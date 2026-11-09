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
# Cloud-image login user (ubuntu on Ubuntu, debian on Debian 12). run.sh
# derives it from VM_IMAGE and passes it through; direct use defaults to the
# historical Ubuntu user.
VM_USER=${VM_USER:-ubuntu}
BUN_BIN=${BUN_BIN:-/usr/local/bin/bun}
BUN_VERSION=${BUN_VERSION:-1.4.4}
# Official SHA256SUMS256 entry for bun-v1.4.4/bun-linux-x64.zip (pinned again
# here so a compromised/tampered SHASUMS file cannot redirect the install).
BUN_SHA256=${BUN_SHA256:-bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c}
BUN_SHASUMS_URL=${BUN_SHASUMS_URL:-https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt}
BUN_ZIP_URL=${BUN_ZIP_URL:-https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip}
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
  curl -fsSL --retry 3 -o "$tmp/bun.zip" "$BUN_ZIP_URL"
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$BUN_SHASUMS_URL"
  WANT_SHA=$(awk '$2 == "bun-linux-x64.zip" || $2 == "*bun-linux-x64.zip" { print $1; exit }' "$tmp/SHASUMS256.txt")
  [ -n "$WANT_SHA" ] || die "SHASUMS256.txt has no entry for bun-linux-x64.zip"
  [ "$WANT_SHA" = "$BUN_SHA256" ] ||
    die "bun SHASUMS256.txt digest $WANT_SHA != pinned $BUN_SHA256 (refusing to install)"
  GOT_SHA=$(sha256sum "$tmp/bun.zip" | awk '{ print $1 }')
  [ "$GOT_SHA" = "$BUN_SHA256" ] ||
    die "downloaded bun zip digest $GOT_SHA != pinned $BUN_SHA256 (refusing to install)"
  unzip -q "$tmp/bun.zip" -d "$tmp"
  install -m 0755 "$tmp/bun-linux-x64/bun" "$BUN_BIN"
  rm -rf "$tmp"
  log "bun zip verified against SHASUMS256.txt ($GOT_SHA)"
fi
"$BUN_BIN" --version

log "installing firecracker + jailer into /usr/local/bin"
install -m 0755 "$ART/firecracker" /usr/local/bin/firecracker
install -m 0755 "$ART/jailer" /usr/local/bin/jailer

log "checkout to $REPO"
rm -rf "$REPO"
mkdir -p "$REPO"
cp -a "$REPO_SRC/." "$REPO/"
chown -R "$VM_USER:$VM_USER" "$REPO"
log "bun install"
su -s /bin/bash "$VM_USER" -c "cd '$REPO' && '$BUN_BIN' install --frozen-lockfile"
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
# restricts them by default (Ubuntu 22.04 and Debian 12 do not have this knob).
# This is test-VM configuration only.
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 || true
  printf '%s\n' 'kernel.apparmor_restrict_unprivileged_userns=0' \
    >/etc/sysctl.d/99-rctf-vmtest-userns.conf
fi

# Debian 12's systemd-resolved answers LLMNR on all interfaces (TCP/UDP 5355),
# while the Ubuntu images do not. That unrelated listener would show up on the
# test VM's "public" interface in check 60, whose assertion is about the
# agent's DNAT (only published ports may be reachable). Disable LLMNR in the
# throwaway VM so the check stays strict; this is test-VM configuration only.
if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
  mkdir -p /etc/systemd/resolved.conf.d
  printf '%s\n' '[Resolve]' 'LLMNR=no' \
    >/etc/systemd/resolved.conf.d/99-rctf-vmtest-no-llmnr.conf
  systemctl restart systemd-resolved >/dev/null 2>&1 || true
fi

# Nested KVM exposes the CPU flag but the kvm module may not be loaded yet, so
# /dev/kvm can be missing on a distro that does not load it eagerly. Load it
# here (test VM only); the Firecracker/jailer checks need /dev/kvm.
if [ ! -e /dev/kvm ]; then
  modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || true
  [ -e /dev/kvm ] || log "WARNING: /dev/kvm is missing inside the VM; privileged checks will fail"
fi

touch /etc/rctf-vmtest-provisioned
log "base provisioning done"
