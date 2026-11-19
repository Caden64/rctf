# sshole-yocto — the musl libc OpenSSH password bypass on a genuine Yocto rootfs

A defensive CTF training lab for **\*sshole** (CVE-2026-123158: musl libc +
OpenSSH built/run without PAM accepts an overlong password for an account
whose shadow field is exactly `*`). It is the same vulnerability the
sibling [Alpine/Ubuntu `sshole` lab](../sshole/) proves — rebuilt here on a
**genuine Yocto (poky) rootfs**, because the event wants the sshhole
challenge running on yocto. The vulnerable Yocto image *is* the event
challenge image (`challenge.yaml` in this directory).

The lab runs two disposable Firecracker microVMs: one vulnerable build and
one control. The vulnerable image is exploited with a stock `ssh` client
using the documented two-prompt sequence; the control must reject the same
attempt, and a rejection only counts when it is a real authentication
rejection, not a transport failure. The bypassed session must read the
per-run flag that only MMDS delivered.

This lab is for the rCTF platform owner's own training infrastructure. It
only ever runs inside a throwaway nested-KVM QEMU VM owned by the developer.
It contains no third-party exploit code: the client is the system `ssh` and
the shared askpass helper.

## What is proven

The vulnerability requires all of:

1. musl libc (not glibc),
2. OpenSSH built/run without PAM,
3. `PasswordAuthentication yes`,
4. an account whose `/etc/shadow` password field is exactly `*`,
5. at least one other account with a real `$5$`/`$6$` SHA-crypt hash (the
   salt sshd borrows for timing equalisation).

All five come from the **stock pinned Yocto release** here, not from a
hand-staged guest: poky yocto-6.0.4 does not put `pam` in `DISTRO_FEATURES`,
so its openssh recipe builds `--without-pam` and sshd authenticates through
libc `crypt()` over `/etc/shadow`; with `TCLIBC=musl` that is exactly the
CVE-2026-123158 condition.

The lab asserts, from inside the vmtest VM and over the real Firecracker
agent's published TCP endpoint:

- `sshole-yocto-musl`: `alice` (`alice:*:…`) logs in with a wrong password
  followed by a 300-byte password in the same connection, the remote `id`
  prints `uid=…(alice)`, and `cat /run/rctf/flag.txt` prints the **exact
  per-run MMDS flag** (the event flag path).
- `sshole-yocto-musl`: a short wrong password for `alice` is rejected.
- `sshole-yocto-musl`: the same overlong attempt for `bob` (real `$5$` hash)
  is rejected — the real hash stays immune.
- `sshole-yocto-glibc`: the identical recipe and configuration with
  `TCLIBC=glibc` rejects the bypass, while `bob` still logs in. The libc is
  the only difference between the two builds, so this isolates the libc
  condition on a Yocto base.
- Every rejection is classified as an authentication rejection; a connection
  refusal, timeout, kex error or unknown output is a **failure**, never a
  pass (`check-client.sh`, copied verbatim from the sibling sshole lab).
- Each instance's endpoint reaches **its own** guest: an instance-id file
  read as `bob`, two team instances with distinct public ports, and the
  second instance's bypass reads **its own** flag, never team A's.
- The reported `sshd` banner, package and Yocto identity of the running
  guest match the pinned build (read out of `/etc/sshole-build` after login,
  and out of the binary at build time).
- Build-time assertions (see `build.sh`) prove the same from the image bytes:
  the `OpenSSH_10.3p1` banner is read out of `sshd` with `strings`, the musl
  (or glibc) flavour is read with `readelf` off the sshd program interpreter,
  PAM is entirely absent (no `/etc/pam.d/sshd`, no `libpam*` anywhere in the
  image, no pam linkage in `sshd`), `/etc/os-release` identifies the poky
  distro, and `alice`/`bob` carry exactly the documented shadow fields.

The documented one-line summary is: **on the Yocto musl image `wrong` then
`300 × 'A'` authenticates `alice`; on the Yocto glibc control it does not.**

## Images

| Image               | Base                                    | OpenSSH                                  | libc  | PAM | Expected long-password result |
| ------------------- | --------------------------------------- | ---------------------------------------- | ----- | --- | ----------------------------- |
| `sshole-yocto-musl` | poky `yocto-6.0.4` `core-image-minimal` | stock `openssh_10.3p1.bb`                | musl  | no  | **accepted**                  |
| `sshole-yocto-glibc`| poky `yocto-6.0.4` `core-image-minimal` | stock `openssh_10.3p1.bb`                | glibc | no  | rejected                      |

Both images are produced by **one** bitbake recipe
(`yocto/meta-sshhole/recipes-core/images/sshhole-yocto-image.bb`) from the
pinned release; only `TCLIBC` differs between the two build directories.

### Yocto pinning basis

- **Release:** the newest stable LTS point release, `yocto-6.0.4` (wrynose,
  6.0 series LTS until April 2030; point release dated 2026-10-20). The
  current poky releases ship **component tarballs** instead of a monolithic
  poky tarball; the lab assembles the poky tree from the three publisher
  archives:
  - `bitbake-51fd94a67fa17650a9ff623492005972bbc7d26f.tar.bz2` —
    `a541a9535cca6e342151e8e7b0c11f322dab879317b32e71bd47490c28af8b7d`
  - `oecore-0f03c732a0a2d0506b41b1abe60b3f368b2300dc.tar.bz2` —
    `a35af9fd6d814ee2fbe21bbcb8de19cdf63fb2c5c78e8f5badf91dfc723a7748`
  - `meta-yocto-7c25b11156553145fa6b241a2d4f65d94438f804.tar.bz2` —
    `411c783757cd2931e407dff408248b6b15f4508e4bf7a9ceedec13c0e7874b84`
- **Trust basis, NOT trust-on-first-use for these:** each tarball has a
  **publisher-provided `.sha256sum`** next to it in the release directory;
  `fetch-artifacts.sh` pins the digest AND re-fetches the publisher's
  `.sha256sum` at fetch time, failing if they disagree. (The release notes
  carry a detached PGP signature; it is recorded for provenance but no key
  is pinned here.)
- **Host toolchain:** `x86_64-buildtools-extended-nativesdk-standalone-6.0.4.sh`
  (publisher `.sha256sum` `93002cc067c15523c1fca4e2ee047a1dba0eed7ccfdb41652141741edb5469b2`,
  cross-checked) supplies gcc 15.3.0, binutils, chrpath, wget, rpcgen and
  python3.14 for the build; the host's own toolchain (gcc 16.2 / python
  3.14.10 on the development machine) is never used to build.
- **diffstat:** the one required host utility the toolchain tarball lacks is
  bootstrapped by `yocto/hosttools-bootstrap.sh` from the exact tarball the
  stock yocto-6.0.4 `diffstat_1.68.bb` recipe pins
  (`diffstat-1.68.tgz`, sha256
  `89f9294a8ac74fcef6f1b9ac408f43ebedf8d208e3efe0b99b4acc16dc6582c7`), and
  compiled unprivileged with the pinned buildtools gcc.
- **hostname:** the build host lacks a `hostname` binary; the lab provides a
  documented query-only shim (`yocto/bin/hostname`) on the bitbake PATH
  that refuses any argument form loudly instead of misbehaving.
- **OpenSSH version decision:** the stock yocto-6.0.4 recipe is
  `openssh_10.3p1` pinned to the upstream tarball
  (sha256 `56682a36bb92dcf4b4f016fd8ec8e74059b79a8de25c15d670d731e7d18e45f4`)
  and carries backports only for CVE-2026-59995..60002 — **none of which is
  CVE-2026-123158** — so the stock recipe IS the vulnerable build and is
  used as shipped. `yocto-build.sh` re-asserts this before every bitbake run
  (recipe present, digest unchanged, no `CVE-2026-123158` patch) and fails
  closed if the release ever changes under it; the fallback then is pinning
  a vulnerable openssh recipe in this layer, as documented in RESULTS.md.
- **Kernel:** the images boot the pinned shared smoke kernel
  (`../smoke/`, vmlinux 6.1.155, `e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2`)
  like every other lab; the **rootfs** is what must be (and is) genuine
  Yocto. The bitbake build also produces a yocto 6.18 kernel because
  `core-image-minimal` depends on `virtual/kernel`; building and booting it
  is an optional stretch goal and is NOT part of the verified path.
- Firecracker, the static `jq` and busybox are reused from `../smoke/` with
  their pinned digests re-verified here. The upstream openssh tarball is
  fetched by bitbake itself and verified against the recipe's
  `SRC_URI[sha256sum]`.

### Guest accounts

Both accounts are throwaway and only exist in the lab images:

| user    | shadow field | password                                  |
| ------- | ------------ | ----------------------------------------- |
| `alice` | `*`          | none (no password can match; the target)  |
| `bob`   | real `$5$`   | `sshole-lab-bob-password` (SHA-256 crypt) |

The accounts are created **inside the bitbake image assembly** through the
`extrausers` class (the distro's own shadow tooling under pseudo), not
patched into the tarball on the host afterwards. `PermitRootLogin
prohibit-password` and `AllowUsers alice bob` keep root out of scope; the
lab demonstrates authentication bypass, not privilege escalation.

### Ownership note (unprivileged builds)

`mkfs.ext4 -d` preserves the *builder's* numeric ownership, and the build
runs unprivileged as the developer (uid 1000 — which is `alice` in the
guest). `/app/start` (run as root at boot) therefore re-chowns the
runtime-critical files before starting sshd: `/etc/passwd`, `/etc/group`,
`/etc/shadow` (mode 0600), `/etc/ssh`, `/run/sshd` to root and `/home/bob`
to bob. This is the same approach the sibling Alpine lab takes.

## The event flag path

`challenge.yaml` registers the musl image as the `sshhole` event challenge
(`challengeIntegrationId: fc-sshhole-yocto`, one `tcp` expose for guest port
22, `readiness: tcp 22`, `vcpus 1`, `memMiB 256`, `diskMiB 1024`,
`shouldDisplay: true`). Per-team flags come from the platform's
`flags/static` provider at the event and are delivered to each instance
**only through MMDS**. The guest init writes them root-only (0400) on the
tmpfs `/run/rctf/flags/<provider>`; `/app/start` republishes the `main`
flag as `/run/rctf/flag.txt` (mode 0644, same tmpfs — never the ext4) so
the bypassed `alice` session can read it. `run.sh` asserts exactly that
against the real instance. **No real flag is ever committed**; the
registration YAML carries the same placeholder as the sample.

## Requirements

Host (unprivileged):

- `/dev/kvm` readable/writable and nested virtualization enabled,
- `qemu-system-x86_64`, `qemu-img`, `ssh`, `ssh-keygen`, `curl`, `python3`,
  `tar`, `strings`, `readelf`, `flock`, `xz`, `mkfs.ext4` (e2fsprogs
  >= 1.47),
- for the Yocto build only: `bash`, `bzip2`, `perl` (bitbake) — everything
  else comes from the pinned buildtools tarball,
- roughly 3 GiB RAM and 10 GiB disk for the lab VM plus ~20-40 GiB and
  1-3+ hours for the first bitbake build (DL_DIR/sstate under
  `$XDG_CACHE_HOME/rctf-sshole-yocto/yocto/`).

Everything privileged (nftables, taps, jailer, KVM) runs inside the throwaway
QEMU VM started by `../vmtest/vm.sh`. Nothing runs privileged on the host.

## How to run

```sh
cd deploy/firecracker/labs/sshole-yocto
./selftest.sh        # unprivileged classifier/staging selftest, no VM
./build.sh           # unprivileged: fetch + bitbake (musl AND glibc) + assertions
./run.sh             # fresh unique VM + real agent + real Firecracker + checks
KEEP_VM=1 ./run.sh   # leave the VM for debugging
ONLY_INNER=1 ./run.sh # reuse existing images (still boots a fresh VM)
SSHOLE_YOCTO_SKIP_BITBAKE=1 ./build.sh   # restage images from an existing build
```

`run.sh` uses its own per-run `VM_DIR` and random host ports; it never uses
the `vmtest` defaults and never signals processes by name, so concurrent
vmtest or lab runs do not interfere. The transcript is written below the lab
cache and, unless the VM must be kept, the per-run VM directory is removed
after teardown.

## What this lab is not

- It does not re-prove the vulnerability from source; it proves the pinned
  Yocto release reproduces it. The upstream fix (OpenSSH 10.6p2) is proven
  by the sibling Alpine lab's fixed image.
- The kernel is the shared pinned 6.1.155 smoke kernel, not a Yocto-built
  one (stretch goal only; see RESULTS.md).
- It does not test root login (`PermitRootLogin prohibit-password`).
- Nested KVM performance and timing differ from bare metal; only behaviour
  is asserted, not timing side channels.
- `build.sh` runs `bitbake` on the build host (unprivileged, with pinned
  inputs). Bitbake compiles host-native tooling as the invoking user; that
  is standard unprivileged Yocto practice, but it means the build host needs
  the ~20-40 GiB of working space above.
