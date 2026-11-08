#!/bin/bash
# Shared assertions for the edge harness. Sourced by phase-agent.sh,
# phase-veth.sh and selftest.sh. Every helper returns 0 only when the
# assertion really holds; an unparseable probe or a dead tool is a failure,
# never an implicit "blocked/closed".
#
# The helpers are intentionally small and side-effect free so selftest.sh can
# run them against deliberately broken inputs and prove that they fail.

# --- conntrack -------------------------------------------------------------
conntrack_has_ip() { # guestIp
  conntrack -L 2>/dev/null | grep -q -- "$1"
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
