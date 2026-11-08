/**
 * Restart simulation for check 8.9: construct a FRESH NetworkManager in a FRESH
 * bun process, let its constructor load the persisted quarantine file from
 * disk, call restore([]), then allocate one lease.
 *
 * Using a separate process (not `manager.restore([])` on the already-running
 * object) is what makes the check sensitive to a regression where startup
 * ignores the on-disk quarantine: such a manager would hand a released /30 or
 * port straight back out.
 *
 * Usage: bun lifecycle-restart.ts CONFIG_JSON INSTANCE_ID [QUARANTINE_FILE]
 * Prints one JSON line: {"tapName","guestIp","publicPorts"}.
 */
import { readFileSync } from 'node:fs'
import { createNetworkManager } from '../../../../apps/firecracker-instancer/src/agent/net'
import { bunCommandRunner } from '../../../../apps/firecracker-instancer/src/util/exec'

const [configPath, instanceId, quarantineOverride] = process.argv.slice(2)
if (!configPath || !instanceId) {
  throw new Error('usage: lifecycle-restart.ts CONFIG_JSON INSTANCE_ID [QUARANTINE_FILE]')
}

const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
  quarantineFile: string
}
if (quarantineOverride !== undefined) config.quarantineFile = quarantineOverride

const manager = createNetworkManager(config as never, {
  runner: bunCommandRunner,
})
// The constructor starts loading the quarantine file; restore([]) and
// allocate() both await it before touching the allocators.
await manager.restore([])
const lease = await manager.allocate({
  instanceId,
  egress: false,
  expose: [{ kind: 'tcp', hostPrefix: 'reuse', port: 8080 }],
})
console.log(
  JSON.stringify({
    tapName: lease.tapName,
    guestIp: lease.guestIp,
    publicPorts: lease.publicPorts,
  })
)
await manager.release(lease.instanceId)
