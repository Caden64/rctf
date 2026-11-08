#!/usr/bin/env bash
# Check f) release/delete flushes real conntrack state and the reuse quarantine
# keeps the freed /30 index and public port away from the next tenant.
. "$(dirname "$0")/lib.sh"

ID=vmtest$(date +%s)c1
ID2=vmtest$(date +%s)c2
FLAG="rctf{vmtest-conntrack-$(date +%s)}"
SPEC=/tmp/vmtest-spec-$ID.json

section "f) conntrack flush and reuse quarantine"
net_setup
outside_http_start || true

make_spec "$SPEC" "$ID" vmtest false "$FLAG" "" ""
CODE=$(api_code PUT "/v1/instances/$ID" "$SPEC")
rm -f "$SPEC"
echo "  create: HTTP $CODE"
if [ "$CODE" != 200 ] && [ "$CODE" != 201 ]; then bad "create failed (HTTP $CODE)"; finish; exit 1; fi
if wait_state "$ID" running 180; then ok "instance running"; else bad "instance not running"; finish; exit 1; fi

GUEST=$(lease_guest_ip "$ID")
TAP=$(lease_tap "$ID")
PUB=$(lease_port "$ID")
INDEX=${TAP#fctap}
PID=$(vm_pid "$ID")
echo "  guest=$GUEST tap=$TAP index=$INDEX public=$PUB pid=$PID"

# One real TCP connection through DNAT, held open with nc.
systemctl reset-failed fc-vmtest-hold >/dev/null 2>&1 || true
systemd-run --unit=fc-vmtest-hold --collect \
  nsenter --net="/run/netns/$OUT_NS" sh -c "sleep 30 | nc $OUT_HOST_IP $PUB >/dev/null" >/dev/null 2>&1 || true
sleep 2
CT_MATCHES=$(conntrack -L 2>/dev/null | grep -F "$GUEST" || true)
echo "  conntrack entries involving $GUEST: $(printf '%s\n' "$CT_MATCHES" | grep -c .)"
if printf '%s' "$CT_MATCHES" | grep -q "dport=$PUB"; then
  ok "a real DNAT flow to the public port is tracked in conntrack"
else
  bad "no conntrack entry for the DNAT flow (dport=$PUB)"
fi
if [ -n "$CT_MATCHES" ]; then ok "conntrack tracks the guest address before release"; else
  bad "conntrack has no entry for the guest before release"
fi

# --- release ---------------------------------------------------------------
CODE=$(api_code DELETE "/v1/instances/$ID")
echo "  delete: HTTP $CODE $(api_body | head -c 200)"
expect_eq "$CODE" 200 "delete accepted"
expect_eq "$(api_body | jq -r '.state' 2>/dev/null)" stopped "delete reports stopped"
sleep 1

LEFT=$(conntrack -L 2>/dev/null | grep -cF "$GUEST" || true)
expect_eq "$LEFT" 0 "release flushed every conntrack entry for the guest address (four directions)"
if conntrack -L 2>/dev/null | grep -q "dport=$PUB"; then
  bad "a conntrack entry for the public port survived release"
else
  ok "no conntrack entry for the released public port remains"
fi

# --- durable reuse quarantine ---------------------------------------------
NOW_MS=$(( $(date +%s) * 1000 ))
Q=$(cat "$QUARANTINE" 2>/dev/null || echo '{}')
echo "  quarantine: $Q"
QIDX=$(printf '%s' "$Q" | jq -r --argjson i "$INDEX" '.indexes[]? | select(.id == $i) | .expiresAtMs' 2>/dev/null || true)
QPORT=$(printf '%s' "$Q" | jq -r --argjson p "$PUB" '.ports[]? | select(.id == $p) | .expiresAtMs' 2>/dev/null || true)
if [ -n "$QIDX" ] && [ "$QIDX" -gt "$NOW_MS" ]; then
  ok "/30 index $INDEX is quarantined into the future ($QIDX)"
else
  bad "/30 index $INDEX is not durably quarantined (got '$QIDX')"
fi
if [ -n "$QPORT" ] && [ "$QPORT" -gt "$NOW_MS" ]; then
  ok "public port $PUB is quarantined into the future ($QPORT)"
else
  bad "public port $PUB is not durably quarantined (got '$QPORT')"
fi

# --- teardown --------------------------------------------------------------
if kill -0 "$PID" 2>/dev/null; then bad "firecracker process survived delete"; else ok "firecracker process removed"; fi
if [ -e "$JAILBASE/$ID" ]; then bad "jail dir still present"; else ok "jail dir removed"; fi
if [ -e "/sys/fs/cgroup/firecracker/$ID" ]; then bad "cgroup still present"; else ok "cgroup removed"; fi
if ip link show dev "$TAP" >/dev/null 2>&1; then bad "tap still present"; else ok "tap removed"; fi
if nft list table inet rctf_fc 2>/dev/null | grep -qF "$GUEST"; then
  bad "nftables still references the released guest"
else
  ok "nftables no longer references the released guest"
fi

# --- quarantine really prevents immediate reuse ---------------------------
SPEC2=/tmp/vmtest-spec-$ID2.json
make_spec "$SPEC2" "$ID2" vmtest false "rctf{vmtest-quarantine-replacement}" "" ""
CODE=$(api_code PUT "/v1/instances/$ID2" "$SPEC2")
rm -f "$SPEC2"
echo "  replacement create: HTTP $CODE $(api_body | head -c 250)"
if wait_state "$ID2" running 180; then ok "replacement instance starts while the quarantine is active"; else
  bad "replacement instance did not start"
fi
NEW_GUEST=$(lease_guest_ip "$ID2")
NEW_TAP=$(lease_tap "$ID2")
NEW_PORT=$(lease_port "$ID2")
echo "  replacement: guest=$NEW_GUEST tap=$NEW_TAP port=$NEW_PORT"
if [ "$NEW_GUEST" != "$GUEST" ] && [ "$NEW_TAP" != "$TAP" ]; then
  ok "the quarantined /30 was not handed to the replacement"
else
  bad "the quarantined /30 was immediately reused"
fi
if [ "$NEW_PORT" != "$PUB" ]; then
  ok "the quarantined public port was not handed to the replacement"
else
  bad "the quarantined public port was immediately reused"
fi
delete_instance "$ID2" >/dev/null 2>&1 || true
wait_gone "$ID2" 30 >/dev/null 2>&1 || true

systemctl stop fc-vmtest-hold >/dev/null 2>&1 || true
systemctl reset-failed fc-vmtest-hold >/dev/null 2>&1 || true
finish
