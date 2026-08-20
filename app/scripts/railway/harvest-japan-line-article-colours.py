#!/usr/bin/env python3
"""Last-resort line colours for railways nothing else colours.

After the operator inventory, the ja.wikipedia line-colour list and the OSM
route relations, a residue is left: mostly funiculars and small third-sector
lines that no source colours at all (`neutral_fallback`, a grey stand-in), plus
the handful whose only OSM value is pure black or pure white — ink, not a
colour, and forbidden on this map.

For exactly those lines this script reads the `路線色` field of the line's own
ja.wikipedia article.  That is an editor-maintained value, not an operator
publication, so it enters the inventory at `confidence: "low"`
(`candidate_line_color`) and never displaces a sourced value: the selection is
computed from the canonical table, and a line that already carries a usable
colour is never queried.

Every record keeps the article title and the revision id it was read from, so
the value can be re-checked or dropped later.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
JP_COLOURS = APP_DIR / "data/raw/railway/jp/colours"
DEFAULT_CANONICAL = (
    APP_DIR / "data/raw/railway/jp/classification/n02-official-line-colours.csv"
)
DEFAULT_CACHE = JP_COLOURS / "wikipedia/line-article-colours.json"
DEFAULT_LINE_COLOURS = JP_COLOURS / "line-colours.json"
API = "https://ja.wikipedia.org/w/api.php"
USER_AGENT = "JapanTrainMap-colour-research/1.0 (https://github.com/Sager1145)"
FORBIDDEN = {"#000000", "#ffffff"}
# An article that fills 路線色 with a neutral grey is saying the same thing the
# neutral fallback already says, so it is recorded but not adopted.
MIN_CHROMA = 24
BATCH = 20

COLOUR_FIELD = re.compile(r"\|\s*(路線色|ラインカラー)\s*=\s*([^\n|}]+)")
CSS_NAMES = {
    "black": "#000000", "blue": "#0000ff", "brown": "#a52a2a", "crimson": "#dc143c",
    "darkblue": "#00008b", "darkgreen": "#006400", "darkorange": "#ff8c00",
    "deeppink": "#ff1493", "deepskyblue": "#00bfff", "dodgerblue": "#1e90ff",
    "gold": "#ffd700", "gray": "#808080", "green": "#008000", "grey": "#808080",
    "hotpink": "#ff69b4", "indigo": "#4b0082", "lightgreen": "#90ee90",
    "lime": "#00ff00", "limegreen": "#32cd32", "magenta": "#ff00ff",
    "mediumseagreen": "#3cb371", "mediumvioletred": "#c71585", "navy": "#000080",
    "orange": "#ffa500", "orangered": "#ff4500", "pink": "#ffc0cb", "purple": "#800080",
    "red": "#ff0000", "royalblue": "#4169e1", "seagreen": "#2e8b57",
    "silver": "#c0c0c0", "skyblue": "#87ceeb", "steelblue": "#4682b4",
    "teal": "#008080", "tomato": "#ff6347", "violet": "#ee82ee", "white": "#ffffff",
    "yellow": "#ffff00", "yellowgreen": "#9acd32",
}
# ja.wikipedia article titles that the (operator, line) pair does not produce.
TITLE_OVERRIDES = {
    "こうべ未来都市機構␟摩耶ケーブル線": "神戸すまいまちづくり公社摩耶ケーブル線",
    "一般財団法人青函トンネル記念館␟青函トンネル竜飛斜坑線": "青函トンネル竜飛斜坑線",
    "御岳登山鉄道␟ケーブルカー": "御岳登山鉄道",
    "十国峠␟十国鋼索線": "十国峠#十国鋼索線",
    "ラクテンチ␟別府ラクテンチケーブル線": "別府ラクテンチケーブル線",
    "四国ケーブル␟八栗ケーブル": "八栗ケーブル",
    "神戸六甲鉄道␟六甲ケーブル線": "六甲ケーブル線",
    "皿倉登山鉄道␟帆柱ケーブル線": "帆柱ケーブル線",
    "比叡山鉄道␟比叡山鉄道線": "比叡山鉄道",
    "鞍馬寺␟鞍馬山鋼索鉄道": "鞍馬山鋼索鉄道",
    "筑波観光鉄道␟筑波山鋼索鉄道線": "筑波山鋼索鉄道線",
    "大山観光電鉄␟大山鋼索線": "大山鋼索線",
    "高尾登山電鉄␟高尾鋼索線": "高尾登山電鉄",
    "立山黒部貫光␟鋼索線": "立山黒部貫光鋼索線",
    "丹後海陸交通␟天橋立鋼索鉄道": "天橋立鋼索鉄道",
    "黒部峡谷鉄道␟本線": "黒部峡谷鉄道本線",
    "舞浜リゾートライン␟ディズニーリゾートライン": "ディズニーリゾートライン",
    "アルピコ交通␟上高地線": "アルピコ交通上高地線",
    "平成筑豊鉄道␟門司港レトロ観光線": "平成筑豊鉄道門司港レトロ観光線",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canonical", type=Path, default=DEFAULT_CANONICAL)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--line-colours", type=Path, default=DEFAULT_LINE_COLOURS)
    parser.add_argument(
        "--fetch", action="store_true", help="query ja.wikipedia and refresh the cache"
    )
    parser.add_argument(
        "--write", action="store_true", help="merge the cache into line-colours.json"
    )
    return parser.parse_args()


def chroma(value: str) -> int:
    red, green, blue = (int(value[index : index + 2], 16) for index in (1, 3, 5))
    return max(red, green, blue) - min(red, green, blue)


def normalise_hex(value: str) -> str | None:
    value = (value or "").strip().strip("'\"").lower()
    value = re.sub(r"<!--.*?-->", "", value).strip()
    value = CSS_NAMES.get(value, value)
    if not value.startswith("#"):
        return None
    value = value.split()[0]
    if len(value) == 4:
        value = "#" + "".join(channel * 2 for channel in value[1:])
    return value if re.fullmatch(r"#[0-9a-f]{6}", value) else None


def needs_a_colour(row: dict) -> bool:
    """Only the lines the sourced chain leaves grey, black or white."""
    value = row["render_color_hex"].strip().lower()
    return row["render_color_basis"] == "neutral_fallback" or value in FORBIDDEN


def candidate_titles(key: str, operator: str, line: str) -> list[str]:
    if key in TITLE_OVERRIDES:
        return [TITLE_OVERRIDES[key]]
    operator = operator.replace("　", "")
    titles = [f"{operator}{line}", line]
    for suffix in ("鉄道", "電鉄", "電気鉄道", "交通"):
        if operator.endswith(suffix) and len(operator) > len(suffix):
            titles.append(f"{operator[: -len(suffix)]}{line}")
    return list(dict.fromkeys(titles))


def query(titles: list[str]) -> dict:
    url = API + "?" + urllib.parse.urlencode(
        {
            "action": "query",
            "prop": "revisions",
            "rvprop": "content|ids",
            "rvslots": "main",
            "titles": "|".join(titles),
            "format": "json",
            "formatversion": "2",
            "redirects": "1",
        }
    )
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)


def fetch(rows: list[dict]) -> list[dict]:
    wanted: list[tuple[str, str]] = []
    for row in rows:
        for title in candidate_titles(row["canonical_key"], row["operator"], row["line"]):
            wanted.append((row["canonical_key"], title.split("#")[0]))

    pages: dict[str, dict] = {}
    titles = list(dict.fromkeys(title for _, title in wanted))
    for index in range(0, len(titles), BATCH):
        payload = query(titles[index : index + BATCH])
        for page in payload.get("query", {}).get("pages", []):
            if "revisions" not in page:
                continue
            pages[page["title"]] = page
        for entry in payload.get("query", {}).get("normalized", []) + payload.get(
            "query", {}
        ).get("redirects", []):
            pages.setdefault(entry["from"], pages.get(entry["to"], {}))
        time.sleep(0.4)

    records = []
    for row in rows:
        key = row["canonical_key"]
        record = {
            "canonical_key": key,
            "operator": row["operator"],
            "line": row["line"],
            "prior_render_color_hex": row["render_color_hex"],
            "prior_render_color_basis": row["render_color_basis"],
            "article_title": "",
            "article_revision": "",
            "raw_value": "",
            "colour": "",
        }
        for title in candidate_titles(key, row["operator"], row["line"]):
            page = pages.get(title.split("#")[0])
            if not page or "revisions" not in page:
                continue
            content = page["revisions"][0]["slots"]["main"]["content"]
            match = COLOUR_FIELD.search(content)
            if not match:
                continue
            colour = normalise_hex(match.group(2))
            if not colour or colour in FORBIDDEN:
                continue
            if chroma(colour) < MIN_CHROMA:
                record["raw_value"] = match.group(2).strip()
                record["article_title"] = page["title"]
                record["article_revision"] = str(page["revisions"][0]["revid"])
                record["rejected"] = "achromatic 路線色; no better than the neutral fallback"
                continue
            record.update(
                {
                    "article_title": page["title"],
                    "article_revision": str(page["revisions"][0]["revid"]),
                    "raw_value": match.group(2).strip(),
                    "colour": colour,
                }
            )
            break
        records.append(record)
    return records


def merge(path: Path, records: list[dict]) -> dict:
    inventory = json.loads(path.read_text(encoding="utf-8"))
    existing = {
        (record["operator_n02"], record["line_n02"]): record for record in inventory
    }
    added = 0
    for record in records:
        if not record["colour"]:
            continue
        key = (record["operator"], record["line"])
        if key in existing and existing[key].get("color"):
            continue
        entry = existing.get(key) or {
            "line_n02": record["line"],
            "line_normalised": record["line"],
            "aliases": [record["line"]],
            "operator_n02": record["operator"],
            "in_n02": True,
        }
        entry.update(
            {
                "color": record["colour"],
                "line_code": entry.get("line_code", ""),
                "source": f'ja.wikipedia「{record["article_title"]}」infobox 路線色',
                "source_url": "https://ja.wikipedia.org/wiki/"
                + urllib.parse.quote(record["article_title"].replace(" ", "_")),
                "confidence": "low",
                "notes": (
                    f'記事 rev.{record["article_revision"]} の路線色 '
                    f'`{record["raw_value"]}`。事業者公表値ではなく、他に色の出典がない'
                    f'路線（従前は {record["prior_render_color_hex"]} / '
                    f'{record["prior_render_color_basis"]}）に限って採用。'
                ),
            }
        )
        if key not in existing:
            inventory.append(entry)
            existing[key] = entry
        added += 1
    inventory.sort(key=lambda record: (record["operator_n02"], record["line_n02"]))
    path.write_text(
        json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {"inventory_records": len(inventory), "added_or_filled": added}


def main() -> None:
    args = parse_args()
    canonical = [
        row
        for row in csv.DictReader(args.canonical.open(encoding="utf-8-sig"))
        if needs_a_colour(row)
    ]

    if args.fetch:
        records = fetch(canonical)
        args.cache.parent.mkdir(parents=True, exist_ok=True)
        args.cache.write_text(
            json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    else:
        records = json.loads(args.cache.read_text(encoding="utf-8"))

    summary = {
        "lines_without_a_usable_colour": len(canonical),
        "cached_records": len(records),
        "with_article_colour": sum(1 for record in records if record["colour"]),
        "without_article_colour": sum(1 for record in records if not record["colour"]),
        "cache": str(args.cache),
    }
    if args.write:
        summary.update(merge(args.line_colours, records))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    for record in records:
        if not record["colour"]:
            print(f'  no 路線色: {record["canonical_key"]}')


if __name__ == "__main__":
    main()
