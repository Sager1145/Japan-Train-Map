#!/usr/bin/env python3
"""Rebuild the bundled Taoyuan Airport MRT sample from official rail data."""

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

TRAIN_ID = "20260802_01_taoyuan_airport_mrt_express_t2_taipei"
LINE_ID = "tw-tym-a"
LINE_NAME = "桃園機場捷運"
OPERATOR = "桃園大眾捷運股份有限公司"
SOURCE = "交通部運輸資料流通服務（TDX/PTX）TYMC Shape LineID=A"
ATTRIBUTION = "交通部運輸資料流通服務（TDX/PTX）；桃園大眾捷運股份有限公司"

# Every physical station in the ridden A13 -> A1 interval.  The express only
# calls at A13/A12/A8/A3/A1; every intervening official TDX station remains in
# the canonical store as pass_through so route_sections stay one physical
# station interval per feature, as required by jsonspec §7/§8/§14.
STOPS = (
    ("TYMC-A13", "機場第二航廈站", None, "13:25", "origin"),
    ("TYMC-A12", "機場第一航廈站", None, "13:28", "passenger_stop"),
    ("TYMC-A11", "坑口站", None, None, "pass_through"),
    ("TYMC-A10", "山鼻站", None, None, "pass_through"),
    ("TYMC-A9", "林口站", None, None, "pass_through"),
    ("TYMC-A8", "長庚醫院站", None, "13:41", "passenger_stop"),
    ("TYMC-A7", "體育大學站", None, None, "pass_through"),
    ("TYMC-A6", "泰山貴和站", None, None, "pass_through"),
    ("TYMC-A5", "泰山站", None, None, "pass_through"),
    ("TYMC-A4", "新莊副都心站", None, None, "pass_through"),
    ("TYMC-A3", "新北產業園區站", None, "13:55", "passenger_stop"),
    ("TYMC-A2", "三重站", None, None, "pass_through"),
    ("TYMC-A1", "台北車站", "14:04", None, "destination"),
)


def json_payload(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def write_json(path: Path, value: object) -> None:
    path.write_bytes(json_payload(value))


def write_json_and_gzip(path: Path, value: object) -> None:
    payload = json_payload(value)
    path.write_bytes(payload)
    gzip_path = Path(str(path) + ".gz")
    with gzip_path.open("wb") as raw:
        with gzip.GzipFile(
            filename="",
            mode="wb",
            fileobj=raw,
            compresslevel=9,
            mtime=0,
        ) as stream:
            stream.write(payload)


def reconstruct_line_segments(line: Dict[str, object]) -> List[List[List[float]]]:
    output = []
    previous_last = None
    for row in line["segments"]:
        payload = row[2]
        coords = [previous_last, *payload] if row[1] else list(payload)
        if len(coords) < 2:
            raise RuntimeError(f"{LINE_ID}: invalid compact segment")
        output.append(coords)
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
    line = next((row for row in package["lines"] if row["id"] == LINE_ID), None)
    if line is None:
        raise RuntimeError(f"official line missing: {LINE_ID}")
    station_by_name = {row[1]: row for row in line["stations"]}
    station_index = {row[1]: index for index, row in enumerate(line["stations"])}
    for _uid, name, _arrival, _departure, _stop_type in STOPS:
        if name not in station_by_name:
            raise RuntimeError(f"official station missing: {name}")
    segments = reconstruct_line_segments(line)

    store = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    train = next((row for row in store["trains"] if row["id"] == TRAIN_ID), None)
    if train is None:
        raise RuntimeError(f"sample train missing: {TRAIN_ID}")
    train.update(
        {
            "number": "桃園機場捷運 直達車（機場第二航廈站→台北車站）",
            "company": OPERATOR,
            "origin": STOPS[0][1],
            "destination": STOPS[-1][1],
            "direction": "up",
            "route_sections": [
                {
                    "from": left[1],
                    "to": right[1],
                    "from_n02_station_code": left[0],
                    "to_n02_station_code": right[0],
                    "line_names": [LINE_NAME],
                    "operator_names": [OPERATOR],
                }
                for left, right in zip(STOPS, STOPS[1:])
            ],
            "stops": [
                {
                    "name": name,
                    "n02_station_code": uid,
                    "arrival": arrival,
                    "departure": departure,
                    "stop_type": stop_type,
                    "ride_segment": True,
                }
                for uid, name, arrival, departure, stop_type in STOPS
            ],
        }
    )
    train["route_policy"]["preferred_line_names"] = [LINE_NAME]
    train["route_policy"]["preferred_operator_names"] = [OPERATOR]

    official_hash = source.get("sourceSha256", {}).get("TYMC:shape", "")
    route_features = []
    for segment_index, (left, right) in enumerate(zip(STOPS, STOPS[1:])):
        coords = official_path(station_index, segments, left[1], right[1])
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
                    "official_line_id": "A",
                    "segment_index": segment_index,
                    "from": left[1],
                    "to": right[1],
                    "from_n02_station_code": left[0],
                    "to_n02_station_code": right[0],
                    "station_code_system": "TDX",
                    "from_official_station_uid": left[0],
                    "to_official_station_uid": right[0],
                    "from_official_station_group_id": station_by_name[left[1]][0],
                    "to_official_station_group_id": station_by_name[right[1]][0],
                    "used_line_names": {LINE_NAME: edge_count},
                    "used_operator_names": {OPERATOR: edge_count},
                    "path_coordinate_count": len(coords),
                },
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        )

    stop_features = []
    for uid, name, _arrival, _departure, _stop_type in STOPS:
        row = station_by_name[name]
        stop_features.append(
            {
                "type": "Feature",
                "properties": {
                    "train_id": TRAIN_ID,
                    "name": name,
                    "n02_station_code": uid,
                    "station_code_system": "TDX",
                    "official_station_uid": uid,
                    "official_station_group_id": row[0],
                    "line_name": LINE_NAME,
                    "operator": OPERATOR,
                    "source": "交通部運輸資料流通服務（TDX/PTX）TYMC Station",
                    "attribution": ATTRIBUTION,
                    "license": "政府資料開放授權條款第1版",
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [row[2], row[3]],
                },
            }
        )

    routes = json.loads(ROUTES_PATH.read_text(encoding="utf-8"))
    stops = json.loads(STOPS_PATH.read_text(encoding="utf-8"))
    replace_train_features(routes, route_features)
    replace_train_features(stops, stop_features)
    routes["source"] = (
        "日本：国土数値情報（鉄道データ N02）2025年度版；"
        "台湾：交通部運輸資料流通服務（TDX/PTX）"
    )
    stops["source"] = routes["source"]

    write_json(STORE_PATH, store)
    write_json_and_gzip(ROUTES_PATH, routes)
    write_json_and_gzip(STOPS_PATH, stops)
    print(
        f"rebuilt {TRAIN_ID}: {len(route_features)} route sections, "
        f"{sum(len(feature['geometry']['coordinates']) for feature in route_features)} "
        f"official coordinates, {len(stop_features)} official stations"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
