import { readFile, readdir, readlink, stat } from 'node:fs/promises'
import path from 'node:path'
import { INSTANCE_ID_REGEX } from '@rctf/firecracker-protocol'

export const PROC_ROOT = '/proc'

/** Device + inode of an executable file. This is the identity we authenticate. */
export interface ExeIdentity {
  dev: number
  ino: number
}

/** One trusted executable (and the uid/root it must run with) for an instance. */
export interface ProcessExpectation {
  instanceId: string
  exe: ExeIdentity
  /** The process uid (real/effective/saved/fs) must equal this. */
  uid: number
  /**
   * Jailer mode: `/proc/<pid>/root` must resolve to this host path. A chrooted
   * process exposes its root through `/proc`, so this proves the process lives
   * in the instance's own jail and not somewhere else on the host.
   */
  jailRoot?: string
  /**
   * Test/dev escape only: an unprivileged agent cannot chroot or setuid, so a
   * non-root process legitimately has `/` as its root. The executable must
   * still be the exact jail copy and the uid must still match.
   */
  allowUnchrootedJailer?: boolean
}

/** `/proc/<pid>/stat` field 22 (starttime, clock ticks since boot), or undefined. */
export const readStartTicks = async (
  pid: number
): Promise<number | undefined> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    const raw = await readFile(`${PROC_ROOT}/${pid}/stat`, 'utf8')
    // comm may contain spaces and parentheses: fields restart after the last ')'.
    const close = raw.lastIndexOf(')')
    if (close < 0) return undefined
    const fields = raw
      .slice(close + 1)
      .trim()
      .split(/\s+/)
    // fields[0] is field 3 (state), so field 22 is fields[19].
    const startTicks = Number(fields[19])
    return Number.isSafeInteger(startTicks) && startTicks > 0
      ? startTicks
      : undefined
  } catch {
    return undefined
  }
}

/** argv of a live process, or undefined if it does not exist / cannot be read. */
export const readCmdline = async (
  pid: number
): Promise<string[] | undefined> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    const raw = await readFile(`${PROC_ROOT}/${pid}/cmdline`, 'utf8')
    return raw.split('\0').filter(part => part.length > 0)
  } catch {
    return undefined
  }
}

/**
 * `/proc/<pid>/exe` target, or undefined. A chrooted process (jailer) can show
 * a path relative to its own root; a process whose binary was replaced shows a
 * trailing ` (deleted)`.
 */
export const readExe = async (pid: number): Promise<string | undefined> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    return await readlink(`${PROC_ROOT}/${pid}/exe`)
  } catch {
    return undefined
  }
}

/** Device + inode of a filesystem entry (follows symlinks). */
export const statExeIdentity = async (target: string): Promise<ExeIdentity> => {
  const st = await stat(target)
  return { dev: st.dev, ino: st.ino }
}

/**
 * Device + inode of the process executable. `stat` follows `/proc/<pid>/exe`
 * to the real file, even when the process is chrooted and `readlink` shows a
 * jail-relative path, and even when the binary was unlinked after exec.
 */
export const readExeIdentity = async (
  pid: number
): Promise<ExeIdentity | undefined> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    const st = await stat(`${PROC_ROOT}/${pid}/exe`)
    return { dev: st.dev, ino: st.ino }
  } catch {
    return undefined
  }
}

/**
 * Every uid of a live process (`/proc/<pid>/status` Uid: real/effective/
 * saved/fs). All four must match the expectation: a setuid helper or a process
 * whose credentials differ must not impersonate a jailer child.
 */
export const readProcessUid = async (
  pid: number
): Promise<number | undefined> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    const raw = await readFile(`${PROC_ROOT}/${pid}/status`, 'utf8')
    const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(raw)
    if (match === null) return undefined
    const values = match.slice(1, 5).map(Number)
    if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) {
      return undefined
    }
    if (!values.every(value => value === values[0])) return undefined
    return values[0]
  } catch {
    return undefined
  }
}

const stripDeletedSuffix = (target: string): string =>
  target.endsWith(' (deleted)') ? target.slice(0, -' (deleted)'.length) : target

/** `/proc/<pid>/root` target, or undefined. */
export const readProcRoot = async (
  pid: number
): Promise<string | undefined> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    return stripDeletedSuffix(await readlink(`${PROC_ROOT}/${pid}/root`))
  } catch {
    return undefined
  }
}

/** `/proc/<pid>/cwd` target, or undefined. */
export const readProcCwd = async (pid: number): Promise<string | undefined> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    return stripDeletedSuffix(await readlink(`${PROC_ROOT}/${pid}/cwd`))
  } catch {
    return undefined
  }
}

/** True when `/proc/<pid>/root` is the same directory (device+inode) as `target`. */
export const procRootMatches = async (
  pid: number,
  target: string
): Promise<boolean> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    const [root, expected] = await Promise.all([
      stat(`${PROC_ROOT}/${pid}/root`),
      stat(target),
    ])
    return root.dev === expected.dev && root.ino === expected.ino
  } catch {
    return false
  }
}

/** True when `target` is lexically inside `base` (both absolute). */
const isInside = (base: string, target: string): boolean => {
  const rel = path.relative(base, target)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

const exeInsideJail = (exe: string, jailRoot: string): boolean => {
  const resolved = path.resolve(exe)
  return resolved === jailRoot || isInside(jailRoot, resolved)
}

/** True when `argv` contains the structured pair `--id`, `<instanceId>` (adjacent). */
export const hasInstanceIdArg = (
  argv: readonly string[],
  instanceId: string
): boolean => {
  for (let i = 0; i + 1 < argv.length; i += 1) {
    if (argv[i] === '--id' && argv[i + 1] === instanceId) return true
  }
  return false
}

/** Instance id from the structured `--id <id>` argv pair, if well formed. */
export const instanceIdFromArgv = (
  argv: readonly string[]
): string | undefined => {
  for (let i = 0; i + 1 < argv.length; i += 1) {
    if (argv[i] === '--id' && argv[i + 1] !== undefined) {
      return INSTANCE_ID_REGEX.test(argv[i + 1] as string)
        ? (argv[i + 1] as string)
        : undefined
    }
  }
  return undefined
}

const sameExe = (a: ExeIdentity, b: ExeIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino

export interface ProcessIdentity {
  pid: number
  startTicks: number
  exe: string
  argv: string[]
}

/**
 * One verified scan of a process.
 *
 * Authentication is device+inode of the executable (not its basename), the
 * process uid, and, in jailer mode, `/proc/<pid>/root`. Start ticks are read
 * before and after the other checks so a recycled pid cannot slip through.
 * The basename + `--id` pair alone is NOT identity: any local user can copy a
 * binary to a file named `firecracker`.
 */
export const inspectProcess = async (
  pid: number,
  expectation: ProcessExpectation
): Promise<ProcessIdentity | undefined> => {
  const startTicks = await readStartTicks(pid)
  if (startTicks === undefined) return undefined
  const exeIdentity = await readExeIdentity(pid)
  if (exeIdentity === undefined || !sameExe(exeIdentity, expectation.exe)) {
    return undefined
  }
  const uid = await readProcessUid(pid)
  if (uid === undefined || uid !== expectation.uid) return undefined
  const argv = await readCmdline(pid)
  if (argv === undefined || !hasInstanceIdArg(argv, expectation.instanceId)) {
    return undefined
  }
  const exe = await readExe(pid)
  if (exe === undefined) return undefined
  if (expectation.jailRoot !== undefined) {
    const rootMatches = await procRootMatches(pid, expectation.jailRoot)
    if (!rootMatches) {
      // Test/dev only: an unprivileged agent cannot chroot. Require the exact
      // jail copy (already checked by inode) and that the executable path is
      // inside the jail root.
      if (
        expectation.allowUnchrootedJailer !== true ||
        (await readProcRoot(pid)) !== '/' ||
        !exeInsideJail(exe, expectation.jailRoot)
      ) {
        return undefined
      }
    }
  }
  if ((await readStartTicks(pid)) !== startTicks) return undefined
  return { pid, startTicks, exe, argv }
}

/**
 * Previous-version compatibility: authenticate by executable *basename* +
 * `--id` + start ticks. Only used for handles persisted before the identity
 * fields existed; never used to authorize a new kill when an inode identity is
 * available.
 */
export const inspectProcessLegacy = async (
  pid: number,
  exeBasenames: ReadonlySet<string>,
  instanceId: string
): Promise<ProcessIdentity | undefined> => {
  const startTicks = await readStartTicks(pid)
  if (startTicks === undefined) return undefined
  const exe = await readExe(pid)
  if (exe === undefined) return undefined
  if (!exeBasenames.has(path.basename(stripDeletedSuffix(exe)))) {
    return undefined
  }
  const argv = await readCmdline(pid)
  if (argv === undefined || !hasInstanceIdArg(argv, instanceId)) {
    return undefined
  }
  if ((await readStartTicks(pid)) !== startTicks) return undefined
  return { pid, startTicks, exe, argv }
}

/** True when the live process is still exactly the one identified by pid+ticks. */
export const processMatchesIdentity = async (
  pid: number,
  startTicks: number,
  expectation: ProcessExpectation
): Promise<boolean> => {
  const found = await inspectProcess(pid, expectation)
  return found !== undefined && found.startTicks === startTicks
}

export interface FoundProcess {
  pid: number
  startTicks: number
}

export interface ProcSnapshot {
  pid: number
  startTicks: number
  exe: string
  exeIdentity: ExeIdentity
  uid: number | undefined
  root: string | undefined
  argv: string[]
}

/** All numeric pids currently visible in `/proc`. */
export const listPids = async (): Promise<number[]> => {
  let entries: string[]
  try {
    entries = await readdir(PROC_ROOT)
  } catch {
    return []
  }
  const pids: number[] = []
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue
    pids.push(Number(entry))
  }
  return pids
}

/**
 * A consistent (start ticks read before and after) snapshot of one process, or
 * undefined when it vanished or its executable could not be stat'ed.
 */
export const readProcSnapshot = async (
  pid: number
): Promise<ProcSnapshot | undefined> => {
  const startTicks = await readStartTicks(pid)
  if (startTicks === undefined) return undefined
  const exeIdentity = await readExeIdentity(pid)
  const exe = await readExe(pid)
  const argv = await readCmdline(pid)
  if (exeIdentity === undefined || exe === undefined || argv === undefined) {
    return undefined
  }
  const [uid, root] = await Promise.all([
    readProcessUid(pid),
    readProcRoot(pid),
  ])
  if ((await readStartTicks(pid)) !== startTicks) return undefined
  return { pid, startTicks, exe, exeIdentity, uid, root, argv }
}

/**
 * All live processes that pass the strict identity check for one expectation.
 * A process merely mentioning "firecracker" and the id (e.g.
 * `python3 /opt/firecracker-maintenance.py <id>`) never matches.
 */
export const findInstanceProcesses = async (
  expectation: ProcessExpectation
): Promise<FoundProcess[]> => {
  const found: FoundProcess[] = []
  for (const pid of await listPids()) {
    const identity = await inspectProcess(pid, expectation)
    if (identity === undefined) continue
    found.push({ pid: identity.pid, startTicks: identity.startTicks })
  }
  return found
}
