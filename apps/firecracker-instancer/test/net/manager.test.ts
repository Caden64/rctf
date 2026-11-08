import { describe, expect, test } from 'bun:test'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NetworkCapacityError } from '../../src/interfaces'
import { createNetworkManager } from '../../src/agent/net'
import { traefikFileName } from '../../src/agent/routing/traefik'
import { FakeHost, instanceId, makeTempConfig, tcpExpose } from './support'

const setup = async (overrides: Parameters<typeof makeTempConfig>[0] = {}) => {
  const config = await makeTempConfig(overrides)
  const host = new FakeHost()
  const manager = createNetworkManager(config, { runner: host })
  return { config, host, manager }
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
    const first = leases.find(
      lease => lease.instanceId === instanceId(0)
    ) as (typeof leases)[number]
    expect(first.hostIp).toBe('10.200.0.1')
    expect(first.guestIp).toBe('10.200.0.2')
    expect(first.tapName).toBe('fctap0')
    expect(first.guestMac).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/)
    for (const lease of leases) {
      const firstOctet = Number.parseInt(lease.guestMac.slice(0, 2), 16)
      expect(firstOctet & 0x03).toBe(0x02) // locally administered, unicast
      expect(lease.prefixLength).toBe(30)
      expect(lease.tapName.length).toBeLessThanOrEqual(15)
    }
    expect(host.links.size).toBe(200)
    expect(host.nftText.match(/ tcp dport \d+ dnat ip to /g)?.length).toBe(200)
  })

  test('is idempotent per instanceId and does not touch the host again', async () => {
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
    const calls = host.calls.length
    const second = await manager.allocate(req)
    expect(second).toEqual(first)
    expect(host.calls.length).toBe(calls)
    expect(host.links.size).toBe(1)
  })

  test('released addresses and ports are reused', async () => {
    const { manager } = await setup()
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
    const again = await manager.allocate({
      instanceId: instanceId(3),
      egress: false,
      expose: [tcpExpose(80)],
    })
    expect(again.guestIp).toBe(first.guestIp)
    expect(again.tapName).toBe(first.tapName)
    expect(again.publicPorts[0]).toBe(first.publicPorts[0])
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
    expect(host.calls.length).toBe(callsBefore) // failed before any host op
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
    expect(host.calls.length).toBe(0)

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
    expect(callsPerAllocate).toBe(4) // tuntap add, addr add, link up, nft

    for (let failingCall = 1; failingCall <= callsPerAllocate; failingCall++) {
      const { manager, host, config } = await setup()
      host.failAt = failingCall
      await expect(
        manager.allocate({
          instanceId: instanceId(0),
          egress: false,
          expose: [tcpExpose(80)],
        })
      ).rejects.toThrow('injected failure')

      expect(host.links.size).toBe(0)
      expect(host.nftText).not.toContain('10.200.0.2')
      expect(host.nftText).toContain('table inet rctf_fc')
      expect(await listDir(config.routesDir)).toEqual([])
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
    await manager.publish(lease, expose)

    const short = lease.instanceId.slice(0, 10)
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
      `tcp dport ${lease.publicPorts[0]} dnat ip to ${lease.guestIp}:8080`
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

  test('unpublish removes routing but keeps the tap and lease; publish restores', async () => {
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
    await manager.unpublish(lease.instanceId)

    expect(host.links.has(lease.tapName)).toBe(true)
    expect(host.nftText).not.toContain('dnat')
    expect(host.nftText).not.toContain(lease.guestIp)
    expect(await listDir(config.traefikDynamicDir)).toEqual([])

    await manager.publish(lease, expose)
    expect(host.nftText).toContain('dnat')
    expect(await listDir(config.traefikDynamicDir)).toEqual([
      traefikFileName(lease.instanceId),
    ])
    // unpublish is idempotent (no lease knowledge required)
    await manager.unpublish(lease.instanceId)
    await manager.unpublish(instanceId(42))
  })

  test('release of a never-allocated id is a no-op', async () => {
    const { config, host, manager } = await setup()
    await manager.release(instanceId(99))
    expect(host.calls.length).toBe(0)
    expect(await listDir(config.traefikDynamicDir)).toEqual([])
    expect(await listDir(config.routesDir)).toEqual([])
  })

  test('release removes everything, is idempotent and tolerates a missing tap', async () => {
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
    // Simulate a host where the tap vanished underneath us.
    host.links.delete(lease.tapName)
    await manager.release(lease.instanceId)

    expect(host.links.size).toBe(0)
    expect(host.nftText).not.toContain(lease.guestIp)
    expect(await listDir(config.traefikDynamicDir)).toEqual([])
    expect(await listDir(config.routesDir)).toEqual([])

    const calls = host.calls.length
    await manager.release(lease.instanceId)
    expect(host.calls.length).toBe(calls)

    // Capacity is back.
    const replacement = await manager.allocate({
      instanceId: instanceId(2),
      egress: false,
      expose: [tcpExpose(8080)],
    })
    expect(replacement.guestIp).toBe(lease.guestIp)
    expect(replacement.publicPorts[0]).toBe(lease.publicPorts[0])
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
    hostB.seedTap('fctap99')
    await writeFile(
      join(config.traefikDynamicDir, traefikFileName(orphanId)),
      'http: {}\n'
    )
    await writeFile(
      join(config.routesDir, `${orphanId}.json`),
      JSON.stringify({ instanceId: orphanId, expose: [] })
    )

    const managerB = createNetworkManager(config, { runner: hostB })
    const result = await managerB.restore(leases)

    expect(result.removedOrphans).toEqual(
      [`route:${orphanId}`, `tap:fctap99`, `traefik:${orphanId}`].sort()
    )
    expect(hostB.links.has(tcpLease.tapName)).toBe(true)
    expect(hostB.links.has(httpLease.tapName)).toBe(true)
    expect(hostB.links.has('fctap99')).toBe(false)
    expect(hostB.nftText).toContain(
      `tcp dport ${tcpLease.publicPorts[0]} dnat ip to ${tcpLease.guestIp}:8080`
    )
    expect(hostB.nftText).toContain(
      `iifname "${httpLease.tapName}" ip saddr != ${httpLease.guestIp} drop`
    )
    const httpFile = await readFile(
      join(config.traefikDynamicDir, traefikFileName(httpLease.instanceId)),
      'utf8'
    )
    expect(httpFile).toContain(
      `Host(\`web-${httpLease.instanceId.slice(0, 10)}.fc1.example.com\`)`
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
    host.seedTap(lease.tapName) // exists but has no address and no up flag
    const manager = createNetworkManager(config, { runner: host })
    await manager.restore([lease])

    const commands = host.calls.map(call => call.argv.join(' '))
    expect(
      commands.filter(command => command.startsWith('ip tuntap add'))
    ).toEqual([])
    expect(commands).toContain(
      `ip addr add ${lease.hostIp}/30 dev ${lease.tapName}`
    )
    expect(commands).toContain(`ip link set dev ${lease.tapName} up`)
    expect(host.links.get(lease.tapName)?.up).toBe(true)
  })

  test('keeps a working Traefik file when the route sidecar is missing', async () => {
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
    const before = await readFile(path, 'utf8')
    await rm(join(config.routesDir, `${lease.instanceId}.json`))

    const managerB = createNetworkManager(config, { runner: new FakeHost() })
    await managerB.restore([lease])
    expect(await readFile(path, 'utf8')).toBe(before)
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
    const { config, manager } = await setup()
    const checks = await manager.preflight()
    expect(checks.nft).toBe(true)
    expect(checks.ip).toBe(true)
    expect(typeof checks.ipForward).toBe('boolean')
    expect(checks.traefikDirWritable).toBe(true)
    expect(checks.routesDirWritable).toBe(true)
    expect(checks.tcpPortRange).toBe(true)
    void config
  })

  test('reports broken tools, config and missing dirs as false, never throwing', async () => {
    const { manager, host } = await setup()
    host.nftOk = false
    host.ipOk = false
    const checks = await manager.preflight()
    expect(checks.nft).toBe(false)
    expect(checks.ip).toBe(false)

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
      routesDir: '/nonexistent/rctf-fc-routes',
    })
    const missingChecks = await missing.manager.preflight()
    expect(missingChecks.traefikDirWritable).toBe(false)
    expect(missingChecks.routesDirWritable).toBe(false)
  })
})
