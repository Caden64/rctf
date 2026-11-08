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
  makeLease,
  makeSpec,
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
  createLogger('recovery-resources-test', 'silent')

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

describe('errored-record recovery retains ownership until release is confirmed', () => {
  it('keeps vm/lease across a failed destroy and frees capacity only after retry', async () => {
    const harness = await setup()
    const spec = makeSpec()
    const lease = leaseToJson(makeLease(spec.id, toExpose(spec.expose)))
    const handle = makeHandle(spec.id)
    await new StateStore(harness.dir, logger()).save({
      ...buildStoredInstance(spec, harness.clock.now(), 'errored'),
      lease,
      vm: handle,
      updatedAtMs: harness.clock.now(),
    })

    const vm2 = new FakeVmDriver()
    vm2.handles.set(spec.id, handle)
    vm2.alive.add(spec.id)
    vm2.failDestroy = true
    const net2 = new FakeNetworkManager()

    const mgr = harness.spawn({ vm: vm2, net: net2, sweepIntervalMs: 2 })
    await mgr.start()

    expect((await mgr.get(spec.id))?.state).toBe('errored')
    const retained = await rawRecord(harness.dir, spec.id)
    expect(retained?.vm).toBeDefined()
    expect((await mgr.info()).usage.instances).toBe(1)

    vm2.failDestroy = false
    await waitFor(async () => {
      const raw = await rawRecord(harness.dir, spec.id)
      return raw?.vm === undefined && raw?.lease === undefined
        ? true
        : undefined
    })
    expect((await mgr.info()).usage.instances).toBe(0)
  })
})

describe('admission counts errored records that still hold resources', () => {
  it('returns no_capacity while a failed readiness teardown still owns the VM', async () => {
    const harness = await setup({
      config: {
        capacity: {
          vcpus: 100,
          memMiB: 100_000,
          diskMiB: 100_000,
          maxInstances: 1,
        },
      },
      sweepIntervalMs: 1_000_000,
    })
    harness.vm.failWaitReady = true
    harness.vm.failStop = true
    harness.vm.failDestroy = true

    const first = makeSpec()
    await harness.mgr.create(first)
    const errored = await waitFor(async () => {
      const current = await harness.mgr.get(first.id)
      return current?.state === 'errored' ? current : undefined
    })
    expect(errored.message).toBe('readiness timed out')
    // The VM could not be stopped/destroyed, so it still holds the reservation.
    expect(harness.vm.alive.has(first.id)).toBe(true)

    const info = await harness.mgr.info()
    expect(info.usage.instances).toBe(1)

    let code = ''
    try {
      await harness.mgr.create(makeSpec())
    } catch (err) {
      code = (err as { code?: string }).code ?? ''
    }
    expect(code).toBe('no_capacity')
    expect(harness.vm.launchCalls).toBe(1)
  })
})
