/**
 * conntrack-tools integration.
 *
 * A released /30 and its public ports are handed out again (after a reuse
 * quarantine), but netfilter conntrack entries live in their own table: an old
 * DNAT mapping or an established flow keyed on the previous tenant's guest
 * IP/port would still match a blanket `ct state established,related accept`
 * and let the next tenant inherit it. Every release (and every unpublish)
 * therefore deletes the lease's entries in all four directions, plus the
 * public DNAT ports, before the addresses/ports become reusable.
 */
import type { CommandResult, CommandRunner } from '../../interfaces'
import { assertIpv4, assertPort } from './validate'

export interface ConntrackFlushRequest {
  guestIp: string
  /** Public DNAT ports of the lease (tcp/raw exposes). */
  publicPorts?: Iterable<number>
}

const NO_ENTRIES = /0 flow entries have been deleted/i
const DEFAULT_TIMEOUT_MS = 10_000

/** `conntrack -D` exits 1 with "0 flow entries have been deleted" when idle. */
export const isNoEntriesResult = (result: CommandResult): boolean =>
  result.code === 1 && NO_ENTRIES.test(`${result.stdout}\n${result.stderr}`)

/**
 * Exact argv lists to run for one lease. Pure and deterministic (ports are
 * sorted) so tests can assert the command set without a host.
 */
export const conntrackDeleteCommands = (
  request: ConntrackFlushRequest
): string[][] => {
  const guestIp = assertIpv4(request.guestIp)
  const commands: string[][] = [
    ['conntrack', '-D', '--orig-src', guestIp],
    ['conntrack', '-D', '--orig-dst', guestIp],
    ['conntrack', '-D', '--reply-src', guestIp],
    ['conntrack', '-D', '--reply-dst', guestIp],
  ]
  const ports = [...(request.publicPorts ?? [])].sort((a, b) => a - b)
  for (const port of ports) {
    assertPort(port)
    commands.push([
      'conntrack',
      '-D',
      '--orig-port-dst',
      String(port),
      '-p',
      'tcp',
    ])
  }
  return commands
}

/** True when conntrack-tools is installed and runnable. */
export const conntrackAvailable = async (
  runner: CommandRunner
): Promise<boolean> => {
  try {
    const result = await runner.run(['conntrack', '--version'], {
      timeoutMs: 5_000,
    })
    return result.code === 0
  } catch {
    return false
  }
}

/**
 * Flush every conntrack entry of one lease. Absence of matching entries is
 * success; any other failure is thrown so the caller keeps the lease reserved
 * and a retried release really retries.
 */
export const flushConntrack = async (
  runner: CommandRunner,
  request: ConntrackFlushRequest
): Promise<void> => {
  const errors: string[] = []
  for (const argv of conntrackDeleteCommands(request)) {
    let result: CommandResult
    try {
      result = await runner.run(argv, { timeoutMs: DEFAULT_TIMEOUT_MS })
    } catch (error) {
      errors.push(
        `${argv.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`
      )
      continue
    }
    if (result.code === 0 || isNoEntriesResult(result)) {
      continue
    }
    errors.push(
      `${argv.join(' ')} failed (${result.code}): ${
        result.stderr.trim() || result.stdout.trim() || 'no output'
      }`
    )
  }
  if (errors.length > 0) {
    throw new Error(
      `could not flush conntrack entries for ${request.guestIp}: ${errors.join('; ')}`
    )
  }
}
