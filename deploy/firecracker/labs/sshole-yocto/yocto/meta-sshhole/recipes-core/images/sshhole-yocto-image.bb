# sshhole-yocto lab image: a genuine poky core-image-minimal plus the openssh
# server and the two throwaway lab accounts.
#
# The libc is chosen by the build configuration (TCLIBC=musl for the vulnerable
# image, TCLIBC=glibc for the control image); the recipe is identical, so the
# libc is the ONLY difference between the two builds.
#
# Accounts (throwaway, documented in the lab README):
#   alice uid 1000 - shadow password field exactly '*' (the CVE-2026-123158
#                   target; no password can ever match it through crypt())
#   bob   uid 1001 - real SHA-256 crypt ($5$) hash of the documented lab
#                   password 'sshole-lab-bob-password'. The hash is the same
#                   known-good one pinned in the Alpine sshole lab
#                   ($5$ssholelab$6unyGM/PkwS.UT.BT2NITT5GU7sdbPg3YB.R56eQGr9),
#                   re-verified against that password before every build.
#
# extrausers runs useradd/usermod under pseudo against the image rootfs, so
# the accounts are created by the distro's own shadow tooling inside the
# bitbake image assembly (not patched in afterwards on the host).

SUMMARY = "sshhole Yocto lab: OpenSSH 10.3p1 without PAM on poky 6.0.4"
DESCRIPTION = "core-image-minimal + openssh server + lab accounts for CVE-2026-123158"
LICENSE = "MIT"

require recipes-core/images/core-image-minimal.bb

# openssh: the vulnerable stack (stock yocto-6.0.4 openssh 10.3p1, built
# --without-pam because 'pam' is removed from DISTRO_FEATURES in local.conf).
# sshhole-lab-config: /app/start (flag publishing service).
# os-release: the poky identity markers the build assertions read.
IMAGE_INSTALL:append = " openssh sshhole-lab-config os-release"

# qemux86-64's qemuboot machine include adds the qemuboot image class, whose
# EXTRA_IMAGEDEPENDS pulls in qemu-system-native (a runqemu convenience). The
# lab boots this image under Firecracker with the pinned shared kernel, never
# with qemu, and yocto-6.0.4's qemu-system-native 10.2 does not compile
# against the newer kernel uapi headers of this environment (mshv_vp_registers
# redefinition - see RESULTS.md). Dropping just that build dependency does not
# change the image contents: the vulnerable stack (musl libc, stock openssh
# 10.3p1 without PAM, the accounts) is unaffected.
EXTRA_IMAGEDEPENDS:remove = "qemu-system-native qemu-helper-native:do_addto_recipe_sysroot"

inherit extrausers

# usermod -p writes its argument verbatim into the shadow password field, so
# alice's field is exactly '*'. Quoting survives the extrausers eval; the
# escaping of every '$' is verified by the build-time assertions on the
# produced rootfs (/etc/shadow must contain 'alice:*' and bob's $5$ hash).
EXTRA_USERS_PARAMS = "\
    groupadd -g 1000 alice; \
    groupadd -g 1001 bob; \
    useradd -u 1000 -g alice -m -d /home/alice -s /bin/sh alice; \
    usermod -p '*' alice; \
    useradd -u 1001 -g bob -m -d /home/bob -s /bin/sh bob; \
    usermod -p '\$5\$ssholelab\$6unyGM/PkwS.UT.BT2NITT5GU7sdbPg3YB.R56eQGr9' bob; \
"
