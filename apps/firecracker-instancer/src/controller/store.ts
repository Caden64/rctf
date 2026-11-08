/**
 * Durable controller state: instance ownership + capacity reservations.
 *
 * `bun:sqlite` in WAL mode. The controller SQLite database is the source of
 * truth for *which team has which instance on which host*. Flags are never
 * written here: callers only hand the agent spec (with flags) to the agent
 * client, and persist the non-secret parts (image, resources, expose list).
 *
 * Every multi-step state change is either a single `BEGIN IMMEDIATE`
 * transaction or a compare-and-swap `UPDATE ... WHERE state = ?` whose
 * `changes` count is checked by the caller.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ControllerEndpoint,
  ExposeKindValue,
} from '@rctf/firecracker-protocol'
import type { Clock } from '../interfaces'

export type InstanceState =
  | 'creating'
  | 'running'
  | 'deleting'
  | 'errored'
  | 'lost'

/**
 * States that own the `(teamId, challengeIntegrationId)` key and keep their
 * capacity reservation. `deleting` still holds resources until the agent
 * confirms the teardown; `errored` and `lost` are terminal-until-delete.
 */
export const LIVE_STATES: readonly InstanceState[] = [
  'creating',
  'running',
  'deleting',
]

export const isLiveState = (state: InstanceState): boolean =>
  LIVE_STATES.includes(state)

export interface Capacity {
  vcpus: number
  memMiB: number
  diskMiB: number
  maxInstances: number
}

export interface Reserved {
  vcpus: number
  memMiB: number
  diskMiB: number
  instances: number
}

export const EMPTY_RESERVED: Reserved = {
  vcpus: 0,
  memMiB: 0,
  diskMiB: 0,
  instances: 0,
}

export interface StoredExpose {
  kind: ExposeKindValue
  hostPrefix: string
  /** Guest TCP port. */
  port: number
  title?: string
}

export interface InstanceRecord {
  id: string
  teamId: string
  challengeIntegrationId: string
  /** HMAC of the team id; the only team identifier sent to hosts. */
  teamKey: string
  hostId: string
  state: InstanceState
  image: string
  vcpus: number
  memMiB: number
  diskMiB: number
  expiresAtMs: number
  createdAtMs: number
  updatedAtMs: number
  /**
   * Monotonically incremented on every mutation of this row. Snapshots/CAS
   * compare this instead of `updatedAtMs`, so two writes in the same
   * millisecond (or with a coarse/fixed clock) cannot clobber each other.
   */
  revision: number
  message: string | null
  /** false => the agent's copy of the deadline is behind and must be re-pushed. */
  agentExpirySynced: boolean
  /** Non-secret expose list, in request order. */
  expose: StoredExpose[]
  /** Last endpoints reported by the agent, in expose order. */
  endpoints: ControllerEndpoint[] | null
}

export type HostHealth = 'healthy' | 'unhealthy'

/**
 * `unknown`: never sampled successfully.
 * `valid`: the stored estimate came from a recent accepted sample.
 * `stale`: a previous estimate exists, but the last sample was rejected or the
 * controller restarted; the host takes no new placements until a probe works.
 */
export type HostClockState = 'unknown' | 'valid' | 'stale'

/** One accepted clock measurement: (agent - controller) offset in ms. */
export interface ClockSample {
  skewMs: number
  rttMs: number
  sampledAtMs: number
}

export interface HostRecord {
  id: string
  url: string
  draining: boolean
  health: HostHealth
  /** Agent accepted new instances on its last heartbeat. */
  accepting: boolean
  lastSeenMs: number | null
  createdAtMs: number
  /** Last capacity reported by the agent; effective capacity is min(config, this). */
  reportedCapacity: Capacity | null
  /** Estimated (agent - controller) clock offset in ms, RTT compensated. */
  clockSkewMs: number
  /** Round-trip time of the sample that produced `clockSkewMs`. */
  clockRttMs: number | null
  /** Controller-clock time when the estimate was measured. */
  clockSampledAtMs: number | null
  clockState: HostClockState
}

export interface InstanceKeyRow {
  teamId: string
  challengeIntegrationId: string
}

interface InstanceDbRow {
  id: string
  team_id: string
  challenge_integration_id: string
  team_key: string
  host_id: string
  state: string
  image: string
  vcpus: number
  mem_mib: number
  disk_mib: number
  expires_at_ms: number
  created_at_ms: number
  updated_at_ms: number
  revision: number
  message: string | null
  agent_expiry_synced: number
  expose_json: string
  endpoints_json: string | null
}

interface HostDbRow {
  id: string
  url: string
  draining: number
  health: string
  accepting: number
  last_seen_ms: number | null
  created_at_ms: number
  reported_vcpus: number | null
  reported_mem_mib: number | null
  reported_disk_mib: number | null
  reported_max_instances: number | null
  clock_skew_ms: number
  clock_rtt_ms: number | null
  clock_sampled_at_ms: number | null
  clock_state: string
}

interface Migration {
  version: number
  sql: string
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        draining INTEGER NOT NULL DEFAULT 0,
        health TEXT NOT NULL DEFAULT 'healthy',
        accepting INTEGER NOT NULL DEFAULT 1,
        last_seen_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        reported_vcpus INTEGER,
        reported_mem_mib INTEGER,
        reported_disk_mib INTEGER,
        reported_max_instances INTEGER
      );

      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        challenge_integration_id TEXT NOT NULL,
        team_key TEXT NOT NULL,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        image TEXT NOT NULL,
        vcpus INTEGER NOT NULL,
        mem_mib INTEGER NOT NULL,
        disk_mib INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        message TEXT,
        agent_expiry_synced INTEGER NOT NULL DEFAULT 1,
        expose_json TEXT NOT NULL,
        endpoints_json TEXT
      );

      -- One live instance per (team, challenge), even under concurrent creates.
      CREATE UNIQUE INDEX IF NOT EXISTS instances_live_key
        ON instances(team_id, challenge_integration_id)
        WHERE state IN ('creating', 'running', 'deleting');

      CREATE INDEX IF NOT EXISTS instances_host_idx ON instances(host_id);
      CREATE INDEX IF NOT EXISTS instances_state_expiry_idx
        ON instances(state, expires_at_ms);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE hosts ADD COLUMN clock_skew_ms INTEGER NOT NULL DEFAULT 0;

      -- 'reserving' was never written; keep the live index in sync with
      -- LIVE_STATES and re-assert it for databases created by v1.
      DROP INDEX IF EXISTS instances_live_key;
      CREATE UNIQUE INDEX IF NOT EXISTS instances_live_key
        ON instances(team_id, challenge_integration_id)
        WHERE state IN ('creating', 'running', 'deleting');

      CREATE INDEX IF NOT EXISTS instances_key_idx
        ON instances(team_id, challenge_integration_id, state);
    `,
  },
  {
    version: 3,
    sql: `
      -- CAS revision: every row mutation increments it, so snapshot updates
      -- never rely on millisecond timestamps.
      ALTER TABLE instances ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

      -- Clock samples: an estimate is usable only when recent and accepted.
      ALTER TABLE hosts ADD COLUMN clock_rtt_ms REAL;
      ALTER TABLE hosts ADD COLUMN clock_sampled_at_ms INTEGER;
      ALTER TABLE hosts ADD COLUMN clock_state TEXT NOT NULL DEFAULT 'unknown';
    `,
  },
]

const INSTANCE_COLUMNS = `
  id, team_id, challenge_integration_id, team_key, host_id, state, image,
  vcpus, mem_mib, disk_mib, expires_at_ms, created_at_ms, updated_at_ms,
  revision, message, agent_expiry_synced, expose_json, endpoints_json
`

const parseJson = <T>(value: string | null): T | null => {
  if (value === null) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

const rowToInstance = (row: InstanceDbRow): InstanceRecord => ({
  id: row.id,
  teamId: row.team_id,
  challengeIntegrationId: row.challenge_integration_id,
  teamKey: row.team_key,
  hostId: row.host_id,
  state: row.state as InstanceState,
  image: row.image,
  vcpus: row.vcpus,
  memMiB: row.mem_mib,
  diskMiB: row.disk_mib,
  expiresAtMs: row.expires_at_ms,
  createdAtMs: row.created_at_ms,
  updatedAtMs: row.updated_at_ms,
  revision: row.revision,
  message: row.message,
  agentExpirySynced: row.agent_expiry_synced === 1,
  expose: parseJson<StoredExpose[]>(row.expose_json) ?? [],
  endpoints: parseJson<ControllerEndpoint[]>(row.endpoints_json),
})

const rowToHost = (row: HostDbRow): HostRecord => ({
  id: row.id,
  url: row.url,
  draining: row.draining === 1,
  health: row.health === 'unhealthy' ? 'unhealthy' : 'healthy',
  accepting: row.accepting === 1,
  lastSeenMs: row.last_seen_ms,
  createdAtMs: row.created_at_ms,
  reportedCapacity:
    row.reported_vcpus === null ||
    row.reported_mem_mib === null ||
    row.reported_disk_mib === null ||
    row.reported_max_instances === null
      ? null
      : {
          vcpus: row.reported_vcpus,
          memMiB: row.reported_mem_mib,
          diskMiB: row.reported_disk_mib,
          maxInstances: row.reported_max_instances,
        },
  clockSkewMs: row.clock_skew_ms ?? 0,
  clockRttMs: row.clock_rtt_ms ?? null,
  clockSampledAtMs: row.clock_sampled_at_ms ?? null,
  clockState:
    row.clock_state === 'valid' || row.clock_state === 'stale'
      ? row.clock_state
      : 'unknown',
})

const placeholders = (count: number): string =>
  Array.from({ length: count }, () => '?').join(', ')

/** Map agent endpoints (already in expose order) to player-facing endpoints. */
export const controllerEndpoints = (
  expose: readonly StoredExpose[],
  endpoints: readonly {
    kind: ExposeKindValue
    host: string
    port: number
  }[]
): ControllerEndpoint[] =>
  endpoints.map((endpoint, index) => {
    const title = expose[index]?.title
    return title === undefined
      ? { kind: endpoint.kind, host: endpoint.host, port: endpoint.port }
      : {
          kind: endpoint.kind,
          host: endpoint.host,
          port: endpoint.port,
          title,
        }
  })

export interface StatePatch {
  message?: string | null
  endpoints?: ControllerEndpoint[] | null
  agentExpirySynced?: boolean
}

/** Thrown by every store operation after `close()` (controller shutdown). */
export class StoreClosedError extends Error {
  constructor() {
    super('controller store is closed')
    this.name = 'StoreClosedError'
  }
}

export class Store {
  readonly db: Database
  private closed = false

  constructor(
    path: string,
    private readonly now: Clock = () => Date.now()
  ) {
    if (path !== ':memory:' && !path.startsWith('file:')) {
      mkdirSync(dirname(path), { recursive: true })
    }
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    this.migrate()
    // Opening the database IS a controller (re)start: a persisted estimate was
    // measured by a previous process and must not be trusted until this process
    // completes its own probe. Keep the value, but mark it stale.
    this.markClockSamplesStale()
  }

  /** Any operation after `close()` throws so late loop ticks are harmless. */
  private assertOpen(): void {
    if (this.closed) throw new StoreClosedError()
  }

  private markClockSamplesStale(): void {
    this.db
      .prepare(
        `UPDATE hosts
         SET clock_state = CASE
           WHEN clock_sampled_at_ms IS NULL THEN 'unknown'
           ELSE 'stale'
         END`
      )
      .run()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      );
    `)
    const applied = new Set(
      (
        this.db.prepare('SELECT version FROM schema_migrations').all() as {
          version: number
        }[]
      ).map(row => row.version)
    )
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      this.transaction(() => {
        this.db.exec(migration.sql)
        this.db
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)'
          )
          .run(migration.version, this.now())
      })
    }
  }

  /**
   * Single serialised write transaction. Callers MUST keep the callback
   * synchronous: reservations + placement happen in one atomic step.
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen()
    return this.db.transaction(fn).immediate()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  // ---- hosts ------------------------------------------------------------

  ensureHost(id: string, url: string, now = this.now()): HostRecord {
    this.assertOpen()
    this.db
      .prepare(
        `INSERT INTO hosts (id, url, created_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET url = excluded.url`
      )
      .run(id, url, now)
    return this.getHost(id)!
  }

  getHost(id: string): HostRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare('SELECT * FROM hosts WHERE id = ?')
      .get(id) as HostDbRow | null
    return row ? rowToHost(row) : null
  }

  listHosts(): HostRecord[] {
    this.assertOpen()
    const rows = this.db.prepare('SELECT * FROM hosts').all() as HostDbRow[]
    return rows.map(rowToHost)
  }

  /**
   * Record a successful heartbeat. `clock` is the accepted sample, or `null`
   * when this probe's sample was rejected: the previous estimate (if any) is
   * kept but marked stale, so the host takes no new placements until a later
   * probe produces a trustworthy sample.
   */
  recordHeartbeat(
    id: string,
    opts: {
      url?: string
      now: number
      accepting: boolean
      capacity: Capacity
      clock?: ClockSample | null
    }
  ): void {
    this.assertOpen()
    const existing = this.getHost(id)
    const sample = opts.clock ?? null
    const skewMs =
      sample === null ? (existing?.clockSkewMs ?? 0) : sample.skewMs
    const rttMs =
      sample === null ? (existing?.clockRttMs ?? null) : sample.rttMs
    const sampledAtMs =
      sample === null
        ? (existing?.clockSampledAtMs ?? null)
        : sample.sampledAtMs
    const clockState: HostClockState =
      sample !== null ? 'valid' : sampledAtMs === null ? 'unknown' : 'stale'
    this.db
      .prepare(
        `INSERT INTO hosts (
           id, url, created_at_ms, health, accepting, last_seen_ms,
           reported_vcpus, reported_mem_mib, reported_disk_mib,
           reported_max_instances, clock_skew_ms, clock_rtt_ms,
           clock_sampled_at_ms, clock_state
         ) VALUES (?, ?, ?, 'healthy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           health = 'healthy',
           accepting = excluded.accepting,
           last_seen_ms = excluded.last_seen_ms,
           reported_vcpus = excluded.reported_vcpus,
           reported_mem_mib = excluded.reported_mem_mib,
           reported_disk_mib = excluded.reported_disk_mib,
           reported_max_instances = excluded.reported_max_instances,
           clock_skew_ms = excluded.clock_skew_ms,
           clock_rtt_ms = excluded.clock_rtt_ms,
           clock_sampled_at_ms = excluded.clock_sampled_at_ms,
           clock_state = excluded.clock_state`
      )
      .run(
        id,
        opts.url ?? '',
        opts.now,
        opts.accepting ? 1 : 0,
        opts.now,
        opts.capacity.vcpus,
        opts.capacity.memMiB,
        opts.capacity.diskMiB,
        opts.capacity.maxInstances,
        Math.round(skewMs),
        rttMs,
        sampledAtMs,
        clockState
      )
  }

  markHostHealth(id: string, health: HostHealth): void {
    this.assertOpen()
    this.db.prepare('UPDATE hosts SET health = ? WHERE id = ?').run(health, id)
  }

  setDraining(id: string, draining: boolean): void {
    this.assertOpen()
    this.db
      .prepare('UPDATE hosts SET draining = ? WHERE id = ?')
      .run(draining ? 1 : 0, id)
  }

  /**
   * Operator removal of a lost host: write its live rows off as `lost`
   * tombstones (cleanup happens if/when the agent returns) and leave the host
   * draining so config seeding/heartbeats can never put it back into service.
   * `service.removeHost` enforces that only `unhealthy` hosts are removable.
   */
  removeHost(id: string, now = this.now()): string[] {
    return this.transaction(() => {
      const ids = this.writeOffHostUnsafe(id, now)
      this.db.prepare('UPDATE hosts SET draining = 1 WHERE id = ?').run(id)
      return ids
    })
  }

  // ---- instances --------------------------------------------------------

  insertInstance(record: InstanceRecord): void {
    this.assertOpen()
    this.db
      .prepare(
        `INSERT INTO instances (${INSTANCE_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.teamId,
        record.challengeIntegrationId,
        record.teamKey,
        record.hostId,
        record.state,
        record.image,
        record.vcpus,
        record.memMiB,
        record.diskMiB,
        record.expiresAtMs,
        record.createdAtMs,
        record.updatedAtMs,
        record.revision,
        record.message,
        record.agentExpirySynced ? 1 : 0,
        JSON.stringify(record.expose),
        record.endpoints === null ? null : JSON.stringify(record.endpoints)
      )
  }

  getInstance(id: string): InstanceRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare(`SELECT ${INSTANCE_COLUMNS} FROM instances WHERE id = ?`)
      .get(id) as InstanceDbRow | null
    return row ? rowToInstance(row) : null
  }

  getLiveInstance(key: InstanceKeyRow): InstanceRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare(
        `SELECT ${INSTANCE_COLUMNS} FROM instances
         WHERE team_id = ? AND challenge_integration_id = ?
           AND state IN (${placeholders(LIVE_STATES.length)})
         LIMIT 1`
      )
      .get(
        key.teamId,
        key.challengeIntegrationId,
        ...LIVE_STATES
      ) as InstanceDbRow | null
    return row ? rowToInstance(row) : null
  }

  /** Preferred row for `get`: a live row if any, else the newest terminal row. */
  getInstanceForKey(key: InstanceKeyRow): InstanceRecord | null {
    this.assertOpen()
    const row = this.db
      .prepare(
        `SELECT ${INSTANCE_COLUMNS} FROM instances
         WHERE team_id = ? AND challenge_integration_id = ?
         ORDER BY
           CASE WHEN state IN (${placeholders(LIVE_STATES.length)}) THEN 0 ELSE 1 END,
           created_at_ms DESC
         LIMIT 1`
      )
      .get(
        key.teamId,
        key.challengeIntegrationId,
        ...LIVE_STATES
      ) as InstanceDbRow | null
    return row ? rowToInstance(row) : null
  }

  listInstancesForHost(hostId: string): InstanceRecord[] {
    this.assertOpen()
    const rows = this.db
      .prepare(
        `SELECT ${INSTANCE_COLUMNS} FROM instances WHERE host_id = ?
         ORDER BY created_at_ms ASC`
      )
      .all(hostId) as InstanceDbRow[]
    return rows.map(rowToInstance)
  }

  listInstances(): InstanceRecord[] {
    this.assertOpen()
    const rows = this.db
      .prepare(`SELECT ${INSTANCE_COLUMNS} FROM instances`)
      .all() as InstanceDbRow[]
    return rows.map(rowToInstance)
  }

  listInstancesInStates(states: readonly InstanceState[]): InstanceRecord[] {
    this.assertOpen()
    if (states.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT ${INSTANCE_COLUMNS} FROM instances
         WHERE state IN (${placeholders(states.length)})`
      )
      .all(...states) as InstanceDbRow[]
    return rows.map(rowToInstance)
  }

  /** Terminal `errored` rows for one key; GC'd before a fresh create. */
  listErroredForKey(key: InstanceKeyRow): InstanceRecord[] {
    this.assertOpen()
    const rows = this.db
      .prepare(
        `SELECT ${INSTANCE_COLUMNS} FROM instances
         WHERE team_id = ? AND challenge_integration_id = ? AND state = 'errored'
         ORDER BY created_at_ms ASC`
      )
      .all(key.teamId, key.challengeIntegrationId) as InstanceDbRow[]
    return rows.map(rowToInstance)
  }

  /**
   * `errored` rows superseded by a newer row for the same key. They are no
   * longer visible as the key's instance and must not keep an agent-side
   * tombstone forever.
   */
  listSupersededErrored(): InstanceRecord[] {
    this.assertOpen()
    const rows = this.db
      .prepare(
        `SELECT ${INSTANCE_COLUMNS} FROM instances e
         WHERE e.state = 'errored'
           AND EXISTS (
             SELECT 1 FROM instances n
             WHERE n.team_id = e.team_id
               AND n.challenge_integration_id = e.challenge_integration_id
               AND n.id <> e.id
               AND n.created_at_ms >= e.created_at_ms
           )`
      )
      .all() as InstanceDbRow[]
    return rows.map(rowToInstance)
  }

  listExpiredRunning(now: number): InstanceRecord[] {
    this.assertOpen()
    const rows = this.db
      .prepare(
        `SELECT ${INSTANCE_COLUMNS} FROM instances
         WHERE state = 'running' AND expires_at_ms <= ?`
      )
      .all(now) as InstanceDbRow[]
    return rows.map(rowToInstance)
  }

  deleteInstance(id: string): boolean {
    this.assertOpen()
    return (
      this.db.prepare('DELETE FROM instances WHERE id = ?').run(id).changes > 0
    )
  }

  deleteInstanceIfState(id: string, state: InstanceState): boolean {
    this.assertOpen()
    return (
      this.db
        .prepare('DELETE FROM instances WHERE id = ? AND state = ?')
        .run(id, state).changes > 0
    )
  }

  /** Compare-and-swap the lifecycle state; returns false when another writer won. */
  casState(
    id: string,
    from: readonly InstanceState[],
    to: InstanceState,
    now: number,
    patch: StatePatch = {}
  ): boolean {
    this.assertOpen()
    if (from.length === 0) return false
    return this.applyStateUpdate(
      `id = ? AND state IN (${placeholders(from.length)})`,
      [id, ...from],
      to,
      now,
      patch
    )
  }

  /**
   * CAS against a row snapshot read earlier (`state` + `revision`).
   * Used whenever a decision was made from data fetched before a network
   * round-trip: if anything changed the row in the meantime, the update is a
   * no-op instead of clobbering newer ownership. `revision` increments on
   * every mutation, so it also separates writes made in the same millisecond.
   */
  casStateSnapshot(
    snapshot: InstanceRecord,
    to: InstanceState,
    now: number,
    patch: StatePatch = {}
  ): boolean {
    this.assertOpen()
    return this.applyStateUpdate(
      'id = ? AND state = ? AND revision = ?',
      [snapshot.id, snapshot.state, snapshot.revision],
      to,
      now,
      patch
    )
  }

  private applyStateUpdate(
    where: string,
    whereParams: (string | number)[],
    to: InstanceState,
    now: number,
    patch: StatePatch
  ): boolean {
    const sets = ['state = ?', 'updated_at_ms = ?', 'revision = revision + 1']
    const params: (string | number | null)[] = [to, now]
    if (patch.message !== undefined) {
      sets.push('message = ?')
      params.push(patch.message)
    }
    if (patch.endpoints !== undefined) {
      sets.push('endpoints_json = ?')
      params.push(
        patch.endpoints === null ? null : JSON.stringify(patch.endpoints)
      )
    }
    if (patch.agentExpirySynced !== undefined) {
      sets.push('agent_expiry_synced = ?')
      params.push(patch.agentExpirySynced ? 1 : 0)
    }
    const result = this.db
      .prepare(`UPDATE instances SET ${sets.join(', ')} WHERE ${where}`)
      .run(...params, ...whereParams)
    return result.changes > 0
  }

  /**
   * Extend CAS: only succeeds while the row is still live with a future
   * deadline. The deadline is monotonic (`MAX(old, new)`) so competing or
   * out-of-order extension pushes can never shorten an instance's life.
   * The reaper races this in another transaction; exactly one wins.
   */
  updateExpiry(
    id: string,
    from: readonly InstanceState[],
    expiresAtMs: number,
    now: number
  ): boolean {
    this.assertOpen()
    if (from.length === 0) return false
    const result = this.db
      .prepare(
        `UPDATE instances
         SET expires_at_ms = MAX(expires_at_ms, ?), updated_at_ms = ?,
             agent_expiry_synced = 0, revision = revision + 1
         WHERE id = ? AND state IN (${placeholders(from.length)})
           AND expires_at_ms > ?`
      )
      .run(expiresAtMs, now, id, ...from, now)
    return result.changes > 0
  }

  /** Mark the agent's deadline as synced only if no newer extend changed it. */
  setExpirySyncedFor(
    id: string,
    expiresAtMs: number,
    synced: boolean
  ): boolean {
    this.assertOpen()
    return (
      this.db
        .prepare(
          `UPDATE instances SET agent_expiry_synced = ?, revision = revision + 1
           WHERE id = ? AND expires_at_ms = ?`
        )
        .run(synced ? 1 : 0, id, expiresAtMs).changes > 0
    )
  }

  /** Claim an expired running row for deletion; returns false if it was extended first. */
  claimExpiredRunning(id: string, now: number): boolean {
    this.assertOpen()
    return (
      this.db
        .prepare(
          `UPDATE instances
           SET state = 'deleting', updated_at_ms = ?, revision = revision + 1
           WHERE id = ? AND state = 'running' AND expires_at_ms <= ?`
        )
        .run(now, id, now).changes > 0
    )
  }

  // ---- reservations -----------------------------------------------------

  reservedByHost(): Map<string, Reserved> {
    this.assertOpen()
    const rows = this.db
      .prepare(
        `SELECT host_id,
                COALESCE(SUM(vcpus), 0) AS vcpus,
                COALESCE(SUM(mem_mib), 0) AS mem_mib,
                COALESCE(SUM(disk_mib), 0) AS disk_mib,
                COUNT(*) AS instances
         FROM instances
         WHERE state IN (${placeholders(LIVE_STATES.length)})
         GROUP BY host_id`
      )
      .all(...LIVE_STATES) as {
      host_id: string
      vcpus: number
      mem_mib: number
      disk_mib: number
      instances: number
    }[]
    const result = new Map<string, Reserved>()
    for (const row of rows) {
      result.set(row.host_id, {
        vcpus: row.vcpus,
        memMiB: row.mem_mib,
        diskMiB: row.disk_mib,
        instances: row.instances,
      })
    }
    return result
  }

  reservedForHost(hostId: string): Reserved {
    this.assertOpen()
    return this.reservedByHost().get(hostId) ?? EMPTY_RESERVED
  }

  // ---- host loss --------------------------------------------------------

  /**
   * Write off every live row pinned to a lost host: the unique key is freed
   * (state `lost` is not live) and the reservation is released. The rows stay
   * as tombstones so the reconciler can delete the agent side when it returns.
   */
  writeOffHost(hostId: string, now: number): string[] {
    this.assertOpen()
    return this.transaction(() => this.writeOffHostUnsafe(hostId, now))
  }

  private writeOffHostUnsafe(hostId: string, now: number): string[] {
    this.assertOpen()
    const rows = this.db
      .prepare(
        `SELECT ${INSTANCE_COLUMNS} FROM instances
         WHERE host_id = ? AND state IN (${placeholders(LIVE_STATES.length)})`
      )
      .all(hostId, ...LIVE_STATES) as InstanceDbRow[]
    const ids: string[] = []
    for (const row of rows) {
      const result = this.db
        .prepare(
          `UPDATE instances
           SET state = 'lost', updated_at_ms = ?, revision = revision + 1,
               message = 'host lost'
           WHERE id = ? AND state = ?`
        )
        .run(now, row.id, row.state)
      if (result.changes > 0) ids.push(row.id)
    }
    return ids
  }
}
