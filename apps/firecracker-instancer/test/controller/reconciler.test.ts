import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
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

const setup = (opts: { orphanGraceSeconds?: number } = {}) => {
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

describe('reconciler', () => {
  test('adopts an agent-running creating row and cleans an absent one', async () => {
    const { service, agent, path } = setup()
    agent.createMode = 'create-then-unreachable'
    await service.create(makeCreateRequest('team-1'))
    agent.createMode = 'unreachable'
    await service.create(makeCreateRequest('team-2'))
    expect(instanceRow(path, 'team-1')?.state).toBe('creating')
    expect(instanceRow(path, 'team-2')?.state).toBe('creating')

    agent.createMode = 'ok'
    await service.start()
    try {
      expect(instanceRow(path, 'team-1')?.state).toBe('running')
      expect(instanceRow(path, 'team-2')).toBe(null)
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
      expect(
        (
          await service.get({
            teamId: 'team-1',
            challengeIntegrationId: 'chal-1',
          })
        ).status
      ).toBe('errored')
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
})
