#!/usr/bin/env python3
"""Query Japanese Wikipedia for every non-ordinary N02 topology candidate.

The output is evidence, not an automatic override.  A page that mentions a
branch, loop, disconnected section, or the computed junction/terminal station
names is useful for human confirmation; absence of those words is not proof
that N02 is wrong.  Official sources in ``line-shape-overrides.json`` retain
priority over this secondary network source.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import time
import urllib.parse
import urllib.request
from urllib.error import HTTPError
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CLASSIFICATION = (
    APP_ROOT
    / "data/raw/railway/jp/classification/n02-line-shape-classification.csv"
)
DEFAULT_OUTPUT = (
    APP_ROOT / "data/raw/railway/jp/classification/network-line-shape-research.json"
)
API = "https://ja.wikipedia.org/w/api.php"
USER_AGENT = "Japan-Train-Map line topology audit/1.0 (local research script)"
KEYWORDS = (
    "支線",
    "本線",
    "分岐",
    "分かれ",
    "環状",
    "ループ",
    "周回",
    "旧線",
    "新線",
    "別線",
    "経由",
    "営業区間",
    "起点",
    "終点",
    "区間",
    "廃止",
    "休止",
    "分断",
)

QUERY_ALIASES = {
    ("東京都", "10号線新宿線"): "都営地下鉄新宿線",
    ("東京都", "12号線大江戸線"): "都営地下鉄大江戸線",
    ("立山黒部貫光", "鋼索線"): "立山黒部貫光鋼索線",
    ("長崎電気軌道", "蛍茶屋支線"): "長崎電気軌道蛍茶屋支線",
    ("阪急電鉄", "今津線"): "阪急今津線",
    ("首都圏新都市鉄道", "常磐新線"): "つくばエクスプレス",
}


def api(params: dict) -> dict:
    query = urllib.parse.urlencode({**params, "format": "json", "utf8": 1})
    request = urllib.request.Request(f"{API}?{query}", headers={"User-Agent": USER_AGENT})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code not in {429, 502, 503, 504} or attempt == 5:
                raise
            retry_after = error.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else min(60.0, 4.0 * (2**attempt))
            time.sleep(delay)
    raise RuntimeError("unreachable retry state")


def normalized(text: str) -> str:
    return re.sub(r"[\s・･（）()\-―—_線本號号]", "", text).lower()


def choose_result(row: dict, results: list[dict]) -> dict | None:
    if not results:
        return None
    line_key = normalized(row["line"])
    operator_key = normalized(row["operator"])
    scored = []
    for rank, result in enumerate(results):
        title_key = normalized(result["title"])
        snippet_key = normalized(
            re.sub(r"<[^>]+>", "", result.get("snippet", ""))
            + " "
            + result.get("extract", "")[:1_000]
        )
        score = 100 - rank
        if line_key and line_key in title_key:
            score += 120
        if title_key and title_key in line_key:
            score += 60
        if operator_key and operator_key in snippet_key:
            score += 25
        if any(word in result["title"] for word in ("駅", "列車", "系統")):
            score -= 35
        scored.append((score, result))
    return max(scored, key=lambda item: item[0])[1]


def candidate_station_terms(row: dict) -> list[str]:
    parts = json.loads(row["branch_parts_json"] or "[]")
    terms = []
    for part in parts:
        for field in ("junctions", "terminals", "stations"):
            for value in part.get(field, []):
                clean = re.sub(r"附近\(.*?\)$", "", value)
                if clean and not clean.startswith("@") and clean not in terms:
                    terms.append(clean)
    for value in re.split(r"\s*→\s*", row.get("main_path", "")):
        clean = re.sub(r"（.*?）|\(.*?\)", "", value).strip()
        if clean and clean not in terms and clean not in {"闭环", "无法自动确定"}:
            terms.append(clean)
    return terms[:24]


def evidence_sentences(text: str, terms: list[str]) -> list[str]:
    compact = re.sub(r"\s+", " ", text)
    sentences = re.split(r"(?<=[。！？])\s*|\n+", compact)
    evidence = []
    for sentence in sentences:
        if len(sentence) < 8:
            continue
        hits = sum(keyword in sentence for keyword in KEYWORDS)
        station_hits = sum(term in sentence for term in terms)
        if hits or station_hits >= 2:
            evidence.append(sentence[:500])
        if len(evidence) >= 16:
            break
    return evidence


def confirmation(evidence: list[str], terms: list[str]) -> str:
    combined = " ".join(evidence)
    complex_words = ("支線", "分岐", "環状", "ループ", "周回", "旧線", "別線", "分断")
    complex_hits = sum(word in combined for word in complex_words)
    station_hits = sum(term in combined for term in terms)
    if complex_hits and station_hits >= 2:
        return "supports_complex_shape"
    if complex_hits:
        return "complex_terms_need_station_check"
    if station_hits >= 3:
        return "route_endpoints_supported"
    return "insufficient_evidence"


def research(row: dict, delay: float) -> dict:
    search_line = QUERY_ALIASES.get((row["operator"], row["line"]), row["line"])
    query = f'"{search_line}" "{row["operator"]}" 鉄道'
    response = api(
        {
            "action": "query",
            "generator": "search",
            "gsrsearch": query,
            "gsrlimit": 6,
            "gsrnamespace": 0,
            "prop": "extracts|info",
            "explaintext": 1,
            "exlimit": 6,
            "inprop": "url",
            "redirects": 1,
        }
    )
    results = list(response.get("query", {}).get("pages", {}).values())
    results.sort(key=lambda result: result.get("index", 999))
    selection_row = {**row, "line": search_line}
    result = choose_result(selection_row, results)
    if not result:
        return {
            "canonical_key": row["canonical_key"],
            "operator": row["operator"],
            "line": row["line"],
            "query": query,
            "status": "no_page_found",
            "page_title": "",
            "page_url": "",
            "confirmation": "insufficient_evidence",
            "evidence": [],
        }
    terms = candidate_station_terms(row)
    evidence = evidence_sentences(result.get("extract", ""), terms)
    return {
        "canonical_key": row["canonical_key"],
        "operator": row["operator"],
        "line": row["line"],
        "query": query,
        "status": "queried",
        "page_title": result["title"],
        "page_url": result.get(
            "fullurl",
            "https://ja.wikipedia.org/wiki/"
            + urllib.parse.quote(result["title"].replace(" ", "_")),
        ),
        "page_id": result["pageid"],
        "confirmation": confirmation(evidence, terms),
        "candidate_station_terms": terms,
        "evidence": evidence,
    }


def refetch_evidence(record: dict, row: dict) -> dict:
    if not record.get("page_id"):
        return record
    response = api(
        {
            "action": "query",
            "prop": "extracts|info",
            "pageids": record["page_id"],
            "explaintext": 1,
            "inprop": "url",
            "redirects": 1,
        }
    )
    page = next(iter(response.get("query", {}).get("pages", {}).values()))
    terms = candidate_station_terms(row)
    evidence = evidence_sentences(page.get("extract", ""), terms)
    return {
        **record,
        "status": "queried",
        "page_title": page.get("title", record.get("page_title", "")),
        "page_url": page.get("fullurl", record.get("page_url", "")),
        "confirmation": confirmation(evidence, terms),
        "candidate_station_terms": terms,
        "evidence": evidence,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--classification", type=Path, default=DEFAULT_CLASSIFICATION)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--delay", type=float, default=0.8)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--refetch-evidence", action="store_true")
    parser.add_argument("--key", action="append", help="Only research this canonical key; repeatable")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    with args.classification.open(encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))
    candidates = [
        row
        for row in rows
        if row["shape_class"] != "ordinary_linear"
        or row["auto_shape_class"] != "ordinary_linear"
        or row["review_status"].startswith("needs_")
    ]
    if args.key:
        wanted = set(args.key)
        candidates = [row for row in candidates if row["canonical_key"] in wanted]
    if args.limit:
        candidates = candidates[: args.limit]

    existing = {
        row["canonical_key"]: row
        for row in (
            json.loads(args.output.read_text(encoding="utf-8"))["records"]
            if args.output.exists()
            else []
        )
    }
    if args.refetch_evidence:
        pending = [
            row
            for row in candidates
            if row["canonical_key"] in existing
            and not existing[row["canonical_key"]].get("evidence")
        ]
    else:
        pending = [
            row
            for row in candidates
            if args.refresh
            or row["canonical_key"] not in existing
            or existing[row["canonical_key"]].get("status") != "queried"
        ]
    for index, row in enumerate(pending, 1):
        print(f"[{index}/{len(pending)}] {row['operator']} / {row['line']}", flush=True)
        try:
            if args.refetch_evidence:
                existing[row["canonical_key"]] = refetch_evidence(
                    existing[row["canonical_key"]], row
                )
            else:
                existing[row["canonical_key"]] = research(row, args.delay)
        except Exception as error:  # retain the candidate and make the failure auditable
            existing[row["canonical_key"]] = {
                "canonical_key": row["canonical_key"],
                "operator": row["operator"],
                "line": row["line"],
                "status": "query_error",
                "confirmation": "insufficient_evidence",
                "error": f"{type(error).__name__}: {error}",
                "page_title": "",
                "page_url": "",
                "evidence": [],
            }
        time.sleep(args.delay)

    records = sorted(existing.values(), key=lambda row: (row["operator"], row["line"]))
    payload = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "Japanese Wikipedia MediaWiki API (CC BY-SA 4.0)",
        "method": "Search every non-ordinary N02 topology candidate; retain evidence sentences containing topology keywords or candidate station pairs.",
        "records": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = {}
    for record in records:
        counts[record["confirmation"]] = counts.get(record["confirmation"], 0) + 1
    print(json.dumps({"records": len(records), "confirmation": counts}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
