#!/usr/bin/env node
/*
 * validate-railway-topology.mjs — the standing railway audit.
 *
 * Measures the DRAWN network (rail-network.js display parts) against
 *   * the official N02 RailroadSection geometry (Japan), and
 *   * the package's own station topology (all four countries),
 * and reports every defect class the render contract cares about:
 *
 *   missing_line               an N02 (operator, line) whose track nobody draws
 *   uncovered_corridor         a stretch of official track no drawn part follows
 *   wrong_terminus             a drawn stroke that does not begin/end at a station
 *   station_not_on_line        a station the line's own geometry never reaches
 *   branch_stops_at_junction   a branch drawn only to the switch, not to its station
 *   shared_track_not_overlapping   junction→station drawn twice but not coincident
 *   wrong_branch_direction     a branch that leaves its junction by turning back
 *   disconnected_geometry      a jump inside one stroke
 *   duplicate_segment          repeated vertices inside one stroke
 *   sharp_artificial_turn      a corner too tight to be track (fold or switchback)
 *   interval_overshoots_audit  an interval drawn far past the distance it was audited to
 *   interval_doubles_back_at_station  an interval that reaches its own platform and carries on
 *   reversal_joint_redraws_track      a reversal that leaves along the interval it arrived on
 *   parallel_spacing_*         independent railways sharing a corridor
 *
 * Usage:
 *   node scripts/validation/validate-railway-topology.mjs                 # every country
 *   node scripts/validation/validate-railway-topology.mjs --country jp
 *   node scripts/validation/validate-railway-topology.mjs --json out.json
 *   node scripts/validation/validate-railway-topology.mjs --lines 函館線,中央線
 *   node scripts/validation/validate-railway-topology.mjs --corridors 40
 *
 * Exit code is 0 unless --strict is given, in which case any ERROR fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import {
  angleBetweenHeadings,
  coincidentRunMeters,
  createEdgeIndex,
  displayParts,
  distanceMeters,
  localHeading,
  pathLengthMeters,
  resample,
  sharedTrackPrefix,
  stationApproachFold,
  straightRunMeters,
  turnDegrees,
} from "../railway/lib/railway-topology.mjs";
// The very rule the renderer decides lanes by, so the audit cannot drift into
// grading the map against a second opinion.
import {
  CorridorRenderMode,
  corridorRenderMode,
} from "../railway/lib/parallel-corridors.mjs";

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const RailNetwork = require(path.join(APP_DIR, "public/rail-network.js"));

export const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];

// ── thresholds ───────────────────────────────────────────────────────────────
// A station anchor sits up to ~130 m off the surveyed centre-line in jp-2025,
// so 150 m is "the line passes this station" and anything beyond is a defect.
const STATION_TOUCH_METERS = 150;
// Display parts are pinned to start and end ON a station (rail-network.js);
// 1 m is the pinned invariant, 5 m the point at which it is a real break.
const ENDPOINT_STATION_METERS = 5;
// An N02 sample this far from every drawn stroke counts as track nobody drew.
const COVERAGE_MISS_METERS = 150;
// Uncovered track with other drawn rail this close is a parallel alignment the
// single-stroke drawing model deliberately collapses, not a hole in the map.
const COVERAGE_PARALLEL_METERS = 1200;
// Only report an uncovered corridor once it is long enough to see.
const COVERAGE_REPORT_METERS = 1000;
// Sampling steps.
const COVERAGE_STEP_METERS = 50;
const CORRIDOR_STEP_METERS = 100;
// Two different lines within this distance are sharing a corridor.
const CORRIDOR_NEAR_METERS = 200;
// …and below this they are drawing the same track, not a parallel one.
const CORRIDOR_SHARED_METERS = 12;
const CORRIDOR_MIN_LENGTH_METERS = 800;
// Mirror of RAILWAY_STYLE in public/railmap-style.js. The renderer owns these
// numbers; the audit only needs them to answer "at what zoom do these two
// railways stop overlapping on screen?". test/railway-topology-audit.test.js
// asserts the two copies agree, so the mirror cannot drift.
const RENDER_STYLE = Object.freeze({
  stationDiameterPx: 6,
  railWidthPx: 1.5,
  parallelGapPx: 1.2,
  // …and the scale ramp those weights ride: full weight from this zoom in,
  // then base^(zoom − anchor) down to a floor.
  fullWeightZoom: 7,
  weightZoomBase: Math.SQRT2,
  minWeightScale: 1 / 3,
});
// Web-mercator metres per CSS pixel at zoom 0 on the equator, on MapLibre's
// 512 px tiles — the tile size the app's map actually uses (see
// app-map-fit.js), so these zooms are the zooms a reader is looking at.
const MERCATOR_METERS_PER_PIXEL_Z0 = 156543.03392 / 2;
// A branch leaving its junction at more than this has doubled back.
const BRANCH_TURN_SUSPICIOUS_DEGREES = 90;
// Shared lead-in shorter than this cannot support a direction verdict.
const DIRECTION_MIN_BASELINE_METERS = 120;
const BRANCH_TURN_WRONG_DEGREES = 135;
// The shared lead-in is a copy of the trunk's own vertices, so any real
// deviation means the two strokes stopped being coincident.
const SHARED_TRACK_OVERLAP_METERS = 2;
// A corner this tight, with real track either side, is not a curve.
const SHARP_TURN_DEGREES = 110;
// …and "real track either side" is measured as a RUN, not as the two edges
// that happen to touch the corner.
//
// The edge form of this test was the audit's reversal blind spot. A stroke
// that doubles back turns round at ONE vertex, and the digitiser decides where
// the neighbouring vertices fall: 東海道線 高輪ゲートウェイ→品川 folded 167°
// between a 70 m and a 36 m edge, so the 36 m side failed a two-sided 60 m
// gate and the whole corner was skipped — the audit read 0 ERROR over a fold
// that added 116 % to the interval. Every fold is shaped that way, so the gate
// was excluding exactly the defect it was written to find.
//
// straightRunMeters walks outward instead and stops at the next corner, so a
// cusp is kept when real track leaves it BOTH ways and dropped when one side
// is a couple of jitter vertices (東海道新幹線's 5 m barb at 品川, 高野線's
// 3 m one at 木津川). 60 m is unchanged: it is still "more track than any
// survey wobble", only now measured over the run that carries it.
const SHARP_TURN_RUN_METERS = 60;
// Stop walking well past the point the answer is settled — a cusp on a 280 km
// trunk must not walk the trunk. Reported as "≥600 m" when it bites.
const SHARP_TURN_RUN_CAP_METERS = 600;
// An interval drawn this much past the distance it was audited to has left
// its station the wrong way and come back — the other half of the reversal
// story, and the half a corner test cannot see when the fold is drawn as a
// smooth hairpin rather than a cusp.
//
// Both bands are the package builder's own, restated as a standing gate
// (build-japan-package-from-inventory.py: REANCHOR_DETOUR_FACTOR / FLOOR and
// GROSS_DETOUR_FACTOR / FLOOR). The builder re-anchors a station whose
// interval overshoots the first band and refuses one that overshoots the
// second; a package that ships either has bypassed that guard.
//
// Both arms must be exceeded, so neither a long interval's ordinary slack nor
// a 100 m platform link's percentage counts. Real reversals are safe: a
// switchback's 営業キロ includes the switchback, so 出雲坂根, 姨捨 and 真幸
// all draw SHORTER than they are audited at. Measured over the shipped
// packages, the worst honest interval is 大阪→福島 at 1.20× (+177 m) and
// 苗穂→札幌 at +182 m (1.11×) — each fails the other arm with room to spare.
const INTERVAL_DETOUR_FACTOR = 1.3;
const INTERVAL_DETOUR_FLOOR_METERS = 300;
const INTERVAL_GROSS_FACTOR = 3.0;
const INTERVAL_GROSS_FLOOR_METERS = 2000;
// ── the renderer's own numbers, mirrored ──────────────────────────────────
// rail-network.js decides what counts as track re-used rather than track
// newly laid, and the audit must not hold a second opinion: a reversal it
// calls a defect while the renderer calls it a branch would be the audit
// grading its own guess. test/railway-topology-audit.test.js reads both out of
// rail-network.js, so the mirror cannot drift.
//
//   RETRACE_MIN_TAIL_METERS  what is left of an interval after its retraced
//                            head is trimmed has to be REAL RAILWAY, not a
//                            stub of rounding noise.
//   RETRACE_MIN_RUN_METERS   only a SUSTAINED run of re-used track is a
//                            retrace; a few metres at a station boundary are
//                            unavoidable.
const RENDERER_REAL_TRACK_METERS = 150;
const RENDERER_RETRACE_RUN_METERS = 600;
// A fold at a platform is an excursion out and the same excursion back, so its
// surplus is twice the arm. One arm has to be real railway by the renderer's
// own floor before the audit calls it anything — under that it is a survey
// wobble in a station throat, and the packages carry a handful (東日本 京葉線
// at 二俣新町 wanders 70 m; 上越線's tunnel mouth at 土樽, 40 m).
const APPROACH_FOLD_METERS = 2 * RENDERER_REAL_TRACK_METERS;
// A single edge longer than this is worth checking. Most are legitimate: a
// Shinkansen tunnel is digitised as one long gentle chord. It is only a hole
// when the chord leaves the official alignment, which needs a reference
// geometry to prove — see referenceIndex below.
const DISCONNECT_METERS = 1500;
// How far a long chord may sit from the official track before it is a
// shortcut rather than a sparsely digitised straight.
const DISCONNECT_OFFTRACK_METERS = 250;

// Package operator names that are the current brand of an N02 legal name.
// Kept explicit: a fuzzy match would silently absorb a genuinely missing line.
const OPERATOR_ALIASES = new Map([
  ["東京メトロ", "東京地下鉄"],
  ["Osaka Metro", "大阪市高速電気軌道"],
]);

function canonicalOperator(name) {
  return OPERATOR_ALIASES.get(name) || name;
}

function severityRank(severity) {
  return severity === "ERROR" ? 2 : severity === "WARNING" ? 1 : 0;
}

// ── loading ──────────────────────────────────────────────────────────────────

function loadNetwork(country) {
  const file = path.join(APP_DIR, `public/rail/${country}-2025.json`);
  if (!fs.existsSync(file)) return null;
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  if (network) network.packageVersion = pkg.version;
  // The built network keeps a line's TOTAL kilometres, not the audited figure
  // each interval was cut to. checkIntervalDistances needs the per-interval
  // one, so hand the compact row back to its line.
  if (network)
    for (const compactLine of pkg.lines || []) {
      const line = network.lineById.get(compactLine.id);
      if (line) line.compactLine = compactLine;
    }
  return network;
}

/**
 * The official survey to check a country's drawn network against.
 *
 * Japan has N02 (国土数値情報); Taiwan, Hong Kong and Macao ship the official
 * geometry their packages were cut from, in the same country-neutral schema.
 * Both are normalised to `{ operator, name, coordinates }` so every country
 * gets the identical completeness, coverage and chord analysis — a drawn line
 * with nothing to compare it against is a line nobody has checked.
 */
function loadReferenceSections(country) {
  const file = path.join(
    APP_DIR,
    country === "jp" ? "data/rail-sections.json" : `data/rail-sections-${country}.json`,
  );
  if (!fs.existsSync(file)) return null;
  const features = JSON.parse(fs.readFileSync(file, "utf8")).features || [];
  return features
    .filter((feature) => feature.geometry?.type === "LineString")
    .map((feature) => {
      const properties = feature.properties || {};
      return {
        operator: properties.N02_004 ?? properties.operator ?? "",
        name: properties.N02_003 ?? properties.line_name ?? "",
        coordinates: feature.geometry.coordinates,
      };
    });
}

// ── per-line structural checks ───────────────────────────────────────────────

function checkPartsAndStations(line, problems, referenceIndex) {
  const parts = line.parts || [];
  const stations = (line.stationOrder || []).map((id) => line.stationById?.get?.(id)).filter(Boolean);
  const stationPoints = line.stationPoints;

  parts.forEach((coordinates, partIndex) => {
    // wrong_terminus — every stroke starts and ends on a platform anchor.
    for (const [label, point] of [
      ["start", coordinates[0]],
      ["end", coordinates[coordinates.length - 1]],
    ]) {
      let best = Infinity;
      for (const station of stationPoints)
        best = Math.min(best, distanceMeters(point, station.point));
      if (best > ENDPOINT_STATION_METERS)
        problems.push({
          code: "wrong_terminus",
          severity: "ERROR",
          partIndex,
          detail: `part ${partIndex} ${label} is ${best.toFixed(0)} m from the nearest station of this line`,
          at: point,
        });
    }

    // disconnected_geometry / duplicate_segment — inside a single stroke.
    let duplicates = 0;
    for (let index = 1; index < coordinates.length; index += 1) {
      const gap = distanceMeters(coordinates[index - 1], coordinates[index]);
      if (gap === 0) duplicates += 1;
      if (gap <= DISCONNECT_METERS) continue;
      // Does the official alignment actually run along this chord? Sample it
      // and take the worst miss. Without a reference (tw/hk/mo ship official
      // geometry directly and have nothing to compare against) a long chord
      // can only be reported for review, never asserted to be a hole.
      let worst = 0;
      if (referenceIndex) {
        for (const sample of resample([coordinates[index - 1], coordinates[index]], 200)) {
          const nearest = referenceIndex.nearest(sample.point);
          worst = Math.max(worst, nearest ? nearest.distance : Infinity);
        }
      }
      if (!referenceIndex)
        problems.push({
          code: "long_chord",
          severity: "WARNING",
          partIndex,
          detail: `${(gap / 1000).toFixed(2)} km with no intermediate vertex in part ${partIndex} — no reference geometry to check it against`,
          at: coordinates[index],
        });
      else if (worst > DISCONNECT_OFFTRACK_METERS)
        problems.push({
          code: "disconnected_geometry",
          severity: "ERROR",
          partIndex,
          detail: `${(gap / 1000).toFixed(2)} km chord in part ${partIndex} leaves the official alignment by up to ${worst.toFixed(0)} m`,
          at: coordinates[index],
        });
    }
    if (duplicates)
      problems.push({
        code: "duplicate_segment",
        severity: "WARNING",
        partIndex,
        detail: `${duplicates} repeated vertices in part ${partIndex}`,
      });

    // sharp_artificial_turn — a corner too tight for track, real track both
    // ways out of it. Judge the angle first: cusps are rare, and only a cusp
    // is worth walking the runs for.
    for (let index = 1; index < coordinates.length - 1; index += 1) {
      const deflection = turnDegrees(
        coordinates[index - 1],
        coordinates[index],
        coordinates[index + 1],
      );
      if (deflection < SHARP_TURN_DEGREES) continue;
      const back = straightRunMeters(coordinates, index, -1, {
        maxMeters: SHARP_TURN_RUN_CAP_METERS,
      });
      const forward = straightRunMeters(coordinates, index, +1, {
        maxMeters: SHARP_TURN_RUN_CAP_METERS,
      });
      if (back < SHARP_TURN_RUN_METERS || forward < SHARP_TURN_RUN_METERS) continue;
      // A cusp is a place before it is a number: name the platform it is
      // nearest, because triaging fourteen of these means knowing at a glance
      // which are 姨捨 and 出雲坂根 and which are somewhere no train reverses.
      let nearestStation = null;
      let nearestMeters = Infinity;
      for (const station of stationPoints) {
        const distance = distanceMeters(coordinates[index], station.point);
        if (distance < nearestMeters) {
          nearestMeters = distance;
          nearestStation = station.name;
        }
      }
      const run = (meters) =>
        meters >= SHARP_TURN_RUN_CAP_METERS ? `≥${meters.toFixed(0)}` : meters.toFixed(0);
      problems.push({
        code: "sharp_artificial_turn",
        severity: "WARNING",
        partIndex,
        detail:
          `${deflection.toFixed(0)}° corner with ${run(back)} m and ${run(forward)} m of track either side` +
          (nearestStation ? `, ${(nearestMeters / 1000).toFixed(2)} km from ${nearestStation}` : "") +
          ` — a real switchback or a fold, and only a human can tell which`,
        at: coordinates[index],
      });
    }
  });

  // station_not_on_line — the line's own geometry must reach each of its stops.
  const own = createEdgeIndex(0.01);
  parts.forEach((coordinates, partIndex) => own.add(coordinates, partIndex));
  for (const station of stationPoints) {
    const nearest = own.nearest(station.point);
    if (!nearest || nearest.distance > STATION_TOUCH_METERS)
      problems.push({
        code: "station_not_on_line",
        severity: "ERROR",
        detail: `${station.name} is ${nearest ? nearest.distance.toFixed(0) : "∞"} m from every stroke of this line`,
        at: station.point,
      });
  }
  return { stations, parts };
}

/**
 * Every station-to-station interval, measured against the distance it was
 * audited to.
 *
 * A fold is the one defect that survives every shape test: the track it draws
 * is real track, it starts and ends on real platforms, and where the turn is
 * digitised as a hairpin rather than a cusp no corner test sees it at all.
 * What it cannot hide is the metres. 東海道線 尾頭橋→名古屋 drew 3.594 km
 * against an audited 2.583 because 名古屋's nearest platform section dead-ends
 * south of the station and the path folded back past its own platform; the
 * shape was defensible, the +39 % was not.
 *
 * So this measures nothing about shape and asks only whether the drawn
 * interval spent its kilometres going somewhere.
 */
function checkIntervalDistances(line, problems) {
  const segments = line.compactLine?.segments;
  const stations = line.compactLine?.stations;
  if (!Array.isArray(segments) || !Array.isArray(stations)) return;
  segments.forEach((segment, index) => {
    const auditKm = segment?.[0];
    const coordinates = segment?.[2];
    if (!(auditKm > 0) || !Array.isArray(coordinates) || coordinates.length < 2) return;
    const drawnMeters = pathLengthMeters(coordinates);
    const auditMeters = auditKm * 1000;
    const overshoot = drawnMeters - auditMeters;
    const ratio = drawnMeters / auditMeters;
    const gross =
      ratio >= INTERVAL_GROSS_FACTOR && overshoot >= INTERVAL_GROSS_FLOOR_METERS;
    if (
      !gross &&
      !(ratio >= INTERVAL_DETOUR_FACTOR && overshoot >= INTERVAL_DETOUR_FLOOR_METERS)
    )
      return;
    const hop = `${stations[index]?.[1] ?? "?"}→${stations[index + 1]?.[1] ?? "?"}`;
    problems.push({
      code: "interval_overshoots_audit",
      severity: gross ? "ERROR" : "WARNING",
      detail:
        `${hop} draws ${(drawnMeters / 1000).toFixed(3)} km against an audited ` +
        `${auditKm.toFixed(3)} km (+${overshoot.toFixed(0)} m, +${((ratio - 1) * 100).toFixed(0)} %) — ` +
        `the interval leaves its station the wrong way and comes back`,
      at: coordinates[Math.floor(coordinates.length / 2)],
    });
  });
}

/**
 * Every reversal in the line's own interval geometry — the audit's one
 * remaining blind spot until now.
 *
 * The drawn map cannot show these. Where the line turns back on itself BETWEEN
 * two intervals, the renderer breaks the stroke there (rail-network.js
 * isReversalJoint → flush, and the retrace split beside it), so the reversal
 * leaves no corner in the drawn geometry for sharp_artificial_turn to find; a
 * fold that turns round INSIDE an interval is trimmed by the stroke-end guard
 * or smoothed out by the groomer. Measured over the shipped packages, the
 * drawn network keeps 14 of the 48 corners the interval chain has: 34 of them
 * are invisible, and the great majority are perfectly correct — Japan reverses
 * trains at 藤沢, 柏, 飯能, 早岐, 遠軽, 会津若松, 十和田南 and a dozen more,
 * and breaking the stroke there is the right drawing.
 *
 * So this does not report reversals. It reports the two shapes a reversal
 * takes when it is NOT one, both measured on the package's own intervals:
 *
 *   interval_doubles_back_at_station  the interval reaches its own platform
 *                                     and then lays hundreds more metres
 *                                     before ending there. A terminal reversal
 *                                     does not do this — the two legs meet
 *                                     their platform end-on and stop, which is
 *                                     what makes 藤沢 and 柏 silent here. A
 *                                     switchback does, and says so: it is the
 *                                     same shape, and only a human can tell
 *                                     which, exactly as sharp_artificial_turn
 *                                     has to.
 *
 *   reversal_joint_redraws_track      the interval leaving the reversal is
 *                                     drawn back down the one that arrived.
 *                                     Sharing the rail from platform to switch
 *                                     is the branch contract and every real
 *                                     reversal does it for a few hundred
 *                                     metres; spending more of the interval on
 *                                     the neighbour's rail than on rail of its
 *                                     own is a station order the track cannot
 *                                     honour.
 *
 * Every joint is reported as a fact either way, so a reader can see that a
 * line reverses at 藤沢 and how much rail the two legs share there.
 */
function checkHiddenReversals(line, problems) {
  const segments = line.compactLine?.segments;
  const stations = line.compactLine?.stations;
  if (!Array.isArray(segments) || !Array.isArray(stations)) return [];

  // The intervals as the package stores them, with both ends brought onto the
  // authoritative platform anchors — the same two vertices decodeIntervals
  // welds, so the audit measures the geometry the renderer starts from.
  const intervals = segments.map((segment, index) => {
    const coordinates = (segment?.[2] || []).map((point) => [point[0], point[1]]);
    const from = stations[index];
    const to = stations[(index + 1) % stations.length];
    if (coordinates.length < 2 || !from || !to) return null;
    coordinates[0] = [from[2], from[3]];
    coordinates[coordinates.length - 1] = [to[2], to[3]];
    return { coordinates, from, to };
  });

  // ── a fold at the interval's own platform ──
  intervals.forEach((interval, index) => {
    if (!interval) return;
    const { coordinates, from, to } = interval;
    for (const [station, walk] of [
      [to, coordinates],
      [from, coordinates.slice().reverse()],
    ]) {
      const fold = stationApproachFold(walk, [station[2], station[3]], {
        touchMeters: STATION_TOUCH_METERS,
      });
      if (fold.excessMeters < APPROACH_FOLD_METERS) continue;
      problems.push({
        code: "interval_doubles_back_at_station",
        severity: "WARNING",
        detail:
          `${from[1]}→${to[1]} is already ${fold.chordMeters.toFixed(0)} m from ${station[1]} ` +
          `with ${fold.trackMeters.toFixed(0)} m of track still to lay (+${fold.excessMeters.toFixed(0)} m) — ` +
          `it runs past its own platform and comes back, which is a switchback ` +
          `or a fold, and only a human can tell which`,
        at: [station[2], station[3]],
      });
    }
  });

  // ── a reversal at the joint between two intervals ──
  const reversals = [];
  for (let index = 0; index + 1 < intervals.length; index += 1) {
    const incoming = intervals[index];
    const outgoing = intervals[index + 1];
    if (!incoming || !outgoing) continue;
    const joint = incoming.coordinates[incoming.coordinates.length - 1];
    // Only a joint the two intervals actually meet at can reverse; a gap is
    // somebody else's defect.
    if (distanceMeters(joint, outgoing.coordinates[0]) > ENDPOINT_STATION_METERS)
      continue;
    // Both headings over a real span of track, never off the two vertices
    // touching the joint: surveyed vertices can be a metre apart and say
    // nothing about which way the rail runs. Same span the corner test calls
    // "more track than any survey wobble".
    const arriving = localHeading(
      incoming.coordinates,
      incoming.coordinates.length - 1,
      -1,
      SHARP_TURN_RUN_METERS,
    );
    const leaving = localHeading(outgoing.coordinates, 0, +1, SHARP_TURN_RUN_METERS);
    const deflection = angleBetweenHeadings(arriving, leaving);
    if (deflection == null || deflection < SHARP_TURN_DEGREES) continue;

    const incomingMeters = pathLengthMeters(incoming.coordinates);
    const reusedMeters = coincidentRunMeters(
      incoming.coordinates.slice().reverse(),
      outgoing.coordinates,
      SHARED_TRACK_OVERLAP_METERS,
    );
    reversals.push({
      station: incoming.to[1],
      intervalIndex: index,
      deflectionDegrees: deflection,
      reusedMeters,
      incomingMeters,
      outgoingMeters: pathLengthMeters(outgoing.coordinates),
      at: joint,
    });
    // Both arms, so that neither a long shared throat on a short interval nor
    // a percentage of a hundred metres counts on its own. 成田 hands its
    // 我孫子支線 694 m of the rail it arrived on and 会津若松 hands 1 020 m,
    // and both are the switch really being that far out of the platform.
    if (
      reusedMeters >= RENDERER_RETRACE_RUN_METERS &&
      reusedMeters > incomingMeters - reusedMeters
    )
      problems.push({
        code: "reversal_joint_redraws_track",
        severity: "WARNING",
        detail:
          `the line reverses at ${incoming.to[1]} (${deflection.toFixed(0)}°) and leaves along ` +
          `${(reusedMeters / 1000).toFixed(2)} km of the ${(incomingMeters / 1000).toFixed(2)} km ` +
          `interval it arrived on — more of that interval is redrawn than is left of it, so ` +
          `${incoming.from[1]}→${incoming.to[1]}→${outgoing.to[1]} is an order no track joins up`,
        at: joint,
      });
  }
  return reversals;
}

/**
 * Branch report for every stroke after the first: where it physically leaves
 * the trunk, which station it is considered to join at, how much track the two
 * share, and whether it leaves that junction going forwards.
 */
function checkBranches(line, problems) {
  const parts = line.parts || [];
  if (parts.length < 2) return [];
  const reports = [];
  // The TRUNK is the longest stroke, not stroke 0. Several package lines open
  // on a short stub (水郡線 opens on its 常陸太田 branch), and calling that the
  // trunk would report the main line as a branch of its own branch.
  let trunkIndex = 0;
  let trunkLength = -1;
  parts.forEach((coordinates, index) => {
    const length = pathLengthMeters(coordinates);
    if (length > trunkLength) {
      trunkLength = length;
      trunkIndex = index;
    }
  });

  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    if (partIndex === trunkIndex) continue;
    const coordinates = parts[partIndex];
    // Every OTHER stroke of the same line is "the trunk" for this test.
    const siblings = createEdgeIndex(0.005);
    parts.forEach((other, otherIndex) => {
      if (otherIndex !== partIndex) siblings.add(other, otherIndex);
    });
    const shared = sharedTrackPrefix({ coordinates }, siblings);
    // Which way round is the stroke? A branch is drawn station -> shared track
    // -> junction -> own track, but the package may store it the other way,
    // in which case the shared metres sit at the END.
    const reversed = coordinates.slice().reverse();
    const sharedFromEnd = sharedTrackPrefix({ coordinates: reversed }, siblings);

    const startPoint = coordinates[0];
    let connectionStation = null;
    let connectionDistance = Infinity;
    for (const station of line.stationPoints) {
      const distance = distanceMeters(startPoint, station.point);
      if (distance < connectionDistance) {
        connectionDistance = distance;
        connectionStation = station;
      }
    }

    const head = shared.lengthMeters >= sharedFromEnd.lengthMeters ? shared : sharedFromEnd;
    const walk = head === shared ? coordinates : reversed;
    const junctionIndex = head.junctionIndex;
    const junction = walk[junctionIndex];
    // Direction test: heading of the shared track arriving at the junction vs
    // heading of the branch-only track leaving it. A branch that leaves by
    // turning back on itself is connected to the wrong station.
    // The direction verdict needs a real baseline on BOTH sides of the switch.
    // With only a few tens of metres of lead-in the "incoming" heading is just
    // the platform-anchor-to-first-vertex stub, which points wherever the
    // anchor happens to sit and reads as 180° at random. Below the minimum
    // span the honest answer is "cannot tell from geometry", not a verdict.
    const incomingSpan = pathLengthMeters(walk.slice(0, junctionIndex + 1));
    const measurable = incomingSpan >= DIRECTION_MIN_BASELINE_METERS;
    const incoming = measurable ? localHeading(walk, junctionIndex, -1) : null;
    const outgoing =
      junctionIndex < walk.length - 1 ? localHeading(walk, junctionIndex, +1) : null;
    const turn = measurable ? angleBetweenHeadings(incoming, outgoing) : null;

    const report = {
      partIndex,
      connectionStation: connectionStation ? connectionStation.name : null,
      connectionStationMeters: connectionDistance,
      junction,
      sharedTrackMeters: head.lengthMeters,
      sharedTrackMaxDeviationMeters: head.maxDeviationMeters,
      alongsideMeters: head.nearLengthMeters,
      branchLengthMeters: pathLengthMeters(coordinates) - head.lengthMeters,
      incomingHeading: incoming,
      outgoingHeading: outgoing,
      turnDegrees: turn,
      turnMeasurable: measurable,
    };
    reports.push(report);

    if (connectionDistance > ENDPOINT_STATION_METERS)
      problems.push({
        code: "branch_stops_at_junction",
        severity: "ERROR",
        partIndex,
        detail: `branch stroke ${partIndex} starts ${connectionDistance.toFixed(0)} m from any station — it was cut at the switch`,
        at: startPoint,
      });
    if (head.lengthMeters > 0 && head.maxDeviationMeters > SHARED_TRACK_OVERLAP_METERS)
      problems.push({
        code: "shared_track_not_overlapping",
        severity: "ERROR",
        partIndex,
        detail: `${(head.lengthMeters / 1000).toFixed(2)} km of shared track deviates up to ${head.maxDeviationMeters.toFixed(1)} m from the trunk`,
        at: junction,
      });
    // Running ALONGSIDE another stroke of the same line without ever sharing
    // its vertices is legitimate where the corridor really has separate tracks
    // (a four-track approach, a trunk continuation beside its own other
    // stroke) and a defect where it does not. The audit cannot tell those
    // apart from geometry, so it asks for a human instead of guessing.
    else if (
      head.lengthMeters < 50 &&
      head.nearLengthMeters >= 300 &&
      connectionDistance <= ENDPOINT_STATION_METERS
    )
      problems.push({
        code: "parallel_not_shared_lead_in",
        severity: "WARNING",
        partIndex,
        detail: `stroke ${partIndex} runs ${(head.nearLengthMeters / 1000).toFixed(2)} km beside another stroke of this line without sharing its track — confirm the corridor really has separate tracks`,
        at: junction,
      });
    if (turn != null && turn >= BRANCH_TURN_WRONG_DEGREES)
      problems.push({
        code: "wrong_branch_direction",
        severity: "ERROR",
        partIndex,
        detail: `branch leaves its junction at ${turn.toFixed(0)}° — it doubles back`,
        at: junction,
      });
    else if (turn != null && turn >= BRANCH_TURN_SUSPICIOUS_DEGREES)
      problems.push({
        code: "wrong_branch_direction",
        severity: "WARNING",
        partIndex,
        detail: `branch leaves its junction at ${turn.toFixed(0)}° — verify the connection station`,
        at: junction,
      });
  }
  return reports;
}

// ── N02 coverage (Japan) ─────────────────────────────────────────────────────

function buildReferenceGroups(sections) {
  const groups = new Map();
  for (const feature of sections) {
    const { operator, name } = feature;
    const key = `${operator}\u0000${name}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { operator, name, features: [], km: 0 }));
    group.features.push(feature);
    group.km += pathLengthMeters(feature.coordinates) / 1000;
  }
  return groups;
}

function measureCoverage(groups, drawnIndex) {
  const perGroup = new Map();
  const uncoveredRuns = [];
  for (const [key, group] of groups) {
    let missMeters = 0;
    let parallelMeters = 0;
    let isolatedMeters = 0;
    let run = null;
    for (const feature of group.features) {
      const samples = resample(feature.coordinates, COVERAGE_STEP_METERS);
      for (const sample of samples) {
        const nearest = drawnIndex.nearest(sample.point);
        const distance = nearest ? nearest.distance : Infinity;
        if (distance <= COVERAGE_MISS_METERS) {
          if (run) {
            if (run.meters >= COVERAGE_REPORT_METERS) uncoveredRuns.push(run);
            run = null;
          }
          continue;
        }
        missMeters += COVERAGE_STEP_METERS;
        const parallel = distance <= COVERAGE_PARALLEL_METERS;
        if (parallel) parallelMeters += COVERAGE_STEP_METERS;
        else isolatedMeters += COVERAGE_STEP_METERS;
        if (!run)
          run = {
            group: key,
            operator: group.operator,
            name: group.name,
            meters: 0,
            parallelMeters: 0,
            start: sample.point,
            end: sample.point,
            maxDistance: 0,
          };
        run.meters += COVERAGE_STEP_METERS;
        if (parallel) run.parallelMeters += COVERAGE_STEP_METERS;
        run.end = sample.point;
        run.maxDistance = Math.max(run.maxDistance, distance === Infinity ? 99999 : distance);
      }
      if (run) {
        if (run.meters >= COVERAGE_REPORT_METERS) uncoveredRuns.push(run);
        run = null;
      }
    }
    perGroup.set(key, {
      operator: group.operator,
      name: group.name,
      km: group.km,
      missKm: missMeters / 1000,
      parallelKm: parallelMeters / 1000,
      isolatedKm: isolatedMeters / 1000,
    });
  }
  uncoveredRuns.sort((a, b) => b.meters - a.meters);
  return { perGroup, uncoveredRuns };
}

// ── parallel corridors ───────────────────────────────────────────────────────

function detectCorridors(parts) {
  const index = createEdgeIndex(0.005);
  for (const part of parts) index.add(part.coordinates, part);

  const runs = new Map(); // pairKey → open run
  const finished = [];
  const closeRun = (key) => {
    const run = runs.get(key);
    runs.delete(key);
    if (!run) return;
    if (run.lengthMeters >= CORRIDOR_MIN_LENGTH_METERS) finished.push(run);
  };

  for (const part of parts) {
    const samples = resample(part.coordinates, CORRIDOR_STEP_METERS);
    const openHere = new Set();
    for (const sample of samples) {
      const near = index.within(sample.point, CORRIDOR_NEAR_METERS, (meta) => {
        if (meta === part) return false;
        // Two strokes of the SAME line are a trunk and its branch: their
        // overlap is shared track, already covered by the branch report.
        return meta.lineId !== part.lineId;
      });
      const seen = new Set();
      for (const [other, distance] of near) {
        const key = `${part.lineId}#${part.partIndex}\u0000${other.lineId}#${other.partIndex}`;
        seen.add(key);
        openHere.add(key);
        let run = runs.get(key);
        if (!run) {
          runs.set(
            key,
            (run = {
              a: part,
              b: other,
              lengthMeters: 0,
              gaps: [],
              start: sample.point,
              end: sample.point,
            }),
          );
        }
        run.lengthMeters += CORRIDOR_STEP_METERS;
        run.gaps.push(distance);
        run.end = sample.point;
      }
      for (const key of [...openHere]) {
        if (!seen.has(key)) {
          closeRun(key);
          openHere.delete(key);
        }
      }
    }
    for (const key of openHere) closeRun(key);
    runs.clear();
  }

  // A↔B and B↔A are the same corridor; keep the longer measurement.
  const merged = new Map();
  for (const run of finished) {
    const ids = [
      `${run.a.lineId}#${run.a.partIndex}`,
      `${run.b.lineId}#${run.b.partIndex}`,
    ].sort();
    // The two directions are walked from opposite strokes, so their
    // endpoints swap but their midpoints agree to within a sample step.
    // Bucket on that (~2 km) so two genuinely separate meetings of one
    // pair still report apart.
    const midLon = Math.round(((run.start[0] + run.end[0]) / 2) * 50);
    const midLat = Math.round(((run.start[1] + run.end[1]) / 2) * 50);
    const key = `${ids[0]}\u0000${ids[1]}\u0000${midLon},${midLat}`;
    const previous = merged.get(key);
    if (!previous || run.lengthMeters > previous.lengthMeters) merged.set(key, run);
  }

  const corridors = [...merged.values()].map((run) => {
    const gaps = run.gaps.slice().sort((x, y) => x - y);
    const median = gaps[Math.floor(gaps.length / 2)];
    const mean = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
    const variance = gaps.reduce((sum, value) => sum + (value - mean) ** 2, 0) / gaps.length;
    // The zoom at which the corridor's real separation first exceeds one rail
    // stroke plus the contract gap — i.e. where the two railways stop reading
    // as one line. Below it the map cannot show them apart without moving
    // them off their surveyed alignment.
    //
    // Both sides of that comparison move with zoom: the real separation
    // doubles every level, while the width it must clear rides the renderer's
    // scale ramp — so the crossing is solved per ramp segment rather than read
    // off a single logarithm. `plain` is where they would meet if the railway
    // were drawn at full weight everywhere; the ramp then pulls the crossing
    // in, because a thinner stroke needs less room.
    const latitude = (run.start[1] + run.end[1]) / 2;
    const neededPx = RENDER_STYLE.railWidthPx + RENDER_STYLE.parallelGapPx;
    const plain =
      median > 0
        ? Math.log2(
            (neededPx * MERCATOR_METERS_PER_PIXEL_Z0 * Math.cos((latitude * Math.PI) / 180)) /
              median,
          )
        : Infinity;
    // Ramp scale = base^(z − anchor) = 2^(k·(z − anchor)), so on the sloped
    // segment separation(z) = needed(z) solves to z = (plain − k·anchor)/(1 − k),
    // which for the contract's k = 1/2 is 2·plain − anchor. Under the floor the
    // stroke is a constant fraction, which just shifts the crossing.
    const k = Math.log2(RENDER_STYLE.weightZoomBase);
    const anchor = RENDER_STYLE.fullWeightZoom;
    const floorZoom = anchor + Math.log2(RENDER_STYLE.minWeightScale) / k;
    const sloped = (plain - k * anchor) / (1 - k);
    const separatesAtZoom =
      !isFinite(plain) || plain >= anchor
        ? plain
        : sloped >= floorZoom
          ? sloped
          : plain + Math.log2(RENDER_STYLE.minWeightScale);
    return {
      separatesAtZoom,
      lines: [
        {
          lineId: run.a.lineId,
          name: run.a.line.name,
          operator: run.a.line.operator,
          partIndex: run.a.partIndex,
          railwayId: run.a.line.railwayId,
        },
        {
          lineId: run.b.lineId,
          name: run.b.line.name,
          operator: run.b.line.operator,
          partIndex: run.b.partIndex,
          railwayId: run.b.line.railwayId,
        },
      ],
      // How many RAILWAYS this corridor holds. Two services of one railway are
      // one railway, and a corridor that says otherwise has counted timetables.
      renderMode: corridorRenderMode(
        {
          lineId: run.a.lineId,
          groupKey: `${run.a.line.operator}\u0000${run.a.line.name}`,
          railwayId: run.a.line.railwayId,
        },
        {
          lineId: run.b.lineId,
          groupKey: `${run.b.line.operator}\u0000${run.b.line.name}`,
          railwayId: run.b.line.railwayId,
        },
      ),
      lengthMeters: run.lengthMeters,
      minGap: gaps[0],
      medianGap: median,
      maxGap: gaps[gaps.length - 1],
      gapStdDev: Math.sqrt(variance),
      topology: median <= CORRIDOR_SHARED_METERS ? "SHARED" : "INDEPENDENT",
      start: run.start,
      end: run.end,
    };
  });
  corridors.sort((a, b) => b.lengthMeters - a.lengthMeters);
  return corridors;
}

// ── the audit ────────────────────────────────────────────────────────────────

export {
  RENDER_STYLE,
  RENDERER_REAL_TRACK_METERS,
  RENDERER_RETRACE_RUN_METERS,
  APPROACH_FOLD_METERS,
};

// ── route ↔ railway lane alignment ───────────────────────────────────────────
//
// A lane moves the RAILWAY sideways on screen. Every ridden route drawn over
// that railway has to move with it: a corridor where the rail steps aside and
// the journey stays on the centre-line draws the ride beside its own track,
// which is the whole thing the lanes exist to prevent.
//
// Checked by construction rather than by trusting the code that assigns them:
// each route vertex is pushed into ITS lane and each railway stroke into the
// lane the map draws it in, and the two must then coincide. A ride that took
// the wrong sign lands a full two lanes away, on the neighbouring railway.
const SAMPLE_DIRECTORIES = {
  jp: ["data/sample-data", "data/new-year-grand-loop-data", "data/tokyo-limited-express-loop-data"],
  tw: ["data/sample-data-tw"],
  hk: ["data/sample-data-hk"],
  mo: ["data/sample-data-mo"],
  kr: ["data/sample-data-kr"],
};
// Metres, not pixels: only the SIDE is under test, and any positive scale
// separates "on its railway" from "one corridor over".
const LANE_PROBE_METERS = 10;
const LANE_PROBE_TOLERANCE_METERS = 3;

/** Move a polyline into its lane, the way MapLibre's line-offset does. */
function offsetIntoLane(coordinates, laneAt) {
  return coordinates.map((point, index) => {
    const before = coordinates[Math.max(0, index - 1)];
    const after = coordinates[Math.min(coordinates.length - 1, index + 1)];
    const cos = Math.cos((point[1] * Math.PI) / 180) || 1e-6;
    const dx = (after[0] - before[0]) * cos;
    const dy = after[1] - before[1];
    const length = Math.hypot(dx, dy) || 1e-12;
    const lane = typeof laneAt === "function" ? laneAt(index) : laneAt;
    const shift = (lane * LANE_PROBE_METERS) / 111320;
    return [point[0] + ((dy / length) * shift) / cos, point[1] - (dx / length) * shift];
  });
}

function auditRouteLaneAlignment(country, network) {
  const directories = (SAMPLE_DIRECTORIES[country] || [])
    .map((name) => path.join(APP_DIR, name))
    .filter((dir) => fs.existsSync(dir));
  if (!directories.length) return null;

  const railByLine = new Map();
  for (const feature of network.segments.features) {
    const lineId = feature.properties.lineId;
    const strokes =
      feature.geometry.type === "LineString"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    if (!railByLine.has(lineId)) railByLine.set(lineId, []);
    for (const coordinates of strokes)
      if (coordinates.length >= 2)
        railByLine
          .get(lineId)
          .push(offsetIntoLane(coordinates, feature.properties.lane || 0));
  }
  const distanceToRail = (lineId, point) => {
    let best = Infinity;
    for (const stroke of railByLine.get(lineId) || [])
      for (const vertex of stroke) {
        const gap = distanceMeters(point, vertex);
        if (gap < best) best = gap;
      }
    return best;
  };

  const summary = { rides: 0, lanedRides: 0, vertices: 0, worst: 0, offRail: [] };
  for (const directory of directories)
    for (const name of fs.readdirSync(directory).filter((f) => /^part-.*\.json$/.test(f))) {
      const part = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      for (const feature of part.route?.features || []) {
        const canonical = RailNetwork.canonicalizeRouteFeature(network, feature);
        if (!canonical) continue;
        summary.rides += 1;
        const lanes = canonical.properties.display_lanes;
        if (!lanes || canonical.properties.display_line_ids.length !== 1) continue;
        summary.lanedRides += 1;
        const lineId = canonical.properties.display_line_ids[0];
        const geometries =
          canonical.geometry.type === "LineString"
            ? [canonical.geometry.coordinates]
            : canonical.geometry.coordinates;
        geometries.forEach((coordinates, index) => {
          const vertexLanes = lanes[index];
          if (!vertexLanes || coordinates.length < 6) return;
          const drawn = offsetIntoLane(coordinates, (at) => vertexLanes[at]);
          // Interior vertices only: the two ends are pinned to their platforms
          // and may bridge the last metres to the track.
          for (let at = 2; at < coordinates.length - 2; at += 1) {
            if (!vertexLanes[at]) continue;
            summary.vertices += 1;
            const gap = distanceToRail(lineId, drawn[at]);
            if (gap > summary.worst) summary.worst = gap;
            if (gap > LANE_PROBE_TOLERANCE_METERS && summary.offRail.length < 20)
              summary.offRail.push({
                train: part.train?.id || name,
                lineId,
                from: feature.properties?.from,
                to: feature.properties?.to,
                lane: vertexLanes[at],
                metersOff: gap,
              });
          }
        });
      }
    }
  return summary;
}

// ── services counted as railways ─────────────────────────────────────────────
//
// A corridor holds as many drawn lines as it holds RAILWAYS. Route numbers,
// service patterns, stopping patterns and 交路 are facts about what runs on a
// railway and can never add one: 香港輕鐵 publishes eleven route numbers over
// one track network, and drawing eleven lines there would invent a network the
// New Territories does not have.
//
// So this asks the rendered output, not the rule that produced it: where two
// drawn lines of ONE railway share a corridor, neither may have been pushed
// into a lane to make room for the other.
function laneDrawnAt(network, lineId, point) {
  let best = null;
  for (const feature of network.segments.features) {
    if (feature.properties.lineId !== lineId) continue;
    const strokes =
      feature.geometry.type === "LineString"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    for (const coordinates of strokes)
      for (const vertex of coordinates) {
        const gap = distanceMeters(point, vertex);
        if (!best || gap < best.gap)
          best = { gap, lane: feature.properties.lane || 0 };
      }
  }
  return best;
}

export function checkServiceLanes(network, corridors, problems) {
  for (const corridor of corridors) {
    if (corridor.renderMode === CorridorRenderMode.INDEPENDENT_PARALLEL) continue;
    if (corridor.renderMode === CorridorRenderMode.SINGLE) continue;
    const midpoint = [
      (corridor.start[0] + corridor.end[0]) / 2,
      (corridor.start[1] + corridor.end[1]) / 2,
    ];
    const drawn = corridor.lines.map((line) => ({
      line,
      at: laneDrawnAt(network, line.lineId, midpoint),
    }));
    const laned = drawn.filter((row) => row.at && row.at.lane !== 0);
    if (laned.length < 2) continue;
    problems.push({
      code: "service_misclassified_as_independent_parallel",
      severity: "ERROR",
      message:
        `${corridor.lines[0].operator}／${corridor.lines[0].name} and ` +
        `${corridor.lines[1].operator}／${corridor.lines[1].name} are one railway ` +
        `(${corridor.lines[0].railwayId}) but are drawn ${laned.length} lanes apart over ` +
        `${(corridor.lengthMeters / 1000).toFixed(2)} km — a service was counted as a railway`,
      railwayId: corridor.lines[0].railwayId,
      services: corridor.lines.map((line) => line.name),
      renderedLaneCount: laned.length,
      expectedLaneCount: 1,
    });
  }
}

export function auditCountry(country, options = {}) {
  const network = loadNetwork(country);
  if (!network) return null;

  // Attach the station anchors each line owns, so the checks never have to
  // reach back into the package.
  for (const line of network.lineById.values()) {
    line.stationPoints = (line.stationOrder || [])
      .map((id) => network.stationById.get(id))
      .filter(Boolean)
      .map((station) => ({ name: station.name, point: [station.lon, station.lat] }));
  }

  const parts = displayParts(network);
  // Japan has an independent survey to check the drawn geometry against; the
  // other packages ARE the official geometry, so there is nothing to compare.
  const sectionsForReference = loadReferenceSections(country);
  let referenceIndex = null;
  if (sectionsForReference) {
    referenceIndex = createEdgeIndex(0.005);
    for (const feature of sectionsForReference)
      referenceIndex.add(feature.coordinates, feature);
  }
  const lineFilter = options.lines
    ? new Set(options.lines)
    : null;

  const lineReports = [];
  for (const line of network.lineById.values()) {
    if (lineFilter && !lineFilter.has(line.name) && !lineFilter.has(line.lineId)) continue;
    const problems = [];
    checkPartsAndStations(line, problems, referenceIndex);
    checkIntervalDistances(line, problems);
    const reversals = checkHiddenReversals(line, problems);
    const branches = checkBranches(line, problems);
    lineReports.push({
      lineId: line.lineId,
      name: line.name,
      operator: line.operator,
      railwayId: line.railwayId,
      km: line.km,
      drawnKm: (line.parts || []).reduce((sum, c) => sum + pathLengthMeters(c), 0) / 1000,
      partCount: (line.parts || []).length,
      stationCount: (line.stationOrder || []).length,
      branches,
      reversals,
      problems,
    });
  }

  const report = {
    country,
    packageVersion: network.packageVersion,
    lineCount: network.lineById.size,
    partCount: parts.length,
    lines: lineReports,
    routeLanes: auditRouteLaneAlignment(country, network),
  };

  if (options.n02 !== false) {
    const sections = sectionsForReference;
    if (sections) {
      const drawnIndex = createEdgeIndex(0.005);
      for (const part of parts) drawnIndex.add(part.coordinates, part);
      const groups = buildReferenceGroups(sections);

      const packageKeys = new Set(
        [...network.lineById.values()].map(
          (line) => `${canonicalOperator(line.operator)}\u0000${line.name}`,
        ),
      );
      const missingLines = [];
      for (const [key, group] of groups) {
        if (packageKeys.has(key)) continue;
        // Not in the package under this name — is the track drawn anyway
        // (a rename), or is it genuinely absent (a missing line)?
        let sampled = 0;
        let covered = 0;
        for (const feature of group.features)
          for (const sample of resample(feature.coordinates, COVERAGE_STEP_METERS)) {
            sampled += 1;
            const nearest = drawnIndex.nearest(sample.point);
            if (nearest && nearest.distance <= COVERAGE_MISS_METERS) covered += 1;
          }
        missingLines.push({
          operator: group.operator,
          name: group.name,
          km: group.km,
          coveredRatio: sampled ? covered / sampled : 0,
        });
      }
      missingLines.sort((a, b) => a.coveredRatio - b.coveredRatio || b.km - a.km);
      report.n02 = {
        groupCount: groups.size,
        totalKm: [...groups.values()].reduce((sum, group) => sum + group.km, 0),
        unmatchedByName: missingLines,
        ...measureCoverage(groups, drawnIndex),
      };
      for (const entry of missingLines) {
        if (entry.coveredRatio >= 0.9) continue;
        const owner = lineReports.find((line) => line.name === entry.name);
        (owner ? owner.problems : (report.orphanProblems ||= [])).push({
          code: "missing_line",
          severity: entry.coveredRatio >= 0.5 ? "WARNING" : "ERROR",
          detail: `N02 ${entry.operator}／${entry.name} (${entry.km.toFixed(1)} km) is ${(entry.coveredRatio * 100).toFixed(0)}% drawn`,
        });
      }
      // Attribute uncovered corridors to the line report that owns the name.
      for (const run of report.n02.uncoveredRuns) {
        if (run.meters - run.parallelMeters < COVERAGE_REPORT_METERS) continue;
        const owner = lineReports.find(
          (line) =>
            line.name === run.name &&
            canonicalOperator(line.operator) === run.operator,
        );
        (owner ? owner.problems : (report.orphanProblems ||= [])).push({
          code: "uncovered_corridor",
          severity: "WARNING",
          detail: `${(run.meters / 1000).toFixed(2)} km of official ${run.operator}／${run.name} track is not drawn (max ${run.maxDistance.toFixed(0)} m away)`,
          at: run.start,
        });
      }
    }
  }

  if (options.corridors !== false) {
    report.corridors = detectCorridors(parts);
    // A corridor that holds one railway may not hold two drawn lines. Reported
    // against the line itself, so it counts as that line's ERROR and fails
    // --strict rather than sitting in a footnote.
    const serviceProblems = [];
    checkServiceLanes(network, report.corridors, serviceProblems);
    for (const problem of serviceProblems) {
      const owner = lineReports.find(
        (line) => line.railwayId === problem.railwayId,
      );
      (owner ? owner.problems : (report.orphanProblems ||= [])).push(problem);
    }
  }
  return report;
}

// ── text rendering ───────────────────────────────────────────────────────────

function statusFor(problems, codes) {
  let worst = 0;
  for (const problem of problems)
    if (codes.includes(problem.code)) worst = Math.max(worst, severityRank(problem.severity));
  return worst === 2 ? "ERROR" : worst === 1 ? "WARNING" : "PASS";
}

const COMPLETENESS_CODES = ["missing_line", "uncovered_corridor"];
const TOPOLOGY_CODES = [
  "branch_stops_at_junction",
  "shared_track_not_overlapping",
  "wrong_branch_direction",
  "wrong_terminus",
  "station_not_on_line",
];
const GEOMETRY_CODES = [
  "disconnected_geometry",
  "duplicate_segment",
  "sharp_artificial_turn",
  "interval_overshoots_audit",
  "interval_doubles_back_at_station",
  "reversal_joint_redraws_track",
];

function renderLine(line) {
  const rows = [];
  rows.push(`Line: ${line.operator}／${line.name}  [${line.lineId}]`);
  rows.push(
    `  package ${line.km.toFixed(1)} km / drawn ${line.drawnKm.toFixed(1)} km · ${line.partCount} stroke(s) · ${line.stationCount} stations`,
  );
  rows.push(
    `  Completeness: ${statusFor(line.problems, COMPLETENESS_CODES)}   Topology: ${statusFor(line.problems, TOPOLOGY_CODES)}   Geometry: ${statusFor(line.problems, GEOMETRY_CODES)}`,
  );
  // Where the line turns round. The drawn map breaks its stroke here and the
  // shape stops existing, so this is the only place a reader can see that the
  // package has 藤沢 reversing and how much rail the two legs share doing it.
  for (const reversal of line.reversals || []) {
    rows.push(
      `  Reversal at ${reversal.station} (interval ${reversal.intervalIndex}→${reversal.intervalIndex + 1}): ` +
        `${reversal.deflectionDegrees.toFixed(0)}° · ${reversal.reusedMeters.toFixed(0)} m of the ` +
        `${(reversal.incomingMeters / 1000).toFixed(2)} km it arrived on redrawn · own track ` +
        `${(reversal.outgoingMeters / 1000).toFixed(2)} km`,
    );
  }
  for (const branch of line.branches) {
    rows.push(
      `  Branch stroke ${branch.partIndex}: joins at ${branch.connectionStation ?? "—"} ` +
        `(${branch.connectionStationMeters.toFixed(0)} m) · shared track ${(branch.sharedTrackMeters / 1000).toFixed(2)} km ` +
        `(max deviation ${branch.sharedTrackMaxDeviationMeters.toFixed(1)} m) · own track ${(branch.branchLengthMeters / 1000).toFixed(2)} km ` +
        `· turn ${branch.turnDegrees == null ? "—" : `${branch.turnDegrees.toFixed(0)}°`}`,
    );
  }
  if (!line.problems.length) rows.push("  Problems: none");
  else
    for (const problem of line.problems)
      rows.push(`  ${problem.severity} ${problem.code}: ${problem.detail}`);
  return rows.join("\n");
}

function renderReport(report, options) {
  const rows = [];
  rows.push(`══ Railway Validation Report — ${report.country} (package ${report.packageVersion}) ══`);
  rows.push(`${report.lineCount} lines · ${report.partCount} drawn strokes`);
  rows.push("");

  const failing = report.lines.filter((line) => line.problems.length);
  const shown = options.all ? report.lines : failing;
  for (const line of shown) {
    rows.push(renderLine(line));
    rows.push("");
  }
  if (report.orphanProblems?.length) {
    rows.push("Unattributed problems:");
    for (const problem of report.orphanProblems)
      rows.push(`  ${problem.severity} ${problem.code}: ${problem.detail}`);
    rows.push("");
  }

  if (report.n02) {
    rows.push("── official-geometry completeness ──");
    rows.push(
      `official ${report.n02.groupCount} (operator, line) groups · ${report.n02.totalKm.toFixed(0)} km`,
    );
    const missKm = [...report.n02.perGroup.values()].reduce((s, g) => s + g.missKm, 0);
    const parallelKm = [...report.n02.perGroup.values()].reduce((s, g) => s + g.parallelKm, 0);
    const isolatedKm = [...report.n02.perGroup.values()].reduce((s, g) => s + g.isolatedKm, 0);
    rows.push(
      `undrawn ${missKm.toFixed(1)} km (${((missKm / report.n02.totalKm) * 100).toFixed(2)}%) = ` +
        `${parallelKm.toFixed(1)} km parallel alignment + ${isolatedKm.toFixed(1)} km isolated corridor`,
    );
    const unmatched = report.n02.unmatchedByName.filter((entry) => entry.coveredRatio < 0.9);
    rows.push(
      `unmatched names ${report.n02.unmatchedByName.length} (${unmatched.length} not drawn under any other name)`,
    );
    for (const entry of unmatched)
      rows.push(
        `  ${entry.operator}／${entry.name} — ${entry.km.toFixed(2)} km, ${(entry.coveredRatio * 100).toFixed(0)}% drawn`,
      );
    rows.push("  longest undrawn corridors:");
    for (const run of report.n02.uncoveredRuns.slice(0, options.corridorLimit)) {
      const kind = run.parallelMeters / run.meters > 0.5 ? "parallel" : "ISOLATED";
      rows.push(
        `    ${(run.meters / 1000).toFixed(2)} km ${kind}  ${run.operator}／${run.name}  @ ${run.start[0].toFixed(4)},${run.start[1].toFixed(4)}`,
      );
    }
    rows.push("");
  }

  if (report.corridors) {
    const independent = report.corridors.filter((c) => c.topology === "INDEPENDENT");
    const shared = report.corridors.filter((c) => c.topology === "SHARED");
    rows.push("── Parallel Railway Validation ──");
    rows.push(
      `${report.corridors.length} corridors ≥ ${CORRIDOR_MIN_LENGTH_METERS} m · ${independent.length} independent · ${shared.length} drawn on top of each other`,
    );
    // How many RAILWAYS each corridor holds, beside how many drawn lines: the
    // pair that reveals a service counted as a railway.
    const byMode = new Map();
    for (const corridor of report.corridors)
      byMode.set(corridor.renderMode, (byMode.get(corridor.renderMode) || 0) + 1);
    rows.push(
      "  by railway identity: " +
        [...byMode.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([mode, count]) => `${mode} ${count}`)
          .join(" · "),
    );
    for (const corridor of report.corridors.slice(0, options.corridorLimit)) {
      rows.push(
        `  ${(corridor.lengthMeters / 1000).toFixed(2)} km ${corridor.topology} ${corridor.renderMode}  ` +
          `${corridor.lines[0].operator}／${corridor.lines[0].name} ↔ ${corridor.lines[1].operator}／${corridor.lines[1].name}  ` +
          `gap min ${corridor.minGap.toFixed(0)} / med ${corridor.medianGap.toFixed(0)} / max ${corridor.maxGap.toFixed(0)} m (σ ${corridor.gapStdDev.toFixed(0)}) ` +
          `· separates at z${corridor.separatesAtZoom.toFixed(1)}`,
      );
    }
    rows.push("");
  }

  if (report.routeLanes) {
    const lanes = report.routeLanes;
    rows.push("── Route Parallel Alignment ──");
    rows.push(
      `${lanes.rides} ridden hops · ${lanes.lanedRides} over a parallel corridor · ` +
        `${lanes.vertices} laned vertices checked`,
    );
    if (!lanes.vertices)
      rows.push("  no ridden hop reaches a parallel corridor in this country");
    else if (!lanes.offRail.length)
      rows.push(
        `  PASS every laned ride is drawn on the railway it rode ` +
          `(worst ${lanes.worst.toFixed(2)} m from it)`,
      );
    else {
      rows.push(
        `  ERROR ${lanes.offRail.length} ride vertices are drawn off their own railway`,
      );
      for (const off of lanes.offRail.slice(0, 10))
        rows.push(
          `    ${off.train} ${off.lineId} ${off.from}→${off.to} ` +
            `lane ${off.lane} is ${off.metersOff.toFixed(1)} m off`,
        );
    }
    rows.push("");
  }

  const counts = new Map();
  for (const line of report.lines)
    for (const problem of line.problems)
      counts.set(problem.code, (counts.get(problem.code) || 0) + 1);
  for (const problem of report.orphanProblems || [])
    counts.set(problem.code, (counts.get(problem.code) || 0) + 1);
  rows.push("── Railway Validation Summary ──");
  rows.push(`Lines checked: ${report.lines.length}`);
  const errorLines = report.lines.filter((line) =>
    line.problems.some((problem) => problem.severity === "ERROR"),
  ).length;
  const warnLines = failing.length - errorLines;
  rows.push(`PASS: ${report.lines.length - failing.length}  WARNING: ${warnLines}  ERROR: ${errorLines}`);
  const branchCount = report.lines.reduce((sum, line) => sum + line.branches.length, 0);
  const sharedTrackCount = report.lines.reduce(
    (sum, line) => sum + line.branches.filter((b) => b.sharedTrackMeters > 5).length,
    0,
  );
  rows.push(`Branch strokes: ${branchCount}  with shared track: ${sharedTrackCount}`);
  if (report.corridors)
    rows.push(`Parallel corridors: ${report.corridors.filter((c) => c.topology === "INDEPENDENT").length}`);
  for (const [code, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]))
    rows.push(`  ${code}: ${count}`);
  return rows.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { corridorLimit: 25, all: false, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--country") options.country = argv[++index];
    else if (arg === "--json") options.json = argv[++index];
    else if (arg === "--lines") options.lines = argv[++index].split(",").filter(Boolean);
    else if (arg === "--corridors") options.corridorLimit = Number(argv[++index]) || 25;
    else if (arg === "--all") options.all = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--no-n02") options.n02 = false;
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
    errors += report.lines.reduce(
      (sum, line) => sum + line.problems.filter((problem) => problem.severity === "ERROR").length,
      0,
    );
  }
  if (options.json) {
    const serializable = reports.map((report) => ({
      ...report,
      n02: report.n02
        ? { ...report.n02, perGroup: Object.fromEntries(report.n02.perGroup) }
        : undefined,
    }));
    fs.writeFileSync(options.json, JSON.stringify(serializable, null, 2));
    process.stdout.write(`wrote ${options.json}\n`);
  }
  if (options.strict && errors) process.exitCode = 1;
}

// Run only as a command; importing this module (tests) must not audit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
