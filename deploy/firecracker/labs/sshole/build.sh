#!/bin/bash
# Build the four sshole lab rootfs images, unprivileged.
#
#   sshole-musl-vuln   Alpine 3.24.4 + openssh-server 10.3_p1-r1 (no PAM)
#   sshole-musl-fixed  Alpine edge + openssh-server 10.6_p2-r0 (the upstream fix)
#   sshole-glibc       Ubuntu 24.04.5 base + openssh-server 9.6p1 (glibc control)
#   sshole-pam         Alpine 3.24.4 + openssh-server-pam 10.3_p1-r1, UsePAM yes
#
# Every image is assembled by unpacking pinned, sha256-verified artifacts into a
# staging directory and calling ../../guest/build-rootfs.sh --dir. No container
# engine, no loop mount, no chroot, no root, and no guest binary is executed on
# the host. Build-time assertions fail the build when the staged tree does not
# contain the pinned sshd banner or the expected libc/PAM flavour.
#
# Output: $SSHOLE_IMAGES/<name>/{rootfs.ext4,vmlinux,build-info.txt}
set -euo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=../lib/common.sh
. "$HERE/../lib/common.sh"

CACHE=${SSHOLE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-sshole}
SMOKE=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
IMAGES=${SSHOLE_IMAGES:-$CACHE/images}
DL=$CACHE/dl
GUEST_BUILD=$(cd -- "$HERE/../../guest" && pwd)

die() { lab_die "$*"; }

# --- pinned input filenames (digests live in fetch-artifacts.sh) ------------
ALPINE324_MINIROOTFS=alpine-minirootfs-3.24.4-x86_64.tar.gz
ALPINE_EDGE_MINIROOTFS=alpine-minirootfs-20260805-x86_64.tar.gz
UBUNTU_BASE=ubuntu-base-24.04.5-base-amd64.tar.gz

# --- pinned sshd banners (asserted out of the binary bytes) -----------------
BANNER_VULN=OpenSSH_10.3p1
BANNER_FIXED=OpenSSH_10.6p2
BANNER_GLIBC=OpenSSH_9.6p1
BANNER_PAM=OpenSSH_10.3p1

# Throwaway lab credentials. Documented in README.md; these images are only ever
# booted inside the throwaway vmtest VM.
BOB_PASSWORD='sshole-lab-bob-password'
BOB_HASH_SHA512='$6$ssholelab$CsS0VmKMBwegzfoHxO57XNvGhMQWkKdTznK7/45XS3oOrl1l60q1ZbBgCeLePnQYb/HDGjByYnsR0rhv4JGPC0'
BOB_HASH_SHA256='$5$ssholelab$6unyGM/PkwS.UT.BT2NITT5GU7sdbPg3YB.R56eQGr9'

[ -x "$GUEST_BUILD/build-rootfs.sh" ] ||
  die "guest builder missing: $GUEST_BUILD/build-rootfs.sh"
command -v tar >/dev/null || die "tar is required"
command -v ar >/dev/null || die "ar (binutils) is required to unpack Ubuntu .deb files"
command -v zstd >/dev/null || die "zstd is required to unpack Ubuntu .deb files"
command -v strings >/dev/null || die "strings (binutils) is required for banner assertions"

mkdir -p "$IMAGES"
# The agent's image trust check rejects group/world-writable dirs.
chmod 0755 "$IMAGES"

"$HERE/fetch-artifacts.sh"

require_file "$DL/$ALPINE324_MINIROOTFS" "Alpine 3.24.4 minirootfs"
require_file "$DL/$ALPINE_EDGE_MINIROOTFS" "Alpine edge minirootfs"
require_file "$DL/$UBUNTU_BASE" "Ubuntu base rootfs"
require_file "$SMOKE/images/smoke/vmlinux" "kernel"
require_file "$SMOKE/dl/jq" "static jq"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/sshole-build.XXXXXX") ||
  die "could not create a staging directory"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# --- helpers -----------------------------------------------------------------

# extract_apks <staging-root> <apk...>
extract_apks() {
  local root=$1
  shift
  local apk
  for apk in "$@"; do
    stage_apk "$DL/$apk.apk" "$root"
  done
}

# extract_debs <staging-root> <deb...>
extract_debs() {
  local root=$1
  shift
  local deb
  for deb in "$@"; do
    stage_deb "$DL/$deb" "$root"
  done
}

write_build_info() { # <root> <image> <family> <libc> <pam> <package> <banner>
  local root=$1 image=$2 family=$3 libc=$4 pam=$5 package=$6 banner=$7
  cat >"$root/etc/sshole-build" <<EOF
IMAGE=$image
FAMILY=$family
LIBC=$libc
PAM=$pam
PACKAGE=$package
SSHD_BANNER=$banner
EOF
  chmod 0644 "$root/etc/sshole-build"
}

assert_build_info() { # <root> <image> <family> <libc> <pam> <package> <banner>
  local root=$1 image=$2 family=$3 libc=$4 pam=$5 package=$6 banner=$7
  grep -qx "IMAGE=$image" "$root/etc/sshole-build" ||
    die "$image: build-info does not name the image"
  grep -qx "LIBC=$libc" "$root/etc/sshole-build" ||
    die "$image: build-info does not name $libc"
  grep -qx "FAMILY=$family" "$root/etc/sshole-build" ||
    die "$image: build-info does not name the $family family"
  grep -qx "PAM=$pam" "$root/etc/sshole-build" ||
    die "$image: build-info does not carry the expected PAM flavour"
  grep -qx "PACKAGE=$package" "$root/etc/sshole-build" ||
    die "$image: build-info does not carry the pinned package"
  grep -qx "SSHD_BANNER=$banner" "$root/etc/sshole-build" ||
    die "$image: build-info does not carry the pinned banner"
}

assert_common_guest() { # <root> <image> <banner> <pam-yes-no>
  local root=$1 image=$2 banner=$3 use_pam=$4
  assert_sshd_banner "$root" usr/sbin/sshd "$banner"
  assert_executable "$root/usr/sbin/sshd" "$image sshd"
  assert_executable "$root/usr/bin/ssh-keygen" "$image ssh-keygen"
  assert_executable "$root/app/start" "$image /app/start"
  require_file "$root/etc/ssh/sshd_config" "$image sshd_config"
  grep -qx 'PasswordAuthentication yes' "$root/etc/ssh/sshd_config" ||
    die "$image: PasswordAuthentication is not enabled"
  grep -qx "UsePAM $use_pam" "$root/etc/ssh/sshd_config" ||
    die "$image: UsePAM is not $use_pam"
  grep -qx 'alice:\*:.*' "$root/etc/shadow" ||
    die "$image: alice's shadow field is not exactly '*'"
  grep -q '^bob:\$[56]\$' "$root/etc/shadow" ||
    die "$image: bob has no real \$5\$/\$6\$ password hash"
  # No key material or disposable password hash is allowed to be world-readable.
  [ "$(stat -c %a "$root/etc/shadow")" = 600 ] ||
    die "$image: /etc/shadow is not mode 0600"
}

# build_image <name> <size> <staging-root>
build_image() {
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
  printf 'rootfs.ext4 sha256 %s\nvmlinux sha256 %s\n' \
    "$sum" "$(sha256_of "$out/vmlinux")" >"$out/build-info.txt"
  chmod 0644 "$out/build-info.txt"
  lab_note "$name rootfs.ext4 sha256 $sum"
}

# --- Alpine musl vulnerable image -------------------------------------------
build_vuln() {
  local name=sshole-musl-vuln
  local root=$WORK/$name
  local base=$root.base
  rm -rf "$root" "$base"
  mkdir -p "$base"
  lab_log "staging $name"
  tar -xzf "$DL/$ALPINE324_MINIROOTFS" -C "$base" ||
    die "$name: could not unpack the Alpine minirootfs"
  mkdir -p "$root"
  cp -a "$base/." "$root/"
  extract_apks "$root" \
    openssh-server-10.3_p1-r1 \
    openssh-keygen-10.3_p1-r1 \
    openssh-server-common-10.3_p1-r1 \
    openssh-client-common-10.3_p1-r1 \
    libcrypto3-3.5.9-r0 zlib-1.4-r0 musl-1.2.6-r3 \
    libedit-20260508.3.1-r1 libncursesw-6.6_p20260516-r0 \
    ncurses-terminfo-base-6.6_p20260516-r0

  # musl control: the dynamic loader must be musl, never glibc.
  require_file "$root/lib/ld-musl-x86_64.so.1" "$name musl loader"
  [ ! -e "$root/lib64/ld-linux-x86-64.so.2" ] ||
    die "$name: a glibc loader leaked into the musl image"

  write_sshole_users "$root" "$BOB_HASH_SHA256"
  write_sshole_nsswitch "$root"
  write_sshd_config "$root" no
  write_sshole_start "$root"
  write_build_info "$root" "$name" alpine musl no \
    openssh-server-10.3_p1-r1 "$BANNER_VULN"
  assert_build_info "$root" "$name" alpine musl no \
    openssh-server-10.3_p1-r1 "$BANNER_VULN"
  assert_common_guest "$root" "$name" "$BANNER_VULN" no
  build_image "$name" 256M "$root"
}

# --- Alpine musl fixed image ------------------------------------------------
build_fixed() {
  local name=sshole-musl-fixed
  local root=$WORK/$name
  rm -rf "$root"
  mkdir -p "$root"
  lab_log "staging $name"
  tar -xzf "$DL/$ALPINE_EDGE_MINIROOTFS" -C "$root" ||
    die "$name: could not unpack the Alpine edge minirootfs"
  extract_apks "$root" \
    openssh-server-10.6_p2-r0 \
    openssh-keygen-10.6_p2-r0 \
    openssh-server-common-10.6_p2-r0 \
    openssh-client-common-10.6_p2-r0 \
    libcrypto3-edge zlib-edge musl-1.2.6-r6 \
    libedit-20260512.3.1-r0 libncursesw-6.6_p20261017-r0 \
    ncurses-terminfo-base-6.6_p20261017-r0

  require_file "$root/lib/ld-musl-x86_64.so.1" "$name musl loader"
  write_sshole_users "$root" "$BOB_HASH_SHA256"
  write_sshole_nsswitch "$root"
  write_sshd_config "$root" no
  write_sshole_start "$root"
  write_build_info "$root" "$name" alpine musl no \
    openssh-server-10.6_p2-r0 "$BANNER_FIXED"
  assert_build_info "$root" "$name" alpine musl no \
    openssh-server-10.6_p2-r0 "$BANNER_FIXED"
  assert_common_guest "$root" "$name" "$BANNER_FIXED" no
  build_image "$name" 256M "$root"
}

# --- Alpine PAM control ------------------------------------------------------
build_pam() {
  local name=sshole-pam
  local root=$WORK/$name
  rm -rf "$root"
  mkdir -p "$root"
  lab_log "staging $name"
  tar -xzf "$DL/$ALPINE324_MINIROOTFS" -C "$root" ||
    die "$name: could not unpack the Alpine minirootfs"
  # Deliberately install only the PAM flavour: openssh-server (non-PAM) would
  # overwrite /usr/sbin/sshd and defeat the control.
  extract_apks "$root" \
    openssh-server-pam-10.3_p1-r1 \
    openssh-keygen-10.3_p1-r1 \
    openssh-server-common-10.3_p1-r1 \
    linux-pam-1.7.1-r2 utmps-libs-0.1.3.3-r0 skalibs-libs-2.15.0.0-r0 \
    libcrypto3-3.5.9-r0 zlib-1.4-r0 musl-1.2.6-r3

  require_file "$root/lib/ld-musl-x86_64.so.1" "$name musl loader"
  assert_executable "$root/usr/sbin/sshd.pam" "$name sshd.pam"
  # Normalise the binary name so /app/start is identical for every image, and
  # make the PAM flavour explicit in the banner assertion target.
  ln -sf sshd.pam "$root/usr/sbin/sshd"
  # Self-contained PAM service config: absolute module paths only, so the
  # control cannot accidentally pass because of a missing vendor include.
  cat >"$root/etc/pam.d/sshd" <<'PAM'
# sshole lab: password authentication through pam_unix for bob; alice's "*"
# shadow field is not a usable hash.
auth      required  /usr/lib/security/pam_unix.so
account   required  /usr/lib/security/pam_unix.so
password  required  /usr/lib/security/pam_unix.so
session   required  /usr/lib/security/pam_unix.so
PAM
  chmod 0644 "$root/etc/pam.d/sshd"
  require_file "$root/usr/lib/security/pam_unix.so" "$name pam_unix module"

  write_sshole_users "$root" "$BOB_HASH_SHA256"
  write_sshole_nsswitch "$root"
  write_sshd_config "$root" yes
  write_sshole_start "$root"
  write_build_info "$root" "$name" alpine musl yes \
    openssh-server-pam-10.3_p1-r1 "$BANNER_PAM"
  assert_build_info "$root" "$name" alpine musl yes \
    openssh-server-pam-10.3_p1-r1 "$BANNER_PAM"
  assert_common_guest "$root" "$name" "$BANNER_PAM" yes
  build_image "$name" 256M "$root"
}

# --- Ubuntu glibc control ----------------------------------------------------
build_glibc() {
  local name=sshole-glibc
  local root=$WORK/$name
  rm -rf "$root"
  mkdir -p "$root"
  lab_log "staging $name"
  tar -xzf "$DL/$UBUNTU_BASE" -C "$root" ||
    die "$name: could not unpack the Ubuntu base rootfs"
  extract_debs "$root" \
    openssh-server_9.6p1-3ubuntu13.20_amd64.deb \
    openssh-client_9.6p1-3ubuntu13.20_amd64.deb \
    libpam0g_1.5.3-5ubuntu5.7_amd64.deb \
    libaudit1_3.1.2-2.1ubuntu0.1_amd64.deb \
    libaudit-common_3.1.2-2.1ubuntu0.1_all.deb \
    libcap-ng0_0.8.4-2build2_amd64.deb \
    libselinux1_3.5-2ubuntu2.1_amd64.deb \
    libpcre2-8-0_10.42-4ubuntu2.2_amd64.deb \
    libcrypt1_4.4.36-4build1_amd64.deb \
    libssl3t64_3.0.13-0ubuntu3.16_amd64.deb \
    zlib1g_1.3.dfsg-3.1ubuntu2.3_amd64.deb \
    libwrap0_7.6.q-33_amd64.deb \
    libcom-err2_1.47.0-2.4~exp1ubuntu4.1_amd64.deb \
    libgssapi-krb5-2_1.20.1-6ubuntu2.10_amd64.deb \
    libkrb5-3_1.20.1-6ubuntu2.10_amd64.deb \
    libk5crypto3_1.20.1-6ubuntu2.10_amd64.deb \
    libkrb5support0_1.20.1-6ubuntu2.10_amd64.deb \
    libkeyutils1_1.6.3-3build1_amd64.deb \
    libc6_2.39-0ubuntu8.9_amd64.deb \
    libgcc-s1_14.2.0-4ubuntu2~24.04.1_amd64.deb \
    gcc-14-base_14.2.0-4ubuntu2~24.04.1_amd64.deb

  # glibc control: a glibc loader and libc must be present, musl must not.
  require_file "$root/lib/x86_64-linux-gnu/libc.so.6" "$name glibc"
  [ ! -e "$root/lib/ld-musl-x86_64.so.1" ] ||
    die "$name: a musl loader leaked into the glibc image"

  # The Ubuntu base has no `ip` or `nc`, which guest/init uses for the MMDS
  # fetch. The pinned static busybox from the smoke artifacts provides both and
  # is also what the smoke test boots; it never runs on the host.
  install -m 0755 "$SMOKE/dl/rootdir/bin/busybox" "$root/usr/bin/busybox" ||
    die "$name: could not install busybox"
  for applet in ip nc; do
    if [ ! -e "$root/usr/bin/$applet" ] && [ ! -L "$root/usr/bin/$applet" ]; then
      ln -s busybox "$root/usr/bin/$applet" ||
        die "$name: could not link $applet"
    fi
  done
  require_file "$root/usr/bin/busybox" "$name busybox"

  write_sshole_users "$root" "$BOB_HASH_SHA512"
  write_sshole_nsswitch "$root"
  # UsePAM no deliberately: the glibc control must exercise the same non-PAM
  # crypt() path as the vulnerable image, isolating libc as the only difference.
  write_sshd_config "$root" no
  write_sshole_start "$root"
  write_build_info "$root" "$name" ubuntu glibc no \
    openssh-server-9.6p1-3ubuntu13.20 "$BANNER_GLIBC"
  assert_build_info "$root" "$name" ubuntu glibc no \
    openssh-server-9.6p1-3ubuntu13.20 "$BANNER_GLIBC"
  assert_common_guest "$root" "$name" "$BANNER_GLIBC" no
  build_image "$name" 512M "$root"
}

lab_log "artifacts: $CACHE"
lab_log "images:    $IMAGES"
build_vuln
build_fixed
build_pam
build_glibc

printf '\nsshole images built in %s\n' "$IMAGES"
for image in sshole-musl-vuln sshole-musl-fixed sshole-glibc sshole-pam; do
  printf '  %-20s %s\n' "$image" \
    "$(awk '/^rootfs\.ext4 sha256/{print $3}' "$IMAGES/$image/build-info.txt")"
done
