import { describe, expect, test } from 'bun:test'
import {
  ERROR_HTTP_STATUS,
  ProtocolError,
  type ControllerInstanceDetails,
  type CreateInstanceRequest,
  type ErrorCode,
  type ExtendInstanceRequest,
  type HostSummary,
  type InstanceKey,
} from '@rctf/firecracker-protocol'
import { createControllerServer } from '../../src/controller/server'
import type { ControllerService } from '../../src/interfaces'
import type { Logger } from '../../src/log'

const AUTH_TOKEN = 'rctf-token'
const ADMIN_TOKEN = 'admin-token'

const instanceDetails = (
  endpoints: ControllerInstanceDetails['endpoints'] = [
    { kind: 'tcp', host: 'fc1.example.com', port: 30000 },
  ],
  status: ControllerInstanceDetails['status'] = 'running'
): ControllerInstanceDetails => ({
  kind: 'instancerInstanceDetails',
  status,
  timeLeftMilliseconds: 60_000,
  endpoints,
})

const hostSummary: HostSummary = {
  id: 'fc1',
  url: 'http://fc1.example.com:7001',
  health: 'healthy',
  lastSeenMs: 1_700_000_000_000,
  capacity: { vcpus: 16, memMiB: 32768, diskMiB: 100_000, maxInstances: 32 },
  reserved: { vcpus: 2, memMiB: 512, diskMiB: 2048, instances: 1 },
}

const validCreateBody = (flag = 'rctf{secret}'): CreateInstanceRequest => ({
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
  flags: [{ provider: 'flags/static', flag }],
  timeoutMilliseconds: 60_000,
})

interface RecordedCalls {
  create: CreateInstanceRequest[]
  get: InstanceKey[]
  delete: InstanceKey[]
  extend: ExtendInstanceRequest[]
  listHosts: number
  drain: string[]
  undrain: string[]
  remove: string[]
}

interface FakeService {
  service: ControllerService
  calls: RecordedCalls
  failWith: (err: Error | undefined) => void
  setDetails: (details: ControllerInstanceDetails) => void
  setHosts: (hosts: HostSummary[]) => void
}

const makeService = (): FakeService => {
  const calls: RecordedCalls = {
    create: [],
    get: [],
    delete: [],
    extend: [],
    listHosts: 0,
    drain: [],
    undrain: [],
    remove: [],
  }
  let failure: Error | undefined
  let details = instanceDetails()
  let hosts = [hostSummary]

  const maybeFail = () => {
    if (failure) {
      throw failure
    }
  }

  const service: ControllerService = {
    async create(req) {
      calls.create.push(req)
      maybeFail()
      return details
    },
    async get(key) {
      calls.get.push(key)
      maybeFail()
      return details
    },
    async delete(key) {
      calls.delete.push(key)
      maybeFail()
      return details
    },
    async extend(req) {
      calls.extend.push(req)
      maybeFail()
      return details
    },
    async listHosts() {
      calls.listHosts += 1
      maybeFail()
      return hosts
    },
    async drainHost(hostId) {
      calls.drain.push(hostId)
      maybeFail()
      return hostSummary
    },
    async undrainHost(hostId) {
      calls.undrain.push(hostId)
      maybeFail()
      return hostSummary
    },
    async removeHost(hostId) {
      calls.remove.push(hostId)
      maybeFail()
    },
    async start() {},
    async stop() {},
  }

  return {
    service,
    calls,
    failWith: err => {
      failure = err
    },
    setDetails: next => {
      details = next
    },
    setHosts: next => {
      hosts = next
    },
  }
}

const makeLogger = () => {
  const entries: unknown[][] = []
  const record = (...args: unknown[]) => {
    entries.push(args)
  }
  const logger = {
    info: record,
    error: record,
    warn: record,
    debug: record,
    trace: record,
    fatal: record,
    child: () => logger,
  } as unknown as Logger
  return { logger, entries }
}

interface CallOptions {
  token?: string
  body?: unknown
  rawBody?: string
  contentType?: string
  headers?: Record<string, string>
  omitContentLength?: boolean
}

const makeServer = (maxBodyBytes?: number) => {
  const fake = makeService()
  const { logger, entries } = makeLogger()
  const server = createControllerServer({
    service: fake.service,
    authToken: AUTH_TOKEN,
    adminToken: ADMIN_TOKEN,
    logger,
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
  })
  return { server, fake, logger, logEntries: entries }
}

const call = (
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  options: CallOptions = {}
): Promise<Response> => {
  const headers = new Headers(options.headers)
  if (options.token !== undefined) {
    headers.set('authorization', `Bearer ${options.token}`)
  }

  const hasBody = options.body !== undefined || options.rawBody !== undefined
  let body: string | undefined
  if (hasBody) {
    body =
      options.rawBody ??
      (typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body))
    headers.set('content-type', options.contentType ?? 'application/json')
    if (!options.omitContentLength) {
      headers.set('content-length', String(Buffer.byteLength(body)))
    }
  }

  return handler(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    })
  )
}

const expectError = async (
  response: Response,
  status: number,
  code: ErrorCode
) => {
  expect(response.status).toBe(status)
  const body = (await response.clone().json()) as {
    kind: string
    message: string
    code: string
  }
  expect(body.kind).toBe('instancerError')
  expect(body.code).toBe(code)
  expect(body.message.length).toBeGreaterThan(0)
}

describe('controller server: startup validation', () => {
  test('rejects missing or equal tokens', () => {
    const fake = makeService()
    const { logger } = makeLogger()
    expect(() =>
      createControllerServer({
        service: fake.service,
        authToken: '',
        adminToken: ADMIN_TOKEN,
        logger,
      })
    ).toThrow(/authToken/)
    expect(() =>
      createControllerServer({
        service: fake.service,
        authToken: AUTH_TOKEN,
        adminToken: '   ',
        logger,
      })
    ).toThrow(/adminToken/)
    expect(() =>
      createControllerServer({
        service: fake.service,
        authToken: AUTH_TOKEN,
        adminToken: AUTH_TOKEN,
        logger,
      })
    ).toThrow(/different/)
  })
})

describe('controller server: auth matrix', () => {
  test('healthz is open and exposes no details', async () => {
    const { server } = makeServer()
    const response = await call(server.handler, 'GET', '/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test('instances require the rCTF token', async () => {
    const { server, fake } = makeServer()
    const body = validCreateBody()

    await expectError(
      await call(server.handler, 'PUT', '/v1/instances', { body }),
      401,
      'unauthorized'
    )
    await expectError(
      await call(server.handler, 'PUT', '/v1/instances', {
        body,
        token: 'wrong-token',
      }),
      401,
      'unauthorized'
    )
    await expectError(
      await call(server.handler, 'PUT', '/v1/instances', {
        body,
        token: ADMIN_TOKEN,
      }),
      401,
      'unauthorized'
    )

    expect(fake.calls.create).toHaveLength(0)

    const ok = await call(server.handler, 'PUT', '/v1/instances', {
      body,
      token: AUTH_TOKEN,
    })
    expect(ok.status).toBe(200)
    expect(fake.calls.create).toHaveLength(1)
  })

  test('ops routes require the admin token, not the rCTF token', async () => {
    const { server, fake } = makeServer()

    await expectError(
      await call(server.handler, 'GET', '/v1/hosts', { token: AUTH_TOKEN }),
      401,
      'unauthorized'
    )
    await expectError(
      await call(server.handler, 'POST', '/v1/hosts/fc1/drain', {
        token: AUTH_TOKEN,
      }),
      401,
      'unauthorized'
    )
    await expectError(
      await call(server.handler, 'DELETE', '/v1/hosts/fc1', {
        token: AUTH_TOKEN,
      }),
      401,
      'unauthorized'
    )

    expect(fake.calls.listHosts).toBe(0)
    expect(fake.calls.drain).toHaveLength(0)

    const list = await call(server.handler, 'GET', '/v1/hosts', {
      token: ADMIN_TOKEN,
    })
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ hosts: [hostSummary] })

    const drain = await call(server.handler, 'POST', '/v1/hosts/fc1/drain', {
      token: ADMIN_TOKEN,
    })
    expect(drain.status).toBe(200)
    expect(await drain.json()).toEqual(hostSummary)
    expect(fake.calls.drain).toEqual(['fc1'])

    const undrain = await call(
      server.handler,
      'POST',
      '/v1/hosts/fc1/undrain',
      { token: ADMIN_TOKEN }
    )
    expect(undrain.status).toBe(200)
    expect(fake.calls.undrain).toEqual(['fc1'])

    const remove = await call(server.handler, 'DELETE', '/v1/hosts/fc1', {
      token: ADMIN_TOKEN,
    })
    expect(remove.status).toBe(204)
    expect(fake.calls.remove).toEqual(['fc1'])
  })

  test('rejects a missing bearer token on ops routes', async () => {
    const { server } = makeServer()
    await expectError(
      await call(server.handler, 'GET', '/v1/hosts'),
      401,
      'unauthorized'
    )
  })
})

describe('controller server: body handling', () => {
  test('rejects bodies above the limit with 413', async () => {
    const { server } = makeServer(64)
    const response = await call(server.handler, 'PUT', '/v1/instances', {
      body: validCreateBody(),
      token: AUTH_TOKEN,
    })
    await expectError(response, 413, 'invalid_request')
  })

  test('enforces the limit without a content-length header', async () => {
    const { server } = makeServer(64)
    const response = await call(server.handler, 'PUT', '/v1/instances', {
      body: validCreateBody(),
      token: AUTH_TOKEN,
      omitContentLength: true,
    })
    await expectError(response, 413, 'invalid_request')
  })

  test('requires a JSON content type', async () => {
    const { server } = makeServer()
    const response = await call(server.handler, 'PUT', '/v1/instances', {
      rawBody: 'teamId=team-1',
      contentType: 'application/x-www-form-urlencoded',
      token: AUTH_TOKEN,
    })
    await expectError(response, 415, 'invalid_request')
  })

  test('rejects invalid JSON without echoing it', async () => {
    const { server } = makeServer()
    const marker = 'leaky-team-id'
    const response = await call(server.handler, 'PUT', '/v1/instances', {
      rawBody: `{"teamId":"${marker}"`,
      token: AUTH_TOKEN,
    })
    await expectError(response, 400, 'invalid_request')
    expect(await response.text()).not.toContain(marker)
  })

  test('rejects zod-invalid bodies without echoing flags', async () => {
    const { server } = makeServer()
    const flag = 'rctf{zod_echo_canary}'
    const body = { ...validCreateBody(flag), timeoutMilliseconds: 1 }
    const response = await call(server.handler, 'PUT', '/v1/instances', {
      body,
      token: AUTH_TOKEN,
    })
    await expectError(response, 400, 'invalid_request')
    expect(await response.text()).not.toContain(flag)
  })
})

describe('controller server: dispatch', () => {
  test('parses and forwards each instance method body', async () => {
    const { server, fake } = makeServer()
    const create = validCreateBody()
    const key = { teamId: 'team-1', challengeIntegrationId: 'chall-1' }
    const extend = { ...key, timeoutMilliseconds: 120_000 }

    expect(
      (
        await call(server.handler, 'PUT', '/v1/instances', {
          body: create,
          token: AUTH_TOKEN,
        })
      ).status
    ).toBe(200)
    expect(
      (
        await call(server.handler, 'POST', '/v1/instances', {
          body: key,
          token: AUTH_TOKEN,
        })
      ).status
    ).toBe(200)
    expect(
      (
        await call(server.handler, 'PATCH', '/v1/instances', {
          body: extend,
          token: AUTH_TOKEN,
        })
      ).status
    ).toBe(200)
    expect(
      (
        await call(server.handler, 'DELETE', '/v1/instances', {
          body: key,
          token: AUTH_TOKEN,
        })
      ).status
    ).toBe(200)

    expect(fake.calls.create).toEqual([create])
    expect(fake.calls.get).toEqual([key])
    expect(fake.calls.extend).toEqual([extend])
    expect(fake.calls.delete).toEqual([key])
  })

  test('accepts trailing slashes', async () => {
    const { server } = makeServer()
    const response = await call(server.handler, 'GET', '/v1/hosts/', {
      token: ADMIN_TOKEN,
    })
    expect(response.status).toBe(200)
  })

  test('returns 404 for unknown paths and 405 for wrong methods', async () => {
    const { server } = makeServer()
    await expectError(
      await call(server.handler, 'GET', '/v1/nope', { token: AUTH_TOKEN }),
      404,
      'not_found'
    )
    const wrong = await call(server.handler, 'GET', '/v1/instances', {
      token: AUTH_TOKEN,
    })
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toContain('PUT')
  })
})

describe('controller server: host ids', () => {
  test('rejects invalid host ids before calling the service', async () => {
    const { server, fake } = makeServer()
    for (const hostId of ['Bad_', 'a_b', '-leading', 'a'.repeat(33)]) {
      const response = await call(
        server.handler,
        'POST',
        `/v1/hosts/${encodeURIComponent(hostId)}/drain`,
        { token: ADMIN_TOKEN }
      )
      await expectError(response, 400, 'invalid_request')
    }
    expect(fake.calls.drain).toHaveLength(0)
  })

  test('maps a missing host ProtocolError to 404', async () => {
    const { server, fake } = makeServer()
    fake.failWith(new ProtocolError('not_found', 'unknown host'))
    const response = await call(server.handler, 'POST', '/v1/hosts/fc1/drain', {
      token: ADMIN_TOKEN,
    })
    await expectError(response, 404, 'not_found')
  })
})

describe('controller server: errors', () => {
  test('maps every ProtocolError code to its HTTP status and code', async () => {
    const codes = Object.keys(ERROR_HTTP_STATUS) as ErrorCode[]
    expect(codes.length).toBeGreaterThan(0)

    for (const code of codes) {
      const { server, fake } = makeServer()
      fake.failWith(new ProtocolError(code, `business outcome: ${code}`))
      const response = await call(server.handler, 'PUT', '/v1/instances', {
        body: validCreateBody(),
        token: AUTH_TOKEN,
      })
      await expectError(response, ERROR_HTTP_STATUS[code], code)
      const text = await response.text()
      if (code === 'internal') {
        // Internal messages can embed infrastructure detail (or worse); they
        // are masked for the player and only the code is passed on.
        expect(text).not.toContain(`business outcome: ${code}`)
        expect(text).toContain('Internal server error')
      } else {
        expect(text).toContain(`business outcome: ${code}`)
      }
    }
  })

  test('returns a generic 500 and logs details for unexpected errors', async () => {
    const { server, fake, logEntries } = makeServer()
    fake.failWith(new Error('internal detail with rctf{log_canary}'))
    const flag = 'rctf{request_canary}'
    const response = await call(server.handler, 'PUT', '/v1/instances', {
      body: validCreateBody(flag),
      token: AUTH_TOKEN,
    })
    await expectError(response, 500, 'internal')
    const text = await response.text()
    expect(text).not.toContain('internal detail')
    expect(text).not.toContain(flag)

    const logs = JSON.stringify(logEntries)
    expect(logs).toContain('internal detail')
    expect(logs).not.toContain(flag)
  })

  test('never logs request bodies on successful or rejected requests', async () => {
    const { server, logEntries } = makeServer()
    const flag = 'rctf{never_log_me}'

    const ok = await call(server.handler, 'PUT', '/v1/instances', {
      body: validCreateBody(flag),
      token: AUTH_TOKEN,
    })
    expect(ok.status).toBe(200)

    const bad = await call(server.handler, 'PUT', '/v1/instances', {
      body: { ...validCreateBody(flag), timeoutMilliseconds: 0 },
      token: AUTH_TOKEN,
    })
    expect(bad.status).toBe(400)

    expect(JSON.stringify(logEntries)).not.toContain(flag)
  })
})

describe('controller server: shutdown drain', () => {
  test('drain waits for an in-flight request and gives up at the deadline', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { server, fake } = makeServer()
    const originalCreate = fake.service.create
    fake.service.create = async req => {
      await gate
      return originalCreate(req)
    }

    const pending = call(server.handler, 'PUT', '/v1/instances', {
      body: validCreateBody(),
      token: AUTH_TOKEN,
    })

    let drained = false
    const drain = server.drain(5_000).then(() => {
      drained = true
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(drained).toBe(false)

    release()
    await pending
    await drain
    expect(drained).toBe(true)

    // A stuck request must not block shutdown beyond the deadline.
    fake.service.create = () => new Promise(() => {})
    void call(server.handler, 'PUT', '/v1/instances', {
      body: validCreateBody(),
      token: AUTH_TOKEN,
    })
    const started = Date.now()
    await server.drain(50)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
