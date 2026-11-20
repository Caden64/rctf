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

## Final-tree green run (2026-11-09, commits 0d18cac3 + 4a6edf0d)

After the convergence-review fixes, two flakiness sources in the runner were
measured and closed: the leak machinery needs a warmed session state (the
runner now primes the target with one small PHPSESSID +
PHP_SESSION_UPLOAD_PROGRESS POST before every leak and chain assertion —
README "Calibration and honest status" fact 4), and the upstream chain
prints its leak-absent verdict to stderr (chain.py now merges it into
stdout). The full lab then passed end to end on the final integrated tree:

```text
PASS: vulnerable PHP 8.4.26 reproduces the stage-1 stale-id OOM leak and the stage-2 libphp leak
PASS: vulnerable PHP 8.4.26 executes id as uid=33(www-data) gid=33(www-data) groups=33(www-data)
PASS: patched PHP 8.4.27: both leak primitives are absent
PASS: patched PHP 8.4.27: leak absent (chain verdict) and /p answers 404 from the reachable target
PASS: hardened php.ini: both leak primitives are absent
PASS: hardened php.ini: leak absent (chain verdict) and /p answers 404 from the reachable target
ALL PHP2SHELL LAB CHECKS PASSED (leaks + calibrated RCE + controls)
```

The cold-vs-warmed diagnosis is preserved above (§4 and the debug
transcripts): the same instance missed three attempts cold and leaked on the
first attempt after a single priming POST; the strict negative classifier
refused transport-shaped outcomes until the verdict markers were merged into
the captured transcript.

## M364 re-theme re-verification (2026-11-19)

The lab's visible web content was re-themed as the fictional **M364 outage
service-credit portal** (static-only theming; README "Theming"), and the full
lab was re-verified end to end on the same host class as the 2026-11-09 runs
(Arch Linux, 16 cores, 54 GiB RAM, `/dev/kvm` rw, nested SVM; run IDs below
are host-local time, UTC-7).

### What changed (commit b401dda7 on branch `challenge/php2shell-m365`)

- New static theme: `lab/www/{index.html,status.html,m364.css}` — pure
  static files, no PHP execution, installed identically into all three
  images by the shared overlay.
- **`lab/www/index.php` stayed byte-identical.** `git diff 642b4813..HEAD`
  for that file is empty; its sha256 is `e463b149…` before the re-theme, in
  the repository, and inside every rebuilt image (`debugfs cat /www/index.php
  | sha256sum`).
- New `conf-enabled/zz-m364.conf` (`lab/m364-oci.conf`): the reset-then-pin
  `DirectoryIndex` dance that makes the static theme own `GET /`. This is
  the one Apache-config addition the theming strictly required; no shipped
  conf was modified. See the two failed runs below for why the reset is
  load-bearing.
- New theme assertion in `run.sh` (`assert_theme`, every image): `GET /`
  must be byte-identical to `lab/www/index.html` (sha256 compared inside
  the VM) and keep the multipart credit form pointed at `/index.php`.
- New selftest invariants (90 checks total, up from 69) and the event
  registration (`challenge.yaml`) plus `staging-manifest.json`.

### What ran (dated 2026-11-19, UTC-7 local)

1. `./fetch.sh` — **PASS**: all pins re-verified from the cache (every
   cached tarball is re-hashed before use; toolkit `2479e2d`, upstream
   `d6f888e`).
2. `./build-oci.sh --force` — **PASS** (14:57:04): all three images rebuilt
   with the themed overlay. Offsets unchanged from the calibration:
   vuln/hardened `zif=0x465370 dtor=0x65eb60`, patched
   `zif=0x46ad70 dtor=0x66a620`. The theme files and `zz-m364.conf` were
   verified inside all three rootfs images with `debugfs`; the image's
   `/www/index.php` hashes to `e463b149…` (byte-identical).
3. `./selftest.sh` — **PASS: 90 passed, 0 failed** (includes the new theming
   invariants, challenge.yaml sanity and staging-manifest consistency
   checks).
4. `P2S_REQUIRE_RCE=1 P2S_HARDENED_LIMIT_PROBE=1 ./run.sh` — **PASS**
   (run `20261119-145724`, every assertion green):

   ```text
   target serves PHP 8.4.26, memory_limit=8M
   PASS: vulnerable image serves the themed static landing page at / (byte-identical to lab/www/index.html)
   PASS: vulnerable PHP 8.4.26 reproduces the stage-1 stale-id OOM leak and the stage-2 libphp leak
   [*] stage 1: heap leak (attempt 1/3)   [+] chunk base = 0x7ff2a3200000
   [*] stage 2: libphp leak (attempt 1/3) [+] libphp base = 0x7ff2a5000000
   [*] stage 3: HTDATA=0x7ff2a32690d8 ZIF=0x7ff2a5465370
   [+] W3 attempt 1
   PROOF: uid=33(www-data) gid=33(www-data) groups=33(www-data)
   PASS: vulnerable PHP 8.4.26 executes id as uid=33(www-data) gid=33(www-data) groups=33(www-data)
   target serves PHP 8.4.27, memory_limit=8M
   PASS: patched image serves the themed static landing page at / (byte-identical to lab/www/index.html)
   PASS: patched PHP 8.4.27: both leak primitives are absent
   [*] stage 1: heap leak missed (3/3)  HEAP_LEAK_FAILED
   PASS: patched PHP 8.4.27: leak absent (chain verdict) and /p answers 404 from the reachable target
   target serves PHP 8.4.26, memory_limit=128M
   PASS: hardened image serves the themed static landing page at / (byte-identical to lab/www/index.html)
   PASS: hardened php.ini: both leak primitives are absent
   [*] stage 1: heap leak missed (3/3)  HEAP_LEAK_FAILED
   PASS: hardened php.ini: leak absent (chain verdict) and /p answers 404 from the reachable target
   OBSERVED: the hardened image DOES execute at huge_mb=140;
             control B is a configuration control, not a mitigation.
   ALL PHP2SHELL LAB CHECKS PASSED (leaks + calibrated RCE + controls)
     RCE: VERIFIED with the profile's stage-3 geometry
   ```

   **The leaks did not shift.** Stage 1 and stage 2 reproduced on the first
   attempt and the stage-3 proof landed on the first attempt with the
   unchanged shipped profile (`stage1_n=841`, `forge=63`, `stage2_t=406`,
   `htdata=0x690d8`, six `(31,31)` pads). **No recalibration was needed or
   performed** — consistent with the constraint: `index.php` is untouched
   and no themed page executes PHP, so the POST-path allocator state the
   calibration depends on is unchanged.

### The two failed runs it took to get there (honest record)

- **Run 1 (`20261119-144610`): FAILED at the new theme assertion.** `GET /`
  served exactly `OK\n` (sha256 `a12b7cb4…`), i.e. the inert `index.php`
  executed, not the theme. Root cause (found by hashing the served body and
  reading the image's own extracted config, not by guessing): the official
  `php:8.4.26-apache` image ships `conf-enabled/docker-php.conf` with
  `DirectoryIndex disabled` + `DirectoryIndex index.php index.html`, which
  overrides Debian's `dir.conf` order (`index.html` first) and pins the
  inert page at `/`.
- **Run 2 (`20261119-145207`): FAILED the same way** after a bare
  `DirectoryIndex index.html index.php` was added in `zz-m364.conf` —
  `mod_dir` **accumulates** same-context `DirectoryIndex` directives
  (Apache httpd 2.4 docs, mod_dir: multiple directives add to the list; to
  replace it you must explicitly reset it first with the `disabled` token —
  the exact idiom the image's own `docker-php.conf` uses). The bare pin was
  appended *after* docker-php's `index.php`, which therefore kept winning
  the walk order. Fix: reset, then pin; images rebuilt; run 3 green.
- Both failures were caught by the new fail-closed `assert_theme` **before
  any chain claim was made**; the runner never asserted the chain on a
  mis-themed image, and no calibration value was changed at any point.

### What did NOT run

- `bun run lint` / `bun run typecheck` / `bun run test:firecracker`: not
  re-run for this change — it touches only
  `deploy/firecracker/labs/php2shell/**` (shell, HTML/CSS, YAML/JSON), no
  TypeScript sources; the 2026-11-09 record above stands for the tree.
- `build.sh` source guest (`P2S_GUEST=source`): not run; unchanged,
  development-only.
- The nginx + PHP-FPM variant: still **not implemented** (unchanged stretch
  goal).
- The event-side deployment itself (real controller, Traefik `https`
  hostPrefix `m364-credit`): not exercised here — the registration ships as
  `challenge.yaml` verified by `selftest.sh` field checks; the lab's own
  run exercises the same agent API and guest bytes, and its
  `assert_theme` is exactly the `readiness: { kind: http, path: /,
  expectStatus: 200 }` probe the registration promises.
- No recalibration (profile unchanged; the measured geometry reproduced on
  attempt 1).

## Flag objective hardening and the staged M364 records (2026-11-19)

Two deployment-review findings were fixed, each driven by measured
evidence. The final gate is green with the calibration untouched.

### Finding 1: the flag was web-served and on the ext4

`lab/app-start-oci` (and the source `lab/app-start`) copied the per-run
MMDS flag to **`/www/flag.txt`** — the Apache DocumentRoot — so
`GET /flag.txt` handed the objective over plain HTTP with no exploit at
all, and the flag landed on the disk-backed ext4, against the guest
contract. Fix: publish to **`/run/flag.txt`** (tmpfs, 0644, outside the
DocumentRoot) with fail-closed runner assertions
(`assert_flag_http_absent` for `/flag.txt` and `/www/flag.txt`; the RCE
objective exact-matched per run).

Three runs were needed to get the objective itself to work, honestly
recorded:

- **Run `20261119-190956`** — the exploit rejected the 24-byte payload
  `cat /run/flag.txt>/www/p` at its own guard:
  `error: --cmd is limited to 14 bytes by the 167-byte carrier`. The
  command budget is part of the calibrated carrier (`MAX_CMD = 14`;
  the 167-byte fake HashTable leaves a 14-byte slot at 0x98 minus a
  NUL). The carrier is request-shape-invariant to the command bytes
  (the ht blob always travels as 15 identical 167-byte parts), so the
  fix was a pointer, not a geometry change: `/app/start` exports
  **`F=/run/flag.txt`**; recon payload `env>/www/p` reveals `F`, and
  `cat $F>/www/p` (13 bytes) reads the flag.
- **Run `20261119-191753`** — the 13-byte payload executed but produced
  empty proofs on every stage-3 attempt, while `id`/`env`/`echo $F`
  worked. Suspicion narrowed via a new fail-path diagnostic pair.
- **Run `20261119-192914` (the diagnostic run)** — measured ground
  truth: `DIAG 'echo $F>/www/p' rc=0 body='/run/flag.txt'` (chain,
  pointer and expansion all work) versus `DIAG 'ls /run>/www/p' rc=1`
  (empty). Every failing command must **traverse `/run`**. Root cause:
  the **frozen guest init mounts `/run` tmpfs root-only
  (`mount -t tmpfs -o mode=0700,... tmpfs /run`)** — a 0644 file under a
  0700 root is unreadable by the www-data worker the chain executes as.
  No previous lab run had ever verified flag readability (the old
  `/www/flag.txt` was never asserted), which is why this only surfaced
  now. Fix at the service level (the frozen init is untouched): `/app/start`
  opens traversal of the tmpfs root it publishes into
  (**`chmod 0711 /run`**); the raw flags dir `/run/rctf` (0700,
  init-owned) stays root-only, so only the published copy is reachable
  by known path, and the flag bytes still live only on tmpfs. The
  documented need for an init-level service-readable publish mount is
  recorded in the README; it was NOT implemented (frozen path).

### Finding 2: the platform flag name and the staged records

rCTF passes the challenge's registered provider through verbatim, so the
event flag file is `/run/rctf/flags/flags_static` (init sanitises
`flags/static`), not the lab runner's `main`. `/app/start` (both
variants) now resolves the source name-robustly — `main`, then
`flags_static`, then the single file when exactly one exists — fail
closed otherwise. The event is additionally split into **two staged
records sharing the one image**, switched by the instancer `CHALLENGE`
env: `fc-m364-credit` (flag only at `/run/flag.txt`, read through the
RCE) and `fc-m364-recon` (flag only in the unlinked static incident note
`/incidents/EX2611-0442.html`, rewritten at boot via awk `ENVIRON` — no
PHP — with a documented non-flag sentinel at `/run/m364-intake.txt` so
the "RCE finds no flag" negative is a positive, exact-match proof instead
of an ambiguity indistinguishable from a probabilistic stage-3 miss).

### The green gate (run `20261119-193954-179847`)

`P2S_REQUIRE_RCE=1 P2S_HARDENED_LIMIT_PROBE=1 ./run.sh` — **ALL
PHP2SHELL LAB CHECKS PASSED (leaks + calibrated RCE + controls)**, every
chain on attempt 1, with the **unchanged** calibration profile:

```text
PASS: vulnerable image: /flag.txt answers 404 and never serves the flag
PASS: vulnerable image: /www/flag.txt answers 404 and never serves the flag
PASS: vulnerable image: the incident note is the shipped non-flag page
PASS: vulnerable PHP 8.4.26 reproduces the stage-1 stale-id OOM leak and the stage-2 libphp leak
PASS: vulnerable PHP 8.4.26 executes id as uid=33(www-data) gid=33(www-data) groups=33(www-data)
PASS: vulnerable PHP 8.4.26 reveals the objective pointer F=/run/flag.txt through the RCE
PASS: vulnerable PHP 8.4.26 reads the per-run flag from /run/flag.txt through the RCE
PASS: platform-named image: /flag.txt answers 404 and never serves the flag
PASS: platform-named image: the incident note is the shipped non-flag page
PASS: platform-named image reads the per-run flag from /run/flag.txt through the RCE
PASS: recon image (main): /flag.txt answers 404 and never serves the flag
PASS: recon image (main): the incident note carries the per-run flag (recon placement)
PASS: recon image (main): the RCE finds the non-flag intake note at $F, not the flag
PASS: recon image (flags/static): the incident note carries the per-run flag (recon placement)
PASS: recon image (flags/static): the RCE finds the non-flag intake note at $F, not the flag
PASS: patched PHP 8.4.27: both leak primitives are absent
PASS: patched PHP 8.4.27: leak absent (chain verdict) and /p answers 404 from the reachable target
PASS: hardened php.ini: both leak primitives are absent
PASS: hardened php.ini: leak absent (chain verdict) and /p answers 404 from the reachable target
OBSERVED: the hardened image DOES execute at huge_mb=140;
          control B is a configuration control, not a mitigation.
ALL PHP2SHELL LAB CHECKS PASSED (leaks + calibrated RCE + controls)
```

`selftest.sh` after the final rebuild + manifest refresh: **143 passed,
0 failed**. The theme and incident-note assertions passed byte-identical
on every image; `index.php` remains byte-identical
(`e463b149…`, empty `git diff`, same hash inside the rebuilt images via
`debugfs`).

**Re-pin for the deployment tooling (both staged records):** the event
image `php2shell-vuln` was rebuilt with the new `/app/start` and the
incident note, so its `rootfs.ext4` digest changed by design —
`vmlinux` sha256 `e20e46d0…af3d4f2` (44,279,576 B, unchanged) and
**`rootfs.ext4` sha256 `3562042b…338d2e4a` (805,306,368 B)**, recorded in
`staging-manifest.json` (source commit `ba1e7afd`). The previous pin
(`6c63bcd4…`) will fail validation by design.

### What did NOT run (this leg)

- The nginx + PHP-FPM variant: still **not implemented** (unchanged).
- `build.sh` source guest (`P2S_GUEST=source`): not run; the source
  variant's start script carries the same fix but is development-only.
- `bun run lint` / `typecheck` / `test:firecracker`: not re-run; this leg
  again touched only `deploy/firecracker/labs/php2shell/**` (shell,
  HTML/CSS, YAML/JSON), no TypeScript sources.
- The real controller/Traefik event-side deployment: not exercised; the
  lab exercises the same agent API and the same guest bytes, and every
  registration promise (readiness `GET /` 200, both hostPrefix records)
  is field-checked by `selftest.sh`.
- No recalibration: the profile, offsets, and every calibrated request
  shape are byte-identical to `642b4813`; all chains hit attempt 1.
- The frozen guest init was NOT modified (the `chmod 0711 /run`
  traversal fix is entirely service-level); the documented need for an
  init-level publish mount is recorded in README/RESULTS instead.
