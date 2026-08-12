#!/usr/bin/env python3
"""Build the Korean rail datasets (kr-2025) from official records + OSM track.

Sources
  official : data/raw/railway/kr/official/*.csv — 국토교통부_도시철도 전체노선 (46 lines /
             1,103 stops in official order), 국가철도공단_철도역 정보 (intercity
             stations with WGS84 + 한자/영문 names), per-line 역위치 / 역간거리,
             한국철도공사 KTX 역정보 and 역 위치, 서울교통공사 역사 좌표.
             All 「이용허락범위 제한 없음」; see data/raw/railway/kr/official/manifest.json.
  track    : data/raw/railway/kr/kr-track-alignments.json (OpenStreetMap, ODbL), built
             by scripts/railway/build-korea-track-alignments.py.

Korea publishes no open track geometry (국가공간정보포털's 철도중심선 host no
longer resolves and V-World needs an account), so OSM supplies the centre lines
while every station identity, position and distance comes from the official
files.

Display lines are PHYSICAL railways, not operators' services: 수도권 전철 1호선
runs over 경부선 + 경인선 + 경원선 + 장항선 track, and drawing the services would
paint the same rails four times (the mistake the Hong Kong tramway forced us to
fix). Each official service is therefore recorded on the stations it serves.

Outputs (mirroring the Japan/Taiwan/Hong Kong/Macao layout):
  public/rail/kr-2025.json        display package (compact-v1, line ids kr-*)
  data/rail-sections-kr.json      solver sections (country-neutral schema)
  data/stations-kr.json           solver stations (short on-track snap stubs)
  data/station-readings-kr.json   localized station names (ko/한자/en)
  data/train-store-kr.json        seeded-random official sample itinerary

Usage:
  python3 scripts/railway/build-korea-rail-package.py
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

from lib.geometry import polyline_km, split_route, station_stub

try:  # optional: Traditional -> Simplified for the zh_Hans reading column
    from opencc import OpenCC

    _T2S = OpenCC("t2s")
except Exception:  # pragma: no cover - falls back to the Traditional form
    _T2S = None


def to_hans(text: str) -> str:
    return _T2S.convert(text) if (_T2S and text) else text


# Native-Korean station names have no 한자; a handful have a settled Chinese
# exonym instead (서울 = 首爾 / 首尔). Everything else stays empty so the reading
# is simply omitted rather than repeating the Hangul.
HANJA_OVERRIDES = {"서울": "首爾", "새절": "", "한티": ""}


def clean_hanja(text: str) -> str:
    """Official 역이름_중국어 is typeset with spaces and a trailing 驛 ("釜 山 驛")."""
    text = re.sub(r"\s+", "", text or "")
    return re.sub(r"[驛站]$", "", text)

APP_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = APP_DIR / "data"
RAIL_DIR = APP_DIR / "public" / "rail"
SOURCE_DATA = DATA_DIR / "raw" / "railway" / "kr"
TRACK_DATA = SOURCE_DATA / "kr-track-alignments.json"
OFFICIAL_DIR = SOURCE_DATA / "official"

PACKAGE_VERSION = "2025.1.0"
GENERATED_AT = "2026-08-11T00:00:00.000Z"
OFFICIAL_MATCH_M = 600.0        # official coordinate accepted this close to the OSM stop
MIN_LINE_KM = 0.8
MIN_LINE_STOPS = 2

# 인천공항 자기부상철도 has been suspended since 2023-09; 월미바다열차 and the
# airport shuttle are people movers inside one complex. Everything else in the
# alignment file that reaches MIN_LINE_STOPS is currently in service.
NOT_OPERATING = {"인천공항 자기부상철도", "인천공항 자기부상열차"}
# Service brands, not railways. KORAIL's metropolitan brands (수도권 전철 1호선,
# 경의·중앙선, 수인·분당선 …) run over 경부선 / 경인선 / 경원선 / 경의선 / 중앙선 /
# 분당선 / 수인선 track that is already in the registry; drawing them too would
# paint the same rails a second time and double the mileage.
SERVICE_PATTERNS = re.compile(
    r"(KTX|SRT|ITX|무궁화|새마을|누리로|셔틀|직통|일반열차|계통|급행|관광|열차"
    r"|수도권 전철|광역전철|·)")
COVER_SAMPLE_M = 200.0      # spacing when testing a candidate against drawn track
COVER_RADIUS_M = 60.0       # counted as "already drawn" within this distance
COVER_FRACTION = 0.85       # skip the candidate above this covered fraction

# N02 code space, reused for Korea (jsonspec §2.3): institution 1 high speed,
# 2 national trunk, 3 publicly operated urban, 4 private/light; railway class
# 11/12 conventional heavy rail, 21 light rail / AGT, 31 special (monorail,
# maglev, funicular).
HIGH_SPEED_LINES = {"경부고속선", "호남고속선", "수서평택고속선", "수도권고속선"}
PUBLIC_URBAN_OPERATORS = ("교통공사", "메트로", "도시철도")


def read_csv(path: Path):
    rows = list(csv.reader(path.read_text(encoding="utf-8").splitlines()))
    if not rows:
        return [], []
    header = [c.strip() for c in rows[0]]
    return header, [r for r in rows[1:] if any(c.strip() for c in r)]


def col(header, *names):
    for name in names:
        for index, value in enumerate(header):
            if value.replace(" ", "") == name:
                return index
    return None


SEPARATORS = re.compile(r"[·・∙\.\s]+")


def norm_station(name: str) -> str:
    name = re.sub(r"\([^)]*\)", "", name or "").strip()
    name = re.sub(r"역$", "", name).strip()
    return SEPARATORS.sub("", name)


# ------------------------------------------------------------ romanization
INITIALS = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j",
            "jj", "ch", "k", "t", "p", "h"]
VOWELS = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae",
          "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"]
FINALS = ["", "k", "k", "k", "n", "n", "n", "t", "l", "l", "l", "l", "l", "l",
          "l", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"]


def romanize(text: str) -> str:
    """Revised Romanization, transliteration only (no assimilation rules).

    Used for ids, station code aliases and `nameRoma` when the official English
    name is missing; official 영문역사명 / OSM `name:en` always win.
    """
    out = []
    for ch in text or "":
        code = ord(ch)
        if 0xAC00 <= code <= 0xD7A3:
            index = code - 0xAC00
            out.append(INITIALS[index // 588] + VOWELS[(index % 588) // 28] + FINALS[index % 28])
        elif ch.isalnum():
            out.append(ch)
        else:
            out.append(" ")
    return re.sub(r"\s+", " ", "".join(out)).strip()


def slug(text: str) -> str:
    base = romanize(text).lower()
    base = unicodedata.normalize("NFKD", base)
    base = re.sub(r"[^a-z0-9]+", "-", base).strip("-")
    return base or "line"


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    path.write_bytes(raw)
    with gzip.GzipFile(filename="", mode="wb", fileobj=open(str(path) + ".gz", "wb"), mtime=0) as out:
        out.write(raw)


def metres(a, b):
    return math.hypot((a[0] - b[0]) * 88800.0, (a[1] - b[1]) * 110540.0)


def turn_degrees(a, b, c):
    v1 = ((b[0] - a[0]) * 88800.0, (b[1] - a[1]) * 110540.0)
    v2 = ((c[0] - b[0]) * 88800.0, (c[1] - b[1]) * 110540.0)
    n1 = math.hypot(*v1)
    n2 = math.hypot(*v2)
    if not n1 or not n2:
        return 0.0
    cos = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
    return math.degrees(math.acos(cos))


def drop_anchor_kinks(geometry, max_turn=60.0, max_edge=40.0):
    """Remove hairpins left where a cut end was snapped onto a station anchor."""
    changed = True
    while changed and len(geometry) > 2:
        changed = False
        for index in range(1, len(geometry) - 1):
            turn = turn_degrees(geometry[index - 1], geometry[index], geometry[index + 1])
            edge = min(metres(geometry[index - 1], geometry[index]),
                       metres(geometry[index], geometry[index + 1]))
            if turn > max_turn and edge < max_edge:
                del geometry[index]
                changed = True
                break
    return geometry


# --------------------------------------------------------------- official
class Official:
    def __init__(self, directory: Path):
        self.points = {}          # normalized name -> (lon, lat)
        self.hanja = {}           # normalized name -> 한자
        self.english = {}         # normalized name -> English
        self.services = defaultdict(list)   # normalized name -> ["운영기관|노선"]
        self.line_order = {}      # "운영기관|노선" -> [station names in order]
        self.gaps = defaultdict(dict)       # 노선 -> {station: 역간거리 km}
        self.files = []
        for path in sorted(directory.glob("*.csv")):
            self.files.append(path.name)
            header, body = read_csv(path)
            self._absorb(header, body)

    def _absorb(self, header, body):
        name_i = col(header, "역명", "역사명", "역이름")
        lon_i = col(header, "경도", "역경도", "경도좌표")
        lat_i = col(header, "위도", "역위도", "위도좌표")
        line_i = col(header, "노선명", "선명")
        seq_i = col(header, "순번")
        op_i = col(header, "철도운영기관명", "철도운영기관", "운영기관명")
        han_i = col(header, "역이름_중국어", "한자역사명")
        eng_i = col(header, "역이름_영어", "영문역사명")
        gap_i = col(header, "역간거리", "역간거리km")
        related_i = col(header, "관련노선")
        if name_i is None:
            return
        for row in body:
            if len(row) <= name_i:
                continue
            raw = row[name_i].strip()
            key = norm_station(raw)
            if not key:
                continue
            if lon_i is not None and lat_i is not None and len(row) > max(lon_i, lat_i):
                try:
                    lon, lat = float(row[lon_i]), float(row[lat_i])
                    if 124 < lon < 132 and 33 < lat < 39:
                        self.points.setdefault(key, (lon, lat))
                except ValueError:
                    pass
            if han_i is not None and len(row) > han_i and row[han_i].strip():
                self.hanja.setdefault(key, row[han_i].strip())
            if eng_i is not None and len(row) > eng_i and row[eng_i].strip():
                self.english.setdefault(key, row[eng_i].strip())
            if line_i is not None and len(row) > line_i and row[line_i].strip():
                service = f"{row[op_i].strip() if op_i is not None and len(row) > op_i else ''}|{row[line_i].strip()}"
                if service not in self.services[key]:
                    self.services[key].append(service)
                if seq_i is not None and len(row) > seq_i and row[seq_i].strip().isdigit():
                    self.line_order.setdefault(service, []).append((int(row[seq_i]), raw))
                if gap_i is not None and len(row) > gap_i:
                    try:
                        self.gaps[row[line_i].strip()][key] = float(row[gap_i])
                    except ValueError:
                        pass
            if related_i is not None and len(row) > related_i:
                for part in row[related_i].split(","):
                    part = part.strip()
                    if part and f"코레일|{part}" not in self.services[key]:
                        self.services[key].append(f"코레일|{part}")

    def ordered(self, service):
        rows = self.line_order.get(service) or []
        return [name for _, name in sorted(rows)]


# ------------------------------------------------------------- line build
class DrawnTrack:
    """Grid of the track already claimed by registered lines."""

    CELL = 0.002  # ~200 m

    def __init__(self):
        self.cells = defaultdict(list)

    def add(self, coords):
        for a, b in zip(coords, coords[1:]):
            steps = max(1, int(metres(a, b) / (COVER_SAMPLE_M / 2)))
            for k in range(steps + 1):
                f = k / steps
                lon, lat = a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
                self.cells[(int(lat / self.CELL), int(lon / self.CELL))].append((lon, lat))

    def covered_fraction(self, coords):
        samples, hits = 0, 0
        for a, b in zip(coords, coords[1:]):
            steps = max(1, int(metres(a, b) / COVER_SAMPLE_M))
            for k in range(steps):
                f = k / steps
                lon, lat = a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
                samples += 1
                ci, cj = int(lat / self.CELL), int(lon / self.CELL)
                found = False
                for i in (ci - 1, ci, ci + 1):
                    for j in (cj - 1, cj, cj + 1):
                        for pt in self.cells.get((i, j), ()):
                            if metres((lon, lat), pt) <= COVER_RADIUS_M:
                                found = True
                                break
                        if found:
                            break
                    if found:
                        break
                hits += found
        return hits / samples if samples else 0.0


def choose_lines(track, official):
    """Registry of physical lines: named-way infrastructure + relation-only lines.

    A candidate is rejected when its track is already drawn — by name (service
    brands) or geometrically (>= COVER_FRACTION of it runs within COVER_RADIUS_M
    of a line already in the registry).
    """
    named = track["named_lines"]
    relations = track["relation_lines"]
    registry = {}
    drawn = DrawnTrack()
    ordered = sorted(named.items(), key=lambda kv: -kv[1]["km"])
    for name, line in ordered:
        if name in NOT_OPERATING or line["km"] < MIN_LINE_KM or len(line["stops"]) < MIN_LINE_STOPS:
            continue
        if drawn.covered_fraction(line["coords"]) >= COVER_FRACTION:
            print(f"  - skip {name}: already drawn")
            continue
        registry[name] = dict(line, display=name, source="named-ways")
        drawn.add(line["coords"])
    for name, line in sorted(relations.items(), key=lambda kv: -kv[1]["km"]):
        if name in NOT_OPERATING or SERVICE_PATTERNS.search(name):
            continue
        if line["km"] < MIN_LINE_KM or len(line["stops"]) < MIN_LINE_STOPS:
            continue
        keys = {norm_station(s["name"]) for s in line["stops"]}
        # Geometric coverage misses a relation that adds a branch to the line
        # already drawn (서울 지하철 2호선 carries 성수지선 and 신정지선), so a
        # relation whose stops are mostly already served counts as drawn too.
        served = 0.0
        for existing in registry.values():
            ekeys = {norm_station(s["name"]) for s in existing["stops"]}
            served = max(served, len(keys & ekeys) / len(keys) if keys else 0.0)
        if drawn.covered_fraction(line["coords"]) >= COVER_FRACTION or served >= 0.7:
            # same rails: keep the physical entry, lift the better name + livery
            best, score = None, 0.0
            for other, existing in registry.items():
                ekeys = {norm_station(s["name"]) for s in existing["stops"]}
                overlap = len(keys & ekeys) / len(keys) if keys else 0.0
                if overlap > score:
                    best, score = other, overlap
            if best and score >= 0.5:
                existing = registry[best]
                # OSM names Seoul's own subway track just "7호선"; the relation
                # carries the full "서울 지하철 7호선". Only bare numbers are lifted
                # so a relation like "태백선 백산 방면" never renames 태백선.
                if len(existing["display"]) <= 4 and name.endswith(existing["display"]):
                    existing["display"] = name
                if not existing.get("colour"):
                    existing["colour"] = line.get("colour")
                if not existing.get("operator"):
                    existing["operator"] = line.get("operator")
                existing["relation"] = line.get("relation")
            continue
        registry[name] = dict(line, display=name, source="relation")
        drawn.add(line["coords"])
    return registry


def classify(name, line, operator):
    if name in HIGH_SPEED_LINES:
        return "1", "11"
    route = line.get("route") or ""
    if route in {"monorail"} or "자기부상" in name:
        return "4", "31"
    if route in {"light_rail", "tram"}:
        return "4", "21"
    if route == "subway" or any(k in (operator or "") for k in PUBLIC_URBAN_OPERATORS):
        return "3", "12"
    if operator and ("코레일" in operator or "한국철도" in operator):
        return "2", "11"
    return "4", "12"


def build_lines(track, official):
    registry = choose_lines(track, official)
    group_ids = {}
    group_counts = defaultdict(int)
    lines = []
    for name, line in sorted(registry.items(), key=lambda kv: -kv[1]["km"]):
        stops = [s for s in line["stops"]]
        if len(stops) < MIN_LINE_STOPS:
            continue
        display = line.get("display") or name
        operator = line.get("operator") or ""
        institution, railway_class = classify(name, line, operator)
        prefix = f"KR-{slug(display).upper()[:18]}"
        rows = []
        for stop in stops:
            key = norm_station(stop["name"])
            point = (stop["lon"], stop["lat"])
            official_point = official.points.get(key)
            source = "osm"
            if official_point and metres(official_point, point) <= OFFICIAL_MATCH_M:
                point = official_point
                source = "official"
            if key not in group_ids:
                group_counts[key] += 1
                suffix = "" if group_counts[key] == 1 else f"-{group_counts[key]}"
                group_ids[key] = f"kr-official-{slug(stop['name'])}{suffix}"
            rows.append({
                "group": group_ids[key],
                "alias": slug(stop["name"]).upper()[:24] or "STN",
                "name": stop["name"],
                "key": key,
                "en": official.english.get(key) or stop.get("name_en") or romanize(stop["name"]).title(),
                "hanja": HANJA_OVERRIDES.get(
                    key, clean_hanja(official.hanja.get(key) or stop.get("name_zh") or "")),
                "lon": point[0],
                "lat": point[1],
                "coord_source": source,
                "services": official.services.get(key, []),
            })
        # aliases must stay unique inside a line (station codes are persisted ids)
        seen = defaultdict(int)
        for row in rows:
            seen[row["alias"]] += 1
            if seen[row["alias"]] > 1:
                row["alias"] = f"{row['alias']}-{seen[row['alias']]}"
        route = [list(c) for c in line["coords"]]
        try:
            station_points, segments = split_route(route, [[r["lon"], r["lat"]] for r in rows])
            # Two stations can project onto the same point on a line that only
            # passes one of them (a parallel platform, a duplicated OSM stop);
            # that would emit a zero-length segment, so the later one is dropped.
            keep = [0]
            for index in range(1, len(station_points)):
                if metres(station_points[index], station_points[keep[-1]]) >= 5.0:
                    keep.append(index)
            if len(keep) < len(rows):
                rows = [rows[i] for i in keep]
                station_points, segments = split_route(
                    route, [[r["lon"], r["lat"]] for r in rows])
        except RuntimeError as error:
            print(f"  !! {display}: {error}")
            continue
        for row, coordinate in zip(rows, station_points):
            row["snapped"] = list(coordinate)
        prepared = []
        for index, geometry in enumerate(segments):
            geometry = [list(c) for c in geometry]
            geometry[0] = list(station_points[index])
            geometry[-1] = list(station_points[index + 1])
            if len(geometry) > 2 and geometry[0] == geometry[1]:
                geometry.pop(1)
            if len(geometry) > 2 and geometry[-1] == geometry[-2]:
                geometry.pop(-2)
            # Snapping the ends onto the station anchor can leave a hairpin at
            # the vertex next to it; drop those so the grooming contract (no
            # >60-degree turn on a sub-40 m edge) survives the cut.
            geometry = drop_anchor_kinks(geometry)
            prepared.append([polyline_km(geometry), 0, geometry])
        lines.append({
            "id": f"kr-{slug(display)}",
            "name": display,
            "operator": operator or "코레일",
            "rank": 1 if institution == "1" else 2 if institution == "2" else 3,
            "color": (line.get("colour") if (line.get("colour") or "").startswith("#")
                      else "#C60C30" if institution == "1" else "#0067A3"),
            "nameRoma": romanize(display).title(),
            "stations": [[r["group"], r["name"], r["snapped"][0], r["snapped"][1], r["en"], 3] for r in rows],
            "segments": prepared,
            "isHSR": 1 if institution == "1" else 0,
            # build-only fields, stripped before the package is written
            "codePrefix": prefix,
            "stationRows": rows,
            "institution": institution,
            "railwayClass": railway_class,
        })
    return lines


def build_derived(country, lines, sources):
    sections, stations = [], []
    by_code, by_name = {}, {}
    for line in lines:
        prefix = line["codePrefix"]
        for segment in line["segments"]:
            sections.append({
                "type": "Feature",
                "properties": {
                    "railway_class_code": line["railwayClass"],
                    "institution_type_code": line["institution"],
                    "line_name": line["name"],
                    "operator": line["operator"],
                },
                "geometry": {"type": "LineString", "coordinates": segment[2]},
            })
        for index, row in enumerate(line["stationRows"]):
            code = f"{prefix}-{row['alias']}"
            segments = line["segments"]
            if index < len(segments):
                stub = station_stub(segments[index][2])
            else:
                stub = station_stub(list(reversed(segments[index - 1][2])))
            stations.append({
                "type": "Feature",
                "properties": {
                    "railway_class_code": line["railwayClass"],
                    "institution_type_code": line["institution"],
                    "line_name": line["name"],
                    "operator": line["operator"],
                    "station_name": row["name"],
                    "n02_station_code": code,
                    "n02_group_code": row["group"],
                    "display_point": row["snapped"],
                },
                "geometry": {"type": "LineString", "coordinates": stub},
            })
            hanja = row["hanja"] if row["hanja"] != row["name"] else ""
            localized = {
                "name": row["name"],
                "zh_Hant": hanja,
                "zh_Hans": to_hans(hanja),
                "ja": "",
                "en": row["en"],
            }
            by_code[code] = localized
            by_code[f"{line['id']}:{row['group']}"] = localized
            by_name.setdefault(row["name"], localized)
    readings = {
        "note": "Official Korean station names; 한자 and English come from the official station files (OSM name:ko-Hani fills gaps), Korean is the base name.",
        "country": country.upper(),
        "languages": ["ko", "zh-Hant", "zh-Hans", "en"],
        "officialRevision": "2026-08-11",
        "packageVersion": PACKAGE_VERSION,
        "sources": sources,
        "stats": {"byCode": len(by_code), "byName": len(by_name)},
        "byCode": by_code,
        "byName": by_name,
    }
    write_json(DATA_DIR / f"rail-sections-{country}.json",
               {"type": "FeatureCollection", "features": sections})
    write_json(DATA_DIR / f"stations-{country}.json",
               {"type": "FeatureCollection", "features": stations})
    write_json(DATA_DIR / f"station-readings-{country}.json", readings)
    return len(sections), len(stations)


def sample_store(country, lines):
    # A representative service: national trunk / high speed / urban rail with a
    # real chain of stops, never a tourist shuttle or a two-station branch.
    candidates = [l for l in lines
                  if l["institution"] in {"1", "2", "3"} and 10 <= len(l["stationRows"]) <= 60] or lines
    digest = hashlib.sha256(f"{country}:official-sample:2026-08-11".encode()).digest()
    line = candidates[int.from_bytes(digest[:4], "big") % len(candidates)]
    rows = line["stationRows"][: min(len(line["stationRows"]), 12)]
    prefix = line["codePrefix"]
    stops, sections = [], []
    for index, row in enumerate(rows):
        code = f"{prefix}-{row['alias']}"
        stops.append({
            "name": row["name"],
            "n02_station_code": code,
            "arrival": None,
            "departure": None,
            "stop_type": "origin" if index == 0 else "destination" if index == len(rows) - 1 else "passenger_stop",
            "ride_segment": True,
        })
        if index + 1 < len(rows):
            sections.append({
                "from_n02_station_code": code,
                "to_n02_station_code": f"{prefix}-{rows[index + 1]['alias']}",
                "line_names": [line["name"]],
                "operator_names": [line["operator"]],
            })
    train = {
        "id": f"KR-SAMPLE-{slug(line['name']).upper()}",
        "date": "2026-08-11",
        "number": f"{line['name']} 공식 노선 예시",
        "train_type": "예시 열차",
        "company": line["operator"],
        "origin": rows[0]["name"],
        "destination": rows[-1]["name"],
        "direction": "down",
        "visible": True,
        "style": {"color": line["color"]},
        "route_policy": {
            "mode": "single_primary_route",
            "jr_only": False,
            "allow_alternatives": False,
            "allow_browser_straight_line_fallback": False,
            "allowed_institution_type_codes": [line["institution"]],
            "preferred_line_names": [line["name"]],
            "preferred_operator_names": [line["operator"]],
            "institution_filter_mode": "hard",
        },
        "route_sections": sections,
        "stops": stops,
    }
    return {"schema_version": "1.3", "trains": [train]}


def strip_build_fields(lines):
    drop = {"codePrefix", "stationRows", "institution", "railwayClass"}
    return [{k: v for k, v in line.items() if k not in drop} for line in lines]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--track-data", type=Path, default=TRACK_DATA)
    parser.add_argument("--official-dir", type=Path, default=OFFICIAL_DIR)
    args = parser.parse_args()

    track = json.loads(args.track_data.read_text())
    official = Official(args.official_dir)
    lines = build_lines(track, official)
    total_km = sum(sum(s[0] for s in line["segments"]) for line in lines)
    stations_total = sum(len(line["stations"]) for line in lines)
    print(f"lines {len(lines)} | stations {stations_total} | drawn {total_km:.1f} km")

    sources = ["국토교통부_도시철도 전체노선", "국가철도공단_철도역 정보",
               "한국철도공사_KTX 노선별 역정보", "국가철도공단 노선별 역위치/역간거리",
               "OpenStreetMap (track geometry, ODbL)"]
    n_sections, n_stations = build_derived("kr", lines, sources)
    write_json(DATA_DIR / "train-store-kr.json", sample_store("kr", lines))
    package = {
        "format": "compact-v1",
        "version": PACKAGE_VERSION,
        "generatedAt": GENERATED_AT,
        "crs": "WGS84",
        "country": "KR",
        "lines": strip_build_fields(lines),
        "geometrySource": {
            "officialOnly": 0,
            "osmSources": 1,
            "syntheticConnectors": 0,
            "providers": [
                "국토교통부 / 국가철도공단 / 한국철도공사 / 서울교통공사 open data (data.go.kr)",
                "OpenStreetMap contributors",
            ],
            "license": "data.go.kr 이용허락범위 제한 없음 (official records); ODbL (OpenStreetMap track geometry)",
            "authority": "국가철도공단 · 한국철도공사 · 국토교통부",
            "stationData": "Official station files: order (도시철도 전체노선 순번), positions, 한자/영문 names",
            "method": "OSM route relations chained by shared node ids, and named-way lines rebuilt by routing between their own stations; groomed (despike, Chaikin x2, 1.5 m simplify) and split at projected official station positions",
            "urls": [
                "https://www.data.go.kr/data/15122916/fileData.do",
                "https://www.data.go.kr/data/15067652/fileData.do",
                "https://download.geofabrik.de/asia/south-korea.html",
                "https://www.openstreetmap.org/copyright",
            ],
            "sourceSha256": {
                "TRACKS:kr-track-alignments": sha256_of(args.track_data),
                "OFFICIAL:manifest": sha256_of(args.official_dir / "manifest.json"),
            },
        },
    }
    write_json(RAIL_DIR / "kr-2025.json", package)
    print(f"sections {n_sections} | station features {n_stations}")
    print("Built the Korean package, solver datasets, readings and sample store.")


if __name__ == "__main__":
    main()
