import type { CommandRunner, VmDriver } from '../../interfaces'
import type { Logger } from '../../log'
import type { VmConfig } from './config'

/** Owner: track 2. STUB — replace the body, keep the signature. */
export const createVmDriver = (
  _config: VmConfig,
  _deps?: { runner?: CommandRunner; logger?: Logger }
): VmDriver => {
  throw new Error('createVmDriver: not implemented')
}
