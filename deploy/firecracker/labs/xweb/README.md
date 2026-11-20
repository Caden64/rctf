# xweb — XWEB-500 portal: default credentials + unauthenticated SQLi lab

A defensive CTF training lab themed as the **XWEB-500 refrigeration-controller
web portal** (the event's beginner "dummy" web challenge). Public security
advisories for that controller family describe two findings in its web
interface: documented factory default credentials (`admin` / `1234`) and an
unauthenticated SQL-injection surface. This lab reproduces that *class* of
bug as a self-contained training fixture: a beginner-friendly portal with
**two independent win paths**, both asserted by the runner against real
published endpoints of real Firecracker instances.

Everything in the portal (HTML/CSS, copy, schema, code) is original work
written for this lab. No vendor firmware, images, or text were copied; the
advisories are cited only as design inspiration.

## What is proven

The runner boots its own throwaway vmtest VM, starts the real Firecracker
agent (jailer mode) and the real pinned Traefik that publishes the instances'
`http` exposes, creates four instances over the real agent HTTP API with real
exposes and per-run flags delivered through MMDS, and then asserts from an
outside network namespace — against the published endpoints, never a
hand-started process:

1. **Default credentials** (`xweb-vuln` and `xweb-patched`): the documented
   `admin` / `1234` pair authenticates, and the admin "System / Service
   notes" page displays the per-run MMDS flag (exact-match assert, so a
   stale or hardcoded flag cannot pass).
2. **SQL injection without credentials** (`xweb-vuln` only):
   - authentication bypass — `admin' OR 1=1--` logs in and reaches the admin
     area, which displays the same per-run flag;
   - UNION-based dump — the public diagnostics archive filter
     (`/archive?probe=`) is injectable; a UNION payload dumps the
     `service_notes` flag row into the visible table;
   - UNION through the login form — the matched row's second column becomes
     the session identity, so the dashboard greets the attacker with the
     dumped flag body;
   - a wrong-column UNION surfaces a genuine SQL fault page (proving the
     injected SQL executes), never a pass.
3. **The patched control** (`xweb-patched`): identical theme and content,
   but every query binds request values as SQL parameters. All injection
   payloads fail closed as genuine negatives (themed access-denied /
   empty-archive pages — classified, not transport failures), while
   `admin`/`1234` still works and still displays the same per-run flag.
4. **Flagless negative control** (the `xweb-vuln` image booted with an empty
   `flags` array): the portal boots and serves normally, the UNION dump
   still renders the seeded service notes, but no flag-shaped string exists
   anywhere — proving the dump can only expose what the database really
   contains and the display never fabricates a flag.
5. **Staged-record placement**: a recon-named instance (env
   `CHALLENGE=fc-xweb-recon`) exposes its exact per-run flag ONLY through the
   hidden, unlinked maintenance page that enumeration (robots.txt →
   `/internal/`) finds — the default-credentials page, the `OR 1=1` bypass
   and the UNION dump must NOT yield it while still classifying as genuine
   portal outcomes; a main-named instance exposes its flag ONLY through the
   creds/SQLi paths, and its hidden page must NOT yield it. Both records are
   covered under both flag delivery names.
6. **Instance isolation**: two instances of the vulnerable image (two teams)
   get distinct published hostnames and distinct public TCP ports; each
   endpoint reports its own `RCTF_INSTANCE_ID` node marker, neither endpoint
   reports the other's node, and a UNION dump through team A's endpoint
   yields team A's flag and never team B's (and vice versa).
7. **Readiness**: every instance must reach `running`, which requires the
   agent's own HTTP readiness probe (`GET /` on guest port 8080 expecting
   200) to pass; an instance that never answers fails the run.
8. **Fail-closed classification**: every probe outcome is classified
   (`check-http.sh`); a connection refusal, timeout, or unclassifiable
   response is INCONCLUSIVE and is always a failure. Control images prove
   the positive path, so a denial cannot be vacuous.

The documented one-line summary is: **on the recon record the flag lives
only on the hidden maintenance page that robots.txt leads to; on the main
record it lives only in the DB service-note row, reachable by
`admin`/`1234` and by SQL injection (`' OR 1=1--` bypass or a UNION dump);
`xweb-patched` denies every injection payload on both records.**

## The two win paths for players

| Path | Record | Steps |
| ---- | ------ | ----- |
| Enumeration (recon stage) | `fc-xweb-recon` | fetch `robots.txt` → notice `Disallow: /internal/` → open `/internal/maintenance.html` → the maintenance note carries the flag |
| Default credentials | `fc-xweb` | log in as `admin` / `1234` (documented on the commissioning-sheet hint line) → "Service notes" page shows the flag |
| SQL injection | `fc-xweb` | the public "Diagnostics archive" filter is injectable → `x' UNION SELECT created, title, body FROM service_notes--` renders the flag row; or bypass the login with `admin' OR 1=1--` and read the same admin page |

## Images

| Image          | Base                                  | Stack                                                | Query seam                        | Expected injection result |
| -------------- | ------------------------------------- | --------------------------------------------------- | --------------------------------- | ------------------------ |
| `xweb-vuln`    | Alpine minirootfs 3.24.4 (`v3.24`)    | `python3-3.14.10-r1` (stdlib http.server + sqlite3) | string concatenation (the bug)    | **bypass + UNION work**  |
| `xweb-patched` | Alpine minirootfs 3.24.4 (`v3.24`)    | same                                                 | parameterized queries only        | genuine denials          |

Both images share the pinned kernel `vmlinux-6.1.155` from `../smoke`. The
flagless negative control is not a third image: it is `xweb-vuln` booted
with an empty `flags` array (valid per the guest contract).

### Flag delivery names (lab vs platform)

The portal resolves the MMDS-written flag file by **delivery name**, and
accepts both names it can receive:

| Source                     | registered flag provider | guest file (`/rctf/init` sanitises `[^A-Za-z0-9._-]` → `_`) |
| -------------------------- | ------------------------ | ----------------------------------------------------------- |
| this lab's runner          | `main`                   | `$RCTF_FLAGS_DIR/main`                                       |
| the platform (rCTF event)  | `flags/static`           | `$RCTF_FLAGS_DIR/flags_static`                              |

Resolution order at boot: `main` first, then `flags_static`, then the single
file in the flags directory when exactly one exists (a safety net for other
provider names). An empty directory boots the portal flagless (the negative
control), and two or more unrecognised files are treated as ambiguous and
also boot flagless — never a wrong flag. Both images carry the identical
shared module, so vuln and patched stay byte-identical in everything except
the query seam. The runner asserts the platform path for real: `inner.sh`
creates one instance whose flags use `provider: "flags/static"` and asserts
the exact per-run flag through both win paths (default-credentials admin
page and the unauthenticated UNION dump).

The portal is a small, auditable program (three lab-authored Python files):
`app/xweb_common.py` (HTTP service, theme, sessions, DB bootstrap, flag
resolution) and `app/xweb_auth_vuln.py` / `app/xweb_auth_patched.py` (the
query seam; build time stages exactly one of them as `/app/xweb_auth.py`).
The database lives on tmpfs (`/run/xweb/portal.db`); the flag is read once
at boot from the MMDS-written tmpfs directory and inserted as a themed
service-note row. No flag ever reaches the ext4 rootfs.

### Pinned inputs and digests

`fetch-artifacts.sh` downloads over HTTPS and sha256-verifies every input;
cached files are re-hashed before every use and a mismatch is fatal:

- Alpine minirootfs 3.24.4 — `cdaa38cb…923012`, additionally cross-checked
  against the publisher's `.sha256` file when reachable.
- Alpine `.apk` closure for `python3-3.14.10-r1` (17 packages, see the
  script for the full list with digests). **Trust-on-first-use:** Alpine
  publishes checksums for release images, not for individual repository
  packages, so these digests were computed from the fetched bytes and pinned
  here; the exact versions were read from the `v3.24` APKINDEX at pin time.
  A changed digest is fatal; re-pin deliberately. (Alpine also rebuilds
  packages in place at the same version — the same caveat the sshole lab
  documents.)
- Shared smoke artifacts reused with their digests re-verified: Firecracker
  `v1.17.0` tarball `06094a11…ade558` (also cross-checked against the
  publisher's release `.sha256.txt` when reachable), firecracker binary
  `99ad0f5c…de7a5`, kernel 6.1.155 `e20e46d0…af3d4f2`, static jq
  `b1c22172…5870f`, busybox 1.35.0 `6e123e7f…11348`.
- Traefik `3.7.15` (tarball `5b9f5119…a81f8e6`, binary
  `34bfdfa8…948e30`) — used **only inside the throwaway vmtest VM** as the
  publishing proxy for the `http` exposes, exactly the production path. The
  tarball pin is the publisher's checksums-file line, cross-checked at pin
  time against the GitHub release-asset digest (the same basis as the edge
  harness pin); the binary digest was computed from the verified tarball.

## Requirements

Host (unprivileged):

- `/dev/kvm` readable/writable and nested virtualization enabled,
- `qemu-system-x86_64`, `qemu-img`, `ssh`, `curl`, `python3` (>= 3.9),
  `tar`, `strings`, `flock`, `mkfs.ext4` (e2fsprogs >= 1.47),
- roughly 3 GiB RAM and ~15 GiB disk for the lab VM (images live in
  `${XDG_CACHE_HOME:-~/.cache}/rctf-xweb`),
- network access on first run for the pinned downloads (and for the shared
  smoke / vmtest base images if they are not already cached).

Everything privileged (nftables, taps, jailer, Traefik, KVM) runs inside the
throwaway QEMU VM started by `../vmtest/vm.sh`. Nothing runs privileged on
the host and no guest binary is ever executed on the host: `build.sh` only
unpacks archives and calls `../../guest/build-rootfs.sh --dir`; the only
lab-authored code executed on the host is `selftest.sh`, which runs the
portal **source** (written in this repo, never unpacked from a guest
artifact) with the host's own python3.

## How to run

```sh
cd deploy/firecracker/labs/xweb
./selftest.sh        # unprivileged: classifier + portal-source payload checks
./build.sh           # unprivileged image build, build-time assertions
./run.sh             # fresh unique VM + real agent + real Firecracker + checks
KEEP_VM=1 ./run.sh    # keep the VM for debugging
ONLY_INNER=1 ./run.sh # reuse existing images (still boots a fresh VM)
```

`run.sh` uses its own per-run `VM_DIR` and random host ports; it never uses
the vmtest defaults and never signals processes it does not own, so
concurrent vmtest or lab runs do not interfere. The transcript is written
below the lab cache and, unless the VM must be kept, the per-run VM directory
is removed after teardown.

## Staged records and flag placement

The event design is **two staged rCTF records sharing one image**
(`xweb-vuln`). Each record spawns its own instance, and each instance
carries only its own flag (that is the platform model), so the app decides
where the one delivered flag lives from the per-record environment:
the instancer env exports `CHALLENGE` with the record name.

| Record             | env `CHALLENGE`    | Flag location                                  | Player route |
| ------------------ | ----------------- | ---------------------------------------------- | ------------ |
| `fc-xweb-recon`    | `fc-xweb-recon`   | **only** the hidden, unlinked maintenance page | enumerate: `robots.txt` disallows `/internal/` → `/internal/maintenance.html` |
| `fc-xweb` (main)   | `fc-xweb` (default) | **only** the DB service-note row             | default credentials and/or SQL injection |

The hidden page is pure static theme content (a plant maintenance schedule,
original text) referenced from nowhere in the portal; `robots.txt` is its
only discovery hint. On the recon record the DB service-note row carries a
non-flag placeholder (themed, never flag-shaped), so the admin page, the
`OR 1=1` bypass and the UNION dump all still classify as genuine portal
outcomes while never yielding the flag. On the main record the hidden page
carries an equivalent non-flag note. Both records' instances are otherwise
identical, and the `xweb-patched` control applies the placement switch
identically (same shared app module).

The runner asserts the full placement matrix fail-closed: recon-named
instances must expose the exact per-run flag ONLY via the hidden page
(default-creds page, bypass and UNION dump must not yield it), and
main-named instances must expose it ONLY via the creds/SQLi paths (the
hidden page must not yield it). Both records are additionally covered under
the platform's `flags/static` delivery name (see below).

Event registration: `challenge.yaml` (record `fc-xweb`) and
`challenge-recon.yaml` (record `fc-xweb-recon`) — same image, one `https`
expose each, their own platform flags.

## Safety boundary and honesty

- The only credentials in the images are the documented throwaway defaults
  (`admin`/`1234`, plus a `storeops` operator account with a lab password);
  no real secret is committed, and flags are generated per run and delivered
  only through MMDS.
- The images are verification fixtures, not production services; they must
  not be exposed outside the throwaway VM.
- `RESULTS.md` records what actually ran and when; anything not executed is
  marked `NOT RUN`.

## What this lab is not

- It is not a copy of vendor firmware: the advisory findings inspired the
  theme and the bug class; all assets, text and code here are original.
- It does not claim to reproduce any specific CVE payload or version; the
  parameterized-query control is the lab's reference fix, not a vendor
  patch.
- The patched build still accepts the documented default credentials (that
  is a separate advisory addressed by credential rotation); the lab proves
  the *injection* fix, and the runner asserts the default-credentials path
  on both images so the control is never vacuous.
- LIKE wildcards inside a bound filter value (`%`, `_`) are filter semantics,
  not SQL injection, and are out of scope for the parameterized control.
