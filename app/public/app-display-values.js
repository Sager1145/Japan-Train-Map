// =========================================================================
//  app-display-values.js — the display-tuning values themselves
//
//  DISPLAY is read by nearly every render module (route render, overlap
//  lanes, deck records, styling, map init, the feature layer), but it was
//  declared inside app-display-settings.js — a file that is otherwise the
//  顯示調節 PANEL: DOM building, slider wiring, theme/UI-mode selects. So
//  reading a number meant depending on the control panel that edits it, and
//  the panel calls back into the renderers to apply a change: three modules
//  ended up in a cycle with a settings panel they never touch.
//
//  The values are self-contained — object and array literals plus one
//  four-line copy function, no DOM, no I18N, no renderer — so they belong at
//  the bottom of the family, ahead of everyone who reads them. This file
//  depends on nothing.
//
//  Ownership after the split: this file DECLARES the values; the panel
//  (app-display-settings.js) loads them from localStorage, edits them, and
//  persists them. Nothing else writes them.
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// ------------------------------------------------------------------------
// Global display-tuning settings. These are pure UI/presentation knobs that
// scale or override the numbers returned by the three style helpers
// (routeSegmentStyleValues / stopMarkerStyleValues / passThroughMarkerStyleValues),
// so they affect BOTH the SVG and the deck.gl render paths uniformly. They are
// NOT part of the canonical train store — they live in localStorage only, so
// the exported JSON schema stays exactly { schema_version, trains:[...] }.
// ------------------------------------------------------------------------
// v2: defaults re-seeded for the railprint visual system (positron basemap at
// full opacity, ridden lines full color, railprint-scale station dots). The
// versioned key intentionally orphans v1 saved settings, whose numbers were
// tuned for the old faded-raster look.
// v5 (2026-08-20): the railway halved its weight, so the sizes that were
// tuned AGAINST the old weight are re-seeded on migration (RESEEDED_ON_MIGRATION
// below) while every other saved preference carries over untouched.
const DISPLAY_STORAGE_KEY = "n02-train-manager-display-settings-v5";
const PREVIOUS_DISPLAY_STORAGE_KEY = "n02-train-manager-display-settings-v4";
// 停靠站中心黑點 keeps a legacy 2..16 slider range from before it meant a
// radius, so the stored number is this many times the radius it sets. Read by
// the default below, by the slider's read-out (app-display-settings.js) and by
// stopCenterRadius() (app-style.js) — the factor used to be spelled 0.4 in all
// three.
const STOP_CENTRE_SLIDER_SCALE = 0.4;
const DISPLAY_DEFAULTS = {
  theme: "system", // system preference, explicit light, or explicit dark
  uiMode: "auto", // automatic terminal detection, or an explicit mobile/desktop UI
  routeWidthScale: 1, // multiplies each train's route line width
  riddenOpacity: 1, // opacity of ridden (ride_segment=true) route segments (railprint: 1)
  // (unriddenOpacity was removed: unridden intervals are hidden entirely now,
  // so the slider was a do-nothing control lying to the user.)
  dimOpacity: 0.18, // opacity of trains not on the selected date
  // px radius of the origin / destination markers: the ONE dot on a ride that
  // is deliberately bigger than the station dot the network already drew
  // there, by the same step the ride's stroke takes over the network's.
  terminalRadius: RAILWAY_STYLE_TOKENS.stationTerminalRadiusPx,
  // Legacy numeric range retained so existing saved display settings remain
  // valid (the slider's value is STOP_CENTRE_SLIDER_SCALE × the radius it
  // sets); it controls the black center inside intermediate stop markers.
  stopRadius:
    RAILWAY_STYLE_TOKENS.stationStopCentreRadiusPx / STOP_CENTRE_SLIDER_SCALE,
  // Intermediate calls and pass-throughs are drawn at exactly the network's
  // own station diameter — the ride must not disagree with the map underneath
  // it about how big a station is.
  passRadius: RAILWAY_STYLE_TOKENS.stationRadiusPx,
  markerStrokeScale: 1, // multiplies every marker's stroke width
  focusBoost: 2, // extra line width / marker radius for the selected train
  mapOpacity: 1, // basemap visibility; lower fades the map toward pure white (railprint: no fade)
  fitCurvePrecision: 1, // B-spline output sampling density only
  fitCurveMinRadius: 3100, // requested minimum geometric/direction radius, metres
  fitCurveMinDetail: 3300, // source details below this physical scale are removed
  fitCurveMaxDeviation: 4200, // how far fit controls may leave the source, metres
  // Cross-day (overnight) trains: OFF draws the half that runs on the other
  // calendar day dashed while a day is selected; ON draws the whole itinerary
  // solid, exactly like every other train.
  showFullCrossDay: false,
  showFitCurves: false, // topmost black/white dashed fitted-curve debug overlay
  showHoverRegions: false, // topmost hover pick / hysteresis region debug overlay
  // Station-name reading annotations (labels / popups): three INDEPENDENT
  // toggles. Until the user touches one (nameReadingsCustomized), they follow
  // the UI language — zh shows kana, en shows romaji, ja shows none — the
  // exact presentation placeName() hardwired before the toggles existed.
  nameReadingKana: false,
  nameReadingRomaji: false,
  nameReadingZh: false,
  nameReadingsCustomized: false,
};
// Live working copy (mutated by the UI; seeded from localStorage on boot).
const DISPLAY = { ...DISPLAY_DEFAULTS };
// Keys whose SAVED value is dropped when a payload is carried over from
// PREVIOUS_DISPLAY_STORAGE_KEY — the ones this version retuned, and only
// those. Everything else a reader has adjusted survives the version bump.
const RESEEDED_ON_MIGRATION = new Set(["terminalRadius"]);
const FIT_CURVE_SETTING_KEYS = [
  "fitCurvePrecision",
  "fitCurveMinRadius",
  "fitCurveMinDetail",
  "fitCurveMaxDeviation",
];
// The fit-curve sliders are the one group that does NOT apply on drag: the
// curve fitter reads this applied snapshot, so a half-dragged slider can
// never invalidate a corridor mid-rebuild. The 進階 rebuild button (and the
// reset button, and boot) copy DISPLAY's pending values across.
const APPLIED_FIT_CURVE_SETTINGS = {};
function applyPendingFitCurveSettings() {
  FIT_CURVE_SETTING_KEYS.forEach((key) => {
    APPLIED_FIT_CURVE_SETTINGS[key] = DISPLAY[key];
  });
}
