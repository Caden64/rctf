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
prepare_link() {
  [ -n "$LINK_LOCAL" ] || die "--link-local is required"
  [ -n "$LINK_PEER" ] || die "--link-peer is required"
  [ "$LINK_LOCAL" != "$LINK_PEER" ] || die "--link-local and --link-peer must differ"
  local dir peer_dir mode owner
  dir=$(dirname -- "$LINK_LOCAL")
  peer_dir=$(dirname -- "$LINK_PEER")
  [ "$dir" = "$peer_dir" ] || die "link socket paths must share one directory ($dir vs $peer_dir)"
  case "$dir" in /*) ;; *) die "link directory must be absolute: $dir" ;; esac
  [ ${#LINK_LOCAL} -le 103 ] || die "unix socket path is too long (${#LINK_LOCAL} > 103): $LINK_LOCAL"
  [ ${#LINK_PEER} -le 103 ] || die "unix socket path is too long (${#LINK_PEER} > 103): $LINK_PEER"
  if [ ! -d "$dir" ]; then
    mkdir -p -- "$dir"
    chmod 700 -- "$dir"
  fi
  mode=$(stat -c '%a' -- "$dir")
  owner=$(stat -c '%u' -- "$dir")
  [ "$mode" = 700 ] || die "link directory $dir is mode $mode, expected 700 (would expose the private link)"
  [ "$owner" = "$(id -u)" ] || die "link directory $dir is owned by uid $owner, expected $(id -u)"
  LINK_SPEC="dgram,id=n1,local.type=unix,local.path=$LINK_LOCAL,remote.type=unix,remote.path=$LINK_PEER"
}

# ---------------------------------------------------------------------------
# PID file authentication (ported from deploy/firecracker/vmtest/vm.sh)
# ---------------------------------------------------------------------------
# A bare PID cannot identify a process: PIDs are reused, and a pidfile can
# outlive a reboot. Every pidfile written by this script is therefore versioned
# and contains the kernel boot id, the process start time (/proc/<pid>/stat
# field 22, clock ticks since boot), the canonical executable, and the
# run-specific argv elements (this VM_DIR's pidfile / seed directory / link).
# A signal is sent only when *all* of them still match. Anything else is
# treated as a stale pidfile: it is removed with a warning and no process is
# signalled.
current_boot_id() { cat /proc/sys/kernel/random/boot_id 2>/dev/null; }
process_start_ticks() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null; }
process_exe() { readlink "/proc/$1/exe" 2>/dev/null; }
cmdline_digest() { sha256sum "/proc/$1/cmdline" 2>/dev/null | awk '{print $1}'; }

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
  local file=$1 kind=$2 line key val
  local version= pid= boot= start= exe=
  local -a recorded=() live=() required=()
  PIDFILE_PID=
  PIDFILE_REASON=
  [ -f "$file" ] || { PIDFILE_REASON="file is missing"; return 1; }
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [[ $line != *=* ]]; then
      PIDFILE_REASON="unsupported legacy pidfile (bare PID '$line'); cannot authenticate"
      return 1
    fi
    key=${line%%=*}
    val=${line#*=}
    case "$key" in
      version) version=$val ;;
      kind) [ "$val" = "$kind" ] || { PIDFILE_REASON="kind is '$val', expected '$kind'"; return 1; } ;;
      pid) pid=$val ;;
      boot_id) boot=$val ;;
      start_ticks) start=$val ;;
      exe) exe=$val ;;
      arg) recorded+=("$val") ;;
      *) PIDFILE_REASON="unknown field '$key'"; return 1 ;;
    esac
  done <"$file"
  [ "$version" = 2 ] || { PIDFILE_REASON="unsupported pidfile version '${version:-none}'"; return 1; }
  case "$pid" in '' | *[!0-9]*) PIDFILE_REASON="invalid pid '$pid'"; return 1 ;; esac
  if [ "$boot" != "$(current_boot_id)" ]; then
    PIDFILE_REASON="recorded boot id '${boot:-none}' != current '$(current_boot_id)' (stale after reboot)"
    return 1
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    PIDFILE_REASON="pid $pid is not running"
    return 1
  fi
  if [ "$start" != "$(process_start_ticks "$pid")" ]; then
    PIDFILE_REASON="pid $pid start ticks '${start:-none}' != live '$(process_start_ticks "$pid")' (pid reused)"
    return 1
  fi
  if [ "$exe" != "$(process_exe "$pid")" ]; then
    PIDFILE_REASON="pid $pid executable '${exe:-none}' != live '$(process_exe "$pid")'"
    return 1
  fi

  while IFS= read -r -d '' val; do live+=("$val"); done <"/proc/$pid/cmdline" 2>/dev/null || true
  case "$kind" in
    qemu) required=(-pidfile "$QEMU_PID") ;;
    # The seed port is dynamic per VM, so tie the required arguments to the
    # run-specific seed directory instead; the recorded argv still pins the
    # exact port and bind address.
    seed) required=(-m http.server --directory "$SEED_DIR") ;;
    *) PIDFILE_REASON="unknown process kind '$kind'"; return 1 ;;
  esac
  local needle candidate found
  for needle in "${required[@]}"; do
    found=0
    for candidate in "${live[@]}"; do
      if [ "$candidate" = "$needle" ]; then found=1; break; fi
    done
    if [ "$found" = 0 ]; then
      PIDFILE_REASON="pid $pid cmdline lacks required argument '$needle' (not this VM_DIR)"
      return 1
    fi
  done
  for needle in "${recorded[@]}"; do
    found=0
    for candidate in "${live[@]}"; do
      if [ "$candidate" = "$needle" ]; then found=1; break; fi
    done
    if [ "$found" = 0 ]; then
      PIDFILE_REASON="pid $pid cmdline lacks recorded argument '$needle'"
      return 1
    fi
  done
  PIDFILE_PID=$pid
  return 0
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

# Stop a process recorded in a pidfile. The identity is snapshotted before the
# first signal so a SIGKILL is only sent to the same process (qemu may unlink
# its own pidfile on the way out, and the PID may have been reused by then).
stop_recorded() { # stop_recorded <file> <kind> <label> <term-wait-ticks>
  local file=$1 kind=$2 label=$3 wait=$4 pid boot start exe digest
  pid=$(pidfile_take "$file" "$kind") || return 0
  boot=$(current_boot_id)
  start=$(process_start_ticks "$pid")
  exe=$(process_exe "$pid")
  digest=$(cmdline_digest "$pid")
  log "stopping $label (pid $pid)"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 "$wait"); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  if kill -0 "$pid" 2>/dev/null; then
    if [ "$(current_boot_id)" = "$boot" ] &&
      [ "$(process_start_ticks "$pid")" = "$start" ] &&
      [ "$(process_exe "$pid")" = "$exe" ] &&
      [ "$(cmdline_digest "$pid")" = "$digest" ]; then
      kill -9 "$pid" 2>/dev/null || true
    else
      log "WARNING: $label pid $pid changed identity before SIGKILL; not signalling"
    fi
  fi
  rm -f "$file"
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
  if pidfile_verify "$QEMU_PID" qemu; then qpid=$PIDFILE_PID; fi
  if pidfile_verify "$SEED_PID" seed; then spid=$PIDFILE_PID; fi
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
    >"$VM_DIR/seed-http.log" 2>&1 &
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
  if qpid=$(pidfile_take "$QEMU_PID" qemu); then
    log "VM already running (pid $qpid)"
    return 0
  fi
  prepare_link
  ensure_base_image
  ensure_ssh_key
  write_seed
  start_seed_server
  rm -f "$QEMU_PID" "$CONSOLE"
  # The local AF_UNIX datagram socket may be left behind by a SIGKILLed QEMU
  # (scenario 5). No authenticated QEMU is running for this VM_DIR (above), so
  # removing the stale path is safe and required before rebinding it.
  rm -f -- "$LINK_LOCAL"
  if [ ! -f "$OVERLAY" ]; then
    log "creating qcow2 overlay (${VM_DISK})"
    qemu-img create -q -f qcow2 -b "$BASE_IMAGE" -F qcow2 "$OVERLAY" "$VM_DISK"
  fi
  log "booting VM (ssh 127.0.0.1:$SSH_PORT, private $PRIV_IP, link $LINK_LOCAL)"
  qemu-system-x86_64 \
    -enable-kvm -cpu host -m "$VM_MEM" -smp "$VM_SMP" \
    -display none -serial "file:$CONSOLE" \
    -pidfile "$QEMU_PID" -daemonize \
    -drive "if=virtio,file=$OVERLAY,cache=none,discard=unmap" \
    -netdev "user,id=n0,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22" \
    -device "virtio-net-pci,netdev=n0,mac=$MAC_MGMT" \
    -netdev "$LINK_SPEC" \
    -device "virtio-net-pci,netdev=n1,mac=$MAC_PRIV" \
    -smbios "type=1,serial=ds=nocloud;s=http://10.0.2.2:${SEED_PORT}/"
  qpid=$(cat "$QEMU_PID" 2>/dev/null) || qpid=
  [ -n "$qpid" ] || die "qemu did not write $QEMU_PID"
  pidfile_record "$QEMU_PID" qemu "$qpid" -pidfile "$QEMU_PID" "$LINK_SPEC" ||
    die "could not record authenticated qemu pidfile $QEMU_PID"
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

# ---------------------------------------------------------------------------
# Unprivileged self-test for the pidfile authentication above. Runs on the
# host, needs no VM, no root and no port: it starts decoy `sleep`/`python3`
# processes and proves that a stale pidfile pointing at an unrelated live
# process is never signalled (while a correctly recorded one still is).
# ---------------------------------------------------------------------------
selftest() {
  local fail=0 line decoy start
  local save_vm_dir=$VM_DIR save_qpid=$QEMU_PID save_spid=$SEED_PID
  local save_seed=$SEED_DIR save_sport=$SEED_PORT
  local save_link_local=$LINK_LOCAL save_link_peer=$LINK_PEER save_link_spec=$LINK_SPEC
  SELFTEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/rctf-mh-selftest.XXXXXX")
  SELFTEST_DECOYS=()
  selftest_cleanup() {
    local p
    for p in ${SELFTEST_DECOYS[@]+"${SELFTEST_DECOYS[@]}"}; do kill "$p" 2>/dev/null || true; done
    rm -rf "$SELFTEST_TMP"
  }
  trap selftest_cleanup EXIT
  local tmp=$SELFTEST_TMP
  VM_DIR=$tmp
  QEMU_PID=$tmp/qemu.pid
  SEED_PID=$tmp/seed-http.pid
  SEED_DIR=$tmp/seed
  SEED_PORT=$((20000 + RANDOM % 20000))
  LINK_LOCAL=
  LINK_PEER=
  LINK_SPEC=
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

  # 5. Correct identity but a recorded link argument from another run: the
  # identity matches, yet this process is not the QEMU the pidfile describes.
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  {
    printf 'version=2\nkind=qemu\npid=%s\nboot_id=%s\nstart_ticks=%s\nexe=%s\n' \
      "$decoy" "$(current_boot_id)" "$(process_start_ticks "$decoy")" "$(process_exe "$decoy")"
    printf 'arg=-pidfile\narg=%s\n' "$QEMU_PID"
    printf 'arg=dgram,id=n1,local.type=unix,local.path=%s/other-run.sock\n' "$tmp"
  } >"$QEMU_PID"
  stop_recorded "$QEMU_PID" qemu "selftest other-run decoy" 2 >"$tmp/stop.out" 2>&1
  st_alive "$decoy" "other-run link argument"
  st_message "other-run link argument" "lacks recorded argument"
  st_removed "other-run link argument"

  # 6. Positive control: a process whose identity matches exactly IS stopped.
  python3 -c 'import time; time.sleep(300)' -pidfile "$QEMU_PID" >/dev/null 2>&1 &
  decoy=$!
  SELFTEST_DECOYS+=("$decoy")
  sleep 0.2
  pidfile_record "$QEMU_PID" qemu "$decoy" -pidfile "$QEMU_PID" ||
    st_bad "could not record the positive-control pidfile"
  stop_recorded "$QEMU_PID" qemu "selftest positive control" 25 >"$tmp/stop.out" 2>&1
  st_dead "$decoy" "positive control"
  st_removed "positive control"

  # 7. A stale seed-server pidfile is also not signalled.
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
  SEED_PORT=$save_sport
  LINK_LOCAL=$save_link_local
  LINK_PEER=$save_link_peer
  LINK_SPEC=$save_link_spec

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
    if pid=$(pidfile_take "$QEMU_PID" qemu); then
      echo "running name=$NAME pid=$pid ssh=127.0.0.1:${SSH_PORT:-?} priv=${PRIV_IP:-?} link=${LINK_LOCAL:-?}"
    else
      echo "stopped name=$NAME"
      exit 1
    fi
    ;;
  ip)
    echo "127.0.0.1:${SSH_PORT:-?}"
    ;;
  pid)
    pidfile_take "$QEMU_PID" qemu || exit 1
    ;;
  console)
    tail -n "${2:-80}" "$CONSOLE"
    ;;
  stop)
    stop_recorded "$QEMU_PID" qemu "VM $NAME" 50
    stop_seed_server
    if [ -n "$LINK_LOCAL" ]; then rm -f -- "$LINK_LOCAL"; fi
    ;;
  selftest) selftest ;;
  destroy)
    "$0" --name "$NAME" --ssh-port "${SSH_PORT:-0}" stop
    log "removing overlay and console for $NAME"
    rm -f "$OVERLAY" "$CONSOLE" "$VM_DIR/qemu.cmdline"
    rm -rf "$SEED_DIR"
    ;;
  *)
    usage
    ;;
esac
