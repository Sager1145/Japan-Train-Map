#!/usr/bin/env python3
"""Publish the East Rail Racecourse rejoining variant from retained geometry.

The normal Hong Kong builder needs two operator payloads that were not archived
in this repository.  This targeted, idempotent sync keeps the retained
Racecourse alignment, the compact display package, and the isolated Hong Kong
solver/readings datasets consistent until those upstream payloads are restored.
"""

from __future__ import annotations

import gzip
import hashlib
import importlib.util
import json
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]
RAW_DIR = APP_DIR / "data" / "raw" / "railway" / "hk"
ALIGNMENT_SOURCE = RAW_DIR / "eal-racecourse-alignment.json"
TRACK_DATA = RAW_DIR / "hk-track-alignments.json"
PACKAGE = APP_DIR / "public" / "rail" / "hk-2025.json"
SECTIONS = APP_DIR / "data" / "rail-sections-hk.json"
STATIONS = APP_DIR / "data" / "stations-hk.json"
READINGS = APP_DIR / "data" / "station-readings-hk.json"

LINE_ID = "hk-mtr-eal-rac"
CODE_PREFIX = "EAL-RAC"
GENERATED_AT = "2026-08-21T00:00:00.000Z"


def load_builder():
    path = Path(__file__).with_name("build-hong-kong-rail-package.py")
    spec = importlib.util.spec_from_file_location("hk_rail_builder", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_json(path: Path, value: object, *, compressed: bool = True) -> None:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    path.write_bytes(raw)
    if compressed:
        with Path(str(path) + ".gz").open("wb") as handle:
            with gzip.GzipFile(filename="", mode="wb", fileobj=handle, mtime=0) as out:
                out.write(raw)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    builder = load_builder()
    source = json.loads(ALIGNMENT_SOURCE.read_text("utf-8"))
    route = source["coordinates"]

    package = json.loads(PACKAGE.read_text("utf-8"))
    main_line = next(line for line in package["lines"] if line["id"] == "hk-mtr-eal-low")
    station_rows = [
        {
            "group": "hk-official-mtr-sht", "alias": "MTR-SHT",
            "zh": "沙田", "zh_hans": "沙田", "en": "Sha Tin",
            "lon": 114.1876419, "lat": 22.3828402,
        },
        {
            "group": "hk-official-mtr-rac", "alias": "MTR-RAC",
            "zh": "馬場", "zh_hans": "马场", "en": "Racecourse",
            "lon": 114.2029649, "lat": 22.4004416,
        },
        {
            "group": "hk-official-mtr-uni", "alias": "MTR-UNI",
            "zh": "大學", "zh_hans": "大学", "en": "University",
            "lon": 114.2100545, "lat": 22.4133852,
        },
    ]
    line = builder.compact_line(
        LINE_ID,
        CODE_PREFIX,
        "東鐵綫",
        "East Rail Line",
        "MTR",
        main_line["color"],
        main_line["rank"],
        station_rows,
        route,
    )

    # Retain the alignment in the shared HK route catalogue used by both
    # package builders.  The small source file above keeps its evidence and
    # extraction method reviewable without a 160 kB one-line diff.
    track_data = json.loads(TRACK_DATA.read_text("utf-8"))
    track_data.setdefault("routes", {})["EAL-RAC"] = route
    track_data.setdefault("refinement", {})["EAL-RAC"] = {
        "points": len(route),
        "sourceRelation": 6587853,
        "shapeClass": "rejoining_variant",
    }
    write_json(TRACK_DATA, track_data, compressed=False)

    clean_line = builder.strip_build_fields([line])[0]
    for field in ("colorReference", "colorDark"):
        if field in main_line:
            clean_line[field] = main_line[field]
    package["lines"] = [row for row in package["lines"] if row["id"] != LINE_ID]
    insert_at = next(
        index + 1
        for index, row in enumerate(package["lines"])
        if row["id"] == "hk-mtr-eal-low"
    )
    package["lines"].insert(insert_at, clean_line)
    package["version"] = "2025.2.1"
    package["generatedAt"] = GENERATED_AT
    geometry_source = package["geometrySource"]
    method_note = (
        " The East Rail Racecourse path is a separate Sha Tin–Racecourse–University "
        "rejoining variant, matching the branch decomposition used for Japanese railways."
    )
    if "Racecourse path" not in geometry_source["method"]:
        geometry_source["method"] += method_note
    geometry_source.setdefault("urls", [])
    for url in (source["source"]["stationUrl"], source["source"]["geometryUrl"]):
        if url not in geometry_source["urls"]:
            geometry_source["urls"].append(url)
    hashes = geometry_source.setdefault("sourceSha256", {})
    hashes["TRACKS:hk-track-alignments"] = sha256(TRACK_DATA)
    hashes["TRACKS:eal-racecourse-alignment"] = sha256(ALIGNMENT_SOURCE)
    write_json(PACKAGE, package)

    sections = json.loads(SECTIONS.read_text("utf-8"))
    sections["features"] = [
        feature
        for feature in sections["features"]
        if feature.get("properties", {}).get("display_line_id") != LINE_ID
    ]
    for segment in line["segments"]:
        sections["features"].append({
            "type": "Feature",
            "properties": {
                "railway_class_code": "21",
                "institution_type_code": "4",
                "line_name": "東鐵綫",
                "operator": "MTR",
                "display_line_id": LINE_ID,
            },
            "geometry": {"type": "LineString", "coordinates": segment[2]},
        })
    write_json(SECTIONS, sections)

    stations = json.loads(STATIONS.read_text("utf-8"))
    stations["features"] = [
        feature
        for feature in stations["features"]
        if not feature.get("properties", {}).get("n02_station_code", "").startswith(
            CODE_PREFIX + "-"
        )
    ]
    for index, row in enumerate(line["stations"]):
        outgoing = line["segments"][index][2] if index < len(line["segments"]) else list(
            reversed(line["segments"][index - 1][2])
        )
        stations["features"].append({
            "type": "Feature",
            "properties": {
                "railway_class_code": "21",
                "institution_type_code": "4",
                "line_name": "東鐵綫",
                "operator": "MTR",
                "station_name": row[1],
                "n02_station_code": f"{CODE_PREFIX}-{line['stationAliases'][index]}",
                "n02_group_code": row[0],
                "display_point": [row[2], row[3]],
                "display_line_id": LINE_ID,
            },
            "geometry": {
                "type": "LineString",
                "coordinates": builder.station_stub(outgoing),
            },
        })
    write_json(STATIONS, stations)

    readings = json.loads(READINGS.read_text("utf-8"))
    by_code = readings["byCode"]
    for key in list(by_code):
        if key.startswith(CODE_PREFIX + "-") or key.startswith(LINE_ID + ":"):
            del by_code[key]
    for index, row in enumerate(line["stations"]):
        localized = {
            "name": row[1],
            "zh_Hant": row[1],
            "zh_Hans": line["stationHans"][index],
            "ja": "",
            "en": row[4],
        }
        by_code[f"{CODE_PREFIX}-{line['stationAliases'][index]}"] = localized
        by_code[f"{LINE_ID}:{row[0]}"] = localized
        readings["byName"].setdefault(row[1], localized)
    readings["stats"]["byCode"] = len(by_code)
    readings["stats"]["byName"] = len(readings["byName"])
    readings["packageVersion"] = "2025.2.1"
    readings["officialRevision"] = "2026-08-21"
    write_json(READINGS, readings)

    print(
        f"synced {LINE_ID}: {len(line['stations'])} stations, "
        f"{len(line['segments'])} intervals, "
        f"{sum(segment[0] for segment in line['segments']):.3f} km"
    )


if __name__ == "__main__":
    main()
