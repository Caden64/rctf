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
                                             │ private L2:
                                             │ QEMU -netdev socket,mcast=…
                    ┌────────────────────────▼───────────────────────┐
                    │ host-b VM  (root, nested KVM)                   │
                    │   agent host-b under the shipped systemd unit, │
                    │     JAILER mode, real Firecracker guests        │
                    │   eth1 10.77.0.11                               │
                    └─────────────────────────────────────────────────┘
```

Nothing privileged runs on the developer machine: `vm.sh` only starts
`qemu-system-x86_64` as the current user and forwards one ssh port per VM. All
root operations (systemd, jailer, nftables, taps, cgroups, conntrack) happen
inside the VMs. Memory: two VMs × 3584 MiB (well under the 54 GiB host budget);
every run is bounded by `timeout(1)` and both QEMUs are stopped on exit.

## How to run

Prerequisites (all present on the reference host):

- `/dev/kvm` readable/writable, nested virtualization enabled;
- `qemu-system-x86_64`, `qemu-img`, `ssh`, `curl`, `python3`, `bun`, `tar`,
  `timeout`, `flock`;
- the smoke artifacts already fetched by
  `deploy/firecracker/smoke/fetch-artifacts.sh` (`~/.cache/rctf-fc-smoke`):
  firecracker v1.17.0, jailer, `images/smoke/{vmlinux,rootfs.ext4}`, static jq.
  This harness never downloads them.
- the Ubuntu 24.04 cloud image from the vmtest harness
  (`~/.cache/rctf-vmtest/noble-base.img`), reused read-only as the qcow2
  backing file; if absent, `vm.sh` downloads it to the run directory once.

```sh
./deploy/firecracker/multihost/run.sh

# leave both VMs running for debugging (the QEMUs are never left behind by a
# normal run: an EXIT/INT/TERM trap stops them):
KEEP_VM=1 ./deploy/firecracker/multihost/run.sh
```

A run creates a unique directory under `/tmp/opencode/fcmh-XXXXXX`
(`MH_RUN_BASE` overrides), binds dynamically allocated ssh/seed/controller
ports, and uses a random multicast group/port for the private L2, so parallel
workers cannot collide. Logs, `results.json`, `assertions.log`, the VM
consoles and `run.log` stay there. Exit code 0 means every assertion passed.

Typical runtime on the reference host: **10–20 minutes**, dominated by the two
cloud-init boots and `bun install` inside each VM.

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
- The private L2 is a real layer-2 segment: two QEMU socket netdevs in
  multicast mode create a point-to-point link, with static addresses
  `10.77.0.10` / `10.77.0.11`. The controller's `/v1/hosts` entries and agent
  `listen` addresses use those addresses.
- Every placement is verified on the **agents**, not only in SQLite: instance
  ids listed by host-a and host-b must match the controller's pinned `host_id`;
  extend/delete are observed changing only the pinned agent; the controller
  SQLite is read directly (read-only script `dbdump.ts`) for ownership, host
  health, `accepting` and clock skew.
- Guest flags are fetched over HTTP from the real guests (`/flag.txt`) and
  compared byte-for-byte, including cross-host wrong-port probes.

## What is simulated / not covered

| Area | Here |
| ---- | ---- |
| Network under test | A QEMU socket/multicast L2, not a physical switch. ARP, TCP and DNAT over it are real. |
| Public DNAT/Traefik | Guests are reached through the hosts' public address/port over the private L2. No Traefik/TLS: only a `tcp` expose entry is used. HTTP(S) routing and wildcard DNS are not covered. |
| Egress internet | `egress:false` like the smoke test; no masquerade check. |
| Clock skew | Real `date -s` inside host-b (ahead/behind 60 s), with NTP disabled in the VM. |
| Host loss | Hard `SIGKILL` of host-b's QEMU (the guest disk/overlay survives). Not a power cut or kernel panic. |
| Network partition | nftables `drop` on host-b's private NIC for the controller IP; the VM and agent keep running. |
| Controller host | Runs inside host-a (unprivileged process under `ubuntu`), so controller→host-b traffic truly crosses the private L2. |
| Agent token mismatch | The controller is restarted with a wrong `FIRECRACKER_HOST_TOKEN_HOST_B`; the agent itself stays correct. |
| `accepting` in `/v1/hosts` | The public `HostSummary` schema does **not** expose `accepting`; the driver asserts it from the controller's `hosts.accepting` column (the value the scheduler uses) and from each agent's `/v1/info`. |

## Checks (numbered assertions)

The driver prints one `PASS/FAIL [id] name -- detail` line per real invariant
and writes `results.json`. Groups:

| Group | Meaning |
| ----- | ------- |
| 1 | Both hosts register, heartbeat (`lastSeenMs` advances), report `accepting:true` (controller DB + agent info) and reject unauthenticated requests. |
| 2 | Four creates spread `host-a, host-b, host-a, host-b` (most-free-memory first, ties by host id); agent listings match pinned rows; a duplicate create launches nothing; extend and delete touch only the pinned agent; the deleted guest stops answering and the survivor keeps serving. |
| 3 | Fill host-a to `maxInstances=2`, the next create lands on host-b; both full ⇒ clean `no_capacity`, no row, no VM leak; 20 concurrent creates reserve atomically (exactly 4 accepted, never >2 per host), then capacity returns. |
| 4 | Drain host-a: new creates go to host-b, the existing instance keeps serving, undrain restores placement. |
| 5 | Host loss: `removeHost` refused while healthy (409); hard-kill host-b's QEMU ⇒ unhealthy after the heartbeat timeout; new creates only on host-a; the B instance is not rescheduled (errored while unreachable, row pinned); `removeHost` (204) writes it off as `lost`, frees the key, leaves the host draining; the team recreates on host-a; restarting the QEMU re-adopts/writes off exactly as documented, cleans the lost tombstone and leaves no duplicate. |
| 6 | Network partition: host-b unhealthy, creates on host-a only, host-b instances stay pinned and are not rescheduled; the short-lived instance is destroyed by the agent's own dead-man deadline while the controller is cut off; unblock ⇒ healthy, the long instance still runs and serves; the short row is cleaned up. |
| 7 | Clock skew: host-b 60 s ahead and behind ⇒ `clock_skew_ms` flagged in controller state, host still healthy, placement refused with the documented `all hosts exceed the maximum clock skew` message (no row, no VM); correcting the clock restores placement. |
| 8 | Cross-host isolation with two instances of one team and two of another: every endpoint names its own host address and its pinned agent's port; each guest serves exactly its own flag; cross-host correct address/port works; the other host's port does not; all four flags are distinct and never cross-delivered. |
| 9 | Controller SIGKILL restart while instances span both hosts: adoption keeps ids and pinned hosts, one VM per instance, stars still serve, no duplicate rows. |
| 10 | Wrong agent token for host-b ⇒ host unhealthy, no successful heartbeat, creates go to host-a only, the rejection appears in the controller log; restoring the token makes it healthy again. |
| L | Leftovers: no rows, agent instances, Firecracker processes, taps, state records or per-lease nft rules; cleanup had no swallowed errors; both agents still answered. |

## Files

| Path | Purpose |
| ---- | ------- |
| `run.sh` | host driver: unique ports/dirs, boots + provisions both VMs in parallel, verifies the L2, opens the ssh forward, runs `driver.ts`, always stops the VMs. |
| `vm.sh` | named QEMU VM helper (copy/extension of `vmtest/vm.sh`): per-VM overlay/seed/ssh port and the second socket/multicast NIC. |
| `provision-host.sh` | runs as root in each VM: packages, bun, checkout, host-setup.sh, images, shipped agent unit + jailer config, controller config on host-a. |
| `hoststats.sh` | read-only per-host observation (agent list, Firecracker/tap/state/nft counts) used by the driver. |
| `dbdump.ts` | read-only controller SQLite snapshot (instances + hosts incl. `accepting` and clock state). |
| `driver.ts` | real provider + scenarios/assertions + cleanup. |
| `RESULTS.md` | dated log of what actually ran, with excerpts. |
| `repros/` | minimal reproductions if a product bug is found (none committed unless found). |

## Safety

- Only `qemu-system-x86_64` runs privileged-free on the host; VMs are stopped by
  PID from their pidfiles, never by `pkill`/name.
- Every run uses unique directories, ssh/seed/controller ports and a unique
  multicast group/port.
- Hosts are never signalled with host-wide tools: host loss is a `kill -9` of
  the one QEMU pid recorded for host-b.
- No secrets are printed. The per-run tokens are generated into a 0600 file,
  copied into the VMs, and only used in HTTP headers (the driver logs source
  shas, guest IPs and status codes, never flags or tokens).
