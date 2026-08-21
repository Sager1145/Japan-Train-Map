#!/usr/bin/env node
/*
 * validate-station-approach-chords.mjs — the standing "does the DRAWN NETWORK
 * reach its own station along a rail?" audit.
 *
 * Three audits already stand near this question and none of them can see the
 * defect this one is for:
 *
 *   validate-station-render-anchoring.mjs  asks whether the dot sits ON the
 *       drawn line. A chord swung across the station passes: it ends exactly
 *       on the dot, which is the whole reason it was drawn.
 *   validate-basemap-alignment.mjs         asks how far the line is from OSM,
 *       but aggregates contiguous >50 m samples into findings of >=150 m. A
 *       200 m chord that peaks at 84 m in the middle and lands back on track
 *       at both ends never fills that window. 岸里玉出 scored CLEAN there.
 *   validate-route-station-approach.mjs    asks the same of a RIDE, not of the
 *       network stroke every reader sees whether or not a train is drawn.
 *
 * The defect: `build-japan-package-from-inventory.py` cuts each interval from
 * the platform feature it picked for that (line, station group). Where several
 * N02 features carry one group — a 複々線 station whose lines stand on separate
 * island platforms — picking the wrong one puts the interval's first vertex on
 * ANOTHER line's platform, and the cut then runs a straight line back across
 * the station to the track its own line actually uses. 南海 高野線 opened
 * 岸里玉出 → 帝塚山 with 211 m of it, drawn straight through the blocks between
 * the two platform groups.
 *
 * So: sample the first and last APPROACH_WINDOW_METERS of every interval, and
 * measure each sample to the nearest active OSM rail. Report a spike there
 * that the rest of the interval does not share — a line drawn on a stale
 * alignment for its whole length is the basemap audit's finding, not this
 * one's, and a line whose survey is systematically offset must not be reported
 * twice.
 *
 * Reported per interval end:
 *   station_approach_chord   the run into (or out of) a station leaves the
 *                            rails, while the rest of the interval is on them
 *
 * Usage:
 *   node scripts/validation/validate-station-approach-chords.mjs
 *   node scripts/validation/validate-station-approach-chords.mjs --country tw
 *   node scripts/validation/validate-station-approach-chords.mjs --all --json out.json
 *
 * Reads the SAME machine-local OSM cell cache as validate-basemap-alignment
 * (<repo>/outputs/osm-basemap-cache, filled by that script's --fetch), so it is
 * not part of npm test / CI for the same reason: the cache is not committed.
 * Exit code is 0 unless --strict is given, in which case any ERROR fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  pathLengthMeters,
  resample,
} from "../railway/lib/railway-topology.mjs";
import {
  cachedCells,
  loadOsmTrackIndex,
} from "../railway/lib/osm-basemap-cache.mjs";
import { createEdgeIndex } from "../railway/lib/railway-topology.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];
const packageFileFor = (country) => path.join(APP_DIR, `public/rail/${country}-2025.json`);

// ── thresholds ───────────────────────────────────────────────────────────────

// How much of each interval end is "the approach". Long enough to hold the
// chord 岸里玉出 drew (211 m), short enough that an interval's own body is
// still what sets the ambient.
const APPROACH_WINDOW_METERS = 300;
// Sampling step inside the window, and the coarser one used for the ambient.
const APPROACH_STEP_METERS = 10;
const BODY_STEP_METERS = 40;

// A drawn line stands a few metres off the OSM centre-line wherever the two
// surveys disagree, and a platform anchor pulls it a few more. Past this it is
// not on the rails at all.
const OFF_TRACK_WARNING_METERS = 25;
const OFF_TRACK_ERROR_METERS = 45;
// The rest of the interval has to be ON the basemap for the end to be a spike
// rather than the tail of a line-long disagreement. Above this the interval
// belongs to validate-basemap-alignment's report, not to this one.
const AMBIENT_CEILING_METERS = 15;
// And the spike has to clear the ambient by this much, so a survey offset of
// 14 m does not become a 25 m "chord" wherever it happens to peak.
const SPIKE_OVER_AMBIENT_METERS = 15;
// Below this an interval has no body to take an ambient from: the whole thing
// is inside the two windows and any measurement is circular.
const MIN_INTERVAL_METERS = 700;
// Samples further than this from any rail are not measurement, they are a gap
// in the cache (an uncached cell, or a line OSM has never mapped). The nearest
// lookup only searches its 3x3 neighbourhood anyway.
const NO_RAIL_WITHIN_METERS = 900;

const SEVERITY_ORDER = { PASS: 0, WARNING: 1, ERROR: 2 };

// ── package loading ──────────────────────────────────────────────────────────

/** Intervals with their drawn coordinates, station names and end anchors. */
function loadIntervals(country) {
  const pkg = JSON.parse(fs.readFileSync(packageFileFor(country), "utf8"));
  const rows = [];
  for (const line of pkg.lines || []) {
    const stations = line.stations || [];
    (line.segments || []).forEach((segment, index) => {
      const from = stations[index];
      const to = stations[(index + 1) % stations.length];
      // `segments[i][1] === 0` carries its own first vertex; anything else
      // opens on the previous station's anchor, which the package stores once.
      const coordinates =
        segment[1] === 0
          ? segment[2]
          : [[from[2], from[3]], ...segment[2]];
      if (!coordinates || coordinates.length < 2) return;
      rows.push({
        lineId: line.id,
        lineName: line.name,
        operator: line.operator,
        index,
        from: from?.[1] ?? `#${index}`,
        to: to?.[1] ?? `#${index + 1}`,
        fromGroup: from?.[0] ?? null,
        toGroup: to?.[0] ?? null,
        coordinates,
      });
    });
  }
  return { version: pkg.version, rows };
}

// ── measuring ────────────────────────────────────────────────────────────────

/**
 * The samples of one interval, tagged by which part of it they came from.
 *
 * `resample` reports each sample's own chainage, so the two windows are cut by
 * measure rather than by counting steps — a sample lands on every vertex too,
 * and those extra points would otherwise shorten the window they fall in.
 */
function sampleInterval(coordinates) {
  const total = pathLengthMeters(coordinates);
  const approach = Math.min(APPROACH_WINDOW_METERS, total / 3);
  const walk = resample(coordinates, APPROACH_STEP_METERS);
  const body = resample(coordinates, BODY_STEP_METERS).map((row) => row.point);
  const head = walk.filter((row) => row.measure <= approach).map((row) => row.point);
  const tail = walk
    .filter((row) => total - row.measure <= approach)
    .map((row) => row.point)
    .reverse();
  return { total, approach, head, tail, body };
}

/**
 * Nearest ACTIVE rail of any kind — sidings, spurs and yard throats included.
 *
 * The question here is not whose track this is (that is the basemap audit's
 * attribution pass) but whether there is track under the drawn line at all. A
 * terminal's own platform road is often filed `service=siding` in OSM, and
 * excluding those would report every stub-end station as a chord.
 */
function nearestActiveRail(index, point) {
  const nearest = index.nearest(point);
  if (!nearest || nearest.distance > NO_RAIL_WITHIN_METERS) return null;
  return nearest;
}

// Lifecycle states meaning the metals are gone or out of service, spelled the
// way validate-basemap-alignment spells them (the cells are fetched once, for
// both audits).
const DEAD_RAILWAY = new Set(["disused", "abandoned", "razed", "dismantled"]);

/**
 * A second index over the alignments OSM says are NO LONGER RUNNING.
 *
 * A drawn line sitting on one of those is a stale alignment or a suspended
 * section — 津軽線 蟹田–三厩 has been out since the 2022 rainfall and the
 * basemap audit's ledger already adjudicates it. Reporting it again here as a
 * "chord" would be a second opinion on a settled question, so a run with dead
 * metals under it is passed over: this audit is only for the runs with NO
 * track of any kind beneath them.
 */
function loadDeadTrackIndex(cacheDir) {
  const index = createEdgeIndex(0.005);
  const seen = new Set();
  let ways = 0;
  for (const cell of cachedCells(cacheDir)) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(cell.file, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(record?.elements)) continue;
    for (const way of record.elements) {
      if (seen.has(way.id)) continue;
      seen.add(way.id);
      if (!DEAD_RAILWAY.has((way.tags || {}).railway)) continue;
      const coordinates = (way.geometry || []).map((node) => [node.lon, node.lat]);
      if (coordinates.length < 2) continue;
      index.add(coordinates, { id: way.id, name: way.tags.name || null });
      ways += 1;
    }
  }
  return { index, ways };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measureEnd(index, dead, points) {
  let worst = null;
  const distances = [];
  for (const point of points) {
    const nearest = nearestActiveRail(index, point);
    if (!nearest) continue;
    // Standing on a lifted or suspended alignment is the other audit's finding.
    const buried = dead ? dead.nearest(point) : null;
    const distance =
      buried && buried.distance < nearest.distance ? buried.distance : nearest.distance;
    distances.push(distance);
    if (!worst || distance > worst.distance)
      worst = { distance, point, meta: nearest.meta };
  }
  return { worst, median: median(distances), measured: distances.length };
}

/** The contiguous length at the end of `points` that is off the rails. */
function offTrackRunMeters(index, dead, points) {
  const offTrackAt = (point) => {
    const nearest = nearestActiveRail(index, point);
    if (!nearest || nearest.distance < OFF_TRACK_WARNING_METERS) return false;
    const buried = dead ? dead.nearest(point) : null;
    return !buried || buried.distance >= OFF_TRACK_WARNING_METERS;
  };
  let run = 0;
  for (let cursor = 0; cursor + 1 < points.length; cursor += 1) {
    if (!offTrackAt(points[cursor])) continue;
    let end = cursor;
    while (end + 1 < points.length) {
      if (!offTrackAt(points[end + 1])) break;
      end += 1;
    }
    run = Math.max(run, pathLengthMeters(points.slice(cursor, end + 1)));
    cursor = end;
  }
  return run;
}

export function auditCountry(country, options = {}) {
  const file = packageFileFor(country);
  if (!fs.existsSync(file)) return null;
  const index = options.index || loadOsmTrackIndex({ cacheDir: options.cacheDir }).index;
  const dead = options.dead || loadDeadTrackIndex(options.cacheDir).index;
  const { version, rows } = loadIntervals(country);
  const findings = [];
  let intervals = 0;
  let skippedShort = 0;
  let skippedAmbient = 0;
  for (const row of rows) {
    const { total, head, tail, body } = sampleInterval(row.coordinates);
    if (total < MIN_INTERVAL_METERS) {
      skippedShort += 1;
      continue;
    }
    intervals += 1;
    const bodyDistances = [];
    for (const point of body) {
      const nearest = nearestActiveRail(index, point);
      if (nearest) bodyDistances.push(nearest.distance);
    }
    const ambient = median(bodyDistances);
    if (ambient === null) continue; // nothing cached here; not a measurement
    if (ambient > AMBIENT_CEILING_METERS) {
      skippedAmbient += 1;
      continue; // the whole interval disagrees — the basemap audit's finding
    }
    for (const [side, points, station, group] of [
      ["arriving", head, row.from, row.fromGroup],
      ["departing", tail, row.to, row.toGroup],
    ]) {
      const { worst, measured } = measureEnd(index, dead, points);
      if (!worst || !measured) continue;
      if (worst.distance < OFF_TRACK_WARNING_METERS) continue;
      if (worst.distance - ambient < SPIKE_OVER_AMBIENT_METERS) continue;
      const offTrack = offTrackRunMeters(index, dead, points);
      findings.push({
        severity:
          worst.distance >= OFF_TRACK_ERROR_METERS ? "ERROR" : "WARNING",
        code: "station_approach_chord",
        country,
        lineId: row.lineId,
        line: `${row.operator}／${row.lineName}`,
        interval: `${row.from} → ${row.to}`,
        station,
        stationGroup: group,
        side,
        maxOffTrackMeters: Number(worst.distance.toFixed(1)),
        ambientMeters: Number(ambient.toFixed(1)),
        offTrackRunMeters: Number(offTrack.toFixed(0)),
        at: worst.point.map((value) => Number(value.toFixed(5))),
        nearestWay: worst.meta?.id ?? null,
        nearestWayName: worst.meta?.name ?? null,
      });
    }
  }
  findings.sort(
    (left, right) =>
      SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity] ||
      right.maxOffTrackMeters - left.maxOffTrackMeters,
  );
  return { country, version, intervals, skippedShort, skippedAmbient, findings };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main(argv) {
  const options = { countries: ["jp"], json: null, strict: false, all: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--country") options.countries = [argv[++index]];
    else if (arg === "--all") options.countries = [...COUNTRIES];
    else if (arg === "--json") options.json = path.resolve(argv[++index]);
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--cache-dir") options.cacheDir = path.resolve(argv[++index]);
  }
  const loaded = loadOsmTrackIndex({ cacheDir: options.cacheDir });
  const buried = loadDeadTrackIndex(options.cacheDir);
  process.stdout.write(
    `OSM cache: ${loaded.cells.length} cells, ${loaded.ways} active ways, ` +
      `${buried.ways} disused/abandoned/razed` +
      `${loaded.oldestFetch ? `, oldest ${loaded.oldestFetch}` : ""}\n`,
  );
  const reports = [];
  let worst = 0;
  for (const country of options.countries) {
    const report = auditCountry(country, { index: loaded.index, dead: buried.index });
    if (!report) continue;
    reports.push(report);
    const errors = report.findings.filter((row) => row.severity === "ERROR");
    const warnings = report.findings.filter((row) => row.severity === "WARNING");
    worst = Math.max(worst, errors.length ? 2 : warnings.length ? 1 : 0);
    process.stdout.write(
      `${country}: ${report.intervals} intervals measured ` +
        `(${report.skippedShort} shorter than ${MIN_INTERVAL_METERS} m, ` +
        `${report.skippedAmbient} off the basemap for their whole length) — ` +
        `${errors.length} ERROR, ${warnings.length} WARNING\n`,
    );
    for (const finding of report.findings) {
      process.stdout.write(
        `  ${finding.severity.padEnd(7)} ${finding.at.join(",")}  ` +
          `${finding.line} ${finding.interval}: the ${finding.side} run leaves ` +
          `the rails by ${finding.maxOffTrackMeters} m over ${finding.offTrackRunMeters} m ` +
          `at ${finding.station} (rest of the interval sits ${finding.ambientMeters} m off)\n`,
      );
    }
  }
  if (options.json)
    fs.writeFileSync(options.json, `${JSON.stringify(reports, null, 1)}\n`);
  if (options.strict && worst === 2) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
