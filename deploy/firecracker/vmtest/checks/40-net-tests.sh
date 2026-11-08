#!/usr/bin/env bash
# Check e) FC_REAL=1 privileged network tests as root, plus the unprivileged
# namespace tests. Failures are reported verbatim (never hidden).
. "$(dirname "$0")/lib.sh"

WORK=$REPO/apps/firecracker-instancer
LOG=/tmp/vmtest-net-tests.log

section "e) privileged network tests (FC_REAL=1)"

expect_match "$(nft --version 2>&1)" 'nftables v' "real nftables is installed"
expect_match "$(conntrack --version 2>&1)" 'conntrack v' "real conntrack-tools is installed"
expect_match "$(/usr/local/bin/bun --version)" '^1\.' "bun runs"

# --- the root-only FC_REAL tests ------------------------------------------
set +e
(cd "$WORK" && FC_REAL=1 /usr/local/bin/bun test test/net/real.test.ts) >"$LOG" 2>&1
REAL_CODE=$?
set +e
sed 's/^/  | /' "$LOG"
if [ "$REAL_CODE" -eq 0 ] && grep -q '0 fail' "$LOG"; then
  ok "FC_REAL=1 bun test test/net/real.test.ts passes as root"
else
  bad "FC_REAL=1 bun test test/net/real.test.ts failed (exit $REAL_CODE)"
fi
for t in 'rendered inet + arp ruleset passes nft -c' 'tap create/delete only touches our interface' \
  'conntrack flush succeeds on an empty table'; do
  if grep -qF "(pass) real host (FC_REAL) > $t" "$LOG"; then
    ok "real test passed: $t"
  else
    bad "real test did not pass: $t"
  fi
done

# --- the full net suite as root -------------------------------------------
FULLLOG=/tmp/vmtest-net-full.log
set +e
(cd "$WORK" && FC_REAL=1 /usr/local/bin/bun test test/net) >"$FULLLOG" 2>&1
FULL_CODE=$?
set +e
echo "  -- full suite tail --"
tail -25 "$FULLLOG" | sed 's/^/  | /'
if grep -q '(fail) real host (FC_REAL)' "$FULLLOG"; then
  bad "a FC_REAL test failed in the full suite"
else
  ok "every FC_REAL test passes inside the full net suite as root"
fi
# The namespace tests feed nft a real temp file (not a Bun stdin socketpair),
# so they must pass here too, as root and as ubuntu.
if [ "$FULL_CODE" -eq 0 ] && grep -q '^ 0 fail' "$FULLLOG"; then
  ok "FC_REAL=1 bun test test/net (full suite) passes as root with 0 failures"
else
  bad "FC_REAL=1 bun test test/net (full suite) failed as root (exit $FULL_CODE)"
fi

# --- the namespace tests as an unprivileged user ---------------------------
# They are designed for `unshare -Urn` as a normal user; Ubuntu 24.04 restricts
# unprivileged user namespaces by default, which the VM provisioning disables.
NSLOG=/tmp/vmtest-net-ns.log
set +e
(cd "$WORK" && su -s /bin/bash ubuntu -c "/usr/local/bin/bun test test/net/namespace.test.ts") >"$NSLOG" 2>&1
NS_CODE=$?
set +e
tail -15 "$NSLOG" | sed 's/^/  | /'
if grep -q '(pass) real namespace networking > dummy fctap9 survives restore' "$NSLOG"; then
  ok "real tap/alias/release namespace test passes as an unprivileged user"
else
  bad "real tap/alias/release namespace test failed as an unprivileged user"
fi
if grep -q '(pass) real namespace networking > full rendered ruleset' "$NSLOG"; then
  ok "real nft -c ruleset test passes as an unprivileged user (temp-file stdin)"
else
  bad "real nft -c ruleset test failed as an unprivileged user"
fi
if [ "$NS_CODE" -eq 0 ] && grep -q '^ 0 fail' "$NSLOG"; then
  ok "the namespace suite has no failures as an unprivileged user"
else
  bad "the namespace suite reported failures as an unprivileged user (exit $NS_CODE)"
fi

echo
echo "  (full logs kept in the VM at $LOG and $FULLLOG; copies are in the host run log)"
finish
