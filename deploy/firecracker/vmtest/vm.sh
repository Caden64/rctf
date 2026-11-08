#!/usr/bin/env bash
#
# Throwaway QEMU VM used by the Firecracker privileged test harness.
#
# This runs on the *developer machine*, unprivileged. The VM is Ubuntu 24.04
# cloud image booted with KVM and user-mode networking; everything privileged
# (host-setup.sh, systemd, jailer, nftables, conntrack, network namespaces)
# happens INSIDE the VM.
#
# Usage:
#   ./vm.sh create   # download image if needed, boot, wait for ssh + cloud-init
#   ./vm.sh start    # alias for create (idempotent)
#   ./vm.sh ssh [args...]
#   ./vm.sh status
#   ./vm.sh stop     # kill qemu + seed http server, keep the disk
#   ./vm.sh destroy  # stop and remove the overlay (base image is kept)
#
# Environment:
#   VM_DIR          default $HOME/.cache/rctf-vmtest
#   VM_SSH_PORT     default 2222
#   VM_SEED_PORT    default 8001
#   VM_MEM          default 4096 (MiB)
#   VM_SMP          default 4
#   VM_DISK         default 40G
#
# The cloud-init seed is served over the QEMU user-network gateway
# (10.0.2.2) and selected with the SMBIOS serial `ds=nocloud;s=...` trick, so
# no ISO, xorriso, cloud-localds or root are needed.
set -euo pipefail

VM_DIR=${VM_DIR:-$HOME/.cache/rctf-vmtest}
VM_SSH_PORT=${VM_SSH_PORT:-2222}
VM_SEED_PORT=${VM_SEED_PORT:-8001}
VM_MEM=${VM_MEM:-4096}
VM_SMP=${VM_SMP:-4}
VM_DISK=${VM_DISK:-40G}
BASE_IMAGE_URL=${BASE_IMAGE_URL:-https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img}

BASE_IMAGE=$VM_DIR/noble-base.img
OVERLAY=$VM_DIR/overlay.qcow2
SSH_KEY=$VM_DIR/id_ed25519
SEED_DIR=$VM_DIR/seed
QEMU_PID=$VM_DIR/qemu.pid
SEED_PID=$VM_DIR/seed-http.pid
CONSOLE=$VM_DIR/console.log

log() { printf '==> %s\n' "$*" >&2; }
die() {
  printf 'vm.sh: %s\n' "$*" >&2
  exit 1
}

ssh_opts=(
  -i "$SSH_KEY"
  -p "$VM_SSH_PORT"
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

ensure_base_image() {
  [ -f "$BASE_IMAGE" ] && return 0
  command -v curl >/dev/null || die "curl is required"
  log "downloading Ubuntu 24.04 cloud image (~600 MiB) to $BASE_IMAGE"
  local tmp=$BASE_IMAGE.part
  curl -fL --retry 3 --connect-timeout 20 -o "$tmp" "$BASE_IMAGE_URL"
  mv "$tmp" "$BASE_IMAGE"
}

ensure_ssh_key() {
  [ -f "$SSH_KEY" ] && return 0
  command -v ssh-keygen >/dev/null || die "ssh-keygen is required"
  log "generating ephemeral ssh key $SSH_KEY"
  ssh-keygen -q -t ed25519 -N '' -f "$SSH_KEY" -C rctf-vmtest
  chmod 600 "$SSH_KEY"
}

write_seed() {
  mkdir -p "$SEED_DIR"
  local pub
  pub=$(cat "$SSH_KEY.pub")
  cat >"$SEED_DIR/meta-data" <<'EOF'
instance-id: rctf-vmtest-01
local-hostname: rctf-vmtest
EOF
  # The management sshd is bound to the QEMU user-network address only, so a
  # scan of the "public" test interface cannot see port 22 (check h).
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
package_update: true
package_upgrade: false
packages:
  - nftables
  - conntrack
  - jq
  - netcat-openbsd
  - curl
  - iproute2
  - e2fsprogs
  - unzip
  - tar
  - ca-certificates
  - psmisc
  - procps
  - nmap
  - python3
write_files:
  - path: /etc/ssh/sshd_config.d/99-vmtest.conf
    content: |
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      PermitRootLogin prohibit-password
      ListenAddress 10.0.2.15
  - path: /etc/systemd/system/ssh.socket.d/10-vmtest-listen.conf
    content: |
      [Socket]
      ListenStream=
      ListenStream=10.0.2.15:22
runcmd:
  - [ systemctl, daemon-reload ]
  - [ systemctl, restart, ssh.socket ]
  - [ sh, -c, "sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 || true" ]
  - [ touch, /etc/rctf-vmtest-ready ]
EOF
}

start_seed_server() {
  if curl -sf --max-time 2 "http://127.0.0.1:$VM_SEED_PORT/meta-data" >/dev/null 2>&1; then
    return 0
  fi
  command -v python3 >/dev/null || die "python3 is required to serve the cloud-init seed"
  nohup python3 -m http.server "$VM_SEED_PORT" --bind 127.0.0.1 --directory "$SEED_DIR" \
    >"$VM_DIR/seed-http.log" 2>&1 &
  echo $! >"$SEED_PID"
  local i
  for i in $(seq 1 50); do
    curl -sf --max-time 2 "http://127.0.0.1:$VM_SEED_PORT/meta-data" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  die "seed http server did not start on port $VM_SEED_PORT"
}

wait_ssh() {
  local deadline=$((SECONDS + 240))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ssh "${ssh_opts[@]}" ubuntu@127.0.0.1 true >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}

wait_cloud_init() {
  log "waiting for cloud-init (packages) - first boot can take a few minutes"
  if ! timeout 1200 ssh "${ssh_opts[@]}" ubuntu@127.0.0.1 \
    'sudo cloud-init status --wait >/dev/null 2>&1; sudo cloud-init status'; then
    tail -40 "$CONSOLE" >&2 || true
    die "cloud-init did not finish"
  fi
  if ! ssh "${ssh_opts[@]}" ubuntu@127.0.0.1 'test -f /etc/rctf-vmtest-ready'; then
    die "VM did not finish provisioning (/etc/rctf-vmtest-ready missing)"
  fi
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
  log "booting VM (ssh 127.0.0.1:$VM_SSH_PORT)"
  qemu-system-x86_64 \
    -enable-kvm -cpu host -m "$VM_MEM" -smp "$VM_SMP" \
    -display none -serial "file:$CONSOLE" \
    -pidfile "$QEMU_PID" -daemonize \
    -drive "if=virtio,file=$OVERLAY,cache=writeback,discard=unmap" \
    -netdev "user,id=n0,hostfwd=tcp:127.0.0.1:${VM_SSH_PORT}-:22" \
    -device virtio-net-pci,netdev=n0 \
    -smbios "type=1,serial=ds=nocloud;s=http://10.0.2.2:${VM_SEED_PORT}/"
  if ! wait_ssh; then
    tail -40 "$CONSOLE" >&2 || true
    die "VM did not become reachable over ssh"
  fi
  wait_cloud_init
}

cmd=${1:-}
case "$cmd" in
  create | start)
    boot
    log "VM ready. Use '$0 ssh' to log in."
    ;;
  ssh)
    shift
    exec ssh "${ssh_opts[@]}" ubuntu@127.0.0.1 "$@"
    ;;
  status)
    if is_running; then
      echo "running pid=$(cat "$QEMU_PID") ssh=127.0.0.1:$VM_SSH_PORT"
    else
      echo "stopped"
      exit 1
    fi
    ;;
  ip) echo "127.0.0.1:$VM_SSH_PORT" ;;
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
    "$0" stop
    log "removing overlay $OVERLAY"
    rm -f "$OVERLAY" "$CONSOLE"
    ;;
  *)
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
