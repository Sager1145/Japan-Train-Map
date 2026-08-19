/*
 * duplicate-strokes.mjs — find the same railway drawn more than once.
 *
 * The multi-line station audit checks that sibling strokes MEET correctly; it
 * never asked whether two strokes are drawing the SAME track. At 日暮里 three
 * 東北線 strokes share one railwayIdentity and 51 % / 47 % / 43 % of their
 * length sits within 3 m of a sibling, in runs up to 2.8 km; at 赤羽 東北線-6
 * is inside 3 m of 東北線 for 1.0 km. Rendered, that is one corridor painted
 * two or three times, and none of the copies is on the real track.
 *
 * Tiers (RAILWAY_MULTILINE_STATION_AUDIT_PROMPT.md 3.1). Distances are
 * point-to-SEGMENT: measured vertex-to-vertex they inflate by roughly half
 * (倶利伽羅 reads 180 m by vertex and 40 m by segment).
 *
 *   duplicate  <=3 m sustained >=200 m   one track drawn twice
 *   suspect    3-12 m sustained >=200 m  duplicate, or a real pair drawn coarsely
 *   parallel   12-40 m                   複々線 / freight / paired alignment: legal
 *   separate   >40 m                     different corridors, out of scope
 *
 * 3 m is not 複々線: 列車線/電車線 sit 10-25 m apart and stay parallel for their
 * whole length. Nothing here decides WHAT to do about a duplicate — a stroke
 * that should exist gets rerouted onto its own N02 section, and only a truly
 * redundant one is pruned (函館線-4's precedent, pinned by a test).
 */
import {
  createEdgeIndex,
  resample,
} from "./railway-topology.mjs";

export const SAMPLE_STEP_METERS = 10;
export const DUPLICATE_METERS = 3;
export const SUSPECT_METERS = 12;
export const PARALLEL_METERS = 40;
export const RUN_REPORT_METERS = 200;

const INDEX_CELL_DEGREES = 0.005;

/** Decode a compact line into its display strokes (continuation flag aware). */
export function strokesOf(line) {
  const strokes = [];
  let current = [];
  for (const row of line.segments) {
    const points = row[2].map((point) => [...point]);
    if (row[1] && current.length) current.push(...points);
    else {
      if (current.length) strokes.push(current);
      current = points;
    }
  }
  if (current.length) strokes.push(current);
  return strokes;
}

function indexFor(strokes) {
  const index = createEdgeIndex(INDEX_CELL_DEGREES);
  for (const stroke of strokes) index.add(stroke, true);
  return index;
}

function nearestDistance(point, index) {
  const hit = index.nearest(point);
  return hit ? hit.distance : Infinity;
}

/** Contiguous runs of samples under `limit`, as [{ meters, from, to }]. */
function runsUnder(distances, limit) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= distances.length; i += 1) {
    const inside = i < distances.length && distances[i] <= limit;
    if (inside && start < 0) start = i;
    if (!inside && start >= 0) {
      runs.push({ from: start, to: i - 1, meters: (i - start) * SAMPLE_STEP_METERS });
      start = -1;
    }
  }
  return runs;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Measure stroke A against stroke B.
 *
 * Directional on purpose: a 3 km line lying entirely on top of a 30 km one is
 * 100 % duplicated while the long one is only 10 %, and both numbers are worth
 * reporting. The caller pairs each way round.
 */
export function compareLines(a, b) {
  const index = indexFor(strokesOf(b));
  const distances = [];
  const points = [];
  for (const stroke of strokesOf(a))
    // resample() yields { point, measure, index } rows, not bare coordinates.
    for (const sample of resample(stroke, SAMPLE_STEP_METERS)) {
      distances.push(nearestDistance(sample.point, index));
      points.push(sample.point);
    }
  const lengthMeters = distances.length * SAMPLE_STEP_METERS;
  const duplicateRuns = runsUnder(distances, DUPLICATE_METERS).filter(
    (run) => run.meters >= RUN_REPORT_METERS,
  );
  const suspectRuns = runsUnder(distances, SUSPECT_METERS).filter(
    (run) => run.meters >= RUN_REPORT_METERS,
  );
  const parallelRuns = runsUnder(distances, PARALLEL_METERS).filter(
    (run) => run.meters >= RUN_REPORT_METERS,
  );
  const duplicateMeters = duplicateRuns.reduce((sum, run) => sum + run.meters, 0);
  const suspectMeters = suspectRuns.reduce((sum, run) => sum + run.meters, 0);
  const overlapping = distances.filter((value) => value <= PARALLEL_METERS);
  let verdict = "separate";
  if (duplicateMeters) verdict = "duplicate";
  else if (suspectMeters) verdict = "suspect";
  else if (parallelRuns.length) verdict = "parallel";
  return {
    lengthMeters,
    duplicateMeters,
    suspectMeters,
    // Where the two coincide, so a caller can ask the basemap how many tracks
    // that corridor really has (coincidentTrackCount).
    duplicatePoints: duplicateRuns.flatMap((run) => {
      const step = Math.max(1, Math.floor((run.to - run.from + 1) / 12));
      const picked = [];
      for (let i = run.from; i <= run.to; i += step) picked.push(points[i]);
      return picked;
    }),
    longestDuplicateRunMeters: duplicateRuns.reduce((best, run) => Math.max(best, run.meters), 0),
    longestSuspectRunMeters: suspectRuns.reduce((best, run) => Math.max(best, run.meters), 0),
    medianGapMeters: median(overlapping),
    verdict,
  };
}

/**
 * How many distinct claimable OSM tracks the corridor holds at these points.
 *
 * This is what separates the two coincidence cases, and neither geometry nor
 * the package can answer it:
 *
 *   <=2       one alignment. A plain 複線 is TWO OSM ways — the up and down
 *             rails of a single railway — so a branch drawn over its trunk
 *             here is the MAIN_BRANCH_SHARED contract (支線共用軌 must stay
 *             vertex-coincident), NOT a defect.
 *   3         a 複線 plus a loop/passing road, or a partly mapped 複々線:
 *             cannot be told apart from the cache alone, so it goes to review
 *             rather than being called either way.
 *   >=4       two independent double-track alignments (複々線, 電車線/列車線).
 *             Two strokes on ONE of them means at least one was routed onto
 *             the other's rails — the 日暮里/赤羽 defect, measured: 東北線-2/-3
 *             and 東北線-3/-4 sit on a 4-track corridor, 東北線/-6 at 赤羽 too.
 *
 * Counted per sample and reported as the median, because a shared run usually
 * begins and ends in a throat where the count is transient.
 */
export function coincidentTrackCount(points, filter, osmIndex, radiusMeters = 30) {
  if (!points.length || !osmIndex || !filter) return null;
  const counts = [];
  // RUNNING tracks only. The claim filter deliberately accepts a named siding,
  // because a platform road at a terminus is often tagged that way — but the
  // question here is whether the corridor holds two independent double-track
  // alignments, and counting siding stubs as alignments inflates it straight
  // past the >=4 gate. (Measured: allowing them turned 4 adjudicated
  // duplicates into 7.)
  const runningOnly = (level) => (meta) => meta.running && level.accept(meta);
  for (const point of points) {
    for (const level of filter.levels) {
      const found = osmIndex.within(point, radiusMeters, runningOnly(level));
      if (!found.size) continue;
      counts.push(new Set([...found.keys()].map((meta) => meta.id)).size);
      break;
    }
  }
  if (!counts.length) return null;
  return median(counts);
}

/** Lines that must be compared: same railwayIdentity, or same operator + name. */
export function candidatePairs(lines) {
  const groups = new Map();
  const add = (key, line) => {
    if (!key) return;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    if (!list.includes(line)) list.push(line);
  };
  for (const line of lines) {
    add(`identity ${line.railwayIdentity || ""}`, line);
    add(`name ${line.operator} ${line.name}`, line);
  }
  const pairs = new Map();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i += 1)
      for (let j = i + 1; j < list.length; j += 1) {
        const key = [list[i].id, list[j].id].sort().join(" ");
        if (!pairs.has(key)) pairs.set(key, [list[i], list[j]]);
      }
  }
  return [...pairs.values()];
}

/** Every duplicate/suspect relationship in a package, worst first. */
export function findDuplicateStrokes(pkg, options = {}) {
  const { osmIndex = null, claimFilterFor = null } = options;
  const rows = [];
  for (const [a, b] of candidatePairs(pkg.lines)) {
    const forward = compareLines(a, b);
    const backward = compareLines(b, a);
    if (forward.verdict === "separate" && backward.verdict === "separate") continue;
    const worst =
      forward.duplicateMeters >= backward.duplicateMeters ? forward : backward;
    const filter = claimFilterFor ? claimFilterFor(a) : null;
    const tracks = coincidentTrackCount(worst.duplicatePoints, filter, osmIndex);
    let basis = "not_measured";
    if (tracks == null) basis = "no_claimable_osm_track";
    else if (tracks >= 4) basis = "corridor_has_two_double_track_alignments";
    else if (tracks >= 3) basis = "corridor_track_count_ambiguous";
    else basis = "single_alignment";
    rows.push({
      lines: [a.id, b.id],
      operator: a.operator,
      names: [a.name, b.name],
      railwayIdentity: a.railwayIdentity || null,
      same_railway_identity: (a.railwayIdentity || null) === (b.railwayIdentity || null),
      verdict: worst.verdict,
      // A duplicate over a single physical track is the shared-track contract,
      // not a defect; only a duplicate inside a multi-track corridor is one.
      duplicate_verdict:
        worst.verdict !== "duplicate"
          ? worst.verdict
          : basis === "corridor_has_two_double_track_alignments"
            ? "duplicate"
            : basis === "single_alignment"
              ? "shared_track_by_contract"
              : basis === "corridor_track_count_ambiguous"
                ? "needs_human"
                : "undecidable",
      coincident_osm_tracks: tracks,
      verdict_basis: basis,
      // Where the coincidence actually is, so a consumer can flag the stations
      // in that stretch instead of every station on a 16 km line.
      duplicate_points: worst.duplicatePoints.map((point) => [
        Number(point[0].toFixed(6)),
        Number(point[1].toFixed(6)),
      ]),
      duplicate_meters: Math.round(worst.duplicateMeters),
      longest_duplicate_run_meters: Math.round(worst.longestDuplicateRunMeters),
      suspect_meters: Math.round(worst.suspectMeters),
      median_gap_meters:
        worst.medianGapMeters == null ? null : Number(worst.medianGapMeters.toFixed(1)),
      forward: {
        line: a.id,
        length_meters: Math.round(forward.lengthMeters),
        duplicate_share: Number((forward.duplicateMeters / forward.lengthMeters || 0).toFixed(3)),
      },
      backward: {
        line: b.id,
        length_meters: Math.round(backward.lengthMeters),
        duplicate_share: Number((backward.duplicateMeters / backward.lengthMeters || 0).toFixed(3)),
      },
    });
  }
  rows.sort(
    (left, right) =>
      right.duplicate_meters - left.duplicate_meters ||
      right.suspect_meters - left.suspect_meters ||
      left.lines[0].localeCompare(right.lines[0]),
  );
  return rows;
}
