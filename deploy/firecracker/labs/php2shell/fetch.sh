#!/usr/bin/env bash
#
# Fetch the pinned artifacts for the PHP2Shell training lab.
#
# Integrity model
# ---------------
# * PHP and Apache tarballs are checked against the official SHA-256 digests
#   pinned in lib.sh (php.net publishes them on the release page; Apache
#   publishes the .sha256 next to the archive).
# * The Ubuntu base rootfs is checked against the digest pinned from
#   cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/SHA256SUMS.
# * The toolkit and the upstream research checkout are pinned by git commit
#   and verified with `git rev-parse HEAD`. They are NOT vendored into this
#   repository.
#
# Trust-on-first-use note: the pinned digests were recorded when this lab was
# written (2026-11). They are the authority here: a changed upstream file is a
# hard failure, not a prompt to update. If a pinned URL disappears (Apache
# removes old releases from downloads.apache.org) the archive URL is used and
# the same pinned digest still applies. Re-pinning is a reviewed change, never
# an automatic one.
set -euo pipefail
. "$(dirname -- "$0")/lib.sh"

log "cache: $CACHE"

download_pinned "$PHP_VULN_URL" "$DL/php-$PHP_VULN.tar.gz" "$PHP_VULN_SHA256" \
  "PHP $PHP_VULN source tarball"
download_pinned "$PHP_FIXED_URL" "$DL/php-$PHP_FIXED.tar.gz" "$PHP_FIXED_SHA256" \
  "PHP $PHP_FIXED source tarball (fixed control)"
download_pinned "$HTTPD_URL" "$DL/httpd-$HTTPD_VERSION.tar.gz" "$HTTPD_SHA256" \
  "Apache httpd $HTTPD_VERSION source tarball"
download_pinned "$UBUNTU_BASE_URL" "$DL/ubuntu-base-$UBUNTU_BASE-base-amd64.tar.gz" \
  "$UBUNTU_BASE_SHA256" "Ubuntu $UBUNTU_BASE base rootfs"

fetch_git_pin() { # fetch_git_pin <dir> <url> <pin> <label>
  local dir=$1 url=$2 pin=$3 label=$4 head
  if [ ! -d "$dir/.git" ]; then
    log "cloning $label"
    rm -rf "$dir"
    git clone -q "$url" "$dir" || die "could not clone $label from $url"
  fi
  if ! git -C "$dir" cat-file -e "$pin^{commit}" 2>/dev/null; then
    log "fetching $label commit $pin"
    git -C "$dir" fetch -q origin "$pin" 2>/dev/null ||
      git -C "$dir" fetch -q --tags origin || die "could not fetch $label"
  fi
  git -C "$dir" checkout -q "$pin" || die "could not check out $label at $pin"
  head=$(git -C "$dir" rev-parse HEAD)
  [ "$head" = "$pin" ] ||
    die "$label is at $head, pinned $pin (refusing to use a moving checkout)"
  printf '%s\n' "$head"
}

fetch_git_pin "$TOOLKIT" "$TOOLKIT_URL" "$TOOLKIT_PIN" "devploit/php2shell toolkit"
fetch_git_pin "$UPSTREAM" "$UPSTREAM_URL" "$UPSTREAM_PIN" "9bie/php2shell-bypass-aslr-exp"

# The toolkit's launcher expects <repo>/exploit.py with the 8M Apache chain
# interface. In the pinned upstream checkout that exact generation is kept at
# archive/legacy-8m/exploit.py (the root exploit.py is the later pure
# 128M/display_errors=Off research chain). Stage the legacy file into a
# run-time directory; the toolkit's own patcher then operates on it exactly as
# it does on its own pinned checkout.
LEGACY=$UPSTREAM/archive/legacy-8m/exploit.py
[ -f "$LEGACY" ] || die "pinned upstream has no archive/legacy-8m/exploit.py"
rm -rf "$UPSTREAM_LEGACY"
mkdir -p "$UPSTREAM_LEGACY"
cp "$LEGACY" "$UPSTREAM_LEGACY/exploit.py"
chmod 0755 "$UPSTREAM_LEGACY/exploit.py"

# Record provenance for RESULTS.md / the runner.
cat >"$CACHE/pins.env" <<EOF
php_vuln=$PHP_VULN
php_vuln_sha256=$PHP_VULN_SHA256
php_fixed=$PHP_FIXED
php_fixed_sha256=$PHP_FIXED_SHA256
httpd=$HTTPD_VERSION
httpd_sha256=$HTTPD_SHA256
ubuntu_base=$UBUNTU_BASE
ubuntu_base_sha256=$UBUNTU_BASE_SHA256
toolkit_commit=$TOOLKIT_PIN
upstream_commit=$UPSTREAM_PIN
upstream_legacy_exploit_sha256=$(sha256_of "$UPSTREAM_LEGACY/exploit.py")
EOF

log "pinned artifacts verified in $DL"
log "toolkit $TOOLKIT_PIN, upstream $UPSTREAM_PIN (legacy 8M chain staged)"
