import { afterAll, describe, expect, test } from 'bun:test'
import { AgentRejectedError, AgentUnreachableError } from '../../src/interfaces'
import { HttpAgentClient } from '../../src/controller/agent-client'
import type { HostConfig } from '../../src/controller/config'
import { makeAgentSpec } from './helpers'
import { cleanupDir, fixture, installFixtures, testDir } from '../tls/helpers'

const servers: Array<{ stop: (force?: boolean) => void }> = []
const dirs: string[] = []

afterAll(() => {
  for (const server of servers) server.stop(true)
  while (dirs.length > 0) cleanupDir(dirs.pop()!)
})

const agentInfo = {
  version: 'fake-1',
  hostId: 'host-a',
  timeMs: 1000,
  capacity: { vcpus: 8, memMiB: 4096, diskMiB: 4096, maxInstances: 10 },
  usage: { vcpus: 0, memMiB: 0, diskMiB: 0, instances: 0 },
  accepting: true,
  checks: {},
  images: ['base'],
}

const agentInstance = {
  id: 'a'.repeat(24),
  state: 'running',
  createdAtMs: 1000,
  expiresAtMs: 2000,
  endpoints: [{ kind: 'http', host: 'h.fc.test', port: 20000 }],
  specHash: 'hash',
}

const startServer = (
  handler: (request: Request) => Response | Promise<Response>
): {
  url: string
  client: (opts?: { timeoutMs?: number }) => HttpAgentClient
  seen: { authorizations: string[]; methods: string[] }
} => {
  const seen = { authorizations: [] as string[], methods: [] as string[] }
  const server = Bun.serve({
    port: 0,
    fetch: async request => {
      seen.authorizations.push(request.headers.get('authorization') ?? '')
      seen.methods.push(`${request.method} ${new URL(request.url).pathname}`)
      return handler(request)
    },
  })
  servers.push(server)
  const config: HostConfig = {
    id: 'host-a',
    url: `http://127.0.0.1:${server.port}`,
    token: 'host-token',
    capacity: { vcpus: 8, memMiB: 4096, diskMiB: 4096, maxInstances: 10 },
  }
  return {
    url: `http://127.0.0.1:${server.port}`,
    client: opts =>
      new HttpAgentClient(config, {
        timeoutMs: opts?.timeoutMs ?? 500,
      }),
    seen,
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('HttpAgentClient', () => {
  test('never follows a redirect with the flag-bearing create body', async () => {
    let leaked = false
    const sink = startServer(async request => {
      leaked = true
      await request.text()
      return json(agentInstance)
    })
    const redirector = startServer(
      () =>
        new Response(null, {
          status: 307,
          headers: { Location: `${sink.url}/v1/instances/${'a'.repeat(24)}` },
        })
    )
    // The sink records anything that reaches it; only the redirector may be hit.
    await expect(
      redirector.client().create(makeAgentSpec('a'.repeat(24)))
    ).rejects.toBeInstanceOf(AgentUnreachableError)
    expect(leaked).toBe(false)
    expect(sink.seen.methods).toEqual([])
  })

  test('sends the bearer token and parses the info response', async () => {
    const { client, seen } = startServer(() => json(agentInfo))
    const info = await client().info()
    expect(info.hostId).toBe('host-a')
    expect(seen.authorizations).toEqual(['Bearer host-token'])
  })

  test('404 on get is undefined and delete of an unknown id resolves', async () => {
    const { client } = startServer(
      () => new Response('not found', { status: 404 })
    )
    expect(await client().get('a'.repeat(24))).toBeUndefined()
    await expect(client().delete('a'.repeat(24))).resolves.toBeUndefined()
  })

  test('DELETE only confirms on 2xx or 404', async () => {
    // 2xx (empty or record body) confirms.
    for (const body of ['', JSON.stringify(agentInstance)]) {
      const { client } = startServer(() => new Response(body, { status: 200 }))
      await expect(client().delete('a'.repeat(24))).resolves.toBeUndefined()
    }

    // 404 (plain or agent not_found body) confirms.
    for (const body of [
      'not found',
      JSON.stringify({ kind: 'agentError', code: 'not_found', message: 'x' }),
    ]) {
      const { client } = startServer(() => new Response(body, { status: 404 }))
      await expect(client().delete('a'.repeat(24))).resolves.toBeUndefined()
    }

    // Everything else must throw: the caller keeps the row fenced.
    const failures: Array<{
      body: string
      status: number
      kind: 'rejected' | 'unreachable'
    }> = [
      {
        body: JSON.stringify({
          kind: 'agentError',
          code: 'expired',
          message: 'gone',
        }),
        status: 410,
        kind: 'rejected',
      },
      {
        body: JSON.stringify({
          kind: 'agentError',
          code: 'internal',
          message: 'boom',
        }),
        status: 409,
        kind: 'rejected',
      },
      { body: 'upstream down', status: 502, kind: 'unreachable' },
      { body: 'not json', status: 200, kind: 'unreachable' },
      { body: '{}', status: 200, kind: 'unreachable' },
    ]
    for (const failure of failures) {
      const { client } = startServer(
        () => new Response(failure.body, { status: failure.status })
      )
      const error = await client()
        .delete('a'.repeat(24))
        .then(() => 'resolved')
        .catch(error => error)
      expect(error).toBeInstanceOf(
        failure.kind === 'rejected' ? AgentRejectedError : AgentUnreachableError
      )
    }
  })

  test('a timed-out DELETE does not confirm teardown', async () => {
    const { client } = startServer(async () => {
      await Bun.sleep(100)
      return new Response('', { status: 200 })
    })
    const error = await client({ timeoutMs: 10 })
      .delete('a'.repeat(24))
      .then(() => 'resolved')
      .catch(error => error)
    expect(error).toBeInstanceOf(AgentUnreachableError)
  })

  test('a well-formed 507 becomes AgentRejectedError(no_capacity)', async () => {
    const { client } = startServer(() =>
      json({ kind: 'agentError', code: 'no_capacity', message: 'full' }, 507)
    )
    const error = await client()
      .create(makeAgentSpec('a'.repeat(24)))
      .catch(error => error)
    expect(error).toBeInstanceOf(AgentRejectedError)
    expect((error as AgentRejectedError).code).toBe('no_capacity')
  })

  test('documented pre-create rejections stay AgentRejectedError', async () => {
    for (const [code, status] of [
      ['no_capacity', 507],
      ['draining', 503],
      ['invalid_request', 400],
      ['unauthorized', 401],
    ] as const) {
      const { client } = startServer(() =>
        json({ kind: 'agentError', code, message: code }, status)
      )
      const error = await client()
        .create(makeAgentSpec('a'.repeat(24)))
        .catch(error => error)
      expect(error).toBeInstanceOf(AgentRejectedError)
      expect((error as AgentRejectedError).code).toBe(code)
    }
  })

  test('a well-formed HTTP 500 body after a create is ambiguous', async () => {
    let created = false
    const { client } = startServer(request => {
      if (request.method === 'PUT') {
        created = true
        return json(
          { kind: 'agentError', code: 'internal', message: 'mid-create' },
          500
        )
      }
      return json(agentInfo)
    })
    const error = await client()
      .create(makeAgentSpec('a'.repeat(24)))
      .catch(error => error)
    // The VM may exist: the controller must keep the row and reconcile.
    expect(created).toBe(true)
    expect(error).toBeInstanceOf(AgentUnreachableError)
  })

  test('non-definitive create error codes are ambiguous', async () => {
    for (const [code, status] of [
      ['host_unavailable', 503],
      ['conflict', 409],
      ['spec_mismatch', 409],
      ['in_progress', 409],
      ['internal', 500],
    ] as const) {
      const { client } = startServer(() =>
        json({ kind: 'agentError', code, message: code }, status)
      )
      const error = await client()
        .create(makeAgentSpec('a'.repeat(24)))
        .catch(error => error)
      expect(error).toBeInstanceOf(AgentUnreachableError)
    }
  })

  test('a malformed 2xx create body is ambiguous', async () => {
    const { client } = startServer(
      () => new Response('not json', { status: 200 })
    )
    const error = await client()
      .create(makeAgentSpec('a'.repeat(24)))
      .catch(error => error)
    expect(error).toBeInstanceOf(AgentUnreachableError)
  })

  test('a 500 on GET is unreachable, not a rejection', async () => {
    const { client } = startServer(() =>
      json({ kind: 'agentError', code: 'internal', message: 'boom' }, 500)
    )
    const error = await client()
      .get(agentInstance.id)
      .catch(error => error)
    expect(error).toBeInstanceOf(AgentUnreachableError)
  })

  test('malformed JSON is an error, not a crash', async () => {
    const { client } = startServer(
      () => new Response('<html>oops</html>', { status: 200 })
    )
    const error = await client()
      .info()
      .catch(error => error)
    expect(error).toBeInstanceOf(AgentRejectedError)
  })

  test('plain 5xx is AgentUnreachableError', async () => {
    const { client } = startServer(
      () => new Response('upstream down', { status: 502 })
    )
    const error = await client()
      .info()
      .catch(error => error)
    expect(error).toBeInstanceOf(AgentUnreachableError)
  })

  test('a slow agent times out as AgentUnreachableError', async () => {
    const { client } = startServer(async () => {
      await Bun.sleep(150)
      return json(agentInfo)
    })
    const error = await client({ timeoutMs: 10 })
      .info()
      .catch(error => error)
    expect(error).toBeInstanceOf(AgentUnreachableError)
  })

  test('a closed port is AgentUnreachableError', async () => {
    const server = Bun.serve({ port: 0, fetch: () => json(agentInfo) })
    const port = server.port
    server.stop(true)
    const config: HostConfig = {
      id: 'host-a',
      url: `http://127.0.0.1:${port}`,
      capacity: { vcpus: 1, memMiB: 1, diskMiB: 1, maxInstances: 1 },
    }
    const error = await new HttpAgentClient(config, { timeoutMs: 100 })
      .info()
      .catch(error => error)
    expect(error).toBeInstanceOf(AgentUnreachableError)
  })

  test('parses GET /v1/instances/:id and list', async () => {
    const { client } = startServer(request => {
      const path = new URL(request.url).pathname
      if (path === '/v1/instances') return json([agentInstance])
      return json(agentInstance)
    })
    expect((await client().get(agentInstance.id))?.state).toBe('running')
    expect(await client().list()).toHaveLength(1)
  })
})

describe('HttpAgentClient TLS options', () => {
  type SeenInit = RequestInit & {
    tls?: {
      ca?: string
      cert?: string
      key?: string
      rejectUnauthorized?: boolean
    }
  }

  const capture = (): {
    seen: () => SeenInit | undefined
    fetch: typeof fetch
  } => {
    let seen: SeenInit | undefined
    const spy = (async (_input: string, init?: SeenInit) => {
      seen = init
      return json(agentInfo)
    }) as unknown as typeof fetch
    return { seen: () => seen, fetch: spy }
  }

  const baseConfig = (overrides: Partial<HostConfig> = {}): HostConfig => ({
    id: 'host-a',
    url: 'https://127.0.0.1:7001',
    token: 'host-token',
    capacity: { vcpus: 8, memMiB: 4096, diskMiB: 4096, maxInstances: 10 },
    ...overrides,
  })

  test('passes an inline CA and explicit verification to fetch', async () => {
    const spy = capture()
    const client = new HttpAgentClient(
      baseConfig({ caCertificate: fixture('ca.crt') }),
      { fetch: spy.fetch }
    )
    await client.info()
    const init = spy.seen()
    expect(init?.tls).toEqual({
      ca: fixture('ca.crt'),
      rejectUnauthorized: true,
    })
    const headers = init?.headers as Record<string, string> | undefined
    expect(headers?.Authorization).toBe('Bearer host-token')
  })

  test('passes CA, client certificate and key loaded from files', async () => {
    const dir = testDir()
    dirs.push(dir)
    const paths = installFixtures(dir)
    const spy = capture()
    const client = new HttpAgentClient(
      baseConfig({
        caCertificateFile: paths.caCert,
        clientCertFile: paths.clientCert,
        clientKeyFile: paths.clientKey,
      }),
      { fetch: spy.fetch }
    )
    await client.info()
    expect(spy.seen()?.tls).toEqual({
      ca: fixture('ca.crt'),
      cert: fixture('client.crt'),
      key: fixture('client.key'),
      rejectUnauthorized: true,
    })
  })

  test('omits tls entirely when the host has no TLS settings', async () => {
    const spy = capture()
    const client = new HttpAgentClient(
      baseConfig({ url: 'http://127.0.0.1:7001' }),
      { fetch: spy.fetch }
    )
    await client.info()
    expect(spy.seen()?.tls).toBeUndefined()
  })

  test('forces verification for an https host with no TLS material', async () => {
    // No CA configured: system trust is used, but verification must still be
    // explicit so NODE_TLS_REJECT_UNAUTHORIZED=0 cannot disable it.
    const spy = capture()
    const client = new HttpAgentClient(baseConfig(), { fetch: spy.fetch })
    await client.info()
    expect(spy.seen()?.tls).toEqual({ rejectUnauthorized: true })
  })

  test('fails closed when both CA forms are set on a direct config', () => {
    const dir = testDir()
    dirs.push(dir)
    const paths = installFixtures(dir)
    expect(
      () =>
        new HttpAgentClient(
          baseConfig({
            caCertificate: fixture('ca.crt'),
            caCertificateFile: paths.caCert,
          })
        )
    ).toThrow(/mutually exclusive/)
  })
})
