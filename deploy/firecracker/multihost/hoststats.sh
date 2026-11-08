#!/usr/bin/env bash
# Read-only observation of one agent host from inside that host. Runs as root
# (sudo) because the agent state dir (0700 root) and its nftables table are
# privileged; it only reads, it never changes state.
#
# Usage: hoststats.sh <agent-private-ip>
# Prints one JSON object.
set -u

IP=${1:?agent private ip}
TOKEN=$(cat /home/ubuntu/.mh-agent-token 2>/dev/null || true)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

HTTP=$(curl -sS -m 5 -o "$TMP" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" "http://$IP:7001/v1/instances" 2>/dev/null || echo 000)

fc_procs=$(pgrep -x firecracker 2>/dev/null | wc -l)
taps=$(ip -o link show type tun 2>/dev/null | wc -l)
records=$(find /var/lib/rctf-firecracker/state -maxdepth 1 -name '*.json' 2>/dev/null | wc -l)
running=$(find /var/lib/rctf-firecracker/state -maxdepth 1 -name '*.json' -exec grep -l '"state":"running"' {} \; 2>/dev/null | wc -l)
nft_leases=$(nft list table inet rctf_fc 2>/dev/null | grep -Ec 'fctap[0-9]+' || true)
info=$(curl -sS -m 5 -H "Authorization: Bearer $TOKEN" "http://$IP:7001/v1/info" 2>/dev/null || true)

printf '{"httpCode":%s,"agent":"%s","info":%s,' "$HTTP" "$IP" "${info:-null}"
printf '"firecrackerProcs":%s,"taps":%s,"stateRecords":%s,"stateRunning":%s,"nftLeaseRules":%s,"instances":' \
  "$fc_procs" "$taps" "$records" "$running" "$nft_leases"
if [ "$HTTP" = 200 ]; then
  cat "$TMP"
else
  printf 'null'
fi
printf '}\n'
