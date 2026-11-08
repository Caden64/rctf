#!/bin/bash
# Download the third-party artifacts the smoke test needs and build the test guest image.
# Everything is fetched over HTTPS; Firecracker and jq are verified against their published SHA-256 files.
# busybox (static) and the CI kernel have no published checksum next to the binary, so they are only
# size-checked; they run exclusively inside the sandboxed guest.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ARTIFACTS=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
FC_VERSION=${FC_VERSION:-v1.17.0}
KERNEL_URL=${KERNEL_URL:-https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.15/x86_64/vmlinux-6.1.155}
BUSYBOX_URL=${BUSYBOX_URL:-https://busybox.net/downloads/binaries/1.35.0-x86_64-linux-musl/busybox}
arch=$(uname -m); [ "$arch" = x86_64 ] || { echo "this script fetches x86_64 artifacts" >&2; exit 2; }
mkdir -p "$ARTIFACTS/dl" "$ARTIFACTS/images/smoke"
cd "$ARTIFACTS/dl"

echo "== firecracker $FC_VERSION"
base=https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION
curl -fsSL -o fc.tgz "$base/firecracker-$FC_VERSION-$arch.tgz"
curl -fsSL -o fc.sha256 "$base/firecracker-$FC_VERSION-$arch.tgz.sha256.txt"
[ "$(sha256sum fc.tgz | cut -d' ' -f1)" = "$(cut -d' ' -f1 fc.sha256)" ] || { echo "firecracker checksum mismatch" >&2; exit 1; }
mkdir -p fc-extract && tar xzf fc.tgz -C fc-extract
cp "fc-extract/release-$FC_VERSION-$arch/firecracker-$FC_VERSION-$arch" "$ARTIFACTS/firecracker"
chmod +x "$ARTIFACTS/firecracker"

echo "== jq"
jqv=$(curl -fsSL https://api.github.com/repos/jqlang/jq/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
curl -fsSL -o jq "https://github.com/jqlang/jq/releases/download/$jqv/jq-linux-amd64"
curl -fsSL -o jq.sha256 "https://github.com/jqlang/jq/releases/download/$jqv/sha256sum.txt"
want=$(grep ' jq-linux-amd64$' jq.sha256 | cut -d' ' -f1)
[ "$(sha256sum jq | cut -d' ' -f1)" = "$want" ] || { echo "jq checksum mismatch" >&2; exit 1; }

echo "== kernel + busybox"
curl -fsSL -o "$ARTIFACTS/images/smoke/vmlinux" "$KERNEL_URL"
curl -fsSL -o busybox "$BUSYBOX_URL"
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
