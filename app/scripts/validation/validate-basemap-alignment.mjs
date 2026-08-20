#!/usr/bin/env node
/*
 * validate-basemap-alignment.mjs — the standing "drawn network vs OSM basemap"
 * audit, for any of the five countries.
 *
 * The map draws each package's own survey on top of an OSM-derived basemap
 * (OpenFreeMap). Where the two disagree the reader sees a railway floating
 * beside the faint basemap track — sometimes because WE drew a removed
 * alignment (a real defect), sometimes because the BASEMAP is the approximate
 * one (volunteer-digitised long tunnels). This audit measures the disagreement
 * and classifies it, re-running the 2026-08-18 one-off comparison (594/663 jp
 * lines clean) as a repeatable check.
 *
 * `--country jp|tw|hk|mo|kr` picks the package, the exclusions ledger and the
 * attribution pass's naming rules together; jp is the default because that is
 * the network the thresholds were calibrated on. Every country reads the SAME
 * cell cache — the grid is geographic, not national.
 *
 * Method (identical to the one-off):
 *   1. Cover the package's geometry with 1°×1° grid cells (~72 cells).
 *   2. Per cell, fetch every OSM railway-class way from Overpass
 *      (rail/light_rail/subway/tram/monorail/narrow_gauge/funicular/…,
 *      PLUS disused/abandoned/razed lifecycle ways so a package line hugging a
 *      REMOVED alignment can be recognised, PLUS highway=bus_guideway for the
 *      ガイドウェイバス annotation). Cached one JSON per cell; resumable.
 *   3. Sample every package line interval by interval at 30 m and take each
 *      sample's point-to-segment distance to the nearest ACTIVE OSM rail way.
 *   4. Aggregate contiguous >50 m samples into findings (≥150 m long), grade
 *      them, and de-noise via the adjudicated-exclusions ledger:
 *        app/data/raw/railway/jp/evidence/basemap-alignment-exclusions.json
 *
 * Severity:
 *   ERROR    the drawn line hugs a disused/abandoned/razed OSM way (≤25 m), or
 *            deviates ≥250 m — a stale-alignment / vacuum candidate.
 *   WARNING  75–250 m deviation with no removed-alignment evidence — review.
 *   INFO     50–75 m local wobble, or a whole-line systematic offset
 *            (median >10 m) — usually survey-style differences.
 *
 * Thresholds were smoke-tested on ゆいレール (沖縄都市モノレール線): station
 * anchoring pulls the drawn line to platform midpoints, a systematic ≤~18 m
 * offset from the OSM track centre-line, and the 50 m gate does not report it.
 *
 * Usage:
 *   node scripts/validation/validate-basemap-alignment.mjs --plan
 *       list the grid cells and their cache status; no network, no audit.
 *   node scripts/validation/validate-basemap-alignment.mjs --fetch
 *       download the missing cells into the cache, then audit. Resumable —
 *       already-cached cells are never re-fetched (delete a cell file to
 *       force). Full first fetch is ~72 Overpass queries ≈ 45–90 min with the
 *       default 3 s politeness gap (public instances 504 under evening load;
 *       the retry/backoff absorbs it). The audit itself runs in seconds
 *       (~2 s for 10 cells / 240k samples), so re-running against a warm
 *       cache is free. Cache size: ~14 MB for the Osaka cell, ~100–400 MB
 *       for all of Japan.
 *   node scripts/validation/validate-basemap-alignment.mjs
 *       audit against whatever is cached; samples in uncached cells are
 *       skipped and counted, never guessed at.
 *   node scripts/validation/validate-basemap-alignment.mjs \
 *       --fetch --cells E127N26,E135N34 --lines 沖縄都市モノレール線,福知山線
 *       the smoke slice: one known-clean line, one known defect.
 *   --country C        jp (default) · tw · hk · mo · kr
 *   --json out.json    full machine-readable report
 *   --all              print per-line stats for clean lines too, and every
 *                      wrong_track finding rather than the WARNING ones
 *   --show-excluded    print the findings the ledger suppressed
 *   --strict           exit 1 if any ERROR remains after the ledger
 *   --no-attribution   skip the wrong_track pass (distance audit only)
 *   --cache-dir DIR    override the cell cache location
 *   --endpoints a,b    Overpass mirrors (or env OVERPASS_ENDPOINTS)
 *   --sleep-ms N       politeness gap between Overpass requests (default 3000)
 *
 * ── the second criterion: whose track is this? ───────────────────────────────
 *
 * Everything above measures DISTANCE to the nearest active rail, and a line
 * drawn on the WRONG railway's metals is 0.2–1.3 m from a rail, so the 50 m
 * gate can never see it. 京浜急行電鉄's 空港線 leaves 京急蒲田 along 90 m of
 * 京急本線 track before cutting across to its own, and this audit scored the
 * whole line one of its 589 clean ones (median 1.97 m, p95 7.53 m, max 9.67 m).
 *
 * So a second pass asks ATTRIBUTION instead of distance: for every sample
 * sitting on a rail, does the way it is sitting on carry THIS LINE's name? The
 * identity test is scripts/railway/lib/track-attribution.mjs, which is
 * station-track-claim's ladder read at corridor scale. A `wrong_track` finding
 * needs all four of:
 *   · the stroke is ON a rail (≤ 8 m — floating is the other criterion's job),
 *   · that rail NAMES a railway, and the name is not this line's,
 *   · this line's own metals are mapped within 120 m SIDEWAYS (an endpoint
 *     distance is how far past the end of our name we have walked, not an
 *     offset — see lateralDistance), and
 *   · they are at least 15 m further away than the rail we are standing on.
 * Anything else is undecidable and reported as nothing.
 *
 * Graded, never judged. Where the line's own way is ≥ 40 m sideways the stroke
 * is on a different alignment (WARNING); below that it is the multi-track
 * corridor case — 東海道本線 / 京浜東北線 / 山手線 are 15–30 m apart and N02
 * draws one centre-line per railway — and is INFO. wrong_track findings are
 * counted SEPARATELY from off_basemap/systematic_offset and never raise ERROR,
 * so the standing distance counts stay comparable across runs.
 *
 * NOT part of npm test / CI: the first run needs the public Overpass API, and
 * the cache is machine-local. Run it by hand after geometry rebuilds, like
 * the Apple-maps check queue.
 *
 * Cache lives OUTSIDE app/ (default <repo>/outputs/osm-basemap-cache/) on
 * purpose: `npm run lint` (scripts/validation/check-source.mjs) JSON-parses
 * every *.json under app/, and ~150k cached OSM ways would add hundreds of MB
 * of parsing to every lint. <repo>/outputs/ is already gitignored.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createEdgeIndex,
  distanceMeters,
  resample,
} from "../railway/lib/railway-topology.mjs";
import {
  attributionFilterFor,
  axisDifference,
  bearingAt,
  ownTrackAt,
} from "../railway/lib/track-attribution.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_DIR = path.resolve(APP_DIR, "..");
const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];
const packageFileFor = (country) => path.join(APP_DIR, `public/rail/${country}-2025.json`);
// One ledger per country, beside that country's other adjudicated evidence.
// A country that has never needed an exclusion simply has no file, and
// `loadLedger` reads that as an empty ledger rather than an error.
const ledgerFileFor = (country) =>
  path.join(APP_DIR, `data/raw/railway/${country}/evidence/basemap-alignment-exclusions.json`);
const DEFAULT_CACHE_DIR = path.join(REPO_DIR, "outputs", "osm-basemap-cache");

// ── thresholds ───────────────────────────────────────────────────────────────
// Package intervals are sampled this often; ~1.1 M samples across the package.
const SAMPLE_STEP_METERS = 30;
// A sample farther than this from every active OSM rail way is "off basemap".
// ゆいレール tops out at ~18 m (station anchoring vs track centre-line), so
// 50 m tolerates the anchoring model and everything the render contract bends.
const OFF_BASEMAP_METERS = 50;
// …but only a sustained run of such samples is worth a finding.
const RUN_REPORT_METERS = 150;
// A drawn line this close to a disused/abandoned/razed OSM way is following a
// REMOVED alignment — the strongest "we drew the old line" signal there is.
const DEAD_HUG_METERS = 25;
// Beyond this the deviation is gross regardless of what is (not) nearby.
const VACUUM_DEVIATION_METERS = 250;
// Between the gate and this, the finding is a review item, not a verdict.
const REVIEW_DEVIATION_METERS = 75;
// Whole-line systematic offset (median over every sample) worth an INFO note.
const SYSTEMATIC_MEDIAN_METERS = 10;
// Edge-index bucket: 3×3 neighbourhood answers distances up to ~0.01° ≈ 1 km;
// anything farther reports as "no rail within ~1 km".
const INDEX_CELL_DEGREES = 0.01;
const NO_FEATURE_METERS = 9999;
// A jump between consecutive interval geometries closes any open run: branch
// strokes of one line are separate walks, not one continuous track.
const INTERVAL_JUMP_METERS = 100;
// Overpass bbox margin per cell, so a sample anywhere inside a cached cell can
// see every way within the ~1 km search radius without needing its neighbour.
const CELL_MARGIN_DEGREES = 0.02;

// ── thresholds: the attribution (wrong_track) criterion ──────────────────────
// Half the distance pass's step: the shape this is for is a junction lead-in
// tens of metres long, and 30 m samples straddle it.
const ATTRIBUTION_STEP_METERS = 15;
// Closer than this to a rail and the stroke is ON it. Beyond, "which track" is
// not the question any more — the distance criterion above is.
const ATTRIBUTION_ON_RAIL_METERS = 8;
// How far to look for the line's own metals before answering "cannot tell".
const ATTRIBUTION_OWN_RADIUS_METERS = 120;
// The own track has to be meaningfully further than the one we stand on, or
// the two are the same pair of rails digitised twice.
const ATTRIBUTION_SEPARATION_METERS = 15;
// One or two samples is a station throat crossing, not a run along a track.
const ATTRIBUTION_RUN_METERS = 45;
// Beyond this the line's own metals are a different alignment, not the next
// track over in the same corridor.
const ATTRIBUTION_ALIGNMENT_METERS = 40;

// OSM railway= values that are operating track (preserved = running heritage).
const ACTIVE_RAILWAY = new Set([
  "rail",
  "light_rail",
  "subway",
  "tram",
  "monorail",
  "narrow_gauge",
  "funicular",
  "miniature",
  "preserved",
]);
// Lifecycle states meaning the track is gone or out of service.
const DEAD_RAILWAY = new Set(["disused", "abandoned", "razed", "dismantled"]);
// Yard throats, sidings and crossovers are real rails no scheduled train is
// drawn along; the attribution pass must not claim one as a line's own track.
// Same vocabulary as scripts/railway/lib/osm-basemap-cache.mjs.
const NON_RUNNING_SERVICE = new Set(["yard", "siding", "spur", "crossover"]);

const OVERPASS_ENDPOINTS = (
  process.env.OVERPASS_ENDPOINTS ||
  "https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter"
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const USER_AGENT =
  "Japan-Train-Map/railway-basemap-audit (github.com/Sager1145/Japan-Train-Map; local data-quality audit)";

// ── package loading ──────────────────────────────────────────────────────────

function loadPackage(country) {
  const pkg = JSON.parse(fs.readFileSync(packageFileFor(country), "utf8"));
  const lines = pkg.lines.map((compact) => {
    const stations = compact.stations.map((row) => ({
      name: row[1],
      point: [row[2], row[3]],
    }));
    // One geometry row per station interval: N stations → N−1 rows (N on a
    // loop). Each row is [km, source, coordinates] with coordinates starting
    // on the from-station's anchor.
    const intervals = compact.segments.map((row, index) => ({
      index,
      from: stations[index]?.name ?? `#${index}`,
      to: stations[(index + 1) % stations.length]?.name ?? `#${index + 1}`,
      coordinates: row[2],
    }));
    return {
      lineId: compact.id,
      name: compact.name,
      operator: compact.operator,
      // The brand the timetables use — OSM files 東武鉄道's 日光線 as 東武日光線,
      // and the attribution pass reads that prefix off the package rather than
      // guessing it.
      operatorShort: compact.operatorShort,
      kind: compact.kind,
      country,
      stations,
      intervals,
    };
  });
  return { version: pkg.version, country, lines };
}

function cellOf(point) {
  return { e: Math.floor(point[0]), n: Math.floor(point[1]) };
}

function cellId(cell) {
  return `E${cell.e}N${cell.n}`;
}

/** Every 1° cell the package geometry touches (vertices + 200 m sub-steps). */
function gridCells(lines) {
  const cells = new Map();
  const add = (point) => {
    const cell = cellOf(point);
    cells.set(cellId(cell), cell);
  };
  for (const line of lines)
    for (const interval of line.intervals) {
      const coordinates = interval.coordinates;
      for (let index = 0; index < coordinates.length; index += 1) {
        add(coordinates[index]);
        if (index === 0) continue;
        const a = coordinates[index - 1];
        const b = coordinates[index];
        const span = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        const steps = Math.floor(span / 0.002);
        for (let step = 1; step <= steps; step += 1)
          add([a[0] + ((b[0] - a[0]) * step) / (steps + 1), a[1] + ((b[1] - a[1]) * step) / (steps + 1)]);
      }
    }
  return [...cells.values()].sort((x, y) => x.e - y.e || x.n - y.n);
}

// ── Overpass fetching + cache ────────────────────────────────────────────────

function cellCachePath(cacheDir, cell) {
  return path.join(cacheDir, `${cellId(cell)}.json`);
}

function readCellCache(cacheDir, cell) {
  const file = cellCachePath(cacheDir, cell);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.format === "osm-basemap-cell" && Array.isArray(parsed.elements)) return parsed;
  } catch {
    // fall through: a torn write is refetchable, not fatal
  }
  return null;
}

function overpassQuery(cell) {
  const south = cell.n - CELL_MARGIN_DEGREES;
  const west = cell.e - CELL_MARGIN_DEGREES;
  const north = cell.n + 1 + CELL_MARGIN_DEGREES;
  const east = cell.e + 1 + CELL_MARGIN_DEGREES;
  const bbox = `${south},${west},${north},${east}`;
  const railwayValues = [...ACTIVE_RAILWAY, ...DEAD_RAILWAY, "construction"].join("|");
  return (
    `[out:json][timeout:180];(` +
    `way["railway"~"^(${railwayValues})$"](${bbox});` +
    `way["disused:railway"](${bbox});` +
    `way["abandoned:railway"](${bbox});` +
    `way["razed:railway"](${bbox});` +
    `way["highway"="bus_guideway"](${bbox});` +
    `);out tags geom;`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCell(cell, options) {
  const query = overpassQuery(cell);
  const attempts = 6;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const endpoint = OVERPASS_ENDPOINTS[(options.endpointCursor + attempt) % OVERPASS_ENDPOINTS.length];
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(240000),
      });
      if (!response.ok) {
        // 429/504 are the public instances saying "later", not "never".
        process.stderr.write(`  ${cellId(cell)}: HTTP ${response.status} from ${endpoint}\n`);
        await sleep(Math.min(60000, 5000 * 2 ** attempt));
        continue;
      }
      const payload = await response.json();
      const elements = (payload.elements || [])
        .filter((element) => element.type === "way" && Array.isArray(element.geometry))
        .map((element) => ({ id: element.id, tags: element.tags || {}, geometry: element.geometry }));
      return {
        format: "osm-basemap-cell",
        cell: cellId(cell),
        bbox: [cell.n, cell.e, cell.n + 1, cell.e + 1],
        marginDegrees: CELL_MARGIN_DEGREES,
        fetchedAt: new Date().toISOString(),
        endpoint,
        wayCount: elements.length,
        elements,
      };
    } catch (error) {
      process.stderr.write(`  ${cellId(cell)}: ${error.message} via ${endpoint}\n`);
      await sleep(Math.min(60000, 5000 * 2 ** attempt));
    }
  }
  return null;
}

async function ensureCells(cells, options) {
  fs.mkdirSync(options.cacheDir, { recursive: true });
  let fetched = 0;
  for (const cell of cells) {
    if (readCellCache(options.cacheDir, cell)) continue;
    if (!options.fetch) continue;
    if (fetched > 0) await sleep(options.sleepMs);
    process.stderr.write(`fetching ${cellId(cell)}…\n`);
    const record = await fetchCell(cell, options);
    options.endpointCursor += 1;
    if (!record) {
      process.stderr.write(`  ${cellId(cell)}: giving up for this run (resume with --fetch)\n`);
      continue;
    }
    // Write via a temp name so an interrupted run never leaves a torn cell.
    const file = cellCachePath(options.cacheDir, cell);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
    fs.renameSync(`${file}.tmp`, file);
    process.stderr.write(`  ${cellId(cell)}: ${record.wayCount} ways\n`);
    fetched += 1;
  }
  return fetched;
}

// ── OSM indexes ──────────────────────────────────────────────────────────────

function classifyWay(tags) {
  const railway = tags.railway;
  if (tags.highway === "bus_guideway") return "guideway";
  if (railway && ACTIVE_RAILWAY.has(railway)) return "active";
  if (railway && DEAD_RAILWAY.has(railway)) return "dead";
  if (tags["disused:railway"] || tags["abandoned:railway"] || tags["razed:railway"]) return "dead";
  return null; // construction, platforms routed here by odd tagging, …
}

function buildIndexes(cacheDir, cells) {
  const covered = new Set();
  const seen = new Set();
  const indexes = {
    active: createEdgeIndex(INDEX_CELL_DEGREES),
    dead: createEdgeIndex(INDEX_CELL_DEGREES),
    guideway: createEdgeIndex(INDEX_CELL_DEGREES),
  };
  const counts = { active: 0, dead: 0, guideway: 0 };
  let oldestFetch = null;
  for (const cell of cells) {
    const record = readCellCache(cacheDir, cell);
    if (!record) continue;
    covered.add(cellId(cell));
    if (!oldestFetch || record.fetchedAt < oldestFetch) oldestFetch = record.fetchedAt;
    for (const way of record.elements) {
      if (seen.has(way.id)) continue; // cells overlap via the fetch margin
      seen.add(way.id);
      const bucket = classifyWay(way.tags);
      if (!bucket) continue;
      const coordinates = way.geometry.map((node) => [node.lon, node.lat]);
      if (coordinates.length < 2) continue;
      indexes[bucket].add(coordinates, {
        id: way.id,
        name: way.tags.name || way.tags["name:ja"] || null,
        // The attribution pass needs the operator to strengthen or weaken a
        // name, `service` to tell a running track from a yard road, and the
        // way's own geometry to measure sideways rather than end-on.
        operator: way.tags.operator || null,
        operatorJa: way.tags["operator:ja"] || null,
        service: way.tags.service || null,
        running: !NON_RUNNING_SERVICE.has(way.tags.service),
        // How deep OSM puts this way. Two ways at different layers are stacked,
        // not side by side, and their horizontal distance is not an offset —
        // see gradeAttributionRun.
        layer: Number.parseInt(way.tags.layer ?? "0", 10) || 0,
        coordinates,
        railway: way.tags.railway || way.tags["disused:railway"] || way.tags["abandoned:railway"] || way.tags["razed:railway"] || way.tags.highway || null,
        state:
          way.tags.railway && DEAD_RAILWAY.has(way.tags.railway)
            ? way.tags.railway
            : way.tags["razed:railway"]
              ? "razed"
              : way.tags["abandoned:railway"]
                ? "abandoned"
                : way.tags["disused:railway"]
                  ? "disused"
                  : null,
        tunnel: Boolean(way.tags.tunnel && way.tags.tunnel !== "no"),
      });
      counts[bucket] += 1;
    }
  }
  return { indexes, counts, covered, wayCount: seen.size, oldestFetch };
}

// ── the audit ────────────────────────────────────────────────────────────────

function nearestIn(index, point) {
  const hit = index.nearest(point);
  return hit ? { distance: hit.distance, meta: hit.meta } : null;
}

function auditLine(line, indexes, covered) {
  const distances = [];
  const findings = [];
  let skipped = 0;
  let sampleCount = 0;
  let worst = { distance: 0, point: null, interval: null };
  let run = null;
  let previousEnd = null;

  const closeRun = () => {
    if (run && run.meters >= RUN_REPORT_METERS) findings.push(run);
    run = null;
  };

  for (const interval of line.intervals) {
    const coordinates = interval.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    if (previousEnd && distanceMeters(previousEnd, coordinates[0]) > INTERVAL_JUMP_METERS)
      closeRun(); // a branch stroke starts here — not the same walk
    previousEnd = coordinates[coordinates.length - 1];

    for (const sample of resample(coordinates, SAMPLE_STEP_METERS)) {
      if (!covered.has(cellId(cellOf(sample.point)))) {
        skipped += 1;
        closeRun(); // never let a run span an unmeasured hole
        continue;
      }
      sampleCount += 1;
      const active = nearestIn(indexes.active, sample.point);
      const distance = active ? active.distance : NO_FEATURE_METERS;
      distances.push(Math.min(distance, NO_FEATURE_METERS));
      if (distance > worst.distance)
        worst = { distance, point: sample.point, interval };

      if (distance <= OFF_BASEMAP_METERS) {
        closeRun();
        continue;
      }
      if (!run)
        run = {
          fromStation: interval.from,
          toStation: interval.to,
          meters: 0,
          maxDistance: 0,
          maxPoint: sample.point,
          maxActive: active,
          start: sample.point,
          end: sample.point,
        };
      run.meters += SAMPLE_STEP_METERS;
      run.end = sample.point;
      run.toStation = interval.to;
      if (distance > run.maxDistance) {
        run.maxDistance = distance;
        run.maxPoint = sample.point;
        run.maxActive = active;
      }
    }
    // NOT closed here: consecutive intervals share their station anchor, so a
    // defect running through a station is one finding, not two fragments.
  }
  closeRun();

  distances.sort((a, b) => a - b);
  const quantile = (q) =>
    distances.length ? distances[Math.min(distances.length - 1, Math.floor(q * distances.length))] : null;
  return {
    lineId: line.lineId,
    name: line.name,
    operator: line.operator,
    kind: line.kind,
    sampleCount,
    skippedSamples: skipped,
    medianMeters: quantile(0.5),
    p95Meters: quantile(0.95),
    maxMeters: distances.length ? distances[distances.length - 1] : null,
    worst,
    rawFindings: findings,
  };
}

/**
 * The attribution pass: which railway's track is this line drawn on?
 *
 * Walks the same geometry as `auditLine`, twice as finely, and asks the
 * identity question at every sample that sits on a rail. Contiguous samples
 * that answer "somebody else's, and mine is over there" become one run; a
 * sample that answers "mine", "cannot tell", or "off the rails entirely" closes
 * the run, so a finding is always an unbroken stretch on one foreign track.
 */
function auditAttribution(line, index, covered, coverage) {
  const filter = attributionFilterFor(line);
  const findings = [];
  let run = null;
  let previousEnd = null;
  const count = (key) => {
    if (coverage) coverage[key] = (coverage[key] || 0) + 1;
  };

  const closeRun = () => {
    if (run && run.meters >= ATTRIBUTION_RUN_METERS) findings.push(run);
    run = null;
  };

  for (const interval of line.intervals) {
    const coordinates = interval.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    if (previousEnd && distanceMeters(previousEnd, coordinates[0]) > INTERVAL_JUMP_METERS)
      closeRun(); // a branch stroke starts here — not the same walk
    previousEnd = coordinates[coordinates.length - 1];

    for (const sample of resample(coordinates, ATTRIBUTION_STEP_METERS)) {
      const point = sample.point;
      if (!covered.has(cellId(cellOf(point)))) {
        closeRun();
        continue;
      }
      count("sampled");
      const nearest = index.nearest(point, (meta) => meta.running);
      // Floating clear of every rail is the distance criterion's business.
      if (!nearest || nearest.distance > ATTRIBUTION_ON_RAIL_METERS) {
        count("offRail");
        closeRun();
        continue;
      }
      // On our own metals: nothing to disagree with.
      if (filter.owns(nearest.meta)) {
        count("onOwnTrack");
        closeRun();
        continue;
      }
      // On a rail that names no railway — an unnamed way, or one named after
      // the tunnel it runs through. It cannot disagree with us either.
      if (!filter.identifiable(nearest.meta)) {
        count("unnamedRail");
        closeRun();
        continue;
      }
      const own = ownTrackAt(point, filter, index, ATTRIBUTION_OWN_RADIUS_METERS);
      // Our name is not mapped beside us here — genuine shared track, or OSM
      // simply does not carry this line. Undecidable, never a verdict.
      if (!own) {
        count("ownTrackNotInReach");
        closeRun();
        continue;
      }
      if (own.distance - nearest.distance < ATTRIBUTION_SEPARATION_METERS) {
        count("ownTrackAlongside");
        closeRun();
        continue;
      }
      count("onAnotherRailway");
      if (!run)
        run = {
          fromStation: interval.from,
          toStation: interval.to,
          meters: 0,
          maxOwnDistance: 0,
          onWays: new Map(),
          maxPoint: point,
          maxOwn: own,
          maxNearest: nearest,
        };
      run.meters += ATTRIBUTION_STEP_METERS;
      run.toStation = interval.to;
      const label = `${nearest.meta.name}${
        nearest.meta.operatorJa || nearest.meta.operator
          ? `／${nearest.meta.operatorJa || nearest.meta.operator}`
          : ""
      }`;
      run.onWays.set(label, (run.onWays.get(label) || 0) + 1);
      if (own.distance > run.maxOwnDistance) {
        run.maxOwnDistance = own.distance;
        run.maxPoint = point;
        run.maxOwn = own;
        run.maxNearest = nearest;
      }
    }
    // NOT closed here: consecutive intervals share their station anchor.
  }
  closeRun();

  return findings.map((run) => {
    const divergence = axisDifference(
      bearingAt(run.maxNearest.meta.coordinates, run.maxPoint),
      bearingAt(run.maxOwn.way.coordinates, run.maxPoint),
    );
    const separated = run.maxOwnDistance >= ATTRIBUTION_ALIGNMENT_METERS;
    return {
      code: "wrong_track",
      lineId: line.lineId,
      line: line.name,
      operator: line.operator,
      kind: line.kind,
      span: `${run.fromStation}→${run.toStation}`,
      meters: run.meters,
      // Named for the distance criterion's field so the ledger's
      // maxDeviationMetersLte rule reads the same number on both codes.
      maxDistance: run.maxOwnDistance,
      at: run.maxPoint,
      onWay: [...run.onWays.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([label]) => label),
      standingOn: {
        wayId: run.maxNearest.meta.id,
        name: run.maxNearest.meta.name,
        distance: run.maxNearest.distance,
        layer: run.maxNearest.meta.layer ?? 0,
      },
      ownTrack: {
        wayId: run.maxOwn.way.id,
        name: run.maxOwn.way.name,
        distance: run.maxOwnDistance,
        strength: run.maxOwn.strength,
        layer: run.maxOwn.way.layer ?? 0,
      },
      divergenceDegrees: divergence,
      ...gradeAttributionRun(run, separated),
    };
  });
}

/**
 * Grade one attribution run — and refuse to call a VERTICAL stack an offset.
 *
 * The criterion's premise is that the stroke is standing ON the rail it is
 * within 8 m of. Under a city that premise fails: 台北車站 stacks the metro at
 * layer −4, 臺鐵 at −2 and 台灣高速鐵路 at −3 beneath the same streets, so the
 * 淡水信義線 measured 0.5 m from a 縱貫線東正線 tunnel it passes two levels
 * above, and its own metals "40 m away" are simply the next street over. Two
 * ways OSM puts on different layers are not side by side and the horizontal
 * distance between them is not evidence of anything.
 *
 * The run is kept rather than dropped — a suppressed finding is one nobody can
 * re-examine — but it can never be the WARNING that asks for a human. Only a
 * stroke standing on a foreign track at ITS OWN LEVEL is that.
 */
function gradeAttributionRun(run, separated) {
  const standingLayer = run.maxNearest.meta.layer ?? 0;
  const ownLayer = run.maxOwn.way.layer ?? 0;
  if (standingLayer !== ownLayer)
    return {
      severity: "INFO",
      verdict:
        `stacked, not beside: the track it stands on is at layer ${standingLayer} and its own metals ` +
        `at layer ${ownLayer} — a horizontal distance between two levels is not an offset`,
    };
  return {
    severity: separated ? "WARNING" : "INFO",
    verdict: separated
      ? "drawn on another railway's track — its own metals are a separate alignment here"
      : "drawn on a neighbouring track of the same corridor — one N02 centre-line, several OSM tracks",
  };
}

function grade(finding) {
  if (finding.nearestDead && finding.nearestDead.distance <= DEAD_HUG_METERS)
    return { severity: "ERROR", verdict: "drawn on a removed alignment" };
  if (finding.maxDistance >= VACUUM_DEVIATION_METERS)
    return {
      severity: "ERROR",
      verdict:
        finding.maxDistance >= NO_FEATURE_METERS
          ? "no OSM rail within ~1 km"
          : "gross deviation from every active way",
    };
  if (finding.maxDistance >= REVIEW_DEVIATION_METERS)
    return { severity: "WARNING", verdict: "medium deviation — needs a human" };
  return { severity: "INFO", verdict: "local wobble above the gate" };
}

function decorateFindings(report, indexes) {
  const findings = [];
  for (const run of report.rawFindings) {
    const dead = nearestIn(indexes.dead, run.maxPoint);
    const guideway = nearestIn(indexes.guideway, run.maxPoint);
    const finding = {
      code: "off_basemap",
      lineId: report.lineId,
      line: report.name,
      operator: report.operator,
      kind: report.kind,
      span: `${run.fromStation}→${run.toStation}`,
      meters: run.meters,
      maxDistance: run.maxDistance,
      at: run.maxPoint,
      nearestActive: run.maxActive
        ? {
            distance: run.maxActive.distance,
            tunnel: run.maxActive.meta.tunnel,
            name: run.maxActive.meta.name,
            railway: run.maxActive.meta.railway,
          }
        : null,
      nearestDead: dead
        ? { distance: dead.distance, state: dead.meta.state || "dead", name: dead.meta.name }
        : null,
      nearestGuideway: guideway ? { distance: guideway.distance } : null,
    };
    Object.assign(finding, grade(finding));
    findings.push(finding);
  }
  if (
    report.medianMeters != null &&
    report.medianMeters > SYSTEMATIC_MEDIAN_METERS &&
    report.sampleCount >= 50
  )
    findings.push({
      code: "systematic_offset",
      lineId: report.lineId,
      line: report.name,
      operator: report.operator,
      kind: report.kind,
      span: "whole line",
      meters: report.sampleCount * SAMPLE_STEP_METERS,
      maxDistance: report.maxMeters,
      medianMeters: report.medianMeters,
      at: report.worst.point,
      severity: "INFO",
      verdict: `median ${report.medianMeters.toFixed(1)} m off the basemap over the whole line`,
    });
  return findings;
}

// ── adjudicated-exclusions ledger ────────────────────────────────────────────

function loadLedger(country) {
  const file = ledgerFileFor(country);
  if (!fs.existsSync(file)) return { entries: [] };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Precompute each entry's span bbox from the package's own station anchors. */
function prepareLedger(ledger, lines) {
  const byId = new Map(lines.map((line) => [line.lineId, line]));
  const prepared = [];
  for (const entry of ledger.entries || []) {
    const compiled = { ...entry, bbox: null, unmatchedSpan: false };
    const match = entry.match || {};
    if (match.lineId && match.spanStations) {
      const line = byId.get(match.lineId);
      const anchors = (match.spanStations || []).map((name) =>
        line?.stations.find((station) => station.name === name),
      );
      if (line && anchors.every(Boolean)) {
        const margin = match.spanMarginDegrees ?? 0.03;
        const lons = anchors.map((station) => station.point[0]);
        const lats = anchors.map((station) => station.point[1]);
        compiled.bbox = [
          Math.min(...lons) - margin,
          Math.min(...lats) - margin,
          Math.max(...lons) + margin,
          Math.max(...lats) + margin,
        ];
      } else compiled.unmatchedSpan = true;
    }
    prepared.push(compiled);
  }
  return prepared;
}

function entryMatches(entry, finding) {
  const match = entry.match || {};
  if (match.code && match.code !== finding.code) return false;
  if (match.lineId && match.lineId !== finding.lineId) return false;
  if (match.lineNameRegex && !new RegExp(match.lineNameRegex).test(finding.line)) return false;
  if (match.kinds && !match.kinds.includes(finding.kind)) return false;
  if (match.spanStations) {
    if (!entry.bbox) return false; // span stations no longer in the package
    const [west, south, east, north] = entry.bbox;
    const [lon, lat] = finding.at;
    if (lon < west || lon > east || lat < south || lat > north) return false;
  }
  if (match.maxDeviationMetersLte != null && !(finding.maxDistance <= match.maxDeviationMetersLte))
    return false;
  if (match.medianMetersLte != null && !(finding.medianMeters <= match.medianMetersLte))
    return false;
  if (match.nearestActiveTunnel && !finding.nearestActive?.tunnel) return false;
  if (
    match.excludeIfDeadHug &&
    finding.nearestDead &&
    finding.nearestDead.distance <= DEAD_HUG_METERS
  )
    return false;
  return true;
}

/**
 * Apply the ledger. Known-defect entries (suppress:false) are checked FIRST
 * and only annotate — a confirmed defect stays reported (the audit's contrast
 * positives) no matter what suppression rules would otherwise say.
 */
function applyLedger(findings, ledger) {
  const kept = [];
  const excluded = [];
  for (const finding of findings) {
    const knownDefect = ledger.find((entry) => entry.suppress === false && entryMatches(entry, finding));
    if (knownDefect) {
      finding.ledgerId = knownDefect.id;
      finding.ledgerKind = knownDefect.kind;
      kept.push(finding);
      continue;
    }
    const suppressor = ledger.find((entry) => entry.suppress !== false && entryMatches(entry, finding));
    if (suppressor) {
      finding.ledgerId = suppressor.id;
      finding.ledgerKind = suppressor.kind;
      excluded.push(finding);
      continue;
    }
    kept.push(finding);
  }
  return { kept, excluded };
}

// ── rendering ────────────────────────────────────────────────────────────────

function formatDistance(meters) {
  return meters >= NO_FEATURE_METERS ? "≥1 km" : `${meters.toFixed(0)} m`;
}

function renderFinding(finding) {
  const bits = [
    `${finding.severity} ${finding.code}: ${finding.span} — ` +
      (finding.code === "systematic_offset"
        ? finding.verdict
        : `${(finding.meters / 1000).toFixed(2)} km beyond ${OFF_BASEMAP_METERS} m of active OSM rail, ` +
          `max ${formatDistance(finding.maxDistance)} @ ${finding.at[0].toFixed(4)},${finding.at[1].toFixed(4)}`),
  ];
  if (finding.code === "off_basemap") {
    const hints = [];
    if (finding.nearestActive)
      hints.push(
        `active ${formatDistance(finding.nearestActive.distance)}${finding.nearestActive.tunnel ? " (tunnel)" : ""}${finding.nearestActive.name ? ` ${finding.nearestActive.name}` : ""}`,
      );
    else hints.push("no active rail in reach");
    if (finding.nearestDead)
      hints.push(
        `dead(${finding.nearestDead.state}) ${formatDistance(finding.nearestDead.distance)}${finding.nearestDead.name ? ` ${finding.nearestDead.name}` : ""}`,
      );
    if (finding.nearestGuideway)
      hints.push(`bus_guideway ${formatDistance(finding.nearestGuideway.distance)}`);
    bits.push(`nearest: ${hints.join(" · ")}`);
    bits.push(finding.verdict);
  }
  if (finding.ledgerId)
    bits.push(
      finding.severity && finding.ledgerKind === "known_defect"
        ? `[known defect: ${finding.ledgerId}]`
        : `[ledger: ${finding.ledgerId}]`,
    );
  return `  ${bits.join(" · ")}`;
}

function renderAttribution(finding) {
  return (
    `  ${finding.severity} wrong_track: ${finding.operator}／${finding.line} ${finding.span} — ` +
    `${finding.meters} m on ${finding.onWay.join(" + ")}` +
    `, own ${finding.ownTrack.name ?? "?"} way/${finding.ownTrack.wayId} ` +
    `${finding.ownTrack.distance.toFixed(1)} m sideways ` +
    `(standing ${finding.standingOn.distance.toFixed(1)} m from way/${finding.standingOn.wayId}` +
    `${finding.divergenceDegrees == null ? "" : `, ${finding.divergenceDegrees.toFixed(0)}° apart`}) ` +
    `@ ${finding.at[0].toFixed(4)},${finding.at[1].toFixed(4)} [${finding.lineId}]` +
    (finding.ledgerId ? ` [ledger: ${finding.ledgerId}]` : "")
  );
}

function severityRank(severity) {
  return severity === "ERROR" ? 2 : severity === "WARNING" ? 1 : 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    country: "jp",
    fetch: false,
    plan: false,
    all: false,
    strict: false,
    showExcluded: false,
    attribution: true,
    sleepMs: 3000,
    cacheDir: DEFAULT_CACHE_DIR,
    endpointCursor: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--country") options.country = argv[++index];
    else if (arg === "--fetch") options.fetch = true;
    else if (arg === "--plan") options.plan = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--show-excluded") options.showExcluded = true;
    else if (arg === "--no-attribution") options.attribution = false;
    else if (arg === "--json") options.json = argv[++index];
    else if (arg === "--cells") options.cells = argv[++index].split(",").filter(Boolean);
    else if (arg === "--lines") options.lines = argv[++index].split(",").filter(Boolean);
    else if (arg === "--cache-dir") options.cacheDir = path.resolve(argv[++index]);
    else if (arg === "--sleep-ms") options.sleepMs = Number(argv[++index]) || 3000;
    else if (arg === "--endpoints") {
      OVERPASS_ENDPOINTS.length = 0;
      OVERPASS_ENDPOINTS.push(...argv[++index].split(",").filter(Boolean));
    }
  }
  // An unknown country must stop the run, never fall back to the default: a
  // `--country tw` that silently audits Japan reports 651 lines of somebody
  // else's findings and looks exactly like a successful Taiwan audit.
  if (!COUNTRIES.includes(options.country))
    throw new Error(`unknown --country ${options.country} (expected ${COUNTRIES.join(", ")})`);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pkg = loadPackage(options.country);
  const allCells = gridCells(pkg.lines);
  const cells = options.cells
    ? allCells.filter((cell) => options.cells.includes(cellId(cell)))
    : allCells;

  if (options.plan) {
    process.stdout.write(`${options.country} package ${pkg.version} · ${pkg.lines.length} lines · ${allCells.length} grid cells\n`);
    for (const cell of allCells) {
      const cached = readCellCache(options.cacheDir, cell);
      process.stdout.write(
        `  ${cellId(cell)}  ${cached ? `cached ${cached.wayCount} ways (${cached.fetchedAt})` : "missing"}\n`,
      );
    }
    return;
  }

  await ensureCells(cells, options);

  const { indexes, counts, covered, wayCount, oldestFetch } = buildIndexes(options.cacheDir, cells);
  if (!covered.size) {
    process.stderr.write(
      `no cached cells under ${options.cacheDir} — run with --fetch (optionally --cells) first\n`,
    );
    process.exitCode = 2;
    return;
  }

  const lineFilter = options.lines ? new Set(options.lines) : null;
  const lines = pkg.lines.filter(
    (line) => !lineFilter || lineFilter.has(line.name) || lineFilter.has(line.lineId),
  );
  const ledger = prepareLedger(loadLedger(options.country), pkg.lines);

  const reports = [];
  // What the attribution pass could and could not answer, so a reader can tell
  // "no findings" from "no coverage".
  const coverage = {};
  let totalSamples = 0;
  let totalSkipped = 0;
  for (const line of lines) {
    const report = auditLine(line, indexes, covered);
    totalSamples += report.sampleCount;
    totalSkipped += report.skippedSamples;
    if (!report.sampleCount) continue; // entirely outside the cached cells
    const { kept, excluded } = applyLedger(decorateFindings(report, indexes), ledger);
    report.findings = kept;
    report.excluded = excluded;
    // The attribution criterion answers a different question and is tallied on
    // its own, so its findings live in their own field from the start rather
    // than being sorted back out of a shared list later.
    const attribution = options.attribution
      ? applyLedger(auditAttribution(line, indexes.active, covered, coverage), ledger)
      : { kept: [], excluded: [] };
    report.attribution = attribution.kept;
    report.attributionExcluded = attribution.excluded;
    delete report.rawFindings;
    reports.push(report);
  }

  // ── render ──
  const rows = [];
  rows.push(
    `══ Basemap Alignment Report — ${options.country} (package ${pkg.version} · ` +
      `OSM cache ${covered.size}/${allCells.length} cells, ${wayCount} ways, oldest ${oldestFetch?.slice(0, 10) ?? "—"}) ══`,
  );
  rows.push(
    `index: ${counts.active} active · ${counts.dead} disused/abandoned/razed · ${counts.guideway} bus_guideway ways`,
  );
  rows.push("");
  const clean = reports.filter((report) => report.maxMeters != null && report.maxMeters <= OFF_BASEMAP_METERS);
  const shown = options.all ? reports : reports.filter((report) => report.findings.length || (options.showExcluded && report.excluded.length));
  for (const report of shown) {
    rows.push(`Line: ${report.operator}／${report.name}  [${report.lineId}]`);
    rows.push(
      `  ${report.sampleCount} samples · median ${report.medianMeters?.toFixed(1)} m · ` +
        `p95 ${report.p95Meters?.toFixed(1)} m · max ${formatDistance(report.maxMeters ?? 0)}` +
        (report.skippedSamples ? ` · ${report.skippedSamples} samples outside cache` : ""),
    );
    for (const finding of report.findings) rows.push(renderFinding(finding));
    if (options.showExcluded)
      for (const finding of report.excluded) rows.push(`  excluded ${renderFinding(finding).trim()}`);
    rows.push("");
  }

  const keptAll = reports.flatMap((report) => report.findings);
  const excludedAll = reports.flatMap((report) => report.excluded);
  const bySeverity = new Map();
  for (const finding of keptAll)
    bySeverity.set(finding.severity, (bySeverity.get(finding.severity) || 0) + 1);
  const byLedger = new Map();
  for (const finding of excludedAll)
    byLedger.set(finding.ledgerId, (byLedger.get(finding.ledgerId) || 0) + 1);
  const unmatchedLedger = ledger.filter((entry) => entry.unmatchedSpan);

  rows.push("── Basemap Alignment Summary ──");
  rows.push(
    `lines audited: ${reports.length} (of ${lines.length} selected) · clean (max ≤ ${OFF_BASEMAP_METERS} m): ${clean.length}`,
  );
  rows.push(
    `samples: ${totalSamples} measured · ${totalSkipped} outside the cached cells` +
      (covered.size < allCells.length
        ? ` (missing ${allCells.length - covered.size} cells — partial audit)`
        : ""),
  );
  rows.push(
    `findings: ERROR ${bySeverity.get("ERROR") || 0} · WARNING ${bySeverity.get("WARNING") || 0} · INFO ${bySeverity.get("INFO") || 0}`,
  );
  rows.push(
    `excluded by ledger: ${excludedAll.length}` +
      (byLedger.size
        ? ` (${[...byLedger.entries()].map(([id, count]) => `${id}: ${count}`).join(" · ")})`
        : ""),
  );
  for (const entry of unmatchedLedger)
    rows.push(`  WARNING ledger entry ${entry.id}: span stations not found in the package`);

  // ── the attribution criterion, counted apart from the distance one ──
  const attributionAll = reports.flatMap((report) => report.attribution);
  const attributionExcluded = reports.flatMap((report) => report.attributionExcluded);
  if (options.attribution) {
    const separated = attributionAll.filter((finding) => finding.severity === "WARNING");
    const corridor = attributionAll.filter((finding) => finding.severity !== "WARNING");
    rows.push("");
    rows.push("── Track Attribution (wrong_track) ──");
    const sampled = coverage.sampled || 0;
    const share = (value) => `${(((value || 0) / (sampled || 1)) * 100).toFixed(1)}%`;
    rows.push(
      `${sampled} samples at ${ATTRIBUTION_STEP_METERS} m · on their own named track ${share(coverage.onOwnTrack)} · ` +
        `clear of every rail ${share(coverage.offRail)} · on a rail that names no railway ${share(coverage.unnamedRail)}`,
    );
    rows.push(
      `  on somebody else's named track: own metals not in reach (shared track, or OSM does not carry the line) ` +
        `${share(coverage.ownTrackNotInReach)} · own metals alongside within ${ATTRIBUTION_SEPARATION_METERS} m ` +
        `${share(coverage.ownTrackAlongside)} · reportable ${share(coverage.onAnotherRailway)}`,
    );
    rows.push(
      `runs where the nearest named rail is not this line's: ${attributionAll.length} ` +
        `over ${new Set(attributionAll.map((finding) => finding.lineId)).size} lines, ` +
        `${(attributionAll.reduce((total, finding) => total + finding.meters, 0) / 1000).toFixed(2)} km`,
    );
    rows.push(
      `  WARNING (own metals ≥ ${ATTRIBUTION_ALIGNMENT_METERS} m sideways — a separate alignment): ${separated.length}` +
        ` · INFO (same corridor, neighbouring track): ${corridor.length}` +
        (attributionExcluded.length ? ` · ledger-excluded: ${attributionExcluded.length}` : ""),
    );
    const listed = options.all ? attributionAll : separated;
    for (const finding of listed.sort((left, right) => right.maxDistance - left.maxDistance))
      rows.push(renderAttribution(finding));
    if (!options.all && corridor.length)
      rows.push(`  (${corridor.length} INFO runs not listed — pass --all)`);
  }
  process.stdout.write(`${rows.join("\n")}\n`);

  if (options.json) {
    fs.writeFileSync(
      options.json,
      JSON.stringify(
        {
          country: options.country,
          packageVersion: pkg.version,
          cache: {
            dir: options.cacheDir,
            coveredCells: [...covered],
            totalCells: allCells.length,
            wayCount,
            counts,
            oldestFetch,
          },
          thresholds: {
            SAMPLE_STEP_METERS,
            OFF_BASEMAP_METERS,
            RUN_REPORT_METERS,
            DEAD_HUG_METERS,
            VACUUM_DEVIATION_METERS,
            REVIEW_DEVIATION_METERS,
            SYSTEMATIC_MEDIAN_METERS,
            ATTRIBUTION_STEP_METERS,
            ATTRIBUTION_ON_RAIL_METERS,
            ATTRIBUTION_OWN_RADIUS_METERS,
            ATTRIBUTION_SEPARATION_METERS,
            ATTRIBUTION_RUN_METERS,
            ATTRIBUTION_ALIGNMENT_METERS,
          },
          totalSamples,
          totalSkipped,
          attributionCoverage: coverage,
          lines: reports,
        },
        null,
        2,
      ),
    );
    process.stdout.write(`wrote ${options.json}\n`);
  }

  const errors = keptAll.filter((finding) => severityRank(finding.severity) === 2).length;
  if (options.strict && errors) process.exitCode = 1;
}

// Run only as a command; importing this module (tests) must not audit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
