#!/usr/bin/env python3
"""Prepare smooth, continuous Hong Kong route centre-lines from OSM.

Each display line is rebuilt from ONE OSM route relation into ONE continuous
polyline. Member ways are chained by exact shared node ids (relation-order
first, nearest-connectable fallback), so branches join at the true junction
and there are no breakpoints. The chain is then refined for cartographic
display: micro-spikes (surveying/switch artifacts that read as sudden kinks)
are removed, corners are rounded with Chaikin subdivision, and the result is
re-simplified at a small tolerance — the Apple-Maps-like smooth look the
display package wants. Station positions are projected onto these refined
centre-lines by scripts/build-hong-kong-rail-package.py afterwards, so
station anchors always sit exactly on the drawn line.

Input is a raw Overpass dump of the route relations with full way/node
detail, e.g.:

  [out:json];area(3600913110)->.hk;
  (relation["route"~"^(subway|light_rail|train|tram|funicular)$"](area.hk););
  out body;>;out skel qt;

Usage:
  python3 scripts/build-hong-kong-track-alignments.py \
    --osm /tmp/hk-osm-rail-full.json \
    --output scripts/data/hk-track-alignments.json
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


RELATION_TO_LINE = {
    5317239: "AEL", 4709540: "DRL", 4248592: "EAL-LOW",
    4248591: "EAL-LMC", 4432666: "ISL", 272125: "KTL",
    6827211: "SIL", 5317706: "TCL", 269672: "TKL-POA",
    13352937: "TKL-LHP", 6102298: "TML", 9736530: "TWL",
    3515354: "LR-505", 3679916: "LR-507", 3680161: "LR-610",
    3680323: "LR-614", 5955256: "LR-614P", 3680520: "LR-615",
    5955258: "LR-615P", 2941692: "LR-705", 2941790: "LR-706",
    2926506: "LR-751", 2942633: "LR-761P",
}

# A member way that cannot chain within this distance of either chain end is
# treated as a stray (parallel platform track, siding) and dropped.
MAX_BRIDGE_METERS = 150.0
# Refinement parameters — see refine().
SPIKE_TURN_DEGREES = 55.0
SPIKE_EDGE_METERS = 30.0
REVERSAL_TURN_DEGREES = 150.0
CHAIKIN_ITERATIONS = 2
SIMPLIFY_TOLERANCE_METERS = 1.5


def metres(a, b):
    latitude = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * 111_320 * math.cos(latitude), (a[1] - b[1]) * 111_320)


def turn_degrees(a, b, c):
    v1 = (b[0] - a[0], b[1] - a[1])
    v2 = (c[0] - b[0], c[1] - b[1])
    l1 = math.hypot(*v1)
    l2 = math.hypot(*v2)
    if l1 == 0 or l2 == 0:
        return 0.0
    cosine = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)
    return math.degrees(math.acos(max(-1.0, min(1.0, cosine))))


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


def simplify(points, tolerance):
    if len(points) <= 2:
        return points
    start, end = points[0], points[-1]
    index, maximum = 0, 0.0
    for candidate in range(1, len(points) - 1):
        distance = point_segment_metres(points[candidate], start, end)
        if distance > maximum:
            index, maximum = candidate, distance
    if maximum <= tolerance:
        return [start, end]
    return simplify(points[: index + 1], tolerance)[:-1] + simplify(points[index:], tolerance)


def chain_relation_ways(relation, ways):
    """Chain track-way members into one continuous node-id list."""
    members = [
        m["ref"]
        for m in relation.get("members", [])
        if m.get("type") == "way" and not str(m.get("role", "")).startswith(("platform", "stop"))
    ]
    pending = [list(ways[ref]) for ref in members if ref in ways and len(ways[ref]) >= 2]
    if not pending:
        raise RuntimeError(f"relation {relation['id']} has no usable track ways")
    chain = pending.pop(0)
    dropped = 0
    bridged = 0.0

    def endpoints(seq):
        return seq[0], seq[-1]

    while pending:
        attached = False
        # 1. Exact node-id attachment, preferring relation order.
        for index, way in enumerate(pending):
            head, tail = endpoints(way)
            if head == chain[-1]:
                chain.extend(way[1:])
            elif tail == chain[-1]:
                chain.extend(list(reversed(way))[1:])
            elif tail == chain[0]:
                chain[:0] = way[:-1]
            elif head == chain[0]:
                chain[:0] = list(reversed(way))[:-1]
            else:
                continue
            pending.pop(index)
            attached = True
            break
        if attached:
            continue
        # 2. Nearest-connectable fallback (small physical gap, bridged).
        best = None
        for index, way in enumerate(pending):
            for reverse in (False, True):
                seq = list(reversed(way)) if reverse else way
                gap_tail = metres_by_node(chain[-1], seq[0])
                gap_head = metres_by_node(chain[0], seq[-1])
                if best is None or min(gap_tail, gap_head) < best[0]:
                    best = (min(gap_tail, gap_head), gap_tail <= gap_head, index, seq)
        gap, at_tail, index, seq = best
        if gap > MAX_BRIDGE_METERS:
            # Stray (parallel platform track / siding) — drop it.
            pending.pop(index)
            dropped += 1
            continue
        bridged += gap
        if at_tail:
            chain.extend(seq)
        else:
            chain[:0] = seq
        pending.pop(index)
    return chain, dropped, bridged


NODE_COORDS = {}


def metres_by_node(a, b):
    return metres(NODE_COORDS[a], NODE_COORDS[b])


def despike(points):
    """Remove micro-spikes and reversal artifacts until stable."""
    changed = True
    while changed and len(points) > 2:
        changed = False
        result = [points[0]]
        index = 1
        while index < len(points) - 1:
            a, b, c = result[-1], points[index], points[index + 1]
            turn = turn_degrees(a, b, c)
            short_edge = metres(a, b) < SPIKE_EDGE_METERS or metres(b, c) < SPIKE_EDGE_METERS
            if turn > REVERSAL_TURN_DEGREES or (turn > SPIKE_TURN_DEGREES and short_edge):
                changed = True
                index += 1
                continue
            result.append(b)
            index += 1
        result.append(points[-1])
        points = result
    return points


def chaikin(points, iterations):
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


def dedupe(points):
    result = [points[0]]
    for point in points[1:]:
        if point != result[-1]:
            result.append(point)
    return result


def refine(points):
    """Despike → Chaikin corner rounding → small-tolerance simplify."""
    points = dedupe(points)
    points = despike(points)
    points = chaikin(points, CHAIKIN_ITERATIONS)
    points = simplify(points, SIMPLIFY_TOLERANCE_METERS)
    return [[round(p[0], 7), round(p[1], 7)] for p in points]


def quality(points):
    kinks = 0
    max_gap = 0.0
    for i in range(1, len(points) - 1):
        turn = turn_degrees(points[i - 1], points[i], points[i + 1])
        if turn > 60 and (
            metres(points[i - 1], points[i]) < 40 or metres(points[i], points[i + 1]) < 40
        ):
            kinks += 1
    for a, b in zip(points, points[1:]):
        max_gap = max(max_gap, metres(a, b))
    return kinks, max_gap


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--osm", type=Path, required=True, help="Overpass dump (relations + ways + nodes)")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    dump = json.loads(args.osm.read_text())
    ways = {}
    relations = {}
    for element in dump["elements"]:
        if element["type"] == "node":
            NODE_COORDS[element["id"]] = [element["lon"], element["lat"]]
        elif element["type"] == "way":
            ways[element["id"]] = element.get("nodes", [])
        elif element["type"] == "relation":
            relations[element["id"]] = element

    routes = {}
    stats = {}
    for relation_id, line_id in RELATION_TO_LINE.items():
        relation = relations.get(relation_id)
        if not relation:
            raise RuntimeError(f"OSM dump is missing relation {relation_id} ({line_id})")
        node_chain, dropped, bridged = chain_relation_ways(relation, ways)
        coords = dedupe([NODE_COORDS[node] for node in node_chain if node in NODE_COORDS])
        refined = refine(coords)
        kinks, max_gap = quality(refined)
        routes[line_id] = refined
        stats[line_id] = {
            "points": len(refined),
            "kinks": kinks,
            "maxGapMeters": round(max_gap, 1),
            "droppedStrayWays": dropped,
            "bridgedMeters": round(bridged, 1),
        }
        if kinks:
            print(f"WARNING {line_id}: {kinks} residual kinks")
        print(
            f"{line_id:10} points={len(refined):4} kinks={kinks} "
            f"maxGap={max_gap:7.1f}m strays={dropped} bridged={bridged:.0f}m"
        )

    missing = sorted(set(RELATION_TO_LINE.values()) - set(routes))
    if missing:
        raise RuntimeError(f"Missing Hong Kong route relations: {missing}")
    output = {"version": 2, "routes": routes, "refinement": stats}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
