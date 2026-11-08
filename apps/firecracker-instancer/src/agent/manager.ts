import type {
  Clock,
  InstanceManager,
  NetworkManager,
  VmDriver,
} from '../interfaces'
import type { Logger } from '../log'
import type { AgentConfig } from './config'

/** Owner: track 4. STUB — replace the body, keep the signature. */
export const createInstanceManager = (_deps: {
  config: AgentConfig
  vm: VmDriver
  net: NetworkManager
  now?: Clock
  logger?: Logger
}): InstanceManager => {
  throw new Error('createInstanceManager: not implemented')
}
