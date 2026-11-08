import * as z from 'zod/mini'

/** Owner: track 2 (VM). Extend freely; keep the export names. */
export const vmConfigSchema = z.object({
  firecrackerBin: z.optional(
    z.prefault(z.string(), '/usr/local/bin/firecracker')
  ),
  jailerBin: z.optional(z.prefault(z.string(), '/usr/local/bin/jailer')),
  /** Each image: <imagesDir>/<name>/{vmlinux,rootfs.ext4}. Read-only for the agent. */
  imagesDir: z.optional(
    z.prefault(z.string(), '/var/lib/rctf-firecracker/images')
  ),
  /** Per-instance writable data and jail roots. Must be on a reflink-capable fs for fast copies. */
  runDir: z.optional(z.prefault(z.string(), '/var/lib/rctf-firecracker/run')),
  mode: z.optional(z.prefault(z.enum(['jailer', 'direct']), 'jailer')),
})
export type VmConfig = z.output<typeof vmConfigSchema>
