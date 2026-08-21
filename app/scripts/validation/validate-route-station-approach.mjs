#!/usr/bin/env node
/*
 * validate-route-station-approach.mjs — the standing RIDDEN-ROUTE approach audit.
 *
 * Sibling of validate-station-render-anchoring.mjs, one layer up. That one asks
 * whether the ALL-RAILWAYS stroke passes through the platform it calls at. This
 * one asks the same question of the stroke a ride is actually drawn with:
 *
 *   A DRAWN RIDE REACHES ITS STOP ALONG THE RAIL IT RODE — never by a straight
 *   chord swung off the track to catch a marker standing somewhere else.
 *
 * The chord is not hypothetical. rail-network.js canonicalizeRouteFeature ends
 * each hop at the PROJECTION of the solver's platform point onto the display
 * line, then snapEndpoint() overwrites that last vertex with the platform point
 * itself whenever the two are within ENDPOINT_SNAP_METERS. Where both name the
 * same platform the move is metres and invisible. Where the display line is a
 * DIFFERENT track from the one the train used — 埼京線 drawn on the 宇都宮線
 * alignment because the package's 東北線 has no 大宮–北与野 branch link — the
 * same line of code draws a 98 m right-angle jog into the station.
 *
 * Reported per corner of every drawn hop:
 *
 *   route_approach_elbow   a corner at a hop END — the signature of the snap
 *                          chord, and reported with the SIDEWAYS distance the
 *                          drawn rail misses the platform by (the chord length
 *                          times the sine of the corner), which is the number
 *                          that says how far off the wrong track was
 *   route_interior_elbow   a corner in open track, away from either end
 *
 * A corner is judged against the curvature the rest of its window is already
 * turning at, exactly as the anchoring audit does, so a switchback (立野) and a
 * tram rounding a block are not reported as defects.
 *
 * Usage:
 *   node scripts/validation/validate-route-station-approach.mjs
 *   node scripts/validation/validate-route-station-approach.mjs --country jp
 *   node scripts/validation/validate-route-station-approach.mjs --train 20260704_07_saikyo_line
 *   node scripts/validation/validate-route-station-approach.mjs --all --json out.json
 *
 * Exit code is 0 unless --strict is given, in which case any ERROR fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const RailNetwork = require(path.join(APP_DIR, "public/rail-network.js"));

export const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];

// Where each country's precomputed solver output lives. These are the very
// features the browser feeds canonicalizeRouteFeature, so replaying them here
// reproduces the drawn geometry vertex for vertex.
const PARTS_DIR = {
  jp: "data/sample-data",
  tw: "data/sample-data-tw",
  hk: "data/sample-data-hk",
  mo: "data/sample-data-mo",
  kr: "data/sample-data-kr",
};

// ── thresholds ───────────────────────────────────────────────────────────────

// A corner where a hop ends is only a defect once the rail it arrives on is
// measurably beside the platform. Sideways miss, in metres: a platform point
// and a package anchor derived from the SAME platform sit a few metres apart,
// and closing that gap is exactly what the snap is for.
const MISS_OK_METERS = 20;
const MISS_ERROR_METERS = 45;

const TURN_SUSPICIOUS_DEGREES = 35;
const TURN_ERROR_DEGREES = 60;
// Corners shorter than this either side are survey jitter, not a drawn elbow.
const MIN_EDGE_METERS = 12;

// Same curvature test the anchoring audit uses: an elbow is artificial only
// when the track is not already turning that hard around it — a tram rounding
// a city block turns far more sharply over its whole approach than at any one
// corner of it.
const APPROACH_WINDOW_METERS = 300;
const CURVATURE_SPIKE_RATIO = 3;
const CURVATURE_FLOOR_DEGREES = 8;

// A fold this tight is a REVERSAL, not an elbow: the train came in and went
// back out the way it arrived. 立野 (豊肥線) and 阿里山線's four 折返
// are railways that genuinely do this, and a chord swung sideways to catch a
// marker never does — it turns 35° to 100°. Reversals that are NOT real are
// a different defect with its own audit (validate-railway-topology.mjs).
const REVERSAL_MIN_DEGREES = 155;

const SEVERITY_ORDER = { PASS: 0, WARNING: 1, ERROR: 2 };

// ── geometry ────────────────────────────────────────────────────────────────

const M_PER_DEG = 111320;

function distanceMeters(a, b) {
  const scale = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180) || 1;
  return Math.hypot((b[0] - a[0]) * M_PER_DEG * scale, (b[1] - a[1]) * M_PER_DEG);
}

function turnDegrees(previous, corner, following) {
  const scale = Math.cos((corner[1] * Math.PI) / 180) || 1;
  const inbound = Math.atan2(corner[1] - previous[1], (corner[0] - previous[0]) * scale);
  const outbound = Math.atan2(following[1] - corner[1], (following[0] - corner[0]) * scale);
  let degrees = (Math.abs(outbound - inbound) * 180) / Math.PI;
  if (degrees > 180) degrees = 360 - degrees;
  return degrees;
}

function pointSegmentDistanceMeters(point, start, end) {
  const scale = Math.cos((point[1] * Math.PI) / 180) || 1;
  const metric = (row) => [row[0] * M_PER_DEG * scale, row[1] * M_PER_DEG];
  const [px, py] = metric(point);
  const [ax, ay] = metric(start);
  const [bx, by] = metric(end);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
    : 0;
  return Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy));
}

/** The sharpest corner in the window around `index`, excluding `index` itself. */
function ambientTurnDegrees(coordinates, index) {
  let ambient = 0;
  const walk = (step) => {
    let travelled = 0;
    for (
      let cursor = index + step;
      cursor > 0 && cursor < coordinates.length - 1;
      cursor += step
    ) {
      ambient = Math.max(
        ambient,
        turnDegrees(coordinates[cursor - 1], coordinates[cursor], coordinates[cursor + 1]),
      );
      travelled += distanceMeters(coordinates[cursor], coordinates[cursor - step]);
      if (travelled >= APPROACH_WINDOW_METERS) break;
    }
  };
  walk(-1);
  walk(1);
  return ambient;
}

// ── replaying what the browser draws ────────────────────────────────────────

function iterateGeometryLines(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates || []];
  if (geometry?.type === "MultiLineString") return geometry.coordinates || [];
  return [];
}

function lastGeometryCoordinate(geometry) {
  const lines = iterateGeometryLines(geometry);
  const last = lines[lines.length - 1];
  return last && last.length ? last[last.length - 1] : null;
}

// app-route-features.js normalizeSingleRouteGeometry, same two rules.
function normalizeSingleRouteGeometry(feature) {
  if (!feature?.geometry) return null;
  if (feature.geometry.type === "LineString") return feature;
  if (
    feature.geometry.type === "MultiLineString" &&
    feature.properties?.geometry_role === "single_path_with_gaps"
  )
    return feature;
  return null;
}

/** The hops of one train, drawn exactly as getMatchedRouteFeatures draws them. */
function drawnHopsForTrain(network, routeFeatures) {
  const candidates = routeFeatures
    .filter((feature) => feature?.properties?.is_primary !== false)
    .sort(
      (a, b) =>
        Number(a.properties?.segment_index ?? 0) -
        Number(b.properties?.segment_index ?? 0),
    );
  if (!candidates.length) return [];
  const routeId = candidates[0].properties?.route_id || "";
  let previousEnd = null;
  const hops = [];
  for (const feature of candidates) {
    if ((feature.properties?.route_id || "") !== routeId) continue;
    const normalized = normalizeSingleRouteGeometry(feature);
    if (!normalized) continue;
    const canonical = RailNetwork.canonicalizeRouteFeature(network, normalized, {
      continueFrom: previousEnd,
    });
    const drawn = canonical || normalized;
    previousEnd = lastGeometryCoordinate(drawn.geometry);
    hops.push({ drawn, canonical: Boolean(canonical), solved: normalized });
  }
  return hops;
}

// ── audit ───────────────────────────────────────────────────────────────────

function severityFor(problems) {
  return problems.reduce(
    (worst, problem) =>
      SEVERITY_ORDER[problem.severity] > SEVERITY_ORDER[worst]
        ? problem.severity
        : worst,
    "PASS",
  );
}

function auditHop(hop, context) {
  const problems = [];
  const properties = hop.drawn.properties || {};
  const label = `${properties.from || "?"} → ${properties.to || "?"}`;
  for (const coordinates of iterateGeometryLines(hop.drawn.geometry)) {
    if (coordinates.length < 3) continue;

    for (let index = 1; index < coordinates.length - 1; index += 1) {
      const deflection = turnDegrees(
        coordinates[index - 1],
        coordinates[index],
        coordinates[index + 1],
      );
      if (deflection < TURN_SUSPICIOUS_DEGREES) continue;
      const before = distanceMeters(coordinates[index - 1], coordinates[index]);
      const after = distanceMeters(coordinates[index], coordinates[index + 1]);
      if (Math.min(before, after) < MIN_EDGE_METERS) continue;
      if (deflection >= REVERSAL_MIN_DEGREES) continue;
      const ambient = ambientTurnDegrees(coordinates, index);
      const spike = ambient > CURVATURE_FLOOR_DEGREES ? deflection / ambient : Infinity;
      if (ambient > CURVATURE_FLOOR_DEGREES && spike < CURVATURE_SPIKE_RATIO) continue;

      const atStart = index === 1;
      const atEnd = index === coordinates.length - 2;
      if (atStart || atEnd) {
        // How far SIDEWAYS of the platform the rail the hop was drawn on runs.
        // The chord itself is the outer edge; the corner is the angle it left
        // the track at; the product is the miss the eye actually sees.
        const chord = atEnd ? after : before;
        const miss = chord * Math.sin((deflection * Math.PI) / 180);
        if (miss <= MISS_OK_METERS) continue;
        problems.push({
          code: "route_approach_elbow",
          severity: miss >= MISS_ERROR_METERS ? "ERROR" : "WARNING",
          meters: miss,
          degrees: deflection,
          at: coordinates[index],
          detail:
            `${label}: leaves the track ${deflection.toFixed(0)}° for a ${chord.toFixed(0)} m ` +
            `chord to the ${atEnd ? "arriving" : "departing"} platform, ` +
            `which stands ${miss.toFixed(0)} m off the rail the hop is drawn on`,
        });
        continue;
      }

      problems.push({
        code: "route_interior_elbow",
        severity: deflection >= TURN_ERROR_DEGREES ? "ERROR" : "WARNING",
        degrees: deflection,
        at: coordinates[index],
        detail:
          `${label}: ${deflection.toFixed(0)}° corner in open track ` +
          `(edges ${before.toFixed(0)} m / ${after.toFixed(0)} m, ambient ${ambient.toFixed(0)}°)`,
      });
    }
  }
  return problems.map((problem) => ({ ...problem, ...context, hop: label }));
}

export function auditCountry(country, options = {}) {
  const packageFile = path.join(APP_DIR, "public/rail", `${country}-2025.json`);
  const partsDir = path.join(APP_DIR, PARTS_DIR[country] || "");
  if (!fs.existsSync(packageFile) || !fs.existsSync(partsDir)) return null;
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  if (!network) return null;

  const findings = [];
  let trains = 0;
  let hops = 0;
  let uncanonical = 0;
  for (const name of fs.readdirSync(partsDir).sort()) {
    if (!name.startsWith("part-") || !name.endsWith(".json")) continue;
    const payload = JSON.parse(fs.readFileSync(path.join(partsDir, name), "utf8"));
    const train = payload.train || {};
    if (options.train && train.id !== options.train) continue;
    const features = payload.route?.features || [];
    if (!features.length) continue;
    trains += 1;
    for (const hop of drawnHopsForTrain(network, features)) {
      hops += 1;
      if (!hop.canonical) uncanonical += 1;
      findings.push(
        ...auditHop(hop, {
          country,
          train: train.id,
          number: train.number || "",
          segment: hop.drawn.properties?.segment_index ?? null,
          lineIds: hop.drawn.properties?.display_line_ids || [],
          source: hop.canonical ? "all-railways-complete-line" : "route-solver-path",
        }),
      );
    }
  }
  return { country, trains, hops, uncanonical, findings };
}

// ── reporting ───────────────────────────────────────────────────────────────

function parseArguments(argv) {
  const options = { all: false, strict: false, json: null, country: null, train: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--all") options.all = true;
    else if (token === "--strict") options.strict = true;
    else if (token === "--json") options.json = argv[++index];
    else if (token === "--country") options.country = argv[++index];
    else if (token === "--train") options.train = argv[++index];
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const countries = options.country ? [options.country] : COUNTRIES;
  const reports = [];
  let worst = "PASS";
  for (const country of countries) {
    const report = auditCountry(country, options);
    if (!report) continue;
    reports.push(report);
    const errors = report.findings.filter((row) => row.severity === "ERROR");
    const warnings = report.findings.filter((row) => row.severity === "WARNING");
    if (errors.length) worst = "ERROR";
    else if (warnings.length && worst === "PASS") worst = "WARNING";
    console.log(
      `${country}: ${report.trains} trains, ${report.hops} drawn hops ` +
        `(${report.uncanonical} on the solver's own path) — ` +
        `${errors.length} ERROR, ${warnings.length} WARNING`,
    );
    const shown = options.all ? report.findings : [...errors, ...warnings];
    for (const row of shown.sort(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
        (b.meters || b.degrees || 0) - (a.meters || a.degrees || 0),
    ))
      console.log(
        `  ${row.severity.padEnd(7)} ${row.code.padEnd(26)} ` +
          `${row.at[0].toFixed(5)},${row.at[1].toFixed(5)}  ${row.train} #${row.segment}  ` +
          `[${row.lineIds.join(" ") || row.source}]  ${row.detail}`,
      );
  }
  if (options.json)
    fs.writeFileSync(options.json, `${JSON.stringify(reports, null, 2)}\n`);
  if (options.strict && worst === "ERROR") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
