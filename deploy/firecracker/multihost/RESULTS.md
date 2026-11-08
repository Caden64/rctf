# Multi-host verification — results

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
- Private L2: QEMU `-netdev socket,mcast=…` second NIC, `10.77.0.10` (host-a)
  and `10.77.0.11` (host-b). Controller→agent HTTP uses distinct per-host
  bearer tokens. This machine reaches the controller through one ssh forward
  and observes the agents through the same ssh management channel.

## Final run — 2026-11-08 13:26:05–13:33:10 (America/Denver)

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

### What changed in this hardening pass

The previous suite passed 108/108 but several assertions were weak. This pass
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
above is 132/132.

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

**None in either pass.** The 108-assertion suite and the final 132-assertion
run both passed. The only two failures in the intermediate hardened run were
harness over-specifications (6.8 row state and 10.2 one pre-SIGTERM
heartbeat), fixed in the driver; no product code was changed and no
reproduction was needed, so `repros/` is empty.

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
item 9 (uid 10000 was visible, but `exe`/`root` were empty). After the fix the
108-assertion suite's final run above is 108/108. The hardened 132-assertion
suite is the 2026-11-08 13:26 run at the top of this file.

## Observations / limitations (honest)

- The task text says “report accepting:true via the controller `/v1/hosts`”,
  but the public `HostSummary` schema has no `accepting` field. The harness
  asserts `/v1/hosts` health and `accepting:true` from the controller's
  `hosts.accepting` column (what the scheduler consumes) plus each agent's
  `/v1/info`. This is an observability gap, not incorrect behaviour.
- `.vm.jailRoot` is not part of the persisted agent handle schema, so the
  existing `vmtest/checks/20-jailer-instance.sh` line
  `JAILROOT=$(... '.vm.jailRoot')` is empty; its two `stat -Lc '%d:%i'`
  comparisons then compare empty strings and pass vacuously. This multi-host
  harness derives the jail root path from the configured chroot base and
  checks it with `sudo`, so the jail is really verified here. (The rest of
  vmtest check 20’s jail assertions are unaffected.)
- The “public internet” is not tested: `egress:false`, no Traefik/TLS. Public
  DNAT is measured between the two VMs over their private L2.
- Nested virtualization (KVM-on-KVM) is slower than bare metal and cannot
  validate hardware-specific behaviour.
- Host loss is a `SIGKILL` of one QEMU process, not a power cut; the guest
  disk overlay survives, which is exactly the documented “host comes back”
  case and the one with duplicate-instance risk.
- Clock skew is injected with `date -s` inside host-b (timesyncd/chrony
  disabled), not with a real broken NTP source.
- Each run uses ephemeral ports, directories and a random multicast group;
  the reference host may run other unprivileged workers without interference.
