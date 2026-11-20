#!/bin/bash
# Build the ONE host utility the lab build host lacks and buildtools does not
# ship: diffstat (bitbake's HOSTTOOLS and sanity check both require it, and
# OE's sanity checker rejects ASSUME_PROVIDED:remove workarounds).
#
# The source is the exact tarball the stock yocto-6.0.4 diffstat recipe pins
# (meta/recipes-devtools/diffstat/diffstat_1.68.bb, SRC_URI
# http://invisible-mirror.net/archives/diffstat/diffstat-1.68.tgz, sha256
# 89f9294a8ac74fcef6f1b9ac408f43ebedf8d208e3efe0b99b4acc16dc6582c7), fetched
# HTTPS from the same publisher mirror and verified against that sha256
# before use, then compiled unprivileged with the pinned buildtools gcc.
# Nothing privileged, nothing unpinned, nothing runs as root.
#
# Result: $YDIR/hosttools/bin/diffstat, put on PATH ahead of bitbake by
# yocto-build.sh.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
LABS=$(cd -- "$HERE/../.." && pwd)
# shellcheck source=../../lib/common.sh
. "$LABS/lib/common.sh"

CACHE=${SSHOLE_YOCTO_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-sshole-yocto}
DL=$CACHE/dl
YDIR=$CACHE/yocto
OUT=$YDIR/hosttools/bin

DIFFSTAT_TARBALL=diffstat-1.68.tgz
DIFFSTAT_SHA256=89f9294a8ac74fcef6f1b9ac408f43ebedf8d208e3efe0b99b4acc16dc6582c7
# Same publisher archive; https is available on the mirror and used here.
DIFFSTAT_URL=https://invisible-mirror.net/archives/diffstat/$DIFFSTAT_TARBALL

mkdir -p "$DL" "$OUT"

if [ -x "$OUT/diffstat" ]; then
  lab_note "host diffstat already present: $OUT/diffstat"
  exit 0
fi

# Fail closed on a pin change in the stock recipe: if yocto's diffstat recipe
# pins a different version/digest, this bootstrap must be re-evaluated.
OPENSSH_TREE=${SSHOLE_YOCTO_POKY:-$YDIR/poky}
RECIPE=$OPENSSH_TREE/meta/recipes-devtools/diffstat/diffstat_1.68.bb
if [ -f "$RECIPE" ]; then
  grep -q "SRC_URI\[sha256sum\] = \"$DIFFSTAT_SHA256\"" "$RECIPE" ||
    lab_die "the pinned yocto-6.0.4 diffstat recipe changed its digest; re-pin this bootstrap"
else
  lab_note "WARNING: diffstat recipe not found at $RECIPE; using this script's pin"
fi

fetch_verified "$DIFFSTAT_URL" "$DL/$DIFFSTAT_TARBALL" "$DIFFSTAT_SHA256" \
  "diffstat 1.68 (the stock yocto-6.0.4 recipe's pin)"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/sshhole-diffstat.XXXXXX") ||
  lab_die "could not create a work directory"
trap 'rm -rf "$WORK"' EXIT INT TERM
tar xzf "$DL/$DIFFSTAT_TARBALL" -C "$WORK" ||
  lab_die "could not unpack $DIFFSTAT_TARBALL"

BTOOLS_ENV=$(find "$YDIR/buildtools" -maxdepth 3 -name 'environment-setup-*' -type f 2>/dev/null | head -n 1)
[ -n "$BTOOLS_ENV" ] && [ -f "$BTOOLS_ENV" ] ||
  lab_die "buildtools environment missing; run yocto-build.sh first"

(
  # The buildtools environment is not `set -u` clean either.
  set +u
  # shellcheck disable=SC1090
  . "$BTOOLS_ENV"
  cd "$WORK/diffstat-1.68"
  ./configure --prefix="$WORK/prefix" >/dev/null
  make -j"$(nproc)" >/dev/null
  make install >/dev/null
)

[ -x "$WORK/prefix/bin/diffstat" ] ||
  lab_die "diffstat build did not produce a binary"
install -m 0755 "$WORK/prefix/bin/diffstat" "$OUT/diffstat"
lab_note "built $OUT/diffstat from the pinned diffstat-1.68 source"
"$OUT/diffstat" -V 2>&1 | head -n 1 || true
