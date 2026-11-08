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
  vm: z.optional(z.prefault(vmConfigSchema, {})),
  network: networkConfigSchema,
})
export type AgentConfig = z.output<typeof agentConfigSchema>
