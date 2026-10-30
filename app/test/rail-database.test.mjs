// The relational mirror (data/rail.db) is a lossless join of the published
// railway data, not a summary of it.
//
// Its whole value is that a query against it answers the same thing the JSON
// does — which lines call at a station, what that station is called in five
// languages, how long an interval is. A loader that silently dropped a country,
// a station row, or half a reading table would still produce a database that
// looks fine and answers wrong, and nothing in the app reads it, so nothing
// else would ever notice. So this suite rebuilds it and counts everything back
// against the sources, then checks the two joins that are actual RULES rather
// than copies: the name lookup order the frontend uses, and the station-number
// cross-reference between the solver data and the packages.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { buildDatabase } from "../scripts/build/rail-database/load.mjs";

const require = createRequire(import.meta.url);
const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { normalizeStationName } = require(path.join(APP_DIR, "shared/app-core.js"));

const COUNTRIES = [
  { code: "JP", slug: "jp", readings: "station-readings.json", sections: "rail-sections.json", stations: "stations.json" },
  { code: "TW", slug: "tw", readings: "station-readings-tw.json", sections: "rail-sections-tw.json", stations: "stations-tw.json" },
  { code: "HK", slug: "hk", readings: "station-readings-hk.json", sections: "rail-sections-hk.json", stations: "stations-hk.json" },
  { code: "KR", slug: "kr", readings: "station-readings-kr.json", sections: "rail-sections-kr.json", stations: "stations-kr.json" },
  { code: "MO", slug: "mo", readings: "station-readings-mo.json", sections: "rail-sections-mo.json", stations: "stations-mo.json" },
];

const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(APP_DIR, ...parts), "utf8"));

const sources = COUNTRIES.map((country) => ({
  ...country,
  pkg: readJson("public/rail", `${country.slug}-2025.json`),
  readingTable: readJson("data", country.readings),
  sections: readJson("data", country.sections).features,
  stations: readJson("data", country.stations).features,
}));

const outFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "rail-db-")),
  "rail.db",
);
buildDatabase({ outFile, geometry: true });
const db = new DatabaseSync(outFile, { readOnly: true });
const scalar = (sql, ...parameters) =>
  Object.values(db.prepare(sql).get(...parameters))[0];

test.after(() => {
  db.close();
  fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
});

test("the database is internally consistent", () => {
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(
    db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check),
    ["ok"],
  );
  assert.equal(scalar("SELECT COUNT(*) FROM country"), COUNTRIES.length);
});

test("every package row survives the load", () => {
  for (const { code, pkg } of sources) {
    const lines = pkg.lines;
    const stationRows = lines.reduce((sum, line) => sum + line.stations.length, 0);
    const intervals = lines.reduce((sum, line) => sum + line.segments.length, 0);
    const vertices = lines.reduce(
      (sum, line) => sum + line.segments.reduce((n, row) => n + row[2].length, 0),
      0,
    );
    const structure = lines.reduce((sum, line) => sum + (line.structure?.length || 0), 0);
    const stationCodes = new Set(lines.flatMap((line) => line.stations.map((row) => row[0])));

    assert.equal(scalar("SELECT COUNT(*) FROM line WHERE country_code = ?", code), lines.length);
    assert.equal(scalar("SELECT COUNT(*) FROM station WHERE country_code = ?", code), stationCodes.size);
    assert.equal(
      scalar("SELECT COUNT(*) FROM line_station ls JOIN line l ON l.id = ls.line_id WHERE l.country_code = ?", code),
      stationRows,
    );
    assert.equal(
      scalar('SELECT COUNT(*) FROM "interval" i JOIN line l ON l.id = i.line_id WHERE l.country_code = ?', code),
      intervals,
    );
    assert.equal(
      scalar(
        'SELECT COUNT(*) FROM interval_vertex v JOIN "interval" i ON i.id = v.interval_id JOIN line l ON l.id = i.line_id WHERE l.country_code = ?',
        code,
      ),
      vertices,
    );
    assert.equal(
      scalar("SELECT COUNT(*) FROM line_structure s JOIN line l ON l.id = s.line_id WHERE l.country_code = ?", code),
      structure,
    );
    assert.equal(
      scalar("SELECT COUNT(*) FROM lane WHERE country_code = ?", code),
      (pkg.lanes || []).length,
    );
  }
});

test("every solver row survives the load", () => {
  for (const { code, sections, stations } of sources) {
    assert.equal(scalar("SELECT COUNT(*) FROM source_section WHERE country_code = ?", code), sections.length);
    assert.equal(scalar("SELECT COUNT(*) FROM source_station WHERE country_code = ?", code), stations.length);
    assert.equal(
      scalar(
        "SELECT COUNT(*) FROM source_section_vertex v JOIN source_section s ON s.id = v.section_id WHERE s.country_code = ?",
        code,
      ),
      sections.reduce((sum, feature) => sum + feature.geometry.coordinates.length, 0),
    );
  }
});

test("the reading tables are mirrored without loss", () => {
  for (const { code, readingTable } of sources) {
    let expected = 0;
    for (const dictionary of [readingTable.byCode || {}, readingTable.byName || {}]) {
      for (const entry of Object.values(dictionary)) {
        // Fields the schema does not model would be a silent data loss.
        for (const [field, value] of Object.entries(entry)) {
          assert.ok(
            scalar("SELECT COUNT(*) FROM name_field WHERE field = ?", field) === 1,
            `${code}: unmodelled reading field ${field}`,
          );
          if (value) expected += 1;
        }
      }
    }
    assert.equal(scalar("SELECT COUNT(*) FROM station_name WHERE country_code = ?", code), expected);
  }
});

test("resolved station names follow the frontend's lookup order", () => {
  // i18n.js stationReading(): exact code, then the country tables' composite
  // "<lineId>:<stationCode>" key, then the normalized-name fallback.
  for (const { code, pkg, readingTable } of sources) {
    const byCode = readingTable.byCode || {};
    const byName = new Map(
      Object.entries(readingTable.byName || {}).map(([key, entry]) => [
        normalizeStationName(key),
        entry,
      ]),
    );
    let checked = 0;
    for (const line of pkg.lines) {
      line.stations.forEach((row, seq) => {
        const entry =
          byCode[row[0]] || byCode[`${line.id}:${row[0]}`] || byName.get(normalizeStationName(row[1]));
        if (!entry) return;
        for (const [field, value] of Object.entries(entry)) {
          if (!value) continue;
          const stored = db
            .prepare("SELECT value FROM line_station_name WHERE line_id = ? AND seq = ? AND field = ?")
            .get(line.id, seq, field);
          assert.equal(stored?.value, value, `${code} ${line.id}#${seq} ${field}`);
          checked += 1;
        }
      });
    }
    assert.ok(checked > 0, `${code}: nothing to check`);
  }
});

test("station numbers cross-reference the packages", () => {
  // source_station.group_code is the package's station code; every row that
  // names one the package still ships must resolve to that station.
  const rows = db
    .prepare("SELECT country_code, group_code, station_id FROM source_station")
    .all();
  const packageCodes = new Map(
    sources.map(({ code, pkg }) => [
      code,
      new Set(pkg.lines.flatMap((line) => line.stations.map((row) => row[0]))),
    ]),
  );
  for (const row of rows) {
    const known = packageCodes.get(row.country_code).has(row.group_code);
    assert.equal(
      row.station_id !== null,
      known,
      `${row.country_code} ${row.group_code}: link ${row.station_id} vs package ${known}`,
    );
  }
  for (const [code, codes] of packageCodes) {
    const linked = scalar(
      "SELECT COUNT(DISTINCT station_id) FROM source_station WHERE country_code = ? AND station_id IS NOT NULL",
      code,
    );
    assert.ok(linked > 0 && linked <= codes.size);
  }
});

test("line measures and interval lengths agree", () => {
  const mismatches = db
    .prepare(
      `SELECT l.id, l.length_km, SUM(i.length_km) summed
         FROM line l JOIN "interval" i ON i.line_id = l.id
        GROUP BY l.id
       HAVING ABS(l.length_km - summed) > 1e-6`,
    )
    .all();
  assert.deepEqual(mismatches, []);

  // The last station's measure is the line's length, in metres.
  const ends = db
    .prepare(
      `SELECT l.id, l.length_km, MAX(ls.measure_m) last_m, l.is_loop
         FROM line l JOIN line_station ls ON ls.line_id = l.id
        GROUP BY l.id`,
    )
    .all();
  for (const row of ends) {
    // A loop's last station still has one interval left to close the ring.
    const expected = row.is_loop ? null : row.length_km * 1000;
    if (expected === null) continue;
    assert.ok(
      Math.abs(row.last_m - expected) < 1e-3,
      `${row.id}: last measure ${row.last_m} vs ${expected}`,
    );
  }
});

test("badge artwork is reachable from the data that describes it", () => {
  // The manifests name their artwork by bare filename because they sit in the
  // directory they describe. Resolving that to a web path is what makes the
  // provenance joinable at all — without `asset_path`, `asset` is
  // `q1007890.svg` and `logo_asset.path` is
  // `/rail/operator-logos/jp/q1007890.svg`, and nothing bridges them.
  const named = scalar(
    "SELECT COUNT(*) FROM operator_logo_manifest WHERE asset IS NOT NULL AND asset <> ''",
  );
  assert.ok(named > 80, `expected the jp manifest to name artwork, got ${named}`);
  assert.equal(
    scalar(`SELECT COUNT(*) FROM operator_logo_manifest m
              JOIN logo_asset a ON a.path = m.asset_path`),
    named,
    "every manifest row that names artwork must resolve to a logo_asset row",
  );

  // `source` is the artwork a badge was derived from: shipped, described by a
  // manifest, and never requested by the site. It is in the database because
  // it is the only reason a drawn badge's licence can be traced.
  assert.ok(scalar("SELECT COUNT(*) FROM logo_asset WHERE kind = 'source'") > 0);
  assert.equal(
    scalar("SELECT COUNT(*) FROM logo_asset WHERE kind NOT IN ('line','operator','badge','source')"),
    0,
  );

  // Nothing points at a badge this database does not know about.
  assert.equal(
    scalar(`SELECT COUNT(*) FROM line l
             WHERE l.badge_path IS NOT NULL AND l.badge_path <> ''
               AND NOT EXISTS (SELECT 1 FROM logo_asset a WHERE a.path = l.badge_path)`),
    0,
  );

  // The view covers every line that draws something, and no others.
  assert.equal(
    scalar("SELECT COUNT(*) FROM badge_provenance"),
    scalar("SELECT COUNT(*) FROM line WHERE badge_path IS NOT NULL AND badge_path <> ''"),
  );

  // A per-line credit may only answer for a line drawing its OWN art. A line
  // that fell back to its operator's mark is not covered by a credit written
  // for artwork it is not drawing.
  assert.equal(
    scalar(`SELECT COUNT(*) FROM badge_provenance
             WHERE line_license IS NOT NULL AND badge_kind <> 'line'`),
    0,
  );
});

test("branding resolves through the module that owns the rules", () => {
  // Every badge a row points at is a file the site actually ships.
  assert.equal(scalar("SELECT COUNT(*) FROM logo_asset WHERE file_exists = 0"), 0);
  assert.ok(scalar("SELECT COUNT(*) FROM operator_alias") > 50);
  assert.equal(
    db.prepare("SELECT display_label FROM operator WHERE name = ?").get("東日本旅客鉄道")?.display_label,
    "JR東日本",
  );
});
