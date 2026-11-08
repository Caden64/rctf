import { readdir, readFile } from 'node:fs/promises'
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

/** True when the process still exists and is the one we captured (pid-reuse safe). */
export const processMatches = async (
  pid: number,
  startTicks: number
): Promise<boolean> => (await readStartTicks(pid)) === startTicks

export const pidExists = async (pid: number): Promise<boolean> =>
  (await readStartTicks(pid)) !== undefined

/** True when two cmdlines describe Firecracker (or its jailer) for `instanceId`. */
export const cmdlineMatchesInstance = (
  argv: readonly string[],
  instanceId: string
): boolean => {
  if (argv.length === 0) return false
  const joined = argv.join(' ').toLowerCase()
  if (!joined.includes('firecracker')) return false
  // Firecracker itself is started as `--id <id>`; the jailer forwards
  // `--id=<id>`.
  return argv.includes(instanceId) || argv.includes(`--id=${instanceId}`)
}

/** The jailer wrapper (as opposed to the Firecracker process it execs). */
export const isJailerCmdline = (argv: readonly string[]): boolean =>
  argv.includes('--exec-file')

export interface FoundProcess {
  pid: number
  startTicks: number
  jailer: boolean
}

/** All live processes whose cmdline is Firecracker (or its jailer) for `instanceId`. */
export const findInstanceProcesses = async (
  instanceId: string
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
    const pid = Number(entry)
    const argv = await readCmdline(pid)
    if (!argv || !cmdlineMatchesInstance(argv, instanceId)) continue
    const startTicks = await readStartTicks(pid)
    if (startTicks === undefined) continue
    found.push({ pid, startTicks, jailer: isJailerCmdline(argv) })
  }
  return found
}

/**
 * Instance ids parsed from running Firecracker processes (`--id <id>`), for
 * orphan cleanup. Unknown ids are included; malformed ones are ignored.
 */
export const listProcessInstanceIds = async (): Promise<string[]> => {
  let entries: string[]
  try {
    entries = await readdir(PROC_ROOT)
  } catch {
    return []
  }
  const ids = new Set<string>()
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue
    const argv = await readCmdline(Number(entry))
    if (!argv) continue
    const joined = argv.join(' ').toLowerCase()
    if (!joined.includes('firecracker')) continue
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === undefined) continue
      const candidate =
        arg === '--id'
          ? argv[i + 1]
          : arg.startsWith('--id=')
            ? arg.slice('--id='.length)
            : undefined
      if (candidate !== undefined && INSTANCE_ID_REGEX.test(candidate)) {
        ids.add(candidate)
      }
    }
  }
  return [...ids].sort()
}
