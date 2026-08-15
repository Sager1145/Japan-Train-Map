#!/usr/bin/env python3
"""Inventory and classify every canonical N02-25 Japan railway identity.

This is a planning artifact for the Japan railway rebuild, not a renderer.
It deliberately keeps two answers:

* ``auto_shape_class`` describes the topology measured from N02.
* ``shape_class`` may be replaced by a documented, operator-facing override.

N02 platform sections are contracted into their ``N02_005g`` station group
before classification.  Parallel edges between the same contracted nodes are
also collapsed.  This prevents most station throats and multiple platforms
from being mistaken for passenger branches while retaining the raw metrics in
the output for later geometry selection.

Only the Python standard library is required.  The source GeoJSON is read
directly from N02-25_GML.zip, so the result is reproducible without extracting
or installing GIS packages.
"""

from __future__ import annotations

import argparse
import csv
import heapq
import json
import math
import re
import zipfile
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


APP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = APP_ROOT / "data/raw/railway/jp/N02-25_GML.zip"
DEFAULT_OSM = APP_ROOT / "data/raw/railway/jp/osm/osm-line-colours.json"
DEFAULT_OVERRIDES = (
    APP_ROOT / "data/raw/railway/jp/classification/line-shape-overrides.json"
)
DEFAULT_RESEARCH = (
    APP_ROOT
    / "data/raw/railway/jp/classification/network-line-shape-research.json"
)
DEFAULT_LINE_COLOURS = APP_ROOT / "data/raw/railway/jp/colours/line-colours.json"
DEFAULT_OPERATOR_COLOURS = (
    APP_ROOT / "data/raw/railway/jp/colours/operator-colours.json"
)
DEFAULT_OUTPUT = APP_ROOT / "data/raw/railway/jp/classification"

SECTION_MEMBER = "N02-25_GML/UTF-8/N02-25_RailroadSection.geojson"
STATION_MEMBER = "N02-25_GML/UTF-8/N02-25_Station.geojson"
EARTH_RADIUS_M = 6_371_008.8
NODE_DP = 5
GEOMETRY_DP = 7
KEY_SEPARATOR = "\u241f"

RAILWAY_CLASS = {
    "11": "普通鉄道JR",
    "12": "普通鉄道",
    "13": "鋼索鉄道",
    "14": "懸垂式鉄道",
    "15": "跨座式鉄道",
    "16": "案内軌条式鉄道",
    "17": "無軌条鉄道",
    "21": "軌道",
    "22": "懸垂式モノレール",
    "23": "跨座式モノレール",
    "24": "案内軌条式",
    "25": "浮上式",
}

SUBWAY_OPERATORS = {
    "東京地下鉄",
    "東京都",
    "大阪市高速電気軌道",
    "名古屋市",
    "横浜市",
    "神戸市",
    "京都市",
    "札幌市",
    "仙台市",
    "福岡市",
}

SUBWAY_EXCEPTIONS = {
    ("東京都", "荒川線"): "tram",
    ("東京都", "日暮里・舎人ライナー"): "agt",
    ("大阪市高速電気軌道", "南港ポートタウン線"): "agt",
}

SWAPPED_SOURCE_KEY = ("えちぜん鉄道", "三国芦原線")
SWAPPED_CANONICAL_KEY = ("三国芦原線", "えちぜん鉄道")


def canonical_line_operator(line: str, operator: str) -> tuple[str, str]:
    if (line, operator) == SWAPPED_SOURCE_KEY:
        return SWAPPED_CANONICAL_KEY
    return line, operator


def canonical_key(operator: str, line: str) -> str:
    return f"{operator}{KEY_SEPARATOR}{line}"


def node_key(point: list[float] | tuple[float, float]) -> tuple[float, float]:
    return round(float(point[0]), NODE_DP), round(float(point[1]), NODE_DP)


def geometry_key(coordinates: list[list[float]]) -> tuple[tuple[float, float], ...]:
    forward = tuple(
        (round(float(point[0]), GEOMETRY_DP), round(float(point[1]), GEOMETRY_DP))
        for point in coordinates
    )
    reverse = tuple(reversed(forward))
    return min(forward, reverse)


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, a)
    lon2, lat2 = map(math.radians, b)
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    value = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(value)))


def polyline_length_m(coordinates: list[list[float]]) -> float:
    return sum(
        haversine_m(tuple(coordinates[index - 1]), tuple(coordinates[index]))
        for index in range(1, len(coordinates))
    )


def load_zip_geojson(path: Path, member: str) -> list[dict]:
    with zipfile.ZipFile(path) as archive:
        with archive.open(member) as source:
            return json.load(source)["features"]


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


class DisjointSet:
    def __init__(self):
        self.parent: dict[tuple[float, float], tuple[float, float]] = {}

    def find(self, item: tuple[float, float]) -> tuple[float, float]:
        self.parent.setdefault(item, item)
        if self.parent[item] != item:
            self.parent[item] = self.find(self.parent[item])
        return self.parent[item]

    def union(self, a: tuple[float, float], b: tuple[float, float]) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


@dataclass
class Edge:
    index: int
    a: tuple[float, float]
    b: tuple[float, float]
    length_m: float
    coordinates: list[list[float]]
    source_indices: list[int] = field(default_factory=list)
    parallel_variants: int = 1


@dataclass
class Graph:
    edges: list[Edge]
    adjacency: dict[tuple[float, float], list[int]]
    node_points: dict[tuple[float, float], tuple[float, float]]
    node_station_names: dict[tuple[float, float], list[str]]
    node_station_groups: dict[tuple[float, float], list[str]]


def midpoint(coordinates: list[list[float]]) -> tuple[float, float]:
    if not coordinates:
        return 0.0, 0.0
    total = polyline_length_m(coordinates)
    if total <= 0:
        return tuple(coordinates[0])
    target = total / 2
    walked = 0.0
    for index in range(1, len(coordinates)):
        a, b = tuple(coordinates[index - 1]), tuple(coordinates[index])
        length = haversine_m(a, b)
        if walked + length >= target:
            ratio = (target - walked) / length if length else 0.0
            return a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio
        walked += length
    return tuple(coordinates[-1])


def connected_components(graph: Graph) -> list[tuple[set, set[int]]]:
    unseen = set(graph.adjacency)
    components = []
    while unseen:
        start = unseen.pop()
        nodes = {start}
        edges: set[int] = set()
        queue = [start]
        while queue:
            node = queue.pop()
            for edge_index in graph.adjacency[node]:
                edges.add(edge_index)
                edge = graph.edges[edge_index]
                other = edge.b if edge.a == node else edge.a
                if other in unseen:
                    unseen.remove(other)
                    nodes.add(other)
                    queue.append(other)
        components.append((nodes, edges))
    components.sort(key=lambda row: -sum(graph.edges[i].length_m for i in row[1]))
    return components


def dijkstra(
    graph: Graph,
    start,
    allowed_edges: set[int],
) -> tuple[dict, dict]:
    distance = {start: 0.0}
    previous: dict = {}
    heap = [(0.0, start)]
    while heap:
        current_distance, node = heapq.heappop(heap)
        if current_distance != distance.get(node):
            continue
        for edge_index in graph.adjacency[node]:
            if edge_index not in allowed_edges:
                continue
            edge = graph.edges[edge_index]
            other = edge.b if edge.a == node else edge.a
            candidate = current_distance + edge.length_m
            if candidate < distance.get(other, math.inf):
                distance[other] = candidate
                previous[other] = (node, edge_index)
                heapq.heappush(heap, (candidate, other))
    return distance, previous


def reconstruct_path(previous: dict, start, end) -> tuple[list, list[int]]:
    if start == end:
        return [start], []
    nodes = [end]
    edges = []
    current = end
    while current != start:
        if current not in previous:
            return [], []
        prior, edge_index = previous[current]
        nodes.append(prior)
        edges.append(edge_index)
        current = prior
    nodes.reverse()
    edges.reverse()
    return nodes, edges


def choose_main_path(graph: Graph, component: tuple[set, set[int]]) -> tuple[list, list[int]]:
    nodes, edges = component
    terminals = [
        node
        for node in nodes
        if sum(edge_index in edges for edge_index in graph.adjacency[node]) == 1
    ]
    if not terminals:
        return sorted(nodes), sorted(edges)
    candidates = terminals if len(terminals) > 1 else list(nodes)
    best = (-1.0, [], [])
    for start in candidates:
        distance, previous = dijkstra(graph, start, edges)
        for end in candidates:
            if end == start or end not in distance:
                continue
            if distance[end] > best[0]:
                path_nodes, path_edges = reconstruct_path(previous, start, end)
                best = distance[end], path_nodes, path_edges
    if best[0] < 0:
        return sorted(nodes), sorted(edges)
    return best[1], best[2]


def graph_metrics(graph: Graph, components) -> dict:
    degree = {node: len(edges) for node, edges in graph.adjacency.items()}
    edge_count = len(graph.edges)
    node_count = len(graph.adjacency)
    component_count = len(components)
    return {
        "node_count": node_count,
        "edge_count": edge_count,
        "component_count": component_count,
        "cycle_rank": edge_count - node_count + component_count,
        "terminal_count": sum(value == 1 for value in degree.values()),
        "junction_count": sum(value >= 3 for value in degree.values()),
        "max_degree": max(degree.values(), default=0),
        "degree": degree,
    }


def auto_shape_class(metrics: dict) -> str:
    components = metrics["component_count"]
    cycles = metrics["cycle_rank"]
    terminals = metrics["terminal_count"]
    max_degree = metrics["max_degree"]
    if components > 1:
        return "disconnected"
    if cycles == 0 and max_degree <= 2 and terminals == 2:
        return "ordinary_linear"
    if cycles == 0 and max_degree >= 3:
        return "branched_terminal"
    if cycles == 1 and terminals == 0 and max_degree == 2:
        return "loop"
    if cycles == 1 and terminals <= 1:
        return "loop_with_tail"
    if cycles == 1:
        return "branch_rejoins"
    if cycles > 1 and terminals <= 1:
        return "complex_loop"
    if cycles > 1:
        return "complex_multicycle"
    return "topology_anomaly"


def render_kind(operator: str, line: str, railway_class: str, institution: str) -> str:
    forced = SUBWAY_EXCEPTIONS.get((operator, line))
    if institution == "1":
        return "shinkansen"
    if operator in SUBWAY_OPERATORS and forced is None:
        return "subway"
    if institution == "2":
        return "jr_conventional"
    if forced:
        return forced
    return {
        "13": "funicular",
        "14": "monorail",
        "15": "monorail",
        "16": "agt",
        "21": "tram",
        "22": "monorail",
        "23": "monorail",
        "24": "agt",
        "25": "maglev",
    }.get(railway_class, "third_sector" if institution == "5" else "private")


def detail_profile(kind: str, length_km: float, station_count: int) -> str:
    if kind == "tram":
        return "short_tram" if length_km <= 20 else "tram_network"
    if kind == "funicular":
        return "short_funicular"
    if length_km <= 5 or station_count <= 4:
        return "short_line"
    if kind in {"subway", "agt", "monorail"} and length_km <= 30:
        return "compact_urban"
    if length_km >= 150:
        return "long_distance"
    return "standard"


def label_node(graph: Graph, node) -> str:
    names = graph.node_station_names.get(node)
    if names:
        return "/".join(names)
    point = graph.node_points.get(node, node)
    best = (math.inf, "")
    for station_node, station_names in graph.node_station_names.items():
        distance = haversine_m(point, graph.node_points.get(station_node, station_node))
        if distance < best[0]:
            best = distance, "/".join(station_names)
    if best[0] <= 1_500:
        return f"{best[1]}附近({best[0]:.0f}m)"
    return f"@{point[1]:.5f},{point[0]:.5f}"


def off_main_parts(
    graph: Graph,
    components,
    main_edges: set[int],
    main_nodes: set,
) -> list[dict]:
    remaining = set(range(len(graph.edges))) - main_edges
    parts = []
    while remaining:
        first_edge = remaining.pop()
        edge_queue = [first_edge]
        part_edges = {first_edge}
        part_nodes = {graph.edges[first_edge].a, graph.edges[first_edge].b}
        while edge_queue:
            edge_index = edge_queue.pop()
            edge = graph.edges[edge_index]
            for node in (edge.a, edge.b):
                for candidate in graph.adjacency[node]:
                    if candidate in remaining:
                        remaining.remove(candidate)
                        part_edges.add(candidate)
                        candidate_edge = graph.edges[candidate]
                        part_nodes.update((candidate_edge.a, candidate_edge.b))
                        edge_queue.append(candidate)
        attachments = sorted(part_nodes & main_nodes)
        local_degree = {
            node: sum(
                edge_index in part_edges for edge_index in graph.adjacency[node]
            )
            for node in part_nodes
        }
        terminals = sorted(node for node, degree in local_degree.items() if degree == 1)
        station_names = sorted(
            {
                name
                for node in part_nodes
                for name in graph.node_station_names.get(node, [])
            }
        )
        if not attachments:
            part_type = "disconnected_component"
        elif len(attachments) >= 2:
            part_type = "rejoin_variant"
        elif terminals:
            part_type = "terminal_branch"
        else:
            part_type = "attached_loop"
        parts.append(
            {
                "type": part_type,
                "length_km": round(
                    sum(graph.edges[index].length_m for index in part_edges) / 1000,
                    3,
                ),
                "junctions": [label_node(graph, node) for node in attachments],
                "terminals": [
                    label_node(graph, node)
                    for node in terminals
                    if node not in attachments
                ],
                "stations": station_names,
                "edge_count": len(part_edges),
            }
        )
    parts.sort(key=lambda part: -part["length_km"])
    return parts


def topology_review_status(
    shape: str,
    branch_parts: list[dict],
    override: dict | None,
    research: dict | None,
) -> str:
    if override:
        return override.get("verification_status", "official_verified")
    if research and research.get("status") == "queried":
        confirmation = research.get("confirmation")
        if confirmation == "route_endpoints_supported":
            return (
                "network_verified_linear"
                if shape == "ordinary_linear"
                else "network_checked_topology_conflict"
            )
        if confirmation == "supports_complex_shape":
            return "network_checked_complex_candidate"
        return "network_checked_needs_decision"
    if shape in {"ordinary_linear", "loop"}:
        return "geometry_high_confidence"
    if shape in {"branched_terminal", "branch_rejoins", "loop_with_tail"}:
        sizeable = [
            part
            for part in branch_parts
            if part["length_km"] >= 1.0 or len(part["stations"]) >= 2
        ]
        return "needs_network_review" if sizeable else "needs_station_throat_review"
    return "needs_network_review"


def build_graph(sections: list[dict], stations: list[dict]) -> tuple[Graph, dict]:
    dsu = DisjointSet()
    sections_by_geometry: dict[tuple, list[tuple[int, dict]]] = defaultdict(list)
    for source_index, section in sections:
        coordinates = section["geometry"]["coordinates"]
        sections_by_geometry[geometry_key(coordinates)].append((source_index, section))

    station_group_nodes: dict[str, set] = defaultdict(set)
    station_group_names: dict[str, set[str]] = defaultdict(set)
    station_group_points: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for station in stations:
        props = station["properties"]
        group = props["N02_005g"]
        station_group_names[group].add(props["N02_005"])
        station_group_points[group].append(midpoint(station["geometry"]["coordinates"]))
        matches = sections_by_geometry.get(geometry_key(station["geometry"]["coordinates"]), [])
        for _source_index, section in matches:
            coordinates = section["geometry"]["coordinates"]
            station_group_nodes[group].update(
                (node_key(coordinates[0]), node_key(coordinates[-1]))
            )

    for nodes in station_group_nodes.values():
        ordered = list(nodes)
        for node in ordered[1:]:
            dsu.union(ordered[0], node)

    # Ensure every endpoint is registered before roots are used as dictionary keys.
    for _source_index, section in sections:
        coordinates = section["geometry"]["coordinates"]
        dsu.find(node_key(coordinates[0]))
        dsu.find(node_key(coordinates[-1]))

    root_points: dict[tuple, list[tuple[float, float]]] = defaultdict(list)
    for point in dsu.parent:
        root_points[dsu.find(point)].append(point)
    node_points = {
        root: (
            sum(point[0] for point in points) / len(points),
            sum(point[1] for point in points) / len(points),
        )
        for root, points in root_points.items()
    }

    node_station_names: dict[tuple, set[str]] = defaultdict(set)
    node_station_groups: dict[tuple, set[str]] = defaultdict(set)
    for group, nodes in station_group_nodes.items():
        if not nodes:
            continue
        root = dsu.find(next(iter(nodes)))
        node_station_names[root].update(station_group_names[group])
        node_station_groups[root].add(group)
        points = station_group_points[group]
        if points:
            node_points[root] = (
                sum(point[0] for point in points) / len(points),
                sum(point[1] for point in points) / len(points),
            )

    # First remove exact duplicate geometries, then collapse parallel semantic
    # edges.  Keep the shortest/smoothest available representative for metrics;
    # all raw source indices remain attached for the geometry-rebuild stage.
    unique_geometry: dict[tuple, tuple[int, dict]] = {}
    duplicate_geometry_count = 0
    for source_index, section in sections:
        key = geometry_key(section["geometry"]["coordinates"])
        if key in unique_geometry:
            duplicate_geometry_count += 1
            continue
        unique_geometry[key] = (source_index, section)

    by_pair: dict[tuple, list[tuple[int, dict, float]]] = defaultdict(list)
    intra_station_count = 0
    for source_index, section in unique_geometry.values():
        coordinates = section["geometry"]["coordinates"]
        a = dsu.find(node_key(coordinates[0]))
        b = dsu.find(node_key(coordinates[-1]))
        if a == b:
            intra_station_count += 1
            continue
        pair = tuple(sorted((a, b)))
        by_pair[pair].append((source_index, section, polyline_length_m(coordinates)))

    edges = []
    for pair, variants in sorted(by_pair.items(), key=lambda row: row[0]):
        source_index, section, length = min(variants, key=lambda row: row[2])
        edges.append(
            Edge(
                index=len(edges),
                a=pair[0],
                b=pair[1],
                length_m=length,
                coordinates=section["geometry"]["coordinates"],
                source_indices=sorted(row[0] for row in variants),
                parallel_variants=len(variants),
            )
        )

    adjacency: dict[tuple, list[int]] = defaultdict(list)
    for edge in edges:
        adjacency[edge.a].append(edge.index)
        adjacency[edge.b].append(edge.index)

    graph = Graph(
        edges=edges,
        adjacency=dict(adjacency),
        node_points=node_points,
        node_station_names={
            node: sorted(names) for node, names in node_station_names.items()
        },
        node_station_groups={
            node: sorted(groups) for node, groups in node_station_groups.items()
        },
    )
    diagnostics = {
        "station_group_count": len(station_group_names),
        "matched_station_group_count": len(station_group_nodes),
        "duplicate_geometry_count": duplicate_geometry_count,
        "intra_station_edge_count": intra_station_count,
        "parallel_semantic_variants": sum(
            max(0, edge.parallel_variants - 1) for edge in edges
        ),
    }
    return graph, diagnostics


def source_key_rows(section_features: list[dict]) -> list[dict]:
    grouped: dict[tuple[str, str], list[int]] = defaultdict(list)
    for index, feature in enumerate(section_features):
        props = feature["properties"]
        grouped[(props["N02_004"], props["N02_003"])].append(index)
    rows = []
    for (source_operator, source_line), indices in sorted(grouped.items()):
        canonical_line, canonical_operator = canonical_line_operator(
            source_line, source_operator
        )
        is_swapped = (source_line, source_operator) == SWAPPED_SOURCE_KEY
        rows.append(
            {
                "source_operator": source_operator,
                "source_line": source_line,
                "source_section_count": len(indices),
                "source_section_indices": json.dumps(indices, ensure_ascii=False),
                "canonical_operator": canonical_operator,
                "canonical_line": canonical_line,
                "canonical_key": canonical_key(canonical_operator, canonical_line),
                "source_key_status": "swapped_column_alias" if is_swapped else "canonical",
            }
        )
    return rows


def load_overrides(path: Path) -> dict[str, dict]:
    records = load_json(path, [])
    return {
        canonical_key(record["operator"], record["line"]): record
        for record in records
    }


def load_osm_routes(path: Path) -> dict[str, dict]:
    records = load_json(path, [])
    result = {}
    for record in records:
        line, operator = canonical_line_operator(
            record["n02_003"], record["n02_004"]
        )
        result[canonical_key(operator, line)] = record
    return result


def load_research(path: Path) -> dict[str, dict]:
    payload = load_json(path, {"records": []})
    return {record["canonical_key"]: record for record in payload.get("records", [])}


def load_line_colours(path: Path) -> dict[tuple[str, str], dict]:
    result = {}
    for record in load_json(path, []):
        line, operator = canonical_line_operator(
            record["line_n02"], record["operator_n02"]
        )
        result[(operator, line)] = record
    return result


def load_operator_colours(path: Path) -> dict[str, dict]:
    return {
        record["operator_n02"]: record for record in load_json(path, [])
    }


def colour_fields(
    operator: str,
    line: str,
    line_colour: dict | None,
    operator_colour: dict | None,
    osm: dict | None,
) -> dict:
    exact = line_colour.get("color") if line_colour else None
    confidence = line_colour.get("confidence", "none") if line_colour else "none"
    notes = line_colour.get("notes", "") if line_colour else ""
    if exact and confidence == "high":
        status = "official_hex"
        authority = "operator_official"
    elif exact and confidence == "medium":
        status = "documented_line_color"
        authority = "secondary_officially_documented"
    elif exact:
        status = "candidate_line_color"
        authority = "community_or_coarse"
    elif line_colour and "未制定" in notes:
        status = "officially_not_defined"
        authority = "operator_has_no_defined_line_color"
    elif line_colour:
        status = "official_hex_not_found"
        authority = "researched_but_unconfirmed"
    else:
        status = "no_line_level_record"
        authority = "not_researched_at_line_level"

    operator_hex = operator_colour.get("color") if operator_colour else None
    osm_hex = osm.get("colour") if osm else None
    osm_confidence = osm.get("confidence", "none") if osm else "none"
    osm_overlap = float(osm.get("overlap_frac_of_n02_line") or 0) if osm else 0.0
    osm_usable = bool(
        osm_hex
        and (
            osm_confidence == "high"
            or (osm_confidence == "medium" and osm_overlap >= 0.5)
        )
    )
    if exact:
        render_hex = exact
        render_dark = line_colour.get("color_dark") or exact
        render_basis = {
            "high": "official_line_color",
            "medium": "documented_line_color",
            "low": "candidate_line_color",
        }.get(confidence, "line_color")
        render_source = line_colour.get("source_url", "")
    elif status == "officially_not_defined" and operator_hex:
        render_hex = operator_hex
        render_dark = operator_colour.get("color_dark") or operator_hex
        render_basis = "operator_color_fallback_no_official_line_color"
        render_source = operator_colour.get("source_url", "")
    elif osm_usable:
        render_hex = osm_hex
        render_dark = osm_hex
        render_basis = "osm_line_color_candidate_fallback"
        render_source = (
            f"https://www.openstreetmap.org/{osm['source_relation']}"
            if osm.get("source_relation")
            else ""
        )
    elif osm_hex:
        render_hex = osm_hex
        render_dark = osm_hex
        render_basis = "osm_color_candidate_fallback"
        render_source = (
            f"https://www.openstreetmap.org/{osm['source_relation']}"
            if osm.get("source_relation")
            else ""
        )
    elif operator_hex:
        render_hex = operator_hex
        render_dark = operator_colour.get("color_dark") or operator_hex
        render_basis = "operator_color_fallback"
        render_source = operator_colour.get("source_url", "")
    else:
        render_hex = "#8a8f98"
        render_dark = "#8a8f98"
        render_basis = "neutral_fallback"
        render_source = ""

    return {
        "official_line_color_hex": exact if confidence == "high" else "",
        "line_color_hex": exact or "",
        "line_color_dark_hex": line_colour.get("color_dark", "") if line_colour else "",
        "line_color_status": status,
        "line_color_authority": authority,
        "line_color_confidence": confidence,
        "line_code": line_colour.get("line_code", "") if line_colour else "",
        "line_color_source": line_colour.get("source", "") if line_colour else "",
        "line_color_source_url": line_colour.get("source_url", "") if line_colour else "",
        "line_color_notes": notes,
        "operator_color_hex": operator_hex or "",
        "operator_color_confidence": operator_colour.get("confidence", "none") if operator_colour else "none",
        "operator_color_source_url": operator_colour.get("source_url", "") if operator_colour else "",
        "osm_color_candidate_hex": osm_hex or "",
        "osm_color_candidate_confidence": osm_confidence,
        "osm_color_candidate_overlap": osm_overlap,
        "render_color_hex": render_hex,
        "render_color_dark_hex": render_dark,
        "render_color_basis": render_basis,
        "render_color_source_url": render_source,
    }


def classify_lines(
    section_features,
    station_features,
    overrides,
    osm_routes,
    network_research,
    line_colours,
    operator_colours,
):
    sections_by_line: dict[tuple[str, str], list[tuple[int, dict]]] = defaultdict(list)
    raw_aliases: dict[tuple[str, str], set[str]] = defaultdict(set)
    for index, feature in enumerate(section_features):
        props = feature["properties"]
        source_line, source_operator = props["N02_003"], props["N02_004"]
        line, operator = canonical_line_operator(source_line, source_operator)
        sections_by_line[(operator, line)].append((index, feature))
        raw_aliases[(operator, line)].add(f"{source_operator}{KEY_SEPARATOR}{source_line}")

    stations_by_line: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for feature in station_features:
        props = feature["properties"]
        line, operator = canonical_line_operator(props["N02_003"], props["N02_004"])
        stations_by_line[(operator, line)].append(feature)

    rows = []
    for (operator, line), sections in sorted(sections_by_line.items()):
        stations = stations_by_line.get((operator, line), [])
        graph, diagnostics = build_graph(sections, stations)
        components = connected_components(graph)
        metrics = graph_metrics(graph, components)
        auto_class = auto_shape_class(metrics)
        main_nodes, main_edge_list = choose_main_path(graph, components[0])
        main_edges = set(main_edge_list)
        main_node_set = set(main_nodes)
        branch_parts = off_main_parts(graph, components, main_edges, main_node_set)

        props = [feature["properties"] for _index, feature in sections]
        class_counts = Counter(row["N02_001"] for row in props)
        institution_counts = Counter(row["N02_002"] for row in props)
        railway_class = class_counts.most_common(1)[0][0]
        institution = institution_counts.most_common(1)[0][0]
        kind = render_kind(operator, line, railway_class, institution)
        total_length_km = sum(
            polyline_length_m(feature["geometry"]["coordinates"])
            for _index, feature in sections
        ) / 1000
        semantic_length_km = sum(edge.length_m for edge in graph.edges) / 1000
        station_groups = {
            feature["properties"]["N02_005g"] for feature in stations
        }
        station_names = sorted(
            {feature["properties"]["N02_005"] for feature in stations}
        )
        key = canonical_key(operator, line)
        override = overrides.get(key)
        osm = osm_routes.get(key)
        research = network_research.get(key)

        if len(main_nodes) >= 2:
            computed_main_path = (
                f"{label_node(graph, main_nodes[0])} → "
                f"{label_node(graph, main_nodes[-1])}"
            )
        elif auto_class == "loop":
            computed_main_path = "闭环（无端点）"
        else:
            computed_main_path = "无法自动确定"

        effective_branch_parts = (
            override.get("branch_parts", branch_parts) if override else branch_parts
        )
        shape_class = override.get("shape_class", auto_class) if override else auto_class
        main_path = override.get("main_path", computed_main_path) if override else computed_main_path
        network_linear_correction = bool(
            not override
            and research
            and research.get("confirmation") == "route_endpoints_supported"
            and metrics["component_count"] == 1
            and auto_class
            in {
                "branched_terminal",
                "branch_rejoins",
                "complex_multicycle",
                "complex_loop",
            }
        )
        if network_linear_correction:
            shape_class = "ordinary_linear"
            effective_branch_parts = []
        source_urls = list(override.get("source_urls", [])) if override else []
        if osm and osm.get("matched_relation"):
            relation = osm["matched_relation"].split("/")[-1]
            source_urls.append(f"https://www.openstreetmap.org/relation/{relation}")
        if research and research.get("page_url"):
            source_urls.append(research["page_url"])
        source_urls = list(dict.fromkeys(source_urls))
        review_status = topology_review_status(
            shape_class, effective_branch_parts, override, research
        )
        colours = colour_fields(
            operator,
            line,
            line_colours.get((operator, line)),
            operator_colours.get(operator),
            osm,
        )

        notes = []
        if override and override.get("notes"):
            notes.append(override["notes"])
        if diagnostics["parallel_semantic_variants"]:
            notes.append(
                f"站区收缩后仍合并 {diagnostics['parallel_semantic_variants']} 条平行候选边"
            )
        if len(raw_aliases[(operator, line)]) > 1:
            notes.append("包含 N02 线路名/运营者列互换的源数据修正")
        if network_linear_correction:
            notes.append(
                "网络资料明确为单一端到端线路；N02 自动枝保留在 auto_branch_parts_json，按站场/多股道候选处理"
            )

        row = {
            "canonical_key": key,
            "operator": operator,
            "line": line,
            "railway_class_code": railway_class,
            "railway_class": RAILWAY_CLASS.get(railway_class, "未知"),
            "institution_code": institution,
            "render_kind": kind,
            "detail_profile": detail_profile(kind, total_length_km, len(station_groups)),
            "shape_class": shape_class,
            "auto_shape_class": auto_class,
            "review_status": review_status,
            **colours,
            "main_path": main_path,
            "main_path_km": round(
                sum(graph.edges[index].length_m for index in main_edges) / 1000, 3
            ),
            "branch_count": len(effective_branch_parts),
            "branch_parts_json": json.dumps(
                effective_branch_parts, ensure_ascii=False, separators=(",", ":")
            ),
            "auto_branch_count": len(branch_parts),
            "auto_branch_parts_json": json.dumps(
                branch_parts, ensure_ascii=False, separators=(",", ":")
            ),
            "component_count": metrics["component_count"],
            "cycle_rank": metrics["cycle_rank"],
            "terminal_count": metrics["terminal_count"],
            "junction_count": metrics["junction_count"],
            "max_degree": metrics["max_degree"],
            "n02_section_count": len(sections),
            "n02_length_km": round(total_length_km, 3),
            "semantic_length_km": round(semantic_length_km, 3),
            "station_feature_count": len(stations),
            "station_group_count": len(station_groups),
            "station_name_count": len(station_names),
            "intra_station_edge_count": diagnostics["intra_station_edge_count"],
            "parallel_semantic_variants": diagnostics["parallel_semantic_variants"],
            "raw_source_keys": json.dumps(
                sorted(raw_aliases[(operator, line)]), ensure_ascii=False
            ),
            "osm_relation": osm.get("matched_relation", "") if osm else "",
            "osm_relation_name": osm.get("relation_name", "") if osm else "",
            "osm_overlap_fraction": osm.get("overlap_frac_of_n02_line", "") if osm else "",
            "network_source_urls": json.dumps(source_urls, ensure_ascii=False),
            "web_query_status": research.get("status", "not_required") if research else "not_required",
            "web_page_title": research.get("page_title", "") if research else "",
            "web_page_url": research.get("page_url", "") if research else "",
            "web_confirmation": research.get("confirmation", "") if research else "",
            "web_evidence_json": json.dumps(
                research.get("evidence", []) if research else [],
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            "notes": "；".join(notes),
        }
        rows.append(row)
    return rows


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def format_counter(counter: Counter) -> str:
    return "\n".join(f"| `{key}` | {value} |" for key, value in sorted(counter.items()))


def write_summary(path: Path, source_rows: list[dict], rows: list[dict]) -> None:
    shape_counts = Counter(row["shape_class"] for row in rows)
    auto_counts = Counter(row["auto_shape_class"] for row in rows)
    profile_counts = Counter(row["detail_profile"] for row in rows)
    review_counts = Counter(row["review_status"] for row in rows)
    web_counts = Counter(row["web_confirmation"] for row in rows if row["web_confirmation"])
    web_queried = sum(row["web_query_status"] == "queried" for row in rows)
    colour_status_counts = Counter(row["line_color_status"] for row in rows)
    render_basis_counts = Counter(row["render_color_basis"] for row in rows)
    complex_rows = [
        row
        for row in rows
        if row["shape_class"] not in {"ordinary_linear"}
        or row["review_status"].startswith("needs_")
    ]
    complex_rows.sort(
        key=lambda row: (
            not row["review_status"].startswith("needs_"),
            -row["cycle_rank"],
            -row["branch_count"],
            row["operator"],
            row["line"],
        )
    )
    sample_lines = []
    for row in complex_rows[:80]:
        sample_lines.append(
            "| {operator} | {line} | `{shape}` | `{auto}` | {main} | {branches} | `{status}` |".format(
                operator=row["operator"],
                line=row["line"],
                shape=row["shape_class"],
                auto=row["auto_shape_class"],
                main=row["main_path"].replace("|", "/"),
                branches=row["branch_count"],
                status=row["review_status"],
            )
        )
    text = f"""# N02-25 日本铁路线路形状分类（第一阶段）

本目录是日本铁路重建的第一阶段输入：先确定线路形状、主干与支线，再为不同类型选择读取、重建和渲染算法。这里不直接修改最终铁路几何。

## 覆盖范围

- N02 原始 `(N02_004 运营者, N02_003 线路名)` 键：**{len(source_rows)}**。
- 修正 N02 已知的 1 条“线路名/运营者列互换”记录后，真实规范线路：**{len(rows)}**。
- 分类表总行数：**{len(rows)}**，与规范线路数完全一致。
- 原始键审计表：`n02-source-line-keys.csv`；规范分类主表：`n02-line-shape-classification.csv`。
- 非普通/异常拓扑候选联网查询：**{web_queried}** 条；每条查询结果、页面 URL 和证据句已回写主表，完整抓取审计在 `network-line-shape-research.json`。

## 分类原则

1. 先按每条 N02 线路独立建图。
2. 把同一 `N02_005g` 车站组内的站台区段收缩成一个语义节点。
3. 收缩后连接相同两点的平行边只用于“候选轨道”统计，不当作客运支线。
4. `auto_shape_class` 只陈述 N02 拓扑；`shape_class` 可由运营者资料覆写。
5. 普通线的主干是最大连通分量内、终点之间网络距离最长的路径；剩余部分拆成终端支线、再次并入支线、附着环或断开的分量。
6. 环线不强行切开成普通 vector line；带尾巴的环、分出后并入、多环网络各自保留独立类别。
7. `short_tram`、`short_funicular`、`short_line` 和 `compact_urban` 是后续细节阈值的输入，不与长距离铁路共用简化/圆角/缩放规则。

## 建议形状分类

| 类别 | 线路数 |
| --- | ---: |
{format_counter(shape_counts)}

## 纯 N02 自动分类（覆写前）

| 类别 | 线路数 |
| --- | ---: |
{format_counter(auto_counts)}

## 细节规则档位

| 档位 | 线路数 |
| --- | ---: |
{format_counter(profile_counts)}

## 复核状态

| 状态 | 线路数 |
| --- | ---: |
{format_counter(review_counts)}

`network_checked_topology_conflict` 表示网络页面把线路描述为明确的端到端线路，但 N02 仍出现分枝，优先按“站场多股道/几何错误”检查。`network_checked_complex_candidate` 表示网络证据也出现支线、分岔、环、分段等复杂信息，但仍需把具体证据与 N02 候选枝逐点对齐。`network_checked_needs_decision` 表示已经实际联网查询，证据尚不足以自动决定，不能直接进入重建。

## 联网证据结果

| 证据结果 | 线路数 |
| --- | ---: |
{format_counter(web_counts)}

## 线路颜色

`official_line_color_hex` 只在运营者官方直接发布或可从官方数字资产精确取得 HEX 时填写；`line_color_hex` 可包含有资料依据但权威等级较低的线路色。最终渲染值是 `render_color_hex`，其回退依据必须同时读取 `render_color_basis`，不得把企业色或 OSM 候选色误称为官方线路色。完整颜色审计表为 `n02-official-line-colours.csv`，来源说明为 `../colours/sources.md`。

| 线路色状态 | 线路数 |
| --- | ---: |
{format_counter(colour_status_counts)}

| 渲染颜色依据 | 线路数 |
| --- | ---: |
{format_counter(render_basis_counts)}

## 复杂与待复核线路（前 80 条）

完整清单请以 CSV 为准。

| 运营者 | 线路 | 建议类别 | N02 自动类别 | 主干 | 分段数 | 状态 |
| --- | --- | --- | --- | --- | ---: | --- |
{chr(10).join(sample_lines)}

## 后续算法路由

| 分类/档位 | 数据读取与重建策略 |
| --- | --- |
| `ordinary_linear` | 单一有序主干；允许一个 vector line 串联全部站，站区选择最直/最顺且靠近站端的候选轨道。 |
| `branched_terminal` | 主干与每条终端支线分别输出 vector line；共享区段只保留一次物理中心线。 |
| `branch_rejoins` | 主干与绕行支线分别输出；两个接入点都必须落在主干，不允许把支线交织进主站序。 |
| `loop` | 使用闭合链和循环站序；禁止任意端点化导致最后一站到第一站断开。 |
| `loop_with_tail` / `complex_loop` | 环和尾线/分支分开建模；需要有方向的循环站序与显式接入点。 |
| `reversing_linear` | 主站序仍是端到端线路，但折返点作为有方向的路径事件保留；禁止把折返轨道误判为客运支线。 |
| `loop_and_switchbacks_suspended` | 同时保存环线、折返点与区段运营状态；空间相邻但运营不连通的边不得自动吸附。 |
| `homonymous_lines` | 先按铁路类别、空间连通和官方端点拆成独立线路，再分别进入普通线/短线算法；禁止只凭运营者与线路名合并。 |
| `disconnected` | 不自动跨空白连线；先判断是合法分段、停运/移管造成的断开，还是 N02/构建缺陷。 |
| `short_tram` / `short_line` | 使用更小的简化阈值、更弱圆角、更高顶点保留率和更早出现的站点/文字 LOD。 |

## 重建命令

```bash
python3 app/scripts/railway/classify-japan-line-shapes.py
python3 app/scripts/railway/build-japan-station-network.py
```

第一个脚本生成线路分类，第二个脚本据此生成公司级车站、逐站铁路邻接和跨公司换乘关系。两者只依赖 Python 标准库，并直接读取压缩包中的 UTF-8 GeoJSON。车站关系字段和样式定义见 `STATION_NETWORK.md`。
"""
    path.write_text(text, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--osm", type=Path, default=DEFAULT_OSM)
    parser.add_argument("--overrides", type=Path, default=DEFAULT_OVERRIDES)
    parser.add_argument("--research", type=Path, default=DEFAULT_RESEARCH)
    parser.add_argument("--line-colours", type=Path, default=DEFAULT_LINE_COLOURS)
    parser.add_argument("--operator-colours", type=Path, default=DEFAULT_OPERATOR_COLOURS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    section_features = load_zip_geojson(args.source, SECTION_MEMBER)
    station_features = load_zip_geojson(args.source, STATION_MEMBER)
    source_rows = source_key_rows(section_features)
    overrides = load_overrides(args.overrides)
    osm_routes = load_osm_routes(args.osm)
    network_research = load_research(args.research)
    line_colours = load_line_colours(args.line_colours)
    operator_colours = load_operator_colours(args.operator_colours)
    rows = classify_lines(
        section_features,
        station_features,
        overrides,
        osm_routes,
        network_research,
        line_colours,
        operator_colours,
    )

    write_csv(args.output / "n02-source-line-keys.csv", source_rows)
    write_csv(args.output / "n02-line-shape-classification.csv", rows)
    colour_columns = [
        "canonical_key", "operator", "line", "official_line_color_hex",
        "line_color_hex", "line_color_dark_hex", "line_color_status",
        "line_color_authority", "line_color_confidence", "line_code",
        "line_color_source", "line_color_source_url", "line_color_notes",
        "operator_color_hex", "operator_color_confidence",
        "operator_color_source_url", "osm_color_candidate_hex",
        "osm_color_candidate_confidence", "osm_color_candidate_overlap",
        "render_color_hex", "render_color_dark_hex", "render_color_basis",
        "render_color_source_url",
    ]
    write_csv(
        args.output / "n02-official-line-colours.csv",
        [{column: row[column] for column in colour_columns} for row in rows],
    )
    write_summary(args.output / "README.md", source_rows, rows)

    print(
        json.dumps(
            {
                "source_line_keys": len(source_rows),
                "canonical_lines": len(rows),
                "shape_classes": Counter(row["shape_class"] for row in rows),
                "review_status": Counter(row["review_status"] for row in rows),
                "output": str(args.output),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
