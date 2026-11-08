#!/usr/bin/env bun
/**
 * Mutation sanity check for the absence probes. Run via `selftest.sh`, which
 * wraps this in `unshare -Urn` so the real `ip` probe sees a tap-free netns.
 *
 * Exit code 0 means every probe failed in the way the harness relies on.
 */
import { symlinkSync, unlinkSync } from 'node:fs'
import {
  processAlive,
  readProcCmdline,
  scanFilesContaining,
  shell,
  type ShellResult,
} from './harness'
import { inspectLease, nftText, tapsInNetns } from './probes'

const failures: string[] = []
const pass = (message: string): void => {
  console.log(`PASS selftest: ${message}`)
}
const fail = (message: string): void => {
  failures.push(message)
  console.log(`FAIL selftest: ${message}`)
}

const expectThrow = (name: string, fn: () => unknown): void => {
  try {
    fn()
    fail(`${name}: probe returned instead of throwing`)
  } catch (error) {
    pass(`${name}: threw (${(error as Error).message})`)
  }
}

const failing =
  (what: string) =>
  (argv: string[]): ShellResult => ({
    code: 64,
    stdout: '',
    stderr: `simulated ${what} failure for: ${argv.join(' ')}`,
  })

expectThrow('tap probe rejects a non-zero ip exit', () =>
  tapsInNetns(failing('ip'))
)
expectThrow('nft probe rejects a non-zero nft exit', () =>
  nftText(failing('nft'))
)
expectThrow('nft probe rejects missing base tables', () =>
  nftText(argv => {
    if (argv[0] === 'nft' && argv[2] === 'tables') {
      return { code: 0, stdout: 'table inet rctf_fc\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  })
)

const baseTables = 'table inet rctf_fc\ntable arp rctf_fc_arp\n'
const emptyRuleset = (argv: string[]): ShellResult => {
  if (argv[0] === 'ip') return { code: 0, stdout: '', stderr: '' }
  if (argv[0] === 'nft' && argv[2] === 'tables') {
    return { code: 0, stdout: baseTables, stderr: '' }
  }
  if (argv[0] === 'nft') {
    return {
      code: 0,
      stdout: 'table inet rctf_fc {\n  chain input {\n  }\n}\n',
      stderr: '',
    }
  }
  return { code: 64, stdout: '', stderr: `unexpected: ${argv.join(' ')}` }
}

// No taps at all (a fresh netns): calibration must fail, not pass vacuously.
const noTaps = inspectLease(emptyRuleset, 'fctap0', '10.200.0.2')
if (noTaps.ok) {
  fail('calibration passed with zero taps and no lease references')
} else {
  pass(`calibration fails with zero taps (${noTaps.problems.join('; ')})`)
}

// Real `ip` in the private netns created by selftest.sh: it must run and find
// no taps. If it throws, the probe is broken; if it finds taps, the netns is
// not the clean one this test expects.
try {
  const taps = tapsInNetns()
  if (taps.length === 0) {
    pass('real ip probe succeeds in the tap-free selftest netns (0 taps)')
  } else {
    fail(`real selftest netns unexpectedly has taps: ${taps.join(', ')}`)
  }
} catch (error) {
  fail(
    `real ip probe failed in the selftest netns: ${(error as Error).message}`
  )
}

// A visible lease must pass: this proves the calibration is not always-fail.
const visible = (argv: string[]): ShellResult => {
  if (argv[0] === 'ip') {
    return {
      code: 0,
      stdout:
        '3: fctap0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP\n',
      stderr: '',
    }
  }
  if (argv[0] === 'nft' && argv[2] === 'tables') {
    return { code: 0, stdout: baseTables, stderr: '' }
  }
  if (argv[0] === 'nft') {
    return {
      code: 0,
      stdout:
        'table inet rctf_fc {\n  iifname "fctap0" ip saddr 10.200.0.2 accept\n}\n',
      stderr: '',
    }
  }
  return { code: 64, stdout: '', stderr: `unexpected: ${argv.join(' ')}` }
}
const okVisible = inspectLease(visible, 'fctap0', '10.200.0.2')
if (okVisible.ok) {
  pass('calibration passes when the lease tap and IP are visible')
} else {
  fail(`calibration rejected a visible lease: ${okVisible.problems.join('; ')}`)
}

// ---------------------------------------------------------------------------
// Flag-absence probes must fail closed when the observation itself fails.
// A missing scan root used to return {hits:[],unreadable:[],scanned:0} and a
// missing /proc/<pid>/cmdline used to return '' -- both made
// "the flag is absent" vacuously true.
// ---------------------------------------------------------------------------
expectThrow('scanFilesContaining rejects a nonexistent root', () =>
  scanFilesContaining(
    [`${import.meta.dir}/missing-${crypto.randomUUID()}`],
    'needle'
  )
)
expectThrow(
  'scanFilesContaining rejects a dangling-symlink root (stat fails)',
  () => {
    const link = `/tmp/e2e-selftest-dangling-${crypto.randomUUID()}`
    symlinkSync('/nonexistent/scan-target', link)
    try {
      scanFilesContaining([link], 'needle')
    } finally {
      unlinkSync(link)
    }
  }
)
expectThrow('readProcCmdline rejects a nonexistent pid', () =>
  readProcCmdline(2_147_483_600)
)
if (processAlive(2_147_483_600)) {
  fail('processAlive reports a nonexistent pid as alive')
} else {
  pass('processAlive returns false for a nonexistent pid')
}
const liveScan = scanFilesContaining([import.meta.dir], 'scanFilesContaining')
if (
  liveScan.scanned > 0 &&
  liveScan.hits.length > 0 &&
  liveScan.unreadable.length === 0
) {
  pass(
    `a real scan reads files and finds the needle (scanned=${liveScan.scanned}, hits=${liveScan.hits.length})`
  )
} else {
  fail(
    `a real scan did not behave (scanned=${liveScan.scanned}, hits=${liveScan.hits.length}, unreadable=${liveScan.unreadable.length})`
  )
}

// Keep `shell` referenced so the import documents that the real probe path is
// the same one the harness uses (and to catch accidental type drift).
void shell

if (failures.length > 0) {
  console.error(
    `selftest FAILED: ${failures.length} mutation check(s) did not behave as required`
  )
  process.exit(1)
}
console.log('selftest: all mutation checks passed')
