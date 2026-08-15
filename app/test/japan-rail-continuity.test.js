"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const RailNetwork = require("../public/rail-network.js");

const PACKAGE_PATH = path.join(__dirname, "../public/rail/jp-2025.json");

function coordinateKey(coordinate) {
  return `${coordinate[0]},${coordinate[1]}`;
}

function decodedIntervals(line) {
  let previousEnd = null;
  return line.segments.map((row) => {
    const coordinates = row[1]
      ? [previousEnd, ...row[2]]
      : row[2].map((coordinate) => [...coordinate]);
    previousEnd = coordinates.at(-1);
    return coordinates;
  });
}

test("every Japanese package line is seam-free before it reaches the renderer", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  // 2025.4.2 keeps the 2025.3.4 loop repair, then reapplies the branch and
  // doubling-back repairs after the OSM attribute/official-colour enrichment.
  //
  // 649 lines, up from 607: the 2026-08-15 rebuild draws each railway's
  // separate alignments as their own strokes, so a line with a rejoining route
  // or a physically detached half yields more than one. The count is a
  // characterisation, not a rule — everything below it is the rule, and it is
  // unchanged: every line's intervals match its station order, and every
  // interval meets its neighbour exactly.
  assert.equal(pkg.version, "2025.4.2");
    // 652 with the three paired alignments — see render-snapshot.mjs.
  assert.equal(pkg.lines.length, 652);

  let intervalCount = 0;
  for (const line of pkg.lines) {
    const expectedIntervals =
      line.stations.length - (line.isLoop ? 0 : 1);
    assert.equal(
      line.segments.length,
      expectedIntervals,
      `${line.id} station/interval topology`,
    );
    const intervals = decodedIntervals(line);
    intervalCount += intervals.length;
    intervals.forEach((coordinates, index) => {
      const start = line.stations[index];
      const end = line.stations[(index + 1) % line.stations.length];
      assert.ok(coordinates.length >= 2, `${line.id}:${index} has no line`);
      assert.equal(
        coordinateKey(coordinates[0]),
        coordinateKey([start[2], start[3]]),
        `${line.id}:${index} does not start at its station`,
      );
      assert.equal(
        coordinateKey(coordinates.at(-1)),
        coordinateKey([end[2], end[3]]),
        `${line.id}:${index} does not end at its station`,
      );
      assert.equal(
        line.segments[index][1],
        index === 0 ? 0 : 1,
        `${line.id}:${index} must encode one shared seam`,
      );
      if (index > 0)
        assert.equal(
          coordinateKey(intervals[index - 1].at(-1)),
          coordinateKey(coordinates[0]),
          `${line.id}:${index} has a station-boundary gap`,
        );
    });
  }
  assert.ok(intervalCount > pkg.lines.length * 10);
});

test("Tokyo and Osaka metro lines use verified official line colours", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const expected = new Map([
    ["jp-東京地下鉄-3号線銀座線", "#ff9500"],
    ["jp-東京地下鉄-4号線丸ノ内線", "#f62e36"],
    ["jp-大阪市高速電気軌道-1号線(御堂筋線)", "#db260a"],
    ["jp-大阪市高速電気軌道-4号線(中央線)", "#00a53c"],
  ]);
  for (const [id, color] of expected) {
    const line = pkg.lines.find((candidate) => candidate.id === id);
    assert.ok(line, `missing ${id}`);
    assert.equal(line.color, color, id);
    assert.match(line.colorSource, /^https:\/\//, id);
  }
});

test("Japanese tunnel and bridge measures remain valid after branch splitting", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  let rows = 0;
  for (const line of pkg.lines) {
    const totalMeters = line.segments.reduce(
      (sum, segment) => sum + segment[0] * 1000,
      0,
    );
    for (const structure of line.structure || []) {
      rows += 1;
      assert.ok(structure[0] >= 0, `${line.id} structure begins before its line`);
      assert.ok(structure[1] > structure[0], `${line.id} has an empty structure interval`);
      assert.ok(
        structure[1] <= totalMeters + 1,
        `${line.id} structure ends beyond its line`,
      );
      assert.ok(structure[2] === 1 || structure[2] === 2);
    }
  }
  assert.ok(rows > 16000, `only ${rows} structure intervals survived`);
});

test("Japan renders one complete feature per line, never one per station interval", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const ids = network.segments.features.map(
    (feature) => feature.properties.lineId,
  );

  // Every line is drawn, and nothing is drawn that is not a line. A line that
  // shares a corridor with an INDEPENDENT railway carries one extra feature
  // per lane it takes (rail-network.js splitPartByLanes) — still its own
  // lineId, still one railway — so the count is per line PLUS the lane table,
  // never per station interval.
  assert.equal(new Set(ids).size, pkg.lines.length);
  assert.ok(network.segments.features.length >= pkg.lines.length);
  // One feature per (line, lane VALUE). A line that takes one lane adds four:
  // the lane itself and the three quarter-steps that ease it in and out. Two
  // stretches at the same lane share all four.
  const lanedPairs = new Set(
    (pkg.lanes || []).map((row) => `${row[0]}\u0000${row[4]}`),
  );
  assert.ok(
    network.segments.features.length <= pkg.lines.length + 4 * lanedPairs.size,
    `${network.segments.features.length} features for ${pkg.lines.length} lines and ${lanedPairs.size} laned pairs`,
  );
  for (const line of pkg.lines) {
    const values = new Set(
      network.segments.features
        .filter((feature) => feature.properties.lineId === line.id)
        .map((feature) => feature.properties.lane),
    );
    assert.equal(
      values.size,
      network.segments.features.filter(
        (feature) => feature.properties.lineId === line.id,
      ).length,
      `${line.id} emits two features for one lane`,
    );
  }
  const laneValues = new Set(
    network.segments.features.map((feature) => feature.properties.lane),
  );
  assert.ok(laneValues.has(0), "the un-offset alignment must still be drawn");
  for (const lane of laneValues) assert.equal(typeof lane, "number");
  // Lines that carry a branch under one id — a TOPOLOGY property, so it is
  // counted from the strokes, not from the lane-split render features.
  const multiPart = [...network.lineById.values()].filter(
    (line) => line.parts.length > 1,
  ).length;
  for (const feature of network.segments.features) {
    const parts =
      feature.geometry.type === "MultiLineString"
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];
    // One feature per line, but a line that carries a branch renders as
    // several DISJOINT strokes so nothing can draw through the junction.
    assert.ok(parts.length >= 1);
    assert.equal(parts.length, feature.properties.partCount);

    for (const part of parts) assert.ok(part.length >= 2);
    assert.ok(feature.properties.strokeCount >= 1);
    assert.ok(feature.properties.intervalCount >= 1);
    assert.equal(feature.properties.segmentId, undefined);
  }
  // Only the handful of package lines that carry a branch under one id.
  assert.ok(multiPart > 0 && multiPart < 100, `multi-part lines: ${multiPart}`);

  // The split is TOPOLOGICAL and per-corridor, never per-hop. A stroke with k
  // lane stretches yields at most k×8 + 1 pieces: each stretch is a gap, three
  // quarter-steps easing in, the full lane, three easing out
  // (rail-network.js RAMP_STEPS), and a final gap closes the stroke. Anything
  // above that means the renderer started cutting the line for some other
  // reason.
  const laneRowsPerLine = new Map();
  for (const row of pkg.lanes || [])
    laneRowsPerLine.set(row[0], (laneRowsPerLine.get(row[0]) || 0) + 1);
  const piecesPerLine = new Map();
  for (const feature of network.segments.features) {
    const parts =
      feature.geometry.type === "MultiLineString"
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];
    const id = feature.properties.lineId;
    piecesPerLine.set(id, (piecesPerLine.get(id) || 0) + parts.length);
  }
  for (const line of pkg.lines) {
    const strokes = network.lineById.get(line.id).parts.length;
    const ceiling = strokes + 8 * (laneRowsPerLine.get(line.id) || 0);
    assert.ok(
      piecesPerLine.get(line.id) <= ceiling,
      `${line.id}: ${piecesPerLine.get(line.id)} drawn pieces for ${strokes} strokes and ${laneRowsPerLine.get(line.id) || 0} lanes`,
    );
  }
});

test("every display part begins and ends on one of its line's stations", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);

  const metres = (a, b) => {
    const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
    return Math.hypot(
      (a[0] - b[0]) * 111320 * Math.cos(lat),
      (a[1] - b[1]) * 111320,
    );
  };

  for (const line of pkg.lines) {
    const stations = line.stations.map((station) => [station[2], station[3]]);
    // TOPOLOGY parts, not the render features. Lane splitting cuts the drawn
    // geometry at corridor boundaries, which is exactly the render/topology
    // separation: what a route is sliced from, and what has to start and end
    // on a platform, is this list.
    const parts = network.lineById.get(line.id).parts;
    for (const part of parts) {
      // A branch only truly merges at a STATION — it is led in over the
      // trunk's own coordinates from the platform to the switch — and a line
      // that ends at a terminus stops on that terminus. So no part may begin
      // or end loose on open track.
      for (const endpoint of [part[0], part[part.length - 1]]) {
        const nearest = Math.min(
          ...stations.map((station) => metres(station, endpoint)),
        );
        assert.ok(
          nearest <= 1,
          `${line.id} has a part endpoint ${Math.round(nearest)} m from any station`,
        );
      }
    }
  }
});

test("no Japanese display line draws back over track it already laid", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);

  const metres = (a, b) => {
    const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
    return Math.hypot(
      (a[0] - b[0]) * 111320 * Math.cos(lat),
      (a[1] - b[1]) * 111320,
    );
  };

  for (const feature of network.segments.features) {
    const parts =
      feature.geometry.type === "MultiLineString"
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];
    for (const part of parts) {
      // A retrace shows up as an about-face: two consecutive edges pointing
      // back along each other. Only kilometre-scale ones are the bug — a real
      // switchback station (二本木 on the 妙高はねうまライン) is a genuine
      // hundred-metre stub that the map should keep drawing.
      for (let index = 1; index < part.length - 1; index += 1) {
        const back = metres(part[index - 1], part[index]);
        const forward = metres(part[index], part[index + 1]);
        if (back < 1000 || forward < 1000) continue;
        const closing = metres(part[index - 1], part[index + 1]);
        assert.ok(
          closing > Math.min(back, forward) * 0.5,
          `${feature.properties.lineId} doubles back at vertex ${index}`,
        );
      }
    }
  }
});

test("official Japanese branch endpoints omitted by the old package are restored", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const stationNames = (operator, name) =>
    new Set(
      pkg.lines
        .filter((line) => line.operator === operator && line.name === name)
        .flatMap((line) => line.stations.map((station) => station[1])),
    );
  const narita = stationNames("東日本旅客鉄道", "成田線");
  const nemuro = stationNames("北海道旅客鉄道", "根室線");

  for (const name of ["空港第2ビル", "成田空港"])
    assert.ok(narita.has(name), `Narita branch is missing ${name}`);
  for (const name of ["滝川", "芦別", "富良野"])
    assert.ok(nemuro.has(name), `Nemuro western component is missing ${name}`);
});
