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
  assert.equal(pkg.version, "2025.3.0");
  assert.equal(pkg.lines.length, 600);

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

test("Japan renders one complete LineString per line, never one per station interval", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const ids = network.segments.features.map(
    (feature) => feature.properties.lineId,
  );

  assert.equal(network.segments.features.length, pkg.lines.length);
  assert.equal(new Set(ids).size, pkg.lines.length);
  for (const feature of network.segments.features) {
    assert.equal(feature.geometry.type, "LineString");
    assert.ok(feature.geometry.coordinates.length >= 2);
    assert.ok(feature.properties.intervalCount >= 1);
    assert.equal(feature.properties.segmentId, undefined);
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
