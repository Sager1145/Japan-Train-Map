#!/usr/bin/env python3
"""Prepare compact Macao LRT route centre-lines from DSCC's Online Map.

Geometry is taken directly from DSCC's Online Map LRT route response. The
input uses EPSG:8433 and requires ``pyproj`` for conversion to WGS84.

Usage:
  python3 scripts/railway/build-macao-track-alignments.py \
    --taipa /tmp/mo-dscc-taipa.json \
    --seac-pai-van /tmp/mo-dscc-spv.json \
    --hengqin /tmp/mo-dscc-hengqin.json \
    --output scripts/railway/data/mo-track-alignments.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from lib.geometry import (
    chaikin,
    despike,
    metres,
    point_segment_metres,
    simplify,
    turn_degrees,
)


def refine(points):
    """Despike → Chaikin corner rounding → small-tolerance simplify."""
    points = despike(points)
    points = chaikin(points)
    points = simplify(points, 1.5)
    return [[round(p[0], 7), round(p[1], 7)] for p in points]


def build_macao(paths):
    try:
        from pyproj import Transformer
    except ImportError as error:
        raise RuntimeError("Macao conversion requires pyproj") from error
    transform = Transformer.from_crs("EPSG:8433", "EPSG:4326", always_xy=True)
    routes, stations = {}, {}
    for line_id, path in paths.items():
        response = json.loads(path.read_text())
        segment = response["alternatives"][0]["segments"][0]
        solid = next(line for line in segment["lines"] if line.get("style") == "solid")
        converted = [list(transform.transform(x, y)) for x, y in solid["points"]]
        routes[line_id] = refine(simplify(converted, 2))
        for marker in segment["markers"]:
            title = marker.get("title", {})
            if marker.get("type") in {"lrtGetOn", "lrtGetOff", "lrtStation"} and title.get("en"):
                stations[title["en"]] = list(transform.transform(marker["x"], marker["y"]))
    return routes, stations


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--taipa", type=Path, required=True)
    parser.add_argument("--seac-pai-van", type=Path, required=True)
    parser.add_argument("--hengqin", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    routes, stations = build_macao({
        "MLM-TAIPA": args.taipa,
        "MLM-SPV": args.seac_pai_van,
        "MLM-HENGQIN": args.hengqin,
    })
    output = {"version": 2, "routes": routes, "stationAnchors": stations}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
