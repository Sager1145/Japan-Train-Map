#!/usr/bin/env python3
"""Dump every N02 station (platform) feature per line and group.

The multi-line audit runs in Node and can measure a drawn dot against OSM, but
it cannot answer the question that decides HOW a finding is fixed:

  does N02 offer another platform feature for this line at this station?

  yes -> the dot is on the wrong ONE of several features, and the fix is a
         `platform_assignments` row in the evidence file: cheap, reversible,
         and it never overrides official data.
  no  -> N02 puts this station where it puts it, and the disagreement is
         between N02 and OSM. Fixing it means a registered geometry patch
         (the 東京 precedent), which overrides official survey with a measured
         one and therefore needs a per-station justification, not a batch.

Telling those apart by hand costs an N02 parse per station, so this dumps them
once. Output is small (one midpoint + vertex count per feature).

Usage:
  python3 app/scripts/railway/n02/dump-station-platform-features.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[3]
OUT = (
    APP_DIR
    / "data/raw/railway/jp/rebuild-inventory/stations/n02-platform-features.json"
)


def load_module(path: Path, name: str):
    # sys.modules first: n02_source uses @dataclass, and a dataclass cannot
    # resolve its own annotations while its module is unregistered.
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def midpoint(coords):
    return [
        round(sum(point[0] for point in coords) / len(coords), 7),
        round(sum(point[1] for point in coords) / len(coords), 7),
    ]


def main() -> None:
    builder = load_module(
        APP_DIR / "scripts/railway/build-japan-package-from-inventory.py", "bji"
    )
    n02 = load_module(APP_DIR / "scripts/railway/n02/n02_source.py", "n02_source")
    root = builder.extract_n02(Path(tempfile.mkdtemp()))
    net = n02.load(root, verbose=False)

    features: dict[str, list] = {}
    for row in net.stations:
        line, operator = row.line_key
        key = f"{operator}␟{line}␟{row.group}"
        features.setdefault(key, []).append(
            {
                "station_name": row.name,
                "midpoint": midpoint(row.coords),
                "vertices": len(row.coords),
            }
        )
    for rows in features.values():
        rows.sort(key=lambda entry: (entry["midpoint"][0], entry["midpoint"][1]))

    payload = {
        "schema_version": 1,
        "source": "N02-25 (国土数値情報 鉄道データ), Shift-JIS layer",
        "key": "operator␟line␟station_group",
        "purpose": (
            "How many platform features N02 offers per line and station group. "
            "Consumed by scripts/validation/audit-japan-multiline-stations.mjs to "
            "separate a wrong PICK (fixable with a platform_assignments row) from "
            "an N02-vs-OSM source disagreement (needs a registered geometry patch)."
        ),
        "groups": len(features),
        "features": features,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", "utf-8")
    multi = sum(1 for rows in features.values() if len(rows) > 1)
    print(
        f"n02 platform features: {len(features)} (line, group) keys, "
        f"{multi} with more than one feature -> {OUT.relative_to(APP_DIR)}"
    )


if __name__ == "__main__":
    main()
