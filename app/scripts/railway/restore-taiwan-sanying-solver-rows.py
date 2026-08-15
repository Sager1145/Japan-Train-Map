#!/usr/bin/env python3
"""Put the Sanying Line's rows back into Taiwan's solver station dataset.

Why this is a script and not a hand edit
----------------------------------------
During the 2026-08-13 staged rebuild, data/stations-tw.json and
data/rail-sections-tw.json were regenerated through the Hong Kong builder's
build_derived_datasets(), which derives station codes from a line's codePrefix.
Taiwan's codes must be TDX StationUIDs, so that rewrote every one of them and
broke six passing tests. Both files were restored from git HEAD — but HEAD
predates the audit that added the Sanying Line, so the restore also dropped
Sanying's 12 stations and 11 sections, and those had only ever existed as
uncommitted work.

They are recoverable exactly, because the official source IS archived:
data/raw/railway/tw/sanying-official-stations.json carries each station's
`stationUid` (NTMC-LB01 …), which is the TDX StationUID the dataset needs. No
code is invented here; the mapping is read from that file.

Classification codes come from the same operator's other METRO line in the
dataset — 新北大眾捷運's 環狀線, ('12', '3') — not from its light rails, which
are ('21', '3'). Sanying is a metro.

Station geometry is the short on-track stub the solver snaps to, cut from the
drawn package's own intervals by the shared lib.geometry.station_stub, exactly
as every other station row was.

Run once; it is idempotent (a dataset that already has Sanying is left alone).

Usage:
  python3 app/scripts/railway/restore-taiwan-sanying-solver-rows.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(APP_DIR / "scripts" / "railway"))

from lib.geometry import station_stub  # noqa: E402

LINE_ID = "tw-ntmetro-lb"
LINE_NAME = "三鶯線"
OPERATOR = "新北大眾捷運股份有限公司"
RAILWAY_CLASS_CODE = "12"
INSTITUTION_TYPE_CODE = "3"

STATIONS_PATH = APP_DIR / "data" / "stations-tw.json"
PACKAGE_PATH = APP_DIR / "public" / "rail" / "tw-2025.json"
OFFICIAL_PATH = APP_DIR / "data" / "raw" / "railway" / "tw" / "sanying-official-stations.json"


def main() -> None:
    stations = json.loads(STATIONS_PATH.read_text("utf-8"))
    already = [
        feature
        for feature in stations["features"]
        if feature["properties"]["line_name"] == LINE_NAME
    ]
    if already:
        print(f"stations-tw.json already carries {len(already)} {LINE_NAME} row(s); nothing to do")
        return

    package = json.loads(PACKAGE_PATH.read_text("utf-8"))
    line = next((row for row in package["lines"] if row["id"] == LINE_ID), None)
    if line is None:
        raise SystemExit(f"{LINE_ID} is not in the drawn package yet")

    official = json.loads(OFFICIAL_PATH.read_text("utf-8"))
    uid_by_group = {
        f"tw-official-{row['stationUid'].lower().replace('-', '-')}": row["stationUid"]
        for row in official["stations"]
    }

    added = []
    for index, station in enumerate(line["stations"]):
        group = station[0]
        uid = uid_by_group.get(group)
        if not uid:
            raise SystemExit(f"no official stationUid for {group}; refusing to invent one")
        # The stub runs along the interval this station starts, or the one it
        # ends when it is the terminus — the same rule the other rows follow.
        segment = line["segments"][min(index, len(line["segments"]) - 1)]
        coordinates = [[point[0], point[1]] for point in segment[2]]
        if index == len(line["stations"]) - 1:
            coordinates.reverse()
        added.append(
            {
                "type": "Feature",
                "properties": {
                    "railway_class_code": RAILWAY_CLASS_CODE,
                    "institution_type_code": INSTITUTION_TYPE_CODE,
                    "line_name": LINE_NAME,
                    "operator": OPERATOR,
                    "station_name": station[1],
                    "n02_station_code": uid,
                    "n02_group_code": group,
                    "display_point": [station[2], station[3]],
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": station_stub(coordinates),
                },
            }
        )

    stations["features"].extend(added)
    STATIONS_PATH.write_text(
        json.dumps(stations, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"stations-tw.json: +{len(added)} {LINE_NAME} rows -> {len(stations['features'])} total")
    for feature in added:
        print(
            f"  {feature['properties']['n02_station_code']:<12}"
            f"{feature['properties']['station_name']}"
        )
    print("\nNow re-run: python3 app/scripts/railway/rebuild-solver-sections.py --country tw")


if __name__ == "__main__":
    main()
