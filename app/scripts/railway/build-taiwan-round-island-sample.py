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

import json
from typing import Dict

from lib.tw_sample_lib import (
    LICENSE,
    ROUTES_PATH,
    STOPS_PATH,
    STORE_PATH,
    line_context,
    load_official_package,
    official_path,
    replace_train_features,
    write_json_and_gzip,
)

TRAIN_ID = "20260813_01_star_of_taiwan_round_island_loop"
OPERATOR = "國營臺灣鐵路股份有限公司"
COMPANY = "台鐵"
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


def main() -> int:
    package = load_official_package()
    source = package.get("geometrySource", {})
    lines_by_id = {row["id"]: row for row in package["lines"]}
    contexts: Dict[str, Dict[str, object]] = {}
    for line_name, line_id in LINE_IDS.items():
        line = lines_by_id.get(line_id)
        if line is None:
            raise RuntimeError(f"official line missing: {line_id}")
        contexts[line_name] = line_context(line, package)

    store = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    train = next((row for row in store["trains"] if row["id"] == TRAIN_ID), None)
    if train is None:
        raise RuntimeError(f"round-island train missing from store: {TRAIN_ID}")
    train["company"] = COMPANY

    official_hash = source.get("sourceSha256", {}).get("TRA:shape", "")
    route_features = []
    for segment_index, section in enumerate(train["route_sections"]):
        line_name = section["line_names"][0]
        context = contexts[line_name]
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
                    "license": LICENSE,
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
        row = contexts[line_name]["station_by_name"][stop["name"]]
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
                    "license": LICENSE,
                },
                "geometry": {"type": "Point", "coordinates": [row[2], row[3]]},
            }
        )

    routes = json.loads(ROUTES_PATH.read_text(encoding="utf-8"))
    stops = json.loads(STOPS_PATH.read_text(encoding="utf-8"))
    replace_train_features(routes, TRAIN_ID, route_features)
    replace_train_features(stops, TRAIN_ID, stop_features)

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
