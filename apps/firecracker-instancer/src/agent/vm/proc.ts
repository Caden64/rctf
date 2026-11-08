import { readFile, readdir, readlink } from 'node:fs/promises'
import path from 'node:path'
import { INSTANCE_ID_REGEX } from '@rctf/firecracker-protocol'

export const PROC_ROOT = '/proc'

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
 * trailing ` (deleted)`. Both are handled by `exeBasenameMatches`.
 */
export const readExe = async (pid: number): Promise<string | undefined> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    return await readlink(`${PROC_ROOT}/${pid}/exe`)
  } catch {
    return undefined
  }
}

const stripDeletedSuffix = (target: string): string =>
  target.endsWith(' (deleted)') ? target.slice(0, -' (deleted)'.length) : target

/**
 * True when the executable really is the canonical binary we launched.
 *
 * The jailer copies/execs the resolved `--exec-file` inside the chroot, so the
 * name we compare is always the realpath basename (not the possibly-symlinked
 * configured path). Accepting only the basename is deliberate: the host-visible
 * `/proc/<pid>/exe` may be the chroot-relative `/firecracker-x.y.z`.
 */
export const exeBasenameMatches = (
  exe: string,
  basenames: ReadonlySet<string>
): boolean => basenames.has(path.basename(stripDeletedSuffix(exe)))

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

export interface ProcessIdentity {
  pid: number
  startTicks: number
  exe: string
  argv: string[]
}

/**
 * One verified scan of a process: start ticks, executable and argv are read
 * together and the ticks are re-read afterwards so a recycled pid cannot slip
 * through. Undefined unless the executable basename is canonical AND the
 * structured `--id <instanceId>` pair is present.
 */
export const inspectProcess = async (
  pid: number,
  exeBasenames: ReadonlySet<string>,
  instanceId: string
): Promise<ProcessIdentity | undefined> => {
  const startTicks = await readStartTicks(pid)
  if (startTicks === undefined) return undefined
  const exe = await readExe(pid)
  if (exe === undefined || !exeBasenameMatches(exe, exeBasenames)) {
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
  exeBasenames: ReadonlySet<string>,
  instanceId: string
): Promise<boolean> => {
  const found = await inspectProcess(pid, exeBasenames, instanceId)
  return found !== undefined && found.startTicks === startTicks
}

export interface FoundProcess {
  pid: number
  startTicks: number
}

/**
 * All live processes that pass the strict identity check for `instanceId`.
 * A process merely mentioning "firecracker" and the id (e.g.
 * `python3 /opt/firecracker-maintenance.py <id>`) never matches.
 */
export const findInstanceProcesses = async (
  instanceId: string,
  exeBasenames: ReadonlySet<string>
): Promise<FoundProcess[]> => {
  let entries: string[]
  try {
    entries = await readdir(PROC_ROOT)
  } catch {
    return []
  }
  const found: FoundProcess[] = []
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue
    const identity = await inspectProcess(
      Number(entry),
      exeBasenames,
      instanceId
    )
    if (identity === undefined) continue
    found.push({ pid: identity.pid, startTicks: identity.startTicks })
  }
  return found
}

/**
 * Instance ids parsed from running processes that pass the strict executable
 * check and carry `--id <id>` as adjacent argv elements. Unknown ids are
 * included; malformed ones are ignored.
 */
export const listProcessInstanceIds = async (
  exeBasenames: ReadonlySet<string>
): Promise<string[]> => {
  let entries: string[]
  try {
    entries = await readdir(PROC_ROOT)
  } catch {
    return []
  }
  const ids = new Set<string>()
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue
    const pid = Number(entry)
    const exe = await readExe(pid)
    if (exe === undefined || !exeBasenameMatches(exe, exeBasenames)) continue
    const argv = await readCmdline(pid)
    if (argv === undefined) continue
    for (let i = 0; i + 1 < argv.length; i += 1) {
      if (argv[i] !== '--id') continue
      const candidate = argv[i + 1]
      if (candidate !== undefined && INSTANCE_ID_REGEX.test(candidate)) {
        ids.add(candidate)
      }
    }
  }
  return [...ids].sort()
}
