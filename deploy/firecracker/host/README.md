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
    still dropped.
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
`--reply-dst`) plus every public DNAT port (`--orig-port-dst <port> -p tcp`).
"0 flow entries have been deleted" is treated as success; any other failure
aborts the release so the lease stays reserved and the release can be retried.

Freed /30 indexes and public ports are additionally **quarantined** for
`network.reuseQuarantineSeconds` (default 120) before they can be handed out
again; allocation prefers never-used entries and then the oldest release.
Restore-time stray resources (a removed abandoned tap) start their quarantine
at restore time.

Allocation refuses to proceed when `conntrack` is unavailable, unless
`network.requireConntrack` is explicitly set to `false` (dev only).

### Tap ownership

An allocation never deletes an interface it did not create. If the chosen
`fctapN` already exists (`File exists` from `ip tuntap add`), that index is
skipped/quarantined and the allocation fails with a clear error if no index is
left; the existing interface is left untouched. A failed `ip link del` is
reported (not swallowed) so release stays retryable.

Restore only removes stray `fctap*` interfaces when the ownership evidence
matches: it is down **and** unaddressed (interrupted create), or every IPv4
address on it is exactly the host side of the /30 belonging to its own index in
`subnetPool`. A foreign interface named `fctap9` (e.g. with a LAN address) is
left alone and reported.

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
  ownership evidence.

**Not verified anywhere yet (needs a real KVM host):**

- `nft -c` acceptance and actual packet behaviour of the rendered ruleset;
- Traefik actually loading the generated dynamic files and proxying;
- `ip tuntap` with `user`/`group` under the jailer uid;
- Firecracker booting with the documented cmdline and MMDS reachability;
- the systemd unit's hardening options against this specific Firecracker/jailer
  version (capability/namespace requirements can change between releases).
