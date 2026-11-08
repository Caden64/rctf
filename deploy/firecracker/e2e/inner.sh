#!/bin/bash
# Runs INSIDE `unshare -Urn` (started by run.sh): a private user+network
# namespace. The tap devices, nftables tables and Firecracker microVMs created
# here are real, but they are invisible to the host and cannot reach its
# network. Only PIDs whose argv references our unique run dir are ever killed.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
RUN=${RUN:?run via run.sh}
export PATH="$HOME/.local/bin:$PATH"
export NO_PROXY='*'
export no_proxy='*'
export LOG_LEVEL=${LOG_LEVEL:-info}

mkdir -p "$RUN/logs" "$RUN/agent/state" "$RUN/agent/run" "$RUN/agent/jailer" "$RUN/agent/traefik" "$RUN/controller"

ip link set lo up
ip link add dummy0 type dummy 2>/dev/null || true
ip link set dummy0 up
sysctl -qw net.ipv4.ip_forward=1 2>/dev/null || echo "(warning: ip_forward not writable)"

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  # Kill only processes whose full argv contains our unique run dir. This
  # covers the agent, the controller and any detached Firecracker process
  # (whose argv includes $RUN/agent/run/<id>). Never a pkill by name: other
  # workers share the PID namespace and their own network namespaces.
  local pids
  pids=$(pgrep -f -- "$RUN" 2>/dev/null || true)
  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 0.2
  echo
  echo "== namespace leftovers"
  local left
  left=$(pgrep -f -- "$RUN" 2>/dev/null || true)
  if [ -n "$left" ]; then
    echo "LEFTOVER PROCESSES: $left"
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
