#!/usr/bin/env bun
/**
 * Read-only view of the controller SQLite database, for the multi-host harness.
 * Run INSIDE host-a (the controller host), where bun:sqlite is available:
 *
 *   bun deploy/firecracker/multihost/dbdump.ts <database-path>
 *
 * The controller is the source of truth for instance ownership (team/challenge
 * -> pinned host) and for host health/clock state, so the test driver observes
 * it directly instead of inferring ownership. Only SELECTs are issued; the
 * connection is read-write because a SQLite WAL may need recovery after a
 * SIGKILL of the controller.
 */
import { Database } from 'bun:sqlite'

const path = process.argv[2]
if (!path) {
  console.error('usage: dbdump.ts <database-path>')
  process.exit(2)
}

const db = new Database(path)
try {
  db.exec('PRAGMA busy_timeout = 5000')
  const instances = db
    .query(
      `SELECT id, state, team_id, challenge_integration_id, host_id,
              expires_at_ms, created_at_ms, updated_at_ms, message, revision,
              agent_expiry_synced
         FROM instances
        ORDER BY created_at_ms`
    )
    .all()
  const hosts = db
    .query(
      `SELECT id, url, health, accepting, draining, last_seen_ms,
              clock_skew_ms, clock_rtt_ms, clock_sampled_at_ms, clock_state,
              reported_vcpus, reported_mem_mib, reported_max_instances
         FROM hosts
        ORDER BY id`
    )
    .all()
  console.log(JSON.stringify({ instances, hosts }))
} finally {
  db.close()
}
