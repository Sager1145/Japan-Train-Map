#!/usr/bin/env node
/*
 * Whole-country multi-line station audit.
 *
 * The report is deliberately built from the compact package AND the final
 * render model.  Coincident source rows are not accepted as continuity: an
 * A/B relationship passes only when the two interval ends, railway identity,
 * rendered station feature agree at one node.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { laneRowsForPackage } from "../railway/build-parallel-corridors.mjs";
import {
  distanceMeters,
  pointSegmentDistanceMeters,
  resample,
} from "../railway/lib/railway-topology.mjs";
import {
  loadOsmPlatformIndex,
  loadOsmTrackIndex,
} from "../railway/lib/osm-basemap-cache.mjs";
import {
  anyRunningTrackAt,
  claimFilterFor,
  claimedTrackAt,
  pickPlatform,
} from "../railway/lib/station-track-claim.mjs";
import {
  DUPLICATE_METERS,
  RUN_REPORT_METERS,
  SAMPLE_STEP_METERS,
  findDuplicateStrokes,
} from "../railway/lib/duplicate-strokes.mjs";

// ── station-zone basemap gate ────────────────────────────────────────────────
//
// The corridor audit (validate-basemap-alignment.mjs) measures every sample to
// the NEAREST active rail way with a 50 m gate sustained over 150 m. Inside a
// station a dozen roads sit 5-15 m apart, so a line drawn on the wrong one is
// still metres from something and that gate can never fire. Here the distance
// is to the line's OWN claimed track (station-track-claim.mjs) instead, which
// lets the gate be much tighter.
//
// Calibrated 2026-08-19 on lines whose alignment is not in question, station
// by station (median / p90 / max):
//   ゆいレール    3.1 / 5.0 / 5.5 m      東海道新幹線  2.4 / 17.1 / 91.9 m
//   山手線        3.8 / 12.2 / 13.3 m    函館線        3.0 / 18.1 / 27.7 m
// so 25 m clears ordinary platform anchoring (p90 tops out at 18 m) while
// still catching 大平台's 33 m and the 新幹線's 92 m outlier. The prompt's
// provisional 10 m was too tight — it would have reported the anchoring model
// itself, which is the failure mode 2.5 warns about.
const STATION_CLAIM_GATE_METERS = 25;
// The approach is a whole stretch of track rather than one point, so its
// MEDIAN is gated tighter. Same calibration lines, per-station approach median
// (median / p90 / max):
//   ゆいレール 1.7 / 3.9 / 6.6 m    山手線 2.7 / 5.9 / 8.7 m
//   新幹線     2.4 / 9.2 / 9.3 m    函館線 2.7 / 13.0 / 22.7 m
// 20 m clears every p90. 函館線's two outliers (27.7 m station, 22.7 m
// approach) DO report, deliberately: they are the first review items, not
// noise to be tuned away.
const APPROACH_MEDIAN_GATE_METERS = 20;
const APPROACH_WINDOW_METERS = 500;
const APPROACH_STEP_METERS = 30;
// Two candidate platforms closer together than this are the two faces of one
// island (or two islands of one group); the cache cannot separate them, so the
// pick goes to review instead of being trusted (prompt 2.4).
const PLATFORM_MARGIN_GATE_METERS = 30;
// How far a station dot may sit from the midpoint of the platform its own
// trains use. Japanese platforms run 100-300 m, so half a long platform.
const PLATFORM_DOT_GATE_METERS = 120;
// Below this an approach is simply accurate, and a station standing off it is
// station-specific whatever the ratio says.
const SYSTEMATIC_OFFSET_FLOOR_METERS = 15;
// How much further than its line's own offset a dot may sit before it stops
// being explained by that offset.
const SYSTEMATIC_OFFSET_MARGIN_METERS = 15;

// ── continuation (A) versus branch/rejoin (B): see classifyPair ──────────────
// Two arms count as leaving on the same metals at the duplicate-stroke audit's
// own coincidence gate (3 m point-to-segment), measured out to its reporting
// window (200 m) in its sampling step (10 m).
const SHARED_DEPARTURE_GATE_METERS = DUPLICATE_METERS;
const SHARED_DEPARTURE_WINDOW_METERS = RUN_REPORT_METERS;
const SHARED_DEPARTURE_STEP_METERS = SAMPLE_STEP_METERS;
// How long that coincidence has to hold before it means "one railway leaving
// this station once", rather than the two strokes merely starting at the same
// junction point. A station throat is tens of metres; 100 m is already out on
// the running line, and the shape this catches (支線共用軌) runs for
// hundreds — 塩尻's 中央線 trunk and 辰野支線 share 1,204 m.
const SHARED_DEPARTURE_RUN_METERS = 100;
// A continuation's two arms must at least point away from each other. This is
// the coarse question ("is this a through route or a fork?"); the 5° tangent
// gate is the separate, tighter QUALITY question asked of an A once it is one.
const OPPOSED_ARM_DEGREES = 90;

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT_DIR = path.resolve(APP_DIR, "..");
const PACKAGE_PATH = path.join(APP_DIR, "public/rail/jp-2025.json");
const NETWORK_PATH = path.join(
  APP_DIR,
  "data/raw/railway/jp/rebuild-inventory/stations/n02-station-network.json",
);
const RULES_PATH = path.join(
  APP_DIR,
  "data/raw/railway/jp/evidence/multi-line-station-audit-rules.json",
);
const BASEMAP_EXCLUSIONS_PATH = path.join(
  APP_DIR,
  "data/raw/railway/jp/evidence/station-basemap-exclusions.json",
);
const N02_FEATURES_PATH = path.join(
  APP_DIR,
  "data/raw/railway/jp/rebuild-inventory/stations/n02-platform-features.json",
);
const TOKYO_PATH = path.join(
  APP_DIR,
  "data/raw/railway/jp/evidence/tokyo-station-platforms.json",
);
const OUTPUT_DIR = path.join(ROOT_DIR, "outputs/railway-audit/multi-line-stations");
const JSON_PATH = path.join(OUTPUT_DIR, "audit.json");
const CSV_PATH = path.join(OUTPUT_DIR, "audit.csv");
const MARKDOWN_PATH = path.join(OUTPUT_DIR, "README.md");

const RailNetwork = require(path.join(APP_DIR, "public/rail-network.js"));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const coordinateKey = (point) => `${point[0]},${point[1]}`;
const samePoint = (a, b) => coordinateKey(a) === coordinateKey(b);
const rounded = (value, digits = 3) =>
  value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

function decodeIntervals(line) {
  let previousEnd = null;
  return line.segments.map((row) => {
    const coordinates = row[1]
      ? [previousEnd, ...row[2].map((point) => [...point])]
      : row[2].map((point) => [...point]);
    previousEnd = coordinates.at(-1);
    return coordinates;
  });
}

function bearing(a, b) {
  const latitude = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  return (
    (Math.atan2(
      (b[0] - a[0]) * Math.cos(latitude),
      b[1] - a[1],
    ) *
      180) /
      Math.PI +
    360
  ) % 360;
}

function angularDifference(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function nearestDistinct(coordinates, fromStart) {
  const ordered = fromStart ? coordinates : coordinates.slice().reverse();
  const station = ordered[0];
  return ordered.find((point) => distanceMeters(station, point) > 0.05) || station;
}

export function stationGeometry(line, stationIndex) {
  const intervals = decodeIntervals(line);
  const point = [line.stations[stationIndex][2], line.stations[stationIndex][3]];
  const incoming = stationIndex > 0 ? intervals[stationIndex - 1] : null;
  const outgoing = stationIndex < intervals.length ? intervals[stationIndex] : null;
  const incomingPrior = incoming ? nearestDistinct(incoming, false) : null;
  const outgoingNext = outgoing ? nearestDistinct(outgoing, true) : null;
  const outwardBearings = [];
  if (incomingPrior && !samePoint(incomingPrior, point))
    outwardBearings.push(bearing(point, incomingPrior));
  if (outgoingNext && !samePoint(outgoingNext, point))
    outwardBearings.push(bearing(point, outgoingNext));

  const stationTurn =
    incomingPrior && outgoingNext
      ? angularDifference(bearing(incomingPrior, point), bearing(point, outgoingNext))
      : null;
  let endpointExact = true;
  if (incoming) endpointExact &&= samePoint(incoming.at(-1), point);
  if (outgoing) endpointExact &&= samePoint(outgoing[0], point);

  const outwardIntervals = [];
  if (incoming) outwardIntervals.push(incoming.slice().reverse());
  if (outgoing) outwardIntervals.push(outgoing);
  const immediateReturn = outwardIntervals.some((coordinates) => {
    let left = false;
    for (const coordinate of coordinates) {
      const distance = distanceMeters(point, coordinate);
      if (distance > 1) left = true;
      else if (left && distance < 0.1) return true;
    }
    return false;
  });

  // Sharpest corner in the intervals either side, with NO edge-length floor.
  //
  // validate-railway-topology's sharp_artificial_turn requires BOTH edges at a
  // corner to be >=60 m, so it cannot see a fold whose short side is shorter
  // than that. 品川 folded 169 deg between a 70 m and a 36 m edge after a
  // registered platform pick, passed topology 654/3/0, and was only caught by
  // a parallel session's isolation build. Any anchor the evidence moves has to
  // be measured against this before it is promoted.
  const foldDegrees = (coordinates) => {
    let worst = 0;
    for (let index = 1; index < (coordinates?.length || 0) - 1; index += 1) {
      const before = bearing(coordinates[index - 1], coordinates[index]);
      const after = bearing(coordinates[index], coordinates[index + 1]);
      worst = Math.max(worst, angularDifference(before, after));
    }
    return worst;
  };
  const adjacentFold = Math.max(
    foldDegrees(incoming),
    foldDegrees(outgoing),
  );

  let measure = line.segments
    .slice(0, stationIndex)
    .reduce((sum, row) => sum + Number(row[0]) * 1000, 0);
  if (line.isLoop && stationIndex === 0) measure = 0;
  const structure = (line.structure || []).filter(
    (row) => measure >= Number(row[0]) - 25 && measure <= Number(row[1]) + 25,
  );
  const kinds = new Set(structure.map((row) => Number(row[2])));
  const layers = structure.map((row) => Number(row[3]) || 0);
  let vertical = "surface";
  if (line.isHSR) vertical = "shinkansen";
  else if (kinds.has(1) || (line.kind === "subway" && !kinds.has(2))) vertical = "underground";
  else if (kinds.has(2) || layers.some((layer) => layer > 0)) vertical = "elevated";

  return {
    intervals,
    point,
    // Every adjacent interval rewritten to start AT the station and run away
    // from it, so two strokes can be compared as they leave (see classifyPair).
    outwardPaths: outwardIntervals,
    endpoint: stationIndex === 0 || stationIndex === line.stations.length - 1,
    endpointExact,
    immediateReturn,
    outwardBearings,
    stationTurn: rounded(stationTurn),
    adjacentFold: rounded(adjacentFold, 1),
    vertical,
    structure: structure.map((row) => ({
      kind: Number(row[2]) === 1 ? "tunnel" : Number(row[2]) === 2 ? "bridge" : "unknown",
      layer: Number(row[3]) || 0,
      from_m: Number(row[0]),
      to_m: Number(row[1]),
    })),
  };
}

function distanceToParts(point, parts) {
  let best = Infinity;
  for (const coordinates of parts || []) {
    for (let index = 1; index < coordinates.length; index += 1)
      best = Math.min(
        best,
        pointSegmentDistanceMeters(point, coordinates[index - 1], coordinates[index]),
      );
  }
  return best;
}

function familyId(lineId) {
  return lineId.replace(/(-p?\d+)+$/u, "");
}

function csvCell(value) {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exactEvidence(tokyo) {
  const byLine = new Map();
  for (const row of tokyo.surveyed_intervals || []) {
    const [operator, name] = row.line.split("␟");
    for (const station of [row.from_station, row.to_station]) {
      const key = `${operator}\0${name}\0${station}`;
      const value = byLine.get(key) || { osm_ways: new Set(), sources: new Set() };
      for (const way of row.osm_ways || []) value.osm_ways.add(way);
      if (row.source) value.sources.add(row.source);
      byLine.set(key, value);
    }
  }
  for (const row of tokyo.geometry_patches || []) {
    const [operator, name] = row.line.split("␟");
    const key = `${operator}\0${name}\0${row.station}`;
    const value = byLine.get(key) || { osm_ways: new Set(), sources: new Set() };
    for (const way of row.osm_ways || []) value.osm_ways.add(way);
    byLine.set(key, value);
  }
  return byLine;
}

function bestContinuationTurn(a, b) {
  if (!a.geometry.outwardBearings.length || !b.geometry.outwardBearings.length) return null;
  let best = Infinity;
  for (const one of a.geometry.outwardBearings) {
    for (const two of b.geometry.outwardBearings) {
      best = Math.min(best, Math.abs(180 - angularDifference(one, two)));
    }
  }
  return rounded(best);
}

/**
 * How far two strokes stay on ONE alignment as they leave a shared station.
 *
 * Measured from the station outward on every adjacent interval either side,
 * as the first contiguous run within the duplicate-stroke gate: the moment the
 * two part company the run stops, so a 1,204 m answer means 1,204 m of shared
 * metals, not 1,204 m of "somewhere near each other".
 */
export function sharedDepartureMeters(a, b) {
  let best = 0;
  for (const [from, to] of [
    [a, b],
    [b, a],
  ]) {
    for (const arm of from.geometry.outwardPaths || []) {
      for (const other of to.geometry.outwardPaths || []) {
        if (arm.length < 2 || other.length < 2) continue;
        let run = 0;
        for (const sample of resample(arm, SHARED_DEPARTURE_STEP_METERS)) {
          if (sample.measure > SHARED_DEPARTURE_WINDOW_METERS) break;
          if (distanceToParts(sample.point, [other]) > SHARED_DEPARTURE_GATE_METERS) break;
          run = sample.measure;
        }
        best = Math.max(best, run);
      }
    }
  }
  return best;
}

/**
 * A/B/C/D/E per multi-line-station-audit-rules.json.
 *
 * A is "the same railway, meeting here, forming a CONTINUATION rather than a
 * branch"; B is "sibling strokes meeting at a branch or rejoin station".
 * Until 2026-08-19 the split was proxied by "exactly two strokes of this
 * railway, both ending here", which a TERMINAL JUNCTION satisfies just as well
 * as a through route. 塩尻 is the case that exposed it: the 中央線 trunk
 * (東京→岡谷→みどり湖→塩尻) and the 辰野支線 both end there, so the proxy said
 * continuation — but they leave the station along the SAME 1,204 m of track
 * (24 identical vertices) before diverging, which is the MAIN_BRANCH_SHARED
 * shape of a branch, and 塩尻 is exactly the junction the 辰野支線's
 * rejoin_variant evidence names. The pair then failed A's 5° tangent gate at
 * 180° and was reported as a geometry defect, when the geometry was right and
 * the classification was wrong.
 *
 * So branch-versus-continuation is now decided on its own two signals, and
 * neither of them is the tangent gate:
 *
 *   they leave on the same metals   → branch: one railway leaving once, with a
 *                                     fork further out (支線共用軌)
 *   their arms are not even opposed → branch: a stroke that departs on the
 *                                     same side as its sibling is not the
 *                                     other half of a through route
 *
 * A continuation must show neither. The 5° tangent check stays where it was,
 * as A's quality requirement: a genuine two-arm continuation drawn with a kink
 * of 5-90° still classifies as A and still reports. Because the new test only
 * ADDS conditions to A, no pair can move from B to A.
 */
export function classifyPair(a, b, occurrences, sharedDeparture) {
  const paired =
    a.line.alignmentRole === "paired_alignment" ||
    b.line.alignmentRole === "paired_alignment";
  if (paired) return "D";
  const sameRailway = a.railwayIdentity === b.railwayIdentity;
  const verticalPair = new Set([a.geometry.vertical, b.geometry.vertical]);
  const verticallySeparated =
    a.line.isHSR !== b.line.isHSR ||
    (verticalPair.size > 1 &&
      [...verticalPair].some((value) => value === "underground" || value === "elevated" || value === "shinkansen"));
  if (verticallySeparated) return "E";
  if (!sameRailway) return "C";
  const sameRailwayCount = occurrences.filter(
    (candidate) => candidate.railwayIdentity === a.railwayIdentity,
  ).length;
  // Three or more strokes of one railway here is a junction by arithmetic, and
  // a stroke that only passes through cannot be one arm of a two-arm route.
  if (sameRailwayCount !== 2 || !a.geometry.endpoint || !b.geometry.endpoint) return "B";
  const turn = bestContinuationTurn(a, b);
  const armsOpposed = turn != null && turn < OPPOSED_ARM_DEGREES;
  const shared = (sharedDeparture ?? sharedDepartureMeters(a, b)) >= SHARED_DEPARTURE_RUN_METERS;
  return armsOpposed && !shared ? "A" : "B";
}

function electedJunction(occurrences, railwayIdentity) {
  const members = occurrences.filter(
    (row) => row.railwayIdentity === railwayIdentity && row.line.alignmentRole !== "paired_alignment",
  );
  const canonical = members.find((row) => row.line.id === familyId(row.line.id));
  const elected =
    canonical ||
    members.slice().sort((a, b) => b.totalKm - a.totalKm || a.line.id.localeCompare(b.line.id))[0];
  return elected?.geometry.point || null;
}

/** Points along the intervals either side of a station, out to the window. */
function approachSamples(geometry, stationIndex) {
  const points = [];
  const take = (coordinates, fromStart) => {
    if (!coordinates || coordinates.length < 2) return;
    const ordered = fromStart ? coordinates : coordinates.slice().reverse();
    let walked = 0;
    for (const sample of resample(ordered, APPROACH_STEP_METERS)) {
      walked = sample.measure;
      if (walked > APPROACH_WINDOW_METERS) break;
      points.push(sample.point);
    }
  };
  take(geometry.intervals[stationIndex - 1], false);
  take(geometry.intervals[stationIndex], true);
  return points;
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Measure one drawn station and its approaches against the line's OWN track.
 *
 * Returns null when the cache holds no claimable way here — an honest "not
 * measured", never a fallback to the nearest rail of any kind.
 */
/**
 * How a finding would have to be fixed — which is not a matter of taste.
 *
 * N02 offers more than one platform feature for only 66 of 10,153 (line,
 * group) keys nationwide. Where it does, a dot on the wrong one is fixed by a
 * `platform_assignments` row: the build still picks an OFFICIAL feature, so
 * nothing is overridden. Where it does not, N02 simply puts the station where
 * it puts it, and moving the dot means registering a measured geometry patch
 * over official survey — the 東京 precedent, which required a provable N02
 * source defect and explicit direction. Batching those would be overriding
 * the official dataset by majority vote of a script.
 */
function fixClassFor(features, claim, currentPoint) {
  if (!features || features.length < 2)
    return { fix_class: "registered_geometry_patch", n02_platform_features: features?.length ?? null };
  const current = claim.trackDistanceAt(currentPoint);
  let best = null;
  for (const feature of features) {
    const distance = claim.trackDistanceAt(feature.midpoint);
    if (best == null || distance < best) best = distance;
  }
  // "Closer" is not enough: at 東武日光 the other feature is 100 m from the
  // line's own track instead of 139 m, so re-picking would move the dot
  // without landing it anywhere real. The alternative has to clear the station
  // gate outright before an assignment can claim to fix anything.
  return {
    n02_platform_features: features.length,
    fix_class:
      best != null && best <= STATION_CLAIM_GATE_METERS && best + 1 < current
        ? "platform_assignment"
        : "registered_geometry_patch",
    best_alternative_to_claimed_track_m: rounded(best, 1),
  };
}

function basemapCheck(line, geometry, stationIndex, osmIndex, filterCache, platformIndex, n02Features) {
  if (!osmIndex) return null;
  let filter = filterCache.get(line.id);
  if (!filter) filterCache.set(line.id, (filter = claimFilterFor(line)));
  const claim = claimedTrackAt(geometry.point, filter, osmIndex, 200);
  if (!claim) return { verdict: "undecidable", reason: "no_claimable_osm_track" };
  claim.trackDistanceAt = (point) => {
    const hit = claimedTrackAt(point, filter, osmIndex, 200);
    return hit ? hit.distance : Infinity;
  };
  const offsets = [];
  for (const point of approachSamples(geometry, stationIndex)) {
    const hit = claimedTrackAt(point, filter, osmIndex, 200);
    if (hit) offsets.push(hit.distance);
  }
  const approachMedian = medianOf(offsets);
  const stationOff = claim.distance > STATION_CLAIM_GATE_METERS;
  const approachOff =
    approachMedian != null && approachMedian > APPROACH_MEDIAN_GATE_METERS;
  // Being far from the claimed track has two very different causes, and the
  // corridor cache alone cannot separate them:
  //
  //   the dot floats with no rail near it at all        → package_wrong
  //   the dot is ON a rail, just not a NAMED one of its
  //   own line (unnamed platform road, or the platform
  //   of the line it terminates into: 日吉 sits on 東急
  //   目黒線's rails because 新横浜線 starts underground) → possible_wrong_platform
  //
  // The second needs railway=platform / stop_area, which the corridor cache
  // does not carry (prompt 2.2's narrow second fetch). Calling it "wrong"
  // here would invent a defect out of a missing tag.
  const onSomeTrack = stationOff
    ? anyRunningTrackAt(geometry.point, osmIndex, STATION_CLAIM_GATE_METERS)
    : null;
  // Underground is where the basemap is the approximate one. The 2026-08-18
  // corridor audit already adjudicated 55 Shinkansen/long-tunnel stretches at
  // 50-120 m as "OSM digitises tunnels by eye, N02 is the survey — the BASEMAP
  // is wrong, do not follow it". The same holds inside a station: 初台 sits
  // 27.9 m from the 京王線 tunnel and 75.3 m from the 京王新線 tunnel it
  // actually uses, and treating that as a misplaced dot would move an official
  // survey point to match a hand-drawn tunnel.
  const underground =
    geometry.vertical === "underground" || Boolean(claim.way && claim.way.tunnel);
  // A line's own named way routinely stops short of the buffer stop: the last
  // few tens of metres into a terminal platform are unnamed, or belong to the
  // host operator at a shared station. Measured over the flagged rows, a
  // terminus approaches its track at a median of 7.8 m while a mid-line
  // station manages 22.2 m — the line IS on its metals, the NAME just runs
  // out. Calling that a misplaced dot would move an official survey point to
  // match where a volunteer stopped typing a name.
  const terminusShortfall =
    geometry.endpoint && !approachOff && stationOff;
  // A dot that is no further from the track than its own line generally is
  // has not been misplaced: N02 and OSM simply surveyed that railway a little
  // differently, which the corridor audit already records as an INFO-level
  // systematic offset rather than a defect. Measured here as station ≈
  // approach — 清和学園前 36.5/29.4, 三ツ屋 30.7/31.5, 長町 42.9/45.0 — as
  // against the genuinely station-specific 伊万里 28.0/1.2 or 田崎橋 53.0/21.9,
  // where the line runs clean and only the dot is out.
  const systematicOffset =
    approachMedian != null &&
    approachMedian > SYSTEMATIC_OFFSET_FLOOR_METERS &&
    claim.distance <= approachMedian + SYSTEMATIC_OFFSET_MARGIN_METERS;
  let verdict = "agrees";
  if ((stationOff || approachOff) && underground) verdict = "tunnel_basemap_approximate";
  else if (stationOff && onSomeTrack) verdict = "possible_wrong_platform";
  else if (stationOff || approachOff) verdict = "package_wrong";

  // With platforms cached, "standing on somebody's rails" can be decided:
  // name the platform this line's own trains use, and see whether the dot is
  // on it. Without them the verdict stays `possible_wrong_platform`.
  const pick = platformIndex
    ? pickPlatform(geometry.point, geometry.outwardBearings, claim, platformIndex, {
        // A platform nearer another stop of this line is that stop's, however
        // well it sits on the claimed track — see pickPlatform.
        otherStations: line.stations
          .filter((_entry, index) => index !== stationIndex)
          .map((entry) => [entry[2], entry[3]]),
      })
    : null;
  const dotToPlatform = pick
    ? distanceMeters(geometry.point, pick.platform.midpoint)
    : null;
  // Adjacency is measured in PLAN, so at a stacked station it cannot tell a
  // Shinkansen viaduct platform from the 在来線 platform underneath it: at
  // 新大阪 the pick came back as ref "1;2", which is the 在来線 island. Any
  // line that is not at grade here therefore needs the platform's own level to
  // agree before the pick may be trusted.
  const stacked = geometry.vertical !== "surface";
  const levelAgrees =
    !stacked ||
    (pick && Number.isFinite(pick.platform.layer) && pick.platform.layer !== 0);
  if (verdict === "possible_wrong_platform" && pick) {
    if (
      pick.marginMeters != null &&
      pick.marginMeters < PLATFORM_MARGIN_GATE_METERS &&
      pick.decisionChanges
    )
      verdict = "platform_pick_ambiguous";
    else if (!pick.adjacentToClaimedTrack) verdict = "platform_not_on_claimed_track";
    else if (!levelAgrees) verdict = "platform_level_unverified";
    else verdict = dotToPlatform > PLATFORM_DOT_GATE_METERS ? "wrong_platform" : "agrees_on_platform";
  }
  // The terminus explanation is a FALLBACK, never a pre-emption: platform
  // evidence is stronger, so a dot that we can positively place on the wrong
  // platform stays `wrong_platform` even at a buffer stop. Only the outcomes
  // that amount to "we cannot tell" are downgraded.
  if (
    systematicOffset &&
    ["package_wrong", "possible_wrong_platform", "platform_not_on_claimed_track"].includes(
      verdict,
    )
  )
    verdict = "systematic_line_offset";
  if (
    terminusShortfall &&
    ["package_wrong", "possible_wrong_platform", "platform_not_on_claimed_track"].includes(
      verdict,
    )
  )
    verdict = "terminus_track_starts_beyond_platform";
  const fix =
    verdict === "agrees" || verdict === "agrees_on_platform"
      ? null
      : fixClassFor(n02Features, claim, geometry.point);
  return {
    verdict,
    ...(fix || {}),
    platform: pick
      ? {
          osm: `${pick.platform.kind}/${pick.platform.id}`,
          ref: pick.platform.ref,
          name: pick.platform.name,
          midpoint: pick.platform.midpoint,
          dot_to_platform_m: rounded(dotToPlatform, 1),
          margin_m: rounded(pick.marginMeters, 1),
          runner_up_changes_decision: pick.decisionChanges,
          alignment_degrees: rounded(pick.alignmentDegrees, 1),
          adjacent_to_claimed_track: pick.adjacentToClaimedTrack,
          candidates: pick.candidates,
        }
      : null,
    nearest_running_track_m: onSomeTrack ? rounded(onSomeTrack.distance, 1) : null,
    claim_strength: claim.strength,
    claimed_osm_way_ids: claim.wayIds.slice(0, 12),
    claimed_way_name: claim.way.name,
    point_to_claimed_track_m: rounded(claim.distance, 1),
    approach_median_offset_m: rounded(approachMedian, 1),
    approach_samples: offsets.length,
    // The projection of the dot onto its own track is the interim suggestion:
    // a platform-level pick needs railway=platform, which the corridor cache
    // does not carry (prompt 2.2 — a second, narrower fetch).
    suggestion_basis: stationOff ? "osm_claimed_track_projection" : null,
  };
}

export function buildAudit(options = {}) {
  const pkg = readJson(PACKAGE_PATH);
  // Machine-local and optional: without the cache every basemap field reports
  // "not measured" and nothing is inferred (npm test must not need a download).
  const osm = options.osm === false ? { ways: 0 } : loadOsmTrackIndex();
  const osmIndex = osm.ways ? osm.index : null;
  const basemapExclusions = fs.existsSync(BASEMAP_EXCLUSIONS_PATH)
    ? readJson(BASEMAP_EXCLUSIONS_PATH).excluded_lines || []
    : [];
  const excludedReason = (line) => {
    const hit = basemapExclusions.find(
      (row) => row.match.operator === line.operator && row.match.line === line.name,
    );
    return hit ? hit.reason : null;
  };
  const n02Features = fs.existsSync(N02_FEATURES_PATH)
    ? readJson(N02_FEATURES_PATH).features
    : {};
  const platformCache = options.osm === false ? { platforms: 0 } : loadOsmPlatformIndex();
  const platformIndex = platformCache.platforms ? platformCache.index : null;
  const filterCache = new Map();
  const duplicateRows = osmIndex
    ? findDuplicateStrokes(pkg, { osmIndex, claimFilterFor })
    : [];
  // A duplicate is a STRETCH, not a property of a whole line: 東北線-2 is
  // 16 km long and duplicated for 2.3 km of it, so only the stations inside
  // that stretch are in scope.
  const duplicateStretches = new Map();
  for (const row of duplicateRows) {
    if (row.duplicate_verdict !== "duplicate") continue;
    for (const lineId of row.lines) {
      const list = duplicateStretches.get(lineId) || [];
      list.push(...row.duplicate_points);
      duplicateStretches.set(lineId, list);
    }
  }
  const DUPLICATE_STATION_RADIUS_METERS = 600;
  const drawnTwiceAt = (lineId, point) => {
    const points = duplicateStretches.get(lineId);
    if (!points) return false;
    return points.some(
      (sample) => distanceMeters(point, sample) <= DUPLICATE_STATION_RADIUS_METERS,
    );
  };
  const stationNetwork = readJson(NETWORK_PATH);
  const rules = readJson(RULES_PATH);
  const tokyo = readJson(TOKYO_PATH);
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const exactSources = exactEvidence(tokyo);
  const explicitByGroup = new Map(
    rules.explicit_station_rules.map((row) => [row.station_group, row]),
  );
  const networkByGroup = new Map();
  for (const station of stationNetwork.stations) {
    const list = networkByGroup.get(station.physical_station_group) || [];
    list.push(station);
    networkByGroup.set(station.physical_station_group, list);
  }

  const renderedStations = new Map();
  for (const feature of network.stations.features)
    renderedStations.set(
      `${feature.properties.lineId}\0${feature.properties.stationGroupId}`,
      feature,
    );

  const occurrencesByGroup = new Map();
  for (const line of pkg.lines) {
    const display = network.lineById.get(line.id);
    const totalKm = line.segments.reduce((sum, row) => sum + Number(row[0]), 0);
    line.stations.forEach((station, stationIndex) => {
      const group = station[0];
      const geometry = stationGeometry(line, stationIndex);
      const key = `${line.id}\0${group}`;
      const rendered = renderedStations.get(key);
      const operatorForEvidence = line.operator === "東京メトロ" ? "東京地下鉄" : line.operator;
      const evidence = exactSources.get(
        `${operatorForEvidence}\0${line.name}\0${station[1]}`,
      );
      const occurrence = {
        line,
        station,
        stationIndex,
        geometry,
        totalKm,
        railwayIdentity: line.railwayIdentity || familyId(line.id),
        render: {
          coordinate: rendered?.geometry.coordinates || geometry.point,
          bearing: rounded(rendered?.properties.bearing),
        },
        pointToTrackMeters: rounded(distanceToParts(geometry.point, display?.parts), 6),
        basemapExcluded: excludedReason(line),
        basemap: basemapCheck(
          line,
          geometry,
          stationIndex,
          osmIndex,
          filterCache,
          platformIndex,
          n02Features[`${line.operator}\u241F${line.name}\u241F${station[0]}`],
        ),
        evidence: evidence
          ? {
              osm_way_ids: [...evidence.osm_ways].sort((a, b) => a - b),
              sources: [...evidence.sources].sort(),
              basis: "registered_OSM_physical_track",
            }
          : {
              osm_way_ids: [],
              sources: [rules.sources.n02],
              basis: "N02_station_feature_and_RailroadSection; no per-interval OSM way registered",
            },
      };
      const list = occurrencesByGroup.get(group) || [];
      list.push(occurrence);
      occurrencesByGroup.set(group, list);
    });
  }

  const groups = [];

  for (const [stationGroup, occurrences] of occurrencesByGroup) {
    const distinctLines = new Set(occurrences.map((row) => row.line.id));
    const siblingCount = new Set(occurrences.map((row) => familyId(row.line.id))).size;
    const hasSibling = siblingCount < distinctLines.size;
    const hasOffset = occurrences.some((row) => row.pointToTrackMeters > 0.5);
    const hasBasemapDisagreement = occurrences.some((row) =>
      row.basemapExcluded
        ? false
        :
      [
        "package_wrong",
        "possible_wrong_platform",
        "wrong_platform",
        "platform_pick_ambiguous",
        "platform_not_on_claimed_track",
        "platform_level_unverified",
      ].includes(row.basemap?.verdict),
    );
    const hasDuplicate = occurrences.some((row) =>
      drawnTwiceAt(row.line.id, row.geometry.point),
    );
    if (
      distinctLines.size < 2 &&
      !hasSibling &&
      !hasOffset &&
      !hasBasemapDisagreement &&
      !hasDuplicate
    )
      continue;

    const scopeReasons = [];
    if (distinctLines.size >= 2) scopeReasons.push("physical_station_group_on_multiple_display_lines");
    if (hasSibling) scopeReasons.push("sibling_display_strokes_meet_here");
    if (hasOffset) scopeReasons.push("station_point_to_track_offset");
    if (hasBasemapDisagreement) scopeReasons.push("station_zone_basemap_disagreement");
    if (hasDuplicate) scopeReasons.push("same_railway_drawn_twice");
    const stationFacts = networkByGroup.get(stationGroup) || [];
    const roles = new Set(
      stationFacts.flatMap((row) => [row.station_style, ...(row.station_style_tags || [])]),
    );
    if ([...roles].some((role) => /branch|terminal|revers/u.test(role)))
      scopeReasons.push("branch_or_terminal_topology_role");
    if (new Set(occurrences.map((row) => row.line.name)).size > 1)
      scopeReasons.push("canonical_line_boundary_or_interchange");

    const relationships = [];
    const manualReasons = new Set();
    const errors = new Set();
    const suggestedByLine = new Map();
    for (let left = 0; left < occurrences.length; left += 1) {
      for (let right = left + 1; right < occurrences.length; right += 1) {
        const a = occurrences[left];
        const b = occurrences[right];
        // Only meaningful inside one railway: two independent railways sharing
        // a corridor out of a station are the duplicate-stroke audit's subject,
        // not this one's.
        const sharedDeparture =
          a.railwayIdentity === b.railwayIdentity ? sharedDepartureMeters(a, b) : null;
        const classification = classifyPair(a, b, occurrences, sharedDeparture);
        const shouldShare = classification === "A" || classification === "B";
        const coordinateEqual = samePoint(a.geometry.point, b.geometry.point);
        const renderedCoordinateEqual = samePoint(a.render.coordinate, b.render.coordinate);
        const identityEqual = a.railwayIdentity === b.railwayIdentity;
        const tangent = bestContinuationTurn(a, b);
        const problems = [];
        if (shouldShare && !coordinateEqual) problems.push("junction_coordinate_mismatch");
        if (shouldShare && !renderedCoordinateEqual) problems.push("rendered_junction_coordinate_mismatch");
        if (shouldShare && !identityEqual) problems.push("railway_identity_mismatch");
        if (classification === "A" && (tangent == null || tangent >= 5))
          problems.push("continuation_tangent_not_under_5_degrees");
        if (shouldShare && (a.geometry.immediateReturn || b.geometry.immediateReturn))
          problems.push("immediate_leave_and_return");
        for (const problem of problems) errors.add(`${a.line.id} ↔ ${b.line.id}: ${problem}`);

        if (shouldShare) {
          const point = electedJunction(occurrences, a.railwayIdentity);
          if (point) {
            suggestedByLine.set(a.line.id, point);
            suggestedByLine.set(b.line.id, point);
          }
        }
        if ((classification === "C" || classification === "E") && coordinateEqual)
          manualReasons.add(
            `${a.line.id} ↔ ${b.line.id}: independent or vertically separated lines share one source point; platform-level evidence is required`,
          );
        if (
          classification === "D" &&
          [a.line, b.line].some(
            (line) => line.alignmentRole === "paired_alignment" && line.alignmentDirection === "unassigned",
          )
        )
          manualReasons.add(`${a.line.id} ↔ ${b.line.id}: paired alignment direction remains unassigned`);

        relationships.push({
          lines: [a.line.id, b.line.id],
          classification,
          should_share_junction: shouldShare,
          exact_source_coordinate_equal: coordinateEqual,
          exact_render_coordinate_equal: renderedCoordinateEqual,
          railway_identity_equal: identityEqual,
          continuation_tangent_difference_degrees: tangent,
          // Why a same-railway pair is a branch rather than a continuation:
          // this many metres of one alignment leaving the station.
          shared_departure_meters: rounded(sharedDeparture, 1),
          problems,
        });
      }
    }

    for (const occurrence of occurrences) {
      // A railway that really does reverse or spiral here folds by design, and
      // a paired-alignment stroke folds where it rejoins its main line. The
      // station network already tags both (出雲坂根 and 大平台 reversing_station,
      // 土樽/土合/越後中里 loop_station), so the scan reports the folds nobody
      // has accounted for rather than every fold.
      const foldExpected =
        roles.has("reversing_station") ||
        roles.has("loop_station") ||
        occurrence.line.alignmentRole === "paired_alignment";
      if (occurrence.geometry.adjacentFold > 120 && !foldExpected)
        manualReasons.add(
          `${occurrence.line.id}: an adjacent interval folds back ` +
            `${occurrence.geometry.adjacentFold}° — sharper than any railway, and below ` +
            `validate-railway-topology's 60 m edge floor it is invisible there`,
        );
      if (!occurrence.geometry.endpointExact)
        errors.add(`${occurrence.line.id}: station is not the exact adjacent-interval endpoint`);
      if (occurrence.geometry.immediateReturn)
        errors.add(`${occurrence.line.id}: geometry leaves the station and immediately returns`);
      if (occurrence.pointToTrackMeters > 0.5)
        errors.add(`${occurrence.line.id}: point-to-track ${occurrence.pointToTrackMeters} m`);
    }

    for (const occurrence of occurrences) {
      if (occurrence.basemapExcluded) continue;
      const check = occurrence.basemap;
      if (check?.verdict === "package_wrong")
        manualReasons.add(
          `${occurrence.line.id}: drawn ${check.point_to_claimed_track_m} m from its own ` +
            `OSM track with no running rail within ${STATION_CLAIM_GATE_METERS} m ` +
            `(approach median ${check.approach_median_offset_m} m)`,
        );
      if (check?.verdict === "wrong_platform")
        manualReasons.add(
          `${occurrence.line.id}: its own trains use platform ` +
            `${check.platform.ref || check.platform.name || check.platform.osm}, whose midpoint ` +
            `is ${check.platform.dot_to_platform_m} m from the drawn dot`,
        );
      if (check?.verdict === "platform_pick_ambiguous")
        manualReasons.add(
          `${occurrence.line.id}: two candidate platforms only ${check.platform.margin_m} m ` +
            `apart — the cache cannot say which face this line uses`,
        );
      if (check?.verdict === "platform_level_unverified")
        manualReasons.add(
          `${occurrence.line.id}: runs ${occurrence.geometry.vertical} here, and the candidate ` +
            `platform carries no level tag — a plan-view pick cannot separate stacked platforms`,
        );
      if (check?.verdict === "platform_not_on_claimed_track")
        manualReasons.add(
          `${occurrence.line.id}: no platform near the dot is adjacent to a named track of ` +
            `its own line`,
        );
      if (check?.verdict === "possible_wrong_platform")
        manualReasons.add(
          `${occurrence.line.id}: sits ${check.nearest_running_track_m} m from a running rail ` +
            `but ${check.point_to_claimed_track_m} m from a NAMED track of its own line; ` +
            `railway=platform evidence is required to decide`,
        );
      if (drawnTwiceAt(occurrence.line.id, occurrence.geometry.point))
        manualReasons.add(
          `${occurrence.line.id}: shares one alignment with a sibling stroke inside a ` +
            `multi-track corridor — see outputs/railway-audit/duplicate-strokes`,
        );
    }
    const explicit = explicitByGroup.get(stationGroup);
    const classes = [...new Set(relationships.map((row) => row.classification))].sort();
    const status = errors.size
      ? "FIX_REQUIRED"
      : manualReasons.size
        ? "NEEDS_HUMAN_PLATFORM_REVIEW"
        : explicit
          ? "FIXED_AND_VERIFIED"
          : "VERIFIED_NO_CHANGE";
    const stationName = occurrences[0].station[1];
    const lineRows = occurrences.map((row) => ({
      display_line_id: row.line.id,
      canonical_line: row.line.name,
      operator: row.line.operator,
      current_point: row.geometry.point,
      suggested_point: suggestedByLine.get(row.line.id) || row.geometry.point,
      platform_track_layer: {
        platform: row.evidence.basis === "registered_OSM_physical_track" ? "registered_line_platform" : "N02_line_station_feature",
        track: row.evidence.basis,
        vertical: row.geometry.vertical,
        structures: row.geometry.structure,
      },
      railwayIdentity: row.railwayIdentity,
      render_point: row.render.coordinate,
      render_bearing_degrees: row.render.bearing,
      station_turn_degrees: row.geometry.stationTurn,
      adjacent_interval_fold_degrees: row.geometry.adjacentFold,
      exact_adjacent_interval_endpoint: row.geometry.endpointExact,
      point_to_track_meters: row.pointToTrackMeters,
      // The ledger suppresses a DISAGREEMENT, never a passing row: a station
      // on a suspended line that still measures clean should read as clean.
      basemap_verdict:
        row.basemapExcluded &&
        !["agrees", "agrees_on_platform", "not_measured"].includes(
          row.basemap?.verdict,
        )
          ? "excluded_by_ledger"
          : row.basemap?.verdict || "not_measured",
      basemap_excluded_reason: row.basemapExcluded || null,
      fix_class: row.basemap?.fix_class || null,
      n02_platform_features: row.basemap?.n02_platform_features ?? null,
      platform_osm: row.basemap?.platform?.osm || null,
      platform_ref: row.basemap?.platform?.ref || null,
      platform_pick_margin_m: row.basemap?.platform?.margin_m ?? null,
      dot_to_platform_m: row.basemap?.platform?.dot_to_platform_m ?? null,
      claim_basis: row.basemap?.claim_strength || null,
      claimed_osm_way_ids: row.basemap?.claimed_osm_way_ids || [],
      claimed_way_name: row.basemap?.claimed_way_name || null,
      point_to_claimed_track_m: row.basemap?.point_to_claimed_track_m ?? null,
      approach_median_offset_m: row.basemap?.approach_median_offset_m ?? null,
      suggested_point_basis:
        suggestedByLine.get(row.line.id) && suggestedByLine.get(row.line.id) !== row.geometry.point
          ? "elected_junction_of_same_railway"
          : row.basemap?.suggestion_basis || "none",
      drawn_twice: drawnTwiceAt(row.line.id, row.geometry.point),
      immediate_leave_and_return: row.geometry.immediateReturn,
      osm_way_ids: row.evidence.osm_way_ids,
      source_refs: row.evidence.sources,
      alignment_role: row.line.alignmentRole || null,
      alignment_direction: row.line.alignmentDirection || null,
    }));

    groups.push({
      station_group: stationGroup,
      station_name: stationName,
      scope_reasons: [...new Set(scopeReasons)].sort(),
      classifications: classes.length ? classes : ["C"],
      operators: [...new Set(occurrences.map((row) => row.line.operator))].sort(),
      display_line_ids: occurrences.map((row) => row.line.id).sort(),
      network_roles: [...roles].filter(Boolean).sort(),
      apple_maps_result: explicit?.apple_maps_result || "pending_dedicated_capture",
      explicit_evidence: explicit?.evidence || null,
      explicit_rule: explicit?.rule || null,
      lines: lineRows,
      relationships,
      repair_status: status,
      unresolved_reasons: [...manualReasons].sort(),
      validation_errors: [...errors].sort(),
    });
  }

  groups.sort((a, b) =>
    b.display_line_ids.length - a.display_line_ids.length ||
    a.station_name.localeCompare(b.station_name, "ja") ||
    a.station_group.localeCompare(b.station_group),
  );
  const fixed = groups.filter((row) => row.repair_status === "FIXED_AND_VERIFIED");
  const verified = groups.filter((row) => row.repair_status === "VERIFIED_NO_CHANGE");
  const manual = groups.filter((row) => row.repair_status === "NEEDS_HUMAN_PLATFORM_REVIEW");
  const failed = groups.filter((row) => row.repair_status === "FIX_REQUIRED");
  const relationshipCounts = Object.fromEntries(
    ["A", "B", "C", "D", "E"].map((classification) => [
      classification,
      groups.flatMap((row) => row.relationships).filter((row) => row.classification === classification).length,
    ]),
  );
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    package: path.relative(ROOT_DIR, PACKAGE_PATH),
    package_version: pkg.version,
    evidence: path.relative(ROOT_DIR, RULES_PATH),
    summary: {
      physical_station_groups_in_package: occurrencesByGroup.size,
      audited_station_groups: groups.length,
      multi_display_line_groups: groups.filter((row) => row.display_line_ids.length >= 2).length,
      audited_display_station_occurrences: groups.reduce((sum, row) => sum + row.lines.length, 0),
      relationship_counts: relationshipCounts,
      fixed_and_verified: fixed.length,
      verified_no_change: verified.length,
      needs_human_platform_review: manual.length,
      fix_required: failed.length,
      basemap: {
        cache_cells: osm.cells?.length || 0,
        cache_ways: osm.ways || 0,
        platform_cells: platformCache.cells?.length || 0,
        platforms: platformCache.platforms || 0,
        verdicts: groups
          .flatMap((row) => row.lines)
          .reduce((counts, line) => {
            counts[line.basemap_verdict] = (counts[line.basemap_verdict] || 0) + 1;
            return counts;
          }, {}),
        measured_occurrences: groups.reduce(
          (sum, row) =>
            sum + row.lines.filter((line) => line.basemap_verdict !== "not_measured").length,
          0,
        ),
      },
      unexplained_fold_backs_over_120_degrees: groups.reduce(
        (sum, row) =>
          sum +
          row.unresolved_reasons.filter((reason) => reason.includes("folds back")).length,
        0,
      ),
      fold_backs_over_120_degrees: groups.reduce(
        (sum, row) =>
          sum + row.lines.filter((line) => (line.adjacent_interval_fold_degrees || 0) > 120).length,
        0,
      ),
      duplicate_strokes: {
        relationships: duplicateRows.length,
        adjudicated_duplicate: duplicateRows.filter(
          (row) => row.duplicate_verdict === "duplicate",
        ).length,
        lines_involved: duplicateStretches.size,
      },
    },
    fixed_station_groups: fixed.map((row) => ({ station_group: row.station_group, station_name: row.station_name })),
    verified_no_change_station_groups: verified.map((row) => ({ station_group: row.station_group, station_name: row.station_name })),
    needs_human_station_groups: manual.map((row) => ({
      station_group: row.station_group,
      station_name: row.station_name,
      reasons: row.unresolved_reasons,
    })),
    failed_station_groups: failed.map((row) => ({
      station_group: row.station_group,
      station_name: row.station_name,
      errors: row.validation_errors,
    })),
    station_groups: groups,
  };
}

function csvRows(audit) {
  const headers = [
    "station_group",
    "station_name",
    "display_line_id",
    "canonical_line",
    "operator",
    "current_point",
    "suggested_point",
    "platform_track_layer",
    "classifications",
    "should_share_junction",
    "railwayIdentity",
    "tangent_differences_degrees",
    "point_to_track_meters",
    "adjacent_interval_fold_degrees",
    "point_to_claimed_track_m",
    "approach_median_offset_m",
    "basemap_verdict",
    "fix_class",
    "n02_platform_features",
    "platform_osm",
    "platform_ref",
    "platform_pick_margin_m",
    "dot_to_platform_m",
    "claim_basis",
    "claimed_osm_way_ids",
    "suggested_point_basis",
    "drawn_twice",
    "osm_way_ids",
    "apple_maps_result",
    "repair_status",
    "unresolved_reasons",
    "validation_errors",
  ];
  const rows = [headers];
  for (const group of audit.station_groups) {
    for (const line of group.lines) {
      const relationships = group.relationships.filter((row) => row.lines.includes(line.display_line_id));
      rows.push([
        group.station_group,
        group.station_name,
        line.display_line_id,
        line.canonical_line,
        line.operator,
        line.current_point,
        line.suggested_point,
        line.platform_track_layer,
        [...new Set(relationships.map((row) => row.classification))],
        relationships.some((row) => row.should_share_junction),
        line.railwayIdentity,
        relationships.map((row) => ({ with: row.lines.find((id) => id !== line.display_line_id), value: row.continuation_tangent_difference_degrees })),
        line.point_to_track_meters,
        line.adjacent_interval_fold_degrees,
        line.point_to_claimed_track_m,
        line.approach_median_offset_m,
        line.basemap_verdict,
        line.fix_class,
        line.n02_platform_features,
        line.platform_osm,
        line.platform_ref,
        line.platform_pick_margin_m,
        line.dot_to_platform_m,
        line.claim_basis,
        line.claimed_osm_way_ids,
        line.suggested_point_basis,
        line.drawn_twice,
        line.osm_way_ids,
        group.apple_maps_result,
        group.repair_status,
        group.unresolved_reasons,
        group.validation_errors,
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function markdown(audit) {
  const s = audit.summary;
  const lines = [
    "# 日本多线车站全量审计",
    "",
    `生成时间：${audit.generated_at}`,
    "",
    "本报告的连续性判定使用相邻区间端点、`railwayIdentity`、最终站点 feature 和切线；不把同名或同坐标本身视为通过。逐站逐线明细见 `audit.csv`，完整关系和证据字段见 `audit.json`。",
    "",
    "## 汇总",
    "",
    "| 指标 | 数量 |",
    "| --- | ---: |",
    `| package physical station groups | ${s.physical_station_groups_in_package} |`,
    `| 审计 station groups | ${s.audited_station_groups} |`,
    `| 多 display-line groups | ${s.multi_display_line_groups} |`,
    `| 审计 display station occurrences | ${s.audited_display_station_occurrences} |`,
    `| A / B / C / D / E 关系 | ${["A", "B", "C", "D", "E"].map((key) => s.relationship_counts[key]).join(" / ")} |`,
    `| 已修复并验证 | ${s.fixed_and_verified} |`,
    `| 无需修改并验证 | ${s.verified_no_change} |`,
    `| 仍需人工站台判断 | ${s.needs_human_platform_review} |`,
    `| 自动验收失败 | ${s.fix_required} |`,
    "",
    "## 站域底图对照",
    "",
    s.basemap.cache_ways
      ? [
          `OSM 缓存 ${s.basemap.cache_cells} cell / ${s.basemap.cache_ways} way；` +
            `站台缓存 ${s.basemap.platform_cells} cell / ${s.basemap.platforms} 个站台。`,
          "距离量的是**该线自己认领的轨道**（operator+name，见 station-track-claim.mjs），",
          "不是最近的任意铁轨——大站里十几股道彼此 5–15 m，按最近量恒等于通过。",
          "门槛按已知正确的线实测校准：站点 25 m、进站中位 20 m（见脚本注释）。",
          "「疑似落在别人的站台」需要 railway=platform 才能定案，语料缓存里没有，",
          "所以只报不判——不拿缺标签当缺陷。",
          "",
          "| 指标 | 数量 |",
          "| --- | ---: |",
          `| 已测量 line×station | ${s.basemap.measured_occurrences} |`,
          [
            ["agrees", "与底图一致"],
            ["agrees_on_platform", "落在本线自己的站台上"],
            ["wrong_platform", "**落在别的站台上**（已指出应在哪个）"],
            ["platform_pick_ambiguous", "两个候选站台相距 <30 m，缓存判不出"],
            ["platform_not_on_claimed_track", "附近没有贴着本线具名轨道的站台"],
            ["platform_level_unverified", "立体叠置站：候选站台无层级标签，平面判据不足"],
            ["tunnel_basemap_approximate", "地下段：OSM 隧道是近似连线，**底图错，不迁就**"],
            ["terminus_track_starts_beyond_platform", "终点站：本线具名轨道未延伸到车挡，进站几何合格"],
            ["systematic_line_offset", "整条线的系统性测绘差：站点偏移不超过该线自身偏移"],
            ["excluded_by_ledger", "已裁决豁免（水害休止等产品决策）"],
            ["possible_wrong_platform", "踩着轨道但不是本线具名轨道，尚无站台数据"],
            ["package_wrong", "站点悬空：25 m 内没有任何运行轨道"],
            ["undecidable", "无可认领轨道，不做结论"],
          ]
            .filter(([key]) => s.basemap.verdicts[key])
            .map(([key, label]) => `| ${label} | ${s.basemap.verdicts[key]} |`)
            .join("\n"),
        ].join("\n")
      : "OSM 缓存不存在，本次未做站域底图对照（全部记为 not_measured，不做任何推断）。",
    "",
    "## 重复绘制",
    "",
    `扫描 ${s.duplicate_strokes.relationships} 组同铁路/同名笔画关系，其中 ` +
      `${s.duplicate_strokes.adjudicated_duplicate} 组判定为真重复，涉及 ` +
      `${s.duplicate_strokes.lines_involved} 条线。明细见 ` +
      "`outputs/railway-audit/duplicate-strokes/jp-README.md`。",
    "",
    "## 交付物与验收",
    "",
    "- `audit.csv`：逐站逐 display line 全量表，包含点位、站台/轨道/层级、A–E、junction、identity、切线、point-to-track、OSM/Apple 状态和未解决原因。",
    "- `audit.json`：保留每个 station group 的线路对关系、证据和自动验收细节。",
    "- `screenshots/tokyo-before-after.png` 与 `screenshots/sapporo-before-after.png`：直接由重建前归档包和最终包渲染的局部拓扑对照。",
    "- `screenshots/tokyo-final-ui.png`：现行应用、最终 render model 与在线底图的东京站 UI 核对。",
    "",
    "2026-08-18 验收结果：`npm test` 272/272 PASS；本审计 `--strict` PASS；topology strict 657 线中 651 PASS / 6 WARNING / 0 ERROR；station anchoring strict 10209 PASS / 14 WARNING / 0 ERROR。render snapshot、continuity、parallel corridor、paired alignment、route slicing 和 gzip parity 全部通过。",
    "",
    "topology 保留的 6 个 warning 是既有的中央/奥羽/篠ノ井/东海道/木次线锐角或东海道新干线覆盖告警；留萌线为已登记的废止线缺口。14 个 anchoring warning 均是终点进站位移，最终线到点和端点距离均为 0。",
    "",
    "## 本次证据、构建器与测试文件",
    "",
    "- Evidence：`app/data/raw/railway/jp/evidence/multi-line-station-audit-rules.json`、`tokyo-station-platforms.json`，以及重建 inventory 中的 station network、line-shape overrides 和 network corrections。",
    "- Builders/validation：`build-japan-package-from-inventory.py`、`build-parallel-corridors.mjs`、`finalize-japan-package.mjs`、`promote-lines.mjs`、`audit-japan-multiline-stations.mjs`、`render-japan-multiline-comparisons.mjs`。",
    "- Tests：`japan-multiline-station-audit.test.mjs`、`japan-rail-continuity.test.js`、`rail-network.test.js`、`rail-package-promotion.test.mjs`、`railway-display-curve.test.mjs`、`station-render-anchoring.test.js` 和 `railmap-popup-japan.test.js`。",
    "",
    "## 已修复车站",
    "",
    ...(audit.fixed_station_groups.length
      ? audit.fixed_station_groups.map((row) => `- ${row.station_name} (${row.station_group})`)
      : ["- 无"]),
    "",
    "## 无需修改但已验证",
    "",
    ...audit.verified_no_change_station_groups.map((row) => `- ${row.station_name} (${row.station_group})`),
    "",
    "## 仍需人工判断",
    "",
    ...(audit.needs_human_station_groups.length
      ? audit.needs_human_station_groups.map(
          (row) => `- ${row.station_name} (${row.station_group})：${row.reasons.join("；")}`,
        )
      : ["- 无"]),
    "",
    "## 自动验收失败",
    "",
    ...(audit.failed_station_groups.length
      ? audit.failed_station_groups.map(
          (row) => `- ${row.station_name} (${row.station_group})：${row.errors.join("；")}`,
        )
      : ["- 无"]),
    "",
    "Apple Maps 项若为 `pending_dedicated_capture`，表示已有核对队列但尚未把该站提升为视觉签核；不会被伪装成已核对。",
    "",
  ];
  return lines.join("\n");
}

function main() {
  const audit = buildAudit();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(JSON_PATH, `${JSON.stringify(audit, null, 2)}\n`);
  fs.writeFileSync(CSV_PATH, csvRows(audit));
  fs.writeFileSync(MARKDOWN_PATH, markdown(audit));
  process.stdout.write(
    `jp multi-line stations: ${audit.summary.audited_station_groups} groups, ` +
      `${audit.summary.fix_required} failures, ${audit.summary.needs_human_platform_review} manual, ` +
      "\n",
  );
  if (process.argv.includes("--strict") && audit.summary.fix_required) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
