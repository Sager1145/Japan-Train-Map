#!/usr/bin/env python3
"""Build the Hong Kong display package from the AUDITED rebuild inventory.

Why this exists alongside build-hong-kong-rail-package.py
---------------------------------------------------------
The original builder reads a scraped MTR journey-planner HTML payload and the
open-data lines/stations CSV, both passed in as ``--mtr-html`` / ``--mtr-csv``
from wherever they were downloaded to. Neither file was archived under
``data/raw/railway/hk/``, so that builder cannot be re-run from the repository
today: its inputs are gone. That is a source-retention gap, and the staged
rebuild cannot depend on a builder whose inputs no longer exist.

The 2026-08-13 audit inventory is the better source anyway, because it is the
one that carries the corrections:

  * per-line station order taken from the DIRECTED service graph, so the four
    light-rail lines whose two directions are not mirror images (505, 751, 705,
    706) are no longer forced into a symmetric chain;
  * ``layer`` separating ``passenger_service`` from track that exists but
    carries no passengers, so the ordering pass cannot walk through the latter;
  * official station identity, English names and colour provenance.

Geometry is NOT re-derived here. Station intervals are cut from the same
``hk-track-alignments.json`` centre-lines by the same ``split_route`` /
``compact_line`` code path the audited package used, so this rebuild differs
from the old package in WHERE ITS STATION ORDER AND IDENTITY COME FROM, not in
how a polyline is cut. Anything else would make the two incomparable.

Output is a staging package. It never writes public/rail/hk-2025.json —
scripts/railway/promote-lines.mjs does, one session's lines at a time
(RAILWAY_REBUILD_SESSION_PLAN.md S01).

Usage:
  python3 scripts/railway/build-hong-kong-package-from-inventory.py
  python3 scripts/railway/build-hong-kong-package-from-inventory.py --lines hk-mtr-isl,hk-mtr-twl
"""

from __future__ import annotations

import argparse
import collections
import csv
import importlib.util
import json
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
INVENTORY = APP_DIR / "data" / "raw" / "railway" / "hk" / "rebuild-inventory"
TRACK_DATA = APP_DIR / "data" / "raw" / "railway" / "hk" / "hk-track-alignments.json"
RACECOURSE_ALIGNMENT = (
    APP_DIR / "data" / "raw" / "railway" / "hk" / "eal-racecourse-alignment.json"
)
STAGING = APP_DIR / "data" / "staging" / "hk-2025.staging.json"

PACKAGE_VERSION = "2025.3.0"
GENERATED_AT = "2026-08-13T00:00:00.000Z"

# Heavy rail reads at region scale; the light rail is a street-level network
# and appears with the city. Two ranks, one rule, no per-line table to drift.
HEAVY_RAIL_RANK = 1
LIGHT_RAIL_RANK = 3


def load_original_builder():
    """Reuse the audited geometry cutter. The module name has hyphens."""
    path = APP_DIR / "scripts" / "railway" / "build-hong-kong-rail-package.py"
    spec = importlib.util.spec_from_file_location("hk_rail_builder", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def route_code(line_id: str) -> str:
    """hk-mtr-tkl-poa -> TKL-POA, hk-mtr-lr-615p -> LR-615P."""
    return line_id.removeprefix("hk-mtr-").upper()


def station_order(line_id: str, connections: list[dict]) -> list[str]:
    """Chain a line's passenger-service adjacency into one station order.

    Only ``passenger_service`` edges may be walked: a ``physical_track_only``
    edge is track the public cannot ride, and letting the walk cross one would
    invent a station order no timetable supports.
    """
    neighbours = collections.defaultdict(set)
    for row in connections:
        if row["line_id"] != line_id or row["layer"] != "passenger_service":
            continue
        neighbours[row["from_station_uid"]].add(row["to_station_uid"])
        neighbours[row["to_station_uid"]].add(row["from_station_uid"])
    if not neighbours:
        raise RuntimeError(f"{line_id}: no passenger-service connections")

    ends = sorted(node for node, near in neighbours.items() if len(near) == 1)
    if len(ends) != 2:
        # Loops and anything branched need their own evidence-backed handling;
        # guessing an order here is exactly the kind of silent invention the
        # rebuild rules forbid.
        raise RuntimeError(
            f"{line_id}: {len(ends)} endpoints, not 2 — needs an explicit order rule"
        )

    order, previous, current = [], None, ends[0]
    while current is not None:
        order.append(current)
        forward = [node for node in sorted(neighbours[current]) if node != previous]
        previous, current = current, (forward[0] if forward else None)
    if len(order) != len(neighbours):
        raise RuntimeError(
            f"{line_id}: walked {len(order)} of {len(neighbours)} stations — not a simple chain"
        )
    return order


def oriented(order: list[str], anchors: dict[str, list[float]], route, geometry_lib):
    """Point the station order along the alignment, not at an arbitrary end.

    Both directions of a chain are equally true, but ``split_route`` cuts along
    increasing route measure, so the order has to agree with the polyline it is
    cut from. Orienting by projected measure also makes the output independent
    of which endpoint sorted first.
    """
    measures = geometry_lib.route_measures(route)
    first = geometry_lib.project_to_route(anchors[order[0]], route, measures)
    last = geometry_lib.project_to_route(anchors[order[-1]], route, measures)
    return order if first[1] <= last[1] else list(reversed(order))


def build(selected: set[str] | None):
    builder = load_original_builder()
    geometry_lib = importlib.import_module("lib.geometry")

    network = json.loads((INVENTORY / "stations" / "station-network.json").read_text("utf-8"))
    connections = read_csv(INVENTORY / "stations" / "station-connections.csv")
    colours = {row["line_id"]: row for row in read_csv(INVENTORY / "colours" / "line-colours.csv")}
    classification = {
        row["line_id"]: row
        for row in read_csv(INVENTORY / "lines" / "line-classification.csv")
    }
    routes = json.loads(TRACK_DATA.read_text("utf-8"))["routes"]

    station_by_uid = {row["station_uid"]: row for row in network["stations"]}

    lines = []
    skipped = []
    for line_id in sorted(classification):
        if selected and line_id not in selected:
            continue
        code = route_code(line_id)
        if code not in routes:
            # The four tram vectors are carried in hk-tram-alignments.json and
            # are a different kind of object (physical track, not a service).
            # They are S07's work; silently emitting an empty line here would
            # be worse than reporting the gap.
            skipped.append((line_id, "no alignment in hk-track-alignments.json"))
            continue

        route = routes[code]
        anchors: dict[str, list[float]] = {}
        for station in network["stations"]:
            for line in station["connected_lines"]:
                if line["line_id"] != line_id:
                    continue
                points = line.get("station_points") or []
                if not points:
                    continue
                anchors[station["station_uid"]] = [
                    points[0]["longitude"],
                    points[0]["latitude"],
                ]

        try:
            order = oriented(
                station_order(line_id, connections), anchors, route, geometry_lib
            )
        except RuntimeError as error:
            skipped.append((line_id, str(error)))
            continue

        stations = []
        for uid in order:
            row = station_by_uid[uid]
            stations.append(
                {
                    "group": row["physical_station_group"],
                    "zh": row["station_name"],
                    "zh_hans": builder.to_hans(row["station_name"]),
                    "en": row["station_english"],
                    "alias": uid,
                    "lon": anchors[uid][0],
                    "lat": anchors[uid][1],
                }
            )

        classified = classification[line_id]
        colour = colours[line_id]
        lines.append(
            builder.compact_line(
                line_id,
                code,
                classified["line"],
                classified["line_english"],
                classified["operator"],
                colour["render_color_hex"],
                LIGHT_RAIL_RANK if "-lr-" in line_id else HEAVY_RAIL_RANK,
                stations,
                route,
            )
        )

    # The 2026-08-13 inventory predates the Racecourse correction. Keep the
    # rejoining variant in the reproducible staging build from its retained,
    # source-documented alignment instead of letting an inventory rebuild
    # silently remove the station and branch again.
    racecourse_id = "hk-mtr-eal-rac"
    if not selected or racecourse_id in selected:
        source = json.loads(RACECOURSE_ALIGNMENT.read_text("utf-8"))
        colour = colours["hk-mtr-eal-low"]
        lines.append(
            builder.compact_line(
                racecourse_id,
                "EAL-RAC",
                "東鐵綫",
                "East Rail Line",
                "MTR",
                colour["render_color_hex"],
                HEAVY_RAIL_RANK,
                [
                    {
                        "group": "hk-official-mtr-sht", "zh": "沙田",
                        "zh_hans": "沙田", "en": "Sha Tin", "alias": "MTR-SHT",
                        "lon": 114.1876419, "lat": 22.3828402,
                    },
                    {
                        "group": "hk-official-mtr-rac", "zh": "馬場",
                        "zh_hans": "马场", "en": "Racecourse", "alias": "MTR-RAC",
                        "lon": 114.2029649, "lat": 22.4004416,
                    },
                    {
                        "group": "hk-official-mtr-uni", "zh": "大學",
                        "zh_hans": "大学", "en": "University", "alias": "MTR-UNI",
                        "lon": 114.2100545, "lat": 22.4133852,
                    },
                ],
                source["coordinates"],
            )
        )

    package = {
        "format": "compact-v1",
        "version": PACKAGE_VERSION,
        "generatedAt": GENERATED_AT,
        "crs": "WGS84",
        "country": "HK",
        "lines": builder.strip_build_fields(lines),
        "geometrySource": {
            "officialOnly": 0,
            "providers": [
                "MTR Corporation Limited (journey planner, lines & stations open data)",
                "OpenStreetMap contributors (track centre-lines)",
            ],
            "license": "MTR open data via DATA.GOV.HK terms; track centre-lines (c) OpenStreetMap contributors, ODbL",
            "authority": "MTR Corporation Limited (network, stations, service topology); OpenStreetMap (track geometry)",
            "stationData": "data/raw/railway/hk/rebuild-inventory (2026-08-13 audited service graph)",
            "method": "Station order chained from the audited directed passenger-service graph; intervals cut from hk-track-alignments.json centre-lines at the per-line on-line render anchors.",
        },
        "lanes": [],
    }

    STAGING.parent.mkdir(parents=True, exist_ok=True)
    STAGING.write_text(json.dumps(package, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"staging: {len(package['lines'])} lines -> {STAGING.relative_to(APP_DIR)}")
    for line in package["lines"]:
        print(
            f"  {line['id']:<18} {len(line['stations']):>3} stations "
            f"{len(line['segments']):>3} intervals "
            f"{sum(row[0] for row in line['segments']):>7.2f} km  {line['color']}"
        )
    for line_id, reason in skipped:
        print(f"  SKIPPED {line_id}: {reason}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lines", default="", help="comma-separated line ids")
    args = parser.parse_args()
    selected = {value.strip() for value in args.lines.split(",") if value.strip()}
    build(selected or None)


if __name__ == "__main__":
    main()
