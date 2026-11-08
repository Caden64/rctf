import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { createLogger } from '../log'
import { controllerConfigSchema } from './config'
import { createControllerServer } from './server'
import { createControllerService } from './service'

const logger = createLogger('firecracker-controller')

const resolveConfigPath = (): string | undefined =>
  process.env.FIRECRACKER_CONTROLLER_CONFIG ?? process.argv[2]

const loadConfig = (path: string) => {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Could not read the controller config at ${path}`)
  }

  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch {
    throw new Error(`Could not parse the controller config at ${path} as YAML`)
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`The controller config at ${path} must be a YAML mapping`)
  }

  // TODO(firecracker): switch to `loadControllerConfig` from `./config` once
  // track 5 lands it. Until then parse here and apply the documented env
  // overrides.
  const merged = {
    ...(raw as Record<string, unknown>),
    ...(process.env.FIRECRACKER_CONTROLLER_AUTH_TOKEN === undefined
      ? {}
      : { authToken: process.env.FIRECRACKER_CONTROLLER_AUTH_TOKEN }),
    ...(process.env.FIRECRACKER_CONTROLLER_ADMIN_TOKEN === undefined
      ? {}
      : { adminToken: process.env.FIRECRACKER_CONTROLLER_ADMIN_TOKEN }),
    ...(process.env.FIRECRACKER_TEAM_KEY_SECRET === undefined
      ? {}
      : { teamKeySecret: process.env.FIRECRACKER_TEAM_KEY_SECRET }),
  }

  return controllerConfigSchema.parse(merged)
}

const main = async (): Promise<void> => {
  const configPath = resolveConfigPath()
  if (!configPath) {
    throw new Error(
      'Usage: FIRECRACKER_CONTROLLER_CONFIG=/path/to/controller.yml bun src/controller/index.ts [config.yml]'
    )
  }

  const config = loadConfig(configPath)
  const listen = config.listen ?? { host: '127.0.0.1', port: 7000 }
  const service = createControllerService(config, { logger })
  const server = createControllerServer({
    service,
    authToken: config.authToken ?? '',
    adminToken: config.adminToken ?? '',
    logger,
  })

  await service.start()

  const http = server.serve(listen)
  logger.info(
    { host: listen.host, port: http.port },
    'firecracker controller listening'
  )

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    logger.info({ signal }, 'shutting down the firecracker controller')

    try {
      await http.stop(true)
    } catch (err) {
      logger.error({ err }, 'failed to stop the HTTP server')
    }
    try {
      await service.stop()
    } catch (err) {
      logger.error({ err }, 'failed to stop the controller service')
    }
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
}

if (import.meta.main) {
  main().catch(err => {
    logger.error({ err }, 'firecracker controller failed to start')
    process.exit(1)
  })
}
