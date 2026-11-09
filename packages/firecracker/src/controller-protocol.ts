import * as z from 'zod/mini'
import {
  DNS_LABEL_REGEX,
  errorCodeSchema,
  exposeKindSchema,
  flagSchema,
  instanceStatusSchema,
  portSchema,
} from './common'

/**
 * rCTF API  ->  Firecracker controller.
 *
 * Transport: HTTPS/HTTP JSON, `Authorization: Bearer <authToken>`
 * (compared in constant time). Endpoints:
 *
 *   PUT    /v1/instances   create (idempotent per teamId+challengeIntegrationId)
 *   POST   /v1/instances   get
 *   DELETE /v1/instances   delete (idempotent)
 *   PATCH  /v1/instances   extend
 *
 * Ops (Bearer `adminToken`): see `HOST_ROUTES`.
 * Successful responses are `controllerInstanceDetailsSchema`; failures are
 * `controllerErrorSchema` with an HTTP status from `ERROR_HTTP_STATUS`.
 */

export const instanceKeySchema = z.object({
  teamId: z.string().check(z.minLength(1), z.maxLength(128)),
  challengeIntegrationId: z.string().check(z.minLength(1), z.maxLength(128)),
})
export type InstanceKey = z.output<typeof instanceKeySchema>

export const exposeEntrySchema = z.object({
  kind: exposeKindSchema,
  hostPrefix: z.string().check(z.regex(DNS_LABEL_REGEX)),
  containerName: z.string(),
  containerPort: portSchema,
  shouldDisplay: z.optional(z.boolean()),
  title: z.optional(z.string()),
})
export type ExposeEntry = z.output<typeof exposeEntrySchema>

export const createInstanceRequestSchema = z.object({
  ...instanceKeySchema.shape,
  /** Raw challenge config; the controller validates it with `firecrackerChallengeConfigSchema`. */
  config: z.record(z.string(), z.unknown()),
  expose: z.array(exposeEntrySchema),
  flags: z.array(flagSchema),
  timeoutMilliseconds: z.int().check(z.gte(1000), z.lte(7 * 24 * 3600 * 1000)),
})
export type CreateInstanceRequest = z.output<typeof createInstanceRequestSchema>

export const extendInstanceRequestSchema = z.object({
  ...instanceKeySchema.shape,
  timeoutMilliseconds: z.int().check(z.gte(1000), z.lte(7 * 24 * 3600 * 1000)),
})
export type ExtendInstanceRequest = z.output<typeof extendInstanceRequestSchema>

export const controllerEndpointSchema = z.object({
  kind: exposeKindSchema,
  host: z.string(),
  port: portSchema,
  title: z.optional(z.string()),
})
export type ControllerEndpoint = z.output<typeof controllerEndpointSchema>

/** Same shape as `instanceDetailsSchema` in apps/api providers/instancer/base.ts. */
export const controllerInstanceDetailsSchema = z.object({
  kind: z.literal('instancerInstanceDetails'),
  status: instanceStatusSchema,
  timeLeftMilliseconds: z.nullable(z.int()),
  endpoints: z.nullable(z.array(controllerEndpointSchema)),
})
export type ControllerInstanceDetails = z.output<
  typeof controllerInstanceDetailsSchema
>

export const controllerErrorSchema = z.object({
  kind: z.literal('instancerError'),
  message: z.string(),
  code: z.optional(errorCodeSchema),
})
export type ControllerError = z.output<typeof controllerErrorSchema>

// ---- ops API -------------------------------------------------------------

export const HOST_ROUTES = {
  list: 'GET /v1/hosts',
  drain: 'POST /v1/hosts/:hostId/drain',
  undrain: 'POST /v1/hosts/:hostId/undrain',
  remove: 'DELETE /v1/hosts/:hostId', // force-forget a lost host and release its reservations
  health: 'GET /healthz',
} as const

export const hostHealthSchema = z.enum([
  'healthy',
  'unhealthy', // missed heartbeats; no new placements
  'draining', // operator requested; no new placements, existing keep running
])

export const hostSummarySchema = z.object({
  id: z.string(),
  url: z.string(),
  health: hostHealthSchema,
  lastSeenMs: z.nullable(z.number()),
  capacity: z.object({
    vcpus: z.number(),
    memMiB: z.number(),
    diskMiB: z.number(),
    maxInstances: z.number(),
  }),
  reserved: z.object({
    vcpus: z.number(),
    memMiB: z.number(),
    diskMiB: z.number(),
    instances: z.number(),
  }),
})
export type HostSummary = z.output<typeof hostSummarySchema>
