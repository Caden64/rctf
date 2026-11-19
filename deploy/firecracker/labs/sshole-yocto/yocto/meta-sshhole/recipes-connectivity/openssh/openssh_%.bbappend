# sshhole-yocto openssh bbappend (CVE-2026-123158 lab).
#
# The ONLY change to the stock yocto-6.0.4 openssh 10.3p1 recipe is the
# sshd_config file: putting this layer's files/ directory first on the
# FILESEXTRAPATHS search path makes the stock recipe's own do_configure /
# do_install machinery install the lab sshd_config (PasswordAuthentication yes,
# UsePAM no, PermitRootLogin prohibit-password, AllowUsers alice bob) instead
# of the stock one. No patch, no version change: the pinned stock recipe
# (openssh_10.3p1.bb, upstream sha256 56682a36bb92dcf4b4f016fd8ec8e74059b79
# a8de25c15d670d731e7d18e45f4, with only the unrelated CVE-2026-59995..60002
# backports) is the vulnerable build.
FILESEXTRAPATHS:prepend := "${THISDIR}/files:"

# The privsep user already exists (stock recipe USERADD_PARAM), and the
# documented lab accounts are created by the image recipe through extrausers.
# Everything else about the build stays stock.
