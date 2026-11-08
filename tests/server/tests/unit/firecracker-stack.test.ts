/**
 * End-to-end over REAL HTTP boundaries, with only the privileged edges faked:
 *
 *   rCTF provider ──HTTP──▶ controller server ─▶ controller service (SQLite)
 *        ──HTTP──▶ agent server ─▶ instance manager (state files)
 *        ─▶ FakeVmDriver / FakeNetworkManager
 *
 * Nothing here boots a VM, touches nftables, or needs root. It proves that the
 * pieces agree on the wire protocol and that the cross-component invariants
 * hold when assembled.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import FirecrackerInstancerProvider from '../../../../apps/api/src/providers/instancer/firecracker-instancer'
import type { CreateInstanceOptions } from '../../../../apps/api/src/providers/instancer/base'
import { createAgentServer } from '../../../../apps/firecracker-instancer/src/agent/server'
import { createInstanceManager } from '../../../../apps/firecracker-instancer/src/agent/manager'
import { createControllerServer } from '../../../../apps/firecracker-instancer/src/controller/server'
import { createControllerService } from '../../../../apps/firecracker-instancer/src/controller/service'
import { createLogger } from '../../../../apps/firecracker-instancer/src/log'
import type { VmLaunchRequest } from '../../../../apps/firecracker-instancer/src/interfaces'
import {
  FakeNetworkManager,
  FakeVmDriver,
  makeConfig,
  readTree,
  tempDir,
} from '../../../../apps/firecracker-instancer/test/agent/fakes'

const AGENT_TOKEN = 'e2e-agent-token'
const API_TOKEN = 'e2e-api-token'
const ADMIN_TOKEN = 'e2e-admin-token'
const FLAG = 'rctf{e2e-super-secret-flag-1234}'

class RecordingVm extends FakeVmDriver {
  readonly metadata: VmLaunchRequest['metadata'][] = []
  override async launch(request: VmLaunchRequest) {
    this.metadata.push(request.metadata)
    return super.launch(request)
  }
}

interface Stack {
  provider: FirecrackerInstancerProvider
  vm: RecordingVm
  net: FakeNetworkManager
  agentDir: string
  controllerDb: string
  controllerDir: string
  controllerFetch: (path: string, init?: RequestInit) => Promise<Response>
  restartController: () => Promise<void>
  stop: () => Promise<void>
}

const stacks: Stack[] = []
const quiet = createLogger('e2e', 'silent')

const startStack = async (
  opts: { maxInstances?: number } = {}
): Promise<Stack> => {
  const agentDir = await tempDir()
  const controllerDir = await tempDir()
  const controllerDb = `${controllerDir}/controller.sqlite`
  const vm = new RecordingVm()
  const net = new FakeNetworkManager()
  const agentConfig = makeConfig(agentDir, {
    hostId: 'fc1',
    token: AGENT_TOKEN,
    listen: { host: '127.0.0.1', port: 0 },
    capacity: {
      vcpus: 64,
      memMiB: 1_000_000,
      diskMiB: 1_000_000,
      maxInstances: opts.maxInstances ?? 50,
    },
  })
  const manager = createInstanceManager({
    config: agentConfig,
    vm,
    net,
    logger: quiet,
    sweepIntervalMs: 50,
  })
  await manager.start()
  const agent = createAgentServer({
    config: agentConfig,
    manager,
    logger: quiet,
  })
  const agentUrl = `http://127.0.0.1:${agent.server.port}`

  const controllerConfig = () => ({
    listen: { host: '127.0.0.1', port: 0 },
    authToken: API_TOKEN,
    adminToken: ADMIN_TOKEN,
    databasePath: controllerDb,
    teamKeySecret: 'e2e-team-key-secret',
    hosts: [
      {
        id: 'fc1',
        url: agentUrl,
        token: AGENT_TOKEN,
        capacity: {
          vcpus: 64,
          memMiB: 1_000_000,
          diskMiB: 1_000_000,
          maxInstances: opts.maxInstances ?? 50,
        },
      },
    ],
    heartbeatIntervalSeconds: 1,
    reaperIntervalSeconds: 1,
    reconcileIntervalSeconds: 1,
  })

  let service = createControllerService(controllerConfig(), { logger: quiet })
  await service.start()
  let server = createControllerServer({
    service,
    authToken: API_TOKEN,
    adminToken: ADMIN_TOKEN,
    logger: quiet,
  })
  let http = server.serve({ host: '127.0.0.1', port: 0 })
  let controllerUrl = `http://127.0.0.1:${http.port}`

  // The provider keeps its URL; route it through a stable indirection so a
  // controller restart (new port) stays reachable.
  const stable = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: req => {
      const url = new URL(req.url)
      return fetch(`${controllerUrl}${url.pathname}${url.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: 'manual',
      })
    },
  })
  const stableProvider = new FirecrackerInstancerProvider({
    apiUrl: `http://127.0.0.1:${stable.port}`,
    authToken: API_TOKEN,
  })

  const stack: Stack = {
    provider: stableProvider,
    vm,
    net,
    agentDir,
    controllerDb,
    controllerDir,
    controllerFetch: (path, init) =>
      fetch(`${controllerUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          ...init?.headers,
        },
      }),
    restartController: async () => {
      await http.stop(true)
      await service.stop()
      service = createControllerService(controllerConfig(), { logger: quiet })
      await service.start()
      server = createControllerServer({
        service,
        authToken: API_TOKEN,
        adminToken: ADMIN_TOKEN,
        logger: quiet,
      })
      http = server.serve({ host: '127.0.0.1', port: 0 })
      controllerUrl = `http://127.0.0.1:${http.port}`
    },
    stop: async () => {
      await stable.stop(true)
      await http.stop(true)
      await service.stop().catch(() => {})
      await agent.stop(500)
      await manager.stop().catch(() => {})
      rmSync(agentDir, { recursive: true, force: true })
      rmSync(controllerDir, { recursive: true, force: true })
    },
  }
  stacks.push(stack)
  return stack
}

afterEach(async () => {
  while (stacks.length > 0) await stacks.pop()!.stop()
})

const user = (id: string) => ({ id }) as CreateInstanceOptions['user']

const createOptions = (
  teamId: string,
  overrides: Partial<CreateInstanceOptions> = {}
): CreateInstanceOptions =>
  ({
    user: user(teamId),
    challengeIntegrationId: 'fc-demo',
    config: { image: 'web-demo', memMiB: 256, vcpus: 1 },
    expose: [
      {
        kind: 'https',
        hostPrefix: 'demo',
        containerName: 'app',
        containerPort: 8080,
        title: 'Web',
      },
      {
        kind: 'tcp',
        hostPrefix: 'demo',
        containerName: 'app',
        containerPort: 9000,
        title: 'Raw',
      },
    ],
    timeoutMilliseconds: 60_000,
    flags: [{ provider: 'main', flag: FLAG }],
    ...overrides,
  }) as CreateInstanceOptions

const query = (teamId: string) => ({
  teamId,
  challengeIntegrationId: 'fc-demo',
  config: {},
})

const waitForStatus = async (
  stack: Stack,
  teamId: string,
  status: string,
  timeoutMs = 5_000
) => {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    last = await stack.provider.getInstance(query(teamId))
    if ((last as { status?: string }).status === status) return last
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(
    `timed out waiting for ${status}; last=${JSON.stringify(last)}`
  )
}

describe('rCTF provider -> controller -> agent (real HTTP)', () => {
  test('create, boot to running, extend, delete: full lifecycle', async () => {
    const stack = await startStack()

    const created = await stack.provider.createInstance(createOptions('team-a'))
    expect(created.kind).toBe('instancerInstanceDetails')

    const running = (await waitForStatus(stack, 'team-a', 'running')) as {
      endpoints: { kind: string; host: string; port: number }[]
      timeLeftMilliseconds: number
    }
    // Endpoints come back in expose order.
    expect(running.endpoints.map(e => e.kind)).toEqual(['https', 'tcp'])
    expect(running.timeLeftMilliseconds).toBeGreaterThan(0)

    const extended = await stack.provider.extendInstance({
      ...query('team-a'),
      timeoutMilliseconds: 600_000,
    })
    expect(extended.kind).toBe('instancerInstanceDetails')
    const after = await stack.provider.getInstance(query('team-a'))
    expect(
      (after as { timeLeftMilliseconds: number }).timeLeftMilliseconds
    ).toBeGreaterThan(running.timeLeftMilliseconds)

    const deleted = await stack.provider.deleteInstance(query('team-a'))
    expect(deleted.kind).toBe('instancerInstanceDetails')
    const gone = await waitForStatus(stack, 'team-a', 'stopped')
    expect((gone as { status: string }).status).toBe('stopped')
    // Nothing left on the host: VM destroyed, lease released.
    expect(stack.vm.processResidue()).toBe(0)
    expect(stack.net.leases.size).toBe(0)

    // Delete is idempotent.
    expect((await stack.provider.deleteInstance(query('team-a'))).kind).toBe(
      'instancerInstanceDetails'
    )
  })

  test('concurrent duplicate creates produce exactly one VM', async () => {
    const stack = await startStack()
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        stack.provider.createInstance(createOptions('team-dup'))
      )
    )
    for (const result of results)
      expect(result.kind).toBe('instancerInstanceDetails')
    await waitForStatus(stack, 'team-dup', 'running')
    expect(stack.vm.launchCalls).toBe(1)
    expect(stack.net.leases.size).toBe(1)
  })

  test('the flag reaches the guest metadata and nothing durable', async () => {
    const stack = await startStack()
    await stack.provider.createInstance(createOptions('team-flag'))
    await waitForStatus(stack, 'team-flag', 'running')

    expect(stack.vm.metadata).toHaveLength(1)
    expect(stack.vm.metadata[0]?.rctf.flags).toEqual([
      { provider: 'main', flag: FLAG },
    ])

    // Not in the agent state dir, not in the controller database (+ WAL).
    for (const [name, contents] of Object.entries(
      await readTree(stack.agentDir)
    )) {
      expect(contents.includes(FLAG), `agent file ${name}`).toBe(false)
    }
    for (const [name, contents] of Object.entries(
      await readTree(stack.controllerDir)
    )) {
      expect(contents.includes(FLAG), `controller file ${name}`).toBe(false)
    }
  })

  test('different teams get isolated instances; capacity is enforced across the stack', async () => {
    const stack = await startStack({ maxInstances: 2 })
    expect(
      (await stack.provider.createInstance(createOptions('t1'))).kind
    ).toBe('instancerInstanceDetails')
    expect(
      (await stack.provider.createInstance(createOptions('t2'))).kind
    ).toBe('instancerInstanceDetails')
    const third = await stack.provider.createInstance(createOptions('t3'))
    expect(third.kind).toBe('instancerError')
    expect((third as { message: string }).message.toLowerCase()).toContain(
      'capacity'
    )
    await waitForStatus(stack, 't1', 'running')
    await waitForStatus(stack, 't2', 'running')
    expect(stack.vm.launchCalls).toBe(2)

    // Freeing a slot lets the third team in.
    await stack.provider.deleteInstance(query('t1'))
    await waitForStatus(stack, 't1', 'stopped')
    const retry = await stack.provider.createInstance(createOptions('t3'))
    expect(retry.kind).toBe('instancerInstanceDetails')
  })

  test('a controller restart resumes ownership from SQLite alone', async () => {
    const stack = await startStack()
    await stack.provider.createInstance(createOptions('team-r'))
    await waitForStatus(stack, 'team-r', 'running')

    await stack.restartController()

    const after = await waitForStatus(stack, 'team-r', 'running')
    expect((after as { status: string }).status).toBe('running')
    // A duplicate create after the restart still does not launch a second VM.
    await stack.provider.createInstance(createOptions('team-r'))
    expect(stack.vm.launchCalls).toBe(1)
  })

  test('operator API: auth separation, listing and draining', async () => {
    const stack = await startStack()
    await stack.provider.createInstance(createOptions('team-ops'))
    await waitForStatus(stack, 'team-ops', 'running')

    const hosts = (await (await stack.controllerFetch('/v1/hosts')).json()) as {
      hosts: { id: string; health: string; reserved: { instances: number } }[]
    }
    expect(hosts.hosts[0]?.id).toBe('fc1')
    expect(hosts.hosts[0]?.reserved.instances).toBe(1)

    // The rCTF token cannot use the admin API.
    const denied = await stack.controllerFetch('/v1/hosts', {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    })
    expect(denied.status).toBe(401)

    const drained = await stack.controllerFetch('/v1/hosts/fc1/drain', {
      method: 'POST',
    })
    expect(drained.status).toBe(200)
    const blocked = await stack.provider.createInstance(
      createOptions('team-new')
    )
    expect(blocked.kind).toBe('instancerError')
    // Existing instances are unaffected by draining.
    expect((await stack.provider.getInstance(query('team-ops'))).kind).toBe(
      'instancerInstanceDetails'
    )
    await stack.controllerFetch('/v1/hosts/fc1/undrain', { method: 'POST' })
    expect(
      (await stack.provider.createInstance(createOptions('team-new'))).kind
    ).toBe('instancerInstanceDetails')
  })
})
