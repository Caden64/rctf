#!/usr/bin/env bun
/**
 * Multi-host end-to-end verification for the Firecracker instancer.
 *
 * Topology (see ../README.md):
 *
 *   this unprivileged machine
 *     ├── real provider code (imported) ── HTTP ──┐
 *     ├── ssh observation ────────────────────────┼──> host-a VM (QEMU, nested KVM)
 *     │                                           │      controller (real, bun:sqlite)
 *     │                                           │      agent host-a under systemd, JAILER mode
 *     │                                           │      real Firecracker guests
 *     └── ssh observation ────────────────────────┴──> host-b VM (QEMU, nested KVM)
 *                                                         agent host-b under systemd, JAILER mode
 *                                                         real Firecracker guests
 *
 * host-a and host-b share a point-to-point Ethernet link (QEMU -netdev dgram
 * over two AF_UNIX sockets under the run directory) 10.77.0.0/24; the link has
 * no multicast group, no UDP/TCP socket and no host interface, so its traffic
 * cannot leave this machine. The controller and agents speak real HTTP with
 * real per-host bearer tokens.
 *
 * Every assertion here is a real invariant, not a log mirror: instances are
 * observed directly on each agent, guest flags are fetched from the guests,
 * and the controller SQLite is read for ownership/pinning.
 */
import { lstatSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import FirecrackerInstancerProvider from '../../../apps/api/src/providers/instancer/firecracker-instancer'
import type { CreateInstanceOptions } from '../../../apps/api/src/providers/instancer/base'
import {
  Report,
  errorMessage,
  httpRequest,
  must,
  shell,
  short,
  sleep,
  waitFor,
  waitForTrue,
} from '../e2e/harness'

// ---------------------------------------------------------------------------
// Environment / constants
// ---------------------------------------------------------------------------

const RUN = must(process.env.MH_RUN, 'MH_RUN')
const REPO = must(process.env.MH_REPO, 'MH_REPO')
const ARTIFACTS = must(process.env.MH_ARTIFACTS, 'MH_ARTIFACTS')
const CONTROLLER = must(process.env.CONTROLLER_URL, 'CONTROLLER_URL')
const SECRETS_FILE = must(process.env.MH_SECRETS_FILE, 'MH_SECRETS_FILE')

const A = 'host-a'
const B = 'host-b'
const A_IP = must(process.env.HOST_A_IP, 'HOST_A_IP')
const B_IP = must(process.env.HOST_B_IP, 'HOST_B_IP')
const A_SSH = Number(must(process.env.HOST_A_SSH_PORT, 'HOST_A_SSH_PORT'))
const B_SSH = Number(must(process.env.HOST_B_SSH_PORT, 'HOST_B_SSH_PORT'))
const LINK_DIR = must(process.env.MH_LINK_DIR, 'MH_LINK_DIR')
const LINK_A = must(process.env.MH_LINK_A, 'MH_LINK_A')
const LINK_B = must(process.env.MH_LINK_B, 'MH_LINK_B')
const A_MAC_PRIV = '52:54:00:77:0a:01'
const B_MAC_PRIV = '52:54:00:77:0b:01'

const VMCTL = path.join(REPO, 'deploy/firecracker/multihost/vm.sh')
const LOGS = path.join(RUN, 'logs')
const RESULTS_JSON = path.join(RUN, 'results.json')
const ASSERTIONS_LOG = path.join(LOGS, 'assertions.log')

const CONTROLLER_YAML = '/home/ubuntu/mh-controller/controller.yaml'
const CONTROLLER_ENV = '/home/ubuntu/mh-controller/controller.env'
const BADTOKEN_ENV = '/home/ubuntu/mh-controller/badtoken.env'
const DB_PATH = '/home/ubuntu/mh-controller/controller.sqlite'
const AGENT_STATE_DIR = '/var/lib/rctf-firecracker/state'

const CHAL = 'fc-mh'
const CHAL2 = 'fc-mh-2'

const secrets = Object.fromEntries(
  readFileSync(SECRETS_FILE, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(line => {
      const eq = line.indexOf('=')
      return [line.slice(0, eq), line.slice(eq + 1)]
    })
)
const API_TOKEN = must(secrets.MH_API_TOKEN, 'MH_API_TOKEN')
const ADMIN_TOKEN = must(secrets.MH_ADMIN_TOKEN, 'MH_ADMIN_TOKEN')

const report = new Report(ASSERTIONS_LOG)

const ipOf = (host: string): string => {
  if (host === A) return A_IP
  if (host === B) return B_IP
  throw new Error(`unknown host ${host}`)
}

const sshPortOf = (host: string): number => (host === A ? A_SSH : B_SSH)

// ---------------------------------------------------------------------------
// Remote execution
// ---------------------------------------------------------------------------

interface RemoteResult {
  code: number
  stdout: string
  stderr: string
}

const remote = (
  host: string,
  command: string,
  timeoutMs = 120_000
): RemoteResult =>
  shell(
    [
      VMCTL,
      '--name',
      host,
      '--ssh-port',
      String(sshPortOf(host)),
      'ssh',
      command,
    ],
    timeoutMs
  )

const remoteOut = (
  host: string,
  command: string,
  timeoutMs = 120_000
): string => {
  const result = remote(host, command, timeoutMs)
  if (result.code !== 0) {
    throw new Error(
      `${host}: remote command failed (${result.code}): ${result.stderr.trim() || result.stdout.slice(-400)}`
    )
  }
  return result.stdout.trim()
}

const remoteSoft = (host: string, command: string): string => {
  const result = remote(host, command)
  return result.code === 0 ? result.stdout.trim() : ''
}

const qemuCmdline = (host: string): string =>
  readFileSync(path.join(RUN, 'vms', host, 'qemu.cmdline'), 'utf8')

/** Every argument that follows a `-netdev` in a recorded QEMU command line. */
const netdevArgs = (cmdline: string): string[] => {
  const lines = cmdline.split('\n')
  return lines.flatMap((line, index) =>
    line === '-netdev' ? [lines[index + 1] ?? ''] : []
  )
}

const privateIfaceCommand = (ip: string): string =>
  `ip -4 -o addr show | awk -v ip='${ip}/24' '$4 == ip { gsub(":", "", $2); print $2; exit }'`

const controllerLogTail = (variant = 'normal', lines = 20): string => {
  try {
    return remoteOut(
      A,
      `tail -n ${lines} /home/ubuntu/mh-controller/controller-${variant}.log 2>/dev/null || true`
    )
  } catch {
    return '<no controller log>'
  }
}

// ---------------------------------------------------------------------------
// Agent observations (real per-host bearer token)
// ---------------------------------------------------------------------------

interface AgentInstance {
  id: string
  state: string
  message?: string
  createdAtMs: number
  expiresAtMs: number
  endpoints: Array<{ kind: string; host: string; port: number }>
  specHash: string
}

interface AgentHttp {
  status: number
  text: string
  json: unknown
}

const agentRequest = async (
  host: string,
  method: string,
  pathname: string,
  body?: unknown
): Promise<AgentHttp> => {
  const data =
    body === undefined
      ? ''
      : `--data-binary '${JSON.stringify(body).replaceAll("'", "'\\''")}'`
  const command =
    `TOKEN=$(cat /home/ubuntu/.mh-agent-token); ` +
    `curl -sS -m 20 -X ${method} -H "Authorization: Bearer $TOKEN" ` +
    `-H "Content-Type: application/json" ${data} ` +
    `-w '\\n%{http_code}' http://${ipOf(host)}:7001${pathname}`
  const result = remote(host, command, 30_000)
  const raw = result.stdout
  const split = raw.lastIndexOf('\n')
  const text = split === -1 ? raw : raw.slice(0, split)
  const status = split === -1 ? 0 : Number(raw.slice(split + 1).trim())
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: Number.isFinite(status) ? status : 0, text, json }
}

const agentList = async (host: string): Promise<AgentInstance[]> => {
  const result = await agentRequest(host, 'GET', '/v1/instances')
  if (result.status !== 200 || !Array.isArray(result.json)) {
    throw new Error(
      `agent ${host} list -> ${result.status}: ${short(result.text)}`
    )
  }
  return result.json as AgentInstance[]
}

const agentDelete = async (host: string, id: string): Promise<number> => {
  const result = await agentRequest(host, 'DELETE', `/v1/instances/${id}`)
  return result.status
}

const agentInfo = async (
  host: string
): Promise<{
  hostId?: string
  accepting?: boolean
  recovered?: boolean
  checks?: Record<string, boolean>
  timeMs?: number
  capacity?: Record<string, number>
  usage?: Record<string, number>
}> => {
  const result = await agentRequest(host, 'GET', '/v1/info')
  if (result.status !== 200 || typeof result.json !== 'object') {
    throw new Error(
      `agent ${host} info -> ${result.status}: ${short(result.text)}`
    )
  }
  return result.json as never
}

interface HostStats {
  httpCode: number
  agent: string
  info: {
    hostId?: string
    accepting?: boolean
    recovered?: boolean
    checks?: Record<string, boolean>
    timeMs?: number
  } | null
  firecrackerProcs: number
  taps: number
  stateRecords: number
  stateRunning: number
  nftLeaseRules: number
  instances: AgentInstance[] | null
  /** Producer failures reported by hoststats.sh (values are -1 as well). */
  observationErrors?: string[]
}

const HOSTSTATS_COUNTERS = [
  'firecrackerProcs',
  'taps',
  'stateRecords',
  'stateRunning',
  'nftLeaseRules',
] as const

/**
 * Read hoststats.sh and reject an observation failure marker.
 *
 * A failed `pgrep`/`ip`/`find`/`nft` in hoststats.sh reports -1 (and names the
 * field in observationErrors). That is NOT "zero leaked processes": treating it
 * as one would let every absence assertion pass vacuously. Callers either
 * retry (probe*) or fail; none may see a zero they did not observe.
 */
const hostStats = (host: string): HostStats => {
  const stats = JSON.parse(
    remoteOut(
      host,
      `sudo bash /opt/rctf-firecracker/deploy/firecracker/multihost/hoststats.sh ${ipOf(host)}`
    )
  ) as HostStats
  const failed = new Set(stats.observationErrors ?? [])
  for (const field of HOSTSTATS_COUNTERS) {
    const value = stats[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      failed.add(field)
    }
  }
  if (failed.size > 0) {
    throw new Error(
      `host observation failed on ${host}: ${[...failed].join(', ')} (counts were not observed, not zero)`
    )
  }
  return stats
}

// --- fail-closed probes ----------------------------------------------------
//
// Every negative assertion below ("the VM is gone", "the port is closed")
// must be based on a definitive observation. A failed ssh/curl is a probe
// error, never proof of absence: these helpers keep the two apart so a broken
// probe fails the assertion instead of passing it vacuously.

interface StatsProbe {
  ok: boolean
  stats?: HostStats
  error?: string
}

const probeHostStats = (host: string): StatsProbe => {
  try {
    const stats = hostStats(host)
    if (stats.httpCode !== 200) {
      return { ok: false, error: `agent HTTP ${stats.httpCode}` }
    }
    if (!Array.isArray(stats.instances)) {
      return { ok: false, error: 'agent instance list was null' }
    }
    return { ok: true, stats }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

interface StateProbe {
  ok: boolean
  exists?: boolean
  record?: Record<string, unknown>
  error?: string
}

/** Tri-state probe of the agent's per-instance state file. */
const probeAgentState = (host: string, id: string): StateProbe => {
  const file = `${AGENT_STATE_DIR}/${id}.json`
  const result = remote(
    host,
    `sudo sh -c 'if [ -f "$1" ]; then echo __PRESENT__; cat "$1"; else echo __ABSENT__; fi' _ '${file}'`
  )
  if (result.code !== 0) {
    return {
      ok: false,
      error: `state probe failed (${result.code}): ${result.stderr.trim() || result.stdout.slice(-200)}`,
    }
  }
  const text = result.stdout
  if (text.startsWith('__ABSENT__')) return { ok: true, exists: false }
  if (!text.startsWith('__PRESENT__')) {
    return {
      ok: false,
      error: `unexpected state probe output: ${short(text, 120)}`,
    }
  }
  const body = text.slice('__PRESENT__'.length).trim()
  try {
    return {
      ok: true,
      exists: true,
      record: JSON.parse(body) as Record<string, unknown>,
    }
  } catch (error) {
    return {
      ok: false,
      error: `unparseable state record: ${errorMessage(error)}`,
    }
  }
}

interface FcProbe {
  ok: boolean
  lines?: string[]
  error?: string
}

/** `pgrep -a -x firecracker` on the host (pid + argv for every guest). */
const probeFirecracker = (host: string): FcProbe => {
  // No `|| true` and no discarded stderr: only pgrep's own exit 1 means "no
  // match". 127 (pgrep missing), 2 (syntax/operating error) or an ssh failure
  // is a probe error and must fail the check, never look like an empty list.
  const result = remote(host, 'pgrep -a -x firecracker')
  if (result.code === 1) return { ok: true, lines: [] }
  if (result.code !== 0) {
    return {
      ok: false,
      error: `pgrep failed (${result.code}): ${result.stderr.trim() || result.stdout.slice(-200) || 'no output'}`,
    }
  }
  return {
    ok: true,
    lines: result.stdout.split('\n').filter(line => line.trim() !== ''),
  }
}

/** Firecracker argv contains `--id <instance id>` (jailer passes it through). */
const fcLineForId = (lines: string[], id: string): string | undefined =>
  lines.find(line => line.includes(`--id ${id}`))

interface PidProbe {
  ok: boolean
  alive?: boolean
  error?: string
}

const probePid = (host: string, pid: number): PidProbe => {
  const result = remote(
    host,
    `if [ -d /proc/${pid} ]; then echo __ALIVE__; else echo __GONE__; fi`
  )
  if (result.code !== 0) {
    return { ok: false, error: `pid probe failed (${result.code})` }
  }
  const out = result.stdout.trim()
  if (out === '__ALIVE__') return { ok: true, alive: true }
  if (out === '__GONE__') return { ok: true, alive: false }
  return { ok: false, error: `unexpected pid probe output: ${short(out, 120)}` }
}

/** True/false when definitive; undefined when the probe itself failed. */
const probeTombstone = (host: string, id: string): boolean | undefined => {
  const file = `${AGENT_STATE_DIR}/tombstones/${id}.json`
  const result = remote(
    host,
    `sudo sh -c 'if [ -f "$1" ]; then echo __YES__; else echo __NO__; fi' _ '${file}'`
  )
  if (result.code !== 0) return undefined
  const out = result.stdout.trim()
  if (out === '__YES__') return true
  if (out === '__NO__') return false
  return undefined
}

const agentState = (
  host: string,
  id: string
): Record<string, unknown> | undefined => {
  const result = remote(
    host,
    `sudo cat ${AGENT_STATE_DIR}/${id}.json 2>/dev/null || true`
  )
  if (result.code !== 0 || result.stdout.trim() === '') return undefined
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>
  } catch {
    return undefined
  }
}

interface Identity {
  pid: number
  tap: string
  guestIp: string
  publicPort: number
}

const requireIdentity = (host: string, id: string): Identity => {
  const record = agentState(host, id)
  if (record === undefined)
    throw new Error(`no agent record for ${id} on ${host}`)
  const vm = record.vm as { pid?: number } | undefined
  const lease = record.lease as
    | {
        tapName?: string
        guestIp?: string
        publicPorts?: Record<string, number>
      }
    | undefined
  if (!vm || !Number.isInteger(vm.pid) || (vm.pid ?? 0) <= 0) {
    throw new Error(`agent record ${id} has no usable vm.pid`)
  }
  if (!lease?.tapName || !lease.guestIp) {
    throw new Error(`agent record ${id} has no lease/tap/guestIp`)
  }
  return {
    pid: vm.pid,
    tap: lease.tapName,
    guestIp: lease.guestIp,
    publicPort: lease.publicPorts?.['0'] ?? 0,
  }
}

const guestFlag = (host: string, guestIp: string): string =>
  remoteOut(host, `curl -sS -m 10 http://${guestIp}:8080/flag.txt`)

/**
 * Prove a live Firecracker process really went through the jailer: it runs as
 * uid 10000, its exe resolves to /firecracker inside the chroot, and
 * /proc/<pid>/root is the instance's jail root (device+inode).
 */
const jailIdentity = (
  host: string,
  id: string
): {
  uid: string
  exe: string
  root: string
  jailRoot: string
  matches: boolean
} => {
  const record = agentState(host, id)
  // vm.jailRoot is not part of the persisted handle schema; in jailer mode the
  // driver derives it deterministically from chrootBase + instance id.
  const jailRoot = `/srv/jailer/firecracker/${id}/root`
  const pid = Number((record?.vm as { pid?: number } | undefined)?.pid ?? 0)
  if (pid <= 0) {
    throw new Error(`no vm.pid in agent record for ${id} on ${host}`)
  }
  // /proc/<pid>/exe and /proc/<pid>/root are ptrace-gated for the jailed uid;
  // the agent unit has CAP_SYS_PTRACE, so read them via sudo.
  const out = remoteOut(
    host,
    `echo uid=$(stat -c %u /proc/${pid}); ` +
      `echo exe=$(sudo readlink /proc/${pid}/exe); ` +
      `echo root=$(sudo stat -Lc '%d:%i' /proc/${pid}/root); ` +
      `echo jail=$(sudo stat -Lc '%d:%i' '${jailRoot}')`
  )
  const field = (name: string): string =>
    out
      .split('\n')
      .find(line => line.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ''
  const root = field('root')
  const jail = field('jail')
  return {
    uid: field('uid'),
    exe: field('exe'),
    root,
    jailRoot: jail,
    matches: root !== '' && root === jail,
  }
}

interface HostHttp {
  ok: boolean
  body: string
  code: number
  /**
   * `ok` = 2xx, `http` = a definitive non-2xx response, `refused`/`timeout` =
   * a definitive connection failure, `probe_error` = the observation itself
   * failed (ssh or an unexpected curl exit). Only the definitive kinds may be
   * used for a negative assertion.
   */
  kind: 'ok' | 'http' | 'refused' | 'timeout' | 'probe_error'
  curlExit: number
  detail: string
}

const httpFromHost = (
  host: string,
  url: string,
  timeoutSeconds = 5
): HostHttp => {
  const result = remote(
    host,
    `curl -sS -m ${timeoutSeconds} -w '\\n%{http_code}' ${url}; ` +
      `printf '\\n__MH_CURL_RC__=%s\\n' $?`,
    30_000
  )
  if (result.code !== 0) {
    return {
      ok: false,
      body: '',
      code: 0,
      kind: 'probe_error',
      curlExit: -1,
      detail: `ssh failed (${result.code}): ${short(result.stderr || result.stdout, 160)}`,
    }
  }
  const lines = result.stdout.replace(/\n$/, '').split('\n')
  const rcLine = (lines.pop() ?? '').trim()
  const match = /^__MH_CURL_RC__=(\d+)$/.exec(rcLine)
  if (match === null) {
    return {
      ok: false,
      body: '',
      code: 0,
      kind: 'probe_error',
      curlExit: -1,
      detail: `unparseable curl exit line: ${short(rcLine, 120)}`,
    }
  }
  const curlExit = Number(match[1])
  const codeText = (lines.pop() ?? '').trim()
  const code = Number(codeText)
  const body = lines.join('\n')
  if (curlExit === 0) {
    const numeric = Number.isFinite(code) ? code : 0
    const ok = numeric >= 200 && numeric < 300
    return {
      ok,
      body,
      code: numeric,
      kind: ok ? 'ok' : 'http',
      curlExit,
      detail: `HTTP ${codeText}`,
    }
  }
  // 7 = couldn't connect, 6 = couldn't resolve, 52/56 = empty reply / reset,
  // 28 = operation timeout. Everything else is not a definitive answer.
  const kind =
    curlExit === 28
      ? 'timeout'
      : [6, 7, 52, 56].includes(curlExit)
        ? 'refused'
        : 'probe_error'
  return {
    ok: false,
    body,
    code: 0,
    kind,
    curlExit,
    detail: `curl exit ${curlExit}`,
  }
}

// ---------------------------------------------------------------------------
// Controller: HTTP API + SQLite observation + process control
// ---------------------------------------------------------------------------

const adminRequest = async (
  method: string,
  pathname: string
): Promise<{ status: number; json: unknown; text: string }> => {
  try {
    const result = await httpRequest(
      `${CONTROLLER}${pathname}`,
      {
        method,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          'content-type': 'application/json',
        },
      },
      15_000
    )
    return { status: result.status, json: result.json, text: result.text }
  } catch (error) {
    return { status: 0, json: undefined, text: errorMessage(error) }
  }
}

interface HostSummary {
  id: string
  url: string
  health: string
  lastSeenMs: number | null
  capacity: {
    vcpus: number
    memMiB: number
    diskMiB: number
    maxInstances: number
  }
  reserved: {
    vcpus: number
    memMiB: number
    diskMiB: number
    instances: number
  }
}

const listHosts = async (): Promise<HostSummary[]> => {
  const result = await adminRequest('GET', '/v1/hosts')
  if (result.status !== 200) {
    throw new Error(`GET /v1/hosts -> ${result.status}: ${short(result.text)}`)
  }
  return ((result.json as { hosts?: HostSummary[] }).hosts ??
    []) as HostSummary[]
}

const hostSummary = async (id: string): Promise<HostSummary | undefined> =>
  (await listHosts()).find(host => host.id === id)

interface DbRow {
  id: string
  state: string
  team_id: string
  challenge_integration_id: string
  host_id: string
  expires_at_ms: number
  created_at_ms: number
  updated_at_ms: number
  message: string | null
  revision: number
  agent_expiry_synced: number
}

interface DbHost {
  id: string
  url: string
  health: string
  accepting: number
  draining: number
  last_seen_ms: number | null
  clock_skew_ms: number
  clock_rtt_ms: number | null
  clock_sampled_at_ms: number | null
  clock_state: string
  reported_vcpus: number | null
  reported_mem_mib: number | null
  reported_max_instances: number | null
}

interface DbSnapshot {
  instances: DbRow[]
  hosts: DbHost[]
}

const dbSnapshot = (): DbSnapshot =>
  JSON.parse(
    remoteOut(
      A,
      `cd /opt/rctf-firecracker && /usr/local/bin/bun deploy/firecracker/multihost/dbdump.ts ${DB_PATH}`
    )
  ) as DbSnapshot

const rows = (): DbRow[] => dbSnapshot().instances
const dbHost = async (id: string): Promise<DbHost | undefined> =>
  dbSnapshot().hosts.find(host => host.id === id)

const rowsFor = (team: string, chal: string): DbRow[] =>
  rows().filter(
    row => row.team_id === team && row.challenge_integration_id === chal
  )

const waitRows = async (
  label: string,
  predicate: (all: DbRow[]) => boolean,
  timeoutMs = 30_000
): Promise<DbRow[]> => waitFor(label, () => rows(), predicate, timeoutMs, 200)

// ---------------------------------------------------------------------------
// Real provider (the rCTF API code path)
// ---------------------------------------------------------------------------

const provider = new FirecrackerInstancerProvider({
  apiUrl: CONTROLLER,
  authToken: API_TOKEN,
  timeoutMilliseconds: 180_000,
})

interface Details {
  kind: 'instancerInstanceDetails'
  status: string
  timeLeftMilliseconds: number | null
  endpoints: Array<{
    kind: string
    host: string
    port: number
    title?: string
    text?: string
  }> | null
}

interface Failure {
  kind: 'instancerError'
  message: string
}

const isDetails = (value: unknown): value is Details =>
  (value as { kind?: string } | undefined)?.kind === 'instancerInstanceDetails'
const isFailure = (value: unknown): value is Failure =>
  (value as { kind?: string } | undefined)?.kind === 'instancerError'

const challengeConfig = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  image: 'smoke',
  vcpus: 1,
  memMiB: 256,
  diskMiB: 128,
  egress: false,
  bootTimeoutSeconds: 120,
  readiness: { kind: 'http', port: 8080, path: '/', expectStatus: 200 },
  env: { CHALLENGE: 'fc-mh' },
  ...overrides,
})

const flags = new Map<string, string>()
const keyOf = (team: string, chal: string): string => `${team}\u0000${chal}`
const flagFor = (team: string, chal: string): string => {
  const key = keyOf(team, chal)
  let flag = flags.get(key)
  if (flag === undefined) {
    flag = `rctf{mh-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}}`
    flags.set(key, flag)
  }
  return flag
}

const create = async (
  team: string,
  chal: string,
  options: { timeoutMs?: number; config?: Record<string, unknown> } = {}
): Promise<Details | Failure> =>
  (await provider.createInstance({
    user: { id: team },
    challengeIntegrationId: chal,
    config: challengeConfig(options.config ?? {}),
    expose: [
      {
        kind: 'tcp',
        hostPrefix: 'web',
        containerName: 'app',
        containerPort: 8080,
        shouldDisplay: true,
        title: 'web',
      },
    ],
    timeoutMilliseconds: options.timeoutMs ?? 600_000,
    flags: [{ provider: 'main', flag: flagFor(team, chal) }],
  } as CreateInstanceOptions)) as Details | Failure

const get = async (team: string, chal: string): Promise<Details | Failure> =>
  (await provider.getInstance({
    teamId: team,
    challengeIntegrationId: chal,
    config: {},
  })) as Details | Failure

const extend = async (
  team: string,
  chal: string,
  timeoutMs = 600_000
): Promise<Details | Failure> =>
  (await provider.extendInstance({
    teamId: team,
    challengeIntegrationId: chal,
    config: {},
    timeoutMilliseconds: timeoutMs,
  })) as Details | Failure

const del = async (team: string, chal: string): Promise<Details | Failure> =>
  (await provider.deleteInstance({
    teamId: team,
    challengeIntegrationId: chal,
    config: {},
  })) as Details | Failure

const waitRunning = async (
  team: string,
  chal: string,
  timeoutMs = 180_000
): Promise<{ details: Details; row: DbRow }> => {
  const details = (await waitFor(
    `${team}/${chal} running`,
    () => get(team, chal),
    value => isDetails(value) && value.status === 'running',
    timeoutMs,
    250
  )) as Details
  const row = (
    await waitRows(
      `${team}/${chal} controller row`,
      all =>
        all.some(
          row =>
            row.team_id === team &&
            row.challenge_integration_id === chal &&
            (row.state === 'running' || row.state === 'creating')
        ),
      timeoutMs
    )
  )
    .filter(
      row =>
        row.team_id === team &&
        row.challenge_integration_id === chal &&
        (row.state === 'running' ||
          row.state === 'creating' ||
          row.state === 'deleting')
    )
    .sort((a, b) => b.created_at_ms - a.created_at_ms)[0]
  if (row === undefined) throw new Error(`no live row for ${team}/${chal}`)
  return { details, row }
}

const waitStopped = async (
  team: string,
  chal: string,
  timeoutMs = 60_000
): Promise<void> => {
  await waitFor(
    `${team}/${chal} stopped`,
    () => get(team, chal),
    value =>
      isDetails(value) &&
      (value.status === 'stopped' || value.status === 'errored'),
    timeoutMs,
    250
  )
}

const waitRowGone = async (
  team: string,
  chal: string,
  timeoutMs = 60_000
): Promise<void> => {
  await waitForTrue(
    `${team}/${chal} row removed`,
    () => rowsFor(team, chal).length === 0,
    timeoutMs,
    200
  )
}

const deleteAndWait = async (team: string, chal: string): Promise<void> => {
  await del(team, chal)
  await waitStopped(team, chal)
  await waitRowGone(team, chal)
}

const deleteAllTeams = async (
  teams: Array<{ team: string; chal: string }>
): Promise<void> => {
  for (const entry of teams) {
    try {
      await deleteAndWait(entry.team, entry.chal)
    } catch (error) {
      report.line(
        `cleanup warning: delete ${entry.team}/${entry.chal}: ${errorMessage(error)}`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Controller process control (inside host-a)
// ---------------------------------------------------------------------------

let controllerPid: number | undefined

const startController = async (
  variant: 'normal' | 'badtoken',
  yamlPath: string = CONTROLLER_YAML
): Promise<void> => {
  const sourceBad = variant === 'badtoken' ? `. ${BADTOKEN_ENV}; ` : ''
  const command =
    `cd /opt/rctf-firecracker && ` +
    `{ set -a; . ${CONTROLLER_ENV}; ${sourceBad}set +a; ` +
    `exec /usr/local/bin/bun apps/firecracker-instancer/src/controller/index.ts ${yamlPath}; } ` +
    `>>/home/ubuntu/mh-controller/controller-${variant}.log 2>&1 </dev/null & echo $!`
  const pid = Number(remoteOut(A, command, 30_000))
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`controller start returned an invalid pid: ${pid}`)
  }
  controllerPid = pid
  try {
    await waitForTrue(
      `controller /healthz (${variant})`,
      async () => {
        try {
          const result = await httpRequest(`${CONTROLLER}/healthz`, {}, 2_000)
          return result.status === 200
        } catch {
          return false
        }
      },
      60_000,
      200
    )
  } catch (error) {
    throw new Error(
      `${errorMessage(error)}\n--- controller log ---\n${controllerLogTail(variant, 40)}`
    )
  }
}

const stopController = async (
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'
): Promise<void> => {
  const pid = controllerPid
  controllerPid = undefined
  if (pid === undefined) return
  remote(
    A,
    `kill -${signal === 'SIGKILL' ? 'KILL' : 'TERM'} ${pid} 2>/dev/null || true`
  )
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const alive = remote(A, `kill -0 ${pid} 2>/dev/null && echo alive || true`)
    if (!alive.stdout.includes('alive')) return
    await sleep(200)
  }
  remote(A, `kill -KILL ${pid} 2>/dev/null || true`)
}

const restartController = async (
  variant: 'normal' | 'badtoken' = 'normal',
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
  yamlPath: string = CONTROLLER_YAML
): Promise<void> => {
  await stopController(signal)
  await startController(variant, yamlPath)
}

// ---------------------------------------------------------------------------
// Host / VM control and cleanliness
// ---------------------------------------------------------------------------

const waitHostsHealthy = async (timeoutMs = 60_000): Promise<HostSummary[]> => {
  return waitFor(
    'both hosts healthy',
    async () => listHosts(),
    hosts =>
      hosts.length === 2 && hosts.every(host => host.health === 'healthy'),
    timeoutMs,
    300
  )
}

const waitHostHealth = async (
  host: string,
  health: string,
  timeoutMs = 30_000
): Promise<number> => {
  const started = Date.now()
  await waitForTrue(
    `${host} health=${health}`,
    async () => (await hostSummary(host))?.health === health,
    timeoutMs,
    200
  )
  return Date.now() - started
}

const waitAgentsClean = async (timeoutMs = 60_000): Promise<void> => {
  await waitForTrue(
    'both agents clean',
    () => {
      const a = hostStats(A)
      const b = hostStats(B)
      return (
        a.instances?.length === 0 &&
        b.instances?.length === 0 &&
        a.firecrackerProcs === 0 &&
        b.firecrackerProcs === 0 &&
        a.taps === 0 &&
        b.taps === 0 &&
        a.stateRecords === 0 &&
        b.stateRecords === 0
      )
    },
    timeoutMs,
    500
  )
}

const waitControllerEmpty = async (timeoutMs = 60_000): Promise<void> => {
  await waitForTrue(
    'controller instance rows empty',
    () => rows().length === 0,
    timeoutMs,
    250
  )
}

interface DestroyedProbe {
  ok: boolean
  destroyedAt?: number
  detail: string
}

/**
 * Wait until the agent has definitively destroyed an instance: the agent
 * listing no longer contains it, its state file is absent, no Firecracker
 * process carries its id and the recorded pid is gone. Every component is a
 * fail-closed probe: a failed ssh/HTTP observation never counts as absence.
 */
const waitDestroyed = async (
  host: string,
  id: string,
  pid: number,
  timeoutMs = 60_000
): Promise<DestroyedProbe> => {
  const deadline = Date.now() + timeoutMs
  let detail = 'not sampled yet'
  while (Date.now() < deadline) {
    const stats = probeHostStats(host)
    const state = probeAgentState(host, id)
    const fc = probeFirecracker(host)
    const proc = probePid(host, pid)
    if (!stats.ok || !state.ok || !fc.ok || !proc.ok) {
      detail = `probe error (stats=${stats.error ?? 'ok'} state=${state.error ?? 'ok'} fc=${fc.error ?? 'ok'} pid=${proc.error ?? 'ok'})`
      await sleep(500)
      continue
    }
    const stillListed = stats.stats!.instances!.some(
      instance => instance.id === id
    )
    const fcLine = fcLineForId(fc.lines!, id)
    if (
      !stillListed &&
      state.exists === false &&
      fcLine === undefined &&
      proc.alive === false
    ) {
      return {
        ok: true,
        destroyedAt: Date.now(),
        detail:
          'listing, state file, Firecracker process and pid are all absent',
      }
    }
    detail = `listed=${stillListed} stateFile=${state.exists} fc=${fcLine !== undefined} pidAlive=${proc.alive}`
    await sleep(500)
  }
  return {
    ok: false,
    detail: `timed out after ${timeoutMs}ms; last: ${detail}`,
  }
}

const globalCleanup = async (): Promise<void> => {
  try {
    for (const row of rows()) {
      try {
        await del(row.team_id, row.challenge_integration_id)
      } catch {
        // best effort
      }
    }
  } catch {
    // controller might be down
  }
  for (const host of [A, B]) {
    try {
      for (const instance of await agentList(host)) {
        await agentDelete(host, instance.id)
      }
    } catch {
      // host down: run.sh stops the VMs anyway
    }
  }
  try {
    await waitControllerEmpty(20_000)
  } catch {
    // recorded by the leftovers section
  }
  try {
    await waitAgentsClean(20_000)
  } catch {
    // recorded by the leftovers section
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarioHosts = async (): Promise<void> => {
  await report.group(
    '1',
    'both hosts register, heartbeat and accept instances',
    async () => {
      const hosts = await waitHostsHealthy(90_000)
      report.check(
        '1.1',
        'controller /v1/hosts lists host-a and host-b as healthy',
        hosts.length === 2 &&
          hosts
            .map(host => host.id)
            .sort()
            .join(',') === 'host-a,host-b',
        short(hosts.map(host => ({ id: host.id, health: host.health })))
      )
      const db = dbSnapshot()
      const dbA = db.hosts.find(host => host.id === A)
      const dbB = db.hosts.find(host => host.id === B)
      report.check(
        '1.2',
        'the controller recorded accepting:true for both hosts (hosts.accepting; /v1/hosts does not expose the field)',
        dbA?.accepting === 1 && dbB?.accepting === 1,
        `accepting host-a=${dbA?.accepting} host-b=${dbB?.accepting}`
      )
      const infoA = await agentInfo(A)
      const infoB = await agentInfo(B)
      report.check(
        '1.3',
        'direct agent /v1/info reports accepting:true and checks.recovered:true on both hosts',
        infoA.accepting === true &&
          infoA.checks?.recovered === true &&
          infoB.accepting === true &&
          infoB.checks?.recovered === true &&
          infoA.hostId === A &&
          infoB.hostId === B,
        short({
          a: {
            hostId: infoA.hostId,
            accepting: infoA.accepting,
            recovered: infoA.checks?.recovered,
          },
          b: {
            hostId: infoB.hostId,
            accepting: infoB.accepting,
            recovered: infoB.checks?.recovered,
          },
        })
      )
      report.check(
        '1.4',
        'each agent reports the configured capacity (maxInstances=2, memMiB=4096)',
        infoA.capacity?.maxInstances === 2 &&
          infoB.capacity?.maxInstances === 2 &&
          infoA.capacity?.memMiB === 4096 &&
          infoB.capacity?.memMiB === 4096,
        short({ a: infoA.capacity, b: infoB.capacity })
      )
      const seenA = hosts.find(host => host.id === A)?.lastSeenMs ?? 0
      const seenB = hosts.find(host => host.id === B)?.lastSeenMs ?? 0
      const now = Date.now()
      await sleep(2_500)
      const later = await listHosts()
      const laterA = later.find(host => host.id === A)?.lastSeenMs ?? 0
      const laterB = later.find(host => host.id === B)?.lastSeenMs ?? 0
      report.check(
        '1.5',
        'heartbeats keep advancing (lastSeenMs is recent and moves forward on both hosts)',
        seenA > now - 15_000 &&
          seenB > now - 15_000 &&
          laterA > seenA &&
          laterB > seenB,
        `deltaMs host-a=${laterA - seenA} host-b=${laterB - seenB}`
      )
      // The private L2 is reachable from this machine only through host VMs;
      // probe the token requirement from inside each host instead.
      const noToken = async (host: string) =>
        remote(
          host,
          `curl -sS -m 5 -o /dev/null -w '%{http_code}' http://${ipOf(host)}:7001/v1/info`
        ).stdout.trim()
      const codeA = await noToken(A)
      const codeB = await noToken(B)
      report.check(
        '1.6',
        'each agent rejects an unauthenticated request (HTTP 401) — real bearer auth',
        codeA === '401' && codeB === '401',
        `host-a=${codeA} host-b=${codeB}`
      )
      report.check(
        '1.7',
        'both agents preflight KVM + the firecracker/jailer binaries in jailer mode',
        infoA.checks?.kvm === true &&
          infoB.checks?.kvm === true &&
          infoA.checks?.firecrackerBin === true &&
          infoB.checks?.firecrackerBin === true &&
          infoA.checks?.jailerBin === true &&
          infoB.checks?.jailerBin === true &&
          infoA.checks?.imagesTrusted === true &&
          infoB.checks?.imagesTrusted === true,
        short({
          a: { kvm: infoA.checks?.kvm, jailer: infoA.checks?.jailerBin },
          b: { kvm: infoB.checks?.kvm, jailer: infoB.checks?.jailerBin },
        })
      )

      // --- private link confinement --------------------------------------
      // Inspect the QEMU command lines recorded in the run directory: the
      // private NIC must be one AF_UNIX datagram netdev pointing at the peer
      // socket, with no multicast, UDP/TCP or host-network backend. Also check
      // the socket objects themselves and that the developer machine has no
      // interface or listener on the private addresses.
      const cmdA = qemuCmdline(A)
      const cmdB = qemuCmdline(B)
      const ndA = netdevArgs(cmdA)
      const ndB = netdevArgs(cmdB)
      const specA = `dgram,id=n1,local.type=unix,local.path=${LINK_A},remote.type=unix,remote.path=${LINK_B}`
      const specB = `dgram,id=n1,local.type=unix,local.path=${LINK_B},remote.type=unix,remote.path=${LINK_A}`
      const linkDir = statSync(LINK_DIR)
      const linkMode = linkDir.mode & 0o777
      const linkOwner = linkDir.uid
      const socketsAreUnix =
        lstatSync(LINK_A).isSocket() && lstatSync(LINK_B).isSocket()
      const hostAddrs = shell(['ip', '-4', '-o', 'addr', 'show']).stdout
      const hostHasPrivate =
        hostAddrs.includes(`inet ${A_IP}/`) ||
        hostAddrs.includes(`inet ${B_IP}/`)
      const userNetdev = (arg: string): boolean =>
        arg.startsWith('user,id=n0,hostfwd=tcp:127.0.0.1:')
      const confined =
        !/mcast/i.test(cmdA + cmdB) &&
        ndA.length === 2 &&
        ndB.length === 2 &&
        ndA.includes(specA) &&
        ndB.includes(specB) &&
        ndA.filter(userNetdev).length === 1 &&
        ndB.filter(userNetdev).length === 1 &&
        ![...ndA, ...ndB].some(arg =>
          /^(socket|tap|bridge|hubport|vde|passt|l2tpv3),/.test(arg)
        ) &&
        ![...ndA, ...ndB].some(arg => arg.includes('local.type=inet')) &&
        linkMode === 0o700 &&
        linkOwner === process.getuid?.() &&
        socketsAreUnix &&
        !hostHasPrivate
      report.check(
        '1.8',
        'the private link is a host-local unix-datagram point-to-point link, not multicast (recorded QEMU command lines + socket objects)',
        confined,
        `netdevs a=${short(ndA)} b=${short(ndB)} dirMode=${linkMode.toString(8)} owner=${linkOwner} unixSockets=${socketsAreUnix} hostAddr=${hostHasPrivate}`
      )

      // The agent must be bound to exactly its private-NIC address, and that
      // address must be on the MAC-pinned second NIC (not the management NIC).
      const ifaceA = remoteSoft(A, privateIfaceCommand(A_IP))
      const ifaceB = remoteSoft(B, privateIfaceCommand(B_IP))
      const ifaceLinkA =
        ifaceA === '' ? '' : remoteSoft(A, `ip -o link show dev '${ifaceA}'`)
      const ifaceLinkB =
        ifaceB === '' ? '' : remoteSoft(B, `ip -o link show dev '${ifaceB}'`)
      const listenersOf = (host: string): string[] =>
        remoteSoft(host, "ss -ltn 2>/dev/null | awk 'NR > 1 { print $4 }'")
          .split('\n')
          .map(line => line.trim())
          .filter(line => line !== '')
      const listensA = listenersOf(A)
      const listensB = listenersOf(B)
      const onlyPrivatePort = (lines: string[], ip: string): boolean =>
        lines.includes(`${ip}:7001`) &&
        lines.filter(line => line.endsWith(':7001')).length === 1
      report.check(
        '1.9',
        "each agent's private-NIC address is MAC-pinned and is the only address it listens on",
        ifaceA !== '' &&
          ifaceB !== '' &&
          ifaceLinkA.includes(`link/ether ${A_MAC_PRIV}`) &&
          ifaceLinkB.includes(`link/ether ${B_MAC_PRIV}`) &&
          onlyPrivatePort(listensA, A_IP) &&
          onlyPrivatePort(listensB, B_IP),
        `ifaceA=${ifaceA} macA=${ifaceLinkA.includes(A_MAC_PRIV)} ifaceB=${ifaceB} macB=${ifaceLinkB.includes(B_MAC_PRIV)} listenA=${short(listensA)} listenB=${short(listensB)}`
      )

      // Cross-link reachability: each VM's only route to the peer is its
      // private NIC, the peer's hardware address resolves to the peer's
      // private MAC, and the developer machine has neither address nor a
      // listener on them.
      // Refresh the neighbour entries over the link before reading them.
      remoteSoft(A, `ping -c 1 -W 2 ${B_IP}`)
      remoteSoft(B, `ping -c 1 -W 2 ${A_IP}`)
      const routeA = remoteSoft(A, `ip route get ${B_IP}`)
      const routeB = remoteSoft(B, `ip route get ${A_IP}`)
      const neighA = remoteSoft(A, `ip neigh show ${B_IP}`)
      const neighB = remoteSoft(B, `ip neigh show ${A_IP}`)
      const hostListeners = shell(['ss', '-ltn']).stdout
      const hostListensPrivate =
        hostListeners.includes(`${A_IP}:`) || hostListeners.includes(`${B_IP}:`)
      report.check(
        '1.10',
        'the agents private-link addresses are reachable only across that link (peer route + MAC, and absent from the developer machine)',
        routeA.includes(`dev ${ifaceA}`) &&
          routeA.includes(`src ${A_IP}`) &&
          routeB.includes(`dev ${ifaceB}`) &&
          routeB.includes(`src ${B_IP}`) &&
          neighA.includes(`lladdr ${B_MAC_PRIV}`) &&
          neighB.includes(`lladdr ${A_MAC_PRIV}`) &&
          !hostListensPrivate,
        `routeA=${short(routeA)} routeB=${short(routeB)} neighA=${short(neighA)} hostListener=${hostListensPrivate}`
      )
    }
  )
}

const scenarioSpread = async (): Promise<void> => {
  await report.group(
    '2',
    "placement follows the scheduler's most-free-memory policy and every instance is pinned to its host",
    async () => {
      const teams = ['spread-1', 'spread-2', 'spread-3', 'spread-4']
      const created: Array<{ team: string; id: string; host: string }> = []
      const expected = [A, B, A, B] // most free memory; equal budgets tie-break by host id
      for (const [index, team] of teams.entries()) {
        const result = await create(team, CHAL)
        report.check(
          `2.${index + 1}a`,
          `create ${team} is accepted`,
          isDetails(result),
          short(result)
        )
        const running = await waitRunning(team, CHAL)
        created.push({
          team,
          id: running.row.id,
          host: running.row.host_id,
        })
        report.check(
          `2.${index + 1}b`,
          `${team} lands where the scheduler's most-free-memory policy predicts (equal budgets: host-id tie-break alternates)`,
          running.row.host_id === expected[index],
          `host=${running.row.host_id} expected=${expected[index]}`
        )
      }
      const hosts = await listHosts()
      report.check(
        '2.5',
        'reservations are exactly two instances per host (spread, not packing)',
        hosts.find(host => host.id === A)?.reserved.instances === 2 &&
          hosts.find(host => host.id === B)?.reserved.instances === 2,
        short(
          hosts.map(host => ({
            id: host.id,
            reserved: host.reserved.instances,
          }))
        )
      )
      const listedA = await agentList(A)
      const listedB = await agentList(B)
      const idsA = listedA.map(instance => instance.id).sort()
      const idsB = listedB.map(instance => instance.id).sort()
      const expectedA = created
        .filter(entry => entry.host === A)
        .map(entry => entry.id)
        .sort()
      const expectedB = created
        .filter(entry => entry.host === B)
        .map(entry => entry.id)
        .sort()
      report.check(
        '2.6',
        'each agent runs exactly the instances the controller pinned to it (get/list agree)',
        JSON.stringify(idsA) === JSON.stringify(expectedA) &&
          JSON.stringify(idsB) === JSON.stringify(expectedB) &&
          created.every(
            entry => entry.host === (idsA.includes(entry.id) ? A : B)
          ),
        short({ hostA: idsA, hostB: idsB })
      )
      for (const host of [A, B]) {
        const entry = created.find(candidate => candidate.host === host)!
        const jail = jailIdentity(host, entry.id)
        report.check(
          `2.7-${host}`,
          `${host} runs its instance under the real jailer (uid 10000, /firecracker, /proc/<pid>/root == jail root)`,
          jail.uid === '10000' && jail.exe === '/firecracker' && jail.matches,
          short(jail)
        )
      }
      const duplicate = await create('spread-1', CHAL)
      report.check(
        '2.8',
        'a duplicate create for a pinned team returns the same row and launches nothing',
        isDetails(duplicate) &&
          rowsFor('spread-1', CHAL).length === 1 &&
          (await agentList(A)).length + (await agentList(B)).length === 4,
        short(duplicate)
      )

      // get/extend/delete route to the pinned agent only.
      const onB = created.find(entry => entry.host === B)!
      const before = requireIdentity(onB.host, onB.id)
      const beforeRecord = agentState(onB.host, onB.id)!
      const extended = await extend(onB.team, CHAL, 900_000)
      const afterRecord = agentState(onB.host, onB.id)!
      report.check(
        '2.9',
        'extend for the instance on host-b changes the deadline on host-b and nowhere else',
        isDetails(extended) &&
          Number(afterRecord.expiresAtMs) > Number(beforeRecord.expiresAtMs) &&
          agentState(A, onB.id) === undefined,
        `before=${beforeRecord.expiresAtMs} after=${afterRecord.expiresAtMs}`
      )
      const onA = created.find(entry => entry.host === A)!
      const identityA = requireIdentity(onA.host, onA.id)
      await deleteAndWait(onA.team, CHAL)
      const goneA = (await agentList(A)).every(
        instance => instance.id !== onA.id
      )
      const stillB = (await agentList(B)).some(
        instance => instance.id === onB.id
      )
      report.check(
        '2.10',
        'delete for the instance on host-a removes it there only; the host-b instance is untouched',
        goneA &&
          stillB &&
          agentState(A, onA.id) === undefined &&
          agentState(B, onB.id) !== undefined &&
          guestFlag(B, before.guestIp) === flagFor(onB.team, CHAL),
        `host-a gone=${goneA} host-b kept=${stillB}`
      )
      const deletedProbe = httpFromHost(
        A,
        `http://${identityA.guestIp}:8080/flag.txt`,
        3
      )
      report.check(
        '2.11',
        'the deleted host-a guest is definitively unreachable (connection refused/timeout, not a probe error), and the host-b guest serves only its own flag',
        (deletedProbe.kind === 'refused' || deletedProbe.kind === 'timeout') &&
          guestFlag(B, before.guestIp) === flagFor(onB.team, CHAL),
        `deletedGuest=${identityA.guestIp} probe=${deletedProbe.kind}/${deletedProbe.curlExit} survivorGuest=${before.guestIp}`
      )
      await deleteAllTeams(
        created
          .filter(entry => entry.team !== onA.team)
          .map(entry => ({ team: entry.team, chal: CHAL }))
      )
      await waitControllerEmpty()
      await waitAgentsClean()

      // The equal-budget order above (a,b,a,b) is the host-id tie-break, not a
      // deliberate spread: the scheduler picks the healthy host with the most
      // free memory (effective capacity - reservations). Skew the configured
      // memory budget of host-b to prove the placement really follows memory.
      const skewYaml = '/home/ubuntu/mh-controller/controller-mem-skew.yaml'
      remoteOut(
        A,
        `awk '/^  - id: host-b$/ { inb=1 } inb && !done && /memMiB: 4096/ { sub(/memMiB: 4096/, "memMiB: 2048"); done=1 } { print }' ${CONTROLLER_YAML} > ${skewYaml}`
      )
      const skewA = remoteOut(
        A,
        `awk '/^  - id: host-a$/ { ina=1 } ina && !done && /memMiB:/ { print; done=1 }' ${skewYaml}`
      )
      const skewB = remoteOut(
        A,
        `awk '/^  - id: host-b$/ { inb=1 } inb && !done && /memMiB:/ { print; done=1 }' ${skewYaml}`
      )
      report.check(
        '2.12',
        'the skew config gives host-a 4096 MiB and host-b 2048 MiB of configured memory',
        /memMiB: 4096/.test(skewA) && /memMiB: 2048/.test(skewB),
        `a=${short(skewA, 80)} b=${short(skewB, 80)}`
      )
      await restartController('normal', 'SIGTERM', skewYaml)
      await waitHostsHealthy(90_000)
      const skewTeams = ['mem-1', 'mem-2', 'mem-3', 'mem-4']
      const skewExpected = [A, A, B, B]
      const skewPlaced: Array<{ team: string; host: string }> = []
      for (const [index, team] of skewTeams.entries()) {
        const result = await create(team, CHAL)
        const running = await waitRunning(team, CHAL)
        skewPlaced.push({ team, host: running.row.host_id })
        report.check(
          `2.13-${team}`,
          `${team} follows the most-free-memory policy with skewed budgets (expected ${skewExpected[index]})`,
          isDetails(result) && running.row.host_id === skewExpected[index],
          `host=${running.row.host_id} expected=${skewExpected[index]}`
        )
      }
      const skewHosts = await listHosts()
      report.check(
        '2.14',
        'the larger host absorbed two creates before the smaller one was used (packing by free memory, not alternation)',
        JSON.stringify(skewPlaced.map(entry => entry.host)) ===
          JSON.stringify(skewExpected) &&
          skewHosts.find(host => host.id === A)?.reserved.instances === 2 &&
          skewHosts.find(host => host.id === B)?.reserved.instances === 2,
        short(skewPlaced)
      )
      await deleteAllTeams(skewTeams.map(team => ({ team, chal: CHAL })))
      await waitControllerEmpty()
      await waitAgentsClean()
      await restartController('normal', 'SIGTERM')
      await waitHostsHealthy(90_000)
    }
  )
}

const scenarioDrain = async (): Promise<void> => {
  await report.group(
    '4',
    'drain: new creates avoid the host, existing instances keep running, undrain restores',
    async () => {
      const created = await create('drain-a', CHAL)
      if (!isDetails(created)) throw new Error(`create: ${short(created)}`)
      const running = await waitRunning('drain-a', CHAL)
      report.check(
        '4.1',
        'the pre-drain instance landed on host-a',
        running.row.host_id === A,
        running.row.host_id
      )
      const identity = requireIdentity(A, running.row.id)
      const drained = await adminRequest('POST', `/v1/hosts/${A}/drain`)
      report.check(
        '4.2',
        'drain marks host-a draining and keeps it listed',
        drained.status === 200 &&
          (drained.json as { health?: string })?.health === 'draining',
        `HTTP ${drained.status} ${short(drained.json)}`
      )
      const blocked = await create('drain-b', CHAL)
      report.check(
        '4.3',
        'a new create is still accepted and placed on host-b while host-a is draining',
        isDetails(blocked),
        short(blocked)
      )
      const onB = await waitRunning('drain-b', CHAL)
      report.check(
        '4.4',
        'the new instance avoided the draining host',
        onB.row.host_id === B,
        onB.row.host_id
      )
      report.check(
        '4.5',
        'the existing host-a instance kept running and serving its flag while draining',
        isDetails(await get('drain-a', CHAL)) &&
          (await get('drain-a', CHAL)).status === 'running' &&
          guestFlag(A, identity.guestIp) === flagFor('drain-a', CHAL),
        `guest=${identity.guestIp}`
      )
      const undrained = await adminRequest('POST', `/v1/hosts/${A}/undrain`)
      report.check(
        '4.6',
        'undrain restores host-a to healthy',
        undrained.status === 200 &&
          (undrained.json as { health?: string })?.health === 'healthy',
        `HTTP ${undrained.status} ${short(undrained.json)}`
      )
      const restored = await create('drain-c', CHAL)
      report.check(
        '4.7',
        'a create after undrain is accepted again',
        isDetails(restored),
        short(restored)
      )
      const onA = await waitRunning('drain-c', CHAL)
      report.check(
        '4.8',
        'post-undrain placement returns to the most-free-memory host (host-a)',
        onA.row.host_id === A,
        onA.row.host_id
      )
      await deleteAllTeams([
        { team: 'drain-a', chal: CHAL },
        { team: 'drain-b', chal: CHAL },
        { team: 'drain-c', chal: CHAL },
      ])
      await waitControllerEmpty()
      await waitAgentsClean()
    }
  )
}

const scenarioCapacity = async (): Promise<void> => {
  await report.group(
    '3',
    'capacity: fill host-a, overflow to host-b, clean no_capacity, atomic reservation under 20 races',
    async () => {
      const teams = ['cap-1', 'cap-2', 'cap-3', 'cap-4']
      const placed: Array<{ team: string; id: string; host: string }> = []
      const expected = [A, B, A, B]
      for (const [index, team] of teams.entries()) {
        const result = await create(team, CHAL)
        if (!isDetails(result))
          throw new Error(`create ${team}: ${short(result)}`)
        const running = await waitRunning(team, CHAL)
        placed.push({ team, id: running.row.id, host: running.row.host_id })
        if (index === 2) {
          const hosts = await listHosts()
          report.check(
            '3.1',
            'host-a is filled to maxInstances=2 by the third create',
            hosts.find(host => host.id === A)?.reserved.instances === 2,
            `reservedA=${hosts.find(host => host.id === A)?.reserved.instances}`
          )
        }
        if (index === 3) {
          report.check(
            '3.2',
            'the next create after host-a is full lands on host-b',
            running.row.host_id === B,
            `host=${running.row.host_id} expected=${expected[index]}`
          )
        }
      }
      const beforeHosts = await listHosts()
      const rejected = await create('cap-5', CHAL)
      report.check(
        '3.3',
        'with both hosts full, create fails cleanly with a no_capacity instancerError',
        isFailure(rejected) && /no capacity|capacity/i.test(rejected.message),
        short(rejected)
      )
      report.check(
        '3.4',
        'the rejected team has no controller row and no VM anywhere',
        rowsFor('cap-5', CHAL).length === 0 &&
          (await agentList(A)).length + (await agentList(B)).length === 4 &&
          hostStats(A).firecrackerProcs + hostStats(B).firecrackerProcs === 4,
        `rows=${rowsFor('cap-5', CHAL).length}`
      )
      report.check(
        '3.5',
        'reservations never exceeded either host capacity',
        beforeHosts.every(host => host.reserved.instances <= 2),
        short(
          beforeHosts.map(host => ({
            id: host.id,
            reserved: host.reserved.instances,
          }))
        )
      )
      await deleteAllTeams(
        placed.map(entry => ({ team: entry.team, chal: CHAL }))
      )
      await waitControllerEmpty()
      await waitAgentsClean()

      // Atomic reservation: 20 concurrent creates, distinct teams. Sample the
      // controller's reservation view *during* the race: the outcome alone
      // (4 accepted) cannot prove no host was transiently oversubscribed.
      const raceTeams = Array.from(
        { length: 20 },
        (_, index) => `race-${index + 1}`
      )
      const raceSamples: Array<{ a: number; b: number; at: number }> = []
      let sampling = true
      const sampler = (async (): Promise<void> => {
        while (sampling) {
          try {
            const snapshot = await listHosts()
            raceSamples.push({
              a: snapshot.find(host => host.id === A)?.reserved.instances ?? -1,
              b: snapshot.find(host => host.id === B)?.reserved.instances ?? -1,
              at: Date.now(),
            })
          } catch {
            // A transient probe failure is not a sample; keep sampling.
          }
          await sleep(50)
        }
      })()
      let results: Array<Details | Failure>
      try {
        results = await Promise.all(raceTeams.map(team => create(team, CHAL)))
      } finally {
        sampling = false
        await sampler
      }
      const successes = results.filter(isDetails)
      const failures = results.filter(isFailure)
      report.check(
        '3.6',
        'under 20 concurrent creates exactly 4 are accepted (2 per host) and 16 fail cleanly',
        successes.length === 4 &&
          failures.length === 16 &&
          failures.every(failure => /capacity/i.test(failure.message)),
        `ok=${successes.length} rejected=${failures.length}`
      )
      const raceRows = await waitRows(
        'the four race winners have live rows',
        all => all.length === 4,
        60_000
      )
      const winners = raceTeams.filter(team =>
        raceRows.some(row => row.team_id === team)
      )
      for (const team of winners) await waitRunning(team, CHAL, 180_000)
      const statsA = hostStats(A)
      const statsB = hostStats(B)
      const hosts = await listHosts()
      const oversubscribed = raceSamples.filter(
        sample => sample.a > 2 || sample.b > 2
      )
      const maxA = Math.max(...raceSamples.map(sample => sample.a))
      const maxB = Math.max(...raceSamples.map(sample => sample.b))
      report.check(
        '3.7',
        'reservations sampled every 50ms during the race never exceeded 2 per host (the sampler observed both hosts fully reserved)',
        raceSamples.length > 0 &&
          oversubscribed.length === 0 &&
          maxA === 2 &&
          maxB === 2 &&
          hosts.every(host => host.reserved.instances <= 2) &&
          (statsA.instances?.length ?? -1) <= 2 &&
          (statsB.instances?.length ?? -1) <= 2 &&
          statsA.firecrackerProcs <= 2 &&
          statsB.firecrackerProcs <= 2 &&
          statsA.firecrackerProcs + statsB.firecrackerProcs === 4,
        `samples=${raceSamples.length} maxReserved=${maxA}/${maxB} over=${oversubscribed.length} reserved=${hosts
          .map(host => `${host.id}:${host.reserved.instances}`)
          .join(
            ','
          )} agentA=${statsA.instances?.length} agentB=${statsB.instances?.length} fc=${
          statsA.firecrackerProcs + statsB.firecrackerProcs
        }`
      )
      await deleteAllTeams(winners.map(team => ({ team, chal: CHAL })))
      await waitControllerEmpty()
      await waitAgentsClean()
      const after = await create('cap-after', CHAL)
      if (isDetails(after)) await waitRunning('cap-after', CHAL)
      report.check(
        '3.8',
        'capacity returns after deletes and the create is clean (no leaked VMs/taps/records)',
        isDetails(after) &&
          (await agentList(A)).length + (await agentList(B)).length === 1,
        short(after)
      )
      await deleteAndWait('cap-after', CHAL)
      await waitAgentsClean()
    }
  )
}

const scenarioIsolation = async (): Promise<void> => {
  await report.group(
    '8',
    'cross-host isolation: every instance answers only on its own host address/port, with its own flag',
    async () => {
      const entries = [
        { team: 'iso-one', chal: CHAL },
        { team: 'iso-one', chal: CHAL2 },
        { team: 'iso-two', chal: CHAL },
        { team: 'iso-two', chal: CHAL2 },
      ]
      const placed: Array<{
        team: string
        chal: string
        host: string
        id: string
        identity: Identity
        endpointHost: string
        endpointPort: number
      }> = []
      for (const entry of entries) {
        const created = await create(entry.team, entry.chal)
        if (!isDetails(created)) throw new Error(`create: ${short(created)}`)
        const running = await waitRunning(entry.team, entry.chal)
        const identity = requireIdentity(running.row.host_id, running.row.id)
        const endpoints = running.details.endpoints ?? []
        placed.push({
          ...entry,
          host: running.row.host_id,
          id: running.row.id,
          identity,
          endpointHost: endpoints[0]?.host ?? '',
          endpointPort: endpoints[0]?.port ?? 0,
        })
      }
      report.check(
        '8.1',
        'two instances of the same team and one of another team are spread two per host',
        placed.filter(entry => entry.host === A).length === 2 &&
          placed.filter(entry => entry.host === B).length === 2 &&
          rowsFor('iso-one', CHAL)[0]?.host_id !==
            rowsFor('iso-one', CHAL2)[0]?.host_id,
        short(
          placed.map(entry => ({
            key: `${entry.team}/${entry.chal}`,
            host: entry.host,
          }))
        )
      )
      report.check(
        '8.2',
        'every endpoint names its own host public address and the port the pinned agent allocated',
        placed.every(
          entry =>
            entry.endpointHost === ipOf(entry.host) &&
            entry.endpointPort > 0 &&
            entry.endpointPort === entry.identity.publicPort
        ),
        short(
          placed.map(entry => ({
            host: entry.host,
            endpoint: `${entry.endpointHost}:${entry.endpointPort}`,
            leasePort: entry.identity.publicPort,
          }))
        )
      )
      for (const entry of placed) {
        const expected = flagFor(entry.team, entry.chal)
        report.check(
          `8.3-${entry.team}-${entry.chal}`,
          `${entry.team}/${entry.chal} guest on ${entry.host} serves exactly its own flag`,
          guestFlag(entry.host, entry.identity.guestIp) === expected,
          `guest=${entry.identity.guestIp}`
        )
      }
      // Public reachability from the *other* host: correct address/port works,
      // the other instance's port on the same address does not.
      const aEntry = placed.find(entry => entry.host === A)!
      const bEntry = placed.find(entry => entry.host === B)!
      const aFlag = flagFor(aEntry.team, aEntry.chal)
      const bFlag = flagFor(bEntry.team, bEntry.chal)
      const bFromA = httpFromHost(
        A,
        `http://${B_IP}:${bEntry.endpointPort}/flag.txt`
      )
      const aFromB = httpFromHost(
        B,
        `http://${A_IP}:${aEntry.endpointPort}/flag.txt`
      )
      report.check(
        '8.4',
        "from host-a, host-b's public address:port serves host-b's flag (and not host-a's)",
        bFromA.ok && bFromA.body === bFlag && bFromA.body !== aFlag,
        `HTTP ${bFromA.code}`
      )
      report.check(
        '8.5',
        "from host-b, host-a's public address:port serves host-a's flag (and not host-b's)",
        aFromB.ok && aFromB.body === aFlag && aFromB.body !== bFlag,
        `HTTP ${aFromB.code}`
      )
      const crossPort1 = httpFromHost(
        A,
        `http://${B_IP}:${aEntry.endpointPort}/flag.txt`,
        3
      )
      const crossPort2 = httpFromHost(
        B,
        `http://${A_IP}:${bEntry.endpointPort}/flag.txt`,
        3
      )
      report.check(
        '8.6',
        "the other host's port is definitively closed at this host's address (connection refused/timeout, not a probe error)",
        (crossPort1.kind === 'refused' || crossPort1.kind === 'timeout') &&
          (crossPort2.kind === 'refused' || crossPort2.kind === 'timeout') &&
          crossPort1.body !== aFlag &&
          crossPort2.body !== bFlag,
        `a->b:${aEntry.endpointPort} ${crossPort1.kind}/${crossPort1.curlExit}; b->a:${bEntry.endpointPort} ${crossPort2.kind}/${crossPort2.curlExit}`
      )
      const allFlags = new Set(
        placed.map(entry => flagFor(entry.team, entry.chal))
      )
      report.check(
        '8.7',
        "all four instances have distinct flags; no guest can serve another instance's flag",
        allFlags.size === 4 &&
          placed.every(entry => {
            const own = flagFor(entry.team, entry.chal)
            const served = guestFlag(entry.host, entry.identity.guestIp)
            return (
              served === own &&
              [...allFlags].every(other => other === own || other !== served)
            )
          }),
        `distinctFlags=${allFlags.size}`
      )
      for (const host of [A, B]) {
        const expectedIds = placed
          .filter(entry => entry.host === host)
          .map(entry => entry.id)
          .sort()
        const listed = (await agentList(host))
          .map(instance => instance.id)
          .sort()
        report.check(
          `8.8-${host}`,
          `${host} still reports exactly its own two instances and neither id exists on the other host`,
          JSON.stringify(listed) === JSON.stringify(expectedIds) &&
            expectedIds.length === 2 &&
            placed
              .filter(entry => entry.host !== host)
              .every(entry => !listed.includes(entry.id)),
          `listed=${short(listed)}`
        )
      }
      await deleteAllTeams(entries)
      await waitControllerEmpty()
      await waitAgentsClean()
    }
  )
}

const scenarioControllerRestart = async (): Promise<void> => {
  await report.group(
    '9',
    'controller restart while instances span both hosts: adoption keeps host pinning, no duplicates',
    async () => {
      const pairs = [
        { team: 'rst-a', chal: CHAL },
        { team: 'rst-b', chal: CHAL },
      ]
      const before: Array<{
        team: string
        chal: string
        id: string
        host: string
        guestIp: string
      }> = []
      for (const pair of pairs) {
        const created = await create(pair.team, pair.chal)
        if (!isDetails(created)) throw new Error(`create: ${short(created)}`)
        const running = await waitRunning(pair.team, pair.chal)
        const identity = requireIdentity(running.row.host_id, running.row.id)
        before.push({
          ...pair,
          id: running.row.id,
          host: running.row.host_id,
          guestIp: identity.guestIp,
        })
      }
      report.check(
        '9.1',
        'the two instances are pinned to different hosts before the restart',
        before[0]!.host !== before[1]!.host,
        `${before[0]!.host} / ${before[1]!.host}`
      )
      await restartController('normal', 'SIGKILL')
      await waitHostsHealthy(90_000)
      await sleep(1_500)
      const afterRows = rows()
      for (const entry of before) {
        const row = afterRows.find(row => row.id === entry.id)
        report.check(
          `9.2-${entry.team}`,
          `${entry.team} is adopted with the same id and the same pinned host after a SIGKILL restart`,
          row?.id === entry.id && row?.host_id === entry.host,
          `id=${row?.id} host=${row?.host_id} state=${row?.state}`
        )
        report.check(
          `9.3-${entry.team}`,
          `${entry.team} still runs exactly one VM on its pinned agent and serves its flag`,
          (await agentList(entry.host)).filter(
            instance => instance.id === entry.id
          ).length === 1 &&
            (await agentList(entry.host === A ? B : A)).every(
              instance => instance.id !== entry.id
            ) &&
            guestFlag(entry.host, entry.guestIp) ===
              flagFor(entry.team, entry.chal),
          `host=${entry.host} guest=${entry.guestIp}`
        )
      }
      report.check(
        '9.4',
        'no duplicate rows exist for either team (one live instance per team/challenge)',
        before.every(entry => rowsFor(entry.team, entry.chal).length === 1) &&
          rows().length === 2,
        `rows=${rows().length}`
      )
      const duplicate = await create(before[0]!.team, before[0]!.chal)
      report.check(
        '9.5',
        'a create after the restart returns the same instance and launches nothing',
        isDetails(duplicate) &&
          rowsFor(before[0]!.team, before[0]!.chal)[0]?.id === before[0]!.id &&
          (await agentList(A)).length + (await agentList(B)).length === 2,
        short(duplicate)
      )
      await deleteAllTeams(pairs)
      await waitControllerEmpty()
      await waitAgentsClean()
    }
  )
}

const scenarioPartition = async (): Promise<void> => {
  await report.group(
    '6',
    'network partition of host-b: unhealthy, no placements, ownership pinned, dead-man expiry',
    async () => {
      await adminRequest('POST', `/v1/hosts/${A}/drain`)
      const longCreate = await create('part-long', CHAL, { timeoutMs: 600_000 })
      if (!isDetails(longCreate))
        throw new Error(`create: ${short(longCreate)}`)
      const longRun = await waitRunning('part-long', CHAL)
      report.check(
        '6.1',
        'the long-lived instance is placed on host-b (host-a drained)',
        longRun.row.host_id === B,
        longRun.row.host_id
      )
      const shortCreate = await create('part-short', CHAL, {
        timeoutMs: 15_000,
      })
      if (!isDetails(shortCreate))
        throw new Error(`create: ${short(shortCreate)}`)
      const shortRun = await waitRunning('part-short', CHAL)
      report.check(
        '6.2',
        'the short-lived instance is also placed on host-b',
        shortRun.row.host_id === B,
        shortRun.row.host_id
      )
      // Capture the *agent's* deadline and the live Firecracker pid before the
      // partition. The controller-side row's expires_at_ms is a translated
      // estimate; only the agent state proves when its dead-man timer expires.
      const shortState = probeAgentState(B, shortRun.row.id)
      const shortPid = Number(
        (shortState.record?.vm as { pid?: number } | undefined)?.pid ?? 0
      )
      const shortFcBefore = probeFirecracker(B)
      const shortPidLine =
        shortFcBefore.ok && shortState.ok
          ? fcLineForId(shortFcBefore.lines!, shortRun.row.id)
          : undefined
      const shortExpiresAt = Number(shortState.record?.expiresAtMs)
      report.check(
        '6.2b',
        'the agent state records the live Firecracker pid and the real expiresAtMs for the short instance',
        shortState.ok &&
          shortState.exists === true &&
          shortPid > 0 &&
          shortPidLine !== undefined &&
          shortPidLine.startsWith(`${shortPid} `) &&
          Number.isFinite(shortExpiresAt) &&
          shortExpiresAt > 0,
        `pid=${shortPid} line=${short(shortPidLine, 100)} expiresAtMs=${shortExpiresAt}`
      )
      const longIdentity = requireIdentity(B, longRun.row.id)
      await adminRequest('POST', `/v1/hosts/${A}/undrain`)

      const block = async (): Promise<void> => {
        const cmd =
          `sudo nft add table inet mhpart; ` +
          `sudo nft 'add chain inet mhpart output { type filter hook output priority 0; policy accept; }'; ` +
          `sudo nft 'add chain inet mhpart input { type filter hook input priority 0; policy accept; }'; ` +
          `sudo nft add rule inet mhpart output ip daddr ${A_IP} drop; ` +
          `sudo nft add rule inet mhpart input ip saddr ${A_IP} drop`
        remoteOut(B, cmd)
      }
      const unblock = async (): Promise<void> => {
        remoteOut(B, 'sudo nft delete table inet mhpart 2>/dev/null || true')
      }
      await block()
      const unhealthyMs = await waitHostHealth(B, 'unhealthy', 30_000)
      report.check(
        '6.3',
        'the controller marks host-b unhealthy after the configured heartbeat timeout (4s)',
        unhealthyMs >= 3_000 && unhealthyMs <= 20_000,
        `after ~${unhealthyMs}ms`
      )
      report.check(
        '6.4',
        'host-a stays healthy during the partition',
        (await hostSummary(A))?.health === 'healthy'
      )
      const during = await create('part-new', CHAL)
      report.check(
        '6.5',
        'a create during the partition is accepted and placed on host-a only',
        isDetails(during),
        short(during)
      )
      const duringRun = await waitRunning('part-new', CHAL)
      report.check(
        '6.6',
        'the new instance avoided the partitioned host',
        duringRun.row.host_id === A &&
          rowsFor('part-long', CHAL)[0]?.host_id === B &&
          rowsFor('part-short', CHAL)[0]?.host_id === B,
        `new=${duringRun.row.host_id} long=${rowsFor('part-long', CHAL)[0]?.host_id} short=${rowsFor('part-short', CHAL)[0]?.host_id}`
      )
      const longDuring = await get('part-long', CHAL)
      const longRowsDuring = rowsFor('part-long', CHAL)
      report.check(
        '6.7',
        "the partitioned host's instance is not rescheduled: exactly one row exists, reports errored, stays pinned to host-b, and no host-a agent record for that id exists",
        isDetails(longDuring) &&
          longDuring.status === 'errored' &&
          longRowsDuring.length === 1 &&
          longRowsDuring[0]?.id === longRun.row.id &&
          longRowsDuring[0]?.host_id === B &&
          (await agentList(B)).some(
            instance => instance.id === longRun.row.id
          ) &&
          (await agentList(A)).every(
            instance => instance.id !== longRun.row.id
          ),
        `get=${short(longDuring)} rows=${short(longRowsDuring.map(row => `${row.id}@${row.host_id}:${row.state}`))}`
      )
      const shortRowsDuring = rowsFor('part-short', CHAL)
      const shortRowDuring = shortRowsDuring[0]
      report.check(
        '6.8',
        "the short instance still has exactly one row pinned to host-b during the partition (running, or deleting after the controller's own expiry claim; an absent row fails this check)",
        shortRowsDuring.length === 1 &&
          shortRowDuring !== undefined &&
          shortRowDuring.id === shortRun.row.id &&
          shortRowDuring.host_id === B &&
          (shortRowDuring.state === 'running' ||
            shortRowDuring.state === 'deleting') &&
          (await agentList(A)).every(
            instance => instance.id !== shortRun.row.id
          ),
        `rows=${short(shortRowsDuring.map(row => `${row.id}@${row.host_id}:${row.state}`))}`
      )

      // Dead-man: the agent tears the guest down at
      // expiresAtMs + expiryGraceSeconds (10s in provision-host.sh) on its own,
      // while the controller cannot reach it. The agent sweep runs every 1s
      // (`sweepIntervalMs` in agent/manager.ts), so destruction is expected
      // within ~1s of that deadline plus teardown time; the band is tight.
      const expiryGraceMs = 10_000
      const shortDeadline = shortExpiresAt + expiryGraceMs
      const destroyed = await waitDestroyed(
        B,
        shortRun.row.id,
        shortPid,
        60_000
      )
      report.check(
        '6.9',
        'host-b destroys the expired guest on its own dead-man deadline (expiresAtMs + 10s grace; 1s agent sweep) while partitioned',
        destroyed.ok &&
          destroyed.destroyedAt !== undefined &&
          destroyed.destroyedAt >= shortDeadline - 1_000 &&
          destroyed.destroyedAt <= shortDeadline + 8_000,
        `expiresAtMs=${shortExpiresAt} deadline=${shortDeadline} destroyed=${destroyed.destroyedAt ?? 'never'} delta=${destroyed.destroyedAt === undefined ? 'n/a' : destroyed.destroyedAt - shortDeadline}ms ${destroyed.detail}`
      )
      report.check(
        '6.10',
        'the long-lived guest on host-b is still alive locally during the partition',
        (await agentList(B)).some(instance => instance.id === longRun.row.id) &&
          hostStats(B).firecrackerProcs >= 1,
        `fc=${hostStats(B).firecrackerProcs}`
      )

      await unblock()
      const healthyMs = await waitHostHealth(B, 'healthy', 60_000)
      report.check(
        '6.11',
        'the host becomes healthy again when the partition ends',
        healthyMs <= 45_000,
        `after ~${healthyMs}ms`
      )
      const longAfter = await waitRunning('part-long', CHAL, 60_000)
      report.check(
        '6.12',
        'the long instance is still owned by host-b and serves its flag after the partition',
        longAfter.row.host_id === B &&
          longAfter.row.id === longRun.row.id &&
          guestFlag(B, longIdentity.guestIp) === flagFor('part-long', CHAL),
        `id=${longAfter.row.id} host=${longAfter.row.host_id}`
      )
      report.check(
        '6.13',
        'the short instance does not come back and its controller row is cleaned up',
        await waitForTrue(
          'short row removed after the partition ends',
          () => rowsFor('part-short', CHAL).length === 0,
          60_000,
          500
        )
          .then(() => true)
          .catch(() => false),
        `rows=${rowsFor('part-short', CHAL).length}`
      )
      report.check(
        '6.13a',
        'the dead-man-destroyed guest left no agent record and reads as stopped',
        agentState(B, shortRun.row.id) === undefined &&
          (await get('part-short', CHAL)).status === 'stopped',
        `record=${agentState(B, shortRun.row.id) === undefined ? 'gone' : 'present'}`
      )
      report.check(
        '6.14',
        'no duplicate instance of either partitioned team exists on host-a',
        (await agentList(A)).every(
          instance =>
            instance.id !== longRun.row.id && instance.id !== shortRun.row.id
        ),
        short((await agentList(A)).map(instance => instance.id))
      )
      await deleteAllTeams([
        { team: 'part-long', chal: CHAL },
        { team: 'part-new', chal: CHAL },
      ])
      await waitControllerEmpty()
      await waitAgentsClean()
    }
  )
}

const scenarioHostLoss = async (): Promise<void> => {
  await report.group(
    '5',
    'host loss: unhealthy, writes off as lost, no rescheduling, agent restart cleans up, no duplicates',
    async () => {
      await adminRequest('POST', `/v1/hosts/${A}/drain`)
      const created = await create('loss', CHAL)
      if (!isDetails(created)) throw new Error(`create: ${short(created)}`)
      const running = await waitRunning('loss', CHAL)
      report.check(
        '5.1',
        'the doomed instance is placed on host-b',
        running.row.host_id === B,
        running.row.host_id
      )
      await adminRequest('POST', `/v1/hosts/${A}/undrain`)
      const healthyRemoval = await adminRequest('DELETE', `/v1/hosts/${B}`)
      report.check(
        '5.2',
        'removing a healthy host is refused with 409',
        healthyRemoval.status === 409,
        `HTTP ${healthyRemoval.status}`
      )

      // Simulate a host crash. The VM pid is authenticated inside vm.sh and
      // SIGKILLed through a pidfd (pidguard.py): reading the PID here and
      // calling process.kill() afterwards had a window in which the PID could
      // be reused, killing an unrelated process.
      const crash = shell(
        [
          VMCTL,
          '--name',
          B,
          '--ssh-port',
          String(B_SSH),
          'kill',
        ],
        30_000
      )
      if (crash.code !== 0) {
        throw new Error(
          `could not crash host-b through the authenticated pidfd: ${short(crash)}`
        )
      }
      const killedAt = Date.now()
      const unhealthyMs = await waitHostHealth(B, 'unhealthy', 30_000)
      report.check(
        '5.3',
        'host-b is marked unhealthy after the configured heartbeat timeout',
        unhealthyMs >= 3_000 && unhealthyMs <= 25_000,
        `after ~${unhealthyMs}ms (killed=${Date.now() - killedAt}ms)`
      )
      const newCreate = await create('loss-new', CHAL)
      report.check(
        '5.4',
        'a create while host-b is down is accepted on host-a only',
        isDetails(newCreate) && rowsFor('loss-new', CHAL)[0]?.host_id === A,
        short(newCreate)
      )
      await waitRunning('loss-new', CHAL)
      const lostDuring = await get('loss', CHAL)
      const lossRowsDuring = rowsFor('loss', CHAL)
      report.check(
        '5.5',
        'the instance on the dead host is not rescheduled: exactly one row exists, reports errored, stays pinned to host-b, and host-a has no agent record for that id',
        isDetails(lostDuring) &&
          lostDuring.status === 'errored' &&
          lossRowsDuring.length === 1 &&
          lossRowsDuring[0]?.id === running.row.id &&
          lossRowsDuring[0]?.host_id === B &&
          lossRowsDuring[0]?.state === 'running' &&
          (await agentList(A)).every(
            instance => instance.id !== running.row.id
          ),
        `get=${short(lostDuring)} rows=${short(lossRowsDuring.map(row => `${row.id}@${row.host_id}:${row.state}`))}`
      )
      const removed = await adminRequest('DELETE', `/v1/hosts/${B}`)
      const lostRow = rowsFor('loss', CHAL)[0]
      report.check(
        '5.6',
        'removing the unhealthy host returns 204 and writes the live row off as lost',
        removed.status === 204 &&
          lostRow?.state === 'lost' &&
          (await hostSummary(B))?.reserved.instances === 0,
        `HTTP ${removed.status} state=${lostRow?.state} reserved=${(await hostSummary(B))?.reserved.instances}`
      )
      report.check(
        '5.7',
        'the written-off host stays draining after removal (a heartbeat cannot resurrect it)',
        (await hostSummary(B))?.health === 'draining',
        (await hostSummary(B))?.health
      )
      const lostGet = await get('loss', CHAL)
      report.check(
        '5.8',
        'the written-off instance reads as stopped for the player',
        isDetails(lostGet) && lostGet.status === 'stopped',
        short(lostGet)
      )
      const recreated = await create('loss', CHAL)
      if (!isDetails(recreated))
        throw new Error(`recreate: ${short(recreated)}`)
      const recreatedRun = await waitRunning('loss', CHAL)
      const liveRowsAfterRecreate = rowsFor('loss', CHAL).filter(
        row => row.state !== 'lost'
      )
      report.check(
        '5.9',
        'the freed key lets the same team start a fresh instance on host-a (different id, one live row)',
        recreatedRun.row.id !== running.row.id &&
          recreatedRun.row.host_id === A &&
          liveRowsAfterRecreate.length === 1 &&
          liveRowsAfterRecreate[0]?.id === recreatedRun.row.id,
        `old=${running.row.id} new=${recreatedRun.row.id} host=${recreatedRun.row.host_id}`
      )
      const recreatedIdentity = requireIdentity(A, recreatedRun.row.id)
      report.check(
        '5.10',
        'the fresh host-a guest serves the team flag',
        guestFlag(A, recreatedIdentity.guestIp) === flagFor('loss', CHAL)
      )

      // Hard-killed QEMU: the overlay (agent records included) survives.
      const boot = shell(
        [
          VMCTL,
          '--name',
          B,
          '--ssh-port',
          String(B_SSH),
          '--seed-port',
          must(process.env.HOST_B_SEED_PORT, 'HOST_B_SEED_PORT'),
          '--priv-ip',
          B_IP,
          '--link-local',
          LINK_B,
          '--link-peer',
          LINK_A,
          '--mac-mgmt',
          '52:54:00:77:0b:00',
          '--mac-priv',
          B_MAC_PRIV,
          'create',
        ],
        600_000
      )
      if (boot.code !== 0) {
        throw new Error(
          `host-b reboot failed: ${boot.stderr.slice(-800) || boot.stdout.slice(-800)}`
        )
      }
      await waitForTrue(
        'host-b agent recovered after the VM restart',
        async () => {
          try {
            const info = await agentInfo(B)
            return info.checks?.recovered === true && info.accepting === true
          } catch {
            return false
          }
        },
        180_000,
        1_000
      )
      // The returning agent writes the dead VM off as an errored record; the
      // controller's lost tombstone cleanup then DELETEs it.
      const tombstoneCleaned = await waitForTrue(
        'lost row removed after agent return',
        () =>
          rowsFor('loss', CHAL).every(row => row.id !== running.row.id) &&
          rowsFor('loss', CHAL).length === 1,
        120_000,
        500
      )
        .then(() => true)
        .catch(() => false)
      report.check(
        '5.11',
        'the lost tombstone is cleaned up exactly as documented when the agent returns',
        tombstoneCleaned,
        `rows=${short(rowsFor('loss', CHAL))}`
      )
      const statsAfterRestart = hostStats(B)
      report.check(
        '5.12',
        'the restarted agent has no record, Firecracker process, tap or duplicate VM for the written-off instance',
        (statsAfterRestart.instances ?? []).every(
          instance => instance.id !== running.row.id
        ) &&
          agentState(B, running.row.id) === undefined &&
          statsAfterRestart.firecrackerProcs === 0 &&
          statsAfterRestart.taps === 0 &&
          (await agentList(B)).length === 0,
        short({
          ids: (statsAfterRestart.instances ?? []).map(instance => instance.id),
          fc: statsAfterRestart.firecrackerProcs,
          taps: statsAfterRestart.taps,
          hostB: (await agentList(B)).length,
        })
      )
      report.check(
        '5.13',
        'the only surviving instance for the team is the host-a one (no duplicate team instance)',
        rowsFor('loss', CHAL).length === 1 &&
          rowsFor('loss', CHAL)[0]?.host_id === A &&
          rowsFor('loss', CHAL)[0]?.id === recreatedRun.row.id,
        `host=${rowsFor('loss', CHAL)[0]?.host_id} id=${rowsFor('loss', CHAL)[0]?.id}`
      )
      await deleteAndWait('loss-new', CHAL)
      await deleteAndWait('loss', CHAL)
      const undrained = await adminRequest('POST', `/v1/hosts/${B}/undrain`)
      report.check(
        '5.14',
        'undrain puts the removed host back in service',
        undrained.status === 200 &&
          (undrained.json as { health?: string })?.health === 'healthy',
        `HTTP ${undrained.status} ${short(undrained.json)}`
      )
      await waitHostsHealthy(60_000)
      await adminRequest('POST', `/v1/hosts/${A}/drain`)
      const after = await create('loss-after', CHAL)
      if (!isDetails(after))
        throw new Error(`post-undrain create: ${short(after)}`)
      const afterRun = await waitRunning('loss-after', CHAL)
      await adminRequest('POST', `/v1/hosts/${A}/undrain`)
      report.check(
        '5.15',
        'after undrain, host-b accepts placements again',
        afterRun.row.host_id === B,
        afterRun.row.host_id
      )
      await deleteAndWait('loss-after', CHAL)
      await waitControllerEmpty()
      await waitAgentsClean()
    }
  )
}

const scenarioClockSkew = async (): Promise<void> => {
  await report.group(
    '7',
    'clock skew beyond maxClockSkewSeconds: host stays healthy but takes no placements',
    async () => {
      // Precondition, independent of earlier scenarios: both hosts in service.
      await adminRequest('POST', `/v1/hosts/${A}/undrain`)
      await adminRequest('POST', `/v1/hosts/${B}/undrain`)
      await waitHostHealth(B, 'healthy', 60_000)
      await adminRequest('POST', `/v1/hosts/${A}/drain`)
      await waitHostHealth(B, 'healthy', 30_000)
      const setClock = async (offsetSeconds: number): Promise<number> => {
        const target = Math.floor(Date.now() / 1000) + offsetSeconds
        remoteOut(B, `sudo date -s "@${target}" >/dev/null`)
        return target
      }
      await setClock(60)
      await sleep(4_000)
      const ahead = await dbHost(B)
      report.check(
        '7.1',
        'a host clock 60s ahead is measured and flagged in the controller state (clock_skew_ms)',
        ahead !== undefined &&
          ahead.clock_state === 'valid' &&
          ahead.clock_skew_ms > 9_000,
        `skew=${ahead?.clock_skew_ms} state=${ahead?.clock_state}`
      )
      report.check(
        '7.2',
        'the skewed host stays healthy (documented behaviour: healthy, no placements)',
        (await hostSummary(B))?.health === 'healthy',
        (await hostSummary(B))?.health
      )
      const blockedAhead = await create('skew-ahead', CHAL)
      report.check(
        '7.3',
        'with host-a draining, a create is refused with the documented clock-skew no_capacity message',
        isFailure(blockedAhead) &&
          /clock skew/i.test(blockedAhead.message) &&
          rowsFor('skew-ahead', CHAL).length === 0 &&
          (hostStats(B).instances ?? []).length === 0,
        short(blockedAhead)
      )
      await setClock(-60)
      await sleep(4_000)
      const behind = await dbHost(B)
      report.check(
        '7.4',
        'a host clock 60s behind is measured and flagged too',
        behind !== undefined &&
          behind.clock_state === 'valid' &&
          behind.clock_skew_ms < -9_000,
        `skew=${behind?.clock_skew_ms} state=${behind?.clock_state}`
      )
      const blockedBehind = await create('skew-behind', CHAL)
      report.check(
        '7.5',
        'the behind host is also refused placement, with no row and no VM',
        isFailure(blockedBehind) &&
          /clock skew/i.test(blockedBehind.message) &&
          rowsFor('skew-behind', CHAL).length === 0 &&
          hostStats(B).firecrackerProcs === 0,
        short(blockedBehind)
      )
      await setClock(0)
      await sleep(4_000)
      const fixed = await dbHost(B)
      report.check(
        '7.6',
        'after the clock is corrected the measured skew returns within bounds',
        fixed !== undefined && Math.abs(fixed.clock_skew_ms) < 3_000,
        `skew=${fixed?.clock_skew_ms}`
      )
      // Keep host-a drained: otherwise host-a alone could satisfy this create
      // and a permanently-excluded host-b would still look healthy. Only
      // host-b can take it, and its guest must actually serve the flag.
      const ok = await create('skew-ok', CHAL)
      const okAccepted = isDetails(ok)
      const okRun = okAccepted ? await waitRunning('skew-ok', CHAL) : undefined
      const okIdentity =
        okRun !== undefined && okRun.row.host_id === B
          ? requireIdentity(B, okRun.row.id)
          : undefined
      report.check(
        '7.7',
        'with host-a still drained, placement works again only on host-b after the skew is fixed',
        okAccepted && okRun !== undefined && okRun.row.host_id === B,
        `create=${short(ok)} host=${okRun?.row.host_id ?? 'none'}`
      )
      report.check(
        '7.8',
        'the post-correction instance is pinned to host-b and its guest serves the team flag',
        okIdentity !== undefined &&
          guestFlag(B, okIdentity.guestIp) === flagFor('skew-ok', CHAL),
        `id=${okRun?.row.id ?? 'none'} host=${okRun?.row.host_id ?? 'none'}`
      )
      await adminRequest('POST', `/v1/hosts/${A}/undrain`)
      report.check(
        '7.9',
        'host-a is undrained only after host-b proved it can take and serve a placement',
        (await hostSummary(A))?.health === 'healthy',
        (await hostSummary(A))?.health
      )
      await deleteAndWait('skew-ok', CHAL)
      await waitControllerEmpty()
      await waitAgentsClean()
    }
  )
}

const scenarioTokenMismatch = async (): Promise<void> => {
  await report.group(
    '10',
    "one host's agent token wrong: rejected by that agent and surfaced as unhealthy",
    async () => {
      const beforeSeen = (await dbHost(B))?.last_seen_ms
      await restartController('badtoken', 'SIGTERM')
      const unhealthyMs = await waitHostHealth(B, 'unhealthy', 30_000)
      report.check(
        '10.1',
        'the host with the wrong token becomes unhealthy while the other stays healthy',
        unhealthyMs <= 25_000 &&
          (await hostSummary(A))?.health === 'healthy' &&
          (await hostSummary(B))?.health === 'unhealthy',
        `unhealthy after ~${unhealthyMs}ms hostA=${(await hostSummary(A))?.health}`
      )
      // "No successful heartbeat" must mean the timestamp stopped advancing,
      // not merely that health is unhealthy: capture it twice while the wrong
      // token is in use and compare with the pre-restart value.
      const dbB1 = await dbHost(B)
      await sleep(3_000)
      const dbB2 = await dbHost(B)
      const seen1 = dbB1?.last_seen_ms ?? null
      const seen2 = dbB2?.last_seen_ms ?? null
      report.check(
        '10.2',
        'the controller never records a successful heartbeat for the mismatched host (last_seen_ms is frozen while the wrong token is in use)',
        dbB2 !== undefined &&
          dbB2.health === 'unhealthy' &&
          seen1 !== null &&
          seen2 !== null &&
          seen1 === seen2 &&
          // The old controller may have written one last heartbeat between the
          // capture and SIGTERM; the bad-token controller must not add any.
          (beforeSeen === null ||
            beforeSeen === undefined ||
            seen2 - beforeSeen <= 3_000),
        `health=${dbB2?.health} before=${beforeSeen ?? 'null'} first=${seen1 ?? 'null'} second=${seen2 ?? 'null'} advance=${seen1 === null || seen2 === null ? 'n/a' : seen2 - seen1}`
      )
      const directB = await agentInfo(B)
      report.check(
        '10.3',
        "the agent itself is healthy and accepting with its real token (the mismatch is the controller's)",
        directB.accepting === true && directB.checks?.recovered === true,
        short({
          accepting: directB.accepting,
          recovered: directB.checks?.recovered,
        })
      )
      const created = await create('tok-a', CHAL)
      report.check(
        '10.4',
        'creates avoid the mismatched host and land on host-a',
        isDetails(created) && rowsFor('tok-a', CHAL)[0]?.host_id === A,
        short(created)
      )
      await waitRunning('tok-a', CHAL)
      const logText = remoteOut(
        A,
        `grep -Eic 'unauthorized|invalid or missing bearer' /home/ubuntu/mh-controller/controller-badtoken.log || true`
      )
      report.check(
        '10.5',
        'the rejection is surfaced in the controller log',
        Number(logText) > 0,
        `matchingLines=${logText}`
      )
      await restartController('normal', 'SIGTERM')
      await waitHostsHealthy(90_000)
      report.check(
        '10.6',
        'restoring the correct token makes host-b healthy again',
        (await hostSummary(B))?.health === 'healthy',
        (await hostSummary(B))?.health
      )
      await deleteAndWait('tok-a', CHAL)
      await waitControllerEmpty()
      await waitAgentsClean()
    }
  )
}

// ---------------------------------------------------------------------------
// Ambiguous creates: fencing and adoption through an in-guest fault proxy
// ---------------------------------------------------------------------------

const FAULT_DIR = '/home/ubuntu/mh-controller'
const FAULT_PROXY = 'deploy/firecracker/multihost/faultproxy.ts'

interface CapturedCreate {
  id: string
  method: string
  target: string
  headers: Record<string, string>
  bodyBase64: string
}

const startFaultProxy = async (): Promise<number> => {
  remoteOut(A, `rm -f ${FAULT_DIR}/faultproxy.*`)
  const out = remoteOut(
    A,
    `cd /opt/rctf-firecracker && ` +
      `{ setsid /usr/local/bin/bun ${FAULT_PROXY} ${B_IP} 7001 ${FAULT_DIR} ` +
      `</dev/null >>${FAULT_DIR}/faultproxy.log 2>&1 & } ; ` +
      `for i in $(seq 1 150); do [ -s ${FAULT_DIR}/faultproxy.port ] && break; sleep 0.1; done; ` +
      `cat ${FAULT_DIR}/faultproxy.port 2>/dev/null || true`,
    60_000
  )
  const port = Number(out.trim())
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `fault proxy did not start: ${short(out)}; log: ${short(
        remoteOut(
          A,
          `tail -20 ${FAULT_DIR}/faultproxy.log 2>/dev/null || true`
        ),
        600
      )}`
    )
  }
  return port
}

const stopFaultProxy = async (): Promise<void> => {
  try {
    remoteOut(
      A,
      `if [ -f ${FAULT_DIR}/faultproxy.pid ]; then kill "$(cat ${FAULT_DIR}/faultproxy.pid)" 2>/dev/null || true; fi`
    )
    await sleep(300)
  } finally {
    remoteOut(A, `rm -f ${FAULT_DIR}/faultproxy.mode`)
  }
}

const armFault = async (
  fault: 'hold-request' | 'drop-response'
): Promise<void> => {
  remoteOut(A, `printf '%s' ${fault} > ${FAULT_DIR}/faultproxy.mode`)
  // The proxy polls the mode file every 50ms; let it arm before the create.
  await sleep(250)
}

const readCaptured = (): CapturedCreate[] => {
  try {
    const text = remoteOut(
      A,
      `cat ${FAULT_DIR}/faultproxy.captured.json 2>/dev/null || true`
    )
    if (text.trim() === '') return []
    return JSON.parse(text) as CapturedCreate[]
  } catch {
    return []
  }
}

const readForwarded = (): string[] => {
  try {
    const text = remoteOut(
      A,
      `cat ${FAULT_DIR}/faultproxy.forwarded.json 2>/dev/null || true`
    )
    if (text.trim() === '') return []
    return JSON.parse(text) as string[]
  } catch {
    return []
  }
}

/** Replay the captured create straight to host-b's agent (not the proxy). */
const replayCapturedCreate = (captured: CapturedCreate): number => {
  const out = remoteOut(
    A,
    `set -a; . ${CONTROLLER_ENV}; set +a; ` +
      `curl -sS -m 10 -X ${captured.method} ` +
      `-H "Authorization: Bearer $FIRECRACKER_HOST_TOKEN_HOST_B" ` +
      `-H 'Content-Type: application/json' ` +
      `--data-binary @${FAULT_DIR}/faultproxy.replay.body ` +
      `-w '\\n%{http_code}' http://${B_IP}:7001${captured.target}`,
    30_000
  )
  const lines = out.trimEnd().split('\n')
  return Number(lines[lines.length - 1]?.trim() ?? 0)
}

const scenarioAmbiguousCreate = async (): Promise<void> => {
  await report.group(
    '11',
    'ambiguous create: a held create is fenced and a response-swallowed create is adopted',
    async () => {
      let proxyStarted = false
      let controllerOnProxy = false
      try {
        await adminRequest('POST', `/v1/hosts/${A}/undrain`)
        await adminRequest('POST', `/v1/hosts/${B}/undrain`)
        await waitHostsHealthy(90_000)
        await waitControllerEmpty()
        await waitAgentsClean()

        const port = await startFaultProxy()
        proxyStarted = true
        const proxyYaml = `${FAULT_DIR}/controller-proxy.yaml`
        remoteOut(
          A,
          `sed 's#url: http://${B_IP}:7001#url: http://127.0.0.1:${port}#' ${CONTROLLER_YAML} > ${proxyYaml}`
        )
        const rewritten = Number(
          remoteOut(
            A,
            `grep -c 'url: http://127.0.0.1:${port}' ${proxyYaml} || true`
          )
        )
        await restartController('normal', 'SIGTERM', proxyYaml)
        controllerOnProxy = true
        await waitHostsHealthy(90_000)
        report.check(
          '11.1',
          'the controller reaches host-b only through the in-guest fault proxy and both hosts are healthy',
          rewritten === 1 && (await hostSummary(B))?.health === 'healthy',
          `rewritten=${rewritten} proxyPort=${port}`
        )

        // --- hold-request: nothing reaches the agent; the fence must fire.
        await adminRequest('POST', `/v1/hosts/${A}/drain`)
        await armFault('hold-request')
        const held = await create('fence-hold', CHAL)
        const heldRows = rowsFor('fence-hold', CHAL)
        const heldRow = heldRows[0]
        report.check(
          '11.2',
          'the held create is ambiguous: the controller keeps exactly one creating row pinned to host-b and answers starting',
          heldRows.length === 1 &&
            heldRow !== undefined &&
            heldRow.state === 'creating' &&
            heldRow.host_id === B &&
            isDetails(held) &&
            held.status === 'starting',
          `response=${short(held)} rows=${short(
            heldRows.map(row => `${row.id}@${row.host_id}:${row.state}`)
          )}`
        )
        if (heldRow === undefined) {
          throw new Error('no creating row for fence-hold')
        }
        const captured = await waitFor(
          'the held create request is captured',
          () => readCaptured(),
          requests => requests.length === 1,
          20_000,
          200
        )
        const heldId = heldRow.id
        report.check(
          '11.3',
          'the create request was captured instead of delivered: no agent record or VM for the id on either host',
          captured[0]?.id === heldId &&
            (await agentList(B)).every(instance => instance.id !== heldId) &&
            (await agentList(A)).every(instance => instance.id !== heldId) &&
            probeAgentState(B, heldId).exists === false,
          `captured=${captured[0]?.id} row=${heldId}`
        )
        const fenced = await waitForTrue(
          'the reconciler fences the ambiguous create',
          () => rowsFor('fence-hold', CHAL).length === 0,
          45_000,
          500
        )
          .then(() => true)
          .catch(() => false)
        report.check(
          '11.4',
          'after createFenceSeconds the reconciler fences the id and removes the row (the key is freed)',
          fenced,
          `rows=${rowsFor('fence-hold', CHAL).length}`
        )
        const tombstoned = probeTombstone(B, heldId)
        report.check(
          '11.5',
          'the agent durably tombstoned the fenced id',
          tombstoned === true,
          `tombstone=${tombstoned === undefined ? 'probe error' : tombstoned}`
        )
        const replayCode = replayCapturedCreate(captured[0]!)
        await sleep(1_500)
        const replayStats = probeHostStats(B)
        report.check(
          '11.6',
          'replaying the captured PUT is rejected by the tombstone (HTTP 409) and creates no VM on either host',
          replayCode === 409 &&
            replayStats.ok &&
            replayStats.stats!.instances!.every(
              instance => instance.id !== heldId
            ) &&
            probeAgentState(B, heldId).exists === false &&
            (await agentList(A)).every(instance => instance.id !== heldId),
          `replayHTTP=${replayCode} agentB=${short(
            replayStats.stats?.instances?.map(instance => instance.id) ??
              replayStats.error
          )}`
        )
        const recreated = await create('fence-hold', CHAL)
        const recreatedRun = await waitRunning('fence-hold', CHAL)
        report.check(
          '11.7',
          'fencing freed the key: the same team gets a fresh instance with a different id on host-b',
          isDetails(recreated) &&
            recreatedRun.row.id !== heldId &&
            recreatedRun.row.host_id === B,
          `old=${heldId} new=${recreatedRun.row.id} host=${recreatedRun.row.host_id}`
        )
        await deleteAndWait('fence-hold', CHAL)

        // --- drop-response: the VM exists but the response is swallowed.
        await armFault('drop-response')
        const adoptedCreate = await create('fence-adopt', CHAL)
        const adoptRows = rowsFor('fence-adopt', CHAL)
        const adoptRow = adoptRows[0]
        const forwarded = await waitFor(
          'the create was forwarded upstream',
          () => readForwarded(),
          ids => ids.length === 1,
          20_000,
          200
        )
        report.check(
          '11.8',
          'the response-swallowed create is ambiguous: the controller answered starting, the VM exists on host-b, and the id matches the forwarded request',
          isDetails(adoptedCreate) &&
            adoptedCreate.status === 'starting' &&
            adoptRows.length === 1 &&
            adoptRow !== undefined &&
            adoptRow.host_id === B &&
            forwarded[0] === adoptRow.id &&
            (await agentList(B)).some(instance => instance.id === adoptRow.id),
          `response=${short(adoptedCreate)} row=${adoptRow?.id} forwarded=${short(
            forwarded
          )}`
        )
        if (adoptRow === undefined) {
          throw new Error('no creating row for fence-adopt')
        }
        const adopted = await waitRunning('fence-adopt', CHAL, 60_000)
        const adoptedIdentity = requireIdentity(B, adopted.row.id)
        report.check(
          '11.9',
          'the reconciler adopts the existing VM: same id, running, pinned to host-b, one row and no duplicate on host-a',
          adopted.row.id === adoptRow.id &&
            adopted.row.host_id === B &&
            (await agentList(B)).filter(instance => instance.id === adoptRow.id)
              .length === 1 &&
            (await agentList(A)).every(
              instance => instance.id !== adoptRow.id
            ) &&
            rowsFor('fence-adopt', CHAL).length === 1,
          `id=${adopted.row.id} host=${adopted.row.host_id}`
        )
        report.check(
          '11.10',
          'the adopted instance serves its flag from host-b',
          guestFlag(B, adoptedIdentity.guestIp) ===
            flagFor('fence-adopt', CHAL),
          `guest=${adoptedIdentity.guestIp}`
        )
        await deleteAndWait('fence-adopt', CHAL)
      } finally {
        try {
          if (proxyStarted) await stopFaultProxy()
        } catch {
          // best effort
        }
        try {
          if (controllerOnProxy) {
            await restartController('normal', 'SIGTERM')
            await waitHostsHealthy(90_000)
          }
        } catch {
          // best effort
        }
        try {
          await adminRequest('POST', `/v1/hosts/${A}/undrain`)
        } catch {
          // best effort
        }
      }
    }
  )
}

// ---------------------------------------------------------------------------
// Agent restart with a live VM: systemctl restart, then kill -9
// ---------------------------------------------------------------------------

const scenarioAgentRestart = async (): Promise<void> => {
  await report.group(
    '12',
    'agent restart with a live VM: re-adoption keeps the same Firecracker pid and host pinning',
    async () => {
      await adminRequest('POST', `/v1/hosts/${A}/undrain`)
      await adminRequest('POST', `/v1/hosts/${B}/undrain`)
      await waitHostsHealthy(90_000)
      await waitControllerEmpty()
      await waitAgentsClean()

      const created = await create('agent-rst', CHAL)
      if (!isDetails(created)) throw new Error(`create: ${short(created)}`)
      const running = await waitRunning('agent-rst', CHAL)
      const identity = requireIdentity(running.row.host_id, running.row.id)
      const rowHost = running.row.host_id
      report.check(
        '12.1',
        'the live instance is placed on host-a before the agent restarts',
        rowHost === A,
        rowHost
      )

      const waitAgentBack = async (): Promise<void> => {
        await waitForTrue(
          'the restarted agent re-adopts the live instance',
          async () => {
            try {
              const info = await agentInfo(rowHost)
              return (
                info.accepting === true &&
                info.checks?.recovered === true &&
                (await agentList(rowHost)).some(
                  instance => instance.id === running.row.id
                )
              )
            } catch {
              return false
            }
          },
          180_000,
          500
        )
        await waitHostHealth(rowHost, 'healthy', 90_000)
      }

      remoteOut(rowHost, 'sudo systemctl restart rctf-firecracker-agent')
      await waitAgentBack()
      const afterRestart = probeAgentState(rowHost, running.row.id)
      const pidAfterRestart = Number(
        (afterRestart.record?.vm as { pid?: number } | undefined)?.pid ?? 0
      )
      const fcAfterRestart = probeFirecracker(rowHost)
      report.check(
        '12.2',
        'systemctl restart re-adopts the same VM (same Firecracker pid, same instance id)',
        afterRestart.ok &&
          afterRestart.exists === true &&
          pidAfterRestart === identity.pid &&
          fcAfterRestart.ok &&
          fcLineForId(fcAfterRestart.lines!, running.row.id) !== undefined,
        `pidBefore=${identity.pid} pidAfter=${pidAfterRestart} state=${short(
          afterRestart.error ?? afterRestart.exists
        )}`
      )
      report.check(
        '12.3',
        'after systemctl restart the guest still serves its flag and the controller keeps exactly one row pinned to host-a',
        guestFlag(rowHost, identity.guestIp) === flagFor('agent-rst', CHAL) &&
          rowsFor('agent-rst', CHAL).length === 1 &&
          rowsFor('agent-rst', CHAL)[0]?.host_id === rowHost &&
          rowsFor('agent-rst', CHAL)[0]?.id === running.row.id,
        `rows=${short(rowsFor('agent-rst', CHAL).map(row => `${row.id}@${row.host_id}:${row.state}`))}`
      )

      const mainPid = Number(
        remoteOut(
          rowHost,
          'systemctl show -p MainPID --value rctf-firecracker-agent'
        )
      )
      report.check(
        '12.4a',
        'the agent main pid was readable before kill -9',
        Number.isInteger(mainPid) && mainPid > 0,
        `mainPid=${mainPid}`
      )
      remoteOut(rowHost, `sudo kill -9 ${mainPid}`)
      await waitForTrue(
        'systemd restarted the agent after kill -9',
        async () => {
          try {
            const pid = Number(
              remoteOut(
                rowHost,
                'systemctl show -p MainPID --value rctf-firecracker-agent'
              )
            )
            if (pid <= 0 || pid === mainPid) return false
            const info = await agentInfo(rowHost)
            return info.accepting === true && info.checks?.recovered === true
          } catch {
            return false
          }
        },
        180_000,
        500
      )
      await waitHostHealth(rowHost, 'healthy', 90_000)
      const afterKill = probeAgentState(rowHost, running.row.id)
      const pidAfterKill = Number(
        (afterKill.record?.vm as { pid?: number } | undefined)?.pid ?? 0
      )
      report.check(
        '12.4b',
        'after kill -9 systemd restarts the agent and it re-adopts the same Firecracker pid',
        afterKill.ok &&
          afterKill.exists === true &&
          pidAfterKill === identity.pid,
        `pidBefore=${identity.pid} pidAfter=${pidAfterKill} state=${short(
          afterKill.error ?? afterKill.exists
        )}`
      )
      report.check(
        '12.5',
        'after the kill the guest still serves and the controller still has exactly one row pinned to host-a',
        guestFlag(rowHost, identity.guestIp) === flagFor('agent-rst', CHAL) &&
          rowsFor('agent-rst', CHAL).length === 1 &&
          rowsFor('agent-rst', CHAL)[0]?.host_id === rowHost &&
          rowsFor('agent-rst', CHAL)[0]?.id === running.row.id,
        `rows=${short(rowsFor('agent-rst', CHAL).map(row => `${row.id}@${row.host_id}:${row.state}`))}`
      )

      const other = await create('agent-rst-2', CHAL)
      const otherRun = await waitRunning('agent-rst-2', CHAL)
      report.check(
        '12.6',
        'a new create after both restarts still spreads to host-b; the existing instance stays pinned to host-a',
        isDetails(other) &&
          otherRun.row.host_id === B &&
          rowsFor('agent-rst', CHAL)[0]?.host_id === A,
        `new=${otherRun.row.host_id} existing=${rowsFor('agent-rst', CHAL)[0]?.host_id}`
      )
      await deleteAllTeams([
        { team: 'agent-rst', chal: CHAL },
        { team: 'agent-rst-2', chal: CHAL },
      ])
      await waitControllerEmpty()
      await waitAgentsClean()
    }
  )
}

// ---------------------------------------------------------------------------
// Leftovers
// ---------------------------------------------------------------------------

let cleanupFailures = 0

const leftovers = async (): Promise<void> => {
  report.line('\n== leftovers')
  let statsA: HostStats | undefined
  let statsB: HostStats | undefined
  let allRows: DbRow[] = []
  let rowsProbeError: string | undefined
  try {
    await globalCleanup()
  } catch (error) {
    cleanupFailures += 1
    report.line(`cleanup warning: ${errorMessage(error)}`)
  }
  try {
    await stopController()
  } catch {
    // VM stop in run.sh is the final backstop
  }
  try {
    statsA = hostStats(A)
    statsB = hostStats(B)
  } catch (error) {
    report.line(`host stats unavailable: ${errorMessage(error)}`)
  }
  try {
    allRows = rows()
  } catch (error) {
    rowsProbeError = errorMessage(error)
  }
  report.line(
    `controller rows: ${allRows.length === 0 ? 'none' : allRows.map(row => `${row.team_id}/${row.challenge_integration_id}@${row.host_id}:${row.state}`).join(',')}`
  )
  for (const [host, stats] of [
    [A, statsA],
    [B, statsB],
  ] as const) {
    report.line(
      `${host}: instances=${
        stats?.instances === null || stats?.instances === undefined
          ? 'PROBE FAILED'
          : stats.instances.length
      } firecracker=${stats?.firecrackerProcs ?? '?'} taps=${
        stats?.taps ?? '?'
      } stateRecords=${stats?.stateRecords ?? '?'} nftLeases=${
        stats?.nftLeaseRules ?? '?'
      }`
    )
  }
  report.check(
    'L.1',
    'no controller instance rows remain (the SQLite dump succeeded)',
    rowsProbeError === undefined && allRows.length === 0,
    rowsProbeError === undefined
      ? `${allRows.length} rows`
      : `row dump failed: ${short(rowsProbeError, 200)}`
  )
  report.check(
    'L.2',
    'no instance remains on either agent',
    (statsA?.instances?.length ?? -1) === 0 &&
      (statsB?.instances?.length ?? -1) === 0,
    `a=${statsA?.instances?.length} b=${statsB?.instances?.length}`
  )
  report.check(
    'L.3',
    'no Firecracker process or tap was leaked on either host',
    statsA !== undefined &&
      statsB !== undefined &&
      statsA.firecrackerProcs === 0 &&
      statsB.firecrackerProcs === 0 &&
      statsA.taps === 0 &&
      statsB.taps === 0,
    `fcA=${statsA?.firecrackerProcs} fcB=${statsB?.firecrackerProcs} tapsA=${statsA?.taps} tapsB=${statsB?.taps}`
  )
  report.check(
    'L.4',
    'no agent state record was left behind on either host',
    statsA !== undefined &&
      statsB !== undefined &&
      statsA.stateRecords === 0 &&
      statsB.stateRecords === 0,
    `a=${statsA?.stateRecords} b=${statsB?.stateRecords}`
  )
  report.check(
    'L.5',
    'no per-lease nftables rule was left behind on either host',
    statsA !== undefined &&
      statsB !== undefined &&
      statsA.nftLeaseRules === 0 &&
      statsB.nftLeaseRules === 0,
    `a=${statsA?.nftLeaseRules} b=${statsB?.nftLeaseRules}`
  )
  report.check(
    'L.6',
    'instance cleanup completed without swallowed errors',
    cleanupFailures === 0,
    `failures=${cleanupFailures}`
  )
  // Surface probe failures as failures, not silent zeroes.
  report.check(
    'L.7',
    'both agents still answered observation requests at the end',
    statsA !== undefined &&
      statsB !== undefined &&
      statsA.httpCode === 200 &&
      statsB.httpCode === 200,
    `a=${statsA?.httpCode} b=${statsB?.httpCode}`
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let shuttingDown = false

const finish = async (code: number): Promise<never> => {
  if (!shuttingDown) {
    shuttingDown = true
    try {
      await leftovers()
    } catch (error) {
      report.fail('L', 'leftover report failed', errorMessage(error))
    }
    report.summary()
    report.writeJson(RESULTS_JSON)
  }
  process.exit(report.failed === 0 ? 0 : Math.max(1, code))
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    report.line(`\nreceived ${signal}; cleaning up`)
    void finish(128 + (signal === 'SIGTERM' ? 15 : 2))
  })
}

const main = async (): Promise<void> => {
  report.line(`multi-host run dir: ${RUN}`)
  report.line(`repo:    ${REPO}`)
  report.line(`artifacts: ${ARTIFACTS}`)
  report.line(`host-a:  ${A_IP} (ssh port ${A_SSH})`)
  report.line(`host-b:  ${B_IP} (ssh port ${B_SSH})`)
  report.line(`controller API: ${CONTROLLER}`)

  await startController('normal')
  await waitHostsHealthy(90_000)

  await scenarioHosts()
  await scenarioSpread()
  await scenarioDrain()
  await scenarioCapacity()
  await scenarioIsolation()
  await scenarioControllerRestart()
  await scenarioPartition()
  await scenarioHostLoss()
  await scenarioClockSkew()
  await scenarioTokenMismatch()
  await scenarioAmbiguousCreate()
  await scenarioAgentRestart()
}

try {
  await main()
} catch (error) {
  report.fail('setup', 'harness setup failed', errorMessage(error))
}
await finish(report.failed === 0 ? 0 : 1)
