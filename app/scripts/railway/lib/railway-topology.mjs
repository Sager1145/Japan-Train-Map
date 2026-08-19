/*
 * railway-topology.mjs — the geometry/topology primitives the railway audit
 * and its regression tests share.
 *
 * Everything here works on the DRAWN display geometry (rail-network.js's
 * display parts) and on the official N02 sections, in metres. Nothing in this
 * module changes what is rendered; it only measures it.
 *
 * The vocabulary follows the branch model the renderer already implements
 * (see rail-network.js displayPartsForLine):
 *
 *   physical junction          where the branch's own track leaves the trunk
 *   logical connection station where the branch is considered to JOIN the line
 *   shared track               junction → station, drawn by both, same coords
 *
 * A branch part therefore reads  station → (shared track) → junction → branch,
 * and "the branch stops at the junction" is a defect, not a shape.
 */
"use strict";

export const EARTH_DEG_METERS = 111320;

export function localMetric(point, latitude) {
  const radians = (latitude * Math.PI) / 180;
  return [point[0] * EARTH_DEG_METERS * Math.cos(radians), point[1] * EARTH_DEG_METERS];
}

export function distanceMeters(left, right) {
  const latitude = (left[1] + right[1]) / 2;
  const a = localMetric(left, latitude);
  const b = localMetric(right, latitude);
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function pointSegmentDistanceMeters(point, start, end) {
  const latitude = point[1];
  const p = localMetric(point, latitude);
  const a = localMetric(start, latitude);
  const b = localMetric(end, latitude);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared))
    : 0;
  return Math.hypot(p[0] - (a[0] + ratio * dx), p[1] - (a[1] + ratio * dy));
}

export function pathLengthMeters(coordinates) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1)
    total += distanceMeters(coordinates[index - 1], coordinates[index]);
  return total;
}

/** Deflection from straight-on at `corner`, in degrees (0 = straight, 180 = about-face). */
export function turnDegrees(previous, corner, following) {
  const latitude = corner[1];
  const a = localMetric(previous, latitude);
  const b = localMetric(corner, latitude);
  const c = localMetric(following, latitude);
  const incoming = [b[0] - a[0], b[1] - a[1]];
  const outgoing = [c[0] - b[0], c[1] - b[1]];
  const denominator = Math.hypot(...incoming) * Math.hypot(...outgoing);
  if (!denominator) return 0;
  const cosine = Math.max(
    -1,
    Math.min(1, (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) / denominator),
  );
  return (Math.acos(cosine) * 180) / Math.PI;
}

/** Compass-free heading of a→b in degrees, for junction direction reports. */
export function headingDegrees(a, b) {
  const latitude = (a[1] + b[1]) / 2;
  const p = localMetric(a, latitude);
  const q = localMetric(b, latitude);
  return (Math.atan2(q[0] - p[0], q[1] - p[1]) * 180) / Math.PI;
}

/**
 * Heading of the polyline `coordinates` at `index`, averaged over `spanMeters`
 * so a single noisy vertex cannot swing the answer. `direction` +1 looks
 * forward from index, -1 looks backward.
 */
export function localHeading(coordinates, index, direction, spanMeters = 250) {
  const origin = coordinates[index];
  let travelled = 0;
  let cursor = index;
  while (travelled < spanMeters) {
    const next = cursor + direction;
    if (next < 0 || next >= coordinates.length) break;
    travelled += distanceMeters(coordinates[cursor], coordinates[next]);
    cursor = next;
  }
  if (cursor === index) return null;
  return direction > 0
    ? headingDegrees(origin, coordinates[cursor])
    : headingDegrees(coordinates[cursor], origin);
}

/**
 * How much continuous track leaves `coordinates[index]` in `direction`.
 *
 * "Is this corner real, or two survey vertices a metre apart?" used to be
 * asked of the single adjoining EDGE, which a reversal fails by construction:
 * where a stroke turns round, the vertex the cusp sits on need not be flanked
 * by two long edges — one side is whatever the digitiser happened to place
 * next. Measuring the RUN instead asks the honest question, because the track
 * either side of a genuine cusp carries on for hundreds of metres while
 * digitisation jitter measures the metre it actually spans.
 *
 * The walk stops at the next corner: a vertex that bends the polyline by more
 * than `bendDegrees` is itself a corner, not this one's track. Curvature never
 * reaches that — a 100 m radius tram curve digitised every 25 m bends ~14° per
 * vertex — so the run follows the line around a curve and halts at a cusp.
 *
 * Returns path length, capped at `maxMeters` so a cusp on a 280 km trunk does
 * not walk the trunk.
 */
export function straightRunMeters(coordinates, index, direction, options = {}) {
  const bendDegrees = options.bendDegrees ?? 45;
  const maxMeters = options.maxMeters ?? 600;
  let cursor = index;
  let meters = 0;
  while (meters < maxMeters) {
    const next = cursor + direction;
    if (next < 0 || next >= coordinates.length) break;
    if (
      cursor !== index &&
      turnDegrees(coordinates[cursor - direction], coordinates[cursor], coordinates[next]) >
        bendDegrees
    )
      break;
    meters += distanceMeters(coordinates[cursor], coordinates[next]);
    cursor = next;
  }
  return Math.min(meters, maxMeters);
}

/**
 * How much track the polyline lays AFTER it has already arrived.
 *
 * `coordinates` must end at `station`. Walking it, every vertex that is
 * already inside `touchMeters` of the platform is asked a simple question:
 * how much track is left, and how far is left to go? On an honest approach
 * those two agree — the line comes in and stops. Where the line runs past its
 * own platform and turns back, the track left over is the excursion plus the
 * way home while the distance left to go is nearly nothing, and the surplus
 * between them is the whole fold, measured without knowing where the corner is
 * or whether there is a corner at all.
 *
 * This is the reversal a drawn map cannot show: the renderer breaks its stroke
 * at the platform, or grooms the thorn away, and the shape stops existing
 * before any corner test can see it. The metres survive in the package.
 *
 * Returns the worst vertex as `{ excessMeters, chordMeters, trackMeters }`,
 * all zero when the approach never doubles back.
 */
export function stationApproachFold(coordinates, station, options = {}) {
  const touchMeters = options.touchMeters ?? 150;
  let total = 0;
  const arc = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    total += distanceMeters(coordinates[index - 1], coordinates[index]);
    arc.push(total);
  }
  let worst = { excessMeters: 0, chordMeters: 0, trackMeters: 0 };
  for (let index = 0; index < coordinates.length; index += 1) {
    const chordMeters = distanceMeters(coordinates[index], station);
    if (chordMeters > touchMeters) continue;
    const trackMeters = total - arc[index];
    const excessMeters = trackMeters - chordMeters;
    if (excessMeters > worst.excessMeters)
      worst = { excessMeters, chordMeters, trackMeters };
  }
  return worst;
}

/**
 * How far `walk` stays on `reference`'s own track, starting from walk[0].
 *
 * Both polylines come out of one track graph, so rail they share is rail they
 * were cut from together — the same survey vertices, not two alignments that
 * happen to run near each other. `radiusMeters` is therefore a coincidence
 * test, not a proximity one: a couple of metres, so that two tracks of a
 * four-track approach measure as what they are (different track) while an
 * interval drawn back down the one it arrived on measures as the same rail.
 *
 * The walk stops the moment it leaves, because what is being asked is how much
 * rail the two lay on top of each other continuously, not how often they meet.
 */
export function coincidentRunMeters(reference, walk, radiusMeters = 2) {
  let travelled = 0;
  let shared = 0;
  for (let index = 1; index < walk.length; index += 1) {
    travelled += distanceMeters(walk[index - 1], walk[index]);
    let nearest = Infinity;
    for (let other = 1; other < reference.length; other += 1) {
      const gap = pointSegmentDistanceMeters(
        walk[index],
        reference[other - 1],
        reference[other],
      );
      if (gap < nearest) nearest = gap;
      if (nearest <= radiusMeters) break;
    }
    if (nearest > radiusMeters) break;
    shared = travelled;
  }
  return shared;
}

export function angleBetweenHeadings(a, b) {
  if (a == null || b == null) return null;
  let delta = Math.abs(a - b) % 360;
  if (delta > 180) delta = 360 - delta;
  return delta;
}

// ───────────────────────────── spatial index ─────────────────────────────
// A lon/lat bucket grid over polyline EDGES. Cell size is given in degrees;
// queries look at the 3×3 neighbourhood, so the cell must be comfortably
// larger than the largest radius any caller asks about.

export function createEdgeIndex(cellDegrees = 0.005) {
  const cells = new Map();
  const key = (x, y) => x * 100000 + y;

  function addEdge(a, b, meta) {
    const x0 = Math.floor(Math.min(a[0], b[0]) / cellDegrees);
    const x1 = Math.floor(Math.max(a[0], b[0]) / cellDegrees);
    const y0 = Math.floor(Math.min(a[1], b[1]) / cellDegrees);
    const y1 = Math.floor(Math.max(a[1], b[1]) / cellDegrees);
    for (let x = x0; x <= x1; x += 1)
      for (let y = y0; y <= y1; y += 1) {
        const k = key(x, y);
        let rows = cells.get(k);
        if (!rows) cells.set(k, (rows = []));
        rows.push([a, b, meta]);
      }
  }

  return {
    cellDegrees,
    add(coordinates, meta) {
      for (let index = 1; index < coordinates.length; index += 1)
        addEdge(coordinates[index - 1], coordinates[index], meta);
    },
    /**
     * Nearest indexed edge to `point`, or null when the 3×3 neighbourhood is
     * empty. `accept(meta)` filters candidates (e.g. "not my own line").
     */
    nearest(point, accept) {
      const gx = Math.floor(point[0] / cellDegrees);
      const gy = Math.floor(point[1] / cellDegrees);
      let best = null;
      for (let dx = -1; dx <= 1; dx += 1)
        for (let dy = -1; dy <= 1; dy += 1) {
          const rows = cells.get(key(gx + dx, gy + dy));
          if (!rows) continue;
          for (const row of rows) {
            if (accept && !accept(row[2])) continue;
            const distance = pointSegmentDistanceMeters(point, row[0], row[1]);
            if (!best || distance < best.distance) best = { distance, meta: row[2] };
          }
        }
      return best;
    },
    /** Every distinct meta whose edge comes within `radiusMeters` of `point`. */
    within(point, radiusMeters, accept) {
      const gx = Math.floor(point[0] / cellDegrees);
      const gy = Math.floor(point[1] / cellDegrees);
      const found = new Map();
      for (let dx = -1; dx <= 1; dx += 1)
        for (let dy = -1; dy <= 1; dy += 1) {
          const rows = cells.get(key(gx + dx, gy + dy));
          if (!rows) continue;
          for (const row of rows) {
            if (accept && !accept(row[2])) continue;
            const distance = pointSegmentDistanceMeters(point, row[0], row[1]);
            if (distance > radiusMeters) continue;
            const previous = found.get(row[2]);
            if (!previous || distance < previous) found.set(row[2], distance);
          }
        }
      return found;
    },
    size() {
      return cells.size;
    },
  };
}

/** Walk `coordinates` emitting a point every `stepMeters` (endpoints included). */
export function resample(coordinates, stepMeters) {
  const output = [];
  if (!coordinates.length) return output;
  output.push({ point: coordinates[0], measure: 0, index: 0 });
  let carry = 0;
  let measure = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const a = coordinates[index - 1];
    const b = coordinates[index];
    const length = distanceMeters(a, b);
    if (!(length > 0)) continue;
    let offset = stepMeters - carry;
    while (offset <= length) {
      const ratio = offset / length;
      output.push({
        point: [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio],
        measure: measure + offset,
        index: index - 1,
      });
      offset += stepMeters;
    }
    carry = (carry + length) % stepMeters;
    measure += length;
  }
  const last = coordinates[coordinates.length - 1];
  if (output[output.length - 1].measure < measure - 1)
    output.push({ point: last, measure, index: coordinates.length - 2 });
  return output;
}

// ───────────────────────── display parts of a network ─────────────────────────

/** Flatten a built RailNetwork into `{ lineId, line, partIndex, coordinates }` rows. */
export function displayParts(network) {
  const rows = [];
  for (const line of network.lineById.values()) {
    const parts = line.parts || [line.geometry?.coordinates || []];
    parts.forEach((coordinates, partIndex) => {
      if (coordinates.length >= 2) rows.push({ lineId: line.lineId, line, partIndex, coordinates });
    });
  }
  return rows;
}

/**
 * Where a branch part stops sharing track with the rest of its own line.
 *
 * The renderer builds a branch as  station → trunk coordinates → junction →
 * branch-only track, and the lead-in is a literal copy of the trunk's
 * vertices. So walking the part from its start and asking "is some OTHER part
 * of this same line still within `matchMeters`?" recovers the junction
 * exactly, and the largest distance seen over that run is the proof that the
 * shared track really is coincident (§12) rather than merely near.
 */
export function sharedTrackPrefix(part, siblingIndex, options = {}) {
  // Two radii, because "shared" and "alongside" are different claims.
  //   coincident — the branch is drawing the trunk's OWN vertices (§12). The
  //                renderer copies them, so this is vertex identity, not
  //                nearness: half a metre, not "close enough".
  //   near       — the two strokes merely run together: a four-track approach,
  //                a trunk continuation beside its own other stroke, or two
  //                N02 alignments of the same line surveyed a few metres
  //                apart. Legitimate geometry, and NOT shared track — calling
  //                a 3 m parallel "shared" would demand the renderer weld two
  //                real tracks into one.
  const coincidentMeters = options.coincidentMeters ?? 0.5;
  const nearMeters = options.nearMeters ?? 60;
  const { coordinates } = part;
  let junctionIndex = 0;
  let maxDeviation = 0;
  let nearIndex = 0;
  for (let index = 0; index < coordinates.length; index += 1) {
    const nearest = siblingIndex.nearest(coordinates[index]);
    if (!nearest || nearest.distance > nearMeters) break;
    nearIndex = index;
    if (nearest.distance > coincidentMeters) continue;
    if (index !== junctionIndex + 1 && index !== 0) continue;
    junctionIndex = index;
    if (nearest.distance > maxDeviation) maxDeviation = nearest.distance;
  }
  return {
    junctionIndex,
    lengthMeters: pathLengthMeters(coordinates.slice(0, junctionIndex + 1)),
    maxDeviationMeters: maxDeviation,
    nearIndex,
    nearLengthMeters: pathLengthMeters(coordinates.slice(0, nearIndex + 1)),
  };
}
