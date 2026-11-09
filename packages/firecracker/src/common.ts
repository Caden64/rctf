import * as z from 'zod/mini'

/**
 * Shared validation primitives for the Firecracker instancer.
 *
 * Every string that ends up in a path, a command line, an nftables rule, a
 * hostname or a Traefik rule MUST be validated by one of these regexes first.
 * They are intentionally strict allow-lists.
 */

/** Controller-generated, random, lowercase base36. Used in paths and hostnames. */
export const INSTANCE_ID_REGEX = /^[a-z0-9]{16,32}$/
/** Host identifier from the controller config. */
export const HOST_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/
/** Image directory name under the agent's `imagesDir`. No slashes, no leading dot. */
export const IMAGE_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,62}$/
/** One DNS label (used for `hostPrefix`). */
export const DNS_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/
export const ENV_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** Printable ASCII without control chars; used for kernel args. */
export const KERNEL_ARGS_REGEX = /^[\x20-\x7e]{0,512}$/

/** The only machine name challenges can reference in `expose[].containerName`. */
export const FIRECRACKER_MACHINE_NAME = 'app'

export const exposeKindSchema = z.enum([
  'tcp',
  'tcp-ssl',
  'http',
  'https',
  'raw',
])
export type ExposeKindValue = z.output<typeof exposeKindSchema>

export const instanceIdSchema = z
  .string()
  .check(z.regex(INSTANCE_ID_REGEX, 'Invalid instance id'))
export const hostIdSchema = z
  .string()
  .check(z.regex(HOST_ID_REGEX, 'Invalid host id'))
export const portSchema = z.int().check(z.gte(1), z.lte(65535))

/** Lifecycle as seen by rCTF. Mirrors `InstanceStatus` in `@rctf/types`. */
export const instanceStatusSchema = z.enum([
  'stopped',
  'running',
  'starting',
  'stopping',
  'errored',
])
export type InstanceStatusValue = z.output<typeof instanceStatusSchema>

export const flagSchema = z.object({
  provider: z.string(),
  flag: z.string(),
})
export type FlagValue = z.output<typeof flagSchema>

/**
 * Stable error codes shared by controller and agent HTTP APIs.
 * HTTP status mapping lives in `ERROR_HTTP_STATUS`.
 */
export const errorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'not_found',
  'conflict', // same id / key with different parameters, or illegal state transition
  'spec_mismatch', // agent: instance id exists with a different spec
  'no_capacity',
  'draining',
  'host_unavailable',
  'expired', // extend after expiry
  'in_progress', // a conflicting operation (e.g. teardown) is still running
  'internal',
])
export type ErrorCode = z.output<typeof errorCodeSchema>

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  spec_mismatch: 409,
  no_capacity: 507,
  draining: 503,
  host_unavailable: 503,
  expired: 410,
  in_progress: 409,
  internal: 500,
}

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}
