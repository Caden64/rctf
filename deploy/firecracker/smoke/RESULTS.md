# Smoke results — 2026-11-08 (pinned artifacts)

Run of `deploy/firecracker/smoke/run.sh` on the reference development host after
`fetch-artifacts.sh` was changed to pin every third-party artifact to an exact version and
an embedded sha256, and to re-hash cached files before use. This is one post-change run; it is
not presented as a repetition of earlier runs.

## Environment

|             |                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Date        | 2026-11-08 (America/Denver, MST)                                                                     |
| Host kernel | `7.2.14-arch1-1`                                                                                     |
| Bun         | `1.4.4` (`/home/caden64/.local/bin/bun`)                                                             |
| Artifacts   | fresh `~/.cache/rctf-fc-smoke-verify/run-GdZ5EK` (89 MiB), built by the changed `fetch-artifacts.sh` |
| Namespace   | `unshare -Urn` (private user + network namespace), no root, no sudo                                  |
| Run dir     | `/run/user/1000/fcs1794169148`                                                                       |
| Result      | **24 passed, 0 failed**, exit code 0                                                                 |

Command (the fresh cache is deliberately under the verification area, not the shared
`~/.cache/rctf-fc-smoke`):

```sh
export PATH=$HOME/.local/bin:$PATH
export SMOKE_ARTIFACTS=$(mktemp -d ~/.cache/rctf-fc-smoke-verify/run-XXXXXX)
deploy/firecracker/smoke/fetch-artifacts.sh
deploy/firecracker/smoke/run.sh
```

## Pinned digests

| Artifact            | Version           | sha256                                                             | Provenance                                            |
| ------------------- | ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| Firecracker tarball | `v1.17.0` x86_64  | `06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558` | official release `.sha256.txt`                        |
| Firecracker binary  | `v1.17.0`         | `99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5` | extracted from the verified tarball, re-hashed        |
| jq                  | `1.8.2`           | `b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f` | official release `sha256sum.txt`                      |
| kernel              | `vmlinux-6.1.155` | `e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2` | **trust-on-first-use** (publisher offers no checksum) |
| busybox             | `1.35.0` static   | `6e123e7f3202a8c1e9b1f94d8941580a25135382b99e8d3e34fb858bba311348` | **trust-on-first-use** (publisher offers no checksum) |

The fresh fetch produced exactly these digests, and a second run over the now-cached files
re-verified all four before rebuilding the rootfs:

```
  cached firecracker v1.17.0 tarball verified
  cached jq jq-1.8.2 verified
  cached kernel vmlinux-6.1.155 verified
  cached busybox 1.35.0 verified
artifacts ready in /home/caden64/.cache/rctf-fc-smoke-verify/run-GdZ5EK
```

Tamper check: a copy of the cache with one byte removed from `dl/busybox` was rejected
before the rootfs build:

```
busybox 1.35.0 (cached) sha256 mismatch: expected 6e123e7f3202a8c1e9b1f94d8941580a25135382b99e8d3e34fb858bba311348, got 052b98de76511a05d5c8b216ad00048f6cb43c4267cbf191527df4ea578b58d2 (busybox)
```

## Checks

All 24 checks from `inner.sh` passed:

```
  PASS: agent up
  PASS: create accepted
  PASS: instance running
  PASS: flag byte-exact in guest
  PASS: flag absent from state dir, traefik dir and agent log
  PASS: flag absent from the guest rootfs disk image
  PASS: anti-spoof rules present
  PASS: VM survived agent crash
  PASS: guest still serving after agent crash
  PASS: agent restarted
  PASS: instance adopted as running
  PASS: tap preserved across restart
  PASS: duplicate create idempotent (200)
  PASS: changed spec -> 409
  PASS: second team's VM running
  PASS: each team's guest holds only its own flag (A='rctf{smoke-canary-flag-7f3a9c}' B='rctf{team-b-secret-91ce}')
  PASS: team A cannot reach team B or the host
  PASS: team B cannot reach team A or the host
  PASS: control: with rules removed the guest CAN reach peer/host (probe is sensitive)
  PASS: firecracker process gone
  PASS: tap removed
  PASS: run dir removed
  PASS: nft rules for the lease removed
  PASS: re-create of a deleted id is fenced (409)
RESULT: 24 passed, 0 failed
```

Boot was `state=running after 2s`; the agent preflight reported `accepting: true` with
`kvm`, `firecrackerBin`, `imagesDir`, `nft`, `ip`, `conntrackBin` and `ipForward` all true.
The team-isolation control flushed `inet rctf_fc` and the same in-guest probe then reported
`peer=REACHED host=REACHED`, so the blocked result is not a dead probe.

## Leftovers / limitations

- The run dir `/run/user/1000/fcs1794169148` is on tmpfs and is kept for inspection; the
  harness itself removes the instance, tap, nft lease rules and run directory it created.
- The fresh verification cache (`~/.cache/rctf-fc-smoke-verify/run-GdZ5EK`) is separate from
  the shared read-only cache used by the e2e/edge runs. It can be deleted after inspection.
- Jailer mode, Traefik/TLS, `egress: true` masquerade and public DNAT from outside the
  namespace remain out of scope (see `README.md`).
- Only the pinned versions above were exercised.
