// =========================================================================
//  app-overlap-lanes.js — §26a: parallel-offset overlap lanes, corridor chains & curve smoothing
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §26.  Parallel-offset overlap display & deck.gl record builders
// =========================================================================

// --- Parallel-offset display of overlapping routes -------------------------
// When N trains share an identical drawn segment, fan them into N parallel
// lanes (each base_width/N wide) so every line stays visible and individually
// hover/clickable. Offsets are computed in screen pixels at the CURRENT zoom
// (constant on-screen spacing) and rebuilt on zoomend; the pick layer uses the
// per-lane spacing as its hit width so any one of the N lanes can be selected.
let _deckHasOverlaps = false;

// --- signature-keyed caches -------------------------------------------------
// The overlap map (segment counts + corridor direction graph) and the split
// route records depend only on the route signature (train set / order / ride
// flags / selection / date scope / per-train style) — never on zoom or pan.
// Zoom/pan only move the LANE OFFSETS (pixel spacing re-expressed in degrees),
// so view changes refresh pickPath on the cached records instead of re-walking
// every segment. DISPLAY slider changes bypass the signature (it does not
// encode DISPLAY), so applyDisplaySettings() clears these explicitly.
// MULTI-ENTRY: the caches keep the last few signatures (typically the "全部"
// scope plus a couple of concrete dates) instead of a single entry, so
// toggling 日期 ⇄ 全部 is a lookup, not a full overlap/record/marker rebuild.
// The first render of each scope pays the build cost once; every return to an
// already-rendered scope only re-uploads the cached records to the GPU.
const DECK_SCOPE_CACHE_MAX = 4;
let _overlapCacheBySig = new Map(); // overlapSig → overlap map
let _deckRecordsCacheBySig = new Map(); // recordSig → built record bundle
let _lastOverlapSpacingDeg = 0;

// Insert with FIFO eviction so long sessions flipping through many dates
// don't grow the caches without bound.
function _deckCachePut(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > DECK_SCOPE_CACHE_MAX)
    cache.delete(cache.keys().next().value);
}

function invalidateDeckRouteCaches() {
  _overlapCacheBySig.clear();
  _deckRecordsCacheBySig.clear();
  _routeItemsCacheBySig.clear();
  _lastPushedBuilt = null;
  // Marker records bake DISPLAY radii/strokes, so they drop with the rest.
  _markerRecordsCacheBySig.clear();
  _lastPushedMarkerRecords = null;
}

// Selection-free style scope for ROUTE RECORDS: the record cache must not
// depend on which train is picked (focus emphasis is drawn by railmap's SEL
// layers + the focus-boost width expression), so `focused` is always false
// here and `dimmed` derives from the date scope alone.
function routeRecordScopeFlags(train) {
  return {
    focused: false,
    // Cross-day trains run on two dates, so both of their days keep them in
    // scope (undimmed and interactive) — see trainSpansDate.
    dimmed: cachedRouteDateActive && !trainSpansDate(train, selectedDate),
  };
}

// Lane spacing: generous enough that sliding the mouse between parallel lanes
// takes a comfortable movement (~12px per lane), independent of how thin the
// drawn lines are — but never narrower than the widest possible line (custom
// per-train weights + focus boost). The focus boost is budgeted for EVERY
// train so the spacing — and with it the whole record cache — never depends
// on which train is currently selected.
function currentOverlapSpacingPx(items) {
  // Line weight is uniform (global 線路粗細), so spacing keys off the single
  // base weight × scale + focus boost — no per-train weight scan.
  const scale = DISPLAY.routeWidthScale || 1;
  const maxW = DEFAULT_TRAIN_WEIGHT * scale;
  return Math.max(
    3 * DEFAULT_TRAIN_WEIGHT * scale,
    maxW + DISPLAY.focusBoost + 4,
    12,
  );
}

function getDeckOverlapMapCached(items) {
  // Keyed on the OVERLAP signature (geometry/visibility/date only), so
  // style-only edits rebuild the records but keep the corridor graph.
  const sig = cachedRouteOverlapSignature;
  if (!sig) return buildDeckOverlapMap(items);
  let overlap = _overlapCacheBySig.get(sig);
  if (!overlap) {
    overlap = buildDeckOverlapMap(items);
    _deckCachePut(_overlapCacheBySig, sig, overlap);
  }
  return overlap;
}

// zoomend/moveend hook: rebuild lane offsets only when the px→degree factor
// actually drifted (zoom changed, or the map centre moved far enough north/
// south that the latitude correction is off by ≥5%). Cheap no-op otherwise.
function maybeRefreshOverlapOffsets() {
  if (!map || !_deckHasOverlaps || !cachedRouteItems) return;
  const deg = overlapOffsetDeg(currentOverlapSpacingPx());
  if (!deg) return;
  if (
    _lastOverlapSpacingDeg &&
    Math.abs(deg - _lastOverlapSpacingDeg) / _lastOverlapSpacingDeg < 0.05
  )
    return;
  renderRoutesInView();
}

function overlapOffsetDeg(px) {
  if (!map || !px) return 0;
  // MapLibre zoom convention: z0 = whole world in 512px (one level lower than
  // Leaflet's 256px-tile zoom for the same view), hence z + 1 here.
  const z = map.getZoom() + 1;
  const lat = map.getCenter().lat;
  const metersPerPx =
    (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
  return (px * metersPerPx) / 111320; // degrees of latitude per `px` pixels
}

// --- rigid lane translation ---------------------------------------------------
// A lane is a RIGID TRANSLATION of the line: every vertex moves by the SAME
// constant vector, so corners, curve radii and segment lengths are preserved
// exactly — the fanned copy is the original shape, just shifted sideways.
// (Per-vertex perpendicular offsetting was abandoned on request: it distorts
// bends and tapers at corridor ends.)
//
// The shift direction is computed ONCE per overlap group: the unit vector
// perpendicular (right-hand) to the group's dominant canonical direction,
// expressed in degree space ([sx, sy] with sx pre-divided by cos(latRef) so a
// shift of `offsetDeg` covers the same number of PIXELS in any direction).
// The corridor is oriented east-/north-dominant, so a negative multiplier
// (slot 0 = earliest date) is the LEFT / TOP lane on screen.
function applyLaneShift(path, sx, sy, offsetDeg) {
  if (!offsetDeg) return path;
  const dx = sx * offsetDeg;
  const dy = sy * offsetDeg;
  const out = new Array(path.length);
  for (let i = 0; i < path.length; i += 1)
    out[i] = [path[i][0] + dx, path[i][1] + dy];
  return out;
}

// Exact-enough local metric distance used by final fit validation.  Unlike the
// solver's convenient single-latitude plane, each query gets its own longitude
// scale, so a long north/south corridor does not accumulate projection error.
function fittedPointSegmentDistanceMeters(p, a, b) {
  const coslat =
    Math.cos((((p[1] + a[1] + b[1]) / 3) * Math.PI) / 180) || 1e-6;
  const ax = (a[0] - p[0]) * 111320 * coslat;
  const ay = (a[1] - p[1]) * 110540;
  const bx = (b[0] - p[0]) * 111320 * coslat;
  const by = (b[1] - p[1]) * 110540;
  const vx = bx - ax;
  const vy = by - ay;
  const den = vx * vx + vy * vy;
  const t = den ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / den)) : 0;
  return Math.hypot(ax + vx * t, ay + vy * t);
}

// Final deviation is always measured against raw railway geometry, never
// against a previous fitted stage.  A degree grid keeps the usual query local;
// the distance calculation itself remains in metres and latitude-aware.
function validateFittedCurveDeviation(points, sourceLines, budgetMeters) {
  const lines = (sourceLines || []).filter((line) => line && line.length >= 2);
  if (!points || points.length < 2 || !lines.length || !(budgetMeters > 0))
    return { valid: false, maxDeviationMeters: Infinity };
  const cellDeg = Math.max(0.005, Math.min(0.05, budgetMeters / 110540));
  const cells = new Map();
  const segments = [];
  lines.forEach((line) => {
    for (let i = 0; i < line.length - 1; i += 1) {
      const a = line[i];
      const b = line[i + 1];
      const index = segments.length;
      segments.push([a, b]);
      const x0 = Math.floor(Math.min(a[0], b[0]) / cellDeg);
      const x1 = Math.floor(Math.max(a[0], b[0]) / cellDeg);
      const y0 = Math.floor(Math.min(a[1], b[1]) / cellDeg);
      const y1 = Math.floor(Math.max(a[1], b[1]) / cellDeg);
      for (let x = x0; x <= x1; x += 1)
        for (let y = y0; y <= y1; y += 1) {
          const key = x + "," + y;
          let bucket = cells.get(key);
          if (!bucket) cells.set(key, (bucket = []));
          bucket.push(index);
        }
    }
  });
  const nearest = (p) => {
    const coslat = Math.cos((p[1] * Math.PI) / 180) || 1e-6;
    const lonRadius = budgetMeters / (111320 * coslat);
    const latRadius = budgetMeters / 110540;
    const x0 = Math.floor((p[0] - lonRadius) / cellDeg) - 1;
    const x1 = Math.floor((p[0] + lonRadius) / cellDeg) + 1;
    const y0 = Math.floor((p[1] - latRadius) / cellDeg) - 1;
    const y1 = Math.floor((p[1] + latRadius) / cellDeg) + 1;
    const seen = new Set();
    let best = Infinity;
    for (let x = x0; x <= x1; x += 1)
      for (let y = y0; y <= y1; y += 1) {
        const bucket = cells.get(x + "," + y);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 1) {
          const index = bucket[i];
          if (seen.has(index)) continue;
          seen.add(index);
          const segment = segments[index];
          best = Math.min(
            best,
            fittedPointSegmentDistanceMeters(p, segment[0], segment[1]),
          );
        }
      }
    return best;
  };

  let maximum = 0;
  const distances = points.map((p) => {
    const d = nearest(p);
    maximum = Math.max(maximum, d);
    return d;
  });
  if (maximum > budgetMeters)
    return { valid: false, maxDeviationMeters: maximum };

  // Distance-to-a-set is 1-Lipschitz.  This bound proves whole output
  // segments, not just their vertices; only spans too close to the budget are
  // subdivided.  At the depth cap we reject conservatively.
  const verifySpan = (a, b, da, db, depth) => {
    const length = distanceMeters(a, b);
    const upper = Math.max(da, db, (da + db + length) / 2);
    if (upper <= budgetMeters) return true;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const dm = nearest(mid);
    maximum = Math.max(maximum, dm);
    if (dm > budgetMeters) return false;
    if (depth >= 9) return false;
    return (
      verifySpan(a, mid, da, dm, depth + 1) &&
      verifySpan(mid, b, dm, db, depth + 1)
    );
  };
  for (let i = 0; i < points.length - 1; i += 1)
    if (!verifySpan(points[i], points[i + 1], distances[i], distances[i + 1], 0))
      return { valid: false, maxDeviationMeters: maximum };
  return { valid: true, maxDeviationMeters: maximum };
}

// Both corridor stitching layers deliberately build paths, not branch graphs.
// Once one endpoint wins a candidate, no second curve may attach to it.
function selectOneToOneEndpointPairs(sortedCandidates, ambiguityMargin = 0) {
  const candidatesByEnd = new Map();
  (sortedCandidates || []).forEach((candidate) => {
    if (!candidate || !candidate.a || !candidate.b) return;
    [candidate.a.id, candidate.b.id].forEach((id) => {
      let list = candidatesByEnd.get(id);
      if (!list) candidatesByEnd.set(id, (list = []));
      list.push(candidate);
    });
  });
  const ambiguousEnds = new Set();
  if (ambiguityMargin > 0)
    candidatesByEnd.forEach((list, id) => {
      list.sort((a, b) => a.score - b.score);
      if (
        list.length > 1 &&
        list[1].score - list[0].score <= ambiguityMargin
      )
        ambiguousEnds.add(id);
    });
  const usedEnds = new Set();
  const selected = [];
  (sortedCandidates || []).forEach((candidate) => {
    if (
      !candidate ||
      !candidate.a ||
      !candidate.b ||
      ambiguousEnds.has(candidate.a.id) ||
      ambiguousEnds.has(candidate.b.id) ||
      usedEnds.has(candidate.a.id) ||
      usedEnds.has(candidate.b.id)
    )
      return;
    usedEnds.add(candidate.a.id);
    usedEnds.add(candidate.b.id);
    selected.push(candidate);
  });
  return selected;
}

function corridorEndpointOutward(gi, side) {
  const line = gi && gi._line;
  if (!line || line.length < 2) return null;
  const a = side === 0 ? line[0] : line[line.length - 1];
  const b = side === 0 ? line[1] : line[line.length - 2];
  const cs = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180) || 1e-6;
  const dx = (a[0] - b[0]) * cs;
  const dy = a[1] - b[1];
  const len = Math.hypot(dx, dy);
  return len > 0 ? [dx / len, dy / len] : null;
}

// Two loose run ends may represent the same corridor join even when their
// coordinates do not literally touch.  Besides distance, require the two
// outward tangents to face one another along the missing interval; nearby
// parallel tracks and real forks are therefore not glued together.
function corridorEndpointPair(a, b) {
  if (!a || !b || a.key === b.key || a.sig !== b.sig) return null;
  const metres = distanceMeters(a.p, b.p);
  if (metres > OVERLAP_CORRIDOR_JOIN_METERS) return null;
  const facing = -(a.out[0] * b.out[0] + a.out[1] * b.out[1]);
  // A shared coordinate is not sufficient at a junction: several branches
  // can snap to the same station node.  Keep a relaxed tangent check even at
  // zero gap so greedy pairing cannot connect perpendicular platform throats.
  if (metres <= OVERLAP_SNAP_METERS) {
    if (facing < 0.35) return null;
    return { metres, score: metres + (1 - facing) * 40 };
  }
  const lat = (a.p[1] + b.p[1]) / 2;
  const cs = Math.cos((lat * Math.PI) / 180) || 1e-6;
  const gx = (b.p[0] - a.p[0]) * cs;
  const gy = b.p[1] - a.p[1];
  const gl = Math.hypot(gx, gy) || 1;
  const ux = gx / gl;
  const uy = gy / gl;
  const aAlong = a.out[0] * ux + a.out[1] * uy;
  const bAlong = b.out[0] * ux + b.out[1] * uy;
  if (aAlong < 0.35 || bAlong > -0.35 || facing < 0.55) return null;
  return {
    metres,
    score: metres * (1 + (1 - facing) + (1 - aAlong) + (1 + bAlong)),
  };
}

// Walk a component through the explicit endpoint joins selected below.  Gap
// endpoints are both retained in the direction curve, so its arc length stays
// continuous across source-feature seams without changing visible geometry.
function buildCorridorChain(c, groupInfo, joins) {
  const byKey = new Map();
  joins.forEach((j) => {
    if (!c.keySet.has(j.a.key) || !c.keySet.has(j.b.key)) return;
    [j.a.key, j.b.key].forEach((k) => {
      let list = byKey.get(k);
      if (!list) byKey.set(k, (list = []));
      list.push(j);
    });
  });
  let startKey = c.keys.find((k) => (byKey.get(k) || []).length < 2) || c.keys[0];
  const startJoins = byKey.get(startKey) || [];
  let fromSide = startJoins.length === 1
    ? 1 - (startJoins[0].a.key === startKey ? startJoins[0].a.side : startJoins[0].b.side)
    : 0;
  const unused = new Set(c.keys);
  const usedJoins = new Set();
  const chain = [];
  let key = startKey;
  while (key && unused.has(key)) {
    unused.delete(key);
    const gi = groupInfo.get(key);
    let line = gi && gi._line;
    if (!line || line.length < 2) break;
    if (fromSide === 1) line = line.slice().reverse();
    for (let i = 0; i < line.length; i += 1) {
      if (!chain.length || distanceMeters(chain[chain.length - 1], line[i]) > 0.05)
        chain.push(line[i]);
    }
    const endSide = 1 - fromSide;
    const nextJoin = (byKey.get(key) || []).find((j) => {
      if (usedJoins.has(j)) return false;
      const end = j.a.key === key ? j.a : j.b;
      return end.side === endSide;
    });
    if (!nextJoin) break;
    usedJoins.add(nextJoin);
    const nextEnd = nextJoin.a.key === key ? nextJoin.b : nextJoin.a;
    key = nextEnd.key;
    fromSide = nextEnd.side;
  }
  return chain.length >= 2 ? chain : null;
}

// One near-parallel interaction key may be encountered on several physical
// runs. Join only unambiguous end-to-end continuations, choose the longest
// resulting representative chain, and rebuild every direction-dependent field
// together. Parallel alternatives remain alternatives; sequential fragments
// become one complete anchor instead of being silently discarded.
function rebuildGroupRepresentativeGeometry(gi) {
  const lines = (gi && gi._lines || []).filter(
    (line) => line && line.length >= 2,
  );
  if (!gi || !lines.length) return null;
  const tempInfo = new Map();
  const endpoints = [];
  lines.forEach((line, index) => {
    const key = "representative:" + index;
    const item = { _line: line };
    tempInfo.set(key, item);
    [0, 1].forEach((side) => {
      const out = corridorEndpointOutward(item, side);
      if (!out) return;
      endpoints.push({
        id: key + "::" + side,
        key,
        side,
        p: side === 0 ? line[0] : line[line.length - 1],
        out,
        sig: "representative",
      });
    });
  });
  const candidates = [];
  for (let i = 0; i < endpoints.length; i += 1)
    for (let j = i + 1; j < endpoints.length; j += 1) {
      const match = corridorEndpointPair(endpoints[i], endpoints[j]);
      if (match)
        candidates.push({ a: endpoints[i], b: endpoints[j], ...match });
    }
  candidates.sort((a, b) => a.score - b.score);
  const joins = selectOneToOneEndpointPairs(candidates, 8);
  const parent = new Map([...tempInfo.keys()].map((key) => [key, key]));
  const find = (key) => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    let current = key;
    while (parent.get(current) !== current) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  joins.forEach((join) => parent.set(find(join.b.key), find(join.a.key)));
  const components = new Map();
  tempInfo.forEach((_, key) => {
    const root = find(key);
    let keys = components.get(root);
    if (!keys) components.set(root, (keys = []));
    keys.push(key);
  });
  const lineLength = (line) => {
    let length = 0;
    for (let i = 1; i < line.length; i += 1)
      length += distanceMeters(line[i - 1], line[i]);
    return length;
  };
  let representative = lines[0];
  let representativeLength = lineLength(representative);
  components.forEach((keys) => {
    const keySet = new Set(keys);
    const componentJoins = joins.filter(
      (join) => keySet.has(join.a.key) && keySet.has(join.b.key),
    );
    let candidate = null;
    if (keys.length > 1 && componentJoins.length < keys.length)
      candidate = buildCorridorChain(
        { keys, keySet },
        tempInfo,
        componentJoins,
      );
    if (!candidate)
      keys.forEach((key) => {
        const line = tempInfo.get(key)._line;
        if (!candidate || lineLength(line) > lineLength(candidate)) candidate = line;
      });
    const length = lineLength(candidate);
    if (length > representativeLength) {
      representative = candidate;
      representativeLength = length;
    }
  });

  let latitudeSum = 0;
  let latitudeCount = 0;
  for (let i = 1; i < representative.length; i += 1) {
    latitudeSum += (representative[i - 1][1] + representative[i][1]) / 2;
    latitudeCount += 1;
  }
  const latRef = latitudeCount ? latitudeSum / latitudeCount : representative[0][1];
  const coslat = Math.cos((latRef * Math.PI) / 180) || 1e-6;
  let pa = representative[0];
  let pb = representative[representative.length - 1];
  if (pb[0] < pa[0] || (pb[0] === pa[0] && pb[1] < pa[1])) {
    const swap = pa;
    pa = pb;
    pb = swap;
  }
  let dx = (pb[0] - pa[0]) * coslat;
  let dy = pb[1] - pa[1];
  let length = Math.hypot(dx, dy);
  if (length < 1e-9) {
    let longest = 0;
    for (let i = 1; i < representative.length; i += 1) {
      let sx = (representative[i][0] - representative[i - 1][0]) * coslat;
      let sy = representative[i][1] - representative[i - 1][1];
      const segmentLength = Math.hypot(sx, sy);
      if (segmentLength <= longest) continue;
      if (sx < 0 || (sx === 0 && sy < 0)) {
        sx = -sx;
        sy = -sy;
      }
      longest = segmentLength;
      dx = sx;
      dy = sy;
    }
    length = Math.hypot(dx, dy) || 1;
  }
  gi._line = representative;
  gi._pa = representative[0];
  gi._pb = representative[representative.length - 1];
  gi._latRef = latRef;
  gi.sx = dy / length / coslat;
  gi.sy = -dx / length;
  return representative;
}

// --- corridor curve memo ---------------------------------------------------
// smoothCorridorCurve is a PURE function of (input coordinates, fit-curve
// settings) but is the single most expensive step of a cold record build
// (~1.7s across ~330 corridors in 全部: a B-spline solve with curvature
// regularisation + fallback passes per corridor). Both call sites (the corridor
// chain, and smoothStandaloneCorridorRun) funnel through it, so memoizing here
// lets any repaint that keeps the route GEOMETRY — style / visibility / ride /
// date / selection edits, scope switches, returning to 全部 after an edit —
// reuse the fitted curves instead of re-solving every corridor. Keyed by the
// fit settings + a coordinate signature. A structuredClone is handed out and
// the cached entry is never surfaced, so the caller's post-fit mutations (the
// nearParallel flag, the station-join reassignment of gi.curve) cannot corrupt
// the cache. Bounded FIFO: stale keys from a geometry / settings change are
// simply never matched again and age out. Cloning all live curves costs ~50ms,
// negligible against the ~1.7s solve it replaces.
const _fitCurveMemo = new Map();
const FIT_CURVE_MEMO_MAX = 2048;
// Deep-copy a fitted curve so the cached entry can never be mutated by callers.
// Not structuredClone: the precompute/test VM sandbox does not expose it, and
// JSON round-tripping would turn Infinity/NaN radius fields into null. One-level
// array copy is enough — pts/dirs are [x,y] pairs (sliced), cum is numbers,
// _sourceLines are read-only source lines (their coord pairs may stay shared).
function cloneFittedCurve(c) {
  const o = {};
  for (const k in c) {
    const v = c[k];
    if (Array.isArray(v)) {
      const a = new Array(v.length);
      for (let i = 0; i < v.length; i += 1) {
        const e = v[i];
        a[i] = Array.isArray(e) ? e.slice() : e;
      }
      o[k] = a;
    } else o[k] = v;
  }
  return o;
}
function fitCurveSettingsSig() {
  const s = APPLIED_FIT_CURVE_SETTINGS || {};
  return (
    (s.fitCurvePrecision ?? "") +
    "," +
    (s.fitCurveMinRadius ?? "") +
    "," +
    (s.fitCurveMinDetail ?? "") +
    "," +
    (s.fitCurveMaxDeviation ?? "")
  );
}
function fitCurveCoordSig(line) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < line.length; i += 1) {
    const p = line[i];
    h = Math.imul(h ^ ((p[0] * 1e6) | 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ ((p[1] * 1e6) | 0), 0x01000193) >>> 0;
  }
  // Length + exact endpoints + full hash: a collision would need identical
  // length, endpoints AND hash for genuinely different geometry.
  const f = line[0];
  const l = line[line.length - 1];
  return (
    line.length +
    ":" +
    f[0].toFixed(6) +
    "," +
    f[1].toFixed(6) +
    ":" +
    l[0].toFixed(6) +
    "," +
    l[1].toFixed(6) +
    ":" +
    h.toString(16)
  );
}
function smoothCorridorCurve(line) {
  if (!line || line.length < 2) return null;
  const key = fitCurveSettingsSig() + "|" + fitCurveCoordSig(line);
  const cached = _fitCurveMemo.get(key);
  if (cached) return cloneFittedCurve(cached);
  const result = smoothCorridorCurveUncached(line);
  if (result) {
    if (_fitCurveMemo.size >= FIT_CURVE_MEMO_MAX)
      _fitCurveMemo.delete(_fitCurveMemo.keys().next().value);
    _fitCurveMemo.set(key, result); // pristine: callers only ever get clones
    return cloneFittedCurve(result);
  }
  return null;
}

// Build a genuinely smooth physical-distance fit for the hover fan. The source
// polyline is only an ANCHOR: controls may leave it by fitCurveMaxDeviation,
// sub-fitCurveMinDetail features are removed, curvature is regularised toward
// fitCurveMinRadius, then an open cubic B-spline produces a C2-continuous curve.
// fitCurvePrecision changes output sampling only — it can never reintroduce a
// source corner into either the displayed debug curve or the direction field.
function smoothCorridorCurveUncached(line) {
  if (!line || line.length < 2) return null;
  const precision = Math.max(
    0.5,
    Math.min(2, Number(APPLIED_FIT_CURVE_SETTINGS.fitCurvePrecision) || 1),
  );
  const requestedMinRadius = Math.max(
    100,
    Math.min(
      40000,
      Number(APPLIED_FIT_CURVE_SETTINGS.fitCurveMinRadius) || 3100,
    ),
  );
  // Solve with a small safety margin so discrete output sampling, latitude
  // scaling and endpoint correction can never pull the measured result below
  // the user-facing minimum radius.
  const minRadius = requestedMinRadius * 1.03;
  const minDetail = Math.max(
    20,
    Math.min(
      30000,
      Number(APPLIED_FIT_CURVE_SETTINGS.fitCurveMinDetail) || 3300,
    ),
  );
  const maxDeviation = Math.max(
    20,
    Math.min(
      40000,
      Number(APPLIED_FIT_CURVE_SETTINGS.fitCurveMaxDeviation) || 4200,
    ),
  );
  const cum = [0];
  for (let i = 1; i < line.length; i += 1)
    cum.push(cum[i - 1] + distanceMeters(line[i - 1], line[i]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) return null;
  const pointOnSource = (target) => {
    let lo = 0;
    let hi = cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid;
      else hi = mid;
    }
    const span = cum[lo + 1] - cum[lo] || 1;
    const t = Math.max(0, Math.min(1, (target - cum[lo]) / span));
    return [
      line[lo][0] + (line[lo + 1][0] - line[lo][0]) * t,
      line[lo][1] + (line[lo + 1][1] - line[lo][1]) * t,
    ];
  };

  // Work resolution is independent of the debug-output resolution. Keeping it
  // tied to physical detail makes every option stable across source densities.
  const workStepTarget = Math.max(20, Math.min(90, minDetail / 6));
  const workN = Math.max(
    20,
    Math.min(1800, Math.ceil(total / workStepTarget) + 1),
  );
  const workStep = total / (workN - 1);
  const anchors = new Array(workN);
  for (let i = 0; i < workN; i += 1)
    anchors[i] = pointOnSource((total * i) / (workN - 1));

  const lat0 = line.reduce((s, p) => s + p[1], 0) / line.length;
  const coslat = Math.cos((lat0 * Math.PI) / 180) || 1e-6;
  const mx = 111320 * coslat;
  const my = 110540;
  const origin = anchors[0];
  const anchorMetric = anchors.map((p) => [
    (p[0] - origin[0]) * mx,
    (p[1] - origin[1]) * my,
  ]);
  let metric = anchorMetric.map((p) => p.slice());

  // This first scale-space fit is intentionally allowed to cut inside bends.
  // Linear continuation at either end avoids the endpoint kink caused by
  // pinning a moving average to the first/last source vertex.
  const sigmaM = Math.max(100, minDetail * 1.1, minRadius * 0.65);
  const gaussianPass = (input, sigma) => {
    const radius = Math.max(
      3,
      Math.min(240, input.length - 1, Math.ceil((sigma * 3) / workStep)),
    );
    const weights = new Array(radius + 1);
    for (let k = 0; k <= radius; k += 1)
      weights[k] = Math.exp(-0.5 * Math.pow((k * workStep) / sigma, 2));
    const edgeSpan = Math.min(input.length - 1, Math.max(3, radius));
    const startDx = (input[edgeSpan][0] - input[0][0]) / edgeSpan;
    const startDy = (input[edgeSpan][1] - input[0][1]) / edgeSpan;
    const endDx =
      (input[input.length - 1][0] - input[input.length - 1 - edgeSpan][0]) /
      edgeSpan;
    const endDy =
      (input[input.length - 1][1] - input[input.length - 1 - edgeSpan][1]) /
      edgeSpan;
    const at = (i) => {
      if (i < 0)
        return [input[0][0] + startDx * i, input[0][1] + startDy * i];
      if (i >= input.length) {
        const d = i - (input.length - 1);
        return [
          input[input.length - 1][0] + endDx * d,
          input[input.length - 1][1] + endDy * d,
        ];
      }
      return input[i];
    };
    return input.map((_, i) => {
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const w = weights[Math.abs(k)];
        const p = at(i + k);
        sx += p[0] * w;
        sy += p[1] * w;
        sw += w;
      }
      return [sx / sw, sy / sw];
    });
  };
  metric = gaussianPass(metric, sigmaM);
  metric = gaussianPass(metric, sigmaM * 0.65);

  const clampDeviation = (p, anchor) => {
    const dx = p[0] - anchor[0];
    const dy = p[1] - anchor[1];
    const d = Math.hypot(dx, dy);
    if (d <= maxDeviation || d < 1e-9) return p;
    const f = maxDeviation / d;
    return [anchor[0] + dx * f, anchor[1] + dy * f];
  };
  metric = metric.map((p, i) => clampDeviation(p, anchorMetric[i]));
  // Keep physical corridor endpoints addressable; the clamped B-spline still
  // provides a smooth one-sided tangent there.
  metric[0] = anchorMetric[0].slice();
  metric[metric.length - 1] = anchorMetric[anchorMetric.length - 1].slice();

  const circumRadius = (a, b, c) => {
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const cross = Math.abs(
      (b[0] - a[0]) * (c[1] - a[1]) -
        (b[1] - a[1]) * (c[0] - a[0]),
    );
    return cross < 1e-6 ? Infinity : (ab * bc * ca) / (2 * cross);
  };

  // Curvature projection: repeatedly relax only the points whose measured
  // radius is below the requested minimum. Deviation limiting is applied on
  // every pass, so the two user constraints remain well-behaved together.
  const curvatureHalf = Math.max(
    1,
    Math.round(
      Math.max(100, minDetail * 0.45, minRadius * 0.12) / workStep,
    ),
  );
  for (let pass = 0; pass < 48; pass += 1) {
    const next = metric.map((p) => p.slice());
    let violations = 0;
    let maxMove = 0;
    for (let i = curvatureHalf; i < metric.length - curvatureHalf; i += 1) {
      const a = metric[i - curvatureHalf];
      const b = metric[i];
      const c = metric[i + curvatureHalf];
      const radius = circumRadius(a, b, c);
      if (radius >= minRadius) continue;
      violations += 1;
      const severity = Math.max(0, Math.min(1, 1 - radius / minRadius));
      const pull = 0.08 + severity * 0.34;
      const target = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
      const candidate = clampDeviation(
        [b[0] + (target[0] - b[0]) * pull, b[1] + (target[1] - b[1]) * pull],
        anchorMetric[i],
      );
      maxMove = Math.max(maxMove, Math.hypot(candidate[0] - b[0], candidate[1] - b[1]));
      next[i] = candidate;
    }
    metric = next;
    metric[0] = anchorMetric[0].slice();
    metric[metric.length - 1] = anchorMetric[anchorMetric.length - 1].slice();
    if (!violations || maxMove < 0.01) break;
  }

  // Physical knot spacing, not source vertices, controls what the spline may
  // express. A larger minimum-detail value therefore removes more wiggles and
  // also gives the B-spline more freedom to span across small protrusions.
  const knotSpacing = Math.max(100, minDetail * 1.25, minRadius * 0.18);
  const knotEvery = Math.max(1, Math.round(knotSpacing / workStep));
  let controls = [];
  for (let i = 0; i < metric.length; i += knotEvery) controls.push(metric[i]);
  if (controls[controls.length - 1] !== metric[metric.length - 1])
    controls.push(metric[metric.length - 1]);
  if (controls.length < 4) {
    controls = [];
    for (let i = 0; i < 4; i += 1)
      controls.push(metric[Math.round(((metric.length - 1) * i) / 3)]);
  }
  // A sub-radius corridor cannot meaningfully express a bend while keeping
  // both physical endpoints. Treat it as a straight C2 span instead of
  // magnifying tiny source protrusions into a sharp hover-direction change.
  if (total <= Math.max(minDetail * 4, minRadius * 1.1)) {
    const a = anchorMetric[0];
    const b = anchorMetric[anchorMetric.length - 1];
    controls = [0, 1 / 3, 2 / 3, 1].map((t) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
    ]);
  }
  // Open B-splines are C2 only at interior knots. Make the first/last three
  // controls collinear as well, which forces zero endpoint curvature instead
  // of allowing a tight hook beside a station or overlap-run endpoint.
  if (controls.length <= 4) {
    const a = controls[0];
    const b = controls[controls.length - 1];
    controls = [0, 1 / 3, 2 / 3, 1].map((t) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
    ]);
  } else {
    controls[1] = [
      (controls[0][0] + controls[2][0]) / 2,
      (controls[0][1] + controls[2][1]) / 2,
    ];
    const n = controls.length;
    controls[n - 2] = [
      (controls[n - 1][0] + controls[n - 3][0]) / 2,
      (controls[n - 1][1] + controls[n - 3][1]) / 2,
    ];
  }

  // Open/clamped cubic B-spline evaluated with de Boor. Unlike a polyline or
  // Catmull-Rom chain this is C2 continuous at every interior knot, so both
  // tangent and curvature change continuously while the mouse moves.
  const degree = 3;
  const knotCount = controls.length + degree + 1;
  const knots = new Array(knotCount);
  for (let i = 0; i < knotCount; i += 1) {
    if (i <= degree) knots[i] = 0;
    else if (i >= controls.length) knots[i] = 1;
    else knots[i] = (i - degree) / (controls.length - degree);
  }
  const splinePoint = (u) => {
    if (u <= 0) return controls[0].slice();
    if (u >= 1) return controls[controls.length - 1].slice();
    let lo = degree;
    let hi = controls.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (knots[mid] <= u) lo = mid;
      else hi = mid;
    }
    const span = Math.min(controls.length - 1, lo);
    const d = new Array(degree + 1);
    for (let j = 0; j <= degree; j += 1)
      d[j] = controls[span - degree + j].slice();
    for (let r = 1; r <= degree; r += 1)
      for (let j = degree; j >= r; j -= 1) {
        const i = span - degree + j;
        const den = knots[i + degree - r + 1] - knots[i];
        const alpha = den ? (u - knots[i]) / den : 0;
        d[j] = [
          d[j - 1][0] * (1 - alpha) + d[j][0] * alpha,
          d[j - 1][1] * (1 - alpha) + d[j][1] * alpha,
        ];
      }
    return d[degree];
  };
  // Candidate solving/validation uses one fixed physical resolution.  The
  // user's precision setting is applied only when the accepted curve is
  // resampled below, so it cannot trigger a different fallback or shape.
  const solveN = Math.max(
    20,
    Math.min(3200, Math.ceil(total / 30) + 1),
  );
  const evaluateSpline = () => {
    const out = new Array(solveN);
    for (let i = 0; i < solveN; i += 1)
      out[i] = splinePoint(i / (solveN - 1));
    return out;
  };
  const measuredSplineRadius = (points) => {
    let length = 0;
    for (let i = 1; i < points.length; i += 1)
      length += Math.hypot(
        points[i][0] - points[i - 1][0],
        points[i][1] - points[i - 1][1],
      );
    const step = length / Math.max(1, points.length - 1);
    const half = Math.max(
      1,
      Math.round(
        Math.max(45, Math.min(180, minDetail * 0.04)) /
          Math.max(1, step),
      ),
    );
    let radius = Infinity;
    for (let i = half; i < points.length - half; i += 1)
      radius = Math.min(
        radius,
        circumRadius(points[i - half], points[i], points[i + half]),
      );
    return radius;
  };
  let splineMetric = evaluateSpline();
  let achievedMinRadius = measuredSplineRadius(splineMetric);

  // If local filtering alone cannot meet the requested radius, progressively
  // pull the complete control polygon toward its endpoint chord. Each target
  // is still clamped against its corresponding source anchor, so increasing
  // the radius never silently violates the maximum-deviation option. This
  // global fallback is what lets the fit leave a jagged source instead of
  // merely rounding each of its individual corners.
  if (achievedMinRadius < minRadius * 0.999) {
    const originalControls = controls.map((p) => p.slice());
    let bestControls = originalControls;
    let bestSpline = splineMetric;
    let bestRadius = achievedMinRadius;
    for (let pass = 1; pass <= 32; pass += 1) {
      const f = pass / 32;
      controls = originalControls.map((p, i) => {
        const t = i / Math.max(1, originalControls.length - 1);
        const ai = Math.round(t * (anchorMetric.length - 1));
        const chord = [
          anchorMetric[0][0] +
            (anchorMetric[anchorMetric.length - 1][0] - anchorMetric[0][0]) * t,
          anchorMetric[0][1] +
            (anchorMetric[anchorMetric.length - 1][1] - anchorMetric[0][1]) * t,
        ];
        const target = clampDeviation(chord, anchorMetric[ai]);
        return [
          p[0] + (target[0] - p[0]) * f,
          p[1] + (target[1] - p[1]) * f,
        ];
      });
      const candidate = evaluateSpline();
      const candidateRadius = measuredSplineRadius(candidate);
      if (candidateRadius > bestRadius) {
        bestRadius = candidateRadius;
        bestControls = controls.map((p) => p.slice());
        bestSpline = candidate;
      }
      if (candidateRadius >= minRadius * 0.999) break;
    }
    controls = bestControls;
    splineMetric = bestSpline;
    achievedMinRadius = bestRadius;
  }

  // Hairpin/loop corridors can have endpoints that are close together even
  // though the shared track between them is long. Pulling such a curve toward
  // its chord collapses it into a hook. Try constant-curvature circular arcs
  // instead; every point on an accepted candidate has one explicit radius.
  let usedCircularArc = false;
  if (achievedMinRadius < minRadius * 0.999) {
    const start = splineMetric[0];
    const end = splineMetric[splineMetric.length - 1];
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const chord = Math.hypot(dx, dy);
    const minimumArcRadius = Math.max(minRadius * 1.03, chord * 0.5001);
    const radii = Array.from(
      new Set(
        [
          minimumArcRadius,
          Math.max(minimumArcRadius, total / (2 * Math.PI)),
          Math.max(minimumArcRadius, total / Math.PI),
          minimumArcRadius * 1.5,
        ].map((v) => Math.round(v * 1000) / 1000),
      ),
    );
    // Anchor segment vectors are invariant across every radius/side/sweep
    // candidate and every sampled point; precompute them once instead of
    // rebuilding vx/vy/den in the innermost loop.
    const arcSegs = new Array(anchorMetric.length - 1);
    for (let j = 0; j < anchorMetric.length - 1; j += 1) {
      const a0 = anchorMetric[j];
      const b0 = anchorMetric[j + 1];
      const vx = b0[0] - a0[0];
      const vy = b0[1] - a0[1];
      arcSegs[j] = { ax: a0[0], ay: a0[1], vx, vy, den: vx * vx + vy * vy };
    }
    let bestArc = null;
    let bestArcScore = Infinity;
    radii.forEach((radius) => {
      const half = chord / 2;
      const height = Math.sqrt(Math.max(0, radius * radius - half * half));
      const mx0 = (start[0] + end[0]) / 2;
      const my0 = (start[1] + end[1]) / 2;
      const nx = chord > 1e-9 ? -dy / chord : 0;
      const ny = chord > 1e-9 ? dx / chord : 1;
      [-1, 1].forEach((side) => {
        const center = [mx0 + nx * height * side, my0 + ny * height * side];
        const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
        const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
        let shortSweep = endAngle - startAngle;
        while (shortSweep > Math.PI) shortSweep -= 2 * Math.PI;
        while (shortSweep < -Math.PI) shortSweep += 2 * Math.PI;
        [shortSweep, shortSweep > 0 ? shortSweep - 2 * Math.PI : shortSweep + 2 * Math.PI]
          .forEach((sweep) => {
            if (Math.abs(sweep) < 1e-6) return;
            const candidate = new Array(solveN);
            for (let i = 0; i < solveN; i += 1) {
              const t = i / (solveN - 1);
              const a = startAngle + sweep * t;
              candidate[i] = [
                center[0] + Math.cos(a) * radius,
                center[1] + Math.sin(a) * radius,
              ];
            }
            let sampledDeviation = 0;
            let maxNearestDeviation = 0;
            let sampledCount = 0;
            const stride = Math.max(1, Math.floor(solveN / 96));
            for (let i = 0; i < solveN; i += stride) {
              const p = candidate[i];
              const px = p[0];
              const py = p[1];
              let nearestSq = Infinity;
              for (let j = 0; j < arcSegs.length; j += 1) {
                const s = arcSegs[j];
                const u = s.den
                  ? Math.max(
                      0,
                      Math.min(
                        1,
                        ((px - s.ax) * s.vx + (py - s.ay) * s.vy) /
                          s.den,
                      ),
                    )
                  : 0;
                const ex = px - (s.ax + s.vx * u);
                const ey = py - (s.ay + s.vy * u);
                const dSq = ex * ex + ey * ey;
                if (dSq < nearestSq) nearestSq = dSq;
              }
              const nearest = Math.sqrt(nearestSq);
              sampledDeviation += nearest;
              maxNearestDeviation = Math.max(maxNearestDeviation, nearest);
              sampledCount += 1;
            }
            if (maxNearestDeviation > maxDeviation * 1.02) return;
            const arcLength = radius * Math.abs(sweep);
            const score =
              sampledDeviation / Math.max(1, sampledCount) +
              Math.abs(arcLength - total) * 0.08;
            if (score < bestArcScore) {
              bestArcScore = score;
              bestArc = candidate;
            }
          });
      });
    });
    if (bestArc) {
      splineMetric = bestArc;
      achievedMinRadius = measuredSplineRadius(splineMetric);
      usedCircularArc = true;
    }
  }
  let cur = splineMetric.map((p) => [
    origin[0] + p[0] / mx,
    origin[1] + p[1] / my,
  ]);
  let smoothCum = [0];
  for (let i = 1; i < cur.length; i += 1)
    smoothCum.push(smoothCum[i - 1] + distanceMeters(cur[i - 1], cur[i]));
  let smoothTotal = smoothCum[smoothCum.length - 1];
  let outputStep = smoothTotal / Math.max(1, cur.length - 1);
  const directionRadiusM = Math.max(minRadius, minDetail * 2);
  const baseHalf = Math.max(
    1,
    Math.round(Math.max(60, minDetail * 0.18) / Math.max(1, outputStep)),
  );
  let angles = cur.map((_, i) => {
    const a = cur[Math.max(0, i - baseHalf)];
    const b = cur[Math.min(cur.length - 1, i + baseHalf)];
    return Math.atan2(b[1] - a[1], (b[0] - a[0]) * coslat);
  });
  // Unwrap before smoothing. Averaging unit vectors is unstable at a U-turn:
  // two nearly opposite vectors cancel and their normalized result can jump
  // tens of degrees between adjacent samples. A continuous scalar angle has
  // no such zero-vector singularity.
  for (let i = 1; i < angles.length; i += 1) {
    let d = angles[i] - angles[i - 1];
    while (d > Math.PI) {
      angles[i] -= 2 * Math.PI;
      d -= 2 * Math.PI;
    }
    while (d < -Math.PI) {
      angles[i] += 2 * Math.PI;
      d += 2 * Math.PI;
    }
  }
  const smoothAngles = (input, sigma) => {
    const radius = Math.max(
      3,
      Math.min(
        300,
        input.length - 1,
        Math.ceil((sigma * 3) / Math.max(1, outputStep)),
      ),
    );
    const weights = new Array(radius + 1);
    for (let k = 0; k <= radius; k += 1)
      weights[k] = Math.exp(
        -0.5 * Math.pow((k * outputStep) / sigma, 2),
      );
    return input.map((_, i) => {
      let sum = 0;
      let sw = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const w = weights[Math.abs(k)];
        const j = Math.max(0, Math.min(input.length - 1, i + k));
        sum += input[j] * w;
        sw += w;
      }
      return sum / sw;
    });
  };
  const directionSigmaM = Math.max(80, minDetail * 0.45, minRadius * 0.12);
  angles = smoothAngles(angles, directionSigmaM);
  angles = smoothAngles(angles, directionSigmaM * 0.65);
  const maxTurn = Math.min(
    0.045,
    Math.max(1e-5, outputStep / Math.max(100, minRadius)),
  );
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 1; i < angles.length; i += 1)
      angles[i] = Math.max(
        angles[i - 1] - maxTurn,
        Math.min(angles[i - 1] + maxTurn, angles[i]),
      );
    for (let i = angles.length - 2; i >= 0; i -= 1)
      angles[i] = Math.max(
        angles[i + 1] - maxTurn,
        Math.min(angles[i + 1] + maxTurn, angles[i]),
      );
  }

  // Reconstruct the displayed geometry from the radius-limited direction
  // field. A linear endpoint correction is distributed over the whole arc,
  // so both physical corridor ends remain exact without concentrating the
  // correction into a station-side hook. This makes the debug curve and the
  // hover direction use the same rounded path instead of merely smoothing
  // the direction sampled from a tighter geometric bend.
  const segmentLengths = new Array(splineMetric.length - 1);
  for (let i = 0; i < segmentLengths.length; i += 1)
    segmentLengths[i] = Math.hypot(
      splineMetric[i + 1][0] - splineMetric[i][0],
      splineMetric[i + 1][1] - splineMetric[i][1],
    );
  const integrated = new Array(splineMetric.length);
  integrated[0] = splineMetric[0].slice();
  for (let i = 1; i < integrated.length; i += 1) {
    const a = (angles[i - 1] + angles[i]) / 2;
    integrated[i] = [
      integrated[i - 1][0] + Math.cos(a) * segmentLengths[i - 1],
      integrated[i - 1][1] + Math.sin(a) * segmentLengths[i - 1],
    ];
  }
  const endDrift = [
    splineMetric[splineMetric.length - 1][0] -
      integrated[integrated.length - 1][0],
    splineMetric[splineMetric.length - 1][1] -
      integrated[integrated.length - 1][1],
  ];
  for (let i = 1; i < integrated.length; i += 1) {
    const t = i / (integrated.length - 1);
    integrated[i][0] += endDrift[0] * t;
    integrated[i][1] += endDrift[1] * t;
  }
  const integratedRadius = measuredSplineRadius(integrated);
  if (integratedRadius >= achievedMinRadius) {
    splineMetric = integrated;
    achievedMinRadius = integratedRadius;
    cur = splineMetric.map((p) => [
      origin[0] + p[0] / mx,
      origin[1] + p[1] / my,
    ]);
    smoothCum = [0];
    for (let i = 1; i < cur.length; i += 1)
      smoothCum.push(
        smoothCum[i - 1] + distanceMeters(cur[i - 1], cur[i]),
      );
    smoothTotal = smoothCum[smoothCum.length - 1];
    outputStep = smoothTotal / Math.max(1, cur.length - 1);
  }
  let achievedDirectionRadius = Infinity;
  for (let i = 1; i < angles.length; i += 1) {
    const turn = Math.abs(angles[i] - angles[i - 1]);
    if (turn > 1e-9)
      achievedDirectionRadius = Math.min(
        achievedDirectionRadius,
        (smoothCum[i] - smoothCum[i - 1]) / turn,
      );
  }
  const deviation = validateFittedCurveDeviation(cur, [line], maxDeviation);
  if (
    !deviation.valid ||
    achievedMinRadius < requestedMinRadius * 0.999 ||
    achievedDirectionRadius < requestedMinRadius * 0.999
  )
    return null;

  // Precision affects only this final representation.  All solving, fallback
  // decisions and hard validation above used the fixed `solveN` geometry.
  const displayN = Math.max(
    20,
    Math.min(3200, Math.ceil(smoothTotal / (30 / precision)) + 1),
  );
  let outputPoints = cur;
  let outputAngles = angles;
  let outputCum = smoothCum;
  if (displayN !== cur.length) {
    outputPoints = new Array(displayN);
    outputAngles = new Array(displayN);
    let sourceIndex = 0;
    for (let i = 0; i < displayN; i += 1) {
      const target = (smoothTotal * i) / (displayN - 1);
      while (
        sourceIndex + 1 < smoothCum.length - 1 &&
        smoothCum[sourceIndex + 1] < target
      )
        sourceIndex += 1;
      const span = smoothCum[sourceIndex + 1] - smoothCum[sourceIndex] || 1;
      const t = Math.max(0, Math.min(1, (target - smoothCum[sourceIndex]) / span));
      const a = cur[sourceIndex];
      const b = cur[sourceIndex + 1];
      outputPoints[i] = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
      ];
      outputAngles[i] =
        angles[sourceIndex] + (angles[sourceIndex + 1] - angles[sourceIndex]) * t;
    }
    outputCum = [0];
    for (let i = 1; i < outputPoints.length; i += 1)
      outputCum.push(
        outputCum[i - 1] + distanceMeters(outputPoints[i - 1], outputPoints[i]),
      );
  }
  let finalDeviation = validateFittedCurveDeviation(
    outputPoints,
    [line],
    maxDeviation,
  );
  const outputMetric = outputPoints.map((p) => [
    (p[0] - origin[0]) * mx,
    (p[1] - origin[1]) * my,
  ]);
  let finalAchievedMinRadius = measuredSplineRadius(outputMetric);
  let finalAchievedDirectionRadius = Infinity;
  for (let i = 1; i < outputAngles.length; i += 1) {
    const turn = Math.abs(outputAngles[i] - outputAngles[i - 1]);
    if (turn > 1e-9)
      finalAchievedDirectionRadius = Math.min(
        finalAchievedDirectionRadius,
        (outputCum[i] - outputCum[i - 1]) / turn,
      );
  }
  if (
    !finalDeviation.valid ||
    finalAchievedMinRadius < requestedMinRadius * 0.999 ||
    finalAchievedDirectionRadius < requestedMinRadius * 0.999
  ) {
    // A low-density representation may replace a validated bend with a chord.
    // Hard invariants win over the requested debug/output density: retain the
    // fixed-resolution solution instead of publishing an invalid polyline.
    outputPoints = cur;
    outputAngles = angles;
    outputCum = smoothCum;
    finalDeviation = deviation;
    finalAchievedMinRadius = achievedMinRadius;
    finalAchievedDirectionRadius = achievedDirectionRadius;
  }
  const dirs = outputAngles.map((a) => [Math.cos(a), Math.sin(a)]);
  return {
    pts: outputPoints,
    cum: outputCum,
    dirs,
    totalMeters: outputCum[outputCum.length - 1],
    sourceTotalMeters: total,
    endpointChordMeters: Math.hypot(
      anchorMetric[anchorMetric.length - 1][0] - anchorMetric[0][0],
      anchorMetric[anchorMetric.length - 1][1] - anchorMetric[0][1],
    ),
    radiusMeters: directionRadiusM,
    smoothingSigmaMeters: sigmaM,
    directionSigmaMeters: directionSigmaM,
    requestedMinRadiusMeters: requestedMinRadius,
    achievedMinRadiusMeters: isFinite(finalAchievedMinRadius)
      ? finalAchievedMinRadius
      : null,
    achievedDirectionRadiusMeters: isFinite(finalAchievedDirectionRadius)
      ? finalAchievedDirectionRadius
      : null,
    minDetailMeters: minDetail,
    maxDeviationMeters: maxDeviation,
    actualMaxDeviationMeters: finalDeviation.maxDeviationMeters,
    samplingPrecision: precision,
    fitType: usedCircularArc ? "circular-arc" : "cubic-bspline-c2",
    coslat,
    _sourceLines: [line],
  };
}

function smoothStandaloneCorridorRun(line, isClosed) {
  return isClosed ? null : smoothCorridorCurve(line);
}

function fittedCurvePointAt(curve, metres) {
  const pts = curve && curve.pts;
  const cum = curve && curve.cum;
  if (!pts || pts.length < 2 || !cum || cum.length !== pts.length) return null;
  const target = Math.max(0, Math.min(curve.totalMeters || 0, metres));
  let lo = 0;
  let hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = cum[lo + 1] - cum[lo] || 1;
  const t = Math.max(0, Math.min(1, (target - cum[lo]) / span));
  return [
    pts[lo][0] + (pts[lo + 1][0] - pts[lo][0]) * t,
    pts[lo][1] + (pts[lo + 1][1] - pts[lo][1]) * t,
  ];
}

// Recalculate the arc-length and tangent fields after a station fillet has
// replaced one end of a fitted curve.  The endpoint tangent is overwritten by
// smoothCurveStationJoins with the exact shared Bezier derivative afterwards.
function refreshFittedCurveGeometry(curve) {
  const pts = curve.pts;
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1)
    cum.push(cum[i - 1] + distanceMeters(pts[i - 1], pts[i]));
  curve.cum = cum;
  curve.totalMeters = cum[cum.length - 1];
  const step = curve.totalMeters / Math.max(1, pts.length - 1);
  const tangentHalf = Math.max(
    1,
    Math.min(
      Math.floor((pts.length - 1) / 5),
      Math.round(
        Math.max(80, (curve.minDetailMeters || 3300) * 0.18) /
          Math.max(1, step),
      ),
    ),
  );
  const cs = curve.coslat || 1;
  curve.dirs = pts.map((_, i) => {
    const a = pts[Math.max(0, i - tangentHalf)];
    const b = pts[Math.min(pts.length - 1, i + tangentHalf)];
    const dx = (b[0] - a[0]) * cs;
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  });

  // Keep the global diagnostics honest after changing the displayed curve.
  const radiusHalf = Math.max(
    1,
    Math.min(
      Math.floor((pts.length - 1) / 5),
      Math.round(
        Math.max(50, Math.min(180, (curve.minDetailMeters || 3300) * 0.04)) /
          Math.max(1, step),
      ),
    ),
  );
  let minRadius = Infinity;
  for (let i = radiusHalf; i < pts.length - radiusHalf; i += 1) {
    const a = pts[i - radiusHalf];
    const b = pts[i];
    const c = pts[i + radiusHalf];
    const ax = a[0] * cs * 111320;
    const ay = a[1] * 110540;
    const bx = b[0] * cs * 111320;
    const by = b[1] * 110540;
    const cx = c[0] * cs * 111320;
    const cy = c[1] * 110540;
    const ab = Math.hypot(bx - ax, by - ay);
    const bc = Math.hypot(cx - bx, cy - by);
    const ca = Math.hypot(ax - cx, ay - cy);
    const cross = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    const radius = cross < 1e-6 ? Infinity : (ab * bc * ca) / (2 * cross);
    minRadius = Math.min(minRadius, radius);
  }
  curve.achievedMinRadiusMeters = isFinite(minRadius) ? minRadius : null;
  let maxTurn = 0;
  let previous = null;
  curve.dirs.forEach((d) => {
    let angle = Math.atan2(d[1], d[0]);
    if (previous != null) {
      while (angle - previous > Math.PI) angle -= 2 * Math.PI;
      while (angle - previous < -Math.PI) angle += 2 * Math.PI;
      maxTurn = Math.max(maxTurn, Math.abs(angle - previous));
    }
    previous = angle;
  });
  curve.achievedDirectionRadiusMeters = maxTurn > 1e-9 ? step / maxTurn : null;
}

// Station smoothing changes geometry after the original direction solve.  Run
// the same essential angle pipeline again so `dirs` remains a hard-validated
// output rather than an unchecked finite-difference diagnostic.
function rebuildLimitedDirectionField(curve) {
  const pts = curve && curve.pts;
  if (!pts || pts.length < 2) return false;
  const cum = curve.cum;
  const total = curve.totalMeters || 0;
  const step = total / Math.max(1, pts.length - 1);
  const minRadius = Math.max(100, curve.requestedMinRadiusMeters || 3100);
  const minDetail = Math.max(20, curve.minDetailMeters || 3300);
  const half = Math.max(
    1,
    Math.min(
      Math.floor((pts.length - 1) / 5),
      Math.round(Math.max(60, minDetail * 0.18) / Math.max(1, step)),
    ),
  );
  const cs = curve.coslat || 1;
  let angles = pts.map((_, i) => {
    const a = pts[Math.max(0, i - half)];
    const b = pts[Math.min(pts.length - 1, i + half)];
    return Math.atan2(b[1] - a[1], (b[0] - a[0]) * cs);
  });
  for (let i = 1; i < angles.length; i += 1) {
    while (angles[i] - angles[i - 1] > Math.PI) angles[i] -= 2 * Math.PI;
    while (angles[i] - angles[i - 1] < -Math.PI) angles[i] += 2 * Math.PI;
  }
  const smooth = (input, sigma) => {
    const radius = Math.max(
      2,
      Math.min(
        300,
        input.length - 1,
        Math.ceil((sigma * 3) / Math.max(1, step)),
      ),
    );
    const weights = new Array(radius + 1);
    for (let k = 0; k <= radius; k += 1)
      weights[k] = Math.exp(-0.5 * Math.pow((k * step) / sigma, 2));
    return input.map((_, i) => {
      let sum = 0;
      let weight = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const w = weights[Math.abs(k)];
        sum += input[Math.max(0, Math.min(input.length - 1, i + k))] * w;
        weight += w;
      }
      return sum / weight;
    });
  };
  const sigma = Math.max(80, minDetail * 0.45, minRadius * 0.12);
  angles = smooth(angles, sigma);
  angles = smooth(angles, sigma * 0.65);
  const limitedRadius = minRadius * 1.03;
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 1; i < angles.length; i += 1) {
      const maxTurn = Math.min(
        0.045,
        Math.max(1e-6, (cum[i] - cum[i - 1]) / limitedRadius),
      );
      angles[i] = Math.max(
        angles[i - 1] - maxTurn,
        Math.min(angles[i - 1] + maxTurn, angles[i]),
      );
    }
    for (let i = angles.length - 2; i >= 0; i -= 1) {
      const maxTurn = Math.min(
        0.045,
        Math.max(1e-6, (cum[i + 1] - cum[i]) / limitedRadius),
      );
      angles[i] = Math.max(
        angles[i + 1] - maxTurn,
        Math.min(angles[i + 1] + maxTurn, angles[i]),
      );
    }
  }
  let achieved = Infinity;
  for (let i = 1; i < angles.length; i += 1) {
    const turn = Math.abs(angles[i] - angles[i - 1]);
    if (turn > 1e-9)
      achieved = Math.min(achieved, (cum[i] - cum[i - 1]) / turn);
  }
  curve.dirs = angles.map((a) => [Math.cos(a), Math.sin(a)]);
  curve.directionSigmaMeters = sigma;
  curve.achievedDirectionRadiusMeters = isFinite(achieved) ? achieved : null;
  return !isFinite(achieved) || achieved >= minRadius * 0.999;
}

// Different overlap memberships often end at the same station as separate
// fitted curves.  Even though each curve is C2 internally, pinning both ends
// to that station leaves a hard change of tangent between them.  Pair the
// straightest compatible ends at every station and replace several kilometres
// on both sides with ONE cubic Bezier fillet.  The Bezier is split between the
// two curves at its closest point to the station, so the direction is exactly
// continuous while the fitted path may cut gently inside the source corner.
// The member curves are already densely sampled, radius-limited splines.  A
// physical Gaussian pass over their concatenated points is enough to remove
// only the new station seams, and is much cheaper than running the complete
// source-fitting solver again over a corridor hundreds of kilometres long.
function smoothJoinedStationCurve(source, template, sourceLines) {
  if (!source || source.length < 4) return null;
  const lat0 = source.reduce((sum, p) => sum + p[1], 0) / source.length;
  const coslat = Math.cos((lat0 * Math.PI) / 180) || 1e-6;
  const mx = 111320 * coslat;
  const my = 110540;
  const origin = source[0];
  const metricSource = source.map((p) => [
    (p[0] - origin[0]) * mx,
    (p[1] - origin[1]) * my,
  ]);
  let total = 0;
  for (let i = 1; i < metricSource.length; i += 1)
    total += Math.hypot(
      metricSource[i][0] - metricSource[i - 1][0],
      metricSource[i][1] - metricSource[i - 1][1],
    );
  const step = total / Math.max(1, metricSource.length - 1);
  const minRadius = template.requestedMinRadiusMeters || 3100;
  const minDetail = template.minDetailMeters || 3300;
  const sigma = Math.max(500, minDetail * 0.9, minRadius * 0.65);
  const boxPass = (input, radius) => {
    radius = Math.max(1, Math.min(input.length - 1, radius));
    const n = input.length;
    const extended = new Array(n + radius * 2);
    const edgeSpan = Math.min(n - 1, Math.max(3, radius));
    const startDx = (input[edgeSpan][0] - input[0][0]) / edgeSpan;
    const startDy = (input[edgeSpan][1] - input[0][1]) / edgeSpan;
    const last = n - 1;
    const endDx = (input[last][0] - input[last - edgeSpan][0]) / edgeSpan;
    const endDy = (input[last][1] - input[last - edgeSpan][1]) / edgeSpan;
    for (let i = -radius; i < n + radius; i += 1) {
      if (i < 0)
        extended[i + radius] = [
          input[0][0] + startDx * i,
          input[0][1] + startDy * i,
        ];
      else if (i > last) {
        const d = i - last;
        extended[i + radius] = [
          input[last][0] + endDx * d,
          input[last][1] + endDy * d,
        ];
      } else extended[i + radius] = input[i];
    }
    const prefixX = new Float64Array(extended.length + 1);
    const prefixY = new Float64Array(extended.length + 1);
    for (let i = 0; i < extended.length; i += 1) {
      prefixX[i + 1] = prefixX[i] + extended[i][0];
      prefixY[i + 1] = prefixY[i] + extended[i][1];
    }
    const width = radius * 2 + 1;
    return input.map((_, i) => [
      (prefixX[i + width] - prefixX[i]) / width,
      (prefixY[i + width] - prefixY[i]) / width,
    ]);
  };
  // Three equal box passes approximate a Gaussian with sigma ~= radius.  The
  // prefix-sum implementation is O(n), so a nationwide joined corridor no
  // longer performs tens of millions of per-sample weight operations.
  const boxRadius = Math.max(
    2,
    Math.min(metricSource.length - 1, 260, Math.ceil(sigma / Math.max(1, step))),
  );
  let metric = boxPass(metricSource, boxRadius);
  metric = boxPass(metric, boxRadius);
  metric = boxPass(metric, boxRadius);
  const curve = {
    ...template,
    coslat,
    smoothingSigmaMeters: sigma,
    fitType: "cubic-bspline-c2-station-continuous",
  };
  curve.sourceTotalMeters = total;
  curve.endpointChordMeters = Math.hypot(
    metricSource[metricSource.length - 1][0] - metricSource[0][0],
    metricSource[metricSource.length - 1][1] - metricSource[0][1],
  );
  // Some newly joined near-parallel corridors contain a sharper station
  // throat than either source curve had alone. Continue the same physical
  // low-pass until the displayed centreline also satisfies the requested
  // minimum radius; this preserves the no-sudden-turn guarantee after adding
  // the new overlap membership.
  let passCount = 3;
  while (true) {
    // Whole-chain smoothing must never move the two physical terminal ends.
    metric[0] = metricSource[0].slice();
    metric[metric.length - 1] = metricSource[metricSource.length - 1].slice();
    curve.pts = metric.map((p) => [
      origin[0] + p[0] / mx,
      origin[1] + p[1] / my,
    ]);
    refreshFittedCurveGeometry(curve);
    if (
      curve.achievedMinRadiusMeters == null ||
      curve.achievedMinRadiusMeters >= minRadius * 0.999 ||
      passCount >= 12
    )
      break;
    metric = boxPass(metric, boxRadius);
    passCount += 1;
  }
  const rawSources = (sourceLines || template._sourceLines || []).filter(Boolean);
  const deviation = validateFittedCurveDeviation(
    curve.pts,
    rawSources,
    curve.maxDeviationMeters,
  );
  curve.actualMaxDeviationMeters = deviation.maxDeviationMeters;
  curve._sourceLines = rawSources;
  curve._finalDeviationValid = deviation.valid;
  curve._finalDirectionValid = rebuildLimitedDirectionField(curve);
  curve.stationSmoothingPasses = passCount;
  return curve;
}

// Build the direction field across station boundaries as one continuous
// corridor.  A membership change still remains a separate hover group, but it
// no longer forces the fitted direction curve to stop at the station.  The
// straightest compatible continuation wins at junctions; then the complete
// multi-group chain is fitted once, making every former station boundary an
// interior C2 point instead of two independently pinned endpoints.
function smoothCurveStationJoins(groupInfo) {
  if (!groupInfo || groupInfo.size < 2) return 0;
  const owners = new Map();
  groupInfo.forEach((gi, groupKey) => {
    const curve = gi && gi.curve;
    if (!curve || !curve.pts || curve.pts.length < 4) return;
    let list = owners.get(curve);
    if (!list) owners.set(curve, (list = []));
    list.push({ gi, groupKey });
  });
  const curves = [...owners.keys()];
  const ends = [];
  curves.forEach((curve, curveIndex) => {
    const trainIds = new Set();
    (owners.get(curve) || []).forEach(({ gi }) => {
      Object.keys((gi && gi.mults) || {}).forEach((id) => trainIds.add(id));
    });
    [0, 1].forEach((side) => {
      const p = side === 0 ? curve.pts[0] : curve.pts[curve.pts.length - 1];
      const probeM = Math.min(450, Math.max(100, curve.totalMeters * 0.03));
      const q = fittedCurvePointAt(
        curve,
        side === 0 ? probeM : curve.totalMeters - probeM,
      );
      if (!q) return;
      const cs = Math.cos((p[1] * Math.PI) / 180) || 1e-6;
      const dx = (q[0] - p[0]) * cs;
      const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) return;
      ends.push({
        id: curveIndex + "::" + side,
        curve,
        curveIndex,
        side,
        p,
        outward: [dx / len, dy / len],
        trainIds,
      });
    });
  });

  const candidates = [];
  for (let i = 0; i < ends.length; i += 1)
    for (let j = i + 1; j < ends.length; j += 1) {
      const a = ends[i];
      const b = ends[j];
      if (a.curve === b.curve) continue;
      let sharedTrains = 0;
      a.trainIds.forEach((id) => {
        if (b.trainIds.has(id)) sharedTrains += 1;
      });
      if (!sharedTrains) continue;
      const metres = distanceMeters(a.p, b.p);
      // Geometry-only station matching is a fallback (the fitted curves do
      // not carry stable station ids), so keep it deliberately conservative.
      // Long gaps are accepted only when the continuation is almost straight.
      if (metres > 120) continue;
      const continuationDot = Math.max(
        -1,
        Math.min(1, -(a.outward[0] * b.outward[0] + a.outward[1] * b.outward[1])),
      );
      const turn = Math.acos(continuationDot);
      if (turn > (60 * Math.PI) / 180) continue;
      if (metres > 40 && turn > (25 * Math.PI) / 180) continue;
      candidates.push({
        a,
        b,
        metres,
        turn,
        sharedTrains,
        score: turn * 1200 + metres - Math.min(5, sharedTrains) * 4,
      });
  }
  candidates.sort((a, b) => a.score - b.score);
  const connections = new Map();
  const connect = (end, other, meta) => {
    let sides = connections.get(end.curve);
    if (!sides) connections.set(end.curve, (sides = new Map()));
    sides.set(end.side, { end: other, meta });
  };
  selectOneToOneEndpointPairs(candidates, 50).forEach((candidate) => {
    connect(candidate.a, candidate.b, candidate);
    connect(candidate.b, candidate.a, candidate);
  });

  const visited = new Set();
  let roundedJoins = 0;
  const components = [];
  const walk = (start, reverseStart) => {
    const component = [];
    let curve = start;
    let reverse = reverseStart;
    while (curve && !visited.has(curve)) {
      visited.add(curve);
      component.push({ curve, reverse });
      const exitSide = reverse ? 0 : 1;
      const edge = (connections.get(curve) || new Map()).get(exitSide);
      if (!edge || visited.has(edge.end.curve)) break;
      curve = edge.end.curve;
      // Entering native side 1 means the next curve must be reversed so that
      // this connected endpoint becomes the start of its oriented points.
      reverse = edge.end.side === 1;
    }
    if (component.length > 1) components.push(component);
  };
  curves.forEach((curve) => {
    if (visited.has(curve)) return;
    const sides = connections.get(curve);
    if (!sides || sides.size !== 1) return;
    const connectedSide = [...sides.keys()][0];
    walk(curve, connectedSide === 0);
  });
  // A cycle needs a periodic solver.  Do not silently cut it at an arbitrary
  // edge and feed it to the open-chain station smoother.
  curves.forEach((curve) => {
    if (!visited.has(curve) && connections.has(curve)) visited.add(curve);
  });

  components.forEach((component) => {
    const source = [];
    let worstOriginalTurn = 0;
    let worstGap = 0;
    component.forEach(({ curve, reverse }, index) => {
      const pts = reverse ? curve.pts.slice().reverse() : curve.pts;
      pts.forEach((p) => {
        if (!source.length || distanceMeters(source[source.length - 1], p) > 0.05)
          source.push(p);
      });
      if (index < component.length - 1) {
        const exitSide = reverse ? 0 : 1;
        const edge = (connections.get(curve) || new Map()).get(exitSide);
        if (edge) {
          worstOriginalTurn = Math.max(worstOriginalTurn, edge.meta.turn);
          worstGap = Math.max(worstGap, edge.meta.metres);
        }
      }
    });
    if (source.length < 4) return;
    const rawSources = [];
    component.forEach(({ curve }) => {
      (curve._sourceLines || []).forEach((line) => rawSources.push(line));
    });
    const fitted = smoothJoinedStationCurve(
      source,
      component[0].curve,
      rawSources,
    );
    if (!fitted) return;
    // A folded/looping component can be geometrically unable to satisfy both
    // the requested radius and deviation budget as one station-continuous
    // curve. Keep its already-valid member splines separate instead of
    // replacing them with a tighter or far-away curve; the hover transition
    // animator still interpolates their endpoint directions.
    if (
      (fitted.achievedMinRadiusMeters != null &&
        fitted.achievedMinRadiusMeters <
          fitted.requestedMinRadiusMeters * 0.999) ||
      (fitted.maxDeviationMeters > 0 &&
        (!fitted._finalDeviationValid ||
          fitted.actualMaxDeviationMeters > fitted.maxDeviationMeters)) ||
      !fitted._finalDirectionValid ||
      (fitted.achievedDirectionRadiusMeters != null &&
        fitted.achievedDirectionRadiusMeters <
          fitted.requestedMinRadiusMeters * 0.999)
    )
      return;
    fitted.stationJoinCount = component.length - 1;
    fitted.stationJoinOriginalMaxDeg = +(
      (worstOriginalTurn * 180) /
      Math.PI
    ).toFixed(2);
    fitted.stationJoinMaxGapMeters = +worstGap.toFixed(1);
    fitted.fitType = "cubic-bspline-c2-station-continuous";
    component.forEach(({ curve }) => {
      (owners.get(curve) || []).forEach(({ gi }) => {
        gi.curve = fitted;
      });
    });
    roundedJoins += component.length - 1;
  });
  return roundedJoins;
}
