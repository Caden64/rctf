import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentInstanceSpec,
  CreateInstanceRequest,
} from '@rctf/firecracker-protocol'
import type { Logger } from '../../src/log'
import type { ControllerConfig, HostConfig } from '../../src/controller/config'
import type { ControllerTimers } from '../../src/controller/hosts'
import { FakeAgent, type AgentCapacity } from './fake-agent'

export class FakeClock {
  constructor(public t = 1_000_000) {}
  now = (): number => this.t
  advance(ms: number): void {
    this.t += ms
  }
}

export class FakeTimers implements ControllerTimers {
  private readonly intervals = new Map<number, () => unknown>()
  private nextHandle = 1

  setInterval(handler: () => unknown): number {
    const handle = this.nextHandle++
    this.intervals.set(handle, handler)
    return handle
  }

  clearInterval(handle: unknown): void {
    if (typeof handle === 'number') this.intervals.delete(handle)
  }

  /** Run every scheduled interval callback once (in registration order). */
  async flush(): Promise<void> {
    for (const handler of this.intervals.values()) {
      await handler()
    }
  }

  /** Registration order matches the service: heartbeat, reaper, reconciler. */
  async trigger(index: number): Promise<void> {
    const handler = Array.from(this.intervals.values())[index]
    if (handler !== undefined) await handler()
  }

  get size(): number {
    return this.intervals.size
  }
}

export class MemoryLogs {
  readonly lines: string[] = []

  info(obj: unknown, message?: string): void {
    this.lines.push(`${message ?? ''} ${JSON.stringify(obj)}`)
  }
  warn(obj: unknown, message?: string): void {
    this.lines.push(`${message ?? ''} ${JSON.stringify(obj)}`)
  }
  error(obj: unknown, message?: string): void {
    this.lines.push(`${message ?? ''} ${JSON.stringify(obj)}`)
  }
  debug(obj: unknown, message?: string): void {
    this.lines.push(`${message ?? ''} ${JSON.stringify(obj)}`)
  }

  asLogger(): Logger {
    return this as unknown as Logger
  }
}

export const testDir = (): string => {
  const root = '/tmp/opencode'
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, 'fc-controller-'))
}

export const cleanupDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true })
}

export const databasePath = (dir: string, name = 'controller.sqlite'): string =>
  join(dir, name)

export const HOST_CAPACITY: AgentCapacity = {
  vcpus: 64,
  memMiB: 16384,
  diskMiB: 65536,
  maxInstances: 100,
}

export const makeHost = (
  id: string,
  overrides: Partial<HostConfig> = {}
): HostConfig => ({
  id,
  url: `http://127.0.0.1:9/${id}`,
  token: 'host-token',
  capacity: { ...HOST_CAPACITY },
  ...overrides,
})

export const makeConfig = (
  dir: string,
  hosts: HostConfig[],
  overrides: Partial<ControllerConfig> = {}
): ControllerConfig => ({
  listen: { host: '127.0.0.1', port: 7000 },
  authToken: 'api-token',
  adminToken: 'admin-token',
  databasePath: databasePath(dir),
  teamKeySecret: 'test-team-key-secret',
  hosts,
  overcommit: { vcpu: 1, mem: 1 },
  heartbeatIntervalSeconds: 5,
  hostTimeoutSeconds: 20,
  hostLostSeconds: 300,
  reaperIntervalSeconds: 5,
  reconcileIntervalSeconds: 30,
  orphanGraceSeconds: 30,
  ...overrides,
})

export const makeExpose = (
  overrides: Partial<CreateInstanceRequest['expose'][number]> = {}
): CreateInstanceRequest['expose'][number] => ({
  kind: 'http',
  hostPrefix: 'chal',
  containerName: 'app',
  containerPort: 8080,
  title: 'Web',
  ...overrides,
})

export const makeCreateRequest = (
  teamId: string,
  overrides: Partial<CreateInstanceRequest> = {}
): CreateInstanceRequest => ({
  teamId,
  challengeIntegrationId: 'chal-1',
  config: {
    image: 'base',
    vcpus: 1,
    memMiB: 256,
    diskMiB: 128,
  },
  expose: [makeExpose()],
  flags: [{ provider: 'rctf', flag: 'FLAG{super-secret-flag}' }],
  timeoutMilliseconds: 60_000,
  ...overrides,
})

export const makeAgentSpec = (
  id: string,
  overrides: Partial<AgentInstanceSpec> = {}
): AgentInstanceSpec => ({
  id,
  teamKey: 'abcdef0123456789',
  image: 'base',
  vcpus: 1,
  memMiB: 256,
  diskMiB: 128,
  egress: false,
  bootTimeoutSeconds: 60,
  readiness: { kind: 'tcp', port: 8080 },
  env: {},
  expose: [
    {
      kind: 'http',
      hostPrefix: 'chal',
      port: 8080,
      title: 'Web',
    },
  ],
  expiresAtMs: 2_000_000,
  flags: [{ provider: 'rctf', flag: 'FLAG{super-secret-flag}' }],
  ...overrides,
})

export const makeAgents = (
  ids: string[],
  capacity: AgentCapacity = HOST_CAPACITY,
  now: () => number = () => Date.now()
): Record<string, FakeAgent> =>
  Object.fromEntries(ids.map(id => [id, new FakeAgent(id, capacity, now)]))

/** Poll until `predicate` is true (for tiny real-timer waits in tests). */
export const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000
): Promise<void> => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await Bun.sleep(2)
  }
  throw new Error('waitFor timed out')
}
