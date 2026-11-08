import type { CommandRunner, NetLease } from '../../interfaces'
import type { NetworkConfig } from './config'
import { deriveLeaseRoutes } from './lease'
import { parseSubnetPool } from './ipam'
import {
  assertIfaceName,
  assertInstanceId,
  assertIpv4,
  assertTapName,
  isValidMacAddress,
  isValidPort,
  parseIpv4,
} from './validate'

export const NFT_TABLE = 'rctf_fc'
/** ARP is not part of the `inet` family, so it gets its own table. */
export const NFT_ARP_TABLE = 'rctf_fc_arp'

/**
 * Destinations a guest with `egress: true` is still never allowed to reach:
 * loopback, RFC1918, CGNAT, link-local, multicast and reserved space. The host's
 * own addresses are additionally covered by the input chain drop (traffic to a
 * local address is delivered locally, not forwarded) and by the explicit pool
 * drop below.
 */
export const EGRESS_DENY_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const

export interface RulesetOptions {
  /**
   * Leases whose public ingress (DNAT + matching forward accept) is installed.
   * Omitted means "every lease is published". Security rules (isolation,
   * anti-spoof, IPv6 drop, egress policy, ARP) are rendered for EVERY lease
   * regardless, so `unpublish` can never strip them from a live tap.
   */
  published?: ReadonlySet<string>
}

interface ValidatedLease {
  lease: NetLease
  /** tcp/raw routes with their guest port, ordered by expose index. */
  routes: { index: number; publicPort: number; guestPort: number }[]
}

const validateLease = (
  lease: NetLease,
  seen: {
    ids: Set<string>
    taps: Set<string>
    guests: Set<string>
    ports: Set<number>
    hostnames: Map<string, string>
  }
): ValidatedLease => {
  assertInstanceId(lease.instanceId)
  if (seen.ids.has(lease.instanceId)) {
    throw new Error(`duplicate lease instanceId: ${lease.instanceId}`)
  }
  seen.ids.add(lease.instanceId)

  assertTapName(lease.tapName)
  if (seen.taps.has(lease.tapName)) {
    throw new Error(`duplicate lease tap: ${lease.tapName}`)
  }
  seen.taps.add(lease.tapName)

  assertIpv4(lease.hostIp)
  assertIpv4(lease.guestIp)
  const hostAddress = parseIpv4(lease.hostIp) as number
  const guestAddress = parseIpv4(lease.guestIp) as number
  if (guestAddress !== hostAddress + 1) {
    throw new Error(
      `lease ${lease.instanceId} guest ${lease.guestIp} is not host ${lease.hostIp} + 1`
    )
  }
  if (lease.prefixLength !== 30) {
    throw new Error(
      `lease ${lease.instanceId} must use a /30 (got /${lease.prefixLength})`
    )
  }
  if (seen.guests.has(lease.guestIp)) {
    throw new Error(`duplicate lease guest address: ${lease.guestIp}`)
  }
  seen.guests.add(lease.guestIp)

  if (!isValidMacAddress(lease.guestMac)) {
    throw new Error(
      `lease ${lease.instanceId} has an invalid guest MAC: ${lease.guestMac}`
    )
  }
  if (typeof lease.egress !== 'boolean') {
    throw new Error(`lease ${lease.instanceId} has an invalid egress flag`)
  }

  // Every route is derived from the lease itself; an incomplete expose list
  // throws instead of silently dropping a public route.
  const derived = deriveLeaseRoutes(lease)
  for (const route of derived.tcp) {
    if (!isValidPort(route.publicPort)) {
      throw new Error(
        `lease ${lease.instanceId} has an invalid public port: ${route.publicPort}`
      )
    }
    if (seen.ports.has(route.publicPort)) {
      throw new Error(`public port ${route.publicPort} is mapped twice`)
    }
    seen.ports.add(route.publicPort)
  }
  for (const route of derived.hostnames) {
    const owner = seen.hostnames.get(route.hostname)
    if (owner !== undefined && owner !== lease.instanceId) {
      throw new Error(
        `public hostname ${route.hostname} is assigned to both ${owner} and ${lease.instanceId}`
      )
    }
    seen.hostnames.set(route.hostname, lease.instanceId)
  }

  return { lease, routes: derived.tcp }
}

const validateLeases = (leases: readonly NetLease[]): ValidatedLease[] => {
  const seen = {
    ids: new Set<string>(),
    taps: new Set<string>(),
    guests: new Set<string>(),
    ports: new Set<number>(),
    hostnames: new Map<string, string>(),
  }
  return leases
    .map(lease => validateLease(lease, seen))
    .sort((a, b) => a.lease.instanceId.localeCompare(b.lease.instanceId))
}

/**
 * Render the complete `inet rctf_fc` + `arp rctf_fc_arp` tables as a PURE
 * function of the current leases plus config. The output is applied as one
 * `nft -f -` transaction (`add table` + `flush table` + re-declare), so a
 * failure leaves the previous tables untouched.
 *
 * The forward chain keeps `policy accept` so this agent never takes over
 * unrelated host forwarding (Docker, VPN, ...); only traffic entering or
 * leaving one of OUR `fctap*` interfaces is explicitly filtered and dropped.
 *
 * Only validated ints, IPv4 addresses, MACs, interface names and regex-checked
 * ids are interpolated; there is no shell and no escaping-by-guessing.
 */
export const renderRuleset = (
  leases: readonly NetLease[],
  config: NetworkConfig,
  options: RulesetOptions = {}
): string => {
  const external = assertIfaceName(config.externalInterface)
  const pool = parseSubnetPool(config.subnetPool)
  const validated = validateLeases(leases)
  const published = options.published
  const isPublished = (lease: NetLease): boolean =>
    published === undefined || published.has(lease.instanceId)

  const lines: string[] = [
    '# rctf-firecracker: managed nftables tables. Generated file, manual edits are lost.',
    `add table inet ${NFT_TABLE}`,
    `flush table inet ${NFT_TABLE}`,
    `table inet ${NFT_TABLE} {`,
    '  chain input {',
    '    type filter hook input priority filter; policy accept;',
    '    # (c) A guest may not reach the host stack (MMDS is inside Firecracker).',
    '    #     Replies to host-initiated connections (readiness probe, Traefik) are',
    '    #     the only justified exception; they are scoped to this lease.',
  ]

  for (const { lease } of validated) {
    lines.push(
      `    iifname "${lease.tapName}" ether saddr != "${lease.guestMac}" drop`
    )
    lines.push(
      `    iifname "${lease.tapName}" ip saddr != ${lease.guestIp} drop`
    )
    lines.push(`    iifname "${lease.tapName}" meta nfproto ipv6 drop`)
  }
  for (const { lease } of validated) {
    lines.push(
      `    iifname "${lease.tapName}" ip saddr ${lease.guestIp} ct state established,related accept`
    )
  }
  lines.push(
    '    iifname "fctap*" drop',
    '  }',
    '',
    '  chain forward {',
    '    # Policy accept: other tables/subsystems own unrelated forwarding.',
    '    type filter hook forward priority filter; policy accept;',
    '    # (a) team isolation: no forwarded traffic between guest taps.',
    '    iifname "fctap*" oifname "fctap*" drop',
    '    # (b) anti-spoof: a tap may only emit its lease address/MAC.'
  )

  for (const { lease } of validated) {
    lines.push(
      `    iifname "${lease.tapName}" ether saddr != "${lease.guestMac}" drop`
    )
    lines.push(
      `    iifname "${lease.tapName}" ip saddr != ${lease.guestIp} drop`
    )
    lines.push(`    iifname "${lease.tapName}" meta nfproto ipv6 drop`)
  }

  lines.push('    # (g) invalid conntrack state, scoped to our taps only.')
  lines.push('    iifname "fctap*" ct state invalid drop')
  lines.push('    oifname "fctap*" ct state invalid drop')

  lines.push(
    '    # (f) return traffic, scoped to the lease interface/address pair so',
    '    #     inherited conntrack state can never be accepted across tenants.'
  )
  for (const { lease } of validated) {
    lines.push(
      `    iifname "${lease.tapName}" ip saddr ${lease.guestIp} ct state established,related accept`
    )
    lines.push(
      `    oifname "${lease.tapName}" ip daddr ${lease.guestIp} ct state established,related accept`
    )
  }

  lines.push(
    '    # (d) Egress is denied by default: leases without egress cannot start flows.',
    '    #     (Inbound DNAT is not iifname <tap>, and its replies are established.)'
  )
  for (const { lease } of validated) {
    if (!lease.egress) {
      lines.push(`    iifname "${lease.tapName}" ct state new drop`)
    }
  }

  const egress = validated.filter(entry => entry.lease.egress)
  if (egress.length > 0) {
    lines.push(
      '    # (d) Egress lease: internet only, never local/link-local/RFC1918/pool.'
    )
    const deny = `{ ${EGRESS_DENY_CIDRS.join(', ')} }`
    for (const { lease } of egress) {
      lines.push(
        `    iifname "${lease.tapName}" oifname "${external}" ip daddr ${deny} drop`
      )
      lines.push(
        `    iifname "${lease.tapName}" oifname "${external}" ip daddr ${pool.cidr} drop`
      )
      lines.push(
        `    iifname "${lease.tapName}" oifname "${external}" ip saddr ${lease.guestIp} accept`
      )
    }
  }

  const dnat = validated
    .filter(entry => isPublished(entry.lease))
    .flatMap(({ lease, routes }) =>
      routes.map(route => ({
        lease,
        publicPort: route.publicPort,
        guestPort: route.guestPort,
      }))
    )
  if (dnat.length > 0) {
    lines.push(
      '    # (e) Public tcp/raw ingress (matching DNAT in chain prerouting).'
    )
    for (const route of dnat) {
      lines.push(
        `    iifname "${external}" oifname "${route.lease.tapName}" ip daddr ${route.lease.guestIp} tcp dport ${route.guestPort} ct status dnat accept`
      )
    }
  }

  lines.push(
    '    # (h) Everything else on a guest tap is denied; non-fctap forwarding is',
    '    #     untouched by this table.',
    '    iifname "fctap*" drop',
    '    oifname "fctap*" drop',
    '  }',
    '',
    '  chain prerouting {',
    '    type nat hook prerouting priority dstnat; policy accept;',
    '    # Only traffic addressed to a LOCAL address (this host) is DNATed, so',
    '    # transit traffic through the host is never rewritten.'
  )
  for (const route of dnat) {
    lines.push(
      `    iifname "${external}" fib daddr type local tcp dport ${route.publicPort} dnat ip to ${route.lease.guestIp}:${route.guestPort}`
    )
  }
  lines.push(
    '  }',
    '',
    '  chain postrouting {',
    '    type nat hook postrouting priority srcnat; policy accept;'
  )
  for (const { lease } of egress) {
    lines.push(
      `    iifname "${lease.tapName}" oifname "${external}" ip saddr ${lease.guestIp} masquerade`
    )
  }
  lines.push('  }', '}', '')

  // -------------------------------------------------------------------------
  // ARP: `inet` rules never see ARP frames, so switch them to their own table.
  // -------------------------------------------------------------------------
  lines.push(
    `add table arp ${NFT_ARP_TABLE}`,
    `flush table arp ${NFT_ARP_TABLE}`,
    `table arp ${NFT_ARP_TABLE} {`,
    '  chain input {',
    '    type filter hook input priority filter; policy accept;',
    '    # (i) ARP anti-spoof + only the host side of the /30 may be resolved.'
  )
  for (const { lease } of validated) {
    lines.push(
      `    iifname "${lease.tapName}" arp saddr ip != ${lease.guestIp} drop`
    )
    lines.push(
      `    iifname "${lease.tapName}" arp saddr ether != "${lease.guestMac}" drop`
    )
    lines.push(
      `    iifname "${lease.tapName}" arp operation request arp daddr ip != ${lease.hostIp} drop`
    )
  }
  lines.push('  }', '}', '')

  return lines.join('\n')
}

/** Apply a rendered ruleset atomically (`nft -f -`, argv only, stdin ruleset). */
export const applyRuleset = async (
  runner: CommandRunner,
  ruleset: string
): Promise<void> => {
  const result = await runner.run(['nft', '-f', '-'], {
    stdin: ruleset,
    timeoutMs: 30_000,
  })
  if (result.code !== 0) {
    throw new Error(
      `nft -f - failed (${result.code}): ${result.stderr.trim() || result.stdout.trim() || 'no output'}`
    )
  }
}
