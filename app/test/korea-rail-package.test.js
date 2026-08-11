"use strict";

// Quality gate for the Korean package (see public/rail/kr-2025.sources.md).
// Korea is the one region whose track geometry is OSM-derived while every
// station identity comes from official files, so the invariants that matter
// are: the compact-v1 shape, station anchors sitting ON the drawn line, short
// snap stubs, no micro-kinks left by the grooming pass, and — the modelling
// decision that keeps the mileage honest — no service brand drawn on top of
// the railway it runs over.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const RailNetwork = require("../public/rail-network.js");

const APP_DIR = path.join(__dirname, "..");
const read = (relative) =>
  JSON.parse(fs.readFileSync(path.join(APP_DIR, relative), "utf8"));

const M_PER_DEG_LAT = 110_540;
const metres = (a, b) =>
  Math.hypot((a[0] - b[0]) * 88_800, (a[1] - b[1]) * M_PER_DEG_LAT);
const polylineMetres = (coords) =>
  coords.slice(1).reduce((sum, point, i) => sum + metres(coords[i], point), 0);

function turnDegrees(a, b, c) {
  const v1 = [(b[0] - a[0]) * 88_800, (b[1] - a[1]) * M_PER_DEG_LAT];
  const v2 = [(c[0] - b[0]) * 88_800, (c[1] - b[1]) * M_PER_DEG_LAT];
  const n1 = Math.hypot(...v1);
  const n2 = Math.hypot(...v2);
  if (!n1 || !n2) return 0;
  const cos = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

test("Korean package matches compact-v1 and its characterized network", () => {
  const pkg = read("public/rail/kr-2025.json");
  assert.equal(pkg.format, "compact-v1");
  assert.equal(pkg.country, "KR");
  assert.equal(pkg.crs, "WGS84");
  assert.ok(pkg.lines.length >= 70, `only ${pkg.lines.length} lines`);
  for (const line of pkg.lines) {
    assert.match(line.id, /^kr-/);
    assert.ok(line.name && line.operator);
    assert.match(line.color, /^#[0-9A-F]{6}$/i);
    assert.ok(line.stations.length >= 2);
    for (const row of line.stations) assert.match(row[0], /^kr-official-/);
    assert.equal(line.segments.length, line.stations.length - 1);
    for (let index = 0; index < line.segments.length; index += 1) {
      const geometry = line.segments[index][2];
      assert.ok(geometry.length >= 2, `${line.id} segment ${index} is empty`);
      // Contract: segment i runs station i -> station i+1 with shared endpoints.
      assert.deepEqual(geometry[0], line.stations[index].slice(2, 4));
      assert.deepEqual(geometry.at(-1), line.stations[index + 1].slice(2, 4));
    }
  }
  assert.equal(pkg.geometrySource.osmSources, 1);
  assert.ok(pkg.geometrySource.providers.length >= 2);
  assert.ok(Object.keys(pkg.geometrySource.sourceSha256).length >= 2);

  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  assert.equal(network.lineById.size, pkg.lines.length);
  assert.ok(network.segments.features.every((f) => f.geometry.type !== "Point"));
});

test("Korean track geometry carries no micro kinks", () => {
  const pkg = read("public/rail/kr-2025.json");
  let kinks = 0;
  for (const line of pkg.lines) {
    for (const segment of line.segments) {
      const coords = segment[2];
      for (let i = 1; i < coords.length - 1; i += 1) {
        const turn = turnDegrees(coords[i - 1], coords[i], coords[i + 1]);
        const edge = Math.min(
          metres(coords[i - 1], coords[i]),
          metres(coords[i], coords[i + 1]),
        );
        if (turn > 60 && edge < 40) kinks += 1;
      }
    }
  }
  assert.equal(kinks, 0, `${kinks} micro kinks survived the grooming pass`);
});

test("Korean solver datasets answer the shared country-neutral schema", () => {
  const sections = read("data/rail-sections-kr.json");
  const stations = read("data/stations-kr.json");
  assert.equal(sections.type, "FeatureCollection");
  assert.ok(sections.features.length >= 1000);
  const institutions = new Set();
  for (const feature of sections.features) {
    const p = feature.properties;
    assert.ok(p.line_name && p.operator);
    assert.match(p.institution_type_code, /^[1-4]$/);
    assert.match(p.railway_class_code, /^(11|12|21|31)$/);
    institutions.add(p.institution_type_code);
    assert.equal(feature.geometry.type, "LineString");
  }
  // High speed, KORAIL conventional and urban rail all have to be present or
  // the statistics buckets would silently collapse into one row.
  for (const code of ["1", "2", "3"]) assert.ok(institutions.has(code), `no institution ${code}`);

  assert.ok(stations.features.length >= 1000);
  for (const feature of stations.features) {
    const p = feature.properties;
    assert.ok(p.station_name);
    assert.match(p.n02_station_code, /^KR-/);
    assert.match(p.n02_group_code, /^kr-official-/);
    assert.equal(p.display_point.length, 2);
    // Station features are SHORT on-track snap stubs. A full inter-station
    // interval here drags the solver's snap candidates kilometres away.
    const stub = polylineMetres(feature.geometry.coordinates);
    assert.ok(stub <= 250, `${p.station_name} stub is ${stub.toFixed(0)} m`);
  }
});

test("Korean station codes are unique per line and stable identifiers", () => {
  const stations = read("data/stations-kr.json");
  const seen = new Map();
  for (const feature of stations.features) {
    const p = feature.properties;
    const key = `${p.line_name}|${p.n02_station_code}`;
    assert.ok(!seen.has(key), `duplicate station code ${p.n02_station_code} on ${p.line_name}`);
    seen.set(key, true);
  }
});

test("Korean readings expose 한자 and English without echoing the Hangul", () => {
  const readings = read("data/station-readings-kr.json");
  assert.equal(readings.country, "KR");
  assert.ok(readings.stats.byCode > 1000);
  for (const [name, value] of Object.entries(readings.byName)) {
    assert.equal(value.name, name);
    // A reading equal to the base name is dropped by the display layer, so an
    // empty 한자 is correct for native-Korean names — a Hangul echo is not.
    assert.notEqual(value.zh_Hant, name, `${name} echoes its own name as 한자`);
  }
  assert.equal(readings.byName["서울"].zh_Hant, "首爾");
  assert.equal(readings.byName["서울"].zh_Hans, "首尔");
});

test("no Korean service brand is drawn on top of the railway it runs over", () => {
  const pkg = read("public/rail/kr-2025.json");
  const names = new Set(pkg.lines.map((line) => line.name));
  for (const brand of [
    "수도권 전철 1호선",
    "수도권 전철 3호선",
    "수도권 전철 4호선",
    "경의·중앙선",
    "수인·분당선",
    "동해선 광역전철",
  ]) {
    assert.ok(!names.has(brand), `${brand} is a service over existing track`);
  }
  // The railways those services run on ARE published.
  for (const railway of ["경부선", "경인선", "경원선", "중앙선", "분당선", "수인선"]) {
    assert.ok(names.has(railway), `missing railway ${railway}`);
  }
  // 인천공항 자기부상철도 has been suspended since 2023-09.
  assert.ok(!names.has("인천공항 자기부상철도"));
});

test("Korean sample store resolves against the Korean station dataset", () => {
  const store = read("data/train-store-kr.json");
  const stations = read("data/stations-kr.json");
  const codes = new Set(
    stations.features.map((feature) => feature.properties.n02_station_code),
  );
  assert.equal(store.schema_version, "1.3");
  assert.ok(store.trains.length >= 1);
  for (const train of store.trains) {
    assert.ok(train.stops.length >= 2);
    for (const stop of train.stops) {
      assert.ok(codes.has(stop.n02_station_code), `unknown stop code ${stop.n02_station_code}`);
    }
    for (const section of train.route_sections) {
      assert.ok(codes.has(section.from_n02_station_code));
      assert.ok(codes.has(section.to_n02_station_code));
    }
  }
});
