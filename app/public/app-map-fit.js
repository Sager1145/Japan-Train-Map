// =========================================================================
//  app-map-fit.js — §32: map fit, bounds clamping & import progress UI
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §32.  Map fit, bounds clamping & import progress UI
// =========================================================================

// Min/max fold shared by both coordinate orders below: `lngIdx`/`latIdx`
// name the slot of each pair holding that axis. Result is MapLibre
// [[w,s],[e,n]]; null when no valid pair exists.
function pointPairsBounds(points, lngIdx, latIdx) {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity,
    any = false;
  (points || []).forEach((p) => {
    if (!Array.isArray(p) || p.length < 2) return;
    any = true;
    if (p[lngIdx] < w) w = p[lngIdx];
    if (p[lngIdx] > e) e = p[lngIdx];
    if (p[latIdx] < s) s = p[latIdx];
    if (p[latIdx] > n) n = p[latIdx];
  });
  return any
    ? [
        [w, s],
        [e, n],
      ]
    : null;
}

// Bounds over every coordinate of the given GeoJSON features (LineString /
// MultiLineString / Point), as MapLibre [[w,s],[e,n]]. null when empty.
function featureCollectionBounds(features) {
  const coords = [];
  (features || []).forEach((feature) => {
    getFeaturePathCoordinates(feature).forEach((c) => coords.push(c));
  });
  return pointPairsBounds(coords, 0, 1);
}

// Bounds over [lat,lng] point pairs (the app's legacy point order).
function latLngPointsBounds(points) {
  return pointPairsBounds(points, 1, 0);
}

// Focus / fit the map on [[w,s],[e,n]] bounds, CENTRED in the uncovered part of
// the viewport (the area not hidden by the sidebar / bottom drawer).
//
// The centring is already handled for us: the map carries a RESTING padding
// equal to the current sidebar footprint (see applySidebarMapPadding — {left:N}
// on desktop, {bottom:N} on mobile). That resting padding makes getCenter() /
// fitBounds() position AND centre content in the uncovered viewport for free,
// and it tracks the menu being expanded/collapsed or dragged.
//
// The old code ALSO passed mapPaddingWithSidebar() as an explicit fit padding —
// MapLibre ADDS that to the resting padding, so the sidebar width was counted
// twice (~960px). On a normal window that overflowed the canvas: cameraForBounds
// returned null, fitBounds silently did nothing, and MapLibre logged "Map cannot
// fit within canvas…". That killed auto-focus (自動聚焦), the 定位 button, the
// per-date fit AND the Japan boot fit. The fix is to pass ONLY a small uniform
// margin so the route never hugs an edge; the resting padding does the rest.
const FOCUS_FIT_MARGIN_PX = 40;
function smoothFitBounds(bounds, opts) {
  if (!map || !bounds) return;
  const { maxZoom = 12, duration = 800 } = opts || {};
  let padding = FOCUS_FIT_MARGIN_PX;
  // Safety net for a tiny viewport under a tall drawer (e.g. a landscape phone):
  // if even the small margin plus the resting padding can't frame the bounds,
  // drop the margin so the fit still moves instead of silently no-op'ing.
  if (
    typeof map.cameraForBounds === "function" &&
    !map.cameraForBounds(bounds, { padding, maxZoom })
  ) {
    if (!map.cameraForBounds(bounds, { padding: 0, maxZoom })) return;
    padding = 0;
  }
  map.fitBounds(bounds, { padding, maxZoom, duration, essential: true });
}

// Two-stage focus fit shared by the single-train and whole-day paths:
// matched route geometry wins; only when NO train in the set has any route
// features do the raw stop coordinates take over. `onlyVisible` restricts
// the set to trains not hidden by their card toggle — the whole-day fit
// honours it, while an explicit single-train fit (selection, 定位 button)
// frames the train regardless.
function fitTrainsBounds(trains, { onlyVisible = false } = {}) {
  if (!map) return;
  const list = (trains || []).filter(
    (train) => train && (!onlyVisible || train.visible !== false),
  );
  const features = [];
  list.forEach((train) => {
    getMatchedRouteFeatures(train).forEach((feature) => features.push(feature));
  });
  const bounds = featureCollectionBounds(features);
  if (bounds) {
    smoothFitBounds(bounds, { maxZoom: 11 });
    return;
  }
  const points = [];
  list.forEach((train) =>
    (train.stops || []).forEach((stop) => {
      const ll = resolveStationForTrain(stop, train);
      if (ll) points.push(toLatLng(ll));
    }),
  );
  const ptBounds = latLngPointsBounds(points);
  if (ptBounds) smoothFitBounds(ptBounds, { maxZoom: 11 });
}

// Single-train entry point — still called by the 定位 button (app-events.js).
function fitTrainBounds(train) {
  fitTrainsBounds([train]);
}

function setImportProgress(count, total, label = "") {
  const safeTotal = Math.max(1, Number(total || 0));
  const safeCount = Math.max(0, Math.min(Number(count || 0), safeTotal));
  const pct = Math.round((safeCount / safeTotal) * 100);
  els.importProgressWrap.hidden = false;
  els.importProgressFill.style.width = `${pct}%`;
  els.importProgressText.textContent =
    label || `${safeCount}/${safeTotal} (${pct}%)`;
}

function resetImportProgress() {
  els.importProgressFill.style.width = "0%";
  els.importProgressText.textContent = "";
  els.importProgressWrap.hidden = true;
}
// [lat,lng] Leaflet-order bounds constant -> MapLibre [[w,s],[e,n]].
function toLngLatBounds(latLngBounds) {
  return [
    [latLngBounds[0][1], latLngBounds[0][0]],
    [latLngBounds[1][1], latLngBounds[1][0]],
  ];
}

function fitJapanMainIslands() {
  if (!map) return;
  // Instant, sidebar-aware fit through the shared helper (its small-margin +
  // resting-padding approach; no explicit sidebar padding that would overflow
  // the canvas and log "Map cannot fit within canvas…" at boot).
  smoothFitBounds(toLngLatBounds(JAPAN_MAIN_ISLANDS_BOUNDS), { duration: 0 });
}

// Keep the map over Japan: minZoom frames the whole territory (beside the
// sidebar) with a small ocean margin; maxBounds stops panning off into empty
// world. Recomputed on resize because the fit zoom depends on the pixel
// viewport.
//
// maxBounds MUST stay wider/taller than the full-canvas viewport at minZoom.
// The old envelope (territory ± 50%) happened to equal the viewport width at the
// old minZoom, so when fully zoomed out the view was clamped to exactly
// maxBounds and horizontal panning LOCKED UP. We now size maxBounds from the
// actual min-zoom viewport span × 1.5, guaranteeing real pan room on both axes.
function applyJapanMapConstraints() {
  if (!map) return;
  const container = map.getContainer();
  const cw = container.clientWidth || 0;
  const ch = container.clientHeight || 0;
  if (!cw || !ch) return; // transient 0-size during layout; a later resize retries
  const cam = map.cameraForBounds(toLngLatBounds(JAPAN_FULL_TERRITORY_BOUNDS));
  if (!cam || !isFinite(cam.zoom)) return;
  // cam.zoom fits the territory in the uncovered viewport; pull back a touch for
  // a small ocean margin (NOT a whole level — that pulled minZoom so far out that
  // the full-canvas view exceeded maxBounds and got clamped, killing the pan).
  const minZoom = Math.max(2, cam.zoom - 0.25);
  map.setMinZoom(minZoom);
  if (map.getZoom() < minZoom) map.setZoom(minZoom);
  // Envelope centred on the territory, sized to the min-zoom viewport × 1.5 (≈50%
  // pan room each way), never smaller than the territory itself. Longitude is
  // linear in web-mercator; latitude uses the scale at the territory's centre.
  const [sw, ne] = JAPAN_FULL_TERRITORY_BOUNDS; // [lat,lng]
  const cLng = (sw[1] + ne[1]) / 2;
  const cLat = (sw[0] + ne[0]) / 2;
  const degPerPxLng = 360 / (512 * Math.pow(2, minZoom));
  const halfViewLng = (cw / 2) * degPerPxLng;
  const halfViewLat = halfViewLng * Math.cos((cLat * Math.PI) / 180) * (ch / cw);
  const PAN = 1.5;
  const halfLng = Math.max(halfViewLng * PAN, (ne[1] - sw[1]) / 2 + 3);
  const halfLat = Math.max(halfViewLat * PAN, (ne[0] - sw[0]) / 2 + 3);
  map.setMaxBounds([
    [cLng - halfLng, Math.max(-85, cLat - halfLat)],
    [cLng + halfLng, Math.min(85, cLat + halfLat)],
  ]);
}

