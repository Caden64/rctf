import * as z from 'zod/mini'

/** Owner: track 5 (controller). Extend freely; keep the export names. */
export const hostConfigSchema = z.object({
  id: z.string(),
  url: z.string(),
  /** Bearer token for the agent; env FIRECRACKER_HOST_TOKEN_<ID upper, - => _> overrides. */
  token: z.optional(z.string()),
  /** Optional PEM CA to trust for https agents. */
  caCertificate: z.optional(z.string()),
  capacity: z.object({
    vcpus: z.int(),
    memMiB: z.int(),
    diskMiB: z.int(),
    maxInstances: z.int(),
  }),
})
export type HostConfig = z.output<typeof hostConfigSchema>

export const controllerConfigSchema = z.object({
  listen: z.optional(
    z.prefault(z.object({ host: z.string(), port: z.int() }), {
      host: '127.0.0.1',
      port: 7000,
    })
  ),
  /** Bearer for rCTF API -> controller; env FIRECRACKER_CONTROLLER_AUTH_TOKEN overrides. */
  authToken: z.optional(z.string()),
  /** Bearer for ops endpoints (hosts, drain); env FIRECRACKER_CONTROLLER_ADMIN_TOKEN overrides. */
  adminToken: z.optional(z.string()),
  /** SQLite file: durable instance ownership + reservations (never flags). */
  databasePath: z.optional(
    z.prefault(z.string(), '/var/lib/rctf-firecracker/controller.sqlite')
  ),
  /** Secret mixed into teamKey so team ids don't leak to hosts/hostnames. env FIRECRACKER_TEAM_KEY_SECRET. */
  teamKeySecret: z.optional(z.string()),
  hosts: z.array(hostConfigSchema).check(z.minLength(1)),
  /** Multiply capacity when reserving (1 = no overcommit). */
  overcommit: z.optional(
    z.prefault(z.object({ vcpu: z.number(), mem: z.number() }), {
      vcpu: 1,
      mem: 1,
    })
  ),
  heartbeatIntervalSeconds: z.optional(z.prefault(z.int(), 5)),
  /** Missed heartbeats (seconds) before a host is `unhealthy`. */
  hostTimeoutSeconds: z.optional(z.prefault(z.int(), 20)),
  /** After this, instances on an unhealthy host are written off (key freed, cleanup deferred to host return). */
  hostLostSeconds: z.optional(z.prefault(z.int(), 300)),
  reaperIntervalSeconds: z.optional(z.prefault(z.int(), 5)),
})
export type ControllerConfig = z.output<typeof controllerConfigSchema>
