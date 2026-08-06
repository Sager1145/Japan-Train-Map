"""Shared core of the curated Taiwan sample-route builders.

Both rebuild-taiwan-sample-route.py (airport MRT express) and
build-taiwan-round-island-sample.py (round-island TRA loop) work the same
way: read the official tw-2025 package, slice a line's official geometry
between two physical stations (walking the per-station segments forward or
reversed), and swap the train's features into matched-routes/matched-stops.
This module owns that whole slicing stage plus the file locations, so a fix
to the weld/slice logic reaches every curated Taiwan sample at once; the
scripts keep only their train-specific constants and assembly.

Codec-level helpers (segment decode, minified+gz writers) come from railpkg.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Sequence

from railpkg import line_segments, write_json, write_json_and_gzip  # noqa: F401

APP_DIR = Path(__file__).resolve().parent.parent
PACKAGE_PATH = APP_DIR / "public" / "rail" / "tw-2025.json"
STORE_PATH = APP_DIR / "data" / "train-store-tw.json"
ROUTES_PATH = APP_DIR / "data" / "matched-routes.json"
STOPS_PATH = APP_DIR / "data" / "matched-stops.json"

LICENSE = "政府資料開放授權條款第1版"


def load_official_package(path: Path = PACKAGE_PATH) -> Dict[str, object]:
    """Read the Taiwan package and refuse anything not official-only."""
    package = json.loads(Path(path).read_text(encoding="utf-8"))
    source = package.get("geometrySource", {})
    if source.get("officialOnly") != 1 or source.get("osmSources") != 0:
        raise RuntimeError("Taiwan package is not official-only")
    return package


def line_context(line: Dict[str, object]) -> Dict[str, object]:
    """Everything the slicer needs about one official line."""
    return {
        "line": line,
        "station_by_name": {row[1]: row for row in line["stations"]},
        "station_index": {row[1]: i for i, row in enumerate(line["stations"])},
        "segments": line_segments(line),
    }


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
    """Official geometry between two on-line stations, either direction."""
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
    collection: Dict[str, object],
    train_id: str,
    replacements: Sequence[Dict[str, object]],
) -> None:
    """Swap one train's features while leaving every other train untouched."""
    retained = [
        feature
        for feature in collection["features"]
        if feature.get("properties", {}).get("train_id") != train_id
    ]
    collection["features"] = [*retained, *replacements]
