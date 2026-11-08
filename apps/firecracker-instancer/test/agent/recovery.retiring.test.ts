import { afterEach, describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { createNetworkManager } from '../../src/agent/net'
import {
  buildStoredInstance,
  leaseToJson,
  StateStore,
} from '../../src/agent/state'
import type { VmHandle } from '../../src/interfaces'
import { createLogger } from '../../src/log'
import { FakeHost, makeTempConfig, tcpExpose } from '../net/support'
import { createHarness, type Harness } from './harness'
import { makeSpec, nextId, readTree, toExpose, waitFor } from './fakes'

const harnesses: Harness[] = []

const setup = async (
  opts?: Parameters<typeof createHarness>[0]
): Promise<Harness> => {
  const harness = await createHarness(opts)
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

const logger = (): ReturnType<typeof createLogger> =>
  createLogger('recovery-retiring-test', 'silent')

const makeHandle = (instanceId: string): VmHandle => ({
  instanceId,
  pid: 4242,
  pidStartTicks: 11,
  apiSocket: `/run/${instanceId}/api.sock`,
  dir: `/run/${instanceId}`,
})

const persistedRecords = async (dir: string): Promise<string[]> =>
  Object.keys(await readTree(dir))
    .filter(name => !name.startsWith('tombstones/') && !name.includes('.tmp-'))
    .sort()

describe('interrupted network release survives a restart (retiring leases)', () => {
  it('never treats an empty replacement network manager as confirmed release', async () => {
    const harness = await setup({ sweepIntervalMs: 2 })
    const netConfig = await makeTempConfig()
    const host = new FakeHost()
    const clock = harness.clock.now
    const netA = createNetworkManager(netConfig, { runner: host, clock })

    const spec = makeSpec({
      expose: [
        { kind: 'tcp', hostPrefix: 'svc', port: 8080 },
        { kind: 'http', hostPrefix: 'web', port: 3000 },
      ],
    })
    const expose = toExpose(spec.expose)
    const lease = await netA.allocate({
      instanceId: spec.id,
      egress: false,
      expose,
    })
    await netA.publish(lease, expose)
    const publicPort = lease.publicPorts[0] as number
    const index = Number(lease.tapName.slice('fctap'.length))

    // A flow from the previous tenant that the release MUST flush before the
    // resources may be reused.
    host.seedFlow({
      origSrc: lease.guestIp,
      origDst: '203.0.113.5',
      replySrc: '203.0.113.5',
      replyDst: lease.guestIp,
    })

    // Persisted mid-teardown record: the agent crashed/was restarted after it
    // wrote `stopping`, fenced, removed routes and deleted the tap, but the
    // conntrack flush failed.
    const handle = makeHandle(spec.id)
    await new StateStore(harness.dir, logger()).save({
      ...buildStoredInstance(spec, clock(), 'stopping'),
      lease: leaseToJson(lease),
      vm: handle,
      updatedAtMs: clock(),
    })
    host.conntrackFlushError = 'Operation not permitted'
    await expect(netA.release(spec.id)).rejects.toThrow(
      'could not flush conntrack'
    )
    expect(host.flows).toHaveLength(1)
    expect(host.links.has(lease.tapName)).toBe(false)

    // Production restart: a FRESH network manager with an EMPTY in-memory map.
    const netB = createNetworkManager(netConfig, { runner: host, clock })
    const mgrB = harness.spawn({ net: netB, sweepIntervalMs: 2 })
    await mgrB.start()

    // The flush still fails, so recovery must NOT forget the record, must not
    // re-create the tap, and must not free the lease.
    const stillStopping = await mgrB.get(spec.id)
    expect(stillStopping?.state).toBe('stopping')
    expect(host.flows).toHaveLength(1)
    expect(host.links.has(lease.tapName)).toBe(false)
    expect((await mgrB.info()).usage.instances).toBe(1)
    expect(await persistedRecords(harness.dir)).toEqual([`${spec.id}.json`])

    // Fix the host: the retrying teardown flushes conntrack and durably
    // persists the quarantine before freeing the record.
    host.conntrackFlushError = undefined
    await waitFor(async () =>
      (await mgrB.get(spec.id)) === undefined ? true : undefined
    )
    expect(host.flows).toHaveLength(0)
    const quarantine = JSON.parse(
      await readFile(netConfig.quarantineFile, 'utf8')
    ) as { indexes: { id: number }[]; ports: { id: number }[] }
    expect(quarantine.indexes.map(entry => entry.id)).toContain(index)
    expect(quarantine.ports.map(entry => entry.id)).toContain(publicPort)

    // The just-released guest IP/port must NOT be handed to the next tenant
    // immediately (old conntrack/NAT state could still exist).
    const replacement = await netB.allocate({
      instanceId: nextId(),
      egress: false,
      expose: [tcpExpose(8080)],
    })
    expect(replacement.guestIp).not.toBe(lease.guestIp)
    expect(replacement.publicPorts[0]).not.toBe(publicPort)

    harness.clock.advance(121_000)
    const later = await netB.allocate({
      instanceId: nextId(),
      egress: false,
      expose: [tcpExpose(8080)],
    })
    expect(later.guestIp).toBe(lease.guestIp)
  })
})
