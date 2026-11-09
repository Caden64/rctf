#!/usr/bin/env bash
# Investigation/repro: Firecracker 1.17.0's --version prints an extra stdout
# log line ("... exiting successfully. exit_code=0"). The old parser
# (awk '{print $NF}') returned "1.17.0\nexit_code=0" and version_ge rejected a
# supported binary; the shipped parser takes the first x.y.z token of the first
# line. Regression coverage (rootless, fake binaries):
#   apps/firecracker-instancer/test/host-setup-version.test.ts
#
# Run as root inside the test VM:
#   sudo bash repros/host-setup-version-parse.sh
set -u

FC=${FIRECRACKER_BIN:-/usr/local/bin/firecracker}
HOSTDIR=${REPO:-/opt/rctf-firecracker}/deploy/firecracker/host

echo "== raw firecracker --version (stdout only) =="
"$FC" --version 2>/dev/null | cat -A
echo
echo "== the OLD parser (what was broken) =="
echo "binary_version() { \"\$1\" --version 2>/dev/null | awk '{print \$NF}' | sed 's/^v//'; }"
echo "parsed value:"
"$FC" --version 2>/dev/null | awk '{print $NF}' | sed 's/^v//' | cat -A
echo
echo "== the shipped parser (first line, first x.y.z token) =="
parsed=$("$FC" --version 2>/dev/null | head -n 1 | grep -m1 -Eo '[0-9]+\.[0-9]+\.[0-9]+')
echo "parsed value: '$parsed'"
if [ "$(printf '%s\n%s\n' 1.7.0 "$parsed" | sort -V | head -n 1)" = 1.7.0 ]; then
  echo "version_ge($parsed, 1.7.0): would pass"
else
  echo "version_ge($parsed, 1.7.0): FAILS"
fi
echo
echo "== host-setup.sh as shipped, rootless version probe =="
(cd "$HOSTDIR" && ./host-setup.sh --check-version-only)
echo "exit=$?"
echo
echo "== host-setup.sh as shipped, full run (needs root) =="
(cd "$HOSTDIR" && ./host-setup.sh)
echo "exit=$?"
