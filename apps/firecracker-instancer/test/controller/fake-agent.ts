/**
 * Faithful in-test AgentClient over the real protocol shapes.
 *
 * - idempotent per instance id (a different spec for the same id rejects)
 * - enforces its own capacity (second line of defence after the controller)
 * - can be told to be unreachable, to fail/time out a create, to lose its
 *   state, or to be slow (controllable latency), which is what the controller
 *   race/ambiguity tests need.
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
  | 'reject' // definitive rejection, nothing created

export class FakeAgent implements AgentClient {
  readonly instances = new Map<string, AgentInstance>()
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

  constructor(
    readonly hostId: string,
    private readonly capacity: AgentCapacity,
    private readonly now: () => number = () => Date.now()
  ) {}

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
    this.infoCalls.push(this.now())
    this.assertReachable()
    return {
      version: 'fake',
      hostId: this.hostId,
      timeMs: this.now(),
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
    return [...this.instances.values()].map(instance => ({ ...instance }))
  }

  async create(spec: AgentInstanceSpec): Promise<AgentInstance> {
    await this.delay()
    this.assertReachable()
    this.createCalls.push(spec)
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
    if (this.createMode === 'create-then-unreachable') {
      throw new AgentUnreachableError(
        this.hostId,
        'fake create timed out after creating'
      )
    }
    return { ...instance }
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
    this.instances.delete(id)
  }

  // ---- test controls ----------------------------------------------------

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
