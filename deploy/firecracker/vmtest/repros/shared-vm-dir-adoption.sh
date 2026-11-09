#!/usr/bin/env bash
#
# Repro (harness defect): a second run with the same VM_DIR used to adopt an
# authenticated, already-running VM and then stop it from its own cleanup trap.
# The fix gives every run an owner token; boot refuses to adopt a VM whose
# token differs unless FORCE_ADOPT_VM=1.
#
# This starts one real throwaway VM (unprivileged QEMU, KVM) and then performs
# the second-run attempt. Run on the host:
#   bash repros/shared-vm-dir-adoption.sh
# Nothing privileged runs on the host; everything root happens inside the VM.
set -uo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
VM_DIR=${VM_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/rctf-adoption-repro.XXXXXX")}
export VM_DIR
export VM_IMAGE_DIR=${VM_IMAGE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-vmtest}

read -r VM_SSH_PORT VM_SEED_PORT < <(python3 - <<'PY'
import socket
def free(p):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); return True
    finally:
        s.close()
for base in range(2600, 64000, 20):
    if free(base) and free(base + 4000):
        print(base, base + 4000); break
PY
)
export VM_SSH_PORT VM_SEED_PORT
[ -n "${VM_SSH_PORT:-}" ] || { echo "no free port pair" >&2; exit 2; }

say() { printf '==> %s\n' "$*"; }
fail=0
cleanup() {
  local token
  token=$(cat "$VM_DIR/owner-token" 2>/dev/null || true)
  if [ -n "$token" ]; then
    VM_RUN_TOKEN=$token "$HERE/../vm.sh" stop >/dev/null 2>&1 || true
  fi
  rm -rf "$VM_DIR"
}
trap cleanup EXIT

say "run A: booting a VM with its own token"
if ! VM_RUN_TOKEN=repro-run-a "$HERE/../vm.sh" create >"$VM_DIR/create.log" 2>&1; then
  echo "run A failed to boot:" >&2
  tail -20 "$VM_DIR/create.log" >&2
  exit 2
fi
VM_RUN_TOKEN=repro-run-a "$HERE/../vm.sh" status

say "run B: same VM_DIR, different token (must be refused)"
rc=0
VM_RUN_TOKEN=repro-run-b "$HERE/../vm.sh" create >/dev/null 2>&1 || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "  PASS: run B refused to adopt run A's VM (exit $rc)"
else
  echo "  FAIL: run B adopted run A's VM"
  fail=$((fail + 1))
fi
if VM_RUN_TOKEN=repro-run-a "$HERE/../vm.sh" status >/dev/null 2>&1; then
  echo "  PASS: run A's VM is still running after the refused adoption"
else
  echo "  FAIL: run A's VM is gone after the refused adoption"
  fail=$((fail + 1))
fi

say "run B: explicit FORCE_ADOPT_VM=1"
if FORCE_ADOPT_VM=1 VM_RUN_TOKEN=repro-run-b "$HERE/../vm.sh" create >/dev/null 2>&1; then
  echo "  PASS: FORCE_ADOPT_VM=1 takes ownership explicitly"
else
  echo "  FAIL: FORCE_ADOPT_VM=1 could not adopt the VM"
  fail=$((fail + 1))
fi
VM_RUN_TOKEN=repro-run-b "$HERE/../vm.sh" stop >/dev/null 2>&1 || true
if VM_RUN_TOKEN=repro-run-b "$HERE/../vm.sh" status >/dev/null 2>&1; then
  echo "  FAIL: the adopted VM did not stop"
  fail=$((fail + 1))
else
  echo "  PASS: the run that adopted the VM stopped only that VM"
fi

printf 'RESULT: adoption repro %s (%d failure(s))\n' \
  "$([ "$fail" -eq 0 ] && echo PASS || echo FAIL)" "$fail"
[ "$fail" -eq 0 ]
