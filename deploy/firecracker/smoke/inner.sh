#!/bin/bash
# Runs INSIDE `unshare -Urn` (started by run.sh): a private user+network namespace, so the tap devices and
# nftables rules below are real but cannot touch the host's network.
#
# `unshare -Urn` does NOT create a PID namespace: cleanup therefore only signals
# processes whose recorded identity (start ticks + executable + this run's unique
# directory in argv) still matches, and waits for every one of them. No pkill or
# pgrep name patterns, so a concurrent run is never touched.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
RUN=${RUN:?run via run.sh}
. "$HERE/lib.sh"
export FIRECRACKER_AGENT_TOKEN=smoke-token
AGENT_LOG=$RUN/agent.log
rand_hex() { od -An -N10 -tx1 /dev/urandom | tr -d ' \n'; }
# 80 random bits per id: two concurrent runs cannot share an id.
ID="smokea$(rand_hex)"
ID_B=
FLAG='rctf{smoke-canary-flag-7f3a9c}'
pass=0; fail=0
ok()   { echo "  PASS: $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL: $*"; fail=$((fail+1)); }
api()  { curl -sS -m 20 -H "Authorization: Bearer $FIRECRACKER_AGENT_TOKEN" -H 'Content-Type: application/json' "$@"; }

AGENT_PID=
LISTENER=
cleanup() {
  set +e
  kill_child "$LISTENER"
  kill_child "$AGENT_PID"
  reap_vms "$RUN/state" "$RUN"
}
trap cleanup EXIT INT TERM

ip link set lo up; ip link add dummy0 type dummy; ip link set dummy0 up
sysctl -qw net.ipv4.ip_forward=1 || echo "(ip_forward not writable)"

echo "== selftest: mutation proofs for fail-closed probes and verified cleanup"
bash "$HERE/selftest.sh" 2>&1 | tee "$RUN/smoke-selftest.log"
ST_LOG=$RUN/smoke-selftest.log
st_pass=$(grep -c '^SELFTEST .* PASS' "$ST_LOG" 2>/dev/null || true); st_pass=${st_pass:-0}
st_fail=$(grep -c '^SELFTEST .* FAIL' "$ST_LOG" 2>/dev/null || true); st_fail=${st_fail:-0}
echo "  selftest: $st_pass passed, $st_fail failed"

start_agent() {
  ( cd "$REPO" && exec bun apps/firecracker-instancer/src/agent/index.ts "$RUN/agent.yaml" >>"$AGENT_LOG" 2>&1 ) &
  AGENT_PID=$!
  for i in $(seq 1 50); do api -f http://127.0.0.1:7001/v1/info >/dev/null 2>&1 && return 0; sleep 0.2; done
  return 1
}

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
# Absence is only proven when the paths exist and grep itself succeeds; a
# missing path or grep error is reported as inconclusive, never as "absent".
flag_scan "$FLAG" "$RUN/state" "$RUN/traefik" "$RUN/agent.log"; rc=$?
case $rc in
  0) ok "flag absent from state dir, traefik dir and agent log" ;;
  1) bad "flag found on the host ($SCAN_DETAIL)" ;;
  *) bad "cannot prove the flag is absent from the host: $SCAN_DETAIL" ;;
esac
# the per-instance rootfs copy is the guest's own disk; the flag must NOT be in it either (tmpfs only)
flag_scan "$FLAG" "$RUN/run/$ID/rootfs.ext4"; rc=$?
case $rc in
  0) ok "flag absent from the guest rootfs disk image" ;;
  1) bad "flag found on guest disk image ($SCAN_DETAIL)" ;;
  *) bad "cannot prove the flag is absent from the guest disk image: $SCAN_DETAIL" ;;
esac

echo "== 6. isolation rules are real nftables"
INET_TEXT=$(nft list table inet rctf_fc 2>&1); INET_RC=$?
ARP_TEXT=$(nft list table arp rctf_fc_arp 2>&1); ARP_RC=$?
printf '%s\n' "$INET_TEXT" | head -40
printf '%s\n' "$ARP_TEXT" | head -12
if [ "$INET_RC" -ne 0 ] || [ "$ARP_RC" -ne 0 ]; then
  bad "nft listing failed (inet=$INET_RC arp=$ARP_RC); rule presence is not proven"
elif ! printf '%s\n' "$INET_TEXT" | grep -q "ether saddr"; then
  bad "anti-spoof rules missing"
else
  ok "anti-spoof rules present"
fi

echo "== 7. agent crash (kill -9) must not kill the VM; restart re-adopts"
vm_alive "$ID" || bad "could not read the VM handle before the crash"
kill -9 $AGENT_PID; sleep 1
if vm_alive "$ID"; then ok "VM survived agent crash (pid $VM_PID start ticks $VM_TICKS verified)"; else bad "VM died with the agent or its identity changed"; fi
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
for i in $(seq 1 30); do curl -sS -m 1 -o /dev/null http://127.0.0.1:9999/ 2>/dev/null && break; sleep 0.2; done
ID_B="smokeb$(rand_hex)"
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
for i in $(seq 1 30); do
  PA=$(curl -sS -m 5 http://10.200.0.2:8080/probe.txt 2>/dev/null)
  PB=$(curl -sS -m 5 http://10.200.0.6:8080/probe.txt 2>/dev/null)
  [ "$PA" = "peer=blocked host=blocked" ] && [ "$PB" = "peer=blocked host=blocked" ] && break
  sleep 1
done
GB=$(curl -sS -m 5 http://10.200.0.6:8080/flag.txt); GA=$(curl -sS -m 5 http://10.200.0.2:8080/flag.txt)
[ "$GA" = "$FLAG" ] && [ "$GB" = "$FLAG_B" ] && ok "each team's guest holds only its own flag (A='$GA' B='$GB')" || bad "flags crossed: A='$GA' B='$GB'"
PA=$(curl -sS -m 5 http://10.200.0.2:8080/probe.txt); PB=$(curl -sS -m 5 http://10.200.0.6:8080/probe.txt)
echo "  probe A: $PA | probe B: $PB"
[ "$PA" = "peer=blocked host=blocked" ] && ok "team A cannot reach team B or the host" || bad "team A probe: $PA"
[ "$PB" = "peer=blocked host=blocked" ] && ok "team B cannot reach team A or the host" || bad "team B probe: $PB"
# Control: flush the isolation rules and require BOTH guests to report BOTH
# reachability results. A broken peer probe can no longer pass as "sensitive":
# the exact expected line is required for each guest, with bounded polling.
echo "  -- control: flush the isolation rules; BOTH guests must now report peer=REACHED host=REACHED"
nft flush table inet rctf_fc
PA2=; PB2=
for i in $(seq 1 20); do
  PA2=$(curl -sS -m 5 http://10.200.0.2:8080/probe.txt 2>/dev/null)
  PB2=$(curl -sS -m 5 http://10.200.0.6:8080/probe.txt 2>/dev/null)
  [ "$PA2" = "peer=REACHED host=REACHED" ] && [ "$PB2" = "peer=REACHED host=REACHED" ] && break
  sleep 1
done
echo "  probe A after flush: $PA2 | probe B after flush: $PB2"
[ "$PA2" = "peer=REACHED host=REACHED" ] && [ "$PB2" = "peer=REACHED host=REACHED" ] &&
  ok "control: with rules removed BOTH guests reach peer and host (probes are sensitive)" ||
  bad "control failed: need peer=REACHED host=REACHED from both guests (A='$PA2' B='$PB2') - the isolation result above proves nothing"
api -o /dev/null -X DELETE http://127.0.0.1:7001/v1/instances/$ID_B
kill_child "$LISTENER"; LISTENER=

echo "== 9. delete tears everything down and fences the id"
VM_PID=; VM_TICKS=
vm_alive "$ID" || bad "could not read the VM handle before delete"
CODE=$(api -o /dev/null -w '%{http_code}' -X DELETE http://127.0.0.1:7001/v1/instances/$ID); echo "  DELETE -> $CODE"
sleep 1
if proc_identity_matches "$VM_PID" "$VM_TICKS"; then
  bad "firecracker still running (pid $VM_PID start ticks $VM_TICKS)"
else
  ok "firecracker process gone (recorded pid/start-ticks identity no longer matches)"
fi
ip_no_link ': fctap[0-9]+:'; rc=$?
case $rc in
  0) ok "tap removed" ;;
  1) bad "tap still present ($SCAN_DETAIL)" ;;
  *) bad "cannot prove the tap is gone: $SCAN_DETAIL" ;;
esac
[ -e "$RUN/run/$ID" ] && bad "run dir still present" || ok "run dir removed"
nft_lacks "$GUEST" inet rctf_fc; rc=$?
case $rc in
  0) ok "nft rules for the lease removed" ;;
  1) bad "nft still references the lease ($SCAN_DETAIL)" ;;
  *) bad "cannot prove the nft rules are gone: $SCAN_DETAIL" ;;
esac
CODE=$(api -o /dev/null -w '%{http_code}' -X PUT http://127.0.0.1:7001/v1/instances/$ID -d "$SPEC"); [ "$CODE" = 409 ] && ok "re-create of a deleted id is fenced (409)" || bad "re-create of deleted id -> $CODE"

echo; echo "RESULT: $pass passed, $fail failed"
echo "SELFTEST RESULT: $st_pass passed, $st_fail failed"
[ $fail = 0 ] && [ "$st_fail" -eq 0 ]
