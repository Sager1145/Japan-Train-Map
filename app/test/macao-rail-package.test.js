"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const RailNetwork = require("../public/rail-network.js");
// The micro-kink gate's turn/length maths, shared with the Hong Kong suite.
// Dot-prefixed so a bare `node --test` does not collect the helper itself
// as a test file; the reasons the maths stays as-is are in its header.
const { turnDegrees, metres } = require("../scripts/lib/region-package-geometry.js");

const APP_DIR = path.join(__dirname, "..");
const read = (relative) =>
  JSON.parse(fs.readFileSync(path.join(APP_DIR, relative), "utf8"));

function assertCompactPackage(country, expectedLineCount) {
  const pkg = read(`public/rail/${country}-2025.json`);
  assert.equal(pkg.format, "compact-v1");
  assert.equal(pkg.country, country.toUpperCase());
  assert.equal(pkg.crs, "WGS84");
  assert.equal(pkg.lines.length, expectedLineCount);
  for (const line of pkg.lines) {
    assert.match(line.id, new RegExp(`^${country}-`));
    assert.ok(line.name);
    assert.ok(line.operator);
    assert.match(line.color, /^#[0-9A-F]{6}$/i);
    assert.ok(line.stations.length >= 2);
    for (const row of line.stations) {
      assert.match(row[0], new RegExp(`^${country}-official-`));
    }
    assert.equal(
      line.segments.length,
      line.isLoop ? line.stations.length : line.stations.length - 1,
    );
    for (let index = 0; index < line.segments.length; index += 1) {
      const geometry = line.segments[index][2];
      const next = (index + 1) % line.stations.length;
      assert.ok(geometry.length >= 2, `${line.id} segment ${index} has no route geometry`);
      assert.deepEqual(geometry[0], line.stations[index].slice(2, 4));
      assert.deepEqual(geometry.at(-1), line.stations[next].slice(2, 4));
    }
  }
  const segments = pkg.lines.flatMap((line) => line.segments);
  assert.ok(
    segments.filter((segment) => segment[2].length >= 3).length / segments.length > 0.9,
    `${country} unexpectedly regressed to straight station chords`,
  );
  assert.ok(pkg.geometrySource.providers.length >= 1);
  assert.ok(Object.keys(pkg.geometrySource.sourceSha256).length >= 1);
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  assert.equal(network.lineById.size, expectedLineCount);
  assert.equal(network.segments.features.length, pkg.lines.length);
  assert.ok(network.segments.features.every((feature) => feature.geometry.type === "LineString"));
  return pkg;
}

function maximumChordDeviationMetres(geometry) {
  const [start, end] = [geometry[0], geometry.at(-1)];
  const latitude = ((start[1] + end[1]) / 2) * Math.PI / 180;
  const scaleX = 111_320 * Math.cos(latitude);
  const dx = (end[0] - start[0]) * scaleX;
  const dy = (end[1] - start[1]) * 111_320;
  const chord = Math.hypot(dx, dy);
  return Math.max(...geometry.map((point) =>
    chord === 0 ? 0 : Math.abs(
      (point[0] - start[0]) * scaleX * dy -
      (point[1] - start[1]) * 111_320 * dx
    ) / chord
  ));
}

test("Macao package contains every operating LRT line", () => {
  const pkg = assertCompactPackage("mo", 3);
  assert.deepEqual(
    pkg.lines.map((line) => line.id),
    ["mo-mlm-taipa", "mo-mlm-spv", "mo-mlm-hengqin"],
  );
  assert.deepEqual(
    pkg.lines.map((line) => line.name),
    ["氹仔線", "石排灣線", "橫琴線"],
  );
  assert.ok(pkg.lines.every((line) => line.operator === "澳門輕軌"));
  assert.deepEqual(
    pkg.lines[0].stations.map((row) => row[1]),
    ["媽閣", "海洋", "馬會", "運動場", "排角", "路氹西", "蓮花", "協和醫院", "東亞運", "路氹東", "科大", "機場", "氹仔碼頭"],
  );
  assert.ok(maximumChordDeviationMetres(pkg.lines[2].segments[0][2]) > 200);
  assert.match(pkg.geometrySource.method, /DSCC LRT route polylines/);
});

test("Macao ships isolated solver, reading and sample datasets", () => {
  const sections = read("data/rail-sections-mo.json");
  const stations = read("data/stations-mo.json");
  const readings = read("data/station-readings-mo.json");
  const store = read("data/train-store-mo.json");
  const manifest = read("data/sample-data-mo/manifest.json");
  assert.ok(sections.features.length > 0);
  assert.ok(stations.features.length > 0);
  assert.equal(readings.country, "MO");
  assert.equal(store.trains.length, 1);
  assert.equal(manifest.total, 1);
  assert.match(store.trains[0].id, /^MO-SAMPLE-/);
  assert.equal(store.trains[0].company, "澳門輕軌");
  assert.deepEqual(store.trains[0].route_policy.preferred_operator_names, ["澳門輕軌"]);

  // Station codes stay the persisted pre-normalization spelling; group codes
  // share the package spelling. No Macao line name may collide with Hong
  // Kong's 輕鐵 stat-classifier prefix (see classifyHkSectionMask).
  for (const feature of stations.features) {
    assert.match(feature.properties.n02_station_code, /^[A-Z][A-Z0-9]*-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/);
    assert.match(feature.properties.n02_group_code, /^mo-official-/);
  }
  for (const feature of sections.features) {
    assert.ok(!String(feature.properties.line_name).startsWith("輕鐵"));
  }
  assert.equal(readings.byCode["MLM-TAIPA-MLM-BARRA"].en, "Barra");
  assert.ok(readings.byCode["mo-mlm-taipa:mo-official-mlm-barra"]);
});

// Same ridden-route coincidence gate as Hong Kong: precomputed sample
// sections must reuse the exact display-package segment coordinates.
test("Macao sample routes coincide exactly with the drawn network segments", () => {
  const pkg = read("public/rail/mo-2025.json");
  const part = read("data/sample-data-mo/part-000.json");
  const library = new Set();
  for (const line of pkg.lines) {
    for (const segment of line.segments) {
      library.add(JSON.stringify(segment[2]));
      library.add(JSON.stringify([...segment[2]].reverse()));
    }
  }
  assert.ok(part.route.features.length > 0);
  for (const feature of part.route.features) {
    assert.equal(feature.properties.route_choice, "official_interval_exact");
    assert.ok(
      library.has(JSON.stringify(feature.geometry.coordinates)),
      `${feature.properties.from}→${feature.properties.to} deviates from the package geometry`,
    );
  }
});

// Same display-quality gate as Hong Kong: smooth continuous polylines.
test("Macao line geometry is continuous and free of micro-kinks", () => {
  const pkg = read("public/rail/mo-2025.json");
  let kinks = 0;
  for (const line of pkg.lines) {
    const coords = [];
    for (const segment of line.segments)
      coords.push(...(coords.length ? segment[2].slice(1) : segment[2]));
    for (let i = 1; i < coords.length - 1; i += 1) {
      const turn = turnDegrees(coords[i - 1], coords[i], coords[i + 1]);
      if (
        turn > 60 &&
        (metres(coords[i - 1], coords[i]) < 40 || metres(coords[i], coords[i + 1]) < 40)
      )
        kinks += 1;
    }
  }
  assert.equal(kinks, 0, `network has ${kinks} micro-kinks`);
});

test("Macao station snap stubs stay short and on the running line", () => {
  const stations = read("data/stations-mo.json");
  for (const feature of stations.features) {
    const coords = feature.geometry.coordinates;
    assert.ok(coords.length >= 2);
    assert.deepEqual(coords[0], feature.properties.display_point);
    const latitude = (coords[0][1] * Math.PI) / 180;
    let length = 0;
    for (let i = 1; i < coords.length; i += 1) {
      length += Math.hypot(
        (coords[i][0] - coords[i - 1][0]) * 111_320 * Math.cos(latitude),
        (coords[i][1] - coords[i - 1][1]) * 111_320,
      );
    }
    assert.ok(
      length <= 250,
      `${feature.properties.n02_station_code} stub is ${Math.round(length)} m`,
    );
  }
});
