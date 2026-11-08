import { describe, expect, test } from 'bun:test'
import type { NetLease } from '../../src/interfaces'
import { renderRuleset } from '../../src/agent/net/nftables'
import { publicHostname } from '../../src/agent/routing/traefik'
import { bunCommandRunner } from '../../src/util/exec'
import { instanceId, makeConfig, makeLease, makeTempConfig } from './support'

const config = await makeTempConfig({
  subnetPool: '10.200.0.0/16',
  externalInterface: 'wan0',
  certResolver: 'le',
})

const hostname = (id: string, prefix: string) =>
  publicHostname(config, id, prefix)

const leases: NetLease[] = [
  makeLease({
    instanceId: instanceId(1),
    tapName: 'fctap0',
    hostIp: '10.200.0.1',
    guestIp: '10.200.0.2',
    guestMac: '02:00:00:00:00:01',
    publicPorts: { 0: 20000 },
    egress: true,
  }),
  makeLease({
    instanceId: instanceId(2),
    tapName: 'fctap1',
    hostIp: '10.200.0.5',
    guestIp: '10.200.0.6',
    guestMac: '02:00:00:00:00:02',
    publicPorts: { 1: 20001, 2: 20002 },
    publicHostnames: { 0: hostname(instanceId(2), 'web') },
    egress: false,
  }),
]

const guestPorts: Record<string, Record<number, number>> = {
  [instanceId(1)]: { 0: 8080 },
  [instanceId(2)]: { 1: 1337, 2: 9000 },
}

const section = (text: string, chain: string): string => {
  const start = text.indexOf(`chain ${chain} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = text.indexOf('\n  }', start)
  return text.slice(start, end)
}

describe('renderRuleset invariants', () => {
  test('(a) drops forwarded traffic between any two guest taps', () => {
    const text = renderRuleset(leases, config, guestPorts)
    const forward = section(text, 'forward')
    expect(forward).toContain('iifname "fctap*" oifname "fctap*" drop')
    // and the forward policy is drop, so anything unhandled is denied
    expect(forward).toContain('policy drop;')
  })

  test('(b) anti-spoof per lease: source IP and ethernet source must match', () => {
    const text = renderRuleset(leases, config, guestPorts)
    for (const lease of leases) {
      expect(text).toContain(
        `iifname "${lease.tapName}" ether saddr != "${lease.guestMac}" drop`
      )
      expect(text).toContain(
        `iifname "${lease.tapName}" ip saddr != ${lease.guestIp} drop`
      )
    }
  })

  test('(c) guest -> host input is dropped, except established replies', () => {
    const text = renderRuleset(leases, config, guestPorts)
    const input = section(text, 'input')
    expect(input).toContain(
      'type filter hook input priority filter; policy accept;'
    )
    for (const lease of leases) {
      expect(input).toContain(
        `iifname "${lease.tapName}" ip saddr != ${lease.guestIp} drop`
      )
      expect(input).toContain(
        `iifname "${lease.tapName}" ether saddr != "${lease.guestMac}" drop`
      )
    }
    // Replies to host-initiated flows (Traefik, readiness) are the only accept.
    expect(input).toContain(
      'iifname "fctap*" ct state established,related accept'
    )
    const establishedAt = input.indexOf('established,related accept')
    const dropAt = input.indexOf('iifname "fctap*" drop')
    expect(establishedAt).toBeGreaterThanOrEqual(0)
    expect(dropAt).toBeGreaterThan(establishedAt)
    expect(input.split('\n').filter(line => line.includes('accept'))).toEqual([
      '    type filter hook input priority filter; policy accept;',
      '    iifname "fctap*" ct state established,related accept',
    ])
  })

  test('(d) egress: denied by default, masqueraded and filtered when enabled', () => {
    const text = renderRuleset(leases, config, guestPorts)
    const forward = section(text, 'forward')
    // non-egress lease cannot open flows at all (replies of DNAT stay allowed)
    expect(forward).toContain(
      `iifname "${leases[1]?.tapName}" ct state new drop`
    )
    // egress lease: no RFC1918/link-local/loopback/metadata, only the internet
    for (const cidr of [
      '10.0.0.0/8',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '172.16.0.0/12',
      '192.168.0.0/16',
    ]) {
      expect(forward).toContain(cidr)
    }
    expect(forward).toContain('ip daddr 10.200.0.0/16 drop')
    expect(forward).toContain(
      `iifname "fctap0" oifname "wan0" ip saddr 10.200.0.2 accept`
    )
    const postrouting = section(text, 'postrouting')
    expect(postrouting).toContain(
      'iifname "fctap0" oifname "wan0" ip saddr 10.200.0.2 masquerade'
    )
    // never masquerade a lease that has no egress
    expect(postrouting).not.toContain('fctap1')
  })

  test('(e) tcp/raw DNAT + matching forward accept only for that lease', () => {
    const text = renderRuleset(leases, config, guestPorts)
    const prerouting = section(text, 'prerouting')
    expect(prerouting).toContain(
      'iifname "wan0" tcp dport 20000 dnat ip to 10.200.0.2:8080'
    )
    expect(prerouting).toContain(
      'iifname "wan0" tcp dport 20001 dnat ip to 10.200.0.6:1337'
    )
    expect(prerouting).toContain(
      'iifname "wan0" tcp dport 20002 dnat ip to 10.200.0.6:9000'
    )
    const forward = section(text, 'forward')
    expect(forward).toContain(
      'iifname "wan0" oifname "fctap0" ip daddr 10.200.0.2 tcp dport 8080 ct status dnat accept'
    )
    expect(forward).toContain(
      'iifname "wan0" oifname "fctap1" ip daddr 10.200.0.6 tcp dport 1337 ct status dnat accept'
    )
    // a public port of lease 1 must not be forwarded to any other guest
    expect(prerouting).not.toMatch(/20000 dnat ip to 10\.200\.0\.6/)
  })

  test('(f) established/related return traffic is allowed', () => {
    expect(renderRuleset(leases, config, guestPorts)).toContain(
      'ct state established,related accept'
    )
  })

  test('DNAT is skipped when the guest port is not known (restore without sidecar)', () => {
    const text = renderRuleset(leases, config, {})
    expect(section(text, 'prerouting')).not.toContain('dnat')
    // anti-spoof/isolation is still asserted from the lease alone
    expect(text).toContain('iifname "fctap0" ip saddr != 10.200.0.2 drop')
  })
})

describe('renderRuleset purity and validation', () => {
  test('same leases in any order produce byte-identical rules', () => {
    const a = renderRuleset(leases, config, guestPorts)
    const b = renderRuleset([...leases].reverse(), config, guestPorts)
    const c = renderRuleset(
      [leases[1] as NetLease, leases[0] as NetLease],
      config,
      guestPorts
    )
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  test('object key insertion order does not affect the output', () => {
    const reordered = {
      ...leases[1],
      publicPorts: { 2: 20002, 1: 20001 },
    } as NetLease
    const a = renderRuleset([reordered], config, guestPorts)
    const b = renderRuleset([leases[1] as NetLease], config, guestPorts)
    expect(a).toBe(b)
  })

  test('a malicious-looking but valid-shaped lease renders literally, safely', () => {
    const lease = makeLease({
      instanceId: 'z9'.repeat(8),
      tapName: 'fctap99999',
      hostIp: '10.200.251.249',
      guestIp: '10.200.251.250',
      guestMac: '02:ff:ff:ff:ff:fe',
      publicPorts: { 0: 65535 },
      egress: true,
    })
    const text = renderRuleset([lease], config, {
      [lease.instanceId]: { 0: 65535 },
    })
    expect(text).toContain('tcp dport 65535 dnat ip to 10.200.251.250:65535')
    expect(text).not.toContain('rm -rf')
  })

  const rejects = (lease: NetLease) => () => renderRuleset([lease], config)

  test('rejects injection attempts in every interpolated value', () => {
    expect(rejects(makeLease({ tapName: 'fctap0; rm -rf /' }))).toThrow(
      'invalid tap name'
    )
    expect(rejects(makeLease({ guestIp: '10.200.0.2; drop' }))).toThrow(
      'invalid IPv4'
    )
    expect(
      rejects(makeLease({ hostIp: '10.200.0.1 } inet rctf_fc {' }))
    ).toThrow('invalid IPv4')
    expect(rejects(makeLease({ guestMac: '02:00:00:00:00:0"' }))).toThrow(
      'invalid guest MAC'
    )
    expect(rejects(makeLease({ instanceId: 'x`;flush' }))).toThrow(
      'invalid instance id'
    )
    expect(rejects(makeLease({ publicPorts: { 0: 70000 } }))).toThrow(
      'invalid public port'
    )
    expect(
      rejects(makeLease({ publicHostnames: { 0: 'evil`host.example.com' } }))
    ).toThrow('invalid public hostname')
    expect(rejects(makeLease({ prefixLength: 24 }))).toThrow('must use a /30')
  })

  test('rejects duplicate public ports across leases', () => {
    const one = makeLease({
      instanceId: instanceId(11),
      publicPorts: { 0: 24000 },
    })
    const two = makeLease({
      instanceId: instanceId(12),
      tapName: 'fctap1',
      hostIp: '10.200.0.5',
      guestIp: '10.200.0.6',
      guestMac: '02:00:00:00:00:0b',
      publicPorts: { 0: 24000 },
    })
    expect(() => renderRuleset([one, two], config)).toThrow('mapped twice')
  })

  test('rejects an external interface that could break out of the rule', () => {
    const bad = { ...config, externalInterface: 'wan0" drop; table inet x {' }
    expect(() => renderRuleset([], bad)).toThrow('invalid network interface')
    const tapWildcard = { ...config, externalInterface: 'fctap0' }
    expect(() => renderRuleset([], tapWildcard)).toThrow(
      'invalid network interface'
    )
  })

  test('empty lease set still renders a locked-down base table', () => {
    const text = renderRuleset([], makeConfig())
    expect(text).toContain('table inet rctf_fc {')
    expect(text).toContain('iifname "fctap*" oifname "fctap*" drop')
    expect(text).toContain('policy drop;')
    expect(text).not.toContain('dnat')
  })
})

test.skipIf(!process.env.FC_REAL)(
  'rendered ruleset passes nft --check on a real kernel',
  async () => {
    const text = renderRuleset(leases, config, guestPorts)
    const result = await bunCommandRunner.run(['nft', '-c', '-f', '-'], {
      stdin: text,
    })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
  }
)
