// =========================================================================
//  app-style.js — §31: visual styling (single source of truth) & render primitives
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §31.  Visual styling (single source of truth) & render primitives
// =========================================================================

// ------------------------------------------------------------------------
// Single source of truth for route / marker visual styling. The SVG render
// path (renderTrainRouteSegment / renderStopMarker / renderPassThroughMarker)
// and the GPU render path (buildDeckRouteRecords / deckMarkerRecord) MUST
// produce visually identical results. These helpers return the raw style
// numbers (opacity 0-1, sizes in screen pixels); each render path only
// converts them to its own colour representation. Previously every one of
// these numbers was duplicated verbatim between the two paths, so a tweak in
// one could silently diverge from the other.
// ------------------------------------------------------------------------
function routeSegmentStyleValues(
  train,
  ridden,
  { focused = false, dimmed = false } = {},
) {
  // Line width is uniform across trains: the global base weight scaled by the
  // 線路粗細 (DISPLAY.routeWidthScale) webpage control — no per-train weight.
  const weight = DEFAULT_TRAIN_WEIGHT * DISPLAY.routeWidthScale;
  // Unridden intervals are now hidden ENTIRELY (opacity 0), not drawn pale.
  // opacity 0 makes the GPU path drop the segment (see buildDeckRouteRecords'
  // `opacity <= 0` guard) and the SVG path render nothing. The whole-train
  // "dimmed" state (other selected date) is NOT baked here anymore: it is
  // applied by railmap as a paint expression on the record's `tdate`
  // (RailMap.setDateScope), so date-scope changes FADE via the declared
  // opacity transitions instead of snapping with a record rebuild. `dimmed`
  // still drives interactivity/lane exclusion (nopick) elsewhere.
  const opacity =
    train.visible === false || !ridden
      ? 0
      : focused
        ? 1
        : DISPLAY.riddenOpacity;
  void dimmed;
  const width = focused ? weight + DISPLAY.focusBoost : weight;
  return { opacity, width };
}

// NEUTRAL station dots (railprint C4: hue is reserved for LINES). The actual
// boarding/alighting pair (ride boundary) = large BLACK dot with a white ring.
// Intermediate stops and pass-throughs share the same small WHITE outer circle
// and ink ring; the marker builder overlays a black center on stops only.
const RP_INK_RGB = [26, 26, 26]; // tokens.ink
const RP_WHITE_RGB = [255, 255, 255];

function stopCenterRadius(outerRadius) {
  const requested = Number(DISPLAY.stopRadius || 5) * 0.4;
  // Keep the stop visibly filled while retaining enough white around the
  // center to distinguish it from the solid origin/destination marker.
  return Math.max(0.75, Math.min(Number(outerRadius) * 0.72, requested));
}

function stopMarkerStyleValues(
  active,
  isBoundary,
  { focused = false, dimmed = false } = {},
) {
  // Intermediate stops render at PASS-THROUGH size (a black center dot on
  // top distinguishes them — added as a second record by the marker builder);
  // only the true boarding/alighting boundary keeps the large terminal dot.
  const baseRadius = isBoundary ? DISPLAY.terminalRadius : DISPLAY.passRadius;
  const boost = isBoundary
    ? DISPLAY.focusBoost
    : Math.round(DISPLAY.focusBoost / 2);
  // Date-scope dim is paint-level now (RailMap.setDateScope), not baked.
  void dimmed;
  const alpha = 1;
  return {
    radius: focused ? baseRadius + boost : baseRadius,
    lineWidth: Math.max(
      1,
      Math.round((focused ? 2 : 1) * DISPLAY.markerStrokeScale),
    ),
    fill: isBoundary ? RP_INK_RGB : RP_WHITE_RGB,
    strokeCol: isBoundary ? RP_WHITE_RGB : RP_INK_RGB,
    fillOpacity: alpha,
    lineOpacity: alpha,
  };
}

function passThroughMarkerStyleValues(
  active,
  { focused = false, dimmed = false } = {},
) {
  // Date-scope dim is paint-level now (RailMap.setDateScope), not baked.
  void dimmed;
  // An active pass-through uses the same outer-circle opacity as an
  // intermediate stop; the stop's black center is their sole visual delta.
  const alpha = active ? 1 : 0.4;
  return {
    radius: focused
      ? DISPLAY.passRadius + Math.round(DISPLAY.focusBoost / 2)
      : DISPLAY.passRadius,
    lineWidth: Math.max(1, Math.round(DISPLAY.markerStrokeScale)),
    fill: RP_WHITE_RGB,
    strokeCol: RP_INK_RGB,
    fillOpacity: alpha,
    lineOpacity: alpha,
  };
}

// (The Leaflet SVG render primitives are gone with Leaflet; routes and
// markers now render as MapLibre GL layers — see railmap.js.)

function toLatLng(feature) {
  const coord = getFeatureDisplayCoordinate(feature);
  return [coord[1], coord[0]];
}

function coordinatesEqual(a, b) {
  return (
    a && b && Number(a[0]) === Number(b[0]) && Number(a[1]) === Number(b[1])
  );
}

