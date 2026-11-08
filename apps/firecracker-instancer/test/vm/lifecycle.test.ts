import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { VmHandle } from '../../src/interfaces'
import type { VmConfig } from '../../src/agent/vm/config'
import { createVmDriver } from '../../src/agent/vm'
import { findInstanceProcesses, readStartTicks } from '../../src/agent/vm/proc'
import {
  clearFakeEnv,
  canonicalFirecrackerBasename,
  compiledFakeFirecracker,
  directProcessExpectation,
  ensureFakeFirecracker,
  findDirectInstances,
  makeDirs,
  makeImage,
  makeLogger,
  makeRequest,
  makeRunner,
  makeVmConfig,
  newInstanceId,
  setFakeEnv,
  shQuote,
  spawnWithEnv,
  startLiveFake,
} from './helpers'

const roots: string[] = []
const liveProcesses: number[] = []

const setup = async (
  overrides: Partial<VmConfig> = {}
): Promise<{
  root: string
  config: VmConfig
  driver: ReturnType<typeof createVmDriver>
}> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-life-'))
  roots.push(root)
  const dirs = await makeDirs(root)
  const config = await makeVmConfig({ dirs, overrides })
  const driver = createVmDriver(config, {
    runner: makeRunner().runner,
    logger: makeLogger().logger,
    spawn: spawnWithEnv,
  })
  return { root, config, driver }
}

afterEach(() => {
  for (const pid of liveProcesses.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
})

afterAll(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

const waitGone = async (pid: number, timeoutMs = 3000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await readStartTicks(pid)) === undefined) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

describe('handle liveness', () => {
  test('accepts the live process and rejects pid reuse', async () => {
    const { root, config, driver } = await setup()
    const id = newInstanceId()
    const live = await startLiveFake(root, id)
    liveProcesses.push(live.pid)
    try {
      expect(await driver.isAlive(live.handle)).toBe(true)

      // Same pid, different start ticks: a recycled pid must NOT look alive.
      const reused: VmHandle = {
        ...live.handle,
        pidStartTicks: live.handle.pidStartTicks + 1,
      }
      expect(await driver.isAlive(reused)).toBe(false)

      // Survives an adopt round-trip.
      const adopted = await driver.adopt(id)
      expect(adopted).toBeDefined()
      expect(adopted?.pid).toBe(live.pid)
      expect(adopted?.pidStartTicks).toBe(live.handle.pidStartTicks)
      expect(adopted?.apiSocket).toBe(path.join(config.runDir, id, 'api.sock'))
    } finally {
      live.kill()
      await waitGone(live.pid)
    }
    expect(await driver.isAlive(live.handle)).toBe(false)
    expect(await driver.adopt(id)).toBeUndefined()
  })

  test('rejects a live pid whose cmdline is not firecracker', async () => {
    const { config, driver } = await setup()
    const id = newInstanceId()
    const proc = Bun.spawn(['/bin/sleep', '30'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    liveProcesses.push(proc.pid)
    try {
      const ticks = await waitFor(proc.pid)
      expect(
        await driver.isAlive({
          instanceId: id,
          pid: proc.pid,
          pidStartTicks: ticks,
          apiSocket: path.join(config.runDir, id, 'api.sock'),
          dir: path.join(config.runDir, id),
        })
      ).toBe(false)
    } finally {
      proc.kill('SIGKILL')
      await proc.exited
    }
  })

  test('lists run dirs and running firecracker processes, including unknown ids', async () => {
    const { root, config, driver } = await setup()
    const withDir = newInstanceId()
    const noDir = newInstanceId()
    await mkdir(path.join(config.runDir, withDir), { recursive: true })
    const live = await startLiveFake(root, noDir)
    liveProcesses.push(live.pid)
    try {
      const ids = await driver.listInstanceIds()
      expect(ids).toContain(withDir)
      expect(ids).toContain(noDir)
    } finally {
      live.kill()
      await waitGone(live.pid)
    }
  })

  test('matches only the structured --id pair and the canonical executable', async () => {
    const { root, config, driver } = await setup()
    const id = newInstanceId()
    const wrapper = await ensureFakeFirecracker(root)
    const dir = path.join(root, 'live', id)
    await mkdir(dir, { recursive: true })
    const apiSocket = path.join(dir, 'api.sock')

    // Same executable but the old jailer-style `--id=<id>` is not the
    // structured pair Firecracker receives.
    const equalsForm = Bun.spawn(
      [wrapper, `--id=${id}`, '--api-sock', `${apiSocket}.equals`],
      { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }
    )
    liveProcesses.push(equalsForm.pid)
    // A process that merely mentions firecracker and the id must not match.
    const unrelated = Bun.spawn(
      [
        process.execPath,
        '-e',
        'setTimeout(() => undefined, 30000)',
        '--exec-file',
        '/usr/local/bin/firecracker',
        '--id',
        id,
      ],
      { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }
    )
    liveProcesses.push(unrelated.pid)
    const firecracker = Bun.spawn(
      [wrapper, '--id', id, '--api-sock', apiSocket],
      {
        detached: true,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      }
    )
    liveProcesses.push(firecracker.pid)

    try {
      const found = await findDirectInstances(config, id)
      expect(found.map(proc => proc.pid)).toEqual([firecracker.pid])
      expect(await driver.adopt(id)).toBeDefined()
      expect((await driver.adopt(id))?.pid).toBe(firecracker.pid)
      expect(await driver.listInstanceIds()).toContain(id)
    } finally {
      equalsForm.kill('SIGKILL')
      unrelated.kill('SIGKILL')
      firecracker.kill('SIGKILL')
      await equalsForm.exited
      await unrelated.exited
      await firecracker.exited
    }
    expect(config.runDir).toBeDefined()
  })

  test('rejects an impostor that copies the firecracker basename (different inode)', async () => {
    const { root, config, driver } = await setup()
    const id = newInstanceId()
    const binBase = await canonicalFirecrackerBasename(config.firecrackerBin)
    const dir = path.join(root, 'impostor')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const impostor = path.join(dir, binBase)
    await copyFile(await compiledFakeFirecracker(), impostor)
    await chmod(impostor, 0o755)
    const apiSocket = path.join(dir, 'api.sock')
    const proc = Bun.spawn([impostor, '--id', id, '--api-sock', apiSocket], {
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    liveProcesses.push(proc.pid)
    try {
      const ticks = await waitFor(proc.pid)
      const trusted = await directProcessExpectation(config, id)
      expect(await findInstanceProcesses(trusted)).toEqual([])
      // A new-style handle carrying the trusted executable identity must not
      // authenticate the impostor.
      expect(
        await driver.isAlive({
          instanceId: id,
          pid: proc.pid,
          pidStartTicks: ticks,
          apiSocket,
          dir,
          exeDev: trusted.exe.dev,
          exeIno: trusted.exe.ino,
          exePath: '/trusted/firecracker',
          uid: trusted.uid,
        } as VmHandle)
      ).toBe(false)
      expect(await driver.adopt(id)).toBeUndefined()
      // destroy must not kill a process it cannot authenticate.
      await driver.destroy(id)
      expect(await readStartTicks(proc.pid)).toBeDefined()
    } finally {
      try {
        process.kill(proc.pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
  })

  test('rejects a process whose uid or proc root does not match the expectation', async () => {
    const { root, config, driver } = await setup()
    const id = newInstanceId()
    const live = await startLiveFake(root, id)
    liveProcesses.push(live.pid)
    try {
      const trusted = await directProcessExpectation(config, id)
      expect(await findInstanceProcesses(trusted)).toHaveLength(1)
      expect(
        await findInstanceProcesses({ ...trusted, uid: trusted.uid + 1 })
      ).toEqual([])
      expect(
        await findInstanceProcesses({
          ...trusted,
          jailRoot: path.join(root, 'wrong-jail'),
        })
      ).toEqual([])
      expect(await driver.isAlive(live.handle)).toBe(true)
    } finally {
      live.kill()
      await waitGone(live.pid)
    }
  })
})

describe('stop', () => {
  test('sends CtrlAltDel, waits for exit, and is idempotent', async () => {
    const { root, config, driver } = await setup()
    const id = newInstanceId()
    const live = await startLiveFake(root, id)
    liveProcesses.push(live.pid)
    await driver.stop(live.handle, { graceMs: 2000 })
    expect(await waitGone(live.pid)).toBe(true)
    // Storage is kept by stop(); calling it again is a no-op.
    await driver.stop(live.handle, { graceMs: 100 })
    expect(await driver.isAlive(live.handle)).toBe(false)
    expect(config.runDir).toBeDefined()
  })

  test('falls back to SIGKILL after the grace period', async () => {
    const { root, driver } = await setup()
    const id = newInstanceId()
    setFakeEnv(id, { IGNORE_CTRL: '1' })
    const live = await startLiveFake(root, id)
    liveProcesses.push(live.pid)
    try {
      const started = Date.now()
      await driver.stop(live.handle, { graceMs: 150 })
      expect(await waitGone(live.pid)).toBe(true)
      expect(Date.now() - started).toBeGreaterThanOrEqual(100)
    } finally {
      clearFakeEnv(id)
    }
  })

  test('does nothing for a handle that is already dead', async () => {
    const { config, driver } = await setup()
    const id = newInstanceId()
    const proc = Bun.spawn(['/bin/sleep', '0.1'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const ticks = await waitFor(proc.pid)
    await proc.exited
    await driver.stop(
      {
        instanceId: id,
        pid: proc.pid,
        pidStartTicks: ticks,
        apiSocket: path.join(config.runDir, id, 'api.sock'),
        dir: path.join(config.runDir, id),
      },
      { graceMs: 0 }
    )
  })
})

const writeJailer = async (root: string, body: string): Promise<string> => {
  const bin = path.join(root, 'bin', 'jailer')
  await mkdir(path.dirname(bin), { recursive: true, mode: 0o700 })
  await writeFile(bin, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 })
  return bin
}

const copyFakeBinary = async (root: string, name: string): Promise<string> => {
  const dir = path.join(root, 'bin')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, name)
  await copyFile(await compiledFakeFirecracker(), target)
  await chmod(target, 0o755)
  return target
}

const jailerPrelude = `
id=
exec_file=
base=
while [ $# -gt 0 ]; do
  case $1 in
    --id) id=$2; shift 2 ;;
    --exec-file) exec_file=$2; shift 2 ;;
    --chroot-base-dir) base=$2; shift 2 ;;
    *) shift ;;
  esac
done
b=$(basename "$exec_file")
dir=$base/$b/$id/root
mkdir -p "$dir"
cp "$exec_file" "$dir/$b"
chmod 0755 "$dir/$b"
`

describe('stale state, rollback and orphans', () => {
  test('removes stale run/jail state but never a live unrelated process', async () => {
    const { config, driver } = await setup()
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    const staleRun = path.join(config.runDir, id)
    await mkdir(staleRun, { recursive: true })
    await writeFile(path.join(staleRun, 'rootfs.ext4'), 'stale')
    const fcBase = await canonicalFirecrackerBasename(config.firecrackerBin)
    const staleJail = path.join(config.chrootBase, fcBase, id, 'root')
    await mkdir(staleJail, { recursive: true })
    await writeFile(path.join(staleJail, `${fcBase}.pid`), '999999\n')

    // Unrelated process that mentions firecracker and the id in argv.
    const unrelated = Bun.spawn(
      [
        process.execPath,
        '-e',
        'setTimeout(() => undefined, 30000)',
        '/opt/firecracker-maintenance.py',
        '--id',
        id,
      ],
      { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }
    )
    liveProcesses.push(unrelated.pid)
    let handle: VmHandle | undefined
    try {
      handle = await driver.launch(makeRequest(id, 'web-demo'))
      expect(await driver.isAlive(handle)).toBe(true)
      expect(await readStartTicks(unrelated.pid)).toBeDefined()
      expect(await pathExists(path.join(staleJail, `${fcBase}.pid`))).toBe(
        false
      )
    } finally {
      if (handle !== undefined) {
        await driver.stop(handle, { graceMs: 100 }).catch(() => undefined)
      }
      await driver.destroy(id).catch(() => undefined)
      try {
        process.kill(unrelated.pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
  })

  test('refuses to reuse an id that already has a live firecracker', async () => {
    const { root, config, driver } = await setup()
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    const live = await startLiveFake(root, id)
    liveProcesses.push(live.pid)
    try {
      await expect(driver.launch(makeRequest(id, 'web-demo'))).rejects.toThrow(
        /already has a live firecracker/
      )
      expect(await readStartTicks(live.pid)).toBeDefined()
    } finally {
      live.kill()
      await waitGone(live.pid)
    }
  })

  test('rollback scans for a forked Firecracker when the jailer never writes a pid file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-life-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const jailerBin = await writeJailer(
      root,
      `${jailerPrelude}
"$dir/$b" --id "$id" --api-sock "$dir/api.sock" </dev/null >/dev/null 2>&1 &
sleep 0.3
`
    )
    const config = await makeVmConfig({
      dirs,
      overrides: {
        mode: 'jailer',
        jailerBin,
        apiStartTimeoutMs: 300,
        killWaitMs: 3000,
      },
    })
    const driver = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    try {
      await expect(driver.launch(makeRequest(id, 'web-demo'))).rejects.toThrow(
        /pid file|exited/
      )
      expect(await findDirectInstances(config, id)).toEqual([])
      expect(await pathExists(path.join(config.runDir, id))).toBe(false)
      const fcBase = await canonicalFirecrackerBasename(config.firecrackerBin)
      expect(await pathExists(path.join(config.chrootBase, fcBase, id))).toBe(
        false
      )
    } finally {
      await driver.destroy(id).catch(() => undefined)
    }
  })

  test('never kills an unrelated pid found in a stale jailer pid file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-life-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const pidPath = path.join(root, 'unrelated.pid')
    const jailerBin = await writeJailer(
      root,
      `${jailerPrelude}
sleep 300 &
child=$!
printf '%s\\n' "$child" > "$dir/$b.pid"
printf '%s\\n' "$child" > ${shQuote(pidPath)}
`
    )
    const config = await makeVmConfig({
      dirs,
      overrides: {
        mode: 'jailer',
        jailerBin,
        apiStartTimeoutMs: 300,
        killWaitMs: 1000,
      },
    })
    const driver = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    let unrelatedPid: number | undefined
    try {
      await expect(driver.launch(makeRequest(id, 'web-demo'))).rejects.toThrow(
        /pid file|exited/
      )
      unrelatedPid = Number((await readFile(pidPath, 'utf8')).trim())
      expect(await readStartTicks(unrelatedPid)).toBeDefined()
    } finally {
      if (unrelatedPid !== undefined) {
        try {
          process.kill(unrelatedPid, 'SIGKILL')
        } catch {
          // gone
        }
      }
      await driver.destroy(id).catch(() => undefined)
    }
  })

  test('rollback catches a jail child that execs only after the first scan', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-life-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const jailerBin = await writeJailer(
      root,
      `${jailerPrelude}
( sleep 0.03; : > "$base/late-child-$id"; exec "$dir/$b" --id "$id" --api-sock "$dir/api.sock" </dev/null >/dev/null 2>&1 ) &
exit 0
`
    )
    const config = await makeVmConfig({
      dirs,
      overrides: {
        mode: 'jailer',
        jailerBin,
        apiStartTimeoutMs: 300,
        killWaitMs: 3000,
      },
    })
    const driver = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    const jail = path.join(
      config.chrootBase,
      await canonicalFirecrackerBasename(config.firecrackerBin),
      id
    )
    try {
      await expect(driver.launch(makeRequest(id, 'web-demo'))).rejects.toThrow(
        /pid file|exited/
      )
      // The child got as far as exec (marker written just before exec) and was
      // still found and killed by the post-jailer rescan.
      expect(
        await pathExists(path.join(config.chrootBase, `late-child-${id}`))
      ).toBe(true)
      expect(await pathExists(jail)).toBe(false)
      expect(await pathExists(path.join(config.runDir, id))).toBe(false)
      expect(await driver.listInstanceIds()).not.toContain(id)
    } finally {
      await driver.destroy(id).catch(() => undefined)
    }
  })

  test('reports and destroys a jail-only leftover', async () => {
    const { config, driver } = await setup()
    const id = newInstanceId()
    const fcBase = await canonicalFirecrackerBasename(config.firecrackerBin)
    const jail = path.join(config.chrootBase, fcBase, id)
    await mkdir(path.join(jail, 'root'), { recursive: true })
    await writeFile(path.join(jail, 'root', 'vmlinux'), 'leftover')

    expect(await driver.listInstanceIds()).toContain(id)
    await driver.destroy(id)
    expect(await pathExists(jail)).toBe(false)
  })

  test('reports and destroys a cgroup-only leftover', async () => {
    const { config, driver } = await setup()
    const id = newInstanceId()
    const fcBase = await canonicalFirecrackerBasename(config.firecrackerBin)
    const cgroup = path.join(config.cgroupRoot, fcBase, id)
    await mkdir(cgroup, { recursive: true })
    expect(await driver.listInstanceIds()).toContain(id)
    await driver.destroy(id)
    expect(await pathExists(cgroup)).toBe(false)
  })

  test('refuses a symlinked runDir without writing through it', async () => {
    const { root, config, driver } = await setup()
    const outside = path.join(root, 'outside-run')
    await mkdir(outside, { recursive: true })
    await rm(config.runDir, { recursive: true, force: true })
    await symlink(outside, config.runDir)
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    await expect(driver.launch(makeRequest(id, 'web-demo'))).rejects.toThrow(
      /real directory|runDir/
    )
    expect(await pathExists(path.join(outside, id))).toBe(false)
  })

  test('refuses a symlinked jail parent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-life-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const jailerBin = await writeJailer(root, 'exit 0\n')
    const config = await makeVmConfig({
      dirs,
      overrides: { mode: 'jailer', jailerBin },
    })
    const driver = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const fcBase = await canonicalFirecrackerBasename(config.firecrackerBin)
    const outside = path.join(root, 'outside-jail')
    await mkdir(outside, { recursive: true })
    await symlink(outside, path.join(config.chrootBase, fcBase))
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    await expect(driver.launch(makeRequest(id, 'web-demo'))).rejects.toThrow(
      /jail parent|real directory/
    )
    expect(await pathExists(path.join(outside, id))).toBe(false)
  })
})

describe('configured binary changes after a restart', () => {
  test('direct mode: adopt, isAlive, listInstanceIds and destroy use persisted identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-switch-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const binA = await copyFakeBinary(root, 'firecracker-a')
    const binB = await copyFakeBinary(root, 'firecracker-b')
    const configA = await makeVmConfig({
      dirs,
      overrides: { mode: 'direct', firecrackerBin: binA },
    })
    const configB = await makeVmConfig({
      dirs,
      overrides: { mode: 'direct', firecrackerBin: binB },
    })
    const driverA = createVmDriver(configA, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const driverB = createVmDriver(configB, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const id = newInstanceId()
    await makeImage(configA.imagesDir, 'web-demo')
    const handle = await driverA.launch(makeRequest(id, 'web-demo'))
    liveProcesses.push(handle.pid)
    try {
      expect((handle as VmHandle & { exeIno?: number }).exeIno).toBeGreaterThan(
        0
      )
      expect(await driverB.isAlive(handle)).toBe(true)
      const adopted = await driverB.adopt(id)
      expect(adopted?.pid).toBe(handle.pid)
      expect(
        (adopted as (VmHandle & { exeIno?: number }) | undefined)?.exeIno
      ).toBe((handle as VmHandle & { exeIno?: number }).exeIno)
      expect(await driverB.listInstanceIds()).toContain(id)

      await driverB.destroy(id)
      expect(await waitGone(handle.pid)).toBe(true)
      expect(await pathExists(path.join(configB.runDir, id))).toBe(false)
    } finally {
      liveProcesses.push(handle.pid)
      await driverA.destroy(id).catch(() => undefined)
    }
  })

  test('jailer mode: an old-basename jail remains adoptable and destroyable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-switch-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const binA = await copyFakeBinary(root, 'firecracker-a')
    const binB = await copyFakeBinary(root, 'firecracker-b')
    const jailerBin = await writeJailer(
      root,
      `${jailerPrelude}
"$dir/$b" --id "$id" --api-sock "$dir/api.sock" </dev/null >/dev/null 2>&1 &
printf '%s\\n' "$!" > "$dir/$b.pid"
`
    )
    const configA = await makeVmConfig({
      dirs,
      overrides: { mode: 'jailer', firecrackerBin: binA, jailerBin },
    })
    const configB = await makeVmConfig({
      dirs,
      overrides: { mode: 'jailer', firecrackerBin: binB, jailerBin },
    })
    const driverA = createVmDriver(configA, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const driverB = createVmDriver(configB, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const id = newInstanceId()
    await makeImage(configA.imagesDir, 'web-demo')
    const handle = await driverA.launch(makeRequest(id, 'web-demo'))
    liveProcesses.push(handle.pid)
    const oldJail = path.join(configA.chrootBase, 'firecracker-a', id)
    try {
      expect(await pathExists(oldJail)).toBe(true)
      // Simulate the newly configured driver having no marker in runDir: the
      // jail copy itself is the trust anchor.
      await rm(path.join(configA.runDir, id), {
        recursive: true,
        force: true,
      })
      expect(await driverB.listInstanceIds()).toContain(id)
      expect(await driverB.isAlive(handle)).toBe(true)
      const adopted = await driverB.adopt(id)
      expect(adopted?.pid).toBe(handle.pid)
      expect(adopted?.apiSocket).toBe(path.join(oldJail, 'root', 'api.sock'))
      expect(adopted?.dir).toBe(oldJail)

      await driverB.destroy(id)
      expect(await waitGone(handle.pid)).toBe(true)
      expect(await pathExists(oldJail)).toBe(false)
    } finally {
      await driverA.destroy(id).catch(() => undefined)
    }
  })
})

describe('destroy', () => {
  const launchOne = async (
    config: VmConfig,
    driver: ReturnType<typeof createVmDriver>
  ): Promise<{ id: string; handle: VmHandle }> => {
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    const handle = await driver.launch(makeRequest(id, 'web-demo'))
    return { id, handle }
  }

  test('kills a live VM, removes its dir, and is idempotent', async () => {
    const { config, driver } = await setup()
    const { id, handle } = await launchOne(config, driver)
    expect(await driver.isAlive(handle)).toBe(true)

    await driver.destroy(id)
    expect(await driver.isAlive(handle)).toBe(false)
    expect(await findDirectInstances(config, id)).toEqual([])
    expect(await pathExists(path.join(config.runDir, id))).toBe(false)

    await driver.destroy(id)
    await driver.destroy(newInstanceId())
  })

  test('removes partially created state', async () => {
    const { config, driver } = await setup()
    const id = newInstanceId()
    const dir = path.join(config.runDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'rootfs.ext4'), 'partial')
    await driver.destroy(id)
    expect(await pathExists(dir)).toBe(false)
  })

  test('fails destroy when a cgroup cannot be removed (busy/non-empty)', async () => {
    const { config, driver } = await setup()
    const id = newInstanceId()
    const fcBase = await canonicalFirecrackerBasename(config.firecrackerBin)
    const cgroup = path.join(config.cgroupRoot, fcBase, id)
    await mkdir(cgroup, { recursive: true })
    await writeFile(path.join(cgroup, 'cgroup.procs'), '12345\n')
    await expect(driver.destroy(id)).rejects.toThrow(
      /ENOTEMPTY|directory not empty/i
    )
    // The manager keeps the teardown pending and retries; once the cgroup is
    // empty a second destroy succeeds.
    await rm(path.join(cgroup, 'cgroup.procs'))
    await driver.destroy(id)
    expect(await pathExists(cgroup)).toBe(false)
  })

  test('never follows a symlinked instance dir', async () => {
    const { root, config, driver } = await setup()
    const id = newInstanceId()
    const outside = path.join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'keep.txt'), 'keep')
    const link = path.join(config.runDir, id)
    await symlink(outside, link)

    await driver.destroy(id)
    expect(await pathExists(link)).toBe(false)
    expect(await pathExists(path.join(outside, 'keep.txt'))).toBe(true)
  })
})

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

const waitFor = async (pid: number, timeoutMs = 2000): Promise<number> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ticks = await readStartTicks(pid)
    if (ticks !== undefined) return ticks
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for pid ${pid}`)
}
