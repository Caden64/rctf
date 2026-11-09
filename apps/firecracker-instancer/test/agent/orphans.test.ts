import { afterEach, describe, expect, it } from 'bun:test'
import { ProtocolError } from '@rctf/firecracker-protocol'
import { createHarness, type Harness } from './harness'
import { makeSpec, nextId, waitFor } from './fakes'

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

describe('orphan cleanup backlog', () => {
  it('retries a failed orphan destroy on later sweeps and stops blocking creates', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const orphanId = nextId('o')
    harness.vm.extraOrphans.push(orphanId)
    harness.vm.failDestroyIds.add(orphanId)

    const mgr = harness.spawn({ sweepIntervalMs: 2 })
    await mgr.start()

    const failing = await mgr.info()
    expect(failing.checks.orphanBacklog).toBe(false)
    expect(failing.accepting).toBe(false)
    expect(harness.vm.destroyedIds).not.toContain(orphanId)
    // No new work is admitted while an orphan is still running unowned.
    expect(await rejectionCode(mgr.create(makeSpec()))).toBe('host_unavailable')

    harness.vm.failDestroyIds.delete(orphanId)
    await waitFor(async () => {
      const info = await mgr.info()
      return info.checks.orphanBacklog && info.accepting ? true : undefined
    })
    expect(harness.vm.destroyedIds).toContain(orphanId)
    expect(harness.vm.alive.has(orphanId)).toBe(false)
  })

  it('re-discovers orphans that appear after recovery', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const mgr = harness.spawn({ sweepIntervalMs: 2, orphanScanSweeps: 2 })
    await mgr.start()
    expect((await mgr.info()).accepting).toBe(true)

    // A VM nobody recorded shows up after the startup scan.
    const late = nextId('l')
    harness.vm.extraOrphans.push(late)
    await waitFor(() =>
      harness.vm.destroyedIds.includes(late) ? true : undefined
    )
    expect(harness.vm.alive.has(late)).toBe(false)
  })
})
