# sshhole-lab-config: the guest-side plumbing the lab needs beyond the stock
# poky image. This is NOT vulnerability-relevant code: it only installs
# /app/start (the service the rCTF guest init execs, publishing the per-run
# MMDS flag and then running sshd) and marks the image so the runner can tell
# the builds apart. The vulnerable stack (openssh 10.3p1, musl libc, no PAM,
# the two accounts) comes from stock yocto-6.0.4 plus the image recipe.

SUMMARY = "sshhole Yocto lab guest service (/app/start)"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

SRC_URI = "file://app-start \
           file://app-start.LICENSE"

do_install() {
    install -d ${D}/app
    install -m 0755 ${UNPACKDIR}/app-start ${D}/app/start
    install -m 0644 ${UNPACKDIR}/app-start.LICENSE ${D}/app/start.LICENSE
}

FILES:${PN} = "/app/start /app/start.LICENSE"
