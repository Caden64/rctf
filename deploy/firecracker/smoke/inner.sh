#!/bin/bash
# Runs INSIDE `unshare -Urn` (started by run.sh): a private user+network namespace, so the tap devices and
# nftables rules below are real but cannot touch the host's network.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
RUN=${RUN:?run via run.sh}
export FIRECRACKER_AGENT_TOKEN=smoke-token
AGENT_LOG=$RUN/agent.log
ID=smoke$(date +%s)abcdef01
FLAG='rctf{smoke-canary-flag-7f3a9c}'
pass=0; fail=0
ok()   { echo "  PASS: $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL: $*"; fail=$((fail+1)); }
api()  { curl -sS -m 20 -H "Authorization: Bearer $FIRECRACKER_AGENT_TOKEN" -H 'Content-Type: application/json' "$@"; }
cleanup() { pkill -9 -f "firecracker.*--id $ID" 2>/dev/null; kill $AGENT_PID 2>/dev/null; }
trap cleanup EXIT

ip link set lo up; ip link add dummy0 type dummy; ip link set dummy0 up
sysctl -qw net.ipv4.ip_forward=1 || echo "(ip_forward not writable)"

start_agent() { (cd $REPO && bun apps/firecracker-instancer/src/agent/index.ts $RUN/agent.yaml >>$AGENT_LOG 2>&1 &) ; sleep 0.2; AGENT_PID=$(pgrep -f "agent/index.ts $RUN/agent.yaml" | head -1); for i in $(seq 1 50); do api -f http://127.0.0.1:7001/v1/info >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1; }

echo "== 1. agent starts (real VmDriver + real NetworkManager)"
start_agent && ok "agent up" || { bad "agent did not start"; tail -20 $AGENT_LOG; exit 1; }
api http://127.0.0.1:7001/v1/info | jq -c '{accepting, checks, images}' 2>/dev/null || api http://127.0.0.1:7001/v1/info | head -c 600; echo

SPEC=$(cat <<JSON
{"id":"$ID","teamKey":"abcdef012345","image":"smoke","vcpus":1,"memMiB":256,"diskMiB":64,"egress":false,"bootTimeoutSeconds":90,
 "readiness":{"kind":"tcp","port":8080},"env":{"CHALLENGE":"smoke","PROBE_PEER":"10.200.0.6","PROBE_HOST":"10.200.0.1"},
 "expose":[{"kind":"tcp","hostPrefix":"web","port":8080}],
 "expiresAtMs":$(( ($(date +%s)+900)*1000 )),"flags":[{"provider":"main","flag":"$FLAG"}]}
JSON
)
echo "== 2. create instance"
CODE=$(api -o $RUN/create.out -w '%{http_code}' -X PUT http://127.0.0.1:7001/v1/instances/$ID -d "$SPEC")
echo "  HTTP $CODE: $(head -c 300 $RUN/create.out)"; [ "$CODE" = 200 -o "$CODE" = 201 ] && ok "create accepted" || bad "create rejected"

echo "== 3. wait for running (real boot under real KVM)"
STATE=; for i in $(seq 1 120); do STATE=$(api http://127.0.0.1:7001/v1/instances/$ID | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p'); [ "$STATE" = running -o "$STATE" = errored ] && break; sleep 1; done
echo "  state=$STATE after ${i}s"; [ "$STATE" = running ] && ok "instance running" || { bad "instance not running: $(api http://127.0.0.1:7001/v1/instances/$ID | head -c 400)"; tail -30 $AGENT_LOG; }
GIP=$(ip -o -4 addr show | sed -n 's/.*inet \(10\.200\.[0-9.]*\)\/30.*/\1/p' | head -1)   # host side of the /30
HOSTIP=$GIP; GUEST=$(echo $HOSTIP | awk -F. '{print $1"."$2"."$3"."$4+1}')
echo "  host=$HOSTIP guest=$GUEST"

echo "== 4. flag delivered to the guest via MMDS and served by the guest service"
curl -sS -m 10 http://$GUEST:8080/diag.txt | sed "s/^/  guest-diag| /"
GOT=$(curl -sS -m 10 http://$GUEST:8080/flag.txt); echo "  guest served: $GOT"; [ "$GOT" = "$FLAG" ] && ok "flag byte-exact in guest" || bad "flag mismatch"

echo "== 5. flag never persisted on the host"
if grep -rqF "$FLAG" $RUN/state $RUN/traefik $RUN/agent.log 2>/dev/null; then bad "flag found in state/traefik/agent log"; else ok "flag absent from state dir, traefik dir and agent log"; fi
# the per-instance rootfs copy is the guest's own disk; the flag must NOT be in it either (tmpfs only)
if grep -qaF "$FLAG" $RUN/run/$ID/rootfs.ext4 2>/dev/null; then bad "flag found on guest disk image"; else ok "flag absent from the guest rootfs disk image"; fi

echo "== 6. isolation rules are real nftables"
nft list table inet rctf_fc 2>&1 | head -40; nft list table arp rctf_fc_arp 2>&1 | head -12
nft list table inet rctf_fc 2>/dev/null | grep -q "ether saddr" && ok "anti-spoof rules present" || bad "anti-spoof rules missing"

echo "== 7. agent crash (kill -9) must not kill the VM; restart re-adopts"
kill -9 $AGENT_PID; sleep 1
pgrep -f "firecracker.*--id $ID" >/dev/null && ok "VM survived agent crash" || bad "VM died with the agent"
GOT=$(curl -sS -m 10 http://$GUEST:8080/flag.txt); [ "$GOT" = "$FLAG" ] && ok "guest still serving after agent crash" || bad "guest unreachable after crash"
start_agent && ok "agent restarted" || bad "agent restart failed"
ST=$(api http://127.0.0.1:7001/v1/instances/$ID | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p'); echo "  state after restart=$ST"
[ "$ST" = running ] && ok "instance adopted as running" || bad "instance not adopted (state=$ST)"
ip -o link show | grep -q fctap && ok "tap preserved across restart" || bad "tap lost"

echo "== 8. duplicate create is idempotent; changed spec is rejected"
CODE=$(api -o /dev/null -w '%{http_code}' -X PUT http://127.0.0.1:7001/v1/instances/$ID -d "$SPEC"); [ "$CODE" = 200 -o "$CODE" = 201 ] && ok "duplicate create idempotent ($CODE)" || bad "duplicate create -> $CODE"
SPEC2=${SPEC/\"memMiB\":256/\"memMiB\":512}
CODE=$(api -o /dev/null -w '%{http_code}' -X PUT http://127.0.0.1:7001/v1/instances/$ID -d "$SPEC2"); [ "$CODE" = 409 ] && ok "changed spec -> 409" || bad "changed spec -> $CODE"


echo "== 8b. team isolation, measured FROM INSIDE the guests (real nftables, real tap)"
python3 -m http.server 9999 --bind 0.0.0.0 >/dev/null 2>&1 & LISTENER=$!
ID_B=smokeb$(date +%s)abcdef1
FLAG_B='rctf{team-b-secret-91ce}'
SPEC_B=$(cat <<JSON
{"id":"$ID_B","teamKey":"fedcba987654","image":"smoke","vcpus":1,"memMiB":256,"diskMiB":64,"egress":false,"bootTimeoutSeconds":90,
 "readiness":{"kind":"tcp","port":8080},"env":{"CHALLENGE":"smoke","PROBE_PEER":"10.200.0.2","PROBE_HOST":"10.200.0.5"},
 "expose":[{"kind":"tcp","hostPrefix":"web","port":8080}],
 "expiresAtMs":$(( ($(date +%s)+900)*1000 )),"flags":[{"provider":"main","flag":"$FLAG_B"}]}
JSON
)
api -o /dev/null -X PUT http://127.0.0.1:7001/v1/instances/$ID_B -d "$SPEC_B"
for i in $(seq 1 60); do S=$(api http://127.0.0.1:7001/v1/instances/$ID_B | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p'); [ "$S" = running ] && break; sleep 1; done
[ "$S" = running ] && ok "second team's VM running" || bad "second VM state=$S"
sleep 6   # let both probes run at least twice
GB=$(curl -sS -m 5 http://10.200.0.6:8080/flag.txt); GA=$(curl -sS -m 5 http://10.200.0.2:8080/flag.txt)
[ "$GA" = "$FLAG" ] && [ "$GB" = "$FLAG_B" ] && ok "each team's guest holds only its own flag (A='$GA' B='$GB')" || bad "flags crossed: A='$GA' B='$GB'"
PA=$(curl -sS -m 5 http://10.200.0.2:8080/probe.txt); PB=$(curl -sS -m 5 http://10.200.0.6:8080/probe.txt)
echo "  probe A: $PA | probe B: $PB"
[ "$PA" = "peer=blocked host=blocked" ] && ok "team A cannot reach team B or the host" || bad "team A probe: $PA"
[ "$PB" = "peer=blocked host=blocked" ] && ok "team B cannot reach team A or the host" || bad "team B probe: $PB"
echo "  -- control: flush the isolation rules; the SAME probe must now succeed (proves the probe can detect a breach)"
nft flush table inet rctf_fc; sleep 6
PA2=$(curl -sS -m 5 http://10.200.0.2:8080/probe.txt); echo "  probe A after flush: $PA2"
case "$PA2" in *REACHED*) ok "control: with rules removed the guest CAN reach peer/host (probe is sensitive)";; *) bad "control failed: probe still blocked ($PA2) - the isolation result above proves nothing";; esac
api -o /dev/null -X DELETE http://127.0.0.1:7001/v1/instances/$ID_B
kill $LISTENER 2>/dev/null

echo "== 9. delete tears everything down and fences the id"
CODE=$(api -o /dev/null -w '%{http_code}' -X DELETE http://127.0.0.1:7001/v1/instances/$ID); echo "  DELETE -> $CODE"
sleep 1
pgrep -f "firecracker.*--id $ID" >/dev/null && bad "firecracker still running" || ok "firecracker process gone"
ip -o link show | grep -q fctap && bad "tap still present" || ok "tap removed"
[ -e $RUN/run/$ID ] && bad "run dir still present" || ok "run dir removed"
nft list table inet rctf_fc 2>/dev/null | grep -qF "$GUEST" && bad "nft still references the lease" || ok "nft rules for the lease removed"
CODE=$(api -o /dev/null -w '%{http_code}' -X PUT http://127.0.0.1:7001/v1/instances/$ID -d "$SPEC"); [ "$CODE" = 409 ] && ok "re-create of a deleted id is fenced (409)" || bad "re-create of deleted id -> $CODE"

echo; echo "RESULT: $pass passed, $fail failed"
[ $fail = 0 ]
