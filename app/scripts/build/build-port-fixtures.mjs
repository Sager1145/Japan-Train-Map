#!/usr/bin/env node
// =========================================================================
//  build-port-fixtures.mjs — freeze the JS answers the Swift port must match
//
//  The Swift/iOS fork re-implements the pure-logic tier (REFACTOR_FOR_SWIFT_
//  FORK_PROMPT.md §二, 20 files / 14,369 lines). Nothing about route solving,
//  corridor smoothing or mileage totals can be checked by eye, so the only
//  way to know a re-implementation agrees with this one is to make both read
//  the same inputs and compare the same outputs.
//
//  This script writes those files. The rule that makes them useful:
//
//      the output field is WHATEVER THIS CODE RETURNS TODAY.
//
//  It is not a second opinion about what the answer should be. If the JS is
//  wrong, the fixture is wrong in the same way and the Swift port reproduces
//  the bug — which is correct, because a port that quietly fixes something is
//  a port whose disagreements you can no longer read. Fix the JS first, then
//  regenerate, and the diff shows exactly which answers moved.
//
//  Inputs are drawn from the shipped rail packages rather than invented, so
//  the cases carry the real coordinate distribution (and its real edge cases:
//  integral coordinates, six-decimal jitter, antimeridian-free but wide
//  longitude spread) instead of tidy round numbers.
//
//  Usage:  node scripts/build/build-port-fixtures.mjs [--check]
//          --check regenerates into memory and fails if anything moved,
//          which is what CI wants: fixtures may only change deliberately.
// =========================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(SCRIPT_DIR, "..", "..");
const REPO_DIR = path.join(APP_DIR, "..");
const OUT_DIR = path.join(REPO_DIR, "port-fixtures");

const AppCore = require(path.join(APP_DIR, "shared", "app-core.js"));

// ── the implementations under test ──────────────────────────────────────
// Loaded by evaluating the real frontend files, never by copying their
// bodies into this script: a fixture generated from a copy proves the copy
// and the port agree, which is not the question being asked.

function loadFrontendScope(files) {
  // The app family shares one global lexical scope (contract 1). Concatenating
  // the files reproduces that scope exactly, which is also what the precompute
  // vm sandbox does.
  const source = files
    .map((file) => fs.readFileSync(path.join(APP_DIR, "public", file), "utf8"))
    .join("\n");
  const factory = new Function(
    "window",
    `${source}\n return { distanceMeters, douglasPeuckerIndices, perpDistanceMeters,` +
      ` coordKey, normalizeGraphCoord, routeCoordinateSegmentKey };`,
  );
  return factory({ AppCore });
}

const js = loadFrontendScope(["app-route-simplify.js", "app-coords.js"]);
const RailNetwork = require(path.join(APP_DIR, "public", "rail-network.js"));

// ── real coordinates to feed them ───────────────────────────────────────

function railPackageCoordinates(country, limit) {
  const file = path.join(APP_DIR, "public", "rail", `${country}-2025.json`);
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = [];
  // Walk the compact package generically: any [lon, lat] pair of finite
  // numbers in a plausible range counts. Reaching for a specific field would
  // couple this generator to the package layout, which is a separate contract.
  const seen = new Set();
  const visit = (node) => {
    if (out.length >= limit) return;
    if (Array.isArray(node)) {
      if (
        node.length === 2 &&
        typeof node[0] === "number" &&
        typeof node[1] === "number" &&
        Number.isFinite(node[0]) &&
        Number.isFinite(node[1]) &&
        Math.abs(node[0]) <= 180 &&
        Math.abs(node[1]) <= 90
      ) {
        const key = `${node[0]},${node[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push([node[0], node[1]]);
        }
        return;
      }
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === "object") for (const v of Object.values(node)) visit(v);
  };
  visit(pkg);
  return out;
}

// Coordinates chosen to break a naive port rather than to pass it. The first
// group is the reason this file exists at all: JavaScript prints an integral
// Number without a fractional part ("139"), and a port whose language prints
// "139.0" produces a different coordKey for the same point — every cache key,
// every graph node identity and every overlap bucket silently splits in two.
const ADVERSARIAL_COORDS = [
  [139, 35], // both integral after quantisation
  [139.5, 35.0], // one integral, one not
  [-0.0, 0.0], // negative zero
  [139.123456, 35.123456], // rounds at the 5th decimal
  [139.1234549, 35.1234551], // rounds down / rounds up across the tie
  [-73.987654, -33.456789], // both negative
  [180, -90], // range limits
  [0.00001, 0.000004], // smallest representable / rounds to zero
];

const packageCache = new Map();

/** Reads and caches one country's compact package. */
function railPackage(country) {
  if (!packageCache.has(country))
    packageCache.set(
      country,
      JSON.parse(
        fs.readFileSync(
          path.join(APP_DIR, "public", "rail", `${country}-2025.json`),
          "utf8",
        ),
      ),
    );
  return packageCache.get(country);
}

// ── fixture builders ────────────────────────────────────────────────────

function coordsFixture(sample) {
  const inputs = [...ADVERSARIAL_COORDS, ...sample.slice(0, 400)];
  return {
    describes: "app-coords.js + shared/app-core.js quant5",
    contract:
      "coordKey bytes are a persisted-cache format: route caches, stats edge " +
      "keys and overlap buckets are all keyed on them, so a port that spells " +
      "a coordinate differently is not merely inconsistent, it is unable to " +
      "read anything this app has already written.",
    cases: inputs.map((coord) => ({
      coord,
      quant5: [AppCore.quant5(coord[0]), AppCore.quant5(coord[1])],
      coordKey: js.coordKey(coord),
      normalized: js.normalizeGraphCoord(coord),
    })),
    segmentKeys: inputs.slice(0, 60).map((a, i) => {
      const b = inputs[(i + 7) % inputs.length];
      return { a, b, key: js.routeCoordinateSegmentKey(a, b) };
    }),
  };
}

function distanceFixture(sample) {
  const pairs = [];
  for (let i = 0; i + 1 < Math.min(sample.length, 800); i += 1)
    pairs.push([sample[i], sample[i + 1]]);
  // Degenerate and long-haul pairs the shipped packages never contain.
  pairs.push(
    [
      [139.7671, 35.6812],
      [139.7671, 35.6812],
    ], // zero distance
    [
      [139.7671, 35.6812],
      [135.4959, 34.7024],
    ], // Tokyo–Osaka
    [
      [139.7671, 35.6812],
      [-73.9857, 40.7484],
    ], // antipodal-ish, crosses the date line the short way
    [
      [0, 0],
      [180, 0],
    ], // half the equator
  );
  return {
    describes: "app-route-simplify.js distanceMeters (haversine, R = 6371000)",
    contract:
      "The single surviving haversine in the frontend. rail-network.js keeps a " +
      "deliberately different equirectangular metric — a port that unifies " +
      "them is changing numerical behaviour, not removing duplication.",
    cases: pairs.map(([a, b]) => ({ a, b, metres: js.distanceMeters(a, b) })),
  };
}

function simplifyFixture(sample) {
  const lines = [];
  for (let start = 0; start + 40 < Math.min(sample.length, 2000); start += 40)
    lines.push(sample.slice(start, start + 40));
  lines.push([], [sample[0]], [sample[0], sample[1]]); // n < 3 short-circuit
  const epsilons = [0, 1, 2.5, 10, 140];
  const cases = [];
  for (const line of lines)
    for (const epsilon of epsilons)
      cases.push({
        points: line,
        epsilonMeters: epsilon,
        keptIndices: js.douglasPeuckerIndices(line, epsilon),
      });
  return {
    describes: "app-route-simplify.js douglasPeuckerIndices (epsilon in metres)",
    contract:
      "Returns ascending ORIGINAL indices, both ends always kept, so callers " +
      "can map a simplified vertex back to source geometry. epsilon 0 must " +
      "retain every index — overlap/lane splitting depends on that identity.",
    cases,
  };
}

function intervalsFixture() {
  // Whole packages, not sampled lines: the interesting cases in decodeIntervals
  // are structural (a row that continues from the previous one, a loop line
  // whose last interval wraps to station 0, an endpoint that disagrees with
  // the geometry and loses to the station anchor), and picking "interesting"
  // lines by hand would be picking the cases the port already handles.
  const cases = [];
  for (const country of ["mo", "hk"]) {
    const file = path.join(APP_DIR, "public", "rail", `${country}-2025.json`);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const line of pkg.lines)
      cases.push({
        country,
        lineId: line.id,
        intervals: RailNetwork.decodeIntervals(line),
      });
  }
  return {
    describes: "rail-network.js decodeIntervals (compact-v1 → station intervals)",
    contract:
      "Row layout is [distanceKm, continuesFromPrevious, coordinates]. When " +
      "the flag is set the interval is prefixed with the PREVIOUS interval's " +
      "last coordinate, which is what makes a chain seam-free. Both endpoints " +
      "are then overwritten by the authoritative station anchors — geometry " +
      "loses to the station table, never the other way round — and the end " +
      "station index wraps modulo the station count so a loop line closes.",
    cases,
  };
}

function visibilityFixture() {
  // Every line of every package, not a sample: the LOD rule decides what a
  // reader sees at a national view, and an off-by-one in the length ladder is
  // invisible in a sample and glaring on the map.
  const cases = [];
  for (const country of ["mo", "hk", "tw", "kr", "jp"]) {
    const file = path.join(APP_DIR, "public", "rail", `${country}-2025.json`);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));

    // Mirrors buildNetworkFromCompactPackage: the length that decides a line's
    // visibility is its GROUP's total, so that every piece of one physical
    // railway appears and vanishes as a unit.
    const groupKm = new Map();
    const groupKey = (line) => `${line.operator}\u0000${line.name}`;
    for (const line of pkg.lines) {
      const km = line.segments.reduce((sum, row) => sum + row[0], 0);
      groupKm.set(groupKey(line), (groupKm.get(groupKey(line)) || 0) + km);
    }

    for (const line of pkg.lines)
      cases.push({
        country,
        lineId: line.id,
        rank: line.rank ?? null,
        groupKm: groupKm.get(groupKey(line)),
        minZoomForRank: RailNetwork.minZoomForRank(line.rank),
        minZoomForLength: RailNetwork.minZoomForLength(
          groupKm.get(groupKey(line)),
        ),
      });
  }
  return {
    describes: "rail-network.js minZoomForRank / minZoomForLength",
    contract:
      "The level-of-detail rule, and therefore what a reader sees at a given " +
      "zoom. Grouping is by operator AND display name joined with a NUL: a " +
      "generic name such as 本線 would otherwise bind unrelated railways " +
      "across the country into one visibility unit.",
    cases,
  };
}

// ── write ───────────────────────────────────────────────────────────────

function build() {
  // jp is the largest and most varied package; tw adds a second country's
  // coordinate distribution so the cases are not all one survey's rounding.
  const sample = [
    ...railPackageCoordinates("jp", 1600),
    ...railPackageCoordinates("tw", 400),
  ];
  return {
    "coords.json": coordsFixture(sample),
    "distance.json": distanceFixture(sample),
    "simplify.json": simplifyFixture(sample),
    "intervals.json": intervalsFixture(),
    "visibility.json": visibilityFixture(),
  };
}

function serialize(name, fixture) {
  return `${JSON.stringify({ fixture: name, ...fixture }, null, 2)}\n`;
}

// Fixture modules. Anything dropped into scripts/build/port-fixtures/ is
// picked up here, which is the whole reason the directory exists: porting work
// runs in parallel, and a registry every contributor has to edit is a file
// every contributor has to merge. A module exports:
//
//     export const name = "dates.json";
//     export function build({ RailNetwork, AppCore, js, railPackage, APP_DIR }) {
//       return { describes, contract, cases };
//     }
//
// `build` returns the same shape the built-in fixtures do, and the same rule
// applies: the expected value is whatever the JavaScript returns today.
async function loadFixtureModules() {
  const dir = path.join(SCRIPT_DIR, "port-fixtures");
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".mjs"))
    .sort();
  const loaded = [];
  for (const file of files) {
    const module = await import(pathToFileURL(path.join(dir, file)).href);
    if (!module.name || typeof module.build !== "function") {
      console.error(`  ! ${file} exports no { name, build } — skipped`);
      continue;
    }
    loaded.push(module);
  }
  return loaded;
}

const built = build();

for (const module of await loadFixtureModules()) {
  if (built[module.name]) {
    console.error(
      `  ! ${module.name} is already built in — rename the module's fixture`,
    );
    process.exitCode = 1;
    continue;
  }
  built[module.name] = module.build({
    RailNetwork,
    AppCore,
    js,
    railPackage,
    APP_DIR,
  });
}
const check = process.argv.includes("--check");
let changed = 0;

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, fixture] of Object.entries(built)) {
  const target = path.join(OUT_DIR, name);
  const next = serialize(name, fixture);
  const previous = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (previous === next) {
    console.log(`  = ${name} (${fixture.cases.length} cases)`);
    continue;
  }
  changed += 1;
  if (check) {
    console.error(`  ! ${name} would change — regenerate deliberately`);
    continue;
  }
  fs.writeFileSync(target, next);
  console.log(
    `  ${previous ? "~" : "+"} ${name} (${fixture.cases.length} cases)`,
  );
}

if (check && changed) {
  console.error(
    `\n${changed} fixture(s) no longer match the code. If that was intended, ` +
      `run without --check and commit the diff: it is the list of answers the ` +
      `Swift port must be re-verified against.`,
  );
  process.exit(1);
}
