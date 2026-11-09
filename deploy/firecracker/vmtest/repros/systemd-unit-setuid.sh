#!/usr/bin/env bash
# Investigation/repro for the shipped unit's capability bug on systemd 255
# (Ubuntu 24.04): NoNewPrivileges=yes together with a seccomp filter
# (RestrictAddressFamilies=) makes systemd start a root service with CapPrm and
# CapEff one bit short of CapBnd: CAP_SETUID is missing. The jailer therefore
# fails to setuid(10000):
#   Failed to exec into Firecracker: Operation not permitted (os error 1)
#
# The shipped unit restores the one measured-missing bit with
# AmbientCapabilities=CAP_SETUID (CAP_SETGID is already effective). This script
# measures all three combinations on the running system.
#
# Run as root inside the test VM:
#   sudo bash repros/systemd-unit-setuid.sh
set -u

CAPS="CAP_NET_ADMIN CAP_NET_RAW CAP_SYS_ADMIN CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SETUID CAP_SETGID CAP_SETPCAP CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_KILL CAP_MKNOD"
RAF='RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK'
UNIT=${REPO:-/opt/rctf-firecracker}/deploy/firecracker/host/rctf-firecracker-agent.service

mkdir -p /usr/local/lib/rctf-vmtest
cat >/usr/local/lib/rctf-vmtest/capdump <<'EOF'
#!/bin/sh
grep -E '^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp)' /proc/self/status
EOF
chmod 0755 /usr/local/lib/rctf-vmtest/capdump

run() { # run <name> [extra -p args...]
  local name=$1
  shift
  systemd-run --wait --collect --unit="repro-$name-$$" \
    -p User=root -p CapabilityBoundingSet="$CAPS" "$@" \
    /usr/local/lib/rctf-vmtest/capdump >/dev/null 2>&1 || true
  echo "  $name: $(journalctl -u "repro-$name-$$" --no-pager -o cat 2>/dev/null |
    grep -E '^Cap(Inh|Prm|Eff|Bnd|Amb):|^NoNewPrivs:|^Seccomp:' | tr '\n' ' ')"
}

echo "== the unit's directives, WITHOUT a seccomp filter =="
run nnp -p NoNewPrivileges=yes
run raf -p "$RAF"

echo
echo "== the same, WITH NoNewPrivileges=yes AND RestrictAddressFamilies= =="
run both -p NoNewPrivileges=yes -p "$RAF"
echo "  => CAP_SETUID (0x80) is in CapBnd but missing from CapPrm/CapEff."

echo
echo "== the shipped unit's fix: add AmbientCapabilities=CAP_SETUID (one bit) =="
run fixed -p NoNewPrivileges=yes -p "$RAF" \
  -p 'AmbientCapabilities=CAP_SETUID'
echo "  => CapEff=CapBnd=0x82c31eb, CapAmb=0x80 (CAP_SETGID was never missing)."

echo
echo "== the shipped unit (from the repository) =="
grep -E '^(NoNewPrivileges|CapabilityBoundingSet|AmbientCapabilities|RestrictAddressFamilies)=' "$UNIT"

echo
echo "== the running agent under the shipped unit (no drop-in) =="
p=$(systemctl show -p MainPID --value rctf-firecracker-agent 2>/dev/null)
if [ -n "$p" ] && [ "$p" != 0 ]; then
  grep -E '^(CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp)' "/proc/$p/status" |
    sed 's/^/  /'
else
  echo "  (agent is not running; run the harness first)"
fi

echo
echo "== therefore the jailer's setuid(10000) =="
echo "-- without the ambient caps (fails):"
systemd-run --wait --pipe --collect --unit="repro-setuid-bad-$$" \
  -p User=root -p NoNewPrivileges=yes -p CapabilityBoundingSet="$CAPS" -p "$RAF" \
  /usr/bin/setpriv --reuid=10000 --regid=10000 --clear-groups /usr/bin/id 2>&1 |
  grep -E 'setpriv|uid=|Operation not permitted' | tail -3
echo "-- with the shipped unit's ambient cap (works):"
systemd-run --wait --pipe --collect --unit="repro-setuid-ok-$$" \
  -p User=root -p NoNewPrivileges=yes -p CapabilityBoundingSet="$CAPS" -p "$RAF" \
  -p 'AmbientCapabilities=CAP_SETUID' \
  /usr/bin/setpriv --reuid=10000 --regid=10000 --clear-groups /usr/bin/id 2>&1 |
  grep -E 'setpriv|uid=|Operation not permitted' | tail -3
