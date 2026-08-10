#!/usr/bin/env python3
"""Build the Hong Kong rail datasets from official operator records.

Station names, line membership, colours and WGS84 station anchors come from
MTR's official journey-planner payload. Branch ordering comes from the
official ``mtr_lines_and_stations.csv`` open-data file. Track curves are cut
from the prepared route centre-lines in ``scripts/data/hk-track-alignments.json``
(built by scripts/build-hong-kong-track-alignments.py: official LandsD iB1000
geometry, with OSM route relations only where the public official map exposes
underground railways as undifferentiated generic tunnels).

Outputs (mirroring the Japan/Taiwan layout):
  public/rail/hk-2025.json         display package (compact-v1, line ids hk-mtr-*)
  data/rail-sections-hk.json       solver sections (country-neutral schema)
  data/stations-hk.json            solver stations (short on-track snap stubs)
  data/station-readings-hk.json    localized station names (zh-Hant/zh-Hans/ja/en)
  data/train-store-hk.json         the seeded-random official sample itinerary

Station codes (e.g. ``TML-MTR-WKS``) are STABLE identifiers persisted in
train stores and readings; they derive from the per-line ``codePrefix``
(the pre-normalization line alias), NOT from the display line id.

Usage:
  python3 scripts/build-hong-kong-rail-package.py \
    --mtr-html /tmp/mtr-jp.html \
    --mtr-csv /tmp/mtr_lines_and_stations.csv
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import re
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = APP_DIR / "data"
RAIL_DIR = APP_DIR / "public" / "rail"
TRACK_DATA = Path(__file__).resolve().parent / "data" / "hk-track-alignments.json"

PACKAGE_VERSION = "2025.2.0"
GENERATED_AT = "2026-08-10T00:00:00.000Z"

# Traditional→Simplified fallback covering the exact character set of the
# Hong Kong station/line names (MTR's own simplified-Chinese payload is the
# primary source; this map only fills rows the payload leaves blank, e.g.
# 鰂魚涌→鲗鱼涌 and 鍾屋村→钟屋村). Characters not listed are identical in
# both scripts.
HANT_TO_HANS = str.maketrans({
    "亞": "亚", "動": "动", "協": "协", "啟": "启", "圍": "围", "園": "园",
    "堅": "坚", "場": "场", "奧": "奥", "媽": "妈", "學": "学", "寶": "宝",
    "將": "将", "島": "岛", "嶺": "岭", "廟": "庙", "廠": "厂", "徑": "径",
    "恆": "恒", "悅": "悦", "愛": "爱", "會": "会", "東": "东", "榮": "荣",
    "樂": "乐", "橋": "桥", "機": "机", "橫": "横", "澤": "泽", "濕": "湿",
    "灣": "湾", "烏": "乌", "營": "营", "環": "环", "盤": "盘", "硤": "硖",
    "碼": "码", "窩": "窝", "紅": "红", "綫": "线", "線": "线", "羅": "罗",
    "聖": "圣", "臺": "台", "興": "兴", "蓮": "莲", "藍": "蓝", "覽": "览",
    "觀": "观", "調": "调", "豐": "丰", "車": "车", "軍": "军", "輕": "轻",
    "運": "运", "邊": "边", "醫": "医", "銀": "银", "銅": "铜", "錦": "锦",
    "鍾": "钟", "鐘": "钟", "鐵": "铁", "鑼": "锣", "鑽": "钻", "長": "长",
    "門": "门", "閣": "阁", "雲": "云", "頌": "颂", "頭": "头", "顯": "显",
    "館": "馆", "馬": "马", "魚": "鱼", "鰂": "鲗", "鳳": "凤", "鳴": "鸣",
    "黃": "黄", "龍": "龙",
})


def to_hans(text: str) -> str:
    return text.translate(HANT_TO_HANS)


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract_js_object(text: str, variable: str) -> dict:
    match = re.search(rf"var\s+{re.escape(variable)}\s*=\s*", text)
    if not match:
        raise RuntimeError(f"MTR payload does not define {variable}")
    start = match.end()
    depth = 0
    quote = None
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start : index + 1])
    raise RuntimeError(f"Unterminated {variable} payload")


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
        # Contract: segment i runs station i → station i+1 exactly (the app
        # and the package tests rely on shared endpoints). Snap the cut ends
        # to the projected station coordinates to kill float residue from
        # projection/rounding.
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
        # Internal build fields, stripped before the package is written:
        # codePrefix keeps persisted station codes stable across the display
        # line-id normalization; stationAliases align 1:1 with stations rows;
        # stationHans carries the operator's official simplified names.
        "codePrefix": code_prefix,
        "stationAliases": [station["alias"] for station in stations],
        "stationHans": [station.get("zh_hans") or "" for station in stations],
    }
    if loop:
        result["isLoop"] = 1
    return result


# Station features answer the solver's station-snap queries, so their
# geometry must stay a SHORT stub along the running line (Japan's N02
# platform lines are ~70 m, Taiwan's official stubs ~90-190 m). Emitting the
# whole neighbour interval here once put snap candidates kilometres from the
# station and collapsed every solved route to zero-length fragments.
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
        hans_names = line["stationHans"]
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
                # Stub runs forward along this station's own outgoing interval.
                stub = station_stub(segments[index][2])
            else:
                # Last station of a non-loop line: stub points back along the
                # final interval instead.
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
                "zh_Hans": hans_names[index] or to_hans(row[1]),
                "ja": "",
                "en": row[4],
            }
            by_code[code] = localized
            # Network alias, Taiwan-style: "{lineId}:{stationGroupId}" resolves
            # the same row for popups that only know the display network ids.
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
    # Prefer a multi-stop route so the sample demonstrates the full editor and
    # route-section workflow rather than only a two-station shuttle.
    candidates = [line for line in lines if len(line["stations"]) >= 3] or lines
    digest = hashlib.sha256(f"{country}:official-sample:2026-08-10".encode()).digest()
    line = candidates[int.from_bytes(digest[:4], "big") % len(candidates)]
    code_prefix = line["codePrefix"]
    aliases = line["stationAliases"]
    # Keep the generated demo inside the line by one station. The app's N02
    # compatibility solver treats a terminal station overlay as a one-sided
    # segment and can otherwise discard the last interval during continuity
    # stitching; the full line remains present in the national-network layer.
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
        clean = {key: value for key, value in line.items() if key not in {"codePrefix", "stationAliases", "stationHans"}}
        stripped.append(clean)
    return stripped


def build_hong_kong(html_path: Path, csv_path: Path, track_path: Path):
    track_data = json.loads(track_path.read_text())
    html = html_path.read_text(encoding="utf-8")
    heavy = extract_js_object(html, "heavyRailDetails")
    light = extract_js_object(html, "lightRailDetails")
    heavy_stations = {station["alias"]: station for station in heavy["stations"]}

    direction_rows = {}
    with csv_path.open(encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            direction_rows.setdefault((row["Line Code"], row["Direction"]), []).append(row["Station Code"])

    lines = []
    for source_line in heavy["lines"]:
        alias = source_line["alias"]
        if alias == "HSR":
            continue  # Hong Kong West Kowloon is the only station inside the SAR.
        variants = [(alias, source_line["nameTC"], source_line["name"], [heavy["stations"][[s["ID"] for s in heavy["stations"]].index(i)]["alias"] for i in source_line["stationIDs"]])]
        if alias == "EAL":
            variants = [
                ("EAL-LOW", "東鐵綫（羅湖支綫）", "East Rail Line (Lo Wu branch)", list(reversed(direction_rows[("EAL", "DT")]))),
                ("EAL-LMC", "東鐵綫（落馬洲支綫）", "East Rail Line (Lok Ma Chau branch)", direction_rows[("EAL", "LMC-UT")]),
            ]
        elif alias == "TKL":
            variants = [
                ("TKL-POA", "將軍澳綫（寶琳支綫）", "Tseung Kwan O Line (Po Lam branch)", list(reversed(direction_rows[("TKL", "DT")]))),
                ("TKL-LHP", "將軍澳綫（康城支綫）", "Tseung Kwan O Line (LOHAS Park branch)", direction_rows[("TKL", "TKS-UT")]),
            ]
        for code_prefix, name, english, station_aliases in variants:
            station_rows = []
            for station_alias in station_aliases:
                station = heavy_stations[station_alias]
                lat, lon = map(float, station["coordinate"].split(","))
                station_rows.append({
                    "group": f"hk-official-mtr-{station_alias.lower()}",
                    "alias": f"MTR-{station_alias}",
                    "zh": station["nameTC"], "zh_hans": station.get("nameSC", ""),
                    "en": station["name"], "lon": lon, "lat": lat,
                })
            line_id = f"hk-mtr-{code_prefix.lower()}"
            lines.append(compact_line(line_id, code_prefix, name, english, "MTR", "#" + source_line["color"], 1, station_rows, track_data["routes"][code_prefix]))

    light_stations = {str(station["ID"]): station for station in light["stations"]}
    for source_line in light["lines"]:
        route_number = source_line["ID"]
        station_rows = []
        for station_id in source_line["stationIDs"]:
            station = light_stations[str(station_id)]
            lat, lon = map(float, station["coordinate"].split(","))
            station_rows.append({
                "group": f"hk-official-lr-{station_id}",
                "alias": f"LR-{station_id}",
                "zh": station["nameTC"], "zh_hans": station.get("nameSC", ""),
                "en": station["name"], "lon": lon, "lat": lat,
            })
        loop = route_number in {"705", "706"}
        code_prefix = f"LR-{route_number}"
        line_id = f"hk-mtr-lr-{route_number.lower()}"
        lines.append(compact_line(line_id, code_prefix, "輕鐵" + route_number + "綫", "Light Rail " + route_number, "MTR", "#" + source_line["color"], 3, station_rows, track_data["routes"][code_prefix], loop=loop))

    build_derived_datasets("hk", lines, ["香港鐵路有限公司（MTR）官方行程指南及開放數據"])
    write_json(DATA_DIR / "train-store-hk.json", sample_store("hk", lines))
    package = {
        "format": "compact-v1",
        "version": PACKAGE_VERSION,
        "generatedAt": GENERATED_AT,
        "crs": "WGS84",
        "country": "HK",
        "lines": strip_build_fields(lines),
        "geometrySource": {
            "officialOnly": 0,
            "providers": [
                "MTR Corporation Limited (journey planner, lines & stations open data)",
                "OpenStreetMap contributors (track centre-lines)",
            ],
            "license": "MTR open data via DATA.GOV.HK terms; track centre-lines © OpenStreetMap contributors, ODbL",
            "authority": "MTR Corporation Limited (network, stations, service topology); OpenStreetMap (track geometry)",
            "stationData": "Official MTR journey planner and lines/stations open data",
            "method": "One continuous centre-line per line, chained from its OSM route relation by exact shared nodes (branches join at the true junction, no breakpoints), then despiked, Chaikin-rounded and re-simplified for display; station positions are projected onto the refined line",
            "urls": [
                "https://www.mtr.com.hk/en/customer/jp/index.php",
                "https://opendata.mtr.com.hk/data/mtr_lines_and_stations.csv",
                "https://opendata.mtr.com.hk/data/light_rail_routes_and_stops.csv",
                "https://www.openstreetmap.org/copyright",
            ],
            "sourceSha256": {
                "MTR:journey-planner-html": sha256_of(html_path),
                "MTR:lines-and-stations-csv": sha256_of(csv_path),
                "TRACKS:hk-track-alignments": sha256_of(track_path),
            },
        },
    }
    write_json(RAIL_DIR / "hk-2025.json", package)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mtr-html", type=Path, required=True)
    parser.add_argument("--mtr-csv", type=Path, required=True)
    parser.add_argument("--track-data", type=Path, default=TRACK_DATA)
    args = parser.parse_args()
    build_hong_kong(args.mtr_html, args.mtr_csv, args.track_data)
    print("Built the Hong Kong package, solver datasets, readings and sample store.")


if __name__ == "__main__":
    main()
