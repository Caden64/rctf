#!/bin/bash
# Fail-closed absence probes and verified process cleanup for the smoke
# harness. Sourced by inner.sh and selftest.sh.
#
# Every helper here distinguishes "the command ran and found nothing" from
# "the command failed": a missing file, an unreadable path, a non-zero `ip`,
# `nft` or `grep` status is never read as "absent". selftest.sh mutates each
# helper with a broken command and requires it to fail.

# capture ARGV... -> CMD_OUT (stdout+stderr), CMD_RC
capture() {
  CMD_OUT=$("$@" 2>&1)
  CMD_RC=$?
}

# flag_scan NEEDLE PATH... -> 0 absent, 1 found, 2 inconclusive.
# Sets SCAN_DETAIL for the failure text.
flag_scan() {
  local needle=$1 p rc
  shift
  SCAN_DETAIL=
  for p in "$@"; do
    if [ ! -e "$p" ]; then
      SCAN_DETAIL="missing $p"
      return 2
    fi
    if [ ! -r "$p" ]; then
      SCAN_DETAIL="unreadable $p"
      return 2
    fi
    if [ -d "$p" ]; then
      grep -rqF -- "$needle" "$p"
      rc=$?
    else
      grep -qaF -- "$needle" "$p"
      rc=$?
    fi
    case $rc in
      0)
        SCAN_DETAIL="found in $p"
        return 1
        ;;
      1) ;;
      *)
        SCAN_DETAIL="grep failed in $p (exit $rc)"
        return 2
        ;;
    esac
  done
  return 0
}

# ip_no_link ERE -> 0 listing succeeded and nothing matched, 1 matched,
# 2 `ip` failed (inconclusive).
ip_no_link() {
  capture ip -o link show
  if [ "$CMD_RC" -ne 0 ]; then
    SCAN_DETAIL="ip -o link show failed (exit $CMD_RC): $CMD_OUT"
    return 2
  fi
  if printf '%s\n' "$CMD_OUT" | grep -qE -- "$1"; then
    SCAN_DETAIL="matching link present"
    return 1
  fi
  return 0
}

# nft_table_absent TABLE-ARGS... -> 0 absent, 1 present, 2 listing failed.
nft_table_absent() {
  capture nft list table "$@"
  case $CMD_RC in
    0)
      SCAN_DETAIL="table $* is present"
      return 1
      ;;
    1)
      case "$CMD_OUT" in
        *"No such file or directory"* | *"does not exist"*) return 0 ;;
        *)
          SCAN_DETAIL="nft list table $* failed (exit 1): $CMD_OUT"
          return 2
          ;;
      esac
      ;;
    *)
      SCAN_DETAIL="nft list table $* failed (exit $CMD_RC): $CMD_OUT"
      return 2
      ;;
  esac
}

# nft_lacks TOKEN TABLE-ARGS... -> 0 when the table is absent or present and
# does not contain TOKEN, 1 when it still contains it, 2 on any listing error.
nft_lacks() {
  local token=$1
  shift
  capture nft list table "$@"
  case $CMD_RC in
    0)
      if printf '%s\n' "$CMD_OUT" | grep -qF -- "$token"; then
        SCAN_DETAIL="table still references $token"
        return 1
      fi
      return 0
      ;;
    1)
      case "$CMD_OUT" in
        *"No such file or directory"* | *"does not exist"*) return 0 ;;
        *)
          SCAN_DETAIL="nft list table $* failed (exit 1): $CMD_OUT"
          return 2
          ;;
      esac
      ;;
    *)
      SCAN_DETAIL="nft list table $* failed (exit $CMD_RC): $CMD_OUT"
      return 2
      ;;
  esac
}

# --- verified process identity ---------------------------------------------
# `unshare -Urn` shares the host PID namespace, so nothing here kills by name.
# A signal is sent only when the recorded start ticks, executable and an argv
# marker unique to this run still match.
proc_start_ticks() {
  local stat
  [ -r "/proc/$1/stat" ] || return 1
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  [ -n "$stat" ] || return 1
  printf '%s' "${stat#*) }" | awk '{print $20}'
}

proc_ppid() {
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  printf '%s' "${stat#*) }" | awk '{print $2}'
}

proc_cmdline() {
  tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null || true
}

proc_exe_basename() {
  local exe
  exe=$(readlink "/proc/$1/exe" 2>/dev/null) || return 1
  printf '%s\n' "${exe##*/}"
}

proc_identity_matches() { # pid ticks
  [ -n "$1" ] && [ -n "$2" ] || return 1
  [ -d "/proc/$1" ] || return 1
  [ "$(proc_start_ticks "$1" 2>/dev/null)" = "$2" ]
}

kill_verified() { # pid ticks exe-basename argv-marker
  local pid=$1 ticks=$2 exe=$3 marker=$4 i
  [ -n "$pid" ] || return 0
  [ -d "/proc/$pid" ] || return 0
  [ "$(proc_start_ticks "$pid" 2>/dev/null)" = "$ticks" ] || return 0
  [ "$(proc_exe_basename "$pid" 2>/dev/null)" = "$exe" ] || return 0
  proc_cmdline "$pid" | grep -qF -- "$marker" || return 0
  kill "$pid" 2>/dev/null || true
  for i in $(seq 1 40); do
    [ -d "/proc/$pid" ] || {
      wait "$pid" 2>/dev/null || true
      return 0
    }
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return 0
}

kill_child() { # pid
  local pid=$1 i
  [ -n "$pid" ] || return 0
  [ -d "/proc/$pid" ] || return 0
  [ "$(proc_ppid "$pid" 2>/dev/null)" = "$$" ] || {
    wait "$pid" 2>/dev/null || true
    return 0
  }
  kill "$pid" 2>/dev/null || true
  for i in $(seq 1 40); do
    [ -d "/proc/$pid" ] || {
      wait "$pid" 2>/dev/null || true
      return 0
    }
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return 0
}

# Read a nested field from an agent state JSON file (python3 is required by
# run.sh). Prints nothing and exits non-zero when the file/field is missing.
state_field() { # file dotted.path
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        cur = json.load(fh)
except Exception:
    sys.exit(1)
for key in sys.argv[2].split('.'):
    if not isinstance(cur, dict) or key not in cur:
        sys.exit(1)
    cur = cur[key]
print(cur)
PY
}

# True when the instance's recorded VM handle still matches the live process:
# start ticks + firecracker executable + this run directory in argv.
vm_alive() { # instance-id -> 0 alive, sets VM_PID/VM_TICKS
  local f=$RUN/state/$1.json pid ticks
  VM_PID=
  VM_TICKS=
  [ -r "$f" ] || return 1
  pid=$(state_field "$f" vm.pid 2>/dev/null) || return 1
  ticks=$(state_field "$f" vm.pidStartTicks 2>/dev/null) || return 1
  [ "$(proc_start_ticks "$pid" 2>/dev/null)" = "$ticks" ] || return 1
  [ "$(proc_exe_basename "$pid" 2>/dev/null)" = firecracker ] || return 1
  proc_cmdline "$pid" | grep -qF -- "$RUN" || return 1
  VM_PID=$pid
  VM_TICKS=$ticks
}

# Reap every Firecracker process of this run: recorded handles first, then a
# /proc sweep restricted to firecracker executables whose argv contains RUN.
reap_vms() { # state-dir run-marker
  local f pid ticks p
  for f in "$1"/*.json; do
    [ -e "$f" ] || continue
    pid=$(state_field "$f" vm.pid 2>/dev/null) || continue
    ticks=$(state_field "$f" vm.pidStartTicks 2>/dev/null) || continue
    kill_verified "$pid" "$ticks" firecracker "$2"
  done
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    [ "$(proc_exe_basename "$pid" 2>/dev/null)" = firecracker ] || continue
    proc_cmdline "$pid" | grep -qF -- "$2" || continue
    ticks=$(proc_start_ticks "$pid" 2>/dev/null) || continue
    kill_verified "$pid" "$ticks" firecracker "$2"
  done
}
