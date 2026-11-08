import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { AgentRejectedError } from '../../src/interfaces'
import { createControllerService } from '../../src/controller/service'
import {
  cleanupDir,
  databasePath,
  FakeClock,
  FakeTimers,
  makeConfig,
  makeCreateRequest,
  makeHost,
  MemoryLogs,
  testDir,
} from './helpers'
import { FakeAgent } from './fake-agent'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) cleanupDir(dirs.pop()!)
})

const setup = (
  opts: { orphanGraceSeconds?: number; createFenceSeconds?: number } = {}
) => {
  const dir = testDir()
  dirs.push(dir)
  const path = databasePath(dir)
  const clock = new FakeClock()
  const timers = new FakeTimers()
  const logs = new MemoryLogs()
  const agent = new FakeAgent('host-a', {
    vcpus: 64,
    memMiB: 65536,
    diskMiB: 65536,
    maxInstances: 100,
  })
  agent.setClock(clock.now)
  const service = createControllerService(
    makeConfig(dir, [makeHost('host-a')], opts),
    {
      clients: { 'host-a': agent },
      now: clock.now,
      logger: logs.asLogger(),
      timers,
      newId: (() => {
        let sequence = 0
        return () => `i${(sequence++).toString(36).padStart(23, '0')}`
      })(),
    }
  )
  return { dir, path, clock, timers, logs, agent, service }
}

const instanceRow = (
  path: string,
  teamId: string
): { state: string; agent_expiry_synced: number } | null => {
  const db = new Database(path, { readonly: true })
  const row = db
    .query('SELECT state, agent_expiry_synced FROM instances WHERE team_id = ?')
    .get(teamId) as { state: string; agent_expiry_synced: number } | null
  db.close()
  return row
}

const rowCount = (path: string, teamId: string): number => {
  const db = new Database(path, { readonly: true })
  const row = db
    .query('SELECT COUNT(*) AS n FROM instances WHERE team_id = ?')
    .get(teamId) as { n: number }
  db.close()
  return row.n
}

const key = { teamId: 'team-1', challengeIntegrationId: 'chal-1' }

describe('reconciler', () => {
  test('a stale listing never frees a running VM (confirmed with get)', async () => {
    const { service, agent, timers, path } = setup()
    await service.start()
    try {
      await service.create(makeCreateRequest('team-1'))
      expect(instanceRow(path, 'team-1')?.state).toBe('running')
      const id = [...agent.instances.keys()][0]!

      // The listing was captured before a create completed: it is missing the
      // id even though the VM is running on the agent.
      agent.listSnapshotOverride = []
      await timers.trigger(2)

      expect(instanceRow(path, 'team-1')?.state).toBe('running')
      expect((await service.listHosts())[0]!.reserved.instances).toBe(1)
      expect(agent.instances.has(id)).toBe(true)
      expect(agent.deleteCalls).not.toContain(id)
    } finally {
      await service.stop()
    }
  })

  test('adopts an agent-running creating row and fences an absent one', async () => {
    const { service, agent, clock, timers, path } = setup({
      createFenceSeconds: 5,
    })
    // Sampling the host clock requires the first heartbeat; start the loops
    // (they are only driven manually through FakeTimers).
    await service.start()
    try {
      agent.createMode = 'create-then-unreachable'
      await service.create(makeCreateRequest('team-1'))
      agent.createMode = 'unreachable'
      await service.create(makeCreateRequest('team-2'))
      expect(instanceRow(path, 'team-1')?.state).toBe('creating')
      expect(instanceRow(path, 'team-2')?.state).toBe('creating')

      agent.createMode = 'ok'
      // Inside the fence: the ambiguous row is left alone.
      clock.t += 1000
      await timers.trigger(2)
      expect(instanceRow(path, 'team-1')?.state).toBe('running')
      expect(instanceRow(path, 'team-2')?.state).toBe('creating')

      // Past the fence: row -> deleting, DELETE confirms, only then removed.
      clock.t += 5000
      await timers.trigger(2)
      expect(instanceRow(path, 'team-2')).toBe(null)
    } finally {
      await service.stop()
    }
  })

  test('a delayed PUT executing after the fence is rejected by the tombstone', async () => {
    const { service, agent, clock, timers, path } = setup({
      createFenceSeconds: 5,
    })
    await service.start()
    try {
      const gate = agent.deferNextCreate()
      const details = await service.create(makeCreateRequest('team-1'))
      expect(details.status).toBe('starting')
      const spec = await gate.captured
      expect(agent.instances.size).toBe(0)
      expect(instanceRow(path, 'team-1')?.state).toBe('creating')

      // Before the fence the create is still assumed in flight.
      clock.t += 1000
      await timers.trigger(2)
      expect(instanceRow(path, 'team-1')?.state).toBe('creating')

      // After the fence the controller sends DELETE (tombstone) and removes
      // the row only because the agent confirmed.
      clock.t += 5000
      await timers.trigger(2)
      expect(agent.isTombstoned(spec.id)).toBe(true)
      expect(instanceRow(path, 'team-1')).toBe(null)

      // The late PUT can no longer create the VM.
      const late = await gate.execute().catch(error => error)
      expect(late).toBeInstanceOf(AgentRejectedError)
      expect((late as AgentRejectedError).code).toBe('conflict')
      expect(agent.instances.size).toBe(0)

      // A same-key retry gets a fresh id and never produces a second VM.
      const retried = await service.create(makeCreateRequest('team-1'))
      expect(retried.status).toBe('running')
      expect(agent.instances.size).toBe(1)
      expect(agent.instances.has(spec.id)).toBe(false)
    } finally {
      await service.stop()
    }
  })

  test('a DELETE answering expired does not free the fence; no delayed PUT survives a retry', async () => {
    const { service, agent, clock, timers, path } = setup({
      createFenceSeconds: 5,
    })
    await service.start()
    try {
      const gate = agent.deferNextCreate()
      await service.create(makeCreateRequest('team-1'))
      const spec = await gate.captured
      expect(instanceRow(path, 'team-1')?.state).toBe('creating')

      // The agent knows the id only after this DELETE: it writes the tombstone
      // but answers 410/expired, which is NOT teardown confirmation.
      agent.deleteMissingMode = 'expired'
      clock.t += 6000
      await timers.trigger(2)
      expect(instanceRow(path, 'team-1')?.state).toBe('deleting')
      expect((await service.listHosts())[0]!.reserved.instances).toBe(1)
      expect(agent.isTombstoned(spec.id)).toBe(true)

      // Ownership is still held: a same-key create cannot start a second VM.
      const whileFenced = await service.create(makeCreateRequest('team-1'))
      expect(whileFenced.status).toBe('stopping')
      expect(agent.createCount()).toBe(1)

      // The delayed PUT is rejected by the tombstone even while the row is
      // still fenced, so it can never coexist with a retry.
      const late = await gate.execute().catch(error => error)
      expect(late).toBeInstanceOf(AgentRejectedError)
      expect((late as AgentRejectedError).code).toBe('conflict')
      expect(agent.instances.size).toBe(0)

      // Confirmation finally releases the row, and a same-key retry gets a
      // fresh id with exactly one VM.
      agent.deleteMissingMode = 'ok'
      await timers.trigger(2)
      expect(instanceRow(path, 'team-1')).toBe(null)
      const retried = await service.create(makeCreateRequest('team-1'))
      expect(retried.status).toBe('running')
      expect(agent.instances.size).toBe(1)
      expect(agent.instances.has(spec.id)).toBe(false)
    } finally {
      await service.stop()
    }
  })

  test('a fenced create stays deleting until the agent confirms', async () => {
    const { service, agent, clock, timers, path } = setup({
      createFenceSeconds: 5,
    })
    await service.start()
    try {
      agent.createMode = 'unreachable'
      await service.create(makeCreateRequest('team-1'))
      agent.createMode = 'ok'
      clock.t += 6000
      agent.deleteUnreachable = true
      await timers.trigger(2)
      expect(instanceRow(path, 'team-1')?.state).toBe('deleting')
      expect((await service.listHosts())[0]!.reserved.instances).toBe(1)

      agent.deleteUnreachable = false
      await timers.trigger(2)
      expect(instanceRow(path, 'team-1')).toBe(null)
      expect((await service.listHosts())[0]!.reserved.instances).toBe(0)
    } finally {
      await service.stop()
    }
  })

  test('a running row missing on the agent becomes errored and frees capacity', async () => {
    const { service, agent, timers, path } = setup()
    await service.start()
    try {
      await service.create(makeCreateRequest('team-1'))
      const id = [...agent.instances.keys()][0]!
      agent.forceDrop(id)
      await timers.trigger(2)

      expect(instanceRow(path, 'team-1')?.state).toBe('errored')
      expect((await service.listHosts())[0]!.reserved.instances).toBe(0)
      expect((await service.get(key)).status).toBe('errored')
    } finally {
      await service.stop()
    }
  })

  test('re-pushes an expiry that failed to reach the agent', async () => {
    const { service, agent, clock, timers, path } = setup()
    await service.start()
    try {
      await service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 10_000 })
      )
      clock.t += 1000
      agent.unreachable = true
      const extended = await service.extend({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
        timeoutMilliseconds: 20_000,
      })
      expect(extended.status).toBe('running')
      expect(instanceRow(path, 'team-1')?.agent_expiry_synced).toBe(0)

      agent.unreachable = false
      const pushes = agent.extendCalls.length
      await timers.trigger(2)
      expect(agent.extendCalls.length).toBe(pushes + 1)
      expect(instanceRow(path, 'team-1')?.agent_expiry_synced).toBe(1)
    } finally {
      await service.stop()
    }
  })

  test('retries an unsynced deadline while the row is still starting', async () => {
    const { service, agent, clock, timers, path } = setup()
    await service.start()
    try {
      agent.createState = 'starting'
      await service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 10_000 })
      )
      expect(instanceRow(path, 'team-1')?.state).toBe('creating')
      clock.t += 1000
      agent.unreachable = true
      await service.extend({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
        timeoutMilliseconds: 20_000,
      })
      expect(instanceRow(path, 'team-1')?.agent_expiry_synced).toBe(0)

      agent.unreachable = false
      const pushes = agent.extendCalls.length
      await timers.trigger(2)
      expect(agent.extendCalls.length).toBe(pushes + 1)
      expect(instanceRow(path, 'team-1')?.agent_expiry_synced).toBe(1)
    } finally {
      await service.stop()
    }
  })

  test('deletes agent-only orphans after the grace period but keeps fresh ones', async () => {
    const { service, agent, clock } = setup({ orphanGraceSeconds: 5 })
    const oldId = 'o'.repeat(24)
    const freshId = 'f'.repeat(24)
    const base = {
      state: 'running' as const,
      expiresAtMs: clock.t + 60_000,
      endpoints: [],
      specHash: 'x',
    }
    agent.forceInstance({
      ...base,
      id: oldId,
      createdAtMs: clock.t - 6000,
    })
    agent.forceInstance({
      ...base,
      id: freshId,
      createdAtMs: clock.t - 1000,
    })
    await service.start()
    try {
      expect(agent.instances.has(oldId)).toBe(false)
      expect(agent.instances.has(freshId)).toBe(true)
    } finally {
      await service.stop()
    }
  })

  test('translates agent timestamps before applying the orphan grace', async () => {
    const { service, agent, clock } = setup({ orphanGraceSeconds: 5 })
    agent.clockOffsetMs = 60_000
    // 6 seconds old on the agent's clock, which is 60s ahead: the naive
    // comparison (`controllerNow - agentCreatedAt`) would look 54s in the
    // future and keep it forever.
    agent.forceInstance({
      id: 'z'.repeat(24),
      state: 'running',
      createdAtMs: clock.t + 60_000 - 6000,
      expiresAtMs: clock.t + 120_000,
      endpoints: [],
      specHash: 'x',
    })
    await service.start()
    try {
      expect(agent.instances.has('z'.repeat(24))).toBe(false)
    } finally {
      await service.stop()
    }
  })

  test('garbage-collects a superseded errored row and its agent record', async () => {
    const { service, agent, timers, path } = setup()
    await service.start()
    try {
      agent.createState = 'errored'
      await service.create(makeCreateRequest('team-1'))
      expect(instanceRow(path, 'team-1')?.state).toBe('errored')
      const oldId = [...agent.instances.keys()][0]!
      expect(agent.instances.has(oldId)).toBe(true)

      agent.createState = 'running'
      const recreated = await service.create(makeCreateRequest('team-1'))
      expect(recreated.status).toBe('running')
      await timers.trigger(2)

      expect(rowCount(path, 'team-1')).toBe(1)
      expect(agent.instances.has(oldId)).toBe(false)
      expect(agent.instances.size).toBe(1)
    } finally {
      await service.stop()
    }
  })

  test('a reconciler sweep cleans an errored row whose reserve-time GC failed', async () => {
    const { service, agent, timers, path } = setup()
    await service.start()
    try {
      agent.createState = 'errored'
      await service.create(makeCreateRequest('team-1'))
      const oldId = [...agent.instances.keys()][0]!

      // Make the GC at reserve time impossible, then recreate.
      agent.deleteUnreachable = true
      agent.createState = 'running'
      await service.create(makeCreateRequest('team-1'))
      expect(rowCount(path, 'team-1')).toBe(2)

      agent.deleteUnreachable = false
      await timers.trigger(2)
      expect(rowCount(path, 'team-1')).toBe(1)
      expect(agent.instances.has(oldId)).toBe(false)
    } finally {
      await service.stop()
    }
  })

  test('errored-row GC keeps the row when DELETE answers expired', async () => {
    const { service, agent, timers, path } = setup()
    await service.start()
    try {
      agent.createState = 'errored'
      await service.create(makeCreateRequest('team-1'))
      const oldId = [...agent.instances.keys()][0]!
      expect(instanceRow(path, 'team-1')?.state).toBe('errored')

      agent.createState = 'running'
      agent.deleteErrorMode = 'expired'
      await service.create(makeCreateRequest('team-1'))
      // The unconfirmed GC did not remove the old tombstone row.
      expect(rowCount(path, 'team-1')).toBe(2)
      expect(agent.instances.has(oldId)).toBe(true)

      agent.deleteErrorMode = 'none'
      await timers.trigger(2)
      expect(rowCount(path, 'team-1')).toBe(1)
      expect(agent.instances.has(oldId)).toBe(false)
    } finally {
      await service.stop()
    }
  })

  test('written-off rows are deleted on the agent when the host returns', async () => {
    const { service, agent, clock, timers, path } = setup()
    await service.start()
    try {
      await service.create(makeCreateRequest('team-1'))
      const id = [...agent.instances.keys()][0]!
      agent.unreachable = true
      clock.t += 400_000
      await timers.flush()
      expect(instanceRow(path, 'team-1')?.state).toBe('lost')

      agent.unreachable = false
      clock.t += 60_000
      await timers.flush()
      expect(agent.instances.has(id)).toBe(false)
      expect(instanceRow(path, 'team-1')).toBe(null)
    } finally {
      await service.stop()
    }
  })

  test('restart in the middle of a lost-host cleanup resumes on return', async () => {
    const dir = testDir()
    dirs.push(dir)
    const clock = new FakeClock()
    const agent = new FakeAgent('host-a', {
      vcpus: 64,
      memMiB: 65536,
      diskMiB: 65536,
      maxInstances: 100,
    })
    agent.setClock(clock.now)
    const config = makeConfig(dir, [makeHost('host-a')])
    const timers1 = new FakeTimers()
    const first = createControllerService(config, {
      clients: { 'host-a': agent },
      now: clock.now,
      logger: new MemoryLogs().asLogger(),
      timers: timers1,
      newId: () => 'i' + 'a'.repeat(23),
    })
    await first.start()
    await first.create(makeCreateRequest('team-1'))
    const id = [...agent.instances.keys()][0]!
    agent.unreachable = true
    clock.t += 400_000
    await timers1.flush()
    expect(instanceRow(databasePath(dir), 'team-1')?.state).toBe('lost')
    await first.stop()
    // Recreate a service on the same DB to run the heartbeat/reconcile.
    const timers = new FakeTimers()
    const second = createControllerService(config, {
      clients: { 'host-a': agent },
      now: clock.now,
      logger: new MemoryLogs().asLogger(),
      timers,
      newId: () => 'i' + 'b'.repeat(23),
    })
    await second.start()
    try {
      // Still unreachable: the lost tombstone survives the restart.
      expect(agent.instances.has(id)).toBe(true)
      agent.unreachable = false
      clock.t += 60_000
      await timers.flush()
      expect(agent.instances.has(id)).toBe(false)
      expect(instanceRow(databasePath(dir), 'team-1')).toBe(null)
    } finally {
      await second.stop()
    }
  })
})
