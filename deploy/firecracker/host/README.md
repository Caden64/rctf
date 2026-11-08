# Firecracker host setup (network + routing)

Everything needed on a KVM host for the rCTF Firecracker instancer's
**guest networking and public routing** (track 3):

| File                                | Purpose                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `host-setup.sh`                     | Idempotent preflight + sysctl + directory creation. No deletes.      |
| `sysctl.d/90-rctf-firecracker.conf` | `net.ipv4.ip_forward=1` (and defence-in-depth `rp_filter`).          |
| `traefik.yml`                       | Sample Traefik **static** config (file provider watches the routes). |
| `rctf-firecracker-agent.service`    | Hardened systemd unit (root only where netfilter/jailer require it). |
| `README.md`                         | This file.                                                           |

## Supported networking model

- **IPv4 only.** No IPv6 addresses are configured on taps (IPv6 from a tap is
  dropped).
- Requires a Linux kernel with `inet`-family NAT support (5.2+ recommended),
  nftables (v1.0+ recommended) and **conntrack-tools** (`conntrack`). The agent
  owns the `inet rctf_fc` and `arp rctf_fc_arp` tables, so `nft -f -` must work
  on the host.
- **One tap per VM, one dedicated /30 per VM** carved from `network.subnetPool`.
  Index `i` gets network `base + 4*i`, host `.1`, guest `.2`; the tap is
  `fctap<i>`. There is **no bridge**, so VMs share no L2 segment.
- The guest boot contract uses
  `ip=<guestIp>::<hostIp>:255.255.255.252::eth0:off`; the guest's only route is
  the host side of its own /30.
- The host must have `net.ipv4.ip_forward=1` (set by `host-setup.sh`).
- The agent owns the nftables tables **`inet rctf_fc`** and **`arp rctf_fc_arp`**
  completely and rewrites them atomically from its live leases. Do not add rules
  to them by hand.
  - The forward chain has `policy accept`: the agent must not take over
    unrelated host forwarding (Docker, VPN, ...). Only traffic entering or
    leaving an `fctap*` interface is filtered, and it ends in an explicit
    `fctap*` drop. _Other tables' drop rules still apply_ (nftables evaluates
    every base chain of the same hook, so an operator's own forward-drop policy
    keeps dropping guest traffic as well).
  - Forwarding between any two `fctap*` interfaces is dropped (team isolation).
  - Anti-spoof: each tap may only emit its lease IPv4 address and MAC, in both
    the `inet` and the `arp` family.
  - Input from taps is dropped except established replies scoped to that
    lease's own interface/address pair (Traefik proxying, readiness probes).
    There is no blanket `ct state established,related accept`, so conntrack
    state inherited from a previous tenant is never accepted. MMDS is handled
    inside Firecracker, not on the host stack.
  - Egress is denied by default. With `egress: true` the guest is masqueraded
    out of `network.externalInterface`, and destinations in loopback, RFC1918,
    CGNAT, link-local, multicast, reserved space and the VM subnet pool are
    still dropped. **The egress flag is immutable for the life of a lease**:
    it is chosen at allocation, persisted in the lease, and restore never
    flips it. If a restored lease's flag disagrees with the currently
    installed rules (`restore` reads the `inet rctf_fc` table), the lease is
    fenced and its conntrack entries are flushed before the new policy is
    rendered, so established flows cannot survive an egress change.
  - Unknown `fctap*` interfaces (up but without a lease) get no per-lease
    rules; the ARP table ends with an explicit drop for every `fctap*` that is
    not in the leased tap set (with zero leases it drops all `fctap*` ARP).
  - DNAT only matches packets addressed to a **local** address
    (`fib daddr type local`) on `externalInterface`; transit traffic through the
    host is never rewritten.
- **tcp/raw** exposes get one public port each from `network.tcpPortRange`
  (`DNAT <externalInterface>:<port> → <guestIp>:<guestPort>`), allocated and
  released with the lease.
- **http/https/tcp-ssl** exposes are routed by Traefik:
  - hostname `<hostPrefix>-<first 20 chars of instanceId>.<httpDomain>`
    (`hostPrefix` is at most 32 characters, so the label stays ≤ 63 bytes);
  - `http` → HTTP router on `network.httpEntrypoint`;
  - `https` → TLS-terminating router on `network.httpsEntrypoint`;
  - `tcp-ssl` → TCP router with `HostSNI(...)` + TLS termination on
    `network.tcpSslEntrypoint`;
  - the backend address is always `http://<guestIp>:<guestPort>` (HTTPS is
    terminated at Traefik; the guest serves plain HTTP) or
    `<guestIp>:<guestPort>` for `tcp-ssl`.
  - The service port reported to players comes from `network.httpPort`,
    `network.httpsPort` and `network.tcpSslPort`; keep those in sync with the
    entrypoint listeners in `traefik.yml`.
  - Routes are rebuilt from the persisted lease (`expose` + public
    ports/hostnames). There is no separate route sidecar store: an existing
    Traefik file is always rewritten from the lease on restore.
- **raw is TCP.** UDP is not supported by this track.

### Conntrack, reuse quarantine

Netfilter conntrack entries (including NAT mappings) outlive a lease. On
`unpublish` and on release, the agent deletes every entry for the lease's guest
IP in all four directions (`--orig-src`, `--orig-dst`, `--reply-src`,
`--reply-dst`). It deliberately does **not** delete by destination port alone:
`--orig-port-dst <port>` has no address component and would also remove other
tenants' egress or host connections to that port. Published DNAT flows always
have `reply-src == guestIp`, so the address selectors cover them. "0 flow
entries have been deleted" is treated as success; any other failure aborts the
release so the lease stays reserved and the release can be retried.

Release is ordered so no pass-through window exists:

1. install a **fenced** ruleset (only blocking rules for the retiring lease:
   no DNAT, no forward/input accepts, explicit unconditional drops for its tap
   and guest address in both directions, including established/related);
2. remove its Traefik routes;
3. delete its tap (stops guest packets);
4. flush conntrack in all four directions;
5. only after all of the above succeed, free the /30, ports and hostnames into
   the quarantine below. `unpublish` uses the same fence step before removing
   routes and flushing, then re-renders the live tap's security rules.

Any failure keeps the lease reserved and fenced, and `release`/`unpublish` are
retryable/idempotent; a restore that finds a half-released lease keeps it
fenced and never re-creates its tap or public routes.

Freed /30 indexes and public ports are additionally **quarantined** for
`network.reuseQuarantineSeconds` (default 120) before they can be handed out
again; allocation prefers never-used entries and then the oldest release.
Restore-time stray resources (a removed abandoned tap) start their quarantine
at restore time. Deadlines are persisted in `network.quarantineFile` (default
`/var/lib/rctf-firecracker/net-quarantine.json`), an atomic (tmp + fsync +
rename, mode 0600) JSON file containing only resource ids and expiry epoch ms —
no addresses, hostnames, flags or other secrets. It is written on release and
orphan cleanup and loaded at startup, so a restart (including `restore([])`)
cannot make a just-released /30 or port immediately reusable. A corrupt or
unreadable file fails closed: every unowned index/port stays quarantined for
one full period and an error is logged. If the file cannot be written, the
release fails (the lease stays reserved and fenced) and is retried; it is never
acknowledged without a durable quarantine. The agent's `/v1/info` preflight
reports `quarantineWritable` (it writes and removes a probe file next to the
quarantine file), so a misconfigured path takes the host out of rotation up
front instead of wedging every teardown later.

Allocation refuses to proceed when `conntrack` is unavailable, unless
`network.requireConntrack` is explicitly set to `false` (dev only).

### Tap ownership (durable alias)

Every tap the agent creates is marked immediately after creation with an
interface alias: `ip link set dev fctapN alias rctf-fc:<network.ownerMarker>`
(default marker `rctf-fc`, so `rctf-fc:rctf-fc`). An interface is considered
ours only when **both** hold:

- `ip -d -o link show dev fctapN` reports `tun type tap`, and
- its alias equals this host's `rctf-fc:<ownerMarker>`.

Restore, `ensure`, release and allocation rollback never adopt, modify or
delete an interface that does not have both. A foreign interface named
`fctapN` (for example an operator's dummy `fctap9`) is reported and left
untouched, and its index is skipped just like the existing name-conflict path.
A restored live lease whose interface exists without the marker is reported
and fails that lease loudly (it is not silently adopted or modified). Keep
`ownerMarker` stable across restarts: changing it makes previously created
taps look foreign. Taps created by an agent without the ownership alias are
never adopted; drain a host and delete its instances before upgrading across
that boundary.

### DNS and certificates

- Create an **IPv4 wildcard A record** `*.<httpDomain> → <this host's public IP>`
  (e.g. `*.fc1.ctf.example.com`). Every VM host must use its **own**
  `httpDomain` if you run more than one, so `*.<domain>` pins routing to one
  host without a shared front door.
- Provide a **wildcard certificate** `*.<httpDomain>` to Traefik, either as the
  default certificate in a dynamic TLS file or through a `certResolver`
  (`network.certResolver` is copied into every https/tcp-ssl router).
- Hostnames contain a random instance id, never a team id. Two instances whose
  ids share the first 20 characters and the same `hostPrefix` would collide:
  allocation detects that (including hostnames already present in another
  Traefik file) and fails/rolls back.

### Firewall the agent port

The agent is privileged (netfilter, taps, jailer). Expose its listen port
(default `127.0.0.1:7001`; set `listen.host` to the private address) **only to
the controller**, e.g. via the cloud provider's security group / host firewall.
Do not expose it to the internet or to challenge players. The agent API uses a
per-host bearer token (`FIRECRACKER_AGENT_TOKEN`).

## Paths and the jailer

The VM defaults (`apps/firecracker-instancer/src/agent/vm/config.ts`) are:

| Setting      | Default                         |
| ------------ | ------------------------------- |
| `mode`       | `jailer`                        |
| `jailUid`    | `10000`                         |
| `jailGid`    | `10000`                         |
| `runDir`     | `/var/lib/rctf-firecracker/run` |
| `chrootBase` | `/srv/jailer`                   |
| `cgroupRoot` | `/sys/fs/cgroup`                |

`host-setup.sh` creates `/var/lib/rctf-firecracker/{state,run,images}`,
`/srv/jailer` and `/etc/traefik/dynamic/rctf-firecracker`.
`rctf-firecracker-agent.service` uses `ProtectSystem=strict`, so the jailer's
chroot base **must** be in `ReadWritePaths` (it is: `/srv/jailer` is listed).
If you change `vm.chrootBase` or `vm.runDir`, update the unit accordingly. The
unit also keeps kernel tunables writable because the jailer creates cgroups
under `/sys/fs/cgroup`.

On systemd 255 (Ubuntu 24.04), `NoNewPrivileges=yes` combined with a seccomp
filter (`RestrictAddressFamilies=` installs one) makes systemd start a root
service with `CapPrm=CapEff=0x82c316b` while `CapBnd=0x82c31eb`: the two sets
differ by exactly `0x80` = `CAP_SETUID`, which is therefore missing from
`CapPrm`/`CapEff` (`CAP_SETGID`, `0x40`, stays effective). The jailer's
`setuid(10000)` then fails with
`Failed to exec into Firecracker: Operation not permitted (os error 1)`.
The unit therefore also sets `AmbientCapabilities=CAP_SETUID`, which restores
exactly the one measured-missing bit (`CapAmb=0x80`,
`CapEff=CapBnd=0x82c31eb`) and keeps the socket filter; `CAP_SETGID` stays in
`CapabilityBoundingSet`. Verified on systemd `255.4-1ubuntu8.18` (Ubuntu 24.04,
kernel 6.8) with Firecracker/jailer v1.17.0 on 2026-11-08; see `../vmtest/`.

## Install

```sh
sudo ./host-setup.sh
```

The script checks root, Linux, `ip`, `nft`, `conntrack`, `/dev/kvm`, and
verifies the Firecracker and jailer binaries and versions (default minimum
`1.7.0`), then creates:

```
/var/lib/rctf-firecracker/state       0700  agent instance records
/var/lib/rctf-firecracker/run         0700  per-instance runtime / jail roots
/var/lib/rctf-firecracker/images      0755  read-only image store
/srv/jailer                           0700  jailer --chroot-base-dir
/etc/traefik/dynamic/rctf-firecracker 0755  Traefik file provider
/etc/rctf-firecracker                 0755  agent config
```

Version parsing reads only the first line of `--version` and the first
`x.y.z` token, so Firecracker/jailer ≥ 1.17 (which log an extra
`exit_code=0` line on stdout) and pre-release suffixes work. For an
unprivileged check of the same parser, `./host-setup.sh --check-version-only`
prints the two parsed versions and exits without touching the host.

The script applies **only** the file it installs,
`/etc/sysctl.d/90-rctf-firecracker.conf`, with `sysctl -q -p` and then verifies
every key/value in that file. It deliberately does not run `sysctl --system`,
so unrelated drop-ins under `/etc/sysctl.d`, `/run/sysctl.d` or
`/usr/lib/sysctl.d` are neither applied nor overwritten by this installer.

It does **not** start/stop services, flush firewalls or delete anything.

Then:

1. Install Traefik with `traefik.yml` (or merge its entries into your own
   static config). The file provider directory must be exactly the agent's
   `network.traefikDynamicDir`.
2. Install `rctf-firecracker-agent.service`, adjust `ExecStart`/`WorkingDirectory`
   to your checkout, and put the token in `/etc/rctf-firecracker/agent.env`:

   ```sh
   FIRECRACKER_AGENT_TOKEN=<long random token>
   ```

3. Give the agent a `network` section, e.g.:

   ```json
   {
     "network": {
       "publicHost": "fc1.ctf.example.com",
       "httpDomain": "fc1.ctf.example.com",
       "httpPort": 80,
       "httpsPort": 443,
       "tcpSslPort": 443,
       "tcpPortRange": { "from": 20000, "to": 29999 },
       "subnetPool": "10.200.0.0/16",
       "externalInterface": "eth0",
       "traefikDynamicDir": "/etc/traefik/dynamic/rctf-firecracker",
   ```

-      "ownerMarker": "rctf-fc",
-      "quarantineFile": "/var/lib/rctf-firecracker/net-quarantine.json",
       "reuseQuarantineSeconds": 120,
       "requireConntrack": true,
       "httpEntrypoint": "web",
       "httpsEntrypoint": "websecure",
       "tcpSslEntrypoint": "websecure",
       "tapUser": "10000",
       "tapGroup": "10000"
  }
  }
  ```

  - `subnetPool` must be an aligned CIDR between /8 and /30, and must not
    overlap the host's own networks or the public internet ranges it routes
    to. Sizing: one /30 per instance, so a /16 holds 16384 instances
    (pool-wide), and the tap suffix is the pool index (`fctap0` … ).
  - `tcpPortRange` needs one port per **tcp/raw expose entry** of every live
    instance. It must be a valid, non-empty range and must not contain
    `httpPort`, `httpsPort` or `tcpSslPort` (those belong to Traefik).
  - With the jailer, `tapUser`/`tapGroup` must be the uid/gid Firecracker runs
    as, otherwise it cannot open the tap. The VM driver defaults are
    `jailUid`/`jailGid` **10000**; keep these values in sync (the example above
    uses `10000`).
  - `reuseQuarantineSeconds` and `requireConntrack` are described above. Only
    disable the conntrack requirement on an isolated development host.
  ```

## Real-host tests (not run in CI)

The network tests use a fake `ip`/`nft`/`conntrack` runner by default. On a
disposable root host with nftables and conntrack-tools you can additionally run
the `FC_REAL`-gated checks (they create/delete a real tap named `fctap9002`,
syntax-check the rendered `inet` + `arp` ruleset with `nft -c -f -`, and flush
conntrack):

```sh
cd apps/firecracker-instancer
FC_REAL=1 sudo bun test test/net
```

Do **not** run these on a production host.

## Verification status

Verified by the track's automated tests (fake `ip`/`nft`/`conntrack` runner +
real temp directories):

- /30 IPAM determinism, uniqueness under 200 concurrent allocations, reuse
  quarantine of indexes and ports, exhaustion errors;
- per-instance idempotency, non-aliased returned leases and full rollback when
  **any** `ip`/`nft`/`conntrack` call fails, including not deleting foreign
  `fctap` interfaces;
- rendered nftables text invariants (isolation with forward `policy accept`,
  anti-spoof, input drop, scoped conntrack accepts, egress policy/masquerade,
  host-local DNAT/forward pairing, ARP anti-spoof table);
- conntrack flush command set, tolerated "0 flow entries", failure keeps the
  lease reserved;
- tap deletion failure propagation and retryable release;
- Traefik hostname/rule injection rejection, 20-char id hostnames, collision
  detection, atomic 0644 writes, orphan removal;
- restore rebuilds every route from the lease (including repaired Traefik
  files), skips and reports incomplete leases, and orphan cleanup with tap
  ownership evidence;
- release fences traffic before route/tap/conntrack teardown, is retryable at
  every step (including a half-released restore), and conntrack deletion is
  scoped to the lease's guest address (never port-only);
- taps carry the durable `rctf-fc:<ownerMarker>` alias and link type, foreign
  `fctapN` devices (including a dummy that spoofs the alias) survive restore;
- reuse quarantine survives restart (and `restore([])`), with a fail-closed
  corrupt-file path; the rendered `inet` + `arp` tables, including the unleased
  `fctap*` ARP drop, pass real `nft -c -f -` inside `unshare -Urn`.

**Verified against the real thing** (unprivileged, `../smoke/`: real nftables + real tap devices in a
user+network namespace, two real Firecracker v1.17.0 microVMs, direct mode):

- the rendered `inet` and `arp` rulesets are accepted by the real `nft` (this found and fixed an invalid ARP
  rule), allocate/publish/release work against real taps, and a tap is removed on delete;
- team isolation measured from inside the guests: neither guest can reach the other or a host-side listener,
  and removing the rules makes the same probe succeed (so the result is not a false negative);
- the guest reaches `169.254.169.254` (MMDS) through the documented `ip=` cmdline and route.

**Verified as root inside a throwaway Ubuntu 24.04 QEMU VM** (`../vmtest/`, 2026-11-08; systemd
255.4-1ubuntu8.18, kernel 6.8, Firecracker/jailer v1.17.0, nested KVM; the host ran only
unprivileged QEMU):

- `host-setup.sh` on a fresh distro, including parsing Firecracker 1.17's `--version`, applying only its own
  `/etc/sysctl.d/90-rctf-firecracker.conf` (an unrelated `99-` drop-in stays unapplied; all three intended keys
  verified) and an idempotent rerun;
- jailer mode: create/delete over the real agent API, uid/gid 10000, chroot, per-VM cgroup, real
  tap with the durable alias, MMDS flag delivery, no flag on host disk;
- the **shipped** systemd unit (byte-identical, no drop-in) actually launching the jailer
  (`CAP_SETUID` via `AmbientCapabilities=`, `CAP_SETGID` already effective; see above),
  `KillMode=process` across `systemctl restart` and `kill -9`, and agent re-adoption;
- `egress: true` masquerade, `egress: false` denial, public DNAT from an outside network
  namespace, conntrack flushing on release, and reuse quarantine;
- team isolation measured from inside the guests, with a rules-removed positive control.

**Verified with the real Traefik and the real controller** (unprivileged, `../edge/`, `../e2e/`; Traefik
v3.7.15 with the repository's file-provider config over plain HTTP): two teams routed by Host header with
unknown Hosts getting 404, route removal on delete, malformed YAML not breaking other routes, DNAT and egress
masquerade from an outside namespace, conntrack flushing, anti-spoofing and nmap exposure; and the rCTF
provider, controller and agent against real microVMs for lifecycle, expiry, restarts, capacity, ambiguous
creates and orphan cleanup.

**Verified across two hosts** (`../multihost/`, two root QEMU VMs with a controller): scheduling and per-host
pinning, capacity races, drain, host loss, partition, clock skew and token mismatch.

**Not verified:**

- TLS and certificate loading (the harnesses use plain HTTP);
- physical networks and real multi-host failure modes (the two hosts are QEMU VMs on one machine);
- your specific distro/systemd/kernel/Firecracker combination (capability and namespace
  requirements can change between releases) — the harness results are for the versions recorded in
  each `RESULTS.md`.
