import { afterEach, describe, expect, it } from 'bun:test'
import { createHarness, type Harness } from './harness'
import { FakeVmDriver } from './fakes'

class PreflightVm extends FakeVmDriver {
  constructor(private readonly checks: Record<string, boolean>) {
    super()
  }
  override async preflight() {
    return { checks: this.checks, images: ['smoke'] }
  }
}

let harness: Harness | undefined
afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

describe('agent info accepting', () => {
  it('stays accepting when only informational checks fail (no reflink)', async () => {
    // A filesystem without reflink only makes boots slower; it must NOT take the
    // host out of rotation (found by a real smoke run: ext4/tmpfs hosts would
    // otherwise report accepting:false forever and never receive instances).
    harness = await createHarness({
      vm: new PreflightVm({ kvm: true, firecrackerBin: true, reflink: false }),
    })
    const info = await harness.mgr.info()
    expect(info.checks.reflink).toBe(false)
    expect(info.accepting).toBe(true)
  })

  it('stops accepting when a critical check fails', async () => {
    harness = await createHarness({
      vm: new PreflightVm({ kvm: false, firecrackerBin: true, reflink: true }),
    })
    expect((await harness.mgr.info()).accepting).toBe(false)
  })
})
