#!/usr/bin/env bash
# Check a) host-setup.sh on a fresh distro (Ubuntu 24.04 cloud image).
#
# Expects a FRESH host: no /var/lib/rctf-firecracker, no /srv/jailer. The
# harness intentionally runs the shipped script unmodified first and records
# the real result before using a documented workaround to continue.
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

# --- 2. identify the cause (version parsing, FC 1.17.0) --------------------
RAW_VERSION=$(/usr/local/bin/firecracker --version 2>/dev/null)
PARSED=$(/usr/local/bin/firecracker --version 2>/dev/null | awk '{print $NF}')
if printf '%s\n' "$RAW_VERSION" | grep -q 'exiting successfully'; then
  ok "Firecracker 1.17.0 prints an extra stdout line on --version (the cause)"
else
  bad "Firecracker --version output did not show the expected extra line"
fi
if printf '%s\n' "$PARSED" | grep -q 'exit_code='; then
  ok "host-setup's 'awk {print \$NF}' captures the log line too, making version_ge fail"
else
  bad "version parsing unexpectedly produced a single clean version: '$PARSED'"
fi

# --- 3. documented workaround: filter --version through a wrapper ----------
cat >/tmp/fc-version-wrapper <<'EOF'
#!/bin/sh
# TEST-ONLY wrapper. Firecracker 1.17.0 logs "Firecracker exiting successfully.
# exit_code=0" on stdout after --version, which host-setup.sh's version parser
# mistakes for part of the version. This wrapper only filters that output.
if [ "$1" = "--version" ]; then
  /usr/local/bin/firecracker --version | head -n 1
  exit 0
fi
exec /usr/local/bin/firecracker "$@"
EOF
chmod 0755 /tmp/fc-version-wrapper

set +e
(cd "$HOSTDIR" && FIRECRACKER_BIN=/tmp/fc-version-wrapper ./host-setup.sh) \
  >"$SETUP_LOG" 2>&1
WORK_CODE=$?
set +e
echo "  (with version-filter wrapper: exit $WORK_CODE)"
sed -n '1,18p' "$SETUP_LOG" | sed 's/^/  | /'
expect_eq "$WORK_CODE" 0 "host-setup.sh completes once version parsing is worked around"

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
(cd "$HOSTDIR" && FIRECRACKER_BIN=/tmp/fc-version-wrapper ./host-setup.sh) \
  >"$SETUP_LOG" 2>&1
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
echo "NOTE: the as-shipped failure is a product bug; minimal repro:"
echo "      deploy/firecracker/vmtest/repros/host-setup-version-parse.sh"
finish
