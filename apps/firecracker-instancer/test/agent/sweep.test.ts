import { afterEach, describe, expect, it } from 'bun:test'
import { createHarness, type Harness } from './harness'
import { makeGate, makeSpec, waitFor } from './fakes'

const harnesses: Harness[] = []

const setup = async (
  opts?: Parameters<typeof createHarness>[0]
): Promise<Harness> => {
  const harness = await createHarness(opts)
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

describe('per-instance sweep isolation', () => {
  it('enforces another instance dead-man deadline while one teardown is stalled', async () => {
    const harness = await setup({ sweepIntervalMs: 2 })
    const base = harness.clock.now()
    const stalled = makeSpec({ expiresAtMs: base + 100 })
    const expiring = makeSpec({ expiresAtMs: base + 100 })

    await harness.mgr.create(stalled)
    await harness.mgr.create(expiring)
    await waitFor(async () => {
      const instances = await harness.mgr.list()
      return instances.length === 2 &&
        instances.every(instance => instance.state === 'running')
        ? true
        : undefined
    })

    const gate = makeGate()
    harness.vm.stopGate = id => (id === stalled.id ? gate.promise : undefined)
    harness.clock.advance(100 + 10_000 + 1)

    // The first id's teardown is stuck in vm.stop; the second must still be
    // torn down independently (old sequential sweep would never reach it).
    await waitFor(async () =>
      (await harness.mgr.get(expiring.id)) === undefined ? true : undefined
    )
    expect(await harness.mgr.get(stalled.id)).toBeDefined()

    gate.open()
    await waitFor(async () =>
      (await harness.mgr.get(stalled.id)) === undefined ? true : undefined
    )
    expect(harness.net.residue()).toEqual({
      leases: 0,
      published: 0,
      ports: 0,
      hostnames: 0,
    })
  })

  it('per-operation timeout frees the sweep slot for another instance', async () => {
    const harness = await setup({
      sweepIntervalMs: 2,
      sweepConcurrency: 1,
      operationTimeoutMs: 50,
    })
    const base = harness.clock.now()
    const a = makeSpec({ expiresAtMs: base + 100 })
    const b = makeSpec({ expiresAtMs: base + 100 })
    await harness.mgr.create(a)
    await harness.mgr.create(b)

    const gate = makeGate()
    // Never opened: only the per-operation timeout can free the single slot.
    harness.vm.stopGate = id => (id === a.id ? gate.promise : undefined)
    harness.clock.advance(100 + 10_000 + 1)

    await waitFor(async () =>
      (await harness.mgr.get(b.id)) === undefined ? true : undefined
    )
    expect(await harness.mgr.get(a.id)).toBeUndefined()
  })

  it('bounded concurrency keeps sweeps moving for more than one slot', async () => {
    const harness = await setup({ sweepIntervalMs: 2, sweepConcurrency: 1 })
    const base = harness.clock.now()
    const a = makeSpec({ expiresAtMs: base + 100 })
    const b = makeSpec({ expiresAtMs: base + 100 })
    await harness.mgr.create(a)
    await harness.mgr.create(b)

    const gate = makeGate()
    harness.vm.stopGate = id => (id === a.id ? gate.promise : undefined)
    harness.clock.advance(100 + 10_000 + 1)
    await new Promise(resolve => setTimeout(resolve, 30))
    // With one slot, the stalled id holds it; releasing lets the sweep finish.
    gate.open()
    await waitFor(async () => {
      const instances = await harness.mgr.list()
      return instances.length === 0 ? true : undefined
    })
  })
})
