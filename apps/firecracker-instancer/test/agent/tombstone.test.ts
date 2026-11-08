import { afterEach, describe, expect, it } from 'bun:test'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { ProtocolError } from '@rctf/firecracker-protocol'
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

const tombstoneFile = (dir: string, id: string): string =>
  path.join(dir, 'tombstones', `${id}.json`)

describe('deleted-id tombstones', () => {
  it('fences an unknown id on DELETE and rejects a later create', async () => {
    const harness = await setup()
    const id = nextId()
    const spec = makeSpec({ id })

    expect(await rejectionCode(harness.mgr.delete(id))).toBe('not_found')

    const raw = await readTree(harness.dir)
    const record = raw[`tombstones/${id}.json`]
    expect(record).toBeDefined()
    const parsed = JSON.parse(record as string) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['atMs', 'id'])
    expect(parsed.id).toBe(id)

    const fileMode = (await stat(tombstoneFile(harness.dir, id))).mode & 0o777
    const dirMode =
      (await stat(path.join(harness.dir, 'tombstones'))).mode & 0o777
    expect(fileMode).toBe(0o600)
    expect(dirMode).toBe(0o700)

    expect(await rejectionCode(harness.mgr.create(spec))).toBe('conflict')
    expect(harness.vm.launchCalls).toBe(0)
  })

  it('fences a normally deleted id after full cleanup', async () => {
    const harness = await setup()
    const spec = makeSpec()

    await harness.mgr.create(spec)
    const deleted = await harness.mgr.delete(spec.id)
    expect(deleted.state).toBe('stopped')

    expect(await rejectionCode(harness.mgr.create(spec))).toBe('conflict')
    expect(harness.vm.launchCalls).toBe(1)
    expect(harness.vm.processResidue()).toBe(0)
    expect(harness.net.residue()).toEqual({
      leases: 0,
      published: 0,
      ports: 0,
      hostnames: 0,
    })
  })

  it('serialises DELETE and PUT in either order', async () => {
    for (const order of ['delete-first', 'put-first'] as const) {
      const harness = await setup()
      const spec = makeSpec()

      const results = await Promise.allSettled(
        order === 'delete-first'
          ? [harness.mgr.delete(spec.id), harness.mgr.create(spec)]
          : [harness.mgr.create(spec), harness.mgr.delete(spec.id)]
      )
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(ProtocolError)
          expect(['not_found', 'conflict']).toContain(
            (result.reason as ProtocolError).code
          )
        }
      }

      expect(await harness.mgr.get(spec.id)).toBeUndefined()
      expect(harness.vm.launchCalls).toBeLessThanOrEqual(1)
      expect(await rejectionCode(harness.mgr.create(spec))).toBe('conflict')
      expect(harness.vm.processResidue()).toBe(0)
      expect(harness.net.residue()).toEqual({
        leases: 0,
        published: 0,
        ports: 0,
        hostnames: 0,
      })
    }
  })

  it('survives a manager restart over the same state dir', async () => {
    const harness = await setup()
    const id = nextId()
    const spec = makeSpec({ id })
    expect(await rejectionCode(harness.mgr.delete(id))).toBe('not_found')

    await harness.mgr.stop()
    const mgr2 = harness.spawn()
    await mgr2.start()

    expect(await rejectionCode(mgr2.create(spec))).toBe('conflict')
    expect(harness.vm.launchCalls).toBe(0)
    expect(await mgr2.get(id)).toBeUndefined()
  })

  it('never stores the spec or flags in a tombstone', async () => {
    const harness = await setup()
    const flag = 'FLAG{tombstone-must-not-copy-me}'
    const spec = makeSpec({ flags: [{ provider: 'rctf/flag', flag }] })
    await harness.mgr.create(spec)
    await harness.mgr.delete(spec.id)

    const raw = await readTree(harness.dir)
    const tombstone = raw[`tombstones/${spec.id}.json`]
    expect(tombstone).toBeDefined()
    expect(tombstone as string).not.toContain(flag)
    expect(tombstone as string).not.toContain(spec.teamKey)
    const parsed = JSON.parse(tombstone as string) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['atMs', 'id'])
  })

  it('prunes tombstones after the TTL using the injected clock', async () => {
    const harness = await setup({
      tombstoneTtlMs: 1000,
      sweepIntervalMs: 2,
    })
    const id = nextId()
    const spec = makeSpec({ id })
    expect(await rejectionCode(harness.mgr.delete(id))).toBe('not_found')
    expect(await readdir(path.join(harness.dir, 'tombstones'))).toContain(
      `${id}.json`
    )
    expect(harness.vm.launchCalls).toBe(0)

    harness.clock.advance(1000)
    await waitFor(async () => {
      const names = await readdir(path.join(harness.dir, 'tombstones'))
      return names.includes(`${id}.json`) ? undefined : true
    })

    const created = await harness.mgr.create(spec)
    expect(created.state).not.toBe('errored')
    expect(harness.vm.launchCalls).toBe(1)
  })
})
