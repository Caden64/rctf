#!/bin/bash
# Runs INSIDE `unshare -Urn` (started by run.sh). Builds one guest image and runs
# three independent phases, each in its own nested network namespace:
#
#   phase-agent     real Firecracker guests + real agent + real Traefik + real nft/conntrack
#   phase-veth      real nft rules with veth-backed "guests" (anti-spoof, nmap, conntrack reuse)
#   phase-lifecycle real NetworkManager: 10 concurrent leases, teardown, quarantine
set -u
: "${RUN:?run via run.sh}"
: "${EDGE:?}" "${REPO:?}" "${ARTIFACTS:?}" "${TRAEFIK:?}"
SUMMARY=$RUN/logs/summary.log
: >"$SUMMARY"

cleanup() {
  local rc=$?
  echo "edge-test: run dir $RUN (logs in $RUN/logs)" >&2
  if [ "${KEEP_RUN:-0}" = 1 ] || [ $rc -ne 0 ]; then
    echo "edge-test: keeping $RUN for inspection"
  else
    rm -rf "$RUN"
  fi
}
trap cleanup EXIT INT TERM

say() { echo "$*" | tee -a "$SUMMARY"; }
pass() { printf 'CHECK %s PASS %s\n' "$1" "${*:2}" | tee -a "$SUMMARY"; }
fail() { printf 'CHECK %s FAIL %s\n' "$1" "${*:2}" | tee -a "$SUMMARY"; }
phase_rc=0

run_phase() {
  local name=$1 script=$2 limit=$3
  local out=$RUN/logs/$name.log
  say ""
  say "=== phase: $name ==="
  timeout "$limit" unshare -n bash "$script" >"$out" 2>&1
  local rc=$?
  cat "$out" >>"$SUMMARY"
  sed -n 's/^CHECK /  /p' "$out"
  local p f
  p=$(grep -c '^CHECK .* PASS' "$out" 2>/dev/null || true); p=${p:-0}
  f=$(grep -c '^CHECK .* FAIL' "$out" 2>/dev/null || true); f=${f:-0}
  say "--- phase $name exit=$rc ($p pass, $f fail)"
  [ $rc -eq 0 ] || phase_rc=1
}

# Mutation proofs for the hardened assertions: the same checks the phases use
# are run against deliberately broken conditions and must FAIL. This is a
# separate, short netns so it cannot disturb a phase.
run_selftest() {
  local out=$RUN/logs/selftest.log
  say ""
  say "=== selftest: mutation proofs for conntrack flush / probe / closed-port assertions ==="
  timeout 120 unshare -n bash "$EDGE/selftest.sh" >"$out" 2>&1
  local rc=$?
  cat "$out" >>"$SUMMARY"
  sed -n 's/^SELFTEST /  /p' "$out"
  local p f
  p=$(grep -c '^SELFTEST .* PASS' "$out" 2>/dev/null || true); p=${p:-0}
  f=$(grep -c '^SELFTEST .* FAIL' "$out" 2>/dev/null || true); f=${f:-0}
  say "--- selftest exit=$rc ($p pass, $f fail)"
  [ $rc -eq 0 ] || phase_rc=1
}

# ---------------------------------------------------------------------------
# Guest image: the smoke rootfs plus our own /app/start (identity HTTP server,
# raw TCP hold listener, egress/peer probe loop). Artifacts stay read-only.
# ---------------------------------------------------------------------------
build_guest_image() {
  say "=== building guest image (mkfs.ext4 -d, no root) ==="
  local stage=$RUN/guestroot
  rm -rf "$stage"
  # Shared cache lock while snapshotting and building: a concurrent
  # fetch-artifacts.sh run holds this lock exclusively and rebuilds
  # fc-extract/rootdir in place, and build-rootfs.sh reads the cached jq.
  : >>"$ARTIFACTS/.fetch.lock"
  (
    flock -s 9
    cp -a "$ARTIFACTS/dl/rootdir" "$stage"
    cp "$EDGE/lib/guest-start" "$stage/app/start"
    chmod 0755 "$stage/app/start"
    cp "$ARTIFACTS/images/smoke/vmlinux" "$RUN/images/edge/vmlinux"
    sh "$REPO/deploy/firecracker/guest/build-rootfs.sh" \
      --dir "$stage" --size 64M \
      --jq "$ARTIFACTS/dl/jq" \
      --init "$REPO/deploy/firecracker/guest/init" \
      --out "$RUN/images/edge/rootfs.ext4" >>"$SUMMARY" 2>&1 || {
      fail 0.log "guest image build failed"
      exit 1
    }
  ) 9<"$ARTIFACTS/.fetch.lock" || exit 1
  say "guest image ready: $RUN/images/edge/rootfs.ext4"
}

build_guest_image

run_selftest
run_phase agent     "$EDGE/lib/phase-agent.sh"     480
run_phase veth      "$EDGE/lib/phase-veth.sh"      240
run_phase lifecycle "$EDGE/lib/phase-lifecycle.sh" 240

passes=$(grep -c '^CHECK .* PASS' "$SUMMARY" || true)
failures=$(grep -c '^CHECK .* FAIL' "$SUMMARY" || true)
st_passes=$(grep -c '^SELFTEST .* PASS' "$SUMMARY" || true)
st_failures=$(grep -c '^SELFTEST .* FAIL' "$SUMMARY" || true)
passes=${passes:-0}; failures=${failures:-0}
st_passes=${st_passes:-0}; st_failures=${st_failures:-0}
say ""
say "RESULT: ${passes} passed, ${failures} failed"
say "SELFTEST RESULT: ${st_passes} passed, ${st_failures} failed"
[ "$failures" -eq 0 ] && [ "$st_failures" -eq 0 ] && [ "$phase_rc" -eq 0 ]
