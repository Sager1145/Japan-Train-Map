const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exact copy of the production haversine (app-route-solver.js /
// app-fit-worker.js), so the curves solved under test are numerically the
// same as the worker's — the harness used to substitute an equirectangular
// approximation here, which quietly broke the "mirrors the worker" claim.
function distanceMeters(a, b) {
  const lon1 = Number(a[0]);
  const lat1 = Number(a[1]);
  const lon2 = Number(b[0]);
  const lat2 = Number(b[1]);
  const radius = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const x =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(x));
}

function loadHooks(settings = {}) {
  const context = vm.createContext({
    console,
    location: { search: "" },
    distanceMeters,
    APPLIED_FIT_CURVE_SETTINGS: settings,
  });
  const pub = path.join(__dirname, "..", "public");
  for (const file of ["app-route-simplify.js", "app-overlap-lanes.js"])
    vm.runInContext(fs.readFileSync(path.join(pub, file), "utf8"), context, {
      filename: file,
    });
  return vm.runInContext(
    `({
      nearParallelSegmentSeparation,
      corridorEndpointPair,
      selectOneToOneEndpointPairs,
      validateFittedCurveDeviation,
      rebuildGroupRepresentativeGeometry,
      smoothCorridorCurve,
      smoothStandaloneCorridorRun
    })`,
    context,
  );
}

function loadOverlapMapHooks() {
  const coordKey = (p) => `${p[0]},${p[1]}`;
  const context = vm.createContext({
    console,
    location: { search: "" },
    distanceMeters,
    APPLIED_FIT_CURVE_SETTINGS: {},
    cachedRouteDateActive: false,
    selectedDate: null,
    compareTrainsByDateAndDeparture: (a, b) => a.id.localeCompare(b.id),
    riddenFeatureVisible: () => true,
    routeSegmentStyleValues: () => ({ opacity: 1 }),
    iterateGeometryLines: (geometry) => [geometry.coordinates],
    coordKey,
    routeCoordinateSegmentKey: (a, b) =>
      [coordKey(a), coordKey(b)].sort().join("|"),
  });
  const pub = path.join(__dirname, "..", "public");
  for (const file of [
    "app-route-simplify.js",
    "app-overlap-lanes.js",
    "app-deck-records.js",
  ])
    vm.runInContext(fs.readFileSync(path.join(pub, file), "utf8"), context, {
      filename: file,
    });
  return vm.runInContext(
    `({ buildDeckOverlapMap, routeCoordinateSegmentKey })`,
    context,
  );
}

test("near-parallel matching rejects a shallow fork that only touches at its tip", () => {
  const { nearParallelSegmentSeparation } = loadHooks();
  const lat = 35;
  const lonM = 111320 * Math.cos((lat * Math.PI) / 180);
  const origin = [139, lat];
  const east = [139 + 2500 / lonM, lat];
  const fork = [
    139 + (2500 * Math.cos(Math.PI / 12)) / lonM,
    lat + (2500 * Math.sin(Math.PI / 12)) / 110540,
  ];
  assert.strictEqual(
    nearParallelSegmentSeparation(origin, east, origin, fork, 120),
    null,
  );

  const parallelStart = [139, lat + 80 / 110540];
  const parallelEnd = [east[0], lat + 80 / 110540];
  const separation = nearParallelSegmentSeparation(
    origin,
    east,
    parallelStart,
    parallelEnd,
    120,
  );
  assert.ok(separation > 75 && separation < 85);
});

test("a snapped junction still requires compatible endpoint tangents", () => {
  const { corridorEndpointPair } = loadHooks();
  const base = { p: [139, 35], sig: "A|B" };
  const incoming = { ...base, id: "in", key: "in", out: [1, 0] };
  const straight = { ...base, id: "straight", key: "straight", out: [-1, 0] };
  const branch = { ...base, id: "branch", key: "branch", out: [0, -1] };
  assert.ok(corridorEndpointPair(incoming, straight));
  assert.strictEqual(corridorEndpointPair(incoming, branch), null);
});

test("one endpoint cannot accept two curves in a many-to-one merge", () => {
  const { selectOneToOneEndpointPairs } = loadHooks();
  const end = (id) => ({ id });
  const trunk = end("trunk");
  const selected = selectOneToOneEndpointPairs([
    { a: end("branch-a"), b: trunk, score: 1 },
    { a: end("branch-b"), b: trunk, score: 2 },
  ]);
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(selected[0].a.id, "branch-a");

  const ambiguous = selectOneToOneEndpointPairs(
    [
      { a: end("branch-a"), b: trunk, score: 100 },
      { a: end("branch-b"), b: trunk, score: 120 },
    ],
    50,
  );
  assert.strictEqual(ambiguous.length, 0);
});

test("near-parallel components cannot re-merge one train through a third track", () => {
  const { buildDeckOverlapMap, routeCoordinateSegmentKey } = loadOverlapMapHooks();
  const lat = 35;
  const offset = 80 / 110540;
  const line = (dy) => [
    [139, lat + dy],
    [139.02, lat + dy],
  ];
  const lines = [line(0), line(offset), line(offset * 2)];
  const trains = [{ id: "same" }, { id: "middle" }, { id: "same" }];
  const items = lines.map((coordinates, i) => ({
    train: trains[i],
    feature: {
      geometry: { type: "LineString", coordinates },
      properties: { ride_segment: true },
    },
  }));
  const overlap = buildDeckOverlapMap(items);
  const keys = lines.map((points) => routeCoordinateSegmentKey(points[0], points[1]));
  assert.strictEqual(overlap.groupKeyForKey(keys[0]), overlap.groupKeyForKey(keys[1]));
  assert.notStrictEqual(overlap.groupKeyForKey(keys[1]), overlap.groupKeyForKey(keys[2]));
  assert.strictEqual(overlap.idsForKey(keys[2]), null);
});

test("sequential runs rebuild one representative and all dependent axis state", () => {
  const { rebuildGroupRepresentativeGeometry } = loadHooks();
  const a = [139, 35];
  const b = [139.01, 35];
  const c = [139.02, 35.002];
  const gi = {
    sx: 1,
    sy: 0,
    _latRef: 0,
    _line: [a, b],
    _lines: [[a, b], [b, c]],
  };
  const representative = rebuildGroupRepresentativeGeometry(gi);
  assert.strictEqual(representative.length, 3);
  assert.strictEqual(JSON.stringify(gi._pa), JSON.stringify(a));
  assert.strictEqual(JSON.stringify(gi._pb), JSON.stringify(c));
  assert.ok(gi._latRef > 34 && gi._latRef < 36);
  assert.ok(Math.abs(gi.sy) > Math.abs(gi.sx));
});

test("closed standalone runs use the static direction fallback", () => {
  const { smoothStandaloneCorridorRun } = loadHooks();
  const closed = [
    [139, 35],
    [139.01, 35],
    [139.01, 35.01],
    [139, 35],
  ];
  assert.strictEqual(smoothStandaloneCorridorRun(closed, true), null);
});

test("final deviation validation measures the whole curve against raw rail", () => {
  const { validateFittedCurveDeviation } = loadHooks();
  const source = [
    [139, 35],
    [139, 35.01],
    [139.01, 35.01],
    [139.01, 35],
  ];
  assert.strictEqual(
    validateFittedCurveDeviation(source, [source], 100).valid,
    true,
  );
  const chord = [source[0], [139.005, 35], source[source.length - 1]];
  assert.strictEqual(
    validateFittedCurveDeviation(chord, [source], 100).valid,
    false,
  );
});

test("the returned precision-resampled curve still passes final validation", () => {
  const settings = {
    fitCurvePrecision: 0.5,
    fitCurveMinRadius: 500,
    fitCurveMinDetail: 500,
    fitCurveMaxDeviation: 300,
  };
  const { smoothCorridorCurve, validateFittedCurveDeviation } = loadHooks(settings);
  const source = [];
  for (let i = 0; i <= 120; i += 1) {
    const t = i / 120;
    source.push([139 + t * 0.08, 35 + Math.sin(t * Math.PI) * 0.008]);
  }
  const curve = smoothCorridorCurve(source);
  assert.ok(curve);
  const finalCheck = validateFittedCurveDeviation(
    curve.pts,
    [source],
    curve.maxDeviationMeters,
  );
  assert.strictEqual(finalCheck.valid, true);
  assert.ok(
    Math.abs(finalCheck.maxDeviationMeters - curve.actualMaxDeviationMeters) < 0.1,
  );
});
