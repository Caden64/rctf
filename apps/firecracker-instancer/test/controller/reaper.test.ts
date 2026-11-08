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

  test('the reaper only claims expired running rows', async () => {
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
})
