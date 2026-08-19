#!/usr/bin/env python3
"""Generate Japan's Apple Maps check queue — the review work list for 596 lines.

hk and tw got their queues from audit-compact-rail-network.py, which reads a
FINISHED package. Japan cannot: the package is being rebuilt one session at a
time, and the queue has to exist before the first of those sessions can be
accepted (verify-batch gate 5). So this builds the queue from the audit
inventory, which knows every line, station and adjacency that must eventually be
reviewed, and takes coordinates from the published package for the lines that
are already drawn.

One row per checkpoint, exactly as hk and tw record them:

    line_shape        1 per line       is the drawn shape the right shape
    station_anchor    1 per platform   is the dot on the right track
    segment_geometry  1 per interval   does the track between two stops match

A checkpoint is the unit a REVIEW is recorded against, not the unit a screenshot
is taken in — plan-apple-capture-tiles.py turns this queue into the far smaller
set of frames that answers it.

Two columns hk and tw do not have:

    canonical_key    the N02 identity `operator␟line`, so a row can be traced
                     back to RAILWAY_REBUILD_BATCHES.csv, which keys jp that way
    geometry_basis   `drawn_geometry` when the line is in the package and the
                     coordinate is a point on the drawn track; `audited_station`
                     when it is not yet built and the coordinate is the audited
                     station position. A reviewer must know which one they were
                     sent to, because only the first is a claim the package makes.

RERUN AFTER EVERY PROMOTE. A line's rows move from `audited_station` to
`drawn_geometry` the moment its session lands it in the package, and only then
does its review compare against something the project actually asserts. Rows
that already carry a review verdict are preserved.

Usage:
  python3 app/scripts/railway/build-japan-check-queue.py
  python3 app/scripts/railway/build-japan-check-queue.py --lines '東海旅客鉄道␟東海道新幹線'
"""

from __future__ import annotations

import argparse
import collections
import csv
import json
import re
import unicodedata
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
RAW = APP_DIR / "data" / "raw" / "railway" / "jp"
INVENTORY = RAW / "rebuild-inventory"
PACKAGE = APP_DIR / "public" / "rail" / "jp-2025.json"
OUTPUT = INVENTORY / "evidence" / "apple-maps-reference" / "check-queue.csv"

OPERATOR_ALIASES = {"東京地下鉄": "東京メトロ", "大阪市高速電気軌道": "Osaka Metro"}
CANONICAL_SEPARATORS = ("␟", "")

COLUMNS = [
    "check_id",
    "country",
    "line_id",
    "logical_line_id",
    "operator",
    "line",
    "shape_class",
    "network_role",
    "detail_profile",
    "check_kind",
    "check_index",
    "from_station",
    "to_station",
    "longitude",
    "latitude",
    "required_verifications",
    "apple_zoom",
    "apple_map_url",
    "nearby_reference_files_json",
    "capture_status",
    "project_overlay_status",
    "visual_review_status",
    "issue_status",
    "review_notes",
    "fix_commit",
    "canonical_key",
    "geometry_basis",
]

REQUIRED = {
    "line_shape": (
        "main_and_branch_partition|shape_class|line_label|parallel_line_display|"
        "closed_loop_or_rejoin_when_applicable"
    ),
    "station_anchor": (
        "station_on_correct_track|operator_identity|connected_lines|station_style|"
        "line_label_collision|smoothest_station_entry"
    ),
    "segment_geometry": (
        "continuous_connection|correct_turning_points|no_spatial_offset|"
        "parallel_track_separation|branch_join|line_label"
    ),
}

KIND_PREFIX = {"line_shape": "L", "station_anchor": "P", "segment_geometry": "S"}

# Carried review state: a rerun must not wipe a verdict someone recorded.
CARRIED = (
    "capture_status",
    "project_overlay_status",
    "visual_review_status",
    "issue_status",
    "review_notes",
    "fix_commit",
)

# jp's detail_profile vocabulary is its own; map it onto the zoom rule hk and tw
# already use rather than inventing a second rule. A funicular is reviewed like a
# tram (both are street-scale), a short line like a compact urban one, and a
# long-distance line like a standard one.
PROFILE_ALIAS = {
    "short_funicular": "short_tram",
    "short_line": "compact_urban",
    "long_distance": "standard",
}

LOOP_SHAPES = {"loop", "complex_loop", "loop_with_tail", "terminal_loop_line"}


def apple_zoom(detail_profile: str, check_kind: str) -> int:
    profile = PROFILE_ALIAS.get(detail_profile, detail_profile)
    if profile in {"short_tram", "mountain_short_line"}:
        return 17 if check_kind == "station_anchor" else 16
    if profile == "compact_urban":
        return 16 if check_kind == "station_anchor" else 15
    return 16 if check_kind == "station_anchor" else 14


def apple_url(longitude: float, latitude: float, zoom: int) -> str:
    return f"https://maps.apple.com/?ll={latitude:.7f},{longitude:.7f}&z={zoom}&t=r"


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def normalised(value: str) -> str:
    return re.sub(r"[\s　]", "", unicodedata.normalize("NFKC", value or ""))


def identity_key(operator: str, name: str) -> str:
    return f"{normalised(OPERATOR_ALIASES.get(operator, operator))} {normalised(name)}"


def split_canonical(key: str):
    for separator in CANONICAL_SEPARATORS:
        at = key.find(separator)
        if at >= 0:
            return key[:at], key[at + len(separator) :]
    return None


def midpoint(points):
    """The vertex nearest half the polyline's length — on the line, not beside it.

    A centroid of a curve leaves the curve, and a reviewer sent to a coordinate
    the track does not pass through cannot tell a real offset from the frame
    being centred somewhere else.
    """
    if len(points) == 1:
        return points[0]
    spans = [0.0]
    total = 0.0
    for start, end in zip(points, points[1:]):
        total += ((end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2) ** 0.5
        spans.append(total)
    half = total / 2
    for index, span in enumerate(spans):
        if span >= half:
            return points[index]
    return points[-1]


def checks_from_package(line):
    """Checkpoints straight off the geometry the package draws."""
    stations = line["stations"]
    anchors = [[row[2], row[3]] for row in stations]
    centre = midpoint(anchors)
    checks = [
        {
            "check_kind": "line_shape",
            "check_index": 0,
            "from_station": stations[0][1],
            "to_station": stations[-1][1],
            "longitude": centre[0],
            "latitude": centre[1],
        }
    ]
    for index, station in enumerate(stations):
        checks.append(
            {
                "check_kind": "station_anchor",
                "check_index": index,
                "from_station": station[1],
                "to_station": "",
                "longitude": station[2],
                "latitude": station[3],
            }
        )
    for index, segment in enumerate(line["segments"]):
        centre = midpoint(segment[2])
        checks.append(
            {
                "check_kind": "segment_geometry",
                "check_index": index,
                "from_station": stations[index][1],
                "to_station": stations[(index + 1) % len(stations)][1],
                "longitude": centre[0],
                "latitude": centre[1],
            }
        )
    return checks, "drawn_geometry"


def checks_from_inventory(key, members, adjacency, station_by_uid):
    """Checkpoints for a line that is not built yet, from the audit's positions.

    A line nobody has drawn owes MORE review than one that is drawn, so it keeps
    its full row count. The coordinates are the audited station positions and are
    flagged as such: they say where to look, not what the package claims.
    """
    uids = sorted(members.get(key, []))
    if not uids:
        return [], "audited_station"
    points = {
        uid: [
            float(station_by_uid[uid]["longitude"]),
            float(station_by_uid[uid]["latitude"]),
        ]
        for uid in uids
    }
    ordered = sorted(uids, key=lambda uid: (points[uid][1], points[uid][0]))
    centre = midpoint([points[uid] for uid in ordered])
    checks = [
        {
            "check_kind": "line_shape",
            "check_index": 0,
            "from_station": station_by_uid[ordered[0]]["station_name"],
            "to_station": station_by_uid[ordered[-1]]["station_name"],
            "longitude": centre[0],
            "latitude": centre[1],
        }
    ]
    for index, uid in enumerate(ordered):
        checks.append(
            {
                "check_kind": "station_anchor",
                "check_index": index,
                "from_station": station_by_uid[uid]["station_name"],
                "to_station": "",
                "longitude": points[uid][0],
                "latitude": points[uid][1],
            }
        )
    for index, (a, b) in enumerate(sorted(adjacency.get(key, set()))):
        if a not in points or b not in points:
            continue
        checks.append(
            {
                "check_kind": "segment_geometry",
                "check_index": index,
                "from_station": station_by_uid[a]["station_name"],
                "to_station": station_by_uid[b]["station_name"],
                "longitude": (points[a][0] + points[b][0]) / 2,
                "latitude": (points[a][1] + points[b][1]) / 2,
            }
        )
    return checks, "audited_station"


def merge_with_previous(
    previous: list[dict], out: list[dict], wanted: set[str] | None
) -> list[dict]:
    """Fold a --lines rerun's rows back into the rows it did not rebuild.

    Kept rows are chosen by CANONICAL KEY, not by check_id. check_ids are
    numbered per line (…-P000, …-P001, …-S000), so a line that comes back with
    fewer stations than last time stops emitting its highest ids; keeping every
    id "this run did not write" would strand those as orphan rows for platforms
    and intervals that no longer exist. Dropping the whole line instead also
    covers the rows whose id moved because the line changed line_id on entering
    the package.

    No --lines is a full rebuild: `out` already is the whole queue.
    """
    if not wanted or not previous:
        return out
    kept = [row for row in previous if row.get("canonical_key") not in wanted]
    return sorted(kept + out, key=lambda row: row["check_id"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lines", default="", help="canonical keys, comma separated")
    args = parser.parse_args()
    wanted = {value.strip() for value in args.lines.split(",") if value.strip()} or None

    classification = {
        row["canonical_key"]: row
        for row in read_csv(INVENTORY / "lines" / "n02-line-shape-classification.csv")
    }
    network = json.loads(
        (INVENTORY / "stations" / "n02-station-network.json").read_text("utf-8")
    )
    station_by_uid = {row["station_uid"]: row for row in network["stations"]}

    adjacency = collections.defaultdict(set)
    for row in network["connections"]:
        adjacency[f"{row['from_operator']}␟{row['line']}"].add(
            tuple(sorted((row["from_station_uid"], row["to_station_uid"])))
        )
    members = collections.defaultdict(list)
    for station in network["stations"]:
        for line in station.get("connected_lines", []):
            members[f"{station['operator']}␟{line['line']}"].append(station["station_uid"])

    drawn = {}
    if PACKAGE.exists():
        for line in json.loads(PACKAGE.read_text("utf-8")).get("lines", []):
            drawn.setdefault(identity_key(line["operator"], line["name"]), line)

    previous = {}
    if OUTPUT.exists():
        for row in read_csv(OUTPUT):
            previous[row["check_id"]] = row

    out = []
    for key in sorted(classification):
        if wanted and key not in wanted:
            continue
        parts = split_canonical(key)
        if not parts:
            continue
        operator, name = parts
        row = classification[key]
        line = drawn.get(identity_key(operator, name))
        if line is not None:
            checks, basis = checks_from_package(line)
            line_id = line["id"]
        else:
            checks, basis = checks_from_inventory(
                key, members, adjacency, station_by_uid
            )
            # The id keeps the N02 corporate operator; only the display
            # `operator` field carries the brand. Same rule as the builder.
            line_id = f"jp-{operator}-{name}"
        shape_class = row["shape_class"]
        for check in checks:
            zoom = apple_zoom(row["detail_profile"], check["check_kind"])
            check_id = (
                f"JP-APPLE-{line_id}-"
                f"{KIND_PREFIX[check['check_kind']]}{check['check_index']:03d}"
            )
            carried = previous.get(check_id, {})
            out.append(
                {
                    "check_id": check_id,
                    "country": "JP",
                    "line_id": line_id,
                    "logical_line_id": line_id,
                    "operator": OPERATOR_ALIASES.get(operator, operator),
                    "line": name,
                    "shape_class": shape_class,
                    "network_role": "closed_loop"
                    if shape_class in LOOP_SHAPES
                    else "main",
                    "detail_profile": row["detail_profile"],
                    **check,
                    "required_verifications": REQUIRED[check["check_kind"]],
                    "apple_zoom": zoom,
                    "apple_map_url": apple_url(
                        float(check["longitude"]), float(check["latitude"]), zoom
                    ),
                    # jp has no archived per-place reference captures; the tile
                    # plan is its capture path. Empty is the honest value.
                    "nearby_reference_files_json": "[]",
                    "capture_status": carried.get(
                        "capture_status", "pending_dedicated_capture"
                    ),
                    "project_overlay_status": carried.get(
                        "project_overlay_status", "pending"
                    ),
                    "visual_review_status": carried.get("visual_review_status", "pending"),
                    "issue_status": carried.get("issue_status", "not_reviewed"),
                    "review_notes": carried.get("review_notes", ""),
                    "fix_commit": carried.get("fix_commit", ""),
                    "canonical_key": key,
                    "geometry_basis": basis,
                }
            )

    out = merge_with_previous(list(previous.values()), out, wanted)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(out)

    kinds = collections.Counter(row["check_kind"] for row in out)
    bases = collections.Counter(row["geometry_basis"] for row in out)
    print(f"jp: {len(out)} checkpoints -> {OUTPUT.relative_to(APP_DIR)}")
    for kind in ("line_shape", "station_anchor", "segment_geometry"):
        print(f"  {kind:<18}{kinds[kind]:>7}")
    print(
        f"  drawn geometry {bases['drawn_geometry']}, "
        f"audited stations {bases['audited_station']} "
        f"({len(drawn)} of {len(classification)} lines in the package)"
    )


if __name__ == "__main__":
    main()
