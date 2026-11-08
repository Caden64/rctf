#!/usr/bin/env bash
# Minimal repro: the shipped systemd unit cannot run the jailer on systemd 255
# (Ubuntu 24.04). RestrictAddressFamilies= makes systemd install seccomp
# filters AND drop CAP_SETUID from the effective set, so jailer's setuid(10000)
# fails with EPERM ("Failed to exec into Firecracker: Operation not permitted").
#
# Run as root inside the test VM:
#   sudo bash repros/systemd-unit-setuid.sh
set -u

systemctl reset-failed repro-setuid repro-caps-no-raf repro-caps-raf >/dev/null 2>&1 || true

CAPS="CAP_NET_ADMIN CAP_NET_RAW CAP_SYS_ADMIN CAP_SYS_CHROOT CAP_SYS_PTRACE CAP_SETUID CAP_SETGID CAP_SETPCAP CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_KILL CAP_MKNOD"

cat >/tmp/vmtest-capdump.sh <<'EOF'
#!/bin/sh
grep -E '^CapEff|^CapBnd|^Seccomp_f' /proc/self/status
EOF
chmod 0755 /tmp/vmtest-capdump.sh

echo "== the unit's directives, WITHOUT RestrictAddressFamilies =="
systemd-run --wait --pipe --collect --unit=repro-caps-no-raf-$$ \
  -p User=root -p NoNewPrivileges=yes -p CapabilityBoundingSet="$CAPS" \
  /tmp/vmtest-capdump.sh 2>&1 | grep -E 'CapEff|CapBnd|Seccomp_f'

echo
echo "== the same, WITH the unit's RestrictAddressFamilies =="
systemd-run --wait --pipe --collect --unit=repro-caps-raf-$$ \
  -p User=root -p NoNewPrivileges=yes -p CapabilityBoundingSet="$CAPS" \
  -p 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK' \
  /tmp/vmtest-capdump.sh 2>&1 | grep -E 'CapEff|CapBnd|Seccomp_f'
echo
echo "CapEff bit 7 (0x80) is CAP_SETUID. It is missing under RestrictAddressFamilies."
echo
echo "== therefore setuid(10000) fails, as the jailer does it =="
systemd-run --wait --pipe --collect --unit=repro-setuid-$$ \
  -p User=root -p NoNewPrivileges=yes -p CapabilityBoundingSet="$CAPS" \
  -p 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK' \
  sh -c 'setpriv --reuid=10000 --regid=10000 --clear-groups /usr/bin/id' 2>&1 | tail -8
echo
echo "== the real unit's failure (from journalctl) =="
journalctl -u rctf-firecracker-agent --no-pager 2>/dev/null |
  grep -E 'Failed to exec into Firecracker|Operation not permitted' | tail -4 ||
  echo "(no journal entry; run the harness first)"
echo
echo "workaround used by the harness (test-only drop-in):"
echo "  [Service]"
echo "  AmbientCapabilities=CAP_SETUID CAP_SETGID"
