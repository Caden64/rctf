#!/usr/bin/env bash
# Check g/h) egress masquerade, public DNAT from an "outside" namespace, team
# isolation measured from inside the guests (with a sensitivity control), and
# an nmap scan proving only published ports are reachable from outside.
. "$(dirname "$0")/lib.sh"

IDA=vmtest$(date +%s)e1
IDB=vmtest$(date +%s)e2
FLAGA="rctf{vmtest-egress-a-$(date +%s)}"
FLAGB="rctf{vmtest-egress-b-$(date +%s)}"
PEERS="10.200.0.2 10.200.0.6 10.200.0.10 10.200.0.14 10.200.0.18 10.200.0.22 10.200.0.26 10.200.0.30"

section "g) egress NAT, public DNAT, team isolation"
net_setup
if outside_http_start; then ok "real HTTP service is listening in the outside namespace"; else
  bad "outside HTTP service did not start"
  finish
  exit 1
fi
expect_eq "$(outside curl -sS -m 3 "http://$OUT_PEER_IP:$OUT_HTTP_PORT/" >/dev/null 2>&1; echo $?)" 0 \
  "the outside service is reachable from its own namespace"

# --- two teams: A with egress, B without ----------------------------------
for pair in "A:$IDA:true:$FLAGA" "B:$IDB:false:$FLAGB"; do
  name=${pair%%:*}; rest=${pair#*:}; id=${rest%%:*}; rest=${rest#*:}; eg=${rest%%:*}; flag=${rest#*:}
  spec=/tmp/vmtest-spec-$id.json
  make_spec "$spec" "$id" vmtest "$eg" "$flag" "$PEERS" "$OUT_PEER_IP:$OUT_HTTP_PORT"
  code=$(api_code PUT "/v1/instances/$id" "$spec")
  rm -f "$spec"
  echo "  create $name: HTTP $code"
  if [ "$code" = 200 ] || [ "$code" = 201 ]; then ok "team $name create accepted"; else bad "team $name create failed (HTTP $code)"; fi
done

for pair in "A:$IDA" "B:$IDB"; do
  name=${pair%%:*}; id=${pair#*:}
  if wait_state "$id" running 180; then ok "team $name instance running"; else bad "team $name instance not running"; fi
done

GA=$(lease_guest_ip "$IDA"); GB=$(lease_guest_ip "$IDB")
TA=$(lease_tap "$IDA"); TB=$(lease_tap "$IDB")
PA=$(lease_port "$IDA"); PB=$(lease_port "$IDB")
echo "  A guest=$GA tap=$TA port=$PA"
echo "  B guest=$GB tap=$TB port=$PB"

# --- g1. egress: true masquerades; egress: false does not ------------------
if probe_wait_for "$GA" 'outside=REACHED' 40; then
  ok "egress:true guest reaches the outside HTTP service"
else
  bad "egress:true guest did NOT reach the outside service (probe: $(probe_text "$GA"))"
fi
if probe_wait_for "$GB" 'outside=blocked' 40; then
  ok "egress:false guest cannot reach the outside service"
else
  bad "egress:false guest reached the outside service (probe: $(probe_text "$GB"))"
fi
CT_A=$(conntrack -L 2>/dev/null | grep -F "$GA" | grep -F "dst=$OUT_HOST_IP" || true)
if [ -n "$CT_A" ]; then
  ok "conntrack proves masquerade: the outside reply is addressed to $OUT_HOST_IP"
else
  bad "no masqueraded conntrack entry found for the egress guest"
fi

# --- g2. public DNAT from the outside namespace ---------------------------
GOT_A=$(outside curl -sS -m 8 "http://$OUT_HOST_IP:$PA/flag.txt" 2>/dev/null || true)
GOT_B=$(outside curl -sS -m 8 "http://$OUT_HOST_IP:$PB/flag.txt" 2>/dev/null || true)
expect_eq "$GOT_A" "$FLAGA" "public DNAT from the outside namespace reaches team A's guest"
expect_eq "$GOT_B" "$FLAGB" "public DNAT from the outside namespace reaches team B's guest"

# --- g3. team isolation, measured from INSIDE the guests ------------------
if probe_wait_for "$GA" "peer:$GB=blocked" 30; then
  ok "team A cannot reach team B's guest (probe inside A)"
else
  bad "team A reached team B (probe: $(probe_text "$GA"))"
fi
if probe_wait_for "$GB" "peer:$GA=blocked" 30; then
  ok "team B cannot reach team A's guest (probe inside B)"
else
  bad "team B reached team A (probe: $(probe_text "$GB"))"
fi

# --- g4. control: remove the rules, the same probe must succeed ------------
nft_save
nft_flush_all
CTRL_OK=1
probe_wait_for "$GA" "peer:$GB=REACHED" 30 || { probe_wait_for "$GB" "peer:$GA=REACHED" 30 || CTRL_OK=0; }
if [ "$CTRL_OK" = 1 ]; then
  ok "control: with the ruleset removed the SAME probe reaches the peer (probe is sensitive)"
else
  bad "control failed: the probe cannot succeed even without rules, so isolation result proves nothing"
fi
# egress must also stop being enforced with the rules gone (a second control).
probe_wait_for "$GB" 'outside=REACHED' 30 \
  && ok "control: egress:false guest reaches the outside once the rules are gone" \
  || bad "control: egress:false guest still blocked without rules"

nft_restore
if probe_wait_for "$GA" "peer:$GB=blocked" 45 && probe_wait_for "$GB" "peer:$GA=blocked" 45; then
  ok "restored ruleset restores isolation in both directions"
else
  bad "isolation did not return after restoring the ruleset (A: $(probe_text "$GA") | B: $(probe_text "$GB"))"
fi
if probe_wait_for "$GB" 'outside=blocked' 45; then
  ok "restored ruleset restores the egress deny for the egress:false team"
else
  bad "egress:false guest can still reach outside after restoring the ruleset"
fi

# --- h. nmap from the outside namespace -----------------------------------
SCANLOG=/tmp/vmtest-nmap.log
outside nmap -Pn --max-retries 1 -p "22,7001,30000-30010" "$OUT_HOST_IP" >"$SCANLOG" 2>&1 || true
sed 's/^/  | /' "$SCANLOG"
OPEN=$(awk '/^[0-9]+\/tcp/ && $2 == "open" {split($1,a,"/"); print a[1]}' "$SCANLOG" | sort -n | tr '\n' ' ')
WANT=$(printf '%s\n%s\n' "$PA" "$PB" | sort -n | tr '\n' ' ')
expect_eq "$OPEN" "$WANT" "nmap sees exactly the published TCP ports as open"
if awk '/^22\/tcp/ && $2 == "closed"' "$SCANLOG" | grep -q .; then
  ok "management sshd (port 22) is not exposed on the public test interface"
else
  bad "port 22 is exposed on the public test interface"
fi
if awk '/^7001\/tcp/ && $2 == "closed"' "$SCANLOG" | grep -q .; then
  ok "the agent API (port 7001, bound to 127.0.0.1) is not exposed on the public interface"
else
  bad "the agent API is exposed on the public interface"
fi

# --- teardown -------------------------------------------------------------
for id in "$IDA" "$IDB"; do
  delete_instance "$id" >/dev/null 2>&1 || bad "delete $id failed"
  wait_gone "$id" 40 >/dev/null 2>&1 || bad "$id did not stop"
done
if fc_procs "$IDA" | grep -q . || fc_procs "$IDB" | grep -q .; then
  bad "a firecracker process survived teardown"
else
  ok "both team VMs were destroyed"
fi

outside_http_stop
finish
