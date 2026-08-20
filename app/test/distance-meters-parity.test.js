// Drift guard for the deliberately duplicated `distanceMeters`.
//
// The frontend carries TWO distance functions that share a name and must not
// be confused with each other:
//
//   * the great-circle (haversine, R=6371000) one owned by
//     app-route-solver.js, mirrored verbatim into app-fit-worker.js (a Worker
//     has its own global scope) and into test/fit-curve-invariants.test.js
//     (a vm harness). Three copies, one body.
//
//   * rail-network.js's equirectangular one, built on its localMetric()
//     projection at 111320 m/degree. It reads ~0.1125% LONGER than the
//     haversine everywhere and is a different accuracy class on purpose
//     (see the note in shared/app-core.js).
//
// These tests fail if a copy drifts, and if someone "deduplicates" the two
// algorithms into one.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

// Pull out `function distanceMeters(...) { ... }` by brace matching, so the
// extraction does not depend on indentation or on what follows the function.
function extractDistanceMeters(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const start = source.indexOf("function distanceMeters(");
  assert.notEqual(
    start,
    -1,
    `${path.relative(ROOT, filePath)} no longer declares distanceMeters`,
  );
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${filePath}`);
}

// Compile an extracted body into a callable, so the tests below compare
// numbers and not only text.
function compile(body) {
  return new Function(`${body}; return distanceMeters;`)();
}

const HAVERSINE_SOURCES = [
  ["public/app-route-solver.js", path.join(PUBLIC, "app-route-solver.js")],
  ["public/app-fit-worker.js", path.join(PUBLIC, "app-fit-worker.js")],
  [
    "test/fit-curve-invariants.test.js",
    path.join(__dirname, "fit-curve-invariants.test.js"),
  ],
];

test("the three haversine distanceMeters copies are character-identical", () => {
  const [canonicalName, canonicalPath] = HAVERSINE_SOURCES[0];
  const canonical = extractDistanceMeters(canonicalPath);
  assert.match(canonical, /6371000/, "canonical copy lost its earth radius");
  for (const [name, filePath] of HAVERSINE_SOURCES.slice(1)) {
    assert.equal(
      extractDistanceMeters(filePath),
      canonical,
      `${name} has drifted from ${canonicalName}. A Worker and a vm harness ` +
        `cannot see the classic-script family's binding, so these copies are ` +
        `intentional — but they must stay identical. Edit one, edit all three.`,
    );
  }
});

test("rail-network.js keeps its own equirectangular distance", () => {
  const railNetwork = extractDistanceMeters(
    path.join(PUBLIC, "rail-network.js"),
  );
  const solver = extractDistanceMeters(path.join(PUBLIC, "app-route-solver.js"));
  assert.notEqual(
    railNetwork,
    solver,
    "rail-network.js's distanceMeters was replaced by the solver's haversine. " +
      "These are different accuracy classes on purpose: every threshold in " +
      "rail-network.js was tuned against the equirectangular numbers.",
  );
  assert.match(
    railNetwork,
    /localMetric/,
    "rail-network.js's distanceMeters must stay built on localMetric(), so it " +
      "shares the cos(latitude) projection with turnDegrees()",
  );
});

test("the equirectangular distance runs a measured ~0.1125% long", () => {
  // Both functions apply a cos(latitude) correction; the entire remaining gap
  // is the metres-per-degree constant (111320 vs 6371000*pi/180 = 111194.93).
  // Pinning the ratio means any change to either constant reports itself here
  // instead of silently shifting every station snap and line length.
  const haversine = compile(
    extractDistanceMeters(path.join(PUBLIC, "app-route-solver.js")),
  );
  const source = fs.readFileSync(path.join(PUBLIC, "rail-network.js"), "utf8");
  const localMetricStart = source.indexOf("function localMetric(");
  assert.notEqual(localMetricStart, -1, "rail-network.js lost localMetric");
  const equirect = new Function(
    `${extractDistanceMeters(path.join(PUBLIC, "rail-network.js"))}
     ${source.slice(localMetricStart, source.indexOf("\n  }", localMetricStart) + 4)}
     return distanceMeters;`,
  )();

  const probes = [
    [139.7671, 35.6812],
    [141.3507, 43.0687],
    [121.5654, 25.033],
    [114.1694, 22.3193],
    [126.978, 37.5665],
  ];
  for (const [lon, lat] of probes) {
    for (const [dlon, dlat] of [
      [0.001, 0],
      [0, 0.001],
      [0.05, 0.05],
    ]) {
      const a = [lon, lat];
      const b = [lon + dlon, lat + dlat];
      const ratio = equirect(a, b) / haversine(a, b);
      assert.ok(
        ratio > 1.0011 && ratio < 1.00115,
        `equirectangular/haversine ratio at ${lon},${lat} was ${ratio}, ` +
          `expected ~1.001125`,
      );
    }
  }
});
