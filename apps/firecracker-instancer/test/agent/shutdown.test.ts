import { afterEach, describe, expect, it } from 'bun:test'
import { createAgentServer, type AgentServer } from '../../src/agent/server'
import { createHarness, type Harness } from './harness'
import { makeGate, makeSpec, never, waitFor } from './fakes'

const harnesses: Harness[] = []
const servers: AgentServer[] = []

const setup = async (
  opts?: Parameters<typeof createHarness>[0]
): Promise<Harness> => {
  const harness = await createHarness(opts)
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(0).catch(() => {})
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

describe('graceful shutdown', () => {
  it('manager.stop drains an in-flight create before returning (within the deadline)', async () => {
    const harness = await setup({
      config: { shutdownTimeoutSeconds: 1 },
      sweepIntervalMs: 1_000_000,
    })
    const gate = makeGate()
    harness.vm.launchGate = gate.promise
    const spec = makeSpec()
    const create = harness.mgr.create(spec)
    await waitFor(() => (harness.vm.launchCalls > 0 ? true : undefined))

    const startedAt = Date.now()
    const stopping = harness.mgr.stop()
    await new Promise(resolve => setTimeout(resolve, 60))
    gate.open()
    await stopping
    const elapsed = Date.now() - startedAt

    // The drain waited for the create instead of returning immediately.
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect((await create).id).toBe(spec.id)
    expect(harness.vm.destroyCalls).toBe(0)
    expect(harness.vm.alive.has(spec.id)).toBe(true)
  })

  it('manager.stop drains only up to the deadline and leaves VMs running', async () => {
    const harness = await setup({
      config: { shutdownTimeoutSeconds: 0 },
      sweepIntervalMs: 1_000_000,
    })
    harness.vm.launchGate = never()
    const spec = makeSpec()
    const create = harness.mgr.create(spec)
    void create.catch(() => {})
    await waitFor(() => (harness.vm.launchCalls > 0 ? true : undefined))

    const startedAt = Date.now()
    await harness.mgr.stop()
    expect(Date.now() - startedAt).toBeLessThan(500)

    // Draining never tears down a VM.
    expect(harness.vm.stopCalls).toBe(0)
    expect(harness.vm.destroyCalls).toBe(0)
    expect(harness.vm.alive.has(spec.id)).toBe(true)
  })

  it('server.stop lets an in-flight request finish during the drain', async () => {
    const harness = await setup({ sweepIntervalMs: 1_000_000 })
    const server = createAgentServer({
      config: harness.config,
      manager: harness.mgr,
    })
    servers.push(server)
    const base = `http://127.0.0.1:${server.server.port}`
    const headers = {
      authorization: `Bearer ${harness.config.token}`,
      'content-type': 'application/json',
    }

    const gate = makeGate()
    harness.vm.launchGate = gate.promise
    const spec = makeSpec()
    const held = fetch(`${base}/v1/instances/${spec.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(spec),
    })
    await waitFor(() => (harness.vm.launchCalls > 0 ? true : undefined))

    const startedAt = Date.now()
    const stopping = server.stop(1000)
    await new Promise(resolve => setTimeout(resolve, 60))
    gate.open()
    const response = await held
    await stopping

    // The in-flight create was drained, not force-closed by stop(true).
    expect(response.status).toBe(200)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40)
  })

  it('server.stop stops accepting and returns by the deadline without awaiting a held request', async () => {
    const harness = await setup({
      config: { shutdownTimeoutSeconds: 0 },
      sweepIntervalMs: 1_000_000,
    })
    const server = createAgentServer({
      config: harness.config,
      manager: harness.mgr,
    })
    servers.push(server)
    const base = `http://127.0.0.1:${server.server.port}`
    const headers = {
      authorization: `Bearer ${harness.config.token}`,
      'content-type': 'application/json',
    }

    harness.vm.launchGate = never()
    const spec = makeSpec()
    const held = fetch(`${base}/v1/instances/${spec.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(spec),
    })
    void held.catch(() => {})
    await waitFor(() => (harness.vm.launchCalls > 0 ? true : undefined))

    const startedAt = Date.now()
    await server.stop(40)
    // An un-deadlined `server.stop()` would wait for the held request forever.
    expect(Date.now() - startedAt).toBeLessThan(500)

    let refused = false
    try {
      const response = await fetch(`${base}/v1/info`, { headers })
      refused = response.status === 503 || response.status === 404
    } catch {
      refused = true
    }
    expect(refused).toBe(true)

    // The guest was not destroyed by draining.
    expect(harness.vm.destroyCalls).toBe(0)
    expect(harness.vm.alive.has(spec.id)).toBe(true)
  })
})
