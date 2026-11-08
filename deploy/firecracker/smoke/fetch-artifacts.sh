#!/bin/bash
# Download the third-party artifacts the smoke test needs and build the test guest image.
# Everything is fetched over HTTPS and every artifact is pinned to an exact version + sha256:
#   - Firecracker tarball and extracted binary: official release .sha256.txt
#   - jq: official sha256sum.txt for the pinned release
#   - kernel and busybox: no publisher checksum exists next to these binaries, so the
#     digests below were computed from the fetched bytes (trust-on-first-use); see README.md.
# Cached files are re-hashed before every use and a mismatch is fatal.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ARTIFACTS=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}

# --- pinned versions and digests -------------------------------------------
FC_VERSION=v1.17.0
FC_TARBALL_SHA256=06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558
FC_BINARY_SHA256=99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5

JQ_VERSION=jq-1.8.2
JQ_SHA256=b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f

KERNEL_FILE=vmlinux-6.1.155
KERNEL_URL=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.15/x86_64/$KERNEL_FILE
KERNEL_SHA256=e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2

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
fetch_verified "$base/firecracker-$FC_VERSION-$arch.tgz" fc.tgz \
  "$FC_TARBALL_SHA256" "firecracker $FC_VERSION tarball"
rm -rf fc-extract && mkdir -p fc-extract
tar xzf fc.tgz -C fc-extract
fc_bin="fc-extract/release-$FC_VERSION-$arch/firecracker-$FC_VERSION-$arch"
verify_sha256 "$fc_bin" "$FC_BINARY_SHA256" "firecracker $FC_VERSION binary"
cp "$fc_bin" "$ARTIFACTS/firecracker"
chmod +x "$ARTIFACTS/firecracker"
verify_sha256 "$ARTIFACTS/firecracker" "$FC_BINARY_SHA256" "installed firecracker binary"

echo "== jq $JQ_VERSION"
fetch_verified \
  "https://github.com/jqlang/jq/releases/download/$JQ_VERSION/jq-linux-amd64" \
  jq "$JQ_SHA256" "jq $JQ_VERSION"

echo "== kernel + busybox"
fetch_verified "$KERNEL_URL" "$ARTIFACTS/images/smoke/vmlinux" \
  "$KERNEL_SHA256" "kernel $KERNEL_FILE"
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
