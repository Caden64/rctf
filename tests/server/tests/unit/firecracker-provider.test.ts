import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { User } from '@rctf/db'
import { ExposeKind } from '@rctf/types'
import {
  ProtocolError,
  type ControllerEndpoint,
  type ControllerInstanceDetails,
  type CreateInstanceRequest,
  type ExtendInstanceRequest,
  type HostSummary,
  type InstanceKey,
} from '../../../../packages/firecracker/src'
import FirecrackerInstancerProvider, {
  firecrackerConfigInputJsonSchema,
} from '../../../../apps/api/src/providers/instancer/firecracker-instancer'
import { instancerProviders } from '../../../../apps/api/src/providers/instancer/index'
import type {
  CreateInstanceOptions,
  InstanceQueryOptions,
} from '../../../../apps/api/src/providers/instancer/base'
import { createControllerServer } from '../../../../apps/firecracker-instancer/src/controller/server'
import type { ControllerService } from '../../../../apps/firecracker-instancer/src/interfaces'
import type { Logger } from '../../../../apps/firecracker-instancer/src/log'

const AUTH_TOKEN = 'rctf-token'
const ADMIN_TOKEN = 'admin-token'

const silentLogger = (): Logger =>
  ({
    info() {},
    error() {},
    warn() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return silentLogger()
    },
  }) as unknown as Logger

const details = (
  endpoints: ControllerEndpoint[] | null
): ControllerInstanceDetails => ({
  kind: 'instancerInstanceDetails',
  status: 'running',
  timeLeftMilliseconds: 60_000,
  endpoints,
})

const hostSummary: HostSummary = {
  id: 'fc1',
  url: 'http://fc1.example.com:7001',
  health: 'healthy',
  lastSeenMs: 1,
  capacity: { vcpus: 16, memMiB: 32768, diskMiB: 100_000, maxInstances: 32 },
  reserved: { vcpus: 2, memMiB: 512, diskMiB: 2048, instances: 1 },
}

interface RecordedRequest {
  method: string
  path: string
  authorization: string | null
  contentType: string | null
  body: string
}

interface FakeControllerService {
  service: ControllerService
  calls: {
    create: CreateInstanceRequest[]
    get: InstanceKey[]
    delete: InstanceKey[]
    extend: ExtendInstanceRequest[]
  }
  handlers: {
    create: (req: CreateInstanceRequest) => Promise<ControllerInstanceDetails>
    get: (key: InstanceKey) => Promise<ControllerInstanceDetails>
    delete: (key: InstanceKey) => Promise<ControllerInstanceDetails>
    extend: (req: ExtendInstanceRequest) => Promise<ControllerInstanceDetails>
  }
}

const endpointsFor = (
  expose: { kind: ControllerEndpoint['kind']; title?: string }[]
): ControllerEndpoint[] =>
  expose.map((entry, index) => ({
    kind: entry.kind,
    host: 'fc1.example.com',
    port: 30000 + index,
    ...(entry.title === undefined ? {} : { title: entry.title }),
  }))

const makeFakeService = (): FakeControllerService => {
  const calls: FakeControllerService['calls'] = {
    create: [],
    get: [],
    delete: [],
    extend: [],
  }

  const handlers: FakeControllerService['handlers'] = {
    create: async req => details(endpointsFor(req.expose)),
    get: async () => details(endpointsFor([])),
    delete: async () => details(endpointsFor([])),
    extend: async () => details(endpointsFor([])),
  }

  const service: ControllerService = {
    async create(req) {
      calls.create.push(req)
      return handlers.create(req)
    },
    async get(key) {
      calls.get.push(key)
      return handlers.get(key)
    },
    async delete(key) {
      calls.delete.push(key)
      return handlers.delete(key)
    },
    async extend(req) {
      calls.extend.push(req)
      return handlers.extend(req)
    },
    async listHosts() {
      return [hostSummary]
    },
    async drainHost() {
      return hostSummary
    },
    async undrainHost() {
      return hostSummary
    },
    async removeHost() {},
    async start() {},
    async stop() {},
  }

  return { service, calls, handlers }
}

interface RunningServer {
  url: string
  records: RecordedRequest[]
  stop: () => void
}

const runningServers: RunningServer[] = []

const startController = (
  fake: FakeControllerService = makeFakeService()
): { server: RunningServer; fake: FakeControllerService } => {
  const controller = createControllerServer({
    service: fake.service,
    authToken: AUTH_TOKEN,
    adminToken: ADMIN_TOKEN,
    logger: silentLogger(),
  })

  const records: RecordedRequest[] = []
  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async req => {
      const clone = req.clone()
      const body = await clone.text()
      records.push({
        method: req.method,
        path: new URL(req.url).pathname,
        authorization: req.headers.get('authorization'),
        contentType: req.headers.get('content-type'),
        body,
      })
      return controller.handler(req)
    },
  })

  const server: RunningServer = {
    url: `http://127.0.0.1:${http.port}`,
    records,
    stop: () => {
      http.stop(true)
    },
  }
  runningServers.push(server)
  return { server, fake }
}

const startRawServer = (
  handler: (req: Request) => Response | Promise<Response>
): RunningServer => {
  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: handler,
  })
  const server: RunningServer = {
    url: `http://127.0.0.1:${http.port}`,
    records: [],
    stop: () => {
      http.stop(true)
    },
  }
  runningServers.push(server)
  return server
}

const providerFor = (
  apiUrl: string,
  options: { timeoutMilliseconds?: number } = {}
) =>
  new FirecrackerInstancerProvider({
    apiUrl,
    authToken: AUTH_TOKEN,
    ...options,
  })

const createOptions = (
  overrides: Partial<CreateInstanceOptions> = {}
): CreateInstanceOptions => ({
  user: { id: 'team-1' } as User,
  challengeIntegrationId: 'chall-1',
  config: { image: 'example' },
  expose: [
    {
      kind: ExposeKind.TCP,
      hostPrefix: 'chal',
      containerName: 'app',
      containerPort: 1337,
      shouldDisplay: true,
      title: 'nc',
    },
  ],
  flags: [{ provider: 'flags/static', flag: 'rctf{secret}' }],
  timeoutMilliseconds: 60_000,
  ...overrides,
})

const queryOptions = (
  overrides: Partial<InstanceQueryOptions> = {}
): InstanceQueryOptions => ({
  teamId: 'team-1',
  challengeIntegrationId: 'chall-1',
  config: { image: 'example' },
  ...overrides,
})

const parseBody = (request: RecordedRequest): unknown =>
  JSON.parse(request.body)

beforeEach(() => {
  delete process.env.FIRECRACKER_INSTANCER_API_URL
  delete process.env.FIRECRACKER_INSTANCER_AUTH_TOKEN
})

afterEach(() => {
  while (runningServers.length > 0) {
    runningServers.pop()!.stop()
  }
  delete process.env.FIRECRACKER_INSTANCER_API_URL
  delete process.env.FIRECRACKER_INSTANCER_AUTH_TOKEN
})

describe('FirecrackerInstancerProvider construction', () => {
  test('is registered under instancers/firecracker', () => {
    const factory = instancerProviders['instancers/firecracker']
    expect(factory).toBeDefined()
    const provider = factory!({
      apiUrl: 'http://localhost',
      authToken: 'token',
    })
    expect(provider).toBeInstanceOf(FirecrackerInstancerProvider)
  })

  test('requires apiUrl and authToken', () => {
    expect(
      () => new FirecrackerInstancerProvider({ authToken: 'token' })
    ).toThrow(/apiUrl/)
    expect(
      () => new FirecrackerInstancerProvider({ apiUrl: 'http://localhost' })
    ).toThrow(/authToken/)
    expect(() => new FirecrackerInstancerProvider({})).toThrow(
      /FirecrackerInstancerProvider/
    )
  })

  test('env vars override provider options', () => {
    process.env.FIRECRACKER_INSTANCER_API_URL = 'http://env.example'
    process.env.FIRECRACKER_INSTANCER_AUTH_TOKEN = 'env-token'
    expect(() => new FirecrackerInstancerProvider({})).not.toThrow()
  })

  test('advertises stop and extend support', () => {
    const provider = new FirecrackerInstancerProvider({
      apiUrl: 'http://localhost',
      authToken: 'token',
    })
    expect(provider.capabilities).toEqual({ canStop: true, canExtend: true })
  })
})

describe('FirecrackerInstancerProvider config schema', () => {
  test('admin JSON schema serialises and defaults parse', () => {
    const provider = providerFor('http://localhost')
    const schema = firecrackerConfigInputJsonSchema()
    expect(schema).toHaveProperty('type', 'object')
    expect(() => JSON.stringify(schema)).not.toThrow()

    const defaults = provider.getDefaults()
    expect(defaults.image).toBe('example')
    expect(() => JSON.stringify(defaults)).not.toThrow()
    expect(provider.configSchema.safeParse(defaults).success).toBe(true)
  })

  test('config schema rejects a missing image', () => {
    const provider = providerFor('http://localhost')
    expect(provider.configSchema.safeParse({}).success).toBe(false)
    expect(provider.configSchema.safeParse({ image: 'example' }).success).toBe(
      true
    )
  })
})

describe('FirecrackerInstancerProvider create', () => {
  test('sends a clean create body with bearer auth', async () => {
    const { server } = startController()
    const provider = providerFor(server.url)

    const result = await provider.createInstance(createOptions())
    expect(result.kind).toBe('instancerInstanceDetails')

    expect(server.records).toHaveLength(1)
    const request = server.records[0]!
    expect(request.method).toBe('PUT')
    expect(request.path).toBe('/v1/instances')
    expect(request.authorization).toBe(`Bearer ${AUTH_TOKEN}`)
    expect(request.contentType).toContain('application/json')

    expect(parseBody(request)).toEqual({
      teamId: 'team-1',
      challengeIntegrationId: 'chall-1',
      config: { image: 'example' },
      expose: [
        {
          kind: 'tcp',
          hostPrefix: 'chal',
          containerName: 'app',
          containerPort: 1337,
          shouldDisplay: true,
          title: 'nc',
        },
      ],
      flags: [{ provider: 'flags/static', flag: 'rctf{secret}' }],
      timeoutMilliseconds: 60_000,
    })

    // Never spread the rCTF User or unrelated challenge fields.
    const body = parseBody(request) as Record<string, unknown>
    expect(body.user).toBeUndefined()
    expect(body.instancer).toBeUndefined()
    expect(body.extendable).toBeUndefined()
  })

  test('preserves expose order in the returned endpoints', async () => {
    const { server } = startController()
    const provider = providerFor(server.url)

    const result = await provider.createInstance(
      createOptions({
        expose: [
          {
            kind: ExposeKind.TCP,
            hostPrefix: 'first',
            containerName: 'app',
            containerPort: 1337,
            title: 'one',
          },
          {
            kind: ExposeKind.HTTP,
            hostPrefix: 'second',
            containerName: 'app',
            containerPort: 8080,
            title: 'two',
          },
        ],
      })
    )

    expect(result.kind).toBe('instancerInstanceDetails')
    if (result.kind !== 'instancerInstanceDetails') {
      return
    }
    expect(result.endpoints?.map(endpoint => endpoint.title)).toEqual([
      'one',
      'two',
    ])
    expect(result.endpoints?.map(endpoint => endpoint.port)).toEqual([
      30000, 30001,
    ])
  })

  test('rejects expose entries for another machine name', async () => {
    const { server, fake } = startController()
    const provider = providerFor(server.url)

    const result = await provider.createInstance(
      createOptions({
        expose: [
          {
            kind: ExposeKind.TCP,
            hostPrefix: 'chal',
            containerName: 'main',
            containerPort: 1337,
          },
        ],
      })
    )

    expect(result.kind).toBe('instancerError')
    if (result.kind === 'instancerError') {
      expect(result.message).toContain('containerName')
    }
    expect(server.records).toHaveLength(0)
    expect(fake.calls.create).toHaveLength(0)
  })

  test('rejects an empty expose list', async () => {
    const { server } = startController()
    const provider = providerFor(server.url)

    const result = await provider.createInstance(createOptions({ expose: [] }))
    expect(result.kind).toBe('instancerError')
    expect(server.records).toHaveLength(0)
  })

  test('rejects unsupported expose kinds before sending', async () => {
    const { server } = startController()
    const provider = providerFor(server.url)

    const result = await provider.createInstance(
      createOptions({
        expose: [
          {
            kind: 'udp' as ExposeKind,
            hostPrefix: 'chal',
            containerName: 'app',
            containerPort: 1337,
          },
        ],
      })
    )
    expect(result.kind).toBe('instancerError')
    expect(server.records).toHaveLength(0)
  })

  test('errors when the controller returns a different endpoint count', async () => {
    const { server, fake } = startController()
    fake.handlers.create = async () =>
      details([{ kind: 'tcp', host: 'fc1.example.com', port: 30000 }])
    const provider = providerFor(server.url)

    const result = await provider.createInstance(
      createOptions({
        expose: [
          {
            kind: ExposeKind.TCP,
            hostPrefix: 'first',
            containerName: 'app',
            containerPort: 1337,
          },
          {
            kind: ExposeKind.TCP,
            hostPrefix: 'second',
            containerName: 'app',
            containerPort: 1338,
          },
        ],
      })
    )

    expect(result.kind).toBe('instancerError')
    if (result.kind === 'instancerError') {
      expect(result.message).toContain('1')
      expect(result.message).toContain('2')
    }
  })

  test('errors when a running create returns null endpoints', async () => {
    const { server, fake } = startController()
    fake.handlers.create = async () => details(null)
    const provider = providerFor(server.url)

    const result = await provider.createInstance(createOptions())
    expect(result.kind).toBe('instancerError')
  })

  test('passes through a transitional (starting) create without endpoints', async () => {
    const { server, fake } = startController()
    fake.handlers.create = async () => ({
      ...details(null),
      status: 'starting',
    })
    const provider = providerFor(server.url)

    const result = await provider.createInstance(createOptions())
    expect(result.kind).toBe('instancerInstanceDetails')
    if (result.kind === 'instancerInstanceDetails') {
      expect(result.status).toBe('starting')
    }
  })

  test('never follows a redirect with the flag-bearing body', async () => {
    let leaked = false
    const sink = Bun.serve({
      port: 0,
      fetch: async req => {
        leaked = true
        await req.text()
        return Response.json(details([]))
      },
    })
    const redirector = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 307,
          headers: { Location: `http://127.0.0.1:${sink.port}/v1/instances` },
        }),
    })
    try {
      const provider = providerFor(`http://127.0.0.1:${redirector.port}`)
      const result = await provider.createInstance(createOptions())
      expect(result.kind).toBe('instancerError')
      expect(leaked).toBe(false)
    } finally {
      redirector.stop(true)
      sink.stop(true)
    }
  })

  test('rejects an apiUrl with credentials, query or a non-http scheme', () => {
    for (const apiUrl of [
      'ftp://controller.example.com',
      'http://user:pw@controller.example.com',
      'http://controller.example.com/?a=b',
      'not a url',
    ]) {
      expect(
        () => new FirecrackerInstancerProvider({ apiUrl, authToken: 't' })
      ).toThrow()
    }
  })
})

describe('FirecrackerInstancerProvider queries', () => {
  test('sends the protocol bodies for get, extend and delete', async () => {
    const { server } = startController()
    const provider = providerFor(server.url)

    const getResult = await provider.getInstance(queryOptions())
    expect(getResult.kind).toBe('instancerInstanceDetails')

    const extendResult = await provider.extendInstance({
      ...queryOptions(),
      timeoutMilliseconds: 120_000,
    })
    expect(extendResult.kind).toBe('instancerInstanceDetails')

    const deleteResult = await provider.deleteInstance(queryOptions())
    expect(deleteResult.kind).toBe('instancerInstanceDetails')

    expect(server.records.map(request => request.method)).toEqual([
      'POST',
      'PATCH',
      'DELETE',
    ])
    expect(server.records.map(request => request.path)).toEqual([
      '/v1/instances',
      '/v1/instances',
      '/v1/instances',
    ])

    expect(parseBody(server.records[0]!)).toEqual({
      teamId: 'team-1',
      challengeIntegrationId: 'chall-1',
    })
    expect(parseBody(server.records[1]!)).toEqual({
      teamId: 'team-1',
      challengeIntegrationId: 'chall-1',
      timeoutMilliseconds: 120_000,
    })
    expect(parseBody(server.records[2]!)).toEqual({
      teamId: 'team-1',
      challengeIntegrationId: 'chall-1',
    })

    for (const request of server.records) {
      expect(request.authorization).toBe(`Bearer ${AUTH_TOKEN}`)
      expect(request.body).not.toContain('rctf{secret}')
    }
  })

  test('surfaces controller error messages (business outcomes)', async () => {
    const { server, fake } = startController()
    fake.handlers.create = async () => {
      throw new ProtocolError('no_capacity', 'No hosts have capacity')
    }
    const provider = providerFor(server.url)

    const result = await provider.createInstance(createOptions())
    expect(result).toEqual({
      kind: 'instancerError',
      message: 'No hosts have capacity',
    })
  })
})

describe('FirecrackerInstancerProvider failure handling', () => {
  test('returns instancerError when the controller cannot be reached', async () => {
    const provider = providerFor('http://127.0.0.1:1')
    const result = await provider.getInstance(queryOptions())
    expect(result.kind).toBe('instancerError')
  })

  test('returns instancerError on timeout instead of throwing', async () => {
    const server = startRawServer(async () => {
      await new Promise(resolve => setTimeout(resolve, 2_000))
      return new Response('{}', {
        headers: { 'content-type': 'application/json' },
      })
    })
    const provider = providerFor(server.url, { timeoutMilliseconds: 50 })

    const started = Date.now()
    const result = await provider.getInstance(queryOptions())
    expect(result.kind).toBe('instancerError')
    if (result.kind === 'instancerError') {
      expect(result.message).toMatch(/respond in time/i)
    }
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  test('returns instancerError for non-JSON responses', async () => {
    const server = startRawServer(
      () => new Response('<html>nope</html>', { status: 500 })
    )
    const provider = providerFor(server.url)

    const result = await provider.getInstance(queryOptions())
    expect(result.kind).toBe('instancerError')
  })

  test('returns instancerError for a 5xx with an error body', async () => {
    const server = startRawServer(
      () =>
        new Response(
          JSON.stringify({
            kind: 'instancerError',
            message: 'Agent is unavailable',
            code: 'host_unavailable',
          }),
          { status: 503, headers: { 'content-type': 'application/json' } }
        )
    )
    const provider = providerFor(server.url)

    const result = await provider.getInstance(queryOptions())
    expect(result).toEqual({
      kind: 'instancerError',
      message: 'Agent is unavailable',
    })
  })

  test('returns instancerError for a 404 with a protocol message', async () => {
    const server = startRawServer(
      () =>
        new Response(
          JSON.stringify({
            kind: 'instancerError',
            message: 'Instance is gone',
            code: 'not_found',
          }),
          { status: 404, headers: { 'content-type': 'application/json' } }
        )
    )
    const provider = providerFor(server.url)

    const result = await provider.getInstance(queryOptions())
    expect(result).toEqual({
      kind: 'instancerError',
      message: 'Instance is gone',
    })
  })

  test('returns a generic error for an unknown error body', async () => {
    const server = startRawServer(
      () =>
        new Response(JSON.stringify({ nope: true }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
    )
    const provider = providerFor(server.url)

    const result = await provider.getInstance(queryOptions())
    expect(result.kind).toBe('instancerError')
    if (result.kind === 'instancerError') {
      expect(result.message).not.toContain('nope')
    }
  })

  test('returns instancerError for an invalid success response', async () => {
    const server = startRawServer(
      () =>
        new Response(JSON.stringify({ kind: 'instancerInstanceDetails' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const provider = providerFor(server.url)

    const result = await provider.getInstance(queryOptions())
    expect(result.kind).toBe('instancerError')
  })
})

describe('FirecrackerInstancerProvider logging', () => {
  test('never logs flags', async () => {
    const { server, fake } = startController()
    const provider = providerFor(server.url)
    const flag = 'rctf{never_log_this}'

    const original = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
    }
    let captured = ''
    const record = (...args: unknown[]) => {
      captured += args.map(String).join(' ')
    }
    console.log = record
    console.error = record
    console.warn = record
    console.info = record

    try {
      const created = await provider.createInstance(
        createOptions({
          flags: [{ provider: 'flags/static', flag }],
        })
      )
      expect(created.kind).toBe('instancerInstanceDetails')

      fake.handlers.create = async () =>
        details([{ kind: 'tcp', host: 'fc1.example.com', port: 30000 }])
      const failed = await provider.createInstance(
        createOptions({
          flags: [{ provider: 'flags/static', flag }],
          expose: [
            {
              kind: ExposeKind.TCP,
              hostPrefix: 'first',
              containerName: 'app',
              containerPort: 1337,
            },
            {
              kind: ExposeKind.TCP,
              hostPrefix: 'second',
              containerName: 'app',
              containerPort: 1338,
            },
          ],
        })
      )
      expect(failed.kind).toBe('instancerError')
    } finally {
      console.log = original.log
      console.error = original.error
      console.warn = original.warn
      console.info = original.info
    }

    expect(captured).not.toContain(flag)
  })
})
