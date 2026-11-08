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

- **IPv4 only.** No IPv6 addresses are configured on taps.
- Requires a Linux kernel with `inet`-family NAT support (5.2+ recommended)
  and nftables (v1.0+ recommended). The agent owns the `inet rctf_fc` table,
  so `nft -f -` must work on the host.
- **One tap per VM, one dedicated /30 per VM** carved from `network.subnetPool`.
  Index `i` gets network `base + 4*i`, host `.1`, guest `.2`; the tap is
  `fctap<i>`. There is **no bridge**, so VMs share no L2 segment.
- The guest boot contract uses
  `ip=<guestIp>::<hostIp>:255.255.255.252::eth0:off`; the guest's only route is
  the host side of its own /30.
- The host must have `net.ipv4.ip_forward=1` (set by `host-setup.sh`).
- The agent owns the nftables table **`inet rctf_fc`** completely and rewrites it
  atomically from its live leases. Do not add rules to it by hand.
  - Forwarding between any two `fctap*` interfaces is dropped (team isolation).
  - Anti-spoof: each tap may only emit its lease IPv4 address and MAC.
  - Input from taps is dropped except established replies to host-initiated
    connections (Traefik proxying, readiness probes). MMDS is handled inside
    Firecracker, not on the host stack.
  - Egress is denied by default. With `egress: true` the guest is masqueraded
    out of `network.externalInterface`, and destinations in loopback, RFC1918,
    CGNAT, link-local, multicast, reserved space and the VM subnet pool are
    still dropped.
- **tcp/raw** exposes get one public port each from `network.tcpPortRange`
  (`DNAT <externalInterface>:<port> → <guestIp>:<guestPort>`), allocated and
  released with the lease.
- **http/https/tcp-ssl** exposes are routed by Traefik:
  - hostname `<hostPrefix>-<first 10 chars of instanceId>.<httpDomain>`;
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
- **raw is TCP.** UDP is not supported by this track.

### DNS and certificates

- Create an **IPv4 wildcard A record** `*.<httpDomain> → <this host's public IP>`
  (e.g. `*.fc1.ctf.example.com`). Every VM host must use its **own**
  `httpDomain` if you run more than one, so `*.<domain>` pins routing to one
  host without a shared front door.
- Provide a **wildcard certificate** `*.<httpDomain>` to Traefik, either as the
  default certificate in a dynamic TLS file or through a `certResolver`
  (`network.certResolver` is copied into every https/tcp-ssl router).
- Hostnames contain a random instance id, never a team id.

### Firewall the agent port

The agent is privileged (netfilter, taps, jailer). Expose its listen port
(default `127.0.0.1:7001`; set `listen.host` to the private address) **only to
the controller**, e.g. via the cloud provider's security group / host firewall.
Do not expose it to the internet or to challenge players. The agent API uses a
per-host bearer token (`FIRECRACKER_AGENT_TOKEN`).

## Install

```sh
sudo ./host-setup.sh
```

The script checks root, Linux, `ip`, `nft`, `/dev/kvm`, and verifies the
Firecracker and jailer binaries and versions (default minimum `1.7.0`), then
creates:

```
/var/lib/rctf-firecracker/state       0700  agent instance records
/var/lib/rctf-firecracker/run         0700  per-instance runtime / jail roots
/var/lib/rctf-firecracker/images      0755  read-only image store
/var/lib/rctf-firecracker/net-routes  0700  per-instance route sidecars
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
       "routesDir": "/var/lib/rctf-firecracker/net-routes",
       "httpEntrypoint": "web",
       "httpsEntrypoint": "websecure",
       "tcpSslEntrypoint": "websecure",
       "tapUser": "1000",
       "tapGroup": "1000"
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
     as, otherwise it cannot open the tap.
   - `routesDir` holds small `instanceId.json` sidecars mapping exposes to guest
     ports. They contain no secrets and exist because the frozen `NetLease`
     contract only stores public ports/hostnames; they let a restarted agent
     re-assert DNAT and Traefik routes for adopted instances.

## Verification status

Verified by the track's automated tests (fake `ip`/`nft` runner + real temp
directories):

- /30 IPAM determinism, uniqueness under 200 concurrent allocations, reuse,
  exhaustion errors;
- per-instance idempotency and full rollback when **any** `ip`/`nft` call fails;
- rendered nftables text invariants (isolation, anti-spoof, input drop,
  egress policy/masquerade, DNAT/forward pairing, conntrack);
- Traefik hostname/rule injection rejection, atomic 0644 writes, orphan
  removal;
- restore re-assertion and orphan cleanup (stray taps, Traefik files, route
  sidecars).

**Not verified anywhere yet (needs a real KVM host):**

- `nft -c` acceptance and actual packet behaviour of the rendered ruleset;
- Traefik actually loading the generated dynamic files and proxying;
- `ip tuntap` with `user`/`group` under the jailer uid;
- Firecracker booting with the documented cmdline and MMDS reachability;
- the systemd unit's hardening options against this specific Firecracker/jailer
  version (capability/namespace requirements can change between releases).
