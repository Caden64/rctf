#!/bin/bash
# Host driver for the xweb lab.
#
# Unprivileged. Boots its OWN throwaway vmtest VM (unique VM_DIR and ports,
# never the vmtest defaults), stages the two lab images, the shared
# Firecracker artifacts and the pinned Traefik publishing proxy, provisions
# the VM, and runs the real-stack checks (real agent in jailer mode, real
# Firecracker, real http/tcp exposes) inside it. All privileged operations
# happen inside that VM.
#
#   ./run.sh                 # build + full run, stop the VM afterwards
#   KEEP_VM=1 ./run.sh       # leave the VM running for debugging
#   ONLY_INNER=1 ./run.sh    # skip the build (reuse existing images)
#
# Own knobs (all optional):
#   XWEB_VM_DIR, XWEB_VM_SSH_PORT, XWEB_VM_SEED_PORT, XWEB_VM_MEM,
#   XWEB_VM_SMP, XWEB_VM_DISK, XWEB_CACHE, XWEB_IMAGES, XWEB_ARTIFACTS,
#   SMOKE_ARTIFACTS, XWEB_BASE_IMAGE
set -uo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
REPO=$(cd -- "$HERE/../../../.." && pwd)
VMTOOL=$REPO/deploy/firecracker/vmtest/vm.sh
CACHE=${XWEB_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-xweb}
IMAGES=${XWEB_IMAGES:-$CACHE/images}
SMOKE=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
FC_VERSION=v1.17.0

STAMP=$(date +%Y%m%d-%H%M%S)-$$
VM_DIR=${XWEB_VM_DIR:-$CACHE/vm/run-$STAMP}
export VM_DIR
export VM_MEM=${XWEB_VM_MEM:-3072}
export VM_SMP=${XWEB_VM_SMP:-4}
export VM_DISK=${XWEB_VM_DISK:-40G}
LOGDIR=$VM_DIR/logs
LOG=$LOGDIR/run-$STAMP.log
WORK=$(mktemp -d "${TMPDIR:-/tmp}/xweb-run.XXXXXX") ||
  { echo 'xweb: could not create a work directory' >&2; exit 2; }

say() { printf '%s\n' "$*" | tee -a "$LOG" >&2; }
die() {
  say "xweb: $*"
  exit 2
}
vm_ssh() { "$VMTOOL" ssh "$@"; }

pick_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
}

if [ -z "${XWEB_VM_SSH_PORT:-}" ]; then
  XWEB_VM_SSH_PORT=$(pick_port) || die 'could not pick a VM ssh port'
fi
if [ -z "${XWEB_VM_SEED_PORT:-}" ]; then
  XWEB_VM_SEED_PORT=$(pick_port) || die 'could not pick a seed port'
  while [ "$XWEB_VM_SEED_PORT" = "$XWEB_VM_SSH_PORT" ]; do
    XWEB_VM_SEED_PORT=$(pick_port)
  done
fi
export VM_SSH_PORT=$XWEB_VM_SSH_PORT
export VM_SEED_PORT=$XWEB_VM_SEED_PORT

mkdir -p "$LOGDIR" "$CACHE"

# Seed the VM's base image from a previously verified copy so a per-run
# VM_DIR does not force a 600 MiB download on every run. vm.sh re-hashes it
# against its pinned digest before boot and discards it on a mismatch.
seed_base_image() {
  [ -f "$VM_DIR/noble-base.img" ] && return 0
  local src
  for src in "${XWEB_BASE_IMAGE:-}" \
    "$CACHE/noble-base.img" \
    "${XDG_CACHE_HOME:-$HOME/.cache}/rctf-vmtest/noble-base.img" \
    "${XDG_CACHE_HOME:-$HOME/.cache}/rctf-sshole/noble-base.img"; do
    [ -n "$src" ] && [ -f "$src" ] || continue
    mkdir -p "$VM_DIR"
    ln "$src" "$VM_DIR/noble-base.img" 2>/dev/null ||
      cp --reflink=auto "$src" "$VM_DIR/noble-base.img" 2>/dev/null ||
      continue
    say "==> seeded the Ubuntu base image from $src (vm.sh re-verifies its digest)"
    return 0
  done
  return 0
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  if [ "${KEEP_VM:-0}" != 1 ]; then
    say '==> destroying the lab VM'
    "$VMTOOL" destroy >>"$LOG" 2>&1
    local drc=$?
    if [ "$drc" -ne 0 ]; then
      say "WARNING: vm.sh destroy returned $drc; keeping $VM_DIR (state may be unconfirmed)"
    else
      mkdir -p "$CACHE/logs"
      cp -f "$LOG" "$CACHE/logs/" 2>/dev/null || true
      rm -rf "$VM_DIR"
    fi
  else
    say "KEEP_VM=1: leaving the VM running (ssh 127.0.0.1:$VM_SSH_PORT, VM_DIR=$VM_DIR)"
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT INT TERM

say "xweb run $STAMP"
say "repo:    $REPO"
say "vm:      $VM_DIR (ssh 127.0.0.1:$VM_SSH_PORT, seed $VM_SEED_PORT)"
say "images:  $IMAGES"
say "log:     $LOG"

# --- prerequisites -----------------------------------------------------------
command -v qemu-system-x86_64 >/dev/null || die 'qemu-system-x86_64 is required'
command -v qemu-img >/dev/null || die 'qemu-img is required'
command -v python3 >/dev/null || die 'python3 is required'
command -v curl >/dev/null || die 'curl is required'
[ -r /dev/kvm ] && [ -w /dev/kvm ] || die '/dev/kvm must be readable/writable'
[ "$(uname -m)" = x86_64 ] || die 'this lab runs x86_64 guests only'

# --- images + shared artifacts ----------------------------------------------
if [ "${ONLY_INNER:-0}" = 1 ]; then
  [ -f "$IMAGES/xweb-vuln/rootfs.ext4" ] &&
    [ -f "$IMAGES/xweb-patched/rootfs.ext4" ] ||
    die "ONLY_INNER=1 but images are missing under $IMAGES"
  say '==> ONLY_INNER=1: reusing existing images'
else
  say '==> building the lab images (unprivileged, pinned + sha256-verified)'
  "$HERE/build.sh" >>"$LOG" 2>&1 || {
    tail -40 "$LOG" >&2
    die 'image build failed'
  }
fi

# The pinned Traefik that publishes the http exposes inside the VM.
"$HERE/fetch-artifacts.sh" >>"$LOG" 2>&1 || {
  tail -40 "$LOG" >&2
  die 'artifact fetch/verify failed'
}
TRAEFIK="$CACHE/dl/traefik-v3.7.15"
[ -x "$TRAEFIK" ] || die "traefik binary is missing: $TRAEFIK"

if [ ! -x "$SMOKE/firecracker" ] || [ ! -f "$SMOKE/images/smoke/rootfs.ext4" ] ||
  [ ! -x "$SMOKE/dl/rootdir/bin/busybox" ] || [ ! -x "$SMOKE/dl/jq" ] ||
  [ ! -x "$SMOKE/dl/fc-extract/release-$FC_VERSION-x86_64/jailer-$FC_VERSION-x86_64" ]; then
  say '==> shared Firecracker artifacts missing; fetching (the fetcher serialises on its own cache lock)'
  mkdir -p "$SMOKE"
  "$REPO/deploy/firecracker/smoke/fetch-artifacts.sh" >>"$LOG" 2>&1 ||
    die 'could not fetch the shared artifacts'
fi

# --- VM ----------------------------------------------------------------------
seed_base_image
say '==> creating/booting the lab VM (unique VM_DIR and ports)'
"$VMTOOL" create >>"$LOG" 2>&1 || {
  tail -40 "$LOG" >&2
  die 'VM boot failed'
}
"$VMTOOL" status | tee -a "$LOG"

# Publish the verified base image for future runs before the per-run VM_DIR is
# removed on teardown.
if [ ! -f "$CACHE/noble-base.img" ] && [ -f "$VM_DIR/noble-base.img" ]; then
  cp --reflink=auto "$VM_DIR/noble-base.img" "$CACHE/noble-base.img" 2>/dev/null ||
    say 'WARNING: could not cache the Ubuntu base image'
fi

say '==> copying the checkout and shared artifacts into the VM'
tar czf "$WORK/repo.tgz" -C "$REPO" \
  --exclude=.git --exclude=node_modules --exclude='deploy/firecracker/vmtest/checks/.cache' . ||
  die 'could not archive the checkout'
vm_ssh 'rm -rf /tmp/fc-vmtest-repo && mkdir -p /tmp/fc-vmtest-repo && tar xzf - -C /tmp/fc-vmtest-repo' \
  <"$WORK/repo.tgz" || die 'could not copy the checkout into the VM'
rm -f "$WORK/repo.tgz"

STAGE=$WORK/stage
rm -rf "$STAGE"
mkdir -p "$STAGE"
# Shared cache lock while snapshotting: a concurrent fetch-artifacts.sh run
# holds this lock exclusively and rebuilds fc-extract/rootdir in place.
: >>"$SMOKE/.fetch.lock"
(
  flock -s 9
  cp "$SMOKE/firecracker" "$STAGE/firecracker"
  cp "$SMOKE/dl/fc-extract/release-$FC_VERSION-x86_64/jailer-$FC_VERSION-x86_64" "$STAGE/jailer"
  cp -a "$SMOKE/dl/rootdir" "$STAGE/rootdir"
  cp "$SMOKE/dl/jq" "$STAGE/jq"
  cp "$TRAEFIK" "$STAGE/traefik"
) 9<"$SMOKE/.fetch.lock" || die 'artifact staging failed'
chmod 0755 "$STAGE/firecracker" "$STAGE/jailer" "$STAGE/jq" "$STAGE/traefik"
tar czf "$WORK/artifacts.tgz" -C "$STAGE" . || die 'could not archive the artifacts'
vm_ssh 'rm -rf /tmp/fc-vmtest/artifacts && mkdir -p /tmp/fc-vmtest/artifacts && tar xzf - -C /tmp/fc-vmtest/artifacts' \
  <"$WORK/artifacts.tgz" || die 'could not copy the artifacts into the VM'
rm -rf "$WORK/artifacts.tgz" "$STAGE"

say '==> provisioning the VM (packages, bun, checkout, firecracker)'
if ! timeout 1800 "$VMTOOL" ssh 'sudo REPO_SRC=/tmp/fc-vmtest-repo bash /tmp/fc-vmtest-repo/deploy/firecracker/vmtest/provision.sh' >>"$LOG" 2>&1; then
  say 'provisioning failed (see log)'
  tail -40 "$LOG" >&2
  exit 2
fi
say 'provisioned.'

# --- register the lab images ------------------------------------------------
say '==> staging the two lab images into the agent imagesDir'
# Only the image directories go into the agent imagesDir; the manifest stays
# at the documented cache path.
tar czf "$WORK/lab-images.tgz" -C "$IMAGES" xweb-vuln xweb-patched ||
  die 'could not archive the lab images'
vm_ssh 'rm -rf /tmp/fc-xweb && mkdir -p /tmp/fc-xweb/images && tar xzf - -C /tmp/fc-xweb/images' \
  <"$WORK/lab-images.tgz" || die 'could not copy the lab images into the VM'
rm -f "$WORK/lab-images.tgz"
vm_ssh "sudo sh -c '
  install -d -m 0755 /var/lib/rctf-firecracker/images
  rm -rf /var/lib/rctf-firecracker/images/xweb-vuln \
         /var/lib/rctf-firecracker/images/xweb-patched
  cp -a /tmp/fc-xweb/images/. /var/lib/rctf-firecracker/images/
  chown -R root:root /var/lib/rctf-firecracker/images
  find /var/lib/rctf-firecracker/images -type d -exec chmod 0755 {} +
  find /var/lib/rctf-firecracker/images -type f -exec chmod 0644 {} +
'" || die 'could not register the lab images'

say '==> running the real-stack checks inside the VM'
checked=0
timeout 2700 "$VMTOOL" ssh 'sudo bash /opt/rctf-firecracker/deploy/firecracker/labs/xweb/inner.sh' 2>&1 |
  tee -a "$LOG"
checked=${PIPESTATUS[0]}
say ''
if [ "$checked" -eq 0 ]; then
  say 'XWEB RESULT: PASS'
else
  say "XWEB RESULT: FAIL (inner.sh exit $checked)"
fi
say "transcript: $LOG"
[ "$checked" -eq 0 ]
