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
  let sequence = 0
  const service = createControllerService(config, {
    clients: opts.agents,
    now: clock.now,
    logger: logs.asLogger(),
    newId: () => `i${(sequence++).toString(36).padStart(23, '0')}`,
    timers,
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
    agents['host-a']!.createMode = 'create-then-unreachable'
    const h = harness({ agents })
    try {
      const details = await h.service.create(makeCreateRequest('team-1'))
      expect(details.status).toBe('starting')
      expect(rowState(h.path, 'team-1')).toBe('creating')
      expect((await h.service.listHosts())[0]!.reserved.instances).toBe(1)
      expect(agents['host-a']!.instances.size).toBe(1)

      agents['host-a']!.createMode = 'ok'
      await h.start()
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

  test('ambiguous timeout with no VM cleans the row on reconcile', async () => {
    const agents = { 'host-a': new FakeAgent('host-a', HOST_CAPACITY) }
    agents['host-a']!.createMode = 'unreachable'
    const h = harness({ agents })
    try {
      const details = await h.service.create(makeCreateRequest('team-1'))
      expect(details.status).toBe('starting')
      expect(rowState(h.path, 'team-1')).toBe('creating')
      expect((await h.service.listHosts())[0]!.reserved.instances).toBe(1)

      agents['host-a']!.createMode = 'ok'
      await h.start()
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

    const first = harness({ agents, dir, clock })
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
    })
    agents['host-a']!.createMode = 'ok'
    await second.service.start()
    try {
      expect(rowState(second.path, 'team-1')).toBe('running')
      expect(rowState(second.path, 'team-3')).toBe(null)
      expect(rowState(second.path, 'team-2')).toBe('deleting')

      agents['host-a']!.deleteUnreachable = false
      await timers.trigger(2) // reconciler interval
      expect(rowState(second.path, 'team-2')).toBe(null)

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

      const unhealthyAt = clock.t
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
      void unhealthyAt
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

  test('drain/undrain persist and removeHost forgets reservations', async () => {
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
      await reopened.service.undrainHost('host-a')
      await reopened.service.create(makeCreateRequest('team-1'))
      expect((await reopened.service.listHosts())[0]!.reserved.instances).toBe(
        1
      )

      await reopened.service.removeHost('host-a')
      expect(countRows(reopened.path)).toBe(0)
      expect((await reopened.service.listHosts())[0]!.reserved.instances).toBe(
        0
      )
      await reopened.service.stop()
    } finally {
      // stopped above
    }
  })
})
