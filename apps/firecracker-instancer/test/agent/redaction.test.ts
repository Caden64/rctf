import { afterEach, describe, expect, it } from 'bun:test'
import { createAgentServer, type AgentServer } from '../../src/agent/server'
import { captureLogger, makeSpec, readTree, waitFor } from './fakes'
import { createHarness, type Harness } from './harness'

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

const FLAG = 'FLAG{quote"back\\slash\nnewline}'
const ESCAPED = JSON.stringify(FLAG).slice(1, -1)

const leakyError = (): Error =>
  new Error(
    `boom ${JSON.stringify({
      flags: [{ provider: 'rctf/flag', flag: FLAG }],
      teamKey: 'teamkey01',
    })}`
  )

const assertNoLeak = async (
  harness: Harness,
  logs: string,
  extra = ''
): Promise<void> => {
  const tree = JSON.stringify(await readTree(harness.dir))
  for (const text of [logs, tree, extra]) {
    expect(text).not.toContain(FLAG)
    expect(text).not.toContain(ESCAPED)
  }
}

describe('driver/network errors never leak request secrets', () => {
  it('redacts launch failures in logs and state', async () => {
    const captured = captureLogger()
    const harness = await setup({
      logger: captured.logger,
      sweepIntervalMs: 1_000_000,
    })
    harness.vm.launchError = leakyError()

    const created = await harness.mgr.create(makeSpec())
    expect(created.state).toBe('errored')
    expect(created.message).toBe('launch failed')
    await assertNoLeak(harness, captured.text(), created.message ?? '')
  })

  it('redacts readiness failures in logs and state', async () => {
    const captured = captureLogger()
    const harness = await setup({
      logger: captured.logger,
      sweepIntervalMs: 1_000_000,
    })
    harness.vm.waitReadyError = leakyError()

    const spec = makeSpec()
    await harness.mgr.create(spec)
    const errored = await waitFor(async () => {
      const current = await harness.mgr.get(spec.id)
      return current?.state === 'errored' ? current : undefined
    })
    expect(errored.message).toBe('readiness timed out')
    await assertNoLeak(harness, captured.text(), errored.message ?? '')
  })

  it('redacts network allocate/publish failures in logs and state', async () => {
    for (const which of ['allocate', 'publish'] as const) {
      const captured = captureLogger()
      const harness = await setup({
        logger: captured.logger,
        sweepIntervalMs: 1_000_000,
      })
      if (which === 'allocate') harness.net.allocateError = leakyError()
      else harness.net.publishError = leakyError()

      const created = await harness.mgr.create(makeSpec())
      expect(created.state).toBe('errored')
      expect(created.message).toBe(
        which === 'allocate'
          ? 'network allocation failed'
          : 'network publish failed'
      )
      await assertNoLeak(harness, captured.text())
    }
  })

  it('redacts stop/destroy/unpublish/release failures in logs, state and tombstones', async () => {
    for (const which of ['stop', 'destroy', 'unpublish', 'release'] as const) {
      const captured = captureLogger()
      const harness = await setup({
        logger: captured.logger,
        sweepIntervalMs: 1_000_000,
      })
      const spec = makeSpec()
      await harness.mgr.create(spec)
      if (which === 'stop') harness.vm.stopError = leakyError()
      if (which === 'destroy') harness.vm.destroyError = leakyError()
      if (which === 'unpublish') harness.net.unpublishError = leakyError()
      if (which === 'release') harness.net.releaseError = leakyError()

      await harness.mgr.delete(spec.id).catch(() => {})
      await assertNoLeak(harness, captured.text())
    }
  })

  it('redacts HTTP error/response bodies', async () => {
    const captured = captureLogger()
    const harness = await setup({
      logger: captured.logger,
      sweepIntervalMs: 1_000_000,
    })
    const server = createAgentServer({
      config: harness.config,
      manager: harness.mgr,
      logger: captured.logger,
    })
    servers.push(server)
    const headers = {
      authorization: `Bearer ${harness.config.token}`,
      'content-type': 'application/json',
    }

    // A creation failure returns an errored instance body.
    harness.vm.launchError = leakyError()
    const first = makeSpec()
    const create = await fetch(
      `http://127.0.0.1:${server.server.port}/v1/instances/${first.id}`,
      { method: 'PUT', headers, body: JSON.stringify(first) }
    )
    expect(create.status).toBe(200)
    const createBody = await create.text()
    expect(createBody).not.toContain(FLAG)
    expect(createBody).not.toContain(ESCAPED)

    // A teardown failure returns a fixed 409 body.
    harness.vm.launchError = undefined
    const second = makeSpec()
    const created = await harness.mgr.create(second)
    expect(created.state).not.toBe('errored')
    harness.vm.destroyError = leakyError()
    const remove = await fetch(
      `http://127.0.0.1:${server.server.port}/v1/instances/${second.id}`,
      { method: 'DELETE', headers }
    )
    expect(remove.status).toBe(409)
    const removeBody = await remove.text()
    expect(removeBody).not.toContain(FLAG)
    expect(removeBody).not.toContain(ESCAPED)

    await assertNoLeak(harness, captured.text(), `${createBody}\n${removeBody}`)
  })
})
