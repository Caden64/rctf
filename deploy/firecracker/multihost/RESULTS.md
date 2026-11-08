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

## Final run — 2026-11-08 12:48:13–12:52:57 (America/Denver)

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

| Group | Result | Assertions | Evidence highlights |
| ----- | ------ | ---------- | ------------------- |
| 1 hosts register/heartbeat/accept | **PASS** | 7/7 | `/v1/hosts` healthy; `hosts.accepting=1` in controller SQLite; direct agent `/v1/info` `accepting:true`, `checks.recovered:true`; `lastSeenMs` advanced ~3 s in 2.5 s; unauthenticated agent call `401`; KVM+jailer preflight true. |
| 2 spread + pinning + jailer | **PASS** | 17/17 | four creates landed `a,b,a,b`; two instances listed per agent; extend changed only host-b's state; delete removed only host-a's; both live Firecracker processes run as uid 10000 with `/proc/<pid>/root` device+inode equal to `/srv/jailer/firecracker/<id>/root` and `/proc/<pid>/exe == /firecracker`. |
| 3 capacity + 20-way race | **PASS** | 9/9 | host-a filled to 2 by the 3rd create, 4th went to host-b; 5th ⇒ `no capacity: insufficient instance slots…`, no row/VM; 20 concurrent creates ⇒ exactly 4 accepted, 16 `no_capacity`, reservations 2+2, 4 Firecracker processes, no oversubscription; capacity returned after deletes. |
| 4 drain/undrain | **PASS** | 8/8 | host-a draining, new create on host-b, existing guest kept serving, undrain returned to healthy and post-undrain placement returned to host-a. |
| 5 host loss | **PASS** | 15/15 | healthy removal `409`; QEMU `SIGKILL` ⇒ unhealthy after ~5.7 s; new create on host-a; old instance reported `errored`, row stayed pinned to host-b; removal `204` ⇒ `lost`, reservation 0, host draining; write-off freed the key and the team recreated on host-a with a new id; VM restart re-adopted/wrote off, the lost tombstone was cleaned up, host-b had no record/process/tap left, exactly one live instance for the team; undrain restored host-b and it accepted a placement. |
| 6 network partition | **PASS** | 17/17 | nftables drop on host-b's private NIC ⇒ unhealthy after ~4.6 s; create during partition went to host-a; host-b instance reported `errored` with row still on host-b; short-lived instance destroyed by the agent's own dead-man at deadline+2.4 s while partitioned; long-lived guest stayed alive; unblock ⇒ healthy in ~0.2 s, long guest still served; short row removed. |
| 7 clock skew | **PASS** | 7/7 | +59.5 s and −60.4 s skews measured and flagged (`clock_skew_ms`, `clock_state=valid`), host stayed healthy, creates refused with `no capacity: all hosts exceed the maximum clock skew` and no row/VM; corrected clock ⇒ −45 ms and placement worked. |
| 8 cross-host isolation | **PASS** | 12/12 | two instances of one team and two of another, two per host; every endpoint names its own host address and the agent's allocated port; each guest served exactly its own flag; A→B and B→A public address/port returned the other host's flag; using the other host's port at this host's address failed; four distinct flags never crossed. |
| 9 controller restart | **PASS** | 6/6 | SIGKILL restart while instances spanned both hosts; same ids, same pinned hosts, one VM each, both guests served; one live row per team; duplicate create returned the same id. |
| 10 token mismatch | **PASS** | 6/6 | wrong host-b token in the controller ⇒ host-b unhealthy after ~4.1 s while host-a stayed healthy; no successful heartbeat row; direct agent still `accepting:true`; creates went to host-a; 11 log lines surfaced the rejection; restoring the token made host-b healthy. |
| L leftovers | **PASS** | 7/7 | 0 controller rows, 0 agent instances, 0 Firecracker processes, 0 taps, 0 state records, 0 per-lease nft rules on both hosts; both agents answered at the end. |

### Verbatim excerpts (final run)

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

### Full transcript

`/tmp/opencode/fcmh-bMXjQn/logs/run.log` on the reference host
(`logs/assertions.log`, per-VM provision/copy/console logs and `results.json`
are next to it). Paths are ephemeral; the excerpts above are the durable
record.

## Post-commit verification run — 2026-11-08 12:56:02–13:00:45

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

**None.** Every numbered invariant passed on the final run. No minimal
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
final run above is 108/108.

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
