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
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

// Persisted so the restart simulation can construct a NEW manager in a NEW bun
// process with exactly this configuration (including the quarantine file).
const configPath = `${RUN}/lifecycle/config.json`
writeFileSync(configPath, JSON.stringify(config))

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
interface CmdText {
  code: number
  out: string
  ok: boolean
  error: string
}
/**
 * Run a read-only command and keep its exit status.
 *
 * A non-zero status is never swallowed: `ok` is false unless the caller
 * explicitly allows the one expected "table is already gone" case after
 * teardown. Every check below fails on !ok, so a failed nft/conntrack listing
 * cannot look like a clean host.
 */
const text = async (
  argv: string[],
  options: { allowMissingTable?: boolean } = {}
): Promise<CmdText> => {
  const result = await run(argv, { timeoutMs: 20_000 })
  const out = `${result.stdout}\n${result.stderr}`
  const missingTable = /No such file or directory|does not exist/i.test(out)
  const ok =
    result.code === 0 ||
    (options.allowMissingTable === true && result.code === 1 && missingTable)
  const first = out.trim().split('\n')[0] ?? ''
  return {
    code: result.code,
    out,
    ok,
    error: ok ? '' : `exit ${result.code}: ${first}`,
  }
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
  const isTap = link.ok && /\btun\s+type\s+tap\b/.test(link.out)
  const alias = link.ok && /\balias\s+(rctf-fc:rctf-fc)\b/.test(link.out)
  if (!isTap || !alias) tapsOk = false
  tapDetail.push(
    `${lease.tapName}:${isTap ? 'tap' : 'NOT-TAP'}${alias ? '+alias' : '-NO-ALIAS'}${
      link.ok ? '' : ` (${link.error})`
    }`
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
const dnatLines = inet.out
  .split('\n')
  .filter(line => line.includes('dnat ip to'))
const allGuests = leases.every(lease =>
  inet.out.includes(`ip saddr != ${lease.guestIp} drop`)
)
const allArp = leases.every(lease =>
  arp.out.includes(`iifname "${lease.tapName}"`)
)
const allPorts = leases.every(lease =>
  Object.values(lease.publicPorts).every(port =>
    dnatLines.some(line => line.includes(`tcp dport ${port} dnat`))
  )
)
check(
  '8.3',
  inet.ok &&
    arp.ok &&
    dnatLines.length === tcpCount &&
    allGuests &&
    allArp &&
    allPorts,
  `${dnatLines.length}/${tcpCount} DNAT rules, anti-spoof for all 10, ARP rules for all 10 taps` +
    (inet.ok ? '' : `; nft inet failed (${inet.error})`) +
    (arp.ok ? '' : `; nft arp failed (${arp.error})`)
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
const entriesBefore = beforeRelease.ok
  ? leases.filter(lease => beforeRelease.out.includes(lease.guestIp)).length
  : -1
check(
  '8.5',
  beforeRelease.ok && entriesBefore === N,
  beforeRelease.ok
    ? `conntrack saw ${entriesBefore}/${N} DNAT flows before release (real mappings)`
    : `conntrack -L failed: ${beforeRelease.error}`
)

for (const lease of leases) await manager.release(lease.instanceId)

const linksAfter = await text(['ip', '-o', 'link', 'show'])
const tapsAfter = linksAfter.out
  .split('\n')
  .filter(line => /: fctap\d+[:,]/.test(line))
// After teardown a missing table is acceptable (and reported); any other
// non-zero nft status is a failure, not a "clean" host.
const inetAfter = await text(['nft', 'list', 'table', 'inet', 'rctf_fc'], {
  allowMissingTable: true,
})
const arpAfter = await text(['nft', 'list', 'table', 'arp', 'rctf_fc_arp'], {
  allowMissingTable: true,
})
const leftovers =
  inetAfter.out.includes('dnat') ||
  inetAfter.out.includes('masquerade') ||
  leases.some(
    lease =>
      inetAfter.out.includes(lease.guestIp) ||
      inetAfter.out.includes(lease.tapName)
  ) ||
  leases.some(lease => arpAfter.out.includes(lease.tapName))
const tableDetail = `inet=${
  inetAfter.code === 0 ? 'present' : 'absent (expected after teardown)'
} arp=${arpAfter.code === 0 ? 'present' : 'absent (expected after teardown)'}`
const traefikAfter = (() => {
  try {
    return readdirSync(traefikDir)
  } catch {
    return ['<missing dir>']
  }
})()
check(
  '8.6',
  linksAfter.ok &&
    inetAfter.ok &&
    arpAfter.ok &&
    tapsAfter.length === 0 &&
    !leftovers &&
    traefikAfter.length === 0,
  `after release: ${tapsAfter.length} taps left${
    linksAfter.ok ? '' : ` (ip failed: ${linksAfter.error})`
  }, rules clean=${!leftovers}, traefik entries=${traefikAfter.length}; ${tableDetail}` +
    (inetAfter.ok ? '' : `; nft inet failed (${inetAfter.error})`) +
    (arpAfter.ok ? '' : `; nft arp failed (${arpAfter.error})`)
)

const afterRelease = await text(['conntrack', '-L'])
const stale = afterRelease.ok
  ? leases.filter(lease => afterRelease.out.includes(lease.guestIp))
  : leases
check(
  '8.7',
  afterRelease.ok && stale.length === 0,
  afterRelease.ok
    ? `release flushed every conntrack entry (${stale.length} guest addresses still present)`
    : `conntrack -L failed: ${afterRelease.error}`
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

// Restart-like recovery: a FRESH manager in a FRESH bun process (its
// constructor loads the quarantine file from disk, then restore([]) runs) must
// not hand a released /30 or port straight back out. Using the already-running
// manager would hide a regression where startup ignores the persisted file.
interface FreshLease {
  tapName: string
  guestIp: string
  publicPorts: Record<string, number>
}
const runFreshManager = async (
  instanceId: string,
  quarantineOverride?: string
): Promise<{ code: number; lease?: FreshLease; text: string }> => {
  const argv = [
    process.execPath,
    `${EDGE}/lib/lifecycle-restart.ts`,
    configPath,
    instanceId,
  ]
  if (quarantineOverride !== undefined) argv.push(quarantineOverride)
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const text = `${stdout.trim()}\n${stderr.trim()}`.trim()
  try {
    const parsed = JSON.parse(
      stdout.trim().split('\n').pop() ?? ''
    ) as FreshLease
    if (typeof parsed.tapName !== 'string') throw new Error('bad shape')
    return { code, lease: parsed, text }
  } catch {
    return { code, text }
  }
}

const normal = await runFreshManager(`life${'1'.repeat(12)}`)
const normalPort =
  normal.lease === undefined
    ? undefined
    : Object.values(normal.lease.publicPorts)[0]
check(
  '8.9',
  normal.code === 0 &&
    normal.lease !== undefined &&
    normalPort !== undefined &&
    !releasedIndexes.has(Number(normal.lease.tapName.slice('fctap'.length))) &&
    !releasedPorts.has(normalPort),
  normal.lease === undefined
    ? `fresh-process restart simulation failed (exit ${normal.code}): ${normal.text}`
    : `post-restart allocation in a fresh process honours the on-disk quarantine: ${
        normal.lease.tapName
      } ${normal.lease.guestIp} port ${normalPort}`
)

// Mutation: the same fresh process pointed at a quarantine file that does not
// exist must hand back a released index or port. That proves 8.9 is sensitive
// to the persisted quarantine (a startup that ignores it cannot pass).
const ignoredQuarantine = `${RUN}/lifecycle/ignored-quarantine.json`
const mutation = await runFreshManager(
  `life${'2'.repeat(12)}`,
  ignoredQuarantine
)
const mutationPort =
  mutation.lease === undefined
    ? undefined
    : Object.values(mutation.lease.publicPorts)[0]
const mutationReused =
  mutation.lease !== undefined &&
  mutationPort !== undefined &&
  (releasedIndexes.has(Number(mutation.lease.tapName.slice('fctap'.length))) ||
    releasedPorts.has(mutationPort))
check(
  '8.10',
  mutation.code === 0 && mutationReused,
  mutation.lease === undefined
    ? `mutation control failed to run (exit ${mutation.code}): ${mutation.text}`
    : `mutation control: a fresh manager that cannot see the quarantine file DOES reuse ${
        mutation.lease.tapName
      } port ${mutationPort}, so 8.9 is sensitive to the persisted state`
)

console.log(`RESULT lifecycle: ${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
