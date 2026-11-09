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
#   ./vm.sh user     # print the ssh user for the selected image
#   ./vm.sh selftest # unprivileged check of the pidfile authentication
#
# Environment:
#   VM_DIR          default $HOME/.cache/rctf-vmtest
#   VM_IMAGE_DIR    directory holding the shared, verified base images
#                   (default $HOME/.cache/rctf-vmtest, so a per-run VM_DIR
#                   reuses the downloaded image instead of fetching it again)
#   VM_IMAGE        ubuntu-24.04 (default) | ubuntu-22.04 | debian-12
#   VM_SSH_PORT     default 2422
#   VM_SEED_PORT    default 8201
#   VM_MEM          default 4096 (MiB)
#   VM_SMP          default 4
#   VM_DISK         default 40G
#   VM_RUN_TOKEN    optional identity of the run that owns this VM_DIR. When
#                   set, an already-running VM is adopted only if its recorded
#                   owner token matches; otherwise create fails hard.
#   FORCE_ADOPT_VM  set to 1 to adopt a running VM with a different/missing
#                   owner token (documented escape hatch for debugging only)
#   UBUNTU_SERIES   default noble (ubuntu-24.04) / jammy (ubuntu-22.04)
#   UBUNTU_RELEASE  default 20261017 (noble) / 20261106 (jammy); dated
#                   cloud-image directories, never current/
#
# The cloud-init seed is served over the QEMU user-network gateway
# (10.0.2.2) and selected with the SMBIOS serial `ds=nocloud-net;s=...` trick, so
# no ISO, xorriso, cloud-localds or root are needed.
#
# Boot refuses to start when VM_SSH_PORT / VM_SEED_PORT are already bound by a
# process this vm.sh did not record. Kill only the PIDs in $VM_DIR, never by
# process name: other harness copies may run on the same machine.
set -euo pipefail

VM_DIR=${VM_DIR:-$HOME/.cache/rctf-vmtest}
VM_IMAGE_DIR=${VM_IMAGE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-vmtest}
VM_IMAGE=${VM_IMAGE:-ubuntu-24.04}
VM_RUN_TOKEN=${VM_RUN_TOKEN:-}
FORCE_ADOPT_VM=${FORCE_ADOPT_VM:-0}
VM_SSH_PORT=${VM_SSH_PORT:-2422}
VM_SEED_PORT=${VM_SEED_PORT:-8201}
VM_MEM=${VM_MEM:-4096}
VM_SMP=${VM_SMP:-4}
VM_DISK=${VM_DISK:-40G}

# ---------------------------------------------------------------------------
# Pinned cloud images
# ---------------------------------------------------------------------------
# Each entry is a dated directory plus the published digest of the exact image
# file. The cached base image is re-hashed against IMAGE_SHA256 before every
# boot; on first fetch the digest is cross-checked against the publisher's
# sums (and, for Ubuntu, their GPG signature with the pinned key).
#
# Debian publishes only SHA512SUMS in the dated cloud directory and does not
# sign that file, so the pinned SHA256 below is trust-on-first-use (computed
# from the fetched bytes on 2026-11-08) and the download is additionally
# checked against the published SHA512. Ubuntu publishes SHA256SUMS and
# SHA256SUMS.gpg, so both are verified.
case "$VM_IMAGE" in
  ubuntu-24.04)
    : "${UBUNTU_SERIES:=noble}"
    : "${UBUNTU_RELEASE:=20261017}"
    : "${UBUNTU_IMAGE:=noble-server-cloudimg-amd64.img}"
    : "${UBUNTU_IMAGE_SHA256:=04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94}"
    BASE_IMAGE_NAME=noble-base.img
    IMAGE_KIND=ubuntu
    VM_USER=ubuntu
    IMAGE_LABEL="Ubuntu 24.04 ($UBUNTU_SERIES/$UBUNTU_RELEASE)"
    ;;
  ubuntu-22.04)
    : "${UBUNTU_SERIES:=jammy}"
    : "${UBUNTU_RELEASE:=20261106}"
    : "${UBUNTU_IMAGE:=jammy-server-cloudimg-amd64.img}"
    : "${UBUNTU_IMAGE_SHA256:=f77bc6d59cb8deaa9657095736b5f5003f7705b47055f01823459715c967de6a}"
    BASE_IMAGE_NAME=jammy-base.img
    IMAGE_KIND=ubuntu
    VM_USER=ubuntu
    IMAGE_LABEL="Ubuntu 22.04 ($UBUNTU_SERIES/$UBUNTU_RELEASE)"
    ;;
  debian-12)
    : "${DEBIAN_RELEASE:=20261026-2643}"
    : "${DEBIAN_BASE_URL:=https://cloud.debian.org/images/cloud/bookworm}"
    DEBIAN_IMAGE_NAME=debian-12-generic-amd64-$DEBIAN_RELEASE.qcow2
    : "${DEBIAN_IMAGE_SHA256:=b242aca2f6dd2fba72c856edf1d9b0df72a9cd093560535142f1e9c9c8128f80}"
    # Digest published in bookworm/20261026-2643/SHA512SUMS.
    : "${DEBIAN_IMAGE_SHA512:=ba6073af9f789c0f7d6b73ec1b23bb207f07f06f2d31bfd3ce5e550fe43eb9415ef983dc0e039014cd59797e0cbea5c32592e6900fa8f974f2e4466b88ff0d80}"
    BASE_IMAGE_NAME=debian-12-base.img
    IMAGE_KIND=debian
    VM_USER=debian
    IMAGE_LABEL="Debian 12 ($DEBIAN_RELEASE)"
    ;;
  *)
    printf 'vm.sh: unknown VM_IMAGE %s (use ubuntu-24.04, ubuntu-22.04 or debian-12)\n' "$VM_IMAGE" >&2
    exit 2
    ;;
esac

if [ "$IMAGE_KIND" = ubuntu ]; then
  : "${UBUNTU_GPG_FINGERPRINT:=D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81}"
  : "${UBUNTU_BASE_URL:=https://cloud-images.ubuntu.com/$UBUNTU_SERIES/$UBUNTU_RELEASE}"
  : "${BASE_IMAGE_URL:=$UBUNTU_BASE_URL/$UBUNTU_IMAGE}"
  : "${SHA256SUMS_URL:=$UBUNTU_BASE_URL/SHA256SUMS}"
  : "${SHA256SUMS_GPG_URL:=$UBUNTU_BASE_URL/SHA256SUMS.gpg}"
  : "${UBUNTU_GPG_KEY_URL:=https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x$UBUNTU_GPG_FINGERPRINT}"
  IMAGE_NAME=$UBUNTU_IMAGE
  IMAGE_SHA256=$UBUNTU_IMAGE_SHA256
else
  : "${SHA512SUMS_URL:=$DEBIAN_BASE_URL/$DEBIAN_RELEASE/SHA512SUMS}"
  IMAGE_NAME=$DEBIAN_IMAGE_NAME
  IMAGE_SHA256=$DEBIAN_IMAGE_SHA256
  BASE_IMAGE_URL=$DEBIAN_BASE_URL/$DEBIAN_RELEASE/$DEBIAN_IMAGE_NAME
fi

# The base image is shared between run directories (and versions); the overlay,
# pidfiles, seed and console stay in VM_DIR so runs cannot interfere.
BASE_IMAGE=$VM_IMAGE_DIR/$BASE_IMAGE_NAME
OVERLAY=$VM_DIR/overlay.qcow2
SSH_KEY=$VM_DIR/id_ed25519
SEED_DIR=$VM_DIR/seed
QEMU_PID=$VM_DIR/qemu.pid
# QEMU's own -pidfile target: a bare numeric file written by QEMU. The
# authenticated record is built from it and atomically renamed onto
# $QEMU_PID, so a concurrent observer never sees a bare intermediate at the
# canonical path.
QEMU_RAW_PID=$QEMU_PID.raw
SEED_PID=$VM_DIR/seed-http.pid
CONSOLE=$VM_DIR/console.log

log() { printf '==> %s\n' "$*" >&2; }
die() {
  printf 'vm.sh: %s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Lifecycle serialisation
# ---------------------------------------------------------------------------
# Every command that can create, remove or rewrite a pidfile holds an
# exclusive flock for the whole operation. Observational commands (`status`,
# `pid`) take no lock because they never mutate the pidfile (see
# pidfile_observe). Daemons started below close fd 9 explicitly (9>&-) so they
# do not inherit the lock for their lifetime.
case "${1:-}" in
  create | start | stop | destroy)
    mkdir -p "$VM_DIR"
    exec 9>"$VM_DIR/.lifecycle.lock"
    flock -w "${VM_LOCK_TIMEOUT:-300}" 9 ||
      die "could not acquire the lifecycle lock $VM_DIR/.lifecycle.lock"
    ;;
esac

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
# before the signal and sends TERM/KILL only through that same pidfd. A
# definitely dead record (exit 1) is removed with a warning; an identity
# mismatch (4) or observation failure (3) keeps the pidfile and signals
# nothing, because a live process may still exist behind it.
PIDGUARD=$(cd -- "$(dirname -- "$0")" && pwd)/pidguard.py
[ -f "$PIDGUARD" ] || die "pidguard helper is missing at $PIDGUARD"
# Only the self-test populates this (with --test-hook=... entries).
PIDGUARD_HOOKS=()

current_boot_id() { cat /proc/sys/kernel/random/boot_id 2>/dev/null; }
process_start_ticks() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null; }
process_exe() { readlink "/proc/$1/exe" 2>/dev/null; }
process_pid_ns() { readlink "/proc/$1/ns/pid" 2>/dev/null; }

# Required argv elements per process kind, as --require-arg=... options for
# pidguard.py. Recorded arguments from the pidfile are always checked too; the
# required ones pin this VM_DIR even if the record itself was tampered with.
pidguard_fill_required() { # <kind>; sets PIDGUARD_REQ
  PIDGUARD_REQ=()
  case "$1" in
    qemu) PIDGUARD_REQ=(--require-arg=-pidfile "--require-arg=$QEMU_RAW_PID") ;;
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
  local boot start exe pid_ns
  boot=$(current_boot_id) || return 1
  start=$(process_start_ticks "$pid") || return 1
  exe=$(process_exe "$pid") || return 1
  pid_ns=$(process_pid_ns "$pid") || return 1
  [ -n "$boot" ] && [ -n "$start" ] && [ -n "$exe" ] && [ -n "$pid_ns" ] ||
    return 1
  {
    printf 'version=3\nkind=%s\npid=%s\nboot_id=%s\nstart_ticks=%s\nexe=%s\npid_ns=%s\n' \
      "$kind" "$pid" "$boot" "$start" "$exe" "$pid_ns"
    for a in "$@"; do printf 'arg=%s\n' "$a"; done
  } >"$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$file"
}

pidfile_verify() { # pidfile_verify <file> <kind>; sets PIDFILE_PID/REASON/STATUS
  # Returns the pidguard outcome unchanged: 0 authenticated, 1 definitely
  # stale (the record does not describe a live process), 3 observation failure
  # (the identity could not be read; nothing may be deleted or signalled).
  local file=$1 kind=$2 errf rc out
  PIDFILE_PID=
  PIDFILE_REASON=
  PIDFILE_STATUS=stale
  if ! pidguard_fill_required "$kind"; then
    PIDFILE_REASON="unknown process kind '$kind'"
    PIDFILE_STATUS=error
    return 2
  fi
  errf=$(mktemp "${TMPDIR:-/tmp}/rctf-pidguard.XXXXXX") || {
    PIDFILE_REASON="could not create a temporary file"
    PIDFILE_STATUS=error
    return 3
  }
  rc=0
  out=$(python3 "$PIDGUARD" verify --pidfile "$file" --kind "$kind" \
    "${PIDGUARD_REQ[@]}" 2>"$errf") || rc=$?
  PIDFILE_REASON=$(tr '\n' ' ' <"$errf" | sed -e 's/[[:space:]]*$//')
  rm -f "$errf"
  case "$rc" in
    0)
      PIDFILE_PID=$out
      PIDFILE_STATUS=running
      return 0
      ;;
    1)
      [ -n "$PIDFILE_REASON" ] || PIDFILE_REASON="stale pidfile"
      return 1
      ;;
    4)
      [ -n "$PIDFILE_REASON" ] || PIDFILE_REASON="identity mismatch"
      PIDFILE_STATUS=error
      return 4
      ;;
    *)
      [ -n "$PIDFILE_REASON" ] ||
        PIDFILE_REASON="pidguard verify failed (exit $rc)"
      PIDFILE_STATUS=error
      return 3
      ;;
  esac
}

# Observation only: never removes or rewrites a pidfile. `status`/`pid` and any
# other read-only command use this so a concurrent lifecycle command can never
# lose its record to a reader. Prints the authenticated pid on success.
pidfile_observe() { # pidfile_observe <file> <kind>
  local file=$1 kind=$2
  [ -f "$file" ] || {
    PIDFILE_STATUS=stopped
    return 1
  }
  pidfile_verify "$file" "$kind"
}

pidfile_take() { # pidfile_take <file> <kind>: mutate callers only; see pidfile_observe
  local file=$1 kind=$2
  [ -f "$file" ] || return 1
  pidfile_verify "$file" "$kind"
  case "$?" in
    0) printf '%s\n' "$PIDFILE_PID"; return 0 ;;
    1)
      log "WARNING: removing stale pidfile $file ($PIDFILE_REASON); not signalling any process"
      rm -f "$file"
      return 1
      ;;
    *)
      log "WARNING: could not observe $file ($PIDFILE_REASON); leaving it in place and not signalling"
      return 3
      ;;
  esac
}

is_running() { pidfile_observe "$QEMU_PID" qemu >/dev/null; }

# Stop a process recorded in a pidfile. pidguard.py does the whole
# authenticate -> TERM -> wait -> KILL sequence in one invocation, opening the
# pidfd before it validates and signalling only through that fd (see the file
# header). A stale record is removed and no process is signalled.
stop_recorded() { # stop_recorded <file> <kind> <label> <term-wait-ticks>
  # Returns 0 only when the recorded process is stopped or the record is
  # definitely stale. An observation failure (rc 3) or unsupported pidfd (rc 2)
  # returns nonzero and leaves the pidfile in place, so the caller must keep
  # every resource it protects (socket, overlay, seed dir).
  local file=$1 kind=$2 label=$3 wait=$4 rc out reason
  [ -f "$file" ] || return 0
  if ! pidguard_fill_required "$kind"; then
    log "WARNING: refusing to stop $label: unknown process kind '$kind'"
    return 2
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
      return 0
      ;;
    1)
      log "WARNING: removing stale pidfile $file ($reason); not signalling any process"
      rm -f "$file"
      return 0
      ;;
    4)
      log "WARNING: identity mismatch for $label ($reason); keeping $file and not signalling"
      return 4
      ;;
    *)
      log "WARNING: could not stop $label ($reason); leaving $file in place and not signalling"
      return 3
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
  if pidfile_observe "$QEMU_PID" qemu; then qpid=$PIDFILE_PID
  elif [ "$PIDFILE_STATUS" = error ]; then
    die "cannot determine whether the recorded VM is running ($PIDFILE_REASON); refusing to boot"
  fi
  if pidfile_observe "$SEED_PID" seed; then spid=$PIDFILE_PID
  elif [ "$PIDFILE_STATUS" = error ]; then
    die "cannot determine whether the recorded seed server is running ($PIDFILE_REASON); refusing to boot"
  fi
  check_port_free "$VM_SSH_PORT" "$qpid" "VM ssh"
  check_port_free "$VM_SEED_PORT" "$spid" "cloud-init seed"
}

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

# Verify the pinned image digest against the publisher's published sums.
# Returns 0 with a verified digest; dies on a mismatch. Ubuntu sums are also
# checked against a pinned GPG key; Debian publishes no signed sums file in the
# dated directory, so its download is checked against the published SHA512 in
# addition to the pinned SHA256 (documented in README.md).
verify_image_sums() {
  local dir=$1 pub got rc
  if [ "$IMAGE_KIND" = debian ]; then
    curl -fsSL --retry 3 --connect-timeout 20 -o "$dir/SHA512SUMS" "$SHA512SUMS_URL" ||
      die "could not download $SHA512SUMS_URL"
    pub=$(awk -v f="$IMAGE_NAME" '$2 == f || $2 == "*" f { print $1; exit }' "$dir/SHA512SUMS")
    [ -n "$pub" ] || die "published SHA512SUMS has no entry for $IMAGE_NAME"
    [ "$pub" = "$DEBIAN_IMAGE_SHA512" ] ||
      die "pinned SHA512 $DEBIAN_IMAGE_SHA512 does not match published $pub for $IMAGE_NAME (refusing to use it)"
    return 0
  fi

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
  mkdir -p "$VM_DIR" "$VM_IMAGE_DIR"
  local got sum
  if [ -f "$BASE_IMAGE" ]; then
    log "re-hashing cached $IMAGE_LABEL image $BASE_IMAGE"
    got=$(sha256_of "$BASE_IMAGE")
    if [ "$got" = "$IMAGE_SHA256" ]; then
      # Same temp+rename pattern as the download path: a concurrent run
      # never reads a half-written sidecar.
      sum=$(mktemp "$(dirname -- "$BASE_IMAGE")/.sha256.XXXXXX")
      printf '%s  %s\n' "$got" "$(basename "$BASE_IMAGE")" >"$sum"
      mv "$sum" "$BASE_IMAGE.sha256"
      return 0
    fi
    log "cached image digest mismatch (got $got, want $IMAGE_SHA256); discarding"
    rm -f "$BASE_IMAGE" "$BASE_IMAGE.sha256"
  fi
  command -v curl >/dev/null || die "curl is required"
  local dir tmp sum
  dir=$(mktemp -d "${TMPDIR:-/tmp}/rctf-vm-image.XXXXXX")
  # Private staging in the image directory: two concurrent runs must never
  # truncate or delete each other's download (a shared $BASE_IMAGE.part did),
  # and the final publish must be an atomic same-directory rename.
  tmp=$(mktemp "$(dirname -- "$BASE_IMAGE")/.download.XXXXXX")
  verify_image_sums "$dir"
  log "downloading $IMAGE_LABEL image (~600 MiB) to $BASE_IMAGE"
  curl -fL --retry 3 --connect-timeout 20 -o "$tmp" "$BASE_IMAGE_URL"
  local got
  got=$(sha256_of "$tmp")
  if [ "$got" != "$IMAGE_SHA256" ]; then
    rm -f "$tmp"
    rm -rf "$dir"
    die "downloaded image digest mismatch (got $got, want $IMAGE_SHA256)"
  fi
  mv "$tmp" "$BASE_IMAGE"
  sum=$(mktemp "$(dirname -- "$BASE_IMAGE")/.sha256.XXXXXX")
  printf '%s  %s\n' "$got" "$(basename "$BASE_IMAGE")" >"$sum"
  mv "$sum" "$BASE_IMAGE.sha256"
  sum=$(mktemp "$(dirname -- "$BASE_IMAGE")/.sha256.XXXXXX")
  printf 'image=%s\nurl=%s\ndigest=%s\nsums_url=%s\ndate=%s\n' \
    "$VM_IMAGE" "$BASE_IMAGE_URL" "$got" \
    "${SHA512SUMS_URL:-$SHA256SUMS_URL}" "$(date -Is)" >"$sum"
  mv "$sum" "$BASE_IMAGE.meta"
  rm -rf "$dir"
  log "$IMAGE_LABEL image verified ($got)"
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
  # scan of the "public" test interface cannot see port 22 (check h). Ubuntu
  # 24.04 socket-activates ssh while Ubuntu 22.04 and Debian 12 run
  # ssh.service, so runcmd restarts whichever unit the image actually enables.
  if [ "$IMAGE_KIND" = ubuntu ]; then
    cat >"$SEED_DIR/user-data" <<EOF
#cloud-config
users:
  - name: $VM_USER
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
  - [ sh, -c, "if systemctl is-enabled --quiet ssh.socket 2>/dev/null; then systemctl restart ssh.socket; else systemctl restart ssh; fi" ]
  - [ sh, -c, "sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 || true" ]
  - [ touch, /etc/rctf-vmtest-ready ]
EOF
  else
    cat >"$SEED_DIR/user-data" <<EOF
#cloud-config
users:
  - name: $VM_USER
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
runcmd:
  - [ systemctl, daemon-reload ]
  - [ sh, -c, "if systemctl is-enabled --quiet ssh.socket 2>/dev/null; then systemctl restart ssh.socket; else systemctl restart ssh; fi" ]
  - [ touch, /etc/rctf-vmtest-ready ]
EOF
  fi
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
    >"$VM_DIR/seed-http.log" 2>&1 9>&- &
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
    if ssh "${ssh_opts[@]}" "$VM_USER@127.0.0.1" true >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}

wait_cloud_init() {
  log "waiting for cloud-init (packages) - first boot can take a few minutes"
  local status rc=0
  status=$(timeout 1200 ssh "${ssh_opts[@]}" "$VM_USER@127.0.0.1" \
    'sudo cloud-init status --wait >/dev/null 2>&1; sudo cloud-init status' 2>&1) || rc=$?
  printf '%s\n' "$status" | sed 's/^/  cloud-init: /' >&2
  if [ "$rc" -ne 0 ] || ! printf '%s\n' "$status" | grep -q 'status: done'; then
    # A degraded cloud-init can be a transient package-mirror failure. The
    # readiness marker is written as the last runcmd of OUR seed, so it is the
    # authoritative "the seed was applied" signal; provisioning re-installs
    # every package anyway. Keep the status visible instead of hiding it.
    if ssh "${ssh_opts[@]}" "$VM_USER@127.0.0.1" 'test -f /etc/rctf-vmtest-ready'; then
      log "WARNING: cloud-init reported a non-clean status (rc=$rc); continuing because /etc/rctf-vmtest-ready exists"
    else
      tail -40 "$CONSOLE" >&2 || true
      die "cloud-init did not finish"
    fi
  fi
  if ! ssh "${ssh_opts[@]}" "$VM_USER@127.0.0.1" 'test -f /etc/rctf-vmtest-ready'; then
    die "VM did not finish provisioning (/etc/rctf-vmtest-ready missing)"
  fi
}

# ---------------------------------------------------------------------------
# Run ownership: boot must never adopt (and therefore later stop) a VM another
# run started. The run that boots writes a token into VM_DIR; an already-running
# authenticated VM is adopted only when the token matches (or when the caller
# opts in with FORCE_ADOPT_VM=1). Direct vm.sh usage without VM_RUN_TOKEN keeps
# the historical idempotent create behaviour.
# ---------------------------------------------------------------------------
OWNER_TOKEN_FILE=$VM_DIR/owner-token

write_run_token() {
  [ -n "$VM_RUN_TOKEN" ] || return 0
  local tmp=$VM_DIR/.owner-token.$$
  printf '%s\n' "$VM_RUN_TOKEN" >"$tmp" && mv -f "$tmp" "$OWNER_TOKEN_FILE"
}

run_owns_vm() {
  [ -n "$VM_RUN_TOKEN" ] || return 0
  local current=
  if [ -f "$OWNER_TOKEN_FILE" ]; then
    current=$(cat "$OWNER_TOKEN_FILE" 2>/dev/null) || current=
  fi
  [ "$current" = "$VM_RUN_TOKEN" ]
}

boot() {
  command -v qemu-system-x86_64 >/dev/null || die "qemu-system-x86_64 is required"
  command -v qemu-img >/dev/null || die "qemu-img is required"
  [ -r /dev/kvm ] || die "/dev/kvm is not readable (KVM is required)"
  mkdir -p "$VM_DIR"
  check_boot_ports
  local qpid
  if pidfile_observe "$QEMU_PID" qemu; then
    if ! run_owns_vm; then
      if [ "$FORCE_ADOPT_VM" = 1 ]; then
        log "WARNING: FORCE_ADOPT_VM=1: adopting VM pid $PIDFILE_PID, which this run did not start"
        write_run_token || die "could not record the owner token in $VM_DIR"
      else
        die "an authenticated VM this run did not start is already running in $VM_DIR (pid $PIDFILE_PID); refusing to adopt it (set FORCE_ADOPT_VM=1 to override)"
      fi
    fi
    log "VM already running (pid $PIDFILE_PID)"
    return 0
  fi
  if [ "$PIDFILE_STATUS" = error ]; then
    die "cannot determine whether the VM is running ($PIDFILE_REASON); refusing to boot"
  fi
  ensure_base_image
  ensure_ssh_key
  write_seed
  start_seed_server
  rm -f "$CONSOLE" "$QEMU_RAW_PID"
  if [ ! -f "$OVERLAY" ]; then
    log "creating qcow2 overlay (${VM_DISK})"
    qemu-img create -q -f qcow2 -b "$BASE_IMAGE" -F qcow2 "$OVERLAY" "$VM_DISK"
  fi
  # Record ownership before QEMU starts, so a boot that fails part-way is still
  # stopped by the run that started it (and never by an unrelated run).
  write_run_token || die "could not record the run owner token in $VM_DIR"
  log "booting VM (ssh 127.0.0.1:$VM_SSH_PORT)"
  qemu-system-x86_64 \
    -enable-kvm -cpu host -m "$VM_MEM" -smp "$VM_SMP" \
    -display none -serial "file:$CONSOLE" \
    -pidfile "$QEMU_RAW_PID" -daemonize \
    -drive "if=virtio,file=$OVERLAY,cache=writeback,discard=unmap" \
    -netdev "user,id=n0,hostfwd=tcp:127.0.0.1:${VM_SSH_PORT}-:22" \
    -device virtio-net-pci,netdev=n0 \
    -smbios "type=1,serial=ds=nocloud-net;s=http://10.0.2.2:${VM_SEED_PORT}/" 9>&-
  qpid=$(cat "$QEMU_RAW_PID" 2>/dev/null) || qpid=
  [ -n "$qpid" ] || die "qemu did not write $QEMU_RAW_PID"
  pidfile_record "$QEMU_PID" qemu "$qpid" -pidfile "$QEMU_RAW_PID" ||
    die "could not record authenticated qemu pidfile $QEMU_PID"
  # The bare numeric file is only an input to the authenticated record; remove
  # it so a concurrent observer can never read it as the live pidfile.
  rm -f "$QEMU_RAW_PID"
  if ! wait_ssh; then
    tail -40 "$CONSOLE" >&2 || true
    die "VM did not become reachable over ssh"
  fi
  wait_cloud_init
}

# Stop the recorded VM. Returns 0 only when shutdown is confirmed (stopped or
# definitively stale); an observation failure leaves the pidfile and returns
# nonzero so callers must keep the overlay/console/seed.
stop_vm() {
  local rc=0
  stop_recorded "$QEMU_PID" qemu "VM" 50 || rc=$?
  stop_seed_server || {
    [ "$rc" -ne 0 ] || rc=3
  }
  rm -f "$QEMU_RAW_PID"
  return "$rc"
}

# Destroy is allowed only after stop_vm confirmed the VM is gone. On an
# observation error every file is retained and the command exits nonzero.
destroy_vm() {
  local rc=0
  stop_vm || rc=$?
  if [ "$rc" -ne 0 ]; then
    log "REFUSING to remove $OVERLAY and the seed directory: VM shutdown is unconfirmed"
    return "$rc"
  fi
  log "removing overlay $OVERLAY"
  rm -f "$OVERLAY" "$CONSOLE" "$OWNER_TOKEN_FILE"
  rm -rf "$SEED_DIR"
  return 0
}

# ---------------------------------------------------------------------------
# Unprivileged self-test for the pidfile authentication above. Runs on the
# host, needs no VM, no root and no port: it starts decoy `sleep`/`python3`
# processes and proves that a stale pidfile pointing at an unrelated live
# process is never signalled (while a correctly recorded one still is).
# ---------------------------------------------------------------------------
selftest() {
  local fail=0 line decoy start replacement rc
  local save_vm_dir=$VM_DIR save_qpid=$QEMU_PID save_spid=$SEED_PID
  local save_seed=$SEED_DIR save_sport=$VM_SEED_PORT save_raw=$QEMU_RAW_PID
  local save_overlay=$OVERLAY save_console=$CONSOLE
  SELFTEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/rctf-vmtest-selftest.XXXXXX")
  SELFTEST_DECOYS=()
  selftest_cleanup() {
    local p
    for p in "${SELFTEST_DECOYS[@]}"; do kill "$p" 2>/dev/null || true; done
    rm -rf "$SELFTEST_TMP"
  }
  trap selftest_cleanup EXIT
  local tmp=$SELFTEST_TMP
  VM_DIR=$tmp
  QEMU_PID=$tmp/qemu.pid
  QEMU_RAW_PID=$tmp/qemu.pid.raw
  SEED_PID=$tmp/seed-http.pid
  SEED_DIR=$tmp/seed
  OVERLAY=$tmp/overlay.qcow2
  CONSOLE=$tmp/console.log
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
  st_exists() { # st_exists <path> <label>
    if [ -e "$1" ] || [ -L "$1" ]; then st_ok "$2"; else st_bad "$2 (missing)"; fi
  }
  st_absent() { # st_absent <path> <label>
    if [ -e "$1" ] || [ -L "$1" ]; then st_bad "$2 (still present)"; else st_ok "$2"; fi
  }

  printf 'pidfile authentication selftest (no VM, no root)\n'
  set +e

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
    printf 'version=3\nkind=qemu\npid=%s\nboot_id=%s\nstart_ticks=%s\nexe=%s\npid_ns=%s\n' \
      "$decoy" "$(current_boot_id)" "$(process_start_ticks "$decoy")" \
      "$(process_exe "$decoy")" "$(process_pid_ns "$decoy")"
    printf 'arg=-pidfile\narg=%s\n' "$QEMU_RAW_PID"
  } >"$QEMU_PID"
  stop_recorded "$QEMU_PID" qemu "selftest cmdline decoy" 2 >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "command-line mismatch"
  st_message "command-line mismatch" "lacks required argument"
  st_exists "$QEMU_PID" "command-line mismatch KEEPS the pidfile (the process may be the VM)"

  # 3. Correct executable/args but a different boot id (stale after reboot).
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_RAW_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  {
    printf 'version=3\nkind=qemu\npid=%s\nboot_id=00000000-0000-0000-0000-000000000000\nstart_ticks=%s\nexe=%s\npid_ns=%s\n' \
      "$decoy" "$(process_start_ticks "$decoy")" "$(process_exe "$decoy")" \
      "$(process_pid_ns "$decoy")"
    printf 'arg=-pidfile\narg=%s\n' "$QEMU_RAW_PID"
  } >"$QEMU_PID"
  stop_recorded "$QEMU_PID" qemu "selftest boot-id decoy" 2 >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "boot-id mismatch"
  st_message "boot-id mismatch" "stale after reboot"
  st_removed "boot-id mismatch"

  # 4. Correct boot/exe/args but a different start time (PID reused).
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_RAW_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  start=$(process_start_ticks "$decoy")
  {
    printf 'version=3\nkind=qemu\npid=%s\nboot_id=%s\nstart_ticks=%s\nexe=%s\npid_ns=%s\n' \
      "$decoy" "$(current_boot_id)" "$((start + 1))" \
      "$(process_exe "$decoy")" "$(process_pid_ns "$decoy")"
    printf 'arg=-pidfile\narg=%s\n' "$QEMU_RAW_PID"
  } >"$QEMU_PID"
  stop_recorded "$QEMU_PID" qemu "selftest start-time decoy" 2 >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "start-time mismatch"
  st_message "start-time mismatch" "pid reused"
  st_exists "$QEMU_PID" "start-time mismatch KEEPS the pidfile"

  # 5. Correct PID/boot/start/exe/argv but a different PID namespace. The same
  # numeric PID in another namespace is a different process and must never be
  # signalled when the *current* namespace does not match the record.
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_RAW_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  {
    printf 'version=3\nkind=qemu\npid=%s\nboot_id=%s\nstart_ticks=%s\nexe=%s\npid_ns=pid:[0]\n' \
      "$decoy" "$(current_boot_id)" "$(process_start_ticks "$decoy")" \
      "$(process_exe "$decoy")"
    printf 'arg=-pidfile\narg=%s\n' "$QEMU_RAW_PID"
  } >"$QEMU_PID"
  stop_recorded "$QEMU_PID" qemu "selftest pid-ns decoy" 2 >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "pid-namespace mismatch"
  st_message "pid-namespace mismatch" "different PID namespace"
  st_removed "pid-namespace mismatch"

  # 6. Positive control: a process whose identity matches exactly IS stopped.
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_RAW_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  pidfile_record "$QEMU_PID" qemu "$decoy" -pidfile "$QEMU_RAW_PID" ||
    st_bad "could not record the positive-control pidfile"
  stop_recorded "$QEMU_PID" qemu "selftest positive control" 25 >"$tmp/stop.out" 2>&1
  st_dead "$decoy" "positive control"
  st_removed "positive control"

  # 7. PID-reuse race at the signal: the record validates, then the live start
  # ticks change before TERM (simulated through the helper's test hook). The
  # helper must re-check immediately before signalling and refuse.
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_RAW_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  pidfile_record "$QEMU_PID" qemu "$decoy" -pidfile "$QEMU_RAW_PID" ||
    st_bad "could not record the pid-reuse-race pidfile"
  PIDGUARD_HOOKS=(--test-hook=start-delta-after-validate=1)
  stop_recorded "$QEMU_PID" qemu "selftest pid-reuse decoy" 2 >"$tmp/stop.out" 2>&1
  PIDGUARD_HOOKS=()
  st_alive "$decoy" "pid-reuse race"
  st_message "pid-reuse race" "changed identity before SIGTERM"
  st_exists "$QEMU_PID" "pid-reuse race KEEPS the pidfile"

  # 8. A naive implementation re-resolves the PID after validation and could
  # signal the recycled PID. The hook makes the helper re-resolve to a second
  # live decoy; the pidfd still holds the validated target, so only that one is
  # stopped and the replacement is never signalled.
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_RAW_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  python3 -c 'import time; time.sleep(300)' >/dev/null 2>&1 &
  replacement=$!
  SELFTEST_DECOYS+=("$replacement")
  sleep 0.2
  pidfile_record "$QEMU_PID" qemu "$decoy" -pidfile "$QEMU_RAW_PID" ||
    st_bad "could not record the pid-reuse replacement pidfile"
  PIDGUARD_HOOKS=(--test-hook="reuse-after-validate=$replacement")
  stop_recorded "$QEMU_PID" qemu "selftest pid-reuse replacement" 25 >"$tmp/stop.out" 2>&1
  PIDGUARD_HOOKS=()
  st_dead "$decoy" "pid-reuse replacement: authenticated target"
  st_alive "$replacement" "pid-reuse replacement: recycled pid"
  st_message "pid-reuse replacement" "signalling only through the pidfd"
  st_removed "pid-reuse replacement"

  # 9. An observation failure is NOT a stale identity: stop must return
  # nonzero, keep the pidfile, and leave the (live, authenticated) process
  # alone. Callers must then keep the socket/overlay/seed dir.
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_RAW_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  pidfile_record "$QEMU_PID" qemu "$decoy" -pidfile "$QEMU_RAW_PID" ||
    st_bad "could not record the observation-error pidfile"
  PIDGUARD_HOOKS=(--test-hook=force-probe-error)
  rc=0
  stop_recorded "$QEMU_PID" qemu "selftest observation error" 2 >"$tmp/stop.out" 2>&1 || rc=$?
  PIDGUARD_HOOKS=()
  if [ "$rc" -ne 0 ]; then st_ok "observation error: stop propagates a failure (rc=$rc)"; else
    st_bad "observation error: stop reported success"
  fi
  st_alive "$decoy" "observation error"
  st_exists "$QEMU_PID" "observation error: the pidfile was retained"
  st_message "observation error" "simulated observation failure"

  # 10. status/pid are observational: an injected observation failure must
  # return nonzero and leave the record intact (never delete it).
  cat >"$tmp/fake-guard.py" <<'PYGUARD'
import sys
print("simulated observation failure", file=sys.stderr)
sys.exit(3)
PYGUARD
  local save_guard=$PIDGUARD
  PIDGUARD=$tmp/fake-guard.py
  rc=0
  pidfile_observe "$QEMU_PID" qemu >/dev/null 2>&1 || rc=$?
  PIDGUARD=$save_guard
  if [ "$rc" -eq 3 ]; then st_ok "status observation failure is exit 3 (distinct from stopped)"; else
    st_bad "status observation failure returned $rc, expected 3"
  fi
  if [ "$PIDFILE_STATUS" = error ]; then st_ok "observation failure is reported as 'unknown', not 'stopped'"; else
    st_bad "observation failure was reported as $PIDFILE_STATUS"
  fi
  st_exists "$QEMU_PID" "status never removed the pidfile"

  # 11. Concurrent observational status while the record is repeatedly
  # rewritten must never remove a live VM's pidfile. The observer runs 60
  # times while the writer re-records the same live process.
  (
    obs_fail=0
    for _ in $(seq 1 60); do
      pidfile_observe "$QEMU_PID" qemu >/dev/null 2>&1 || obs_fail=$((obs_fail + 1))
    done
    printf '%s\n' "$obs_fail" >"$tmp/concurrent.fail"
  ) &
  local obs=$!
  for _ in $(seq 1 60); do
    pidfile_record "$QEMU_PID" qemu "$decoy" -pidfile "$QEMU_RAW_PID" || {
      st_bad "concurrent rewrite failed"
      break
    }
  done
  wait "$obs"
  if [ "$(cat "$tmp/concurrent.fail")" = 0 ]; then st_ok "concurrent status never observed a missing/mutated live pidfile"; else
    st_bad "concurrent status failed $(cat "$tmp/concurrent.fail") time(s)"
  fi
  if pidfile_observe "$QEMU_PID" qemu; then st_ok "live pidfile still authenticates after concurrent status/rewrite"; else
    st_bad "live pidfile was lost by concurrent status"
  fi

  # 12. destroy must refuse while the authenticated VM is still alive: the
  # overlay and seed directory are kept and the exit is nonzero.
  : >"$OVERLAY"
  : >"$CONSOLE"
  mkdir -p "$SEED_DIR"
  # Force the stop observation to fail: shutdown is unconfirmed while the VM
  # is still alive, so destroy must refuse.
  PIDGUARD_HOOKS=(--test-hook=force-probe-error)
  rc=0
  destroy_vm >"$tmp/destroy.out" 2>&1 || rc=$?
  PIDGUARD_HOOKS=()
  if [ "$rc" -ne 0 ]; then st_ok "destroy refuses while the VM is alive (rc=$rc)"; else
    st_bad "destroy reported success while the VM was alive"
  fi
  st_alive "$decoy" "destroy while alive"
  st_exists "$OVERLAY" "destroy while alive: overlay retained"
  st_exists "$CONSOLE" "destroy while alive: console retained"
  st_exists "$SEED_DIR" "destroy while alive: seed directory retained"
  st_exists "$QEMU_PID" "destroy while alive: pidfile retained"

  # 13. Once the authenticated VM is stopped, destroy removes the overlay.
  stop_recorded "$QEMU_PID" qemu "selftest destroy owner" 25 >"$tmp/stop.out" 2>&1
  st_dead "$decoy" "destroy owner"
  rc=0
  destroy_vm >"$tmp/destroy.out" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then st_ok "destroy succeeds after a confirmed stop"; else
    st_bad "destroy failed after a confirmed stop (rc=$rc): $(tr '\n' ' ' <"$tmp/destroy.out")"
  fi
  st_absent "$OVERLAY" "confirmed destroy removed the overlay"
  st_absent "$SEED_DIR" "confirmed destroy removed the seed directory"

  # 14. A stale seed-server pidfile is also not signalled.
  sleep 300 >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  printf '%s\n' "$decoy" >"$SEED_PID"
  stop_seed_server >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "stale seed pidfile"
  st_removed "stale seed pidfile"

  # 15. Run ownership: an already-running VM is adopted only by the run whose
  # token it records, so a concurrent/foreign run can never stop it.
  local save_token=$VM_RUN_TOKEN save_force=$FORCE_ADOPT_VM
  VM_RUN_TOKEN=run-a
  FORCE_ADOPT_VM=0
  write_run_token || st_bad "could not record the run owner token"
  if [ "$(cat "$OWNER_TOKEN_FILE" 2>/dev/null)" = run-a ]; then
    st_ok "the run token is recorded in the VM directory"
  else
    st_bad "the run token was not recorded"
  fi
  if run_owns_vm; then st_ok "the run that recorded the token owns the VM"; else
    st_bad "the run that recorded the token was not recognised"
  fi
  VM_RUN_TOKEN=run-b
  if run_owns_vm; then st_bad "another run's token was accepted (the VM would be adopted)"; else
    st_ok "a different run token is foreign and is refused"
  fi
  FORCE_ADOPT_VM=1
  write_run_token || st_bad "FORCE_ADOPT_VM did not record the new token"
  if run_owns_vm; then st_ok "FORCE_ADOPT_VM=1 takes ownership explicitly"; else
    st_bad "FORCE_ADOPT_VM=1 did not take ownership"
  fi
  rm -f "$OWNER_TOKEN_FILE"
  VM_RUN_TOKEN=run-c
  FORCE_ADOPT_VM=0
  if run_owns_vm; then st_bad "a VM with no owner token was adopted without FORCE_ADOPT_VM=1"; else
    st_ok "a VM with no owner token is foreign and is refused"
  fi
  VM_RUN_TOKEN=$save_token
  FORCE_ADOPT_VM=$save_force

  VM_DIR=$save_vm_dir
  QEMU_PID=$save_qpid
  QEMU_RAW_PID=$save_raw
  SEED_PID=$save_spid
  SEED_DIR=$save_seed
  OVERLAY=$save_overlay
  CONSOLE=$save_console
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
    exec ssh "${ssh_opts[@]}" "$VM_USER@127.0.0.1" "$@"
    ;;
  user | image)
    printf '%s\n' "$VM_USER"
    ;;
  status)
    if pidfile_observe "$QEMU_PID" qemu; then
      echo "running pid=$PIDFILE_PID ssh=127.0.0.1:$VM_SSH_PORT"
    elif [ "$PIDFILE_STATUS" = error ]; then
      echo "unknown ($PIDFILE_REASON)"
      exit 2
    else
      echo "stopped"
      exit 1
    fi
    ;;
  pid)
    if pidfile_observe "$QEMU_PID" qemu; then
      printf '%s\n' "$PIDFILE_PID"
    elif [ "$PIDFILE_STATUS" = error ]; then
      printf 'unknown (%s)\n' "$PIDFILE_REASON" >&2
      exit 2
    else
      exit 1
    fi
    ;;
  ip) echo "127.0.0.1:$VM_SSH_PORT" ;;
  stop) stop_vm ;;
  selftest) selftest ;;
  destroy) destroy_vm ;;
  *)
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
