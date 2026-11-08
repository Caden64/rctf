import { describe, expect, test } from 'bun:test'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  TraefikFileManager,
  publicHostname,
  renderTraefikFile,
  traefikFileName,
  type TraefikRoute,
} from '../../src/agent/routing/traefik'
import { instanceId, makeTempConfig } from './support'

const config = await makeTempConfig({
  httpDomain: 'fc7.ctf.example.com',
  httpEntrypoint: 'web',
  httpsEntrypoint: 'secure',
  tcpSslEntrypoint: 'tcps',
  certResolver: 'le-wildcard',
})

const id = instanceId(7)
const hostname = publicHostname(config, id, 'baby-rev')

const routes: TraefikRoute[] = [
  {
    index: 0,
    kind: 'http',
    hostname,
    guestIp: '10.200.0.2',
    guestPort: 8080,
  },
  {
    index: 1,
    kind: 'https',
    hostname: publicHostname(config, id, 'secure'),
    guestIp: '10.200.0.2',
    guestPort: 8443,
  },
  {
    index: 2,
    kind: 'tcp-ssl',
    hostname: publicHostname(config, id, 'tls'),
    guestIp: '10.200.0.2',
    guestPort: 9443,
  },
]

describe('publicHostname', () => {
  test('is <hostPrefix>-<first 10 of instanceId>.<httpDomain>', () => {
    expect(hostname).toBe(`baby-rev-${id.slice(0, 10)}.fc7.ctf.example.com`)
  })

  test('rejects every character that could break a Traefik rule', () => {
    for (const prefix of [
      'bad`tick',
      'bad space',
      'bad"quote',
      "bad'quote",
      'UPPER',
      '-leading',
      'trailing-',
      'x'.repeat(64),
      'semi;colon',
    ]) {
      expect(() => publicHostname(config, id, prefix)).toThrow('invalid')
    }
    expect(() => publicHostname(config, 'not-an-id', 'ok')).toThrow()
    expect(() =>
      publicHostname({ httpDomain: 'evil`domain.example' }, id, 'ok')
    ).toThrow('invalid')
  })
})

describe('renderTraefikFile', () => {
  test('renders http, https and tcp-ssl routers for the configured entrypoints', () => {
    const text = renderTraefikFile(id, routes, config)
    expect(text).toContain(`Host(\`${hostname}\`)`)
    expect(text).toContain('entryPoints:')
    expect(text).toContain('- web')
    expect(text).toContain('- secure')
    expect(text).toContain('- tcps')
    expect(text).toContain(`HostSNI(\`${routes[2]?.hostname}\`)`)
    expect(text).toContain('certResolver: le-wildcard')
    expect(text).toContain('url: http://10.200.0.2:8080')
    expect(text).toContain('url: http://10.200.0.2:8443')
    expect(text).toContain('address: 10.200.0.2:9443')
  })

  test('omits certResolver but keeps TLS enabled when not configured', () => {
    const text = renderTraefikFile(id, routes, {
      ...config,
      certResolver: undefined,
    })
    expect(text).toContain('tls: {}')
    expect(text).not.toContain('certResolver')
  })

  test('is deterministic in expose order', () => {
    expect(renderTraefikFile(id, routes, config)).toBe(
      renderTraefikFile(id, [...routes], config)
    )
  })

  test('rejects malicious rule/hostname/service values', () => {
    expect(() =>
      renderTraefikFile(
        id,
        [
          {
            index: 0,
            kind: 'http',
            hostname: 'x.example.com`)}`',
            guestIp: '10.200.0.2',
            guestPort: 8080,
          },
        ],
        config
      )
    ).toThrow('invalid hostname')
    expect(() =>
      renderTraefikFile(
        id,
        [
          {
            index: 0,
            kind: 'http',
            hostname,
            guestIp: '10.200.0.2; drop',
            guestPort: 8080,
          },
        ],
        config
      )
    ).toThrow('invalid IPv4')
    expect(() =>
      renderTraefikFile(
        id,
        [
          {
            index: 0,
            kind: 'tcp',
            hostname,
            guestIp: '10.200.0.2',
            guestPort: 1,
          },
        ],
        config
      )
    ).toThrow('not a Traefik route')
    expect(() =>
      renderTraefikFile(
        id,
        [routes[0] as TraefikRoute, { ...(routes[0] as TraefikRoute) }],
        config
      )
    ).toThrow('duplicate')
    expect(() => renderTraefikFile(id, [], config)).toThrow('empty')
  })
})

describe('TraefikFileManager', () => {
  test('writes atomically with mode 0644, overwrites and removes', async () => {
    const localConfig = await makeTempConfig()
    const manager = new TraefikFileManager(localConfig)
    await manager.write(id, [routes[0] as TraefikRoute])
    const path = join(localConfig.traefikDynamicDir, traefikFileName(id))
    expect((await stat(path)).mode & 0o777).toBe(0o644)
    expect(await readFile(path, 'utf8')).toContain(`Host(\`${hostname}\`)`)

    await manager.write(id, [routes[1] as TraefikRoute])
    const text = await readFile(path, 'utf8')
    expect(text).toContain('- websecure')
    expect(text).toContain('tls:')
    expect(text).not.toContain('Host(`baby-rev')
    expect((await readdir(localConfig.traefikDynamicDir)).sort()).toEqual([
      traefikFileName(id),
    ])

    await manager.remove(id)
    await manager.remove(id) // idempotent
    expect(await readdir(localConfig.traefikDynamicDir)).toEqual([])
  })

  test('lists instance files and removes only unknown orphans', async () => {
    const localConfig = await makeTempConfig()
    const manager = new TraefikFileManager(localConfig)
    const known = instanceId(1)
    const orphan = instanceId(2)
    await manager.write(known, [routes[0] as TraefikRoute])
    await manager.write(orphan, [routes[0] as TraefikRoute])
    await writeFile(
      join(localConfig.traefikDynamicDir, 'unrelated.yml'),
      'http: {}\n'
    )
    await writeFile(
      join(localConfig.traefikDynamicDir, `.rctf-fc-${known}.yml.tmp`),
      'stale'
    )

    expect((await manager.list()).sort()).toEqual([known, orphan].sort())
    const removed = await manager.removeOrphans(new Set([known]))
    expect(removed).toEqual([`traefik:${orphan}`])
    const entries = await readdir(localConfig.traefikDynamicDir)
    expect(entries.sort()).toEqual(
      [traefikFileName(known), 'unrelated.yml'].sort()
    )
  })
})
