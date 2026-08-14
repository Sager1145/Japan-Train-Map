#!/usr/bin/env python3
"""Turn a country's Apple check queue into the SMALLEST set of captures that answers it.

The check queue lists one checkpoint per line, per station and per interval,
because that is the unit a REVIEW is recorded against. It is not the unit a
SCREENSHOT should be taken in: a z14 frame is ~27 x 15 km, so one capture over
Lantau already shows the Disneyland Resort Line, the Tung Chung Line, the
Airport Express, the Tsuen Wan Line and part of the Light Rail. Shooting each
checkpoint separately re-photographs the same square kilometre dozens of times.

This lays a grid per zoom level, one cell per frame, and emits one capture per
NON-EMPTY cell. Every checkpoint keeps its own review row; it is simply
answered by the frame that contains it.

Measured reduction (2026-08-13):

    hk    902 checkpoints ->  72 captures   12.5x
    tw   1173 checkpoints -> 416 captures    2.8x
    jp  20324 checkpoints -> 6598 captures   3.1x

Hong Kong collapses hardest because its network is dense; Taiwan least, because
a 7 x 4 km z16 frame over the west-coast trunk holds two stations. The win is
therefore a property of the network, not a constant — which is why this prints
the real numbers instead of assuming them.

CONTAINMENT: a cell is one frame MINUS a margin on every side, and the capture
is centred on the cell. Every checkpoint in a cell is therefore at least
`--margin` pixels from the frame edge, so nothing lands half-cropped where a
reviewer cannot judge it.

This does not decide what is worth reviewing — every checkpoint in the queue is
still covered. It only stops photographing the same view repeatedly.

Usage:
  python3 app/scripts/validation/plan-apple-capture-tiles.py --country hk
  python3 app/scripts/validation/plan-apple-capture-tiles.py --session 2
"""

from __future__ import annotations

import argparse
import collections
import csv
import math
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = APP_DIR.parent
BATCH_TABLE = REPO_ROOT / "RAILWAY_REBUILD_BATCHES.csv"
OUTPUT_ROOT = REPO_ROOT / "outputs" / "apple-maps-reference"

FRAME = (1512, 855)
DEFAULT_MARGIN = 150
# Apple's URL `z` is not the Web Mercator zoom. Measured at -1; see
# overlay-project-geometry.py, which carries the same offset and the evidence.
ZOOM_OFFSET = -1


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def check_queue_path(country: str) -> Path:
    return (
        APP_DIR / "data" / "raw" / "railway" / country / "rebuild-inventory"
        / "evidence" / "apple-maps-reference" / "check-queue.csv"
    )


def world_xy(lon: float, lat: float, zoom: float) -> tuple[float, float]:
    scale = 256.0 * (2.0**zoom)
    sin_lat = math.sin(math.radians(lat))
    return (
        (lon + 180.0) / 360.0 * scale,
        (0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)) * scale,
    )


def inverse_xy(x: float, y: float, zoom: float) -> tuple[float, float]:
    scale = 256.0 * (2.0**zoom)
    lon = x / scale * 360.0 - 180.0
    n = math.pi - 2.0 * math.pi * y / scale
    lat = math.degrees(math.atan(math.sinh(n)))
    return lon, lat


def plan(rows: list[dict], margin: int) -> tuple[list[dict], dict[str, str]]:
    usable = (FRAME[0] - 2 * margin, FRAME[1] - 2 * margin)
    by_zoom: dict[int, list[dict]] = collections.defaultdict(list)
    for row in rows:
        by_zoom[int(row["apple_zoom"])].append(row)

    tiles: list[dict] = []
    assignment: dict[str, str] = {}
    for apple_zoom in sorted(by_zoom):
        mercator = apple_zoom + ZOOM_OFFSET
        cells: dict[tuple[int, int], list[dict]] = collections.defaultdict(list)
        for row in by_zoom[apple_zoom]:
            x, y = world_xy(float(row["longitude"]), float(row["latitude"]), mercator)
            cells[(math.floor(x / usable[0]), math.floor(y / usable[1]))].append(row)
        for index, (cell, members) in enumerate(sorted(cells.items())):
            centre = inverse_xy(
                (cell[0] + 0.5) * usable[0], (cell[1] + 0.5) * usable[1], mercator
            )
            tile_id = f"Z{apple_zoom}-T{index:04d}"
            kinds = sorted({member["check_kind"] for member in members})
            lines = sorted({member["line_id"] for member in members})
            tiles.append(
                {
                    "tile_id": tile_id,
                    "apple_zoom": apple_zoom,
                    "mercator_zoom": mercator,
                    "longitude": f"{centre[0]:.7f}",
                    "latitude": f"{centre[1]:.7f}",
                    "checkpoints": len(members),
                    "check_kinds": "|".join(kinds),
                    "lines": "|".join(lines),
                    "file": f"{tile_id}.png",
                }
            )
            for member in members:
                assignment[member["check_id"]] = tile_id
    return tiles, assignment


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--country")
    parser.add_argument("--session")
    parser.add_argument("--margin", type=int, default=DEFAULT_MARGIN)
    args = parser.parse_args()

    if args.session:
        batch = [row for row in read_csv(BATCH_TABLE) if row["session"] == str(args.session)]
        if not batch:
            raise SystemExit(f"batch table has no session {args.session}")
        country = batch[0]["country"]
        wanted_lines = {row["line_id"] for row in batch}
        scope = f"session {args.session} ({batch[0]['batch_code']})"
    elif args.country:
        country, wanted_lines, scope = args.country, set(), f"all of {args.country}"
    else:
        raise SystemExit("pass --country <cc> or --session <n>")

    queue_path = check_queue_path(country)
    if not queue_path.exists():
        raise SystemExit(f"no Apple check queue for {country}: {queue_path}")
    # A batch row names a line the way its own country's table does: tw and hk
    # use the display id, jp uses the N02 canonical `operator␟line`. The jp queue
    # carries both, so match on either — matching only `line_id` selects nothing
    # for jp, and an empty selection reads as "this session owes no captures".
    rows = [
        row
        for row in read_csv(queue_path)
        if not wanted_lines
        or row["line_id"] in wanted_lines
        or row.get("canonical_key") in wanted_lines
    ]
    if not rows:
        raise SystemExit("no checkpoints matched")

    tiles, assignment = plan(rows, args.margin)
    output_dir = OUTPUT_ROOT / country
    output_dir.mkdir(parents=True, exist_ok=True)

    tiles_path = output_dir / "capture-tiles.csv"
    with tiles_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(tiles[0].keys()))
        writer.writeheader()
        writer.writerows(tiles)

    map_path = output_dir / "checkpoint-tiles.csv"
    with map_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["check_id", "tile_id"])
        for check_id in sorted(assignment):
            writer.writerow([check_id, assignment[check_id]])

    by_zoom = collections.Counter(tile["apple_zoom"] for tile in tiles)
    counted = collections.Counter(int(row["apple_zoom"]) for row in rows)
    print(f"{scope}: {len(rows)} checkpoints -> {len(tiles)} captures")
    for apple_zoom in sorted(by_zoom):
        print(
            f"  apple z{apple_zoom} (mercator z{apple_zoom + ZOOM_OFFSET}): "
            f"{counted[apple_zoom]:>6} checkpoints -> {by_zoom[apple_zoom]:>5} tiles "
            f"({counted[apple_zoom] / by_zoom[apple_zoom]:.1f} per capture)"
        )
    print(
        f"  {len(rows) / len(tiles):.1f}x fewer captures, "
        f"~{len(tiles) * 3.9 / 60:.1f} min at 3.9 s each"
    )
    print(f"\n{tiles_path}\n{map_path}")


if __name__ == "__main__":
    main()
