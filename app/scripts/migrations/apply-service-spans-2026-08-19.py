#!/usr/bin/env python3
"""Stamp `serviceSpans` onto the published jp package (2026-08-19).

The package gained one optional line-level field:

    "serviceSpans": [[0, 18, 1]]     # [firstStation, lastStation, statusCode]

indexing the line's OWN `stations` array — station ordinals, not metres, for
the reason lib/service_status.py sets out. `serviceStatus` is restated at the
same time so the string and the spans can never disagree: a bare status when
every interval of the line is out of service, `partial_<status>` when only some
are. codes 1..4 are service_suspended / substitute_bus / no_passenger_train /
all_trains_pass.

Why a stamp and not a rebuild. The spans are a pure function of two things the
published package and the inventory already agree on — the edge table's
`network_status` column and the line's own station order — and neither depends
on the geometry build. Rebuilding 652 lines to write 8 arrays would re-derive
every metre of geometry from N02, put the shared staging package at risk of a
concurrent session's work, and mix an unrelated geometry diff into a batch about
line style. The DERIVATION is not duplicated: this script and
build-japan-package-from-inventory.py both call lib/service_status.py, so a
later full rebuild reproduces exactly what this writes.

Geometry, station rows, colours, ranks and every other field are untouched;
`--check` asserts that.

Idempotent: re-running produces a byte-identical package.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]
PACKAGE = APP_ROOT / "public/rail/jp-2025.json"
# An additive schema field: old readers ignore an unknown key and draw the
# closed stretches solid, which is what they do today. Minor, not patch.
PACKAGE_VERSION = "2025.5.0"
CONNECTIONS = (
    APP_ROOT
    / "data/raw/railway/jp/rebuild-inventory/stations/n02-station-connections.csv"
)

# The package publishes these two operators under their brand name; the
# inventory keys them by their legal N02 one (build-japan-package-from-inventory
# .py OPERATOR_ALIASES).
OPERATOR_ALIASES = {"東京地下鉄": "東京メトロ", "大阪市高速電気軌道": "Osaka Metro"}

sys.path.insert(0, str(APP_ROOT / "scripts" / "railway"))
service_status = importlib.import_module("lib.service_status")


def read_connections():
    import csv

    with CONNECTIONS.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def apply(package, edge_status):
    """The package with every line's `serviceSpans`/`serviceStatus` restated."""
    touched = []
    claimed = set()
    for line in package["lines"]:
        key = f"{line['operator']}␟{line['name']}"
        stations = [row[0] for row in line["stations"]]
        spans = service_status.service_spans(key, stations, edge_status)
        missed = service_status.unmatched_skip_edges(
            key, stations, edge_status, spans
        )
        if missed:
            raise SystemExit(f"{line['id']}: ledger edges outside every span: {missed}")
        before = (line.get("serviceSpans"), line.get("serviceStatus"))
        if spans:
            line["serviceSpans"] = spans
            line["serviceStatus"] = service_status.line_service_status(
                spans, len(stations)
            )
            # An edge is accounted for when every interval between its two
            # seats is inside a span. That covers 肥薩線's 人吉↔矢岳 and
            # 矢岳↔吉松 — the graph's record of the 大畑 and 真幸 reversals,
            # which skip a station and are redundant with the adjacent edges
            # they straddle — without letting a real gap pass as one.
            covered = [False] * max(0, len(stations) - 1)
            for first, last, _code in spans:
                for index in range(first, last):
                    covered[index] = True
            seat = {group: index for index, group in enumerate(stations)}
            for edge_key, edge in edge_status:
                if edge_key != key:
                    continue
                seats = sorted(seat[group] for group in edge if group in seat)
                if len(seats) != 2:
                    continue
                if all(covered[index] for index in range(seats[0], seats[1])):
                    claimed.add((edge_key, edge))
        else:
            line.pop("serviceSpans", None)
            line.pop("serviceStatus", None)
        after = (line.get("serviceSpans"), line.get("serviceStatus"))
        if before != after:
            touched.append(
                {
                    "id": line["id"],
                    "was": {"serviceSpans": before[0], "serviceStatus": before[1]},
                    "now": {"serviceSpans": after[0], "serviceStatus": after[1]},
                    "km": round(
                        sum(
                            line["segments"][index][0]
                            for first, last, _ in (after[0] or [])
                            for index in range(first, last)
                        ),
                        3,
                    ),
                }
            )
    # Every marked edge has to end up inside some line's span. An edge the
    # package cannot seat means the two are describing different railways, and
    # drawing the rest solid would hide that rather than report it.
    orphans = sorted(
        f"{key} {sorted(edge)}" for key, edge in edge_status if (key, edge) not in claimed
    )
    return touched, orphans


def main() -> None:
    check = "--check" in sys.argv[1:]
    original = PACKAGE.read_text("utf-8")
    package = json.loads(original)
    edge_status = service_status.edge_status_index_by_group(
        read_connections(), OPERATOR_ALIASES
    )
    touched, orphans = apply(package, edge_status)
    version_was = package.get("version")
    package["version"] = PACKAGE_VERSION
    if orphans:
        raise SystemExit(
            "these ledger edges are in no package line's span:\n  "
            + "\n  ".join(orphans)
        )
    # `separators=(",", ":")` + one trailing newline is exactly what
    # JSON.stringify(pkg) + "\n" produces, which is what last wrote this file.
    # Verified by round-trip: parsing and re-dumping the untouched package
    # reproduces it byte for byte, so no float re-formatting rides along
    # (Python's "4.0" against Node's "4" is the classic false diff here).
    text = json.dumps(package, ensure_ascii=False, separators=(",", ":")) + "\n"
    report = {
        "version": [version_was, PACKAGE_VERSION],
        "linesChanged": len(touched),
        "lines": touched,
        "bytesBefore": len(original.encode("utf-8")),
        "bytesAfter": len(text.encode("utf-8")),
    }
    if check:
        report["identical"] = text == original
        print(json.dumps(report, ensure_ascii=False, indent=1))
        return
    PACKAGE.write_text(text, encoding="utf-8")
    # The .json.gz sidecar is NOT written here. recompute-package-derived.mjs
    # owns it (zlib level 9, mtime 0) along with `lanes` and `stats`, and must
    # run after this — the same order every promotion follows.
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
