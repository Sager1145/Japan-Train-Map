# Raw railway sources — local only, not committed

This directory holds the inputs the railway packages are built from. **It is
not tracked by git**: everything except this README is ignored, and the
historical copies were removed from the repository's history on 2026-08-31.

None of it is ours to redistribute. The MLIT and operator publications carry
their own attribution and use terms, OpenStreetMap is ODbL, and the Apple Maps
survey is Apple's imagery. What this project publishes is the processed output
in `app/data/` and `app/public/rail/`, with per-source provenance recorded in
`app/public/rail/*.sources.md`.

**Nothing at runtime reads this directory** — the server serves processed JSON
from `app/data/` and published packages from `app/public/rail/`. You only need
it to re-derive a package.

## What belongs here, and where to get it

| Path | Source | Derived into |
| --- | --- | --- |
| `railway/jp/N02-25_GML.zip` | 国土交通省 国土数値情報 鉄道データ N02, 2025 edition — <https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html> | `data/rail-sections.json`, `data/stations.json` |
| `railway/jp/rebuild-inventory/` | N02-derived station network and connection tables | Japan package |
| `railway/jp/osm/`, `railway/tw/osm/` | OpenStreetMap extracts, ODbL 1.0 | Names, structure, colour fallbacks |
| `railway/jp/apple-maps/` | Apple Maps transit survey captures | Visual cross-check evidence only |
| `railway/hk/` | Prepared OSM alignments and official tram stop tables | Hong Kong package and solver datasets |
| `railway/mo/` | Prepared DSCC alignment data | Macao package and solver datasets |
| `railway/kr/kr-track-alignments.json` | Prepared OpenStreetMap alignments | Korea package and solver datasets |
| `railway/kr/official/` | data.go.kr CSV snapshots and checksum manifest | Korea identities, names, positions and distances |
| `railway/tw/` | TRA/operator publications and rebuild inventory | Taiwan package |

The fetchers live in `app/scripts/railway/` (`fetch-korea-official-data.py`,
`download-north-america-*.py`, and the per-country builders). See `jsonspec.md`
for field semantics and the extraction that produced the processed datasets.
