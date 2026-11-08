# Unprivileged smoke test (real Firecracker + real KVM)

`run.sh` boots **real** Firecracker microVMs with the real agent, real VM driver and real network
manager, without root. It exists because most of the repository's automated tests fake the privileged
edges; this is the check that the pieces work against the real programs.

```sh
./fetch-artifacts.sh   # downloads the pinned Firecracker, CI kernel, busybox and jq (all sha256-verified); builds the guest rootfs
./run.sh               # needs bun, nft, ip, curl, python3, /dev/kvm access, unprivileged user namespaces
```

## Pinned artifacts

`fetch-artifacts.sh` pins exact versions and embeds sha256 digests; cached files are re-hashed
before every use and a mismatch is fatal. Downloads go to a `.part` file and are verified
before being renamed into place.

| Artifact            | Version                                  | sha256                                                             | Provenance                                                                |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Firecracker tarball | `v1.17.0` x86_64                         | `06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558` | official release `.sha256.txt`                                            |
| Firecracker binary  | `v1.17.0`                                | `99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5` | extracted from the verified tarball and re-hashed                         |
| jq                  | `1.8.2` (`jq-linux-amd64`)               | `b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f` | official release `sha256sum.txt`                                          |
| kernel              | `vmlinux-6.1.155` (Firecracker CI v1.15) | `e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2` | **trust-on-first-use**: the publisher has no checksum next to this object |
| busybox             | `1.35.0` static x86_64                   | `6e123e7f3202a8c1e9b1f94d8941580a25135382b99e8d3e34fb858bba311348` | **trust-on-first-use**: no publisher checksum in the binaries directory   |

The kernel and busybox digests were computed from the fetched bytes because the publisher
does not offer an independent checksum for those files. They are still pinned: a changed
upstream file or a corrupted cache fails the fetch instead of being silently used. If you
intentionally change a URL or version, update the digest and the provenance row here.

To exercise the whole path against a fresh cache without touching the shared one (both
commands must use the same directory):

```sh
export SMOKE_ARTIFACTS=$(mktemp -d ~/.cache/rctf-fc-smoke-verify/run-XXXXXX)
./fetch-artifacts.sh
./run.sh
```

## How it stays unprivileged and safe

The agent and Firecracker run inside `unshare -Urn`: a private **user + network namespace**. Inside it the
script is "root", so it can create real tap devices, a dummy uplink and real nftables rules, but none of it
is visible to or can reach the host's network. The run directory lives under `$XDG_RUNTIME_DIR` (a tmpfs)
and is short on purpose: Firecracker rejects unix socket paths longer than 107 bytes.

`unshare -Urn` does **not** create a PID namespace, so the harness never kills by process name. Instance
ids carry 80 random bits from `/dev/urandom`; cleanup signals the agent, both VMs, the Python listener and
every helper only after re-verifying the recorded `/proc/<pid>/stat` start ticks, the executable and this
run's unique directory in argv, then waits for each to exit. A concurrent run on the same machine is never
touched.

## What it verifies (24 checks)

- The agent starts with the real `VmDriver` and `NetworkManager`, and preflight reports `accepting: true`.
- A real kernel boots under KVM in about 2 seconds, `ip=` autoconfiguration works, and the reference guest
  `init` (the one in `../guest/`) fetches the **MMDS v2** document and exports the flag and environment.
- The flag reaches the guest service byte-for-byte, and appears nowhere on the host: not in the agent state
  directory, the Traefik directory, the agent log, or the per-instance rootfs disk image. Absence is only
  asserted after every scan target is proven to exist and be readable, and `grep` itself must exit 0/1;
  a missing file or a grep error is reported as inconclusive, never as "flag absent".
- The real `nft` accepts the rendered `inet` and `arp` rulesets; anti-spoof rules are present.
- `kill -9` of the agent does not kill the VM (the recorded pid + start-tick identity still matches); the
  restarted agent re-adopts it as `running` and keeps its tap.
- A duplicate create is idempotent and a changed spec is rejected with 409.
- **Team isolation measured from inside the guests:** two VMs each hold only their own flag, neither can reach
  the other or a listener on the host side of its tap, and a **control** (flushing the rules) requires
  **both** guests to report exactly `peer=REACHED host=REACHED` (bounded polling), so a broken peer or
  host probe cannot make the "blocked" result look meaningful.
- Delete removes the process, tap, run directory and nftables rules, and the deleted id is fenced against a
  late re-create (409). The tap and nft absence checks inspect the `ip`/`nft` exit status first: a failed
  listing fails the check instead of looking like "nothing left".

`selftest.sh` (run first, in the same namespace) is a 10-case mutation proof of these helpers: a
nonexistent scan target or a failing `ip`/`nft` stub must be rejected as inconclusive, a genuine
"table does not exist" is accepted, and `kill_verified` must ignore a PID whose start ticks, executable
or argv run marker disagree. Its `SELFTEST` failures also fail the run.

## What it does NOT verify

This script alone does not cover jailer mode, Traefik, NAT, conntrack, systemd, the controller or multiple
hosts. Those are covered by the sibling harnesses: `../e2e/` (provider, controller and real agent),
`../edge/` (Traefik, NAT, conntrack, anti-spoof, nmap), `../vmtest/` (root VM: jailer, systemd, host setup)
and `../multihost/` (two root VMs and a controller); see their READMEs and `RESULTS.md`. Still unverified by
any of them: TLS, physical networks, and other distros/kernels/Firecracker versions than the ones recorded in
the `RESULTS.md` files (Firecracker v1.17.0, kernel 6.1.155 from the Firecracker CI bucket, busybox 1.35.0,
jq 1.8.2 for this script).

Run these on a real root host before an event: `host/README.md` lists the checks, and
`FC_REAL=1 sudo bun test apps/firecracker-instancer/test/net` runs the privileged network tests.
