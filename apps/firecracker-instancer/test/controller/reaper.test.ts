import { afterEach, describe, expect, test } from 'bun:test'
import { ProtocolError } from '@rctf/firecracker-protocol'
import { createControllerService } from '../../src/controller/service'
import {
  cleanupDir,
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

const setup = () => {
  const dir = testDir()
  dirs.push(dir)
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
    makeConfig(dir, [makeHost('host-a')]),
    {
      clients: { 'host-a': agent },
      now: clock.now,
      logger: logs.asLogger(),
      timers,
      newId: () => 'i' + 'a'.repeat(23),
    }
  )
  return { dir, clock, timers, logs, agent, service }
}

const extendRequest = (timeoutMilliseconds = 5000) => ({
  teamId: 'team-1',
  challengeIntegrationId: 'chal-1',
  timeoutMilliseconds,
})

describe('reaper vs extend', () => {
  test('extend just before expiry wins; the reaper leaves the row alone', async () => {
    for (let iteration = 0; iteration < 10; iteration++) {
      const { service, agent, clock, timers } = setup()
      await service.start()
      try {
        agent.latencyMs = iteration % 3
        await service.create(
          makeCreateRequest('team-1', { timeoutMilliseconds: 1000 })
        )
        const id = [...agent.instances.keys()][0]!

        // One millisecond before the deadline.
        clock.t += 999
        const extendPromise = service.extend(extendRequest())
        if (iteration % 2 === 0) await Promise.resolve()
        const reaperPromise = timers.trigger(1)
        const [extendResult] = await Promise.allSettled([
          extendPromise,
          reaperPromise,
        ])
        await reaperPromise

        expect(extendResult.status).toBe('fulfilled')
        expect(agent.deleteCalls).not.toContain(id)
        expect(
          (
            await service.get({
              teamId: 'team-1',
              challengeIntegrationId: 'chal-1',
            })
          ).status
        ).toBe('running')
        expect(agent.extendCalls.some(call => call.id === id)).toBe(true)
      } finally {
        await service.stop()
      }
    }
  })

  test('the reaper claims at expiry; a concurrent extend cannot resurrect it', async () => {
    for (let iteration = 0; iteration < 10; iteration++) {
      const { service, agent, clock, timers } = setup()
      await service.start()
      try {
        agent.latencyMs = iteration % 3
        await service.create(
          makeCreateRequest('team-1', { timeoutMilliseconds: 1000 })
        )
        const id = [...agent.instances.keys()][0]!

        clock.t += 1000
        const reaperPromise = timers.trigger(1)
        if (iteration % 2 === 0) await Promise.resolve()
        const extendPromise = service.extend(extendRequest())
        const [extendResult] = await Promise.allSettled([extendPromise])
        const reapResult = await reaperPromise.catch(error => error)

        expect(reapResult === undefined || reapResult instanceof Error).toBe(
          true
        )
        expect(extendResult.status).toBe('rejected')
        const code = (extendResult as PromiseRejectedResult).reason
        expect(code).toBeInstanceOf(ProtocolError)
        expect(['expired', 'not_found']).toContain((code as ProtocolError).code)
        expect(agent.deleteCalls).toContain(id)
        const unavailable = await service.get({
          teamId: 'team-1',
          challengeIntegrationId: 'chal-1',
        })
        expect(unavailable.status).toBe('stopped')
      } finally {
        await service.stop()
      }
    }
  })

  test('the reaper treats a missing instance as confirmed teardown (tombstone written)', async () => {
    const { service, agent, clock, timers } = setup()
    await service.start()
    try {
      await service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 1000 })
      )
      const id = [...agent.instances.keys()][0]!
      // The VM vanished and the agent answers 404 for DELETE, after writing
      // its durable fence.
      agent.forceDrop(id)
      agent.deleteMissingMode = 'not_found'

      clock.t += 1000
      await timers.trigger(1)
      expect(agent.deleteCalls).toContain(id)
      // A 404 is confirmation exactly because the agent wrote the tombstone.
      expect(agent.isTombstoned(id)).toBe(true)
      const details = await service.get({
        teamId: 'team-1',
        challengeIntegrationId: 'chal-1',
      })
      expect(details.status).toBe('stopped')
    } finally {
      await service.stop()
    }
  })

  test('an ambiguous DELETE 404 keeps the row fenced until real confirmation', async () => {
    const { service, agent, clock, timers } = setup()
    await service.start()
    try {
      await service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 1000 })
      )
      const id = [...agent.instances.keys()][0]!
      agent.forceDrop(id)
      // A route/proxy 404: no instance-scoped body, no tombstone.
      agent.deleteMissingMode = 'ambiguous'

      clock.t += 1000
      await timers.trigger(1)
      expect(agent.deleteCalls).toContain(id)
      expect(agent.isTombstoned(id)).toBe(false)
      expect(
        (
          await service.get({
            teamId: 'team-1',
            challengeIntegrationId: 'chal-1',
          })
        ).status
      ).toBe('stopping')
      expect((await service.listHosts())[0]!.reserved.instances).toBe(1)

      // The reconciler retries the DELETE; confirmation releases the row.
      agent.deleteMissingMode = 'ok'
      await timers.trigger(2)
      expect(agent.isTombstoned(id)).toBe(true)
      expect(
        (
          await service.get({
            teamId: 'team-1',
            challengeIntegrationId: 'chal-1',
          })
        ).status
      ).toBe('stopped')
      expect((await service.listHosts())[0]!.reserved.instances).toBe(0)
    } finally {
      await service.stop()
    }
  })

  test('a DELETE answering 410/expired never frees the reaped row', async () => {
    const { service, agent, clock, timers } = setup()
    await service.start()
    try {
      await service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 1000 })
      )
      const id = [...agent.instances.keys()][0]!
      // 410/expired: the agent writes its tombstone but does NOT confirm the
      // teardown (only HTTP 2xx, or an instance-scoped absence 404 from an
      // agent advertising instance-absence-v1, confirms).
      agent.deleteErrorMode = 'expired'

      clock.t += 1000
      await timers.trigger(1)
      expect(agent.deleteCalls).toContain(id)
      expect(agent.isTombstoned(id)).toBe(false)
      expect(
        (
          await service.get({
            teamId: 'team-1',
            challengeIntegrationId: 'chal-1',
          })
        ).status
      ).toBe('stopping')
      expect((await service.listHosts())[0]!.reserved.instances).toBe(1)
      // The VM is still there too: nothing was torn down on this answer.
      expect(agent.instances.has(id)).toBe(true)

      // Once the agent confirms (the reconciler retries deleting rows), the
      // row and reservation are released.
      agent.deleteErrorMode = 'none'
      await timers.trigger(2)
      expect(
        (
          await service.get({
            teamId: 'team-1',
            challengeIntegrationId: 'chal-1',
          })
        ).status
      ).toBe('stopped')
      expect((await service.listHosts())[0]!.reserved.instances).toBe(0)
      expect(agent.isTombstoned(id)).toBe(true)
    } finally {
      await service.stop()
    }
  })

  test('the reaper claims expired live rows but never before the deadline', async () => {
    const { service, agent, clock, timers } = setup()
    await service.start()
    try {
      await service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 10_000 })
      )
      clock.t += 5000
      await timers.trigger(1)
      expect(agent.instances.size).toBe(1)
      expect(agent.deleteCalls).toHaveLength(0)

      clock.t += 6000
      await timers.trigger(1)
      expect(agent.deleteCalls).toHaveLength(1)
      expect(agent.instances.size).toBe(0)
    } finally {
      await service.stop()
    }
  })

  test('an expired creating row is fenced through DELETE and kept until confirmed', async () => {
    const { service, agent, clock, timers } = setup()
    await service.start()
    try {
      // The create outlives its deadline while it is still booting.
      agent.createState = 'starting'
      await service.create(
        makeCreateRequest('team-1', { timeoutMilliseconds: 1000 })
      )
      const id = [...agent.instances.keys()][0]!
      expect(
        (
          await service.get({
            teamId: 'team-1',
            challengeIntegrationId: 'chal-1',
          })
        ).status
      ).toBe('starting')

      agent.deleteUnreachable = true
      clock.t += 1000
      await timers.trigger(1)
      // Reservation and fence survive an unconfirmed teardown.
      expect((await service.listHosts())[0]!.reserved.instances).toBe(1)
      expect(
        (
          await service.get({
            teamId: 'team-1',
            challengeIntegrationId: 'chal-1',
          })
        ).status
      ).toBe('stopping')
      expect(agent.isTombstoned(id)).toBe(false)

      agent.deleteUnreachable = false
      await timers.trigger(2)
      expect(agent.isTombstoned(id)).toBe(true)
      expect((await service.listHosts())[0]!.reserved.instances).toBe(0)
      expect(agent.instances.has(id)).toBe(false)
    } finally {
      await service.stop()
    }
  })
})
