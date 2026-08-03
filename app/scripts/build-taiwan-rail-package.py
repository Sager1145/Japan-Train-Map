#!/usr/bin/env python3
"""Build ``public/rail/tw-2025.json`` exclusively from Taiwan official data.

The regular railway, high-speed railway, metro, and light-rail station order,
station coordinates, and detailed WGS84 shapes come from the Ministry of
Transportation TDX/PTX open APIs.  Alishan Forest Railway uses the Ministry of
Agriculture detailed SHP plus the current NLSC railway/station SHPs.

No OpenStreetMap file or geometry fallback is accepted.  Adjacent stations are
routed through an official shape graph.  The build fails instead of drawing a
synthetic straight connector when an official path is missing.

Only the Python standard library is required.  See
``public/rail/tw-2025.sources.md`` for source URLs and download commands.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import heapq
import json
import math
import os
import re
import struct
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple


APP_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = APP_DIR / "public" / "rail" / "tw-2025.json"
EARTH_RADIUS_KM = 6371.0088
SNAP_METERS = 14.0
MAX_STATION_OFFSET_KM = 2.0
PARALLEL_TRACK_SLACK_KM = 0.250
MAX_CANDIDATES = 64
# Station anchors pay this multiple of their offset in the routing objective.
# At 1:1 an anchor pulled along the track is free (the offset saved equals the
# path shortened), which systematically shaved every terminal and skewed
# interval boundaries; at 3:1 the nearest anchor wins unless the track truly
# is elsewhere.
OFFSET_WEIGHT = 3.0
# A routed via point must sit on the official graph within this distance.
VIA_SNAP_KM = 0.08
OFFICIAL_ROMA_SOURCE = 3
MAX_OUTPUT_EDGE_KM = 0.2
MAX_OFFICIAL_DEVIATION_METERS = 20.0

Coord = Tuple[float, float]
ProjectedCoord = Tuple[float, float]


@dataclass(frozen=True)
class Station:
    system: str
    station_id: str
    uid: str
    name: str
    name_en: str
    lon: float
    lat: float


@dataclass(frozen=True)
class LineSpec:
    line_id: str
    name: str
    name_en: str
    operator: str
    color: str
    rank: int
    station_refs: Tuple[Tuple[str, str], ...]
    shape_refs: Tuple[Tuple[str, str], ...]
    is_hsr: bool = False
    is_loop: bool = False
    max_detour_ratio: float = 4.0
    # Ordered official-track via coordinates per interval index.  They force
    # the route through spiral loops and switchback tails that a plain
    # shortest path would cut (Dushan spiral, the Alishan zigzags); every via
    # must lie on the line's scoped official geometry.
    via_points: Optional[Dict[int, Tuple[Coord, ...]]] = None


@dataclass(frozen=True)
class ShapeFeature:
    attrs: Dict[str, str]
    parts: Tuple[Tuple[ProjectedCoord, ...], ...]


@dataclass(frozen=True)
class Edge:
    target: int
    km: float
    cost: float


@dataclass
class RailGraph:
    coords: List[Coord]
    adjacency: List[List[Edge]]


@dataclass(frozen=True)
class RouteResult:
    coords: Tuple[Coord, ...]
    start_node: int
    end_node: int
    km: float
    max_edge_km: float


class OfficialGeometryIndex:
    """Small spatial index used to prove output stays on its scoped sources."""

    CELL_DEGREES = 0.002

    def __init__(self, parts: Sequence[Sequence[Coord]]):
        self.segments: List[Tuple[Coord, Coord]] = []
        self.cells: Dict[Tuple[int, int], List[int]] = {}
        for part in parts:
            for left, right in zip(part, part[1:]):
                segment_id = len(self.segments)
                self.segments.append((left, right))
                min_x = math.floor(min(left[0], right[0]) / self.CELL_DEGREES)
                max_x = math.floor(max(left[0], right[0]) / self.CELL_DEGREES)
                min_y = math.floor(min(left[1], right[1]) / self.CELL_DEGREES)
                max_y = math.floor(max(left[1], right[1]) / self.CELL_DEGREES)
                for x in range(min_x, max_x + 1):
                    for y in range(min_y, max_y + 1):
                        self.cells.setdefault((x, y), []).append(segment_id)

    def distance_meters(self, point: Coord) -> float:
        cell_x = math.floor(point[0] / self.CELL_DEGREES)
        cell_y = math.floor(point[1] / self.CELL_DEGREES)
        candidates = set()
        for x in range(cell_x - 1, cell_x + 2):
            for y in range(cell_y - 1, cell_y + 2):
                candidates.update(self.cells.get((x, y), ()))
        if not candidates:
            return float("inf")
        return min(
            point_segment_distance_meters(point, *self.segments[index])
            for index in candidates
        )


SOURCE_CANDIDATES: Dict[str, Tuple[str, ...]] = {
    "THSR:shape": ("tdx_thsr_shape.json", "ptx_thsr_shape.json"),
    "THSR:station": ("tdx_thsr_station.json", "ptx_thsr_station.json"),
    "THSR:line": (
        "tdx_thsr_station_of_line.json",
        "ptx_thsr_station_of_line.json",
    ),
    "TRA:shape": ("tdx_tra_shape.json", "ptx_tra_shape.json"),
    "TRA:station": ("tdx_tra_station.json", "ptx_tra_station.json"),
    "TRA:line": (
        "tdx_tra_station_of_line.json",
        "ptx_tra_station_of_line.json",
    ),
    "TRTC:shape": ("tdx_trtc_shape.json", "ptx_trtc_shape.json"),
    "TRTC:station": ("tdx_trtc_station.json", "ptx_trtc_station.json"),
    "TRTC:line": (
        "tdx_trtc_station_of_line.json",
        "ptx_trtc_station_of_line.json",
    ),
    "KRTC:shape": ("tdx_krtc_shape.json", "ptx_krtc_shape.json"),
    "KRTC:station": ("tdx_krtc_station.json", "ptx_krtc_station.json"),
    "KRTC:line": (
        "tdx_krtc_station_of_line.json",
        "ptx_krtc_station_of_line.json",
    ),
    "TYMC:shape": ("tdx_tymc_shape.json", "ptx_tymc_shape.json"),
    "TYMC:station": ("tdx_tymc_station.json", "ptx_tymc_station.json"),
    "TYMC:line": (
        "tdx_tymc_station_of_line.json",
        "ptx_tymc_station_of_line.json",
    ),
    "NTDLRT:shape": ("tdx_ntdlrt_shape.json", "ptx_ntdlrt_shape.json"),
    "NTDLRT:station": (
        "tdx_ntdlrt_station.json",
        "ptx_ntdlrt_station.json",
    ),
    "NTDLRT:line": (
        "tdx_ntdlrt_station_of_line.json",
        "ptx_ntdlrt_station_of_line.json",
    ),
    "TMRT:shape": ("tdx_tmrt_shape.json", "ptx_tmrt_shape.json"),
    "TMRT:station": ("tdx_tmrt_station.json", "ptx_tmrt_station.json"),
    "TMRT:line": (
        "tdx_tmrt_station_of_line.json",
        "ptx_tmrt_station_of_line.json",
    ),
    "KLRT:shape": ("tdx_klrt_shape.json", "ptx_klrt_shape.json"),
    "KLRT:station": ("tdx_klrt_station.json", "ptx_klrt_station.json"),
    "KLRT:line": (
        "tdx_klrt_station_of_line.json",
        "ptx_klrt_station_of_line.json",
    ),
    "NTMC:shape": ("tdx_ntmc_shape.json", "ptx_ntmc_shape.json"),
    "NTMC:station": ("tdx_ntmc_station.json", "ptx_ntmc_station.json"),
    "NTMC:line": (
        "tdx_ntmc_station_of_line.json",
        "ptx_ntmc_station_of_line.json",
    ),
    "NTALRT:shape": ("tdx_ntalrt_shape.json", "ptx_ntalrt_shape.json"),
    "NTALRT:station": (
        "tdx_ntalrt_station.json",
        "ptx_ntalrt_station.json",
    ),
    "NTALRT:line": (
        "tdx_ntalrt_station_of_line.json",
        "ptx_ntalrt_station_of_line.json",
    ),
}


def haversine(left: Coord, right: Coord) -> float:
    lon1, lat1 = map(math.radians, left)
    lon2, lat2 = map(math.radians, right)
    dlon, dlat = lon2 - lon1, lat2 - lat1
    value = (
        math.sin(dlat / 2.0) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2.0) ** 2
    )
    return 2.0 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(value)))


def point_segment_distance_meters(point: Coord, left: Coord, right: Coord) -> float:
    """Local planar distance; sufficient for the 20 m conformance threshold."""
    lon_scale = 111320.0 * math.cos(math.radians(point[1]))
    lat_scale = 110574.0
    left_x = (left[0] - point[0]) * lon_scale
    left_y = (left[1] - point[1]) * lat_scale
    right_x = (right[0] - point[0]) * lon_scale
    right_y = (right[1] - point[1]) * lat_scale
    delta_x = right_x - left_x
    delta_y = right_y - left_y
    squared = delta_x * delta_x + delta_y * delta_y
    ratio = 0.0
    if squared:
        ratio = max(
            0.0,
            min(1.0, -(left_x * delta_x + left_y * delta_y) / squared),
        )
    return math.hypot(left_x + ratio * delta_x, left_y + ratio * delta_y)


def twd97_tm2_to_wgs84(x: float, y: float) -> Coord:
    """Inverse EPSG:3826 using the published GRS80 TM2 parameters."""
    semi_major = 6378137.0
    flattening = 1.0 / 298.257222101
    eccentricity_sq = flattening * (2.0 - flattening)
    eccentricity_prime_sq = eccentricity_sq / (1.0 - eccentricity_sq)
    scale = 0.9999
    meridian = math.radians(121.0)
    meridional_arc = y / scale
    mu = meridional_arc / (
        semi_major
        * (
            1.0
            - eccentricity_sq / 4.0
            - 3.0 * eccentricity_sq**2 / 64.0
            - 5.0 * eccentricity_sq**3 / 256.0
        )
    )
    root = math.sqrt(1.0 - eccentricity_sq)
    e1 = (1.0 - root) / (1.0 + root)
    footpoint = (
        mu
        + (3.0 * e1 / 2.0 - 27.0 * e1**3 / 32.0) * math.sin(2.0 * mu)
        + (21.0 * e1**2 / 16.0 - 55.0 * e1**4 / 32.0) * math.sin(4.0 * mu)
        + (151.0 * e1**3 / 96.0) * math.sin(6.0 * mu)
        + (1097.0 * e1**4 / 512.0) * math.sin(8.0 * mu)
    )
    sin_fp = math.sin(footpoint)
    cos_fp = math.cos(footpoint)
    tan_fp = math.tan(footpoint)
    c1 = eccentricity_prime_sq * cos_fp**2
    t1 = tan_fp**2
    n1 = semi_major / math.sqrt(1.0 - eccentricity_sq * sin_fp**2)
    r1 = semi_major * (1.0 - eccentricity_sq) / (
        1.0 - eccentricity_sq * sin_fp**2
    ) ** 1.5
    d = (x - 250000.0) / (n1 * scale)
    latitude = footpoint - (n1 * tan_fp / r1) * (
        d**2 / 2.0
        - (5.0 + 3.0 * t1 + 10.0 * c1 - 4.0 * c1**2 - 9.0 * eccentricity_prime_sq)
        * d**4
        / 24.0
        + (
            61.0
            + 90.0 * t1
            + 298.0 * c1
            + 45.0 * t1**2
            - 252.0 * eccentricity_prime_sq
            - 3.0 * c1**2
        )
        * d**6
        / 720.0
    )
    longitude = meridian + (
        d
        - (1.0 + 2.0 * t1 + c1) * d**3 / 6.0
        + (
            5.0
            - 2.0 * c1
            + 28.0 * t1
            - 3.0 * c1**2
            + 8.0 * eccentricity_prime_sq
            + 24.0 * t1**2
        )
        * d**5
        / 120.0
    ) / cos_fp
    return (math.degrees(longitude), math.degrees(latitude))


def read_dbf(path: Path) -> List[Optional[Dict[str, str]]]:
    data = path.read_bytes()
    if len(data) < 33:
        raise RuntimeError(f"invalid DBF: {path}")
    count = struct.unpack_from("<I", data, 4)[0]
    header_len, record_len = struct.unpack_from("<HH", data, 8)
    fields: List[Tuple[str, int]] = []
    offset = 32
    while offset < header_len and data[offset] != 0x0D:
        descriptor = data[offset : offset + 32]
        name = descriptor[:11].split(b"\0", 1)[0].decode("ascii")
        fields.append((name, descriptor[16]))
        offset += 32
    rows: List[Optional[Dict[str, str]]] = []
    for index in range(count):
        record = data[
            header_len + index * record_len : header_len + (index + 1) * record_len
        ]
        if not record:
            raise RuntimeError(f"truncated DBF record {index}: {path}")
        if record[0:1] == b"*":
            rows.append(None)
            continue
        position = 1
        row: Dict[str, str] = {}
        for name, length in fields:
            raw = record[position : position + length]
            position += length
            row[name] = raw.decode("utf-8", errors="replace").strip()
        rows.append(row)
    return rows


def iter_shp_records(path: Path) -> Iterator[Tuple[int, Tuple[Tuple[ProjectedCoord, ...], ...]]]:
    data = path.read_bytes()
    if len(data) < 100:
        raise RuntimeError(f"invalid SHP: {path}")
    offset = 100
    while offset + 8 <= len(data):
        _record_number, content_words = struct.unpack_from(">II", data, offset)
        offset += 8
        content = data[offset : offset + content_words * 2]
        offset += content_words * 2
        if len(content) < 4:
            raise RuntimeError(f"truncated SHP record: {path}")
        shape_type = struct.unpack_from("<I", content, 0)[0]
        if shape_type == 0:
            yield shape_type, ()
        elif shape_type in (1, 11, 21):
            yield shape_type, ((struct.unpack_from("<dd", content, 4),),)
        elif shape_type in (3, 13, 23):
            part_count, point_count = struct.unpack_from("<II", content, 36)
            starts = list(struct.unpack_from(f"<{part_count}I", content, 44))
            point_offset = 44 + part_count * 4
            points = tuple(
                struct.unpack_from("<dd", content, point_offset + index * 16)
                for index in range(point_count)
            )
            starts.append(point_count)
            yield shape_type, tuple(
                points[starts[index] : starts[index + 1]]
                for index in range(part_count)
            )
        else:
            raise RuntimeError(f"unsupported SHP type {shape_type}: {path}")


def find_shape_pair(path: Path, temporary: Path) -> Tuple[Path, Path]:
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            archive.extractall(temporary)
        candidates = sorted(temporary.rglob("*.shp"))
        if len(candidates) != 1:
            raise RuntimeError(f"expected one SHP in {path}, found {len(candidates)}")
        shp_path = candidates[0]
    else:
        shp_path = path
    dbf_path = shp_path.with_suffix(".dbf")
    if not shp_path.is_file() or not dbf_path.is_file():
        raise RuntimeError(f"SHP/DBF pair not found for {path}")
    return shp_path, dbf_path


def load_shape_features(path: Path) -> List[ShapeFeature]:
    with tempfile.TemporaryDirectory(prefix="tw-official-shp-") as temporary_name:
        shp_path, dbf_path = find_shape_pair(path, Path(temporary_name))
        rows = read_dbf(dbf_path)
        shapes = list(iter_shp_records(shp_path))
    if len(rows) != len(shapes):
        raise RuntimeError(f"SHP/DBF record mismatch: {path}")
    return [
        ShapeFeature(row, parts)
        for row, (_shape_type, parts) in zip(rows, shapes)
        if row is not None and parts
    ]


def load_alishan_stations(path: Path) -> Dict[str, Station]:
    features = load_shape_features(path)
    output: Dict[str, Station] = {}
    for feature in features:
        if not feature.parts or not feature.parts[0]:
            continue
        row = feature.attrs
        if "阿里山" not in row.get("MARKNAME1", ""):
            continue
        x, y = feature.parts[0][0]
        lon, lat = twd97_tm2_to_wgs84(x, y)
        raw_name = row.get("MARKNAME2") or row.get("MARKNAME1", "")
        name = re.sub(r"^阿里山林鐵", "", raw_name)
        name = re.sub(r"車?站(?:\(現未停靠\))?$", "", name)
        uid = f"AFR-{row['MARKID']}"
        output[name] = Station(
            "AFR", row["MARKID"], uid, name, "", round(lon, 6), round(lat, 6)
        )
    return output


def parse_wkt_parts(wkt: str) -> List[List[Coord]]:
    text = wkt.strip()
    if text.startswith("LINESTRING"):
        bodies = [text[text.find("(") + 1 : text.rfind(")")]]
    elif text.startswith("MULTILINESTRING"):
        body = text[text.find("(") + 1 : text.rfind(")")]
        bodies: List[str] = []
        depth = 0
        start: Optional[int] = None
        for index, char in enumerate(body):
            if char == "(":
                if depth == 0:
                    start = index + 1
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0 and start is not None:
                    bodies.append(body[start:index])
                    start = None
        if depth != 0:
            raise RuntimeError("unbalanced MULTILINESTRING")
    else:
        raise RuntimeError(f"unsupported official WKT: {text[:40]}")
    output: List[List[Coord]] = []
    for body in bodies:
        coords = []
        for token in body.split(","):
            values = token.strip().split()
            if len(values) < 2:
                raise RuntimeError(f"invalid WKT coordinate: {token}")
            coords.append((round(float(values[0]), 6), round(float(values[1]), 6)))
        if len(coords) >= 2:
            output.append(coords)
    return output


def resolve_source(source_dir: Path, key: str) -> Path:
    for name in SOURCE_CANDIDATES[key]:
        candidate = source_dir / name
        if candidate.is_file():
            return candidate
    raise RuntimeError(
        f"missing official source {key}; expected one of {SOURCE_CANDIDATES[key]} "
        f"in {source_dir}"
    )


def localized(value: object, locale: str) -> str:
    if isinstance(value, dict):
        result = value.get(locale, "")
        return str(result) if result is not None else ""
    if locale == "Zh_tw" and value is not None:
        return str(value)
    return ""


def utc_timestamp(values: Iterable[str]) -> str:
    parsed = []
    for value in values:
        if not value:
            continue
        try:
            parsed.append(datetime.fromisoformat(value.replace("Z", "+00:00")))
        except ValueError:
            pass
    latest = max(parsed) if parsed else datetime(2026, 8, 3, tzinfo=timezone.utc)
    return latest.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def build_graph(
    parts: Sequence[Sequence[Coord]],
    snap_meters: float = SNAP_METERS,
    penalties: Optional[Sequence[float]] = None,
) -> RailGraph:
    coords: List[Coord] = []
    xy: List[Tuple[float, float]] = []
    adjacency: List[List[Edge]] = []
    cells: Dict[Tuple[int, int], List[int]] = {}
    lon_scale = 111320.0 * math.cos(math.radians(24.0))
    lat_scale = 110574.0

    def node_for(point: Coord) -> int:
        projected = (point[0] * lon_scale, point[1] * lat_scale)
        cell = (
            math.floor(projected[0] / snap_meters),
            math.floor(projected[1] / snap_meters),
        )
        best: Optional[Tuple[float, int]] = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for node in cells.get((cell[0] + dx, cell[1] + dy), ()):
                    other = xy[node]
                    distance = math.hypot(
                        projected[0] - other[0], projected[1] - other[1]
                    )
                    if distance <= snap_meters and (
                        best is None or (distance, node) < best
                    ):
                        best = (distance, node)
        if best is not None:
            return best[1]
        node = len(coords)
        coords.append((round(point[0], 6), round(point[1], 6)))
        xy.append(projected)
        adjacency.append([])
        cells.setdefault(cell, []).append(node)
        return node

    if penalties is None:
        penalties = [1.0] * len(parts)
    if len(penalties) != len(parts):
        raise RuntimeError("official shape penalty/part mismatch")
    for part, penalty in zip(parts, penalties):
        # Collinear subdivision so long published edges (viaduct/tunnel
        # records of a kilometre or more) still carry graph nodes near the
        # stations they pass; anchors would otherwise land at the far edge
        # ends (水安宮 sat 415 m from its nearest node).
        part = subdivide_part(part, 0.2)
        nodes = [node_for(point) for point in part]
        for left, right in zip(nodes, nodes[1:]):
            if left == right:
                continue
            km = haversine(coords[left], coords[right])
            if km <= 0.0:
                continue
            adjacency[left].append(Edge(right, km, km * penalty))
            adjacency[right].append(Edge(left, km, km * penalty))
    return RailGraph(coords, adjacency)


def station_candidates(graph: RailGraph, station: Station) -> List[Tuple[int, float]]:
    point = (station.lon, station.lat)
    rows = sorted(
        ((node, haversine(point, coord)) for node, coord in enumerate(graph.coords)),
        key=lambda row: (row[1], row[0]),
    )
    if not rows or rows[0][1] > MAX_STATION_OFFSET_KM:
        return []
    cutoff = min(MAX_STATION_OFFSET_KM, rows[0][1] + PARALLEL_TRACK_SLACK_KM)
    return [row for row in rows if row[1] <= cutoff][:MAX_CANDIDATES]


def find_route(
    graph: RailGraph,
    starts: Sequence[Tuple[int, float]],
    ends: Sequence[Tuple[int, float]],
) -> Optional[RouteResult]:
    if not starts or not ends:
        return None
    distances: Dict[int, float] = {}
    previous: Dict[int, Tuple[int, float]] = {}
    queue: List[Tuple[float, int]] = []
    for node, offset in starts:
        if offset < distances.get(node, float("inf")):
            distances[node] = offset
            heapq.heappush(queue, (offset, node))
    end_offsets = {node: offset for node, offset in ends}
    chosen: Optional[Tuple[float, int]] = None
    while queue:
        distance, node = heapq.heappop(queue)
        if distance != distances.get(node):
            continue
        if chosen is not None and distance >= chosen[0]:
            break
        if node in end_offsets:
            total = distance + end_offsets[node]
            if chosen is None or (total, node) < chosen:
                chosen = (total, node)
        for edge in graph.adjacency[node]:
            candidate = distance + edge.cost
            if candidate < distances.get(edge.target, float("inf")):
                distances[edge.target] = candidate
                previous[edge.target] = (node, edge.km)
                heapq.heappush(queue, (candidate, edge.target))
    if chosen is None:
        return None
    end_node = chosen[1]
    nodes = [end_node]
    edges = []
    while nodes[-1] in previous:
        parent, edge_km = previous[nodes[-1]]
        nodes.append(parent)
        edges.append(edge_km)
    nodes.reverse()
    edges.reverse()
    if len(nodes) < 2:
        return None
    return RouteResult(
        tuple(graph.coords[node] for node in nodes),
        nodes[0],
        end_node,
        sum(edges),
        max(edges),
    )


def find_transition_routes(
    graph: RailGraph,
    start_scores: Dict[int, float],
    ends: Sequence[Tuple[int, float]],
) -> Dict[int, Tuple[float, int, RouteResult]]:
    """Find the best continuous route to every next-station candidate.

    The start score contains the optimal cost through all preceding stations.
    One multi-source Dijkstra therefore advances the dynamic program by a
    station without greedily locking onto the wrong platform track.
    """
    distances = dict(start_scores)
    previous: Dict[int, Tuple[int, float]] = {}
    origin = {node: node for node in start_scores}
    queue = [(score, node) for node, score in start_scores.items()]
    heapq.heapify(queue)
    end_offsets: Dict[int, float] = {}
    for node, offset in ends:
        end_offsets[node] = min(offset, end_offsets.get(node, float("inf")))
    unsettled = set(end_offsets)
    settled_ends = []
    while queue and unsettled:
        distance, node = heapq.heappop(queue)
        if distance != distances.get(node):
            continue
        if node in unsettled:
            unsettled.remove(node)
            settled_ends.append(node)
        for edge in graph.adjacency[node]:
            candidate = distance + edge.cost
            if candidate < distances.get(edge.target, float("inf")):
                distances[edge.target] = candidate
                previous[edge.target] = (node, edge.km)
                origin[edge.target] = origin[node]
                heapq.heappush(queue, (candidate, edge.target))
    output: Dict[int, Tuple[float, int, RouteResult]] = {}
    for end_node in settled_ends:
        source_node = origin[end_node]
        nodes = [end_node]
        edge_lengths = []
        while nodes[-1] != source_node:
            if nodes[-1] not in previous:
                break
            parent, edge_km = previous[nodes[-1]]
            nodes.append(parent)
            edge_lengths.append(edge_km)
        if nodes[-1] != source_node or len(nodes) < 2:
            continue
        nodes.reverse()
        edge_lengths.reverse()
        route = RouteResult(
            tuple(graph.coords[node] for node in nodes),
            source_node,
            end_node,
            sum(edge_lengths),
            max(edge_lengths),
        )
        output[end_node] = (
            distances[end_node] + end_offsets[end_node],
            source_node,
            route,
        )
    return output


def subrange(values: Sequence[str], start: str, end: str) -> Tuple[str, ...]:
    left, right = values.index(start), values.index(end)
    if left <= right:
        return tuple(values[left : right + 1])
    return tuple(reversed(values[right : left + 1]))


def normalize_group_name(name: str) -> str:
    value = name.replace("台", "臺").lower()
    value = re.sub(r"^(高鐵|臺鐵)", "", value)
    value = re.sub(r"(車站|站)$", "", value)
    value = re.sub(r"[／/（）()\s\-_]", "", value)
    return value


def subdivide_part(part: Sequence[Coord], max_edge_km: float) -> List[Coord]:
    """Insert collinear points so no input edge exceeds max_edge_km."""
    output = [part[0]]
    for left, right in zip(part, part[1:]):
        steps = max(1, math.ceil(haversine(left, right) / max_edge_km))
        for step in range(1, steps + 1):
            ratio = step / steps
            output.append(
                (
                    left[0] + (right[0] - left[0]) * ratio,
                    left[1] + (right[1] - left[1]) * ratio,
                )
            )
    return output


def densify_official_edge(coords: Sequence[Coord]) -> List[Coord]:
    """Subdivide a published official edge without changing its alignment."""
    output = [coords[0]]
    for left, right in zip(coords, coords[1:]):
        steps = max(1, math.ceil(haversine(left, right) / MAX_OUTPUT_EDGE_KM))
        for step in range(1, steps + 1):
            ratio = step / steps
            output.append(
                (
                    round(left[0] + (right[0] - left[0]) * ratio, 6),
                    round(left[1] + (right[1] - left[1]) * ratio, 6),
                )
            )
    if len(output) == 2:
        left, right = output
        output.insert(
            1,
            (
                round((left[0] + right[0]) / 2.0, 6),
                round((left[1] + right[1]) / 2.0, 6),
            ),
        )
    return output


class UnionFind:
    def __init__(self, values: Iterable[str]):
        self.parent = {value: value for value in values}

    def find(self, value: str) -> str:
        while self.parent[value] != value:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, left: str, right: str) -> None:
        left_root, right_root = self.find(left), self.find(right)
        if left_root == right_root:
            return
        if right_root < left_root:
            left_root, right_root = right_root, left_root
        self.parent[right_root] = left_root


def build_group_ids(stations: Iterable[Station]) -> Dict[str, str]:
    unique = {station.uid: station for station in stations}
    uf = UnionFind(unique)
    rows = list(unique.values())
    for index, left in enumerate(rows):
        for right in rows[index + 1 :]:
            distance = haversine((left.lon, left.lat), (right.lon, right.lat))
            same_name = normalize_group_name(left.name) == normalize_group_name(right.name)
            same_name_limit = 0.25 if left.system == right.system else 0.5
            if (same_name and distance <= same_name_limit) or (
                left.system != right.system and distance <= 0.35
            ):
                uf.union(left.uid, right.uid)
    members: Dict[str, List[str]] = {}
    for uid in unique:
        members.setdefault(uf.find(uid), []).append(uid)
    output: Dict[str, str] = {}
    for uids in members.values():
        source = min(uids).lower()
        slug = re.sub(r"[^a-z0-9]+", "-", source).strip("-")
        if not slug:
            slug = hashlib.sha1("|".join(sorted(uids)).encode()).hexdigest()[:12]
        group_id = f"tw-official-{slug}"
        for uid in uids:
            output[uid] = group_id
    return output


def weighted_offsets(
    rows: Sequence[Tuple[int, float]]
) -> List[Tuple[int, float]]:
    """Scale station-anchor offsets so shaving track never pays for itself."""
    return [(node, offset * OFFSET_WEIGHT) for node, offset in rows]


def nearest_graph_node(graph: RailGraph, point: Coord) -> Tuple[float, int]:
    best: Optional[Tuple[float, int]] = None
    for node, coord in enumerate(graph.coords):
        distance = haversine(point, coord)
        if best is None or (distance, node) < best:
            best = (distance, node)
    if best is None:
        raise RuntimeError("official graph is empty")
    return best


def route_with_vias(
    spec: LineSpec,
    stations: Sequence[Station],
    graph: RailGraph,
    candidates: Sequence[Sequence[Tuple[int, float]]],
) -> List[RouteResult]:
    """Route every interval through its ordered official via points.

    Vias exist to keep spiral loops and switchback tails (which a shortest
    path would cut) in the display line; every station anchors at its nearest
    official node and every leg is routed separately."""
    anchors = [min(rows, key=lambda row: (row[1], row[0]))[0] for rows in candidates]
    routes: List[RouteResult] = []
    for index in range(len(stations) - 1):
        stops = [anchors[index]]
        for via in (spec.via_points or {}).get(index, ()):
            distance, node = nearest_graph_node(graph, via)
            if distance > VIA_SNAP_KM:
                raise RuntimeError(
                    f"{spec.line_id}: via point {via} is {distance * 1000:.0f} m "
                    "away from the line's official geometry"
                )
            stops.append(node)
        stops.append(anchors[index + 1])
        coords: List[Coord] = []
        total_km = 0.0
        max_edge = 0.0
        for left, right in zip(stops, stops[1:]):
            if left == right:
                continue
            leg = find_route(graph, [(left, 0.0)], [(right, 0.0)])
            if leg is None:
                raise RuntimeError(
                    f"{spec.line_id}: official geometry cannot reach a via point "
                    f"between {stations[index].name} and {stations[index + 1].name}"
                )
            total_km += leg.km
            max_edge = max(max_edge, leg.max_edge_km)
            coords.extend(leg.coords if not coords else leg.coords[1:])
        if len(coords) < 2:
            raise RuntimeError(
                f"{spec.line_id}: empty via route between "
                f"{stations[index].name} and {stations[index + 1].name}"
            )
        routes.append(
            RouteResult(tuple(coords), stops[0], stops[-1], total_km, max_edge)
        )
    return routes


def route_line(
    spec: LineSpec, stations: Sequence[Station], graph: RailGraph
) -> Tuple[List[List[object]], Dict[str, float]]:
    candidates = []
    for station in stations:
        rows = station_candidates(graph, station)
        if not rows:
            raise RuntimeError(
                f"{spec.line_id}: no official shape within "
                f"{MAX_STATION_OFFSET_KM} km of {station.name}"
            )
        candidates.append(rows)

    component_by_node: Dict[int, int] = {}
    component_id = 0
    for node in range(len(graph.coords)):
        if node in component_by_node:
            continue
        queue = [node]
        component_by_node[node] = component_id
        for current in queue:
            for edge in graph.adjacency[current]:
                if edge.target not in component_by_node:
                    component_by_node[edge.target] = component_id
                    queue.append(edge.target)
        component_id += 1
    common_components = set(component_by_node[node] for node, _offset in candidates[0])
    for rows in candidates[1:]:
        common_components.intersection_update(
            component_by_node[node] for node, _offset in rows
        )
    if not common_components:
        raise RuntimeError(
            f"{spec.line_id}: no single official connected component covers all stations"
        )
    selected_component = min(
        common_components,
        key=lambda component: (
            sum(
                min(
                    offset
                    for node, offset in rows
                    if component_by_node[node] == component
                )
                for rows in candidates
            ),
            component,
        ),
    )
    candidates = [
        [
            (node, offset)
            for node, offset in rows
            if component_by_node[node] == selected_component
        ]
        for rows in candidates
    ]
    pair_count = len(stations) if spec.is_loop else len(stations) - 1
    routes: List[RouteResult] = []
    if spec.via_points:
        routes = route_with_vias(spec, stations, graph, candidates)
    elif spec.is_loop:
        previous_end: Optional[int] = None
        first_start: Optional[int] = None
        for index in range(pair_count):
            next_index = (index + 1) % len(stations)
            starts = (
                [(previous_end, 0.0)]
                if previous_end is not None
                else weighted_offsets(candidates[index])
            )
            ends = (
                [(first_start, 0.0)]
                if next_index == 0 and first_start is not None
                else weighted_offsets(candidates[next_index])
            )
            route = find_route(graph, starts, ends)
            if route is None:
                raise RuntimeError(
                    f"{spec.line_id}: official loop is disconnected for "
                    f"{stations[index].name} -> {stations[next_index].name}"
                )
            if first_start is None:
                first_start = route.start_node
            previous_end = route.end_node
            routes.append(route)
    else:
        start_scores: Dict[int, float] = {}
        for node, offset in candidates[0]:
            start_scores[node] = min(
                offset * OFFSET_WEIGHT, start_scores.get(node, float("inf"))
            )
        transitions: List[Dict[int, Tuple[float, int, RouteResult]]] = []
        for next_rows in candidates[1:]:
            transition = find_transition_routes(
                graph, start_scores, weighted_offsets(next_rows)
            )
            if not transition:
                raise RuntimeError(
                    f"{spec.line_id}: official shape cannot advance through all stations"
                )
            transitions.append(transition)
            start_scores = {
                end_node: values[0] for end_node, values in transition.items()
            }
        selected_end = min(start_scores, key=lambda node: (start_scores[node], node))
        reversed_routes = []
        for transition in reversed(transitions):
            _score, selected_start, route = transition[selected_end]
            reversed_routes.append(route)
            selected_end = selected_start
        routes = list(reversed(reversed_routes))

    output: List[List[object]] = []
    previous_last: Optional[Coord] = None
    total_km = 0.0
    max_edge = 0.0
    max_offset = 0.0
    max_detour = 0.0
    for index, route in enumerate(routes):
        next_index = (index + 1) % len(stations)
        straight = haversine(
            (stations[index].lon, stations[index].lat),
            (stations[next_index].lon, stations[next_index].lat),
        )
        start_offset = haversine(
            (stations[index].lon, stations[index].lat), graph.coords[route.start_node]
        )
        end_offset = haversine(
            (stations[next_index].lon, stations[next_index].lat),
            graph.coords[route.end_node],
        )
        if route.km + start_offset + end_offset < straight * 0.58:
            raise RuntimeError(
                f"{spec.line_id}: implausible official shortcut for "
                f"{stations[index].name} -> {stations[next_index].name}"
            )
        if route.km > straight * spec.max_detour_ratio + 3.0:
            raise RuntimeError(
                f"{spec.line_id}: implausible official detour for "
                f"{stations[index].name} -> {stations[next_index].name} "
                f"({route.km:.2f} km vs {straight:.2f} km straight)"
            )
        # Some official tunnel/viaduct records expose only their engineered
        # end points.  Subdivision keeps that exact published alignment while
        # ensuring compact-v1 never represents a long interval as two points.
        coords = densify_official_edge(route.coords)
        shared = int(previous_last is not None and coords[0] == previous_last)
        payload = coords[1:] if shared else coords
        output.append(
            [
                round(route.km, 3),
                shared,
                [[round(lon, 6), round(lat, 6)] for lon, lat in payload],
            ]
        )
        previous_last = coords[-1]
        total_km += route.km
        max_edge = max(max_edge, route.max_edge_km)
        max_offset = max(max_offset, start_offset, end_offset)
        max_detour = max(max_detour, route.km / max(straight, 0.001))
    return output, {
        "km": total_km,
        "max_edge_km": max_edge,
        "max_station_offset_km": max_offset,
        "max_detour_ratio": max_detour,
    }


def reconstruct_segment(row: Sequence[object], previous_last: Optional[Coord]) -> List[Coord]:
    payload = [tuple(map(float, coord)) for coord in row[2]]
    if row[1]:
        if previous_last is None:
            raise RuntimeError("compact segment shares a missing prior point")
        return [previous_last, *payload]
    return payload


def audit_line_against_official(
    line_id: str,
    segments: Sequence[Sequence[object]],
    official_parts: Sequence[Sequence[Coord]],
) -> Dict[str, float]:
    """Compare every output vertex and edge midpoint with line-scoped data."""
    index = OfficialGeometryIndex(official_parts)
    previous_last: Optional[Coord] = None
    compared_vertices = 0
    compared_edges = 0
    maximum = 0.0
    for segment in segments:
        coords = reconstruct_segment(segment, previous_last)
        previous_last = coords[-1]
        samples = list(coords)
        samples.extend(
            (
                (left[0] + right[0]) / 2.0,
                (left[1] + right[1]) / 2.0,
            )
            for left, right in zip(coords, coords[1:])
        )
        compared_vertices += len(coords)
        compared_edges += max(0, len(coords) - 1)
        for point in samples:
            distance = index.distance_meters(point)
            maximum = max(maximum, distance)
            if not math.isfinite(distance) or distance > MAX_OFFICIAL_DEVIATION_METERS:
                raise RuntimeError(
                    f"{line_id}: output deviates {distance:.2f} m from its "
                    "line-scoped official geometry"
                )
    return {
        "vertices": compared_vertices,
        "edges": compared_edges,
        "max_deviation_m": maximum,
    }


def audit_package(package: Dict[str, object]) -> Dict[str, object]:
    edge_lengths: List[float] = []
    station_count = 0
    segment_count = 0
    vertex_count = 0
    two_point_intervals: List[str] = []
    for line in package["lines"]:
        stations = line["stations"]
        station_count += len(stations)
        expected = len(stations) if line.get("isLoop") else len(stations) - 1
        if len(line["segments"]) != expected:
            raise RuntimeError(f"{line['id']}: station/segment topology mismatch")
        previous_last: Optional[Coord] = None
        for index, segment in enumerate(line["segments"]):
            coords = reconstruct_segment(segment, previous_last)
            previous_last = coords[-1]
            lengths = [haversine(a, b) for a, b in zip(coords, coords[1:])]
            if not lengths:
                raise RuntimeError(f"{line['id']}: empty geometry segment")
            if len(coords) == 2:
                next_index = (index + 1) % len(stations)
                two_point_intervals.append(
                    f"{line['id']}:{stations[index][1]}->{stations[next_index][1]}"
                )
            edge_lengths.extend(lengths)
            segment_count += 1
            vertex_count += len(coords)
    if two_point_intervals:
        raise RuntimeError(f"two-point segments: {two_point_intervals}")
    if max(edge_lengths, default=0.0) >= 0.5:
        longest = max(edge_lengths)
        raise RuntimeError(f"official source contains a {longest:.3f} km straight edge")
    return {
        "lines": len(package["lines"]),
        "stations": station_count,
        "segments": segment_count,
        "vertices": vertex_count,
        "edges": len(edge_lengths),
        "maxEdgeKm": round(max(edge_lengths, default=0.0), 6),
        "twoPointSegments": len(two_point_intervals),
        "twoPointSegmentsGe500m": len(two_point_intervals),
    }


def write_package(path: Path, package: Dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(package, ensure_ascii=False, separators=(",", ":")).encode()
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(encoded)
    os.replace(temporary, path)
    gzip_path = Path(str(path) + ".gz")
    gzip_temporary = Path(str(gzip_path) + ".tmp")
    with gzip_temporary.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as stream:
            stream.write(encoded)
    os.replace(gzip_temporary, gzip_path)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-dir",
        type=Path,
        required=True,
        help="directory containing the downloaded TDX/PTX JSON snapshots",
    )
    parser.add_argument(
        "--alishan-detail",
        type=Path,
        required=True,
        help="Ministry of Agriculture Alishan detailed SHP or ZIP",
    )
    parser.add_argument(
        "--alishan-rail",
        type=Path,
        required=True,
        help="current NLSC RAIL SHP or ZIP",
    )
    parser.add_argument(
        "--nlsc-mrt",
        type=Path,
        required=True,
        help="current NLSC MRT SHP or ZIP",
    )
    parser.add_argument(
        "--nlsc-lrt",
        type=Path,
        required=True,
        help="current NLSC LRT SHP or ZIP",
    )
    parser.add_argument(
        "--nlsc-lrt-stations",
        type=Path,
        required=True,
        help="current NLSC light-rail station SHP or ZIP",
    )
    parser.add_argument(
        "--taipei-metro",
        type=Path,
        required=True,
        help="Taipei City official metro-network GeoJSON/JSON",
    )
    parser.add_argument(
        "--alishan-stations",
        type=Path,
        required=True,
        help="current NLSC railway-station SHP or ZIP",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)

    systems = sorted({key.split(":", 1)[0] for key in SOURCE_CANDIDATES})
    source_data: Dict[str, List[Dict[str, object]]] = {}
    source_paths: Dict[str, Path] = {}
    update_times: List[str] = []
    for system in systems:
        for kind in ("shape", "station", "line"):
            key = f"{system}:{kind}"
            path = resolve_source(args.source_dir, key)
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            if not isinstance(data, list) or not data:
                raise RuntimeError(f"empty official JSON source: {path}")
            source_data[key] = data
            source_paths[key] = path
            for row in data:
                update_times.extend(
                    str(row.get(field, ""))
                    for field in ("UpdateTime", "SrcUpdateTime")
                )

    station_maps: Dict[str, Dict[str, Station]] = {}
    line_sequences: Dict[Tuple[str, str], Tuple[str, ...]] = {}
    shape_parts: Dict[Tuple[str, str], List[List[Coord]]] = {}
    shape_part_penalties: Dict[Tuple[str, str], List[float]] = {}
    for system in systems:
        stations: Dict[str, Station] = {}
        for row in source_data[f"{system}:station"]:
            station_id = str(row["StationID"])
            position = row["StationPosition"]
            name = localized(row.get("StationName", ""), "Zh_tw")
            name_en = localized(row.get("StationName", ""), "En")
            stations[station_id] = Station(
                system=system,
                station_id=station_id,
                uid=str(row.get("StationUID") or f"{system}-{station_id}"),
                name=name,
                name_en=name_en,
                lon=round(float(position["PositionLon"]), 6),
                lat=round(float(position["PositionLat"]), 6),
            )
        station_maps[system] = stations
        for row in source_data[f"{system}:line"]:
            line_id = str(row["LineID"])
            ordered = sorted(
                row["Stations"],
                key=lambda item: float(item.get("Sequence", 0)),
            )
            line_sequences[(system, line_id)] = tuple(
                str(item["StationID"]) for item in ordered
            )
        for row in source_data[f"{system}:shape"]:
            line_id = str(row["LineID"])
            parts = parse_wkt_parts(str(row["Geometry"]))
            if system == "TRA":
                # The TRA shapes contain multi-kilometre straight chords where
                # the record is coarse (e.g. the realigned 壽豐-豐田 section is
                # one 6.2 km chord).  Subdividing keeps the exact published
                # alignment while letting the graph snap the chord onto the
                # NLSC centreline wherever both exist, so the chord only ever
                # bridges genuine NLSC breaks instead of being drawn whole.
                parts = [subdivide_part(part, 0.1) for part in parts]
            shape_parts.setdefault((system, line_id), []).extend(parts)

    # PTX currently publishes K03 and K04 of Ankeng LRT at effectively the
    # same coordinate.  The current NLSC official station layer has the
    # distinct platform locations, so it is the coordinate authority for all
    # light-rail stations while TDX/PTX remains the name and station-order
    # authority.
    for feature in load_shape_features(args.nlsc_lrt_stations):
        row = feature.attrs
        if not feature.parts or not feature.parts[0]:
            continue
        raw_name = row.get("MARKNAME2") or row.get("MARKNAME1", "")
        code_match = re.search(r"_([KVC])(\d+[Aa]?)$", raw_name)
        if not code_match:
            continue
        prefix, suffix = code_match.groups()
        numeric_suffix = int(re.match(r"\d+", suffix).group())
        if prefix == "K":
            system = "NTALRT"
            station_id = f"K{numeric_suffix:02d}"
        elif prefix == "V":
            system = "NTDLRT"
            station_id = f"V{numeric_suffix:02d}"
        else:
            system = "KLRT"
            station_id = f"C{suffix.upper()}"
        station = station_maps.get(system, {}).get(station_id)
        if station is None:
            continue
        x, y = feature.parts[0][0]
        lon, lat = twd97_tm2_to_wgs84(x, y)
        station_maps[system][station_id] = Station(
            station.system,
            station.station_id,
            station.uid,
            station.name,
            station.name_en,
            round(lon, 6),
            round(lat, 6),
        )

    # One TDX pseudo-stop represents a fare/timetable concept rather than a
    # physical station and must never enter the geometry topology.
    tra_wl = tuple(
        station_id
        for station_id in line_sequences[("TRA", "WL")]
        if station_id != "1001"
    )
    tra_el = line_sequences[("TRA", "EL")]
    tra_sl = line_sequences[("TRA", "SL")]
    tra_su = line_sequences[("TRA", "SU")]
    trtc_g = line_sequences[("TRTC", "G")]
    trtc_o = line_sequences[("TRTC", "O")]
    trtc_r = line_sequences[("TRTC", "R")]
    ntdlrt_v = line_sequences[("NTDLRT", "V")]

    def refs(system: str, station_ids: Sequence[str]) -> Tuple[Tuple[str, str], ...]:
        return tuple((system, station_id) for station_id in station_ids)

    specs: Tuple[LineSpec, ...] = (
        LineSpec(
            "tw-thsr-main",
            "台灣高速鐵路",
            "Taiwan High Speed Rail",
            "台灣高速鐵路股份有限公司",
            "#ED6D00",
            0,
            refs("THSR", line_sequences[("THSR", "THSR")]),
            (("THSR", "HSRL"),),
            is_hsr=True,
        ),
        LineSpec(
            "tw-tra-western-north",
            "縱貫線北段",
            "Western Trunk Line (North)",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            1,
            refs("TRA", subrange(tra_wl, "0900", "1250")),
            (("NLSC_TRA", "western-north"), ("TRA", "WL")),
        ),
        LineSpec(
            "tw-tra-western-south",
            "縱貫線南段",
            "Western Trunk Line (South)",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            1,
            refs("TRA", subrange(tra_wl, "3360", "4400")),
            (("NLSC_TRA", "western-south"), ("TRA", "WL")),
        ),
        LineSpec(
            "tw-tra-coast",
            "海岸線",
            "Coast Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            1,
            refs("TRA", line_sequences[("TRA", "WL-C")]),
            (
                ("NLSC_TRA", "coast"),
                ("NLSC_TRA", "chengzhui"),
                ("NLSC_TRA", "taichung"),
                ("NLSC_TRA", "western-south"),
                ("TRA", "WL-C"),
            ),
        ),
        LineSpec(
            "tw-tra-taichung",
            "臺中線",
            "Taichung Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            1,
            refs("TRA", subrange(tra_wl, "1250", "3360")),
            (("NLSC_TRA", "taichung"), ("TRA", "WL")),
        ),
        LineSpec(
            "tw-tra-pingtung",
            "屏東線",
            "Pingtung Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            1,
            refs(
                "TRA",
                subrange(tra_wl, "4400", "5000")
                + subrange(tra_sl, "5010", "5120"),
            ),
            (("NLSC_TRA", "pingtung"), ("TRA", "WL"), ("TRA", "SL")),
        ),
        LineSpec(
            "tw-tra-south-link",
            "南迴線",
            "South-Link Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            1,
            refs("TRA", subrange(tra_sl, "5120", "6000")),
            (("NLSC_TRA", "south-link"), ("TRA", "SL")),
        ),
        LineSpec(
            "tw-tra-taitung",
            "臺東線",
            "Taitung Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            1,
            refs("TRA", subrange(tra_el, "7000", "6000")),
            (("NLSC_TRA", "taitung"), ("TRA", "EL")),
        ),
        LineSpec(
            "tw-tra-north-link",
            "北迴線",
            "North-Link Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            1,
            refs("TRA", subrange(tra_el, "7130", "7000")),
            (("NLSC_TRA", "north-link"), ("TRA", "EL")),
        ),
        LineSpec(
            "tw-tra-yilan",
            "宜蘭線",
            "Yilan Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            1,
            refs("TRA", subrange(tra_el, "0920", "7130") + (tra_su[-1],)),
            (("NLSC_TRA", "yilan"), ("TRA", "EL"), ("TRA", "SU")),
        ),
        LineSpec(
            "tw-tra-neiwan",
            "內灣線",
            "Neiwan Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            3,
            refs("TRA", line_sequences[("TRA", "NW")]),
            (("NLSC_TRA", "neiwan"), ("TRA", "NW")),
        ),
        LineSpec(
            "tw-tra-liujia",
            "六家線",
            "Liujia Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            3,
            refs("TRA", line_sequences[("TRA", "LJ")]),
            (("NLSC_TRA", "liujia"), ("TRA", "LJ")),
        ),
        LineSpec(
            "tw-tra-pingxi",
            "平溪線",
            "Pingxi Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            3,
            refs("TRA", line_sequences[("TRA", "PX")]),
            (("NLSC_TRA", "pingxi"), ("TRA", "PX")),
            max_detour_ratio=8.0,
        ),
        LineSpec(
            "tw-tra-shenao",
            "深澳線",
            "Shen'ao Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            3,
            refs("TRA", line_sequences[("TRA", "SA")]),
            (("NLSC_TRA", "shenao"), ("TRA", "SA")),
        ),
        LineSpec(
            "tw-tra-jiji",
            "集集線",
            "Jiji Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            3,
            refs("TRA", line_sequences[("TRA", "JJ")]),
            (("NLSC_TRA", "jiji"), ("TRA", "JJ")),
        ),
        LineSpec(
            "tw-tra-shalun",
            "沙崙線",
            "Shalun Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            3,
            refs("TRA", line_sequences[("TRA", "SH")]),
            (("NLSC_TRA", "shalun"), ("TRA", "SH")),
        ),
        LineSpec(
            "tw-tra-chengzhui",
            "成追線",
            "Chengzhui Line",
            "國營臺灣鐵路股份有限公司",
            "#0B4DA2",
            3,
            refs("TRA", line_sequences[("TRA", "CZ")]),
            (("NLSC_TRA", "chengzhui"), ("TRA", "CZ")),
        ),
        LineSpec(
            "tw-trtc-bl",
            "板南線",
            "Bannan Line",
            "臺北大眾捷運股份有限公司",
            "#0070BD",
            2,
            refs("TRTC", line_sequences[("TRTC", "BL")]),
            (("TRTC", "BL"),),
        ),
        LineSpec(
            "tw-trtc-r",
            "淡水信義線",
            "Tamsui-Xinyi Line",
            "臺北大眾捷運股份有限公司",
            "#E3002C",
            2,
            refs("TRTC", tuple(value for value in trtc_r if value != "R22A")),
            (("TRTC", "R"),),
        ),
        LineSpec(
            "tw-trtc-r-xinbeitou",
            "新北投支線",
            "Xinbeitou Branch Line",
            "臺北大眾捷運股份有限公司",
            "#E3002C",
            3,
            refs("TRTC", ("R22", "R22A")),
            (("TRTC", "R"),),
        ),
        LineSpec(
            "tw-trtc-g",
            "松山新店線",
            "Songshan-Xindian Line",
            "臺北大眾捷運股份有限公司",
            "#008659",
            2,
            refs("TRTC", tuple(value for value in trtc_g if value != "G03A")),
            (("TRTC", "G"),),
        ),
        LineSpec(
            "tw-trtc-g-xiaobitan",
            "小碧潭支線",
            "Xiaobitan Branch Line",
            "臺北大眾捷運股份有限公司",
            "#008659",
            3,
            refs("TRTC", ("G03", "G03A")),
            (("TRTC", "G"),),
        ),
        LineSpec(
            "tw-trtc-o-luzhou",
            "中和新蘆線（蘆洲）",
            "Zhonghe-Xinlu Line (Luzhou)",
            "臺北大眾捷運股份有限公司",
            "#F8B61C",
            2,
            refs(
                "TRTC",
                subrange(trtc_o, "O01", "O12")
                + subrange(trtc_o, "O50", "O54"),
            ),
            (("TRTC", "O"),),
        ),
        LineSpec(
            "tw-trtc-o-huilong",
            "中和新蘆線（迴龍）",
            "Zhonghe-Xinlu Line (Huilong)",
            "臺北大眾捷運股份有限公司",
            "#F8B61C",
            2,
            refs("TRTC", subrange(trtc_o, "O01", "O21")),
            (("TRTC", "O"),),
        ),
        LineSpec(
            "tw-trtc-br",
            "文湖線",
            "Wenhu Line",
            "臺北大眾捷運股份有限公司",
            "#C48C31",
            2,
            refs("TRTC", line_sequences[("TRTC", "BR")]),
            (("TRTC", "BR"),),
        ),
        LineSpec(
            "tw-trtc-y",
            "環狀線",
            "Circular Line",
            "新北大眾捷運股份有限公司",
            "#FFD800",
            2,
            refs("NTMC", line_sequences[("NTMC", "Y")]),
            (("NTMC", "Y"),),
        ),
        LineSpec(
            "tw-tym-a",
            "桃園機場捷運",
            "Taoyuan Airport MRT",
            "桃園大眾捷運股份有限公司",
            "#8246AF",
            2,
            refs("TYMC", line_sequences[("TYMC", "A")]),
            (("TYMC", "A"),),
        ),
        LineSpec(
            "tw-tcmrt-g",
            "臺中捷運綠線",
            "Taichung MRT Green Line",
            "臺中捷運股份有限公司",
            "#00A651",
            2,
            refs("TMRT", line_sequences[("TMRT", "G")]),
            (("TMRT", "G"),),
        ),
        LineSpec(
            "tw-krtc-r",
            "高雄捷運紅線",
            "Kaohsiung MRT Red Line",
            "高雄捷運股份有限公司",
            "#E20A17",
            2,
            refs("KRTC", line_sequences[("KRTC", "R")]),
            (("KRTC", "R"),),
        ),
        LineSpec(
            "tw-krtc-o",
            "高雄捷運橘線",
            "Kaohsiung MRT Orange Line",
            "高雄捷運股份有限公司",
            "#F9A51A",
            2,
            refs("KRTC", line_sequences[("KRTC", "O")]),
            (("KRTC", "O"),),
        ),
        LineSpec(
            "tw-ntmetro-v-green",
            "淡海輕軌綠山線",
            "Danhai LRT Green Mountain Line",
            "新北大眾捷運股份有限公司",
            "#E5554F",
            3,
            refs("NTDLRT", subrange(ntdlrt_v, "V01", "V11")),
            (("NTDLRT", "V"),),
        ),
        LineSpec(
            "tw-ntmetro-v-blue",
            "淡海輕軌藍海線",
            "Danhai LRT Blue Sea Line",
            "新北大眾捷運股份有限公司",
            "#4AA8C7",
            3,
            refs("NTDLRT", ("V09", "V28", "V27", "V26")),
            (("NTDLRT", "V"),),
        ),
        LineSpec(
            "tw-ntmetro-k",
            "安坑輕軌",
            "Ankeng Light Rail",
            "新北大眾捷運股份有限公司",
            "#A1C058",
            3,
            refs("NTALRT", line_sequences[("NTALRT", "K")]),
            (("NTALRT", "K"),),
        ),
        LineSpec(
            "tw-klrt-c",
            "高雄環狀輕軌",
            "Kaohsiung Circular Light Rail",
            "高雄捷運股份有限公司",
            "#78C7D3",
            3,
            refs("KLRT", line_sequences[("KLRT", "C")]),
            (("KLRT", "C"),),
            is_loop=True,
        ),
    )

    alishan_stations = load_alishan_stations(args.alishan_stations)
    station_maps["AFR"] = {station.station_id: station for station in alishan_stations.values()}

    def afr_ref(name: str) -> Tuple[str, str]:
        if name not in alishan_stations:
            raise RuntimeError(f"official Alishan station is missing: {name}")
        return ("AFR", alishan_stations[name].station_id)

    afr_main_names = (
        "北門",
        "鹿麻產",
        "竹崎",
        "木屐寮",
        "樟腦寮",
        "獨立山",
        "梨園寮",
        "交力坪",
        "水社寮",
        "奮起湖",
        "多林",
        "十字路",
        "屏遮那",
        "二萬平",
        "神木",
        "阿里山",
    )
    # Official-track via points that keep the published alignment's spiral
    # and switchbacks in the display line.  Interval indexes are positions in
    # the station list (0 = 嘉義→北門).  Every coordinate lies on the scoped
    # official geometry; the resulting interval lengths match the AFR 營業里程
    # table (afrch.forest.gov.tw/0000120): 樟腦寮→獨立山 4.10 km,
    # 獨立山→梨園寮 4.00 km, 屏遮那→二萬平 6.98 km (two switchback tails),
    # 二萬平→阿里山 4.44 km (station-throat reversal tail).
    alishan_main_vias: Dict[int, Tuple[Coord, ...]] = {
        # 樟腦寮→獨立山: the Dulishan spiral's three loops.
        5: (
            (120.602321, 23.530515),
            (120.60924, 23.534054),
            (120.610938, 23.537219),
            (120.60973, 23.537383),
            (120.608077, 23.535966),
            (120.605552, 23.539132),
        ),
        # 獨立山→梨園寮: the spiral's exit loop over itself.
        6: ((120.603786, 23.535006),),
        # 屏遮那→二萬平: both zigzag reversal tails.
        13: (
            (120.795836, 23.521625),
            (120.789319, 23.513787),
        ),
        # 神木→阿里山: the reversal tail west of Alishan station.
        15: ((120.802671, 23.508749),),
    }
    afr_specs = (
        LineSpec(
            "tw-alsr-alishan",
            "阿里山線",
            "Alishan Line",
            "阿里山林業鐵路及文化資產管理處",
            "#C41230",
            4,
            (("TRA", "4080"),) + tuple(afr_ref(name) for name in afr_main_names),
            (("AFR", "MAIN"),),
            max_detour_ratio=24.0,
            via_points=alishan_main_vias,
        ),
        LineSpec(
            "tw-alsr-zhaoping",
            "沼平線",
            "Zhaoping Line",
            "阿里山林業鐵路及文化資產管理處",
            "#C41230",
            4,
            (afr_ref("阿里山"), afr_ref("沼平")),
            (("AFR", "NLSC"),),
            max_detour_ratio=12.0,
        ),
        LineSpec(
            "tw-alsr-shenmu",
            "神木線",
            "Sacred Tree Line",
            "阿里山林業鐵路及文化資產管理處",
            "#C41230",
            4,
            (afr_ref("阿里山"), afr_ref("神木")),
            (("AFR", "NLSC"),),
            max_detour_ratio=12.0,
        ),
        LineSpec(
            "tw-alsr-zhushan",
            "祝山線",
            "Zhushan Line",
            "阿里山林業鐵路及文化資產管理處",
            "#C41230",
            4,
            (afr_ref("阿里山"), afr_ref("對高岳"), afr_ref("祝山")),
            (("AFR", "ZHUSHAN"),),
            max_detour_ratio=24.0,
            # 對高岳→祝山: the Zhushan terminal loop; with it the branch
            # totals ~6.0 km against the official 6.25 km line length.
            via_points={1: ((120.82319, 23.509633),)},
        ),
    )
    specs = specs + afr_specs

    detail_features = load_shape_features(args.alishan_detail)
    current_rail_features = load_shape_features(args.alishan_rail)
    current_mrt_features = load_shape_features(args.nlsc_mrt)
    current_lrt_features = load_shape_features(args.nlsc_lrt)

    nlsc_mrt_systems = {
        "TRTC": "臺北捷運",
        "KRTC": "高雄捷運",
        "TYMC": "臺灣桃園國際機場捷運",
        "TMRT": "臺中捷運",
        "NTMC": "新北捷運",
    }
    nlsc_mrt_codes = {
        ("TRTC", "BL"): ("板南線",),
        ("TRTC", "BR"): ("文湖線",),
        ("TRTC", "G"): ("松山新店線", "小碧潭線"),
        ("TRTC", "O"): ("中和新蘆線",),
        ("TRTC", "R"): ("淡水信義線", "新北投線"),
        ("KRTC", "O"): ("橘線",),
        ("KRTC", "R"): ("紅線",),
        ("TYMC", "A"): ("機場捷運",),
        ("TMRT", "G"): ("綠線",),
        ("NTMC", "Y"): ("環狀線",),
    }
    for shape_ref, source_codes in nlsc_mrt_codes.items():
        source_system = nlsc_mrt_systems[shape_ref[0]]
        official_parts = []
        for feature in current_mrt_features:
            if feature.attrs.get("STATUS", "0") not in ("", "0"):
                continue
            if feature.attrs.get("MRTSYS", "") != source_system:
                continue
            if feature.attrs.get("MRTCODE", "") not in source_codes:
                continue
            official_parts.extend(
                [
                    [twd97_tm2_to_wgs84(x, y) for x, y in part]
                    for part in feature.parts
                    if len(part) >= 2
                ]
            )
        shape_parts[shape_ref].extend(official_parts)

    nlsc_lrt_codes = {
        ("NTDLRT", "V"): (
            "新北捷運",
            ("淡海輕軌綠山線", "淡海輕軌藍海線"),
        ),
        ("NTALRT", "K"): ("新北捷運", ("安坑輕軌",)),
        ("KLRT", "C"): ("高雄捷運", ("環狀輕軌",)),
    }
    for shape_ref, (source_system, source_codes) in nlsc_lrt_codes.items():
        official_parts = []
        for feature in current_lrt_features:
            if feature.attrs.get("STATUS", "0") not in ("", "0"):
                continue
            if feature.attrs.get("LRTSYS", "") != source_system:
                continue
            if feature.attrs.get("LRTCODE", "") not in source_codes:
                continue
            official_parts.extend(
                [
                    [twd97_tm2_to_wgs84(x, y) for x, y in part]
                    for part in feature.parts
                    if len(part) >= 2
                ]
            )
        shape_parts[shape_ref].extend(official_parts)

    taipei_route_refs = {
        "板橋線": (("TRTC", "BL"),),
        "南港線": (("TRTC", "BL"),),
        "木柵線": (("TRTC", "BR"),),
        "內湖線": (("TRTC", "BR"),),
        "新店線": (("TRTC", "G"),),
        "小南門線": (("TRTC", "G"),),
        "松山線": (("TRTC", "G"),),
        "碧潭支線": (("TRTC", "G"),),
        "中和線": (("TRTC", "O"),),
        "新莊線": (("TRTC", "O"),),
        "蘆洲線": (("TRTC", "O"),),
        "淡水線": (("TRTC", "R"),),
        "信義線": (("TRTC", "R"),),
        "環狀線": (("NTMC", "Y"),),
    }
    taipei_data = json.loads(args.taipei_metro.read_text(encoding="utf-8-sig"))
    taipei_parts: Dict[Tuple[str, str], List[List[Coord]]] = {}
    for feature in taipei_data.get("features", []):
        route_name = str(feature.get("properties", {}).get("RouteName", ""))
        refs_for_route = taipei_route_refs.get(route_name, ())
        geometry = feature.get("geometry", {})
        coordinates = geometry.get("coordinates", [])
        if geometry.get("type") == "LineString":
            raw_parts = [coordinates]
        elif geometry.get("type") == "MultiLineString":
            raw_parts = coordinates
        else:
            continue
        converted = [
            [twd97_tm2_to_wgs84(float(x), float(y)) for x, y in part]
            for part in raw_parts
            if len(part) >= 2
        ]
        for shape_ref in refs_for_route:
            taipei_parts.setdefault(shape_ref, []).extend(converted)
    for shape_ref, official_parts in taipei_parts.items():
        existing_count = len(shape_parts[shape_ref])
        shape_parts[shape_ref].extend(official_parts)
        # Prefer the detailed Taipei GIS curves only on equal length: a
        # sub-1.0 factor deep enough to reward detours (0.5 did) made the
        # router draw longer paths on the preferred source (景安→永安市場 grew
        # to 1.7 km against a 1.17 km straight line).
        shape_part_penalties[shape_ref] = [1.0] * existing_count + [0.95] * len(
            official_parts
        )
    nlsc_tra_names: Dict[str, Tuple[str, ...]] = {
        "western-north": ("臺鐵縱貫線(北段)",),
        "western-south": ("臺鐵縱貫線(南段)", "臺鐵縱貫線南段"),
        "coast": ("臺鐵縱貫線(海線)", "臺鐵海岸線(海線)"),
        "taichung": ("臺鐵臺中線(山線)",),
        "pingtung": ("臺鐵屏東線",),
        "south-link": ("臺鐵南迴線",),
        "taitung": ("臺鐵臺東線",),
        "north-link": ("臺鐵北迴線",),
        "yilan": ("臺鐵宜蘭線",),
        "neiwan": ("臺鐵內灣線",),
        "liujia": ("臺鐵六家線",),
        "pingxi": ("臺鐵平溪線",),
        "shenao": ("臺鐵深澳線",),
        "jiji": ("臺鐵集集線",),
        "shalun": ("臺鐵沙崙線",),
        "chengzhui": ("臺鐵成追線",),
    }
    nlsc_parts_by_name: Dict[str, List[List[Coord]]] = {}
    for feature in current_rail_features:
        if feature.attrs.get("STATUS", "0") not in ("", "0"):
            continue
        name = feature.attrs.get("RAILNAME", "")
        converted = [
            [twd97_tm2_to_wgs84(x, y) for x, y in part]
            for part in feature.parts
            if len(part) >= 2
        ]
        nlsc_parts_by_name.setdefault(name, []).extend(converted)
    # Never put unrelated railway names in one graph.  NLSC is the preferred
    # civil centreline and the matching TDX LineID may only close gaps inside
    # that same passenger line.  The penalty must stay low enough that a real
    # NLSC break is bridged by the TDX shape instead of a multi-kilometre
    # official-track detour: at 12x the router preferred a 9 km double-back on
    # the Taitung line over the 2.8 km TDX bridge through 豐田.
    for shape_ref, parts in tuple(shape_parts.items()):
        if shape_ref[0] == "TRA":
            shape_part_penalties[shape_ref] = [2.5] * len(parts)
    for key, names in nlsc_tra_names.items():
        parts = []
        for name in names:
            parts.extend(nlsc_parts_by_name.get(name, ()))
        if not parts:
            raise RuntimeError(f"NLSC official railway geometry is missing: {key}")
        shape_parts[("NLSC_TRA", key)] = parts

    detail_main = []
    detail_zhushan = []
    for feature in detail_features:
        converted = [
            [twd97_tm2_to_wgs84(x, y) for x, y in part]
            for part in feature.parts
            if len(part) >= 2
        ]
        if feature.attrs.get("LineName") == "本線":
            detail_main.extend(converted)
        elif feature.attrs.get("LineName") == "祝山線":
            detail_zhushan.extend(converted)
    current_alishan = []
    for feature in current_rail_features:
        name = feature.attrs.get("RAILNAME", "")
        if not name.startswith("阿里山林業鐵路"):
            continue
        if feature.attrs.get("STATUS", "0") not in ("", "0"):
            continue
        current_alishan.extend(
            [
                [twd97_tm2_to_wgs84(x, y) for x, y in part]
                for part in feature.parts
                if len(part) >= 2
            ]
        )
    if not detail_main or not detail_zhushan or not current_alishan:
        raise RuntimeError("official Alishan geometry sources are incomplete")
    shape_parts[("AFR", "MAIN")] = detail_main + current_alishan
    # The Ministry of Agriculture file begins the named Zhushan feature at
    # Shizifandao; NLSC supplies the Alishan approach, while the detailed MOA
    # feature closes NLSC's small mountain-top topology gap.
    shape_parts[("AFR", "ZHUSHAN")] = detail_zhushan + current_alishan
    shape_parts[("AFR", "NLSC")] = current_alishan

    all_stations = []
    resolved_stations: Dict[str, List[Station]] = {}
    for spec in specs:
        rows = []
        for system, station_id in spec.station_refs:
            station = station_maps.get(system, {}).get(station_id)
            if station is None:
                raise RuntimeError(
                    f"{spec.line_id}: official station missing: {system}:{station_id}"
                )
            rows.append(station)
        if len({station.uid for station in rows}) != len(rows):
            raise RuntimeError(f"{spec.line_id}: repeated official station")
        resolved_stations[spec.line_id] = rows
        all_stations.extend(rows)
    group_ids = build_group_ids(all_stations)

    graph_cache: Dict[Tuple[Tuple[str, str], ...], RailGraph] = {}
    official_parts_cache: Dict[
        Tuple[Tuple[str, str], ...], List[List[Coord]]
    ] = {}
    lines = []
    line_reports = {}
    conformance_vertices = 0
    conformance_edges = 0
    conformance_maximum = 0.0
    conformance_by_line: Dict[str, Dict[str, object]] = {}
    for spec in specs:
        if spec.shape_refs not in graph_cache:
            parts = []
            penalties = []
            for shape_ref in spec.shape_refs:
                if shape_ref not in shape_parts:
                    raise RuntimeError(
                        f"{spec.line_id}: official shape missing: {shape_ref}"
                    )
                parts.extend(shape_parts[shape_ref])
                penalties.extend(
                    shape_part_penalties.get(
                        shape_ref, [1.0] * len(shape_parts[shape_ref])
                    )
                )
            snap_meters = (
                40.0
                if any(
                    ref[0] in ("NLSC_TRA", "NTALRT")
                    for ref in spec.shape_refs
                )
                else SNAP_METERS
            )
            graph = build_graph(parts, snap_meters, penalties)
            if not graph.coords:
                raise RuntimeError(f"{spec.line_id}: official graph is empty")
            graph_cache[spec.shape_refs] = graph
            official_parts_cache[spec.shape_refs] = parts
        graph = graph_cache[spec.shape_refs]
        stations = resolved_stations[spec.line_id]
        segments, report = route_line(spec, stations, graph)
        conformance = audit_line_against_official(
            spec.line_id,
            segments,
            official_parts_cache[spec.shape_refs],
        )
        conformance_vertices += int(conformance["vertices"])
        conformance_edges += int(conformance["edges"])
        conformance_maximum = max(
            conformance_maximum, conformance["max_deviation_m"]
        )
        conformance_by_line[spec.line_id] = {
            "shapeRefs": [f"{system}:{line_id}" for system, line_id in spec.shape_refs],
            "vertices": int(conformance["vertices"]),
            "edgeMidpoints": int(conformance["edges"]),
            "maxDeviationMeters": round(conformance["max_deviation_m"], 3),
        }
        station_rows = []
        for station in stations:
            row: List[object] = [
                group_ids[station.uid],
                station.name,
                station.lon,
                station.lat,
            ]
            if station.name_en:
                row.extend((station.name_en, OFFICIAL_ROMA_SOURCE))
            station_rows.append(row)
        line: Dict[str, object] = {
            "id": spec.line_id,
            "name": spec.name,
            "operator": spec.operator,
            "rank": spec.rank,
            "color": spec.color,
            "nameRoma": spec.name_en,
        }
        if spec.is_hsr:
            line["isHSR"] = 1
        if spec.is_loop:
            line["isLoop"] = 1
        line["stations"] = station_rows
        line["segments"] = segments
        lines.append(line)
        line_reports[spec.line_id] = report
        print(
            f"{spec.line_id:28s} stations={len(stations):3d} "
            f"km={report['km']:8.1f} max_edge={report['max_edge_km']:.3f} "
            f"offset={report['max_station_offset_km']:.3f} "
            f"detour={report['max_detour_ratio']:.2f}x "
            f"official_delta={conformance['max_deviation_m']:.2f}m"
        )

    fingerprints = {
        key: hashlib.sha256(path.read_bytes()).hexdigest()
        for key, path in sorted(source_paths.items())
    }
    fingerprints.update(
        {
            "AFR:detail": hashlib.sha256(args.alishan_detail.read_bytes()).hexdigest(),
            "AFR:rail": hashlib.sha256(args.alishan_rail.read_bytes()).hexdigest(),
            "NLSC:MRT": hashlib.sha256(args.nlsc_mrt.read_bytes()).hexdigest(),
            "NLSC:LRT": hashlib.sha256(args.nlsc_lrt.read_bytes()).hexdigest(),
            "NLSC:LRTStation": hashlib.sha256(
                args.nlsc_lrt_stations.read_bytes()
            ).hexdigest(),
            "Taipei:MRT": hashlib.sha256(args.taipei_metro.read_bytes()).hexdigest(),
            "AFR:station": hashlib.sha256(
                args.alishan_stations.read_bytes()
            ).hexdigest(),
        }
    )
    package: Dict[str, object] = {
        "format": "compact-v1",
        "version": "2025.4.1",
        "generatedAt": utc_timestamp(update_times),
        "crs": "WGS84",
        "country": "TW",
        "lines": lines,
        "geometrySource": {
            "officialOnly": 1,
            "providers": [
                "交通部運輸資料流通服務（TDX/PTX）",
                "農業部阿里山林業鐵路及文化資產管理處",
                "內政部國土測繪中心",
            ],
            "license": "政府資料開放授權條款第1版",
            "tdxRevision": utc_timestamp(update_times),
            "nlscRailRevision": "1150409",
            "moaAlishanRevision": "11001",
            "osmSources": 0,
            "syntheticConnectors": 0,
            "officialGeometryComparison": {
                "scope": "LineID/RAILNAME/MRTCODE/LRTCODE",
                "lines": len(lines),
                "vertices": conformance_vertices,
                "edgeMidpoints": conformance_edges,
                "maxDeviationMeters": round(conformance_maximum, 3),
                "toleranceMeters": MAX_OFFICIAL_DEVIATION_METERS,
                "byLine": conformance_by_line,
            },
            "sourceSha256": fingerprints,
        },
    }
    audit = audit_package(package)
    if audit["lines"] != 38:
        raise RuntimeError(f"expected 38 lines, built {audit['lines']}")
    write_package(args.output, package)
    print(f"wrote {args.output}")
    print("audit " + json.dumps(audit, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
