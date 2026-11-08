import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { firecrackerChallengeConfigSchema } from '@rctf/firecracker-protocol'
import { agentConfigSchema } from '../src/agent/config'
import { loadControllerConfig } from '../src/controller/config'

const root = new URL('../../../deploy/firecracker/', import.meta.url)
const load = (name: string) =>
  parse(readFileSync(new URL(name, root), 'utf8')) as Record<string, unknown>

describe('shipped example configs', () => {
  test('controller.example.yaml parses with the real loader', () => {
    const config = loadControllerConfig(load('controller.example.yaml'))
    expect(config.hosts.length).toBeGreaterThan(0)
  })

  test('agent.example.yaml parses with the real schema', () => {
    expect(
      agentConfigSchema.safeParse(load('agent.example.yaml')).success
    ).toBe(true)
  })

  test('sample-challenge.yaml config + expose satisfy the challenge schema', () => {
    const challenge = load('sample-challenge.yaml') as {
      instancerConfig: { config: unknown; expose: { containerName: string }[] }
    }
    expect(
      firecrackerChallengeConfigSchema.safeParse(
        challenge.instancerConfig.config
      ).success
    ).toBe(true)
    expect(challenge.instancerConfig.expose[0]?.containerName).toBe('app')
  })

  test('the sample challenge actually shows its endpoint to players', () => {
    // The API drops endpoints unless expose[].shouldDisplay is truthy, so an
    // example without it deploys fine and then shows the player nothing.
    const challenge = load('sample-challenge.yaml') as {
      instancerConfig: { expose: { shouldDisplay?: boolean }[] }
    }
    for (const entry of challenge.instancerConfig.expose) {
      expect(entry.shouldDisplay).toBe(true)
    }
  })

  test('the controller example speaks the same scheme the agent serves (plain HTTP)', () => {
    // The agent has no TLS listener; an https:// URL here fails every heartbeat.
    const controller = load('controller.example.yaml') as {
      hosts: { url: string }[]
    }
    for (const host of controller.hosts) {
      expect(host.url.startsWith('http://')).toBe(true)
    }
  })

  test('the agent systemd unit passes the config path the agent requires', () => {
    const unit = readFileSync(
      new URL('host/rctf-firecracker-agent.service', root),
      'utf8'
    )
    const execStart = unit
      .split('\n')
      .find(line => line.startsWith('ExecStart='))
    expect(execStart).toContain(
      'agent/index.ts /etc/rctf-firecracker/agent.yaml'
    )
    // VMs must outlive an agent restart: the default mixed kill mode would SIGKILL them.
    expect(unit).toMatch(/^KillMode=process$/m)
  })

  test('the agent systemd unit keeps the capabilities the jailer needs', () => {
    const unit = readFileSync(
      new URL('host/rctf-firecracker-agent.service', root),
      'utf8'
    )
    const directive = (name: string) =>
      unit
        .split('\n')
        .find(line => line.startsWith(`${name}=`))
        ?.slice(name.length + 1)
        .trim()
        .split(/\s+/) ?? []

    // The jailer chroots, mounts, writes cgroups and setuid/setgid()s to the
    // per-VM uid, so all of these must survive the bounding set.
    const bounding = directive('CapabilityBoundingSet')
    for (const cap of [
      'CAP_NET_ADMIN',
      'CAP_NET_RAW',
      'CAP_SYS_ADMIN',
      'CAP_SYS_CHROOT',
      'CAP_SYS_PTRACE',
      'CAP_SETUID',
      'CAP_SETGID',
      'CAP_CHOWN',
      'CAP_MKNOD',
    ]) {
      expect(bounding).toContain(cap)
    }
    // systemd 255 (Ubuntu 24.04) launches a root unit one bit short of
    // CapBnd (CAP_SETUID) when NoNewPrivileges=yes is combined with a seccomp
    // filter. AmbientCapabilities restores exactly the jailer's bits; removing
    // either directive would silently reintroduce the launch failure.
    expect(unit).toMatch(/^NoNewPrivileges=yes$/m)
    expect(directive('RestrictAddressFamilies')).toEqual(
      expect.arrayContaining(['AF_UNIX', 'AF_INET', 'AF_INET6', 'AF_NETLINK'])
    )
    const ambient = directive('AmbientCapabilities')
    expect(ambient).toContain('CAP_SETUID')
    expect(ambient).toContain('CAP_SETGID')
  })
})
