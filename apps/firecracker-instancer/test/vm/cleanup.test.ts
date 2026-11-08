import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { VmHandle } from '../../src/interfaces'
import type { VmConfig } from '../../src/agent/vm/config'
import { createVmDriver } from '../../src/agent/vm'
import { readStartTicks } from '../../src/agent/vm/proc'
import {
  compiledFakeFirecracker,
  makeDirs,
  makeImage,
  makeLogger,
  makeRequest,
  makeRunner,
  makeVmConfig,
  newInstanceId,
  spawnWithEnv,
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-clean-'))
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

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

const copyNative = async (root: string, name: string): Promise<string> => {
  const dir = path.join(root, 'bin')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, name)
  await copyFile(await compiledFakeFirecracker(), target)
  await chmod(target, 0o755)
  return target
}

const writeJailer = async (root: string, body: string): Promise<string> => {
  const bin = path.join(root, 'bin', 'jailer')
  await mkdir(path.dirname(bin), { recursive: true, mode: 0o700 })
  await writeFile(bin, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 })
  return bin
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

const startNative = (binary: string, id: string, socket: string): number => {
  const proc = Bun.spawn([binary, '--id', id, '--api-sock', socket], {
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  liveProcesses.push(proc.pid)
  return proc.pid
}

describe('cleanup identity: pre-exec jailer and unrelated processes', () => {
  test('never kills an unrelated process that merely mentions the jail path', async () => {
    const { config, driver } = await setup()
    const id = newInstanceId()
    const fcBase = path.basename(config.firecrackerBin)
    const jailRoot = path.join(config.chrootBase, fcBase, id, 'root')
    await mkdir(jailRoot, { recursive: true, mode: 0o700 })

    // The reproduced leak: a process with the (empty) jail directory as a
    // command-line ARGUMENT was SIGKILLed by destroy(id).
    const unrelated = Bun.spawn(
      [process.execPath, '-e', 'setTimeout(() => undefined, 30000)', jailRoot],
      { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }
    )
    liveProcesses.push(unrelated.pid)
    try {
      await driver.destroy(id)
      expect(await readStartTicks(unrelated.pid)).toBeDefined()
      expect(await pathExists(path.join(config.chrootBase, fcBase, id))).toBe(
        false
      )
    } finally {
      try {
        unrelated.kill('SIGKILL')
      } catch {
        // gone
      }
    }
  })

  test('kills a pre-exec jailer child authenticated by the trusted jailer inode and --id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-clean-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const jailerBin = await copyNative(root, 'jailer')
    const config = await makeVmConfig({
      dirs,
      overrides: { mode: 'jailer', jailerBin },
    })
    const driver = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const id = newInstanceId()
    const socket = path.join(root, 'pre-exec.sock')
    // The jailer clones before exec: the child still runs the jailer
    // executable (same device+inode) with the jailer's argv.
    const pid = startNative(jailerBin, id, socket)
    expect(await readStartTicks(pid)).toBeDefined()

    await driver.destroy(id)
    expect(await waitGone(pid)).toBe(true)
  })

  test('does not kill a process with --id <id> but a different executable inode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-clean-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const jailerBin = await copyNative(root, 'jailer')
    const otherBin = await copyNative(root, 'jailer-other-copy')
    const config = await makeVmConfig({
      dirs,
      overrides: { mode: 'jailer', jailerBin },
    })
    const driver = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const id = newInstanceId()
    const socket = path.join(root, 'other.sock')
    const pid = startNative(otherBin, id, socket)
    try {
      // It looks like a jailer but no anchor (trusted jailer inode, persisted
      // identity, current jail executable or configured binary) authenticates
      // it, so destroy must refuse rather than signal it.
      await expect(driver.destroy(id)).rejects.toThrow(/unresolved process/)
      expect(await readStartTicks(pid)).toBeDefined()
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
  })
})

describe('rollback waits through the clone-to-exec window', () => {
  test('finds and kills a child that appears only after 300ms with no jail path in argv', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-clean-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const jailerBin = await writeJailer(
      root,
      `${jailerPrelude}
# Exercise the delayed child through a symlink outside the jail so argv
# contains no jail path at all.
ln -sf "$dir/$b" "$base/late-link-$id"
( sleep 0.3; : > "$base/late-child-$id"; exec "$base/late-link-$id" --id "$id" --api-sock /tmp/rctf-late-$id.sock </dev/null >/dev/null 2>&1 ) &
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
    const fcBase = path.basename(config.firecrackerBin)
    const jail = path.join(config.chrootBase, fcBase, id)
    try {
      await expect(driver.launch(makeRequest(id, 'web-demo'))).rejects.toThrow(
        /pid file|exited/
      )
      expect(
        await pathExists(path.join(config.chrootBase, `late-child-${id}`))
      ).toBe(true)
      expect(await pathExists(jail)).toBe(false)
      expect(await pathExists(path.join(config.runDir, id))).toBe(false)
      expect(await driver.listInstanceIds()).not.toContain(id)
    } finally {
      await rm(`/tmp/rctf-late-${id}.sock`, { force: true }).catch(
        () => undefined
      )
      await driver.destroy(id).catch(() => undefined)
    }
  })
  test('keeps storage when a candidate survives the bounded scan deadline', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-clean-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const config = await makeVmConfig({ dirs, overrides: { killWaitMs: 400 } })
    const driver = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    const handle = await driver.launch(makeRequest(id, 'web-demo'))
    liveProcesses.push(handle.pid)
    // A signal sender that never succeeds proves the deadline path: destroy
    // must fail, keep the sidecar and storage, and never remove the tree.
    const blocked = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
      killProcess: () => undefined,
    })
    try {
      await expect(blocked.destroy(id)).rejects.toThrow(/survived SIGKILL/)
      expect(await pathExists(path.join(config.runDir, id))).toBe(true)
      expect(
        await pathExists(path.join(config.runDir, id, 'vm-identity.json'))
      ).toBe(true)
      expect(await blocked.listInstanceIds()).toContain(id)
    } finally {
      await driver.destroy(id).catch(() => undefined)
    }
  })
})

describe('destroy refuses processes it cannot authenticate', () => {
  test('previous binary, no sidecar: throws unresolved and keeps storage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-clean-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const binA = await copyNative(root, 'firecracker-a')
    const binB = await copyNative(root, 'firecracker-b')
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
      // No previous release wrote a sidecar: simulate an agent restart that
      // lost it, then a configured-binary switch.
      await rm(path.join(configA.runDir, id, 'vm-identity.json'))
      const reloaded: VmHandle = {
        instanceId: id,
        pid: handle.pid,
        pidStartTicks: handle.pidStartTicks,
        apiSocket: handle.apiSocket,
        dir: handle.dir,
      }
      expect(await driverB.isAlive(reloaded)).toBe(false)
      expect(await driverB.adopt(id)).toBeUndefined()

      await expect(driverB.destroy(id)).rejects.toThrow(/unresolved process/)
      expect(await readStartTicks(handle.pid)).toBeDefined()
      expect(await pathExists(path.join(configA.runDir, id))).toBe(true)
      expect(
        await pathExists(path.join(configA.runDir, id, 'rootfs.ext4'))
      ).toBe(true)
    } finally {
      await driverA.destroy(id).catch(() => undefined)
      try {
        process.kill(handle.pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
  })
})
