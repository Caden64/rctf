#!/bin/bash
# Download and verify every input the sshole lab images need.
#
# Everything is HTTPS and pinned to an exact version + sha256:
#   - Alpine minirootfs tarballs and .apk packages: file digests pinned below.
#     Alpine publishes per-file .sha256 only for release images, not for
#     individual repository packages, so those .apk digests were computed from
#     the fetched bytes (trust-on-first-use) and are pinned here. The vulnerable
#     openssh-server 10.3_p1-r1 has been superseded by 10.3_p1-r2 on the Alpine
#     CDN; the exact file is still served and its digest is pinned.
#   - Ubuntu base tarball: digest pinned and cross-checked against the
#     publisher's SHA256SUMS when it is reachable.
#   - Ubuntu .deb files: digests taken from the signed noble-updates Packages
#     index (the SHA256 field is the .deb digest) and pinned here.
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

ART=${SSHOLE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-sshole}
SMOKE=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
DL=$ART/dl
mkdir -p "$DL"

die() { lab_die "$*"; }

# --- Alpine release images --------------------------------------------------
ALPINE324_MINIROOTFS=alpine-minirootfs-3.24.4-x86_64.tar.gz
ALPINE324_MINIROOTFS_SHA256=cdaa38cb8de3537967ee5b6c9b6cd00cc962da2b018e6eea48696bb274923012
ALPINE324_URL=https://dl-cdn.alpinelinux.org/alpine/v3.24

ALPINE_EDGE_MINIROOTFS=alpine-minirootfs-20260805-x86_64.tar.gz
ALPINE_EDGE_MINIROOTFS_SHA256=5acac12c425a0817c1b6a79bdd5df4c73756fc8dc268eab32f8ba830872b835d
ALPINE_EDGE_URL=https://dl-cdn.alpinelinux.org/alpine/edge

# --- Alpine .apk closure ----------------------------------------------------
# cache-name|sha256|branch|url-filename
# The `*-edge` cache names are aliases for edge-branch files that happen to
# share a version with v3.24 but not their bytes (Alpine rebuilds v3.24 packages
# in place; edge still serves the earlier build). Keeping them separate means a
# future divergence can never silently reuse the wrong bits.
ALPINE_APKS=$(cat <<'EOF'
openssh-server-10.3_p1-r1|2818d1c4ba1cc279e226632aceea3ada2c7652977fce364f75c0d2ad058ea57f|v3.24|openssh-server-10.3_p1-r1
openssh-keygen-10.3_p1-r1|a7a197dd781fd25d127fe7815db3d69130f0772655f421b4a88c7e4f7bb2ecf7|v3.24|openssh-keygen-10.3_p1-r1
openssh-server-common-10.3_p1-r1|d91b68c19d02f61587eb3e6b6b5a30c9658f22b655e412adbd25eddd503229bd|v3.24|openssh-server-common-10.3_p1-r1
openssh-client-common-10.3_p1-r1|b56b7fca470d627ff80bdff9267533abb13ccab1246c932032b190bd7dffa4d9|v3.24|openssh-client-common-10.3_p1-r1
openssh-server-pam-10.3_p1-r1|dc3654a6aec2e82d418102fc7ad536752019917c4044a1da253644c01d49523d|v3.24|openssh-server-pam-10.3_p1-r1
linux-pam-1.7.1-r2|73c327468bfd849bf078fb3d59516f1adc54685682dec6386d8d9d75c00e939d|v3.24|linux-pam-1.7.1-r2
utmps-libs-0.1.3.3-r0|497f0f1cb51f0e6c1acc338fded0dc7722b1d43ea17bdb749f0d556794f8b2d8|v3.24|utmps-libs-0.1.3.3-r0
skalibs-libs-2.15.0.0-r0|3301f6ccbeaea49cdd966c7e636898a8612fb8fe964a15f24f6d204b3944c3f3|v3.24|skalibs-libs-2.15.0.0-r0
libcrypto3-3.5.9-r0|6632d758d8f5e9ea3b650fe966f23bbf9a202f8b8dceecac93da135dec5e3689|v3.24|libcrypto3-3.5.9-r0
zlib-1.4-r0|7b05bc778b8b25cd880835b40114182bd4d1581717504d0129c810c0a14291cb|v3.24|zlib-1.4-r0
musl-1.2.6-r3|e142255d0fa397f14318996bc10378093dcc069dc3dd1b6818c8f28a789c21da|v3.24|musl-1.2.6-r3
libedit-20260508.3.1-r1|dfb62b3fb06346a525ffea788c6a48a0581d61a89014f57885b84b1df5a365c0|v3.24|libedit-20260508.3.1-r1
libncursesw-6.6_p20260516-r0|cf8caa8a88bc4ce9d9e395567fefaf9ef7fbd55c50ae6155b35c1b58f3755023|v3.24|libncursesw-6.6_p20260516-r0
ncurses-terminfo-base-6.6_p20260516-r0|ce83be6d0bd10584a53c3a5868cc1595ce5f0f8e0b621f8f7f70b6144e521fc9|v3.24|ncurses-terminfo-base-6.6_p20260516-r0
openssh-server-10.6_p2-r0|2681a323c6a2b959d90d878b796176de801954f2c97cac1a7d1c77d93f36972e|edge|openssh-server-10.6_p2-r0
openssh-keygen-10.6_p2-r0|d77d31c07f031b604a2f5eb608f9dd4b9570b10ed0c3f5850b2e2f0176876edf|edge|openssh-keygen-10.6_p2-r0
openssh-server-common-10.6_p2-r0|31da052c86d81224d1dcaa87548aa06acef2ec737ef34347eb485879bd46d83e|edge|openssh-server-common-10.6_p2-r0
openssh-client-common-10.6_p2-r0|82d66f008e5317c0bfdeb9ea53444e479cd07e7a84b9dac3c681dda95b8bfe92|edge|openssh-client-common-10.6_p2-r0
libcrypto3-edge|3f49f0ca1256cda3b5c336dc8387b9b9b0134fab48602ee6adec70cacfe3be74|edge|libcrypto3-3.5.9-r0
zlib-edge|c81f2e580754a6bebb9b3a17034082d35cfa275723d5a27c47e8bfdfab18aca7|edge|zlib-1.4-r0
libedit-20260512.3.1-r0|cd33045f0cfe152db2a32ca01e3ebba5416110586b5da48feb743b58558cc417|edge|libedit-20260512.3.1-r0
libncursesw-6.6_p20261017-r0|953fc025d8c86b3e03d75214ab8bc8349b2070ab7de3ad638081e36a29fb44b2|edge|libncursesw-6.6_p20261017-r0
ncurses-terminfo-base-6.6_p20261017-r0|41f697fef61c95b807829a35ba34283fa304da3aac3d70de43e6632d5969102c|edge|ncurses-terminfo-base-6.6_p20261017-r0
musl-1.2.6-r6|002f8b956419d67e91fd4e594f7b8d62fef13042cec45d977305df1a9ce0704f|edge|musl-1.2.6-r6
EOF
)

# --- Ubuntu base + .deb closure --------------------------------------------
UBUNTU_BASE=ubuntu-base-24.04.5-base-amd64.tar.gz
UBUNTU_BASE_SHA256=e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86
UBUNTU_BASE_URL=https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release
UBUNTU_SHA256SUMS_URL=$UBUNTU_BASE_URL/SHA256SUMS

# filename|sha256|pool path (under http://archive.ubuntu.com/ubuntu/)
UBUNTU_DEBS=$(cat <<'EOF'
openssh-server_9.6p1-3ubuntu13.20_amd64.deb|5d0d5eb672ddc27601e2da4e8465c5736dc73375a21bc1cd1834fcb08fb155bf|pool/main/o/openssh/openssh-server_9.6p1-3ubuntu13.20_amd64.deb
openssh-client_9.6p1-3ubuntu13.20_amd64.deb|5fb4429e9eff60a5b4ddb68ccf0c46ee67066b445794ede5fe181e64c4a8b795|pool/main/o/openssh/openssh-client_9.6p1-3ubuntu13.20_amd64.deb
libpam0g_1.5.3-5ubuntu5.7_amd64.deb|1d7f54e77f0455ab5e607cd5e78b576801d8efdc66115e02cf3c6e708d093667|pool/main/p/pam/libpam0g_1.5.3-5ubuntu5.7_amd64.deb
libaudit1_3.1.2-2.1ubuntu0.1_amd64.deb|326a55fce45a620f12b98baf581fb037eb0fcea1ab3969c54cf177f51be8abfe|pool/main/a/audit/libaudit1_3.1.2-2.1ubuntu0.1_amd64.deb
libaudit-common_3.1.2-2.1ubuntu0.1_all.deb|b1b6fca3f7ed86db971c073352a6741f1f60f4a94eeb2c1eb0aca8a7e4b11660|pool/main/a/audit/libaudit-common_3.1.2-2.1ubuntu0.1_all.deb
libcap-ng0_0.8.4-2build2_amd64.deb|cf1e9437ac7ddf6539dbe87b68858cbdef84d78c6aac243ab3b6e564a52ed930|pool/main/libc/libcap-ng/libcap-ng0_0.8.4-2build2_amd64.deb
libselinux1_3.5-2ubuntu2.1_amd64.deb|6abaa6c26f46ef17764c4a753e0e84de1cdadde5634fd2987621fdc617988d19|pool/main/libs/libselinux/libselinux1_3.5-2ubuntu2.1_amd64.deb
libpcre2-8-0_10.42-4ubuntu2.2_amd64.deb|f41da7cb7e979d6b037ea92650c72ec8ec532ec3c93aa8d5b997207de56695ea|pool/main/p/pcre2/libpcre2-8-0_10.42-4ubuntu2.2_amd64.deb
libcrypt1_4.4.36-4build1_amd64.deb|9474785cd6f398512bf8c305c3901dbb111569dccb6f5832002373c0a8ac5832|pool/main/libx/libxcrypt/libcrypt1_4.4.36-4build1_amd64.deb
libssl3t64_3.0.13-0ubuntu3.16_amd64.deb|219f43b1cd836a4da550938db5fda93160d269d39a4edcf1f1ce698a470db797|pool/main/o/openssl/libssl3t64_3.0.13-0ubuntu3.16_amd64.deb
zlib1g_1.3.dfsg-3.1ubuntu2.3_amd64.deb|376249c8de139568221dbb242318cc8cb8f02299e3a62b7432948e1754fbddf9|pool/main/z/zlib/zlib1g_1.3.dfsg-3.1ubuntu2.3_amd64.deb
libwrap0_7.6.q-33_amd64.deb|36118b862539868408ee056411d6e470068d14c46e5296b29bfb744770f5d2ce|pool/main/t/tcp-wrappers/libwrap0_7.6.q-33_amd64.deb
libcom-err2_1.47.0-2.4~exp1ubuntu4.1_amd64.deb|7ab24d3057dabf86db8f771ad6e43f073ed86b6b950d6e8ba22cb9fe6707bbc9|pool/main/e/e2fsprogs/libcom-err2_1.47.0-2.4~exp1ubuntu4.1_amd64.deb
libgssapi-krb5-2_1.20.1-6ubuntu2.10_amd64.deb|0d4a0187bcdbbe3e6a10bfa574100087d12052d0d0ef28614fd6210021c587b2|pool/main/k/krb5/libgssapi-krb5-2_1.20.1-6ubuntu2.10_amd64.deb
libkrb5-3_1.20.1-6ubuntu2.10_amd64.deb|60b48c5a3233f1d8caba30d6573edc8e131911ab6d63adcd664f7cbe62708362|pool/main/k/krb5/libkrb5-3_1.20.1-6ubuntu2.10_amd64.deb
libk5crypto3_1.20.1-6ubuntu2.10_amd64.deb|273f7cc95a68d927d7f71c3e78b7717a16a8d86e646a206bae7bf797150ae9db|pool/main/k/krb5/libk5crypto3_1.20.1-6ubuntu2.10_amd64.deb
libkrb5support0_1.20.1-6ubuntu2.10_amd64.deb|9224ede3246a82a845ea97652ecfae57f88e8d8f520d8a186f9157167574fb34|pool/main/k/krb5/libkrb5support0_1.20.1-6ubuntu2.10_amd64.deb
libkeyutils1_1.6.3-3build1_amd64.deb|0679f198b0128179e46cdf956fb2022c23c758664c00bc8efa0382d509683a8a|pool/main/k/keyutils/libkeyutils1_1.6.3-3build1_amd64.deb
libc6_2.39-0ubuntu8.9_amd64.deb|ff5557d99b51f761c4b7c92368b9cc45565eda17df9bf9eb4b134d09825008be|pool/main/g/glibc/libc6_2.39-0ubuntu8.9_amd64.deb
libgcc-s1_14.2.0-4ubuntu2~24.04.1_amd64.deb|aa7fadbe33b78bcf99885318040601c550c208929565b179891d9a3cc2aa68cd|pool/main/g/gcc-14/libgcc-s1_14.2.0-4ubuntu2~24.04.1_amd64.deb
gcc-14-base_14.2.0-4ubuntu2~24.04.1_amd64.deb|b95c172411a7fdae70307cf33a9f5320ba5e056b556454543dd5b679d5ce1c4f|pool/main/g/gcc-14/gcc-14-base_14.2.0-4ubuntu2~24.04.1_amd64.deb
EOF
)

# --- shared smoke artifacts (Firecracker, kernel, static jq, busybox) -------
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

# Alpine release images.
fetch_verified \
  "$ALPINE324_URL/releases/x86_64/$ALPINE324_MINIROOTFS" \
  "$DL/$ALPINE324_MINIROOTFS" "$ALPINE324_MINIROOTFS_SHA256" \
  "Alpine 3.24.4 minirootfs"
fetch_verified \
  "$ALPINE_EDGE_URL/releases/x86_64/$ALPINE_EDGE_MINIROOTFS" \
  "$DL/$ALPINE_EDGE_MINIROOTFS" "$ALPINE_EDGE_MINIROOTFS_SHA256" \
  "Alpine edge 20260805 minirootfs"

# Alpine package closure. `libcrypto3-edge` and `zlib-edge` are aliases for the
# same bits as the v3.24 files (identical digest), kept separate so a future
# branch difference cannot silently collide in the cache.
while IFS='|' read -r name sha branch url_name; do
  [ -n "$name" ] || continue
  case "$branch" in
    v3.24)
      base=$ALPINE324_URL
      url=$base/main/x86_64/$url_name.apk
      file=$DL/$name.apk
      ;;
    edge)
      base=$ALPINE_EDGE_URL
      url=$base/main/x86_64/$url_name.apk
      file=$DL/$name.apk
      ;;
    *) die "unknown Alpine branch in manifest: $branch" ;;
  esac
  fetch_verified "$url" "$file" "$sha" "Alpine apk $name"
done <<<"$ALPINE_APKS"

# Ubuntu base image. The pinned digest is authoritative; the publisher's
# SHA256SUMS is fetched when it is reachable and any disagreement is fatal.
fetch_verified "$UBUNTU_BASE_URL/$UBUNTU_BASE" "$DL/$UBUNTU_BASE" \
  "$UBUNTU_BASE_SHA256" "Ubuntu 24.04 base rootfs"
if sums=$(curl -fsSL --retry 2 --connect-timeout 20 "$UBUNTU_SHA256SUMS_URL" 2>/dev/null); then
  published=$(printf '%s\n' "$sums" |
    awk -v f="$UBUNTU_BASE" '$2 == f || $2 == "*" f { print $1; exit }')
  [ -n "$published" ] ||
    die "published Ubuntu SHA256SUMS has no entry for $UBUNTU_BASE"
  [ "$published" = "$UBUNTU_BASE_SHA256" ] ||
    die "Ubuntu base digest $UBUNTU_BASE_SHA256 does not match published $published"
  lab_note "Ubuntu base digest matches the published SHA256SUMS"
else
  lab_note "WARNING: could not fetch $UBUNTU_SHA256SUMS_URL; pinned sha256 still enforced"
fi

# Ubuntu .deb closure (extracted with ar/tar, never with dpkg).
while IFS='|' read -r name sha path; do
  [ -n "$name" ] || continue
  fetch_verified "https://archive.ubuntu.com/ubuntu/$path" "$DL/$name" "$sha" \
    "Ubuntu deb $name"
done <<<"$UBUNTU_DEBS"

# Shared smoke inputs.
ensure_smoke_artifacts
verify_sha256 "$SMOKE/images/smoke/vmlinux" "$KERNEL_SHA256" "kernel vmlinux"
verify_sha256 "$SMOKE/dl/jq" "$JQ_SHA256" "static jq"
verify_sha256 "$SMOKE/firecracker" "$FC_BINARY_SHA256" "firecracker binary"
verify_sha256 "$SMOKE/dl/rootdir/bin/busybox" "$BUSYBOX_SHA256" "busybox"
# The jailer is a separate binary in the same release tarball; the pinned
# tarball digest (verified by the smoke fetcher and re-checked below when the
# tarball is cached) is authoritative for it.
verify_sha256 "$SMOKE/dl/fc.tgz" "$FC_TARBALL_SHA256" "firecracker tarball"
[ -x "$SMOKE/dl/fc-extract/release-$FC_VERSION-x86_64/jailer-$FC_VERSION-x86_64" ] ||
  die "jailer binary is missing from the verified Firecracker tarball"

lab_log "artifacts ready in $ART"
