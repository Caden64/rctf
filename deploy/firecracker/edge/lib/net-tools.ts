// CLI used by the edge-test phases. Runs against the REAL modules from
// apps/firecracker-instancer/src (not a re-implementation).
//
//   bun net-tools.ts render <spec.json>   # print the exact ruleset for spec.leases/config
//   bun net-tools.ts flush <guestIp>      # the real conntrack flush used by release
import { readFileSync } from 'node:fs'
import { flushConntrack } from '../../../../apps/firecracker-instancer/src/agent/net/conntrack'
import { renderRuleset } from '../../../../apps/firecracker-instancer/src/agent/net/nftables'
import { bunCommandRunner } from '../../../../apps/firecracker-instancer/src/util/exec'

interface RenderSpec {
  leases: Parameters<typeof renderRuleset>[0]
  config: Parameters<typeof renderRuleset>[1]
  fenced?: string[]
  published?: string[]
}

const [command, ...args] = process.argv.slice(2)

if (command === 'render') {
  const file = args[0]
  if (!file) throw new Error('usage: render <spec.json>')
  const spec = JSON.parse(readFileSync(file, 'utf8')) as RenderSpec
  process.stdout.write(
    renderRuleset(spec.leases, spec.config, {
      fenced: new Set(spec.fenced ?? []),
      published:
        spec.published === undefined ? undefined : new Set(spec.published),
    })
  )
} else if (command === 'flush') {
  const guestIp = args[0]
  if (!guestIp) throw new Error('usage: flush <guestIp>')
  await flushConntrack(bunCommandRunner, { guestIp })
  console.log(`flushed ${guestIp}`)
} else {
  throw new Error(`unknown command: ${String(command)}`)
}
