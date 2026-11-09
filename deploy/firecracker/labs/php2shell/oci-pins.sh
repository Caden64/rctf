#!/usr/bin/env bash
# Pinned OCI images for the official-image PHP2Shell guest.
#
# The images are fetched from Docker Hub by digest, not by tag: the tag is only
# recorded for provenance and is never used for the download. The manifest list
# digest, the amd64 manifest digest, the config digest and every layer digest
# (with its size) are pinned below. A changed upstream tag therefore cannot
# change what this lab runs; re-pinning is a reviewed change.
#
# Values recorded 2026-11-09 from registry-1.docker.io (library/php amd64).
# Layer blob digests are sha256 over the compressed blob, so each download is
# verified before it is used and no extra digest file is needed.

OCI_REGISTRY=registry-1.docker.io
OCI_REPOSITORY=library/php

oci_pins_8426() {
  OCI_TAG=8.4.26-apache
  OCI_INDEX_DIGEST=sha256:60111400ff77bdc44fa79b4f072afe49a42abba71e0846ad496be4761dc9c11a
  OCI_MANIFEST_DIGEST=sha256:b0ae0e0d4a3b7f0e800017482752b94f58ab049f2d7fcd108e5452afce3f50d1
  OCI_CONFIG_DIGEST=sha256:46b195b6378e712d1a65cd3f853242bebd7f3cb4cafe137fd592b365909d2c17
  OCI_LAYER_DIGESTS=(
    sha256:f2be67225471500c788ce88c597eb5ea8336e912ad1ca4815650e0281afe2034
    sha256:938fb0002764080b4325e74d7c628b45992643b253b094337ad7d920364937b0
    sha256:85667d86c34747ee6a1228447eb21df1b8c5374812fc5b5c78527b7d33f942f7
    sha256:2e0677e4c933f55b0286a8d5eb129742d6f21a519c2de9d85c641d9fdc2a2b0e
    sha256:4bbbed6ae0e79c53d8f66133f2edf2f1857731b921c6bc04180338c6283d59c8
    sha256:d5337c4d634f1abcca7b4593372c495a5343b0897a93315af6ba9ef9cfef0f84
    sha256:612a5e72ef6d265f2f4e221936e09626bbcd994dd82f792b7401adfdb718d606
    sha256:0176c38c24c1f3cba75b31b4a9695ba9505f5c675fc97c46ed105fc2a339d5f8
    sha256:6a30f6b92dd2619401f37a2799eeff611c72208720ca5267d030468ffe2a50e1
    sha256:340ca2c9e3db4d35cd75630a3ddf315eca8f74193858eb2f650df4190623bc75
    sha256:9a092caccb2f6d58b75baeb0e2225fafbffb2dfcf7f394940b24f9f6d11b738a
    sha256:ccfc183b5846840ad64d58f5e18efbc2cad597c9b195d07ce642b96f7e77ca43
    sha256:11a70d63dfe65433ef124b2897d1c9416aa54e0c1062cf6aca88c85b2a44d271
    sha256:2e8d91297bc7c7ded8f59904bbe444cdc1f358c6ca5ab37f8c9ddb8cc8b95f55
    sha256:4f4fb700ef54461cfa02571ae0db9a0dc1e0cdb5577484a6d75e68dc38e8acc1
  )
  OCI_LAYER_SIZES=(
    29843579 226 117839383 225 4244082 427 481 13958043 490 13711880
    2463 248 243 894 32
  )
}

oci_pins_8427() {
  OCI_TAG=8.4.27-apache
  OCI_INDEX_DIGEST=sha256:884f64b47174de2c0e813270fe7b24a18605729fcebe201302d98c38805530d0
  OCI_MANIFEST_DIGEST=sha256:7c3d8b9e579e29cdf2fbce05649f8427840798800d4d7c1528e0bf17dec7354c
  OCI_CONFIG_DIGEST=sha256:00cc1fe5876d492ac0b180e6acda327ebf713d7e57d1e3e96f8bd9fce10baee2
  OCI_LAYER_DIGESTS=(
    sha256:37fb86c2a767b88d500c6872195f88078f64765fe0d2f9cc375cc2efbd4c0a41
    sha256:bc1809275eb74212e1003b3c8184a9babff13f3938b5126b32439e46a86b4f76
    sha256:763317e8e82406bcd93298e660dff460212d57b26566e8c13784c079c471cbd2
    sha256:f1279874e909260556a2946171c72d718a320ad6a0a591dc1378651cd0f247f0
    sha256:d9d4be292819677c165d27d056e172f17ec2837bf1dda5b0faf45dc591b8266a
    sha256:6476889f09276744dab0badd432a59084f89f516f964fddee68da30055e95435
    sha256:77998a05dd42e6541018aaf55823057eb7a20737068e9698e5e5b445936d6e25
    sha256:33398883691602ae36e1407b64fbf2c68f8bb48576259e4e7687d06248a56a46
    sha256:78537a14b060ee5497c5c5be058cdf26ba5bc859b5442a922f30e1ed98d2581a
    sha256:bc70471740f73108c498e6eba7a97b24ecc31ec7e8cf3e1417bcb78d38a509a3
    sha256:9ef3b170e20ffef31f29c9c4fc696073143e8539e9c5dd3c618c8183fd7ca04f
    sha256:9b25056db48421b53f2565f442ce907db8442ddd936ddd51a82e46890ff703b1
    sha256:abbdfb142654ea1949d4c870fbd5977f8b4df55317ca1b0f81548ca859443149
    sha256:550aa3c8151cd63060d5ec8f18934283642f350d50d3943d9043e5defa8f27ae
    sha256:4f4fb700ef54461cfa02571ae0db9a0dc1e0cdb5577484a6d75e68dc38e8acc1
  )
  OCI_LAYER_SIZES=(
    29856132 226 117838081 226 4244098 429 483 14030210 488 13755707
    2462 252 247 891 32
  )
}

# oci_pins <php-version>: select the pinned image for 8.4.26 or 8.4.27.
oci_pins() {
  case "$1" in
    8.4.26) oci_pins_8426 ;;
    8.4.27) oci_pins_8427 ;;
    *) printf 'ERROR: no pinned OCI image for PHP %s\n' "$1" >&2; return 1 ;;
  esac
}
