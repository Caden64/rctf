#!/usr/bin/env bash
#
# Named, throwaway QEMU VM for the multi-host Firecracker tests.
#
# This is a small generalisation of deploy/firecracker/vmtest/vm.sh (copied,
# not modified): the same Ubuntu 24.04 cloud image booted with KVM and QEMU
# user networking for management ssh. On top of that it adds a SECOND NIC
# connected to the other test VMs through a QEMU socket netdev in multicast
# mode (a private L2 segment), and it keeps every file under
# $MH_VM_ROOT/<name> so any number of named VMs can coexist.
#
# Runs unprivileged on the developer machine. Everything privileged happens
# inside the VMs.
#
# Usage:
#   ./vm.sh --name host-a --ssh-port 2201 --seed-port 8101 \
#           --priv-ip 10.77.0.10 --mcast 239.1.2.3:47001 \
#           --mac-mgmt 52:54:00:77:0a:00 --mac-priv 52:54:00:77:0a:01 \
#           create|start|stop|destroy|status|ssh|pid|ip|console
#
# Environment:
#   MH_VM_ROOT    default $HOME/.cache/rctf-multihost
#   MH_VM_MEM     default 3584 (MiB)
#   MH_VM_SMP     default 2
#   MH_VM_DISK    default 30G
#   MH_BASE_IMAGE override the base image (still digest-verified)
#
# The base image is the same pinned Ubuntu 24.04 dated release the vmtest
# harness uses (noble/20261017, SHA256 + SHA256SUMS.gpg verified). A cached
# image is re-hashed on every boot and the boot is refused on a mismatch; a
# floating noble/current download is never used.
#
# The cloud-init seed is served over the QEMU user-network gateway
# (10.0.2.2) and selected with the SMBIOS serial `ds=nocloud;s=...` trick, so
# no ISO, xorriso, cloud-localds or root are needed.
set -euo pipefail

VM_ROOT=${MH_VM_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-multihost}
VM_MEM=${MH_VM_MEM:-3584}
VM_SMP=${MH_VM_SMP:-2}
VM_DISK=${MH_VM_DISK:-30G}

# Pinned Ubuntu cloud image (same release and digest as vmtest/vm.sh).
UBUNTU_SERIES=${UBUNTU_SERIES:-noble}
UBUNTU_RELEASE=${UBUNTU_RELEASE:-20261017}
UBUNTU_IMAGE=${UBUNTU_IMAGE:-noble-server-cloudimg-amd64.img}
# Digest published in noble/20261017/SHA256SUMS (2026-10-17). Pinned here as
# well as cross-checked against the published SHA256SUMS on every fresh fetch.
UBUNTU_IMAGE_SHA256=${UBUNTU_IMAGE_SHA256:-04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94}
UBUNTU_GPG_FINGERPRINT=${UBUNTU_GPG_FINGERPRINT:-D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81}
UBUNTU_BASE_URL=${UBUNTU_BASE_URL:-https://cloud-images.ubuntu.com/$UBUNTU_SERIES/$UBUNTU_RELEASE}
BASE_IMAGE_URL=${BASE_IMAGE_URL:-$UBUNTU_BASE_URL/$UBUNTU_IMAGE}
SHA256SUMS_URL=${SHA256SUMS_URL:-$UBUNTU_BASE_URL/SHA256SUMS}
SHA256SUMS_GPG_URL=${SHA256SUMS_GPG_URL:-$UBUNTU_BASE_URL/SHA256SUMS.gpg}
UBUNTU_GPG_KEY_URL=${UBUNTU_GPG_KEY_URL:-https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x$UBUNTU_GPG_FINGERPRINT}

NAME=
SSH_PORT=
SEED_PORT=
PRIV_IP=
MCAST=
MAC_MGMT=
MAC_PRIV=

usage() {
  sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

log() { printf '==> %s: %s\n' "${NAME:-vm}" "$*" >&2; }
die() {
  printf 'vm.sh(%s): %s\n' "${NAME:-?}" "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME=${2:?}; shift 2 ;;
    --ssh-port) SSH_PORT=${2:?}; shift 2 ;;
    --seed-port) SEED_PORT=${2:?}; shift 2 ;;
    --priv-ip) PRIV_IP=${2:?}; shift 2 ;;
    --mcast) MCAST=${2:?}; shift 2 ;;
    --mac-mgmt) MAC_MGMT=${2:?}; shift 2 ;;
    --mac-priv) MAC_PRIV=${2:?}; shift 2 ;;
    --help | -h) usage ;;
    --*) die "unknown option $1" ;;
    *) break ;;
  esac
done
CMD=${1:-}
[ -n "$CMD" ] || usage
[ -n "$NAME" ] || die "--name is required"
case "$NAME" in
  *[!a-zA-Z0-9_.-]*) die "invalid --name '$NAME'" ;;
esac

VM_DIR=$VM_ROOT/$NAME
BASE_IMAGE=${MH_BASE_IMAGE:-}
if [ -z "$BASE_IMAGE" ]; then
  if [ -f "$VM_ROOT/noble-base.img" ]; then
    BASE_IMAGE=$VM_ROOT/noble-base.img
  elif [ -f "${XDG_CACHE_HOME:-$HOME/.cache}/rctf-vmtest/noble-base.img" ]; then
    # Shared read-only with the vmtest harness; never written here.
    BASE_IMAGE=${XDG_CACHE_HOME:-$HOME/.cache}/rctf-vmtest/noble-base.img
  else
    BASE_IMAGE=$VM_ROOT/noble-base.img
  fi
fi

OVERLAY=$VM_DIR/overlay.qcow2
SSH_KEY=$VM_ROOT/id_ed25519
SEED_DIR=$VM_DIR/seed
QEMU_PID=$VM_DIR/qemu.pid
SEED_PID=$VM_DIR/seed-http.pid
# Keep the serial log path short: qemu writes it by absolute path.
CONSOLE=$VM_DIR/console.log

ssh_opts=(
  -i "$SSH_KEY"
  -p "${SSH_PORT:?--ssh-port is required for ssh/create}"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR
  -o ConnectTimeout=5
  -o ServerAliveInterval=10
  -o BatchMode=yes
)

is_running() {
  [ -f "$QEMU_PID" ] || return 1
  local pid
  pid=$(cat "$QEMU_PID" 2>/dev/null) || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

stop_seed_server() {
  [ -f "$SEED_PID" ] || return 0
  local pid
  pid=$(cat "$SEED_PID" 2>/dev/null) || return 0
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  rm -f "$SEED_PID"
}

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

# Verify the pinned image digest and Ubuntu's SHA256SUMS / SHA256SUMS.gpg.
# Copied from deploy/firecracker/vmtest/vm.sh so both harnesses trust exactly
# the same dated release. Returns 0 with a verified digest; dies on a mismatch.
# GPG failure caused by unavailable key infrastructure is reported honestly and
# does not block the pinned SHA256, which is the authoritative check.
verify_ubuntu_sums() {
  local dir=$1 pub got rc
  curl -fsSL --retry 3 --connect-timeout 20 -o "$dir/SHA256SUMS" "$SHA256SUMS_URL" ||
    die "could not download $SHA256SUMS_URL"
  pub=$(awk -v f="$UBUNTU_IMAGE" '$2 == f || $2 == "*" f { print $1; exit }' "$dir/SHA256SUMS")
  [ -n "$pub" ] || die "published SHA256SUMS has no entry for $UBUNTU_IMAGE"
  [ "$pub" = "$UBUNTU_IMAGE_SHA256" ] ||
    die "pinned digest $UBUNTU_IMAGE_SHA256 does not match published $pub for $UBUNTU_IMAGE (refusing to use it)"

  if ! command -v gpg >/dev/null 2>&1; then
    log "WARNING: gpg is not installed; SHA256SUMS.gpg not verified (pinned SHA256 still enforced)"
    return 0
  fi
  curl -fsSL --retry 3 --connect-timeout 20 -o "$dir/SHA256SUMS.gpg" "$SHA256SUMS_GPG_URL" ||
    die "could not download $SHA256SUMS_GPG_URL"
  curl -fsSL --retry 3 --connect-timeout 20 -o "$dir/ubuntu-key.asc" "$UBUNTU_GPG_KEY_URL" ||
    die "could not download the pinned Ubuntu cloud-image signing key from $UBUNTU_GPG_KEY_URL"

  if (
    export GNUPGHOME=$dir/gnupg
    mkdir -m 700 "$GNUPGHOME" || exit 2
    gpg --batch --quiet --import "$dir/ubuntu-key.asc" 2>"$dir/gpg-import.err" || exit 2
    gpg --batch --with-colons --list-keys "$UBUNTU_GPG_FINGERPRINT" >/dev/null 2>&1 || exit 3
    gpg --batch --quiet --verify "$dir/SHA256SUMS.gpg" "$dir/SHA256SUMS" 2>"$dir/gpg-verify.err" || exit 4
    exit 0
  ); then
    rc=0
  else
    rc=$?
  fi
  case "$rc" in
    0) log "GPG signature on SHA256SUMS verified (key $UBUNTU_GPG_FINGERPRINT)" ;;
    2) die "could not import the pinned Ubuntu cloud-image signing key" ;;
    3) die "the fetched key does not have the pinned fingerprint $UBUNTU_GPG_FINGERPRINT" ;;
    *) cat "$dir/gpg-verify.err" >&2 2>/dev/null || true
       die "GPG verification of SHA256SUMS FAILED (signature mismatch)" ;;
  esac
}

ensure_base_image() {
  mkdir -p "$(dirname "$BASE_IMAGE")"
  if [ -f "$BASE_IMAGE" ]; then
    log "re-hashing cached Ubuntu image $BASE_IMAGE"
    local got
    got=$(sha256_of "$BASE_IMAGE")
    if [ "$got" = "$UBUNTU_IMAGE_SHA256" ]; then
      printf '%s  %s\n' "$got" "$(basename "$BASE_IMAGE")" >"$BASE_IMAGE.sha256"
      return 0
    fi
    if [ "$BASE_IMAGE" != "$VM_ROOT/noble-base.img" ]; then
      # Never delete an image this run does not own (for example the shared
      # read-only vmtest cache): refuse to boot instead.
      die "cached image $BASE_IMAGE has digest $got, expected $UBUNTU_IMAGE_SHA256 (refusing to boot; not deleting a shared image)"
    fi
    log "cached image digest mismatch (got $got, want $UBUNTU_IMAGE_SHA256); discarding"
    rm -f "$BASE_IMAGE" "$BASE_IMAGE.sha256"
  fi
  command -v curl >/dev/null || die "curl is required"
  command -v sha256sum >/dev/null || die "sha256sum is required"
  local tmp=$BASE_IMAGE.part dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/rctf-mh-image.XXXXXX")
  rm -f "$tmp"
  verify_ubuntu_sums "$dir"
  log "downloading Ubuntu $UBUNTU_SERIES/$UBUNTU_RELEASE image (~600 MiB) to $BASE_IMAGE"
  curl -fL --retry 3 --connect-timeout 20 -o "$tmp" "$BASE_IMAGE_URL"
  local got
  got=$(sha256_of "$tmp")
  if [ "$got" != "$UBUNTU_IMAGE_SHA256" ]; then
    rm -f "$tmp"
    rm -rf "$dir"
    die "downloaded image digest mismatch (got $got, want $UBUNTU_IMAGE_SHA256)"
  fi
  mv "$tmp" "$BASE_IMAGE"
  printf '%s  %s\n' "$got" "$(basename "$BASE_IMAGE")" >"$BASE_IMAGE.sha256"
  printf 'url=%s\ndigest=%s\ngpg_fingerprint=%s\ndate=%s\n' \
    "$BASE_IMAGE_URL" "$got" "$UBUNTU_GPG_FINGERPRINT" "$(date -Is)" >"$BASE_IMAGE.meta"
  rm -rf "$dir"
  log "Ubuntu image verified ($got)"
}

ensure_ssh_key() {
  mkdir -p "$VM_ROOT"
  [ -f "$SSH_KEY" ] && return 0
  command -v ssh-keygen >/dev/null || die "ssh-keygen is required"
  # Two VMs boot in parallel; generate the shared key exactly once.
  (
    flock 9
    if [ ! -f "$SSH_KEY" ]; then
      log "generating ephemeral ssh key $SSH_KEY"
      ssh-keygen -q -t ed25519 -N '' -f "$SSH_KEY" -C rctf-multihost
      chmod 600 "$SSH_KEY"
    fi
  ) 9>"$VM_ROOT/.ssh-key.lock"
}

write_seed() {
  [ -n "$PRIV_IP" ] || die "--priv-ip is required"
  [ -n "$MCAST" ] || die "--mcast is required"
  [ -n "$MAC_MGMT" ] || die "--mac-mgmt is required"
  [ -n "$MAC_PRIV" ] || die "--mac-priv is required"
  mkdir -p "$SEED_DIR"
  local pub
  pub=$(cat "$SSH_KEY.pub")
  cat >"$SEED_DIR/meta-data" <<EOF
instance-id: rctf-mh-$NAME
local-hostname: $NAME
EOF
  # Management ssh is bound to the QEMU user-network address only, so the
  # private test L2 never exposes an ssh daemon.
  # cloud-init's netplan renderer renames virtio NICs to ens3/ens4 in this
  # image and ignores `set-name` under `network:`. Configure the private NIC by
  # MAC in a tiny boot unit instead: it works for any kernel-assigned name and
  # survives a VM reboot (the overlay keeps the enabled unit).
  cat >"$SEED_DIR/user-data" <<EOF
#cloud-config
users:
  - name: ubuntu
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: [sudo]
    shell: /bin/bash
    ssh_authorized_keys:
      - $pub
ssh_pwauth: false
disable_root: true
package_update: false
package_upgrade: false
write_files:
  - path: /etc/ssh/sshd_config.d/99-mh.conf
    content: |
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      PermitRootLogin prohibit-password
      ListenAddress 10.0.2.15
  - path: /etc/systemd/system/ssh.socket.d/10-mh-listen.conf
    content: |
      [Socket]
      ListenStream=
      ListenStream=10.0.2.15:22
  - path: /usr/local/sbin/mh-private-net
    permissions: '0755'
    content: |
      #!/bin/sh
      set -e
      MAC="$MAC_PRIV"
      IF=\$(ip -o link show | awk -v mac="\$MAC" '\$0 ~ mac {gsub(":", "", \$2); print \$2; exit}')
      [ -n "\$IF" ] || exit 0
      ip link set "\$IF" up
      ip addr replace "$PRIV_IP/24" dev "\$IF"
  - path: /etc/systemd/system/mh-private-net.service
    permissions: '0644'
    content: |
      [Unit]
      Description=multihost private L2 address
      After=local-fs.target
      Before=network-online.target
      Wants=network-online.target

      [Service]
      Type=oneshot
      ExecStart=/usr/local/sbin/mh-private-net
      RemainAfterExit=yes

      [Install]
      WantedBy=multi-user.target
runcmd:
  - [ systemctl, daemon-reload ]
  - [ systemctl, enable, --now, mh-private-net.service ]
  - [ systemctl, restart, ssh.socket ]
  - [ touch, /etc/mh-ready ]
EOF
}

start_seed_server() {
  if curl -sf --max-time 2 "http://127.0.0.1:$SEED_PORT/meta-data" >/dev/null 2>&1; then
    return 0
  fi
  command -v python3 >/dev/null || die "python3 is required to serve the cloud-init seed"
  mkdir -p "$VM_DIR"
  nohup python3 -m http.server "$SEED_PORT" --bind 127.0.0.1 --directory "$SEED_DIR" \
    >"$VM_DIR/seed-http.log" 2>&1 &
  echo $! >"$SEED_PID"
  local i
  for i in $(seq 1 50); do
    curl -sf --max-time 2 "http://127.0.0.1:$SEED_PORT/meta-data" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  die "seed http server did not start on port $SEED_PORT"
}

wait_ssh() {
  local deadline=$((SECONDS + 420))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ssh "${ssh_opts[@]}" ubuntu@127.0.0.1 true >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}

wait_cloud_init() {
  log "waiting for cloud-init"
  # `cloud-init status` exits non-zero on a degraded run (for example a failed
  # optional runcmd). The contract we need is /etc/mh-ready plus the private IP.
  timeout 900 ssh "${ssh_opts[@]}" ubuntu@127.0.0.1 \
    'sudo cloud-init status --wait >/dev/null 2>&1; sudo cloud-init status || true' >&2 || true
  local deadline=$((SECONDS + 120))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ssh "${ssh_opts[@]}" ubuntu@127.0.0.1 \
      "test -f /etc/mh-ready && ip -4 -o addr show | grep -Fq '$PRIV_IP/'"; then
      return 0
    fi
    sleep 2
  done
  tail -40 "$CONSOLE" >&2 || true
  die "VM did not finish provisioning (/etc/mh-ready or the private IP is missing)"
}

boot() {
  command -v qemu-system-x86_64 >/dev/null || die "qemu-system-x86_64 is required"
  command -v qemu-img >/dev/null || die "qemu-img is required"
  [ -r /dev/kvm ] || die "/dev/kvm is not readable (KVM is required)"
  mkdir -p "$VM_DIR"
  ensure_base_image
  ensure_ssh_key
  write_seed
  start_seed_server
  if is_running; then
    log "VM already running (pid $(cat "$QEMU_PID"))"
    return 0
  fi
  rm -f "$QEMU_PID" "$CONSOLE"
  if [ ! -f "$OVERLAY" ]; then
    log "creating qcow2 overlay (${VM_DISK})"
    qemu-img create -q -f qcow2 -b "$BASE_IMAGE" -F qcow2 "$OVERLAY" "$VM_DISK"
  fi
  log "booting VM (ssh 127.0.0.1:$SSH_PORT, private $PRIV_IP)"
  qemu-system-x86_64 \
    -enable-kvm -cpu host -m "$VM_MEM" -smp "$VM_SMP" \
    -display none -serial "file:$CONSOLE" \
    -pidfile "$QEMU_PID" -daemonize \
    -drive "if=virtio,file=$OVERLAY,cache=none,discard=unmap" \
    -netdev "user,id=n0,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22" \
    -device "virtio-net-pci,netdev=n0,mac=$MAC_MGMT" \
    -netdev "socket,id=n1,mcast=$MCAST" \
    -device "virtio-net-pci,netdev=n1,mac=$MAC_PRIV" \
    -smbios "type=1,serial=ds=nocloud;s=http://10.0.2.2:${SEED_PORT}/"
  if ! wait_ssh; then
    tail -40 "$CONSOLE" >&2 || true
    die "VM did not become reachable over ssh"
  fi
  wait_cloud_init
}

case "$CMD" in
  create | start)
    boot
    log "VM ready. Use '$0 --name $NAME --ssh-port $SSH_PORT ssh' to log in."
    ;;
  ssh)
    shift
    [ -n "${SSH_PORT:-}" ] || die "--ssh-port is required for ssh"
    exec ssh "${ssh_opts[@]}" ubuntu@127.0.0.1 "$@"
    ;;
  status)
    if is_running; then
      echo "running name=$NAME pid=$(cat "$QEMU_PID") ssh=127.0.0.1:${SSH_PORT:-?} priv=${PRIV_IP:-?}"
    else
      echo "stopped name=$NAME"
      exit 1
    fi
    ;;
  ip)
    echo "127.0.0.1:${SSH_PORT:-?}"
    ;;
  pid)
    is_running || exit 1
    cat "$QEMU_PID"
    ;;
  console)
    tail -n "${2:-80}" "$CONSOLE"
    ;;
  stop)
    if is_running; then
      pid=$(cat "$QEMU_PID")
      log "stopping VM (pid $pid)"
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$QEMU_PID"
    stop_seed_server
    ;;
  destroy)
    "$0" --name "$NAME" --ssh-port "${SSH_PORT:-0}" stop
    log "removing overlay and console for $NAME"
    rm -f "$OVERLAY" "$CONSOLE"
    rm -rf "$SEED_DIR"
    ;;
  *)
    usage
    ;;
esac
