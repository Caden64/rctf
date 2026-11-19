# xweb — results

Dated record of what actually ran, on which machine, with which exact
outcome. Anything not executed is marked **NOT RUN**.

Host (reference machine): Linux, 16 CPUs, 54 GiB RAM, `/dev/kvm` present and
readable/writable, QEMU with nested virtualization working (previous
Firecracker lab runs green on this host), ~1.7 TiB free disk.

## 2026-11-19 — unprivileged selftest and image build (host)

Executed for real, unprivileged, on the host.

- Command: `cd deploy/firecracker/labs/xweb && ./selftest.sh`
- Result: **75 passed, 0 failed**; exit 0. Covers the fail-closed classifier
  (13 canned outcomes), the lab-authored portal source driven with the exact
  payload set on the host python 3.14.10 (the same version the guest pins):
  vuln build default-creds/bypass/UNION-archive/UNION-login/bad-column
  behaviour, patched-build denials, flagless-boot behaviour, and `bash -n` /
  `sh -n` / `py_compile` syntax checks of every lab piece.
- Command: `cd deploy/firecracker/labs/xweb && ./build.sh`
- Result: **green**; exit 0. Unpacked the pinned Alpine minirootfs + 17
  verified `.apk` files with `tar` only, called
  `../../guest/build-rootfs.sh --dir` per image, no root, no container
  engine, no chroot, no guest binary executed on the host.
- Build-time assertions observed passing per image: python banner `3.14.10`
  read out of `usr/lib/libpython3.14.so.1.0` bytes, `_sqlite3` module and
  `libsqlite3.so.0` present, musl loader present / no glibc loader, themed
  app + schema + default credentials staged, concatenated-SQL seam asserted
  in `xweb-vuln` and parameterized seam (with no SQL-text concatenation) in
  `xweb-patched`, `/etc/xweb-build` identity asserted back.
- Pinned-input verification observed: Alpine minirootfs digest matched the
  publisher's `.sha256` file; Firecracker tarball pin matched the publisher's
  release `.sha256.txt`; every cached `.apk` re-hashed clean.

| Image          | Size | rootfs.ext4 sha256 (this build)                             |
| -------------- | ---- | ----------------------------------------------------------- |
| `xweb-vuln`    | 256M | see `$XWEB_IMAGES/MANIFEST.txt` (per-build; mkfs UUID/timestamps vary) |
| `xweb-patched` | 256M | see `$XWEB_IMAGES/MANIFEST.txt` (per-build; mkfs UUID/timestamps vary) |

Bytes differ between rebuilds (mkfs UUID/timestamps), exactly as the sshole
lab documents; the build-time assertions tie every image back to the pinned
package digests and the running guest reports its own build marker, which
the runner asserts.

## 2026-11-19 — full nested-KVM end-to-end run

**NOT RUN YET** — this section is updated only after the real
`./run.sh` execution completes on a quiet host (a sibling lab's nested-KVM
verification was still finishing when the build above completed). No claim
of a green end-to-end run is made until the transcript exists.
