#!/usr/bin/env python3
"""Which N02 sections each drawn line actually rides — derived, not instrumented.

RAILWAY_MULTILINE_STATION_AUDIT_PROMPT.md 3.2 asks for per-interval section
provenance so "are these two strokes on the same track" becomes a set
intersection instead of a distance threshold. The builder's TrackGraph knows it
(`self.source[piece]`), but plumbing it out means editing a builder another
session is also editing.

It does not have to be instrumented. A drawn interval IS a slice of N02 section
geometry, so every drawn vertex lies within centimetres of the section it came
from: matching vertices back to sections recovers the same answer read-only,
and it works on any published package including archived ones.

Usage:
  python3 app/scripts/validation/audit-section-usage.py
  python3 app/scripts/validation/audit-section-usage.py --lines jp-...,jp-...
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = APP_DIR.parent
PACKAGE = APP_DIR / "public/rail/jp-2025.json"
OUT = REPO_DIR / "outputs/railway-audit/section-usage.json"

MATCH_METERS = 8.0
SAMPLE_STEP_METERS = 20.0
CELL_DEGREES = 0.005


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def metres(a, b):
    return math.hypot(
        (a[0] - b[0]) * 111320 * math.cos(math.radians((a[1] + b[1]) / 2)),
        (a[1] - b[1]) * 111320,
    )


def segment_distance(point, start, end):
    scale = math.cos(math.radians(point[1]))
    ax = (start[0] - point[0]) * 111320 * scale
    ay = (start[1] - point[1]) * 111320
    bx = (end[0] - point[0]) * 111320 * scale
    by = (end[1] - point[1]) * 111320
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length))
    return math.hypot(ax + t * dx, ay + t * dy)


class SectionIndex:
    """Grid index over N02 section edges; answers "every section within r"."""

    def __init__(self, sections):
        self.cells = defaultdict(list)
        for index, section in enumerate(sections):
            coords = section.coords
            for i in range(1, len(coords)):
                a, b = coords[i - 1], coords[i]
                x0 = int(min(a[0], b[0]) / CELL_DEGREES)
                x1 = int(max(a[0], b[0]) / CELL_DEGREES)
                y0 = int(min(a[1], b[1]) / CELL_DEGREES)
                y1 = int(max(a[1], b[1]) / CELL_DEGREES)
                for x in range(x0, x1 + 1):
                    for y in range(y0, y1 + 1):
                        self.cells[(x, y)].append((a, b, index))

    def near(self, point, radius):
        gx = int(point[0] / CELL_DEGREES)
        gy = int(point[1] / CELL_DEGREES)
        best = {}
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for a, b, index in self.cells.get((gx + dx, gy + dy), ()):
                    distance = segment_distance(point, a, b)
                    if distance > radius:
                        continue
                    if index not in best or distance < best[index]:
                        best[index] = distance
        return best


def strokes_of(line):
    strokes, current = [], []
    for row in line["segments"]:
        points = [list(point) for point in row[2]]
        if row[1] and current:
            current.extend(points)
        else:
            if current:
                strokes.append(current)
            current = points
    if current:
        strokes.append(current)
    return strokes


def resample(coords, step):
    out = []
    for i in range(1, len(coords)):
        a, b = coords[i - 1], coords[i]
        span = metres(a, b)
        steps = max(1, int(span // step))
        for k in range(steps):
            t = k / steps
            out.append([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    out.append(coords[-1])
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lines", default="")
    args = parser.parse_args()
    wanted = {value for value in args.lines.split(",") if value}

    builder = load_module(
        APP_DIR / "scripts/railway/build-japan-package-from-inventory.py", "bji"
    )
    n02 = load_module(APP_DIR / "scripts/railway/n02/n02_source.py", "n02_source")
    net = n02.load(builder.extract_n02(Path(tempfile.mkdtemp())), verbose=False)
    index = SectionIndex(net.sections)

    package = json.loads(PACKAGE.read_text("utf-8"))
    usage = {}
    for line in package["lines"]:
        if wanted and line["id"] not in wanted:
            continue
        metres_by_section = defaultdict(float)
        unmatched = 0.0
        for stroke in strokes_of(line):
            for point in resample(stroke, SAMPLE_STEP_METERS):
                near = index.near(point, MATCH_METERS)
                if not near:
                    unmatched += SAMPLE_STEP_METERS
                    continue
                # Every section within tolerance is credited: where two N02
                # sections are coincident the drawn line rides both, and
                # crediting only the nearest would invent a distinction the
                # survey does not make.
                for section_index in near:
                    metres_by_section[section_index] += SAMPLE_STEP_METERS
        usage[line["id"]] = {
            "operator": line["operator"],
            "name": line["name"],
            "railwayIdentity": line.get("railwayIdentity"),
            "unmatched_meters": round(unmatched),
            "sections": {
                str(section): round(value)
                for section, value in sorted(
                    metres_by_section.items(), key=lambda item: -item[1]
                )
            },
        }

    payload = {
        "schema_version": 1,
        "package_version": package["version"],
        "method": (
            f"Every drawn stroke resampled at {SAMPLE_STEP_METERS:.0f} m; each sample "
            f"credited to every N02 section within {MATCH_METERS:.0f} m "
            "(point-to-segment). Derived from the published package, so it needs no "
            "builder instrumentation and works on archived packages too."
        ),
        "section_source": "N02-25 RailroadSection indices as loaded by scripts/railway/n02/n02_source.py",
        "lines": usage,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", "utf-8")
    print(
        f"section usage: {len(usage)} lines -> {OUT.relative_to(REPO_DIR)} "
        f"({sum(len(row['sections']) for row in usage.values())} line-section pairs)"
    )


if __name__ == "__main__":
    main()
