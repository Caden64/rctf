#!/bin/bash
# sshole checks. Runs as root INSIDE the throwaway vmtest VM (copied there by
# run.sh). It starts the real Firecracker agent in jailer mode with the four lab
# images, creates one instance per image over the real agent HTTP API, and
# probes the published TCP endpoints with a stock ssh client from an "outside"
# network namespace.
#
# Everything here is disposable. Nothing is signalled by process name: the agent
# PID is the one this script started, and teardown checks its command line
# before signalling it.
set -uo pipefail

REPO=${REPO:-/opt/rctf-firecracker}
IMAGES=${SSHOLE_IMAGES:-/var/lib/rctf-firecracker/images}
AGENT_PORT=${SSHOLE_AGENT_PORT:-7101}
AGENT_CONFIG=/etc/rctf-sshole/agent.yaml
AGENT_LOG=/var/log/rctf-sshole-agent.log
CLIENT=$REPO/deploy/firecracker/labs/sshole/check-client.sh
NETNS=fcoutside
VETH=fcveth0
VETH_PEER=fcvext0
PUBLIC_HOST=192.0.2.1
OUTSIDE_HOST=192.0.2.2
IMAGES_ORDER=(sshole-musl-vuln sshole-musl-fixed sshole-glibc sshole-pam)

pass=0
fail=0
ok() { printf '  PASS: %s\n' "$*"; pass=$((pass + 1)); }
bad() { printf '  FAIL: %s\n' "$*" >&2; fail=$((fail + 1)); }
section() { printf '\n== %s\n' "$*"; }
fatal() {
  printf 'FATAL: %s\n' "$*" >&2
  fail=$((fail + 1))
  finish
  exit 1
}

AGENT_PID=
declare -a INSTANCE_IDS=()

api() {
  curl -sS -m 30 -H "Authorization: Bearer $AGENT_TOKEN" \
    -H 'Content-Type: application/json' "$@"
}

stop_agent() {
  [ -n "$AGENT_PID" ] || return 0
  if [ -r "/proc/$AGENT_PID/cmdline" ] &&
    tr '\0' ' ' <"/proc/$AGENT_PID/cmdline" | grep -Fq -- "$AGENT_CONFIG"; then
    kill "$AGENT_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$AGENT_PID" 2>/dev/null || return 0
      sleep 0.1
    done
    kill -9 "$AGENT_PID" 2>/dev/null || true
  fi
  return 0
}

cleanup() {
  set +e
  local id
  for id in "${INSTANCE_IDS[@]}"; do
    [ -n "$id" ] || continue
    api -o /dev/null -X DELETE "http://127.0.0.1:$AGENT_PORT/v1/instances/$id" 2>/dev/null || true
  done
  stop_agent
  ip netns del "$NETNS" 2>/dev/null || true
  ip link del "$VETH" 2>/dev/null || true
}

finish() {
  set +e
  cleanup
  printf '\nRESULT: sshole %d passed, %d failed\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
}
trap cleanup EXIT INT TERM

# --- setup -------------------------------------------------------------------
section 'host setup (real privileged operations inside the throwaway VM)'
[ "$(id -u)" -eq 0 ] || fatal 'inner.sh must run as root'
[ -x "$CLIENT" ] || fatal "check client is missing: $CLIENT"
[ -f "$REPO/apps/firecracker-instancer/src/agent/index.ts" ] ||
  fatal "agent source is missing under $REPO"
command -v bun >/dev/null || fatal 'bun is not installed in the VM'
command -v jq >/dev/null || fatal 'jq is not installed in the VM'
command -v nft >/dev/null || fatal 'nft is not installed in the VM'
command -v conntrack >/dev/null || fatal 'conntrack is not installed in the VM'

for image in "${IMAGES_ORDER[@]}"; do
  [ -f "$IMAGES/$image/rootfs.ext4" ] && [ -f "$IMAGES/$image/vmlinux" ] ||
    fatal "image $image is not registered under $IMAGES"
done

if ! bash "$REPO/deploy/firecracker/host/host-setup.sh" >/tmp/sshole-host-setup.log 2>&1; then
  tail -30 /tmp/sshole-host-setup.log >&2
  fatal 'host-setup.sh failed'
fi
ok 'host-setup.sh completed (sysctl, directories, firecracker binaries)'

ip link set lo up
ip netns del "$NETNS" 2>/dev/null || true
ip link del "$VETH" 2>/dev/null || true
ip link add "$VETH" type veth peer name "$VETH_PEER" ||
  fatal "could not create $VETH"
ip addr add "$PUBLIC_HOST/24" dev "$VETH"
ip link set "$VETH" up
ip netns add "$NETNS" || fatal "could not create netns $NETNS"
ip link set "$VETH_PEER" netns "$NETNS"
ip -n "$NETNS" addr add "$OUTSIDE_HOST/24" dev "$VETH_PEER"
ip -n "$NETNS" link set "$VETH_PEER" up
ip -n "$NETNS" link set lo up
if ip -n "$NETNS" -o -4 addr show dev "$VETH_PEER" | grep -q "$OUTSIDE_HOST"; then
  ok "outside netns $NETNS has $OUTSIDE_HOST on $VETH_PEER"
else
  fatal 'outside netns address was not configured'
fi

# --- agent -------------------------------------------------------------------
section 'real Firecracker agent (jailer mode)'
mkdir -p /var/lib/rctf-firecracker/state /var/lib/rctf-firecracker/run \
  /var/lib/rctf-firecracker/traefik /etc/rctf-sshole
chmod 0755 "$IMAGES"
find "$IMAGES" -mindepth 1 -maxdepth 2 -type f -exec chmod 0644 {} +
find "$IMAGES" -mindepth 1 -maxdepth 1 -type d -exec chmod 0755 {} +
AGENT_TOKEN=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
export AGENT_TOKEN
export FIRECRACKER_AGENT_TOKEN=$AGENT_TOKEN

cat >"$AGENT_CONFIG" <<YAML
hostId: sshole1
listen:
  host: 127.0.0.1
  port: $AGENT_PORT
stateDir: /var/lib/rctf-firecracker/state
capacity:
  vcpus: 8
  memMiB: 2048
  diskMiB: 8192
  maxInstances: 8
expiryGraceSeconds: 30
vm:
  mode: jailer
  firecrackerBin: /usr/local/bin/firecracker
  jailerBin: /usr/local/bin/jailer
  imagesDir: $IMAGES
  runDir: /var/lib/rctf-firecracker/run
  chrootBase: /srv/jailer
  jailUid: 10000
  jailGid: 10000
network:
  publicHost: $PUBLIC_HOST
  httpDomain: sshole.test
  externalInterface: $VETH
  subnetPool: 10.200.0.0/16
  tcpPortRange: { from: 30000, to: 30050 }
  traefikDynamicDir: /var/lib/rctf-firecracker/traefik
  quarantineFile: /var/lib/rctf-firecracker/state/net-quarantine.json
  requireConntrack: true
YAML
chmod 0600 "$AGENT_CONFIG"

(
  cd "$REPO" || exit 1
  exec bun apps/firecracker-instancer/src/agent/index.ts "$AGENT_CONFIG"
) >>"$AGENT_LOG" 2>&1 &
AGENT_PID=$!

agent_up=0
for _ in $(seq 1 120); do
  if api -f "http://127.0.0.1:$AGENT_PORT/v1/info" -o /tmp/sshole-info.json 2>/dev/null; then
    agent_up=1
    break
  fi
  sleep 0.5
done
if [ "$agent_up" -ne 1 ]; then
  tail -40 "$AGENT_LOG" >&2 || true
  fatal 'agent did not answer /v1/info'
fi
if ! jq -e '.accepting == true' /tmp/sshole-info.json >/dev/null; then
  jq -c '{accepting, checks}' /tmp/sshole-info.json >&2 || cat /tmp/sshole-info.json >&2
  tail -40 "$AGENT_LOG" >&2 || true
  fatal 'agent preflight is not accepting'
fi
ok 'agent preflight accepting'

for image in "${IMAGES_ORDER[@]}"; do
  if jq -e --arg i "$image" '.images | index($i) != null' /tmp/sshole-info.json >/dev/null; then
    ok "agent registered image $image"
  else
    fatal "agent did not register image $image"
  fi
done

# --- instances ---------------------------------------------------------------
section 'instances over the real agent API'
rand_hex() { od -An -N5 -tx1 /dev/urandom | tr -d ' \n'; }

instance_id() { # <tag>; prints a fresh 16..32 char lowercase id
  printf 'sshole%s%s\n' "$1" "$(rand_hex)"
}

create_instance() { # <id> <image> <teamKey> <flag>; prints the id
  local id=$1 image=$2 team=$3 flag=$4 now expires spec code
  now=$(date +%s)
  expires=$(((now + 900) * 1000))
  spec=$(cat <<JSON
{"id":"$id","teamKey":"$team","image":"$image","vcpus":1,"memMiB":128,"diskMiB":1024,
 "egress":false,"bootTimeoutSeconds":90,
 "readiness":{"kind":"tcp","port":22},
 "env":{"CHALLENGE":"sshole"},
 "expose":[{"kind":"tcp","hostPrefix":"sshole","port":22}],
 "expiresAtMs":$expires,
 "flags":[{"provider":"main","flag":"$flag"}]}
JSON
)
  INSTANCE_IDS+=("$id")
  code=$(api -o "/tmp/sshole-create-$id.json" -w '%{http_code}' \
    -X PUT "http://127.0.0.1:$AGENT_PORT/v1/instances/$id" -d "$spec")
  if [ "$code" = 200 ] || [ "$code" = 201 ]; then
    printf '%s\n' "$id"
  else
    printf 'create %s -> HTTP %s: %s\n' "$id" "$code" \
      "$(head -c 400 "/tmp/sshole-create-$id.json" 2>/dev/null)" >&2
    return 1
  fi
}

wait_running() { # <id> <timeout-seconds>
  local id=$1 timeout=$2 state
  for _ in $(seq 1 "$timeout"); do
    state=$(api "http://127.0.0.1:$AGENT_PORT/v1/instances/$id" |
      jq -r '.state // "unknown"' 2>/dev/null)
    case "$state" in
      running) return 0 ;;
      errored | stopped)
        api "http://127.0.0.1:$AGENT_PORT/v1/instances/$id" | head -c 600 >&2 || true
        printf '\n' >&2
        tail -30 "$AGENT_LOG" >&2 || true
        return 1
        ;;
    esac
    sleep 1
  done
  printf 'instance %s did not reach running (last state %s)\n' "$id" "${state:-unknown}" >&2
  return 1
}

endpoint_of() { # <id>; prints "host port"
  local id=$1
  api "http://127.0.0.1:$AGENT_PORT/v1/instances/$id" |
    jq -r '.endpoints[] | select(.kind == "tcp") | "\(.host) \(.port)"' |
    head -n 1
}

# --- probes ------------------------------------------------------------------
PROBE_KIND=
PROBE_OUT=
PROBE_ERR=
probe() { # <host> <port> <user> <mode> [command]
  local host=$1 port=$2 user=$3 mode=$4 command=${5:-}
  local -a args=(probe --host "$host" --port "$port" --user "$user" --mode "$mode")
  [ -n "$command" ] && args+=(--command "$command")
  local out
  out=$(ip netns exec "$NETNS" "$CLIENT" "${args[@]}")
  PROBE_KIND=$(printf '%s\n' "$out" |
    sed -n 's/^SSHOLE_PROBE kind=\([A-Z]*\).*/\1/p')
  PROBE_OUT=$(printf '%s\n' "$out" |
    awk '/^SSHOLE_STDOUT_BEGIN$/{f=1;next}/^SSHOLE_STDOUT_END$/{f=0}f' |
    sed 's/^| //')
  PROBE_ERR=$(printf '%s\n' "$out" |
    awk '/^SSHOLE_STDERR_BEGIN$/{f=1;next}/^SSHOLE_STDERR_END$/{f=0}f' |
    sed 's/^| //')
}

show_probe() {
  printf '    %s\n' "$*" >&2
  printf '    stderr: %s\n' "$(printf '%s' "$PROBE_ERR" | tr '\n' ' ' | head -c 300)" >&2
}

expect_kind() { # <expected> <label>
  local expected=$1 label=$2
  if [ "$PROBE_KIND" = "$expected" ]; then
    ok "$label ($PROBE_KIND)"
  else
    bad "$label: expected $expected, got ${PROBE_KIND:-none} (a transport/unknown result is never a pass)"
    show_probe "$label"
  fi
}

image_expectations() { # <image>; prints "libc pam banner package bypass"
  case "$1" in
    sshole-musl-vuln) printf 'musl no OpenSSH_10.3p1 openssh-server-10.3_p1-r1 yes\n' ;;
    sshole-musl-fixed) printf 'musl no OpenSSH_10.6p2 openssh-server-10.6_p2-r0 no\n' ;;
    sshole-glibc) printf 'glibc no OpenSSH_9.6p1 openssh-server-9.6p1-3ubuntu13.20 no\n' ;;
    sshole-pam) printf 'musl yes OpenSSH_10.3p1 openssh-server-pam-10.3_p1-r1 no\n' ;;
    *) printf 'unknown unknown unknown unknown no\n' ;;
  esac
}

declare -A ENDPOINT_HOST=()
declare -A ENDPOINT_PORT=()
declare -A INSTANCE_IDS_BY_IMAGE=()

for image in "${IMAGES_ORDER[@]}"; do
  read -r libc pam banner package bypass <<<"$(image_expectations "$image")"
  section "image $image (libc=$libc pam=$pam banner=$banner)"
  id=$(instance_id "$(printf '%s' "$image" | tr -cd 'a-z0-9' | cut -c6-14)")
  team=$(rand_hex)
  if ! create_instance "$id" "$image" "$team" \
    "rctf{sshole-$image-$(rand_hex)}" >/dev/null; then
    bad "$image: create was rejected"
    continue
  fi
  INSTANCE_IDS_BY_IMAGE[$image]=$id
  if wait_running "$id" 180; then
    endpoints=$(endpoint_of "$id")
    host=${endpoints% *}
    port=${endpoints#* }
    if [ -n "$host" ] && [ -n "$port" ] && [ "$host" != "$port" ]; then
      ok "$image instance $id is running at $host:$port"
      ENDPOINT_HOST[$image]=$host
      ENDPOINT_PORT[$image]=$port
    else
      bad "$image instance $id has no tcp endpoint"
      continue
    fi
  else
    bad "$image instance $id did not become ready"
    continue
  fi

  # 1. A short wrong password for alice must be rejected.
  probe "$host" "$port" alice wrong
  expect_kind REJECT "$image: short wrong password for alice is rejected"

  # 2. bob's documented real password must work: the client and credentials are
  #    not vacuous, and the guest really runs the pinned image.
  probe "$host" "$port" bob correct id
  expect_kind ACCEPT "$image: bob logs in with the documented password"
  if printf '%s\n' "$PROBE_OUT" | grep -Eq '^uid=[0-9]+\(bob\)'; then
    ok "$image: bob's login prints id (uid=bob)"
  else
    bad "$image: bob's login did not print a bob uid: $(printf '%s' "$PROBE_OUT" | head -c 200)"
  fi

  probe "$host" "$port" bob correct 'cat /etc/sshole-build'
  expect_kind ACCEPT "$image: build marker is readable as bob"
  if printf '%s\n' "$PROBE_OUT" | grep -qx "IMAGE=$image" &&
    printf '%s\n' "$PROBE_OUT" | grep -qx "LIBC=$libc" &&
    printf '%s\n' "$PROBE_OUT" | grep -qx "PAM=$pam" &&
    printf '%s\n' "$PROBE_OUT" | grep -qx "SSHD_BANNER=$banner" &&
    printf '%s\n' "$PROBE_OUT" | grep -qx "PACKAGE=$package"; then
    ok "$image: running guest reports the pinned build ($package, $banner, PAM=$pam)"
  else
    bad "$image: running guest build marker is wrong: $(printf '%s' "$PROBE_OUT" | tr '\n' ' ' | head -c 300)"
  fi

  # 3. The bypass itself: wrong password, then 300 bytes, same connection.
  probe "$host" "$port" alice wrong-then-long id
  if [ "$bypass" = yes ]; then
    expect_kind ACCEPT "$image: alice (shadow '*') accepts the 257+ byte password"
    if printf '%s\n' "$PROBE_OUT" | grep -Eq '^uid=[0-9]+\(alice\)'; then
      ok "$image: bypass login prints id (uid=alice)"
    else
      bad "$image: bypass login did not run id: $(printf '%s' "$PROBE_OUT" | head -c 200)"
    fi
    # The real hash must stay immune: the same overlong attempt as bob fails.
    probe "$host" "$port" bob wrong-then-long id
    expect_kind REJECT "$image: bob's real hash rejects the overlong password"
    # Informational only: a first-attempt overlong password is documented to be
    # rejected on the pinned build. Not asserted, because the advisory only
    # guarantees the second-or-later attempt.
    probe "$host" "$port" alice long-first id
    printf '  INFO: %s: first-attempt overlong password -> %s\n' "$image" \
      "${PROBE_KIND:-none}"
  else
    expect_kind REJECT "$image: alice (shadow '*') rejects the 257+ byte password"
  fi
done

# --- isolation ---------------------------------------------------------------
section 'live instances before the isolation check'
api "http://127.0.0.1:$AGENT_PORT/v1/instances" |
  jq -r '.[] | "\(.id) \(.state) ports=\([.endpoints[]?.port] | join(","))"' |
  sort | sed 's/^/  /' || true
nft list table inet rctf_fc 2>/dev/null | grep 'dnat ip to' | sed 's/^/  /' || true

section 'per-instance endpoint isolation'
id_a=${INSTANCE_IDS_BY_IMAGE[sshole-musl-vuln]:-}
if [ -z "$id_a" ]; then
  bad 'isolation: team A instance is missing'
else
  id_b=$(instance_id 'isob')
  team_b=$(rand_hex)
  [ "${#team_b}" -ge 8 ] || team_b="${team_b}00000000"
  if create_instance "$id_b" sshole-musl-vuln "$team_b" \
    "rctf{sshole-isolation-b-$(rand_hex)}" >/dev/null; then
    if wait_running "$id_b" 180; then
      ep_b=$(endpoint_of "$id_b")
      host_b=${ep_b% *}
      port_b=${ep_b#* }
      ok "isolation: second vuln instance $id_b is running at $host_b:$port_b"
      printf '    B record: %s\n' \
        "$(api "http://127.0.0.1:$AGENT_PORT/v1/instances/$id_b" | jq -c '{id,state,endpoints}' 2>/dev/null)"
      printf '    A record: %s\n' \
        "$(api "http://127.0.0.1:$AGENT_PORT/v1/instances/$id_a" | jq -c '{id,state,endpoints}' 2>/dev/null)"
      if [ "$port_b" != "${ENDPOINT_PORT[sshole-musl-vuln]:-}" ]; then
        ok 'isolation: the two teams received distinct public ports'
      else
        bad 'isolation: both teams were given the same public port'
      fi
      for other in "${IMAGES_ORDER[@]}"; do
        other_port=${ENDPOINT_PORT[$other]:-}
        if [ -n "$other_port" ] && [ "$other_port" = "$port_b" ]; then
          bad "isolation: team B's port $port_b collides with the $other endpoint"
        fi
      done

      probe "${ENDPOINT_HOST[sshole-musl-vuln]}" "${ENDPOINT_PORT[sshole-musl-vuln]}" \
        bob correct 'cat /etc/sshole-instance'
      expect_kind ACCEPT 'isolation: team A endpoint answers as bob'
      got_a=$(printf '%s\n' "$PROBE_OUT" | sed -n '1p')
      [ "$got_a" = "$id_a" ] && ok "isolation: team A endpoint is $id_a" ||
        bad "isolation: team A endpoint returned '$got_a', expected $id_a"

      probe "$host_b" "$port_b" bob correct 'cat /etc/sshole-instance'
      expect_kind ACCEPT 'isolation: team B endpoint answers as bob'
      got_b=$(printf '%s\n' "$PROBE_OUT" | sed -n '1p')
      [ "$got_b" = "$id_b" ] && ok "isolation: team B endpoint is $id_b" ||
        bad "isolation: team B endpoint returned '$got_b', expected $id_b"

      if [ "$got_a" != "$got_b" ] && [ "$got_a" != "$id_b" ] && [ "$got_b" != "$id_a" ]; then
        ok 'isolation: neither endpoint reaches the other team instance'
      else
        bad "isolation: endpoints crossed (A='$got_a' B='$got_b')"
      fi
    else
      bad "isolation: second instance $id_b did not become ready"
    fi
  else
    bad 'isolation: second instance create was rejected'
  fi
fi

finish
