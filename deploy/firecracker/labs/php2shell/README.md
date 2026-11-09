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
> (`display_errors=On`, `memory_limit=8M`, one prefork worker, no `log_errors`,
> no `php.ini`) is required, and it ships two negative controls that prove
> version and configuration sensitivity.

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

The guest is built **from the official `php:8.4.2x-apache` OCI image** (the
same image the toolkit calibrated against), so its Apache, `libphp.so`,
modules and extension configuration are the image's own bytes. The runner
asserts, in the VM, exactly what is proven:

| Image | Build | Assertions |
| --- | --- | --- |
| `php2shell-vuln` | `php:8.4.26-apache` + lab php.ini (8M) | stage-1 stale-id OOM leak **and** stage-2 libphp leak reproduce; stage 3 executes `id>/www/p` as `uid=33(www-data)` when a calibrated profile is present |
| `php2shell-patched` | `php:8.4.27-apache` + lab php.ini (8M) | serves 8.4.27; both leak primitives are **absent**; the chain fails closed with no proof |
| `php2shell-hardened` | `php:8.4.26-apache` + 128M php.ini | serves 8.4.26 with `memory_limit=128M`; at the shipped 12 MiB OOM body neither leak reproduces and the chain fails closed |

Stage 3 is **env/config-gated**: it runs only when a calibration profile (or
explicit `P2S_STAGE3_HTDATA`/`P2S_STAGE3_PADS`) provides a geometry recorded
with a real proof. Without one the runner asserts the memory-safety primitives
and prints `RCE: NOT ASSERTED`; it never fabricates a proof. `P2S_REQUIRE_RCE=1`
turns an uncalibrated run into a hard failure.

The lab is deliberately built around the _laboratory conditions_ the chain
needs. It is not a claim that a default production PHP is exploitable in the
same way:

| Condition | Lab value | Why |
| --- | --- | --- |
| PHP | 8.4.26 | last vulnerable 8.4 release; fixed in 8.4.27 |
| SAPI | Apache prefork + `mod_php`, one worker | chain assumes one child |
| `display_errors` | `On` | the heap leak is rendered in a request-startup warning |
| `output_buffering` | `0` (no `php.ini`) | the warning must be flushed so `SG(headers_sent)=1`; a stock `php.ini-production` (4096) silently kills stage 1 |
| `log_errors` | `Off` | measured: turning logging on also kills the stage-1 Set-Cookie leak even with `display_errors=On` |
| `memory_limit` | `8M` | the OOM field is `memory_limit + 12M` |
| `post_max_size` | `512M` | the OOM body must not be rejected |
| `session.upload_progress.enabled` | `On` | the trigger |
| `session.use_cookies` | `1`, `use_strict_mode = 0` | session behavior |
| landing page | `<?php echo "OK\n";` | any allocation on the POST path moves the free list and misses the stage-1 reclaim slot |

The hardened control keeps everything else identical and raises
`memory_limit` to `128M`, above the 12 MiB OOM field. The patched control keeps
the laboratory php.ini and swaps PHP to 8.4.27. Both must fail closed.

### Honest limit of control B

The toolkit documents that the same 8.4.26 build is exploitable at `128M`
when the OOM body is raised to `140M` (limit + 12M); its verification table
records RCE at both 8M and 128M. Control B therefore proves that the **8M
memory_limit is a load-bearing laboratory condition**, not that raising the
limit mitigates the vulnerability. `P2S_HARDENED_LIMIT_PROBE=1` runs the
`huge_mb=140` variant against the same hardened guest as an informational
(non-asserting) probe and records the outcome in `RESULTS.md`.

## Pinned versions and digests

`fetch.sh` and `build-oci.sh` verify all of these before use. Re-pinning is a
reviewed change; a changed upstream file is a hard failure.

| Artifact | Version | SHA-256 / commit |
| --- | --- | --- |
| PHP (vulnerable) | 8.4.26 | `c248abaebc4bb777b80968f0760da0da8e989836e896c9ff637b6775d7d37662` |
| PHP (fixed control) | 8.4.27 | `5bafed9994c1a49796b25b5f61c22c9183bfe046b6acc7b363842d03c77f972f` |
| Apache httpd (source build only) | 2.4.69 | `c551b9861e26f146f57e1b1765e69c89a60b3db0ec252ccab0d36283487016bb` |
| Ubuntu base rootfs (source build only) | 24.04.5 amd64 | `e77b6f10c2590cef872b33ee9f635a0e3fd1f57fb074c0e52b5c7f56147a0c86` |
| devploit/php2shell toolkit | `2479e2d` | `2479e2dd95c64fd9a8bf83f9f482c17e2cbc987b` |
| 9bie/php2shell-bypass-aslr-exp | `d6f888e` | `d6f888ebd3f0e188bb662e16f23747afdf35e42f` |
| Official OCI image (positive/hardened) | `php:8.4.26-apache` amd64 | manifest `sha256:b0ae0e0d…f50d1`, index `sha256:60111400…c11a` |
| Official OCI image (patched control) | `php:8.4.27-apache` amd64 | manifest `sha256:7c3d8b9e…7354c`, index `sha256:884f64b4…530d0` |

Every OCI config and layer digest, with sizes, is pinned in `oci-pins.sh`.
The registry is addressed by digest only: the tags above are provenance, never
the download selector. Layers are fetched with `curl`, checked against their
`sha256` descriptor before extraction, and applied with OCI whiteout handling.

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

## Build (host-side, unprivileged, no docker)

`build-oci.sh` (default; used by `run.sh`) fetches the pinned official images
by digest with `curl` and assembles the rootfs with the guest's
`build-rootfs.sh` (`mkfs.ext4 -d`). No root, docker or podman is used.

Only these paths are added to the image; everything else is the image's own:

| Path | Purpose |
| --- | --- |
| `/etc/apache2/ports.conf` | `Listen 8080` |
| `/etc/apache2/conf-enabled/zz-php2shell.conf` | `KeepAlive Off`, one prefork worker |
| `/etc/apache2/conf-enabled/zz-lab.conf` | `DocumentRoot /www`, PHP handler for `/www` |
| `/usr/local/etc/php/conf.d/zz-php2shell.ini` | laboratory php.ini (8M, no `log_errors`) |
| `/www/index.php`, `/www/version.php` | inert landing page; version + `memory_limit` for assertions |
| `/app/start` | MMDS flag publish, `/www` ownership, `apache2-foreground` |
| `/usr/local/bin/{busybox,ip,nc}` | boot-contract `ip route`/`ip link` (busybox from the sha256-verified shared smoke artifacts) |
| `/rctf/{init,jq}` | installed by `guest/build-rootfs.sh` |

No `php.ini` is installed: the official image ships none, and
`output_buffering=0` is required by the stage-1 leak. `build-oci.sh` fails if a
future pinned image starts shipping one.

Output (under `~/.cache/rctf-p2s-lab/images` by default):

| Image | PHP | php.ini | Purpose |
| --- | --- | --- | --- |
| `php2shell-vuln` | 8.4.26 | `lab/php-oci.ini` (8M) | positive chain |
| `php2shell-patched` | 8.4.27 | `lab/php-oci.ini` (8M) | negative control A |
| `php2shell-hardened` | 8.4.26 | `lab/php-oci-hardened.ini` (128M) | negative control B |

Offsets measured from the pinned images (2026-11-09):

| Image | `zif_system` | `zval_ptr_dtor` |
| --- | --- | --- |
| vuln / hardened (8.4.26, trixie) | `0x465370` | `0x65eb60` |
| patched (8.4.27, trixie) | `0x46ad70` | `0x66a620` |

`build.sh` remains as an alternative **source** build (Ubuntu 24.04 chroot,
Apache/PHP built with the official Dockerfile flags). It is *not* byte-identical
to the official image and its stage-1 heap alignment differs; use it only with
`P2S_GUEST=source` and a profile calibrated for that build. The OCI guest is
the default for a reason: it is the environment the toolkit's profile and this
lab's stage-3 calibration were measured in.

## Runner topology

`run.sh` uses the existing `../vmtest/vm.sh` CLI **unchanged** with its own
unique per-run `VM_DIR` and a port set allocated by **one simultaneous bind**
(never vmtest's 2422/8201):

```text
host (unprivileged)
  └─ vm.sh create            # throwaway Ubuntu 24.04 QEMU VM, unique VM_DIR
       ├─ provision.sh       # bun, checkout, firecracker/jailer
       ├─ host-setup.sh + shipped agent unit (jailer mode)
       ├─ PUT /v1/instances/<id>   # real agent API, one tcp expose
       ├─ ssh -L 127.0.0.1:<fwd>:<guestIp>:8080   # inside the VM
       ├─ leaks.py           # stages 1-2 only (memory-safety primitives)
       └─ chain.py           # full calibrated chain + proof fetch
```

The runner asserts every step and fails closed: a transport error, a missing
readiness, an unparseable API response or a missing proof is a **test
failure**, never a negative result. The negative controls first prove the
target is reachable and serving the expected PHP version and `memory_limit`,
then require both leak primitives to be absent and the chain to fail without a
proof.

Environment:

- `P2S_CHAIN_RETRIES` (default `1`): full chain attempts per image. Stage 3 is
  probabilistic even when calibrated; raise it on a slow host.
- `KEEP_VM=1`: leave the VM running for debugging.
- `P2S_SKIP_BUILD=1`: reuse cached images.
- `P2S_GUEST=official` (default) or `source`.
- `P2S_PROFILE`: calibration profile (default
  `calibration/php-8.4.26-apache-trixie.json`).
- `P2S_STAGE1_N`, `P2S_FORGE_LEN`, `P2S_STAGE2_T`, `P2S_STAGE2_V`,
  `P2S_STAGE3_HTDATA`, `P2S_STAGE3_PADS`: override the profile. Stage 3 needs
  both values; a partially specified geometry is a hard error.
- `P2S_REQUIRE_RCE=1`: fail if no stage-3 geometry is calibrated.
- `P2S_HARDENED_LIMIT_PROBE=1`: informational `huge_mb=140` probe on control B.

## Calibration and honest status

The toolkit's verified profile is build-specific. This lab's
`calibration/php-8.4.26-apache-trixie.json` records a calibration performed
over HTTP against the exact pinned `php:8.4.26-apache` (trixie) image, in a
rootless user-namespace chroot with the same Apache config and php.ini the
guest ships. The toolkit's calibration methodology was used unchanged:
`php2shell_calibrate.py`'s stage-1 probe (unique 48-byte fields), stage-2
sweep, and its stage-3 layout list, extended with explicit sweeps of the
carrier knobs.

Measured on the pinned image:

```text
stage1: stale block taken by v0841; forge length 63 -> 4096-byte Set-Cookie
stage2: T=406, V=16 -> page-aligned zval_ptr_dtor -> libphp base
stage3: htdata=0x690d8, six (31,31) pads, 15-byte carrier, 167-byte fake
        HashTable -> uid=33(www-data) proof
```

The stage-3 geometry is the toolkit's own `8.4.26-bookworm` carrier layout
(`profiles/8.4.26-bookworm-amd64.json`): this image's `libphp` offsets
(`zif=0x465370`, `dtor=0x65eb60`, `libphp sha256 51663cf8…`) are exactly the
ones that profile records, and the 0x690d8 carrier lands as documented.

Two measured environment facts were required to get there and are enforced by
the build and self-test:

1. **No `php.ini`.** With `output_buffering=4096` the stage-1 startup warning
   does not set `SG(headers_sent)`, so the stale `PS(id)` is cleaned and the
   Set-Cookie is a normal 32-byte id.
2. **No `log_errors`.** Adding `log_errors=On` (with `error_log`) to the
   otherwise identical ini changes the request-startup warning path and
   produces the same normal 32-byte cookie. The shipped ini therefore mirrors
   the toolkit's verified `lab/rce/php.ini` and adds nothing.
3. **An allocation-inert landing page.** `session_start()` on the POST path
   (even behind a `REQUEST_METHOD` check) moves the allocator's free list and
   makes the 4096-byte leak miss. The page is `<?php echo "OK\n";`.

Stage 3 was also tried with the explicit deb13 "lab" layout
(`htdata=0x6e0d8`, five `(4,4)` + six `(31,31)` pads, 31-byte fake refs) and
the vessel variant's parameter range; those are recorded in `RESULTS.md` as
ruled out for this image. The carrier layout is the calibrated one.

## Requirements and cost

- `/dev/kvm` readable/writable on the host, with nested virtualization enabled
  for the guest (Firecracker runs KVM-on-KVM).
- `qemu-system-x86_64`, `qemu-img`, `ssh`, `ssh-keygen`, `curl`, `python3`,
  `jq`, `bwrap`, `fakeroot` (optional but recommended for the source build),
  `mkfs.ext4` (e2fsprogs >= 1.47), `nm`, `tar`, `flock`, `debugfs` (optional).
- ~5 GiB RAM free for the vmtest VM (4 GiB), ~10 GiB disk for the VM plus the
  images (~2.4 GiB), and network access on the first run for the pinned OCI
  layers, the Ubuntu cloud image and the two git checkouts.
- Time: the first OCI build is ~3-5 minutes; the first VM boot (cloud image
  download + cloud-init packages) is ~5-10 minutes; the chain itself is
  seconds to a few minutes per attempt.

## Files

| Path | Purpose |
| --- | --- |
| `fetch.sh` | pinned downloads + git commits, SHA-256 verification, TOFU note |
| `build-oci.sh` | official-image guest build (default; no docker/root) |
| `oci.sh` | digest-addressed registry fetch, verification, layer extraction |
| `oci-pins.sh` | pinned index/manifest/config/layer digests and sizes |
| `build.sh` | optional source build (Ubuntu chroot) |
| `run.sh` | full vmtest VM end-to-end run with controls |
| `leaks.py` | stage-1/2 leak assertions with machine-readable exit codes |
| `chain.py` | full chain with an explicit `--htdata-offset` |
| `amd64.py` | narrows the toolkit's wide pointer filters to amd64 userspace |
| `calibration/` | the measured profile and its provenance |
| `selftest.sh` | unprivileged fail-closed self-test |
| `lib.sh` | pinned constants, offsets/proof helpers, port allocation |
| `lab/apache-oci.conf` | single-worker prefork policy for the official guest |
| `lab/lab-oci.conf` | `/www` document root for the official guest |
| `lab/php-oci.ini` | official-guest laboratory php.ini (8M) |
| `lab/php-oci-hardened.ini` | official-guest hardened control (128M) |
| `lab/www/index.php` | allocation-inert landing page |
| `lab/www/version.php` | version + `memory_limit` for assertions |
| `lab/app-start-oci` | `/app/start`: flag publish + `apache2-foreground` |
| `lab/*` (source-build files) | Apache/PHP source-build lab configuration |
| `RESULTS.md` | dated log of what actually ran |

## Not done

The nginx + PHP-FPM variant (the toolkit's `lab/fpm` chain) is a stretch goal
and is **not implemented**. See `RESULTS.md`.
