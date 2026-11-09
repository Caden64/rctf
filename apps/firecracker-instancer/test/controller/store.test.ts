import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { ProtocolError } from '@rctf/firecracker-protocol'
import {
  Store,
  StoreClosedError,
  type InstanceRecord,
} from '../../src/controller/store'
import { cleanupDir, databasePath, testDir } from './helpers'

const dirs: string[] = []

const newStore = (): { store: Store; path: string; dir: string } => {
  const dir = testDir()
  dirs.push(dir)
  const path = databasePath(dir)
  return { store: new Store(path, () => 1000), path, dir }
}

afterEach(() => {
  while (dirs.length > 0) cleanupDir(dirs.pop()!)
})

const instance = (overrides: Partial<InstanceRecord> = {}): InstanceRecord => ({
  id: 'a'.repeat(24),
  teamId: 'team-1',
  challengeIntegrationId: 'chal-1',
  teamKey: 'deadbeefdeadbeefdeadbeefdeadbeef',
  hostId: 'host-a',
  state: 'running',
  image: 'base',
  vcpus: 1,
  memMiB: 256,
  diskMiB: 128,
  expiresAtMs: 10_000,
  createdAtMs: 1000,
  updatedAtMs: 1000,
  revision: 0,
  message: null,
  agentExpirySynced: true,
  expose: [{ kind: 'http', hostPrefix: 'chal', port: 8080, title: 'Web' }],
  endpoints: null,
  ...overrides,
})

describe('store', () => {
  test('the live unique index prevents two live instances for one key', () => {
    const { store } = newStore()
    store.ensureHost('host-a', 'http://a')
    store.insertInstance(instance())
    expect(() =>
      store.insertInstance(instance({ id: 'b'.repeat(24) }))
    ).toThrow()
    expect(store.getLiveInstance(instance())?.id).toBe('a'.repeat(24))

    // Terminal states free the key.
    expect(store.casState('a'.repeat(24), ['running'], 'errored', 2000)).toBe(
      true
    )
    store.insertInstance(instance({ id: 'b'.repeat(24) }))
    expect(store.getLiveInstance(instance())?.id).toBe('b'.repeat(24))
    store.close()
  })

  test('reservations count creating/running/deleting only', () => {
    const { store } = newStore()
    store.ensureHost('host-a', 'http://a')
    store.insertInstance(instance({ id: 'a'.repeat(24), state: 'running' }))
    store.insertInstance(
      instance({
        id: 'b'.repeat(24),
        teamId: 'team-2',
        state: 'deleting',
        memMiB: 512,
      })
    )
    store.insertInstance(
      instance({
        id: 'c'.repeat(24),
        teamId: 'team-3',
        state: 'errored',
      })
    )
    store.insertInstance(
      instance({ id: 'd'.repeat(24), teamId: 'team-4', state: 'lost' })
    )
    expect(store.reservedForHost('host-a')).toEqual({
      vcpus: 2,
      memMiB: 768,
      diskMiB: 256,
      instances: 2,
    })
    store.close()
  })

  test('expiry CAS lets exactly one of extend/claim win', () => {
    const { store } = newStore()
    store.ensureHost('host-a', 'http://a')
    store.insertInstance(instance({ expiresAtMs: 5000 }))
    expect(store.updateExpiry('a'.repeat(24), ['running'], 9000, 6000)).toBe(
      false
    )
    expect(store.updateExpiry('a'.repeat(24), ['running'], 9000, 4000)).toBe(
      true
    )
    expect(store.claimExpired('a'.repeat(24), 5000)).toBe(false)
    expect(store.claimExpired('a'.repeat(24), 9000)).toBe(true)
    expect(store.getInstance('a'.repeat(24))?.state).toBe('deleting')
    expect(store.updateExpiry('a'.repeat(24), ['running'], 12000, 9001)).toBe(
      false
    )
    store.close()
  })

  test('an expired creating row is claimable and extend still wins first', () => {
    const { store } = newStore()
    store.ensureHost('host-a', 'http://a')
    store.insertInstance(
      instance({
        id: 'b'.repeat(24),
        state: 'creating',
        expiresAtMs: 5000,
      })
    )
    expect(store.listExpiredClaimable(4000).map(row => row.id)).toEqual([])
    expect(store.listExpiredClaimable(5000).map(row => row.id)).toEqual([
      'b'.repeat(24),
    ])
    // An extend just before the deadline moves it, so the claim loses.
    expect(store.updateExpiry('b'.repeat(24), ['creating'], 9000, 4999)).toBe(
      true
    )
    expect(store.claimExpired('b'.repeat(24), 5000)).toBe(false)
    expect(store.getInstance('b'.repeat(24))?.state).toBe('creating')
    // At the new deadline the claim succeeds.
    expect(store.claimExpired('b'.repeat(24), 9000)).toBe(true)
    expect(store.getInstance('b'.repeat(24))?.state).toBe('deleting')
    // A deleting row is no longer claimable and keeps its reservation.
    expect(store.claimExpired('b'.repeat(24), 20_000)).toBe(false)
    expect(store.reservedForHost('host-a').instances).toBe(1)
    store.close()
  })

  test('writeOffHost frees the key and releases the reservation', () => {
    const { store } = newStore()
    store.ensureHost('host-a', 'http://a')
    store.insertInstance(instance())
    const ids = store.writeOffHost('host-a', 2000)
    expect(ids).toEqual(['a'.repeat(24)])
    expect(store.getInstance('a'.repeat(24))?.state).toBe('lost')
    expect(store.reservedForHost('host-a').instances).toBe(0)
    expect(store.getLiveInstance(instance())).toBe(null)
    store.insertInstance(instance({ id: 'b'.repeat(24), teamId: 'team-2' }))
    store.close()
  })

  test('state and drain flags survive reopening the database', () => {
    const { store, path, dir } = newStore()
    store.ensureHost('host-a', 'http://a')
    store.setDraining('host-a', true)
    store.insertInstance(instance())
    store.close()

    const reopened = new Store(path, () => 5000)
    expect(reopened.getHost('host-a')?.draining).toBe(true)
    expect(reopened.getInstance('a'.repeat(24))?.state).toBe('running')
    reopened.close()

    const db = new Database(path, { readonly: true })
    const migrations = db.query('SELECT version FROM schema_migrations').all()
    db.close()
    expect(migrations).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }])
    void dir
  })

  test('rejects a state update from a stale writer', () => {
    const { store } = newStore()
    store.ensureHost('host-a', 'http://a')
    store.insertInstance(instance())
    expect(store.casState('a'.repeat(24), ['creating'], 'running', 2000)).toBe(
      false
    )
    expect(store.casState('a'.repeat(24), ['running'], 'deleting', 2000)).toBe(
      true
    )
    // ProtocolError is what the service maps races to; importing it keeps the
    // error-code contract visible here.
    expect(new ProtocolError('conflict', 'x').code).toBe('conflict')
    store.close()
  })

  test('a same-millisecond update cannot be overwritten by a stale snapshot', () => {
    const { store } = newStore() // fixed clock at 1000 for every write
    store.ensureHost('host-a', 'http://a')
    store.insertInstance(instance())
    const snapshot = store.getInstance('a'.repeat(24))!
    expect(snapshot.revision).toBe(0)

    // First write at the same `updated_at_ms` as the snapshot.
    expect(store.casState('a'.repeat(24), ['running'], 'running', 1000)).toBe(
      true
    )
    const updated = store.getInstance('a'.repeat(24))!
    expect(updated.updatedAtMs).toBe(snapshot.updatedAtMs)
    expect(updated.revision).toBeGreaterThan(snapshot.revision)

    // A decision made from the old snapshot is now stale, even though the
    // timestamps are equal.
    expect(store.casStateSnapshot(snapshot, 'deleting', 1000)).toBe(false)
    expect(store.getInstance('a'.repeat(24))?.state).toBe('running')
    store.close()
  })

  test('every store operation after close throws StoreClosedError', () => {
    const { store } = newStore()
    store.ensureHost('host-a', 'http://a')
    store.insertInstance(instance())
    store.close()
    const key = { teamId: 'team-1', challengeIntegrationId: 'chal-1' }
    const operations: Array<() => unknown> = [
      () => store.getHost('host-a'),
      () => store.getInstance('a'.repeat(24)),
      () => store.listInstances(),
      () => store.getLiveInstance(key),
      () => store.reservedByHost(),
      () => store.casState('a'.repeat(24), ['running'], 'deleting', 1000),
      () => store.updateExpiry('a'.repeat(24), ['running'], 5000, 1000),
      () => store.transaction(() => undefined),
    ]
    for (const operation of operations) {
      expect(operation).toThrow(StoreClosedError)
    }
  })
})
