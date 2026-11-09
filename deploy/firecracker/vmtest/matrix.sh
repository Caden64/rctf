#!/usr/bin/env bash
#
# Run the real-root verification matrix sequentially: one throwaway VM per
# (VM_IMAGE, KERNEL, FC_VERSION) combination, each with its own run directory
# and ports so a failed run can never interfere with the next one.
#
# Usage:
#   ./matrix.sh                        # the four pinned combinations below
#   MATRIX="ubuntu-22.04:vmlinux-6.1.155:v1.17.0" ./matrix.sh
#   MATRIX_KEEP=1 ./matrix.sh          # keep every VM/DIR for debugging
#
# This is a convenience driver around ./run.sh (same prerequisites, /dev/kvm and
# the shared artifacts cache). Results are written to
#   $MATRIX_ROOT/matrix.tsv  and  $MATRIX_ROOT/matrix.md
# and the exit status is nonzero when any combination fails.
set -uo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
STAMP=$(date +%Y%m%d-%H%M%S)
MATRIX_ROOT=${MATRIX_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-vmtest/matrix-$STAMP-$$}
MATRIX=${MATRIX:-"
ubuntu-24.04:vmlinux-6.1.155:v1.17.0
debian-12:vmlinux-6.1.155:v1.17.0
ubuntu-24.04:vmlinux-6.1.188:v1.17.0
ubuntu-24.04:vmlinux-6.1.155:v1.16.0
"}
# Base cloud images are shared by every combination; run directories are not.
export VM_IMAGE_DIR=${VM_IMAGE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-vmtest}
mkdir -p "$MATRIX_ROOT"
TSV=$MATRIX_ROOT/matrix.tsv
MD=$MATRIX_ROOT/matrix.md
printf 'index\timage\tkernel\tfirecracker\texit\tsystemd\tguest_kernel\tverdict\n' >"$TSV"

log() { printf '%s\n' "$*" | tee -a "$MATRIX_ROOT/matrix.log"; }

# Find a pair of free 127.0.0.1 ports starting at <base>, without claiming them
# (run.sh binds them soon after). Sequential runs make a race unlikely; a lost
# race is a safe, loud boot failure, never a signal to another run's VM.
free_ports() { # free_ports <base>
  python3 - "$1" <<'PY'
import socket, sys
base = int(sys.argv[1])
def free(p):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p))
        return True
    except OSError:
        return False
    finally:
        s.close()
p = base
while p < base + 400:
    if free(p) and free(p + 3800):
        print(p, p + 3800)
        sys.exit(0)
    p += 1
sys.exit(1)
PY
}

FAILED=0
INDEX=0
while IFS= read -r combo; do
  [ -n "$combo" ] || continue
  INDEX=$((INDEX + 1))
  image=${combo%%:*}
  rest=${combo#*:}
  kernel=${rest%%:*}
  fc=${rest#*:}
  slug=$(printf '%s' "$image-$kernel-$fc" | tr -c 'A-Za-z0-9._-' '-')
  run_root=$MATRIX_ROOT/$slug

  ports=$(free_ports $((2400 + INDEX * 20))) || {
    log "FAIL $combo: no free port pair"
    FAILED=$((FAILED + 1))
    continue
  }
  ssh_port=${ports%% *}
  seed_port=${ports##* }

  log ""
  log "=================================================================="
  log "MATRIX $INDEX: image=$image kernel=$kernel firecracker=$fc (ssh $ssh_port, seed $seed_port)"
  log "=================================================================="
  set +e
  # </dev/null: run.sh's ssh calls would otherwise consume the remaining
  # combinations from this loop's stdin.
  VM_ROOT=$run_root VM_IMAGE=$image KERNEL=$kernel FC_VERSION=$fc \
    VM_SSH_PORT=$ssh_port VM_SEED_PORT=$seed_port \
    KEEP_VM=${MATRIX_KEEP:-0} \
    "$HERE/run.sh" </dev/null
  rc=$?
  set +e
  logfile=$(find "$run_root/logs" -maxdepth 1 -name 'run-*.log' -print 2>/dev/null | sort | tail -1)
  systemd=$(grep -oE 'VM versions: systemd=[^ ]*' "$logfile" 2>/dev/null | head -1 | cut -d= -f2)
  guest_kernel=$(grep -oE 'kernel=[^ ]*' "$logfile" 2>/dev/null | head -1 | cut -d= -f2)
  if [ "$rc" -eq 0 ]; then
    verdict=PASS
  else
    verdict=FAIL
    FAILED=$((FAILED + 1))
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$INDEX" "$image" "$kernel" "$fc" "$rc" "${systemd:-?}" "${guest_kernel:-?}" "$verdict" >>"$TSV"
  log "MATRIX $INDEX: $verdict (exit $rc, systemd ${systemd:-?}, kernel ${guest_kernel:-?})"
done <<EOF
$MATRIX
EOF

{
  printf '# vmtest matrix %s\n\n' "$STAMP"
  printf '| # | VM image | Guest kernel | Firecracker | systemd | Exit | Verdict |\n'
  printf '| - | -------- | ------------ | ----------- | ------- | ---- | ------- |\n'
  tail -n +2 "$TSV" | while IFS=$'\t' read -r i image kernel fc rc systemd guest_kernel verdict; do
    printf '| %s | %s | %s | %s | %s | %s | **%s** |\n' \
      "$i" "$image" "$kernel" "$fc" "${systemd:-?}" "$rc" "$verdict"
  done
} >"$MD"

log ""
log "matrix results: $TSV"
log "matrix summary: $MD"
cat "$MD"
[ "$FAILED" -eq 0 ]
