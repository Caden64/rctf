#!/bin/bash
# Stock-ssh two-prompt check client for the sshole lab.
#
# The vulnerability needs a wrong password first and an overlong password on a
# second (or later) authentication attempt in the SAME connection. This client
# drives the system `ssh` with SSH_ASKPASS so each prompt gets a different
# password, and classifies the result fail-closed:
#
#   ACCEPT  ssh exited 0 (authentication succeeded)
#   REJECT  ssh failed with a definitive authentication rejection
#   ERROR   anything else (connection refused, timeout, kex/transport failure,
#           unknown output) - a test MUST treat this as a failure, never as a
#           negative result.
#
# Exit status: 0 ACCEPT, 10 REJECT, 20 ERROR. Usage:
#
#   check-client.sh probe --host H --port P --user U \
#     --mode wrong|correct|wrong-then-long|long-first [--command CMD]
#
# The SSH output is printed between markers for the caller to inspect.
set -uo pipefail

SSHOLE_LONG_LENGTH=${SSHOLE_LONG_LENGTH:-300}
SSHOLE_WRONG_PASSWORD=${SSHOLE_WRONG_PASSWORD:-sshole-definitely-wrong-password}
SSHOLE_BOB_PASSWORD=${SSHOLE_BOB_PASSWORD:-sshole-lab-bob-password}

sshole_long_password() {
  # 257..1024 bytes; 300 is inside the published range and comfortably above
  # musl's 256-byte crypt() limit.
  local i out=
  for ((i = 0; i < SSHOLE_LONG_LENGTH; i++)); do out+=A; done
  printf '%s' "$out"
}

SSHOLE_TRANSPORT_RE='Connection refused|Connection timed out|Connection reset|Connection closed|No route to host|Network is unreachable|kex_exchange_identification|Host key verification failed|Temporary failure in name resolution|Broken pipe|Connection to [^ ]+ closed'
SSHOLE_AUTH_RE='Permission denied|Too many authentication failures|Authentication failed'

# classify_ssh <exit-code> <stderr-file>
# Prints ACCEPT, REJECT or ERROR. Deliberately conservative: a definitive
# rejection requires an authentication diagnostic AND the absence of any
# transport diagnostic.
classify_ssh() {
  local rc=$1 err=$2
  if [ "$rc" -eq 0 ]; then
    printf 'ACCEPT\n'
    return 0
  fi
  if grep -Eq "$SSHOLE_TRANSPORT_RE" "$err" 2>/dev/null; then
    printf 'ERROR\n'
    return 0
  fi
  if grep -Eq "$SSHOLE_AUTH_RE" "$err" 2>/dev/null; then
    printf 'REJECT\n'
    return 0
  fi
  printf 'ERROR\n'
}

askpass_dir=
cleanup() {
  [ -n "$askpass_dir" ] && rm -rf "$askpass_dir"
}
trap cleanup EXIT INT TERM

# make_askpass <password...>
# The helper is invoked once per password prompt. It returns the next password
# and an empty string once the list is exhausted, so an unexpected extra prompt
# cannot silently succeed.
make_askpass() {
  askpass_dir=$(mktemp -d "${TMPDIR:-/tmp}/sshole-askpass.XXXXXX") ||
    return 1
  printf '%s\n' "$@" >"$askpass_dir/passwords" || return 1
  cat >"$askpass_dir/askpass" <<'ASKPASS'
#!/bin/sh
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
n=0
[ -f "$dir/count" ] && n=$(cat "$dir/count" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s\n' "$n" >"$dir/count"
sed -n "${n}p" "$dir/passwords"
ASKPASS
  chmod 0700 "$askpass_dir" "$askpass_dir/passwords" "$askpass_dir/askpass"
}

usage() {
  sed -n '2,/^# The SSH output/p' "$0" | sed 's/^# \{0,1\}//'
}

probe() {
  local host= port= user= mode= command=id
  while [ $# -gt 0 ]; do
    case "$1" in
      --host) host=$2; shift 2 ;;
      --port) port=$2; shift 2 ;;
      --user) user=$2; shift 2 ;;
      --mode) mode=$2; shift 2 ;;
      --command) command=$2; shift 2 ;;
      *) printf 'check-client: unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
  done
  [ -n "$host" ] && [ -n "$port" ] && [ -n "$user" ] && [ -n "$mode" ] ||
    { printf 'check-client: --host, --port, --user and --mode are required\n' >&2; exit 2; }

  local -a passwords=()
  case "$mode" in
    wrong) passwords=("$SSHOLE_WRONG_PASSWORD") ;;
    correct) passwords=("$SSHOLE_BOB_PASSWORD") ;;
    wrong-then-long) passwords=("$SSHOLE_WRONG_PASSWORD" "$(sshole_long_password)") ;;
    long-first) passwords=("$(sshole_long_password)") ;;
    *) printf 'check-client: unknown mode: %s\n' "$mode" >&2; exit 2 ;;
  esac

  make_askpass "${passwords[@]}" ||
    { printf 'check-client: could not create the askpass helper\n' >&2; exit 2; }

  local out err rc kind
  out=$askpass_dir/ssh.out
  err=$askpass_dir/ssh.err
  timeout 45 setsid -w env -u SSH_AUTH_SOCK \
    SSH_ASKPASS="$askpass_dir/askpass" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
    ssh -F /dev/null -T \
    -p "$port" \
    -o PreferredAuthentications=password \
    -o PubkeyAuthentication=no \
    -o KbdInteractiveAuthentication=no \
    -o NumberOfPasswordPrompts="${#passwords[@]}" \
    -o ConnectTimeout=10 \
    -o ConnectionAttempts=1 \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o GlobalKnownHostsFile=/dev/null \
    -o LogLevel=ERROR \
    "$user@$host" "$command" >"$out" 2>"$err" </dev/null
  rc=$?

  kind=$(classify_ssh "$rc" "$err")
  printf 'SSHOLE_PROBE kind=%s rc=%d user=%s host=%s port=%s mode=%s\n' \
    "$kind" "$rc" "$user" "$host" "$port" "$mode"
  printf 'SSHOLE_STDOUT_BEGIN\n'
  sed -e 's/^/| /' "$out" 2>/dev/null || true
  printf 'SSHOLE_STDOUT_END\n'
  printf 'SSHOLE_STDERR_BEGIN\n'
  sed -e 's/^/| /' "$err" 2>/dev/null || true
  printf 'SSHOLE_STDERR_END\n'

  case "$kind" in
    ACCEPT) exit 0 ;;
    REJECT) exit 10 ;;
    *) exit 20 ;;
  esac
}

# Tests source this file and drive classify_ssh/sshole_long_password directly.
if [ "${SSHOLE_CHECK_CLIENT_SOURCE_ONLY:-0}" = 1 ]; then
  return 0 2>/dev/null || exit 0
fi

cmd=${1:-}
shift || true
case "$cmd" in
  probe) probe "$@" ;;
  -h | --help | help) usage ;;
  *)
    usage
    exit 2
    ;;
esac
