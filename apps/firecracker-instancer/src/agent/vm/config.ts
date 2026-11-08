import * as z from 'zod/mini'

/**
 * Owner: track 2 (VM). Extend freely; keep the export names.
 *
 * Everything here is host-local: the base images are read-only, per-instance
 * writable state lives below `runDir`, and (in jailer mode) Firecracker runs
 * chrooted below `chrootBase`.
 *
 * `z.prefault` (without an extra `z.optional`) keeps the parsed output fully
 * populated while still allowing `{}` as input.
 */
export const vmConfigSchema = z.object({
  firecrackerBin: z.prefault(z.string(), '/usr/local/bin/firecracker'),
  jailerBin: z.prefault(z.string(), '/usr/local/bin/jailer'),
  /** Each image: <imagesDir>/<name>/{vmlinux,rootfs.ext4[,initrd]}. Read-only for the agent. */
  imagesDir: z.prefault(z.string(), '/var/lib/rctf-firecracker/images'),
  /** Per-instance writable data and jail roots. Must be on a reflink-capable fs for fast copies. */
  runDir: z.prefault(z.string(), '/var/lib/rctf-firecracker/run'),
  mode: z.prefault(z.enum(['jailer', 'direct']), 'jailer'),
  /** Jailer identity the Firecracker process drops to. */
  jailUid: z.prefault(z.int(), 10000),
  jailGid: z.prefault(z.int(), 10000),
  /**
   * Jailer `--chroot-base-dir`. The actual jail for an instance is
   * `<chrootBase>/<firecracker basename>/<instanceId>` (jailer's own layout)
   * with the chroot root in its `root/` subdirectory.
   */
  chrootBase: z.prefault(z.string(), '/srv/jailer'),
  /** cgroup v2 mount root; jailer creates `<cgroupRoot>/<id>` (or under parentCgroup). */
  cgroupRoot: z.prefault(z.string(), '/sys/fs/cgroup'),
  /**
   * Jailer cgroup placement. With cgroup v2 the jailer only creates a child
   * cgroup when at least one `--cgroup` value is given; `cgroupLimits` holds
   * `<file>=<value>` pairs (e.g. `pids.max=512`). `parentCgroup` defaults to
   * the Firecracker binary name (jailer's default).
   */
  parentCgroup: z.optional(z.string().check(z.regex(/^[A-Za-z0-9_.-]+$/))),
  cgroupLimits: z.prefault(
    z.array(z.string().check(z.regex(/^[A-Za-z0-9_.-]+=[A-Za-z0-9:._-]+$/))),
    []
  ),
  /**
   * Jailer RLIMIT_FSIZE floor (per instance the driver uses at least
   * `diskMiB` so guest rootfs writes are never truncated) and RLIMIT_NOFILE.
   */
  fsizeLimitBytes: z.prefault(z.int(), 64 * 1024 * 1024),
  noFileLimit: z.prefault(z.int(), 1024),
  /** Disk rate limiter (per second). */
  diskIops: z.prefault(z.int(), 4000),
  diskBandwidthMiBps: z.prefault(z.int(), 200),
  /** Per-NIC rate limiter (per second). */
  netBandwidthMiBps: z.prefault(z.int(), 100),
  netPps: z.prefault(z.int(), 20000),
  /** HTTP budget for one Firecracker API call. */
  apiTimeoutMs: z.prefault(z.int(), 5000),
  /** How long Firecracker may take to create its API unix socket. */
  apiStartTimeoutMs: z.prefault(z.int(), 5000),
  /** Readiness probe retry interval. */
  readinessIntervalMs: z.prefault(z.int(), 500),
  /** How long to wait for a SIGKILLed process to disappear from /proc. */
  killWaitMs: z.prefault(z.int(), 5000),
  /** Refuse world-writable base image dirs (a local user could swap the rootfs). */
  forbidWorldWritableImages: z.prefault(z.boolean(), true),
})
export type VmConfig = z.output<typeof vmConfigSchema>
