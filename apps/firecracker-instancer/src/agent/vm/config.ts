import * as z from 'zod/mini'

const CGROUP_SEGMENT = '[A-Za-z0-9_.-]+'
/** Relative cgroup path: safe segments separated by `/`, never `.`/`..`, empty or absolute. */
const PARENT_CGROUP_REGEX = new RegExp(
  `^(?!\\.{1,2}(?:/|$))${CGROUP_SEGMENT}(?:/(?!\\.{1,2}(?:/|$))${CGROUP_SEGMENT})*$`
)
/** `<file>=<value>`; values may contain commas (cpuset lists) but no whitespace/shell metachars. */
const CGROUP_LIMIT_REGEX = /^[A-Za-z0-9_.-]+=[A-Za-z0-9:._,+-]+$/

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
  /**
   * Kernel `init=` path installed by `deploy/firecracker/guest/build-rootfs.sh`
   * (`/rctf/init`). It is emitted before the challenge's `kernelArgs`, so a
   * later `init=` in `kernelArgs` still wins.
   */
  defaultInit: z.prefault(
    z
      .string()
      .check(
        z.regex(
          /^\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]+)*$/
        )
      ),
    '/rctf/init'
  ),
  /** Jailer identity the Firecracker process drops to. */
  jailUid: z.prefault(z.int(), 10000),
  jailGid: z.prefault(z.int(), 10000),
  /**
   * Jailer `--chroot-base-dir`. The actual jail for an instance is
   * `<chrootBase>/<resolved firecracker basename>/<instanceId>` (jailer's own
   * layout) with the chroot root in its `root/` subdirectory.
   */
  chrootBase: z.prefault(z.string(), '/srv/jailer'),
  /** cgroup v2 mount root; jailer creates `<cgroupRoot>/<id>` (or under parentCgroup). */
  cgroupRoot: z.prefault(z.string(), '/sys/fs/cgroup'),
  /**
   * Jailer cgroup placement. With cgroup v2 the jailer only creates a child
   * cgroup when at least one `--cgroup` value is given; `cgroupLimits` holds
   * `<file>=<value>` pairs (e.g. `pids.max=512`, `cpuset.cpus=0,1,2`).
   * Nested relative paths such as `all_uvms/external_uvms` are allowed.
   * `parentCgroup` defaults to the Firecracker binary name (jailer's default).
   */
  parentCgroup: z.optional(z.string().check(z.regex(PARENT_CGROUP_REGEX))),
  cgroupLimits: z.prefault(
    z.array(z.string().check(z.regex(CGROUP_LIMIT_REGEX))),
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
  /**
   * Full image-trust enforcement: `imagesDir` (and its non-sticky ancestors)
   * plus the image dir must not be group/world-writable and must be owned by
   * root or the agent uid; `vmlinux`/`rootfs.ext4` must not be group/other
   * writable. Development escape hatch only.
   */
  allowUntrustedImages: z.prefault(z.boolean(), false),
})
export type VmConfig = z.output<typeof vmConfigSchema>
