#!/usr/bin/env bash
# Shared constants and helpers for the PHP2Shell training lab.
#
# Everything here is unprivileged on the host. Privileged operations happen
# only inside the throwaway vmtest QEMU VM (see ../vmtest/README.md).
set -uo pipefail

LAB_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
FC_DIR=$(cd -- "$LAB_DIR/../.." && pwd)
REPO=$(cd -- "$FC_DIR/../.." && pwd)
SMOKE_DIR=$FC_DIR/smoke
VMTEST_DIR=$FC_DIR/vmtest

# Shared cache. The build and the vmtest artifacts are separate subtrees so
# that a lab build never deletes or rewrites another worker's cache.
CACHE=${P2S_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-p2s-lab}
SMOKE_ARTIFACTS=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
DL=$CACHE/dl
IMAGES=$CACHE/images
WORK=$CACHE/work
TOOLKIT=$CACHE/toolkit
UPSTREAM=$CACHE/upstream
UPSTREAM_LEGACY=$CACHE/upstream-legacy
LOGS=$CACHE/logs

# ---------------------------------------------------------------------------
# Pinned versions and digests. Every download is checked against the pinned
# digest BEFORE it is used. See README.md for provenance and the
# trust-on-first-use note in fetch.sh.
# ---------------------------------------------------------------------------
PHP_VULN=8.4.26
PHP_VULN_SHA256=c248abaebc4bb777b80968f0760da0da8e989836e896c9ff637b6775d7d37662
PHP_FIXED=8.4.27
PHP_FIXED_SHA256=5bafed9994c1a49796b25b5f61c22c9183bfe046b6acc7b363842d03c77f972f
HTTPD_VERSION=2.4.69
HTTPD_SHA256=c551b9861e26f146f57e1b1765e69c89a60b3db0ec252ccab0d36283487016bb
UBUNTU_BASE=24.04.5
UBUNTU_BASE_SHA256=e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86

PHP_VULN_URL=https://www.php.net/distributions/php-$PHP_VULN.tar.gz
PHP_FIXED_URL=https://www.php.net/distributions/php-$PHP_FIXED.tar.gz
# downloads.apache.org only keeps current releases; the pinned release is
# fetched from the official Apache archive instead (same bytes, pinned digest).
HTTPD_URL=https://archive.apache.org/dist/httpd/httpd-$HTTPD_VERSION.tar.gz
UBUNTU_BASE_URL=https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-$UBUNTU_BASE-base-amd64.tar.gz

TOOLKIT_URL=https://github.com/devploit/php2shell.git
TOOLKIT_PIN=2479e2dd95c64fd9a8bf83f9f482c17e2cbc987b
UPSTREAM_URL=https://github.com/9bie/php2shell-bypass-aslr-exp.git
# d6f888e is the pinned upstream checkout. Its root exploit.py is a different
# (128M/display_errors=Off) research chain; the verified 8M Apache chain the
# toolkit orchestrates lives in archive/legacy-8m/exploit.py in the same
# checkout. build/fetch promote that file into a run-time staging copy.
UPSTREAM_PIN=d6f888ebd3f0e188bb662e16f23747afdf35e42f

# Stage-3 and leak parameters are loaded by run.sh from the calibration
# profile (calibration/php-8.4.26-apache-trixie.json) with P2S_STAGE1_N /
# P2S_FORGE_LEN / P2S_STAGE2_T / P2S_STAGE2_V / P2S_STAGE3_HTDATA /
# P2S_STAGE3_PADS overrides. Nothing here hard-codes a stage-3 layout: an
# uncalibrated checkout must not pretend the RCE is proven.
P2S_CHAIN_RETRIES=${P2S_CHAIN_RETRIES:-1}

log() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

mkdir -p "$CACHE" "$DL" "$IMAGES" "$WORK" "$LOGS" 2>/dev/null || true

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

# verify_sha256 <file> <expected> <label>; returns 1 on mismatch (callers decide)
verify_sha256() {
  local file=$1 want=$2 label=$3 got
  [ -f "$file" ] || {
    printf 'ERROR: %s is missing at %s\n' "$label" "$file" >&2
    return 1
  }
  got=$(sha256_of "$file")
  [ "$got" = "$want" ] || {
    printf 'ERROR: %s digest mismatch: got %s, want %s (refusing to use it)\n' \
      "$label" "$got" "$want" >&2
    return 1
  }
  printf '%s\n' "$got"
}

# download_pinned <url> <dest> <sha256> <label>
download_pinned() {
  local url=$1 dest=$2 want=$3 label=$4 tmp
  if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$want" ]; then
    return 0
  fi
  rm -f "$dest"
  tmp=$dest.part.$$
  log "downloading $label"
  curl -fL --retry 3 --connect-timeout 20 -o "$tmp" "$url" ||
    { rm -f "$tmp"; die "could not download $label from $url"; }
  verify_sha256 "$tmp" "$want" "$label" >/dev/null || { rm -f "$tmp"; exit 1; }
  mv "$tmp" "$dest"
}

# ensure_kernel_and_firecracker: the guest kernel/firecracker/jailer are shared
# with the smoke harness and are fetched under its flock.
ensure_smoke_artifacts() {
  local fc=$SMOKE_ARTIFACTS/dl/fc-extract/release-v1.17.0-x86_64
  if [ -x "$SMOKE_ARTIFACTS/firecracker" ] &&
    [ -x "$fc/jailer-v1.17.0-x86_64" ] &&
    [ -f "$SMOKE_ARTIFACTS/images/smoke/vmlinux" ] &&
    [ -x "$SMOKE_ARTIFACTS/dl/jq" ] &&
    [ -d "$SMOKE_ARTIFACTS/dl/rootdir" ]; then
    return 0
  fi
  log "shared Firecracker artifacts missing; fetching with the smoke harness"
  mkdir -p "$SMOKE_ARTIFACTS"
  (
    flock 9
    "$SMOKE_DIR/fetch-artifacts.sh"
  ) 9>"$SMOKE_ARTIFACTS/.fetch.lock" || return 1
}

# read_offsets <image-dir>: sets ZIF_OFFSET and DTOR_OFFSET; returns 1 on error.
read_offsets() {
  local dir=$1
  [ -f "$dir/offsets.env" ] || {
    printf 'ERROR: missing %s/offsets.env\n' "$dir" >&2
    return 1
  }
  # shellcheck disable=SC1090
  . "$dir/offsets.env"
  [ -n "${ZIF_OFFSET:-}" ] && [ -n "${DTOR_OFFSET:-}" ] || {
    printf 'ERROR: %s/offsets.env must define ZIF_OFFSET and DTOR_OFFSET\n' "$dir" >&2
    return 1
  }
  case "$ZIF_OFFSET$DTOR_OFFSET" in
    *[!0-9a-fA-Fx]*)
      printf 'ERROR: offsets must be hexadecimal (got %s/%s)\n' "$ZIF_OFFSET" "$DTOR_OFFSET" >&2
      return 1
      ;;
  esac
  return 0
}

# proof_is_web_uid <text>: true when a command proof shows the web worker uid.
# The Apache worker is www-data (uid 33) on Debian/Ubuntu.
proof_is_web_uid() {
  printf '%s' "$1" | grep -Eq 'uid=33\(www-data\)'
}

# free_port <start> <end>: print the first TCP port that can be bound on
# 127.0.0.1 right now. The probe binds and releases the socket; a race with
# another process remains between the release and the consumer's bind, which
# is why the runner allocates its ports with free_tcp_set (all at once) instead
# of calling this in a check-then-use loop. Kept for the self-test.
free_port() {
  local p=$1 end=$2
  while [ "$p" -le "$end" ]; do
    if python3 - "$p" <<'PY'
import socket, sys
s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
PY
    then
      printf '%s\n' "$p"
      return 0
    fi
    p=$((p + 1))
  done
  return 1
}

# free_tcp_set <count> [excluded-port...]: allocate <count> TCP ports on
# 127.0.0.1 by binding every socket BEFORE releasing any, so the ports are
# distinct from each other by construction (independent bind(0) calls can hand
# the same ephemeral port to two sockets). Ports in the exclusion list -- the
# vmtest defaults 2422/8201 and any port the caller already fixed -- are
# rejected and the whole set is re-drawn. A residual window remains between the
# release here and each consumer's bind; a lost race is a loud consumer
# failure (QEMU hostfwd / seed bind), never a silent one. Prints the ports on
# one line, space separated.
free_tcp_set() {
  local count=$1
  shift
  python3 - "$count" "$@" <<'PY'
import socket, sys

count = int(sys.argv[1])
excluded = {int(p) for p in sys.argv[2:]}
reserved = {2422, 8201}  # vmtest's fixed defaults; never auto-allocate them

for _ in range(64):
    socks = [socket.socket() for _ in range(count)]
    try:
        for s in socks:
            s.bind(("127.0.0.1", 0))
        ports = [s.getsockname()[1] for s in socks]
    finally:
        for s in socks:
            s.close()
    if len(set(ports)) != count:
        continue
    if set(ports) & (excluded | reserved):
        continue
    print(" ".join(str(p) for p in ports))
    sys.exit(0)
sys.exit(1)
PY
}
