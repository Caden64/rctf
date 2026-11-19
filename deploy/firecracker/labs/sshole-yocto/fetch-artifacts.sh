#!/bin/bash
# Download and verify every input the sshole-yocto lab needs.
#
# Everything is HTTPS and pinned to an exact version + sha256:
#
#   - Yocto Project yocto-6.0.4 (wrynose LTS point release, dated
#     2026-10-20) COMPONENT RELEASE TARBALLS from downloads.yoctoproject.org:
#     bitbake, oecore (openembedded-core) and meta-yocto. Each tarball has a
#     PUBLISHER-PROVIDED .sha256sum next to it in the release directory; the
#     digest is pinned here AND cross-checked against the publisher's file
#     at fetch time, so this is NOT trust-on-first-use: a changed upstream
#     file (or a tampered .sha256sum) fails the fetch. The release notes
#     carry a detached PGP signature (RELEASENOTES.asc); the lab records but
#     does not GPG-verify it (no publisher key pinned here).
#
#     yocto-6.0.4 is the newest stable LTS point release (wrynose/6.0, LTS
#     until April 2030; point release 6.0.4, 2026-10-20). Its stock openssh
#     recipe is openssh_10.3p1 with only unrelated CVE backports
#     (CVE-2026-59995..60002), i.e. still vulnerable to CVE-2026-123158, so
#     the stock recipe is used and its exact version is recorded.
#
#   - x86_64-buildtools-extended-nativesdk-standalone-6.0.4.sh: the official
#     yocto-6.0.4 host toolchain tarball (gcc 15.3, binutils, chrpath, wget,
#     rpcsvc-proto/rpcgen, python3.14, make, git). Publisher .sha256sum
#     pinned and cross-checked. The build host's own toolchain (gcc 16.2 /
#     python 3.14.10) is NOT used for the build.
#
#   - Firecracker, the kernel, static jq and busybox: reused from the shared
#     smoke artifacts (../smoke/fetch-artifacts.sh), which apply the same
#     pinned-digest rules. Their digests are re-verified here.
#
# The upstream openssh-10.3p1.tar.gz (sha256 56682a36bb92dcf4b4f016fd8ec8e
# 74059b79a8de25c15d670d731e7d18e45f4, pinned in the yocto-6.0.4 stock
# recipe) is fetched by bitbake itself during the build and verified against
# that recipe's SRC_URI[sha256sum]; yocto-build.sh asserts the recipe's pin
# before building.
#
# Cached files are re-hashed before every use; a mismatch is fatal.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
LABS=$(cd -- "$HERE/../.." && pwd)
# shellcheck source=../lib/common.sh
. "$LABS/labs/lib/common.sh"

ART=${SSHOLE_YOCTO_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-sshole-yocto}
SMOKE=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
DL=$ART/dl
mkdir -p "$DL"

die() { lab_die "$*"; }

# --- pinned Yocto yocto-6.0.4 component release tarballs --------------------
YOCTO_RELEASE=yocto-6.0.4
YOCTO_URL=https://downloads.yoctoproject.org/releases/yocto/$YOCTO_RELEASE

# cache-name|sha256 (publisher-pinned via the release directory's
# <file>.sha256sum)
YOCTO_PINS=$(cat <<'EOF'
bitbake-51fd94a67fa17650a9ff623492005972bbc7d26f.tar.bz2|a541a9535cca6e342151e8e7b0c11f322dab879317b32e71bd47490c28af8b7d
oecore-0f03c732a0a2d0506b41b1abe60b3f368b2300dc.tar.bz2|a35af9fd6d814ee2fbe21bbcb8de19cdf63fb2c5c78e8f5badf91dfc723a7748
meta-yocto-7c25b11156553145fa6b241a2d4f65d94438f804.tar.bz2|411c783757cd2931e407dff408248b6b15f4508e4bf7a9ceedec13c0e7874b84
x86_64-buildtools-extended-nativesdk-standalone-6.0.4.sh|93002cc067c15523c1fca4e2ee047a1dba0eed7ccfdb41652141741edb5469b2
EOF
)

# --- shared smoke artifact pins (re-verified below) --------------------------
FC_VERSION=v1.17.0
FC_TARBALL_SHA256=06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558
FC_BINARY_SHA256=99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5
KERNEL_SHA256=e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2
JQ_SHA256=b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f
BUSYBOX_SHA256=6e123e7f3202a8c1e9b1f94d8941580a25135382b99e8d3e34fb858bba311348

ensure_smoke_artifacts() {
  local fc=$SMOKE/dl/fc-extract/release-$FC_VERSION-x86_64
  if [ -x "$SMOKE/firecracker" ] && [ -f "$SMOKE/images/smoke/rootfs.ext4" ] &&
    [ -x "$SMOKE/dl/rootdir/bin/busybox" ] && [ -x "$SMOKE/dl/jq" ] &&
    [ -f "$SMOKE/dl/fc.tgz" ] && [ -x "$fc/jailer-$FC_VERSION-x86_64" ]; then
    return 0
  fi
  lab_log "shared Firecracker artifacts missing; fetching (the fetcher serialises on its own cache lock)"
  mkdir -p "$SMOKE"
  command -v flock >/dev/null ||
    die "flock is required by the shared smoke fetcher"
  # The fetcher takes its own exclusive lock on the cache (see
  # smoke/fetch-artifacts.sh); wrapping it here would deadlock.
  "$LABS/smoke/fetch-artifacts.sh" || die "could not obtain the shared smoke artifacts"
}

arch=$(uname -m)
[ "$arch" = x86_64 ] || die "this lab fetch script supports x86_64 artifacts only"

lab_log "cache: $ART"
mkdir -p "$DL"

# Yocto component release tarballs + buildtools: pinned digest AND the
# publisher's own .sha256sum cross-check. Both must agree; either mismatch is
# fatal. (The release also publishes a GPG-signed RELEASENOTES; it is fetched
# below for provenance, not verified - no key is pinned - and its digest is
# not part of the build inputs.)
while IFS='|' read -r name sha; do
  [ -n "$name" ] || continue
  # The buildtools installer lives in (and publishes its .sha256sum under)
  # the release's buildtools/ subdirectory; the layer tarballs are at the
  # release root.
  case "$name" in
    x86_64-buildtools*) subdir=buildtools ;;
    *) subdir=. ;;
  esac
  fetch_verified "$YOCTO_URL/$name" "$DL/$name" "$sha" "yocto-6.0.4 $name"
  # Cross-check against the publisher's published digest for the same file.
  if sums=$(curl -fsSL --retry 2 --connect-timeout 20 "$YOCTO_URL/$subdir/$name.sha256sum" 2>/dev/null); then
    published=$(printf '%s\n' "$sums" | awk '{print $1; exit}')
    [ -n "$published" ] ||
      die "publisher .sha256sum for $name has no digest"
    [ "$published" = "$sha" ] ||
      die "$name: pinned sha256 $sha does not match the publisher's published $published"
    lab_note "$name matches the publisher's published .sha256sum"
  else
    lab_note "WARNING: could not fetch $YOCTO_URL/$name.sha256sum; the pinned sha256 is still enforced"
  fi
done <<<"$YOCTO_PINS"

# Best-effort provenance: the yocto-6.0.4 release notes and their detached
# PGP signature. Neither is a build input and neither digest is pinned; they
# are kept in the cache to document exactly which release was built.
curl -fsSL --retry 2 --connect-timeout 20 -o "$DL/RELEASENOTES" \
  "$YOCTO_URL/RELEASENOTES" 2>/dev/null ||
  lab_note "WARNING: could not fetch RELEASENOTES (provenance only)"
curl -fsSL --retry 2 --connect-timeout 20 -o "$DL/RELEASENOTES.asc" \
  "$YOCTO_URL/RELEASENOTES.asc" 2>/dev/null ||
  lab_note "WARNING: could not fetch RELEASENOTES.asc (provenance only)"

# Shared smoke inputs.
ensure_smoke_artifacts
verify_sha256 "$SMOKE/images/smoke/vmlinux" "$KERNEL_SHA256" "kernel vmlinux"
verify_sha256 "$SMOKE/dl/jq" "$JQ_SHA256" "static jq"
verify_sha256 "$SMOKE/firecracker" "$FC_BINARY_SHA256" "firecracker binary"
verify_sha256 "$SMOKE/dl/rootdir/bin/busybox" "$BUSYBOX_SHA256" "busybox"
verify_sha256 "$SMOKE/dl/fc.tgz" "$FC_TARBALL_SHA256" "firecracker tarball"
[ -x "$SMOKE/dl/fc-extract/release-$FC_VERSION-x86_64/jailer-$FC_VERSION-x86_64" ] ||
  die "jailer binary is missing from the verified Firecracker tarball"

lab_log "artifacts ready in $ART"
