"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const RailNetwork = require("../public/rail-network.js");

const PACKAGE_PATH = path.join(__dirname, "../public/rail/tw-2025.json");
const TW_STORE_PATH = path.join(__dirname, "../data/train-store-tw.json");
const MATCHED_ROUTES_PATH = path.join(__dirname, "../data/matched-routes.json");
const MATCHED_STOPS_PATH = path.join(__dirname, "../data/matched-stops.json");
const TYMC_SAMPLE_ID =
  "20260802_01_taoyuan_airport_mrt_express_t2_taipei";
// 574 stations, not 585: 中和新蘆線 is ONE railway to 迴龍 with a branch off
// 大橋頭 to 蘆洲, so the 蘆洲 row carries only its own six stations instead of
// repeating the twelve it shares with the trunk
// (scripts/railway/collapse-branch-services.mjs). Both rows keep the line's own name,
// which is how the renderer knows to draw their shared track coincident
// rather than as two independent railways in parallel lanes.
const EXPECTED_COUNTS = Object.freeze({
  lines: 38,
  stations: 574,
  segments: 537,
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

function turnAngleDegrees(previous, corner, following) {
  const lonScale = Math.cos((corner[1] * Math.PI) / 180);
  const incoming = [
    (corner[0] - previous[0]) * lonScale,
    corner[1] - previous[1],
  ];
  const outgoing = [
    (following[0] - corner[0]) * lonScale,
    following[1] - corner[1],
  ];
  const incomingLength = Math.hypot(...incoming);
  const outgoingLength = Math.hypot(...outgoing);
  if (!incomingLength || !outgoingLength) return 0;
  const cosine = Math.max(
    -1,
    Math.min(
      1,
      (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) /
        incomingLength /
        outgoingLength,
    ),
  );
  return (Math.acos(cosine) * 180) / Math.PI;
}

function reconstructedLineSegments(line) {
  let previousLastCoordinate = null;
  return line.segments.map((segment) => {
    const coordinates = segment[1]
      ? [previousLastCoordinate].concat(segment[2])
      : segment[2];
    previousLastCoordinate = coordinates.at(-1);
    return coordinates;
  });
}

function officialPathBetween(line, fromName, toName) {
  const names = line.stations.map((station) => station[1]);
  const fromIndex = names.indexOf(fromName);
  const toIndex = names.indexOf(toName);
  assert.notEqual(fromIndex, -1, `${fromName} missing from official line`);
  assert.notEqual(toIndex, -1, `${toName} missing from official line`);
  const segments = reconstructedLineSegments(line);
  const output = [];
  const append = (coordinates) => {
    const next = coordinates.map((coordinate) => [...coordinate]);
    if (output.length && next.length && output.at(-1).join() === next[0].join())
      next.shift();
    output.push(...next);
  };
  if (fromIndex < toIndex) {
    for (let index = fromIndex; index < toIndex; index += 1)
      append(segments[index]);
  } else {
    for (let index = fromIndex - 1; index >= toIndex; index -= 1)
      append([...segments[index]].reverse());
  }
  return output;
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
      version: "2025.5.2",
      generatedAt: "2026-08-04T16:38:19.000Z",
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
  assert.equal(officialComparison.vertices, 18_456);
  assert.equal(officialComparison.edgeMidpoints, 17_908);
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
    const reconstructedSegments = [];
    for (const segment of line.segments) {
      assert.ok(segment[0] > 0);
      assert.ok(segment[0] < 75, `${line.id} has an implausible segment`);
      assert.ok(segment[2].length > 0);
      const coordinates = segment[1]
        ? [previousLastCoordinate].concat(segment[2])
        : segment[2];
      reconstructedSegments.push(coordinates);
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

    // A station marker is the exact shared boundary vertex of its incoming
    // and outgoing line intervals. This also prevents a route from entering
    // a platform spur and doubling back merely to touch an off-line marker.
    line.stations.forEach((station, index) => {
      const point = [station[2], station[3]];
      const incomingIndex = index - 1;
      if (incomingIndex >= 0) {
        assert.deepEqual(
          reconstructedSegments[incomingIndex].at(-1),
          point,
          `${line.id}:${station[1]} misses incoming line`,
        );
      } else if (line.isLoop) {
        assert.deepEqual(
          reconstructedSegments.at(-1).at(-1),
          point,
          `${line.id}:${station[1]} misses loop seam`,
        );
      }
      if (index < reconstructedSegments.length) {
        assert.deepEqual(
          reconstructedSegments[index][0],
          point,
          `${line.id}:${station[1]} misses outgoing line`,
        );
      }
    });

    // Ordinary Taiwan rail alignments should not contain visible polygonal
    // elbows after grooming. Forest-rail switchbacks are intentional and are
    // therefore kept out of this smoothness guard.
    if (!line.id.startsWith("tw-alsr-")) {
      for (const coordinates of reconstructedSegments) {
        for (let index = 1; index < coordinates.length - 1; index += 1) {
          assert.ok(
            turnAngleDegrees(
              coordinates[index - 1],
              coordinates[index],
              coordinates[index + 1],
            ) < 35,
            `${line.id} retains a jagged interior corner`,
          );
        }
      }
      for (let index = 1; index < line.stations.length - 1; index += 1) {
        const point = [line.stations[index][2], line.stations[index][3]];
        assert.ok(
          turnAngleDegrees(
            reconstructedSegments[index - 1].at(-2),
            point,
            reconstructedSegments[index][1],
          ) < 40,
          `${line.id}:${line.stations[index][1]} bends at the station`,
        );
      }
    }
  }
  assert.equal(stationCount, EXPECTED_COUNTS.stations);
  assert.equal(segmentCount, EXPECTED_COUNTS.segments);
  // 2025.5.2's minimum-corner-radius pass straightens sub-40 m digitising
  // artefacts, which costs 46 m across the whole network. The remaining 12 km
  // are the 中和新蘆線 trunk the 蘆洲 row used to repeat: the package now
  // counts that track once, as one railway does.
  assert.equal(Math.round(totalKm * 10) / 10, 1784.0);
  assert.ok(edgeCount >= 17_000, `only ${edgeCount} geometry edges`);
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
      segments: new Set(
        network.segments.features.map((feature) => feature.properties.lineId),
      ).size,
      groups: network.groupMembers.size,
    },
    {
      ...EXPECTED_COUNTS,
      // Lines plus the lanes independent railways take where they share a
      // corridor (rail-network.js splitPartByLanes).
      segments: new Set(
        network.segments.features.map((feature) => feature.properties.lineId),
      ).size,
    },
  );
});

test("Taipei Main Station is grouped across high speed, TRA, and metro", () => {
  const compactPackage = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const lookups = [
    ["tw-thsr-main", "台北"],
    ["tw-tra-western-north", "臺北"],
    ["tw-trtc-bl", "台北車站"],
    ["tw-trtc-r", "台北車站"],
    ["tw-tym-a", "台北車站"],
  ];
  const stationRows = lookups.map(([lineId, stationName]) => {
    const row = lineById(compactPackage, lineId).stations.find(
      (station) => station[1] === stationName,
    );
    assert.ok(row, `${stationName} missing from ${lineId}`);
    return row;
  });
  assert.equal(new Set(stationRows.map((row) => row[0])).size, 1);
  assert.ok(
    new Set(stationRows.map((row) => `${row[2]},${row[3]}`)).size > 1,
    "separate Taipei Main platforms should retain their own on-line points",
  );
});

test("Taoyuan Airport MRT sample uses the official TYMC route and stations", () => {
  const compactPackage = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const line = lineById(compactPackage, "tw-tym-a");
  const store = JSON.parse(fs.readFileSync(TW_STORE_PATH, "utf8"));
  const routes = JSON.parse(fs.readFileSync(MATCHED_ROUTES_PATH, "utf8"));
  const stops = JSON.parse(fs.readFileSync(MATCHED_STOPS_PATH, "utf8"));
  const train = store.trains.find((row) => row.id === TYMC_SAMPLE_ID);
  assert.ok(train);

  const expectedStops = [
    ["TYMC-A13", "機場第二航廈站", "origin", "13:25"],
    ["TYMC-A12", "機場第一航廈站", "passenger_stop", "13:28"],
    ["TYMC-A11", "坑口站", "pass_through", null],
    ["TYMC-A10", "山鼻站", "pass_through", null],
    ["TYMC-A9", "林口站", "pass_through", null],
    ["TYMC-A8", "長庚醫院站", "passenger_stop", "13:41"],
    ["TYMC-A7", "體育大學站", "pass_through", null],
    ["TYMC-A6", "泰山貴和站", "pass_through", null],
    ["TYMC-A5", "泰山站", "pass_through", null],
    ["TYMC-A4", "新莊副都心站", "pass_through", null],
    ["TYMC-A3", "新北產業園區站", "passenger_stop", "13:55"],
    ["TYMC-A2", "三重站", "pass_through", null],
    ["TYMC-A1", "台北車站", "destination", "14:04"],
  ];
  assert.deepEqual(
    train.stops.map((stop) => [
      stop.n02_station_code,
      stop.name,
      stop.stop_type,
      stop.departure || stop.arrival,
    ]),
    expectedStops,
  );
  assert.equal(train.direction, "up");
  assert.equal(train.route_sections.length, train.stops.length - 1);
  train.route_sections.forEach((section, index) => {
    assert.equal(section.from, train.stops[index].name);
    assert.equal(section.to, train.stops[index + 1].name);
    assert.equal(
      section.from_n02_station_code,
      train.stops[index].n02_station_code,
    );
    assert.equal(
      section.to_n02_station_code,
      train.stops[index + 1].n02_station_code,
    );
  });
  assert.deepEqual(train.route_policy.preferred_line_names, ["桃園機場捷運"]);
  assert.deepEqual(train.route_policy.preferred_operator_names, [
    "桃園大眾捷運股份有限公司",
  ]);

  const sampleRoutes = routes.features
    .filter((feature) => feature.properties.train_id === TYMC_SAMPLE_ID)
    .sort((left, right) =>
      left.properties.segment_index - right.properties.segment_index,
    );
  assert.equal(sampleRoutes.length, 12);
  for (const feature of sampleRoutes) {
    const properties = feature.properties;
    assert.equal(properties.route_choice, "official_line_slice");
    assert.equal(properties.official_line_id, "A");
    assert.equal(properties.station_code_system, "TDX");
    assert.equal(
      properties.from_official_station_uid,
      train.stops[properties.segment_index].n02_station_code,
    );
    assert.equal(
      properties.to_official_station_uid,
      train.stops[properties.segment_index + 1].n02_station_code,
    );
    assert.equal(
      properties.from_official_station_group_id,
      line.stations.find((station) => station[1] === properties.from)[0],
    );
    assert.equal(
      properties.to_official_station_group_id,
      line.stations.find((station) => station[1] === properties.to)[0],
    );
    assert.equal(properties.official_package_version, compactPackage.version);
    assert.equal(
      properties.official_shape_sha256,
      compactPackage.geometrySource.sourceSha256["TYMC:shape"],
    );
    assert.doesNotMatch(JSON.stringify(feature), /openstreetmap|osm_/i);
    assert.deepEqual(
      feature.geometry.coordinates,
      officialPathBetween(line, properties.from, properties.to),
      `${properties.from} -> ${properties.to}`,
    );
  }

  const stationByName = new Map(
    line.stations.map((station) => [station[1], [station[2], station[3]]]),
  );
  const stationGroupByName = new Map(
    line.stations.map((station) => [station[1], station[0]]),
  );
  const sampleStops = stops.features.filter(
    (feature) => feature.properties.train_id === TYMC_SAMPLE_ID,
  );
  assert.equal(sampleStops.length, 13);
  for (const feature of sampleStops) {
    assert.doesNotMatch(JSON.stringify(feature), /openstreetmap|osm_/i);
    assert.equal(feature.properties.line_name, "桃園機場捷運");
    assert.equal(feature.properties.station_code_system, "TDX");
    assert.equal(
      feature.properties.official_station_uid,
      feature.properties.n02_station_code,
    );
    assert.equal(
      feature.properties.official_station_group_id,
      stationGroupByName.get(feature.properties.name),
    );
    assert.deepEqual(
      feature.geometry.coordinates,
      stationByName.get(feature.properties.name),
    );
  }
});
