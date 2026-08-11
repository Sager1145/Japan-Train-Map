#!/usr/bin/env python3
"""Build the Hong Kong rail datasets from official operator records.

Station names, line membership, colours and WGS84 station anchors come from
MTR's official journey-planner payload. Branch ordering comes from the
official ``mtr_lines_and_stations.csv`` open-data file. Track curves are cut
from the prepared route centre-lines in ``scripts/railway/data/hk-track-alignments.json``
(built by scripts/railway/build-hong-kong-track-alignments.py: official LandsD iB1000
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
  python3 scripts/railway/build-hong-kong-rail-package.py \
    --mtr-html /tmp/mtr-jp.html \
    --mtr-csv /tmp/mtr_lines_and_stations.csv
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import re
from pathlib import Path

from lib.geometry import (
    STATION_STUB_METERS,
    haversine_km,
    point_at,
    polyline_km,
    project_to_route,
    route_measures,
    route_slice,
    split_route,
    station_stub,
)


APP_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = APP_DIR / "data"
RAIL_DIR = APP_DIR / "public" / "rail"
SCRIPT_DATA = Path(__file__).resolve().parent / "data"
TRACK_DATA = SCRIPT_DATA / "hk-track-alignments.json"
TRAM_TRACK_DATA = SCRIPT_DATA / "hk-tram-alignments.json"
TRAM_STOPS_CSV = {
    "zh_Hant": SCRIPT_DATA / "hk-tramways-stops-tc.csv",
    "zh_Hans": SCRIPT_DATA / "hk-tramways-stops-sc.csv",
    "en": SCRIPT_DATA / "hk-tramways-stops-en.csv",
}

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


def sample_store(country: str, lines: list[dict], operator: str | None = None) -> dict:
    # Stable pseudo-random pick: reproducible builds, but not a hand-selected showcase.
    # Prefer a multi-stop route so the sample demonstrates the full editor and
    # route-section workflow rather than only a two-station shuttle.
    # `operator` pins the pool the digest indexes into, so extending the
    # package with another operator's network cannot silently reshuffle the
    # sample itinerary that is already persisted in train stores.
    pool = [line for line in lines if operator is None or line["operator"] == operator]
    candidates = [line for line in pool if len(line["stations"]) >= 3] or pool
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


# ── Hong Kong Tramways ──────────────────────────────────────────────────────
# The tramway joins the package as its PHYSICAL network — the two through
# tracks plus the two branches that carry scheduled service — and not as the
# six numbered services, which all share the same rails and would draw (and
# count) the same corridor five or six times over. See
# scripts/railway/build-hong-kong-track-alignments.py for how the four are cut.
#
# Hong Kong Tramways is a separate operator from MTR, and that operator name
# is what splits the statistics buckets (classifyHkSectionMask in app-stats.js).
TRAM_OPERATOR = "香港電車"
# The company's own corporate green. The six well-known route colours belong
# to the SERVICES, so none of them describes a physical track.
TRAM_COLOR = "#007549"
# (line id, codePrefix, alignment key, 中文名, English name)
TRAM_LINES = [
    ("hk-tram-east", "TRAM-E", "TRAM-EAST", "電車東行綫", "Tramways Eastbound"),
    ("hk-tram-west", "TRAM-W", "TRAM-WEST", "電車西行綫", "Tramways Westbound"),
    ("hk-tram-hv", "TRAM-HV", "TRAM-HV", "電車跑馬地支綫", "Tramways Happy Valley Branch"),
    ("hk-tram-np", "TRAM-NP", "TRAM-NPT", "電車北角支綫", "Tramways North Point Branch"),
]
# The operator files every terminus under the same stop code "T", so the OSM
# terminus codes carry the identity and this maps them back onto the official
# row — and therefore onto the official names in all three scripts.
TRAM_TERMINUS_NAMES = {
    "KTT": "堅尼地城總站", "WST": "石塘咀總站", "WMT": "上環 (西港城) 總站",
    "CBT": "銅鑼灣總站", "NPT": "北角總站", "SKT": "筲箕灣總站",
    "HVT": "跑馬地總站",
}


def load_tram_stop_names(paths: dict[str, Path]) -> dict[str, dict[str, str]]:
    """The operator's stop list, by stop code, in the three published scripts.

    The three files are the same table in three languages, so they are read
    row for row rather than joined on a key the Chinese editions spell
    differently.
    """
    columns = {}
    for language, path in paths.items():
        with path.open(encoding="utf-8-sig", newline="") as source:
            rows = [row for row in csv.reader(source) if len(row) >= 3][1:]
        columns[language] = [(row[1].strip(), row[2].strip()) for row in rows]
    lengths = {len(rows) for rows in columns.values()}
    if len(lengths) != 1:
        raise RuntimeError(f"the official tram stop lists disagree on length: {lengths}")
    names = {}
    terminals = {}
    for index in range(lengths.pop()):
        code = columns["zh_Hant"][index][0]
        entry = {language: rows[index][1] for language, rows in columns.items()}
        if code == "T":
            terminals[entry["zh_Hant"]] = entry
        else:
            names[code] = entry
    for code, official in TRAM_TERMINUS_NAMES.items():
        if official not in terminals:
            raise RuntimeError(f"the official tram stop list has no terminus named {official}")
        names[code] = terminals[official]
    return names


def build_tram_lines(track_path: Path, stop_names: dict[str, dict[str, str]]) -> list[dict]:
    track = json.loads(track_path.read_text())
    lines = []
    served = set()
    for line_id, code_prefix, route_key, name, english in TRAM_LINES:
        route = track["routes"].get(route_key)
        if not route:
            raise RuntimeError(f"tram alignments are missing {route_key}")
        station_rows = []
        for stop in route["stops"]:
            official = stop_names.get(stop["code"])
            if not official:
                raise RuntimeError(f"{route_key}: stop {stop['code']} is not in the official stop list")
            served.add(stop["code"])
            station_rows.append({
                "group": f"hk-official-tram-{stop['code'].lower()}",
                "alias": stop["code"],
                "zh": official["zh_Hant"], "zh_hans": official["zh_Hans"],
                "en": official["en"], "lon": stop["lon"], "lat": stop["lat"],
            })
        lines.append(compact_line(
            line_id, code_prefix, name, english, TRAM_OPERATOR, TRAM_COLOR, 3,
            station_rows, route["coordinates"],
        ))
    skipped = sorted(set(stop_names) - served - set(TRAM_TERMINUS_NAMES))
    print(f"Tramways: {len(served)} official stops on 4 tracks; depot-only stops not served: {skipped}")
    return lines


def branch_variants(trunk, branch):
    """A trunk row plus a branch row that starts at their junction station.

    The operator publishes a branched line as two complete end-to-end services
    (東鐵綫 to 羅湖 and to 落馬洲 share 34 km of the same track). Stored that
    way the map has to guess whether that shared track is one railway or two.
    So the branch keeps only its OWN run — from the last station it shares with
    the trunk to its terminus — and both rows carry the line's name, which is
    how the renderer knows they are one railway.
    """
    # Prefixes stay exactly as they were: they are baked into persisted
    # station codes and readings, which never follow a display rename.
    code_prefix, name, english, trunk_aliases = trunk
    branch_prefix, branch_aliases = branch
    on_trunk = set(trunk_aliases)
    junction = 0
    for index, alias in enumerate(branch_aliases):
        if alias not in on_trunk:
            junction = max(0, index - 1)
            break
    return [
        (code_prefix, name, english, trunk_aliases),
        (branch_prefix, name, english, branch_aliases[junction:]),
    ]


def build_hong_kong(html_path: Path, csv_path: Path, track_path: Path, tram_track_path: Path, tram_stops: dict[str, Path]):
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
            # ONE railway with a branch, not two railways. 東鐵綫 runs to 羅湖;
            # 落馬洲 hangs off 上水. Both rows therefore carry the LINE's name,
            # which is what makes the renderer treat their shared 34 km as a
            # trunk and its branch — drawn over the same coordinates — instead
            # of as two independent railways to be pulled into parallel lanes
            # (scripts/railway/lib/parallel-corridors.mjs corridorRenderMode).
            variants = branch_variants(
                ("EAL-LOW", "東鐵綫", "East Rail Line", list(reversed(direction_rows[("EAL", "DT")]))),
                ("EAL-LMC", direction_rows[("EAL", "LMC-UT")]),
            )
        elif alias == "TKL":
            # Same shape: 將軍澳綫 runs to 寶琳, 康城 hangs off 將軍澳.
            variants = branch_variants(
                ("TKL-POA", "將軍澳綫", "Tseung Kwan O Line", list(reversed(direction_rows[("TKL", "DT")]))),
                ("TKL-LHP", direction_rows[("TKL", "TKS-UT")]),
            )
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

    lines.extend(build_tram_lines(tram_track_path, load_tram_stop_names(tram_stops)))

    build_derived_datasets(
        "hk",
        lines,
        [
            "香港鐵路有限公司（MTR）官方行程指南及開放數據",
            "香港電車有限公司官方電車站開放數據（DATA.GOV.HK）",
        ],
    )
    write_json(DATA_DIR / "train-store-hk.json", sample_store("hk", lines, operator="MTR"))
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
                "Hong Kong Tramways, Limited (tram stops open data via DATA.GOV.HK)",
                "OpenStreetMap contributors (track centre-lines)",
            ],
            "license": "MTR and Hong Kong Tramways open data via DATA.GOV.HK terms; track centre-lines © OpenStreetMap contributors, ODbL",
            "authority": "MTR Corporation Limited and Hong Kong Tramways, Limited (network, stations, service topology); OpenStreetMap (track geometry)",
            "stationData": "Official MTR journey planner and lines/stations open data; official Hong Kong Tramways tram stop list",
            "method": "One continuous centre-line per line, chained from its OSM route relation by exact shared nodes (branches join at the true junction, no breakpoints), then despiked, Chaikin-rounded and re-simplified for display; station positions are projected onto the refined line. The tramway is carried as its physical tracks — the two through directions plus the Happy Valley and 春秧街 branches — because its six numbered services all run over the same rails",
            "urls": [
                "https://www.mtr.com.hk/en/customer/jp/index.php",
                "https://opendata.mtr.com.hk/data/mtr_lines_and_stations.csv",
                "https://opendata.mtr.com.hk/data/light_rail_routes_and_stops.csv",
                "https://data.gov.hk/en-data/dataset/hktramways-hktramways-tram-stops",
                "https://data.gov.hk/en-data/dataset/hktramways-hktramways-main-routes",
                "https://www.openstreetmap.org/copyright",
            ],
            "sourceSha256": {
                "MTR:journey-planner-html": sha256_of(html_path),
                "MTR:lines-and-stations-csv": sha256_of(csv_path),
                "TRACKS:hk-track-alignments": sha256_of(track_path),
                "TRAMWAYS:tram-stops-csv": sha256_of(tram_stops["zh_Hant"]),
                "TRACKS:hk-tram-alignments": sha256_of(tram_track_path),
            },
        },
    }
    write_json(RAIL_DIR / "hk-2025.json", package)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mtr-html", type=Path, required=True)
    parser.add_argument("--mtr-csv", type=Path, required=True)
    parser.add_argument("--track-data", type=Path, default=TRACK_DATA)
    parser.add_argument("--tram-track-data", type=Path, default=TRAM_TRACK_DATA)
    args = parser.parse_args()
    build_hong_kong(args.mtr_html, args.mtr_csv, args.track_data, args.tram_track_data, TRAM_STOPS_CSV)
    print("Built the Hong Kong package, solver datasets, readings and sample store.")


if __name__ == "__main__":
    main()
