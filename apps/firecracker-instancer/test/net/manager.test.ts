import { describe, expect, test } from 'bun:test'
import {
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import type { Clock, NetLease } from '../../src/interfaces'
import { NetworkCapacityError } from '../../src/interfaces'
import { createNetworkManager } from '../../src/agent/net'
import { tapAlias } from '../../src/agent/net/tap'
import {
  publicHostname,
  traefikFileName,
} from '../../src/agent/routing/traefik'
import {
  FakeHost,
  instanceId,
  makeLease,
  makeTempConfig,
  tcpExpose,
} from './support'

const setup = async (
  overrides: Parameters<typeof makeTempConfig>[0] = {},
  opts: { clock?: Clock } = {}
) => {
  const config = await makeTempConfig(overrides)
  const host = new FakeHost()
  const clock = opts.clock ?? (() => 1_000_000)
  const manager = createNetworkManager(config, { runner: host, clock })
  return { config, host, manager, clock }
}

/** Mutable fake clock for the reuse-quarantine tests. */
const mutableClock = (start = 1_000_000) => {
  let now = start
  return {
    clock: (() => now) as Clock,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const listDir = async (path: string): Promise<string[]> => {
  try {
    return (await readdir(path)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

const commandsOf = (host: FakeHost): string[] =>
  host.calls.map(call => call.argv.join(' '))

describe('allocate', () => {
  test('200 concurrent allocations are unique and deterministic', async () => {
    const { host, manager } = await setup({
      subnetPool: '10.200.0.0/16',
      tcpPortRange: { from: 20000, to: 29999 },
    })
    const leases = await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        manager.allocate({
          instanceId: instanceId(index),
          egress: false,
          expose: [tcpExpose(1337)],
        })
      )
    )
    expect(new Set(leases.map(lease => lease.guestIp)).size).toBe(200)
    expect(new Set(leases.map(lease => lease.tapName)).size).toBe(200)
    const ports = leases.map(lease => lease.publicPorts[0] as number)
    expect(new Set(ports).size).toBe(200)
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(20000)
      expect(port).toBeLessThanOrEqual(29999)
    }
    // First allocation is deterministic: index 0 -> 10.200.0.1/.2 + fctap0.
    const first = leases.find(lease => lease.instanceId === instanceId(0)) as
      | (typeof leases)[number]
      | undefined
    expect(first?.hostIp).toBe('10.200.0.1')
    expect(first?.guestIp).toBe('10.200.0.2')
    expect(first?.tapName).toBe('fctap0')
    expect(first?.guestMac).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/)
    for (const lease of leases) {
      const firstOctet = Number.parseInt(lease.guestMac.slice(0, 2), 16)
      expect(firstOctet & 0x03).toBe(0x02) // locally administered, unicast
      expect(lease.prefixLength).toBe(30)
      expect(lease.tapName.length).toBeLessThanOrEqual(15)
    }
    expect(host.links.size).toBe(200)
    // Allocation asserts security rules but never publishes public ingress
    // before the VM is up (that is `publish`).
    expect(host.nftText).toContain(
      'iifname "fctap0" ip saddr != 10.200.0.2 drop'
    )
    expect(host.nftText).not.toContain('dnat ip to')

    await manager.publish(first as NetLease, [tcpExpose(1337)])
    expect(host.nftText.match(/ tcp dport \d+ dnat ip to /g)?.length).toBe(1)
  })

  test('is idempotent per instanceId and returns an equal, non-aliased lease', async () => {
    const { host, manager } = await setup()
    const req = {
      instanceId: instanceId(1),
      egress: false,
      expose: [
        tcpExpose(80),
        { kind: 'http' as const, hostPrefix: 'web', port: 3000 },
      ],
    }
    const first = await manager.allocate(req)
    // The lease carries the full expose list so every route can be rebuilt.
    expect(first.expose).toEqual(req.expose)
    const snapshot = structuredClone(first)

    const calls = host.calls.length
    const second = await manager.allocate(req)
    expect(second).toEqual(first)
    expect(host.calls.length).toBe(calls)
    expect(host.links.size).toBe(1)

    // Mutating a returned lease must never change manager state.
    second.expose[0]!.port = 9999
    second.publicPorts[0] = 1
    second.publicHostnames[1] = 'evil.example.com'
    expect(await manager.allocate(req)).toEqual(snapshot)
  })

  test('every created tap carries the durable alias and tap link type', async () => {
    const { host, manager } = await setup()
    const lease = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [],
    })
    const link = host.links.get(lease.tapName)
    expect(link?.kind).toBe('tap')
    expect(link?.alias).toBe(tapAlias('rctf-fc'))
  })

  test('released /30s and ports go through the reuse quarantine, then are reused oldest-first', async () => {
    const { clock, advance } = mutableClock()
    const { manager } = await setup({}, { clock })
    const first = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [tcpExpose(80)],
    })
    await manager.allocate({
      instanceId: instanceId(2),
      egress: false,
      expose: [tcpExpose(80)],
    })
    await manager.release(first.instanceId)

    // Still quarantined: a never-used /30 and port are handed out instead.
    const third = await manager.allocate({
      instanceId: instanceId(3),
      egress: false,
      expose: [tcpExpose(80)],
    })
    expect(third.guestIp).not.toBe(first.guestIp)
    expect(third.guestIp).toBe('10.200.0.10') // index 2
    expect(third.publicPorts[0]).not.toBe(first.publicPorts[0])
    expect(third.publicPorts[0]).toBe(20002)

    // After the quarantine the oldest release is reused.
    advance(121_000)
    const fourth = await manager.allocate({
      instanceId: instanceId(4),
      egress: false,
      expose: [tcpExpose(80)],
    })
    expect(fourth.guestIp).toBe(first.guestIp)
    expect(fourth.publicPorts[0]).toBe(first.publicPorts[0])
  })

  test('IP exhaustion throws NetworkCapacityError with nothing leaked', async () => {
    const { host, manager } = await setup({ subnetPool: '10.9.0.0/30' })
    const lease = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [],
    })
    expect(lease.guestIp).toBe('10.9.0.2')
    const callsBefore = host.calls.length
    await expect(
      manager.allocate({
        instanceId: instanceId(2),
        egress: false,
        expose: [tcpExpose(80)],
      })
    ).rejects.toBeInstanceOf(NetworkCapacityError)
    expect(host.calls.length).toBe(callsBefore) // failed before any host mutation
    expect(host.links.size).toBe(1)
    expect(host.nftText).not.toContain('10.9.0.6')
  })

  test('port exhaustion is atomic and leaks no IP/tap', async () => {
    const { host, manager } = await setup({
      tcpPortRange: { from: 20000, to: 20000 },
    })
    await expect(
      manager.allocate({
        instanceId: instanceId(1),
        egress: false,
        expose: [tcpExpose(80), tcpExpose(81)],
      })
    ).rejects.toBeInstanceOf(NetworkCapacityError)
    expect(host.links.size).toBe(0)
    expect(host.nftWrites).toBe(0)
    expect(
      commandsOf(host).filter(command => command.startsWith('ip '))
    ).toEqual([])

    const lease = await manager.allocate({
      instanceId: instanceId(2),
      egress: false,
      expose: [tcpExpose(80)],
    })
    expect(lease.publicPorts[0]).toBe(20000)
  })

  test('rejects invalid instance ids / host prefixes before touching the host', async () => {
    const { host, manager } = await setup()
    await expect(
      manager.allocate({
        instanceId: 'not valid',
        egress: false,
        expose: [],
      })
    ).rejects.toThrow('invalid instance id')
    await expect(
      manager.allocate({
        instanceId: instanceId(1),
        egress: false,
        expose: [{ kind: 'http', hostPrefix: 'bad`prefix', port: 80 }],
      })
    ).rejects.toThrow('invalid hostPrefix')
    expect(host.calls.length).toBe(0)
  })

  test('a pre-existing fctap interface is never deleted; the index is skipped', async () => {
    const { host, manager } = await setup()
    host.seedTap('fctap0', ['192.168.5.1/24'])
    const lease = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [],
    })
    expect(lease.tapName).toBe('fctap1')
    expect(host.links.has('fctap0')).toBe(true)
    expect(host.nftText).not.toContain('iifname "fctap0"')
    expect(commandsOf(host)).not.toContain('ip link del dev fctap0')
  })

  test('fails clearly when every free /30 index collides with a foreign tap', async () => {
    const { host, manager } = await setup({ subnetPool: '10.9.0.0/30' })
    host.seedTap('fctap0', ['192.168.5.1/24'])
    await expect(
      manager.allocate({
        instanceId: instanceId(1),
        egress: false,
        expose: [],
      })
    ).rejects.toThrow(/already exists/)
    expect(host.links.has('fctap0')).toBe(true)
    expect(host.links.size).toBe(1)
  })

  test('two ids sharing 20 characters collide on hostnames and roll back', async () => {
    const { host, manager } = await setup()
    const shared = 'a'.repeat(20)
    const idA = `${shared}bbbb`
    const idB = `${shared}cccc`
    const expose = [{ kind: 'http' as const, hostPrefix: 'web', port: 3000 }]
    const leaseA = await manager.allocate({
      instanceId: idA,
      egress: false,
      expose,
    })
    const linksBefore = host.links.size
    await expect(
      manager.allocate({ instanceId: idB, egress: false, expose })
    ).rejects.toThrow(/already assigned|already used/)
    // Nothing of the rejected allocation is left behind.
    expect(host.links.size).toBe(linksBefore)
    expect(host.links.has(leaseA.tapName)).toBe(true)

    // Same id with a different hostPrefix is fine.
    const leaseB = await manager.allocate({
      instanceId: idB,
      egress: false,
      expose: [{ kind: 'http' as const, hostPrefix: 'other', port: 3000 }],
    })
    expect(leaseB.publicHostnames[0]).toContain(`other-${idB.slice(0, 20)}`)
  })

  test('a hostname in another instance Traefik file blocks allocation', async () => {
    const { config, host, manager } = await setup()
    const idA = 'b'.repeat(10) + 'cccccc'
    const idB = 'b'.repeat(10) + 'dddddd'
    const claimed = publicHostname(config, idB, 'stale')
    await writeFile(
      join(config.traefikDynamicDir, traefikFileName(idA)),
      `http:\n  routers:\n    x:\n      rule: Host(\`${claimed}\`)\n`
    )
    await expect(
      manager.allocate({
        instanceId: idB,
        egress: false,
        expose: [{ kind: 'http', hostPrefix: 'stale', port: 80 }],
      })
    ).rejects.toThrow(/already used by another Traefik route/)
    expect(host.links.size).toBe(0)
  })
})

describe('fault injection during allocate', () => {
  test('failing ANY single runner call rolls back everything', async () => {
    const { manager: baseline, host: baselineHost } = await setup()
    await baseline.allocate({
      instanceId: instanceId(0),
      egress: false,
      expose: [tcpExpose(80)],
    })
    const callsPerAllocate = baselineHost.calls.length
    // conntrack probe, tuntap add, alias, addr add, link up, nft
    expect(callsPerAllocate).toBe(6)

    for (let failingCall = 1; failingCall <= callsPerAllocate; failingCall++) {
      const { manager, host, config } = await setup()
      host.failAt = failingCall
      await expect(
        manager.allocate({
          instanceId: instanceId(0),
          egress: false,
          expose: [tcpExpose(80)],
        })
      ).rejects.toThrow()

      expect(host.links.size).toBe(0)
      expect(host.nftText).not.toContain('10.200.0.2')
      if (host.nftWrites > 0) {
        expect(host.nftText).toContain('table inet rctf_fc')
      }
      expect(await listDir(config.traefikDynamicDir)).toEqual([])

      // No residue in the in-memory allocators either: a retry succeeds with
      // the same deterministic first lease.
      host.failAt = undefined
      const lease = await manager.allocate({
        instanceId: instanceId(0),
        egress: false,
        expose: [tcpExpose(80)],
      })
      expect(lease.guestIp).toBe('10.200.0.2')
      expect(lease.tapName).toBe('fctap0')
      expect(lease.publicPorts[0]).toBe(20000)
      expect(host.links.size).toBe(1)
    }
  })
})

describe('publish / unpublish / release', () => {
  test('publish installs DNAT + Traefik and endpoints follow expose order', async () => {
    const { config, host, manager } = await setup()
    const expose = [
      tcpExpose(8080),
      { kind: 'http' as const, hostPrefix: 'web', port: 3000 },
      { kind: 'https' as const, hostPrefix: 'web', port: 3000 },
      { kind: 'tcp-ssl' as const, hostPrefix: 'tls', port: 9443 },
    ]
    const lease = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose,
    })
    // Before publish only security rules exist: no DNAT to a dead guest.
    expect(host.nftText).not.toContain('dnat')
    await manager.publish(lease, expose)

    const short = lease.instanceId.slice(0, 20)
    const endpoints = manager.endpoints(lease, expose)
    expect(endpoints).toEqual([
      {
        kind: 'tcp',
        host: 'fc.example.com',
        port: lease.publicPorts[0] as number,
      },
      {
        kind: 'http',
        host: `web-${short}.fc1.example.com`,
        port: 80,
      },
      {
        kind: 'https',
        host: `web-${short}.fc1.example.com`,
        port: 443,
      },
      {
        kind: 'tcp-ssl',
        host: `tls-${short}.fc1.example.com`,
        port: 443,
      },
    ])

    expect(host.nftText).toContain(
      `fib daddr type local tcp dport ${lease.publicPorts[0]} dnat ip to ${lease.guestIp}:8080`
    )
    const traefik = await readFile(
      join(config.traefikDynamicDir, traefikFileName(lease.instanceId)),
      'utf8'
    )
    expect(traefik).toContain(`Host(\`web-${short}.fc1.example.com\`)`)
    expect(traefik).toContain(`HostSNI(\`tls-${short}.fc1.example.com\`)`)
    expect(traefik).toContain(`url: http://${lease.guestIp}:3000`)
    expect(traefik).toContain(`address: ${lease.guestIp}:9443`)

    // Idempotent publish: still exactly one DNAT rule for this port.
    await manager.publish(lease, expose)
    expect(
      host.nftText.match(
        new RegExp(`tcp dport ${lease.publicPorts[0]} dnat ip to`, 'g')
      )?.length
    ).toBe(1)
  })

  test('unpublish fences first, drops ingress, flushes conntrack, then re-asserts security rules', async () => {
    const { config, host, manager } = await setup()
    const expose = [
      tcpExpose(8080),
      { kind: 'http' as const, hostPrefix: 'web', port: 3000 },
    ]
    const lease = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose,
    })
    await manager.publish(lease, expose)
    const publicPort = lease.publicPorts[0] as number
    const writesBefore = host.nftWrites
    const callsBefore = host.calls.length
    await manager.unpublish(lease.instanceId)
    const unpublishCalls = host.calls.slice(callsBefore)
    const nftWrites = unpublishCalls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.argv.join(' ') === 'nft -f -')
    expect(nftWrites.length).toBe(2)
    const fenceWrite = nftWrites[0]?.call.stdin ?? ''
    // The first render must be a pure fence: no DNAT/accept for this lease.
    expect(fenceWrite).not.toContain('dnat')
    expect(fenceWrite).not.toContain(
      `iifname "${lease.tapName}" ip saddr ${lease.guestIp} ct state established,related accept`
    )
    expect(fenceWrite).toContain(`iifname "${lease.tapName}" drop`)
    expect(fenceWrite).toContain(`ip saddr ${lease.guestIp} drop`)
    // Traefik removal + conntrack flush happen while the fence is installed.
    const fenceIndex = nftWrites[0]?.index ?? -1
    const finalIndex = nftWrites[1]?.index ?? -1
    const flushIndex = unpublishCalls.findIndex(call =>
      call.argv.join(' ').startsWith('conntrack -D')
    )
    expect(fenceIndex).toBeGreaterThanOrEqual(0)
    expect(flushIndex).toBeGreaterThan(fenceIndex)
    expect(finalIndex).toBeGreaterThan(flushIndex)
    expect(await listDir(config.traefikDynamicDir)).toEqual([])

    expect(host.links.has(lease.tapName)).toBe(true)
    expect(host.nftText).not.toContain('dnat')
    // Regression: the old implementation removed the whole per-lease ruleset.
    expect(host.nftText).toContain(
      `iifname "${lease.tapName}" ip saddr != ${lease.guestIp} drop`
    )
    expect(host.nftText).toContain(
      `iifname "${lease.tapName}" ether saddr != "${lease.guestMac}" drop`
    )
    expect(host.nftText).toContain(
      `iifname "${lease.tapName}" meta nfproto ipv6 drop`
    )
    expect(host.nftText).toContain(
      `iifname "${lease.tapName}" ip saddr ${lease.guestIp} ct state established,related accept`
    )
    expect(host.nftWrites).toBeGreaterThan(writesBefore)

    const commands = commandsOf(host)
    expect(commands).toContain(`conntrack -D --orig-src ${lease.guestIp}`)
    expect(commands).toContain(`conntrack -D --orig-dst ${lease.guestIp}`)
    expect(commands).toContain(`conntrack -D --reply-src ${lease.guestIp}`)
    expect(commands).toContain(`conntrack -D --reply-dst ${lease.guestIp}`)
    // Never a port-only delete (other tenants' flows share that port).
    expect(commands).not.toContain(
      `conntrack -D --orig-port-dst ${publicPort} -p tcp`
    )

    await manager.publish(lease, expose)
    expect(host.nftText).toContain('dnat')
    expect(await listDir(config.traefikDynamicDir)).toEqual([
      traefikFileName(lease.instanceId),
    ])
    await manager.unpublish(lease.instanceId)
    await manager.unpublish(instanceId(42))
  })

  test('release of a never-allocated id is a no-op', async () => {
    const { config, host, manager } = await setup()
    await manager.release(instanceId(99))
    expect(host.calls.length).toBe(0)
    expect(await listDir(config.traefikDynamicDir)).toEqual([])
  })

  test('release fences, tears down, persists quarantine, is idempotent and tolerates a missing tap', async () => {
    const { clock, advance } = mutableClock()
    const { config, host, manager } = await setup({}, { clock })
    const expose = [
      tcpExpose(8080),
      { kind: 'http' as const, hostPrefix: 'web', port: 3000 },
    ]
    const lease = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose,
    })
    await manager.publish(lease, expose)
    // Simulate a host where the tap vanished underneath us.
    host.links.delete(lease.tapName)
    await manager.release(lease.instanceId)

    expect(host.links.size).toBe(0)
    // The applied ruleset keeps the retiring lease fenced (explicit drops),
    // but no public ingress and no accept for it survive.
    expect(host.nftText).toContain(`iifname "${lease.tapName}" drop`)
    expect(host.nftText).toContain(`ip saddr ${lease.guestIp} drop`)
    expect(host.nftText).not.toContain(
      `iifname "${lease.tapName}" ip saddr ${lease.guestIp} ct state established,related accept`
    )
    expect(host.nftText).not.toContain('dnat')
    expect(await listDir(config.traefikDynamicDir)).toEqual([])
    const commands = commandsOf(host)
    for (const direction of [
      '--orig-src',
      '--orig-dst',
      '--reply-src',
      '--reply-dst',
    ]) {
      expect(commands).toContain(`conntrack -D ${direction} ${lease.guestIp}`)
    }
    // Regression: a port-only delete hits other tenants' connections.
    expect(commands.some(command => command.includes('--orig-port-dst'))).toBe(
      false
    )

    const calls = host.calls.length
    await manager.release(lease.instanceId)
    expect(host.calls.length).toBe(calls)

    // Capacity is back after the quarantine.
    advance(121_000)
    const replacement = await manager.allocate({
      instanceId: instanceId(2),
      egress: false,
      expose: [tcpExpose(8080)],
    })
    expect(replacement.guestIp).toBe(lease.guestIp)
    expect(replacement.publicPorts[0]).toBe(lease.publicPorts[0])
  })

  test('release deletes only this lease conntrack entries, never every flow to the public port', async () => {
    const { host, manager } = await setup()
    const lease = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [tcpExpose(8080)],
    })
    const port = lease.publicPorts[0] as number
    // Our published DNAT flow: reply-src is the guest address.
    host.seedFlow({
      origSrc: '203.0.113.5',
      origDst: '198.51.100.10',
      origPortDst: port,
      replySrc: lease.guestIp,
      replyDst: '203.0.113.5',
    })
    // Another tenant's egress to the same port, and a host-local connection.
    host.seedFlow({
      origSrc: '203.0.113.9',
      origDst: '198.51.100.10',
      origPortDst: port,
      replySrc: '198.51.100.8',
      replyDst: '203.0.113.9',
    })
    host.seedFlow({
      origSrc: '127.0.0.1',
      origDst: '127.0.0.1',
      origPortDst: port,
      replySrc: '127.0.0.1',
      replyDst: '127.0.0.1',
    })
    await manager.release(lease.instanceId)
    expect(host.flows).toHaveLength(2)
    expect(host.flows.map(flow => flow.replySrc)).not.toContain(lease.guestIp)
  })

  test('a failed tap deletion keeps the lease reserved so release can be retried', async () => {
    const { host, manager } = await setup()
    const req = {
      instanceId: instanceId(1),
      egress: false,
      expose: [tcpExpose(8080)],
    }
    const lease = await manager.allocate(req)
    host.failDeleteTap = lease.tapName
    await expect(manager.release(lease.instanceId)).rejects.toThrow(
      'ip link del'
    )
    expect(host.links.has(lease.tapName)).toBe(true)
    // The lease is still owned by the manager (idempotent allocate).
    expect((await manager.allocate(req)).guestIp).toBe(lease.guestIp)

    host.failDeleteTap = undefined
    await manager.release(lease.instanceId)
    expect(host.links.has(lease.tapName)).toBe(false)
    await manager.release(lease.instanceId) // idempotent
  })

  test('release fences before route/tap/conntrack teardown', async () => {
    const { config, host, manager } = await setup()
    const expose = [
      tcpExpose(8080),
      { kind: 'http' as const, hostPrefix: 'web', port: 3000 },
    ]
    const req = { instanceId: instanceId(1), egress: false, expose }
    const lease = await manager.allocate(req)
    await manager.publish(lease, expose)

    const start = host.calls.length
    // Fail at the first flush so we can inspect the exact steady state then.
    host.failMatch = argv => argv[0] === 'conntrack' && argv[1] === '-D'
    await expect(manager.release(lease.instanceId)).rejects.toThrow(
      'could not flush conntrack'
    )
    const calls = host.calls.slice(start)
    const find = (predicate: (argv: string[]) => boolean): number =>
      calls.findIndex(call => predicate(call.argv))
    const fenceIndex = find(
      argv => argv[0] === 'nft' && argv[1] === '-f' && argv[2] === '-'
    )
    const deleteIndex = find(
      argv => argv[0] === 'ip' && argv[1] === 'link' && argv[2] === 'del'
    )
    const flushIndex = find(argv => argv[0] === 'conntrack' && argv[1] === '-D')
    expect(fenceIndex).toBeGreaterThanOrEqual(0)
    expect(fenceIndex).toBeLessThan(deleteIndex)
    expect(deleteIndex).toBeLessThan(flushIndex)

    const fence = calls[fenceIndex]?.stdin ?? ''
    expect(fence).not.toContain('dnat')
    expect(fence).not.toContain(
      `iifname "${lease.tapName}" ip saddr ${lease.guestIp} ct state established,related accept`
    )
    expect(fence).toContain(`iifname "${lease.tapName}" drop`)
    expect(fence).toContain(`ip saddr ${lease.guestIp} drop`)

    // By the time conntrack runs, routes are gone and the tap is deleted.
    expect(await listDir(config.traefikDynamicDir)).toEqual([])
    expect(host.links.has(lease.tapName)).toBe(false)
    // ...but the lease is still reserved and fenced.
    expect((await manager.allocate(req)).guestIp).toBe(lease.guestIp)
    expect(host.nftText).toContain(`iifname "${lease.tapName}" drop`)
  })

  test('a fence or tap-delete failure leaves the lease reserved and fenced; retry completes', async () => {
    for (const step of ['fence', 'tap'] as const) {
      const { config, host, manager } = await setup()
      const req = {
        instanceId: instanceId(1),
        egress: false,
        expose: [tcpExpose(8080)],
      }
      const lease = await manager.allocate(req)
      await manager.publish(lease, [tcpExpose(8080)])
      if (step === 'fence') {
        host.failMatch = argv => argv[0] === 'nft' && argv[1] === '-f'
      } else {
        host.failDeleteTap = lease.tapName
      }
      await expect(manager.release(lease.instanceId)).rejects.toThrow()
      // Still reserved (idempotent allocate returns the same lease).
      expect((await manager.allocate(req)).guestIp).toBe(lease.guestIp)
      // A fence failure aborts before teardown; a tap-delete failure happens
      // after the fence. Either way the tap is still present.
      expect(host.links.has(lease.tapName)).toBe(true)
      if (step === 'tap') {
        // Routes are removed between the fence and the tap deletion.
        expect(await listDir(config.traefikDynamicDir)).toEqual([])
        // The fence was installed before the failing tap deletion.
        expect(host.nftText).toContain(`iifname "${lease.tapName}" drop`)
        expect(host.nftText).not.toContain('dnat')
        expect(
          commandsOf(host).some(command => command.startsWith('conntrack -D'))
        ).toBe(false)
      }
      host.failMatch = undefined
      host.failDeleteTap = undefined
      await manager.release(lease.instanceId)
      expect(host.links.has(lease.tapName)).toBe(false)
      expect(host.nftText).toContain(`iifname "${lease.tapName}" drop`)
    }
  })

  test('a route-removal failure leaves the lease reserved and fenced; retry completes', async () => {
    const { config, host, manager } = await setup()
    const expose = [{ kind: 'http' as const, hostPrefix: 'web', port: 3000 }]
    const req = { instanceId: instanceId(1), egress: false, expose }
    const lease = await manager.allocate(req)
    await manager.publish(lease, expose)

    const parked = `${config.traefikDynamicDir}.parked`
    await rename(config.traefikDynamicDir, parked)
    await writeFile(config.traefikDynamicDir, 'not a directory')
    await expect(manager.release(lease.instanceId)).rejects.toThrow()
    // Fence applied, but tap/routes/conntrack not torn down yet.
    expect(host.nftText).toContain(`iifname "${lease.tapName}" drop`)
    expect(host.nftText).not.toContain('dnat')
    expect(host.links.has(lease.tapName)).toBe(true)
    expect((await manager.allocate(req)).guestIp).toBe(lease.guestIp)

    await rm(config.traefikDynamicDir)
    await rename(parked, config.traefikDynamicDir)
    await manager.release(lease.instanceId)
    expect(host.links.has(lease.tapName)).toBe(false)
    expect(await listDir(config.traefikDynamicDir)).toEqual([])
  })

  test('restore while a lease is half-released keeps it fenced and does not resurrect it', async () => {
    const { host, manager } = await setup()
    const req = {
      instanceId: instanceId(1),
      egress: false,
      expose: [tcpExpose(8080)],
    }
    const lease = await manager.allocate(req)
    await manager.publish(lease, [tcpExpose(8080)])
    // Fence -> routes gone -> tap deleted -> flush fails.
    host.conntrackFlushError = 'Operation not permitted'
    await expect(manager.release(lease.instanceId)).rejects.toThrow(
      'could not flush conntrack'
    )
    host.conntrackFlushError = undefined
    expect(host.links.has(lease.tapName)).toBe(false)

    await manager.restore([lease])
    expect(host.nftText).toContain(`iifname "${lease.tapName}" drop`)
    expect(host.nftText).toContain(`ip saddr ${lease.guestIp} drop`)
    expect(host.nftText).not.toContain('dnat')
    expect(host.nftText).not.toContain(
      `iifname "${lease.tapName}" ip saddr ${lease.guestIp} ct state established,related accept`
    )
    // Restore must not re-create the tap of a lease that is being released.
    expect(host.links.has(lease.tapName)).toBe(false)
    expect((await manager.allocate(req)).guestIp).toBe(lease.guestIp)

    await manager.release(lease.instanceId)
    expect(host.links.has(lease.tapName)).toBe(false)
  })

  test('release never deletes a foreign interface that took over the lease name', async () => {
    const { host, manager } = await setup()
    const req = {
      instanceId: instanceId(1),
      egress: false,
      expose: [],
    }
    const lease = await manager.allocate(req)
    host.links.delete(lease.tapName)
    host.seedTap(lease.tapName, [], true, { kind: 'dummy' })
    await manager.release(lease.instanceId)
    expect(host.links.has(lease.tapName)).toBe(true)
    expect(commandsOf(host)).not.toContain(`ip link del dev ${lease.tapName}`)
  })

  test('a conntrack flush failure keeps the lease reserved', async () => {
    const { host, manager } = await setup()
    const req = {
      instanceId: instanceId(1),
      egress: false,
      expose: [tcpExpose(8080)],
    }
    const lease = await manager.allocate(req)
    host.conntrackFlushError = 'Operation not permitted'
    await expect(manager.release(lease.instanceId)).rejects.toThrow(
      'could not flush conntrack entries'
    )
    expect((await manager.allocate(req)).guestIp).toBe(lease.guestIp)

    host.conntrackFlushError = undefined
    await manager.release(lease.instanceId)
    expect(host.nftText).toContain(`iifname "${lease.tapName}" drop`)
    expect(host.nftText).not.toContain(
      `iifname "${lease.tapName}" ip saddr ${lease.guestIp} ct state established,related accept`
    )
  })

  test('"no conntrack entries" is a successful flush', async () => {
    const { host, manager } = await setup()
    const lease = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [tcpExpose(8080)],
    })
    host.conntrackEmpty = true
    await manager.release(lease.instanceId)
    expect(host.links.has(lease.tapName)).toBe(false)
  })

  test('allocation refuses without conntrack-tools unless requireConntrack=false', async () => {
    const strict = await setup()
    strict.host.conntrackOk = false
    await expect(
      strict.manager.allocate({
        instanceId: instanceId(1),
        egress: false,
        expose: [],
      })
    ).rejects.toThrow('conntrack-tools')

    const relaxed = await setup({ requireConntrack: false })
    relaxed.host.conntrackOk = false
    const lease = await relaxed.manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [],
    })
    expect(lease.guestIp).toBe('10.200.0.2')
    // With requireConntrack=false a missing binary must not fail preflight
    // (a failing check takes the whole host out of rotation).
    expect((await relaxed.manager.preflight()).conntrackBin).toBe(true)

    const required = await setup()
    required.host.conntrackOk = false
    expect((await required.manager.preflight()).conntrackBin).toBe(false)
  })

  test('egress leases get masquerade, others do not', async () => {
    const { host, manager } = await setup()
    const closed = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [],
    })
    const open = await manager.allocate({
      instanceId: instanceId(2),
      egress: true,
      expose: [],
    })
    expect(host.nftText).toContain(
      `iifname "${open.tapName}" oifname "eth0" ip saddr ${open.guestIp} masquerade`
    )
    expect(host.nftText).not.toContain(
      `iifname "${closed.tapName}" oifname "eth0" ip saddr ${closed.guestIp} masquerade`
    )
  })
})

describe('restore', () => {
  test('re-asserts live leases and removes every orphan artifact', async () => {
    const config = await makeTempConfig()
    const hostA = new FakeHost()
    const managerA = createNetworkManager(config, { runner: hostA })
    const tcpLease = await managerA.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [tcpExpose(8080)],
    })
    await managerA.publish(tcpLease, [tcpExpose(8080)])
    const httpExpose = [
      { kind: 'http' as const, hostPrefix: 'web', port: 3000 },
    ]
    const httpLease = await managerA.allocate({
      instanceId: instanceId(2),
      egress: true,
      expose: httpExpose,
    })
    await managerA.publish(httpLease, httpExpose)

    const leases = [tcpLease, httpLease]
    const orphanId = instanceId(77)
    const hostB = new FakeHost()
    // A down, unaddressed tap carrying OUR alias is an interrupted create.
    hostB.seedTapAsAgent('fctap99', [], false)
    await writeFile(
      join(config.traefikDynamicDir, traefikFileName(orphanId)),
      'http: {}\n'
    )

    const managerB = createNetworkManager(config, { runner: hostB })
    const result = (await managerB.restore(leases)) as {
      removedOrphans: string[]
      keptOrphans: string[]
      skippedLeases: string[]
    }

    expect(result.removedOrphans).toEqual(
      [`tap:fctap99`, `traefik:${orphanId}`].sort()
    )
    expect(result.keptOrphans).toEqual([])
    expect(hostB.links.has(tcpLease.tapName)).toBe(true)
    expect(hostB.links.has(httpLease.tapName)).toBe(true)
    expect(hostB.links.has('fctap99')).toBe(false)
    expect(hostB.nftText).toContain(
      `fib daddr type local tcp dport ${tcpLease.publicPorts[0]} dnat ip to ${tcpLease.guestIp}:8080`
    )
    expect(hostB.nftText).toContain(
      `iifname "${httpLease.tapName}" ip saddr != ${httpLease.guestIp} drop`
    )
    const httpFile = await readFile(
      join(config.traefikDynamicDir, traefikFileName(httpLease.instanceId)),
      'utf8'
    )
    expect(httpFile).toContain(
      `Host(\`web-${httpLease.instanceId.slice(0, 20)}.fc1.example.com\`)`
    )
    expect(await listDir(config.traefikDynamicDir)).toEqual([
      traefikFileName(httpLease.instanceId),
    ])
  })

  test('completes partially existing taps without recreating them', async () => {
    const config = await makeTempConfig()
    const managerA = createNetworkManager(config, { runner: new FakeHost() })
    const lease = await managerA.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [tcpExpose(8080)],
    })

    const host = new FakeHost()
    host.seedTapAsAgent(lease.tapName, [], false) // exists, no address, down
    const manager = createNetworkManager(config, { runner: host })
    await manager.restore([lease])

    const commands = commandsOf(host)
    expect(
      commands.filter(command => command.startsWith('ip tuntap add'))
    ).toEqual([])
    expect(commands).toContain(
      `ip addr add ${lease.hostIp}/30 dev ${lease.tapName}`
    )
    expect(commands).toContain(`ip link set dev ${lease.tapName} up`)
    expect(host.links.get(lease.tapName)?.up).toBe(true)
  })

  test('rewrites an existing Traefik file from the lease (no sidecar)', async () => {
    const config = await makeTempConfig()
    const hostA = new FakeHost()
    const managerA = createNetworkManager(config, { runner: hostA })
    const expose = [{ kind: 'http' as const, hostPrefix: 'web', port: 3000 }]
    const lease = await managerA.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose,
    })
    await managerA.publish(lease, expose)
    const path = join(
      config.traefikDynamicDir,
      traefikFileName(lease.instanceId)
    )
    await writeFile(path, 'stale: true\n') // an old/partial file must not survive

    const managerB = createNetworkManager(config, { runner: new FakeHost() })
    await managerB.restore([lease])
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('stale: true')
    expect(text).toContain(
      `Host(\`web-${lease.instanceId.slice(0, 20)}.fc1.example.com\`)`
    )
  })

  test('skips and reports an incomplete lease instead of dropping its DNAT silently', async () => {
    const config = await makeTempConfig()
    const managerA = createNetworkManager(config, { runner: new FakeHost() })
    const good = await managerA.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [tcpExpose(8080)],
    })
    const badId = instanceId(5)
    const bad: NetLease = {
      ...makeLease({
        instanceId: badId,
        tapName: 'fctap5',
        hostIp: '10.200.0.21',
        guestIp: '10.200.0.22',
        expose: [tcpExpose(8080)],
      }),
    }
    const host = new FakeHost()
    const manager = createNetworkManager(config, { runner: host })
    const result = (await manager.restore([good, bad])) as {
      removedOrphans: string[]
      keptOrphans: string[]
      skippedLeases: string[]
    }
    expect(result.skippedLeases).toEqual([badId])
    expect(host.nftText).toContain(
      `tcp dport ${good.publicPorts[0]} dnat ip to ${good.guestIp}:8080`
    )
    expect(host.nftText).not.toContain(bad.guestIp)
  })

  test('leaves a foreign fctap interface alone and reports it', async () => {
    const { host, manager } = await setup()
    host.seedTap('fctap9', ['192.168.5.9/24'])
    const result = (await manager.restore([])) as {
      removedOrphans: string[]
      keptOrphans: string[]
      skippedLeases: string[]
    }
    expect(result.keptOrphans).toEqual(['tap:fctap9'])
    expect(result.removedOrphans).not.toContain('tap:fctap9')
    expect(host.links.has('fctap9')).toBe(true)
    expect(commandsOf(host)).not.toContain('ip link del dev fctap9')
  })

  test('leaves a dummy fctap9 alone even when it spoofs our alias (wrong link type)', async () => {
    const { host, manager } = await setup()
    host.seedTap('fctap9', [], false, {
      kind: 'dummy',
      alias: tapAlias('rctf-fc'),
    })
    const result = (await manager.restore([])) as {
      removedOrphans: string[]
      keptOrphans: string[]
      skippedLeases: string[]
    }
    expect(result.keptOrphans).toEqual(['tap:fctap9'])
    expect(host.links.has('fctap9')).toBe(true)
    expect(commandsOf(host)).not.toContain('ip link del dev fctap9')
  })

  test('fails a restored live lease whose interface lacks our marker, without touching it', async () => {
    const config = await makeTempConfig()
    const managerA = createNetworkManager(config, { runner: new FakeHost() })
    const lease = await managerA.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [],
    })
    const host = new FakeHost()
    host.seedTap(lease.tapName, ['192.168.5.1/24'], true, { kind: 'dummy' })
    const manager = createNetworkManager(config, { runner: host })
    await expect(manager.restore([lease])).rejects.toThrow(/does not belong/)
    expect(host.links.get(lease.tapName)?.kind).toBe('dummy')
    expect(host.links.get(lease.tapName)?.alias).toBeUndefined()
    expect(commandsOf(host)).not.toContain(
      `ip addr add ${lease.hostIp}/30 dev ${lease.tapName}`
    )
    expect(commandsOf(host)).not.toContain(`ip link del dev ${lease.tapName}`)
  })

  test('restore with a flipped egress flag fences and flushes before re-rendering', async () => {
    const config = await makeTempConfig()
    const host = new FakeHost()
    const clock = (): number => 1_000_000
    const managerA = createNetworkManager(config, { runner: host, clock })
    const lease = await managerA.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [],
    })
    expect(host.nftText).toContain(
      `iifname "${lease.tapName}" ct state new drop`
    )

    const start = host.calls.length
    const managerB = createNetworkManager(config, { runner: host, clock })
    await managerB.restore([{ ...lease, egress: true }])
    const calls = host.calls.slice(start)
    const writes = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.argv.join(' ') === 'nft -f -')
    expect(writes.length).toBeGreaterThanOrEqual(2)
    const fence = writes[0]?.call.stdin ?? ''
    expect(fence).toContain(`iifname "${lease.tapName}" drop`)
    expect(fence).not.toContain('ct state established,related accept')
    expect(fence).not.toContain(`ip saddr ${lease.guestIp} ct state new drop`)
    const flushIndex = calls.findIndex(
      call => call.argv[0] === 'conntrack' && call.argv[1] === '-D'
    )
    expect(flushIndex).toBeGreaterThan(writes[0]?.index ?? -1)
    expect(flushIndex).toBeLessThan(writes[1]?.index ?? Number.MAX_SAFE_INTEGER)

    // The final ruleset is rendered with the restored lease's egress flag.
    expect(host.nftText).toContain(
      `iifname "${lease.tapName}" oifname "eth0" ip saddr ${lease.guestIp} accept`
    )
    expect(host.nftText).toContain(
      `iifname "${lease.tapName}" oifname "eth0" ip saddr ${lease.guestIp} masquerade`
    )
    expect(
      (
        await managerB.allocate({
          instanceId: lease.instanceId,
          egress: true,
          expose: [],
        })
      ).egress
    ).toBe(true)
  })

  test('removes an abandoned in-pool tap and quarantines its index', async () => {
    const { host, manager } = await setup()
    host.seedTapAsAgent('fctap0', [], false)
    const result = await manager.restore([])
    expect(result.removedOrphans).toContain('tap:fctap0')

    const lease = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [],
    })
    expect(lease.tapName).toBe('fctap1')
  })

  test('rejects duplicate leases instead of silently corrupting the allocators', async () => {
    const { manager } = await setup()
    const lease = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [],
    })
    await expect(manager.restore([lease, lease])).rejects.toThrow('duplicate')
  })
})

describe('preflight', () => {
  test('reports working tools, ip_forward, writable dirs and a sane range', async () => {
    const { manager } = await setup()
    const checks = await manager.preflight()
    expect(checks.nft).toBe(true)
    expect(checks.ip).toBe(true)
    expect(checks.conntrackBin).toBe(true)
    expect(typeof checks.ipForward).toBe('boolean')
    expect(checks.traefikDirWritable).toBe(true)
    expect(checks.tcpPortRange).toBe(true)
  })

  test('reports broken tools, config and missing dirs as false, never throwing', async () => {
    const { manager, host } = await setup()
    host.nftOk = false
    host.ipOk = false
    host.conntrackOk = false
    const checks = await manager.preflight()
    expect(checks.nft).toBe(false)
    expect(checks.ip).toBe(false)
    expect(checks.conntrackBin).toBe(false)

    const broken = await setup({ tcpPortRange: { from: 30000, to: 20000 } })
    const badChecks = await broken.manager.preflight()
    expect(badChecks.tcpPortRange).toBe(false)
    await expect(
      broken.manager.allocate({
        instanceId: instanceId(1),
        egress: false,
        expose: [tcpExpose(80)],
      })
    ).rejects.toThrow('invalid tcpPortRange')

    const overlapping = await setup({ tcpPortRange: { from: 1, to: 1000 } })
    expect((await overlapping.manager.preflight()).tcpPortRange).toBe(false)
    await expect(
      overlapping.manager.allocate({
        instanceId: instanceId(1),
        egress: false,
        expose: [tcpExpose(80)],
      })
    ).rejects.toThrow('invalid tcpPortRange')

    const missing = await setup({
      traefikDynamicDir: '/nonexistent/rctf-fc-traefik',
    })
    const missingChecks = await missing.manager.preflight()
    expect(missingChecks.traefikDirWritable).toBe(false)
  })
})

describe('quarantine persistence', () => {
  test('released /30s and ports stay quarantined across a restart and restore([])', async () => {
    const { clock, advance } = mutableClock()
    const config = await makeTempConfig()
    const hostA = new FakeHost()
    const managerA = createNetworkManager(config, {
      runner: hostA,
      clock,
    })
    const first = await managerA.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [tcpExpose(80)],
    })
    await managerA.release(first.instanceId)

    // New process over the same quarantine file, then restore([]) (which must
    // not reset deadlines to "now" or drop them).
    const hostB = new FakeHost()
    const managerB = createNetworkManager(config, {
      runner: hostB,
      clock,
    })
    await managerB.restore([])
    const second = await managerB.allocate({
      instanceId: instanceId(2),
      egress: false,
      expose: [tcpExpose(80)],
    })
    expect(second.guestIp).not.toBe(first.guestIp)
    expect(second.publicPorts[0]).not.toBe(first.publicPorts[0])

    advance(121_000)
    const third = await managerB.allocate({
      instanceId: instanceId(3),
      egress: false,
      expose: [tcpExpose(80)],
    })
    expect(third.guestIp).toBe(first.guestIp)
    expect(third.publicPorts[0]).toBe(first.publicPorts[0])
  })

  test('same-process restore preserves in-memory quarantine deadlines', async () => {
    const { clock, advance } = mutableClock()
    const { host, manager } = await setup({}, { clock })
    const first = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [tcpExpose(80)],
    })
    await manager.release(first.instanceId)
    await manager.restore([])

    const second = await manager.allocate({
      instanceId: instanceId(2),
      egress: false,
      expose: [tcpExpose(80)],
    })
    expect(second.guestIp).not.toBe(first.guestIp)
    advance(121_000)
    const third = await manager.allocate({
      instanceId: instanceId(3),
      egress: false,
      expose: [tcpExpose(80)],
    })
    expect(third.guestIp).toBe(first.guestIp)
    expect(host.links.has(first.tapName)).toBe(true)
  })

  test('a corrupt quarantine file fails closed for one quarantine period', async () => {
    const { clock, advance } = mutableClock()
    const config = await makeTempConfig({ subnetPool: '10.9.0.0/24' })
    await writeFile(config.quarantineFile, '{not json', { mode: 0o600 })
    const host = new FakeHost()
    const manager = createNetworkManager(config, { runner: host, clock })
    await manager.restore([])
    await expect(
      manager.allocate({
        instanceId: instanceId(1),
        egress: false,
        expose: [tcpExpose(80)],
      })
    ).rejects.toBeInstanceOf(NetworkCapacityError)

    advance(121_000)
    const lease = await manager.allocate({
      instanceId: instanceId(2),
      egress: false,
      expose: [tcpExpose(80)],
    })
    expect(lease.guestIp).toBe('10.9.0.2')
    expect(lease.publicPorts[0]).toBe(20000)
  })

  test('writes only resource ids + expiry to a 0600 file', async () => {
    const { config, manager } = await setup()
    const lease = await manager.allocate({
      instanceId: instanceId(1),
      egress: false,
      expose: [tcpExpose(80)],
    })
    await manager.release(lease.instanceId)
    const info = await stat(config.quarantineFile)
    expect(info.mode & 0o777).toBe(0o600)
    const text = await readFile(config.quarantineFile, 'utf8')
    const document = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(document).sort()).toEqual([
      'indexes',
      'ports',
      'version',
    ])
    expect(text).not.toContain(lease.guestIp)
    expect(text).not.toContain(lease.instanceId)
    expect(text).not.toContain(lease.guestMac)
    expect(text).not.toContain(lease.tapName)
  })
})
