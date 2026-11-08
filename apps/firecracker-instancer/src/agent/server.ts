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
import type { AgentConfig } from './config'

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024

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

const errorResponse = (code: ErrorCode, message: string, status?: number) => {
  const body: AgentErrorBody = { kind: 'agentError', code, message }
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
  const buffer = await request.arrayBuffer()
  if (buffer.byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new HttpProblem(413, 'invalid_request', 'request body too large')
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
  stop: () => Promise<void>
}

export const createAgentServer = (deps: {
  config: AgentConfig
  manager: InstanceManager
  logger?: Logger
}): AgentServer => {
  const { config, manager } = deps
  const logger = deps.logger ?? createLogger('firecracker-agent-http', 'silent')
  const token = config.token
  if (!token) {
    throw new Error(
      'agent token is required (config.token or FIRECRACKER_AGENT_TOKEN)'
    )
  }

  const fetch = async (request: Request): Promise<Response> => {
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
        return jsonResponse(await manager.info())
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

        switch (request.method) {
          case 'GET': {
            const instance = await manager.get(id)
            if (!instance) {
              return errorResponse('not_found', 'instance not found')
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
              return errorResponse('invalid_request', 'invalid extend request')
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
      }

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
    }
  }

  const listen = config.listen ?? { host: '127.0.0.1', port: 7001 }
  const server = Bun.serve({
    hostname: listen.host,
    port: listen.port,
    fetch,
    error(err) {
      logger.error(
        { errorType: err instanceof Error ? err.name : typeof err },
        'bun server error'
      )
      return errorResponse('internal', 'internal error')
    },
  })

  return {
    server,
    stop: async () => {
      server.stop(true)
    },
  }
}
