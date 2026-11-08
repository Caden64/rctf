#!/bin/bash
# Minimal repro: a `vm.mode: direct` agent (which never uses cgroups) is
# reported as NOT accepting when `vm.cgroupRoot` is not a writable cgroup2
# mount. In an unprivileged user namespace (and in most CI containers) the
# real /sys/fs/cgroup is read-only, so the controller refuses to place ANY
# instance on the host even though direct mode boots VMs fine (see the smoke
# test, which boots real VMs in exactly this environment).
#
# Expected: checks.cgroupRoot=true and accepting=true for direct mode.
# Observed: checks.cgroupRoot=false, accepting=false.
#
# Run: SMOKE_ARTIFACTS=$HOME/.cache/rctf-fc-smoke ./direct-mode-cgroup-root.sh
# Exits 0 when the bug is reproduced, 2 when the environment is missing, and 1
# when the agent behaves correctly (i.e. the bug is fixed).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../.." && pwd)
ARTIFACTS=${SMOKE_ARTIFACTS:-${XDG_CACHE_HOME:-$HOME/.cache}/rctf-fc-smoke}
[ -x "$ARTIFACTS/firecracker" ] || { echo "missing $ARTIFACTS/firecracker" >&2; exit 2; }
command -v bun >/dev/null || { echo "bun is required" >&2; exit 2; }
RUNTIME_BASE=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
RUN=$(mktemp -d "$RUNTIME_BASE/cgr-XXXXXX")
export RUN REPO ARTIFACTS
mkdir -p "$RUN/state" "$RUN/run" "$RUN/jailer" "$RUN/traefik"

cat > "$RUN/agent.yaml" <<YAML
hostId: cgr1
listen: { host: 127.0.0.1, port: 17999 }
stateDir: $RUN/state
capacity: { vcpus: 2, memMiB: 1024, diskMiB: 1024, maxInstances: 2 }
vm:
  mode: direct                 # cgroups are not used in direct mode
  firecrackerBin: $ARTIFACTS/firecracker
  imagesDir: $ARTIFACTS/images
  runDir: $RUN/run
  chrootBase: $RUN/jailer
  allowUntrustedImages: true
  cgroupRoot: /sys/fs/cgroup   # read-only in a user namespace / CI container
network:
  publicHost: 10.200.0.1
  httpDomain: repro.test
  externalInterface: dummy0
  traefikDynamicDir: $RUN/traefik
  requireConntrack: false
  quarantineFile: $RUN/net-quarantine.json
YAML

cat > "$RUN/inner.sh" <<'INNER'
#!/bin/bash
set -u
ip link set lo up
ip link add dummy0 type dummy 2>/dev/null || true
ip link set dummy0 up
sysctl -qw net.ipv4.ip_forward=1 2>/dev/null || true
export FIRECRACKER_AGENT_TOKEN=repro-token
export PATH="$HOME/.local/bin:$PATH"
cd "$REPO"
bun apps/firecracker-instancer/src/agent/index.ts "$RUN/agent.yaml" >"$RUN/agent.log" 2>&1 &
AP=$!
cleanup() { kill -9 "$AP" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 100); do
  curl -sS -m 2 -H "Authorization: Bearer repro-token" http://127.0.0.1:17999/v1/info >"$RUN/info.json" 2>/dev/null && break
  sleep 0.2
done
jq -c '{accepting, cgroupRoot: .checks.cgroupRoot, other_checks: (.checks | with_entries(select(.key != "cgroupRoot" and .key != "reflink")))}' "$RUN/info.json"
if jq -e '.accepting == false and .checks.cgroupRoot == false' "$RUN/info.json" >/dev/null; then
  echo "REPRODUCED: direct-mode agent is not accepting because cgroupRoot is not writable"
  exit 0
fi
echo "NOT REPRODUCED: agent reports accepting=$(jq -r .accepting "$RUN/info.json") cgroupRoot=$(jq -r .checks.cgroupRoot "$RUN/info.json")"
exit 1
INNER
chmod +x "$RUN/inner.sh"
exec timeout 120 unshare -Urn env RUN="$RUN" REPO="$REPO" bash "$RUN/inner.sh"
