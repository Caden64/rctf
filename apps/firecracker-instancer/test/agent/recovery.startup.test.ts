import { afterEach, describe, expect, it } from 'bun:test'
import {
  buildStoredInstance,
  leaseToJson,
  StateStore,
} from '../../src/agent/state'
import { createLogger } from '../../src/log'
import type { VmHandle } from '../../src/interfaces'
import { createHarness, type Harness } from './harness'
import {
  FakeNetworkManager,
  FakeVmDriver,
  makeGate,
  makeLease,
  makeSpec,
  never,
  readTree,
  toExpose,
  waitFor,
} from './fakes'

const harnesses: Harness[] = []

const setup = async (
  opts?: Parameters<typeof createHarness>[0]
): Promise<Harness> => {
  const harness = await createHarness(opts)
  harnesses.push(harness)
  return harness
}

const logger = (): ReturnType<typeof createLogger> =>
  createLogger('recovery-startup-test', 'silent')

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

const makeHandle = (instanceId: string): VmHandle => ({
  instanceId,
  pid: 1234,
  pidStartTicks: 7,
  apiSocket: `/run/${instanceId}/api.sock`,
  dir: `/run/${instanceId}`,
})

const rawRecord = async (
  dir: string,
  id: string
): Promise<Record<string, unknown> | undefined> => {
  const file = (await readTree(dir))[`${id}.json`]
  return file ? (JSON.parse(file) as Record<string, unknown>) : undefined
}

describe('startup ordering', () => {
  it('does not start readiness until net.restore has completed', async () => {
    const harness = await setup({
      config: { shutdownTimeoutSeconds: 0 },
      sweepIntervalMs: 1_000_000,
    })
    harness.vm.waitReadyHook = () => never()
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await waitFor(async () => {
      const raw = await rawRecord(harness.dir, spec.id)
      return raw?.state === 'starting' ? true : undefined
    })
    await harness.mgr.stop()
    harness.vm.waitReadyHook = undefined
    const before = harness.vm.waitReadyCalls

    const net2 = new FakeNetworkManager()
    const restoreGate = makeGate()
    net2.restoreGate = restoreGate.promise
    const mgr = harness.spawn({ net: net2 })
    const starting = mgr.start()

    await new Promise(resolve => setTimeout(resolve, 30))
    expect(net2.restoreCalls).toBe(1)
    expect(net2.lastRestored).toHaveLength(0)
    // Readiness must not have been restarted before restore finished.
    expect(harness.vm.waitReadyCalls).toBe(before)
    expect((await mgr.get(spec.id))?.state).toBe('starting')

    restoreGate.open()
    await starting
    expect(net2.lastRestored).toHaveLength(1)
    await waitFor(async () =>
      (await mgr.get(spec.id))?.state === 'running' ? true : undefined
    )
    expect(harness.vm.waitReadyCalls).toBeGreaterThan(before)
  })

  it('is idempotent across two restarts', async () => {
    const harness = await setup()
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await waitFor(async () =>
      (await harness.mgr.get(spec.id))?.state === 'running' ? true : undefined
    )
    await harness.mgr.stop()

    const net2 = new FakeNetworkManager()
    const mgr2 = harness.spawn({ net: net2 })
    await mgr2.start()
    await mgr2.stop()

    const net3 = new FakeNetworkManager()
    const mgr3 = harness.spawn({ net: net3 })
    await mgr3.start()

    expect((await mgr3.get(spec.id))?.state).toBe('running')
    expect(net3.leases.has(spec.id)).toBe(true)
    expect(net3.lastRestored).toHaveLength(1)
    expect(harness.vm.destroyedIds).not.toContain(spec.id)
    expect(harness.vm.alive.has(spec.id)).toBe(true)
  })
})

describe('recovery failures keep the agent un-accepting and retry on sweep', () => {
  it('reports accepting:false when net.restore fails, then recovers', async () => {
    const harness = await setup()
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await waitFor(async () =>
      (await harness.mgr.get(spec.id))?.state === 'running' ? true : undefined
    )
    await harness.mgr.stop()

    const net2 = new FakeNetworkManager()
    net2.failRestore = true
    const mgr = harness.spawn({ net: net2, sweepIntervalMs: 2 })
    await mgr.start()

    const failing = await mgr.info()
    expect(failing.checks.recovered).toBe(false)
    expect(failing.accepting).toBe(false)
    expect((await mgr.get(spec.id))?.state).toBe('running')

    net2.failRestore = false
    await waitFor(async () => {
      const info = await mgr.info()
      return info.checks.recovered && info.accepting ? true : undefined
    })
  })

  it('reports accepting:false when orphan discovery fails, then recovers', async () => {
    const harness = await setup()
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await waitFor(async () =>
      (await harness.mgr.get(spec.id))?.state === 'running' ? true : undefined
    )
    await harness.mgr.stop()

    harness.vm.failList = true
    const mgr = harness.spawn({ sweepIntervalMs: 2 })
    await mgr.start()
    expect((await mgr.info()).checks.recovered).toBe(false)

    harness.vm.failList = false
    await waitFor(async () => {
      const info = await mgr.info()
      return info.checks.recovered && info.accepting ? true : undefined
    })
  })
})

describe('recovered readiness requires a guest IP', () => {
  it('fails closed instead of falling back to hostIp', async () => {
    const harness = await setup()
    const spec = makeSpec()
    const lease = {
      ...leaseToJson(makeLease(spec.id, toExpose(spec.expose))),
      guestIp: '',
    }
    const handle = makeHandle(spec.id)
    await new StateStore(harness.dir, logger()).save({
      ...buildStoredInstance(spec, harness.clock.now(), 'starting'),
      lease,
      vm: handle,
      updatedAtMs: harness.clock.now(),
    })

    const vm2 = new FakeVmDriver()
    vm2.handles.set(spec.id, handle)
    vm2.alive.add(spec.id)
    const net2 = new FakeNetworkManager()
    net2.leases.set(spec.id, lease)

    const mgr = harness.spawn({ vm: vm2, net: net2 })
    await mgr.start()

    const errored = await waitFor(async () => {
      const current = await mgr.get(spec.id)
      return current?.state === 'errored' ? current : undefined
    })
    expect(errored.message).toBe('invalid network lease')
    expect(vm2.waitReadyCalls).toBe(0)
  })
})
