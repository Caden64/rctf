import { afterEach, describe, expect, it } from 'bun:test'
import {
  agentErrorSchema,
  agentInfoSchema,
  agentInstanceSchema,
} from '@rctf/firecracker-protocol'
import {
  MAX_REQUEST_BODY_BYTES,
  constantTimeEqual,
  createAgentServer,
  tokensMatch,
  type AgentServer,
} from '../../src/agent/server'
import { makeSpec, nextId } from './fakes'
import { createHarness, type Harness } from './harness'

const harnesses: Harness[] = []
const servers: AgentServer[] = []

interface ServerHarness {
  harness: Harness
  server: AgentServer
  base: string
  headers: Record<string, string>
}

const setup = async (deps?: {
  maxRequestBodyBytes?: number
}): Promise<ServerHarness> => {
  const harness = await createHarness()
  harnesses.push(harness)
  const server = createAgentServer({
    config: harness.config,
    manager: harness.mgr,
    ...(deps?.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: deps.maxRequestBodyBytes }),
  })
  servers.push(server)
  return {
    harness,
    server,
    base: `http://127.0.0.1:${server.server.port}`,
    headers: {
      authorization: `Bearer ${harness.config.token}`,
      'content-type': 'application/json',
    },
  }
}

const call = (
  ctx: ServerHarness,
  path: string,
  init?: RequestInit
): Promise<Response> =>
  fetch(`${ctx.base}${path}`, {
    ...init,
  })

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => {})
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

describe('agent HTTP auth', () => {
  it('rejects missing and wrong bearers with 401', async () => {
    const ctx = await setup()

    const missing = await fetch(`${ctx.base}/v1/info`)
    expect(missing.status).toBe(401)
    expect(agentErrorSchema.parse(await missing.json()).code).toBe(
      'unauthorized'
    )

    const wrong = await fetch(`${ctx.base}/v1/info`, {
      headers: { authorization: 'Bearer not-the-token' },
    })
    expect(wrong.status).toBe(401)
  })

  it('accepts the right bearer and returns valid info', async () => {
    const ctx = await setup()
    const response = await call(ctx, '/v1/info', { headers: ctx.headers })
    expect(response.status).toBe(200)
    const info = agentInfoSchema.parse(await response.json())
    expect(info.hostId).toBe('host1')
    expect(info.accepting).toBe(true)
    expect(info.capabilities).toContain('instance-absence-v1')
  })

  it('has a constant-time comparison helper', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(tokensMatch('Bearer abc', 'abc')).toBe(true)
    expect(tokensMatch('Bearer abc', 'abc ')).toBe(false)
    expect(tokensMatch(undefined, 'abc')).toBe(false)
    expect(tokensMatch('Basic abc', 'abc')).toBe(false)
  })

  it('refuses to start without a configured token', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    expect(() =>
      createAgentServer({
        config: { ...harness.config, token: undefined },
        manager: harness.mgr,
      })
    ).toThrow()
  })
})

describe('agent HTTP instance routes', () => {
  it('creates idempotently and maps errors', async () => {
    const ctx = await setup()
    const spec = makeSpec()

    const created = await call(ctx, `/v1/instances/${spec.id}`, {
      method: 'PUT',
      headers: ctx.headers,
      body: JSON.stringify(spec),
    })
    expect(created.status).toBe(200)
    const instance = agentInstanceSchema.parse(await created.json())
    expect(instance.id).toBe(spec.id)

    const repeat = await call(ctx, `/v1/instances/${spec.id}`, {
      method: 'PUT',
      headers: ctx.headers,
      body: JSON.stringify(spec),
    })
    expect(repeat.status).toBe(200)
    expect(agentInstanceSchema.parse(await repeat.json()).specHash).toBe(
      instance.specHash
    )

    const mismatch = await call(ctx, `/v1/instances/${spec.id}`, {
      method: 'PUT',
      headers: ctx.headers,
      body: JSON.stringify({ ...spec, memMiB: spec.memMiB + 128 }),
    })
    expect(mismatch.status).toBe(409)
    expect(agentErrorSchema.parse(await mismatch.json()).code).toBe(
      'spec_mismatch'
    )

    const got = await call(ctx, `/v1/instances/${spec.id}`, {
      headers: ctx.headers,
    })
    expect(got.status).toBe(200)
    agentInstanceSchema.parse(await got.json())

    const listed = await call(ctx, '/v1/instances', { headers: ctx.headers })
    const list = await listed.json()
    expect(Array.isArray(list)).toBe(true)
    expect(list).toHaveLength(1)

    const extended = await call(ctx, `/v1/instances/${spec.id}`, {
      method: 'PATCH',
      headers: ctx.headers,
      body: JSON.stringify({ expiresAtMs: spec.expiresAtMs + 1000 }),
    })
    expect(extended.status).toBe(200)
    expect(agentInstanceSchema.parse(await extended.json()).expiresAtMs).toBe(
      spec.expiresAtMs + 1000
    )

    const deleted = await call(ctx, `/v1/instances/${spec.id}`, {
      method: 'DELETE',
      headers: ctx.headers,
    })
    expect(deleted.status).toBe(200)
    expect(agentInstanceSchema.parse(await deleted.json()).state).toBe(
      'stopped'
    )

    const again = await call(ctx, `/v1/instances/${spec.id}`, {
      method: 'DELETE',
      headers: ctx.headers,
    })
    expect(again.status).toBe(404)
    const againBody = agentErrorSchema.parse(await again.json())
    expect(againBody.code).toBe('not_found')
    // The absence discriminator: the instance route echoes the validated id.
    expect(againBody.instanceId).toBe(spec.id)
  })

  it('validates path ids and body ids', async () => {
    const ctx = await setup()
    const spec = makeSpec()

    const badPath = await call(ctx, '/v1/instances/NOT-A-VALID-ID', {
      method: 'PUT',
      headers: ctx.headers,
      body: JSON.stringify(spec),
    })
    expect(badPath.status).toBe(400)
    expect(agentErrorSchema.parse(await badPath.json()).code).toBe(
      'invalid_request'
    )

    const otherId = nextId()
    const badBody = await call(ctx, `/v1/instances/${otherId}`, {
      method: 'PUT',
      headers: ctx.headers,
      body: JSON.stringify(spec),
    })
    expect(badBody.status).toBe(400)
    expect(agentErrorSchema.parse(await badBody.json()).code).toBe(
      'invalid_request'
    )

    const malformed = await call(ctx, `/v1/instances/${otherId}`, {
      method: 'PUT',
      headers: ctx.headers,
      body: JSON.stringify({ id: otherId }),
    })
    expect(malformed.status).toBe(400)
  })

  it('rejects request bodies over 1 MiB with 413', async () => {
    const ctx = await setup()
    const spec = makeSpec()
    const response = await call(ctx, `/v1/instances/${spec.id}`, {
      method: 'PUT',
      headers: ctx.headers,
      body: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1),
    })
    expect(response.status).toBe(413)
  })

  it('cancels chunked bodies that stream past 1 MiB', async () => {
    // Raise Bun's transport cap so the handler's streaming byte count is the
    // mechanism under test (production keeps the transport cap at the limit).
    const ctx = await setup({ maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES * 4 })
    const spec = makeSpec()
    const chunk = new Uint8Array(64 * 1024).fill(120)
    const total = Math.ceil((MAX_REQUEST_BODY_BYTES + 1) / chunk.byteLength) + 8
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close()
          return
        }
        sent += 1
        controller.enqueue(chunk)
      },
    })
    const response = await fetch(`${ctx.base}/v1/instances/${spec.id}`, {
      method: 'PUT',
      headers: ctx.headers,
      body,
      duplex: 'half',
    })
    expect(response.status).toBe(413)
    expect(agentErrorSchema.parse(await response.json()).code).toBe(
      'invalid_request'
    )
    // The request was cancelled mid-stream, not read to completion.
    expect(sent).toBeLessThan(total)
  })

  it('distinguishes instance absence from unknown routes', async () => {
    const ctx = await setup()
    const unknown = await call(ctx, '/v1/nope', { headers: ctx.headers })
    expect(unknown.status).toBe(404)
    // A route-level 404 must NEVER look like a fenced instance absence.
    expect(
      agentErrorSchema.parse(await unknown.json()).instanceId
    ).toBeUndefined()

    const unknownId = nextId()
    const missing = await call(ctx, `/v1/instances/${unknownId}`, {
      headers: ctx.headers,
    })
    expect(missing.status).toBe(404)
    expect(agentErrorSchema.parse(await missing.json()).instanceId).toBe(
      unknownId
    )

    const patchMissing = await call(ctx, `/v1/instances/${unknownId}`, {
      method: 'PATCH',
      headers: ctx.headers,
      body: JSON.stringify({ expiresAtMs: 1_000_000 }),
    })
    expect(patchMissing.status).toBe(404)
    const patchBody = agentErrorSchema.parse(await patchMissing.json())
    expect(patchBody.code).toBe('not_found')
    expect(patchBody.instanceId).toBe(unknownId)

    const deleted = await call(ctx, `/v1/instances/${unknownId}`, {
      method: 'DELETE',
      headers: ctx.headers,
    })
    expect(deleted.status).toBe(404)
    const deleteBody = agentErrorSchema.parse(await deleted.json())
    expect(deleteBody.code).toBe('not_found')
    expect(deleteBody.instanceId).toBe(unknownId)

    const resurrect = await call(ctx, `/v1/instances/${unknownId}`, {
      method: 'PUT',
      headers: ctx.headers,
      body: JSON.stringify(makeSpec({ id: unknownId })),
    })
    expect(resurrect.status).toBe(409)
    expect(agentErrorSchema.parse(await resurrect.json()).code).toBe('conflict')
  })
})
