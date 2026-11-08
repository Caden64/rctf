/**
 * Lease validation and derivation shared by the manager and the nftables
 * renderer.
 *
 * `NetLease` is the single source of truth for routing: it carries the full
 * expose list (kind, host prefix, guest port) plus the allocated public
 * ports/hostnames, so both DNAT and Traefik routes can be rebuilt after a
 * restart without a sidecar store. Everything below therefore DERIVES routes
 * from the lease and rejects a lease whose expose list and public mappings do
 * not line up instead of silently dropping a route.
 */
import {
  DNS_LABEL_REGEX,
  type ExposeKindValue,
} from '@rctf/firecracker-protocol'
import type { NetExposeRequest, NetLease } from '../../interfaces'
import {
  assertHostname,
  assertInstanceId,
  assertIpv4,
  assertPort,
  assertTapName,
  isValidMacAddress,
  isValidPort,
} from './validate'

export const EXPOSE_KINDS: ReadonlySet<string> = new Set<ExposeKindValue>([
  'tcp',
  'tcp-ssl',
  'http',
  'https',
  'raw',
])

/**
 * Longest accepted hostPrefix. The hostname label is
 * `<hostPrefix>-<20 chars of instanceId>` (<= 32 + 1 + 20 = 53 bytes), which
 * stays inside the 63 byte DNS label limit.
 */
export const MAX_HOST_PREFIX_LENGTH = 32

export const isTcpKind = (kind: ExposeKindValue): boolean =>
  kind === 'tcp' || kind === 'raw'

export const isHostnameKind = (kind: ExposeKindValue): boolean =>
  kind === 'http' || kind === 'https' || kind === 'tcp-ssl'

/** Validate and copy an expose list. Rejects, never repairs. */
export const validateExpose = (
  input: readonly NetExposeRequest[]
): NetExposeRequest[] => {
  if (!Array.isArray(input)) {
    throw new Error('expose must be an array')
  }
  return input.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`expose[${index}] is not an object`)
    }
    if (!EXPOSE_KINDS.has(entry.kind)) {
      throw new Error(`expose[${index}] has an invalid kind: ${entry.kind}`)
    }
    if (!DNS_LABEL_REGEX.test(entry.hostPrefix)) {
      throw new Error(
        `expose[${index}] has an invalid hostPrefix: ${JSON.stringify(entry.hostPrefix)}`
      )
    }
    if (entry.hostPrefix.length > MAX_HOST_PREFIX_LENGTH) {
      throw new Error(
        `expose[${index}] hostPrefix is longer than ${MAX_HOST_PREFIX_LENGTH} characters: ${JSON.stringify(entry.hostPrefix)}`
      )
    }
    assertPort(entry.port)
    return { kind: entry.kind, hostPrefix: entry.hostPrefix, port: entry.port }
  })
}

/** Deep copy so callers can never mutate manager state through a returned lease. */
export const cloneLease = (lease: NetLease): NetLease => ({
  ...lease,
  expose: Array.isArray(lease.expose)
    ? lease.expose.map(entry => ({ ...entry }))
    : [],
  publicPorts: { ...lease.publicPorts },
  publicHostnames: { ...lease.publicHostnames },
})

export interface TcpRoute {
  index: number
  publicPort: number
  guestPort: number
}

export interface HostnameRoute {
  index: number
  kind: ExposeKindValue
  hostname: string
  guestPort: number
}

export interface LeaseRoutes {
  /** tcp/raw exposes, ordered by expose index. */
  tcp: TcpRoute[]
  /** http/https/tcp-ssl exposes, ordered by expose index. */
  hostnames: HostnameRoute[]
}

/**
 * Derive every route of a lease from `lease.expose` + its public mappings.
 * Throws when an expose entry has no matching public port/hostname or when a
 * mapping points at an expose entry of the wrong kind, so an incomplete lease
 * is rejected/reported instead of losing its DNAT silently.
 */
export const deriveLeaseRoutes = (lease: NetLease): LeaseRoutes => {
  if (!Array.isArray(lease.expose)) {
    throw new Error(`lease ${lease.instanceId} has no expose list`)
  }
  const expose = validateExpose(lease.expose)
  const tcp: TcpRoute[] = []
  const hostnames: HostnameRoute[] = []
  expose.forEach((entry, index) => {
    if (isTcpKind(entry.kind)) {
      const publicPort = lease.publicPorts[index]
      if (publicPort === undefined) {
        throw new Error(
          `lease ${lease.instanceId} has no public port for expose[${index}] (${entry.kind})`
        )
      }
      if (!isValidPort(publicPort)) {
        throw new Error(
          `lease ${lease.instanceId} has an invalid public port: ${publicPort}`
        )
      }
      tcp.push({ index, publicPort, guestPort: entry.port })
      return
    }
    const hostname = lease.publicHostnames[index]
    if (hostname === undefined) {
      throw new Error(
        `lease ${lease.instanceId} has no hostname for expose[${index}] (${entry.kind})`
      )
    }
    assertHostname(hostname)
    hostnames.push({ index, kind: entry.kind, hostname, guestPort: entry.port })
  })

  for (const [key, value] of Object.entries(lease.publicPorts)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= expose.length) {
      throw new Error(
        `lease ${lease.instanceId} has a public port for unknown expose index ${key}`
      )
    }
    if (!isTcpKind((expose[index] as NetExposeRequest).kind)) {
      throw new Error(
        `lease ${lease.instanceId} has a public port for non-tcp expose[${index}]`
      )
    }
    if (!isValidPort(value)) {
      throw new Error(
        `lease ${lease.instanceId} has an invalid public port: ${value}`
      )
    }
  }
  for (const [key, value] of Object.entries(lease.publicHostnames)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= expose.length) {
      throw new Error(
        `lease ${lease.instanceId} has a hostname for unknown expose index ${key}`
      )
    }
    if (!isHostnameKind((expose[index] as NetExposeRequest).kind)) {
      throw new Error(
        `lease ${lease.instanceId} has a hostname for non-hostname expose[${index}]`
      )
    }
    assertHostname(value)
  }
  return { tcp, hostnames }
}

/** Structural validation of one lease (ids, addresses, /30, MAC, expose). */
export const assertLeaseShape = (lease: NetLease): void => {
  assertInstanceId(lease.instanceId)
  assertTapName(lease.tapName)
  assertIpv4(lease.hostIp)
  assertIpv4(lease.guestIp)
  if (lease.prefixLength !== 30) {
    throw new Error(`lease ${lease.instanceId} must use a /30`)
  }
  if (!isValidMacAddress(lease.guestMac)) {
    throw new Error(`invalid guest MAC in lease ${lease.instanceId}`)
  }
  if (typeof lease.egress !== 'boolean') {
    throw new Error(`invalid egress flag in lease ${lease.instanceId}`)
  }
  deriveLeaseRoutes(lease)
}
