#!/bin/bash
# Shared assertions for the edge harness. Sourced by phase-agent.sh,
# phase-veth.sh, phase-lifecycle.sh and selftest.sh. Every helper returns 0 only
# when the assertion really holds; an unparseable probe or a dead tool is a
# failure, never an implicit "blocked/closed".
#
# The helpers are intentionally small and side-effect free so selftest.sh can
# run them against deliberately broken inputs and prove that they fail.

# --- conntrack -------------------------------------------------------------
# The binary is overridable only so the selftest can inject a broken one; the
# phases always use the real `conntrack` from PATH.
CONNTRACK_BIN=${CONNTRACK_BIN:-conntrack}

# Print a conntrack listing. Fails when the command fails OR when a successful
# command prints output that is not a conntrack listing (a broken wrapper that
# exits 0 and prints an error must never look like an empty table).
conntrack_list() {
  local out lines
  out=$("$CONNTRACK_BIN" -L 2>&1) || return 1
  lines=$(printf '%s\n' "$out" | sed '/^$/d')
  if [ -n "$lines" ] &&
    printf '%s\n' "$lines" |
      grep -qvE '^((tcp|udp|icmp|icmpv6|sctp|dccp)[[:space:]]+[0-9]+[[:space:]]|conntrack v[0-9])'; then
    return 1
  fi
  printf '%s\n' "$lines"
}

# Presence is fail-closed: a failed listing prints nothing, so grep fails.
conntrack_has_ip() { # guestIp
  conntrack_list | grep -q -- "$1"
}

# Absence is only meaningful when the listing itself succeeded. Never write
# `! conntrack_has_ip`: a failed `conntrack -L` would then pass as "absent".
conntrack_ip_absent() { # guestIp
  local out
  out=$(conntrack_list) || return 1
  ! printf '%s\n' "$out" | grep -q -- "$1"
}

flush_guest_conntrack() { # guestIp -> the repository's real flushConntrack
  bun "$EDGE/lib/net-tools.ts" flush "$1"
}

# --- guest probe.txt -------------------------------------------------------
# The guest writes exactly one line: "peer=<v> host=<v> scan=<v>". Anything
# else (empty file, truncated line, unexpected token) is NOT a result and must
# fail closed.
probe_format_ok() {
  printf '%s' "$1" | grep -Eq '^peer=[A-Za-z]+ host=[A-Za-z]+ scan=[A-Za-z]+$'
}

probe_value() { # line key -> value (empty when missing/unparseable)
  printf '%s\n' "$1" |
    awk -v key="$2" '{
      for (i = 1; i <= NF; i++) {
        split($i, part, "=")
        if (part[1] == key) { print part[2]; exit }
      }
    }'
}

probe_scan_blocked() {
  probe_format_ok "$1" && [ "$(probe_value "$1" scan)" = blocked ]
}

probe_scan_reached() {
  probe_format_ok "$1" && [ "$(probe_value "$1" scan)" = REACHED ]
}

probe_peer_is() {
  probe_format_ok "$1" && [ "$(probe_value "$1" peer)" = "$2" ]
}

probe_host_is() {
  probe_format_ok "$1" && [ "$(probe_value "$1" host)" = "$2" ]
}

# --- TCP port probes -------------------------------------------------------
port_connects() { # host port
  nc -z -w 2 "$1" "$2" >/dev/null 2>&1
}

# A "closed" port is only meaningful when a known-open port is reachable from
# the SAME namespace/tool at the same time: otherwise any nc failure (missing
# nc, bad route, wrong netns) would look like a closed port.
assert_port_closed() { # host publishedPort closedPort
  port_connects "$1" "$2" || return 1
  ! port_connects "$1" "$3"
}

# --- nmap greppable (-oG) reports -----------------------------------------
# A "no open ports" result is only meaningful when nmap exited 0 AND produced a
# complete, parseable report for exactly the ports we asked about. A timeout,
# crash or truncated output must never be read as "closed".
nmap_report_complete() { # exit-code greppable-output "port,port,..."
  local rc=$1 out=$2 ports=$3 port portsline
  [ "$rc" -eq 0 ] || return 1
  printf '%s\n' "$out" | grep -q 'Status: Up' || return 1
  portsline=$(printf '%s\n' "$out" | grep 'Ports: ' | head -n 1)
  [ -n "$portsline" ] || return 1
  local IFS=,
  for port in $ports; do
    printf '%s\n' "$portsline" |
      grep -Eq "(^|[ ,])${port}/(open|closed|filtered|unfiltered|open\\|filtered|closed\\|filtered)/tcp" ||
      return 1
  done
  return 0
}

nmap_scan_blocked() { # exit-code greppable-output "port,port,..."
  nmap_report_complete "$@" || return 1
  ! printf '%s\n' "$2" | grep -Eq '/(open|open\|filtered)/'
}

# --- process identity (cleanup only) ---------------------------------------
# `unshare -Urn` does NOT create a PID namespace, so a harness that kills by
# name can kill another run's processes. Cleanup therefore only ever signals a
# PID whose recorded identity still matches: /proc/<pid>/stat start ticks (the
# same field the VM driver persists), the executable basename, and an argv
# marker that is unique to this run (the run directory).
proc_start_ticks() { # pid -> ticks on stdout; non-zero when gone/unreadable
  local stat
  [ -r "/proc/$1/stat" ] || return 1
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  [ -n "$stat" ] || return 1
  printf '%s' "${stat#*) }" | awk '{print $20}'
}

proc_ppid() { # pid -> parent pid
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  printf '%s' "${stat#*) }" | awk '{print $2}'
}

proc_cmdline() { # pid -> argv joined by spaces
  tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null || true
}

proc_exe_basename() { # pid -> basename of the resolved executable
  local exe
  exe=$(readlink "/proc/$1/exe" 2>/dev/null) || return 1
  printf '%s\n' "${exe##*/}"
}

# Signal only when every identity component matches. Returns 0 when the process
# was gone or was safely signalled; never signals a recycled/foreign PID.
kill_verified() { # pid ticks exe-basename argv-marker
  local pid=$1 ticks=$2 exe=$3 marker=$4 i
  [ -n "$pid" ] || return 0
  [ -d "/proc/$pid" ] || return 0
  [ "$(proc_start_ticks "$pid" 2>/dev/null)" = "$ticks" ] || return 0
  [ "$(proc_exe_basename "$pid" 2>/dev/null)" = "$exe" ] || return 0
  proc_cmdline "$pid" | grep -qF -- "$marker" || return 0
  kill "$pid" 2>/dev/null || true
  for i in $(seq 1 40); do
    [ -d "/proc/$pid" ] || {
      wait "$pid" 2>/dev/null || true
      return 0
    }
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return 0
}

# Kill a direct child of this shell, after proving it is still our child (a
# child PID cannot be recycled before it is reaped) and waiting for exit.
kill_child() { # pid
  local pid=$1 i
  [ -n "$pid" ] || return 0
  [ -d "/proc/$pid" ] || return 0
  [ "$(proc_ppid "$pid" 2>/dev/null)" = "$$" ] || {
    wait "$pid" 2>/dev/null || true
    return 0
  }
  kill "$pid" 2>/dev/null || true
  for i in $(seq 1 40); do
    [ -d "/proc/$pid" ] || {
      wait "$pid" 2>/dev/null || true
      return 0
    }
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return 0
}

# Reap every Firecracker process that belongs to this run: first the handles
# recorded in the agent state files (pid + start ticks + exe + argv), then a
# /proc sweep restricted to firecracker executables whose argv contains this
# run directory. Never kills by name pattern across runs.
reap_firecracker() { # state-dir run-dir
  local state_dir=$1 run_dir=$2 d pid ticks p
  for d in "$state_dir"/*.json; do
    [ -e "$d" ] || continue
    pid=$(jq -r '.vm.pid // empty' "$d" 2>/dev/null || true)
    ticks=$(jq -r '.vm.pidStartTicks // empty' "$d" 2>/dev/null || true)
    [ -n "$pid" ] && [ -n "$ticks" ] || continue
    kill_verified "$pid" "$ticks" firecracker "$run_dir"
  done
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    [ "$(proc_exe_basename "$pid" 2>/dev/null)" = firecracker ] || continue
    proc_cmdline "$pid" | grep -qF -- "$run_dir" || continue
    ticks=$(proc_start_ticks "$pid" 2>/dev/null) || continue
    kill_verified "$pid" "$ticks" firecracker "$run_dir"
  done
}
