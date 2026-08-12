#!/usr/bin/env python3
"""Give Japan's loop lines their loops back.

`rebuild-japan-package-geometry.py` cuts every station interval by running
Dijkstra over a graph whose nodes are the N02 section vertices, keyed on the
coordinate. On four Japanese railways that key is a lie.

A ループ線 climbs by spiralling: the track leaves a point, circles for one to
three kilometres, and crosses BACK OVER ITSELF at that same point before
carrying on. N02 draws each of them as a single RailroadSection whose polyline
therefore visits one coordinate twice — and keyed on the coordinate, those two
passes are one graph node with a zero-cost edge between them. Dijkstra takes
it every time, so the drawn railway leaves the loop out and climbs its 50 m
in a straight line:

    ゆりかもめ  芝浦ふ頭 → お台場海浜公園   3.20 km drawn, 0.87 km of loop missing
    上越線      湯檜曽 → 土合             4.72 km drawn, 2.96 km of loop missing
    上越線      土樽 → 越後中里           4.87 km drawn, 2.69 km of loop missing
    中村線      荷稲 → 若井               7.33 km drawn, 2.26 km of loop missing

`LineGraph.add_polyline` now gives a section's INTERIOR repeat visits their own
node identity (its endpoints keep the shared coordinate, so real junctions
still join), which closes the shortcut for good. This migration applies that
same corrected graph to the four affected intervals of the CURRENT package
rather than re-running the whole rebuild — a full rebuild would also undo
`split-interleaved-branches`, `repair-doubling-back-intervals` and the derived
`-2` line records that landed after it.

What it will and will not do:

  * It re-cuts an interval only if that interval's drawn geometry currently
    passes a loop junction WITHOUT the loop. An interval already carrying its
    loop is left alone, so the script is idempotent.
  * It keeps both endpoints exactly where they were, so the line stays
    seam-free and every station keeps its anchor.
  * It refuses an interval whose re-cut path does not actually gain the loop.
    上越線 土樽 → 越後中里 is the case that matters: 上り and 下り run on
    separate alignments there and only the 上り one loops, so the corrected
    graph still prefers the 下り alignment through the tunnel. The script
    reports it as unchanged rather than forcing a loop the shortest path does
    not take.

Usage:
  python3 scripts/migrations/restore-n02-loop-line-geometry.py [--dry-run]
"""

from __future__ import annotations

import importlib.util
import json
import math
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
BUILDER = APP_DIR / "scripts" / "railway" / "rebuild-japan-package-geometry.py"
PACKAGE = APP_DIR / "public" / "rail" / "jp-2025.json"
SECTIONS = APP_DIR / "data" / "rail-sections.json"
NEW_VERSION = "2025.3.4"


def load_builder():
    """Import the rebuild script as a module (its filename has hyphens).

    Sharing its LineGraph is the whole point: the interval this migration
    writes has to be the interval a future full rebuild would write, or the
    package and the builder disagree the moment anyone runs one.
    """
    sys.path.insert(0, str(APP_DIR / "scripts" / "railway"))
    spec = importlib.util.spec_from_file_location("jp_geometry_builder", BUILDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def coord_key(point):
    return f"{point[0]:.6f},{point[1]:.6f}"


def haversine(a, b):
    p1 = [math.radians(a[0]), math.radians(a[1])]
    p2 = [math.radians(b[0]), math.radians(b[1])]
    dlon, dlat = p2[0] - p1[0], p2[1] - p1[1]
    h = math.sin(dlat / 2) ** 2 + math.cos(p1[1]) * math.cos(p2[1]) * math.sin(dlon / 2) ** 2
    return 6371.0088 * 2 * math.asin(math.sqrt(h))


def polyline_km(points):
    return sum(haversine(a, b) for a, b in zip(points, points[1:]))


def find_loops(sections):
    """Every N02 section that crosses back over a point it already passed."""
    loops = []
    for feature in sections["features"]:
        if feature.get("geometry", {}).get("type") != "LineString":
            continue
        coords = feature["geometry"]["coordinates"]
        seen = defaultdict(list)
        for index, point in enumerate(coords):
            seen[coord_key(point)].append(index)
        for key, indexes in seen.items():
            first, last = indexes[0], indexes[-1]
            # Two adjacent identical vertices are a duplicate, not a loop; and
            # a section whose two ENDPOINTS coincide is a closed balloon hung
            # off the line at one point (身延線), which no through path enters.
            if last - first < 2:
                continue
            if first == 0 and last == len(coords) - 1:
                continue
            props = feature.get("properties", {})
            loops.append(
                {
                    "name": str(props.get("N02_003") or ""),
                    "operator": str(props.get("N02_004") or ""),
                    "junction": key,
                    "interior": {coord_key(p) for p in coords[first + 1 : last]},
                    "km": polyline_km(coords[first : last + 1]),
                }
            )
    return loops


def interval_polylines(line):
    """The package's intervals as full polylines (shared-first expanded)."""
    out = []
    previous = None
    for row in line["segments"]:
        coords = [list(p) for p in row[2]]
        if row[1] and previous is not None:
            coords = [list(previous)] + coords
        out.append(coords)
        previous = row[2][-1]
    return out


def station_name(row):
    return row[1] if isinstance(row, list) else row


def main():
    dry_run = "--dry-run" in sys.argv
    builder = load_builder()
    package = json.loads(PACKAGE.read_text())
    sections = json.loads(SECTIONS.read_text())
    loops = find_loops(sections)
    print(f"N02 sections that cross back over themselves: {len(loops)}")

    groups = defaultdict(list)
    for feature in sections["features"]:
        if feature.get("geometry", {}).get("type") != "LineString":
            continue
        props = feature.get("properties", {})
        coords = feature["geometry"]["coordinates"]
        if len(coords) >= 2:
            groups[
                (builder.section_line_name(props), builder.section_operator(props))
            ].append(coords)

    graphs = {}

    def graph_for(line):
        key = (line["name"], line["operator"])
        polylines = groups.get(key)
        if not polylines:
            line_id = str(line["id"])
            suffix = "-" + line["name"]
            if line_id.startswith("jp-") and line_id.endswith(suffix):
                key = (line["name"], line_id[len("jp-") : -len(suffix)])
                polylines = groups.get(key)
        if not polylines:
            return None
        if key not in graphs:
            graph = builder.LineGraph()
            for coords in polylines:
                graph.add_polyline(coords)
            graph.finish()
            graphs[key] = graph
        return graphs[key]

    repaired = []
    unchanged = []
    already = []

    for line in package["lines"]:
        line_loops = [L for L in loops if L["name"] == line["name"]]
        if not line_loops:
            continue
        drawn = interval_polylines(line)
        for index, coords in enumerate(drawn):
            keys = {coord_key(p) for p in coords}
            for loop in line_loops:
                if loop["junction"] not in keys:
                    continue
                present = len(loop["interior"] & keys)
                label = (
                    f"{line['id']}  {station_name(line['stations'][index])}"
                    f" → {station_name(line['stations'][index + 1])}"
                )
                if present:
                    already.append((label, loop, polyline_km(coords)))
                    break
                graph = graph_for(line)
                if graph is None:
                    unchanged.append((label, loop, "no N02 sections for this line"))
                    break
                start = coords[0]
                end = coords[-1]
                a_node, a_d = graph.nearest(start)
                b_node, b_d = graph.nearest(end)
                path = (
                    graph.path(a_node, b_node)
                    if a_node is not None and b_node is not None
                    else None
                )
                if not path:
                    unchanged.append((label, loop, "no path through the N02 graph"))
                    break
                from lib.geometry import dedupe  # noqa: E402  (builder's sys.path)

                rebuilt = dedupe(
                    [list(start)]
                    + [builder.node_point(node) for node in path]
                    + [list(end)]
                )
                gained = len({coord_key(p) for p in rebuilt} & loop["interior"])
                if gained < len(loop["interior"]) * 0.8:
                    unchanged.append(
                        (
                            label,
                            loop,
                            "the shortest path still avoids the loop — a separate "
                            "alignment carries the other direction here",
                        )
                    )
                    break
                # Endpoints are the station anchors and must not move.
                if rebuilt[0] != list(start) or rebuilt[-1] != list(end):
                    unchanged.append((label, loop, "endpoints would have moved"))
                    break
                repaired.append(
                    {
                        "line": line,
                        "index": index,
                        "label": label,
                        "loop": loop,
                        "before_km": polyline_km(coords),
                        "after_km": polyline_km(rebuilt),
                        "coords": rebuilt,
                    }
                )
                break

    for label, loop, km in already:
        print(f"  already drawn: {label}  ({km:.3f} km, loop {loop['km']:.3f} km)")
    for label, loop, why in unchanged:
        print(f"  left alone:    {label}  (loop {loop['km']:.3f} km) — {why}")
    for item in repaired:
        gain = item["after_km"] - item["before_km"]
        print(
            f"  REPAIRED:      {item['label']}  "
            f"{item['before_km']:.3f} → {item['after_km']:.3f} km "
            f"(+{gain:.3f}, loop {item['loop']['km']:.3f} km)"
        )
        # The gain has to BE the loop, not a different detour.
        assert abs(gain - item["loop"]["km"]) < 0.05, "gain is not the loop's length"

    if not repaired:
        print("nothing to repair — package already carries every drawable loop")
        return

    # Re-encode each touched line in place.
    for item in repaired:
        line = item["line"]
        intervals = [
            {"coords": c, "extra": row[3:] if len(row) > 3 else []}
            for c, row in zip(interval_polylines(line), line["segments"])
        ]
        intervals[item["index"]]["coords"] = item["coords"]
        line["segments"] = builder.encode_segments(intervals)

    package["version"] = NEW_VERSION
    if dry_run:
        print("--dry-run: package NOT written")
        return
    PACKAGE.write_text(
        json.dumps(package, ensure_ascii=False, separators=(",", ":")) + "\n"
    )
    print(f"wrote {PACKAGE} (version {NEW_VERSION})")

    # The lane table is a pure function of the display geometry, so it is stale
    # the moment an interval changes shape — and the loop is exactly the kind of
    # shape that moves a corridor. Regenerating it here rather than leaving it
    # to whoever runs the tests next is the difference between a migration and
    # a half-migration.
    print("regenerating the jp lane table (geometry changed)…")
    subprocess.run(
        [
            "node",
            str(APP_DIR / "scripts" / "railway" / "build-parallel-corridors.mjs"),
            "--country",
            "jp",
        ],
        cwd=APP_DIR,
        check=True,
    )


if __name__ == "__main__":
    main()
