# vmtest results — 2026-11-08

Real execution as root inside a throwaway QEMU VM. **Nothing privileged was run
on the developer machine.** The host only ran `qemu-system-x86_64` as the login
user; every root operation happened inside the VM.

- Host: Linux 7.2.14-arch1-1, AMD SVM, `kvm_amd.nested=1`, `/dev/kvm` 0666.
- VM: Ubuntu 24.04 cloud image (noble), kernel 6.8.0-147-generic, systemd
  `255.4-1ubuntu8.18`, nftables 1.0.9, conntrack-tools 1.4.8, nmap 7.94SVN,
  Python 3.12.
- Guest runtime: Firecracker/jailer v1.17.0, kernel 6.1.155 (Firecracker CI
  bucket), busybox 1.35.0, Bun 1.4.4.
- Command: `deploy/firecracker/vmtest/run.sh` (fresh overlay, full run).
- Transcript: `~/.cache/rctf-vmtest/logs/run-20261108-113959.log`.
- VM stopped (`vm.sh status` → `stopped`); the qcow2 overlay is kept for fast
  reruns (`vm.sh destroy` removes it). No qemu/seed processes left on the host.

## Summary

| Check | Assertions | Verdict |
| ----- | ---------- | ------- |
| `00-host-setup.sh` (a) | 16 pass / 1 fail | **FAIL**: `host-setup.sh` as shipped rejects Firecracker 1.17.0 — **product bug B1**; everything after the workaround passes (dirs, modes, sysctl, idempotency). |
| `10-agent-systemd.sh` (b) | 28 pass / 1 fail | **b PASSES** (agent starts, `KillMode=process`, preflight `accepting:true`, all checks true). **1 extra assertion FAILS**: the shipped unit drops CAP_SETUID, so the jailer cannot `setuid(10000)` — **product bug B2**. |
| `20-jailer-instance.sh` (c) | 32 / 0 | **PASS** — real jailer create, uid/chroot/cgroup/tap, MMDS flag, no host flag, full teardown, fencing. |
| `30-restart-survival.sh` (d) | 17 / 0 | **PASS** — VM survives `systemctl restart` and `kill -9`, is re-adopted; CAP_SYS_PTRACE is genuinely required. |
| `40-net-tests.sh` (e) | 9 / 0 | **PASS** — all 3 `FC_REAL` tests pass as root. One non-FC_REAL namespace test fails on a Bun stdin issue (test harness, quoted below). |
| `50-conntrack-quarantine.sh` (f) | 17 / 0 | **PASS** — real DNAT flow tracked, flushed on delete, /30 + port quarantined, not reused. |
| `60-egress-dnat-isolation.sh` (g,h) | 21 / 0 | **PASS** — egress masquerade, egress deny, public DNAT, team isolation with a positive control, nmap only published ports. |

Total: **140 passed, 2 failed**. Both failures are real product defects in
`deploy/firecracker/host/`; no assertion was weakened.

## a) host-setup.sh on a fresh Ubuntu 24.04

The shipped script was run first on a host with no rctf directories:

```text
==> checking Firecracker binaries
ERROR: firecracker 1.17.0

exit_code=0 is older than the supported minimum 1.7.0
```

That is bug B1. With the version-output wrapper (documented in the check and in
`repros/host-setup-version-parse.sh`), the same script:

- exits 0 and installs the directories with the documented modes
  (`state`/`run` 0700, `images`/`traefik` 0755, `/srv/jailer` 0700, config 0755),
- installs `/etc/sysctl.d/90-rctf-firecracker.conf` and applies
  `net.ipv4.ip_forward=1`, `net.ipv4.conf.all.rp_filter=1`,
- exits 0 again on a second run with unchanged modes/owners (idempotent).

## b) systemd, jailer preflight, and the unit bug

The installed unit is byte-identical to
`deploy/firecracker/host/rctf-firecracker-agent.service`. It started on the
first try; `KillMode=process`, `User=root`. `/v1/info` in jailer mode:

```json
"checks":{"recovered":true,"orphanBacklog":true,"stalledOperations":true,
"kvm":true,"firecrackerBin":true,"jailerBin":true,"imagesDir":true,
"imagesTrusted":true,"runDir":true,"cgroupRoot":true,"chrootBase":true,
"reflink":false,"apiSocketPath":true,"nft":true,"ip":true,
"conntrackBin":true,"ipForward":true,"traefikDirWritable":true,
"quarantineWritable":true,"tcpPortRange":true,"subnetPool":true}
```

`accepting: true`. But the shipped unit's effective capabilities are:

```text
CapEff: 00000000082c316b
CapBnd: 00000000082c31eb     # bit 7 (0x80, CAP_SETUID) only in bounding
```

so the jailer fails with `Failed to exec into Firecracker: Operation not
permitted (os error 1)` and the create returns `state: errored, message: launch
failed` (see B2). A test-only drop-in
`AmbientCapabilities=CAP_SETUID CAP_SETGID` restores CAP_SETUID and the jailer
works; the check then passes `accepting:true` again. This drop-in is the only
modification to the unit made by the harness and is removed at the start of the
next run.

## c) jailer-mode create (32 assertions)

Create over the agent API (`PUT /v1/instances/:id`) with `mode: jailer`:

```text
create: HTTP 200 {"state":"starting", ... "endpoints":[{"host":"192.0.2.1","port":30000}]}
pid=8005 guest=10.200.0.2 host=10.200.0.1 tap=fctap0 public=30000
jail=/srv/jailer/firecracker/vmtest1794163342j1/root
```

Verified: process alive, uid `10000`, jailed executable (`/proc/<pid>/exe` is
`/firecracker` and its device+inode equals the jail copy), `/proc/<pid>/root`
device+inode equals the jail root, `--id` on the cmdline exactly once,
per-instance cgroup `/sys/fs/cgroup/firecracker/<id>` with `pids.max=512` and
the pid as member, real `tun type tap` with alias `rctf-fc:rctf-fc` and the
host /30 address.

Flag delivered via MMDS v2 and served byte-exactly:

```text
guest served: rctf{vmtest-jailer-1794163342-canary}
guest probe: peer:10.200.0.6=blocked ... outside=REACHED
```

The flag was **absent** from the agent state dir, per-instance run dir, jail
tree (including `rootfs.ext4`), Traefik dir, agent journal, Firecracker
cmdline, and both base images. (The test guest keeps its flag on tmpfs; the
reference smoke guest copies it to `/www` on the rootfs, which is guest
behaviour, not an agent leak.)

Delete:

```text
delete: HTTP 200 {"state":"stopped", ...}
PASS firecracker process removed
PASS jail directory removed
PASS per-instance cgroup removed
PASS tap fctap0 removed
PASS nftables rules for the released guest IP removed
PASS nftables rules for the removed tap removed
PASS re-create of a deleted id is fenced (HTTP 409)
```

## d) restart / `kill -9` / CAP_SYS_PTRACE (17 assertions)

```text
fc pid=8266 guest=10.200.0.6 tap=fctap1 agent=7824
PASS systemctl restart replaced the agent process (7824 -> 8306)
PASS firecracker survived systemctl restart (KillMode=process)
PASS guest still serves its flag after restart
PASS restarted agent re-adopted the instance as running
PASS tap was preserved across the restart
sidecar: {"instanceId":"vmtest...r1","uid":10000,
          "jailRoot":"/srv/jailer/firecracker/vmtest...r1/root",
          "exePath":".../root/firecracker"}
PASS systemd restarted the agent after kill -9 (8306 -> 8366)
PASS firecracker survived kill -9 of the agent
PASS agent re-adopted the VM after kill -9 (strict identity)
```

CAP_SYS_PTRACE experiment (drop-in removing it, test-only):

```text
PASS drop-in really removed CAP_SYS_PTRACE from the agent's effective set
state without CAP_SYS_PTRACE: errored
PASS without CAP_SYS_PTRACE the agent cannot authenticate/re-adopt the running VM
PASS without CAP_SYS_PTRACE the VM process is left alive (no unverified signal)
reported state/message: errored (vm died)
PASS with CAP_SYS_PTRACE restored the agent reclaimed and destroyed the
     unauthenticated VM
```

**Conclusion: CAP_SYS_PTRACE is really required.** Without it a live jailed
Firecracker (uid 10000) is unreadable via `/proc/<pid>/exe` and
`/proc/<pid>/root`; recovery marks the instance `errored`/`vm died` and teardown
refuses to signal a process it cannot authenticate. When the capability is
restored the same agent destroys it. (A transient orphan between those two
moments is the designed fail-safe, not silent data loss.)

## e) FC_REAL privileged network tests

As root inside the VM:

```text
bun test v1.4.4
(pass) real host (FC_REAL) > rendered inet + arp ruleset passes nft -c [16.61ms]
(pass) real host (FC_REAL) > tap create/delete only touches our interface [32.92ms]
(pass) real host (FC_REAL) > conntrack flush succeeds on an empty table [12.19ms]
 3 pass, 0 fail
```

Full `FC_REAL=1 bun test test/net` as root: **104 pass, 1 fail**. The one failure
is not `FC_REAL`-gated and is a test-harness/Bun issue:

```text
(fail) real namespace networking > full rendered ruleset (2 leases) passes nft -c -f - [4.28ms]
error: expect(received).toBe(expected)
- ""
+ "internal:0:0-0: Error: Not a regular file: "/dev/stdin"
```

`Bun.spawn(..., {stdin: "pipe"})` hands the child a socketpair, and `nft -c -f -`
accepts only a regular file or a pipe. The same ruleset passes `nft -c` through
the repository's `CommandRunner` (real test #1). Repro:
`repros/bun-spawn-nft-stdin.sh`. The other namespace test (tap alias/restore)
passes both as root and as `ubuntu`.

## f) conntrack flush and reuse quarantine

```text
guest=10.200.0.10 tap=fctap2 index=2 public=30002
PASS a real DNAT flow to the public port is tracked in conntrack
PASS conntrack tracks the guest address before release
delete: HTTP 200 {"state":"stopped", ...}
PASS release flushed every conntrack entry for the guest address (four directions)
PASS no conntrack entry for the released public port remains
quarantine: {"version":1,
  "indexes":[{"id":0,...},{"id":1,...},{"id":2,...}],
  "ports":[{"id":30000,...},{"id":30001,...},{"id":30002,...}]}
PASS /30 index 2 is quarantined into the future
PASS public port 30002 is quarantined into the future
replacement: guest=10.200.0.14 tap=fctap3 port=30003
PASS the quarantined /30 was not handed to the replacement
PASS the quarantined public port was not handed to the replacement
```

The held connection was a real `nc` session from the outside namespace through
the DNAT port; the conntrack entry existed while it was open and was gone after
`DELETE`. Teardown (process/jail/cgroup/tap/nft) is asserted in the same check.

## g/h) egress, DNAT, isolation, nmap

```text
A guest=10.200.0.18 tap=fctap4 port=30004   (egress:true)
B guest=10.200.0.22 tap=fctap5 port=30005   (egress:false)
PASS egress:true guest reaches the outside HTTP service
PASS egress:false guest cannot reach the outside service
PASS conntrack proves masquerade: the outside reply is addressed to 192.0.2.1
PASS public DNAT from the outside namespace reaches team A's guest
PASS public DNAT from the outside namespace reaches team B's guest
PASS team A cannot reach team B's guest (probe inside A)
PASS team B cannot reach team A's guest (probe inside B)
PASS control: with the ruleset removed the SAME probe reaches the peer
PASS control: egress:false guest reaches the outside once the rules are gone
PASS restored ruleset restores isolation in both directions
PASS restored ruleset restores the egress deny for the egress:false team
```

The control flushes both owned tables (`inet rctf_fc`, `arp rctf_fc_arp`) and
restores the exact saved ruleset; isolation returns afterwards. This proves the
"blocked" measurements are sensitive, not a false negative.

nmap from the outside namespace against the host's public test address:

```text
22/tcp    closed   ssh
7001/tcp  closed   afs3-callback
30000/tcp closed   ndmps
30001/tcp closed   pago-services1
30002/tcp closed   pago-services2
30003/tcp closed   amicon-fpsu-ra
30004/tcp open     amicon-fpsu-s
30005/tcp open     unknown
30006..30010 closed
```

Only the two published DNAT ports are open. Port 22 is closed because the VM's
management sshd is bound to the QEMU management address (10.0.2.15) only; the
agent API is bound to 127.0.0.1 and does not appear.

## Product bugs found (not fixed; `src` untouched)

### B1 — `host-setup.sh` cannot parse Firecracker 1.17.0's `--version`

- File: `deploy/firecracker/host/host-setup.sh` (`binary_version()`).
- Repro: `deploy/firecracker/vmtest/repros/host-setup-version-parse.sh`.
- Exact failure:

  ```text
  ==> checking Firecracker binaries
  ERROR: firecracker 1.17.0

  exit_code=0 is older than the supported minimum 1.7.0
  ```

- Cause: Firecracker v1.17.0 writes this to **stdout** after `--version`:

  ```text
  Firecracker v1.17.0

  2026-11-08T18:14:08.188685327 [anonymous-instance:main] Firecracker exiting successfully. exit_code=0
  ```

  `awk '{print $NF}'` returns `1.17.0\nexit_code=0`, so `version_ge` fails.
- Impact: the documented fresh-host install aborts before creating any
  directory; the shipped minimum-version check is unusable with the pinned
  v1.17.0 artifact used by the smoke tests. Fix should take the first line (or
  the last whitespace field of the `Firecracker vX.Y.Z` line only).

### B2 — the shipped systemd unit cannot run the jailer (CAP_SETUID dropped)

- Files: `deploy/firecracker/host/rctf-firecracker-agent.service`
  (`RestrictAddressFamilies=...` + `CapabilityBoundingSet=...`).
- Repro: `deploy/firecracker/vmtest/repros/systemd-unit-setuid.sh`.
- Exact failure (from the real agent journal / jailer):

  ```text
  Failed to exec into Firecracker: Operation not permitted (os error 1)
  Error: Exec(Os { code: 1, kind: PermissionDenied, message: "Operation not permitted" })
  ```

  and the API create returns HTTP 200 with
  `{"state":"errored","message":"launch failed"}`.
- Evidence: under the shipped unit, `CapEff=00000000082c316b` but
  `CapBnd=00000000082c31eb` — CAP_SETUID (bit 7) is in the bounding set but not
  effective. Removing `RestrictAddressFamilies` (or adding
  `AmbientCapabilities=CAP_SETUID`) restores it. The repro's systemd-run
  demonstration (same directives as the unit) prints:

  ```text
  CapEff:	00000000082c316b
  CapBnd:	00000000082c31eb
  CapEff bit 7 (0x80) is CAP_SETUID. It is missing under RestrictAddressFamilies.
  setpriv: setresuid failed: Operation not permitted
  ```

  This is systemd 255 on Ubuntu 24.04; it is a real interaction, and the unit
  as shipped is broken for its default jailer mode.
- Test workaround: a drop-in with `AmbientCapabilities=CAP_SETUID CAP_SETGID`
  (kept out of the committed unit; created by the harness at run time).

## Test-harness / environment findings (not product bugs)

- **Bun 1.4.4 stdin pipe**: `test/net/namespace.test.ts` feeds `nft -c -f -`
  through `Bun.spawn(..., {stdin:"pipe"})`. Bun uses a socketpair; nft prints
  `internal:0:0-0: Error: Not a regular file: "/dev/stdin"`. The FC_REAL tests
  use the repository's `CommandRunner` (a Blob/regular-file stdin) and pass.
  Repro: `repros/bun-spawn-nft-stdin.sh`. This test is not FC_REAL-gated, so
  the full suite reports 1 failure even on a real host.
- **Ubuntu 24.04 unprivileged user namespaces**: `kernel.apparmor_restrict_unprivileged_userns`
  is disabled by `provision.sh` so the namespace test can run as `ubuntu`.
  (The `test.skipIf` guard still runs it as root, where it now passes except
  for the nft stdin issue.)
- **`ip netns exec` transient EPERM**: on this nested kernel,
  `ip netns exec <ns>` intermittently fails with `setting the network
  namespace "fcoutside" failed: Operation not permitted` even for root. The
  harness uses `nsenter --net=/run/netns/<ns>` with retries, which is stable;
  this is an environment quirk, not a product result.

## Real vs simulated

| Real | Simulated / limited |
| ---- | ------------------- |
| Nested KVM (`/dev/kvm` inside the VM), real Firecracker v1.17.0 boots | Nested virtualization, not bare metal; timings are slower |
| Real jailer: uid/gid 10000, chroot, cgroup v2, pid namespace, copies | One host only; no controller/scheduler/multi-host |
| Real systemd unit, `systemctl restart`, `kill -9`, journal | systemd 255/Ubuntu 24.04 only; another distro may differ |
| Real nftables rules, taps, conntrack, DNAT, masquerade | The "internet" is a veth + netns with TEST-NET-1 (192.0.2.0/24) |
| Real nmap from a separate network namespace | nmap scans the test host's public test IP, not a real public IP |
| Real guest MMDS v2 flag delivery and byte-exact service response | Test guest/service is a fixture (`guest-start`); no TLS/Traefik |
| Real `host-setup.sh`, unit and agent binaries from this checkout | `FIRECRACKER_BIN` wrapper only for the version bug; ambient drop-in only for the unit bug |

## Leftovers / cleanup

- The VM was stopped by `run.sh`'s trap; the overlay from this run is kept in
  `~/.cache/rctf-vmtest/` for fast reruns (`vm.sh destroy` removes it), and
  `vm.sh status` reports `stopped`.
- All three repros were executed inside that VM on 2026-11-08 (the version,
  capability/setuid and Bun-stdin outputs quoted above are from those runs).
- No `qemu-system-x86_64`, seed HTTP server or ssh tunnel remains on the host.
- The shared artifact cache (`~/.cache/rctf-fc-smoke`) is untouched; the VM
  image cache (`~/.cache/rctf-vmtest`) keeps only `noble-base.img` + ssh key.
- The throwaway VM's `/srv/jailer`, cgroups, taps and nft rules were removed by
  the checks; nothing privileged ran on the host.

## How to reproduce

```sh
cd deploy/firecracker/vmtest
./run.sh                    # ~10-15 min; stops the VM and prints the summary
KEEP_VM=1 ./run.sh          # then ./vm.sh ssh for a shell in the VM
./vm.sh destroy             # remove the overlay and start completely fresh
```

Inside the VM (for the two repros):

```sh
sudo bash /opt/rctf-firecracker/deploy/firecracker/vmtest/repros/host-setup-version-parse.sh
sudo bash /opt/rctf-firecracker/deploy/firecracker/vmtest/repros/systemd-unit-setuid.sh
bash /opt/rctf-firecracker/deploy/firecracker/vmtest/repros/bun-spawn-nft-stdin.sh
```
