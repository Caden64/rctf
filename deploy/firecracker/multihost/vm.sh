#!/usr/bin/env bash
#
# Named, throwaway QEMU VM for the multi-host Firecracker tests.
#
# This is a small generalisation of deploy/firecracker/vmtest/vm.sh (copied,
# not modified): the same Ubuntu 24.04 cloud image booted with KVM and QEMU
# user networking for management ssh. On top of that it adds a SECOND NIC
# connected to exactly one peer VM through a QEMU unix-datagram netdev: a
# point-to-point Ethernet link that exists only as two AF_UNIX socket files
# under the run directory. There is no multicast group, no UDP/TCP socket and
# no host bridge/tap, so nothing on any other machine can observe or inject
# traffic on the link (the directory is mode 0700 and the sockets are only
# reachable through it). Every file lives under $MH_VM_ROOT/<name> so any
# number of named VMs can coexist.
#
# Runs unprivileged on the developer machine. Everything privileged happens
# inside the VMs.
#
# Usage:
#   ./vm.sh --name host-a --ssh-port 2201 --seed-port 8101 \
#           --priv-ip 10.77.0.10 \
#           --link-local /run/dir/link/host-a.sock \
#           --link-peer  /run/dir/link/host-b.sock \
#           --mac-mgmt 52:54:00:77:0a:00 --mac-priv 52:54:00:77:0a:01 \
#           create|start|stop|destroy|status|ssh|pid|ip|console
#   ./vm.sh --name selftest selftest   # unprivileged pidfile-auth self-test
#
# The peer VM passes the two paths mirrored (its own --link-local is this VM's
# --link-peer). The directory must be mode 0700; it is created that way when
# missing but never loosened.
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
# Pidfiles are authenticated exactly like vmtest/vm.sh: they record the boot
# id, process start ticks, executable and run-specific argv. A stale pidfile
# (reboot, PID reuse, another run's directory) is removed with a warning and
# no process is signalled. Run `selftest` to prove that with decoy processes.
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
LINK_LOCAL=
LINK_PEER=
LINK_SPEC=
LINK_ROOT=${MH_LINK_ROOT:-}
MAC_MGMT=
MAC_PRIV=

usage() {
  sed -n '2,55p' "$0" | sed 's/^# \{0,1\}//'
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
    --link-local) LINK_LOCAL=${2:?}; shift 2 ;;
    --link-peer) LINK_PEER=${2:?}; shift 2 ;;
    --link-root) LINK_ROOT=${2:?}; shift 2 ;;
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

# A VM name becomes a directory component under MH_VM_ROOT. Reject '.'/'..'
# outright and allow only a conservative identifier; then require the resolved
# directory to be a direct child of the resolved root, so a symlink or a path
# trick can never make destroy touch a directory outside the run.
NAME_PROBLEM=
name_valid() { # name_valid <name>
  local name=$1 root dir
  NAME_PROBLEM=
  case "$name" in
    '' | . | ..)
      NAME_PROBLEM="invalid --name '$name'"
      return 1
      ;;
  esac
  case "$name" in
    *[!A-Za-z0-9_-]*)
      NAME_PROBLEM="invalid --name '$name' (allowed: A-Z a-z 0-9 _ -, must start alphanumeric)"
      return 1
      ;;
  esac
  case "$name" in
    [A-Za-z0-9]*) ;;
    *)
      NAME_PROBLEM="invalid --name '$name' (must start with a letter or digit)"
      return 1
      ;;
  esac
  root=$(realpath -m -- "$VM_ROOT") || {
    NAME_PROBLEM="cannot resolve MH_VM_ROOT '$VM_ROOT'"
    return 1
  }
  dir=$(realpath -m -- "$VM_ROOT/$name") || {
    NAME_PROBLEM="cannot resolve VM directory for '$name'"
    return 1
  }
  if [ "$dir" = "$root" ] || [ "$(dirname -- "$dir")" != "$root" ]; then
    NAME_PROBLEM="VM directory $dir is not a direct child of $root"
    return 1
  fi
  return 0
}

name_valid "$NAME" || die "$NAME_PROBLEM"

VM_DIR=$(realpath -m -- "$VM_ROOT/$NAME")
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
# QEMU writes a bare numeric pidfile here; the authenticated record is renamed
# onto $QEMU_PID atomically so no bare intermediate is observable.
QEMU_RAW_PID=$QEMU_PID.raw
SEED_PID=$VM_DIR/seed-http.pid
# Keep the serial log path short: qemu writes it by absolute path.
CONSOLE=$VM_DIR/console.log
LINKGUARD=$(cd -- "$(dirname -- "$0")" && pwd)/linkguard.py

# ---------------------------------------------------------------------------
# Lifecycle serialisation
# ---------------------------------------------------------------------------
# Two concurrent `vm.sh stop` / `create` calls for the same name (run.sh's
# cleanup trap racing a manual stop, two shells debugging the same VM) could
# otherwise interleave pidfile checks and link cleanup. Every lifecycle command
# holds an exclusive flock for the whole operation. Daemons started here close
# fd 9 explicitly (9>&-) so they do not inherit the lock for their lifetime.
case "$CMD" in
  create | start | stop | destroy | kill)
    mkdir -p "$VM_DIR"
    exec 9>"$VM_DIR/.lifecycle.lock"
    flock -w "${MH_LOCK_TIMEOUT:-300}" 9 ||
      die "could not acquire the lifecycle lock $VM_DIR/.lifecycle.lock"
    ;;
esac

ssh_opts=(
  -i "$SSH_KEY"
  -p "${SSH_PORT:-0}"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR
  -o ConnectTimeout=5
  -o ServerAliveInterval=10
  -o BatchMode=yes
)

# ---------------------------------------------------------------------------
# Private link validation
# ---------------------------------------------------------------------------
# The link is a pair of AF_UNIX datagram sockets: QEMU's `dgram` netdev binds
# this VM's path and sends every Ethernet frame to the peer path. It cannot
# leave the host: there is no multicast group, no UDP/TCP port and no host
# interface. The directory holding the sockets must be 0700 (and owned by this
# user) so no other local user can connect either.
#
# `linkguard.py` is the single trust boundary: the link directory must be a
# direct child of a trusted root (--link-root / MH_LINK_ROOT, default: the
# directory's parent), with no symlink anywhere up to that root, owned by this
# uid and not writable by group/other. Removal opens the directory with
# O_DIRECTORY|O_NOFOLLOW, re-checks its identity through the fd, lstats the
# basename through the same fd and only then unlinks an AF_UNIX socket owned by
# this uid. Validation and unlink therefore use the same object, not a path
# resolved twice.
cleanup_link_endpoint() { # cleanup_link_endpoint <path> <label>
  local path=$1 label=$2 dir root rc out
  [ -n "$path" ] || return 0
  dir=$(dirname -- "$path")
  root=${LINK_ROOT:-$(dirname -- "$dir")}
  rc=0
  out=$(python3 "$LINKGUARD" unlink --root "$root" --dir "$dir" --path "$path" 2>&1) || rc=$?
  case "$rc" in
    0)
      [ -z "$out" ] || log "$out"
      return 0
      ;;
    *)
      log "WARNING: refusing to unlink $label $path: ${out:-linkguard failed (exit $rc)}"
      return 1
      ;;
  esac
}

# The only caller-facing form: never unlink while an authenticated QEMU for
# this VM_DIR still runs or while its state cannot be observed.
cleanup_link_endpoint_if_stopped() { # <path> <label>
  [ -n "${1:-}" ] || return 0
  vm_running_state
  case "$VM_STATE" in
    stopped) cleanup_link_endpoint "$1" "$2" ;;
    running)
      log "WARNING: not unlinking $2 $1: an authenticated QEMU is still running"
      return 1
      ;;
    *)
      log "WARNING: not unlinking $2 $1: the VM state could not be observed"
      return 1
      ;;
  esac
}

prepare_link() {
  [ -n "$LINK_LOCAL" ] || die "--link-local is required"
  [ -n "$LINK_PEER" ] || die "--link-peer is required"
  [ "$LINK_LOCAL" != "$LINK_PEER" ] || die "--link-local and --link-peer must differ"
  local dir peer_dir root rc out
  case "$LINK_LOCAL" in
    */../* | */.. | */./* | */.) die "link socket paths must not contain '.' or '..' components: $LINK_LOCAL" ;;
  esac
  case "$LINK_PEER" in
    */../* | */.. | */./* | */.) die "link socket paths must not contain '.' or '..' components: $LINK_PEER" ;;
  esac
  dir=$(dirname -- "$LINK_LOCAL")
  peer_dir=$(dirname -- "$LINK_PEER")
  [ "$dir" = "$peer_dir" ] || die "link socket paths must share one directory ($dir vs $peer_dir)"
  case "$dir" in /*) ;; *) die "link directory must be absolute: $dir" ;; esac
  root=${LINK_ROOT:-$(dirname -- "$dir")}
  case "$root" in /*) ;; *) die "link root must be absolute: $root" ;; esac
  if [ ! -e "$dir" ]; then
    mkdir -p -- "$dir"
    chmod 700 -- "$dir"
  fi
  [ -f "$LINKGUARD" ] || die "linkguard helper is missing at $LINKGUARD"
  rc=0
  out=$(python3 "$LINKGUARD" check --root "$root" --dir "$dir" \
    --local "$LINK_LOCAL" --peer "$LINK_PEER" 2>&1) || rc=$?
  [ "$rc" -eq 0 ] || die "link endpoints failed validation: ${out:-linkguard failed (exit $rc)}"
  LINK_SPEC="dgram,id=n1,local.type=unix,local.path=$LINK_LOCAL,remote.type=unix,remote.path=$LINK_PEER"
}

# ---------------------------------------------------------------------------
# PID file authentication and pidfd signalling
# (ported from deploy/firecracker/vmtest/vm.sh; see pidguard.py)
# ---------------------------------------------------------------------------
# A bare PID cannot identify a process: PIDs are reused, and a pidfile can
# outlive a reboot. Every pidfile written by this script is therefore versioned
# and contains the kernel boot id, the process start time (/proc/<pid>/stat
# field 22, clock ticks since boot), the canonical executable, and the
# run-specific argv elements (this VM_DIR's pidfile / seed directory / link).
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
if [ ! -f "$PIDGUARD" ]; then
  # The canonical helper lives next to the vmtest harness it was copied from.
  PIDGUARD=$(cd -- "$(dirname -- "$0")/../vmtest" 2>/dev/null && pwd)/pidguard.py
fi
[ -f "$PIDGUARD" ] || die "pidguard helper is missing (looked next to this script and in ../vmtest/pidguard.py)"
# Only the self-test populates this (with --test-hook=... entries).
PIDGUARD_HOOKS=()

current_boot_id() { cat /proc/sys/kernel/random/boot_id 2>/dev/null; }
process_start_ticks() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null; }
process_exe() { readlink "/proc/$1/exe" 2>/dev/null; }
process_pid_ns() { readlink "/proc/$1/ns/pid" 2>/dev/null; }

# Required argv elements per process kind, as --require-arg=... options for
# pidguard.py. Recorded arguments from the pidfile are always checked too; the
# seed port is dynamic per VM, so the required arguments tie it to the
# run-specific seed directory and the recorded argv pins the exact port.
pidguard_fill_required() { # <kind>; sets PIDGUARD_REQ
  PIDGUARD_REQ=()
  case "$1" in
    qemu) PIDGUARD_REQ=(--require-arg=-pidfile "--require-arg=$QEMU_RAW_PID") ;;
    seed)
      PIDGUARD_REQ=(
        --require-arg=-m --require-arg=http.server
        --require-arg=--directory "--require-arg=$SEED_DIR"
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
  # 0 authenticated, 1 definitely stale, 3 observation failure. The caller
  # must never collapse 3 into 1: an unreadable /proc says nothing about
  # whether the process is alive.
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

# Observation only: never deletes or rewrites the record. Used by status/pid
# and by every cleanup decision.
pidfile_observe() { # pidfile_observe <file> <kind>
  local file=$1 kind=$2
  [ -f "$file" ] || {
    PIDFILE_STATUS=stopped
    return 1
  }
  pidfile_verify "$file" "$kind"
}

# Tri-state VM observation: 0 running, 1 stopped (definitely), 3 unknown.
vm_running_state() {
  local rc=0
  pidfile_observe "$QEMU_PID" qemu >/dev/null || rc=$?
  case "$rc" in
    0) VM_STATE=running ;;
    1) VM_STATE=stopped ;;
    *) VM_STATE=unknown ;;
  esac
  return "$rc"
}

pidfile_take() { # pidfile_take <file> <kind>: mutate-only callers
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
  # 0 = stopped or definitely stale; nonzero = unconfirmed (keep resources).
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

# Simulate a host crash: SIGKILL the authenticated QEMU through the pidfd and
# wait for it to go. Used by driver.ts instead of an authenticated-PID ->
# process.kill sequence, which had the same reuse window.
pidkill() { # pidkill <file> <kind> <label>
  local file=$1 kind=$2 label=$3 rc out reason
  [ -f "$file" ] || {
    log "no pidfile $file"
    return 1
  }
  if ! pidguard_fill_required "$kind"; then
    log "unknown process kind '$kind'"
    return 1
  fi
  rc=0
  out=$(python3 "$PIDGUARD" kill --pidfile "$file" --kind "$kind" \
    --label "$label" --signal SIGKILL "${PIDGUARD_REQ[@]}" \
    ${PIDGUARD_HOOKS[@]+"${PIDGUARD_HOOKS[@]}"} 2>&1) || rc=$?
  reason=${out//$'\n'/ }
  [ -z "$reason" ] || printf '%s\n' "$reason" >&2
  case "$rc" in
    0) rm -f "$file"; return 0 ;;
    1)
      log "WARNING: not killing $label: no authenticated process ($reason)"
      rm -f "$file"
      return 1
      ;;
    *)
      log "WARNING: could not authenticate $label ($reason); not signalling"
      return 1
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
check_port_free() { # check_port_free <port> <allowed-pid> <description>
  local port=$1 allow=$2 what=$3 pids pid comm
  [ -n "$port" ] || return 0
  if ! pids=$(listener_pids "$port"); then return 0; fi
  for pid in $pids; do
    if [ "$pid" != unknown ] && [ -n "$allow" ] && [ "$pid" = "$allow" ]; then
      continue
    fi
    if [ "$pid" = unknown ]; then
      die "$what port $port is already bound by an unidentifiable process; pick free ports (refusing to boot)"
    fi
    comm=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    die "$what port $port is already bound by pid $pid (${comm:-unknown}); pick free ports (refusing to boot)"
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
  check_port_free "$SSH_PORT" "$qpid" "VM ssh"
  check_port_free "$SEED_PORT" "$spid" "cloud-init seed"
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
  # point-to-point private link never exposes an ssh daemon.
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
      Description=multihost private link address
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
    >"$VM_DIR/seed-http.log" 2>&1 9>&- &
  local spid=$!
  pidfile_record "$SEED_PID" seed "$spid" \
    -m http.server "$SEED_PORT" --bind 127.0.0.1 --directory "$SEED_DIR" ||
    die "could not record authenticated seed pidfile $SEED_PID"
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
  check_boot_ports
  local qpid
  if pidfile_observe "$QEMU_PID" qemu; then
    log "VM already running (pid $PIDFILE_PID)"
    return 0
  fi
  if [ "$PIDFILE_STATUS" = error ]; then
    die "cannot determine whether the VM is running ($PIDFILE_REASON); refusing to boot"
  fi
  prepare_link
  ensure_base_image
  ensure_ssh_key
  write_seed
  start_seed_server
  rm -f "$CONSOLE" "$QEMU_RAW_PID"
  # The local AF_UNIX datagram socket may be left behind by a SIGKILLed QEMU
  # (scenario 5). No authenticated QEMU is running for this VM_DIR (above), so
  # removing the stale path is safe. The cleanup refuses to touch anything that
  # is not a socket of ours in the validated link directory, and refuses if the
  # state became unobservable in the meantime.
  cleanup_link_endpoint_if_stopped "$LINK_LOCAL" "stale local link endpoint" || {
    log "WARNING: a stale link endpoint could not be removed; QEMU may fail to bind $LINK_LOCAL"
  }
  if [ ! -f "$OVERLAY" ]; then
    log "creating qcow2 overlay (${VM_DISK})"
    qemu-img create -q -f qcow2 -b "$BASE_IMAGE" -F qcow2 "$OVERLAY" "$VM_DISK"
  fi
  log "booting VM (ssh 127.0.0.1:$SSH_PORT, private $PRIV_IP, link $LINK_LOCAL)"
  qemu-system-x86_64 \
    -enable-kvm -cpu host -m "$VM_MEM" -smp "$VM_SMP" \
    -display none -serial "file:$CONSOLE" \
    -pidfile "$QEMU_RAW_PID" -daemonize \
    -drive "if=virtio,file=$OVERLAY,cache=none,discard=unmap" \
    -netdev "user,id=n0,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22" \
    -device "virtio-net-pci,netdev=n0,mac=$MAC_MGMT" \
    -netdev "$LINK_SPEC" \
    -device "virtio-net-pci,netdev=n1,mac=$MAC_PRIV" \
    -smbios "type=1,serial=ds=nocloud;s=http://10.0.2.2:${SEED_PORT}/" 9>&-
  qpid=$(cat "$QEMU_RAW_PID" 2>/dev/null) || qpid=
  [ -n "$qpid" ] || die "qemu did not write $QEMU_RAW_PID"
  pidfile_record "$QEMU_PID" qemu "$qpid" -pidfile "$QEMU_RAW_PID" "$LINK_SPEC" ||
    die "could not record authenticated qemu pidfile $QEMU_PID"
  rm -f "$QEMU_RAW_PID"
  # Record the exact command line in the run directory: the driver and run.sh
  # assert from it that the private link is the local unix datagram and not a
  # multicast/socket/TCP netdev.
  tr '\0' '\n' <"/proc/$qpid/cmdline" >"$VM_DIR/qemu.cmdline" ||
    die "could not record qemu command line in $VM_DIR/qemu.cmdline"
  if ! wait_ssh; then
    tail -40 "$CONSOLE" >&2 || true
    die "VM did not become reachable over ssh"
  fi
  wait_cloud_init
}

# Stop the recorded VM and (only when shutdown is confirmed) remove the link
# endpoint. Returns nonzero if shutdown is unconfirmed; the caller must then
# keep the pidfile, socket and disk.
stop_vm() {
  local rc=0
  stop_recorded "$QEMU_PID" qemu "VM $NAME" 50 || rc=$?
  stop_seed_server || {
    [ "$rc" -ne 0 ] || rc=3
  }
  rm -f "$QEMU_RAW_PID"
  if [ "$rc" -ne 0 ]; then
    log "shutdown is unconfirmed; keeping the pidfile, link endpoint and overlay"
    return "$rc"
  fi
  cleanup_link_endpoint_if_stopped "$LINK_LOCAL" "local link endpoint" ||
    log "WARNING: link endpoint $LINK_LOCAL was not removed"
  return 0
}

# Destroy may remove the overlay/console/seed only after stop_vm confirmed the
# VM is gone. Anything else is a hard failure (exit nonzero, files retained).
destroy_vm() {
  local rc=0
  stop_vm || rc=$?
  if [ "$rc" -ne 0 ]; then
    log "REFUSING to remove the overlay, console and seed directory for $NAME: VM shutdown is unconfirmed"
    return "$rc"
  fi
  log "removing overlay and console for $NAME"
  rm -f "$OVERLAY" "$CONSOLE" "$VM_DIR/qemu.cmdline"
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
  local fail=0 line decoy start replacement rc obs
  local save_name=$NAME save_vm_root=$VM_ROOT save_vm_dir=$VM_DIR
  local save_qpid=$QEMU_PID save_spid=$SEED_PID
  local save_seed=$SEED_DIR save_sport=$SEED_PORT save_raw=$QEMU_RAW_PID
  local save_overlay=$OVERLAY save_console=$CONSOLE
  local save_link_local=$LINK_LOCAL save_link_peer=$LINK_PEER
  local save_link_spec=$LINK_SPEC save_link_root=$LINK_ROOT
  SELFTEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/rctf-mh-selftest.XXXXXX")
  SELFTEST_DECOYS=()
  selftest_cleanup() {
    local p
    for p in ${SELFTEST_DECOYS[@]+"${SELFTEST_DECOYS[@]}"}; do kill "$p" 2>/dev/null || true; done
    rm -rf "$SELFTEST_TMP"
  }
  trap selftest_cleanup EXIT
  local tmp=$SELFTEST_TMP
  NAME=selftest
  VM_DIR=$tmp
  QEMU_PID=$tmp/qemu.pid
  QEMU_RAW_PID=$tmp/qemu.pid.raw
  SEED_PID=$tmp/seed-http.pid
  SEED_DIR=$tmp/seed
  OVERLAY=$tmp/overlay.qcow2
  CONSOLE=$tmp/console.log
  SEED_PORT=$((20000 + RANDOM % 20000))
  LINK_LOCAL=
  LINK_PEER=
  LINK_SPEC=
  LINK_ROOT=$tmp
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
  st_explains() { # st_explains <file> <label> <pattern>
    if grep -q -- "$3" "$1"; then st_ok "$2"; else
      st_bad "$2: expected '$3' in $(tr '\n' ' ' <"$1")"
    fi
  }
  st_guard() { # st_guard <label> <expected-rc> <command...>
    local label=$1 want=$2
    shift 2
    rc=0
    "$@" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq "$want" ]; then st_ok "$label (exit $rc)"; else
      st_bad "$label: exit $rc, expected $want"
    fi
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
  st_exists "$QEMU_PID" "identity mismatch KEEPS the pidfile (the process may be the VM)"

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

  # 5. Correct PID/boot/start/exe/argv but a different PID namespace.
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

  # 6. Correct identity but a recorded link argument from another run.
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_RAW_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  {
    printf 'version=3\nkind=qemu\npid=%s\nboot_id=%s\nstart_ticks=%s\nexe=%s\npid_ns=%s\n' \
      "$decoy" "$(current_boot_id)" "$(process_start_ticks "$decoy")" \
      "$(process_exe "$decoy")" "$(process_pid_ns "$decoy")"
    printf 'arg=-pidfile\narg=%s\n' "$QEMU_RAW_PID"
    printf 'arg=dgram,id=n1,local.type=unix,local.path=%s/other-run.sock\n' "$tmp"
  } >"$QEMU_PID"
  stop_recorded "$QEMU_PID" qemu "selftest other-run decoy" 2 >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "other-run link argument"
  st_message "other-run link argument" "lacks recorded argument"
  st_exists "$QEMU_PID" "other-run link argument KEEPS the pidfile"

  # 7. Positive control: a process whose identity matches exactly IS stopped.
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_RAW_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  pidfile_record "$QEMU_PID" qemu "$decoy" -pidfile "$QEMU_RAW_PID" ||
    st_bad "could not record the positive-control pidfile"
  stop_recorded "$QEMU_PID" qemu "selftest positive control" 25 >"$tmp/stop.out" 2>&1
  st_dead "$decoy" "positive control"
  st_removed "positive control"

  # 8. PID-reuse race at the signal (test hook).
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

  # 9. A naive implementation re-resolves the PID after validation; the pidfd
  # still holds the validated target, so only that one is stopped.
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

  # 10. Name validation: '.'/'..'/separators/dots are rejected, and a symlink
  # under the root may not resolve outside it.
  VM_ROOT=$tmp/names
  mkdir -p "$VM_ROOT"
  st_guard "name '.' is rejected" 1 name_valid .
  st_guard "name '..' is rejected" 1 name_valid ..
  st_guard "name 'a/b' is rejected" 1 name_valid a/b
  st_guard "name '.hidden' is rejected" 1 name_valid .hidden
  st_guard "name '-x' is rejected" 1 name_valid -x
  st_guard "name 'host-a' is accepted" 0 name_valid host-a
  st_guard "name 'a_b-2' is accepted" 0 name_valid a_b-2
  ln -s / "$VM_ROOT/escape"
  st_guard "name resolving outside the root (symlink) is rejected" 1 name_valid escape
  VM_ROOT=$save_vm_root

  # 11. Link validation: direct child of a trusted root, 0700, no symlinks;
  # endpoints must be direct children of that directory.
  mkdir -p "$tmp/links" "$tmp/linkdir"
  chmod 700 "$tmp/links" "$tmp/linkdir"
  LINKDIR=$tmp/linkdir
  st_guard "valid link directory/endpoints accepted" 0 \
    python3 "$LINKGUARD" check --root "$tmp" --dir "$LINKDIR" \
      --local "$LINKDIR/a.sock" --peer "$LINKDIR/b.sock"
  ln -s "$LINKDIR" "$tmp/linkdir-link"
  st_guard "symlinked link directory rejected" 3 \
    python3 "$LINKGUARD" check --root "$tmp" --dir "$tmp/linkdir-link" \
      --local "$tmp/linkdir-link/a.sock" --peer "$tmp/linkdir-link/b.sock"
  chmod 755 "$LINKDIR"
  st_guard "group/other-readable link directory rejected" 3 \
    python3 "$LINKGUARD" check --root "$tmp" --dir "$LINKDIR" \
      --local "$LINKDIR/a.sock" --peer "$LINKDIR/b.sock"
  chmod 700 "$LINKDIR"
  st_guard "endpoint outside the link directory rejected" 3 \
    python3 "$LINKGUARD" check --root "$tmp" --dir "$LINKDIR" \
      --local "$tmp/elsewhere.sock" --peer "$LINKDIR/b.sock"
  st_guard "non-direct-child link directory rejected" 3 \
    python3 "$LINKGUARD" check --root "$tmp" --dir "$tmp" \
      --local "$tmp/a.sock" --peer "$tmp/b.sock"
  rm -f "$tmp/linkdir-link"

  # 12. Link endpoint safety: a regular file given as --link-local must never
  # be unlinked.
  mkdir -p "$tmp/link"
  chmod 700 "$tmp/link"
  LINK_ROOT=$tmp
  LINK_LOCAL=$tmp/link/host-a.sock
  LINK_PEER=$tmp/link/host-b.sock
  printf 'do not delete this file\n' >"$LINK_LOCAL"
  cleanup_link_endpoint_if_stopped "$LINK_LOCAL" "selftest regular file" >"$tmp/link.out" 2>&1
  st_exists "$LINK_LOCAL" "regular file given as --link-local was NOT deleted"
  st_explains "$tmp/link.out" "regular file: refusal explains the type" "not a unix socket"
  rm -f "$LINK_LOCAL"

  # 13. A socket owned by a QEMU that is still running is not unlinked.
  python3 -c 'import socket,sys,time; s=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM); s.bind(sys.argv[1]); time.sleep(300)' \
    "$LINK_LOCAL" -pidfile "$QEMU_RAW_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  for _ in $(seq 1 50); do [ -S "$LINK_LOCAL" ] && break; sleep 0.1; done
  pidfile_record "$QEMU_PID" qemu "$decoy" -pidfile "$QEMU_RAW_PID" ||
    st_bad "could not record the live-socket pidfile"
  cleanup_link_endpoint_if_stopped "$LINK_LOCAL" "selftest live socket" >"$tmp/link.out" 2>&1
  st_alive "$decoy" "live qemu socket: decoy was NOT signalled"
  st_exists "$LINK_LOCAL" "socket of a still-running QEMU was NOT unlinked"
  st_explains "$tmp/link.out" "live qemu socket: refusal explains the owner" "still running"

  # 14. An observation error must not look like a stale record: the pidfile
  # AND the socket are kept and nothing is signalled.
  cat >"$tmp/fake-guard.py" <<'PYGUARD'
import sys
print("simulated observation failure", file=sys.stderr)
sys.exit(3)
PYGUARD
  local save_guard=$PIDGUARD
  PIDGUARD_HOOKS=(--test-hook=force-probe-error)
  rc=0
  stop_recorded "$QEMU_PID" qemu "selftest observation error" 2 >"$tmp/stop.out" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then st_ok "observation error: stop propagates a failure (rc=$rc)"; else
    st_bad "observation error: stop reported success"
  fi
  st_alive "$decoy" "observation error"
  st_exists "$QEMU_PID" "observation error: pidfile retained"
  cleanup_link_endpoint_if_stopped "$LINK_LOCAL" "selftest running socket" >"$tmp/link.out" 2>&1
  st_exists "$LINK_LOCAL" "observation error: live socket retained (state still running)"
  st_explains "$tmp/link.out" "observation error: link refusal explains the running VM" "still running"
  PIDGUARD_HOOKS=()
  # The same refusal when the observation itself fails (status error).
  PIDGUARD=$tmp/fake-guard.py
  cleanup_link_endpoint_if_stopped "$LINK_LOCAL" "selftest unobservable socket" >"$tmp/link.out" 2>&1
  st_exists "$LINK_LOCAL" "observation error: live socket retained (state unobservable)"
  st_explains "$tmp/link.out" "observation error: link refusal explains the state" "could not be observed"
  PIDGUARD=$save_guard

  # 15. status/pid are observational: an injected observation failure returns
  # a distinct nonzero and keeps the record.
  PIDGUARD=$tmp/fake-guard.py
  rc=0
  pidfile_observe "$QEMU_PID" qemu >/dev/null 2>&1 || rc=$?
  PIDGUARD=$save_guard
  if [ "$rc" -eq 3 ]; then st_ok "status observation failure is exit 3 (distinct from stopped)"; else
    st_bad "status observation failure returned $rc, expected 3"
  fi
  st_exists "$QEMU_PID" "status never removed the pidfile"

  # 16. Concurrent status while the record is repeatedly rewritten must never
  # remove a live VM's pidfile.
  (
    obs_fail=0
    for _ in $(seq 1 60); do
      pidfile_observe "$QEMU_PID" qemu >/dev/null 2>&1 || obs_fail=$((obs_fail + 1))
    done
    printf '%s\n' "$obs_fail" >"$tmp/concurrent.fail"
  ) &
  obs=$!
  for _ in $(seq 1 60); do
    pidfile_record "$QEMU_PID" qemu "$decoy" -pidfile "$QEMU_RAW_PID" || {
      st_bad "concurrent rewrite failed"
      break
    }
  done
  wait "$obs"
  if [ "$(cat "$tmp/concurrent.fail")" = 0 ]; then st_ok "concurrent status never lost the live pidfile"; else
    st_bad "concurrent status failed $(cat "$tmp/concurrent.fail") time(s)"
  fi
  if pidfile_observe "$QEMU_PID" qemu; then st_ok "live pidfile still authenticates after concurrent status/rewrite"; else
    st_bad "live pidfile was lost by concurrent status"
  fi

  # 17. destroy must refuse while shutdown is unconfirmed: overlay, console,
  # seed dir, pidfile and socket are all retained.
  : >"$OVERLAY"
  : >"$CONSOLE"
  mkdir -p "$SEED_DIR"
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
  st_exists "$LINK_LOCAL" "destroy while alive: link socket retained"

  # 18. Once the authenticated QEMU is stopped, the socket and overlay ARE
  # removed by stop/destroy.
  stop_recorded "$QEMU_PID" qemu "selftest link owner" 25 >"$tmp/stop.out" 2>&1
  st_dead "$decoy" "link owner"
  cleanup_link_endpoint_if_stopped "$LINK_LOCAL" "selftest stale socket" >"$tmp/link.out" 2>&1
  st_absent "$LINK_LOCAL" "stale socket of a stopped QEMU was removed"
  rc=0
  destroy_vm >"$tmp/destroy.out" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then st_ok "destroy succeeds after a confirmed stop"; else
    st_bad "destroy failed after a confirmed stop (rc=$rc): $(tr '\n' ' ' <"$tmp/destroy.out")"
  fi
  st_absent "$OVERLAY" "confirmed destroy removed the overlay"
  st_absent "$SEED_DIR" "confirmed destroy removed the seed directory"

  # 19. A symlink is not a socket and must not be unlinked.
  printf 'symlink target\n' >"$tmp/link/target"
  ln -s "$tmp/link/target" "$LINK_LOCAL"
  cleanup_link_endpoint_if_stopped "$LINK_LOCAL" "selftest symlink" >"$tmp/link.out" 2>&1
  st_exists "$LINK_LOCAL" "symlink given as --link-local was NOT deleted"
  st_exists "$tmp/link/target" "symlink target was NOT deleted"
  rm -f "$LINK_LOCAL" "$tmp/link/target"

  # 20. A stale seed-server pidfile is also not signalled.
  sleep 300 >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  printf '%s\n' "$decoy" >"$SEED_PID"
  stop_seed_server >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "stale seed pidfile"
  st_removed "stale seed pidfile"

  NAME=$save_name
  VM_ROOT=$save_vm_root
  VM_DIR=$save_vm_dir
  QEMU_PID=$save_qpid
  QEMU_RAW_PID=$save_raw
  SEED_PID=$save_spid
  SEED_DIR=$save_seed
  OVERLAY=$save_overlay
  CONSOLE=$save_console
  SEED_PORT=$save_sport
  LINK_LOCAL=$save_link_local
  LINK_PEER=$save_link_peer
  LINK_SPEC=$save_link_spec
  LINK_ROOT=$save_link_root

  printf 'RESULT: pidfile selftest %s (%d failure(s))\n' \
    "$([ "$fail" -eq 0 ] && echo PASS || echo FAIL)" "$fail"
  [ "$fail" -eq 0 ]
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
    if pidfile_observe "$QEMU_PID" qemu; then
      echo "running name=$NAME pid=$PIDFILE_PID ssh=127.0.0.1:${SSH_PORT:-?} priv=${PRIV_IP:-?} link=${LINK_LOCAL:-?}"
    elif [ "$PIDFILE_STATUS" = error ]; then
      echo "unknown name=$NAME ($PIDFILE_REASON)"
      exit 2
    else
      echo "stopped name=$NAME"
      exit 1
    fi
    ;;
  ip)
    echo "127.0.0.1:${SSH_PORT:-?}"
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
  console)
    tail -n "${2:-80}" "$CONSOLE"
    ;;
  stop) stop_vm ;;
  kill)
    # Crash simulation for driver.ts: no TERM, just an authenticated SIGKILL
    # through a pidfd. The link endpoint is left for the next boot/stop.
    pidkill "$QEMU_PID" qemu "VM $NAME"
    ;;
  selftest) selftest ;;
  destroy)
    destroy_vm
    ;;
  *)
    usage
    ;;
esac
