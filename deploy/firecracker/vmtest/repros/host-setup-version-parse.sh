#!/usr/bin/env bash
# Minimal repro: host-setup.sh rejects Firecracker 1.17.0 because --version
# prints an extra stdout log line and binary_version() keeps every line.
#
# Run as root inside the test VM (after vm.sh create + provisioning):
#   sudo bash repros/host-setup-version-parse.sh
set -u

FC=${FIRECRACKER_BIN:-/usr/local/bin/firecracker}
HOSTDIR=${REPO:-/opt/rctf-firecracker}/deploy/firecracker/host

echo "== raw firecracker --version (stdout only) =="
"$FC" --version 2>/dev/null | cat -A
echo
echo "== the parser used by host-setup.sh =="
echo "binary_version() { \"\$1\" --version 2>/dev/null | awk '{print \$NF}' | sed 's/^v//'; }"
echo "parsed value:"
"$FC" --version 2>/dev/null | awk '{print $NF}' | sed 's/^v//' | cat -A
echo
echo "== version_ge(parsed, 1.7.0) result =="
parsed=$("$FC" --version 2>/dev/null | awk '{print $NF}' | sed 's/^v//')
if [ "$(printf '%s\n%s\n' 1.7.0 "$parsed" | sort -V | head -n 1)" = 1.7.0 ]; then
  echo "would pass"
else
  echo "FAILS (the second line makes the comparison false)"
fi
echo
echo "== host-setup.sh as shipped =="
(cd "$HOSTDIR" && ./host-setup.sh)
echo "exit=$?"
