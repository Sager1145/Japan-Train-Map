#!/usr/bin/env python3
"""Prepare compact Macao LRT route centre-lines from DSCC's Online Map.

Geometry is taken directly from DSCC's Online Map LRT route response. The
input uses EPSG:8433 and requires ``pyproj`` for conversion to WGS84.

Usage:
  python3 scripts/build-macao-track-alignments.py \
    --taipa /tmp/mo-dscc-taipa.json \
    --seac-pai-van /tmp/mo-dscc-spv.json \
    --hengqin /tmp/mo-dscc-hengqin.json \
    --output scripts/data/mo-track-alignments.json
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def metres(a, b):
    latitude = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * 111_320 * math.cos(latitude), (a[1] - b[1]) * 111_320)


def point_segment_metres(point, start, end):
    latitude = math.radians(point[1])
    scale_x = 111_320 * math.cos(latitude)
    ax, ay = (start[0] - point[0]) * scale_x, (start[1] - point[1]) * 111_320
    bx, by = (end[0] - point[0]) * scale_x, (end[1] - point[1]) * 111_320
    dx, dy = bx - ax, by - ay
    if dx == dy == 0:
        return math.hypot(ax, ay)
    ratio = max(0, min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
    return math.hypot(ax + ratio * dx, ay + ratio * dy)


def simplify(points, tolerance=5):
    if len(points) <= 2:
        return points
    start, end = points[0], points[-1]
    index, maximum = 0, 0
    for candidate in range(1, len(points) - 1):
        distance = point_segment_metres(points[candidate], start, end)
        if distance > maximum:
            index, maximum = candidate, distance
    if maximum <= tolerance:
        return [start, end]
    return simplify(points[: index + 1], tolerance)[:-1] + simplify(points[index:], tolerance)


def turn_degrees(a, b, c):
    v1 = (b[0] - a[0], b[1] - a[1])
    v2 = (c[0] - b[0], c[1] - b[1])
    l1 = math.hypot(*v1)
    l2 = math.hypot(*v2)
    if l1 == 0 or l2 == 0:
        return 0.0
    cosine = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)
    return math.degrees(math.acos(max(-1.0, min(1.0, cosine))))


def despike(points):
    """Drop micro-spike and reversal vertices until stable (display grooming)."""
    changed = True
    while changed and len(points) > 2:
        changed = False
        result = [points[0]]
        index = 1
        while index < len(points) - 1:
            a, b, c = result[-1], points[index], points[index + 1]
            turn = turn_degrees(a, b, c)
            short = metres(a, b) < 30 or metres(b, c) < 30
            if turn > 150 or (turn > 55 and short):
                changed = True
                index += 1
                continue
            result.append(b)
            index += 1
        result.append(points[-1])
        points = result
    return points


def chaikin(points, iterations=2):
    for _ in range(iterations):
        if len(points) < 3:
            return points
        result = [points[0]]
        for a, b in zip(points, points[1:]):
            result.append([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25])
            result.append([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
        result.append(points[-1])
        points = result
    return points


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
