// =========================================================================
//  app-display-settings.js — §3: display-tuning settings & control panel (localStorage-only)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §3.  Display-tuning settings & control panel (localStorage-only, not in store)
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
const DISPLAY_STORAGE_KEY = "n02-train-manager-display-settings-v4";
const PREVIOUS_DISPLAY_STORAGE_KEY = "n02-train-manager-display-settings-v3";
const DISPLAY_DEFAULTS = {
  theme: "system", // system preference, explicit light, or explicit dark
  routeWidthScale: 1, // multiplies each train's route line width
  riddenOpacity: 1, // opacity of ridden (ride_segment=true) route segments (railprint: 1)
  // (unriddenOpacity was removed: unridden intervals are hidden entirely now,
  // so the slider was a do-nothing control lying to the user.)
  dimOpacity: 0.18, // opacity of trains not on the selected date
  terminalRadius: 6, // px radius (at z12) of origin / destination markers
  // Legacy numeric range retained so existing saved display settings remain
  // valid; it now controls the black center inside intermediate stop markers.
  stopRadius: 5,
  passRadius: 3, // px radius (at z12) of pass-through markers (railprint unridden dot = 3 @ z12)
  markerStrokeScale: 1, // multiplies every marker's stroke width
  focusBoost: 2, // extra line width / marker radius for the selected train
  mapOpacity: 1, // basemap visibility; lower fades the map toward pure white (railprint: no fade)
  fitCurvePrecision: 1, // B-spline output sampling density only
  fitCurveMinRadius: 3100, // requested minimum geometric/direction radius, metres
  fitCurveMinDetail: 3300, // source details below this physical scale are removed
  fitCurveMaxDeviation: 4200, // how far fit controls may leave the source, metres
  showFitCurves: false, // topmost black/white dashed fitted-curve debug overlay
  showHoverRegions: false, // topmost hover pick / hysteresis region debug overlay
};
// Live working copy (mutated by the UI; seeded from localStorage on boot).
const DISPLAY = { ...DISPLAY_DEFAULTS };
const FIT_CURVE_SETTING_KEYS = [
  "fitCurvePrecision",
  "fitCurveMinRadius",
  "fitCurveMinDetail",
  "fitCurveMaxDeviation",
];
const APPLIED_FIT_CURVE_SETTINGS = {};
function applyPendingFitCurveSettings() {
  FIT_CURVE_SETTING_KEYS.forEach((key) => {
    APPLIED_FIT_CURVE_SETTINGS[key] = DISPLAY[key];
  });
}
const formatFitDistance = (x) =>
  x >= 1000 ? (x / 1000).toFixed(1) + "km" : Math.round(x) + "m";
// Slider definitions for the "顯示調節" submenu (built dynamically in JS so the
// HTML stays tiny and every control is wired the same way).
const DISPLAY_CONTROLS = [
  { key: "routeWidthScale", labelKey: "disp.routeWidthScale", min: 0.2, max: 3, step: 0.1, fmt: (x) => x.toFixed(1) + "×" },
  { key: "riddenOpacity", labelKey: "disp.riddenOpacity", min: 0, max: 1, step: 0.05, fmt: (x) => x.toFixed(2) },
  { key: "dimOpacity", labelKey: "disp.dimOpacity", min: 0, max: 1, step: 0.02, fmt: (x) => x.toFixed(2) },
  { key: "terminalRadius", labelKey: "disp.terminalRadius", min: 3, max: 20, step: 1, fmt: (x) => x + "px" },
  { key: "stopRadius", labelKey: "disp.stopRadius", min: 2, max: 16, step: 1, fmt: (x) => (x * 0.4).toFixed(1) + "px" },
  { key: "passRadius", labelKey: "disp.passRadius", min: 1, max: 12, step: 1, fmt: (x) => x + "px" },
  { key: "markerStrokeScale", labelKey: "disp.markerStrokeScale", min: 0.5, max: 3, step: 0.1, fmt: (x) => x.toFixed(1) + "×" },
  { key: "focusBoost", labelKey: "disp.focusBoost", min: 0, max: 6, step: 1, fmt: (x) => "+" + x },
  { key: "mapOpacity", labelKey: "disp.mapOpacity", min: 0, max: 1, step: 0.05, fmt: (x) => x.toFixed(2) },
  { key: "fitCurvePrecision", labelKey: "disp.fitCurvePrecision", min: 0.5, max: 2, step: 0.1, fmt: (x) => x.toFixed(1) + "×", manualFitRebuild: true },
  { key: "fitCurveMinRadius", labelKey: "disp.fitCurveMinRadius", min: 200, max: 30000, step: 100, fmt: formatFitDistance, manualFitRebuild: true },
  { key: "fitCurveMinDetail", labelKey: "disp.fitCurveMinDetail", min: 100, max: 20000, step: 100, fmt: formatFitDistance, manualFitRebuild: true },
  { key: "fitCurveMaxDeviation", labelKey: "disp.fitCurveMaxDeviation", min: 100, max: 30000, step: 100, fmt: formatFitDistance, manualFitRebuild: true },
];
// Checkbox toggles for the submenu (booleans, rendered under the sliders).
const DISPLAY_TOGGLES = [
  { key: "showFitCurves", labelKey: "disp.fitCurves", rebuild: false },
  { key: "showHoverRegions", labelKey: "disp.hoverRegions", rebuild: false },
];
const THEME_MEDIA = window.matchMedia("(prefers-color-scheme: dark)");
const REDUCED_MOTION_MEDIA = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
);
let activeResolvedTheme = null;
let themeSelectReady = false;
let themeTransitionTimer = null;
const THEME_TRANSITION_MS = 460;

function resolveDisplayTheme(mode = DISPLAY.theme) {
  if (mode === "dark" || mode === "light") return mode;
  return THEME_MEDIA.matches ? "dark" : "light";
}

function updateThemeSelect() {
  const select = document.getElementById("theme-select");
  if (!select) return;
  select.value = ["system", "light", "dark"].includes(DISPLAY.theme)
    ? DISPLAY.theme
    : "system";
}

function setupThemeSelect() {
  if (themeSelectReady) return;
  const select = document.getElementById("theme-select");
  if (!select) return;
  themeSelectReady = true;
  select.addEventListener("change", () => {
    DISPLAY.theme = select.value;
    applyDisplayTheme();
  });
  updateThemeSelect();
}

function setDocumentTheme(resolved) {
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta)
    themeMeta.content = resolved === "dark" ? "#1c1c1e" : "#ff5522";
}

function transitionDocumentTheme(resolved, animate) {
  const root = document.documentElement;
  clearTimeout(themeTransitionTimer);
  root.classList.toggle("theme-transitioning", Boolean(animate));
  if (animate) void root.offsetWidth;
  setDocumentTheme(resolved);
  if (animate) {
    // Commit the menu's colour transition before the MapLibre paint updates.
    // Both timelines then advance together even if updating many basemap
    // layers occupies the main thread before the next visible frame.
    void root.offsetWidth;
    themeTransitionTimer = setTimeout(() => {
      root.classList.remove("theme-transitioning");
      themeTransitionTimer = null;
    }, THEME_TRANSITION_MS + 40);
  }
}

async function applyDisplayTheme({ updateMap = true, persist = true } = {}) {
  const resolved = resolveDisplayTheme();
  const previous = activeResolvedTheme;
  const changed = resolved !== activeResolvedTheme;
  activeResolvedTheme = resolved;
  const animate =
    changed && previous !== null && !REDUCED_MOTION_MEDIA.matches;
  updateThemeSelect();
  if (persist) persistDisplaySettings();
  const canUpdateMap =
    updateMap &&
    changed &&
    map &&
    window.RailMap &&
    typeof RailMap.setBasemapTheme === "function";
  transitionDocumentTheme(resolved, animate);
  if (canUpdateMap) {
    await RailMap.setBasemapTheme(resolved, { animate });
  }
}

function loadDisplaySettings() {
  try {
    const current = localStorage.getItem(DISPLAY_STORAGE_KEY);
    const migrated = !current;
    const raw = current || localStorage.getItem(PREVIOUS_DISPLAY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const k of Object.keys(DISPLAY_DEFAULTS)) {
        const def = DISPLAY_DEFAULTS[k];
        const v = parsed[k];
        // Keep existing visual preferences while deliberately seeding the new
        // much broader v3 curve-fit defaults for users upgrading from v2.
        if (migrated && k.indexOf("fitCurve") === 0) continue;
        if (typeof def === "boolean") {
          if (typeof v === "boolean") DISPLAY[k] = v;
        } else if (typeof def === "string") {
          if (typeof v === "string") DISPLAY[k] = v;
        } else if (typeof v === "number" && isFinite(v)) {
          DISPLAY[k] = v;
        }
      }
    }
  } catch (err) {
    // Non-fatal: disabled storage just means defaults.
  }
}

function persistDisplaySettings() {
  try {
    localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(DISPLAY));
  } catch (err) {
    /* ignore */
  }
}

// Apply a settings change: persist, drop the route-item cache so segments are
// re-emitted with the new numbers, then re-render both layers.
function applyDisplaySettings({ rebuild = true } = {}) {
  persistDisplaySettings();
  applyMapOpacity();
  if (window.RailMap && RailMap.setFitCurvesVisible)
    RailMap.setFitCurvesVisible(DISPLAY.showFitCurves);
  if (window.RailMap && RailMap.setHoverRegionsVisible)
    RailMap.setHoverRegionsVisible(DISPLAY.showHoverRegions);
  if (!rebuild) return;
  cachedRouteItems = null;
  cachedRouteSignature = "";
  // DISPLAY values (dimOpacity, routeWidthScale, …) are NOT part of the route
  // signature, so the signature-keyed overlap/record caches must be dropped
  // explicitly — e.g. dimOpacity crossing 0 changes which segments are drawn
  // and therefore the lane counts.
  if (typeof invalidateDeckRouteCaches === "function")
    invalidateDeckRouteCaches();
  // focusBoost is drawn by the SEL layer's paint expression, not the records.
  if (window.RailMap && RailMap.setFocusBoost)
    RailMap.setFocusBoost(DISPLAY.focusBoost);
  if (typeof renderTrainLayers === "function") renderTrainLayers();
}

let fitCurveSettingsDirty = false;
let fitCurveRebuildButton = null;
function updateFitCurveRebuildButton() {
  if (!fitCurveRebuildButton) return;
  fitCurveRebuildButton.textContent = I18N.t("disp.rebuildFitCurves");
  fitCurveRebuildButton.dataset.pending = fitCurveSettingsDirty ? "true" : "false";
  fitCurveRebuildButton.classList.toggle("pending", fitCurveSettingsDirty);
}

// Build + wire the submenu sliders. Safe to call once after the DOM exists.
function setupDisplaySettingsPanel() {
  const body = document.getElementById("display-settings-body");
  if (!body) return;
  body.innerHTML = "";
  DISPLAY_CONTROLS.forEach((cfg) => {
    const wrap = document.createElement("label");
    wrap.className = "display-control";
    const head = document.createElement("span");
    head.className = "display-control-head";
    const name = document.createElement("span");
    name.textContent = I18N.t(cfg.labelKey);
    const val = document.createElement("span");
    val.className = "display-control-val";
    const input = document.createElement("input");
    input.type = "range";
    input.min = cfg.min;
    input.max = cfg.max;
    input.step = cfg.step;
    input.value = DISPLAY[cfg.key];
    val.textContent = cfg.fmt(Number(DISPLAY[cfg.key]));
    input.addEventListener("input", () => {
      DISPLAY[cfg.key] = Number(input.value);
      val.textContent = cfg.fmt(Number(input.value));
      if (cfg.manualFitRebuild) {
        fitCurveSettingsDirty = true;
        persistDisplaySettings();
        updateFitCurveRebuildButton();
      } else if (cfg.debounceMs) {
        clearTimeout(cfg._applyTimer);
        cfg._applyTimer = setTimeout(() => applyDisplaySettings(), cfg.debounceMs);
      } else {
        applyDisplaySettings();
      }
    });
    head.appendChild(name);
    head.appendChild(val);
    wrap.appendChild(head);
    wrap.appendChild(input);
    body.appendChild(wrap);
    cfg._input = input;
    cfg._val = val;
    cfg._name = name;
  });
  const rebuildWrap = document.createElement("div");
  rebuildWrap.className = "toolbar fit-curve-rebuild-toolbar";
  fitCurveRebuildButton = document.createElement("button");
  fitCurveRebuildButton.type = "button";
  fitCurveRebuildButton.id = "rebuild-fit-curves";
  fitCurveRebuildButton.addEventListener("click", () => {
    applyPendingFitCurveSettings();
    fitCurveSettingsDirty = false;
    updateFitCurveRebuildButton();
    applyDisplaySettings();
  });
  updateFitCurveRebuildButton();
  rebuildWrap.appendChild(fitCurveRebuildButton);
  body.appendChild(rebuildWrap);
  DISPLAY_TOGGLES.forEach((cfg) => {
    const wrap = document.createElement("label");
    wrap.className = "inline-check display-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(DISPLAY[cfg.key]);
    const span = document.createElement("span");
    span.textContent = I18N.t(cfg.labelKey);
    input.addEventListener("change", () => {
      DISPLAY[cfg.key] = input.checked;
      applyDisplaySettings({ rebuild: cfg.rebuild !== false });
    });
    wrap.appendChild(input);
    wrap.appendChild(span);
    body.appendChild(wrap);
    cfg._input = input;
    cfg._span = span;
  });
  const reset = document.getElementById("display-settings-reset");
  if (reset) {
    reset.addEventListener("click", () => {
      Object.assign(DISPLAY, DISPLAY_DEFAULTS);
      DISPLAY_CONTROLS.forEach((cfg) => {
        if (!cfg._input) return;
        cfg._input.value = DISPLAY[cfg.key];
        cfg._val.textContent = cfg.fmt(Number(DISPLAY[cfg.key]));
      });
      DISPLAY_TOGGLES.forEach((cfg) => {
        if (cfg._input) cfg._input.checked = Boolean(DISPLAY[cfg.key]);
      });
      applyPendingFitCurveSettings();
      fitCurveSettingsDirty = false;
      updateFitCurveRebuildButton();
      applyDisplayTheme();
      applyDisplaySettings();
    });
  }
}

