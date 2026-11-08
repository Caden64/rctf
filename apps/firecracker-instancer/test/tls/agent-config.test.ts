import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { loadAgentConfig } from '../../src/agent/index'
import { createAgentServer } from '../../src/agent/server'
import type { InstanceManager } from '../../src/interfaces'
import { makeConfig } from '../agent/fakes'
import {
  cleanupDir,
  installFixtures,
  testDir,
  type FixturePaths,
} from './helpers'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) cleanupDir(dirs.pop()!)
})

const setup = (): FixturePaths => {
  const dir = testDir()
  dirs.push(dir)
  return installFixtures(dir)
}

const managerStub = (): InstanceManager =>
  ({
    info: async () => ({
      version: 'test',
      hostId: 'host1',
      timeMs: Date.now(),
      capacity: { vcpus: 1, memMiB: 1, diskMiB: 1, maxInstances: 1 },
      usage: { vcpus: 0, memMiB: 0, diskMiB: 0, instances: 0 },
      accepting: true,
      checks: {},
      images: [],
    }),
  }) as unknown as InstanceManager

const writeAgentConfig = (
  dir: string,
  tls: Record<string, unknown> | undefined
): string => {
  const file = join(dir, 'agent.yaml')
  writeFileSync(
    file,
    JSON.stringify({
      hostId: 'host1',
      token: 'agent-token',
      stateDir: join(dir, 'state'),
      capacity: { vcpus: 1, memMiB: 1, diskMiB: 1, maxInstances: 1 },
      network: { publicHost: 'fc.example.com', httpDomain: 'fc.example.com' },
      ...(tls === undefined ? {} : { tls }),
    })
  )
  return file
}

describe('agent TLS config', () => {
  test('loads and validates the tls block at config load time', async () => {
    const paths = setup()
    const config = await loadAgentConfig(
      writeAgentConfig(paths.dir, {
        certFile: paths.serverCert,
        keyFile: paths.serverKey,
        caFile: paths.caCert,
      })
    )
    expect(config.tlsMaterial?.cert).toContain('BEGIN CERTIFICATE')
    expect(config.tlsMaterial?.key).toContain('PRIVATE KEY')
    expect(config.tlsMaterial?.ca).toContain('BEGIN CERTIFICATE')
  })

  test('fails before startup on a missing certificate file', async () => {
    const paths = setup()
    await expect(
      loadAgentConfig(
        writeAgentConfig(paths.dir, {
          certFile: join(paths.dir, 'missing.crt'),
          keyFile: paths.serverKey,
        })
      )
    ).rejects.toThrow(/cannot read certificate .*missing\.crt/)
  })

  test('fails before startup on a world-readable private key', async () => {
    const paths = setup()
    chmodSync(paths.serverKey, 0o644)
    await expect(
      loadAgentConfig(
        writeAgentConfig(paths.dir, {
          certFile: paths.serverCert,
          keyFile: paths.serverKey,
        })
      )
    ).rejects.toThrow(/private key .*group\/world-accessible/)
  })

  test('the listener refuses to start with invalid TLS material', () => {
    const paths = setup()
    const config = makeConfig(paths.dir, {
      tls: {
        certFile: join(paths.dir, 'missing.crt'),
        keyFile: paths.serverKey,
      },
    })
    expect(() => createAgentServer({ config, manager: managerStub() })).toThrow(
      /cannot read certificate .*missing\.crt/
    )
  })
})
