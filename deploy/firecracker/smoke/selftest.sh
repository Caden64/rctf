#!/bin/bash
# Mutation proofs for the smoke harness's fail-closed absence probes and its
# verified process cleanup. Each case deliberately breaks a command or an
# identity and requires the SAME helper inner.sh uses to reject it.
#
# Prints `SELFTEST <id> PASS/FAIL <text>`; inner.sh counts these separately and
# fails the run on any SELFTEST failure.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
RUN=${RUN:?run via run.sh}
. "$HERE/lib.sh"

ST=$RUN/smoke-selftest
rm -rf "$ST"; mkdir -p "$ST"
passes=0; failures=0
st_pass() { passes=$((passes + 1)); printf 'SELFTEST %s PASS %s\n' "$1" "$2"; }
st_fail() { failures=$((failures + 1)); printf 'SELFTEST %s FAIL %s\n' "$1" "$2"; }

needle='rctf{selftest-only}'
printf 'nothing here\n' >"$ST/clean.txt"
printf 'x %s y\n' "$needle" >"$ST/dirty.txt"

# 1. A scan target that does not exist must be inconclusive, not "absent".
flag_scan "$needle" "$ST/does-not-exist"; rc=$?
if [ "$rc" -eq 2 ]; then
  st_pass 1 "mutation caught: a nonexistent scan target is inconclusive (exit 2), never 'flag absent'"
else
  st_fail 1 "a nonexistent scan target returned $rc instead of 2 (absence would be vacuously true)"
fi

# 2. Correct cases still work: absent -> 0, present -> 1.
flag_scan "$needle" "$ST/clean.txt"; rc1=$?
flag_scan "$needle" "$ST/dirty.txt"; rc2=$?
if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 1 ]; then
  st_pass 2 "a readable file without the flag is absent (0) and one containing it is found (1)"
else
  st_fail 2 "valid scans returned $rc1/$rc2 instead of 0/1"
fi

# 3. A failing `ip` must be inconclusive, not "no tap".
mkdir -p "$ST/bin-ip"
printf '#!/bin/sh\necho "ip: injected failure" >&2\nexit 2\n' >"$ST/bin-ip/ip"
chmod +x "$ST/bin-ip/ip"
PATH="$ST/bin-ip:$PATH" ip_no_link ': fctap[0-9]+:'; rc=$?
if [ "$rc" -eq 2 ]; then
  st_pass 3 "mutation caught: a failing 'ip -o link show' cannot prove the tap is absent (exit 2)"
else
  st_fail 3 "a failing ip returned $rc instead of 2 (a tap could look removed)"
fi

# 4. A failing `nft` must be inconclusive for table absence.
mkdir -p "$ST/bin-nft"
printf '#!/bin/sh\necho "nft: injected failure" >&2\nexit 2\n' >"$ST/bin-nft/nft"
chmod +x "$ST/bin-nft/nft"
PATH="$ST/bin-nft:$PATH" nft_table_absent inet rctf_fc; rc=$?
if [ "$rc" -eq 2 ]; then
  st_pass 4 "mutation caught: a failing nft cannot prove a table is absent (exit 2)"
else
  st_fail 4 "a failing nft returned $rc instead of 2 for table absence"
fi

# 5. A genuine "table does not exist" (exit 1 + message) is still accepted.
mkdir -p "$ST/bin-nft-missing"
printf '#!/bin/sh\necho "Error: No such file or directory" >&2\nexit 1\n' >"$ST/bin-nft-missing/nft"
chmod +x "$ST/bin-nft-missing/nft"
PATH="$ST/bin-nft-missing:$PATH" nft_table_absent inet rctf_fc; rc=$?
if [ "$rc" -eq 0 ]; then
  st_pass 5 "a real missing-table error (exit 1, 'No such file or directory') is accepted as absent"
else
  st_fail 5 "a real missing-table error returned $rc instead of 0"
fi

# 6. A failing `nft` must be inconclusive for "the lease rule is gone".
PATH="$ST/bin-nft:$PATH" nft_lacks 10.200.0.2 inet rctf_fc; rc=$?
if [ "$rc" -eq 2 ]; then
  st_pass 6 "mutation caught: a failing nft cannot prove the lease rules are gone (exit 2)"
else
  st_fail 6 "a failing nft returned $rc instead of 2 for lease-rule absence"
fi

# 7. Verified cleanup: wrong start ticks, wrong exe or wrong argv marker must
#    leave the process alone; the matching identity must terminate it.
sleep 30 &
victim=$!
victim_ticks=$(proc_start_ticks "$victim")
kill_verified "$victim" "$((victim_ticks + 1))" sleep 30
if proc_identity_matches "$victim" "$victim_ticks"; then
  st_pass 7 "mutation caught: kill_verified ignores a PID whose recorded start ticks do not match"
else
  st_fail 7 "kill_verified killed a process with mismatched start ticks"
fi
kill_verified "$victim" "$victim_ticks" not-this-exe 30
if proc_identity_matches "$victim" "$victim_ticks"; then
  st_pass 7b "mutation caught: kill_verified ignores a PID whose executable does not match"
else
  st_fail 7b "kill_verified killed a process with a mismatched executable"
fi
kill_verified "$victim" "$victim_ticks" sleep definitely-not-this-run
if proc_identity_matches "$victim" "$victim_ticks"; then
  st_pass 7c "mutation caught: kill_verified ignores a PID whose argv lacks this run's marker"
else
  st_fail 7c "kill_verified killed a process whose argv marker did not match"
fi
kill_verified "$victim" "$victim_ticks" sleep 30
if proc_identity_matches "$victim" "$victim_ticks"; then
  st_fail 7d "kill_verified did not terminate a process whose full identity matched"
else
  st_pass 7d "kill_verified terminates the process when start ticks, exe and argv marker all match"
fi

printf 'RESULT selftest: %d passed, %d failed\n' "$passes" "$failures"
[ "$failures" -eq 0 ]
