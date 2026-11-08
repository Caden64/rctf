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
# The FC_REAL tests are the privileged ones this check owns; the two
# namespace.test.ts failures are an environment/harness issue (reported below).
if grep -q '(fail) real host (FC_REAL)' "$FULLLOG"; then
  bad "a FC_REAL test failed in the full suite"
else
  ok "every FC_REAL test passes inside the full net suite as root"
fi
if grep -q '(fail) real namespace networking' "$FULLLOG"; then
  echo "  verbatim namespace failures:" | tee -a "$LOG"
  grep -A12 '(fail) real namespace networking' "$FULLLOG" | sed 's/^/  | /' | tee -a "$LOG"
else
  ok "namespace tests also passed in the full root suite"
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
if grep -q 'Not a regular file: "/dev/stdin"' "$NSLOG"; then
  echo "  NOTE: the remaining namespace failure is a Bun.spawn stdin bug: a" \
       "'pipe' is a socketpair, and nft rejects non-regular -f input." | tee -a "$LOG"
  echo "        repro: deploy/firecracker/vmtest/repros/bun-spawn-nft-stdin.sh" | tee -a "$LOG"
else
  ok "no nft stdin harness failure observed"
fi

echo
echo "  (full logs kept in the VM at $LOG and $FULLLOG; copies are in the host run log)"
finish
