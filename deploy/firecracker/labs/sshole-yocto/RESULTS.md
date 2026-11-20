# sshole-yocto — results

## 2026-11-19 — full nested run on the development machine (FINAL, PASS)

Executed for real with `/dev/kvm` available; nothing privileged ran on the
host. All commands were run from
`deploy/firecracker/labs/sshole-yocto` on the `challenge/sshole-yocto` branch
(sha642b4813 + this lab).

- Host: Arch Linux, 16 CPUs, 54 GiB RAM, `/dev/kvm` rw, QEMU 11.1.3,
  e2fsprogs mkfs.ext4 with `-d`, ~1.7 TiB free disk.
- Command: `./selftest.sh` → **PASS (0 failures)**, exit 0.
- Command: `./run.sh` (fresh full path: fetch + bitbake + staging + assertions
  + nested-KVM verification) → **`SSHOLE_YOCTO RESULT: PASS`,
  33 passed, 0 failed**, exit 0, VM destroyed, overlay removed.
- Lab VM: fresh Ubuntu 24.04 cloud image under nested KVM, unique per-run
  `VM_DIR` (`~/.cache/rctf-sshole-yocto/vm/run-20261119-184138-134687`) and
  random host ports (ssh `127.0.0.1:…`, seed `127.0.0.1:…`); the vmtest
  default VM was not touched. Transcript:
  `~/.cache/rctf-sshole-yocto/logs/run-20261119-184138-134687.log`.
- Firecracker: v1.17.0 jailer mode; kernel `vmlinux-6.1.155` (shared smoke
  artifacts, pinned digests re-verified); agent HTTP API on `127.0.0.1:7101`
  inside the VM; checks run from the `fcoutside` netns against the published
  DNAT endpoints.

### Images built (unprivileged, genuine Yocto)

`./build.sh` ran the pinned `yocto-build.sh` (bitbake 2.18.0, poky
yocto-6.0.4 assembled from the three publisher `.sha256sum`-cross-checked
component tarballs, pinned buildtools-extended gcc 15.3.0/python 3.14.7
toolchain), unpacked each produced rootfs with `tar -xJf`, asserted the
binary-byte facts below, and wrote the ext4 images with
`../../guest/build-rootfs.sh --dir` (pinned static jq from `../smoke/`).
No container engine, no loop mount, no chroot, no root, and no guest binary
executed on the host.

| Image               | Size | rootfs.ext4 sha256 (this build)                                    | build-time facts asserted from bytes                                                                                                                                        |
| ------------------- | ---- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sshole-yocto-musl` | 256M | `eb3fc2095304bc7861e35f1c18ccfd41a44c470d3fe37770b270084e4aae2551`  | sshd banner `OpenSSH_10.3p1` (strings), interpreter `/lib/ld-musl-x86_64.so.1` (readelf), no PAM anywhere (`/etc/pam.d/sshd`, `libpam*`, sshd DT_NEEDED), `/etc/os-release` ID=poky VERSION_ID=6.0.4, `alice:*` / bob's pinned `$5$` hash (awk-exact), `/etc/shadow` 0400, no baked host keys |
| `sshole-yocto-glibc`| 256M | `a62e0b84d8569b5b269dd93a6d2265ca19b7f5c847f6deb1595e61ad8d8b02ce`  | same, plus glibc loader present and sshd interpreter `/lib64/ld-linux-x86-64.so.2`, no musl loader leaked                                                                          |

vmlinux for both: `e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2`
(shared smoke kernel). Bytes differ between rebuilds (mkfs UUID/timestamps);
the build-time assertions tie every image back to the pinned Yocto inputs,
and the running guest confirms its own build after login. Full manifest with
sizes and bitbake versions: `~/.cache/rctf-sshole-yocto/images/manifest.txt`
(written by build.sh; identical content is embedded in this record below).

Versions used (from `sshhole-versions.txt`, captured with
`bitbake-getvar --value`): bitbake 2.18.0, openssh 10.3p1, musl 1.2.6+git,
glibc 2.43+git, busybox 1.37.0, base-passwd 3.6.8, shadow 4.19.4,
DISTRO_VERSION 6.0.4. The upstream openssh tarball (sha256
`56682a36bb92dcf4b4f016fd8ec8e74059b79a8de25c15d670d731e7d18e45f4`) is
fetched and verified by bitbake against the stock recipe's pin;
`yocto-build.sh` re-asserts the recipe is still `openssh_10.3p1.bb` with that
digest and WITHOUT any `CVE-2026-123158` backport before every build.

### Checks observed (33 PASS, 0 FAIL)

Per instance, over the agent's published TCP endpoint from the `fcoutside`
netns with the system `ssh` + `SSH_ASKPASS_REQUIRE=force`:

| Check                                                         | yocto musl (vuln) | yocto glibc (control) |
| ------------------------------------------------------------- | ----------------- | --------------------- |
| short wrong password for `alice`                               | REJECT            | REJECT                |
| `bob` + documented password (`id` prints `uid=…(bob)`)        | ACCEPT            | ACCEPT                |
| running build marker matches the pinned build                 | PASS              | PASS                  |
| `wrong` then 300 × `A` for `alice` (`shadow *`)               | **ACCEPT**        | REJECT                 |
| bypass login prints `uid=…(alice)`                            | PASS              | n/a                    |
| bypassed session prints the exact per-run MMDS flag from `/run/rctf/flag.txt` | PASS | n/a      |
| `bob` (real `$5$` hash) + the same overlong password          | REJECT            | n/a                    |
| first-attempt overlong password for `alice` (INFO only)       | REJECT            | n/a                    |

Isolation (third instance, second team):

- team A `192.0.2.1:30000` → instance `ssholeyoctousl2db47ebb79`,
  team B `192.0.2.1:30002` → instance `ssholeyoctoisobbbdcf11c4c`;
  distinct public ports, each endpoint answers with its own
  `/etc/sshole-instance`, neither reaches the other instance;
- team B's bypass also works and prints **its own** per-run flag; team A's
  flag is not readable from team B.

The observed first-attempt rejection matches the public advisory (the bypass
succeeds on the second or later attempt in the same connection, which is
exactly what the check client sends: wrong, then long). It is recorded as
INFO rather than asserted.

### Honest history of this session's runs (all on 2026-11-19)

- `run.sh` 17:22 — **FAIL, 5 passed / 3 failed**: every instance's VM died
  before readiness. Diagnosed by booting the image directly with Firecracker
  v1.17.0 (direct mode, host KVM, unprivileged) and reading the serial
  console: repeated `Usage: nc [IPADDR PORT]` then
  `Kernel panic - not syncing: Attempted to kill init! exitcode=0x00000100` —
  poky's stock busybox builds the MINIMAL nc applet (no `CONFIG_NC_EXTRA`),
  so the frozen guest init's `nc -w` MMDS fetch failed instantly every boot.
  Fixed in the image with a busybox config fragment in this lab's layer
  (documented in `yocto/meta-sshhole/recipes-core/busybox/busybox_%.bbappend`,
  which also fails the busybox build unless the merged `.config` carries
  `CONFIG_NC_EXTRA=y`).
- `run.sh` 17:54 — **FAIL, 29 passed / 4 failed**: the bypass itself and the
  glibc control were already green (that run first proved the CVE on the
  Yocto musl image); the flag checks failed because the guest init mounts
  `/run` 0700 and `/run/rctf` 0700 (flags must not leak to non-root), so the
  bypassed non-root `alice` could not traverse to the 0644 flag copy.
  Fixed in `/app/start`: traversal-only `chmod 0755 /run /run/rctf`;
  `/run/rctf/flags` stays 0700 with every unpublished flag root-only.
- `run.sh` 18:14 — **FAIL, 31 passed / 2 failed**: the flag came back
  byte-exact but glued to check-client's `SSHOLE_STDOUT_END` marker (flags
  are written byte-exact with no trailing newline, `jq -j`), which the
  first-line comparison included. Fixed in `inner.sh` (marker stripped;
  `check-client.sh` itself remains byte-identical to the sibling sshole
  lab's copy).
- `run.sh` 18:41 — **PASS, 33 passed / 0 failed** (the run recorded above).

### Build incidents recorded for honesty

- The first bitbake musl build (3515 tasks) failed at
  `qemu-system-native 10.2`: qemu's bundled mshv.h redefines
  `struct mshv_vp_registers`, which this environment's newer kernel uapi
  headers also define (`/usr/include/linux/mshv.h:335` redefinition error).
  qemu was only in the graph because the `qemux86-64` machine include adds
  the `qemuboot` image class (`EXTRA_IMAGEDEPENDS += "qemu-system-native
  qemu-helper-native:do_addto_recipe_sysroot"`); the lab never boots the
  image with qemu, so the image recipe drops exactly that build dependency
  (documented in `sshhole-yocto-image.bb`). Everything else in the pinned
  release is stock. No Yocto recipe was modified.
- The build host lacks `hostname`/`chrpath`/`diffstat`/`wget`/`rpcgen`;
  instead of host packages, the pinned yocto-6.0.4
  `buildtools-extended-nativesdk-standalone` tarball provides the toolchain
  (gcc 15.3.0, chrpath, wget, rpcgen, python 3.14.7) — the host's own
  gcc 16.2 is never used — and the one missing utility (diffstat) is
  bootstrapped from the stock recipe's own pinned diffstat-1.68 source by
  `yocto/hosttools-bootstrap.sh`. A documented query-only `hostname` shim
  (`yocto/bin/hostname`) completes `bitbake`'s HOSTTOOLS requirement.
- bitbake's own notes: "Host distribution 'arch' has not been validated"
  (warning only — the build ran to completion) and "Your host glibc (2.44)
  is newer than uninative's (2.43); disabling uninative" (uninative is a
  host-isolation nicety; the target images are built by OE's own cross
  toolchain either way).

### NOT RUN

- No Yocto-built kernel: the lab reuses the pinned shared smoke kernel
  (`vmlinux-6.1.155`) exactly like the sibling labs; the yocto 6.18 kernel
  that bitbake also produced is an optional stretch goal and was NOT booted
  or verified. The rootfs — the part the event requires to be genuine Yocto —
  is bitbake output.
- The `curl` MMDS transport of the frozen guest init was not exercised (the
  image is busybox-only, `nc` is used, as in the smoke lab).
- No production host, no controller/scheduler, no Traefik, no real public
  network: checks run against the agent's DNAT port from an isolated netns.
- No fixed-openssh Yocto control (the sibling Alpine lab already proves the
  10.6p2 fix; this lab isolates the libc condition on the Yocto base).
- No bare-metal timing measurements (side channels out of scope).
- The yocto-6.0.4 release notes' detached PGP signature is recorded for
  provenance but was not verified (no publisher key pinned here).

### Manifest (as written by the final build.sh run)

```
yocto-release: yocto-6.0.4 (wrynose LTS; component tarballs pinned in fetch-artifacts.sh)
openssh: stock 10.3p1 recipe (upstream tarball sha256 56682a36bb92dcf4b4f016fd8ec8e74059b79a8de25c15d670d731e7d18e45f4), no CVE-2026-123158 backport
build-musl:
  bitbake: BitBake Build Tool Core version 2.18.0
  openssh PV=10.3p1
  musl PV=1.2.6+git
  busybox PV=1.37.0
  base-passwd PV=3.6.8
  shadow PV=4.19.4
  DISTRO_VERSION=6.0.4
build-glibc:
  bitbake: BitBake Build Tool Core version 2.18.0
  openssh PV=10.3p1
  glibc PV=2.43+git
  busybox PV=1.37.0
  base-passwd PV=3.6.8
  shadow PV=4.19.4
  DISTRO_VERSION=6.0.4

image: sshole-yocto-musl
  rootfs.ext4 sha256 eb3fc2095304bc7861e35f1c18ccfd41a44c470d3fe37770b270084e4aae2551  268435456 bytes
  vmlinux    sha256 e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2  44279576 bytes

image: sshole-yocto-glibc
  rootfs.ext4 sha256 a62e0b84d8569b5b269dd93a6d2265ca19b7f5c847f6deb1595e61ad8d8b02ce  268435456 bytes
  vmlinux    sha256 e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2  44279576 bytes
```
