#!/usr/bin/env bash
# Check c) create a VM through the agent HTTP API in JAILER mode and prove the
# jail invariants, MMDS flag delivery, no on-disk flag, and full teardown.
. "$(dirname "$0")/lib.sh"

ID=vmtest$(date +%s)j1
FLAG="rctf{vmtest-jailer-$(date +%s)-canary}"
SPEC=/tmp/vmtest-spec-$ID.json

section "c) jailer-mode create via the agent HTTP API"
net_setup

# This whole check must run under the SHIPPED unit, not a test-only drop-in.
UNIT_SRC=$REPO/deploy/firecracker/host/rctf-firecracker-agent.service
UNIT_DST=/etc/systemd/system/rctf-firecracker-agent.service
expect_eq "$(sha256sum "$UNIT_DST" | cut -d' ' -f1)" \
  "$(sha256sum "$UNIT_SRC" | cut -d' ' -f1)" \
  "installed unit is byte-identical to the repository unit"
if [ -d "$UNIT_DST.d" ] && [ -n "$(ls -A "$UNIT_DST.d" 2>/dev/null)" ]; then
  bad "a systemd drop-in is installed ($(ls "$UNIT_DST.d"))"
else
  ok "no systemd drop-in installed (shipped unit alone)"
fi
expect_eq "$(ip -br addr show "$OUT_IF" | awk '{print $3}')" "$OUT_HOST_IP/24" \
  "outside test peer network is up on $OUT_IF"
outside_http_start || bad "outside HTTP service did not start"

make_spec "$SPEC" "$ID" vmtest true "$FLAG" \
  "10.200.0.2 10.200.0.6 10.200.0.10 10.200.0.14" "$OUT_PEER_IP:$OUT_HTTP_PORT"
CODE=$(api_code PUT "/v1/instances/$ID" "$SPEC")
echo "  create: HTTP $CODE $(api_body | head -c 400)"
rm -f "$SPEC"
if [ "$CODE" = 200 ] || [ "$CODE" = 201 ]; then ok "create accepted in jailer mode"; else
  bad "create rejected (HTTP $CODE)"
  journalctl -u rctf-firecracker-agent --no-pager -n 60 >&2
  finish
  exit 1
fi

if wait_state "$ID" running 180; then
  ok "instance reaches state running under the jailer"
  ok "jailer launched Firecracker under the shipped unit (no drop-in)"
else
  bad "instance did not reach running: $(api "$API/v1/instances/$ID" | head -c 500)"
  journalctl -u rctf-firecracker-agent --no-pager -n 80 | tail -40 >&2
fi

SJ=$(id_json "$ID")
PID=$(vm_pid "$ID")
JAILROOT=$(state_field "$ID" '.vm.jailRoot')
GUEST=$(lease_guest_ip "$ID")
HOSTIP=$(lease_host_ip "$ID")
TAP=$(lease_tap "$ID")
PUB=$(lease_port "$ID")
echo "  pid=$PID guest=$GUEST host=$HOSTIP tap=$TAP public=$PUB jail=$JAILROOT"

# --- process identity / jail ----------------------------------------------
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then ok "firecracker process $PID is alive"; else
  bad "firecracker process is not alive"
fi
expect_eq "$(ps -o user= -p "$PID" 2>/dev/null | tr -d ' ')" 10000 \
  "firecracker runs as jailUid 10000"
EXE=$(readlink "/proc/$PID/exe" 2>/dev/null || true)
expect_eq "$EXE" /firecracker "chrooted process sees its executable as /firecracker"
expect_eq "$(stat -Lc '%d:%i' "/proc/$PID/exe" 2>/dev/null)" \
  "$(stat -Lc '%d:%i' "$JAILROOT/firecracker" 2>/dev/null)" \
  "process executable inode is the copy inside the jail root (identity anchor)"
expect_eq "$(stat -Lc '%d:%i' "/proc/$PID/root" 2>/dev/null)" \
  "$(stat -Lc '%d:%i' "$JAILROOT" 2>/dev/null)" \
  "process root is the jailer chroot (device+inode)"
ARGS=$(tr '\0' ' ' <"/proc/$PID/cmdline" 2>/dev/null || true)
expect_match "$ARGS" "(^| )--id $ID( |$)" "process cmdline carries --id $ID"
case "$ARGS" in
  *"--id $ID --id"*) bad "duplicate --id on the firecracker cmdline" ;;
  *) ok "jailer did not pass a duplicate --id" ;;
esac

# --- cgroup ----------------------------------------------------------------
CGROUP=/sys/fs/cgroup/firecracker/$ID
if [ -d "$CGROUP" ]; then ok "per-instance cgroup exists ($CGROUP)"; else
  bad "per-instance cgroup missing ($CGROUP)"
fi
expect_eq "$(cat "$CGROUP/pids.max" 2>/dev/null)" 512 "cgroup pids.max=512 applied"
if grep -qx "$PID" "$CGROUP/cgroup.procs" 2>/dev/null; then
  ok "firecracker pid is a member of its per-instance cgroup"
else
  bad "firecracker pid is not in the per-instance cgroup"
fi

# --- tap -------------------------------------------------------------------
LINK=$(ip -d -o link show dev "$TAP" 2>/dev/null || true)
expect_match "$LINK" 'tun type tap' "$TAP is a real tun/tap device"
expect_match "$LINK" 'alias rctf-fc:rctf-fc' "$TAP carries the durable ownership alias"
expect_eq "$(ip -4 -o addr show dev "$TAP" | awk '{print $4}')" "$HOSTIP/30" \
  "$TAP has the host side of the dedicated /30"

# --- MMDS / flag -----------------------------------------------------------
GOT=
for _ in $(seq 1 20); do
  GOT=$(guest_get "$GUEST" /flag.txt)
  [ "$GOT" = "$FLAG" ] && break
  sleep 0.5
done
echo "  guest served: $GOT"
expect_eq "$GOT" "$FLAG" "flag delivered through MMDS v2, byte-exact"
if probe_wait_for "$GUEST" 'outside=' 20; then
  PROBE=$(guest_get "$GUEST" /probe.txt)
  echo "  guest probe: $PROBE"
  ok "guest environment was delivered and the service is running"
else
  bad "guest probe never produced output (env/MMDS delivery problem)"
fi

# --- flag must not be persisted on the host -------------------------------
HITS=$(grep -ralF "$FLAG" "$STATE" "$RUNDIR" /srv/jailer /etc/traefik/dynamic/rctf-firecracker 2>/dev/null || true)
if [ -z "$HITS" ]; then
  ok "flag is absent from agent state, run dir, jail tree and Traefik dir"
else
  bad "flag found on host disk: $HITS"
fi
if journalctl -u rctf-firecracker-agent --no-pager 2>/dev/null | grep -qF "$FLAG"; then
  bad "flag found in the agent journal"
else
  ok "flag is absent from the agent journal"
fi
if printf '%s' "$ARGS" | grep -qF "$FLAG"; then
  bad "flag found on the firecracker command line"
else
  ok "flag is absent from the firecracker command line"
fi
if grep -qaF "$FLAG" "$RUNDIR/$ID/rootfs.ext4" 2>/dev/null; then
  bad "flag found in the per-instance rootfs disk image"
else
  ok "flag is absent from the per-instance rootfs disk image"
fi
if grep -qaF "$FLAG" "$IMAGES"/*/rootfs.ext4 2>/dev/null; then
  bad "flag found in a base image"
else
  ok "flag is absent from the base images"
fi

# --- delete / teardown -----------------------------------------------------
CODE=$(api_code DELETE "/v1/instances/$ID")
echo "  delete: HTTP $CODE $(api_body | head -c 200)"
expect_eq "$CODE" 200 "delete accepted"
expect_eq "$(api_body | jq -r '.state' 2>/dev/null)" stopped "delete reports stopped"

sleep 1
if kill -0 "$PID" 2>/dev/null; then bad "firecracker process survived delete"; else
  ok "firecracker process removed"
fi
if [ -e "$JAILBASE/$ID" ]; then bad "jail directory still exists"; else ok "jail directory removed"; fi
if [ -e "$CGROUP" ]; then bad "cgroup still exists"; else ok "per-instance cgroup removed"; fi
if ip link show dev "$TAP" >/dev/null 2>&1; then bad "tap $TAP still exists"; else ok "tap $TAP removed"; fi
if nft list table inet rctf_fc 2>/dev/null | grep -qF "$GUEST"; then
  bad "nftables still references the released guest IP"
else
  ok "nftables rules for the released guest IP removed"
fi
if nft list table inet rctf_fc 2>/dev/null | grep -qF "$TAP"; then
  bad "nftables still references the removed tap"
else
  ok "nftables rules for the removed tap removed"
fi

# --- fencing ---------------------------------------------------------------
make_spec "$SPEC" "$ID" vmtest true "rctf{fence-check}" "" ""
CODE=$(api_code PUT "/v1/instances/$ID" "$SPEC")
rm -f "$SPEC"
if [ "$CODE" = 409 ]; then
  ok "re-create of a deleted id is fenced (HTTP 409)"
else
  bad "re-create of a deleted id was not fenced (HTTP $CODE)"
fi

finish
