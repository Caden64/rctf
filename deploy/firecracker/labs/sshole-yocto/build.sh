#!/bin/bash
# Build the two sshhole-yocto lab rootfs images, unprivileged.
#
#   sshole-yocto-musl    yocto-6.0.4 (wrynose, LTS) + TCLIBC=musl + stock
#                       openssh 10.3p1 built/run without PAM   -> VULNERABLE
#   sshole-yocto-glibc  identical recipe and config, TCLIBC=glibc -> control
#
# The rootfs trees are produced by bitbake (genuine poky core-image-minimal +
# openssh + the two throwaway accounts), then staged with tar only and turned
# into ext4 images through ../../guest/build-rootfs.sh --dir. No container
# engine, no loop mount, no chroot, no root, and no guest binary is executed
# on the host.
#
# Build-time assertions fail the build unless the staged tree really contains
# the pinned build: the sshd version banner is read out of the binary bytes,
# the dynamic loader flavour is read with readelf, PAM must be entirely
# absent (no /etc/pam.d/sshd, no libpam anywhere, no pam linkage in sshd),
# /etc/os-release must identify the poky distro, the accounts must match the
# documented throwaway credentials, and no host key material may be present.
#
# Output: $SSHOLE_YOCTO_IMAGES/<name>/{rootfs.ext4,vmlinux,build-info.txt}
# plus a manifest at $SSHOLE_YOCTO_IMAGES/manifest.txt.
#
# Knobs (all optional): SSHOLE_YOCTO_ARTIFACTS, SSHOLE_YOCTO_IMAGES,
# SMOKE_ARTIFACTS, SSHOLE_YOCTO_SKIP_BITBAKE (reuse an existing Yocto build),
# SSHOLE_YOCTO_JOBS.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
LABS=$(cd -- "$HERE/../.." && pwd)
# shellcheck source=../lib/common.sh
. "$LABS/labs/lib/common.sh"

CACHE=${SSHOLE_YOCTO_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-sshole-yocto}
SMOKE=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
IMAGES=${SSHOLE_YOCTO_IMAGES:-$CACHE/images}
YDIR=$CACHE/yocto
DL=$CACHE/dl
GUEST_BUILD=$(cd -- "$HERE/../../guest" && pwd)

die() { lab_die "$*"; }

# --- pinned build identity ---------------------------------------------------
YOCTO_RELEASE=yocto-6.0.4
BANNER=OpenSSH_10.3p1
OPENSSH_PV=10.3p1
OPENSSH_SRC_SHA256=56682a36bb92dcf4b4f016fd8ec8e74059b79a8de25c15d670d731e7d18e45f4
PACKAGE=openssh-$OPENSSH_PV-stock-$YOCTO_RELEASE

# Throwaway lab credentials, documented in README.md. The accounts only ever
# exist inside lab images booted in the throwaway vmtest VM. bob's $5$ hash is
# the known-good SHA-crypt hash of 'sshole-lab-bob-password' (the same one the
# Alpine sshole lab pins; the password/hash pair was re-verified on the build
# host with libcrypt's crypt() before pinning - see RESULTS.md).
BOB_PASSWORD='sshole-lab-bob-password'
BOB_HASH='$5$ssholelab$6unyGM/PkwS.UT.BT2NITT5GU7sdbPg3YB.R56eQGr9'

[ -x "$GUEST_BUILD/build-rootfs.sh" ] ||
  die "guest builder missing: $GUEST_BUILD/build-rootfs.sh"
command -v tar >/dev/null || die "tar is required"
command -v strings >/dev/null || die "strings (binutils) is required for banner assertions"
command -v readelf >/dev/null || die "readelf (binutils) is required for loader/PAM assertions"
command -v xz >/dev/null || die "xz is required to unpack the Yocto rootfs tarball"

mkdir -p "$IMAGES"
# The agent's image trust check rejects group/world-writable dirs.
chmod 0755 "$IMAGES"

# --- inputs: pinned artifacts + the genuine Yocto build -----------------------
"$HERE/fetch-artifacts.sh"

if [ "${SSHOLE_YOCTO_SKIP_BITBAKE:-0}" != 1 ]; then
  "$HERE/yocto-build.sh" --tclib all ||
    die "the Yocto bitbake build failed"
fi

# --- helpers -----------------------------------------------------------------
write_build_info() { # <root> <image> <libc>
  local root=$1 image=$2 libc=$3
  cat >"$root/etc/sshole-build" <<EOF
IMAGE=$image
FAMILY=yocto
DISTRO=poky
YOCTO_RELEASE=$YOCTO_RELEASE
LIBC=$libc
PAM=no
PACKAGE=$PACKAGE
OPENSSH_SRC_SHA256=$OPENSSH_SRC_SHA256
SSHD_BANNER=$BANNER
EOF
  chmod 0644 "$root/etc/sshole-build"
}

assert_build_info() { # <root> <image> <libc>
  local root=$1 image=$2 libc=$3
  grep -qx "IMAGE=$image" "$root/etc/sshole-build" ||
    die "$image: build-info does not name the image"
  grep -qx "FAMILY=yocto" "$root/etc/sshole-build" ||
    die "$image: build-info does not name the yocto family"
  grep -qx "LIBC=$libc" "$root/etc/sshole-build" ||
    die "$image: build-info does not name $libc"
  grep -qx "PAM=no" "$root/etc/sshole-build" ||
    die "$image: build-info must record PAM=no"
  grep -qx "PACKAGE=$PACKAGE" "$root/etc/sshole-build" ||
    die "$image: build-info does not carry the pinned package"
  grep -qx "SSHD_BANNER=$BANNER" "$root/etc/sshole-build" ||
    die "$image: build-info does not carry the pinned banner"
}

# interpreter_of <file>: prints the ELF program interpreter path.
interpreter_of() {
  readelf -l "$1" 2>/dev/null |
    sed -n 's/.*Requesting program interpreter: \(.*\)\]/\1/p' |
    head -n 1
}

# linked_libs <file>: prints DT_NEEDED entries.
linked_libs() {
  readelf -d "$1" 2>/dev/null |
    sed -n 's/.*Shared library: \[\(.*\)\]/\1/p'
}

assert_common_guest() { # <root> <image> <libc>
  local root=$1 image=$2 libc=$3
  local loader=
  assert_sshd_banner "$root" usr/sbin/sshd "$BANNER"
  assert_executable "$root/usr/sbin/sshd" "$image sshd"
  # OpenSSH >= 9.8 splits the privileged monitor/session code into
  # sshd-session/sshd-auth; the guest cannot accept a session without them.
  # OE installs them directly under ${libexecdir} (recipe FILES:
  # ${libexecdir}/sshd-session); accept the openssh/ subdir spelling too.
  local session_ok=0 auth_ok=0
  for p in usr/libexec/sshd-session usr/libexec/openssh/sshd-session; do
    [ -x "$root/$p" ] && session_ok=1
  done
  for p in usr/libexec/sshd-auth usr/libexec/openssh/sshd-auth; do
    [ -x "$root/$p" ] && auth_ok=1
  done
  [ "$session_ok" = 1 ] ||
    die "$image: sshd-session (post-9.8 privilege separation) is missing"
  [ "$auth_ok" = 1 ] ||
    die "$image: sshd-auth (post-9.8 privilege separation) is missing"
  assert_executable "$root/usr/bin/ssh-keygen" "$image ssh-keygen"
  assert_executable "$root/app/start" "$image /app/start"
  require_file "$root/etc/ssh/sshd_config" "$image sshd_config"

  # sshd_config: the vulnerable configuration, exactly.
  grep -qx 'PasswordAuthentication yes' "$root/etc/ssh/sshd_config" ||
    die "$image: PasswordAuthentication is not enabled"
  grep -qx 'UsePAM no' "$root/etc/ssh/sshd_config" ||
    die "$image: UsePAM is not explicitly no"
  grep -qx 'PermitRootLogin prohibit-password' "$root/etc/ssh/sshd_config" ||
    die "$image: root login is not limited to prohibit-password"
  grep -qx 'AllowUsers alice bob' "$root/etc/ssh/sshd_config" ||
    die "$image: AllowUsers is not exactly 'alice bob'"

  # PAM must be entirely absent: no service config, no library, no linkage.
  [ ! -e "$root/etc/pam.d/sshd" ] ||
    die "$image: /etc/pam.d/sshd must not exist in a no-PAM build"
  if find "$root" -xdev -name 'libpam*' -print -quit | grep -q .; then
    die "$image: a libpam* file leaked into the image"
  fi
  if linked_libs "$root/usr/sbin/sshd" | grep -qi pam; then
    die "$image: sshd links against a PAM library"
  fi

  # libc flavour, read out of the binary bytes (readelf, never execution).
  loader=$(interpreter_of "$root/usr/sbin/sshd")
  [ -n "$loader" ] || die "$image: could not read sshd's program interpreter"
  case "$libc" in
    musl)
      [ -f "$root/lib/ld-musl-x86_64.so.1" ] ||
        die "$image: the musl loader is missing"
      case "$loader" in
        /lib/ld-musl-x86_64.so.1) ;;
        *) die "$image: sshd interpreter is $loader, expected /lib/ld-musl-x86_64.so.1" ;;
      esac
      if linked_libs "$root/usr/sbin/sshd" | grep -q '^ld-linux\|^libm\.so\|libc\.so\.6$'; then
        die "$image: sshd looks glibc-linked in a musl image"
      fi
      ;;
    glibc)
      if [ ! -f "$root/lib64/ld-linux-x86-64.so.2" ] &&
        [ ! -f "$root/lib/ld-linux-x86-64.so.2" ]; then
        die "$image: the glibc loader is missing"
      fi
      case "$loader" in
        /lib64/ld-linux-x86-64.so.2 | /lib/ld-linux-x86-64.so.2) ;;
        *) die "$image: sshd interpreter is $loader, expected a glibc ld-linux" ;;
      esac
      [ ! -e "$root/lib/ld-musl-x86_64.so.1" ] ||
        die "$image: a musl loader leaked into the glibc control image"
      ;;
    *) die "$image: unknown libc spec: $libc" ;;
  esac

  # Yocto identity markers: a genuine poky /etc/os-release.
  local osrel=$root/etc/os-release
  [ -e "$osrel" ] || [ -e "$root/usr/lib/os-release" ] ||
    die "$image: no os-release found (is the os-release package installed?)"
  if [ -L "$osrel" ]; then
    require_file "$root/usr/lib/os-release" "$image os-release target"
  fi
  local rel=${osrel}
  [ -f "$rel" ] || rel=$root/usr/lib/os-release
  grep -qx 'ID=poky' "$rel" ||
    die "$image: os-release does not identify the poky distro"
  grep -qx 'VERSION_ID=6.0.4' "$rel" ||
    die "$image: os-release does not carry the yocto-6.0.4 version"
  grep -q '^NAME="Poky (Yocto Project Reference Distro)"' "$rel" ||
    die "$image: os-release does not carry the poky distro name"

  # The documented throwaway accounts, byte-exact (awk compares the shadow
  # password FIELD, so a '!' or '!*' or partial match cannot sneak through).
  awk -F: '$1 == "alice" && $2 != "*" { exit 1 }' "$root/etc/shadow" ||
    die "$image: alice's shadow password field is not exactly '*'"
  awk -F: -v hash="$BOB_HASH" '$1 == "bob" && $2 != hash { exit 1 }' \
    "$root/etc/shadow" ||
    die "$image: bob does not carry the pinned \$5\$ hash"
  grep -q '^alice:x:1000:1000:' "$root/etc/passwd" ||
    die "$image: alice is not uid 1000"
  grep -q '^bob:x:1001:1001:' "$root/etc/passwd" ||
    die "$image: bob is not uid 1001"
  awk -F: '$1 == "alice" && $2 != "x" { exit 1 }' "$root/etc/passwd" ||
    die "$image: alice's passwd entry is not exactly 'x'"
  grep -qx 'alice:x:1000:' "$root/etc/group" ||
    die "$image: alice's group entry is missing"
  grep -qx 'bob:x:1001:' "$root/etc/group" ||
    die "$image: bob's group entry is missing"
  # /etc/shadow must be root-only (OE's shadow package ships 0400; the Alpine
  # sibling lab's hand-staged images used 0600 - both are strict, anything
  # group/world-readable fails the build).
  local smode
  smode=$(stat -c %a "$root/etc/shadow")
  [ "$smode" = 400 ] || [ "$smode" = 600 ] ||
    die "$image: /etc/shadow is mode $smode, expected 0400/0600"

  # The rCTF guest init needs busybox ip/nc applets in the image.
  local found=
  found=$(find "$root/bin" "$root/sbin" "$root/usr/bin" "$root/usr/sbin" \
    -maxdepth 1 \( -name ip -o -name nc \) 2>/dev/null | sort -u)
  printf '%s\n' "$found" | grep -qx '.*/ip' ||
    die "$image: no busybox 'ip' applet found (MMDS route setup would fail)"
  printf '%s\n' "$found" | grep -qx '.*/nc' ||
    die "$image: no busybox 'nc' applet found (MMDS fetch would fail)"

  # No host key material may be baked into the image (generated at boot).
  if find "$root/etc/ssh" -name 'ssh_host_*' -print -quit | grep -q .; then
    die "$image: baked-in ssh host keys are not allowed"
  fi
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

# stage_yocto_rootfs <tclib> -> prints the path of the Yocto rootfs tarball
stage_yocto_rootfs() {
  local tclib=$1
  local bdir=$YDIR/build-$tclib
  local link=$bdir/tmp/deploy/images/qemux86-64/sshhole-yocto-image-qemux86-64.rootfs.tar.xz
  require_file "$link" "the $tclib Yocto rootfs tarball"
  local real
  real=$(readlink -f "$link")
  require_file "$real" "the $tclib Yocto rootfs tarball (resolved)"
  printf '%s\n' "$real"
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/sshole-yocto-build.XXXXXX") ||
  die "could not create a staging directory"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

build_yocto_image() { # <image-name> <tclib>
  local name=$1 tclib=$2
  local root=$WORK/$name
  rm -rf "$root"
  mkdir -p "$root"
  local tarball
  tarball=$(stage_yocto_rootfs "$tclib")
  lab_log "staging $name from $tarball"
  # Extracting as an unprivileged user drops the pseudo ownership (files land
  # owned by the builder); modes are preserved. /app/start re-chowns the
  # runtime-critical files to root at boot.
  tar -xJf "$tarball" -C "$root" ||
    die "$name: could not unpack the Yocto rootfs tarball"

  # The Yocto rootfs must not carry an /app from another source; assert ours.
  assert_executable "$root/app/start" "$name /app/start (from the Yocto build)"

  write_build_info "$root" "$name" "$tclib"
  assert_build_info "$root" "$name" "$tclib"
  assert_common_guest "$root" "$name" "$tclib"
  build_image "$name" 256M "$root"
}

build_yocto_image sshole-yocto-musl musl
build_yocto_image sshole-yocto-glibc glibc

# --- manifest ----------------------------------------------------------------
MANIFEST=$IMAGES/manifest.txt
{
  printf '# sshole-yocto lab image manifest\n'
  printf '# generated %s by build.sh\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'yocto-release: %s (wrynose LTS; component tarballs pinned in fetch-artifacts.sh)\n' "$YOCTO_RELEASE"
  printf 'openssh: stock %s recipe (upstream tarball sha256 %s), no CVE-2026-123158 backport\n' \
    "$OPENSSH_PV" "$OPENSSH_SRC_SHA256"
  for f in "$YDIR/build-musl/sshhole-versions.txt" "$YDIR/build-glibc/sshhole-versions.txt"; do
    if [ -f "$f" ]; then
      printf '%s:\n' "$(basename "$(dirname "$f")")"
      sed 's/^/  /' "$f"
    fi
  done
  for image in sshole-yocto-musl sshole-yocto-glibc; do
    printf '\nimage: %s\n' "$image"
    for f in rootfs.ext4 vmlinux; do
      printf '  %-10s sha256 %s  %s bytes\n' "$f" \
        "$(sha256_of "$IMAGES/$image/$f")" "$(stat -c %s "$IMAGES/$image/$f")"
    done
  done
} >"$MANIFEST"
chmod 0644 "$MANIFEST"

printf '\nsshole-yocto images built in %s\n' "$IMAGES"
for image in sshole-yocto-musl sshole-yocto-glibc; do
  printf '  %-22s %s\n' "$image" \
    "$(awk '/^rootfs\.ext4 sha256/{print $3}' "$IMAGES/$image/build-info.txt")"
done
printf 'manifest: %s\n' "$MANIFEST"
