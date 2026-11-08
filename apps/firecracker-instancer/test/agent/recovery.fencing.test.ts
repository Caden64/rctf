import { afterEach, describe, expect, it } from 'bun:test'
import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ProtocolError } from '@rctf/firecracker-protocol'
import {
  StateStore,
  TombstoneStore,
  buildStoredInstance,
  type StoreFaults,
} from '../../src/agent/state'
import { createLogger } from '../../src/log'
import type { VmHandle } from '../../src/interfaces'
import { createHarness, type Harness } from './harness'
import {
  FakeNetworkManager,
  FakeVmDriver,
  makeSpec,
  nextId,
  readTree,
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

const logger = (): ReturnType<typeof createLogger> =>
  createLogger('recovery-fencing-test', 'silent')

const ioError = (message = 'injected read error'): Error =>
  Object.assign(new Error(message), { code: 'EACCES' })

const rejectionCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (err) {
    if (err instanceof ProtocolError) return err.code
    throw err
  }
  throw new Error('expected the promise to reject')
}

const makeHandle = (instanceId: string): VmHandle => ({
  instanceId,
  pid: 5150,
  pidStartTicks: 9,
  apiSocket: `/run/${instanceId}/api.sock`,
  dir: `/run/${instanceId}`,
})

describe('creates are rejected until recovery has completed', () => {
  it('rejects a PUT during a failed recovery with zero side effects, then accepts one after recovery', async () => {
    const harness = await setup()
    const existing = makeSpec()
    await harness.mgr.create(existing)
    await waitFor(async () =>
      (await harness.mgr.get(existing.id))?.state === 'running'
        ? true
        : undefined
    )
    await harness.mgr.stop()

    const net2 = new FakeNetworkManager()
    net2.failRestore = true
    const mgr = harness.spawn({ net: net2, sweepIntervalMs: 2 })
    await mgr.start()

    const failing = await mgr.info()
    expect(failing.checks.recovered).toBe(false)
    expect(failing.accepting).toBe(false)

    const launchesBefore = harness.vm.launchCalls
    const allocatedBefore = net2.allocateCalls
    const spec = makeSpec()
    expect(await rejectionCode(mgr.create(spec))).toBe('host_unavailable')
    expect(harness.vm.launchCalls).toBe(launchesBefore)
    expect(net2.allocateCalls).toBe(allocatedBefore)
    // Nothing was written for the rejected id.
    expect(Object.keys(await readTree(harness.dir))).not.toContain(
      `${spec.id}.json`
    )

    net2.failRestore = false
    await waitFor(async () => {
      const info = await mgr.info()
      return info.checks.recovered && info.accepting ? true : undefined
    })
    const created = await mgr.create(spec)
    expect(created.id).toBe(spec.id)
    expect(harness.vm.launchCalls).toBe(launchesBefore + 1)
  })
})

describe('unreadable state files fail recovery closed', () => {
  it('does not discard an acknowledged tombstone it cannot read', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const id = nextId()
    expect(await rejectionCode(harness.mgr.delete(id))).toBe('not_found')
    await harness.mgr.stop()

    const broken = harness.spawn({
      sweepIntervalMs: 1_000_000,
      tombstones: new TombstoneStore(
        harness.dir,
        logger(),
        {
          readFile: fileName =>
            fileName === `${id}.json` ? ioError() : undefined,
        },
        harness.clock.now
      ),
    })
    await broken.start()
    expect((await broken.info()).checks.recovered).toBe(false)
    expect((await broken.info()).accepting).toBe(false)
    expect(await rejectionCode(broken.create(makeSpec({ id })))).toBe(
      'host_unavailable'
    )
    expect(harness.vm.launchCalls).toBe(0)
    await broken.stop()

    // Once readable again the fence is enforced: the id can never be reused.
    const healthy = harness.spawn({ sweepIntervalMs: 1_000_000 })
    await healthy.start()
    expect(await rejectionCode(healthy.create(makeSpec({ id })))).toBe(
      'conflict'
    )
  })

  it('fails closed on an unreadable instance state file and recovers on a later sweep', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await waitFor(async () =>
      (await harness.mgr.get(spec.id))?.state === 'running' ? true : undefined
    )
    await harness.mgr.stop()

    let failReads = true
    const store = new StateStore(harness.dir, logger(), {
      readFile: fileName =>
        failReads && fileName === `${spec.id}.json` ? ioError() : undefined,
    })
    const broken = harness.spawn({ store, sweepIntervalMs: 2 })
    await broken.start()

    expect((await broken.info()).checks.recovered).toBe(false)
    expect(await rejectionCode(broken.create(makeSpec()))).toBe(
      'host_unavailable'
    )

    failReads = false
    await waitFor(async () =>
      (await broken.info()).checks.recovered ? true : undefined
    )
    expect((await broken.get(spec.id))?.state).toBe('running')
    expect(harness.vm.destroyedIds).not.toContain(spec.id)
  })
})

describe('malformed files are quarantined and conservatively fenced', () => {
  it('replaces a malformed tombstone with a durable conservative fence', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const id = nextId()
    expect(await rejectionCode(harness.mgr.delete(id))).toBe('not_found')
    await harness.mgr.stop()

    await writeFile(
      path.join(harness.dir, 'tombstones', `${id}.json`),
      '{not json',
      'utf8'
    )

    const mgr = harness.spawn({ sweepIntervalMs: 1_000_000 })
    await mgr.start()

    expect((await mgr.info()).accepting).toBe(true)
    const names = await readdir(path.join(harness.dir, 'tombstones'))
    expect(names.some(name => name.endsWith('.corrupt'))).toBe(true)
    expect(names).toContain(`${id}.json`)
    const rewritten = JSON.parse(
      (await readTree(harness.dir))[`tombstones/${id}.json`] as string
    ) as { id: string; atMs: number }
    expect(rewritten.id).toBe(id)

    expect(await rejectionCode(mgr.create(makeSpec({ id })))).toBe('conflict')
    expect(harness.vm.launchCalls).toBe(0)
  })

  it('fences a malformed instance record and destroys the VM it no longer owns', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const id = nextId()
    const handle = makeHandle(id)
    await harness.mgr.stop()

    await writeFile(path.join(harness.dir, `${id}.json`), '{not json', 'utf8')

    const vm2 = new FakeVmDriver()
    vm2.handles.set(id, handle)
    vm2.alive.add(id)
    const mgr = harness.spawn({ vm: vm2, sweepIntervalMs: 1_000_000 })
    await mgr.start()

    const names = await readdir(harness.dir)
    expect(names.some(name => name.endsWith('.corrupt'))).toBe(true)
    expect(names).not.toContain(`${id}.json`)
    expect(Object.keys(await readTree(harness.dir))).toContain(
      `tombstones/${id}.json`
    )
    // The id is fenced and the unowned VM is discovered and destroyed.
    expect(await rejectionCode(mgr.create(makeSpec({ id })))).toBe('conflict')
    expect(vm2.destroyedIds).toContain(id)
    expect(vm2.handles.has(id)).toBe(false)
  })

  it('quarantines a state file whose content id disagrees with its filename', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const id = nextId()
    const other = nextId()
    await harness.mgr.stop()

    const record = buildStoredInstance(
      makeSpec({ id: other }),
      harness.clock.now(),
      'starting'
    )
    await writeFile(
      path.join(harness.dir, `${id}.json`),
      JSON.stringify(record),
      'utf8'
    )

    const mgr = harness.spawn({ sweepIntervalMs: 1_000_000 })
    await mgr.start()

    expect(await rejectionCode(mgr.create(makeSpec({ id })))).toBe('conflict')
    expect(await mgr.get(other)).toBeUndefined()
  })
})

describe('a malformed file is only quarantined after its fence is durable', () => {
  it('keeps a malformed tombstone in place and recovery closed when the replacement fence cannot be written', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const id = nextId()
    expect(await rejectionCode(harness.mgr.delete(id))).toBe('not_found')
    await harness.mgr.stop()
    await writeFile(
      path.join(harness.dir, 'tombstones', `${id}.json`),
      '{not json',
      'utf8'
    )

    const faults: StoreFaults = {
      writeFile: (fileName, dir) =>
        fileName === `${id}.json` && dir.endsWith('tombstones')
          ? ioError('fence write failed')
          : undefined,
    }
    const tombstones = new TombstoneStore(
      harness.dir,
      logger(),
      faults,
      harness.clock.now
    )
    const mgr = harness.spawn({ tombstones, sweepIntervalMs: 1_000_000 })
    await mgr.start()

    const info = await mgr.info()
    expect(info.checks.recovered).toBe(false)
    expect(info.accepting).toBe(false)
    // The original file is the only fence evidence: it must stay in place and
    // must not have been renamed to `.corrupt`.
    let names = await readdir(path.join(harness.dir, 'tombstones'))
    expect(names).toContain(`${id}.json`)
    expect(names.some(name => name.endsWith('.corrupt'))).toBe(false)
    expect(await rejectionCode(mgr.create(makeSpec({ id })))).toBe(
      'host_unavailable'
    )
    expect(harness.vm.launchCalls).toBe(0)

    // Once writes work again the next load fences durably, then quarantines.
    faults.writeFile = undefined
    await mgr.stop()
    const healthy = harness.spawn({ sweepIntervalMs: 1_000_000 })
    await healthy.start()
    expect((await healthy.info()).accepting).toBe(true)
    expect(await rejectionCode(healthy.create(makeSpec({ id })))).toBe(
      'conflict'
    )
    names = await readdir(path.join(harness.dir, 'tombstones'))
    expect(names).toContain(`${id}.json`)
    expect(names.some(name => name.endsWith('.corrupt'))).toBe(true)
  })

  it('keeps a malformed state record until its conservative tombstone is durable', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const id = nextId()
    await harness.mgr.stop()
    await writeFile(path.join(harness.dir, `${id}.json`), '{not json', 'utf8')

    const faults: StoreFaults = {
      writeFile: (fileName, dir) =>
        fileName === `${id}.json` && dir.endsWith('tombstones')
          ? ioError('tombstone write failed')
          : undefined,
    }
    const mgr = harness.spawn({
      tombstones: new TombstoneStore(
        harness.dir,
        logger(),
        faults,
        harness.clock.now
      ),
      sweepIntervalMs: 1_000_000,
    })
    await mgr.start()

    expect((await mgr.info()).checks.recovered).toBe(false)
    expect((await mgr.info()).accepting).toBe(false)
    let names = await readdir(harness.dir)
    expect(names).toContain(`${id}.json`)
    expect(names.some(name => name.endsWith('.corrupt'))).toBe(false)
    // The in-process pending fence still rejects the id even though it is not
    // durable yet (and recovery is not accepting new instances).
    expect(['conflict', 'host_unavailable']).toContain(
      await rejectionCode(mgr.create(makeSpec({ id })))
    )

    faults.writeFile = undefined
    await mgr.stop()
    const healthy = harness.spawn({ sweepIntervalMs: 1_000_000 })
    await healthy.start()
    expect((await healthy.info()).accepting).toBe(true)
    names = await readdir(harness.dir)
    expect(names).not.toContain(`${id}.json`)
    expect(names.some(name => name.endsWith('.corrupt'))).toBe(true)
    expect(await rejectionCode(healthy.create(makeSpec({ id })))).toBe(
      'conflict'
    )
  })
})

describe('state read failures are a distinct failure mode', () => {
  it('is not conflated with malformed JSON', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await harness.mgr.stop()

    // A read error must not quarantine (that would lose the record); it is
    // reported so the manager can fail recovery closed and retry.
    const store = new StateStore(harness.dir, logger(), {
      readFile: () => ioError(),
    })
    const result = await store.load()
    expect(result.readErrors).toBeGreaterThan(0)
    expect(result.fences).toEqual([])
    const names = await readdir(harness.dir)
    expect(names).toContain(`${spec.id}.json`)
    expect(names.some(name => name.endsWith('.corrupt'))).toBe(false)
  })
})
