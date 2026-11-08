import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { loadControllerConfig } from '../../src/controller/config'
import { cleanupDir, testDir } from './helpers'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) cleanupDir(dirs.pop()!)
})

describe('loadControllerConfig', () => {
  test('applies the documented environment overrides to a YAML file', () => {
    const dir = testDir()
    dirs.push(dir)
    const file = join(dir, 'controller.yaml')
    writeFileSync(
      file,
      [
        'databasePath: /tmp/opencode/file.sqlite',
        'teamKeySecret: from-file',
        'hosts:',
        '  - id: host-a',
        '    url: http://127.0.0.1:7001',
        '    token: file-token',
        '    capacity:',
        '      vcpus: 4',
        '      memMiB: 2048',
        '      diskMiB: 4096',
        '      maxInstances: 5',
      ].join('\n')
    )

    const config = loadControllerConfig(file, {
      FIRECRACKER_CONTROLLER_AUTH_TOKEN: 'api-token',
      FIRECRACKER_CONTROLLER_ADMIN_TOKEN: 'admin-token',
      FIRECRACKER_TEAM_KEY_SECRET: 'env-secret',
      FIRECRACKER_HOST_TOKEN_HOST_A: 'env-host-token',
    })

    expect(config.authToken).toBe('api-token')
    expect(config.adminToken).toBe('admin-token')
    expect(config.teamKeySecret).toBe('env-secret')
    expect(config.hosts[0]!.token).toBe('env-host-token')
    expect(config.hosts[0]!.capacity.maxInstances).toBe(5)
  })

  test('accepts an object and applies defaults', () => {
    const config = loadControllerConfig(
      {
        hosts: [
          {
            id: 'host-a',
            url: 'http://127.0.0.1:7001',
            capacity: {
              vcpus: 4,
              memMiB: 2048,
              diskMiB: 4096,
              maxInstances: 5,
            },
          },
        ],
      },
      {}
    )
    expect(config.overcommit).toEqual({ vcpu: 1, mem: 1 })
    expect(config.heartbeatIntervalSeconds).toBe(5)
    expect(config.hostLostSeconds).toBe(300)
    expect(config.reconcileIntervalSeconds).toBe(30)
    expect(config.createFenceSeconds).toBe(45)
    expect(config.maxClockSkewSeconds).toBe(10)
    expect(config.hostProbeTimeoutSeconds).toBe(10)
    expect(config.clockMaxRttSeconds).toBe(2)
    expect(config.clockSampleMaxAgeSeconds).toBe(60)
    expect(config.shutdownTimeoutSeconds).toBe(10)
  })

  test('applies create fence and clock skew environment overrides', () => {
    const config = loadControllerConfig(
      {
        hosts: [
          {
            id: 'host-a',
            url: 'http://127.0.0.1:7001',
            capacity: {
              vcpus: 4,
              memMiB: 2048,
              diskMiB: 4096,
              maxInstances: 5,
            },
          },
        ],
      },
      {
        FIRECRACKER_CREATE_FENCE_SECONDS: '90',
        FIRECRACKER_MAX_CLOCK_SKEW_SECONDS: '3',
      }
    )
    expect(config.createFenceSeconds).toBe(90)
    expect(config.maxClockSkewSeconds).toBe(3)
    expect(() =>
      loadControllerConfig(
        { hosts: [] },
        {
          FIRECRACKER_CREATE_FENCE_SECONDS: 'nope',
        }
      )
    ).toThrow()
  })

  test('rejects a config with no hosts', () => {
    expect(() => loadControllerConfig({ hosts: [] }, {})).toThrow()
  })
})
