// Single-source guard for `distanceMeters`.
//
// The frontend carries TWO distance functions that share a name and must not
// be confused with each other:
//
//   * the great-circle (haversine, R=6371000) one. It has exactly ONE
//     declaration, in public/app-route-simplify.js — the only leaf that both
//     the page (index.html) and the fit worker (importScripts) load, so the
//     page, app-fit-worker.js and test/fit-curve-invariants.test.js's vm
//     harness all reach the same function object instead of a copy. It used to
//     be declared in app-route-solver.js and mirrored verbatim into the other
//     two; those mirrors are gone.
//
//   * rail-network.js's equirectangular one, built on its localMetric()
//     projection at 111320 m/degree. It reads ~0.1125% LONGER than the
//     haversine over vertex-scale steps and is a different accuracy class on
//     purpose (see the note in shared/app-core.js).
//
// These tests fail if a second haversine declaration reappears, if a consumer
// goes back to carrying its own copy, if the one declaration's numbers move,
// or if someone "deduplicates" the two algorithms into one.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const CANONICAL = "public/app-route-simplify.js";

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

// Every source the browser, the worker or a harness can execute. rail-network.js
// is listed too: its own declaration is checked separately, and listing it here
// is what makes "exactly one haversine" a statement about the whole family.
function frontendSources() {
  const files = [];
  for (const entry of fs.readdirSync(PUBLIC))
    if (entry.endsWith(".js")) files.push(path.join(PUBLIC, entry));
  files.push(path.join(ROOT, "shared", "app-core.js"));
  for (const entry of fs.readdirSync(__dirname))
    // This file quotes "function distanceMeters(" as a search string; skipping
    // it keeps the scan looking at code and not at its own literals.
    if (
      (entry.endsWith(".test.js") || entry.endsWith(".test.mjs")) &&
      entry !== path.basename(__filename)
    )
      files.push(path.join(__dirname, entry));
  return files;
}

test("the haversine distanceMeters is declared exactly once", () => {
  const declarations = [];
  for (const filePath of frontendSources()) {
    const source = fs.readFileSync(filePath, "utf8");
    let at = source.indexOf("function distanceMeters(");
    while (at !== -1) {
      const body = source.slice(at, source.indexOf("\n}", at) + 2);
      if (body.includes("6371000"))
        declarations.push(path.relative(ROOT, filePath));
      at = source.indexOf("function distanceMeters(", at + 1);
    }
  }
  assert.deepEqual(
    declarations,
    [CANONICAL],
    `the haversine distanceMeters must have exactly one declaration, in ` +
      `${CANONICAL}. Found: ${declarations.join(", ") || "none"}. A Worker and ` +
      `a vm harness cannot see the classic-script family's bare bindings, but ` +
      `both load app-route-simplify.js, so neither needs a copy.`,
  );
});

test("the fit worker and the vm harness read the one declaration", () => {
  const worker = fs.readFileSync(path.join(PUBLIC, "app-fit-worker.js"), "utf8");
  assert.match(
    worker,
    /importScripts\("app-route-simplify\.js"/,
    "app-fit-worker.js must importScripts app-route-simplify.js first — that " +
      "is where its distanceMeters comes from",
  );
  assert.ok(
    !worker.includes("function distanceMeters("),
    "app-fit-worker.js declared its own distanceMeters again; it already " +
      "imports the file that owns it",
  );

  const harness = fs.readFileSync(
    path.join(__dirname, "fit-curve-invariants.test.js"),
    "utf8",
  );
  assert.ok(
    !harness.includes("function distanceMeters("),
    "test/fit-curve-invariants.test.js declared its own distanceMeters again",
  );
  assert.ok(
    !/^\s*distanceMeters,$/m.test(harness),
    "test/fit-curve-invariants.test.js stubbed distanceMeters into its vm " +
      "context again. It runs app-route-simplify.js into that context, so the " +
      "real one is already there; a stub would silently shadow it and the " +
      "harness would stop mirroring the worker.",
  );
});

test("the one declaration still returns the exact doubles it always has", () => {
  // Behaviour pin, not a text pin. These are the bit patterns app-route-
  // solver.js produced before the declaration moved out of it, so an edit to
  // the body reports itself as a number change and not only as a diff.
  const distanceMeters = compile(
    extractDistanceMeters(path.join(PUBLIC, "app-route-simplify.js")),
  );
  const buf = new DataView(new ArrayBuffer(8));
  const bits = (x) => {
    buf.setFloat64(0, x);
    return buf.getBigUint64(0).toString(16).padStart(16, "0");
  };
  const cases = [
    // 東京 -> 東京 (a repeated vertex)                                  0 m
    [[139.7671, 35.6812], [139.7671, 35.6812], "0000000000000000"],
    // one N02 vertex step                                21.21218932118593 m
    [[139.7671, 35.6812], [139.7673, 35.6813], "403536520a130dd4"],
    // 東京 -> 大阪                                        403058.319569929 m
    [[139.7671, 35.6812], [135.4959, 34.7025], "411899c9473d56e7"],
    // 札幌 -> 博多                                      1419808.4682823762 m
    [[141.3507, 43.0687], [130.4017, 33.5904], "4135aa2077e15a93"],
    // 台北 -> 高雄                                       296787.65877213073 m
    [[121.5654, 25.033], [120.3014, 22.6273], "41121d4ea2952954"],
    // 香港 -> 澳門                                        65751.41775056212 m
    [[114.1694, 22.3193], [113.5439, 22.1987], "40f00d76af1b36a3"],
    // 서울 -> 부산                                        325111.2588497622 m
    [[126.978, 37.5665], [129.0756, 35.1796], "4113d7dd090fe97d"],
    // sub-millimetre, where a naive law-of-cosines would collapse to 0
    [
      [139.7671, 35.6812],
      [139.76710001, 35.68120001],
      "3f577893e8c34767",
    ],
  ];
  for (const [a, b, expected] of cases)
    assert.equal(
      bits(distanceMeters(a, b)),
      expected,
      `distanceMeters(${JSON.stringify(a)}, ${JSON.stringify(b)}) changed: ` +
        `got ${distanceMeters(a, b)} (${bits(distanceMeters(a, b))}), ` +
        `expected bit pattern ${expected}. Every cached route key, station ` +
        `snap and corridor fit was solved against these numbers.`,
    );
});

test("rail-network.js keeps its own equirectangular distance", () => {
  const railNetwork = extractDistanceMeters(
    path.join(PUBLIC, "rail-network.js"),
  );
  const canonical = extractDistanceMeters(
    path.join(PUBLIC, "app-route-simplify.js"),
  );
  assert.notEqual(
    railNetwork,
    canonical,
    "rail-network.js's distanceMeters was replaced by the haversine. " +
      "These are different accuracy classes on purpose: every threshold in " +
      "rail-network.js was tuned against the equirectangular numbers.",
  );
  assert.match(
    railNetwork,
    /localMetric/,
    "rail-network.js's distanceMeters must stay built on localMetric(), so it " +
      "shares the cos(latitude) projection with turnDegrees()",
  );
  assert.ok(
    !railNetwork.includes("6371000"),
    "rail-network.js's distanceMeters grew an earth radius — it is the " +
      "equirectangular one and must stay on localMetric's 111320 m/degree",
  );
});

test("the equirectangular distance runs a measured ~0.1125% long", () => {
  // Both functions apply a cos(latitude) correction; the entire remaining gap
  // is the metres-per-degree constant (111320 vs 6371000*pi/180 = 111194.93).
  // Pinning the ratio means any change to either constant reports itself here
  // instead of silently shifting every station snap and line length.
  const haversine = compile(
    extractDistanceMeters(path.join(PUBLIC, "app-route-simplify.js")),
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
