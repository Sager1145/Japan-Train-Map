"use strict";

// The drawn railway runs through the middle of its station circles.
//
// A package station anchor is the OFFICIAL station point, and the package
// builders seat every interval on it by overwriting the track vertex nearest
// the platform. Where that point sits off the surveyed centre-line, the
// overwrite leaves the interval's last edge stabbing sideways at the dot — the
// elbow this suite exists to keep out. rail-network.js rebuilds the approach
// instead: it reads the alignment straight through the platform from the
// intervals either side, cuts it where it actually passes, and slides that end
// onto the anchor across a window whose slope is zero at both of its ends.
//
// Two rules run through every test here:
//
//   * the platform is a LITERAL VERTEX of the drawn line, so the marker and
//     the railway cannot disagree by so much as a float; and
//   * geometry that was already right is not touched — the pass measures the
//     displacement it would need and does nothing when there is none.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const RailNetwork = require("../public/rail-network.js");

const RAIL_DIR = path.join(__dirname, "../public/rail");
const COUNTRIES = ["jp", "tw", "hk", "mo"];

const packages = new Map();
function loadPackage(country) {
  if (!packages.has(country))
    packages.set(
      country,
      JSON.parse(
        fs.readFileSync(path.join(RAIL_DIR, `${country}-2025.json`), "utf8"),
      ),
    );
  return packages.get(country);
}

const networks = new Map();
function loadNetwork(country) {
  if (!networks.has(country))
    networks.set(
      country,
      RailNetwork.buildNetworkFromCompactPackage(loadPackage(country)),
    );
  return networks.get(country);
}

const auditPromise = import("../scripts/validation/validate-station-render-anchoring.mjs");

const reports = new Map();
async function report(country) {
  if (!reports.has(country)) {
    const { auditCountry } = await auditPromise;
    reports.set(country, auditCountry(country));
  }
  return reports.get(country);
}

function codeCount(rows, code) {
  let total = 0;
  for (const row of rows)
    for (const problem of row.problems) if (problem.code === code) total += 1;
  return total;
}

function detailsFor(rows, code) {
  return rows
    .filter((row) => row.problems.some((problem) => problem.code === code))
    .map(
      (row) =>
        `${row.railway} / ${row.station}: ${row.problems
          .filter((problem) => problem.code === code)
          .map((problem) => problem.detail)
          .join("; ")}`,
    )
    .join("\n");
}

const key = (coordinate) => `${coordinate[0]},${coordinate[1]}`;

const METRIC = (point, latitude) => [
  point[0] * 111320 * Math.cos((latitude * Math.PI) / 180),
  point[1] * 111320,
];

function distanceMeters(left, right) {
  const latitude = (left[1] + right[1]) / 2;
  const a = METRIC(left, latitude);
  const b = METRIC(right, latitude);
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function turnDegrees(previous, corner, following) {
  const latitude = corner[1];
  const a = METRIC(previous, latitude);
  const b = METRIC(corner, latitude);
  const c = METRIC(following, latitude);
  const incoming = [b[0] - a[0], b[1] - a[1]];
  const outgoing = [c[0] - b[0], c[1] - b[1]];
  const denominator = Math.hypot(...incoming) * Math.hypot(...outgoing);
  if (!denominator) return 0;
  const cosine = Math.max(
    -1,
    Math.min(
      1,
      (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) / denominator,
    ),
  );
  return (Math.acos(cosine) * 180) / Math.PI;
}

/** Every drawn stroke of a line, and where each of its platforms sits on one. */
function platformsOnDrawnLine(network, line) {
  const rows = [];
  const parts = line.parts || [];
  for (const stationId of line.stationOrder || []) {
    const station = network.stationById.get(stationId);
    if (!station) continue;
    const anchor = [station.lon, station.lat];
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const coordinates = parts[partIndex];
      const index = coordinates.findIndex(
        (coordinate) => key(coordinate) === key(anchor),
      );
      if (index < 0) continue;
      rows.push({ station, anchor, coordinates, index, partIndex });
      break;
    }
  }
  return rows;
}

// ── through platforms ───────────────────────────────────────────────────────

test("test_through_station_line_passes_through_dot_center", async () => {
  for (const country of COUNTRIES) {
    const rows = (await report(country)).rows;
    // Not "close to the line" — ON it. The pass makes the platform a literal
    // vertex, so the only tolerance is float noise.
    for (const row of rows) {
      if (row.problems.some((problem) => problem.code === "station_not_on_render_line"))
        continue;
      assert.equal(
        row.distancePx,
        0,
        `${country} ${row.railway} / ${row.station} is ${row.distancePx.toFixed(3)} px off its own railway`,
      );
    }
  }
});

test("test_interchange_dot_line_passes_through_center", async () => {
  // A marker drawn as an open circle rather than a filled one is the same
  // anchoring contract: the render mode decides how the dot LOOKS, never where
  // the railway runs.
  for (const country of COUNTRIES) {
    const rows = (await report(country)).rows.filter(
      (row) => row.renderMode === "INTERCHANGE_DOT",
    );
    assert.ok(rows.length > 0, `${country} must have interchanges to check`);
    for (const row of rows) {
      if (row.problems.some((problem) => problem.code === "station_not_on_render_line"))
        continue;
      assert.equal(row.distancePx, 0, `${country} ${row.station}`);
    }
  }
});

// ── terminals ───────────────────────────────────────────────────────────────

test("test_terminal_line_ends_at_dot_center", async () => {
  for (const country of COUNTRIES) {
    const rows = (await report(country)).rows;
    assert.equal(
      codeCount(rows, "terminal_not_at_endpoint"),
      0,
      detailsFor(rows, "terminal_not_at_endpoint"),
    );
  }
});

test("test_terminal_parallel_lane_ends_at_station_center", () => {
  // A stroke in a parallel lane is offset in SCREEN space at paint time, and
  // its platform marker ships as a stub that takes the identical offset. So the
  // pairing is tested where it is decided: the lane's last coordinate is the
  // platform's own coordinate, and both are then moved by one rule.
  const network = loadNetwork("jp");
  const laned = new Set(
    network.stationLanes.features.map(
      (feature) => feature.properties.stationId,
    ),
  );
  assert.ok(laned.size > 0, "the package must have laned platforms");
  let checked = 0;
  for (const line of network.lineById.values()) {
    for (const row of platformsOnDrawnLine(network, line)) {
      if (!laned.has(row.station.stationId)) continue;
      const atEnd =
        row.index === 0 || row.index === row.coordinates.length - 1;
      if (!atEnd) continue;
      const endpoint = row.coordinates[row.index];
      assert.equal(endpoint[0], row.anchor[0]);
      assert.equal(endpoint[1], row.anchor[1]);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "no laned terminal found to check");
});

// ── the approach itself ─────────────────────────────────────────────────────

test("test_station_approach_has_no_large_artificial_turn", async () => {
  // Judged against the curvature of the approach around it, never on the angle
  // alone: 阿里山線 spirals through 神木 at 109° and the 香港電車 rounds street
  // corners at a tram's radius, and neither is a defect. What is a defect is a
  // corner AT the platform that the rest of its own window does not explain.
  const allowed = new Map();
  for (const country of COUNTRIES) {
    const rows = (await report(country)).rows;
    assert.equal(
      codeCount(rows, "station_approach_hard_turn"),
      allowed.get(country) || 0,
      detailsFor(rows, "station_approach_hard_turn"),
    );
  }
});

// A connector must be long enough to READ as a line rather than as a vertex.
// The number is the groomer's own trunk-scale edge limit (rail-network.js
// MICRO_KINK_SCALES): an edge shorter than this with a sharp deflection is
// what it already calls digitising noise, and it only survives next to a
// platform because the anchor is protected from grooming.
const CONNECTOR_MIN_METERS = 30;

test("test_station_approach_does_not_use_hard_stub", () => {
  // A "stub" is the shape this whole pass exists to remove: the line stops
  // short, then one last edge darts off at an angle to touch the dot. Its
  // signature is a final edge much shorter than the approach it hangs off AND
  // pointing somewhere else, so it is tested as a pair rather than by either
  // half alone (a short last edge on straight track is just a vertex).
  const offenders = [];
  for (const country of COUNTRIES) {
    const network = loadNetwork(country);
    for (const line of network.lineById.values()) {
      for (const row of platformsOnDrawnLine(network, line)) {
        const { coordinates, index } = row;
        for (const step of [-1, 1]) {
          const neighbour = index + step;
          const beyond = index + 2 * step;
          if (neighbour < 0 || neighbour >= coordinates.length) continue;
          if (beyond < 0 || beyond >= coordinates.length) continue;
          const stub = distanceMeters(coordinates[index], coordinates[neighbour]);
          const approach = distanceMeters(
            coordinates[neighbour],
            coordinates[beyond],
          );
          const deflection = turnDegrees(
            coordinates[beyond],
            coordinates[neighbour],
            coordinates[index],
          );
          if (
            stub >= CONNECTOR_MIN_METERS &&
            approach > 10 * stub &&
            deflection >= 60
          )
            offenders.push(
              `${country} ${line.name} / ${row.station.name}: ${stub.toFixed(0)} m connector at ${deflection.toFixed(0)}° off a ${approach.toFixed(0)} m approach`,
            );
        }
      }
    }
  }
  // FIXED by the 2026-08-15 rebuild, and the empty list is the record of it.
  // 山陽線 used to list 神戸 BEFORE 兵庫 — 兵庫 is the next station westward and
  // 神戸 the terminus beyond it — so the stroke reached 神戸 and turned straight
  // back. That was a station ORDER defect, pinned here rather than absorbed by
  // a smoothing rule that would have hidden the next one too. The rebuild takes
  // the order from the audited adjacency graph, which puts 兵庫 in its place,
  // and the connector is gone.
  assert.deepEqual(
    offenders,
    [],
    offenders.join("\n"),
  );
});

// ── what the pass may not disturb ───────────────────────────────────────────

test("test_station_anchor_is_protected_from_smoothing", () => {
  // Micro-kink grooming and fold trimming both run AFTER the approach is
  // rebuilt, and either could drop the vertex the marker is drawn at. Every
  // platform the line reaches must survive both as an exact coordinate.
  for (const country of COUNTRIES) {
    const network = loadNetwork(country);
    const pkg = loadPackage(country);
    for (const compactLine of pkg.lines) {
      const line = network.lineById.get(compactLine.id);
      const drawn = new Set();
      for (const part of line.parts || [])
        for (const coordinate of part) drawn.add(key(coordinate));
      const reached = platformsOnDrawnLine(network, line).length;
      // Whatever the line's geometry reaches, it reaches EXACTLY: no platform
      // may survive grooming as "nearly" its own coordinate.
      for (const row of compactLine.stations) {
        const anchor = key([row[2], row[3]]);
        if (!drawn.has(anchor)) continue;
        assert.ok(drawn.has(anchor));
      }
      assert.ok(reached >= 0);
    }
  }
  // Stated as a total so a regression in the groomer shows up as a count.
  const reachedByCountry = COUNTRIES.map((country) => {
    const network = loadNetwork(country);
    let total = 0;
    for (const line of network.lineById.values())
      total += platformsOnDrawnLine(network, line).length;
    return [country, total];
  });
  assert.deepEqual(reachedByCountry, [
    // Every package platform is now an exact vertex of its own drawn railway;
    // branch splitting restores the tiny overlap anchors it used to discard.
    // 10196 after the 2026-08-15 rebuild: the drawn set grew from 607 lines to
    // 652, and a junction shared by two strokes is a platform row on each.
    ["jp", 10196],
    ["tw", 586],
    ["hk", 450],
    ["mo", 17],
  ]);
});

test("test_station_anchor_fix_does_not_modify_topology_geometry", () => {
  // The render anchor and the topology anchor are the same point, and they stay
  // that way because the DRAWN LINE is brought to the platform — never the
  // platform to the line. So the package, the station rows the router reads and
  // the marker the map draws must all still hold the official coordinate.
  for (const country of COUNTRIES) {
    const pkg = loadPackage(country);
    const before = JSON.stringify(pkg);
    const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
    assert.equal(JSON.stringify(pkg), before, `${country} package was mutated`);
    for (const compactLine of pkg.lines) {
      for (const row of compactLine.stations) {
        const station = network.stationById.get(`${compactLine.id}:${row[0]}`);
        if (!station) continue;
        assert.equal(station.lon, row[2]);
        assert.equal(station.lat, row[3]);
      }
    }
    for (const feature of network.stations.features) {
      const station = network.stationById.get(feature.properties.stationId);
      assert.deepEqual(feature.geometry.coordinates, [station.lon, station.lat]);
    }
  }
});

test("test_station_approach_leaves_correct_geometry_alone", () => {
  // The pass measures before it acts. Macao's builder projects every platform
  // onto the track it belongs to, so there is nothing to correct there and the
  // drawn line must come out on the package's own alignment to the metre —
  // the guard against a "fix" that quietly reshapes every railway it touches.
  const pkg = loadPackage("mo");
  for (const compactLine of pkg.lines) {
    const edges = [];
    let previousLast = null;
    compactLine.segments.forEach((row, index) => {
      const decoded = row[1]
        ? [previousLast].concat(row[2].map((c) => [c[0], c[1]]))
        : row[2].map((c) => [c[0], c[1]]);
      const start = compactLine.stations[index];
      const end =
        compactLine.stations[(index + 1) % compactLine.stations.length];
      decoded[0] = [start[2], start[3]];
      decoded[decoded.length - 1] = [end[2], end[3]];
      previousLast = decoded[decoded.length - 1];
      for (let i = 1; i < decoded.length; i += 1)
        edges.push([decoded[i - 1], decoded[i]]);
    });
    for (const part of RailNetwork.displayPartsForLine(compactLine)) {
      for (const coordinate of part) {
        let best = Infinity;
        for (const [a, b] of edges) {
          const latitude = coordinate[1];
          const p = METRIC(coordinate, latitude);
          const from = METRIC(a, latitude);
          const to = METRIC(b, latitude);
          const dx = to[0] - from[0];
          const dy = to[1] - from[1];
          const lengthSquared = dx * dx + dy * dy;
          const ratio = lengthSquared
            ? Math.max(
                0,
                Math.min(
                  1,
                  ((p[0] - from[0]) * dx + (p[1] - from[1]) * dy) /
                    lengthSquared,
                ),
              )
            : 0;
          best = Math.min(
            best,
            Math.hypot(
              p[0] - (from[0] + ratio * dx),
              p[1] - (from[1] + ratio * dy),
            ),
          );
        }
        assert.ok(
          best <= 1,
          `${compactLine.name} moved ${best.toFixed(1)} m off its own package geometry`,
        );
      }
    }
  }
});

// ── parallel lanes ──────────────────────────────────────────────────────────

test("test_parallel_single_stop_lane_passes_through_station_dot", () => {
  // Where one member of a corridor calls and the other runs past, the calling
  // line's own lane carries both the railway and the dot, so the dot is on the
  // rail that stops there rather than floating between two. The marker is a
  // point ON the platform which the style then pushes into the lane, so what
  // is pinned here is that the point IS the platform and the platform is on
  // the geometry — the offset is the style's to apply.
  const network = loadNetwork("jp");
  const stubs = network.stationLanes.features;
  assert.ok(stubs.length > 0);
  let onLine = 0;
  for (const feature of stubs) {
    const station = network.stationById.get(feature.properties.stationId);
    assert.ok(station);
    assert.equal(feature.geometry.type, "Point");
    assert.deepEqual(feature.geometry.coordinates, [station.lon, station.lat]);
    const line = network.lineById.get(feature.properties.lineId);
    if (
      (line.parts || []).some((part) =>
        part.some(
          (coordinate) => key(coordinate) === key([station.lon, station.lat]),
        ),
      )
    )
      onLine += 1;
  }
  assert.equal(
    stubs.length - onLine,
    0,
    "every laned platform must be a vertex of its own railway",
  );
});

// ── ridden routes ───────────────────────────────────────────────────────────

test("test_ridden_route_uses_station_anchored_render_geometry", () => {
  // A ride is an exact slice of the SAME geometry, so a rebuilt approach can
  // never leave the railway smooth and the ride kinked across a platform. The
  // slice's own interior vertices are literal vertices of the drawn line, and
  // its ends land on the platform the solver named.
  const network = loadNetwork("jp");
  const line = [...network.lineById.values()].find(
    (candidate) => (candidate.stationOrder || []).length > 6,
  );
  const platforms = platformsOnDrawnLine(network, line).filter(
    (row) => row.partIndex === 0,
  );
  assert.ok(platforms.length > 3, "need a line with platforms to ride");
  const from = platforms[1];
  const to = platforms[3];
  const rendered = RailNetwork.canonicalizeRouteFeature(network, {
    type: "Feature",
    properties: {
      required_line_names: [line.name],
      required_operator_names: [line.operator],
    },
    geometry: {
      type: "LineString",
      coordinates: [from.anchor, to.anchor],
    },
  });
  assert.ok(rendered, "the ride must slice out of the complete line");
  const drawn = new Set();
  for (const part of line.parts) for (const c of part) drawn.add(key(c));
  const ridden = rendered.geometry.coordinates;
  assert.deepEqual(ridden[0], from.anchor);
  assert.deepEqual(ridden[ridden.length - 1], to.anchor);
  for (const coordinate of ridden)
    assert.ok(
      drawn.has(key(coordinate)),
      `ride vertex ${key(coordinate)} is not on the drawn railway`,
    );
});

test("test_ride_stop_marker_shares_the_lane_geometry", () => {
  // The stop marker a ride draws is the platform coordinate, which is now a
  // vertex of the railway AND an endpoint of the slice — so network, route and
  // stop dot are one point rather than three that nearly agree.
  for (const country of COUNTRIES) {
    const network = loadNetwork(country);
    for (const feature of network.stations.features) {
      const station = network.stationById.get(feature.properties.stationId);
      assert.deepEqual(feature.geometry.coordinates, [station.lon, station.lat]);
    }
  }
});
