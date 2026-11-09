# Real-root verification in a throwaway QEMU VM

This harness proves, with **real execution as root**, the Firecracker
instancer pieces that the unprivileged smoke test cannot: jailer mode, the
shipped systemd unit, `host-setup.sh` on a fresh distribution, privileged
network tests, conntrack flushing, egress NAT and public DNAT.

It boots a pinned cloud image under KVM. **Nothing privileged runs on your
machine**: `vm.sh` only starts `qemu-system-x86_64` as your user and forwards
one ssh port. Every root operation (nftables, taps, jailer, cgroups, systemd,
network namespaces) happens inside the VM. There is no `sudo` on the host and
none is needed.

```sh
cd deploy/firecracker/vmtest
./run.sh                 # full run; stops this run's VM on exit
KEEP_VM=1 ./run.sh       # leave it running for debugging
./vm.sh ssh              # shell inside the VM (passwordless sudo)
./vm.sh stop             # kill qemu (keeps the disk)
./vm.sh destroy          # stop and delete the qcow2 overlay

# matrix axes (defaults preserve the original single run)
VM_IMAGE=debian-12     ./run.sh
VM_IMAGE=ubuntu-22.04  ./run.sh
KERNEL=vmlinux-6.1.188 ./run.sh
FC_VERSION=v1.16.0     ./run.sh
./matrix.sh              # the four pinned combinations, sequentially
```

Every `run.sh` invocation gets its own `VM_DIR` by default
(`$VM_ROOT/runs/run-<stamp>-<pid>.XXXXXX`), while the verified base cloud image
is shared in `$VM_IMAGE_DIR` (`~/.cache/rctf-vmtest` by default). A run records
a unique owner token in its VM directory and **refuses to adopt an
authenticated VM it did not start** (`FORCE_ADOPT_VM=1` is the explicit
debugging override), and its cleanup stops only a VM carrying that token. Two
concurrent runs therefore cannot stop each other's VM; give them distinct
`VM_SSH_PORT` / `VM_SEED_PORT` (defaults are ssh `127.0.0.1:2422` and
cloud-init seed `127.0.0.1:8201`) because the ports are exclusive. Setting
`VM_DIR` explicitly keeps the old fixed-directory behaviour (and then
concurrent runs sharing it fail closed instead of adopting).

`vm.sh` refuses to boot when either port is already bound by a process it did
not record (it never kills by process name). Pidfiles are versioned
(`version=3`) and record the machine boot
id, the process start time (`/proc/<pid>/stat` field 22), the executable, the
PID-namespace identity (`/proc/<pid>/ns/pid`) and the run-specific argv
elements. QEMU writes its bare numeric pidfile to `qemu.pid.raw`; the
authenticated record is atomically renamed onto `qemu.pid`, so no bare
intermediate is observable. All signalling goes through `pidguard.py`, which
opens a pidfd first, validates that identity while holding it, re-reads the
start ticks immediately before the signal, and sends TERM/KILL only through the
same pidfd (so a reused PID is never signalled). Check output is written under
the run's own scratch directory (`$WORK/check-logs/`), never a fixed
`/tmp/vmtest-check-*.log` path shared by concurrent runs.

The helper has three distinct outcomes and the wrappers preserve them: `0`
authenticated/stopped, `1` definitely dead/stale (only this may delete a
pidfile), `4` identity mismatch (a live process exists but is not this record;
keep the pidfile) and `3` observation failure (pidfd/`/proc` unreadable; keep
the pidfile and every resource it protects). `status`/`pid` are non-mutating
observations; every pidfile mutation is serialised by a lifecycle `flock`.
`stop` returns nonzero when shutdown is unconfirmed, and `destroy` refuses to
remove the overlay/console/seed when it is. `./vm.sh selftest` runs these checks
unprivileged on the host (decoy processes, no VM; **50 checks**, including the
PID-namespace mismatch, observation-error retention, destroy refusal, a
concurrent status/rewrite loop and the run-ownership token rules) and `run.sh`
runs it before booting.

## Requirements

Host (unprivileged):

- `/dev/kvm` readable/writable, AMD-V/Intel-VT with nested virtualization
  enabled for the guest (the VM must expose `/dev/kvm` to Firecracker),
- `qemu-system-x86_64`, `qemu-img`, `ssh`, `ssh-keygen`, `curl`, `python3`
  (>= 3.9 with Linux pidfd support: `os.pidfd_open` /
  `signal.pidfd_send_signal`), `tar`, `/dev/kvm`,
- ~5 GiB RAM free (VM uses 4 GiB by default) and ~10 GiB disk.

The Firecracker, kernel, busybox and rootfs artifacts are shared with
`deploy/firecracker/smoke/` (`~/.cache/rctf-fc-smoke`, populated by
`fetch-artifacts.sh`; `run.sh` fetches them under a `flock` if missing). All
three axes are pinned; an unknown `VM_IMAGE`, `KERNEL` or `FC_VERSION` is
refused rather than fetched unpinned.

| Axis         | Values                                                                                               | Pinning                                                                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VM_IMAGE`   | `ubuntu-24.04` (default), `ubuntu-22.04` (see the systemd 249 limitation below), `debian-12`         | dated image directory + exact file SHA256, cross-checked against the publisher's sums on fetch and re-hashed before every boot                                                                         |
| `KERNEL`     | `vmlinux-6.1.155` (default, Firecracker CI `v1.15`), `vmlinux-6.1.188` (Firecracker CI `20261105-…`) | SHA256 trust-on-first-use (the S3 objects have no published checksum), stored under `images/smoke/kernels/<kernel>`; `KERNEL_URL` + `KERNEL_SHA256` must be set together for any other kernel          |
| `FC_VERSION` | `v1.17.0` (default), `v1.16.0`                                                                       | tarball from the official release `.sha256.txt`; the Firecracker and jailer binaries are additionally checked against the publisher `SHA256SUMS` inside that verified tarball and pinned independently |

VM: 4 vCPU / 4 GiB / 40 GiB overlay. The cloud image is downloaded once to
`$VM_IMAGE_DIR` and the run directory only holds the overlay, seed, console and
pidfiles. Ubuntu images are checked against the published `SHA256SUMS` and its
GPG signature (`SHA256SUMS.gpg`, pinned signing fingerprint) on first fetch.
Debian publishes only an unsigned `SHA512SUMS` in its dated directory, so the
Debian download is checked against the pinned SHA256 (trust-on-first-use, taken
from the fetched bytes on 2026-11-08) and the published SHA512; there is no
signature to verify. The cached image is re-hashed against the pinned digest
before every boot. The ssh user follows the image (`ubuntu` or `debian`) and
provisioning adapts to the distro (`apt`, `ssh.service` vs socket activation,
the AppArmor unprivileged-userns knob only where it exists). Bun is downloaded
inside the VM (pinned 1.4.4) and its zip is checked against the official
`SHASUMS256.txt` plus a pinned digest.

## What is checked (numbered assertions)

| Check                         | Assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-host-setup.sh`            | `host-setup.sh` on a fresh host as shipped (no wrapper); the installed binary is the selected `FC_VERSION`, and `--check-version-only` parses its extra `exit_code=0` line; directories and modes; only its own sysctl file is applied and every key in it verified (an unrelated 99- drop-in must stay unapplied); idempotent rerun.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `10-agent-systemd.sh`         | The repository unit (byte-identical, **no drop-in**) starts the agent under real systemd; `KillMode=process`; preflight `accepting:true` in jailer mode; every blocking preflight check true; both images visible; `CAP_SETUID` is the only ambient capability and `CAP_SETGID` stays effective; the agent's `CapBnd`/`CapPrm`/`CapEff`/`CapAmb` match the documented `0x82c31eb`/`0x80` set and `NoNewPrivs=1`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `20-jailer-instance.sh`       | The installed unit is byte-identical and has no drop-in; HTTP create in jailer mode; Firecracker uid 10000; executable inside the jail; `/proc/<pid>/root` == jail root (non-empty inode pairs, aborts if the process is dead); **the live Firecracker process (and any child) has `CapPrm`/`CapEff`/`CapAmb` == 0 and `NoNewPrivs=1`**; per-instance cgroup + `pids.max`; real tun/tap with `rctf-fc:rctf-fc` alias and /30; MMDS v2 flag byte-exact; flag absent from agent state, run dir, jail tree, Traefik dir, whole journal, cmdline, rootfs and base images, with searchable-tree/file counts and planted-canary positive controls for the tree, journal and binary scans; delete removes process/jail/cgroup/tap/nft rules with a positive tap/nft calibration before delete and fail-closed `ip`/`nft` probes after it; tombstone fencing. |
| `30-restart-survival.sh`      | `systemctl restart` and `kill -9` leave the VM alive and re-adopted: agent-reported `.vm.pid` stays the original PID and `vm-identity.json` (`jailRoot`, `exePath`, exe dev:ino, uid) is compared against live `/proc/<pid>/{exe,root,status}` after each event; **the zero-capability/`NoNewPrivs` assertion is repeated after each re-adoption and the agent's documented capability set is re-checked**; `KillMode=process`; CAP_SYS_PTRACE drop-in experiment records the exact outcome (hard requirement: VM alive/unsignalled with same starttime and an errored auth-failure record) and recovery clean-up after restoring the cap; teardown tap/process probes are fail-closed with a live-tap calibration.                                                                                                                                   |
| `40-net-tests.sh`             | `FC_REAL=1 bun test test/net` as root (105 tests, 0 fail); the unprivileged namespace suite as the image's login user (real nft via a temp file, not Bun's stdin socketpair).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `50-conntrack-quarantine.sh`  | A real DNAT TCP flow (guest in the reply-source direction) and a masqueraded egress flow (guest in the original-source direction) are tracked; `conntrack -L` must exit 0 after delete; every entry for the guest address, both flowed tuples and the public port are flushed; the freed /30 index and public port are durably quarantined and not reused; tap/nft teardown probes are fail-closed and calibrated while the lease exists.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `60-egress-dnat-isolation.sh` | `egress:true` masquerade to an outside netns service (plus a conntrack masquerade proof); `egress:false` blocked; public DNAT from the outside netns; team isolation measured inside the guests with a flush control; `nmap` from outside over ports 1-10000 plus the configured `tcpPortRange` sees only the published ports; Firecracker teardown enumeration is fail-closed and calibrated before delete.                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The guest used for the checks is `guest-start` in this directory: it keeps the
flag on tmpfs (never on the ext4 rootfs) and exposes `/probe.txt` with the
results of continuous probes to peer guests and to an outside HTTP service.

## The "outside" network

Inside the VM the harness creates a veth pair: `fcveth0` in the main namespace
with `192.0.2.1/24`, and `fcvext0` in the `fcoutside` netns with
`192.0.2.2/24`. The agent is configured with:

- `network.externalInterface = fcveth0` (DNAT + masquerade),
- `network.publicHost = 192.0.2.1`,
- `network.subnetPool = 10.200.0.0/16`,
- `network.tcpPortRange = 30000-30010`.

An HTTP service on `192.0.2.2:9999` represents the internet. `nmap` runs in
`fcoutside` against `192.0.2.1`. The VM's management sshd is bound to
`10.0.2.15:22` only, so port 22 is not visible on the public test interface.

## Files

| Path           | Purpose                                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vm.sh`        | create/start/ssh/status/stop/destroy/selftest the VM (idempotent, port-ownership checks, authenticated pidfiles, pidfd signalling, verified base image)                                                                     |
| `pidguard.py`  | authenticate a v3 pidfile (boot id, start ticks, exe, PID namespace, argv) and TERM/KILL it through a pidfd; exit codes preserve running / stale / identity-mismatch / observation-error (shared with `../multihost/vm.sh`) |
| `provision.sh` | runs as root in the VM: packages, Bun, checkout, guest image                                                                                                                                                                |
| `run.sh`       | host driver: per-run VM dir, boot, copy, provision, run checks, stop, summary                                                                                                                                               |
| `matrix.sh`    | sequential driver for the pinned `(image, kernel, Firecracker)` combinations                                                                                                                                                |
| `guest-start`  | test-only guest service (flag on tmpfs + probe results)                                                                                                                                                                     |
| `checks/*.sh`  | numbered pass/fail assertions                                                                                                                                                                                               |
| `repros/*.sh`  | minimal reproductions for product bugs / harness issues                                                                                                                                                                     |
| `RESULTS.md`   | dated log of what actually ran and the exact outcomes                                                                                                                                                                       |

## Honest limitations

- **Not every distro/systemd version.** The matrix in `RESULTS.md` covers
  Ubuntu 24.04 (systemd 255, nftables 1.0.9, conntrack 1.4.8) and Debian 12
  (systemd 252, nftables 1.0.6, conntrack 1.4.7), guest kernels 6.1.155 and
  6.1.188, and Firecracker v1.17.0 and v1.16.0. **Ubuntu 22.04 (systemd 249)
  is parameterizable but currently fails before the checks matter**: on
  systemd 249, `ProtectClock=yes` in the shipped unit installs a device-cgroup
  allowlist that makes `open("/dev/kvm", O_RDWR)` fail with `EPERM`, so the
  agent preflight reports `kvm:false` (bisected to that one unit property; the
  same unit works on systemd 252 and 255). Treat systemd 249 hosts as
  unsupported until the unit changes; see RESULTS.md for the exact evidence.
- **One host.** No controller, scheduler, multi-host or rCTF provider.
- **Nested virtualization.** Firecracker runs on KVM-on-KVM. It works here, but
  it is slower than bare metal and cannot validate hardware-specific behaviour.
- **Test topology, not a real internet.** Egress and DNAT are measured against
  a veth/netns peer; no real public traffic, no Traefik/TLS.
- **The test guest/service and the agent config are test fixtures**, not the
  production sample. `cgroupLimits: ['pids.max=512']` is set so the jailer
  creates a per-VM cgroup (with the default empty list jailer v2 creates none).
- **Artifact integrity.** Every image, kernel and Firecracker release is
  pinned to a dated directory/version plus a SHA256, and cached files are
  re-hashed before each use. Ubuntu images are verified against the dated
  directory's `SHA256SUMS` and `SHA256SUMS.gpg` (pinned key fingerprint) on
  first fetch. Debian publishes only an unsigned `SHA512SUMS` in its dated
  directory: the Debian SHA256 is trust-on-first-use and the download is also
  checked against that published SHA512, so there is no publisher signature for
  the Debian image. Firecracker tarballs are checked against the official
  release `.sha256.txt`, and the extracted firecracker/jailer binaries against
  both the publisher `SHA256SUMS` inside that tarball and independent pins. The
  Bun 1.4.4 zip is verified against the official `SHASUMS256.txt` and a pinned
  digest. If `gpg` (or the keyserver) is unavailable, the harness prints an
  honest warning and still enforces the pinned SHA256, but the signature is not
  checked in that case.
- **Conntrack-tools and unprivileged user namespaces** are installed/enabled
  in the VM. The namespace suite now feeds `nft` a real temp file instead of a
  Bun stdin socketpair; `bunCommandRunner` (production) already used a Blob.
- **The version parser has rootless regression coverage** (fake binaries) in
  `apps/firecracker-instancer/test/host-setup-version.test.ts`; the VM check
  runs the real selected binary (1.17.0 and 1.16.0 in the matrix).
- The host artifacts cache is shared with other workers; never delete it while
  they run.
