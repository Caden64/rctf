#!/bin/bash
# Download the third-party artifacts the smoke test needs and build the test guest image.
# Everything is fetched over HTTPS and every artifact is pinned to an exact version + sha256:
#   - Firecracker tarball: official release .sha256.txt
#   - Firecracker/jailer binaries: the publisher's SHA256SUMS inside that sha256-verified
#     tarball; the pins below are repeated so a tarball that disagrees is rejected
#   - jq: official sha256sum.txt for the pinned release
#   - kernel and busybox: no publisher checksum exists next to these binaries, so the
#     digests below were computed from the fetched bytes (trust-on-first-use); see README.md.
# Cached files are re-hashed before every use and a mismatch is fatal.
#
# FC_VERSION and KERNEL select a pinned pair; a version without a pin is refused
# (never silently fetched unpinned). See KERNEL_URL/KERNEL_SHA256 below for a
# fully explicit override.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ARTIFACTS=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}

# --- pinned versions and digests -------------------------------------------
FC_VERSION=${FC_VERSION:-v1.17.0}
case "$FC_VERSION" in
  v1.17.0)
    FC_TARBALL_SHA256=06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558
    FC_BINARY_SHA256=99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5
    FC_JAILER_SHA256=65ef226e96f0ceda55ba643f445801ef2cc0ea667ef67cad8ac4f406c9c8434f
    ;;
  v1.16.0)
    FC_TARBALL_SHA256=bd04e26952d4e158085778c6230a0b383d2619c319182e27eaa9d61a212e92d6
    FC_BINARY_SHA256=9b15fcdc63f95262c40c9eacfb510fca4353b567dd7624086f759982158efa61
    FC_JAILER_SHA256=86314fcb7754e21ab7c05704188985932c3688b2fe27976b1de4434373d8fc33
    ;;
  *)
    echo "no pinned digests for FC_VERSION=$FC_VERSION; refusing to fetch it unpinned" >&2
    echo "(add a case here with the release .sha256.txt tarball digest and TUFU binary digests)" >&2
    exit 2
    ;;
esac

JQ_VERSION=jq-1.8.2
JQ_SHA256=b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f

# KERNEL selects a pinned Firecracker CI x86_64 kernel. Inventory:
#   firecracker-ci/v1.15/x86_64/vmlinux-6.1.155     (the default pin)
#   firecracker-ci/20261105-6ea6634994fa-0/x86_64/vmlinux-6.1.188
#     (a newer 6.1 LTS from the dated CI directory; the same directory also
#      carries vmlinux-6.18.56, which KERNEL_URL/KERNEL_SHA256 can select)
# Set KERNEL_URL and KERNEL_SHA256 together to use any other kernel; both must
# be explicit, and the digest is enforced exactly like the pinned ones.
KERNEL=${KERNEL:-${KERNEL_FILE:-vmlinux-6.1.155}}
case "$KERNEL" in
  vmlinux-6.1.155)
    KERNEL_URL_DEFAULT=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.15/x86_64/$KERNEL
    KERNEL_SHA256_DEFAULT=e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2
    ;;
  vmlinux-6.1.188)
    KERNEL_URL_DEFAULT=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261105-6ea6634994fa-0/x86_64/$KERNEL
    KERNEL_SHA256_DEFAULT=31fe88d6c72b93d5c9c63cca599ccadec49fd35673bbfd04850d6c00ff27f032
    ;;
  *)
    KERNEL_URL_DEFAULT=
    KERNEL_SHA256_DEFAULT=
    ;;
esac
KERNEL_URL=${KERNEL_URL:-$KERNEL_URL_DEFAULT}
KERNEL_SHA256=${KERNEL_SHA256:-$KERNEL_SHA256_DEFAULT}
if [ -z "$KERNEL_URL" ] || [ -z "$KERNEL_SHA256" ]; then
  echo "no pinned URL/digest for KERNEL=$KERNEL; set KERNEL_URL and KERNEL_SHA256 together" >&2
  exit 2
fi
KERNEL_FILE=$KERNEL

BUSYBOX_FILE=busybox
BUSYBOX_URL=https://busybox.net/downloads/binaries/1.35.0-x86_64-linux-musl/$BUSYBOX_FILE
BUSYBOX_SHA256=6e123e7f3202a8c1e9b1f94d8941580a25135382b99e8d3e34fb858bba311348

arch=$(uname -m); [ "$arch" = x86_64 ] || { echo "this script fetches x86_64 artifacts" >&2; exit 2; }

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

verify_sha256() { # file expected label
  local actual
  actual=$(sha256_of "$1")
  [ "$actual" = "$2" ] || {
    echo "$3 sha256 mismatch: expected $2, got $actual ($1)" >&2
    exit 1
  }
}

# Use a cached file only after re-hashing it; download to a .part file and verify
# before publishing it under the real name.
fetch_verified() { # url destination expected-sha256 label
  local url=$1 dest=$2 expected=$3 label=$4 actual
  if [ -f "$dest" ]; then
    verify_sha256 "$dest" "$expected" "$label (cached)"
    echo "  cached $label verified"
    return 0
  fi
  echo "  downloading $label"
  if ! curl -fsSL -o "$dest.part" "$url"; then
    rm -f "$dest.part"
    echo "$label download failed: $url" >&2
    exit 1
  fi
  actual=$(sha256_of "$dest.part")
  if [ "$actual" != "$expected" ]; then
    rm -f "$dest.part"
    echo "$label sha256 mismatch: expected $expected, got $actual" >&2
    exit 1
  fi
  mv "$dest.part" "$dest"
}

mkdir -p "$ARTIFACTS/dl" "$ARTIFACTS/images/smoke"
cd "$ARTIFACTS/dl"

echo "== firecracker $FC_VERSION"
base=https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION
fetch_verified "$base/firecracker-$FC_VERSION-$arch.tgz" "fc-$FC_VERSION-$arch.tgz" \
  "$FC_TARBALL_SHA256" "firecracker $FC_VERSION tarball"
# Keep every extracted release side by side: other harnesses read
# fc-extract/release-<version>-<arch>/jailer-..., and the vmtest matrix needs
# several versions in one cache.
mkdir -p fc-extract
rm -rf "fc-extract/release-$FC_VERSION-$arch"
tar xzf "fc-$FC_VERSION-$arch.tgz" -C fc-extract
fc_bin="fc-extract/release-$FC_VERSION-$arch/firecracker-$FC_VERSION-$arch"
jailer_bin="fc-extract/release-$FC_VERSION-$arch/jailer-$FC_VERSION-$arch"
# The tarball ships a publisher SHA256SUMS next to the binaries; require it to
# agree with the pinned digests rather than trusting either one alone.
for pair in "firecracker-$FC_VERSION-$arch:$FC_BINARY_SHA256" \
  "jailer-$FC_VERSION-$arch:$FC_JAILER_SHA256"; do
  file=${pair%%:*}
  want=${pair#*:}
  got=$(awk -v f="./$file" '$2 == f { print $1; exit }' \
    "fc-extract/release-$FC_VERSION-$arch/SHA256SUMS")
  [ -n "$got" ] || { echo "tarball SHA256SUMS has no entry for $file" >&2; exit 1; }
  [ "$got" = "$want" ] || {
    echo "pinned digest for $file ($want) disagrees with the tarball SHA256SUMS ($got)" >&2
    exit 1
  }
done
verify_sha256 "$fc_bin" "$FC_BINARY_SHA256" "firecracker $FC_VERSION binary"
verify_sha256 "$jailer_bin" "$FC_JAILER_SHA256" "jailer $FC_VERSION binary"
# The canonical $ARTIFACTS/firecracker stays the default-version binary for the
# harnesses that read it; other versions are only available under their own
# name so a matrix run can never silently change what smoke/e2e/edge execute.
cp "$fc_bin" "$ARTIFACTS/firecracker-$FC_VERSION"
chmod +x "$ARTIFACTS/firecracker-$FC_VERSION"
if [ "$FC_VERSION" = v1.17.0 ]; then
  cp "$fc_bin" "$ARTIFACTS/firecracker"
  chmod +x "$ARTIFACTS/firecracker"
  verify_sha256 "$ARTIFACTS/firecracker" "$FC_BINARY_SHA256" "installed firecracker binary"
fi
verify_sha256 "$ARTIFACTS/firecracker-$FC_VERSION" "$FC_BINARY_SHA256" \
  "installed firecracker $FC_VERSION binary"

echo "== jq $JQ_VERSION"
fetch_verified \
  "https://github.com/jqlang/jq/releases/download/$JQ_VERSION/jq-linux-amd64" \
  jq "$JQ_SHA256" "jq $JQ_VERSION"

echo "== kernel + busybox"
mkdir -p "$ARTIFACTS/images/smoke/kernels"
if [ "$KERNEL" = vmlinux-6.1.155 ] &&
  [ "$KERNEL_URL" = "$KERNEL_URL_DEFAULT" ] &&
  [ "$KERNEL_SHA256" = "$KERNEL_SHA256_DEFAULT" ]; then
  # The default kernel keeps the historical cache path other harnesses read;
  # the versioned copy is what the multi-kernel vmtest matrix consumes.
  kernel_out=$ARTIFACTS/images/smoke/vmlinux
  fetch_verified "$KERNEL_URL" "$kernel_out" \
    "$KERNEL_SHA256" "kernel $KERNEL"
  cp "$kernel_out" "$ARTIFACTS/images/smoke/kernels/$KERNEL"
else
  kernel_out=$ARTIFACTS/images/smoke/kernels/$KERNEL
  fetch_verified "$KERNEL_URL" "$kernel_out" \
    "$KERNEL_SHA256" "kernel $KERNEL"
fi
verify_sha256 "$ARTIFACTS/images/smoke/kernels/$KERNEL" "$KERNEL_SHA256" \
  "installed kernel $KERNEL"
fetch_verified "$BUSYBOX_URL" "$BUSYBOX_FILE" \
  "$BUSYBOX_SHA256" "busybox 1.35.0"
[ "$(stat -c %s busybox)" -gt 500000 ] || { echo "busybox looks truncated" >&2; exit 1; }
chmod +x busybox jq

echo "== guest rootfs (real build-rootfs.sh, no root)"
rm -rf rootdir && mkdir -p rootdir/{bin,sbin,usr/bin,app,etc,www}
cp busybox rootdir/bin/busybox
for a in sh ash ip mount mkdir cat nc httpd cp chmod chown ln ls grep sed awk tr head tail printf sleep echo hostname umount \
         mknod ifconfig route wget cut id date tee test '[' env basename dirname mv rm touch kill ps od wc sort uniq xargs find; do
  ln -sf busybox "rootdir/bin/$a"
done
cp "$HERE/guest-start" rootdir/app/start && chmod +x rootdir/app/start
sh "$HERE/../guest/build-rootfs.sh" --dir rootdir --size 64M --jq jq --out "$ARTIFACTS/images/smoke/rootfs.ext4"
echo "artifacts ready in $ARTIFACTS"
