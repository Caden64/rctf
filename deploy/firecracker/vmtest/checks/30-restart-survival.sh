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
if [ -z "$PID" ]; then bad "agent state has no vm.pid"; finish; exit 1; fi

# Assert the durable sidecar and the live process agree. This is the strict
# re-adoption identity: agent-reported pid, jail root, exe path/inode and uid.
assert_reidentity() { # <label>
  local label=$1 side=$RUNDIR/$ID/vm-identity.json
  local s_id s_uid s_jail s_exe s_dev s_ino s_jail_ino
  local live_uid live_exe live_root_ino live_dev live_ino
  if [ ! -f "$side" ] || [ ! -r "$side" ]; then
    bad "vm-identity.json missing or unreadable ($label)"
    return
  fi
  s_id=$(jq -r '.instanceId // empty' "$side")
  s_uid=$(jq -r '.uid // empty' "$side")
  s_jail=$(jq -r '.jailRoot // empty' "$side")
  s_exe=$(jq -r '.exePath // empty' "$side")
  s_dev=$(jq -r '.exe.dev // empty' "$side")
  s_ino=$(jq -r '.exe.ino // empty' "$side")
  live_uid=$(awk '/^Uid:/{print $2}' "/proc/$PID/status") || live_uid=
  live_exe=$(readlink "/proc/$PID/exe") || live_exe=
  live_root_ino=$(stat -Lc '%d:%i' "/proc/$PID/root") || live_root_ino=
  live_dev=$(stat -Lc '%d' "/proc/$PID/exe") || live_dev=
  live_ino=$(stat -Lc '%i' "/proc/$PID/exe") || live_ino=
  s_jail_ino=
  if [ -n "$s_jail" ]; then s_jail_ino=$(stat -Lc '%d:%i' "$s_jail") || s_jail_ino=; fi

  if [ -n "$s_id" ] && [ "$s_id" = "$ID" ]; then
    ok "vm-identity instanceId matches $ID ($label)"
  else
    bad "vm-identity instanceId is '$s_id', want '$ID' ($label)"
  fi
  if [ -n "$s_uid" ] && [ -n "$live_uid" ] && [ "$s_uid" = "$live_uid" ] && [ "$s_uid" = 10000 ]; then
    ok "vm-identity uid $s_uid matches live /proc/<pid>/status and jailUid ($label)"
  else
    bad "vm-identity uid '$s_uid' != live uid '$live_uid' (want 10000) ($label)"
  fi
  if [ -n "$s_jail" ] && [ -n "$live_root_ino" ] && [ "$s_jail_ino" = "$live_root_ino" ]; then
    ok "vm-identity jailRoot dev:ino $s_jail_ino matches live /proc/<pid>/root ($label)"
  else
    bad "vm-identity jailRoot '$s_jail' ($s_jail_ino) does not match live /proc/<pid>/root ($live_root_ino) ($label)"
  fi
  if [ -n "$live_exe" ] && [ "$live_exe" = /firecracker ]; then
    ok "live executable is /firecracker inside the chroot ($label)"
  else
    bad "live executable is '$live_exe', want /firecracker ($label)"
  fi
  if [ -n "$s_exe" ] && [ -n "$s_jail" ] && [ "$s_exe" = "$s_jail/firecracker" ]; then
    ok "vm-identity exePath is the live jail copy ($label)"
  else
    bad "vm-identity exePath '$s_exe' != '$s_jail/firecracker' ($label)"
  fi
  if [ -n "$s_dev" ] && [ -n "$s_ino" ] && [ -n "$live_dev" ] && [ -n "$live_ino" ] &&
    [ "$s_dev" = "$live_dev" ] && [ "$s_ino" = "$live_ino" ]; then
    ok "vm-identity exe dev:ino $s_dev:$s_ino matches live /proc/<pid>/exe ($label)"
  else
    bad "vm-identity exe '$s_dev:$s_ino' != live '$live_dev:$live_ino' ($label)"
  fi
}


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
expect_eq "$(vm_pid "$ID")" "$PID" "agent-reported .vm.pid is the original PID after systemctl restart"
assert_reidentity "after systemctl restart"

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
expect_eq "$(vm_pid "$ID")" "$PID" "agent-reported .vm.pid is the original PID after kill -9"
assert_reidentity "after kill -9"

# --- 3. is CAP_SYS_PTRACE really required? ---------------------------------
PID_START=$(awk '{print $22}' "/proc/$PID/stat")
mkdir -p "$(dirname "$DROPIN")"
cat >"$DROPIN" <<'EOF'
# TEST-ONLY: remove CAP_SYS_PTRACE (with a reset, because systemd merges
# lists). The shipped unit's AmbientCapabilities=CAP_SETUID CAP_SETGID stays in
# effect: both are still in this bounding set.
[Service]
CapabilityBoundingSet=
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW CAP_SYS_ADMIN CAP_SYS_CHROOT CAP_SETUID CAP_SETGID CAP_SETPCAP CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_KILL CAP_MKNOD
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
NO_PTRACE_ALIVE=0
if kill -0 "$PID" 2>/dev/null; then NO_PTRACE_ALIVE=1; fi
NO_PTRACE_START=$(awk '{print $22}' "/proc/$PID/stat" 2>/dev/null || true)
NO_PTRACE_ERR=$(api "$API/v1/instances/$ID" | jq -r '.message // empty' 2>/dev/null || true)
echo "  state without CAP_SYS_PTRACE: $NO_PTRACE_STATE"
echo "  live pid without CAP_SYS_PTRACE: alive=$NO_PTRACE_ALIVE start=$NO_PTRACE_START (was $PID_START)"
echo "  reported state/message: $NO_PTRACE_STATE ${NO_PTRACE_ERR:+($NO_PTRACE_ERR)}"
if [ "$NO_PTRACE_STATE" != running ]; then
  ok "without CAP_SYS_PTRACE the agent cannot authenticate/re-adopt the running VM (cap is required)"
else
  bad "CAP_SYS_PTRACE is not required: the agent still reports the VM running"
fi
if [ -n "$NO_PTRACE_ERR" ] && printf '%s' "$NO_PTRACE_ERR" |
  grep -Eqi 'vm died|authenticat|identity|ptrace|permission|verif'; then
  ok "the errored record carries an authentication/verification failure message ($NO_PTRACE_ERR)"
else
  bad "the errored record has no authentication/verification failure message (got '$NO_PTRACE_ERR')"
fi
# Documented safe outcome: the VM process is left alive and unsignalled (same
# kernel starttime), and the record is errored. Anything else is a hard fail.
if [ "$NO_PTRACE_STATE" = errored ] && [ "$NO_PTRACE_ALIVE" = 1 ] &&
  [ -n "$NO_PTRACE_START" ] && [ "$NO_PTRACE_START" = "$PID_START" ]; then
  ok "safe outcome: VM left alive and unsignalled (same starttime), record errored"
else
  bad "unsafe/undocumented outcome without CAP_SYS_PTRACE: state='$NO_PTRACE_STATE' alive=$NO_PTRACE_ALIVE start='$NO_PTRACE_START' original='$PID_START'"
fi

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
CLEAN_STATE=$(api "$API/v1/instances/$ID" | jq -r '.state // "missing"' 2>/dev/null || true)
if [ "$CLEAN_STATE" = errored ] || [ "$CLEAN_STATE" = stopped ] || [ "$CLEAN_STATE" = missing ]; then
  ok "after restore the instance is no longer running (state=$CLEAN_STATE)"
else
  bad "after restore the instance still reports state '$CLEAN_STATE'"
fi
sleep 1
if [ -e "$JAILBASE/$ID" ]; then bad "jail dir still present after cleanup"; else ok "jail dir removed after cleanup"; fi
if ip link show dev "$TAP" >/dev/null 2>&1; then bad "tap still present after cleanup"; else ok "tap removed after cleanup"; fi
if fc_procs "$ID" | grep -q .; then bad "a firecracker process for $ID survived cleanup"; else ok "no firecracker process for $ID remains"; fi

api_code DELETE "/v1/instances/$ID" >/dev/null 2>&1 || true
echo
echo "NOTE: CAP_SYS_PTRACE is genuinely required. Removing it makes the agent report"
echo "      'vm died' for a live VM and leaves the process unverifiable (see RESULTS.md)."
finish
