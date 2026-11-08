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
#   VM_SSH_PORT     default 2422
#   VM_SEED_PORT    default 8201
#   VM_MEM          default 4096 (MiB)
#   VM_SMP          default 4
#   VM_DISK         default 40G
#   UBUNTU_SERIES   default noble
#   UBUNTU_RELEASE  default 20261017 (dated cloud-image directory, not current/)
#
# The cloud-init seed is served over the QEMU user-network gateway
# (10.0.2.2) and selected with the SMBIOS serial `ds=nocloud;s=...` trick, so
# no ISO, xorriso, cloud-localds or root are needed.
#
# Boot refuses to start when VM_SSH_PORT / VM_SEED_PORT are already bound by a
# process this vm.sh did not record. Kill only the PIDs in $VM_DIR, never by
# process name: other harness copies may run on the same machine.
set -euo pipefail

VM_DIR=${VM_DIR:-$HOME/.cache/rctf-vmtest}
VM_SSH_PORT=${VM_SSH_PORT:-2422}
VM_SEED_PORT=${VM_SEED_PORT:-8201}
VM_MEM=${VM_MEM:-4096}
VM_SMP=${VM_SMP:-4}
VM_DISK=${VM_DISK:-40G}

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

# Print the PID(s) listening on <port>, or "unknown" when ss cannot attribute
# the socket to a process. Returns 1 when nothing is listening.
listener_pids() { # listener_pids <port>
  local port=$1 addr pid pids
  pids=
  while IFS= read -r addr; do
    [ -n "$addr" ] || continue
    pid=$(ss -ltnp 2>/dev/null |
      awk -v a="$addr" '$4 == a' |
      sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)
    pids="${pids}${pids:+ }${pid:-unknown}"
  done <<EOF
$(ss -ltn 2>/dev/null | awk -v port="$port" '
  { n = split($4, a, ":"); if (a[n] == port) print $4 }
')
EOF
  [ -n "$pids" ] || return 1
  printf '%s\n' "$pids"
}

# Refuse to boot when a port is taken by a process this VM_DIR does not own.
# The allowed PID is the recorded qemu/seed server for this VM_DIR (empty when
# this VM_DIR has none).
check_port_free() { # check_port_free <port> <allowed-pid> <description>
  local port=$1 allow=$2 what=$3 pids pid comm
  if ! pids=$(listener_pids "$port"); then return 0; fi
  for pid in $pids; do
    if [ "$pid" != unknown ] && [ -n "$allow" ] && [ "$pid" = "$allow" ]; then
      continue
    fi
    if [ "$pid" = unknown ]; then
      die "$what port $port is already bound by an unidentifiable process; set VM_SSH_PORT/VM_SEED_PORT to free ports (refusing to boot)"
    fi
    comm=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    die "$what port $port is already bound by pid $pid (${comm:-unknown}); set VM_SSH_PORT/VM_SEED_PORT to free ports (refusing to boot)"
  done
}

recorded_pid() { # recorded_pid <pidfile> <expected-command-prefix>
  local file=$1 want=$2 pid
  [ -f "$file" ] || return 1
  pid=$(cat "$file" 2>/dev/null) || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  ps -o comm= -p "$pid" 2>/dev/null | grep -q "^$want" || return 1
  printf '%s\n' "$pid"
}

check_boot_ports() {
  local qpid spid
  qpid=$(recorded_pid "$QEMU_PID" qemu-system-x86 || true)
  spid=$(recorded_pid "$SEED_PID" python || true)
  check_port_free "$VM_SSH_PORT" "$qpid" "VM ssh"
  check_port_free "$VM_SEED_PORT" "$spid" "cloud-init seed"
}

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

# Verify the pinned image digest and Ubuntu's SHA256SUMS / SHA256SUMS.gpg.
# Returns 0 with a verified digest; dies on a mismatch. GPG failure caused by
# unavailable key infrastructure is reported honestly and does not block the
# pinned SHA256, which is the authoritative check.
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
  mkdir -p "$VM_DIR"
  if [ -f "$BASE_IMAGE" ]; then
    log "re-hashing cached Ubuntu image $BASE_IMAGE"
    local got
    got=$(sha256_of "$BASE_IMAGE")
    if [ "$got" = "$UBUNTU_IMAGE_SHA256" ]; then
      printf '%s  %s\n' "$got" "$(basename "$BASE_IMAGE")" >"$BASE_IMAGE.sha256"
      return 0
    fi
    log "cached image digest mismatch (got $got, want $UBUNTU_IMAGE_SHA256); discarding"
    rm -f "$BASE_IMAGE" "$BASE_IMAGE.sha256"
  fi
  command -v curl >/dev/null || die "curl is required"
  local tmp=$BASE_IMAGE.part dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/rctf-vm-image.XXXXXX")
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
  check_boot_ports
  if is_running; then
    log "VM already running (pid $(cat "$QEMU_PID"))"
    return 0
  fi
  ensure_base_image
  ensure_ssh_key
  write_seed
  start_seed_server
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
