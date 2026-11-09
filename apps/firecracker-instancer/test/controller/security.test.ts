import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'bun:test'
import { createControllerService } from '../../src/controller/service'
import {
  cleanupDir,
  FakeClock,
  FakeTimers,
  makeConfig,
  makeCreateRequest,
  makeHost,
  MemoryLogs,
  testDir,
} from './helpers'
import { FakeAgent } from './fake-agent'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) cleanupDir(dirs.pop()!)
})

describe('controller persistence security', () => {
  test('flags never reach SQLite (db + WAL) or logs', async () => {
    const dir = testDir()
    dirs.push(dir)
    const logs = new MemoryLogs()
    const clock = new FakeClock()
    const flag = 'FLAG{never-persist-this-flag-abcdef}'
    const agent = new FakeAgent('host-a', {
      vcpus: 8,
      memMiB: 4096,
      diskMiB: 4096,
      maxInstances: 10,
    })
    agent.setClock(clock.now)
    const config = makeConfig(dir, [makeHost('host-a')])
    const service = createControllerService(config, {
      clients: { 'host-a': agent },
      now: clock.now,
      logger: logs.asLogger(),
      timers: new FakeTimers(),
      newId: () => 'i' + 'a'.repeat(23),
    })
    try {
      // The host needs a successful clock sample before it accepts creates.
      await service.start()
      await service.create(
        makeCreateRequest('team-secret', {
          flags: [{ provider: 'rctf', flag }],
        })
      )
      // The agent saw the flag (MMDS path), but the controller must not store
      // or log it. The team id is never sent to the host either.
      expect(agent.createCalls[0]!.flags[0]!.flag).toBe(flag)
      expect(JSON.stringify(agent.createCalls[0])).not.toContain('team-secret')

      const db = new Database(config.databasePath!, { readonly: true })
      const dump = JSON.stringify(db.query('SELECT * FROM instances').all())
      const teamKey = (
        db.query('SELECT team_key FROM instances').get() as { team_key: string }
      ).team_key
      db.close()

      expect(dump).not.toContain(flag)
      expect(teamKey).not.toBe('team-secret')
      expect(teamKey).toMatch(/^[a-f0-9]{32}$/)

      const files = [config.databasePath!, `${config.databasePath!}-wal`]
      for (const file of files) {
        let bytes: Buffer
        try {
          bytes = readFileSync(file)
        } catch {
          continue
        }
        expect(bytes.indexOf(Buffer.from(flag))).toBe(-1)
      }
      expect(logs.lines.join('\n')).not.toContain(flag)
    } finally {
      await service.stop()
    }
  })
})
