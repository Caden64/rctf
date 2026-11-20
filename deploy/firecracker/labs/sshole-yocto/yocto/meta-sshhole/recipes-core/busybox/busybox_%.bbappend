# sshhole-yocto busybox bbappend.
#
# The rCTF guest init (deploy/firecracker/guest/init, FROZEN and therefore not
# changed here) fetches the MMDS metadata with
#
#     nc -w "$FETCH_TIMEOUT" "$MMDS_HOST" "$MMDS_PORT"
#
# (the curl transport is only used when a curl binary exists in the image, and
# poky's busybox-only core-image-minimal has none). The stock yocto-6.0.4
# busybox defconfig builds the MINIMAL nc applet - CONFIG_NC_EXTRA is not set,
# so `nc -w ...` prints "Usage: nc [IPADDR PORT]" and fails instantly. Every
# boot then exhausts the 45 s metadata budget, init exits non-zero and the
# guest panic-loops (verified against a real Firecracker boot; the console
# shows the nc usage lines followed by "Attempted to kill init").
#
# This fragment turns on busybox's documented nc extensions (-e/-i/-w/-f), of
# which the guest contract's raw_http only needs -w (initial-connection
# timeout). It is merged into the stock defconfig by the busybox recipe's own
# merge_config.sh step; nothing else about busybox changes. Every other applet
# the guest init needs (mount, hostname, ip, awk, sed, cut, tr, printf, date,
# sleep, test, mkdir, cat) is already enabled in the stock defconfig.
FILESEXTRAPATHS:prepend := "${THISDIR}/files:"

SRC_URI:append = " file://sshhole-mmds-nc.cfg"

# Enforce the fragment exactly where it is merged: fail the busybox build
# unless the final .config really carries CONFIG_NC_EXTRA=y. (There is
# deliberately no byte-level re-check later: poky's defconfig sets
# CONFIG_FEATURE_COMPRESS_USAGE, so the compiled usage strings are a gzip
# blob inside the binary and `strings` cannot see them.)
do_configure:append() {
    grep -q '^CONFIG_NC_EXTRA=y' ${B}/.config ||
        bbfatal "sshhole-mmds-nc.cfg did not take effect: busybox must carry CONFIG_NC_EXTRA for the rCTF guest init MMDS fetch (nc -w)"
}
