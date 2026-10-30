-- ===========================================================================
-- rail.db — relational mirror of the PUBLISHED railway data
-- ===========================================================================
-- Built by scripts/build/build-rail-database.mjs (npm run build:db) from, in
-- order of authority:
--
--   public/rail/<c>-2025.json      the display packages (compact-v1)
--   data/station-readings*.json    the multilingual station-name tables
--   data/rail-sections*.json       the route solver's section graph
--   data/stations*.json            the route solver's station/platform table
--   public/rail/logo-credits.json  line-badge attribution
--   public/rail/operator-logos/*/manifest.json
--   public/app-operator-branding.js   operator label + badge resolution rules
--
-- This file is DERIVED. Nothing here is a source of truth: every row can be
-- reproduced from the files above, and the builder rewrites the database from
-- scratch on every run. Edit the sources, then rebuild — never the other way.
--
-- Two rulers appear in this schema and they are NOT interchangeable:
--   * `seq`      — a station's ordinal on its line (0-based). Survives every
--                  display pass, which is why service spans are stated in it.
--   * `*_m`      — metres along the line, accumulated from the package's own
--                  interval lengths. `line_structure` and `lane` are surveyed
--                  against this ruler; the drawn geometry is groomed after the
--                  fact, so a metre offset is an approximation on screen.
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- ─────────────────────────── build provenance ───────────────────────────

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE country (
  code                     TEXT PRIMARY KEY,   -- 'JP' | 'TW' | 'HK' | 'KR' | 'MO'
  slug                     TEXT NOT NULL UNIQUE, -- file prefix: 'jp' …
  package_file             TEXT NOT NULL,
  package_format           TEXT NOT NULL,      -- 'compact-v1'
  package_version          TEXT NOT NULL,
  package_generated_at     TEXT,
  crs                      TEXT,
  official_only            INTEGER,            -- geometrySource.officialOnly
  license                  TEXT,
  authority                TEXT,
  method                   TEXT,
  sources_doc              TEXT,               -- public/rail/<c>-2025.sources.md
  readings_file            TEXT,
  readings_revision        TEXT,               -- readings officialRevision
  readings_package_version TEXT,
  line_count               INTEGER NOT NULL,
  station_count            INTEGER NOT NULL,   -- distinct station codes
  interval_count           INTEGER NOT NULL,
  vertex_count             INTEGER NOT NULL,
  length_km                REAL    NOT NULL
);

-- The UI languages a country's reading table declares, in its own order.
CREATE TABLE country_language (
  country_code TEXT    NOT NULL REFERENCES country(code),
  ord          INTEGER NOT NULL,
  lang         TEXT    NOT NULL,
  PRIMARY KEY (country_code, lang)
);

-- Flattened geometrySource / attributeSources / readings.sources blocks: one
-- row per provenance statement, so "where did this attribute come from" is a
-- query rather than a JSON dig.
CREATE TABLE data_source (
  id           INTEGER PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES country(code),
  category     TEXT NOT NULL,  -- 'geometry' | 'geometry_provider' | 'attribute' | 'reading'
  field        TEXT,           -- the key inside that block, when it has one
  value        TEXT NOT NULL
);
CREATE INDEX data_source_country ON data_source(country_code, category);

-- ───────────────────────── reference vocabularies ─────────────────────────

-- N02_002 事業者種別 — the class of the operator, shared by all five countries
-- (the non-Japanese builders assign the same code space on purpose, so route
-- policies and mileage statistics stay country-generic).
CREATE TABLE institution_type (
  code     TEXT PRIMARY KEY,
  label_ja TEXT NOT NULL,
  label_zh TEXT NOT NULL
);

-- N02_001 鉄道区分 — the class of the track. `country_code` is '*' for the
-- codes N02 itself defines; a country row records a code this project assigns
-- beyond N02 (31), which does NOT mean the same thing in Taiwan and Korea.
CREATE TABLE railway_class (
  code         TEXT NOT NULL,
  country_code TEXT NOT NULL,
  label        TEXT NOT NULL,
  note         TEXT,
  PRIMARY KEY (code, country_code)
);

CREATE TABLE roma_source (          -- compact-v1 station row field 6
  code INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE structure_kind (       -- compact-v1 structure row field 3
  code INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE service_status (       -- compact-v1 serviceSpans row field 3
  code      INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  suspended INTEGER NOT NULL        -- 1 = no passenger train runs on the track
);

-- The name fields the reading tables carry, mapped onto language tags. Keeping
-- the raw field name as the key is deliberate: `kana`, `katakana` and `romaji`
-- are three renderings of ONE language and would collide under a bare tag.
CREATE TABLE name_field (
  field       TEXT PRIMARY KEY,
  bcp47       TEXT,
  description TEXT NOT NULL
);

-- ────────────────────────────── operators ──────────────────────────────

CREATE TABLE operator (
  id            INTEGER PRIMARY KEY,
  country_code  TEXT NOT NULL REFERENCES country(code),
  name          TEXT NOT NULL,   -- the package's official operator name
  short_name    TEXT,            -- package `operatorShort` (Japan only)
  display_label TEXT NOT NULL,   -- RailOperatorBranding.companyLabel()
  logo_path     TEXT,            -- RailOperatorBranding.operatorLogo()
  line_count    INTEGER NOT NULL,
  UNIQUE (country_code, name)
);

-- Every spelling of a company that resolves to one passenger-facing label.
-- Mirrors the four dictionaries in public/app-operator-branding.js, which is
-- what normalizes imported records whose company field is written freehand.
CREATE TABLE operator_alias (
  id    INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,           -- 'JP' | 'TW' | 'HK' | 'MO'
  alias TEXT NOT NULL,
  label TEXT NOT NULL,
  UNIQUE (scope, alias)
);

-- ──────────────────────────────── lines ────────────────────────────────

CREATE TABLE line (
  id                    TEXT PRIMARY KEY,   -- package line id, unique across countries
  country_code          TEXT NOT NULL REFERENCES country(code),
  operator_id           INTEGER NOT NULL REFERENCES operator(id),
  name                  TEXT NOT NULL,
  name_norm             TEXT,               -- package `nameNorm`
  name_roma             TEXT,
  line_code             TEXT,               -- 路線記号 (package `lineCode`)
  rank                  INTEGER NOT NULL,   -- 1 = trunk … 5, drives label/zoom order
  kind                  TEXT,               -- 'jr' | 'private' | 'third_sector' | …
  color                 TEXT NOT NULL,      -- light-theme stroke
  color_dark            TEXT,
  color_reference       TEXT,               -- the operator's published colour
  color_source          TEXT,
  color_policy          TEXT,
  label_policy          TEXT,
  railway_identity      TEXT,               -- lines sharing this are one railway
  railway_class_code    TEXT,               -- see railway_class; joined from the solver data
  institution_type_code TEXT,               -- see institution_type
  class_source          TEXT,               -- how those two codes were joined
  is_hsr                INTEGER NOT NULL DEFAULT 0,
  is_loop               INTEGER NOT NULL DEFAULT 0,
  service_status        TEXT,
  station_count         INTEGER NOT NULL,
  interval_count        INTEGER NOT NULL,
  vertex_count          INTEGER NOT NULL,
  length_km             REAL    NOT NULL,   -- sum of its interval lengths
  logo_asset            TEXT,               -- package badge, resolved to a web path
  badge_path            TEXT,               -- RailOperatorBranding.logoForLine()
  badge_dark_matte      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX line_country  ON line(country_code);
CREATE INDEX line_operator ON line(operator_id);
CREATE INDEX line_name_idx ON line(name);
CREATE INDEX line_identity ON line(railway_identity);

-- Japan's paired alignments: two package lines that are the two DIRECTIONS of
-- one railway, drawn on their own surveyed track.
CREATE TABLE line_alignment (
  line_id      TEXT PRIMARY KEY REFERENCES line(id),
  alignment_of TEXT,          -- the parent line id (not an FK: may name a part id)
  role         TEXT,
  direction    TEXT,          -- 'up' | 'down' | 'unassigned'
  source       TEXT,
  split_source TEXT
);

CREATE TABLE line_alignment_pair (
  id           INTEGER PRIMARY KEY,
  line_id      TEXT NOT NULL REFERENCES line(id),
  with_line_id TEXT NOT NULL, -- may carry a `-pN` part suffix, so not an FK
  from_station TEXT,
  to_station   TEXT,
  direction    TEXT,
  source       TEXT
);
CREATE INDEX line_alignment_pair_line ON line_alignment_pair(line_id);

-- Stretches where the track carries no ordinary passenger service. Stated in
-- STATION ORDINALS, never metres — see the header note.
CREATE TABLE line_service_span (
  id          INTEGER PRIMARY KEY,
  line_id     TEXT NOT NULL REFERENCES line(id),
  from_seq    INTEGER NOT NULL,
  to_seq      INTEGER NOT NULL,
  status_code INTEGER NOT NULL REFERENCES service_status(code)
);
CREATE INDEX line_service_span_line ON line_service_span(line_id);

-- Hong Kong: intervals whose surveyed centre-line is missing from the source,
-- recorded with the evidence rather than silently drawn straight.
CREATE TABLE line_extra_segment (
  id       INTEGER PRIMARY KEY,
  line_id  TEXT NOT NULL REFERENCES line(id),
  from_seq INTEGER NOT NULL,
  to_seq   INTEGER NOT NULL,
  status   TEXT,
  evidence TEXT
);
CREATE INDEX line_extra_segment_line ON line_extra_segment(line_id);

-- Switchback stub track that a line reverses onto (阿里山線's zigzag).
CREATE TABLE line_reversal_tail (
  line_id TEXT    NOT NULL REFERENCES line(id),
  seq     INTEGER NOT NULL,
  lon     REAL    NOT NULL,
  lat     REAL    NOT NULL,
  PRIMARY KEY (line_id, seq)
);

-- Tunnel / bridge runs, in metres along the line.
CREATE TABLE line_structure (
  id        INTEGER PRIMARY KEY,
  line_id   TEXT NOT NULL REFERENCES line(id),
  start_m   REAL NOT NULL,
  end_m     REAL NOT NULL,
  kind_code INTEGER NOT NULL REFERENCES structure_kind(code),
  layer     INTEGER NOT NULL
);
CREATE INDEX line_structure_line ON line_structure(line_id);

-- Screen-space lane assignment for lines sharing a corridor. A DERIVED table
-- in the package too (build-parallel-corridors.mjs); regenerate it there
-- whenever geometry moves, then rebuild this database.
CREATE TABLE lane (
  id           INTEGER PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES country(code),
  line_id      TEXT NOT NULL REFERENCES line(id),
  part_index   INTEGER NOT NULL,   -- which drawn part of the line
  from_m       REAL NOT NULL,
  to_m         REAL NOT NULL,
  lane         REAL NOT NULL       -- signed lane offset, ±0.5, ±1, …
);
CREATE INDEX lane_line ON lane(line_id);

-- ─────────────────────────────── stations ───────────────────────────────

-- One row per PHYSICAL station: the package's station group code, deduplicated
-- across the lines that call there. `name`, `lon` and `lat` are summaries — the
-- most common spelling and the mean of the per-line anchors. Where a station's
-- lines disagree (26 codes in Taiwan, 27 in Korea carry more than one spelling)
-- `name_variant_count` is above 1 and `line_station` holds the authority.
CREATE TABLE station (
  id                 INTEGER PRIMARY KEY,
  country_code       TEXT NOT NULL REFERENCES country(code),
  code               TEXT NOT NULL,  -- package station group code
  name               TEXT NOT NULL,
  name_norm          TEXT NOT NULL,  -- AppCore.normalizeStationName(name)
  name_roma          TEXT,
  lon                REAL NOT NULL,
  lat                REAL NOT NULL,
  line_count         INTEGER NOT NULL,
  name_variant_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE (country_code, code)
);
CREATE INDEX station_name_norm ON station(country_code, name_norm);

-- A station AS IT SITS ON ONE LINE — the authoritative row. Each line anchors
-- the station on its own track, so the coordinates differ per line by design.
CREATE TABLE line_station (
  line_id     TEXT    NOT NULL REFERENCES line(id),
  seq         INTEGER NOT NULL,   -- 0-based ordinal along the line
  station_id  INTEGER NOT NULL REFERENCES station(id),
  name        TEXT    NOT NULL,
  name_roma   TEXT,
  roma_source INTEGER REFERENCES roma_source(code),
  lon         REAL    NOT NULL,
  lat         REAL    NOT NULL,
  measure_m   REAL    NOT NULL,   -- metres along the line; first station = 0
  is_terminal INTEGER NOT NULL,
  PRIMARY KEY (line_id, seq)
);
CREATE UNIQUE INDEX line_station_once ON line_station(line_id, station_id);
CREATE INDEX line_station_station ON line_station(station_id);

-- ────────────────────── intervals and their geometry ──────────────────────

CREATE TABLE "interval" (
  id                  INTEGER PRIMARY KEY,
  line_id             TEXT    NOT NULL REFERENCES line(id),
  seq                 INTEGER NOT NULL,   -- same ordinal as its from-station
  from_station_id     INTEGER NOT NULL REFERENCES station(id),
  to_station_id       INTEGER NOT NULL REFERENCES station(id),
  length_km           REAL    NOT NULL,
  start_m             REAL    NOT NULL,
  end_m               REAL    NOT NULL,
  -- compact-v1 omits an interval's first vertex when it repeats the previous
  -- interval's last one. 1 = omitted in the package; the vertex rows below are
  -- always complete, so a consumer never has to re-implement that rule.
  shares_start_vertex INTEGER NOT NULL,
  vertex_count        INTEGER NOT NULL,
  UNIQUE (line_id, seq)
);
CREATE INDEX interval_from ON "interval"(from_station_id);
CREATE INDEX interval_to   ON "interval"(to_station_id);

CREATE TABLE interval_vertex (
  interval_id INTEGER NOT NULL REFERENCES "interval"(id),
  seq         INTEGER NOT NULL,
  lon         REAL    NOT NULL,
  lat         REAL    NOT NULL,
  PRIMARY KEY (interval_id, seq)
) WITHOUT ROWID;

-- ──────────────────────── multilingual station names ────────────────────────

-- Raw mirror of data/station-readings*.json, one row per (key, field) pair.
-- Empty values are not stored — a missing row IS "no official translation".
--   key_type 'code'         Japan: keyed by the N02 station code
--   key_type 'line_station' TW/HK/KR/MO: keyed by "<lineId>:<stationCode>",
--                           because those tables localize per line-station
--   key_type 'name'         the byName fallback, keyed by station name
CREATE TABLE station_name (
  id           INTEGER PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES country(code),
  key_type     TEXT NOT NULL,
  key          TEXT NOT NULL,
  key_norm     TEXT NOT NULL,   -- AppCore.normalizeStationName(key)
  field        TEXT NOT NULL REFERENCES name_field(field),
  value        TEXT NOT NULL,
  UNIQUE (country_code, key_type, key, field)
);
CREATE INDEX station_name_lookup ON station_name(country_code, key_type, key);
CREATE INDEX station_name_key_norm ON station_name(country_code, key_type, key_norm);

-- The same table RESOLVED onto every line-station, applying the frontend's own
-- lookup order (i18n.js stationReading): exact code, then "<lineId>:<code>",
-- then the normalized-name fallback. `source` records which one answered, and
-- 'package' marks a romaji that came from the package station row rather than
-- from a reading table.
CREATE TABLE line_station_name (
  line_id TEXT    NOT NULL,
  seq     INTEGER NOT NULL,
  field   TEXT    NOT NULL REFERENCES name_field(field),
  value   TEXT    NOT NULL,
  source  TEXT    NOT NULL,
  PRIMARY KEY (line_id, seq, field),
  FOREIGN KEY (line_id, seq) REFERENCES line_station(line_id, seq)
);

-- ──────────────── the route solver's source layer (as published) ────────────────
-- Japan's sections are the N02 survey itself — 21,933 features that the display
-- package cut 9,568 station intervals out of, so this is NOT a copy of the
-- package. For the other four countries the solver sections are regenerated
-- from their package and match it interval for interval.

CREATE TABLE source_section (
  id                    INTEGER PRIMARY KEY,
  country_code          TEXT    NOT NULL REFERENCES country(code),
  ord                   INTEGER NOT NULL,   -- feature index in the source file
  line_name             TEXT    NOT NULL,
  operator              TEXT    NOT NULL,
  railway_class_code    TEXT    NOT NULL,
  institution_type_code TEXT    NOT NULL,
  vertex_count          INTEGER NOT NULL,
  UNIQUE (country_code, ord)
);
CREATE INDEX source_section_line ON source_section(country_code, line_name, operator);

CREATE TABLE source_section_vertex (
  section_id INTEGER NOT NULL REFERENCES source_section(id),
  seq        INTEGER NOT NULL,
  lon        REAL    NOT NULL,
  lat        REAL    NOT NULL,
  PRIMARY KEY (section_id, seq)
) WITHOUT ROWID;

-- The station-number cross-reference. `station_code` is what an itinerary
-- record and a route section cite; `group_code` is what the display package
-- calls the same station. In Japan they are N02_005c and N02_005g and differ
-- for 1,146 of 10,233 platform features — a platform code versus the station
-- it belongs to.
CREATE TABLE source_station (
  id                    INTEGER PRIMARY KEY,
  country_code          TEXT    NOT NULL REFERENCES country(code),
  ord                   INTEGER NOT NULL,
  station_code          TEXT    NOT NULL,
  group_code            TEXT    NOT NULL,
  station_id            INTEGER REFERENCES station(id),  -- NULL = not in the package
  name                  TEXT    NOT NULL,
  line_name             TEXT    NOT NULL,
  operator              TEXT    NOT NULL,
  railway_class_code    TEXT    NOT NULL,
  institution_type_code TEXT    NOT NULL,
  display_lon           REAL,
  display_lat           REAL,
  vertex_count          INTEGER NOT NULL,
  UNIQUE (country_code, ord)
);
CREATE INDEX source_station_code  ON source_station(country_code, station_code);
CREATE INDEX source_station_group ON source_station(country_code, group_code);
CREATE INDEX source_station_link  ON source_station(station_id);

-- The platform centre-line each station anchor was measured from.
CREATE TABLE source_station_vertex (
  source_station_id INTEGER NOT NULL REFERENCES source_station(id),
  seq               INTEGER NOT NULL,
  lon               REAL    NOT NULL,
  lat               REAL    NOT NULL,
  PRIMARY KEY (source_station_id, seq)
) WITHOUT ROWID;

-- ────────────────────────────── badge assets ──────────────────────────────

-- Every badge file some row in this database points at, checked against the
-- shipped artwork. It is a table of REFERENCED assets, not an inventory of the
-- directory: a file nothing points at is not railway data, it is a file.
--
--   'line'      the package's own art for one line   (line.logo_asset)
--   'operator'  the mark a whole operator draws      (operator.logo_path)
--   'badge'     the per-line override table          (line.badge_path)
--   'source'    the artwork a badge was DERIVED from — named by
--               operator_logo_manifest.asset, never requested by the site,
--               and the only reason its licence can be traced at all.
CREATE TABLE logo_asset (
  path        TEXT PRIMARY KEY,   -- web path as the frontend requests it
  kind        TEXT NOT NULL,      -- 'line' | 'operator' | 'badge' | 'source'
  file_exists INTEGER NOT NULL,
  byte_size   INTEGER
);

CREATE TABLE logo_credit (
  line_id    TEXT PRIMARY KEY,    -- not an FK: credits outlive renamed lines
  source_url TEXT,
  license    TEXT
);

CREATE TABLE operator_logo_manifest (
  id                  INTEGER PRIMARY KEY,
  manifest            TEXT NOT NULL,   -- 'jp' | 'jp-badges'
  operator            TEXT NOT NULL,
  lines_without_badge INTEGER,
  article_title       TEXT,
  entity_id           TEXT,            -- Wikidata Q-id
  logo_file           TEXT,
  asset               TEXT,            -- bare filename, as the manifest writes it
  -- `asset` resolved against the manifest's own directory, so the provenance
  -- in this row can actually be joined to the file it describes. Without it
  -- the two sat in the same database with no way to get from one to the other:
  -- `asset` is `q1007890.svg` and `logo_asset.path` is
  -- `/rail/operator-logos/jp/q1007890.svg`, and no join can bridge that.
  asset_path          TEXT REFERENCES logo_asset(path),
  source_type         TEXT,
  source_page         TEXT,
  license             TEXT,
  license_url         TEXT,
  status              TEXT
);
CREATE INDEX operator_logo_manifest_operator ON operator_logo_manifest(operator);
CREATE INDEX operator_logo_manifest_asset_path ON operator_logo_manifest(asset_path);

-- ────────────────────────────────── views ──────────────────────────────────

-- Line names as a language table. Derived, not stored: `nameRoma` IS the
-- line's English name and `name` is its name in the country's own language.
CREATE VIEW line_name AS
  SELECT id AS line_id, country_code,
         CASE country_code WHEN 'JP' THEN 'ja' WHEN 'KR' THEN 'ko'
                           ELSE 'zh-Hant' END AS lang,
         name AS value, 'package.name' AS source
    FROM line
  UNION ALL
  SELECT id, country_code, 'en', name_roma, 'package.nameRoma'
    FROM line WHERE name_roma IS NOT NULL AND name_roma <> '';

-- One row per line-station with every resolved name pivoted into a column.
CREATE VIEW station_name_wide AS
  SELECT ls.line_id,
         ls.seq,
         s.country_code,
         s.code AS station_code,
         ls.name AS base_name,
         MAX(CASE WHEN n.field = 'name'     THEN n.value END) AS official_name,
         MAX(CASE WHEN n.field = 'kana'     THEN n.value END) AS kana,
         MAX(CASE WHEN n.field = 'katakana' THEN n.value END) AS katakana,
         MAX(CASE WHEN n.field = 'romaji'   THEN n.value END) AS romaji,
         MAX(CASE WHEN n.field = 'zh_Hant'  THEN n.value END) AS zh_hant,
         MAX(CASE WHEN n.field = 'zh_Hans'  THEN n.value END) AS zh_hans,
         MAX(CASE WHEN n.field = 'ja'       THEN n.value END) AS ja,
         MAX(CASE WHEN n.field = 'en'       THEN n.value END) AS en
    FROM line_station ls
    JOIN station s ON s.id = ls.station_id
    LEFT JOIN line_station_name n
           ON n.line_id = ls.line_id AND n.seq = ls.seq
   GROUP BY ls.line_id, ls.seq;

-- Every railway a station is served by, with the operator that runs it.
CREATE VIEW station_line AS
  SELECT s.id AS station_id, s.country_code, s.code AS station_code, s.name AS station_name,
         l.id AS line_id, l.name AS line_name, l.color, o.name AS operator,
         o.display_label AS operator_label, ls.seq, ls.measure_m
    FROM line_station ls
    JOIN station  s ON s.id = ls.station_id
    JOIN line     l ON l.id = ls.line_id
    JOIN operator o ON o.id = l.operator_id;

-- Station-to-station intervals with both names resolved, the shape most
-- reporting queries actually want.
CREATE VIEW interval_detail AS
  SELECT i.id, i.line_id, l.name AS line_name, l.country_code, i.seq,
         a.code AS from_code, a.name AS from_name,
         b.code AS to_code,   b.name AS to_name,
         i.length_km, i.start_m, i.end_m, i.vertex_count
    FROM "interval" i
    JOIN line    l ON l.id = i.line_id
    JOIN station a ON a.id = i.from_station_id
    JOIN station b ON b.id = i.to_station_id;

-- Every badge a line actually draws, with where the artwork came from.
--
-- The provenance sits in two different places and neither is reachable from a
-- badge path on its own, which is the whole reason this view exists:
--
--   * a line drawing its OWN art is credited per line, in `logo_credit`;
--   * a line drawing its OPERATOR's mark is credited per operator, in the `jp`
--     manifest — entity, source page, licence and URL.
--
-- The `jp-badges` manifest is deliberately NOT joined for provenance. Despite
-- the name it is a worklist, not a record: its rows carry an operator and a
-- `lines_without_badge` count and nothing else, so joining it would attach a
-- row with every provenance column null and make a badge look documented when
-- it is not.
--
-- `license` is the answer to "under what terms is this drawn", resolved from
-- whichever of the two applies. The per-line credit wins because it is the
-- narrower statement, and it is only consulted when the badge IS the line's
-- own art — a line that falls back to its operator's mark is not covered by a
-- credit written for artwork it is not drawing.
CREATE VIEW badge_provenance AS
  SELECT l.id                AS line_id,
         l.country_code,
         l.name              AS line_name,
         o.name              AS operator_name,
         l.badge_path,
         a.kind              AS badge_kind,
         a.byte_size         AS badge_bytes,
         l.badge_dark_matte,
         c.source_url        AS line_source_url,
         c.license           AS line_license,
         m.entity_id         AS operator_entity_id,
         m.source_page       AS operator_source_page,
         m.license           AS operator_license,
         m.license_url       AS operator_license_url,
         COALESCE(c.license, m.license) AS license
    FROM line l
    JOIN operator   o ON o.id = l.operator_id
    JOIN logo_asset a ON a.path = l.badge_path
    LEFT JOIN logo_credit c
           ON c.line_id = l.id AND l.badge_path = l.logo_asset
    LEFT JOIN operator_logo_manifest m
           ON m.manifest = 'jp' AND m.operator = o.name
   WHERE l.badge_path IS NOT NULL AND l.badge_path <> '';
