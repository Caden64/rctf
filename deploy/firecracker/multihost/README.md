# Real multi-host verification (two nested-KVM QEMU VMs + real controller)

This harness proves the Firecracker instancer's **multi-host** behaviour with real
processes and real microVMs:

```
                    this unprivileged machine
   ┌─────────────────────────────────────────────────────────────────────┐
   │  real provider code (imported)  ──HTTP──► ssh -L forward            │
   │  driver.ts (assertions)                 │                           │
   │  ssh observation of both agents         │                           │
   └─────────────────────────────────────────┼───────────────────────────┘
                                             │ management ssh (QEMU user net)
                    ┌────────────────────────▼───────────────────────┐
                    │ host-a VM  (root, nested KVM)                   │
                    │   controller (real HTTP, bun:sqlite, scheduler) │
                    │   agent host-a under the shipped systemd unit, │
                    │     JAILER mode, real Firecracker guests        │
                    │   eth1 10.77.0.10                               │
                    └────────────────────────┬───────────────────────┘
                                             │ private link:
                                             │ QEMU -netdev dgram over two
                                             │ AF_UNIX sockets in a 0700 dir
                                             │ (no multicast, no host NIC)
                    ┌────────────────────────▼───────────────────────┐
                    │ host-b VM  (root, nested KVM)                   │
                    │   agent host-b under the shipped systemd unit, │
                    │     JAILER mode, real Firecracker guests        │
                    │   eth1 10.77.0.11                               │
                    └─────────────────────────────────────────────────┘
```

The two VMs are joined by a **point-to-point Ethernet link that exists only
inside this host**: each QEMU binds one `AF_UNIX` datagram socket
(`-netdev dgram,local.type=unix,local.path=…,remote.type=unix,remote.path=…`)
in the per-run `link/` directory, and every frame is sent to the peer socket
path. There is no multicast group, no UDP/TCP port, no bridge and no tap. The
directory is mode 0700 and owned by the test user, so no other machine and no
other local user can observe or inject the controller→agent HTTP traffic
(bearer tokens, flag metadata, API responses) that crosses the link. The link
paths are unique per run, so parallel workers cannot share a segment.

Nothing privileged runs on the developer machine: `vm.sh` only starts
`qemu-system-x86_64` as the current user and forwards one ssh port per VM. All
root operations (systemd, jailer, nftables, taps, cgroups, conntrack) happen
inside the VMs. Memory: two VMs × 3584 MiB (well under the 54 GiB host budget);
every run is bounded by `timeout(1)` and both QEMUs are stopped on exit.

## How to run

Prerequisites (all present on the reference host):

- `/dev/kvm` readable/writable, nested virtualization enabled;
- `qemu-system-x86_64`, `qemu-img`, `ssh`, `curl`, `python3` (>= 3.9 with Linux
  pidfd support), `bun`, `tar`, `timeout`, `flock`;
- the smoke artifacts already fetched by
  `deploy/firecracker/smoke/fetch-artifacts.sh` (`~/.cache/rctf-fc-smoke`):
  firecracker v1.17.0, jailer, `images/smoke/{vmlinux,rootfs.ext4}`, static jq.
  This harness never downloads them.
- the Ubuntu 24.04 cloud image from the vmtest harness
  (`~/.cache/rctf-vmtest/noble-base.img`), reused read-only as the qcow2
  backing file. The image is the **pinned** dated release
  `noble/20261017` (`sha256 04e8f246…b6c94`); `vm.sh` re-hashes any cached
  copy on every boot, verifies `SHA256SUMS` (and `SHA256SUMS.gpg` when gpg is
  available) on a fresh download, and refuses to boot on a mismatch. If the
  image is absent it downloads that release to the run directory once.

```sh
./deploy/firecracker/multihost/run.sh

# leave both VMs running for debugging (the QEMUs are never left behind by a
# normal run: an EXIT/INT/TERM trap stops them):
KEEP_VM=1 ./deploy/firecracker/multihost/run.sh
```

A run creates a unique directory under `/tmp/opencode/fcmh-XXXXXX`
(`MH_RUN_BASE` overrides), binds dynamically allocated ssh/seed/controller
ports, and creates two unique unix-socket paths under `link/` (mode 0700) for
the private link, so parallel workers cannot collide. Before any VM starts,
`run.sh` runs `vm.sh selftest` (unprivileged decoy processes) to prove stale
pidfiles never signal unrelated processes. After provisioning it asserts the
link directly: the recorded QEMU command lines must be the two mirrored
unix-datagram netdevs (no multicast), the link directory must be 0700, each
agent must listen only on its MAC-pinned private address, the peer route and
neighbour MAC must be on that link, and the developer machine must have no
interface or listener on `10.77.0.10/11`. Logs, `results.json`,
`assertions.log`, the VM consoles, the recorded `qemu.cmdline` files and
`run.log` stay there. Exit code 0 means every driver assertion and all link
checks passed.

Typical runtime on the reference host: **8–20 minutes** (the final run took
7m14s: 137 driver assertions, 24 link checks, 35 pidfile-selftest checks), dominated
by the two cloud-init boots, `bun install` inside each VM and the injected
faults. The host checkout needs its workspace dependencies installed once
(`bun install --frozen-lockfile`), because `driver.ts` imports the real
provider from `apps/api`; `node_modules/` is gitignored and is not packed into
the VMs.

## What is real

- The **controller** is the production process
  (`src/controller/index.ts`) with the real HTTP API, real `bun:sqlite`
  database, scheduler, heartbeat monitor, reconciler and reaper. It runs
  inside host-a and is restarted (SIGKILL) mid-run.
- Both **agents** run as root under the shipped
  `deploy/firecracker/host/rctf-firecracker-agent.service` unit, in **jailer
  mode**, with the real `VmDriver`/`NetworkManager`, real nftables, real taps,
  real conntrack and real Firecracker microVMs under KVM-on-KVM. host-setup.sh
  is executed as shipped on each fresh VM.
- Controller→agent traffic uses **real per-host HTTP bearer tokens**
  (`FIRECRACKER_HOST_TOKEN_<ID>`); the two hosts have different tokens. The
  token-mismatch check proves a mismatch is rejected and surfaces as unhealthy.
- The private link is a real layer-2 segment between exactly two endpoints:
  one QEMU `dgram` netdev per VM over `AF_UNIX` sockets, with static addresses
  `10.77.0.10` / `10.77.0.11`. The controller's `/v1/hosts` entries and agent
  `listen` addresses use those addresses. It cannot reach the LAN (see the
  topology note above); the driver and `run.sh` assert that from the recorded
  QEMU command lines, the socket objects and both VMs' routing/neighbour
  tables.
- Every placement is verified on the **agents**, not only in SQLite: instance
  ids listed by host-a and host-b must match the controller's pinned `host_id`;
  extend/delete are observed changing only the pinned agent; the controller
  SQLite is read directly (read-only script `dbdump.ts`) for ownership, host
  health, `accepting` and clock skew.
- **Ambiguous creates** are exercised through a real TCP fault proxy running
  inside host-a (`faultproxy.ts`, wrapping the edge harness proxy): one create
  is held back (nothing reaches the agent) and must be fenced by the
  reconciler after `createFenceSeconds`; the captured request is then replayed
  to prove the agent tombstone rejects it. Another create's response is
  swallowed after the VM was launched and must be adopted.
- **Agent restarts** are real: `systemctl restart` and then `kill -9` of the
  shipped agent unit while a Firecracker guest is running. The restarted agent
  must re-adopt the same Firecracker pid and keep serving the guest.
- Guest flags are fetched over HTTP from the real guests (`/flag.txt`) and
  compared byte-for-byte, including cross-host wrong-port probes.

## What is simulated / not covered

| Area                       | Here                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Network under test         | A host-local QEMU unix-datagram point-to-point link, not a physical switch or LAN. ARP, TCP and DNAT over it are real; it cannot leave the developer machine.                                          |
| Public DNAT/Traefik        | Guests are reached through the hosts' public address/port over the private link. No Traefik/TLS: only a `tcp` expose entry is used. HTTP(S) routing and wildcard DNS are not covered.                  |
| Egress internet            | `egress:false` like the smoke test; no masquerade check.                                                                                                                                               |
| Clock skew                 | Real `date -s` inside host-b (ahead/behind 60 s), with NTP disabled in the VM.                                                                                                                         |
| Host loss                  | Hard `SIGKILL` of host-b's QEMU (the guest disk/overlay survives). Not a power cut or kernel panic.                                                                                                    |
| Network partition          | nftables `drop` on host-b's private NIC for the controller IP; the VM and agent keep running.                                                                                                          |
| Controller host            | Runs inside host-a (unprivileged process under `ubuntu`), so controller→host-b traffic truly crosses the private link.                                                                                 |
| Agent token mismatch       | The controller is restarted with a wrong `FIRECRACKER_HOST_TOKEN_HOST_B`; the agent itself stays correct.                                                                                              |
| `accepting` in `/v1/hosts` | The public `HostSummary` schema does **not** expose `accepting`; the driver asserts it from the controller's `hosts.accepting` column (the value the scheduler uses) and from each agent's `/v1/info`. |

## Checks (numbered assertions)

The driver prints one `PASS/FAIL [id] name -- detail` line per real invariant
and writes `results.json`. Groups:

| Group | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Both hosts register, heartbeat (`lastSeenMs` advances), report `accepting:true` (controller DB + agent info) and reject unauthenticated requests. Also asserts the private link from the recorded QEMU command lines and socket objects: two mirrored unix-datagram netdevs, no multicast, mode-0700 directory; each agent listens only on its MAC-pinned private address; the peer route/neighbour and the developer machine's absence of `10.77.0.10/11` prove the addresses are reachable only across that link.                                                                                                                   |
| 2     | Four creates land `host-a, host-b, host-a, host-b` under the scheduler's **most-free-memory** policy (equal budgets ⇒ vCPU-free then host-id tie-break; the claim is not "deliberate spread"); halving host-b's configured memory budget packs the first two creates onto host-a. Agent listings match pinned rows; a duplicate create launches nothing; extend and delete touch only the pinned agent; the deleted guest is definitively unreachable (connection refused/timeout, not a probe error) and the survivor keeps serving.                                                                                                 |
| 3     | Fill host-a to `maxInstances=2`, the next create lands on host-b; both full ⇒ clean `no_capacity`, no row, no VM leak; 20 concurrent creates reserve atomically (exactly 4 accepted) while `/v1/hosts` is sampled every 50 ms and reservations never exceed 2 per host at any sample; then capacity returns.                                                                                                                                                                                                                                                                                                                          |
| 4     | Drain host-a: new creates go to host-b, the existing instance keeps serving, undrain restores placement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5     | Host loss: `removeHost` refused while healthy (409); hard-kill host-b's QEMU ⇒ unhealthy after the heartbeat timeout; new creates only on host-a; the B instance is not rescheduled (exactly one row, errored while unreachable, still pinned to host-b, no agent record for that id on host-a); `removeHost` (204) writes it off as `lost`, frees the key, leaves the host draining; the team recreates on host-a; restarting the QEMU re-adopts/writes off exactly as documented, cleans the lost tombstone and leaves no duplicate.                                                                                                |
| 6     | Network partition: host-b unhealthy, creates on host-a only, host-b instances stay pinned and are not rescheduled (exactly one live row each; an absent short-instance row fails 6.8); the short-lived instance is destroyed by the agent's own dead-man deadline while the controller is cut off — measured from the agent state's `expiresAtMs` + `expiryGraceSeconds` (10 s), with a 1 s agent sweep and a tight post-deadline band, and with the Firecracker pid/state file required to be definitively gone (probe errors fail closed); unblock ⇒ healthy, the long instance still runs and serves; the short row is cleaned up. |
| 7     | Clock skew: host-b 60 s ahead and behind ⇒ `clock_skew_ms` flagged in controller state, host still healthy, placement refused with the documented `all hosts exceed the maximum clock skew` message (no row, no VM); after correcting the clock host-a stays drained, so the successful create must land on host-b and its guest must serve the flag; host-a is undrained only afterwards.                                                                                                                                                                                                                                            |
| 8     | Cross-host isolation with two instances of one team and two of another: every endpoint names its own host address and its pinned agent's port; each guest serves exactly its own flag; cross-host correct address/port works; the other host's port is definitively closed (refused/timeout, not a probe error); all four flags are distinct and never cross-delivered.                                                                                                                                                                                                                                                               |
| 9     | Controller SIGKILL restart while instances span both hosts: adoption keeps ids and pinned hosts, one VM per instance, stars still serve, no duplicate rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 10    | Wrong agent token for host-b ⇒ host unhealthy, `last_seen_ms` stops advancing (sampled twice while the wrong token is in use), creates go to host-a only, the rejection appears in the controller log; restoring the token makes it healthy again.                                                                                                                                                                                                                                                                                                                                                                                    |
| 11    | Ambiguous create: a TCP proxy inside host-a holds one create request (nothing reaches the agent) ⇒ one `creating` row pinned to host-b, then a fence DELETE after `createFenceSeconds`, a durable agent tombstone, row removed/key freed, and a replayed PUT rejected with 409 and no VM. A second create's response is swallowed after the agent launched the VM ⇒ the reconciler adopts the same id on host-b, it serves its flag, and no duplicate exists on host-a.                                                                                                                                                               |
| 12    | Agent restart with a live VM: `systemctl restart` then `kill -9` of the shipped unit; the agent re-adopts the **same Firecracker pid**, the guest keeps serving, the controller keeps exactly one row pinned to host-a, and a later create still spreads to host-b.                                                                                                                                                                                                                                                                                                                                                                   |
| L     | Leftovers: no rows (the SQLite dump must have succeeded), agent instances, Firecracker processes, taps, state records or per-lease nft rules (an nftables read failure is `-1`, not 0); cleanup had no swallowed errors; both agents still answered.                                                                                                                                                                                                                                                                                                                                                                                  |

## Files

| Path                | Purpose                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.sh`            | host driver: unique ports/dirs, pidfile selftest, boots + provisions both VMs, asserts the private link, opens the ssh forward, runs `driver.ts`, always stops the VMs. |
| `vm.sh`             | named QEMU VM helper (copy/extension of `vmtest/vm.sh`): per-VM overlay/seed/ssh port, the second unix-datagram link NIC, authenticated pidfiles + pidfd signalling, per-VM lifecycle `flock`, and `selftest`. |
| `pidguard.py` (shared) | `../vmtest/pidguard.py`: authenticate a v2 pidfile and TERM/KILL it through a pidfd; used by both `vm.sh` scripts.                                                              |
| `provision-host.sh` | runs as root in each VM: packages, bun, checkout, host-setup.sh, images, shipped agent unit + jailer config, controller config on host-a.                               |
| `hoststats.sh`      | read-only per-host observation (agent list, Firecracker/tap/state/nft counts) used by the driver; every failed enumeration reports -1 + `observationErrors`, which the driver rejects. |
| `faultproxy.ts`     | runs inside host-a: wraps `../e2e/proxy.ts` around host-b's agent for the ambiguous-create scenario (hold a request or swallow the response).                           |
| `dbdump.ts`         | read-only controller SQLite snapshot (instances + hosts incl. `accepting` and clock state).                                                                             |
| `driver.ts`         | real provider + scenarios/assertions + cleanup.                                                                                                                         |
| `RESULTS.md`        | dated log of what actually ran, with excerpts.                                                                                                                          |
| `repros/`           | minimal reproductions if a product bug is found (none committed unless found).                                                                                          |

## Safety

- Only `qemu-system-x86_64` runs unprivileged on the host. Both QEMU and the
  cloud-init seed server are stopped only through authenticated pidfiles that
  record the boot id, process start ticks, executable and run-specific argv.
  All TERM/KILL signals go through `pidguard.py`, which opens a pidfd first,
  validates the identity while holding it, re-reads the start ticks immediately
  before the signal, and signals only through that fd (a reused PID is never
  signalled). A stale or mismatched pidfile is removed with a warning and no
  process is signalled (never `pkill`/name). `vm.sh --name selftest selftest`
  proves this with unprivileged decoy processes (35 checks, including simulated
  PID-reuse races) and runs before every boot.
- Every run uses unique directories, ssh/seed/controller ports and two unique
  unix-socket paths in a 0700 directory for the private link. Link endpoints are
  removed only after the authenticated pidfile says the VM is gone, and only an
  AF_UNIX socket owned by this uid inside a validated 0700 directory is ever
  unlinked (a regular file given as `--link-local` is left untouched).
  `create`/`start`/`stop`/`destroy`/`kill` are serialised with a per-VM `flock`.
- The private link cannot leave the host: it is two `AF_UNIX` datagram sockets,
  not multicast/UDP/TCP, and there is no host bridge or tap. Ports cannot
  collide across parallel workers because there is no shared port at all.
- The fault proxy is an unprivileged `bun` process inside host-a listening on
  loopback; it only wraps host-b's agent URL in a per-scenario controller
  config.
- Hosts are never signalled with host-wide tools: host loss is an authenticated
  SIGKILL of the one QEMU recorded for host-b, sent through the pidfd by
  `vm.sh kill` (`pidguard.py`); the driver never reads a PID and calls
  `process.kill` itself.
- No secrets are printed. The per-run tokens are generated into a 0600 file,
  copied into the VMs, and only used in HTTP headers (the driver logs source
  shas, guest IPs and status codes, never flags or tokens).
