# sshole — musl libc OpenSSH password bypass lab

A defensive CTF training lab for **\*sshole** (CVE-2026-123158: musl libc +
OpenSSH without PAM accepts an overlong password for an account whose shadow
field is exactly `*`). It runs four disposable Firecracker microVMs: one
vulnerable build and three controls. The vulnerable image is exploited with a
stock `ssh` client using the documented two-prompt sequence; every control must
reject the same attempt, and a rejection is only accepted when it is a real
authentication rejection, not a transport failure.

This lab is for the rCTF platform owner's own training infrastructure. It only
ever runs inside a throwaway nested-KVM QEMU VM owned by the developer. It
contains no third-party exploit code: the client is the system `ssh` and a
small askpass helper written here.

## What is proven

The vulnerability requires all of:

1. musl libc (not glibc),
2. OpenSSH built/run without PAM,
3. `PasswordAuthentication yes`,
4. an account whose `/etc/shadow` password field is exactly `*`,
5. at least one other account with a real `$5$`/`$6$` SHA-crypt hash (the salt
   sshd borrows for timing equalisation).

The lab asserts, from inside the vmtest VM and over the real Firecracker
agent's published TCP endpoint:

- `sshole-musl-vuln`: `alice` (`alice:*:…`) logs in with a wrong password
  followed by a 300-byte password in the same connection, and the remote `id`
  prints `uid=…(alice)`.
- `sshole-musl-vuln`: a short wrong password for `alice` is rejected.
- `sshole-musl-vuln`: the same overlong attempt for `bob` (real `$5$` hash) is
  rejected — the real hash stays immune.
- `sshole-musl-fixed` (OpenSSH 10.6p2): the overlong attempt for `alice` is
  rejected; `bob` still logs in.
- `sshole-glibc` (Ubuntu 24.04, glibc, `UsePAM no`): the overlong attempt is
  rejected; `bob` still logs in. This isolates the libc difference because it
  exercises the same non-PAM `crypt()` path.
- `sshole-pam` (Alpine, vulnerable 10.3p1 code, `UsePAM yes`): the overlong
  attempt is rejected; `bob` still logs in through `pam_unix`.
- Every rejection above is classified as an authentication rejection; a
  connection refusal, timeout, kex error or unknown output is a **failure**, not
  a pass (`check-client.sh`).
- Each instance's endpoint reaches **its own** guest (an instance-id file read as
  `bob`), the two team instances have distinct public ports, and no endpoint
  reaches another team's guest.
- The reported `sshd` banner and package version of the running guest match the
  pinned build (read out of `/etc/sshole-build` after login, and out of the
  binary at build time).

The documented one-line summary is: **on the vuln image `wrong` then
`300 × 'A'` authenticates `alice`; on all three controls it does not.**

## Images

| Image               | Base                                       | OpenSSH package                                        | libc  | PAM | Expected long-password result |
| ------------------- | ------------------------------------------ | ------------------------------------------------------ | ----- | --- | ----------------------------- |
| `sshole-musl-vuln`  | Alpine minirootfs 3.24.4 (`v3.24`)         | `openssh-server-10.3_p1-r1`                            | musl  | no  | **accepted**                  |
| `sshole-musl-fixed` | Alpine edge minirootfs `20260805`          | `openssh-server-10.6_p2-r0`                            | musl  | no  | rejected                      |
| `sshole-glibc`      | Ubuntu base 24.04.5 (`cdimage.ubuntu.com`) | `openssh-server 1:9.6p1-3ubuntu13.20`                  | glibc | no  | rejected                      |
| `sshole-pam`        | Alpine minirootfs 3.24.4 (`v3.24`)         | `openssh-server-pam-10.3_p1-r1` + `linux-pam-1.7.1-r2` | musl  | yes | rejected                      |

Pinned versions/digests are in `fetch-artifacts.sh`. The important ones:

- Alpine 3.24.4 minirootfs: `cdaa38cb8de3537967ee5b6c9b6cd00cc962da2b018e6eea48696bb274923012`
- Alpine edge `20260805` minirootfs: `5acac12c425a0817c1b6a79bdd5df4c73756fc8dc268eab32f8ba830872b835d`
- vulnerable `openssh-server-10.3_p1-r1.apk`: `2818d1c4ba1cc279e226632aceea3ada2c7652977fce364f75c0d2ad058ea57f`
- fixed `openssh-server-10.6_p2-r0.apk`: `2681a323c6a2b959d90d878b796176de801954f2c97cac1a7d1c77d93f36972e`
- Alpine PAM `openssh-server-pam-10.3_p1-r1.apk`: `dc3654a6aec2e82d418102fc7ad536752019917c4044a1da253644c01d49523d`
- Ubuntu base 24.04.5: `e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86`
- Ubuntu `openssh-server_9.6p1-3ubuntu13.20_amd64.deb`: `5d0d5eb672ddc27601e2da4e8465c5736dc73375a21bc1cd1834fcb08fb155bf`

### Integrity notes (trust-on-first-use)

- Alpine publishes `.sha256` files for release images, not for individual
  repository packages. The `.apk` digests were computed from the fetched bytes
  and are pinned as **trust-on-first-use**. Alpine also rebuilds packages
  **in place** at the same version: during development the `v3.24`
  `libcrypto3-3.5.9-r0` and `zlib-1.4-r0` bytes changed while the `edge` copies
  did not, so the lab keeps them under separate cache names. A changed digest is
  fatal; re-pin deliberately after re-checking the bytes.
- Superseded Alpine packages (the vulnerable `10.3_p1-r1`) are no longer listed
  in the current repository index but are still served by the CDN at the exact
  URL; the digest is pinned so a replacement cannot slip in.
- Ubuntu's base tarball is checked against both the pinned digest and the
  publisher's `SHA256SUMS`. Ubuntu `.deb` digests come from the signed
  `noble-updates` `Packages` index.
- Firecracker, the kernel, static `jq` and busybox are reused from
  `../smoke/` with its pinned digests re-verified here.

### Guest accounts

Both accounts are throwaway and only exist in the lab images:

| user    | shadow field | password                                                      |
| ------- | ------------ | ------------------------------------------------------------- |
| `alice` | `*`          | none (no password can match; this is what the bypass targets) |
| `bob`   | real hash    | `sshole-lab-bob-password` (Alpine `$5$`, Ubuntu `$6$`)        |

`PermitRootLogin prohibit-password`, `AllowUsers alice bob`, and only password
authentication is enabled. `alice` is a normal user (`uid=1000`), not root; the
lab demonstrates authentication bypass, not privilege escalation.

## Requirements

Host (unprivileged):

- `/dev/kvm` readable/writable and nested virtualization enabled,
- `qemu-system-x86_64`, `qemu-img`, `ssh`, `ssh-keygen`, `curl`, `python3`,
  `tar`, `ar`, `zstd`, `strings`, `mkfs.ext4` (e2fsprogs >= 1.47),
- roughly 3 GiB RAM and 10 GiB disk for the lab VM (the four guest images live
  in `$XDG_CACHE_HOME/rctf-sshole`),
- network access on first run for the pinned downloads (and for the shared
  smoke artifacts / Ubuntu cloud image if they are not already cached).

Everything privileged (nftables, taps, jailer, KVM) runs inside the throwaway
QEMU VM started by `../vmtest/vm.sh`. Nothing runs privileged on the host.

## How to run

```sh
cd deploy/firecracker/labs/sshole
./build.sh          # unprivileged image build, build-time assertions
./run.sh            # fresh unique VM + real agent + real Firecracker + checks
KEEP_VM=1 ./run.sh  # keep the VM for debugging
ONLY_INNER=1 ./run.sh  # reuse existing images (still boots a fresh VM)
```

`run.sh` uses its own per-run `VM_DIR` and random host ports; it never uses the
`vmtest` defaults and never signals processes by name, so concurrent vmtest or
lab runs do not interfere. The transcript is written below the lab cache and,
unless the VM must be kept, the per-run VM directory is removed after teardown.

`./selftest.sh` runs the client classifier and askpass helper unprivileged on
the host (no VM, no ssh server). It is included in the checks documented in
`RESULTS.md`.

## What this lab is not

- It is not a production hardening guide; the fixed image demonstrates upstream
  OpenSSH 10.6p2, the distro backports are separate.
- It does not test root login: `PermitRootLogin prohibit-password` keeps the
  root `*` account out of scope.
- It does not claim the bug is Alpine-specific; musl-based OpenSSH builds
  without PAM share the condition. The PAM and glibc images are controls.
- Nested KVM performance and timing differ from bare metal; only behaviour is
  asserted, not timing side channels.
