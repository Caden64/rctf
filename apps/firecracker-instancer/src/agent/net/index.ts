import type { CommandRunner, NetworkManager } from '../../interfaces'
import type { Logger } from '../../log'
import type { NetworkConfig } from './config'

/** Owner: track 3. STUB — replace the body, keep the signature. */
export const createNetworkManager = (
  _config: NetworkConfig,
  _deps?: { runner?: CommandRunner; logger?: Logger }
): NetworkManager => {
  throw new Error('createNetworkManager: not implemented')
}
