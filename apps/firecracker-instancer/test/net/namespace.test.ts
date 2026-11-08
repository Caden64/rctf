/**
 * Real-kernel checks that do not need root: everything runs inside a fresh
 * unprivileged user+network namespace (`unshare -Urn`), so real `ip`/`nft`
 * objects are created but cannot touch the host. Skipped when the environment
 * does not allow unprivileged user namespaces.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { NetLease } from '../../src/interfaces'
import { renderRuleset } from '../../src/agent/net/nftables'
import { publicHostname } from '../../src/agent/routing/traefik'
import { instanceId, makeConfig, makeLease } from './support'

const canUnshare = (() => {
  try {
    const result = Bun.spawnSync(['unshare', '-Urn', 'true'])
    return result.exitCode === 0
  } catch {
    return false
  }
})()

const ns = test.skipIf(!canUnshare)

interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

const spawn = async (argv: string[], stdin?: string): Promise<SpawnResult> => {
  const proc = Bun.spawn(argv, {
    stdin: stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (stdin !== undefined && proc.stdin !== undefined) {
    proc.stdin.write(stdin)
    await proc.stdin.end()
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

describe('real namespace networking', () => {
  ns('full rendered ruleset (2 leases) passes nft -c -f -', async () => {
    const config = makeConfig({
      subnetPool: '198.51.100.0/24',
      externalInterface: 'ware0',
    })
    const egress: NetLease = makeLease({
      instanceId: instanceId(1),
      tapName: 'fctap0',
      hostIp: '198.51.100.1',
      guestIp: '198.51.100.2',
      guestMac: '02:00:00:00:00:01',
      egress: true,
    })
    const published: NetLease = makeLease({
      instanceId: instanceId(2),
      tapName: 'fctap1',
      hostIp: '198.51.100.5',
      guestIp: '198.51.100.6',
      guestMac: '02:00:00:00:00:02',
      expose: [
        { kind: 'tcp', hostPrefix: 'svc', port: 8080 },
        { kind: 'tcp-ssl', hostPrefix: 'tls', port: 9443 },
        { kind: 'http', hostPrefix: 'web', port: 3000 },
      ],
      publicPorts: { 0: 24000 },
      publicHostnames: {
        1: publicHostname(config, instanceId(2), 'tls'),
        2: publicHostname(config, instanceId(2), 'web'),
      },
      egress: false,
    })
    const text = renderRuleset([egress, published], config)
    const result = await spawn(
      ['unshare', '-Urn', 'nft', '-c', '-f', '-'],
      text
    )
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)

    // The release fence variant must also be valid nft syntax.
    const fenced = renderRuleset([egress, published], config, {
      fenced: new Set([instanceId(1)]),
    })
    const fencedResult = await spawn(
      ['unshare', '-Urn', 'nft', '-c', '-f', '-'],
      fenced
    )
    expect(fencedResult.stderr).toBe('')
    expect(fencedResult.code).toBe(0)
  })

  ns(
    'dummy fctap9 survives restore; a manager-created tap gets the alias and is removed on release',
    async () => {
      const helper = join(import.meta.dir, 'namespace-helper.ts')
      const result = await spawn(['unshare', '-Urn', process.execPath, helper])
      expect(result.code).toBe(0)
      const line = result.stdout.trim().split('\n').at(-1) ?? ''
      const data = JSON.parse(line) as Record<string, unknown>
      expect(data['keptOrphans']).toEqual(['tap:fctap9'])
      expect(data['dummyExists']).toBe(true)
      expect(data['tapType']).toBe(true)
      expect(data['alias']).toBe('rctf-fc:rctf-fc')
      expect(data['tapGone']).toBe(true)
      expect(data['released']).toBe(true)
    }
  )
})
