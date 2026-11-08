# Firecracker instancer — architecture

A fully supported rCTF challenge backend (`instancers/firecracker`) that runs
**one Firecracker microVM per team per challenge**, booted from a prebuilt
kernel + rootfs.

```
 rCTF API ──(Bearer authToken)──► controller ──(Bearer per-host token)──► host agent ─► firecracker/jailer ─► guest
 apps/api provider               scheduler, SQLite,                       (root, KVM, nft,       (untrusted)
 firecracker-instancer.ts        reaper, reconciler                        Traefik files)
```

Three deployables from two code locations:

| Piece                                                    | Where                                                       | Runs on                         |
| -------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------- |
| Provider adapter                                         | `apps/api/src/providers/instancer/firecracker-instancer.ts` | rCTF API                        |
| Protocol (zod schemas, ids, error codes, guest contract) | `packages/firecracker` (`@rctf/firecracker-protocol`)       | shared                          |
| Controller                                               | `apps/firecracker-instancer/src/controller`                 | one box (no privileges, no KVM) |
| Host agent                                               | `apps/firecracker-instancer/src/agent`                      | each KVM host (root)            |

Bun + TypeScript + zod/mini, like the rest of the repo. Controller state is
`bun:sqlite`; agent state is JSON files. **Flags are never persisted anywhere.**

## Source of truth

- **Controller SQLite** owns _which team has which instance on which host_ and the
  _capacity reservations_. The instance's host is pinned at creation and never changes.
- **Agent** owns _what physically exists on the host_ (VMs, taps, rules, ports) and
  mirrors its instance records on disk (`stateDir/<id>.json`, atomic write+rename,
  mode 0600, no flags) so it can re-adopt after a restart.
- The controller **reconciles** DB vs agent listings; the agent **reconciles** its state
  files vs the host (processes, taps, nft, Traefik files, dirs). Anything on a host that
  no record owns is an orphan and gets removed (after a short grace for in-flight creates).

## Instance lifecycle

Controller row states: `reserving → creating → running → deleting → (row removed / tombstoned)`; `errored`
and `lost` are terminal-until-delete. Agent states: `creating, starting, running, stopping, stopped, errored`.

1. `PUT create` (rCTF): validate challenge config → one transaction `BEGIN IMMEDIATE`: if a live row exists for
   `(teamId, challengeIntegrationId)` return it (idempotent / concurrent-safe via UNIQUE index on live rows);
   else pick a host (healthy, not draining, fits `capacity × overcommit − reserved`), insert the row
   with the reservation and a random instance id. → call agent `PUT /v1/instances/:id`.
   Only a **definitive pre-create rejection** (`no_capacity`, `draining`, `invalid_request`, `unauthorized`)
   releases the reservation and tries the next host (bounded); all such failures ⇒ `no_capacity` error to the
   player. A **transport error, timeout, 5xx or any other ambiguous outcome** does **not** release the reservation
   or fail over: the row stays `creating`, pinned to that host, holding the key and reservation until the
   reconciler adopts the VM or fences it (see "Ambiguous creates and fencing" below). Flags only live in
   request memory.
2. Agent `create`: reserve against its own limits (second line of defence) → `NetworkManager.allocate` →
   `VmDriver.launch` → `NetworkManager.publish` → state `starting` → `VmDriver.waitReady` → `running`; failure ⇒
   `errored`, release everything, keep a tombstone record until the controller deletes/forgets it.
3. `extend`: authoritative at the controller. CAS in SQLite:
   `UPDATE … SET expires_at=now+timeout WHERE state IN (creating,running) AND expires_at>now` (never extends past
   `maxLifetime` if configured). Then push `expiresAtMs` to the agent (monotonic max). If the push fails it is
   retried by the reconciler. Expired ⇒ `expired` error.
4. Expiry: the controller reaper claims `state=running AND expires_at<=now` via CAS to `deleting`, then tells the agent to delete.
   Extend and expiry race on the same row, so exactly one wins. The **agent also has a dead-man deadline**:
   at `expiresAtMs + expiryGraceSeconds` it destroys the VM on its own (controller loss ≠ leaked VMs forever).
5. `delete`: CAS to `deleting` (idempotent), agent `DELETE` (idempotent; unknown = done), then row removed and the
   reservation released _only after the agent confirmed_. If the host is unreachable the row stays `deleting`
   (player sees `stopping`) and is retried; after `hostLostSeconds` it is written off: the unique key is freed,
   the row is tombstoned, the host's orphan cleanup finishes the job when it returns.

### Ambiguous creates and fencing (normative)

A create whose outcome is unknown (timeout, connection reset, HTTP 5xx or a malformed 2xx — _anything except a documented
pre-create rejection_: `no_capacity`, `draining`, `invalid_request`, `unauthorized`) keeps its row in `creating`, pinned to that
host, holding the key and reservation. The reconciler resolves it: `get(id)` finds the VM ⇒ adopt; still absent after
`createFenceSeconds` (default 45) ⇒ row becomes `deleting` and the controller sends `DELETE` — which makes the agent write a
**tombstone** so a delayed original `PUT` can never create the VM (see agent protocol, FENCING) — and only when the agent
confirms (200/404) is the row removed and the key freed. Absence is never inferred from a single listing: a listing can be
stale relative to concurrent creates, so every "missing on agent" conclusion is re-confirmed with a fresh per-id `get` and applied
with a version CAS on the row snapshot taken **before** the listing.

### Agent crash safety (normative)

- **Ownership before side effects.** The agent persists `netMayHold`/`vmMayHold` on the instance record BEFORE `net.allocate`, `vm.launch` and `net.publish`.
  Teardown always runs the idempotent `net.release(id)`/`vm.destroy(id)` even when a call timed out and its outcome is unknown. Every unsettled call is tracked
  once; DELETE answers `409 in_progress` (the controller keeps ownership and retries) until it has settled and release/destroy succeeded. A call that never
  settles cannot be cancelled through the interfaces: after `pendingOperationAbandonSeconds` the host reports `accepting:false` (check `stalledOperations`)
  while ownership and capacity stay accounted. Sweeps never wait on an unsettled call, so one stuck instance cannot delay another's dead-man expiry.
- **Recovery gate.** Until every record is loaded, restored into the network manager (`restore(live, { retiring })`) and orphan discovery has succeeded, the agent
  answers PUT/PATCH/DELETE with `503 host_unavailable`, GET/list with the same until the records are loaded, and `/v1/info` reports `recovered:false,
accepting:false`. Recovery is retried by the sweep. A read error on any state/tombstone file fails recovery closed; a MALFORMED file is replaced by a
  durable conservative tombstone first and only then quarantined.
- **Interrupted teardown resumes.** Leases of `stopping` records are passed to `net.restore` as `retiring`: adopted already fenced and reserved, so the following
  `release` performs the real fence -> routes -> tap -> conntrack flush -> durable quarantine. An empty in-memory network state is never taken as a completed release.
- **Network release order.** fence (blocking rules only) -> remove routes -> delete tap -> flush conntrack -> persist the reuse quarantine -> free resources ->
  re-render the table without the lease. Any failure leaves the lease reserved and fenced and release retryable. Taps carry an ownership alias; only interfaces
  with the alias AND link type tun/tap are ever adopted or deleted.
- **VM identity.** A process is signalled/adopted only after its executable device+inode, uid and jail root match the trusted anchor (per-instance identity
  file, jail executable, configured binary); command-line text never authorises a signal. `destroy` refuses to report success while an unauthenticatable
  firecracker/jailer process for the id exists.

### Host removal and clocks (normative)

`removeHost` is only allowed for an `unhealthy` host (409 otherwise): it writes the host's rows off as `lost` tombstones (cleanup
still happens when the agent returns) and leaves the host `draining` (persisted; config seeding never clears it) until an operator
`undrain`s. Heartbeats run concurrently with a per-probe deadline and each host is judged on its own last success. Deadlines sent to
an agent are translated to the agent's clock using the skew measured from `AgentInfo.timeMs`; a host beyond `maxClockSkewSeconds`
(default 10) takes no new placements. Known limitation: when a host is written off after `hostLostSeconds`, a partitioned agent may
keep the old VM running until its own dead-man deadline, so a team can briefly have two live instances in that rare case.

## Scheduling and capacity

Per-host reservation = Σ(vcpus, memMiB, diskMiB, 1) of rows in `reserving|creating|running|deleting` (a deleting row still
holds its resources until the agent confirms). Placement is a single SQLite write transaction ⇒ no oversubscription
under races. Pick order: most free memory first among healthy hosts (spread). Hosts are static in controller config
(`hosts[]`); drain/undrain flags are persisted in SQLite. Heartbeat = `GET /v1/info` every N s; `hostTimeoutSeconds`
without a reply ⇒ `unhealthy` (no new placements; existing rows read as `errored`/`stopping`).

## Guest network model (supported assumptions)

- One tap per VM, a dedicated **/30** per VM carved from `subnetPool` (host = .1, guest = .2). No bridge ⇒ VMs share no L2 segment.
- nftables tables `inet rctf_fc` and `arp rctf_fc_arp` (owned entirely by the agent; rendered as a pure function of the live leases and
  applied atomically in one `nft -f -`). The forward chain is `policy accept` with rules scoped to `fctap*` only, so unrelated host
  forwarding (Docker, VPN) is untouched. Per allocated lease, always (even when unpublished): forward drop between taps, anti-spoof
  (`iifname tap` ⇒ `saddr == guestIp`, `ether saddr == guestMac`), ARP sender/target filtering, IPv6 drop, input from taps to the host
  dropped except established replies scoped to that lease's own tap/IP pair, egress dropped unless `egress: true` (then masquerade via
  `externalInterface`, and still never to RFC1918/link-local/CGNAT/loopback/the host or the VM pool). DNAT matches `fib daddr type local`.
- **Reuse safety:** releasing or unpublishing a lease flushes its conntrack entries in all four directions (`conntrack-tools` required;
  `requireConntrack: false` only for dev) and a freed /30 index or public port is quarantined for `reuseQuarantineSeconds` (default 120)
  before it can be handed out again, so a new tenant can never inherit a previous tenant's flows. Release is retryable: if a tap or flush
  fails the lease stays reserved. Taps are only deleted when this agent created them; a foreign interface named `fctapN` blocks that
  index and is never removed. All routes are rebuilt from `NetLease.expose` + `publicPorts/publicHostnames` (there is no sidecar state).
- Public **TCP/raw**: DNAT `publicHost:<port from tcpPortRange> → guestIp:port`, one port per exposed entry, allocated and released with the lease.
- Public **HTTP/HTTPS/TCP-SSL**: per-instance Traefik file-provider config in `traefikDynamicDir`
  (`Host(<hostPrefix>-<first 20 chars of instance id>.<httpDomain>)` → `http://guestIp:port`; TLS terminated by the operator's Traefik with a wildcard cert
  for `*.<httpDomain>`). With several hosts each host has its own `httpDomain` (e.g. `fc1.ctf.example.com`), so DNS wildcard
  `*.fc1.ctf.example.com → host 1` pins routing without a shared front door.
- IPv4 only. The host must have `net.ipv4.ip_forward=1`.

## Guest boot contract (v1)

Kernel cmdline: `console=ttyS0 reboot=k panic=1 pci=off ip=<guestIp>::<hostIp>:255.255.255.252::eth0:off <extra kernelArgs>` (guest kernel needs `CONFIG_IP_PNP`).
After boot, init fetches the MMDS **V2** document (token via `PUT /latest/api/token`, then `GET /` with `Accept: application/json`, needs a
route to 169.254.169.254 on eth0) — schema `guestMetadataSchema` in `packages/firecracker/src/guest-metadata.ts` — and exports `flags`/`env` to the
service. Flags are only ever in firecracker's memory (MMDS), never on cmdline/drive/host disk/logs.
`rootfs.ext4` is copied (reflink if available) per instance; the base image is never written. Readiness = TCP/HTTP probe from the host over the tap.

## File ownership (parallel work — touch only your own files)

| Track / worker            | Owns                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 Provider + API surface  | `apps/api/src/providers/instancer/firecracker-instancer.ts`, `instancer/index.ts` (registration), `src/controller/server.ts`, `src/controller/auth.ts`, `tests/server/tests/unit/firecracker-*.test.ts`, `src/controller/index.ts` (wiring/entrypoint) |
| 2 VM                      | `src/agent/vm/**`, `deploy/firecracker/guest/**`                                                                                                                                                                                                       |
| 3 Network/routing         | `src/agent/net/**`, `src/agent/routing/**`, `deploy/firecracker/host/**`                                                                                                                                                                               |
| 4 Agent manager           | `src/agent/manager.ts`, `src/agent/state.ts`, `src/agent/server.ts`, `src/agent/index.ts`, `src/agent/config.ts`                                                                                                                                       |
| 5 Controller core         | `src/controller/{store,scheduler,hosts,agent-client,service,reconciler,reaper,config}.ts`                                                                                                                                                              |
| 6 Docs/integration (lead) | `apps/docs/**`, `deploy/firecracker/**` top-level, README                                                                                                                                                                                              |

Shared and frozen (lead approves changes): `packages/firecracker/**`, `src/interfaces.ts`, this file.
Tests live next to the owner's code in `apps/firecracker-instancer/test/<area>/` (providers tests under `tests/server`).
Each module has real-invariant tests (duplicate requests, partial failure rollback, restart, races), not just mirrors of the implementation.
Anything that needs root/KVM/nft must be isolated behind an injectable `CommandRunner`/fs seam and covered by a root-only test that is
`test.skipIf(!process.env.FC_REAL)`.

## Security boundaries

1. Guest is hostile: jailer (uid/gid, chroot, cgroups, seccomp default), rate limiters on disk/net, no virtio-fs, no vsock, MMDS only.
2. Agent is privileged: authenticated (constant-time bearer), bind to private iface, every id/path/image/hostname validated by the
   regexes in `common.ts`; image path resolved with `realpath` and required to stay under `imagesDir`; no shell — `Bun.spawn` with argv arrays only.
3. Controller → agent auth per host; rCTF → controller auth separate from ops admin token.
4. Flags: request memory → MMDS only. Redact in logs via `redactSpec`. Never in cmdline, files, SQLite, error messages.
5. Team isolation: per-VM /30 + nft forward-drop + anti-spoof; hostnames contain a random instance id, never the team id.
