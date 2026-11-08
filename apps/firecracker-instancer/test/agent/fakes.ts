import path from 'node:path'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import pino from 'pino'
import type {
  NetExposeRequest,
  NetLease,
  NetworkManager,
  PublicEndpoint,
  VmDriver,
  VmHandle,
  VmLaunchRequest,
  PreflightResult,
} from '../../src/interfaces'
import type { AgentInstanceSpec } from '@rctf/firecracker-protocol'
import { agentConfigSchema, type AgentConfig } from '../../src/agent/config'
import type { Logger } from '../../src/log'

export interface TestClock {
  now: () => number
  advance: (ms: number) => void
  set: (ms: number) => void
}

export const makeClock = (start = 1_700_000_000_000): TestClock => {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
    set: (ms: number) => {
      current = ms
    },
  }
}

let idCounter = 0
/** Valid instance id: 16 chars, lowercase base36. */
export const nextId = (prefix = 'i'): string => {
  idCounter += 1
  const counter = idCounter.toString(36).padStart(4, '0')
  return `${prefix}${counter}${'a'.repeat(11)}`.slice(0, 16)
}

export const makeSpec = (
  overrides: Partial<AgentInstanceSpec> = {}
): AgentInstanceSpec => {
  const id = overrides.id ?? nextId()
  return {
    id,
    teamKey: 'teamkey01',
    image: 'ubuntu',
    vcpus: 1,
    memMiB: 256,
    diskMiB: 1024,
    egress: false,
    bootTimeoutSeconds: 30,
    readiness: { kind: 'tcp', port: 80 },
    env: { FOO: 'bar' },
    expose: [{ kind: 'http', hostPrefix: 'app', port: 80, title: 'app' }],
    expiresAtMs: 1_700_000_000_000 + 3_600_000,
    flags: [{ provider: 'rctf/flag', flag: 'FLAG{test-secret-value}' }],
    ...overrides,
  }
}

export const makeConfig = (
  stateDir: string,
  overrides: Record<string, unknown> = {}
): AgentConfig =>
  agentConfigSchema.parse({
    hostId: 'host1',
    token: 'agent-token',
    stateDir,
    capacity: {
      vcpus: 1000,
      memMiB: 1_000_000,
      diskMiB: 1_000_000,
      maxInstances: 1000,
    },
    expiryGraceSeconds: 10,
    draining: false,
    erroredTtlSeconds: 600,
    vm: {},
    network: { publicHost: 'fc.example.com', httpDomain: 'fc.example.com' },
    ...overrides,
  })

export interface Residue {
  leases: number
  published: number
  ports: number
  hostnames: number
}

/** A controllable async gate for delayed/stalled fake operations. */
export interface Gate {
  promise: Promise<void>
  open: () => void
}

export const makeGate = (): Gate => {
  let open!: () => void
  const promise = new Promise<void>(resolve => {
    open = resolve
  })
  return { promise, open }
}

export const never = (): Promise<void> => new Promise<void>(() => {})

const isTcpKind = (kind: string): boolean => kind === 'tcp' || kind === 'raw'

let leaseCounter = 0
export const makeLease = (
  instanceId: string,
  expose: NetExposeRequest[],
  egress = false
): NetLease => {
  leaseCounter += 1
  const index = leaseCounter
  const octet = (index % 250) + 1
  const publicPorts: Record<number, number> = {}
  const publicHostnames: Record<number, string> = {}
  expose.forEach((item, i) => {
    if (isTcpKind(item.kind)) {
      publicPorts[i] = 20000 + (index * 10 + i)
    } else {
      publicHostnames[i] =
        `${item.hostPrefix}-${instanceId.slice(0, 8)}.fc.example.com`
    }
  })
  return {
    instanceId,
    tapName: `fctap${index}`,
    hostIp: `10.200.${Math.floor(index / 250)}.${(octet % 250) * 4 + 1}`,
    guestIp: `10.200.${Math.floor(index / 250)}.${(octet % 250) * 4 + 2}`,
    prefixLength: 30,
    guestMac: `02:00:00:00:${(index & 0xff).toString(16).padStart(2, '0')}:01`,
    publicPorts,
    publicHostnames,
    egress,
    expose,
  } as NetLease
}

const toExposeRequests = (
  expose: { kind: string; hostPrefix: string; port: number }[]
): NetExposeRequest[] =>
  expose.map(item => ({
    kind: item.kind as NetExposeRequest['kind'],
    hostPrefix: item.hostPrefix,
    port: item.port,
  }))

export class FakeNetworkManager implements NetworkManager {
  readonly leases = new Map<string, NetLease>()
  readonly published = new Set<string>()
  lastRestored: NetLease[] = []
  allocateCalls = 0
  publishCalls = 0
  unpublishCalls = 0
  releaseCalls = 0
  restoreCalls = 0
  failAllocate = false
  failPublish = false
  failUnpublish = false
  failRelease = false
  failRestore = false
  allocateError?: Error
  publishError?: Error
  unpublishError?: Error
  releaseError?: Error
  restoreError?: Error
  allocateGate?: Promise<void>
  publishGate?: Promise<void>
  publishStartGate?: Promise<void>
  restoreGate?: Promise<void>
  unpublishGate?: Promise<void>
  releaseGate?: Promise<void>

  constructor(
    readonly publicHost = 'fc.example.com',
    readonly httpDomain = 'fc.example.com'
  ) {}

  async allocate(req: {
    instanceId: string
    egress: boolean
    expose: NetExposeRequest[]
  }): Promise<NetLease> {
    this.allocateCalls += 1
    if (this.allocateGate) await this.allocateGate
    if (this.allocateError) throw this.allocateError
    if (this.failAllocate) throw new Error('allocate failed')
    const existing = this.leases.get(req.instanceId)
    if (existing) return existing
    const lease = makeLease(req.instanceId, req.expose, req.egress)
    this.leases.set(req.instanceId, lease)
    return lease
  }

  async publish(lease: NetLease, _expose: NetExposeRequest[]): Promise<void> {
    this.publishCalls += 1
    if (this.publishStartGate) await this.publishStartGate
    if (this.publishError) throw this.publishError
    if (this.failPublish) throw new Error('publish failed')
    this.published.add(lease.instanceId)
    if (this.publishGate) await this.publishGate
  }

  async unpublish(instanceId: string): Promise<void> {
    this.unpublishCalls += 1
    if (this.unpublishGate) await this.unpublishGate
    if (this.unpublishError) throw this.unpublishError
    if (this.failUnpublish) throw new Error('unpublish failed')
    this.published.delete(instanceId)
  }

  async release(instanceId: string): Promise<void> {
    this.releaseCalls += 1
    if (this.releaseGate) await this.releaseGate
    if (this.releaseError) throw this.releaseError
    if (this.failRelease) throw new Error('release failed')
    this.published.delete(instanceId)
    this.leases.delete(instanceId)
  }

  endpoints(lease: NetLease, expose: NetExposeRequest[]): PublicEndpoint[] {
    return expose.map((item, i) => {
      if (isTcpKind(item.kind)) {
        return {
          kind: item.kind,
          host: this.publicHost,
          port: lease.publicPorts[i] ?? 1,
        }
      }
      return {
        kind: item.kind,
        host:
          lease.publicHostnames[i] ?? `${item.hostPrefix}.${this.httpDomain}`,
        port: item.kind === 'https' || item.kind === 'tcp-ssl' ? 443 : 80,
      }
    })
  }

  async restore(leases: NetLease[]): Promise<{ removedOrphans: string[] }> {
    this.restoreCalls += 1
    if (this.restoreGate) await this.restoreGate
    if (this.restoreError) throw this.restoreError
    if (this.failRestore) throw new Error('restore failed')
    this.lastRestored = leases
    const keep = new Set(leases.map(lease => lease.instanceId))
    const removedOrphans: string[] = []
    for (const id of this.leases.keys()) {
      if (!keep.has(id)) {
        this.leases.delete(id)
        this.published.delete(id)
        removedOrphans.push(id)
      }
    }
    for (const lease of leases) this.leases.set(lease.instanceId, lease)
    return { removedOrphans }
  }

  async preflight(): Promise<Record<string, boolean>> {
    return { 'net.nft': true, 'net.ip_forward': true }
  }

  residue(): Residue {
    let ports = 0
    let hostnames = 0
    for (const lease of this.leases.values()) {
      ports += Object.keys(lease.publicPorts).length
      hostnames += Object.keys(lease.publicHostnames).length
    }
    return {
      leases: this.leases.size,
      published: this.published.size,
      ports,
      hostnames,
    }
  }
}

export class FakeVmDriver implements VmDriver {
  readonly handles = new Map<string, VmHandle>()
  readonly alive = new Set<string>()
  readonly abortedWaitReady: string[] = []
  readonly destroyedIds: string[] = []
  extraOrphans: string[] = []
  launchCalls = 0
  stopCalls = 0
  destroyCalls = 0
  waitReadyCalls = 0
  adoptCalls = 0
  failLaunch = false
  failWaitReady = false
  failStop = false
  failDestroy = false
  failAdopt = false
  failIsAlive = false
  failList = false
  launchError?: Error
  waitReadyError?: Error
  stopError?: Error
  destroyError?: Error
  adoptError?: Error
  isAliveError?: Error
  listError?: Error
  launchGate?: Promise<void>
  launchStartGate?: Promise<void>
  stopGate?: (instanceId: string) => Promise<void> | undefined
  destroyGate?: (instanceId: string) => Promise<void> | undefined
  waitReadyHook?: (
    instanceId: string,
    signal: AbortSignal | undefined
  ) => Promise<void>
  private nextPid = 4000

  async launch(request: VmLaunchRequest): Promise<VmHandle> {
    this.launchCalls += 1
    if (this.launchStartGate) await this.launchStartGate
    if (this.launchError) throw this.launchError
    if (this.failLaunch) throw new Error('launch failed')
    const handle: VmHandle = {
      instanceId: request.instanceId,
      pid: this.nextPid++,
      pidStartTicks: 1,
      apiSocket: `/run/${request.instanceId}/api.sock`,
      dir: `/run/${request.instanceId}`,
    }
    this.handles.set(request.instanceId, handle)
    this.alive.add(request.instanceId)
    // Crash injection: side effects happen, then the process "dies" before the
    // manager can persist the returned handle.
    if (this.launchGate) await this.launchGate
    return handle
  }

  async isAlive(handle: VmHandle): Promise<boolean> {
    if (this.isAliveError) throw this.isAliveError
    if (this.failIsAlive) throw new Error('isAlive failed')
    return this.alive.has(handle.instanceId)
  }

  async waitReady(
    handle: VmHandle,
    _probe: unknown,
    signal?: AbortSignal
  ): Promise<void> {
    this.waitReadyCalls += 1
    if (this.waitReadyError) throw this.waitReadyError
    if (this.failWaitReady) throw new Error('readiness failed')
    if (this.waitReadyHook) {
      await this.waitReadyHook(handle.instanceId, signal)
    }
    if (signal?.aborted) {
      this.abortedWaitReady.push(handle.instanceId)
      throw new Error('aborted')
    }
  }

  async stop(handle: VmHandle, _opts: { graceMs: number }): Promise<void> {
    this.stopCalls += 1
    const gate = this.stopGate?.(handle.instanceId)
    if (gate) await gate
    if (this.stopError) throw this.stopError
    if (this.failStop) throw new Error('stop failed')
    this.alive.delete(handle.instanceId)
  }

  async destroy(instanceId: string): Promise<void> {
    this.destroyCalls += 1
    const gate = this.destroyGate?.(instanceId)
    if (gate) await gate
    if (this.destroyError) throw this.destroyError
    if (this.failDestroy) throw new Error('destroy failed')
    this.destroyedIds.push(instanceId)
    this.alive.delete(instanceId)
    this.handles.delete(instanceId)
  }

  async listInstanceIds(): Promise<string[]> {
    if (this.listError) throw this.listError
    if (this.failList) throw new Error('list failed')
    return [...new Set([...this.handles.keys(), ...this.extraOrphans])]
  }

  async adopt(instanceId: string): Promise<VmHandle | undefined> {
    this.adoptCalls += 1
    if (this.adoptError) throw this.adoptError
    if (this.failAdopt) throw new Error('adopt failed')
    return this.alive.has(instanceId) ? this.handles.get(instanceId) : undefined
  }

  async preflight(): Promise<PreflightResult> {
    return {
      checks: { 'vm.kvm': true, 'vm.firecracker': true },
      images: ['ubuntu', 'alpine'],
    }
  }

  processResidue(): number {
    return this.alive.size + this.handles.size
  }
}

export interface CapturedLogger {
  logger: Logger
  lines: string[]
  text: () => string
}

export const captureLogger = (): CapturedLogger => {
  const lines: string[] = []
  const stream = {
    write(chunk: string) {
      lines.push(chunk)
    },
  }
  const logger = pino({ level: 'trace', base: undefined }, stream)
  return { logger, lines, text: () => lines.join('') }
}

export const tempDir = async (): Promise<string> =>
  mkdtemp(path.join(tmpdir(), 'rctf-fc-agent-'))

/** Recursively read every regular file under `dir`, returning name -> contents. */
export const readTree = async (
  dir: string
): Promise<Record<string, string>> => {
  const out: Record<string, string> = {}
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(full, rel)
      else if (entry.isFile()) {
        try {
          out[rel] = await readFile(full, 'utf8')
        } catch (err) {
          // A concurrent atomic rename can remove a file between readdir and
          // read; treat that as "not present in this snapshot".
          if ((err as { code?: string }).code !== 'ENOENT') throw err
        }
      }
    }
  }
  await walk(dir, '')
  return out
}

export const removeDir = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true })
}

export const waitFor = async <T>(
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 2000
): Promise<T> => {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

export const delayTick = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 2))

export const toExpose = toExposeRequests
