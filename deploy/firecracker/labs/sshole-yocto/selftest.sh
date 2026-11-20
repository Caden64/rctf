#!/bin/bash
# Unprivileged selftest for the sshole-yocto check client.
#
# It does not need a VM or an ssh server. It proves that the result
# classifier is fail-closed (a transport error or unknown output can never be
# read as an authentication rejection), that the two-prompt askpass helper
# returns the passwords in order and refuses an unexpected extra prompt, and
# that the overlong password is inside the published 257..1024 byte range.
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

tmp=$(mktemp -d "${TMPDIR:-/tmp}/sshole-yocto-selftest.XXXXXX")
trap 'rm -rf "$tmp" "${askpass_dir:-}"' EXIT

expect_kind() { # <expected> <rc> <stderr-text> <label>
  printf '%s\n' "$3" >"$tmp/err"
  got=$(classify_ssh "$2" "$tmp/err")
  if [ "$got" = "$1" ]; then ok "$4 -> $1"; else
    bad "$4: expected $1, got $got (rc=$2 stderr=$3)"
  fi
}

printf 'sshole-yocto check-client selftest (no VM, no ssh server)\n'

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

# --- flag-source resolution ordering (app-start) ----------------------------
# The guest service /app/start resolves which flag file to publish. The lab
# runner delivers provider "main"; the event platform resolves the challenge's
# REGISTERED provider name verbatim ("flags/static" in challenge.yaml), which
# the guest init sanitizes to "flags_static". The resolution must accept
# both plus a single-file directory, and publish nothing for a flagless boot.
#
# This test extracts the REAL pick_flag_src function from the committed
# app-start (by name, from the authoritative file) so the tested code cannot
# drift from the shipped code. A missing function fails the selftest.
APP_START=$HERE/yocto/meta-sshhole/recipes-core/sshhole-lab-config/files/app-start
pick_src=$(sed -n '/^pick_flag_src() {$/,/^}$/p' "$APP_START")
if [ -n "$pick_src" ]; then
  # shellcheck disable=SC2317
  eval "$pick_src"
  if command -v pick_flag_src >/dev/null 2>&1; then
    run_pick() { # <dir>; prints the picked file or '<none>'
      local out
      if out=$(pick_flag_src "$1"); then printf '%s' "$out"; else printf '%s' '<none>'; fi
    }
    # 1. lab runner delivery: only "main" present.
    d=$tmp/flags-main
    mkdir -p "$d"
    printf 'flag-lab\n' >"$d/main"
    [ "$(run_pick "$d")" = "$d/main" ] &&
      ok 'flag resolution: picks main when only main exists' ||
      bad "flag resolution: main-only case picked '$(run_pick "$d")'"
    # 2. platform delivery: only "flags_static" present (flags/static).
    d=$tmp/flags-static
    mkdir -p "$d"
    printf 'flag-event\n' >"$d/flags_static"
    [ "$(run_pick "$d")" = "$d/flags_static" ] &&
      ok 'flag resolution: picks flags_static (the platform delivery name)' ||
      bad "flag resolution: flags_static case picked '$(run_pick "$d")'"
    # 3. both present: the lab-runner "main" keeps priority.
    printf 'flag-lab\n' >"$d/main"
    [ "$(run_pick "$d")" = "$d/main" ] &&
      ok 'flag resolution: main wins when both delivery names exist' ||
      bad "flag resolution: both-present case picked '$(run_pick "$d")'"
    # 4. a single file under any other name still publishes.
    d=$tmp/flags-other
    mkdir -p "$d"
    printf 'flag-single\n' >"$d/anything-else"
    [ "$(run_pick "$d")" = "$d/anything-else" ] &&
      ok 'flag resolution: falls back to the single flag file' ||
      bad "flag resolution: single-file fallback picked '$(run_pick "$d")'"
    # 5. two files with neither delivery name: ambiguous, publish nothing.
    printf 'flag-two\n' >"$d/second"
    [ "$(run_pick "$d")" = '<none>' ] &&
      ok 'flag resolution: ambiguous multi-file directory publishes nothing' ||
      bad "flag resolution: ambiguous case picked '$(run_pick "$d")'"
    # 6. flagless boot: empty (or missing) flags directory publishes nothing,
    #    which keeps the documented flagless-control behaviour.
    d=$tmp/flags-empty
    mkdir -p "$d"
    [ "$(run_pick "$d")" = '<none>' ] &&
      ok 'flag resolution: flagless boot publishes nothing (service still starts)' ||
      bad "flag resolution: flagless case picked '$(run_pick "$d")'"
    [ "$(run_pick "$tmp/flags-missing")" = '<none>' ] &&
      ok 'flag resolution: missing flags directory publishes nothing' ||
      bad "flag resolution: missing-dir case picked '$(run_pick "$tmp/flags-missing")'"
  else
    bad 'flag resolution: could not eval pick_flag_src from app-start'
  fi
else
  bad 'flag resolution: pick_flag_src is missing from the committed app-start'
fi

printf 'RESULT: sshole-yocto check-client selftest %s (%d failure(s))\n' \
  "$([ "$fail" -eq 0 ] && echo PASS || echo FAIL)" "$fail"
[ "$fail" -eq 0 ]
