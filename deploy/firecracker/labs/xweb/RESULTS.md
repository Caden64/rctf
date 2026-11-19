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
  vuln-build default-creds / `OR 1=1` bypass / UNION-archive / UNION-login /
  bad-column behaviour, patched-build denials, flagless-boot behaviour, and
  `bash -n` / `sh -n` / `py_compile` syntax checks of every lab piece.
  Re-run green again after the `inner.sh` fix below (still 75/0).
- Command: `cd deploy/firecracker/labs/xweb && ./build.sh`
- Result: **green**; exit 0 (executed twice this day; the run below rebuilt
  the images again inside `run.sh`). Unpacked the pinned Alpine minirootfs +
  17 verified `.apk` files with `tar` only, called
  `../../guest/build-rootfs.sh --dir` per image, no root, no container
  engine, no chroot, no guest binary executed on the host.
- Build-time assertions observed passing per image: python banner `3.14.10`
  read out of `usr/lib/libpython3.14.so.1.0` bytes, `_sqlite3` module and
  `libsqlite3.so.0` present, musl loader present / no glibc loader, themed
  app + schema + default credentials staged, concatenated-SQL seam asserted
  in `xweb-vuln` and parameterized seam (with no SQL-text concatenation) in
  `xweb-patched`, `/etc/xweb-build` identity asserted back. The built ext4
  images were additionally inspected read-only with `debugfs` on the host:
  `/app/xweb_auth.py` inside `xweb-vuln` shows the concatenated SQL, inside
  `xweb-patched` the `?`-bound queries, and `/etc/xweb-build` names the
  right image/stack/auth in both.
- Pinned-input verification observed: Alpine minirootfs digest matched the
  publisher's `.sha256` file; Firecracker tarball pin matched the
  publisher's release `.sha256.txt`; every cached `.apk` re-hashed clean.
- Development note (fail-closed pinning working as designed): an early
  transcription error in this lab's own `FC_TARBALL_SHA256` pin was caught
  fatally by `fetch-artifacts.sh` (digest mismatch against the cached,
  publisher-verified tarball) before anything was built; the pin was
  corrected against the publisher's `.sha256.txt`.

| Image          | Size | rootfs.ext4 sha256 (build used by the green run below)      |
| -------------- | ---- | ----------------------------------------------------------- |
| `xweb-vuln`    | 256M | `728bed554a79db627aee3af8bb45a0f99f9b86f1d3e604bbced55cfafd751781` |
| `xweb-patched` | 256M | `afeabcd25964f289c83140f1c2e195db3f0a662365c4d26e21394660d36a5d4a` |

Both share `vmlinux` sha256 `e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2`
(the pinned shared smoke kernel 6.1.155). Bytes differ between rebuilds
(mkfs UUID/timestamps), exactly as the sshole lab documents; the build-time
assertions tie every image back to the pinned package digests and the
running guest reports its own build marker, which the runner asserts.

## 2026-11-19 — full nested-KVM end-to-end run (green)

Executed for real with `/dev/kvm`; nothing privileged ran on the host. The
run was sequenced to start in a quiet window (a sibling lab's bitbake build
had been compiling at load 30–100 on this host earlier; this run started at
host load ~1.9).

- Command: `cd deploy/firecracker/labs/xweb && ./run.sh`
- Lab VM: fresh Ubuntu 24.04 cloud image under nested KVM, unique per-run
  `VM_DIR` (`~/.cache/rctf-xweb/vm/run-20261119-162645-2738556`) and random
  host ports (ssh `127.0.0.1:38307`, seed `127.0.0.1:48411`); the vmtest
  default VM was not touched and no process outside this run was signalled.
- Stack: Firecracker `v1.17.0` (jailer mode, uid 10000), agent from
  `apps/firecracker-instancer` under bun, pinned Traefik `3.7.15` publishing
  the `http` exposes from the agent's file-provider dynamic dir, kernel
  `vmlinux-6.1.155` (shared smoke artifacts, pinned digests re-verified).
- Instances: four, created over the real agent HTTP API with per-run flags
  through MMDS only — team A and team B (`xweb-vuln`, each with an `http` +
  a `tcp` expose), the patched control (`xweb-patched`, `http` expose) and
  the flagless negative control (`xweb-vuln`, empty `flags` array, `http`
  expose). Readiness in every case was the agent's own HTTP probe
  (`GET /` on guest port 8080 expecting 200); all four reached `running`.
- Result: **96 passed, 0 failed**; `RESULT: xweb 96 passed, 0 failed`;
  `XWEB RESULT: PASS`; `run.sh` exited 0; the VM was destroyed and its
  overlay removed. Transcript:
  `~/.cache/rctf-xweb/logs/run-20261119-162645-2738556.log`.

Checks observed over the published endpoints from the `xwoutside` network
namespace (classified fail-closed throughout; no check was ever satisfied by
a transport failure):

| Check                                                     | vuln A | vuln B | patched | flagless |
| -------------------------------------------------------- | ------ | ------ | ------- | ------- |
| published http endpoint serves the themed login page      | PASS   | PASS   | PASS    | PASS    |
| published tcp (DNAT) endpoint serves the portal           | PASS   | PASS   | n/a     | n/a     |
| running guest reports the pinned build + own node id      | PASS   | PASS   | PASS    | PASS    |
| `admin`/`1234` authenticates (documented default)         | PASS   | PASS   | PASS    | PASS    |
| admin "Service notes" displays the per-run MMDS flag      | PASS   | PASS   | PASS    | none    |
| wrong code is denied (genuine negative)                    | PASS   | PASS   | n/a     | n/a     |
| `admin' OR 1=1--` bypass authenticates without creds       | **PASS** | **PASS** | denied | n/a   |
| bypass session reaches the admin area + flag              | PASS   | PASS   | n/a     | n/a     |
| UNION archive dump renders the service notes + flag       | **PASS** | **PASS** | empty state | rows, no flag |
| UNION login dumps the flag into the operator line         | **PASS** | **PASS** | denied | n/a   |
| wrong-column UNION surfaces a genuine SQL fault          | PASS   | PASS   | plain data | n/a |
| flagless build contains no flag-shaped string anywhere   | n/a    | n/a    | n/a     | **PASS** |

Isolation (team A vs team B, both `xweb-vuln`):

- distinct published hostnames (`xweb-xwebvulnabeea99e225.xweb.test` vs
  `xweb-xwebvulnb3ab59b5b63.xweb.test`) and distinct public tcp ports
  (30060 vs 30061), each derived from its own instance id;
- each endpoint reports its own `RCTF_INSTANCE_ID` node marker and never
  the other's;
- a UNION dump through team A's endpoint yields team A's flag and never
  team B's, and vice versa; neither login page leaks the other team's flag.

The agent wrote the per-instance Traefik route files (verified for team A,
including the `Host()` rule), and the per-instance state never left the
agent/VM boundary.

### Honest record of the failed first attempt (2026-11-19 16:24)

The first `./run.sh` (transcript `run-20261119-162406-2736276.log`) failed
closed **6 passed, 10 failed**: every instance create was rejected with
`invalid_request: invalid instance spec` because this lab's `inner.sh`
built `teamKey` values containing an uppercase tag (`teamA…`), while the
agent schema requires `^[a-z0-9]{8,64}$`. The infrastructure checks (VM
boot, provisioning, Traefik up, agent preflight accepting, both images
registered) passed in that same run. The one-character-per-tag fix
(`team${tag,,}…`) was audited against every field of
`packages/firecracker/src/agent-protocol.ts` (id, image, vcpus/mem/disk
bounds, readiness union, expose entries, env keys, flags) before the
re-run; no other field was non-conforming, and the re-run above is green.
