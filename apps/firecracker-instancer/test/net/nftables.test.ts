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
    expose: [{ kind: 'tcp', hostPrefix: 'svc', port: 8080 }],
    publicPorts: { 0: 20000 },
    egress: true,
  }),
  makeLease({
    instanceId: instanceId(2),
    tapName: 'fctap1',
    hostIp: '10.200.0.5',
    guestIp: '10.200.0.6',
    guestMac: '02:00:00:00:00:02',
    expose: [
      { kind: 'http', hostPrefix: 'web', port: 3000 },
      { kind: 'tcp', hostPrefix: 'svc2', port: 1337 },
      { kind: 'raw', hostPrefix: 'svc3', port: 9000 },
    ],
    publicPorts: { 1: 20001, 2: 20002 },
    publicHostnames: { 0: hostname(instanceId(2), 'web') },
    egress: false,
  }),
]

const section = (text: string, chain: string): string => {
  const start = text.indexOf(`chain ${chain} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = text.indexOf('\n  }', start)
  return text.slice(start, end)
}

describe('renderRuleset invariants', () => {
  test('(a) drops forwarded traffic between any two guest taps, without taking over unrelated forwarding', () => {
    const text = renderRuleset(leases, config)
    const forward = section(text, 'forward')
    expect(forward).toContain('iifname "fctap*" oifname "fctap*" drop')
    // The old code used `policy drop`, which also broke Docker/VPN forwarding.
    expect(forward).toContain('policy accept;')
    expect(forward).not.toContain('policy drop;')
    // Only fctap-scoped traffic is finally dropped.
    expect(forward.trimEnd().endsWith('oifname "fctap*" drop')).toBe(true)
  })

  test('(b) anti-spoof per lease: source IP and ethernet source must match', () => {
    const text = renderRuleset(leases, config)
    for (const lease of leases) {
      expect(text).toContain(
        `iifname "${lease.tapName}" ether saddr != "${lease.guestMac}" drop`
      )
      expect(text).toContain(
        `iifname "${lease.tapName}" ip saddr != ${lease.guestIp} drop`
      )
    }
  })

  test('(c) guest -> host input is dropped, except established replies scoped to the lease', () => {
    const text = renderRuleset(leases, config)
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
      expect(input).toContain(
        `iifname "${lease.tapName}" ip saddr ${lease.guestIp} ct state established,related accept`
      )
    }
    // Never a blanket accept: inherited conntrack state must not cross tenants.
    expect(input).not.toContain(
      'iifname "fctap*" ct state established,related accept'
    )
    const establishedAt = input.indexOf('established,related accept')
    const dropAt = input.indexOf('iifname "fctap*" drop')
    expect(establishedAt).toBeGreaterThanOrEqual(0)
    expect(dropAt).toBeGreaterThan(establishedAt)
  })

  test('(d) egress: denied by default, masqueraded and filtered when enabled', () => {
    const text = renderRuleset(leases, config)
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
      'iifname "fctap0" oifname "wan0" ip saddr 10.200.0.2 accept'
    )
    const postrouting = section(text, 'postrouting')
    expect(postrouting).toContain(
      'iifname "fctap0" oifname "wan0" ip saddr 10.200.0.2 masquerade'
    )
    // never masquerade a lease that has no egress
    expect(postrouting).not.toContain('fctap1')
  })

  test('(e) tcp/raw DNAT is host-local only and paired with a forward accept', () => {
    const text = renderRuleset(leases, config)
    const prerouting = section(text, 'prerouting')
    expect(prerouting).toContain(
      'iifname "wan0" fib daddr type local tcp dport 20000 dnat ip to 10.200.0.2:8080'
    )
    expect(prerouting).toContain(
      'iifname "wan0" fib daddr type local tcp dport 20001 dnat ip to 10.200.0.6:1337'
    )
    expect(prerouting).toContain(
      'iifname "wan0" fib daddr type local tcp dport 20002 dnat ip to 10.200.0.6:9000'
    )
    // transit traffic is never rewritten
    const dnatLines = prerouting
      .split('\n')
      .filter(line => line.includes('dnat ip to'))
    expect(dnatLines.length).toBe(3)
    for (const line of dnatLines) {
      expect(line).toContain('fib daddr type local')
    }
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

  test('(f) established/related return traffic is scoped to the lease interface/address pair', () => {
    const text = renderRuleset(leases, config)
    const forward = section(text, 'forward')
    for (const lease of leases) {
      expect(forward).toContain(
        `iifname "${lease.tapName}" ip saddr ${lease.guestIp} ct state established,related accept`
      )
      expect(forward).toContain(
        `oifname "${lease.tapName}" ip daddr ${lease.guestIp} ct state established,related accept`
      )
    }
    expect(forward).not.toContain('    ct state established,related accept')
  })

  test('(g) unpublishing one lease keeps its security rules and only drops public ingress', () => {
    const published = new Set([instanceId(2)])
    const text = renderRuleset(leases, config, { published })
    // lease 1 is unpublished: no DNAT and no DNAT forward accept...
    const prerouting = section(text, 'prerouting')
    expect(prerouting).not.toContain('20000')
    expect(prerouting).toContain('20001')
    const forward = section(text, 'forward')
    expect(forward).not.toContain('tcp dport 8080')
    // ...but the live tap keeps isolation, anti-spoof, IPv6 and egress rules.
    expect(text).toContain(
      'iifname "fctap0" ether saddr != "02:00:00:00:00:01" drop'
    )
    expect(text).toContain('iifname "fctap0" ip saddr != 10.200.0.2 drop')
    expect(text).toContain('iifname "fctap0" meta nfproto ipv6 drop')
    expect(forward).toContain(
      'iifname "fctap0" oifname "wan0" ip saddr 10.200.0.2 accept'
    )
    expect(section(text, 'postrouting')).toContain(
      'iifname "fctap0" oifname "wan0" ip saddr 10.200.0.2 masquerade'
    )
    // published lease 2 keeps its DNAT
    expect(prerouting).toContain('20001')
  })

  test('(i) ARP anti-spoof table is rendered from the leases', () => {
    const text = renderRuleset(leases, config)
    expect(text).toContain('add table arp rctf_fc_arp')
    expect(text).toContain('flush table arp rctf_fc_arp')
    expect(text).toContain('table arp rctf_fc_arp {')
    for (const lease of leases) {
      expect(text).toContain(
        `iifname "${lease.tapName}" arp saddr ip != ${lease.guestIp} drop`
      )
      expect(text).toContain(
        `iifname "${lease.tapName}" arp saddr ether != "${lease.guestMac}" drop`
      )
      expect(text).toContain(
        `iifname "${lease.tapName}" arp operation request arp daddr ip != ${lease.hostIp} drop`
      )
    }
  })

  test('(j) ARP from unleased fctap* interfaces is dropped with the leased set', () => {
    const text = renderRuleset(leases, config)
    const arp = text.slice(text.indexOf('table arp rctf_fc_arp {'))
    expect(arp).toContain(
      'iifname "fctap*" iifname != { "fctap0", "fctap1" } drop'
    )
    const empty = renderRuleset([], config)
    const emptyArp = empty.slice(empty.indexOf('table arp rctf_fc_arp {'))
    expect(emptyArp).toContain('iifname "fctap*" drop')
    // No per-lease ARP rules with zero leases.
    expect(emptyArp).not.toContain('arp saddr ip !=')
  })

  test('fenced leases keep only blocking rules (no DNAT, no accepts)', () => {
    const fenced = new Set([instanceId(1)])
    const text = renderRuleset(leases, config, { fenced })
    const prerouting = section(text, 'prerouting')
    expect(prerouting).not.toContain('20000')
    expect(prerouting).toContain('20001')
    const forward = section(text, 'forward')
    expect(forward).not.toContain(
      `iifname "fctap0" ip saddr 10.200.0.2 ct state established,related accept`
    )
    expect(forward).not.toContain('tcp dport 8080')
    expect(forward).not.toContain(
      'iifname "fctap0" oifname "wan0" ip saddr 10.200.0.2 accept'
    )
    // Explicit blocking in both directions, including established.
    expect(forward).toContain(
      'ip saddr 10.200.0.2 ct state established,related drop'
    )
    expect(forward).toContain(
      'ip daddr 10.200.0.2 ct state established,related drop'
    )
    expect(forward).toContain('iifname "fctap0" drop')
    expect(forward).toContain('oifname "fctap0" drop')
    expect(forward).toContain('ip saddr 10.200.0.2 drop')
    expect(forward).toContain('ip daddr 10.200.0.2 drop')
    const postrouting = section(text, 'postrouting')
    expect(postrouting).not.toContain('fctap0')
    // The other lease is untouched.
    expect(prerouting).toContain('20001')
    expect(forward).toContain(
      'iifname "fctap1" ip saddr 10.200.0.6 ct state established,related accept'
    )
  })
})

describe('renderRuleset purity and validation', () => {
  test('same leases in any order produce byte-identical rules', () => {
    const a = renderRuleset(leases, config)
    const b = renderRuleset([...leases].reverse(), config)
    const c = renderRuleset(
      [leases[1] as NetLease, leases[0] as NetLease],
      config
    )
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  test('object key insertion order does not affect the output', () => {
    const reordered = {
      ...leases[1],
      publicPorts: { 2: 20002, 1: 20001 },
    } as NetLease
    const a = renderRuleset([reordered], config)
    const b = renderRuleset([leases[1] as NetLease], config)
    expect(a).toBe(b)
  })

  test('a malicious-looking but valid-shaped lease renders literally, safely', () => {
    const lease = makeLease({
      instanceId: 'z9'.repeat(8),
      tapName: 'fctap99999',
      hostIp: '10.200.251.249',
      guestIp: '10.200.251.250',
      guestMac: '02:ff:ff:ff:ff:fe',
      expose: [{ kind: 'tcp', hostPrefix: 'svc', port: 65535 }],
      publicPorts: { 0: 65535 },
      egress: true,
    })
    const text = renderRuleset([lease], config)
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
    expect(
      rejects(
        makeLease({
          tapName: 'fctap1',
          hostIp: '10.200.0.5',
          guestIp: '10.200.0.6',
          expose: [{ kind: 'tcp', hostPrefix: 'svc', port: 80 }],
          publicPorts: { 0: 70000 },
        })
      )
    ).toThrow('invalid public port')
    expect(
      rejects(
        makeLease({
          expose: [{ kind: 'http', hostPrefix: 'web', port: 80 }],
          publicHostnames: { 0: 'evil`host.example.com' },
        })
      )
    ).toThrow('invalid hostname')
    expect(rejects(makeLease({ prefixLength: 24 }))).toThrow('must use a /30')
  })

  test('rejects a lease whose expose list does not match its public mapping', () => {
    // This is the old "missing sidecar" case: silently dropping DNAT is no
    // longer allowed.
    expect(
      rejects(
        makeLease({
          expose: [{ kind: 'tcp', hostPrefix: 'svc', port: 8080 }],
        })
      )
    ).toThrow('has no public port for expose[0]')
    expect(
      rejects(
        makeLease({
          expose: [{ kind: 'http', hostPrefix: 'web', port: 80 }],
        })
      )
    ).toThrow('has no hostname for expose[0]')
  })

  test('rejects duplicate public ports across leases', () => {
    const one = makeLease({
      instanceId: instanceId(11),
      expose: [{ kind: 'tcp', hostPrefix: 'svc', port: 80 }],
      publicPorts: { 0: 24000 },
    })
    const two = makeLease({
      instanceId: instanceId(12),
      tapName: 'fctap1',
      hostIp: '10.200.0.5',
      guestIp: '10.200.0.6',
      guestMac: '02:00:00:00:00:0b',
      expose: [{ kind: 'tcp', hostPrefix: 'svc', port: 80 }],
      publicPorts: { 0: 24000 },
    })
    expect(() => renderRuleset([one, two], config)).toThrow('mapped twice')
  })

  test('rejects duplicate public hostnames across leases', () => {
    const hostname = publicHostname(config, instanceId(11), 'web')
    const one = makeLease({
      instanceId: instanceId(11),
      expose: [{ kind: 'http', hostPrefix: 'web', port: 80 }],
      publicHostnames: { 0: hostname },
    })
    const two = makeLease({
      instanceId: instanceId(12),
      tapName: 'fctap1',
      hostIp: '10.200.0.5',
      guestIp: '10.200.0.6',
      guestMac: '02:00:00:00:00:0b',
      expose: [{ kind: 'http', hostPrefix: 'web', port: 80 }],
      publicHostnames: { 0: hostname },
    })
    expect(() => renderRuleset([one, two], config)).toThrow('assigned to both')
  })

  test('rejects an external interface that could break out of the rule', () => {
    const bad = { ...config, externalInterface: 'wan0" drop; table inet x {' }
    expect(() => renderRuleset([], bad)).toThrow('invalid network interface')
    const tapWildcard = { ...config, externalInterface: 'fctap0' }
    expect(() => renderRuleset([], tapWildcard)).toThrow(
      'invalid network interface'
    )
  })

  test('empty lease set still renders locked-down base tables', () => {
    const text = renderRuleset([], makeConfig())
    expect(text).toContain('table inet rctf_fc {')
    expect(text).toContain('iifname "fctap*" oifname "fctap*" drop')
    expect(text).toContain('policy accept;')
    expect(text).toContain('table arp rctf_fc_arp {')
    expect(text).not.toContain('dnat')
  })
})

test.skipIf(!process.env.FC_REAL)(
  'rendered ruleset passes nft --check on a real kernel',
  async () => {
    const text = renderRuleset(leases, config)
    const result = await bunCommandRunner.run(['nft', '-c', '-f', '-'], {
      stdin: text,
    })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
  }
)
