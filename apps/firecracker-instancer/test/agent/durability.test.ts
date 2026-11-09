import { afterEach, describe, expect, it } from 'bun:test'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { ProtocolError } from '@rctf/firecracker-protocol'
import {
  StateStore,
  TombstoneStore,
  type StoreFaults,
} from '../../src/agent/state'
import { createLogger } from '../../src/log'
import { createHarness, type Harness } from './harness'
import {
  makeGate,
  makeSpec,
  nextId,
  readTree,
  removeDir,
  tempDir,
} from './fakes'

const harnesses: Harness[] = []
const dirs: string[] = []

const setup = async (
  opts?: Parameters<typeof createHarness>[0]
): Promise<Harness> => {
  const harness = await createHarness(opts)
  harnesses.push(harness)
  return harness
}

const logger = (): ReturnType<typeof createLogger> =>
  createLogger('durability-test', 'silent')

const ioError = (message = 'injected io error'): Error =>
  Object.assign(new Error(message), { code: 'EIO' })

const rejectionCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (err) {
    if (err instanceof ProtocolError) return err.code
    throw err
  }
  throw new Error('expected the promise to reject')
}

const tombstoneNames = async (dir: string): Promise<string[]> => {
  try {
    const tree = await readTree(dir)
    return Object.keys(tree).filter(name => name.startsWith('tombstones/'))
  } catch {
    return []
  }
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  for (const dir of dirs.splice(0)) await removeDir(dir)
})

describe('tombstone durability (DELETE escalation)', () => {
  it('does not acknowledge a DELETE whose tombstone write failed, and retries durably', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const faults: StoreFaults = {}
    const tombstones = new TombstoneStore(harness.dir, logger(), faults)
    const mgr = harness.spawn({
      store: new StateStore(harness.dir, logger()),
      tombstones,
    })
    await mgr.start()

    const id = nextId()
    faults.writeFile = (fileName, dir) =>
      fileName === `${id}.json` && dir.endsWith('tombstones')
        ? ioError('tombstone write failed')
        : undefined

    // A failed persistence is a 5xx: the controller keeps ownership and retries.
    expect(await rejectionCode(mgr.delete(id))).toBe('internal')
    expect(tombstones.has(id)).toBe(true)
    expect(tombstones.isDurable(id)).toBe(false)
    expect(await tombstoneNames(harness.dir)).not.toContain(
      `tombstones/${id}.json`
    )

    faults.writeFile = undefined
    expect(await rejectionCode(mgr.delete(id))).toBe('not_found')
    expect(tombstones.isDurable(id)).toBe(true)
    expect(await tombstoneNames(harness.dir)).toContain(`tombstones/${id}.json`)

    // After a restart the fence is still durable: a delayed PUT cannot create.
    await mgr.stop()
    const mgr2 = harness.spawn({
      store: new StateStore(harness.dir, logger()),
      tombstones: new TombstoneStore(harness.dir, logger()),
    })
    await mgr2.start()
    expect(await rejectionCode(mgr2.create(makeSpec({ id })))).toBe('conflict')
    expect(harness.vm.launchCalls).toBe(0)
  })

  it('returns internal (and keeps a stopping record) when a known instance cannot be fenced, then finishes on retry', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const faults: StoreFaults = {}
    const tombstones = new TombstoneStore(harness.dir, logger(), faults)
    const mgr = harness.spawn({
      store: new StateStore(harness.dir, logger()),
      tombstones,
    })
    await mgr.start()
    const spec = makeSpec()
    await mgr.create(spec)

    faults.writeFile = () => ioError('tombstone write failed')
    expect(await rejectionCode(mgr.delete(spec.id))).toBe('internal')
    expect((await mgr.get(spec.id))?.state).toBe('stopping')
    expect(harness.net.residue()).toEqual({
      leases: 0,
      published: 0,
      ports: 0,
      hostnames: 0,
    })
    expect(await tombstoneNames(harness.dir)).not.toContain(
      `tombstones/${spec.id}.json`
    )

    faults.writeFile = undefined
    const deleted = await mgr.delete(spec.id)
    expect(deleted.state).toBe('stopped')
    expect(await mgr.get(spec.id)).toBeUndefined()
    expect(await tombstoneNames(harness.dir)).toContain(
      `tombstones/${spec.id}.json`
    )
  })

  it('refreshes the tombstone timestamp on every DELETE', async () => {
    const harness = await setup()
    const id = nextId()
    const t0 = harness.clock.now()

    expect(await rejectionCode(harness.mgr.delete(id))).toBe('not_found')
    const first = JSON.parse(
      (await readTree(harness.dir))[`tombstones/${id}.json`] as string
    ) as { atMs: number }
    expect(first.atMs).toBe(t0)

    harness.clock.advance(500)
    expect(await rejectionCode(harness.mgr.delete(id))).toBe('not_found')
    const second = JSON.parse(
      (await readTree(harness.dir))[`tombstones/${id}.json`] as string
    ) as { atMs: number }
    expect(second.atMs).toBe(t0 + 500)
  })

  it('prunes under the same per-id guard as a DELETE refresh', async () => {
    const root = await tempDir()
    dirs.push(root)
    const faults: StoreFaults = {}
    const store = new TombstoneStore(root, logger(), faults)
    await store.load()
    const id = nextId()
    const t0 = 1_000
    await store.save(id, t0)

    const gate = makeGate()
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => {
      entered = resolve
    })
    faults.beforeRemove = async () => {
      entered()
      await gate.promise
    }

    const prunePromise = store.prune(t0 + 1000, 1000)
    await enteredPromise
    const refreshPromise = store.save(id, t0 + 1500)
    // Give the refresh a chance to (incorrectly) overtake the pruner.
    await new Promise(resolve => setTimeout(resolve, 20))
    gate.open()
    await Promise.all([prunePromise, refreshPromise])

    expect(store.isDurable(id)).toBe(true)
    const persisted = JSON.parse(
      await readFile(path.join(root, 'tombstones', `${id}.json`), 'utf8')
    ) as { atMs: number }
    expect(persisted.atMs).toBe(t0 + 1500)
  })
})

describe('durable state directory errors', () => {
  it('propagates real fsync failures for instance state writes', async () => {
    const dir = await tempDir()
    dirs.push(dir)
    const faults: StoreFaults = {
      fsyncDir: target =>
        target === dir ? ioError('directory fsync failed') : undefined,
    }
    const store = new StateStore(dir, logger(), faults)
    await store.init()
    const record = {
      id: nextId(),
      specHash: 'x',
      spec: {},
      state: 'errored',
      createdAtMs: 0,
      expiresAtMs: 0,
      updatedAtMs: 0,
      version: 1,
      flagProviders: [],
    } as unknown as Parameters<StateStore['save']>[0]
    await expect(store.save(record)).rejects.toThrow('directory fsync failed')
  })

  it('ignores only unsupported directory fsync errors', async () => {
    const dir = await tempDir()
    dirs.push(dir)
    const faults: StoreFaults = {
      fsyncDir: target =>
        target === dir
          ? Object.assign(new Error('fsync unsupported'), { code: 'EINVAL' })
          : undefined,
    }
    const store = new StateStore(dir, logger(), faults)
    await store.init()
    const record = {
      id: nextId(),
      specHash: 'x',
      spec: {},
      state: 'errored',
      createdAtMs: 0,
      expiresAtMs: 0,
      updatedAtMs: 0,
      version: 1,
      flagProviders: [],
    } as unknown as Parameters<StateStore['save']>[0]
    await expect(store.save(record)).resolves.toBeUndefined()
  })

  it('fsyncs the parent directory when creating the state directory', async () => {
    const root = await tempDir()
    dirs.push(root)
    const faults: StoreFaults = {
      fsyncDir: target =>
        target === root ? ioError('parent fsync failed') : undefined,
    }
    const store = new StateStore(path.join(root, 'state'), logger(), faults)
    await expect(store.init()).rejects.toThrow('parent fsync failed')
  })

  it('fsyncs the parent directory when creating the tombstone directory', async () => {
    const root = await tempDir()
    dirs.push(root)
    const faults: StoreFaults = {
      fsyncDir: target =>
        target === root ? ioError('parent fsync failed') : undefined,
    }
    const store = new TombstoneStore(root, logger(), faults)
    await expect(store.init()).rejects.toThrow('parent fsync failed')
  })

  it('propagates fence write failures and keeps a pending (non-durable) fence', async () => {
    const root = await tempDir()
    dirs.push(root)
    const faults: StoreFaults = {}
    const store = new TombstoneStore(root, logger(), faults)
    await store.load()
    const id = nextId()
    faults.fsyncDir = target =>
      target === store.directory ? ioError('fence fsync failed') : undefined

    await expect(store.save(id, 10)).rejects.toThrow('fence fsync failed')
    expect(store.has(id)).toBe(true)
    expect(store.isDurable(id)).toBe(false)

    faults.fsyncDir = undefined
    await store.save(id, 20)
    expect(store.isDurable(id)).toBe(true)
    const persisted = JSON.parse(
      await readFile(path.join(store.directory, `${id}.json`), 'utf8')
    ) as { atMs: number }
    expect(persisted.atMs).toBe(20)
  })

  it('distinguishes an absent directory from an enumeration failure (state)', async () => {
    const dir = await tempDir()
    dirs.push(dir)
    const missing = new StateStore(dir, logger(), {
      readdir: () => Object.assign(new Error('gone'), { code: 'ENOENT' }),
    })
    await missing.init()
    await expect(missing.load()).resolves.toEqual({
      records: [],
      fences: [],
      readErrors: 0,
    })

    const broken = new StateStore(dir, logger(), {
      readdir: () => ioError('readdir failed'),
    })
    await broken.init()
    await expect(broken.load()).rejects.toThrow('readdir failed')
  })

  it('distinguishes an absent directory from an enumeration failure (tombstones)', async () => {
    const root = await tempDir()
    dirs.push(root)
    const missing = new TombstoneStore(root, logger(), {
      readdir: () => Object.assign(new Error('gone'), { code: 'ENOENT' }),
    })
    await missing.init()
    await expect(missing.load()).resolves.toEqual([])

    const broken = new TombstoneStore(root, logger(), {
      readdir: () => ioError('readdir failed'),
    })
    await broken.init()
    await expect(broken.load()).rejects.toThrow('readdir failed')
  })

  it('fails startup closed when the instance state directory cannot be enumerated', async () => {
    const harness = await setup()
    const mgr = harness.spawn({
      store: new StateStore(harness.dir, logger(), {
        readdir: () => ioError('state enumeration failed'),
      }),
    })
    await expect(mgr.start()).rejects.toThrow('state enumeration failed')
  })

  it('fails startup closed when the tombstone directory cannot be enumerated', async () => {
    const harness = await setup()
    const mgr = harness.spawn({
      tombstones: new TombstoneStore(harness.dir, logger(), {
        readdir: () => ioError('tombstone enumeration failed'),
      }),
    })
    await expect(mgr.start()).rejects.toThrow('tombstone enumeration failed')
  })

  it('cleans stale temp files in both state directories on start', async () => {
    const harness = await setup()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      path.join(harness.dir, '.stale.json.tmp-1-1'),
      'partial',
      'utf8'
    )
    await writeFile(
      path.join(harness.dir, 'tombstones', '.stale.json.tmp-1-2'),
      'partial',
      'utf8'
    )
    const mgr = harness.spawn()
    await mgr.start()
    const files = Object.keys(await readTree(harness.dir))
    expect(files.some(name => name.includes('.tmp-'))).toBe(false)
  })
})

describe('extend persistence', () => {
  it('writes the deadline on retry after a failed save', async () => {
    const harness = await setup()
    const faults: StoreFaults = {}
    const store = new StateStore(harness.dir, logger(), faults)
    await harness.mgr.stop()
    const mgr = harness.spawn({ store })
    await mgr.start()

    const spec = makeSpec()
    await mgr.create(spec)
    const deadline = spec.expiresAtMs + 5000

    faults.writeFile = (fileName, dir) =>
      fileName === `${spec.id}.json` && dir === harness.dir
        ? ioError('state write failed')
        : undefined
    await expect(mgr.extend(spec.id, deadline)).rejects.toThrow(
      'state write failed'
    )
    // The in-memory deadline must not be advanced past the durable one.
    expect((await mgr.get(spec.id))?.expiresAtMs).toBe(spec.expiresAtMs)

    faults.writeFile = undefined
    const extended = await mgr.extend(spec.id, deadline)
    expect(extended.expiresAtMs).toBe(deadline)
    const persisted = JSON.parse(
      (await readTree(harness.dir))[`${spec.id}.json`] as string
    ) as { expiresAtMs: number }
    expect(persisted.expiresAtMs).toBe(deadline)
  })
})
