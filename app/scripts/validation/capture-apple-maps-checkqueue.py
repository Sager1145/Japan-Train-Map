#!/usr/bin/env python3
"""Capture the macOS Maps transit reference for one rebuild session's COVERAGE TILES.

Companion to capture-apple-maps-reference.sh, which captures a fixed list of
representative places. This one captures the tile plan that
plan-apple-capture-tiles.py derives from the country's check queue, so it
answers every checkpoint a session owes (RAILWAY_REBUILD_SESSION_PLAN.md gate 5)
WITHOUT photographing the same square kilometre once per checkpoint: a z14 frame
is ~27 x 15 km and already contains dozens of them. Run the planner first; it
writes capture-tiles.csv next to the output.

Every capture follows the same rules as the existing harness, which exist so a
screenshot is admissible as `visual_evidence` under
RAILWAY_DATA_TOPOLOGY_AND_APPLE_MAPS_DISPLAY_RULES.md 13:

  * the transit view (`t=r`), never the standard map view;
  * the coordinate form of the URL with no `q=`, so Maps opens with no search
    pin, no selected station, no route plan and no navigation overlay;
  * a fixed window geometry and capture region, so two captures of the same
    place are comparable pixel for pixel;
  * the check id, coordinate and zoom recorded per file.

MUST RUN ON macOS — it drives Maps.app through `open`, `osascript` and
`screencapture`. It cannot run in the Linux VM or in a cloud session.

Resumable: a checkpoint whose PNG already exists is skipped, so an interrupted
run continues where it stopped rather than recapturing from the beginning.

Usage:
  python3 app/scripts/validation/capture-apple-maps-checkqueue.py --session 2
  python3 app/scripts/validation/capture-apple-maps-checkqueue.py --session 2 --limit 3
  python3 app/scripts/validation/capture-apple-maps-checkqueue.py --country hk --lines hk-mtr-drl
"""

from __future__ import annotations

import argparse
import csv
import platform
import subprocess
import sys
import time
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = APP_DIR.parent
BATCH_TABLE = REPO_ROOT / "RAILWAY_REBUILD_BATCHES.csv"
OUTPUT_ROOT = REPO_ROOT / "outputs" / "apple-maps-reference"

WINDOW_POSITION = (0, 33)
WINDOW_SIZE = (1512, 855)
CAPTURE_REGION = "0,33,1512,855"
# Maps keeps drawing transit lines and labels after the window settles; three
# seconds is what capture-apple-maps-reference.sh already found sufficient.
SETTLE_SECONDS = 3.0
# The sidebar is app chrome, not map. Left open it covers the western ~15% of
# every frame AND shifts the requested coordinate off the window centre, since
# Maps centres on the map viewport rather than the window. Hidden, the frame is
# all map and the coordinate sits dead centre. Localised names because the menu
# item is titled in the user's language.
HIDE_SIDEBAR_MENU_ITEMS = ("Hide Sidebar", "隱藏側邊欄", "隐藏边栏", "サイドバーを非表示")


def check_queue_path(country: str) -> Path:
    return (
        APP_DIR
        / "data"
        / "raw"
        / "railway"
        / country
        / "rebuild-inventory"
        / "evidence"
        / "apple-maps-reference"
        / "check-queue.csv"
    )


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def lines_for_session(session: str) -> tuple[str, list[str], str]:
    rows = [row for row in read_csv(BATCH_TABLE) if row["session"] == str(session)]
    if not rows:
        raise SystemExit(f"batch table has no session {session}")
    return rows[0]["country"], [row["line_id"] for row in rows], rows[0]["batch_code"]


def hide_sidebar() -> None:
    """Collapse the sidebar if it is open. Silent when it is already hidden."""
    # Search every menu rather than assuming the View menu's index: menu order
    # differs by macOS version and the whole point is to not depend on that.
    titles = ", ".join(f'"{title}"' for title in HIDE_SIDEBAR_MENU_ITEMS)
    script = f'''
tell application "System Events" to tell process "Maps"
  repeat with wanted in {{{titles}}}
    repeat with barItem in menu bar items of menu bar 1
      try
        click menu item (wanted as text) of menu 1 of barItem
        return
      end try
    end repeat
  end repeat
end tell
'''
    subprocess.run(["osascript", "-e", script], capture_output=True)


def capture(row: dict, destination: Path, downscale: bool) -> None:
    url = (
        f"http://maps.apple.com/?ll={float(row['latitude']):.7f},"
        f"{float(row['longitude']):.7f}&z={row['apple_zoom']}&t=r"
    )
    # BEFORE navigating, not after: hiding the sidebar widens the viewport to
    # the left without moving the map, so a frame captured after the hide sits
    # half a sidebar (~112 px) off the coordinate it claims to be centred on.
    hide_sidebar()
    subprocess.run(["open", "-a", "Maps", url], check=True)
    subprocess.run(["osascript", "-e", 'tell application "Maps" to activate'], check=True)
    subprocess.run(
        [
            "osascript",
            "-e",
            'tell application "System Events" to tell process "Maps"',
            "-e",
            f"set position of front window to {{{WINDOW_POSITION[0]}, {WINDOW_POSITION[1]}}}",
            "-e",
            f"set size of front window to {{{WINDOW_SIZE[0]}, {WINDOW_SIZE[1]}}}",
            "-e",
            "end tell",
        ],
        check=True,
    )
    time.sleep(SETTLE_SECONDS)
    subprocess.run(
        ["screencapture", "-x", "-o", f"-R{CAPTURE_REGION}", str(destination)],
        check=True,
    )
    if downscale:
        # screencapture writes at the display's backing scale, so a Retina Mac
        # produces a 3024x1710 PNG of a 1512x855 region — 2-4 MB each, which is
        # ~60 GB across Japan's queue. Resampling back to the logical size loses
        # nothing a visual review uses and costs a fifth of the disk.
        subprocess.run(
            ["sips", "--resampleWidth", str(WINDOW_SIZE[0]), str(destination)],
            check=True,
            stdout=subprocess.DEVNULL,
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", help="session number from RAILWAY_REBUILD_BATCHES.csv")
    parser.add_argument("--country", help="country code, when --session is not used")
    parser.add_argument("--lines", default="", help="comma-separated line ids")
    parser.add_argument("--kinds", default="", help="restrict to these apple_zoom values, e.g. 14,16")
    parser.add_argument("--limit", type=int, default=0, help="stop after N captures")
    parser.add_argument("--redo", action="store_true", help="recapture files that exist")
    parser.add_argument("--retina", action="store_true", help="keep the 2x backing-scale PNG")
    args = parser.parse_args()

    if platform.system() != "Darwin":
        raise SystemExit(
            "This script drives macOS Maps.app and must run on the Mac itself, "
            "not in the Linux VM or a cloud session."
        )

    if args.session:
        country, line_ids, batch_code = lines_for_session(args.session)
    elif args.country:
        country, batch_code = args.country, "ad-hoc"
        line_ids = [value.strip() for value in args.lines.split(",") if value.strip()]
    else:
        raise SystemExit("pass --session <n> or --country <cc>")

    tiles_path = OUTPUT_ROOT / country / "capture-tiles.csv"
    if not tiles_path.exists():
        raise SystemExit(
            f"no tile plan for {country}. Run first:\n"
            f"  python3 app/scripts/validation/plan-apple-capture-tiles.py "
            + (f"--session {args.session}" if args.session else f"--country {country}")
        )
    wanted_zooms = {value.strip() for value in args.kinds.split(",") if value.strip()}
    rows = [
        row
        for row in read_csv(tiles_path)
        if not wanted_zooms or row["apple_zoom"] in wanted_zooms
    ]
    if not rows:
        raise SystemExit("tile plan is empty")

    # Open Maps and collapse the sidebar once up front, so even the first
    # capture of a run is centred like every one after it.
    subprocess.run(["open", "-a", "Maps"], check=True)
    time.sleep(2.0)
    hide_sidebar()

    output_dir = OUTPUT_ROOT / country
    output_dir.mkdir(parents=True, exist_ok=True)
    index_path = output_dir / "captured-index.csv"
    existing = {}
    if index_path.exists():
        existing = {row["tile_id"]: row for row in read_csv(index_path) if row.get("tile_id")}

    captured = 0
    print(f"{batch_code} / {country}: {len(rows)} capture tile(s) -> {output_dir}")
    for row in rows:
        destination = output_dir / row["file"]
        if destination.exists() and not args.redo:
            continue
        if args.limit and captured >= args.limit:
            break
        capture(row, destination, not args.retina)
        existing[row["tile_id"]] = {
            "tile_id": row["tile_id"],
            "checkpoints": row["checkpoints"],
            "lines": row["lines"],
            "check_kinds": row["check_kinds"],
            "longitude": row["longitude"],
            "latitude": row["latitude"],
            "apple_zoom": row["apple_zoom"],
            "window": f"{WINDOW_SIZE[0]}x{WINDOW_SIZE[1]}",
            "pixels": "2x" if args.retina else "1x",
            "capture_region": CAPTURE_REGION,
            "file": destination.name,
        }
        captured += 1
        print(
            f"  {captured:>4}  {row['tile_id']:<14} z{row['apple_zoom']:<3} "
            f"{row['checkpoints']:>4} checkpoints  {row['lines']}"
        )

    fieldnames = [
        "tile_id",
        "checkpoints",
        "lines",
        "check_kinds",
        "longitude",
        "latitude",
        "apple_zoom",
        "window",
        "pixels",
        "capture_region",
        "file",
    ]
    with index_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for tile_id in sorted(existing):
            writer.writerow(existing[tile_id])

    remaining = sum(1 for row in rows if not (output_dir / row["file"]).exists())
    print(
        f"\ncaptured {captured} this run; {len(rows) - remaining}/{len(rows)} complete, "
        f"{remaining} remaining\nindex: {index_path}"
    )
    if remaining:
        print("Re-run the same command to continue where this stopped.")


if __name__ == "__main__":
    main()
