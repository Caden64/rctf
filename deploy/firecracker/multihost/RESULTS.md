# Multi-host verification — results

## Final run (lifecycle/observation hardening) — 2026-11-08 15:19:52–15:24:49 (America/Denver)

Command:

```sh
./deploy/firecracker/multihost/run.sh
```

Dynamic identifiers for this run: run dir `/tmp/opencode/fcmh-ZmpSUT`, ssh ports
`43817` / `60533`, controller forward `44799`, private link
`/tmp/opencode/fcmh-ZmpSUT/link/{host-a,host-b}.sock` (QEMU unix-datagram, no
multicast group or port). Exit code **0**.

```
==> pidfile authentication selftest (unprivileged decoy processes)
pidfile selftest passed (72 checks)
...
private-link checks: 24 passed, 0 failed
private link works and is host-local only
...
PASS [run.complete] every scenario ran to completion -- 12/12 scenarios
RESULT: 138 passed, 0 failed, 138 assertions
driver exit code: 0
```

Both QEMUs were stopped through their authenticated pidfiles by the EXIT trap;
`pgrep -f qemu-system-x86_64` returned nothing afterwards, `vm.sh status`
printed `stopped name=host-a` / `stopped name=host-b`, the two link socket
files were removed (the `link/` directory remains mode 0700), and both
overlays were removed only after that definitive status. The host ran no
privileged command: only QEMU, the seed HTTP servers and the ssh client ran as
the login user.

### What changed in this pass

1. **Pidfile outcomes are distinct and fail closed.** `pidguard.py` is now
   `version=3` and records the PID namespace (`/proc/<pid>/ns/pid`) in addition
   to the boot id, start ticks, executable and argv. Exit codes are `0`
   authenticated/stopped, `1` definitely dead/stale (the only case that may
   remove a pidfile), `4` identity mismatch (a live process exists that is not
   the record; keep the record) and `3` observation failure (keep the record
   and everything it protects). `stop_recorded` propagates `3`/`4`;
   `destroy` refuses to remove the overlay/console/seed when shutdown is
   unconfirmed; `run.sh` removes an overlay only when the authenticated status
   says the VM stopped. A link endpoint is unlinked only in the definitive
   stopped state.
2. **Observers do not mutate; mutators are serialised.** `status`/`pid` use a
   non-mutating observer. `create`/`start`/`stop`/`destroy`/`kill` hold the
   per-VM lifecycle `flock`, and both spawned daemons close fd 9. QEMU writes
   its bare numeric pidfile to `qemu.pid.raw`; the authenticated record is
   atomically renamed onto `qemu.pid`, so a concurrent status can never delete
   a live VM's pidfile or observe a bare intermediate. The selftest runs 60
   concurrent observes while the record is rewritten 60 times and requires the
   live record to survive.
3. **Names and link endpoints are constrained.** VM names must match
   `^[A-Za-z0-9][A-Za-z0-9_-]*$` (no `.`, `..`, dots or separators) and the
   resolved VM directory must be a direct child of the resolved `MH_VM_ROOT`.
   `linkguard.py` (new) requires the link directory to be a direct child of the
   trusted root (`MH_LINK_ROOT`, set by `run.sh` to the 0700 run directory),
   with no symlink and no group/other write up to that root, and removes an
   endpoint relative to an opened `O_DIRECTORY|O_NOFOLLOW` fd after `lstat`
   through the same fd (only an AF_UNIX socket owned by this uid). The selftest
   covers `.`/`..`/separator/dot names, a symlink escape, a symlinked or
   0755 link directory, an endpoint outside the directory, a regular file, a
   symlink and a live socket.
4. **Interrupted drivers cannot report success.** `driver.ts` tracks the 12
   expected scenarios and adds a `run.complete` assertion. SIGINT/SIGTERM
   record a failure, keep the real `130`/`143` exit code, and a normal exit is
   0 only when every assertion passed and every scenario completed.
   `globalCleanup` now collects its best-effort errors into `cleanupErrors`, so
   L.6 no longer claims "without swallowed errors" while discarding reasons.
5. **nft observation covers both tables.** `hoststats.sh` counts per-lease
   entries in `arp rctf_fc_arp` as well as `inet rctf_fc`, and reports `-1` +
   `observationErrors` if `nft list tables` or either table read fails.

### Honest notes

- No product bug was found; `apps/**/src` and `packages/**` were not edited.
- The task text at the previous pass said the lifecycle overview in
  `apps/firecracker-instancer/ARCHITECTURE.md` released the reservation on a
  transport error. It now states the normative behaviour (definitive
  rejection → release/fail over; ambiguous transport/5xx → keep the row,
  reservation and key until adoption or confirmed fencing), matching
  `src/controller/service.ts`.
- The link is still a host-local unix-datagram point-to-point segment, not a
  physical LAN; host loss is a QEMU SIGKILL, not a power cut.

Dated log of what actually ran. All runs are on the reference development host:

- Arch Linux, kernel `7.2.14-arch1-1`, 16 vCPU, 54 GiB RAM, `/dev/kvm` with
  nested virtualization.
- QEMU `11.1.3`, bun `1.4.4`.
- Guest VMs: Ubuntu 24.04.5 cloud image, 2 vCPU / 3584 MiB / 30 GiB qcow2
  overlay each, Firecracker + jailer **v1.17.0**, shipped
  `deploy/firecracker/host/rctf-firecracker-agent.service` (jailer mode),
  `host-setup.sh` run as shipped.
- Controller inside host-a: real `src/controller/index.ts`, real `bun:sqlite`.
  Config: two hosts, `maxInstances=2`, `memMiB=4096` each,
  `heartbeatIntervalSeconds=1`, `hostTimeoutSeconds=4`,
  `hostProbeTimeoutSeconds=2`, `hostLostSeconds=300`,
  `maxClockSkewSeconds=10`, `reconcileIntervalSeconds=2`,
  `reaperIntervalSeconds=1`, `createFenceSeconds=10`.
- Private link (current harness): QEMU `-netdev dgram` over two `AF_UNIX`
  sockets in the run's mode-0700 `link/` directory, one bound by each VM
  (`local.path`/`remote.path` mirrored); `10.77.0.10` (host-a) and
  `10.77.0.11` (host-b). No multicast, no UDP/TCP port, no host bridge/tap,
  so it cannot reach the LAN. Controller→agent HTTP over it uses distinct
  per-host bearer tokens. This machine reaches the controller through one ssh
  forward and observes the agents through the same ssh management channel.
  Results below dated before this hardening pass describe the multicast link
  that was in use then; they are kept as history.

## Previous run (pidfd + fail-closed observation hardening) — 2026-11-08 14:25:48–14:33:02 (America/Denver)

Command:

```sh
./deploy/firecracker/multihost/run.sh
```

Dynamic identifiers for this run: run dir `/tmp/opencode/fcmh-2KS6vh`, ssh ports
`55501` / `49641`, controller forward `52017`, private link
`/tmp/opencode/fcmh-2KS6vh/link/{host-a,host-b}.sock` (QEMU unix-datagram, no
multicast group or port). Exit code **0**. The 7m14s includes the two boots,
provisioning, the 20-way race, the partition/host-loss restarts and both agent
restarts.

```
==> pidfile authentication selftest (unprivileged decoy processes)
pidfile selftest passed (35 checks)
...
PASS [link.24] the controller API binds loopback only (reached through the ssh forward)
private-link checks: 24 passed, 0 failed
private link works and is host-local only
...
RESULT: 137 passed, 0 failed, 137 assertions
driver exit code: 0
```

Both QEMUs were stopped through their authenticated pidfiles by the EXIT trap;
`pgrep -x qemu-system-x86` returned nothing afterwards, `vm.sh status` printed
`stopped name=host-a` / `stopped name=host-b`, and the cleanup removed both link
socket files (the `link/` directory remains mode 0700). The host ran no
privileged command: only QEMU, the seed HTTP servers and the ssh client ran as
the login user.

### What changed in this pass

1. **All signalling goes through a pidfd.** The shared helper
   `deploy/firecracker/vmtest/pidguard.py` is now used by this `vm.sh` too
   (looked up next to the script, then `../vmtest/pidguard.py`). It opens
   `os.pidfd_open(pid)` first, validates the recorded boot id, start ticks,
   executable, required argv and recorded argv while holding the fd, re-reads
   the start ticks immediately before the signal, and sends TERM/KILL only
   with `signal.pidfd_send_signal` on that same fd. A reused PID makes the
   signal fail with ESRCH instead of resolving the PID again. `stop_recorded`
   is now one helper invocation (authenticate + signal + wait), so there is no
   check-then-`kill <pid>` gap for QEMU or the seed server.
2. **The host-loss crash no longer reads a PID and calls `process.kill`.**
   `driver.ts` scenario 5 invokes `vm.sh kill`, which authenticates the
   recorded QEMU and SIGKILLs it through the pidfd (new `pidkill`). The driver
   fails the scenario if that command does not exit 0. `process.kill` is no
   longer used anywhere in the driver.
3. **Link endpoints are only removed when provably ours.** `prepare_link`
   rejects `.`/`..` components, symlinked link directories, and directories
   that are not mode 0700 owned by the current uid. `cleanup_link_endpoint`
   only removes an entry that is an AF_UNIX socket (not a regular file,
   symlink or directory) owned by the current uid inside such a directory, and
   `cleanup_link_endpoint_if_stopped` first proves through the authenticated
   pidfile that the VM is not running. Boot's unconditional `rm -f
"$LINK_LOCAL"` and stop's unconditional unlink are both gone.
4. **Lifecycle operations are serialised.** `create`, `start`, `stop`,
   `destroy` and `kill` hold an exclusive `flock` on
   `$VM_DIR/.lifecycle.lock` for the whole operation; QEMU and the seed server
   close fd 9 (`9>&-`) so the daemons do not inherit the lock. `destroy` now
   calls the stop functions directly instead of re-execing `vm.sh stop` (which
   would deadlock on its own lock).
5. **Host observation is fail-closed.** `hoststats.sh` checks the exit status
   of `pgrep`, `ip` and `find` separately, treats only `pgrep` exit 1 as
   "no match", and reports `-1` plus an `observationErrors` entry for anything
   else (including an unreadable state directory or state record). The driver
   rejects any `-1`/`observationErrors` in `hostStats()`, so `waitDestroyed`,
   the leftover assertions and every other absence check fail instead of
   passing on an unobserved zero.
6. **The Firecracker probe preserves pgrep's status.** `probeFirecracker` runs
   `pgrep -a -x firecracker` without `|| true`: exit 1 means no process, any
   other status (127 missing binary, 2 error, ssh failure) is a probe error
   that fails the assertion.
7. **The self-test grew from 19 to 35 checks.** New: the two PID-reuse race
   cases (changed start ticks before the signal; naive re-resolution to a
   second decoy after validation, which must not be signalled) and three link
   cases (a regular file given as `--link-local` and a symlink are not
   deleted; a socket of a still-running authenticated QEMU is not unlinked),
   plus a positive control that the leftover socket of a stopped QEMU is
   removed.

### Residual races (honest)

- The pidfile _record_ is sampled after QEMU writes it, without a pidfd. A PID
  reuse in that microsecond window could record a different process, but that
  record cannot authenticate: verification also requires this VM_DIR's
  `-pidfile` argv and the recorded argv (including the run-specific link
  spec), which an unrelated replacement does not carry. The record is never a
  direct signal target.
- The link endpoint's owning QEMU is proven gone through the authenticated
  pidfile, not through the socket. A process that is not this VM_DIR's QEMU
  and that deliberately bound a socket at this run-specific path could not be
  distinguished, but the path is inside a per-run 0700 directory that no other
  local user can reach; a regular file or symlink is never removed.
- `flock` serialises cooperation through this script. A caller that edits or
  removes pidfiles directly bypasses it, but no signal is sent without the
  full identity check.
- A process stuck in uninterruptible sleep after SIGKILL makes the helper exit
  3; the pidfile is left in place, `stop` reports it, and the link endpoint is
  not unlinked (the running check still authenticates the QEMU).
- `pidguard.py` needs Linux >= 5.3 and Python >= 3.9; without pidfd support the
  selftest fails and `run.sh` refuses to continue.

## Previous run (link + pidfile hardening) — 2026-11-08 13:52:43–13:59:58 (America/Denver)

Command:

```sh
./deploy/firecracker/multihost/run.sh
```

Dynamic identifiers for this run: run dir `/tmp/opencode/fcmh-cYdNuX`, ssh ports
`40875` / `56637`, controller forward `42977`, private link
`/tmp/opencode/fcmh-cYdNuX/link/{host-a,host-b}.sock` (QEMU unix-datagram, no
multicast group or port). Exit code **0**. The 7m15s includes the two boots,
provisioning, the 20-way race, the partition/host-loss restarts and both agent
restarts.

```
==> pidfile authentication selftest (unprivileged decoy processes)
pidfile selftest passed (19 checks)
...
PASS [link.24] the controller API binds loopback only (reached through the ssh forward)
private-link checks: 24 passed, 0 failed
private link works and is host-local only
...
RESULT: 137 passed, 0 failed, 137 assertions
driver exit code: 0
```

Both QEMUs were stopped through their authenticated pidfiles by the EXIT trap;
`pgrep -af '^qemu-system'` returned nothing afterwards, and the cleanup removed
both link socket files (the `link/` directory remains mode 0700).

### Per-check outcome

| Group                                    | Result   | Assertions | Evidence highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 hosts register/heartbeat/accept + link | **PASS** | 10/10      | `/v1/hosts` healthy; `hosts.accepting=1` in controller SQLite; direct agent `/v1/info` `accepting:true`, `checks.recovered:true`; `lastSeenMs` advanced 3014/3015 ms; unauthenticated agent call `401`; KVM+jailer preflight true. New 1.8–1.10: recorded QEMU command lines contain exactly the two mirrored `dgram,local.type=unix` netdevs and no multicast/inet/host backend, `link/` is mode 0700 uid 1000 and both endpoints are unix sockets; both agents listen only on `10.77.0.10:7001` / `10.77.0.11:7001` on the MAC-pinned `ens4`; each VM's only route to the peer is `ens4` with the peer's private MAC; this machine has no `10.77.0.x` address or listener. |
| 2 placement/pinning/jailer + memory skew | **PASS** | 22/22      | equal budgets: `a,b,a,b` (most-free-memory, host-id tie-break); with host-b's configured memory halved to 2048 MiB: `mem-1,mem-2` on host-a then `mem-3,mem-4` on host-b (`a,a,b,b`), proving the scheduler follows free memory rather than alternating. Extend/delete touched only the pinned agent; both guests ran under the real jailer (uid 10000, `/firecracker`, `/proc/<pid>/root == jail root`, 64769:531797 / 64769:532138); the deleted guest was definitively refused (probe `timeout/28`), not a probe error.                                                                                                                                                   |
| 3 capacity + sampled 20-way race         | **PASS** | 8/8        | host-a filled to 2; 4th create on host-b; 5th ⇒ `no capacity: insufficient instance slots…`; 20 concurrent creates ⇒ 4 accepted, 16 `no_capacity`; `/v1/hosts` sampled every 50 ms during the race: `samples=4 maxReserved=2/2 over=0` (never above capacity at any sample), 4 Firecracker processes; capacity returned after deletes.                                                                                                                                                                                                                                                                                                                                       |
| 4 drain/undrain                          | **PASS** | 8/8        | host-a draining, new create on host-b, existing guest kept serving, undrain restored placement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5 host loss                              | **PASS** | 15/15      | healthy removal `409`; QEMU `SIGKILL` ⇒ unhealthy after ~5.9 s; new create on host-a; the B instance reported `errored` with **exactly one row**, still pinned to host-b, no agent record for that id on host-a; removal `204` ⇒ `lost`, reservation 0, host draining; the key was freed and the team recreated on host-a; host-b's QEMU was restarted through the same authenticated pidfile/link arguments, re-adopted/wrote off, cleaned the tombstone, had no record/process/tap; exactly one live instance for the team; undrain restored service.                                                                                                                      |
| 6 network partition + dead-man           | **PASS** | 16/16      | nftables drop ⇒ unhealthy after ~4.2 s; create during partition on host-a; host-b instance reported `errored` with **exactly one row** pinned to host-b and no host-a record; the short row stayed pinned to host-b (`deleting`); the agent state recorded the live pid and real `expiresAtMs`; the agent destroyed the guest itself at deadline+1525 ms (`expiresAtMs + 10 s` grace, 1 s sweep) with listing, state file, Firecracker process and pid all definitely absent; the long guest stayed alive; unblock ⇒ healthy in ~0.4 s, long guest still served, short row removed.                                                                                          |
| 7 clock skew                             | **PASS** | 9/9        | +59.3 s and −60.6 s measured and flagged; host stayed healthy; creates refused with `no capacity: all hosts exceed the maximum clock skew` and no row/VM; corrected clock ⇒ −252 ms. host-a stayed **drained**, so the post-correction create had to land on host-b: 7.7 confirms `host=host-b`, 7.8 fetches the real guest flag from that instance, and only then 7.9 undrains host-a.                                                                                                                                                                                                                                                                                      |
| 8 cross-host isolation                   | **PASS** | 12/12      | two instances of one team and two of another, two per host; every endpoint names its own host address/agent port; each guest served exactly its own flag; cross-host correct address/port worked (HTTP 200 both ways); the other host's port was **definitively refused** (`refused/7`); four distinct flags never crossed.                                                                                                                                                                                                                                                                                                                                                  |
| 9 controller restart                     | **PASS** | 7/7        | SIGKILL restart while instances spanned both hosts; same ids, same pinned hosts, one VM each, both guests served; one live row per team; duplicate create returned the same id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10 token mismatch                        | **PASS** | 6/6        | wrong host-b token ⇒ unhealthy after ~4.0 s; `last_seen_ms` frozen (`advance=0`) while the wrong token was in use; direct agent still `accepting:true`; creates on host-a; 14 rejection lines in the controller log; restoring the token made host-b healthy.                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11 ambiguous create                      | **PASS** | 10/10      | in-guest fault proxy: a held create produced exactly one `creating` row pinned to host-b and a `starting` answer, the request was captured (no VM on either host), the reconciler fenced it after `createFenceSeconds` (row removed, key freed), the agent tombstone was durable, and replaying the captured PUT returned **409** with no VM; a response-swallowed create was adopted with the same id on host-b, served its flag, one row, no host-a duplicate.                                                                                                                                                                                                             |
| 12 agent restart with a live VM          | **PASS** | 7/7        | `systemctl restart` re-adopted the **same Firecracker pid** (22242) and kept serving; `kill -9` of the agent was recovered by systemd and re-adopted the same pid; one controller row stayed pinned to host-a; a new create still spread to host-b.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| L leftovers                              | **PASS** | 7/7        | 0 controller rows (the SQLite dump succeeded), 0 agent instances, 0 Firecracker processes, 0 taps, 0 state records, 0 per-lease nft rules on both hosts; cleanup had no swallowed errors; both agents answered `200`.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Verbatim excerpts (final run)

```
==> pidfile authentication selftest (unprivileged decoy processes)
pidfile selftest passed (19 checks)
PASS [link.1] host-a private NIC is a host-local unix-datagram link (host-a.sock -> host-b.sock)
PASS [link.3] host-a has exactly two netdevs (user-mode management + unix-dgram private) and no host-network or port-forward path to the private link
PASS [link.19] link directory /tmp/opencode/fcmh-cYdNuX/link is mode 0700 and owned by uid 1000
PASS [link.21] no interface on this machine carries 10.77.0.10 or 10.77.0.11 (the private L2 does not exist on the host)
PASS [link.24] the controller API binds loopback only (reached through the ssh forward)
private-link checks: 24 passed, 0 failed

PASS [1.8] the private link is a host-local unix-datagram point-to-point link, not multicast (recorded QEMU command lines + socket objects) -- netdevs a=["user,id=n0,hostfwd=tcp:127.0.0.1:40875-:22","dgram,id=n1,local.type=unix,local.path=/tmp/opencode/fcmh-cYdNuX/link/host-a.sock,remote.type=unix,remote.path=/tmp/opencode/fcmh-cYdNuX/link/host-b.sock"] b=["user,id=n0,hostfwd=tcp:127.0.0.1:56637-:22","dgram,id=n1,local.type=unix,local.path=/tmp/opencode/fcmh-cYdNuX/link/host-b.sock,remote.type=unix,remote.path=/tmp/opencode/fcmh-cYdNuX/link/host-a.sock"] dirMode=700 owner=1000 unixSockets=true hostAddr=false
PASS [1.9] each agent's private-NIC address is MAC-pinned and is the only address it listens on -- ifaceA=ens4 macA=true ifaceB=ens4 macB=true listenA=[...,"10.77.0.10:7001"] listenB=[...,"10.77.0.11:7001"]
PASS [1.10] the agents private-link addresses are reachable only across that link (peer route + MAC, and absent from the developer machine) -- routeA=10.77.0.11 dev ens4 src 10.77.0.10 ... neighA=10.77.0.11 dev ens4 lladdr 52:54:00:77:0b:01 REACHABLE hostListener=false
PASS [6.9] host-b destroys the expired guest on its own dead-man deadline (expiresAtMs + 10s grace; 1s agent sweep) while partitioned -- expiresAtMs=1794171362200 deadline=1794171372200 destroyed=1794171373725 delta=1525ms listing, state file, Firecracker process and pid are all absent
PASS [7.7] with host-a still drained, placement works again only on host-b after the skew is fixed -- create={"kind":"instancerInstanceDetails","status":"starting",...} host=host-b
PASS [7.8] the post-correction instance is pinned to host-b and its guest serves the team flag -- id=r02myowqwhmajdioce01m5x1 host=host-b
PASS [7.9] host-a is undrained only after host-b proved it can take and serve a placement -- healthy
PASS [11.9] the reconciler adopts the existing VM: same id, running, pinned to host-b, one row and no duplicate on host-a -- id=lkqvd39von589j7v4o40ynof host=host-b
PASS [12.2] systemctl restart re-adopts the same VM (same Firecracker pid, same instance id) -- pidBefore=22242 pidAfter=22242 state=true
```

### What changed in this hardening pass

1. **No multicast, no LAN exposure.** The private NIC is now
   `-netdev dgram,local.type=unix,local.path=…,remote.type=unix,remote.path=…`
   per VM, with the two mirrored paths inside a mode-0700 per-run directory.
   There is no multicast group, UDP/TCP port, bridge or tap, so no other
   machine (or local user) can observe or inject the bearer-token/flag HTTP
   that crosses it. All multicast allocation and wording was removed.
2. **Asserted, not assumed.** `run.sh` performs 24 explicit link checks before
   the driver (recorded QEMU command lines, exactly two confined netdevs, mode
   0700 sockets, MAC-pinned private NICs, agent listen addresses only on the
   private IPs, peer routes/neighbour MACs, no host address/listener) and the
   driver repeats the core invariants as assertions 1.8–1.10 (137 total).
3. **Authenticated pidfiles for QEMU and the seed server.** Both pidfiles are
   versioned records of the boot id, process start ticks, executable and
   run-specific argv; identity is verified before `TERM` and again before
   `KILL`, and a stale/mismatched file is removed with a warning without
   signalling anything. `vm.sh selftest` runs before boot and passed 19/19
   decoy checks (bare PID, wrong cmdline, stale boot id, PID reuse, another
   run's link argument, positive control, stale seed pidfile).
4. **Clock-skew assertion fixed.** host-a is no longer undrained before the
   post-correction create: it stays drained until the instance is running on
   host-b with the correct pinned host and a real `/flag.txt` response from
   its guest (7.7–7.8), then host-a is undrained (7.9).
5. **RESULTS corrected.** The old claim that vmtest check 20's inode
   comparisons passed on empty strings is removed and replaced with the
   current behaviour (see “Observations” below).

## Previous run — 2026-11-08 13:26:05–13:33:10 (America/Denver)

Command:

```sh
./deploy/firecracker/multihost/run.sh
```

Dynamic identifiers for this run: run dir `/tmp/opencode/fcmh-OTnCQg`,
ssh ports `56599` / `47433`, controller forward `50993`, mcast
`239.255.113.167:57587`. Exit code **0**; both QEMUs were stopped by the trap
and no `qemu-system-x86` process remained afterwards.

```
RESULT: 132 passed, 0 failed, 132 assertions
driver exit code: 0
```

### Per-check outcome

| Group                                    | Result   | Assertions | Evidence highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 hosts register/heartbeat/accept        | **PASS** | 7/7        | `/v1/hosts` healthy; `hosts.accepting=1` in controller SQLite; direct agent `/v1/info` `accepting:true`, `checks.recovered:true`; `lastSeenMs` advanced; unauthenticated agent call `401`; KVM+jailer preflight true.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2 placement/pinning/jailer + memory skew | **PASS** | 22/22      | equal budgets: `a,b,a,b` (most-free-memory, host-id tie-break); with host-b's configured memory halved to 2048 MiB: `mem-1,mem-2` on host-a then `mem-3,mem-4` on host-b (`a,a,b,b`), proving the scheduler follows free memory rather than alternating. Extend/delete touched only the pinned agent; both guests ran under the real jailer (uid 10000, `/firecracker`, `/proc/<pid>/root == jail root`); the deleted guest was definitively refused (curl exit 7), not a probe error.                                                                                                                                                                   |
| 3 capacity + sampled 20-way race         | **PASS** | 8/8        | host-a filled to 2; 4th create on host-b; 5th ⇒ `no capacity: insufficient instance slots…`; 20 concurrent creates ⇒ 4 accepted, 16 `no_capacity`; `/v1/hosts` sampled every 50 ms during the race: `samples=4 maxReserved=2/2 over=0` (never above capacity at any sample), 4 Firecracker processes; capacity returned after deletes.                                                                                                                                                                                                                                                                                                                   |
| 4 drain/undrain                          | **PASS** | 8/8        | host-a draining, new create on host-b, existing guest kept serving, undrain restored placement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5 host loss                              | **PASS** | 15/15      | healthy removal `409`; QEMU `SIGKILL` ⇒ unhealthy; new create on host-a; the B instance reported `errored` with **exactly one row**, still pinned to host-b, no agent record for that id on host-a; removal `204` ⇒ `lost`, reservation 0, host draining; the key was freed and the team recreated on host-a; VM restart re-adopted/wrote off, cleaned the tombstone, host-b had no record/process/tap; exactly one live instance for the team; undrain restored service.                                                                                                                                                                                |
| 6 network partition + dead-man           | **PASS** | 16/16      | nftables drop ⇒ unhealthy; create during partition on host-a; host-b instance reported `errored` with **exactly one row** pinned to host-b and no host-a record; the short row stayed pinned to host-b (`deleting` after the controller's own expiry claim — an absent row fails 6.8); the agent state recorded the live pid and real `expiresAtMs=1794169756861`; the agent destroyed the guest itself at deadline+3420 ms (`expiresAtMs + 10 s` grace, 1 s sweep) with the agent listing, state file, Firecracker process and pid all definitively absent; the long guest stayed alive; unblock ⇒ healthy, long guest still served, short row removed. |
| 7 clock skew                             | **PASS** | 7/7        | +60.6 s and −60.2 s measured and flagged; host stayed healthy; creates refused with `no capacity: all hosts exceed the maximum clock skew` and no row/VM; corrected clock ⇒ −71 ms and placement worked.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8 cross-host isolation                   | **PASS** | 12/12      | two instances of one team and two of another, two per host; every endpoint names its own host address/agent port; each guest served exactly its own flag; cross-host correct address/port worked; the other host's port was **definitively refused/timeout** (not a probe error); four distinct flags never crossed.                                                                                                                                                                                                                                                                                                                                     |
| 9 controller restart                     | **PASS** | 7/7        | SIGKILL restart while instances spanned both hosts; same ids, same pinned hosts, one VM each, both guests served; one live row per team; duplicate create returned the same id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 10 token mismatch                        | **PASS** | 6/6        | wrong host-b token ⇒ unhealthy; `last_seen_ms` frozen (`before=first=second=1794169844486 advance=0`) while the wrong token was in use; direct agent still `accepting:true`; creates on host-a; 12 rejection lines in the controller log; restoring the token made host-b healthy.                                                                                                                                                                                                                                                                                                                                                                       |
| 11 ambiguous create                      | **PASS** | 10/10      | in-guest fault proxy: a held create produced exactly one `creating` row pinned to host-b and a `starting` answer, the request was captured (no VM on either host), the reconciler fenced it after `createFenceSeconds` (row removed, key freed), the agent tombstone was durable, and replaying the captured PUT returned **409** with no VM; a response-swallowed create was adopted with the same id on host-b, served its flag, one row, no host-a duplicate.                                                                                                                                                                                         |
| 12 agent restart with a live VM          | **PASS** | 7/7        | `systemctl restart` re-adopted the **same Firecracker pid** (21571) and kept serving; `kill -9` of the agent was recovered by systemd and re-adopted the same pid; one controller row stayed pinned to host-a; a new create still spread to host-b.                                                                                                                                                                                                                                                                                                                                                                                                      |
| L leftovers                              | **PASS** | 7/7        | 0 controller rows (the SQLite dump succeeded), 0 agent instances, 0 Firecracker processes, 0 taps, 0 state records, 0 per-lease nft rules on both hosts; cleanup had no swallowed errors; both agents answered `200`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Verbatim excerpts (final run)

```
PASS [2.14] the larger host absorbed two creates before the smaller one was used (packing by free memory, not alternation) -- [{"team":"mem-1","host":"host-a"},{"team":"mem-2","host":"host-a"},{"team":"mem-3","host":"host-b"},{"team":"mem-4","host":"host-b"}]
PASS [3.7] reservations sampled every 50ms during the race never exceeded 2 per host (the sampler observed both hosts fully reserved) -- samples=4 maxReserved=2/2 over=0 reserved=host-a:2,host-b:2 agentA=2 agentB=2 fc=4
PASS [6.2b] the agent state records the live Firecracker pid and the real expiresAtMs for the short instance -- pid=10373 line=10373 /firecracker --id c45dgy22d5vv58qumu47xpf1 ... expiresAtMs=1794169756861
PASS [6.8] the short instance still has exactly one row pinned to host-b during the partition (running, or deleting after the controller's own expiry claim; an absent row fails this check) -- rows=["c45dgy22d5vv58qumu47xpf1@host-b:deleting"]
PASS [6.9] host-b destroys the expired guest on its own dead-man deadline (expiresAtMs + 10s grace; 1s agent sweep) while partitioned -- expiresAtMs=1794169756861 deadline=1794169766861 destroyed=1794169770281 delta=3420ms listing, state file, Firecracker process and pid are all absent
PASS [10.2] the controller never records a successful heartbeat for the mismatched host (last_seen_ms is frozen while the wrong token is in use) -- health=unhealthy before=1794169844486 first=1794169844486 second=1794169844486 advance=0
PASS [11.4] after createFenceSeconds the reconciler fences the id and removes the row (the key is freed) -- rows=0
PASS [11.5] the agent durably tombstoned the fenced id -- tombstone=true
PASS [11.6] replaying the captured PUT is rejected by the tombstone (HTTP 409) and creates no VM on either host -- replayHTTP=409 agentB=[]
PASS [11.9] the reconciler adopts the existing VM: same id, running, pinned to host-b, one row and no duplicate on host-a -- id=kdhw30gs0uwtmyf40zlfl2mh host=host-b
PASS [12.2] systemctl restart re-adopts the same VM (same Firecracker pid, same instance id) -- pidBefore=21571 pidAfter=21571 state=true
PASS [12.4b] after kill -9 systemd restarts the agent and it re-adopts the same Firecracker pid -- pidBefore=21571 pidAfter=21571 state=true
```

### What changed in the previous hardening pass (132 assertions)

The suite before it passed 108/108 but several assertions were weak. That pass
strengthened them and added the missing scenarios:

1. **Dead-man fail-closed**: the wait now requires the agent HTTP list
   (`httpCode=200`, non-null instances), the per-instance state file, the
   Firecracker argv (`--id <id>`) and the recorded pid to all be definitively
   absent; a failed probe is an error, never "destroyed".
2. **Real deadline**: the band is measured from the agent state's
   `expiresAtMs` + `expiryGraceSeconds` (10 s), not `Date.now()` before
   `create()`. The agent sweeps every 1 s (`sweepIntervalMs` in
   `agent/manager.ts`) and tears down at `expiresAtMs + grace`; the observed
   delta was **+3420 ms** and the band is now −1 s … +8 s (previously
   −3 s … +25 s around a 25 s guess). The earlier RESULTS wording
   “deadline+2.4s” was measuring `create()+15s+10s`, not the agent deadline;
   it is corrected here.
3. **Pinned image**: `vm.sh` no longer downloads floating `noble/current`. It
   uses the same dated release and pinned digest as `vmtest/vm.sh`
   (`noble/20261017`, `sha256 04e8f246…b6c94`), re-hashes cached copies on
   every boot, verifies `SHA256SUMS` (+ GPG when available) on a fresh fetch,
   and refuses to boot on a mismatch (without deleting the shared vmtest
   image).
4. **L.1 fails closed**: a failed SQLite dump is now a failed leftover check,
   not an empty row list.
5. **No-reschedule/duplicate checks**: 5.5, 6.7 and 6.8 now require exactly
   one row for the team/challenge key, the expected id and host, and no agent
   record for that id on the other host. 6.8 fails if the row is absent
   (it accepts `running` or the controller's own `deleting` expiry claim,
   both pinned to host-b).
6. **Probe failures are not negatives**: `httpFromHost` now returns a
   definitive class (`ok`, `http`, `refused`, `timeout`, `probe_error`); 2.11
   and 8.6 require connection refused/timeout and fail on ssh/curl probe
   errors.
7. **Token mismatch**: `last_seen_ms` is captured before the bad-token
   controller and sampled twice while it is in use; it must not advance
   (observed `advance=0`).
8. **Most-free-memory policy**: the equal-budget `a,b,a,b` result is now
   labelled as the host-id tie-break, and a second pass halves host-b's
   configured memory to prove placement packs onto the larger host
   (`a,a,b,b`), matching `controller/scheduler.ts`.
9. **Atomic reservation sampling**: `/v1/hosts` is polled every 50 ms during
   the 20-way race; no sample may exceed 2 reserved instances per host and the
   sampler must observe both hosts at 2.
10. **New scenarios**: ambiguous-create fencing/adoption through an in-guest
    TCP fault proxy (11) and agent `systemctl restart`/`kill -9` with a live
    VM (12), both passing.
11. **Fail-closed observations**: `hoststats.sh` reports `nftLeaseRules=-1`
    when the agent's nftables table cannot be read (previously `|| true`
    turned a failure into 0); `run.sh` picks the multicast group in
    `239.255.0.0/16` and probes the port by binding on the group, wildcard
    and loopback addresses (QEMU's mcast netdev uses `SO_REUSEADDR`).

### Intermediate run (130/132) — harness assertion bugs, not product bugs

The first run of the hardened suite was 2026-11-08 13:18:16–13:25:29
(run dir `/tmp/opencode/fcmh-ISdXXk`), `RESULT: 130 passed, 2 failed`:

- `[6.8]` expected the short row to still be `running`; by the time the check
  ran (after the heartbeat timeout and a create), the controller's own reaper
  had legitimately claimed the expired row as `deleting`, still pinned to
  host-b. Fixed the assertion to accept `running`/`deleting` while still
  failing if the row is absent or moved.
- `[10.2]` required `last_seen_ms` not to move at all from a sample taken
  _before_ the controller restart; the old controller wrote one final
  heartbeat before SIGTERM (+1001 ms). The assertion now samples twice while
  the wrong token is in use (`advance=0`) and allows only that one pre-kill
  interval.

Neither was a product bug; both were harness over-specification. The final run
of that pass was 132/132.

## Earlier run — 2026-11-08 12:48:13–12:52:57 (America/Denver)

Command:

```sh
./deploy/firecracker/multihost/run.sh
```

Dynamic identifiers for this run: run dir `/tmp/opencode/fcmh-bMXjQn`,
ssh ports `47579` / `43853`, controller forward `40355`, mcast
`239.5.32.53:57743`. Exit code **0**; both QEMUs were stopped by the trap and
`pgrep -f qemu-system-x86_64` showed none afterwards.

```
RESULT: 108 passed, 0 failed, 108 assertions
driver exit code: 0
```

### Per-check outcome

| Group                             | Result   | Assertions | Evidence highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 hosts register/heartbeat/accept | **PASS** | 7/7        | `/v1/hosts` healthy; `hosts.accepting=1` in controller SQLite; direct agent `/v1/info` `accepting:true`, `checks.recovered:true`; `lastSeenMs` advanced ~3 s in 2.5 s; unauthenticated agent call `401`; KVM+jailer preflight true.                                                                                                                                                                                                                                                                                           |
| 2 spread + pinning + jailer       | **PASS** | 17/17      | four creates landed `a,b,a,b`; two instances listed per agent; extend changed only host-b's state; delete removed only host-a's; both live Firecracker processes run as uid 10000 with `/proc/<pid>/root` device+inode equal to `/srv/jailer/firecracker/<id>/root` and `/proc/<pid>/exe == /firecracker`.                                                                                                                                                                                                                    |
| 3 capacity + 20-way race          | **PASS** | 9/9        | host-a filled to 2 by the 3rd create, 4th went to host-b; 5th ⇒ `no capacity: insufficient instance slots…`, no row/VM; 20 concurrent creates ⇒ exactly 4 accepted, 16 `no_capacity`, reservations 2+2, 4 Firecracker processes, no oversubscription; capacity returned after deletes.                                                                                                                                                                                                                                        |
| 4 drain/undrain                   | **PASS** | 8/8        | host-a draining, new create on host-b, existing guest kept serving, undrain returned to healthy and post-undrain placement returned to host-a.                                                                                                                                                                                                                                                                                                                                                                                |
| 5 host loss                       | **PASS** | 15/15      | healthy removal `409`; QEMU `SIGKILL` ⇒ unhealthy after ~5.7 s; new create on host-a; old instance reported `errored`, row stayed pinned to host-b; removal `204` ⇒ `lost`, reservation 0, host draining; write-off freed the key and the team recreated on host-a with a new id; VM restart re-adopted/wrote off, the lost tombstone was cleaned up, host-b had no record/process/tap left, exactly one live instance for the team; undrain restored host-b and it accepted a placement.                                     |
| 6 network partition               | **PASS** | 17/17      | nftables drop on host-b's private NIC ⇒ unhealthy after ~4.6 s; create during partition went to host-a; host-b instance reported `errored` with row still on host-b; short-lived instance destroyed by the agent's own dead-man while partitioned (the old check reported “deadline+2.4 s”, but its “deadline” was `create()+15 s+10 s`, not the agent's `expiresAtMs`; corrected in the 2026-11-08 13:26 run above); long-lived guest stayed alive; unblock ⇒ healthy in ~0.2 s, long guest still served; short row removed. |
| 7 clock skew                      | **PASS** | 7/7        | +59.5 s and −60.4 s skews measured and flagged (`clock_skew_ms`, `clock_state=valid`), host stayed healthy, creates refused with `no capacity: all hosts exceed the maximum clock skew` and no row/VM; corrected clock ⇒ −45 ms and placement worked.                                                                                                                                                                                                                                                                         |
| 8 cross-host isolation            | **PASS** | 12/12      | two instances of one team and two of another, two per host; every endpoint names its own host address and the agent's allocated port; each guest served exactly its own flag; A→B and B→A public address/port returned the other host's flag; using the other host's port at this host's address failed; four distinct flags never crossed.                                                                                                                                                                                   |
| 9 controller restart              | **PASS** | 6/6        | SIGKILL restart while instances spanned both hosts; same ids, same pinned hosts, one VM each, both guests served; one live row per team; duplicate create returned the same id.                                                                                                                                                                                                                                                                                                                                               |
| 10 token mismatch                 | **PASS** | 6/6        | wrong host-b token in the controller ⇒ host-b unhealthy after ~4.1 s while host-a stayed healthy; no successful heartbeat row; direct agent still `accepting:true`; creates went to host-a; 11 log lines surfaced the rejection; restoring the token made host-b healthy.                                                                                                                                                                                                                                                     |
| L leftovers                       | **PASS** | 7/7        | 0 controller rows, 0 agent instances, 0 Firecracker processes, 0 taps, 0 state records, 0 per-lease nft rules on both hosts; both agents answered at the end.                                                                                                                                                                                                                                                                                                                                                                 |

### Verbatim excerpts (earlier 108-assertion run)

```
PASS [1.1] controller /v1/hosts lists host-a and host-b as healthy -- [{"id":"host-a","health":"healthy"},{"id":"host-b","health":"healthy"}]
PASS [1.2] the controller recorded accepting:true for both hosts (hosts.accepting; /v1/hosts does not expose the field) -- accepting host-a=1 host-b=1
PASS [2.7-host-a] host-a runs its instance under the real jailer (uid 10000, /firecracker, /proc/<pid>/root == jail root) -- {"uid":"10000","exe":"/firecracker","root":"64769:533463","jailRoot":"64769:533463","matches":true}
PASS [2.7-host-b] host-b runs its instance under the real jailer (uid 10000, /firecracker, /proc/<pid>/root == jail root) -- {"uid":"10000","exe":"/firecracker","root":"64769:532881","jailRoot":"64769:532881","matches":true}
PASS [2.2b] spread-2 lands on the host the scheduler's spread policy predicts -- host=host-b expected=host-b
PASS [3.3] with both hosts full, create fails cleanly with a no_capacity instancerError -- {"kind":"instancerError","message":"no capacity: insufficient instance slots for 1 vCPU / 256 MiB / 128 MiB"}
PASS [3.6] under 20 concurrent creates exactly 4 are accepted (2 per host) and 16 fail cleanly -- ok=4 rejected=16
PASS [3.7] the race never oversubscribed a host (agent listings and controller reservations <= 2 each) -- reserved=host-a:2,host-b:2 agentA=2 agentB=2 fc=4
PASS [4.6] undrain restores host-a to healthy -- HTTP 200 {"id":"host-a",...,"health":"healthy",...}
PASS [5.3] host-b is marked unhealthy after the configured heartbeat timeout -- after ~5669ms (killed=5669ms)
PASS [5.6] removing the unhealthy host returns 204 and writes the live row off as lost -- HTTP 204 state=lost reserved=0
PASS [5.11] the lost tombstone is cleaned up exactly as documented when the agent returns -- rows=[{"id":"3ez21kpwfqb99uwg6ix42tos","state":"running","team_id":"loss",...,"host_id":"host-a",...}]
PASS [5.12] the restarted agent has no record, Firecracker process, tap or duplicate VM for the written-off instance -- {"ids":[],"fc":0,"taps":0,"hostB":0}
PASS [6.3] the controller marks host-b unhealthy after the configured heartbeat timeout (4s) -- after ~4648ms
PASS [6.7] the partitioned host's instance is not silently rescheduled: it reports errored and its row stays pinned to host-b -- get={"kind":"instancerInstanceDetails","status":"errored",...,"host":"10.77.0.11",...} rowHost=host-b
PASS [6.9] host-b destroys the expired guest on its own dead-man deadline while partitioned -- deadline=1794167480429 destroyed=1794167482843 delta=2414ms
PASS [6.11] the host becomes healthy again when the partition ends -- after ~203ms
PASS [7.1] a host clock 60s ahead is measured and flagged in the controller state (clock_skew_ms) -- skew=59493 state=valid
PASS [7.3] with host-a draining, a create is refused with the documented clock-skew no_capacity message -- {"kind":"instancerError","message":"no capacity: all hosts exceed the maximum clock skew"}
PASS [7.6] after the clock is corrected the measured skew returns within bounds -- skew=-45
PASS [8.2] every endpoint names its own host public address and the port the pinned agent allocated -- [{"host":"host-a","endpoint":"10.77.0.10:20003","leasePort":20003},{"host":"host-b","endpoint":"10.77.0.11:21000","leasePort":21000},...]
PASS [8.4] from host-a, host-b's public address:port serves host-b's flag (and not host-a's) -- HTTP 200
PASS [8.6] the other host's port is not reachable at this host's address (no port crossover) -- a->b:20003 HTTP 0; b->a:21000 HTTP 0
PASS [9.2-rst-a] rst-a is adopted with the same id and the same pinned host after a SIGKILL restart -- id=019rrwk4qnm6g9fcnck9zjlr host=host-a state=running
PASS [10.1] the host with the wrong token becomes unhealthy while the other stays healthy -- unhealthy after ~4052ms hostA=healthy
PASS [10.5] the rejection is surfaced in the controller log -- matchingLines=11
controller rows: none
host-a: instances=0 firecracker=0 taps=0 stateRecords=0 nftLeases=0
host-b: instances=0 firecracker=0 taps=0 stateRecords=0 nftLeases=0
```

### Full transcript (earlier run)

`/tmp/opencode/fcmh-bMXjQn/logs/run.log` on the reference host
(`logs/assertions.log`, per-VM provision/copy/console logs and `results.json`
are next to it). Paths are ephemeral; the excerpts above are the durable
record.

## Post-commit verification run (108-assertion suite) — 2026-11-08 12:56:02–13:00:45

The harness code was committed and the same command was run again on the
committed tree (the only later change is this RESULTS note and the commit's
bookkeeping). Run dir `/tmp/opencode/fcmh-RnGaIS`, ssh ports `33037` /
`35827`, mcast `239.141.202.67:47754`, controller forward `40287`.

```
RESULT: 108 passed, 0 failed, 108 assertions
driver exit code: 0
```

Both QEMUs were stopped; `pgrep -f qemu-system-x86_64` returned nothing. This
confirms the result is reproducible, not a one-off ordering.

## Product bugs found

**None.** The 108-assertion, 132-assertion and 137-assertion runs all passed.
The only two assertion failures in the intermediate 130/132 run were harness
over-specifications (6.8 row state and 10.2 one pre-SIGTERM heartbeat), fixed
in the driver; no product code was changed and no reproduction was needed, so
`repros/` is empty.

### Attempts before the final 137/137 run

Two attempts in this pass stopped before exercising any scenario, for local
reasons that are worth recording:

- the first run reached the driver with the link checks already 24/24, then
  failed with `Cannot find module '@rctf/firecracker-protocol'`: this fresh
  worktree had no `node_modules` for the **host-side** driver (the VMs install
  their own). Fixed by `bun install --frozen-lockfile` on the host; README now
  lists this as a prerequisite.
- one attempt was aborted because `run.sh` was edited by hand while bash was
  still reading it, producing `syntax error near unexpected token ')'` at line 241. The EXIT trap still stopped both VMs. The final run used the finished
  scripts unchanged.

## Harness defects found and fixed during development (not product bugs)

Earlier full attempts failed before or inside the suite because of the
harness; all were fixed here, never by editing product code:

1. `run.sh` UDP-port allocator had a Python `try/finally` syntax error →
   empty multicast port, QEMU refused `mcast=…::`. Fixed.
2. Two parallel `vm.sh create` calls raced on the shared ssh key → host-b
   stopped at an `Overwrite (y/n)?` prompt. Key generation is now under
   `flock`.
3. cloud-init in this image ignores netplan `set-name` (NICs are `ens3`/
   `ens4`), so the private NIC got no address. Replaced by a boot-time
   systemd unit that finds the NIC by MAC and assigns the static address;
   this also survives the host-loss VM reboot.
4. `push_to_vm` omitted `--ssh-port` on later `vm.sh` calls → “SSH_PORT is
   required”. Fixed.
5. The controller started through a nested `( … ) &` subshell held the ssh
   channel open (the wrapper stayed as parent). Switched to
   `{ …; exec bun …; } &` so the channel closes immediately.
6. The agent's `externalInterface` was the management NIC while `publicHost`
   was on the private L2; the DNAT rule is scoped `iifname externalInterface`,
   so cross-host public probes failed. The private NIC is now the external
   interface (correct for this topology).
7. `waitRunning` chose the first controller row for a team, which after a
   host write-off was the old `lost` row; it now selects the newest live row.
8. `hoststats.sh` counted the literal `fctap*` template in the nft table as a
   lease; it now matches `fctap[0-9]+`.
9. The jail-identity probe ran `/proc/<pid>/exe`/`root` as the unprivileged
   `ubuntu` user (ptrace-gated) and relied on a non-persisted `vm.jailRoot`.
   It now reads them with `sudo` and derives `/srv/jailer/firecracker/<id>/root`.

Intermediate run at 12:44 reached **106/108**; the two failures were exactly
item 9 (uid 10000 was visible, but `exe`/`root` were empty). After the fix that
suite's final run was 108/108. The 132-assertion pass is the 2026-11-08 13:26
run above; the current 137-assertion pass is the 2026-11-08 13:52 run at the
top of this file.

## Observations / limitations (honest)

- The task text says “report accepting:true via the controller `/v1/hosts`”,
  but the public `HostSummary` schema has no `accepting` field. The harness
  asserts `/v1/hosts` health and `accepting:true` from the controller's
  `hosts.accepting` column (what the scheduler consumes) plus each agent's
  `/v1/info`. This is an observability gap, not incorrect behaviour.
- An earlier version of this file claimed that
  `vmtest/checks/20-jailer-instance.sh` read an empty `.vm.jailRoot` and that
  its `stat -Lc '%d:%i'` comparisons then "compare empty strings and pass
  vacuously". That is **not** true of the current code. The state schema in
  `apps/firecracker-instancer/src/agent/vm/driver.ts` persists `jailRoot`, so
  check 20 gets a non-empty path; if it were missing, the check records
  `bad "agent state has no vm.jailRoot for $ID"`. Both inode comparisons (exe
  dev:ino vs `$JAILROOT/firecracker`, and `/proc/<pid>/root` dev:ino vs
  `$JAILROOT`) are computed only when both sides are non-empty and otherwise
  record `bad "could not stat ... identities"`; empty strings can never make
  them pass. This multi-host harness nevertheless derives the jail root from
  the configured chroot base and checks the same identities with `sudo`
  itself, so `2.7-*` is an independent assertion.
- The “public internet” is not tested: `egress:false`, no Traefik/TLS. Public
  DNAT is measured between the two VMs over their private L2.
- Nested virtualization (KVM-on-KVM) is slower than bare metal and cannot
  validate hardware-specific behaviour.
- Host loss is a `SIGKILL` of one QEMU process, not a power cut; the guest
  disk overlay survives, which is exactly the documented “host comes back”
  case and the one with duplicate-instance risk.
- Clock skew is injected with `date -s` inside host-b (timesyncd/chrony
  disabled), not with a real broken NTP source.
- Each run uses ephemeral ports, unique directories and two unique unix-socket
  paths for the private link; the reference host may run other unprivileged
  workers without interference.

## Re-run on the integrated branch (2026-11-08)

After merging the fail-closed guest boot contract (mandatory jq, bounded MMDS
retries, schema validation before the service starts) and the edge Traefik
fetch / multihost port allocation fixes, the full harness was re-run from the
integrated tree: RESULT: 0 failed (see the counts in the run log for this
date). The stricter init changed no check outcome; every failure mode it adds
fails the boot instead, which these suites never relied on.
