#!/bin/sh
# Build a Firecracker rootfs.ext4 without root (uses mkfs.ext4 -d).
#
# Usage:
#   build-rootfs.sh --image <docker-or-oci-ref> [options]
#   build-rootfs.sh --dir <existing-rootfs-dir> [options]
#
# Options:
#   --out <file>    output image (default: rootfs.ext4)
#   --size <size>   image size passed to truncate (default: 512M)
#   --init <file>   init to install as /rctf/init (default: ./init next to this script)
#   --jq <file>     copy this jq binary to /rctf/jq in the image
#   --arch <arch>   guest architecture for the --jq ELF check (default: x86_64)
#   --no-init       do not install an init
#
# The --jq binary is checked before it is installed: ELF magic, 64-bit,
# little-endian and an ELF machine type matching --arch (x86_64|aarch64).
# This catches a wrong-architecture or non-ELF jq without executing it. What it
# cannot check unprivileged (no chroot, no execution): that the guest rootfs
# has the dynamic loader and shared libraries a dynamically-linked jq needs.
# Install a static jq when the source image is not known to provide them.
#
# Requirements (all unprivileged): a container engine for --image (docker or
# podman), tar, truncate, realpath, od and e2fsprogs >= 1.47 (mkfs.ext4 -d). No
# loop mount, no chroot, no root.
#
# SECURITY: only run this builder as root on sources you fully trust. It
# extracts/copies a source tree and only ever writes the fixed set of staging
# paths below, but a root-run build gives a malicious source tar every chance
# to attack the host through the tools it invokes.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_image=
source_dir=
out=rootfs.ext4
size=512M
init_file=$script_dir/init
jq_file=
arch=x86_64
install_init=1

usage() {
  sed -n '2,/^# Requirements:/p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  printf 'build-rootfs: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case $1 in
    --image)
      [ $# -ge 2 ] || die "--image needs a value"
      source_image=$2
      shift 2
      ;;
    --dir)
      [ $# -ge 2 ] || die "--dir needs a value"
      source_dir=$2
      shift 2
      ;;
    --out)
      [ $# -ge 2 ] || die "--out needs a value"
      out=$2
      shift 2
      ;;
    --size)
      [ $# -ge 2 ] || die "--size needs a value"
      size=$2
      shift 2
      ;;
    --init)
      [ $# -ge 2 ] || die "--init needs a value"
      init_file=$2
      shift 2
      ;;
    --jq)
      [ $# -ge 2 ] || die "--jq needs a value"
      jq_file=$2
      shift 2
      ;;
    --arch)
      [ $# -ge 2 ] || die "--arch needs a value"
      arch=$2
      shift 2
      ;;
    --no-init)
      install_init=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done

if [ -n "$source_image" ] && [ -n "$source_dir" ]; then
  die "use either --image or --dir, not both"
fi
if [ -z "$source_image" ] && [ -z "$source_dir" ]; then
  die "one of --image or --dir is required (try --help)"
fi

case "$arch" in
  x86_64) expected_machine=62 ;;
  aarch64) expected_machine=183 ;;
  *) die "unsupported --arch: $arch (expected x86_64 or aarch64)" ;;
esac

command -v mkfs.ext4 >/dev/null 2>&1 ||
  die "mkfs.ext4 not found (install e2fsprogs)"
command -v truncate >/dev/null 2>&1 || die "truncate not found (coreutils)"
command -v realpath >/dev/null 2>&1 || die "realpath not found (coreutils)"
command -v od >/dev/null 2>&1 || die "od not found (coreutils or busybox)"
mkfs.ext4 -h 2>&1 | grep -q -- '-d' ||
  die "this mkfs.ext4 lacks -d; e2fsprogs >= 1.47 is required"

root=$(mktemp -d "${TMPDIR:-/tmp}/rctf-rootfs.XXXXXX")
container=
real_root=

cleanup() {
  if [ -n "$container" ]; then
    "$runtime" rm -f "$container" >/dev/null 2>&1 || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT INT TERM

if [ -n "$source_image" ]; then
  runtime=
  if command -v docker >/dev/null 2>&1; then
    runtime=docker
  elif command -v podman >/dev/null 2>&1; then
    runtime=podman
  else
    die "--image requires docker or podman"
  fi
  container=$("$runtime" create "$source_image" /bin/true) ||
    die "could not create a container from $source_image"
  # `export` reads the container filesystem without mounting it and needs no
  # root when the user can talk to the container engine.
  "$runtime" export "$container" | tar -x -C "$root" -f - ||
    die "could not export $source_image"
else
  [ -d "$source_dir" ] || die "--dir is not a directory: $source_dir"
  # -a keeps modes/symlinks; we own the copied files.
  cp -a "$source_dir/." "$root/" || die "could not copy $source_dir"
fi

real_root=$(realpath "$root") || die "could not resolve staging root"
[ -d "$real_root" ] || die "staging root is not a directory: $real_root"

mkdir -p "$root/proc" "$root/sys" "$root/dev" "$root/run" "$root/tmp" \
  "$root/etc"

# Install files only under a freshly created real /rctf directory. The source
# tree may contain /rctf or /sbin as symlinks to the host; remove a link
# without ever following it, then recreate the directory ourselves.
prepare_rctf_dir() {
  if [ -L "$root/rctf" ]; then
    rm -f "$root/rctf" || die "could not remove symlinked /rctf"
  elif [ -e "$root/rctf" ]; then
    rm -rf "$root/rctf" || die "could not remove source /rctf"
  fi
  mkdir -p "$root/rctf" || die "could not create /rctf"
  [ -d "$root/rctf" ] && [ ! -L "$root/rctf" ] ||
    die "/rctf is not a real directory"
  rctf_real=$(realpath "$root/rctf") || die "could not resolve /rctf"
  case "$rctf_real" in
    "$real_root"/*) ;;
    *) die "/rctf resolves outside the staging root: $rctf_real" ;;
  esac
}

# install_into_staging <source> <destination> <mode>
# Every write is checked against the staging root and refuses symlink targets.
install_into_staging() {
  src=$1
  dest=$2
  mode=$3
  [ -f "$src" ] || die "file not found: $src"
  dest_dir=$(dirname "$dest")
  [ -d "$dest_dir" ] && [ ! -L "$dest_dir" ] ||
    die "destination directory is missing or a symlink: $dest_dir"
  dest_real=$(realpath "$dest_dir") || die "could not resolve $dest_dir"
  case "$dest_real" in
    "$real_root"/*) ;;
    *) die "destination escapes the staging root: $dest_real" ;;
  esac
  if [ -L "$dest" ]; then
    die "refusing to write through a symlink: $dest"
  fi
  install -m "$mode" "$src" "$dest" || die "could not install $dest"
  written_real=$(realpath "$dest") || die "could not resolve $dest"
  case "$written_real" in
    "$real_root"/*) ;;
    *) die "written file escapes the staging root: $written_real" ;;
  esac
}

# check_guest_elf <file> <label>
#
# Fail closed on anything that cannot be a runnable guest binary of the
# requested architecture: not an ELF, not 64-bit, not little-endian, or an
# e_machine that does not match --arch. Unprivileged builds cannot execute the
# guest binary or inspect the guest's /lib, so missing dynamic libraries or a
# missing interpreter are documented as unverified.
check_guest_elf() {
  file=$1
  label=$2
  [ -f "$file" ] || die "$label not found: $file"
  [ -r "$file" ] || die "$label is not readable: $file"
  report=$(od -An -tu1 -N20 "$file" 2>/dev/null | awk '
    { for (i = 1; i <= NF; i++) b[n++] = $i }
    END {
      if (n < 20) { print "short"; exit }
      if (b[0] != 127 || b[1] != 69 || b[2] != 76 || b[3] != 70) {
        print "not-elf"; exit
      }
      if (b[4] != 2) { print "not-elf64"; exit }
      if (b[5] != 1) { print "not-little-endian"; exit }
      print "machine:" (b[18] + b[19] * 256)
    }')
  case "$report" in
    "machine:$expected_machine") ;;
    machine:*)
      die "$label is built for ELF machine ${report#machine:}, but --arch $arch expects $expected_machine (wrong guest architecture)"
      ;;
    short | not-elf)
      die "$label is not an ELF binary (a shell script or wrapper cannot be installed as /rctf/jq)"
      ;;
    not-elf64)
      die "$label is a 32-bit ELF; the guest image expects a 64-bit binary"
      ;;
    not-little-endian)
      die "$label is not little-endian; the guest image expects a little-endian binary"
      ;;
    *)
      die "could not verify $label as an ELF binary for --arch $arch"
      ;;
  esac
}

if [ "$install_init" = 1 ] || [ -n "$jq_file" ]; then
  prepare_rctf_dir
fi

if [ "$install_init" = 1 ]; then
  install_into_staging "$init_file" "$root/rctf/init" 0755
fi

if [ -n "$jq_file" ]; then
  check_guest_elf "$jq_file" "jq binary (--jq)"
  install_into_staging "$jq_file" "$root/rctf/jq" 0755
fi

# Old image files would make mkfs.ext4 refuse to overwrite.
rm -f "$out"
truncate -s "$size" "$out" || die "could not create $out"
mkfs.ext4 -F -L rctf-rootfs -d "$root" "$out" ||
  die "mkfs.ext4 failed"

printf 'build-rootfs: wrote %s (%s) from %s\n' \
  "$out" "$size" "${source_image:-$source_dir}"
