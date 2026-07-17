// =========================================================================
//  app-route-simplify.js — §5: route-geometry simplification (Douglas-Peucker pre-render decimation)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §5.  Route-geometry simplification (Douglas-Peucker pre-render decimation)
// =========================================================================

// --- Route geometry simplification (pre-render decimation) -----------------
// The N02 source geometry is survey-grade: ~50 m median vertex spacing (down
// to <1 m at segment joins / curves), so a stitched route carries thousands
// of points that are visually redundant. We run Douglas-Peucker ONCE per
// route feature (cached), before the geometry is handed to the renderer, to
// drop the redundant vertices while preserving shape. On the real routes,
// an 8 m tolerance removes ~83% of points with <=8 m deviation (sub-pixel at
// country zoom, ~1 px at city zoom). Tunable via ?simplify=<meters> in the
// URL; ?simplify=0 disables it for an A/B comparison.
const ROUTE_SIMPLIFY_METERS = (function () {
  try {
    const m = /[?&]simplify=(\d+(?:\.\d+)?)/.exec(location.search);
    if (m) return Number(m[1]);
  } catch (e) {
    /* no location — use default */
  }
  return 8;
})();

// Short single-train slivers inside an otherwise identical overlap membership
// are closed before records are split.  This handles an extra/missing graph
// vertex without allowing a real route divergence to inherit the old fan.
const OVERLAP_BRIDGE_MAX_METERS = (function () {
  try {
    const m = /[?&]bridge=(\d+(?:\.\d+)?)/.exec(location.search);
    if (m) return Number(m[1]);
  } catch (e) {
    /* no location — use default */
  }
  return 140;
})();

// Separate route features often stop a few metres either side of the same
// station/graph join.  Exact segment keys cannot describe the empty interval,
// so join compatible overlap runs geometrically and add an invisible pick
// connector.  This is deliberately much shorter than a station-to-station
// section and requires matching membership plus tangent continuity.
const OVERLAP_CORRIDOR_JOIN_METERS = (function () {
  try {
    const m = /[?&]join=(\d+(?:\.\d+)?)/.exec(location.search);
    if (m) return Number(m[1]);
  } catch (e) {
    /* no location — use default */
  }
  return 120;
})();

// Perpendicular distance (metres) from point p to segment a-b, using a local
// equirectangular scaling (longitude compressed by cos(latitude)).
function perpDistanceMeters(p, a, b, sx, sy) {
  const px = p[0] * sx,
    py = p[1] * sy;
  const ax = a[0] * sx,
    ay = a[1] * sy;
  const bx = b[0] * sx,
    by = b[1] * sy;
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Iterative (stack-based) Douglas-Peucker. epsilon is in metres. Returns the
// ASCENDING ORIGINAL INDICES of the kept vertices (both ends always kept), so
// callers can correlate every simplified vertex back to the source geometry.
function douglasPeuckerIndices(points, epsilonMeters) {
  const n = points ? points.length : 0;
  if (n < 3 || epsilonMeters <= 0) {
    const all = new Array(n);
    for (let i = 0; i < n; i += 1) all[i] = i;
    return all;
  }
  const sx = 111320 * Math.cos(((points[0][1] || 0) * Math.PI) / 180);
  const sy = 111320;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const seg = stack.pop();
    const s = seg[0],
      e = seg[1];
    let maxD = -1,
      idx = -1;
    for (let i = s + 1; i < e; i += 1) {
      const d = perpDistanceMeters(points[i], points[s], points[e], sx, sy);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > epsilonMeters && idx !== -1) {
      keep[idx] = 1;
      stack.push([s, idx]);
      stack.push([idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) out.push(i);
  return out;
}

// Tolerance for canonicalising route vertices before overlap keys are built.
// It is intentionally sub-track-width: only graph-coordinate jitter is
// absorbed; genuinely parallel tracks remain separate.
const OVERLAP_SNAP_METERS = (function () {
  try {
    const m = /[?&]snap=(\d+(?:\.\d+)?)/.exec(location.search);
    if (m) return Number(m[1]);
  } catch (e) {
    /* no location — use default */
  }
  return 2.5;
})();

// Visually adjacent railway alignments can form one interaction corridor even
// when they are different N02 tracks (for example the conventional JR line and
// the Hokuriku Shinkansen south of Nagano). Keep this tolerance physical and
// zoom-independent: it describes track-to-track separation, not screen pixels.
// Direction + longitudinal-overlap checks below prevent crossings and nearby
// but unrelated end-to-end segments from being merged.
const OVERLAP_NEAR_PARALLEL_METERS = (function () {
  try {
    const m = /[?&]nearoverlap=(\d+(?:\.\d+)?)/.exec(location.search);
    if (m) return Number(m[1]);
  } catch (e) {
    /* no location — use default */
  }
  return 120;
})();

const OVERLAP_NEAR_PARALLEL_COS = Math.cos((20 * Math.PI) / 180);

function pointSegmentDistanceXY(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Return the separation of two genuinely side-by-side segments, or null when
// they merely cross, point towards one another, or have no longitudinal
// overlap. Coordinates are projected into a local metre plane for the test.
function nearParallelSegmentSeparation(a0, a1, b0, b1, maxMeters) {
  const lat = (a0[1] + a1[1] + b0[1] + b1[1]) / 4;
  const sx = 111320 * (Math.cos((lat * Math.PI) / 180) || 1e-6);
  const sy = 111320;
  const ax = a0[0] * sx;
  const ay = a0[1] * sy;
  const bx = a1[0] * sx;
  const by = a1[1] * sy;
  const cx = b0[0] * sx;
  const cy = b0[1] * sy;
  const dx = b1[0] * sx;
  const dy = b1[1] * sy;
  const avx = bx - ax;
  const avy = by - ay;
  const bvx = dx - cx;
  const bvy = dy - cy;
  const al = Math.hypot(avx, avy);
  const bl = Math.hypot(bvx, bvy);
  if (al < 1 || bl < 1) return null;
  const aux = avx / al;
  const auy = avy / al;
  const bux = bvx / bl;
  const buy = bvy / bl;
  if (Math.abs(aux * bux + auy * buy) < OVERLAP_NEAR_PARALLEL_COS)
    return null;

  // Both projection tests are required. They reject two collinear segments
  // whose endpoints are close but whose actual intervals do not run beside
  // one another.
  const bProj0 = (cx - ax) * aux + (cy - ay) * auy;
  const bProj1 = (dx - ax) * aux + (dy - ay) * auy;
  const overlapA =
    Math.min(al, Math.max(bProj0, bProj1)) -
    Math.max(0, Math.min(bProj0, bProj1));
  const aProj0 = (ax - cx) * bux + (ay - cy) * buy;
  const aProj1 = (bx - cx) * bux + (by - cy) * buy;
  const overlapB =
    Math.min(bl, Math.max(aProj0, aProj1)) -
    Math.max(0, Math.min(aProj0, aProj1));
  const requiredOverlap = Math.max(
    0.75,
    Math.min(6, Math.min(al, bl) * 0.15),
  );
  if (overlapA < requiredOverlap || overlapB < requiredOverlap) return null;

  const separation = Math.min(
    pointSegmentDistanceXY(ax, ay, cx, cy, dx, dy),
    pointSegmentDistanceXY(bx, by, cx, cy, dx, dy),
    pointSegmentDistanceXY(cx, cy, ax, ay, bx, by),
    pointSegmentDistanceXY(dx, dy, ax, ay, bx, by),
  );
  return separation <= maxMeters ? separation : null;
}

// Shared vertex canonicaliser, rebuilt per overlap pass (refreshRouteVertexSnap
// from buildDeckOverlapMap). `_routeVertexSnap(coord)` returns the canonical
// representative [lon,lat] for coord's ~OVERLAP_SNAP_METERS neighbourhood; the
// first vertex seen in a neighbourhood becomes its representative (deterministic
// for a given item order). The version counter invalidates getRouteLinePairs'
// per-feature segKey cache when the snap map is rebuilt.
let _routeVertexSnap = null;
let _routeVertexSnapVer = 0;

function refreshRouteVertexSnap(items, tolMeters) {
  _routeVertexSnapVer += 1;
  const tol = tolMeters > 0 ? tolMeters : 0;
  if (!tol) {
    _routeVertexSnap = null;
    return;
  }
  const mLat = 110540; // metres per degree latitude (mean)
  const gridLon = 80000; // stable Japan-wide grid; distance check stays exact
  const cells = new Map(); // "gx,gy" -> array of representative [lon,lat]
  const mLonAt = (lat) => Math.cos((lat * Math.PI) / 180) * 111320;
  const tol2 = tol * tol; // squared-metre compare, avoiding Math.hypot's sqrt
  const canon = (c) => {
    // Never multiply absolute longitude by a latitude-dependent scale here:
    // doing so moves the grid itself as latitude changes and can put two
    // sub-metre neighbours several cells apart.
    const gx = Math.floor((c[0] * gridLon) / tol);
    const gy = Math.floor((c[1] * mLat) / tol);
    // The longitude->metre scale is fixed for this query's latitude, so take the
    // cosine ONCE here instead of once per candidate inside the scan. Keep the
    // dx in [-2,2] span: north of ~44 deg a cell is narrower than the tolerance
    // (gridLon > mLonAt), so a within-tol match can sit two cells away. The
    // squared-distance test is the exact equivalent of Math.hypot(...) <= tol.
    const mx = mLonAt(c[1]);
    for (let dx = -2; dx <= 2; dx += 1)
      for (let dy = -1; dy <= 1; dy += 1) {
        const arr = cells.get(gx + dx + "," + (gy + dy));
        if (arr)
          for (let k = 0; k < arr.length; k += 1) {
            const ex = (c[0] - arr[k][0]) * mx;
            const ey = (c[1] - arr[k][1]) * mLat;
            if (ex * ex + ey * ey <= tol2) return arr[k];
          }
      }
    const key = gx + "," + gy;
    let arr = cells.get(key);
    if (!arr) {
      arr = [];
      cells.set(key, arr);
    }
    arr.push(c);
    return c;
  };
  // Register a representative for every vertex, in a stable order, so the whole
  // pass shares one canonical set.
  items.forEach((it) => {
    if (!it.feature) return;
    iterateGeometryLines(it.feature.geometry).forEach((line) => {
      for (let i = 0; i < line.length; i += 1) canon(line[i]);
    });
  });
  _routeVertexSnap = canon;
}

// Corridor-node identity key for a coordinate, snapped to the shared
// representative so it matches the node keys embedded in segKeys. Use this
// (not raw coordKey) anywhere a coordinate is compared ACROSS trains as an
// overlap/corridor node; keep raw orig coords for drawn geometry and vectors.
function overlapNodeKey(coord) {
  return coordKey(_routeVertexSnap ? _routeVertexSnap(coord) : coord);
}

// Route lines for a feature, computed once and cached on the feature object
// (WeakMap). Each entry pairs the ORIGINAL (normalized) line with the display
// simplification and the per-segment overlap keys:
//   orig    — the full normalized coordinate array (exact shared N02 coords),
//   keepIdx — ascending original indices Douglas-Peucker kept (null = all,
//             when ?simplify=0),
//   segKeys — routeCoordinateSegmentKey per ORIGINAL segment, built on the
//             SNAPPED endpoints (segKeys[i] is the direction-independent key of
//             orig[i]→orig[i+1]); sub-tolerance segments whose two ends snap to
//             one representative keep their true coords so the key stays
//             non-degenerate.
// Overlap detection works on `segKeys` — snapped so coincident N02 track keys
// identically across trains — while drawing uses `orig`/keepIdx. This way
// neither per-feature simplification NOR sub-metre solve jitter can fragment an
// overlap corridor (the old causes of parallel lanes breaking into pieces).
const _routeLinePairCache = new WeakMap();
function getRouteLinePairs(feature) {
  let cached = _routeLinePairCache.get(feature);
  if (cached && cached._snapVer === _routeVertexSnapVer) return cached;
  const snap = _routeVertexSnap;
  cached = iterateGeometryLines(feature.geometry).map((orig) => {
    const segKeys = new Array(Math.max(0, orig.length - 1));
    // Snap each vertex once: consecutive segments share an endpoint, so mapping
    // the whole line up front halves the canon() calls versus snapping both a
    // and b per segment. snap() is pure for the current _routeVertexSnap, so
    // each segment's endpoints are the same representatives as before.
    const snapped = snap ? orig.map((c) => snap(c)) : null;
    for (let i = 0; i < orig.length - 1; i += 1) {
      let a = orig[i];
      let b = orig[i + 1];
      if (snap) {
        const sa = snapped[i];
        const sb = snapped[i + 1];
        // Only adopt the snapped endpoints when they stay distinct; a segment
        // whose ends collapse to one representative (sub-tolerance) keeps its
        // true coords so its key can't degenerate to "P|P".
        if (sa !== sb) {
          a = sa;
          b = sb;
        }
      }
      segKeys[i] = routeCoordinateSegmentKey(a, b);
    }
    return {
      orig,
      keepIdx:
        ROUTE_SIMPLIFY_METERS > 0
          ? douglasPeuckerIndices(orig, ROUTE_SIMPLIFY_METERS)
          : null,
      segKeys,
    };
  });
  cached._snapVer = _routeVertexSnapVer;
  _routeLinePairCache.set(feature, cached);
  return cached;
}

