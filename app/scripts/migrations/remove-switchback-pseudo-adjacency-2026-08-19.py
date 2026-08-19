#!/usr/bin/env python3
"""Delete three N02 pseudo-adjacencies that skip a reversal station (2026-08-19).

Batch 13's tightened `sharp_artificial_turn` rule found five out-and-back folds
in jp-2025. Three of them are one defect wearing three hats: the station
contracted graph carries a DIRECT edge between the two stations either side of
a reversal point, because N02 joins the two legs at a junction a few hundred
metres short of the platform and `first_station_paths` walks straight through
that junction without asking whether a train could make the turn.

    養老鉄道 養老線     室—西大垣    junction 685 m west of 大垣, legs 6° apart
    松浦鉄道 西九州線   川東—東山代  junction 560 m west of 伊万里, legs 20° apart
    東日本旅客鉄道 東北線 北赤羽—川口  junction 485 m north of 赤羽, legs 12° apart

In every case the two legs leave the junction on the SAME side, so the drawn
interval runs out to the junction and folds 160–170° back — a movement no train
makes. The station between them is the one both legs actually reach.

This is the same defect the 2026-08-13 audit removed twelve of (関山—新井 past
二本木, 瀬田—赤水 past 立野, 広田—堂島 past 会津若松 …) and the 2026-08-18 pass
another four of (久住—下総松崎 past 成田 …). The geometric guard in the package
builder — drop_skip_station_edges — cannot catch these three: it asks whether
the A–B track runs within 400 m of another station of the line, and all three
junctions sit outside that window (伊万里 560 m, 大垣 685 m, 赤羽 485 m), which
is exactly why 成田 needed the same hand removal in the 08-18 batch.

Sources (quoted in the ledger entry):
  * 養老線   「大垣駅は、桑名方面と揖斐方面との線路が合流するスイッチバック形
              の配線となっている。」 station order 西大垣 41.2 → 大垣 43.0 →
              室 44.1 km.
  * 西九州線 「伊万里駅はスイッチバック構造（定期旅客列車の同駅を跨いでの直通
              はなし）」 station order 川東 11.6 → 伊万里 13.0 → 東山代 16.3 km;
              the through track was severed by the 2002 station rebuild.
  * 東北線   赤羽 is the 起点 of the 東北本線別線 (埼京線) and the 本線 station
              before 川口; every track path from 北赤羽 to 川口 runs through it.

What this rewrites, following the 2026-08-13 method_notes:
  * n02-station-connections.csv — the six directed rows go; the per-line style
    columns of every surviving row are recomputed for the six stations whose
    degree drops from 3 to 2.
  * n02-station-network.csv / .json — rail_connections_json, the two counts,
    station_style and the role tags, recomputed by the generator's own degree
    rules (degree>=3 branch_origin, degree==1 line/branch terminal, else
    ordinary_station). Geometry-sourced tags (loop_station, disconnected_station,
    multi_*) are preserved: they describe the N02 graph, not the adjacency.
  * n02-line-shape-classification.csv — 養老線 and 西九州線 become
    ordinary_linear with no branch parts, the treatment every reversal station
    of the 08-13 batch got (磐越西線, 篠ノ井線, 豊肥線 …); their auto_shape_class
    keeps saying branched_terminal, which is what N02's raw graph says. 東北線
    is disconnected with eight branch parts for reasons unrelated to this edge
    and keeps its line-level columns.
  * evidence/network-corrections-2026-08-13.json — the rollback ledger.
  * MANIFEST.json — sizes and hashes for the files that changed.

Idempotent: re-running after the edges are gone changes nothing.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import shutil
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]
JP_ROOT = APP_ROOT / "data/raw/railway/jp"
CLASSIFICATION = JP_ROOT / "classification"
INVENTORY = JP_ROOT / "rebuild-inventory"

CONNECTIONS = "n02-station-connections.csv"
NETWORK_CSV = "n02-station-network.csv"
NETWORK_JSON = "n02-station-network.json"
LINES_CSV = "n02-line-shape-classification.csv"
LEDGER = "network-corrections-2026-08-13.json"

# Where each file lives under classification/ and under rebuild-inventory/.
INVENTORY_SUBDIR = {
    CONNECTIONS: "stations",
    NETWORK_CSV: "stations",
    NETWORK_JSON: "stations",
    LINES_CSV: "lines",
    LEDGER: "evidence",
}

AUDIT_DATE = "2026-08-19"
ORIGIN = "correction_2026-08-19"

REMOVALS = [
    {
        "operator": "養老鉄道",
        "line": "養老線",
        "edge": "室—西大垣",
        "connection_uid": "養老鉄道␟養老線␟004922␟004945",
        "groups": ("004922", "004945"),
        "between": "大垣",
        "n02_defect": (
            "审计伪邻接边（大垣 スイッチバック）：養老線 桑名方（西大垣）与 揖斐方"
            "（室）两条轨道在 (136.60904,35.36720) 汇合，该点距 大垣 站锚约 685 m，"
            "两条腿由汇合点分别以方位角 265.8° 与 271.7° 离开（夹角 5.9°），"
            "第三条腿 658 m 东行进 大垣 后到 (136.61686,35.36665) 为端点。"
            "自 室 经汇合点往 西大垣 需 174° 掉头，无任何客运列车按此运行；"
            "汇合点距 大垣 685 m，超出 drop_skip_station_edges 的 400 m 窗口，"
            "几何启发式抓不到。"
        ),
        "reason": (
            "室—西大垣 间无跳过 大垣 的客运服务：養老線 站序为 西大垣（41.2 km）"
            "— 大垣（43.0 km）— 室（44.1 km），大垣 为桑名方面与揖斐方面线路汇合"
            "的スイッチバック形配線，全线直通列车必须在此改变方向。删除后主干经 大垣。"
        ),
        "source_url": "https://ja.wikipedia.org/wiki/%E9%A4%8A%E8%80%81%E9%89%84%E9%81%93%E9%A4%8A%E8%80%81%E7%B7%9A",
        "source_quote": (
            "途中にある東海道本線・樽見鉄道樽見線乗り換え駅の大垣駅は、桑名方面と"
            "揖斐方面との線路が合流するスイッチバック形の配線となっている。"
        ),
    },
    {
        "operator": "松浦鉄道",
        "line": "西九州線",
        "edge": "川東—東山代",
        "connection_uid": "松浦鉄道␟西九州線␟009429␟009442",
        "groups": ("009429", "009442"),
        "between": "伊万里",
        "n02_defect": (
            "审计伪邻接边（伊万里 スイッチバック）：西九州線 有田方（川東）与 "
            "佐世保方（東山代）两条轨道在 (129.87032,33.27233) 汇合，该点距 伊万里 "
            "站锚约 560 m，两条腿由汇合点分别以方位角 259.2° 与 279.5° 离开"
            "（夹角 20.3°），第三条腿 465 m 东行经 伊万里 后到端点。"
            "自 川東 经汇合点往 東山代 需 160° 掉头，无任何客运列车按此运行；"
            "汇合点距 伊万里 560 m，超出 drop_skip_station_edges 的 400 m 窗口。"
        ),
        "reason": (
            "川東—東山代 间无跳过 伊万里 的客运服务：西九州線 站序为 川東"
            "（11.6 km）— 伊万里（13.0 km）— 東山代（16.3 km）；伊万里駅 为"
            "スイッチバック構造，且 2002-03-01 新駅舎完成后线路被分断，"
            "定期旅客列车无「同駅を跨いでの直通」。删除后主干经 伊万里。"
        ),
        "source_url": "https://ja.wikipedia.org/wiki/%E6%9D%BE%E6%B5%A6%E9%89%84%E9%81%93%E8%A5%BF%E4%B9%9D%E5%B7%9E%E7%B7%9A",
        "source_quote": (
            "伊万里駅はスイッチバック構造（定期旅客列車の同駅を跨いでの直通はなし）／"
            "2002年（平成14年）3月1日：伊万里駅新駅舎完成に伴い筑肥線・西九州線間が分断。"
        ),
    },
    {
        "operator": "東日本旅客鉄道",
        "line": "東北線",
        "edge": "北赤羽—川口",
        "connection_uid": "東日本旅客鉄道␟東北線␟003086␟003130",
        "groups": ("003086", "003130"),
        "between": "赤羽",
        "n02_defect": (
            "审计伪邻接边（赤羽 进路）：别线（埼京線）自 北赤羽 与 本線 自 川口 "
            "两条轨道在 (139.71835,35.78162) 汇合，该点距 赤羽 站锚约 485 m，"
            "两条腿由汇合点分别以方位角 326.6° 与 338.4° 离开（夹角 11.8°），"
            "第三条腿 383 m 东南行进 赤羽 站区。自 北赤羽 经汇合点往 川口 需 168° "
            "掉头，无任何客运列车按此运行；汇合点距 赤羽 485 m，超出 "
            "drop_skip_station_edges 的 400 m 窗口（与 08-18 批次 成田 枢纽"
            "约 600 m 同因）。"
        ),
        "reason": (
            "北赤羽—川口 间无跳过 赤羽 的客运服务：北赤羽 在東北本線別線"
            "（埼京線，起点 赤羽）上，川口 在本線 赤羽 以北；两站各自经 赤羽 相连"
            "（北赤羽—赤羽 1.6033 km、赤羽—川口 2.5457 km 均为既有真实边）。"
            "删除后主干经 赤羽 连续。"
        ),
        "source_url": "https://ja.wikipedia.org/wiki/%E5%9F%BC%E4%BA%AC%E7%B7%9A",
        "source_quote": (
            "埼京線は東北本線の支線（通称・赤羽線区間を含む）を走る運転系統で、"
            "大宮 - 赤羽間は東北本線の別線として建設された。"
        ),
    },
]

# 養老線 and 西九州線 lose their only branch part with this edge: the "terminal
# branch" the classifier saw was the reversal stub, not a branch. Every reversal
# station of the 2026-08-13 batch was normalised the same way.
LINE_RECLASSIFICATION = {
    ("養老鉄道", "養老線"): {
        "shape_class": "ordinary_linear",
        "branch_count": "0",
        "branch_parts_json": "[]",
        "review_status": "network_verified_linear",
    },
    ("松浦鉄道", "西九州線"): {
        "shape_class": "ordinary_linear",
        "branch_count": "0",
        "branch_parts_json": "[]",
        "review_status": "network_verified_linear",
    },
}

# Role priority, copied from build-japan-station-network.py primary_style().
STYLE_PRIORITY = [
    "reversing_station",
    "branch_origin",
    "multi_line_station",
    "multi_operator_interchange",
    "loop_station",
    "branch_terminal",
    "line_terminal",
    "disconnected_station",
    "isolated_or_unmatched",
    "ordinary_station",
]

# Roles that come from the N02 geometry graph rather than from the station
# degree, and so survive an adjacency correction untouched.
GEOMETRY_ROLES = {
    "reversing_station",
    "loop_station",
    "disconnected_station",
    "multi_line_station",
    "multi_operator_interchange",
}


def read_csv(path: Path) -> tuple[list[str], list[dict]]:
    with path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        return list(reader.fieldnames or []), list(reader)


def line_terminator(path: Path) -> str:
    """What this file already uses. The three CSVs do not agree: the station
    network and line classification are CRLF, the connections table is LF, and
    rewriting one in the other's terminator would rewrite every line of a 25 MB
    file for a six-row edit."""
    with path.open("rb") as source:
        head = source.read(1 << 16)
    return "\r\n" if b"\r\n" in head else "\n"


def write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
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


def write_json(path: Path, payload) -> None:
    """The station network JSON is compact and unterminated; keep it that way."""
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def station_key(uid: str, line: str) -> tuple[str, str]:
    return (uid, line)


def recomputed_roles(previous: list[str], degree: int, branch_candidate: bool) -> list[str]:
    """The generator's own role rules, re-run at the new degree.

    build-japan-station-network.py adds branch_origin at degree>=3, one of
    branch_terminal/line_terminal at degree==1, isolated_or_unmatched at 0, and
    ordinary_station only when nothing else has claimed the station.
    """
    roles = {role for role in previous if role in GEOMETRY_ROLES}
    if degree >= 3:
        roles.add("branch_origin")
    elif degree == 1:
        roles.add("branch_terminal" if branch_candidate else "line_terminal")
    elif degree == 0:
        roles.add("isolated_or_unmatched")
    elif not roles:
        roles.add("ordinary_station")
    return sorted(roles)


def primary_style(tags: set[str]) -> str:
    return next((style for style in STYLE_PRIORITY if style in tags), "ordinary_station")


def apply(root: Path) -> dict:
    connections_path = root / CONNECTIONS
    network_csv_path = root / NETWORK_CSV
    network_json_path = root / NETWORK_JSON
    lines_path = root / LINES_CSV

    uids = {
        removal["connection_uid"]: removal for removal in REMOVALS
    }
    connection_fields, connection_rows = read_csv(connections_path)
    survivors = [row for row in connection_rows if row["connection_uid"] not in uids]
    removed = len(connection_rows) - len(survivors)
    if removed == 0:
        return {"already_applied": True}
    if removed != 2 * len(REMOVALS):
        raise SystemExit(
            f"expected {2 * len(REMOVALS)} directed rows to remove, found {removed}"
        )

    # Which (station, line) pairs lost a neighbour, and what their new degree is.
    touched: set[tuple[str, str]] = set()
    for removal in REMOVALS:
        for group in removal["groups"]:
            touched.add(station_key(f"{removal['operator']}␟{group}", removal["line"]))

    degree: dict[tuple[str, str], set[str]] = {}
    branch_candidate: dict[tuple[str, str], bool] = {}
    for row in survivors:
        key = station_key(row["from_station_uid"], row["line"])
        degree.setdefault(key, set()).add(row["to_station_uid"])
        tags = json.loads(row["connection_type_tags_json"])
        if "branch_candidate" in tags:
            branch_candidate[key] = True

    new_roles: dict[tuple[str, str], list[str]] = {}
    for key in sorted(touched):
        # The pre-correction roles live on any surviving row that names the
        # station; they are identical on every one of them.
        previous: list[str] = []
        for row in survivors:
            if station_key(row["from_station_uid"], row["line"]) == key:
                previous = json.loads(row["from_line_station_style_json"])
                break
        new_roles[key] = recomputed_roles(
            previous, len(degree.get(key, set())), branch_candidate.get(key, False)
        )

    for row in survivors:
        for side in ("from", "to"):
            key = station_key(row[f"{side}_station_uid"], row["line"])
            if key in new_roles:
                row[f"{side}_line_station_style_json"] = json.dumps(
                    new_roles[key], ensure_ascii=False
                )
    write_csv(connections_path, connection_fields, survivors)

    # ── station network: drop the neighbour, recompute counts and styles ──
    dropped_neighbour: dict[str, set[tuple[str, str]]] = {}
    for removal in REMOVALS:
        a, b = removal["groups"]
        a_uid = f"{removal['operator']}␟{a}"
        b_uid = f"{removal['operator']}␟{b}"
        dropped_neighbour.setdefault(a_uid, set()).add((b_uid, removal["line"]))
        dropped_neighbour.setdefault(b_uid, set()).add((a_uid, removal["line"]))

    network_fields, network_rows = read_csv(network_csv_path)
    changed_stations = []
    for row in network_rows:
        uid = row["station_uid"]
        if uid not in dropped_neighbour:
            continue
        rail = [
            entry
            for entry in json.loads(row["rail_connections_json"])
            if (entry["station_uid"], entry["line"]) not in dropped_neighbour[uid]
        ]
        row["rail_connections_json"] = json.dumps(rail, ensure_ascii=False)
        row["rail_neighbor_count"] = str(len(rail))
        row["total_connected_station_count"] = str(
            len(rail) + int(row["interchange_neighbor_count"])
        )
        lines = json.loads(row["connected_lines_json"])
        tags: set[str] = set()
        for detail in lines:
            key = station_key(uid, detail["line"])
            if key in new_roles:
                detail["station_roles"] = new_roles[key]
            tags.update(detail["station_roles"])
        if len(lines) >= 2:
            tags.add("multi_line_station")
        if int(row["physical_station_operator_count"]) >= 2:
            tags.add("multi_operator_interchange")
        if not tags:
            tags.add("ordinary_station")
        row["connected_lines_json"] = json.dumps(lines, ensure_ascii=False)
        row["station_style_tags_json"] = json.dumps(sorted(tags), ensure_ascii=False)
        row["station_style"] = primary_style(tags)
        row["record_origin"] = ORIGIN
        row["change_effective_date"] = AUDIT_DATE
        row["change_note"] = "删除 1 条无向相邻关系"
        changed_stations.append(f"{row['operator']}/{row['station_name']}")
    write_csv(network_csv_path, network_fields, network_rows)

    # The JSON mirror holds the same stations AND the same directed connections,
    # under unsuffixed key names and with real numbers where the CSV has text.
    # Patch it from the corrected CSV so the two can never disagree.
    network_json = json.loads(network_json_path.read_text("utf-8"))
    by_uid = {row["station_uid"]: row for row in network_rows}
    for record in network_json["stations"]:
        row = by_uid.get(record["station_uid"])
        if row is None or row["station_uid"] not in dropped_neighbour:
            continue
        keep = {
            (entry["station_uid"], entry["line"])
            for entry in json.loads(row["rail_connections_json"])
        }
        record["rail_connections"] = [
            entry
            for entry in record["rail_connections"]
            if (entry["station_uid"], entry["line"]) in keep
        ]
        record["rail_neighbor_count"] = int(row["rail_neighbor_count"])
        record["total_connected_station_count"] = int(row["total_connected_station_count"])
        for detail in record["connected_lines"]:
            key = station_key(record["station_uid"], detail["line"])
            if key in new_roles:
                detail["station_roles"] = new_roles[key]
        record["station_style_tags"] = json.loads(row["station_style_tags_json"])
        record["station_style"] = row["station_style"]
        record["record_origin"] = ORIGIN
        record["change_effective_date"] = AUDIT_DATE
        record["change_note"] = "删除 1 条无向相邻关系"
    network_json["connections"] = [
        entry for entry in network_json["connections"] if entry["connection_uid"] not in uids
    ]
    for entry in network_json["connections"]:
        for side in ("from", "to"):
            key = station_key(entry[f"{side}_station_uid"], entry["line"])
            if key in new_roles:
                entry[f"{side}_line_station_style_json"] = json.dumps(
                    new_roles[key], ensure_ascii=False
                )
    write_json(network_json_path, network_json)

    # ── line classification ──
    line_fields, line_rows = read_csv(lines_path)
    for row in line_rows:
        key = (row["operator"], row["line"])
        if key not in {(r["operator"], r["line"]) for r in REMOVALS}:
            continue
        row["record_origin"] = ORIGIN
        row["change_effective_date"] = AUDIT_DATE
        row["change_note"] = "删除 1 条无向相邻关系"
        override = LINE_RECLASSIFICATION.get(key)
        if not override:
            continue
        row["shape_class"] = override["shape_class"]
        row["branch_count"] = override["branch_count"]
        row["branch_parts_json"] = override["branch_parts_json"]
        row["review_status"] = override["review_status"]
    write_csv(lines_path, line_fields, line_rows)

    return {
        "already_applied": False,
        "directed_rows_removed": removed,
        "stations_changed": sorted(changed_stations),
        "connections_after": len(survivors),
    }


LEDGER_BLOCK_KEY = "switchback_pseudo_edge_removals_2026_08_19"
LEDGER_SUMMARY_KEY = "switchback_pseudo_edges_removed_2026_08_19"
# Anchors for the surgical insert below. The ledger is hand-maintained JSON —
# a few of its objects are written inline — so it is edited as TEXT and then
# parsed back and compared, rather than reflowed by json.dumps.
SUMMARY_ANCHOR = (
    '"keio_new_line_split_2026_08_18": {"adjacency_removed": 1, '
    '"adjacency_reassigned": 3, "stations_reassigned": 2, "lines_added": 1}'
)
BLOCK_ANCHOR = '\n  "stations_removed":'


def ledger_block() -> dict:
    entries = []
    for removal in REMOVALS:
        entries.append(
            {
                "action": "REMOVE_ADJACENCY",
                "operator": removal["operator"],
                "line": removal["line"],
                "edge": removal["edge"],
                "connection_uid": removal["connection_uid"],
                "skipped_station": removal["between"],
                "n02_defect": removal["n02_defect"],
                "reason": removal["reason"],
                "source_url": removal["source_url"],
                "source_quote": removal["source_quote"],
            }
        )
    return {
        "audit_date": AUDIT_DATE,
        "scope": (
            "2026-08-19 折返伪边批次（13）：删除三条「轨道拓扑可达但需在汇合点掉头」"
            "的审计伪邻接边。三者同形——N02 把折返站两侧的线路接在距月台数百米的"
            "汇合节点上，两条腿自该节点同向离开（夹角 6°/20°/12°），"
            "first_station_paths 直接穿过该节点便产生跳过折返站的直连边，"
            "而 build-japan-package-from-inventory.py 的 drop_skip_station_edges "
            "只检查 A–B 轨道是否通过同线他站 400 m 以内，三处汇合点分别在 "
            "685 m / 560 m / 485 m 之外，故几何启发式抓不到（与 2026-08-18 批次的 "
            "成田 枢纽约 600 m 同因）。删除依据为运营方现行站序与配线："
            "大垣・伊万里 为スイッチバック配線，赤羽 为東北本線別線起点。"
            "同批把 養老線 与 西九州線 的 shape_class 由 branched_terminal 正规化为 "
            "ordinary_linear、branch_parts_json 清空——分类器看到的「terminal branch」"
            "正是折返股本身，与 2026-08-13 批次对 磐越西線・篠ノ井線・豊肥線 的处理一致；"
            "auto_shape_class 保留 branched_terminal，仍如实描述 N02 原始端点图。"
            "车站角色按生成器自身的邻接度规则重算（degree>=3 为 branch_origin，"
            "else ordinary_station），几何来源的 loop_station / disconnected_station "
            "标签保留。"
        ),
        "detected_by": (
            "app/scripts/validation/validate-railway-topology.mjs "
            "sharp_artificial_turn（批次 13 起改以 straightRunMeters 量测转角两侧"
            "的实轨长度，折返因此不再被边长闸门吞掉）"
        ),
        "applied_by": "app/scripts/migrations/remove-switchback-pseudo-adjacency-2026-08-19.py",
        "adjacency_removed": entries,
    }


def update_ledger(path: Path) -> None:
    text = path.read_text("utf-8")
    before = json.loads(text)
    if LEDGER_BLOCK_KEY in before:
        return
    if text.count(SUMMARY_ANCHOR) != 1 or text.count(BLOCK_ANCHOR) != 1:
        raise SystemExit(f"{path.name}: cannot locate a unique insertion point")

    text = text.replace(
        SUMMARY_ANCHOR,
        SUMMARY_ANCHOR + f',\n    "{LEDGER_SUMMARY_KEY}": {len(REMOVALS)}',
    )
    block = json.dumps({LEDGER_BLOCK_KEY: ledger_block()}, ensure_ascii=False, indent=2)
    # Drop the wrapper braces; the member's own lines already carry the
    # two-space top-level indent the rest of the file uses.
    body = "\n".join(block.split("\n")[1:-1])
    text = text.replace(BLOCK_ANCHOR, "\n" + body + "," + BLOCK_ANCHOR)

    after = json.loads(text)
    expected = dict(before)
    expected["summary"] = dict(before["summary"])
    expected["summary"][LEDGER_SUMMARY_KEY] = len(REMOVALS)
    expected[LEDGER_BLOCK_KEY] = ledger_block()
    if after != expected:
        raise SystemExit(f"{path.name}: text edit did not produce the expected ledger")
    path.write_text(text, encoding="utf-8")


def refresh_manifest() -> None:
    manifest_path = INVENTORY / "MANIFEST.json"
    manifest = json.loads(manifest_path.read_text("utf-8"))
    for entry in manifest["files"]:
        path = INVENTORY / entry["path"]
        entry["bytes"] = path.stat().st_size
        entry["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    with (INVENTORY / "stations" / CONNECTIONS).open(
        encoding="utf-8-sig", newline=""
    ) as source:
        manifest["counts"]["directed_rail_connections"] = sum(1 for _ in csv.reader(source)) - 1
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> None:
    result = apply(CLASSIFICATION)
    if result.get("already_applied"):
        print("already applied — no rows matched the three connection uids")
        return
    update_ledger(CLASSIFICATION / LEDGER)
    for name, subdir in INVENTORY_SUBDIR.items():
        shutil.copy2(CLASSIFICATION / name, INVENTORY / subdir / name)
    refresh_manifest()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
