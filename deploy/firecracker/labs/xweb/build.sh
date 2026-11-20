#!/bin/bash
# Build the two xweb lab rootfs images, unprivileged.
#
#   xweb-vuln     Alpine 3.24.4 + python3 3.14.10-r1 + the concatenated-SQL
#                 portal (the lab's bug: default creds AND injection)
#   xweb-patched  identical theme and content, parameterized queries only
#
# Every image is assembled by unpacking pinned, sha256-verified artifacts into
# a staging directory and calling ../../guest/build-rootfs.sh --dir. No
# container engine, no loop mount, no chroot, no root, and no guest binary is
# executed on the host. Build-time assertions fail the build when the staged
# tree does not contain the pinned python stack, the themed app files, the DB
# schema, and the expected vulnerable/parameterized query seam.
#
# The portal source is lab-authored (app/*.py); build.sh copies it but never
# runs it. run-time behaviour is verified by selftest.sh (host, lab source
# only) and inner.sh (inside the throwaway vmtest VM).
#
# Output: $XWEB_IMAGES/<name>/{rootfs.ext4,vmlinux,build-info.txt} plus a
#         $XWEB_IMAGES/MANIFEST.txt manifest.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=../lib/common.sh
. "$HERE/../lib/common.sh"

CACHE=${XWEB_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-xweb}
SMOKE=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
IMAGES=${XWEB_IMAGES:-$CACHE/images}
DL=$CACHE/dl
GUEST_BUILD=$(cd -- "$HERE/../../guest" && pwd)
APP=$HERE/app

die() { lab_die "$*"; }

# --- pinned input filenames (digests live in fetch-artifacts.sh) -------------
ALPINE324_MINIROOTFS=alpine-minirootfs-3.24.4-x86_64.tar.gz

# The exact Alpine package closure for the pinned python stack.
PYTHON_APKS="
  python3-3.14.10-r1
  musl-1.2.6-r3
  libssl3-3.5.9-r1
  libcrypto3-3.5.9-r1
  libexpat-2.10.0-r0
  libbz2-1.0.8-r6
  libffi-3.5.2-r1
  gdbm-1.26-r0
  xz-libs-5.8.4-r0
  mpdecimal-4.0.1-r0
  libncursesw-6.6_p20260516-r0
  libpanelw-6.6_p20260516-r0
  readline-8.3.3-r1
  sqlite-libs-3.53.4-r0
  zlib-1.4-r0
  libgcc-15.2.0-r5
  libstdc++-15.2.0-r5
  ncurses-terminfo-base-6.6_p20260516-r0
"

PYTHON_VERSION=3.14.10
PYTHON_PACKAGE=python3-3.14.10-r1
SQLITE_PACKAGE=sqlite-libs-3.53.4-r0

# Throwaway lab credentials, documented in README.md. These images only ever
# boot inside the throwaway vmtest VM.
XWEB_ADMIN_USER=admin
XWEB_ADMIN_CODE=1234

[ -x "$GUEST_BUILD/build-rootfs.sh" ] ||
  die "guest builder missing: $GUEST_BUILD/build-rootfs.sh"
command -v tar >/dev/null || die "tar is required"
command -v strings >/dev/null ||
  die "strings (binutils) is required for the stack banner assertion"

mkdir -p "$IMAGES"
# The agent's image trust check rejects group/world-writable dirs.
chmod 0755 "$IMAGES"

"$HERE/fetch-artifacts.sh"

require_file "$DL/$ALPINE324_MINIROOTFS" "Alpine 3.24.4 minirootfs"
require_file "$SMOKE/images/smoke/vmlinux" "kernel"
require_file "$SMOKE/dl/jq" "static jq"
for apk in $PYTHON_APKS; do
  require_file "$DL/$apk.apk" "Alpine apk $apk"
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/xweb-build.XXXXXX") ||
  die "could not create a staging directory"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# --- build-time assertions ----------------------------------------------------

assert_python_stack() { # <root> <image>
  local root=$1 image=$2 libpy rel hit got
  rel=usr/lib/libpython3.14.so.1.0
  [ -f "$root/$rel" ] || die "$image: missing $rel"
  # Read the version banner out of the binary bytes (strings is not
  # execution; the guest binary never runs on the host).
  hit=$(strings "$root/$rel" | grep -E "^$PYTHON_VERSION$" | head -n 1 || true)
  [ -n "$hit" ] ||
    die "$image: could not read the $PYTHON_VERSION banner from $rel"
  lab_note "$image: python banner $hit verified out of $rel bytes"
  [ -f "$root/usr/bin/python3.14" ] ||
    die "$image: python3.14 launcher is missing"
  [ -f "$root/usr/lib/libsqlite3.so.0" ] ||
    die "$image: $SQLITE_PACKAGE did not stage libsqlite3.so.0"
  local dyn=usr/lib/python3.14/lib-dynload/_sqlite3.cpython-314-x86_64-linux-musl.so
  [ -f "$root/$dyn" ] ||
    die "$image: the python sqlite3 module is missing from lib-dynload"
  # musl stack only: the dynamic loader must be musl, never glibc.
  require_file "$root/lib/ld-musl-x86_64.so.1" "$image musl loader"
  [ ! -e "$root/lib64/ld-linux-x86-64.so.2" ] ||
    die "$image: a glibc loader leaked into the musl image"
}

assert_auth_seam() { # <root> <image> <vuln|patched>
  local root=$1 image=$2 mode=$3 auth=$root/app/xweb_auth.py
  require_file "$auth" "$image query seam /app/xweb_auth.py"
  require_file "$root/app/xweb_common.py" "$image portal /app/xweb_common.py"
  assert_executable "$root/app/start" "$image /app/start"
  if [ "$mode" = vuln ]; then
    grep -q "AUTH_MODE = 'concat'" "$auth" ||
      die "$image: the query seam does not declare the concat mode"
    grep -q "XWEB-AUTH-VULN: SQL built by string concatenation" "$auth" ||
      die "$image: the concatenated-SQL code path is missing"
    grep -qF -- "'\" + username +" "$auth" ||
      die "$image: the username is not concatenated into the login SQL"
    grep -qF -- "'\" + password +" "$auth" ||
      die "$image: the password is not concatenated into the login SQL"
    grep -qF -- "LIKE '%\" + probe +" "$auth" ||
      die "$image: the archive filter is not concatenated into its SQL"
    grep -q "AUTH_MODE = 'parameterized'" "$auth" &&
      die "$image: the parameterized seam leaked into the vulnerable image"
    # The vulnerable build must report SQL faults to the page (debug realism).
    grep -q "XwebSqlError" "$auth" ||
      die "$image: the vulnerable seam does not surface SQL faults"
  else
    grep -q "AUTH_MODE = 'parameterized'" "$auth" ||
      die "$image: the query seam does not declare the parameterized mode"
    grep -q "XWEB-AUTH-PATCHED: parameterized query only" "$auth" ||
      die "$image: the parameterized code path is missing"
    grep -qE 'username = \? AND password = \?' "$auth" ||
      die "$image: the login query is not parameterized"
    grep -qE 'label LIKE \? OR detail LIKE \?' "$auth" ||
      die "$image: the archive query is not parameterized"
    grep -qF -- "'\" + username +" "$auth" &&
      die "$image: a concatenated SQL path leaked into the control image"
    grep -qF -- "'\" + password +" "$auth" &&
      die "$image: a concatenated SQL path leaked into the control image"
    grep -qF -- "LIKE '%\" + probe +" "$auth" &&
      die "$image: the archive SQL text is concatenated in the control image"
  fi
  # The portal must read the MMDS flag dir and keep the DB on tmpfs.
  grep -q "RCTF_FLAGS_DIR" "$root/app/xweb_common.py" ||
    die "$image: the portal does not read \$RCTF_FLAGS_DIR"
  grep -q "XWEB_DB', '/run/xweb/portal.db'" "$root/app/xweb_common.py" ||
    die "$image: the portal DB is not on the /run tmpfs default"
  # Themed schema + seed are part of the portal source itself.
  grep -q "CREATE TABLE IF NOT EXISTS service_notes" \
    "$root/app/xweb_common.py" ||
    die "$image: the themed service_notes schema is missing"
  grep -q "CREATE TABLE IF NOT EXISTS cold_rooms" "$root/app/xweb_common.py" ||
    die "$image: the themed cold_rooms schema is missing"
  grep -q "'admin', '1234', 'administrator'" "$root/app/xweb_common.py" ||
    die "$image: the documented default credentials are not seeded"
}

write_build_info() { # <root> <image> <mode vuln|patched>
  local root=$1 image=$2 mode=$3 authmode
  case "$mode" in
    vuln) authmode=concat ;;
    patched) authmode=parameterized ;;
    *) die "unknown seam mode: $mode" ;;
  esac
  cat >"$root/etc/xweb-build" <<EOF
IMAGE=$image
STACK=$PYTHON_PACKAGE
SQLITE=$SQLITE_PACKAGE
AUTH=$authmode
CREDENTIALS=$XWEB_ADMIN_USER/$XWEB_ADMIN_CODE (documented default)
THEME=xweb500-1
EOF
  chmod 0644 "$root/etc/xweb-build"
}

assert_build_info() { # <root> <image> <mode vuln|patched>
  local root=$1 image=$2 mode=$3 authmode
  case "$mode" in
    vuln) authmode=concat ;;
    patched) authmode=parameterized ;;
    *) die "unknown seam mode: $mode" ;;
  esac
  grep -qx "IMAGE=$image" "$root/etc/xweb-build" ||
    die "$image: build-info does not name the image"
  grep -qx "STACK=$PYTHON_PACKAGE" "$root/etc/xweb-build" ||
    die "$image: build-info does not name the pinned python package"
  grep -qx "AUTH=$authmode" "$root/etc/xweb-build" ||
    die "$image: build-info does not name the $authmode query mode"
}

build_image() { # <name> <size> <staging-root>
  local name=$1 size=$2 root=$3 out=$IMAGES/$1
  mkdir -p "$out"
  chmod 0755 "$out"
  lab_log "building $name rootfs.ext4 ($size)"
  sh "$GUEST_BUILD/build-rootfs.sh" --dir "$root" --size "$size" \
    --jq "$SMOKE/dl/jq" --out "$out/rootfs.ext4" ||
    die "$name: guest builder failed"
  cp "$SMOKE/images/smoke/vmlinux" "$out/vmlinux" ||
    die "$name: could not install vmlinux"
  chmod 0644 "$out/rootfs.ext4" "$out/vmlinux"
  local sum
  sum=$(sha256_of "$out/rootfs.ext4")
  printf 'rootfs.ext4 sha256 %s\nvmlinux sha256 %s\nsize %s\npython %s\nsqlite %s\n' \
    "$sum" "$(sha256_of "$out/vmlinux")" "$size" \
    "$PYTHON_PACKAGE" "$SQLITE_PACKAGE" >"$out/build-info.txt"
  chmod 0644 "$out/build-info.txt"
  lab_note "$name rootfs.ext4 sha256 $sum"
}

# stage_image <name> <mode vuln|patched>
stage_image() {
  local name=$1 mode=$2 root=$WORK/$1
  rm -rf "$root"
  mkdir -p "$root"
  lab_log "staging $name"
  tar -xzf "$DL/$ALPINE324_MINIROOTFS" -C "$root" ||
    die "$name: could not unpack the Alpine minirootfs"
  local apk
  for apk in $PYTHON_APKS; do
    stage_apk "$DL/$apk.apk" "$root"
  done
  assert_python_stack "$root" "$name"
  mkdir -p "$root/app" "$root/run/xweb" "$root/etc"
  cp "$APP/start" "$root/app/start"
  chmod 0755 "$root/app/start"
  cp "$APP/xweb_common.py" "$root/app/xweb_common.py"
  chmod 0644 "$root/app/xweb_common.py"
  # Exactly one query seam per image: this is the vulnerable/patched switch.
  cp "$APP/xweb_auth_$mode.py" "$root/app/xweb_auth.py"
  chmod 0644 "$root/app/xweb_auth.py"
  assert_auth_seam "$root" "$name" "$mode"
  write_build_info "$root" "$name" "$mode"
  assert_build_info "$root" "$name" "$mode"
}

write_manifest() {
  local name mode
  {
    printf 'xweb lab image manifest (built %s)\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for name in xweb-vuln xweb-patched; do
      case "$name" in
        xweb-vuln) mode=concat ;;
        xweb-patched) mode=parameterized ;;
      esac
      printf '%s\n' "## $name"
      printf '  rootfs.ext4 sha256: %s\n' \
        "$(awk '/^rootfs\.ext4 sha256/{print $3}' "$IMAGES/$name/build-info.txt")"
      printf '  vmlinux      sha256: %s (shared smoke kernel 6.1.155)\n' \
        "$(awk '/^vmlinux sha256/{print $3}' "$IMAGES/$name/build-info.txt")"
      printf '  rootfs.ext4 size: %s bytes\n' "$(stat -c %s "$IMAGES/$name/rootfs.ext4")"
      printf '  python package: %s\n' "$PYTHON_PACKAGE"
      printf '  sqlite package: %s\n' "$SQLITE_PACKAGE"
      printf '  auth mode: %s\n' "$mode"
      printf '  credentials: %s (documented throwaway default)\n' \
        "$XWEB_ADMIN_USER/$XWEB_ADMIN_CODE"
      printf '\n'
    done
    printf '%s\n' 'Pinned inputs: see fetch-artifacts.sh (Alpine 3.24.4 minirootfs,'
    printf '%s\n' 'python-closure TOFU digests, shared smoke kernel/jq, Traefik 3.7.15).'
  } >"$IMAGES/MANIFEST.txt"
  chmod 0644 "$IMAGES/MANIFEST.txt"
}

lab_log "artifacts: $CACHE"
lab_log "images:    $IMAGES"

stage_image xweb-vuln vuln
build_image xweb-vuln 256M "$WORK/xweb-vuln"

stage_image xweb-patched patched
build_image xweb-patched 256M "$WORK/xweb-patched"

write_manifest

printf '\nxweb images built in %s\n' "$IMAGES"
cat "$IMAGES/MANIFEST.txt"
