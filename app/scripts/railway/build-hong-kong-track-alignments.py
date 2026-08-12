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
centre-lines by scripts/railway/build-hong-kong-rail-package.py afterwards, so
station anchors always sit exactly on the drawn line.

Input is a raw Overpass dump of the route relations with full way/node
detail, e.g.:

  [out:json];area(3600913110)->.hk;
  (relation["route"~"^(subway|light_rail|train|tram|funicular)$"](area.hk););
  out body;>;out skel qt;

Usage:
  python3 scripts/railway/build-hong-kong-track-alignments.py \
    --osm /tmp/hk-osm-rail-full.json \
    --output data/raw/railway/hk/hk-track-alignments.json
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from lib.geometry import (
    chaikin,
    dedupe,
    despike,
    metres,
    point_segment_metres,
    simplify,
    turn_degrees,
)


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

# ── Hong Kong Tramways (--profile tram) ─────────────────────────────────────
# The tramway is the one PHYSICAL network here, not a set of service routes.
# Hong Kong Tramways runs six numbered routes, but they all share the same
# double-track corridor along the north shore of Hong Kong Island, so building
# a display line per route would draw the same rails five or six times over
# and inflate the tramway's mileage from ~30 km to ~150 km. What is actually
# distinct on the ground is:
#
#   TRAM-EAST  the eastbound track, 堅尼地城 → 筲箕灣
#   TRAM-WEST  the westbound track, 筲箕灣 → 堅尼地城 (a few metres away, with
#              its own, separately numbered stops)
#   TRAM-HV    the one-way Happy Valley loop off 堅拿道
#   TRAM-NPT   the 春秧街 single track, the only way in to 北角總站
#
# The two through directions come straight from the route-6 relations (the
# only pair that runs the whole corridor); the two branches are cut out of a
# route ring that uses them, between the stops where they leave and rejoin the
# through tracks (those junction stops are repeated on the branch so the
# branch is an interchange of the through line, never an island).
TRAM_THROUGH_LINES = {
    "TRAM-EAST": 4088262,  # route 6, 堅尼地城 → 筲箕灣
    "TRAM-WEST": 4088263,  # route 6, 筲箕灣 → 堅尼地城
}
TRAM_BRANCH_LINES = {
    # line: (arriving relation, departing relation, junction stop, rejoin stop)
    "TRAM-HV": (3263757, 4088000, "49E", "52W"),   # route 5 via Happy Valley
    "TRAM-NPT": (4088481, 4088457, "65E", "32W"),  # route 3 via 春秧街
}
# Terminus platforms sit on short sidings that the through relations do not
# run over, so OSM never lists them as members of the route-6 relations even
# though the operator's own stop list has them in the through sequence. Each
# is pulled in from a relation that does terminate there and takes its place
# on the through track by projection.
TRAM_TERMINUS_STOPS = {
    "TRAM-EAST": [
        ("WST", 4088481),        # 石塘咀總站, between 07E and 09E
        (24358851, 4088368),     # 上環（西港城）總站, between 19E and 21E
    ],
    "TRAM-WEST": [("CBT", 4088086)],  # 銅鑼灣總站, between 44W and 46W
}
# 北角總站 is deliberately absent from the list above: unlike the other
# termini it is not a siding beside the through track but the far end of the
# 春秧街 single track, so it belongs to TRAM-NPT.

# Some stop nodes are mapped beside the rails instead of as a vertex of the
# track, so they have no position in the node chain to be ordered by. Where a
# properly tagged twin stop exists within this radius its official code is
# borrowed; otherwise the stop is placed by projecting it between the stops it
# sits between in the relation.
TRAM_STOP_TWIN_METERS = 50.0

# A member way that cannot chain within this distance of either chain end is
# treated as a stray (parallel platform track, siding) and dropped.
MAX_BRIDGE_METERS = 150.0
# Refinement parameters — see refine().
CHAIKIN_ITERATIONS = 2
SIMPLIFY_TOLERANCE_METERS = 1.5


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


def report(line_id, refined, dropped, bridged):
    kinks, max_gap = quality(refined)
    if kinks:
        print(f"WARNING {line_id}: {kinks} residual kinks")
    print(
        f"{line_id:10} points={len(refined):4} kinks={kinks} "
        f"maxGap={max_gap:7.1f}m strays={dropped} bridged={bridged:.0f}m"
    )
    return {
        "points": len(refined),
        "kinks": kinks,
        "maxGapMeters": round(max_gap, 1),
        "droppedStrayWays": dropped,
        "bridgedMeters": round(bridged, 1),
    }


def build_mtr_alignments(relations, ways):
    routes = {}
    stats = {}
    for relation_id, line_id in RELATION_TO_LINE.items():
        relation = relations.get(relation_id)
        if not relation:
            raise RuntimeError(f"OSM dump is missing relation {relation_id} ({line_id})")
        node_chain, dropped, bridged = chain_relation_ways(relation, ways)
        coords = dedupe([NODE_COORDS[node] for node in node_chain if node in NODE_COORDS])
        refined = refine(coords)
        routes[line_id] = refined
        stats[line_id] = report(line_id, refined, dropped, bridged)

    missing = sorted(set(RELATION_TO_LINE.values()) - set(routes))
    if missing:
        raise RuntimeError(f"Missing Hong Kong route relations: {missing}")
    return {"version": 2, "routes": routes, "refinement": stats}


# ── tram profile ────────────────────────────────────────────────────────────

NODE_TAGS = {}


def cumulative_meters(coords):
    measures = [0.0]
    for a, b in zip(coords, coords[1:]):
        measures.append(measures[-1] + metres(a, b))
    return measures


def measure_of_closest_point(point, coords, measures, low, high):
    """Where along `coords` the point sits, searching only [low, high] metres."""
    best = (float("inf"), low)
    for index, (start, end) in enumerate(zip(coords, coords[1:])):
        if measures[index + 1] < low or measures[index] > high:
            continue
        span = measures[index + 1] - measures[index]
        distance = point_segment_metres(point, start, end)
        if distance >= best[0]:
            continue
        if span == 0:
            best = (distance, measures[index])
            continue
        # Re-derive the position on this edge from the perpendicular foot.
        latitude = math.radians(point[1])
        scale_x = 111_320 * math.cos(latitude)
        ax, ay = (start[0] - point[0]) * scale_x, (start[1] - point[1]) * 111_320
        bx, by = (end[0] - point[0]) * scale_x, (end[1] - point[1]) * 111_320
        dx, dy = bx - ax, by - ay
        ratio = 0.0 if dx == dy == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        best = (distance, min(high, max(low, measures[index] + ratio * span)))
    return best[1]


def tram_stop_members(relation):
    return [
        member["ref"]
        for member in relation.get("members", [])
        if member.get("type") == "node" and str(member.get("role", "")).startswith("stop")
    ]


def tram_stop_code(node_id, coded_stops):
    """The operator's stop code for an OSM stop node.

    Stops mapped beside the rails carry no code of their own; the properly
    tagged twin a few metres away is the same physical stop.
    """
    reference = (NODE_TAGS.get(node_id) or {}).get("ref")
    if reference:
        return reference
    twin = min(
        ((metres(NODE_COORDS[node_id], NODE_COORDS[other]), other) for other in coded_stops if other != node_id),
        default=None,
    )
    if twin and twin[0] <= TRAM_STOP_TWIN_METERS:
        return NODE_TAGS[twin[1]]["ref"]
    raise RuntimeError(f"tram stop node {node_id} has no official code and no tagged twin")


def order_tram_stops(node_chain, member_nodes, off_track_nodes=()):
    """Place every stop of a line along its node chain, in running order.

    Stops that ARE chain vertices are placed exactly, walking forward through
    the relation's own stop order so a chain that touches a node twice picks
    the right visit. Stops mapped beside the rails are then projected: members
    only between the stops they sit between, terminus platforms over the whole
    line (their siding is nowhere near the rest of the track).
    """
    coords = [NODE_COORDS[node] for node in node_chain]
    measures = cumulative_meters(coords)
    indexes = {}
    for index, node in enumerate(node_chain):
        indexes.setdefault(node, []).append(index)

    placed = []
    cursor = -1
    for node in member_nodes:
        hits = indexes.get(node)
        if hits:
            pick = next((index for index in hits if index > cursor), hits[-1])
            cursor = pick
            placed.append([node, measures[pick]])
        else:
            placed.append([node, None])
    for position, (node, measure) in enumerate(placed):
        if measure is not None:
            continue
        low = next((placed[i][1] for i in range(position - 1, -1, -1) if placed[i][1] is not None), 0.0)
        high = next(
            (placed[i][1] for i in range(position + 1, len(placed)) if placed[i][1] is not None),
            measures[-1],
        )
        placed[position][1] = measure_of_closest_point(NODE_COORDS[node], coords, measures, low, high)
    for node in off_track_nodes:
        placed.append([node, measure_of_closest_point(NODE_COORDS[node], coords, measures, 0.0, measures[-1])])

    placed.sort(key=lambda entry: entry[1])
    ordered = []
    for node, measure in placed:
        if ordered and ordered[-1][0] == node:
            continue
        ordered.append((node, measure))
    return ordered, coords, measures


def slice_chain(coords, measures, start, end):
    """The coordinates between two measures, cut exactly at both ends."""
    def point_at(target):
        for index in range(len(measures) - 1):
            if measures[index + 1] >= target:
                span = measures[index + 1] - measures[index]
                ratio = 0.0 if span == 0 else (target - measures[index]) / span
                return [
                    coords[index][0] + ratio * (coords[index + 1][0] - coords[index][0]),
                    coords[index][1] + ratio * (coords[index + 1][1] - coords[index][1]),
                ]
        return coords[-1]

    result = [point_at(start)]
    result.extend(coords[i] for i in range(len(coords)) if start < measures[i] < end)
    result.append(point_at(end))
    return dedupe(result)


def build_tram_alignments(relations, ways):
    coded_stops = [node for node, tags in NODE_TAGS.items() if tags.get("ref")]
    routes = {}
    stats = {}

    def chain_of(relation_id):
        relation = relations.get(relation_id)
        if not relation:
            raise RuntimeError(f"OSM dump is missing tram relation {relation_id}")
        return chain_relation_ways(relation, ways)

    def emit(line_id, coords, ordered, dropped, bridged):
        refined = refine(coords)
        routes[line_id] = {
            "coordinates": refined,
            "stops": [
                {
                    "code": tram_stop_code(node, coded_stops),
                    "node": node,
                    "lon": NODE_COORDS[node][0],
                    "lat": NODE_COORDS[node][1],
                }
                for node, _ in ordered
            ],
        }
        stats[line_id] = report(line_id, refined, dropped, bridged)
        stats[line_id]["stops"] = len(ordered)

    for line_id, relation_id in TRAM_THROUGH_LINES.items():
        node_chain, dropped, bridged = chain_of(relation_id)
        terminus = [
            node
            for stop, source in TRAM_TERMINUS_STOPS.get(line_id, [])
            for node in [stop if isinstance(stop, int) else next(
                candidate
                for candidate in tram_stop_members(relations[source])
                if (NODE_TAGS.get(candidate) or {}).get("ref") == stop
            )]
        ]
        ordered, coords, _ = order_tram_stops(
            node_chain, tram_stop_members(relations[relation_id]), terminus
        )
        emit(line_id, coords, ordered, dropped, bridged)

    for line_id, (arriving, departing, junction, rejoin) in TRAM_BRANCH_LINES.items():
        head, dropped_a, bridged_a = chain_of(arriving)
        tail, dropped_b, bridged_b = chain_of(departing)
        ring = head + (tail[1:] if head[-1] == tail[0] else tail)
        members = tram_stop_members(relations[arriving]) + tram_stop_members(relations[departing])
        ordered, coords, measures = order_tram_stops(ring, members)
        by_code = {tram_stop_code(node, coded_stops): measure for node, measure in ordered}
        for code in (junction, rejoin):
            if code not in by_code:
                raise RuntimeError(f"{line_id}: junction stop {code} is not on the route ring")
        start, end = by_code[junction], by_code[rejoin]
        if not start < end:
            raise RuntimeError(f"{line_id}: {junction} does not precede {rejoin} on the ring")
        branch = [(node, measure) for node, measure in ordered if start <= measure <= end]
        emit(
            line_id,
            slice_chain(coords, measures, start, end),
            branch,
            dropped_a + dropped_b,
            bridged_a + bridged_b,
        )

    return {"version": 1, "routes": routes, "refinement": stats}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--osm", type=Path, required=True, help="Overpass dump (relations + ways + nodes)")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--profile",
        choices=("mtr", "tram"),
        default="mtr",
        help="mtr: the MTR heavy-rail and Light Rail relations; tram: Hong Kong Tramways",
    )
    args = parser.parse_args()
    dump = json.loads(args.osm.read_text())
    ways = {}
    relations = {}
    for element in dump["elements"]:
        if element["type"] == "node":
            NODE_COORDS[element["id"]] = [element["lon"], element["lat"]]
            if element.get("tags"):
                NODE_TAGS[element["id"]] = element["tags"]
        elif element["type"] == "way":
            ways[element["id"]] = element.get("nodes", [])
        elif element["type"] == "relation":
            relations[element["id"]] = element

    output = (
        build_tram_alignments(relations, ways)
        if args.profile == "tram"
        else build_mtr_alignments(relations, ways)
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
