#!/usr/bin/env bash
#
# Shared helpers for the vmtest checks. Sourced by every checks/*.sh.
# All checks run as root INSIDE the throwaway VM; nothing here is meant for a
# production host.
set -u

REPO=${REPO:-/opt/rctf-firecracker}
TOKEN=${FIRECRACKER_AGENT_TOKEN:-vmtest-token-3f8a1c9d}
API=${AGENT_API:-http://127.0.0.1:7001}
STATE=${STATE_DIR:-/var/lib/rctf-firecracker/state}
RUNDIR=${RUN_DIR:-/var/lib/rctf-firecracker/run}
QUARANTINE=${QUARANTINE_FILE:-/var/lib/rctf-firecracker/net-quarantine.json}
JAILBASE=${JAIL_BASE:-/srv/jailer/firecracker}
IMAGES=${IMAGES_DIR:-/var/lib/rctf-firecracker/images}
OUT_NS=${OUT_NS:-fcoutside}
OUT_IF=${OUT_IF:-fcveth0}
OUT_PEER_IF=${OUT_PEER_IF:-fcvext0}
OUT_HOST_IP=${OUT_HOST_IP:-192.0.2.1}
OUT_PEER_IP=${OUT_PEER_IP:-192.0.2.2}
OUT_HTTP_PORT=${OUT_HTTP_PORT:-9999}

COUNT=0
PASS=0
FAIL=0

section() { printf '\n== %s\n' "$*"; }
ok() {
  COUNT=$((COUNT + 1))
  PASS=$((PASS + 1))
  printf '  PASS [%02d]: %s\n' "$COUNT" "$*"
}
bad() {
  COUNT=$((COUNT + 1))
  FAIL=$((FAIL + 1))
  printf '  FAIL [%02d]: %s\n' "$COUNT" "$*" >&2
}
expect_eq() { # expect_eq <actual> <expected> <description>
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1', want '$2')"; fi
}
expect_match() { # expect_match <text> <regex> <description>
  if printf '%s' "$1" | grep -Eq -- "$2"; then ok "$3"; else bad "$3 (got '$1', want /$2/)"; fi
}
finish() {
  printf '\nRESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ]
}

api() {
  curl -sS -m 120 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"
}

api_code() { # api_code <method> <path> [body-file]
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    api -o /tmp/vmtest-api.out -w '%{http_code}' -X "$method" "$API$path" --data-binary "@$body"
  else
    api -o /tmp/vmtest-api.out -w '%{http_code}' -X "$method" "$API$path"
  fi
}

api_body() { cat /tmp/vmtest-api.out 2>/dev/null; }

wait_state() { # wait_state <id> <state> [seconds]
  local id=$1 want=$2 deadline=$((SECONDS + ${3:-120}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local now
    now=$(api "$API/v1/instances/$id" | jq -r '.state // "missing"' 2>/dev/null) || now=missing
    [ "$now" = "$want" ] && return 0
    [ "$now" = errored ] && [ "$want" != errored ] && return 1
    sleep 1
  done
  return 1
}

wait_gone() { # wait_gone <id> [seconds]: DELETE removes the record (GET 404)
  local id=$1 deadline=$((SECONDS + ${2:-30})) code
  while [ "$SECONDS" -lt "$deadline" ]; do
    code=$(api_code GET "/v1/instances/$id")
    [ "$code" = 404 ] && return 0
    sleep 1
  done
  return 1
}

id_json() { printf '%s.json' "$STATE/$1"; }
state_field() { # state_field <id> <jq path>
  jq -r "$2" "$(id_json "$1")" 2>/dev/null
}
lease_guest_ip() { state_field "$1" '.lease.guestIp'; }
lease_host_ip() { state_field "$1" '.lease.hostIp'; }
lease_tap() { state_field "$1" '.lease.tapName'; }
lease_port() { state_field "$1" '.lease.publicPorts["0"]'; }
vm_pid() { state_field "$1" '.vm.pid'; }
public_port() { # public_port <id> -> tcp endpoint port
  api "$API/v1/instances/$1" | jq -r '[.endpoints[] | select(.kind == "tcp")][0].port // empty'
}

make_spec() { # make_spec <file> <id> <image> <egress> <flag> <peers> <outside> [port]
  local file=$1 id=$2 image=$3 egress=$4 flag=$5 peers=$6 outside=$7 port=${8:-8080}
  jq -n \
    --arg id "$id" --arg image "$image" --argjson egress "$egress" \
    --arg flag "$flag" --arg peers "$peers" --arg outside "$outside" \
    --argjson port "$port" \
    --argjson expires "$((($(date +%s) + 3600) * 1000))" '
    {
      id: $id, teamKey: "abcdef012345", image: $image,
      vcpus: 1, memMiB: 256, diskMiB: 64, egress: $egress,
      bootTimeoutSeconds: 120,
      readiness: {kind: "tcp", port: 8080},
      env: {CHALLENGE: "vmtest", PROBE_PEERS: $peers, PROBE_OUTSIDE: $outside},
      expose: [{kind: "tcp", hostPrefix: "web", port: $port}],
      expiresAtMs: $expires,
      flags: [{provider: "main", flag: $flag}]
    }' >"$file"
}

create_instance() { # create_instance <id> <image> <egress> <flag> [peers] [outside]
  local id=$1 image=$2 egress=$3 flag=$4
  local peers=${5:-"10.200.0.2 10.200.0.6 10.200.0.10 10.200.0.14"}
  local outside=${6:-"$OUT_PEER_IP:$OUT_HTTP_PORT"}
  local spec=/tmp/vmtest-spec-$id.json
  make_spec "$spec" "$id" "$image" "$egress" "$flag" "$peers" "$outside"
  local code
  code=$(api_code PUT "/v1/instances/$id" "$spec")
  printf '%s' "$code"
}

delete_instance() { # delete_instance <id> [expected-code]
  local id=$1 want=${2:-200} code
  code=$(api_code DELETE "/v1/instances/$id")
  [ "$code" = "$want" ] || {
    echo "delete $id: HTTP $code $(api_body)" >&2
    return 1
  }
  return 0
}

guest_get() { # guest_get <guestIp> <path>
  curl -sS -m 10 "http://$1:8080$2"
}

ns_exec() { # namespace exec with retry for the transient setns EPERM on some kernels
  local i out err rc
  out=$(mktemp)
  err=$(mktemp)
  for i in 1 2 3 4 5; do
    nsenter --net="/run/netns/$OUT_NS" "$@" >"$out" 2>"$err"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      cat "$out"
      rm -f "$out" "$err"
      return 0
    fi
    if grep -q 'setting the network namespace\|Operation not permitted' "$err"; then
      sleep 0.2
      continue
    fi
    break
  done
  cat "$out"
  cat "$err" >&2
  rm -f "$out" "$err"
  return "$rc"
}

outside() { ns_exec "$@"; }

net_setup() { # idempotent "outside" peer network used by checks 50/60
  if ip netns list 2>/dev/null | awk '{print $1}' | grep -qx "$OUT_NS"; then
    if ! ns_exec ip link show "$OUT_PEER_IF" >/dev/null 2>&1; then
      ip netns del "$OUT_NS"
    fi
  fi
  if ! ip netns list 2>/dev/null | awk '{print $1}' | grep -qx "$OUT_NS"; then
    ip netns add "$OUT_NS"
    sleep 0.2
  fi
  if ! ip link show "$OUT_IF" >/dev/null 2>&1; then
    ip link add "$OUT_IF" type veth peer name "$OUT_PEER_IF"
  fi
  if ip link show "$OUT_PEER_IF" >/dev/null 2>&1; then
    ip link set "$OUT_PEER_IF" netns "$OUT_NS"
  fi
  ip addr replace "$OUT_HOST_IP/24" dev "$OUT_IF"
  ip link set "$OUT_IF" up
  ns_exec ip addr replace "$OUT_PEER_IP/24" dev "$OUT_PEER_IF"
  ns_exec ip link set "$OUT_PEER_IF" up
  ns_exec ip link set lo up
  ns_exec ip route replace default via "$OUT_HOST_IP"
}

outside_http_start() { # one real HTTP service in the outside namespace
  systemctl reset-failed fc-vmtest-outside >/dev/null 2>&1 || true
  systemd-run --unit=fc-vmtest-outside --collect \
    nsenter --net="/run/netns/$OUT_NS" python3 -m http.server "$OUT_HTTP_PORT" --bind "$OUT_PEER_IP" \
    >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 30); do
    if ns_exec curl -sS -m 2 "http://$OUT_PEER_IP:$OUT_HTTP_PORT/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  # A recreated netns strands the old service; restart it once.
  systemctl stop fc-vmtest-outside >/dev/null 2>&1 || true
  systemctl reset-failed fc-vmtest-outside >/dev/null 2>&1 || true
  systemd-run --unit=fc-vmtest-outside --collect \
    nsenter --net="/run/netns/$OUT_NS" python3 -m http.server "$OUT_HTTP_PORT" --bind "$OUT_PEER_IP" \
    >/dev/null 2>&1 || true
  for i in $(seq 1 30); do
    if ns_exec curl -sS -m 2 "http://$OUT_PEER_IP:$OUT_HTTP_PORT/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

outside_http_stop() {
  systemctl stop fc-vmtest-outside >/dev/null 2>&1 || true
  systemctl reset-failed fc-vmtest-outside >/dev/null 2>&1 || true
}

nft_save() {
  mkdir -p /tmp/vmtest-nft
  nft list table inet rctf_fc >/tmp/vmtest-nft/inet 2>/dev/null || true
  nft list table arp rctf_fc_arp >/tmp/vmtest-nft/arp 2>/dev/null || true
}

nft_flush_all() {
  nft flush table inet rctf_fc 2>/dev/null || true
  nft flush table arp rctf_fc_arp 2>/dev/null || true
}

nft_restore() {
  [ -s /tmp/vmtest-nft/inet ] && nft -f /tmp/vmtest-nft/inet
  [ -s /tmp/vmtest-nft/arp ] && nft -f /tmp/vmtest-nft/arp
}

probe_text() { guest_get "$1" /probe.txt; }

probe_wait_for() { # probe_wait_for <guestIp> <needle> [seconds]
  local ip=$1 needle=$2 deadline=$((SECONDS + ${3:-25}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    case "$(probe_text "$ip" 2>/dev/null)" in *"$needle"*) return 0 ;; esac
    sleep 1
  done
  return 1
}

wait_agent_active() {
  local i
  for i in $(seq 1 60); do
    systemctl is-active --quiet rctf-firecracker-agent && \
      api "$API/v1/info" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

agent_main_pid() { systemctl show -p MainPID --value rctf-firecracker-agent; }

# Documented agent capability set. CapabilityBoundingSet= in the shipped unit is
# CAP_CHOWN, CAP_DAC_OVERRIDE, CAP_FOWNER, CAP_KILL, CAP_SETGID, CAP_SETUID,
# CAP_SETPCAP, CAP_NET_ADMIN, CAP_NET_RAW, CAP_SYS_CHROOT, CAP_SYS_PTRACE,
# CAP_SYS_ADMIN, CAP_MKNOD = 0x82c31eb. AmbientCapabilities=CAP_SETUID restores
# the one bit systemd drops (0x80), so CapEff must equal CapBnd and CapAmb must
# be exactly CAP_SETUID.
AGENT_CAPBND=00000000082c31eb
AGENT_CAPAMB=0000000000000080

cap_field() { grep -E "^$2:" "/proc/$1/status" 2>/dev/null | awk '{print $2}'; }

assert_agent_caps() { # assert_agent_caps <pid> <label>
  local pid=$1 label=$2
  expect_eq "$(cap_field "$pid" CapBnd)" "$AGENT_CAPBND" \
    "agent CapBnd equals the documented unit set ($label)"
  expect_eq "$(cap_field "$pid" CapEff)" "$AGENT_CAPBND" \
    "agent CapEff equals CapBnd, so CAP_SETUID was restored ($label)"
  expect_eq "$(cap_field "$pid" CapPrm)" "$AGENT_CAPBND" \
    "agent CapPrm equals CapBnd ($label)"
  expect_eq "$(cap_field "$pid" CapAmb)" "$AGENT_CAPAMB" \
    "agent CapAmb is only CAP_SETUID ($label)"
  expect_eq "$(cap_field "$pid" NoNewPrivs)" 1 \
    "agent NoNewPrivs=1 ($label)"
}

# Every live process belonging to the instance: the jailer execs Firecracker in
# place (same PID), but enumerate descendants too in case it ever forks.
fc_family_pids() { # fc_family_pids <rootpid>
  local root=$1 child
  printf '%s\n' "$root"
  for child in $(pgrep -P "$root" 2>/dev/null || true); do
    fc_family_pids "$child"
  done
}

assert_no_caps() { # assert_no_caps <pid> <label>: guest-facing process is unprivileged
  local pid=$1 label=$2
  expect_eq "$(cap_field "$pid" CapPrm)" 0000000000000000 \
    "pid $pid has zero permitted capabilities ($label)"
  expect_eq "$(cap_field "$pid" CapEff)" 0000000000000000 \
    "pid $pid has zero effective capabilities ($label)"
  expect_eq "$(cap_field "$pid" CapAmb)" 0000000000000000 \
    "pid $pid has zero ambient capabilities ($label)"
  expect_eq "$(cap_field "$pid" NoNewPrivs)" 1 \
    "pid $pid runs with NoNewPrivs=1 ($label)"
}

assert_instance_no_caps() { # assert_instance_no_caps <rootpid> <label>
  local root=$1 label=$2 pid
  for pid in $(fc_family_pids "$root"); do
    assert_no_caps "$pid" "$label"
  done
}

# A firecracker process is identified by the exact process name and --id, never
# by a command line that merely mentions the id (the check's own shell does).
# Returns 0 with FC_PROCS set (possibly empty) when enumeration succeeded, 2
# when pgrep itself failed. pgrep exit 1 is the legitimate "no match".
FC_PROCS=
FC_PROCS_ERROR=
fc_procs() { # fc_procs <id>
  local out rc
  FC_PROCS=
  FC_PROCS_ERROR=
  out=$(pgrep -a -x firecracker 2>/dev/null) || rc=$?
  rc=${rc:-0}
  case "$rc" in
    0)
      FC_PROCS=$(printf '%s\n' "$out" | grep -F -- "--id $1 " || true)
      return 0
      ;;
    1) return 0 ;;
    *)
      FC_PROCS_ERROR="pgrep -a -x firecracker exited $rc"
      return 2
      ;;
  esac
}

# Tri-state link observation: 0 present, 1 absent, 2 probe failure.
# `ip link show dev X` exits 1 with "does not exist" for a missing interface;
# any other failure is an observation failure and must not pass as absence.
LINK_STATE=
link_exists() { # link_exists <ifname>
  local out err rc
  err=$(mktemp)
  out=$(ip link show dev "$1" 2>"$err") || rc=$?
  rc=${rc:-0}
  case "$rc" in
    0)
      LINK_STATE=present
      rm -f "$err"
      return 0
      ;;
    1)
      if grep -q 'does not exist' "$err"; then
        LINK_STATE=absent
        rm -f "$err"
        return 1
      fi
      LINK_STATE=error
      LINK_ERROR="ip link show dev $1 exited 1: $(tr '\n' ' ' <"$err")"
      rm -f "$err"
      return 2
      ;;
    *)
      LINK_STATE=error
      LINK_ERROR="ip link show dev $1 exited $rc: $(tr '\n' ' ' <"$err")"
      rm -f "$err"
      return 2
      ;;
  esac
}

# Tri-state nft observation: 0 the command succeeded (NFT_STATE is match,
# absent or missing), 2 the producer failed. "missing" is legitimate absence
# ONLY for the specific "No such file or directory" error after teardown; any
# other nft error is a probe failure and the check must fail, not pass.
NFT_STATE=
NFT_ERROR=
nft_table_grep() { # nft_table_grep <family> <table> <fixed-needle>
  local fam=$1 table=$2 needle=$3 out err rc
  NFT_STATE=
  NFT_ERROR=
  err=$(mktemp)
  out=$(nft list table "$fam" "$table" 2>"$err") || rc=$?
  rc=${rc:-0}
  if [ "$rc" -eq 0 ]; then
    rm -f "$err"
    if printf '%s\n' "$out" | grep -qF -- "$needle"; then
      NFT_STATE=match
    else
      NFT_STATE=absent
    fi
    return 0
  fi
  if grep -q 'No such file or directory' "$err"; then
    NFT_STATE=missing
    rm -f "$err"
    return 0
  fi
  NFT_STATE=error
  NFT_ERROR="nft list table $fam $table exited $rc: $(tr '\n' ' ' <"$err")"
  rm -f "$err"
  return 2
}

cleanup_all_instances() {
  local ids id
  ids=$(api "$API/v1/instances" 2>/dev/null | jq -r '.[].id' 2>/dev/null) || ids=
  for id in $ids; do
    api_code DELETE "/v1/instances/$id" >/dev/null 2>&1 || true
  done
  for id in $ids; do
    wait_gone "$id" 30 >/dev/null 2>&1 || true
  done
  outside_http_stop
  systemctl stop fc-vmtest-hold >/dev/null 2>&1 || true
  systemctl reset-failed fc-vmtest-hold >/dev/null 2>&1 || true
}
