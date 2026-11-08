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
- Command: `deploy/firecracker/vmtest/run.sh` (full run, shipped unit with no
  drop-in, shipped `host-setup.sh` with no version wrapper).
- Transcript: `~/.cache/rctf-vmtest/logs/run-20261108-120034.log`.
- VM stopped (`vm.sh status` → `stopped`); the qcow2 overlay is kept for fast
  reruns (`vm.sh destroy` removes it). No qemu/seed processes left on the host.

## Summary

All checks pass. Two product bugs found by the previous run of this harness
(B1, B2) and one harness-only failure (item 3) are fixed in this change; the
numbered assertions below were re-run against the fixed tree.

| Check                               | Assertions       | Verdict                                                                                                                                                                 |
| ----------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-host-setup.sh` (a)              | 18 pass / 0 fail | **PASS** — `host-setup.sh` as shipped accepts Firecracker 1.17.0 (extra `exit_code=0` line ignored), creates the dirs/modes, applies sysctl, idempotent.                |
| `10-agent-systemd.sh` (b)           | 31 pass / 0 fail | **PASS** — shipped unit (byte-identical, no drop-in) starts the agent, `KillMode=process`, preflight `accepting:true`, `CAP_SETUID`+`CAP_SETGID` effective and ambient. |
| `20-jailer-instance.sh` (c)         | 35 pass / 0 fail | **PASS** — unit byte-identical/no drop-in; real jailer create, uid/chroot/cgroup/tap, MMDS flag, no host flag, full teardown, fencing.                                  |
| `30-restart-survival.sh` (d)        | 17 pass / 0 fail | **PASS** — VM survives `systemctl restart` and `kill -9`, is re-adopted; CAP_SYS_PTRACE is genuinely required.                                                          |
| `40-net-tests.sh` (e)               | 12 pass / 0 fail | **PASS** — `FC_REAL=1 bun test test/net` as root: **105 tests, 0 fail**; the namespace suite also passes as `ubuntu`.                                                   |
| `50-conntrack-quarantine.sh` (f)    | 17 pass / 0 fail | **PASS** — real DNAT flow tracked, flushed on delete, /30 + port quarantined, not reused.                                                                               |
| `60-egress-dnat-isolation.sh` (g,h) | 21 pass / 0 fail | **PASS** — egress masquerade, egress deny, public DNAT, team isolation with a positive control, nmap only published ports.                                              |

Total: **151 passed, 0 failed**. Before the fixes the same harness reported
140 passed / 2 failed (B1 in check 00, B2 in check 10) plus one non-FC_REAL
namespace test failing on Bun's stdin socketpair. No assertion was weakened:
the workarounds (a version-filter wrapper and an ambient-capability drop-in)
were removed, and the checks now assert the shipped files directly.

## a) host-setup.sh on a fresh Ubuntu 24.04 (18 assertions)

The shipped script was run first on a host with no rctf directories, with no
wrapper:

```text
==> checking Firecracker binaries
==> firecracker 1.17.0, jailer 1.17.0 (minimum 1.7.0)
==> printing tool versions (informational)
    nft:       nftables v1.0.9 (Old Doc Yak #3)
    ip:        ip utility, iproute2-6.1.0, libbpf 1.3.0
    conntrack: conntrack v1.4.8 (conntrack-tools)
==> creating directories
==> installing /etc/sysctl.d/90-rctf-firecracker.conf
==> net.ipv4.ip_forward=1
...
PASS [01]: host-setup.sh runs clean on a fresh host as shipped
```

The extra Firecracker line is still present and is now parsed correctly. The
rootless hook (also covered by fake binaries in
`apps/firecracker-instancer/test/host-setup-version.test.ts`) prints:

```text
firecracker 1.17.0
jailer 1.17.0
```

Verified: directories and documented modes (`state`/`run` 0700,
`images`/`traefik` 0755, `/srv/jailer` 0700, config 0755),
`/etc/sysctl.d/90-rctf-firecracker.conf`, `net.ipv4.ip_forward=1`,
`net.ipv4.conf.all.rp_filter=1`, and a byte-for-byte idempotent rerun.

## b) systemd, jailer preflight, and the capability bug (31 assertions)

The installed unit is byte-identical to
`deploy/firecracker/host/rctf-firecracker-agent.service` and there is **no
drop-in**. It started on the first try; `KillMode=process`, `User=root`.
`/v1/info` in jailer mode:

```json
"checks":{"recovered":true,"orphanBacklog":true,"stalledOperations":true,
"kvm":true,"firecrackerBin":true,"jailerBin":true,"imagesDir":true,
"imagesTrusted":true,"runDir":true,"cgroupRoot":true,"chrootBase":true,
"reflink":false,"apiSocketPath":true,"nft":true,"ip":true,
"conntrackBin":true,"ipForward":true,"traefikDirWritable":true,
"quarantineWritable":true,"tcpPortRange":true,"subnetPool":true}
```

`accepting: true`. The capability assertions under the shipped unit:

```text
PASS [27]: no systemd drop-in: the agent runs from the shipped unit alone
PASS [28]: shipped unit applies AmbientCapabilities=CAP_SETUID CAP_SETGID
CapEff: 00000000082c31eb
CapBnd: 00000000082c31eb
PASS [29]: agent process has CAP_SETUID+CAP_SETGID effective (jailer can drop to uid 10000)
PASS [30]: the two restored capabilities are ambient (inherited across the jailer exec)
PASS [31]: preflight accepting:true with no drop-in
```

`CapAmb` is `00000000000000c0` (CAP_SETUID|CAP_SETGID). Without the fix this
was `CapEff=00000000082c316b`, `CapBnd=00000000082c31eb` (CAP_SETUID missing
from effective) and the jailer failed with
`Failed to exec into Firecracker: Operation not permitted (os error 1)`.

## c) jailer-mode create (35 assertions)

This check now starts by asserting the installed unit is byte-identical and
that no drop-in exists, then creates over the agent API (`PUT
/v1/instances/:id`) with `mode: jailer`:

```text
PASS [01]: installed unit is byte-identical to the repository unit
PASS [02]: no systemd drop-in installed (shipped unit alone)
create: HTTP 200 {"state":"starting", ... "endpoints":[{"host":"192.0.2.1","port":30000}]}
PASS [06]: jailer launched Firecracker under the shipped unit (no drop-in)
pid=2843 guest=10.200.0.2 host=10.200.0.1 tap=fctap0 public=30000
jail=/srv/jailer/firecracker/vmtest1794164443j1/root
```

Verified: process alive, uid `10000`, jailed executable (`/proc/<pid>/exe` is
`/firecracker` and its device+inode equals the jail copy), `/proc/<pid>/root`
device+inode equals the jail root, `--id` on the cmdline exactly once,
per-instance cgroup `/sys/fs/cgroup/firecracker/<id>` with `pids.max=512` and
the pid as member, real `tun type tap` with alias `rctf-fc:rctf-fc` and the
host /30 address.

Flag delivered via MMDS v2 and served byte-exactly:

```text
guest served: rctf{vmtest-jailer-1794164443-canary}
guest probe: peer:10.200.0.6=blocked ... outside=REACHED
```

The flag was **absent** from the agent state dir, per-instance run dir, jail
tree (including `rootfs.ext4`), Traefik dir, agent journal, Firecracker
cmdline, and both base images. (The test guest keeps its flag on tmpfs; the
reference smoke guest copies it to `/www` on the rootfs, which is guest
behaviour, not an agent leak.)

Delete: `HTTP 200 {"state":"stopped", ...}`; process, jail directory,
per-instance cgroup, tap and both nft rule sets removed; re-create of the
deleted id fenced with HTTP 409.

## d) restart / `kill -9` / CAP_SYS_PTRACE (17 assertions)

```text
fc pid=2578 guest=10.200.0.2 tap=fctap0 agent=...
PASS systemctl restart replaced the agent process (2578 -> 3139)
PASS firecracker survived systemctl restart (KillMode=process)
PASS guest still serves its flag after restart
PASS restarted agent re-adopted the instance as running
PASS tap was preserved across the restart
sidecar: {"instanceId":"vmtest...r1","uid":10000,
          "jailRoot":"/srv/jailer/firecracker/vmtest...r1/root",
          "exePath":".../root/firecracker"}
PASS systemd restarted the agent after kill -9 (3139 -> 3200)
PASS firecracker survived kill -9 of the agent
PASS agent re-adopted the VM after kill -9 (strict identity)
```

CAP_SYS_PTRACE experiment (a test-only drop-in removes it; the shipped
`AmbientCapabilities=` stays in effect):

```text
PASS drop-in really removed CAP_SYS_PTRACE from the agent's effective set
state without CAP_SYS_PTRACE: errored
PASS without CAP_SYS_PTRACE the agent cannot authenticate/re-adopt the running VM
PASS without CAP_SYS_PTRACE the VM process is left alive (no unverified signal)
reported state/message: errored (vm died)
PASS with CAP_SYS_PTRACE restored the agent reclaimed and destroyed the
     unauthenticated VM
PASS jail dir removed after cleanup
PASS tap removed after cleanup
```

**Conclusion: CAP_SYS_PTRACE is really required.** Without it a live jailed
Firecracker (uid 10000) is unreadable via `/proc/<pid>/exe` and
`/proc/<pid>/root`; recovery marks the instance `errored`/`vm died` and teardown
refuses to signal a process it cannot authenticate. When the capability is
restored the same agent destroys it. (A transient orphan between those two
moments is the designed fail-safe, not silent data loss.)

## e) privileged and namespace network tests

As root inside the VM:

```text
(pass) real host (FC_REAL) > rendered inet + arp ruleset passes nft -c
(pass) real host (FC_REAL) > tap create/delete only touches our interface
(pass) real host (FC_REAL) > conntrack flush succeeds on an empty table
  3 pass, 0 fail
```

Full `FC_REAL=1 bun test test/net` as root: **105 pass, 0 fail** across 8
files. The two `namespace.test.ts` tests now pass both as root and as the
unprivileged `ubuntu` user:

```text
(pass) real namespace networking > full rendered ruleset (2 leases) passes nft -c -f -
(pass) real namespace networking > dummy fctap9 survives restore; a manager-created tap gets the alias and is removed on release
  2 pass, 0 fail
```

The previous failure was harness-only: Bun 1.4.4's `stdin:"pipe"` is a
socketpair, and `nft -f -` rejects it with
`internal:0:0-0: Error: Not a regular file: "/dev/stdin"`. The test now writes
the ruleset to a real temp file and passes it as a Blob/BunFile; `nft -c` sees
a regular file. The production `bunCommandRunner` already passed stdin as a
`Blob` (not `stdin:"pipe"`), so no `src` change was needed; the real
`nft -c -f -` test using that runner passes as root above. Repro of the Bun
behaviour is kept at `repros/bun-spawn-nft-stdin.sh`.

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

## Fixes landed in this change (2026-11-08)

### B1 — `host-setup.sh` could not parse Firecracker 1.17.0's `--version`

- File: `deploy/firecracker/host/host-setup.sh` (`binary_version()`).
- Cause: Firecracker v1.17.0 writes this to **stdout** after `--version`:

  ```text
  Firecracker v1.17.0
  2026-11-08T18:14:08 [anonymous-instance:main] Firecracker exiting successfully. exit_code=0
  ```

  The old `awk '{print $NF}'` returned `1.17.0\nexit_code=0`, so `version_ge`
  rejected a supported binary and the documented fresh-host install aborted
  before creating any directory.

- Fix: take the first line only and the first `x.y.z` token
  (`grep -m1 -Eo '[0-9]+\.[0-9]+\.[0-9]+'`), for both firecracker and jailer;
  a leading `v` and pre-release/build suffixes are tolerated, and garbage
  still yields the existing "could not read ... version" error.
- Added `--check-version-only`, a rootless hook that runs the same parser and
  comparison and exits before any privileged precondition. The new
  `apps/firecracker-instancer/test/host-setup-version.test.ts` drives it with
  fake binaries (banner + `exit_code=0`, plain 1.7.0, pre-release, garbage,
  below-minimum), and `bun run test:firecracker` runs it.
- Evidence: check 00 is 18/0 (was 16/1); `--check-version-only` printed
  `firecracker 1.17.0` / `jailer 1.17.0`. `repros/host-setup-version-parse.sh`
  now compares the old and fixed parsers.

### B2 — the shipped unit could not run the jailer on systemd 255

- File: `deploy/firecracker/host/rctf-firecracker-agent.service`.
- Cause: on systemd `255.4-1ubuntu8.18` (Ubuntu 24.04), `NoNewPrivileges=yes`
  combined with a seccomp filter (`RestrictAddressFamilies=` installs one)
  starts a root service with `CAP_SETUID` in `CapBnd` but **not** in
  `CapPrm`/`CapEff`. Measured with otherwise identical transient units:

  ```text
  NoNewPrivileges=yes alone:        CapPrm=CapEff=CapBnd=0x82c31eb
  RestrictAddressFamilies= alone:   CapPrm=CapEff=CapBnd=0x82c31eb
  both together:                    CapPrm=CapEff=0x82c316b, CapBnd=0x82c31eb
  ```

  (Any seccomp filter + NNP behaves the same; a `SystemCallFilter=` variant
  reproduced it.) The jailer setuid/setgid()s to uid/gid 10000 before execing
  Firecracker, so it failed with
  `Failed to exec into Firecracker: Operation not permitted (os error 1)` and
  creates returned `state: errored`, `message: launch failed`.

- Fix: keep `RestrictAddressFamilies=` and add
  `AmbientCapabilities=CAP_SETUID CAP_SETGID`. With it, `CapAmb=0xc0` and
  `CapEff=CapBnd=0x82c31eb`; the address-family filter stays in force. Removing
  `RestrictAddressFamilies=` also works, but restoring exactly the two bits the
  jailer needs is narrower and was chosen after the full vmtest (create/delete,
  restart, `kill -9`, conntrack, egress NAT, public DNAT) passed with the
  shipped unit and **no drop-in**.
- Harness: the test-only `AmbientCapabilities` drop-in was removed from
  check 10 (and check 30's drop-in no longer recreates ambient caps). Check 10
  asserts the effective/ambient bits; check 20 asserts the installed unit is
  byte-identical and that no drop-in exists, then launches a real jailer.
- Tests/docs: `apps/firecracker-instancer/test/samples.test.ts` asserts the
  unit's capability directives; the unit's "not yet verified" comment now
  records what was verified (systemd version, distro, date);
  `deploy/firecracker/host/README.md` and
  `apps/docs/src/content/docs/integrations/instancer/firecracker.md` are
  updated.
- Evidence: check 10 is 31/0 (was 28/1), check 20 is 35/0; `CapEff` was
  `0x82c31eb` with `CapAmb=0xc0` under the shipped unit alone.
  `repros/systemd-unit-setuid.sh` reproduces the measurement and shows the
  shipped fix.

### Harness-only item 3 — namespace test fed nft a Bun stdin socketpair

- File: `apps/firecracker-instancer/test/net/namespace.test.ts` (test only).
- Cause: Bun 1.4.4's `stdin:"pipe"` child stdin is a socketpair; `nft -f -`
  rejects non-regular, non-pipe input:
  `internal:0:0-0: Error: Not a regular file: "/dev/stdin"`.
- Fix: write the ruleset to a real temp file (`mkdtempSync`) and pass it as
  `Bun.file(path)`; remove the temp dir afterwards. No shell, no host path.
- Evidence: full `FC_REAL=1 bun test test/net` as root in the VM: 105 pass,
  0 fail; `namespace.test.ts` 2 pass as root and 2 pass as `ubuntu`.
- `src` audit: `applyRuleset` goes through `bunCommandRunner`, which passes
  `new Blob([stdin])` (not `stdin:"pipe"`), and the FC_REAL
  `nft -c -f -` test using it passes as root. The only other `Bun.spawn` in
  `src` (`vm/driver.ts`) uses `stdin: "ignore"`. **No production code path is
  affected; `src` was not edited.**

## Test-harness / environment findings (not product bugs)

- **Bun 1.4.4 stdin pipe (fixed in the harness):** see item 3 above. The
  behaviour is still reproducible with
  `deploy/firecracker/vmtest/repros/bun-spawn-nft-stdin.sh`, which is kept as
  documentation; the test no longer depends on it.
- **Ubuntu 24.04 unprivileged user namespaces**:
  `kernel.apparmor_restrict_unprivileged_userns` is disabled by `provision.sh`
  so the namespace test can run as `ubuntu`. It also passes as root.
- **`ip netns exec` transient EPERM**: on this nested kernel,
  `ip netns exec <ns>` intermittently fails with `setting the network
namespace "fcoutside" failed: Operation not permitted` even for root. The
  harness uses `nsenter --net=/run/netns/<ns>` with retries, which is stable;
  this is an environment quirk, not a product result.

## Real vs simulated

| Real                                                                            | Simulated / limited                                             |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Nested KVM (`/dev/kvm` inside the VM), real Firecracker v1.17.0 boots           | Nested virtualization, not bare metal; timings are slower       |
| Real jailer: uid/gid 10000, chroot, cgroup v2, pid namespace, copies            | One host only; no controller/scheduler/multi-host               |
| Real shipped systemd unit (no drop-in), `systemctl restart`, `kill -9`, journal | systemd 255/Ubuntu 24.04 only; another distro may differ        |
| Real nftables rules, taps, conntrack, DNAT, masquerade                          | The "internet" is a veth + netns with TEST-NET-1 (192.0.2.0/24) |
| Real nmap from a separate network namespace                                     | nmap scans the test host's public test IP, not a real public IP |
| Real guest MMDS v2 flag delivery and byte-exact service response                | Test guest/service is a fixture (`guest-start`); no TLS/Traefik |
| Real `host-setup.sh`, unit and agent binaries from this checkout                | Nothing replaced: no version wrapper, no capability drop-in     |

## Leftovers / cleanup

- The VM was stopped by `run.sh`'s trap; the overlay from this run is kept in
  `~/.cache/rctf-vmtest/` for fast reruns (`vm.sh destroy` removes it), and
  `vm.sh status` reports `stopped`.
- The repros were executed inside the VM on 2026-11-08 (the version,
  capability/setuid and Bun-stdin outputs above are from those runs).
- No `qemu-system-x86_64`, seed HTTP server or ssh tunnel remains on the host.
- The shared artifact cache (`~/.cache/rctf-fc-smoke`) is untouched; the VM
  image cache (`~/.cache/rctf-vmtest`) keeps only `noble-base.img`, the
  overlay and the ssh key.
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
