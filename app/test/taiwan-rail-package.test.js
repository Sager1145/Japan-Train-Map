"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const RailNetwork = require("../public/rail-network.js");

const PACKAGE_PATH = path.join(__dirname, "../public/rail/tw-2025.json");
const EXPECTED_COUNTS = Object.freeze({
  lines: 38,
  stations: 585,
  segments: 548,
  groups: 495,
});

function lineById(compactPackage, id) {
  return compactPackage.lines.find((line) => line.id === id);
}

function haversineKm(left, right) {
  const radians = (value) => (value * Math.PI) / 180;
  const lon1 = radians(left[0]);
  const lat1 = radians(left[1]);
  const lon2 = radians(right[0]);
  const lat2 = radians(right[1]);
  const dlon = lon2 - lon1;
  const dlat = lat2 - lat1;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

test("Taiwan 2025 package matches compact-v1 and its characterized network", () => {
  const source = fs.readFileSync(PACKAGE_PATH);
  const compactPackage = JSON.parse(source);

  assert.deepEqual(
    {
      format: compactPackage.format,
      version: compactPackage.version,
      generatedAt: compactPackage.generatedAt,
      crs: compactPackage.crs,
      country: compactPackage.country,
    },
    {
      format: "compact-v1",
      version: "2025.4.0",
      generatedAt: "2026-08-03T04:38:19.000Z",
      crs: "WGS84",
      country: "TW",
    },
  );
  assert.equal(compactPackage.geometrySource.officialOnly, 1);
  assert.equal(compactPackage.geometrySource.nlscRailRevision, "1150409");
  assert.equal(compactPackage.geometrySource.syntheticConnectors, 0);
  assert.equal(compactPackage.geometrySource.osmSources, 0);
  const officialComparison =
    compactPackage.geometrySource.officialGeometryComparison;
  assert.equal(officialComparison.scope, "LineID/RAILNAME/MRTCODE/LRTCODE");
  assert.equal(officialComparison.lines, EXPECTED_COUNTS.lines);
  assert.equal(Object.keys(officialComparison.byLine).length, EXPECTED_COUNTS.lines);
  assert.equal(officialComparison.vertices, 34_948);
  assert.equal(officialComparison.edgeMidpoints, 34_400);
  assert.ok(
    officialComparison.maxDeviationMeters <= officialComparison.toleranceMeters,
  );
  for (const [lineId, comparison] of Object.entries(
    officialComparison.byLine,
  )) {
    assert.ok(comparison.shapeRefs.length > 0, `${lineId} has no official shape`);
    assert.ok(
      comparison.maxDeviationMeters <= officialComparison.toleranceMeters,
      `${lineId} deviates ${comparison.maxDeviationMeters} m`,
    );
    assert.ok(
      !comparison.shapeRefs.includes("NLSC_TRA:all"),
      `${lineId} uses an unscoped railway graph`,
    );
  }
  assert.ok(compactPackage.geometrySource.sourceSha256["TRA:shape"]);
  assert.doesNotMatch(source.toString("utf8"), /tw-osm|openstreetmap/i);
  assert.equal(compactPackage.lines.length, EXPECTED_COUNTS.lines);
  assert.equal(
    new Set(compactPackage.lines.map((line) => line.id)).size,
    EXPECTED_COUNTS.lines,
  );

  let stationCount = 0;
  let segmentCount = 0;
  let totalKm = 0;
  let edgeCount = 0;
  let maxEdgeKm = 0;
  let maxUnsharedJoinKm = 0;
  let longTwoPointSegments = 0;
  for (const line of compactPackage.lines) {
    stationCount += line.stations.length;
    segmentCount += line.segments.length;
    assert.equal(
      line.segments.length,
      line.stations.length - (line.isLoop ? 0 : 1),
      `${line.id} station/segment topology`,
    );
    assert.equal(
      new Set(line.stations.map((station) => station[0])).size,
      line.stations.length,
      `${line.id} repeats a physical station group`,
    );
    for (const station of line.stations) {
      assert.match(station[0], /^tw-official-[a-z0-9-]+$/);
      assert.ok(station[1]);
      assert.ok(station[2] >= 119 && station[2] <= 123);
      assert.ok(station[3] >= 21 && station[3] <= 26);
      if (station.length > 4) {
        assert.equal(station.length, 6);
        assert.equal(station[5], 3);
      }
    }
    let previousLastCoordinate = null;
    for (const segment of line.segments) {
      assert.ok(segment[0] > 0);
      assert.ok(segment[0] < 75, `${line.id} has an implausible segment`);
      assert.ok(segment[2].length > 0);
      const coordinates = segment[1]
        ? [previousLastCoordinate].concat(segment[2])
        : segment[2];
      assert.ok(coordinates.length >= 3, `${line.id} has a two-point segment`);
      if (previousLastCoordinate && !segment[1]) {
        maxUnsharedJoinKm = Math.max(
          maxUnsharedJoinKm,
          haversineKm(previousLastCoordinate, coordinates[0]),
        );
      }
      const edgeLengths = coordinates.slice(1).map((coordinate, index) =>
        haversineKm(coordinates[index], coordinate),
      );
      edgeCount += edgeLengths.length;
      maxEdgeKm = Math.max(maxEdgeKm, ...edgeLengths);
      if (coordinates.length === 2 && edgeLengths[0] >= 0.5) {
        longTwoPointSegments += 1;
      }
      previousLastCoordinate = coordinates.at(-1);
      totalKm += segment[0];
    }
  }
  assert.equal(stationCount, EXPECTED_COUNTS.stations);
  assert.equal(segmentCount, EXPECTED_COUNTS.segments);
  assert.equal(Math.round(totalKm * 10) / 10, 1788.4);
  assert.ok(edgeCount >= 34_000, `only ${edgeCount} geometry edges`);
  assert.ok(maxEdgeKm < 0.2, `${maxEdgeKm} km output edge`);
  assert.equal(maxUnsharedJoinKm, 0, `${maxUnsharedJoinKm} km station gap`);
  assert.equal(longTwoPointSegments, 0);

  assert.equal(lineById(compactPackage, "tw-thsr-main").stations.length, 12);
  assert.equal(lineById(compactPackage, "tw-trtc-bl").stations.length, 23);
  assert.equal(lineById(compactPackage, "tw-tym-a").stations.length, 22);
  assert.equal(lineById(compactPackage, "tw-krtc-r").stations.length, 25);
  assert.equal(lineById(compactPackage, "tw-klrt-c").stations.length, 38);
  assert.equal(lineById(compactPackage, "tw-alsr-alishan").stations.length, 17);

  const network = RailNetwork.buildNetworkFromCompactPackage(compactPackage);
  assert.ok(network);
  assert.deepEqual(
    {
      lines: network.lineById.size,
      stations: network.stations.features.length,
      segments: network.segments.features.length,
      groups: network.groupMembers.size,
    },
    EXPECTED_COUNTS,
  );
});

test("Taipei Main Station is grouped across high speed, TRA, and metro", () => {
  const compactPackage = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const lookups = [
    ["tw-thsr-main", "台北"],
    ["tw-tra-western-north", "臺北"],
    ["tw-trtc-r", "台北車站"],
    ["tw-tym-a", "台北車站"],
  ];
  const groupIds = lookups.map(([lineId, stationName]) => {
    const row = lineById(compactPackage, lineId).stations.find(
      (station) => station[1] === stationName,
    );
    assert.ok(row, `${stationName} missing from ${lineId}`);
    return row[0];
  });
  assert.equal(new Set(groupIds).size, 1);
});
