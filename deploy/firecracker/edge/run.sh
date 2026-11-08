#!/bin/bash
# Real-program network-edge verification for the Firecracker instancer.
#
# Runs everything inside `unshare -Urn` (a private user + network namespace), so
# real Traefik, real nftables DNAT/NAT, real conntrack and real port scans are
# exercised without root and without touching the host network.
#
# Usage:
#   ./fetch-traefik.sh          # once: download + sha256-verify the pinned Traefik binary
#   ./run.sh                    # run all phases (~3-6 min)
#   KEEP_RUN=1 ./run.sh         # keep the run dir/logs for inspection
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)

ARTIFACTS=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
TRAEFIK=${TRAEFIK_BIN:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-edge/traefik-v3.7.15}

fail() { echo "edge-test: $*" >&2; exit 2; }

[ -x "$ARTIFACTS/firecracker" ] || fail "missing $ARTIFACTS/firecracker (run deploy/firecracker/smoke/fetch-artifacts.sh once)"
[ -f "$ARTIFACTS/images/smoke/vmlinux" ] || fail "missing $ARTIFACTS/images/smoke/vmlinux"
[ -f "$ARTIFACTS/images/smoke/rootfs.ext4" ] || fail "missing $ARTIFACTS/images/smoke/rootfs.ext4"
[ -x "$TRAEFIK" ] || fail "missing Traefik $TRAEFIK (run $HERE/fetch-traefik.sh)"
[ -r /dev/kvm ] && [ -w /dev/kvm ] || fail "/dev/kvm is not accessible"
command -v bun >/dev/null || fail "bun is required on PATH"
command -v nft >/dev/null || fail "nft is required"
command -v conntrack >/dev/null || fail "conntrack (conntrack-tools) is required"
command -v nmap >/dev/null || fail "nmap is required"
unshare -Urn true 2>/dev/null || fail "unprivileged user namespaces are not available"

# Unix socket paths must stay below 108 bytes (Firecracker + Traefik watch):
# keep the run dir short on the XDG runtime tmpfs.
export RUN=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/fce$(date +%s)$$
mkdir -p "$RUN"/{agent/{state,run,jailer,traefik},lifecycle/traefik,images/edge,logs,out,www/host}
export EDGE="$HERE" REPO="$(cd "$HERE/../../.." && pwd)" ARTIFACTS TRAEFIK
echo "edge-test run dir: $RUN"
echo "artifacts: $ARTIFACTS (read-only)  traefik: $TRAEFIK"
exec timeout "${EDGE_TIMEOUT:-900}" unshare -Urn bash "$HERE/inner.sh"
