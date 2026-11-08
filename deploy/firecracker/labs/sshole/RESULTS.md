# sshole — results

## 2026-11-08 — full nested run on the development machine

Executed for real with `/dev/kvm` available; nothing privileged ran on the host.

- Host: Linux 7.2.14-arch1-1, 16 CPUs, 54 GiB RAM, `/dev/kvm` present,
  QEMU 11.1.3 (user-mode networking).
- Repo: `rCTF` fork, branch `feat/firecracker-backend`, commit `50c5f16c` plus
  this lab.
- Lab VM: fresh Ubuntu 24.04 cloud image under nested KVM, unique per-run
  `VM_DIR` (`~/.cache/rctf-sshole/vm/run-20261108-164044-983346`) and random
  host ports (ssh `127.0.0.1:…`, seed `127.0.0.1:…`); the vmtest default VM
  was not touched.
- Firecracker: v1.17.0, kernel `vmlinux-6.1.155` (shared smoke artifacts,
  pinned digests re-verified).
- Command: `cd deploy/firecracker/labs/sshole && ./run.sh`
- Result: **44 passed, 0 failed**; `run.sh` exited 0; the VM was destroyed and
  its overlay removed. Transcript:
  `~/.cache/rctf-sshole/logs/run-20261108-164044-983346.log`.

### Images built (unprivileged)

`./build.sh` unpacked the pinned trees with `tar`/`ar` and called
`../../guest/build-rootfs.sh --dir`; no container engine, no mount, no chroot,
no guest binary executed on the host.

| Image               | Size | rootfs.ext4 sha256 (this build)                                    | build-time banner |
| ------------------- | ---- | ------------------------------------------------------------------ | ----------------- |
| `sshole-musl-vuln`  | 256M | `a25066e451f4bda310e62d240ffb855dfbad83e169d1e3c9329118fa6f54b27a` | `OpenSSH_10.3p1`  |
| `sshole-musl-fixed` | 256M | `4252ab30211b1bf8ff2115131edbd98769f0087b3a766d7d7f5733bc42ce3d61` | `OpenSSH_10.6p2`  |
| `sshole-glibc`      | 512M | `9f3efa96c7893c1ee6c518751ef544bbe2f58b4f37c13c98bc9c1a63f6558671` | `OpenSSH_9.6p1`   |
| `sshole-pam`        | 256M | `6e0eabc5b2fdc6d88dde5112cbdb83206b10b62ded2d992ee532d444698ed9de` | `OpenSSH_10.3p1`  |

Bytes differ between builds (mkfs UUID/timestamps); the build-time assertions
tie every image back to the pinned package digests and expected banner, and the
running guest confirms its own package and banner after login.

Pinned inputs used (full manifest and digests in `fetch-artifacts.sh`):

- Alpine minirootfs 3.24.4 (`v3.24`) — `cdaa38cb…923012`
- Alpine edge minirootfs `20260805` — `5acac12c…2b835d`
- `openssh-server-10.3_p1-r1.apk` — `2818d1c4…5ea57f`
- `openssh-server-10.6_p2-r0.apk` — `2681a323…36972e`
- `openssh-server-pam-10.3_p1-r1.apk` — `dc3654a6…9523d`
- `openssh-server_9.6p1-3ubuntu13.20_amd64.deb` — `5d0d5eb6…b155bf`
- Ubuntu base 24.04.5 — `e77b6f10…7a0c86` (also matched the published
  `SHA256SUMS` at fetch time; the signed index was not GPG-verified by this
  lab).

### Checks observed (44 PASS, 0 FAIL)

Per image, over the agent-published TCP endpoint from the `fcoutside` network
namespace, using the system `ssh` with `SSH_ASKPASS_REQUIRE=force`:

| Check                                                   | vuln       | fixed  | glibc  | pam    |
| ------------------------------------------------------- | ---------- | ------ | ------ | ------ |
| short wrong password for `alice`                        | REJECT     | REJECT | REJECT | REJECT |
| `bob` + documented password (`id` prints `uid=…(bob)`)  | ACCEPT     | ACCEPT | ACCEPT | ACCEPT |
| running build marker matches the pinned package/banner  | PASS       | PASS   | PASS   | PASS   |
| wrong then 300 × `A` for `alice` (`shadow *`)           | **ACCEPT** | REJECT | REJECT | REJECT |
| bypass login prints `uid=…(alice)`                      | PASS       | n/a    | n/a    | n/a    |
| `bob` (real hash) + the same overlong password          | REJECT     | n/a    | n/a    | n/a    |
| first-attempt overlong password for `alice` (INFO only) | REJECT     | n/a    | n/a    | n/a    |

Isolation:

- team A endpoint `192.0.2.1:30000` → instance `ssholeemuslvuln…`
- team B endpoint `192.0.2.1:30004` → instance `ssholeisob…`
- distinct public ports; each endpoint reads its own guest's
  `/etc/sshole-instance`; neither endpoint returns the other team's id.

The observed first-attempt rejection matches the public advisory: the bypass
succeeds on the second or later attempt in the same connection, which is exactly
what the check client sends (wrong, then long). This is recorded as INFO rather
than asserted.

### Other checks run

- `./selftest.sh`: 14/14 PASS. The result classifier treats refusals, timeouts,
  kex failures, auth-plus-transport output and unknown output as ERROR (never
  as a rejection); the 300-byte password is inside 257..1024; the askpass
  helper returns passwords in order and empty on an unexpected third prompt.
- `bun run test:firecracker`: 472 pass, 4 skip, 0 fail.
- `bun run typecheck`: all workspaces exit 0.
- `bun run lint`: exit 0.
- `bun run format:check`: two lab Markdown files were formatted with
  `oxfmt --check` clean. The repo-wide check still reports pre-existing
  formatting differences in `deploy/firecracker/{edge,multihost,smoke,vmtest}`
  files outside this change; they were not modified.

### NOT RUN

- No production host, no controller/scheduler, no Traefik, no real public
  network: checks run against the agent's DNAT port from an isolated netns, as
  the vmtest harness does.
- No bare-metal timing measurements (side channels are out of scope).
- No OpenSSH source build: the vulnerable image uses the pinned Alpine 10.3p1
  package, and the fixed image uses the pinned upstream 10.6p2 package on
  Alpine edge.
