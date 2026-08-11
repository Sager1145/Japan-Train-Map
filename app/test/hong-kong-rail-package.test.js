"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const RailNetwork = require("../public/rail-network.js");

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
    // Display line ids follow the Japan/Taiwan convention: country-prefixed.
    assert.match(line.id, new RegExp(`^${country}-`));
    assert.ok(line.name);
    assert.ok(line.operator);
    assert.match(line.color, /^#[0-9A-F]{6}$/i);
    assert.ok(line.stations.length >= 2);
    for (const row of line.stations) {
      // Station group ids share the dataset spelling ({country}-official-…),
      // exactly as Taiwan's package groups match its solver dataset.
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
  // Provenance block follows the Taiwan package shape.
  assert.ok(pkg.geometrySource.providers.length >= 1);
  assert.ok(Object.keys(pkg.geometrySource.sourceSha256).length >= 1);
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  assert.equal(network.lineById.size, expectedLineCount);
  // One feature per line, plus one per lane where independent railways share
  // a corridor — the Light Rail routes and the two 東鐵綫 branches all run the
  // same tracks, so most of the network is laned.
  assert.equal(
    new Set(network.segments.features.map((feature) => feature.properties.lineId)).size,
    pkg.lines.length,
  );
  assert.ok(network.segments.features.length >= pkg.lines.length);
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

test("Hong Kong package contains the complete MTR and Light Rail display network", () => {
  const pkg = assertCompactPackage("hk", 27);
  const ids = new Set(pkg.lines.map((line) => line.id));
  for (const id of [
    "hk-mtr-ael", "hk-mtr-drl", "hk-mtr-eal-low", "hk-mtr-eal-lmc",
    "hk-mtr-isl", "hk-mtr-ktl", "hk-mtr-sil", "hk-mtr-tcl",
    "hk-mtr-tkl-poa", "hk-mtr-tkl-lhp", "hk-mtr-tml", "hk-mtr-twl",
  ])
    assert.ok(ids.has(id), `missing ${id}`);
  for (const route of ["505", "507", "610", "614", "614p", "615", "615p", "705", "706", "751", "761p"])
    assert.ok(ids.has(`hk-mtr-lr-${route}`), `missing Light Rail ${route}`);
  for (const id of ["hk-tram-east", "hk-tram-west", "hk-tram-hv", "hk-tram-np"])
    assert.ok(ids.has(id), `missing tramway track ${id}`);

  const loWu = pkg.lines.find((line) => line.id === "hk-mtr-eal-low");
  const lokMaChau = pkg.lines.find((line) => line.id === "hk-mtr-eal-lmc");
  assert.equal(loWu.stations.at(-1)[1], "羅湖");
  assert.equal(lokMaChau.stations.at(-1)[1], "落馬洲");
  assert.ok(!loWu.stations.some((row) => row[1] === "落馬洲"));
  assert.ok(!lokMaChau.stations.some((row) => row[1] === "羅湖"));
  const airportCurve = pkg.lines.find((line) => line.id === "hk-mtr-ael").segments[2][2];
  assert.ok(maximumChordDeviationMetres(airportCurve) > 1_000);
  assert.match(pkg.geometrySource.method, /OSM route relation/);
  assert.match(pkg.geometrySource.method, /despiked, Chaikin-rounded/);
});

test("Hong Kong ships isolated solver, reading and sample datasets", () => {
  const sections = read("data/rail-sections-hk.json");
  const stations = read("data/stations-hk.json");
  const readings = read("data/station-readings-hk.json");
  const store = read("data/train-store-hk.json");
  const manifest = read("data/sample-data-hk/manifest.json");
  assert.ok(sections.features.length > 0);
  assert.ok(stations.features.length > 0);
  assert.equal(readings.country, "HK");
  assert.equal(store.trains.length, 1);
  assert.equal(manifest.total, 1);
  assert.match(store.trains[0].id, /^HK-SAMPLE-/);

  // Station codes are STABLE persisted identifiers (train stores, readings)
  // and keep the pre-normalization uppercase alias spelling, independent of
  // the display line ids.
  for (const feature of stations.features) {
    assert.match(feature.properties.n02_station_code, /^[A-Z][A-Z0-9]*-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/);
    assert.match(feature.properties.n02_group_code, /^hk-official-/);
  }

  // The readings table resolves both persisted codes and Taiwan-style
  // network aliases ({lineId}:{stationGroupId}).
  assert.ok(readings.byCode["TML-MTR-WKS"]);
  assert.ok(readings.byCode["hk-mtr-tml:hk-official-mtr-wks"]);
  assert.equal(readings.byCode["TML-MTR-WKS"].en, "Wu Kai Sha");
  assert.equal(readings.byCode["AEL-MTR-KOW"].zh_Hans, "九龙");
});

test("Hong Kong station snap stubs stay short and on the running line", () => {
  const stations = read("data/stations-hk.json");
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
    // The solver snaps stations through this geometry; a stub longer than a
    // few hundred metres would put snap candidates at the NEIGHBOUR station
    // and collapse solved routes (the exact regression this pins).
    assert.ok(
      length <= 250,
      `${feature.properties.n02_station_code} stub is ${Math.round(length)} m`,
    );
  }
});

// Ridden-route coincidence: every precomputed sample section must reuse the
// EXACT ordered coordinates of a display-package segment (the
// official-interval solver path, OFFICIAL_INTERVAL_COUNTRIES in
// app-route-graph.js). This is what keeps a ridden line visually ON the
// "all railways" track instead of a Dijkstra-reassembled near-miss.
test("Hong Kong sample routes coincide exactly with the drawn network segments", () => {
  const pkg = read("public/rail/hk-2025.json");
  const part = read("data/sample-data-hk/part-000.json");
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

// Display-quality gate: every line is one continuous smooth polyline. The
// pre-rebuild hybrid geometry carried ~1,300 micro-kinks (sudden >60° turns
// on sub-40 m edges) from spliced-source seams; the OSM-chained + despiked +
// Chaikin-rounded pipeline must keep the network kink-free.
test("Hong Kong line geometry is continuous and free of micro-kinks", () => {
  const pkg = read("public/rail/hk-2025.json");
  const turnDegrees = (a, b, c) => {
    const v1 = [b[0] - a[0], b[1] - a[1]];
    const v2 = [c[0] - b[0], c[1] - b[1]];
    const l1 = Math.hypot(...v1);
    const l2 = Math.hypot(...v2);
    if (!l1 || !l2) return 0;
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  };
  const metres = (a, b) => {
    const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
    return Math.hypot((b[0] - a[0]) * 111_320 * Math.cos(lat), (b[1] - a[1]) * 111_320);
  };
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

// Mirrors classifyHkSectionMask in app-stats.js: the HK datasets ship one
// flat code pair (institution 4 / class 21), so the three statistics buckets
// ride on the operator (香港電車 vs MTR) and, within MTR, on the official
// 輕鐵NNN綫 line names. If either convention or the classifier changes, this
// pins that all three coverage buckets stay reachable.
test("Hong Kong sections split into MTR heavy rail, Light Rail and tramway stat buckets", () => {
  const sections = read("data/rail-sections-hk.json");
  let heavy = 0;
  let lightRail = 0;
  let tram = 0;
  for (const feature of sections.features) {
    const props = feature.properties;
    assert.equal(props.institution_type_code, "4");
    assert.equal(props.railway_class_code, "21");
    assert.ok(["MTR", "香港電車"].includes(props.operator), props.operator);
    if (props.operator === "香港電車") tram += 1;
    else if (String(props.line_name).startsWith("輕鐵")) lightRail += 1;
    else heavy += 1;
  }
  assert.ok(heavy > 0, "no heavy-rail sections classified");
  assert.ok(lightRail > 0, "no Light Rail sections classified");
  assert.ok(tram > 0, "no tramway sections classified");
  assert.equal(heavy + lightRail + tram, sections.features.length);
});

// The tramway is carried as its PHYSICAL tracks, not as the six numbered
// services that all share them. That is the whole reason its mileage is
// meaningful, so pin the network total near the operator's own ~30 km of
// track: a regression to per-service lines would multiply it several times.
test("the Hong Kong tramway is one physical network, not six overlapping services", () => {
  const pkg = read("public/rail/hk-2025.json");
  const tram = pkg.lines.filter((line) => line.operator === "香港電車");
  assert.equal(tram.length, 4);
  const km = tram.reduce(
    (sum, line) => sum + line.segments.reduce((total, row) => total + row[0], 0),
    0,
  );
  assert.ok(km > 28 && km < 34, `tramway network is ${km.toFixed(1)} km of track`);

  // Every branch repeats the through-line stop it leaves from and the one it
  // rejoins at, sharing their station GROUP ids, so no branch is an island in
  // the network graph.
  const groupsOf = (id) =>
    new Set(pkg.lines.find((line) => line.id === id).stations.map((row) => row[0]));
  const through = new Set([...groupsOf("hk-tram-east"), ...groupsOf("hk-tram-west")]);
  for (const branch of ["hk-tram-hv", "hk-tram-np"]) {
    const shared = [...groupsOf(branch)].filter((group) => through.has(group));
    assert.equal(shared.length, 2, `${branch} shares ${shared.length} junction stops`);
  }

  // Station codes stay per-line and stable; the shared junctions differ from
  // the through line's codes for the same stop, exactly as MTR interchanges do.
  const readings = read("data/station-readings-hk.json");
  assert.equal(readings.byCode["TRAM-E-KTT"].zh_Hant, "堅尼地城總站");
  assert.equal(readings.byCode["TRAM-E-KTT"].en, "Kennedy Town Terminus");
  assert.equal(readings.byCode["TRAM-W-104W"].zh_Hans, "爹核士街");
  assert.equal(readings.byCode["TRAM-HV-HVT"].zh_Hant, "跑馬地總站");
  assert.equal(readings.byCode["hk-tram-np:hk-official-tram-67e"].en, "Chun Yeung Street");
});
