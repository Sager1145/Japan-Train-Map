#!/usr/bin/env python3
"""Draw this project's geometry over an Apple Maps capture, at the same extent.

Gate 5 of a rebuild session is not "we have Apple screenshots" — it is "the
railway we draw and the railway Apple draws are the same railway". Comparing
two pictures side by side answers that badly; putting one on top of the other
answers it in a glance, and the offset is measurable rather than impressionistic.

For every checkpoint this renders the package's own line geometry and station
anchors into the SAME frame the capture used (centre coordinate, zoom, pixel
size), then composites it over the capture. What you see is:

  * project lines in their own colours, drawn 3 px wide with a dark casing;
  * project station anchors as open circles;
  * a crosshair at the checkpoint coordinate, so "is the frame centred where it
    claims" is visible and not assumed.

Only geometry is drawn. The basemap, labels and Apple's own styling are
deliberately not reproduced: this compares ALIGNMENT, and a pixel-identical
restyle would hide exactly the drift it exists to find.

ZOOM: Apple's `z` URL parameter is not the Web Mercator zoom. Measured against
HK-APPLE-hk-mtr-drl-L000 (two stations of known coordinate, z=14 requested),
the frame's scale is Web Mercator z13 at 1 CSS px — an offset of -1. That
offset is a MEASUREMENT, not a constant Apple documents, so it is exposed as
--zoom-offset and must be re-checked whenever the capture window or a macOS
version changes.

Usage:
  python3 app/scripts/validation/overlay-project-geometry.py --session 2
  python3 app/scripts/validation/overlay-project-geometry.py --country hk --check-id HK-APPLE-hk-mtr-drl-L000
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

APP_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = APP_DIR.parent
BATCH_TABLE = REPO_ROOT / "RAILWAY_REBUILD_BATCHES.csv"
CAPTURE_ROOT = REPO_ROOT / "outputs" / "apple-maps-reference"

FRAME = (1512, 855)
DEFAULT_ZOOM_OFFSET = -1
LINE_WIDTH = 3
CASING_WIDTH = 5
STATION_RADIUS = 5


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def world_xy(lon: float, lat: float, zoom: float) -> tuple[float, float]:
    """Web Mercator, 256 px tiles."""
    scale = 256.0 * (2.0**zoom)
    x = (lon + 180.0) / 360.0 * scale
    sin_lat = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)) * scale
    return x, y


def projector(centre_lon: float, centre_lat: float, zoom: float, size: tuple[int, int]):
    cx, cy = world_xy(centre_lon, centre_lat, zoom)

    def project(lon: float, lat: float) -> tuple[float, float]:
        x, y = world_xy(lon, lat, zoom)
        return x - cx + size[0] / 2.0, y - cy + size[1] / 2.0

    return project


def visible(points: list[tuple[float, float]], size: tuple[int, int]) -> bool:
    margin = 200
    return any(
        -margin <= x <= size[0] + margin and -margin <= y <= size[1] + margin
        for x, y in points
    )


def render_overlay(package: dict, row: dict, zoom_offset: float) -> Image.Image:
    zoom = float(row["apple_zoom"]) + zoom_offset
    project = projector(float(row["longitude"]), float(row["latitude"]), zoom, FRAME)
    overlay = Image.new("RGBA", FRAME, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    for line in package.get("lines", []):
        colour = line.get("color") or "#7C8A82"
        for segment in line.get("segments", []):
            points = [project(lon, lat) for lon, lat in segment[2]]
            if len(points) < 2 or not visible(points, FRAME):
                continue
            draw.line(points, fill=(10, 12, 16, 200), width=CASING_WIDTH, joint="curve")
            draw.line(points, fill=colour, width=LINE_WIDTH, joint="curve")

    for line in package.get("lines", []):
        colour = line.get("color") or "#7C8A82"
        for station in line.get("stations", []):
            x, y = project(station[2], station[3])
            if not visible([(x, y)], FRAME):
                continue
            box = [x - STATION_RADIUS, y - STATION_RADIUS, x + STATION_RADIUS, y + STATION_RADIUS]
            draw.ellipse(box, fill=(255, 255, 255, 235), outline=colour, width=2)

    # Crosshair on the requested centre: proves the frame is where it claims.
    cx, cy = FRAME[0] / 2, FRAME[1] / 2
    for a, b in (((cx - 14, cy), (cx + 14, cy)), ((cx, cy - 14), (cx, cy + 14))):
        draw.line([a, b], fill=(255, 64, 64, 220), width=1)

    return overlay


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session")
    parser.add_argument("--country")
    parser.add_argument("--check-id", default="", help="tile id (or legacy check id)")
    parser.add_argument("--zoom-offset", type=float, default=DEFAULT_ZOOM_OFFSET)
    parser.add_argument("--opacity", type=float, default=1.0)
    args = parser.parse_args()

    if args.session:
        rows = [row for row in read_csv(BATCH_TABLE) if row["session"] == str(args.session)]
        if not rows:
            raise SystemExit(f"batch table has no session {args.session}")
        country = rows[0]["country"]
    elif args.country:
        country = args.country
    else:
        raise SystemExit("pass --session <n> or --country <cc>")

    capture_dir = CAPTURE_ROOT / country
    index_path = capture_dir / "captured-index.csv"
    if not index_path.exists():
        raise SystemExit(f"no captures yet for {country}: run capture-apple-maps-checkqueue.py")

    package = json.loads((APP_DIR / "public" / "rail" / f"{country}-2025.json").read_text("utf-8"))
    output_dir = capture_dir / "overlay"
    output_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    for row in read_csv(index_path):
        key = row.get("tile_id") or row.get("check_id")
        if args.check_id and key != args.check_id:
            continue
        capture_path = capture_dir / row["file"]
        if not capture_path.exists():
            continue
        base = Image.open(capture_path).convert("RGBA")
        if base.size != FRAME:
            base = base.resize(FRAME)
        overlay = render_overlay(package, row, args.zoom_offset)
        if args.opacity < 1.0:
            alpha = overlay.getchannel("A").point(lambda value: int(value * args.opacity))
            overlay.putalpha(alpha)
        composite = Image.alpha_composite(base, overlay).convert("RGB")
        destination = output_dir / f"{key}.png"
        composite.save(destination)
        written += 1
        print(
            f"  {key:<16} z{row['apple_zoom']}->{float(row['apple_zoom']) + args.zoom_offset:g}  "
            f"{row.get('checkpoints', '?'):>4} checkpoints  {destination.name}"
        )

    print(f"{written} overlay(s) -> {output_dir}")


if __name__ == "__main__":
    main()
