#!/usr/bin/env bash
#
# Provision one multi-host test VM. Runs as root INSIDE the VM, after run.sh
# has copied the repo to /tmp/fc-mh-repo, the artifacts to /tmp/fc-mh-artifacts
# and the per-run secrets to /tmp/fc-mh/secrets.env.
#
# Installs the real agent under its shipped systemd unit in JAILER mode, and
# (on host-a only) the controller config used by the driver. Idempotent per VM
# boot; on re-provision it deliberately wipes agent/controller state so a run
# starts clean.
#
# Usage (inside the VM): provision-host.sh <name> <private-ip> <controller|agent>
set -euo pipefail

NAME=${1:?name}
PRIV_IP=${2:?private ip}
ROLE=${3:?role: controller|agent}

REPO_SRC=/tmp/fc-mh-repo
ART=/tmp/fc-mh-artifacts
SECRETS=/tmp/fc-mh/secrets.env
REPO=/opt/rctf-firecracker
BUN_BIN=/usr/local/bin/bun
export DEBIAN_FRONTEND=noninteractive

log() { printf '==> [%s] %s\n' "$NAME" "$*"; }
die() {
  printf 'provision-host(%s): %s\n' "$NAME" "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "must run as root"
[ -f "$REPO_SRC/package.json" ] || die "checkout missing at $REPO_SRC"
[ -x "$ART/firecracker" ] || die "firecracker artifact missing"
[ -x "$ART/jailer" ] || die "jailer artifact missing"
[ -x "$ART/bun" ] || die "bun artifact missing"
[ -f "$SECRETS" ] || die "secrets missing at $SECRETS"

# shellcheck disable=SC1091
. "$SECRETS"
if [ "$ROLE" = controller ]; then
  TOKEN=${MH_AGENT_TOKEN_A:?}
  TCP_FROM=20000
else
  case "$NAME" in
    host-a)
      TOKEN=${MH_AGENT_TOKEN_A:?}
      TCP_FROM=20000
      ;;
    host-b)
      TOKEN=${MH_AGENT_TOKEN_B:?}
      TCP_FROM=21000
      ;;
    *) die "unknown host name $NAME" ;;
  esac
fi

log "checking private L2 address and interface"
ip -4 -o addr show | grep -Fq "$PRIV_IP/" ||
  die "no interface has $PRIV_IP; the private L2 setup failed"
# The controller talks to the agents over this same L2, and the public
# host:port endpoints are on it too, so the agent's external interface must be
# the private NIC (the DNAT rules are scoped to iifname externalInterface).
PRIV_IF=$(ip -4 -o addr show | awk -v ip="$PRIV_IP/" 'index($4, ip) == 1 {gsub(":", "", $2); print $2; exit}')
[ -n "$PRIV_IF" ] || die "could not determine the interface with $PRIV_IP"
log "private interface: $PRIV_IF"

log "installing packages"
apt-get update -q
apt-get install -y -q --no-install-recommends \
  nftables conntrack jq netcat-openbsd curl iproute2 e2fsprogs unzip tar \
  ca-certificates psmisc procps python3 >/dev/null

log "installing bun"
install -m 0755 "$ART/bun" "$BUN_BIN"
"$BUN_BIN" --version

log "installing firecracker + jailer into /usr/local/bin"
install -m 0755 "$ART/firecracker" /usr/local/bin/firecracker
install -m 0755 "$ART/jailer" /usr/local/bin/jailer

log "checkout to $REPO"
rm -rf "$REPO"
mkdir -p "$REPO"
cp -a "$REPO_SRC/." "$REPO/"
chown -R ubuntu:ubuntu "$REPO"
su -s /bin/bash ubuntu -c "cd '$REPO' && '$BUN_BIN' install --frozen-lockfile"
chmod -R a+rX "$REPO"

log "wiping any previous agent/controller state for a clean run"
systemctl stop rctf-firecracker-agent >/dev/null 2>&1 || true
systemctl disable rctf-firecracker-agent >/dev/null 2>&1 || true
rm -rf /var/lib/rctf-firecracker /srv/jailer/* /home/ubuntu/mh-controller
mkdir -p /srv/jailer
nft delete table inet rctf_fc >/dev/null 2>&1 || true
nft delete table arp rctf_fc_arp >/dev/null 2>&1 || true
for tap in $(ip -o link show type tun 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1); do
  ip link del "$tap" >/dev/null 2>&1 || true
done

# Clock changes for the skew check must stick.
systemctl disable --now systemd-timesyncd >/dev/null 2>&1 || true
systemctl disable --now chrony chronyd >/dev/null 2>&1 || true
timedatectl set-ntp false >/dev/null 2>&1 || true

log "running the shipped host-setup.sh"
(cd "$REPO/deploy/firecracker/host" && ./host-setup.sh) >"/tmp/mh-host-setup.log" 2>&1 ||
  {
    tail -30 /tmp/mh-host-setup.log >&2
    die "host-setup.sh failed"
  }

IMAGES=/var/lib/rctf-firecracker/images
install -d -m 0755 "$IMAGES/smoke"
install -m 0644 "$ART/vmlinux" "$IMAGES/smoke/vmlinux"
install -m 0644 "$ART/rootfs-smoke.ext4" "$IMAGES/smoke/rootfs.ext4"

log "installing the shipped agent unit and jailer-mode config"
install -m 0644 "$REPO/deploy/firecracker/host/rctf-firecracker-agent.service" \
  /etc/systemd/system/rctf-firecracker-agent.service
mkdir -p /etc/rctf-firecracker
cat >/etc/rctf-firecracker/agent.yaml <<EOF
hostId: $NAME
listen: { host: $PRIV_IP, port: 7001 }
stateDir: /var/lib/rctf-firecracker/state
capacity: { vcpus: 8, memMiB: 4096, diskMiB: 20000, maxInstances: 2 }
expiryGraceSeconds: 10
tombstoneTtlSeconds: 86400
vm:
  mode: jailer
  firecrackerBin: /usr/local/bin/firecracker
  jailerBin: /usr/local/bin/jailer
  imagesDir: $IMAGES
  runDir: /var/lib/rctf-firecracker/run
  chrootBase: /srv/jailer
  jailUid: 10000
  jailGid: 10000
  cgroupLimits: ['pids.max=512']
network:
  publicHost: $PRIV_IP
  httpDomain: $NAME.mh.test
  httpPort: 80
  httpsPort: 443
  tcpSslPort: 443
  tcpPortRange: { from: $TCP_FROM, to: $((TCP_FROM + 60)) }
  subnetPool: 10.200.0.0/16
  traefikDynamicDir: /etc/traefik/dynamic/rctf-firecracker
  externalInterface: $PRIV_IF
  reuseQuarantineSeconds: 10
  requireConntrack: true
  tapUser: '10000'
  tapGroup: '10000'
EOF
printf 'FIRECRACKER_AGENT_TOKEN=%s\n' "$TOKEN" >/etc/rctf-firecracker/agent.env
chmod 0600 /etc/rctf-firecracker/agent.env

systemctl daemon-reload
systemctl enable rctf-firecracker-agent >/dev/null 2>&1
systemctl restart rctf-firecracker-agent

log "waiting for the agent to accept"
ok=0
for _ in $(seq 1 90); do
  if curl -sS -m 2 -H "Authorization: Bearer $TOKEN" "http://$PRIV_IP:7001/v1/info" |
    grep -q '"accepting":true'; then
    ok=1
    break
  fi
  sleep 1
done
[ "$ok" -eq 1 ] || {
  journalctl -u rctf-firecracker-agent --no-pager -n 60 >&2 || true
  die "agent did not become accepting"
}

# Token file used by the driver's observation helpers (read-only HTTP calls).
printf '%s\n' "$TOKEN" >/home/ubuntu/.mh-agent-token
chown ubuntu:ubuntu /home/ubuntu/.mh-agent-token
chmod 0600 /home/ubuntu/.mh-agent-token
printf '%s\n' "$PRIV_IP" >/home/ubuntu/.mh-private-ip
chown ubuntu:ubuntu /home/ubuntu/.mh-private-ip

if [ "$ROLE" = controller ]; then
  log "writing controller config"
  mkdir -p /home/ubuntu/mh-controller
  chown ubuntu:ubuntu /home/ubuntu/mh-controller
  cat >/home/ubuntu/mh-controller/controller.yaml <<'EOF'
listen: { host: 127.0.0.1, port: 7000 }
databasePath: /home/ubuntu/mh-controller/controller.sqlite
hosts:
  - id: host-a
    url: http://10.77.0.10:7001
    capacity: { vcpus: 8, memMiB: 4096, diskMiB: 20000, maxInstances: 2 }
  - id: host-b
    url: http://10.77.0.11:7001
    capacity: { vcpus: 8, memMiB: 4096, diskMiB: 20000, maxInstances: 2 }
heartbeatIntervalSeconds: 1
hostTimeoutSeconds: 4
hostProbeTimeoutSeconds: 2
hostLostSeconds: 300
reaperIntervalSeconds: 1
reconcileIntervalSeconds: 2
orphanGraceSeconds: 5
createFenceSeconds: 10
maxClockSkewSeconds: 10
clockSampleMaxAgeSeconds: 30
clockMaxRttSeconds: 3
shutdownTimeoutSeconds: 5
EOF
  cat >/home/ubuntu/mh-controller/controller.env <<EOF
FIRECRACKER_CONTROLLER_AUTH_TOKEN=${MH_API_TOKEN:?}
FIRECRACKER_CONTROLLER_ADMIN_TOKEN=${MH_ADMIN_TOKEN:?}
FIRECRACKER_TEAM_KEY_SECRET=${MH_TEAM_KEY_SECRET:?}
FIRECRACKER_HOST_TOKEN_HOST_A=${MH_AGENT_TOKEN_A:?}
FIRECRACKER_HOST_TOKEN_HOST_B=${MH_AGENT_TOKEN_B:?}
EOF
  cat >/home/ubuntu/mh-controller/badtoken.env <<'EOF'
FIRECRACKER_HOST_TOKEN_HOST_B=deliberately-wrong-token-for-host-b
EOF
  chown -R ubuntu:ubuntu /home/ubuntu/mh-controller
  chmod 0600 /home/ubuntu/mh-controller/controller.env /home/ubuntu/mh-controller/badtoken.env
fi

touch /etc/mh-provisioned
log "provisioning done ($ROLE)"
