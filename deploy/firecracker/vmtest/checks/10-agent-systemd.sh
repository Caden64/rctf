#!/usr/bin/env bash
# Check b) the shipped systemd unit starts the agent and preflight accepts in
# jailer mode. Also records the unit's CAP_SETUID problem (see repro).
. "$(dirname "$0")/lib.sh"

UNIT_SRC=$REPO/deploy/firecracker/host/rctf-firecracker-agent.service
UNIT_DST=/etc/systemd/system/rctf-firecracker-agent.service
CFG=/etc/rctf-firecracker/agent.yaml
ENVFILE=/etc/rctf-firecracker/agent.env
DROPIN=/etc/systemd/system/rctf-firecracker-agent.service.d

section "b) systemd unit + jailer-mode preflight"

# Test from the shipped unit only: remove workarounds from a previous run.
rm -rf /etc/systemd/system/rctf-firecracker-agent.service.d
install -m 0644 "$UNIT_SRC" "$UNIT_DST"
mkdir -p /etc/rctf-firecracker
cat >"$CFG" <<EOF
hostId: fcvmtest
listen: { host: 127.0.0.1, port: 7001 }
stateDir: $STATE
capacity: { vcpus: 4, memMiB: 2048, diskMiB: 4096, maxInstances: 4 }
expiryGraceSeconds: 600
vm:
  mode: jailer
  firecrackerBin: /usr/local/bin/firecracker
  jailerBin: /usr/local/bin/jailer
  imagesDir: $IMAGES
  runDir: $RUNDIR
  chrootBase: /srv/jailer
  jailUid: 10000
  jailGid: 10000
  cgroupLimits: ['pids.max=512']
network:
  publicHost: $OUT_HOST_IP
  httpDomain: fcvmtest.test
  httpPort: 80
  httpsPort: 443
  tcpSslPort: 443
  tcpPortRange: { from: 30000, to: 30010 }
  subnetPool: 10.200.0.0/16
  traefikDynamicDir: /etc/traefik/dynamic/rctf-firecracker
  externalInterface: $OUT_IF
  reuseQuarantineSeconds: 120
  requireConntrack: true
  tapUser: '10000'
  tapGroup: '10000'
EOF
printf 'FIRECRACKER_AGENT_TOKEN=%s\n' "$TOKEN" >"$ENVFILE"
chmod 0600 "$ENVFILE"

systemctl daemon-reload
systemctl enable --now rctf-firecracker-agent >/dev/null 2>&1

if wait_agent_active; then ok "agent starts under systemd (unit from deploy/firecracker/host)"; else
  bad "agent did not start under systemd"
  journalctl -u rctf-firecracker-agent --no-pager -n 40 | sed 's/^/  | /' >&2
fi

expect_eq "$(systemctl show -p KillMode --value rctf-firecracker-agent)" process \
  "unit applies KillMode=process (VMs are not in the agent's kill scope)"
expect_eq "$(systemctl show -p User --value rctf-firecracker-agent)" root \
  "unit runs as root"

if [ "$(sha256sum "$UNIT_SRC" | cut -d' ' -f1)" = "$(sha256sum "$UNIT_DST" | cut -d' ' -f1)" ]; then
  ok "installed unit is byte-identical to deploy/firecracker/host/rctf-firecracker-agent.service"
else
  bad "installed unit differs from the repository unit"
fi

INFO=$(api "$API/v1/info")
ACCEPT=$(printf '%s' "$INFO" | jq -r '.accepting')
CHECKS=$(printf '%s' "$INFO" | jq -c '.checks')
IMAGES_LIST=$(printf '%s' "$INFO" | jq -c '.images')
echo "  checks: $CHECKS"
echo "  images: $IMAGES_LIST"
expect_eq "$ACCEPT" true "preflight accepting:true in jailer mode"
for k in recovered orphanBacklog stalledOperations kvm firecrackerBin jailerBin imagesDir \
  imagesTrusted runDir cgroupRoot chrootBase apiSocketPath nft ip conntrackBin \
  ipForward traefikDirWritable quarantineWritable tcpPortRange subnetPool; do
  if [ "$(printf '%s' "$INFO" | jq -r --arg k "$k" '.checks[$k]')" = true ]; then
    ok "preflight check '$k' is true"
  else
    bad "preflight check '$k' is not true"
  fi
done
expect_eq "$(printf '%s' "$INFO" | jq -c '.images | sort')" '["smoke","vmtest"]' \
  "both test images are visible to the agent"

# ---------------------------------------------------------------------------
# The shipped unit's RestrictAddressFamilies= makes systemd (255, Ubuntu
# 24.04) drop CAP_SETUID from the effective set, so jailer's setuid(10000)
# fails with EPERM. This assertion is expected to FAIL until the unit is fixed.
# ---------------------------------------------------------------------------
CAPEFF=$(grep '^CapEff:' "/proc/$(agent_main_pid)/status" | awk '{print $2}')
if [ $((0x$CAPEFF & 0x80)) -ne 0 ]; then
  ok "agent process has CAP_SETUID effective (jailer can drop to uid 10000)"
  UNIT_CAP_BUG=0
else
  bad "agent process lacks CAP_SETUID effective under the shipped unit; jailer setuid will fail (product bug)"
  UNIT_CAP_BUG=1
fi

mkdir -p "$DROPIN"
# Test-only drop-in: restore the capability systemd dropped because of
# RestrictAddressFamilies. Everything else in the shipped unit stays active.
cat >"$DROPIN/10-vmtest-ambient.conf" <<'EOF'
[Service]
AmbientCapabilities=CAP_SETUID CAP_SETGID
EOF
systemctl daemon-reload
systemctl restart rctf-firecracker-agent
wait_agent_active || true
CAPEFF=$(grep '^CapEff:' "/proc/$(agent_main_pid)/status" | awk '{print $2}')
if [ $((0x$CAPEFF & 0x80)) -ne 0 ]; then
  ok "with the test-only AmbientCapabilities drop-in the agent can setuid to the jail uid"
else
  bad "AmbientCapabilities drop-in did not restore CAP_SETUID"
fi
expect_eq "$(api "$API/v1/info" | jq -r '.accepting')" true \
  "preflight still accepting:true after the drop-in"

echo
echo "NOTE: the as-shipped unit cannot run jailer mode on systemd 255/Ubuntu 24.04."
echo "      minimal repro: deploy/firecracker/vmtest/repros/systemd-unit-setuid.sh"
echo "      (test drop-in kept at $DROPIN/10-vmtest-ambient.conf)"
finish
