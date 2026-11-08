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
# Fail closed: -1 means "could not observe the nftables table", which is NOT
# the same as "no per-lease rules". Only a successful read of the agent's own
# table (or proof that the table does not exist) may report 0.
nft_leases=-1
if command -v nft >/dev/null 2>&1; then
  if nft_tables=$(nft list tables 2>/dev/null); then
    if printf '%s\n' "$nft_tables" | grep -qx 'table inet rctf_fc'; then
      if nft_out=$(nft list table inet rctf_fc 2>/dev/null); then
        nft_leases=$(printf '%s\n' "$nft_out" | grep -Ec 'fctap[0-9]+' || true)
      fi
    else
      nft_leases=0
    fi
  fi
fi
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
