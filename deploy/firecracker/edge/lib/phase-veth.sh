#!/bin/bash
# Phase veth (inside its own network namespace): the agent's REAL rendered
# nftables rules with Linux-netns "guests" on veth pairs. This is what lets us
# inject spoofed IP/MAC/ARP frames and scan from inside a guest without needing
# to modify a Firecracker rootfs; every packet still crosses the real kernel
# forwarding path with the real rules the agent installs.
#
# Checks: anti-spoof (IP, MAC, ARP) with an egress-enabled positive control and
# per-filter rule-deletion mutations, nmap from a guest, and conntrack reuse
# safety when a /30 + public port are handed to a new instance (real
# flushConntrack, the exact same source tuple).
set -u
: "${RUN:?}" "${EDGE:?}" "${REPO:?}"
. "$EDGE/lib/assert.sh"
PIDS=()
cleanup() {
  set +e
  for pid in "${PIDS[@]}"; do kill_child "$pid"; done
}
trap cleanup EXIT INT TERM

pass() { printf 'CHECK %s PASS %s\n' "$1" "${*:2}"; }
fail() { printf 'CHECK %s FAIL %s\n' "$1" "${*:2}"; }
note() { printf 'NOTE %s\n' "$*"; }

A_ID="vetha$(printf '%011d' 1)"
B_ID="vethb$(printf '%011d' 2)"
A2_ID="vethc$(printf '%011d' 3)"
A_TAP=fctap0
A_IP=10.200.0.2
B_IP=10.200.0.6
A_MAC=02:00:00:00:0a:02
B_MAC=02:00:00:00:0b:02
A2_MAC=02:00:00:00:0c:02
A_PUB=24000
A_HOLD=24001
B_PUB=24002
OUT_MAC=            # filled after fctap0 exists

ip link set lo up
echo 1 >/proc/sys/net/ipv4/ip_forward 2>/dev/null || true
sysctl -qw net.ipv4.conf.all.rp_filter=0 2>/dev/null || true
sysctl -qw net.ipv4.conf.default.rp_filter=0 2>/dev/null || true

ip link add br-ext type bridge
ip link set br-ext up
ip addr add 203.0.113.1/24 dev br-ext
ip addr add 203.0.114.1/24 dev br-ext

# --- outside client netns --------------------------------------------------
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

# --- upstream netns (post-forward observation point + egress/hold server) ---
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
  --http 8080 --hold 24000 --hold 24001 --hold 24002 --hold 24003 \
  >"$RUN/out/upstream.log" 2>&1 & UPHOLD_PID=$!
PIDS+=("$UPHOLD_PID")

mkdir -p "$RUN/out/guestA" "$RUN/out/guestB" "$RUN/out/guestA2"
echo A >"$RUN/out/guestA/id.txt"
echo B >"$RUN/out/guestB/id.txt"
echo A2 >"$RUN/out/guestA2/id.txt"

# --- guest A on fctap0 -----------------------------------------------------
unshare -n sleep 900 & GA_PID=$!
sleep 0.3
PIDS+=("$GA_PID")
ip link add fctap0 type veth peer name g0
ip addr add 10.200.0.1/30 dev fctap0
ip link set fctap0 up
ip link set g0 netns "$GA_PID"
nsenter -t "$GA_PID" -n bash -c "
  ip link set g0 name eth0
  ip link set eth0 address $A_MAC
  ip addr add $A_IP/30 dev eth0
  ip link set eth0 up
  ip link set lo up
  ip route add default via 10.200.0.1
"
OUT_MAC=$(ip -o link show dev fctap0 | sed -n 's/.*link\/ether \([0-9a-f:]*\).*/\1/p')
sysctl -qw net.ipv4.conf.fctap0.arp_accept=1 net.ipv4.conf.fctap0.rp_filter=0 2>/dev/null || true
nsenter -t "$GA_PID" -n python3 -m http.server 8080 --bind 0.0.0.0 \
  --directory "$RUN/out/guestA" >"$RUN/out/httpA.log" 2>&1 & HTTPA_PID=$!
PIDS+=("$HTTPA_PID")
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/upstream.py" --hold 9001 \
  >"$RUN/out/holdA.log" 2>&1 & HOLDA_PID=$!
PIDS+=("$HOLDA_PID")

# --- guest B on fctap1 -----------------------------------------------------
unshare -n sleep 900 & GB_PID=$!
sleep 0.3
PIDS+=("$GB_PID")
ip link add fctap1 type veth peer name g1
ip addr add 10.200.0.5/30 dev fctap1
ip link set fctap1 up
ip link set g1 netns "$GB_PID"
nsenter -t "$GB_PID" -n bash -c "
  ip link set g1 name eth0
  ip link set eth0 address $B_MAC
  ip addr add $B_IP/30 dev eth0
  ip link set eth0 up
  ip link set lo up
  ip route add default via 10.200.0.5
"
sysctl -qw net.ipv4.conf.fctap1.arp_accept=1 net.ipv4.conf.fctap1.rp_filter=0 2>/dev/null || true
nsenter -t "$GB_PID" -n python3 -m http.server 8080 --bind 0.0.0.0 \
  --directory "$RUN/out/guestB" >"$RUN/out/httpB.log" 2>&1 & HTTPB_PID=$!
PIDS+=("$HTTPB_PID")
sleep 0.7

# --- leases exactly as the agent would build them --------------------------
cat >"$RUN/out/veth-config.json" <<'JSON'
{
  "publicHost": "203.0.113.1",
  "httpDomain": "veth.test",
  "httpPort": 8088,
  "httpsPort": 8443,
  "tcpSslPort": 8443,
  "tcpPortRange": { "from": 24000, "to": 24099 },
  "subnetPool": "10.200.0.0/16",
  "traefikDynamicDir": "/tmp/unused-traefik",
  "reuseQuarantineSeconds": 120,
  "requireConntrack": true,
  "externalInterface": "br-ext",
  "ownerMarker": "rctf-fc",
  "quarantineFile": "/tmp/unused-quarantine.json",
  "httpEntrypoint": "web",
  "httpsEntrypoint": "websecure",
  "tcpSslEntrypoint": "websecure"
}
JSON
lease_json() { # id tap host guest mac egress "guestPort:publicPort[,guestPort:publicPort]"
  local id=$1 tap=$2 host=$3 guest=$4 mac=$5 egress=$6 exposes=$7
  local ex='[]' pp='{}' i=0 part g pub
  local IFS=,
  for part in $exposes; do
    g=${part%%:*}
    pub=${part##*:}
    ex=$(printf '%s' "$ex" | jq --argjson g "$g" '. + [{kind:"tcp",hostPrefix:"svc",port:$g}]')
    pp=$(printf '%s' "$pp" | jq --arg k "$i" --argjson p "$pub" '. + {($k):$p}')
    i=$((i + 1))
  done
  jq -nc --arg id "$id" --arg tap "$tap" --arg host "$host" --arg guest "$guest" \
    --arg mac "$mac" --argjson ex "$ex" --argjson pp "$pp" --argjson eg "$egress" \
    '{instanceId:$id,tapName:$tap,hostIp:$host,guestIp:$guest,prefixLength:30,
      guestMac:$mac,expose:$ex,publicPorts:$pp,publicHostnames:{},egress:$eg}'
}
render_apply() { # fenced-id-or-empty
  local fenced="$1"
  local spec="$RUN/out/veth-spec.json"
  {
    printf '{"config":'
    cat "$RUN/out/veth-config.json"
    printf ',"leases":['
    lease_json "$A_ID" fctap0 10.200.0.1 "$A_IP" "$A_MAC" true "8080:$A_PUB,9001:$A_HOLD"
    printf ','
    lease_json "$B_ID" fctap1 10.200.0.5 "$B_IP" "$B_MAC" true "8080:$B_PUB"
    printf ']'
    if [ -n "$fenced" ]; then printf ',"fenced":["%s"]' "$fenced"; fi
    printf '}'
  } >"$spec"
  bun "$EDGE/lib/net-tools.ts" render "$spec" | nft -f - || {
    echo "nft apply failed" >&2
    return 1
  }
}

apply_full() { render_apply ""; }
flush_inet() { nft flush table inet rctf_fc; }
flush_arp() { nft flush table arp rctf_fc_arp; }

apply_full || { fail 0 "could not install the rendered ruleset"; exit 1; }
note "installed rules: $(nft list table inet rctf_fc | grep -c 'fctap') tap references"

# ===========================================================================
# 6. anti-spoof with flushed-rules controls
# ===========================================================================
# ===========================================================================
# 6. anti-spoof
#
# The spoof probes run with egress ENABLED on both leases. With egress disabled
# the general "no new flows" rule plus the final `iifname "fctap*" drop` would
# block the packets even if the MAC/IP anti-spoof rules were removed, so the
# probes would not be sensitive to those rules. Egress enabled removes the
# first blocker; the selective mutations below prove each filter is still what
# stops the spoof in the otherwise-allowed path.
# ===========================================================================
fwd_rule_handle() { # exact rule text -> handle in chain forward
  nft -a list chain inet rctf_fc forward |
    grep -F -- "$1" | sed -n 's/.*# handle \([0-9]*\).*/\1/p' | tail -1
}
insert_before_tap_drop() { # nft rule expressions...
  local idx
  idx=$(nft -a list chain inet rctf_fc forward | awk '
    /^[[:space:]]+.*# handle [0-9]+$/ {
      n++
      if (index($0, "iifname \"fctap*\" drop")) { print n; exit }
    }')
  [ -n "$idx" ] || return 1
  nft add rule inet rctf_fc forward position "$idx" "$@"
}

note "-- 6.0 positive control: a correctly sourced packet from guest A is forwarded"
nsenter -t "$UP_PID" -n python3 "$EDGE/lib/sniff.py" eth0 udp 2.5 \
  "$RUN/out/sniff-legit.json" --dport 9996 >/dev/null 2>&1 & SN=$!
sleep 0.3
LEGIT_RC=0
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" ip eth0 "$A_IP" 203.0.114.3 9996 LEGIT-PACKET >/dev/null || LEGIT_RC=$?
SN_RC=0
wait $SN || SN_RC=$?
if [ "$LEGIT_RC" -ne 0 ] || [ "$SN_RC" -ne 0 ]; then
  fail 6.0 "positive-control probe failed (send=$LEGIT_RC sniff=$SN_RC); the forwarding path is not proven"
elif grep -q '"payload": "LEGIT-PACKET"' "$RUN/out/sniff-legit.json" 2>/dev/null; then
  pass 6.0 "a correctly sourced packet from guest A is forwarded with the rules installed (positive control)"
else
  fail 6.0 "a correctly sourced packet from guest A was NOT forwarded with the rules installed; later 'dropped' results would be meaningless"
fi

note "-- 6.1 spoofed source IP from guest A (claims guest B's address)"
nsenter -t "$UP_PID" -n python3 "$EDGE/lib/sniff.py" eth0 udp 2.5 \
  "$RUN/out/sniff-ip-blocked.json" --dport 9998 >/dev/null 2>&1 & SN=$!
sleep 0.3
SPOOF_RC=0
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" ip eth0 "$B_IP" 203.0.114.3 9998 SPOOF-IP >/dev/null || SPOOF_RC=$?
SN_RC=0
wait $SN || SN_RC=$?
if [ "$SPOOF_RC" -ne 0 ]; then
  fail 6.1 "spoofed-IP injection failed (exit $SPOOF_RC); the drop is not proven"
elif [ "$SN_RC" -ne 0 ]; then
  fail 6.1 "upstream sniffer failed (exit $SN_RC); the drop is not proven"
elif [ -s "$RUN/out/sniff-ip-blocked.json" ]; then
  fail 6.1 "spoofed IP packet reached upstream: $(cat "$RUN/out/sniff-ip-blocked.json")"
else
  pass 6.1 "packet with saddr $B_IP from guest A was dropped (upstream saw none; probe exit 0; egress enabled)"
fi

# Selective mutation: give the spoofed packet an otherwise-allowed path just
# before the final tap drop. With the IP filter installed it must still be
# dropped (proves the filter, not the final drop, is doing the work); deleting
# ONLY that filter by handle must let the identical packet through.
IP_HANDLE=$(fwd_rule_handle "iifname \"$A_TAP\" ip saddr != $A_IP drop")
if ! insert_before_tap_drop iifname "$A_TAP" ip saddr "$B_IP" accept; then
  fail 6.1b "could not install the otherwise-allowed path for the selective IP mutation"
elif [ -z "$IP_HANDLE" ]; then
  fail 6.1b "could not find the forward IP anti-spoof rule handle"
else
  nsenter -t "$UP_PID" -n python3 "$EDGE/lib/sniff.py" eth0 udp 2.5 \
    "$RUN/out/sniff-ip-select-before.json" --dport 9998 >/dev/null 2>&1 & SN=$!
  sleep 0.3
  SPOOF_RC=0
  nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" ip eth0 "$B_IP" 203.0.114.3 9998 SPOOF-IP-SELECT >/dev/null || SPOOF_RC=$?
  SN_RC=0
  wait $SN || SN_RC=$?
  if [ "$SPOOF_RC" -ne 0 ] || [ "$SN_RC" -ne 0 ]; then
    fail 6.1b "selective IP-mutation probe failed (send=$SPOOF_RC sniff=$SN_RC)"
  elif [ -s "$RUN/out/sniff-ip-select-before.json" ]; then
    fail 6.1b "the spoofed-IP packet bypassed the IP filter even though only an otherwise-allowed path was added"
  else
    pass 6.1b "control: with an otherwise-allowed path present the IP filter alone still drops the spoofed source $B_IP"
  fi

  nft delete rule inet rctf_fc forward handle "$IP_HANDLE" || fail 6.1c "could not delete only the forward IP anti-spoof rule (handle $IP_HANDLE)"
  nsenter -t "$UP_PID" -n python3 "$EDGE/lib/sniff.py" eth0 udp 2.5 \
    "$RUN/out/sniff-ip-select-deleted.json" --dport 9998 >/dev/null 2>&1 & SN=$!
  sleep 0.3
  SPOOF_RC=0
  nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" ip eth0 "$B_IP" 203.0.114.3 9998 SPOOF-IP-SELECT2 >/dev/null || SPOOF_RC=$?
  SN_RC=0
  wait $SN || SN_RC=$?
  if [ "$SPOOF_RC" -ne 0 ] || [ "$SN_RC" -ne 0 ]; then
    fail 6.1c "selective IP-mutation probe failed (send=$SPOOF_RC sniff=$SN_RC)"
  elif grep -q '"ip_src": "10.200.0.6"' "$RUN/out/sniff-ip-select-deleted.json" 2>/dev/null; then
    pass 6.1c "selective mutation: deleting ONLY the IP anti-spoof rule lets the identical spoofed-IP packet through"
  else
    fail 6.1c "deleting only the IP anti-spoof rule did not let the spoofed-IP packet through; the assertion is not sensitive to that rule"
  fi
  apply_full
  nsenter -t "$UP_PID" -n python3 "$EDGE/lib/sniff.py" eth0 udp 2.5 \
    "$RUN/out/sniff-ip-select-restored.json" --dport 9998 >/dev/null 2>&1 & SN=$!
  sleep 0.3
  SPOOF_RC=0
  nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" ip eth0 "$B_IP" 203.0.114.3 9998 SPOOF-IP-SELECT3 >/dev/null || SPOOF_RC=$?
  SN_RC=0
  wait $SN || SN_RC=$?
  if [ "$SPOOF_RC" -ne 0 ] || [ "$SN_RC" -ne 0 ]; then
    fail 6.1d "restored-rules probe failed (send=$SPOOF_RC sniff=$SN_RC)"
  elif [ -s "$RUN/out/sniff-ip-select-restored.json" ]; then
    fail 6.1d "the spoofed-IP packet still passed after restoring the ruleset"
  else
    pass 6.1d "restoring the real ruleset blocks the same spoofed-IP packet again"
  fi
fi

nsenter -t "$UP_PID" -n python3 "$EDGE/lib/sniff.py" eth0 udp 3 \
  "$RUN/out/sniff-ip-control.json" --dport 9998 >/dev/null 2>&1 & SN=$!
sleep 0.3
flush_inet
SPOOF_RC=0
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" ip eth0 "$B_IP" 203.0.114.3 9998 SPOOF-IP-CONTROL >/dev/null || SPOOF_RC=$?
SN_RC=0
wait $SN || SN_RC=$?
if [ "$SPOOF_RC" -ne 0 ] || [ "$SN_RC" -ne 0 ]; then
  fail 6.2 "control probe failed (spoof=$SPOOF_RC sniff=$SN_RC)"
elif grep -q '"ip_src": "10.200.0.6"' "$RUN/out/sniff-ip-control.json" 2>/dev/null; then
  pass 6.2 "control: with inet rules flushed the same spoofed-IP packet is forwarded and observed"
else
  fail 6.2 "control failed: spoofed-IP packet not observable even with rules flushed"
fi
apply_full

note "-- 6.3 spoofed source MAC from guest A (claims guest B's MAC)"
nsenter -t "$UP_PID" -n python3 "$EDGE/lib/sniff.py" eth0 udp 2.5 \
  "$RUN/out/sniff-mac-blocked.json" --dport 9999 >/dev/null 2>&1 & SN=$!
sleep 0.3
SPOOF_RC=0
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" eth eth0 "$B_MAC" "$OUT_MAC" \
  "$A_IP" 203.0.114.3 9999 SPOOF-MAC >/dev/null || SPOOF_RC=$?
SN_RC=0
wait $SN || SN_RC=$?
if [ "$SPOOF_RC" -ne 0 ]; then
  fail 6.3 "spoofed-MAC injection failed (exit $SPOOF_RC); the drop is not proven"
elif [ "$SN_RC" -ne 0 ]; then
  fail 6.3 "upstream sniffer failed (exit $SN_RC); the drop is not proven"
elif [ -s "$RUN/out/sniff-mac-blocked.json" ]; then
  fail 6.3 "frame with ether saddr $B_MAC reached upstream: $(cat "$RUN/out/sniff-mac-blocked.json")"
else
  pass 6.3 "frame with ether saddr $B_MAC from guest A was dropped (probe exit 0; egress enabled)"
fi

# Selective mutation: with egress enabled, a frame whose source IP is the
# lease address is otherwise accepted by the egress rule. Delete ONLY the
# Ethernet-source filter and the identical frame must be forwarded.
MAC_HANDLE=$(fwd_rule_handle "iifname \"$A_TAP\" ether saddr != $A_MAC drop")
if [ -z "$MAC_HANDLE" ]; then
  fail 6.3a "could not find the forward Ethernet anti-spoof rule handle"
else
  nft delete rule inet rctf_fc forward handle "$MAC_HANDLE" || fail 6.3a "could not delete only the forward MAC anti-spoof rule (handle $MAC_HANDLE)"
  nsenter -t "$UP_PID" -n python3 "$EDGE/lib/sniff.py" eth0 udp 2.5 \
    "$RUN/out/sniff-mac-select-deleted.json" --dport 9999 >/dev/null 2>&1 & SN=$!
  sleep 0.3
  SPOOF_RC=0
  nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" eth eth0 "$B_MAC" "$OUT_MAC" \
    "$A_IP" 203.0.114.3 9999 SPOOF-MAC-SELECT >/dev/null || SPOOF_RC=$?
  SN_RC=0
  wait $SN || SN_RC=$?
  if [ "$SPOOF_RC" -ne 0 ] || [ "$SN_RC" -ne 0 ]; then
    fail 6.3a "selective MAC-mutation probe failed (send=$SPOOF_RC sniff=$SN_RC)"
  elif grep -q '"payload": "SPOOF-MAC-SELECT"' "$RUN/out/sniff-mac-select-deleted.json" 2>/dev/null; then
    pass 6.3a "selective mutation: deleting ONLY the Ethernet anti-spoof rule lets the identical spoofed-MAC frame through"
  else
    fail 6.3a "deleting only the Ethernet anti-spoof rule did not let the spoofed-MAC frame through; the assertion is not sensitive to that rule"
  fi
  apply_full
  nsenter -t "$UP_PID" -n python3 "$EDGE/lib/sniff.py" eth0 udp 2.5 \
    "$RUN/out/sniff-mac-select-restored.json" --dport 9999 >/dev/null 2>&1 & SN=$!
  sleep 0.3
  SPOOF_RC=0
  nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" eth eth0 "$B_MAC" "$OUT_MAC" \
    "$A_IP" 203.0.114.3 9999 SPOOF-MAC-SELECT2 >/dev/null || SPOOF_RC=$?
  SN_RC=0
  wait $SN || SN_RC=$?
  if [ "$SPOOF_RC" -ne 0 ] || [ "$SN_RC" -ne 0 ]; then
    fail 6.3b "restored-rules probe failed (send=$SPOOF_RC sniff=$SN_RC)"
  elif [ -s "$RUN/out/sniff-mac-select-restored.json" ]; then
    fail 6.3b "the spoofed-MAC frame still passed after restoring the ruleset"
  else
    pass 6.3b "restoring the real ruleset blocks the same spoofed-MAC frame again"
  fi
fi

nsenter -t "$UP_PID" -n python3 "$EDGE/lib/sniff.py" eth0 udp 3 \
  "$RUN/out/sniff-mac-control.json" --dport 9999 >/dev/null 2>&1 & SN=$!
sleep 0.3
flush_inet
SPOOF_RC=0
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" eth eth0 "$B_MAC" "$OUT_MAC" \
  "$A_IP" 203.0.114.3 9999 SPOOF-MAC-CONTROL >/dev/null || SPOOF_RC=$?
SN_RC=0
wait $SN || SN_RC=$?
if [ "$SPOOF_RC" -ne 0 ] || [ "$SN_RC" -ne 0 ]; then
  fail 6.4 "control probe failed (spoof=$SPOOF_RC sniff=$SN_RC)"
elif grep -q "\"payload\": \"SPOOF-MAC-CONTROL\"" "$RUN/out/sniff-mac-control.json" 2>/dev/null; then
  pass 6.4 "control: with inet rules flushed the spoofed-MAC frame is forwarded and observed"
else
  fail 6.4 "control failed: spoofed-MAC frame not observable even with rules flushed"
fi
apply_full

note "-- 6.5 ARP: reply from guest A with guest B's MAC (same guest IP)"
ip neigh replace "$A_IP" lladdr "$A_MAC" nud stale dev fctap0 2>/dev/null || true
sleep 1.2
SPOOF_RC=0
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" arp eth0 2 "$B_MAC" "$A_IP" "$OUT_MAC" 10.200.0.1 >/dev/null || SPOOF_RC=$?
sleep 0.3
if [ "$SPOOF_RC" -ne 0 ]; then
  fail 6.5 "ARP spoof injection failed (exit $SPOOF_RC); the drop is not proven"
elif ip neigh show dev fctap0 | grep -q "^$A_IP .*lladdr $B_MAC"; then
  fail 6.5 "host accepted ARP $A_IP -> $B_MAC from guest A (ARP ether-saddr spoof)"
else
  pass 6.5 "ARP reply with ether saddr $B_MAC from guest A was dropped (host kept $A_MAC; probe exit 0)"
fi
ip neigh replace "$A_IP" lladdr "$A_MAC" nud stale dev fctap0 2>/dev/null || true
sleep 1.2
flush_arp
SPOOF_RC=0
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" arp eth0 2 "$B_MAC" "$A_IP" "$OUT_MAC" 10.200.0.1 >/dev/null || SPOOF_RC=$?
sleep 0.3
if [ "$SPOOF_RC" -ne 0 ]; then
  fail 6.6 "control probe failed (spoof exit $SPOOF_RC)"
elif ip neigh show dev fctap0 | grep -q "^$A_IP .*lladdr $B_MAC"; then
  pass 6.6 "control: with the ARP table flushed the spoofed reply updates the neighbour (probe is sensitive)"
else
  fail 6.6 "control failed: spoofed ARP reply not observable with ARP rules flushed"
fi
apply_full

note "-- 6.7 ARP: spoofed sender IP (claims guest B's address) and the host reply"
ip neigh flush dev fctap0 2>/dev/null || true
# Positive control: a legit request is answered with the rules installed.
SPOOF_RC=0
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" arp eth0 1 "$A_MAC" "$A_IP" ff:ff:ff:ff:ff:ff 10.200.0.1 >/dev/null || SPOOF_RC=$?
sleep 0.3
if [ "$SPOOF_RC" -ne 0 ]; then
  fail 6.7 "positive control probe failed (spoof exit $SPOOF_RC)"
elif ip neigh show dev fctap0 | grep -q "^$A_IP .*lladdr $A_MAC"; then
  pass 6.7 "legit ARP request from guest A is accepted with the ARP rules installed (positive control)"
else
  fail 6.7 "positive control failed: legit ARP request from guest A was not learned"
fi
# A request whose sender claims guest B's address must be dropped. Observable:
# with the rules installed the host emits no ARP reply into guest A. The
# secondary /30 address makes guest B's address ON-LINK for fctap0, so an
# unfiltered kernel would process the spoofed sender (sensitivity control);
# the agent's ARP rule must still drop it.
ip addr add 10.200.0.0/24 dev fctap0 2>/dev/null || true
ip neigh flush dev fctap0 2>/dev/null || true
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/sniff.py" eth0 arp 2.5 \
  "$RUN/out/sniff-arp-blocked.json" >/dev/null 2>&1 & SN=$!
sleep 0.3
SPOOF_RC=0
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" arp eth0 1 "$A_MAC" "$B_IP" ff:ff:ff:ff:ff:ff 10.200.0.1 >/dev/null || SPOOF_RC=$?
SN_RC=0
wait $SN || SN_RC=$?
if [ "$SPOOF_RC" -ne 0 ]; then
  fail 6.8 "ARP spoof injection failed (exit $SPOOF_RC); the drop is not proven"
elif [ "$SN_RC" -ne 0 ]; then
  fail 6.8 "guest-side sniffer failed (exit $SN_RC); the drop is not proven"
elif grep -q '"target_ip": "10.200.0.6"' "$RUN/out/sniff-arp-blocked.json" 2>/dev/null; then
  fail 6.8 "host answered the ARP request whose sender was spoofed as $B_IP"
else
  pass 6.8 "ARP request with spoofed sender $B_IP from guest A was dropped (no host reply; probe exit 0)"
fi
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/sniff.py" eth0 arp 3 \
  "$RUN/out/sniff-arp-control.json" >/dev/null 2>&1 & SN=$!
sleep 0.3
flush_arp
SPOOF_RC=0
nsenter -t "$GA_PID" -n python3 "$EDGE/lib/spoof.py" arp eth0 1 "$A_MAC" "$B_IP" ff:ff:ff:ff:ff:ff 10.200.0.1 >/dev/null || SPOOF_RC=$?
SN_RC=0
wait $SN || SN_RC=$?
if [ "$SPOOF_RC" -ne 0 ] || [ "$SN_RC" -ne 0 ]; then
  fail 6.9 "control probe failed (spoof=$SPOOF_RC sniff=$SN_RC)"
elif grep -q '"target_ip": "10.200.0.6"' "$RUN/out/sniff-arp-control.json" 2>/dev/null; then
  pass 6.9 "control: with the ARP table flushed the host answers the spoofed-sender request"
else
  fail 6.9 "control failed: spoofed ARP request not observable with ARP rules flushed"
fi
ip addr del 10.200.0.0/24 dev fctap0 2>/dev/null || true
apply_full

# ===========================================================================
# 7.2 nmap from inside guest A against guest B
# ===========================================================================
note "-- 7.2 nmap from guest A against guest B ($B_IP)"
NMAP_PORTS=8080,9000,22
NMAP_RC=0
NMAP_BLOCKED=$(nsenter -t "$GA_PID" -n timeout 40 nmap -sT -Pn -n -T4 \
  -p "$NMAP_PORTS" "$B_IP" -oG - 2>"$RUN/out/nmap-blocked.err") || NMAP_RC=$?
if ! nmap_report_complete "$NMAP_RC" "$NMAP_BLOCKED" "$NMAP_PORTS"; then
  fail 7.2 "nmap failed or produced an incomplete/unparseable report (exit $NMAP_RC); 'no open ports' is not proven: $(printf '%s' "$NMAP_BLOCKED" | tr '\n' ' ') $(tr '\n' ' ' <"$RUN/out/nmap-blocked.err")"
elif printf '%s\n' "$NMAP_BLOCKED" | grep -Eq '/(open|open\|filtered)/'; then
  fail 7.2 "guest A can reach guest B: $(printf '%s\n' "$NMAP_BLOCKED" | grep -o '[0-9]*/open' | tr '\n' ' ')"
else
  pass 7.2 "nmap from guest A shows no open ports on guest B (exit 0, all 3 ports reported; cross-tap forwarding dropped)"
fi
# Control: without the inet rules the same scan must find guest B's server.
flush_inet
NMAP_RC=0
NMAP_CONTROL=$(nsenter -t "$GA_PID" -n timeout 40 nmap -sT -Pn -n -T4 \
  -p "$NMAP_PORTS" "$B_IP" -oG - 2>"$RUN/out/nmap-control.err") || NMAP_RC=$?
if ! nmap_report_complete "$NMAP_RC" "$NMAP_CONTROL" "$NMAP_PORTS"; then
  fail 7.3 "control nmap failed or produced an incomplete/unparseable report (exit $NMAP_RC): $(printf '%s' "$NMAP_CONTROL" | tr '\n' ' ') $(tr '\n' ' ' <"$RUN/out/nmap-control.err")"
elif printf '%s\n' "$NMAP_CONTROL" | grep -q '8080/open'; then
  pass 7.3 "control: with inet rules flushed the same nmap scan finds guest B's 8080 (exit 0, complete report)"
else
  fail 7.3 "control failed: nmap cannot see guest B even with rules flushed"
fi
apply_full

# ===========================================================================
# 5.6-5.9 conntrack reuse: /30 + public port handed to a new instance
# ===========================================================================
note "-- 5.6 long-lived DNAT flow, release flush, and reuse of the same /30/port"
conntrack -F >/dev/null 2>&1 || true
tuple_line() { # sport dport -> the matching conntrack line (first)
  conntrack_list | grep -F "sport=$1 " | grep -F "dport=$2 " | head -1
}
tuple_exact() { # line src dst sport dport rsrc rdst rsport rdport
  printf '%s' "$1" |
    grep -qF "src=$2 dst=$3 sport=$4 dport=$5 src=$6 dst=$7 sport=$8 dport=$9"
}
nsenter -t "$OUT_PID" -n python3 "$EDGE/lib/hold_client.py" 203.0.113.1 "$A_HOLD" 55555 60 \
  >"$RUN/out/hold-a.log" 2>&1 & HOLD_A=$!
PIDS+=("$HOLD_A")
nsenter -t "$OUT_PID" -n python3 "$EDGE/lib/hold_client.py" 203.0.114.3 "$A_HOLD" 55556 60 \
  >"$RUN/out/hold-unrelated.log" 2>&1 & HOLD_U=$!
PIDS+=("$HOLD_U")
sleep 1
CT_RC=0
CT=$(conntrack_list) || CT_RC=$?
if [ "$CT_RC" -ne 0 ]; then
  fail 5.6 "conntrack -L failed (exit $CT_RC); the DNAT flow is not proven; hold logs: $(cat "$RUN/out/hold-a.log" "$RUN/out/hold-unrelated.log" | tr '\n' ' ')"
elif echo "$CT" | grep -q "$A_IP" && echo "$CT" | grep -q "dst=203.0.114.3.*dport=$A_HOLD"; then
  pass 5.6 "DNAT flow ($A_IP) and unrelated flow to port $A_HOLD tracked in conntrack (conntrack -L exit 0)"
else
  fail 5.6 "expected conntrack entries missing; hold logs: $(cat "$RUN/out/hold-a.log" "$RUN/out/hold-unrelated.log" | tr '\n' ' '); ct: $(echo "$CT" | head -3 | tr '\n' ' ')"
fi
ORIG_LINE=$(tuple_line 55555 "$A_HOLD")
if tuple_exact "$ORIG_LINE" 203.0.113.2 203.0.113.1 55555 "$A_HOLD" "$A_IP" 203.0.113.2 9001 55555; then
  pass 5.6b "the old flow has the exact tuple 203.0.113.2:55555 -> 203.0.113.1:$A_HOLD = $A_IP:9001"
else
  fail 5.6b "the old flow tuple is not the expected one: '${ORIG_LINE:-<missing>}'"
fi

# Release step (a): fence, then drop the interface, then the REAL flush.
render_apply "$A_ID" | nft -f -
ip link del fctap0 2>/dev/null || true
# Keep the hold socket OPEN through the fence/tap-removal/flush: it is the only
# thing that keeps the exact 5-tuple alive. Asserting the tuple is still there
# immediately BEFORE the flush is what makes the flush (not an RST or the link
# deletion) responsible for its disappearance.
HOLD_STATE=$(cat "$RUN/out/hold-a.log" 2>/dev/null | tr '\n' ' ')
if ! conntrack_has_ip "$A_IP"; then
  fail 5.6a "the guest flow vanished after fence/tap removal, before the flush (hold='$HOLD_STATE'); the flush is not proven"
elif ! tuple_exact "$(tuple_line 55555 "$A_HOLD")" 203.0.113.2 203.0.113.1 55555 "$A_HOLD" "$A_IP" 203.0.113.2 9001 55555; then
  fail 5.6a "the exact old tuple changed before the flush: '$(tuple_line 55555 "$A_HOLD")'"
elif ! echo "$HOLD_STATE" | grep -q connected; then
  fail 5.6a "hold socket was not connected before the flush (hold='$HOLD_STATE')"
else
  pass 5.6a "the exact old tuple is still tracked after the fenced ruleset and tap removal, immediately before the flush (hold socket open)"
fi
FLUSH_RC=0
bun "$EDGE/lib/net-tools.ts" flush "$A_IP" >"$RUN/out/flush-a.log" 2>&1 || FLUSH_RC=$?
sleep 0.3
CT_RC=0
CT=$(conntrack_list) || CT_RC=$?
if [ "$FLUSH_RC" -ne 0 ]; then
  fail 5.7 "real flushConntrack exited $FLUSH_RC (must be 0): $(cat "$RUN/out/flush-a.log" | tr '\n' ' ')"
elif [ "$CT_RC" -ne 0 ]; then
  fail 5.7 "conntrack -L failed after the flush (exit $CT_RC); absence of $A_IP is not proven"
elif echo "$CT" | grep -q "$A_IP"; then
  fail 5.7 "conntrack still has $A_IP after the real flush: $(echo "$CT" | grep "$A_IP")"
else
  pass 5.7 "real flushConntrack (exit 0) removed every entry for $A_IP (conntrack -L exit 0)"
fi
if [ "$CT_RC" -ne 0 ]; then
  fail 5.8 "conntrack -L failed (exit $CT_RC); survival of the unrelated flow is not proven"
elif echo "$CT" | grep -q "dst=203.0.114.3.*dport=$A_HOLD"; then
  pass 5.8 "unrelated flow with the SAME destination port $A_HOLD survived (no port-only deletion)"
else
  fail 5.8 "address-scoped flush also removed the unrelated flow to port $A_HOLD"
fi
kill "$HOLD_A" 2>/dev/null || true

# Reuse the exact /30 and public port for a NEW instance (quarantine 0 here on
# purpose: this is the dangerous path the production quarantine protects).
unshare -n sleep 900 & GA2_PID=$!
sleep 0.3
PIDS+=("$GA2_PID")
ip link add fctap0 type veth peer name g2
ip addr add 10.200.0.1/30 dev fctap0
ip link set fctap0 up
ip link set g2 netns "$GA2_PID"
nsenter -t "$GA2_PID" -n bash -c "
  ip link set g2 name eth0
  ip link set eth0 address $A2_MAC
  ip addr add $A_IP/30 dev eth0
  ip link set eth0 up
  ip link set lo up
  ip route add default via 10.200.0.1
"
sysctl -qw net.ipv4.conf.fctap0.arp_accept=1 2>/dev/null || true
nsenter -t "$GA2_PID" -n python3 -m http.server 8080 --bind 0.0.0.0 \
  --directory "$RUN/out/guestA2" >"$RUN/out/httpA2.log" 2>&1 & HTTPA2=$!
PIDS+=("$HTTPA2")
# Same mapped guest port as the old hold service (:9001), but a different
# service identity, so "the reuse reached the NEW guest" is observable on the
# exact port that the old tuple used.
nsenter -t "$GA2_PID" -n python3 -m http.server 9001 --bind 0.0.0.0 \
  --directory "$RUN/out/guestA2" >"$RUN/out/httpA2-hold.log" 2>&1 & HTTPA2HOLD=$!
PIDS+=("$HTTPA2HOLD")
sleep 0.7
{
  printf '{"config":'
  cat "$RUN/out/veth-config.json"
  printf ',"leases":['
  lease_json "$A2_ID" fctap0 10.200.0.1 "$A_IP" "$A2_MAC" true "8080:$A_PUB,9001:$A_HOLD"
  printf ','
  lease_json "$B_ID" fctap1 10.200.0.5 "$B_IP" "$B_MAC" true "8080:$B_PUB"
  printf ']}'
} >"$RUN/out/veth-reuse-spec.json"
bun "$EDGE/lib/net-tools.ts" render "$RUN/out/veth-reuse-spec.json" | nft -f -
CT_RC=0
CT=$(conntrack_list) || CT_RC=$?
if [ "$CT_RC" -ne 0 ]; then
  fail 5.9 "conntrack -L failed (exit $CT_RC); the absence of inherited state on the reused /30 is not proven"
elif echo "$CT" | grep -q "$A_IP"; then
  fail 5.9 "reused /30 inherited a conntrack entry before any new flow: $(echo "$CT" | grep "$A_IP")"
else
  pass 5.9 "reused /30 has no inherited conntrack state before the new instance is contacted (conntrack -L exit 0)"
fi
# Reopen the EXACT old 5-tuple (same client address/port, same public port) on
# the reused /30. The replacement service on guest :9001 answers with a
# different identity, and the conntrack entry must show the identical original
# and reply tuples - not merely "some flow to the new guest".
NEW_BODY=$(nsenter -t "$OUT_PID" -n curl -sS -m 5 --local-port 55555 \
  "http://203.0.113.1:$A_HOLD/id.txt" 2>/dev/null || true)
if [ "$NEW_BODY" = A2 ]; then
  pass 5.10 "the exact old client port 55555 / public port $A_HOLD now reaches the NEW guest (identity '$NEW_BODY')"
else
  fail 5.10 "reused port reached '$NEW_BODY' instead of the new guest A2"
fi
CT_RC=0
CT=$(conntrack_list) || CT_RC=$?
NEW_LINE=$(tuple_line 55555 "$A_HOLD")
if [ "$CT_RC" -ne 0 ]; then
  fail 5.11 "conntrack -L failed (exit $CT_RC); the new flow is not proven"
elif tuple_exact "$NEW_LINE" 203.0.113.2 203.0.113.1 55555 "$A_HOLD" "$A_IP" 203.0.113.2 9001 55555; then
  pass 5.11 "the reused flow has the identical 5-tuple (203.0.113.2:55555 -> 203.0.113.1:$A_HOLD = $A_IP:9001) as a FRESH entry"
else
  fail 5.11 "no fresh conntrack entry with the exact reused tuple (got '${NEW_LINE:-<missing>}')"
fi
if [ "$CT_RC" -ne 0 ]; then
  fail 5.12 "conntrack -L failed (exit $CT_RC); survival of the unrelated flow is not proven"
elif echo "$CT" | grep -q "dst=203.0.114.3.*dport=$A_HOLD"; then
  pass 5.12 "the unrelated flow is still alive after the whole reuse sequence"
else
  fail 5.12 "the unrelated flow was lost during the reuse sequence"
fi

echo "RESULT veth done"
