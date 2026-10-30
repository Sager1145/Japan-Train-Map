# rail.db — the relational mirror of the railway data

`npm run build:db` writes `app/data/rail.db`, a SQLite file that holds every
published railway fact this repository ships, joined into tables.

```bash
cd app && npm run build:db          # data/rail.db, ~45 MB, ~2 s
npm run build:db -- --no-geometry   # attributes only, ~21 MB
npm run build:db -- --out /tmp/x.db
```

It is **derived output** and is gitignored. The packages under
`public/rail/` remain the source of truth; nothing in the app or the site reads
the database. Rebuild it after any package promotion, reading-table refresh, or
solver-dataset rebuild.

## What is in it

| Source | Tables |
| --- | --- |
| `public/rail/<c>-2025.json` (compact-v1 packages) | `country`, `operator`, `line`, `station`, `line_station`, `interval`, `interval_vertex`, `line_structure`, `lane`, `line_service_span`, `line_alignment`, `line_alignment_pair`, `line_extra_segment`, `line_reversal_tail` |
| `data/station-readings*.json` | `station_name`, `line_station_name`, `country_language`, `name_field` |
| `data/rail-sections*.json`, `data/stations*.json` | `source_section`, `source_section_vertex`, `source_station`, `source_station_vertex` |
| `public/rail/logo-credits.json`, `operator-logos/*/manifest.json`, `public/app-operator-branding.js` | `logo_credit`, `logo_asset`, `operator_logo_manifest`, `operator_alias`, and the `badge_path` / `display_label` columns |
| the packages' `geometrySource` / `attributeSources` blocks | `data_source` |
| N02 code spaces + the compact-v1 codec | `institution_type`, `railway_class`, `roma_source`, `structure_kind`, `service_status` |

Views: `line_name`, `station_name_wide`, `station_line`, `interval_detail`,
`badge_provenance`.

Current contents (packages of 2026-08-21):

| | JP | TW | HK | KR | MO |
| --- | ---: | ---: | ---: | ---: | ---: |
| lines | 652 | 39 | 28 | 82 | 3 |
| stations | 9,039 | 505 | 282 | 1,097 | 15 |
| intervals | 9,568 | 548 | 427 | 1,330 | 14 |
| track km | 27,222 | 1,799 | 367 | 4,552 | 14 |

Not included: itinerary and ride records (`data/train-store*.json`, the
precomputed route parts, `matched-routes.json` / `matched-stops.json`) and the
builder inputs under `data/raw/`.

## Badges, and where the artwork came from

`logo_asset` is a table of **referenced** assets, not an inventory of the
directory: a file nothing points at is not railway data. Four kinds, and the
last one is the reason the other three can be traced:

| kind | points from | drawn? |
| --- | --- | --- |
| `line` | `line.logo_asset` — the package's own art | yes |
| `operator` | `operator.logo_path` | yes |
| `badge` | `line.badge_path` where it overrides the above | yes |
| `source` | `operator_logo_manifest.asset_path` | **no** |

A `source` row is the artwork a drawn badge was *derived* from. The site never
requests it, so nothing else in this database would mention it — and it carries
the Wikidata entity, the source page and the licence, which is the only route
from a badge on screen to the terms it is drawn under.

The manifests name their artwork by bare filename, because they sit in the
directory they describe. `asset_path` resolves it: `asset` is `q1007890.svg`
and `logo_asset.path` is `/rail/operator-logos/jp/q1007890.svg`, and no join
bridges those two on its own.

`badge_provenance` puts it together — one row per line that draws a badge, with
the file, its kind, and `license` resolved from whichever record applies. The
per-line credit wins because it is the narrower statement, and it is consulted
only when the badge IS the line's own art.

```sql
-- which drawn badges have no recorded licence
SELECT country_code, badge_kind, COUNT(*) FROM badge_provenance
 WHERE license IS NULL OR license = '' GROUP BY 1, 2;

-- lines whose own art ships but is not what they draw
SELECT id, logo_asset, badge_path FROM line
 WHERE logo_asset IS NOT NULL AND badge_path <> logo_asset;
```

The `jp-badges` manifest is deliberately **not** a provenance source. Despite
the name its rows carry an operator and a `lines_without_badge` count and
nothing else — it is a worklist. Joining it would attach a row whose every
provenance column is null and make a badge look documented when it is not.

## Things to know before writing a query

**A station has two identities.** `station` is one row per *physical* station,
deduplicated by the package's station group code. `line_station` is that station
*as it sits on one line* — with its own anchor coordinates, because each line
anchors the station onto its own surveyed track. `station.name`, `station.lon`
and `station.lat` are summaries (most common spelling, mean of the anchors);
`line_station` is the authority. Where a station's lines disagree about the
spelling — 26 codes in Taiwan, 27 in Korea — `station.name_variant_count` is
above 1.

**There are two rulers, and they are not interchangeable.** `seq` is a station's
ordinal on its line; `measure_m` / `start_m` / `end_m` are metres accumulated
from the package's own interval lengths. `line_service_span` is stated in
ordinals on purpose: display grooming (anchoring, branch cutting, kink
smoothing) moves the drawn geometry, so a metre offset is an approximation on
screen, while an ordinal survives every pass. `line_structure` and `lane` are
surveyed in metres and carry that caveat.

**Geometry is complete in the database.** compact-v1 omits an interval's first
vertex when it repeats the previous interval's last one; `interval_vertex` always
stores it, and `interval.shares_start_vertex` records whether the package had
elided it.

**Japan's source layer is not a copy of its package.** `source_section` holds
the N02 survey itself — 21,933 features that the package cut 9,568 station
intervals out of. For the other four countries the solver sections are
regenerated from the package and match it interval for interval.

**`source_station` is the station-number cross-reference.** `station_code` is
what an itinerary record and a route section cite (`007958`, `TYMC-A13`,
`AEL-MTR-HOK`); `group_code` is what the package calls the same station
(`007958`, `tw-official-tymc-a13`, `hk-official-mtr-hok`). In Japan these are
N02_005c and N02_005g and differ for 1,146 of 10,233 platform features — a
platform code versus the station it belongs to. `station_id` is NULL for the 12
rows naming a station the current packages no longer ship (the 留萌線 closures,
筑豊電気鉄道 西黒崎, and two Taiwanese stations).

**Names.** `station_name` is the raw mirror of the reading tables — Japan keys
by station code, the other four key by `"<lineId>:<stationCode>"` because their
tables localize per line-station, and every table also has a name-keyed
fallback. `line_station_name` is that table *resolved* onto every line-station
through the frontend's own lookup order (`i18n.js` `stationReading`: exact code,
then the composite key, then the normalized-name fallback), with `source`
recording which one answered. A `source` of `package` marks a romanization taken
from the package station row, which is how Japan's 8,803 stations outside the
reading table still get a romaji. Empty values are never stored: a missing row
*is* "no official translation". 94 Japanese line-stations have no name row at
all — the package ships no romanization for them either.

`line_name` is a view, not a table: `line.name` is the line's name in its own
country's language and `line.name_roma` is its English name, so a language table
over them would only duplicate two columns.

**Line classification codes are joined, not stored upstream.** `line`'s
`railway_class_code` and `institution_type_code` come from the solver datasets
by majority vote, and `class_source` says how: `section:name+operator` for 784
lines, `section:name` for 19, `station:group` for one (京王新線, whose operator
was renamed after the N02 vintage).

## Example queries

```sql
-- Every line calling at 新宿, with the operator's passenger-facing label.
SELECT line_name, operator_label, seq
  FROM station_line
 WHERE country_code = 'JP' AND station_name = '新宿';

-- One station's name in every language the data has.
SELECT * FROM station_name_wide
 WHERE country_code = 'KR' AND base_name = '서울';

-- Tunnel and bridge kilometres by operator.
SELECT o.display_label,
       ROUND(SUM(CASE WHEN k.name = 'tunnel' THEN s.end_m - s.start_m END) / 1000, 1) AS tunnel_km,
       ROUND(SUM(CASE WHEN k.name = 'bridge' THEN s.end_m - s.start_m END) / 1000, 1) AS bridge_km
  FROM line_structure s
  JOIN line l ON l.id = s.line_id
  JOIN operator o ON o.id = l.operator_id
  JOIN structure_kind k ON k.code = s.kind_code
 GROUP BY 1 ORDER BY tunnel_km DESC;

-- The itinerary station code -> package station -> the lines that serve it.
SELECT ss.station_code, s.name, l.name AS line_name
  FROM source_station ss
  JOIN station s ON s.id = ss.station_id
  JOIN line_station ls ON ls.station_id = s.id
  JOIN line l ON l.id = ls.line_id
 WHERE ss.country_code = 'JP' AND ss.station_code = '007958';

-- An interval's geometry as an ordered coordinate list.
SELECT v.seq, v.lon, v.lat
  FROM interval_vertex v
  JOIN "interval" i ON i.id = v.interval_id
 WHERE i.line_id = 'jp-東日本旅客鉄道-山手線' AND i.seq = 0
 ORDER BY v.seq;
```

## Files

- `scripts/build/build-rail-database.mjs` — CLI
- `scripts/build/rail-database/schema.sql` — the DDL, with the field notes
- `scripts/build/rail-database/load.mjs` — readers, joins and the writer
- `test/rail-database.test.mjs` — rebuilds it and counts every row back
  against the sources, then re-derives the two joins that are rules rather
  than copies
