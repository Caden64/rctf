# vmtest results — 2026-11-08 (assertion-hardening rerun)

Real execution as root inside a throwaway QEMU VM. **Nothing privileged was run
on the developer machine.** The host only ran `qemu-system-x86_64` as the login
user; every root operation happened inside the VM.

- Host: Linux 7.2.14-arch1-1, AMD SVM, `kvm_amd.nested=1`, `/dev/kvm` 0666.
  This run used `VM_DIR=~/.cache/rctf-vmtest-t3-21cbbd46`,
  `VM_SSH_PORT=2422`, `VM_SEED_PORT=8201` so another worker's VMs and ports were
  not touched.
- VM: Ubuntu 24.04 cloud image from the **dated** `noble/20261017/` directory
  (pinned SHA256 `04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94`;
  cached image re-hashed before boot), kernel 6.8.0-147-generic, systemd
  `255.4-1ubuntu8.18`, nftables 1.0.9, conntrack-tools 1.4.8, nmap 7.94SVN,
  Python 3.12.
- Guest runtime: Firecracker/jailer v1.17.0, kernel 6.1.155 (Firecracker CI
  bucket), busybox 1.35.0, Bun 1.4.4 (`bun-linux-x64.zip` verified against the
  release `SHASUMS256.txt` and the pinned digest
  `bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c`).
- Command: `deploy/firecracker/vmtest/run.sh` (full run, shipped unit with no
  drop-in, shipped `host-setup.sh` with no version wrapper).
- Transcript: `~/.cache/rctf-vmtest-t3-21cbbd46/logs/run-20261108-122237.log`.
- VM stopped (`vm.sh status` → `stopped`); the qcow2 overlay is kept for fast
  reruns (`vm.sh destroy` removes it). No qemu/seed processes from this run
  remain on the host.

## Summary (this run)

All checks pass. This assertion-hardening pass raised the total from 151 to
**180** assertions without weakening a check. The first run of the tightened
harness exposed three harness bugs (not product bugs); they were fixed and the
full run was repeated (see "What changed in this pass"). No new product bug was
found.

| Check                               | Assertions       | Verdict                                                                                                                                                                                                 |
| ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-host-setup.sh` (a)              | 18 pass / 0 fail | **PASS** — `host-setup.sh` as shipped accepts Firecracker 1.17.0, creates dirs/modes, applies sysctl, idempotent.                                                                                        |
| `10-agent-systemd.sh` (b)           | 31 pass / 0 fail | **PASS** — shipped unit (byte-identical, no drop-in) starts the agent, `KillMode=process`, preflight `accepting:true`, `CAP_SETUID`+`CAP_SETGID` effective and ambient.                                  |
| `20-jailer-instance.sh` (c)         | 39 pass / 0 fail | **PASS** — unit byte-identical/no drop-in; real jailer create, uid/chroot/cgroup/tap, MMDS flag, fail-closed flag-absence scans with planted-canary controls, full teardown, fencing.                     |
| `30-restart-survival.sh` (d)        | 33 pass / 0 fail | **PASS** — VM survives `systemctl restart` and `kill -9`, `.vm.pid` stays the original PID, `vm-identity.json` matches live `/proc`; CAP_SYS_PTRACE safe-failure outcome asserted.                       |
| `40-net-tests.sh` (e)               | 12 pass / 0 fail | **PASS** — `FC_REAL=1 bun test test/net` as root: **105 tests, 0 fail**; the namespace suite also passes as `ubuntu`.                                                                                    |
| `50-conntrack-quarantine.sh` (f)    | 24 pass / 0 fail | **PASS** — `conntrack -L` must exit 0; DNAT reply and masqueraded egress original tuples both seeded and flushed; quarantine holds.                                                                       |
| `60-egress-dnat-isolation.sh` (g,h) | 23 pass / 0 fail | **PASS** — egress masquerade/deny, public DNAT, team isolation with control; nmap over 1-10000 + `tcpPortRange` sees only published ports, plus explicit 22/7001 probes.                                   |

Total: **180 passed, 0 failed**.

## What changed in this pass (2026-11-08, assertion hardening)

1. **Verified Ubuntu image.** `vm.sh` now uses the dated
   `noble/20261017/` directory, pins the image SHA256, checks the published
   `SHA256SUMS`, and GPG-verifies `SHA256SUMS.gpg` with the pinned Ubuntu cloud
   image signing fingerprint `D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81`
   (GPG verification succeeded in this environment). The cached image is
   re-hashed against the pinned digest before every boot and the digest is
   recorded in `noble-base.img.sha256` / `.meta`. Missing GPG/key infrastructure
   is reported honestly and still fails closed on the pinned SHA256.
2. **Verified Bun zip.** `provision.sh` downloads the release `SHASUMS256.txt`
   for pinned Bun 1.4.4, requires the `bun-linux-x64.zip` entry to equal a
   pinned digest, and verifies the downloaded zip before installing.
3. **Conntrack check fails closed.** `50-conntrack-quarantine.sh` now requires
   `conntrack -L` exit 0 before and after `DELETE`; it seeds a real DNAT flow
   (guest in the reply-source tuple) and a real masqueraded egress flow (guest
   in the original-source tuple), asserts both entries carry both tuples, and
   asserts both are gone afterwards. The "four directions" wording was replaced
   with exactly what is proven.
4. **Flag-absence probes fail closed with controls.** `20-jailer-instance.sh`
   requires four searchable roots, counts and prints the files scanned (>0),
   distinguishes grep's "not found" (1) from a probe error (2), `test -f`s the
   per-instance rootfs before `grep -a`, and requires planted-canary positive
   controls to be found by the same tree, journal and binary scans. The journal
   scan now covers the whole journal, not just one unit.
5. **Inode identity cannot compare empty strings.** `20-jailer-instance.sh`
   requires non-empty `stat` results for `/proc/<pid>/exe` and `/proc/<pid>/root`,
   never silences `stat`, and aborts the inode/host-identity checks if
   `kill -0` failed.
6. **Re-adoption is asserted, not implied.** `30-restart-survival.sh` checks
   agent-reported `.vm.pid` equals the original PID after both `systemctl
   restart` and `kill -9`, and compares `vm-identity.json` (`jailRoot` device+
   inode, `exePath`, exe dev+inode, uid) against live `/proc/<pid>/{exe,root,
   status}`.
7. **CAP_SYS_PTRACE outcome is a hard assertion.** The check records the live
   PID starttime and requires the documented safe outcome when the capability
   is removed: process alive and unsignalled (same starttime) with `errored`
   state and a `vm died`/authentication message. A killed VM or a still-running
   record now fails. After restoring the cap it requires process, jail, tap and
   process-record cleanup.
8. **Wider nmap range.** `60-egress-dnat-isolation.sh` scans `1-10000` plus the
   configured `tcpPortRange`, and runs a targeted `22,7001` scan because the
   wide scan suppresses its closed-port lines. The visible open set must be
   exactly the two published ports.
9. **Port ownership and cleanup.** `vm.sh` defaults to ssh 2422 / seed 8201,
   refuses to boot when either port is bound by a process it did not record,
   and `stop`/`destroy` reap the seed server by recorded PID. `run.sh` uses a
   per-run scratch directory so concurrent harness copies cannot collide on
   `/tmp` tarball names.

Harness bugs found by the first run of this pass (all fixed before the passing
run): (i) `/proc/<pid>/root` `readlink` is `/` for a chrooted process, so the
jail-root comparison must use device+inode; (ii) the egress flow matcher matched
the DNAT reply tuple too and must inspect the original tuple only; (iii) nmap
does not print individual `closed` lines when the scan has many closed ports,
so 22/7001 need a targeted scan.

## Previous run (2026-11-08, before this hardening)

The earlier full run reported **151 passed, 0 failed** and documented two
product fixes (B1 version parsing, B2 systemd capabilities) plus a harness-only
Bun-stdin finding. Those fixes are still in the tree; the detailed sections
below are updated with this run's counts and evidence.


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

## c) jailer-mode create (39 assertions)

This check starts by asserting the installed unit is byte-identical and that no
drop-in exists, then creates over the agent API (`PUT /v1/instances/:id`) with
`mode: jailer`:

```text
PASS [01]: installed unit is byte-identical to the repository unit
PASS [02]: no systemd drop-in installed (shipped unit alone)
create: HTTP 200 {"state":"starting", ... "endpoints":[{"host":"192.0.2.1","port":30000}]}
PASS [06]: jailer launched Firecracker under the shipped unit (no drop-in)
pid=2278 guest=10.200.0.2 host=10.200.0.1 tap=fctap0 public=30000
jail=/srv/jailer/firecracker/vmtest1794165789j1/root
```

Verified: process alive, uid `10000`, jailed executable (`/proc/<pid>/exe` is
`/firecracker` and its device+inode equals the jail copy), `/proc/<pid>/root`
device+inode equals the jail root (with non-empty `stat` results and an abort if
the process is dead), `--id` on the cmdline exactly once, per-instance cgroup
`/sys/fs/cgroup/firecracker/<id>` with `pids.max=512` and the pid as member,
real `tun type tap` with alias `rctf-fc:rctf-fc` and the host /30 address.

Flag delivered via MMDS v2 and served byte-exactly:

```text
guest served: rctf{vmtest-jailer-1794165789-canary}
guest probe: peer:10.200.0.6=blocked ... outside=REACHED
```

The flag-absence probes now fail closed and prove they are sensitive:

```text
PASS [22]: scanned 7 files under 4 searchable roots
PASS [23]: flag is absent from agent state, run dir, jail tree and Traefik dir (7 files)
PASS [24]: positive control: tree scan found the planted canary in its scanned file
PASS [25]: flag is absent from the journal (2681 lines searched)
PASS [26]: positive control: journal scan finds the planted canary
PASS [27]: flag is absent from the firecracker command line
PASS [28]: flag is absent from the per-instance rootfs disk image
PASS [29]: flag is absent from all 2 base images (tested non-empty, readable files)
PASS [30]: positive control: binary (grep -a) scan finds a planted canary
```

The flag was **absent** from the agent state dir, per-instance run dir, jail
tree (including `rootfs.ext4`), Traefik dir, whole journal, Firecracker cmdline,
and both base images. Probe errors (`grep` rc=2, missing/unreadable roots or
images, empty journal) fail the check instead of passing as "absent". (The test
guest keeps its flag on tmpfs; the reference smoke guest copies it to `/www` on
the rootfs, which is guest behaviour, not an agent leak.)

Delete: `HTTP 200 {"state":"stopped", ...}`; process, jail directory,
per-instance cgroup, tap and both nft rule sets removed; re-create of the
deleted id fenced with HTTP 409.

## d) restart / `kill -9` / CAP_SYS_PTRACE (33 assertions)

```text
fc pid=2561 guest=10.200.0.6 tap=fctap1 agent=1991
PASS systemctl restart replaced the agent process (1991 -> 2601)
PASS firecracker survived systemctl restart (KillMode=process)
PASS guest still serves its flag after restart
PASS restarted agent re-adopted the instance as running
PASS tap was preserved across the restart
PASS agent-reported .vm.pid is the original PID after systemctl restart
PASS vm-identity instanceId matches vmtest1794165797r1
PASS vm-identity uid 10000 matches live /proc/<pid>/status and jailUid
PASS vm-identity jailRoot dev:ino 64769:533023 matches live /proc/<pid>/root
PASS live executable is /firecracker inside the chroot
PASS vm-identity exePath is the live jail copy
PASS vm-identity exe dev:ino 64769:544112 matches live /proc/<pid>/exe
PASS systemd restarted the agent after kill -9 (2601 -> 2675)
PASS firecracker survived kill -9 of the agent
PASS agent re-adopted the VM after kill -9 (strict identity)
PASS agent-reported .vm.pid is the original PID after kill -9
PASS vm-identity ... (same six fields re-checked after kill -9)
```

The `vm-identity.json` sidecar is compared field-by-field with the live
process: `instanceId`, `uid`, `jailRoot` (device+inode vs `/proc/<pid>/root`),
`exePath`, and exe device+inode vs `/proc/<pid>/exe`. `/proc/<pid>/root`
`readlink` is `/` for a chrooted process, so the path comparison correctly uses
the inode.

CAP_SYS_PTRACE experiment (a test-only drop-in removes it; the shipped
`AmbientCapabilities=` stays in effect):

```text
PASS drop-in really removed CAP_SYS_PTRACE from the agent's effective set
state without CAP_SYS_PTRACE: errored
live pid without CAP_SYS_PTRACE: alive=1 start=3821 (was 3821)
reported state/message: errored (vm died)
PASS without CAP_SYS_PTRACE the agent cannot authenticate/re-adopt the running VM
PASS the errored record carries an authentication/verification failure message
PASS safe outcome: VM left alive and unsignalled (same starttime), record errored
PASS with CAP_SYS_PTRACE restored the agent reclaimed and destroyed the
     unauthenticated VM
PASS after restore the instance is no longer running (state=errored)
PASS jail dir removed after cleanup
PASS tap removed after cleanup
PASS no firecracker process for vmtest1794165797r1 remains
```

This is now a hard assertion either way: a killed VM, a different PID/starttime,
a `running` record, or a missing authentication message fails the check. The
recorded safe outcome is the one documented below; after restoring the cap the
agent must clean up, and that clean-up is required.

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

## f) conntrack flush and reuse quarantine (24 assertions)

```text
guest=10.200.0.10 tap=fctap2 index=2 public=30002 pid=3490
PASS egress:true guest produced a real outbound flow through masquerade
conntrack entries involving 10.200.0.10: 6
DNAT entry:   tcp 6 431997 ESTABLISHED src=192.0.2.2 dst=192.0.2.1 sport=40058 dport=30002
              src=10.200.0.10 dst=192.0.2.2 sport=8080 dport=40058 [ASSURED]
egress entry: tcp 6 117 TIME_WAIT src=10.200.0.10 dst=192.0.2.2 sport=51594 dport=9999
              src=192.0.2.2 dst=192.0.2.1 sport=9999 dport=51594 [ASSURED]
PASS conntrack tracks the guest address before release
PASS DNAT flow tracked with the guest in the reply-source direction
PASS masqueraded egress flow tracked with the guest in the original-source direction
PASS DNAT flow entry carries both original and reply tuples
PASS egress flow entry carries both original and reply tuples
delete: HTTP 200 {"state":"stopped", ...}
PASS release flushed every conntrack entry for the guest address (original and reply tuples)
PASS the DNAT reply tuple for the public port was flushed
PASS the masqueraded egress original tuple was flushed
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

`conntrack -L` must exit 0 before and after `DELETE`; a tool failure is reported
as a failure, not as "zero entries". The DNAT flow is a real held `nc` session
from the outside namespace; the egress flow is the guest's real probe to the
outside HTTP service. Both tuple directions are present before release and both
are gone afterwards. Teardown (process/jail/cgroup/tap/nft) is asserted in the
same check.

## g/h) egress, DNAT, isolation, nmap (23 assertions)

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
PASS nmap scan completed over ports 1-10000,30000-30010
PASS nmap sees exactly the published TCP ports as open
PASS targeted nmap scan of management ports 22,7001 completed
PASS management sshd (port 22) is not exposed on the public test interface
PASS the agent API (port 7001, bound to 127.0.0.1) is not exposed on the public interface
```

The control flushes both owned tables (`inet rctf_fc`, `arp rctf_fc_arp`) and
restores the exact saved ruleset; isolation returns afterwards. This proves the
"blocked" measurements are sensitive, not a false negative.

nmap from the outside namespace against the host's public test address. The
wide scan covers `1-10000` plus the configured `tcpPortRange` (`30000-30010`):

```text
Not shown: 10009 closed tcp ports (reset)
30004/tcp open  amicon-fpsu-s
30005/tcp open  unknown
```

Because nmap suppresses individual `closed` lines in a wide scan, a second
targeted scan asserts the management ports explicitly:

```text
22/tcp   closed ssh
7001/tcp closed afs3-callback
```

Only the two published DNAT ports are open. Port 22 is closed because the VM's
management sshd is bound to the QEMU management address (10.0.2.15) only; the
agent API is bound to 127.0.0.1 and does not appear. This is the exact range
scanned, not a claim about all 65535 ports.

## Earlier product fixes (previous run; still in the tree)

These were found and fixed before this assertion-hardening pass. The current
run re-verified them under the tightened checks (00 is still 18/0, 10 is 31/0,
20 is 39/0 with the added absence controls).

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
- Evidence: check 10 is 31/0 (was 28/1), check 20 is 39/0 in this run; `CapEff`
  was `0x82c31eb` with `CapAmb=0xc0` under the shipped unit alone.
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
  `~/.cache/rctf-vmtest-t3-21cbbd46/` for fast reruns (`vm.sh destroy` removes
  it), and `vm.sh status` reports `stopped`. Only PIDs recorded in that
  directory were signalled; no other worker's qemu/seed processes were touched.
- This run used ports 2422 (ssh) and 8201 (seed). `vm.sh` refused to boot if
  either was bound by a process it did not own.
- The repros were executed inside the VM on 2026-11-08 (the version,
  capability/setuid and Bun-stdin outputs above are from those runs).
- No `qemu-system-x86_64`, seed HTTP server or ssh tunnel from this run remains
  on the host.
- The shared artifact cache (`~/.cache/rctf-fc-smoke`) is untouched; the VM
  image cache for this run keeps only the verified `noble-base.img` (plus its
  recorded digest/metadata), the overlay and the ssh key.
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
