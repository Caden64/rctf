#!/usr/bin/env bash
#
# Host-side, unprivileged build of the PHP2Shell training-lab images from the
# OFFICIAL php:8.4.2x-apache OCI images.
#
# No docker, no podman, no root: layers are fetched from the registry by pinned
# manifest+layer digest with curl, verified, extracted with tar, and assembled
# with guest/build-rootfs.sh (mkfs.ext4 -d).
#
# Output (under $P2S_CACHE/images, default ~/.cache/rctf-p2s-lab/images):
#   php2shell-vuln/      php:8.4.26-apache  + lab php.ini (8M)
#   php2shell-patched/   php:8.4.27-apache  + lab php.ini (8M)   control A
#   php2shell-hardened/  php:8.4.26-apache  + 128M php.ini      control B
#   <image>/vmlinux, rootfs.ext4, offsets.env, meta.env
#
# The Apache/PHP runtime is the image's own (its apache2, libphp.so, modules,
# extension config and envvars). Only these files are added:
#   /etc/apache2/ports.conf                     Listen 8080
#   /etc/apache2/conf-enabled/zz-php2shell.conf single worker, KeepAlive Off
#   /etc/apache2/conf-enabled/zz-lab.conf       DocumentRoot /www
#   /usr/local/etc/php/conf.d/zz-php2shell.ini  laboratory php.ini
#   /www/{index,version}.php, /app/start
#   /usr/local/bin/{busybox,ip}                 boot-contract ip route/link
# and /rctf/{init,jq} from guest/build-rootfs.sh. No php.ini is installed: the
# official image ships none, and output_buffering=0 is load-bearing for the
# stage-1 leak (see lab/php-oci.ini).
#
# Usage:
#   ./build-oci.sh                 # build all three images (cached)
#   ./build-oci.sh --force         # re-extract and rebuild from scratch
#   ./build-oci.sh --only vuln
set -euo pipefail
. "$(dirname -- "$0")/lib.sh"
. "$LAB_DIR/oci-pins.sh"
. "$LAB_DIR/oci.sh"

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
      sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required"
command -v mkfs.ext4 >/dev/null || die "e2fsprogs >= 1.47 is required"
command -v nm >/dev/null || die "binutils (nm) is required"

"$LAB_DIR/fetch.sh" --toolkit-only ||
  die "could not fetch the pinned toolkit/upstream checkouts"
ensure_smoke_artifacts || die "could not obtain the shared Firecracker artifacts"
BUSYBOX=$SMOKE_ARTIFACTS/dl/rootdir/bin/busybox
[ -x "$BUSYBOX" ] || die "shared smoke busybox missing at $BUSYBOX"
JQ=$SMOKE_ARTIFACTS/dl/jq
[ -x "$JQ" ] || die "static jq missing at $JQ"

BUILD_LOGS=$WORK/build-logs
mkdir -p "$BUILD_LOGS" "$IMAGES"

extract_offsets() { # extract_offsets <libphp> <outfile>
  local lib=$1 out=$2 zif dtor
  zif=$(nm "$lib" 2>/dev/null | awk '$3 == "zif_system" { z = $1 } END { print z }')
  dtor=$(nm "$lib" 2>/dev/null | awk '$3 == "zval_ptr_dtor" { d = $1 } END { print d }')
  [ -n "$zif" ] || die "could not find zif_system in $lib"
  [ -n "$dtor" ] || die "could not find zval_ptr_dtor in $lib"
  # nm pads with leading zeroes; normalise so the profile's values compare
  # equal as text (and stay readable).
  zif=$(printf '0x%x' "$((16#$zif))")
  dtor=$(printf '0x%x' "$((16#$dtor))")
  {
    printf 'ZIF_OFFSET=%s\n' "$zif"
    printf 'DTOR_OFFSET=%s\n' "$dtor"
    printf 'LIBPHP_SHA256=%s\n' "$(sha256_of "$lib")"
  } >"$out"
  log "offsets from $OCI_TAG libphp.so: zif=$zif dtor=$dtor"
}

overlay_image() { # overlay_image <root> <php-ini>
  local root=$1 ini=$2
  # The official image ships no php.ini on purpose. If a future pinned image
  # grows one, it would change output_buffering and break the stage-1 leak;
  # refuse instead of silently keeping it.
  if [ -e "$root/usr/local/etc/php/php.ini" ]; then
    die "pinned image unexpectedly contains /usr/local/etc/php/php.ini"
  fi
  printf 'Listen 8080\n' >"$root/etc/apache2/ports.conf"
  install -m 0644 "$LAB_DIR/lab/apache-oci.conf" \
    "$root/etc/apache2/conf-enabled/zz-php2shell.conf"
  install -m 0644 "$LAB_DIR/lab/lab-oci.conf" \
    "$root/etc/apache2/conf-enabled/zz-lab.conf"
  install -m 0644 "$ini" "$root/usr/local/etc/php/conf.d/zz-php2shell.ini"
  mkdir -p "$root/www" "$root/app" "$root/usr/local/bin"
  install -m 0644 "$LAB_DIR/lab/www/index.php" "$root/www/index.php"
  install -m 0644 "$LAB_DIR/lab/www/version.php" "$root/www/version.php"
  install -m 0755 "$LAB_DIR/lab/app-start-oci" "$root/app/start"
  # The boot contract needs `ip`/`nc`; the image has curl but no iproute2.
  # BusyBox comes from the pinned shared smoke artifacts (sha256 verified by
  # the smoke fetch) so the image's libc and PHP runtime stay untouched.
  install -m 0755 "$BUSYBOX" "$root/usr/local/bin/busybox"
  ln -sf busybox "$root/usr/local/bin/ip"
  ln -sf busybox "$root/usr/local/bin/nc"
}

assemble_image() { # assemble_image <name> <php-version> <php-ini> <description>
  local name=$1 ver=$2 ini=$3 what=$4
  local out=$IMAGES/$name root=$WORK/oci-image-$name
  local src

  oci_pins "$ver" || die "no pinned OCI image for PHP $ver"
  # Reuse only an image built from the same pinned OCI manifest; a cached
  # source-built image (or one from another digest) must not be mistaken for
  # this one.
  if [ "$FORCE" != 1 ] && [ -f "$out/rootfs.ext4" ] && [ -f "$out/offsets.env" ] &&
    [ -f "$out/vmlinux" ] && [ -f "$out/meta.env" ] &&
    grep -qx 'APACHE=official-image' "$out/meta.env" 2>/dev/null &&
    grep -qx "OCI_MANIFEST_DIGEST=$OCI_MANIFEST_DIGEST" "$out/meta.env" 2>/dev/null; then
    log "image $name already built from $OCI_MANIFEST_DIGEST; reusing"
    return 0
  fi

  oci_prepare "$ver" || die "could not fetch the pinned $OCI_TAG image"
  src=$CACHE/oci/$OCI_TAG/root
  oci_extract_root "$ver" "$src" || die "could not extract $OCI_TAG"

  log "assembling $name from $OCI_TAG ($what)"
  rm -rf "$root"
  mkdir -p "$root"
  cp -a "$src/." "$root/" || die "could not copy the extracted rootfs"
  overlay_image "$root" "$ini"

  mkdir -p "$out"
  extract_offsets "$root/usr/lib/apache2/modules/libphp.so" "$out/offsets.env"

  # Materialise image ownership (root:root, /www owned by www-data) without
  # root privileges, then assemble the ext4 image.
  local br="$FC_DIR/guest/build-rootfs.sh"
  [ -x "$br" ] || die "guest builder missing at $br"
  local asm=$WORK/oci-assemble-$name.sh
  cat >"$asm" <<EOF
set -e
chown -R 0:0 "$root"
chown -R 33:33 "$root/www"
chmod 0755 "$root/www"
bash "$br" --dir "$root" --size 768M --jq "$JQ" --out "$out/rootfs.ext4"
EOF
  if command -v fakeroot >/dev/null; then
    fakeroot -- bash "$asm" >"$BUILD_LOGS/rootfs-$name.log" 2>&1 ||
      die "rootfs assembly failed for $name (see $BUILD_LOGS/rootfs-$name.log)"
  else
    warn "fakeroot not found; image ownership will be the build uid"
    bash "$asm" >"$BUILD_LOGS/rootfs-$name.log" 2>&1 ||
      die "rootfs assembly failed for $name (see $BUILD_LOGS/rootfs-$name.log)"
  fi
  rm -f "$asm"

  cp "$SMOKE_ARTIFACTS/images/smoke/vmlinux" "$out/vmlinux"
  chmod 0644 "$out/vmlinux" "$out/rootfs.ext4"
  {
    printf 'IMAGE=%s\n' "$name"
    printf 'DESCRIPTION=%s\n' "$what"
    printf 'PHP_VERSION=%s\n' "$ver"
    printf 'OCI_TAG=%s\n' "$OCI_TAG"
    printf 'OCI_INDEX_DIGEST=%s\n' "$OCI_INDEX_DIGEST"
    printf 'OCI_MANIFEST_DIGEST=%s\n' "$OCI_MANIFEST_DIGEST"
    printf 'OCI_CONFIG_DIGEST=%s\n' "$OCI_CONFIG_DIGEST"
    printf 'PHP_INI=%s\n' "$(basename "$ini")"
    printf 'APACHE=official-image\n'
    printf 'BUILT_AT=%s\n' "$(date -Is)"
    printf 'TOOLKIT_COMMIT=%s\n' "$TOOLKIT_PIN"
    printf 'UPSTREAM_COMMIT=%s\n' "$UPSTREAM_PIN"
  } >"$out/meta.env"
  rm -rf "$root"
  log "image $name ready: $out"
}

# 8.4.26 is shared by the positive image and the hardened control; prepare it
# once so both reuse the verified extraction and the downloaded layers.
oci_pins 8.4.26
case "${ONLY:-all}" in
  vuln | hardened)
    oci_prepare 8.4.26 || die "could not fetch php:8.4.26-apache"
    oci_extract_root 8.4.26 "$CACHE/oci/8.4.26-apache/root" ||
      die "could not extract php:8.4.26-apache"
    ;;
  patched | all) ;;
  *) die "unknown image: $ONLY (vuln|patched|hardened)" ;;
esac

case "${ONLY:-all}" in
  vuln) assemble_image php2shell-vuln "$PHP_VULN" "$LAB_DIR/lab/php-oci.ini" "positive chain (official 8.4.26)" ;;
  patched) assemble_image php2shell-patched "$PHP_FIXED" "$LAB_DIR/lab/php-oci.ini" "control A: fixed 8.4.27" ;;
  hardened) assemble_image php2shell-hardened "$PHP_VULN" "$LAB_DIR/lab/php-oci-hardened.ini" "control B: 128M memory_limit" ;;
  all)
    assemble_image php2shell-vuln "$PHP_VULN" "$LAB_DIR/lab/php-oci.ini" "positive chain (official 8.4.26)"
    assemble_image php2shell-patched "$PHP_FIXED" "$LAB_DIR/lab/php-oci.ini" "control A: fixed 8.4.27"
    assemble_image php2shell-hardened "$PHP_VULN" "$LAB_DIR/lab/php-oci-hardened.ini" "control B: 128M memory_limit"
    ;;
esac

log "done. official-image guests: $IMAGES"
