#!/bin/bash
# xweb checks. Runs as root INSIDE the throwaway vmtest VM (copied there by
# run.sh). It starts the real Firecracker agent in jailer mode with the two
# lab images, plus the real pinned Traefik that publishes the instances' http
# exposes (exactly the production publishing path: the agent writes the
# per-instance file-provider route, Traefik proxies by Host header). Instances
# are created over the real agent HTTP API with real exposes, reach readiness
# through the agent's own HTTP readiness probe, and every check below runs
# from an "outside" network namespace against the PUBLISHED endpoints.
#
# Fail-closed: every probe is classified (check-http.sh). A transport failure
# or unclassifiable response is INCONCLUSIVE and is a failure, never a pass.
# The patched control proves the positive path still works, so a denial on it
# cannot be vacuous.
#
# Nothing is signalled by process name: the agent and Traefik PIDs are the
# ones this script started, and teardown checks identity before signalling.
set -uo pipefail

REPO=${REPO:-/opt/rctf-firecracker}
IMAGES=${XWEB_IMAGES:-/var/lib/rctf-firecracker/images}
AGENT_PORT=${XWEB_AGENT_PORT:-7102}
TRAEFIK_PORT=${XWEB_TRAEFIK_PORT:-8088}
TRAEFIK_BIN=${XWEB_TRAEFIK_BIN:-/tmp/fc-vmtest/artifacts/traefik}
AGENT_CONFIG=/etc/rctf-xweb/agent.yaml
TRAEFIK_CONFIG=/etc/rctf-xweb/traefik-static.yml
AGENT_LOG=/var/log/rctf-xweb-agent.log
TRAEFIK_LOG=/var/log/rctf-xweb-traefik.log
CHECK=$REPO/deploy/firecracker/labs/xweb/check-http.sh
NETNS=xwoutside
VETH=xwveth0
VETH_PEER=xwvext0
PUBLIC_HOST=192.0.2.1
OUTSIDE_HOST=192.0.2.2
HTTP_DOMAIN=xweb.test
IMAGES_ORDER=(xweb-vuln xweb-patched)

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
TRAEFIK_PID=
declare -a INSTANCE_IDS=()

api() {
  curl -sS -m 30 -H "Authorization: Bearer $AGENT_TOKEN" \
    -H 'Content-Type: application/json' "$@"
}

stop_pid() { # <pid> <config-path-needle>
  local pid=$1 needle=$2
  [ -n "$pid" ] || return 0
  if [ -r "/proc/$pid/cmdline" ] &&
    tr '\0' ' ' <"/proc/$pid/cmdline" | grep -Fq -- "$needle"; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || return 0
      sleep 0.1
    done
    kill -9 "$pid" 2>/dev/null || true
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
  stop_pid "$AGENT_PID" "$AGENT_CONFIG"
  stop_pid "$TRAEFIK_PID" "$TRAEFIK_CONFIG"
  ip netns del "$NETNS" 2>/dev/null || true
  ip link del "$VETH" 2>/dev/null || true
}

finish() {
  set +e
  cleanup
  printf '\nRESULT: xweb %d passed, %d failed\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
}
trap cleanup EXIT INT TERM

# --- shared classifier + payload set ------------------------------------------
# shellcheck source=./check-http.sh
. "$CHECK"

# --- setup --------------------------------------------------------------------
section 'host setup (real privileged operations inside the throwaway VM)'
[ "$(id -u)" -eq 0 ] || fatal 'inner.sh must run as root'
[ -f "$REPO/apps/firecracker-instancer/src/agent/index.ts" ] ||
  fatal "agent source is missing under $REPO"
[ -x "$TRAEFIK_BIN" ] || fatal "traefik binary is missing: $TRAEFIK_BIN"
command -v bun >/dev/null || fatal 'bun is not installed in the VM'
command -v jq >/dev/null || fatal 'jq is not installed in the VM'
command -v nft >/dev/null || fatal 'nft is not installed in the VM'
command -v conntrack >/dev/null || fatal 'conntrack is not installed in the VM'
command -v curl >/dev/null || fatal 'curl is not installed in the VM'

for image in "${IMAGES_ORDER[@]}"; do
  [ -f "$IMAGES/$image/rootfs.ext4" ] && [ -f "$IMAGES/$image/vmlinux" ] ||
    fatal "image $image is not registered under $IMAGES"
done

if ! bash "$REPO/deploy/firecracker/host/host-setup.sh" >/tmp/xweb-host-setup.log 2>&1; then
  tail -30 /tmp/xweb-host-setup.log >&2
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
ok "outside netns $NETNS has $OUTSIDE_HOST on $VETH_PEER"

# --- real Traefik (the publishing proxy for http exposes) ----------------------
section 'real Traefik (pinned 3.7.15, file provider on the agent dynamic dir)'
mkdir -p /var/lib/rctf-firecracker/state /var/lib/rctf-firecracker/run \
  /var/lib/rctf-firecracker/traefik /etc/rctf-xweb
cat >"$TRAEFIK_CONFIG" <<EOF
log:
  level: INFO
entryPoints:
  web:
    address: ':$TRAEFIK_PORT'
providers:
  file:
    directory: '/var/lib/rctf-firecracker/traefik'
    watch: true
EOF
chmod 0644 "$TRAEFIK_CONFIG"
"$TRAEFIK_BIN" --configFile="$TRAEFIK_CONFIG" >>"$TRAEFIK_LOG" 2>&1 &
TRAEFIK_PID=$!
traefik_up=0
for _ in $(seq 1 80); do
  code=$(ip netns exec "$NETNS" curl -s -o /dev/null -w '%{http_code}' \
    -m 5 -H 'Host: no.such.host' "http://$PUBLIC_HOST:$TRAEFIK_PORT/" 2>/dev/null || true)
  [ "$code" = 404 ] && traefik_up=1 && break
  sleep 0.25
done
[ "$traefik_up" = 1 ] || {
  tail -20 "$TRAEFIK_LOG" >&2 || true
  fatal "traefik did not answer on :$TRAEFIK_PORT"
}
ok "traefik is up on :$TRAEFIK_PORT (unknown Host -> 404)"

# --- real Firecracker agent (jailer mode) --------------------------------------
section 'real Firecracker agent (jailer mode, http publishing through traefik)'
chmod 0755 "$IMAGES"
find "$IMAGES" -mindepth 1 -maxdepth 2 -type f -exec chmod 0644 {} +
find "$IMAGES" -mindepth 1 -maxdepth 1 -type d -exec chmod 0755 {} +
AGENT_TOKEN=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
export AGENT_TOKEN
export FIRECRACKER_AGENT_TOKEN=$AGENT_TOKEN

cat >"$AGENT_CONFIG" <<YAML
hostId: xweb1
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
  httpDomain: $HTTP_DOMAIN
  httpPort: $TRAEFIK_PORT
  httpsPort: $TRAEFIK_PORT
  tcpSslPort: $TRAEFIK_PORT
  httpEntrypoint: web
  httpsEntrypoint: websecure
  tcpSslEntrypoint: websecure
  externalInterface: $VETH
  subnetPool: 10.200.0.0/16
  tcpPortRange: { from: 30060, to: 30090 }
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
  if api -f "http://127.0.0.1:$AGENT_PORT/v1/info" -o /tmp/xweb-info.json 2>/dev/null; then
    agent_up=1
    break
  fi
  sleep 0.5
done
[ "$agent_up" = 1 ] || {
  tail -40 "$AGENT_LOG" >&2 || true
  fatal 'agent did not answer /v1/info'
}
jq -e '.accepting == true' /tmp/xweb-info.json >/dev/null ||
  fatal 'agent preflight is not accepting'
ok 'agent preflight accepting'

for image in "${IMAGES_ORDER[@]}"; do
  if jq -e --arg i "$image" '.images | index($i) != null' /tmp/xweb-info.json >/dev/null; then
    ok "agent registered image $image"
  else
    fatal "agent did not register image $image"
  fi
done

# --- instances over the real agent API -----------------------------------------
section 'instances over the real agent API (readiness = agent http probe)'
rand_hex() { od -An -N5 -tx1 /dev/urandom | tr -d ' \n'; }

instance_id() { # <tag>; prints a fresh 16..32 char lowercase id
  printf 'xweb%s%s\n' "$1" "$(rand_hex)"
}

create_instance() { # <id> <image> <teamKey> <flag-or-empty> <tcp-expose yes|no>; prints the id
  local id=$1 image=$2 team=$3 flag=$4 with_tcp=$5 now expires spec flags_json expose_json code
  now=$(date +%s)
  expires=$(((now + 1200) * 1000))
  if [ -n "$flag" ]; then
    flags_json="[{\"provider\":\"main\",\"flag\":\"$flag\"}]"
  else
    flags_json='[]'
  fi
  expose_json="[{\"kind\":\"http\",\"hostPrefix\":\"xweb\",\"port\":8080}]"
  if [ "$with_tcp" = yes ]; then
    expose_json="[{\"kind\":\"http\",\"hostPrefix\":\"xweb\",\"port\":8080},{\"kind\":\"tcp\",\"hostPrefix\":\"xwebport\",\"port\":8080}]"
  fi
  spec=$(cat <<JSON
{"id":"$id","teamKey":"$team","image":"$image","vcpus":1,"memMiB":256,"diskMiB":512,
 "egress":false,"bootTimeoutSeconds":90,
 "readiness":{"kind":"http","port":8080,"path":"/","expectStatus":200},
 "env":{"CHALLENGE":"xweb"},
 "expose":$expose_json,
 "expiresAtMs":$expires,
 "flags":$flags_json}
JSON
)
  INSTANCE_IDS+=("$id")
  code=$(api -o "/tmp/xweb-create-$id.json" -w '%{http_code}' \
    -X PUT "http://127.0.0.1:$AGENT_PORT/v1/instances/$id" -d "$spec")
  if [ "$code" = 200 ] || [ "$code" = 201 ]; then
    printf '%s\n' "$id"
  else
    printf 'create %s -> HTTP %s: %s\n' "$id" "$code" \
      "$(head -c 400 "/tmp/xweb-create-$id.json" 2>/dev/null)" >&2
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

endpoint_of() { # <id> <kind http|tcp>; prints "host port"
  local id=$1 kind=$2
  api "http://127.0.0.1:$AGENT_PORT/v1/instances/$id" |
    jq -r --arg k "$kind" '.endpoints[] | select(.kind == $k) | "\(.host) \(.port)"' |
    head -n 1
}

# --- probe helpers (all against PUBLISHED endpoints, from outside) -------------
KIND= BODY= CODE= RC=
probe_http() { # <http-host> <method> <path> [curl args...]
  local host=$1 method=$2 path=$3
  shift 3
  local out rc code
  out=$(ip netns exec "$NETNS" curl -s -m 20 -o /tmp/xweb-body \
    -w '%{http_code}' -X "$method" -H "Host: $host" \
    "$@" "http://$PUBLIC_HOST:$TRAEFIK_PORT$path") && rc=0 || rc=$?
  code=$out
  BODY=$(cat /tmp/xweb-body 2>/dev/null)
  CODE=$code
  RC=$rc
  KIND=$(classify_xweb "$rc" "$code" "$BODY")
}

probe_tcp() { # <tcp-port> <method> <path> [curl args...]
  local port=$1 method=$2 path=$3
  shift 3
  local out rc code
  out=$(ip netns exec "$NETNS" curl -s -m 20 -o /tmp/xweb-body \
    -w '%{http_code}' -X "$method" \
    "$@" "http://$PUBLIC_HOST:$port$path") && rc=0 || rc=$?
  code=$out
  BODY=$(cat /tmp/xweb-body 2>/dev/null)
  CODE=$code
  RC=$rc
  KIND=$(classify_xweb "$rc" "$code" "$BODY")
}

expect_kind() { # <expected> <label>
  local expected=$1 label=$2
  if [ "$KIND" = "$expected" ]; then
    ok "$label ($KIND)"
  else
    bad "$label: expected $expected, got ${KIND:-none} (an inconclusive or unexpected result is never a pass)"
    printf '    code=%s rc=%s body[:200]=%s\n' "${CODE:-?}" "${RC:-?}" \
      "$(printf '%s' "$BODY" | head -c 200 | tr '\n' ' ')" >&2
  fi
}

expect_marker() { # <marker> <label>
  if printf '%s' "$BODY" | grep -qF -- "$1"; then
    ok "$2"
  else
    bad "$2: marker missing: $1"
  fi
}

expect_flag() { # <flag> <label>
  if printf '%s' "$BODY" | grep -qF -- "$1"; then
    ok "$2"
  else
    bad "$2: the exact per-run flag is not in the response"
  fi
}

expect_no_flag() { # <flag-or-empty> <label>
  if [ -n "$1" ] && printf '%s' "$BODY" | grep -qF -- "$1"; then
    bad "$2: found a flag that must not be there: $1"
  elif printf '%s' "$BODY" | grep -Eq 'rctf\{[A-Za-z0-9_-]+\}'; then
    bad "$2: response contains a flag-shaped string"
  else
    ok "$2"
  fi
}

expect_node() { # <instance-id> <label>
  if printf '%s' "$BODY" | grep -qF -- ">$1<"; then
    ok "$2"
  else
    bad "$2: the endpoint did not report its own node id $1"
  fi
}

expect_build() { # <image> <auth-mode> <label>
  if printf '%s' "$BODY" | grep -qF -- "IMAGE=$1 stack=python3-stdlib-sqlite3 auth=$2"; then
    ok "$3"
  else
    bad "$3: the running guest does not report the pinned build ($1, $2)"
  fi
}

# login through the published http endpoint; uses a per-flow cookie jar
portal_login() { # <http-host> <jar> <user> <pass>
  probe_http "$1" POST /login -c "$2" \
    --data-urlencode "username=$3" --data-urlencode "password=$4"
}

# --- the vulnerable portal ------------------------------------------------------
# check_vuln_instance <label> <id> <http-host> <tcp-port-or-empty> <flag> <other-flag>
check_vuln_instance() {
  local label=$1 id=$2 host=$3 tcp_port=$4 flag=$5 other_flag=$6
  local jar_root=/tmp/xweb-jar-$id
  rm -f "$jar_root"*

  section "vulnerable portal $label (instance $id)"

  # 1. The published http endpoint serves the themed login page.
  probe_http "$host" GET /
  expect_kind LOGIN "$label: published http endpoint serves the portal"
  expect_marker 'XWEB-500' "$label: portal branding XWEB-500"
  expect_marker 'Supervisor Portal' "$label: themed login subtitle"
  expect_marker 'FW 5.00.10' "$label: firmware-style footer"
  expect_node "$id" "$label: login page reports its own node id"
  expect_build xweb-vuln concat "$label: running guest reports the pinned build"
  if [ -n "$other_flag" ]; then
    if printf '%s' "$BODY" | grep -qF -- "$other_flag"; then
      bad "$label: the login page leaks the other team's flag"
    else
      ok "$label: the login page does not leak the other team's flag"
    fi
  fi

  # 2. The tcp DNAT endpoint serves the same portal (second real expose).
  if [ -n "$tcp_port" ]; then
    probe_tcp "$tcp_port" GET /
    expect_kind LOGIN "$label: published tcp endpoint serves the portal"
    expect_node "$id" "$label: tcp endpoint reports its own node id"
  fi

  # 3. Default credentials: the documented admin/1234 pair works and the
  #    admin area displays the per-run MMDS flag.
  portal_login "$host" "$jar_root-admin" admin 1234
  expect_kind REDIRECT "$label: admin/1234 authenticates (documented default)"
  probe_http "$host" GET /dashboard -b "$jar_root-admin"
  expect_kind DASHBOARD "$label: dashboard renders for the default admin"
  expect_marker 'Operator: <span class="xweb-led">admin</span>' \
    "$label: dashboard greets operator admin"
  probe_http "$host" GET /service -b "$jar_root-admin"
  expect_kind SERVICE "$label: admin area renders the service notes"
  expect_flag "$flag" "$label: admin service notes display the per-run flag"

  # 4. A wrong code is a genuine denial (classifier must not see a pass here).
  portal_login "$host" "$jar_root-wrong" admin not-the-code
  expect_kind DENIED "$label: a wrong code is denied (genuine negative)"

  # 5. SQLi #1 — authentication bypass with no credentials.
  local bypass_user bypass_pass
  bypass_user=$(xweb_bypass_username)
  bypass_pass=$(xweb_bypass_password)
  portal_login "$host" "$jar_root-bypass" "$bypass_user" "$bypass_pass"
  expect_kind REDIRECT "$label: ' OR 1=1-- bypass authenticates without credentials"
  probe_http "$host" GET /service -b "$jar_root-bypass"
  expect_kind SERVICE "$label: bypass session reaches the admin area"
  expect_flag "$flag" "$label: the bypass path exposes the per-run flag"

  # 6. SQLi #2 — UNION dump of the flag row through the public archive.
  local union_probe
  union_probe=$(xweb_union_archive_probe)
  probe_http "$host" GET /archive -G --data-urlencode "probe=$union_probe"
  expect_kind ARCHIVE "$label: UNION dump renders the service notes in the archive"
  expect_flag "$flag" "$label: the UNION dump exposes the per-run flag"
  if [ -n "$other_flag" ]; then
    if printf '%s' "$BODY" | grep -qF -- "$other_flag"; then
      bad "$label: the UNION dump leaked the other team's flag"
    else
      ok "$label: the UNION dump does not leak the other team's flag"
    fi
  fi

  # 7. A wrong-column UNION is a genuine SQL fault (proves the injected SQL
  #    really executes on the vulnerable build).
  local badcol_probe
  badcol_probe=$(xweb_badcol_archive_probe)
  probe_http "$host" GET /archive -G --data-urlencode "probe=$badcol_probe"
  expect_kind SQLERROR "$label: wrong-column UNION surfaces a genuine SQL fault"

  # 8. SQLi #3 — UNION through the login form (login-as-data).
  local union_user
  union_user=$(xweb_union_login_username)
  portal_login "$host" "$jar_root-union" "$union_user" whatever
  expect_kind REDIRECT "$label: UNION login authenticates as the dumped row"
  probe_http "$host" GET /dashboard -b "$jar_root-union"
  expect_flag "$flag" "$label: the UNION login dumps the flag into the operator line"
}

# --- the patched control ---------------------------------------------------------
# check_patched_instance <label> <id> <http-host> <flag>
check_patched_instance() {
  local label=$1 id=$2 host=$3 flag=$4
  local jar_root=/tmp/xweb-jar-$id
  rm -f "$jar_root"*

  section "patched control $label (instance $id)"

  probe_http "$host" GET /
  expect_kind LOGIN "$label: published endpoint serves the same portal theme"
  expect_marker 'XWEB-500' "$label: identical branding XWEB-500"
  expect_marker 'FW 5.00.10' "$label: identical firmware-style footer"
  expect_node "$id" "$label: login page reports its own node id"
  expect_build xweb-patched parameterized "$label: running guest reports the pinned build"

  # The positive path still works: default creds display the same flag.
  portal_login "$host" "$jar_root-admin" admin 1234
  expect_kind REDIRECT "$label: admin/1234 still authenticates (positive control)"
  probe_http "$host" GET /service -b "$jar_root-admin"
  expect_kind SERVICE "$label: admin area still renders the service notes"
  expect_flag "$flag" "$label: the control still displays the per-run flag"

  # Every injection payload fails closed as a genuine denial.
  local bypass_user bypass_pass union_probe badcol_probe union_user
  bypass_user=$(xweb_bypass_username)
  bypass_pass=$(xweb_bypass_password)
  union_probe=$(xweb_union_archive_probe)
  badcol_probe=$(xweb_badcol_archive_probe)
  union_user=$(xweb_union_login_username)

  portal_login "$host" "$jar_root-bypass" "$bypass_user" "$bypass_pass"
  expect_kind DENIED "$label: the ' OR 1=1 bypass is denied (genuine negative)"

  probe_http "$host" GET /archive -G --data-urlencode "probe=$union_probe"
  expect_kind ARCHIVE_EMPTY "$label: the UNION dump returns the empty state"
  expect_no_flag "$flag" "$label: the UNION dump shows no flag"

  probe_http "$host" GET /archive -G --data-urlencode "probe=$badcol_probe"
  expect_kind ARCHIVE_EMPTY "$label: the wrong-column UNION is plain data (no SQL fault)"

  portal_login "$host" "$jar_root-union" "$union_user" whatever
  expect_kind DENIED "$label: the UNION login payload is denied (genuine negative)"
}

# --- flagless negative control ----------------------------------------------------
# check_noflag_instance <label> <id> <http-host> <flagA> <flagB> <flagP>
check_noflag_instance() {
  local label=$1 id=$2 host=$3 flag_a=$4 flag_b=$5 flag_p=$6
  local jar_root=/tmp/xweb-jar-$id
  rm -f "$jar_root"*

  section "flagless negative control $label (instance $id, empty flags array)"

  probe_http "$host" GET /
  expect_kind LOGIN "$label: the vulnerable image boots and serves without a flag"
  expect_node "$id" "$label: login page reports its own node id"
  expect_build xweb-vuln concat "$label: running guest reports the pinned build"

  portal_login "$host" "$jar_root-admin" admin 1234
  expect_kind REDIRECT "$label: admin/1234 still authenticates"
  probe_http "$host" GET /service -b "$jar_root-admin"
  expect_kind SERVICE "$label: the admin area renders the (flagless) service notes"
  expect_no_flag '' "$label: the admin area shows no flag-shaped string"
  for f in "$flag_a" "$flag_b" "$flag_p"; do
    if printf '%s' "$BODY" | grep -qF -- "$f"; then
      bad "$label: the flagless instance leaked another instance's flag ($f)"
    fi
  done
  ok "$label: the flagless instance shows none of the other instances' flags"

  local union_probe
  union_probe=$(xweb_union_archive_probe)
  probe_http "$host" GET /archive -G --data-urlencode "probe=$union_probe"
  expect_kind ARCHIVE "$label: the UNION dump still renders the (seeded) notes"
  expect_no_flag '' "$label: the UNION dump cannot fabricate a flag"
}

# --- create, wait, check ------------------------------------------------------------
FLAG_A="rctf{xweb-team-a-$(rand_hex)}"
FLAG_B="rctf{xweb-team-b-$(rand_hex)}"
FLAG_P="rctf{xweb-team-p-$(rand_hex)}"

ID_A=$(instance_id vulna) || fatal 'could not build instance id A'
ID_B=$(instance_id vulnb) || fatal 'could not build instance id B'
ID_P=$(instance_id pctrl) || fatal 'could not build instance id P'
ID_N=$(instance_id noflg) || fatal 'could not build instance id N'

declare -A HOST_OF=() TCP_OF=()

for pair in "A:$ID_A:xweb-vuln:$FLAG_A:yes" "B:$ID_B:xweb-vuln:$FLAG_B:yes" \
  "P:$ID_P:xweb-patched:$FLAG_P:no" "N:$ID_N:xweb-vuln::no"; do
  IFS=: read -r tag id image flag with_tcp <<<"$pair"
  section "creating instance $tag ($image)"
  # teamKey must match ^[a-z0-9]{8,64}$: the display tag is lowercased here.
  if create_instance "$id" "$image" "team${tag,,}$(rand_hex)" "$flag" "$with_tcp" >/dev/null; then
    ok "instance $tag created over the agent API ($id)"
  else
    bad "instance $tag create was rejected"
    continue
  fi
  if wait_running "$id" 180; then
    ok "instance $tag is running (agent http readiness probe passed)"
    ep=$(endpoint_of "$id" http)
    host=${ep% *}
    port=${ep#* }
    if [ -n "$host" ] && [ -n "$port" ] && [ "$host" != "$port" ] &&
      printf '%s' "$host" | grep -Eq "^xweb-[a-z0-9]+\.$HTTP_DOMAIN$"; then
      ok "instance $tag published http endpoint $host:$port"
      HOST_OF[$tag]=$host
    else
      bad "instance $tag has no well-formed published http endpoint (got '${ep:-none}')"
    fi
    if [ "$with_tcp" = yes ]; then
      tcp=$(endpoint_of "$id" tcp)
      host_t=${tcp% *}
      port_t=${tcp#* }
      if [ -n "$port_t" ] && [ "$host_t" = "$PUBLIC_HOST" ]; then
        ok "instance $tag published tcp endpoint $host_t:$port_t"
        TCP_OF[$tag]=$port_t
      else
        bad "instance $tag has no tcp endpoint (got '${tcp:-none}')"
      fi
    fi
  else
    bad "instance $tag did not become ready (readiness is the agent's own probe)"
  fi
done

# The per-instance traefik route files exist (the real publishing path).
section 'published routes'
ls /var/lib/rctf-firecracker/traefik/rctf-fc-*.yml 2>/dev/null | sed 's/^/  /' || true
if [ -f "/var/lib/rctf-firecracker/traefik/rctf-fc-$ID_A.yml" ] &&
  grep -q "Host(\`xweb-$ID_A.$HTTP_DOMAIN\`)" \
    "/var/lib/rctf-firecracker/traefik/rctf-fc-$ID_A.yml"; then
  ok "the agent wrote the traefik route for instance A (Host rule)"
else
  bad 'the traefik route file for instance A is missing or malformed'
fi

# --- run the checks -----------------------------------------------------------------
if [ -n "${HOST_OF[A]:-}" ]; then
  check_vuln_instance 'team A' "$ID_A" "${HOST_OF[A]}" "${TCP_OF[A]:-}" "$FLAG_A" "$FLAG_B"
else
  bad 'team A instance is missing; skipping its checks'
fi
if [ -n "${HOST_OF[B]:-}" ]; then
  check_vuln_instance 'team B' "$ID_B" "${HOST_OF[B]}" "${TCP_OF[B]:-}" "$FLAG_B" "$FLAG_A"
else
  bad 'team B instance is missing; skipping its checks'
fi
if [ -n "${HOST_OF[P]:-}" ]; then
  check_patched_instance 'patched' "$ID_P" "${HOST_OF[P]}" "$FLAG_P"
else
  bad 'patched control instance is missing; skipping its checks'
fi
if [ -n "${HOST_OF[N]:-}" ]; then
  check_noflag_instance 'flagless' "$ID_N" "${HOST_OF[N]}" "$FLAG_A" "$FLAG_B" "$FLAG_P"
else
  bad 'flagless control instance is missing; skipping its checks'
fi

# --- isolation ------------------------------------------------------------------------
section 'per-instance endpoint isolation (team A vs team B)'
if [ -z "${HOST_OF[A]:-}" ] || [ -z "${HOST_OF[B]:-}" ]; then
  bad 'isolation: both team instances must be up'
else
  if [ "${HOST_OF[A]}" != "${HOST_OF[B]}" ]; then
    ok "isolation: distinct published hostnames (${HOST_OF[A]} vs ${HOST_OF[B]})"
  else
    bad 'isolation: both teams were given the same hostname'
  fi
  if [ -n "${TCP_OF[A]:-}" ] && [ -n "${TCP_OF[B]:-}" ]; then
    if [ "${TCP_OF[A]}" != "${TCP_OF[B]}" ]; then
      ok "isolation: distinct published tcp ports (${TCP_OF[A]} vs ${TCP_OF[B]})"
    else
      bad 'isolation: both teams were given the same public tcp port'
    fi
  else
    bad 'isolation: tcp endpoints are missing'
  fi
  if printf '%s' "${HOST_OF[A]}" | grep -qF -- "$ID_A" &&
    printf '%s' "${HOST_OF[B]}" | grep -qF -- "$ID_B"; then
    ok 'isolation: each hostname is derived from its own instance id'
  else
    bad 'isolation: a hostname is not derived from its instance id'
  fi
  # Cross-check: each endpoint reaches ONLY its own guest.
  probe_http "${HOST_OF[A]}" GET /
  if printf '%s' "$BODY" | grep -qF -- ">$ID_B<"; then
    bad 'isolation: team A endpoint reports team B node'
  else
    ok 'isolation: team A endpoint does not report team B node'
  fi
  probe_http "${HOST_OF[B]}" GET /
  if printf '%s' "$BODY" | grep -qF -- ">$ID_A<"; then
    bad 'isolation: team B endpoint reports team A node'
  else
    ok 'isolation: team B endpoint does not report team A node'
  fi
fi

finish
