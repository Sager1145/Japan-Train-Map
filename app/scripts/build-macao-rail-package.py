#!/usr/bin/env python3
"""Build the Macao LRT rail datasets from official operator records.

The current line and station order comes from the Macao LRT Corporation
route page; the small coordinate table is traced from the operator's
published station maps. Track curves are cut from the prepared route
centre-lines in ``scripts/data/mo-track-alignments.json`` (built by
scripts/build-macao-track-alignments.py from DSCC's official Online Map).

Outputs (mirroring the Japan/Taiwan layout):
  public/rail/mo-2025.json         display package (compact-v1, line ids mo-mlm-*)
  data/rail-sections-mo.json       solver sections (country-neutral schema)
  data/stations-mo.json            solver stations (short on-track snap stubs)
  data/station-readings-mo.json    localized station names (zh-Hant/zh-Hans/ja/en)
  data/train-store-mo.json         the seeded-random official sample itinerary

Station codes (e.g. ``MLM-TAIPA-MLM-BARRA``) are STABLE identifiers persisted
in train stores and readings; they derive from the per-line ``codePrefix``
(the pre-normalization line alias), NOT from the display line id.

Usage:
  python3 scripts/build-macao-rail-package.py
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = APP_DIR / "data"
RAIL_DIR = APP_DIR / "public" / "rail"
TRACK_DATA = Path(__file__).resolve().parent / "data" / "mo-track-alignments.json"

PACKAGE_VERSION = "2025.2.0"
GENERATED_AT = "2026-08-10T00:00:00.000Z"

# Traditional→Simplified map covering the exact character set of the Macao
# station/line names. Characters not listed are identical in both scripts.
HANT_TO_HANS = str.maketrans({
    "亞": "亚", "媽": "妈", "會": "会", "東": "东", "機": "机", "橫": "横",
    "灣": "湾", "碼": "码", "運": "运", "醫": "医", "閣": "阁", "馬": "马",
    "協": "协", "蓮": "莲", "場": "场", "頭": "头",
})


def to_hans(text: str) -> str:
    return text.translate(HANT_TO_HANS)


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def haversine_km(a: list[float], b: list[float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return round(6371.0088 * 2 * math.asin(math.sqrt(h)), 3)


def polyline_km(points: list[list[float]]) -> float:
    return round(sum(haversine_km(a, b) for a, b in zip(points, points[1:])), 3)


def route_measures(route):
    # Cumulative METERS along the polyline.
    measures = [0.0]
    for a, b in zip(route, route[1:]):
        measures.append(measures[-1] + haversine_km(a, b) * 1000)
    return measures


def project_to_route(point, route, measures, min_measure=0.0, max_measure=float("inf")):
    best = (float("inf"), 0.0, route[0])
    latitude = math.radians(point[1])
    scale_x = 111_320 * math.cos(latitude)
    for index, (start, end) in enumerate(zip(route, route[1:])):
        if measures[index + 1] + 1e-6 < min_measure or measures[index] - 1e-6 > max_measure:
            continue
        ax, ay = (start[0] - point[0]) * scale_x, (start[1] - point[1]) * 111_320
        bx, by = (end[0] - point[0]) * scale_x, (end[1] - point[1]) * 111_320
        dx, dy = bx - ax, by - ay
        lower = 0 if measures[index + 1] == measures[index] else max(0, (min_measure - measures[index]) / (measures[index + 1] - measures[index]))
        upper = 1 if measures[index + 1] == measures[index] else min(1, (max_measure - measures[index]) / (measures[index + 1] - measures[index]))
        ratio = lower if dx == dy == 0 else max(lower, min(upper, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        distance = math.hypot(ax + ratio * dx, ay + ratio * dy)
        projected = [start[0] + ratio * (end[0] - start[0]), start[1] + ratio * (end[1] - start[1])]
        measure = measures[index] + ratio * (measures[index + 1] - measures[index])
        if distance < best[0]:
            best = (distance, measure, projected)
    return best


def point_at(route, measures, target):
    target = max(0, min(measures[-1], target))
    for index in range(len(measures) - 1):
        if measures[index + 1] >= target:
            span = measures[index + 1] - measures[index]
            ratio = 0 if span == 0 else (target - measures[index]) / span
            return [
                route[index][0] + ratio * (route[index + 1][0] - route[index][0]),
                route[index][1] + ratio * (route[index + 1][1] - route[index][1]),
            ]
    return route[-1]


def route_slice(route, measures, start, end):
    result = [point_at(route, measures, start)]
    result.extend(route[index] for index in range(1, len(route) - 1) if start < measures[index] < end)
    result.append(point_at(route, measures, end))
    deduped = [result[0]]
    for point in result[1:]:
        if point != deduped[-1]:
            deduped.append(point)
    return deduped


def split_route(route, station_points, *, loop=False):
    candidates = []
    for oriented in (route, list(reversed(route))):
        measures = route_measures(oriented)
        projected = [project_to_route(point, oriented, measures) for point in station_points]
        if loop:
            start = projected[0][1]
            rotated = route_slice(oriented, measures, start, measures[-1])
            tail = route_slice(oriented, measures, 0, start)
            rotated.extend(tail[1:])
            oriented, measures = rotated, route_measures(rotated)
            projected = [project_to_route(point, oriented, measures) for point in station_points]
            projected[0] = (projected[0][0], 0.0, oriented[0])
        ordered = list(projected)
        for index in range(len(ordered) - 2, -1, -1):
            if ordered[index][1] > ordered[index + 1][1]:
                minimum_gap = min(50, haversine_km(station_points[index], station_points[index + 1]) * 250)
                ordered[index] = project_to_route(station_points[index], oriented, measures, max_measure=ordered[index + 1][1] - minimum_gap)
        for index in range(1, len(ordered)):
            if ordered[index][1] < ordered[index - 1][1]:
                ordered[index] = project_to_route(station_points[index], oriented, measures, min_measure=ordered[index - 1][1])
        fit_penalty = sum(item[0] for item in ordered)
        endpoint_penalty = ordered[0][0] + ordered[-1][0]
        candidates.append((fit_penalty, endpoint_penalty, oriented, measures, ordered))
    _, _, route, measures, projected = min(candidates, key=lambda item: (item[0], item[1]))
    station_coordinates = [item[2] for item in projected]
    segment_count = len(station_points) if loop else len(station_points) - 1
    segments = []
    for index in range(segment_count):
        start = projected[index][1]
        end = measures[-1] if loop and index == len(station_points) - 1 else projected[index + 1][1]
        segments.append(route_slice(route, measures, start, end))
    return station_coordinates, segments


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    path.write_bytes(raw)
    with gzip.GzipFile(filename="", mode="wb", fileobj=open(str(path) + ".gz", "wb"), mtime=0) as out:
        out.write(raw)


def compact_line(line_id, code_prefix, name, english, operator, color, rank, stations, route, *, loop=False):
    try:
        station_coordinates, route_segments = split_route(
            route, [[station["lon"], station["lat"]] for station in stations], loop=loop
        )
    except RuntimeError as error:
        raise RuntimeError(f"{line_id}: {error}") from error
    rows = []
    for station, coordinate in zip(stations, station_coordinates):
        rows.append([
            station["group"], station["zh"], coordinate[0], coordinate[1], station["en"], 3
        ])
    segments = []
    for index, geometry in enumerate(route_segments):
        # Contract: segment i runs station i → station i+1 exactly (shared
        # endpoints); snap the cut ends to the projected station coordinates.
        geometry = list(geometry)
        geometry[0] = list(station_coordinates[index])
        geometry[-1] = list(station_coordinates[(index + 1) % len(station_coordinates)])
        if len(geometry) > 2 and geometry[0] == geometry[1]:
            geometry.pop(1)
        if len(geometry) > 2 and geometry[-1] == geometry[-2]:
            geometry.pop(-2)
        segments.append([polyline_km(geometry), 0, geometry])
    result = {
        "id": line_id,
        "name": name,
        "operator": operator,
        "rank": rank,
        "color": color,
        "nameRoma": english,
        "stations": rows,
        "segments": segments,
        # Internal build fields, stripped before the package is written.
        "codePrefix": code_prefix,
        "stationAliases": [station["alias"] for station in stations],
    }
    if loop:
        result["isLoop"] = 1
    return result


# Short on-track snap stubs — see build-hong-kong-rail-package.py for the
# rationale (Japan ~70 m platform lines, Taiwan ~90-190 m stubs).
STATION_STUB_METERS = 180.0


def station_stub(segment_coords: list) -> list:
    measures = route_measures(segment_coords)
    limit = min(STATION_STUB_METERS, measures[-1])
    if limit <= 0:
        return [segment_coords[0], segment_coords[-1]]
    return route_slice(segment_coords, measures, 0.0, limit)


def build_derived_datasets(country: str, lines: list[dict], source_names: list[str]):
    sections = []
    stations = []
    by_code = {}
    by_name = {}
    seen_names = set()
    for line in lines:
        code_prefix = line["codePrefix"]
        station_rows = line["stations"]
        aliases = line["stationAliases"]
        for segment in line["segments"]:
            sections.append({
                "type": "Feature",
                "properties": {
                    "railway_class_code": "21",
                    "institution_type_code": "4",
                    "line_name": line["name"],
                    "operator": line["operator"],
                },
                "geometry": {"type": "LineString", "coordinates": segment[2]},
            })
        for index, row in enumerate(station_rows):
            code = f"{code_prefix}-{aliases[index]}"
            segments = line["segments"]
            if index < len(segments):
                stub = station_stub(segments[index][2])
            else:
                stub = station_stub(list(reversed(segments[index - 1][2])))
            props = {
                "railway_class_code": "21",
                "institution_type_code": "4",
                "line_name": line["name"],
                "operator": line["operator"],
                "station_name": row[1],
                "n02_station_code": code,
                "n02_group_code": row[0],
                "display_point": [row[2], row[3]],
            }
            stations.append({
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "LineString", "coordinates": stub},
            })
            localized = {
                "name": row[1],
                "zh_Hant": row[1],
                "zh_Hans": to_hans(row[1]),
                "ja": "",
                "en": row[4],
            }
            by_code[code] = localized
            by_code[f"{line['id']}:{row[0]}"] = localized
            if row[1] not in seen_names:
                by_name[row[1]] = localized
                seen_names.add(row[1])
    readings = {
        "note": "Official operator station names for the four UI languages; unavailable translations are empty.",
        "country": country.upper(),
        "languages": ["zh-Hant", "zh-Hans", "ja", "en"],
        "officialRevision": "2026-08-10",
        "packageVersion": PACKAGE_VERSION,
        "sources": source_names,
        "stats": {"byCode": len(by_code), "byName": len(by_name)},
        "byCode": by_code,
        "byName": by_name,
    }
    write_json(DATA_DIR / f"rail-sections-{country}.json", {"type": "FeatureCollection", "features": sections})
    write_json(DATA_DIR / f"stations-{country}.json", {"type": "FeatureCollection", "features": stations})
    write_json(DATA_DIR / f"station-readings-{country}.json", readings)


def sample_store(country: str, lines: list[dict]) -> dict:
    # Stable pseudo-random pick: reproducible builds, but not a hand-selected showcase.
    candidates = [line for line in lines if len(line["stations"]) >= 3] or lines
    digest = hashlib.sha256(f"{country}:official-sample:2026-08-10".encode()).digest()
    line = candidates[int.from_bytes(digest[:4], "big") % len(candidates)]
    code_prefix = line["codePrefix"]
    aliases = line["stationAliases"]
    keep = len(line["stations"]) - 1 if len(line["stations"]) > 2 else len(line["stations"])
    rows = line["stations"][:keep]
    sections = []
    stops = []
    for index, row in enumerate(rows):
        code = f"{code_prefix}-{aliases[index]}"
        stop_type = "origin" if index == 0 else "destination" if index == len(rows) - 1 else "passenger_stop"
        stops.append({
            "name": row[1],
            "n02_station_code": code,
            "arrival": None,
            "departure": None,
            "stop_type": stop_type,
            "ride_segment": True,
        })
        if index + 1 < len(rows):
            sections.append({
                "from_n02_station_code": code,
                "to_n02_station_code": f"{code_prefix}-{aliases[index + 1]}",
                "line_names": [line["name"]],
                "operator_names": [line["operator"]],
            })
    train = {
        "id": f"{country.upper()}-SAMPLE-{code_prefix}",
        "date": "2026-08-10",
        "number": f"{line['name']} 官方路線示例",
        "train_type": "示例列車",
        "company": line["operator"],
        "origin": rows[0][1],
        "destination": rows[-1][1],
        "direction": "down",
        "visible": True,
        "style": {"color": line["color"]},
        "route_policy": {
            "mode": "single_primary_route",
            "jr_only": False,
            "allow_alternatives": False,
            "allow_browser_straight_line_fallback": False,
            "allowed_institution_type_codes": ["4"],
            "preferred_line_names": [line["name"]],
            "preferred_operator_names": [line["operator"]],
            "institution_filter_mode": "hard",
        },
        "route_sections": sections,
        "stops": stops,
    }
    return {"schema_version": "1.3", "trains": [train]}


def strip_build_fields(lines: list[dict]) -> list[dict]:
    stripped = []
    for line in lines:
        clean = {key: value for key, value in line.items() if key not in {"codePrefix", "stationAliases"}}
        stripped.append(clean)
    return stripped


def build_macao(track_path: Path):
    track_data = json.loads(track_path.read_text())
    anchors = track_data["stationAnchors"]
    stations = {
        "BARRA": ("媽閣", "Barra"), "OCEAN": ("海洋", "Ocean"),
        "JOCKEY": ("馬會", "Jockey Club"), "STADIUM": ("運動場", "Stadium"),
        "PAIKOK": ("排角", "Pai Kok"), "COTAIW": ("路氹西", "Cotai West"),
        "LOTUS": ("蓮花", "Lotus"), "HOSPITAL": ("協和醫院", "Union Hospital"),
        "EAG": ("東亞運", "East Asian Games"), "COTAIE": ("路氹東", "Cotai East"),
        "MUST": ("科大", "MUST"), "AIRPORT": ("機場", "Airport"),
        "FERRY": ("氹仔碼頭", "Taipa Ferry Terminal"),
        "SEACPAIVAN": ("石排灣", "Seac Pai Van"), "HENGQIN": ("橫琴", "Hengqin"),
    }

    def rows(ids):
        return [{
            "group": f"mo-official-mlm-{code.lower()}",
            "alias": f"MLM-{code}",
            "zh": stations[code][0], "en": stations[code][1],
            "lon": anchors[stations[code][1]][0], "lat": anchors[stations[code][1]][1],
        } for code in ids]

    # Passenger-facing operator label used consistently by the map, popup,
    # solver constraints and generated sample train. The legal corporate name
    # remains in the package's source attribution below.
    operator = "澳門輕軌"
    lines = [
        compact_line("mo-mlm-taipa", "MLM-TAIPA", "氹仔線", "Taipa Line", operator, "#72BF44", 1, rows(["BARRA", "OCEAN", "JOCKEY", "STADIUM", "PAIKOK", "COTAIW", "LOTUS", "HOSPITAL", "EAG", "COTAIE", "MUST", "AIRPORT", "FERRY"]), track_data["routes"]["MLM-TAIPA"]),
        compact_line("mo-mlm-spv", "MLM-SPV", "石排灣線", "Seac Pai Van Line", operator, "#F58220", 1, rows(["HOSPITAL", "SEACPAIVAN"]), track_data["routes"]["MLM-SPV"]),
        compact_line("mo-mlm-hengqin", "MLM-HENGQIN", "橫琴線", "Hengqin Line", operator, "#00A6CE", 1, rows(["LOTUS", "HENGQIN"]), track_data["routes"]["MLM-HENGQIN"]),
    ]
    build_derived_datasets("mo", lines, ["澳門輕軌官方路線及車站資料"])
    write_json(DATA_DIR / "train-store-mo.json", sample_store("mo", lines))
    package = {
        "format": "compact-v1",
        "version": PACKAGE_VERSION,
        "generatedAt": GENERATED_AT,
        "crs": "WGS84",
        "country": "MO",
        "lines": strip_build_fields(lines),
        "geometrySource": {
            "officialOnly": 1,
            "providers": [
                "Macao Light Rapid Transit Corporation, Limited (routes and stations)",
                "Cartography and Cadastre Bureau (DSCC) Online Map",
            ],
            "license": "Official DSCC Online Map data; Macao LRT Corporation published route and station records",
            "authority": "Macao Light Rapid Transit Corporation, Limited and Cartography and Cadastre Bureau (DSCC)",
            "stationData": "Official LRT Lines page and DSCC Online Map route markers",
            "method": "Official DSCC LRT route polylines and station markers converted from EPSG:8433 to WGS84, simplified at two-metre tolerance and split at projected station positions",
            "urls": [
                "https://www.mlm.com.mo/en/route.html",
                "https://webmap.gis.gov.mo",
                "https://www.dscc.gov.mo/en/services_system.html",
            ],
            "sourceSha256": {
                "TRACKS:mo-track-alignments": sha256_of(track_path),
            },
        },
    }
    write_json(RAIL_DIR / "mo-2025.json", package)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--track-data", type=Path, default=TRACK_DATA)
    args = parser.parse_args()
    build_macao(args.track_data)
    print("Built the Macao package, solver datasets, readings and sample store.")


if __name__ == "__main__":
    main()
