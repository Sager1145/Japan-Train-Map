#!/usr/bin/env node
/*
 * validate-station-render-anchoring.mjs — the standing station-approach audit.
 *
 * One rule, measured four ways: THE DRAWN RAILWAY PASSES THROUGH THE CENTRE OF
 * EVERY STATION CIRCLE IT CALLS AT, and ENDS on the centre of its terminal one.
 * Not near it, not joined to it by a connector — through it, arriving along the
 * track's own heading.
 *
 * Reported per station:
 *
 *   station_distance_to_render_line   platform centre → drawn line
 *   terminal_endpoint_distance        terminal platform → the stroke's last
 *                                     coordinate; a terminal must STOP on it
 *   station_approach_max_turn         sharpest corner within the approach
 *                                     window either side of the platform
 *   station_approach_curvature_spike  that corner against the curvature the
 *                                     rest of the window is turning at, which
 *                                     is what separates an artificial elbow
 *                                     from a railway that is simply on a curve
 *   station_anchor_displacement       how far the approach pass had to move
 *                                     the alignment to reach the platform
 *
 * Defect classes:
 *
 *   station_not_on_render_line     the line that calls here never reaches it
 *   station_off_render_line        drawn, but the platform is not ON the line
 *   terminal_not_at_endpoint       a terminal that does not stop on its dot
 *   station_approach_hard_turn     an elbow at the platform
 *   station_render_anchor_suspicious  a displacement too large to be a
 *                                     platform offset — read as a data fault
 *                                     (wrong line matched, wrong endpoint,
 *                                     wrong stop group), never smoothed away
 *
 * Usage:
 *   node scripts/validation/validate-station-render-anchoring.mjs              # everywhere
 *   node scripts/validation/validate-station-render-anchoring.mjs --country jp
 *   node scripts/validation/validate-station-render-anchoring.mjs --lines 東海道線
 *   node scripts/validation/validate-station-render-anchoring.mjs --all        # every row
 *   node scripts/validation/validate-station-render-anchoring.mjs --json out.json
 *
 * Exit code is 0 unless --strict is given, in which case any ERROR fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import {
  distanceMeters,
  pointSegmentDistanceMeters,
  turnDegrees,
} from "../railway/lib/railway-topology.mjs";

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const RailNetwork = require(path.join(APP_DIR, "public/rail-network.js"));

const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];

// ── thresholds ───────────────────────────────────────────────────────────────

// Everything on screen is judged in PIXELS, because that is the unit the defect
// is visible in: half a metre at a terminal is nothing, half a metre on a tram
// stop you are zoomed into is the gap the eye catches. Measured at the closest
// zoom the map allows, so a station that passes here passes everywhere.
const REFERENCE_ZOOM = 18;
const TILE_SIZE = 512;

// A platform is ON the line or it is not. The pass makes the anchor a literal
// vertex of the drawn geometry, so anything above float noise is a real defect.
const ON_LINE_MAX_PX = 0.25;

// Corner severity, in degrees of deflection at one vertex. Under 30° is a
// railway curve and is not reported at all.
const TURN_SUSPICIOUS_DEGREES = 60;
const TURN_ERROR_DEGREES = 90;

// How far either side of the platform counts as its approach.
const APPROACH_WINDOW_METERS = 300;

// A corner is only artificial if the track is not already turning that hard.
// A tram rounding a city block and a switchback both turn far more sharply
// than this over their whole approach, and neither is a defect: the spike is
// the corner divided by the sharpest OTHER corner in the same window.
const CURVATURE_SPIKE_RATIO = 3;
// Below this the window is essentially straight and any ratio against it is
// meaningless, so the corner is judged on its own size alone.
const CURVATURE_FLOOR_DEGREES = 8;

// Beyond this the platform is not off its track, the data is wrong. Mirrors
// rail-network.js ANCHOR_MAX_DISPLACEMENT_METERS, which declines to reshape an
// approach this far out rather than hide the fault under a graceful curve.
const DISPLACEMENT_SUSPICIOUS_METERS = 250;
// A platform this far off the alignment is still drawn through, but it is
// worth a human deciding whether the anchor or the geometry is wrong.
const DISPLACEMENT_CHECK_METERS = 60;

const SEVERITY_ORDER = { PASS: 0, WARNING: 1, ERROR: 2 };

function metersPerPixel(latitude) {
  return (
    (40075016.686 * Math.cos((latitude * Math.PI) / 180)) /
    (TILE_SIZE * 2 ** REFERENCE_ZOOM)
  );
}

function toPixels(meters, latitude) {
  return meters / metersPerPixel(latitude);
}

// ── geometry ────────────────────────────────────────────────────────────────

function coordinateKey(coordinate) {
  return `${coordinate[0]},${coordinate[1]}`;
}

/** Distance from `point` to the polyline. */
function distanceToPart(coordinates, point) {
  let best = Infinity;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const distance = pointSegmentDistanceMeters(
      point,
      coordinates[index],
      coordinates[index + 1],
    );
    if (distance < best) best = distance;
  }
  return best;
}

/**
 * Where the polyline passes closest to `point`, as an edge and a position
 * along it. Read structurally rather than by comparing distances, so "the
 * platform is past the end of what we can read" is answered by WHERE the
 * nearest point is and never by two float projections agreeing.
 */
function nearestCut(coordinates, point) {
  let best = null;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const a = coordinates[index];
    const b = coordinates[index + 1];
    const latitude = point[1];
    const scale = Math.cos((latitude * Math.PI) / 180) || 1;
    const metric = (row) => [row[0] * 111320 * scale, row[1] * 111320];
    const p = metric(point);
    const from = metric(a);
    const to = metric(b);
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const lengthSquared = dx * dx + dy * dy;
    const ratio = lengthSquared
      ? Math.max(
          0,
          Math.min(1, ((p[0] - from[0]) * dx + (p[1] - from[1]) * dy) / lengthSquared),
        )
      : 0;
    const distance = Math.hypot(
      p[0] - (from[0] + ratio * dx),
      p[1] - (from[1] + ratio * dy),
    );
    if (!best || distance < best.distance) best = { index, ratio, distance };
  }
  return best;
}

/**
 * The corners inside the approach window around `index`, sharpest first.
 *
 * Reported as a pair — the corner AT the platform and the sharpest anywhere in
 * the window — because a station that sits inside a curve is not a defect and
 * the two numbers together are what says so.
 */
function approachTurns(coordinates, index) {
  const turns = [];
  const walk = (step) => {
    let travelled = 0;
    for (
      let cursor = index;
      cursor > 0 && cursor < coordinates.length - 1;
      cursor += step
    ) {
      const deflection = turnDegrees(
        coordinates[cursor - 1],
        coordinates[cursor],
        coordinates[cursor + 1],
      );
      turns.push({ index: cursor, deflection });
      const next = cursor + step;
      if (next < 0 || next >= coordinates.length) break;
      travelled += distanceMeters(coordinates[cursor], coordinates[next]);
      if (travelled >= APPROACH_WINDOW_METERS) break;
    }
  };
  walk(-1);
  walk(1);
  const atStation = turns.find((row) => row.index === index);
  const others = turns.filter((row) => row.index !== index);
  return {
    atStation: atStation ? atStation.deflection : 0,
    ambient: others.length
      ? Math.max(...others.map((row) => row.deflection))
      : 0,
    max: turns.length ? Math.max(...turns.map((row) => row.deflection)) : 0,
  };
}

/** The package's station intervals, endpoints welded to their platforms. */
function decodeIntervals(compactLine) {
  const stationCount = compactLine.stations.length;
  const intervals = [];
  let previousLast = null;
  compactLine.segments.forEach((row, index) => {
    const decoded = row[1]
      ? [previousLast].concat(row[2].map((c) => [c[0], c[1]]))
      : row[2].map((c) => [c[0], c[1]]);
    const start = compactLine.stations[index];
    const end = compactLine.stations[(index + 1) % stationCount];
    decoded[0] = [start[2], start[3]];
    decoded[decoded.length - 1] = [end[2], end[3]];
    previousLast = decoded[decoded.length - 1];
    intervals.push(decoded);
  });
  return intervals;
}

/**
 * How far the approach pass had to move the alignment to reach this platform.
 *
 * Measured from the PACKAGE, not from the drawn line: the two intervals that
 * meet at the station, read straight through with the anchor lifted out, are
 * the surveyed track, and the platform's distance from it is the displacement
 * the renderer then has to absorb. Recomputed here rather than exported from
 * the renderer so the audit is a second opinion, not an echo.
 *
 * `beyondEnd` says the platform lies past the last surveyed vertex its line
 * has, which only a terminal can do. There is no track there to be off, so
 * there is no displacement to report — the renderer draws the package's own
 * final edge and this audit says so rather than inventing a number.
 */
function anchorDisplacement(compactLine, intervals, stationIndex) {
  const stationCount = compactLine.stations.length;
  const closed = intervals.length >= stationCount;
  const incomingIndex =
    stationIndex > 0 ? stationIndex - 1 : closed ? intervals.length - 1 : -1;
  const outgoingIndex = stationIndex < intervals.length ? stationIndex : -1;
  const incoming = incomingIndex >= 0 ? intervals[incomingIndex] : null;
  const outgoing = outgoingIndex >= 0 ? intervals[outgoingIndex] : null;
  const head = incoming ? incoming.slice(0, -1) : [];
  let tail = outgoing ? outgoing.slice(1) : [];
  if (
    head.length &&
    tail.length &&
    coordinateKey(head[head.length - 1]) === coordinateKey(tail[0])
  )
    tail = tail.slice(1);
  const row = compactLine.stations[stationIndex];
  const anchor = [row[2], row[3]];
  const path = head.concat(tail);
  if (path.length < 2) return { meters: null, beyondEnd: false };
  const cut = nearestCut(path, anchor);
  if (!cut) return { meters: null, beyondEnd: false };
  const beyondEnd =
    (!incoming && cut.index === 0 && cut.ratio <= 0) ||
    (!outgoing && cut.index === path.length - 2 && cut.ratio >= 1);
  return { meters: cut.distance, beyondEnd };
}

// ── audit ───────────────────────────────────────────────────────────────────

export function auditCountry(country, options = {}) {
  const file = path.join(APP_DIR, "public/rail", `${country}-2025.json`);
  if (!fs.existsSync(file)) return null;
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  if (!network) return null;
  const compactById = new Map(pkg.lines.map((line) => [line.id, line]));
  const interchangeByStationId = new Map(
    network.stations.features.map((feature) => [
      feature.properties.stationId,
      feature.properties.interchange === 1,
    ]),
  );
  // Which platforms are drawn in a parallel lane, and which sit on a shared
  // centre-line because every railway in the bundle calls there. The second
  // kind is one station with one marker between two lanes BY DESIGN, so it is
  // measured against the un-offset geometry and never against a lane.
  const lanedStationIds = new Set(
    (network.stationLanes?.features || []).map(
      (feature) => feature.properties.stationId,
    ),
  );

  const rows = [];
  for (const line of network.lineById.values()) {
    if (options.lines && !options.lines.includes(line.name)) continue;
    const compactLine = compactById.get(line.lineId);
    if (!compactLine) continue;
    const intervals = decodeIntervals(compactLine);
    const parts = line.parts || [];
    const stationIds = line.stationOrder || [];
    stationIds.forEach((stationId, stationIndex) => {
      const station = network.stationById.get(stationId);
      if (!station) return;
      const anchor = [station.lon, station.lat];
      const key = coordinateKey(anchor);

      let found = null;
      parts.forEach((coordinates, partIndex) => {
        if (found) return;
        const index = coordinates.findIndex(
          (coordinate) => coordinateKey(coordinate) === key,
        );
        if (index >= 0) found = { partIndex, coordinates, index };
      });

      const nearestMeters = parts.length
        ? Math.min(...parts.map((coordinates) => distanceToPart(coordinates, anchor)))
        : Infinity;
      const displacement = anchorDisplacement(
        compactLine,
        intervals,
        stationIndex,
      );
      const isLineTerminal =
        !line.isLoop &&
        (stationIndex === 0 || stationIndex === stationIds.length - 1);

      const row = {
        country,
        station: station.name,
        stationId,
        railway: `${line.operator} ${line.name}`,
        lineId: line.lineId,
        renderMode: interchangeByStationId.get(stationId)
          ? "INTERCHANGE_DOT"
          : "SINGLE_DOT",
        lane: lanedStationIds.has(stationId) ? "lane" : "centre-line",
        role: isLineTerminal ? "Terminal" : "Through",
        distancePx: toPixels(nearestMeters, station.lat),
        distanceMeters: nearestMeters,
        endpointPx: null,
        maxTurn: 0,
        turnAtStation: 0,
        curvatureSpike: 0,
        displacementMeters: displacement.beyondEnd ? null : displacement.meters,
        beyondEnd: displacement.beyondEnd,
        problems: [],
      };

      if (!found) {
        row.problems.push({
          code: "station_not_on_render_line",
          severity: "ERROR",
          detail: `${line.name} never reaches ${station.name}: nearest drawn track is ${nearestMeters.toFixed(0)} m away`,
        });
      } else {
        const { coordinates, index } = found;
        row.distancePx = 0;
        row.distanceMeters = 0;
        const atEnd = index === 0 || index === coordinates.length - 1;
        row.role = atEnd ? "Terminal" : "Through";
        if (atEnd) {
          const endpoint = index === 0 ? coordinates[0] : coordinates[index];
          row.endpointPx = toPixels(
            distanceMeters(anchor, endpoint),
            station.lat,
          );
          if (row.endpointPx > ON_LINE_MAX_PX)
            row.problems.push({
              code: "terminal_not_at_endpoint",
              severity: "ERROR",
              detail: `stroke ends ${row.endpointPx.toFixed(2)} px from the platform centre`,
            });
        } else {
          const turns = approachTurns(coordinates, index);
          row.maxTurn = turns.max;
          row.turnAtStation = turns.atStation;
          row.curvatureSpike =
            turns.ambient > 0 ? turns.atStation / turns.ambient : 0;
          // An elbow is a corner AT the platform that the rest of the approach
          // does not explain. A window that is turning just as hard everywhere
          // is a railway on a curve, and is left alone.
          const isolated =
            turns.ambient < CURVATURE_FLOOR_DEGREES ||
            row.curvatureSpike >= CURVATURE_SPIKE_RATIO;
          if (turns.atStation >= TURN_ERROR_DEGREES && isolated)
            row.problems.push({
              code: "station_approach_hard_turn",
              severity: "ERROR",
              detail: `${turns.atStation.toFixed(0)}° at the platform (window turns at most ${turns.ambient.toFixed(0)}° elsewhere)`,
            });
          else if (turns.atStation >= TURN_SUSPICIOUS_DEGREES && isolated)
            row.problems.push({
              code: "station_approach_hard_turn",
              severity: "WARNING",
              detail: `${turns.atStation.toFixed(0)}° at the platform (window turns at most ${turns.ambient.toFixed(0)}° elsewhere)`,
            });
        }
      }

      if (row.displacementMeters != null) {
        if (row.displacementMeters > DISPLACEMENT_SUSPICIOUS_METERS)
          row.problems.push({
            code: "station_render_anchor_suspicious",
            severity: "ERROR",
            detail: `platform sits ${row.displacementMeters.toFixed(0)} m off its own surveyed track — check the line match, the endpoint and the stop group before smoothing anything`,
          });
        else if (row.displacementMeters > DISPLACEMENT_CHECK_METERS)
          row.problems.push({
            code: "station_render_anchor_displaced",
            severity: "WARNING",
            detail: `approach moved ${row.displacementMeters.toFixed(0)} m to reach the platform`,
          });
      }

      row.severity = row.problems.reduce(
        (worst, problem) =>
          SEVERITY_ORDER[problem.severity] > SEVERITY_ORDER[worst]
            ? problem.severity
            : worst,
        "PASS",
      );
      rows.push(row);
    });
  }

  return { country, rows };
}

// ── report ──────────────────────────────────────────────────────────────────

function renderRow(row) {
  const lines = [
    `Station:                ${row.station}  (${row.country})`,
    `Railway:                ${row.railway}`,
    `RenderMode:             ${row.renderMode} on the ${row.lane}`,
    `Through / Terminal:     ${row.role}`,
    `Distance to Render Line: ${row.distancePx.toFixed(2)} px`,
    `Endpoint Distance:      ${row.endpointPx == null ? "—" : `${row.endpointPx.toFixed(2)} px`}`,
    `Max Turn:               ${row.maxTurn.toFixed(0)}° (${row.turnAtStation.toFixed(0)}° at the platform, spike ×${row.curvatureSpike.toFixed(1)})`,
    `Anchor Displacement:    ${row.displacementMeters == null ? (row.beyondEnd ? "— (platform beyond the last surveyed vertex)" : "—") : `${row.displacementMeters.toFixed(1)} m`}`,
    `${row.severity}`,
  ];
  for (const problem of row.problems)
    lines.push(`  ${problem.severity} ${problem.code}: ${problem.detail}`);
  return lines.join("\n");
}

export function renderReport(report, options = {}) {
  const counts = { PASS: 0, WARNING: 0, ERROR: 0 };
  for (const row of report.rows) counts[row.severity] += 1;
  const byCode = new Map();
  for (const row of report.rows)
    for (const problem of row.problems)
      byCode.set(problem.code, (byCode.get(problem.code) || 0) + 1);

  const out = [
    `${report.country}: ${report.rows.length} platforms — ${counts.PASS} PASS, ${counts.WARNING} WARNING, ${counts.ERROR} ERROR`,
  ];
  for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1]))
    out.push(`  ${count.toString().padStart(5)}  ${code}`);
  const shown = options.all
    ? report.rows
    : report.rows.filter((row) => row.severity !== "PASS");
  if (shown.length) {
    out.push("");
    for (const row of shown.slice(0, options.limit || 40))
      out.push(renderRow(row), "");
    if (shown.length > (options.limit || 40))
      out.push(`  … ${shown.length - (options.limit || 40)} more`);
  }
  return out.join("\n");
}

function parseArgs(argv) {
  const options = { strict: false, all: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--country") options.country = argv[++index];
    else if (arg === "--json") options.json = argv[++index];
    else if (arg === "--lines")
      options.lines = argv[++index].split(",").filter(Boolean);
    else if (arg === "--limit") options.limit = Number(argv[++index]) || 40;
    else if (arg === "--all") options.all = true;
    else if (arg === "--strict") options.strict = true;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const countries = options.country ? [options.country] : COUNTRIES;
  const reports = [];
  let errors = 0;
  for (const country of countries) {
    const report = auditCountry(country, options);
    if (!report) continue;
    reports.push(report);
    process.stdout.write(`${renderReport(report, options)}\n\n`);
    errors += report.rows.filter((row) => row.severity === "ERROR").length;
  }
  if (options.json) {
    fs.writeFileSync(options.json, JSON.stringify(reports, null, 2));
    process.stdout.write(`wrote ${options.json}\n`);
  }
  if (options.strict && errors) process.exitCode = 1;
}

// Run only as a command; importing this module (tests) must not audit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
