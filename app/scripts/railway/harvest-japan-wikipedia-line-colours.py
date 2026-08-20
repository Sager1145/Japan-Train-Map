#!/usr/bin/env python3
"""Read documented Japanese line colours out of the cached ja.wikipedia list.

`日本の鉄道ラインカラー一覧` is an aggregator: most of its per-operator tables
cite the operator's own route map, station-numbering guideline or press
release.  Reading it is therefore *documented* evidence, one authority step
below a HEX taken from the operator's own asset — which is exactly how the
existing colour inventory tiers `documented_line_color` under `official_hex`.

The parser keeps that distinction visible instead of flattening it:

* every emitted row carries the section, the table, the row's own reference
  URLs and whether the table itself is cited;
* `列車種別`/`車体色`/withdrawn tables are skipped — a train-type or livery
  colour is not a line colour;
* rows are joined to canonical N02 `(運営会社, 路線名)` keys only through an
  exact name match or an explicit, reasoned decision in
  `colours/wikipedia/n02-line-colour-decisions.json`.  Nothing is guessed
  from string similarity: `本線` alone matches half the country.

The output is an evidence CSV.  Merging it into `colours/line-colours.json`
is a separate, explicit step (`--write`), so the curated inventory never
changes as a side effect of re-reading the page.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
JP_COLOURS = APP_DIR / "data/raw/railway/jp/colours"
DEFAULT_WIKITEXT = JP_COLOURS / "wikipedia/line-colour-list-rev110713989.wiki"
DEFAULT_DECISIONS = JP_COLOURS / "wikipedia/n02-line-colour-decisions.json"
DEFAULT_EVIDENCE = JP_COLOURS / "wikipedia/n02-line-colour-evidence.csv"
DEFAULT_LINE_COLOURS = JP_COLOURS / "line-colours.json"
DEFAULT_CANONICAL = (
    APP_DIR / "data/raw/railway/jp/classification/n02-official-line-colours.csv"
)
SOURCE_PAGE = "https://ja.wikipedia.org/wiki/日本の鉄道ラインカラー一覧"
SOURCE_REVISION = "110713989 (2026-08-20T12:04:36Z)"
KEY_SEPARATOR = "␟"

# Tables that describe something other than a line's own colour.
SKIP_TABLE = ("種別", "ゾーンカラー", "行先", "方向幕", "コーポレートカラー")
# A table whose header names 列車 is a train-identification chart: the six
# 新幹線 departure-board colours and every 列車愛称 palette live in those, and
# reading them as line colours would paint のぞみ yellow across 東海道新幹線.
SKIP_HEADER = ("列車名", "愛称")

BG = re.compile(r"background(?:-color)?\s*:\s*([#\w]+)")
ROWSPAN = re.compile(r"rowspan\s*=\s*\"?(\d+)")
LINK = re.compile(r"\[\[([^\]\|]+)(?:\|([^\]]+))?\]\]")
REF = re.compile(r"<ref[^>]*?/>|<ref[^>]*>.*?</ref>", re.S)
REF_BODY = re.compile(r"<ref[^>]*>(.*?)</ref>", re.S)
URL = re.compile(r"https?://[^\s\]|}<]+")
COMMENT = re.compile(r"<!--.*?-->", re.S)
FILE_LINK = re.compile(r"\[\[(?:File|file|ファイル|Image|image):[^\]]*\]\]")
TAG = re.compile(r"<[^>]+>")
TEMPLATE = re.compile(r"\{\{[^{}]*\}\}")
BOLD_LINE = re.compile(r"^'''(.+?)'''\s*$")

# CSS keywords used by the page's editors.  A keyword is an approximation by
# definition — the operator publishes a HEX or a DIC number, never "limegreen"
# — so a row that carries one is marked as such and never reaches `high`.
CSS_NAMES = {
    "aqua": "#00ffff", "black": "#000000", "blue": "#0000ff", "brown": "#a52a2a",
    "chocolate": "#d2691e", "crimson": "#dc143c", "cyan": "#00ffff",
    "darkblue": "#00008b", "darkgreen": "#006400", "darkorange": "#ff8c00",
    "deeppink": "#ff1493", "dodgerblue": "#1e90ff", "firebrick": "#b22222",
    "gold": "#ffd700", "gray": "#808080", "green": "#008000",
    "greenyellow": "#adff2f", "grey": "#808080", "hotpink": "#ff69b4",
    "indigo": "#4b0082", "khaki": "#f0e68c", "lightgreen": "#90ee90",
    "lime": "#00ff00", "limegreen": "#32cd32", "magenta": "#ff00ff",
    "maroon": "#800000", "mediumblue": "#0000cd", "mediumseagreen": "#3cb371",
    "mediumvioletred": "#c71585", "navy": "#000080", "olive": "#808000",
    "orange": "#ffa500", "orangered": "#ff4500", "pink": "#ffc0cb",
    "plum": "#dda0dd", "purple": "#800080", "red": "#ff0000",
    "royalblue": "#4169e1", "salmon": "#fa8072", "seagreen": "#2e8b57",
    "silver": "#c0c0c0", "skyblue": "#87ceeb", "slateblue": "#6a5acd",
    "springgreen": "#00ff7f", "steelblue": "#4682b4", "teal": "#008080",
    "tomato": "#ff6347", "turquoise": "#40e0d0", "violet": "#ee82ee",
    "white": "#ffffff", "yellow": "#ffff00", "yellowgreen": "#9acd32",
}
# Table furniture, not a line colour.
NEUTRAL_CELL = {
    "#ccc", "#cccccc", "#ddd", "#dddddd", "#eee", "#eeeeee", "#efefef",
    "#e6e6e6", "#f2f2f2", "#f8f9fa", "#fff", "#ffffff",
}

SECTION_OPERATORS = {
    "新幹線": ["北海道旅客鉄道", "東日本旅客鉄道", "東海旅客鉄道", "西日本旅客鉄道", "九州旅客鉄道"],
    "北海道旅客鉄道（JR北海道）": ["北海道旅客鉄道"],
    "東日本旅客鉄道（JR東日本）": ["東日本旅客鉄道"],
    "東海旅客鉄道（JR東海）": ["東海旅客鉄道"],
    "西日本旅客鉄道（JR西日本）": ["西日本旅客鉄道"],
    "四国旅客鉄道（JR四国）": ["四国旅客鉄道"],
    "九州旅客鉄道（JR九州）": ["九州旅客鉄道"],
    "東京地下鉄（東京メトロ）": ["東京地下鉄"],
    "東武鉄道": ["東武鉄道"],
    "西武鉄道": ["西武鉄道"],
    "京王電鉄": ["京王電鉄"],
    "小田急電鉄・小田急箱根": ["小田急電鉄", "小田急箱根"],
    "東急電鉄・横浜高速鉄道": ["東急電鉄", "横浜高速鉄道"],
    "京浜急行電鉄・都営地下鉄浅草線・京成電鉄・北総鉄道・芝山鉄道": [
        "京浜急行電鉄", "東京都", "京成電鉄", "北総鉄道", "芝山鉄道",
    ],
    "相模鉄道": ["相模鉄道"],
    "名古屋鉄道": ["名古屋鉄道"],
    "近畿日本鉄道": ["近畿日本鉄道"],
    "南海電気鉄道": ["南海電気鉄道"],
    "阪急電鉄": ["阪急電鉄"],
    "阪神電気鉄道・山陽電気鉄道": ["阪神電気鉄道", "山陽電気鉄道"],
    "京阪電気鉄道": ["京阪電気鉄道"],
    "西日本鉄道": ["西日本鉄道"],
    "大阪市高速電気軌道（Osaka Metro・ニュートラム）": ["大阪市高速電気軌道"],
    "札幌市営地下鉄": ["札幌市"],
    "仙台市地下鉄": ["仙台市"],
    "都営地下鉄": ["東京都"],
    "横浜市営地下鉄": ["横浜市"],
    "名古屋市営地下鉄": ["名古屋市"],
    "京都市営地下鉄": ["京都市"],
    "神戸市営地下鉄": ["神戸市"],
    "福岡市地下鉄": ["福岡市"],
    "富山地方鉄道（鉄道線）": ["富山地方鉄道"],
    "富山地方鉄道（市内電車）": ["富山地方鉄道"],
    "伊予鉄道（郊外電車）": ["伊予鉄道"],
    "伊予鉄道（市内線）": ["伊予鉄道"],
    "京福電気鉄道（嵐電）": ["京福電気鉄道"],
    "熊本市交通局（熊本市電）": ["熊本市"],
    "鹿児島市交通局（鹿児島市電）": ["鹿児島市"],
    "京都丹後鉄道": ["WILLER　TRAINS"],
    "北大阪急行": ["北大阪急行電鉄"],
    "宇都宮ライトレール": ["宇都宮ライトレール"],
}
# A row that names the operating company in brackets belongs to that company
# alone — 北陸新幹線 is green for JR東日本 and blue for JR西日本.
OPERATOR_IN_BRACKETS = {
    "JR北海道": "北海道旅客鉄道", "JR東日本": "東日本旅客鉄道",
    "JR東海": "東海旅客鉄道", "JR西日本": "西日本旅客鉄道",
    "JR四国": "四国旅客鉄道", "JR九州": "九州旅客鉄道",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wikitext", type=Path, default=DEFAULT_WIKITEXT)
    parser.add_argument("--decisions", type=Path, default=DEFAULT_DECISIONS)
    parser.add_argument("--canonical", type=Path, default=DEFAULT_CANONICAL)
    parser.add_argument("--evidence-out", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--line-colours", type=Path, default=DEFAULT_LINE_COLOURS)
    parser.add_argument(
        "--write",
        action="store_true",
        help="merge the resolved rows into colours/line-colours.json",
    )
    return parser.parse_args()


# ───────────────────────────── wikitext helpers ─────────────────────────────


def normalise_hex(value: str) -> str | None:
    value = (value or "").strip().lower()
    value = CSS_NAMES.get(value, value)
    if not value.startswith("#"):
        return None
    if len(value) == 4:
        value = "#" + "".join(channel * 2 for channel in value[1:])
    return value if re.fullmatch(r"#[0-9a-f]{6}", value) else None


def strip_markup(text: str) -> str:
    text = REF.sub("", text)
    text = COMMENT.sub("", text)
    text = FILE_LINK.sub("", text)
    text = TEMPLATE.sub("", text)
    return TAG.sub("\n", text)


def cell_attributes(cell: str) -> tuple[str, str]:
    """Split a wikitable cell into its attribute prefix and its content."""
    match = re.match(r"^([^|\[\]{}]*?)\|(?!\|)(.*)$", cell, re.S)
    if match and re.search(r"(style|rowspan|colspan|class|align|width)\s*=", match.group(1)):
        return match.group(1), match.group(2)
    return "", cell


def link_names(text: str) -> list[str]:
    names = []
    for target, label in LINK.findall(text):
        names.append(target.strip())
        if label:
            names.append(label.strip())
    return names


def plain_names(text: str) -> list[str]:
    body = LINK.sub(lambda match: (match.group(2) or match.group(1)), strip_markup(text))
    names = []
    for part in re.split(r"[\n・,、/／]", body):
        part = part.strip().strip("'").strip()
        if part and len(part) <= 40:
            names.append(part)
    return names


def reference_urls(text: str) -> list[str]:
    urls = []
    for body in REF_BODY.findall(text):
        urls.extend(URL.findall(body))
    urls.extend(URL.findall(" ".join(TEMPLATE.findall(text))))
    return list(dict.fromkeys(url.rstrip(".,;") for url in urls))


def normalise(text: str) -> str:
    return unicodedata.normalize("NFKC", text or "").strip().replace(" ", "")


def normalise_line(name: str) -> str:
    """`4号線丸ノ内線` → `丸ノ内線`, `1号線(御堂筋線)` → `御堂筋線`."""
    name = normalise(name)
    unwrapped = re.sub(r"^第?\d+号線[（(]?([^）)]*)[）)]?$", r"\1", name)
    name = unwrapped or name
    stripped = re.sub(r"[（(][^）)]*[）)]", "", name).strip()
    return stripped or name


def name_variants(name: str) -> set[str]:
    base = normalise_line(name)
    variants = {base}
    if base.endswith("本線"):
        variants.add(base[:-2] + "線")
    elif base.endswith("線"):
        variants.add(base[:-1] + "本線")
    return {variant for variant in variants if variant}


# ───────────────────────────────── parsing ──────────────────────────────────


def parse_rows(wikitext: str) -> list[dict]:
    """Every table row of the page that paints a colour swatch."""
    section = {2: "", 3: "", 4: "", 5: ""}
    records: list[dict] = []
    in_table = False
    table_rows: list[tuple[list[tuple[str, str]], list[tuple[int, str, int]]]] = []
    row: list[tuple[str, str]] = []
    pending: list[tuple[int, str, int]] = []
    caption = ""
    table_label = ""
    table_refs: list[str] = []
    headers: list[str] = []
    last_bold = ""

    def end_row() -> None:
        nonlocal row, pending
        if row or pending:
            table_rows.append((row, list(pending)))
            pending = [
                (count - 1, colour, column)
                for count, colour, column in pending
                if count - 1 > 0
            ]
        row = []

    def end_table() -> None:
        nonlocal table_rows, pending
        for cells, inherited in table_rows:
            colour = None
            colour_column = None
            keyword = False
            for index, (attributes, _) in enumerate(cells):
                match = BG.search(attributes)
                if not match:
                    continue
                value = normalise_hex(match.group(1))
                if not value or value in NEUTRAL_CELL:
                    continue
                colour = value
                colour_column = index
                keyword = match.group(1).strip().lower() in CSS_NAMES
                break
            if colour is None and inherited:
                colour = inherited[0][1]
            if colour is None:
                continue
            if colour_column is None:
                head_cells = [content for _, content in cells]
            else:
                before = [content for _, content in cells[:colour_column]]
                after = [content for _, content in cells[colour_column + 1 :]]
                head_cells = before if any(cell.strip() for cell in before) else after
            head = " ".join(head_cells)
            records.append(
                {
                    "section": " > ".join(part for part in section.values() if part),
                    # A `|+` caption belongs to this table; a bold line above it
                    # may belong to the paragraph before it (東京メトロ's
                    # 「列車種別案内色」 heads a section whose FIRST table is the
                    # line-colour table), so the caption wins when both exist.
                    "table": caption or table_label,
                    "table_refs": table_refs,
                    "headers": headers,
                    "row_refs": reference_urls(" ".join(content for _, content in cells)),
                    "names": list(dict.fromkeys(link_names(head) + plain_names(head))),
                    "colour": colour,
                    "css_keyword": keyword,
                    "label": " ".join(strip_markup(head).split())[:80],
                }
            )
        table_rows = []
        pending = []

    for raw_line in wikitext.splitlines():
        line = raw_line.rstrip()
        heading = re.match(r"^(={2,5})\s*(.*?)\s*\1\s*$", line)
        if heading:
            level = len(heading.group(1))
            title = LINK.sub(
                lambda match: (match.group(2) or match.group(1)),
                strip_markup(heading.group(2)),
            ).strip()
            section[level] = title
            for deeper in range(level + 1, 6):
                section[deeper] = ""
            last_bold = ""
            continue
        bold = BOLD_LINE.match(line.strip())
        if bold and not in_table:
            last_bold = strip_markup(bold.group(1)).strip()
            continue
        if line.startswith("{|"):
            in_table = True
            table_rows, row, pending = [], [], []
            caption = ""
            table_label = last_bold
            table_refs = []
            headers = []
            last_bold = ""
            continue
        if not in_table:
            continue
        if line.startswith("|}"):
            end_row()
            end_table()
            in_table = False
            continue
        if line.startswith("|+"):
            caption = strip_markup(line[2:]).strip()
            table_refs.extend(reference_urls(line))
            continue
        if line.startswith("|-"):
            end_row()
            continue
        if line.startswith("!"):
            table_refs.extend(reference_urls(line))
            headers.append(" ".join(strip_markup(line[1:]).split()))
            continue
        if line.startswith("|"):
            for chunk in re.split(r"\|\|", line[1:]):
                attributes, content = cell_attributes(chunk)
                row.append((attributes, content))
                span = ROWSPAN.search(attributes)
                match = BG.search(attributes)
                value = normalise_hex(match.group(1)) if match else None
                if span and value and value not in NEUTRAL_CELL and int(span.group(1)) > 1:
                    pending.append((int(span.group(1)), value, len(row) - 1))
            continue
        if row:
            attributes, content = row[-1]
            row[-1] = (attributes, content + "\n" + line)

    return records


def table_is_line_colours(record: dict) -> bool:
    if any(word in header for header in record["headers"] for word in SKIP_HEADER):
        return False
    label = f'{record["table"]} {record["section"]}'
    if any(word in label for word in SKIP_TABLE):
        return False
    if "車体" in label and not ("案内色" in label or "ラインカラー" in label):
        return False
    # 「路線ラインカラー（2025年8月3日以降不使用）」 and similar.
    return "不使用" not in label and "廃止" not in label


def section_operators(record: dict, n02_operators: set[str]) -> list[str]:
    """Which N02 operators a section heading speaks for.

    Most of the long tail needs no table: the page's heading IS the N02
    company name (`上信電鉄`, `樽見鉄道`).  Only headings that group companies,
    rename them or brand them (`京都丹後鉄道` for WILLER　TRAINS) are listed
    above, and a heading that matches nothing is ignored rather than guessed.
    """
    parts = [part for part in record["section"].split(" > ") if part]
    for part in reversed(parts):
        if part in SECTION_OPERATORS:
            return SECTION_OPERATORS[part]
        bare = re.sub(r"[（(][^）)]*[）)]", "", part).strip()
        if bare in n02_operators:
            return [bare]
    return []


# ─────────────────────────────── joining ───────────────────────────────────


def build_index(
    records: list[dict], n02_operators: set[str]
) -> dict[tuple[str, str], list[tuple[dict, str]]]:
    index: dict[tuple[str, str], list[tuple[dict, str]]] = defaultdict(list)
    for record in records:
        if not table_is_line_colours(record):
            continue
        operators = section_operators(record, n02_operators)
        if not operators:
            continue
        for name in record["names"]:
            bracketed = re.search(r"[（(]([^）)]*)[）)]", name)
            restricted = None
            if bracketed:
                for text, operator in OPERATOR_IN_BRACKETS.items():
                    if text in bracketed.group(1):
                        restricted = operator
            targets = [restricted] if restricted in operators else operators
            for variant in name_variants(name):
                for operator in targets:
                    index[(operator, variant)].append((record, name))
    return index


def main() -> None:
    args = parse_args()
    wikitext = args.wikitext.read_text(encoding="utf-8")
    records = parse_rows(wikitext)
    decisions = json.loads(args.decisions.read_text(encoding="utf-8"))
    canonical = list(csv.DictReader(args.canonical.open(encoding="utf-8-sig")))
    index = build_index(records, {row["operator"] for row in canonical})

    resolved: list[dict] = []
    unresolved: list[dict] = []
    for row in canonical:
        key = row["canonical_key"]
        operator, line = row["operator"], row["line"]
        decision = decisions.get("lines", {}).get(key, {})
        if decision.get("skip"):
            unresolved.append(
                {"canonical_key": key, "operator": operator, "line": line,
                 "reason": decision.get("reason", "")}
            )
            continue

        hits: list[tuple[dict, str]] = []
        if decision.get("wiki_name"):
            for wanted in [decision["wiki_name"]] if isinstance(decision["wiki_name"], str) else decision["wiki_name"]:
                for variant in name_variants(wanted):
                    hits.extend(index.get((decision.get("wiki_operator", operator), variant), []))
        else:
            for variant in name_variants(line):
                hits.extend(index.get((operator, variant), []))

        colours = {record["colour"] for record, _ in hits}
        chosen = decision.get("colour")
        if chosen:
            colours = {chosen}
        if not hits and not chosen:
            unresolved.append(
                {"canonical_key": key, "operator": operator, "line": line,
                 "reason": "no row on the page for this line"}
            )
            continue
        if len(colours) > 1:
            unresolved.append(
                {"canonical_key": key, "operator": operator, "line": line,
                 "reason": "conflicting rows: " + " / ".join(sorted(colours))}
            )
            continue

        colour = chosen or hits[0][0]["colour"]
        source_record = None
        for record, _ in hits:
            if record["colour"] == colour:
                source_record = record
                break
        refs = []
        if source_record:
            refs = [
                url
                for url in source_record["row_refs"] + source_record["table_refs"]
                if "wikipedia.org" not in url and "wikimedia.org" not in url
            ]
        resolved.append(
            {
                "canonical_key": key,
                "operator": operator,
                "line": line,
                "colour": colour,
                "matched_name": (hits[0][1] if hits else decision.get("wiki_name", "")),
                "section": source_record["section"] if source_record else decision.get("section", ""),
                "table": source_record["table"] if source_record else "",
                "css_keyword": int(bool(source_record and source_record["css_keyword"])),
                "cited_source_urls": " ".join(refs[:3]),
                "decision": decision.get("reason", ""),
                "confidence": decision.get("confidence")
                or ("low" if source_record and source_record["css_keyword"] else "medium"),
            }
        )

    args.evidence_out.parent.mkdir(parents=True, exist_ok=True)
    with args.evidence_out.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(resolved[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(sorted(resolved, key=lambda row: row["canonical_key"]))

    summary = {
        "page_rows_with_a_swatch": len(records),
        "canonical_lines": len(canonical),
        "resolved": len(resolved),
        "unresolved": len(unresolved),
        "cited_by_operator_source": sum(1 for row in resolved if row["cited_source_urls"]),
        "css_keyword_rows": sum(1 for row in resolved if row["css_keyword"]),
        "evidence": str(args.evidence_out),
    }

    if args.write:
        summary.update(merge_into_inventory(args.line_colours, resolved))

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if unresolved:
        report = defaultdict(list)
        for row in unresolved:
            report[row["reason"]].append(f'{row["operator"]}␟{row["line"]}')
        print("\nunresolved:")
        for reason, keys in sorted(report.items(), key=lambda item: -len(item[1])):
            print(f"  {reason} ({len(keys)})")
            for key in keys[:8]:
                print(f"      {key}")
            if len(keys) > 8:
                print(f"      … {len(keys) - 8} more")


def merge_into_inventory(path: Path, resolved: list[dict]) -> dict:
    """Add a line-level record for every resolved line that has none yet."""
    inventory = json.loads(path.read_text(encoding="utf-8"))
    existing = {
        (record["operator_n02"], record["line_n02"]): record for record in inventory
    }
    added = 0
    kept = 0
    filled = 0
    for row in resolved:
        key = (row["operator"], row["line"])
        record = existing.get(key)
        if record and record.get("color"):
            # An operator-published value already occupies this key.  The page
            # is one authority step below it and never overwrites it.
            kept += 1
            continue
        if record:
            # A researched-but-unconfirmed record (`color: null`): the page
            # supplies the value its own research could not reach.
            record["color"] = row["colour"]
            record["confidence"] = row["confidence"]
            record["source"] = (
                "ja.wikipedia「日本の鉄道ラインカラー一覧」"
                f'§{row["section"].split(" > ")[-1]}'
            )
            record["source_url"] = row["cited_source_urls"].split(" ")[0] or SOURCE_PAGE
            record["notes"] = (
                (record.get("notes", "") + " ").lstrip()
                + f'ラインカラー一覧 rev.{SOURCE_REVISION} の「{row["matched_name"]}」行で補完。'
            ).strip()
            record["wikipedia_revision"] = SOURCE_REVISION
            filled += 1
            continue
        source = (
            "ja.wikipedia「日本の鉄道ラインカラー一覧」"
            f'§{row["section"].split(" > ")[-1]}'
        )
        if row["cited_source_urls"]:
            source += "（同表は事業者公式資料を出典として明示）"
        inventory.append(
            {
                "line_n02": row["line"],
                "line_normalised": normalise_line(row["line"]),
                "aliases": sorted(name_variants(row["line"]) | {row["line"]}),
                "operator_n02": row["operator"],
                "color": row["colour"],
                "line_code": "",
                "source": source,
                "source_url": row["cited_source_urls"].split(" ")[0] or SOURCE_PAGE,
                "confidence": row["confidence"],
                "notes": (
                    f'ラインカラー一覧 rev.{SOURCE_REVISION} の「{row["matched_name"]}」行。'
                    + (row["decision"] or "")
                ).strip(),
                "in_n02": True,
                "wikipedia_revision": SOURCE_REVISION,
            }
        )
        added += 1
    inventory.sort(key=lambda record: (record["operator_n02"], record["line_n02"]))
    path.write_text(
        json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {
        "inventory_records": len(inventory),
        "added": added,
        "filled_empty_records": filled,
        "already_present": kept,
    }


if __name__ == "__main__":
    main()
