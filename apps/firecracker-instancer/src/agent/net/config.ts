import * as z from 'zod/mini'
import {
  ENTRYPOINT_REGEX,
  IFACE_NAME_REGEX,
  USER_GROUP_REGEX,
  isValidDomain,
  isValidIpv4Cidr,
} from './validate'

const subnetPoolSchema = z
  .string()
  .check(
    z.refine(isValidIpv4Cidr, {
      message: 'subnetPool must be an aligned IPv4 CIDR with host bits clear',
    })
  )
  .check(
    z.refine(
      value => {
        const prefix = Number(value.slice(value.indexOf('/') + 1))
        return prefix >= 8 && prefix <= 30
      },
      { message: 'subnetPool must be between /8 and /30' }
    )
  )

const portSchema = z.int().check(z.gte(1), z.lte(65535))

/**
 * Owner: track 3 (network). Extend freely; keep the export names.
 *
 * Every value is validated before it can reach an `ip` argument, an nftables
 * rule or a Traefik rule. The schema rejects invalid config at startup instead
 * of failing on the first instance.
 *
 * (`prefault` alone, without `z.optional`, so the output type is non-nullable
 * and every consumer can rely on the documented default.)
 */
export const networkConfigSchema = z.object({
  /** Address/hostname returned in tcp/raw endpoints. */
  publicHost: z.string().check(z.minLength(1)),
  /** Base domain for http/https/tcp-ssl hostnames: <hostPrefix>-<shortId>.<httpDomain>. */
  httpDomain: z.string().check(
    z.refine(isValidDomain, {
      message: 'httpDomain must be a lowercase DNS name without a trailing dot',
    })
  ),
  httpPort: z.prefault(portSchema, 80),
  httpsPort: z.prefault(portSchema, 443),
  /** Public port reported for tcp-ssl endpoints (the Traefik entrypoint listener). */
  tcpSslPort: z.prefault(portSchema, 443),
  /** Public TCP ports for DNAT. */
  tcpPortRange: z.prefault(z.object({ from: z.int(), to: z.int() }), {
    from: 20000,
    to: 29999,
  }),
  /** /30 point-to-point networks are carved out of this pool. */
  subnetPool: z.prefault(subnetPoolSchema, '10.200.0.0/16'),
  traefikDynamicDir: z.prefault(
    z.string(),
    '/etc/traefik/dynamic/rctf-firecracker'
  ),
  /**
   * Per-instance route sidecars (instanceId -> expose list). The frozen
   * `NetLease` has no guest ports, so this is what lets `restore()` re-assert
   * DNAT and Traefik files after an agent restart. No secrets.
   */
  routesDir: z.prefault(z.string(), '/var/lib/rctf-firecracker/net-routes'),
  /** NIC that faces the internet; used for DNAT and masquerade. */
  externalInterface: z
    .prefault(z.string(), 'eth0')
    .check(z.regex(IFACE_NAME_REGEX, 'Invalid externalInterface')),
  /** Traefik entrypoint for plain HTTP routers. */
  httpEntrypoint: z
    .prefault(z.string(), 'web')
    .check(z.regex(ENTRYPOINT_REGEX, 'Invalid httpEntrypoint')),
  /** Traefik entrypoint for HTTPS routers (TLS terminated by Traefik). */
  httpsEntrypoint: z
    .prefault(z.string(), 'websecure')
    .check(z.regex(ENTRYPOINT_REGEX, 'Invalid httpsEntrypoint')),
  /** Traefik TCP entrypoint for tcp-ssl routers (HostSNI + TLS). */
  tcpSslEntrypoint: z
    .prefault(z.string(), 'websecure')
    .check(z.regex(ENTRYPOINT_REGEX, 'Invalid tcpSslEntrypoint')),
  /** Traefik certificate resolver name; when unset only the default cert is used. */
  certResolver: z.optional(z.string().check(z.minLength(1))),
  /**
   * User/group the tap device is handed to. With the jailer this must match
   * the jailer uid/gid so the (unprivileged) Firecracker process can open it.
   */
  tapUser: z.optional(
    z.string().check(z.regex(USER_GROUP_REGEX, 'Invalid tapUser'))
  ),
  tapGroup: z.optional(
    z.string().check(z.regex(USER_GROUP_REGEX, 'Invalid tapGroup'))
  ),
})
export type NetworkConfig = z.output<typeof networkConfigSchema>
