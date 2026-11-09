import * as z from 'zod/mini'
import { flagSchema } from './common'

/**
 * Guest boot contract, version 1.
 *
 * The agent publishes this JSON through Firecracker's MMDS (V2, token
 * required) bound to the guest's single NIC. The guest init fetches it from
 * http://169.254.169.254/ with `Accept: application/json` and is responsible
 * for exporting flags/env to the challenge service. Flags are NEVER put on the
 * kernel command line, a drive, or a host file.
 */
export const GUEST_METADATA_VERSION = 1

export const guestMetadataSchema = z.object({
  rctf: z.object({
    version: z.literal(GUEST_METADATA_VERSION),
    instanceId: z.string(),
    hostname: z.string(),
    env: z.record(z.string(), z.string()),
    flags: z.array(flagSchema),
  }),
})
export type GuestMetadata = z.output<typeof guestMetadataSchema>
