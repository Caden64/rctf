#!/bin/bash
# Shared helpers for deploy/firecracker/labs/*.
#
# Sourced, never executed. Everything here is unprivileged and local: verified
# downloads, staging-directory helpers and fail-closed assertions. Guest
# binaries are only ever unpacked, never executed on the host.
#
# Conventions (see ../smoke/fetch-artifacts.sh):
#   - a download is cached under its final name only after sha256 verification;
#   - a cached file is re-hashed before every use and a mismatch is fatal;
#   - a failed download leaves no `.part` file behind.

LABS_LIB_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

lab_log() { printf '==> %s\n' "$*" >&2; }

lab_die() {
  printf 'labs: %s\n' "$*" >&2
  exit 1
}

lab_note() { printf '    %s\n' "$*" >&2; }

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

verify_sha256() { # <file> <expected> <label>
  local actual
  [ -f "$1" ] || lab_die "$3: missing file $1"
  actual=$(sha256_of "$1") || lab_die "$3: could not hash $1"
  [ "$actual" = "$2" ] ||
    lab_die "$3 sha256 mismatch: expected $2, got $actual ($1)"
}

# fetch_verified <url> <destination> <sha256> <label>
# A cached destination is accepted only after re-hashing it. A fresh download
# is written to `.part`, verified, then renamed into place.
fetch_verified() {
  local url=$1 dest=$2 expected=$3 label=$4 actual
  if [ -f "$dest" ]; then
    verify_sha256 "$dest" "$expected" "$label (cached)"
    lab_note "cached $label verified"
    return 0
  fi
  mkdir -p "$(dirname -- "$dest")" || lab_die "could not create $(dirname -- "$dest")"
  lab_note "downloading $label"
  if ! curl -fsSL --retry 3 --connect-timeout 20 -o "$dest.part" "$url"; then
    rm -f "$dest.part"
    lab_die "$label download failed: $url"
  fi
  actual=$(sha256_of "$dest.part") || {
    rm -f "$dest.part"
    lab_die "$label: could not hash the download"
  }
  if [ "$actual" != "$expected" ]; then
    rm -f "$dest.part"
    lab_die "$label sha256 mismatch: expected $expected, got $actual"
  fi
  mv "$dest.part" "$dest" || lab_die "$label: could not publish $dest"
}

# stage_apk <apk> <staging-root>
# Alpine .apk files are concatenated gzip members: signature, control and data.
# GNU tar reads them with --ignore-zeros. The control metadata and install
# scripts are removed afterwards; package scripts are NEVER executed (we are
# not running apk and not running as root).
stage_apk() {
  local apk=$1 root=$2
  [ -f "$apk" ] || lab_die "apk not found: $apk"
  tar -xzf "$apk" -C "$root" --ignore-zeros ||
    lab_die "could not unpack $apk"
  rm -rf "$root/.PKGINFO" "$root/.SIGN."* "$root/.pre-"* \
    "$root/.post-"* "$root/.trigger" "$root/.install" 2>/dev/null || true
}

# stage_deb <deb> <staging-root>
# Extract a Debian/Ubuntu .deb with ar and tar only. No dpkg, no maintainer
# scripts, no configuration. The data member can be .zst, .xz or .gz.
stage_deb() {
  local deb=$1 root=$2 member
  [ -f "$deb" ] || lab_die "deb not found: $deb"
  member=$(ar t "$deb" 2>/dev/null | grep '^data\.tar' | head -n 1) ||
    lab_die "could not list $deb (is binutils/ar installed?)"
  [ -n "$member" ] || lab_die "$deb has no data.tar member"
  lab_note "extracting $(basename "$deb") ($member)"
  case "$member" in
    *.zst)
      ar p "$deb" "$member" | tar --zstd -xf - -C "$root" ||
        lab_die "could not unpack $deb"
      ;;
    *.xz)
      ar p "$deb" "$member" | tar -xJf - -C "$root" ||
        lab_die "could not unpack $deb"
      ;;
    *.gz)
      ar p "$deb" "$member" | tar -xzf - -C "$root" ||
        lab_die "could not unpack $deb"
      ;;
    *)
      lab_die "$deb has an unsupported data member: $member"
      ;;
  esac
}

# write_sshole_users <staging-root> <bob-hash>
# Two throwaway accounts:
#   alice: shadow field exactly "*" (no password can ever match it)
#   bob:   a real $5$/$6$ SHA-crypt hash (the salt sshd borrows)
# The numeric uid/gid are stable so the lab can assert them in a login.
write_sshole_users() {
  local root=$1 bob_hash=$2
  [ -f "$root/etc/passwd" ] && [ -f "$root/etc/shadow" ] &&
    [ -f "$root/etc/group" ] ||
    lab_die "staging tree has no passwd/shadow/group: $root"

  # Idempotent: drop existing lab/sshd entries before appending ours.
  sed -i -e '/^alice:/d' -e '/^bob:/d' -e '/^sshd:/d' "$root/etc/passwd"
  sed -i -e '/^alice:/d' -e '/^bob:/d' -e '/^sshd:/d' "$root/etc/shadow"
  sed -i -e '/^alice:/d' -e '/^bob:/d' -e '/^sshd:/d' "$root/etc/group"

  printf 'sshd:x:22:22:sshd:/var/empty:/sbin/nologin\n' >>"$root/etc/passwd"
  printf 'sshd:!::0:::::\n' >>"$root/etc/shadow"
  printf 'sshd:x:22:\n' >>"$root/etc/group"

  printf 'alice:x:1000:1000:sshole lab alice:/home/alice:/bin/sh\n' \
    >>"$root/etc/passwd"
  printf 'alice:*:20000:0:99999:7:::\n' >>"$root/etc/shadow"
  printf 'alice:x:1000:\n' >>"$root/etc/group"

  printf 'bob:x:1001:1001:sshole lab bob:/home/bob:/bin/sh\n' \
    >>"$root/etc/passwd"
  printf 'bob:%s:20000:0:99999:7:::\n' "$bob_hash" >>"$root/etc/shadow"
  printf 'bob:x:1001:\n' >>"$root/etc/group"

  mkdir -p "$root/home/alice" "$root/home/bob" "$root/var/empty" \
    "$root/run/sshd" "$root/etc/ssh" "$root/app"
  chmod 0755 "$root/home/alice" "$root/home/bob" "$root/var/empty" \
    "$root/etc/ssh"
  chmod 0700 "$root/run/sshd"
  chmod 0644 "$root/etc/passwd"
  chmod 0600 "$root/etc/shadow"
  chmod 0644 "$root/etc/group"
}

# write_sshole_start <staging-root>
# The guest service: PID 1 (guest/init) execs /app/start as root. It prepares
# the privilege-separation directory, records the instance id for the isolation
# probe, generates host keys on first boot and runs sshd in the foreground.
write_sshole_start() {
  local root=$1
  cat >"$root/app/start" <<'START'
#!/bin/sh
# sshole lab guest service. Runs as root under /rctf/init.
set -eu
mkdir -p /run/sshd /var/empty /etc/ssh
chmod 0700 /run/sshd
chmod 0755 /var/empty
# mkfs.ext4 -d preserves the build user's numeric ownership; the guest's
# privilege separation directory must belong to root at runtime.
chown 0:0 /run/sshd /var/empty /etc/ssh 2>/dev/null || true
printf '%s\n' "${RCTF_INSTANCE_ID:-unknown}" >/etc/sshole-instance
chmod 0644 /etc/sshole-instance
if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
  ssh-keygen -A
fi
exec /usr/sbin/sshd -D -e
START
  chmod 0755 "$root/app/start"
}

# write_sshole_nsswitch <staging-root>
# Only local files are needed by a lab guest; pinning this avoids NSS modules
# that a minimal extracted rootfs does not contain.
write_sshole_nsswitch() {
  local root=$1
  mkdir -p "$root/etc"
  cat >"$root/etc/nsswitch.conf" <<'NSS'
passwd: files
shadow: files
group: files
hosts: files dns
NSS
  chmod 0644 "$root/etc/nsswitch.conf"
}

# write_sshd_config <staging-root> <use-pam yes|no>
write_sshd_config() {
  local root=$1 use_pam=$2
  cat >"$root/etc/ssh/sshd_config" <<EOF
# sshole lab: deliberately minimal, PasswordAuthentication on.
Port 22
ListenAddress 0.0.0.0
PasswordAuthentication yes
KbdInteractiveAuthentication no
PubkeyAuthentication no
PermitRootLogin prohibit-password
UsePAM $use_pam
AllowUsers alice bob
X11Forwarding no
PrintMotd no
PidFile /run/sshd.pid
Subsystem sftp internal-sftp
LogLevel VERBOSE
EOF
  chmod 0644 "$root/etc/ssh/sshd_config"
}

# assert_sshd_banner <staging-root> <relative-binary> <expected-banner>
# Read the version banner out of the binary bytes. `strings` is not execution;
# the guest binary never runs on the host.
assert_sshd_banner() {
  local root=$1 rel=$2 want=$3 got hits
  [ -f "$root/$rel" ] || lab_die "sshd binary missing: $root/$rel"
  # Read every banner-shaped string, then take the first. No `grep -m1` here:
  # under `set -o pipefail` closing the pipe early makes `strings` exit with
  # SIGPIPE and would turn a successful read into a build failure.
  hits=$(strings "$root/$rel" | grep -E '^OpenSSH_[0-9]+\.[0-9]+(p[0-9]+)?$' || true)
  got=$(printf '%s\n' "$hits" | sed -n '1p')
  [ -n "$got" ] || lab_die "could not read an OpenSSH banner from $root/$rel"
  [ "$got" = "$want" ] ||
    lab_die "$root/$rel banner is $got, expected $want"
  lab_note "sshd banner $got ($rel) verified"
}

# assert_executable <path> <label>
assert_executable() {
  [ -f "$1" ] && [ -x "$1" ] || lab_die "$2 is missing or not executable: $1"
}

# require_file <path> <label>
require_file() {
  [ -f "$1" ] || lab_die "$2 is missing: $1"
}
