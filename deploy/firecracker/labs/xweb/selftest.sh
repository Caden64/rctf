#!/bin/bash
# Unprivileged selftest for the xweb lab. No VM, no root, no guest binaries.
#
# What it proves, on the developer's own machine:
#   1. the fail-closed HTTP classifier classifies canned outcomes correctly
#      (a transport error or unknown body is INCONCLUSIVE and can never pass);
#   2. the lab-authored portal source behaves exactly as the challenge
#      specifies when driven with the payload set from check-http.sh:
#        vuln build:    admin/1234 -> flag; wrong code -> DENIED;
#                       ' OR 1=1 bypass -> flag; UNION login -> flag;
#                       UNION archive -> flag; bad-column UNION -> SQLERROR;
#                       no-flag boot -> no flag anywhere.
#        patched build: admin/1234 -> flag (control positive path);
#                       bypass -> DENIED; UNION archive -> ARCHIVE_EMPTY with
#                       no flag; bad-column UNION -> ARCHIVE_EMPTY.
#   3. the shell pieces of the lab pass syntax checks.
#
# The portal is LAB-AUTHORED SOURCE (app/*.py). It is executed here by the
# host's own python3 (3.14.10 on the reference machine, the same version the
# guest image pins); no file unpacked from a guest artifact is ever run on
# the host — build.sh never executes anything from its staging tree.
set -uo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
APP=$HERE/app
fail=0
pass=0
ok() { printf '  PASS: %s\n' "$*"; pass=$((pass + 1)); }
bad() { printf '  FAIL: %s\n' "$*" >&2; fail=$((fail + 1)); }
section() { printf '\n== %s\n' "$*"; }

finish() {
  printf '\nRESULT: xweb selftest %d passed, %d failed\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
}

cleanup() {
  set +e
  for pid in ${APP_PIDS:-}; do kill "$pid" 2>/dev/null; done
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

WORK=$(mktemp -d "${TMPDIR:-/tmp}/xweb-selftest.XXXXXX") || {
  echo 'xweb selftest: could not create a work dir' >&2
  exit 2
}
APP_PIDS=
LAST_PORT=
LAST_FLAGS=

command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 2; }
command -v curl >/dev/null || { echo 'curl is required' >&2; exit 2; }
pyver=$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')
printf 'xweb selftest (host python %s, unprivileged)\n' "$pyver"

# --- 1. classifier -----------------------------------------------------------
section 'fail-closed classifier (canned outcomes)'
expect_kind() { # <expected> <rc> <code> <body> <label>
  local got
  got=$(classify_xweb "$2" "$3" "$4")
  if [ "$got" = "$1" ]; then ok "$5 -> $1"; else
    bad "$5: expected $1, got $got"
  fi
}
export XWEB_CHECK_HTTP_SOURCE_ONLY=1
# shellcheck source=./check-http.sh
. "$HERE/check-http.sh"

expect_kind INCONCLUSIVE 7 000 '' 'connection refused'
expect_kind INCONCLUSIVE 28 000 '' 'connection timed out'
expect_kind INCONCLUSIVE 0 '' '' 'no HTTP status parsed'
expect_kind REDIRECT 0 302 '' 'login redirect'
expect_kind DENIED 0 200 '<div id="xweb-denied">ACCESS DENIED' 'themed denial'
expect_kind SQLERROR 0 200 '<div id="xweb-sqlerror">fault' 'themed SQL fault'
expect_kind LOGIN 0 200 '<div class="xweb-card" id="xweb-login">' 'login page'
expect_kind DASHBOARD 0 200 '<div id="xweb-dashboard">' 'dashboard page'
expect_kind SERVICE 0 200 '<div id="xweb-service">' 'service notes page'
expect_kind ARCHIVE 0 200 '<div class="xweb-card" id="xweb-archive"><table>' \
  'archive page with rows'
expect_kind ARCHIVE_EMPTY 0 200 \
  '<div class="xweb-card" id="xweb-archive"><div id="xweb-empty">' \
  'archive page with no rows'
expect_kind OTHER 0 200 '<html>some other complete answer</html>' \
  'unknown themed page is genuine-but-unclassified'
# marker precedence: a SQL fault rendered on a login page is a SQLERROR.
expect_kind SQLERROR 0 200 \
  '<div class="xweb-card" id="xweb-login"><div id="xweb-sqlerror">' \
  'SQL fault wins over the page id'

# --- 2. portal source behaviour ----------------------------------------------
section 'lab-authored portal source driven with the payload set'

pick_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
}

selftest_hex() { od -An -N4 -tx1 /dev/urandom | tr -d ' \n'; }

# start_portal <variant vuln|patched> <case>
#   case determines which flag-delivery name(s) exist in $RCTF_FLAGS_DIR:
#     main   -> flags/main                      (the lab runner provider name)
#     static -> flags/flags_static              (the platform provider name:
#               the challenge registers `flags/static`, the guest init
#               sanitises it to `flags_static`)
#     other  -> flags/factory_override only     (single-file fallback)
#     both   -> flags/main AND flags/flags_static with DIFFERENT values
#               (main must win; the other value must never appear)
#     multi  -> two unrecognised junk files     (ambiguous -> flagless)
#     none   -> empty directory                 (flagless)
start_portal() {
  local variant=$1 case=$2 port appdir flags
  appdir=$WORK/app-$variant-$case
  mkdir -p "$appdir"
  cp "$APP/xweb_common.py" "$appdir/xweb_common.py"
  cp "$APP/xweb_auth_$variant.py" "$appdir/xweb_auth.py"
  flags=$WORK/flags-$variant-$case
  mkdir -p "$flags"
  SELFTEST_FLAG=
  SELFTEST_LOSERS=
  case "$case" in
    main)
      SELFTEST_FLAG="rctf{xweb-selftest-$variant-main-$(selftest_hex)}"
      printf '%s' "$SELFTEST_FLAG" >"$flags/main"
      ;;
    static)
      SELFTEST_FLAG="rctf{xweb-selftest-$variant-static-$(selftest_hex)}"
      printf '%s' "$SELFTEST_FLAG" >"$flags/flags_static"
      ;;
    other)
      SELFTEST_FLAG="rctf{xweb-selftest-$variant-other-$(selftest_hex)}"
      printf '%s' "$SELFTEST_FLAG" >"$flags/factory_override"
      ;;
    both)
      SELFTEST_FLAG="rctf{xweb-selftest-$variant-bothmain-$(selftest_hex)}"
      SELFTEST_LOSERS="rctf{xweb-selftest-$variant-bothstatic-$(selftest_hex)}"
      printf '%s' "$SELFTEST_FLAG" >"$flags/main"
      printf '%s' "$SELFTEST_LOSERS" >"$flags/flags_static"
      ;;
    multi)
      SELFTEST_LOSERS="xweb-junk-alpha-$variant xweb-junk-beta-$variant"
      printf '%s' "xweb-junk-alpha-$variant" >"$flags/zz_alpha"
      printf '%s' "xweb-junk-beta-$variant" >"$flags/zz_beta"
      ;;
    none) : ;;
    *) bad "unknown start_portal case: $case"; return 1 ;;
  esac
  chmod 0400 "$flags"/* 2>/dev/null || true
  printf 'IMAGE=xweb-selftest-%s\n' "$variant" >"$WORK/build-$variant-$case"
  port=$(pick_port)
  XWEB_PORT=$port \
  XWEB_DB=$WORK/db-$variant-$case.db \
  XWEB_BUILD_FILE=$WORK/build-$variant-$case \
  RCTF_FLAGS_DIR=$flags \
  RCTF_INSTANCE_ID=selftest-$variant-$case \
  python3 "$appdir/xweb_common.py" >"$WORK/out-$variant-$case.log" 2>&1 &
  APP_PIDS="$APP_PIDS $!"
  # wait for the portal to answer
  local i
  for i in $(seq 1 60); do
    curl -s -o /dev/null "http://127.0.0.1:$port/" && break
    sleep 0.2
  done
  curl -s -o /dev/null "http://127.0.0.1:$port/" ||
    { bad "$variant/$case: portal did not start (log: $(tail -3 "$WORK/out-$variant-$case.log" 2>/dev/null))"; return 1; }
  LAST_PORT=$port
  LAST_FLAGS=$flags
  return 0
}

# assert no non-selected flags-dir value leaked into the last response.
expect_no_losers() { # <label>
  local label=$1 loser
  for loser in ${SELFTEST_LOSERS:-}; do
    if printf '%s' "$BODY" | grep -qF -- "$loser"; then
      bad "$label: a non-selected flags-dir value leaked into the page ($loser)"
    else
      ok "$label: the non-selected flags-dir value did not leak ($loser)"
    fi
  done
}

# http_kind <port> <method> <path> [curl args...] -> sets KIND, BODY, CODE
KIND= BODY= CODE= RC=
http_kind() {
  local port=$1 method=$2 path=$3
  shift 3
  local out rc code
  out=$(curl -s -o "$WORK/body" -w '%{http_code}' -X "$method" \
    "$@" "http://127.0.0.1:$port$path") && rc=0 || rc=$?
  code=$out
  BODY=$(cat "$WORK/body" 2>/dev/null)
  CODE=$code
  RC=$rc
  KIND=$(classify_xweb "$rc" "$code" "$BODY")
}

login_flow() { # <port> <jar> <user> <pass> -> KIND/BODY of the POST
  http_kind "$1" POST /login -c "$2" \
    --data-urlencode "username=$3" --data-urlencode "password=$4"
}

drive_portal() { # <variant> <case main|static|other|both|multi|none>
  local variant=$1 case=$2 port
  start_portal "$variant" "$case" || return 0
  port=$LAST_PORT
  local label="$variant/$case"
  local selftest_flag=${SELFTEST_FLAG:-}

  # login page theme markers
  http_kind "$port" GET /
  [ "$KIND" = LOGIN ] && ok "$label: / is the themed login page" ||
    bad "$label: / classified $KIND (expected LOGIN)"
  for marker in 'XWEB-500' 'Supervisor Portal' 'FW 5.00.10' \
    "Node: <span class=\"xweb-led\">selftest-$variant-$case</span>"; do
    if printf '%s' "$BODY" | grep -qF -- "$marker"; then
      ok "$label: login page shows themed marker: $marker"
    else
      bad "$label: login page is missing marker: $marker"
    fi
  done
  if printf '%s' "$BODY" | grep -qF 'auth=concat' &&
    [ "$variant" = vuln ]; then
    ok "$label: build comment reports auth=concat"
  elif printf '%s' "$BODY" | grep -qF 'auth=parameterized' &&
    [ "$variant" = patched ]; then
    ok "$label: build comment reports auth=parameterized"
  else
    bad "$label: build comment does not report the right auth mode"
  fi

  # default credentials
  jar_admin=$WORK/jar-$variant-$case-admin
  login_flow "$port" "$jar_admin" admin 1234
  if [ "$KIND" = REDIRECT ]; then
    ok "$label: admin/1234 authenticates (redirect to dashboard)"
  else
    bad "$label: admin/1234 classified $KIND (expected REDIRECT)"
  fi
  http_kind "$port" GET /dashboard -b "$jar_admin"
  [ "$KIND" = DASHBOARD ] && ok "$label: dashboard renders after login" ||
    bad "$label: dashboard classified $KIND"
  printf '%s' "$BODY" | grep -qF 'Operator: <span class="xweb-led">admin</span>' &&
    ok "$label: dashboard greets operator admin" ||
    bad "$label: dashboard does not greet admin"
  http_kind "$port" GET /service -b "$jar_admin"
  [ "$KIND" = SERVICE ] && ok "$label: service notes render for admin" ||
    bad "$label: service notes classified $KIND (expected SERVICE)"
  if [ -n "$selftest_flag" ]; then
    printf '%s' "$BODY" | grep -qF -- "$selftest_flag" &&
      ok "$label: service notes display the per-run flag" ||
      bad "$label: service notes do NOT display the per-run flag"
  else
    printf '%s' "$BODY" | grep -Eq 'rctf\{' &&
      bad "$label: flagless build still shows a flag-shaped string" ||
      ok "$label: flagless build shows no flag-shaped string"
  fi
  expect_no_losers "$label (service notes)"

  # wrong credentials (genuine negative on both builds)
  login_flow "$port" "$WORK/jar-$variant-$case-wrong" admin wrongcode
  [ "$KIND" = DENIED ] && ok "$label: wrong code is denied (genuine negative)" ||
    bad "$label: wrong code classified $KIND (expected DENIED)"

  # authentication bypass
  local bypass_user bypass_pass jar_bypass
  bypass_user=$(xweb_bypass_username)
  bypass_pass=$(xweb_bypass_password)
  jar_bypass=$WORK/jar-$variant-$case-bypass
  login_flow "$port" "$jar_bypass" "$bypass_user" "$bypass_pass"
  if [ "$variant" = vuln ]; then
    if [ "$KIND" = REDIRECT ]; then
      ok "$label: ' OR 1=1 bypass authenticates"
    else
      bad "$label: ' OR 1=1 bypass classified $KIND (expected REDIRECT)"
    fi
    http_kind "$port" GET /service -b "$jar_bypass"
    [ "$KIND" = SERVICE ] &&
      ok "$label: bypass session reaches the admin service notes" ||
      bad "$label: bypass session classified $KIND at /service"
    if [ -n "$selftest_flag" ]; then
      printf '%s' "$BODY" | grep -qF -- "$selftest_flag" &&
        ok "$label: bypass path exposes the per-run flag" ||
        bad "$label: bypass path did not expose the per-run flag"
    fi
  else
    [ "$KIND" = DENIED ] &&
      ok "$label: patched build denies the ' OR 1=1 bypass" ||
      bad "$label: patched build classified $KIND for the bypass (expected DENIED)"
  fi

  # UNION dump through the archive filter
  local union_probe
  union_probe=$(xweb_union_archive_probe)
  http_kind "$port" GET "/archive" -G --data-urlencode "probe=$union_probe"
  if [ "$variant" = vuln ]; then
    [ "$KIND" = ARCHIVE ] &&
      ok "$label: UNION archive dump renders rows" ||
      bad "$label: UNION archive dump classified $KIND (expected ARCHIVE)"
    if [ -n "$selftest_flag" ]; then
      printf '%s' "$BODY" | grep -qF -- "$selftest_flag" &&
        ok "$label: UNION archive dump exposes the per-run flag" ||
        bad "$label: UNION archive dump did not expose the per-run flag"
    else
      printf '%s' "$BODY" | grep -Eq 'rctf\{' &&
        bad "$label: flagless UNION dump fabricated a flag-shaped string" ||
        ok "$label: flagless UNION dump cannot fabricate a flag"
    fi
    expect_no_losers "$label (union archive dump)"
  else
    [ "$KIND" = ARCHIVE_EMPTY ] &&
      ok "$label: patched archive filter returns the empty state" ||
      bad "$label: patched archive classified $KIND (expected ARCHIVE_EMPTY)"
    printf '%s' "$BODY" | grep -qF -- "${SELFTEST_FLAG:-never}" &&
      bad "$label: patched archive leaked the flag" ||
      ok "$label: patched archive dump shows no flag"
  fi

  # UNION through the login form (login-as-data)
  local union_user jar_union
  union_user=$(xweb_union_login_username)
  jar_union=$WORK/jar-$variant-$case-union
  login_flow "$port" "$jar_union" "$union_user" whatever
  if [ "$variant" = vuln ]; then
    [ "$KIND" = REDIRECT ] &&
      ok "$label: UNION login authenticates as the dumped row" ||
      bad "$label: UNION login classified $KIND (expected REDIRECT)"
    http_kind "$port" GET /dashboard -b "$jar_union"
    if [ -n "$selftest_flag" ]; then
      printf '%s' "$BODY" | grep -qF -- "$selftest_flag" &&
        ok "$label: UNION login dumps the flag into the operator line" ||
        bad "$label: UNION login did not dump the flag"
    fi
  else
    [ "$KIND" = DENIED ] &&
      ok "$label: patched build denies the UNION login payload" ||
      bad "$label: patched UNION login classified $KIND (expected DENIED)"
  fi

  # wrong-column UNION
  local badcol_probe
  badcol_probe=$(xweb_badcol_archive_probe)
  http_kind "$port" GET "/archive" -G --data-urlencode "probe=$badcol_probe"
  if [ "$variant" = vuln ]; then
    [ "$KIND" = SQLERROR ] &&
      ok "$label: bad-column UNION surfaces a genuine SQL fault" ||
      bad "$label: bad-column UNION classified $KIND (expected SQLERROR)"
  else
    [ "$KIND" = ARCHIVE_EMPTY ] &&
      ok "$label: patched build treats bad-column UNION as plain data" ||
      bad "$label: patched bad-column UNION classified $KIND (expected ARCHIVE_EMPTY)"
  fi
}

# Delivery-name resolution matrix: the lab provider name, the platform
# provider name, the single-file fallback, main-first ordering, the ambiguous
# directory (flagless) and the empty directory (flagless).
SELFTEST_FLAG=
SELFTEST_LOSERS=
drive_portal vuln main
drive_portal patched main
drive_portal vuln none
drive_portal vuln static
drive_portal patched static
drive_portal vuln other
drive_portal vuln both
drive_portal vuln multi

# --- 3. syntax checks ----------------------------------------------------------
section 'lab shell pieces pass syntax checks'
for script in "$HERE/fetch-artifacts.sh" "$HERE/build.sh" "$HERE/run.sh" \
  "$HERE/inner.sh" "$HERE/check-http.sh"; do
  if [ -f "$script" ] && bash -n "$script"; then
    ok "bash -n $(basename "$script")"
  else
    bad "$(basename "$script") fails bash -n"
  fi
done
if sh -n "$APP/start"; then
  ok 'sh -n app/start (guest service script)'
else
  bad 'app/start fails sh -n'
fi
if python3 -m py_compile "$APP"/xweb_common.py "$APP"/xweb_auth_vuln.py \
  "$APP"/xweb_auth_patched.py; then
  ok 'app python sources compile'
else
  bad 'app python sources do not compile'
fi

finish
