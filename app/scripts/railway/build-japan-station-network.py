#!/usr/bin/env python3
"""Build an operator-scoped station adjacency network from N02-25.

The output deliberately separates three identities:

* physical station: N02_005g, shared by interchange operators;
* operator station: operator + N02_005g, the stable station identity here;
* line station: operator + line + N02_005g, used for topology roles.

Railway adjacency and cross-operator interchange are not mixed.  Every railway
connection is emitted in both directions so each station row can enumerate its
own neighbours without a second undirected-edge lookup.
"""

from __future__ import annotations

import argparse
import csv
import heapq
import importlib.util
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
CLASSIFIER_PATH = SCRIPT_DIR / "classify-japan-line-shapes.py"
SPEC = importlib.util.spec_from_file_location("japan_line_shapes", CLASSIFIER_PATH)
SHAPES = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = SHAPES
SPEC.loader.exec_module(SHAPES)

DEFAULT_SOURCE = SHAPES.DEFAULT_SOURCE
DEFAULT_CLASSIFICATION = SHAPES.DEFAULT_OUTPUT / "n02-line-shape-classification.csv"
DEFAULT_OVERRIDES = SHAPES.DEFAULT_OVERRIDES
DEFAULT_OUTPUT = SHAPES.DEFAULT_OUTPUT
UID_SEPARATOR = SHAPES.KEY_SEPARATOR


def station_uid(operator: str, group: str) -> str:
    return f"{operator}{UID_SEPARATOR}{group}"


def line_station_uid(operator: str, line: str, group: str) -> str:
    return f"{operator}{UID_SEPARATOR}{line}{UID_SEPARATOR}{group}"


def connection_uid(operator: str, line: str, group_a: str, group_b: str) -> str:
    a, b = sorted((group_a, group_b))
    return f"{operator}{UID_SEPARATOR}{line}{UID_SEPARATOR}{a}{UID_SEPARATOR}{b}"


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as output:
        if not rows:
            return
        writer = csv.DictWriter(output, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def canonical_feature_key(feature: dict) -> tuple[str, str]:
    props = feature["properties"]
    line, operator = SHAPES.canonical_line_operator(
        props["N02_003"], props["N02_004"]
    )
    return operator, line


def bridge_edges(graph) -> set[int]:
    """Return graph bridges; every non-bridge edge belongs to a cycle."""
    timer = 0
    entered: dict[tuple, int] = {}
    low: dict[tuple, int] = {}
    bridges: set[int] = set()

    def visit(node, parent_edge: int | None) -> None:
        nonlocal timer
        timer += 1
        entered[node] = low[node] = timer
        for edge_index in graph.adjacency.get(node, []):
            if edge_index == parent_edge:
                continue
            edge = graph.edges[edge_index]
            other = edge.b if edge.a == node else edge.a
            if other not in entered:
                visit(other, edge_index)
                low[node] = min(low[node], low[other])
                if low[other] > entered[node]:
                    bridges.add(edge_index)
            else:
                low[node] = min(low[node], entered[other])

    for node in graph.adjacency:
        if node not in entered:
            visit(node, None)
    return bridges


def first_station_paths(graph, origin) -> dict[tuple, tuple[float, list[int]]]:
    """Shortest paths from one station node, stopping at every next station."""
    distances = {origin: 0.0}
    previous: dict[tuple, tuple[tuple, int]] = {}
    heap = [(0.0, origin)]
    targets: dict[tuple, tuple[float, list[int]]] = {}
    while heap:
        distance, node = heapq.heappop(heap)
        if distance != distances.get(node):
            continue
        if node != origin and graph.node_station_groups.get(node):
            path_edges: list[int] = []
            current = node
            while current != origin:
                prior, edge_index = previous[current]
                path_edges.append(edge_index)
                current = prior
            targets[node] = distance, list(reversed(path_edges))
            continue
        for edge_index in graph.adjacency.get(node, []):
            edge = graph.edges[edge_index]
            other = edge.b if edge.a == node else edge.a
            candidate = distance + edge.length_m
            if candidate < distances.get(other, float("inf")):
                distances[other] = candidate
                previous[other] = (node, edge_index)
                heapq.heappush(heap, (candidate, other))
    return targets


def reversing_station_names(override: dict | None) -> set[str]:
    names: set[str] = set()
    if not override:
        return names
    for part in override.get("branch_parts", []):
        if "revers" in str(part.get("type", "")):
            names.update(part.get("stations", []))
    return names


def primary_style(tags: set[str]) -> str:
    priority = [
        "reversing_station",
        "branch_origin",
        "multi_line_station",
        "multi_operator_interchange",
        "loop_station",
        "branch_terminal",
        "line_terminal",
        "disconnected_station",
        "isolated_or_unmatched",
        "ordinary_station",
    ]
    return next((style for style in priority if style in tags), "ordinary_station")


def build_network(section_features, station_features, line_rows, overrides):
    sections_by_line: dict[tuple[str, str], list[tuple[int, dict]]] = defaultdict(list)
    stations_by_line: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for index, feature in enumerate(section_features):
        sections_by_line[canonical_feature_key(feature)].append((index, feature))
    for feature in station_features:
        stations_by_line[canonical_feature_key(feature)].append(feature)

    line_info = {(row["operator"], row["line"]): row for row in line_rows}
    override_info = {
        (row["operator"], row["line"]): row for row in overrides
    }

    station_meta: dict[str, dict] = {}
    operators_by_group: dict[str, set[str]] = defaultdict(set)
    for feature in station_features:
        props = feature["properties"]
        operator, line = canonical_feature_key(feature)
        group = str(props["N02_005g"])
        uid = station_uid(operator, group)
        meta = station_meta.setdefault(
            uid,
            {
                "station_uid": uid,
                "operator": operator,
                "group": group,
                "names": set(),
                "codes": set(),
                "lines": set(),
                "points": [],
            },
        )
        meta["names"].add(props["N02_005"])
        meta["codes"].add(str(props["N02_005c"]))
        meta["lines"].add(line)
        meta["points"].append(SHAPES.midpoint(feature["geometry"]["coordinates"]))
        operators_by_group[group].add(operator)

    undirected: dict[tuple[str, str, str, str], dict] = {}
    local_neighbors: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    local_connection_parts: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    local_cycle: set[tuple[str, str, str]] = set()

    for key in sorted(sections_by_line):
        operator, line = key
        info = line_info[key]
        graph, _diagnostics = SHAPES.build_graph(
            sections_by_line[key], stations_by_line.get(key, [])
        )
        components = SHAPES.connected_components(graph)
        _main_nodes, main_edge_list = SHAPES.choose_main_path(graph, components[0])
        main_edges = set(main_edge_list)
        cyclic_edges = set(range(len(graph.edges))) - bridge_edges(graph)
        reverse_names = reversing_station_names(override_info.get(key))

        for origin_node, origin_groups in sorted(graph.node_station_groups.items()):
            for target_node, (distance, path_edges) in first_station_paths(
                graph, origin_node
            ).items():
                target_groups = graph.node_station_groups[target_node]
                uses_cycle = any(edge in cyclic_edges for edge in path_edges)
                if path_edges and all(edge in main_edges for edge in path_edges):
                    part = "main"
                elif path_edges and all(edge not in main_edges for edge in path_edges):
                    part = "branch_candidate"
                else:
                    part = "main_branch_transition"
                tags = {part}
                if uses_cycle:
                    tags.add("cycle_segment")
                if info["shape_class"] in {
                    "reversing_linear",
                    "loop_and_switchbacks_suspended",
                }:
                    tags.add("reversing_route")
                if info["shape_class"] == "disconnected":
                    tags.add("disconnected_line_component")

                for group_a in origin_groups:
                    for group_b in target_groups:
                        if group_a == group_b:
                            continue
                        a, b = sorted((group_a, group_b))
                        edge_key = (operator, line, a, b)
                        candidate = {
                            "connection_uid": connection_uid(operator, line, a, b),
                            "operator": operator,
                            "line": line,
                            "line_shape_type": info["shape_class"],
                            "line_auto_shape_type": info["auto_shape_class"],
                            "line_review_status": info["review_status"],
                            "official_line_color_hex": info["official_line_color_hex"],
                            "line_color_hex": info["line_color_hex"],
                            "line_color_status": info["line_color_status"],
                            "line_color_authority": info["line_color_authority"],
                            "line_color_confidence": info["line_color_confidence"],
                            "line_color_source_url": info["line_color_source_url"],
                            "render_color_hex": info["render_color_hex"],
                            "render_color_dark_hex": info["render_color_dark_hex"],
                            "render_color_basis": info["render_color_basis"],
                            "render_color_source_url": info["render_color_source_url"],
                            "group_a": a,
                            "group_b": b,
                            "distance_km": round(distance / 1000, 4),
                            "connection_type_tags": sorted(tags),
                            "path_edge_count": len(path_edges),
                            "contains_cycle_edge": uses_cycle,
                            "topology_source": "N02_station_contracted_graph",
                        }
                        existing = undirected.get(edge_key)
                        if not existing or candidate["distance_km"] < existing["distance_km"]:
                            undirected[edge_key] = candidate

        # Apply name-based reversal roles even if a signal box is not an N02 station.
        for feature in stations_by_line.get(key, []):
            props = feature["properties"]
            group = str(props["N02_005g"])
            local_key = (operator, line, group)
            if props["N02_005"] in reverse_names:
                local_connection_parts[local_key].add("reversing_station")

    # Calculate local degrees and segment roles from the final unique edge set.
    for edge in undirected.values():
        operator, line = edge["operator"], edge["line"]
        a, b = edge["group_a"], edge["group_b"]
        local_neighbors[(operator, line, a)].add(b)
        local_neighbors[(operator, line, b)].add(a)
        for group in (a, b):
            local_connection_parts[(operator, line, group)].update(
                edge["connection_type_tags"]
            )
            if edge["contains_cycle_edge"]:
                local_cycle.add((operator, line, group))

    local_roles: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    for feature in station_features:
        props = feature["properties"]
        operator, line = canonical_feature_key(feature)
        group = str(props["N02_005g"])
        key = (operator, line, group)
        degree = len(local_neighbors.get(key, set()))
        parts = local_connection_parts.get(key, set())
        if "reversing_station" in parts:
            local_roles[key].add("reversing_station")
        if degree >= 3:
            local_roles[key].add("branch_origin")
        if key in local_cycle:
            local_roles[key].add("loop_station")
        if degree == 1 and "branch_candidate" in parts:
            local_roles[key].add("branch_terminal")
        elif degree == 1:
            local_roles[key].add("line_terminal")
        elif degree == 0:
            local_roles[key].add("isolated_or_unmatched")
        elif not local_roles[key]:
            local_roles[key].add("ordinary_station")
        if line_info[(operator, line)]["shape_class"] == "disconnected":
            local_roles[key].add("disconnected_station")

    directed_rows: list[dict] = []
    neighbors_by_station: dict[str, list[dict]] = defaultdict(list)
    for edge in sorted(
        undirected.values(), key=lambda row: (row["operator"], row["line"], row["group_a"], row["group_b"])
    ):
        for from_group, to_group in (
            (edge["group_a"], edge["group_b"]),
            (edge["group_b"], edge["group_a"]),
        ):
            from_uid = station_uid(edge["operator"], from_group)
            to_uid = station_uid(edge["operator"], to_group)
            if from_uid not in station_meta or to_uid not in station_meta:
                continue
            from_meta, to_meta = station_meta[from_uid], station_meta[to_uid]
            local_from = (edge["operator"], edge["line"], from_group)
            local_to = (edge["operator"], edge["line"], to_group)
            row = {
                "connection_uid": edge["connection_uid"],
                "connection_type": "railway_adjacency",
                "from_station_uid": from_uid,
                "from_line_station_uid": line_station_uid(
                    edge["operator"], edge["line"], from_group
                ),
                "from_operator": edge["operator"],
                "from_station_name": "/".join(sorted(from_meta["names"])),
                "from_station_group": from_group,
                "to_station_uid": to_uid,
                "to_line_station_uid": line_station_uid(
                    edge["operator"], edge["line"], to_group
                ),
                "to_operator": edge["operator"],
                "to_station_name": "/".join(sorted(to_meta["names"])),
                "to_station_group": to_group,
                "line": edge["line"],
                "line_shape_type": edge["line_shape_type"],
                "line_auto_shape_type": edge["line_auto_shape_type"],
                "official_line_color_hex": edge["official_line_color_hex"],
                "line_color_hex": edge["line_color_hex"],
                "line_color_status": edge["line_color_status"],
                "line_color_authority": edge["line_color_authority"],
                "line_color_confidence": edge["line_color_confidence"],
                "line_color_source_url": edge["line_color_source_url"],
                "render_color_hex": edge["render_color_hex"],
                "render_color_dark_hex": edge["render_color_dark_hex"],
                "render_color_basis": edge["render_color_basis"],
                "render_color_source_url": edge["render_color_source_url"],
                "connection_type_tags_json": json.dumps(
                    edge["connection_type_tags"], ensure_ascii=False
                ),
                "from_line_station_style_json": json.dumps(
                    sorted(local_roles[local_from]), ensure_ascii=False
                ),
                "to_line_station_style_json": json.dumps(
                    sorted(local_roles[local_to]), ensure_ascii=False
                ),
                "distance_km": edge["distance_km"],
                "path_edge_count": edge["path_edge_count"],
                "line_review_status": edge["line_review_status"],
                "topology_source": edge["topology_source"],
            }
            directed_rows.append(row)
            neighbors_by_station[from_uid].append(
                {
                    "station_uid": to_uid,
                    "operator": edge["operator"],
                    "station_name": row["to_station_name"],
                    "station_group": to_group,
                    "line": edge["line"],
                    "line_shape_type": edge["line_shape_type"],
                    "official_line_color_hex": edge["official_line_color_hex"],
                    "line_color_hex": edge["line_color_hex"],
                    "line_color_status": edge["line_color_status"],
                    "line_color_authority": edge["line_color_authority"],
                    "line_color_confidence": edge["line_color_confidence"],
                    "line_color_source_url": edge["line_color_source_url"],
                    "render_color_hex": edge["render_color_hex"],
                    "render_color_dark_hex": edge["render_color_dark_hex"],
                    "render_color_basis": edge["render_color_basis"],
                    "render_color_source_url": edge["render_color_source_url"],
                    "connection_type_tags": edge["connection_type_tags"],
                    "distance_km": edge["distance_km"],
                    "review_status": edge["line_review_status"],
                }
            )

    station_rows: list[dict] = []
    json_stations: list[dict] = []
    interchange_rows: list[dict] = []
    for uid, meta in sorted(station_meta.items(), key=lambda item: (item[1]["operator"], item[1]["group"])):
        operator, group = meta["operator"], meta["group"]
        operators = sorted(operators_by_group[group])
        other_station_uids = [
            station_uid(other, group) for other in operators if other != operator
        ]
        lines = sorted(meta["lines"])
        line_details = []
        tags: set[str] = set()
        for line in lines:
            info = line_info[(operator, line)]
            roles = sorted(local_roles[(operator, line, group)])
            tags.update(roles)
            line_details.append(
                {
                    "line": line,
                    "line_station_uid": line_station_uid(operator, line, group),
                    "line_shape_type": info["shape_class"],
                    "line_auto_shape_type": info["auto_shape_class"],
                    "official_line_color_hex": info["official_line_color_hex"],
                    "line_color_hex": info["line_color_hex"],
                    "line_color_status": info["line_color_status"],
                    "line_color_authority": info["line_color_authority"],
                    "line_color_confidence": info["line_color_confidence"],
                    "line_color_source_url": info["line_color_source_url"],
                    "render_color_hex": info["render_color_hex"],
                    "render_color_dark_hex": info["render_color_dark_hex"],
                    "render_color_basis": info["render_color_basis"],
                    "render_color_source_url": info["render_color_source_url"],
                    "station_roles": roles,
                    "review_status": info["review_status"],
                }
            )
        if len(lines) >= 2:
            tags.add("multi_line_station")
        if len(operators) >= 2:
            tags.add("multi_operator_interchange")
        if not tags:
            tags.add("ordinary_station")
        points = meta["points"]
        lon = sum(point[0] for point in points) / len(points)
        lat = sum(point[1] for point in points) / len(points)
        neighbors = sorted(
            neighbors_by_station.get(uid, []),
            key=lambda row: (row["line"], row["station_uid"]),
        )
        interchange_connections = []
        for other_uid in other_station_uids:
            other_meta = station_meta[other_uid]
            destination_lines = [
                {
                    "line": other_line,
                    "line_station_uid": line_station_uid(
                        other_meta["operator"], other_line, group
                    ),
                    "line_shape_type": line_info[(other_meta["operator"], other_line)]["shape_class"],
                    "official_line_color_hex": line_info[(other_meta["operator"], other_line)]["official_line_color_hex"],
                    "line_color_hex": line_info[(other_meta["operator"], other_line)]["line_color_hex"],
                    "line_color_status": line_info[(other_meta["operator"], other_line)]["line_color_status"],
                    "line_color_authority": line_info[(other_meta["operator"], other_line)]["line_color_authority"],
                    "line_color_confidence": line_info[(other_meta["operator"], other_line)]["line_color_confidence"],
                    "line_color_source_url": line_info[(other_meta["operator"], other_line)]["line_color_source_url"],
                    "render_color_hex": line_info[(other_meta["operator"], other_line)]["render_color_hex"],
                    "render_color_dark_hex": line_info[(other_meta["operator"], other_line)]["render_color_dark_hex"],
                    "render_color_basis": line_info[(other_meta["operator"], other_line)]["render_color_basis"],
                    "render_color_source_url": line_info[(other_meta["operator"], other_line)]["render_color_source_url"],
                    "review_status": line_info[(other_meta["operator"], other_line)]["review_status"],
                }
                for other_line in sorted(other_meta["lines"])
            ]
            interchange = {
                "station_uid": other_uid,
                "operator": other_meta["operator"],
                "station_name": "/".join(sorted(other_meta["names"])),
                "physical_station_group": group,
                "connected_lines": destination_lines,
                "connection_type": "physical_interchange",
                "source": "shared_N02_005g",
            }
            interchange_connections.append(interchange)
            interchange_rows.append(
                {
                    "interchange_uid": f"{group}{UID_SEPARATOR}{min(operator, other_meta['operator'])}{UID_SEPARATOR}{max(operator, other_meta['operator'])}",
                    "from_station_uid": uid,
                    "from_operator": operator,
                    "from_station_name": "/".join(sorted(meta["names"])),
                    "to_station_uid": other_uid,
                    "to_operator": other_meta["operator"],
                    "to_station_name": interchange["station_name"],
                    "physical_station_group": group,
                    "to_connected_lines_json": json.dumps(destination_lines, ensure_ascii=False, separators=(",", ":")),
                    "connection_type": "physical_interchange",
                    "source": "shared_N02_005g",
                }
            )
        connected_station_uids = {
            row["station_uid"] for row in neighbors
        } | set(other_station_uids)
        record = {
            "station_uid": uid,
            "operator": operator,
            "station_name": "/".join(sorted(meta["names"])),
            "physical_station_group": group,
            "n02_station_codes": sorted(meta["codes"]),
            "longitude": round(lon, 7),
            "latitude": round(lat, 7),
            "station_style": primary_style(tags),
            "station_style_tags": sorted(tags),
            "line_count": len(lines),
            "connected_lines": line_details,
            "rail_neighbor_count": len({row["station_uid"] for row in neighbors}),
            "rail_connections": neighbors,
            "interchange_neighbor_count": len(other_station_uids),
            "interchange_connections": interchange_connections,
            "total_connected_station_count": len(connected_station_uids),
            "physical_station_operator_count": len(operators),
            "physical_station_operators": operators,
            "interchange_station_uids": other_station_uids,
            "identity_rule": "operator+N02_005g",
        }
        json_stations.append(record)
        station_rows.append(
            {
                **{key: value for key, value in record.items() if key not in {
                    "n02_station_codes", "station_style_tags", "connected_lines",
                    "rail_connections", "interchange_connections", "physical_station_operators",
                    "interchange_station_uids",
                }},
                "n02_station_codes_json": json.dumps(record["n02_station_codes"], ensure_ascii=False),
                "station_style_tags_json": json.dumps(record["station_style_tags"], ensure_ascii=False),
                "connected_lines_json": json.dumps(record["connected_lines"], ensure_ascii=False, separators=(",", ":")),
                "rail_connections_json": json.dumps(record["rail_connections"], ensure_ascii=False, separators=(",", ":")),
                "interchange_connections_json": json.dumps(record["interchange_connections"], ensure_ascii=False, separators=(",", ":")),
                "physical_station_operators_json": json.dumps(record["physical_station_operators"], ensure_ascii=False),
                "interchange_station_uids_json": json.dumps(record["interchange_station_uids"], ensure_ascii=False),
            }
        )

    payload = {
        "schema_version": 1,
        "identity_rule": "operator+N02_005g",
        "rail_connections_are_directed": True,
        "interchanges_are_not_rail_connections": True,
        "stations": json_stations,
        "connections": directed_rows,
        "interchanges": interchange_rows,
    }
    return station_rows, directed_rows, interchange_rows, payload


def write_readme(
    path: Path, stations: list[dict], connections: list[dict], interchanges: list[dict]
) -> None:
    style_counts = Counter(row["station_style"] for row in stations)
    lines = "\n".join(f"| `{key}` | {value} |" for key, value in sorted(style_counts.items()))
    text = f"""# 车站级铁路网络关系

本目录在全量线路分类基础上增加车站级关系。车站身份使用 `运营公司 + N02_005g`，所以不同公司的同一物理换乘站不会被合并；它们通过 `physical_station_group` 和 `interchange_station_uids_json` 相互引用。

- 公司车站实体：**{len(stations)}**
- 有向铁路相邻关系：**{len(connections)}**（每条无向邻接分别从两端输出）
- 有向跨公司换乘关系：**{len(interchanges)}**（不同公司的车站实体保持分离）
- `n02-station-network.csv`：每个公司车站一行，内含线路、线路类型、样式、相邻站和跨公司换乘关系。
- `n02-station-connections.csv`：每个“本站 → 相邻站 → 连接线路”一行，适合查询和构图。
- `n02-station-interchanges.csv`：同一物理站内不同公司车站之间的换乘关系；不混入铁路轨道邻接。
- `n02-station-network.json`：上述两张表的结构化版本。

## 车站主样式

| 样式 | 数量 |
| --- | ---: |
{lines}

`station_style` 是按优先级选出的单一渲染样式；完整语义必须读取 `station_style_tags_json`。例如同一站可以同时是 `multi_line_station`、`multi_operator_interchange` 和 `branch_origin`。

主要标签含义：`ordinary_station` 普通站、`line_terminal` 线路端点、`branch_origin` 分支起点、`branch_terminal` 支线端点、`multi_line_station` 同公司多线站、`multi_operator_interchange` 多公司换乘站、`loop_station` 环状区段车站、`reversing_station` 折返车站。`isolated_or_unmatched` 表示该线路内没有另一个 N02 车站，但仍可能通过 `interchange_connections_json` 与其他公司车站连接。

每个 `connected_lines` 和铁路连接都带有具体色号：`official_line_color_hex` 仅表示运营者官方直接确认的 HEX，`line_color_hex` 是有来源的线路级色号，`render_color_hex` 是实际渲染值。使用回退值时必须同时保留 `render_color_basis`，不能把企业色、OSM 候选色或中性色称为官方线路色。暗色底图可使用独立的 `render_color_dark_hex`，不会覆盖原始官方色号。

## 关系和置信度

铁路邻接来自 N02 站区收缩图。`line_shape_type` 是第一阶段结合网络资料后的线路类别；`line_auto_shape_type` 保留纯 N02 判定。`line_review_status` 不是 `official_verified` / `network_verified` 时，邻接仍是待逐站核对的候选关系，不能视为最终正确几何。
"""
    path.write_text(text, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--classification", type=Path, default=DEFAULT_CLASSIFICATION)
    parser.add_argument("--overrides", type=Path, default=DEFAULT_OVERRIDES)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    sections = SHAPES.load_zip_geojson(args.source, SHAPES.SECTION_MEMBER)
    stations = SHAPES.load_zip_geojson(args.source, SHAPES.STATION_MEMBER)
    line_rows = read_csv(args.classification)
    overrides = SHAPES.load_json(args.overrides, [])
    station_rows, connection_rows, interchange_rows, payload = build_network(
        sections, stations, line_rows, overrides
    )
    write_csv(args.output / "n02-station-network.csv", station_rows)
    write_csv(args.output / "n02-station-connections.csv", connection_rows)
    write_csv(args.output / "n02-station-interchanges.csv", interchange_rows)
    (args.output / "n02-station-network.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    write_readme(
        args.output / "STATION_NETWORK.md",
        station_rows,
        connection_rows,
        interchange_rows,
    )
    print(
        json.dumps(
            {
                "operator_stations": len(station_rows),
                "directed_rail_connections": len(connection_rows),
                "directed_interchange_connections": len(interchange_rows),
                "output": str(args.output.resolve()),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
