import type { CommandRunner, NetLease } from '../../interfaces'
import type { NetworkConfig } from './config'
import { parseSubnetPool } from './ipam'
import {
  assertIfaceName,
  assertInstanceId,
  assertIpv4,
  assertTapName,
  isValidHostname,
  isValidMacAddress,
  isValidPort,
  parseIpv4,
} from './validate'

export const NFT_TABLE = 'rctf_fc'

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

/** Guest port for `lease.publicPorts[index]` (needed for DNAT). */
export type GuestPorts = Readonly<
  Record<string, Readonly<Record<number, number>> | undefined>
>

interface ValidatedLease {
  lease: NetLease
  /** tcp/raw public ports with their guest port, ordered by expose index. */
  routes: { index: number; publicPort: number; guestPort?: number }[]
}

const validateLease = (
  lease: NetLease,
  guestPorts: GuestPorts,
  seen: {
    ids: Set<string>
    taps: Set<string>
    guests: Set<string>
    ports: Set<number>
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

  const guestPortMap = guestPorts[lease.instanceId]
  const routes: ValidatedLease['routes'] = []
  for (const [key, publicPort] of Object.entries(lease.publicPorts)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(
        `lease ${lease.instanceId} has an invalid expose index: ${key}`
      )
    }
    if (!isValidPort(publicPort)) {
      throw new Error(
        `lease ${lease.instanceId} has an invalid public port: ${publicPort}`
      )
    }
    if (seen.ports.has(publicPort)) {
      throw new Error(`public port ${publicPort} is mapped twice`)
    }
    seen.ports.add(publicPort)
    let guestPort: number | undefined
    if (guestPortMap !== undefined) {
      const candidate = guestPortMap[index]
      if (candidate !== undefined) {
        if (!isValidPort(candidate)) {
          throw new Error(
            `lease ${lease.instanceId} has an invalid guest port: ${candidate}`
          )
        }
        guestPort = candidate
      }
    }
    routes.push({ index, publicPort, guestPort })
  }
  routes.sort((a, b) => a.index - b.index)

  for (const [key, hostname] of Object.entries(lease.publicHostnames)) {
    if (!Number.isInteger(Number(key)) || Number(key) < 0) {
      throw new Error(
        `lease ${lease.instanceId} has an invalid hostname index: ${key}`
      )
    }
    if (!isValidHostname(hostname)) {
      throw new Error(
        `lease ${lease.instanceId} has an invalid public hostname: ${JSON.stringify(hostname)}`
      )
    }
  }

  return { lease, routes }
}

const validateLeases = (
  leases: readonly NetLease[],
  guestPorts: GuestPorts
): ValidatedLease[] => {
  const seen = {
    ids: new Set<string>(),
    taps: new Set<string>(),
    guests: new Set<string>(),
    ports: new Set<number>(),
  }
  return leases
    .map(lease => validateLease(lease, guestPorts, seen))
    .sort((a, b) => a.lease.instanceId.localeCompare(b.lease.instanceId))
}

/**
 * Render the complete `inet rctf_fc` table as a PURE function of the current
 * leases plus config. The output replaces the whole table in one `nft -f -`
 * transaction (`add table` + `flush table` + re-declare), so a failure leaves
 * the previous table untouched.
 *
 * Only validated ints, IPv4 addresses, MACs, interface names and regex-checked
 * ids are interpolated; there is no shell and no escaping-by-guessing.
 */
export const renderRuleset = (
  leases: readonly NetLease[],
  config: NetworkConfig,
  guestPorts: GuestPorts = {}
): string => {
  const external = assertIfaceName(config.externalInterface)
  const pool = parseSubnetPool(config.subnetPool)
  const validated = validateLeases(leases, guestPorts)

  const lines: string[] = [
    '# rctf-firecracker: managed nftables table. Generated file, manual edits are lost.',
    `add table inet ${NFT_TABLE}`,
    `flush table inet ${NFT_TABLE}`,
    `table inet ${NFT_TABLE} {`,
    '  chain input {',
    '    type filter hook input priority filter; policy accept;',
    '    # (c) A guest may not reach the host stack (MMDS is inside Firecracker).',
    '    #     Replies to host-initiated connections (readiness probe, Traefik) are',
    '    #     the only justified exception; they are established/related.',
  ]

  for (const { lease } of validated) {
    lines.push(
      `    iifname "${lease.tapName}" ether saddr != "${lease.guestMac}" drop`
    )
    lines.push(
      `    iifname "${lease.tapName}" ip saddr != ${lease.guestIp} drop`
    )
  }
  lines.push(
    '    iifname "fctap*" ct state established,related accept',
    '    iifname "fctap*" drop',
    '  }',
    '',
    '  chain forward {',
    '    type filter hook forward priority filter; policy drop;',
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

  lines.push(
    '    # (d) Egress is denied by default: leases without egress cannot start flows.',
    '    #     (Inbound DNAT is not iifname <tap>, and its replies are established.)'
  )
  for (const { lease } of validated) {
    if (!lease.egress) {
      lines.push(`    iifname "${lease.tapName}" ct state new drop`)
    }
  }
  lines.push(
    '    ct state invalid drop',
    '    # (f) return traffic for flows that were explicitly accepted below.',
    '    ct state established,related accept'
  )

  const dnat = validated.flatMap(({ lease, routes }) =>
    routes
      .filter(route => route.guestPort !== undefined)
      .map(route => ({
        lease,
        index: route.index,
        publicPort: route.publicPort,
        guestPort: route.guestPort as number,
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

  lines.push(
    '  }',
    '',
    '  chain prerouting {',
    '    type nat hook prerouting priority dstnat; policy accept;'
  )
  for (const route of dnat) {
    lines.push(
      `    iifname "${external}" tcp dport ${route.publicPort} dnat ip to ${route.lease.guestIp}:${route.guestPort}`
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
