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
  uiMode: "auto", // automatic terminal detection, or an explicit mobile/desktop UI
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
// `advanced: true` renders the control inside the collapsible 進階 group
// (collapsed on mobile, auto-opened on desktop by bindEvents) — the common
// visual knobs stay on the panel's first screen.
const DISPLAY_CONTROLS = [
  { key: "routeWidthScale", labelKey: "disp.routeWidthScale", min: 0.2, max: 3, step: 0.1, fmt: (x) => x.toFixed(1) + "×" },
  { key: "riddenOpacity", labelKey: "disp.riddenOpacity", min: 0, max: 1, step: 0.05, fmt: (x) => x.toFixed(2) },
  { key: "dimOpacity", labelKey: "disp.dimOpacity", min: 0, max: 1, step: 0.02, fmt: (x) => x.toFixed(2) },
  { key: "mapOpacity", labelKey: "disp.mapOpacity", min: 0, max: 1, step: 0.05, fmt: (x) => x.toFixed(2) },
  { key: "terminalRadius", labelKey: "disp.terminalRadius", min: 3, max: 20, step: 1, fmt: (x) => x + "px", advanced: true },
  { key: "stopRadius", labelKey: "disp.stopRadius", min: 2, max: 16, step: 1, fmt: (x) => (x * 0.4).toFixed(1) + "px", advanced: true },
  { key: "passRadius", labelKey: "disp.passRadius", min: 1, max: 12, step: 1, fmt: (x) => x + "px", advanced: true },
  { key: "markerStrokeScale", labelKey: "disp.markerStrokeScale", min: 0.5, max: 3, step: 0.1, fmt: (x) => x.toFixed(1) + "×", advanced: true },
  { key: "focusBoost", labelKey: "disp.focusBoost", min: 0, max: 6, step: 1, fmt: (x) => "+" + x, advanced: true },
  { key: "fitCurvePrecision", labelKey: "disp.fitCurvePrecision", min: 0.5, max: 2, step: 0.1, fmt: (x) => x.toFixed(1) + "×", manualFitRebuild: true, advanced: true },
  { key: "fitCurveMinRadius", labelKey: "disp.fitCurveMinRadius", min: 200, max: 30000, step: 100, fmt: formatFitDistance, manualFitRebuild: true, advanced: true },
  { key: "fitCurveMinDetail", labelKey: "disp.fitCurveMinDetail", min: 100, max: 20000, step: 100, fmt: formatFitDistance, manualFitRebuild: true, advanced: true },
  { key: "fitCurveMaxDeviation", labelKey: "disp.fitCurveMaxDeviation", min: 100, max: 30000, step: 100, fmt: formatFitDistance, manualFitRebuild: true, advanced: true },
];
// Checkbox toggles for the submenu (booleans, rendered under the sliders).
// refreshNames toggles change how station names annotate (kana / romaji /
// Chinese readings) — they push their state into I18N and refresh the on-map
// endpoint labels; popups/tooltips rebuild per interaction anyway.
const DISPLAY_TOGGLES = [
  { key: "showFullCrossDay", labelKey: "disp.fullCrossDay", rebuild: false },
  // Debug overlays (fit-curve wireframe, hover hit regions) are desktop
  // diagnosis tools — they live in the 進階 group.
  { key: "showFitCurves", labelKey: "disp.fitCurves", rebuild: false, advanced: true },
  { key: "showHoverRegions", labelKey: "disp.hoverRegions", rebuild: false, advanced: true },
  // Kana readings only exist for Japanese stations — the row hides in Taiwan
  // mode via the shared [data-country] visibility pass.
  { key: "nameReadingKana", labelKey: "disp.nameReadingKana", rebuild: false, refreshNames: true, country: "jp" },
  { key: "nameReadingRomaji", labelKey: "disp.nameReadingRomaji", rebuild: false, refreshNames: true },
  { key: "nameReadingZh", labelKey: "disp.nameReadingZh", rebuild: false, refreshNames: true },
];

// Push the current reading-toggle state into I18N so placeName()/nameReadings()
// annotate accordingly everywhere (labels, popups, tooltips).
function pushNameReadingPrefs() {
  if (window.I18N && typeof I18N.setNameReadings === "function")
    I18N.setNameReadings({
      kana: DISPLAY.nameReadingKana,
      romaji: DISPLAY.nameReadingRomaji,
      zh: DISPLAY.nameReadingZh,
    });
}

// Until the user explicitly customizes the reading toggles, they track the UI
// language (the pre-toggle behavior). Called at boot and on language switch.
function syncNameReadingDefaultsToLang(lang) {
  if (!DISPLAY.nameReadingsCustomized) {
    // The language→default-readings rule lives in i18n.js so the pre-boot
    // fallback (activeReadingPrefs) and this seed can never drift.
    const defaults = I18N.localeDefaultReadingPrefs(lang);
    DISPLAY.nameReadingKana = defaults.kana;
    DISPLAY.nameReadingRomaji = defaults.romaji;
    DISPLAY.nameReadingZh = defaults.zh;
    DISPLAY_TOGGLES.forEach((cfg) => {
      if (cfg.refreshNames && cfg._input)
        cfg._input.checked = Boolean(DISPLAY[cfg.key]);
    });
  }
  pushNameReadingPrefs();
}
const THEME_MEDIA = window.matchMedia("(prefers-color-scheme: dark)");
const REDUCED_MOTION_MEDIA = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
);
let activeResolvedTheme = null;
let themeSelectReady = false;
let themeTransitionTimer = null;
const THEME_TRANSITION_MS = 460;

const UI_MODE_VALUES = ["auto", "mobile", "desktop"];
const UI_MODE_COMPACT_MEDIA = window.matchMedia("(max-width: 599px)");
let uiModeSelectReady = false;
let uiModeResizeRaf = null;

// Browser APIs intentionally expose a device class, not a precise hardware
// model. Combine UA-CH/UA hints with input capabilities so iPadOS desktop-UA
// devices and Android tablets still receive touch-first interaction.
function detectTerminalClass() {
  const nav = typeof navigator === "undefined" ? {} : navigator;
  const ua = nav.userAgent || "";
  const uaDataMobile = Boolean(nav.userAgentData && nav.userAgentData.mobile);
  const phone =
    uaDataMobile || /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua);
  if (phone) return "phone";
  const tablet =
    /iPad|Android(?!.*Mobile)/i.test(ua) ||
    (/Macintosh/i.test(ua) && Number(nav.maxTouchPoints) > 1) ||
    (Number(nav.maxTouchPoints) > 1 &&
      window.matchMedia("(any-pointer: coarse)").matches &&
      window.matchMedia("(hover: none)").matches);
  return tablet ? "tablet" : "computer";
}

function resolveUiMode(preference = DISPLAY.uiMode) {
  if (preference === "mobile" || preference === "desktop") return preference;
  return detectTerminalClass() !== "computer" || UI_MODE_COMPACT_MEDIA.matches
    ? "mobile"
    : "desktop";
}

function updateUiModeUi() {
  const select = document.getElementById("ui-mode-select");
  if (select)
    select.value = UI_MODE_VALUES.includes(DISPLAY.uiMode)
      ? DISPLAY.uiMode
      : "auto";
  const status = document.getElementById("ui-mode-status");
  if (!status || !window.I18N) return;
  const root = document.documentElement;
  const device = root.dataset.deviceClass || detectTerminalClass();
  const mode = root.dataset.uiMode || resolveUiMode();
  status.textContent = I18N.t("uiMode.status", {
    device: I18N.t(`uiMode.device.${device}`),
    mode: I18N.t(`uiMode.${mode}`),
  });
}

function applyUiMode({ persist = true } = {}) {
  if (!UI_MODE_VALUES.includes(DISPLAY.uiMode)) DISPLAY.uiMode = "auto";
  const root = document.documentElement;
  const previousMode = root.dataset.uiMode;
  const previousDevice = root.dataset.deviceClass;
  const device = detectTerminalClass();
  const resolved = resolveUiMode();
  root.dataset.deviceClass = device;
  root.dataset.uiPreference = DISPLAY.uiMode;
  root.dataset.uiMode = resolved;
  updateUiModeUi();
  if (persist) persistDisplaySettings();
  if (previousMode === resolved && previousDevice === device) return;
  const event =
    typeof window.CustomEvent === "function"
      ? new CustomEvent("n02-ui-mode-change", {
          detail: { preference: DISPLAY.uiMode, mode: resolved, device },
        })
      : new Event("n02-ui-mode-change");
  window.dispatchEvent(event);
}

function setupUiModeSelect() {
  if (uiModeSelectReady) return;
  const select = document.getElementById("ui-mode-select");
  if (!select) return;
  uiModeSelectReady = true;
  select.addEventListener("change", () => {
    DISPLAY.uiMode = UI_MODE_VALUES.includes(select.value)
      ? select.value
      : "auto";
    applyUiMode();
  });
  const refreshAutoMode = () => {
    if (DISPLAY.uiMode !== "auto" || uiModeResizeRaf) return;
    uiModeResizeRaf = requestAnimationFrame(() => {
      uiModeResizeRaf = null;
      applyUiMode({ persist: false });
    });
  };
  window.addEventListener("resize", refreshAutoMode);
  if (typeof UI_MODE_COMPACT_MEDIA.addEventListener === "function")
    UI_MODE_COMPACT_MEDIA.addEventListener("change", refreshAutoMode);
  else if (typeof UI_MODE_COMPACT_MEDIA.addListener === "function")
    UI_MODE_COMPACT_MEDIA.addListener(refreshAutoMode);
  updateUiModeUi();
}

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
  // Keep in sync with the index.html boot script, which writes the same
  // values before this module loads (light --ios-grouped, dark black).
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta)
    themeMeta.content = resolved === "dark" ? "#000000" : "#f2f2f7";
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
    map &&
    window.RailMap &&
    typeof RailMap.setBasemapTheme === "function";
  transitionDocumentTheme(resolved, animate);
  if (canUpdateMap) {
    // Always converge instead of gating on `changed`: our bookkeeping can
    // desync from the map's actually-installed theme (e.g. a system flip
    // racing boot), and RailMap dedupes a no-op switch cheaply.
    await RailMap.setBasemapTheme(resolved, { animate });
  }
}

function loadDisplaySettings() {
  try {
    const current = localStorage.getItem(DISPLAY_STORAGE_KEY);
    const migrated = !current;
    const raw = current || localStorage.getItem(PREVIOUS_DISPLAY_STORAGE_KEY);
    if (raw) {
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
    }
  } catch (err) {
    // Non-fatal: disabled storage just means defaults.
  }
  // Reading toggles: non-customized users keep following the UI language;
  // customized users get their saved choice pushed into I18N as-is.
  syncNameReadingDefaultsToLang(
    window.I18N && typeof I18N.getLang === "function"
      ? I18N.getLang()
      : "zh-Hant",
  );
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
  // Solid ⇄ dashed for cross-day halves is two layer filters, not a rebuild.
  if (window.RailMap && RailMap.setCrossDayDash)
    RailMap.setCrossDayDash(!DISPLAY.showFullCrossDay);
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
let fitCurveOverlapNote = null;
let fitCurvePendingHint = null;
// Also refreshes the two helper texts (coverage note + not-yet-applied hint):
// app-events.js re-invokes this on every language change, so their copy stays
// in the current language without a panel rebuild.
function updateFitCurveRebuildButton() {
  if (!fitCurveRebuildButton) return;
  fitCurveRebuildButton.textContent = I18N.t("disp.rebuildFitCurves");
  fitCurveRebuildButton.dataset.pending = fitCurveSettingsDirty ? "true" : "false";
  fitCurveRebuildButton.classList.toggle("pending", fitCurveSettingsDirty);
  if (fitCurveOverlapNote)
    fitCurveOverlapNote.textContent = I18N.t("disp.fitCurveOverlapNote");
  if (fitCurvePendingHint) {
    fitCurvePendingHint.textContent = I18N.t("disp.fitCurvePendingHint");
    fitCurvePendingHint.hidden = !fitCurveSettingsDirty;
  }
}

// Build + wire the submenu sliders. Safe to call once after the DOM exists.
function setupDisplaySettingsPanel() {
  const body = document.getElementById("display-settings-body");
  if (!body) return;
  body.innerHTML = "";
  // The 進階 group: marker geometry, fit-curve tuning and debug overlays.
  // Collapsed on mobile; bindEvents auto-opens it on desktop.
  const advanced = document.createElement("details");
  advanced.className = "display-advanced collapse-desktop-open";
  const advancedSummary = document.createElement("summary");
  advancedSummary.className = "subhead-toggle";
  advancedSummary.dataset.i18n = "disp.advanced";
  advancedSummary.textContent = I18N.t("disp.advanced");
  advanced.appendChild(advancedSummary);
  const homeOf = (cfg) => (cfg.advanced ? advanced : body);
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
    homeOf(cfg).appendChild(wrap);
    cfg._input = input;
    cfg._val = val;
    cfg._name = name;
  });
  // Scope note: fitting only ever runs on overlap corridors, so the debug
  // overlay showing zero curves on a no-overlap day is expected behavior,
  // not a solver failure.
  fitCurveOverlapNote = document.createElement("p");
  fitCurveOverlapNote.className = "display-note fit-curve-overlap-note";
  advanced.appendChild(fitCurveOverlapNote);
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
  rebuildWrap.appendChild(fitCurveRebuildButton);
  // Fit sliders only mark themselves dirty; nothing changes until the
  // rebuild button applies them. Say so explicitly while dirty.
  fitCurvePendingHint = document.createElement("p");
  fitCurvePendingHint.className = "display-note fit-curve-pending-hint";
  fitCurvePendingHint.hidden = true;
  rebuildWrap.appendChild(fitCurvePendingHint);
  updateFitCurveRebuildButton();
  // The rebuild button applies the fit-curve sliders, all of which live in
  // the 進階 group.
  advanced.appendChild(rebuildWrap);
  DISPLAY_TOGGLES.forEach((cfg) => {
    const wrap = document.createElement("label");
    wrap.className = "inline-check display-toggle";
    if (cfg.country) wrap.dataset.country = cfg.country;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(DISPLAY[cfg.key]);
    const span = document.createElement("span");
    span.textContent = I18N.t(cfg.labelKey);
    input.addEventListener("change", () => {
      DISPLAY[cfg.key] = input.checked;
      if (cfg.refreshNames) {
        // First explicit choice pins the toggles: they stop tracking the UI
        // language from here on (persisted with the rest of DISPLAY).
        DISPLAY.nameReadingsCustomized = true;
        pushNameReadingPrefs();
      }
      applyDisplaySettings({ rebuild: cfg.rebuild !== false });
      // Reading changes redraw the on-map endpoint labels immediately;
      // popups/tooltips pick the new setting up on their next build.
      if (cfg.refreshNames && typeof updateEndpointLabels === "function")
        updateEndpointLabels();
    });
    wrap.appendChild(input);
    wrap.appendChild(span);
    homeOf(cfg).appendChild(wrap);
    cfg._input = input;
    cfg._span = span;
  });
  body.appendChild(advanced);
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
      // Back to language-tracking reading defaults (customized flag reset).
      syncNameReadingDefaultsToLang(
        window.I18N && typeof I18N.getLang === "function"
          ? I18N.getLang()
          : "zh-Hant",
      );
      applyUiMode();
      applyDisplayTheme();
      applyDisplaySettings();
    });
  }
}
