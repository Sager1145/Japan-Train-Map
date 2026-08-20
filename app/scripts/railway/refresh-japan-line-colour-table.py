#!/usr/bin/env python3
"""Re-derive the colour columns of the canonical N02 tables in place.

`classify-japan-line-shapes.py` owns the colour resolution rules, but running
it again would also rebuild the topology tables, and those carry documented
manual corrections that a re-run does not reproduce (a re-run drops 広島電鉄
循環線 and 京王新線 and revives 留萌線).  So this script imports the rule —
`colour_fields()` — from that module and rewrites ONLY the colour columns of

* `classification/n02-official-line-colours.csv`
* `classification/n02-line-shape-classification.csv`
* the two colour histograms inside the generated `classification/README.md`

leaving every row, row order, non-colour column and every other section of the
README untouched.  Same inputs, same function, no second implementation to
drift.

Run it after any edit to `colours/line-colours.json` / `operator-colours.json`,
then `organize-japan-network-inventory.py` and
`apply-display-colours.py --country jp`.
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
CLASSIFIER = Path(__file__).with_name("classify-japan-line-shapes.py")
CLASSIFICATION = APP_DIR / "data/raw/railway/jp/classification"
COLOUR_TABLE = CLASSIFICATION / "n02-official-line-colours.csv"
SHAPE_TABLE = CLASSIFICATION / "n02-line-shape-classification.csv"
SUMMARY = CLASSIFICATION / "README.md"


def load_classifier():
    spec = importlib.util.spec_from_file_location("classify_japan_lines", CLASSIFIER)
    module = importlib.util.module_from_spec(spec)
    # The module defines dataclasses; dataclasses resolves annotations through
    # sys.modules, so the module has to be registered before it executes.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--colour-table", type=Path, default=COLOUR_TABLE)
    parser.add_argument("--shape-table", type=Path, default=SHAPE_TABLE)
    parser.add_argument("--summary", type=Path, default=SUMMARY)
    parser.add_argument(
        "--dry-run", action="store_true", help="report the change without writing"
    )
    return parser.parse_args()


def read_csv(path: Path) -> tuple[list[str], list[dict]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        # The committed tables are LF; csv's default CRLF would rewrite every
        # row of a 597-row table as a diff.
        writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def rewrite_summary_table(text: str, header: str, counts: Counter) -> str:
    """Replace one `| header | 线路数 |` block, leaving the rest of the file."""
    marker = f"| {header} | 线路数 |\n| --- | ---: |\n"
    start = text.index(marker) + len(marker)
    end = text.index("\n\n", start)
    body = "\n".join(
        f"| `{key}` | {value} |" for key, value in sorted(counts.items())
    )
    return text[:start] + body + text[end:]


def main() -> None:
    args = parse_args()
    classify = load_classifier()

    line_colours = classify.load_line_colours(classify.DEFAULT_LINE_COLOURS)
    operator_colours = classify.load_operator_colours(classify.DEFAULT_OPERATOR_COLOURS)
    osm_routes = classify.load_osm_routes(classify.DEFAULT_OSM)

    before = Counter()
    after = Counter()
    changed = []
    resolved: dict[str, dict] = {}

    fieldnames, rows = read_csv(args.colour_table)
    for row in rows:
        operator, line = row["operator"], row["line"]
        colours = classify.colour_fields(
            operator,
            line,
            line_colours.get((operator, line)),
            operator_colours.get(operator),
            osm_routes.get(row["canonical_key"]),
        )
        before[row["render_color_basis"]] += 1
        after[colours["render_color_basis"]] += 1
        if row["render_color_hex"] != colours["render_color_hex"]:
            changed.append(
                (
                    row["canonical_key"],
                    row["render_color_hex"],
                    row["render_color_basis"],
                    colours["render_color_hex"],
                    colours["render_color_basis"],
                )
            )
        resolved[row["canonical_key"]] = colours
        row.update({key: colours[key] for key in colours if key in fieldnames})

    shape_fieldnames, shape_rows = read_csv(args.shape_table)
    colour_columns = [column for column in shape_fieldnames if column in resolved[next(iter(resolved))]]
    missing = []
    for row in shape_rows:
        colours = resolved.get(row["canonical_key"])
        if not colours:
            missing.append(row["canonical_key"])
            continue
        row.update({column: colours[column] for column in colour_columns})

    if missing:
        raise SystemExit(
            f"shape table rows absent from the colour table: {missing[:5]}"
        )

    status_counts = Counter(row["line_color_status"] for row in rows)
    summary = args.summary.read_text(encoding="utf-8")
    summary = rewrite_summary_table(summary, "线路色状态", status_counts)
    summary = rewrite_summary_table(summary, "渲染颜色依据", after)

    if not args.dry_run:
        write_csv(args.colour_table, fieldnames, rows)
        write_csv(args.shape_table, shape_fieldnames, shape_rows)
        args.summary.write_text(summary, encoding="utf-8")

    print(
        json.dumps(
            {
                "rows": len(rows),
                "changed_render_colours": len(changed),
                "basis_before": dict(before.most_common()),
                "basis_after": dict(after.most_common()),
                "written": not args.dry_run,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    for key, old_hex, old_basis, new_hex, new_basis in changed[:20]:
        print(f"  {key}: {old_hex} ({old_basis}) → {new_hex} ({new_basis})")
    if len(changed) > 20:
        print(f"  … {len(changed) - 20} more")


if __name__ == "__main__":
    main()
