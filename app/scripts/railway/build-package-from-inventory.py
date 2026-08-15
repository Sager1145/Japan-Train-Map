#!/usr/bin/env python3
"""Build a country's display package from its AUDITED rebuild inventory.

Why the original builders are not the rebuild path
--------------------------------------------------
Neither country's builder can be re-run from the repository today:

  build-hong-kong-rail-package.py  needs --mtr-html / --mtr-csv, scraped to
                                   /tmp and never archived.
  build-taiwan-rail-package.py     needs eight downloaded inputs (TDX/PTX
                                   snapshots, four NLSC shapefiles, the Taipei
                                   metro GeoJSON, the Alishan detail SHP), none
                                   of which live under data/raw/railway/tw/.

That is a source-retention gap in both cases. The 2026-08-13 audit inventories
ARE archived, and they are the better source anyway, because they carry the
corrections: the directed passenger-service graph, the passenger/physical layer
split, official station identity and English names, and colour provenance.

What comes from where
---------------------
    station order      stations/station-connections.csv, walked on the layer
                       the line actually runs on
    station identity   stations/station-network.json
    on-line anchors    each station's per-line on_line_render_anchor
    colour             colours/line-colours.csv render_color_hex
    geometry           hk: hk-track-alignments.json + hk-tram-alignments.json
                       tw: the audited source package's own per-line centre-line
    rank / isHSR       hk: derived by rule (heavy rail vs light rail)
                       tw: carried from the audited source package, which is
                           where those display attributes were validated; the
                           inventory does not publish them

Geometry is re-cut, not re-derived: intervals are cut from those centre-lines by
the same split_route/compact_line path the audited packages used, so a rebuilt
line differs from the old one in WHERE ITS ORDER AND IDENTITY COME FROM, not in
how a polyline is cut.

What this refuses to do
-----------------------
A line whose service graph is not a simple chain or a simple directed cycle is
SKIPPED with its reason, never guessed. compact-v1 stores a line as an ordered
list of DISTINCT stations, so a service that traverses a station twice — Light
Rail 505 and 751, whose two directions are not mirror images — cannot be
expressed in it without dropping the direction-unique edges. Dropping them is
exactly the `network_union_missing_branch_edge` defect the display rules name,
so those lines wait for an explicit decision instead.

Output is a staging package. public/rail/<cc>-2025.json is only ever written by
scripts/railway/promote-lines.mjs, one session's lines at a time.

Usage:
  python3 app/scripts/railway/build-package-from-inventory.py --country hk
  python3 app/scripts/railway/build-package-from-inventory.py --country tw
"""

from __future__ import annotations

import argparse
import collections
import csv
import importlib
import importlib.util
import json
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
RAW = APP_DIR / "data" / "raw" / "railway"
STAGING_DIR = APP_DIR / "data" / "staging"

PACKAGE_VERSION = {"hk": "2025.3.0", "tw": "2025.7.0"}
GENERATED_AT = "2026-08-13T00:00:00.000Z"

# Hong Kong publishes no rank; heavy rail reads at region scale and the street
# level Light Rail appears with the city. Two ranks, one rule, no table to drift.
HK_HEAVY_RANK, HK_LIGHT_RANK = 1, 3

# Why a line's unrepresented edges have no geometry, per country. Points at the
# open audit issue so the gap stays traceable instead of becoming folklore.
EXTRA_EDGE_EVIDENCE = {
    "hk": "HK-LR-GEOM-002: hk-track-alignments.json holds one polyline per line and does not separate the two tracks",
}

HK_TRAM_ROUTE_CODES = {
    "hk-tram-east": "TRAM-EAST",
    "hk-tram-west": "TRAM-WEST",
    "hk-tram-hv": "TRAM-HV",
    "hk-tram-np": "TRAM-NPT",
}


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def inventory(country: str) -> Path:
    return RAW / country / "rebuild-inventory"


# ---------------------------------------------------------------- geometry


def dedupe_join(points: list[list[float]]) -> list[list[float]]:
    out: list[list[float]] = []
    for point in points:
        if out and abs(out[-1][0] - point[0]) < 1e-12 and abs(out[-1][1] - point[1]) < 1e-12:
            continue
        out.append([point[0], point[1]])
    return out


def geometry_sources(country: str) -> tuple[dict[str, list], str]:
    """line_id -> centre-line, plus a one-line note on where it came from."""
    if country == "hk":
        routes = json.loads((RAW / "hk" / "hk-track-alignments.json").read_text("utf-8"))["routes"]
        trams = json.loads((RAW / "hk" / "hk-tram-alignments.json").read_text("utf-8"))["routes"]
        by_line = {
            f"hk-mtr-{code.lower()}": coordinates for code, coordinates in routes.items()
        }
        for line_id, code in HK_TRAM_ROUTE_CODES.items():
            if code in trams:
                by_line[line_id] = trams[code]["coordinates"]
        return by_line, "hk-track-alignments.json / hk-tram-alignments.json"

    source = json.loads(
        (inventory("tw") / "evidence" / "source-compact-package.json").read_text("utf-8")
    )
    by_line = {}
    for line in source["lines"]:
        points: list[list[float]] = []
        for segment in line["segments"]:
            points.extend(segment[2])
        by_line[line["id"]] = dedupe_join(points)
    return by_line, "rebuild-inventory/evidence/source-compact-package.json (official_geometry)"


# ---------------------------------------------------------------- ordering


def allowed_layers(classified: dict) -> set[str]:
    """Which edges may be walked to order a line's stations.

    A tram vector is physical track, not a service, and has no service edges.

    A service line is ordered on `passenger_service` alone, because that is the
    only layer whose order a timetable supports. Stations that exist on the line
    but handle no passengers — 枋野, 木履寮, 屏遮那 on the South Link and Alishan
    lines — are then INSERTED into that chain by their position along the
    alignment (see insert_non_passenger_stations). Walking both layers instead
    was tried and breaks: the physical-only edges turn Alishan's switchbacks and
    the South Link into graphs with no simple chain at all.
    """
    if classified.get("line_layer") == "physical_track_vector":
        return {"physical_track_vector"}
    return {"passenger_service"}


def station_order(line_id: str, connections: list[dict], layers: set[str]):
    """Return (order, is_loop) or raise with the reason it cannot be ordered."""
    edges = [
        row
        for row in connections
        if row["line_id"] == line_id and (row.get("layer") or "passenger_service") in layers
    ]
    if not edges:
        raise RuntimeError(f"no connections on layer(s) {sorted(layers)}")

    nodes = {row["from_station_uid"] for row in edges} | {row["to_station_uid"] for row in edges}
    out_degree = collections.Counter(row["from_station_uid"] for row in edges)

    # A simple directed cycle: every station left exactly once, as many edges as
    # stations, and NO edge has a reciprocal. Light Rail 705/706 are the one-way
    # Tin Shui Wai circles.
    #
    # The reciprocal test is what separates a real loop from a two-station line:
    # A->B plus B->A also has one edge per station and one departure per station,
    # and read as a cycle it draws the line out and back — which is how the
    # Disneyland Resort Line first came out 5.69 km long instead of 3.03 km.
    directed = {(row["from_station_uid"], row["to_station_uid"]) for row in edges}
    reciprocal = any((b, a) in directed for a, b in directed)
    if (
        len(nodes) >= 3
        and not reciprocal
        and len(edges) == len(nodes)
        and all(out_degree[node] == 1 for node in nodes)
    ):
        successor = {row["from_station_uid"]: row["to_station_uid"] for row in edges}
        start = min(nodes)
        order, current = [], start
        while True:
            order.append(current)
            current = successor[current]
            if current == start:
                break
        if len(order) != len(nodes):
            raise RuntimeError("directed edges form more than one cycle")
        return order, True

    neighbours = collections.defaultdict(set)
    for row in edges:
        neighbours[row["from_station_uid"]].add(row["to_station_uid"])
        neighbours[row["to_station_uid"]].add(row["from_station_uid"])

    # A bidirectional closed loop: undirected, every station has exactly two
    # neighbours and they form ONE ring. Kaohsiung's Circular Light Rail is
    # ridden both ways, so it has no one-way cycle and no chain endpoints.
    if len(nodes) >= 3 and all(len(near) == 2 for near in neighbours.values()):
        start = min(nodes)
        order, previous, current = [], None, start
        while True:
            order.append(current)
            forward = [node for node in sorted(neighbours[current]) if node != previous]
            previous, current = current, forward[0]
            if current == start:
                break
        if len(order) != len(nodes):
            raise RuntimeError("undirected edges form more than one ring")
        return order, True

    ends = sorted(node for node, near in neighbours.items() if len(near) == 1)
    if len(ends) != 2:
        # Not a chain and not a ring. The two directions are not mirror images
        # (Light Rail 505 and 751), so no ordering of distinct stations has a
        # real service edge between every consecutive pair.
        #
        # The station order is still well defined, because compact-v1's order is
        # an order ALONG THE ALIGNMENT, not an adjacency walk: split_route cuts
        # the centre-line between consecutive projected stations, whether or not
        # a train runs directly between them. So order by projected distance and
        # let the caller record the edges that order does not represent.
        return None, False

    order, previous, current = [], None, ends[0]
    while current is not None:
        order.append(current)
        forward = [node for node in sorted(neighbours[current]) if node != previous]
        previous, current = current, (forward[0] if forward else None)
    if len(order) != len(neighbours):
        raise RuntimeError(f"walked {len(order)} of {len(neighbours)} stations — not a simple chain")
    return order, False


def alignment_order(anchors, route, geometry_lib):
    """Every station of a line, ordered by where it projects onto the centre-line.

    Always defined, and independent of service direction — which is exactly what
    a line whose two directions disagree needs.
    """
    measures = geometry_lib.route_measures(route)
    return sorted(
        anchors, key=lambda uid: geometry_lib.project_to_route(anchors[uid], route, measures)[1]
    )


def unrepresented_edges(order, connections, line_id, layers):
    """Service edges the station ORDER does not put next to each other.

    These are real track that the drawn chain never traverses. Dropping them is
    `network_union_missing_branch_edge` (display rules 19.7): the network union
    would be missing a branch the operator runs. They are returned so the caller
    can record them, with the pairs that are consecutive in the order but carry
    no service reported alongside — a chain segment drawn over track no train
    uses in that direction is worth knowing about too.
    """
    position = {uid: index for index, uid in enumerate(order)}
    service = {
        frozenset((row["from_station_uid"], row["to_station_uid"]))
        for row in connections
        if row["line_id"] == line_id and (row.get("layer") or "passenger_service") in layers
    }
    consecutive = {frozenset((order[i], order[i + 1])) for i in range(len(order) - 1)}
    extra = sorted(
        (sorted((position[a], position[b])) for a, b in (tuple(e) for e in service - consecutive)),
    )
    order_only = sorted(
        (sorted((position[a], position[b])) for a, b in (tuple(e) for e in consecutive - service)),
    )
    return extra, order_only


def insert_non_passenger_stations(order, anchors, route, geometry_lib):
    """Put stations that exist on the line but carry no passengers back on it.

    They are absent from the passenger-service graph by design, but they are
    real railway and the compact package is the display package: drawing the
    South Link with 11 stations instead of 12 deletes a station that is there.
    Position comes from projecting onto the line's own centre-line, so it needs
    no order evidence the inventory does not have.
    """
    extra = [uid for uid in anchors if uid not in set(order)]
    if not extra:
        return order, []
    measures = geometry_lib.route_measures(route)
    at = {
        uid: geometry_lib.project_to_route(anchors[uid], route, measures)[1]
        for uid in set(order) | set(extra)
    }
    ordered = sorted(order, key=lambda uid: at[uid])
    if ordered != list(order) and ordered != list(reversed(order)):
        # Projection disagrees with the timetable order, so it cannot be trusted
        # to place anything either. Leave the chain alone and report the gap.
        return order, extra
    merged = sorted(set(order) | set(extra), key=lambda uid: at[uid])
    if ordered == list(reversed(order)):
        merged.reverse()
    return merged, []


def oriented(order, anchors, route, geometry_lib, is_loop):
    """Point a chain along the alignment; a cycle keeps its own direction."""
    if is_loop:
        return order
    measures = geometry_lib.route_measures(route)
    first = geometry_lib.project_to_route(anchors[order[0]], route, measures)
    last = geometry_lib.project_to_route(anchors[order[-1]], route, measures)
    return order if first[1] <= last[1] else list(reversed(order))


# ---------------------------------------------------------------- build


def build(country: str, selected: set[str] | None, write_datasets: bool = False) -> None:
    builder = load_module(
        APP_DIR / "scripts" / "railway" / "build-hong-kong-rail-package.py", "hk_rail_builder"
    )
    geometry_lib = importlib.import_module("lib.geometry")

    root = inventory(country)
    network = json.loads((root / "stations" / "station-network.json").read_text("utf-8"))
    connections = read_csv(root / "stations" / "station-connections.csv")
    colours = {row["line_id"]: row for row in read_csv(root / "colours" / "line-colours.csv")}
    classification = {
        row["line_id"]: row for row in read_csv(root / "lines" / "line-classification.csv")
    }
    routes, geometry_note = geometry_sources(country)
    station_by_uid = {row["station_uid"]: row for row in network["stations"]}

    carried: dict[str, dict] = {}
    if country == "tw":
        source = json.loads(
            (root / "evidence" / "source-compact-package.json").read_text("utf-8")
        )
        carried = {line["id"]: line for line in source["lines"]}

    lines, skipped, notes = [], [], []
    for line_id in sorted(classification):
        if selected and line_id not in selected:
            continue
        classified = classification[line_id]
        route = routes.get(line_id)
        if not route:
            skipped.append((line_id, "no centre-line in the archived geometry source"))
            continue

        anchors = {}
        for station in network["stations"]:
            for line in station["connected_lines"]:
                if line["line_id"] != line_id:
                    continue
                points = line.get("station_points") or []
                if points:
                    anchors[station["station_uid"]] = [
                        points[0]["longitude"],
                        points[0]["latitude"],
                    ]

        try:
            layers = allowed_layers(classified)
            order, is_loop = station_order(line_id, connections, layers)
            if order is None:
                order = alignment_order(anchors, route, geometry_lib)
                extra_edges, order_only = unrepresented_edges(
                    order, connections, line_id, layers
                )
            else:
                extra_edges, order_only = [], []
            missing = [uid for uid in order if uid not in anchors]
            if missing:
                raise RuntimeError(f"{len(missing)} station(s) have no on-line anchor")
            order = oriented(order, anchors, route, geometry_lib, is_loop)
            if not is_loop:
                order, unplaced = insert_non_passenger_stations(
                    order, anchors, route, geometry_lib
                )
                if unplaced:
                    notes.append(
                        (line_id, f"{len(unplaced)} non-passenger station(s) not placed")
                    )
        except RuntimeError as error:
            skipped.append((line_id, str(error)))
            continue

        stations = [
            {
                "group": station_by_uid[uid]["physical_station_group"],
                "zh": station_by_uid[uid]["station_name"],
                "zh_hans": builder.to_hans(station_by_uid[uid]["station_name"]),
                "en": station_by_uid[uid].get("station_english") or "",
                "alias": uid,
                "lon": anchors[uid][0],
                "lat": anchors[uid][1],
            }
            for uid in order
        ]

        if country == "hk":
            rank = HK_LIGHT_RANK if ("-lr-" in line_id or "tram" in line_id) else HK_HEAVY_RANK
        else:
            rank = carried.get(line_id, {}).get("rank", 3)

        try:
            line = builder.compact_line(
                line_id,
                line_id.split("-")[-1].upper(),
                classified["line"],
                classified["line_english"],
                classified["operator"],
                colours[line_id]["render_color_hex"],
                rank,
                stations,
                route,
                loop=is_loop,
            )
        except RuntimeError as error:
            skipped.append((line_id, f"geometry cut failed: {error}"))
            continue

        if carried.get(line_id, {}).get("isHSR"):
            line["isHSR"] = 1

        if extra_edges:
            # Recorded as TOPOLOGY ONLY, with no geometry, and that is the
            # honest answer rather than a limitation to apologise for.
            #
            # These edges exist — 505's two directions take different streets,
            # 751 serves 安定 one way only — but the archived alignment holds ONE
            # polyline per line and does not separate the tracks (audit issue
            # HK-LR-GEOM-002). Cutting geometry for them from that single
            # centre-line would lay a second stroke exactly on top of the first,
            # which draws the claim that the two directions share track — the
            # opposite of what the audit established. Inventing the separation
            # is worse still.
            #
            # So the edge is stored, flagged, and NOT drawn. The renderer draws
            # only extraSegments that carry geometry, so supplying split-track
            # geometry later needs no schema change and no code change.
            line["extraSegments"] = [
                {
                    "from": pair[0],
                    "to": pair[1],
                    "status": "data_coverage_gap",
                    "evidence": EXTRA_EDGE_EVIDENCE.get(country, "no split-track geometry archived"),
                }
                for pair in extra_edges
            ]
            notes.append(
                (
                    line_id,
                    f"{len(extra_edges)} service edge(s) the station order cannot carry, "
                    f"recorded in extraSegments without geometry"
                    + (f"; {len(order_only)} drawn pair(s) carry no service" if order_only else ""),
                )
            )
        lines.append(line)

    if write_datasets:
        # DISABLED, and the reason is worth keeping.
        #
        # The solver datasets ARE derived from the drawn package, and leaving
        # them stale is a real defect: "Hong Kong sample routes coincide exactly
        # with the drawn network" and "Taiwan section geometry matches the drawn
        # rail package" both fail on it today.
        #
        # But regenerating them through build_derived_datasets() derives each
        # station's CODE from the line's codePrefix, and those codes are
        # PERSISTED IDENTITY: train stores and readings reference them, and
        # Taiwan's must be TDX StationUIDs. Running it with a codePrefix guessed
        # from the line id rewrote every code and broke six previously passing
        # tests across both countries — worse than the staleness it fixed.
        #
        # Regenerating them needs the real per-line code prefixes (hk) and the
        # TDX StationUID mapping (tw), neither of which the rebuild inventory
        # publishes. That is its own piece of work, not a flag on this builder.
        raise SystemExit(
            "--write-datasets is disabled: regenerating solver datasets rewrites "
            "persisted station codes (Taiwan's must be TDX StationUIDs) and the "
            "rebuild inventory does not publish the mapping. See the comment here."
        )

    package = {
        "format": "compact-v1",
        "version": PACKAGE_VERSION[country],
        "generatedAt": GENERATED_AT,
        "crs": "WGS84",
        "country": country.upper(),
        "lines": builder.strip_build_fields(lines),
        "geometrySource": {
            "officialOnly": 1 if country == "tw" else 0,
            "stationData": f"data/raw/railway/{country}/rebuild-inventory (2026-08-13 audited service graph)",
            "geometry": geometry_note,
            "method": (
                "Station order chained from the audited directed service graph on the "
                "line's own layer; intervals cut from the archived centre-lines at each "
                "line's on-line render anchors."
            ),
        },
        "lanes": [],
    }

    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    destination = STAGING_DIR / f"{country}-2025.staging.json"
    destination.write_text(json.dumps(package, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"{country}: {len(package['lines'])} lines -> {destination.relative_to(APP_DIR)}")
    for line in package["lines"]:
        loop = " loop" if line.get("isLoop") else ""
        print(
            f"  {line['id']:<22}{len(line['stations']):>4} stations"
            f"{len(line['segments']):>5} intervals"
            f"{sum(row[0] for row in line['segments']):>9.2f} km  {line['color']}{loop}"
        )
    for line_id, reason in notes:
        print(f"  NOTE    {line_id}: {reason}")
    for line_id, reason in skipped:
        print(f"  SKIPPED {line_id}: {reason}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--country", required=True, choices=["hk", "tw"])
    parser.add_argument("--lines", default="")
    parser.add_argument(
        "--write-datasets",
        action="store_true",
        help="also regenerate the country's solver sections and stations",
    )
    args = parser.parse_args()
    selected = {value.strip() for value in args.lines.split(",") if value.strip()}
    build(args.country, selected or None, args.write_datasets)


if __name__ == "__main__":
    main()
