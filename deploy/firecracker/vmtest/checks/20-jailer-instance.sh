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
ALIVE=0
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  ALIVE=1
  ok "firecracker process $PID is alive"
else
  bad "firecracker process is not alive"
fi
if [ -z "$JAILROOT" ]; then bad "agent state has no vm.jailRoot for $ID"; fi
if [ "$ALIVE" = 1 ]; then
  expect_eq "$(ps -o user= -p "$PID" | tr -d ' ')" 10000 \
    "firecracker runs as jailUid 10000"
  EXE=$(readlink "/proc/$PID/exe") || EXE=
  if [ -n "$EXE" ]; then
    expect_eq "$EXE" /firecracker "chrooted process sees its executable as /firecracker"
  else
    bad "could not readlink /proc/$PID/exe"
  fi
  if [ -n "$JAILROOT" ]; then
    EXE_INO=$(stat -Lc '%d:%i' "/proc/$PID/exe") || EXE_INO=
    JAIL_INO=$(stat -Lc '%d:%i' "$JAILROOT/firecracker") || JAIL_INO=
    if [ -n "$EXE_INO" ] && [ -n "$JAIL_INO" ]; then
      expect_eq "$EXE_INO" "$JAIL_INO" \
        "process executable inode is the copy inside the jail root (identity anchor)"
    else
      bad "could not stat executable identities (proc='$EXE_INO' jail='$JAIL_INO')"
    fi
    ROOT_INO=$(stat -Lc '%d:%i' "/proc/$PID/root") || ROOT_INO=
    JAIL_ROOT_INO=$(stat -Lc '%d:%i' "$JAILROOT") || JAIL_ROOT_INO=
    if [ -n "$ROOT_INO" ] && [ -n "$JAIL_ROOT_INO" ]; then
      expect_eq "$ROOT_INO" "$JAIL_ROOT_INO" \
        "process root is the jailer chroot (device+inode)"
    else
      bad "could not stat root identities (proc='$ROOT_INO' jail='$JAIL_ROOT_INO')"
    fi
  else
    bad "skipping executable/root inode identity: jail root unknown"
  fi
  ARGS=$(tr '\0' ' ' <"/proc/$PID/cmdline") || ARGS=
  if [ -n "$ARGS" ]; then
    expect_match "$ARGS" "(^| )--id $ID( |\$)" "process cmdline carries --id $ID"
    case "$ARGS" in
      *"--id $ID --id"*) bad "duplicate --id on the firecracker cmdline" ;;
      *) ok "jailer did not pass a duplicate --id" ;;
    esac
  else
    bad "could not read the firecracker command line"
  fi
else
  bad "aborting executable/root inode identity checks: process $PID is not alive"
  ARGS=
fi

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
CANARY="rctf{vmtest-scan-canary-$(date +%s)-$RANDOM}"
SCAN_ERR=/tmp/vmtest-scan-$ID.err
SCAN_DIRS=()
for d in "$STATE" "$RUNDIR" /srv/jailer /etc/traefik/dynamic/rctf-firecracker; do
  if [ ! -d "$d" ]; then
    bad "flag-absence scan root missing: $d"
  elif [ ! -r "$d" ]; then
    bad "flag-absence scan root not readable: $d"
  else
    SCAN_DIRS+=("$d")
  fi
done
if [ "${#SCAN_DIRS[@]}" -gt 0 ]; then
  TREE_LIST=$(find "${SCAN_DIRS[@]}" -type f 2>"$SCAN_ERR")
  FIND_RC=$?
  TREE_COUNT=$(printf '%s\n' "$TREE_LIST" | grep -c . || true)
  if [ "$FIND_RC" -ne 0 ]; then
    bad "find failed while enumerating the scan tree: $(cat "$SCAN_ERR")"
  elif [ "$TREE_COUNT" -gt 0 ]; then
    ok "scanned $TREE_COUNT files under ${#SCAN_DIRS[@]} searchable roots"
  else
    bad "flag-absence scan found no regular files to search"
  fi
else
  TREE_COUNT=0
  bad "no searchable directories for the flag-absence scan"
fi

scan_tree_for() { # scan_tree_for <needle>; returns 0 found, 1 absent, 2 probe error
  local needle=$1 out rc
  out=$(grep -ralF -- "$needle" "${SCAN_DIRS[@]}" 2>"$SCAN_ERR")
  rc=$?
  case "$rc" in
    0) printf '%s\n' "$out"; return 0 ;;
    1) return 1 ;;
    *)
      printf 'grep probe failed (rc=%d): %s\n' "$rc" "$(cat "$SCAN_ERR")" >&2
      return 2
      ;;
  esac
}

HITS=$(scan_tree_for "$FLAG")
SCAN_RC=$?
if [ "$SCAN_RC" -eq 0 ]; then
  bad "flag found on host disk: $HITS"
elif [ "$SCAN_RC" -eq 1 ]; then
  ok "flag is absent from agent state, run dir, jail tree and Traefik dir ($TREE_COUNT files)"
else
  bad "flag-absence tree probe failed (see above)"
fi

# Positive control: the same scanner must find a planted canary in this tree.
CANARY_FILE=$RUNDIR/.vmtest-scan-canary-$ID
if printf '%s\n' "$CANARY" >"$CANARY_FILE"; then
  HITS=$(scan_tree_for "$CANARY")
  SCAN_RC=$?
  rm -f "$CANARY_FILE"
  if [ "$SCAN_RC" -eq 0 ] && printf '%s\n' "$HITS" | grep -qxF "$CANARY_FILE"; then
    ok "positive control: tree scan found the planted canary in its scanned file"
  else
    bad "positive control failed: tree scan did not find the planted canary (rc=$SCAN_RC, hits='$HITS')"
  fi
else
  bad "could not plant the tree-scan canary at $CANARY_FILE"
fi

# Journal: fail closed when journalctl itself fails, and prove the journal
# probe is sensitive with a planted canary.
JOURNAL=/tmp/vmtest-journal-$ID.txt
if journalctl --no-pager >"$JOURNAL" 2>"$JOURNAL.err"; then
  JLINE_COUNT=$(wc -l <"$JOURNAL")
  if [ "$JLINE_COUNT" -gt 0 ]; then
    if grep -qF "$FLAG" "$JOURNAL"; then
      bad "flag found in the journal"
    else
      ok "flag is absent from the journal ($JLINE_COUNT lines searched)"
    fi
  else
    bad "journal is empty; cannot prove the flag is absent from it"
  fi
  logger -t rctf-vmtest-canary "$CANARY" || bad "logger failed; cannot plant a journal canary"
  for _ in $(seq 1 25); do
    journalctl --no-pager 2>/dev/null | grep -qF "$CANARY" && break
    sleep 0.2
  done
  if journalctl --no-pager 2>/dev/null | grep -qF "$CANARY"; then
    ok "positive control: journal scan finds the planted canary"
  else
    bad "positive control failed: journal scan did not find the planted canary"
  fi
else
  bad "journalctl failed; cannot assert the flag is absent from the journal: $(cat "$JOURNAL.err")"
fi

if printf '%s' "$ARGS" | grep -qF "$FLAG"; then
  bad "flag found on the firecracker command line"
elif [ -n "$ARGS" ]; then
  ok "flag is absent from the firecracker command line"
else
  bad "firecracker command line was not readable; cannot assert flag absence"
fi

# Explicit rootfs/base-image probes: test -f first, never scan a missing path.
ROOTFS=$RUNDIR/$ID/rootfs.ext4
if [ -f "$ROOTFS" ] && [ -r "$ROOTFS" ]; then
  grep -qaF "$FLAG" "$ROOTFS"
  rc=$?
  case "$rc" in
    0) bad "flag found in the per-instance rootfs disk image" ;;
    1) ok "flag is absent from the per-instance rootfs disk image" ;;
    *) bad "could not scan the per-instance rootfs disk image (grep rc=$rc)" ;;
  esac
else
  bad "per-instance rootfs missing or unreadable: $ROOTFS"
fi

BASE_ROOTS=()
while IFS= read -r f; do
  [ -n "$f" ] && BASE_ROOTS+=("$f")
done < <(find "$IMAGES" -mindepth 2 -maxdepth 2 -name rootfs.ext4 -type f 2>/dev/null)
if [ "${#BASE_ROOTS[@]}" -eq 0 ]; then
  bad "no base image rootfs.ext4 files found under $IMAGES"
else
  BASE_BAD=0
  for f in "${BASE_ROOTS[@]}"; do
    if [ ! -r "$f" ]; then
      bad "base image not readable: $f"
      BASE_BAD=1
      continue
    fi
    grep -qaF "$FLAG" "$f"
    rc=$?
    case "$rc" in
      0) bad "flag found in a base image: $f"; BASE_BAD=1 ;;
      1) : ;;
      *) bad "could not scan base image (grep rc=$rc): $f"; BASE_BAD=1 ;;
    esac
  done
  [ "$BASE_BAD" -eq 0 ] &&
    ok "flag is absent from all ${#BASE_ROOTS[@]} base images (tested non-empty, readable files)"
fi

# Positive control for the binary scan: grep -a must find a canary in a binary.
BIN_CANARY=/tmp/vmtest-binary-canary-$ID
printf '\000\000%s\000\000' "$CANARY" >"$BIN_CANARY"
if grep -qaF "$CANARY" "$BIN_CANARY"; then
  ok "positive control: binary (grep -a) scan finds a planted canary"
else
  bad "positive control failed: binary (grep -a) scan did not find a planted canary"
fi
rm -f "$BIN_CANARY"

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
