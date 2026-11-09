#!/bin/bash
# Unprivileged selftest for the sshole check client.
#
# It does not need a VM or an ssh server. It proves that the result classifier
# is fail-closed (a transport error or unknown output can never be read as an
# authentication rejection), that the two-prompt askpass helper returns the
# passwords in order and refuses an unexpected extra prompt, and that the
# overlong password is inside the published 257..1024 byte range.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
fail=0
ok() { printf '  PASS: %s\n' "$*"; }
bad() {
  printf '  FAIL: %s\n' "$*" >&2
  fail=$((fail + 1))
}

export SSHOLE_CHECK_CLIENT_SOURCE_ONLY=1
# shellcheck source=./check-client.sh
. "$HERE/check-client.sh"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/sshole-check-selftest.XXXXXX")
trap 'rm -rf "$tmp" "${askpass_dir:-}"' EXIT

expect_kind() { # <expected> <rc> <stderr-text> <label>
  printf '%s\n' "$3" >"$tmp/err"
  got=$(classify_ssh "$2" "$tmp/err")
  if [ "$got" = "$1" ]; then ok "$4 -> $1"; else
    bad "$4: expected $1, got $got (rc=$2 stderr=$3)"
  fi
}

printf 'sshole check-client selftest (no VM, no ssh server)\n'

# --- classifier -------------------------------------------------------------
expect_kind ACCEPT 0 '' 'successful login'
expect_kind REJECT 255 'alice@192.0.2.1: Permission denied (password).' \
  'definitive password rejection'
expect_kind REJECT 255 'Permission denied, please try again.' \
  'first prompt rejected (still conclusive when ssh then fails)'
expect_kind ERROR 255 'ssh: connect to host 192.0.2.1 port 30001: Connection refused' \
  'connection refused is inconclusive'
expect_kind ERROR 255 'ssh: connect to host 192.0.2.1 port 30001: Connection timed out' \
  'connection timeout is inconclusive'
expect_kind ERROR 255 'kex_exchange_identification: Connection closed by remote host' \
  'kex failure is inconclusive'
expect_kind ERROR 255 'Permission denied (password).
Connection closed by 192.0.2.1 port 30001' \
  'auth text plus a transport error is inconclusive'
expect_kind ERROR 1 'some unexpected local failure' 'unknown output is inconclusive'
expect_kind ERROR 20 '' 'timeout exit with no output is inconclusive'

# --- overlong password ------------------------------------------------------
long=$(sshole_long_password)
if [ "${#long}" -ge 257 ] && [ "${#long}" -le 1024 ]; then
  ok "overlong password is ${#long} bytes (inside 257..1024)"
else
  bad "overlong password is ${#long} bytes, expected 257..1024"
fi
if printf '%s' "$long" | grep -q '^A*$'; then
  ok 'overlong password contains only the expected filler'
else
  bad 'overlong password contains unexpected bytes'
fi

# --- askpass helper ---------------------------------------------------------
if make_askpass 'first-password' 'second-password'; then
  got1=$("$askpass_dir/askpass" 'alice@host password:')
  got2=$("$askpass_dir/askpass" 'alice@host password:')
  got3=$("$askpass_dir/askpass" 'alice@host password:')
  [ "$got1" = 'first-password' ] && ok 'askpass returns the first password' ||
    bad "askpass first value was '$got1'"
  [ "$got2" = 'second-password' ] && ok 'askpass returns the second password' ||
    bad "askpass second value was '$got2'"
  [ -z "$got3" ] && ok 'askpass refuses an unexpected third prompt (empty password)' ||
    bad "askpass third value was '$got3' (must be empty)"
else
  bad 'could not create the askpass helper'
fi

printf 'RESULT: sshole check-client selftest %s (%d failure(s))\n' \
  "$([ "$fail" -eq 0 ] && echo PASS || echo FAIL)" "$fail"
[ "$fail" -eq 0 ]
