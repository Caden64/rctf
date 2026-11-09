#!/usr/bin/env python3
"""amd64 pointer-range patch for the pinned upstream exploit.

The toolkit relaxes the upstream exploit's pointer filters from the amd64
range (0x7f...) to 0x10000..2^48 so the same code can carry aarch64 profiles.
On an amd64-only lab that widening is unsafe: the leaked 4096-byte window
contains ordinary integers, and a repeated low value (for example 0x600000)
can win `Counter.most_common()` for the stage-1 chunk base and poison every
address derived from it. Measured on the pinned trixie image: a leak that is
byte-for-byte valid parsed as chunk=0x600000 under the wide filter.

This patch narrows both filters back to canonical amd64 userspace addresses.
It is applied AFTER the toolkit's own patch (which it must not replace: that
patch also injects the heap-parameter environment knobs and the cookie '+'
decoding). It is a lab-local change and does not modify the pinned toolkits on
disk permanently -- callers stage a private copy of exploit.py.
"""

from __future__ import annotations

import os


def patch_amd64_filters(repo: str) -> bool:
    path = os.path.join(repo, "exploit.py")
    try:
        with open(path, encoding="utf-8") as fh:
            source = fh.read()
    except OSError:
        return False
    # Keep the semantics of each filter; only narrow the range. The same text
    # appears once in chunk_base_from_cookie and once in
    # libphp_base_from_cookie (guarded by an "if not" there).
    wide_chunk = "if 0x10000 < v < 0x0001000000000000:"
    narrow_chunk = "if 0x400000000000 <= v < 0x800000000000:"
    wide_lib = "if not (0x10000 < p < 0x0001000000000000):"
    narrow_lib = "if not (0x400000000000 <= p < 0x800000000000):"
    changed = False
    if wide_chunk in source:
        source = source.replace(wide_chunk, narrow_chunk, 1)
        changed = True
    if wide_lib in source:
        source = source.replace(wide_lib, narrow_lib, 1)
        changed = True
    if not changed:
        return False
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(source)
    return True
