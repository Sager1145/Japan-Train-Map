#!/usr/bin/env python3
"""Rebuild jp-2025.json interval geometry from the official N02 GIS sections.

The original display package stored heavily simplified interval geometry
(median ~4 vertices/km; 533 intervals over 0.8 km were bare 2-point chords),
so ridden routes — which carry full-detail N02 solver geometry — visibly
diverged from the drawn network between stations. This script re-cuts every
line's station intervals directly from ``data/rail-sections.json`` (the
official 国土数値情報 N02 RailroadSection geometry, the very dataset the
route solver walks), so the drawn network and solved ridden routes share the
same vertices and coincide.

Method, per package line (all 600 in the current package):
  1. Collect the N02 sections whose N02_003/N02_004 match the line's
     name/operator and build an exact-coordinate graph from their polylines.
  2. For each consecutive station pair, Dijkstra through that graph between
     the nodes nearest the two stations, yielding the official on-track path.
  3. Snap the interval's endpoints to the package station coordinates
     (compact-v1 invariant; identical to the previous build's behaviour).
Geometry is intentionally NOT smoothed or simplified — official GIS fidelity
is the point, and N02's vertex density renders smoothly on its own. Lines or
intervals whose N02 subgraph cannot be pathed keep their previous geometry
(reported at the end).

The rebuild also COMPLETES each line against the official N02 station set:
stations N02 assigns to the line but the old curated sequence omitted (e.g.
the whole 東京—横浜 東海道線 corridor with 大森/蒲田, which left the trunk
undrawn) are snapped to the official per-line graph and inserted into its
station topology. Connected branches remain attached at their real junction;
disconnected official components become their own complete line entries.

Everything else (ids, names, operators, ranks, colors, romanizations, logo
flags, existing station rows, arcDirection extras) is preserved byte-for-byte;
inserted station rows are 4-field rows (no romanization), which the reader
already supports.

The command is idempotent. Before rebuilding, previously derived disconnected
components are collapsed back to the first canonical record for each
``(operator, line name)`` pair; they are then re-derived from the official N02
graph. Running the command twice therefore cannot multiply ``-2``/``-3`` line
fragments.

Usage:
  python3 scripts/rebuild-japan-package-geometry.py
"""

from __future__ import annotations

import gzip
import heapq
import json
import math
from collections import defaultdict
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
PACKAGE = APP_DIR / "public" / "rail" / "jp-2025.json"
SECTIONS = APP_DIR / "data" / "rail-sections.json"

NEW_VERSION = "2025.3.0"
STATION_SNAP_LIMIT_METERS = 600.0


def metres(a, b):
    latitude = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * 111_320 * math.cos(latitude), (a[1] - b[1]) * 111_320)


def polyline_km(points):
    lon1 = [math.radians(p[0]) for p in points]
    total = 0.0
    for a, b in zip(points, points[1:]):
        p1 = [math.radians(a[0]), math.radians(a[1])]
        p2 = [math.radians(b[0]), math.radians(b[1])]
        dlon, dlat = p2[0] - p1[0], p2[1] - p1[1]
        h = math.sin(dlat / 2) ** 2 + math.cos(p1[1]) * math.cos(p2[1]) * math.sin(dlon / 2) ** 2
        total += 6371.0088 * 2 * math.asin(math.sqrt(h))
    return round(total, 3)


def section_line_name(props):
    return str(props.get("N02_003") or props.get("line_name") or "")


def section_operator(props):
    return str(props.get("N02_004") or props.get("operator") or "")


class LineGraph:
    def __init__(self):
        self.adj = defaultdict(list)  # node -> [(node, weight)]
        self.nodes = []

    def add_polyline(self, coords):
        for a, b in zip(coords, coords[1:]):
            na, nb = tuple(a), tuple(b)
            if na == nb:
                continue
            w = metres(a, b)
            self.adj[na].append((nb, w))
            self.adj[nb].append((na, w))

    def finish(self):
        self.nodes = list(self.adj.keys())

    def nearest(self, point):
        best = None
        best_d = float("inf")
        for node in self.nodes:
            d = metres(point, node)
            if d < best_d:
                best, best_d = node, d
        return best, best_d

    def distances(self, start):
        dist = {start: 0.0}
        heap = [(0.0, start)]
        while heap:
            d, node = heapq.heappop(heap)
            if d > dist.get(node, float("inf")):
                continue
            for neighbour, weight in self.adj[node]:
                nd = d + weight
                if nd < dist.get(neighbour, float("inf")):
                    dist[neighbour] = nd
                    heapq.heappush(heap, (nd, neighbour))
        return dist

    def path(self, start, goal):
        if start == goal:
            return [start]
        dist = {start: 0.0}
        prev = {}
        heap = [(0.0, start)]
        while heap:
            d, node = heapq.heappop(heap)
            if node == goal:
                break
            if d > dist.get(node, float("inf")):
                continue
            for neighbour, weight in self.adj[node]:
                nd = d + weight
                if nd < dist.get(neighbour, float("inf")):
                    dist[neighbour] = nd
                    prev[neighbour] = node
                    heapq.heappush(heap, (nd, neighbour))
        if goal not in prev and goal != start:
            return None
        path = [goal]
        while path[-1] != start:
            path.append(prev[path[-1]])
        path.reverse()
        return path


def decode_segments(line):
    """Expand the compact rows into full coordinate lists (+extras)."""
    full = []
    prev_last = None
    for row in line["segments"]:
        coords = row[2]
        expanded = ([prev_last] if row[1] and prev_last else []) + [list(c) for c in coords]
        prev_last = list(coords[-1])
        full.append({"coords": expanded, "extra": row[3:] if len(row) > 3 else []})
    return full


def encode_segments(intervals):
    """Re-encode with the shared-first-coordinate elision."""
    rows = []
    prev_last = None
    for interval in intervals:
        coords = interval["coords"]
        shared = 1 if prev_last is not None and coords[0] == prev_last else 0
        stored = coords[1:] if shared else coords
        row = [polyline_km(coords), shared, stored]
        row.extend(interval["extra"])
        rows.append(row)
        prev_last = coords[-1]
    return rows


def weld_line_intervals(line):
    """Make the compact rows themselves seam-free, not only the renderer.

    Every interval starts and ends on its authoritative station coordinate;
    encode_segments then elides the shared boundary whenever possible. This
    closes sub-metre source mismatches and the 25 m Nishinomiya-kitaguchi gap
    left by unmatched legacy geometry.
    """
    expanded = decode_segments(line)
    station_count = len(line["stations"])
    for index, interval in enumerate(expanded):
        start = line["stations"][index]
        end = line["stations"][(index + 1) % station_count]
        start_point = [start[2], start[3]]
        end_point = [end[2], end[3]]
        coords = [list(coordinate) for coordinate in interval["coords"]]
        if len(coords) < 2:
            coords = [start_point, end_point]
        else:
            coords[0] = start_point
            coords[-1] = end_point
        interval["coords"] = dedupe(coords)
        if len(interval["coords"]) < 2:
            interval["coords"] = [start_point, end_point]
    line["segments"] = encode_segments(expanded)


def dedupe(coords):
    out = [coords[0]]
    for c in coords[1:]:
        if c != out[-1]:
            out.append(c)
    return out


# N02 station display points are polygons/centroids and can sit noticeably
# away from the section centreline at large terminals. Use the same audited
# 600 m ceiling as interval endpoint snapping. The former 150 m cutoff dropped
# the Narita Airport branch and the Takikawa/Furano ends of the Nemuro Line.
OFFICIAL_STATION_LIMIT_METERS = STATION_SNAP_LIMIT_METERS


def rebuild_intervals(graph, stations, segment_count, old, stats):
    """Re-cut every consecutive-station interval along the line graph."""
    intervals = []
    for index in range(segment_count):
        a_row = stations[index]
        b_row = stations[(index + 1) % len(stations)]
        a_pt = [a_row[2], a_row[3]]
        b_pt = [b_row[2], b_row[3]]
        a_node, a_d = graph.nearest(a_pt)
        b_node, b_d = graph.nearest(b_pt)
        path = None
        if (
            a_node is not None
            and b_node is not None
            and a_d <= STATION_SNAP_LIMIT_METERS
            and b_d <= STATION_SNAP_LIMIT_METERS
        ):
            path = graph.path(a_node, b_node)
            stats["snap_worst"] = max(stats["snap_worst"], a_d, b_d)
        if path is None or len(path) < 1:
            # Keep the previous geometry for this interval (only possible on
            # the pre-insertion pass, where `old` aligns index-for-index) —
            # but SNAP its endpoints to the station rows: the whole line must
            # chain seam-free (old-package endpoints could sit metres off the
            # station coordinate, leaving a visible break at the join).
            if old is not None and index < len(old):
                coords = [list(c) for c in old[index]["coords"]]
                coords[0] = list(a_pt)
                coords[-1] = list(b_pt)
                if len(coords) > 2 and coords[0] == coords[1]:
                    coords.pop(1)
                if len(coords) > 2 and coords[-1] == coords[-2]:
                    coords.pop(-2)
                intervals.append({"coords": coords, "extra": old[index]["extra"]})
            else:
                intervals.append({"coords": [list(a_pt), list(b_pt)], "extra": []})
            stats["fallbacks"] += 1
            continue
        coords = dedupe([a_pt] + [list(node) for node in path] + [b_pt])
        if len(coords) < 2:
            coords = [a_pt, b_pt]
        extra = old[index]["extra"] if old is not None and index < len(old) else []
        intervals.append({"coords": coords, "extra": extra})
    return intervals


STATION_TERRITORY_METERS = 250.0


def resequence_line(line, graph, curated_rows, missing, stats):
    """Rebuild a gap line's station sequence from official adjacency.

    Returns {stations, inserted, skipped, extra_components} where
    extra_components are row-lists for disconnected official corridors
    (e.g. 鹿児島線's 川内—鹿児島 section) that become their own entries.
    """
    curated_index = {row[1]: i for i, row in enumerate(curated_rows)}
    entries = []
    unsnapped = []
    for row in curated_rows:
        node, distance = graph.nearest([row[2], row[3]])
        if node is None or distance > STATION_SNAP_LIMIT_METERS:
            unsnapped.append(row)
            continue
        entries.append({"name": row[1], "row": row, "node": node})
    skipped = 0
    inserted = 0
    for candidate in missing.values():
        node, distance = graph.nearest(candidate["point"])
        if node is None or distance > OFFICIAL_STATION_LIMIT_METERS:
            skipped += 1
            continue
        entries.append(
            {
                "name": candidate["name"],
                "row": [
                    candidate["group"],
                    candidate["name"],
                    candidate["point"][0],
                    candidate["point"][1],
                ],
                "node": node,
            }
        )
        inserted += 1

    # Assign graph nodes to station territories (nearest station ≤250 m).
    territory = {}
    for index, entry in enumerate(entries):
        point = [entry["row"][2], entry["row"][3]]
        for node in graph.nodes:
            d = metres(point, node)
            if d <= STATION_TERRITORY_METERS:
                current = territory.get(node)
                if current is None or d < current[1]:
                    territory[node] = (index, d)

    # Station adjacency: Dijkstra from each station, blocked at the first
    # entry into another station's territory.
    neighbours = defaultdict(dict)
    for index, entry in enumerate(entries):
        dist = {entry["node"]: 0.0}
        heap = [(0.0, entry["node"])]
        while heap:
            d, node = heapq.heappop(heap)
            if d > dist.get(node, float("inf")):
                continue
            owner = territory.get(node)
            if owner is not None and owner[0] != index:
                other = owner[0]
                if d < neighbours[index].get(other, float("inf")):
                    neighbours[index][other] = d
                continue  # blocked: do not expand through another station
            for neighbour, weight in graph.adj[node]:
                nd = d + weight
                if nd < dist.get(neighbour, float("inf")):
                    dist[neighbour] = nd
                    heapq.heappush(heap, (nd, neighbour))
    for a in list(neighbours):
        for b, d in list(neighbours[a].items()):
            if d < neighbours[b].get(a, float("inf")):
                neighbours[b][a] = d

    # Connected components over the adjacency graph.
    seen = set()
    components = []
    for start in range(len(entries)):
        if start in seen:
            continue
        component = []
        stack = [start]
        seen.add(start)
        while stack:
            node = stack.pop()
            component.append(node)
            for other in neighbours[node]:
                if other not in seen:
                    seen.add(other)
                    stack.append(other)
        components.append(component)

    def order_component(component):
        member = set(component)
        # Root: a degree-1 station, preferring the lowest curated index.
        def rank(index):
            degree = sum(1 for o in neighbours[index] if o in member)
            return (
                0 if degree <= 1 else 1,
                curated_index.get(entries[index]["name"], 10_000),
            )
        root = min(component, key=rank)
        order = []
        visited = set()
        def visit(index):
            visited.add(index)
            order.append(index)
            nexts = [o for o in neighbours[index] if o in member and o not in visited]
            nexts.sort(
                key=lambda o: (
                    curated_index.get(entries[o]["name"], 10_000),
                    neighbours[index][o],
                )
            )
            for other in nexts:
                if other not in visited:
                    visit(other)
        visit(root)
        for index in component:  # isolated leftovers keep their place
            if index not in visited:
                order.append(index)
        return order

    components.sort(
        key=lambda c: (
            min(curated_index.get(entries[i]["name"], 10_000) for i in c),
            -len(c),
        )
    )
    main = components[0]
    rows = [entries[i]["row"] for i in order_component(main)]
    rows.extend(unsnapped)
    extra_components = []
    for component in components[1:]:
        if len(component) < 2:
            skipped += 1
            continue
        extra_components.append([entries[i]["row"] for i in order_component(component)])
    return {
        "stations": rows,
        "inserted": inserted,
        "skipped": skipped,
        "extra_components": extra_components,
    }


def project_measure(point, path_coords, measures):
    """(distance m, measure m) of the nearest point on the concatenated path."""
    best = (float("inf"), 0.0)
    coslat = math.cos(math.radians(point[1]))
    for index, (a, b) in enumerate(zip(path_coords, path_coords[1:])):
        ax = (a[0] - point[0]) * 111_320 * coslat
        ay = (a[1] - point[1]) * 111_320
        bx = (b[0] - point[0]) * 111_320 * coslat
        by = (b[1] - point[1]) * 111_320
        dx, dy = bx - ax, by - ay
        if dx == 0 and dy == 0:
            d, t = math.hypot(ax, ay), 0.0
        else:
            t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
            d = math.hypot(ax + t * dx, ay + t * dy)
        if d < best[0]:
            best = (d, measures[index] + t * (measures[index + 1] - measures[index]))
    return best


def main():
    package = json.loads(PACKAGE.read_text())
    sections = json.loads(SECTIONS.read_text())
    station_features = json.loads((APP_DIR / "data" / "stations.json").read_text())

    groups = defaultdict(list)
    for feature in sections["features"]:
        if feature.get("geometry", {}).get("type") != "LineString":
            continue
        props = feature.get("properties", {})
        key = (section_line_name(props), section_operator(props))
        coords = feature["geometry"]["coordinates"]
        if len(coords) >= 2:
            groups[key].append(coords)

    official_stations = defaultdict(list)
    for feature in station_features["features"]:
        props = feature.get("properties", {})
        key = (str(props.get("N02_003") or ""), str(props.get("N02_004") or ""))
        point = props.get("display_point") or feature["geometry"]["coordinates"][0]
        official_stations[key].append(
            {
                "name": str(props.get("N02_005") or ""),
                "group": str(props.get("N02_005g") or props.get("N02_005c") or ""),
                "point": [point[0], point[1]],
            }
        )

    # A prior generated package can already contain derived disconnected
    # components. Keep the first (canonical) record for each physical display
    # line and derive every extra component again below. The committed 2025.2
    # input has no duplicate (operator, name) keys, so this is both a safe
    # migration and the idempotence guard for all later rebuilds.
    canonical_lines = []
    seen_line_keys = set()
    collapsed_components = 0
    for line in package["lines"]:
        key = (line["operator"], line["name"])
        if key in seen_line_keys:
            collapsed_components += 1
            continue
        seen_line_keys.add(key)
        canonical_lines.append(line)
    package["lines"] = canonical_lines

    rebuilt_lines = 0
    inserted_total = 0
    branch_skipped_total = 0
    missing_lines = []
    extra_lines = []
    stats = {"fallbacks": 0, "snap_worst": 0.0}

    for line in package["lines"]:
        key = (line["name"], line["operator"])
        polylines = groups.get(key)
        officials = official_stations.get(key)
        if not polylines:
            # Some lines carry a brand operator ("東京メトロ", "Osaka Metro")
            # while N02_004 is the legal name; the line id keeps the legal
            # form: jp-{N02_004}-{N02_003}.
            line_id = str(line["id"])
            suffix = "-" + line["name"]
            if line_id.startswith("jp-") and line_id.endswith(suffix):
                legal_key = (line["name"], line_id[len("jp-") : -len(suffix)])
                polylines = groups.get(legal_key)
                officials = official_stations.get(legal_key)
        old = decode_segments(line)
        if not polylines:
            missing_lines.append(line["id"])
            continue
        graph = LineGraph()
        for coords in polylines:
            graph.add_polyline(coords)
        graph.finish()

        stations = list(line["stations"])
        is_loop = bool(line.get("isLoop"))
        count = len(line["segments"])

        # Does the curated sequence miss official N02 stations of this line?
        have = {row[1] for row in stations}
        missing = {}
        for candidate in officials or []:
            name = candidate["name"]
            if name and name not in have and name not in missing:
                missing[name] = candidate

        if missing and not is_loop:
            # Completion: rebuild the whole station sequence from the line's
            # official station-adjacency graph (DFS preorder), so dropped
            # corridors rejoin the path, spurs attach at their true junction,
            # and every physical interval is covered by some drawn interval.
            # Disconnected extra corridors become their own line entries.
            result = resequence_line(line, graph, stations, missing, stats)
            stations = result["stations"]
            count = len(stations) - 1
            intervals = rebuild_intervals(graph, stations, count, None, stats)
            inserted_total += result["inserted"]
            branch_skipped_total += result["skipped"]
            line["stations"] = stations
            for extra_stations in result["extra_components"]:
                extra_lines.append((line, extra_stations))
        else:
            intervals = rebuild_intervals(graph, stations, count, old, stats)
            if missing:
                branch_skipped_total += len(missing)

        line["segments"] = encode_segments(intervals)
        line["_graph"] = graph
        rebuilt_lines += 1

    # Disconnected official corridors become their own line entries — the
    # same modelling as the East Rail branches in the Hong Kong package.
    for parent, extra_rows in extra_lines:
        suffix = 2
        existing_ids = {l["id"] for l in package["lines"]}
        while f"{parent['id']}-{suffix}" in existing_ids:
            suffix += 1
        graph = parent["_graph"]
        count = len(extra_rows) - 1
        intervals = rebuild_intervals(graph, extra_rows, count, None, stats)
        entry = {
            "id": f"{parent['id']}-{suffix}",
            "name": parent["name"],
            "operator": parent["operator"],
            "rank": parent["rank"],
            "color": parent["color"],
            "stations": extra_rows,
            "segments": encode_segments(intervals),
        }
        if parent.get("nameRoma"):
            entry["nameRoma"] = parent["nameRoma"]
        package["lines"].append(entry)
    for line in package["lines"]:
        line.pop("_graph", None)
        weld_line_intervals(line)

    package["version"] = NEW_VERSION
    package["geometrySource"] = {
        "officialOnly": 1,
        "providers": ["国土交通省 国土数値情報 鉄道データ N02-25"],
        "license": "国土数値情報ダウンロードサービス 利用約款 (CC BY 4.0 相当)",
        "method": "Station intervals cut from the official N02 RailroadSection polylines by per-line exact-coordinate pathfinding; identical vertex geometry to the route solver's rail-sections dataset, so ridden routes coincide with the drawn network",
        "sections": "data/rail-sections.json (N02-25)",
    }

    raw = json.dumps(package, ensure_ascii=False, separators=(",", ":")).encode()
    PACKAGE.write_bytes(raw)
    with gzip.GzipFile(filename="", mode="wb", fileobj=open(str(PACKAGE) + ".gz", "wb"), mtime=0) as out:
        out.write(raw)

    print(f"rebuilt lines: {rebuilt_lines}/{len(package['lines'])}")
    print(f"previously derived components collapsed before rebuild: {collapsed_components}")
    print(f"interval fallbacks (kept previous geometry): {stats['fallbacks']}")
    print(f"worst station→track snap: {stats['snap_worst']:.1f} m")
    print(f"official stations inserted into main paths: {inserted_total}")
    print(f"official stations left out (off this line's geometry): {branch_skipped_total}")
    print(f"disconnected corridors emitted as new line entries: {len(extra_lines)}")
    for parent, extra_rows in extra_lines:
        print(f"    {parent['id']} → {extra_rows[0][1]}—{extra_rows[-1][1]} ({len(extra_rows)})")
    if missing_lines:
        print(f"lines with no N02 match (geometry unchanged): {len(missing_lines)}")
        for line_id in missing_lines[:20]:
            print("   ", line_id)


if __name__ == "__main__":
    main()
