import * as z from 'zod/mini'
import { loadTlsIdentity, type LoadedTlsIdentity } from '../util/tls'
import { networkConfigSchema } from './net/config'
import { vmConfigSchema } from './vm/config'

/**
 * Native TLS listener settings. `caFile` turns the listener into mTLS: client
 * certificates are requested and must verify against that CA.
 */
export const agentTlsConfigSchema = z.object({
  certFile: z.string(),
  keyFile: z.string(),
  caFile: z.optional(z.string()),
})
export type AgentTlsConfig = z.output<typeof agentTlsConfigSchema>

/** Owner: track 4 (agent). Composes the per-track sub-configs. */
export const agentConfigSchema = z.object({
  hostId: z.string(),
  listen: z.optional(
    z.prefault(z.object({ host: z.string(), port: z.int() }), {
      host: '127.0.0.1',
      port: 7001,
    })
  ),
  /** Bearer token; env FIRECRACKER_AGENT_TOKEN overrides. */
  token: z.optional(z.string()),
  /**
   * Serve HTTPS natively. Without this the agent serves plain HTTP (bind it to
   * a private address and firewall it to the controller).
   */
  tls: z.optional(agentTlsConfigSchema),
  /** Durable agent state: instance records (no flags). */
  stateDir: z.optional(
    z.prefault(z.string(), '/var/lib/rctf-firecracker/state')
  ),
  capacity: z.object({
    vcpus: z.int(),
    memMiB: z.int(),
    diskMiB: z.int(),
    maxInstances: z.int(),
  }),
  /** How long past expiresAtMs the agent waits for the controller before self-destructing the VM. */
  expiryGraceSeconds: z.optional(z.prefault(z.int(), 120)),
  /**
   * A resource-acquiring call (allocate/launch/publish) that has not settled
   * for this long is never abandoned (that could orphan a guest) but is loudly
   * reported and takes the host out of rotation (`checks.stalledOperations`)
   * until it settles or the agent is restarted.
   */
  pendingOperationAbandonSeconds: z.optional(z.prefault(z.int(), 900)),
  /** Local drain flag: stop accepting new instances (existing ones keep running). */
  draining: z.optional(z.prefault(z.boolean(), false)),
  /** Keep an errored tombstone for this long, then forget it. */
  erroredTtlSeconds: z.optional(z.prefault(z.int(), 600)),
  /** Fence deleted ids for this long so delayed duplicate PUTs cannot resurrect them. */
  tombstoneTtlSeconds: z.optional(z.prefault(z.int(), 86400)),
  /** Drain in-flight work for at most this long during shutdown, then force. */
  shutdownTimeoutSeconds: z.optional(z.prefault(z.int(), 15)),
  vm: z.optional(z.prefault(vmConfigSchema, {})),
  network: networkConfigSchema,
})
export type AgentConfig = z.output<typeof agentConfigSchema> & {
  /**
   * Loaded and validated from `tls` at startup. Never logged: it contains the
   * private key bytes.
   */
  tlsMaterial?: LoadedTlsIdentity
}

/**
 * Load and validate the configured TLS material. Exported so `loadAgentConfig`
 * can fail before any privileged preflight runs, and so tests can exercise the
 * same path the listener uses.
 */
export const resolveAgentTls = (
  config: AgentConfig,
  opts?: { now?: number; expirySkewMs?: number }
): LoadedTlsIdentity | undefined =>
  config.tls === undefined
    ? undefined
    : loadTlsIdentity(config.tls, { label: 'agent tls', ...opts })

/**
 * In jailer mode Firecracker runs as `vm.jailUid:vm.jailGid` and must be able to
 * open the tap the agent creates, so the tap owner has to be that same
 * identity. Unset owners default to the jailer identity; an explicit NUMERIC
 * owner that differs is a configuration error (it would be a tap the dropped
 * uid cannot attach to). Names are accepted as-is: they cannot be resolved here.
 */
export const alignTapOwner = (config: AgentConfig): AgentConfig => {
  const vm = config.vm
  if (vm === undefined || vm.mode !== 'jailer') return config
  const check = (
    label: string,
    configured: string | undefined,
    expected: number
  ): string => {
    if (configured === undefined) return String(expected)
    if (/^\d+$/.test(configured) && Number(configured) !== expected) {
      throw new Error(
        `network.${label}=${configured} does not match the jailer identity (${expected}); the unprivileged Firecracker process could not open its tap`
      )
    }
    return configured
  }
  return {
    ...config,
    network: {
      ...config.network,
      tapUser: check('tapUser', config.network.tapUser, vm.jailUid),
      tapGroup: check('tapGroup', config.network.tapGroup, vm.jailGid),
    },
  }
}
