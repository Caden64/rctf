/**
 * Helpers for the unprivileged provider -> controller -> agent -> Firecracker
 * end-to-end harness. No product code lives here; everything is observation,
 * process control and assertions.
 */
import { Database } from 'bun:sqlite'
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

export const must = (value: string | undefined, name: string): string => {
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable ${name}`)
  }
  return value
}

export const short = (value: unknown, max = 400): string => {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text === undefined) return 'undefined'
  return text.length > max ? `${text.slice(0, max)}...` : text
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// ---------------------------------------------------------------------------
// Assertions / report
// ---------------------------------------------------------------------------

export interface Result {
  id: string
  name: string
  ok: boolean
  detail: string
}

export class Report {
  readonly results: Result[] = []
  private readonly outputFile: string

  constructor(outputFile: string) {
    this.outputFile = outputFile
  }

  line(text: string): void {
    console.log(text)
    appendFileSync(this.outputFile, `${text}\n`)
  }

  private record(id: string, name: string, ok: boolean, detail: string): void {
    this.results.push({ id, name, ok, detail })
    this.line(
      `${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${detail ? ` -- ${detail}` : ''}`
    )
  }

  pass(id: string, name: string, detail = ''): void {
    this.record(id, name, true, detail)
  }

  fail(id: string, name: string, detail = ''): void {
    this.record(id, name, false, detail)
  }

  /** Records one assertion; returns its truth value so callers can gate. */
  check(id: string, name: string, ok: boolean, detail = ''): boolean {
    this.record(id, name, ok, detail)
    return ok
  }

  async group(
    id: string,
    title: string,
    fn: () => Promise<void>
  ): Promise<void> {
    this.line(`\n== ${id}. ${title}`)
    try {
      await fn()
    } catch (error) {
      // A group must never disappear into a log line: print the full exception
      // and record a failure so the driver's exit code is non-zero. Otherwise a
      // crashing scenario would silently reduce the assertion count.
      this.line(
        `\n!! group ${id} aborted: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`
      )
      this.fail(id, `${title} (group aborted)`, errorMessage(error))
    }
  }

  get passed(): number {
    return this.results.filter(result => result.ok).length
  }

  get failed(): number {
    return this.results.filter(result => !result.ok).length
  }

  summary(): void {
    this.line(
      `\nRESULT: ${this.passed} passed, ${this.failed} failed, ${this.results.length} assertions`
    )
    for (const result of this.results.filter(r => !r.ok)) {
      this.line(`  FAILED [${result.id}] ${result.name}: ${result.detail}`)
    }
  }

  writeJson(file: string): void {
    writeFileSync(file, `${JSON.stringify(this.results, null, 2)}\n`)
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export const waitFor = async <T>(
  label: string,
  probe: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      last = await probe()
      if (predicate(last)) return last
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${label}; last=${short(last)}${
      lastError === undefined ? '' : `; error=${errorMessage(lastError)}`
    }`
  )
}

export const waitForTrue = async (
  label: string,
  probe: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<void> => {
  await waitFor(label, probe, value => value === true, timeoutMs, intervalMs)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HttpResult {
  status: number
  text: string
  json: unknown
}

export const httpRequest = async (
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000
): Promise<HttpResult> => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, text, json }
}

// ---------------------------------------------------------------------------
// Controller SQLite (read-only observation)
// ---------------------------------------------------------------------------

export interface ControllerRow {
  id: string
  state: string
  team_id: string
  challenge_integration_id: string
  host_id: string
  expires_at_ms: number
  created_at_ms: number
  updated_at_ms: number
  message: string | null
  endpoints_json: string | null
}

export const readControllerRows = (databasePath: string): ControllerRow[] => {
  if (!existsSync(databasePath)) return []
  // Read-write on purpose: after a SIGKILL the WAL may need recovery, which a
  // strictly read-only connection cannot perform. Only SELECTs are issued.
  const db = new Database(databasePath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return db
      .query(
        `SELECT id, state, team_id, challenge_integration_id, host_id,
                expires_at_ms, created_at_ms, updated_at_ms, message,
                endpoints_json
           FROM instances`
      )
      .all() as ControllerRow[]
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Filesystem observation
// ---------------------------------------------------------------------------

export const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

export const walkFiles = (root: string): string[] => {
  const files: string[] = []
  const visit = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      // A vanished/unreadable directory must not silently truncate the scan:
      // that would make "the flag is absent" vacuous. Propagate instead.
      throw new Error(
        `cannot enumerate directory ${dir}: ${errorMessage(error)}`,
        { cause: error }
      )
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
      } else if (entry.isFile()) {
        try {
          if (statSync(full).isFile()) files.push(full)
        } catch (error) {
          // A file that disappeared between readdir and stat cannot be
          // inspected; fail the scan rather than under-report it.
          throw new Error(`cannot stat ${full}: ${errorMessage(error)}`, {
            cause: error,
          })
        }
      }
    }
  }
  visit(root)
  return files
}

export interface FileScan {
  /** Files whose bytes contain the needle. */
  hits: string[]
  /** Files that could not be read (a vacuous "no hits" is not acceptable). */
  unreadable: string[]
  /** Number of files actually read. */
  scanned: number
}

/**
 * Scan one or more files/directories for `needle`, reporting unreadable files
 * instead of silently skipping them. Callers must treat `unreadable` as a
 * failure: otherwise a permission error makes "the flag is absent" vacuous.
 *
 * Enumeration/stat failures THROW. A missing or unreadable root means the scan
 * did not happen, so returning an empty result would make every absence
 * assertion vacuous; callers must only scan roots they expect to exist.
 */
export const scanFilesContaining = (
  roots: readonly string[],
  needle: string
): FileScan => {
  const bytes = Buffer.from(needle, 'utf8')
  const files: string[] = []
  for (const root of roots) {
    let stat
    try {
      stat = statSync(root)
    } catch (error) {
      throw new Error(`cannot stat scan root ${root}: ${errorMessage(error)}`, {
        cause: error,
      })
    }
    if (stat.isFile()) {
      files.push(root)
    } else if (stat.isDirectory()) {
      files.push(...walkFiles(root))
    } else {
      throw new Error(
        `scan root ${root} is neither a regular file nor a directory`
      )
    }
  }
  const hits: string[] = []
  const unreadable: string[] = []
  let scanned = 0
  for (const file of files) {
    let content: Buffer
    try {
      content = readFileSync(file)
      scanned += 1
    } catch {
      unreadable.push(file)
      continue
    }
    if (content.indexOf(bytes) !== -1) hits.push(file)
  }
  return { hits, unreadable, scanned }
}

/** True when `file` is a regular file this process can actually read. */
export const readableFile = (
  file: string
): { ok: boolean; reason?: string } => {
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return { ok: false, reason: 'not a regular file' }
    accessSync(file, constants.R_OK)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: errorMessage(error) }
  }
}

const fsErrorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined

/**
 * The full argv of `pid` as one string. Throws when it cannot be read: an
 * empty string would make `!cmdline.includes(FLAG)` pass even though no
 * command line was ever observed.
 */
export const readProcCmdline = (pid: number): string => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'latin1').replaceAll('\0', ' ')
  } catch (error) {
    const code = fsErrorCode(error)
    throw new Error(
      `cannot read /proc/${pid}/cmdline${code === undefined ? '' : ` (${code})`}: ${errorMessage(error)}`,
      { cause: error }
    )
  }
}

/**
 * Like `readProcCmdline`, but a process that no longer exists yields
 * `undefined` (a normal race). Any other read error still throws.
 */
export const readProcCmdlineIfAlive = (pid: number): string | undefined => {
  try {
    return readProcCmdline(pid)
  } catch (error) {
    const code = fsErrorCode((error as Error).cause)
    if (code === 'ENOENT' || code === 'ESRCH') return undefined
    throw error
  }
}

/** True when the pid exists AND still looks like the process we recorded. */
export const processAlive = (pid: number, marker?: string): boolean => {
  const cmdline = readProcCmdlineIfAlive(pid)
  if (cmdline === undefined) return false
  if (marker === undefined) return true
  return cmdline.includes(marker)
}

export const tailFile = (file: string, lines = 30): string => {
  try {
    const text = readFileSync(file, 'utf8')
    return text.split('\n').slice(-lines).join('\n')
  } catch {
    return '<no log>'
  }
}

// ---------------------------------------------------------------------------
// Child processes (started by this harness only)
// ---------------------------------------------------------------------------

export interface ManagedProcess {
  name: string
  proc: ReturnType<typeof Bun.spawn>
  pid: number
  logPath: string
  fd: number
  stopped: boolean
}

export const spawnManaged = (options: {
  name: string
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
  logPath: string
}): ManagedProcess => {
  const fd = openSync(options.logPath, 'a')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined) env[key] = value
  }
  const proc = Bun.spawn({
    cmd: options.argv,
    cwd: options.cwd,
    env,
    stdin: 'ignore',
    stdout: fd,
    stderr: fd,
  })
  return {
    name: options.name,
    proc,
    pid: proc.pid,
    logPath: options.logPath,
    fd,
    stopped: false,
  }
}

export const terminate = async (
  managed: ManagedProcess | undefined,
  options: { signal?: NodeJS.Signals; timeoutMs?: number } = {}
): Promise<void> => {
  if (managed === undefined || managed.stopped) return
  managed.stopped = true
  const signal = options.signal ?? 'SIGTERM'
  const timeoutMs = options.timeoutMs ?? 10_000
  try {
    managed.proc.kill(signal)
  } catch {
    // already gone
  }
  const exited = await Promise.race([
    managed.proc.exited.then(() => true).catch(() => true),
    sleep(timeoutMs).then(() => false),
  ])
  if (!exited) {
    try {
      managed.proc.kill('SIGKILL')
    } catch {
      // already gone
    }
    await Promise.race([
      managed.proc.exited.catch(() => undefined),
      sleep(5_000),
    ])
  }
  try {
    closeSync(managed.fd)
  } catch {
    // already closed
  }
}

// ---------------------------------------------------------------------------
// Shell helpers (read-only inspection; never a pkill by name)
// ---------------------------------------------------------------------------

export interface ShellResult {
  code: number
  stdout: string
  stderr: string
}

export const shell = (argv: string[], timeoutMs = 15_000): ShellResult => {
  const result = Bun.spawnSync({
    cmd: argv,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  })
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  }
}

/** PIDs whose full argv contains `needle` (our unique run dir). */
export const pidsMatching = (needle: string): number[] => {
  const result = shell(['pgrep', '-f', '--', needle])
  // pgrep: 0 = matched, 1 = no match, anything else = the probe itself failed.
  // Returning [] for a failed probe would make every absence assertion vacuous.
  if (result.code === 1) return []
  if (result.code !== 0) {
    throw new Error(
      `pgrep -f failed (${result.code}): ${result.stderr.trim() || 'no output'}`
    )
  }
  return result.stdout
    .split('\n')
    .map(line => Number(line.trim()))
    .filter(pid => Number.isInteger(pid) && pid > 0)
}
