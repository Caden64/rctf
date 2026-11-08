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
#   ./vm.sh selftest # unprivileged check of the pidfile authentication
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

# ---------------------------------------------------------------------------
# PID file authentication and pidfd signalling
# ---------------------------------------------------------------------------
# A bare PID cannot identify a process: PIDs are reused, and a pidfile can
# outlive a reboot. Every pidfile written by this script is therefore versioned
# and contains the kernel boot id, the process start time (/proc/<pid>/stat
# field 22, clock ticks since boot), the canonical executable, and the
# run-specific argv elements (this VM_DIR's pidfile / seed directory). A signal
# is sent only when *all* of them still match.
#
# Verification alone is not enough: a check-then-`kill <pid>` sequence still
# has a window in which the target exits and the PID is reused. All signalling
# therefore goes through pidguard.py, which opens a pidfd FIRST, validates the
# recorded identity while holding it, re-reads the start ticks immediately
# before the signal and sends TERM/KILL only through that same pidfd. Any
# mismatch is a stale pidfile: it is removed with a warning and no process is
# signalled.
PIDGUARD=$(cd -- "$(dirname -- "$0")" && pwd)/pidguard.py
[ -f "$PIDGUARD" ] || die "pidguard helper is missing at $PIDGUARD"
# Only the self-test populates this (with --test-hook=... entries).
PIDGUARD_HOOKS=()

current_boot_id() { cat /proc/sys/kernel/random/boot_id 2>/dev/null; }
process_start_ticks() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null; }
process_exe() { readlink "/proc/$1/exe" 2>/dev/null; }

# Required argv elements per process kind, as --require-arg=... options for
# pidguard.py. Recorded arguments from the pidfile are always checked too; the
# required ones pin this VM_DIR even if the record itself was tampered with.
pidguard_fill_required() { # <kind>; sets PIDGUARD_REQ
  PIDGUARD_REQ=()
  case "$1" in
    qemu) PIDGUARD_REQ=(--require-arg=-pidfile "--require-arg=$QEMU_PID") ;;
    seed)
      PIDGUARD_REQ=(
        --require-arg=-m --require-arg=http.server
        "--require-arg=$VM_SEED_PORT" --require-arg=--bind
        --require-arg=127.0.0.1 --require-arg=--directory
        "--require-arg=$SEED_DIR"
      )
      ;;
    *) return 1 ;;
  esac
}

pidfile_record() { # pidfile_record <file> <kind> <pid> [argv-element...]
  local file=$1 kind=$2 pid=$3 a tmp=$1.tmp.$$
  shift 3
  local boot start exe
  boot=$(current_boot_id) || return 1
  start=$(process_start_ticks "$pid") || return 1
  exe=$(process_exe "$pid") || return 1
  [ -n "$boot" ] && [ -n "$start" ] && [ -n "$exe" ] || return 1
  {
    printf 'version=2\nkind=%s\npid=%s\nboot_id=%s\nstart_ticks=%s\nexe=%s\n' \
      "$kind" "$pid" "$boot" "$start" "$exe"
    for a in "$@"; do printf 'arg=%s\n' "$a"; done
  } >"$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$file"
}

pidfile_verify() { # pidfile_verify <file> <kind>; sets PIDFILE_PID, returns 0 on match
  local file=$1 kind=$2 errf rc out
  PIDFILE_PID=
  PIDFILE_REASON=
  if ! pidguard_fill_required "$kind"; then
    PIDFILE_REASON="unknown process kind '$kind'"
    return 1
  fi
  errf=$(mktemp "${TMPDIR:-/tmp}/rctf-pidguard.XXXXXX") || {
    PIDFILE_REASON="could not create a temporary file"
    return 1
  }
  rc=0
  out=$(python3 "$PIDGUARD" verify --pidfile "$file" --kind "$kind" \
    "${PIDGUARD_REQ[@]}" 2>"$errf") || rc=$?
  PIDFILE_REASON=$(tr '\n' ' ' <"$errf" | sed -e 's/[[:space:]]*$//')
  rm -f "$errf"
  case "$rc" in
    0) PIDFILE_PID=$out; return 0 ;;
    1) return 1 ;;
    *)
      [ -n "$PIDFILE_REASON" ] ||
        PIDFILE_REASON="pidguard verify failed (exit $rc)"
      return 1
      ;;
  esac
}

pidfile_take() { # pidfile_take <file> <kind>: verified pid, or remove stale and return 1
  local file=$1 kind=$2
  [ -f "$file" ] || return 1
  if pidfile_verify "$file" "$kind"; then
    printf '%s\n' "$PIDFILE_PID"
    return 0
  fi
  log "WARNING: removing stale pidfile $file ($PIDFILE_REASON); not signalling any process"
  rm -f "$file"
  return 1
}

is_running() { pidfile_take "$QEMU_PID" qemu >/dev/null; }

# Stop a process recorded in a pidfile. pidguard.py does the whole
# authenticate -> TERM -> wait -> KILL sequence in one invocation, opening the
# pidfd before it validates and signalling only through that fd (see the file
# header). A stale record is removed and no process is signalled.
stop_recorded() { # stop_recorded <file> <kind> <label> <term-wait-ticks>
  local file=$1 kind=$2 label=$3 wait=$4 rc out reason
  [ -f "$file" ] || return 0
  if ! pidguard_fill_required "$kind"; then
    log "WARNING: refusing to stop $label: unknown process kind '$kind'"
    return 0
  fi
  rc=0
  out=$(python3 "$PIDGUARD" stop --pidfile "$file" --kind "$kind" \
    --label "$label" --term-wait-ticks "$wait" "${PIDGUARD_REQ[@]}" \
    ${PIDGUARD_HOOKS[@]+"${PIDGUARD_HOOKS[@]}"} 2>&1) || rc=$?
  reason=${out//$'\n'/ }
  case "$rc" in
    0)
      [ -z "$out" ] || printf '%s\n' "$out" >&2
      rm -f "$file"
      ;;
    1)
      log "WARNING: removing stale pidfile $file ($reason); not signalling any process"
      rm -f "$file"
      ;;
    *)
      log "WARNING: could not authenticate $label ($reason); leaving $file in place and not signalling"
      ;;
  esac
}

stop_seed_server() { stop_recorded "$SEED_PID" seed "cloud-init seed server" 25; }

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

check_boot_ports() {
  local qpid= spid=
  if pidfile_verify "$QEMU_PID" qemu; then qpid=$PIDFILE_PID; fi
  if pidfile_verify "$SEED_PID" seed; then spid=$PIDFILE_PID; fi
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
    # A seed server from an interrupted run is still serving. It is only
    # acceptable if its pidfile authenticates; check_boot_ports already refused
    # to boot when the port belonged to anything else.
    return 0
  fi
  command -v python3 >/dev/null || die "python3 is required to serve the cloud-init seed"
  nohup python3 -m http.server "$VM_SEED_PORT" --bind 127.0.0.1 --directory "$SEED_DIR" \
    >"$VM_DIR/seed-http.log" 2>&1 &
  local spid=$!
  pidfile_record "$SEED_PID" seed "$spid" \
    -m http.server "$VM_SEED_PORT" --bind 127.0.0.1 --directory "$SEED_DIR" ||
    die "could not record authenticated seed pidfile $SEED_PID"
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
  local qpid
  if qpid=$(pidfile_take "$QEMU_PID" qemu); then
    log "VM already running (pid $qpid)"
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
  qpid=$(cat "$QEMU_PID" 2>/dev/null) || qpid=
  [ -n "$qpid" ] || die "qemu did not write $QEMU_PID"
  pidfile_record "$QEMU_PID" qemu "$qpid" -pidfile "$QEMU_PID" ||
    die "could not record authenticated qemu pidfile $QEMU_PID"
  if ! wait_ssh; then
    tail -40 "$CONSOLE" >&2 || true
    die "VM did not become reachable over ssh"
  fi
  wait_cloud_init
}

# ---------------------------------------------------------------------------
# Unprivileged self-test for the pidfile authentication above. Runs on the
# host, needs no VM, no root and no port: it starts decoy `sleep`/`python3`
# processes and proves that a stale pidfile pointing at an unrelated live
# process is never signalled (while a correctly recorded one still is).
# ---------------------------------------------------------------------------
selftest() {
  local fail=0 line decoy start replacement
  local save_vm_dir=$VM_DIR save_qpid=$QEMU_PID save_spid=$SEED_PID
  local save_seed=$SEED_DIR save_sport=$VM_SEED_PORT
  SELFTEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/rctf-vmtest-selftest.XXXXXX")
  SELFTEST_DECOYS=()
  selftest_cleanup() {
    local p
    for p in "${SELFTEST_DECOYS[@]}"; do kill "$p" 2>/dev/null || true; done
    rm -rf "$SELFTEST_TMP"
  }
  trap selftest_cleanup EXIT
  local tmp=$SELFTEST_TMP
  local -a decoys=()
  VM_DIR=$tmp
  QEMU_PID=$tmp/qemu.pid
  SEED_PID=$tmp/seed-http.pid
  SEED_DIR=$tmp/seed
  VM_SEED_PORT=$((20000 + RANDOM % 20000))
  mkdir -p "$SEED_DIR"

  st_ok() { printf '  PASS: %s\n' "$*"; }
  st_bad() { printf '  FAIL: %s\n' "$*" >&2; fail=$((fail + 1)); }
  st_alive() { # st_alive <pid> <label>
    if kill -0 "$1" 2>/dev/null; then st_ok "$2: live decoy was NOT signalled"; else st_bad "$2: live decoy was signalled"; fi
  }
  st_dead() { # st_dead <pid> <label>
    if kill -0 "$1" 2>/dev/null; then st_bad "$2: process is still alive"; else st_ok "$2: process was stopped"; fi
  }
  st_message() { # st_message <label> <pattern>
    if grep -q -- "$2" "$tmp/stop.out"; then st_ok "$1: warning explains the mismatch"; else
      st_bad "$1: expected warning matching '$2', got: $(tr '\n' ' ' <"$tmp/stop.out")"
    fi
  }
  st_removed() { # st_removed <label>
    if [ -e "$QEMU_PID" ] || [ -e "$SEED_PID" ]; then st_bad "$1: stale pidfile was not removed"; else st_ok "$1: stale pidfile was removed"; fi
  }

  printf 'pidfile authentication selftest (no VM, no root)\n'

  # 1. Old-format pidfile (bare PID): cannot be authenticated at all.
  sleep 300 >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  printf '%s\n' "$decoy" >"$QEMU_PID"
  stop_recorded "$QEMU_PID" qemu "selftest bare-pid decoy" 2 >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "bare PID"
  st_message "bare PID" "unsupported legacy pidfile"
  st_removed "bare PID"

  # 2. Authentic-looking metadata, but an unrelated command line.
  sleep 300 >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  {
    printf 'version=2\nkind=qemu\npid=%s\nboot_id=%s\nstart_ticks=%s\nexe=%s\n' \
      "$decoy" "$(current_boot_id)" "$(process_start_ticks "$decoy")" "$(process_exe "$decoy")"
    printf 'arg=-pidfile\narg=%s\n' "$QEMU_PID"
  } >"$QEMU_PID"
  stop_recorded "$QEMU_PID" qemu "selftest cmdline decoy" 2 >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "command-line mismatch"
  st_message "command-line mismatch" "lacks required argument"
  st_removed "command-line mismatch"

  # 3. Correct executable/args but a different boot id (stale after reboot).
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  {
    printf 'version=2\nkind=qemu\npid=%s\nboot_id=00000000-0000-0000-0000-000000000000\nstart_ticks=%s\nexe=%s\n' \
      "$decoy" "$(process_start_ticks "$decoy")" "$(process_exe "$decoy")"
    printf 'arg=-pidfile\narg=%s\n' "$QEMU_PID"
  } >"$QEMU_PID"
  stop_recorded "$QEMU_PID" qemu "selftest boot-id decoy" 2 >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "boot-id mismatch"
  st_message "boot-id mismatch" "stale after reboot"
  st_removed "boot-id mismatch"

  # 4. Correct boot/exe/args but a different start time (PID reused).
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  start=$(process_start_ticks "$decoy")
  {
    printf 'version=2\nkind=qemu\npid=%s\nboot_id=%s\nstart_ticks=%s\nexe=%s\n' \
      "$decoy" "$(current_boot_id)" "$((start + 1))" "$(process_exe "$decoy")"
    printf 'arg=-pidfile\narg=%s\n' "$QEMU_PID"
  } >"$QEMU_PID"
  stop_recorded "$QEMU_PID" qemu "selftest start-time decoy" 2 >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "start-time mismatch"
  st_message "start-time mismatch" "pid reused"
  st_removed "start-time mismatch"

  # 5. Positive control: a process whose identity matches exactly IS stopped.
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  pidfile_record "$QEMU_PID" qemu "$decoy" -pidfile "$QEMU_PID" ||
    st_bad "could not record the positive-control pidfile"
  stop_recorded "$QEMU_PID" qemu "selftest positive control" 25 >"$tmp/stop.out" 2>&1
  st_dead "$decoy" "positive control"
  st_removed "positive control"

  # 6. PID-reuse race at the signal: the record validates, then the live start
  # ticks change before TERM (simulated through the helper's test hook). The
  # helper must re-check immediately before signalling and refuse.
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  pidfile_record "$QEMU_PID" qemu "$decoy" -pidfile "$QEMU_PID" ||
    st_bad "could not record the pid-reuse-race pidfile"
  PIDGUARD_HOOKS=(--test-hook=start-delta-after-validate=1)
  stop_recorded "$QEMU_PID" qemu "selftest pid-reuse decoy" 2 >"$tmp/stop.out" 2>&1
  PIDGUARD_HOOKS=()
  st_alive "$decoy" "pid-reuse race"
  st_message "pid-reuse race" "changed identity before SIGTERM"
  st_removed "pid-reuse race"

  # 7. A naive implementation re-resolves the PID after validation and could
  # signal the recycled PID. The hook makes the helper re-resolve to a second
  # live decoy; the pidfd still holds the validated target, so only that one is
  # stopped and the replacement is never signalled.
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  python3 -c 'import time; time.sleep(300)' >/dev/null 2>&1 &
  replacement=$!
  SELFTEST_DECOYS+=("$replacement")
  sleep 0.2
  pidfile_record "$QEMU_PID" qemu "$decoy" -pidfile "$QEMU_PID" ||
    st_bad "could not record the pid-reuse replacement pidfile"
  PIDGUARD_HOOKS=(--test-hook="reuse-after-validate=$replacement")
  stop_recorded "$QEMU_PID" qemu "selftest pid-reuse replacement" 25 >"$tmp/stop.out" 2>&1
  PIDGUARD_HOOKS=()
  st_dead "$decoy" "pid-reuse replacement: authenticated target"
  st_alive "$replacement" "pid-reuse replacement: recycled pid"
  st_message "pid-reuse replacement" "signalling only through the pidfd"
  st_removed "pid-reuse replacement"

  # 8. A stale seed-server pidfile is also not signalled.
  sleep 300 >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  printf '%s\n' "$decoy" >"$SEED_PID"
  stop_seed_server >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "stale seed pidfile"
  st_removed "stale seed pidfile"

  VM_DIR=$save_vm_dir
  QEMU_PID=$save_qpid
  SEED_PID=$save_spid
  SEED_DIR=$save_seed
  VM_SEED_PORT=$save_sport

  printf 'RESULT: pidfile selftest %s (%d failure(s))\n' \
    "$([ "$fail" -eq 0 ] && echo PASS || echo FAIL)" "$fail"
  [ "$fail" -eq 0 ]
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
    if pid=$(pidfile_take "$QEMU_PID" qemu); then
      echo "running pid=$pid ssh=127.0.0.1:$VM_SSH_PORT"
    else
      echo "stopped"
      exit 1
    fi
    ;;
  ip) echo "127.0.0.1:$VM_SSH_PORT" ;;
  stop)
    stop_recorded "$QEMU_PID" qemu "VM" 50
    stop_seed_server
    ;;
  selftest) selftest ;;
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
