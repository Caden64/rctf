# Firecracker guest image contract (v1)

One Firecracker microVM per team, booted from a prebuilt kernel and ext4
rootfs. This directory contains the reference guest pieces:

| File              | Purpose                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `init`            | POSIX sh PID 1: mounts pseudo-filesystems, fetches MMDS, runs the service |
| `build-rootfs.sh` | Unprivileged `rootfs.ext4` builder (Docker/OCI export + `mkfs.ext4 -d`)   |
| `README.md`       | This contract                                                             |

The host-side driver lives in `apps/firecracker-instancer/src/agent/vm`.

## Image layout

```text
<imagesDir>/
  web-demo/
    vmlinux        # uncompressed (or bzImage-compatible) kernel
    rootfs.ext4    # ext4 image, at most the challenge's diskMiB
    initrd         # optional initramfs
```

`imagesDir`, every image directory and their non-sticky ancestors must not be
group/world-writable, and must be owned by root or the agent uid. `vmlinux` and
`rootfs.ext4` must be regular files and must not be group/other-writable
(preflight check `imagesTrusted`; `allowUntrustedImages` is a development-only
escape hatch). Image names must match `^[a-z0-9][a-z0-9._-]{0,62}$`, all files
are resolved with `realpath`, and both the directory and each file must stay
below `realpath(imagesDir)`; symlink escapes are rejected. The base image is
read only: each instance gets a reflink/copy at `<runDir>/<instanceId>/rootfs.ext4`
(mode 0600) and Firecracker opens only that copy read-write.

## Boot contract

The kernel command line is exactly:

```text
console=ttyS0 reboot=k panic=1 pci=off ip=<guestIp>::<hostIp>:255.255.255.252::eth0:off init=/rctf/init [extra kernelArgs]
```

`init=/rctf/init` is emitted by the driver from `defaultInit` (configurable)
**before** the challenge's `kernelArgs`, so a later `init=` in `kernelArgs`
wins.

- `<guestIp>` is the guest side of a dedicated /30 (`<hostIp>` is the host side,
  e.g. `10.200.0.2` and `10.200.0.1`).
- The kernel must autoconfigure `eth0` from `ip=` (`CONFIG_IP_PNP`).
- There is exactly one NIC, Firecracker device id `eth0`; MMDS is bound to it.
- There is no vsock and no virtio-fs: the guest talks to Firecracker's MMDS
  endpoint only.

After boot, `/rctf/init` (selected by `init=`) fetches the MMDS metadata
document. The document is **V2**-only:

1. `PUT /latest/api/token` with `X-metadata-token-ttl-seconds: 21600`
   (answered with the token in the body).
2. `GET /` with `X-metadata-token: <token>` and
   `Accept: application/json`.

A route to `169.254.169.254/32` via `eth0` is required because the guest
address is a /30. Firecracker answers this endpoint itself, so it is not
reachable through the host network stack.

### Metadata schema

```json
{
  "rctf": {
    "version": 1,
    "instanceId": "0123456789abcdef",
    "hostname": "myapp-0123456789abcdef.fc1.example.com",
    "env": { "CHALLENGE": "web-demo" },
    "flags": [{ "provider": "main", "flag": "flag{...}" }]
  }
}
```

- `env` is non-secret and is exported to the service. Keys beginning with
  `RCTF_` are reserved for init: they are skipped (and logged) so challenge
  config can never spoof `RCTF_FLAGS_DIR`/`RCTF_INSTANCE_ID`/`RCTF_HOSTNAME`.
  The environment is sourced only in the service's subshell, so a challenge key
  such as `FLAGS_DIR` cannot overwrite init's own state either.
- `flags` are secrets. `init` writes each one to
  `/run/rctf/flags/<sanitised provider>` with mode 0400 on a tmpfs, and never
  to the ext4 rootfs. Provider names are sanitised (`[^A-Za-z0-9._-]` → `_`);
  on collision the index is appended (`name.<index>`) so two providers can
  never overwrite each other, and a name that sanitises to empty is rejected
  (the service is not started). Each value is written with `jq -j` by index, so
  backslashes, tabs, newlines, quotes and unicode survive byte-for-byte. The
  service reads the file/directory from `$RCTF_FLAGS_DIR`.
- Before writing any flag, `init` checks `/proc/mounts` that `/run` really is a
  tmpfs. If it is not, no flags are written and the service is **not** started
  (`init` exits non-zero) instead of leaking flags onto the rootfs.
- The document is delivered over the Firecracker API (`PUT /mmds`) only. The
  driver never logs it, never writes it to disk, and never puts it on the
  kernel command line or a drive.

### Service

`init` exports:

- `RCTF_FLAGS_DIR` (e.g. `/run/rctf/flags`),
- `RCTF_INSTANCE_ID`, `RCTF_HOSTNAME`,
- every non-reserved key from `rctf.env`, and sets the hostname.

Then it `exec`s the first of:

1. `$RCTF_SERVICE` (from init's own environment, not challenge metadata),
2. `/app/start`,
3. `/sbin/rctf-service`,
4. `/etc/rctf/service`,
5. `/bin/sh`.

`init` requires `jq` in the image (see the builder's `--jq` option). Without
it, the service still starts but flags cannot be parsed. `nc` is used for MMDS
unless `curl` is present; the `nc` path builds a strict HTTP/1.1 request with
real CRLF header terminators and only accepts a `200` status line.

## Kernel requirements

Build the kernel without modules (or ship the modules inside the initramfs):

- `CONFIG_IP_PNP=y` (and normal IPv4 `CONFIG_INET=y`),
- virtio-mmio (Firecracker is `pci=off`): `CONFIG_VIRTIO_MMIO=y`,
  `CONFIG_VIRTIO_BLK=y`, `CONFIG_VIRTIO_NET=y`,
- `CONFIG_EXT4_FS=y` (root filesystem),
- `CONFIG_TMPFS=y`, `CONFIG_DEVTMPFS=y`, `CONFIG_PROC_FS=y`,
  `CONFIG_SYSFS=y`,
- `CONFIG_SERIAL_8250=y`, `CONFIG_SERIAL_8250_CONSOLE=y` (console `ttyS0`),
- `CONFIG_BLK_DEV_INITRD=y` only if the image has an `initrd`,
- an `init` in the rootfs (or `CONFIG_DEFAULT_INIT`).

`panic=1` reboots the VM one second after a kernel panic; `reboot=k` makes a
guest reboot syscall restart the VM instead of powering off. The driver emits
`init=/rctf/init` before the challenge's extra kernel args; a later `init=`
there overrides it, so a missing `/rctf/init` yields a kernel panic loop.

## Building rootfs.ext4 without root

`mkfs.ext4 -d` populates an ext4 image from a directory without loop-mounting.
The script uses a container engine only to unpack the OCI image (`export`),
never to run it:

```sh
# From an OCI/Docker image; includes jq from the host if you pass a static one.
./build-rootfs.sh \
  --image debian:bookworm-slim \
  --size 512M \
  --jq /usr/bin/jq \
  --out /srv/rctf-firecracker/images/web-demo/rootfs.ext4

# From a prepared rootfs directory instead.
./build-rootfs.sh --dir ./my-rootfs --size 1G --out ./rootfs.ext4
```

The script installs `init` as `/rctf/init` and creates `/proc`, `/sys`,
`/dev`, `/run`, `/tmp` and `/etc`. It needs e2fsprogs >= 1.47 for `mkfs.ext4
-d`, plus `truncate`, `realpath` and `tar`. No `sudo`, `losetup`, `mount` or
chroot is used.

Installs go **only** to `/rctf/init` and `/rctf/jq` (never through
source-controlled paths like `/sbin/init`). Any `/rctf` entry in the copied
source tree is removed first — a symlink is unlinked, never followed — and the
script re-creates `/rctf` as a real directory. Before every write it verifies
with `realpath`/`[ -L ]` that the target is inside the staging root.

> **Security:** never run the builder as root on an untrusted source image or
> directory. A malicious source can still attack through the extraction tools;
> the staging-path checks only prevent this script from writing host files
> through symlinks.

Build the kernel separately (e.g. with `make ARCH=x86_64` and the config
above); Firecracker does not build kernels for you.

## Sample tiny HTTP challenge

Image layout:

```text
<imagesDir>/web-demo/
  vmlinux
  rootfs.ext4
```

Inside the rootfs, `/app/start` is an executable served as PID 1 by `init`:

```sh
#!/bin/sh
# Very small static HTTP service: expose the flag on :8080.
set -eu
mkdir -p /www
cp "$RCTF_FLAGS_DIR/main" /www/flag.txt
chmod 0644 /www/flag.txt
exec httpd -f -p 8080 -h /www
```

The challenge config then uses `image: web-demo`, `readiness: { kind: "tcp",
port: 8080 }` (or an HTTP probe of `/flag.txt`) and one `expose` entry for
guest port 8080. `init`'s MMDS loop starts the service only after flags are
written, so the port opens with the flag already available.

## Security notes

- Guest is untrusted. In jailer mode (the default) Firecracker runs under the
  jailer with a dedicated uid/gid, a chroot, cgroup v2, a new pid namespace,
  `RLIMIT_FSIZE`/`RLIMIT_NOFILE`, and Firecracker's default seccomp level. Disk
  and network rate limiters are configured over the API. The effective `fsize`
  limit is raised to at least the instance's reserved disk so guest rootfs
  writes are not truncated; cgroup v2 child creation is opt-in through
  `cgroupLimits` because jailer only creates one when a `--cgroup` value is
  supplied.
- With `--new-pid-ns` the jailer exits after forking Firecracker, so the driver
  reads Firecracker's host pid from
  `<jailRoot>/<firecracker basename>.pid` (jailer's documented pid file) and
  tracks that process, not the short-lived jailer parent.
- `mode: "direct"` skips all of that (no chroot/uid/cgroup/pid ns) and is for
  development only; the driver logs a prominent warning and you should never
  use it in production.
- Flags exist only in the request buffer, Firecracker's MMDS, and the guest's
  tmpfs. They are never on a kernel command line, a drive, a host file, or an
  agent log.

## Verification status

Covered by the automated tests in
`apps/firecracker-instancer/test/vm` (fake Firecracker over a unix socket):

- image/path validation and symlink-escape rejection, image trust
  (`imagesTrusted`, group/world-writable and ownership checks),
- API call order and payloads, rate limiters, MMDS payload,
- no flag on argv/logs/files under `runDir` (including a `/mmds` 400 that
  echoes the request body and a fetch exception containing the flag),
- rollback after failures at every launch step (including a jailer that forks
  Firecracker but never writes its pid file),
- strict pid identity (`/proc/<pid>/exe` basename + adjacent `--id <id>`,
  start ticks) for liveness, adopt, stop/destroy and rollback; unrelated
  processes that merely mention firecracker are never signalled,
- stale run/jail/cgroup state and jail-only/cgroup-only orphans,
- idempotent stop/destroy, canonical (realpath) binary/jail layout,
- readiness (TCP/HTTP, timeout, abort, VM death, probe-succeeded-then-died),
  and API socket readiness as a successful connect rather than file existence,
- guest init: strict CRLF HTTP fallback and 200-only bodies, tmpfs check
  before flags, byte-exact flag files and collision naming,
- `build-rootfs.sh`: no writes through source-controlled symlinks and only
  `/rctf/init` + `/rctf/jq`.

**Verified against the real thing** (unprivileged, `../smoke/`, Firecracker v1.17.0, kernel 6.1.155,
busybox 1.35.0, static jq): a real KVM boot of this `init` and of an image produced by
`build-rootfs.sh --dir`, including the MMDS v2 token and document fetch through the busybox `nc` fallback,
byte-exact flag delivery to a tmpfs, and teardown. That run found and fixed two real bugs in this directory:
the token `PUT` needs `Content-Length: 0`, and `/rctf` must be on `PATH` so the bundled `/rctf/jq` is found.

**Not verified:** the `curl` path of `init` (the test image has no curl), `build-rootfs.sh --image`
(container export), `mkfs.ext4 -d` on your distribution, other kernel configs, and jailer mode. Treat the
guest examples as a documented reference and boot one of your own images on a real host before an event.
