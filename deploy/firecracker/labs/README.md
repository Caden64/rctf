# Firecracker vulnerability labs

Reproducible, disposable CTF training labs built and exercised through the real
Firecracker instancer. A lab is a set of guest images that demonstrate a
publicly disclosed vulnerability, plus a runner that boots those images as real
microVMs inside the throwaway `../vmtest/` VM and asserts the vulnerable and
fixed behaviour from inside that VM.

Nothing here contacts third-party infrastructure. Artifacts are downloaded at
build time from the publishers listed below, pinned by exact version and
sha256, and every guest image is disposable: the labs only ever run inside a
nested-KVM QEMU VM owned by the developer, in throwaway Firecracker guests.

## Contract

A lab under `labs/<name>/` MUST provide:

| File                 | Contract                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`          | What is proven, exact pinned versions/digests, requirements, how to run, and the safety boundary.                                |
| `RESULTS.md`         | Dated record of what actually ran on which machine and the exact outcomes. Anything not executed is marked `NOT RUN`.            |
| `build.sh`           | Builds every guest image into `$LAB_IMAGES/<image>/rootfs.ext4` with `../../guest/build-rootfs.sh --dir`, unprivileged.          |
| `fetch-artifacts.sh` | Downloads the pinned inputs into a cache. Every fetch is HTTPS and sha256-verified; trust-on-first-use is called out explicitly. |
| `run.sh`             | Boots its own VM through `../vmtest/vm.sh`, stages the images, creates real instances over the agent API, and fails closed.      |

Rules:

1. **No root, no containers.** `build.sh` must assemble a staging directory from
   unpacked artifacts (`tar`, `ar`, `zstd`) and call
   `../../guest/build-rootfs.sh --dir`. It must never run a guest binary on the
   host, loop-mount, chroot or invoke `docker`/`podman`.
2. **Pinned inputs only.** Every download has an exact filename/version and a
   sha256 in `fetch-artifacts.sh`. Cached files are re-hashed before every use
   and a mismatch is fatal. Where the publisher provides a checksum or a signed
   index, verify against it as well. Where it does not (for example individual
   Alpine `.apk` files), the digest was computed from the fetched bytes and is
   pinned as trust-on-first-use; the lab README must say so.
3. **Build-time assertions.** `build.sh` fails the build unless the staged tree
   really contains the pinned build: the `sshd` version banner is read out of
   the binary bytes (`strings | grep`), required users/configs are present, and
   the expected PAM/glibc flavour is confirmed. A build that only downloaded
   the right files but shipped something else must not pass.
4. **One VM per run.** `run.sh` uses `../vmtest/vm.sh` unchanged, but always
   with its own `VM_DIR`, `VM_SSH_PORT` and `VM_SEED_PORT`. It must never use
   the `vmtest` defaults and never signal a process it does not own, so
   concurrent lab/vmtest runs cannot stop each other.
5. **Real stack.** Images are registered by being placed under the agent's
   `imagesDir`, instances are created through the agent HTTP API with a real
   `expose`, and readiness is the agent's own readiness probe. Checks run from
   inside the vmtest VM against the published endpoint, not against a
   hand-started process.
6. **Fail closed.** Every check distinguishes a genuine negative (for example
   an SSH authentication rejection) from an inconclusive one (connection
   refused, timeout, protocol error). An inconclusive result is a failure, never
   a pass. Control images prove that the positive path still works, so a
   rejection cannot be vacuous. Scripts print `PASS`/`FAIL` lines and a final
   `RESULT:` line and exit non-zero when anything failed.
7. **No secrets.** Lab credentials in guest images are disposable and
   documented. No real flag, token or host key is committed. Flags are
   generated per run and delivered only through MMDS, exactly as the guest
   contract requires.

## Layout

```text
labs/
  README.md          # this contract
  lib/common.sh      # shared download/staging helpers (integral, no third-party code)
  sshole/
    README.md
    RESULTS.md
    fetch-artifacts.sh
    build.sh
    check-client.sh  # stock-ssh two-prompt client + fail-closed classifier
    selftest.sh      # unprivileged classifier/staging selftest
    inner.sh         # runs as root inside the vmtest VM
    run.sh           # unprivileged host driver
```

## Running a lab

```sh
cd deploy/firecracker/labs/<name>
./build.sh            # unprivileged image build, sha256-verified inputs
./run.sh              # nested-KVM VM, real agent, real Firecracker, checks
KEEP_VM=1 ./run.sh    # keep the vmtest VM for debugging
```

`run.sh` prints a summary and writes its transcript below the lab cache. The
`RESULTS.md` in each lab records the last real run.

Labs are verification fixtures, not production images: they are built from
distro packages, use documented throwaway passwords, and must not be exposed
outside the throwaway VM.
