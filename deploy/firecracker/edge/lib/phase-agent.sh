#!/bin/bash
# Phase agent (inside its own network namespace): two REAL Firecracker guests
# managed by the REAL agent, routed by REAL Traefik, with an "outside" netns
# client and an "upstream" netns server across a bridge that is the configured
# externalInterface. Covers checks 1-5 and 7.
set -u
: "${RUN:?}" "${EDGE:?}" "${REPO:?}" "${ARTIFACTS:?}" "${TRAEFIK:?}"
. "$EDGE/lib/assert.sh"
PIDS=()
AGENT_PID=
TRAEFIK_PID=
IDA=
IDB=
IDC=

kill_matching() { # unique instance id -> its firecracker pids only
  local id=$1 p
  for p in $(pgrep -f "firecracker.*--id $id" 2>/dev/null || true); do
    kill -9 "$p" 2>/dev/null || true
  done
}
cleanup() {
  set +e
  [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null
  [ -n "$TRAEFIK_PID" ] && kill "$TRAEFIK_PID" 2>/dev/null
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  for id in $IDA $IDB $IDC; do kill_matching "$id"; done
}
trap cleanup EXIT INT TERM

pass() { printf 'CHECK %s PASS %s\n' "$1" "${*:2}"; }
fail() { printf 'CHECK %s FAIL %s\n' "$1" "${*:2}"; }
note() { printf 'NOTE %s\n' "$*"; }
TOKEN=edge-token-$$
export FIRECRACKER_AGENT_TOKEN=$TOKEN
api() { curl -sS -m 90 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }
out_curl() { nsenter -t "$OUT_PID" -n curl -sS -m 8 "$@"; }

ip link set lo up
echo 1 >/proc/sys/net/ipv4/ip_forward 2>/dev/null || true
sysctl -qw net.ipv4.conf.all.rp_filter=0 2>/dev/null || true

# --- external L2: host bridge = network.externalInterface -------------------
ip link add br-ext type bridge
ip link set br-ext up
ip addr add 203.0.113.1/24 dev br-ext
ip addr add 203.0.114.1/24 dev br-ext

unshare -n sleep 900 & OUT_PID=$!
sleep 0.3
PIDS+=("$OUT_PID")
ip link add vout type veth peer name pout
ip link set vout master br-ext
ip link set vout up
ip link set pout netns "$OUT_PID"
nsenter -t "$OUT_PID" -n bash -c '
  ip link set pout name eth0
  ip addr add 203.0.113.2/24 dev eth0
  ip link set eth0 up
  ip link set lo up
  ip route add default via 203.0.113.1
'
nsenter -t "$OUT_PID" -n sysctl -qw net.ipv4.tcp_tw_reuse=1 2>/dev/null || true

unshare -n sleep 900 & UP_PID=$!
sleep 0.3
PIDS+=("$UP_PID")
ip link add vup type veth peer name pup
ip link set vup master br-ext
ip link set vup up
ip link set pup netns "$UP_PID"
nsenter -t "$UP_PID" -n bash -c '
  ip link set pup name eth0
  ip addr add 203.0.114.3/24 dev eth0
  ip addr add 203.0.113.4/24 dev eth0
  ip link set eth0 up
  ip link set lo up
  ip route add default via 203.0.113.1
'
nsenter -t "$UP_PID" -n python3 "$EDGE/lib/upstream.py" \
  --http 8080 --hold 24000 --hold 24001 --hold 24002 --hold 24003 --hold 24004 --hold 24005 \
  >"$RUN/out/agent-upstream.log" 2>&1 & UPHOLD_PID=$!
PIDS+=("$UPHOLD_PID")

echo host-ok >"$RUN/www/host/index.html"

# --- real Traefik with the repo's file-provider static config --------------
cat >"$RUN/agent/traefik-static.yml" <<EOF
log:
  level: INFO
entryPoints:
  web:
    address: ':8088'
providers:
  file:
    directory: '$RUN/agent/traefik'
    watch: true
EOF
"$TRAEFIK" --configFile="$RUN/agent/traefik-static.yml" \
  >>"$RUN/logs/traefik.log" 2>&1 & TRAEFIK_PID=$!

# --- real agent (direct mode; jailer needs real root) ----------------------
cat >"$RUN/agent/agent.yaml" <<EOF
hostId: edge1
listen: { host: 127.0.0.1, port: 7001 }
stateDir: $RUN/agent/state
capacity: { vcpus: 8, memMiB: 4096, diskMiB: 4096, maxInstances: 8 }
expiryGraceSeconds: 60
vm:
  mode: direct
  firecrackerBin: $ARTIFACTS/firecracker
  imagesDir: $RUN/images
  runDir: $RUN/agent/run
  chrootBase: $RUN/agent/jailer
  allowUntrustedImages: true
network:
  publicHost: 203.0.113.1
  httpDomain: edge.test
  httpPort: 8088
  httpsPort: 8088
  tcpSslPort: 8088
  tcpPortRange: { from: 24000, to: 24099 }
  subnetPool: 10.200.0.0/16
  externalInterface: br-ext
  traefikDynamicDir: $RUN/agent/traefik
  reuseQuarantineSeconds: 120
  requireConntrack: true
  httpEntrypoint: web
  httpsEntrypoint: websecure
  tcpSslEntrypoint: websecure
  ownerMarker: rctf-fc
  quarantineFile: $RUN/agent/net-quarantine.json
EOF
( cd "$REPO" && exec bun apps/firecracker-instancer/src/agent/index.ts "$RUN/agent/agent.yaml" ) \
  >>"$RUN/logs/agent.log" 2>&1 & AGENT_PID=$!

for i in $(seq 1 80); do
  api -f http://127.0.0.1:7001/v1/info >/dev/null 2>&1 && break
  sleep 0.25
done
if ! api -f http://127.0.0.1:7001/v1/info >/dev/null 2>&1; then
  fail 0 "agent did not start (see $RUN/logs/agent.log)"
  tail -20 "$RUN/logs/agent.log" >&2
  exit 1
fi
for i in $(seq 1 40); do
  code=$(out_curl -o /dev/null -w '%{http_code}' -H 'Host: no.such.test' http://203.0.113.1:8088/ || true)
  [ "$code" = 404 ] && break
  sleep 0.25
done

STAMP=$(date +%s)
IDA="edgea${STAMP}aa"
IDB="edgeb${STAMP}bb"
IDC="edgec${STAMP}cc"
EXP=$(( ($(date +%s) + 900) * 1000 ))

spec() { # id team hostprefix egress probe_host scan_peer
  cat <<JSON
{"id":"$1","teamKey":"team${2}edgekey1234","image":"edge","vcpus":1,"memMiB":256,"diskMiB":64,
 "egress":$4,"bootTimeoutSeconds":120,"readiness":{"kind":"tcp","port":8080},
 "env":{"GUEST_NAME":"team-$2",
        "PROBE_PEER":"http://203.0.114.3:8080/index.html",
        "PROBE_HOST":"http://$3:9999/",
        "SCAN_PEER":"$5","SCAN_PORT":"8080"},
 "expose":[{"kind":"tcp","hostPrefix":"raw-$2","port":8080},
           {"kind":"raw","hostPrefix":"hold-$2","port":9000},
           {"kind":"http","hostPrefix":"web-$2","port":8080}],
 "expiresAtMs":$EXP,"flags":[{"provider":"main","flag":"rctf{edge-${2}-not-real}"}]}
JSON
}

note "creating two real Firecracker guests"
api -o "$RUN/out/create-a.json" -w '%{http_code}' -X PUT \
  "http://127.0.0.1:7001/v1/instances/$IDA" -d "$(spec "$IDA" a 10.200.0.1 false 10.200.0.6)" \
  >"$RUN/out/create-a.code" || true
api -o "$RUN/out/create-b.json" -w '%{http_code}' -X PUT \
  "http://127.0.0.1:7001/v1/instances/$IDB" -d "$(spec "$IDB" b 10.200.0.5 true 10.200.0.2)" \
  >"$RUN/out/create-b.code" || true
note "create codes: A=$(cat "$RUN/out/create-a.code") B=$(cat "$RUN/out/create-b.code")"

for id in "$IDA" "$IDB"; do
  st=
  for i in $(seq 1 160); do
    st=$(api "http://127.0.0.1:7001/v1/instances/$id" | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p')
    [ "$st" = running ] && break
    [ "$st" = errored ] && break
    sleep 0.5
  done
  note "$id state=$st"
done
if [ "$(api "http://127.0.0.1:7001/v1/instances/$IDA" | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p')" != running ] ||
   [ "$(api "http://127.0.0.1:7001/v1/instances/$IDB" | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p')" != running ]; then
  fail 0 "real Firecracker guests did not reach running"
  tail -30 "$RUN/logs/agent.log" >&2
  exit 1
fi

AJ=$RUN/agent/state/$IDA.json
BJ=$RUN/agent/state/$IDB.json
A_TAP=$(jq -r '.lease.tapName' "$AJ")
B_TAP=$(jq -r '.lease.tapName' "$BJ")
A_GUEST=$(jq -r '.lease.guestIp' "$AJ")
B_GUEST=$(jq -r '.lease.guestIp' "$BJ")
A_HOST=$(jq -r '.lease.hostIp' "$AJ")
B_HOST=$(jq -r '.lease.hostIp' "$BJ")
A_PUB=$(jq -r '.lease.publicPorts["0"]' "$AJ")
A_HOLD=$(jq -r '.lease.publicPorts["1"]' "$AJ")
B_PUB=$(jq -r '.lease.publicPorts["0"]' "$BJ")
B_HOLD=$(jq -r '.lease.publicPorts["1"]' "$BJ")
A_HOSTNAME=$(jq -r '.lease.publicHostnames["2"]' "$AJ")
B_HOSTNAME=$(jq -r '.lease.publicHostnames["2"]' "$BJ")
note "A: $A_TAP $A_HOST/$A_GUEST ports $A_PUB,$A_HOLD host=$A_HOSTNAME"
note "B: $B_TAP $B_HOST/$B_GUEST ports $B_PUB,$B_HOLD host=$B_HOSTNAME"

# Host-side listeners on the tap addresses (the guests probe them; must stay
# unreachable from the guests even with egress=true).
python3 -m http.server 9999 --bind "$A_HOST" --directory "$RUN/www/host" \
  >>"$RUN/out/host-listen-a.log" 2>&1 & PIDS+=("$!")
python3 -m http.server 9999 --bind "$B_HOST" --directory "$RUN/www/host" \
  >>"$RUN/out/host-listen-b.log" 2>&1 & PIDS+=("$!")
sleep 0.5

wait_route() { # hostname expected-body
  local host=$1 want=$2 body= code=
  for i in $(seq 1 60); do
    body=$(out_curl -H "Host: $host" "http://203.0.113.1:8088/id.txt" 2>/dev/null || true)
    [ "$body" = "$want" ] && return 0
    sleep 0.3
  done
  return 1
}
http_code() { # hostname path
  out_curl -o /dev/null -w '%{http_code}' -H "Host: $1" "http://203.0.113.1:8088$2" 2>/dev/null || true
}

# ===========================================================================
# 1. real Traefik, two teams, Host-based routing
# ===========================================================================
note "-- 1. Traefik routes by Host to the right real guest"
if wait_route "$A_HOSTNAME" team-a; then
  pass 1.1 "Host($A_HOSTNAME) served team-a from the real guest"
else
  fail 1.1 "Host($A_HOSTNAME) did not serve team-a (got '$(out_curl -H "Host: $A_HOSTNAME" http://203.0.113.1:8088/id.txt 2>/dev/null)')"
fi
if wait_route "$B_HOSTNAME" team-b; then
  pass 1.2 "Host($B_HOSTNAME) served team-b at the same time"
else
  fail 1.2 "Host($B_HOSTNAME) did not serve team-b"
fi
UNKNOWN=$(http_code "nope.edge.test" /id.txt)
WRONG=$(http_code "web-a-deadbeefdeadbeefdead.edge.test" /id.txt)
if [ "$UNKNOWN" = 404 ] && [ "$WRONG" = 404 ]; then
  pass 1.3 "unknown/wrong Host -> HTTP 404 (unknown=$UNKNOWN wrong=$WRONG), no fallback to a guest"
else
  fail 1.3 "unknown/wrong Host did not 404 (unknown=$UNKNOWN wrong=$WRONG)"
fi
# Cross-check: A's hostname must never return B's body.
A_BODY=$(out_curl -H "Host: $A_HOSTNAME" http://203.0.113.1:8088/id.txt 2>/dev/null || true)
B_BODY=$(out_curl -H "Host: $B_HOSTNAME" http://203.0.113.1:8088/id.txt 2>/dev/null || true)
if [ "$A_BODY" = team-a ] && [ "$B_BODY" = team-b ]; then
  pass 1.4 "simultaneous requests keep teams separate (A='$A_BODY' B='$B_BODY')"
else
  fail 1.4 "team bodies crossed (A='$A_BODY' B='$B_BODY')"
fi

# ===========================================================================
# 2.3/2.4 malformed and partial file-provider documents
# ===========================================================================
note "-- 2.3/2.4 a malformed and a partial YAML file must not break live routes"
printf 'http: [this is not closed\n  routers: {}\n' >"$RUN/agent/traefik/rctf-fc-deadbeefdeadbeefdead.yml"
sleep 2
A_OK=$(out_curl -H "Host: $A_HOSTNAME" http://203.0.113.1:8088/id.txt 2>/dev/null || true)
B_OK=$(out_curl -H "Host: $B_HOSTNAME" http://203.0.113.1:8088/id.txt 2>/dev/null || true)
if [ "$A_OK" = team-a ] && [ "$B_OK" = team-b ]; then
  pass 2.3 "Traefik ignored a malformed YAML file; both live routes still work"
else
  fail 2.3 "malformed YAML broke live routes (A='$A_OK' B='$B_OK')"
fi
rm -f "$RUN/agent/traefik/rctf-fc-deadbeefdeadbeefdead.yml"
cat >"$RUN/agent/traefik/rctf-fc-badbadbadbadbadbadba.yml" <<'YAML'
http:
  routers:
    broken:
      rule: Host(`broken.edge.test`)
      entryPoints: [web]
      service: does-not-exist
YAML
sleep 2
A_OK=$(out_curl -H "Host: $A_HOSTNAME" http://203.0.113.1:8088/id.txt 2>/dev/null || true)
B_OK=$(out_curl -H "Host: $B_HOSTNAME" http://203.0.113.1:8088/id.txt 2>/dev/null || true)
if [ "$A_OK" = team-a ] && [ "$B_OK" = team-b ]; then
  pass 2.4 "partial router (missing service) did not break the other routes"
else
  fail 2.4 "partial router broke live routes (A='$A_OK' B='$B_OK')"
fi
rm -f "$RUN/agent/traefik/rctf-fc-badbadbadbadbadbadba.yml"
sleep 0.5

# ===========================================================================
# 3. real DNAT from the outside netns
# ===========================================================================
note "-- 3. TCP/raw DNAT from the outside netns to the host public port"
GOT_A=$(nsenter -t "$OUT_PID" -n curl -sS -m 5 "http://203.0.113.1:$A_PUB/id.txt" 2>/dev/null || true)
GOT_B=$(nsenter -t "$OUT_PID" -n curl -sS -m 5 "http://203.0.113.1:$B_PUB/id.txt" 2>/dev/null || true)
if [ "$GOT_A" = team-a ]; then
  pass 3.1 "outside client on host port $A_PUB reached only team A's guest"
else
  fail 3.1 "DNAT $A_PUB returned '$GOT_A' instead of team-a"
fi
if [ "$GOT_B" = team-b ]; then
  pass 3.2 "outside client on host port $B_PUB reached only team B's guest"
else
  fail 3.2 "DNAT $B_PUB returned '$GOT_B' instead of team-b"
fi
# A raw port maps to A's 9000; B has no such mapping. Connect to B's published
# port with a request that only A's hold listener would answer? Not possible over
# HTTP; instead assert the two DNAT rules point at different guests (nft) and
# that A's hold port is not B's public port.
if [ "$A_PUB" != "$B_PUB" ] && [ "$A_HOLD" != "$B_PUB" ]; then
  pass 3.3 "per-instance public ports are distinct (A=$A_PUB/$A_HOLD B=$B_PUB); no port is shared"
else
  fail 3.3 "public ports collide between instances (A=$A_PUB/$A_HOLD B=$B_PUB)"
fi
DNAT_RULES=$(nft list table inet rctf_fc | grep 'dnat ip to')
DNAT_OK=1
for pair in "$A_PUB:$A_GUEST:$A_TAP" "$A_HOLD:$A_GUEST:$A_TAP" "$B_PUB:$B_GUEST:$B_TAP" "$B_HOLD:$B_GUEST:$B_TAP"; do
  port=${pair%%:*}; rest=${pair#*:}; guest=${rest%%:*}; tap=${rest##*:}
  echo "$DNAT_RULES" | grep -q "tcp dport $port dnat ip to $guest:.*" || DNAT_OK=0
done
if [ "$DNAT_OK" = 1 ]; then
  pass 3.4 "each public port DNATs to exactly its own lease (A=$A_PUB/$A_HOLD -> $A_GUEST, B=$B_PUB/$B_HOLD -> $B_GUEST)"
else
  fail 3.4 "DNAT mapping is not per-lease: $(echo "$DNAT_RULES" | tr '\n' ' ')"
fi
CLOSED=24099
# Positive control: the published port must connect from the SAME netns/tool
# immediately before the unpublished port is asserted closed. A dead nc (or a
# wrong netns) would otherwise make any port look "closed".
PORT_CTL=$(nsenter -t "$OUT_PID" -n bash -c \
  '. "$1/lib/assert.sh"; if assert_port_closed "$2" "$3" "$4"; then echo ok; else echo fail; fi' \
  _ "$EDGE" 203.0.113.1 "$A_PUB" "$CLOSED")
if [ "$PORT_CTL" = ok ]; then
  pass 3.5 "unpublished port ($CLOSED) is closed while the published port ($A_PUB) connects from the same netns"
else
  fail 3.5 "port probe invalid: published $A_PUB did not connect or unpublished $CLOSED did (positive control required)"
fi

note "-- 3.6/3.7 direct guest reachability and its positive control"
direct_guest() {
  nsenter -t "$OUT_PID" -n curl -sS -m 3 "http://$A_GUEST:8080/id.txt" 2>/dev/null || true
}
DIRECT=$(direct_guest)
if [ -n "$DIRECT" ]; then
  fail 3.6 "outside client reached the guest address $A_GUEST directly, bypassing DNAT (body '$DIRECT')"
else
  pass 3.6 "outside client cannot reach guest address $A_GUEST directly (no bypass)"
fi
# Positive control: prepend accepts for both directions of the direct flow, so
# the identical probe succeeds only because it was allowed; remove them again
# and assert the absence returns. (This proves the probe is sensitive instead
# of a dead curl.)
nft insert rule inet rctf_fc forward ip saddr "$A_GUEST" tcp sport 8080 accept
nft insert rule inet rctf_fc forward ip daddr "$A_GUEST" tcp dport 8080 accept
DIRECT_CTL=$(direct_guest)
del_forward_rule() {
  local spec=$1 h
  h=$(nft -a list chain inet rctf_fc forward | grep -F "$spec" |
    sed -n 's/.*# handle \([0-9]*\).*/\1/p' | tail -1)
  [ -n "$h" ] && nft delete rule inet rctf_fc forward handle "$h"
}
del_forward_rule "ip saddr $A_GUEST tcp sport 8080 accept"
del_forward_rule "ip daddr $A_GUEST tcp dport 8080 accept"
DIRECT_AFTER=$(direct_guest)
if [ "$DIRECT_CTL" = team-a ] && [ -z "$DIRECT_AFTER" ]; then
  pass 3.7 "control: the same direct probe reaches the guest when temporarily allowed, and is blocked again after removing the rules"
else
  fail 3.7 "direct-probe positive control failed (allowed='$DIRECT_CTL' after-removal='$DIRECT_AFTER')"
fi

# ===========================================================================
# 4. egress policy, measured inside the real guests
# ===========================================================================
note "-- 4. egress:false vs egress:true, from inside the real guests (probe loop)"
probe() { # hostname
  out_curl -H "Host: $1" "http://203.0.113.1:8088/probe.txt" 2>/dev/null || true
}
PA=
PB=
for i in $(seq 1 40); do
  PA=$(probe "$A_HOSTNAME")
  PB=$(probe "$B_HOSTNAME")
  if probe_peer_is "$PA" blocked && probe_host_is "$PA" blocked &&
     probe_peer_is "$PB" REACHED && probe_host_is "$PB" blocked; then
    break
  fi
  sleep 1
done
note "A probe: ${PA:-<empty>}"
note "B probe: ${PB:-<empty>}"
if probe_peer_is "$PA" blocked; then
  pass 4.1 "egress:false guest cannot reach the upstream server ($PA)"
else
  fail 4.1 "egress:false guest did not report a valid peer=blocked probe (empty/unparseable fails closed): '${PA:-<empty>}'"
fi
if probe_peer_is "$PB" REACHED; then
  pass 4.2 "egress:true guest reaches the upstream server ($PB)"
else
  fail 4.2 "egress:true guest did NOT report a valid peer=REACHED probe: '${PB:-<empty>}'"
fi
if probe_host_is "$PB" blocked; then
  pass 4.3 "egress:true guest cannot reach the host side of its own tap ($PB)"
else
  fail 4.3 "egress:true guest did not report a valid host=blocked probe: '${PB:-<empty>}'"
fi
if probe_scan_blocked "$PA" && probe_scan_blocked "$PB"; then
  pass 4.4 "neither guest can reach the other guest's address (A and B report a valid scan=blocked)"
else
  fail 4.4 "cross-guest scan was not a valid blocked result (A='${PA:-<empty>}' B='${PB:-<empty>}'); empty/unparseable/error fails closed"
fi

# ---------------------------------------------------------------------------
# 4.5/4.6 controls: while BOTH real guests are still alive, flush the agent
# rules and require (a) the egress-true guest to reach the host side of its tap
# and (b) at least one cross-guest scan to become REACHED. Without (b), a guest
# whose nc probe is broken would report scan=blocked and 4.4/7.2 would pass for
# the wrong reason. The exact pre-flush ruleset is snapshotted and restored.
# ---------------------------------------------------------------------------
note "-- 4.5/4.6 control: flush all agent rules while both guests are alive, then restore them"
RULESET_SNAPSHOT=$RUN/out/ruleset-before-4.5.nft
nft list ruleset >"$RULESET_SNAPSHOT"
nft flush table inet rctf_fc
nft flush table arp rctf_fc_arp
PA2=
PB2=
for i in $(seq 1 30); do
  PA2=$(probe "$A_HOSTNAME")
  PB2=$(probe "$B_HOSTNAME")
  if probe_host_is "$PB2" REACHED &&
     { probe_scan_reached "$PA2" || probe_scan_reached "$PB2"; }; then
    break
  fi
  sleep 1
done
note "A probe after flush: ${PA2:-<empty>}"
note "B probe after flush: ${PB2:-<empty>}"
if probe_host_is "$PB2" REACHED; then
  pass 4.5 "control: with the rules flushed the same guest probe reaches the host tap side ($PB2)"
else
  fail 4.5 "control failed: probe did not report a valid host=REACHED with rules flushed ('${PB2:-<empty>}')"
fi
if probe_scan_reached "$PA2" || probe_scan_reached "$PB2"; then
  pass 4.6 "control: after the flush the cross-guest scan probe is live (scan=REACHED), so blocked scans are not dead-probe results"
else
  fail 4.6 "control failed: no guest reported a valid scan=REACHED after the flush (A='${PA2:-<empty>}' B='${PB2:-<empty>}')"
fi
# Restore the exact pre-flush ruleset: the table objects still exist but are
# empty after `flush table`, so delete them first and re-apply the snapshot.
nft delete table inet rctf_fc 2>/dev/null || true
nft delete table arp rctf_fc_arp 2>/dev/null || true
if ! nft -f "$RULESET_SNAPSHOT"; then
  fail 4.6 "control cleanup failed: could not restore the agent ruleset from $RULESET_SNAPSHOT"
  exit 1
fi
note "agent ruleset restored after the 4.5/4.6 control"

# ===========================================================================
# 7. nmap from the outside netns against the host address
# ===========================================================================
note "-- 7.1 nmap from outside against 203.0.113.1 (all 65535 ports)"
NMAP_XML=$RUN/out/nmap.xml
NMAP_RC=0
NMAP=$(nsenter -t "$OUT_PID" -n timeout 180 nmap -sT -Pn -n -T4 -p- 203.0.113.1 \
  -oG - -oX "$NMAP_XML" 2>/dev/null) || NMAP_RC=$?
OPEN=$(echo "$NMAP" | grep -oE '[0-9]+/open/tcp' | sed 's#/open/tcp##' | sort -n | tr '\n' ' ' | sed 's/ $//')
EXPECT=$(printf '%s\n' 8088 "$A_PUB" "$A_HOLD" "$B_PUB" "$B_HOLD" | sort -n | tr '\n' ' ' | sed 's/ $//')
SCANINFO=$(grep -o '<scaninfo[^>]*>' "$NMAP_XML" 2>/dev/null | head -1)
FULLSCAN=0
if echo "$SCANINFO" | grep -q 'numservices="65535"' &&
   echo "$SCANINFO" | grep -q 'services="1-65535"'; then
  FULLSCAN=1
fi
if [ "$NMAP_RC" -ne 0 ]; then
  fail 7.1 "nmap exited $NMAP_RC (124 = timeout/partial scan); open ports '$OPEN' cannot be trusted"
elif [ "$FULLSCAN" -ne 1 ]; then
  fail 7.1 "nmap did not prove a full 65535-port scan (scaninfo='${SCANINFO:-<missing>}')"
elif [ "$OPEN" = "$EXPECT" ]; then
  pass 7.1 "only published ports are open on the host: $OPEN (nmap exit 0, 65535/65535 ports scanned)"
else
  fail 7.1 "nmap open ports '$OPEN' != expected published '$EXPECT'"
fi

# ===========================================================================
# 5. conntrack through real DNAT, real release, quarantine, no inheritance
# ===========================================================================
note "-- 5. long-lived DNAT flow, real agent delete, real conntrack flush"
conntrack -F >/dev/null 2>&1 || true
nsenter -t "$OUT_PID" -n python3 "$EDGE/lib/hold_client.py" 203.0.113.1 "$A_HOLD" 55555 90 \
  >"$RUN/out/agent-hold-a.log" 2>&1 & PIDS+=("$!")
nsenter -t "$OUT_PID" -n python3 "$EDGE/lib/hold_client.py" 203.0.114.3 "$A_HOLD" 55556 90 \
  >"$RUN/out/agent-hold-unrelated.log" 2>&1 & PIDS+=("$!")
for i in $(seq 1 30); do
  grep -q connected "$RUN/out/agent-hold-a.log" 2>/dev/null &&
    grep -q connected "$RUN/out/agent-hold-unrelated.log" 2>/dev/null && break
  sleep 0.3
done
sleep 0.5
CT=$(conntrack -L 2>/dev/null || true)
if echo "$CT" | grep -q "$A_GUEST" && echo "$CT" | grep -q "dst=203.0.114.3.*dport=$A_HOLD"; then
  pass 5.1 "long-lived DNAT flow to $A_GUEST:$A_HOLD plus an unrelated flow to port $A_HOLD are tracked"
else
  fail 5.1 "expected conntrack entries missing: $(echo "$CT" | grep "$A_GUEST" | head -2)"
fi
HOLD_SEEN=$(cat "$RUN/out/agent-hold-a.log" 2>/dev/null | tr '\n' ' ')
note "hold client A: $HOLD_SEEN"

note "deleting instance A through the real agent"
DEL_CODE=$(api -o "$RUN/out/delete-a.json" -w '%{http_code}' -X DELETE "http://127.0.0.1:7001/v1/instances/$IDA")
note "DELETE A -> $DEL_CODE"

FILE_GONE=0
for i in $(seq 1 40); do
  [ -e "$RUN/agent/traefik/rctf-fc-$IDA.yml" ] || { FILE_GONE=1; break; }
  sleep 0.25
done
if [ "$FILE_GONE" = 1 ] && [ "$DEL_CODE" = 200 ]; then
  pass 2.1 "DELETE removed the per-instance Traefik YAML (HTTP $DEL_CODE)"
else
  fail 2.1 "Traefik YAML still present after DELETE (code=$DEL_CODE)"
fi
A_CODE=
for i in $(seq 1 40); do
  A_CODE=$(http_code "$A_HOSTNAME" /id.txt)
  [ "$A_CODE" = 404 ] && break
  sleep 0.25
done
B_CODE=$(http_code "$B_HOSTNAME" /id.txt)
if [ "$A_CODE" = 404 ] && [ "$B_CODE" = 200 ]; then
  pass 2.2 "deleted route -> 404 while the other team's route still serves 200"
else
  fail 2.2 "after delete: A=$A_CODE B=$B_CODE (want 404/200)"
fi
CT=$(conntrack -L 2>/dev/null || true)
if echo "$CT" | grep -q "$A_GUEST"; then
  fail 5.2 "conntrack still contains $A_GUEST after release: $(echo "$CT" | grep "$A_GUEST" | head -2)"
else
  pass 5.2 "real release flushed every conntrack entry of $A_GUEST before freeing the address"
fi
if echo "$CT" | grep -q "dst=203.0.114.3.*dport=$A_HOLD"; then
  pass 5.3 "the unrelated flow with the same destination port $A_HOLD survived (address-scoped, not port-only)"
else
  fail 5.3 "release also deleted the unrelated flow to port $A_HOLD (port-only deletion regression)"
fi
HOLD_AFTER=$(cat "$RUN/out/agent-hold-a.log" 2>/dev/null | tr '\n' ' ')
for i in $(seq 1 20); do
  case "$HOLD_AFTER" in *closed*) break;; esac
  sleep 0.5
  HOLD_AFTER=$(cat "$RUN/out/agent-hold-a.log" 2>/dev/null | tr '\n' ' ')
done
case "$HOLD_AFTER" in *closed*) pass 5.4 "the held DNAT connection was broken by release ($HOLD_AFTER)";; *) fail 5.4 "held connection still alive after release ($HOLD_AFTER)";; esac

A_INDEX=${A_TAP#fctap}
Q_OK=0
Q_DETAIL=
if [ -f "$RUN/agent/net-quarantine.json" ]; then
  NOW_MS=$(date +%s%3N)
  Q_IDX=$(jq -r --argjson i "$A_INDEX" '[.indexes[]? | select(.id==$i and .expiresAtMs>'"$NOW_MS"')] | length' "$RUN/agent/net-quarantine.json" 2>/dev/null || echo 0)
  Q_P0=$(jq -r --argjson p "$A_PUB" '[.ports[]? | select(.id==$p and .expiresAtMs>'"$NOW_MS"')] | length' "$RUN/agent/net-quarantine.json" 2>/dev/null || echo 0)
  Q_P1=$(jq -r --argjson p "$A_HOLD" '[.ports[]? | select(.id==$p and .expiresAtMs>'"$NOW_MS"')] | length' "$RUN/agent/net-quarantine.json" 2>/dev/null || echo 0)
  Q_DETAIL="index $A_INDEX=$Q_IDX ports $A_PUB=$Q_P0/$A_HOLD=$Q_P1"
  [ "$Q_IDX" = 1 ] && [ "$Q_P0" = 1 ] && [ "$Q_P1" = 1 ] && Q_OK=1
else
  Q_DETAIL="quarantine file missing"
fi
if [ "$Q_OK" = 1 ]; then
  pass 5.5 "released /30 and public ports entered the durable quarantine ($Q_DETAIL)"
else
  fail 5.5 "quarantine missing released resources ($Q_DETAIL)"
fi

note "creating instance C; the quarantined /30 and ports must not be reused"
api -o "$RUN/out/create-c.json" -w '%{http_code}' -X PUT \
  "http://127.0.0.1:7001/v1/instances/$IDC" -d "$(cat <<JSON
{"id":"$IDC","teamKey":"teamcedgekey1234","image":"edge","vcpus":1,"memMiB":256,"diskMiB":64,
 "egress":false,"bootTimeoutSeconds":120,"readiness":{"kind":"tcp","port":8080},
 "env":{"GUEST_NAME":"team-c"},"expose":[{"kind":"tcp","hostPrefix":"raw-c","port":8080}],
 "expiresAtMs":$EXP,"flags":[{"provider":"main","flag":"rctf{edge-c-not-real}"}]}
JSON
)" >"$RUN/out/create-c.code"
for i in $(seq 1 160); do
  st=$(api "http://127.0.0.1:7001/v1/instances/$IDC" | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p')
  [ "$st" = running ] && break
  [ "$st" = errored ] && break
  sleep 0.5
done
CJ=$RUN/agent/state/$IDC.json
C_TAP=$(jq -r '.lease.tapName' "$CJ" 2>/dev/null || true)
C_GUEST=$(jq -r '.lease.guestIp' "$CJ" 2>/dev/null || true)
C_PUB=$(jq -r '.lease.publicPorts["0"]' "$CJ" 2>/dev/null || true)
note "C: state=$st tap=$C_TAP guest=$C_GUEST port=$C_PUB"
if [ "$st" = running ] && [ "$C_TAP" != "$A_TAP" ] && [ "$C_GUEST" != "$A_GUEST" ] &&
   [ "$C_PUB" != "$A_PUB" ] && [ "$C_PUB" != "$A_HOLD" ]; then
  pass 5.6 "post-delete instance got a different /30 and port ($C_TAP $C_GUEST port $C_PUB), quarantine held"
else
  fail 5.6 "quarantine violated: C state=$st tap=$C_TAP guest=$C_GUEST port=$C_PUB"
fi
CT=$(conntrack -L 2>/dev/null || true)
# C holds a DIFFERENT /30 (5.6), so this is not a reuse assertion. It only
# proves the released flow tuple is gone. The real reuse-without-inheritance
# path (same /30 + public port handed to a new guest, quarantine 0) is executed
# in phase-veth 5.9-5.12; the 120 s quarantine here deliberately prevents it.
if echo "$CT" | grep -q "sport=55555"; then
  fail 5.7 "the old released flow tuple (client port 55555) still exists: $(echo "$CT" | grep "sport=55555" | head -2)"
else
  pass 5.7 "old released flow tuple (client port 55555) is gone after release; C holds a different /30, so real reuse is phase-veth 5.9-5.12"
fi
api -o /dev/null -w '%{http_code}' -X DELETE "http://127.0.0.1:7001/v1/instances/$IDC" >/dev/null || true

# ---------------------------------------------------------------------------
# 7.2 real guests: busybox nc scan from guest A to guest B (already collected
# by the probe loop above; A's SCAN_PEER is B's address).
# ---------------------------------------------------------------------------
if probe_scan_blocked "$PA"; then
  pass 7.2 "busybox nc connect from inside real guest A to guest B's address was blocked ($PA; 4.6 shows the probe is live)"
else
  fail 7.2 "real guest A did not report a valid scan=blocked result ('${PA:-<empty>}'); empty/error fails closed"
fi

api -o /dev/null -w '%{http_code}' -X DELETE "http://127.0.0.1:7001/v1/instances/$IDB" >/dev/null || true
echo "RESULT agent done"
