/**
 * Check 8: many concurrent instances through the REAL NetworkManager.
 *
 * Ten leases allocated concurrently (one also gets an http expose so the
 * Traefik file path is exercised), published, then released. Asserts distinct
 * /30s, real tun/tap devices with the ownership alias, one DNAT rule per tcp
 * expose, real conntrack entries created through DNAT and flushed by release,
 * a completely clean host afterwards, and a durable reuse quarantine that a
 * restart cannot forget.
 *
 * Runs inside a throwaway network namespace; the "outside client" used to
 * create the conntrack entries is a veth peer in a child netns (its pid comes
 * from OUTSIDE_PID).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createNetworkManager } from '../../../../apps/firecracker-instancer/src/agent/net'
import { bunCommandRunner } from '../../../../apps/firecracker-instancer/src/util/exec'
const run = (argv: string[], options?: { timeoutMs?: number }) =>
  bunCommandRunner.run(argv, options)

const RUN = process.env['RUN']
const EDGE = process.env['EDGE']
const OUTSIDE_PID = process.env['OUTSIDE_PID']
if (!RUN || !EDGE || !OUTSIDE_PID) {
  throw new Error('RUN, EDGE and OUTSIDE_PID are required')
}

const traefikDir = `${RUN}/lifecycle/traefik`
const quarantineFile = `${RUN}/lifecycle/net-quarantine.json`
const config = {
  publicHost: '203.0.113.1',
  httpDomain: 'life.test',
  httpPort: 8088,
  httpsPort: 8443,
  tcpSslPort: 8443,
  tcpPortRange: { from: 25000, to: 25099 },
  subnetPool: '10.201.0.0/16',
  traefikDynamicDir: traefikDir,
  reuseQuarantineSeconds: 120,
  requireConntrack: true,
  externalInterface: 'ext0',
  ownerMarker: 'rctf-fc',
  quarantineFile,
  httpEntrypoint: 'web',
  httpsEntrypoint: 'websecure',
  tcpSslEntrypoint: 'websecure',
}

let passes = 0
let failures = 0
const check = (id: string, ok: boolean, detail: string): void => {
  if (ok) {
    passes += 1
    console.log(`CHECK ${id} PASS ${detail}`)
  } else {
    failures += 1
    console.log(`CHECK ${id} FAIL ${detail}`)
  }
}
const text = async (argv: string[]): Promise<string> => {
  const result = await run(argv, { timeoutMs: 20_000 })
  return `${result.stdout}\n${result.stderr}`
}

const manager = createNetworkManager(config as never, {
  runner: bunCommandRunner,
})
await manager.restore([])

const N = 10
const ids = Array.from(
  { length: N },
  (_, i) => `life${String(i).padStart(2, '0')}${'x'.repeat(11)}`
)
const requests = ids.map((instanceId, i) => ({
  instanceId,
  egress: i % 2 === 0,
  expose:
    i === 0
      ? [
          { kind: 'tcp' as const, hostPrefix: 'raw0', port: 8080 },
          { kind: 'http' as const, hostPrefix: 'web0', port: 8080 },
        ]
      : [{ kind: 'tcp' as const, hostPrefix: `svc${i}`, port: 8080 }],
}))

// All ten concurrently: the manager serialises internally, allocation must still
// be unique and every lease must be visible.
const leases = await Promise.all(requests.map(req => manager.allocate(req)))
const releasedIndexes = new Set<number>()
const releasedPorts = new Set<number>()
for (const lease of leases) {
  releasedIndexes.add(Number(lease.tapName.slice('fctap'.length)))
  for (const port of Object.values(lease.publicPorts)) releasedPorts.add(port)
}

check(
  '8.1',
  new Set(leases.map(l => l.guestIp)).size === N &&
    new Set(leases.map(l => l.hostIp)).size === N &&
    new Set(leases.map(l => l.tapName)).size === N,
  `10 distinct /30s and taps: ${leases.map(l => `${l.tapName}=${l.guestIp}`).join(' ')}`
)

let tapsOk = true
const tapDetail: string[] = []
for (const lease of leases) {
  const link = await text([
    'ip',
    '-d',
    '-o',
    'link',
    'show',
    'dev',
    lease.tapName,
  ])
  const isTap = /\btun\s+type\s+tap\b/.test(link)
  const alias = /\balias\s+(rctf-fc:rctf-fc)\b/.test(link)
  if (!isTap || !alias) tapsOk = false
  tapDetail.push(
    `${lease.tapName}:${isTap ? 'tap' : 'NOT-TAP'}${alias ? '+alias' : '-NO-ALIAS'}`
  )
}
check(
  '8.2',
  tapsOk,
  `real tun/tap with ownership alias: ${tapDetail.join(' ')}`
)

await Promise.all(leases.map(lease => manager.publish(lease, lease.expose)))

const inet = await text(['nft', 'list', 'table', 'inet', 'rctf_fc'])
const arp = await text(['nft', 'list', 'table', 'arp', 'rctf_fc_arp'])
const tcpCount = requests.reduce(
  (sum, req) => sum + req.expose.filter(e => e.kind === 'tcp').length,
  0
)
const dnatLines = inet.split('\n').filter(line => line.includes('dnat ip to'))
const allGuests = leases.every(lease =>
  inet.includes(`ip saddr != ${lease.guestIp} drop`)
)
const allArp = leases.every(lease => arp.includes(`iifname "${lease.tapName}"`))
const allPorts = leases.every(lease =>
  Object.values(lease.publicPorts).every(port =>
    dnatLines.some(line => line.includes(`tcp dport ${port} dnat`))
  )
)
check(
  '8.3',
  dnatLines.length === tcpCount && allGuests && allArp && allPorts,
  `${dnatLines.length}/${tcpCount} DNAT rules, anti-spoof for all 10, ARP rules for all 10 taps`
)

const traefikFile = `${traefikDir}/rctf-fc-${ids[0]}.yml`
const traefikText = (() => {
  try {
    return readFileSync(traefikFile, 'utf8')
  } catch {
    return ''
  }
})()
check(
  '8.4',
  traefikText.includes(`Host(\`web0-${ids[0]!.slice(0, 20)}.life.test\`)`),
  `per-instance Traefik file written for the http expose (${traefikFile})`
)

// Real conntrack entries through DNAT: a SYN from the outside netns creates an
// UNREPLIED entry whose reply tuple carries the guest address.
const synPromises: Promise<unknown>[] = []
for (const lease of leases) {
  for (const port of Object.values(lease.publicPorts)) {
    synPromises.push(
      run(
        [
          'nsenter',
          '-t',
          OUTSIDE_PID,
          '-n',
          'python3',
          `${EDGE}/lib/connect_once.py`,
          '203.0.113.1',
          String(port),
        ],
        { timeoutMs: 10_000 }
      )
    )
  }
}
await Promise.all(synPromises)
await Bun.sleep(500)
const beforeRelease = await text(['conntrack', '-L'])
const entriesBefore = leases.filter(lease =>
  beforeRelease.includes(lease.guestIp)
).length
check(
  '8.5',
  entriesBefore === N,
  `conntrack saw ${entriesBefore}/${N} DNAT flows before release (real mappings)`
)

for (const lease of leases) await manager.release(lease.instanceId)

const linksAfter = await text(['ip', '-o', 'link', 'show'])
const tapsAfter = linksAfter
  .split('\n')
  .filter(line => /: fctap\d+[:,]/.test(line))
const inetAfter = await text(['nft', 'list', 'table', 'inet', 'rctf_fc'])
const arpAfter = await text(['nft', 'list', 'table', 'arp', 'rctf_fc_arp'])
const leftovers =
  inetAfter.includes('dnat') ||
  inetAfter.includes('masquerade') ||
  leases.some(
    lease =>
      inetAfter.includes(lease.guestIp) || inetAfter.includes(lease.tapName)
  ) ||
  leases.some(lease => arpAfter.includes(lease.tapName))
const traefikAfter = (() => {
  try {
    return readdirSync(traefikDir)
  } catch {
    return ['<missing dir>']
  }
})()
check(
  '8.6',
  tapsAfter.length === 0 && !leftovers && traefikAfter.length === 0,
  `after release: ${tapsAfter.length} taps left, rules clean=${!leftovers}, traefik entries=${traefikAfter.length}`
)

const afterRelease = await text(['conntrack', '-L'])
const stale = leases.filter(lease => afterRelease.includes(lease.guestIp))
check(
  '8.7',
  stale.length === 0,
  `release flushed every conntrack entry (${stale.length} guest addresses still present)`
)

let quarantineOk = false
let quarantineDetail = ''
try {
  const parsed = JSON.parse(readFileSync(quarantineFile, 'utf8')) as {
    indexes: { id: number; expiresAtMs: number }[]
    ports: { id: number; expiresAtMs: number }[]
  }
  const now = Date.now()
  const indexes = new Set(parsed.indexes.map(entry => entry.id))
  const ports = new Set(parsed.ports.map(entry => entry.id))
  const expiryOk = [...parsed.indexes, ...parsed.ports].every(
    e => e.expiresAtMs > now
  )
  quarantineOk =
    [...releasedIndexes].every(index => indexes.has(index)) &&
    [...releasedPorts].every(port => ports.has(port)) &&
    expiryOk
  quarantineDetail = `${parsed.indexes.length} /30 indexes + ${parsed.ports.length} ports quarantined, expiries in the future=${expiryOk}`
} catch (error) {
  quarantineDetail = `could not read quarantine file: ${String(error)}`
}
check('8.8', quarantineOk, quarantineDetail)

// Restart-like recovery: a new manager instance (restore([])) must load the
// durable quarantine and not hand a released /30 or port straight back out.
await manager.restore([])
const reuse = await manager.allocate({
  instanceId: `life${'y'.repeat(12)}`,
  egress: false,
  expose: [{ kind: 'tcp', hostPrefix: 'reuse', port: 8080 }],
})
const reusePort = Object.values(reuse.publicPorts)[0]!
check(
  '8.9',
  !releasedIndexes.has(Number(reuse.tapName.slice('fctap'.length))) &&
    !releasedPorts.has(reusePort),
  `post-restart allocation honours quarantine: ${reuse.tapName} ${reuse.guestIp} port ${reusePort}`
)
await manager.release(reuse.instanceId)

console.log(`RESULT lifecycle: ${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
