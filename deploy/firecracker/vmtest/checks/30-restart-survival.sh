#!/usr/bin/env bash
# Check d) VMs survive `systemctl restart` and `kill -9` of the agent and are
# re-adopted with strict process identity; then establish whether CAP_SYS_PTRACE
# is really required, via a drop-in that removes it.
. "$(dirname "$0")/lib.sh"

ID=vmtest$(date +%s)r1
FLAG="rctf{vmtest-restart-$(date +%s)}"
SPEC=/tmp/vmtest-spec-$ID.json
DROPIN=/etc/systemd/system/rctf-firecracker-agent.service.d/20-vmtest-no-ptrace.conf

section "d) restart / kill -9 survival and CAP_SYS_PTRACE"
net_setup
outside_http_start || true

make_spec "$SPEC" "$ID" vmtest false "$FLAG" "" ""
CODE=$(api_code PUT "/v1/instances/$ID" "$SPEC")
rm -f "$SPEC"
echo "  create: HTTP $CODE"
if [ "$CODE" != 200 ] && [ "$CODE" != 201 ]; then bad "create failed (HTTP $CODE)"; finish; exit 1; fi
if wait_state "$ID" running 180; then ok "instance running before restart"; else
  bad "instance not running before restart"
  finish
  exit 1
fi

PID=$(vm_pid "$ID")
GUEST=$(lease_guest_ip "$ID")
TAP=$(lease_tap "$ID")
AGENT1=$(agent_main_pid)
echo "  fc pid=$PID guest=$GUEST tap=$TAP agent=$AGENT1"

# --- 1. systemctl restart --------------------------------------------------
systemctl restart rctf-firecracker-agent
wait_agent_active || bad "agent did not come back after systemctl restart"
AGENT2=$(agent_main_pid)
if [ "$AGENT2" != "$AGENT1" ]; then ok "systemctl restart replaced the agent process ($AGENT1 -> $AGENT2)"; else
  bad "agent pid did not change across systemctl restart"
fi
if kill -0 "$PID" 2>/dev/null; then ok "firecracker survived systemctl restart (KillMode=process)"; else
  bad "firecracker was killed by systemctl restart"
fi
expect_eq "$(guest_get "$GUEST" /flag.txt)" "$FLAG" "guest still serves its flag after restart"
if wait_state "$ID" running 60; then ok "restarted agent re-adopted the instance as running"; else
  bad "restarted agent did not re-adopt the instance ($(api "$API/v1/instances/$ID" | head -c 300))"
fi
expect_eq "$(lease_tap "$ID")" "$TAP" "tap was preserved across the restart"
IDENT=$(state_json="$RUNDIR/$ID/vm-identity.json"; [ -f "$state_json" ] && jq -c '{instanceId,uid,jailRoot,exePath}' "$state_json")
echo "  sidecar: $IDENT"
case "$IDENT" in
  *"\"instanceId\":\"$ID\""*"\"uid\":10000"*) ok "durable vm-identity.json sidecar is present and matches the process" ;;
  *) bad "vm-identity.json sidecar missing or wrong: $IDENT" ;;
esac

# --- 2. kill -9 of the agent ----------------------------------------------
AGENT2=$(agent_main_pid)
kill -9 "$AGENT2"
NEW=
for _ in $(seq 1 60); do
  NEW=$(agent_main_pid)
  [ -n "$NEW" ] && [ "$NEW" != "$AGENT2" ] && api "$API/v1/info" >/dev/null 2>&1 && break
  sleep 0.5
done
if [ -n "$NEW" ] && [ "$NEW" != "$AGENT2" ]; then ok "systemd restarted the agent after kill -9 ($AGENT2 -> $NEW)"; else
  bad "agent was not restarted after kill -9"
fi
if kill -0 "$PID" 2>/dev/null; then ok "firecracker survived kill -9 of the agent"; else
  bad "firecracker died with the agent"
fi
expect_eq "$(guest_get "$GUEST" /flag.txt)" "$FLAG" "guest still serves its flag after kill -9"
if wait_state "$ID" running 60; then ok "agent re-adopted the VM after kill -9 (strict identity)"; else
  bad "agent did not re-adopt after kill -9"
fi

# --- 3. is CAP_SYS_PTRACE really required? ---------------------------------
cat >"$DROPIN" <<'EOF'
# TEST-ONLY: remove CAP_SYS_PTRACE (with resets, because systemd merges lists).
[Service]
CapabilityBoundingSet=
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW CAP_SYS_ADMIN CAP_SYS_CHROOT CAP_SETUID CAP_SETGID CAP_SETPCAP CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_KILL CAP_MKNOD
AmbientCapabilities=
AmbientCapabilities=CAP_SETUID CAP_SETGID
EOF
systemctl daemon-reload
systemctl restart rctf-firecracker-agent
wait_agent_active || true
CAPEFF=$(grep '^CapEff:' "/proc/$(agent_main_pid)/status" | awk '{print $2}')
if [ $((0x$CAPEFF & 0x80000)) -eq 0 ]; then
  ok "drop-in really removed CAP_SYS_PTRACE from the agent's effective set"
else
  bad "drop-in did not remove CAP_SYS_PTRACE"
fi

NO_PTRACE_STATE=
for _ in $(seq 1 40); do
  NO_PTRACE_STATE=$(api "$API/v1/instances/$ID" | jq -r '.state // empty' 2>/dev/null || true)
  [ "$NO_PTRACE_STATE" = running ] || break
  sleep 0.5
done
echo "  state without CAP_SYS_PTRACE: $NO_PTRACE_STATE"
if [ "$NO_PTRACE_STATE" != running ]; then
  ok "without CAP_SYS_PTRACE the agent cannot authenticate/re-adopt the running VM (cap is required)"
else
  bad "CAP_SYS_PTRACE is not required: the agent still reports the VM running"
fi
if kill -0 "$PID" 2>/dev/null; then
  ok "without CAP_SYS_PTRACE the VM process is left alive (no unverified signal)"
else
  echo "  note: the VM process disappeared while CAP_SYS_PTRACE was missing"
fi
NO_PTRACE_ERR=$(api "$API/v1/instances/$ID" | jq -r '.message // empty' 2>/dev/null || true)
echo "  reported state/message: $NO_PTRACE_STATE ${NO_PTRACE_ERR:+($NO_PTRACE_ERR)}"

# --- 4. restore the capability; the agent must now be able to clean up ------
rm -f "$DROPIN"
systemctl daemon-reload
systemctl restart rctf-firecracker-agent
wait_agent_active || bad "agent did not restart after restoring CAP_SYS_PTRACE"
GONE=0
for _ in $(seq 1 60); do
  if ! kill -0 "$PID" 2>/dev/null; then GONE=1; break; fi
  sleep 0.5
done
if [ "$GONE" = 1 ]; then
  ok "with CAP_SYS_PTRACE restored the agent reclaimed and destroyed the unauthenticated VM"
else
  bad "the VM process was still alive after CAP_SYS_PTRACE was restored"
  kill -9 "$PID" 2>/dev/null || true
fi
sleep 1
if [ -e "$JAILBASE/$ID" ]; then bad "jail dir still present after cleanup"; else ok "jail dir removed after cleanup"; fi
if ip link show dev "$TAP" >/dev/null 2>&1; then bad "tap still present after cleanup"; else ok "tap removed after cleanup"; fi

api_code DELETE "/v1/instances/$ID" >/dev/null 2>&1 || true
echo
echo "NOTE: CAP_SYS_PTRACE is genuinely required. Removing it makes the agent report"
echo "      'vm died' for a live VM and leaves the process unverifiable (see RESULTS.md)."
finish
