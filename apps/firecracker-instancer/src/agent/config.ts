import * as z from 'zod/mini'
import { networkConfigSchema } from './net/config'
import { vmConfigSchema } from './vm/config'

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
export type AgentConfig = z.output<typeof agentConfigSchema>

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
