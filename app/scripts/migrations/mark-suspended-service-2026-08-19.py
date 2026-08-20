#!/usr/bin/env python3
"""Record the two service suspensions the 2026-08-13 audit missed (2026-08-19).

The 2026-08-13 pass gave all three inventory tables a `network_status` column
and marked 49 undirected edges across six lines. Two railways that had been out
of rail service for years were left saying `active`, because that pass worked
from the operator news feeds it had in hand and neither railway had issued
anything recent enough to surface there:

    西日本旅客鉄道 美祢線     厚狭—長門市  代行バス since 2023-07-01 (whole line)
    九州旅客鉄道   日田彦山線 添田—夜明    BRT ひこぼしライン since 2023-08-28

Both are `substitute_bus` by the ledger's own definition — 「目前以代行巴士运行，
无铁路客运列车」. Neither is a deletion: JR West still holds the 美祢線 rail
licence and says so on its standing 長期運転見合わせ page, and JR Kyushu's
添田—夜明 rail licence runs until the 廃止予定日 of 2027-03-31 filed under
鉄道事業法第28条の2. Until that date the track is a railway with no trains,
which is exactly what `substitute_bus` is for; on that date 添田—夜明 becomes a
DELETION for a later batch, not a status change.

    美祢線     11 undirected adjacencies (22 directed) — the complete line
    日田彦山線  9 undirected adjacencies (18 directed) — 夜明(0) … 添田(9),
               a PREFIX of the package's 24-station order, not a suffix

Line-level `network_status` follows from the edges, never the other way round:
every edge of 美祢線 is non-active so it takes the bare `substitute_bus`, while
日田彦山線 keeps 城野—添田 in service and takes `partial_substitute_bus`.

What this rewrites, following the 2026-08-13 method_notes:
  * n02-station-connections.csv — the five status columns on 40 directed rows.
    No row is added or removed; the adjacency graph is untouched.
  * n02-line-shape-classification.csv — the same five columns on two line rows.
  * evidence/service-status-2026-08-13.json — two `segments` narratives and the
    20 new undirected edges under `connections.substitute_bus`, each carrying
    the operator's own page as `source_url`.
  * MANIFEST.json — sizes and hashes for the files that changed.

Sources quoted in the ledger entries:
  * 美祢線     https://www.westjr.co.jp/suspend/ — JR West's standing
    long-term-suspension page, which as of 2026-08-19 lists 美祢線 and nothing
    else: 「2023年6月30日から7月1日にかけて…運転見合わせをしております」.
  * 日田彦山線 https://www.jrkyushu.co.jp/news/__icsFiles/afieldfile/2025/12/26/
    20251226_Notification_of_the_discontinuation_of_railway_operations_on_the_
    Hitahikosan_Line.pdf — 「同区間は、2023年8月28日より道路運送法に基づく
    『日田彦山線BRT（愛称名：BRT ひこぼしライン）』として運行しております」,
    with the 鉄道事業廃止 filed 2025-12-26.

Idempotent: re-running after the rows are marked changes nothing.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import shutil
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]
JP_ROOT = APP_ROOT / "data/raw/railway/jp"
CLASSIFICATION = JP_ROOT / "classification"
INVENTORY = JP_ROOT / "rebuild-inventory"

CONNECTIONS = "n02-station-connections.csv"
# The SAME 19,256 connection rows in the shape the package builder reads. The
# CSV is for people and the JSON is for build-japan-package-from-inventory.py
# (`network["connections"]`), so marking only the CSV would leave the next full
# rebuild reproducing the pre-correction package — which is exactly what the
# builder-path check caught before this file learned to write it.
NETWORK_JSON = "n02-station-network.json"
LINES_CSV = "n02-line-shape-classification.csv"
LEDGER = "service-status-2026-08-13.json"

INVENTORY_SUBDIR = {
    CONNECTIONS: "stations",
    NETWORK_JSON: "stations",
    LINES_CSV: "lines",
    LEDGER: "evidence",
}

AUDIT_DATE = "2026-08-19"
ORIGIN = f"correction_{AUDIT_DATE}"
STATUS = "substitute_bus"
EDGE_NOTE = "基础设施边可保留；服务层不得显示为当前有客运列车直达的营业边。"

MINE_SOURCE = "https://www.westjr.co.jp/suspend/"
HITA_SOURCE = (
    "https://www.jrkyushu.co.jp/news/__icsFiles/afieldfile/2025/12/26/"
    "20251226_Notification_of_the_discontinuation_of_railway_operations_"
    "on_the_Hitahikosan_Line.pdf"
)

# Station order as the package walks it, so the marked run is provably the
# contiguous span the operator names and not a scatter of edges.
SPANS = [
    {
        "operator": "西日本旅客鉄道",
        "line": "美祢線",
        "stations": [
            "長門市", "板持", "長門湯本", "渋木", "於福", "重安",
            "美祢", "南大嶺", "四郎ヶ原", "厚保", "湯ノ峠", "厚狭",
        ],
        "whole_line": True,
        "source_url": MINE_SOURCE,
        "segment": {
            "audit_date": AUDIT_DATE,
            "operator": "西日本旅客鉄道",
            "line_or_layer": "美祢線",
            "current_mode": "全线代行バス",
            "affected": "厚狭—長門市（全线）",
            "interpretation": (
                "2023-07-01 の大雨以降、全線で鉄道の運転を見合わせ、代行バスで運行。"
                "鉄道事業は継続中（廃止届なし）ため拓扑边保留、服务层标记为代行バス。"
            ),
            "effective_or_future_date": "2023-07-01運転見合わせ開始／2026-08-19時点で継続",
            "source_url": MINE_SOURCE,
        },
    },
    {
        "operator": "九州旅客鉄道",
        "line": "日田彦山線",
        "stations": [
            "夜明", "今山", "大鶴", "宝珠山", "大行司",
            "筑前岩屋", "彦山", "豊前桝田", "歓遊舎ひこさん", "添田",
        ],
        "whole_line": False,
        "source_url": HITA_SOURCE,
        "segment": {
            "audit_date": AUDIT_DATE,
            "operator": "九州旅客鉄道",
            "line_or_layer": "日田彦山線",
            "current_mode": "部分鉄道 + BRT（ひこぼしライン）",
            "affected": "添田—夜明",
            "interpretation": (
                "2017-07 九州北部豪雨で不通、2023-08-28 より道路運送法に基づく "
                "BRT ひこぼしライン。2025-12-26 に鉄道事業法第28条の2 の廃止届出、"
                "廃止予定日 2027-03-31 — その日までは鉄道事業が残るため拓扑边保留、"
                "以降は削除对象（本次不删）。"
            ),
            "effective_or_future_date": "2023-08-28 BRT開業／2027-03-31 鉄道事業廃止予定",
            "source_url": HITA_SOURCE,
        },
    },
]

STATUS_COLUMNS = (
    "network_status",
    "record_origin",
    "change_effective_date",
    "change_source_url",
    "change_note",
)


def directed_pairs(stations: list[str]) -> set[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    for first, second in zip(stations, stations[1:]):
        pairs.add((first, second))
        pairs.add((second, first))
    return pairs


def read_csv_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def line_terminator(path: Path) -> str:
    """What this file already uses. The three inventory CSVs do not agree — the
    line classification is CRLF and the connections table is LF — and rewriting
    one in the other's terminator would rewrite every line of the file for a
    forty-row edit."""
    with path.open("rb") as source:
        head = source.read(1 << 16)
    return "\r\n" if b"\r\n" in head else "\n"


def write_csv_rows(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    """Rewrite in the exact shape the file already has: BOM, its own line
    terminator, QUOTE_MINIMAL."""
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(
        buffer, fieldnames=fieldnames, lineterminator=line_terminator(path)
    )
    writer.writeheader()
    writer.writerows(rows)
    with path.open("w", encoding="utf-8-sig", newline="") as destination:
        destination.write(buffer.getvalue())


def mark_connections(path: Path) -> tuple[int, dict[str, list[dict[str, str]]]]:
    fieldnames, rows = read_csv_rows(path)
    for column in STATUS_COLUMNS:
        if column not in fieldnames:
            raise SystemExit(f"{path.name}: missing column {column}")

    marked = 0
    ledger_edges: dict[str, list[dict[str, str]]] = {}
    for span in SPANS:
        wanted = directed_pairs(span["stations"])
        hits = [
            row
            for row in rows
            if row["line"] == span["line"]
            and row["from_operator"] == span["operator"]
            and (row["from_station_name"], row["to_station_name"]) in wanted
        ]
        if len(hits) != len(wanted):
            raise SystemExit(
                f"{span['line']}: expected {len(wanted)} directed rows, found {len(hits)}"
            )
        seen_undirected: set[frozenset[str]] = set()
        edges: list[dict[str, str]] = []
        for row in hits:
            if row["network_status"] not in ("active", STATUS):
                raise SystemExit(
                    f"{row['connection_uid']}: already {row['network_status']}"
                )
            if row["network_status"] == "active":
                marked += 1
            row["network_status"] = STATUS
            row["record_origin"] = ORIGIN
            row["change_effective_date"] = AUDIT_DATE
            row["change_source_url"] = span["source_url"]
            row["change_note"] = EDGE_NOTE
            key = frozenset((row["from_station_name"], row["to_station_name"]))
            if key in seen_undirected:
                continue
            seen_undirected.add(key)
            edges.append(
                {
                    "connection_uid": row["connection_uid"],
                    "operator": span["operator"],
                    "line": span["line"],
                    "edge": f"{row['from_station_name']}—{row['to_station_name']}",
                    "source_url": span["source_url"],
                }
            )
        ledger_edges[span["line"]] = edges

    write_csv_rows(path, fieldnames, rows)
    return marked, ledger_edges


def mark_network_json(path: Path) -> int:
    """The same five columns on the same rows of the builder's own input."""
    # Compact separators and no trailing newline: verified by round-trip to be
    # byte-for-byte what this file already is.
    network = json.loads(path.read_text("utf-8"))
    wanted = {}
    for span in SPANS:
        for pair in directed_pairs(span["stations"]):
            wanted[(span["operator"], span["line"], pair)] = span
    marked = 0
    hits = 0
    for row in network["connections"]:
        span = wanted.get(
            (
                row["from_operator"],
                row["line"],
                (row["from_station_name"], row["to_station_name"]),
            )
        )
        if span is None:
            continue
        hits += 1
        if row["network_status"] not in ("active", STATUS):
            raise SystemExit(f"{row['connection_uid']}: already {row['network_status']}")
        if row["network_status"] == "active":
            marked += 1
        row["network_status"] = STATUS
        row["record_origin"] = ORIGIN
        row["change_effective_date"] = AUDIT_DATE
        row["change_source_url"] = span["source_url"]
        row["change_note"] = EDGE_NOTE
    if hits != len(wanted):
        raise SystemExit(f"{path.name}: matched {hits} rows, expected {len(wanted)}")
    path.write_text(
        json.dumps(network, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return marked


def mark_lines(path: Path) -> int:
    fieldnames, rows = read_csv_rows(path)
    marked = 0
    for span in SPANS:
        value = STATUS if span["whole_line"] else f"partial_{STATUS}"
        hits = [
            row
            for row in rows
            if row["line"] == span["line"] and row["operator"] == span["operator"]
        ]
        if len(hits) != 1:
            raise SystemExit(f"{span['line']}: expected 1 line row, found {len(hits)}")
        row = hits[0]
        if row["network_status"] not in ("active", value):
            raise SystemExit(f"{span['line']}: already {row['network_status']}")
        if row["network_status"] == "active":
            marked += 1
        row["network_status"] = value
        row["record_origin"] = ORIGIN
        row["change_effective_date"] = AUDIT_DATE
        row["change_source_url"] = span["source_url"]
        row["change_note"] = (
            "线级状态由边级 network_status 派生：全线非营业取裸值，部分区间取 partial_ 前缀。"
        )
    write_csv_rows(path, fieldnames, rows)
    return marked


def update_ledger(path: Path, ledger_edges: dict[str, list[dict[str, str]]]) -> int:
    ledger = json.loads(path.read_text("utf-8"))
    known = {
        (entry["operator"], entry["line_or_layer"]) for entry in ledger["segments"]
    }
    added = 0
    for span in SPANS:
        if (span["operator"], span["line"]) in known:
            continue
        ledger["segments"].append(span["segment"])
        added += 1
    existing = {
        row["connection_uid"]
        for rows in ledger["connections"].values()
        for row in rows
    }
    bucket = ledger["connections"].setdefault(STATUS, [])
    for edges in ledger_edges.values():
        for edge in edges:
            if edge["connection_uid"] in existing:
                continue
            bucket.append(edge)
            existing.add(edge["connection_uid"])
    ledger["connections"][STATUS] = bucket
    # The ledger is indent=2 with NO trailing newline; keep it byte-shaped.
    path.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")
    return added


def refresh_manifest() -> None:
    manifest_path = INVENTORY / "MANIFEST.json"
    manifest = json.loads(manifest_path.read_text("utf-8"))
    for entry in manifest["files"]:
        path = INVENTORY / entry["path"]
        entry["bytes"] = path.stat().st_size
        entry["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> None:
    marked_edges, ledger_edges = mark_connections(CLASSIFICATION / CONNECTIONS)
    marked_json = mark_network_json(CLASSIFICATION / NETWORK_JSON)
    marked_lines = mark_lines(CLASSIFICATION / LINES_CSV)
    added_segments = update_ledger(CLASSIFICATION / LEDGER, ledger_edges)
    for name, subdir in INVENTORY_SUBDIR.items():
        shutil.copy2(CLASSIFICATION / name, INVENTORY / subdir / name)
    refresh_manifest()
    print(
        json.dumps(
            {
                "directed_rows_marked": marked_edges,
                "network_json_rows_marked": marked_json,
                "line_rows_marked": marked_lines,
                "ledger_segments_added": added_segments,
                "undirected_edges": {
                    line: len(edges) for line, edges in ledger_edges.items()
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
