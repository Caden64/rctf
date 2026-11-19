#!/bin/bash
# Assemble the pinned poky (yocto-6.0.4) tree and build the sshhole-yocto
# lab rootfs tarballs with bitbake. Unprivileged: no root, no containers,
# no host package installs. Called by build.sh; can also be run directly.
#
#   yocto-build.sh [--parse-only] [--tclib musl|glibc|all] [--jobs N]
#
# Steps (all idempotent, all inputs re-hashed first):
#   1. verify the pinned yocto-6.0.4 component tarballs (bitbake, oecore,
#      meta-yocto) and the buildtools-extended installer in the lab cache,
#   2. assemble $cache/yocto/poky from those tarballs (oecore + bitbake +
#      meta-poky + meta-yocto-bsp) exactly once, with a marker recording the
#      pins it came from,
#   3. extract the pinned buildtools-extended toolchain and put it on PATH
#      (gcc 15.3, chrpath, wget, rpcgen, python3.14; the lab hostname shim is
#      prepended too),
#   4. create build-musl/ and build-glibc/ with a local.conf from the lab
#      template (TCLIBC is the only difference) and a bblayers.conf that adds
#      the lab layer, assert the stock openssh pin (10.3p1, upstream sha256,
#      no CVE-2026-123158 backport),
#   5. bitbake sshhole-yocto-image for each libc, and record the exact
#      versions used into <build>/sshhole-versions.txt.
#
# The musl build is the VULNERABLE image (CVE-2026-123158), the glibc build is
# the control: identical recipe, identical layer, only TCLIBC differs.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
LABS=$(cd -- "$HERE/../.." && pwd)
# shellcheck source=../lib/common.sh
. "$LABS/labs/lib/common.sh"

CACHE=${SSHOLE_YOCTO_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-sshole-yocto}
DL=$CACHE/dl
YDIR=$CACHE/yocto
POKY=$YDIR/poky
BTOOLS=$YDIR/buildtools
TCLIBC_SEL=all
PARSE_ONLY=0
JOBS=${SSHOLE_YOCTO_JOBS:-$(nproc)}

while [ $# -gt 0 ]; do
  case "$1" in
    --parse-only) PARSE_ONLY=1 ;;
    --tclib) TCLIBC_SEL=$2; shift ;;
    --jobs) JOBS=$2; shift ;;
    *) lab_die "yocto-build.sh: unknown argument: $1" ;;
  esac
  shift
done

die() { lab_die "$*"; }

# --- 1. re-verify the pinned inputs ------------------------------------------
BITBAKE_TARBALL=bitbake-51fd94a67fa17650a9ff623492005972bbc7d26f.tar.bz2
OECORE_TARBALL=oecore-0f03c732a0a2d0506b41b1abe60b3f368b2300dc.tar.bz2
METAYOCTO_TARBALL=meta-yocto-7c25b11156553145fa6b241a2d4f65d94438f804.tar.bz2
BTOOLS_INSTALLER=x86_64-buildtools-extended-nativesdk-standalone-6.0.4.sh

verify_sha256 "$DL/$BITBAKE_TARBALL" \
  a541a9535cca6e342151e8e7b0c11f322dab879317b32e71bd47490c28af8b7d "poky bitbake tarball (cached)"
verify_sha256 "$DL/$OECORE_TARBALL" \
  a35af9fd6d814ee2fbe21bbcb8de19cdf63fb2c5c78e8f5badf91dfc723a7748 "poky oecore tarball (cached)"
verify_sha256 "$DL/$METAYOCTO_TARBALL" \
  411c783757cd2931e407dff408248b6b15f4508e4bf7a9ceedec13c0e7874b84 "poky meta-yocto tarball (cached)"
verify_sha256 "$DL/$BTOOLS_INSTALLER" \
  93002cc067c15523c1fca4e2ee047a1dba0eed7ccfdb41652141741edb5469b2 "buildtools-extended installer (cached)"

# --- 2. assemble the poky tree (once) -----------------------------------------
ASSEMBLED=$POKY/.sshhole-yocto-assembled
if [ ! -f "$ASSEMBLED" ]; then
  lab_log "assembling $POKY from the pinned yocto-6.0.4 component tarballs"
  rm -rf "$POKY" "$YDIR/oecore"
  mkdir -p "$YDIR"
  tar xjf "$DL/$OECORE_TARBALL" -C "$YDIR" ||
    die "could not unpack the pinned oecore tarball"
  mv "$YDIR/oecore" "$POKY" || die "could not place the poky tree"
  tar xjf "$DL/$BITBAKE_TARBALL" -C "$POKY" ||
    die "could not unpack the pinned bitbake tarball"
  tar xjf "$DL/$METAYOCTO_TARBALL" -C "$POKY" ||
    die "could not unpack the pinned meta-yocto tarball"
  [ -d "$POKY/meta-yocto/meta-poky" ] && [ -d "$POKY/meta-yocto/meta-yocto-bsp" ] ||
    die "the pinned meta-yocto tarball does not contain meta-poky and meta-yocto-bsp"
  mv "$POKY/meta-yocto/meta-poky" "$POKY/"
  mv "$POKY/meta-yocto/meta-yocto-bsp" "$POKY/"
  # The meta-yocto tarball wrapper only carries top-level docs/licensing left;
  # keep them at the poky root (matching the poky monorepo layout) and drop the
  # now-empty wrapper (its README symlinks point at the moved layers, which is
  # also how the poky monorepo places them).
  for f in LICENSE .gitignore .b4-config SECURITY.md README.hardware.md \
    README.md README.poky.md; do
    if [ -e "$POKY/meta-yocto/$f" ] && [ ! -e "$POKY/$f" ]; then
      mv "$POKY/meta-yocto/$f" "$POKY/" || true
    fi
  done
  rm -rf "$POKY/meta-yocto"
  cat >"$ASSEMBLED" <<MARKER
assembled $(date -u +%Y-%m-%dT%H:%M:%SZ) from:
  $OECORE_TARBALL
  $BITBAKE_TARBALL
  $METAYOCTO_TARBALL
(yocto-6.0.4 / wrynose, publisher .sha256sum cross-checked at fetch)
MARKER
else
  lab_note "poky tree already assembled ($(cat "$ASSEMBLED" | wc -l) marker lines present)"
fi
[ -f "$POKY/oe-init-build-env" ] && [ -d "$POKY/meta" ] &&
  [ -d "$POKY/bitbake" ] && [ -d "$POKY/meta-poky" ] ||
  die "$POKY is not a complete assembled poky tree"

# --- 3. pinned buildtools toolchain + lab hostname shim ----------------------
BTOOLS_ENV=
if [ ! -d "$BTOOLS" ] || ! BTOOLS_ENV=$(find "$BTOOLS" -maxdepth 3 -name 'environment-setup-*' -type f 2>/dev/null | head -n 1) || [ -z "$BTOOLS_ENV" ]; then
  lab_log "extracting the pinned buildtools-extended toolchain into $BTOOLS"
  rm -rf "$BTOOLS"
  mkdir -p "$BTOOLS"
  bash "$DL/$BTOOLS_INSTALLER" -y -d "$BTOOLS" >/dev/null ||
    die "buildtools-extended installer failed"
  BTOOLS_ENV=$(find "$BTOOLS" -maxdepth 3 -name 'environment-setup-*' -type f | head -n 1)
fi
[ -n "$BTOOLS_ENV" ] && [ -f "$BTOOLS_ENV" ] ||
  die "no environment-setup script found in $BTOOLS"
lab_note "buildtools environment: $BTOOLS_ENV"

# The lab hostname shim (query-only stand-in, see yocto/bin/hostname) goes on
# PATH ahead of everything; the buildtools toolchain comes next.
SHIMBIN=$HERE/yocto/bin
[ -x "$SHIMBIN/hostname" ] || die "lab hostname shim missing: $SHIMBIN/hostname"

# diffstat: the one HOSTTOOLS utility this host lacks and buildtools does not
# ship. Bootstrap it from the stock recipe's own pinned source (this also
# satisfies OE's sanity ASSUME_PROVIDED heuristic honestly: the host really
# provides diffstat afterwards).
bash "$HERE/yocto/hosttools-bootstrap.sh" ||
  die "could not bootstrap the pinned host diffstat"
HOSTBIN=$YDIR/hosttools/bin
[ -x "$HOSTBIN/diffstat" ] || die "host diffstat missing after bootstrap"

# --- 4/5. per-libc build configuration + bitbake ------------------------------
LAYER=$HERE/yocto/meta-sshhole
[ -f "$LAYER/conf/layer.conf" ] || die "lab layer missing: $LAYER"
[ -f "$HERE/yocto/local.conf.template" ] || die "local.conf template missing"

# Fail closed on the stock openssh pin BEFORE any bitbake run: the
# yocto-6.0.4 stock recipe must still be the vulnerable 10.3p1 with the
# pinned upstream tarball digest and WITHOUT a CVE-2026-123158 backport.
OPENSSH_BB=$POKY/meta/recipes-connectivity/openssh/openssh_10.3p1.bb
[ -f "$OPENSSH_BB" ] ||
  die "yocto-6.0.4 does not ship openssh_10.3p1.bb anymore: re-evaluate the pin"
grep -q 'SRC_URI\[sha256sum\] = "56682a36bb92dcf4b4f016fd8ec8e74059b79a8de25c15d670d731e7d18e45f4"' "$OPENSSH_BB" ||
  die "the stock openssh 10.3p1 recipe no longer pins the upstream tarball sha256 56682a36...: re-evaluate the pin"
if grep -rq 'CVE-2026-123158' "$POKY/meta/recipes-connectivity/openssh/"; then
  die "the yocto-6.0.4 openssh recipe carries a CVE-2026-123158 backport: the stock build would be FIXED; pin a vulnerable openssh recipe instead"
fi
lab_note "stock yocto-6.0.4 openssh 10.3p1 verified vulnerable (no CVE-2026-123158 backport)"

write_conf() { # <build-dir> <tclib>
  local bdir=$1 tclib=$2
  mkdir -p "$bdir/conf"
  sed -e "s|@TCLIBC@|$tclib|g" \
    -e "s|@DL_DIR@|$YDIR/dl|g" \
    -e "s|@SSTATE_DIR@|$YDIR/sstate|g" \
    -e "s|@BB_NUMBER_THREADS@|$JOBS|g" \
    "$HERE/yocto/local.conf.template" >"$bdir/conf/local.conf"
  cat >"$bdir/conf/bblayers.conf" <<EOF
# sshhole-yocto lab (generated; yocto-6.0.4 assembled from pinned tarballs)
LCONF_VERSION = "7"
BBPATH = "\${TOPDIR}"
BBFILES ?= ""

BBLAYERS = " \\
  $POKY/meta \\
  $POKY/meta-poky \\
  $POKY/meta-yocto-bsp \\
  $LAYER \\
  "
EOF
}

run_build() { # <tclib>
  local tclib=$1
  local bdir=$YDIR/build-$tclib
  lab_log "=== build-$tclib: configuring"
  write_conf "$bdir" "$tclib"
  mkdir -p "$YDIR/dl" "$YDIR/sstate"

  # This shell sources the pinned buildtools environment (known gcc/python),
  # prepends the lab shim dir, then oe-init-build-env for the build dir.
  (
    set -e
    # The OE setup script is not `set -u` safe (BBSERVER, ZSH_NAME, OEROOT...);
    # disable nounset inside this subshell and give the well-known ones empty
    # defaults so the sourcing behaves as documented.
    set +u
    # shellcheck disable=SC1090
    . "$BTOOLS_ENV"
    PATH="$HOSTBIN:$SHIMBIN:$PATH"
    export PATH
    cd "$POKY"
    # shellcheck disable=SC1091
    . ./oe-init-build-env "$bdir" >/dev/null
    if [ "$PARSE_ONLY" = 1 ]; then
      bitbake -p
    else
      bitbake sshhole-yocto-image
      # Record the exact versions this build used (for RESULTS/manifests).
      {
        printf 'bitbake: %s\n' "$(bitbake --version)"
        for spec in openssh musl glibc busybox base-passwd shadow; do
          v=$(bitbake-getvar --value -r "$spec" PV 2>/dev/null || true)
          case "$v" in '' | '# '* | *'${@'*) continue ;; esac
          printf '%s PV=%s\n' "$spec" "$v"
        done
        v=$(bitbake-getvar --value DISTRO_VERSION 2>/dev/null || true)
        case "$v" in '' | '# '* | *'${@'*) ;; *) printf 'DISTRO_VERSION=%s\n' "$v" ;; esac
      } >"$bdir/sshhole-versions.txt" 2>/dev/null || true
    fi
  )
  lab_log "=== build-$tclib: done"
}

case "$TCLIBC_SEL" in
  musl | glibc) run_build "$TCLIBC_SEL" ;;
  all)
    run_build musl
    run_build glibc
    ;;
  *) die "--tclib must be musl, glibc or all" ;;
esac

if [ "$PARSE_ONLY" = 1 ]; then
  printf 'yocto-build: parse-only OK\n'
else
  printf 'yocto-build: rootfs tarballs under %s\n' "$YDIR"
fi
