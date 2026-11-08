#!/bin/bash
# Phase lifecycle (inside its own network namespace): 10 concurrent real leases
# through the real NetworkManager, publishes, DNAT conntrack, full teardown and
# the durable reuse quarantine.
set -u
: "${RUN:?}" "${EDGE:?}" "${REPO:?}"
PIDS=()
cleanup() {
  set +e
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
}
trap cleanup EXIT INT TERM

ip link set lo up
echo 1 >/proc/sys/net/ipv4/ip_forward 2>/dev/null || true

# "Outside" client netns on the external interface.
unshare -n sleep 600 & OUT_PID=$!
sleep 0.3
PIDS+=("$OUT_PID")
ip link add ext0 type veth peer name extp
ip addr add 203.0.113.1/24 dev ext0
ip link set ext0 up
ip link set extp netns "$OUT_PID"
nsenter -t "$OUT_PID" -n bash -c '
  ip link set extp name eth0
  ip addr add 203.0.113.2/24 dev eth0
  ip link set eth0 up
  ip link set lo up
  ip route add default via 203.0.113.1
'
mkdir -p "$RUN/lifecycle/traefik"
export RUN EDGE OUTSIDE_PID=$OUT_PID

cd "$REPO"
bun "$EDGE/lib/lifecycle.ts"
