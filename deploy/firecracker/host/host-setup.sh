#!/usr/bin/env bash
#
# rCTF Firecracker instancer - host setup for the NETWORK/ROUTING track.
#
# Idempotent: every action is create-if-missing or overwrite-with-the-same-file.
# It performs NO destructive operation (no deletes, no firewall flushes, no
# service restarts). The privileged nftables table is created by the agent
# itself (owned entirely by it), never by this script.
#
# Usage:
#   sudo ./host-setup.sh
#
# Overridable environment:
#   FIRECRACKER_BIN      default /usr/local/bin/firecracker
#   JAILER_BIN           default /usr/local/bin/jailer
#   MIN_FC_VERSION       default 1.7.0
#   CHROOT_BASE          default /srv/jailer (vm.chrootBase)
#   TRAEFIK_DYNAMIC_DIR  default /etc/traefik/dynamic/rctf-firecracker
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

FIRECRACKER_BIN="${FIRECRACKER_BIN:-/usr/local/bin/firecracker}"
JAILER_BIN="${JAILER_BIN:-/usr/local/bin/jailer}"
MIN_FC_VERSION="${MIN_FC_VERSION:-1.7.0}"

STATUS_DIR="/var/lib/rctf-firecracker"
STATE_DIR="${STATUS_DIR}/state"
RUN_DIR="${STATUS_DIR}/run"
IMAGES_DIR="${STATUS_DIR}/images"
CHROOT_BASE="${CHROOT_BASE:-/srv/jailer}"
TRAEFIK_DYNAMIC_DIR="${TRAEFIK_DYNAMIC_DIR:-/etc/traefik/dynamic/rctf-firecracker}"
CONFIG_DIR="/etc/rctf-firecracker"
SYSCTL_FILE="/etc/sysctl.d/90-rctf-firecracker.conf"

log() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

version_ge() {
  # version_ge A B -> true when A >= B (sort -V semantics).
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

binary_version() {
  # Only the banner line is the version: Firecracker >= 1.17 also logs
  # "Firecracker exiting successfully. exit_code=0" to stdout after it, which
  # made the old `awk '{print $NF}'` return "1.17.0\nexit_code=0" and
  # version_ge reject a supported binary. Take the first line, then the first
  # x.y.z token (tolerating a leading "v" and ignoring a pre-release/build
  # suffix such as "-rc1"). An unparsable binary yields the empty string, which
  # the caller already rejects as "could not read ... version".
  "$1" --version 2>/dev/null |
    head -n 1 |
    grep -m1 -Eo '[0-9]+\.[0-9]+\.[0-9]+' || true
}

# ---------------------------------------------------------------------------
# Rootless version probe (used by apps/firecracker-instancer/test): parse and
# compare the binaries, print the result, and exit BEFORE any privileged
# precondition or directory change. Never touches the host.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--check-version-only" ]; then
  [ -x "${FIRECRACKER_BIN}" ] || die "firecracker binary not executable: ${FIRECRACKER_BIN}"
  [ -x "${JAILER_BIN}" ] || die "jailer binary not executable: ${JAILER_BIN}"
  FC_VERSION="$(binary_version "${FIRECRACKER_BIN}")"
  JAILER_VERSION="$(binary_version "${JAILER_BIN}")"
  [ -n "${FC_VERSION}" ] || die "could not read firecracker version from ${FIRECRACKER_BIN}"
  [ -n "${JAILER_VERSION}" ] || die "could not read jailer version from ${JAILER_BIN}"
  version_ge "${FC_VERSION}" "${MIN_FC_VERSION}" ||
    die "firecracker ${FC_VERSION} is older than the supported minimum ${MIN_FC_VERSION}"
  version_ge "${JAILER_VERSION}" "${MIN_FC_VERSION}" ||
    die "jailer ${JAILER_VERSION} is older than the supported minimum ${MIN_FC_VERSION}"
  printf 'firecracker %s\njailer %s\n' "${FC_VERSION}" "${JAILER_VERSION}"
  exit 0
fi

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
[ "${EUID}" -eq 0 ] || die "must run as root (netfilter, taps, jailer uid/chroot)"
[ "$(uname -s)" = "Linux" ] || die "Linux only"
command -v ip >/dev/null 2>&1 || die "iproute2 (ip) is required"
command -v nft >/dev/null 2>&1 || die "nftables (nft) is required"
# net.requireConntrack defaults to true: without conntrack-tools a released
# lease can leak conntrack/NAT state to the next tenant.
command -v conntrack >/dev/null 2>&1 ||
  die "conntrack-tools (conntrack) is required (set network.requireConntrack=false only on isolated dev hosts)"
command -v sysctl >/dev/null 2>&1 || die "sysctl is required"

if [ ! -c /dev/kvm ]; then
  die "/dev/kvm is missing: enable VT-x/AMD-V and the KVM module, then rerun"
fi
[ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm is not accessible to root"

log "checking Firecracker binaries"
[ -x "${FIRECRACKER_BIN}" ] || die "firecracker binary not executable: ${FIRECRACKER_BIN}"
[ -x "${JAILER_BIN}" ] || die "jailer binary not executable: ${JAILER_BIN}"
FC_VERSION="$(binary_version "${FIRECRACKER_BIN}")"
JAILER_VERSION="$(binary_version "${JAILER_BIN}")"
[ -n "${FC_VERSION}" ] || die "could not read firecracker version from ${FIRECRACKER_BIN}"
[ -n "${JAILER_VERSION}" ] || die "could not read jailer version from ${JAILER_BIN}"
version_ge "${FC_VERSION}" "${MIN_FC_VERSION}" ||
  die "firecracker ${FC_VERSION} is older than the supported minimum ${MIN_FC_VERSION}"
version_ge "${JAILER_VERSION}" "${MIN_FC_VERSION}" ||
  die "jailer ${JAILER_VERSION} is older than the supported minimum ${MIN_FC_VERSION}"
log "firecracker ${FC_VERSION}, jailer ${JAILER_VERSION} (minimum ${MIN_FC_VERSION})"

log "printing tool versions (informational)"
printf '    nft:       %s\n' "$(nft --version 2>/dev/null | head -n 1 || echo unknown)"
printf '    ip:        %s\n' "$(ip -V 2>/dev/null | head -n 1 || echo unknown)"
printf '    conntrack: %s\n' "$(conntrack --version 2>/dev/null | head -n 1 || echo unknown)"

# ---------------------------------------------------------------------------
# Directories (no delete; modes are set explicitly)
# ---------------------------------------------------------------------------
log "creating directories"
install -d -m 0755 -o root -g root "${STATUS_DIR}"
install -d -m 0700 -o root -g root "${STATE_DIR}"
install -d -m 0700 -o root -g root "${RUN_DIR}"
install -d -m 0755 -o root -g root "${IMAGES_DIR}"
# The jailer chroots below this path and the systemd unit mounts it read-write
# (ProtectSystem=strict). Create it root-owned; the jailer creates the
# per-uid/per-instance subtrees itself.
install -d -m 0700 -o root -g root "${CHROOT_BASE}"
# Traefik reads these files after dropping privileges.
install -d -m 0755 -o root -g root "${TRAEFIK_DYNAMIC_DIR}"
install -d -m 0755 -o root -g root "${CONFIG_DIR}"

# ---------------------------------------------------------------------------
# IPv4 forwarding (guests are routed, one /30 per VM)
# ---------------------------------------------------------------------------
log "installing ${SYSCTL_FILE}"
if [ -f "${SCRIPT_DIR}/sysctl.d/90-rctf-firecracker.conf" ]; then
  install -m 0644 -o root -g root \
    "${SCRIPT_DIR}/sysctl.d/90-rctf-firecracker.conf" "${SYSCTL_FILE}"
else
  printf '%s\n' \
    '# rCTF Firecracker instancer: guests are routed, one /30 per VM.' \
    'net.ipv4.ip_forward = 1' >"${SYSCTL_FILE}"
  chmod 0644 "${SYSCTL_FILE}"
fi
# Apply ONLY the file this script installed. `sysctl --system` would also
# apply every other /etc/sysctl.d, /run/sysctl.d and /usr/lib/sysctl.d file,
# silently changing unrelated host tunables (and making this setup non-local).
log "applying ${SYSCTL_FILE} only (no other sysctl file is touched)"
sysctl -q -p "${SYSCTL_FILE}" >/dev/null
# Verify every intended setting from that same file, not just ip_forward.
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%%#*}
  line=$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [ -n "$line" ] || continue
  case "$line" in *"="*) ;; *) continue ;; esac
  key=$(printf '%s' "$line" | cut -d= -f1 | tr -d '[:space:]')
  want=$(printf '%s' "$line" | cut -d= -f2- |
    sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [ -n "$key" ] && [ -n "$want" ] || die "unparsable setting in ${SYSCTL_FILE}: $line"
  got=$(sysctl -n "$key" 2>/dev/null) ||
    die "could not read $key after applying ${SYSCTL_FILE}"
  [ "$got" = "$want" ] ||
    die "$key is $got after applying ${SYSCTL_FILE}, expected $want"
  log "$key=$got"
done <"${SYSCTL_FILE}"
IP_FORWARD="$(sysctl -n net.ipv4.ip_forward)"
[ "${IP_FORWARD}" = "1" ] || die "net.ipv4.ip_forward is ${IP_FORWARD}, expected 1"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
cat <<EOF

Setup complete. Nothing was deleted and no service was restarted.

Created/updated:
  ${SYSCTL_FILE}                      net.ipv4.ip_forward=1
  ${STATE_DIR}                        agent instance state (0700)
  ${RUN_DIR}                          per-instance runtime/jail roots (0700)
  ${IMAGES_DIR}                       read-only image store (0755)
  ${CHROOT_BASE}                      jailer --chroot-base-dir (0700)
  ${TRAEFIK_DYNAMIC_DIR}              Traefik file provider directory (0755)
  ${CONFIG_DIR}                       agent config (0755)

Still required by the operator:
  - Install the sample Traefik static config (deploy/firecracker/host/traefik.yml)
    and a wildcard certificate for *.<httpDomain>, or configure a certResolver.
  - Install deploy/firecracker/host/rctf-firecracker-agent.service, set
    FIRECRACKER_AGENT_TOKEN, and keep the agent port reachable only from the
    controller.
  - Point the wildcard DNS record for *.<httpDomain> at this host's public IP.
  - If the jailer runs Firecracker as a non-root uid, set the agent's
    network.tapUser/tapGroup to that uid/gid so it can open its tap device.
    The VM driver defaults (vm.jailUid/vm.jailGid) are 10000.
EOF
