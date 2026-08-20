// =========================================================================
//  app-route-render.js — §25: route rebuild & layer / marker rendering (SVG + deck record assembly)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §25.  Route rebuild & layer / marker rendering (SVG + deck record assembly)
// =========================================================================

function rebuildSelectedRoute() {
  if (importBusy()) return;
  const train = getTrain();
  if (!train) return;

  train.route_sections = getRideRouteSectionsForTrain(train);

  applyMutationResult(MutationResults.routeChanged);
  setStatus(
    els.fieldStatus,
    I18N.t("status.routeSectionsRebuilt", {
      count: train.route_sections.length,
    }),
    "ok",
  );
}

// Add ONE train's route line + markers onto the existing map layers WITHOUT
// clearing anything. Used during progressive load so each train appears one at
// a time (one new line per train) instead of all-at-once. Overlap offset slots
// are intentionally skipped here (they are a global, all-trains computation);
// the single authoritative renderTrainLayers() at the end of the load applies
// the correct parallel-offset styling. Honors the same visibility / date-scope
// rules as the full render so hidden or out-of-scope trains don't draw.
let _appendRenderTimer = null;
function appendTrainToLayers(train) {
  if (!train || train.visible === false) return;
  const dateScoped = mapFollowsSelectedDate && selectedDate !== ALL_DATES;
  // Same scope rule as renderTrainLayers: a cross-day train belongs to both of
  // its days, so "only show the current date" still draws it on either one.
  if (dateScoped && !trainSpansDate(train, selectedDate)) return;

  // GL mode: incremental feedback = drop the route-item cache and re-issue
  // the layers for the trains loaded so far. Rebuilding the overlap map is
  // O(all segments), so per-train renders make a big import O(N²) — batch
  // appends landing within one short window into a single render. The
  // authoritative renderAll() at the end of the load still applies the final
  // styling.
  cachedRouteItems = null;
  cachedRouteSignature = "";
  // Train DATA changed: every scope's cached items/records holds objects from
  // the store being replaced, so all of them are stale — not just the current
  // signature's. The overlap map survives: it is keyed by a signature that
  // already encodes the exact train set, so the entry for a DIFFERENT set is
  // not stale, only irrelevant. This runs once per appended train, so clearing
  // it here is what used to hold the cache to a single live entry and made
  // every return to a previously-drawn store re-derive its whole corridor
  // graph from scratch.
  if (typeof invalidateDeckRouteCaches === "function")
    invalidateDeckRouteCaches({ keepOverlapMap: true });
  // A progressive import renders ITSELF: it streams the train list, and closes
  // with one authoritative renderAll() (finalizeProgressiveLoad for the two
  // "replace" paths, runProgressiveAppend's finalRender for append mode). The
  // debounced full render below is therefore redundant during an import — and
  // far from free. The invalidate above drops every cache on EVERY appended
  // train, so each fire is a COLD rebuild (vertex snap, overlap map, corridor
  // curves, deck records) over all trains loaded so far, growing as the load
  // proceeds. On the 142-train sample that was five back-to-back blocking
  // tasks of 0.7–1.3 s: ~5 s of frozen tab that the loader's 12 ms frame
  // budget cannot yield out of, all of it discarded by the final render.
  // Skipping them makes the load both responsive AND ~45% faster.
  if (typeof importInProgress !== "undefined" && importInProgress) return;
  if (_appendRenderTimer || !map) return;
  _appendRenderTimer = setTimeout(() => {
    _appendRenderTimer = null;
    if (typeof renderTrainLayers === "function" && map) renderTrainLayers();
  }, 120);
}

// Three-tier emphasis for the current scope, drawn bottom→top as:
//   dim (other dates) < normal (the selected date's trains) < selected (top).
// - "全部" with nothing selected: everything normal (no dimming).
// - A concrete date, no train selected: that day normal, other dates dim.
// - A concrete date with a train selected: the selected train rides on top
//   (focused), its SAME-DAY siblings stay normal/highlighted, and only the
//   other dates dim.
// Returns 0 = dim, 1 = normal, 2 = selected — used for both styling and the
// draw-order so higher tiers paint above lower ones.
function trainEmphasisLevel(train) {
  if (selectedTrainId && train.id === selectedTrainId) return 2;
  if (selectedDate === ALL_DATES) return 1;
  // A cross-day train counts as "this day" on BOTH of its dates: the half that
  // runs on another date draws dashed, never dimmed (jsonspec §13.6).
  return trainSpansDate(train, selectedDate) ? 1 : 0;
}

// (trainScopeFlags was removed: route/marker RECORDS use the selection-free
// routeRecordScopeFlags in §26, and focus emphasis is drawn by railmap's SEL
// layers + focus-boost paint expressions.)

function renderTrainLayers() {
  // A concrete selected date now always scopes the map: that date's trains
  // stay solid and other dates draw half-transparent (dimmed) — they are NOT
  // removed. The optional "地圖僅顯示當前日期" checkbox is a stricter override
  // that hides other dates entirely instead of dimming them. Selecting a
  // single train keeps everything drawn: the selected train stays solid and
  // EVERY other train — same-day siblings AND other dates, routes and
  // station dots alike — fades to one uniform opacity via railmap's
  // selection-dim paint pass (constant SELECT_DIM, so both groups look the
  // same). Off-date trains remain non-interactive and lane-less regardless.
  const dateActive = selectedDate !== ALL_DATES;
  const hardHide = mapFollowsSelectedDate && dateActive;
  // Date-scope dim is a railmap PAINT state keyed on each record's tdate.
  // Update it FIRST so the opacity fade starts on the currently-drawn data
  // (the record rebuild below re-uploads features with identical per-train
  // paint inputs, so the transition continues seamlessly across it).
  if (window.RailMap && map) {
    RailMap.setDateScope(
      dateActive ? selectedDate : null,
      DISPLAY.dimOpacity,
      !DISPLAY.showFullCrossDay,
    );
  }
  const visibleTrains = trainStore.trains.filter(
    (train) =>
      train.visible !== false &&
      (!hardHide || trainSpansDate(train, selectedDate)),
  );
  const focusActive = Boolean(
    selectedTrainId &&
    visibleTrains.some((train) => train.id === selectedTrainId),
  );
  // Stable bottom→top draw order by emphasis tier: dim (0) under the current
  // date's trains (1). The SELECTED train no longer gets its own tier — the
  // dedicated SEL casing/line layers already draw it above everything, so
  // reordering (and thus rebuilding the record pipeline) on every pick would
  // be pure waste.
  const scopeActive = dateActive || focusActive;
  const orderedTrains = scopeActive
    ? [0, 1].flatMap((tier) =>
        visibleTrains.filter(
          (train) => Math.min(1, trainEmphasisLevel(train)) === tier,
        ),
      )
    : visibleTrains;
  cachedRouteDateActive = dateActive;

  // (1) Overlap-split caching. The split runs + overlap slots are a function
  // of the train set / order / route geometry / ride flags / date scope —
  // never of zoom, pan or SELECTION — so recompute them only when their
  // signature changes. Picking a train, style-only edits (overlap map) and
  // view moves all reuse the caches.
  const signature = computeRouteSignature(orderedTrains, dateActive);
  if (!cachedRouteItems || signature.records !== cachedRouteSignature) {
    // Scope-keyed: switching back to an already-rendered scope (e.g. a date
    // ⇄ 全部 round trip) reuses that scope's item list instead of rebuilding.
    cachedRouteItems =
      _routeItemsCacheBySig.get(signature.records) ||
      buildRouteItems(orderedTrains);
    _deckCachePut(_routeItemsCacheBySig, signature.records, cachedRouteItems);
    cachedRouteSignature = signature.records;
    cachedRouteOverlapSignature = signature.overlap;
  }

  // (2) Attach all route segments once (SVG render-once). Pan/zoom need no
  // per-gesture work — Leaflet's SVG renderer transforms the existing paths.
  renderRoutesInView();

  cachedOrderedTrains = orderedTrains;
  renderTrainMarkers();
}

// Markers are ZERO-REBUILD on selection and zoom:
//   - records are selection-independent (focus emphasis = SEL-layer paint,
//     selection split = layer filters) and cached by the route signature, so
//     a train pick re-uses them untouched;
//   - the pass-through LOD lives in the pass layers' `minzoom` (set from
//     PASSTHROUGH_MIN_ZOOM), so crossing the threshold re-renders nothing —
//     MapLibre just starts/stops drawing the already-uploaded circles.
let _markerRecordsCacheBySig = new Map(); // recordSig → marker records
let _routeItemsCacheBySig = new Map(); // recordSig → route items
let _lastPushedMarkerRecords = null;
function renderTrainMarkers() {
  updateEndpointLabels();
  if (window.RailMap && map) {
    let records = cachedRouteSignature
      ? _markerRecordsCacheBySig.get(cachedRouteSignature)
      : null;
    if (!records) {
      records = buildDeckMarkerRecords(cachedOrderedTrains);
      if (cachedRouteSignature)
        _deckCachePut(_markerRecordsCacheBySig, cachedRouteSignature, records);
    }
    // Push only when the record set actually changed (identity check works
    // because cache hits return the same array).
    if (records !== _lastPushedMarkerRecords) {
      RailMap.setMarkers(records);
      _lastPushedMarkerRecords = records;
    }
  }
}

// Signatures of everything the route records / overlap map depend on
// (zoom-independent). Returns TWO keys:
//   records — invalidates the flattened record cache: geometry + ride flags +
//             per-train style + visibility + date scope. SELECTION IS
//             DELIBERATELY EXCLUDED: focus emphasis lives entirely in
//             railmap's SEL layers + paint expressions, so picking a train
//             costs ZERO pipeline rebuild.
//   overlap — invalidates the overlap map only: geometry + visibility + date
//             scope (style-only edits keep the corridor graph).
function computeRouteSignature(orderedTrains, dateActive) {
  const overlapPart = [];
  const trainPart = orderedTrains
    .map((train) => {
      // The day span belongs in the key: editing a stop time into (or out of)
      // 25:xx changes which records draw dashed, and nothing else in the key
      // sees stop TIMES at all.
      const base = `${train.id}:${getTrainRouteTemplateKey(train)}:${(train.stops || []).map((s) => (s.ride_segment ? 1 : 0)).join("")}:${getTrainDaySpan(train).sig}`;
      const vis = train.visible === false ? 0 : 1;
      overlapPart.push(`${base}:${vis}`);
      const s = train.style || {};
      return `${base}:${s.color || ""}:${vis}`;
    })
    .join("|");
  // Selection deliberately stays OUT of the signature: picking a train only
  // changes railmap paint state (SEL layers + selection dim), never the
  // record set, so clicks rebuild nothing. Which trains are drawn is already
  // captured per-train in trainPart (visibility + membership).
  const scope = `date:${dateActive ? selectedDate : ""}`;
  return {
    records: `${trainPart}|${scope}`,
    overlap: `${overlapPart.join("|")}|${scope}`,
  };
}

// Build the overlap map + split runs once, annotating each run with a cached
// LatLngBounds so the viewport cull can test it without re-walking geometry.
function buildRouteItems(orderedTrains) {
  // One item per (train, matched route feature), always on its true track.
  // Overlap detection, run-splitting and the parallel pick/expand lanes all
  // live in buildDeckOverlapMap / buildDeckRouteRecords (§26); the old
  // Leaflet-era split path was removed.
  // Routes are drawn from these items in renderRoutesInView(); the
  // popup/click data lives on each item via item.train / item.feature.
  return orderedTrains.flatMap((train) =>
    getMatchedRouteFeatures(train).map((feature) => ({ train, feature })),
  );
}

// Attach only the cached route segments intersecting the current padded view.
// `force` re-renders unconditionally (data/style changed); otherwise skip when
// the previous padded render still covers the current view, so an in-margin pan
// is a cheap no-op.
//
// Performance: layer objects are pre-created in buildRouteItems (one per item,
// per-signature). On pan/zoom, we do an O(delta) incremental diff — only add
// layers that entered the padded view and remove those that left. No new Leaflet
// objects are allocated on moveend/zoom, eliminating the dominant source of
// post-load drag/zoom jank.
// SVG render-once: attach every pre-created route segment a single time.
// With the SVG renderer, panning is a free CSS transform (no redraw) and zoom
// re-projects in one Leaflet pass, so the old canvas-era machinery — viewport
// culling, the spatial grid, per-moveend incremental add/remove, and per-tier
// LOD smoothFactor patching — is unnecessary. Re-attaching only runs when the
// train set / styling actually changes (via renderTrainLayers), never on a
// pan or zoom. clearLayers() first so any segments added incrementally by
// appendTrainToLayers during a progressive import are not double-counted.
let _lastPushedBuilt = null;
function renderRoutesInView() {
  if (!map || !cachedRouteItems || !window.RailMap) return;
  // One GeoJSON source for the whole train set; MapLibre re-tiles it on the
  // worker, so pan/zoom stay GPU-cheap regardless of point count. The
  // full-line expand records + per-group rigid shift vectors feed the
  // dedicated hover-expand source, so a fanned parallel line is the member
  // train's complete course translated intact — never broken mid-route.
  const built = buildDeckRouteRecords(cachedRouteItems);
  // A stable record bundle needs no source or lane update: line-translate is
  // pixel-valued, so pan/zoom do not alter fan spacing. Geometry/style/
  // visibility/date changes produce a new bundle and take the full path.
  if (built !== _lastPushedBuilt) {
    RailMap.setData(
      built.records,
      built.expandRecords,
      built.groupInfo,
      built.spacingPx,
    );
    _lastPushedBuilt = built;
  }
  // The selected train re-draws in the dedicated selection layers (dark ink
  // casing + full-color line) above all other routes.
  RailMap.setSelected(focusedTrainId || null);
}
