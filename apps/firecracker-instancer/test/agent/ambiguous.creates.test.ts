import { afterEach, describe, expect, it } from 'bun:test'
import { readTree } from './fakes'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ProtocolError } from '@rctf/firecracker-protocol'
import {
  buildStoredInstance,
  leaseToJson,
  StateStore,
} from '../../src/agent/state'
import type { VmHandle } from '../../src/interfaces'
import { createLogger } from '../../src/log'
import { createHarness, type Harness } from './harness'
import {
  FakeNetworkManager,
  FakeVmDriver,
  makeGate,
  makeLease,
  makeSpec,
  waitFor,
  toExpose,
  type Gate,
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

const logger = (): ReturnType<typeof createLogger> =>
  createLogger('ambiguous-create-test', 'silent')

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

const makeHandle = (instanceId: string): VmHandle => ({
  instanceId,
  pid: 4242,
  pidStartTicks: 7,
  apiSocket: `/run/${instanceId}/api.sock`,
  dir: `/run/${instanceId}`,
})

/**
 * Drive one provisioning stage past the operation deadline while its fake call
 * is still gated. The record must never be acknowledged as gone before the
 * late call settles and its resources are released.
 */
const assertDeleteFencedUntilSettled = async (opts: {
  stage: 'allocate' | 'launch' | 'publish'
  expectedMessage: string
}): Promise<void> => {
  const harness = await setup({
    operationTimeoutMs: 20,
    sweepIntervalMs: 2,
  })
  const spec = makeSpec()
  const gate: Gate = makeGate()
  if (opts.stage === 'allocate') harness.net.allocateGate = gate.promise
  if (opts.stage === 'launch') harness.vm.launchGate = gate.promise
  if (opts.stage === 'publish') harness.net.publishGate = gate.promise

  const created = await harness.mgr.create(spec)
  expect(created.state).toBe('errored')
  expect(created.message).toBe(opts.expectedMessage)

  // The call outlived the deadline: its outcome is unknown, so capacity is
  // still accounted and DELETE cannot be acknowledged.
  expect((await harness.mgr.info()).usage.instances).toBe(1)
  expect(await rejectionCode(harness.mgr.delete(spec.id))).toBe('in_progress')
  expect((await harness.mgr.get(spec.id))?.state).toBe('stopping')
  expect(harness.vm.destroyedIds).not.toContain(spec.id)
  expect((await harness.mgr.info()).usage.instances).toBe(1)

  // Only once the late call settles may the sweep release/destroy and finish.
  gate.open()
  await waitFor(async () =>
    (await harness.mgr.get(spec.id)) === undefined ? true : undefined
  )
  if (opts.stage !== 'allocate') {
    expect(harness.vm.destroyedIds).toContain(spec.id)
    expect(harness.vm.alive.has(spec.id)).toBe(false)
  }
  expectClean(harness)
  expect((await harness.mgr.info()).usage.instances).toBe(0)
}

describe('ambiguous creates are fenced until the operation settles', () => {
  it('keeps a timed-out launch alive but unacknowledged, then destroys it', async () => {
    await assertDeleteFencedUntilSettled({
      stage: 'launch',
      expectedMessage: 'launch failed',
    })
  })

  it('keeps a timed-out allocate unacknowledged, then releases the lease', async () => {
    await assertDeleteFencedUntilSettled({
      stage: 'allocate',
      expectedMessage: 'network allocation failed',
    })
  })

  it('keeps a timed-out publish unacknowledged, then releases its routes', async () => {
    await assertDeleteFencedUntilSettled({
      stage: 'publish',
      expectedMessage: 'network publish failed',
    })
  })

  it('does not acknowledge a DELETE that times out while waiting for the settle grace', async () => {
    const harness = await setup({
      operationTimeoutMs: 10,
      sweepIntervalMs: 1_000_000,
    })
    const spec = makeSpec()
    const gate = makeGate()
    harness.vm.launchGate = gate.promise

    await harness.mgr.create(spec)
    // Never opened: the record stays `stopping` and every DELETE is a 409.
    expect(await rejectionCode(harness.mgr.delete(spec.id))).toBe('in_progress')
    expect(await rejectionCode(harness.mgr.delete(spec.id))).toBe('in_progress')
    expect((await harness.mgr.get(spec.id))?.state).toBe('stopping')
    expect((await harness.mgr.info()).usage.instances).toBe(1)

    gate.open()
    // The sweep is disabled, so the retried teardown finishes through DELETE.
    const deleted = await harness.mgr.delete(spec.id)
    expect(deleted.state).toBe('stopped')
    expect(harness.vm.destroyedIds).toContain(spec.id)
    expectClean(harness)
  })
})

describe('restart with may-hold ownership but no handle', () => {
  it('releases network and destroys the VM by id during recovery', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const spec = makeSpec()
    const lease = leaseToJson(makeLease(spec.id, toExpose(spec.expose)))
    const handle = makeHandle(spec.id)
    await harness.mgr.stop()

    await new StateStore(harness.dir, logger()).save({
      ...buildStoredInstance(spec, harness.clock.now(), 'creating'),
      netMayHold: true,
      vmMayHold: true,
      updatedAtMs: harness.clock.now(),
    })

    const vm2 = new FakeVmDriver()
    vm2.handles.set(spec.id, handle)
    vm2.alive.add(spec.id)
    const net2 = new FakeNetworkManager()
    net2.leases.set(spec.id, lease)
    net2.published.add(spec.id)

    const mgr = harness.spawn({ vm: vm2, net: net2 })
    await mgr.start()

    expect(vm2.destroyedIds).toContain(spec.id)
    expect(vm2.handles.has(spec.id)).toBe(false)
    // The lease is released by id from the persisted may-hold ownership (not
    // merely by `net.restore` dropping it as an unowned artifact).
    expect(net2.releaseCalls).toBeGreaterThan(0)
    expect(net2.leases.has(spec.id)).toBe(false)
    expect(net2.published.has(spec.id)).toBe(false)
    expect((await mgr.get(spec.id))?.state).toBe('errored')

    const raw = JSON.parse(
      (await readTree(harness.dir))[`${spec.id}.json`] as string
    ) as Record<string, unknown>
    expect(raw.netMayHold).toBeUndefined()
    expect(raw.vmMayHold).toBeUndefined()
    expect(raw.lease).toBeUndefined()
    expect(raw.vm).toBeUndefined()

    // Reads as a real file too (not just the in-memory record).
    const persisted = JSON.parse(
      await readFile(path.join(harness.dir, `${spec.id}.json`), 'utf8')
    ) as Record<string, unknown>
    expect(persisted.netMayHold).toBeUndefined()
    expect(persisted.vmMayHold).toBeUndefined()
  })
})
