#!/bin/bash
# Fetch the pinned Traefik release binary into ~/.cache/rctf-edge and verify it.
#
# The expected hashes are PINNED IN THIS REPOSITORY, not read from the same
# origin as the download:
#   * PINNED_TARBALL_SHA256 is the line for
#     traefik_v3.7.15_linux_amd64.tar.gz in the official
#     traefik_v3.7.15_checksums.txt, cross-checked against the GitHub API
#     release-asset digest (api.github.com/repos/traefik/traefik/releases/
#     tags/v3.7.15 -> assets[].digest = sha256:5b9f...).
#   * PINNED_BINARY_SHA256 is the sha256 of the `traefik` member extracted from
#     that verified tarball.
# The cached binary is re-hashed on EVERY use (run.sh calls `--verify`); a
# mismatch is fatal and never silently accepted.
#
# Usage:
#   ./fetch-traefik.sh            # verify the cache, or download + verify + install
#   ./fetch-traefik.sh --verify   # verify an existing cache only (used by run.sh)
# Nothing is written into the repository.
set -eu
VERSION=${TRAEFIK_VERSION:-3.7.15}
DEST=${XDG_CACHE_HOME:-$HOME/.cache}/rctf-edge
BASE=https://github.com/traefik/traefik/releases/download/v$VERSION
TARBALL=traefik_v${VERSION}_linux_amd64.tar.gz
BIN=${TRAEFIK_BIN:-$DEST/traefik-v$VERSION}

PINNED_TARBALL_SHA256=5b9f51199fcb7a3b5f7ae0f9dae8dcf01efadafd92c5fca96ea2822eca81f8e6
PINNED_BINARY_SHA256=34bfdfa88e321ad496d829910c6145a0743eae09cdf290e3e114b137eb948e30

die() { echo "fetch-traefik: $*" >&2; exit 1; }

command -v sha256sum >/dev/null || die "sha256sum is required"
[ "$(uname -m)" = x86_64 ] || die "this pins the linux_amd64 build"
[ "$VERSION" = 3.7.15 ] ||
  die "no pinned sha256 for Traefik $VERSION in this script (only 3.7.15)"

hash_of() { sha256sum "$1" | cut -d' ' -f1; }

verify_bin() {
  [ -f "$BIN" ] || die "missing $BIN (run $0 without --verify)"
  [ -x "$BIN" ] || die "$BIN is not executable"
  got=$(hash_of "$BIN")
  [ "$got" = "$PINNED_BINARY_SHA256" ] ||
    die "cached binary sha256 mismatch: got $got want $PINNED_BINARY_SHA256 ($BIN)"
  echo "verified cached binary sha256 $got"
  "$BIN" version | sed -n 's/^Version:[[:space:]]*/traefik /p'
}

if [ "${1:-}" = --verify ]; then
  verify_bin
  exit 0
fi

if [ -e "$BIN" ]; then
  verify_bin
  exit 0
fi

mkdir -p "$DEST"
echo "== downloading Traefik v$VERSION"
curl -fsSL -o "$DEST/$TARBALL" "$BASE/$TARBALL" || die "download failed"

got=$(hash_of "$DEST/$TARBALL")
[ "$got" = "$PINNED_TARBALL_SHA256" ] ||
  die "tarball sha256 mismatch: got $got want $PINNED_TARBALL_SHA256 (repo pin)"

# Second source: the published checksums file. It must agree with the repo pin;
# a disagreement is fatal even if the tarball matched the pin.
if curl -fsSL -o "$DEST/checksums.txt" "$BASE/traefik_v${VERSION}_checksums.txt"; then
  published=$(grep " $TARBALL\$" "$DEST/checksums.txt" | cut -d' ' -f1)
  [ -n "$published" ] || die "no checksum for $TARBALL in the published checksums file"
  [ "$published" = "$PINNED_TARBALL_SHA256" ] ||
    die "published checksum $published disagrees with the repo pin $PINNED_TARBALL_SHA256"
  echo "published checksums file agrees with the repo pin"
else
  echo "warning: could not download the published checksums file; the repo pin is authoritative" >&2
fi

tmp=$(mktemp -d "$DEST/.extract.XXXXXX")
trap 'rm -rf "$tmp" "$DEST/$TARBALL"' EXIT
tar -xzf "$DEST/$TARBALL" -C "$tmp" traefik || die "could not extract traefik from the tarball"
gotbin=$(hash_of "$tmp/traefik")
[ "$gotbin" = "$PINNED_BINARY_SHA256" ] ||
  die "extracted binary sha256 mismatch: got $gotbin want $PINNED_BINARY_SHA256"
chmod +x "$tmp/traefik"
mv "$tmp/traefik" "$BIN"
rm -f "$DEST/$TARBALL"
trap - EXIT
rm -rf "$tmp"
verify_bin
