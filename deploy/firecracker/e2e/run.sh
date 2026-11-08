#!/bin/bash
# Unprivileged end-to-end harness for the Firecracker instancer:
#
#   rCTF provider -> controller (real HTTP + bun:sqlite) -> real agent
#     (real VmDriver / NetworkManager / nft / taps) -> real Firecracker VM.
#
# Everything runs inside `unshare -Urn` (a private user + network namespace),
# exactly like deploy/firecracker/smoke/run.sh: no root, no sudo, and none of
# the taps or nftables rules are visible to (or can reach) the host network.
#
# Requires: bun on PATH, /dev/kvm access, unprivileged user namespaces, nft, ip,
# conntrack, pgrep, and the artifacts from smoke/fetch-artifacts.sh (already
# fetched; this script never downloads anything).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ARTIFACTS=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}

[ -x "$ARTIFACTS/firecracker" ] || {
  echo "missing $ARTIFACTS/firecracker (do not fetch it here; see smoke/fetch-artifacts.sh)" >&2
  exit 2
}
[ -f "$ARTIFACTS/images/smoke/rootfs.ext4" ] && [ -f "$ARTIFACTS/images/smoke/vmlinux" ] || {
  echo "missing $ARTIFACTS/images/smoke/{vmlinux,rootfs.ext4}" >&2
  exit 2
}
[ -r /dev/kvm ] && [ -w /dev/kvm ] || { echo "/dev/kvm is not accessible" >&2; exit 2; }
command -v bun >/dev/null || { echo "bun is required on PATH (export PATH=\$HOME/.local/bin:\$PATH)" >&2; exit 2; }
for tool in nft ip conntrack pgrep unshare timeout; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

# Unix socket paths are limited to 107 bytes (SUN_LEN), so the run dir must be
# short. XDG_RUNTIME_DIR is a tmpfs owned by the user.
RUNTIME_BASE=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
[ -d "$RUNTIME_BASE" ] || { echo "no writable runtime dir: $RUNTIME_BASE" >&2; exit 2; }
RUN=$(mktemp -d "$RUNTIME_BASE/fce-XXXXXX")
export RUN
export SMOKE_ARTIFACTS="$ARTIFACTS"
export PATH="$HOME/.local/bin:$PATH"

echo "e2e run dir: $RUN"
echo "artifacts:   $ARTIFACTS (read-only)"

# Hard outer bound. inner.sh has its own (shorter) bound for the driver.
exec timeout "${E2E_TIMEOUT:-900}" unshare -Urn bash "$HERE/inner.sh"
