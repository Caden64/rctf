# Real-root verification in a throwaway QEMU VM

This harness proves, with **real execution as root**, the Firecracker
instancer pieces that the unprivileged smoke test cannot: jailer mode, the
shipped systemd unit, `host-setup.sh` on a fresh distribution, privileged
network tests, conntrack flushing, egress NAT and public DNAT.

It boots an Ubuntu 24.04 cloud image under KVM. **Nothing privileged runs on
your machine**: `vm.sh` only starts `qemu-system-x86_64` as your user and
forwards one ssh port. Every root operation (nftables, taps, jailer, cgroups,
systemd, network namespaces) happens inside the VM. There is no `sudo` on the
host and none is needed.

```sh
cd deploy/firecracker/vmtest
./run.sh                 # full run; stops the VM on exit
KEEP_VM=1 ./run.sh       # leave it running for debugging
./vm.sh ssh              # shell inside the VM (ubuntu, passwordless sudo)
./vm.sh stop             # kill qemu (keeps the disk)
./vm.sh destroy          # stop and delete the qcow2 overlay
```

## Requirements

Host (unprivileged):

- `/dev/kvm` readable/writable, AMD-V/Intel-VT with nested virtualization
  enabled for the guest (the VM must expose `/dev/kvm` to Firecracker),
- `qemu-system-x86_64`, `qemu-img`, `ssh`, `ssh-keygen`, `curl`, `python3`,
  `tar`, `/dev/kvm`,
- ~5 GiB RAM free (VM uses 4 GiB by default) and ~10 GiB disk.

The Firecracker v1.17.0, kernel, busybox and rootfs artifacts are shared with
`deploy/firecracker/smoke/` (`~/.cache/rctf-fc-smoke`, populated by
`fetch-artifacts.sh`; `run.sh` fetches them under a `flock` if missing).

VM: 4 vCPU / 4 GiB / 40 GiB overlay (Ubuntu 24.04 cloud image, downloaded once
to `~/.cache/rctf-vmtest/`). Bun is downloaded inside the VM (pinned 1.4.4).

## What is checked (numbered assertions)

| Check                         | Assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-host-setup.sh`            | `host-setup.sh` on a fresh host as shipped (no wrapper); `--check-version-only` parses Firecracker 1.17's extra `exit_code=0` line; directories and modes; sysctl (`ip_forward`, `rp_filter`); idempotent rerun.                                                                                                                                                                                                                                                     |
| `10-agent-systemd.sh`         | The repository unit (byte-identical, **no drop-in**) starts the agent under real systemd; `KillMode=process`; preflight `accepting:true` in jailer mode; every blocking preflight check true; both images visible; `CAP_SETUID`+`CAP_SETGID` effective and ambient in the agent.                                                                                                                                                                                     |
| `20-jailer-instance.sh`       | The installed unit is byte-identical and has no drop-in; HTTP create in jailer mode; Firecracker uid 10000; executable inside the jail; `/proc/<pid>/root` == jail root; per-instance cgroup + `pids.max`; real tun/tap with `rctf-fc:rctf-fc` alias and /30; MMDS v2 flag byte-exact; flag absent from agent state, run dir, jail tree, Traefik dir, journal, cmdline, rootfs and base images; delete removes process/jail/cgroup/tap/nft rules; tombstone fencing. |
| `30-restart-survival.sh`      | `systemctl restart` and `kill -9` leave the VM alive and re-adopted (strict identity, `vm-identity.json`); `KillMode=process`; CAP_SYS_PTRACE drop-in experiment and recovery (the shipped ambient caps stay in effect).                                                                                                                                                                                                                                             |
| `40-net-tests.sh`             | `FC_REAL=1 bun test test/net` as root (105 tests, 0 fail); the unprivileged namespace suite as `ubuntu` (real nft via a temp file, not Bun's stdin socketpair).                                                                                                                                                                                                                                                                                                      |
| `50-conntrack-quarantine.sh`  | A real DNAT TCP flow is tracked; delete flushes every entry for the guest address; the freed /30 index and public port are durably quarantined and not reused.                                                                                                                                                                                                                                                                                                       |
| `60-egress-dnat-isolation.sh` | `egress:true` masquerade to an outside netns service (plus a conntrack masquerade proof); `egress:false` blocked; public DNAT from the outside netns; team isolation measured inside the guests with a flush control; `nmap` from outside sees only the published ports.                                                                                                                                                                                             |

The guest used for the checks is `guest-start` in this directory: it keeps the
flag on tmpfs (never on the ext4 rootfs) and exposes `/probe.txt` with the
results of continuous probes to peer guests and to an outside HTTP service.

## The "outside" network

Inside the VM the harness creates a veth pair: `fcveth0` in the main namespace
with `192.0.2.1/24`, and `fcvext0` in the `fcoutside` netns with
`192.0.2.2/24`. The agent is configured with:

- `network.externalInterface = fcveth0` (DNAT + masquerade),
- `network.publicHost = 192.0.2.1`,
- `network.subnetPool = 10.200.0.0/16`,
- `network.tcpPortRange = 30000-30010`.

An HTTP service on `192.0.2.2:9999` represents the internet. `nmap` runs in
`fcoutside` against `192.0.2.1`. The VM's management sshd is bound to
`10.0.2.15:22` only, so port 22 is not visible on the public test interface.

## Files

| Path           | Purpose                                                       |
| -------------- | ------------------------------------------------------------- |
| `vm.sh`        | create/start/ssh/status/stop/destroy the VM (idempotent)      |
| `provision.sh` | runs as root in the VM: packages, Bun, checkout, guest image  |
| `run.sh`       | host driver: boot, copy, provision, run checks, stop, summary |
| `guest-start`  | test-only guest service (flag on tmpfs + probe results)       |
| `checks/*.sh`  | numbered pass/fail assertions                                 |
| `repros/*.sh`  | minimal reproductions for product bugs / harness issues       |
| `RESULTS.md`   | dated log of what actually ran and the exact outcomes         |

## Honest limitations

- **Only this environment.** Ubuntu 24.04 (systemd 255, kernel 6.8, nftables
  1.0.9, conntrack 1.4.8) and Firecracker v1.17.0. Other kernels/systemd
  versions may behave differently (particularly the capability interaction the
  unit's `AmbientCapabilities=` works around; see RESULTS).
- **One host.** No controller, scheduler, multi-host or rCTF provider.
- **Nested virtualization.** Firecracker runs on KVM-on-KVM. It works here, but
  it is slower than bare metal and cannot validate hardware-specific behaviour.
- **Test topology, not a real internet.** Egress and DNAT are measured against
  a veth/netns peer; no real public traffic, no Traefik/TLS.
- **The test guest/service and the agent config are test fixtures**, not the
  production sample. `cgroupLimits: ['pids.max=512']` is set so the jailer
  creates a per-VM cgroup (with the default empty list jailer v2 creates none).
- **Conntrack-tools and unprivileged user namespaces** are installed/enabled
  in the VM. The namespace suite now feeds `nft` a real temp file instead of a
  Bun stdin socketpair; `bunCommandRunner` (production) already used a Blob.
- **The version parser has rootless regression coverage** (fake binaries) in
  `apps/firecracker-instancer/test/host-setup-version.test.ts`; the VM check
  still runs the real pinned 1.17.0 binary.
- The host artifacts cache is shared with other workers; never delete it while
  they run.
