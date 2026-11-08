import { readFile } from 'node:fs/promises'
import yaml from 'yaml'
import { createLogger } from '../log'
import { agentConfigSchema, type AgentConfig } from './config'
import { createInstanceManager } from './manager'
import { createNetworkManager } from './net'
import { createAgentServer } from './server'
import { createVmDriver } from './vm'
import { vmConfigSchema } from './vm/config'

/**
 * Load the agent YAML config. `FIRECRACKER_AGENT_TOKEN` overrides the token in
 * the file (the recommended deployment hides it from disk).
 */
export const loadAgentConfig = async (file: string): Promise<AgentConfig> => {
  const source = await readFile(file, 'utf8')
  const config = agentConfigSchema.parse(yaml.parse(source))
  const envToken = process.env.FIRECRACKER_AGENT_TOKEN
  if (envToken) config.token = envToken
  if (!config.token) {
    throw new Error(
      'agent token is required (config.token or FIRECRACKER_AGENT_TOKEN)'
    )
  }
  return config
}

export const runAgent = async (configPath: string): Promise<void> => {
  const logger = createLogger('firecracker-agent')
  const config = await loadAgentConfig(configPath)
  const vm = createVmDriver(config.vm ?? vmConfigSchema.parse({}), { logger })
  const net = createNetworkManager(config.network, { logger })

  try {
    const vmPreflight = await vm.preflight()
    logger.info(vmPreflight, 'vm preflight')
  } catch (err) {
    logger.error(
      { errorType: err instanceof Error ? err.name : typeof err },
      'vm preflight failed'
    )
  }
  try {
    const netChecks = await net.preflight()
    logger.info({ checks: netChecks }, 'network preflight')
  } catch (err) {
    logger.error(
      { errorType: err instanceof Error ? err.name : typeof err },
      'network preflight failed'
    )
  }

  const manager = createInstanceManager({ config, vm, net, logger })
  await manager.start()
  const agent = createAgentServer({ config, manager, logger })

  logger.info(
    {
      hostId: config.hostId,
      listen: config.listen ?? { host: '127.0.0.1', port: 7001 },
    },
    'firecracker agent listening'
  )

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    const timeoutMs = (config.shutdownTimeoutSeconds ?? 15) * 1000
    logger.info(
      { signal, timeoutMs },
      'shutting down agent (running VMs are left alone)'
    )
    try {
      // Stop accepting first, then drain HTTP requests and manager work; both
      // are bounded by the same deadline. VMs are never destroyed here.
      await Promise.allSettled([agent.stop(timeoutMs), manager.stop()])
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
}

if (import.meta.main) {
  const configPath =
    process.env.FIRECRACKER_AGENT_CONFIG ?? process.argv[2] ?? undefined
  if (!configPath) {
    console.error(
      'usage: bun src/agent/index.ts <config.yaml> (or set FIRECRACKER_AGENT_CONFIG)'
    )
    process.exit(1)
  }
  runAgent(configPath).catch(err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
