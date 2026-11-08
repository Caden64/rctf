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
if outside_http_start; then ok "outside HTTP service is running"; else
  bad "outside HTTP service did not start"
  finish
  exit 1
fi

# egress:true so the guest also creates a masqueraded outbound flow: its tuple
# exercises the ORIGINAL direction while the DNAT flow exercises the REPLY
# direction. Both must be flushed on release.
make_spec "$SPEC" "$ID" vmtest true "$FLAG" "" "$OUT_PEER_IP:$OUT_HTTP_PORT"
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

if probe_wait_for "$GUEST" 'outside=REACHED' 40; then
  ok "egress:true guest produced a real outbound flow through masquerade"
else
  bad "egress:true guest never reached the outside service (probe: $(probe_text "$GUEST"))"
fi

# One real TCP connection through DNAT, held open with nc.
systemctl reset-failed fc-vmtest-hold >/dev/null 2>&1 || true
systemd-run --unit=fc-vmtest-hold --collect \
  nsenter --net="/run/netns/$OUT_NS" sh -c "sleep 30 | nc $OUT_HOST_IP $PUB >/dev/null" >/dev/null 2>&1 || true
sleep 2

CT_BEFORE=
DNAT_LINE=
EGRESS_LINE=
# Original tuple only: src=<guest> dst=<outside>. A DNAT reply tuple has the
# same host pair in the opposite role, so matching anywhere in the line would
# confuse the two flows.
ct_original_guest_to() { # ct_original_guest_to <dump> <guest> <dst>
  printf '%s\n' "$1" | awk -v g="$2" -v o="$3" '
    {
      s = 0; d = 0; s1 = ""; d1 = "";
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^src=/) { s++; if (s == 1) s1 = substr($i, 5) }
        if ($i ~ /^dst=/) { d++; if (d == 1) d1 = substr($i, 5) }
      }
      if (s1 == g && d1 == o) { print; exit }
    }'
}
for _ in $(seq 1 20); do
  CT_BEFORE=$(conntrack -L -f ipv4)
  CT_RC=$?
  [ "$CT_RC" -eq 0 ] || break
  DNAT_LINE=$(printf '%s\n' "$CT_BEFORE" |
    awk -v g="$GUEST" -v p="dport=$PUB" 'index($0, g) && index($0, p) { print; exit }')
  EGRESS_LINE=$(ct_original_guest_to "$CT_BEFORE" "$GUEST" "$OUT_PEER_IP")
  [ -n "$DNAT_LINE" ] && [ -n "$EGRESS_LINE" ] && break
  sleep 0.5
done
if [ "$CT_RC" -ne 0 ]; then
  bad "conntrack -L failed before release (exit $CT_RC); cannot inspect flows"
fi
CT_GUEST_BEFORE=$(printf '%s\n' "$CT_BEFORE" | grep -cF "$GUEST" || true)
echo "  conntrack entries involving $GUEST: $CT_GUEST_BEFORE"
echo "  DNAT entry:    ${DNAT_LINE:-<none>}"
echo "  egress entry:  ${EGRESS_LINE:-<none>}"
if [ "$CT_GUEST_BEFORE" -gt 0 ]; then
  ok "conntrack tracks the guest address before release"
else
  bad "conntrack has no entry for the guest before release"
fi
if [ -n "$DNAT_LINE" ] && printf '%s\n' "$DNAT_LINE" | grep -qE "(^| )src=$GUEST( |$)"; then
  ok "DNAT flow tracked with the guest in the reply-source direction"
else
  bad "no DNAT conntrack entry with the guest as reply source (dport=$PUB)"
fi
if [ -n "$EGRESS_LINE" ] && printf '%s\n' "$EGRESS_LINE" | grep -qE "(^| )src=$GUEST( |$)"; then
  ok "masqueraded egress flow tracked with the guest in the original-source direction"
else
  bad "no masqueraded egress conntrack entry with the guest as original source"
fi
for pair in "DNAT:$DNAT_LINE" "egress:$EGRESS_LINE"; do
  label=${pair%%:*}; line=${pair#*:}
  n=$(printf '%s\n' "$line" | awk '{ c = 0; for (i = 1; i <= NF; i++) if ($i ~ /^src=/) c++; print c }')
  expect_eq "$n" 2 "$label flow entry carries both original and reply tuples"
done

# Positive calibration while the lease exists: the same teardown probes must
# find the tap and the guest IP now. A probe error must fail, not pass.
if link_exists "$TAP"; then
  ok "positive calibration: tap $TAP is present before release"
else
  case "$LINK_STATE" in
    absent) bad "positive calibration failed: tap $TAP is absent before release" ;;
    *) bad "positive calibration failed: cannot observe tap $TAP (${LINK_ERROR:-probe error})" ;;
  esac
fi
if nft_table_grep inet rctf_fc "$GUEST"; then
  [ "$NFT_STATE" = match ] &&
    ok "positive calibration: inet rctf_fc references the live guest before release" ||
    bad "positive calibration failed: inet rctf_fc does not reference $GUEST before release (state=$NFT_STATE)"
else
  bad "positive calibration failed: cannot read inet rctf_fc (${NFT_ERROR:-probe error})"
fi

# --- release ---------------------------------------------------------------
CODE=$(api_code DELETE "/v1/instances/$ID")
echo "  delete: HTTP $CODE $(api_body | head -c 200)"
expect_eq "$CODE" 200 "delete accepted"
expect_eq "$(api_body | jq -r '.state' 2>/dev/null)" stopped "delete reports stopped"
sleep 1

# conntrack must be a working probe after release; a tool failure is not a
# flush. Only exit 0 with zero matching entries proves the flush.
CT_AFTER=$(conntrack -L -f ipv4)
CT_RC=$?
if [ "$CT_RC" -ne 0 ]; then
  bad "conntrack -L failed after release (exit $CT_RC); cannot verify the flush"
else
  LEFT=$(printf '%s\n' "$CT_AFTER" | grep -cF "$GUEST" || true)
  expect_eq "$LEFT" 0 \
    "release flushed every conntrack entry for the guest address (original and reply tuples)"
  if printf '%s\n' "$CT_AFTER" | grep -F "$GUEST" | grep -qF "dport=$PUB"; then
    bad "the DNAT reply tuple for the public port survived release"
  else
    ok "the DNAT reply tuple for the public port was flushed"
  fi
  if [ -n "$(ct_original_guest_to "$CT_AFTER" "$GUEST" "$OUT_PEER_IP")" ]; then
    bad "the masqueraded egress original tuple survived release"
  else
    ok "the masqueraded egress original tuple was flushed"
  fi
  if printf '%s\n' "$CT_AFTER" | grep -qF "dport=$PUB"; then
    bad "a conntrack entry for the public port survived release"
  else
    ok "no conntrack entry for the released public port remains"
  fi
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
link_exists "$TAP"
case "$?" in
  0) bad "tap still present" ;;
  1) ok "tap removed" ;;
  *) bad "could not observe tap $TAP after release (${LINK_ERROR:-probe error}); cannot claim it was removed" ;;
esac
nft_table_grep inet rctf_fc "$GUEST"
case "$?" in
  0)
    case "$NFT_STATE" in
      match) bad "nftables still references the released guest" ;;
      absent | missing) ok "nftables no longer references the released guest" ;;
    esac
    ;;
  *) bad "could not read inet rctf_fc after release (${NFT_ERROR:-probe error}); cannot claim the rules were removed" ;;
esac

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
