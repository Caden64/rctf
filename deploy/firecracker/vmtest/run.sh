#!/usr/bin/env bash
#
# End-to-end driver: boot the throwaway VM, provision it, run every check, and
# tear the VM down. Runs unprivileged on the developer machine; all privileged
# operations happen inside the VM.
#
# Usage:
#   ./run.sh                 # full run
#   KEEP_VM=1 ./run.sh       # leave this run's VM running for debugging
#   ONLY=20-jailer-instance.sh ./run.sh   # one check
#
#   VM_IMAGE=debian-12 ./run.sh
#   VM_IMAGE=ubuntu-22.04 ./run.sh
#   KERNEL=vmlinux-6.1.188 ./run.sh
#   FC_VERSION=v1.16.0 ./run.sh
#
# Every run gets its own VM_DIR by default (under
# $VM_ROOT/runs/run-<stamp>-<pid>.XXXXXX) while the verified base cloud image is
# shared in $VM_IMAGE_DIR, so two runs cannot stop each other's VM. A run
# refuses to adopt an authenticated VM that it did not start; set
# FORCE_ADOPT_VM=1 to override that explicitly (debugging only). Set VM_DIR to
# use a fixed directory (then concurrent runs sharing it are refused), and
# VM_SSH_PORT/VM_SEED_PORT to give concurrent runs distinct ports.
#
# Requirements: qemu-system-x86_64, qemu-img, ssh, curl, python3, tar, /dev/kvm,
# and the shared artifacts produced by deploy/firecracker/smoke/fetch-artifacts.sh
# (downloaded automatically, with a lock, when missing).
set -uo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
REPO=$(cd -- "$HERE/../../.." && pwd)
CACHE=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
VM_ROOT=${VM_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-vmtest}
export VM_IMAGE_DIR=${VM_IMAGE_DIR:-$VM_ROOT}
export VM_IMAGE=${VM_IMAGE:-ubuntu-24.04}
export FC_VERSION=${FC_VERSION:-v1.17.0}
export KERNEL=${KERNEL:-vmlinux-6.1.155}
export VM_SSH_PORT=${VM_SSH_PORT:-2422}
export VM_SEED_PORT=${VM_SEED_PORT:-8201}
export VM_MEM=${VM_MEM:-4096}
export VM_SMP=${VM_SMP:-4}
STAMP=$(date +%Y%m%d-%H%M%S)
LOGDIR=$VM_ROOT/logs
LOG=$LOGDIR/run-$STAMP-$$.log
mkdir -p "$LOGDIR"

# Per-run scratch space: /tmp is shared with other harness copies on the same
# host, so never use fixed paths for the repo/artifact tarballs or check logs.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/fc-vmtest-run.XXXXXX")
CHECK_LOGS=$WORK/check-logs

# A per-run identity. vm.sh records it in the VM directory; cleanup stops only
# a VM carrying this token, and vm.sh refuses to adopt someone else's VM.
VM_RUN_TOKEN=run-$STAMP-$$-$RANDOM$RANDOM
export VM_RUN_TOKEN
VM_DIR_OWNED=0

say() { printf '%s\n' "$*" | tee -a "$LOG" >&2; }
vm_ssh() { "$HERE/vm.sh" ssh "$@"; }

fc_binary() { printf '%s/firecracker-%s\n' "$CACHE" "$FC_VERSION"; }
fc_jailer() {
  printf '%s/dl/fc-extract/release-%s-x86_64/jailer-%s-x86_64\n' \
    "$CACHE" "$FC_VERSION" "$FC_VERSION"
}
kernel_file() {
  printf '%s/images/smoke/kernels/%s\n' "$CACHE" "$KERNEL"
}

ensure_artifacts() {
  local fc jailer kernel rootfs
  fc=$(fc_binary)
  jailer=$(fc_jailer)
  kernel=$(kernel_file)
  rootfs=$CACHE/images/smoke/rootfs.ext4
  if [ -x "$fc" ] && [ -x "$jailer" ] && [ -f "$kernel" ] && [ -f "$rootfs" ] &&
    [ -x "$CACHE/dl/rootdir/bin/busybox" ] && [ -x "$CACHE/dl/jq" ]; then
    return 0
  fi
  say "==> shared Firecracker artifacts missing ($FC_VERSION, $KERNEL); fetching (the fetcher serialises on its own cache lock)"
  mkdir -p "$CACHE"
  FC_VERSION="$FC_VERSION" KERNEL="$KERNEL" \
    "$REPO/deploy/firecracker/smoke/fetch-artifacts.sh" || return 1
}

# Stop only a VM this run started, then remove this run's private VM directory
# (the shared base image lives in $VM_IMAGE_DIR). Runs on EXIT only after the
# prerequisite checks below have passed.
cleanup() {
  local rc=$? stop_rc=0 status_rc=0 owned=0 stopped=0
  if [ -n "${VM_DIR:-}" ] && [ -f "$VM_DIR/owner-token" ] &&
    [ "$(cat "$VM_DIR/owner-token" 2>/dev/null || true)" = "$VM_RUN_TOKEN" ]; then
    owned=1
  fi
  if [ "$owned" = 1 ]; then
    if [ "${KEEP_VM:-0}" != 1 ]; then
      say "==> stopping VM"
      "$HERE/vm.sh" stop >>"$LOG" 2>&1 || stop_rc=$?
      "$HERE/vm.sh" status >>"$LOG" 2>&1 || status_rc=$?
      case "$status_rc" in
        0) say "WARNING: VM is still running after stop; keeping $VM_DIR" ;;
        1)
          stopped=1
          if [ "$stop_rc" -eq 0 ]; then
            say "VM stopped; nothing left running."
          else
            say "WARNING: VM stopped but the seed server/teardown reported rc=$stop_rc; keeping $VM_DIR"
            stopped=0
          fi
          ;;
        *)
          say "WARNING: VM state could not be observed after stop; keeping $VM_DIR"
          ;;
      esac
    else
      say "KEEP_VM=1: leaving this run's VM in $VM_DIR (ssh 127.0.0.1:$VM_SSH_PORT)"
    fi
  fi
  rm -rf "$WORK"
  # Remove this run's private directory only when no VM of ours can still be
  # using it. A foreign VM (owned=0) was never in a per-run directory, so an
  # empty one can go too; explicit VM_DIRs are never removed.
  if [ "$VM_DIR_OWNED" = 1 ] && [ "${KEEP_VM:-0}" != 1 ] &&
    { [ "$stopped" = 1 ] || [ "$owned" = 0 ]; }; then
    say "==> removing this run's VM directory $VM_DIR (base image is shared)"
    rm -rf "$VM_DIR"
  fi
  exit "$rc"
}

say "rCTF Firecracker vmtest - $(date -Is)"
say "repo:    $REPO"
say "image:   $VM_IMAGE"
say "kernel:  $KERNEL"
say "fc:      $FC_VERSION"

# ---------------------------------------------------------------------------
# Prerequisites. No cleanup trap before this block succeeds: a failed
# prerequisite must not touch any VM directory.
# ---------------------------------------------------------------------------
command -v qemu-system-x86_64 >/dev/null || { say "qemu-system-x86_64 is required"; exit 2; }
command -v python3 >/dev/null || { say "python3 is required"; exit 2; }
command -v curl >/dev/null || { say "curl is required"; exit 2; }
command -v tar >/dev/null || { say "tar is required"; exit 2; }
[ -r /dev/kvm ] && [ -w /dev/kvm ] || { say "/dev/kvm must be readable/writable"; exit 2; }

VM_USER=$("$HERE/vm.sh" user) || { say "could not resolve the ssh user for $VM_IMAGE"; exit 2; }
export VM_USER

ensure_artifacts || { say "could not obtain Firecracker artifacts"; exit 2; }

say "==> pidfile-authentication selftest (host, unprivileged)"
if ! "$HERE/vm.sh" selftest 2>&1 | tee -a "$LOG"; then
  say "pidfile-authentication selftest FAILED; refusing to boot"
  exit 2
fi

if [ -n "${VM_DIR:-}" ]; then
  say "vm dir:  $VM_DIR (explicit; this run must own any VM it finds there)"
else
  mkdir -p "$VM_ROOT/runs" || { say "could not create $VM_ROOT/runs"; exit 2; }
  VM_DIR=$(mktemp -d "$VM_ROOT/runs/run-$STAMP-$$.XXXXXX") ||
    { say "could not create a per-run VM directory under $VM_ROOT/runs"; exit 2; }
  VM_DIR_OWNED=1
  say "vm dir:  $VM_DIR (per-run)"
fi
export VM_DIR
mkdir -p "$CHECK_LOGS"
say "log:     $LOG"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "==> creating/booting VM"
if ! "$HERE/vm.sh" create >>"$LOG" 2>&1; then
  say "VM boot failed (see $LOG)"
  # A foreign VM was never adopted (vm.sh refuses before writing this run's
  # token), so cleanup will not touch it. A half-started VM of ours is stopped.
  exit 2
fi
"$HERE/vm.sh" status | tee -a "$LOG"

say "==> copying checkout and artifacts into the VM"
tar czf "$WORK/repo.tgz" -C "$REPO" \
  --exclude=.git --exclude=node_modules --exclude='deploy/firecracker/vmtest/checks/.cache' .
vm_ssh 'rm -rf /tmp/fc-vmtest-repo && mkdir -p /tmp/fc-vmtest-repo && tar xzf - -C /tmp/fc-vmtest-repo' \
  <"$WORK/repo.tgz" || { say "checkout copy failed"; exit 2; }
rm -f "$WORK/repo.tgz"

STAGE=$WORK/stage
rm -rf "$STAGE"
mkdir -p "$STAGE"
# Shared cache lock while snapshotting: a concurrent fetch-artifacts.sh run
# holds this lock exclusively and rebuilds fc-extract/rootdir in place.
: >>"$CACHE/.fetch.lock"
(
  flock -s 9
  cp "$(fc_binary)" "$STAGE/firecracker"
  cp "$(fc_jailer)" "$STAGE/jailer"
  cp "$(kernel_file)" "$STAGE/vmlinux"
  cp "$CACHE/images/smoke/rootfs.ext4" "$STAGE/rootfs-smoke.ext4"
  cp -a "$CACHE/dl/rootdir" "$STAGE/rootdir"
  cp "$CACHE/dl/jq" "$STAGE/jq"
) 9<"$CACHE/.fetch.lock" || { say "artifact staging failed"; exit 2; }
chmod 0755 "$STAGE/firecracker" "$STAGE/jailer" "$STAGE/jq"
tar czf "$WORK/artifacts.tgz" -C "$STAGE" .
vm_ssh 'rm -rf /tmp/fc-vmtest/artifacts && mkdir -p /tmp/fc-vmtest/artifacts && tar xzf - -C /tmp/fc-vmtest/artifacts' \
  <"$WORK/artifacts.tgz" || { say "artifact copy failed"; exit 2; }
rm -rf "$WORK/artifacts.tgz" "$STAGE"

say "==> provisioning the VM (packages, bun, checkout, guest image)"
if ! timeout 1800 "$HERE/vm.sh" ssh "sudo env REPO_SRC=/tmp/fc-vmtest-repo VM_USER=$VM_USER bash /tmp/fc-vmtest-repo/deploy/firecracker/vmtest/provision.sh" >>"$LOG" 2>&1; then
  say "provisioning failed (see $LOG)"
  tail -40 "$LOG" >&2
  exit 2
fi
say "provisioned."
# Record what this matrix cell actually ran: the host distro's systemd/nftables/
# conntrack and the VM's kernel. The matrix driver parses this line.
VERS=$(vm_ssh 'sudo bash -s' <<'EOS'
systemd=$(systemctl show -p Version --value 2>/dev/null || true)
printf 'systemd=%s kernel=%s nft=%s conntrack=%s\n' \
  "$systemd" "$(uname -r)" \
  "$(nft --version 2>/dev/null | awk '{print $2}')" \
  "$(conntrack --version 2>/dev/null | head -n1 | awk '{print $2}')"
EOS
) || VERS="unknown (probe failed)"
say "VM versions: $VERS"

CHECKS=()
if [ -n "${ONLY:-}" ]; then
  CHECKS=("$HERE/checks/$ONLY")
else
  while IFS= read -r f; do CHECKS+=("$f"); done < <(find "$HERE/checks" -maxdepth 1 -name '[0-9][0-9]-*.sh' | sort)
fi

FAILED=0
RESULTS=""
for f in "${CHECKS[@]}"; do
  name=$(basename "$f")
  say ""
  say "=================================================================="
  say "RUN $name"
  say "=================================================================="
  # Per-run check log: never a fixed /tmp path shared by concurrent runs.
  out=$CHECK_LOGS/$name.log
  set +e
  timeout 1200 "$HERE/vm.sh" ssh \
    "sudo env VM_IMAGE=$VM_IMAGE VM_USER=$VM_USER FC_VERSION=$FC_VERSION KERNEL=$KERNEL bash /opt/rctf-firecracker/deploy/firecracker/vmtest/checks/$name" \
    >"$out" 2>&1
  rc=$?
  set +e
  cat "$out" | tee -a "$LOG"
  summary=$(grep -E '^RESULT:' "$out" | tail -1)
  if [ "$rc" -eq 0 ]; then
    RESULTS="$RESULTS\nPASS  $name  ${summary:-}"
  else
    FAILED=$((FAILED + 1))
    RESULTS="$RESULTS\nFAIL  $name (exit $rc)  ${summary:-}"
  fi
  # Keep the network-test output next to the transcript.
  if [ "$name" = "40-net-tests.sh" ]; then
    for l in /tmp/vmtest-net-tests.log /tmp/vmtest-net-full.log /tmp/vmtest-net-ns.log; do
      say "--- $l (from the VM) ---"
      vm_ssh "cat $l 2>/dev/null" | tee -a "$LOG" || true
    done
  fi
done

say ""
say "=================================================================="
say "SUMMARY"
say "=================================================================="
say "matrix: image=$VM_IMAGE kernel=$KERNEL firecracker=$FC_VERSION"
printf '%b\n' "$RESULTS" | tee -a "$LOG"
say ""
if [ "$FAILED" -eq 0 ]; then
  say "ALL CHECKS PASSED"
else
  say "$FAILED check script(s) reported failures (see $LOG)"
fi
say "transcript: $LOG"
[ "$FAILED" -eq 0 ]
