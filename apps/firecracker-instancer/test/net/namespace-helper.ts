/**
 * Runs INSIDE `unshare -Urn` (spawned by namespace.test.ts): real ip/nft in an
 * unprivileged private network namespace. Prints one JSON line.
 */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetworkManager } from '../../src/agent/net'
import { bunCommandRunner } from '../../src/util/exec'
import { instanceId, makeConfig } from './support'

const root = await mkdtemp(join(tmpdir(), 'rctf-fc-netns-'))
const traefikDynamicDir = join(root, 'traefik')
await mkdir(traefikDynamicDir, { recursive: true })
const config = makeConfig({
  subnetPool: '198.51.100.0/24',
  externalInterface: 'lo',
  traefikDynamicDir,
  quarantineFile: join(root, 'net-quarantine.json'),
  requireConntrack: false,
})
const manager = createNetworkManager(config, { runner: bunCommandRunner })

// A foreign dummy named like a tap. It has no alias and the wrong link type.
await bunCommandRunner.run(['ip', 'link', 'add', 'fctap9', 'type', 'dummy'])
await bunCommandRunner.run(['ip', 'link', 'set', 'dev', 'fctap9', 'up'])

const restored = (await manager.restore([])) as {
  removedOrphans: string[]
  keptOrphans: string[]
  skippedLeases: string[]
}
const dummy = await bunCommandRunner.run([
  'ip',
  '-d',
  '-o',
  'link',
  'show',
  'dev',
  'fctap9',
])

const lease = await manager.allocate({
  instanceId: instanceId(1),
  egress: false,
  expose: [],
})
const link = await bunCommandRunner.run([
  'ip',
  '-d',
  '-o',
  'link',
  'show',
  'dev',
  lease.tapName,
])
const alias = /\balias\s+([^\s\\]+)/.exec(link.stdout)?.[1]
const tapType = /\btun\s+type\s+tap\b/.test(link.stdout)

await manager.release(lease.instanceId)
const gone = await bunCommandRunner.run([
  'ip',
  '-o',
  'link',
  'show',
  'dev',
  lease.tapName,
])

console.log(
  JSON.stringify({
    keptOrphans: restored.keptOrphans,
    dummyExists: dummy.code === 0,
    alias,
    tapType,
    tapGone: gone.code !== 0,
    released: true,
  })
)
