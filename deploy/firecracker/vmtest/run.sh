#!/usr/bin/env bash
#
# End-to-end driver: boot the throwaway VM, provision it, run every check, and
# tear the VM down. Runs unprivileged on the developer machine; all privileged
# operations happen inside the VM.
#
# Usage:
#   ./run.sh                 # full run
#   KEEP_VM=1 ./run.sh       # leave the VM running for debugging
#   ONLY=20-jailer-instance.sh ./run.sh   # one check (VM already provisioned?)
#
# Requirements: qemu-system-x86_64, qemu-img, ssh, curl, python3, tar, /dev/kvm,
# and the shared artifacts produced by deploy/firecracker/smoke/fetch-artifacts.sh
# (downloaded automatically, with a lock, when missing).
set -uo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
REPO=$(cd -- "$HERE/../../.." && pwd)
CACHE=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
export VM_DIR=${VM_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-vmtest}
export VM_SSH_PORT=${VM_SSH_PORT:-2222}
export VM_SEED_PORT=${VM_SEED_PORT:-8001}
export VM_MEM=${VM_MEM:-4096}
export VM_SMP=${VM_SMP:-4}
STAMP=$(date +%Y%m%d-%H%M%S)
LOGDIR=$VM_DIR/logs
LOG=$LOGDIR/run-$STAMP.log
mkdir -p "$LOGDIR"

say() { printf '%s\n' "$*" | tee -a "$LOG" >&2; }
vm_ssh() { "$HERE/vm.sh" ssh "$@"; }

cleanup() {
  local rc=$?
  if [ "${KEEP_VM:-0}" != 1 ]; then
    say "==> stopping VM"
    "$HERE/vm.sh" stop >>"$LOG" 2>&1 || true
    if "$HERE/vm.sh" status >>"$LOG" 2>&1; then
      say "WARNING: VM is still running after stop"
    else
      say "VM stopped; nothing left running."
    fi
  else
    say "KEEP_VM=1: leaving the VM running at 127.0.0.1:$VM_SSH_PORT"
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

ensure_artifacts() {
  local fc=$CACHE/dl/fc-extract/release-v1.17.0-x86_64
  if [ -x "$CACHE/firecracker" ] && [ -f "$CACHE/images/smoke/rootfs.ext4" ] &&
    [ -x "$CACHE/dl/rootdir/bin/busybox" ] && [ -x "$CACHE/dl/jq" ] &&
    [ -x "$fc/jailer-v1.17.0-x86_64" ]; then
    return 0
  fi
  say "==> shared Firecracker artifacts missing; fetching (serialised with flock)"
  mkdir -p "$CACHE"
  command -v flock >/dev/null || { say "flock is required to serialise downloads"; return 1; }
  (
    flock 9
    "$REPO/deploy/firecracker/smoke/fetch-artifacts.sh"
  ) 9>"$CACHE/.fetch.lock" || return 1
}

say "rCTF Firecracker vmtest - $(date -Is)"
say "repo:    $REPO"
say "vm dir:  $VM_DIR"
say "log:     $LOG"

command -v qemu-system-x86_64 >/dev/null || { say "qemu-system-x86_64 is required"; exit 2; }
command -v python3 >/dev/null || { say "python3 is required"; exit 2; }
[ -r /dev/kvm ] && [ -w /dev/kvm ] || { say "/dev/kvm must be readable/writable"; exit 2; }

ensure_artifacts || { say "could not obtain Firecracker artifacts"; exit 2; }

say "==> creating/booting VM"
"$HERE/vm.sh" create >>"$LOG" 2>&1 || { say "VM boot failed (see $LOG)"; exit 2; }
"$HERE/vm.sh" status | tee -a "$LOG"

say "==> copying checkout and artifacts into the VM"
tar czf /tmp/fc-vmtest-repo.tgz -C "$REPO" \
  --exclude=.git --exclude=node_modules --exclude='deploy/firecracker/vmtest/checks/.cache' .
vm_ssh 'rm -rf /tmp/fc-vmtest-repo && mkdir -p /tmp/fc-vmtest-repo && tar xzf - -C /tmp/fc-vmtest-repo' \
  </tmp/fc-vmtest-repo.tgz || { say "checkout copy failed"; exit 2; }
rm -f /tmp/fc-vmtest-repo.tgz

STAGE=/tmp/fc-vmtest-stage
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$CACHE/firecracker" "$STAGE/firecracker"
cp "$CACHE/dl/fc-extract/release-v1.17.0-x86_64/jailer-v1.17.0-x86_64" "$STAGE/jailer"
cp "$CACHE/images/smoke/vmlinux" "$STAGE/vmlinux"
cp "$CACHE/images/smoke/rootfs.ext4" "$STAGE/rootfs-smoke.ext4"
cp -a "$CACHE/dl/rootdir" "$STAGE/rootdir"
cp "$CACHE/dl/jq" "$STAGE/jq"
chmod 0755 "$STAGE/firecracker" "$STAGE/jailer" "$STAGE/jq"
tar czf /tmp/fc-vmtest-artifacts.tgz -C "$STAGE" .
vm_ssh 'rm -rf /tmp/fc-vmtest/artifacts && mkdir -p /tmp/fc-vmtest/artifacts && tar xzf - -C /tmp/fc-vmtest/artifacts' \
  </tmp/fc-vmtest-artifacts.tgz || { say "artifact copy failed"; exit 2; }
rm -rf /tmp/fc-vmtest-artifacts.tgz "$STAGE"

say "==> provisioning the VM (packages, bun, checkout, guest image)"
if ! timeout 1800 "$HERE/vm.sh" ssh 'sudo REPO_SRC=/tmp/fc-vmtest-repo bash /tmp/fc-vmtest-repo/deploy/firecracker/vmtest/provision.sh' >>"$LOG" 2>&1; then
  say "provisioning failed (see $LOG)"
  tail -40 "$LOG" >&2
  exit 2
fi
say "provisioned."

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
  out=/tmp/vmtest-check-$name.log
  set +e
  timeout 1200 "$HERE/vm.sh" ssh "sudo bash /opt/rctf-firecracker/deploy/firecracker/vmtest/checks/$name" >"$out" 2>&1
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
printf '%b\n' "$RESULTS" | tee -a "$LOG"
say ""
if [ "$FAILED" -eq 0 ]; then
  say "ALL CHECKS PASSED"
else
  say "$FAILED check script(s) reported failures (see $LOG)"
fi
say "transcript: $LOG"
[ "$FAILED" -eq 0 ]
