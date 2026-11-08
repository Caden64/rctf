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
 * host-a and host-b share a private L2 (QEMU socket/multicast) 10.77.0.0/24;
 * the controller and agents speak real HTTP with real per-host bearer tokens.
 *
 * Every assertion here is a real invariant, not a log mirror: instances are
 * observed directly on each agent, guest flags are fetched from the guests,
 * and the controller SQLite is read for ownership/pinning.
 */
import { readFileSync } from 'node:fs'
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
}

const hostStats = (host: string): HostStats =>
  JSON.parse(
    remoteOut(
      host,
      `sudo bash /opt/rctf-firecracker/deploy/firecracker/multihost/hoststats.sh ${ipOf(host)}`
    )
  ) as HostStats

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

const httpFromHost = (
  host: string,
  url: string,
  timeoutSeconds = 5
): { ok: boolean; body: string; code: number } => {
  const result = remote(
    host,
    `curl -sS -m ${timeoutSeconds} -w '\\n%{http_code}' ${url}`,
    30_000
  )
  const raw = result.stdout
  const split = raw.lastIndexOf('\n')
  const code = split === -1 ? 0 : Number(raw.slice(split + 1).trim() || '0')
  return {
    ok: result.code === 0 && code >= 200 && code < 300,
    body: split === -1 ? raw : raw.slice(0, split),
    code,
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
  variant: 'normal' | 'badtoken'
): Promise<void> => {
  const sourceBad = variant === 'badtoken' ? `. ${BADTOKEN_ENV}; ` : ''
  const command =
    `cd /opt/rctf-firecracker && ` +
    `{ set -a; . ${CONTROLLER_ENV}; ${sourceBad}set +a; ` +
    `exec /usr/local/bin/bun apps/firecracker-instancer/src/controller/index.ts ${CONTROLLER_YAML}; } ` +
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
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'
): Promise<void> => {
  await stopController(signal)
  await startController(variant)
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
    }
  )
}

const scenarioSpread = async (): Promise<void> => {
  await report.group(
    '2',
    'placement spreads across both hosts and every instance is pinned to its host',
    async () => {
      const teams = ['spread-1', 'spread-2', 'spread-3', 'spread-4']
      const created: Array<{ team: string; id: string; host: string }> = []
      const expected = [A, B, A, B] // most-free-memory first, ties by host id
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
          `${team} lands on the host the scheduler's spread policy predicts`,
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
      report.check(
        '2.11',
        'the deleted host-a guest is no longer reachable, and the host-b guest serves only its own flag',
        !httpFromHost(A, `http://${identityA.guestIp}:8080/flag.txt`, 3).ok &&
          guestFlag(B, before.guestIp) === flagFor(onB.team, CHAL),
        `deletedGuest=${identityA.guestIp} survivorGuest=${before.guestIp}`
      )
      await deleteAllTeams(
        created
          .filter(entry => entry.team !== onA.team)
          .map(entry => ({ team: entry.team, chal: CHAL }))
      )
      await waitControllerEmpty()
      await waitAgentsClean()
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

      // Atomic reservation: 20 concurrent creates, distinct teams.
      const raceTeams = Array.from(
        { length: 20 },
        (_, index) => `race-${index + 1}`
      )
      const results = await Promise.all(
        raceTeams.map(team => create(team, CHAL))
      )
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
      report.check(
        '3.7',
        'the race never oversubscribed a host (agent listings and controller reservations <= 2 each)',
        hosts.every(host => host.reserved.instances <= 2) &&
          (statsA.instances?.length ?? 0) <= 2 &&
          (statsB.instances?.length ?? 0) <= 2 &&
          statsA.firecrackerProcs <= 2 &&
          statsB.firecrackerProcs <= 2 &&
          statsA.firecrackerProcs + statsB.firecrackerProcs === 4,
        `reserved=${hosts
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
        "the other host's port is not reachable at this host's address (no port crossover)",
        !crossPort1.ok &&
          !crossPort2.ok &&
          crossPort1.body !== aFlag &&
          crossPort2.body !== bFlag,
        `a->b:${aEntry.endpointPort} HTTP ${crossPort1.code}; b->a:${bEntry.endpointPort} HTTP ${crossPort2.code}`
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
      const shortCreatedAt = Date.now()
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
      report.check(
        '6.7',
        "the partitioned host's instance is not silently rescheduled: it reports errored and its row stays pinned to host-b",
        isDetails(longDuring) &&
          longDuring.status === 'errored' &&
          rowsFor('part-long', CHAL)[0]?.host_id === B &&
          (await agentList(B)).some(instance => instance.id === longRun.row.id),
        `get=${short(longDuring)} rowHost=${rowsFor('part-long', CHAL)[0]?.host_id}`
      )
      const shortRowDuring = rowsFor('part-short', CHAL)[0]
      report.check(
        '6.8',
        "the short instance's row is never moved off host-b either",
        shortRowDuring === undefined || shortRowDuring.host_id === B,
        `rowHost=${shortRowDuring?.host_id} state=${shortRowDuring?.state}`
      )

      // Dead-man: the agent must destroy the guest itself at expiresAt+10s,
      // with the controller unable to reach it.
      const shortDeadline = shortCreatedAt + 15_000 + 10_000
      await waitForTrue(
        'agent host-b dead-man destroyed the expired instance',
        () => {
          const stats = hostStats(B)
          return (
            (stats.instances ?? []).every(
              instance => instance.id !== shortRun.row.id
            ) && agentState(B, shortRun.row.id) === undefined
          )
        },
        60_000,
        1_000
      )
      const destroyedAt = Date.now()
      report.check(
        '6.9',
        'host-b destroys the expired guest on its own dead-man deadline while partitioned',
        destroyedAt >= shortDeadline - 3_000 &&
          destroyedAt <= shortDeadline + 25_000,
        `deadline=${shortDeadline} destroyed=${destroyedAt} delta=${destroyedAt - shortDeadline}ms`
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

      const pidRaw = shell([
        VMCTL,
        '--name',
        B,
        '--ssh-port',
        String(B_SSH),
        'pid',
      ])
      const qemuPid = Number(pidRaw.stdout.trim())
      if (!Number.isInteger(qemuPid) || qemuPid <= 0) {
        throw new Error(`could not read host-b qemu pid: ${short(pidRaw)}`)
      }
      process.kill(qemuPid, 'SIGKILL')
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
      report.check(
        '5.5',
        'the instance on the dead host is not rescheduled; it reports errored and its row stays pinned to host-b',
        isDetails(lostDuring) &&
          lostDuring.status === 'errored' &&
          rowsFor('loss', CHAL)[0]?.host_id === B &&
          rowsFor('loss', CHAL)[0]?.state === 'running',
        `get=${short(lostDuring)} row=${short(rowsFor('loss', CHAL)[0])}`
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
          '--mcast',
          must(process.env.MH_MCAST, 'MH_MCAST'),
          '--mac-mgmt',
          '52:54:00:77:0b:00',
          '--mac-priv',
          '52:54:00:77:0b:01',
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
      await adminRequest('POST', `/v1/hosts/${A}/undrain`)
      const ok = await create('skew-ok', CHAL)
      report.check(
        '7.7',
        'placement works again after the skew is fixed',
        isDetails(ok),
        short(ok)
      )
      await waitRunning('skew-ok', CHAL)
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
      const dbB = await dbHost(B)
      report.check(
        '10.2',
        'the controller never records a successful heartbeat for the mismatched host',
        dbB !== undefined && dbB.health === 'unhealthy',
        `health=${dbB?.health}`
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
// Leftovers
// ---------------------------------------------------------------------------

let cleanupFailures = 0

const leftovers = async (): Promise<void> => {
  report.line('\n== leftovers')
  let statsA: HostStats | undefined
  let statsB: HostStats | undefined
  let allRows: DbRow[] = []
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
  } catch {
    allRows = []
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
    'no controller instance rows remain',
    allRows.length === 0,
    `${allRows.length} rows`
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
}

try {
  await main()
} catch (error) {
  report.fail('setup', 'harness setup failed', errorMessage(error))
}
await finish(report.failed === 0 ? 0 : 1)
