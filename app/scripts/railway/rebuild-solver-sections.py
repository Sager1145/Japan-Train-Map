#!/usr/bin/env python3
"""Regenerate a country's solver SECTIONS from its published display package.

Sections are the solver's routable edges and they are derived: one feature per
station interval of the drawn package. When a session rebuilds a line, sections
built from the previous package become geometry the solver routes over but the
map no longer draws — which is what "Taiwan section geometry matches the drawn
rail package" fails on.

This regenerates ONLY the sections file, and only from things it can read
rather than invent:

  * geometry, line name and operator come from public/rail/<cc>-2025.json;
  * `railway_class_code` / `institution_type_code` are carried per
    (line, operator) from the existing stations dataset, which the official
    builder wrote. A line with no existing classification is reported and left
    out rather than being given a guessed code.

It deliberately does NOT touch stations-<cc>.json or station-readings-<cc>.json.
Those carry PERSISTED STATION CODES — Taiwan's are TDX StationUIDs, and train
stores reference them — and the rebuild inventory does not publish the mapping
needed to reproduce them. Regenerating them from a guessed code prefix rewrote
every code and broke six passing tests; that path is closed until the real
mapping is available.

Usage:
  python3 app/scripts/railway/rebuild-solver-sections.py --country tw
  python3 app/scripts/railway/rebuild-solver-sections.py --country tw --report
"""

from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = APP_DIR / "data"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--country", required=True)
    parser.add_argument("--report", action="store_true", help="print, do not write")
    args = parser.parse_args()

    package_path = APP_DIR / "public" / "rail" / f"{args.country}-2025.json"
    stations_path = DATA_DIR / f"stations-{args.country}.json"
    sections_path = DATA_DIR / f"rail-sections-{args.country}.json"
    for path in (package_path, stations_path):
        if not path.exists():
            raise SystemExit(f"missing {path}")

    package = json.loads(package_path.read_text("utf-8"))
    classification: dict[tuple[str, str], tuple[str, str]] = {}
    for feature in json.loads(stations_path.read_text("utf-8"))["features"]:
        properties = feature["properties"]
        classification.setdefault(
            (properties["line_name"], properties["operator"]),
            (properties["railway_class_code"], properties["institution_type_code"]),
        )

    features = []
    unclassified = collections.Counter()
    for line in package["lines"]:
        key = (line["name"], line["operator"])
        codes = classification.get(key)
        if not codes:
            unclassified[key] += len(line["segments"])
            continue
        for segment in line["segments"]:
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "railway_class_code": codes[0],
                        "institution_type_code": codes[1],
                        "line_name": line["name"],
                        "operator": line["operator"],
                    },
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[point[0], point[1]] for point in segment[2]],
                    },
                }
            )

    previous = 0
    if sections_path.exists():
        previous = len(json.loads(sections_path.read_text("utf-8"))["features"])
    print(
        f"{args.country}: {previous} -> {len(features)} sections "
        f"from {len(package['lines'])} drawn lines"
    )
    for key, count in unclassified.items():
        print(
            f"  UNCLASSIFIED {key[0]} / {key[1]}: {count} interval(s) left out — "
            "no railway_class_code in the stations dataset, and one is not invented here"
        )
    if args.report:
        return
    sections_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False)
        + "\n",
        encoding="utf-8",
    )
    print(f"  wrote {sections_path.relative_to(APP_DIR)}")


if __name__ == "__main__":
    main()
