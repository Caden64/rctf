import {
  ERROR_HTTP_STATUS,
  HOST_ID_REGEX,
  ProtocolError,
  controllerErrorSchema,
  controllerInstanceDetailsSchema,
  createInstanceRequestSchema,
  extendInstanceRequestSchema,
  hostSummarySchema,
  instanceKeySchema,
  type ErrorCode,
} from '@rctf/firecracker-protocol'
import type { ControllerService } from '../interfaces'
import type { Logger } from '../log'
import { assertTokenConfigured, isAuthorized } from './auth'

/** Default request body cap for the controller HTTP API (256 KiB). */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024

export interface ControllerServerOptions {
  service: ControllerService
  /** Bearer token for the rCTF API (`/v1/instances`). */
  authToken: string
  /** Bearer token for ops (`/v1/hosts`); must differ from `authToken`. */
  adminToken: string
  logger: Logger
  maxBodyBytes?: number
}

export interface ControllerListenOptions {
  host: string
  port: number
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })

const errorBody = (message: string, code?: ErrorCode) =>
  controllerErrorSchema.parse({
    kind: 'instancerError',
    message,
    ...(code === undefined ? {} : { code }),
  })

const errorResponse = (
  status: number,
  message: string,
  code?: ErrorCode
): Response => jsonResponse(status, errorBody(message, code))

const unauthorized = (): Response =>
  errorResponse(401, 'Unauthorized', 'unauthorized')

const methodNotAllowed = (allow: string): Response => {
  const response = errorResponse(405, 'Method not allowed', 'invalid_request')
  response.headers.set('Allow', allow)
  return response
}

const normalizePath = (pathname: string): string => {
  if (pathname.length <= 1) {
    return pathname
  }
  return pathname.replace(/\/+$/, '') || '/'
}

const isJsonContentType = (contentType: string | null): boolean => {
  if (contentType === null) {
    return false
  }
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; response: Response }

/**
 * Build the controller HTTP API around a `ControllerService`.
 *
 * The returned `handler` is a plain fetch-style function, so it can be tested
 * without opening a socket. `serve` wires it into `Bun.serve` for production.
 */
export const createControllerServer = (options: ControllerServerOptions) => {
  const { service, authToken, adminToken, logger } = options

  assertTokenConfigured('authToken', authToken)
  assertTokenConfigured('adminToken', adminToken)
  if (authToken === adminToken) {
    throw new Error(
      'Firecracker controller: authToken and adminToken must be different'
    )
  }

  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error(
      'Firecracker controller: maxBodyBytes must be a positive number'
    )
  }

  const readJsonBody = async (req: Request): Promise<BodyResult> => {
    const contentLength = req.headers.get('content-length')
    if (contentLength !== null) {
      const declared = Number(contentLength)
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        return {
          ok: false,
          response: errorResponse(
            413,
            'Request body too large',
            'invalid_request'
          ),
        }
      }
    }

    if (!isJsonContentType(req.headers.get('content-type'))) {
      return {
        ok: false,
        response: errorResponse(
          415,
          'Content-Type must be application/json',
          'invalid_request'
        ),
      }
    }

    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await req.arrayBuffer())
    } catch {
      return {
        ok: false,
        response: errorResponse(
          400,
          'Could not read request body',
          'invalid_request'
        ),
      }
    }

    if (bytes.byteLength > maxBodyBytes) {
      return {
        ok: false,
        response: errorResponse(
          413,
          'Request body too large',
          'invalid_request'
        ),
      }
    }

    try {
      return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) }
    } catch {
      // NOTE: never echo the body (it may contain flags).
      return {
        ok: false,
        response: errorResponse(400, 'Invalid JSON body', 'invalid_request'),
      }
    }
  }

  const handle = async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url)
      const path = normalizePath(url.pathname)

      // Unauthenticated liveness probe: no configuration details.
      if (path === '/healthz') {
        if (req.method !== 'GET') {
          return methodNotAllowed('GET')
        }
        return jsonResponse(200, { ok: true })
      }

      if (path === '/v1/instances') {
        if (!isAuthorized(req, authToken)) {
          return unauthorized()
        }

        switch (req.method) {
          case 'PUT': {
            const body = await readJsonBody(req)
            if (!body.ok) {
              return body.response
            }
            const parsed = createInstanceRequestSchema.safeParse(body.value)
            if (!parsed.success) {
              return errorResponse(
                400,
                'Invalid request body',
                'invalid_request'
              )
            }
            const details = await service.create(parsed.data)
            return jsonResponse(
              200,
              controllerInstanceDetailsSchema.parse(details)
            )
          }
          case 'POST': {
            const body = await readJsonBody(req)
            if (!body.ok) {
              return body.response
            }
            const parsed = instanceKeySchema.safeParse(body.value)
            if (!parsed.success) {
              return errorResponse(
                400,
                'Invalid request body',
                'invalid_request'
              )
            }
            const details = await service.get(parsed.data)
            return jsonResponse(
              200,
              controllerInstanceDetailsSchema.parse(details)
            )
          }
          case 'DELETE': {
            const body = await readJsonBody(req)
            if (!body.ok) {
              return body.response
            }
            const parsed = instanceKeySchema.safeParse(body.value)
            if (!parsed.success) {
              return errorResponse(
                400,
                'Invalid request body',
                'invalid_request'
              )
            }
            const details = await service.delete(parsed.data)
            return jsonResponse(
              200,
              controllerInstanceDetailsSchema.parse(details)
            )
          }
          case 'PATCH': {
            const body = await readJsonBody(req)
            if (!body.ok) {
              return body.response
            }
            const parsed = extendInstanceRequestSchema.safeParse(body.value)
            if (!parsed.success) {
              return errorResponse(
                400,
                'Invalid request body',
                'invalid_request'
              )
            }
            const details = await service.extend(parsed.data)
            return jsonResponse(
              200,
              controllerInstanceDetailsSchema.parse(details)
            )
          }
          default:
            return methodNotAllowed('PUT, POST, DELETE, PATCH')
        }
      }

      if (path === '/v1/hosts') {
        if (!isAuthorized(req, adminToken)) {
          return unauthorized()
        }
        if (req.method !== 'GET') {
          return methodNotAllowed('GET')
        }
        const hosts = await service.listHosts()
        return jsonResponse(200, {
          hosts: hosts.map(host => hostSummarySchema.parse(host)),
        })
      }

      const hostRoute = /^\/v1\/hosts\/([^/]+)(?:\/(drain|undrain))?$/.exec(
        path
      )
      if (hostRoute !== null) {
        if (!isAuthorized(req, adminToken)) {
          return unauthorized()
        }

        let hostId: string
        try {
          hostId = decodeURIComponent(hostRoute[1]!)
        } catch {
          return errorResponse(400, 'Invalid host id', 'invalid_request')
        }
        if (!HOST_ID_REGEX.test(hostId)) {
          return errorResponse(400, 'Invalid host id', 'invalid_request')
        }

        const action = hostRoute[2]
        if (action === undefined) {
          if (req.method !== 'DELETE') {
            return methodNotAllowed('DELETE')
          }
          await service.removeHost(hostId)
          return new Response(null, { status: 204 })
        }

        if (req.method !== 'POST') {
          return methodNotAllowed('POST')
        }
        const summary =
          action === 'drain'
            ? await service.drainHost(hostId)
            : await service.undrainHost(hostId)
        return jsonResponse(200, hostSummarySchema.parse(summary))
      }

      return errorResponse(404, 'Not found', 'not_found')
    } catch (err) {
      if (err instanceof ProtocolError && err.code !== 'internal') {
        return errorResponse(
          ERROR_HTTP_STATUS[err.code] ?? 500,
          err.message,
          err.code
        )
      }

      // Details (including stack) go to the logger only. Never log the request
      // body: it may contain flags.
      logger.error(
        {
          err: {
            name: err instanceof Error ? err.name : 'UnknownError',
            message: err instanceof Error ? err.message : String(err),
          },
        },
        'unhandled error while serving a controller request'
      )
      return errorResponse(500, 'Internal server error', 'internal')
    }
  }

  const inflight = new Set<Promise<Response>>()
  const handler = (req: Request): Promise<Response> => {
    const pending = handle(req)
    inflight.add(pending)
    const done = () => inflight.delete(pending)
    pending.then(done, done)
    return pending
  }

  /** Resolve once active requests finish, or after `timeoutMs`. */
  const drain = async (timeoutMs: number): Promise<void> => {
    if (inflight.size === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(inflight),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
    clearTimeout(timer)
  }

  const serve = (listen: ControllerListenOptions) =>
    Bun.serve({
      hostname: listen.host,
      port: listen.port,
      // Enforced by Bun while streaming, so chunked bodies cannot be buffered
      // past the cap before our own check runs.
      maxRequestBodySize: maxBodyBytes,
      // Create waits on the host agent (up to ~30s); Bun's default is 10s.
      idleTimeout: 60,
      fetch: handler,
    })

  return { handler, fetch: handler, serve, drain }
}
