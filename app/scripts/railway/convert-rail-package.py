#!/usr/bin/env python3
"""Convert public/rail/jp-2025.json between legacy flat and compact-v1 formats.

Usage:
  python3 scripts/railway/convert-rail-package.py [path]            # -> compact-v1 (default path: public/rail/jp-2025.json)
  python3 scripts/railway/convert-rail-package.py --expand [path]   # compact-v1 -> legacy flat (debugging)

Before overwriting, the round trip expand(compress(pkg)) is verified to be
semantically identical to the input; on any mismatch nothing is written.
A one-time copy of the original legacy file is kept at <path>.legacy.bak.
The .gz sidecar served by server.js is refreshed on every write.
"""

import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import railpkg

APP = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT = os.path.join(APP, "public/rail/jp-2025.json")


def norm(o):
    return json.dumps(o, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def main():
    args = [a for a in sys.argv[1:] if a != "--expand"]
    to_legacy = "--expand" in sys.argv
    path = args[0] if args else DEFAULT

    with open(path) as f:
        data = json.load(f)
    is_compact = data.get("format") == railpkg.FORMAT

    if to_legacy:
        if not is_compact:
            sys.exit("already legacy format, nothing to do")
        pkg = railpkg.expand(data)
        assert norm(railpkg.compress(pkg)) == norm(data), "round-trip mismatch"
        with open(path, "w") as f:
            json.dump(pkg, f, ensure_ascii=False, separators=(",", ":"))
        print("expanded -> legacy: %s (%.2f MB)" % (path, os.path.getsize(path) / 1e6))
        return

    if is_compact:
        sys.exit("already compact-v1, nothing to do")
    before = os.path.getsize(path)
    compact = railpkg.compress(data)
    assert norm(railpkg.expand(compact)) == norm(data), "round-trip mismatch, aborting"
    bak = path + ".legacy.bak"
    if not os.path.exists(bak):
        shutil.copyfile(path, bak)
    railpkg.save(path, compact)
    after = os.path.getsize(path)
    print("compacted %s: %.2f MB -> %.2f MB (-%d%%); legacy copy at %s"
          % (path, before / 1e6, after / 1e6, round(100 - after / before * 100), bak))


if __name__ == "__main__":
    main()
