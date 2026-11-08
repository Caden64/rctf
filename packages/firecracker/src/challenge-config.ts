import * as z from 'zod/mini'
import {
  ENV_NAME_REGEX,
  IMAGE_NAME_REGEX,
  KERNEL_ARGS_REGEX,
  portSchema,
} from './common'

export const readinessSchema = z.union([
  z.object({
    kind: z.literal('tcp'),
    port: portSchema,
  }),
  z.object({
    kind: z.literal('http'),
    port: portSchema,
    path: z.optional(
      z.prefault(z.string().check(z.regex(/^\/[\x21-\x7e]*$/)), '/')
    ),
    expectStatus: z.optional(
      z.prefault(z.int().check(z.gte(100), z.lte(599)), 200)
    ),
  }),
  z.object({ kind: z.literal('none') }),
])
export type Readiness = z.output<typeof readinessSchema>

/**
 * Challenge-author facing config: the contents of `instancerConfig.config`
 * for `instancers/firecracker`. One Firecracker microVM per team.
 *
 * `expose[].containerName` must be `app` and `expose[].containerPort` is the
 * guest TCP port to publish.
 */
export const firecrackerChallengeConfigSchema = z.object({
  image: z
    .string()
    .check(
      z.regex(IMAGE_NAME_REGEX, 'Invalid image name'),
      z.describe(
        'Image name: a directory under the host imagesDir containing vmlinux and rootfs.ext4'
      )
    ),
  vcpus: z
    .optional(z.prefault(z.int().check(z.gte(1), z.lte(8)), 1))
    .check(z.describe('Number of vCPUs')),
  memMiB: z
    .optional(z.prefault(z.int().check(z.gte(128), z.lte(16384)), 256))
    .check(z.describe('Guest memory in MiB')),
  diskMiB: z
    .optional(z.prefault(z.int().check(z.gte(64), z.lte(65536)), 1024))
    .check(
      z.describe(
        'Upper bound of per-instance writable disk in MiB (reserved for scheduling; the rootfs image must not be larger)'
      )
    ),
  kernelArgs: z
    .optional(
      z.string().check(z.regex(KERNEL_ARGS_REGEX, 'Invalid kernel args'))
    )
    .check(z.describe('Extra kernel command line arguments')),
  egress: z
    .optional(z.prefault(z.boolean(), false))
    .check(
      z.describe('Allow the guest outbound internet access (default: none)')
    ),
  bootTimeoutSeconds: z
    .optional(z.prefault(z.int().check(z.gte(5), z.lte(600)), 60))
    .check(z.describe('Max seconds to wait for readiness before erroring')),
  readiness: z
    .optional(readinessSchema)
    .check(
      z.describe(
        'Readiness probe. Defaults to a TCP probe of the first exposed port'
      )
    ),
  env: z
    .optional(
      z.prefault(
        z.record(z.string().check(z.regex(ENV_NAME_REGEX)), z.string()),
        {}
      )
    )
    .check(
      z.describe(
        'Non-secret environment passed to the guest init via MMDS (never put flags here)'
      )
    ),
})
export type FirecrackerChallengeConfig = z.output<
  typeof firecrackerChallengeConfigSchema
>
