# Unprivileged smoke test (real Firecracker + real KVM)

`run.sh` boots **real** Firecracker microVMs with the real agent, real VM driver and real network
manager, without root. It exists because most of the repository's automated tests fake the privileged
edges; this is the check that the pieces work against the real programs.

```sh
./fetch-artifacts.sh   # downloads Firecracker (sha256-verified), a CI kernel, busybox, jq; builds the guest rootfs
./run.sh               # needs bun, nft, ip, curl, python3, /dev/kvm access, unprivileged user namespaces
```

## How it stays unprivileged and safe

The agent and Firecracker run inside `unshare -Urn`: a private **user + network namespace**. Inside it the
script is "root", so it can create real tap devices, a dummy uplink and real nftables rules, but none of it
is visible to or can reach the host's network. The run directory lives under `$XDG_RUNTIME_DIR` (a tmpfs)
and is short on purpose: Firecracker rejects unix socket paths longer than 107 bytes.

## What it verifies (24 checks)

- The agent starts with the real `VmDriver` and `NetworkManager`, and preflight reports `accepting: true`.
- A real kernel boots under KVM in about 2 seconds, `ip=` autoconfiguration works, and the reference guest
  `init` (the one in `../guest/`) fetches the **MMDS v2** document and exports the flag and environment.
- The flag reaches the guest service byte-for-byte, and appears nowhere on the host: not in the agent state
  directory, the Traefik directory, the agent log, or the per-instance rootfs disk image.
- The real `nft` accepts the rendered `inet` and `arp` rulesets; anti-spoof rules are present.
- `kill -9` of the agent does not kill the VM; the restarted agent re-adopts it as `running` and keeps its tap.
- A duplicate create is idempotent and a changed spec is rejected with 409.
- **Team isolation measured from inside the guests:** two VMs each hold only their own flag, neither can reach
  the other or a listener on the host side of its tap, and a **control** (flushing the rules) shows the same
  probe then succeeds, so the "blocked" result is not a false negative.
- Delete removes the process, tap, run directory and nftables rules, and the deleted id is fenced against a
  late re-create (409).

## What it does NOT verify

- **Jailer mode.** The jailer needs real root (chroot, mknod, cgroups); this test uses `mode: direct`.
- **Traefik routing and TLS, `egress: true` masquerade, public DNAT from outside** (only a locally generated
  connection is possible in the namespace), **conntrack flushing** (conntrack-tools is not required here),
  and **systemd hardening**.
- The controller, scheduler, multi-host behaviour and the rCTF provider. Those are covered by the unit and
  end-to-end tests in `tests/server/tests/unit/firecracker-*.test.ts` with fake agents, not by this script.
- Behaviour on other kernels, guests, or Firecracker versions than the ones fetched (Firecracker v1.17.0,
  kernel 6.1.155 from the Firecracker CI bucket, busybox 1.35.0, latest jq).

Run these on a real root host before an event: `host/README.md` lists the checks, and
`FC_REAL=1 sudo bun test apps/firecracker-instancer/test/net` runs the privileged network tests.
