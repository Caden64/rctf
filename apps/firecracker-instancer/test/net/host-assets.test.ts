import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vmConfigSchema } from '../../src/agent/vm/config'

/**
 * Regression for the systemd/jailer mismatch: the VM defaults put the jailer
 * chroot below `/srv/jailer`, while `ProtectSystem=strict` made it read-only.
 * The host assets must stay aligned with `src/agent/vm/config.ts` (which this
 * track does not own, so it is read, not edited).
 */
const repoRoot = join(import.meta.dir, '../../../..')
const hostDir = join(repoRoot, 'deploy/firecracker/host')

const read = (name: string): Promise<string> =>
  readFile(join(hostDir, name), 'utf8')

describe('host assets and VM defaults', () => {
  const vmDefaults = vmConfigSchema.parse({})

  test('systemd keeps the jailer chroot base and run/state dirs writable', async () => {
    const unit = await read('rctf-firecracker-agent.service')
    expect(unit).toContain('ProtectSystem=strict')
    const line = unit
      .split('\n')
      .find(entry => entry.startsWith('ReadWritePaths='))
    expect(line).toBeDefined()
    const paths = (line as string).slice('ReadWritePaths='.length).split(/\s+/)
    expect(paths).toContain(vmDefaults.chrootBase)
    expect(paths).toContain('/var/lib/rctf-firecracker')
    // runDir lives under the state root that is already writable.
    expect(
      paths.some(
        path =>
          vmDefaults.runDir === path || vmDefaults.runDir.startsWith(`${path}/`)
      )
    ).toBe(true)
    // The jailer writes per-VM cgroups; ProtectKernelTunables would block it.
    expect(unit).not.toMatch(/^ProtectKernelTunables=yes$/m)
  })

  test('host setup creates the jailer chroot base', async () => {
    const script = await read('host-setup.sh')
    expect(script).toContain(
      `CHROOT_BASE="\${CHROOT_BASE:-${vmDefaults.chrootBase}}"`
    )
    expect(script).toContain(
      'install -d -m 0700 -o root -g root "${CHROOT_BASE}"'
    )
    expect(script).toContain('command -v conntrack')
  })

  test('README tap example matches the jailer uid/gid defaults', async () => {
    const readme = await read('README.md')
    expect(readme).toContain(`"tapUser": "${vmDefaults.jailUid}"`)
    expect(readme).toContain(`"tapGroup": "${vmDefaults.jailGid}"`)
    expect(readme).toContain(vmDefaults.chrootBase)
    expect(readme).not.toContain('"routesDir"')
    expect(readme).toContain('FC_REAL=1 sudo bun test test/net')
  })
})
