---
title: Firecracker instancer
description: Run one Firecracker microVM per team on your own KVM hosts, with a scheduler, durable ownership, and multi-host capacity management.
order: 3
---

The Firecracker instancer boots a prebuilt kernel and root filesystem in a [Firecracker](https://firecracker-microvm.github.io/) microVM for every team. Use it when a challenge needs a real kernel boundary (kernel exploitation, container escapes, untrusted code execution) instead of a shared-kernel container.

For the participant controls, common `<red>instancerConfig</red>` fields, and endpoint types, see [Instancer](/integrations/instancer).

:::warning[Hardware and verification status]
This backend needs bare-metal or nested-virtualization Linux hosts with `/dev/kvm`. Most of the automated tests fake the privileged edges. In addition, an unprivileged smoke test (`deploy/firecracker/smoke/{:dir}`) boots real Firecracker v1.17.0 microVMs under real KVM with the real agent, tap devices and nftables, and checks flag delivery, agent-crash recovery, and team isolation from inside the guests. It does not cover jailer mode, Traefik, TLS, egress NAT, conntrack, or systemd, and nothing has been run across several hosts. Run the checks in [Verify a host](#verify-a-host) as root on your own hardware before trusting this with a live event.
:::

## Architecture

```text
rCTF API ──Bearer authToken──▶ controller ──Bearer per-host token──▶ host agent ──▶ jailer ▶ firecracker ▶ guest
 provider                      scheduler,                            (root, KVM,                       (untrusted)
 instancers/firecracker        SQLite, reaper,                        nftables, taps,
                               reconciler                             Traefik files)
```

| Component | Runs on | Responsibility |
| --- | --- | --- |
| Provider `instancers/firecracker` | rCTF API | Translates rCTF create, get, extend, and delete calls into controller requests. |
| Controller | One machine, unprivileged | Owns which team has which instance on which host, capacity reservations, expiry, and recovery. State lives in SQLite. |
| Host agent | Every KVM host, root | Owns what physically exists on the host: VMs, tap devices, firewall rules, ports, Traefik routes. State is JSON files. |

Key properties:

- **Ownership is pinned.** An instance stays on the host that created it. Get, extend, and delete always go to that host.
- **No oversubscription.** Placement and reservation happen in a single SQLite transaction, and the agent enforces its own limits again. A full fleet returns a clear `no capacity` message.
- **Idempotent and race-safe.** A team can never have two live instances of the same challenge, even with duplicate or concurrent create requests (the one exception is a partitioned host, see [Host health, draining, and removal](#host-health-draining-and-removal)). Extend and expiry race on one row, so exactly one wins.
- **Survives restarts.** The controller resumes from SQLite. The agent re-adopts running VMs from its state files, cleans orphans, and does not kill VMs when it restarts or shuts down. The shipped systemd unit uses `KillMode=process` for this reason, so `systemctl stop` also leaves VMs running: drain the host and delete its instances first if you want them gone. This unit behaviour has not been tested under a real systemd.
- **The instancer never persists flags.** Flags travel in request memory to Firecracker's MMDS and appear only on the guest's tmpfs. The controller and agent never write them to the kernel command line, a disk, SQLite, or logs. This covers the instancer's own state only: your guest service can still store a flag it receives, and host-level swap or core dumps are outside its control.

## Requirements

Every KVM host:

- Linux with KVM (`/dev/kvm`), cgroup v2, nftables, `iproute2`, and [conntrack-tools](https://conntrack-tools.netfilter.org/).
- `firecracker` and `jailer` binaries. Use the same release for both.
- A filesystem with reflink support for the run directory (XFS with `reflink=1`, or Btrfs) for fast per-VM copies. Plain ext4 works, but each boot copies the whole rootfs.
- Traefik for `http`, `https`, and `tcp-ssl` endpoints.
- Time synchronized with the controller (chrony or NTP). Hosts whose clock differs by more than `maxClockSkewSeconds` stop receiving new instances.
- Wildcard DNS for `*.<httpDomain>` pointing at the host, and a wildcard certificate for the same name.

The controller needs Bun, a writable state directory, and network access to every agent. rCTF needs network access to the controller.

## Supported networking model

- **IPv4 only.** Guests get one NIC.
- **One tap and one dedicated /30 per VM**, carved from `subnetPool`. There is no bridge, so VMs share no layer-2 segment.
- **Isolation:** forwarding between taps is dropped, each tap may only send its own IP and MAC, ARP is filtered, IPv6 is dropped, and traffic from guests to the host is dropped except replies to host-initiated connections.
- **Egress is off by default.** With `egress: true` a guest can reach the internet through NAT, but never loopback, RFC1918, link-local, or other guests.
- **Reuse safety:** when an instance is released the agent flushes its conntrack entries, and the freed /30 and public port are not handed to another team for `reuseQuarantineSeconds` (default 120). Allocation refuses to run without conntrack-tools unless you set `network.requireConntrack: false` (development only).
- **`tcp` and `raw` endpoints** get a public port from `tcpPortRange` through DNAT, reported as `publicHost:port`.
- **`http`, `https`, and `tcp-ssl` endpoints** are routed by Traefik at `<hostPrefix>-<instance id>.<httpDomain>`. Traefik terminates TLS, and the guest serves plain HTTP or TCP. Give each host its own `httpDomain` (for example `fc1.ctf.example.com`), so wildcard DNS selects the host without a shared front door.
- **UDP is not supported.**

Other tools that drop forwarded traffic in their own nftables or iptables chains still apply. The agent only manages its own `inet rctf_fc` and `arp rctf_fc_arp` tables.

## Install

The files are in `deploy/firecracker/{:dir}`:

:::file-tree
- deploy/
  - firecracker/
    - controller.example.yaml Controller configuration
    - agent.example.yaml Host agent configuration
    - rctf-firecracker-controller.service Controller systemd unit
    - sample-challenge.yaml Example challenge
    - host/ Host setup script, sysctl, Traefik config, agent unit, networking notes
    - guest/ Guest `init`, rootfs builder, and the boot contract
:::

### 1. Prepare each host

```ansi
$ <red>sudo</red> deploy/firecracker/host/host-setup.sh
```

The script is idempotent. It checks root, KVM, `ip`, `nft`, and the Firecracker binaries, enables `ip_forward`, and creates the state directories. It never deletes anything. Details and the Traefik static config are in `deploy/firecracker/host/README.md{:file}`.

### 2. Build an image

An image is a directory on every host, `<imagesDir>/<name>/`, containing an uncompressed `vmlinux` kernel and a `rootfs.ext4`. Build the rootfs without root:

```ansi
$ <red>deploy/firecracker/guest/build-rootfs.sh</red> <dim>--image</dim> debian:bookworm-slim <dim>--size</dim> 512M <dim>--jq</dim> /usr/bin/jq <dim>--out</dim> /var/lib/rctf-firecracker/images/web-demo/rootfs.ext4
```

The kernel needs `CONFIG_IP_PNP`, virtio-mmio, and ext4 built in. The full list, and the kernel command line the driver generates, are in `deploy/firecracker/guest/README.md{:file}`. Keep the image directories and `imagesDir` owned by root and not writable by group or others, because the agent refuses untrusted image directories.

:::warning[Image builder trust]
Run `build-rootfs.sh` on images you control, and never as root against untrusted sources.
:::

### 3. Configure and start the agent

Copy `agent.example.yaml` to `/etc/rctf-firecracker/agent.yaml{:file}`, set `hostId`, the private `listen.host`, capacity, and the `network` section, then run it as root:

```ansi
$ <red>FIRECRACKER_AGENT_TOKEN</red>=<green><host-token></green> <red>bun</red> apps/firecracker-instancer/src/agent/index.ts /etc/rctf-firecracker/agent.yaml
```

Use `host/rctf-firecracker-agent.service{:file}` to run it under systemd. The agent API controls root-level operations and serves plain HTTP. Bind it to a private address and firewall it to the controller only, or put a TLS reverse proxy in front of it and give the controller an `https` URL plus `caCertificate`.

### 4. Configure and start the controller

Copy `controller.example.yaml` to `/etc/rctf-firecracker/controller.yaml{:file}` and list every host. Secrets belong in an environment file:

```sh title="/etc/rctf-firecracker/controller.env"
FIRECRACKER_CONTROLLER_AUTH_TOKEN=<token-for-rctf>
FIRECRACKER_CONTROLLER_ADMIN_TOKEN=<different-token-for-operators>
FIRECRACKER_TEAM_KEY_SECRET=<long-random-secret>
FIRECRACKER_HOST_TOKEN_FC1=<host-token>
```

The controller refuses to start without `FIRECRACKER_TEAM_KEY_SECRET`, and `authToken` must differ from `adminToken`. The `FIRECRACKER_HOST_TOKEN_<ID>` suffix is the host id in upper case with non-alphanumerics replaced by `_`. Use `deploy/firecracker/rctf-firecracker-controller.service{:file}` to run it under systemd.

### 5. Point rCTF at the controller

```yaml title="rctf.d/instancer.yaml"
instancers:
  firecracker:
    name: instancers/firecracker
    options:
      apiUrl: https://controller.internal.example.com:7000
      authToken: <token-for-rctf>
```

| Field or variable | Purpose |
| --- | --- |
| `<red>options.apiUrl</red>` | Base URL of the controller. It must be an `http(s)` URL without credentials, query, or fragment. Redirects are rejected. |
| `<red>options.authToken</red>` | Bearer token for the controller's `authToken`. |
| `<yellow>FIRECRACKER_INSTANCER_API_URL</yellow>` | Environment override for `<red>apiUrl</red>`. |
| `<yellow>FIRECRACKER_INSTANCER_AUTH_TOKEN</yellow>` | Environment override for `<red>authToken</red>`. |

Put the controller behind TLS, or on a private network. The bearer token is the only authentication.

## Challenge config

```yaml title="challenge.yaml"
instancerConfig:
  instancer: firecracker
  challengeIntegrationId: fc-web-demo
  timeoutMilliseconds: 1800000
  extendable: true
  config:
    image: web-demo
    vcpus: 1
    memMiB: 256
    diskMiB: 1024
    egress: false
    bootTimeoutSeconds: 60
    readiness: { kind: http, port: 8080, path: /, expectStatus: 200 }
    env:
      CHALLENGE: fc-web-demo
  expose:
    - kind: https
      hostPrefix: fc-web-demo
      containerName: app
      containerPort: 8080
      shouldDisplay: true
      title: Challenge
```

| Field | Default | Purpose |
| --- | --- | --- |
| `<red>image</red>` | required | Image directory name under every host's `imagesDir`. |
| `<red>vcpus</red>` | `1` | vCPUs, 1 to 8. |
| `<red>memMiB</red>` | `256` | Guest memory in MiB. |
| `<red>diskMiB</red>` | `1024` | Reserved writable disk. The rootfs image must not be larger. |
| `<red>kernelArgs</red>` | none | Extra kernel command line arguments. |
| `<red>egress</red>` | `false` | Allow outbound internet access. |
| `<red>bootTimeoutSeconds</red>` | `60` | How long readiness may take before the instance is marked `errored`. |
| `<red>readiness</red>` | TCP on the first exposed port | `tcp`, `http`, or `none` probe, run from the host over the tap. |
| `<red>env</red>` | `{}` | Non-secret environment for the guest `init`. Never put flags here. |

Every `expose` entry must use `containerName: app`, because each instance is a single machine. `containerPort` is the guest port. Endpoints are returned in `expose` order. Endpoint kinds behave as described in [Supported networking model](#supported-networking-model).

### Flags and the guest boot contract

The agent places per-team flags in Firecracker's MMDS. The reference guest `init` reads them with a version-2 token request and writes each flag to `/run/rctf/flags/<provider>` on a tmpfs with mode `0400`. It also exports `RCTF_FLAGS_DIR`, `RCTF_INSTANCE_ID`, `RCTF_HOSTNAME`, and every key of `env`, then starts your service. The full contract, metadata schema, and a sample service are in `deploy/firecracker/guest/README.md{:file}`.

## Operations

### Capacity and scheduling

Each host's `capacity` in the controller config is an upper bound. The agent also reports its own capacity, and the controller uses the smaller value. Reservations count `creating`, `running`, and `deleting` instances, and a deleting instance holds its resources until the agent confirms teardown. Use `overcommit` only if you accept the risk of CPU or memory contention.

### Host health, draining, and removal

The controller probes every agent every `heartbeatIntervalSeconds`. A host that misses heartbeats for `hostTimeoutSeconds`, has a stale or inaccurate clock sample, or reports `accepting: false` takes no new placements while existing instances keep their reservations.

The operations API uses the admin token:

| Request | Effect |
| --- | --- |
| `GET /v1/hosts` | Host health, capacity, and reservations. |
| `POST /v1/hosts/<id>/drain` | Stop placing new instances. Existing instances keep running, and extend and delete still work. |
| `POST /v1/hosts/<id>/undrain` | Resume placement. |
| `DELETE /v1/hosts/<id>` | Write off the instances of an unhealthy host. The host stays drained until you undrain it. Healthy hosts are refused. |

```ansi
$ <red>curl</red> <dim>-H</dim> <green>"Authorization: Bearer $ADMIN_TOKEN"</green> <dim>-X</dim> POST https://controller.internal.example.com:7000/v1/hosts/fc1/drain
```

If a host is unreachable for `hostLostSeconds`, its instances are written off so the affected teams can start again on another host. When the host returns, its orphaned VMs are deleted. In that rare case a partitioned agent may keep the old VM running until its own deadline (`expiry + expiryGraceSeconds`), so a team can briefly have two instances.

### Expiry and extension

The controller owns the deadline. Extending sets the deadline to now plus `timeoutMilliseconds`, never shortens it, and fails for an expired instance. `maxLifetimeSeconds` caps total lifetime. The agent also enforces the deadline plus `expiryGraceSeconds` on its own, so a lost controller does not leave VMs running forever.

### Crashes and restarts

- **Controller restart:** state resumes from SQLite. Creates with an unknown outcome stay reserved, then the reconciler either adopts the VM or deletes the instance id on the agent, which records a tombstone so a delayed create can never produce a VM. Only after the agent confirms is the team's slot freed.
- **Agent restart:** running VMs keep running. The agent re-adopts them, resumes pending teardowns, removes orphaned VMs, taps, rules, and routes, and reports `accepting: false` until recovery succeeds. An instance that was still being created when the agent died cannot resume, because flags are never stored. It is removed and the team can start again.

## Security model

- The guest is untrusted. In `jailer` mode Firecracker runs with a dedicated uid and gid, a chroot, a new PID namespace, resource limits, and Firecracker's default seccomp filter. The jailer only creates a per-VM cgroup when `vm.cgroupLimits` is set (for example `['pids.max=512']`), and the default is empty, so set it if you want cgroup isolation. Keep `network.tapUser` and `network.tapGroup` equal to `vm.jailUid` and `vm.jailGid`, otherwise the unprivileged Firecracker process cannot open its tap. Disk and network have rate limiters. `direct` mode skips the jailer, is for development only, and logs a warning.
- The agent is privileged. It authenticates the controller with a constant-time bearer check, validates every id, path, image name, and hostname against strict allow lists, never uses a shell, and keeps images read-only. Bind the agent to a private address.
- Hostnames contain a random instance id, never a team id. Hosts only see an HMAC of the team id.
- Challenge images are trusted to the extent that you build them. A guest can still use CPU and bandwidth up to its limits, so size `capacity` accordingly.

## Verify a host

First, the unprivileged smoke test boots real microVMs inside a throwaway user and network namespace, so it is safe to run on any machine with KVM access:

```ansi
$ <red>deploy/firecracker/smoke/fetch-artifacts.sh</red>
$ <red>deploy/firecracker/smoke/run.sh</red>
```

It covers 24 checks, listed with its limits in `deploy/firecracker/smoke/README.md{:file}`. Then, on the real host as root, cover what it cannot: jailer mode, Traefik and TLS, egress, conntrack, and systemd.

```ansi
$ <red>FC_REAL</red>=1 <red>sudo</red> bun test apps/firecracker-instancer/test/net
```

Start the agent and controller, create a challenge from `sample-challenge.yaml{:file}`, and confirm that:

- the instance reaches `running` and its endpoint answers through Traefik,
- two teams cannot reach each other's guest addresses,
- `egress: false` guests cannot reach the internet, and `egress: true` guests can reach it but not RFC1918 space,
- deleting the instance removes the tap, the nftables rules, the Traefik file, and the run directory,
- restarting the agent keeps the VM, and `kill -9` on the agent during create leaves no orphans after the restart.

## Limitations

- IPv4 and TCP only, one NIC, one machine per instance.
- Firecracker supports x86_64 and aarch64 hosts. Images must match the host architecture.
- A single controller instance. Run it under a supervisor. There is no controller leader election.
- Host clocks must be synchronized, and capacity values are operator-supplied.
