import { afterEach, describe, expect, test } from 'bun:test'
import type { ControllerConfig } from '../../src/controller/config'
import { HostMonitor, PeriodicLoop } from '../../src/controller/hosts'
import { Store, StoreClosedError } from '../../src/controller/store'
import {
  cleanupDir,
  databasePath,
  FakeTimers,
  makeConfig,
  makeHost,
  MemoryLogs,
  testDir,
} from './helpers'
import { FakeAgent } from './fake-agent'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) cleanupDir(dirs.pop()!)
})

const monitorSetup = (
  hosts: ReturnType<typeof makeHost>[],
  agents: Record<string, FakeAgent>,
  overrides: Partial<ControllerConfig> = {}
) => {
  const dir = testDir()
  dirs.push(dir)
  const store = new Store(databasePath(dir), () => Date.now())
  const logs = new MemoryLogs()
  const config = makeConfig(dir, hosts, overrides)
  let monotonic = 0
  const monitor = new HostMonitor({
    config,
    store,
    clients: agents,
    now: () => Date.now(),
    // Deterministic 1ms RTT per probe (the fixed wall clock never advances).
    rttNow: () => ++monotonic,
    logger: logs.asLogger(),
  })
  return { store, monitor, logs, dir }
}

describe('host monitor', () => {
  test('probes concurrently: one responding host is not aged past the timeout by hung peers', async () => {
    const hosts: ReturnType<typeof makeHost>[] = []
    const agents: Record<string, FakeAgent> = {}
    for (let index = 0; index < 21; index++) {
      const id = `bad-${index}`
      hosts.push(makeHost(id))
      const agent = new FakeAgent(id, {
        vcpus: 8,
        memMiB: 4096,
        diskMiB: 4096,
        maxInstances: 10,
      })
      agent.infoMode = 'unreachable'
      agent.latencyMs = 100
      agents[id] = agent
    }
    hosts.push(makeHost('good'))
    agents['good'] = new FakeAgent('good', {
      vcpus: 8,
      memMiB: 4096,
      diskMiB: 4096,
      maxInstances: 10,
    })

    const { store, monitor } = monitorSetup(hosts, agents, {
      hostTimeoutSeconds: 2,
    })
    try {
      await monitor.tick()
      // Serial probing would spend 2.1s on the 21 timing-out hosts and mark
      // the early success stale; concurrent probing finishes in ~100ms.
      expect(store.getHost('good')?.health).toBe('healthy')
    } finally {
      store.close()
    }
  })

  test('a hung probe is bounded by the per-probe deadline', async () => {
    const hosts = [makeHost('hang')]
    const agents = {
      hang: new FakeAgent('hang', {
        vcpus: 8,
        memMiB: 4096,
        diskMiB: 4096,
        maxInstances: 10,
      }),
    }
    agents.hang.infoMode = 'hang'
    const { store, monitor } = monitorSetup(hosts, agents, {
      hostProbeTimeoutSeconds: 0.05,
      hostTimeoutSeconds: 20,
    })
    try {
      const started = Date.now()
      await monitor.tick()
      expect(Date.now() - started).toBeLessThan(1000)
      expect(store.getHost('hang')).not.toBeNull()
    } finally {
      store.close()
    }
  })

  test('records the measured clock skew at heartbeat time', async () => {
    const hosts = [makeHost('host-a')]
    const agents = {
      'host-a': new FakeAgent('host-a', {
        vcpus: 8,
        memMiB: 4096,
        diskMiB: 4096,
        maxInstances: 10,
      }),
    }
    agents['host-a'].clockOffsetMs = -7000
    const { store, monitor } = monitorSetup(hosts, agents)
    try {
      await monitor.tick()
      // The fake agent and the monitor both read the real wall clock, so a
      // millisecond can pass between the two reads; allow that jitter.
      const skew = store.getHost('host-a')?.clockSkewMs ?? Number.NaN
      expect(Math.abs(skew + 7000)).toBeLessThanOrEqual(5)
    } finally {
      store.close()
    }
  })
})

describe('PeriodicLoop', () => {
  const logs = new MemoryLogs()

  test('a tick queued after stop begins is a no-op', async () => {
    const timers = new FakeTimers()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const loop = new PeriodicLoop(
      'test',
      1000,
      async () => {
        calls += 1
        await gate
      },
      timers,
      logs.asLogger()
    )
    loop.start()
    const first = loop.run()
    await Promise.resolve()
    const stopping = loop.stop()
    const late = loop.run()
    release()
    await Promise.all([first, stopping, late])
    expect(calls).toBe(1)
  })

  test('stop awaits the in-flight tick', async () => {
    const timers = new FakeTimers()
    let finished = false
    const loop = new PeriodicLoop(
      'test',
      1000,
      async () => {
        await Bun.sleep(30)
        finished = true
      },
      timers,
      logs.asLogger()
    )
    loop.start()
    const running = loop.run()
    await Bun.sleep(5)
    await loop.stop()
    expect(finished).toBe(true)
    await running
  })

  test('stop is bounded by the deadline even with a held tick', async () => {
    const timers = new FakeTimers()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const loop = new PeriodicLoop(
      'held',
      1000,
      async () => {
        await gate
      },
      timers,
      logs.asLogger()
    )
    loop.start()
    const running = loop.run()
    await Promise.resolve()
    const started = Date.now()
    await loop.stop(50)
    expect(Date.now() - started).toBeLessThan(1000)
    // Scheduling stopped immediately, even though the tick is still held.
    expect(timers.size).toBe(0)
    release()
    await running
  })

  test('a late tick against a closed store is swallowed quietly', async () => {
    const dir = testDir()
    dirs.push(dir)
    const store = new Store(databasePath(dir), () => Date.now())
    const timers = new FakeTimers()
    const localLogs = new MemoryLogs()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const loop = new PeriodicLoop(
      'late',
      1000,
      async () => {
        await gate
        // The controller closed SQLite while this tick was in flight.
        store.getHost('host-a')
      },
      timers,
      localLogs.asLogger()
    )
    loop.start()
    const running = loop.run()
    await Promise.resolve()
    store.close()
    release()
    await running
    expect(localLogs.lines.join('\n')).not.toContain(
      'controller loop tick failed'
    )
    expect(() => store.getHost('host-a')).toThrow(StoreClosedError)
  })
})
