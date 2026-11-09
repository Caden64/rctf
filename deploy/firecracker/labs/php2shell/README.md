# PHP2Shell training lab (guest-side)

A disposable, single-team CTF training lab for the publicly disclosed PHP
`session.upload_progress` memory-corruption chain (CVE-2026-109618 /
CVE-2026-109619, fixed upstream in PHP 8.4.27 / 8.5.12). It runs entirely
inside throwaway microVMs inside the throwaway `vmtest` QEMU VM. Nothing
contacts third-party infrastructure, and no part of this directory is a
production attack tool.

> **Authorized use only.** The chain is run against a local loopback target
> inside a disposable VM that this harness creates and destroys. Do not point
> the toolkit at systems you do not own or have written permission to test.
> The lab is a defensive exercise: it shows why a laboratory configuration
> (`display_errors=On`, `memory_limit=8M`, one prefork worker) is required, and
> it ships two negative controls that prove version and configuration
> sensitivity.

## What the lab proves

The chain is the public research exploit by **9bie**
(`php2shell-bypass-aslr-exp`). The toolkit by **devploit/php2shell** (MIT)
orchestrates it:

```text
stage 1  Set-Cookie out-of-bounds read  -> Zend MM 2 MiB chunk base
stage 2  Set-Cookie out-of-bounds read  -> libphp base (zval_ptr_dtor)
stage 3  upload_progress fake reference -> pDestructor = zif_system
proof    `id>/www/p` executed by the Apache worker, fetched over HTTP
```

The lab is deliberately built around the _laboratory conditions_ the chain
needs. It is not a claim that a default production PHP is exploitable in the
same way:

| Condition                         | Lab value                              | Why                                                    |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| PHP                               | 8.4.26                                 | last vulnerable 8.4 release; fixed in 8.4.27           |
| SAPI                              | Apache prefork + `mod_php`, one worker | chain assumes one child                                |
| `display_errors`                  | `On`                                   | the heap leak is rendered in a request-startup warning |
| `memory_limit`                    | `8M`                                   | the OOM field is `memory_limit + 12M`                  |
| `post_max_size`                   | `512M`                                 | the OOM body must not be rejected                      |
| `session.upload_progress.enabled` | `On`                                   | the trigger                                            |
| `session.use_cookies`             | `1`, `use_strict_mode = 0`             | session behavior                                       |

The hardened control keeps everything else identical and raises
`memory_limit` to `128M`, above the 12 MiB OOM field. The patched control keeps
the laboratory php.ini and swaps PHP to 8.4.27. Both must fail closed.

## Pinned versions and digests

`fetch.sh` downloads and verifies all of these before use. Re-pinning is a
reviewed change; a changed upstream file is a hard failure.

| Artifact                       | Version       | SHA-256 / commit                                                   |
| ------------------------------ | ------------- | ------------------------------------------------------------------ |
| PHP (vulnerable)               | 8.4.26        | `c248abaebc4bb777b80968f0760da0da8e989836e896c9ff637b6775d7d37662` |
| PHP (fixed control)            | 8.4.27        | `5bafed9994c1a49796b25b5f61c22c9183bfe046b6acc7b363842d03c77f972f` |
| Apache httpd                   | 2.4.69        | `c551b9861e26f146f57e1b1765e69c89a60b3db0ec252ccab0d36283487016bb` |
| Ubuntu base rootfs             | 24.04.5 amd64 | `e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86` |
| devploit/php2shell toolkit     | `2479e2d`     | `2479e2dd95c64fd9a8bf83f9f482c17e2cbc987b`                         |
| 9bie/php2shell-bypass-aslr-exp | `d6f888e`     | `d6f888ebd3f0e188bb662e16f23747afdf35e42f`                         |

### Upstream licensing and how the exploit is used

The 9bie research repository has **no license file**. It is therefore not
vendored into this repository. `fetch.sh` clones the pinned commit into the
harness cache and the runner uses it from that checkout. At `d6f888e` the
repository's root `exploit.py` is a later pure-HTTP 128 MiB /
`display_errors=Off` research chain; the verified 8 MiB Apache chain the
toolkit orchestrates is preserved in the same checkout at
`archive/legacy-8m/exploit.py`. `fetch.sh` promotes that file into a run-time
staging directory (`$CACHE/upstream-legacy/exploit.py`) so the toolkit's own
runtime patcher operates on it exactly as the toolkit does on its pinned
checkout. The 9bie code's own terms apply to that checkout; if you need a clear
license, contact its author.

## Build (host-side, unprivileged)

`build.sh` does not need root, docker or podman. It uses `bwrap` (bubblewrap)
to run a rootless Ubuntu 24.04 chroot in a user + mount namespace:

1. Extract the pinned Ubuntu 24.04 base rootfs.
2. `apt-get` the build dependencies **inside the user namespace** as its root.
3. Build Apache 2.4.69 (`--with-mpm=prefork --enable-so`).
4. Build PHP 8.4.26 and 8.4.27 with the official `php:*-apache` Dockerfile's
   configure flags and `CFLAGS` (`-fstack-protector-strong -fpic -fpie -O2
-D_LARGEFILE_SOURCE -D_FILE_OFFSET_BITS=64`, `LDFLAGS=-Wl,-O1 -pie`),
   `--with-apxs2` against the Apache just built.
5. Extract `zif_system` and `zval_ptr_dtor` from **your** `libphp.so` with
   `nm` and record them in `<image>/offsets.env`. There is no docker-based
   auto-offset path here; the runner always passes explicit offsets.
6. Assemble three `rootfs.ext4` images with
   `../../guest/build-rootfs.sh --dir` and copy the shared smoke `vmlinux`.
   The runtime rootfs also installs `iproute2`, `curl` and `netcat-openbsd`:
   the guest init's MMDS fetch needs `curl` (or `nc`) and the route to
   `169.254.169.254` needs `ip`, per the guest boot contract.

Output (under `~/.cache/rctf-p2s-lab/images` by default):

| Image                | PHP    | php.ini                       | Purpose            |
| -------------------- | ------ | ----------------------------- | ------------------ |
| `php2shell-vuln`     | 8.4.26 | `lab/php.ini` (8M, errors on) | positive chain     |
| `php2shell-patched`  | 8.4.27 | `lab/php.ini`                 | negative control A |
| `php2shell-hardened` | 8.4.26 | `lab/php-hardened.ini` (128M) | negative control B |

Offsets measured from the built modules (this host, 2026-11-08):

| Image                    | `zif_system` | `zval_ptr_dtor` |
| ------------------------ | ------------ | --------------- |
| vuln / hardened (8.4.26) | `0x467af0`   | `0x65f060`      |
| patched (8.4.27)         | `0x46e380`   | `0x66baf0`      |

`/app/start` runs `httpd -D FOREGROUND` on port 8080, publishes the MMDS flag
to `/www/flag.txt`, and makes `/www` writable by `www-data` for the
out-of-band `id>/www/p` proof. `lab/www/index.php` starts a session for
ordinary GET visitors but deliberately does **not** call `session_start()` on
the multipart POST: an unconditional call re-sends the session cookie and
removes the stage-1 leak header.

## Runner topology

`run.sh` uses the existing `../vmtest/vm.sh` CLI **unchanged** with its own
unique per-run `VM_DIR` and free ssh/seed ports (never the vmtest defaults):

```text
host (unprivileged)
  └─ vm.sh create            # throwaway Ubuntu 24.04 QEMU VM, unique VM_DIR
       ├─ provision.sh       # bun, checkout, firecracker/jailer
       ├─ host-setup.sh + shipped agent unit (jailer mode)
       ├─ PUT /v1/instances/<id>   # real agent API, one tcp expose
       ├─ ssh -L 127.0.0.1:<fwd>:<guestIp>:8080   # inside the VM
       └─ toolkit launcher against http://127.0.0.1:<fwd>/index.php
```

The runner asserts every step and fails closed: a transport error, a missing
readiness, an unparseable API response or a missing proof is a **test
failure**, never a negative result. The negative controls first prove the
target is reachable and serves the expected PHP version, then require the
chain to fail without a proof.

Environment:

- `P2S_CHAIN_RETRIES` (default `1`): full chain attempts per image. The
  toolkit's docs say the chain can take minutes and need retries; stage 3 is
  build/instance dependent. Raise it to `3` on a slow or unlucky host.
- `KEEP_VM=1`: leave the VM running for debugging.
- `P2S_SKIP_BUILD=1`: reuse cached images.
- `P2S_STAGE1_N`, `P2S_FORGE_LEN`, `P2S_STAGE2_T`, `P2S_STAGE2_V`: heap
  calibration overrides (see below).

## Calibration and honest status

The toolkit's verified 8 MiB Apache profile is build-specific. The
`php2shell_auto.py`/`php2shell_calibrate.py` calibrator was run over HTTP
against the official `php:8.4.26-apache` image while developing this lab. On
the bookworm tag it discovered:

```text
stage1: stale block taken by v0841, forge length 63 -> chunk=0x...
stage2: T=406 -> libphp=0x...
```

Those values (`N=841`, forge `63`, `T=406`, `V=16`) are the runner's defaults.
They differ from the toolkit's shipped `8.4.26-bookworm` profile (`forge 79`)
because the official image was rebuilt; always calibrate against the exact
build you serve.

**This is the honest part:** the stage-1 and stage-2 leaks were reproduced
against the official image, but stage 3 (`pDestructor = zif_system`) was not
reproduced in this environment, on either the official image tags or the
source-built Ubuntu image, with the toolkit's known stage-3 layouts. The
runner therefore reports a chain failure rather than a proof on such a host.
See `RESULTS.md` for the exact runs. The build, image assembly, offset
extraction, VM/agent/instance/tunnel plumbing and the fail-closed controls are
implemented and were exercised; the positive chain is the part that is not
green here.

If you need the lab green for an event, calibrate stage 3 against the exact
image you serve with `php2shell_calibrate.py --stage3-sweep ...` (or the
upstream's gdb recipes) and pin the resulting pads/htdata in `run_chain`. Do
not guess offsets.

## Requirements and cost

- `/dev/kvm` readable/writable on the host, with nested virtualization enabled
  for the guest (Firecracker runs KVM-on-KVM).
- `qemu-system-x86_64`, `qemu-img`, `ssh`, `ssh-keygen`, `curl`, `python3`,
  `bwrap`, `fakeroot` (optional but recommended), `mkfs.ext4` (e2fsprogs
  > = 1.47), `nm`, `tar`, `flock`.
- ~5 GiB RAM free for the vmtest VM (4 GiB), ~10 GiB disk for the VM plus the
  images (~2.5 GiB), and network access on the first run for the pinned
  downloads and the Ubuntu cloud image.
- Time: the first build is ~8-10 minutes on 8+ cores; the first VM boot
  (cloud image download + cloud-init packages) is ~5-10 minutes; the chain
  itself is seconds to a few minutes per attempt.

## Files

| Path                   | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `fetch.sh`             | pinned downloads + git commits, SHA-256 verification, TOFU note |
| `build.sh`             | rootless Ubuntu build of Apache/PHP and the three images        |
| `run.sh`               | full vmtest VM end-to-end run with controls                     |
| `selftest.sh`          | unprivileged fail-closed self-test (35 checks)                  |
| `lib.sh`               | pinned constants and shared helpers                             |
| `lab/httpd.conf.in`    | single-worker prefork + mod_php lab vhost                       |
| `lab/php.ini`          | laboratory php.ini (8M, display_errors On)                      |
| `lab/php-hardened.ini` | negative control (128M)                                         |
| `lab/www/index.php`    | landing page (GET session, chain-safe POST)                     |
| `lab/app-start`        | `/app/start`: flag publish + foreground httpd                   |
| `RESULTS.md`           | dated log of what actually ran                                  |

## Not done

The nginx + PHP-FPM variant (the toolkit's `lab/fpm` chain) is a stretch goal
and is **not implemented**. See `RESULTS.md`.
