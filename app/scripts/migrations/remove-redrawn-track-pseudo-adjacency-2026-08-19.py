#!/usr/bin/env python3
"""Delete three N02 pseudo-adjacencies whose track another hop already draws (2026-08-19).

Batches 19 and 21 are one defect wearing two hats. In both, the station
contracted graph carries a DIRECT edge between two stations that no line
section joins, because `first_station_paths` walked a track path nobody could
ride, and the package builder then drew that path a SECOND time on top of the
hops that legitimately cover it.

    四国旅客鉄道 予讃線    五郎—新谷      redraws 3.26 km of 新谷—伊予大洲
    東日本旅客鉄道 東北線  王子—日暮里    redraws the 尾久 支線, 372 m past 尾久
    東日本旅客鉄道 東北線  東十条—日暮里  the same 支線, one station further out

予讃線 五郎—新谷 is a WYE chord. The 内子経由新線 runs 3.15 km west from 新谷
and meets the 海回り本線 at 伊予若宮信号場 — (132.56469, 33.53163), 1,208 m from
五郎 and 2,348 m from 伊予大洲. The three legs leave that node on bearings 29.3°
(五郎), 57.6° (新谷) and 210.3° (伊予大洲): the 五郎 and 新谷 legs are 28.3°
apart, so going from 五郎 to 新谷 through the node is a 152° reversal. Nothing
runs it, and the official 営業キロ has no such section — 予讃線 is 高松—宇和島
297.6 km, 向井原—内子 23.5 km and 新谷—伊予大洲 5.9 km, while the fourth side of
the wye, 五郎—新谷, was the 内子線's own first section until it was ABOLISHED on
1986-03-03, the day the 新線 opened. drop_skip_station_edges cannot see this one
at all: it asks whether the A–B track runs within 400 m of another station of
the line, and this edge runs past no station whatsoever.

東北線 王子/東十条—日暮里 are skip-station edges over 尾久, and they are the
opposite failure — 372 m from 尾久's platform, comfortably INSIDE the 400 m
window, and the guard still never looked. The reason is that the test needs a
cut to measure, and it cannot make one: 東北線's N02 sections fall into three
connected groups (389 / 8 / 3 sections), and 日暮里's platform is the only one
of the corridor's stations that projects onto the 8-section island rooted at
(139.77069, 35.72840) — 王子, 東十条, 尾久, 上中里, 田端, 西日暮里, 鶯谷, 上野 and
赤羽 all land on the 389-section main group. `TrackGraph.path_between` therefore
returns None for EVERY pair that ends at 日暮里, and `stations_passed_by_cut`
reports that "no track could be cut" as the empty list — which reads, at the
call site, as "this edge skips nobody". Every other pseudo-edge of the same
clique (東十条—尾久, 東十条—鶯谷, 王子—鶯谷, 尾久—鶯谷) was cut normally; the two
that end at 日暮里 are the ones that got through. So neither `keep`, nor
`shield`, nor the connectivity guard held these back: the geometric test
returned "nothing" where it meant "unknown".

Sources (quoted in the ledger entry):
  * 予讃線   「新谷駅 - 伊予大洲駅間 5.9 km（新谷駅 - 伊予若宮信号場間は3.5 km）」
              「実際の分岐点は五郎駅 - 伊予大洲駅間にある伊予若宮信号場である。」
  * 内子線   「予讃本線の向井原駅 - 内子駅間、新谷駅 - 伊予大洲駅間の開業により
              内子線が短絡ルートに組み込まれる。……五郎駅 - 新谷駅間は廃止」
              (1986-03-03); today 内子線 is 新谷—内子 5.3 km.
  * 尾久駅   「線路名称上は東北本線の日暮里駅 - 当駅 - 赤羽駅間の支線（尾久支線）
              である。」 隣の駅 上野 -（井堀信号場）- 尾久 - 赤羽.
  * 王子駅   JR は京浜東北線のみ、隣の駅「東十条駅 (JK 37) - 王子駅 (JK 36) -
              上中里駅 (JK 35)」——王子 も 東十条 も 日暮里 行きの直通はない。

What this rewrites, following the 2026-08-13 method_notes:
  * n02-station-connections.csv — the six directed rows go; the per-line style
    columns of every surviving row are recomputed for the stations whose degree
    changed.
  * n02-station-network.csv / .json — rail_connections_json, the two counts,
    station_style and the role tags, recomputed by the generator's own degree
    rules (degree>=3 branch_origin, degree==1 line/branch terminal, else
    ordinary_station). Geometry-sourced tags (loop_station, reversing_station,
    disconnected_station, multi_*) are preserved: they describe the N02 graph,
    not the adjacency.
  * n02-line-shape-classification.csv — line-level columns are NOT touched.
    予讃線 keeps `branch_rejoins` and its officially verified 内子経由新線 part
    (向井原 → … → 内子 → 新谷 → 伊予大洲): that route is real, it simply crosses
    into 内子線's own graph, which is why 予讃線's own adjacency is a tree.
    東北線 keeps its eight parts, including the 尾久 rejoin variant, which after
    this correction is exactly what the graph shows.
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
        "operator": "四国旅客鉄道",
        "line": "予讃線",
        "edge": "五郎—新谷",
        "connection_uid": "四国旅客鉄道␟予讃線␟009199␟009213",
        "groups": ("009199", "009213"),
        "between": "伊予大洲",
        "n02_defect": (
            "审计伪邻接边（伊予若宮信号場 三岔）：内子経由新線 自 新谷 西行 3.15 km "
            "在 (132.56469,33.53163) 与 海回り本線 汇合，该点距 五郎 站锚 1208 m、"
            "距 伊予大洲 站锚 2348 m（审计自己记作「五郎附近(1207m)」）。三条腿由汇合点"
            "分别以方位角 29.3°（五郎）、57.6°（新谷）、210.3°（伊予大洲）离开——"
            "五郎 腿与 新谷 腿仅差 28.3°，自 五郎 经汇合点往 新谷 需 152° 掉头。"
            "收缩图仍据此登记 五郎—新谷 4.3981 km 直连边，包生成器遂把 "
            "五郎→新谷 4.477 km 与 新谷→伊予大洲 5.843 km 画在同一段 3.26 km 轨道上"
            "（validate-railway-topology 的 reversal_joint_redraws_track）。"
            "drop_skip_station_edges 抓不到：它只检查 A–B 轨道是否通过同线他站 "
            "400 m 以内，而这条边不通过任何车站。"
        ),
        "reason": (
            "五郎—新谷 间无线路区段：予讃線 官方営業キロ 只有 高松—宇和島 297.6 km、"
            "向井原—内子 23.5 km、新谷—伊予大洲 5.9 km（新谷—伊予若宮信号場 3.5 km）；"
            "短絡ルート 的实际分岐点是 五郎—伊予大洲 间的 伊予若宮信号場，"
            "而 五郎—新谷 是旧 内子線 的首段，1986-03-03 新線開業当日廃止。"
            "删除后 予讃線-3 成 新谷 → 伊予大洲 单区间 5.843 km（官方 5.9 km），"
            "五郎 由本线 春賀—五郎—伊予大洲 连续通过。"
        ),
        "source_url": "https://ja.wikipedia.org/wiki/%E5%86%85%E5%AD%90%E7%B7%9A",
        "source_quote": (
            "予讃本線の向井原駅 - 内子駅間、新谷駅 - 伊予大洲駅間の開業により内子線が"
            "短絡ルートに組み込まれる。新谷駅に交換設備が設けられ、五十崎駅・内子駅は"
            "移転、五郎駅 - 新谷駅間は廃止（1986年3月3日）／"
            "予讃線 新谷駅 - 伊予大洲駅間 5.9 km（新谷駅 - 伊予若宮信号場間は3.5 km）、"
            "実際の分岐点は五郎駅 - 伊予大洲駅間にある伊予若宮信号場である。"
        ),
    },
    {
        "operator": "東日本旅客鉄道",
        "line": "東北線",
        "edge": "王子—日暮里",
        "connection_uid": "東日本旅客鉄道␟東北線␟003236␟003417",
        "groups": ("003236", "003417"),
        "between": "尾久",
        "n02_defect": (
            "审计跳站伪边（尾久支線）：该边 6.2817 km 的轨道就是 日暮里—尾久—赤羽 "
            "支線，画出来距 尾久 站台最近 372 m —— 在 drop_skip_station_edges 的 "
            "400 m 窗口**之内**，与 08-18/08-19 两批「合流点在窗口之外」正相反。"
            "挡住剪边的既不是 keep 也不是 shield，更不是连通性守卫：東北線 的 N02 "
            "区段分 3 个连通组（389 / 8 / 3 段），日暮里 的站台是这条走廊上唯一投影到"
            "以 (139.77069,35.72840) 为根的 8 段孤岛的车站，王子・東十条・尾久・"
            "上中里・田端・西日暮里・鶯谷・上野・赤羽 全在 389 段主组上，于是 "
            "TrackGraph.path_between 对**任何以 日暮里 为端点**的站对都返回 None，"
            "stations_passed_by_cut 把「切不出轨道」当成空表返回，调用处读作"
            "「这条边没跳过任何车站」。同族其余伪边（東十条—尾久、東十条—鶯谷、"
            "王子—鶯谷、尾久—鶯谷）都被几何判据正常剪掉，漏网的正是两条端点为 日暮里 的。"
            "画出来的后果：東北線-4 在 日暮里 以南 265 m 处 168° 折返，"
            "王子→日暮里 越过自己的站台再回头（interval_doubles_back_at_station）。"
        ),
        "reason": (
            "王子—日暮里 间无客运服务：王子 的 JR 只有京浜東北線停车，隣の駅为 "
            "東十条 (JK 37) — 王子 (JK 36) — 上中里 (JK 35)，往 日暮里 必经 "
            "上中里・田端・西日暮里；而该边所走的 尾久支線 上唯一的车站是 尾久，"
            "其 隣の駅 为 上野 —（井堀信号場）— 尾久 — 赤羽。"
            "删除后 尾久 由既有真实边 尾久—日暮里 2.9996 km（官方 日暮里—尾久 2.7 km）"
            "接回，電車線 站序 赤羽—東十条—王子—上中里—田端—西日暮里—日暮里 完整成链。"
        ),
        "source_url": "https://ja.wikipedia.org/wiki/%E5%B0%BE%E4%B9%85%E9%A7%85",
        "source_quote": (
            "線路名称上は東北本線の日暮里駅 - 当駅 - 赤羽駅間の支線（尾久支線）である。"
            "運行系統上は、当駅経由となっている列車線を走る宇都宮線・高崎線列車が停車する。"
            "／隣の駅：上野駅 (JU 02) -（井堀信号場）- 尾久駅 (JU 03) - 赤羽駅 (JU 04)"
        ),
    },
    {
        "operator": "東日本旅客鉄道",
        "line": "東北線",
        "edge": "東十条—日暮里",
        "connection_uid": "東日本旅客鉄道␟東北線␟003210␟003417",
        "groups": ("003210", "003417"),
        "between": "尾久",
        "n02_defect": (
            "审计跳站伪边（尾久支線，同 王子—日暮里 一族）：6.2797 km，比 王子—日暮里 "
            "多跳一站 王子，走的是同一条 尾久支線 轨道。漏网原因相同——端点 日暮里 "
            "的站台落在 東北線 那个 8 段孤立连通组上，path_between 返回 None，"
            "stations_passed_by_cut 因此报告「没跳过任何车站」。"
            "包生成器据此把 東北線-2 的 東十条→日暮里 画成 5.987 km 的支線轨道，"
            "同一条走廊连同 東北線-4 一共画了三遍。"
        ),
        "reason": (
            "東十条—日暮里 间无客运服务：東十条 的 JR 只有京浜東北線停车，"
            "隣の駅为 赤羽 — 東十条 — 王子；該边跳过 王子・上中里・田端・西日暮里 "
            "四站（電車線）或 王子・尾久（尾久支線）。"
            "删除后 東北線-2 成 赤羽—東十条—王子—上中里—田端—西日暮里—日暮里—上野—"
            "御徒町—秋葉原—神田—東京 的连续站序。"
        ),
        "source_url": "https://ja.wikipedia.org/wiki/%E6%9D%B1%E5%8D%81%E6%9D%A1%E9%A7%85",
        "source_quote": (
            "線路名称上は東北本線であるが、当駅には電車線を走る京浜東北線電車のみが停車"
            "／隣の駅：赤羽駅 (JK 38) - 東十条駅 (JK 37) - 王子駅 (JK 36)"
        ),
    },
]

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

    uids = {removal["connection_uid"]: removal for removal in REMOVALS}
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
        row["change_note"] = "删除重画轨道的伪相邻关系"
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
        record["change_note"] = "删除重画轨道的伪相邻关系"
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

    # ── line classification: provenance only ──
    #
    # Neither line is reclassified. 予讃線's 内子経由新線 rejoin variant and
    # 東北線's 尾久 rejoin variant both describe real, officially listed track;
    # what was wrong was the adjacency graph, not the shape.
    line_fields, line_rows = read_csv(lines_path)
    per_line = {}
    for removal in REMOVALS:
        per_line[(removal["operator"], removal["line"])] = (
            per_line.get((removal["operator"], removal["line"]), 0) + 1
        )
    for row in line_rows:
        count = per_line.get((row["operator"], row["line"]))
        if not count:
            continue
        row["record_origin"] = ORIGIN
        row["change_effective_date"] = AUDIT_DATE
        row["change_note"] = f"删除 {count} 条无向相邻关系（重画轨道的伪边）"
    write_csv(lines_path, line_fields, line_rows)

    return {
        "already_applied": False,
        "directed_rows_removed": removed,
        "stations_changed": sorted(changed_stations),
        "connections_after": len(survivors),
    }


LEDGER_BLOCK_KEY = "redrawn_track_pseudo_edge_removals_2026_08_19"
LEDGER_SUMMARY_KEY = "redrawn_track_pseudo_edges_removed_2026_08_19"
# Anchors for the surgical insert below. The ledger is hand-maintained JSON —
# a few of its objects are written inline — so it is edited as TEXT and then
# parsed back and compared, rather than reflowed by json.dumps.
SUMMARY_ANCHOR = '"switchback_pseudo_edges_removed_2026_08_19": 3'
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
            "2026-08-19 重画轨道伪边批次（19+21）：删除三条「轨道拓扑可达但没有任何"
            "线路区段与之对应」的审计伪邻接边，它们的共同后果是把别的区间已经画过的"
            "轨道再画一遍。予讃線 五郎—新谷 是 伊予若宮信号場 三岔的第四条弦——"
            "五郎 腿与 新谷 腿自汇合点仅相差 28.3°，走通需 152° 掉头，官方営業キロ "
            "无此区段（五郎—新谷 是旧 内子線 首段，1986-03-03 新線開業当日廃止），"
            "而 drop_skip_station_edges 完全抓不到：这条边不通过任何车站。"
            "東北線 王子—日暮里 与 東十条—日暮里 是跳过 尾久 的跳站边，轨道距 尾久 "
            "站台 372 m —— 在 400 m 窗口**之内**却仍未被剪，与 08-18/08-19 两批"
            "「合流点在窗口之外」正相反：東北線 的 N02 区段分 3 个连通组"
            "（389/8/3 段），日暮里 的站台是这条走廊上唯一落在 8 段孤岛"
            "（根 139.77069,35.72840）的车站，TrackGraph.path_between 对任何以 "
            "日暮里 为端点的站对都返回 None，stations_passed_by_cut 把「切不出轨道」"
            "当空表返回，调用处读作「没跳过任何车站」——挡住剪边的既不是 keep，"
            "也不是 shield，更不是连通性守卫，而是几何判据把「无从判断」答成了「无」。"
            "同族其余伪边（東十条—尾久、東十条—鶯谷、王子—鶯谷、尾久—鶯谷）都被正常剪掉。"
            "两条线路的 shape_class 与 branch_parts_json 均不改动：予讃線 的 "
            "内子経由新線 与 東北線 的 尾久 rejoin variant 描述的都是真实且官方列出的"
            "线路，错的是邻接图不是形态。车站角色按生成器自身的邻接度规则重算"
            "（degree>=3 为 branch_origin、degree==1 为 line/branch terminal、"
            "else ordinary_station），几何来源的 loop_station / reversing_station / "
            "disconnected_station 标签保留。"
        ),
        "detected_by": (
            "app/scripts/validation/validate-railway-topology.mjs "
            "reversal_joint_redraws_track（予讃線-3）与 sharp_artificial_turn + "
            "interval_doubles_back_at_station（東北線-4）"
        ),
        "applied_by": "app/scripts/migrations/remove-redrawn-track-pseudo-adjacency-2026-08-19.py",
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
