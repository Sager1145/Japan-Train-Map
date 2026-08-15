/*
 * parallel-corridors.mjs — where two DIFFERENT railways run the same corridor.
 *
 * The map draws one stroke per railway. Where a trunk and its own branch share
 * track that is correct and required: the branch is drawn over the trunk's own
 * coordinates so the two are exactly coincident (rail-network.js
 * displayPartsForLine). But where two INDEPENDENT railways — two companies, or
 * one company's two separate lines — happen to run the same corridor, drawing
 * them coincident tells the reader there is one railway where there are two.
 *
 * So the question is never "is the geometry the same?" but "is it the same
 * railway?". This module answers the second one and hands the renderer a lane
 * per (line, part, measure range):
 *
 *   same line id                  → one railway, one stroke
 *   same (operator, name) group   → trunk and branch, exactly coincident
 *   anything else sharing a       → INDEPENDENT_PARALLEL: separate lanes,
 *   corridor                         offset in SCREEN space at draw time
 *
 * Lanes are assigned by sorted line id, so both members of a corridor derive
 * the same order from the same facts and neither can flip relative to the
 * other on a reload, a pan, or a zoom.
 */
"use strict";

import {
  createEdgeIndex,
  distanceMeters,
  pathLengthMeters,
  pointSegmentDistanceMeters,
  resample,
} from "./railway-topology.mjs";

// Two independent railways this close are sharing a corridor. Wider than the
// couple of metres that separates two surveyed alignments of one railway, and
// far narrower than the gap that reads as "two different places".
export const CORRIDOR_NEAR_METERS = 45;
// Walk step. Half the near radius, so a corridor cannot slip between samples.
export const CORRIDOR_SAMPLE_METERS = 25;
// Shorter than this and splitting the stroke costs more than it explains.
// Raised deliberately: below this a lane change costs the reader a sideways
// step of the whole line for less railway than the step is worth explaining.
export const CORRIDOR_MIN_METERS = 2500;
// Two railways that run together for tens of kilometres still drift more than
// CORRIDOR_NEAR_METERS apart here and there — around a station throat, across
// a river, past a depot. Treating each of those as the end of the corridor
// would step the line sideways and back again every few kilometres, which is
// exactly what a reader must not see. So a lane is carried straight through
// any gap shorter than this: the corridor keeps one left-to-right order from
// the station it starts at to the station it ends at.
export const CORRIDOR_BRIDGE_METERS = 6000;
// A lane boundary is pushed OUT to the enclosing station where one is near, so
// the point where a line moves between its own alignment and its lane is a
// platform rather than a spot on open track: the station circle covers the
// step, and the two railways read as converging at the station they share —
// which is what they physically do. Outward, never inward: pulling a boundary
// inward would strip the lane off the very metres the corridor needs it for.
//
// …but only so far. A 新幹線 runs 30–50 km between stations, and snapping a
// 2 km shared viaduct out to the platforms either side claimed forty more
// kilometres on which the two railways are nowhere near each other — a bundle
// drawn over track that is genuinely apart, which is the one thing a bundle
// must never say. Past this distance the ramp is left on open track, where its
// 220 m of quarter-lane steps are invisible anyway.
export const CORRIDOR_STATION_SNAP_METERS = 2000;

export const CorridorRenderMode = Object.freeze({
  SINGLE: "SINGLE",
  // One railway published as several services — route numbers, service
  // patterns, 運行系統, 交路. One railway to draw.
  SAME_RAILWAY: "SAME_RAILWAY",
  MAIN_BRANCH_SHARED: "MAIN_BRANCH_SHARED",
  INDEPENDENT_PARALLEL: "INDEPENDENT_PARALLEL",
});

/**
 * How two drawn strokes relate.
 *
 * Identity first, geometry never — and RAILWAY identity, never SERVICE
 * identity. A branch over its trunk and two independent railways over one
 * corridor can be the very same coordinates and still need opposite
 * treatment; and eleven light rail route numbers over one set of rails are
 * one railway however many timetables run on it.
 *
 * The ladder, widest question first:
 *
 *   same drawn line                      SINGLE
 *   same railway, different service      SAME_RAILWAY          one stroke
 *   same railway, trunk and its branch   MAIN_BRANCH_SHARED    one stroke
 *   different railways                   INDEPENDENT_PARALLEL  a lane each
 *
 * Only the last takes a lane. A different route number, service pattern,
 * stopping pattern or pair of endpoints never reaches it: those are all
 * facts about a SERVICE, and the number of railways drawn in a corridor is
 * the number of RAILWAYS in it.
 */
export function corridorRenderMode(a, b) {
  if (a.lineId === b.lineId) return CorridorRenderMode.SINGLE;
  // A package that states no railway identity is stating that each of its
  // lines is its own railway, which is what operator+name already means.
  const railwayA = a.railwayId ?? a.groupKey;
  const railwayB = b.railwayId ?? b.groupKey;
  if (railwayA === railwayB)
    return a.groupKey === b.groupKey
      ? CorridorRenderMode.MAIN_BRANCH_SHARED
      : CorridorRenderMode.SAME_RAILWAY;
  return CorridorRenderMode.INDEPENDENT_PARALLEL;
}

/**
 * How far along `coordinates` the nearest point to `point` lies, in metres.
 * Used to ask "do these two strokes run the same way round?".
 */
function projectMeasure(coordinates, cumulative, point) {
  let best = Infinity;
  let at = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const distance = pointSegmentDistanceMeters(point, coordinates[index - 1], coordinates[index]);
    if (distance >= best) continue;
    best = distance;
    at = cumulative[index - 1];
  }
  return at;
}

/** Cumulative along-part distance for each vertex. */
function measures(coordinates) {
  const out = [0];
  for (let index = 1; index < coordinates.length; index += 1)
    out.push(out[index - 1] + distanceMeters(coordinates[index - 1], coordinates[index]));
  return out;
}

/** Where each of the part's stations sits along it, in metres. */
function stationMeasures(coordinates, cumulative, stationPoints) {
  const found = [];
  for (const station of stationPoints) {
    let best = Infinity;
    let at = 0;
    for (let index = 0; index < coordinates.length; index += 1) {
      const distance = distanceMeters(coordinates[index], station);
      if (distance < best) {
        best = distance;
        at = cumulative[index];
      }
    }
    if (best <= 200) found.push(at);
  }
  found.sort((x, y) => x - y);
  return found;
}

/**
 * The last station at or before `measure`, if one is close enough to be worth
 * reaching for; otherwise `measure` itself. 0 when the stroke starts first.
 */
function stationAtOrBefore(measure, stations, reach) {
  let best = 0;
  for (const station of stations) if (station <= measure && station > best) best = station;
  return measure - best <= reach ? best : measure;
}

/** The first station at or after `measure`, under the same reach. */
function stationAtOrAfter(measure, stations, total, reach) {
  let best = total;
  for (const station of stations) if (station >= measure && station < best) best = station;
  return best - measure <= reach ? best : measure;
}

/**
 * +1 when this stroke runs the same way as its corridor's reference member
 * (the one with the lowest line id), -1 when it runs against it.
 *
 * MapLibre's line-offset is signed relative to the feature's own direction of
 * travel, and nothing says two railways sharing a corridor were digitised the
 * same way round. Without this every anti-parallel pair would offset to the
 * same side — exactly the collision the lanes exist to prevent.
 */
function corridorHeadingSign(part, run, cumulative) {
  const reference = run.members && run.members[0];
  if (!reference || reference === part.lineId) return 1;
  const partner = run.partners && run.partners.get(reference);
  if (!partner) return 1;
  const other = partner.meta;
  const otherCumulative = measures(other.coordinates);
  const at = (measure) => {
    let index = 0;
    while (index < cumulative.length - 1 && cumulative[index] < measure) index += 1;
    return part.coordinates[index];
  };
  const mine = [at(run.from), at(run.to)];
  const theirs = mine.map((point) => projectMeasure(other.coordinates, otherCumulative, point));
  return theirs[1] >= theirs[0] ? 1 : -1;
}

/**
 * Detect every stretch where independent railways share a corridor.
 *
 * `parts` is `{ lineId, groupKey, partIndex, coordinates, stationPoints }`.
 * Returns lane rows `[lineId, partIndex, fromMeters, toMeters, laneOffset]`
 * where `laneOffset` is a SIGNED MULTIPLE of the centre-to-centre lane
 * spacing: with two members the lanes are ±0.5, with three −1 / 0 / +1, so a
 * corridor always stays symmetric about the alignment it shares and the
 * station markers on it stay in the middle.
 */

// ---------------------------------------------------------------------------
// Global lane order
//
// The order used to be "sort this sample's members by line id". That is stable
// for a FIXED member set, but the member set is recomputed independently for
// every part from that part's own proximity hits, so one end of a corridor can
// see {A,B} while the other sees {A,B,C} and the two ends then derive their
// offsets from different sets — the pair comes out swapped, or on the same
// side, between them. Alphabetical order also has no relation to which railway
// is physically on the left, so a corridor could be drawn mirrored.
//
// So the order is decided ONCE for the whole corridor graph: every proximity
// hit votes on which side its partner lies (weighted by the track it covers),
// votes reduce to one side per pair, pairs group into connected components,
// and each component is totally ordered by relaxation — which degrades
// gracefully when the constraints contain a cycle instead of failing. Ties
// break on line id, so the result is deterministic.
// ---------------------------------------------------------------------------

function nearestPointOn(coordinates, point) {
  let best = null;
  let bestD = Infinity;
  const cosLat = Math.cos((point[1] * Math.PI) / 180);
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const [ax, ay] = coordinates[i];
    const [bx, by] = coordinates[i + 1];
    const dx = (bx - ax) * cosLat;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = 0;
    if (l2 > 0) {
      t = (((point[0] - ax) * cosLat) * dx + (point[1] - ay) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
    }
    const qx = ax + (bx - ax) * t;
    const qy = ay + (by - ay) * t;
    const d = ((qx - point[0]) * cosLat) ** 2 + (qy - point[1]) ** 2;
    if (d < bestD) { bestD = d; best = [qx, qy]; }
  }
  return best;
}

function bearingAt(coordinates, point) {
  let bestI = 0;
  let bestD = Infinity;
  const cosLat = Math.cos((point[1] * Math.PI) / 180);
  for (let i = 0; i < coordinates.length; i += 1) {
    const d = ((coordinates[i][0] - point[0]) * cosLat) ** 2
      + (coordinates[i][1] - point[1]) ** 2;
    if (d < bestD) { bestD = d; bestI = i; }
  }
  const a = coordinates[Math.max(0, bestI - 1)];
  const b = coordinates[Math.min(coordinates.length - 1, bestI + 1)];
  return Math.atan2((b[1] - a[1]) * 110540.0, (b[0] - a[0]) * 111320.0 * cosLat);
}

export function buildGlobalLaneOrder(parts, index, near, step) {
  const votes = new Map();
  const weight = new Map();
  const adjacency = new Map();
  const link = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  };

  for (const part of parts) {
    const samples = resample(part.coordinates, step);
    if (samples.length < 2) continue;
    for (const sample of samples) {
      const found = index.within(sample.point, near, (meta) =>
        corridorRenderMode(part, meta) === CorridorRenderMode.INDEPENDENT_PARALLEL,
      );
      if (!found.size) continue;
      const bearing = bearingAt(part.coordinates, sample.point);
      const vx = Math.cos(bearing);
      const vy = Math.sin(bearing);
      const cosLat = Math.cos((sample.point[1] * Math.PI) / 180);
      const seenHere = new Set();
      for (const [meta] of found) {
        if (meta.lineId === part.lineId || seenHere.has(meta.lineId)) continue;
        seenHere.add(meta.lineId);
        link(part.lineId, meta.lineId);
        const q = nearestPointOn(meta.coordinates, sample.point);
        if (!q) continue;
        const dx = (q[0] - sample.point[0]) * 111320.0 * cosLat;
        const dy = (q[1] - sample.point[1]) * 110540.0;
        const cross = vx * dy - vy * dx;
        if (!cross) continue;
        const side = cross > 0 ? 1 : -1;
        const a = part.lineId < meta.lineId ? part.lineId : meta.lineId;
        const b = part.lineId < meta.lineId ? meta.lineId : part.lineId;
        const signed = part.lineId < meta.lineId ? side : -side;
        const key = a + " " + b;
        votes.set(key, (votes.get(key) || 0) + signed * step);
        weight.set(key, (weight.get(key) || 0) + step);
      }
    }
  }

  const sides = new Map();
  for (const [key, v] of votes) sides.set(key, v >= 0 ? 1 : -1);

  const seen = new Set();
  const order = new Map();
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const comp = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const id = stack.pop();
      comp.push(id);
      for (const nb of adjacency.get(id) || []) {
        if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
    comp.sort();
    const pos = new Map(comp.map((id, i) => [id, i]));
    for (let iter = 0; iter < 64; iter += 1) {
      const delta = new Map();
      let moved = 0;
      for (const [key, side] of sides) {
        const [a, b] = key.split(" ");
        if (!pos.has(a) || !pos.has(b)) continue;
        const want = side > 0 ? -1 : 1;
        const cur = pos.get(b) - pos.get(a);
        if (Math.sign(cur) === Math.sign(want) && Math.abs(cur) >= 0.5) continue;
        const w = Math.min(1, (weight.get(key) || 0) / 5000);
        const push = (want * 0.5 - cur) * 0.5 * (0.25 + 0.75 * w);
        delta.set(b, (delta.get(b) || 0) + push);
        delta.set(a, (delta.get(a) || 0) - push);
        moved += Math.abs(push);
      }
      if (!delta.size || moved < 1e-4) break;
      for (const [id, dv] of delta) pos.set(id, pos.get(id) + dv);
    }
    comp
      .slice()
      .sort((x, y) => pos.get(x) - pos.get(y) || (x < y ? -1 : 1))
      .forEach((id, i) => order.set(id, i));
  }
  return order;
}

export function detectIndependentOverlappingCorridors(parts, options = {}) {
  const near = options.nearMeters ?? CORRIDOR_NEAR_METERS;
  const step = options.sampleMeters ?? CORRIDOR_SAMPLE_METERS;
  const minRun = options.minRunMeters ?? CORRIDOR_MIN_METERS;
  const bridge = options.bridgeMeters ?? CORRIDOR_BRIDGE_METERS;
  const reach = options.stationSnapMeters ?? CORRIDOR_STATION_SNAP_METERS;

  const index = createEdgeIndex(0.005);
  for (const part of parts) index.add(part.coordinates, part);

  // One order for the whole corridor graph, decided before any part is laned.
  const globalOrder = buildGlobalLaneOrder(parts, index, near, step);

  const rows = [];
  const corridors = [];
  for (const part of parts) {
    const samples = resample(part.coordinates, step);
    if (samples.length < 2) continue;

    // Per sample: which OTHER railways share this spot.
    const partnersAt = samples.map((sample) => {
      const found = index.within(sample.point, near, (meta) =>
        corridorRenderMode(part, meta) === CorridorRenderMode.INDEPENDENT_PARALLEL,
      );
      if (!found.size) return null;
      const partners = new Map();
      for (const [meta, distance] of found) {
        const previous = partners.get(meta.lineId);
        if (!previous || distance < previous.distance)
          partners.set(meta.lineId, { meta, distance });
      }
      return partners;
    });

    // Lane per sample, taken as the SUBSEQUENCE of the one global order
    // computed above. Because every part reads the same order, two railways
    // sit the same way round everywhere they meet, a third joining slots into
    // the existing order instead of shuffling the first two past each other,
    // and the side each one takes matches the ground.
    const laneAt = partnersAt.map((partners) => {
      if (!partners) return { lane: 0, members: null, partners: null };
      const members = [...new Set([part.lineId, ...partners.keys()])].sort(
        (a, b) => {
          const ra = globalOrder.has(a) ? globalOrder.get(a) : Number.MAX_SAFE_INTEGER;
          const rb = globalOrder.has(b) ? globalOrder.get(b) : Number.MAX_SAFE_INTEGER;
          if (ra !== rb) return ra - rb;
          return a < b ? -1 : a > b ? 1 : 0;
        },
      );
      return {
        lane: members.indexOf(part.lineId) - (members.length - 1) / 2,
        members,
        partners,
      };
    });

    // Runs of ONE lane value, then two clean-ups: a run too short to be worth
    // a sideways step is absorbed by its neighbour, and a lane is carried
    // straight through any gap shorter than the bridge, so a corridor keeps
    // one left-to-right order for its whole length instead of stepping in and
    // out every few kilometres.
    const runs = [];
    for (let i = 0; i < laneAt.length; i += 1) {
      const previous = runs[runs.length - 1];
      if (previous && previous.lane === laneAt[i].lane) {
        previous.to = samples[i].measure;
        continue;
      }
      runs.push({
        lane: laneAt[i].lane,
        members: laneAt[i].members,
        partners: laneAt[i].partners,
        from: previous ? previous.to : 0,
        to: samples[i].measure,
      });
    }
    if (runs.length) runs[runs.length - 1].to = pathLengthMeters(part.coordinates);

    const merged = [];
    for (const run of runs) {
      const previous = merged[merged.length - 1];
      if (previous && (run.to - run.from < minRun || previous.lane === run.lane)) {
        previous.to = run.to;
        continue;
      }
      merged.push({ ...run });
    }
    while (merged.length > 1 && merged[0].to - merged[0].from < minRun) {
      merged[1].from = merged[0].from;
      merged.shift();
    }
    for (let i = 1; i < merged.length - 1; ) {
      const gap = merged[i];
      const before = merged[i - 1];
      const after = merged[i + 1];
      if (
        gap.lane === 0 &&
        before.lane === after.lane &&
        before.lane !== 0 &&
        gap.to - gap.from < bridge
      ) {
        before.to = after.to;
        merged.splice(i, 2);
        continue;
      }
      i += 1;
    }

    const cumulative = measures(part.coordinates);
    const stations = stationMeasures(part.coordinates, cumulative, part.stationPoints || []);
    const total = cumulative[cumulative.length - 1];
    let previousEnd = 0;
    for (const run of merged) {
      if (!run.lane) continue;
      // Out to the enclosing stations, then clamped so two lane stretches on
      // one stroke can never claim the same metres.
      const from = Math.max(previousEnd, stationAtOrBefore(run.from, stations, reach));
      const to = stationAtOrAfter(run.to, stations, total, reach);
      previousEnd = to;
      if (to - from < minRun) continue;
      // The lane index above is stated in the CORRIDOR's frame — sorted line
      // id — but the renderer offsets a stroke relative to ITS OWN direction
      // of travel. Two members digitised in opposite directions would then be
      // pushed to the same side and land on top of each other. So measure
      // which way this stroke runs against the corridor's reference member and
      // flip the sign when they disagree.
      const lane = run.lane * corridorHeadingSign(part, run, cumulative);
      rows.push([part.lineId, part.partIndex, Number(from.toFixed(1)), Number(to.toFixed(1)), lane]);
      corridors.push({
        lineId: part.lineId,
        partIndex: part.partIndex,
        fromMeters: from,
        toMeters: to,
        lane,
        members: run.members,
        mode: CorridorRenderMode.INDEPENDENT_PARALLEL,
      });
    }
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1] || a[2] - b[2]));
  return { rows, corridors };
}
