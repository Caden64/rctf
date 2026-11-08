import type { ControllerService, AgentClient, Clock } from '../interfaces'
import type { Logger } from '../log'
import type { ControllerConfig } from './config'

/** Owner: track 5. STUB — replace the body, keep the signature. */
export const createControllerService = (
  _config: ControllerConfig,
  _deps?: {
    /** hostId -> client. Defaults to HttpAgentClient per configured host. */
    clients?: Record<string, AgentClient>
    now?: Clock
    logger?: Logger
    /** Instance id generator (random lowercase base36, 24 chars by default). */
    newId?: () => string
  }
): ControllerService => {
  throw new Error('createControllerService: not implemented')
}
