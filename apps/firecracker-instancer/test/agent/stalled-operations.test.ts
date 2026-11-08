import { afterEach, describe, expect, it } from 'bun:test'
import type { NetLease, NetExposeRequest } from '../../src/interfaces'
import { createHarness, type Harness } from './harness'
import {
  FakeNetworkManager,
  captureLogger,
  makeSpec,
  never,
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

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/**
 * A network manager whose `allocate` returns a thenable that NEVER settles and
 * counts every reaction attached to it. It detects the old retry pattern that
 * wrapped the same pending promise in a fresh `Promise.allSettled` per sweep.
 */
class CountingPendingNetwork extends FakeNetworkManager {
  attaches = 0

  override allocate(_req: {
    instanceId: string
    egress: boolean
    expose: NetExposeRequest[]
  }): Promise<NetLease> {
    const thenable = {}
    // oxlint-disable-next-line unicorn/no-thenable -- a thenable is required to observe how many reactions the manager attaches to a never-settling operation.
    Object.defineProperty(thenable, 'then', {
      value: () => {
        this.attaches += 1
        return thenable
      },
    })
    Object.defineProperty(thenable, 'catch', { value: () => thenable })
    Object.defineProperty(thenable, 'finally', { value: () => thenable })
    return thenable as Promise<NetLease>
  }
}

describe('never-settling provisioning operations', () => {
  it('do not delay another instance dead-man expiry across all sweep slots', async () => {
    const harness = await setup({
      sweepIntervalMs: 2,
      sweepConcurrency: 8,
      operationTimeoutMs: 200,
    })
    const base = harness.clock.now()
    const stalled = Array.from({ length: 8 }, () =>
      makeSpec({ expiresAtMs: base + 3_600_000 })
    )
    const stalledIds = new Set(stalled.map(spec => spec.id))
    harness.net.allocateGateFor = instanceId =>
      stalledIds.has(instanceId) ? never() : undefined

    // Every create times out but keeps ONE never-settling pending operation.
    await Promise.all(stalled.map(spec => harness.mgr.create(spec)))
    for (const spec of stalled) {
      expect((await harness.mgr.get(spec.id))?.state).toBe('errored')
    }

    const expiring = makeSpec({ expiresAtMs: base + 100 })
    await harness.mgr.create(expiring)
    await waitFor(async () =>
      (await harness.mgr.get(expiring.id))?.state === 'running'
        ? true
        : undefined
    )

    // Eight stalled entries would fill every worker slot if a sweep waited on
    // the pending operation; with non-blocking checks the dead-man teardown of
    // the unrelated instance must still happen promptly.
    harness.clock.advance(100 + 10_000 + 1)
    await waitFor(async () =>
      (await harness.mgr.get(expiring.id)) === undefined ? true : undefined
    )
    expect((await harness.mgr.get(stalled[0]?.id ?? ''))?.state).toBe('errored')
  })

  it('attach exactly one settlement reaction even across many retrying sweeps', async () => {
    const net = new CountingPendingNetwork()
    const harness = await setup({
      net,
      sweepIntervalMs: 2,
      operationTimeoutMs: 50,
    })
    const spec = makeSpec()
    await harness.mgr.create(spec)
    const initial = net.attaches
    expect(initial).toBeGreaterThan(0)

    // Let many sweeps retry the errored record (each one skips non-blockingly).
    await sleep(60)
    expect(net.attaches).toBe(initial)

    // A DELETE waits bounded and answers `in_progress` without re-wrapping.
    let code = ''
    try {
      await harness.mgr.delete(spec.id)
    } catch (err) {
      code = (err as { code?: string }).code ?? ''
    }
    expect(code).toBe('in_progress')
    expect(net.attaches).toBe(initial)
  })

  it('reports the stalled check critically (accepting=false) after the abandon window', async () => {
    const capture = captureLogger()
    const harness = await setup({
      logger: capture.logger,
      sweepIntervalMs: 2,
      operationTimeoutMs: 50,
      config: { pendingOperationAbandonSeconds: 5 },
    })
    const spec = makeSpec()
    harness.net.allocateGateFor = instanceId =>
      instanceId === spec.id ? never() : undefined
    await harness.mgr.create(spec)

    let info = await harness.mgr.info()
    expect(info.checks.stalledOperations).toBe(true)
    expect(info.usage.instances).toBe(1)

    harness.clock.advance(5_001)
    info = await harness.mgr.info()
    expect(info.checks.stalledOperations).toBe(false)
    expect(info.accepting).toBe(false)
    expect(info.usage.instances).toBe(1)
    // Fail safe: the operation is never forgotten.
    expect((await harness.mgr.get(spec.id))?.state).toBe('errored')

    await sleep(30)
    const matches = capture.text().match(/has not settled/g) ?? []
    expect(matches).toHaveLength(1)
  })
})
