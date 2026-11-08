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

export type DeleteMissingMode = 'ok' | 'not_found' | 'expired'

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
  deleteMissingMode: DeleteMissingMode = 'ok'
  /** (agent - controller) clock offset reported in AgentInfo.timeMs. */
  clockOffsetMs = 0
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
    this.assertReachable()
    const snapshot = this.listSnapshotOverride ?? [...this.instances.values()]
    // Snapshot BEFORE the hook: a listing must be allowed to be stale relative
    // to creates that complete while it is in flight.
    if (this.listHook !== null) await this.listHook()
    return snapshot.map(instance => ({ ...instance }))
  }

  async create(spec: AgentInstanceSpec): Promise<AgentInstance> {
    await this.delay()
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
    if (existing !== undefined) return { ...existing }

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
      createdAtMs: this.now(),
      expiresAtMs: spec.expiresAtMs,
      endpoints: spec.expose.map((expose, index) => ({
        kind: expose.kind,
        host: `${this.hostId}.fc.test`,
        port: 20000 + index,
      })),
      specHash: JSON.stringify({
        ...spec,
        flags: spec.flags.map(flag => flag.provider),
      }),
    }
    this.instances.set(spec.id, instance)
    return instance
  }

  async get(id: string): Promise<AgentInstance | undefined> {
    await this.delay()
    this.assertReachable()
    const instance = this.instances.get(id)
    return instance === undefined ? undefined : { ...instance }
  }

  async extend(id: string, expiresAtMs: number): Promise<AgentInstance> {
    await this.delay()
    this.assertReachable()
    this.extendCalls.push({ id, expiresAtMs })
    const instance = this.instances.get(id)
    if (instance === undefined) {
      throw new AgentRejectedError(this.hostId, 'not_found', 'no such instance')
    }
    // Monotonic: a competing/out-of-order push never shortens the deadline.
    instance.expiresAtMs = Math.max(instance.expiresAtMs, expiresAtMs)
    return { ...instance }
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
    if (!known && this.deleteMissingMode !== 'ok') {
      throw new AgentRejectedError(
        this.hostId,
        this.deleteMissingMode,
        `fake delete missing instance (${this.deleteMissingMode})`
      )
    }
    this.instances.delete(id)
    // DELETE always fences the id, including when it was already unknown
    // ("already finished").
    this.tombstones.set(id, this.now())
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

  isTombstoned(id: string): boolean {
    return this.tombstones.has(id)
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
