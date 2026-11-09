# PHP2Shell lab — results log

All runs are against local, disposable targets created by this harness. No
third-party infrastructure was contacted. Dates are 2026-11-08/09 (UTC).

## Environment

| Component          | Value                                                                          |
| ------------------ | ------------------------------------------------------------------------------ |
| Host               | Arch Linux, 16 cores, 54 GiB RAM, AMD-V with nested SVM (`/dev/kvm` readable)  |
| Guest base         | official `php:8.4.26-apache` amd64 OCI image (Debian 13 trixie), digest-pinned |
| Fixed control base | official `php:8.4.27-apache` amd64 OCI image (Debian 13 trixie), digest-pinned |
| Apache             | 2.4.69 (image's own `/usr/sbin/apache2`, prefork, one worker)                  |
| PHP                | 8.4.26 (vulnerable) / 8.4.27 (fixed control)                                   |
| Calibration chroot | rootless user+mount namespace (`unshare` + `bwrap`)                            |
| VM harness         | `../vmtest/vm.sh` (unchanged), nested KVM Firecracker 1.17                     |

## 1. Official-image guest build — PASS

Command:

```sh
deploy/firecracker/labs/php2shell/build-oci.sh --force
```

No root, docker or podman. The build fetched the amd64 manifest by **digest**
with `curl`, verified its sha256, verified every config and layer descriptor
against the pins in `oci-pins.sh`, downloaded each layer blob and verified its
sha256 before extracting it with OCI whiteout handling. It then assembled the
rootfs with `guest/build-rootfs.sh` under `fakeroot`.

| Image                | Base                | PHP ini                        | `rootfs.ext4` | `zif_system` | `zval_ptr_dtor` |
| -------------------- | ------------------- | ------------------------------ | ------------- | ------------ | --------------- |
| `php2shell-vuln`     | `php:8.4.26-apache` | 8M, errors on, no `log_errors` | 768 MiB       | `0x465370`   | `0x65eb60`      |
| `php2shell-patched`  | `php:8.4.27-apache` | same                           | 768 MiB       | `0x46ad70`   | `0x66a620`      |
| `php2shell-hardened` | `php:8.4.26-apache` | 128M                           | 768 MiB       | `0x465370`   | `0x65eb60`      |

Pinned and verified on every build:

| Image  | Manifest digest                                                           | `libphp.so` sha256                                                 |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 8.4.26 | `sha256:b0ae0e0d4a3b7f0e800017482752b94f58ab049f2d7fcd108e5452afce3f50d1` | `51663cf883b1223436d4c99f31dd0225735ea5573665e4242621eee7f4ee679c` |
| 8.4.27 | `sha256:7c3d8b9e579e29cdf2fbce05649f8427840798800d4d7c1528e0bf17dec7354c` | (recorded in `meta.env`)                                           |

The extracted roots are Debian trixie with the image's own Apache, `libphp.so`,
modules, `docker-php.conf`, opcache and sodium configuration. The only added
paths are the lab overlay (`ports.conf` 8080, `conf-enabled/zz-php2shell.conf`
single worker + `KeepAlive Off`, `conf-enabled/zz-lab.conf` `/www` document
root, `conf.d/zz-php2shell.ini`, `/www/{index,version}.php`, `/app/start`, a
sha256-verified static busybox at `/usr/local/bin/{busybox,ip,nc}`) and
`/rctf/{init,jq}`. `debugfs` confirms the image files are root-owned, `/www` is
`33:33`, and `ports.conf` is exactly `Listen 8080`.

`build-oci.sh` refuses to reuse an image unless `meta.env` records the same
pinned manifest and `APACHE=official-image`, so the previous source-built
images cannot be mistaken for these.

## 2. Chain calibration against the official image — ALL STAGES PASS

The toolkit's documented methodology was used unchanged:
`php2shell_calibrate.py`'s stage-1 probe, stage-2 sweep and stage-3 layout
list, run over HTTP against the official image in a rootless chroot with the
guest's exact Apache config, php.ini and `/www` document root. Every attempt is
logged in `calibration/8.4.26-calibration.log` and
`calibration/stage3-sweep.log`; the winning profile is
`calibration/php-8.4.26-apache-trixie.json`.

Measured result:

```text
[*] stage1 probe: stale block taken by v0841
    N=841 len=63 -> cookie=4096 chunk=0x7f6095000000
[*] stage2 T=406 -> libphp=0x7f6096c00000
[+] stage3 0x690d8/bookworm try 1/5: uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

This is the toolkit's own `8.4.26-bookworm` **carrier** layout
(`htdata=0x690d8`, six `(31,31)` pads, 15-byte carrier, 15×167-byte fake
HashTables). The image's `libphp` offsets (`zif=0x465370`, `dtor=0x65eb60`)
match that profile exactly, and the carrier lands where the toolkit documents.
The full chain then reproduced **5/5** times on a fresh worker set, proof on
attempt 1 each time.

### 2.1 Stage-3 sweep (bounded, 12 attempts)

Each attempt starts from a fresh prefork worker; `/www/p` is removed inside
the chroot before the attempt; “hit” means `/p` served `uid=33(www-data)`
after that attempt.

| Layout / parameters                                                                                      | Result  |
| -------------------------------------------------------------------------------------------------------- | ------- |
| carrier, `htdata=0x690d8`, 6×(31,31) (calibrated)                                                        | **hit** |
| carrier, `htdata=0x690d0` (−8)                                                                           | miss    |
| carrier, `htdata=0x690e0` (+8)                                                                           | miss    |
| carrier, `htdata=0x690d8`, 5×(31,31)                                                                     | **hit** |
| carrier, `htdata=0x690d8`, 7×(31,31)                                                                     | **hit** |
| carrier, `htdata=0x6e0d8` (deb13 profile)                                                                | miss    |
| carrier, `htdata=0x680d8` (−0x1000)                                                                      | miss    |
| lab, `htdata=0x6e0d8`, 5×(4,4)+6×(31,31), `fake_len=31`, `fakes=12`, `b_name_len=3`, `wfields=5`, cookie | miss    |
| lab, toolkit pads `8:7 + 5×(7,7)`, `htdata=0x6e0d8`                                                      | miss    |
| lab, toolkit pads, `htdata=0x690d8`                                                                      | miss    |
| vessel, defaults, `htdata=0x690d8`                                                                       | miss    |
| vessel, defaults, `htdata=0x680d8`                                                                       | miss    |

What this rules out: the deb13 “lab” composition, the toolkit's lab pads and
the vessel technique do not fit this heap. The exact carrier `htdata` is
load-bearing (a single 8-byte shift misses), while the number of `(31,31)`
pads has tolerance (5, 6 and 7 all hit) — the profile keeps the toolkit's six.
The sweep stopped at a hit for the calibrated layout; the remaining known
layouts were still measured above so the ruling-out is recorded, not assumed.
The sweep budget (`P2S_SWEEP_BUDGET_MIN`, default 90) was not approached.

### 2.2 Environment facts that were required (and are now enforced)

The previous round’s stage-3 failures were **environment**, not parameter,
problems. Each was measured on the pinned image:

1. **A `php.ini` with `output_buffering=4096` kills stage 1.** The official
   image ships no `php.ini`; the stage-1 startup warning must be flushed so
   `SG(headers_sent)` becomes 1. Adding the stock `php.ini-production` gives a
   normal 32-byte session cookie instead of the 4096-byte leak. `build-oci.sh`
   fails if a future pinned image starts shipping a `php.ini`.
2. **`log_errors=On` also kills stage 1**, even with `display_errors=On`.
   Adding just those two lines to the otherwise identical ini produced a
   normal 32-byte cookie. The guest ini leaves logging off.
3. **The landing page must be allocation-inert on POST.** A GET-only
   `session_start()` (even the minimal `REQUEST_METHOD` form) moves the
   allocator's free list and the 4096-byte reclaim misses. The page is the
   toolkit's `<?php echo "OK\n";`.
4. **The proof path must be writable by the worker.** Several early stage-3
   runs executed `system()` but could not write `/www/p` because `/www` was
   not owned by uid 33. The guest `/app/start` performs the chown; the
   calibration harness was corrected to match, after which the same layout
   proofed on the first attempt.
5. **The toolkit's widened pointer filter is unsafe on amd64.** The toolkit
   relaxes the upstream exploit's range to `0x10000..2^48` for aarch64
   profiles. On this image a byte-for-byte valid leak parsed as
   `chunk=0x600000` (63 occurrences of a low value beat 62 real heap
   pointers). `amd64.py` narrows both filters back to canonical amd64
   userspace after the toolkit's own patch, and the correct chunk base is
   recovered. Without it every stage-3 address is wrong.

None of these are chain-parameter changes; they are the laboratory
configuration the toolkit's own verified profile assumes.

## 3. VM end-to-end run — PASS (positive + both controls)

Command (shipped defaults; only the informational control-B probe enabled):

```sh
P2S_SKIP_BUILD=1 P2S_HARDENED_LIMIT_PROBE=1 \
  deploy/firecracker/labs/php2shell/run.sh
```

The runner booted its own vmtest VM with ports from **one simultaneous bind**
(`ssh 38709`, `seed 59225`; neither is vmtest's 2422/8201), provisioned it,
installed the shipped agent unit in **jailer mode**, staged the three images,
created each instance through the real agent API with one TCP expose, started
an `ssh -L` forward inside the VM, and ran the fetched toolkit from inside the
VM. Every assertion is fail-closed.

### 3.1 Vulnerable image (`php:8.4.26-apache` guest)

```text
target serves PHP 8.4.26, memory_limit=8M
PASS: vulnerable PHP 8.4.26 reproduces the stage-1 stale-id OOM leak and the stage-2 libphp leak
chain attempt 1/1
[+] chunk base = 0x7fdadfc00000
[+] libphp base = 0x7fdae1800000
[*] stage 3: HTDATA=0x7fdadfc690d8 ZIF=0x7fdae1c65370
[+] W3 attempt 1
PROOF: uid=33(www-data) gid=33(www-data) groups=33(www-data)
PASS: vulnerable PHP 8.4.26 executes id as uid=33(www-data)
```

The leak assertion is not a heuristic: `leaks.py` runs the pinned toolkit's
stage-1 probe and stage-2 request shapes over HTTP and exits 0 only when both
Set-Cookie leaks yield a valid chunk base and a page-aligned `zval_ptr_dtor`
pointer. The RCE proof is the worker’s own `id` output fetched from `/p`.

### 3.2 Control A — fixed PHP 8.4.27

```text
target serves PHP 8.4.27, memory_limit=8M
PASS: patched PHP 8.4.27: both leak primitives are absent
[*] stage 1: heap leak (attempt 1/3)  [-] heap leak missed
... (3/3)
PASS: patched PHP 8.4.27 failed closed (no proof)
```

The chain is run with the **vulnerable image's** calibrated parameters and the
patched image's own offsets, so the only intended difference is the PHP
version. The version and `memory_limit` are asserted before the negative, so a
transport failure can never be reported as a control pass.

### 3.3 Control B — hardened php.ini (`memory_limit=128M`)

```text
target serves PHP 8.4.26, memory_limit=128M
PASS: hardened php.ini: both leak primitives are absent
[*] stage 1: heap leak (attempt 1/3)  [-] heap leak missed
... (3/3)
PASS: hardened php.ini failed closed (no proof)
```

**Honest result of the informational probe** (`P2S_HARDENED_LIMIT_PROBE=1`):
the _same hardened image_ with the OOM body raised to `huge_mb=140`
(`memory_limit + 12M`, exactly as the toolkit documents) does reproduce both
leaks and the full chain on attempt 1:

```text
PROOF: uid=33(www-data) gid=33(www-data) groups=33(www-data)
OBSERVED: the hardened image DOES execute at huge_mb=140;
          control B is a configuration control, not a mitigation.
```

So control B proves that the lab's **8M `memory_limit` and its 12 MiB OOM
field are load-bearing laboratory conditions**. It does **not** show that
raising `memory_limit` mitigates the vulnerability, and the lab does not claim
that. `RESULTS.md` records this because the opposite claim would be false.

## 4. Self-test and repository checks

```text
deploy/firecracker/labs/php2shell/selftest.sh
# RESULT: 69 passed, 0 failed
```

Covers digest accept/reject/missing, offset parsing/normalisation, proof
assertion (only `uid=33(www-data)`), simultaneous-bind port allocation
(distinct, bindable, excludes 2422/8201 and caller-fixed ports), `bash -n` for
every script, Python syntax for the helpers, the official-guest laboratory
invariants (8M/128M, `display_errors=On`, no `log_errors`, one worker,
`KeepAlive Off`, inert landing page), OCI pin consistency for both images, and
the calibration profile's internal consistency and match against the built
image's offsets.

Repository checks on the same tree:

```text
bun run lint                                   # oxlint --deny-warnings: clean
bun run typecheck                              # all packages: 0 errors
bun run test:firecracker                       # 551 pass, 4 skip, 0 fail
```

## 5. What each invariant proves

| Assertion                                     | Vulnerable 8.4.26            | Patched 8.4.27 | Hardened 128M                            |
| --------------------------------------------- | ---------------------------- | -------------- | ---------------------------------------- |
| target reachable, serves the expected PHP     | PASS                         | PASS           | PASS                                     |
| configured `memory_limit` is the expected one | 8M                           | 8M             | 128M                                     |
| stage-1 stale-`PS(id)` OOM leak               | present                      | absent         | absent at the shipped 12M OOM            |
| stage-2 libphp `zval_ptr_dtor` leak           | present                      | absent         | absent at the shipped 12M OOM            |
| stage-3 fake reference → `zif_system`         | executes, proof on attempt 1 | not reached    | not reached at 12M; **executes at 140M** |
| out-of-band proof `uid=33(www-data)`          | PASS                         | none           | none (none at 12M)                       |

## 6. Honest limitations

- **Stage 3 is probabilistic in general.** It hit attempt 1 in every run here
  (5/5 calibration, 1/1 in each VM run), but the toolkit documents
  build/instance-dependent retries. The runner retries (`P2S_CHAIN_RETRIES`)
  and the leak helper retries the worker-fork race; a miss is a retry, never a
  fabricated proof.
- **Control B is a configuration control only** (see §3.3).
- **One host, nested KVM.** Timing differs from bare metal; the chain is
  deterministic in the user-space heap but worker rotation is a race.
- **No docker/podman.** The image is fetched from Docker Hub by digest with
  `curl`; the registry must be reachable on the first build.
- **The source-built Ubuntu guest is not byte-identical** to the official
  image and does not reproduce the stage-1 alignment. It remains available via
  `P2S_GUEST=source` for development only; the shipped lab uses the OCI guest.
- **The chain's laboratory conditions matter.** `display_errors=On`,
  `memory_limit=8M`, one prefork worker, `output_buffering=0`,
  `log_errors=Off` and an inert landing page are all required on this build.

## 7. Stretch goal — NOT DONE

The nginx + PHP-FPM variant (the toolkit's `lab/fpm` chain) was **not
implemented**. Only the Apache prefork + `mod_php` path exists.

## 8. Reproducing

```sh
# host, unprivileged: fetch pins, verify, build the three official-image guests
deploy/firecracker/labs/php2shell/build-oci.sh

# full VM run: leaks + calibrated RCE + both controls
deploy/firecracker/labs/php2shell/run.sh

# unprivileged self-test only
deploy/firecracker/labs/php2shell/selftest.sh
```

The calibration logs and the winning profile are committed under
`calibration/`; the per-run VM transcripts live under
`~/.cache/rctf-p2s-lab/logs/` (host-specific paths, not committed).
