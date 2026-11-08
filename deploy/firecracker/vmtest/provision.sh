#!/usr/bin/env bash
#
# Base provisioning inside the throwaway VM. Runs as root, is idempotent, and
# deliberately does NOT create /var/lib/rctf-firecracker, /srv/jailer or any
# other rctf directory: check 00 must see a fresh host for host-setup.sh.
#
# Expects (copied by run.sh):
#   /tmp/fc-vmtest-repo/            the git checkout
#   /tmp/fc-vmtest/artifacts/       firecracker, jailer, vmlinux, smoke rootfs,
#                                   busybox rootdir, static jq
set -euo pipefail

REPO_SRC=${REPO_SRC:-/tmp/fc-vmtest-repo}
ART=${ART:-/tmp/fc-vmtest/artifacts}
REPO=/opt/rctf-firecracker
BUN_BIN=${BUN_BIN:-/usr/local/bin/bun}
BUN_VERSION=${BUN_VERSION:-1.4.4}
export DEBIAN_FRONTEND=noninteractive

log() { printf '==> %s\n' "$*"; }
die() {
  printf 'provision: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "must run as root"
[ -f "$REPO_SRC/package.json" ] || die "checkout missing at $REPO_SRC"
[ -x "$ART/firecracker" ] || die "firecracker artifact missing"
[ -x "$ART/jailer" ] || die "jailer artifact missing"
[ -d "$ART/rootdir" ] || die "busybox rootdir missing"

log "installing packages"
apt-get update -q
apt-get install -y -q --no-install-recommends \
  nftables conntrack jq netcat-openbsd curl iproute2 e2fsprogs unzip tar \
  ca-certificates psmisc procps nmap python3 >/dev/null

log "installing bun $BUN_VERSION at $BUN_BIN"
if ! "$BUN_BIN" --version 2>/dev/null | grep -qx "$BUN_VERSION"; then
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/bun.zip" \
    "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
  unzip -q "$tmp/bun.zip" -d "$tmp"
  install -m 0755 "$tmp/bun-linux-x64/bun" "$BUN_BIN"
  rm -rf "$tmp"
fi
"$BUN_BIN" --version

log "installing firecracker + jailer into /usr/local/bin"
install -m 0755 "$ART/firecracker" /usr/local/bin/firecracker
install -m 0755 "$ART/jailer" /usr/local/bin/jailer

log "checkout to $REPO"
rm -rf "$REPO"
mkdir -p "$REPO"
cp -a "$REPO_SRC/." "$REPO/"
chown -R ubuntu:ubuntu "$REPO"
log "bun install"
su -s /bin/bash ubuntu -c "cd '$REPO' && '$BUN_BIN' install --frozen-lockfile"
chmod -R a+rX "$REPO"

log "building the test guest rootfs (flag stays in tmpfs; no /www copy)"
build=/tmp/fc-vmtest-rootdir
rm -rf "$build"
cp -a "$ART/rootdir" "$build"
install -m 0755 "$REPO/deploy/firecracker/vmtest/guest-start" "$build/app/start"
bash "$REPO/deploy/firecracker/guest/build-rootfs.sh" \
  --dir "$build" --size 64M --jq "$ART/jq" \
  --out "$ART/vmtest-rootfs.ext4" >/dev/null
rm -rf "$build"

# The privileged net-test suite runs unprivileged user namespaces; Ubuntu 24.04
# restricts them by default. This is test-VM configuration only.
sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 || true
printf '%s\n' 'kernel.apparmor_restrict_unprivileged_userns=0' \
  >/etc/sysctl.d/99-rctf-vmtest-userns.conf

touch /etc/rctf-vmtest-provisioned
log "base provisioning done"
