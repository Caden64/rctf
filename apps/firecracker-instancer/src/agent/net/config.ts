import * as z from 'zod/mini'

/** Owner: track 3 (network). Extend freely; keep the export names. */
export const networkConfigSchema = z.object({
  /** Address/hostname returned in tcp/raw endpoints. */
  publicHost: z.string(),
  /** Base domain for http/https/tcp-ssl hostnames: <hostPrefix>-<shortId>.<httpDomain>. */
  httpDomain: z.string(),
  httpPort: z.optional(z.prefault(z.int(), 80)),
  httpsPort: z.optional(z.prefault(z.int(), 443)),
  /** Public TCP ports for DNAT. */
  tcpPortRange: z.optional(
    z.prefault(z.object({ from: z.int(), to: z.int() }), {
      from: 20000,
      to: 29999,
    })
  ),
  /** /30 point-to-point networks are carved out of this pool. */
  subnetPool: z.optional(z.prefault(z.string(), '10.200.0.0/16')),
  traefikDynamicDir: z.optional(
    z.prefault(z.string(), '/etc/traefik/dynamic/rctf-firecracker')
  ),
})
export type NetworkConfig = z.output<typeof networkConfigSchema>
