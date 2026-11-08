# Unprivileged end-to-end harness: rCTF provider → controller → agent → real Firecracker

This directory contains the only test that runs the **real** Firecracker instancer stack
end-to-end, without root:

```
 rCTF provider code                 controller process             agent process                  Firecracker
 apps/api/src/providers/            (real HTTP, real               (real VmDriver, real           microVM under KVM
 instancer/firecracker-             bun:sqlite, scheduler,        NetworkManager, real           (real kernel + rootfs,
 instancer.ts)                      reaper, reconciler)           nft/taps/conntrack)            real MMDS flag delivery)
        │                                  │                              │                              │
        └──── HTTP (Bearer) ───────────────┴──── HTTP (Bearer) ────────────┴──── unix socket + tap ─────────┘
                                    optional TCP fault proxy (only for scenario 7)
```

Everything runs inside `unshare -Urn` — a private **user + network namespace** — exactly like
`deploy/firecracker/smoke/run.sh`. The taps, nftables tables and microVMs are real, but they are
invisible to the host and cannot reach its network. There is no `sudo` and none is needed.

The existing unit/integration tests (`tests/server/tests/unit/firecracker-stack.test.ts`, etc.) use
**fake** agents/VMs/networks. This harness replaces those fakes with the real agent process and real
Firecracker; that is the point of it.

## How to run

Prerequisites (all already present on the development host used for `RESULTS.md`):

- `/dev/kvm` readable and writable by the user
- unprivileged user namespaces (`unshare -Urn` works)
- `bun` on `PATH` (`export PATH=$HOME/.local/bin:$PATH`)
- `nft`, `ip`, `conntrack`, `pgrep`, `curl`, `jq`, `python3`, `timeout`
- artifacts from `deploy/firecracker/smoke/fetch-artifacts.sh`, already fetched. This harness **never
  downloads anything** and mounts nothing; it only reads them:

```sh
export PATH=$HOME/.local/bin:$PATH
export SMOKE_ARTIFACTS=$HOME/.cache/rctf-fc-smoke   # read-only
deploy/firecracker/e2e/run.sh
```

Useful knobs:

| Variable            | Default                  | Meaning                                           |
| ------------------- | ------------------------ | ------------------------------------------------- |
| `SMOKE_ARTIFACTS`   | `~/.cache/rctf-fc-smoke` | firecracker, `images/smoke/{vmlinux,rootfs.ext4}` |
| `E2E_TIMEOUT`       | `900`                    | outer hard bound (seconds, `timeout(1)`)          |
| `E2E_INNER_TIMEOUT` | `840`                    | bound for the driver itself                       |
| `LOG_LEVEL`         | `info`                   | controller/agent pino level                       |

A run creates a unique short directory under `$XDG_RUNTIME_DIR` (`fce-XXXXXX`, ~24 bytes; the longest
unix socket path is `$RUN/agent/run/<24-char id>/api.sock` ≈ 68 bytes, well under `SUN_LEN` 108).
Logs, configs, the controller SQLite database, the agent state and `results.json` stay there for
inspection; the path is printed at the start and end. Exit code 0 means every assertion passed.

Typical runtime on the reference host: **~2 minutes** (20 VM boots + all fault scenarios).

## What is real

- `apps/api/src/providers/instancer/firecracker-instancer.ts` is imported and called directly — the
  same code the rCTF API uses (`createInstance`, `getInstance`, `extendInstance`, `deleteInstance`).
- The controller runs as a **separate process** via `src/controller/index.ts`, with the real HTTP API,
  real `bun:sqlite` database, scheduler, host monitor, reaper and reconciler. It is restarted and
  `kill -9`ed mid-flight.
- The agent runs as a **separate process** via `src/agent/index.ts`, with the real `VmDriver`, real
  `NetworkManager`, real `nft`, real tap devices and real `conntrack`. It is `kill -9`ed while VMs run
  and restarted.
- Real Firecracker microVMs boot under KVM from the smoke artifacts; the guest `init` fetches the
  **MMDS v2** document and the guest service serves the flag. The flag is compared byte-for-byte.
- The controller SQLite file, the agent state directory (`<id>.json`, `tombstones/`), the Traefik
  directory, the per-instance rootfs and the agent/controller logs are read and grepped as real
  on-disk state.

## What is simulated, injected, or not covered

| Area                                   | In this harness                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ambiguous create (scenario 7)          | A small TCP proxy (`proxy.ts`) between controller and agent injects two faults: **drop-response** (forward the create, wait for the complete agent response, close the controller connection without relaying it — the VM exists) and **hold-request** (capture the create and close the controller connection without forwarding — nothing exists). See the scenario notes below. |
| Crashes                                | `SIGKILL` of the controller and of the agent, plus process restarts. No kernel panic / power loss.                                                                                                                                                                                                                                                                                 |
| Jailer mode                            | **Not covered.** The jailer needs real root (chroot, `mknod`, cgroups); the harness uses `vm.mode: direct` like the smoke test.                                                                                                                                                                                                                                                    |
| Traefik / TLS / HTTP(S) endpoints      | **Not covered.** Only a public `tcp` expose entry is used; its endpoint is verified by shape and against the lease's allocated public port. Actual reachability is measured at the guest IP over the tap (the smoke test covers the same).                                                                                                                                         |
| Public DNAT from outside the namespace | **Not covered** — there is no outside in a private network namespace. The nftables table is still real and rendered for the lease.                                                                                                                                                                                                                                                 |
| `egress: true` masquerade              | **Not covered** (no uplink).                                                                                                                                                                                                                                                                                                                                                       |
| Conntrack flushing                     | The agent runs with `requireConntrack: true`, so every release executes the real `conntrack -D` sequence; the harness does not inspect conntrack entries (it would need privileged host access).                                                                                                                                                                                   |
| Clock skew                             | Controller and agent share the host clock, so the measured skew is ~0. The skew-rejection / deadline-translation paths are covered by the controller unit tests, not here.                                                                                                                                                                                                         |
| Multi-host failover / spread           | **Not covered.** One host, one controller. Capacity and drain are exercised on that host.                                                                                                                                                                                                                                                                                          |
| Reuse quarantine                       | The 20-cycle test deliberately gets fresh `/30` indices and public ports because the default 120 s reuse quarantine is active; it does not test reuse.                                                                                                                                                                                                                             |
| Guest isolation                        | Covered by `deploy/firecracker/smoke/` (measured from inside two guests); this harness focuses on the provider/controller/agent contract.                                                                                                                                                                                                                                          |

## Scenario map (assertion IDs)

The driver prints `PASS [id] name -- detail` for each assertion. IDs are grouped by the requested
check:

| Group | Scenario                                                                                                                                                                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Full lifecycle through the provider: create → get running with endpoint → flag byte-for-byte in the guest → flag absent from all durable state → extend → delete → full teardown.                                                                                           |
| 2     | Idempotent create: same team/challenge returns the same row/instance and no second VM; a changed spec is rejected by the **agent** with `409 spec_mismatch` (the controller documents idempotency by key and returns the live row).                                         |
| 3     | Expiry: a 6 s lifetime is reaped on time (real VM/tap/row gone); extend inside the window keeps the VM alive past the old deadline; extend after the deadline is rejected and the VM dies.                                                                                  |
| 4     | Controller restart: a running instance is adopted from SQLite; a duplicate create launches nothing; a `SIGKILL` **mid-create** is adopted after restart with the same id and one VM.                                                                                        |
| 5     | Agent `kill -9`: the VM survives, the guest keeps serving, the restarted agent re-adopts the same pid and tap.                                                                                                                                                              |
| 6     | Capacity: 8 concurrent creates for one team race to exactly one row/VM; `maxInstances` exhaustion surfaces as a clean `instancerError` mentioning capacity with no VM leak; capacity returns after a delete.                                                                |
| 7     | Ambiguous create (proxy): the swallowed-response case is **adopted** (row `creating` → `running`, one VM); the never-delivered case stays `creating`, is fenced with `DELETE`, the id is tombstoned durably, the delayed PUT gets `409 conflict`, and a later create works. |
| 8     | Orphan: a VM created directly on the agent (unknown to the controller) is deleted by the reconciler, with its tap/run dir/process.                                                                                                                                          |
| 9     | Drain: new creates refused (`no capacity: all hosts are draining`), existing instance keeps running and serving, undrain restores creates.                                                                                                                                  |
| 10    | Auth: missing/wrong/cross tokens rejected on controller and agent; the provider surfaces auth failure as a clean `instancerError`.                                                                                                                                          |
| 11    | 20 sequential create/delete cycles: after each cycle no leaked Firecracker process, tap, nft per-lease rule, run dir, agent state record, controller row, or agent lease/usage.                                                                                             |
| 12    | (extra) Host removal: a healthy host is not removable (409); an unhealthy host is removable (204), its rows become `lost`, it stays draining; the returning agent deletes the written-off VM; undrain restores service.                                                     |
| L     | Final leftovers: no harness process, tap, run dir, state record or per-lease nft rule.                                                                                                                                                                                      |

### Scenario 7 in detail (why two faults)

A create whose response is swallowed **after the agent created the VM** is, by design, resolved by the
reconciler **adopting** the live VM — that is the safe outcome and is asserted in 7.1–7.5. The
`createFenceSeconds` fence branch only applies when the agent has **no** VM (otherwise adopting is
correct). To exercise the fence deterministically, 7.6–7.13 use the proxy's `hold-request` fault: the
controller's create is captured and never reaches the agent, so after `createFenceSeconds` the
reconciler sends `DELETE`, the agent writes a durable tombstone, the row is removed, and replaying the
captured request later returns `409 conflict` — exactly the delayed-PUT hazard the fence exists for.

The proxy controller is configured with an effectively manual reconcile interval
(`reconcileIntervalSeconds: 3600`); the harness triggers reconciler ticks by restarting the controller,
which makes “row is still `creating`” and “the fence ran” deterministic instead of timing-dependent.

## Cleanup and safety

- `run.sh` creates a unique run dir with `mktemp`; nothing is shared with parallel workers.
- The namespace is private, so taps/nftables cannot collide with other workers or the host.
- Processes are only ever killed by **PID**, and only PIDs whose full argv contains this run's unique
  directory (the agent/controller YAML path or `$RUN/agent/run/<id>`). No `pkill` by process name.
- `inner.sh` has an `EXIT/INT/TERM` trap that kills only those PIDs and prints the leftover
  processes/taps/nft tables. The driver installs its own `SIGTERM`/`SIGINT` handler, deletes any
  remaining instances through the real agent, stops the controller and agent, then reports leftovers.
- Fixed loopback ports (17000 controller, 17001 agent, 17002 proxy) are safe because the network
  namespace is private.

## Files

- `run.sh` — outer wrapper: checks prerequisites, creates the short run dir, `exec`s `unshare`.
- `inner.sh` — namespace setup (lo, dummy0, ip_forward), trap, runs the driver.
- `driver.ts` — real provider + process orchestration + scenarios/assertions + leftover report.
- `harness.ts` — assertions/report, polling, HTTP, SQLite observation, filesystem grep, process control.
- `proxy.ts` — the TCP fault proxy used only by scenario 7.
- `RESULTS.md` — dated log of the actual run with excerpts.
