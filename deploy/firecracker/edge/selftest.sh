#!/bin/bash
# Mutation proofs for the hardened edge assertions (items 1, 2 and 3 of the
# review). Each case deliberately breaks the condition and requires the SAME
# assertion the phases use to FAIL; the matching correct case must PASS.
# Runs in its own network namespace (inner.sh does `unshare -n`) and prints
# SELFTEST lines, which inner.sh counts separately from CHECK lines.
set -u
: "${RUN:?}" "${EDGE:?}"
. "$EDGE/lib/assert.sh"

ST=$RUN/selftest
mkdir -p "$ST"
PIDS=()
cleanup() {
  set +e
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
}
trap cleanup EXIT INT TERM

passes=0
failures=0
st_pass() { passes=$((passes + 1)); printf 'SELFTEST %s PASS %s\n' "$1" "$2"; }
st_fail() { failures=$((failures + 1)); printf 'SELFTEST %s FAIL %s\n' "$1" "$2"; }

ip link set lo up
# A fresh network namespace does not track conntrack until nf_conntrack hooks
# are registered; a trivial `ct` rule does that (the phases get it from the
# real rendered ruleset). Without this, every conntrack assertion would be
# vacuously "gone".
nft add table inet selftest_ct
nft add chain inet selftest_ct input '{ type filter hook input priority filter; policy accept; }'
nft add rule inet selftest_ct input ct state established,related accept
nft add chain inet selftest_ct output '{ type filter hook output priority filter; policy accept; }'
nft add rule inet selftest_ct output ct state established,related accept

# ===========================================================================
# 1. conntrack: presence immediately before the flush + exit 0 is what proves
#    the flush removed the tuple. Mutation: flush the WRONG address; the tuple
#    must survive, so the phase's post-flush absence assertion would fail.
# ===========================================================================
python3 "$EDGE/lib/upstream.py" --hold 18080 >"$ST/upstream.log" 2>&1 & PIDS+=("$!")
sleep 0.3
HOLD_QUIET=1 python3 "$EDGE/lib/hold_client.py" 127.0.0.1 18080 40000 20 >"$ST/hold.log" 2>&1 & PIDS+=("$!")
for i in $(seq 1 40); do
  grep -q connected "$ST/hold.log" 2>/dev/null && break
  sleep 0.1
done
sleep 0.3
if ! conntrack_has_ip 127.0.0.1; then
  st_fail 1 "could not create a loopback conntrack tuple (hold: $(tr '\n' ' ' <"$ST/hold.log"))"
else
  flush_guest_conntrack 10.99.99.99 >/dev/null 2>&1
  WRONG_RC=$?
  if [ "$WRONG_RC" -eq 0 ] && conntrack_has_ip 127.0.0.1; then
    st_pass 1 "mutation caught: flushing the wrong address exits 0 but leaves the tuple, so 'gone after flush' cannot pass falsely"
  else
    st_fail 1 "mutation not caught (flush rc=$WRONG_RC, tuple present=$(conntrack_has_ip 127.0.0.1 && echo yes || echo no))"
  fi
  if flush_guest_conntrack 127.0.0.1 >/dev/null 2>&1 && ! conntrack_has_ip 127.0.0.1; then
    st_pass 1b "the real flush of the right address exits 0 and removes the tuple (the hardened assertion passes when it should)"
  else
    st_fail 1b "the real flush of the right address did not remove the tuple"
  fi
fi

# ===========================================================================
# 2. guest probe: a dead nc is 'error', never 'blocked'; the probe assertion
#    fails closed on empty/unparseable/error lines. Mutation: fake nc exits 127
#    (or is missing) and must NOT be accepted as scan=blocked.
# ===========================================================================
mk_fake_nc() { # dir exit-code
  mkdir -p "$1"
  printf '#!/bin/sh\nexit %s\n' "$2" >"$1/nc"
  chmod +x "$1/nc"
}
mk_fake_nc "$ST/nc-reached" 0
mk_fake_nc "$ST/nc-blocked" 1
mk_fake_nc "$ST/nc-error" 127
scan_with() { # PATH value
  EDGE_PROBE_ONCE=1 SCAN_PEER=127.0.0.1 SCAN_PORT=1 PATH="$1" \
    /bin/sh "$EDGE/lib/guest-start" 2>/dev/null
}
S_REACHED=$(scan_with "$ST/nc-reached:$PATH")
S_BLOCKED=$(scan_with "$ST/nc-blocked:$PATH")
S_ERROR=$(scan_with "$ST/nc-error:$PATH")
S_MISSING=$(scan_with "/nonexistent")
if [ "$S_REACHED" = scan=REACHED ] && [ "$S_BLOCKED" = scan=blocked ] &&
   [ "$S_ERROR" = scan=error ] && [ "$S_MISSING" = scan=error ]; then
  st_pass 2 "probe classification: nc success=REACHED, refusal=blocked, nc exit 127=error, nc missing=error (never blocked)"
else
  st_fail 2 "probe classification wrong (REACHED='$S_REACHED' blocked='$S_BLOCKED' error='$S_ERROR' missing='$S_MISSING')"
fi
if probe_scan_blocked "peer=blocked host=blocked scan=blocked" &&
   ! probe_scan_blocked "" &&
   ! probe_scan_blocked "peer=blocked host=blocked" &&
   ! probe_scan_blocked "peer=blocked host=blocked scan=error"; then
  st_pass 2b "probe assertion fails closed on empty/unparseable/error lines and accepts only a valid scan=blocked"
else
  st_fail 2b "probe assertion accepted an empty/unparseable/error probe"
fi

# ===========================================================================
# 3. closed port: a published port must connect from the same netns/tool
#    immediately before the unpublished port is asserted closed. Mutation:
#    the "published" probe is dead, so the assertion must FAIL instead of
#    reporting the port closed.
# ===========================================================================
python3 -m http.server 25000 --bind 127.0.0.1 >"$ST/http.log" 2>&1 & PIDS+=("$!")
for i in $(seq 1 40); do
  port_connects 127.0.0.1 25000 && break
  sleep 0.1
done
if assert_port_closed 127.0.0.1 25000 25099; then
  st_pass 3 "published port connects and unpublished port is refused in the same netns (assertion passes when it should)"
else
  st_fail 3 "published port 25000 did not connect (server log: $(tr '\n' ' ' <"$ST/http.log"))"
fi
if assert_port_closed 127.0.0.1 25098 25099; then
  st_fail 3b "mutation not caught: a dead 'published' probe was accepted as a closed unpublished port"
else
  st_pass 3b "mutation caught: when the published probe does not connect, the closed-port assertion fails"
fi

printf 'RESULT selftest: %d passed, %d failed\n' "$passes" "$failures"
[ "$failures" -eq 0 ]
