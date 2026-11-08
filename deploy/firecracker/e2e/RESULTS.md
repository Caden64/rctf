# E2E results — 2026-11-08 (strengthened assertions)

Run of `deploy/firecracker/e2e/run.sh` on the reference development host. This is the first time the
controller was run against the **real** agent and the rCTF provider against the **real** controller,
with real Firecracker microVMs under KVM.

The original run in this file passed 122 assertions. After the assertion-hardening review described
under “Assertion hardening” below, the harness has **128 assertions**, and four consecutive full runs
passed **128/128 with exit code 0** (run dirs `/run/user/1000/fce-ONipfv`, `fce-0j34YV`,
`fce-z3hIB6`, `fce-vzFKJX`; ~120.8 s, ~121.1 s, ~120.7 s and ~120.9 s wall time).

## Environment

|             |                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Date        | 2026-11-08 (America/Denver)                                                                               |
| Kernel      | `7.2.14-arch1-1`                                                                                          |
| Bun         | `1.4.4` (`/home/caden64/.local/bin/bun`)                                                                  |
| Artifacts   | `$HOME/.cache/rctf-fc-smoke` (read-only): Firecracker v1.17.0, kernel 6.1.155, smoke `rootfs.ext4`        |
| Namespace   | `unshare -Urn` (private user + network namespace), no root, no sudo                                       |
| Run dirs    | `/run/user/1000/fce-ONipfv`, `fce-0j34YV`, `fce-z3hIB6`, `fce-vzFKJX` (`mktemp` under `$XDG_RUNTIME_DIR`) |
| cgroup root | default `/sys/fs/cgroup` (the F1 workaround is gone; re-verified after fix d5c17f1c)                      |
| Wall time   | ~120.8 s, ~121.1 s, ~120.7 s and ~120.9 s for the four consecutive runs                                   |
| Exit code   | **0** for all four runs                                                                                   |

The earlier post-formatting verification run (122/122) and the first run in this file were against the
same product revision. Sections 1, 3 and Leftovers below are from the final strengthened run; the
remaining excerpts are from the original 122-assertion run (their assertions are unchanged except
where noted). The strengthened runs use the same flags and artifacts.

Command:

```sh
export PATH=$HOME/.local/bin:$PATH
export SMOKE_ARTIFACTS=$HOME/.cache/rctf-fc-smoke
deploy/firecracker/e2e/run.sh
```

Header from the original run (the explicit cgroup-root line predates the F1 fix):

```
e2e run dir: /run/user/1000/fce-LV2Syk
artifacts:   /home/caden64/.cache/rctf-fc-smoke (read-only)
cgroup root for the agent: /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-dbc3098cac94.slice/t3code-opencode-a7376808.scope
flag: <redacted> len=33 sha256=67b2dd00dabad6eeda55c29ee45ca683f0de11b274896a532f2a87cd0b279289
bun: /home/caden64/.local/lib/node_modules/bun/bin/bun.exe; node: v26.3.0; kernel: 7.2.14-arch1-1
```

The flag is a random per-run canary (`rctf{e2e-canary-…}`). It is never printed or written by the
harness; only its length and SHA-256 appear in logs.

## Summary

Latest strengthened run (four consecutive runs were identical):

```
RESULT: 128 passed, 0 failed, 128 assertions
driver exit code: 0
```

| Group                                   | Assertions | Failed |
| --------------------------------------- | ---------: | -----: |
| 10 auth                                 |         10 |      0 |
| 1 lifecycle + flag                      |         20 |      0 |
| 2 idempotency / spec conflict           |          8 |      0 |
| 6 capacity + concurrent creates         |         10 |      0 |
| 3 expiry + extend race                  |          8 |      0 |
| 4 controller restart (incl. mid-flight) |          8 |      0 |
| 5 agent kill -9                         |          6 |      0 |
| 8 orphan                                |          5 |      0 |
| 9 drain                                 |          7 |      0 |
| 11 20 create/delete cycles              |         20 |      0 |
| 12 host removal (extra)                 |          7 |      0 |
| 7 ambiguous create (proxy)              |         13 |      0 |
| L leftovers                             |          6 |      0 |
| **total**                               |    **128** |  **0** |

The original run had 122 assertions; the extra six are the new live probe calibration (`1.2a`),
the run-wide Firecracker-process check (`1.13a`), the split extend/expiry race
(`3.4a`, `3.4b`, `3.5a`) and the explicit pre-shutdown cleanup assertion (`L.6`). Existing
assertions were also made stricter without changing their IDs (see “Assertion hardening”).

## Excerpts (verbatim from the run)

### 1. Full lifecycle, flag byte-for-byte, flag nowhere durable

```
PASS [1.1] provider create returns instancerInstanceDetails -- {"kind":"instancerInstanceDetails","status":"starting","timeLeftMilliseconds":59917,"endpoints":[{"kind":"tcp","host":"10.200.0.1","port":20000,"title":"web"}]}
PASS [1.2] get reports running with a positive time left -- {"kind":"instancerInstanceDetails","status":"running","timeLeftMilliseconds":58889,"endpoints":[{"kind":"tcp","host":"10.200.0.1","port":20000,"title":"web"}]}
PASS [1.2a] probe calibration: the running lease has a visible tap and nft references its tap and guest IP -- taps=1 tap=fctap0 guestIp=10.200.0.2
PASS [1.5] the flag reaches the guest byte-for-byte via MMDS -- len=33 sha256=67b2dd00dabad6eeda55c29ee45ca683f0de11b274896a532f2a87cd0b279289
PASS [1.6] the flag appears nowhere in controller sqlite, agent state, logs or the guest disk image (and every scanned file was readable) -- {"agent state":0,"agent traefik dir":0,"per-instance disk/run dir":0,"per-instance rootfs.ext4 (explicit)":0,"per-instance vm-identity.json":0,"controller sqlite":0,"logs":0,"whole run tree (configs, driver output, everything)":0,"scannedFiles":26,"rootfs":"readable","identity":"readable","unreadable":[]}
PASS [1.7] the flag is absent from the firecracker process command line -- pid=34117
PASS [1.8] the agent persists only the flag provider name, never the value -- ["main"]
PASS [1.9] extend succeeds and reports a deadline about ten minutes out -- {"kind":"instancerInstanceDetails","status":"running","timeLeftMilliseconds":599998,...}
PASS [1.12] delete reports stopped through the provider -- {"kind":"instancerInstanceDetails","status":"stopped","timeLeftMilliseconds":0,"endpoints":null}
PASS [1.13] firecracker process gone
PASS [1.13a] no firecracker process for this run remains -- pids=none
PASS [1.14] tap device removed
PASS [1.15] per-instance run dir and agent state record removed
PASS [1.17] no nft rule references the lease
PASS [1.18] the controller row is gone after a confirmed delete
```

The `1.6` scan reads the **whole run tree** (controller SQLite + WAL, agent state and tombstones,
Traefik dir, per-instance `rootfs.ext4` and `vm-identity.json`, all logs, generated configs, driver
output) as raw bytes. It also stats and opens the per-instance `rootfs.ext4` and
`vm-identity.json` explicitly and fails if either is missing or unreadable;
`scanFilesContaining` reports unreadable files instead of skipping them. `1.2a` is the live
calibration: the tap/nft probes are only trusted after seeing this lease's tap, tap name and guest
IP while the VM is running.

### 2. Idempotency and a real spec conflict

```
PASS [2.2] the same team/challenge create returns the same instance id -- fec4bdyctryy9rcau5rwq8uu vs fec4bdyctryy9rcau5rwq8uu
PASS [2.3] no second VM was created by the duplicate create
PASS [2.4] a different spec on the same key still resolves to the one live row (documented idempotency, no second VM)
PASS [2.6] the agent rejects a different spec for the same id with 409 spec_mismatch -- HTTP 409 {"kind":"agentError","code":"spec_mismatch","message":"instance id already exists with a different spec"}
```

Note: at the controller level a create is idempotent by `(teamId, challengeIntegrationId)` and returns
the live row even if the requested config differs (this is the documented contract in
`ARCHITECTURE.md`); the “different spec conflicts” invariant lives at the agent, and is asserted
there (`2.6`). Both were verified with real VMs and no duplicate process/tap.

### 3. Expiry and the extend/expiry race

```
PASS [3.2] the reaper destroyed the real VM and released the row on time -- {"process":true,"stateFile":true,"runDir":true,"tap":true,"nft":true,"agent":true,"all":true}
PASS [3.3] provider get reports stopped after expiry -- {"kind":"instancerInstanceDetails","status":"stopped","timeLeftMilliseconds":0,"endpoints":null}
PASS [3.4a] race 1: the extend is issued early, with margin before the original deadline -- issuedAt=1794164521739 originDeadline=1794164527738 marginMs=5999
PASS [3.4b] race 1: the early extend is accepted and reports running -- {"kind":"instancerInstanceDetails","status":"running","timeLeftMilliseconds":599999,...}
PASS [3.4] race 1: the early extend kept the VM alive past the original deadline -- extend={"kind":"instancerInstanceDetails","status":"running","timeLeftMilliseconds":599999,...} get={"kind":"instancerInstanceDetails","status":"running","timeLeftMilliseconds":591499,...} now=1794164530244 originDeadline=1794164527738
PASS [3.5a] race 2: the extend is genuinely issued after the lease deadline -- issuedAt=1794164537609 deadline=1794164536107
PASS [3.5] race 2: an extend after the deadline is rejected and the real VM is gone -- extend={"kind":"instancerError","message":"instance is no longer extendable"} gone={"process":true,"stateFile":true,"runDir":true,"tap":true,"nft":true,"agent":true,"all":true} get={"kind":"instancerInstanceDetails","status":"stopped",...}
```

Race 1 is no longer an “either outcome” test: the extend is issued six seconds before the original
deadline and **must** be accepted; the VM, process, tap and guest must then survive two and a half
seconds past that deadline. Race 2 is separate and waits until the lease deadline has actually
passed before extending.

### 4. Controller restart, including `SIGKILL` mid-create

```
PASS [4.1] the restarted controller adopts the running instance from SQLite
PASS [4.2] the restart did not duplicate the VM
PASS [4.4] the provider surfaces the killed controller as a clean instancerError -- {"kind":"instancerError","message":"Something went wrong while talking to the Firecracker controller"}
PASS [4.5] the mid-flight create is adopted after the restart with the same id -- row=running id=318zyqhcq200qi8pryelvj8s
PASS [4.6] the mid-flight adoption did not duplicate the VM
PASS [4.7] the adopted instance still serves the flag
```

The mid-flight kill is timed deterministically: the harness waits until the controller row exists
**and** the agent has begun the create, then `SIGKILL`s the controller, waits for the provider call to
fail, restarts the controller, and requires the same id to reach `running` with exactly one VM.

### 5. Agent `kill -9` while a VM runs

```
PASS [5.1] the microVM survives an agent SIGKILL -- pid=34117
PASS [5.2] the guest still serves the flag while the agent is dead
PASS [5.3] the controller reports the instance running after the agent returns
PASS [5.4] the restarted agent re-adopted the same VM (one VM, same pid)
PASS [5.5] the tap and guest survived the agent restart
```

Agent log after the restart:

```
{"level":30,"pid":34138,"name":"firecracker-agent","instanceId":"zj266yemg4x8syin76mae22o","state":"running","msg":"adopted running firecracker instance"}
```

### 6. Capacity and concurrent creates

```
PASS [6.1] eight concurrent creates for one team all resolve to instance details -- []
PASS [6.2] exactly one controller row exists for the racing team -- 1 rows
PASS [6.3] exactly one real VM and one agent record exist for the racing team
PASS [6.5] maxInstances exhaustion surfaces as a clean instancerError mentioning capacity -- {"kind":"instancerError","message":"no capacity: insufficient instance slots for 1 vCPU / 256 MiB / 128 MiB"}
PASS [6.6] the rejected team has no controller row
PASS [6.7] the rejected create leaked no VM
PASS [6.8] capacity returns after a delete (the third team can now start)
PASS [6.9] two live VMs are accounted for by the controller reservations -- reserved=2
```

### 7. Ambiguous create through a real TCP fault proxy

```
PASS [7.1] the provider reports the ambiguous create as starting (no transport error leaks to the player) -- {"kind":"instancerInstanceDetails","status":"starting",...}
PASS [7.2] the controller row stays creating after the swallowed response -- state=creating
PASS [7.3] the VM was really created despite the swallowed response -- forwarded=4r4urzrre1w7ic2ps6oh5m85
PASS [7.4] the reconciler adopts the live VM after an ambiguous create (same id, one VM) -- row=running
PASS [7.5] the adopted guest still serves the flag
PASS [7.6] the row stays creating when the create never reached the agent -- create={"kind":"instancerInstanceDetails","status":"starting",...} state=creating
PASS [7.7] the proxy captured the create request and the agent has no record of it -- captured=true
PASS [7.8] the fence DELETE removed the controller row
PASS [7.9] the agent wrote a durable tombstone for the fenced id -- bqtcp8krgj2mi9iblaj806rm
PASS [7.10] no VM, run dir or state record was leaked for the fenced id
PASS [7.11] a delayed PUT of the fenced create is rejected by the tombstone (409 conflict) -- HTTP 409 {"kind":"agentError","code":"conflict","message":"instance id was deleted"}
PASS [7.12] the delayed PUT created no VM
PASS [7.13] a later create for the same team works and gets a fresh id -- bqtcp8krgj2mi9iblaj806rm -> rhj39kgyma8q2hj4mryovbxj
```

Controller log for the fence:

```
{"level":40,"name":"firecracker-controller","instanceId":"bqtcp8krgj2mi9iblaj806rm","hostId":"fc1","msg":"reconciler: fencing ambiguous create; agent DELETE makes a late PUT conflict"}
```

Durable tombstone written by the real agent (`agent/state/tombstones/<id>.json`):

```json
{ "id": "bqtcp8krgj2mi9iblaj806rm", "atMs": 1794162752707 }
```

As explained in `README.md`, the swallowed-response case is correctly resolved by **adoption** (7.1–7.5);
the fence branch (7.6–7.13) needs a create the agent never received, so the proxy's second fault holds
the request instead of forwarding it. Both branches are real HTTP through the real controller/agent.

### 8–9. Orphan cleanup, drain

```
PASS [8.1] the agent accepts a VM the controller does not know about -- HTTP 200 {"id":"orphan4c3f313e3a","state":"starting",...}
PASS [8.3] the controller deleted the orphan VM, tap and record -- {"process":true,"stateFile":true,"runDir":true,"tap":true,"nft":true,"agent":true,"all":true}
PASS [8.5] no orphan process, run dir or nft rule is left behind
PASS [9.1] drain sets the host to draining -- HTTP 200 {"id":"fc1",...,"health":"draining",...}
PASS [9.2] a new create is refused with a clean no-capacity error while draining -- {"kind":"instancerError","message":"no capacity: all hosts are draining"}
PASS [9.3] the existing instance keeps running while the host is draining
PASS [9.4] the existing guest is still reachable while draining
PASS [9.5] undrain restores the host to healthy
```

Controller log for the orphan:

```
{"level":40,"name":"firecracker-controller","hostId":"fc1","instanceId":"orphan4c3f313e3a","msg":"reconciler: deleted orphan instance on agent"}
```

### 10. Auth

```
PASS [10.1] controller rejects a missing bearer token (401) -- HTTP 401
PASS [10.2] controller rejects a wrong bearer token (401) -- HTTP 401
PASS [10.3] the ops admin token is not accepted on the rCTF API route -- HTTP 401
PASS [10.4] the rCTF token is not accepted on the ops API -- HTTP 401
PASS [10.6] agent rejects a missing/empty bearer token (401) -- HTTP 401
PASS [10.7] agent rejects a wrong bearer token (401) -- HTTP 401
PASS [10.8] agent rejects an unauthenticated create and creates nothing -- HTTP 401
PASS [10.9] the provider surfaces an auth failure as a clean instancerError -- {"kind":"instancerError","message":"Unauthorized"}
```

### 11. Twenty create/delete cycles

Each cycle boots a real VM, serves the flag, deletes it, and then re-checks **global** state:
Firecracker processes, tun/tap links, per-lease nft rules, per-instance run dirs, agent state records,
controller rows, agent instance count and agent capacity usage. Cycle 1 and cycle 20 (all 20 are in
the log and in `results.json`):

```
PASS [11.1] cycle 1: create/run/delete leaves no leak -- served=true gone={"process":true,"stateFile":true,"runDir":true,"tap":true,"nft":true,"agent":true,"all":true} global={"processes":0,"taps":0,"runDirs":0,"stateFiles":0,"rows":0,"agentInstances":0,"usageInstances":0,"nftLeases":false} 2058ms
PASS [11.20] cycle 20: create/run/delete leaves no leak -- ... global={"processes":0,"taps":0,"runDirs":0,"stateFiles":0,"rows":0,"agentInstances":0,"usageInstances":0,"nftLeases":false} 2045ms
```

The agent's `tombstones/` directory grows (one small JSON fence per deleted id, 24 h TTL by design).
Those are durable fences, not leases, and are intentionally not counted as leaks.

### 12. Host removal (extra, normative in `ARCHITECTURE.md`)

```
PASS [12.1] removing a healthy host is refused with 409 -- HTTP 409
PASS [12.2] removing the unhealthy host returns 204 -- HTTP 204
PASS [12.3] the live row is written off as lost (unique key and reservation freed) -- state=lost reserved=0
PASS [12.4] the removed host stays draining (a config seed/heartbeat cannot resurrect it) -- health=draining
PASS [12.5] the returning agent deletes the written-off VM and its resources -- {"process":true,"stateFile":true,"runDir":true,"tap":true,"nft":true,"agent":true,"all":true}
PASS [12.6] undrain puts the removed host back into service -- HTTP 200 {...,"health":"healthy",...}
PASS [12.7] creates work again after the host is undrained
```

### Leftovers

```
pids matching /run/user/1000/fce-LV2Syk: none
taps: none
run dirs: none
agent state files: none
nft per-lease rules: none
PASS [L.1] no harness process was left behind
PASS [L.2] no tap device was left behind (probe must not fail)
PASS [L.3] no per-instance run dir was left behind
PASS [L.4] no per-instance agent state record was left behind
PASS [L.5] no per-lease nftables rule was left behind (probe must not fail)
PASS [L.6] pre-shutdown instance cleanup completed without swallowed errors -- cleanupFailures=0
```

`L.2` and `L.5` now fail if the probe itself fails, not just if a tap/rule is present; `L.6`
makes any swallowed `cleanupAllInstances` error visible and fails the run.

Final controller SQLite after the run (read with `sqlite3`):

```
instances 0
hosts [('fc1', 'healthy', 0, 1)]
```

Final namespace report from `inner.sh`:

```
== namespace leftovers
processes: none
taps: 0
nft tables: 2
table inet rctf_fc
table arp rctf_fc_arp
```

(The two empty tables are the agent's base chains; no per-lease rules remain.)

## Assertion hardening (2026-11-08)

The original harness had several assertions that could pass when the observation itself failed.
After the review, the following changes were made and re-verified with four consecutive full runs
(128/128, exit 0):

1. **Strict absence probes.** `probes.ts` replaces the old `tapsInNetns`/`nftText`. `tapsInNetns`
   throws on a non-zero `ip` exit. `nftText` throws on a non-zero `nft` exit **and** when either
   base table (`inet rctf_fc`, `arp rctf_fc_arp`) is missing. `pidsMatching` distinguishes
   “pgrep found nothing” (exit 1) from “pgrep failed” (other non-zero) and throws on the latter.
   Every run also calibrates live: `1.2a` requires the running lease's tap to be listed and the
   nft text to reference both its tap name and guest IP; each of the 20 cycles calibrates again
   before deleting and then asserts absence. The orphan case (`8.2`, `8.5`) does the same.
2. **Identity is mandatory.** `requireIdentity` throws if an agent record has no `vm.pid`, no
   `lease.tapName` or no `lease.guestIp` after `running`. `probeTeardown` no longer accepts
   `undefined`, and all `pid === undefined ? true` branches are gone. `1.13a` additionally
   asserts that no Firecracker process for the run remains.
3. **The extend/expiry race is no longer “either outcome”.** `3.4a`/`3.4b` require the extend
   issued six seconds before the deadline to be accepted; `3.4` then requires the process, guest
   and provider state to survive 2.5 s past the original deadline. The separate `3.5a`/`3.5`
   waits until the deadline has actually passed, then requires rejection and full teardown.
   Four consecutive runs passed with ~6 s of margin each time.
4. **Agent-down is a failure.** `agentList` now throws on any non-200 (or a non-array body)
   instead of returning `[]`. `9.7` requires zero agent instances, controller rows, Firecracker
   processes, taps and run dirs, with the agent demonstrably up.
5. **The flag scan is not allowed to skip files.** `scanFilesContaining` returns `hits`,
   `unreadable` and `scanned`; `1.6` fails if anything is unreadable. It explicitly stats and
   opens the per-instance `rootfs.ext4` and `vm-identity.json` (and still scans the whole run
   tree, which covers any MMDS/vsock/config sidecar the agent writes there).
6. **Safe cleanup.** `inner.sh` no longer does `pgrep -f "$RUN"` + `kill -9` on everything that
   matches. It records the PIDs the driver started under `$RUN/pids/`, reads Firecracker PIDs from
   agent state, and only kills a PID when it is same-uid, its `argv[0]` is one of the known
   binaries (`bun`/`bun.exe`/`firecracker`) and its argv contains this run's unique directory.
   Unmatched PIDs are left alone.
7. **Soft failures are visible.** `cleanupAllInstances` logs and counts every failed DELETE or
   thrown cleanup (`L.6` fails the run); `Report.group` prints the full exception/stack and records
   a failure, so an aborted scenario exits non-zero and cannot silently reduce the assertion count.

Mutation sanity: `deploy/firecracker/e2e/selftest.sh` runs `selftest.ts` in a tap-free
`unshare -Urn`. It verifies the tap probe throws on a failing `ip`, the nft probe throws on a
failing `nft` and on missing tables, calibration fails with zero taps, the real `ip` probe sees a
tap-free netns, and calibration passes for a visible lease. All checks pass:

```
PASS selftest: tap probe rejects a non-zero ip exit
PASS selftest: nft probe rejects a non-zero nft exit
PASS selftest: nft probe rejects missing base tables
PASS selftest: calibration fails with zero taps
PASS selftest: real ip probe succeeds in the tap-free selftest netns (0 taps)
PASS selftest: calibration passes when the lease tap and IP are visible
selftest: all mutation checks passed
```

## Product finding

### F1 — `mode: direct` agents are never `accepting` without a writable cgroup2 root (FIXED)

**Status: fixed** in commit d5c17f1c (`cgroupRoot` preflight is now gated on jailer mode, with a regression test in `apps/firecracker-instancer/test/vm/preflight.test.ts`). The harness originally worked around it by pointing `vm.cgroupRoot` at the user's delegated cgroup subtree; that workaround and the repro script were removed and the full run re-verified against the fix. The text below is the original finding.

**Repro:** `deploy/firecracker/e2e/repros/direct-mode-cgroup-root.sh` (real agent, real preflight,
inside `unshare -Urn`, `vm.mode: direct`, `vm.cgroupRoot: /sys/fs/cgroup`).

Observed:

```json
{"accepting":false,"cgroupRoot":false,"other_checks":{"recovered":true,"orphanBacklog":true,"stalledOperations":true,"kvm":true,"firecrackerBin":true,"jailerBin":true,"imagesDir":true,"imagesTrusted":true,"runDir":true,"chrootBase":true,"apiSocketPath":true,"nft":true,"ip":true,"conntrackBin":true,"ipForward":true,"traefikDirWritable":true,"quarantineWritable":true,"tcpPortRange":true,"subnetPool":true}}
REPRODUCED: direct-mode agent is not accepting because cgroupRoot is not writable
```

Every check except `cgroupRoot` is true, including `kvm`, `firecrackerBin`, `runDir` and
`apiSocketPath`; the smoke test boots real VMs in exactly this environment. But `cgroupRoot` is a
**hard** check (only `reflink` is in `INFORMATIONAL_CHECKS`), so `accepting` is false and the
controller's `isPlaceable()` refuses every placement on the host (`no capacity: no host is
accepting instances`). In `mode: direct` cgroups are never used — the jailer is the only consumer —
and the sibling check `chrootBase` is already mode-gated (`config.mode === 'jailer' ? … : true`).
The same gate breaks the smoke environment for any controller-backed use, and most CI containers /
user namespaces have a read-only `/sys/fs/cgroup`.

**Impact:** a direct-mode host can never receive instances in an unprivileged/dev/CI environment,
even though it can boot VMs. This was invisible before because no test ran the controller against the
real agent.

**Workaround used by this harness (no `src` change):** point `vm.cgroupRoot` at the user's
systemd-delegated cgroup2 subtree (`/sys/fs/cgroup/user.slice/…/user@1000.service/…`, computed from
`/proc/self/cgroup`). It is a real cgroup2 mount descendant and is writable as userns root, so the
real `stat`/`access`/`/proc/mounts` preflight passes. With that, `cgroupRoot: true` and all 122
assertions ran. The harness does **not** patch the agent or fake the check.

No other product bugs were found: every requested invariant held against the real components.

## Observations (not bugs)

- The reconciler logged `reconciler: deleted orphan instance on agent` twice for ids
  (`fec4bdyctryy9rcau5rwq8uu`, `p9xabxx50rqyet8w1h3qacf2`) whose controller row was concurrently
  removed by the player's own delete. The agent listing was stale relative to that delete; the
  reconciler's `DELETE` hit an already-removed id (404 + tombstone refresh). No live instance was
  touched and no resource leaked (`2.8`, `L.1–L.5`). This is the documented “a listing is a hint”
  behaviour.
- The agent's `tombstones/` directory keeps one fence per deleted id (24 h TTL). Expected.

## Not run / limitations

- Jailer mode, Traefik/TLS, HTTP(S)/tcp-ssl endpoints, `egress: true` masquerade, and public DNAT
  from outside the namespace: not possible unprivileged / not applicable to this contract test.
  See `README.md` for the full table.
- Clock-skew rejection and deadline translation: controller and agent share the host clock (~0 skew);
  covered by controller unit tests.
- Multi-host failover/spread: one host.
- Conntrack entry inspection: `conntrack -D` runs for real (`requireConntrack: true`) but entries are
  not inspected.
- The `RESULTS.md` run dir is on tmpfs and will not survive a reboot; the assertions are reproduced
  by re-running `run.sh`.

## Flag-absence probes fail closed (2026-11-08, re-verification)

A review found that the flag-absence checks could pass when the observation itself failed:
`scanFilesContaining` swallowed a missing root (returning `{hits:[],unreadable:[],scanned:0}`),
`walkFiles` swallowed `readdir`/`stat` errors, and `readProcCmdline` returned `''` on a read
failure, which satisfies `!cmdline.includes(FLAG)`. The fixes and their mutation proofs:

1. `walkFiles` now throws on a failed directory enumeration or `stat`; `scanFilesContaining`
   throws when a scan root cannot be `stat`ed or is neither a file nor a directory. The
   driver's 1.6 additionally requires `scanned > 0`, so a scan that read nothing fails.
2. `readProcCmdline` throws on any read failure; `processAlive` tolerates only `ENOENT`/`ESRCH`
   (a process that really exited) and propagates other errors. 1.7 requires a successfully
   read, non-empty command line before asserting the flag is absent.
3. `selftest.sh` grew from 6 to 11 checks: nonexistent scan root, dangling-symlink root
   (`stat` failure), nonexistent pid for `readProcCmdline`, `processAlive` false for a
   nonexistent pid, and a positive real scan (`scanned=10`, `hits=5`).

One full run after the change:

|                  |                                                                            |
| ---------------- | -------------------------------------------------------------------------- |
| Date             | 2026-11-08 (America/Denver)                                                |
| Command          | `SMOKE_ARTIFACTS=$HOME/.cache/rctf-fc-smoke deploy/firecracker/e2e/run.sh` |
| Run dir          | `/run/user/1000/fce-vzUdmi`                                                |
| Result           | **128 passed, 0 failed, 128 assertions**                                   |
| Driver exit code | **0**                                                                      |
| Selftest         | **11 passed, 0 failed**                                                    |

```
PASS [1.6] the flag appears nowhere in controller sqlite, agent state, logs or the guest disk image (and every scanned file was readable) -- {"agent state":0,"agent traefik dir":0,"per-instance disk/run dir":0,"per-instance rootfs.ext4 (explicit)":0,"per-instance vm-identity.json":0,"controller sqlite":0,"logs":0,"whole run tree (configs, driver output, everything)":0,"scannedFiles":26,"rootfs":"readable","identity":"readable","unreadable":[]}
PASS [1.7] the flag is absent from the firecracker process command line (and the command line was actually read) -- pid=231154 cmdlineChars=158
RESULT: 128 passed, 0 failed, 128 assertions
driver exit code: 0
```

The rest of the run (groups 2–12 and the leftovers) was unchanged from the 128-assertion
baseline above; the full log is `/tmp/opencode/e2e-run.log` on the run host. This is one
post-change run, not four: it is reported as such rather than as a repetition of the earlier
four-run result.
