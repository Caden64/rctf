#!/bin/bash
# Mutation sanity check for the absence probes used by the e2e driver.
#
# It proves that the tap/nft probes throw when their commands fail and that the
# live calibration fails in a netns with no taps. Run this before/alongside the
# full harness; it needs no KVM and doesn't touch any run directory.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
export PATH="$HOME/.local/bin:$PATH"
export NO_PROXY='*'
export no_proxy='*'

command -v bun >/dev/null || {
  echo "bun is required on PATH (export PATH=\$HOME/.local/bin:\$PATH)" >&2
  exit 2
}
command -v unshare >/dev/null || { echo "unshare is required" >&2; exit 2; }
command -v ip >/dev/null || { echo "ip is required" >&2; exit 2; }

exec unshare -Urn bun "$HERE/selftest.ts"
