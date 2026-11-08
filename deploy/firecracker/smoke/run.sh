#!/bin/bash
# Unprivileged end-to-end smoke test of the Firecracker instancer agent against REAL Firecracker + KVM.
# Needs: /dev/kvm access, unprivileged user namespaces, bun, nft, ip, curl, python3, and the artifacts from
# ./fetch-artifacts.sh. Everything network-related happens inside a throwaway user+network namespace.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ARTIFACTS=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
[ -x "$ARTIFACTS/firecracker" ] && [ -f "$ARTIFACTS/images/smoke/rootfs.ext4" ] || {
  echo "artifacts missing: run $HERE/fetch-artifacts.sh first" >&2; exit 2; }
[ -r /dev/kvm ] && [ -w /dev/kvm ] || { echo "/dev/kvm is not accessible" >&2; exit 2; }
command -v bun >/dev/null || { echo "bun is required on PATH" >&2; exit 2; }
# Unix socket paths are limited to 107 bytes, so keep the run dir short (XDG_RUNTIME_DIR is a tmpfs).
export RUN=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/fcs$(date +%s)
mkdir -p "$RUN"/{state,run,jailer,traefik}
cat > "$RUN/agent.yaml" <<YAML
hostId: smoke1
listen: { host: 127.0.0.1, port: 7001 }
stateDir: $RUN/state
capacity: { vcpus: 4, memMiB: 4096, diskMiB: 4096, maxInstances: 4 }
expiryGraceSeconds: 30
vm:
  mode: direct                 # the jailer needs real root; see README
  firecrackerBin: $ARTIFACTS/firecracker
  imagesDir: $ARTIFACTS/images
  runDir: $RUN/run
  chrootBase: $RUN/jailer
  allowUntrustedImages: true   # in a user namespace host-owned parents map to 'nobody'
network:
  publicHost: 10.200.0.1
  httpDomain: smoke.test
  externalInterface: dummy0
  traefikDynamicDir: $RUN/traefik
  requireConntrack: false      # conntrack-tools usually isn't installed unprivileged
  quarantineFile: $RUN/net-quarantine.json
YAML
echo "run dir: $RUN"
exec timeout 290 unshare -Urn bash "$HERE/inner.sh"
