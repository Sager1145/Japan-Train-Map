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
  assert.equal(pkg.version, "2025.3.2");
  assert.equal(pkg.lines.length, 602);

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

test("Japan renders one complete feature per line, never one per station interval", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const ids = network.segments.features.map(
    (feature) => feature.properties.lineId,
  );

  assert.equal(network.segments.features.length, pkg.lines.length);
  assert.equal(new Set(ids).size, pkg.lines.length);
  let multiPart = 0;
  for (const feature of network.segments.features) {
    const parts =
      feature.geometry.type === "MultiLineString"
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];
    // One feature per line, but a line that carries a branch renders as
    // several DISJOINT strokes so nothing can draw through the junction.
    assert.ok(parts.length >= 1);
    assert.equal(parts.length, feature.properties.partCount);
    if (parts.length > 1) multiPart += 1;
    for (const part of parts) assert.ok(part.length >= 2);
    // Far fewer parts than intervals — the split is topological, not per-hop.
    assert.ok(parts.length <= Math.max(4, feature.properties.intervalCount / 4));
    assert.ok(feature.properties.intervalCount >= 1);
    assert.equal(feature.properties.segmentId, undefined);
  }
  // Only the handful of package lines that carry a branch under one id.
  assert.ok(multiPart > 0 && multiPart < 100, `multi-part lines: ${multiPart}`);
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
    const feature = network.segments.features.find(
      (item) => item.properties.lineId === line.id,
    );
    const parts =
      feature.geometry.type === "MultiLineString"
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];
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
