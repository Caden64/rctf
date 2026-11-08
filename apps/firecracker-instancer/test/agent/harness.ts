import { createInstanceManager } from '../../src/agent/manager'
import type { AgentConfig } from '../../src/agent/config'
import type { InstanceManager } from '../../src/interfaces'
import type { Logger } from '../../src/log'
import {
  FakeNetworkManager,
  FakeVmDriver,
  makeClock,
  makeConfig,
  removeDir,
  tempDir,
  type TestClock,
} from './fakes'

export interface Harness {
  dir: string
  config: AgentConfig
  clock: TestClock
  vm: FakeVmDriver
  net: FakeNetworkManager
  mgr: InstanceManager
  logger?: Logger
  /** Build another manager over the same state dir (restart / second agent). */
  spawn: (opts?: {
    vm?: FakeVmDriver
    net?: FakeNetworkManager
    sweepIntervalMs?: number
    erroredTtlMs?: number
    tombstoneTtlMs?: number
  }) => InstanceManager
  cleanup: () => Promise<void>
}

export const createHarness = async (opts?: {
  config?: Record<string, unknown>
  logger?: Logger
  sweepIntervalMs?: number
  erroredTtlMs?: number
  tombstoneTtlMs?: number
  clock?: TestClock
  vm?: FakeVmDriver
  net?: FakeNetworkManager
}): Promise<Harness> => {
  const dir = await tempDir()
  const clock = opts?.clock ?? makeClock()
  const vm = opts?.vm ?? new FakeVmDriver()
  const net = opts?.net ?? new FakeNetworkManager()
  const config = makeConfig(dir, opts?.config)
  const managers: InstanceManager[] = []

  const spawn = (spawnOpts?: {
    vm?: FakeVmDriver
    net?: FakeNetworkManager
    sweepIntervalMs?: number
    erroredTtlMs?: number
    tombstoneTtlMs?: number
  }): InstanceManager => {
    const manager = createInstanceManager({
      config,
      vm: spawnOpts?.vm ?? vm,
      net: spawnOpts?.net ?? net,
      now: clock.now,
      ...(opts?.logger === undefined ? {} : { logger: opts.logger }),
      sweepIntervalMs: spawnOpts?.sweepIntervalMs ?? opts?.sweepIntervalMs ?? 5,
      erroredTtlMs: spawnOpts?.erroredTtlMs ?? opts?.erroredTtlMs ?? 600_000,
      tombstoneTtlMs:
        spawnOpts?.tombstoneTtlMs ?? opts?.tombstoneTtlMs ?? 86_400_000,
      orphanGraceMs: 0,
    })
    managers.push(manager)
    return manager
  }

  const mgr = spawn()
  await mgr.start()

  return {
    dir,
    config,
    clock,
    vm,
    net,
    mgr,
    ...(opts?.logger === undefined ? {} : { logger: opts.logger }),
    spawn,
    cleanup: async () => {
      for (const manager of [...managers].reverse()) {
        await manager.stop().catch(() => {})
      }
      await removeDir(dir)
    },
  }
}
