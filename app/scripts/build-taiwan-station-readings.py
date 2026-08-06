#!/usr/bin/env python3
"""Build the Taiwan four-language station-name table from official snapshots.

The input directory is produced by ``download-taiwan-rail-official.py``.  The
Traditional Chinese, English, and Japanese values are copied only from the
official TDX/PTX ``StationName`` object.  Official sources currently publish no
Simplified Chinese station-name field, so ``zh_Hans`` falls back to a
deterministic Traditional-to-Simplified conversion, as documented by the app.

Stations that only exist in the official NLSC/AFR layer keep their official
Traditional Chinese name from ``tw-2025.json``; unavailable English/Japanese
translations remain empty strings.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple


APP_DIR = Path(__file__).resolve().parent.parent
DEFAULT_PACKAGE = APP_DIR / "public" / "rail" / "tw-2025.json"
DEFAULT_OUTPUT = APP_DIR / "data" / "station-readings-tw.json"

# Every Traditional character that changes under character-level T→S
# conversion in the current official station names. Keeping the complete
# current set local makes this snapshot build deterministic and dependency-free.
# Extend it when a later official snapshot introduces another changing
# character.
HANT_TO_HANS = {
    "亞": "亚", "來": "来", "內": "内", "凱": "凯", "劍": "剑",
    "勁": "劲", "動": "动", "勢": "势", "匯": "汇", "區": "区",
    "員": "员", "嗇": "啬", "國": "国", "圍": "围", "園": "园",
    "圓": "圆", "場": "场", "塊": "块", "壇": "坛", "壢": "坜",
    "壽": "寿", "夢": "梦", "奮": "奋", "學": "学", "宮": "宫",
    "寧": "宁", "對": "对", "導": "导", "岡": "冈", "島": "岛",
    "崗": "岗", "崙": "仑", "嶺": "岭", "廈": "厦", "廠": "厂",
    "張": "张", "後": "后", "復": "复", "愛": "爱", "態": "态",
    "慶": "庆", "時": "时", "會": "会", "東": "东", "柵": "栅",
    "楊": "杨", "業": "业", "榮": "荣", "樂": "乐", "樓": "楼",
    "樹": "树", "橋": "桥", "機": "机", "橫": "横", "櫻": "樱",
    "權": "权", "歸": "归", "漁": "渔", "漢": "汉", "濁": "浊",
    "濱": "滨", "瀧": "泷", "灣": "湾", "烏": "乌", "營": "营",
    "獅": "狮", "獨": "独", "瑪": "玛", "環": "环", "產": "产",
    "碼": "码", "祿": "禄", "萬": "万", "籬": "篱", "紀": "纪",
    "紅": "红", "結": "结", "經": "经", "維": "维", "總": "总",
    "羅": "罗", "義": "义", "聖": "圣", "聯": "联", "腦": "脑",
    "腳": "脚", "臺": "台", "興": "兴", "舊": "旧", "莊": "庄",
    "華": "华", "萊": "莱", "蓮": "莲", "藝": "艺", "蘆": "芦",
    "蘇": "苏", "蘭": "兰", "術": "术", "衛": "卫", "裡": "里",
    "覽": "览", "調": "调", "談": "谈", "讚": "赞", "豐": "丰",
    "貢": "贡", "貴": "贵", "貿": "贸", "車": "车", "軌": "轨",
    "軟": "软", "輔": "辅", "輕": "轻", "迴": "回", "連": "连",
    "運": "运", "邊": "边", "鄧": "邓", "醫": "医", "銅": "铜",
    "鎮": "镇", "鐵": "铁", "鑼": "锣", "長": "长", "門": "门",
    "關": "关", "陽": "阳", "際": "际", "雙": "双", "雲": "云",
    "電": "电", "頂": "顶", "順": "顺", "領": "领", "頭": "头",
    "館": "馆", "馬": "马", "駁": "驳", "驛": "驿", "體": "体",
    "鳳": "凤", "鳴": "鸣", "鶯": "莺", "鹽": "盐", "麗": "丽",
    "龍": "龙", "龜": "龟",
}


@dataclass(frozen=True)
class OfficialStation:
    system: str
    uid: str
    station_id: str
    zh_hant: str
    zh_hans: str
    english: str
    japanese: str
    lon: float
    lat: float


def normalize_name(value: str) -> str:
    return (
        str(value or "")
        .strip()
        .replace(" ", "")
        .replace("ヶ", "ケ")
        .replace("ヵ", "カ")
        .replace("ゖ", "け")
        .replace("ゕ", "か")
    )


def simplified_name(value: str) -> str:
    return "".join(HANT_TO_HANS.get(char, char) for char in str(value or ""))


def localized(value: object, key: str) -> str:
    return str(value.get(key, "")) if isinstance(value, dict) else ""


def source_system(path: Path) -> str:
    match = re.fullmatch(r"(?:tdx|ptx)_([^_]+)_station\.json", path.name)
    if not match:
        raise RuntimeError(f"unrecognized official station file: {path}")
    return match.group(1).upper()


def load_official_stations(source_dir: Path) -> Tuple[List[OfficialStation], str]:
    output: List[OfficialStation] = []
    revisions: List[str] = []
    paths = sorted(source_dir.glob("*_station.json"))
    if not paths:
        raise RuntimeError(f"no official *_station.json snapshots in {source_dir}")
    for path in paths:
        system = source_system(path)
        rows = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(rows, list) or not rows:
            raise RuntimeError(f"empty official station snapshot: {path}")
        for row in rows:
            names = row.get("StationName") or {}
            position = row.get("StationPosition") or {}
            zh_hant = localized(names, "Zh_tw")
            if not zh_hant:
                raise RuntimeError(f"{path.name}: station without official Zh_tw")
            official_hans = next(
                (
                    localized(names, key)
                    for key in ("Zh_cn", "Zh_hans", "Zh_Hans")
                    if localized(names, key)
                ),
                "",
            )
            output.append(
                OfficialStation(
                    system=system,
                    uid=str(row.get("StationUID") or ""),
                    station_id=str(row.get("StationID") or ""),
                    zh_hant=zh_hant,
                    zh_hans=official_hans or simplified_name(zh_hant),
                    english=localized(names, "En"),
                    japanese=localized(names, "Ja"),
                    lon=float(position["PositionLon"]),
                    lat=float(position["PositionLat"]),
                )
            )
            revisions.extend(
                str(row.get(field) or "")
                for field in ("UpdateTime", "SrcUpdateTime")
                if row.get(field)
            )
    if len({row.uid for row in output}) != len(output):
        raise RuntimeError("duplicate StationUID in official station snapshots")
    return output, max(revisions, default="")


def system_for_line(line_id: str) -> str:
    rules = (
        ("tw-thsr", "THSR"),
        ("tw-tra", "TRA"),
        ("tw-trtc-y", "NTMC"),
        ("tw-trtc", "TRTC"),
        ("tw-tym", "TYMC"),
        ("tw-tcmrt", "TMRT"),
        ("tw-krtc", "KRTC"),
        ("tw-ntmetro-v", "NTDLRT"),
        ("tw-ntmetro-k", "NTALRT"),
        ("tw-klrt", "KLRT"),
        ("tw-alsr", "AFR"),
    )
    for prefix, system in rules:
        if line_id.startswith(prefix):
            return system
    raise RuntimeError(f"no official-system mapping for {line_id}")


def distance_km(left: Sequence[float], right: Sequence[float]) -> float:
    lon_scale = 111.32 * math.cos(math.radians((left[1] + right[1]) / 2.0))
    return math.hypot((left[0] - right[0]) * lon_scale, (left[1] - right[1]) * 110.574)


def find_official_station(
    stations: Sequence[OfficialStation],
    system: str,
    name: str,
    english: str,
    point: Sequence[float],
) -> Optional[OfficialStation]:
    expected = [row for row in stations if row.system == system]
    if system == "AFR":
        # 嘉義 is the one TRA station at the head of the official AFR display
        # line.  Other AFR names come from the NLSC station layer and have no
        # official TDX/PTX translation record.
        expected = list(stations)
    candidates = [
        row
        for row in expected
        if normalize_name(row.zh_hant) == normalize_name(name)
        or (english and row.english == english)
    ]
    if not candidates:
        candidates = [
            row
            for row in expected
            if distance_km((row.lon, row.lat), point) <= 0.75
        ]
    if not candidates:
        return None
    candidates.sort(
        key=lambda row: (
            normalize_name(row.zh_hant) != normalize_name(name),
            bool(english) and row.english != english,
            distance_km((row.lon, row.lat), point),
            row.uid,
        )
    )
    best = candidates[0]
    if distance_km((best.lon, best.lat), point) > 2.0:
        return None
    return best


def entry(
    zh_hant: str,
    zh_hans: str,
    japanese: str,
    english: str,
) -> Dict[str, str]:
    return {
        "name": zh_hant,
        "zh_Hant": zh_hant,
        "zh_Hans": zh_hans,
        "ja": japanese,
        "en": english,
    }


def fallback_entry(name: str) -> Dict[str, str]:
    return entry(name, simplified_name(name), "", "")


def build_table(
    package: Dict[str, object],
    official_stations: Sequence[OfficialStation],
    revision: str,
) -> Dict[str, object]:
    # Keep every StationUID published by the official snapshots, including
    # interchange line-specific codes and operational records that are not a
    # separate marker in the current display package.  The map aliases added
    # below are extra lookup keys, not a filter on the official station table.
    by_code: Dict[str, Dict[str, str]] = {
        row.uid: entry(
            row.zh_hant,
            row.zh_hans,
            row.japanese,
            row.english,
        )
        for row in official_stations
    }
    by_uid = {row.uid: row for row in official_stations}
    matched_uids = set()
    fallback_aliases: List[str] = []

    for line in package.get("lines", []):
        line_id = str(line["id"])
        system = system_for_line(line_id)
        for station_row in line.get("stations", []):
            group_id = str(station_row[0])
            name = str(station_row[1])
            english = str(station_row[4]) if len(station_row) > 4 else ""
            point = (float(station_row[2]), float(station_row[3]))
            official = find_official_station(
                official_stations, system, name, english, point
            )
            alias = f"{line_id}:{group_id}"
            if official is None:
                by_code[alias] = fallback_entry(name)
                fallback_aliases.append(alias)
                continue
            matched_uids.add(official.uid)
            by_code[alias] = entry(
                official.zh_hant,
                official.zh_hans,
                official.japanese,
                official.english,
            )

    # Name lookup is only safe when every station with that normalized name has
    # byte-identical language values.  Ambiguous names (e.g. 市政府 in Taipei and
    # Taichung) deliberately have no byName fallback and require their exact UID.
    by_name_candidates: Dict[str, List[Dict[str, str]]] = {}
    for value in by_code.values():
        key = normalize_name(value["name"])
        by_name_candidates.setdefault(key, []).append(value)
    by_name = {}
    ambiguous_names = []
    for key, values in sorted(by_name_candidates.items()):
        signatures = {
            (row["zh_Hant"], row["zh_Hans"], row["ja"], row["en"])
            for row in values
        }
        if len(signatures) != 1:
            ambiguous_names.append(key)
            continue
        row = values[0]
        by_name[key] = {
            "zh_Hant": row["zh_Hant"],
            "zh_Hans": row["zh_Hans"],
            "ja": row["ja"],
            "en": row["en"],
        }

    return {
        "note": (
            "Taiwan official station names for the four UI languages. "
            "Zh-Hant/English/Japanese come from official TDX/PTX StationName; "
            "missing translations are empty. Zh-Hans uses an official field "
            "when available, otherwise a deterministic conversion of Zh-Hant."
        ),
        "country": "TW",
        "languages": ["zh-Hant", "zh-Hans", "ja", "en"],
        "officialRevision": revision,
        "packageVersion": str(package.get("version") or ""),
        "sources": [
            "交通部運輸資料流通服務（TDX/PTX）",
            "內政部國土測繪中心（NLSC）",
            "農業部林業及自然保育署阿里山林業鐵路及文化資產管理處（AFR）",
        ],
        "stats": {
            "byCode": len(by_code),
            "byName": len(by_name),
            "officialStationUIDs": len(by_uid),
            "matchedOfficialStationUIDs": len(matched_uids),
            "networkAliases": sum(
                len(line.get("stations", []))
                for line in package.get("lines", [])
            ),
            "fallbackAliases": len(fallback_aliases),
            "ambiguousNamesWithoutFallback": len(ambiguous_names),
        },
        "byCode": dict(sorted(by_code.items())),
        "byName": by_name,
    }


def write_table(path: Path, table: Dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(table, ensure_ascii=False, indent=2) + "\n"
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(encoded, encoding="utf-8")
    temporary.replace(path)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--package", type=Path, default=DEFAULT_PACKAGE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)

    package = json.loads(args.package.read_text(encoding="utf-8"))
    official_stations, revision = load_official_stations(args.source_dir)
    table = build_table(package, official_stations, revision)
    write_table(args.output, table)
    print(
        f"wrote {args.output}: {table['stats']['byCode']} codes, "
        f"{table['stats']['byName']} names, "
        f"{table['stats']['fallbackAliases']} untranslated network aliases"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
