import { createInstanceManager } from '../../src/agent/manager'
import type { AgentConfig } from '../../src/agent/config'
import { StateStore, TombstoneStore } from '../../src/agent/state'
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

interface SpawnOptions {
  vm?: FakeVmDriver
  net?: FakeNetworkManager
  sweepIntervalMs?: number
  erroredTtlMs?: number
  tombstoneTtlMs?: number
  operationTimeoutMs?: number
  sweepConcurrency?: number
  store?: StateStore
  tombstones?: TombstoneStore
}

export interface Harness {
  dir: string
  config: AgentConfig
  clock: TestClock
  vm: FakeVmDriver
  net: FakeNetworkManager
  mgr: InstanceManager
  logger?: Logger
  /** Build another manager over the same state dir (restart / second agent). */
  spawn: (opts?: SpawnOptions) => InstanceManager
  cleanup: () => Promise<void>
}

export const createHarness = async (opts?: {
  config?: Record<string, unknown>
  logger?: Logger
  sweepIntervalMs?: number
  erroredTtlMs?: number
  tombstoneTtlMs?: number
  operationTimeoutMs?: number
  sweepConcurrency?: number
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

  const spawn = (spawnOpts?: SpawnOptions): InstanceManager => {
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
      operationTimeoutMs:
        spawnOpts?.operationTimeoutMs ?? opts?.operationTimeoutMs ?? 30_000,
      sweepConcurrency:
        spawnOpts?.sweepConcurrency ?? opts?.sweepConcurrency ?? 8,
      orphanGraceMs: 0,
      ...(spawnOpts?.store === undefined ? {} : { store: spawnOpts.store }),
      ...(spawnOpts?.tombstones === undefined
        ? {}
        : { tombstones: spawnOpts.tombstones }),
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
