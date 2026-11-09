#!/usr/bin/env bash
#
# Unprivileged self-test for the PHP2Shell lab's fail-closed pieces.
#
# This does NOT need KVM, a VM, docker or root. It checks the pinned-digest
# plumbing, the offset/proof parsers, the shell syntax of every lab script and
# the laboratory configuration invariants. The chain itself is only exercised
# by run.sh inside the vmtest VM.
set -uo pipefail
. "$(dirname -- "$0")/lib.sh"

COUNT=0
FAIL=0
ok() {
  COUNT=$((COUNT + 1))
  printf '  PASS [%02d]: %s\n' "$COUNT" "$*"
}
bad() {
  COUNT=$((COUNT + 1))
  FAIL=$((FAIL + 1))
  printf '  FAIL [%02d]: %s\n' "$COUNT" "$*" >&2
}
expect_ok() { # expect_ok <description> <command...>
  local desc=$1
  shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi
}
expect_fail() {
  local desc=$1
  shift
  if "$@" >/dev/null 2>&1; then bad "$desc (unexpected success)"; else ok "$desc"; fi
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/p2s-selftest.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

printf 'PHP2Shell lab self-test (no VM, no root)\n'

# ---------------------------------------------------------------------------
# 1. Pinned digests and versions are well-formed.
# ---------------------------------------------------------------------------
for d in "$PHP_VULN_SHA256" "$PHP_FIXED_SHA256" "$HTTPD_SHA256" "$UBUNTU_BASE_SHA256"; do
  if printf '%s' "$d" | grep -Eq '^[0-9a-f]{64}$'; then
    ok "pinned digest is 64 lowercase hex"
  else
    bad "pinned digest is malformed: $d"
  fi
done
[ "$PHP_VULN" = 8.4.26 ] && ok "vulnerable PHP is the toolkit-verified 8.4.26" ||
  bad "vulnerable PHP is $PHP_VULN, expected 8.4.26"
[ "$PHP_FIXED" = 8.4.27 ] && ok "fixed control is 8.4.27 (first fixed 8.4 release)" ||
  bad "fixed control is $PHP_FIXED, expected 8.4.27"
[ "$HTTPD_VERSION" = 2.4.69 ] && ok "Apache is the profile's 2.4.69" ||
  bad "Apache is $HTTPD_VERSION, expected 2.4.69"

# ---------------------------------------------------------------------------
# 2. sha256 verification fails closed.
# ---------------------------------------------------------------------------
printf 'lab' >"$TMP/file"
GOOD=$(sha256_of "$TMP/file")
expect_ok "verify_sha256 accepts the matching digest" verify_sha256 "$TMP/file" "$GOOD" "selftest"
expect_fail "verify_sha256 rejects a wrong digest" verify_sha256 "$TMP/file" \
  "0000000000000000000000000000000000000000000000000000000000000000" "selftest"
expect_fail "verify_sha256 rejects a missing file" verify_sha256 "$TMP/nope" "$GOOD" "selftest"

# ---------------------------------------------------------------------------
# 3. Offsets parser: valid env accepted, malformed rejected.
# ---------------------------------------------------------------------------
mkdir -p "$TMP/img"
printf 'ZIF_OFFSET=0x465370\nDTOR_OFFSET=0x65eb60\n' >"$TMP/img/offsets.env"
if (read_offsets "$TMP/img" && [ "$ZIF_OFFSET" = 0x465370 ] && [ "$DTOR_OFFSET" = 0x65eb60 ]); then
  ok "read_offsets loads explicit symbol offsets"
else
  bad "read_offsets did not load valid offsets"
fi
printf 'ZIF_OFFSET=nope\nDTOR_OFFSET=0x1\n' >"$TMP/img/offsets.env"
expect_fail "read_offsets rejects non-hex offsets" read_offsets "$TMP/img"
rm -f "$TMP/img/offsets.env"
expect_fail "read_offsets rejects a missing offsets.env" read_offsets "$TMP/img"

# ---------------------------------------------------------------------------
# 4. Proof assertion: only the web worker uid passes.
# ---------------------------------------------------------------------------
if proof_is_web_uid 'uid=33(www-data) gid=33(www-data) groups=33(www-data)'; then
  ok "proof_is_web_uid accepts the Apache worker uid"
else
  bad "proof_is_web_uid rejected a valid proof"
fi
for wrong in 'uid=0(root) gid=0(root)' 'uid=1000(ubuntu)' '' 'uid=33(www-datax)'; do
  if proof_is_web_uid "$wrong"; then
    bad "proof_is_web_uid accepted a wrong uid: $wrong"
  else
    ok "proof_is_web_uid rejects '$wrong'"
  fi
done

# ---------------------------------------------------------------------------
# 5. Port selection: one simultaneous bind yields distinct, bindable ports and
#    never the vmtest defaults 2422/8201.
# ---------------------------------------------------------------------------
read -r P1 P2 P3 <<<"$(free_tcp_set 3)" || true
if [ -n "${P1:-}" ] && [ -n "${P2:-}" ] && [ -n "${P3:-}" ] &&
  [ "$P1" != "$P2" ] && [ "$P1" != "$P3" ] && [ "$P2" != "$P3" ]; then
  ok "free_tcp_set returned three distinct ports ($P1/$P2/$P3)"
else
  bad "free_tcp_set did not return three distinct ports"
fi
RESERVED_SEEN=0
for p in "${P1:-0}" "${P2:-0}" "${P3:-0}"; do
  if [ "$p" = 2422 ] || [ "$p" = 8201 ]; then RESERVED_SEEN=1; fi
done
[ "$RESERVED_SEEN" = 0 ] && ok "free_tcp_set avoids the vmtest defaults 2422/8201" ||
  bad "free_tcp_set allocated a vmtest default port"
BIND_FAIL=0
for p in "${P1:-0}" "${P2:-0}" "${P3:-0}"; do
  free_port "$p" "$p" >/dev/null 2>&1 || BIND_FAIL=1
done
[ "$BIND_FAIL" = 0 ] && ok "every allocated port is bindable when handed back" ||
  bad "an allocated port was not bindable"
EXCL=$(free_tcp_set 2 "$P1") || EXCL=
read -r E1 E2 <<<"$EXCL" || true
if [ -n "${E1:-}" ] && [ "$E1" != "$P1" ] && [ "${E2:-}" != "$P1" ]; then
  ok "free_tcp_set honours an excluded port"
else
  bad "free_tcp_set re-used an excluded port"
fi
SP1=$(free_port 24000 24100) || SP1=
SP2=$(free_port 24000 24100) || SP2=
if [ -n "$SP1" ] && [ "$SP1" = "$SP2" ]; then
  ok "free_port is deterministic while the port stays free ($SP1)"
else
  bad "free_port did not return a stable free port"
fi

# ---------------------------------------------------------------------------
# 6. Script syntax and lab configuration invariants.
# ---------------------------------------------------------------------------
for f in "$LAB_DIR"/*.sh "$LAB_DIR/lab/app-start" "$LAB_DIR/lab/app-start-oci"; do
  if bash -n "$f" 2>/dev/null; then ok "bash -n $(basename "$f")"; else bad "bash -n $(basename "$f")"; fi
done
for f in "$LAB_DIR/leaks.py" "$LAB_DIR/chain.py" "$LAB_DIR/amd64.py"; do
  if python3 - "$f" <<'PY'
import sys
compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")
PY
  then ok "python3 syntax $(basename "$f")"; else bad "python3 syntax $(basename "$f")"; fi
done

grep -q '^Listen 8080$' "$LAB_DIR/lab/httpd.conf.in" &&
  ok "lab httpd listens on the guest web port 8080" ||
  bad "lab httpd does not listen on 8080"
grep -q 'MaxRequestWorkers      1' "$LAB_DIR/lab/httpd.conf.in" &&
  ok "lab httpd has exactly one prefork worker" ||
  bad "lab httpd is not single-worker"
grep -q '^KeepAlive Off' "$LAB_DIR/lab/httpd.conf.in" &&
  ok "lab httpd disables KeepAlive (chain assumption)" ||
  bad "lab httpd does not disable KeepAlive"
grep -q '^memory_limit = 8M$' "$LAB_DIR/lab/php.ini" &&
  ok "lab php.ini uses the laboratory memory_limit=8M" ||
  bad "lab php.ini is not 8M"
grep -q '^display_errors = On$' "$LAB_DIR/lab/php.ini" &&
  ok "lab php.ini renders request-startup diagnostics" ||
  bad "lab php.ini has display_errors off"
grep -q '^memory_limit = 128M$' "$LAB_DIR/lab/php-hardened.ini" &&
  ok "hardened control raises memory_limit above the 12M OOM field" ||
  bad "hardened control does not raise memory_limit"

# The official-image guest config is the calibrated environment.
for ini in "$LAB_DIR/lab/php-oci.ini" "$LAB_DIR/lab/php-oci-hardened.ini"; do
  if grep -q '^log_errors' "$ini"; then
    bad "$(basename "$ini") sets log_errors (breaks the stage-1 Set-Cookie leak)"
  else
    ok "$(basename "$ini") leaves log_errors at Off (stage-1 leak invariant)"
  fi
  grep -q '^display_errors = On$' "$ini" &&
    ok "$(basename "$ini") renders request-startup diagnostics" ||
    bad "$(basename "$ini") has display_errors off"
done
grep -q '^memory_limit = 8M$' "$LAB_DIR/lab/php-oci.ini" &&
  ok "official guest php.ini uses the laboratory memory_limit=8M" ||
  bad "official guest php.ini is not 8M"
grep -q '^memory_limit = 128M$' "$LAB_DIR/lab/php-oci-hardened.ini" &&
  ok "official hardened guest raises memory_limit to 128M" ||
  bad "official hardened guest does not raise memory_limit"
grep -q 'printf .Listen 8080' "$LAB_DIR/build-oci.sh" &&
  ok "official guest listens on 8080 via ports.conf" ||
  bad "official guest does not configure Listen 8080"
grep -q 'MaxRequestWorkers      1' "$LAB_DIR/lab/apache-oci.conf" &&
  ok "official guest has exactly one prefork worker" ||
  bad "official guest is not single-worker"
grep -q '^KeepAlive Off' "$LAB_DIR/lab/apache-oci.conf" &&
  ok "official guest disables KeepAlive" ||
  bad "official guest does not disable KeepAlive"

# The landing page must be allocation-inert on the POST path, or stage 1's
# forged free-list slot is disturbed (measured; see RESULTS.md).
if [ "$(cat "$LAB_DIR/lab/www/index.php")" = '<?php echo "OK\n";' ]; then
  ok "index.php is the allocation-inert calibrated landing page"
else
  bad "index.php is not the calibrated <?php echo \"OK\\n\"; page"
fi
grep -q 'PHP_VERSION' "$LAB_DIR/lab/www/version.php" &&
  grep -q 'memory_limit' "$LAB_DIR/lab/www/version.php" &&
  ok "version.php reports PHP version and memory_limit" ||
  bad "version.php does not report the control-relevant configuration"

# ---------------------------------------------------------------------------
# 6b. OCI pins are complete and internally consistent.
# ---------------------------------------------------------------------------
# shellcheck disable=SC1091
. "$LAB_DIR/oci-pins.sh"
for ver in 8.4.26 8.4.27; do
  if oci_pins "$ver" 2>/dev/null; then
    ok "OCI pin set exists for PHP $ver ($OCI_TAG)"
  else
    bad "OCI pin set missing for PHP $ver"
    continue
  fi
  case "$OCI_INDEX_DIGEST$OCI_MANIFEST_DIGEST$OCI_CONFIG_DIGEST" in
    sha256:*sha256:*sha256:*) ok "OCI digests for $ver are sha256-formatted" ;;
    *) bad "OCI digest format is wrong for $ver" ;;
  esac
  [ "${#OCI_LAYER_DIGESTS[@]}" = "${#OCI_LAYER_SIZES[@]}" ] &&
    ok "OCI layer digest/size counts agree for $ver" ||
    bad "OCI layer digest/size counts differ for $ver"
  BADLAYER=0
  for d in "${OCI_LAYER_DIGESTS[@]}"; do
    printf '%s' "$d" | grep -Eq '^sha256:[0-9a-f]{64}$' || BADLAYER=1
  done
  [ "$BADLAYER" = 0 ] && ok "every OCI layer digest is 64 lowercase hex for $ver" ||
    bad "an OCI layer digest is malformed for $ver"
done
grep -q 'oci_manifest_url "$OCI_MANIFEST_DIGEST"' "$LAB_DIR/oci.sh" &&
  grep -q 'verify_sha256' "$LAB_DIR/oci.sh" &&
  ok "OCI fetch addresses the manifest by digest and verifies blobs" ||
  bad "OCI fetch is not digest-addressed/verified"

# ---------------------------------------------------------------------------
# 6c. The shipped calibration profile is internally consistent.
# ---------------------------------------------------------------------------
PROFILE=$LAB_DIR/calibration/php-8.4.26-apache-trixie.json
if [ -f "$PROFILE" ] && jq -e . "$PROFILE" >/dev/null 2>&1; then
  ok "calibration profile parses"
  [ "$(jq -r '.php_version' "$PROFILE")" = "$PHP_VULN" ] &&
    ok "calibration profile targets PHP $PHP_VULN" ||
    bad "calibration profile targets the wrong PHP version"
  if [ "$(jq -r 'if .stage3.verified == true and (.stage3.htdata // "") != "" and ((.stage3.pads // []) | length) > 0 then 1 else 0 end' "$PROFILE")" = 1 ]; then
    ok "calibration profile carries a verified stage-3 geometry"
  else
    bad "calibration profile has no complete verified stage-3 geometry"
  fi
  norm_hex() { printf '0x%x' "$((16#${1#0x}))"; }
  if [ -f "$IMAGES/php2shell-vuln/offsets.env" ]; then
    if read_offsets "$IMAGES/php2shell-vuln" &&
      [ "$(norm_hex "${ZIF_OFFSET:-0}")" = "$(norm_hex "$(jq -r '.libphp.zif_system' "$PROFILE")")" ] &&
      [ "$(norm_hex "${DTOR_OFFSET:-0}")" = "$(norm_hex "$(jq -r '.libphp.zval_ptr_dtor' "$PROFILE")")" ]; then
      ok "profile offsets match the built vulnerable image"
    else
      bad "profile offsets do not match the built vulnerable image"
    fi
  else
    ok "vulnerable image not built yet; profile/image offset comparison skipped"
  fi
else
  bad "calibration profile is missing or malformed"
fi

# ---------------------------------------------------------------------------
# 7. Toolkit/upstream provenance, when the cache is populated.
# ---------------------------------------------------------------------------
if [ -f "$UPSTREAM_LEGACY/exploit.py" ]; then
  if grep -q 'forge = bytearray(b"A" \* 79)' "$UPSTREAM_LEGACY/exploit.py" &&
    grep -q 'stage3_carrier' "$UPSTREAM_LEGACY/exploit.py" &&
    grep -q 'def stage1' "$UPSTREAM_LEGACY/exploit.py"; then
    ok "staged upstream is the 8M Apache chain generation"
  else
    bad "staged upstream does not look like the legacy 8M chain"
  fi
  if [ -f "$CACHE/pins.env" ]; then
    . "$CACHE/pins.env"
    [ "${toolkit_commit:-}" = "$TOOLKIT_PIN" ] && ok "toolkit pin recorded ($TOOLKIT_PIN)" ||
      bad "toolkit pin mismatch in pins.env"
    [ "${upstream_commit:-}" = "$UPSTREAM_PIN" ] && ok "upstream pin recorded ($UPSTREAM_PIN)" ||
      bad "upstream pin mismatch in pins.env"
  else
    ok "toolkit cache present without pins.env (fetch.sh has not run yet)"
  fi
else
  ok "toolkit cache not populated (run fetch.sh/build.sh for the chain)"
fi

printf '\nRESULT: %d passed, %d failed\n' "$((COUNT - FAIL))" "$FAIL"
[ "$FAIL" -eq 0 ]
