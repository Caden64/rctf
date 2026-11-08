import { afterEach, describe, expect, it } from 'bun:test'
import { createAgentServer, type AgentServer } from '../../src/agent/server'
import { captureLogger, makeSpec, readTree } from './fakes'
import { createHarness, type Harness } from './harness'

const harnesses: Harness[] = []
const servers: AgentServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => {})
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

describe('flag secrecy', () => {
  it('never leaks a flag into state files, logs or HTTP error bodies', async () => {
    const captured = captureLogger()
    const harness = await createHarness({ logger: captured.logger })
    harnesses.push(harness)

    const flag = 'FLAG{unique-secret-4f3d9a}'
    const spec = makeSpec({ flags: [{ provider: 'rctf/flag', flag }] })
    harness.vm.launchError = new Error(`launch exploded with ${flag}`)

    const created = await harness.mgr.create(spec)
    expect(created.state).toBe('errored')
    expect(created.message ?? '').not.toContain(flag)

    // A second create with a different spec exercises the error path too.
    const agent = createAgentServer({
      config: harness.config,
      manager: harness.mgr,
      logger: captured.logger,
    })
    servers.push(agent)
    const response = await fetch(
      `http://127.0.0.1:${agent.server.port}/v1/instances/${spec.id}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${harness.config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...spec, memMiB: spec.memMiB + 128 }),
      }
    )
    expect(response.status).toBe(409)
    const body = await response.text()
    expect(body).not.toContain(flag)

    const files = await readTree(harness.dir)
    expect(JSON.stringify(files)).not.toContain(flag)
    const logs = captured.text()
    expect(logs).not.toContain(flag)
  })
})
