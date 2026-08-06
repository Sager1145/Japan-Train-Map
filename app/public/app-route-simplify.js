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

// Local-metric plane scales, shared by every equirectangular projection in
// the render/solver pipeline (this file, app-overlap-lanes.js,
// app-route-solver.js, app-deck-records.js — all page + fit-worker
// reachable, which is why they live here and not in app-core.js):
//   M_PER_DEG_LON — metres per degree of longitude AT THE EQUATOR; callers
//                   multiply by cos(lat).
//   M_PER_DEG_LAT — metres per degree of latitude (spherical mean).
// AppCore.equirectKm (stats) keeps its own documented 110.574 km scale, and
// a few historical sites in this file use M_PER_DEG_LON's value for BOTH
// axes — those are annotated in place and deliberately not "fixed", because
// changing the scale re-simplifies every cached route.
const M_PER_DEG_LON = 111320;
const M_PER_DEG_LAT = 110540;

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
  const sx = M_PER_DEG_LON * Math.cos(((points[0][1] || 0) * Math.PI) / 180);
  // Historical: lat shares the lon scale here (~0.7% overestimate, well
  // inside the tolerance slack). Not switched to M_PER_DEG_LAT — that would
  // re-decimate every route for no visible gain.
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
  const sx = M_PER_DEG_LON * (Math.cos((lat * Math.PI) / 180) || 1e-6);
  // Historical: lat shares the lon scale (see douglasPeuckerIndices).
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
  const requiredOverlap = Math.max(20, Math.min(al, bl) * 0.2);
  if (overlapA < requiredOverlap || overlapB < requiredOverlap) return null;

  // Endpoint minima classify a shallow fork as "parallel" because the two
  // segments touch at the junction.  Measure the shared longitudinal span at
  // several interior positions instead, in both segment frames.  A real
  // side-by-side pair stays close throughout the overlap; a diverging pair
  // quickly fails the maximum/median tests even if its minimum separation is
  // exactly zero.
  const separations = [];
  const sampleOverlap = (ox, oy, ux, uy, lo, hi, p0x, p0y, p1x, p1y) => {
    [0.25, 0.5, 0.75].forEach((f) => {
      const s = lo + (hi - lo) * f;
      separations.push(
        pointSegmentDistanceXY(
          ox + ux * s,
          oy + uy * s,
          p0x,
          p0y,
          p1x,
          p1y,
        ),
      );
    });
  };
  sampleOverlap(
    ax,
    ay,
    aux,
    auy,
    Math.max(0, Math.min(bProj0, bProj1)),
    Math.min(al, Math.max(bProj0, bProj1)),
    cx,
    cy,
    dx,
    dy,
  );
  sampleOverlap(
    cx,
    cy,
    bux,
    buy,
    Math.max(0, Math.min(aProj0, aProj1)),
    Math.min(bl, Math.max(aProj0, aProj1)),
    ax,
    ay,
    bx,
    by,
  );
  separations.sort((a, b) => a - b);
  const median = separations[(separations.length / 2) | 0];
  const maximum = separations[separations.length - 1];
  return median <= maxMeters && maximum <= maxMeters * 1.3 ? median : null;
}

// Shared vertex canonicaliser, rebuilt (via ensureRouteVertexSnap) only when the
// route GEOMETRY set actually changes. `_routeVertexSnap(coord)` returns the
// canonical representative [lon,lat] for coord's ~OVERLAP_SNAP_METERS
// neighbourhood; the first vertex seen in a neighbourhood becomes its
// representative (deterministic for a given item order). The version counter
// invalidates getRouteLinePairs' per-geometry segKey cache when the snap map is
// rebuilt.
let _routeVertexSnap = null;
let _routeVertexSnapVer = 0;
// Geometry signature of the item set the current snap was built from. A date
// scope / 全部 / visibility / style / ride-flag / selection change all keep the
// same route COORDINATES, so their signature is unchanged and the snap (plus
// every getRouteLinePairs segKey it stamped) is reused instead of spending
// ~0.5s re-snapping 160k vertices on each cold repaint. Coincident N02 track
// snaps to the same representative whether or not other routes are present, so
// reusing one snap across scopes yields corridor membership identical to a
// per-scope snap (verified against the per-scope build across every date).
let _routeVertexSnapSig = null;

function refreshRouteVertexSnap(items, tolMeters) {
  _routeVertexSnapVer += 1;
  const tol = tolMeters > 0 ? tolMeters : 0;
  if (!tol) {
    _routeVertexSnap = null;
    return;
  }
  const mLat = M_PER_DEG_LAT;
  const gridLon = 80000; // stable Japan-wide grid; distance check stays exact
  const cells = new Map(); // cellKey(gx,gy) -> array of representative [lon,lat]
  const mLonAt = (lat) => Math.cos((lat * Math.PI) / 180) * M_PER_DEG_LON;
  const tol2 = tol * tol; // squared-metre compare, avoiding Math.hypot's sqrt
  // NUMERIC cell keys. Each vertex probes 15 neighbouring cells, so the old
  // `gx + "," + gy` keys built ~2.7M throwaway strings per pass over a
  // full-Japan store — the single most expensive thing this function did.
  // Packing both axes into one integer is exact (and therefore
  // collision-free) as long as each axis stays inside GY_SPAN and the product
  // stays inside Number.MAX_SAFE_INTEGER; a pathologically fine tolerance
  // falls back to the string key rather than silently aliasing two cells.
  const GY_SPAN = 1 << 26;
  const GY_HALF = GY_SPAN >> 1;
  const maxGx = Math.ceil((180 * gridLon) / tol) + 4;
  const maxGy = Math.ceil((90 * mLat) / tol) + 4;
  const cellKey =
    maxGx < GY_HALF &&
    maxGy < GY_HALF &&
    maxGx * GY_SPAN + GY_SPAN < Number.MAX_SAFE_INTEGER
      ? (gx, gy) => gx * GY_SPAN + (gy + GY_HALF)
      : (gx, gy) => gx + "," + gy;
  // Every vertex is canonicalised twice — once here, once when
  // getRouteLinePairs stamps its segment keys — and coordinate arrays are
  // shared by the deduped route templates, so memoizing per coordinate object
  // turns the whole second pass (and every repeat lookup within this one)
  // into a WeakMap hit. canon() is pure for a given cell set: a repeat call
  // always found the representative the first call registered, so the memo
  // returns exactly what the scan would have.
  const memo = new WeakMap();
  const canon = (c) => {
    const seen = memo.get(c);
    if (seen !== undefined) return seen;
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
        const arr = cells.get(cellKey(gx + dx, gy + dy));
        if (arr)
          for (let k = 0; k < arr.length; k += 1) {
            const ex = (c[0] - arr[k][0]) * mx;
            const ey = (c[1] - arr[k][1]) * mLat;
            if (ex * ex + ey * ey <= tol2) {
              memo.set(c, arr[k]);
              return arr[k];
            }
          }
      }
    const key = cellKey(gx, gy);
    let arr = cells.get(key);
    if (!arr) {
      arr = [];
      cells.set(key, arr);
    }
    arr.push(c);
    memo.set(c, c);
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

// Rebuild the vertex snap only when the item set's route geometry actually
// changed. The signature is the per-train solve cacheKey (route sections +
// policy + solver version — i.e. exactly what determines the coordinates), so it
// is invariant under the far more frequent scope / visibility / style / ride /
// selection changes, letting those reuse the existing snap and its stamped
// segKeys. Rebuilds (and only then bumps _routeVertexSnapVer) when a train is
// re-solved, imported, or added/removed. buildDeckOverlapMap calls this in place
// of refreshRouteVertexSnap.
function routeVertexSnapSignature(items, tolMeters) {
  const seen = new Set();
  const tokens = [];
  for (const it of items) {
    const train = it.train;
    const id = train && train.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ctx =
      typeof buildTrainRouteSolveContext === "function"
        ? buildTrainRouteSolveContext(train)
        : null;
    tokens.push(id + "@" + (ctx ? ctx.cacheKey : "fallback"));
  }
  // Order-independent: two scopes with the same trains must share a signature
  // even when tier ordering visits them in a different order.
  tokens.sort();
  return tolMeters + "::" + tokens.join("|");
}

function ensureRouteVertexSnap(items, tolMeters) {
  const sig = routeVertexSnapSignature(items, tolMeters);
  if (sig === _routeVertexSnapSig) return;
  refreshRouteVertexSnap(items, tolMeters);
  _routeVertexSnapSig = sig;
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
// Keyed by the GEOMETRY object, not the feature wrapper: the render pipeline
// rebuilds a fresh feature object for each train on every repaint but SHARES the
// underlying geometry (the deduped route template — see dedupedRouteTemplate),
// so keying on geometry lets the snapped segKeys / Douglas-Peucker indices
// survive across repaints and scope switches. segKeys/keepIdx are a pure
// function of (geometry, snap), so two features sharing one geometry share one
// entry correctly.
const _routeLinePairCache = new WeakMap();
function getRouteLinePairs(feature) {
  const geometry = feature && feature.geometry;
  if (!geometry) return [];
  let cached = _routeLinePairCache.get(geometry);
  if (cached && cached._snapVer === _routeVertexSnapVer) return cached;
  const snap = _routeVertexSnap;
  cached = iterateGeometryLines(geometry).map((orig) => {
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
  _routeLinePairCache.set(geometry, cached);
  return cached;
}
