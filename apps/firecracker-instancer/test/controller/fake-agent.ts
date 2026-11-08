/**
 * Faithful in-test AgentClient over the real protocol shapes.
 *
 * Models the parts of the agent contract the controller depends on:
 * - idempotent per instance id (a different spec for the same id rejects)
 * - enforces its own capacity (second line of defence after the controller)
 * - can be told to be unreachable, to fail/time out a create, to lose its
 *   state, or to be slow (controllable latency), which is what the controller
 *   race/ambiguity tests need
 * - DELETE writes a durable tombstone, so a later PUT for that id fails with
 *   `conflict` (FENCING in agent-protocol.ts) — including a PUT the controller
 *   timed out but that is delivered later
 * - `list()` can return a stale snapshot taken before concurrent changes, and
 *   `info()` reports `timeMs` with a configurable clock offset
 */
import {
  AgentRejectedError,
  AgentUnreachableError,
  type AgentClient,
} from '../../src/interfaces'
import type {
  AgentInfo,
  AgentInstance,
  AgentInstanceSpec,
  ErrorCode,
} from '@rctf/firecracker-protocol'

export interface AgentCapacity {
  vcpus: number
  memMiB: number
  diskMiB: number
  maxInstances: number
}

export type CreateMode =
  | 'ok'
  | 'unreachable' // nothing created, transport error (ambiguous)
  | 'create-then-unreachable' // VM exists, transport error (ambiguous)
  | 'create-then-internal-error' // VM exists, a misclassified 500/internal body (ambiguous)
  | 'create-then-hold' // VM exists; the promise resolves only on release
  | 'reject' // definitive rejection, nothing created

export type InfoMode = 'ok' | 'unreachable' | 'hang'

export type DeleteMissingMode =
  | 'ok'
  | 'not_found'
  | 'expired'
  /** Simulates a route/proxy 404 that the controller cannot attribute. */
  | 'ambiguous'

/** One captured PUT whose delivery is delayed until `execute()`. */
export interface DeferredCreate {
  captured: Promise<AgentInstanceSpec>
  execute: () => Promise<AgentInstance>
}

/** One create whose completion is held until `release()`. */
export interface HeldCreate {
  created: Promise<AgentInstance>
  release: () => void
}

/** One extend whose response is held until `release()`. */
export interface HeldExtend {
  /** Resolves with the argument once the PATCH is captured. */
  captured: Promise<{ id: string; expiresAtMs: number }>
  release: () => void
}

/** Stable per-instance spec hash: excludes `expiresAtMs` and flag values. */
export const specHashOf = (spec: AgentInstanceSpec): string =>
  JSON.stringify({
    id: spec.id,
    teamKey: spec.teamKey,
    image: spec.image,
    vcpus: spec.vcpus,
    memMiB: spec.memMiB,
    diskMiB: spec.diskMiB,
    kernelArgs: spec.kernelArgs ?? null,
    egress: spec.egress,
    bootTimeoutSeconds: spec.bootTimeoutSeconds,
    readiness: spec.readiness,
    env: spec.env,
    expose: spec.expose.map(expose => ({
      kind: expose.kind,
      hostPrefix: expose.hostPrefix,
      port: expose.port,
      title: expose.title ?? null,
    })),
    flags: spec.flags.map(flag => flag.provider),
  })

export class FakeAgent implements AgentClient {
  readonly instances = new Map<string, AgentInstance>()
  readonly tombstones = new Map<string, number>()
  readonly createCalls: AgentInstanceSpec[] = []
  readonly deleteCalls: string[] = []
  readonly extendCalls: { id: string; expiresAtMs: number }[] = []
  readonly infoCalls: number[] = []

  unreachable = false
  deleteUnreachable = false
  accepting = true
  createMode: CreateMode = 'ok'
  createState: AgentInstance['state'] = 'running'
  rejectCode: ErrorCode = 'no_capacity'
  latencyMs = 0
  infoMode: InfoMode = 'ok'
  /** Await this before answering `info()` (holds a heartbeat tick open). */
  infoHold: Promise<void> | null = null
  /**
   * A DELETE of an unknown id still writes the tombstone; `expired` throws
   * AFTER fencing, while `ambiguous` models a route/proxy 404 (no fence).
   */
  deleteMissingMode: DeleteMissingMode = 'ok'
  /** Error returned for a DELETE of a KNOWN id (before any mutation). */
  deleteErrorMode: 'none' | 'expired' | 'internal' = 'none'
  /** How GET answers for an unknown id: absent, or an unattributable 404. */
  getMissingMode: 'absent' | 'ambiguous' = 'absent'
  /** How PATCH answers for an unknown id: not_found, or an unattributable 404. */
  extendMissingMode: 'not_found' | 'ambiguous' = 'not_found'
  /** Error for a PATCH of a KNOWN id (e.g. a routing 404 while it is alive). */
  extendErrorMode: 'none' | 'not_found' | 'ambiguous' = 'none'
  /**
   * When set, the agent answers PATCH with this deadline instead of the one it
   * actually applied (models a silent short/clamped acknowledgement).
   */
  extendAckDeadline: ((applied: number, requested: number) => number) | null =
    null
  /** (agent - controller) clock offset reported in AgentInfo.timeMs. */
  clockOffsetMs = 0
  /** Runs inside `info()` after the request started (can step the clock). */
  infoHook: (() => void) | null = null
  /** Optional dead-man: destroy a VM once now > expiresAtMs + expiryGraceMs. */
  deadmanEnabled = false
  expiryGraceMs = 5000
  /** Return this stale snapshot from `list()` instead of the live map. */
  listSnapshotOverride: AgentInstance[] | null = null
  /** Runs after `list()` captured its snapshot but before returning it. */
  listHook: (() => void | Promise<void>) | null = null

  private delayedGate: {
    capture: (spec: AgentInstanceSpec) => void
  } | null = null
  private holdGate: {
    capture: (instance: AgentInstance) => void
    released: Promise<void>
  } | null = null
  private extendGate: {
    capture: (call: { id: string; expiresAtMs: number }) => void
    released: Promise<void>
  } | null = null

  /** The agent's own clock (controller clock + configured offset). */
  private agentNow(): number {
    return this.now() + this.clockOffsetMs
  }

  /** Model the agent's dead-man deadline destroying VMs on its own. */
  private expireDeadman(): void {
    if (!this.deadmanEnabled) return
    const at = this.agentNow()
    for (const [id, instance] of this.instances) {
      if (instance.expiresAtMs + this.expiryGraceMs <= at) {
        this.instances.delete(id)
      }
    }
  }

  constructor(
    readonly hostId: string,
    private readonly capacity: AgentCapacity,
    private clock: () => number = () => Date.now()
  ) {}

  /** Test seam: make the fake share the controller's fake clock. */
  setClock(now: () => number): void {
    this.clock = now
  }

  private now(): number {
    return this.clock()
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await Bun.sleep(this.latencyMs)
  }

  private assertReachable(): void {
    if (this.unreachable) {
      throw new AgentUnreachableError(this.hostId, 'fake agent unreachable')
    }
  }

  private usage(): {
    vcpus: number
    memMiB: number
    diskMiB: number
    instances: number
  } {
    let vcpus = 0
    let memMiB = 0
    let diskMiB = 0
    let instances = 0
    const specs = new Map(this.createCalls.map(spec => [spec.id, spec]))
    for (const instance of this.instances.values()) {
      if (instance.state === 'stopped' || instance.state === 'errored') continue
      const spec = specs.get(instance.id)
      if (spec === undefined) continue
      vcpus += spec.vcpus
      memMiB += spec.memMiB
      diskMiB += spec.diskMiB
      instances += 1
    }
    return { vcpus, memMiB, diskMiB, instances }
  }

  async info(): Promise<AgentInfo> {
    await this.delay()
    if (this.infoMode === 'hang') {
      return new Promise<AgentInfo>(() => undefined)
    }
    if (this.infoHold !== null) await this.infoHold
    if (this.infoHook !== null) this.infoHook()
    this.infoCalls.push(this.now())
    this.assertReachable()
    if (this.infoMode === 'unreachable') {
      throw new AgentUnreachableError(this.hostId, 'fake info unavailable')
    }
    return {
      version: 'fake',
      hostId: this.hostId,
      timeMs: this.now() + this.clockOffsetMs,
      capacity: { ...this.capacity },
      usage: this.usage(),
      accepting: this.accepting,
      checks: {},
      images: ['base'],
    }
  }

  async list(): Promise<AgentInstance[]> {
    await this.delay()
    this.expireDeadman()
    this.assertReachable()
    const snapshot = this.listSnapshotOverride ?? [...this.instances.values()]
    // Snapshot BEFORE the hook: a listing must be allowed to be stale relative
    // to creates that complete while it is in flight.
    if (this.listHook !== null) await this.listHook()
    return snapshot.map(instance => ({ ...instance }))
  }

  async create(spec: AgentInstanceSpec): Promise<AgentInstance> {
    await this.delay()
    this.expireDeadman()
    this.assertReachable()
    this.createCalls.push(spec)

    const delayed = this.delayedGate
    if (delayed !== null) {
      this.delayedGate = null
      delayed.capture(spec)
      // The controller observes a timeout; the PUT is still on the wire and
      // will execute when the test calls `execute()`.
      throw new AgentUnreachableError(
        this.hostId,
        'fake create timed out on the wire (delivered later)'
      )
    }

    if (this.createMode === 'unreachable') {
      throw new AgentUnreachableError(this.hostId, 'fake create timed out')
    }
    if (this.createMode === 'reject') {
      throw new AgentRejectedError(
        this.hostId,
        this.rejectCode,
        'fake agent rejected create'
      )
    }

    const instance = this.executeCreate(spec)

    if (this.createMode === 'create-then-unreachable') {
      throw new AgentUnreachableError(
        this.hostId,
        'fake create timed out after creating'
      )
    }
    if (this.createMode === 'create-then-internal-error') {
      // A well-formed JSON 500/internal body after the VM exists. The service
      // must treat this as ambiguous (the fixed client reports it as
      // AgentUnreachableError; a client bug surfaces it as AgentRejectedError).
      throw new AgentRejectedError(
        this.hostId,
        'internal',
        'agent returned HTTP 500 (instance created)'
      )
    }
    if (this.createMode === 'create-then-hold') {
      const hold = this.holdGate
      if (hold !== null) {
        this.holdGate = null
        hold.capture({ ...instance })
        await hold.released
      }
    }
    return { ...instance }
  }

  private executeCreate(spec: AgentInstanceSpec): AgentInstance {
    if (this.tombstones.has(spec.id)) {
      throw new AgentRejectedError(
        this.hostId,
        'conflict',
        'instance id was deleted'
      )
    }

    const existing = this.instances.get(spec.id)
    if (existing !== undefined) {
      // Idempotent only for the same logical spec. Delay/flag-value changes
      // (which the hash excludes) are fine; anything else is a real mismatch.
      if (existing.specHash !== specHashOf(spec)) {
        throw new AgentRejectedError(
          this.hostId,
          'spec_mismatch',
          'instance exists with a different spec'
        )
      }
      return { ...existing }
    }

    const usage = this.usage()
    if (
      usage.vcpus + spec.vcpus > this.capacity.vcpus ||
      usage.memMiB + spec.memMiB > this.capacity.memMiB ||
      usage.diskMiB + spec.diskMiB > this.capacity.diskMiB ||
      usage.instances + 1 > this.capacity.maxInstances
    ) {
      throw new AgentRejectedError(
        this.hostId,
        'no_capacity',
        'fake agent is full'
      )
    }

    const instance: AgentInstance = {
      id: spec.id,
      state:
        this.createMode === 'create-then-unreachable'
          ? 'running'
          : this.createState,
      createdAtMs: this.agentNow(),
      expiresAtMs: spec.expiresAtMs,
      endpoints: spec.expose.map((expose, index) => ({
        kind: expose.kind,
        host: `${this.hostId}.fc.test`,
        port: 20000 + index,
      })),
      specHash: specHashOf(spec),
    }
    this.instances.set(spec.id, instance)
    return instance
  }

  async get(id: string): Promise<AgentInstance | undefined> {
    await this.delay()
    this.expireDeadman()
    this.assertReachable()
    const instance = this.instances.get(id)
    if (instance === undefined) {
      if (this.getMissingMode === 'ambiguous') {
        throw new AgentUnreachableError(
          this.hostId,
          'fake ambiguous GET 404 (route/proxy)'
        )
      }
      return undefined
    }
    return { ...instance }
  }

  async extend(id: string, expiresAtMs: number): Promise<AgentInstance> {
    await this.delay()
    this.expireDeadman()
    this.assertReachable()
    this.extendCalls.push({ id, expiresAtMs })
    const instance = this.instances.get(id)
    if (instance === undefined) {
      if (this.extendMissingMode === 'ambiguous') {
        throw new AgentUnreachableError(
          this.hostId,
          'fake ambiguous PATCH 404 (route/proxy)'
        )
      }
      throw new AgentRejectedError(this.hostId, 'not_found', 'no such instance')
    }
    if (this.extendErrorMode === 'ambiguous') {
      throw new AgentUnreachableError(
        this.hostId,
        'fake ambiguous PATCH 404 (instance alive)'
      )
    }
    if (this.extendErrorMode === 'not_found') {
      throw new AgentRejectedError(this.hostId, 'not_found', 'no such instance')
    }
    // Monotonic: a competing/out-of-order push never shortens the deadline.
    instance.expiresAtMs = Math.max(instance.expiresAtMs, expiresAtMs)
    const snapshot = { ...instance }
    if (this.extendAckDeadline !== null) {
      snapshot.expiresAtMs = this.extendAckDeadline(
        instance.expiresAtMs,
        expiresAtMs
      )
    }
    const gate = this.extendGate
    if (gate !== null) {
      this.extendGate = null
      gate.capture({ id, expiresAtMs })
      // The agent applied the update but the response is stuck on the wire:
      // another extend can complete (and be observed) first.
      await gate.released
    }
    return snapshot
  }

  async delete(id: string): Promise<void> {
    await this.delay()
    if (this.deleteUnreachable) {
      throw new AgentUnreachableError(
        this.hostId,
        'fake delete transport failure'
      )
    }
    this.assertReachable()
    this.deleteCalls.push(id)
    const known = this.instances.has(id)
    if (!known) {
      if (this.deleteMissingMode === 'ambiguous') {
        // A route/proxy 404: the agent never ran the instance DELETE, so no
        // tombstone exists and the controller must keep the row fenced.
        throw new AgentUnreachableError(
          this.hostId,
          'fake ambiguous DELETE 404 (no fence)'
        )
      }
      // Faithful FENCING: the agent writes the durable tombstone BEFORE it
      // answers (404 for an unknown id, or an error mode's 410/expired).
      this.tombstones.set(id, this.agentNow())
      if (
        this.deleteMissingMode !== 'ok' &&
        this.deleteMissingMode !== 'not_found'
      ) {
        throw new AgentRejectedError(
          this.hostId,
          this.deleteMissingMode,
          `fake delete missing instance (${this.deleteMissingMode})`
        )
      }
      // `not_found` is the agent's 404 body; AgentClient.delete resolves on
      // HTTP 404, so the fake resolves too.
      return
    }
    if (this.deleteErrorMode !== 'none') {
      throw new AgentRejectedError(
        this.hostId,
        this.deleteErrorMode,
        `fake delete failed (${this.deleteErrorMode})`
      )
    }
    this.instances.delete(id)
    this.tombstones.set(id, this.agentNow())
  }

  // ---- test controls ----------------------------------------------------

  /**
   * Capture the next create and pretend the controller timed out: the PUT
   * stays "on the wire" and only runs when the returned `execute()` is called.
   */
  deferNextCreate(): DeferredCreate {
    let capture!: (spec: AgentInstanceSpec) => void
    const captured = new Promise<AgentInstanceSpec>(resolve => {
      capture = resolve
    })
    this.delayedGate = { capture }
    return {
      captured,
      execute: async () => this.executeCreate(await captured),
    }
  }

  /**
   * Create the VM on the next create but hold the response until release, so a
   * concurrent GET can observe/promote the row before the PUT completion.
   */
  holdNextCreate(): HeldCreate {
    this.createMode = 'create-then-hold'
    let capture!: (instance: AgentInstance) => void
    const created = new Promise<AgentInstance>(resolve => {
      capture = resolve
    })
    let release!: () => void
    const released = new Promise<void>(resolve => {
      release = resolve
    })
    this.holdGate = { capture, released }
    return { created, release }
  }

  /** Hold the next PATCH response after the agent applied it. */
  holdNextExtend(): HeldExtend {
    let capture!: (call: { id: string; expiresAtMs: number }) => void
    const captured = new Promise<{ id: string; expiresAtMs: number }>(
      resolve => {
        capture = resolve
      }
    )
    let release!: () => void
    const released = new Promise<void>(resolve => {
      release = resolve
    })
    this.extendGate = { capture, released }
    return { captured, release }
  }

  isTombstoned(id: string): boolean {
    return this.tombstones.has(id)
  }

  /**
   * Simulate an agent process restart: durable state (instances + tombstones)
   * survives; transient test controls (failures, gates, latency) reset.
   */
  simulateRestart(): void {
    this.unreachable = false
    this.deleteUnreachable = false
    this.accepting = true
    this.createMode = 'ok'
    this.createState = 'running'
    this.latencyMs = 0
    this.infoMode = 'ok'
    this.infoHold = null
    this.deleteMissingMode = 'ok'
    this.deleteErrorMode = 'none'
    this.getMissingMode = 'absent'
    this.extendMissingMode = 'not_found'
    this.extendErrorMode = 'none'
    this.extendAckDeadline = null
    this.infoHook = null
    this.listSnapshotOverride = null
    this.listHook = null
    this.delayedGate = null
    this.holdGate = null
    this.extendGate = null
  }

  loseState(): void {
    this.instances.clear()
  }

  /** Remove an instance without going through delete (agent-side loss). */
  forceDrop(id: string): void {
    this.instances.delete(id)
  }

  /** Add an agent-only record the controller does not know about. */
  forceInstance(instance: AgentInstance, spec?: AgentInstanceSpec): void {
    this.instances.set(instance.id, { ...instance })
    if (spec !== undefined) this.createCalls.push(spec)
  }

  createCount(): number {
    return this.createCalls.length
  }
}
