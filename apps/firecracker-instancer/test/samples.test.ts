import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { firecrackerChallengeConfigSchema } from '@rctf/firecracker-protocol'
import { agentConfigSchema } from '../src/agent/config'
import { loadControllerConfig } from '../src/controller/config'

const root = new URL('../../../deploy/firecracker/', import.meta.url)
const load = (name: string) =>
  parse(readFileSync(new URL(name, root), 'utf8')) as Record<string, unknown>

describe('shipped example configs', () => {
  test('controller.example.yaml parses with the real loader', () => {
    const config = loadControllerConfig(load('controller.example.yaml'))
    expect(config.hosts.length).toBeGreaterThan(0)
  })

  test('agent.example.yaml parses with the real schema', () => {
    expect(
      agentConfigSchema.safeParse(load('agent.example.yaml')).success
    ).toBe(true)
  })

  test('sample-challenge.yaml config + expose satisfy the challenge schema', () => {
    const challenge = load('sample-challenge.yaml') as {
      instancerConfig: { config: unknown; expose: { containerName: string }[] }
    }
    expect(
      firecrackerChallengeConfigSchema.safeParse(
        challenge.instancerConfig.config
      ).success
    ).toBe(true)
    expect(challenge.instancerConfig.expose[0]?.containerName).toBe('app')
  })
})
