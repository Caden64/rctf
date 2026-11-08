import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { VmHandle } from '../../src/interfaces'
import type { VmConfig } from '../../src/agent/vm/config'
import { createVmDriver } from '../../src/agent/vm'
import type { VmSpawn } from '../../src/agent/vm/driver'
import { readStartTicks, statExeIdentity } from '../../src/agent/vm/proc'
import {
  compiledFakeFirecracker,
  makeDirs,
  makeImage,
  makeLogger,
  makeRequest,
  makeRunner,
  makeVmConfig,
  newInstanceId,
  setFakeEnv,
  spawnWithEnv,
  clearFakeEnv,
} from './helpers'

const roots: string[] = []
const liveProcesses: number[] = []

const setup = async (
  overrides: Partial<VmConfig> = {},
  spawnOverride?: VmSpawn
): Promise<{
  root: string
  config: VmConfig
  driver: ReturnType<typeof createVmDriver>
  logger: ReturnType<typeof makeLogger>
}> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-id-'))
  roots.push(root)
  const dirs = await makeDirs(root)
  const config = await makeVmConfig({ dirs, overrides })
  const logger = makeLogger()
  const driver = createVmDriver(config, {
    runner: makeRunner().runner,
    logger: logger.logger,
    spawn: spawnOverride ?? spawnWithEnv,
  })
  return { root, config, driver, logger }
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

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

const waitGone = async (pid: number, timeoutMs = 3000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await readStartTicks(pid)) === undefined) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

const copyNative = async (root: string, name: string): Promise<string> => {
  const dir = path.join(root, 'bin')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, name)
  await copyFile(await compiledFakeFirecracker(), target)
  await chmod(target, 0o755)
  return target
}

const markerPath = (config: VmConfig, id: string): string =>
  path.join(config.runDir, id, 'vm-identity.json')

const identityFor = async (
  instanceId: string,
  binary: string,
  config: VmConfig
): Promise<string> => {
  const st = await statExeIdentity(await realpath(binary))
  return JSON.stringify({
    version: 1,
    instanceId,
    exe: { dev: st.dev, ino: st.ino },
    exePath: await realpath(binary),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    apiSocket: path.join(config.runDir, instanceId, 'api.sock'),
    dir: path.join(config.runDir, instanceId),
  })
}

const reloadedHandle = (handle: VmHandle): VmHandle => ({
  instanceId: handle.instanceId,
  pid: handle.pid,
  pidStartTicks: handle.pidStartTicks,
  apiSocket: handle.apiSocket,
  dir: handle.dir,
})

describe('vm-identity sidecar is written atomically and early', () => {
  test('replaces (never follows) a symlinked marker and leaves no temp files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-id-'))
    roots.push(root)
    const outside = path.join(root, 'outside.json')
    await writeFile(outside, 'keep')
    const dirs = await makeDirs(root)
    const config = await makeVmConfig({ dirs })
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    const marker = path.join(config.runDir, id, 'vm-identity.json')
    const driver = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: (argv, opts) => {
        // The instance dir exists by now; a malicious/stale symlink must not
        // make the sidecar writer follow it.
        Bun.spawnSync(['ln', '-sfn', outside, marker])
        return spawnWithEnv(argv, opts)
      },
    })
    let handle: VmHandle | undefined
    try {
      handle = await driver.launch(makeRequest(id, 'web-demo'))
      expect(await readFile(outside, 'utf8')).toBe('keep')
      const st = await lstat(marker)
      expect(st.isSymbolicLink()).toBe(false)
      expect(st.isFile()).toBe(true)
      expect(st.mode & 0o777).toBe(0o600)
      const names = await readdir(path.join(config.runDir, id))
      expect(names.filter(name => name.includes('.tmp'))).toEqual([])
    } finally {
      if (handle !== undefined) {
        await driver.stop(handle, { graceMs: 100 }).catch(() => undefined)
        liveProcesses.push(handle.pid)
      }
      await driver.destroy(id).catch(() => undefined)
    }
  })

  test('persists the sidecar before the API socket is ready / configured', async () => {
    const { config, driver } = await setup()
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    setFakeEnv(id, { SOCKET_DELAY_MS: '800' })
    const marker = markerPath(config, id)
    let handle: VmHandle | undefined
    try {
      const launching = driver.launch(makeRequest(id, 'web-demo'))
      const deadline = Date.now() + 600
      let seen = false
      while (Date.now() < deadline) {
        if (await pathExists(marker)) {
          seen = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(seen).toBe(true)
      handle = await launching
    } finally {
      clearFakeEnv(id)
      if (handle !== undefined) {
        liveProcesses.push(handle.pid)
        await driver.destroy(id).catch(() => undefined)
      } else {
        await driver.destroy(id).catch(() => undefined)
      }
    }
  })
})

describe('vm-identity sidecar read hardening', () => {
  test('ignores a symlinked marker (no-follow) instead of trusting it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-id-'))
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
    const loggerB = makeLogger()
    const driverA = createVmDriver(configA, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const driverB = createVmDriver(configB, {
      runner: makeRunner().runner,
      logger: loggerB.logger,
      spawn: spawnWithEnv,
    })
    const id = newInstanceId()
    await makeImage(configA.imagesDir, 'web-demo')
    const handle = await driverA.launch(makeRequest(id, 'web-demo'))
    liveProcesses.push(handle.pid)
    try {
      const marker = markerPath(configA, id)
      const outside = path.join(root, 'forged-identity.json')
      await writeFile(outside, await identityFor(id, binA, configA))
      await rm(marker, { force: true })
      await symlink(outside, marker)
      // The sidecar is the only anchor that would match binA; ignoring the
      // symlink leaves only the configured binB, so the old VM is not alive.
      expect(await driverB.isAlive(reloadedHandle(handle))).toBe(false)
      expect(loggerB.text()).toContain('vm-identity.json')
    } finally {
      await driverA.destroy(id).catch(() => undefined)
      await rm(path.join(configA.runDir, id), {
        recursive: true,
        force: true,
      }).catch(() => undefined)
    }
  })

  test('ignores a marker that is group/other writable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-id-'))
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
      const marker = markerPath(configA, id)
      await writeFile(marker, await identityFor(id, binA, configA), {
        mode: 0o660,
      })
      await chmod(marker, 0o660)
      expect(await driverB.isAlive(reloadedHandle(handle))).toBe(false)
    } finally {
      await chmod(markerPath(configA, id), 0o600).catch(() => undefined)
      await driverA.destroy(id).catch(() => undefined)
    }
  })

  test('ignores a marker below an insecure instance directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-id-'))
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
    const instanceDir = path.join(configA.runDir, id)
    try {
      await chmod(instanceDir, 0o770)
      expect(await driverB.isAlive(reloadedHandle(handle))).toBe(false)
    } finally {
      await chmod(instanceDir, 0o700).catch(() => undefined)
      await driverA.destroy(id).catch(() => undefined)
    }
  })

  test('a stale but valid sidecar does not stop isAlive from trying other anchors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-id-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const binA = await copyNative(root, 'firecracker-a')
    const binB = await copyNative(root, 'firecracker-b')
    const config = await makeVmConfig({
      dirs,
      overrides: { mode: 'direct', firecrackerBin: binA },
    })
    const driver = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: makeLogger().logger,
      spawn: spawnWithEnv,
    })
    const id = newInstanceId()
    await makeImage(config.imagesDir, 'web-demo')
    const handle = await driver.launch(makeRequest(id, 'web-demo'))
    liveProcesses.push(handle.pid)
    try {
      // Valid format, wrong (stale) executable identity. The configured
      // binary is still binA and the live process is binA.
      await writeFile(
        markerPath(config, id),
        await identityFor(id, binB, config)
      )
      await chmod(markerPath(config, id), 0o600)
      expect(await driver.isAlive(reloadedHandle(handle))).toBe(true)
    } finally {
      await driver.destroy(id).catch(() => undefined)
    }
  })

  test('jail enumeration does not follow an intermediate <id> symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rctf-vm-id-'))
    roots.push(root)
    const dirs = await makeDirs(root)
    const config = await makeVmConfig({ dirs })
    const logger = makeLogger()
    const driver = createVmDriver(config, {
      runner: makeRunner().runner,
      logger: logger.logger,
      spawn: spawnWithEnv,
    })
    const id = newInstanceId()
    const fcBase = path.basename(await realpath(config.firecrackerBin))
    const outsideRoot = path.join(root, 'outside-jail', id, 'root')
    await mkdir(outsideRoot, { recursive: true, mode: 0o700 })
    const outsideExe = path.join(outsideRoot, 'firecracker')
    await copyFile(await compiledFakeFirecracker(), outsideExe)
    await chmod(outsideExe, 0o755)
    await mkdir(path.join(config.chrootBase, fcBase), { recursive: true })
    await symlink(
      path.join(root, 'outside-jail', id),
      path.join(config.chrootBase, fcBase, id)
    )
    const socket = path.join(root, 'outside.sock')
    const proc = Bun.spawn([outsideExe, '--id', id, '--api-sock', socket], {
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    liveProcesses.push(proc.pid)
    try {
      expect(await driver.adopt(id)).toBeUndefined()
      expect(logger.text()).toContain('symlink')
      await expect(driver.destroy(id)).rejects.toThrow(/unresolved process/)
      expect(await pathExists(outsideExe)).toBe(true)
    } finally {
      try {
        process.kill(proc.pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
    await waitGone(proc.pid)
  })
})
