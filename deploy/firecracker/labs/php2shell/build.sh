#!/usr/bin/env bash
#
# Host-side, unprivileged build of the PHP2Shell training-lab images.
#
# Output (under $P2S_CACHE/images, default ~/.cache/rctf-p2s-lab/images):
#   php2shell-vuln/      PHP 8.4.26 + Apache 2.4.69 + laboratory php.ini
#   php2shell-patched/   PHP 8.4.27 + Apache 2.4.69 + laboratory php.ini
#   php2shell-hardened/  PHP 8.4.26 + Apache 2.4.69 + memory_limit=128M
#   <image>/vmlinux, rootfs.ext4, offsets.env, meta.env
#
# The build runs in a rootless Ubuntu 24.04 chroot created with bubblewrap
# (user namespaces + a private mount namespace). Nothing privileged happens on
# the host: apt, make and mkfs all run inside the user namespace as its root.
#
# Usage:
#   ./build.sh                 # build all three images (cached)
#   ./build.sh --force         # rebuild from scratch
#   ./build.sh --only vuln     # one image
set -euo pipefail
. "$(dirname -- "$0")/lib.sh"

ONLY=
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --only)
      ONLY=${2:-}
      [ -n "$ONLY" ] || die "--only needs an image name"
      shift
      ;;
    -h | --help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

command -v bwrap >/dev/null || die "bwrap (bubblewrap) is required for the rootless build"
command -v mkfs.ext4 >/dev/null || die "e2fsprogs >= 1.47 is required"
command -v nm >/dev/null || die "binutils (nm) is required"
command -v curl >/dev/null || die "curl is required"

"$LAB_DIR/fetch.sh"
ensure_smoke_artifacts || die "could not obtain the shared Firecracker artifacts"

BUILD_ROOT=$WORK/build-rootfs
BUILD_LOGS=$WORK/build-logs
mkdir -p "$BUILD_LOGS"

in_rootfs() { # in_rootfs <root> <script>
  local root=$1 script=$2
  bwrap --bind "$root" / --proc /proc --dev /dev --tmpfs /tmp \
    --bind "$BUILD_LOGS" /logs \
    --ro-bind /etc/resolv.conf /etc/resolv.conf \
    --unshare-user --uid 0 --gid 0 -- \
    /bin/bash -c "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive; $script"
}

extract_base() { # extract_base <dir>
  local dir=$1
  rm -rf "$dir"
  mkdir -p "$dir"
  log "extracting Ubuntu $UBUNTU_BASE base rootfs"
  tar --no-same-owner -xzf "$DL/ubuntu-base-$UBUNTU_BASE-base-amd64.tar.gz" -C "$dir" ||
    die "could not extract the Ubuntu base rootfs"
  mkdir -p "$dir/proc" "$dir/sys" "$dir/dev" "$dir/tmp" "$dir/run"
  chmod 1777 "$dir/tmp"
}

build_rootfs() {
  if [ "$FORCE" != 1 ] && [ -d "$BUILD_ROOT/opt/php2shell/apache" ] &&
    [ -f "$WORK/php-$PHP_VULN/libphp.so" ] && [ -f "$WORK/php-$PHP_FIXED/libphp.so" ]; then
    log "build rootfs already populated; reusing (use --force to rebuild)"
    return 0
  fi
  extract_base "$BUILD_ROOT"
  log "installing build dependencies (rootless apt in the Ubuntu chroot)"
  in_rootfs "$BUILD_ROOT" '
    set -e
    apt-get -o APT::Sandbox::User=root update -q
    apt-get -o APT::Sandbox::User=root install -y -q --no-install-recommends \
      build-essential autoconf dpkg-dev file g++ gcc libc-dev make pkg-config \
      re2c bison ca-certificates curl xz-utils \
      libapr1-dev libaprutil1-dev libexpat1-dev libpcre2-dev libssl-dev \
      zlib1g-dev libargon2-dev libcurl4-openssl-dev libonig-dev \
      libreadline-dev libsodium-dev libsqlite3-dev libxml2-dev
  ' >"$BUILD_LOGS/apt-build.log" 2>&1 ||
    die "build dependency installation failed (see $BUILD_LOGS/apt-build.log)"

  log "building Apache httpd $HTTPD_VERSION (prefork, DSO)"
  cp "$DL/httpd-$HTTPD_VERSION.tar.gz" "$BUILD_ROOT/opt/httpd.tar.gz"
  in_rootfs "$BUILD_ROOT" '
    set -e
    cd /opt
    rm -rf httpd-src
    mkdir httpd-src
    tar --no-same-owner -xzf httpd.tar.gz -C httpd-src --strip-components=1
    cd httpd-src
    ./configure --prefix=/opt/php2shell/apache \
      --with-apr=/usr/bin/apr-1-config --with-apr-util=/usr/bin/apu-1-config \
      --with-mpm=prefork --enable-so >/logs/apache-configure.log 2>&1
    make -j"$(nproc)" >/logs/apache-make.log 2>&1
    make install >/logs/apache-install.log 2>&1
  ' || die "Apache build failed (see $BUILD_LOGS/apache-*.log)"

  for ver in "$PHP_VULN" "$PHP_FIXED"; do
    log "building PHP $ver with the official php:*-apache configure flags"
    cp "$DL/php-$ver.tar.gz" "$BUILD_ROOT/opt/php-$ver.tar.gz"
    in_rootfs "$BUILD_ROOT" "
      set -e
      export CFLAGS='-fstack-protector-strong -fpic -fpie -O2 -D_LARGEFILE_SOURCE -D_FILE_OFFSET_BITS=64'
      export CPPFLAGS=\"\$CFLAGS\"
      export LDFLAGS='-Wl,-O1 -pie'
      cd /opt
      rm -rf php-src-$ver
      mkdir php-src-$ver
      tar --no-same-owner -xzf php-$ver.tar.gz -C php-src-$ver --strip-components=1
      cd php-src-$ver
      ./configure \
        --build=x86_64-linux-gnu \
        --prefix=/opt/php2shell/php \
        --sysconfdir=/opt/php2shell/php/etc \
        --with-config-file-path=/opt/php2shell/php/etc \
        --with-config-file-scan-dir=/opt/php2shell/php/etc/conf.d \
        --enable-option-checking=fatal \
        --with-mhash --with-pic --enable-mbstring --enable-mysqlnd \
        --with-password-argon2 --with-sodium=shared \
        --with-pdo-sqlite=/usr --with-sqlite3=/usr \
        --with-curl --with-iconv --with-openssl --with-readline --with-zlib \
        --disable-phpdbg --with-pear --with-libdir=lib/x86_64-linux-gnu \
        --disable-cgi --with-apxs2=/opt/php2shell/apache/bin/apxs \
        >/logs/php-$ver-configure.log 2>&1
      make -j\"\$(nproc)\" >/logs/php-$ver-make.log 2>&1
      make install >/logs/php-$ver-install.log 2>&1
    " || die "PHP $ver build failed (see $BUILD_LOGS/php-$ver-*.log)"

    # Save the module and the shared extensions for this exact build. The
    # next PHP build overwrites the apache module and the shared prefix.
    mkdir -p "$WORK/php-$ver/extensions"
    cp "$BUILD_ROOT/opt/php2shell/apache/modules/libphp.so" "$WORK/php-$ver/libphp.so"
    cp -a "$BUILD_ROOT/opt/php2shell/php/lib/php/extensions/." "$WORK/php-$ver/extensions/" 2>/dev/null || true
    if [ ! -f "$WORK/php-$ver/libphp.so" ]; then
      die "PHP $ver did not produce libphp.so"
    fi
    # The lab only needs the session/standard surface; keep the module.
    rm -rf "$BUILD_ROOT/opt/php2shell/php" "$BUILD_ROOT/opt/php-src-$ver"
  done

  log "build rootfs ready"
}

extract_offsets() { # extract_offsets <libphp> <outfile>
  local lib=$1 out=$2 zif dtor
  # Consume all of nm's output: `exit` in awk closes the pipe early and nm
  # then dies with SIGPIPE, which `set -o pipefail` would turn into a build
  # failure (rc 141).
  zif=$(nm "$lib" 2>/dev/null | awk '$3 == "zif_system" { z = $1 } END { print z }')
  dtor=$(nm "$lib" 2>/dev/null | awk '$3 == "zval_ptr_dtor" { d = $1 } END { print d }')
  [ -n "$zif" ] || die "could not find zif_system in $lib"
  [ -n "$dtor" ] || die "could not find zval_ptr_dtor in $lib"
  {
    printf 'ZIF_OFFSET=0x%s\n' "$zif"
    printf 'DTOR_OFFSET=0x%s\n' "$dtor"
    printf 'LIBPHP_SHA256=%s\n' "$(sha256_of "$lib")"
  } >"$out"
  log "offsets from $(basename "$lib"): zif=0x$zif dtor=0x$dtor"
}

runtime_rootfs() { # runtime_rootfs <dir>
  local dir=$1
  extract_base "$dir"
  log "installing runtime libraries"
  in_rootfs "$dir" '
    set -e
    apt-get -o APT::Sandbox::User=root update -q
    apt-get -o APT::Sandbox::User=root install -y -q --no-install-recommends \
      libapr1t64 libaprutil1t64 libpcre2-8-0 libssl3t64 libxml2 \
      libsqlite3-0 libcurl4t64 libonig5 libreadline8t64 libsodium23 \
      libargon2-1 zlib1g libexpat1 liblua5.3-0 ca-certificates \
      iproute2 curl netcat-openbsd
  ' >"$BUILD_LOGS/apt-runtime.log" 2>&1 ||
    die "runtime library installation failed (see $BUILD_LOGS/apt-runtime.log)"
}

assemble_image() { # assemble_image <name> <php-version> <php-ini>
  local name=$1 ver=$2 ini=$3
  local root=$WORK/image-$name
  local out=$IMAGES/$name

  if [ "$FORCE" != 1 ] && [ -f "$out/rootfs.ext4" ] && [ -f "$out/offsets.env" ] &&
    [ -f "$out/vmlinux" ]; then
    log "image $name already built; reusing (use --force to rebuild)"
    return 0
  fi

  runtime_rootfs "$root"

  # Apache tree + PHP module/config from the pinned build.
  rm -rf "$root/opt/php2shell"
  mkdir -p "$root/opt/php2shell"
  cp -a "$BUILD_ROOT/opt/php2shell/apache" "$root/opt/php2shell/apache"
  rm -f "$root/opt/php2shell/apache/modules/libphp.so"
  cp "$WORK/php-$ver/libphp.so" "$root/opt/php2shell/apache/modules/libphp.so"
  mkdir -p "$root/opt/php2shell/apache/conf"
  cp "$LAB_DIR/lab/httpd.conf.in" "$root/opt/php2shell/apache/conf/php2shell.conf"

  mkdir -p "$root/opt/php2shell/php/etc"
  cp "$ini" "$root/opt/php2shell/php/etc/php.ini"

  # Shared extensions (opcache, sodium) for this exact PHP build. The module's
  # compiled extension_dir is the build prefix, not the official image's
  # /usr/local, so rewrite the ini to the path we actually populate.
  local extdir=$root/opt/php2shell/php/lib/php/extensions/no-debug-non-zts-20240924
  mkdir -p "$extdir"
  cp -a "$WORK/php-$ver/extensions/." "$extdir/" 2>/dev/null || true
  sed -i "s|^extension_dir = .*|extension_dir = \"/opt/php2shell/php/lib/php/extensions/no-debug-non-zts-20240924\"|" \
    "$root/opt/php2shell/php/etc/php.ini"

  # Webroot + service entrypoint.
  mkdir -p "$root/www" "$root/app"
  cp "$LAB_DIR/lab/www/index.php" "$root/www/index.php"
  install -m 0755 "$LAB_DIR/lab/app-start" "$root/app/start"

  # Offsets and metadata.
  mkdir -p "$out"
  extract_offsets "$WORK/php-$ver/libphp.so" "$out/offsets.env"
  {
    printf 'IMAGE=%s\n' "$name"
    printf 'PHP_VERSION=%s\n' "$ver"
    printf 'HTTPD_VERSION=%s\n' "$HTTPD_VERSION"
    printf 'PHP_INI=%s\n' "$(basename "$ini")"
    printf 'BUILT_AT=%s\n' "$(date -Is)"
    printf 'TOOLKIT_COMMIT=%s\n' "$TOOLKIT_PIN"
    printf 'UPSTREAM_COMMIT=%s\n' "$UPSTREAM_PIN"
  } >"$out/meta.env"

  # build-rootfs.sh installs /rctf/init + /rctf/jq and creates the base dirs.
  # Run it under fakeroot when available so the image's files are root-owned
  # even though the host build is unprivileged.
  local jq=$SMOKE_ARTIFACTS/dl/jq
  [ -x "$jq" ] || die "static jq missing at $jq"
  local br="$FC_DIR/guest/build-rootfs.sh"
  [ -x "$br" ] || die "guest builder missing at $br"
  log "assembling $name rootfs.ext4"
  if command -v fakeroot >/dev/null; then
    fakeroot -- bash "$br" --dir "$root" --size 768M --jq "$jq" \
      --out "$out/rootfs.ext4" >"$BUILD_LOGS/rootfs-$name.log" 2>&1 ||
      die "rootfs assembly failed for $name (see $BUILD_LOGS/rootfs-$name.log)"
  else
    warn "fakeroot not found; the image's files will keep the build uid"
    bash "$br" --dir "$root" --size 768M --jq "$jq" \
      --out "$out/rootfs.ext4" >"$BUILD_LOGS/rootfs-$name.log" 2>&1 ||
      die "rootfs assembly failed for $name (see $BUILD_LOGS/rootfs-$name.log)"
  fi

  cp "$SMOKE_ARTIFACTS/images/smoke/vmlinux" "$out/vmlinux"
  chmod 0644 "$out/vmlinux" "$out/rootfs.ext4"
  rm -rf "$root"
  log "image $name ready: $out"
}

build_rootfs

case "${ONLY:-all}" in
  vuln) assemble_image php2shell-vuln "$PHP_VULN" "$LAB_DIR/lab/php.ini" ;;
  patched) assemble_image php2shell-patched "$PHP_FIXED" "$LAB_DIR/lab/php.ini" ;;
  hardened) assemble_image php2shell-hardened "$PHP_VULN" "$LAB_DIR/lab/php-hardened.ini" ;;
  all)
    assemble_image php2shell-vuln "$PHP_VULN" "$LAB_DIR/lab/php.ini"
    assemble_image php2shell-patched "$PHP_FIXED" "$LAB_DIR/lab/php.ini"
    assemble_image php2shell-hardened "$PHP_VULN" "$LAB_DIR/lab/php-hardened.ini"
    ;;
  *) die "unknown image: $ONLY (vuln|patched|hardened)" ;;
esac

log "done. images: $IMAGES"
