# Firecracker instancer — real network-edge verification

This directory verifies the **network edge** of the Firecracker instancer against real
programs, without root and without touching the machine's network:

- **real Traefik 3.7.15** (the release-tarball and extracted-binary sha256 are pinned in
  `fetch-traefik.sh` and the cached binary is re-hashed on every run) loading the agent's
  file-provider routes and proxying to real backends;
- **real nftables** `inet rctf_fc` / `arp rctf_fc_arp` rules rendered by the repository's own
  `renderRuleset` and applied with `nft -f -`;
- **real conntrack** (`conntrack -L` / the repository's `flushConntrack`);
- **real DNAT/NAT** between an `outside` network namespace and an `upstream` network namespace;
- **real Firecracker v1.17.0 guests** managed by the real host agent (phase `agent`);
- **real nmap** from outside and from another guest's network namespace.

Everything runs inside `unshare -Urn` (a private user + network namespace). Inside it we are
"root" with `CAP_NET_ADMIN` over our own netns, so taps, bridges, veth pairs, nftables NAT and
conntrack are real, but nothing is visible to the host or the user's network. No `sudo` is
needed (or available).

## Run

```sh
./fetch-traefik.sh     # verify the cached binary against the repo-pinned sha256, or download + verify
./run.sh               # all phases + mutation selftest; exit 0 iff every CHECK and SELFTEST passes
KEEP_RUN=1 ./run.sh    # keep the run dir and logs
```

`fetch-traefik.sh` embeds the pinned sha256 of both the release tarball and the extracted
binary. The tarball pin was taken from the official `traefik_v3.7.15_checksums.txt` and
cross-checked against the GitHub API release-asset digest; the published checksums file is
still downloaded as a second source and a disagreement is fatal. `run.sh` calls
`fetch-traefik.sh --verify` before every run, so a modified or corrupted cached binary stops
the harness instead of being used.

Prerequisites: `bun` on `PATH`, `/dev/kvm` readable/writable, unprivileged user namespaces,
`nft`, `conntrack`, `nmap`, `python3`, `curl`, `ip`, and the artifacts from
`deploy/firecracker/smoke/fetch-artifacts.sh` (`SMOKE_ARTIFACTS`, default
`~/.cache/rctf-fc-smoke`). The guest rootfs is built per run with the repository's
`deploy/firecracker/guest/build-rootfs.sh` (`mkfs.ext4 -d`, no root); the cached artifacts are
only read.

Run directory: `$XDG_RUNTIME_DIR/fce<epoch><pid>` (short, because Firecracker/Traefik unix
socket paths must stay below 108 bytes). The whole run is bounded by `EDGE_TIMEOUT` (default
900 s) at the outer level and by per-phase timeouts. Cleanup kills only PIDs the scripts
started and destroys each phase's network namespace; the run dir is removed unless a check
failed or `KEEP_RUN=1`.

## Topology

Each phase runs in its **own nested network namespace** (`unshare -n` from inside the outer
user namespace), so phases cannot leak nft rules, taps, addresses or conntrack state into each
other.

```
 phase host netns (the "KVM host")
   br-ext 203.0.113.1/24 + 203.0.114.1/24        <- network.externalInterface
     ├── veth ── outside netns 203.0.113.2/24   "player on the internet"
     └── veth ── upstream netns 203.0.114.3/24  "upstream server" (HTTP :8080, hold :240xx)
   fctapN 10.200.x.1/30 ── guest A/B (real Firecracker VM on a real tun/tap, or a veth peer
                                     in a netns for the frame-injection phase)
   Traefik :8088  (file provider watches the agent's traefikDynamicDir)
```

The upstream server is on a **different L3 prefix** (`203.0.114.0/24`) reached through the
host, not on the same bridge L2 segment. That is deliberate: traffic between two ports of one
bridge is switched by the bridge and never reaches the IP forward hook, so it would create no
conntrack state; routing it through the host exercises the real forward/conntrack path, like a
real upstream on the internet.

## Phases and checks

### `phase-agent` — real Firecracker + real agent + real Traefik (checks 1–5, 7.1/7.2)

Two real microVMs (`team-a` with `egress:false`, `team-b` with `egress:true`) are created
through the real agent HTTP API. The agent allocates a `/30`, a real tap and public ports,
publishes DNAT and writes Traefik YAML from the real `TraefikFileManager`. The outside netns
acts as the player; the upstream netns is the egress destination.

- **1.x** Traefik routes `web-a-<id>.edge.test` and `web-b-<id>.edge.test` to the right VM at
  the same time; unknown and wrong Host headers get **404**, not another team's guest.
- **2.1/2.2** `DELETE` through the agent removes the per-instance YAML and the route starts
  returning 404 (bounded polling) while the other team keeps serving 200.
- **2.3/2.4** a malformed YAML file and a valid-but-partial router (missing service) in the
  watched directory do not break the live routes.
- **3.x** from the outside netns: host public ports DNAT to exactly their own guest (verified
  per port in nft and by the guest's `/id.txt`); an unpublished port is closed only after the
  published port is proven to connect from the same netns (**3.5**); the guest address cannot
  be reached directly, bypassing DNAT (**3.6**), and a temporary accept rule proves the same
  probe reaches the guest when allowed (**3.7**).
- **4.x** measured **inside the real guests**: `egress:false` cannot reach upstream,
  `egress:true` can; `egress:true` still cannot reach the host side of its own tap or the
  other guest. While both guests are alive the rules are flushed and the same probe must
  reach the host tap side (**4.5**) and at least one guest must report cross-guest
  `scan=REACHED` (**4.6**), then the exact ruleset is restored. A guest that reports
  `scan=error` (nc missing or an unexpected exit) is never accepted as `blocked`, and an
  empty/unparseable `probe.txt` fails closed.
- **5.x** a long-lived connection through DNAT (guest `:9000`) plus an unrelated connection
  **to the same destination port on a different address** are tracked by `conntrack -L`.
  `DELETE` releases the instance. The guest flow must still be tracked after the fenced
  ruleset and tap removal and immediately **before** the real flush, the flush must exit 0
  (no `|| true`), and only then is absence asserted (**5.6a/5.7**); the held socket stays
  open through the flush. The held connection is reset, every conntrack entry for the guest
  IP disappears, the unrelated flow survives (the flush is address-scoped, not port-only),
  the released `/30` and ports appear in the durable quarantine file with future deadlines,
  and a new instance gets a different `/30` and ports. **5.7** only proves the old released
  tuple is gone; the real same-`/30`/same-port reuse path is phase `veth` 5.9–5.12, because
  the 120 s quarantine deliberately prevents reuse here.
- **7.1** `nmap -sT -p-` from outside against the host address sees **only** the published
  ports; nmap must exit 0 and its XML `scaninfo` must report `numservices="65535"
  services="1-65535"`, so a timed-out partial scan cannot pass. **7.2** a busybox `nc`
  connect from inside real guest A to guest B's address is blocked; the 4.6 control shows the
  same probe reports `scan=REACHED` when the rules are flushed, so a dead probe cannot pass.

### `phase-veth` — frame injection with the real ruleset (checks 5.6–5.12, 6.x, 7.2/7.3)

The same `renderRuleset` output (imported from `src/agent/net/nftables.ts`) is applied with
real `nft`; "guests" are veth peers in network namespaces with the lease MAC/address. This is
what makes raw frame injection possible without modifying a Firecracker rootfs. Every packet
still crosses the real kernel forwarding hooks with the real rules. Checks:

- **6.1/6.2** a UDP packet from guest A with guest B's source IP is dropped; after flushing
  the inet table the identical packet is observed at the upstream (control).
- **6.3/6.4** an Ethernet frame from guest A with guest B's source MAC is dropped; the flushed
  control is forwarded.
- **6.5/6.6** an ARP reply with guest B's MAC (existing neighbour made `stale`) does not
  overwrite the host's neighbour entry; with the ARP table flushed it does (control).
- **6.7** a legitimate ARP request is still learned with the rules installed (positive
  control).
- **6.8/6.9** an ARP request whose sender claims guest B's address is dropped (no host ARP
  reply into guest A); with the ARP table flushed the host answers (control). For the control
  only, `10.200.0.0/24` is temporarily added to `fctap0`, because Linux ignores ARP senders
  that are off-link for the receiving interface *before* any nftables rule runs; the secondary
  prefix makes the sender on-link so an unfiltered kernel demonstrably answers.
  Every `spoof.py` injection and `sniff.py` capture in 6.x must exit 0; a failed probe fails
  the check instead of looking like a drop.
- **7.2/7.3** `nmap` from guest A finds no open ports on guest B; after flushing the inet
  table the same scan finds guest B's `:8080` (control).
- **5.6–5.12** the dangerous reuse path: long-lived DNAT flow + unrelated flow on the same
  destination port, then the real release steps (fenced ruleset, interface removal, real
  `flushConntrack`), then a **new lease reusing the exact same `/30`, MAC-independent guest
  address, public port and client source port**. The guest flow must still be tracked after
  the fence and tap removal and immediately before the flush (**5.6a**); the flush must exit
  0; only then is the old tuple asserted gone (**5.7**). The unrelated flow survives, and the
  new guest is reached. Quarantine is 0 in this phase *on purpose* so the path that quarantine
  protects can be executed; the real 120 s quarantine is covered by phase `agent` and
  `lifecycle`.

### `phase-lifecycle` — real NetworkManager at scale (check 8)

Ten leases are allocated **concurrently** through the real `createNetworkManager`, published,
then released. The outside netns fires one SYN at each public port so real DNAT conntrack
entries exist before release.

- **8.1** ten distinct `/30`s, host addresses and taps.
- **8.2** ten real `tun type tap` devices, each with the `rctf-fc:rctf-fc` ownership alias.
- **8.3** one DNAT rule and one anti-spoof/ARP rule per lease.
- **8.4** the `http` expose wrote a per-instance Traefik file with the expected `Host()` rule.
- **8.5** ten real DNAT conntrack entries before release.
- **8.6** after release: no taps, no DNAT/masquerade/fctap rules, no Traefik files.
- **8.7** no conntrack entry for any released guest address.
- **8.8** ten `/30` indexes and ten ports in the durable quarantine with future deadlines.
- **8.9** a restart-like `restore([])` followed by allocation does **not** hand back any
  quarantined index or port.

Every `nft`, `conntrack` and `ip` listing in this phase must exit 0; after teardown the only
accepted non-zero is a genuinely missing table (named in the check text as
`absent (expected after teardown)`). A failed listing can therefore never be read as a clean
host.

### `selftest` — mutation proofs for the hardened assertions

`inner.sh` runs `selftest.sh` in its own network namespace before the phases. It deliberately
breaks each condition and requires the **same** helper the phases use to FAIL (and the
correct case to PASS):

- **1** a `flushConntrack` of the *wrong* address exits 0 but leaves the tuple, so
  "present immediately before the flush, absent after" cannot pass falsely; flushing the
  right address removes it.
- **2** the guest probe maps `nc` success to `REACHED`, a refusal to `blocked`, and
  `nc` exit 127 / missing `nc` to `error`; `probe_scan_blocked` rejects empty,
  unparseable and `scan=error` lines.
- **3** `assert_port_closed` passes only when the published port connects from the same
  netns; a dead published probe makes it fail instead of reporting the unpublished port
  closed.

The selftest emits `SELFTEST <id> PASS/FAIL` lines (counted separately from `CHECK`) and makes
`run.sh` exit non-zero on any failure.

## What is real vs simulated

| Piece | phase `agent` | phase `veth` | phase `lifecycle` |
| --- | --- | --- | --- |
| Firecracker + KVM guest | **real** | simulated by netns/veth | none (no VM needed) |
| Agent HTTP API + manager | **real** | not used (rules rendered directly) | **real** |
| nftables renderer + `nft` | **real** | **real** | **real** |
| Traefik + file provider | **real** binary | not used | files only |
| DNAT / masquerade / forwarding | **real** | **real** | **real** |
| conntrack (`-L`, `-D`) | **real** | **real** | **real** |
| nmap | outside + real-guest `nc` | outside? no: guest→guest nmap | outside (SYN to DNAT ports) |
| ARP/IP/MAC spoof frames | guest-level probe only | **raw frames** from a guest | none |

The only deliberate substitutions are (a) `veth` instead of `tap`/Firecracker in
`phase-veth` (needed to inject arbitrary frames; the host-side rules are identical and the
unprivileged smoke test covers real tap + Firecracker), and (b) `nmap` running from a netns
"guest" rather than inside a Firecracker VM, because the minimal busybox rootfs has no nmap.
The real guest performs the same scan with busybox `nc` (7.2).

## Limitations / not covered

- **TLS / HTTPS / tcp-ssl**: Traefik terminates TLS in production; here only the plain HTTP
  entrypoint is exercised (no certificates). The generated `HostSNI()` / TLS router YAML is
  covered by unit tests, not by this harness.
- **Jailer mode**: needs real root; all phases use the same unprivileged constraints as the
  smoke test (agent `mode: direct`).
- **systemd hardening, multi-host scheduling, controller/API provider**: out of scope.
- **`ip netns add`** does not work in an unprivileged user namespace here (mounting
  `/var/run/netns` is denied), so child namespaces are held open with `unshare -n sleep` and
  joined with `nsenter -t PID -n` / `ip link set ... netns PID`.
- **ARP off-link sender behaviour**: without nftables, Linux itself ignores ARP senders that
  are not on-link for the receiving interface. The ARP control therefore temporarily widens
  the interface prefix (documented above) so the check proves the *rule*, not the kernel
  default.
- The `phase-agent` egress/scan probe uses the guest's own `/probe.txt` loop, so results are
  sampled (bounded polling); it is not a per-packet assertion. The guest distinguishes
  `blocked` from `error` (missing/unusable `nc`), empty or unparseable `probe.txt` fails
  closed, and **4.6** proves the same probe reports `scan=REACHED` when the rules are
  flushed, so a `blocked` result is not a dead probe.
- Timings are wall-clock bounded (image build, VM boot, Traefik watch, probe loops); on a very
  loaded machine increase `EDGE_TIMEOUT` and the per-phase limits in `inner.sh`.

## Files

```
run.sh                     outer launcher: checks, short RUN dir, `unshare -Urn`
fetch-traefik.sh           repo-pinned tarball+binary sha256; re-hashes the cache every run
inner.sh                   builds the guest image, runs the mutation selftest + three phases
selftest.sh                mutation proofs for the conntrack/probe/closed-port assertions
lib/phase-agent.sh         checks 1-5, 7.1/7.2 with real Firecracker + agent + Traefik
lib/phase-veth.sh          checks 5.6-5.12, 6.x, 7.2/7.3 with raw frames
lib/phase-lifecycle.sh     check 8: real NetworkManager, 10 concurrent leases
lib/assert.sh              shared fail-closed conntrack/probe/port assertions
lib/lifecycle.ts           the NetworkManager assertions (imports the real modules)
lib/net-tools.ts           render the real ruleset / run the real conntrack flush
lib/guest-start            guest service: identity HTTP, hold listener, probe loop
                           (`scan=blocked` vs `scan=error`, EDGE_PROBE_ONCE for selftest)
lib/upstream.py            upstream HTTP + hold servers
lib/hold_client.py         long-lived TCP flow with a fixed source port
lib/connect_once.py        single SYN (creates a DNAT conntrack entry)
lib/sniff.py               scapy-free AF_PACKET sniffer (UDP/ARP/Ethernet)
lib/spoof.py               scapy-free raw IP/MAC/ARP injection
RESULTS.md                 dated log of the actual runs with excerpts
```

`repros/` is only used if a product bug is found; it is empty when all checks pass.
