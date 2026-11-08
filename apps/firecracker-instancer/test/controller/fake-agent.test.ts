/**
 * Faithfulness checks for the in-test fake agent. These are contract
 * properties the controller relies on (FENCING, clock timestamps, durability),
 * so a regression in the fake must fail loudly rather than silently weaken
 * the controller tests.
 */
import { describe, expect, test } from 'bun:test'
import { AgentRejectedError } from '../../src/interfaces'
import { FakeAgent } from './fake-agent'
import { FakeClock, HOST_CAPACITY, makeAgentSpec } from './helpers'

const setup = () => {
  const clock = new FakeClock()
  const agent = new FakeAgent('host-a', HOST_CAPACITY, clock.now)
  return { clock, agent }
}

describe('FakeAgent contract', () => {
  test('DELETE of an unknown id fences before answering; the fence is durable', async () => {
    const { agent } = setup()
    const id = 'a'.repeat(24)
    agent.deleteMissingMode = 'expired'
    const error = await agent.delete(id).catch(error => error)
    expect(error).toBeInstanceOf(AgentRejectedError)
    expect((error as AgentRejectedError).code).toBe('expired')
    // The tombstone was written BEFORE the error.
    expect(agent.isTombstoned(id)).toBe(true)

    // Durable across a restart, and a late PUT can never create the VM.
    agent.simulateRestart()
    expect(agent.isTombstoned(id)).toBe(true)
    const late = await agent.create(makeAgentSpec(id)).catch(error => error)
    expect(late).toBeInstanceOf(AgentRejectedError)
    expect((late as AgentRejectedError).code).toBe('conflict')
    expect(agent.instances.has(id)).toBe(false)
  })

  test('records survive a simulated agent restart', async () => {
    const { agent } = setup()
    const id = 'b'.repeat(24)
    await agent.create(makeAgentSpec(id))
    agent.simulateRestart()
    expect((await agent.get(id))?.id).toBe(id)
    expect(await agent.list()).toHaveLength(1)
  })

  test('create timestamps use the agent clock offset', async () => {
    const { clock, agent } = setup()
    agent.clockOffsetMs = 60_000
    await agent.create(makeAgentSpec('c'.repeat(24)))
    expect((await agent.get('c'.repeat(24)))?.createdAtMs).toBe(
      clock.t + 60_000
    )
  })

  test('spec hash excludes expiresAtMs and flag values but rejects real changes', async () => {
    const { agent } = setup()
    const id = 'd'.repeat(24)
    const spec = makeAgentSpec(id, {
      expiresAtMs: 2_000_000,
      flags: [{ provider: 'rctf', flag: 'FLAG{one}' }],
    })
    await agent.create(spec)

    // Same logical spec: a new deadline and new flag value are idempotent.
    await expect(
      agent.create({
        ...spec,
        expiresAtMs: 3_000_000,
        flags: [{ provider: 'rctf', flag: 'FLAG{two}' }],
      })
    ).resolves.toMatchObject({ id })

    const mismatch = await agent
      .create({ ...spec, vcpus: 2 })
      .catch(error => error)
    expect(mismatch).toBeInstanceOf(AgentRejectedError)
    expect((mismatch as AgentRejectedError).code).toBe('spec_mismatch')
    expect(agent.createCalls).toHaveLength(3)
  })

  test('optional dead-man expiry destroys the VM after the grace period', async () => {
    const { clock, agent } = setup()
    agent.deadmanEnabled = true
    agent.expiryGraceMs = 5000
    const id = 'e'.repeat(24)
    await agent.create(makeAgentSpec(id, { expiresAtMs: clock.t + 10_000 }))
    expect(agent.instances.has(id)).toBe(true)

    clock.t += 14_000
    expect(agent.instances.has(id)).toBe(true)
    clock.t += 2000
    // Any operation observes the dead-man having destroyed the VM.
    expect(await agent.get(id)).toBeUndefined()
    expect(agent.instances.has(id)).toBe(false)
  })
})
