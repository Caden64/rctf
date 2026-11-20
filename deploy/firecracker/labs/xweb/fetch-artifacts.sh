#!/bin/bash
# Download and verify every input the xweb lab images need.
#
# Everything is HTTPS and pinned to an exact version + sha256:
#   - Alpine minirootfs 3.24.4: digest pinned AND cross-checked against the
#     publisher's .sha256 file when it is reachable.
#   - Alpine .apk packages (the python3 closure): Alpine publishes per-file
#     checksums only for release images, not for repository packages, so those
#     digests were computed from the fetched bytes and are pinned here as
#     TRUST-ON-FIRST-USE. The exact versions were taken from the v3.24 APKINDEX
#     at pin time. A changed digest is fatal; re-pin deliberately.
#   - Traefik v3.7.15 (used ONLY inside the throwaway vmtest VM to publish the
#     real http exposes): tarball digest is the publisher's checksums-file
#     line, cross-checked at pin time against the GitHub release-asset digest
#     (same basis as the edge harness pin, re-verified here from the fetched
#     bytes); the binary digest was computed from the verified tarball.
#   - Firecracker, kernel, static jq and busybox: reused from the shared smoke
#     artifacts, which apply the same pinned-digest rules
#     (../smoke/fetch-artifacts.sh). Their digests are re-verified here.
#
# Cached files are re-hashed before every use; a mismatch is fatal.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
LABS=$(cd -- "$HERE/../.." && pwd)
# shellcheck source=../lib/common.sh
. "$LABS/labs/lib/common.sh"

ART=${XWEB_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-xweb}
SMOKE=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
DL=$ART/dl
mkdir -p "$DL"

die() { lab_die "$*"; }

# --- Alpine release image -----------------------------------------------------
ALPINE324_MINIROOTFS=alpine-minirootfs-3.24.4-x86_64.tar.gz
ALPINE324_MINIROOTFS_SHA256=cdaa38cb8de3537967ee5b6c9b6cd00cc962da2b018e6eea48696bb274923012
ALPINE324_URL=https://dl-cdn.alpinelinux.org/alpine/v3.24
ALPINE324_MINIROOTFS_SHA256_URL=$ALPINE324_URL/releases/x86_64/$ALPINE324_MINIROOTFS.sha256

# --- Alpine .apk closure for python3 3.14.10-r1 -------------------------------
# cache-name|sha256 (TOFU: computed from the fetched bytes at pin time)
# The closure was resolved from the v3.24 main APKINDEX: python3 + every
# dependency it names (soname providers included). Versions are exact.
ALPINE_APKS=$(cat <<'EOF'
python3-3.14.10-r1|32ae9c446a79f965f942ae704c5121fa4744c5fee76ec86955fe0fc9a6e6c412
musl-1.2.6-r3|e142255d0fa397f14318996bc10378093dcc069dc3dd1b6818c8f28a789c21da
libssl3-3.5.9-r1|18c5778cbe52e1991303f8531970b05d4e6e036ea08349322f7422f42a689dc7
libcrypto3-3.5.9-r1|042026082cc9bc7872d1baa81755c50efa70b05f03b5369fdc5f0a1303009720
libexpat-2.10.0-r0|e7e7408ea787ed06d00159b0ff1f9b65a63cf634f36d9e0fa7512ce2c489a503
libbz2-1.0.8-r6|2737e2b23ed08d4911ee62cd0163b5f4bf0379cacf4dc35b23a00209584c98fd
libffi-3.5.2-r1|6da1a19313a40c56cac756fb11e2c4d5267831e1c22fc8323f24c943c94da6e0
gdbm-1.26-r0|3278ccba30b241168ca4ab93c919be805411b918fdc062f06d3684d12dc33ae3
xz-libs-5.8.4-r0|ab362dd515ead04c31a6c302163248da7aa4813e283c971e6dd3f789b453a1d9
mpdecimal-4.0.1-r0|1278f374bbc8b4aad674244458cca5fc63e0780a921138eef400d5db64381a31
libncursesw-6.6_p20260516-r0|cf8caa8a88bc4ce9d9e395567fefaf9ef7fbd55c50ae6155b35c1b58f3755023
libpanelw-6.6_p20260516-r0|057be8b1b788580f4cb72c382a6dcc03467d15bd69700f32192bd709e7a57a12
readline-8.3.3-r1|766911ecb986a6c5cf0841a6b556cd1e9dbbf22b3559726de32416486cd15c81
sqlite-libs-3.53.4-r0|a8a216e53d22faa3f04d2e3650c1991af66f8d0b42fadff5afcdb9afb60b19e5
zlib-1.4-r0|7b05bc778b8b25cd880835b40114182bd4d1581717504d0129c810c0a14291cb
libgcc-15.2.0-r5|393dcd32629f06d7d85409c272d142d0c082772d10b87ef55ee82f47de3be637
libstdc++-15.2.0-r5|14c987b556f5385a5db18376e788c75f37d85321b8dc1920d926ea7daac1d6f6
ncurses-terminfo-base-6.6_p20260516-r0|ce83be6d0bd10584a53c3a5868cc1595ce5f0f8e0b621f8f7f70b6144e521fc9
EOF
)

# --- Traefik (published-endpoint harness inside the throwaway VM) -------------
TRAEFIK_VERSION=3.7.15
TRAEFIK_TARBALL=traefik_v${TRAEFIK_VERSION}_linux_amd64.tar.gz
TRAEFIK_TARBALL_URL=https://github.com/traefik/traefik/releases/download/v${TRAEFIK_VERSION}/$TRAEFIK_TARBALL
TRAEFIK_TARBALL_SHA256=5b9f51199fcb7a3b5f7ae0f9dae8dcf01efadafd92c5fca96ea2822eca81f8e6
TRAEFIK_BINARY_SHA256=34bfdfa88e321ad496d829910c6145a0743eae09cdf290e3e114b137eb948e30

# --- shared smoke artifacts (Firecracker, kernel, static jq, busybox) ---------
FC_VERSION=v1.17.0
FC_TARBALL_SHA256=06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558
FC_TARBALL_SHA256_URL=https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION/firecracker-$FC_VERSION-x86_64.tgz.sha256.txt
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

# Alpine release image. The pinned digest is authoritative; the publisher's
# .sha256 file is fetched when it is reachable and any disagreement is fatal.
fetch_verified \
  "$ALPINE324_URL/releases/x86_64/$ALPINE324_MINIROOTFS" \
  "$DL/$ALPINE324_MINIROOTFS" "$ALPINE324_MINIROOTFS_SHA256" \
  "Alpine 3.24.4 minirootfs"
if published=$(curl -fsSL --retry 2 --connect-timeout 20 \
  "$ALPINE324_MINIROOTFS_SHA256_URL" 2>/dev/null); then
  published=$(printf '%s\n' "$published" | awk '{print $1}' | head -n 1)
  [ -n "$published" ] ||
    die "published Alpine .sha256 file is empty"
  [ "$published" = "$ALPINE324_MINIROOTFS_SHA256" ] ||
    die "Alpine minirootfs digest $ALPINE324_MINIROOTFS_SHA256 does not match published $published"
  lab_note "Alpine minirootfs digest matches the publisher's .sha256 file"
else
  lab_note "WARNING: could not fetch $ALPINE324_MINIROOTFS_SHA256_URL; pinned sha256 still enforced"
fi

# Alpine package closure (trust-on-first-use digests, see header).
while IFS='|' read -r name sha; do
  [ -n "$name" ] || continue
  fetch_verified "$ALPINE324_URL/main/x86_64/$name.apk" "$DL/$name.apk" \
    "$sha" "Alpine apk $name"
done <<<"$ALPINE_APKS"

# Traefik (runs only inside the throwaway vmtest VM as the publishing proxy).
if [ ! -x "$DL/traefik-v$TRAEFIK_VERSION" ]; then
  fetch_verified "$TRAEFIK_TARBALL_URL" "$DL/$TRAEFIK_TARBALL" \
    "$TRAEFIK_TARBALL_SHA256" "traefik $TRAEFIK_VERSION tarball"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/xweb-traefik.XXXXXX") ||
    die "could not create a staging directory"
  tar xzf "$DL/$TRAEFIK_TARBALL" -C "$tmp" traefik ||
    { rm -rf "$tmp"; die "could not unpack the Traefik tarball"; }
  verify_sha256 "$tmp/traefik" "$TRAEFIK_BINARY_SHA256" "traefik binary"
  install -m 0755 "$tmp/traefik" "$DL/traefik-v$TRAEFIK_VERSION"
  rm -rf "$tmp"
fi
verify_sha256 "$DL/traefik-v$TRAEFIK_VERSION" "$TRAEFIK_BINARY_SHA256" \
  "traefik binary (cached)"

# Shared smoke inputs.
ensure_smoke_artifacts
verify_sha256 "$SMOKE/images/smoke/vmlinux" "$KERNEL_SHA256" "kernel vmlinux"
verify_sha256 "$SMOKE/dl/jq" "$JQ_SHA256" "static jq"
verify_sha256 "$SMOKE/firecracker" "$FC_BINARY_SHA256" "firecracker binary"
verify_sha256 "$SMOKE/dl/rootdir/bin/busybox" "$BUSYBOX_SHA256" "busybox"
# The jailer is a separate binary in the same release tarball; the pinned
# tarball digest (verified by the smoke fetcher and re-checked below when the
# tarball is cached) is authoritative for it. When the publisher's release
# .sha256.txt is reachable, it must agree with the pin as well.
verify_sha256 "$SMOKE/dl/fc.tgz" "$FC_TARBALL_SHA256" "firecracker tarball"
if published=$(curl -fsSL --retry 2 --connect-timeout 20 \
  "$FC_TARBALL_SHA256_URL" 2>/dev/null); then
  published=$(printf '%s\n' "$published" | awk '{print $1}' | head -n 1)
  [ -n "$published" ] ||
    die "published Firecracker .sha256.txt is empty"
  [ "$published" = "$FC_TARBALL_SHA256" ] ||
    die "firecracker tarball pin $FC_TARBALL_SHA256 disagrees with the published $published"
  lab_note "firecracker tarball pin matches the publisher's .sha256.txt"
else
  lab_note "WARNING: could not fetch $FC_TARBALL_SHA256_URL; pinned sha256 still enforced"
fi
[ -x "$SMOKE/dl/fc-extract/release-$FC_VERSION-x86_64/jailer-$FC_VERSION-x86_64" ] ||
  die "jailer binary is missing from the verified Firecracker tarball"

lab_log "artifacts ready in $ART"
