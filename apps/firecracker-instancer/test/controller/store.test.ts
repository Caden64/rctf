import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { ProtocolError } from '@rctf/firecracker-protocol'
import { Store, type InstanceRecord } from '../../src/controller/store'
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

  test('reservations count reserving/creating/running/deleting only', () => {
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
    expect(store.claimExpiredRunning('a'.repeat(24), 5000)).toBe(false)
    expect(store.claimExpiredRunning('a'.repeat(24), 9000)).toBe(true)
    expect(store.getInstance('a'.repeat(24))?.state).toBe('deleting')
    expect(store.updateExpiry('a'.repeat(24), ['running'], 12000, 9001)).toBe(
      false
    )
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
    expect(migrations).toEqual([{ version: 1 }])
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
})
