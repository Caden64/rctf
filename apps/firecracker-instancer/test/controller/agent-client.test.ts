import { afterAll, describe, expect, test } from 'bun:test'
import { AgentRejectedError, AgentUnreachableError } from '../../src/interfaces'
import { HttpAgentClient } from '../../src/controller/agent-client'
import type { HostConfig } from '../../src/controller/config'
import { makeAgentSpec } from './helpers'

const servers: Array<{ stop: (force?: boolean) => void }> = []

afterAll(() => {
  for (const server of servers) server.stop(true)
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
