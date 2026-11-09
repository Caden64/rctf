/**
 * Host agent HTTP API (Bun.serve). See `packages/firecracker/src/agent-protocol.ts`
 * for the wire contract.
 *
 *   GET    /v1/info
 *   GET    /v1/instances
 *   PUT    /v1/instances/:id
 *   GET    /v1/instances/:id
 *   PATCH  /v1/instances/:id
 *   DELETE /v1/instances/:id
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  AGENT_CAPABILITIES,
  ERROR_HTTP_STATUS,
  INSTANCE_ID_REGEX,
  ProtocolError,
  agentExtendRequestSchema,
  agentInstanceSpecSchema,
  type AgentErrorBody,
  type ErrorCode,
} from '@rctf/firecracker-protocol'
import type { InstanceManager } from '../interfaces'
import { createLogger, type Logger } from '../log'
import { resolveAgentTls, type AgentConfig } from './config'

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024
/** A create may legitimately take ~30s; do not cut the connection earlier. */
export const SERVER_IDLE_TIMEOUT_SECONDS = 60

/** Constant-time comparison of two opaque tokens (hash first: equal lengths). */
export const constantTimeEqual = (a: string, b: string): boolean => {
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}

/** Validate an `Authorization: Bearer <token>` header in constant time. */
export const tokensMatch = (
  authorization: string | undefined | null,
  expected: string
): boolean => {
  if (!authorization || !expected) return false
  const prefix = 'Bearer '
  if (!authorization.startsWith(prefix)) return false
  return constantTimeEqual(authorization.slice(prefix.length), expected)
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'HttpProblem'
  }
}

const errorResponse = (
  code: ErrorCode,
  message: string,
  status?: number,
  instanceId?: string
) => {
  const body: AgentErrorBody = {
    kind: 'agentError',
    code,
    message,
    ...(instanceId === undefined ? {} : { instanceId }),
  }
  return new Response(JSON.stringify(body), {
    status: status ?? ERROR_HTTP_STATUS[code],
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

const readJson = async (request: Request): Promise<unknown> => {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > MAX_REQUEST_BODY_BYTES) {
      throw new HttpProblem(413, 'invalid_request', 'request body too large')
    }
  }

  const body = request.body
  let buffer: Uint8Array
  if (!body) {
    buffer = new Uint8Array(0)
  } else {
    // Count bytes as they stream in: a chunked request has no content-length,
    // and must not be allowed to buffer past the limit before we look at it.
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        throw new HttpProblem(413, 'invalid_request', 'request body too large')
      }
      chunks.push(value)
    }
    buffer = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      buffer.set(chunk, offset)
      offset += chunk.byteLength
    }
  }

  const text = new TextDecoder().decode(buffer)
  try {
    return JSON.parse(text)
  } catch {
    throw new ProtocolError('invalid_request', 'invalid JSON body')
  }
}

export interface AgentServer {
  server: ReturnType<typeof Bun.serve>
  /** Stop accepting, then drain in-flight requests under a deadline. */
  stop: (timeoutMs?: number) => Promise<void>
}

export const createAgentServer = (deps: {
  config: AgentConfig
  manager: InstanceManager
  logger?: Logger
  /** Test seam: raise Bun's transport cap to exercise the streaming check. */
  maxRequestBodyBytes?: number
}): AgentServer => {
  const { config, manager } = deps
  const logger = deps.logger ?? createLogger('firecracker-agent-http', 'silent')
  const token = config.token
  if (!token) {
    throw new Error(
      'agent token is required (config.token or FIRECRACKER_AGENT_TOKEN)'
    )
  }

  let closing = false
  let stopped = false
  const inflight = new Set<Promise<void>>()
  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void
    const promise = new Promise<void>(r => {
      resolve = r
    })
    return { promise, resolve }
  }

  const fetch = async (request: Request): Promise<Response> => {
    if (closing) {
      return errorResponse('draining', 'agent is shutting down', 503)
    }
    return handleRequest(request)
  }

  const handleRequest = async (request: Request): Promise<Response> => {
    const done = deferred()
    inflight.add(done.promise)
    try {
      if (!tokensMatch(request.headers.get('authorization'), token)) {
        return errorResponse('unauthorized', 'invalid or missing bearer token')
      }

      const url = new URL(request.url)
      const pathname = url.pathname.replace(/\/+$/, '') || '/'

      if (pathname === '/v1/info') {
        if (request.method !== 'GET') {
          return errorResponse('invalid_request', 'method not allowed', 405)
        }
        return jsonResponse({
          ...(await manager.info()),
          capabilities: [...AGENT_CAPABILITIES],
        })
      }

      if (pathname === '/v1/instances') {
        if (request.method !== 'GET') {
          return errorResponse('invalid_request', 'method not allowed', 405)
        }
        return jsonResponse(await manager.list())
      }

      const prefix = '/v1/instances/'
      if (pathname.startsWith(prefix)) {
        const id = pathname.slice(prefix.length)
        if (id.includes('/') || !INSTANCE_ID_REGEX.test(id)) {
          return errorResponse('invalid_request', 'invalid instance id')
        }

        try {
          switch (request.method) {
            case 'GET': {
              const instance = await manager.get(id)
              if (!instance) {
                // Instance-scoped absence: the id was validated above, so the
                // controller may treat this as a real missing instance. Never
                // emitted by the unmatched-route branch below.
                return errorResponse(
                  'not_found',
                  'instance not found',
                  undefined,
                  id
                )
              }
              return jsonResponse(instance)
            }
            case 'PUT': {
              const body = await readJson(request)
              const parsed = agentInstanceSpecSchema.safeParse(body)
              if (!parsed.success) {
                return errorResponse('invalid_request', 'invalid instance spec')
              }
              if (parsed.data.id !== id) {
                return errorResponse(
                  'invalid_request',
                  'request body id does not match path id'
                )
              }
              return jsonResponse(await manager.create(parsed.data))
            }
            case 'PATCH': {
              const body = await readJson(request)
              const parsed = agentExtendRequestSchema.safeParse(body)
              if (!parsed.success) {
                return errorResponse(
                  'invalid_request',
                  'invalid extend request'
                )
              }
              return jsonResponse(
                await manager.extend(id, parsed.data.expiresAtMs)
              )
            }
            case 'DELETE': {
              return jsonResponse(await manager.delete(id))
            }
            default:
              return errorResponse('invalid_request', 'method not allowed', 405)
          }
        } catch (err) {
          // The manager answers `not_found` (DELETE only after its tombstone is
          // durable) or `expired`; the route is the only layer that knows the
          // requested id, so stamp it here. Anything else keeps propagating.
          if (err instanceof ProtocolError) {
            return errorResponse(err.code, err.message, undefined, id)
          }
          throw err
        }
      }

      // Unmatched route: deliberately carries no instanceId. A proxy or a
      // mid-deploy agent can produce this shape; it must stay AMBIGUOUS.
      return errorResponse('not_found', 'route not found')
    } catch (err) {
      if (err instanceof HttpProblem) {
        return errorResponse(err.code, err.message, err.status)
      }
      if (err instanceof ProtocolError) {
        return errorResponse(err.code, err.message)
      }
      // Never echo internals (they may include sensitive request data).
      logger.error(
        { errorType: err instanceof Error ? err.name : typeof err },
        'unhandled agent request error'
      )
      return errorResponse('internal', 'internal error')
    } finally {
      done.resolve()
      inflight.delete(done.promise)
    }
  }

  const listen = config.listen ?? { host: '127.0.0.1', port: 7001 }
  // Loading/validating here as well as in loadAgentConfig keeps the listener
  // fail-closed for callers that build an AgentConfig directly (tests, tools).
  const tlsMaterial = config.tlsMaterial ?? resolveAgentTls(config)
  const tls =
    tlsMaterial === undefined
      ? undefined
      : {
          cert: tlsMaterial.cert,
          key: tlsMaterial.key,
          // A configured client CA means mTLS: require and verify a client
          // certificate. rejectUnauthorized is explicit so an operator's
          // NODE_TLS_REJECT_UNAUTHORIZED=0 cannot silently disable it.
          ...(tlsMaterial.ca === undefined
            ? {}
            : {
                ca: tlsMaterial.ca,
                requestCert: true,
                rejectUnauthorized: true,
              }),
        }
  const server = Bun.serve({
    hostname: listen.host,
    port: listen.port,
    /** Reject oversized bodies before Bun buffers them. */
    maxRequestBodySize: deps.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES,
    idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
    ...(tls === undefined ? {} : { tls }),
    fetch,
    error(err) {
      logger.error(
        { errorType: err instanceof Error ? err.name : typeof err },
        'bun server error'
      )
      return errorResponse('internal', 'internal error')
    },
  })
  if (tls !== undefined && server.protocol !== 'https') {
    // Never silently fall back to plaintext when TLS was requested.
    void server.stop(true)
    throw new Error(
      `Bun.serve did not enable TLS (protocol ${String(server.protocol)}); refusing to serve the agent API in plaintext`
    )
  }

  return {
    server,
    stop: async (timeoutMs = (config.shutdownTimeoutSeconds ?? 15) * 1000) => {
      if (stopped) return
      // Stop accepting immediately, but do NOT await a server.stop() that may
      // wait forever on active connections before the drain deadline.
      closing = true
      const stopPromise = server.stop(false)
      const deadline = Date.now() + Math.max(0, timeoutMs)
      while (inflight.size > 0) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await new Promise(resolve =>
          setTimeout(resolve, Math.min(10, remaining))
        )
      }
      if (inflight.size > 0) {
        // Deadline hit: force the remaining requests/connections.
        void stopPromise.catch(() => {})
        await Promise.resolve(server.stop(true)).catch(() => {})
      } else {
        await stopPromise.catch(() => {})
      }
      stopped = true
    },
  }
}
