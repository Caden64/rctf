import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { VmHandle } from '../../src/interfaces'
import type { VmConfig } from '../../src/agent/vm/config'
import { createVmDriver } from '../../src/agent/vm'
import { findInstanceProcesses, readStartTicks } from '../../src/agent/vm/proc'
import {
  clearFakeEnv,
  ensureFakeFirecracker,
  makeDirs,
  makeImage,
  makeLogger,
  makeRequest,
  makeRunner,
  makeVmConfig,
  newInstanceId,
  setFakeEnv,
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

  test('recognizes jailer-style --id=<id> cmdlines but does not adopt the jailer', async () => {
    const { root, config, driver } = await setup()
    const id = newInstanceId()
    const wrapper = await ensureFakeFirecracker(root)
    const dir = path.join(root, 'live', id)
    await mkdir(dir, { recursive: true })
    const apiSocket = path.join(dir, 'api.sock')

    const firecracker = Bun.spawn(
      [wrapper, `--id=${id}`, '--api-sock', apiSocket],
      { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }
    )
    liveProcesses.push(firecracker.pid)
    const jailerSock = path.join(dir, 'jailer.sock')
    const jailer = Bun.spawn(
      [
        wrapper,
        '--exec-file',
        '/usr/local/bin/firecracker',
        `--id=${id}`,
        '--api-sock',
        jailerSock,
      ],
      { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }
    )
    liveProcesses.push(jailer.pid)

    try {
      const found = await findInstanceProcesses(id)
      expect(
        found.some(proc => proc.pid === firecracker.pid && !proc.jailer)
      ).toBe(true)
      expect(found.some(proc => proc.pid === jailer.pid && proc.jailer)).toBe(
        true
      )
      expect(await driver.adopt(id)).toBeDefined()
      expect((await driver.adopt(id))?.pid).toBe(firecracker.pid)
      expect(await driver.listInstanceIds()).toContain(id)
    } finally {
      firecracker.kill('SIGKILL')
      jailer.kill('SIGKILL')
      await firecracker.exited
      await jailer.exited
    }
    expect(config.runDir).toBeDefined()
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
    expect(await findInstanceProcesses(id)).toEqual([])
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
