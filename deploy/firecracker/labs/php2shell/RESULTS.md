# PHP2Shell lab — results log

All runs are against local, disposable targets created by this harness. No
third-party infrastructure was contacted. Dates are 2026-11-08/09 (UTC).

## Environment

| Component                 | Value                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| Host                      | Arch Linux, 16 cores, 54 GiB RAM, AMD-V with nested SVM (`/dev/kvm` readable) |
| Bubblewrap                | `/usr/bin/bwrap` (rootless user + mount namespaces)                           |
| e2fsprogs                 | 1.47.4                                                                        |
| GCC (Ubuntu 24.04 chroot) | 13.3.0                                                                        |
| PHP                       | 8.4.26 (vulnerable), 8.4.27 (fixed)                                           |
| Apache                    | 2.4.69 (source build, prefork + DSO)                                          |
| Base rootfs               | Ubuntu 24.04.5 (`ubuntu-base-24.04.5-base-amd64.tar.gz`)                      |

## 1. Host-side build — PASS

Command:

```sh
deploy/firecracker/labs/php2shell/build.sh
```

The build ran unprivileged on the host inside a rootless Ubuntu 24.04 chroot
(`bwrap --unshare-user`). No sudo, docker or podman was used.

| Image                | PHP    | php.ini                   | `rootfs.ext4` | `zif_system` | `zval_ptr_dtor` |
| -------------------- | ------ | ------------------------- | ------------- | ------------ | --------------- |
| `php2shell-vuln`     | 8.4.26 | 8M, `display_errors=On`   | 768 MiB       | `0x467af0`   | `0x65f060`      |
| `php2shell-patched`  | 8.4.27 | 8M, `display_errors=On`   | 768 MiB       | `0x46e380`   | `0x66baf0`      |
| `php2shell-hardened` | 8.4.26 | 128M, `display_errors=On` | 768 MiB       | `0x467af0`   | `0x65f060`      |

Offsets were extracted from **our** built `libphp.so` with
`nm libphp.so | awk '$3=="zif_system"'` (and `zval_ptr_dtor`) and recorded in
each image's `offsets.env`. The images are root-owned inside ext4 (the build
ran `build-rootfs.sh` under `fakeroot`), contain `/rctf/init`, `/rctf/jq`,
`/app/start`, `/www/index.php`, `/opt/php2shell/apache/bin/httpd` and the
matching `libphp.so`, and boot with the shared smoke `vmlinux`.

Pinned digests were re-checked on every fetch (PHP 8.4.26
`c248abae…`, PHP 8.4.27 `5bafed99…`, httpd 2.4.69 `c551b986…`, Ubuntu base
`e77b6f10…`; toolkit `2479e2d`, upstream `d6f888e`).

## 2. Unprivileged self-test — PASS (35/35)

```sh
deploy/firecracker/labs/php2shell/selftest.sh
# RESULT: 33 passed, 0 failed
```

Covers digest verification (accept/reject/missing), offset parsing (valid,
non-hex, missing), proof assertion (only `uid=33(www-data)`), stable free-port
selection, `bash -n` for every script, and the laboratory invariants
(single prefork worker, `KeepAlive Off`, 8M vs 128M, GET-only session start).

## 3. Chain calibration against the official image — stages 1–2 PASS, stage 3 NOT GREEN

The toolkit's calibrator was run over HTTP against the official
`php:8.4.26-apache` image tags, extracted from the OCI registry and run in a
rootless chroot with the toolkit's `lab/rce/apache.conf` + `lab/rce/php.ini`
and the image's own Apache/PHP. This is the environment the toolkit documents.

### 3.1 `php:8.4.26-apache-bookworm` (Debian 12, Apache 2.4.68, PHP 8.4.26)

`libphp.so` sha256 `ff3ea77f…`, offsets `zif=0x45a3b0 dtor=0x64eb60`.

```text
[*] stage1 probe: stale block taken by v0841
    N=841 len=63 -> cookie=4096 chunk=0x7f14d0400000
[*] stage2 T=406 -> libphp=0x7f14cea00000
```

Stages 1 and 2 reproduced exactly with `N=841`, forge length **63**, `T=406`,
`V=16`. The toolkit's shipped profile says forge length 79; the current image
yields 63, which is why the runner defaults to 63.

Stage 3 was attempted with:

- the bookworm carrier layout (`htdata=0x690d8`, six `31:31` pads, 3 attempts);
- the explicit “lab” layout (`htdata=0x6e0d8`, five `4:4` + six `31:31` pads,
  `fake_len=31`, `fakes=12`, `b_name_len=3`, `wfields=5`, cookie, 8 attempts).

No proof. The exploit never executed `id>p`; the target's `system()` path is
known-good (a benign `<?php system("id > /var/www/html/sysok")` page wrote
`uid=33(www-data)` in the same chroot).

### 3.2 `php:8.4.26-apache` (Debian 13/trixie, Apache 2.4.69, PHP 8.4.26)

`libphp.so` sha256 `51663cf8…`, offsets `zif=0x465370 dtor=0x65eb60` (the
toolkit's `8.4.26-bookworm` offsets).

With the toolkit's bookworm profile the runner reached:

```text
[+] chunk base = 0x7fac33800000
[+] libphp base = 0x7fac35600000
[*] stage 3: HTDATA=0x7fac338690d8 ZIF=0x7fac35a65370
```

and then failed all five stage-3 attempts (and the explicit deb13 layout with
a fresh Apache master). No proof.

### 3.3 Source-built Ubuntu image (this lab's default)

The Ubuntu 24.04 build's stage 1 did **not** reproduce the toolkit's 48-byte
value reclaim with `N=841/892`. A request with the forge length the image
needs produced a garbage forged length
(`55102866029003747`) and the worker aborted with `zend_mm_heap corrupted`:
the stale `PS(id)` block lands at a different Zend MM size class on this
toolchain, so the upstream request shape does not align it. This is a
build-specific heap-calibration difference, not a claim that the CVE is
absent. It is the reason the source-built image's positive chain is **NOT
RUN** in the VM (see §4).

**Conclusion for §3:** the leak stages are real and reproducible on the
official image; stage 3 was not reproduced here. The lab runner reports a
failure rather than a proof, and the two controls are only meaningful once the
positive chain is green.

## 4. VM end-to-end run — plumbing PASS, positive chain NOT GREEN

Command:

```sh
P2S_SKIP_BUILD=1 P2S_CHAIN_RETRIES=1 \
  deploy/firecracker/labs/php2shell/run.sh
```

The runner uses its own `VM_DIR` and free ssh/seed ports (`2402`/`8202` in
the reuse run), provisions the vmtest VM with `provision.sh`, installs the
shipped agent unit in jailer mode, stages the three images, creates an
instance through the real agent API with one TCP expose, starts an `ssh -L`
forward inside the VM and runs the fetched toolkit. Every assertion is
fail-closed.

What actually ran (2026-11-08/09):

- the pinned Ubuntu cloud image was fetched and its GPG signature verified;
- the VM booted and cloud-init provisioning completed;
- `host-setup.sh` ran on a fresh host and the shipped systemd unit started
  the agent in **jailer mode**;
- the agent reported `accepting:true` and every preflight check true
  (`kvm`, `firecrackerBin`, `jailerBin`, `imagesDir`, `imagesTrusted`,
  `runDir`, `cgroupRoot`, `chrootBase`, `nft`, `ip`, `conntrackBin`,
  `ipForward`, `traefikDirWritable`, `quarantineWritable`, `tcpPortRange`,
  `subnetPool`);
- the three images were staged into the agent's `imagesDir` (root-owned,
  0755/0644, `imagesTrusted:true`);
- an instance was created through `PUT /v1/instances/<id>` with one TCP
  expose and reached `running` after the agent's TCP readiness probe;
- the `ssh -L 127.0.0.1:<fwd>:<guestIp>:8080` forward was established inside
  the VM and the toolkit was executed against
  `http://127.0.0.1:<fwd>/index.php` with the image's explicit offsets.

The first runs found and fixed real harness bugs (all fail-closed, none
silent):

1. the agent API was called from the host instead of the VM's loopback; the
   helpers now execute `curl` through `vm_ssh` and read the body/code back;
2. a temp directory used for the agent YAML was removed before use (the
   agent-config step now has its own temp dir);
3. the image-staging tarball used the same removed temp dir (now its own);
4. the `nm | awk` offset extraction exited `awk` early and made `nm` die
   with SIGPIPE under `pipefail` (now consumes all output);
5. the runtime rootfs was missing the guest boot-contract tools (`ip`,
   `curl`/`nc`); the guest init could not fetch MMDS or add the metadata
   route, so the service never became reachable. The images now install
   `iproute2`, `curl` and `netcat-openbsd`;
6. the tunnel cleanup used `pkill -f 'ssh -N -L 127.0.0.1:<port>'`, whose
   pattern also matched the outer `vm.sh ssh` command line (the remote
   command is part of its argv) and killed the session before the forward
   existed. It now kills the recorded PID from `/tmp/p2s-tunnel.pid`.

The positive chain on the source-built Ubuntu image stopped at stage 1: the
stale `PS(id)` block is not reclaimed by the upstream 48-byte value shape on
this toolchain (the same calibration difference as §3.3), so the runner
reported a chain failure and did **not** fabricate a proof. The exact
transcript is in `~/.cache/rctf-p2s-lab/logs/run-<stamp>.log` (host-specific
paths, not committed).

The last run (2026-11-08 17:38 UTC, instance `p2s202611081738431468514v`,
guest `10.201.0.2:8080`) exercised the complete path and then failed closed:

```text
vulnerable instance: p2s202611081738431468514v
guest endpoint: 10.201.0.2:8080 (forwarded on 127.0.0.1:18000 inside the VM)
target serves PHP 8.4.26
==> running the PHP2Shell chain
chain attempt 1/1 (stage-3 profile: bookworm)
[*] target http://127.0.0.1:18000/index.php (cmd='id>/www/p')
[*] offsets: zif=0x467af0 dtor=0x65f060 htdata=0x6e0d8
[*] stage 1: heap leak (attempt 1/3)
[-] heap leak missed
...
FAIL: the chain did not produce the web-uid proof
```

The same run was repeated with the toolkit's explicit “lab” stage-3 layout;
it also failed at stage 1. No proof file was served and no PASS was recorded.

## 5. Negative controls — implemented, not exercised end-to-end

| Control | Image                                              | Design                                                                                                    | Status                                                                       |
| ------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A       | `php2shell-patched` (8.4.27)                       | target reachable + serves 8.4.27, then the chain must fail without a proof                                | implemented in `run.sh`; not reached because the positive chain failed first |
| B       | `php2shell-hardened` (8.4.26, `memory_limit=128M`) | target reachable + serves 8.4.26, then the 12 MiB OOM field must not exhaust 128M and the chain must fail | implemented in `run.sh`; not reached                                         |

Both controls use the image's own `offsets.env`, so the only intended
difference is the PHP version or the php.ini condition. A control that cannot
prove the target is reachable and serving the expected version is reported as
a failure, never as a negative.

## 6. Stretch goal — NOT DONE

The nginx + PHP-FPM variant (the toolkit's `lab/fpm` chain) was **not
implemented**. Only the Apache prefork + `mod_php` path exists.

## 7. Honest limitations

- **Stage 3 is not green.** The public chain's last stage is build- and
  instance-dependent; this environment did not reproduce it. Treat the lab as
  a calibrated harness plus a verified leak demonstration until stage 3 is
  calibrated for the exact image you serve.
- **The source-built Ubuntu image does not match the official image's heap.**
  The build is faithful to the official configure flags but uses Ubuntu
  24.04's glibc/gcc; the stage-1 alignment differs. The runner's defaults are
  the official image's calibrated values and are overridable.
- **One host, nested KVM.** Firecracker runs on KVM-on-KVM; timing and ASLR
  differ from bare metal. The chain is probabilistic even when calibrated.
- **No docker/podman.** The build and the offset extraction are deliberately
  rootless and docker-free; the official-image comparison in §3 was done by
  extracting OCI layers and running them in a rootless chroot, not by running
  containers.
