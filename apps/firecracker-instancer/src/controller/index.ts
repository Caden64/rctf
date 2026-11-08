import { createLogger } from '../log'
import { loadControllerConfig } from './config'
import { createControllerServer } from './server'
import { createControllerService } from './service'

const logger = createLogger('firecracker-controller')

const resolveConfigPath = (): string | undefined =>
  process.env.FIRECRACKER_CONTROLLER_CONFIG ?? process.argv[2]

const main = async (): Promise<void> => {
  const configPath = resolveConfigPath()
  if (!configPath) {
    throw new Error(
      'Usage: FIRECRACKER_CONTROLLER_CONFIG=/path/to/controller.yml bun src/controller/index.ts [config.yml]'
    )
  }

  const config = loadControllerConfig(configPath)
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
      // Stop accepting new requests immediately, give in-flight create/delete
      // bookkeeping a bounded time to finish, then force-close whatever is
      // left. `http.stop()` is NOT awaited first: it only resolves once every
      // active request is done, which would bypass the drain deadline.
      void http.stop()
      await server.drain(30_000)
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
