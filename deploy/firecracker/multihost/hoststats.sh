#!/usr/bin/env bash
# Read-only observation of one agent host from inside that host. Runs as root
# (sudo) because the agent state dir (0700 root) and its nftables table are
# privileged; it only reads, it never changes state.
#
# Usage: hoststats.sh <agent-private-ip>
# Prints one JSON object.
#
# Every enumeration is fail-closed: a producer that fails (pgrep missing or
# erroring, ip failing, find unable to read the state dir, an unreadable state
# record) reports -1 for the affected field and names it in observationErrors.
# Zero always means "the producer succeeded and found nothing". Consumers must
# treat -1 as a probe failure, never as absence. pgrep's exit 1 is the one
# legitimate "no match".
set -u

IP=${1:?agent private ip}
TOKEN=$(cat /home/ubuntu/.mh-agent-token 2>/dev/null || true)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

observation_errors=()
fail_observation() { observation_errors+=("$1"); }

count_lines() { # count_lines <text>; newline count of a non-empty block
  if [ -z "$1" ]; then
    printf '0\n'
  else
    printf '%s\n' "$1" | wc -l
  fi
}

# curl prints %{http_code} even when the request fails; force a single 000 so
# the JSON never carries "000000".
http_rc=0
HTTP=$(curl -sS -m 5 -o "$TMP" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" "http://$IP:7001/v1/instances" 2>/dev/null) || http_rc=$?
if [ "$http_rc" -ne 0 ] || [ -z "$HTTP" ]; then
  HTTP=0
fi

fc_procs=-1
fc_rc=0
fc_out=$(pgrep -x firecracker 2>/dev/null) || fc_rc=$?
case "$fc_rc" in
  0) fc_procs=$(count_lines "$fc_out") ;;
  1) fc_procs=0 ;;
  *)
    fc_procs=-1
    fail_observation firecrackerProcs
    ;;
esac

taps=-1
taps_rc=0
taps_out=$(ip -o link show type tun 2>/dev/null) || taps_rc=$?
if [ "$taps_rc" -eq 0 ]; then
  taps=$(count_lines "$taps_out")
else
  fail_observation taps
fi

STATE_DIR=/var/lib/rctf-firecracker/state
records=-1
running=-1
if [ ! -e "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ]; then
  # The agent has no state directory at all: that is a definitive observation
  # that it holds no records (host-setup/agent create it on first use).
  records=0
  running=0
elif [ -d "$STATE_DIR" ] && [ -r "$STATE_DIR" ]; then
  find_rc=0
  state_files=$(find "$STATE_DIR" -maxdepth 1 -type f -name '*.json' 2>/dev/null) || find_rc=$?
  if [ "$find_rc" -ne 0 ]; then
    fail_observation stateRecords
    fail_observation stateRunning
  else
    records=$(count_lines "$state_files")
    running_ok=1
    running=0
    while IFS= read -r record_file; do
      [ -n "$record_file" ] || continue
      grep_rc=0
      grep -q '"state":"running"' "$record_file" 2>/dev/null || grep_rc=$?
      case "$grep_rc" in
        0) running=$((running + 1)) ;;
        1) ;; # no match, legitimate
        *)
          running_ok=0
          break
          ;;
      esac
    done <<<"$state_files"
    if [ "$running_ok" -ne 1 ]; then
      running=-1
      fail_observation stateRunning
    fi
  fi
else
  # The agent creates this directory; if it cannot be read the counts below are
  # unobserved, so report the failure marker rather than a vacuous zero.
  fail_observation stateRecords
  fail_observation stateRunning
fi

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
[ "$nft_leases" -ge 0 ] || fail_observation nftLeaseRules

info=$(curl -sS -m 5 -H "Authorization: Bearer $TOKEN" "http://$IP:7001/v1/info" 2>/dev/null || true)

if [ "${#observation_errors[@]}" -eq 0 ]; then
  errors_json='[]'
else
  errors_json=$(printf '%s\n' "${observation_errors[@]}" |
    awk 'BEGIN{printf "["} NR>1{printf ","} {printf "\"%s\"", $0} END{printf "]"}')
fi

printf '{"httpCode":%s,"agent":"%s","info":%s,' "$HTTP" "$IP" "${info:-null}"
printf '"firecrackerProcs":%s,"taps":%s,"stateRecords":%s,"stateRunning":%s,"nftLeaseRules":%s,"observationErrors":%s,"instances":' \
  "$fc_procs" "$taps" "$records" "$running" "$nft_leases" "$errors_json"
if [ "$HTTP" = 200 ]; then
  cat "$TMP"
else
  printf 'null'
fi
printf '}\n'
