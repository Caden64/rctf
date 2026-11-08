import { afterEach, describe, expect, it } from 'bun:test'
import { ProtocolError } from '@rctf/firecracker-protocol'
import type { InstanceManager } from '../../src/interfaces'
import { createHarness, type Harness } from './harness'
import { makeSpec, nextId, readTree, waitFor } from './fakes'

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

const rejectionCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (err) {
    if (err instanceof ProtocolError) return err.code
    throw err
  }
  throw new Error('expected the promise to reject')
}

const expectClean = (harness: Harness): void => {
  expect(harness.net.residue()).toEqual({
    leases: 0,
    published: 0,
    ports: 0,
    hostnames: 0,
  })
  expect(harness.vm.processResidue()).toBe(0)
}

describe('instance manager: create', () => {
  it('launches exactly once for 100 concurrent creates of the same id', async () => {
    const harness = await setup()
    const spec = makeSpec()

    const instances = await Promise.all(
      Array.from({ length: 100 }, () => harness.mgr.create(spec))
    )

    expect(harness.vm.launchCalls).toBe(1)
    expect(new Set(instances.map(instance => instance.id))).toEqual(
      new Set([spec.id])
    )
    expect(new Set(instances.map(instance => instance.specHash)).size).toBe(1)
  })

  it('rejects a different spec for an existing id', async () => {
    const harness = await setup()
    const spec = makeSpec()
    await harness.mgr.create(spec)

    const code = await rejectionCode(
      harness.mgr.create({ ...spec, memMiB: spec.memMiB + 128 })
    )
    expect(code).toBe('spec_mismatch')
    expect(harness.vm.launchCalls).toBe(1)
  })

  it('admits exactly capacity.maxInstances under 50 parallel creates', async () => {
    const harness = await setup({
      config: {
        capacity: {
          vcpus: 100,
          memMiB: 100_000,
          diskMiB: 100_000,
          maxInstances: 10,
        },
      },
    })
    const specs = Array.from({ length: 50 }, () =>
      makeSpec({ memMiB: 128, diskMiB: 64 })
    )

    const results = await Promise.allSettled(
      specs.map(spec => harness.mgr.create(spec))
    )
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )

    expect(fulfilled).toHaveLength(10)
    expect(rejected).toHaveLength(40)
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(ProtocolError)
      expect((result.reason as ProtocolError).code).toBe('no_capacity')
    }
    expect(harness.vm.launchCalls).toBe(10)

    const info = await harness.mgr.info()
    expect(info.usage.instances).toBe(10)
    expect(info.usage.memMiB).toBeLessThanOrEqual(10 * 128 + 128)
  })

  it('rejects new creates while draining', async () => {
    const harness = await setup({ config: { draining: true } })
    const code = await rejectionCode(harness.mgr.create(makeSpec()))
    expect(code).toBe('draining')
  })
})

describe('instance manager: provisioning failures', () => {
  const stages = ['allocate', 'launch', 'publish', 'waitReady'] as const

  for (const stage of stages) {
    it(`leaves no residue and an errored tombstone when ${stage} fails`, async () => {
      const harness = await setup()
      const spec = makeSpec()
      if (stage === 'allocate') harness.net.failAllocate = true
      if (stage === 'launch') harness.vm.failLaunch = true
      if (stage === 'publish') harness.net.failPublish = true
      if (stage === 'waitReady') harness.vm.failWaitReady = true

      const created = await harness.mgr.create(spec)
      const instance = await waitFor(async () => {
        const current = await harness.mgr.get(spec.id)
        return current?.state === 'errored' ? current : undefined
      })

      expect(created.id).toBe(spec.id)
      expect(instance.state).toBe('errored')
      expect(instance.message ?? '').not.toContain('FLAG{test-secret-value}')
      expectClean(harness)

      const files = await readTree(harness.dir)
      expect(Object.keys(files)).toContain(`${spec.id}.json`)
      expect(JSON.stringify(files)).not.toContain('FLAG{test-secret-value}')
    })
  }
})

describe('instance manager: delete', () => {
  it('cancels an in-flight boot and releases everything', async () => {
    const harness = await setup()
    const spec = makeSpec()
    let aborted = false
    harness.vm.waitReadyHook = (_id, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new Error('aborted'))
          },
          { once: true }
        )
      })

    await harness.mgr.create(spec)
    await waitFor(() => (harness.vm.waitReadyCalls >= 1 ? true : undefined))
    expect((await harness.mgr.get(spec.id))?.state).toBe('starting')

    const deleted = await harness.mgr.delete(spec.id)
    expect(deleted.state).toBe('stopped')
    expect(aborted).toBe(true)
    expect(await harness.mgr.get(spec.id)).toBeUndefined()
    expectClean(harness)
    expect(Object.keys(await readTree(harness.dir))).not.toContain(
      `${spec.id}.json`
    )
  })

  it('is idempotent: the second delete reports not_found', async () => {
    const harness = await setup()
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await harness.mgr.delete(spec.id)

    const code = await rejectionCode(harness.mgr.delete(spec.id))
    expect(code).toBe('not_found')
    expectClean(harness)
  })

  it('does not double-release when raced with the expiry sweep', async () => {
    const harness = await setup({ sweepIntervalMs: 2 })
    const spec = makeSpec({ expiresAtMs: harness.clock.now() + 100 })
    await harness.mgr.create(spec)

    harness.clock.advance(100 + 10_000)
    const deleteResult = harness.mgr.delete(spec.id).catch(err => err)
    const removed = await waitFor(async () =>
      (await harness.mgr.get(spec.id)) === undefined ? true : undefined
    )
    expect(removed).toBe(true)
    await deleteResult

    expectClean(harness)
    expect(harness.net.releaseCalls).toBeLessThanOrEqual(1)
    expect(harness.vm.destroyCalls).toBeLessThanOrEqual(1)
  })
})

describe('instance manager: extend and expiry', () => {
  it('rejects extend after the deadline', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const spec = makeSpec({ expiresAtMs: harness.clock.now() + 1000 })
    await harness.mgr.create(spec)

    harness.clock.advance(1000)
    const code = await rejectionCode(
      harness.mgr.extend(spec.id, harness.clock.now() + 60_000)
    )
    expect(code).toBe('expired')
  })

  it('never shortens the expiry', async () => {
    const harness = await setup()
    const start = harness.clock.now()
    const spec = makeSpec({ expiresAtMs: start + 10_000 })
    await harness.mgr.create(spec)

    const shortened = await harness.mgr.extend(spec.id, start + 5000)
    expect(shortened.expiresAtMs).toBe(start + 10_000)

    const extended = await harness.mgr.extend(spec.id, start + 20_000)
    expect(extended.expiresAtMs).toBe(start + 20_000)
    expect((await harness.mgr.get(spec.id))?.expiresAtMs).toBe(start + 20_000)
  })

  it('tears down instances past expiresAtMs + grace', async () => {
    const harness = await setup({ sweepIntervalMs: 2 })
    const spec = makeSpec({ expiresAtMs: harness.clock.now() + 1000 })
    await harness.mgr.create(spec)
    await waitFor(async () =>
      (await harness.mgr.get(spec.id))?.state === 'running' ? true : undefined
    )

    harness.clock.advance(1000 + 10_000 + 1)
    await waitFor(async () =>
      (await harness.mgr.get(spec.id)) === undefined ? true : undefined
    )
    expectClean(harness)
  })

  it('forgets an errored tombstone after its TTL', async () => {
    const harness = await setup({ erroredTtlMs: 10, sweepIntervalMs: 2 })
    harness.vm.failLaunch = true
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await waitFor(async () =>
      (await harness.mgr.get(spec.id))?.state === 'errored' ? true : undefined
    )

    harness.clock.advance(11)
    await waitFor(async () =>
      (await harness.mgr.get(spec.id)) === undefined ? true : undefined
    )
    expect(Object.keys(await readTree(harness.dir))).toHaveLength(0)
  })
})

describe('instance manager: VM liveness', () => {
  it('marks a running instance errored when its VM disappears', async () => {
    const harness = await setup({ sweepIntervalMs: 2 })
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await waitFor(async () =>
      (await harness.mgr.get(spec.id))?.state === 'running' ? true : undefined
    )

    harness.vm.alive.delete(spec.id)
    const instance = await waitFor(async () => {
      const current = await harness.mgr.get(spec.id)
      return current?.state === 'errored' ? current : undefined
    })
    expect(instance.message).toBe('vm died')
    expectClean(harness)
    expect(Object.keys(await readTree(harness.dir))).toContain(
      `${spec.id}.json`
    )
  })
})

describe('instance manager: misc', () => {
  it('reports usage, capacity and endpoints through info/list/get', async () => {
    const harness = await setup()
    const spec = makeSpec({ id: nextId() })
    await harness.mgr.create(spec)

    const list = await harness.mgr.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.endpoints).toHaveLength(spec.expose.length)
    expect(list[0]?.endpoints[0]?.host).toContain('fc.example.com')

    const info: Awaited<ReturnType<InstanceManager['info']>> =
      await harness.mgr.info()
    expect(info.hostId).toBe('host1')
    expect(info.version).toBe('0.0.0')
    expect(info.usage.instances).toBe(1)
    expect(info.capacity.maxInstances).toBe(1000)
    expect(info.accepting).toBe(true)
    expect(info.images).toContain('ubuntu')
  })
})
