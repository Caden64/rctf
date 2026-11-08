#!/usr/bin/env bash
# Check a) host-setup.sh on a fresh distro (Ubuntu 24.04 cloud image).
#
# Expects a FRESH host: no /var/lib/rctf-firecracker, no /srv/jailer. The
# harness runs the shipped script unmodified (no version wrapper, no drop-in)
# and asserts its real behaviour, including the Firecracker 1.17 version parse.
. "$(dirname "$0")/lib.sh"

HOSTDIR=$REPO/deploy/firecracker/host
SETUP_LOG=/tmp/vmtest-host-setup.log

section "a) host-setup.sh on a fresh Ubuntu 24.04 host"

# --- clean slate (the VM was created for this run) --------------------------
systemctl stop rctf-firecracker-agent >/dev/null 2>&1 || true
systemctl disable rctf-firecracker-agent >/dev/null 2>&1 || true
rm -rf /var/lib/rctf-firecracker /srv/jailer /etc/traefik/dynamic/rctf-firecracker \
  /etc/rctf-firecracker /etc/sysctl.d/90-rctf-firecracker.conf
sysctl -qw net.ipv4.ip_forward=0 2>/dev/null || true

# --- 1. run it exactly as shipped ------------------------------------------
set +e
(cd "$HOSTDIR" && ./host-setup.sh) >"$SETUP_LOG" 2>&1
SHIPPED_CODE=$?
set +e
echo "  (as shipped: exit $SHIPPED_CODE)"
sed -n '1,20p' "$SETUP_LOG" | sed 's/^/  | /'

if [ "$SHIPPED_CODE" -eq 0 ]; then
  ok "host-setup.sh runs clean on a fresh host as shipped"
else
  bad "host-setup.sh fails on a fresh host as shipped (exit $SHIPPED_CODE): $(grep -m1 'ERROR' "$SETUP_LOG" || true)"
fi

# --- 2. version parsing, FC 1.17.0 ----------------------------------------
# Firecracker 1.17.0 prints an extra stdout line after the banner; the parser
# must keep only the first x.y.z token. The rootless hook exercises exactly the
# shipped parser/comparison (the fake-binary unit test lives in
# apps/firecracker-instancer/test/host-setup-version.test.ts).
RAW_VERSION=$(/usr/local/bin/firecracker --version 2>/dev/null)
if printf '%s\n' "$RAW_VERSION" | grep -q 'exiting successfully'; then
  ok "Firecracker 1.17.0 still prints an extra stdout line on --version"
else
  bad "Firecracker --version output did not show the expected extra line"
fi
set +e
VPROBE=$(cd "$HOSTDIR" && ./host-setup.sh --check-version-only 2>&1)
VPROBE_CODE=$?
set +e
echo "  (--check-version-only: exit $VPROBE_CODE)"
printf '%s\n' "$VPROBE" | sed 's/^/  | /'
expect_eq "$VPROBE_CODE" 0 "--check-version-only succeeds as shipped"
expect_eq "$(printf '%s\n' "$VPROBE" | sed -n '1p')" "firecracker 1.17.0" \
  "the extra exit_code log line is not part of the parsed version"
expect_eq "$(printf '%s\n' "$VPROBE" | sed -n '2p')" "jailer 1.17.0" \
  "the jailer version is parsed the same way"

# --- 4. installed state ----------------------------------------------------
for spec in \
  "/var/lib/rctf-firecracker:755" \
  "/var/lib/rctf-firecracker/state:700" \
  "/var/lib/rctf-firecracker/run:700" \
  "/var/lib/rctf-firecracker/images:755" \
  "/srv/jailer:700" \
  "/etc/traefik/dynamic/rctf-firecracker:755" \
  "/etc/rctf-firecracker:755"; do
  path=${spec%:*}
  want=${spec##*:}
  if [ -d "$path" ]; then
    got=$(stat -c '%a' "$path")
    expect_eq "$got" "$want" "$path exists with mode $want"
  else
    bad "$path missing"
  fi
done

if [ -f /etc/sysctl.d/90-rctf-firecracker.conf ]; then
  ok "/etc/sysctl.d/90-rctf-firecracker.conf installed"
else
  bad "/etc/sysctl.d/90-rctf-firecracker.conf missing"
fi
expect_eq "$(sysctl -n net.ipv4.ip_forward)" 1 "net.ipv4.ip_forward=1 applied"
expect_eq "$(sysctl -n net.ipv4.conf.all.rp_filter)" 1 "net.ipv4.conf.all.rp_filter=1 applied"

# --- 5. idempotent rerun ---------------------------------------------------
before=$(stat -c '%a %U %G' /var/lib/rctf-firecracker/state /srv/jailer /var/lib/rctf-firecracker/images)
set +e
(cd "$HOSTDIR" && ./host-setup.sh) >"$SETUP_LOG" 2>&1
RERUN_CODE=$?
set +e
after=$(stat -c '%a %U %G' /var/lib/rctf-firecracker/state /srv/jailer /var/lib/rctf-firecracker/images)
expect_eq "$RERUN_CODE" 0 "host-setup.sh rerun exits 0 (idempotent)"
expect_eq "$after" "$before" "directory modes/owners unchanged by the rerun"
expect_eq "$(sysctl -n net.ipv4.ip_forward)" 1 "ip_forward still 1 after rerun"

# --- provisioning for later checks (not assertions) ------------------------
mkdir -p "$IMAGES/smoke" "$IMAGES/vmtest"
install -m 0644 /tmp/fc-vmtest/artifacts/vmlinux "$IMAGES/smoke/vmlinux"
install -m 0644 /tmp/fc-vmtest/artifacts/rootfs-smoke.ext4 "$IMAGES/smoke/rootfs.ext4"
install -m 0644 /tmp/fc-vmtest/artifacts/vmlinux "$IMAGES/vmtest/vmlinux"
install -m 0644 /tmp/fc-vmtest/artifacts/vmtest-rootfs.ext4 "$IMAGES/vmtest/rootfs.ext4"
chmod 0755 "$IMAGES" "$IMAGES/smoke" "$IMAGES/vmtest"

echo
echo "NOTE: version parsing regression coverage:"
echo "      apps/firecracker-instancer/test/host-setup-version.test.ts (rootless fakes)"
echo "      deploy/firecracker/vmtest/repros/host-setup-version-parse.sh (old-parser repro)"
finish
