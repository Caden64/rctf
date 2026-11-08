/**
 * Rootless unit test for deploy/firecracker/host/host-setup.sh version parsing.
 *
 * Firecracker >= 1.17 prints an extra stdout line after `--version`
 * ("... exiting successfully. exit_code=0"); the old parser returned
 * "1.17.0\nexit_code=0" and rejected a supported binary. The script exposes
 * `--check-version-only`, which parses/compares and exits before any root
 * precondition, so real fake binaries drive the real code path without root.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'deploy',
  'firecracker',
  'host',
  'host-setup.sh'
)

const dirs: string[] = []

const fakeBin = (name: string, body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `rctf-host-setup-${name}-`))
  dirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** Runs the real script's rootless hook with fake binaries. */
const checkVersions = (
  firecrackerOutput: string,
  jailerOutput = 'Jailer v1.17.0',
  minVersion = '1.7.0'
) => {
  // %b so an embedded newline really reaches stdout as a separate line.
  const firecracker = fakeBin(
    'firecracker',
    `printf '%b\\n' ${JSON.stringify(firecrackerOutput)}`
  )
  const jailer = fakeBin(
    'jailer',
    `printf '%b\\n' ${JSON.stringify(jailerOutput)}`
  )
  const result = Bun.spawnSync(['bash', script, '--check-version-only'], {
    env: {
      ...process.env,
      FIRECRACKER_BIN: firecracker,
      JAILER_BIN: jailer,
      MIN_FC_VERSION: minVersion,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('host-setup.sh version parsing', () => {
  test('ignores the extra Firecracker 1.17 log line and keeps 1.17.0', () => {
    // The exact stdout shape of the pinned v1.17.0 artifact (banner + log).
    const result = checkVersions('Firecracker v1.17.0\\nexit_code=0')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('firecracker 1.17.0\njailer 1.17.0\n')
    expect(result.stderr).toBe('')
  })

  test('accepts a plain banner and strips the leading v', () => {
    const result = checkVersions('Firecracker v1.7.0')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('firecracker 1.7.0')
  })

  test('ignores a pre-release suffix on firecracker and jailer', () => {
    const result = checkVersions(
      'Firecracker v1.17.0-rc.1',
      'Jailer v1.17.0-dev+build.9'
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('firecracker 1.17.0\njailer 1.17.0\n')
  })

  test('a version-looking token in a later line cannot leak into the result', () => {
    const result = checkVersions(
      'Firecracker v1.17.0\nJailer v9.9.9 (log noise)'
    )
    expect(result.code).toBe(0)
    // The parser reads exactly two lines, one version each.
    expect(result.stdout.trim().split('\n')).toEqual([
      'firecracker 1.17.0',
      'jailer 1.17.0',
    ])
  })

  test('rejects garbage output with a clear error', () => {
    const result = checkVersions('definitely not a version')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('could not read firecracker version')
  })

  test('rejects a version older than the minimum', () => {
    const result = checkVersions('Firecracker v1.6.9', 'Jailer v1.6.9')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'firecracker 1.6.9 is older than the supported minimum 1.7.0'
    )
  })

  test('rejects the extra log line when the banner itself is garbage', () => {
    // A bare log line (no banner) must not be mistaken for a version.
    const result = checkVersions(
      '2026-11-08T18:14:08Z Firecracker exiting successfully. exit_code=0'
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('could not read firecracker version')
  })
})
