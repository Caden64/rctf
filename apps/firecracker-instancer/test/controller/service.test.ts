import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { ProtocolError } from '@rctf/firecracker-protocol'
import type { ControllerService } from '../../src/interfaces'
import { createControllerService } from '../../src/controller/service'
import type { ControllerConfig } from '../../src/controller/config'
import {
  cleanupDir,
  databasePath,
  FakeClock,
  FakeTimers,
  HOST_CAPACITY,
  makeConfig,
  makeCreateRequest,
  makeHost,
  MemoryLogs,
  testDir,
} from './helpers'
import { FakeAgent, type AgentCapacity } from './fake-agent'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) cleanupDir(dirs.pop()!)
})

interface Harness {
  dir: string
  path: string
  clock: FakeClock
  timers: FakeTimers
  logs: MemoryLogs
  agents: Record<string, FakeAgent>
  service: ControllerService
  start: () => Promise<void>
}

const harness = (opts: {
  agents: Record<string, FakeAgent>
  config?: Partial<ControllerConfig>
  hosts?: ReturnType<typeof makeHost>[]
  clock?: FakeClock
  timers?: FakeTimers
  path?: string
  dir?: string
  /**
   * Deterministic monotonic RTT source. Defaults to a counter that advances by
   * 1ms per call, so each probe measures a 1ms RTT (slack 1ms).
   */
  rttNow?: () => number
  newId?: () => string
}): Harness => {
  const dir = opts.dir ?? testDir()
  if (opts.dir === undefined) dirs.push(dir)
  const path = opts.path ?? databasePath(dir)
  const clock = opts.clock ?? new FakeClock()
  const timers = opts.timers ?? new FakeTimers()
  const logs = new MemoryLogs()
  const hosts =
    opts.hosts ??
    Object.keys(opts.agents).map(id =>
      makeHost(id, { capacity: HOST_CAPACITY })
    )
  const config = makeConfig(dir, hosts, {
    databasePath: path,
    ...opts.config,
  })
  for (const agent of Object.values(opts.agents)) agent.setClock(clock.now)
  let sequence = 0
  let monotonic = 0
  const rttNow = opts.rttNow ?? (() => ++monotonic)
  const service = createControllerService(config, {
    clients: opts.agents,
    now: clock.now,
    logger: logs.asLogger(),
    newId:
      opts.newId ?? (() => `i${(sequence++).toString(36).padStart(23, '0')}`),
    timers,
    rttNow,
  })
  return {
    dir,
    path,
    clock,
    timers,
    logs,
    agents: opts.agents,
    service,
    start: () => service.start(),
  }
}

const countRows = (path: string): number => {
  const db = new Database(path, { readonly: true })
  const row = db.query('SELECT COUNT(*) AS c FROM instances').get() as {
    c: number
  }
  db.close()
  return row.c
}

const rowState = (path: string, teamId: string): string | null => {
  const db = new Database(path, { readonly: true })
  const row = db
    .query(
      'SELECT state FROM instances WHERE team_id = ? ORDER BY created_at_ms DESC LIMIT 1'
    )
    .get(teamId) as { state: string } | null
  db.close()
  return row?.state ?? null
}

const rowExpiry = (path: string, teamId: string): number | null => {
  const db = new Database(path, { readonly: true })
  const row = db
    .query(
      'SELECT expires_at_ms FROM instances WHERE team_id = ? ORDER BY created_at_ms DESC LIMIT 1'
    )
    .get(teamId) as { expires_at_ms: number } | null
  db.close()
  return row?.expires_at_ms ?? null
}

const rowSynced = (path: string, teamId: string): number | null => {
  const db = new Database(path, { readonly: true })
  const row = db
    .query(
      'SELECT agent_expiry_synced FROM instances WHERE team_id = ? ORDER BY created_at_ms DESC LIMIT 1'
    )
    .get(teamId) as { agent_expiry_synced: number } | null
  db.close()
  return row?.agent_expiry_synced ?? null
}

const hostSkew = (path: string, hostId: string): number => {
  const db = new Database(path, { readonly: true })
  const row = db
    .query('SELECT clock_skew_ms FROM hosts WHERE id = ?')
    .get(hostId) as { clock_skew_ms: number } | null
  db.close()
  return row?.clock_skew_ms ?? 0
}

const hostClock = (
  path: string,
  hostId: string
): { skew: number; rtt: number | null; state: string } => {
  const db = new Database(path, { readonly: true })
  const row = db
    .query(
      'SELECT clock_skew_ms, clock_rtt_ms, clock_state FROM hosts WHERE id = ?'
    )
    .get(hostId) as {
    clock_skew_ms: number
    clock_rtt_ms: number | null
    clock_state: string
  } | null
  db.close()
  return {
    skew: row?.clock_skew_ms ?? 0,
    rtt: row?.clock_rtt_ms ?? null,
    state: row?.clock_state ?? 'unknown',
  }
}

const capacity = (instances: number, memMiB = 4096): AgentCapacity => ({
  vcpus: 64,
  memMiB,
  diskMiB: 65536,
  maxInstances: instances,
})

const errorCode = (error: unknown): string | undefined =>
  error instanceof ProtocolError ? error.code : undefined

describe('controller service', () => {
  test('concurrent identical creates make one row and one agent create', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    try {
      const request = makeCreateRequest('team-1')
      const results = await Promise.all(
        Array.from({ length: 10 }, () => h.service.create(request))
      )
      expect(results).toHaveLength(10)
      expect(agents['host-a']!.createCount()).toBe(1)
      expect(countRows(h.path)).toBe(1)

      const details = await h.service.get({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
      })
      expect(details.status).toBe('running')
      expect(details.endpoints).toEqual([
        { kind: 'http', host: 'host-a.fc.test', port: 20000, title: 'Web' },
      ])
      expect(details.timeLeftMilliseconds).toBe(60_000)

      const hosts = await h.service.listHosts()
      expect(hosts[0]!.reserved).toEqual({
        vcpus: 1,
        memMiB: 256,
        diskMiB: 128,
        instances: 1,
      })
    } finally {
      await h.service.stop()
    }
  })

  test('200 concurrent creates against capacity 20 admit exactly 20', async () => {
    const perHost = capacity(10)
    const agents = {
      'host-a': new FakeAgent('host-a', perHost),
      'host-b': new FakeAgent('host-b', perHost),
    }
    const h = harness({
      agents,
      hosts: [
        makeHost('host-a', { capacity: perHost }),
        makeHost('host-b', { capacity: perHost }),
      ],
    })
    await h.start()
    try {
      const requests = Array.from({ length: 200 }, (_, index) =>
        h.service.create(makeCreateRequest(`team-${index}`))
      )
      const results = await Promise.allSettled(requests)
      const fulfilled = results.filter(result => result.status === 'fulfilled')
      const rejected = results.filter(result => result.status === 'rejected')
      expect(fulfilled).toHaveLength(20)
      expect(rejected).toHaveLength(180)
      for (const result of rejected) {
        expect(errorCode((result as PromiseRejectedResult).reason)).toBe(
          'no_capacity'
        )
      }

      const hosts = await h.service.listHosts()
      for (const host of hosts) {
        expect(host.reserved.instances).toBeLessThanOrEqual(10)
        expect(host.reserved.memMiB).toBeLessThanOrEqual(perHost.memMiB)
        expect(host.reserved.vcpus).toBeLessThanOrEqual(perHost.vcpus)
      }
      expect(
        hosts.reduce((sum, host) => sum + host.reserved.instances, 0)
      ).toBe(20)
      expect(countRows(h.path)).toBe(20)
      expect(
        agents['host-a']!.instances.size + agents['host-b']!.instances.size
      ).toBe(20)
    } finally {
      await h.service.stop()
    }
  })

  test('a definitive rejection fails over and releases the first reservation', async () => {
    const agents = {
      'host-a': new FakeAgent('host-a', HOST_CAPACITY),
      'host-b': new FakeAgent('host-b', HOST_CAPACITY),
    }
    agents['host-a']!.createMode = 'reject'
    agents['host-a']!.rejectCode = 'no_capacity'
    const h = harness({ agents })
    await h.start()
    try {
      const details = await h.service.create(makeCreateRequest('team-1'))
      expect(details.status).toBe('running')
      expect(agents['host-a']!.createCount()).toBe(1)
      expect(agents['host-b']!.createCount()).toBe(1)
      expect(agents['host-a']!.instances.size).toBe(0)
      expect(agents['host-b']!.instances.size).toBe(1)

      const hosts = await h.service.listHosts()
      expect(hosts.find(host => host.id === 'host-a')?.reserved.instances).toBe(
        0
      )
      expect(hosts.find(host => host.id === 'host-b')?.reserved.instances).toBe(
        1
      )
      expect(rowState(h.path, 'team-1')).toBe('running')
    } finally {
      await h.service.stop()
    }
  })

  test('all hosts exhausted is a no_capacity ProtocolError', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    agents['host-a']!.createMode = 'reject'
    agents['host-a']!.rejectCode = 'draining'
    const h = harness({ agents })
    await h.start()
    try {
      const error = await h.service
        .create(makeCreateRequest('team-1'))
        .catch(error => error)
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe('no_capacity')
      expect(countRows(h.path)).toBe(0)
    } finally {
      await h.service.stop()
    }
  })

  test('ambiguous timeout with a VM keeps row/reservation and adopt on reconcile', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    try {
      agents['host-a']!.createMode = 'create-then-unreachable'
      const details = await h.service.create(makeCreateRequest('team-1'))
      expect(details.status).toBe('starting')
      expect(rowState(h.path, 'team-1')).toBe('creating')
      expect((await h.service.listHosts())[0]!.reserved.instances).toBe(1)
      expect(agents['host-a']!.instances.size).toBe(1)

      agents['host-a']!.createMode = 'ok'
      await h.timers.trigger(2)
      expect(rowState(h.path, 'team-1')).toBe('running')
      const resolved = await h.service.get({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
      })
      expect(resolved.status).toBe('running')
      expect((await h.service.listHosts())[0]!.reserved.instances).toBe(1)
    } finally {
      await h.service.stop()
    }
  })

  test('ambiguous timeout with no VM is fenced and freed only after the agent confirms', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents, config: { createFenceSeconds: 5 } })
    await h.start()
    try {
      agents['host-a']!.createMode = 'unreachable'
      const details = await h.service.create(makeCreateRequest('team-1'))
      expect(details.status).toBe('starting')
      expect(rowState(h.path, 'team-1')).toBe('creating')
      expect((await h.service.listHosts())[0]!.reserved.instances).toBe(1)

      agents['host-a']!.createMode = 'ok'
      agents['host-a']!.deleteUnreachable = true
      h.clock.t += 6000
      await h.timers.trigger(2)
      expect(rowState(h.path, 'team-1')).toBe('deleting')
      expect((await h.service.listHosts())[0]!.reserved.instances).toBe(1)

      agents['host-a']!.deleteUnreachable = false
      await h.timers.trigger(2)
      expect(countRows(h.path)).toBe(0)
      expect((await h.service.listHosts())[0]!.reserved.instances).toBe(0)
      expect(
        await h.service.get({
          teamId: 'team-1',
          challengeIntegrationId: 'chal-1',
        })
      ).toEqual({
        kind: 'instancerInstanceDetails',
        status: 'stopped',
        timeLeftMilliseconds: 0,
        endpoints: null,
      })
    } finally {
      await h.service.stop()
    }
  })

  test('deleting keeps the reservation until the agent confirms', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    try {
      await h.service.create(makeCreateRequest('team-1'))
      const key = { teamId: 'team-1', challengeIntegrationId: 'chal-1' }
      const id = [...agents['host-a']!.instances.keys()][0]!

      agents['host-a']!.deleteUnreachable = true
      const stopping = await h.service.delete(key)
      expect(stopping.status).toBe('stopping')
      expect(rowState(h.path, 'team-1')).toBe('deleting')
      expect((await h.service.listHosts())[0]!.reserved.instances).toBe(1)
      expect(agents['host-a']!.instances.has(id)).toBe(true)

      agents['host-a']!.deleteUnreachable = false
      const stopped = await h.service.delete(key)
      expect(stopped.status).toBe('stopped')
      expect(rowState(h.path, 'team-1')).toBe(null)
      expect((await h.service.listHosts())[0]!.reserved.instances).toBe(0)
      expect(agents['host-a']!.deleteCalls).toContain(id)

      // Idempotent after removal.
      expect((await h.service.delete(key)).status).toBe('stopped')
    } finally {
      await h.service.stop()
    }
  })

  test('an ambiguous DELETE 404 keeps the row fenced and the reservation held', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    try {
      await h.service.create(makeCreateRequest('team-1'))
      const id = [...agents['host-a']!.instances.keys()][0]!
      agents['host-a']!.forceDrop(id)
      agents['host-a']!.deleteMissingMode = 'ambiguous'

      const key = { teamId: 'team-1', challengeIntegrationId: 'chal-1' }
      const stopping = await h.service.delete(key)
      expect(stopping.status).toBe('stopping')
      expect(rowState(h.path, 'team-1')).toBe('deleting')
      expect((await h.service.listHosts())[0]!.reserved.instances).toBe(1)
      expect(agents['host-a']!.isTombstoned(id)).toBe(false)

      // A real instance-absence response confirms and releases the row.
      agents['host-a']!.deleteMissingMode = 'ok'
      expect((await h.service.delete(key)).status).toBe('stopped')
      expect(rowState(h.path, 'team-1')).toBe(null)
      expect(agents['host-a']!.isTombstoned(id)).toBe(true)
    } finally {
      await h.service.stop()
    }
  })

  test('extend after expiry fails with expired, and never creates a row', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    try {
      expect(
        errorCode(
          await h.service
            .extend({
              teamId: 'team-1',
              challengeIntegrationId: 'chal-1',
              timeoutMilliseconds: 5000,
            })
            .catch(error => error)
        )
      ).toBe('not_found')
      expect(countRows(h.path)).toBe(0)

      await h.service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 1000 })
      )
      h.clock.advance(1000)
      const error = await h.service
        .extend({
          teamId: 'team-1',
          challengeIntegrationId: 'chal-1',
          timeoutMilliseconds: 5000,
        })
        .catch(error => error)
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe('expired')
      expect(countRows(h.path)).toBe(1)
    } finally {
      await h.service.stop()
    }
  })

  test('restart resumes creating, deleting and adopts running instances', async () => {
    const dir = testDir()
    dirs.push(dir)
    const clock = new FakeClock()
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }

    const first = harness({
      agents,
      dir,
      clock,
      config: { createFenceSeconds: 5 },
    })
    await first.service.start()
    agents['host-a']!.createMode = 'create-then-unreachable'
    await first.service.create(makeCreateRequest('team-1'))
    agents['host-a']!.createMode = 'ok'
    await first.service.create(makeCreateRequest('team-2'))
    agents['host-a']!.deleteUnreachable = true
    await first.service.delete({
      teamId: 'team-2',
      challengeIntegrationId: 'chal-1',
    })
    agents['host-a']!.createMode = 'unreachable'
    await first.service.create(makeCreateRequest('team-3'))
    expect(rowState(first.path, 'team-1')).toBe('creating')
    expect(rowState(first.path, 'team-2')).toBe('deleting')
    expect(rowState(first.path, 'team-3')).toBe('creating')
    await first.service.stop()

    const timers = new FakeTimers()
    const second = harness({
      agents,
      dir,
      clock,
      timers,
      path: first.path,
      config: { createFenceSeconds: 5 },
    })
    agents['host-a']!.createMode = 'ok'
    await second.service.start()
    try {
      expect(rowState(second.path, 'team-1')).toBe('running')
      // Inside the fence after the restart: the ambiguous create is kept.
      expect(rowState(second.path, 'team-3')).toBe('creating')
      expect(rowState(second.path, 'team-2')).toBe('deleting')

      agents['host-a']!.deleteUnreachable = false
      await timers.trigger(0) // heartbeat
      clock.t += 6000
      await timers.trigger(2) // reconciler: retries delete and fences team-3
      expect(rowState(second.path, 'team-2')).toBe(null)
      expect(rowState(second.path, 'team-3')).toBe(null)

      const resolved = await second.service.get({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
      })
      expect(resolved.status).toBe('running')
    } finally {
      await second.service.stop()
    }
  })

  test('host loss writes off, frees the team to recreate elsewhere, and cleans up on return', async () => {
    const perHost = capacity(10)
    const clock = new FakeClock()
    const timers = new FakeTimers()
    const agents = {
      'host-a': new FakeAgent('host-a', perHost, clock.now),
      'host-b': new FakeAgent('host-b', perHost, clock.now),
    }
    const h = harness({
      agents,
      clock,
      timers,
      hosts: [
        makeHost('host-a', { capacity: perHost }),
        makeHost('host-b', { capacity: perHost }),
      ],
    })
    await h.start()
    try {
      const key = { teamId: 'team-1', challengeIntegrationId: 'chal-1' }
      await h.service.create(makeCreateRequest('team-1'))
      expect(agents['host-a']!.instances.size).toBe(1)

      agents['host-a']!.unreachable = true
      clock.advance(21_000)
      await timers.flush()
      expect(
        (await h.service.listHosts()).find(host => host.id === 'host-a')?.health
      ).toBe('unhealthy')

      // Existing instance reads as errored while the host is unreachable, but
      // the row (and reservation) is still there.
      const duringOutage = await h.service.get(key)
      expect(duringOutage.status).toBe('errored')
      expect(rowState(h.path, 'team-1')).toBe('running')

      clock.advance((300 - 21) * 1000 + 1000)
      await timers.flush()
      expect(rowState(h.path, 'team-1')).toBe('lost')
      expect((await h.service.listHosts())[0]!.reserved.instances).toBe(0)
      expect((await h.service.get(key)).status).toBe('stopped')

      // The unique key is free: the same team can create on the other host.
      const recreated = await h.service.create(makeCreateRequest('team-1'))
      expect(recreated.status).toBe('running')
      expect(agents['host-b']!.instances.size).toBe(1)
      expect(rowState(h.path, 'team-1')).toBe('running')

      // Host returns: the reconciler deletes the old agent-side instance.
      agents['host-a']!.unreachable = false
      clock.t += 31_000
      await timers.flush()
      expect(agents['host-a']!.instances.size).toBe(0)
      expect(
        (await h.service.listHosts()).find(host => host.id === 'host-a')?.health
      ).toBe('healthy')
      const orphanRows = countRows(h.path)
      expect(orphanRows).toBe(1)
    } finally {
      await h.service.stop()
    }
  })

  test('drain blocks placement but not extend/delete of existing instances', async () => {
    const perHost = capacity(10)
    const agents = {
      'host-a': new FakeAgent('host-a', perHost),
      'host-b': new FakeAgent('host-b', perHost),
    }
    const h = harness({
      agents,
      hosts: [
        makeHost('host-a', { capacity: perHost }),
        makeHost('host-b', { capacity: perHost }),
      ],
    })
    await h.start()
    try {
      const key = { teamId: 'team-1', challengeIntegrationId: 'chal-1' }
      await h.service.create(makeCreateRequest('team-1'))
      const drained = await h.service.drainHost('host-a')
      expect(drained.health).toBe('draining')

      const other = await h.service.create(makeCreateRequest('team-2'))
      expect(other.status).toBe('running')
      expect(agents['host-b']!.instances.size).toBe(1)
      expect(agents['host-a']!.instances.size).toBe(1)

      await h.service.extend({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
        timeoutMilliseconds: 10_000,
      })
      expect(agents['host-a']!.extendCalls).toHaveLength(1)

      expect((await h.service.delete(key)).status).toBe('stopped')
      expect(agents['host-a']!.instances.size).toBe(0)

      await h.service.drainHost('host-b')
      const error = await h.service
        .create(makeCreateRequest('team-3'))
        .catch(error => error)
      expect(errorCode(error)).toBe('no_capacity')
      expect((error as ProtocolError).message).toContain('draining')

      const undrained = await h.service.undrainHost('host-a')
      expect(undrained.health).toBe('healthy')
    } finally {
      await h.service.stop()
    }
  })

  test('validates the challenge config and expose mapping', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    try {
      const badConfig = makeCreateRequest('team-1', {
        config: { image: '../escape' },
      })
      expect(
        errorCode(await h.service.create(badConfig).catch(error => error))
      ).toBe('invalid_request')

      const badContainer = makeCreateRequest('team-1', {
        expose: [makeCreateRequest('x').expose[0]!].map(entry => ({
          ...entry,
          containerName: 'web',
        })),
      })
      expect(
        errorCode(await h.service.create(badContainer).catch(error => error))
      ).toBe('invalid_request')

      const noExpose = makeCreateRequest('team-1', { expose: [] })
      expect(
        errorCode(await h.service.create(noExpose).catch(error => error))
      ).toBe('invalid_request')

      const duplicatePort = makeCreateRequest('team-1', {
        expose: [
          makeCreateRequest('x').expose[0]!,
          makeCreateRequest('x').expose[0]!,
        ],
      })
      expect(
        errorCode(await h.service.create(duplicatePort).catch(error => error))
      ).toBe('invalid_request')
      expect(countRows(h.path)).toBe(0)
    } finally {
      await h.service.stop()
    }
  })

  test('drain/undrain persist across restarts', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    try {
      await h.service.drainHost('host-a')
      await h.service.stop()

      const reopened = harness({
        agents,
        dir: h.dir,
        path: h.path,
      })
      expect((await reopened.service.listHosts())[0]!.health).toBe('draining')
      // A restarted controller has no clock sample yet: probe before placing.
      await reopened.service.start()
      await reopened.service.undrainHost('host-a')
      await reopened.service.create(makeCreateRequest('team-1'))
      expect((await reopened.service.listHosts())[0]!.reserved.instances).toBe(
        1
      )
      await reopened.service.stop()
    } finally {
      // stopped above
    }
  })

  test('removeHost rejects a healthy host and keeps the draining host removed', async () => {
    const perHost = capacity(10)
    const clock = new FakeClock()
    const timers = new FakeTimers()
    const agents = {
      'host-a': new FakeAgent('host-a', perHost, clock.now),
      'host-b': new FakeAgent('host-b', perHost, clock.now),
    }
    const h = harness({
      agents,
      clock,
      timers,
      hosts: [
        makeHost('host-a', { capacity: perHost }),
        makeHost('host-b', { capacity: perHost }),
      ],
      config: { hostTimeoutSeconds: 20, hostLostSeconds: 300 },
    })
    await h.start()
    try {
      await h.service.create(makeCreateRequest('team-1'))
      expect(agents['host-a']!.instances.size).toBe(1)
      const oldId = [...agents['host-a']!.instances.keys()][0]!

      // Healthy hosts cannot be removed.
      const error = await h.service.removeHost('host-a').catch(error => error)
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe('conflict')
      expect(rowState(h.path, 'team-1')).toBe('running')

      // Make it unhealthy, then remove it: rows become lost tombstones and the
      // host stays draining.
      agents['host-a']!.unreachable = true
      clock.t += 21_000
      await timers.trigger(0)
      expect(
        (await h.service.listHosts()).find(host => host.id === 'host-a')?.health
      ).toBe('unhealthy')
      await h.service.removeHost('host-a')
      expect(rowState(h.path, 'team-1')).toBe('lost')
      expect(
        (await h.service.listHosts()).find(host => host.id === 'host-a')?.health
      ).toBe('draining')

      // A heartbeat must not clear draining or resurrect the host.
      agents['host-a']!.unreachable = false
      await timers.trigger(0)
      expect(
        (await h.service.listHosts()).find(host => host.id === 'host-a')
      ).toMatchObject({ health: 'draining', reserved: { instances: 0 } })

      // Recreating the key never places on the removed host.
      const recreated = await h.service.create(makeCreateRequest('team-1'))
      expect(recreated.status).toBe('running')
      expect(agents['host-a']!.createCount()).toBe(1)
      expect(agents['host-a']!.instances.has(oldId)).toBe(true)
      expect(agents['host-b']!.instances.size).toBe(1)
      expect(rowState(h.path, 'team-1')).toBe('running')
    } finally {
      await h.service.stop()
    }
  })

  test('config seeding after removeHost does not resurrect the host', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    await h.service.create(makeCreateRequest('team-1'))
    const id = [...agents['host-a']!.instances.keys()][0]!

    agents['host-a']!.unreachable = true
    h.clock.t += 21_000
    await h.timers.trigger(0)
    await h.service.removeHost('host-a')
    await h.service.stop()

    const reopened = harness({ agents, dir: h.dir, path: h.path })
    try {
      expect((await reopened.service.listHosts())[0]!.health).toBe('draining')
      const error = await reopened.service
        .create(makeCreateRequest('team-1'))
        .catch(error => error)
      expect(errorCode(error)).toBe('no_capacity')
      expect((error as ProtocolError).message).toContain('draining')
      // The old VM was never replaced on the removed host.
      expect(agents['host-a']!.instances.has(id)).toBe(true)
      expect(agents['host-a']!.createCount()).toBe(1)
    } finally {
      await reopened.service.stop()
    }
  })

  test('a well-formed 500 after the VM was created never fails over', async () => {
    const agents = {
      'host-a': new FakeAgent('host-a', HOST_CAPACITY),
      'host-b': new FakeAgent('host-b', HOST_CAPACITY),
    }
    const h = harness({
      agents,
      hosts: [makeHost('host-a'), makeHost('host-b')],
    })
    await h.start()
    try {
      agents['host-a']!.createMode = 'create-then-internal-error'
      const details = await h.service.create(makeCreateRequest('team-1'))
      expect(details.status).toBe('starting')
      expect(rowState(h.path, 'team-1')).toBe('creating')
      expect(agents['host-a']!.instances.size).toBe(1)
      // The old code treated the parsable 500/internal body as definitive and
      // failed over, producing a second VM on host-b.
      expect(agents['host-b']!.createCount()).toBe(0)

      agents['host-a']!.createMode = 'ok'
      await h.timers.trigger(2)
      expect(rowState(h.path, 'team-1')).toBe('running')
      expect(agents['host-a']!.instances.size).toBe(1)
      expect(agents['host-b']!.instances.size).toBe(0)
    } finally {
      await h.service.stop()
    }
  })

  test('a concurrent GET promotion before PUT completion keeps the healthy VM', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    try {
      const hold = agents['host-a']!.holdNextCreate()
      const createPromise = h.service.create(makeCreateRequest('team-1'))
      const created = await hold.created
      expect(rowState(h.path, 'team-1')).toBe('creating')

      // The player's GET observes the running VM and promotes the row.
      const during = await h.service.get({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
      })
      expect(during.status).toBe('running')

      hold.release()
      const result = await createPromise
      expect(result.status).toBe('running')
      expect(agents['host-a']!.instances.has(created.id)).toBe(true)
      expect(agents['host-a']!.deleteCalls).not.toContain(created.id)
      expect(rowState(h.path, 'team-1')).toBe('running')
    } finally {
      await h.service.stop()
    }
  })

  test('clamps create and extend at the maxLifetime boundary', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents, config: { maxLifetimeSeconds: 60 } })
    await h.start()
    try {
      const created = h.clock.t
      await h.service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 60_000 })
      )
      expect(rowExpiry(h.path, 'team-1')).toBe(created + 60_000)

      await h.service.create(
        makeCreateRequest('team-2', { timeoutMilliseconds: 61_000 })
      )
      expect(rowExpiry(h.path, 'team-2')).toBe(created + 60_000)

      // Exactly at the boundary is allowed.
      h.clock.t = created + 1000
      await h.service.extend({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
        timeoutMilliseconds: 59_000,
      })
      expect(rowExpiry(h.path, 'team-1')).toBe(created + 60_000)

      // Requests past the cap are clamped, not rejected.
      await h.service.extend({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
        timeoutMilliseconds: 120_000,
      })
      expect(rowExpiry(h.path, 'team-1')).toBe(created + 60_000)

      // At the exact cap there is no life left to extend.
      h.clock.t = created + 60_000
      const error = await h.service
        .extend({
          teamId: 'team-1',
          challengeIntegrationId: 'chal-1',
          timeoutMilliseconds: 5000,
        })
        .catch(error => error)
      expect(errorCode(error)).toBe('expired')
    } finally {
      await h.service.stop()
    }
  })

  test('a maxLifetime cap lowered across a restart is grandfathered', async () => {
    const dir = testDir()
    dirs.push(dir)
    const clock = new FakeClock()
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const first = harness({
      agents,
      dir,
      clock,
      config: { maxLifetimeSeconds: 600 },
    })
    await first.service.start()
    await first.service.create(
      makeCreateRequest('team-1', { timeoutMilliseconds: 600_000 })
    )
    const created = clock.t
    const oldDeadline = rowExpiry(first.path, 'team-1')!
    expect(oldDeadline).toBe(created + 600_000)
    await first.service.stop()

    // Restart with a much lower cap.
    const second = harness({
      agents,
      dir,
      clock,
      path: first.path,
      config: { maxLifetimeSeconds: 60 },
      newId: () => 'j' + 'a'.repeat(23),
    })
    await second.service.start()
    try {
      clock.t = created + 1000
      // An extend never shortens the grandfathered deadline...
      await second.service.extend({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
        timeoutMilliseconds: 120_000,
      })
      expect(rowExpiry(second.path, 'team-1')).toBe(oldDeadline)

      // ...while a new create gets the new, lower cap.
      await second.service.create(
        makeCreateRequest('team-2', { timeoutMilliseconds: 120_000 })
      )
      expect(rowExpiry(second.path, 'team-2')).toBe(clock.t + 60_000)
    } finally {
      await second.service.stop()
    }
  })

  test('competing out-of-order extends never shorten the deadline', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    try {
      await h.service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 10_000 })
      )
      const id = [...agents['host-a']!.instances.keys()][0]!
      h.clock.t += 1000
      const longDeadline = h.clock.t + 30_000

      // The long extend's PATCH is applied by the agent first, but its network
      // completion is held. A shorter extend started later completes first:
      // the responses are genuinely reordered.
      const hold = agents['host-a']!.holdNextExtend()
      const longPending = h.service.extend({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
        timeoutMilliseconds: 30_000,
      })
      await hold.captured
      expect(rowExpiry(h.path, 'team-1')).toBe(longDeadline)

      let shortCompleted = false
      const shortPending = h.service
        .extend({
          teamId: 'team-1',
          challengeIntegrationId: 'chal-1',
          timeoutMilliseconds: 5000,
        })
        .then(result => {
          shortCompleted = true
          return result
        })
      const shortResult = await shortPending
      expect(shortCompleted).toBe(true)
      expect(shortResult.status).toBe('running')

      hold.release()
      const longResult = await longPending
      expect(longResult.status).toBe('running')

      expect(rowExpiry(h.path, 'team-1')).toBe(longDeadline)
      // +1ms is the conservative RTT/2 slack of the 1ms sample.
      expect(agents['host-a']!.instances.get(id)!.expiresAtMs).toBe(
        longDeadline + 1
      )
    } finally {
      await h.service.stop()
    }
  })

  test('a short-deadline agent reply fails the extend but keeps the committed deadline', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    try {
      await h.service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 10_000 })
      )
      h.clock.t += 1000
      agents['host-a']!.extendAckDeadline = applied => applied - 5000
      const error = await h.service
        .extend({
          teamId: 'team-1',
          challengeIntegrationId: 'chal-1',
          timeoutMilliseconds: 20_000,
        })
        .catch(error => error)
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe('host_unavailable')

      // The desired deadline is authoritative and never rolled back.
      expect(rowExpiry(h.path, 'team-1')).toBe(h.clock.t + 20_000)
      expect(rowSynced(h.path, 'team-1')).toBe(0)

      agents['host-a']!.extendAckDeadline = null
      await h.timers.trigger(2)
      expect(rowSynced(h.path, 'team-1')).toBe(1)
    } finally {
      await h.service.stop()
    }
  })

  test('an extend with no agent client for the row host fails host_unavailable', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    try {
      await h.service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 10_000 })
      )
      h.clock.t += 1000
      // The controller's client map is this same object: a host dropped from
      // the configuration (e.g. a restart without it) disappears from it
      // while the durable row is still there.
      delete agents['host-a']
      const error = await h.service
        .extend({
          teamId: 'team-1',
          challengeIntegrationId: 'chal-1',
          timeoutMilliseconds: 20_000,
        })
        .catch(error => error)
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe('host_unavailable')
      // The committed desired deadline stays authoritative and unsynced;
      // recovery is the reconciler's job.
      expect(rowExpiry(h.path, 'team-1')).toBe(h.clock.t + 20_000)
      expect(rowSynced(h.path, 'team-1')).toBe(0)
    } finally {
      await h.service.stop()
    }
  })

  test('a paused extend response reports a concurrent delete, not success', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    try {
      await h.service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 10_000 })
      )
      h.clock.t += 1000
      const hold = agents['host-a']!.holdNextExtend()
      const pending = h.service.extend({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
        timeoutMilliseconds: 20_000,
      })
      await hold.captured
      // The player deletes while the PATCH response is still on the wire.
      expect(
        (
          await h.service.delete({
            teamId: 'team-1',
            challengeIntegrationId: 'chal-1',
          })
        ).status
      ).toBe('stopped')
      hold.release()

      const result = await pending
      expect(result.status).toBe('stopped')
      expect(countRows(h.path)).toBe(0)
    } finally {
      await h.service.stop()
    }
  })

  test('stop waits for an in-flight loop tick before closing the database', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents })
    await h.start()
    try {
      const before = agents['host-a']!.infoCalls.length
      agents['host-a']!.latencyMs = 80
      const heartbeat = h.timers.trigger(0)
      await Bun.sleep(5)
      // stop() must await the slow heartbeat; the old code closed SQLite first
      // and the tick then failed against the closed database.
      await h.service.stop()
      expect(agents['host-a']!.infoCalls.length).toBe(before + 1)
      await heartbeat
      expect(h.logs.lines.join('\n')).not.toContain(
        'controller loop tick failed'
      )
    } finally {
      // stopped above
    }
  })

  test('stop halts every loop first and bounds held ticks by one deadline', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents, config: { shutdownTimeoutSeconds: 0.05 } })
    await h.start()
    try {
      let release!: () => void
      agents['host-a']!.infoHold = new Promise<void>(resolve => {
        release = resolve
      })
      const heartbeat = h.timers.trigger(0)
      await Bun.sleep(2)
      expect(h.timers.size).toBe(3)

      const started = Date.now()
      const stopping = h.service.stop()
      // Every loop is unscheduled synchronously, before any tick is awaited.
      await Promise.resolve()
      expect(h.timers.size).toBe(0)
      await stopping
      expect(Date.now() - started).toBeLessThan(1000)
      expect(h.logs.lines.join('\n')).toContain(
        'controller shutdown deadline exceeded'
      )

      // The held tick resumes after SQLite is closed; its late writes are
      // harmless and must not surface as a loop failure.
      agents['host-a']!.infoHold = null
      release()
      await heartbeat
      expect(h.logs.lines.join('\n')).not.toContain(
        'controller loop tick failed'
      )
    } finally {
      // stopped above
    }
  })

  for (const offset of [5000, -5000]) {
    test(`translates deadlines by a ${offset}ms clock offset in both directions`, async () => {
      const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
      agents['host-a']!.clockOffsetMs = offset
      const h = harness({ agents })
      await h.start()
      try {
        expect(hostSkew(h.path, 'host-a')).toBe(offset)
        const row = await h.service.create(
          makeCreateRequest('team-1', { timeoutMilliseconds: 10_000 })
        )
        expect(row.status).toBe('running')
        const id = [...agents['host-a']!.instances.keys()][0]!
        const deadline = rowExpiry(h.path, 'team-1')!
        // +1ms is the conservative RTT/2 slack of the deterministic 1ms sample.
        expect(agents['host-a']!.createCalls[0]!.expiresAtMs).toBe(
          deadline + offset + 1
        )
        expect(agents['host-a']!.instances.get(id)!.expiresAtMs).toBe(
          deadline + offset + 1
        )

        h.clock.t += 1000
        await h.service.extend({
          teamId: 'team-1',
          challengeIntegrationId: 'chal-1',
          timeoutMilliseconds: 20_000,
        })
        const extended = rowExpiry(h.path, 'team-1')!
        expect(extended).toBe(h.clock.t + 20_000)
        expect(agents['host-a']!.instances.get(id)!.expiresAtMs).toBe(
          extended + offset + 1
        )
      } finally {
        await h.service.stop()
      }
    })
  }

  test('a host beyond maxClockSkewSeconds stays healthy but takes no placements', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    agents['host-a']!.clockOffsetMs = 20_000
    const h = harness({ agents, config: { maxClockSkewSeconds: 10 } })
    await h.start()
    try {
      expect((await h.service.listHosts())[0]!.health).toBe('healthy')
      const error = await h.service
        .create(makeCreateRequest('team-1'))
        .catch(error => error)
      expect(errorCode(error)).toBe('no_capacity')
      expect((error as ProtocolError).message).toContain('clock skew')
      expect(agents['host-a']!.createCount()).toBe(0)
    } finally {
      await h.service.stop()
    }
  })

  test('an initial /info failure refuses placement until a probe succeeds', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    agents['host-a']!.infoMode = 'unreachable'
    const h = harness({ agents })
    await h.start()
    try {
      expect((await h.service.listHosts())[0]!.health).toBe('healthy')
      const error = await h.service
        .create(makeCreateRequest('team-1'))
        .catch(error => error)
      expect(errorCode(error)).toBe('no_capacity')
      expect((error as ProtocolError).message).toContain('clock sample')
      expect(agents['host-a']!.createCount()).toBe(0)
      expect(hostClock(h.path, 'host-a').state).toBe('unknown')

      agents['host-a']!.infoMode = 'ok'
      await h.timers.trigger(0)
      expect(hostClock(h.path, 'host-a').state).toBe('valid')
      expect((await h.service.create(makeCreateRequest('team-1'))).status).toBe(
        'running'
      )
    } finally {
      await h.service.stop()
    }
  })

  test('fails over to a host that has a usable clock sample', async () => {
    const agents = {
      'host-a': new FakeAgent('host-a', HOST_CAPACITY),
      'host-b': new FakeAgent('host-b', HOST_CAPACITY),
    }
    agents['host-a']!.infoMode = 'unreachable'
    const h = harness({ agents })
    await h.start()
    try {
      const details = await h.service.create(makeCreateRequest('team-1'))
      expect(details.status).toBe('running')
      expect(agents['host-a']!.createCount()).toBe(0)
      expect(agents['host-b']!.createCount()).toBe(1)
    } finally {
      await h.service.stop()
    }
  })

  test('rejects an asymmetric slow clock sample instead of trusting a bogus skew', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    agents['host-a']!.latencyMs = 40
    const h = harness({
      agents,
      config: { clockMaxRttSeconds: 0.01 },
      rttNow: () => performance.now(),
    })
    await h.start()
    try {
      // Synchronized clocks, but the response spent 40ms on the wire: the
      // measured skew must not be (or ever be used as) -20ms.
      const clock = hostClock(h.path, 'host-a')
      expect(clock.state).not.toBe('valid')
      const error = await h.service
        .create(makeCreateRequest('team-1'))
        .catch(error => error)
      expect(errorCode(error)).toBe('no_capacity')
      expect((error as ProtocolError).message).toContain('clock sample')
      expect(agents['host-a']!.createCount()).toBe(0)

      agents['host-a']!.latencyMs = 0
      await h.timers.trigger(0)
      expect(hostClock(h.path, 'host-a').state).toBe('valid')
      expect(hostClock(h.path, 'host-a').skew).toBe(0)
      expect((await h.service.create(makeCreateRequest('team-1'))).status).toBe(
        'running'
      )
    } finally {
      await h.service.stop()
    }
  })

  test('a controller clock step rejects the sample and keeps the old estimate', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    agents['host-a']!.clockOffsetMs = 5000
    const h = harness({ agents })
    await h.start()
    try {
      expect(hostClock(h.path, 'host-a')).toMatchObject({
        state: 'valid',
        skew: 5000,
      })
      await h.service.create(makeCreateRequest('team-1'))

      // The controller wall clock jumps backwards while the probe runs.
      agents['host-a']!.infoHook = () => {
        h.clock.t -= 1000
      }
      await h.timers.trigger(0)
      expect(hostClock(h.path, 'host-a')).toMatchObject({
        state: 'stale',
        skew: 5000,
      })
      // No NEW placements while the sample is not trustworthy...
      const error = await h.service
        .create(makeCreateRequest('team-2'))
        .catch(error => error)
      expect(errorCode(error)).toBe('no_capacity')
      // ...but existing instances keep working.
      expect(
        (
          await h.service.extend({
            teamId: 'team-1',
            challengeIntegrationId: 'chal-1',
            timeoutMilliseconds: 10_000,
          })
        ).status
      ).toBe('running')

      agents['host-a']!.infoHook = null
      await h.timers.trigger(0)
      expect(hostClock(h.path, 'host-a').state).toBe('valid')
      expect((await h.service.create(makeCreateRequest('team-2'))).status).toBe(
        'running'
      )
    } finally {
      await h.service.stop()
    }
  })

  test('an RTT above clockMaxRttSeconds is rejected and keeps the previous estimate', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    agents['host-a']!.clockOffsetMs = 5000
    const rtt = {
      value: 0,
      step: 1,
      now(): number {
        const value = this.value
        this.value += this.step
        return value
      },
    }
    const h = harness({
      agents,
      config: { clockMaxRttSeconds: 2 },
      rttNow: () => rtt.now(),
    })
    await h.start()
    try {
      expect(hostClock(h.path, 'host-a')).toMatchObject({
        state: 'valid',
        skew: 5000,
        rtt: 1,
      })
      await h.service.create(makeCreateRequest('team-1'))

      rtt.step = 9000
      await h.timers.trigger(0)
      // The bad sample is discarded; the last good one is kept but stale.
      expect(hostClock(h.path, 'host-a')).toMatchObject({
        state: 'stale',
        skew: 5000,
        rtt: 1,
      })
      expect(
        errorCode(
          await h.service
            .create(makeCreateRequest('team-2'))
            .catch(error => error)
        )
      ).toBe('no_capacity')

      rtt.step = 1
      await h.timers.trigger(0)
      expect(hostClock(h.path, 'host-a').state).toBe('valid')
      expect((await h.service.create(makeCreateRequest('team-2'))).status).toBe(
        'running'
      )
    } finally {
      await h.service.stop()
    }
  })

  test('a stale clock sample blocks new placements but keeps existing instances', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    const h = harness({ agents, config: { clockSampleMaxAgeSeconds: 0.005 } })
    await h.start()
    try {
      await h.service.create(makeCreateRequest('team-1'))
      h.clock.t += 10
      const error = await h.service
        .create(makeCreateRequest('team-2'))
        .catch(error => error)
      expect(errorCode(error)).toBe('no_capacity')
      expect((error as ProtocolError).message).toContain('clock sample')
      expect(
        (
          await h.service.extend({
            teamId: 'team-1',
            challengeIntegrationId: 'chal-1',
            timeoutMilliseconds: 10_000,
          })
        ).status
      ).toBe('running')
    } finally {
      await h.service.stop()
    }
  })
})
