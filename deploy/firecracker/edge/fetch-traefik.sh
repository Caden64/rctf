#!/bin/bash
# Fetch the pinned Traefik release binary into ~/.cache/rctf-edge and verify its
# published SHA-256 before installing it. Nothing is written into the repo.
set -eu
VERSION=${TRAEFIK_VERSION:-3.7.15}
DEST=${XDG_CACHE_HOME:-$HOME/.cache}/rctf-edge
BASE=https://github.com/traefik/traefik/releases/download/v$VERSION
TARBALL=traefik_v${VERSION}_linux_amd64.tar.gz

command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 2; }
[ "$(uname -m)" = x86_64 ] || { echo "this pins the linux_amd64 build" >&2; exit 2; }
mkdir -p "$DEST"

if [ -x "$DEST/traefik-v$VERSION" ]; then
  echo "already present: $DEST/traefik-v$VERSION"
  "$DEST/traefik-v$VERSION" version | sed -n 's/^Version:[[:space:]]*/traefik /p'
  exit 0
fi

echo "== downloading Traefik v$VERSION"
curl -fsSL -o "$DEST/$TARBALL" "$BASE/$TARBALL"
curl -fsSL -o "$DEST/checksums.txt" "$BASE/traefik_v${VERSION}_checksums.txt"

want=$(grep " $TARBALL\$" "$DEST/checksums.txt" | cut -d' ' -f1)
[ -n "$want" ] || { echo "no checksum for $TARBALL in the published checksums file" >&2; exit 1; }
got=$(sha256sum "$DEST/$TARBALL" | cut -d' ' -f1)
[ "$got" = "$want" ] || { echo "sha256 mismatch: got $got want $want" >&2; exit 1; }

tar -xzf "$DEST/$TARBALL" -C "$DEST" traefik
mv "$DEST/traefik" "$DEST/traefik-v$VERSION"
chmod +x "$DEST/traefik-v$VERSION"
rm -f "$DEST/$TARBALL"
echo "verified sha256 $got"
"$DEST/traefik-v$VERSION" version
