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

`imagesDir` and every image directory must not be world-writable. Image names
must match `^[a-z0-9][a-z0-9._-]{0,62}$`, all files are resolved with
`realpath`, and both the directory and each file must stay below
`realpath(imagesDir)`; symlink escapes are rejected. The base image is read
only: each instance gets a reflink/copy at `<runDir>/<instanceId>/rootfs.ext4`
(mode 0600) and Firecracker opens only that copy read-write.

## Boot contract

The kernel command line is exactly:

```text
console=ttyS0 reboot=k panic=1 pci=off ip=<guestIp>::<hostIp>:255.255.255.252::eth0:off [extra kernelArgs]
```

- `<guestIp>` is the guest side of a dedicated /30 (`<hostIp>` is the host side,
  e.g. `10.200.0.2` and `10.200.0.1`).
- The kernel must autoconfigure `eth0` from `ip=` (`CONFIG_IP_PNP`).
- There is exactly one NIC, Firecracker device id `eth0`; MMDS is bound to it.
- There is no vsock and no virtio-fs: the guest talks to Firecracker's MMDS
  endpoint only.

After boot, `/sbin/init` (the kernel default; `init=` is not set) fetches the
MMDS metadata document. The document is **V2**-only:

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

- `env` is non-secret and is exported to the service.
- `flags` are secrets. `init` writes each one to
  `/run/rctf/flags/<sanitised provider>` with mode 0400 on a tmpfs, and never
  to the ext4 rootfs. The service reads the file/directory from
  `$RCTF_FLAGS_DIR`.
- The document is delivered over the Firecracker API (`PUT /mmds`) only. The
  driver never logs it, never writes it to disk, and never puts it on the
  kernel command line or a drive.

### Service

`init` exports:

- `RCTF_FLAGS_DIR` (e.g. `/run/rctf/flags`),
- `RCTF_INSTANCE_ID`, `RCTF_HOSTNAME`,
- every key from `rctf.env`, and sets the hostname.

Then it `exec`s the first of:

1. `$RCTF_SERVICE` (may also come from the metadata env),
2. `/app/start`,
3. `/sbin/rctf-service`,
4. `/etc/rctf/service`,
5. `/bin/sh`.

`init` requires `jq` in the image (see the builder's `--jq` option). Without
it, the service still starts but flags cannot be parsed. `nc` is used for MMDS
unless `curl` is present.

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
guest reboot syscall restart the VM instead of powering off. The driver never
sets `init=`, so a missing `/sbin/init` yields a kernel panic loop.

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

The script installs `init` as `/sbin/init` and creates `/proc`, `/sys`,
`/dev`, `/run`, `/tmp` and `/etc`. It needs e2fsprogs >= 1.47 for `mkfs.ext4
-d`, plus `truncate` and `tar`. No `sudo`, `losetup`, `mount` or chroot is
used.

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

- image/path validation and symlink-escape rejection,
- API call order and payloads, rate limiters, MMDS payload,
- no flag on argv/logs/files under `runDir`,
- rollback after failures at every launch step,
- pid-reuse-safe liveness, adopt/list, idempotent stop/destroy,
- readiness (TCP/HTTP, timeout, abort, VM death).

**Not verified here:** a real KVM boot of this `init`/builder combination,
jailer's exact chroot/cgroup layout on a target host, kernel config selection,
and `mkfs.ext4 -d`/container export on your distribution. Treat the guest
examples as a documented reference: boot one image on a real KVM host and
check `/var/log`/serial output before relying on it in production.
