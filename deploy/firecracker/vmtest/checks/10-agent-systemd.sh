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

# Informational: the preflight below requires /dev/kvm to be a character
# device readable/writable by the agent. Record what the host view is.
echo "  /dev/kvm: $(stat -c '%F %a %U:%G' /dev/kvm 2>&1) access=$(python3 -c 'import os; print(os.access("/dev/kvm", os.R_OK | os.W_OK))' 2>&1)"

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
systemctl enable rctf-firecracker-agent >/dev/null 2>&1
# Restart explicitly: `enable --now` does not replace an already-running agent,
# and the capability assertions below must observe THIS unit file.
systemctl restart rctf-firecracker-agent

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
# The jailer forks and setuid/setgid()s to jailUid/jailGid (10000) before it
# execs Firecracker. The shipped unit must deliver CAP_SETUID to the agent's
# effective set with NO test-only drop-in (systemd 255 + NoNewPrivileges + a
# seccomp filter drops exactly CAP_SETUID; see the unit's comment and
# repros/systemd-unit-setuid.sh). CAP_SETGID is already effective and stays in
# the bounding set.
# ---------------------------------------------------------------------------
if [ -d "$DROPIN" ] && [ -n "$(ls -A "$DROPIN" 2>/dev/null)" ]; then
  bad "test-only systemd drop-in is still installed ($(ls "$DROPIN"))"
else
  ok "no systemd drop-in: the agent runs from the shipped unit alone"
fi
expect_eq "$(systemctl show -p AmbientCapabilities --value rctf-firecracker-agent | tr ' ' '\n' | sort | tr '\n' ' ')" \
  "cap_setuid " \
  "shipped unit applies AmbientCapabilities=CAP_SETUID only"
AGENTPID=$(agent_main_pid)
CAPEFF=$(cap_field "$AGENTPID" CapEff)
CAPBND=$(cap_field "$AGENTPID" CapBnd)
echo "  CapEff: $CAPEFF"
echo "  CapBnd: $CAPBND"
if [ $((0x$CAPEFF & 0x80)) -ne 0 ] && [ $((0x$CAPEFF & 0x40)) -ne 0 ]; then
  ok "agent process has CAP_SETUID+CAP_SETGID effective (jailer can drop to uid 10000)"
else
  bad "agent process lacks CAP_SETUID/CAP_SETGID effective under the shipped unit; jailer setuid will fail"
fi
assert_agent_caps "$AGENTPID" "shipped unit"
expect_eq "$(api "$API/v1/info" | jq -r '.accepting')" true \
  "preflight accepting:true with no drop-in"

echo
echo "NOTE: the shipped unit keeps RestrictAddressFamilies= and restores the one"
echo "      measured-missing capability (CAP_SETUID) via AmbientCapabilities=."
echo "      minimal repro/experiment: deploy/firecracker/vmtest/repros/systemd-unit-setuid.sh"
finish
