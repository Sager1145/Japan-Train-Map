#!/usr/bin/env python3
"""Download the official Korean rail source data used by the kr-2025 package.

Everything here comes from data.go.kr (공공데이터포털) under
「이용허락범위 제한 없음」 and is fetched anonymously: the dataset page carries a
direct `fileDownload.do?atchFileId=…` link, and the files are CP949 CSV.

  국토교통부_도시철도 전체노선          46 lines / 1,103 stops IN OFFICIAL ORDER
  국가철도공단_철도역 정보               214 intercity stations, WGS84 + 한자/영문 names
  한국철도공사_KTX 노선별 역정보         high-speed stop order
  한국철도공사_역 위치 정보              KORAIL station positions
  서울교통공사_1~8호선 역사 좌표         Seoul metro positions
  국가철도공단_<line>_역위치             per-line station positions (27 lines)
  국가철도공단_<line>_역간거리           per-line inter-station distances (24 lines)

Output: scripts/railway/data/kr/*.csv plus manifest.json (source URL + sha256 per file).

usage: python3 scripts/railway/fetch-korea-official-data.py [--out DIR]
"""
import argparse, csv, hashlib, io, json, os, re, sys, time, urllib.parse, urllib.request

UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
}
PORTAL = "https://www.data.go.kr"
FIXED = {
    "15122916": "도시철도_전체노선",
    "15067652": "철도역_정보",
    "15127571": "KTX_노선별_역정보",
    "15127532": "코레일_역_위치_정보",
    "15099316": "서울교통공사_역사_좌표",
}
KEYWORD_SETS = [("역위치", "국가철도공단"), ("역간거리", "국가철도공단")]


def get(url, ref=None, timeout=90):
    h = dict(UA)
    if ref:
        h["Referer"] = ref
    return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout).read()


def search(keyword, org, per=100):
    q = {"dType": "FILE", "keyword": keyword, "org": org, "orgFilter": org,
         "orgFullName": org, "conditionType": "search", "perPage": str(per), "currentPage": "1"}
    html = get(f"{PORTAL}/tcs/dss/selectDataSetList.do?" + urllib.parse.urlencode(q)).decode("utf-8", "replace")
    return sorted(set(re.findall(r"/data/(\d+)/fileData\.do", html)))


def download(pk, out_dir, want=None):
    page = f"{PORTAL}/data/{pk}/fileData.do"
    html = get(page).decode("utf-8", "replace")
    title = (re.search(r'<meta property="og:title" content="([^"]+)"', html)
             or re.search(r"<title>\s*([^<]+?)\s*</title>", html))
    title = (title.group(1) if title else pk).replace("| 공공데이터포털", "").strip()
    if want and want not in title and want not in html:
        return None
    m = re.search(r"fileDownload\.do\?atchFileId=([A-Za-z0-9_]+)&(?:amp;)?fileDetailSn=(\d+)", html)
    if not m:
        print(f"  !! {pk} {title}: no anonymous download link", file=sys.stderr)
        return None
    url = (f"{PORTAL}/cmm/cmm/fileDownload.do?atchFileId={m.group(1)}"
           f"&fileDetailSn={m.group(2)}&insertDataPrcus=N")
    raw = get(url, ref=page)
    text = None
    for enc in ("utf-8-sig", "cp949"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        print(f"  !! {pk} {title}: not text", file=sys.stderr)
        return None
    safe = re.sub(r"[^0-9A-Za-z가-힣]+", "_", title)[:60].strip("_")
    path = os.path.join(out_dir, f"{pk}_{safe}.csv")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    return {"pk": pk, "title": title, "file": os.path.basename(path), "page": page,
            "rows": max(0, len(rows) - 1),
            "columns": [c.strip() for c in rows[0]] if rows else [],
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "data", "kr"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    manifest = {}
    for pk in FIXED:
        rec = download(pk, args.out)
        if rec:
            manifest[pk] = rec
            print(f"  {rec['rows']:5d}  {rec['title'][:64]}")
        time.sleep(0.3)
    for keyword, org in KEYWORD_SETS:
        for pk in search(keyword, org):
            if pk in manifest:
                continue
            rec = download(pk, args.out, want=keyword)
            if rec:
                manifest[pk] = rec
                print(f"  {rec['rows']:5d}  {rec['title'][:64]}")
            time.sleep(0.3)
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1, sort_keys=True)
    print(f"\n{len(manifest)} datasets / {sum(r['rows'] for r in manifest.values())} rows -> {args.out}")


if __name__ == "__main__":
    main()
