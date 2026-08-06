#!/usr/bin/env python3
"""Build curated official-geometry routes for the round-island TRA sample.

The offline solver runs against the Japanese N02 network, so Taiwan trains
ship curated matched-routes sliced from the official tw-2025 package (the
same mechanism as ``rebuild-taiwan-sample-route.py`` for the airport MRT
sample).  This script reads the round-island train's ``route_sections`` from
the Taiwan store — every section names the display line it rides — and
slices that line's official geometry between the two physical stations.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Dict, List, Sequence


APP_DIR = Path(__file__).resolve().parent.parent
PACKAGE_PATH = APP_DIR / "public" / "rail" / "tw-2025.json"
STORE_PATH = APP_DIR / "data" / "train-store-tw.json"
ROUTES_PATH = APP_DIR / "data" / "matched-routes.json"
STOPS_PATH = APP_DIR / "data" / "matched-stops.json"

TRAIN_ID = "20260813_01_star_of_taiwan_round_island_loop"
OPERATOR = "國營臺灣鐵路股份有限公司"
SOURCE = "交通部運輸資料流通服務（TDX/PTX）TRA Shape + 內政部國土測繪中心 NLSC"
ATTRIBUTION = (
    "交通部運輸資料流通服務（TDX/PTX）；國營臺灣鐵路股份有限公司；內政部國土測繪中心"
)

LINE_IDS = {
    "縱貫線北段": "tw-tra-western-north",
    "臺中線": "tw-tra-taichung",
    "縱貫線南段": "tw-tra-western-south",
    "屏東線": "tw-tra-pingtung",
    "南迴線": "tw-tra-south-link",
    "臺東線": "tw-tra-taitung",
    "北迴線": "tw-tra-north-link",
    "宜蘭線": "tw-tra-yilan",
}


def json_payload(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def write_json(path: Path, value: object) -> None:
    path.write_bytes(json_payload(value))


def write_json_and_gzip(path: Path, value: object) -> None:
    payload = json_payload(value)
    path.write_bytes(payload)
    with Path(str(path) + ".gz").open("wb") as raw:
        with gzip.GzipFile(
            filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0
        ) as stream:
            stream.write(payload)


def reconstruct_line_segments(line: Dict[str, object]) -> List[List[List[float]]]:
    output = []
    previous_last = None
    for row in line["segments"]:
        coords = [previous_last, *row[2]] if row[1] else [list(c) for c in row[2]]
        if len(coords) < 2:
            raise RuntimeError(f"{line['id']}: invalid compact segment")
        output.append([list(c) for c in coords])
        previous_last = coords[-1]
    return output


def join_without_duplicate(
    output: List[List[float]], values: Sequence[Sequence[float]]
) -> None:
    rows = [list(coord) for coord in values]
    if output and rows and output[-1] == rows[0]:
        rows = rows[1:]
    output.extend(rows)


def official_path(
    station_index: Dict[str, int],
    segments: Sequence[Sequence[Sequence[float]]],
    start: str,
    end: str,
) -> List[List[float]]:
    start_index = station_index[start]
    end_index = station_index[end]
    output: List[List[float]] = []
    if start_index < end_index:
        for index in range(start_index, end_index):
            join_without_duplicate(output, segments[index])
    else:
        for index in range(start_index - 1, end_index - 1, -1):
            join_without_duplicate(output, list(reversed(segments[index])))
    if len(output) < 2:
        raise RuntimeError(f"empty official path: {start} -> {end}")
    return output


def replace_train_features(
    collection: Dict[str, object], replacements: Sequence[Dict[str, object]]
) -> None:
    retained = [
        feature
        for feature in collection["features"]
        if feature.get("properties", {}).get("train_id") != TRAIN_ID
    ]
    collection["features"] = [*retained, *replacements]


def main() -> int:
    package = json.loads(PACKAGE_PATH.read_text(encoding="utf-8"))
    source = package.get("geometrySource", {})
    if source.get("officialOnly") != 1 or source.get("osmSources") != 0:
        raise RuntimeError("Taiwan package is not official-only")
    lines_by_id = {row["id"]: row for row in package["lines"]}
    line_context: Dict[str, Dict[str, object]] = {}
    for line_name, line_id in LINE_IDS.items():
        line = lines_by_id.get(line_id)
        if line is None:
            raise RuntimeError(f"official line missing: {line_id}")
        line_context[line_name] = {
            "line": line,
            "station_by_name": {row[1]: row for row in line["stations"]},
            "station_index": {row[1]: i for i, row in enumerate(line["stations"])},
            "segments": reconstruct_line_segments(line),
        }

    store = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    train = next((row for row in store["trains"] if row["id"] == TRAIN_ID), None)
    if train is None:
        raise RuntimeError(f"round-island train missing from store: {TRAIN_ID}")

    official_hash = source.get("sourceSha256", {}).get("TRA:shape", "")
    route_features = []
    for segment_index, section in enumerate(train["route_sections"]):
        line_name = section["line_names"][0]
        context = line_context[line_name]
        for name in (section["from"], section["to"]):
            if name not in context["station_by_name"]:
                raise RuntimeError(f"{line_name}: official station missing: {name}")
        coords = official_path(
            context["station_index"],
            context["segments"],
            section["from"],
            section["to"],
        )
        edge_count = len(coords) - 1
        route_features.append(
            {
                "type": "Feature",
                "properties": {
                    "train_id": TRAIN_ID,
                    "route_id": f"{TRAIN_ID}-primary",
                    "variant_rank": 0,
                    "is_primary": True,
                    "route_choice": "official_line_slice",
                    "geometry_role": "single_primary_segment",
                    "source": SOURCE,
                    "attribution": ATTRIBUTION,
                    "license": "政府資料開放授權條款第1版",
                    "official_package_version": package["version"],
                    "official_shape_sha256": official_hash,
                    "official_line_id": LINE_IDS[line_name],
                    "segment_index": segment_index,
                    "from": section["from"],
                    "to": section["to"],
                    "from_n02_station_code": section["from_n02_station_code"],
                    "to_n02_station_code": section["to_n02_station_code"],
                    "station_code_system": "TDX",
                    "from_official_station_uid": section["from_n02_station_code"],
                    "to_official_station_uid": section["to_n02_station_code"],
                    "from_official_station_group_id": context["station_by_name"][
                        section["from"]
                    ][0],
                    "to_official_station_group_id": context["station_by_name"][
                        section["to"]
                    ][0],
                    "used_line_names": {line_name: edge_count},
                    "used_operator_names": {OPERATOR: edge_count},
                    "path_coordinate_count": len(coords),
                },
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        )

    stop_features = []
    seen_codes = set()
    for stop_index, stop in enumerate(train["stops"]):
        code = stop["n02_station_code"]
        if code in seen_codes:
            continue
        seen_codes.add(code)
        # The station point of the line the train departs this stop on (the
        # arriving line for the terminus); junctions are welded so member
        # dots coincide anyway.
        section = train["route_sections"][min(stop_index, len(train["route_sections"]) - 1)]
        line_name = section["line_names"][0]
        row = line_context[line_name]["station_by_name"][stop["name"]]
        stop_features.append(
            {
                "type": "Feature",
                "properties": {
                    "train_id": TRAIN_ID,
                    "name": stop["name"],
                    "n02_station_code": code,
                    "station_code_system": "TDX",
                    "official_station_uid": code,
                    "official_station_group_id": row[0],
                    "line_name": line_name,
                    "operator": OPERATOR,
                    "source": "交通部運輸資料流通服務（TDX/PTX）TRA Station",
                    "attribution": ATTRIBUTION,
                    "license": "政府資料開放授權條款第1版",
                },
                "geometry": {"type": "Point", "coordinates": [row[2], row[3]]},
            }
        )

    routes = json.loads(ROUTES_PATH.read_text(encoding="utf-8"))
    stops = json.loads(STOPS_PATH.read_text(encoding="utf-8"))
    replace_train_features(routes, route_features)
    replace_train_features(stops, stop_features)

    write_json_and_gzip(ROUTES_PATH, routes)
    write_json_and_gzip(STOPS_PATH, stops)
    print(
        f"rebuilt {TRAIN_ID}: {len(route_features)} route sections, "
        f"{sum(len(f['geometry']['coordinates']) for f in route_features)} "
        f"official coordinates, {len(stop_features)} official stations"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
