import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
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
  /** Per-host deadline for one heartbeat probe (seconds). Probes run concurrently. */
  hostProbeTimeoutSeconds: z.optional(z.prefault(z.number(), 10)),
  reaperIntervalSeconds: z.optional(z.prefault(z.int(), 5)),
  /** How often DB-vs-agent reconciliation runs. */
  reconcileIntervalSeconds: z.optional(z.prefault(z.int(), 30)),
  /** Agent-side records unknown to the DB are deleted after this grace (in-flight creates). */
  orphanGraceSeconds: z.optional(z.prefault(z.int(), 30)),
  /**
   * How long an ambiguous create is left in `creating` before the reconciler
   * fences it (row -> deleting + agent DELETE/tombstone) when the agent has no
   * record of the instance.
   */
  createFenceSeconds: z.optional(z.prefault(z.int(), 45)),
  /**
   * Hosts whose measured clock skew (agent - controller) exceeds this take no
   * new placements. Deadlines sent to agents are translated by the skew.
   */
  maxClockSkewSeconds: z.optional(z.prefault(z.int(), 10)),
  /**
   * Optional hard cap on an instance's total lifetime (seconds from creation).
   * Extends are clamped to `createdAt + maxLifetimeSeconds`.
   */
  maxLifetimeSeconds: z.optional(z.int()),
})
export type ControllerConfig = z.output<typeof controllerConfigSchema>

const formatIssues = (error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
}): string =>
  error.issues
    .map(issue =>
      issue.path.length > 0
        ? `${issue.path.join('.')}: ${issue.message}`
        : issue.message
    )
    .join('; ')

const hostTokenEnvKey = (hostId: string): string =>
  `FIRECRACKER_HOST_TOKEN_${hostId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

const intEnv = (
  env: Record<string, string | undefined>,
  key: string
): number | undefined => {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer, got ${raw}`)
  }
  return value
}

/**
 * Load controller config from a YAML/JSON file path (or an already-parsed
 * object) and apply environment overrides:
 *
 * - `FIRECRACKER_CONTROLLER_AUTH_TOKEN`   -> authToken
 * - `FIRECRACKER_CONTROLLER_ADMIN_TOKEN`  -> adminToken
 * - `FIRECRACKER_TEAM_KEY_SECRET`         -> teamKeySecret
 * - `FIRECRACKER_HOST_TOKEN_<HOST_ID>`    -> hosts[].token (uppercase, non
 *   alphanumerics become `_`)
 */
export const loadControllerConfig = (
  source: string | Record<string, unknown>,
  env: Record<string, string | undefined> = process.env
): ControllerConfig => {
  let raw: unknown
  if (typeof source === 'string') {
    let text: string
    try {
      text = readFileSync(source, 'utf8')
    } catch (error) {
      throw new Error(
        `cannot read controller config ${source}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    try {
      raw = parseYaml(text)
    } catch (error) {
      throw new Error(
        `cannot parse controller config ${source}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  } else {
    raw = source
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('controller config must be a mapping/object')
  }

  const input = { ...(raw as Record<string, unknown>) }
  if (env.FIRECRACKER_CONTROLLER_AUTH_TOKEN !== undefined) {
    input.authToken = env.FIRECRACKER_CONTROLLER_AUTH_TOKEN
  }
  if (env.FIRECRACKER_CONTROLLER_ADMIN_TOKEN !== undefined) {
    input.adminToken = env.FIRECRACKER_CONTROLLER_ADMIN_TOKEN
  }
  if (env.FIRECRACKER_TEAM_KEY_SECRET !== undefined) {
    input.teamKeySecret = env.FIRECRACKER_TEAM_KEY_SECRET
  }
  const createFence = intEnv(env, 'FIRECRACKER_CREATE_FENCE_SECONDS')
  if (createFence !== undefined) input.createFenceSeconds = createFence
  const maxSkew = intEnv(env, 'FIRECRACKER_MAX_CLOCK_SKEW_SECONDS')
  if (maxSkew !== undefined) input.maxClockSkewSeconds = maxSkew
  if (Array.isArray(input.hosts)) {
    input.hosts = input.hosts.map(entry => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return entry
      }
      const host = { ...(entry as Record<string, unknown>) }
      if (typeof host.id === 'string') {
        const override = env[hostTokenEnvKey(host.id)]
        if (override !== undefined) host.token = override
      }
      return host
    })
  }

  const parsed = controllerConfigSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`invalid controller config: ${formatIssues(parsed.error)}`)
  }
  return parsed.data
}
