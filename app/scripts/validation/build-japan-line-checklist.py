#!/usr/bin/env python3
"""Build the per-line review checklist for Japan — one row per canonical railway.

Every line gets a row whether it is drawn or not, and every row carries the
facts a reviewer would otherwise have to gather by hand: what the package drew,
what N02 surveyed, what the 2026-08-13 audit says, and what the two validators
concluded about that line specifically.

The columns a machine can fill are filled here. The columns only a source can
answer — the operator's own 営業キロ and station count — are left empty for the
review pass to write, alongside the URL it used. That separation is the point:
a checklist that mixes derived numbers with researched ones, without saying
which is which, cannot be audited later.

Usage:
  python3 app/scripts/validation/build-japan-line-checklist.py
  python3 app/scripts/validation/build-japan-line-checklist.py --out /tmp/x.csv
"""

from __future__ import annotations

import argparse
import collections
import csv
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = APP_DIR.parent
RAW = APP_DIR / "data" / "raw" / "railway" / "jp"
INVENTORY = RAW / "rebuild-inventory"
PACKAGE = APP_DIR / "public" / "rail" / "jp-2025.json"
DEFAULT_OUT = REPO_ROOT / "RAILWAY_JP_LINE_CHECKLIST.csv"

OPERATOR_ALIASES = {"東京地下鉄": "東京メトロ", "大阪市高速電気軌道": "Osaka Metro"}

COLUMNS = [
    # identity
    "canonical_key",
    "operator",
    "line",
    "render_kind",
    "shape_class",
    "session",
    # what the package drew
    "built",
    "display_line_ids",
    "parts",
    "drawn_km",
    "drawn_stations",
    # what the survey and the audit say
    "n02_km",
    "semantic_km",
    "audit_stations",
    "n02_station_features",
    "audit_edges",
    # what the validators concluded about THIS line
    "anchor_pass",
    "anchor_warning",
    "anchor_error",
    "topology_status",
    "topology_findings",
    # what the builder had to decide
    "builder_notes",
    "skip_edges_dropped",
    "not_drawn_reason",
    # filled by the review pass, from sources
    "official_km",
    "official_stations",
    "source_url",
    "verdict",
    "review_notes",
]


def normalised(value: str) -> str:
    return re.sub(r"[\s　]", "", unicodedata.normalize("NFKC", value or ""))


def identity(operator: str, name: str) -> str:
    return f"{normalised(OPERATOR_ALIASES.get(operator, operator))} {normalised(name)}"


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def run_validators(scratch: Path):
    """Per-line verdicts, from the validators themselves rather than re-derived."""
    topology = scratch / "topology.json"
    anchoring = scratch / "anchoring.json"
    for script, out in (
        ("scripts/validation/validate-railway-topology.mjs", topology),
        ("scripts/validation/validate-station-render-anchoring.mjs", anchoring),
    ):
        subprocess.run(
            ["node", script, "--country", "jp", "--json", str(out)],
            cwd=APP_DIR,
            capture_output=True,
        )
    topo_by_line = {}
    if topology.exists():
        report = json.loads(topology.read_text("utf-8"))
        report = report[0] if isinstance(report, list) else report
        for line in report.get("lines", []):
            problems = line.get("problems", [])
            topo_by_line[line.get("lineId")] = {
                "status": "ERROR"
                if any(p.get("severity") == "ERROR" for p in problems)
                else "WARNING"
                if problems
                else "PASS",
                "findings": "; ".join(
                    sorted({p.get("code", "") for p in problems if p.get("code")})
                ),
            }
    anchors_by_line = collections.defaultdict(lambda: collections.Counter())
    if anchoring.exists():
        report = json.loads(anchoring.read_text("utf-8"))
        # The validator writes one entry per country, each holding its rows.
        rows = []
        for entry in report if isinstance(report, list) else [report]:
            rows.extend(entry.get("rows", []) if isinstance(entry, dict) else [])
        for row in rows:
            line_id = row.get("lineId") or row.get("line_id")
            status = (row.get("status") or row.get("severity") or "").upper()
            if line_id:
                anchors_by_line[line_id][status] += 1
    return topo_by_line, anchors_by_line


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--scratch", default="/tmp")
    args = parser.parse_args()

    classification = {
        row["canonical_key"]: row
        for row in read_csv(INVENTORY / "lines" / "n02-line-shape-classification.csv")
    }
    network = json.loads(
        (INVENTORY / "stations" / "n02-station-network.json").read_text("utf-8")
    )
    audit_stations = collections.Counter()
    for station in network["stations"]:
        for line in station.get("connected_lines", []):
            audit_stations[f"{station['operator']}␟{line['line']}"] += 1
    audit_edges = collections.Counter()
    for row in network["connections"]:
        audit_edges[f"{row['from_operator']}␟{row['line']}"] += 1

    sessions = {}
    for row in read_csv(REPO_ROOT / "RAILWAY_REBUILD_BATCHES.csv"):
        if row.get("country") == "jp":
            sessions[row["line_id"]] = row["session"]

    drawn = collections.defaultdict(list)
    if PACKAGE.exists():
        for line in json.loads(PACKAGE.read_text("utf-8")).get("lines", []):
            drawn[identity(line["operator"], line["name"])].append(line)

    topo_by_line, anchors_by_line = run_validators(Path(args.scratch))

    report_path = APP_DIR / "data" / "staging" / "jp-2025.build-report.json"
    build_notes = collections.defaultdict(list)
    build_skips = {}
    if report_path.exists():
        report = json.loads(report_path.read_text("utf-8"))
        for entry in report.get("notes", []):
            build_notes[re.sub(r"-\d+$", "", entry["key"])].append(entry["note"])
        for entry in report.get("skipped", []):
            build_skips[re.sub(r"-\d+$", "", entry["key"])] = entry["reason"]

    rows = []
    for key in sorted(classification):
        info = classification[key]
        operator, _, name = key.partition("␟")
        parts = drawn.get(identity(operator, name), [])
        ids = [part["id"] for part in parts]
        anchor = collections.Counter()
        for line_id in ids:
            anchor.update(anchors_by_line.get(line_id, {}))
        topo = [topo_by_line.get(line_id, {}) for line_id in ids]
        rows.append(
            {
                "canonical_key": key,
                "operator": operator,
                "line": name,
                "render_kind": info.get("render_kind", ""),
                "shape_class": info.get("shape_class", ""),
                "session": sessions.get(key, ""),
                "built": "yes" if parts else "no",
                "display_line_ids": "|".join(ids),
                "parts": len(parts),
                "drawn_km": round(
                    sum(row[0] for part in parts for row in part["segments"]), 3
                )
                if parts
                else "",
                "drawn_stations": sum(len(part["stations"]) for part in parts)
                if parts
                else "",
                "n02_km": info.get("n02_length_km", ""),
                "semantic_km": info.get("semantic_length_km", ""),
                "audit_stations": audit_stations.get(key, 0),
                "n02_station_features": info.get("station_feature_count", ""),
                "audit_edges": audit_edges.get(key, 0) // 2,
                "anchor_pass": anchor.get("PASS", 0),
                "anchor_warning": anchor.get("WARNING", 0),
                "anchor_error": anchor.get("ERROR", 0),
                "topology_status": "ERROR"
                if any(entry.get("status") == "ERROR" for entry in topo)
                else "WARNING"
                if any(entry.get("status") == "WARNING" for entry in topo)
                else ("PASS" if topo else ""),
                "topology_findings": "; ".join(
                    sorted({entry.get("findings", "") for entry in topo if entry.get("findings")})
                ),
                "builder_notes": " | ".join(build_notes.get(key, [])),
                "skip_edges_dropped": sum(
                    note.count("skips") for note in build_notes.get(key, [])
                ),
                "not_drawn_reason": build_skips.get(key, ""),
                "official_km": "",
                "official_stations": "",
                "source_url": "",
                "verdict": "",
                "review_notes": "",
            }
        )

    out = Path(args.out)
    with out.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)

    built = sum(1 for row in rows if row["built"] == "yes")
    print(f"{len(rows)} canonical lines -> {out}")
    print(f"  built {built}, not built {len(rows) - built}")
    print(f"  topology ERROR {sum(1 for r in rows if r['topology_status'] == 'ERROR')}, "
          f"WARNING {sum(1 for r in rows if r['topology_status'] == 'WARNING')}")
    print(f"  anchor ERROR rows {sum(1 for r in rows if r['anchor_error'])}, "
          f"WARNING rows {sum(1 for r in rows if r['anchor_warning'])}")


if __name__ == "__main__":
    main()
