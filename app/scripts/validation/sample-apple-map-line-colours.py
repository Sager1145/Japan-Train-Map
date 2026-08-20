#!/usr/bin/env python3
"""Sample every Japanese display line's colour from the Apple Maps survey.

The input is the repository's complete z2 dark-mode Transit screenshot survey.
N02/platform anchors and Apple's cartographic station positions can differ by
several hundred metres, so this does not trust one pixel at one coordinate. It
collects chromatic pixels around many station and mid-line probes, clusters
near-identical antialiasing shades, and scores candidates by recurrence along
the whole railway plus proximity to the currently sourced colour.

The output is evidence, not an assertion that Apple publishes a canonical HEX.
It records the visible raster sample, its support and its ambiguity so the
classification pipeline can prefer a real operator colour where one exists and
use Apple as the line-by-line source for the large remainder.

Run with the Codex workspace Python (Pillow + NumPy):

  /path/to/workspace/python/bin/python3 \
    scripts/validation/sample-apple-map-line-colours.py
"""

from __future__ import annotations

import argparse
import colorsys
import csv
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image


APP_DIR = Path(__file__).resolve().parents[2]
APPLE_ROOT = APP_DIR / "data/raw/railway/jp/apple-maps"
PACKAGE_PATH = APP_DIR / "public/rail/jp-2025.json"
COLOUR_INVENTORY = (
    APP_DIR
    / "data/raw/railway/jp/rebuild-inventory/colours/n02-official-line-colours.csv"
)
OUTPUT_PATH = (
    APP_DIR
    / "data/raw/railway/jp/rebuild-inventory/colours/apple-map-line-colours.csv"
)

WIDTH = 3024
HEIGHT = 1964
KEY_SEPARATOR = "␟"
PACKAGE_OPERATOR_ALIASES = {
    "Osaka Metro": "大阪市高速電気軌道",
    "東京メトロ": "東京地下鉄",
}
MAX_STATION_PROBES = 56
MAX_LINE_PROBES = 56
STATION_RADIUS = 26
LINE_RADIUS = 18


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apple-root", type=Path, default=APPLE_ROOT)
    parser.add_argument("--package", type=Path, default=PACKAGE_PATH)
    parser.add_argument("--inventory", type=Path, default=COLOUR_INVENTORY)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    return parser.parse_args()


def mercator_y(latitude: float) -> float:
    radians = math.radians(max(-85.05112878, min(85.05112878, latitude)))
    return math.log(math.tan(math.pi / 4 + radians / 2))


def hex_rgb(value: str) -> tuple[int, int, int]:
    text = (value or "#8a8f98").lstrip("#")
    return tuple(int(text[index : index + 2], 16) for index in (0, 2, 4))


def rgb_hex(value: tuple[int, int, int] | np.ndarray) -> str:
    return "#" + "".join(f"{int(channel):02x}" for channel in value)


def oklab(rgb: tuple[int, int, int] | np.ndarray) -> np.ndarray:
    value = np.asarray(rgb, dtype=float) / 255
    value = np.where(
        value <= 0.04045,
        value / 12.92,
        ((value + 0.055) / 1.055) ** 2.4,
    )
    red, green, blue = value[..., 0], value[..., 1], value[..., 2]
    long = np.cbrt(
        0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue
    )
    medium = np.cbrt(
        0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue
    )
    short = np.cbrt(
        0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue
    )
    return np.stack(
        [
            0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
            1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
            0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
        ],
        axis=-1,
    )


def colour_distance(left: tuple[int, int, int], right: tuple[int, int, int]) -> float:
    delta = oklab(left) - oklab(right)
    return float(np.linalg.norm(delta * np.array([1, 1.25, 1.25])))


def chroma(rgb: tuple[int, int, int]) -> int:
    return max(rgb) - min(rgb)


def hue(rgb: tuple[int, int, int]) -> float:
    return colorsys.rgb_to_hsv(*(channel / 255 for channel in rgb))[0]


def evenly_spaced(values: list, maximum: int) -> list:
    if len(values) <= maximum:
        return values
    return [
        values[round(index * (len(values) - 1) / (maximum - 1))]
        for index in range(maximum)
    ]


def line_probe_points(line: dict) -> list[tuple[float, float]]:
    points = []
    for segment in line.get("segments", []):
        coordinates = segment[2]
        if not coordinates:
            continue
        for fraction in (0.2, 0.4, 0.6, 0.8):
            points.append(coordinates[round(fraction * (len(coordinates) - 1))])
    return evenly_spaced(points, MAX_LINE_PROBES)


def load_manifest(root: Path) -> list[dict]:
    rows = list(csv.DictReader((root / "manifests/manifest_z2.csv").open()))
    for row in rows:
        for key in ("west", "east", "south", "north"):
            row[key] = float(row[key])
    return rows


def best_tile(
    manifest: list[dict], longitude: float, latitude: float
) -> tuple[dict, float, float, float] | None:
    candidates = []
    for row in manifest:
        if not (
            row["west"] <= longitude <= row["east"]
            and row["south"] <= latitude <= row["north"]
        ):
            continue
        x = (longitude - row["west"]) / (row["east"] - row["west"]) * WIDTH
        y = (
            (mercator_y(row["north"]) - mercator_y(latitude))
            / (mercator_y(row["north"]) - mercator_y(row["south"]))
            * HEIGHT
        )
        # Prefer the clean map rectangle retained by stitch.py, away from the
        # title bar, floating controls and screenshot-edge haze.
        edge = min(x - 260, 2773 - x, y - 191, 1809 - y)
        candidates.append((edge, row, x, y))
    if not candidates:
        return None
    edge, row, x, y = max(candidates, key=lambda item: item[0])
    return row, x, y, edge


def cluster_key(pixel: tuple[int, int, int]) -> tuple[int, int, int]:
    # Four-channel buckets join the one- or two-unit antialiasing variants
    # visible in screenshots while keeping adjacent route colours distinct.
    return tuple(min(252, ((channel + 2) // 4) * 4) for channel in pixel)


def usable_pixels(patch: np.ndarray) -> np.ndarray:
    flat = patch.reshape(-1, 3)
    maximum = flat.max(axis=1)
    minimum = flat.min(axis=1)
    # Removes roads, terrain, labels, black/white markers and the dark map
    # surface. A neutral/grey railway cannot be identified safely from a dark
    # screenshot and is deliberately left to the sourced neutral fallback.
    mask = (
        (maximum - minimum >= 42)
        & (maximum >= 105)
        & ~((maximum >= 238) & (minimum >= 225))
        & ~(maximum <= 45)
    )
    return flat[mask]


def add_patch(
    image: np.ndarray,
    x: float,
    y: float,
    radius: int,
    line_key: str,
    probe_kind: str,
    totals: dict[str, Counter],
    supports: dict[str, Counter],
    kind_supports: dict[str, dict[str, Counter]],
    windows: Counter,
) -> None:
    center_x, center_y = round(x), round(y)
    patch = image[
        max(0, center_y - radius) : min(HEIGHT, center_y + radius + 1),
        max(0, center_x - radius) : min(WIDTH, center_x + radius + 1),
    ]
    pixels = usable_pixels(patch)
    local = Counter(cluster_key(tuple(pixel)) for pixel in pixels.tolist())
    for colour, count in local.items():
        totals[line_key][colour] += count
        supports[line_key][colour] += 1
        kind_supports[line_key][probe_kind][colour] += 1
    windows[line_key] += 1


def candidate_rows(
    current: tuple[int, int, int],
    total: Counter,
    support: Counter,
    station_support: Counter,
    line_support: Counter,
    window_count: int,
) -> list[dict]:
    rows = []
    minimum_support = max(1, math.ceil(window_count * 0.05))
    prior_chroma = chroma(current)
    for colour, pixels in total.items():
        occurrences = support[colour]
        if occurrences < minimum_support:
            continue
        support_fraction = occurrences / max(1, window_count)
        density = min(1, pixels / max(1, window_count * 4))
        distance = colour_distance(colour, current)
        similarity = math.exp(-((distance / 0.18) ** 2)) if prior_chroma >= 20 else 0
        both_probe_kinds = bool(station_support[colour] and line_support[colour])
        score = (
            0.48 * support_fraction
            + 0.17 * density
            + 0.30 * similarity
            + (0.05 if both_probe_kinds else 0)
        )
        rows.append(
            {
                "colour": colour,
                "score": score,
                "support": occurrences,
                "support_fraction": support_fraction,
                "pixels": pixels,
                "distance": distance,
                "similarity": similarity,
                "station_support": station_support[colour],
                "line_support": line_support[colour],
            }
        )
    return sorted(rows, key=lambda row: (row["score"], row["pixels"]), reverse=True)


def confidence_for(best: dict | None, margin: float, windows: int) -> str:
    if not best:
        return "none"
    support = best["support_fraction"]
    if support >= 0.42 and (margin >= 0.035 or best["similarity"] >= 0.7):
        return "high"
    if support >= 0.16 and (
        margin >= 0.025
        or best["similarity"] >= 0.45
        or (best["station_support"] >= 2 and best["line_support"] >= 2)
    ):
        return "medium"
    if windows <= 4 and best["similarity"] >= 0.65 and best["pixels"] >= 4:
        return "medium"
    return "low"


def main() -> None:
    args = parse_args()
    Image.MAX_IMAGE_PIXELS = None
    package = json.loads(args.package.read_text())
    inventory_rows = list(csv.DictReader(args.inventory.open(encoding="utf-8-sig")))
    inventory = {row["canonical_key"]: row for row in inventory_rows}
    manifest = load_manifest(args.apple_root)

    package_lines = defaultdict(list)
    for line in package["lines"]:
        operator = PACKAGE_OPERATOR_ALIASES.get(line["operator"], line["operator"])
        package_lines[f'{operator}{KEY_SEPARATOR}{line["name"]}'].append(line)

    requests = defaultdict(list)
    probe_totals = Counter()
    for key, rows in package_lines.items():
        seen_stations = set()
        station_points = []
        line_points = []
        for line in rows:
            for station in line.get("stations", []):
                point = (float(station[2]), float(station[3]))
                if point not in seen_stations:
                    seen_stations.add(point)
                    station_points.append(point)
            line_points.extend(line_probe_points(line))
        probes = [
            (point, STATION_RADIUS, "station")
            for point in evenly_spaced(station_points, MAX_STATION_PROBES)
        ] + [
            (point, LINE_RADIUS, "line")
            for point in evenly_spaced(line_points, MAX_LINE_PROBES)
        ]
        for point, radius, kind in probes:
            tile = best_tile(manifest, point[0], point[1])
            if not tile:
                continue
            row, x, y, edge = tile
            if edge < -radius:
                continue
            requests[row["id"]].append((key, x, y, radius, kind))
            probe_totals[key] += 1

    totals = defaultdict(Counter)
    supports = defaultdict(Counter)
    kind_supports = defaultdict(lambda: defaultdict(Counter))
    windows = Counter()
    tile_count = len(requests)
    for index, (tile_id, items) in enumerate(sorted(requests.items()), 1):
        image_path = args.apple_root / f"out/z2/{tile_id}.png"
        image = np.asarray(Image.open(image_path).convert("RGB"))
        for key, x, y, radius, kind in items:
            add_patch(
                image,
                x,
                y,
                radius,
                key,
                kind,
                totals,
                supports,
                kind_supports,
                windows,
            )
        if index % 25 == 0 or index == tile_count:
            print(f"sampled {index}/{tile_count} z2 screenshots")

    output = []
    for row in inventory_rows:
        key = row["canonical_key"]
        current_hex = row["render_color_hex"] or "#8a8f98"
        current = hex_rgb(current_hex)
        candidates = candidate_rows(
            current,
            totals[key],
            supports[key],
            kind_supports[key]["station"],
            kind_supports[key]["line"],
            windows[key],
        )
        best = candidates[0] if candidates else None
        second_score = candidates[1]["score"] if len(candidates) > 1 else 0
        margin = best["score"] - second_score if best else 0
        confidence = confidence_for(best, margin, windows[key])
        sampled_hex = rgb_hex(best["colour"]) if best else ""
        candidate_text = "|".join(
            f'{rgb_hex(item["colour"])}:{item["support"]}/{windows[key]}:{item["score"]:.3f}'
            for item in candidates[:5]
        )
        if not best:
            note = "截图覆盖存在，但未检出可与底图可靠分离的彩色线路像素。"
        elif confidence == "low":
            note = "已逐线取样；候选像素支持度或与次选的区分不足，保留为低置信度证据。"
        else:
            note = "由全国z2 Apple地图大众运输截图沿车站及线路几何重复取样；HEX为屏幕栅格样本，不冒称运营者发布色号。"
        output.append(
            {
                "canonical_key": key,
                "operator": row["operator"],
                "line": row["line"],
                "prior_render_color_hex": current_hex.lower(),
                "apple_map_sample_hex": sampled_hex,
                "apple_map_sample_confidence": confidence,
                "apple_map_sample_support": best["support"] if best else 0,
                "apple_map_sample_support_fraction": (
                    f'{best["support_fraction"]:.4f}' if best else "0.0000"
                ),
                "apple_map_sample_pixels": best["pixels"] if best else 0,
                "apple_map_sample_distance_from_prior": (
                    f'{best["distance"]:.4f}' if best else ""
                ),
                "apple_map_sample_margin": f"{margin:.4f}",
                "apple_map_station_support": best["station_support"] if best else 0,
                "apple_map_line_support": best["line_support"] if best else 0,
                "apple_map_probe_windows": windows[key],
                "apple_map_candidates": candidate_text,
                "apple_map_source": "apple-maps/out/z2 (complete nationwide Transit screenshot survey, Apple zoom 12)",
                "apple_map_notes": note,
            }
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(output[0]))
        writer.writeheader()
        writer.writerows(output)

    confidence_counts = Counter(row["apple_map_sample_confidence"] for row in output)
    sampled = sum(bool(row["apple_map_sample_hex"]) for row in output)
    print(
        json.dumps(
            {
                "canonical_lines": len(output),
                "sampled_lines": sampled,
                "confidence": confidence_counts,
                "z2_screenshots_read": tile_count,
                "output": str(args.output),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
