/**
 * Real-host checks. Skipped by default; run on a disposable root host with
 * nftables + conntrack-tools:
 *
 *   FC_REAL=1 sudo bun test test/net
 *
 * These tests create and delete a real tap in TEST-NET-2 (198.51.100.0/30) and
 * only ever touch resources named with our `fctap` prefix. Nothing here runs in
 * CI.
 */
import { describe, expect, test } from 'bun:test'
import { renderRuleset } from '../../src/agent/net/nftables'
import { TapController } from '../../src/agent/net/tap'
import { flushConntrack } from '../../src/agent/net/conntrack'
import { bunCommandRunner } from '../../src/util/exec'
import { makeLease, makeTempConfig, tcpExpose } from './support'

const real = test.skipIf(!process.env.FC_REAL)

const config = await makeTempConfig({
  subnetPool: '198.51.100.0/24',
  externalInterface: 'eth0',
})

describe('real host (FC_REAL)', () => {
  real('rendered inet + arp ruleset passes nft -c', async () => {
    const lease = makeLease({
      instanceId: 'fcreal'.padEnd(16, '0'),
      tapName: 'fctap0',
      hostIp: '198.51.100.1',
      guestIp: '198.51.100.2',
      expose: [tcpExpose(8080)],
      publicPorts: { 0: 24000 },
    })
    const text = renderRuleset([lease], config)
    expect(text).toContain('table arp rctf_fc_arp {')
    const result = await bunCommandRunner.run(['nft', '-c', '-f', '-'], {
      stdin: text,
    })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
  })

  real('tap create/delete only touches our interface', async () => {
    const taps = new TapController(bunCommandRunner, {})
    const lease = makeLease({
      instanceId: 'fcreal'.padEnd(16, '1'),
      tapName: 'fctap9002',
      hostIp: '198.51.100.5',
      guestIp: '198.51.100.6',
    })
    await taps.remove(lease.tapName) // start clean; absent is tolerated
    await taps.create(lease)
    const created = await taps.inspect(lease.tapName)
    expect(created.exists).toBe(true)
    expect(created.up).toBe(true)
    expect(created.addresses).toContain(`${lease.hostIp}/30`)
    await taps.remove(lease.tapName)
    const removed = await taps.inspect(lease.tapName)
    expect(removed.exists).toBe(false)
    await taps.remove(lease.tapName) // idempotent
  })

  real('conntrack flush succeeds on an empty table', async () => {
    await flushConntrack(bunCommandRunner, {
      guestIp: '198.51.100.6',
      publicPorts: [24001],
    })
  })
})
