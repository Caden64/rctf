import * as z from 'zod/mini'
import {
  DNS_LABEL_REGEX,
  ENV_NAME_REGEX,
  IMAGE_NAME_REGEX,
  KERNEL_ARGS_REGEX,
  errorCodeSchema,
  exposeKindSchema,
  flagSchema,
  instanceIdSchema,
  portSchema,
} from './common'
import { readinessSchema } from './challenge-config'

/**
 * Firecracker controller  ->  host agent.
 *
 * Transport: HTTP(S) JSON, `Authorization: Bearer <host token>` (per host,
 * constant-time compare). The agent is privileged (root/KVM/netfilter): it must
 * only be reachable from the controller (private network / firewall / TLS).
 *
 *   GET    /v1/info                  host capabilities + usage + health
 *   GET    /v1/instances             every instance the agent knows about
 *   PUT    /v1/instances/:id         create, idempotent per id (same spec => same result)
 *   GET    /v1/instances/:id
 *   PATCH  /v1/instances/:id         push a new expiry (monotonic: max(current, new))
 *   DELETE /v1/instances/:id         idempotent teardown (404 when unknown)
 *
 * FENCING: DELETE of an id the agent does not know (or already finished) records a
 * durable tombstone {id, atMs} (kept >= `tombstoneTtlSeconds`, default 24h, persisted
 * in the agent state dir). A later PUT for a tombstoned id fails with `conflict`
 * ("instance id was deleted"), so a create request that was delayed on the wire
 * after the controller gave up on it can never produce a VM.
 *
 * ABSENCE DISCRIMINATOR: agents that advertise
 * `AGENT_CAPABILITY_INSTANCE_ABSENCE` stamp every `not_found` emitted by an
 * instance-scoped route with the requested `instanceId`. A DELETE 404 carrying
 * the matching id therefore proves the agent ran the instance DELETE route and
 * wrote its tombstone. A plain/route-level 404 (an unmatched route, a proxy, or
 * a mid-deploy agent) never carries the id and is AMBIGUOUS: the controller
 * keeps the row fenced and retries. The same discriminator gates GET/PATCH
 * absence, so a routing 404 cannot declare a live instance lost. Agents that do
 * not advertise the capability keep the pre-negotiation semantics (any 404 is
 * absence); the controller probes `GET /v1/info` before trusting a marker-less
 * 404 and treats a failed probe as ambiguous, so a modern agent is never
 * mistaken for a legacy one.
 *
 * Time: `expiresAtMs` values are on the AGENT clock. The controller reads
 * `AgentInfo.timeMs` at every heartbeat, estimates the skew (agent - controller,
 * RTT-compensated) and translates deadlines it sends. A host whose |skew| exceeds
 * the controller's `maxClockSkewSeconds` takes no new placements.
 *
 * Errors: `agentErrorSchema` with codes from `errorCodeSchema`.
 * `no_capacity` (507) means the agent's own limits rejected the spec.
 */

export const agentExposeSchema = z.object({
  kind: exposeKindSchema,
  hostPrefix: z.string().check(z.regex(DNS_LABEL_REGEX)),
  /** Guest TCP port. */
  port: portSchema,
  title: z.optional(z.string()),
})
export type AgentExpose = z.output<typeof agentExposeSchema>

/**
 * The whole creation request. Contains SECRETS (`flags`): never log it in full
 * (use `redactSpec`), never persist `flags` to disk on the agent or controller.
 */
export const agentInstanceSpecSchema = z.object({
  id: instanceIdSchema,
  /** Opaque stable per-team key (HMAC of teamId); for logs/correlation only. */
  teamKey: z.string().check(z.regex(/^[a-z0-9]{8,64}$/)),
  image: z.string().check(z.regex(IMAGE_NAME_REGEX)),
  vcpus: z.int().check(z.gte(1), z.lte(8)),
  memMiB: z.int().check(z.gte(128), z.lte(16384)),
  diskMiB: z.int().check(z.gte(64), z.lte(65536)),
  kernelArgs: z.optional(z.string().check(z.regex(KERNEL_ARGS_REGEX))),
  egress: z.boolean(),
  bootTimeoutSeconds: z.int().check(z.gte(5), z.lte(600)),
  readiness: readinessSchema,
  env: z.record(z.string().check(z.regex(ENV_NAME_REGEX)), z.string()),
  expose: z.array(agentExposeSchema).check(z.minLength(1), z.maxLength(16)),
  /** Absolute wall-clock deadline (epoch ms). The agent destroys the VM at expiresAtMs + graceMs. */
  expiresAtMs: z.number(),
  /** SECRET. Delivered to the guest only via MMDS. */
  flags: z.array(flagSchema),
})
export type AgentInstanceSpec = z.output<typeof agentInstanceSpecSchema>

export type RedactedSpec = Omit<AgentInstanceSpec, 'flags'> & {
  flags: { provider: string; flag: '<redacted>' }[]
}
export const redactSpec = (spec: AgentInstanceSpec): RedactedSpec => ({
  ...spec,
  flags: spec.flags.map(f => ({ provider: f.provider, flag: '<redacted>' })),
})

export const agentInstanceStateSchema = z.enum([
  'creating', // resources being allocated / VM spawning
  'starting', // VM booted, waiting for readiness
  'running', // readiness passed
  'stopping', // teardown in progress
  'stopped', // torn down (terminal, only returned from DELETE)
  'errored', // failed boot / VM died; resources are being or have been released
])
export type AgentInstanceState = z.output<typeof agentInstanceStateSchema>

export const agentEndpointSchema = z.object({
  kind: exposeKindSchema,
  host: z.string(),
  port: portSchema,
})
export type AgentEndpoint = z.output<typeof agentEndpointSchema>

export const agentInstanceSchema = z.object({
  id: instanceIdSchema,
  state: agentInstanceStateSchema,
  message: z.optional(z.string()),
  createdAtMs: z.number(),
  expiresAtMs: z.number(),
  /** Same order as `spec.expose`. Empty until networking is allocated. */
  endpoints: z.array(agentEndpointSchema),
  /** Hash of the spec minus `expiresAtMs`/`flags`' values; for idempotency checks. */
  specHash: z.string(),
})
export type AgentInstance = z.output<typeof agentInstanceSchema>

const resourcesSchema = z.object({
  vcpus: z.number(),
  memMiB: z.number(),
  diskMiB: z.number(),
  instances: z.number(),
})

/**
 * Capability advertised by agents that echo the instance id on instance-scoped
 * absence errors (see ABSENCE DISCRIMINATOR above). Optional on the wire so an
 * older agent's `/v1/info` still validates.
 */
export const AGENT_CAPABILITY_INSTANCE_ABSENCE = 'instance-absence-v1'
export const AGENT_CAPABILITIES: readonly string[] = [
  AGENT_CAPABILITY_INSTANCE_ABSENCE,
]

export const agentInfoSchema = z.object({
  version: z.string(),
  hostId: z.string(),
  timeMs: z.number(),
  capacity: z.object({
    vcpus: z.number(),
    memMiB: z.number(),
    diskMiB: z.number(),
    maxInstances: z.number(),
  }),
  usage: resourcesSchema,
  /** false when draining locally or a preflight check fails */
  accepting: z.boolean(),
  checks: z.record(z.string(), z.boolean()),
  images: z.array(z.string()),
  /** Protocol capabilities; absent on agents that predate negotiation. */
  capabilities: z.optional(z.array(z.string())),
})
export type AgentInfo = z.output<typeof agentInfoSchema>

export const agentExtendRequestSchema = z.object({
  expiresAtMs: z.number(),
})

export const agentErrorSchema = z.object({
  kind: z.literal('agentError'),
  code: errorCodeSchema,
  message: z.string(),
  /**
   * Echo of the validated path id, set ONLY by instance-scoped routes. Absent
   * for unmatched-route/proxy errors and for agents without
   * `AGENT_CAPABILITY_INSTANCE_ABSENCE`.
   */
  instanceId: z.optional(instanceIdSchema),
})
export type AgentErrorBody = z.output<typeof agentErrorSchema>
