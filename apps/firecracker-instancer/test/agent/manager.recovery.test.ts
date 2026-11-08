import { afterEach, describe, expect, it } from 'bun:test'
import { readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
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
  makeLease,
  makeSpec,
  nextId,
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

const silentLogger = (): ReturnType<typeof createLogger> =>
  createLogger('state-test', 'silent')

const stateStore = (dir: string): StateStore =>
  new StateStore(dir, silentLogger())

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

describe('agent restart recovery', () => {
  it('adopts a live VM and re-arms its lease', async () => {
    const harness = await setup()
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await waitFor(async () =>
      (await harness.mgr.get(spec.id))?.state === 'running' ? true : undefined
    )

    await harness.mgr.stop()
    // A graceful agent stop must NOT kill the guest.
    expect(harness.vm.alive.has(spec.id)).toBe(true)

    const net2 = new FakeNetworkManager()
    const mgr2 = harness.spawn({ net: net2 })
    await mgr2.start()

    const adopted = await mgr2.get(spec.id)
    expect(adopted?.state).toBe('running')
    expect(adopted?.endpoints).toHaveLength(spec.expose.length)
    expect(net2.leases.has(spec.id)).toBe(true)
    expect(net2.lastRestored).toHaveLength(1)
    const restoredLease = net2.lastRestored[0] as unknown as {
      expose?: unknown[]
    }
    expect(restoredLease?.expose).toHaveLength(spec.expose.length)
    expect(harness.vm.adoptCalls).toBeGreaterThan(0)
  })

  it('is re-runnable without duplicating adoption or orphans', async () => {
    const harness = await setup()
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await harness.mgr.stop()

    const net2 = new FakeNetworkManager()
    const mgr2 = harness.spawn({ net: net2 })
    await mgr2.start()
    await mgr2.start()

    expect((await mgr2.get(spec.id))?.state).toBe('running')
    expect(harness.vm.destroyedIds).not.toContain(spec.id)
  })

  it('marks a dead VM errored and cleans its resources', async () => {
    const harness = await setup()
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await waitFor(async () =>
      (await harness.mgr.get(spec.id))?.state === 'running' ? true : undefined
    )
    await harness.mgr.stop()
    harness.vm.alive.delete(spec.id)

    const net2 = new FakeNetworkManager()
    const mgr2 = harness.spawn({ net: net2 })
    await mgr2.start()

    const recovered = await mgr2.get(spec.id)
    expect(recovered?.state).toBe('errored')
    expect(recovered?.message).toBe('vm died')
    expect(harness.vm.handles.has(spec.id)).toBe(false)
    expect(net2.residue()).toEqual({
      leases: 0,
      published: 0,
      ports: 0,
      hostnames: 0,
    })
    expect(Object.keys(await readTree(harness.dir))).toContain(
      `${spec.id}.json`
    )
  })

  it('drops a creating record that has no live VM', async () => {
    const harness = await setup()
    const spec = makeSpec()
    const lease = leaseToJson(makeLease(spec.id, toExpose(spec.expose)))
    const record = {
      ...buildStoredInstance(spec, harness.clock.now(), 'creating'),
      lease,
      updatedAtMs: harness.clock.now(),
    }
    await stateStore(harness.dir).save(record)

    const net2 = new FakeNetworkManager()
    net2.leases.set(spec.id, lease)
    const mgr2 = harness.spawn({ net: net2 })
    await mgr2.start()

    expect(await mgr2.get(spec.id)).toBeUndefined()
    expect(net2.releaseCalls).toBeGreaterThan(0)
    expect(Object.keys(await readTree(harness.dir))).not.toContain(
      `${spec.id}.json`
    )
  })

  it('resumes teardown for a stopping record', async () => {
    const harness = await setup()
    const spec = makeSpec()
    const lease = leaseToJson(makeLease(spec.id, toExpose(spec.expose)))
    const handle = makeHandle(spec.id)
    await stateStore(harness.dir).save({
      ...buildStoredInstance(spec, harness.clock.now(), 'stopping'),
      lease,
      vm: handle,
      updatedAtMs: harness.clock.now(),
    })

    const vm2 = new FakeVmDriver()
    vm2.handles.set(spec.id, handle)
    const net2 = new FakeNetworkManager()
    net2.leases.set(spec.id, lease)
    const mgr2 = harness.spawn({ vm: vm2, net: net2 })
    await mgr2.start()

    expect(await mgr2.get(spec.id)).toBeUndefined()
    expect(vm2.stopCalls).toBeGreaterThan(0)
    expect(vm2.destroyedIds).toContain(spec.id)
    expect(net2.leases.has(spec.id)).toBe(false)
    const files = Object.keys(await readTree(harness.dir)).filter(
      name => !name.startsWith('tombstones/')
    )
    expect(files).toHaveLength(0)
  })

  it('destroys VMs that no record owns', async () => {
    const harness = await setup()
    const orphanId = nextId('o')
    harness.vm.extraOrphans.push(orphanId)

    const mgr2 = harness.spawn()
    await mgr2.start()

    expect(harness.vm.destroyedIds).toContain(orphanId)
  })

  it('quarantines a corrupt state file without crashing', async () => {
    const harness = await setup()
    const spec = makeSpec()
    await harness.mgr.create(spec)
    await harness.mgr.stop()

    const badId = nextId('b')
    await writeFile(
      path.join(harness.dir, `${badId}.json`),
      '{not json',
      'utf8'
    )

    const mgr2 = harness.spawn()
    await mgr2.start()

    const names = await readdir(harness.dir)
    expect(names).not.toContain(`${badId}.json`)
    expect(names.some(name => name.endsWith('.corrupt'))).toBe(true)
    expect((await mgr2.get(spec.id))?.state).toBe('running')
  })
})

describe('durable state files', () => {
  it('are written atomically with 0600 files in a 0700 directory', async () => {
    const harness = await setup()
    const spec = makeSpec()
    await harness.mgr.create(spec)

    const dirMode = (await stat(harness.dir)).mode & 0o777
    const fileName = `${spec.id}.json`
    const fileMode = (await stat(path.join(harness.dir, fileName))).mode & 0o777
    expect(dirMode).toBe(0o700)
    expect(fileMode).toBe(0o600)

    await waitFor(async () => {
      const current = await readdir(harness.dir)
      return current.some(name => name.includes('.tmp')) ? undefined : true
    })
    const names = await readdir(harness.dir)
    expect(names.filter(name => name.includes('.tmp'))).toHaveLength(0)
    const files = await readTree(harness.dir)
    expect(Object.keys(files)).toContain(fileName)
    const persisted = JSON.parse(files[fileName] as string) as {
      lease?: { expose?: unknown[] }
    }
    expect(persisted.lease?.expose).toHaveLength(spec.expose.length)
  })
})
