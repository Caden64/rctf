#!/usr/bin/env bash
#
# Multi-host Firecracker end-to-end driver.
#
# Boots TWO named QEMU VMs (host-a, host-b), each a root VM with nested KVM
# running the shipped agent under systemd in JAILER mode, connects them through
# a private QEMU socket/multicast L2 (10.77.0.0/24), runs the real controller
# inside host-a, and executes deploy/firecracker/multihost/driver.ts from this
# (unprivileged) machine. Everything privileged happens inside the VMs.
#
# Usage:
#   ./run.sh                 # full run; stops and destroys both VMs on exit
#   KEEP_VM=1 ./run.sh       # leave both VMs running for debugging
#   ONLY=3 ./run.sh          # diagnostic only; the driver does not filter yet
#
# Requirements: /dev/kvm, qemu-system-x86_64, qemu-img, ssh, curl, python3,
# bun, tar, and the smoke artifacts from
# deploy/firecracker/smoke/fetch-artifacts.sh (never fetched here).
set -uo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
REPO=$(cd -- "$HERE/../../.." && pwd)
ARTIFACTS=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
STAMP=$(date +%Y%m%d-%H%M%S)

RUN_BASE=${MH_RUN_BASE:-/tmp/opencode}
mkdir -p "$RUN_BASE"
RUN=$(mktemp -d "$RUN_BASE/fcmh-XXXXXX")
VM_ROOT=$RUN/vms
LOG=$RUN/logs/run.log
LOGS=$RUN/logs
mkdir -p "$LOGS" "$VM_ROOT"
export MH_VM_ROOT=$VM_ROOT

say() { printf '%s\n' "$*" | tee -a "$LOG" >&2; }
die() {
  say "ERROR: $*"
  exit 2
}

# ---------------------------------------------------------------------------
# Unique ports (this host is shared with other unprivileged test workers).
# ---------------------------------------------------------------------------
free_tcp() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
}

A_SSH=$(free_tcp)
B_SSH=$(free_tcp)
A_SEED=$(free_tcp)
B_SEED=$(free_tcp)
CTRL_PORT=$(free_tcp)
MCAST_PORT=$(python3 - <<'PY'
import random, socket, sys
for _ in range(50):
    p = random.randint(40000, 60000)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.bind(('0.0.0.0', p))
    except OSError:
        continue
    finally:
        s.close()
    print(p)
    sys.exit(0)
raise SystemExit('no free udp port')
PY
)
MCAST_GROUP="239.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))"
MCAST="$MCAST_GROUP:$MCAST_PORT"
A_IP=10.77.0.10
B_IP=10.77.0.11

# ---------------------------------------------------------------------------
# Cleanup: always stop both QEMUs and the ssh tunnel; keep host-side logs.
# ---------------------------------------------------------------------------
TUNNEL_PID=
STOPPED=0
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  [ "$STOPPED" -eq 1 ] && exit "$rc"
  STOPPED=1
  if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [ "${KEEP_VM:-0}" = 1 ]; then
    say "KEEP_VM=1: leaving VMs running"
    say "  host-a: $HERE/vm.sh --name host-a --ssh-port $A_SSH --seed-port $A_SEED --priv-ip $A_IP --mcast $MCAST --mac-mgmt 52:54:00:77:0a:00 --mac-priv 52:54:00:77:0a:01 ssh"
    say "  host-b: $HERE/vm.sh --name host-b --ssh-port $B_SSH --seed-port $B_SEED --priv-ip $B_IP --mcast $MCAST --mac-mgmt 52:54:00:77:0b:00 --mac-priv 52:54:00:77:0b:01 ssh"
    say "  controller: http://127.0.0.1:$CTRL_PORT"
  else
    say "==> stopping VMs"
    "$HERE/vm.sh" --name host-a --ssh-port "$A_SSH" stop >>"$LOG" 2>&1 || true
    "$HERE/vm.sh" --name host-b --ssh-port "$B_SSH" stop >>"$LOG" 2>&1 || true
    for n in host-a host-b; do
      if "$HERE/vm.sh" --name "$n" status >>"$LOG" 2>&1; then
        say "WARNING: $n is still running after stop"
      fi
    done
    # Keep console logs for the record, then drop the overlays.
    for n in host-a host-b; do
      [ -f "$VM_ROOT/$n/console.log" ] && cp "$VM_ROOT/$n/console.log" "$LOGS/$n-console.log" || true
    done
    rm -f "$VM_ROOT"/*/overlay.qcow2
  fi
  say "run dir: $RUN"
  exit "$rc"
}
trap cleanup EXIT INT TERM

say "rCTF Firecracker multi-host test - $(date -Is)"
say "repo:      $REPO"
say "run dir:   $RUN"
say "host-a:    ssh 127.0.0.1:$A_SSH private $A_IP"
say "host-b:    ssh 127.0.0.1:$B_SSH private $B_IP"
say "mcast L2:  $MCAST"
say "controller forwarded on 127.0.0.1:$CTRL_PORT"

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
for tool in qemu-system-x86_64 qemu-img ssh curl python3 bun tar timeout flock; do
  command -v "$tool" >/dev/null || die "$tool is required"
done
[ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm must be readable/writable"
[ -x "$ARTIFACTS/firecracker" ] || die "missing $ARTIFACTS/firecracker"
[ -f "$ARTIFACTS/images/smoke/rootfs.ext4" ] || die "missing smoke rootfs"
[ -f "$ARTIFACTS/images/smoke/vmlinux" ] || die "missing smoke vmlinux"
[ -x "$ARTIFACTS/dl/fc-extract/release-v1.17.0-x86_64/jailer-v1.17.0-x86_64" ] ||
  die "missing jailer"
[ -x "$ARTIFACTS/dl/jq" ] || die "missing static jq"

# ---------------------------------------------------------------------------
# Per-run secrets (test-only). Never echoed; copied into the VMs.
# ---------------------------------------------------------------------------
SECRETS=$RUN/secrets.env
umask 077
python3 - "$SECRETS" <<'PY'
import secrets
import sys

names = [
    'MH_API_TOKEN',
    'MH_ADMIN_TOKEN',
    'MH_TEAM_KEY_SECRET',
    'MH_AGENT_TOKEN_A',
    'MH_AGENT_TOKEN_B',
]
with open(sys.argv[1], 'w') as f:
    for name in names:
        f.write(f'{name}={secrets.token_hex(24)}\n')
PY
chmod 600 "$SECRETS"
say "per-run secrets generated (not logged)"

# ---------------------------------------------------------------------------
# Copy repo + artifacts into both VMs (parallel) and provision (parallel).
# ---------------------------------------------------------------------------
STAGE=$RUN/stage
mkdir -p "$STAGE"
cp "$ARTIFACTS/firecracker" "$STAGE/firecracker"
cp "$ARTIFACTS/dl/fc-extract/release-v1.17.0-x86_64/jailer-v1.17.0-x86_64" "$STAGE/jailer"
cp "$ARTIFACTS/images/smoke/vmlinux" "$STAGE/vmlinux"
cp "$ARTIFACTS/images/smoke/rootfs.ext4" "$STAGE/rootfs-smoke.ext4"
cp "$(readlink -f "$(command -v bun)")" "$STAGE/bun"
chmod 0755 "$STAGE/firecracker" "$STAGE/jailer" "$STAGE/bun"
cp "$ARTIFACTS/dl/jq" "$STAGE/jq"
chmod 0755 "$STAGE/jq"

say "==> packing checkout and artifacts"
tar czf "$RUN/repo.tgz" -C "$REPO" --exclude=.git --exclude=node_modules . ||
  die "could not pack the checkout"
tar czf "$RUN/artifacts.tgz" -C "$STAGE" . || die "could not pack artifacts"

push_to_vm() { # push_to_vm <name> <ssh-port> <seed-port> <priv-ip> <mac-prefix>
  local name=$1 sshp=$2 seedp=$3 ip=$4 mac=$5
  "$HERE/vm.sh" --name "$name" --ssh-port "$sshp" --seed-port "$seedp" \
    --priv-ip "$ip" --mcast "$MCAST" \
    --mac-mgmt "52:54:00:77:${mac}:00" --mac-priv "52:54:00:77:${mac}:01" \
    ssh 'rm -rf /tmp/fc-mh /tmp/fc-mh-repo /tmp/fc-mh-artifacts && mkdir -p /tmp/fc-mh /tmp/fc-mh-repo /tmp/fc-mh-artifacts' \
    >>"$LOG" 2>&1 || return 1
  "$HERE/vm.sh" --name "$name" --ssh-port "$sshp" ssh 'tar xzf - -C /tmp/fc-mh-repo' \
    <"$RUN/repo.tgz" >>"$LOG" 2>&1 || return 1
  "$HERE/vm.sh" --name "$name" --ssh-port "$sshp" ssh 'tar xzf - -C /tmp/fc-mh-artifacts' \
    <"$RUN/artifacts.tgz" >>"$LOG" 2>&1 || return 1
  "$HERE/vm.sh" --name "$name" --ssh-port "$sshp" ssh 'cat > /tmp/fc-mh/secrets.env && chmod 600 /tmp/fc-mh/secrets.env' \
    <"$SECRETS" >>"$LOG" 2>&1 || return 1
}

say "==> booting host-a and host-b (parallel)"
"$HERE/vm.sh" --name host-a --ssh-port "$A_SSH" --seed-port "$A_SEED" \
  --priv-ip "$A_IP" --mcast "$MCAST" \
  --mac-mgmt 52:54:00:77:0a:00 --mac-priv 52:54:00:77:0a:01 \
  create >"$LOGS/vm-host-a.log" 2>&1 &
PID_A=$!
"$HERE/vm.sh" --name host-b --ssh-port "$B_SSH" --seed-port "$B_SEED" \
  --priv-ip "$B_IP" --mcast "$MCAST" \
  --mac-mgmt 52:54:00:77:0b:00 --mac-priv 52:54:00:77:0b:01 \
  create >"$LOGS/vm-host-b.log" 2>&1 &
PID_B=$!
wait "$PID_A" || {
  tail -30 "$LOGS/vm-host-a.log" >>"$LOG"
  die "host-a boot failed (see $LOGS/vm-host-a.log)"
}
wait "$PID_B" || {
  tail -30 "$LOGS/vm-host-b.log" >>"$LOG"
  die "host-b boot failed (see $LOGS/vm-host-b.log)"
}
say "both VMs booted"

say "==> copying checkout/artifacts into both VMs (parallel)"
push_to_vm host-a "$A_SSH" "$A_SEED" "$A_IP" 0a >"$LOGS/copy-host-a.log" 2>&1 &
PID_A=$!
push_to_vm host-b "$B_SSH" "$B_SEED" "$B_IP" 0b >"$LOGS/copy-host-b.log" 2>&1 &
PID_B=$!
wait "$PID_A" || {
  tail -20 "$LOGS/copy-host-a.log" >>"$LOG"
  die "copy to host-a failed"
}
wait "$PID_B" || {
  tail -20 "$LOGS/copy-host-b.log" >>"$LOG"
  die "copy to host-b failed"
}

say "==> provisioning both VMs (packages, bun, checkout, host-setup, agent)"
prov() { # prov <name> <ip> <role>
  local name=$1 ip=$2 role=$3
  timeout 2400 "$HERE/vm.sh" --name "$name" --ssh-port "$( [ "$name" = host-a ] && echo "$A_SSH" || echo "$B_SSH" )" ssh \
    "sudo NAME='$name' IP='$ip' ROLE='$role' bash /tmp/fc-mh-repo/deploy/firecracker/multihost/provision-host.sh '$name' '$ip' '$role'"
}
prov host-a "$A_IP" controller >"$LOGS/provision-host-a.log" 2>&1 &
PID_A=$!
prov host-b "$B_IP" agent >"$LOGS/provision-host-b.log" 2>&1 &
PID_B=$!
wait "$PID_A" || {
  tail -40 "$LOGS/provision-host-a.log" >>"$LOG"
  die "provisioning host-a failed"
}
wait "$PID_B" || {
  tail -40 "$LOGS/provision-host-b.log" >>"$LOG"
  die "provisioning host-b failed"
}
say "both VMs provisioned; agents accepting:true"

# Verify the private L2 before running the checks: a broken mcast link would
# otherwise look like a product bug in every later check.
say "==> verifying private L2 (host-a -> host-b)"
"$HERE/vm.sh" --name host-a --ssh-port "$A_SSH" ssh "ping -c 2 -W 2 $B_IP" >"$LOGS/l2-ping.log" 2>&1 || {
  cat "$LOGS/l2-ping.log" >>"$LOG"
  die "private L2 is not working (host-a cannot ping $B_IP)"
}
say "private L2 works"

# ---------------------------------------------------------------------------
# Forward the controller's loopback port to this machine for the driver.
# ---------------------------------------------------------------------------
say "==> opening ssh forward for the controller (127.0.0.1:$CTRL_PORT)"
ssh -i "$VM_ROOT/id_ed25519" -p "$A_SSH" \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -o ExitOnForwardFailure=yes -o BatchMode=yes -N \
  -L "127.0.0.1:${CTRL_PORT}:127.0.0.1:7000" ubuntu@127.0.0.1 \
  >"$LOGS/ssh-tunnel.log" 2>&1 &
TUNNEL_PID=$!
sleep 1
if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
  cat "$LOGS/ssh-tunnel.log" >>"$LOG"
  die "ssh forward failed"
fi

# ---------------------------------------------------------------------------
# Run the real driver.
# ---------------------------------------------------------------------------
export MH_RUN=$RUN
export MH_REPO=$REPO
export MH_ARTIFACTS=$ARTIFACTS
export HOST_A_NAME=host-a
export HOST_B_NAME=host-b
export HOST_A_SSH_PORT=$A_SSH
export HOST_B_SSH_PORT=$B_SSH
export HOST_A_SEED_PORT=$A_SEED
export HOST_B_SEED_PORT=$B_SEED
export MH_MCAST=$MCAST
export HOST_A_IP=$A_IP
export HOST_B_IP=$B_IP
export CONTROLLER_URL="http://127.0.0.1:$CTRL_PORT"
export MH_SECRETS_FILE=$SECRETS
export PATH="$HOME/.local/bin:$PATH"
export NO_PROXY='*'
export no_proxy='*'

say "==> running the multi-host driver"
set -o pipefail
timeout "${MH_TOTAL_TIMEOUT:-3300}" bun "$HERE/driver.ts" 2>&1 | tee -a "$LOG"
rc=${PIPESTATUS[0]}
say "driver exit code: $rc"
exit "$rc"
