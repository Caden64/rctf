#!/usr/bin/env bash
#
# Multi-host Firecracker end-to-end driver.
#
# Boots TWO named QEMU VMs (host-a, host-b), each a root VM with nested KVM
# running the shipped agent under systemd in JAILER mode, connects them through
# a point-to-point Ethernet link made of two AF_UNIX datagram sockets under the
# per-run directory (10.77.0.0/24, no multicast, no host interface), runs the
# real controller inside host-a, and executes
# deploy/firecracker/multihost/driver.ts from this (unprivileged) machine.
# Everything privileged happens inside the VMs.
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
# The private link directory is $RUN/link. $RUN is the trusted root linkguard
# checks (owned by this uid, mode 0700, no group/other write).
export MH_LINK_ROOT=$RUN

say() { printf '%s\n' "$*" | tee -a "$LOG" >&2; }
die() {
  say "ERROR: $*"
  exit 2
}

# ---------------------------------------------------------------------------
# Unique ports (this host is shared with other unprivileged test workers).
# ---------------------------------------------------------------------------
# All five ports are bound SIMULTANEOUSLY before any is released, so the five
# are distinct from each other by construction (five separate bind(0)+close
# round trips can hand the same ephemeral port to two of them). A residual
# window remains between the release here and each consumer's bind: another
# run claiming a port in that window fails this run's consumer loudly (QEMU
# exits nonzero on a hostfwd bind failure, the seed servers fail to bind, and
# the controller forward uses ExitOnForwardFailure), never silently, and the
# ports are recorded in the run log.
free_tcp_set() {
  python3 - <<'PY'
import socket
socks = [socket.socket() for _ in range(5)]
try:
    for s in socks:
        s.bind(('127.0.0.1', 0))
    print(' '.join(str(s.getsockname()[1]) for s in socks))
finally:
    for s in socks:
        s.close()
PY
}

ports=$(free_tcp_set)
read -r A_SSH B_SSH A_SEED B_SEED CTRL_PORT <<<"$ports"
case " $A_SSH $B_SSH $A_SEED $B_SEED $CTRL_PORT " in
  *[!\ 0-9]*) die "port allocation failed: $ports" ;;
esac

# The private link between the two VMs is a pair of AF_UNIX datagram sockets
# (QEMU -netdev dgram), one bound by each QEMU, in a per-run directory that is
# mode 0700 and owned by this user. There is no multicast group, no UDP or TCP
# port and no host bridge/tap: no other machine (and no other local user) can
# observe or inject traffic on it, and two parallel workers cannot share a
# segment because every run has its own paths.
LINK_DIR=$RUN/link
mkdir -m 700 -- "$LINK_DIR" || die "could not create the private link directory"
A_LINK=$LINK_DIR/host-a.sock
B_LINK=$LINK_DIR/host-b.sock
for link_path in "$A_LINK" "$B_LINK"; do
  [ ${#link_path} -le 103 ] || die "unix socket path is too long (${#link_path} > 103): $link_path"
done
A_IP=10.77.0.10
B_IP=10.77.0.11
A_MAC_PRIV=52:54:00:77:0a:01
B_MAC_PRIV=52:54:00:77:0b:01

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
    say "  host-a: $HERE/vm.sh --name host-a --ssh-port $A_SSH --seed-port $A_SEED --priv-ip $A_IP --link-local $A_LINK --link-peer $B_LINK --mac-mgmt 52:54:00:77:0a:00 --mac-priv $A_MAC_PRIV ssh"
    say "  host-b: $HERE/vm.sh --name host-b --ssh-port $B_SSH --seed-port $B_SEED --priv-ip $B_IP --link-local $B_LINK --link-peer $A_LINK --mac-mgmt 52:54:00:77:0b:00 --mac-priv $B_MAC_PRIV ssh"
    say "  controller: http://127.0.0.1:$CTRL_PORT"
  else
    say "==> stopping VMs"
    "$HERE/vm.sh" --name host-a --ssh-port "$A_SSH" --link-local "$A_LINK" stop >>"$LOG" 2>&1 || true
    "$HERE/vm.sh" --name host-b --ssh-port "$B_SSH" --link-local "$B_LINK" stop >>"$LOG" 2>&1 || true
    # Keep console logs for the record. Remove an overlay ONLY when the
    # authenticated pidfile proves the VM stopped; a still-running or
    # unobservable VM keeps its disk (and the run stays honest about it).
    for n in host-a host-b; do
      [ -f "$VM_ROOT/$n/console.log" ] && cp "$VM_ROOT/$n/console.log" "$LOGS/$n-console.log" || true
      vm_rc=0
      "$HERE/vm.sh" --name "$n" status >>"$LOG" 2>&1 || vm_rc=$?
      case "$vm_rc" in
        0) say "WARNING: $n is still running after stop; keeping $VM_ROOT/$n/overlay.qcow2" ;;
        1) rm -f "$VM_ROOT/$n/overlay.qcow2" ;;
        *) say "WARNING: $n's state could not be observed after stop; keeping $VM_ROOT/$n/overlay.qcow2" ;;
      esac
    done
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
say "link:      unix-dgram $A_LINK <-> $B_LINK"
say "controller forwarded on 127.0.0.1:$CTRL_PORT"

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
for tool in qemu-system-x86_64 qemu-img ssh curl python3 bun tar timeout flock ss stat; do
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
# Shared cache lock while snapshotting: a concurrent fetch-artifacts.sh run
# holds this lock exclusively and rebuilds fc-extract/rootdir in place.
: >>"$ARTIFACTS/.fetch.lock"
(
  flock -s 9
  cp "$ARTIFACTS/firecracker" "$STAGE/firecracker"
  cp "$ARTIFACTS/dl/fc-extract/release-v1.17.0-x86_64/jailer-v1.17.0-x86_64" "$STAGE/jailer"
  cp "$ARTIFACTS/images/smoke/vmlinux" "$STAGE/vmlinux"
  cp "$ARTIFACTS/images/smoke/rootfs.ext4" "$STAGE/rootfs-smoke.ext4"
  cp "$(readlink -f "$(command -v bun)")" "$STAGE/bun"
  cp "$ARTIFACTS/dl/jq" "$STAGE/jq"
) 9<"$ARTIFACTS/.fetch.lock" || die "artifact staging failed"
chmod 0755 "$STAGE/firecracker" "$STAGE/jailer" "$STAGE/bun"
chmod 0755 "$STAGE/jq"

say "==> packing checkout and artifacts"
tar czf "$RUN/repo.tgz" -C "$REPO" --exclude=.git --exclude=node_modules . ||
  die "could not pack the checkout"
tar czf "$RUN/artifacts.tgz" -C "$STAGE" . || die "could not pack artifacts"

# ---------------------------------------------------------------------------
# Pidfile authentication self-test. Runs unprivileged before any VM starts and
# proves that a stale pidfile never signals an unrelated live process.
# ---------------------------------------------------------------------------
say "==> pidfile authentication selftest (unprivileged decoy processes)"
if ! "$HERE/vm.sh" --name "selftest-$STAMP" selftest >"$LOGS/pidfile-selftest.log" 2>&1; then
  cat "$LOGS/pidfile-selftest.log" >>"$LOG"
  die "pidfile authentication selftest failed (see $LOGS/pidfile-selftest.log)"
fi
say "pidfile selftest passed ($(grep -c '^  PASS' "$LOGS/pidfile-selftest.log") checks)"

push_to_vm() { # push_to_vm <name> <ssh-port> <seed-port> <priv-ip> <link-local> <link-peer>
  local name=$1 sshp=$2 seedp=$3 ip=$4 link_local=$5 link_peer=$6
  "$HERE/vm.sh" --name "$name" --ssh-port "$sshp" --seed-port "$seedp" \
    --priv-ip "$ip" --link-local "$link_local" --link-peer "$link_peer" \
    ssh 'rm -rf /tmp/fc-mh /tmp/fc-mh-repo /tmp/fc-mh-artifacts && mkdir -p /tmp/fc-mh /tmp/fc-mh-repo /tmp/fc-mh-artifacts' \
    >>"$LOG" 2>&1 || return 1
  "$HERE/vm.sh" --name "$name" --ssh-port "$sshp" ssh 'tar xzf - -C /tmp/fc-mh-repo' \
    <"$RUN/repo.tgz" >>"$LOG" 2>&1 || return 1
  "$HERE/vm.sh" --name "$name" --ssh-port "$sshp" ssh 'tar xzf - -C /tmp/fc-mh-artifacts' \
    <"$RUN/artifacts.tgz" >>"$LOG" 2>&1 || return 1
  "$HERE/vm.sh" --name "$name" --ssh-port "$sshp" ssh 'cat > /tmp/fc-mh/secrets.env && chmod 600 /tmp/fc-mh/secrets.env' \
    <"$SECRETS" >>"$LOG" 2>&1 || return 1
}

# host-a goes first only until its QEMU has bound the link socket: that also
# serialises the (uncached) base-image download, and makes the peer path exist
# before host-b starts. The long cloud-init waits still run in parallel.
say "==> booting host-a (binds $A_LINK)"
"$HERE/vm.sh" --name host-a --ssh-port "$A_SSH" --seed-port "$A_SEED" \
  --priv-ip "$A_IP" --link-local "$A_LINK" --link-peer "$B_LINK" \
  --mac-mgmt 52:54:00:77:0a:00 --mac-priv "$A_MAC_PRIV" \
  create >"$LOGS/vm-host-a.log" 2>&1 &
PID_A=$!
for _ in $(seq 1 900); do
  [ -S "$A_LINK" ] && break
  kill -0 "$PID_A" 2>/dev/null || break
  sleep 0.2
done
if [ ! -S "$A_LINK" ]; then
  wait "$PID_A" 2>/dev/null || true
  tail -30 "$LOGS/vm-host-a.log" >>"$LOG"
  die "host-a did not bind the private link socket $A_LINK"
fi
say "host-a link socket ready; booting host-b (binds $B_LINK)"
"$HERE/vm.sh" --name host-b --ssh-port "$B_SSH" --seed-port "$B_SEED" \
  --priv-ip "$B_IP" --link-local "$B_LINK" --link-peer "$A_LINK" \
  --mac-mgmt 52:54:00:77:0b:00 --mac-priv "$B_MAC_PRIV" \
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
push_to_vm host-a "$A_SSH" "$A_SEED" "$A_IP" "$A_LINK" "$B_LINK" >"$LOGS/copy-host-a.log" 2>&1 &
PID_A=$!
push_to_vm host-b "$B_SSH" "$B_SEED" "$B_IP" "$B_LINK" "$A_LINK" >"$LOGS/copy-host-b.log" 2>&1 &
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

# ---------------------------------------------------------------------------
# Verify the private link before running the checks: a broken link would
# otherwise look like a product bug in every later check. These assertions are
# deliberately independent of the driver: they inspect the QEMU command lines
# recorded in the run directory, the socket filesystem objects and the routing
# tables inside both VMs.
# ---------------------------------------------------------------------------
LINK_PASS=0
LINK_FAIL=0
link_ok() {
  LINK_PASS=$((LINK_PASS + 1))
  say "PASS [link.$((LINK_PASS + LINK_FAIL))] $*"
}
link_bad() {
  LINK_FAIL=$((LINK_FAIL + 1))
  say "FAIL [link.$((LINK_PASS + LINK_FAIL))] $*"
}
vm_ssh() { # vm_ssh <name> <ssh-port> <command>
  "$HERE/vm.sh" --name "$1" --ssh-port "$2" ssh "$3" 2>/dev/null
}

verify_private_link() {
  local name local_sock peer_sock file spec netdevs iface linkline listens foreign
  local route neigh ip sshp peer_ip peer_mac priv_mac
  for name in host-a host-b; do
    if [ "$name" = host-a ]; then
      local_sock=$A_LINK; peer_sock=$B_LINK
      ip=$A_IP; sshp=$A_SSH; peer_ip=$B_IP; peer_mac=$B_MAC_PRIV; priv_mac=$A_MAC_PRIV
    else
      local_sock=$B_LINK; peer_sock=$A_LINK
      ip=$B_IP; sshp=$B_SSH; peer_ip=$A_IP; peer_mac=$A_MAC_PRIV; priv_mac=$B_MAC_PRIV
    fi
    file=$VM_ROOT/$name/qemu.cmdline
    if [ ! -s "$file" ]; then
      link_bad "$name has no recorded qemu command line at $file"
      continue
    fi
    spec="dgram,id=n1,local.type=unix,local.path=$local_sock,remote.type=unix,remote.path=$peer_sock"
    if grep -qxF -- "$spec" "$file"; then
      link_ok "$name private NIC is a host-local unix-datagram link ($(basename "$local_sock") -> $(basename "$peer_sock"))"
    else
      link_bad "$name qemu command line lacks the expected private netdev '$spec'"
    fi
    if grep -qiE -- 'mcast|multicast' "$file"; then
      link_bad "$name qemu command line still mentions multicast"
    else
      link_ok "$name qemu command line contains no multicast"
    fi
    netdevs=$(grep -cx -- '-netdev' "$file" || true)
    if [ "$netdevs" = 2 ] &&
      ! grep -qE -- '^(socket|tap|bridge|hubport|vde|passt|l2tpv3),' "$file" &&
      ! grep -qF -- 'local.type=inet' "$file" &&
      ! grep -qE -- 'hostfwd=.*10\.77\.' "$file"; then
      link_ok "$name has exactly two netdevs (user-mode management + unix-dgram private) and no host-network or port-forward path to the private link"
    else
      link_bad "$name netdevs are not confined to user-mode management + unix-dgram (count=$netdevs)"
    fi

    iface=$(vm_ssh "$name" "$sshp" \
      "ip -4 -o addr show | awk -v ip='$ip/24' '\$4 == ip { gsub(\":\", \"\", \$2); print \$2; exit }'" | tail -1)
    if [ -n "$iface" ]; then
      link_ok "$name has $ip on interface $iface"
    else
      link_bad "$name has no interface with $ip"
      continue
    fi
    linkline=$(vm_ssh "$name" "$sshp" "ip -o link show dev '$iface'")
    case "$linkline" in
      *"link/ether $priv_mac"*) link_ok "$name's $ip is on the MAC-pinned private NIC ($priv_mac), not the management NIC" ;;
      *) link_bad "$name's $iface does not have the expected private MAC $priv_mac" ;;
    esac
    listens=$(vm_ssh "$name" "$sshp" "ss -ltn 2>/dev/null | awk 'NR > 1 { print \$4 }'")
    if printf '%s\n' "$listens" | grep -qxF "$ip:7001"; then
      link_ok "$name's agent listens on its private address $ip:7001"
    else
      link_bad "$name's agent does not listen on $ip:7001 (listeners: $(printf '%s' "$listens" | tr '\n' ' '))"
    fi
    foreign=$(printf '%s\n' "$listens" | grep -E ':7001$' | grep -vxF "$ip:7001" || true)
    if [ -z "$foreign" ]; then
      link_ok "$name's agent has no wildcard/management :7001 listener"
    else
      link_bad "$name's agent also listens on: $(printf '%s' "$foreign" | tr '\n' ' ')"
    fi
    route=$(vm_ssh "$name" "$sshp" "ip route get $peer_ip")
    case "$route" in
      *"dev $iface"*"src $ip"*) link_ok "$name reaches $peer_ip only via $iface (src $ip)" ;;
      *) link_bad "$name route to $peer_ip is not via $iface: ${route:-<empty>}" ;;
    esac
    neigh=$(vm_ssh "$name" "$sshp" "ip neigh show $peer_ip")
    case "$neigh" in
      *"lladdr $peer_mac"*) link_ok "$name resolves the peer $peer_ip to the peer's private MAC $peer_mac over the link" ;;
      *) link_bad "$name neighbour entry for $peer_ip is not the peer's private MAC $peer_mac: ${neigh:-<empty>}" ;;
    esac
  done

  local mode owner
  mode=$(stat -c '%a' -- "$LINK_DIR")
  owner=$(stat -c '%u' -- "$LINK_DIR")
  if [ "$mode" = 700 ] && [ "$owner" = "$(id -u)" ]; then
    link_ok "link directory $LINK_DIR is mode 0700 and owned by uid $owner"
  else
    link_bad "link directory $LINK_DIR has mode $mode owner $owner (expected 700/$(id -u))"
  fi
  if [ -S "$A_LINK" ] && [ -S "$B_LINK" ] && [ ! -e "$LINK_DIR/control" ]; then
    link_ok "both link endpoints are AF_UNIX socket files in the 0700 directory"
  else
    link_bad "one of the link socket files is missing or not a unix socket"
  fi
  if ip -4 -o addr show | grep -qE "inet ($A_IP|$B_IP)/"; then
    link_bad "this machine has a host interface with $A_IP or $B_IP"
  else
    link_ok "no interface on this machine carries $A_IP or $B_IP (the private L2 does not exist on the host)"
  fi
  if ss -ltn 2>/dev/null | grep -qE "($A_IP|$B_IP):"; then
    link_bad "this machine listens on a private-link address"
  else
    link_ok "this machine has no listener on the private-link addresses"
  fi
  if vm_ssh host-a "$A_SSH" "grep -q 'url: http://$B_IP:7001' /home/ubuntu/mh-controller/controller.yaml"; then
    link_ok "the controller targets host-b only at $B_IP:7001 across the link"
  else
    link_bad "the controller config does not target host-b at $B_IP:7001"
  fi
  if vm_ssh host-a "$A_SSH" "grep -q 'host: 127.0.0.1' /home/ubuntu/mh-controller/controller.yaml"; then
    link_ok "the controller API binds loopback only (reached through the ssh forward)"
  else
    link_bad "the controller API is not bound to loopback"
  fi
  say "private-link checks: $LINK_PASS passed, $LINK_FAIL failed"
  [ "$LINK_FAIL" -eq 0 ]
}

say "==> verifying the private link (host-a <-> host-b)"
"$HERE/vm.sh" --name host-a --ssh-port "$A_SSH" ssh "ping -c 2 -W 2 $B_IP" >"$LOGS/l2-ping.log" 2>&1 || {
  cat "$LOGS/l2-ping.log" >>"$LOG"
  die "the private link is not working (host-a cannot ping $B_IP)"
}
verify_private_link || die "private-link verification failed (see the FAIL [link.*] lines)"
say "private link works and is host-local only"

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
export MH_LINK_DIR=$LINK_DIR
export MH_LINK_A=$A_LINK
export MH_LINK_B=$B_LINK
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
