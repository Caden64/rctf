import { afterEach, describe, expect, it } from 'bun:test'
import type { InstanceManager } from '../../src/interfaces'
import { createHarness, type Harness } from './harness'
import {
  makeGate,
  makeSpec,
  never,
  readTree,
  waitFor,
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

type CrashPoint =
  | 'after-initial-write'
  | 'after-allocate'
  | 'after-launch'
  | 'after-handle'
  | 'after-publish'
  | 'after-starting'

interface RawRecord {
  state?: string
  lease?: unknown
  vm?: unknown
  message?: string
}

const rawRecord = async (
  dir: string,
  id: string
): Promise<RawRecord | undefined> => {
  const file = (await readTree(dir))[`${id}.json`]
  return file ? (JSON.parse(file) as RawRecord) : undefined
}

const waitRaw = async (
  harness: Harness,
  id: string,
  predicate: (record: RawRecord) => boolean
): Promise<RawRecord> =>
  waitFor(async () => {
    const record = await rawRecord(harness.dir, id)
    return record && predicate(record) ? record : undefined
  })

/** Start a create, let it reach `point`, then "crash" (stop) the agent. */
const crashAt = async (
  point: CrashPoint
): Promise<{ harness: Harness; spec: ReturnType<typeof makeSpec> }> => {
  const harness = await setup({
    config: { shutdownTimeoutSeconds: 0 },
    sweepIntervalMs: 1_000_000,
  })
  const spec = makeSpec()
  let gate: Gate | undefined

  switch (point) {
    case 'after-initial-write':
      gate = makeGate()
      harness.net.allocateGate = gate.promise
      break
    case 'after-allocate':
      gate = makeGate()
      harness.vm.launchStartGate = gate.promise
      break
    case 'after-launch':
      gate = makeGate()
      harness.vm.launchGate = gate.promise
      break
    case 'after-handle':
      gate = makeGate()
      harness.net.publishStartGate = gate.promise
      break
    case 'after-publish':
      gate = makeGate()
      harness.net.publishGate = gate.promise
      break
    case 'after-starting':
      harness.vm.waitReadyHook = () => never()
      break
  }

  const createPromise = harness.mgr.create(spec)
  void createPromise.catch(() => {})

  switch (point) {
    case 'after-initial-write':
      await waitRaw(
        harness,
        spec.id,
        record => record.state === 'creating' && !record.lease && !record.vm
      )
      break
    case 'after-allocate':
      await waitRaw(
        harness,
        spec.id,
        record => record.state === 'creating' && !!record.lease && !record.vm
      )
      break
    case 'after-launch':
      await waitFor(() => harness.vm.handles.has(spec.id) || undefined)
      await waitRaw(
        harness,
        spec.id,
        record => record.state === 'creating' && !!record.lease && !record.vm
      )
      break
    case 'after-handle':
      await waitRaw(
        harness,
        spec.id,
        record => record.state === 'creating' && !!record.vm
      )
      expect(harness.net.published.has(spec.id)).toBe(false)
      break
    case 'after-publish':
      await waitFor(() => harness.net.published.has(spec.id) || undefined)
      await waitRaw(harness, spec.id, record => record.state === 'creating')
      break
    case 'after-starting':
      await waitRaw(harness, spec.id, record => record.state === 'starting')
      break
  }

  // Simulate an abrupt process death: stop without teardown.
  await harness.mgr.stop()
  // Keep the gate closed so the crashed create can never resume and mutate the
  // state it left behind.
  void gate
  if (point === 'after-starting') harness.vm.waitReadyHook = undefined
  return { harness, spec }
}

const assertAggressivelyAbandoned = async (
  harness: Harness,
  spec: ReturnType<typeof makeSpec>,
  mgr: InstanceManager
): Promise<void> => {
  const recovered = await mgr.get(spec.id)
  expect(recovered?.state).toBe('errored')
  expect(recovered?.message).toBe('agent restarted during provisioning')
  expect(harness.net.leases.has(spec.id)).toBe(false)
  expect(harness.vm.alive.has(spec.id)).toBe(false)
  expect(harness.vm.handles.has(spec.id)).toBe(false)
  const raw = await rawRecord(harness.dir, spec.id)
  expect(raw?.message).toBe('agent restarted during provisioning')
  expect(raw?.lease).toBeUndefined()
  expect(raw?.vm).toBeUndefined()
}

describe('crash-window recovery never adopts half-provisioned VMs', () => {
  const creatingPoints: CrashPoint[] = [
    'after-initial-write',
    'after-allocate',
    'after-launch',
    'after-handle',
    'after-publish',
  ]

  for (const point of creatingPoints) {
    it(`rejects a creating record ${point}`, async () => {
      const { harness, spec } = await crashAt(point)
      const mgr = harness.spawn()
      await mgr.start()
      await assertAggressivelyAbandoned(harness, spec, mgr)
    })
  }

  it('adopts a record whose `starting` state was persisted', async () => {
    const { harness, spec } = await crashAt('after-starting')
    const mgr = harness.spawn()
    await mgr.start()

    const running = await waitFor(async () => {
      const current = await mgr.get(spec.id)
      return current?.state === 'running' ? current : undefined
    })
    expect(running.id).toBe(spec.id)
    expect(harness.vm.alive.has(spec.id)).toBe(true)
    expect(harness.vm.destroyedIds).not.toContain(spec.id)
    expect(harness.net.leases.has(spec.id)).toBe(true)
  })
})
