#!/bin/bash
# Runs INSIDE `unshare -Urn` (started by run.sh): a private user+network
# namespace. The tap devices, nftables tables and Firecracker microVMs created
# here are real, but they are invisible to the host and cannot reach its
# network. Only PIDs the harness started are ever killed, and only after a
# same-uid + known-binary + run-dir check. Never `pkill` by name: other workers
# share the PID namespace.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
RUN=${RUN:?run via run.sh}
export PATH="$HOME/.local/bin:$PATH"
export NO_PROXY='*'
export no_proxy='*'
export LOG_LEVEL=${LOG_LEVEL:-info}

mkdir -p "$RUN/logs" "$RUN/pids" "$RUN/agent/state" "$RUN/agent/run" "$RUN/agent/jailer" "$RUN/agent/traefik" "$RUN/controller"

ip link set lo up
ip link add dummy0 type dummy 2>/dev/null || true
ip link set dummy0 up
sysctl -qw net.ipv4.ip_forward=1 2>/dev/null || echo "(warning: ip_forward not writable)"

cleanup() {
  local rc=$?
  trap - EXIT INT TERM

  # A PID is ours only if it runs as us, its argv[0] is one of the binaries the
  # harness starts (bun for agent/controller, the smoke firecracker binary), and
  # its argv references this run's unique directory. This deliberately does not
  # match the `tee` copy of driver output, which also carries the run dir.
  local run_uid bun_bin fc_bin
  run_uid=$(id -u)
  bun_bin=$(readlink -f "$(command -v bun 2>/dev/null || true)" 2>/dev/null || true)
  fc_bin=$(readlink -f "${SMOKE_ARTIFACTS:-}/firecracker" 2>/dev/null || true)

  is_our_pid() {
    local pid=$1
    [ -n "$pid" ] || return 1
    [ "$pid" = "$$" ] && return 1
    [ "$pid" = "$PPID" ] && return 1
    [ -r "/proc/$pid/cmdline" ] || return 1
    [ "$(stat -c %u "/proc/$pid" 2>/dev/null || echo x)" = "$run_uid" ] || return 1
    local argv0
    argv0=$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | head -n 1)
    [ -n "$argv0" ] || return 1
    case "$argv0" in
      "$bun_bin" | "$fc_bin") ;;
      *)
        # process.execPath / resolved paths can differ by symlink; accept only
        # the known binary basenames, still with the run-dir and uid checks.
        case "$(basename -- "$argv0")" in
          bun | bun.exe | firecracker) ;;
          *) return 1 ;;
        esac
        ;;
    esac
    tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -Fq -- "$RUN" || return 1
    return 0
  }

  # Candidate PIDs: the ones the driver recorded, Firecracker PIDs persisted in
  # agent state, and a same-uid /proc scan for anything else that still matches.
  local candidates="" pid
  for f in "$RUN"/pids/*.pid; do
    [ -f "$f" ] || continue
    read -r pid < "$f" || continue
    candidates="$candidates $pid"
  done
  if command -v jq >/dev/null 2>&1; then
    for f in "$RUN"/agent/state/*.json; do
      [ -f "$f" ] || continue
      pid=$(jq -r '.vm.pid // empty' "$f" 2>/dev/null || true)
      [ -n "$pid" ] && candidates="$candidates $pid"
    done
  fi
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    if is_our_pid "$pid"; then candidates="$candidates $pid"; fi
  done

  local killed=""
  for pid in $(printf '%s\n' $candidates | sort -u); do
    if is_our_pid "$pid"; then
      kill -9 "$pid" 2>/dev/null && killed="$killed $pid"
    fi
  done
  if [ -n "$killed" ]; then
    echo "killed harness pids:$killed"
  fi
  sleep 0.2
  echo
  echo "== namespace leftovers"
  local left=""
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    if is_our_pid "$pid"; then left="$left $pid"; fi
  done
  left=$(echo $left)
  if [ -n "$left" ]; then
    echo "LEFTOVER PROCESSES:$left"
    # shellcheck disable=SC2086
    ps -o pid=,args= -p $left 2>/dev/null || true
  else
    echo "processes: none"
  fi
  echo "taps: $(ip -o link show type tun 2>/dev/null | wc -l)"
  ip -o link show type tun 2>/dev/null || true
  echo "nft tables: $(nft list tables 2>/dev/null | wc -l)"
  nft list tables 2>/dev/null || true
  echo "run dir kept for inspection: $RUN"
  exit "$rc"
}
trap cleanup EXIT INT TERM

cd "$REPO"
set -o pipefail
timeout "${E2E_INNER_TIMEOUT:-840}" bun deploy/firecracker/e2e/driver.ts 2>&1 \
  | tee -a "$RUN/driver-output.log"
rc=${PIPESTATUS[0]}
echo "driver exit code: $rc"
exit "$rc"
