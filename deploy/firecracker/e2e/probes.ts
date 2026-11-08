/**
 * Absence probes for the unprivileged e2e harness.
 *
 * Every probe here MUST throw when the underlying command fails. A probe that
 * returns an empty list/text on a non-zero exit makes "no taps / no nft rules
 * are left" vacuously true, so these functions are deliberately strict and
 * are exercised by `selftest.sh` against deliberately broken commands.
 */
import { shell, type ShellResult } from './harness'

export type ShellFn = (argv: string[]) => ShellResult

export const BASE_NFT_TABLES = ['inet rctf_fc', 'arp rctf_fc_arp'] as const

const declareTable = (table: string): string => `table ${table}`

const describe = (result: ShellResult): string =>
  `${result.code}: ${result.stderr.trim() || result.stdout.trim() || 'no output'}`

/** Tun/tap devices in this network namespace; throws if `ip` fails. */
export const tapsInNetns = (run: ShellFn = shell): string[] => {
  const result = run(['ip', '-o', 'link', 'show', 'type', 'tun'])
  if (result.code !== 0) {
    throw new Error(`ip link show type tun failed (${describe(result)})`)
  }
  return result.stdout
    .split('\n')
    .map(line => /^\d+:\s+([^:@]+)[:@]/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined && name.length > 0)
}

/** All nftables table names; throws if `nft` fails. */
export const nftTables = (run: ShellFn = shell): string[] => {
  const result = run(['nft', 'list', 'tables'])
  if (result.code !== 0) {
    throw new Error(`nft list tables failed (${describe(result)})`)
  }
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * The full text of the agent's two managed tables. Throws when `nft` fails
 * OR when either base table is missing: an empty result must never be read as
 * "no per-lease rules remain".
 */
export const nftText = (run: ShellFn = shell): string => {
  const tables = nftTables(run)
  const missing = BASE_NFT_TABLES.filter(
    table => !tables.includes(declareTable(table))
  )
  if (missing.length > 0) {
    throw new Error(
      `nft base table(s) missing: ${missing
        .map(declareTable)
        .join(', ')}; tables=${
        tables.length === 0 ? '<none>' : tables.join(', ')
      }`
    )
  }
  const parts: string[] = []
  for (const table of BASE_NFT_TABLES) {
    const result = run(['nft', 'list', 'table', ...table.split(' ')])
    if (result.code !== 0) {
      throw new Error(
        `nft list table ${declareTable(table)} failed (${describe(result)})`
      )
    }
    parts.push(result.stdout)
  }
  return parts.join('\n')
}

export interface LeaseVisibility {
  taps: string[]
  nft: string
  tapPresent: boolean
  nftReferencesTap: boolean
  nftReferencesGuest: boolean
  ok: boolean
  problems: string[]
}

/**
 * Live calibration: while a VM is running its tap must be listed and the
 * nftables text must reference both its tap name and its guest IP. Without
 * this, the post-teardown absence assertions prove nothing.
 */
export const inspectLease = (
  run: ShellFn,
  tap: string,
  guestIp: string
): LeaseVisibility => {
  const taps = tapsInNetns(run)
  const nft = nftText(run)
  const tapPresent = taps.includes(tap)
  const nftReferencesTap = nft.includes(tap)
  const nftReferencesGuest = nft.includes(guestIp)
  const problems: string[] = []
  if (!tapPresent) {
    problems.push(
      `tap ${tap} not listed (taps: ${taps.length === 0 ? '<none>' : taps.join(', ')})`
    )
  }
  if (!nftReferencesTap) problems.push(`nft text does not reference tap ${tap}`)
  if (!nftReferencesGuest) {
    problems.push(`nft text does not reference guest IP ${guestIp}`)
  }
  return {
    taps,
    nft,
    tapPresent,
    nftReferencesTap,
    nftReferencesGuest,
    ok: problems.length === 0,
    problems,
  }
}
