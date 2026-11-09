#!/usr/bin/env bash
# Rootless OCI image fetch/extract helpers (no docker, no podman).
#
# The image is addressed by digest only. Every byte is checked against the
# pinned digest before use:
#   * the manifest body's sha256 must equal the pinned amd64 manifest digest,
#   * its config and layer descriptor list must equal the pinned descriptors,
#   * every layer blob's sha256 must equal its descriptor digest.
# Nothing is extracted from an unverified layer.
#
# Requires: curl, jq, tar, sha256sum, python3.

# oci_token: print an anonymous pull token for the pinned repository.
oci_token() {
  curl -fsSL --retry 3 --connect-timeout 20 \
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$OCI_REPOSITORY:pull" |
    jq -er '.token'
}

oci_manifest_url() { printf 'https://%s/v2/%s/manifests/%s' "$OCI_REGISTRY" "$OCI_REPOSITORY" "$1"; }
oci_blob_url() { printf 'https://%s/v2/%s/blobs/%s' "$OCI_REGISTRY" "$OCI_REPOSITORY" "$1"; }

# oci_fetch_manifest <token> <out>: download the pinned amd64 manifest by
# digest and verify it plus its descriptor list. Sets OCI_LAYER_COUNT.
oci_fetch_manifest() {
  local token=$1 out=$2 body got want i digest size
  body=$(curl -fsSL --retry 3 --connect-timeout 20 \
    -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "$(oci_manifest_url "$OCI_MANIFEST_DIGEST")") ||
    { printf 'ERROR: could not fetch the pinned manifest %s\n' "$OCI_MANIFEST_DIGEST" >&2; return 1; }
  printf '%s' "$body" >"$out"
  got=$(sha256_of "$out")
  want=${OCI_MANIFEST_DIGEST#sha256:}
  [ "$got" = "$want" ] || {
    printf 'ERROR: manifest digest mismatch: got %s, want %s\n' "$got" "$want" >&2
    return 1
  }
  [ "$(jq -r '.config.digest // empty' "$out")" = "$OCI_CONFIG_DIGEST" ] || {
    printf 'ERROR: config digest is not the pinned %s\n' "$OCI_CONFIG_DIGEST" >&2
    return 1
  }
  OCI_LAYER_COUNT=$(jq -r '.layers | length' "$out")
  [ "$OCI_LAYER_COUNT" = "${#OCI_LAYER_DIGESTS[@]}" ] || {
    printf 'ERROR: manifest has %s layers, %s are pinned\n' \
      "$OCI_LAYER_COUNT" "${#OCI_LAYER_DIGESTS[@]}" >&2
    return 1
  }
  for i in $(seq 0 $((OCI_LAYER_COUNT - 1))); do
    read -r digest size < <(jq -r ".layers[$i] | \"\(.digest) \(.size)\"" "$out")
    [ "$digest" = "${OCI_LAYER_DIGESTS[$i]}" ] || {
      printf 'ERROR: layer %s digest %s is not the pinned %s\n' \
        "$i" "$digest" "${OCI_LAYER_DIGESTS[$i]}" >&2
      return 1
    }
    [ "$size" = "${OCI_LAYER_SIZES[$i]}" ] || {
      printf 'ERROR: layer %s size %s is not the pinned %s\n' \
        "$i" "$size" "${OCI_LAYER_SIZES[$i]}" >&2
      return 1
    }
  done
  return 0
}

# oci_fetch_blob <token> <digest> <dest> [expected-size]
oci_fetch_blob() {
  local token=$1 digest=$2 dest=$3 want_size=${4:-} tmp
  if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "${digest#sha256:}" ]; then
    if [ -n "$want_size" ]; then
      [ "$(stat -c %s "$dest")" = "$want_size" ] || {
        printf 'ERROR: cached %s has the wrong size\n' "$dest" >&2
        return 1
      }
    fi
    return 0
  fi
  tmp=$dest.part.$$
  curl -fsSL --retry 3 --connect-timeout 20 -H "Authorization: Bearer $token" \
    -o "$tmp" "$(oci_blob_url "$digest")" ||
    { rm -f "$tmp"; printf 'ERROR: could not download %s\n' "$digest" >&2; return 1; }
  verify_sha256 "$tmp" "${digest#sha256:}" "OCI blob $digest" >/dev/null || {
    rm -f "$tmp"
    return 1
  }
  [ -z "$want_size" ] || [ "$(stat -c %s "$tmp")" = "$want_size" ] || {
    rm -f "$tmp"
    printf 'ERROR: blob %s has the wrong size\n' "$digest" >&2
    return 1
  }
  mv "$tmp" "$dest"
}

# oci_prepare <php-version>: fetch (or reuse) the verified manifest, config and
# layers for the pinned image. Sets OCI_DIR (cache dir) and OCI_MANIFEST_FILE.
oci_prepare() {
  local ver=$1 token i digest size
  oci_pins "$ver" || return 1
  OCI_DIR=$DL/oci/$OCI_TAG
  mkdir -p "$OCI_DIR"
  token=$(oci_token) || { printf 'ERROR: could not get a registry token\n' >&2; return 1; }
  OCI_MANIFEST_FILE=$OCI_DIR/manifest.json
  oci_fetch_manifest "$token" "$OCI_MANIFEST_FILE" || return 1
  oci_fetch_blob "$token" "$OCI_CONFIG_DIGEST" "$OCI_DIR/config.json" || return 1
  for i in $(seq 0 $((OCI_LAYER_COUNT - 1))); do
    read -r digest size < <(jq -r ".layers[$i] | \"\(.digest) \(.size)\"" "$OCI_MANIFEST_FILE")
    oci_fetch_blob "$token" "$digest" "$OCI_DIR/layer-$i.tgz" "$size" ||
      { printf 'ERROR: layer %s download failed\n' "$i" >&2; return 1; }
  done
  return 0
}

# oci_extract_root <php-version> <outdir>: extract the verified layers (lowest
# first) into <outdir>, applying OCI whiteouts. Reuses a cached extraction when
# its stamp matches the pinned manifest digest. The result is owned by the
# invoking user; image ownership is materialised later under fakeroot.
oci_extract_root() {
  local ver=$1 out=$2 i remember= stamp
  oci_pins "$ver" || return 1
  stamp=$CACHE/oci/$OCI_TAG/root.stamp
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$OCI_MANIFEST_DIGEST" ] &&
    [ -d "$out" ] && [ -x "$out/usr/sbin/apache2" ]; then
    log "reusing verified OCI rootfs extraction for $OCI_TAG"
    return 0
  fi
  rm -rf "$out"
  mkdir -p "$out"
  for i in $(seq 0 $(( ${#OCI_LAYER_DIGESTS[@]} - 1 ))); do
    log "extracting $OCI_TAG layer $((i + 1))/${#OCI_LAYER_DIGESTS[@]}"
    oci_apply_layer "$DL/oci/$OCI_TAG/layer-$i.tgz" "$out" || return 1
  done
  [ -x "$out/usr/sbin/apache2" ] || {
    printf 'ERROR: %s has no /usr/sbin/apache2 after extraction\n' "$OCI_TAG" >&2
    return 1
  }
  printf '%s\n' "$OCI_MANIFEST_DIGEST" >"$CACHE/oci/$OCI_TAG/root.stamp"
  return 0
}

# oci_apply_layer <layer.tgz> <root>: apply OCI whiteouts and extract one
# verified layer. Rejects absolute member names and `..` components.
oci_apply_layer() {
  local tgz=$1 root=$2
  python3 - "$tgz" "$root" <<'PY' || return 1
import os, sys, tarfile

tgz, root = sys.argv[1], os.path.realpath(sys.argv[2])
deletes = []
with tarfile.open(tgz, "r:gz") as tf:
    for m in tf.getmembers():
        name = m.name
        norm = os.path.normpath(name).lstrip("/")
        if name.startswith("/") or ".." in norm.split("/"):
            sys.exit(f"unsafe layer member: {name!r}")
        base = os.path.basename(norm)
        if base == ".wh..wh..opq":
            d = os.path.dirname(norm)
            if d:
                deletes.append((d, True))
        elif base.startswith(".wh."):
            target = os.path.join(os.path.dirname(norm), base[4:])
            deletes.append((target, False))
for target, opaque in deletes:
    path = os.path.realpath(os.path.join(root, target))
    if not (path == root or path.startswith(root + os.sep)):
        sys.exit(f"whiteout escapes root: {target!r}")
    if opaque:
        if os.path.isdir(path):
            for e in os.listdir(path):
                p = os.path.join(path, e)
                if os.path.isdir(p) and not os.path.islink(p):
                    import shutil; shutil.rmtree(p)
                else:
                    os.unlink(p)
    elif os.path.islink(path) or os.path.isfile(path):
        os.unlink(path)
    elif os.path.isdir(path):
        import shutil; shutil.rmtree(path)
sys.exit(0)
PY
  # GNU tar: --no-same-owner keeps this unprivileged; --numeric-owner is
  # irrelevant without ownership but keeps the operation deterministic.
  tar --no-same-owner --numeric-owner -xzf "$tgz" -C "$root" \
    --exclude='.wh.*' --exclude='*/.wh.*' || return 1
  # Remove any whiteout marker that the exclude patterns did not catch.
  find "$root" -name '.wh.*' -print0 2>/dev/null | xargs -0r rm -f --
  return 0
}
