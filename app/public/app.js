// =========================================================================
//  app.js — N02 Limited Express Train Manager (frontend)
//
//  Single-file Leaflet + deck.gl map editor. Loads rail/station data and the
//  saved train store from the Express backend, solves each route client-side
//  (Dijkstra over the N02 rail graph) and renders routes, stops and
//  pass-through stations. Auto-saves edits back to the server store.
//
//  CONTENTS  (search "§N." to jump to a section)
//
//   §1  Performance instrumentation (opt-in via PERF_DEBUG)
//   §2  App-wide constants: protocol/schema, storage keys, map bounds, style defaults
//   §3  Display-tuning settings & control panel (localStorage-only, not in store)
//   §4  Display-feature helpers (basemap opacity, endpoint labels, deck hover/tooltip)
//   §5  Route-geometry simplification (Douglas-Peucker pre-render decimation)
//   §6  Date grouping, sorting & UI date-state persistence
//   §7  Backend API client & app-data loading
//   §8  Core mutable state & cached DOM element references
//   §9  Boot sequence (runs once on DOMContentLoaded)
//   §10 Live refresh via Server-Sent Events + background route-graph prebuild
//   §11 Station resolution & generic data accessors
//   §12 Train store: built-in defaults & debounced server autosave
//   §13 File System Access API & IndexedDB key/value (file-handle) store
//   §14 Persistent route-geometry cache (IndexedDB, namespaced by rail-content hash)
//   §15 Local JSON file open / save (File System Access, with download fallback)
//   §16 Progressive load / import engine (one train at a time, time-budgeted)
//   §17 Train CRUD (add / update / duplicate / delete / move / visibility)
//   §18 Canonical export & serialization (single definition of the saved schema)
//   §19 Import parsing & normalization (lenient inbound -> canonical shape)
//   §20 Blank-train factory, id helpers & persist/render glue
//   §21 Map initialization (Leaflet + deck.gl overlay, tile layers, panes)
//   §22 Event binding (all sidebar / editor / map UI event handlers)
//   §23 Render orchestration & sidebar (date bar + train list)
//   §24 Editor panel & stops table (per-train field + stop editing)
//   §25 Route rebuild & layer / marker rendering (SVG + deck record assembly)
//   §26 Parallel-offset overlap display & deck.gl record builders
//   §27 Route matching, template keys, feature generation & full graph construction
//   §28 On-demand regional route graphs & rail-section spatial index
//   §29 Route solving: institution/edge rules, route hints & Dijkstra
//   §30 Geometry helpers & matched-route feature assembly
//   §31 Visual styling (single source of truth) & render primitives
//   §32 Map fit, bounds clamping & import progress UI
//   §33 Validation (export textarea, store, branch-leak, per-train)
//   §34 Popups & tooltips (stop / route-segment HTML)
//   §35 Misc utilities (status line, color, portable HTML, download, HTML escaping)
// =========================================================================

const LOCAL_JSON_FILENAME = "n02-train-store.json";

// =========================================================================
//  §1.  Performance instrumentation (opt-in via PERF_DEBUG)
// =========================================================================

// ---- Performance instrumentation (default OFF) --------------------------
// Flip PERF_DEBUG to true (or run `window.PERF_DEBUG = true` before load) to
// log how long the hot rendering / serialization / import paths take and to
// surface any main-thread "long task" (>50ms) via PerformanceObserver. The
// harness is a no-op when disabled so it costs nothing in normal use.
let PERF_DEBUG = typeof window !== "undefined" && window.PERF_DEBUG === true;

function perfMeasure(label, fn) {
  if (!PERF_DEBUG) return fn();
  const start = performance.now();
  const result = fn();
  const end = performance.now();
  console.log(`[perf] ${label}: ${(end - start).toFixed(1)}ms`);
  return result;
}

// Long-task monitor: warns whenever the main thread is blocked >50ms, which
// is exactly what makes dragging / scrolling feel janky. Only attached when
// PERF_DEBUG is on so it never adds observer overhead in production.
function installLongTaskObserver() {
  if (!PERF_DEBUG || typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 50) {
          console.warn("[long-task]", `${entry.duration.toFixed(1)}ms`, entry);
        }
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch (err) {
    console.warn("Long-task observer unavailable.", err);
  }
}

// =========================================================================
//  §2.  App-wide constants: protocol/schema, storage keys, map bounds, style defaults
// =========================================================================

// The server-side data/train-store.json (served at /api/train-store) is now
// the single source of truth: the editor auto-saves there and loads from it
// on every boot, replacing the old browser-localStorage backup.
const TRAIN_STORE_API = "train-store";
const SERVER_AUTOSAVE_DEBOUNCE_MS = 450;
const FILE_HANDLE_DB_NAME = "n02-train-store-file-handle-db";
const FILE_HANDLE_STORE_NAME = "handles";
const FILE_HANDLE_KEY = "local-json-file-handle";
const ROUTE_CACHE_DB_NAME = "n02-route-geometry-cache";
const ROUTE_CACHE_STORE_NAME = "routes";
const JAPAN_MAIN_ISLANDS_BOUNDS = [
  [30.85, 129.1],
  [45.75, 146.2],
];
// All-Japan territory used to clamp the map: main islands plus Okinawa /
// the Nansei (southwest) islands — south to ~Yonaguni (24°N / 122.8°E).
const JAPAN_FULL_TERRITORY_BOUNDS = [
  [24.0, 122.8],
  [45.75, 146.2],
];

// Single source of truth for protocol/schema constants reused across the app.
// Stores are now written as 1.3 (adds per-train `date`), but 1.2 (no date)
// is still accepted on import/load for backward compatibility.
const SCHEMA_VERSION = "1.3";
const ACCEPTED_SCHEMA_VERSIONS = ["1.2", "1.3"];
// Sentinel selectedDate value: show the combined "all trains" list.
const ALL_DATES = "__all__";
// Bucket for trains whose date could neither be supplied nor inferred.
const UNDATED = "undated";
const DEFAULT_TRAIN_COLOR = "#d9364f";
// Single source of truth for the default route style numbers (railprint's
// glowing-line spec: ridden lines draw from a 4px base, zoom-scaled).
const DEFAULT_TRAIN_WEIGHT = 4;
const DEFAULT_UNRIDDEN_OPACITY = 0.48;

// N02 "institution type" (事業者種別, field N02_002) classifies a line's
// operator. The default route policy allows all five classes; a train may
// narrow it (e.g. ["1","2"] = JR-only). N02_INSTITUTION_TYPE_CODES is the
// validation whitelist for codes supplied in imported route policies.
// (Grouped here with the other app-wide protocol constants; these two
// previously lived down in the route-simplification block, far from kin.)
//   1 = JR 新幹線    2 = JR 在来線    3 = 公営鉄道
//   4 = 民営鉄道     5 = 第三セクター
const DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES = ["1", "2", "3", "4", "5"];
const N02_INSTITUTION_TYPE_CODES = new Set(
  DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES,
);

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
const DISPLAY_STORAGE_KEY = "n02-train-manager-display-settings-v2";
const DISPLAY_DEFAULTS = {
  routeWidthScale: 1, // multiplies each train's route line width
  riddenOpacity: 1, // opacity of ridden (ride_segment=true) route segments (railprint: 1)
  // (unriddenOpacity was removed: unridden intervals are hidden entirely now,
  // so the slider was a do-nothing control lying to the user.)
  dimOpacity: 0.18, // opacity of trains not on the selected date
  terminalRadius: 6, // px radius (at z12) of origin / destination markers
  stopRadius: 5, // px radius (at z12) of stop markers (railprint ridden dot = 5 @ z12)
  passRadius: 3, // px radius (at z12) of pass-through markers (railprint unridden dot = 3 @ z12)
  markerStrokeScale: 1, // multiplies every marker's stroke width
  focusBoost: 2, // extra line width / marker radius for the selected train
  mapOpacity: 1, // basemap visibility; lower fades the map toward pure white (railprint: no fade)
  onlyEndpoints: false, // show only the trip's first origin + last destination
};
// Live working copy (mutated by the UI; seeded from localStorage on boot).
const DISPLAY = { ...DISPLAY_DEFAULTS };
// Slider definitions for the "顯示調節" submenu (built dynamically in JS so the
// HTML stays tiny and every control is wired the same way).
const DISPLAY_CONTROLS = [
  { key: "routeWidthScale", labelKey: "disp.routeWidthScale", min: 0.2, max: 3, step: 0.1, fmt: (x) => x.toFixed(1) + "×" },
  { key: "riddenOpacity", labelKey: "disp.riddenOpacity", min: 0, max: 1, step: 0.05, fmt: (x) => x.toFixed(2) },
  { key: "dimOpacity", labelKey: "disp.dimOpacity", min: 0, max: 1, step: 0.02, fmt: (x) => x.toFixed(2) },
  { key: "terminalRadius", labelKey: "disp.terminalRadius", min: 3, max: 20, step: 1, fmt: (x) => x + "px" },
  { key: "stopRadius", labelKey: "disp.stopRadius", min: 2, max: 16, step: 1, fmt: (x) => x + "px" },
  { key: "passRadius", labelKey: "disp.passRadius", min: 1, max: 12, step: 1, fmt: (x) => x + "px" },
  { key: "markerStrokeScale", labelKey: "disp.markerStrokeScale", min: 0.5, max: 3, step: 0.1, fmt: (x) => x.toFixed(1) + "×" },
  { key: "focusBoost", labelKey: "disp.focusBoost", min: 0, max: 6, step: 1, fmt: (x) => "+" + x },
  { key: "mapOpacity", labelKey: "disp.mapOpacity", min: 0, max: 1, step: 0.05, fmt: (x) => x.toFixed(2) },
];
// Checkbox toggles for the submenu (booleans, rendered under the sliders).
const DISPLAY_TOGGLES = [
  { key: "onlyEndpoints", labelKey: "disp.onlyEndpoints" },
];

function loadDisplaySettings() {
  try {
    const raw = localStorage.getItem(DISPLAY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const k of Object.keys(DISPLAY_DEFAULTS)) {
        const def = DISPLAY_DEFAULTS[k];
        const v = parsed[k];
        if (typeof def === "boolean") {
          if (typeof v === "boolean") DISPLAY[k] = v;
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
function applyDisplaySettings() {
  persistDisplaySettings();
  applyMapOpacity();
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
      applyDisplaySettings();
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
      applyDisplaySettings();
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
      applyDisplaySettings();
    });
  }
}

// =========================================================================
//  §4.  Display-feature helpers (basemap opacity, endpoint labels, deck hover/tooltip)
// =========================================================================

// ------------------------------------------------------------------------
// Helpers backing the new display features: basemap opacity, the
// "only first/last endpoint" toggle, and the hover / selection station-name
// and line-name labels. Kept together so the feature is easy to find.
// ------------------------------------------------------------------------
function applyMapOpacity() {
  if (!map || !window.RailMap) return;
  const v = Math.max(0, Math.min(1, Number(DISPLAY.mapOpacity)));
  // The slider now drives a white fade layer ABOVE the basemap (railprint's
  // positron needs no fading, so the default is fully visible = fade 0).
  RailMap.setFadeOpacity(1 - v);
}

// The very first origin + the very last destination among the given trains.
// Trip order = index in the canonical store (legs are built in travel order).
// The id→index map is built once per call instead of an Array.indexOf per
// train (which made this O(n²) and it runs on every hover change / zoomend).
function computeGlobalEndpoints(trains) {
  if (!trains || !trains.length) return { firstId: null, lastId: null };
  const orderById = new Map();
  trainStore.trains.forEach((t, i) => orderById.set(t.id, i));
  const tripIndex = (t) => {
    const i = orderById.get(t.id);
    return i === undefined ? Number.MAX_SAFE_INTEGER : i;
  };
  let first = trains[0];
  let last = trains[0];
  let fi = tripIndex(first);
  let li = tripIndex(last);
  trains.forEach((t) => {
    const idx = tripIndex(t);
    if (idx < fi) {
      fi = idx;
      first = t;
    }
    if (idx > li) {
      li = idx;
      last = t;
    }
  });
  return { firstId: first.id, lastId: last.id };
}

// Endpoints for the current view scope. With a concrete date selected, the
// "only endpoints" toggle shows THAT day's first origin + last destination;
// with "全部" showing it falls back to the whole trip's global endpoints.
function computeScopedEndpoints(trains) {
  if (selectedDate !== ALL_DATES) {
    const dayTrains = (trains || []).filter(
      (t) => getTrainDate(t) === selectedDate,
    );
    if (dayTrains.length) return computeGlobalEndpoints(dayTrains);
  }
  return computeGlobalEndpoints(trains);
}

// When the "only endpoints" toggle is on, allow only the trip's first origin
// marker and last destination marker; otherwise allow everything.
function passesOnlyEndpoints(endpoints, train, stopFeature) {
  if (!DISPLAY.onlyEndpoints) return true;
  const st = stopFeature.properties && stopFeature.properties.stop_type;
  if (train.id === endpoints.firstId && st === "origin") return true;
  if (train.id === endpoints.lastId && st === "destination") return true;
  return false;
}

// On-map origin/destination name labels come from two sources: (1) whenever a
// concrete date is selected, that day's very first origin ("起點") and very last
// destination ("終點") are ALWAYS labelled, so picking a date immediately shows
// where the day begins and ends; (2) the hovered train wins, otherwise the
// selected train, keeps its own endpoints labelled. Overlapping labels are
// pushed apart by layoutEndpointLabels() below — most visibly on a round-trip
// day (e.g. 沼津→沼津 / 札幌→札幌) whose start and end sit on the SAME point.
let hoverLabelTrainId = null;

// One reusable canvas 2D context to measure label text width without forcing a
// DOM reflow (used by the overlap-avoidance layout).
let _labelMeasureCtx = null;
function measureLabelTextWidth(text) {
  if (!_labelMeasureCtx) {
    const cnv = document.createElement("canvas");
    _labelMeasureCtx = cnv.getContext("2d");
    _labelMeasureCtx.font =
      "700 11px system-ui, -apple-system, 'Segoe UI', sans-serif";
  }
  return _labelMeasureCtx.measureText(text || "").width;
}

// Build one label descriptor for a train's origin/destination stop, or null when
// the stop can't be resolved. `dayEndpoint` adds a 起點/終點 badge + emphasis.
function buildEndpointLabelSpec(train, kind, opts = {}) {
  const stop = (train.stops || []).find((x) => x.stop_type === kind);
  if (!stop) return null;
  const feature = getStopFeature(stop, train);
  if (!feature) return null;
  const name = I18N.placeName(feature.properties.name || stopName(stop));
  if (!name) return null;
  const latlng = toLatLng(feature);
  const time = kind === "origin" ? stop.departure : stop.arrival;
  const timeTag = I18N.t(kind === "origin" ? "tag.dep" : "tag.arr");
  const badgeText = opts.dayEndpoint
    ? I18N.t(kind === "origin" ? "tag.start" : "tag.end")
    : "";
  const badgeHtml = badgeText
    ? `<span class="station-label-badge">${escapeHtml(badgeText)}</span>`
    : "";
  const timeHtml = time
    ? ` <span class="station-label-time">${escapeHtml(timeTag)} ${escapeHtml(time)}</span>`
    : "";
  const plain =
    (badgeText ? badgeText + " " : "") +
    name +
    (time ? ` ${timeTag} ${time}` : "");
  return {
    latlng,
    tid: train.id,
    html: `${badgeHtml}${escapeHtml(name)}${timeHtml}`,
    key: `${latlng[0].toFixed(5)},${latlng[1].toFixed(5)}|${kind}`,
    dayEndpoint: !!opts.dayEndpoint,
    // Estimated rendered width (px): text + horizontal padding (+ badge chip).
    width: Math.min(300, measureLabelTextWidth(plain) + (badgeText ? 34 : 16)),
  };
}

function updateEndpointLabels() {
  if (!map) return;
  endpointLabelMarkers.forEach((m) => m.remove());
  endpointLabelMarkers = [];

  const specs = [];
  const seen = new Set();
  const add = (spec) => {
    if (!spec || seen.has(spec.key)) return;
    seen.add(spec.key);
    specs.push(spec);
  };

  // (1) Selected day's first origin + last destination — always labelled.
  if (selectedDate !== ALL_DATES) {
    const ep = computeScopedEndpoints(trainStore.trains);
    const firstTrain =
      ep.firstId && trainStore.trains.find((t) => t.id === ep.firstId);
    const lastTrain =
      ep.lastId && trainStore.trains.find((t) => t.id === ep.lastId);
    if (firstTrain && firstTrain.visible !== false)
      add(buildEndpointLabelSpec(firstTrain, "origin", { dayEndpoint: true }));
    if (lastTrain && lastTrain.visible !== false)
      add(buildEndpointLabelSpec(lastTrain, "destination", { dayEndpoint: true }));
  }

  // (2) Hovered / selected train's own endpoints.
  const id = hoverLabelTrainId || selectedTrainId;
  if (id) {
    const train = trainStore.trains.find((t) => t.id === id);
    if (train && train.visible !== false) {
      const dateActive = selectedDate !== ALL_DATES;
      const offDate =
        mapFollowsSelectedDate &&
        dateActive &&
        getTrainDate(train) !== selectedDate;
      if (!offDate) {
        add(buildEndpointLabelSpec(train, "origin"));
        add(buildEndpointLabelSpec(train, "destination"));
      }
    }
  }

  if (!specs.length) return;

  // Non-interactive DOM markers (pointer-events:none) so they never block
  // route/marker picking. MapLibre markers track their lng/lat through
  // pan/zoom automatically; the overlap layout only recomputes on re-render.
  layoutEndpointLabels(specs).forEach((spec) => {
    const el = document.createElement("div");
    el.className =
      (spec.dayEndpoint
        ? "station-label station-label--endpoint"
        : "station-label") +
      " station-label--" +
      spec.direction;
    // Hover spotlight: while a train is hovered, other trains' endpoint
    // labels fade with the rest of the map (mirrors railmap's HOVER_DIM).
    if (hoverLabelTrainId && spec.tid !== hoverLabelTrainId)
      el.style.opacity = "0.25";
    el.innerHTML = spec.html;
    const marker = new maplibregl.Marker({
      element: el,
      anchor: spec.direction === "top" ? "bottom" : "top",
      offset: spec.offset,
    })
      .setLngLat([spec.latlng[1], spec.latlng[0]])
      .addTo(map);
    endpointLabelMarkers.push(marker);
  });
}

// Overlap-avoidance for the endpoint labels: each label is placed just above or
// just below its station dot, alternating and stacking outward so labels that
// would collide get pushed apart and all stay readable. Pure pixel-space layout;
// relative distances only change on zoom and the labels are rebuilt on every
// marker render (including the zoomend handler), so no per-pan work is needed.
function layoutEndpointLabels(specs) {
  const BASE = 10; // gap from the dot to the first label
  const H = 20; // estimated label box height (single line)
  const PAD = 4; // gap kept between neighbouring boxes
  const placed = [];
  const hits = (a, b) =>
    a.x1 < b.x2 + PAD && a.x2 > b.x1 - PAD && a.y1 < b.y2 + PAD && a.y2 > b.y1 - PAD;
  specs.forEach((spec) => {
    const p = map
      ? map.project([spec.latlng[1], spec.latlng[0]])
      : { x: 0, y: 0 };
    const halfW = spec.width / 2;
    let picked = null;
    for (let k = 0; k < 8 && !picked; k++) {
      const step = BASE + k * (H + PAD);
      // Try above the dot first, then below, at increasing distance.
      for (const cand of [
        { direction: "top", offY: -step },
        { direction: "bottom", offY: step },
      ]) {
        const y1 =
          cand.direction === "top" ? p.y + cand.offY - H : p.y + cand.offY;
        const y2 =
          cand.direction === "top" ? p.y + cand.offY : p.y + cand.offY + H;
        const box = { x1: p.x - halfW, x2: p.x + halfW, y1, y2 };
        if (!placed.some((q) => hits(box, q))) {
          placed.push(box);
          picked = { direction: cand.direction, offset: [0, cand.offY] };
          break;
        }
      }
    }
    if (!picked)
      picked = { direction: "top", offset: [0, -(BASE + 8 * (H + PAD))] };
    spec.direction = picked.direction;
    spec.offset = picked.offset;
  });
  return specs;
}

// deck.gl hover -> mirror the hovered train into the endpoint labels.
function handleDeckHover(id) {
  hoverLabelTrainId = id || null;
  updateEndpointLabels();
}

// deck.gl floating tooltip: a marker shows just its station name; a route
// segment shows the line name plus its origin -> destination endpoints.
function deckGetTooltip(info) {
  const o = info && info.object;
  if (!o) return null;
  const style = {
    background: "rgba(30,37,44,0.92)",
    color: "#fff",
    fontSize: "11px",
    fontWeight: "700",
    padding: "3px 7px",
    borderRadius: "4px",
    boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
  };
  if (o.category) {
    const pr = (o.feature && o.feature.properties) || {};
    const name = pr.name || "";
    if (!name) return null;
    const times = [];
    if (pr.arrival) times.push(`${I18N.t("tag.arr")} ${escapeHtml(pr.arrival)}`);
    if (pr.departure) times.push(`${I18N.t("tag.dep")} ${escapeHtml(pr.departure)}`);
    const timeHtml = times.length ? `<br>${times.join("\u3000")}` : "";
    return { html: `<b>${escapeHtml(I18N.placeName(name))}</b>${timeHtml}`, style };
  }
  const t = o.train;
  if (!t) return null;
  const line = t.number || "";
  const meta = trainTypeCompanyLabel(t);
  const origin = t.origin || "";
  const dest = t.destination || "";
  const oStop = (t.stops || []).find((x) => x.stop_type === "origin");
  const dStop = (t.stops || []).find((x) => x.stop_type === "destination");
  const times = [];
  if (oStop && oStop.departure) times.push(`${I18N.t("tag.dep")} ${escapeHtml(oStop.departure)}`);
  if (dStop && dStop.arrival) times.push(`${I18N.t("tag.arr")} ${escapeHtml(dStop.arrival)}`);
  const numHtml = meta
    ? `<br><span style="opacity:0.85">${escapeHtml(meta)}</span>`
    : "";
  const timeHtml = times.length ? `<br>${times.join("\u3000")}` : "";
  // Hovering an overlapped stretch: show which parallel lane this train is
  // (date order, left/top = earliest) and hint that sliding sideways switches.
  const overlapHtml =
    o.overlapCount > 1
      ? `<br><span style="opacity:0.8">\u21c6 ${I18N.t("tip.overlap", {
          slot: o.overlapSlot + 1,
          count: o.overlapCount,
        })}</span>`
      : "";
  // The visible box is an INNER element shifted above the cursor via CSS; the
  // OUTER element is positioned by deck.gl through its own transform, so we must
  // NOT set transform on it (doing so wipes deck's positioning and hides the
  // popup entirely — the bug this replaces).
  return {
    html: `<div class="map-line-tip"><b>${escapeHtml(I18N.trainName(line))}</b>${numHtml}<br>${escapeHtml(I18N.placeName(origin))} \u2192 ${escapeHtml(I18N.placeName(dest))}${timeHtml}${overlapHtml}</div>`,
    style: { background: "transparent", boxShadow: "none", padding: "0", margin: "0" },
  };
}

// GPU route rendering. Train routes, markers, the national rail network and
// the basemap all render in MapLibre GL (see railmap.js — the railprint-style
// map core). The old Leaflet SVG fallback path is gone with Leaflet itself.

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  return m
    ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
    : [217, 54, 79];
}

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

// Route lines for a feature, computed once and cached on the feature object
// (WeakMap). Each entry pairs the ORIGINAL (normalized) line with the display
// simplification and the per-segment overlap keys:
//   orig    — the full normalized coordinate array (exact shared N02 coords),
//   keepIdx — ascending original indices Douglas-Peucker kept (null = all,
//             when ?simplify=0),
//   segKeys — routeCoordinateSegmentKey per ORIGINAL segment (segKeys[i] is
//             the direction-independent key of orig[i]→orig[i+1]).
// Overlap detection works on `orig`/`segKeys` — identical for every train
// sharing the same N02 track — while drawing uses the keepIdx subset. This
// way per-feature simplification differences can never fragment an overlap
// corridor (the old cause of parallel lanes breaking into little pieces).
const _routeLinePairCache = new WeakMap();
function getRouteLinePairs(feature) {
  let cached = _routeLinePairCache.get(feature);
  if (cached) return cached;
  cached = iterateGeometryLines(feature.geometry).map((orig) => {
    const segKeys = new Array(Math.max(0, orig.length - 1));
    for (let i = 0; i < orig.length - 1; i += 1)
      segKeys[i] = routeCoordinateSegmentKey(orig[i], orig[i + 1]);
    return {
      orig,
      keepIdx:
        ROUTE_SIMPLIFY_METERS > 0
          ? douglasPeuckerIndices(orig, ROUTE_SIMPLIFY_METERS)
          : null,
      segKeys,
    };
  });
  _routeLinePairCache.set(feature, cached);
  return cached;
}

// =========================================================================
//  §6.  Date grouping, sorting & UI date-state persistence
// =========================================================================

// ------------------------------------------------------------------------
// Date grouping helpers. A train belongs to exactly one date bucket via its
// `date` field ("YYYY-MM-DD" or UNDATED). Every per-date / all-trains view is
// derived from the single `trainStore.trains` array, never stored separately,
// so the daily lists and the combined list can never drift out of sync.
// ------------------------------------------------------------------------
function isValidDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return true;
}

// Coerce arbitrary input to a canonical "YYYY-MM-DD" string, or null when it
// is not a usable date. Tolerates surrounding whitespace and "/" separators.
function normalizeDateString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\//g, "-");
  return isValidDateString(trimmed) ? trimmed : null;
}

// Parse a leading YYYYMMDD out of a train id, e.g.
// "20260703_01_haruka_kix_shinosaka" -> "2026-07-03". Returns null if absent.
function inferDateFromTrainId(id) {
  const match = /(?:^|[^0-9])(\d{4})(\d{2})(\d{2})(?:[^0-9]|$)/.exec(
    String(id || ""),
  );
  if (!match) return null;
  const candidate = `${match[1]}-${match[2]}-${match[3]}`;
  return isValidDateString(candidate) ? candidate : null;
}

// Resolve a train's date with the documented precedence:
//   1. an explicit valid train.date,
//   2. the caller's fallback (the currently-selected concrete date),
//   3. a date parsed from the id,
//   4. UNDATED.
function normalizeTrainDate(train, fallbackDate = null) {
  const explicit = normalizeDateString(train && train.date);
  if (explicit) return explicit;
  const fallback = normalizeDateString(fallbackDate);
  if (fallback) return fallback;
  const inferred = inferDateFromTrainId(train && train.id);
  if (inferred) return inferred;
  return UNDATED;
}

// The date bucket a train currently lives in (defensive re-normalize).
function getTrainDate(train) {
  return normalizeTrainDate(train);
}

// Convert "HH:mm" (optionally "HH:mm+1" for a next-day time) to minutes from
// midnight. Returns null when the value is missing or unparseable so callers
// can push such trains to the end instead of crashing.
function parseTimeToMinutes(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})(?:\s*\+\s*(\d+))?/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const dayOffset = match[3] ? Number(match[3]) : 0;
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return dayOffset * 24 * 60 + hours * 60 + minutes;
}

// First meaningful departure time of a train, in minutes, following the
// documented priority. Returns Infinity when no departure exists so the
// train sorts last within its date.
function getTrainDepartureMinutes(train) {
  const stops = Array.isArray(train && train.stops) ? train.stops : [];
  if (!stops.length) return Infinity;
  const firstStopDep = parseTimeToMinutes(stops[0].departure);
  if (firstStopDep !== null) return firstStopDep;
  const originStop = stops.find((stop) => stop && stop.stop_type === "origin");
  if (originStop) {
    const originDep = parseTimeToMinutes(originStop.departure);
    if (originDep !== null) return originDep;
  }
  for (const stop of stops) {
    const dep = parseTimeToMinutes(stop && stop.departure);
    if (dep !== null) return dep;
  }
  return Infinity;
}

// Date sort key: real dates ascending, UNDATED always last.
function dateSortKey(date) {
  return date === UNDATED ? "￿" : date;
}

// Comparator implementing: date ASC, departure ASC (missing last), id ASC.
function compareTrainsByDateAndDeparture(a, b) {
  const dateA = dateSortKey(getTrainDate(a));
  const dateB = dateSortKey(getTrainDate(b));
  if (dateA < dateB) return -1;
  if (dateA > dateB) return 1;
  const depA = getTrainDepartureMinutes(a);
  const depB = getTrainDepartureMinutes(b);
  if (depA !== depB) return depA - depB;
  return String(a.id).localeCompare(String(b.id));
}

function sortTrainsByDateAndDeparture(trains) {
  return [...trains].sort(compareTrainsByDateAndDeparture);
}

// All date buckets currently in use, plus any manually-created empty dates,
// ordered earliest-first with UNDATED forced to the end.
function getAvailableDates(trains) {
  const set = new Set();
  (trains || []).forEach((train) => set.add(getTrainDate(train)));
  manualDates.forEach((date) => {
    const normalized = date === UNDATED ? UNDATED : normalizeDateString(date);
    if (normalized) set.add(normalized);
  });
  return [...set].sort((a, b) => {
    const ka = dateSortKey(a);
    const kb = dateSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function getTrainsForDate(trains, date) {
  return (trains || []).filter((train) => getTrainDate(train) === date);
}

// ---- selectedDate / manualDates persistence (pure UI state) -------------
// Kept in localStorage (not the train store) so the canonical store schema
// stays exactly { schema_version, trains:[...] } as required.
const UI_STATE_STORAGE_KEY = "n02-train-manager-ui-state";

function persistUiDateState() {
  try {
    localStorage.setItem(
      UI_STATE_STORAGE_KEY,
      JSON.stringify({
        selectedDate,
        manualDates,
        mapFollowsSelectedDate,
        focusZoomEnabled,
      }),
    );
  } catch (err) {
    // Non-fatal: private-mode / disabled storage just means no restore.
  }
}

// Returns true when a previously-saved selectedDate was restored, so the
// boot path knows whether to apply the "earliest date" first-run default.
function restoreUiDateState() {
  try {
    const raw = localStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.manualDates)) {
        manualDates = parsed.manualDates
          .map((d) => (d === UNDATED ? UNDATED : normalizeDateString(d)))
          .filter(Boolean);
      }
      if (typeof parsed.mapFollowsSelectedDate === "boolean")
        mapFollowsSelectedDate = parsed.mapFollowsSelectedDate;
      if (typeof parsed.focusZoomEnabled === "boolean")
        focusZoomEnabled = parsed.focusZoomEnabled;
      if (typeof parsed.selectedDate === "string") {
        selectedDate = parsed.selectedDate;
        return true;
      }
    }
  } catch (err) {
    // Ignore malformed saved UI state.
  }
  return false;
}

// Ensure selectedDate still points at something renderable after the train
// set changes (import / delete / boot). Never force-switches to the *last*
// date: keeps a still-valid selection, otherwise falls back to earliest.
function reconcileSelectedDate({ preferEarliestWhenAll = false } = {}) {
  const dates = getAvailableDates(trainStore.trains);
  if (selectedDate === ALL_DATES) {
    if (preferEarliestWhenAll && dates.length) selectedDate = dates[0];
    return;
  }
  if (!dates.includes(selectedDate)) {
    selectedDate = dates.length ? dates[0] : ALL_DATES;
  }
}

// =========================================================================
//  §7.  Backend API client & app-data loading
// =========================================================================

// Document-relative (not root-absolute) so every API call — including the
// train-store save/load — resolves next to index.html. This keeps the app
// working when it is served from a sub-path (e.g. behind a reverse proxy at
// /something/) instead of only from the domain root.
const API_BASE = "./api";
// A per-tab id sent with every store write (X-Client-Id). The server echoes it
// in the SSE "store-changed" event so this tab can ignore the write it just
// made and only react to changes from *other* sources (another tab, or an AI
// agent calling /api/agent/import).
const CLIENT_ID =
  (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
  `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const fetchJson = async (path) => {
  // Use the browser's default HTTP cache. The server sends a weak ETag +
  // Cache-Control: max-age on every dataset, so reloads revalidate to a 304 (or
  // serve straight from cache within max-age) instead of re-downloading the full
  // multi-MB payload. The old `cache: "no-store"` defeated all of that.
  const res = await fetch(`${API_BASE}/${path}`);
  if (!res.ok)
    throw new Error(`Failed to load ${path}: ${res.status} ${res.statusText}`);
  return res.json();
};

// Data is now served by the backend instead of being embedded in the page.
let railSectionsGeoJson,
  stationsGeoJson,
  defaultTrainStore,
  matchedRoutesGeoJson,
  matchedStopsGeoJson;
let stationCandidatesIndex;
// Tracks the in-flight (or resolved) rail-sections fetch. rail-sections.json is
// ~12 MB raw / 2.4 MB gzipped and is consumed ONLY by the route solver, which
// runs after the map is already on screen — so it is fetched in parallel with
// boot but never blocks first paint. ensureRailSectionsLoaded() awaits it right
// before the first solve.
let railSectionsReady = null;

async function loadAppData() {
  // Kick off the big solver-only dataset immediately, but do NOT block boot on
  // it — assign it to the module global as soon as it lands.
  railSectionsReady = fetchJson("rail-sections").then((data) => {
    railSectionsGeoJson = data;
    return data;
  });

  // Block first paint only on the small, render-critical datasets. `stations`
  // (3.3 MB / 456 KB gz) feeds the marker/station-resolution paths used by the
  // very first render, so it stays in the blocking set.
  [
    stationsGeoJson,
    defaultTrainStore,
    matchedRoutesGeoJson,
    matchedStopsGeoJson,
  ] = await Promise.all([
    fetchJson("stations"),
    fetchJson("default-trains"),
    fetchJson("matched-routes"),
    fetchJson("matched-stops"),
  ]);

  stationCandidatesIndex = buildStationCandidatesIndex(stationsGeoJson);

  // Surface a rail-sections failure instead of leaving an unhandled rejection;
  // ensureRailSectionsLoaded() will retry on demand before the first solve.
  railSectionsReady.catch((err) =>
    console.error(
      "rail-sections load failed during boot; will retry before first route solve.",
      err,
    ),
  );
}

// Guarantee the rail-sections dataset is present before any route solve. Awaits
// the background boot fetch; retries once if that fetch failed. Cheap and
// idempotent once the data is resident.
async function ensureRailSectionsLoaded() {
  if (railSectionsGeoJson) return railSectionsGeoJson;
  if (railSectionsReady) {
    try {
      await railSectionsReady;
    } catch (err) {
      /* fall through to a fresh retry below */
    }
  }
  if (!railSectionsGeoJson) {
    railSectionsReady = fetchJson("rail-sections").then((data) => {
      railSectionsGeoJson = data;
      return data;
    });
    await railSectionsReady;
  }
  return railSectionsGeoJson;
}
// =========================================================================
//  §8.  Core mutable state & cached DOM element references
// =========================================================================

let trainStore = { schema_version: SCHEMA_VERSION, trains: [] };
let selectedTrainId = null;
let focusedTrainId = null;
// Live maplibregl.Marker instances for the on-map origin/destination labels.
let endpointLabelMarkers = [];
// Which date the sidebar list is filtered to. ALL_DATES shows the combined
// "all trains" list; otherwise it is a concrete "YYYY-MM-DD" (or UNDATED).
let selectedDate = ALL_DATES;
// Dates the user created manually that may not yet have any train. Merged
// with the dates derived from trains when building the date-button bar.
let manualDates = [];
// When on, the map mirrors the sidebar date filter (only the selected date's
// trains draw). Off by default: the map stays controlled by each train's
// `visible` flag, matching the original behaviour.
let mapFollowsSelectedDate = false;
// Auto-focus: when on, picking a date zooms the map to that day's trains and
// picking a train zooms to that train. The toggle button turns it off so the
// map view stays put on selection (whether the pick came from a card or a
// route line).
// Defaults OFF: an auto-focus fitBounds animation forces a zoom change, and the
// zoomend handler then recomputes overlap offsets and re-uploads the full
// visible-route GeoJSON to the GPU — making a simple selection ~4 s instead of
// the ~270 ms it takes with focus off. Users who want it can still toggle it on
// (their choice is persisted in localStorage and restored on boot).
let focusZoomEnabled = false;
// The maplibregl.Map instance (created by initMap once the basemap + rail
// network package have loaded).
let map;
// Cached route render items (overlap-split run features) + viewport-cull state.
// The split runs / overlap slots depend only on the train data (not zoom/pan),
// so we memoise them and re-attach only the segments inside the current view.
let cachedRouteItems = null,
  cachedRouteSignature = "",
  cachedRouteOverlapSignature = "",
  cachedRouteDateActive = false;
// Pass-through markers number in the thousands and are sub-pixel clutter when
// zoomed out. Below this zoom they are not rendered at all, which removes a large
// chunk of per-frame Paint work (the trace showed Paint, not JS, is the
// bottleneck). A lightweight zoomend handler re-renders markers only when the
// view crosses this threshold — never on pan.
// NOTE: MapLibre zoom convention (world in one 512px tile at z0) — one level
// lower than the old Leaflet number for the same view.
const PASSTHROUGH_MIN_ZOOM = 9;
let cachedOrderedTrains = [];
let importInProgress = false;

// Cached DOM references. app.js is loaded at the END of <body> (no `defer`),
// so the document is fully parsed when this runs — getElementById here at
// module-eval time resolves every element synchronously, before first render.
const els = {
  list: document.getElementById("train-list"),
  dateBar: document.getElementById("date-bar"),
  listTitle: document.getElementById("train-list-title"),
  importTarget: document.getElementById("import-target"),
  mapDateFilter: document.getElementById("map-date-filter"),
  search: document.getElementById("search-input"),
  importJson: document.getElementById("import-json-input"),
  importStatus: document.getElementById("import-status"),
  importProgressWrap: document.getElementById("import-progress-wrap"),
  importProgressFill: document.getElementById("import-progress-fill"),
  importProgressText: document.getElementById("import-progress-text"),
  localJsonFileInput: document.getElementById("local-json-file-input"),
  json: document.getElementById("train-json-input"),
  jsonStatus: document.getElementById("json-status"),
  fieldStatus: document.getElementById("field-status"),
  stopsBody: document.getElementById("stops-body"),
  id: document.getElementById("field-id"),
  number: document.getElementById("field-number"),
  trainType: document.getElementById("field-train-type"),
  company: document.getElementById("field-company"),
  direction: document.getElementById("field-direction"),
  origin: document.getElementById("field-origin"),
  destination: document.getElementById("field-destination"),
  color: document.getElementById("field-color"),
  weight: document.getElementById("field-weight"),
  toggleFocusZoom: document.getElementById("toggle-focus-zoom"),
};

// =========================================================================
//  §9.  Boot sequence (runs once on DOMContentLoaded)
// =========================================================================

document.addEventListener("DOMContentLoaded", async () => {
  installLongTaskObserver();
  // Seed the display-tuning knobs from localStorage before the first render so
  // the user's saved line widths / sizes / opacities apply on load.
  loadDisplaySettings();
  // Start the map's own downloads (vendored basemap style + the 9.2 MB rail
  // network package) IMMEDIATELY, in parallel with the /api datasets below.
  // Previously initMap() kicked these off only after loadAppData() had fully
  // downloaded AND parsed stations/default-trains/matched-* — serializing the
  // two multi-MB waterfalls and delaying first map paint by the whole first
  // phase. Both loaders resolve null on failure (never throw).
  const mapAssetsReady = Promise.all([
    RailMap.loadBasemap(),
    RailMap.loadNetwork(),
  ]);
  try {
    await loadAppData();
  } catch (err) {
    console.error(err);
    const status = document.getElementById("import-status");
    if (status) {
      // Use the shared status helper so this critical failure gets the same
      // ".status err" styling as every other error path (the CSS only
      // defines .status.err, not .status.error).
      setStatus(status, I18N.t("status.loadFailed", { msg: err.message }), "err");
    }
    return;
  }
  // Restore the saved date filter (selectedDate / manual dates) before the
  // first render so the date bar reflects the user's last choice.
  const restoredSelectedDate = restoreUiDateState();
  await initMap(mapAssetsReady);
  applyMapOpacity();
  bindEvents();
  fitJapanMainIslands();
  renderAll();

  // Warm the persistent route-geometry cache (IndexedDB) BEFORE the progressive
  // load runs its solves, so cached trains hit memory and the heavy route graph
  // is never built. Best-effort and namespaced to the current rail network.
  // The map is now on screen (initMap loaded the visible rail network + basemap
  // without waiting on the 12 MB rail-sections graph source). Route solving —
  // and the railHash that namespaces the IndexedDB route cache — both need
  // rail-sections, so make sure it has finished loading before we warm the cache
  // or solve. By now it has almost always arrived in parallel with initMap, so
  // this rarely blocks.
  await ensureRailSectionsLoaded();

  await warmRouteCacheFromIndexedDb();

  // Boot from the server-saved store; if nothing has been saved yet, fall
  // back to the built-in defaults (and do not persist them until edited).
  const savedStore = await loadTrainStoreFromServer();
  await replaceTrainStoreFromStoreProgressive(
    savedStore || getDefaultTrainStore(),
    savedStore ? I18N.t("src.serverStore") : I18N.t("src.builtinDefault"),
    // First run (no saved filter): default to the earliest date per spec 1.1.
    // Returning user: keep their restored selection if it is still valid.
    {
      persistEachStep: false,
      finalPersist: false,
      selectEarliestDate: !restoredSelectedDate,
    },
  );
  if (!savedStore) {
    setStatus(
      els.importStatus,
      I18N.t("status.noSavedStore"),
      "warn",
    );
  }

  // Warm up the heavy N02 routing graph in the background so the first local
  // JSON open / import doesn't pay that one-time build cost synchronously
  // (which would freeze the UI mid-open).
  scheduleRouteGraphPrebuild();

  // Listen for store changes pushed by the server (another tab's edit, or an
  // AI agent calling /api/agent/import) and live-reload the map so the new
  // route shows up automatically.
  subscribeToStoreEvents();
});

// =========================================================================
//  §10.  Live refresh via Server-Sent Events + background route-graph prebuild
// =========================================================================

// ---------------------------------------------------------------------------
// Live refresh: subscribe to the server's SSE stream and, when the saved store
// changes from another source, reload it, re-solve every route and re-render —
// no manual reload. We skip events we caused ourselves (origin === CLIENT_ID).
// EventSource auto-reconnects, so a server restart simply resumes the stream.
// ---------------------------------------------------------------------------
let storeEventSource = null;
let liveReloadPending = false;
// Detail of the newest deferred SSE event (so the catch-up reconcile acts on
// the latest state — e.g. a `cleared` event — instead of a stale one).
let liveReloadPendingDetail = null;

// Re-run the deferred live reload once the blocking work has finished. Called
// from every `importInProgress = false` site; previously an event deferred
// during a progressive import was silently dropped (the early return in
// handleExternalStoreChange skipped its own finally-block retry).
function drainPendingLiveReload() {
  if (!liveReloadPending) return;
  liveReloadPending = false;
  const next = liveReloadPendingDetail;
  liveReloadPendingDetail = null;
  setTimeout(() => handleExternalStoreChange(next || {}), 0);
}

function subscribeToStoreEvents() {
  if (typeof EventSource === "undefined") return; // very old browser: no live refresh
  try {
    storeEventSource = new EventSource(`${API_BASE}/events`);
  } catch (err) {
    console.warn("Live-refresh unavailable; could not open SSE stream.", err);
    return;
  }

  storeEventSource.addEventListener("store-changed", (evt) => {
    let detail = {};
    try {
      detail = JSON.parse(evt.data || "{}");
    } catch (err) {
      /* ignore malformed payload */
    }
    // Ignore the echo of our own write.
    if (detail.origin && detail.origin === CLIENT_ID) return;
    handleExternalStoreChange(detail);
  });

  storeEventSource.onerror = () => {
    // EventSource reconnects on its own; nothing to do but note it once.
  };
}

async function handleExternalStoreChange(detail) {
  // If a progressive import is mid-flight, defer; drainPendingLiveReload()
  // catches up as soon as the import's finally-block clears importInProgress.
  if (importInProgress) {
    liveReloadPending = true;
    liveReloadPendingDetail = detail; // newest event wins
    return;
  }
  try {
    if (detail && detail.cleared) {
      // Store was cleared on the server: fall back to built-in defaults.
      await replaceTrainStoreFromStoreProgressive(
        getDefaultTrainStore(),
        I18N.t("src.serverCleared"),
        { persistEachStep: false, finalPersist: false },
      );
      setStatus(els.importStatus, I18N.t("status.serverClearedFallback"), "warn");
      return;
    }
    const savedStore = await loadTrainStoreFromServer();
    if (!savedStore) return;
    const sourceLabel =
      detail && detail.source === "agent"
        ? I18N.t("src.agentImport")
        : I18N.t("src.otherUpdate");
    await replaceTrainStoreFromStoreProgressive(savedStore, sourceLabel, {
      // The server is already the source of truth — don't re-save (that would
      // echo back through SSE), and keep the user's current date selection.
      persistEachStep: false,
      finalPersist: false,
    });
    setStatus(
      els.importStatus,
      I18N.t("status.autoLoaded", { label: sourceLabel, count: savedStore.trains.length }),
      "ok",
    );
  } catch (err) {
    console.warn("Live reload after external store change failed.", err);
  } finally {
    // A change may have arrived while we were busy; reconcile once more
    // (with the NEWEST deferred detail, not this call's).
    drainPendingLiveReload();
  }
}

// Warm the lightweight rail-section spatial index during idle time (NOT the
// full ~377k-node graph, which is no longer built eagerly). This keeps the
// first on-demand regional solve from paying the index build synchronously.
function scheduleRouteGraphPrebuild() {
  const prebuild = () => {
    try {
      getRailSectionSpatialIndex();
    } catch (err) {
      console.warn(
        "Rail-section index prebuild failed; it will be built lazily on first use.",
        err,
      );
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(prebuild, { timeout: 3000 });
  } else {
    setTimeout(prebuild, 0);
  }
}

// =========================================================================
//  §11.  Station resolution & generic data accessors
// =========================================================================

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stationName(feature) {
  return (
    feature.properties.station_name ||
    feature.properties.name ||
    feature.properties.N02_005 ||
    feature.properties.station ||
    feature.properties.id
  );
}

function stationCode(feature) {
  const p = feature.properties || {};
  return p.n02_station_code || p.N02_005c || p.station_id || null;
}

function stationGroupCode(feature) {
  const p = feature.properties || {};
  return p.n02_group_code || p.N02_005g || null;
}

function stationLineName(feature) {
  const p = feature.properties || {};
  return p.line_name || p.N02_003 || "-";
}

function stationOperator(feature) {
  const p = feature.properties || {};
  return p.operator || p.N02_004 || "-";
}

function stationInstitutionTypeCode(feature) {
  const p = feature.properties || {};
  return String(p.institution_type_code || p.N02_002 || "");
}

function stopName(stop) {
  return stop.name || stop.station || "";
}

function stopStationCode(stop) {
  return stop.n02_station_code || stop.N02_005c || null;
}

// Normalize a station name for tolerant matching against imperfect JSON.
// NFKC folds full/half-width differences; we additionally unify the small/large
// kana variants that N02 and hand-written JSON spell inconsistently (e.g.
// 柳ヶ浦 vs 柳ケ浦, 茅ヶ崎 vs 茅ケ崎) and strip internal whitespace.
function normalizeStationName(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .replace(/ヶ/g, "ケ")
    .replace(/ヵ/g, "カ")
    .replace(/ゖ/g, "け")
    .replace(/ゕ/g, "か");
}

function stationLookupKeys(name, code) {
  const keys = [];
  if (code) {
    const cleanCode = String(code).trim();
    if (cleanCode) keys.push(cleanCode);
  }
  if (name) {
    const cleanName = String(name).trim();
    if (cleanName) keys.push(cleanName);
    // Index a normalized alias too, so a stop written 柳ケ浦 still finds 柳ヶ浦.
    const normalized = normalizeStationName(name);
    if (normalized && normalized !== cleanName) keys.push(normalized);
  }
  return [...new Set(keys)];
}

function buildStationCandidatesIndex(collection) {
  const index = new Map();
  (collection.features || []).forEach((feature) => {
    stationLookupKeys(stationName(feature), stationCode(feature)).forEach(
      (key) => {
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(feature);
      },
    );
  });
  return index;
}

// Display coordinates of a train's UNAMBIGUOUS stops (single name candidate or
// carrying a station code). These anchor the geographic disambiguation of any
// same-name stop, so e.g. 池田 on a Hokkaido train resolves to 根室線 池田 rather
// than 阪急 池田 in Osaka. `excludeStop` skips the stop currently being resolved.
function trainAnchorCoordinates(train, excludeStop) {
  const coords = [];
  (train?.stops || []).forEach((stop) => {
    if (stop === excludeStop) return;
    const candidates = resolveStationCandidates(stop);
    if (!candidates.length) return;
    if (candidates.length === 1 || stopStationCode(stop)) {
      const coord = getFeatureDisplayCoordinate(candidates[0]);
      if (coord) coords.push(coord);
    }
  });
  return coords;
}

// Train-aware single-station resolution. Prefers candidates in the train's
// allowed institution class and, when a name is still ambiguous, picks the one
// nearest the train's anchor stops. With no train context it simply returns
// the first by-name candidate.
function resolveStationForTrain(stopOrName, train) {
  const candidates = resolveStationCandidates(stopOrName);
  if (candidates.length <= 1) return candidates[0] || null;

  const allowedCodes = train ? getAllowedInstitutionTypeCodes(train) : null;
  const preferred = allowedCodes
    ? filterStationsByPreferredInstitution(candidates, allowedCodes)
    : [];
  const pool = preferred.length ? preferred : candidates;
  if (pool.length === 1) return pool[0];

  const excludeStop = typeof stopOrName === "object" ? stopOrName : null;
  const anchors = train ? trainAnchorCoordinates(train, excludeStop) : [];
  if (!anchors.length) return pool[0];

  let best = pool[0];
  let bestDistance = Infinity;
  pool.forEach((feature) => {
    const coord = getFeatureDisplayCoordinate(feature);
    if (!coord) return;
    let nearest = Infinity;
    anchors.forEach((anchor) => {
      const d = distanceMeters(coord, anchor);
      if (d < nearest) nearest = d;
    });
    if (nearest < bestDistance) {
      bestDistance = nearest;
      best = feature;
    }
  });
  return best;
}

function dedupeStationFeatures(features) {
  const seen = new Set();
  const candidates = [];
  (features || []).forEach((feature) => {
    const signature = `${stationCode(feature) || ""}|${stationName(feature) || ""}|${stationLineName(feature) || ""}|${stationOperator(feature) || ""}|${JSON.stringify(feature.geometry?.coordinates?.[0] || [])}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    candidates.push(feature);
  });
  return candidates;
}

function resolveStationCandidates(stopOrName) {
  if (!stopOrName) return [];
  const name =
    typeof stopOrName === "string" ? stopOrName : stopName(stopOrName);
  const code =
    typeof stopOrName === "string" ? null : stopStationCode(stopOrName);
  const cleanName = name ? String(name).trim() : "";
  const cleanCode = code ? String(code).trim() : "";

  // A station code is line-specific in N02.  Do not union code matches with
  // same-name matches, otherwise an inconsistent imported pair such as
  // { name: "千葉", n02_station_code: "003859" } can mix 越中島 and 千葉
  // candidates and make Dijkstra jump to the wrong city/line.
  const normalizedQueryName = normalizeStationName(cleanName);
  const codeCandidates = cleanCode
    ? dedupeStationFeatures(stationCandidatesIndex.get(cleanCode) || [])
    : [];
  if (codeCandidates.length) {
    if (!cleanName) return codeCandidates;
    const codeAndNameCandidates = codeCandidates.filter(
      (feature) =>
        normalizeStationName(stationName(feature)) === normalizedQueryName,
    );
    if (codeAndNameCandidates.length) return codeAndNameCandidates;
    console.warn(
      "N02 station code/name mismatch; falling back to station name candidates.",
      {
        name: cleanName,
        n02_station_code: cleanCode,
        code_candidates: codeCandidates.map((feature) => ({
          name: stationName(feature),
          n02_station_code: stationCode(feature),
          line_name: stationLineName(feature),
          operator: stationOperator(feature),
        })),
      },
    );
  }

  // Try the exact name first, then the normalized alias (handles ケ/ヶ, width).
  const nameCandidates = cleanName
    ? dedupeStationFeatures(
        stationCandidatesIndex.get(cleanName) ||
          stationCandidatesIndex.get(normalizedQueryName) ||
          [],
      )
    : [];
  return nameCandidates.length ? nameCandidates : codeCandidates;
}

// =========================================================================
//  §12.  Train store: built-in defaults & debounced server autosave
// =========================================================================

function getDefaultTrainStore() {
  return {
    schema_version: SCHEMA_VERSION,
    trains: (defaultTrainStore.trains || []).map(normalizeExportTrain),
  };
}

// Persist every change to the server-side store (debounced). This is the
// single source of truth that replaces the old localStorage backup.
let serverStoreSaveTimer = null;
let serverStoreSaveInFlight = false;
let pendingServerStoreText = null;
// Marks the in-memory store dirty WITHOUT serializing. The expensive full
// JSON.stringify (which now also carries per-train route_geometry_cache) is
// deferred until the debounced flush actually runs, so a rapid burst of small
// mutations (visible toggles, field edits, ride_segment toggles) no longer
// pays one — let alone two — full serializations on the synchronous path.
let storeSaveDirty = false;

function saveTrainStore() {
  storeSaveDirty = true;
  clearTimeout(serverStoreSaveTimer);
  serverStoreSaveTimer = setTimeout(
    () => flushServerStoreSave(),
    SERVER_AUTOSAVE_DEBOUNCE_MS,
  );
}

// Serialize the store at most once per dirty window, lazily, right before a
// network write. Kept separate so force-flush paths can reuse it.
function serializePendingStoreIfDirty() {
  if (!storeSaveDirty) return;
  pendingServerStoreText = perfMeasure("serialize store", () =>
    exportTrainStore(),
  );
  storeSaveDirty = false;
}

// Resolves when the current PUT settles — lets the clear-storage handler wait
// out an in-flight save so it can't land AFTER the DELETE and resurrect the
// just-cleared file on the server.
let serverStoreSavePromise = null;

async function flushServerStoreSave() {
  serializePendingStoreIfDirty();
  if (serverStoreSaveInFlight) return serverStoreSavePromise;
  if (pendingServerStoreText === null) return;
  serverStoreSaveInFlight = true;
  const jsonText = pendingServerStoreText;
  pendingServerStoreText = null;
  serverStoreSavePromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/${TRAIN_STORE_API}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Client-Id": CLIENT_ID },
        body: jsonText,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setStatus(els.jsonStatus, I18N.t("status.autosaveOk"), "ok");
    } catch (error) {
      console.warn("Autosave to server train-store failed.", error);
      setStatus(els.jsonStatus, I18N.t("status.autosaveFail", { msg: error.message }), "warn");
    } finally {
      serverStoreSaveInFlight = false;
      // A newer change may have arrived while this request was in flight
      // (either already serialized, or just flagged dirty). Flush it.
      if (pendingServerStoreText !== null || storeSaveDirty)
        flushServerStoreSave();
    }
  })();
  return serverStoreSavePromise;
}

// The read-only export textarea is a display convenience, not part of the
// edit path. Refreshing it ran a full exportTrainStore() (whole-store
// JSON.stringify) on EVERY mutation. Debounce it so rapid edits coalesce into
// a single serialization once the user pauses, off the interaction's hot path.
let exportTextareaTimer = null;
function scheduleExportTextareaRefresh() {
  clearTimeout(exportTextareaTimer);
  exportTextareaTimer = setTimeout(() => {
    if (els.json)
      els.json.value = perfMeasure("export textarea", () => exportTrainStore());
  }, 300);
}

// Load the saved store from the server. Returns null when nothing has been
// saved yet (HTTP 404) or the saved data is unreadable, so the caller can
// fall back to the built-in defaults.
async function loadTrainStoreFromServer() {
  try {
    const res = await fetch(`${API_BASE}/${TRAIN_STORE_API}`, {
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const parsed = await res.json();
    validateTrainStore(parsed);
    return parsed;
  } catch (error) {
    console.warn(
      "Could not load saved train store from server; using defaults.",
      error,
    );
    return null;
  }
}

let localJsonFileHandle = null;

// =========================================================================
//  §13.  File System Access API & IndexedDB key/value (file-handle) store
// =========================================================================

function supportsFileSystemAccess() {
  return (
    typeof window.showOpenFilePicker === "function" &&
    typeof window.showSaveFilePicker === "function"
  );
}

function openFileHandleDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(FILE_HANDLE_DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(FILE_HANDLE_STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Could not open IndexedDB."));
  });
}

async function idbDeleteValue(key) {
  const db = await openFileHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_HANDLE_STORE_NAME, "readwrite");
    tx.objectStore(FILE_HANDLE_STORE_NAME).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("Could not delete IndexedDB value."));
    };
  });
}

// =========================================================================
//  §14.  Persistent route-geometry cache (IndexedDB, namespaced by rail-content hash)
// =========================================================================

// --- Persistent route-geometry cache (IndexedDB) -------------------------
// Solved route geometry is expensive (route-graph build + Dijkstra). Persisting
// it keyed by railHash::cacheKey means that across sessions — and for ANY
// dataset — a train whose sections/policy already solved once is restored
// instantly, and the heavy route graph is never even built when every train hits
// the warmed cache (getRuntimeRouteGraph runs only on a miss). railHash
// namespaces entries to the current rail network, so changing the underlying N02
// data transparently invalidates stale geometry.
let railContentHashCache = null;
function getRailContentHash() {
  if (railContentHashCache) return railContentHashCache;
  const feats = (railSectionsGeoJson && railSectionsGeoJson.features) || [];
  // Cheap deterministic content signature (hashing the full 12MB text every
  // boot would be wasteful): feature count + a sampled coordinate sweep.
  let h = 0x811c9dc5;
  const mix = (n) => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(feats.length);
  // Full content hash (~tens of ms over ~405k points, one-time at boot): every
  // coordinate is mixed in — not a sample — so ANY change to the rail geometry
  // changes the namespace and invalidates stale cached routes. Avoids the blind
  // spots a sparse sample would leave between sampled features.
  for (let i = 0; i < feats.length; i += 1) {
    const geom = feats[i] && feats[i].geometry;
    const coords = geom && geom.coordinates;
    if (!Array.isArray(coords)) {
      mix(0);
      continue;
    }
    const lines = geom.type === "MultiLineString" ? coords : [coords];
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      if (!Array.isArray(line)) continue;
      mix(line.length);
      for (let pi = 0; pi < line.length; pi += 1) {
        const pt = line[pi];
        if (Array.isArray(pt)) {
          mix(pt[0] * 1e5);
          mix(pt[1] * 1e5);
        }
      }
    }
  }
  railContentHashCache = `r${(h >>> 0).toString(36)}-${feats.length}`;
  return railContentHashCache;
}

function openRouteCacheDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(ROUTE_CACHE_DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(ROUTE_CACHE_STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Could not open route cache DB."));
  });
}

// Bulk-load all persisted route geometry for the current rail network into the
// in-memory runtimeRouteCache, so the synchronous solve path hits memory and
// never triggers the route-graph build. Best-effort: any failure just falls
// back to solving on demand.
async function warmRouteCacheFromIndexedDb() {
  if (!window.indexedDB) return;
  const prefix = `${getRailContentHash()}::`;
  try {
    const db = await openRouteCacheDb();
    await new Promise((resolve) => {
      const tx = db.transaction(ROUTE_CACHE_STORE_NAME, "readonly");
      const req = tx.objectStore(ROUTE_CACHE_STORE_NAME).openCursor();
      let warmed = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const key = String(cursor.key);
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (rest.startsWith(ROUTE_NEG_CACHE_MARKER)) {
            // Persisted "this route can't be solved" marker for this rail net.
            runtimeRouteNegativeCache.add(
              rest.slice(ROUTE_NEG_CACHE_MARKER.length),
            );
          } else if (Array.isArray(cursor.value) && cursor.value.length) {
            runtimeRouteCache.set(rest, cursor.value);
            warmed += 1;
          }
        }
        cursor.continue();
      };
      tx.oncomplete = () => {
        db.close();
        if (warmed) console.info(`Warmed ${warmed} route(s) from IndexedDB.`);
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    });
  } catch (err) {
    console.warn("Route cache warm-up skipped.", err);
  }
}

// Fire-and-forget persist of one solved route's geometry for future sessions.
function persistRouteCacheEntry(cacheKey, features) {
  if (!window.indexedDB || !Array.isArray(features) || !features.length) return;
  const storeKey = `${getRailContentHash()}::${cacheKey}`;
  openRouteCacheDb()
    .then((db) => {
      const tx = db.transaction(ROUTE_CACHE_STORE_NAME, "readwrite");
      tx.objectStore(ROUTE_CACHE_STORE_NAME).put(features, storeKey);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    })
    .catch((err) => console.warn("Route cache persist skipped.", err));
}

// Fire-and-forget persist of a "this route can't be solved with the current rail
// data + policy" marker, so future sessions skip the doomed solve too. Namespaced
// by rail-content hash like the positive cache, and stored under a distinct
// marker prefix so warmRouteCacheFromIndexedDb() can tell the two apart.
function persistRouteNegativeEntry(cacheKey) {
  if (!window.indexedDB) return;
  const storeKey = `${getRailContentHash()}::${ROUTE_NEG_CACHE_MARKER}${cacheKey}`;
  openRouteCacheDb()
    .then((db) => {
      const tx = db.transaction(ROUTE_CACHE_STORE_NAME, "readwrite");
      tx.objectStore(ROUTE_CACHE_STORE_NAME).put(1, storeKey);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    })
    .catch((err) => console.warn("Route negative-cache persist skipped.", err));
}

// =========================================================================
//  §15.  Local JSON file open / save (File System Access, with download fallback)
// =========================================================================

// (storeFileHandle was removed: the handle was persisted to IndexedDB but
// never read back — a write-only path. The user re-picks the file each
// session either way; deleteStoredFileHandle stays to clean up old entries.)

async function deleteStoredFileHandle() {
  try {
    await idbDeleteValue(FILE_HANDLE_KEY);
  } catch (error) {
    console.warn("Could not clear stored file handle.", error);
  }
  localJsonFileHandle = null;
}

async function verifyFileHandlePermission(handle, writable) {
  if (!handle || typeof handle.queryPermission !== "function") return false;
  const options = writable ? { mode: "readwrite" } : { mode: "read" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  if (typeof handle.requestPermission === "function") {
    return (await handle.requestPermission(options)) === "granted";
  }
  return false;
}

async function writeLocalJsonFile(
  jsonText = exportTrainStore(),
  promptIfMissing = true,
) {
  if (!supportsFileSystemAccess()) {
    downloadText(LOCAL_JSON_FILENAME, jsonText, "application/json");
    setStatus(
      els.jsonStatus,
      I18N.t("status.noFsApi"),
      "warn",
    );
    return false;
  }

  if (!localJsonFileHandle && promptIfMissing) {
    localJsonFileHandle = await window.showSaveFilePicker({
      suggestedName: LOCAL_JSON_FILENAME,
      types: [
        {
          description: "Train store JSON",
          accept: { "application/json": [".json"] },
        },
      ],
    });
  }

  if (!localJsonFileHandle) return false;
  if (!(await verifyFileHandlePermission(localJsonFileHandle, true))) {
    throw new Error(I18N.t("err.noWritePerm"));
  }

  const writable = await localJsonFileHandle.createWritable();
  await writable.write(jsonText);
  await writable.close();
  return true;
}

async function openLocalJsonFile() {
  if (supportsFileSystemAccess()) {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: "Train store JSON",
          accept: { "application/json": [".json"] },
        },
      ],
    });
    if (!handle) return;
    localJsonFileHandle = handle;
    const file = await handle.getFile();
    // replaceTrainStoreFromJsonText() already finishes with finalizeProgressiveLoad()
    // -> renderAll(), so an extra renderAll() here is a redundant full repaint
    // (and full store re-serialization). Don't double-render.
    await replaceTrainStoreFromJsonText(
      await file.text(),
      I18N.t("src.localJson", { name: file.name }),
    );
    return;
  }

  els.localJsonFileInput.value = "";
  els.localJsonFileInput.click();
}

// =========================================================================
//  §16.  Progressive load / import engine (one train at a time, time-budgeted)
// =========================================================================

// Clear the in-memory store and selection before a full progressive reload.
// Shared by the two "replace" import paths so the reset has one definition.
function resetTrainStoreForProgressiveLoad() {
  trainStore = { schema_version: SCHEMA_VERSION, trains: [] };
  selectedTrainId = null;
  focusedTrainId = null;
  // Close any click-opened popup: its train is about to stop existing.
  closeClickPopup();
  // Drop the cached route render items so a re-import can't briefly draw the
  // previous store's segments (the cache is keyed by train data, which is
  // about to be replaced).
  cachedRouteItems = null;
  cachedRouteSignature = "";
  renderAll();
}

// Shared per-train progressive append loop. Every import/restore path runs the
// same append -> yield -> solve route -> draw THIS train -> progress sequence,
// so a change to that ordering only has to be made once.
//
// The map is built up one train at a time: each iteration adds exactly ONE new
// route line (and its markers) onto the existing layers via appendTrainToLayers
// — it never clears and re-draws the whole map mid-load. Because each train's
// route is solved off the render path and only its own line is drawn, the loop
// stays O(N) and the page keeps responding while lines appear progressively.
// A single authoritative renderAll() at the end re-renders with the correct
// cross-train overlap offsets and refreshes the date bar / export textarea.
async function runProgressiveAppend(
  trains,
  { persistEachStep = true, onProgress, fallbackDate = null } = {},
) {
  const appendedIds = [];
  const total = trains.length;
  // Time-budget chunked scheduling. Keep processing trains until ~FRAME_BUDGET_MS
  // of work has accumulated, THEN yield one frame — instead of paying a whole
  // frame per train (which made N trains cost >= N frames regardless of how
  // cheap each one was). Cached/cheap trains now fly through many per frame; a
  // heavy solve still yields right after. Wall-clock tracks real work and the
  // approach scales to any N.
  const FRAME_BUDGET_MS = 12;
  const now = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now();
  // One initial yield so the progress UI paints before the (possibly heavy)
  // first solve / route-graph build blocks the thread.
  await waitForImportPaint();
  let frameStart = now();
  for (let index = 0; index < total; index += 1) {
    const id = appendImportedTrain(trains[index], fallbackDate);
    appendedIds.push(id);

    const appendedTrain = getTrain(id);
    warmRouteCacheForTrain(appendedTrain);

    // Draw just this one train incrementally: one more line on the map, one
    // more card in the list (O(1)). No full-list rebuild, no full-map clear.
    perfMeasure("appendTrainToLayers", () =>
      appendTrainToLayers(appendedTrain),
    );
    appendTrainListItemIncremental(appendedTrain);
    if (onProgress) onProgress({ count: appendedIds.length, total, id });

    if (now() - frameStart >= FRAME_BUDGET_MS) {
      await waitForImportPaint();
      frameStart = now();
    }
  }
  // Single authoritative repaint: full sorted list + date bar + cross-train
  // overlap offsets, all once at the end.
  renderAll();
  if (persistEachStep) saveTrainStore();
  return appendedIds;
}

// Pre-compute (and cache) one train's route geometry without touching the DOM,
// so the heavy solve happens between animation frames rather than as a single
// blocking burst during rendering (fix #2). Failures are swallowed — the
// normal render path will surface any genuine routing problem.
function warmRouteCacheForTrain(train) {
  if (!train) return;
  try {
    generateMatchedRouteFeaturesForTrain(train);
  } catch (err) {
    console.warn(
      `Route warm-up failed for ${train?.id}; will retry on render.`,
      err,
    );
  }
}

// Re-select the first imported train, re-validate the canonical store and
// (optionally) persist. Shared tail of the two "replace" import paths.
function finalizeProgressiveLoad(
  appendedIds,
  { finalPersist = true, selectEarliestDate = false } = {},
) {
  selectedTrainId = appendedIds[0] || null;
  focusedTrainId = null;
  // Cancel any pending batched append-render: the authoritative renderAll()
  // below supersedes it (otherwise the timer fires ~120 ms later and runs one
  // redundant full renderTrainLayers after every import).
  if (_appendRenderTimer) {
    clearTimeout(_appendRenderTimer);
    _appendRenderTimer = null;
  }
  // A full replace can invalidate the previous date filter. Drop to the
  // earliest available date (or keep a still-valid one); on first boot we
  // explicitly prefer the earliest date even when nothing was selected yet.
  reconcileSelectedDate({ preferEarliestWhenAll: selectEarliestDate });
  validateTrainStore(buildCanonicalTrainStore());
  if (finalPersist) saveTrainStore();
  renderAll();
  // The load allowed the regional-graph cache to grow to its transient budget to
  // avoid rebuilding regions mid-pass; settle it back to the steady budget now.
  trimRegionalGraphCache(REGIONAL_GRAPH_NODE_BUDGET);
}

async function replaceTrainStoreFromJsonText(jsonText, sourceLabel = "JSON") {
  if (importInProgress) {
    console.warn(
      "A progressive load/import is already running; ignoring concurrent replaceTrainStoreFromJsonText.",
    );
    return;
  }
  importInProgress = true;
  try {
    const importedStore = parseImportedCanonicalStore(jsonText);
    const total = importedStore.trains.length;
    if (!total) throw new Error(`${sourceLabel} contains no trains.`);

    resetTrainStoreForProgressiveLoad();
    setImportProgress(0, total, I18N.t("prog.prepare", { label: sourceLabel, total }));

    const appendedIds = await runProgressiveAppend(importedStore.trains, {
      persistEachStep: true,
      // Per-item progress lives only in the progress bar's own text. The
      // status line is left for the final summary so the two don't echo the
      // same "n/total" message at once.
      onProgress: ({ count, total: t, id }) => {
        setImportProgress(
          count,
          t,
          I18N.t("prog.loading", { label: sourceLabel, count, total: t, id }),
        );
      },
    });

    finalizeProgressiveLoad(appendedIds, { finalPersist: true });
    setStatus(
      els.importStatus,
      I18N.t("status.loadedAll", { label: sourceLabel, total }),
      "ok",
    );
    setImportProgress(total, total, I18N.t("prog.done", { count: total }));
  } finally {
    importInProgress = false;
    // If a server-side store change arrived mid-import, reconcile it now
    // instead of dropping it (bug: deferred live reloads were never retried).
    drainPendingLiveReload();
  }
}

async function replaceTrainStoreFromStoreProgressive(
  store,
  sourceLabel = "JSON",
  options = {},
) {
  if (importInProgress) {
    console.warn(
      "A progressive load/import is already running; ignoring concurrent replaceTrainStoreFromStoreProgressive.",
    );
    return { count: 0, ids: [] };
  }
  importInProgress = true;
  try {
    const importedStore = parseImportedCanonicalStore(
      JSON.stringify(store || { trains: [] }),
    );
    const total = importedStore.trains.length;
    if (!total) {
      renderAll();
      return { count: 0, ids: [] };
    }

    const persistEachStep = Boolean(options.persistEachStep);
    const finalPersist = options.finalPersist !== false;
    const selectEarliestDate = Boolean(options.selectEarliestDate);

    resetTrainStoreForProgressiveLoad();
    setImportProgress(0, total, I18N.t("prog.prepare", { label: sourceLabel, total }));

    const appendedIds = await runProgressiveAppend(importedStore.trains, {
      persistEachStep,
      // Per-item progress lives only in the progress bar's own text; the
      // status line is reserved for the final summary to avoid a duplicate
      // "正在…n/total" line echoing the same thing.
      onProgress: ({ count, total: t, id }) => {
        setImportProgress(
          count,
          t,
          I18N.t("prog.loading", { label: sourceLabel, count, total: t, id }),
        );
      },
    });

    finalizeProgressiveLoad(appendedIds, { finalPersist, selectEarliestDate });
    setImportProgress(total, total, I18N.t("prog.done", { count: total }));
    setStatus(
      els.importStatus,
      I18N.t("status.restoredAll", { label: sourceLabel, total }),
      "ok",
    );
    return { count: appendedIds.length, ids: appendedIds };
  } finally {
    importInProgress = false;
    // If a server-side store change arrived mid-import, reconcile it now
    // instead of dropping it (bug: deferred live reloads were never retried).
    drainPendingLiveReload();
  }
}

// =========================================================================
//  §17.  Train CRUD (add / update / duplicate / delete / move / visibility)
// =========================================================================

function addTrain(train) {
  const base = train || createBlankTrain();
  const candidate = clone(base);
  candidate.id = uniqueId(candidate.id || "LE");
  trainStore.trains.push(candidate);
  selectedTrainId = candidate.id;
  focusedTrainId = candidate.id;
  persistAndRender();
}

function duplicateTrain(trainId) {
  const train = getTrain(trainId);
  if (!train) return;
  const copy = clone(train);
  copy.id = uniqueId(`${train.id}-copy`);
  copy.number = `${train.number || "Train"} Copy`;
  trainStore.trains.push(copy);
  selectedTrainId = copy.id;
  focusedTrainId = copy.id;
  persistAndRender();
}

function deleteTrain(trainId) {
  const index = trainStore.trains.findIndex((t) => t.id === trainId);
  if (index < 0) return;
  trainStore.trains.splice(index, 1);
  selectedTrainId =
    trainStore.trains[Math.min(index, trainStore.trains.length - 1)]?.id ||
    null;
  if (focusedTrainId === trainId) focusedTrainId = null;
  persistAndRender();
}

function deleteAllTrains() {
  trainStore = { schema_version: SCHEMA_VERSION, trains: [] };
  selectedTrainId = null;
  focusedTrainId = null;
  persistAndRender();
}

function toggleTrainVisibility(trainId) {
  const train = getTrain(trainId);
  if (!train) return;
  train.visible = train.visible === false;
  // Incremental update: a visibility flip changes (a) this card's shown/hidden
  // label and (b) the map. It does NOT change the date buckets, the editor, or
  // the import target, so we skip rebuilding those. The map still gets one full
  // renderTrainLayers pass because overlapping parallel routes share global
  // offset slots that must be recomputed when the visible set changes. Saving
  // is debounced (no synchronous full serialization here).
  saveTrainStore();
  perfMeasure("renderTrainList", renderTrainList);
  perfMeasure("renderTrainLayers", renderTrainLayers);
}

function moveTrain(trainId, direction) {
  const index = trainStore.trains.findIndex((t) => t.id === trainId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= trainStore.trains.length) return;
  const [train] = trainStore.trains.splice(index, 1);
  trainStore.trains.splice(next, 0, train);
  persistAndRender();
}

// =========================================================================
//  §18.  Canonical export & serialization (single definition of the saved schema)
// =========================================================================

function exportTrainStore() {
  return JSON.stringify(buildCanonicalTrainStore(), null, 2);
}

function normalizeNullableTime(value) {
  if (value === undefined || value === "") return null;
  return value;
}

// Canonical shape builders shared by both the export and import paths so the
// serialized stop/style/route_policy schema has a single definition.
function canonicalStopShape(stop) {
  return {
    name: stop.name || "",
    n02_station_code: stop.n02_station_code || null,
    arrival: normalizeNullableTime(stop.arrival),
    departure: normalizeNullableTime(stop.departure),
    stop_type: stop.stop_type || "passenger_stop",
    ride_segment: Boolean(stop.ride_segment),
  };
}

function canonicalStyle(style) {
  // Legacy default migration: stores written before the railprint restyle
  // baked the OLD defaults (weight 6 / unridden 0.22) into every train.
  // Treat exactly those values as "unset" so existing plans pick up the new
  // railprint-scale defaults; any other explicit value is kept as-is.
  let weight = Number(style?.weight || DEFAULT_TRAIN_WEIGHT);
  if (weight === 6) weight = DEFAULT_TRAIN_WEIGHT;
  let unridden = Number(style?.unridden_opacity ?? DEFAULT_UNRIDDEN_OPACITY);
  if (unridden === 0.22) unridden = DEFAULT_UNRIDDEN_OPACITY;
  return {
    color: style?.color || DEFAULT_TRAIN_COLOR,
    weight,
    unridden_opacity: unridden,
  };
}

function canonicalRoutePolicy(routePolicy) {
  return {
    mode: "single_primary_route",
    jr_only: routePolicy?.jr_only === true,
    allow_alternatives: false,
    allow_browser_straight_line_fallback: false,
    allowed_institution_type_codes:
      routePolicy?.allowed_institution_type_codes || [
        ...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES,
      ],
    preferred_line_names: Array.isArray(routePolicy?.preferred_line_names)
      ? routePolicy.preferred_line_names.map(String).filter(Boolean)
      : [],
    preferred_operator_names: Array.isArray(
      routePolicy?.preferred_operator_names,
    )
      ? routePolicy.preferred_operator_names.map(String).filter(Boolean)
      : [],
    institution_filter_mode: routePolicy?.institution_filter_mode || "soft",
  };
}

function normalizeExportRouteSection(section) {
  const normalized = {
    from: section.from || "",
    to: section.to || "",
    from_n02_station_code: section.from_n02_station_code || null,
    to_n02_station_code: section.to_n02_station_code || null,
  };
  if (Array.isArray(section.line_names) && section.line_names.length)
    normalized.line_names = [...section.line_names];
  if (Array.isArray(section.operator_names) && section.operator_names.length)
    normalized.operator_names = [...section.operator_names];
  // Branch-portion train number / name (optional; see normalizeImportedRouteSection).
  if (section.number) normalized.number = String(section.number);
  if (section.name) normalized.name = String(section.name);
  return normalized;
}

function getRideRouteSectionsForTrain(train) {
  const stops = train?.stops || [];
  const sections = Array.isArray(train?.route_sections)
    ? train.route_sections
    : [];
  const calculated = [];

  for (let index = 0; index < stops.length - 1; index += 1) {
    const fromStop = stops[index];
    const toStop = stops[index + 1];
    const existing = findRouteSectionForStopPair(
      sections,
      fromStop,
      toStop,
      index,
    );

    if (existing) {
      calculated.push(normalizeExportRouteSection(existing));
      continue;
    }

    const from = resolveStationForTrain(fromStop, train);
    const to = resolveStationForTrain(toStop, train);
    calculated.push({
      from: stopName(fromStop),
      to: stopName(toStop),
      from_n02_station_code: from
        ? stationCode(from)
        : fromStop.n02_station_code || null,
      to_n02_station_code: to
        ? stationCode(to)
        : toStop.n02_station_code || null,
    });
  }

  return calculated;
}

function findRouteSectionForStopPair(
  sections,
  fromStop,
  toStop,
  preferredIndex,
) {
  const preferred = sections[preferredIndex];
  if (routeSectionMatchesStopPair(preferred, fromStop, toStop))
    return preferred;
  return sections.find((section) =>
    routeSectionMatchesStopPair(section, fromStop, toStop),
  );
}

function routeSectionMatchesStopPair(section, fromStop, toStop) {
  if (!section) return false;
  const fromCode = stopStationCode(fromStop);
  const toCode = stopStationCode(toStop);
  const sectionFromCode = section.from_n02_station_code || null;
  const sectionToCode = section.to_n02_station_code || null;
  const codeMatches = Boolean(
    fromCode &&
    toCode &&
    sectionFromCode &&
    sectionToCode &&
    String(fromCode) === String(sectionFromCode) &&
    String(toCode) === String(sectionToCode),
  );
  const nameMatches = Boolean(
    stopName(fromStop) &&
    stopName(toStop) &&
    stopName(fromStop) === (section.from || "") &&
    stopName(toStop) === (section.to || ""),
  );

  // N02 station codes are line-specific.  A stop can be displayed with one
  // line-code while the route_section intentionally uses another line-code
  // for the same physical station transfer/through-running point.  Treat a
  // same-name adjacent pair as the same route section instead of forcing the
  // stop code and route-section code to be identical.
  return codeMatches || nameMatches;
}

function normalizeExportTrain(train) {
  const normalized = {
    id: train.id || "",
    date: normalizeTrainDate(train),
    number: train.number || "",
    train_type: train.train_type || "",
    company: train.company || "",
    origin: train.origin || "",
    destination: train.destination || "",
    direction: train.direction || "down",
    visible: train.visible !== false,
    style: canonicalStyle(train.style),
    route_policy: canonicalRoutePolicy(train.route_policy),
    route_sections: getRideRouteSectionsForTrain(train),
    stops: Array.isArray(train.stops)
      ? train.stops.map(canonicalStopShape)
      : [],
  };
  // Route geometry is intentionally NOT persisted into the store anymore.
  // It is cached cross-session in IndexedDB (warmed into runtimeRouteCache on
  // boot) and re-solved on a miss, so embedding it here only bloated
  // train-store.json (~96% of the file) and the in-memory train objects.
  return normalized;
}

function buildCanonicalTrainStore() {
  return {
    schema_version: SCHEMA_VERSION,
    trains: trainStore.trains.map(normalizeExportTrain),
  };
}

// =========================================================================
//  §19.  Import parsing & normalization (lenient inbound -> canonical shape)
// =========================================================================

function parseImportedCanonicalStore(json) {
  const parsed = typeof json === "string" ? JSON.parse(json) : json;

  if (Array.isArray(parsed)) {
    return { schema_version: SCHEMA_VERSION, trains: parsed };
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      "JSON root must be a store object, a trains array, or one train object.",
    );
  }

  if (Array.isArray(parsed.trains)) {
    assertOnlyKeys(parsed, ["schema_version", "trains"], "Store");

    if (!ACCEPTED_SCHEMA_VERSIONS.includes(parsed.schema_version)) {
      throw new Error(
        `schema_version must be one of ${ACCEPTED_SCHEMA_VERSIONS.join(", ")}.`,
      );
    }

    return parsed;
  }

  if (parsed.id && parsed.stops) {
    return { schema_version: SCHEMA_VERSION, trains: [parsed] };
  }

  throw new Error(
    "JSON must contain a trains array, be a trains array, or be a single train object.",
  );
}

function assertOnlyKeys(object, allowedKeys, label) {
  Object.keys(object || {}).forEach((key) => {
    if (!allowedKeys.includes(key))
      throw new Error(`${label} contains unsupported field: ${key}.`);
  });
}

function normalizeImportedStop(stop) {
  if (!stop || typeof stop !== "object" || Array.isArray(stop)) {
    throw new Error("Each stop must be an object.");
  }

  assertOnlyKeys(
    stop,
    [
      "name",
      "n02_station_code",
      "arrival",
      "departure",
      "stop_type",
      "ride_segment",
    ],
    "Stop",
  );

  if (!("name" in stop)) {
    throw new Error("Each stop must contain name.");
  }

  return canonicalStopShape(stop);
}

function normalizeImportedRouteSection(section) {
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    throw new Error("Each route_section must be an object.");
  }

  assertOnlyKeys(
    section,
    [
      "from",
      "to",
      "from_n02_station_code",
      "to_n02_station_code",
      "line_names",
      "operator_names",
      "operator_hints",
      "number",
      "name",
    ],
    "Route section",
  );

  const normalized = {
    from: section.from || "",
    to: section.to || "",
    from_n02_station_code: section.from_n02_station_code || null,
    to_n02_station_code: section.to_n02_station_code || null,
    line_names: Array.isArray(section.line_names)
      ? section.line_names.map(String).filter(Boolean)
      : [],
    operator_names: Array.isArray(
      section.operator_names || section.operator_hints,
    )
      ? (section.operator_names || section.operator_hints)
          .map(String)
          .filter(Boolean)
      : [],
  };
  // Optional per-section branch train number / name: some limited expresses run
  // a branch portion under a DIFFERENT 号 (e.g. はやぶさ↔こまち, しおかぜ↔いしづち).
  // When present it is shown for that segment in the route popup.
  if (section.number) normalized.number = String(section.number);
  if (section.name) normalized.name = String(section.name);
  return normalized;
}

function normalizeImportedTrain(train, { fallbackDate = null } = {}) {
  if (!train || typeof train !== "object" || Array.isArray(train)) {
    throw new Error("Each train must be an object.");
  }

  assertOnlyKeys(
    train,
    [
      "id",
      "date",
      "number",
      // Legacy field (removed from the schema: it always duplicated
      // `number`). Still accepted on import, dropped on normalize/export.
      "name",
      "train_type",
      "company",
      "origin",
      "destination",
      "direction",
      "visible",
      "style",
      "route_policy",
      "route_sections",
      "stops",
      "route_geometry_cache",
    ],
    "Train",
  );

  if (!train.id) throw new Error("Each train must contain id.");
  if (!train.number) throw new Error(`Train ${train.id} must contain number.`);
  if (!train.origin) throw new Error(`Train ${train.id} must contain origin.`);
  if (!train.destination)
    throw new Error(`Train ${train.id} must contain destination.`);
  if (!Array.isArray(train.stops) || train.stops.length < 2) {
    throw new Error(`Train ${train.id} must contain at least 2 stops.`);
  }

  const normalized = {
    id: train.id,
    date: normalizeTrainDate(train, fallbackDate),
    number: train.number,
    train_type:
      typeof train.train_type === "string" ? train.train_type.trim() : "",
    company: typeof train.company === "string" ? train.company.trim() : "",
    origin: train.origin,
    destination: train.destination,
    direction: train.direction || "down",
    visible: train.visible !== false,
    style: canonicalStyle(train.style),
    route_policy: canonicalRoutePolicy(train.route_policy),
    route_sections: Array.isArray(train.route_sections)
      ? train.route_sections.map(normalizeImportedRouteSection)
      : [],
    stops: train.stops.map(normalizeImportedStop),
  };
  // A legacy file may still carry route_geometry_cache; it stays in the
  // allowed-keys list so import does not reject it, but we deliberately drop
  // it instead of loading megabytes of geometry into memory. Geometry is
  // rebuilt from IndexedDB / re-solved on first render.
  return normalized;
}

function makeUniqueTrainId(baseId, existingIds) {
  const cleanBase = String(baseId || "train").trim() || "train";
  let id = cleanBase;
  let counter = 2;

  while (existingIds.has(id)) {
    id = `${cleanBase}-${counter}`;
    counter += 1;
  }

  return id;
}

// The concrete date to assign an undated imported train to: the currently
// selected date when one is active, otherwise null (let id-inference decide).
function currentImportFallbackDate() {
  return selectedDate && selectedDate !== ALL_DATES ? selectedDate : null;
}

function appendImportedTrain(
  rawTrain,
  fallbackDate = currentImportFallbackDate(),
) {
  const train = normalizeImportedTrain(rawTrain, { fallbackDate });
  const existingIds = new Set(trainStore.trains.map((t) => t.id));
  train.id = makeUniqueTrainId(train.id, existingIds);

  // Validate ONLY the incoming train. Previously this rebuilt the whole
  // canonical store and re-validated every already-appended train (including
  // warnBranchLeak's per-section station resolution) on EVERY append — an
  // O(N²) pass that dominated large imports. Id uniqueness against the
  // existing store is already guaranteed by makeUniqueTrainId, and the one
  // authoritative full-store validateTrainStore() still runs at the end of
  // the load in finalizeProgressiveLoad().
  validateTrain(
    normalizeExportTrain(train),
    trainStore.trains.length,
    existingIds,
  );

  trainStore.trains.push(train);
  selectedTrainId = train.id;

  return train.id;
}

function waitForImportPaint() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
      return;
    }
    setTimeout(resolve, 0);
  });
}

async function importCanonicalStoreAppendProgressive(json, onProgress) {
  if (importInProgress) {
    console.warn(
      "A progressive load/import is already running; ignoring concurrent import.",
    );
    return { count: 0, ids: [] };
  }
  importInProgress = true;
  try {
    const importedStore = parseImportedCanonicalStore(json);

    if (!importedStore.trains.length) {
      throw new Error("Imported store contains no trains.");
    }

    if (onProgress) {
      onProgress({
        count: 0,
        total: importedStore.trains.length,
        id: I18N.t("prog.preparingId"),
      });
    }

    // Append mode: unlike the "replace" paths this does NOT reset the store.
    // Undated trains fall back to the currently-selected date (spec 3.1);
    // trains carrying their own `date` keep it (spec 3.2), and when "全部"
    // is active the date is inferred from the id instead.
    const appendedIds = await runProgressiveAppend(importedStore.trains, {
      persistEachStep: true,
      onProgress,
      fallbackDate: currentImportFallbackDate(),
    });

    return {
      count: appendedIds.length,
      ids: appendedIds,
    };
  } finally {
    importInProgress = false;
    // If a server-side store change arrived mid-import, reconcile it now
    // instead of dropping it (bug: deferred live reloads were never retried).
    drainPendingLiveReload();
  }
}

// =========================================================================
//  §20.  Blank-train factory, id helpers & persist/render glue
// =========================================================================

function createBlankTrain() {
  return {
    id: "LE",
    number: "",
    train_type: "特急",
    company: "",
    origin: "東京",
    destination: "熱海",
    direction: "down",
    visible: true,
    style: {
      color: "#1d7f8c",
      weight: DEFAULT_TRAIN_WEIGHT,
      unridden_opacity: DEFAULT_UNRIDDEN_OPACITY,
    },
    route_policy: {
      mode: "single_primary_route",
      jr_only: false,
      allow_alternatives: false,
      allow_browser_straight_line_fallback: false,
      allowed_institution_type_codes: [
        ...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES,
      ],
    },
    route_sections: [
      {
        from: "東京",
        to: "品川",
        from_n02_station_code: "003770",
        to_n02_station_code: "004095",
      },
      {
        from: "品川",
        to: "横浜",
        from_n02_station_code: "004095",
        to_n02_station_code: "004634",
      },
      {
        from: "横浜",
        to: "小田原",
        from_n02_station_code: "004634",
        to_n02_station_code: "005218",
      },
      {
        from: "小田原",
        to: "熱海",
        from_n02_station_code: "005218",
        to_n02_station_code: "005685",
      },
    ],
    stops: [
      {
        name: "東京",
        n02_station_code: "003770",
        arrival: null,
        departure: null,
        stop_type: "origin",
        ride_segment: true,
      },
      {
        name: "熱海",
        n02_station_code: "005685",
        arrival: null,
        departure: null,
        stop_type: "destination",
        ride_segment: true,
      },
    ],
  };
}

function uniqueId(seed) {
  // Collapse whitespace in interactive seeds (e.g. "LE-copy" from a name), then
  // delegate to the shared uniqueness loop used by the import path.
  const clean =
    String(seed || "train")
      .trim()
      .replace(/\s+/g, "-") || "train";
  return makeUniqueTrainId(clean, new Set(trainStore.trains.map((t) => t.id)));
}

function getTrain(id = selectedTrainId) {
  return trainStore.trains.find((t) => t.id === id);
}

function persistAndRender() {
  // Keep the date filter pointing at something renderable after add / delete
  // / edit so a removed date can't leave the list stuck on an empty bucket.
  reconcileSelectedDate();
  saveTrainStore();
  renderAll();
}

// =========================================================================
//  §21.  Map initialization (MapLibre GL + railprint-style map core)
// =========================================================================
// The map renders with MapLibre GL, styled after yzhouwang/railprint
// (see railmap.js for the ported style system):
//   - vendored OpenFreeMap positron vector basemap (offline -> plain
//     background, with the pre-downloaded raster tiles selectable),
//   - the full MLIT N02 national network + stations from railprint's
//     jp-2025 rail package, every line in its official color, revealed
//     by zoom tier (rank) and station spacing — OFF by default, toggled
//     via the "All Railway Lines" switch in the layers control,
//   - train routes/markers as GeoJSON layers with railprint's "ridden"
//     treatment: full official color, dark ink casing under the selected
//     route (no glow).

// Custom map-corner control: basemap picker + overlay checkboxes (replaces
// the old Leaflet layers control).
function buildMapLayersControl(hasBasemap) {
  const wrap = document.createElement("div");
  wrap.className = "map-layers-control";
  const select = document.createElement("select");
  // "Positron (online)" is ALWAYS offered: when boot degraded to offline the
  // option becomes the online-retry entry point (picking it re-attempts the
  // basemap via RailMap.retryBasemap and reverts on failure).
  const POSITRON_LABEL = "Positron (online)";
  const options = [
    ["positron", hasBasemap ? POSITRON_LABEL : POSITRON_LABEL + " — offline"],
    ["raster", "Local Tiles (offline)"],
    ["none", "No Basemap"],
  ];
  options.forEach(([value, label]) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    select.appendChild(o);
  });
  select.value = hasBasemap ? "positron" : "raster";
  RailMap.setBasemapMode(select.value);
  const posOption = select.querySelector('option[value="positron"]');
  let prevMode = select.value;
  const ensureBasemap = async () => {
    if (RailMap.hasBasemap()) return true;
    posOption.textContent = POSITRON_LABEL + " — connecting…";
    const ok = await RailMap.retryBasemap();
    posOption.textContent = ok
      ? POSITRON_LABEL
      : POSITRON_LABEL + " — retry failed";
    if (!ok)
      setTimeout(() => {
        if (!RailMap.hasBasemap())
          posOption.textContent = POSITRON_LABEL + " — offline";
      }, 2500);
    return ok;
  };
  select.addEventListener("change", async () => {
    const mode = select.value;
    if (mode === "positron" && !RailMap.hasBasemap()) {
      select.disabled = true;
      const ok = await ensureBasemap();
      select.disabled = false;
      if (!ok) {
        // Stay on the previous (working) basemap; the option label reports
        // the failure so the user knows to retry later.
        select.value = prevMode;
        return;
      }
    }
    prevMode = mode;
    RailMap.setBasemapMode(mode);
  });
  // Auto-recovery: when the browser regains connectivity, pre-warm the vector
  // basemap in the background. The view only switches if the user has already
  // picked "Positron (online)" — otherwise the option just becomes available.
  if (!hasBasemap) {
    window.addEventListener("online", () => {
      if (RailMap.hasBasemap()) return;
      ensureBasemap().then((ok) => {
        if (ok && select.value === "positron") RailMap.setBasemapMode("positron");
      });
    });
  }
  wrap.appendChild(select);
  const toggles = [
    ["Limited Express Routes", (v) => RailMap.setVisible(v), true],
    ["Stops", (v) => RailMap.setMarkerVisibility("stop", v), true],
    ["Pass-through Stations", (v) => RailMap.setMarkerVisibility("pass", v), true],
    // 全部線路（全國路網 + 車站點）：opt-in, OFF by default.
    [
      "All Railway Lines",
      (v) => {
        RailMap.setNetworkVisible(v);
        RailMap.setNetworkStationsVisible(v);
      },
      false,
    ],
  ];
  toggles.forEach(([label, apply, on]) => {
    const item = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    cb.addEventListener("change", () => apply(cb.checked));
    item.appendChild(cb);
    item.appendChild(document.createTextNode(" " + label));
    wrap.appendChild(item);
  });
  map.getContainer().appendChild(wrap);
}

async function initMap(mapAssetsReady) {
  // The vendored positron style + railprint's jp-2025 rail package load in
  // parallel (pre-started at boot, before the /api datasets); either may be
  // null (offline) — the style builder degrades the same way railprint does
  // (plain background / no network overlay).
  const [basemap, network] = await (mapAssetsReady ||
    Promise.all([RailMap.loadBasemap(), RailMap.loadNetwork()]));
  const style = RailMap.buildBaseStyle({
    basemap,
    network,
    fadeOpacity: 1 - Math.max(0, Math.min(1, Number(DISPLAY.mapOpacity))),
    // Pass-through dot LOD: the numerous white dots only draw from this zoom
    // (layer minzoom — no marker rebuild when the view crosses it).
    passMinzoom: PASSTHROUGH_MIN_ZOOM,
  });
  map = new maplibregl.Map({
    container: "map",
    style,
    // Compact (i) control aggregating the OSM basemap + N02 rail CC BY
    // credits, matching railprint (both are required to be visible).
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
    center: [138.2, 36.4],
    zoom: 4,
    fadeDuration: 200,
  });
  if (map.touchZoomRotate && map.touchZoomRotate.disableRotation)
    map.touchZoomRotate.disableRotation();
  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false }),
    "top-left",
  );

  // Bounded readiness wait: a stalled tile origin must not hang boot — the
  // rail/train sources are same-origin GeoJSON and usable immediately.
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    map.on("load", finish);
    setTimeout(finish, 9000);
  });

  RailMap.attach(
    map,
    network,
    {
      onClick: handleDeckRouteClick,
      onMarkerClick: handleDeckMarkerClick,
      onBackgroundClick: handleMapBackgroundClick,
      onHover: handleDeckHover,
      getTooltip: deckGetTooltip,
    },
    basemap ? basemap.layers.map((l) => l.id) : [],
  );
  // Selected-train width boost lives in the SEL layer's paint expression
  // (records stay selection-independent — picking a train rebuilds nothing).
  RailMap.setFocusBoost(DISPLAY.focusBoost);
  buildMapLayersControl(Boolean(basemap));

  // Basemap tile failures are expected degradation (offline) — never fatal.
  map.on("error", (e) => {
    const msg = (e && e.error && e.error.message) || "";
    const url = (e && e.error && e.error.url) || "";
    if (url.includes("openfreemap") || msg.includes("openfreemap")) return;
    console.warn("[map]", msg || e);
  });

  // Marker LOD is handled by the pass layers' minzoom (no re-render); zoom
  // only re-layouts the endpoint labels (their overlap layout is pixel-space).
  map.on("zoomend", () => {
    if (!cachedOrderedTrains.length) return;
    updateEndpointLabels();
    // Parallel pick lanes are offset in degrees computed from a PIXEL spacing
    // at the previous view; refresh them so the lanes keep a constant
    // on-screen spacing (no-op when the px→degree factor barely moved).
    maybeRefreshOverlapOffsets();
  });

  // Long north/south pans change the latitude correction even at constant
  // zoom — refresh the lane offsets when the drift exceeds the threshold.
  map.on("moveend", maybeRefreshOverlapOffsets);

  // Clamp the map over Japan; minZoom depends on the pixel viewport.
  applyJapanMapConstraints();
  map.on("resize", applyJapanMapConstraints);

  // Trackpad pinch ANYWHERE on the page zooms the MAP, never the browser
  // page (page zoom stays available via the browser's ±% menu / keyboard
  // shortcuts). In Chromium/Edge a trackpad pinch arrives as a wheel event
  // with ctrlKey set; preventDefault blocks the browser's page zoom. Over
  // the map canvas MapLibre's own scroll-zoom handler already consumes the
  // gesture, so we only forward pinches that land on the sidebar / other UI,
  // anchored at the current map center. Plain (non-pinch) two-finger scroll
  // is untouched so the sidebar still scrolls normally.
  // Attached to the SIDEBAR, not `document`: a non-passive wheel listener on
  // document disables the compositor fast path for every scroll on the page
  // (the browser must wait for JS before starting any scroll, even with the
  // early return). The map canvas is already covered by MapLibre's own
  // handler, and #sidebar + #map fill the whole viewport, so scoping the
  // listener loses nothing.
  // Shared pinch→map-zoom forwarder. anchorAtCursor keeps the point under
  // the pointer fixed (matches MapLibre's own scroll-zoom feel over the
  // canvas); the sidebar path anchors at the map center instead (the cursor
  // isn't over the map there).
  const forwardPinchZoom = (e, anchorAtCursor) => {
    e.preventDefault(); // block the browser page-zoom
    if (!map) return;
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 20; // DOM_DELTA_LINE -> px
    else if (e.deltaMode === 2) delta *= 60; // DOM_DELTA_PAGE -> px
    delta = Math.max(-50, Math.min(50, delta));
    const target = Math.max(
      map.getMinZoom(),
      Math.min(map.getMaxZoom(), map.getZoom() - delta * 0.01),
    );
    if (anchorAtCursor) {
      const rect = map.getContainer().getBoundingClientRect();
      const around = map.unproject([
        e.clientX - rect.left,
        e.clientY - rect.top,
      ]);
      map.easeTo({ zoom: target, around, duration: 0 });
    } else {
      map.setZoom(target);
    }
  };
  const sidebarEl = document.getElementById("sidebar");
  (sidebarEl || document).addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return; // not a pinch: keep normal scrolling
      if (map && map.getContainer().contains(e.target)) return; // map's own
      forwardPinchZoom(e, false);
    },
    { passive: false },
  );
  // MapLibre's scroll-zoom handler is bound to the CANVAS container, but
  // popups (segment/stop click popup, station hover popup), the layers
  // control and the nav/attribution controls live in the OUTER map container
  // — a trackpad pinch over any of them used to fall through to the browser
  // and zoom the whole page. Catch those here and forward them to the map,
  // anchored at the cursor. Events whose target is inside the canvas
  // container are left alone (MapLibre consumes and preventDefaults them),
  // and plain (non-ctrl) scrolling is untouched so popup content can still
  // scroll internally.
  map.getContainer().addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return; // not a pinch
      if (map.getCanvasContainer().contains(e.target)) return; // MapLibre's
      forwardPinchZoom(e, true);
    },
    { passive: false },
  );
  // Safari reports a trackpad pinch as gesture* events instead; blocking the
  // default suppresses its full-page zoom the same way.
  ["gesturestart", "gesturechange", "gestureend"].forEach((type) =>
    document.addEventListener(type, (e) => e.preventDefault(), {
      passive: false,
    }),
  );
}

// The one click-opened popup (route segment or stop). Tracked so a store
// replacement (live reload / delete-all) can close it — otherwise a popup
// left open kept showing data for a train that no longer exists.
let _clickPopup = null;
function openClickPopup(coordinate, html) {
  if (_clickPopup) _clickPopup.remove();
  _clickPopup = new maplibregl.Popup({ maxWidth: "320px" })
    .setLngLat(coordinate)
    .setHTML(html)
    .addTo(map);
}
function closeClickPopup() {
  if (_clickPopup) {
    _clickPopup.remove();
    _clickPopup = null;
  }
}

// Blank-map click (no route lane / station dot under the pointer) steps the
// view BACK one level instead of jumping straight to "全部":
//   1. a train is selected      -> clear the selection, stay on its day
//                                  (the whole day's routes re-appear solid);
//   2. a concrete day, no train -> back to the all-dates view ("全部");
//   3. already "全部", nothing selected -> no-op (idle clicks re-render
//      nothing).
function handleMapBackgroundClick() {
  if (selectedTrainId || focusedTrainId) {
    const day = selectedDate; // selection always lives on a concrete day
    selectDateBucket(day);
    return;
  }
  if (selectedDate !== ALL_DATES) selectDateBucket(ALL_DATES);
}

// Shared click guard for on-map route lines and station dots. Off-date
// trains are not clickable while a concrete day is active (their pick lanes
// are filtered out in railmap, this guard is belt-and-braces). `selectsNow`
// tells the caller whether the click actually SELECTS the train — a stage-1
// click from "全部" (or another day) just activates the train's day, exactly
// like pressing that date button, and must not open a popup.
function interactiveTrainFromClick(info) {
  if (!info || !info.object) return null;
  const { train, feature } = info.object;
  if (!train) return null;
  const trainDate = getTrainDate(train);
  if (selectedDate !== ALL_DATES && trainDate !== selectedDate) return null;
  return { train, feature, selectsNow: trainDate === selectedDate };
}

// Route click -> select train + open the segment popup at the clicked spot.
function handleDeckRouteClick(info) {
  const hit = interactiveTrainFromClick(info);
  if (!hit) return;
  pickTrain(hit.train.id);
  if (hit.selectsNow && info.coordinate && map) {
    openClickPopup(
      info.coordinate,
      buildTrainSegmentPopup(hit.train, hit.feature),
    );
  }
}

// =========================================================================
//  §22.  Event binding (all sidebar / editor / map UI event handlers)
// =========================================================================

function bindEvents() {
  setupDisplaySettingsPanel();
  // Re-render every dynamically-built UI string when the language changes.
  // (Static [data-i18n] DOM is handled by I18N.applyStatic; this covers the
  // JS-generated bits: display-panel labels, the focus button, the date bar,
  // train list/cards, editor, import target and the on-map labels.)
  if (window.I18N && typeof I18N.onChange === "function") {
    I18N.onChange(() => {
      DISPLAY_CONTROLS.forEach((cfg) => {
        if (cfg._name) cfg._name.textContent = I18N.t(cfg.labelKey);
      });
      DISPLAY_TOGGLES.forEach((cfg) => {
        if (cfg._span) cfg._span.textContent = I18N.t(cfg.labelKey);
      });
      updateFocusZoomButton();
      renderAll();
      updateEndpointLabels();
    });
  }
  document
    .getElementById("add-train")
    .addEventListener("click", () => addTrain());
  document
    .getElementById("duplicate-train")
    .addEventListener("click", () => duplicateTrain(selectedTrainId));
  document.getElementById("delete-train").addEventListener("click", () => {
    if (selectedTrainId && confirm(I18N.t("confirm.deleteTrain")))
      deleteTrain(selectedTrainId);
  });
  document.getElementById("delete-all-trains").addEventListener("click", () => {
    if (trainStore.trains.length && confirm(I18N.t("confirm.deleteAll"))) {
      deleteAllTrains();
      setStatus(els.jsonStatus, I18N.t("status.allDeleted"), "warn");
    }
  });
  document
    .getElementById("fit-selected")
    .addEventListener("click", () => fitTrainBounds(getTrain()));
  document.getElementById("clear-selection").addEventListener("click", () => {
    selectedTrainId = null;
    focusedTrainId = null;
    renderAll();
  });
  document
    .getElementById("save-fields")
    .addEventListener("click", saveSelectedFields);
  document
    .getElementById("toggle-visible")
    .addEventListener("click", () => toggleTrainVisibility(selectedTrainId));
  document
    .getElementById("move-up")
    .addEventListener("click", () => moveTrain(selectedTrainId, -1));
  document
    .getElementById("move-down")
    .addEventListener("click", () => moveTrain(selectedTrainId, 1));
  document
    .getElementById("add-stop")
    .addEventListener("click", addStopToSelected);
  document
    .getElementById("rebuild-route")
    .addEventListener("click", rebuildSelectedRoute);
  document
    .getElementById("open-local-json")
    .addEventListener("click", async () => {
      try {
        fitJapanMainIslands();
        setImportProgress(0, 1, I18N.t("prog.openingLocal"));
        await openLocalJsonFile();
        // Opening a local file replaces the store; persist it to the server now.
        await flushServerStoreSave();
      } catch (error) {
        setStatus(els.importStatus, error.message, "err");
      }
    });
  // Shared by the "保存／另存 JSON" and "下載 JSON" buttons — the two handlers
  // were byte-for-byte identical, so they now literally share one function.
  const saveLocalJsonHandler = async () => {
    try {
      await writeLocalJsonFile(exportTrainStore(), true);
      setStatus(els.jsonStatus, I18N.t("status.savedTo", { name: LOCAL_JSON_FILENAME }), "ok");
    } catch (error) {
      setStatus(els.jsonStatus, error.message, "err");
    }
  };
  document
    .getElementById("save-local-json")
    .addEventListener("click", saveLocalJsonHandler);
  els.localJsonFileInput.addEventListener("change", async () => {
    const file = els.localJsonFileInput.files?.[0];
    if (!file) return;
    try {
      // No trailing renderAll(): replaceTrainStoreFromJsonText() already
      // repaints once via finalizeProgressiveLoad().
      await replaceTrainStoreFromJsonText(
        await file.text(),
        I18N.t("src.localJson", { name: file.name }),
      );
    } catch (error) {
      setStatus(els.importStatus, error.message, "err");
    }
  });
  document
    .getElementById("validate-import-json")
    .addEventListener("click", validateTextareaJson);
  document
    .getElementById("apply-import-json")
    .addEventListener("click", async () => {
      // The progressive import owns the importInProgress lock; the handler only
      // pre-checks it (cheap reject) and disables the button against double-clicks.
      if (importInProgress) return;
      const applyButton = document.getElementById("apply-import-json");
      applyButton.disabled = true;
      try {
        fitJapanMainIslands();
        resetImportProgress();
        els.search.value = "";
        const result = await importCanonicalStoreAppendProgressive(
          els.importJson.value,
          ({ count, total, id }) => {
            // Live count shown only in the progress bar; importStatus gets the
            // final summary below so the two lines don't repeat each other.
            setImportProgress(
              count,
              total,
              I18N.t("prog.loadingShort", { count, total, id }),
            );
          },
        );
        setImportProgress(
          result.count,
          result.count,
          I18N.t("prog.done", { count: result.count }),
        );
        setStatus(
          els.importStatus,
          I18N.t("status.imported", { count: result.count, ids: result.ids.join(", ") }),
          "ok",
        );
        // Force-flush the debounced server autosave so the import is persisted now.
        await flushServerStoreSave();
      } catch (error) {
        setStatus(els.importStatus, error.message, "err");
      } finally {
        els.importJson.value = "";
        applyButton.disabled = false;
      }
    });
  document.getElementById("export-json").addEventListener("click", () => {
    els.json.value = exportTrainStore();
    setStatus(
      els.jsonStatus,
      I18N.t("status.exported"),
      "ok",
    );
  });
  document
    .getElementById("download-json")
    .addEventListener("click", saveLocalJsonHandler);
  document
    .getElementById("download-html")
    .addEventListener("click", () =>
      downloadText("index.html", buildPortableHtml(), "text/html"),
    );
  document.getElementById("reset-defaults").addEventListener("click", () => {
    trainStore = getDefaultTrainStore();
    selectedTrainId = trainStore.trains[0]?.id || null;
    focusedTrainId = null;
    persistAndRender();
    setStatus(els.jsonStatus, I18N.t("status.resetDefaults"), "ok");
  });
  document
    .getElementById("clear-storage")
    .addEventListener("click", async () => {
      try {
        // Cancel any pending autosave so it can't immediately re-create the file.
        clearTimeout(serverStoreSaveTimer);
        pendingServerStoreText = null;
        storeSaveDirty = false;
        // A PUT already in flight could land AFTER our DELETE and resurrect
        // the file on the server (other tabs would then reload the store this
        // tab just cleared). Wait for it to settle first.
        if (serverStoreSaveInFlight) await serverStoreSavePromise;
        pendingServerStoreText = null;
        storeSaveDirty = false;
        const res = await fetch(`${API_BASE}/${TRAIN_STORE_API}`, {
          method: "DELETE",
          headers: { "X-Client-Id": CLIENT_ID },
        });
        if (!res.ok && res.status !== 404)
          throw new Error(`${res.status} ${res.statusText}`);
        await deleteStoredFileHandle();
        setStatus(
          els.jsonStatus,
          I18N.t("status.clearedAll"),
          "warn",
        );
      } catch (error) {
        setStatus(els.jsonStatus, I18N.t("status.clearFail", { msg: error.message }), "err");
      }
    });
  // Debounce search: re-rendering the list on every keystroke (and, before,
  // JSON.stringify-ing every train including its route geometry per keystroke)
  // made typing janky. Coalesce keystrokes into one render after a short pause.
  let searchDebounceTimer = null;
  els.search.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(renderTrainList, 120);
  });
  document.getElementById("add-date").addEventListener("click", addManualDate);
  document
    .getElementById("remove-empty-dates")
    .addEventListener("click", removeEmptyDates);

  // When the tab is hidden, flush any pending (debounced) save immediately so
  // unsaved edits aren't lost if the page is backgrounded/closed. There are no
  // always-on animation/interval loops in this app to pause; the only deferred
  // work (route-graph prebuild) is a one-shot requestIdleCallback.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushServerStoreSave();
  });
  if (els.mapDateFilter) {
    els.mapDateFilter.addEventListener("change", () => {
      mapFollowsSelectedDate = els.mapDateFilter.checked;
      persistUiDateState();
      renderTrainLayers();
    });
  }
  if (els.toggleFocusZoom) {
    els.toggleFocusZoom.addEventListener("click", () => {
      focusZoomEnabled = !focusZoomEnabled;
      persistUiDateState();
      updateFocusZoomButton();
    });
  }
  updateFocusZoomButton();
}

// =========================================================================
//  §23.  Render orchestration & sidebar (date bar + train list)
// =========================================================================

// Reflect the auto-focus toggle state on its button.
function updateFocusZoomButton() {
  const btn = els.toggleFocusZoom;
  if (!btn) return;
  btn.textContent = I18N.t("btn.autoFocus") + I18N.t(focusZoomEnabled ? "state.on" : "state.off");
  btn.setAttribute("aria-pressed", focusZoomEnabled ? "true" : "false");
  btn.classList.toggle("active", focusZoomEnabled);
}

function renderAll({ updateJsonTextarea = true } = {}) {
  perfMeasure("renderDateButtons", renderDateButtons);
  perfMeasure("renderTrainList", renderTrainList);
  updateImportTarget();
  perfMeasure("renderEditor", renderEditor);
  perfMeasure("renderTrainLayers", renderTrainLayers);
  // Serializing the whole store to fill the export textarea is O(store size).
  // Callers in hot loops (progressive import) skip it; everyone else gets a
  // debounced refresh so the serialization never blocks the interaction.
  if (updateJsonTextarea) scheduleExportTextareaRefresh();
}

// Human-readable label for a date bucket used in buttons / titles.
function dateLabel(date) {
  if (date === ALL_DATES) return I18N.t("date.all");
  if (date === UNDATED) return I18N.t("date.undated");
  return date;
}

// The date-selector bar: a "全部" button plus one button per available date
// (dynamically generated, no fixed cap), ordered earliest-first. The active
// date is highlighted. Clicking only re-scopes the sidebar list.
function renderDateButtons() {
  if (!els.dateBar) return;
  const dates = getAvailableDates(trainStore.trains);
  els.dateBar.innerHTML = "";
  const fragment = document.createDocumentFragment();

  const makeButton = (date, label, count) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `date-btn${date === selectedDate ? " active" : ""}`;
    btn.dataset.date = date;
    const countHtml =
      count === null ? "" : `<span class="date-count">${count}</span>`;
    btn.innerHTML = `${escapeHtml(label)}${countHtml}`;
    btn.addEventListener("click", () => selectDateBucket(date));
    fragment.appendChild(btn);
  };

  makeButton(ALL_DATES, I18N.t("date.all"), trainStore.trains.length);
  dates.forEach((date) => {
    makeButton(
      date,
      dateLabel(date),
      getTrainsForDate(trainStore.trains, date).length,
    );
  });

  els.dateBar.appendChild(fragment);
  if (els.mapDateFilter) els.mapDateFilter.checked = mapFollowsSelectedDate;
}

// Switch the sidebar date filter. Does NOT reload the basemap or drop any
// imported train — it only changes which trains the list shows (and, when
// the "map follows date" toggle is on, which trains draw).
function setSelectedDate(date) {
  selectedDate = date;
  persistUiDateState();
  renderDateButtons();
  renderTrainList();
  updateImportTarget();
  // A concrete date now always re-scopes the map (dim other dates), and
  // returning to "全部" restores full opacity — so always redraw.
  renderTrainLayers();
}

// Clicking a date button (including "全部") clears any train selection so the
// date scope takes effect: a concrete date shows that day solid + other dates
// dimmed; "全部" deselects and shows every train at full opacity. With
// auto-focus on, a concrete date also zooms the map to that whole day.
function selectDateBucket(date) {
  selectedTrainId = null;
  focusedTrainId = null;
  setSelectedDate(date);
  renderEditor();
  updateSelectionHighlight();
  scrollActiveDateButtonIntoView();
  if (focusZoomEnabled && date !== ALL_DATES) fitDateBounds(date);
}

// Two-stage train pick shared by the sidebar card and the on-map route line.
// First interaction with a day (selecting a train whose date is not the active
// one — e.g. from "全部" or another date) only switches to that day and
// highlights ALL of its trains. A second click, once that day is active,
// selects the single train. Within the already-active day the first click
// selects directly.
function pickTrain(id) {
  const train = getTrain(id);
  if (!train) return;
  const date = getTrainDate(train);
  if (selectedDate !== date) {
    // Stage 1: enter the day and highlight the whole day (no single selection).
    selectDateBucket(date);
    return;
  }
  // Stage 2: the day is already active — select this single train.
  selectTrain(id, { fit: focusZoomEnabled });
}

// Trains to show in the current sidebar scope, already sorted. "全部" shows
// everything (date ASC, departure ASC, undated last); a concrete date shows
// only that day's trains sorted by departure.
function getVisibleListTrains() {
  const base =
    selectedDate === ALL_DATES
      ? trainStore.trains
      : getTrainsForDate(trainStore.trains, selectedDate);
  return sortTrainsByDateAndDeparture(base);
}

function renderTrainList() {
  const query = els.search.value.trim().toLowerCase();
  const showingAll = selectedDate === ALL_DATES;

  if (els.listTitle) {
    els.listTitle.textContent = showingAll
      ? I18N.t("list.allTitle", { count: trainStore.trains.length })
      : I18N.t("list.dateTitle", { date: dateLabel(selectedDate) });
  }

  const trains = getVisibleListTrains().filter(
    (train) => !query || trainMatchesQuery(train, query),
  );

  els.list.innerHTML = "";

  if (!trains.length) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = showingAll
      ? query
        ? I18N.t("empty.allSearch")
        : I18N.t("empty.allNone")
      : query
        ? I18N.t("empty.dateSearch")
        : I18N.t("empty.dateNone");
    els.list.appendChild(empty);
    return;
  }

  // Build the whole list in a detached fragment so the live DOM only reflows
  // once on insertion instead of once per train.
  const fragment = document.createDocumentFragment();
  trains.forEach((train) =>
    fragment.appendChild(buildTrainListItemElement(train, showingAll)),
  );
  els.list.appendChild(fragment);
}

// Build ONE sidebar card. Shared by the full renderTrainList() and the
// incremental per-train append used during progressive import, so both render
// identically.
function buildTrainListItemElement(train, showingAll) {
  const item = document.createElement("button");
  item.type = "button";
  item.dataset.trainId = train.id;
  item.className = `train-item${train.id === selectedTrainId ? " selected" : ""}${train.id === focusedTrainId ? " focused" : ""}`;
  // In the combined "全部" view each card shows its date badge; per-date views
  // omit it (the whole list is one date already).
  const dateBadge = showingAll
    ? `<span class="train-date-badge">${escapeHtml(dateLabel(getTrainDate(train)))}</span>`
    : "";
  const depMinutes = getTrainDepartureMinutes(train);
  const depText = depMinutes === Infinity ? "—:—" : formatMinutes(depMinutes);
  item.innerHTML = `
        <span class="swatch" style="background:${escapeAttr(train.style?.color || DEFAULT_TRAIN_COLOR)}"></span>
        <span style="min-width:0">
          <span class="train-title">${dateBadge}${escapeHtml(train.number || train.id)} ${escapeHtml(trainTypeCompanyLabel(train))}</span>
          <span class="train-meta">${escapeHtml(I18N.placeName(train.origin || "?"))} → ${escapeHtml(I18N.placeName(train.destination || "?"))} · ${I18N.t("tag.dep")} ${escapeHtml(depText)} · ${train.stops?.length || 0} ${I18N.t("unit.stops")}</span>
        </span>
        <span class="train-meta">${train.visible === false ? I18N.t("state.hidden") : I18N.t("state.shown")}</span>
      `;
  item.addEventListener("click", () => pickTrain(train.id));
  return item;
}

// Same date + search predicate renderTrainList() applies, for a single train.
function trainPassesListFilter(train) {
  const query = els.search.value.trim().toLowerCase();
  if (query && !trainMatchesQuery(train, query)) return false;
  if (selectedDate !== ALL_DATES && getTrainDate(train) !== selectedDate)
    return false;
  return true;
}

// Append exactly one card during progressive import (O(1)) instead of
// rebuilding the whole list each iteration (which was O(N^2) over the import).
// The authoritative sorted list is rebuilt once by the final renderAll().
function appendTrainListItemIncremental(train) {
  if (!trainPassesListFilter(train)) return;
  const empty = els.list.querySelector(".list-empty");
  if (empty) empty.remove();
  els.list.appendChild(
    buildTrainListItemElement(train, selectedDate === ALL_DATES),
  );
}

// Lightweight search match. The old code ran JSON.stringify(train) — which now
// serializes each train's full route_geometry_cache — for every train on every
// keystroke. Match only the human-facing fields (id, number, name, direction,
// endpoints, date, and stop names) instead. Built lazily and reused.
function trainMatchesQuery(train, query) {
  const parts = [
    train.id,
    train.number,
    train.train_type,
    train.company,
    train.direction,
    train.origin,
    train.destination,
    getTrainDate(train),
  ];
  (train.stops || []).forEach((stop) => {
    if (stop && stop.name) parts.push(stop.name);
  });
  return parts.join(" ").toLowerCase().includes(query);
}

// Toggle the `.selected` / `.focused` classes on the existing list cards
// instead of rebuilding the whole list. Selecting a train used to call
// renderAll() — a full date-bar + list + editor + map rebuild — just to move
// a highlight. This touches only the two affected nodes' classList.
function updateSelectionHighlight() {
  const kids = els.list.children;
  for (let i = 0; i < kids.length; i += 1) {
    const el = kids[i];
    const id = el.dataset && el.dataset.trainId;
    if (!id) continue;
    el.classList.toggle("selected", id === selectedTrainId);
    el.classList.toggle("focused", id === focusedTrainId);
  }
}

// Select + focus a train with the minimum work needed: update the list
// highlight in place, refresh the editor for the new selection, and redraw
// the map ONCE (focus changes route dimming, so the map layer does need a
// pass). Crucially this does NOT rebuild the date bar or the whole list, and
// the export textarea refresh is debounced — so clicking through trains stays
// snappy. Shared by the sidebar list and the on-map route click.
function selectTrain(id, { fit = false } = {}) {
  selectedTrainId = id;
  focusedTrainId = id;
  // Jump the sidebar to this train's own date so the correct date button is
  // active and the correct card is shown/highlighted (e.g. clicking a route on
  // the map while a different date — or "全部" — is selected).
  const train = getTrain(id);
  const trainDate = train ? getTrainDate(train) : null;
  if (trainDate && trainDate !== selectedDate) {
    selectedDate = trainDate;
    persistUiDateState();
    renderDateButtons();
    renderTrainList();
    updateImportTarget();
  }
  updateSelectionHighlight();
  scrollActiveDateButtonIntoView();
  scrollSelectedCardIntoView();
  perfMeasure("renderEditor", renderEditor);
  perfMeasure("renderTrainLayers", renderTrainLayers);
  scheduleExportTextareaRefresh();
  if (fit && train) fitTrainBounds(train);
}

// Bring the highlighted sidebar card into view after a map-driven selection.
function scrollSelectedCardIntoView() {
  if (!els.list || !selectedTrainId) return;
  const card = els.list.querySelector(`[data-train-id="${selectedTrainId}"]`);
  if (card && typeof card.scrollIntoView === "function") {
    card.scrollIntoView({ block: "nearest" });
  }
}

// Scroll the (horizontally scrolling) date bar so the active date button is
// visible — used whenever a pick auto-jumps the selected date.
function scrollActiveDateButtonIntoView() {
  if (!els.dateBar) return;
  const active = els.dateBar.querySelector(".date-btn.active");
  if (active && typeof active.scrollIntoView === "function") {
    active.scrollIntoView({ block: "nearest", inline: "center" });
  }
}

// Auto-focus the map on every train of a given date (its whole-day view).
function fitDateBounds(date) {
  if (!map) return;
  const dayTrains = getTrainsForDate(trainStore.trains, date).filter(
    (t) => t.visible !== false,
  );
  const features = [];
  dayTrains.forEach((train) => {
    getMatchedRouteFeatures(train).forEach((feature) => features.push(feature));
  });
  const bounds = featureCollectionBounds(features);
  if (bounds) {
    smoothFitBounds(bounds, { padding: 90, maxZoom: 11 });
    return;
  }
  const points = [];
  dayTrains.forEach((train) =>
    (train.stops || []).forEach((stop) => {
      const ll = resolveStationForTrain(stop, train);
      if (ll) points.push(toLatLng(ll));
    }),
  );
  const ptBounds = latLngPointsBounds(points);
  if (ptBounds) smoothFitBounds(ptBounds, { padding: 90, maxZoom: 11 });
}

// Render minutes-from-midnight back to "HH:mm" (wrapping next-day times).
function formatMinutes(total) {
  const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = String(Math.floor(wrapped / 60)).padStart(2, "0");
  const mm = String(wrapped % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Show where an imported JSON will land, so the user knows before importing.
function updateImportTarget() {
  if (!els.importTarget) return;
  if (selectedDate && selectedDate !== ALL_DATES) {
    els.importTarget.innerHTML = I18N.t("import.targetDate", {
      date: escapeHtml(dateLabel(selectedDate)),
    });
  } else {
    els.importTarget.innerHTML = I18N.t("import.targetAuto");
  }
}

// Add a manual (possibly empty) date bucket, then jump to it.
function addManualDate() {
  const input = prompt(I18N.t("prompt.addDate"), "");
  if (input === null) return;
  const normalized = normalizeDateString(input);
  if (!normalized) {
    setStatus(
      els.importStatus,
      I18N.t("status.invalidDate", { input }),
      "err",
    );
    return;
  }
  if (!manualDates.includes(normalized)) manualDates.push(normalized);
  setSelectedDate(normalized);
  setStatus(
    els.importStatus,
    I18N.t("status.dateAdded", { date: normalized }),
    "ok",
  );
}

// Drop manually-created date buttons that hold no trains. Dates still backed
// by at least one train are derived from the trains and cannot be removed
// here (delete the trains instead).
function removeEmptyDates() {
  const used = new Set(trainStore.trains.map(getTrainDate));
  const before = manualDates.length;
  manualDates = manualDates.filter((date) => used.has(date));
  reconcileSelectedDate();
  persistUiDateState();
  renderAll();
  const removed = before - manualDates.length;
  setStatus(
    els.importStatus,
    removed ? I18N.t("status.emptyDatesRemoved", { count: removed }) : I18N.t("status.noEmptyDates"),
    removed ? "ok" : "warn",
  );
}

// =========================================================================
//  §24.  Editor panel & stops table (per-train field + stop editing)
// =========================================================================

function renderEditor() {
  const train = getTrain();
  const disabled = !train;
  [
    els.id,
    els.number,
    els.trainType,
    els.company,
    els.direction,
    els.origin,
    els.destination,
    els.color,
    els.weight,
  ].forEach((el) => (el.disabled = disabled));
  document.getElementById("duplicate-train").disabled = disabled;
  document.getElementById("delete-train").disabled = disabled;
  document.getElementById("delete-all-trains").disabled =
    !trainStore.trains.length;
  document.getElementById("fit-selected").disabled = disabled;
  document.getElementById("clear-selection").disabled =
    !selectedTrainId && !focusedTrainId;
  document.getElementById("toggle-visible").disabled = disabled;
  if (!train) {
    els.id.value =
      els.number.value =
      els.trainType.value =
      els.company.value =
      els.direction.value =
      els.origin.value =
      els.destination.value =
        "";
    els.color.value = DEFAULT_TRAIN_COLOR;
    els.weight.value = DEFAULT_TRAIN_WEIGHT;
    els.stopsBody.innerHTML = "";
    return;
  }
  els.id.value = train.id || "";
  els.number.value = train.number || "";
  els.trainType.value = train.train_type || "";
  els.company.value = train.company || "";
  els.direction.value = train.direction || "";
  els.origin.value = train.origin || "";
  els.destination.value = train.destination || "";
  els.color.value = normalizeColor(train.style?.color || DEFAULT_TRAIN_COLOR);
  els.weight.value = train.style?.weight || DEFAULT_TRAIN_WEIGHT;
  renderStopsTable(train);
}

// Colour palette for branch (支線) groups in the stops table. Each maximal run
// of consecutive route_sections that share the same line_names (+ branch number)
// becomes one branch and gets the next colour.
const BRANCH_COLORS = [
  "#2563eb",
  "#16a34a",
  "#db2777",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#dc2626",
  "#4d7c0f",
];

// Derive branches from the train's per-adjacent-stop route_sections. A branch
// spans stops [startIdx..endIdx] (inclusive); adjacent branches SHARE the
// boundary stop, which is the divergence station (支线分理处). Trains with no
// line_names collapse to a single unlabeled branch (ordinary single-line view).
function deriveTrainBranches(train) {
  const stops = train.stops || [];
  if (stops.length < 2)
    return [
      {
        line: "",
        number: "",
        startIdx: 0,
        endIdx: Math.max(0, stops.length - 1),
        colorIndex: 0,
      },
    ];
  const sections = getRideRouteSectionsForTrain(train);
  if (!sections.length)
    return [
      { line: "", number: "", startIdx: 0, endIdx: stops.length - 1, colorIndex: 0 },
    ];
  const keyOf = (s) =>
    `${(s.line_names || []).map(String).slice().sort().join(",")}|${s.number || ""}`;
  const branches = [];
  let cur = null;
  sections.forEach((sec, i) => {
    const k = keyOf(sec);
    if (!cur || cur.key !== k) {
      cur = {
        key: k,
        line: (sec.line_names || [])[0] || "",
        number: sec.number || "",
        startIdx: i,
        endIdx: i + 1,
        colorIndex: branches.length,
      };
      branches.push(cur);
    } else {
      cur.endIdx = i + 1;
    }
  });
  return branches;
}

function renderStopsTable(train) {
  els.stopsBody.innerHTML = "";
  const stops = train.stops || [];
  const branches = deriveTrainBranches(train);
  const showHeaders =
    branches.length > 1 ||
    (branches[0] && (branches[0].line || branches[0].number));

  // Owning branch of each stop = first branch that contains it (so a shared
  // junction is owned by the earlier branch and only toggled/edited once).
  const ownerOf = new Array(stops.length).fill(0);
  const ownedSeen = new Set();
  branches.forEach((b, bi) => {
    for (let i = b.startIdx; i <= b.endIdx; i += 1) {
      if (!ownedSeen.has(i)) {
        ownerOf[i] = bi;
        ownedSeen.add(i);
      }
    }
  });

  const editableRow = (stop, index, color) => {
    const tr = document.createElement("tr");
    tr.style.borderLeft = `4px solid ${color}`;
    tr.innerHTML = `
          <td>${index + 1}</td>
          <td><input data-stop-field="name" data-stop-index="${index}" value="${escapeAttr(stopName(stop))}"></td>
          <td><input data-stop-field="arrival" data-stop-index="${index}" value="${escapeAttr(stop.arrival ?? "")}"></td>
          <td><input data-stop-field="departure" data-stop-index="${index}" value="${escapeAttr(stop.departure ?? "")}"></td>
          <td>
            <select data-stop-field="stop_type" data-stop-index="${index}">
              ${["origin", "passenger_stop", "pass_through", "operational_stop", "destination"].map((type) => `<option value="${type}" ${stop.stop_type === type ? "selected" : ""}>${I18N.t("stoptype." + type)}</option>`).join("")}
            </select>
          </td>
          <td>
            <input
              type="checkbox"
              data-stop-field="ride_segment"
              data-stop-index="${index}"
              ${(isPassThroughStop(stop) ? effectiveStopRide(train.stops, index) : stop.ride_segment) ? "checked" : ""}
              ${isPassThroughStop(stop) ? "disabled" : ""}
              title="${escapeAttr(isPassThroughStop(stop) ? "通過站不可單獨切換：隨其所在停靠站區間自動顯示／隱藏 (pass-through follows its stop interval)" : I18N.t("tip.rideSegment"))}"
            >
          </td>
          <td class="stop-actions">
            <button class="icon" title="Move up" data-stop-action="up" data-stop-index="${index}">↑</button>
            <button class="icon" title="Move down" data-stop-action="down" data-stop-index="${index}">↓</button>
            <button class="icon danger" title="Delete" data-stop-action="delete" data-stop-index="${index}">×</button>
          </td>
        `;
    return tr;
  };

  const editableSeen = new Set();
  branches.forEach((b, bi) => {
    const color = BRANCH_COLORS[b.colorIndex % BRANCH_COLORS.length];
    if (showHeaders) {
      const label =
        (b.line || I18N.t("branch.noline")) + (b.number ? ` · ${b.number}` : "");
      const htr = document.createElement("tr");
      htr.className = "branch-header";
      htr.innerHTML = `<td colspan="7" style="border-left:4px solid ${color}">
            <span class="branch-swatch" style="background:${color}"></span>
            <strong>${escapeHtml(label)}</strong>
            ${b.number ? `<span class="branch-tag">${escapeHtml(I18N.t("branch.tag"))}</span>` : ""}
            <label class="branch-ride"><input type="checkbox" data-branch-ride="${bi}"> ${escapeHtml(I18N.t("branch.rideAll"))}</label>
          </td>`;
      els.stopsBody.appendChild(htr);
    }
    for (let i = b.startIdx; i <= b.endIdx; i += 1) {
      const stop = stops[i];
      if (!stop) continue;
      if (editableSeen.has(i)) {
        // Already rendered editable in the previous branch — show the shared
        // divergence station as a read-only anchor so each branch starts at it.
        const tr = document.createElement("tr");
        tr.className = "branch-junction";
        tr.style.borderLeft = `4px solid ${color}`;
        tr.innerHTML = `
              <td>${i + 1}</td>
              <td>${escapeHtml(stopName(stop))} <span class="branch-tag">${escapeHtml(I18N.t("branch.junction"))}</span></td>
              <td>${escapeHtml(stop.arrival ?? "")}</td>
              <td>${escapeHtml(stop.departure ?? "")}</td>
              <td>${escapeHtml(I18N.t("stoptype." + stop.stop_type))}</td>
              <td></td><td></td>`;
        els.stopsBody.appendChild(tr);
        continue;
      }
      editableSeen.add(i);
      els.stopsBody.appendChild(editableRow(stop, i, showHeaders ? color : ""));
    }
  });

  // Branch master toggle: ride/hide every owned stopping station in one click.
  branches.forEach((b, bi) => {
    const cb = els.stopsBody.querySelector(`[data-branch-ride="${bi}"]`);
    if (!cb) return;
    const owned = [];
    for (let i = b.startIdx; i <= b.endIdx; i += 1) {
      if (ownerOf[i] === bi && isStoppingStation(stops[i])) owned.push(stops[i]);
    }
    const on = owned.filter((s) => s.ride_segment === true).length;
    cb.checked = owned.length > 0 && on === owned.length;
    cb.indeterminate = on > 0 && on < owned.length;
    cb.addEventListener("change", (event) => {
      const t = getTrain();
      if (!t) return;
      const value = event.target.checked;
      for (let i = b.startIdx; i <= b.endIdx; i += 1) {
        if (ownerOf[i] === bi && isStoppingStation(t.stops[i])) {
          t.stops[i].ride_segment = value;
          setAdjacentPassThroughStops(t, i, value);
        }
      }
      saveTrainStore();
      perfMeasure("renderTrainLayers", renderTrainLayers);
      scheduleExportTextareaRefresh();
      renderStopsTable(t);
    });
  });

  els.stopsBody.querySelectorAll("[data-stop-field]").forEach((input) => {

    input.addEventListener("change", (event) => {
      const train = getTrain();
      const index = Number(event.target.dataset.stopIndex);
      const field = event.target.dataset.stopField;
      if (!train?.stops?.[index]) return;

      let refreshStopsTable = false;

      if (field === "ride_segment") {
        // Pass-through stations are not individually toggleable; their visibility
        // is derived from the bounding stops. Ignore any stray event and redraw.
        if (isPassThroughStop(train.stops[index])) {
          renderStopsTable(train);
          return;
        }
        const enabled = event.target.checked;
        train.stops[index][field] = enabled;

        // Pass-through stops remain directly toggleable. When a real
        // stopping station is toggled, mirror that value to all
        // pass-through stops between it and the neighbouring stopping
        // stations on both sides. This keeps a disabled station from
        // leaving bright orphan through markers, and also restores the
        // same intermediate through-stops when the station is re-enabled.
        if (isStoppingStation(train.stops[index])) {
          refreshStopsTable = setAdjacentPassThroughStops(
            train,
            index,
            enabled,
          );
        }
      } else {
        train.stops[index][field] = normalizeStopValue(
          field,
          event.target.value,
        );
        refreshStopsTable = field === "stop_type";
      }

      if (field === "name") applyStationMetadata(train.stops[index], train);

      saveTrainStore();
      perfMeasure("renderTrainLayers", renderTrainLayers);
      scheduleExportTextareaRefresh();
      if (refreshStopsTable) renderStopsTable(train);
    });
  });

  els.stopsBody.querySelectorAll("[data-stop-action]").forEach((button) => {
    button.addEventListener("click", () =>
      mutateStop(Number(button.dataset.stopIndex), button.dataset.stopAction),
    );
  });
}

function saveSelectedFields() {
  const train = getTrain();
  if (!train) return;
  const oldId = train.id;
  const next = {
    ...train,
    id: els.id.value.trim(),
    number: els.number.value.trim(),
    train_type: els.trainType.value.trim(),
    company: els.company.value.trim(),
    direction: els.direction.value.trim(),
    origin: els.origin.value.trim(),
    destination: els.destination.value.trim(),
    style: {
      ...(train.style || {}),
      color: els.color.value,
      weight: Number(els.weight.value || DEFAULT_TRAIN_WEIGHT),
    },
  };
  try {
    const temp = clone(trainStore);
    temp.trains = temp.trains.map((t) => (t.id === oldId ? next : t));
    validateTrainStore(temp);
    trainStore = temp;
    selectedTrainId = next.id;
    persistAndRender();
    setStatus(els.fieldStatus, I18N.t("status.fieldsSaved"), "ok");
  } catch (error) {
    setStatus(els.fieldStatus, error.message, "err");
  }
}

function addStopToSelected() {
  const train = getTrain();
  if (!train) return;
  train.stops = train.stops || [];
  const stop = {
    name: train.destination || "",
    n02_station_code: null,
    arrival: null,
    departure: null,
    stop_type: "passenger_stop",
    ride_segment: true,
  };
  applyStationMetadata(stop, train);
  train.stops.push(stop);
  persistAndRender();
}

function normalizeStopValue(field, value) {
  if ((field === "arrival" || field === "departure") && value.trim() === "")
    return null;
  return value;
}

function isPassThroughStop(stop) {
  return stop?.stop_type === "pass_through";
}

function isStoppingStation(stop) {
  return Boolean(stop) && !isPassThroughStop(stop);
}

function findPreviousStoppingStationIndex(stops, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (isStoppingStation(stops[cursor])) return cursor;
  }
  return -1;
}

function findNextStoppingStationIndex(stops, index) {
  for (let cursor = index + 1; cursor < stops.length; cursor += 1) {
    if (isStoppingStation(stops[cursor])) return cursor;
  }
  return -1;
}

function setPassThroughStopsBetween(stops, startIndex, endIndex, enabled) {
  if (startIndex < 0 || endIndex < 0 || startIndex >= endIndex) return false;
  let changed = false;
  for (let cursor = startIndex + 1; cursor < endIndex; cursor += 1) {
    const stop = stops[cursor];
    if (!isPassThroughStop(stop)) continue;
    if (stop.ride_segment !== enabled) {
      stop.ride_segment = enabled;
      changed = true;
    }
  }
  return changed;
}

function setAdjacentPassThroughStops(train, stopIndex, enabled) {
  const stops = train?.stops || [];
  const previousStopIndex = findPreviousStoppingStationIndex(stops, stopIndex);
  const nextStopIndex = findNextStoppingStationIndex(stops, stopIndex);
  const changedBefore = setPassThroughStopsBetween(
    stops,
    previousStopIndex,
    stopIndex,
    enabled,
  );
  const changedAfter = setPassThroughStopsBetween(
    stops,
    stopIndex,
    nextStopIndex,
    enabled,
  );
  return changedBefore || changedAfter;
}

// Effective "ridden" (shown) state of a stop for display & hiding.
//   - A real stopping station uses its own ride_segment flag (user-toggleable).
//   - A pass-through (非停車站) is NOT individually toggleable: it inherits the
//     ride state of the stop-to-stop interval it lies in, i.e. it is shown only
//     when BOTH bounding stopping stations are ridden. So hiding the interval
//     between two stops automatically hides every pass-through inside it.
// "Hidden" everywhere means truly not drawn (see routeSegmentStyleValues /
// the marker loops), not merely a lower opacity.
function effectiveStopRide(stops, index) {
  const stop = stops && stops[index];
  if (!stop) return false;
  if (isStoppingStation(stop)) return stop.ride_segment === true;
  const prev = findPreviousStoppingStationIndex(stops, index);
  const next = findNextStoppingStationIndex(stops, index);
  if (prev < 0 || next < 0) return stop.ride_segment === true;
  return (
    stops[prev].ride_segment === true && stops[next].ride_segment === true
  );
}

function applyStationMetadata(stop, train) {
  const station = resolveStationForTrain(stop, train);
  if (!station) return;
  stop.name = stationName(station);
  delete stop.station;
  stop.n02_station_code = stationCode(station);
  stop.n02_group_code = stationGroupCode(station);
}

function mutateStop(index, action) {
  const train = getTrain();
  if (!train || !train.stops?.[index]) return;
  if (action === "delete") train.stops.splice(index, 1);
  if (action === "up" && index > 0)
    [train.stops[index - 1], train.stops[index]] = [
      train.stops[index],
      train.stops[index - 1],
    ];
  if (action === "down" && index < train.stops.length - 1)
    [train.stops[index + 1], train.stops[index]] = [
      train.stops[index],
      train.stops[index + 1],
    ];
  persistAndRender();
}

// =========================================================================
//  §25.  Route rebuild & layer / marker rendering (SVG + deck record assembly)
// =========================================================================

function rebuildSelectedRoute() {
  const train = getTrain();
  if (!train) return;
  const stops = train.stops || [];

  train.route_sections = getRideRouteSectionsForTrain(train);

  persistAndRender();
  setStatus(
    els.fieldStatus,
    `Route sections rebuilt. ${train.route_sections.length} segment(s) calculated. Non-true stops/segments are rendered in pale color.`,
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
  if (dateScoped && getTrainDate(train) !== selectedDate) return;

  // GL mode: incremental feedback = drop the route-item cache and re-issue
  // the layers for the trains loaded so far. Rebuilding the overlap map is
  // O(all segments), so per-train renders make a big import O(N²) — batch
  // appends landing within one short window into a single render. The
  // authoritative renderAll() at the end of the load still applies the final
  // styling.
  cachedRouteItems = null;
  cachedRouteSignature = "";
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
  return getTrainDate(train) === selectedDate ? 1 : 0;
}

// (trainScopeFlags was removed: route/marker RECORDS use the selection-free
// routeRecordScopeFlags in §26, and focus emphasis is drawn by railmap's SEL
// layers + focus-boost paint expressions.)

function renderTrainLayers() {
  // A concrete selected date now always scopes the map: that date's trains
  // stay solid and other dates draw half-transparent (dimmed) — they are NOT
  // removed. The optional "地圖僅顯示當前日期" checkbox is a stricter override
  // that hides other dates entirely instead of dimming them. Selecting a
  // single train hides other dates entirely too (routes AND station dots):
  // the selected train stays solid, its same-day siblings fade via railmap's
  // selection-dim paint pass, and nothing from any other day draws at all.
  const dateActive = selectedDate !== ALL_DATES;
  const hardHide =
    dateActive && (mapFollowsSelectedDate || Boolean(selectedTrainId));
  const visibleTrains = trainStore.trains.filter(
    (train) =>
      train.visible !== false &&
      (!hardHide || getTrainDate(train) === selectedDate),
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
    cachedRouteItems = buildRouteItems(orderedTrains);
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
let _cachedMarkerRecords = null;
let _cachedMarkerSig = null;
function renderTrainMarkers() {
  updateEndpointLabels();
  if (window.RailMap && map) {
    if (!_cachedMarkerRecords || _cachedMarkerSig !== cachedRouteSignature) {
      _cachedMarkerRecords = buildDeckMarkerRecords(cachedOrderedTrains);
      _cachedMarkerSig = cachedRouteSignature;
      RailMap.setMarkers(_cachedMarkerRecords);
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
      const base = `${train.id}:${getTrainRouteTemplateKey(train)}:${(train.stops || []).map((s) => (s.ride_segment ? 1 : 0)).join("")}`;
      const vis = train.visible === false ? 0 : 1;
      overlapPart.push(`${base}:${vis}`);
      const s = train.style || {};
      return `${base}:${s.color || ""}:${s.weight || ""}:${s.unridden_opacity ?? ""}:${vis}`;
    })
    .join("|");
  // `hide` mirrors renderTrainLayers' hardHide: whether other dates are
  // removed entirely (checkbox on, or a single train selected). It is a
  // boolean — WHICH train is selected stays out of the signature, so picking
  // train A then train B within the same day rebuilds nothing.
  const hide =
    dateActive && (mapFollowsSelectedDate || Boolean(selectedTrainId)) ? 1 : 0;
  const scope = `date:${dateActive ? selectedDate : ""}|hide:${hide}`;
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
let _lastPushedSpacingDeg = 0;
function renderRoutesInView() {
  if (!map || !cachedRouteItems || !window.RailMap) return;
  // One GeoJSON source for the whole train set; MapLibre re-tiles it on the
  // worker, so pan/zoom stay GPU-cheap regardless of point count. The
  // full-line expand records + per-group rigid shift vectors feed the
  // dedicated hover-expand source, so a fanned parallel line is the member
  // train's complete course translated intact — never broken mid-route.
  const built = buildDeckRouteRecords(cachedRouteItems);
  // Three cases, cheapest first:
  //   • same record object AND same spacing (a pure selection/marker change) —
  //     push nothing; RailMap.setSelected below does the whole job.
  //   • same record object, spacing drifted (a zoom) — only the invisible pick
  //     lanes moved; re-upload just the pick source, not the identical base
  //     route source.
  //   • new record object (geometry/style/visibility/date changed) — full push.
  if (built !== _lastPushedBuilt) {
    RailMap.setData(
      built.records,
      built.expandRecords,
      built.groupInfo,
      built.spacingDeg,
    );
    _lastPushedBuilt = built;
    _lastPushedSpacingDeg = built.spacingDeg;
  } else if (built.spacingDeg !== _lastPushedSpacingDeg) {
    RailMap.updateLaneSpacing(built.spacingDeg);
    _lastPushedSpacingDeg = built.spacingDeg;
  }
  // The selected train re-draws in the dedicated selection layers (dark ink
  // casing + full-color line) above all other routes.
  RailMap.setSelected(focusedTrainId || null);
}

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
let _cachedOverlap = null;
let _cachedOverlapSig = null;
let _cachedDeckRecords = null;
let _cachedDeckRecordsSig = null;
let _lastOverlapSpacingDeg = 0;

function invalidateDeckRouteCaches() {
  _cachedOverlap = null;
  _cachedOverlapSig = null;
  _cachedDeckRecords = null;
  _cachedDeckRecordsSig = null;
  _lastPushedBuilt = null;
  // Marker records bake DISPLAY radii/strokes, so they drop with the rest.
  _cachedMarkerRecords = null;
  _cachedMarkerSig = null;
}

// Selection-free style scope for ROUTE RECORDS: the record cache must not
// depend on which train is picked (focus emphasis is drawn by railmap's SEL
// layers + the focus-boost width expression), so `focused` is always false
// here and `dimmed` derives from the date scope alone.
function routeRecordScopeFlags(train) {
  return {
    focused: false,
    dimmed: cachedRouteDateActive && getTrainDate(train) !== selectedDate,
  };
}

// Lane spacing: generous enough that sliding the mouse between parallel lanes
// takes a comfortable movement (~12px per lane), independent of how thin the
// drawn lines are — but never narrower than the widest possible line (custom
// per-train weights + focus boost). The focus boost is budgeted for EVERY
// train so the spacing — and with it the whole record cache — never depends
// on which train is currently selected.
function currentOverlapSpacingPx(items) {
  const scale = DISPLAY.routeWidthScale || 1;
  let maxW = DEFAULT_TRAIN_WEIGHT * scale;
  const seen = new Set();
  (items || cachedRouteItems || []).forEach((it) => {
    const t = it.train;
    if (!t || seen.has(t.id)) return;
    seen.add(t.id);
    const w = Number(t.style?.weight || DEFAULT_TRAIN_WEIGHT) * scale;
    if (w > maxW) maxW = w;
  });
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
  if (!_cachedOverlap || !sig || _cachedOverlapSig !== sig) {
    _cachedOverlap = buildDeckOverlapMap(items);
    _cachedOverlapSig = sig;
  }
  return _cachedOverlap;
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

// Index every ORIGINAL route segment by the direction-independent key the
// route dedupe uses, so shared N02 track (identical source coordinates) is
// detected exactly — INDEPENDENT of how each feature's geometry was
// simplified for display (per-feature simplification keeps different vertex
// subsets, which used to fragment corridors into confetti). Slot order is by
// DATE (earliest first, then departure time, then id) so parallel pick lanes
// read left→right / top→bottom in chronological order, and a train keeps the
// same lane along the whole shared stretch.
function buildDeckOverlapMap(items) {
  const uniqueTrains = [];
  const seenIds = new Set();
  items.forEach((it) => {
    if (it.train && !seenIds.has(it.train.id)) {
      seenIds.add(it.train.id);
      uniqueTrains.push(it.train);
    }
  });
  uniqueTrains.sort(compareTrainsByDateAndDeparture);
  const rank = new Map(uniqueTrains.map((t, i) => [t.id, i]));
  // Count ONLY segments that will actually produce a drawn record — the same
  // predicate buildDeckRouteRecords uses to drop records (unridden sections
  // are hidden entirely; dimmed trains vanish when dimOpacity is 0). Anything
  // invisible must not occupy a lane slot or inflate the ×N count, or the fan
  // and the pick corridor get phantom gaps.
  const itemDrawn = (item) => {
    const train = item.train;
    if (!train) return false;
    const flags = routeRecordScopeFlags(train);
    // Off-date (dimmed) trains never occupy a parallel lane: while a concrete
    // day is active, its routes must not shift sideways because of overlaps
    // with OTHER days' routes, and the dim lines are not hoverable anyway.
    if (flags.dimmed) return false;
    const ridden =
      item.feature.properties && item.feature.properties.ride_segment === true;
    const { opacity } = routeSegmentStyleValues(train, ridden, flags);
    return opacity > 0;
  };
  const seg = new Map();
  items.forEach((item) => {
    const tid = item.train && item.train.id;
    if (!tid || !itemDrawn(item)) return;
    getRouteLinePairs(item.feature).forEach(({ segKeys }) => {
      for (let i = 0; i < segKeys.length; i += 1) {
        let ids = seg.get(segKeys[i]);
        if (!ids) {
          ids = new Set();
          seg.set(segKeys[i], ids);
        }
        ids.add(tid);
      }
    });
  });
  // Intern the sharing sets: ONE canonical Set instance per distinct train
  // membership, so the record builder can detect run boundaries by simple
  // identity comparison — a corridor stays a single run however many
  // original segments long it is.
  const canonicalIds = new Map(); // sorted-ids signature -> Set
  seg.forEach((ids, key) => {
    const idsSig = [...ids].sort().join("\u0000");
    const canon = canonicalIds.get(idsSig);
    if (!canon) canonicalIds.set(idsSig, ids);
    else if (canon !== ids) seg.set(key, canon);
  });

  // --- canonical corridor direction ----------------------------------------
  // Every train offsets its lane relative to the SAME reference direction, or
  // lanes would swap sides wherever trains traverse shared track opposite
  // ways or the bearing crosses an axis. Overlapped segments (≥2 trains) form
  // chains; walk each connected chain once, orienting every segment away from
  // the walk start so the direction is CONTINUOUS through every bend and
  // station. Then flip the whole chain, if needed, so its net direction is
  // east-dominant (or north-dominant for N-S chains): with lane normals taken
  // right of this direction, slot 0 (earliest date) is the left/top lane.
  const adjacency = new Map(); // coordKey -> [segKey...]
  seg.forEach((ids, key) => {
    if (ids.size < 2) return;
    key.split("|").forEach((nodeKey) => {
      let list = adjacency.get(nodeKey);
      if (!list) {
        list = [];
        adjacency.set(nodeKey, list);
      }
      list.push(key);
    });
  });
  const segFrom = new Map(); // segKey -> canonical FROM coordKey
  const nodeXY = (nodeKey) => nodeKey.split(",").map(Number);
  const otherEnd = (segKey, nodeKey) => {
    const [a, b] = segKey.split("|");
    return a === nodeKey ? b : a;
  };
  const visited = new Set();
  adjacency.forEach((_, startNode) => {
    if (visited.has(startNode)) return;
    // Collect the connected component, preferring a degree-1 end as the walk
    // start so a simple chain gets one continuous direction end-to-end.
    const compNodes = [];
    const stack = [startNode];
    visited.add(startNode);
    while (stack.length) {
      const n = stack.pop();
      compNodes.push(n);
      (adjacency.get(n) || []).forEach((sk) => {
        const o = otherEnd(sk, n);
        if (!visited.has(o)) {
          visited.add(o);
          stack.push(o);
        }
      });
    }
    const start =
      compNodes.find((n) => (adjacency.get(n) || []).length === 1) ||
      compNodes[0];
    // Orient each edge away from the walk.
    const compSegs = [];
    const seenNode = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const n = queue.shift();
      (adjacency.get(n) || []).forEach((sk) => {
        if (segFrom.has(sk)) return;
        segFrom.set(sk, n);
        compSegs.push(sk);
        const o = otherEnd(sk, n);
        if (!seenNode.has(o)) {
          seenNode.add(o);
          queue.push(o);
        }
      });
    }
    // Net direction of the chain; flip everything if it points west/south.
    let dxSum = 0;
    let dySum = 0;
    compSegs.forEach((sk) => {
      const from = segFrom.get(sk);
      const to = otherEnd(sk, from);
      const [fx, fy] = nodeXY(from);
      const [tx, ty] = nodeXY(to);
      dxSum += (tx - fx) * Math.cos((((fy + ty) / 2) * Math.PI) / 180);
      dySum += ty - fy;
    });
    const flip =
      Math.abs(dxSum) >= Math.abs(dySum) ? dxSum < 0 : dySum < 0;
    if (flip)
      compSegs.forEach((sk) => segFrom.set(sk, otherEnd(sk, segFrom.get(sk))));
  });

  const orderedCache = new WeakMap(); // ids Set -> date-ordered id array
  return {
    // The sharing-train set of one ORIGINAL segment — the same Set instance
    // for every train on the segment, so run boundaries computed from its
    // identity coincide EXACTLY across all sharing trains. null = unshared.
    idsForKey(key) {
      const ids = seg.get(key);
      return ids && ids.size >= 2 ? ids : null;
    },
    // Date-ordered lane slot of `tid` inside a sharing set from idsForKey.
    slotFor(ids, tid) {
      if (!ids) return 0;
      let ordered = orderedCache.get(ids);
      if (!ordered) {
        ordered = [...ids].sort(
          (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
        );
        orderedCache.set(ids, ordered);
      }
      return Math.max(0, ordered.indexOf(tid));
    },
    // +1 when traversing the original segment `key` starting from the vertex
    // whose coordKey is `fromKey` runs WITH the corridor's canonical direction.
    dirForKey(key, fromKey) {
      const from = segFrom.get(key);
      if (from == null) return 1;
      return from === fromKey ? 1 : -1;
    },
  };
}

// Merge the simplified vertex subset with the exact run-boundary vertices
// (both ascending original indices), so lane transitions bend precisely where
// the overlap membership changes — never displaced by the simplification.
function mergeDrawnIndices(keepIdx, runs, nSeg) {
  if (!keepIdx) {
    const all = new Array(nSeg + 1);
    for (let i = 0; i <= nSeg; i += 1) all[i] = i;
    return all;
  }
  const boundarySet = new Set();
  runs.forEach((r) => {
    boundarySet.add(r.a);
    boundarySet.add(r.b);
  });
  const extras = [...boundarySet].sort((x, y) => x - y);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < keepIdx.length || j < extras.length) {
    const ki = i < keepIdx.length ? keepIdx[i] : Infinity;
    const ej = j < extras.length ? extras[j] : Infinity;
    if (ki <= ej) {
      out.push(ki);
      i += 1;
      if (ki === ej) j += 1;
    } else {
      out.push(ej);
      j += 1;
    }
  }
  return out;
}

// Flatten cached route items into MapLibre route records. Returns
// { records, expandRecords, groupInfo, spacingDeg }:
//
//   records       — base + pick runs. One polyline per maximal stretch of
//                   constant overlap MEMBERSHIP (same sharing-train set), so
//                   run boundaries coincide exactly across all sharing
//                   trains. The visible line stays on its TRUE track; the
//                   invisible pickPath is the run rigidly translated into
//                   the train's date-ordered lane.
//   expandRecords — one polyline per (train, line): the train's complete
//                   course on its true track. When a group is hovered,
//                   railmap.js translates every member train's complete
//                   course RIGIDLY by that group's shift vector — corners,
//                   radii and lengths unchanged, the whole line moved intact,
//                   never chopped into little pieces mid-route.
//   groupInfo     — Map(groupKey → { sx, sy, mults: {tid: laneMultiplier} }):
//                   the group's unit shift vector (degree space) and every
//                   member's slot-centered lane multiplier.
//   spacingDeg    — the current lane spacing (degrees) matching pickPath.
//
// Overlap detection and run boundaries use the ORIGINAL geometry (exact
// shared N02 coordinates); drawn paths use the Douglas-Peucker subset plus
// the exact boundary vertices.
function buildDeckRouteRecords(items) {
  const sig = cachedRouteSignature;
  const spacingPx = currentOverlapSpacingPx(items);
  const spacingDeg = overlapOffsetDeg(spacingPx);
  // Fast path (zoom/pan): geometry, styles, runs, shift vectors and lane
  // multipliers are unchanged — only re-express the pixel lane spacing in
  // degrees and re-translate the pick lanes.
  if (_cachedDeckRecords && sig && _cachedDeckRecordsSig === sig) {
    if (spacingDeg !== _lastOverlapSpacingDeg) {
      _cachedDeckRecords.records.forEach((r) => {
        if (r.overlapCount > 1) {
          r.pickPath = applyLaneShift(
            r.path,
            r.shiftX,
            r.shiftY,
            r.laneMult * spacingDeg,
          );
          r.pickWidth = Math.max(spacingPx, 6);
        }
      });
      _lastOverlapSpacingDeg = spacingDeg;
      _cachedDeckRecords.spacingDeg = spacingDeg;
    }
    return _cachedDeckRecords;
  }
  const overlap = getDeckOverlapMapCached(items);
  _deckHasOverlaps = false;
  const records = [];
  const expandRecords = [];
  const groupInfo = new Map();
  items.forEach((item) => {
    const train = item.train;
    const feature = item.feature;
    const tid = train && train.id;
    const ridden =
      feature.properties && feature.properties.ride_segment === true;
    const rgb = hexToRgb(
      train.style && train.style.color
        ? train.style.color
        : DEFAULT_TRAIN_COLOR,
    );
    const scopeFlags = routeRecordScopeFlags(train);
    const { opacity, width } = routeSegmentStyleValues(
      train,
      ridden,
      scopeFlags,
    );
    if (opacity <= 0) return; // hidden trains contribute nothing to the GPU buffer
    // Off-date trains still DRAW (dimmed) while a day is active, but they are
    // not interactive: no hover, no tooltip, no click-select, no fan lanes.
    const noPick = scopeFlags.dimmed === true;
    const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
    const color = [rgb[0], rgb[1], rgb[2], alpha];
    getRouteLinePairs(feature).forEach(({ orig, keepIdx, segKeys }) => {
      if (!orig || orig.length < 2) return;
      const nSeg = orig.length - 1;
      // Per ORIGINAL segment: sharing-train set, this train's lane slot and
      // the signed lane multiplier (slots centered around the true track).
      const segIds = new Array(nSeg);
      const segSlot = new Array(nSeg);
      const segMult = new Array(nSeg);
      let lineHasOverlap = false;
      for (let i = 0; i < nSeg; i += 1) {
        // Off-date trains are excluded from the overlap map entirely: even
        // where their track coincides with a same-day shared corridor they
        // stay on the true track (no lane slot, no fan membership).
        const ids = noPick ? null : overlap.idsForKey(segKeys[i]);
        segIds[i] = ids;
        if (ids) {
          lineHasOverlap = true;
          segSlot[i] = overlap.slotFor(ids, tid);
          segMult[i] = segSlot[i] - (ids.size - 1) / 2;
        } else {
          segSlot[i] = 0;
          segMult[i] = 0;
        }
      }
      if (lineHasOverlap) _deckHasOverlaps = true;
      // Maximal runs of constant overlap membership (Set identity — the same
      // instance for every sharing train, so run boundaries coincide exactly
      // across all of them and so do the derived groupKeys).
      const runs = [];
      let a = 0;
      for (let i = 1; i < nSeg; i += 1) {
        if (segIds[i] !== segIds[a]) {
          runs.push({ a, b: i });
          a = i;
        }
      }
      runs.push({ a, b: nSeg }); // each run spans original vertices [a .. b]
      // Drawn vertices: the simplified subset + the exact run boundaries.
      const drawnIdx = mergeDrawnIndices(keepIdx, runs, nSeg);
      const drawn = new Array(drawnIdx.length);
      const posOf = new Map(); // original index -> position in drawn
      for (let k = 0; k < drawnIdx.length; k += 1) {
        drawn[k] = orig[drawnIdx[k]];
        posOf.set(drawnIdx[k], k);
      }

      // ── base + pick records, one per run ──
      // The visible line stays on its TRUE track at full width (no permanent
      // fan-out). The invisible PICK target is translated into per-train
      // lanes; hovering an overlapped run temporarily shows every member
      // train's COMPLETE course rigidly translated into those lanes
      // (railmap.js + the expand record below). groupKey identifies the
      // shared run: its smallest ORIGINAL segment key is identical for every
      // train sharing it, whichever way each train traverses the track and
      // however each geometry was simplified.
      runs.forEach(({ a: ra, b: rb }) => {
        const ka = posOf.get(ra);
        const kb = posOf.get(rb);
        const runLine = drawn.slice(ka, kb + 1);
        if (runLine.length < 2) return;
        const ids = segIds[ra];
        const n = ids ? ids.size : 1;
        const mult = segMult[ra];
        let groupKey = "";
        if (n > 1) {
          groupKey = segKeys[ra];
          for (let i = ra + 1; i < rb; i += 1)
            if (segKeys[i] < groupKey) groupKey = segKeys[i];
        }
        // One shift vector + lane multipliers per GROUP, computed from the
        // run's canonical (train-independent) orientation so every sharing
        // train derives the identical fan. Right-hand perpendicular to the
        // dominant direction; sx pre-divided by cos(latRef) so the shift
        // spans the same PIXEL distance regardless of heading.
        let gi = null;
        if (n > 1) {
          gi = groupInfo.get(groupKey);
          if (!gi) {
            let dxSum = 0;
            let dySum = 0;
            let latSum = 0;
            for (let i = ra; i < rb; i += 1) {
              const d = overlap.dirForKey(segKeys[i], coordKey(orig[i]));
              const latMid = (orig[i][1] + orig[i + 1][1]) / 2;
              const coslat = Math.cos((latMid * Math.PI) / 180) || 1e-6;
              dxSum += (orig[i + 1][0] - orig[i][0]) * coslat * d;
              dySum += (orig[i + 1][1] - orig[i][1]) * d;
              latSum += latMid;
            }
            const len = Math.hypot(dxSum, dySum) || 1;
            const latRef = latSum / (rb - ra);
            const coslatRef = Math.cos((latRef * Math.PI) / 180) || 1e-6;
            const mults = {};
            ids.forEach((id) => {
              mults[id] = overlap.slotFor(ids, id) - (ids.size - 1) / 2;
            });
            gi = {
              sx: dySum / len / coslatRef, // right-hand perpendicular
              sy: -dxSum / len,
              mults,
            };
            groupInfo.set(groupKey, gi);
          }
        }
        records.push({
          path: runLine,
          pickPath: gi
            ? applyLaneShift(runLine, gi.sx, gi.sy, mult * spacingDeg)
            : runLine,
          shiftX: gi ? gi.sx : 0,
          shiftY: gi ? gi.sy : 0,
          laneMult: mult,
          color,
          width,
          train,
          feature,
          pickWidth: n > 1 ? Math.max(spacingPx, 6) : Math.max(width + 8, 14),
          overlapCount: n,
          overlapSlot: segSlot[ra],
          groupKey,
          nopick: noPick,
        });
      });

      // ── one expand record for the whole line (true-track geometry) ──
      // Every line of every train gets one, so a hovered group can translate
      // each member train's COMPLETE course intact — including sections that
      // overlap nothing.
      expandRecords.push({ path: drawn, color, width, train });
    });
  });
  _cachedDeckRecords = { records, expandRecords, groupInfo, spacingDeg };
  _cachedDeckRecordsSig = sig;
  _lastOverlapSpacingDeg = spacingDeg;
  return _cachedDeckRecords;
}


// Flatten the visible trains' stop + pass-through markers into deck.gl
// ScatterplotLayer records. Fill/line colours, radius and stroke width are
// precomputed to match renderStopMarker() / renderPassThroughMarker()
// exactly (radius + width are in screen pixels). category lets the layers
// control toggle "Stops" / "Pass-through Stations" independently.
function deckMarkerRecord(feature, train, opts, kind) {
  const p = feature.properties || {};
  const coord = getFeatureDisplayCoordinate(feature);
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const focused = opts.focused === true;
  const dimmed = opts.dimmed === true;
  let s;
  let category;
  if (kind === "pass") {
    s = passThroughMarkerStyleValues(p.ride_segment !== false, {
      focused,
      dimmed,
    });
    category = "pass";
  } else {
    // BLACK dot only at the actually-ridden boundary (boarding/alighting);
    // scheduled origin/destination that weren't the real endpoints stay white.
    s = stopMarkerStyleValues(p.ride_segment === true, p.ride_boundary === true, {
      focused,
      dimmed,
    });
    category = "stop";
  }
  // Alpha is carried as its own value (not premultiplied into the colours):
  // the base marker layers draw it via circle-opacity while the SEL layers
  // override it to 1, so a selected off-date train's dots un-dim without any
  // record rebuild. fillOpacity === lineOpacity in every style helper.
  return {
    position: [coord[0], coord[1]],
    radius: s.radius,
    lineWidth: s.lineWidth,
    fillColor: [s.fill[0], s.fill[1], s.fill[2]],
    lineColor: [s.strokeCol[0], s.strokeCol[1], s.strokeCol[2]],
    alpha: s.fillOpacity,
    category,
    feature,
    train,
    // Off-date dots draw dimmed but are not hover/click targets.
    nopick: dimmed === true,
  };
}

// Computed pass-through stations only depend on a train's route_sections +
// ride flags (never on focus / selection / zoom), but resolving every passed
// station for all 67 trains is costly. Memoize so a focus-only change (a
// route/marker click) doesn't recompute them — this is the main fix for the
// on-click latency now that markers rebuild on the GPU on every selection.
const _computedPassThroughCache = new Map();
// Every stop/section edit mints a new key, so cap the cache (simple FIFO
// eviction) to keep long editing sessions from growing it without bound.
const _COMPUTED_PASS_CACHE_MAX = 300;
function getComputedPassThroughFeaturesCached(train) {
  const key = `${train.id}|${getTrainRouteTemplateKey(train)}|${(train.stops || []).map((s) => (s.ride_segment ? 1 : 0)).join("")}`;
  let v = _computedPassThroughCache.get(key);
  if (!v) {
    v = getComputedPassThroughFeatures(train);
    if (_computedPassThroughCache.size >= _COMPUTED_PASS_CACHE_MAX) {
      const oldest = _computedPassThroughCache.keys().next().value;
      _computedPassThroughCache.delete(oldest);
    }
    _computedPassThroughCache.set(key, v);
  }
  return v;
}

// Every ridden station draws a dot, but ONLY the first and last effectively-
// ridden stop of each train (the actual boarding / alighting stations) get
// the BLACK ink dot — every other stop and pass-through station renders as a
// WHITE dot with an ink ring.
// SELECTION-INDEPENDENT: pass-through dots are always emitted (the layer
// minzoom gates them) and focus flags are never baked, so the record set only
// changes with the route signature / display settings.
function buildDeckMarkerRecords(orderedTrains) {
  const records = [];
  const endpoints = computeScopedEndpoints(orderedTrains);
  (orderedTrains || []).forEach((train) => {
    if (train.visible === false) return;
    const opts = routeRecordScopeFlags(train);
    const stops = train.stops || [];
    // First + last effectively-ridden stopping station = the black-dot pair.
    const ridden = [];
    stops.forEach((stop, idx) => {
      if (stop.stop_type === "pass_through") return;
      if (!effectiveStopRide(stops, idx)) return;
      ridden.push(idx);
    });
    const boundarySet = new Set(
      ridden.length ? [ridden[0], ridden[ridden.length - 1]] : [],
    );
    stops.forEach((stop, idx) => {
      const stopFeature = getStopFeature(stop, train);
      if (!stopFeature) return;
      if (!passesOnlyEndpoints(endpoints, train, stopFeature)) return;
      const isPass = stopFeature.properties.stop_type === "pass_through";
      // Hidden (not effectively ridden) markers are dropped entirely.
      const eff = effectiveStopRide(stops, idx);
      if (!eff) return;
      stopFeature.properties.ride_segment = eff;
      stopFeature.properties.ride_boundary = boundarySet.has(idx);
      const rec = deckMarkerRecord(
        stopFeature,
        train,
        opts,
        isPass ? "pass" : "stop",
      );
      if (rec) records.push(rec);
    });
    if (!DISPLAY.onlyEndpoints) {
      getComputedPassThroughFeaturesCached(train).forEach((feature) => {
        if (feature.properties && feature.properties.ride_segment === false)
          return;
        const rec = deckMarkerRecord(feature, train, opts, "pass");
        if (rec) records.push(rec);
      });
    }
  });
  return records;
}

// Marker click -> select train + open the stop popup at the marker. Same
// off-date guard + stage-1/stage-2 popup gating as handleDeckRouteClick.
function handleDeckMarkerClick(info) {
  const hit = interactiveTrainFromClick(info);
  if (!hit) return;
  pickTrain(hit.train.id);
  if (hit.selectsNow && info.coordinate && map) {
    openClickPopup(info.coordinate, buildStopPopup(hit.feature, hit.train));
  }
}

function routeCoordinateSegmentKey(a, b) {
  return [coordKey(a), coordKey(b)].sort().join("|");
}

function getComputedPassThroughFeatures(train) {
  const explicitKeys = new Set();
  (train.stops || []).forEach((stop) =>
    stationLookupKeys(stopName(stop), stopStationCode(stop)).forEach((key) =>
      explicitKeys.add(key),
    ),
  );
  const computed = [];
  const seen = new Set(explicitKeys);
  getRideRouteSectionsForTrain(train).forEach((section) => {
    [
      { name: section.from, n02_station_code: section.from_n02_station_code },
      { name: section.to, n02_station_code: section.to_n02_station_code },
    ].forEach((candidate) => {
      const station = resolveStationForTrain(candidate, train);
      if (!station) return;
      const keys = stationLookupKeys(
        stationName(station),
        stationCode(station),
      );
      if (keys.some((key) => seen.has(key))) return;
      keys.forEach((key) => seen.add(key));
      computed.push({
        type: "Feature",
        properties: {
          name: stationName(station),
          n02_station_code: stationCode(station),
          n02_group_code: stationGroupCode(station),
          stop_type: "pass_through",
          pass_through_computed: true,
          train_id: train.id,
          train_type: train.train_type || "",
          company: train.company || "",
          number: train.number,
          line_name: stationLineName(station),
          operator: stationOperator(station),
          source: "computed from route_sections",
        },
        geometry: {
          type: "Point",
          coordinates: getFeatureDisplayCoordinate(station),
        },
      });
    });
  });
  return computed;
}

// =========================================================================
//  §27.  Route matching, template keys, feature generation & full graph construction
// =========================================================================

function getTrainRouteTemplateKey(train) {
  return (train.route_sections || [])
    .map((section) => {
      const from = section.from_n02_station_code || section.from || "";
      const to = section.to_n02_station_code || section.to || "";
      const lines = (section.line_names || [])
        .map(String)
        .filter(Boolean)
        .sort()
        .join(",");
      const operators = (section.operator_names || section.operator_hints || [])
        .map(String)
        .filter(Boolean)
        .sort()
        .join(",");

      // line_names/operator_names change the route solver constraints, so they
      // must be part of the cache/template key.  Without this, editing only
      // line_names could incorrectly reuse an earlier path for the same endpoints.
      return `${from}->${to}|lines:${lines}|operators:${operators}`;
    })
    .join("|");
}

let runtimeRouteGraph = null;
const runtimeRouteCache = new Map();
// Negative cache: cacheKeys whose solve produced ZERO usable geometry (all
// sections failed — bad/mismatched station codes, or no path under the policy).
// A failure is deterministic for a given (rail data + sections + policy), all of
// which are encoded in cacheKey, so re-solving can only fail again. Without this
// the ~25 unsolvable trains rebuilt regional graphs and ran Dijkstra on every
// prewarm, final render and live refresh — a big chunk of the ~53 s hot reload.
// Editing a train changes its cacheKey, so a fix is re-solved automatically.
const runtimeRouteNegativeCache = new Set();
const ROUTE_NEG_CACHE_MARKER = "__neg__::";
const STATION_SNAP_MAX_DISTANCE_METERS = 500;
const STATION_SNAP_COST_FACTOR = 4;
// N02_002 institution type codes are treated as preferences by default, not
// as a hard whitelist. Some JR service geometry shares or crosses private
// railway sections around airports/through-service corridors; hard-filtering
// them can create visible gaps. Set route_policy.institution_filter_mode =
// "hard" only when a strict institution whitelist is intentionally required.
const NON_PREFERRED_INSTITUTION_LENGTH_FACTOR = 180;
const NON_PREFERRED_INSTITUTION_EDGE_PENALTY = 5000;
const NON_PREFERRED_STATION_SNAP_PENALTY = 20000;
// Soft preferred-line/operator bias for route Dijkstra. These are deliberately
// BOUNDED, length-proportional multipliers (a non-preferred metre costs a few
// preferred metres) — NOT the old route-dominating 140x/100x plus a flat
// per-edge constant. The flat per-edge penalty scaled with the *number* of
// N02 micro-segments, so a short branch line (e.g. 内子線, ~93 vertices over
// 5 km) accumulated ~400k of penalty and a finely-segmented same-line detour
// looked cheaper than the real path. Keeping the bias proportional to distance
// makes it resolution-independent and stops a same-line detour from beating a
// shorter mixed-line path.
const NON_PREFERRED_OPERATOR_LENGTH_FACTOR = 6;
const NON_PREFERRED_LINE_LENGTH_FACTOR = 8;
const NON_PREFERRED_OPERATOR_STATION_SNAP_PENALTY = 12000;
const NON_PREFERRED_LINE_STATION_SNAP_PENALTY = 15000;
const STATION_TRANSFER_NODE_RADIUS_DEG = 0.0035;
const STATION_TRANSFER_MAX_SNAP_METERS = 520;
const STATION_TRANSFER_MAX_NODE_GAP_METERS = 900;
const STATION_TRANSFER_EDGE_PENALTY = 180;
const STATION_TRANSFER_MAX_NODES_PER_GROUP = 24;

function generateMatchedRouteFeaturesForTrain(train) {
  const routeSections = getRideRouteSectionsForTrain(train);
  if (!routeSections.length) return [];

  const templateKey = getTrainRouteTemplateKey({
    ...train,
    route_sections: routeSections,
  });
  const allowedCodes = getAllowedInstitutionTypeCodes(train);
  const policyKey = [
    ...(train.route_policy?.preferred_line_names || []).map(
      (value) => `line:${value}`,
    ),
    ...(train.route_policy?.preferred_operator_names || []).map(
      (value) => `operator:${value}`,
    ),
    ...derivedPreferredOperatorNames(train).map(
      (value) => `operator:${value}`,
    ),
    `institution_filter:${train.route_policy?.institution_filter_mode || "soft"}`,
  ]
    .sort()
    .join("|");
  const cacheKey = `${allowedCodes.join(",")}|${policyKey}|${templateKey}`;
  if (runtimeRouteCache.has(cacheKey)) {
    const cached = runtimeRouteCache.get(cacheKey);
    return dedupeSameTrainRouteFeatures(
      cloneRouteFeaturesForTrain(cached, train),
    );
  }

  // Fix #1: reuse geometry persisted in the train's JSON. If the train carries
  // a cached route whose key still matches its current sections/policy, seed
  // the in-memory cache from it and skip the expensive Dijkstra solve. Any
  // change to stops/sections/policy changes cacheKey, so a stale cache is
  // simply ignored and re-solved below.
  const persisted = train.route_geometry_cache;
  if (
    persisted &&
    persisted.key === cacheKey &&
    Array.isArray(persisted.features) &&
    persisted.features.length
  ) {
    runtimeRouteCache.set(cacheKey, persisted.features);
    // Also seed the cross-session IndexedDB cache so other trains / future
    // sessions with the same sections benefit even without an embedded cache.
    persistRouteCacheEntry(cacheKey, persisted.features);
    return dedupeSameTrainRouteFeatures(
      cloneRouteFeaturesForTrain(persisted.features, train),
    );
  }

  // Known-unsolvable with this exact data + policy: skip the regional-graph
  // build + Dijkstra entirely and return empty, exactly as a fresh solve would.
  if (runtimeRouteNegativeCache.has(cacheKey)) {
    return [];
  }

  setStatus(
    els.fieldStatus,
    `Generating N02 railway route for ${train.number || train.id}...`,
    "warn",
  );
  const generated = [];
  const warnings = [];

  routeSections.forEach((section, segmentIndex) => {
    // Solve on a small on-demand regional subgraph instead of the resident
    // all-Japan graph; falls back to the full graph only if a region proves
    // too small (see solveRouteSectionOnDemand), so results are unchanged.
    const result = solveRouteSectionOnDemand(
      section,
      segmentIndex,
      train,
      allowedCodes,
    );
    if (!result) {
      warnings.push(
        `${section.from || section.from_n02_station_code}→${section.to || section.to_n02_station_code}`,
      );
      return;
    }
    generated.push(result);
  });

  if (!generated.length) {
    console.warn(
      `Unable to generate N02 railway route for train ${train.id}.`,
      warnings,
    );
    setStatus(
      els.fieldStatus,
      `Unable to generate N02 railway route for ${train.number || train.id}. ${warnings.length} segment(s) failed.`,
      "warn",
    );
    // Remember the failure so re-renders / prewarms / live refreshes in this
    // session (and future sessions, via IndexedDB) don't re-run the same doomed
    // graph build + Dijkstra. Cleared implicitly when the train's data changes
    // (its cacheKey changes).
    runtimeRouteNegativeCache.add(cacheKey);
    persistRouteNegativeEntry(cacheKey);
    return [];
  }

  const templateFeatures = generated.map((feature) => ({
    ...feature,
    properties: {
      ...(feature.properties || {}),
      train_id: "__template__",
      route_id: `${cacheKey}-primary`,
      route_template_key: templateKey,
    },
  }));
  runtimeRouteCache.set(cacheKey, templateFeatures);
  // Persist the freshly solved geometry so later sessions skip both the solve
  // and (if every train hits the cache) the route-graph build entirely.
  persistRouteCacheEntry(cacheKey, templateFeatures);
  // Solved geometry is kept only in runtimeRouteCache (this session) and
  // IndexedDB (cross-session). It is deliberately NOT attached back onto the
  // train object, so train-store.json and the in-memory store stay lean.

  const concrete = dedupeSameTrainRouteFeatures(
    cloneRouteFeaturesForTrain(templateFeatures, train),
  );
  // Replace (not append after) this train's previous features: re-solves for
  // an edited train used to pile up stale entries forever — a slow memory
  // leak that also fed stale geometry to the train_id fallback lookup.
  matchedRoutesGeoJson.features = matchedRoutesGeoJson.features.filter(
    (f) => (f.properties || {}).train_id !== train.id,
  );
  concrete.forEach((feature) => matchedRoutesGeoJson.features.push(feature));

  setStatus(
    els.fieldStatus,
    `Generated ${concrete.length} N02 route segment(s) for ${train.number || train.id}${warnings.length ? `; ${warnings.length} segment(s) skipped.` : "."}`,
    warnings.length ? "warn" : "ok",
  );
  return concrete;
}

function dedupeSameTrainRouteFeatures(features) {
  const seenSegments = new Set();
  const cleaned = [];
  (features || []).forEach((feature) => {
    const uniqueLines = [];
    iterateGeometryLines(feature.geometry).forEach((line) => {
      const uniqueLine = [];
      for (let i = 0; i < line.length - 1; i += 1) {
        const from = line[i];
        const to = line[i + 1];
        if (coordinatesEqual(from, to)) continue;
        const key = routeCoordinateSegmentKey(from, to);
        if (seenSegments.has(key)) continue;
        seenSegments.add(key);
        if (!uniqueLine.length) uniqueLine.push(from);
        else if (!coordinatesEqual(uniqueLine[uniqueLine.length - 1], from)) {
          if (uniqueLine.length >= 2) uniqueLines.push(uniqueLine);
          uniqueLine.length = 0;
          uniqueLine.push(from);
        }
        uniqueLine.push(to);
      }
      if (uniqueLine.length >= 2) uniqueLines.push(uniqueLine);
    });

    if (!uniqueLines.length) return;
    const geometry =
      uniqueLines.length === 1
        ? { type: "LineString", coordinates: uniqueLines[0] }
        : { type: "MultiLineString", coordinates: uniqueLines };
    cleaned.push({
      ...feature,
      properties: {
        ...(feature.properties || {}),
        geometry_role:
          uniqueLines.length > 1
            ? "single_path_with_gaps"
            : feature.properties?.geometry_role,
      },
      geometry,
    });
  });
  return cleaned;
}

function cloneRouteFeaturesForTrain(features, train) {
  return features.map((feature) => ({
    ...feature,
    properties: {
      ...(feature.properties || {}),
      train_id: train.id,
      route_id: `${train.id}-runtime-primary`,
      source:
        feature.properties?.source || "browser_dijkstra_on_embedded_n02_graph",
    },
  }));
}

// -------------------------------------------------------------------------
// 車輛類型 (train_type) / 營運公司 (company) helpers.
// `company` may contain several operators separated by "/" — that marks a
// 直通 (through-running) service. Type + company together SOFT-bias which
// tracks the route solver renders on (institution codes + operator names);
// an explicit route_policy always wins.
// -------------------------------------------------------------------------
const COMPANY_OPERATOR_ALIASES = {
  JR北海道: "北海道旅客鉄道",
  JR東日本: "東日本旅客鉄道",
  JR东日本: "東日本旅客鉄道",
  JR東海: "東海旅客鉄道",
  JR西日本: "西日本旅客鉄道",
  JR四国: "四国旅客鉄道",
  JR四國: "四国旅客鉄道",
  JR九州: "九州旅客鉄道",
  東京メトロ: "東京地下鉄",
  东京地下铁: "東京地下鉄",
  都営地下鉄: "東京都",
  都営: "東京都",
  京急: "京浜急行電鉄",
  京急電鉄: "京浜急行電鉄",
  東急: "東急電鉄",
  小田急: "小田急電鉄",
  京王: "京王電鉄",
  京成: "京成電鉄",
  西武: "西武鉄道",
  東武: "東武鉄道",
  相鉄: "相模鉄道",
  近鉄: "近畿日本鉄道",
  阪急: "阪急電鉄",
  阪神: "阪神電気鉄道",
  名鉄: "名古屋鉄道",
  西鉄: "西日本鉄道",
};

function companyParts(train) {
  return String(train?.company || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isThroughService(train) {
  return companyParts(train).length > 1;
}

// "特急 · JR西日本" / "普通 · 京急電鉄/都営地下鉄（直通）"
function trainCompanyLabel(train) {
  const parts = companyParts(train);
  if (!parts.length) return "";
  const joined = parts.join("/");
  return isThroughService(train)
    ? `${joined}（${I18N.t("tag.through")}）`
    : joined;
}

function trainTypeCompanyLabel(train) {
  return [String(train?.train_type || "").trim(), trainCompanyLabel(train)]
    .filter(Boolean)
    .join(" · ");
}

// Map the human company field to N02_004 operator names for the solver's
// soft operator bias (accepts both marketing names and official names).
function derivedPreferredOperatorNames(train) {
  const names = new Set();
  companyParts(train).forEach((part) => {
    names.add(COMPANY_OPERATOR_ALIASES[part] || part);
  });
  return [...names];
}

// Derive N02_002 institution-type codes from train_type + company. Empty
// result = no signal (caller keeps the full default set).
function derivedInstitutionTypeCodes(train) {
  const type = String(train?.train_type || "");
  const text = `${type} ${companyParts(train).join(" ")}`;
  const codes = new Set();
  if (/新幹線|新干线|shinkansen/i.test(text)) codes.add("1");
  if (/JR|旅客鉄道|旅客铁道/i.test(text) && !/新幹線|新干线/.test(type))
    codes.add("2");
  if (/都営|東京都交通局|市営|公営|市交通局/.test(text)) codes.add("3");
  if (
    /メトロ|地下鉄|地下铁|私鉄|私铁|電鉄|电铁|電気鉄道|京急|京成|東急|小田急|近鉄|阪急|阪神|名鉄|西鉄|西武|東武|モノレール|ゆりかもめ|長野電鉄|富士山麓|富士急/.test(
      text,
    )
  )
    codes.add("4");
  if (
    /第三セクター|三セク|三陸鉄道|しなの鉄道|あいの風|IGR|青い森|肥薩おれんじ|道南いさりび|IRいしかわ|松浦鉄道|横浜高速鉄道/.test(
      text,
    )
  )
    codes.add("5");
  return [...codes].sort();
}

function getAllowedInstitutionTypeCodes(train) {
  const explicit = train.route_policy?.allowed_institution_type_codes;
  const codes =
    Array.isArray(explicit) && explicit.length
      ? explicit.map(String)
      : [...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES];
  const unique = [...new Set(codes)].sort();
  // When route_policy does NOT narrow the codes itself (still the full
  // default set), derive a soft narrowing from 車輛類型/公司. With the
  // default institution_filter_mode "soft" this only biases the solver —
  // it never creates gaps.
  const fullDefault = [...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES].sort();
  if (unique.join(",") === fullDefault.join(",")) {
    const derived = derivedInstitutionTypeCodes(train);
    if (derived.length) return derived;
  }
  return unique;
}

// Core graph builder shared by the full-network graph and the on-demand
// regional subgraphs. Builds nodes / edges / nodeMeta / spatial-grid from
// ONLY the given rail-section features (station transfer edges added later).
function buildRouteGraphFromFeatures(features) {
  const nodes = new Map();
  const adjacency = new Map();
  const grid = new Map();
  const nodeMeta = new Map();
  const cellSize = 0.01;

  function ensureNode(coord) {
    const normalized = normalizeGraphCoord(coord);
    const key = coordKey(normalized);
    if (!nodes.has(key)) {
      nodes.set(key, normalized);
      adjacency.set(key, []);
      nodeMeta.set(key, {
        line_names: new Set(),
        operators: new Set(),
        institution_type_codes: new Set(),
        railway_class_codes: new Set(),
      });
      const gk = graphGridKey(normalized, cellSize);
      if (!grid.has(gk)) grid.set(gk, []);
      grid.get(gk).push(key);
    }
    return key;
  }

  function recordNodeMeta(key, properties) {
    const meta = nodeMeta.get(key);
    if (!meta) return;
    const lineName = properties?.N02_003 || properties?.line_name || "";
    const operator = properties?.N02_004 || properties?.operator || "";
    const institution = String(
      properties?.N02_002 || properties?.institution_type_code || "",
    );
    const railwayClass = String(
      properties?.N02_001 || properties?.railway_class_code || "",
    );
    if (lineName) meta.line_names.add(lineName);
    if (operator) meta.operators.add(operator);
    if (institution) meta.institution_type_codes.add(institution);
    if (railwayClass) meta.railway_class_codes.add(railwayClass);
  }

  function addRailEdge(aCoord, bCoord, properties) {
    const a = ensureNode(aCoord);
    const b = ensureNode(bCoord);
    if (a === b) return;
    recordNodeMeta(a, properties);
    recordNodeMeta(b, properties);
    const length = distanceMeters(nodes.get(a), nodes.get(b));
    const edge = {
      to: b,
      length: Math.max(length, 0.01),
      institution_type_code: String(
        properties?.N02_002 || properties?.institution_type_code || "",
      ),
      railway_class_code: String(
        properties?.N02_001 || properties?.railway_class_code || "",
      ),
      line_name: properties?.N02_003 || properties?.line_name || "",
      operator: properties?.N02_004 || properties?.operator || "",
    };
    adjacency.get(a).push(edge);
    adjacency.get(b).push({ ...edge, to: a });
  }

  // Python-equivalent rule: the routable graph is built ONLY from RailroadSection.
  // N02 Station LineString is used only for station snap candidates, never as a train-runnable edge.
  (features || []).forEach((feature) => {
    const props = feature.properties || {};
    iterateGeometryLines(feature.geometry).forEach((line) => {
      for (let i = 0; i < line.length - 1; i += 1)
        addRailEdge(line[i], line[i + 1], props);
    });
  });

  return {
    nodes,
    adjacency,
    grid,
    nodeMeta,
    cellSize,
    stationSnapCache: new Map(),
  };
}

// Full-network graph (~377k nodes). Retained as the guaranteed-correct
// fallback for on-demand solving; built lazily and memoized only if a
// regional subgraph proves insufficient — never eagerly at startup.
function getRuntimeRouteGraph() {
  if (runtimeRouteGraph) return runtimeRouteGraph;
  const graph = buildRouteGraphFromFeatures(
    (railSectionsGeoJson && railSectionsGeoJson.features) || [],
  );
  addStationTransferConnectorEdges(graph);
  runtimeRouteGraph = graph;
  console.info(
    `Runtime N02 railroad-only route graph built (full network): ${graph.nodes.size} nodes.`,
  );
  return runtimeRouteGraph;
}

// =========================================================================
//  §28.  On-demand regional route graphs & rail-section spatial index
// =========================================================================

// ---- On-demand regional route graphs ------------------------------------
// Instead of holding the whole-Japan graph resident, build small per-region
// subgraphs on demand and LRU-cache them. A subgraph built from EVERY rail
// feature inside a bbox is structurally identical to the full graph
// restricted to that bbox, so Dijkstra returns the SAME optimal path as long
// as that path stays inside the bbox. We check that at solve time
// (pathTouchesRegionEdge) and widen / fall back to the full graph otherwise,
// so on-demand results never differ from the all-Japan graph.

const RAIL_INDEX_CELL_DEG = 0.1;
let railSectionSpatialIndex = null;

function featureBbox(feature) {
  if (feature.__railBbox !== undefined) return feature.__railBbox;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  iterateGeometryLines(feature.geometry).forEach((line) => {
    for (const pt of line) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[1] > maxY) maxY = pt[1];
    }
  });
  const bbox = minX === Infinity ? null : [minX, minY, maxX, maxY];
  feature.__railBbox = bbox;
  return bbox;
}

// Coarse grid index over rail-section feature bboxes. Cheap (just bboxes +
// references), built once, so regional builds avoid scanning all 22k features.
function getRailSectionSpatialIndex() {
  if (railSectionSpatialIndex) return railSectionSpatialIndex;
  const grid = new Map();
  const feats = (railSectionsGeoJson && railSectionsGeoJson.features) || [];
  feats.forEach((feature) => {
    const bbox = featureBbox(feature);
    if (!bbox) return;
    const x0 = Math.floor(bbox[0] / RAIL_INDEX_CELL_DEG);
    const x1 = Math.floor(bbox[2] / RAIL_INDEX_CELL_DEG);
    const y0 = Math.floor(bbox[1] / RAIL_INDEX_CELL_DEG);
    const y1 = Math.floor(bbox[3] / RAIL_INDEX_CELL_DEG);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const k = `${x},${y}`;
        let arr = grid.get(k);
        if (!arr) {
          arr = [];
          grid.set(k, arr);
        }
        arr.push(feature);
      }
    }
  });
  railSectionSpatialIndex = grid;
  console.info(
    `Rail-section spatial index built: ${grid.size} cells over ${feats.length} features.`,
  );
  return grid;
}

function bboxIntersects(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function railFeaturesInBbox(bbox) {
  const grid = getRailSectionSpatialIndex();
  const x0 = Math.floor(bbox[0] / RAIL_INDEX_CELL_DEG);
  const x1 = Math.floor(bbox[2] / RAIL_INDEX_CELL_DEG);
  const y0 = Math.floor(bbox[1] / RAIL_INDEX_CELL_DEG);
  const y1 = Math.floor(bbox[3] / RAIL_INDEX_CELL_DEG);
  const seen = new Set();
  const out = [];
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      const arr = grid.get(`${x},${y}`);
      if (!arr) continue;
      for (const f of arr) {
        if (seen.has(f)) continue;
        seen.add(f);
        const fb = featureBbox(f);
        if (fb && bboxIntersects(fb, bbox)) out.push(f);
      }
    }
  }
  return out;
}

function stationFeaturesInBbox(bbox) {
  const feats = (stationsGeoJson && stationsGeoJson.features) || [];
  const out = [];
  for (const f of feats) {
    const c = getFeatureDisplayCoordinate(f);
    if (
      c &&
      c[0] >= bbox[0] &&
      c[0] <= bbox[2] &&
      c[1] >= bbox[1] &&
      c[1] <= bbox[3]
    )
      out.push(f);
  }
  return out;
}

// Expand a bbox by a metric margin (longitude scaled by latitude).
function padBboxMeters(bbox, meters) {
  const latPad = meters / 111320;
  const midLat = (bbox[1] + bbox[3]) / 2;
  const lonPad =
    meters / (111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  return [
    bbox[0] - lonPad,
    bbox[1] - latPad,
    bbox[2] + lonPad,
    bbox[3] + latPad,
  ];
}

function bboxDiagonalMeters(bbox) {
  return distanceMeters([bbox[0], bbox[1]], [bbox[2], bbox[3]]);
}

const REGION_QUANT_DEG = 0.25;
// Steady-state cap on total resident regional-graph nodes. Was 140,000 — smaller
// than a SINGLE cross-Japan region (50k–72k nodes), so a multi-region load
// evicted a region and then rebuilt the identical one 2–3× within one pass
// (56–61 builds observed for 117 trains). For reference the full-Japan graph is
// ~377k nodes and is already a tolerated fallback, so holding ~4–5 regions
// resident here is well within that envelope while erasing most re-builds.
const REGIONAL_GRAPH_NODE_BUDGET = 300000;
// During an active progressive load we suspend eviction so a region built for an
// early train is still resident when a later train needs it again — but cap the
// transient so a pathological all-Japan load can't blow up memory. Trimmed back
// to the steady budget by trimRegionalGraphCache() when the load finishes.
const REGIONAL_GRAPH_LOAD_NODE_BUDGET = 600000;
const regionalGraphCache = new Map(); // quantized-bbox key -> graph (insertion order = LRU)
let regionalGraphNodeCount = 0;

// Evict least-recently-used regional graphs until the resident node count is at
// or below `target` (always keeping at least one so the in-flight solve has its
// graph). Shared by the on-demand builder and the post-load trim.
function trimRegionalGraphCache(target) {
  while (regionalGraphNodeCount > target && regionalGraphCache.size > 1) {
    const oldestKey = regionalGraphCache.keys().next().value;
    const oldest = regionalGraphCache.get(oldestKey);
    regionalGraphCache.delete(oldestKey);
    regionalGraphNodeCount -= oldest.nodes.size;
  }
}

function quantizeBboxOutward(bbox) {
  return [
    Math.floor(bbox[0] / REGION_QUANT_DEG) * REGION_QUANT_DEG,
    Math.floor(bbox[1] / REGION_QUANT_DEG) * REGION_QUANT_DEG,
    Math.ceil(bbox[2] / REGION_QUANT_DEG) * REGION_QUANT_DEG,
    Math.ceil(bbox[3] / REGION_QUANT_DEG) * REGION_QUANT_DEG,
  ];
}

// Build (or reuse from LRU) the regional subgraph covering a bbox. Quantizing
// the bbox outward lets nearby sections share one subgraph; an LRU node budget
// caps total resident graph memory.
function getRegionalRouteGraph(bbox) {
  const qbbox = quantizeBboxOutward(bbox);
  const key = qbbox.map((v) => v.toFixed(2)).join(",");
  const cached = regionalGraphCache.get(key);
  if (cached) {
    regionalGraphCache.delete(key); // LRU touch
    regionalGraphCache.set(key, cached);
    return cached;
  }
  const graph = buildRouteGraphFromFeatures(railFeaturesInBbox(qbbox));
  addStationTransferConnectorEdges(graph, stationFeaturesInBbox(qbbox));
  graph.regionBbox = qbbox;
  regionalGraphCache.set(key, graph);
  regionalGraphNodeCount += graph.nodes.size;
  // While a load is solving many trains back-to-back, keep regions resident up
  // to the larger transient budget so an already-built region is reused instead
  // of evicted-then-rebuilt; finalizeProgressiveLoad() trims back to the steady
  // budget once the load settles. Interactive (non-load) solves trim immediately.
  trimRegionalGraphCache(
    importInProgress
      ? REGIONAL_GRAPH_LOAD_NODE_BUDGET
      : REGIONAL_GRAPH_NODE_BUDGET,
  );
  console.info(
    `Regional route graph built: ${graph.nodes.size} nodes for ${key} (${regionalGraphCache.size} region(s) cached).`,
  );
  return graph;
}

// Resolve BOTH endpoint station candidate lists of a route section (shared
// by the bbox helper and the on-graph solver so the from/to lookup pattern
// lives in exactly one place).
function resolveSectionEndpoints(section, train, allowedCodes) {
  return {
    fromStations: resolveRouteEndpointStationCandidates(
      { name: section.from, n02_station_code: section.from_n02_station_code },
      train,
      allowedCodes,
    ),
    toStations: resolveRouteEndpointStationCandidates(
      { name: section.to, n02_station_code: section.to_n02_station_code },
      train,
      allowedCodes,
    ),
  };
}

// Bounding box of a section's resolved endpoint station candidates.
function sectionEndpointBbox(section, train, allowedCodes) {
  const { fromStations, toStations } = resolveSectionEndpoints(
    section,
    train,
    allowedCodes,
  );
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  [...fromStations, ...toStations].forEach((f) => {
    const c = getFeatureDisplayCoordinate(f);
    if (!c) return;
    if (c[0] < minX) minX = c[0];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[1] > maxY) maxY = c[1];
  });
  return minX === Infinity ? null : [minX, minY, maxX, maxY];
}

// True if any vertex of the solved feature lies within marginDeg of the
// region edge — a signal the true optimum might leave the region, so the
// search should widen (or fall back to the full graph).
function pathTouchesRegionEdge(feature, regionBbox, marginDeg) {
  if (!feature || !regionBbox) return false;
  const coords = (feature.geometry && feature.geometry.coordinates) || [];
  for (const c of coords) {
    if (
      c[0] <= regionBbox[0] + marginDeg ||
      c[0] >= regionBbox[2] - marginDeg ||
      c[1] <= regionBbox[1] + marginDeg ||
      c[1] >= regionBbox[3] - marginDeg
    ) {
      return true;
    }
  }
  return false;
}

// On-demand replacement for "solve on the full graph". Uses a small regional
// subgraph; widens it (and finally falls back to the full graph) if the
// solved path reaches the region edge, so the result matches the all-Japan
// graph while keeping resident graph memory bounded.
function solveRouteSectionOnDemand(section, segmentIndex, train, allowedCodes) {
  const endpointBbox = sectionEndpointBbox(section, train, allowedCodes);
  if (!endpointBbox) {
    return solveRouteSectionOnN02Graph(
      section,
      segmentIndex,
      train,
      getRuntimeRouteGraph(),
      allowedCodes,
    );
  }
  const straight = bboxDiagonalMeters(endpointBbox);
  const margins = [
    Math.max(30000, straight * 0.6),
    Math.max(90000, straight * 1.5),
  ];
  let lastResult = null;
  for (const margin of margins) {
    const graph = getRegionalRouteGraph(padBboxMeters(endpointBbox, margin));
    const result = solveRouteSectionOnN02Graph(
      section,
      segmentIndex,
      train,
      graph,
      allowedCodes,
    );
    if (result) {
      lastResult = result;
      if (!pathTouchesRegionEdge(result, graph.regionBbox, 0.02)) return result;
    }
  }
  // The region wasn't conclusively large enough — use the full graph so the
  // answer is provably identical to the original all-Japan solve.
  const full = solveRouteSectionOnN02Graph(
    section,
    segmentIndex,
    train,
    getRuntimeRouteGraph(),
    allowedCodes,
  );
  return full || lastResult;
}

function intersects(a, b) {
  if (!a || !b) return false;
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function nearbyGraphNodes(coord, graph, radiusDeg = 0.0015, limit = 30) {
  const [lon, lat] = normalizeGraphCoord(coord);
  const baseX = Math.floor(lon / graph.cellSize);
  const baseY = Math.floor(lat / graph.cellSize);
  const cellRadius = Math.max(1, Math.ceil(radiusDeg / graph.cellSize));
  const found = [];
  const seen = new Set();
  for (let dx = -cellRadius; dx <= cellRadius; dx += 1) {
    for (let dy = -cellRadius; dy <= cellRadius; dy += 1) {
      const bucket = graph.grid.get(`${baseX + dx},${baseY + dy}`) || [];
      bucket.forEach((key) => {
        if (seen.has(key)) return;
        seen.add(key);
        const distance = distanceMeters([lon, lat], graph.nodes.get(key));
        found.push({ key, distance });
      });
    }
  }
  found.sort((a, b) => a.distance - b.distance);
  return found.slice(0, limit);
}

// =========================================================================
//  §29.  Route solving: institution/edge rules, route hints & Dijkstra
// =========================================================================

function preferredInstitutionSet(allowedCodes) {
  return new Set((allowedCodes || []).map(String).filter(Boolean));
}

function edgeHasPreferredInstitution(edge, allowedCodes) {
  const allowed = preferredInstitutionSet(allowedCodes);
  if (!allowed.size) return true;
  if (edge?.is_station_connector) {
    // A transfer connector bridges two physical platforms in the same station
    // group. Only allow it when every platform institution it joins is permitted,
    // so a JR-only train cannot hop onto an Osaka-Metro / private platform that
    // happens to share the station group (e.g. 天王寺 group 007439). Unknown
    // institutions are treated as acceptable to avoid over-filtering.
    const codes = edge.institution_type_codes || [];
    if (!codes.length) return true;
    return codes.every((code) => !code || allowed.has(String(code)));
  }
  if (!edge?.institution_type_code) return true;
  return allowed.has(String(edge.institution_type_code));
}

function edgeMatchesAllowedCodes(edge, allowedCodes, train, segmentHints = {}) {
  const hardFilter =
    train?.route_policy?.institution_filter_mode === "hard" ||
    Boolean(segmentHints.requirePreferredInstitution);
  if (!hardFilter) return true;
  return edgeHasPreferredInstitution(edge, allowedCodes);
}

function institutionPreferencePenaltyForEdge(edge, allowedCodes, train) {
  if (train?.route_policy?.institution_filter_mode === "hard") return 0;
  const preferred = preferredInstitutionSet(allowedCodes);
  if (
    !preferred.size ||
    !edge.institution_type_code ||
    preferred.has(String(edge.institution_type_code))
  )
    return 0;
  return (
    edge.length * NON_PREFERRED_INSTITUTION_LENGTH_FACTOR +
    NON_PREFERRED_INSTITUTION_EDGE_PENALTY
  );
}

function graphNodeHasPreferredInstitution(meta, allowedCodes) {
  const preferred = preferredInstitutionSet(allowedCodes);
  if (!preferred.size) return true;
  return intersects(meta?.institution_type_codes, preferred);
}

function addStationTransferConnectorEdges(graph, stationFeatures) {
  const stations =
    stationFeatures || (stationsGeoJson && stationsGeoJson.features) || [];
  const groups = new Map();
  const edgeKeys = new Set();

  function stationTransferGroupKey(feature) {
    const groupCode = stationGroupCode(feature);
    if (groupCode) return `group:${groupCode}`;
    const coord = getFeatureDisplayCoordinate(feature) || [0, 0];
    const lonBucket = Math.round(Number(coord[0]) * 10) / 10;
    const latBucket = Math.round(Number(coord[1]) * 10) / 10;
    return `name:${stationName(feature)}@${lonBucket},${latBucket}`;
  }

  function getGroup(key) {
    if (!groups.has(key)) groups.set(key, new Map());
    return groups.get(key);
  }

  function rememberNode(group, nearest, feature) {
    if (
      !nearest ||
      !nearest.key ||
      nearest.distance > STATION_TRANSFER_MAX_SNAP_METERS
    )
      return;
    const existing = group.get(nearest.key);
    if (!existing || nearest.distance < existing.distance) {
      group.set(nearest.key, {
        key: nearest.key,
        distance: nearest.distance,
        station_name: stationName(feature),
        n02_group_code: stationGroupCode(feature),
        line_name: stationLineName(feature),
        operator: stationOperator(feature),
        institution_type_code: stationInstitutionTypeCode(feature),
      });
    }
  }

  stations.forEach((feature) => {
    const key = stationTransferGroupKey(feature);
    const group = getGroup(key);
    const sourceLines = iterateGeometryLines(feature.geometry);
    const sourceCoords = sourceLines.length
      ? sourceLines.flat()
      : [getFeatureDisplayCoordinate(feature)];
    sourceCoords.forEach((coord) => {
      nearbyGraphNodes(
        coord,
        graph,
        STATION_TRANSFER_NODE_RADIUS_DEG,
        30,
      ).forEach((nearest) => rememberNode(group, nearest, feature));
    });
  });

  function addConnectorEdge(a, b, infoA, infoB) {
    if (!a || !b || a === b) return;
    const key = [a, b].sort().join("|");
    if (edgeKeys.has(key)) return;
    const aCoord = graph.nodes.get(a);
    const bCoord = graph.nodes.get(b);
    if (!aCoord || !bCoord) return;
    const gap = distanceMeters(aCoord, bCoord);
    if (gap > STATION_TRANSFER_MAX_NODE_GAP_METERS) return;
    edgeKeys.add(key);
    // Record the institution of each bridged platform so the institution filter
    // can reject connectors that would cross into a non-allowed operator class.
    const institutionTypeCodes = [
      ...new Set(
        [infoA?.institution_type_code, infoB?.institution_type_code]
          .map((c) => String(c || ""))
          .filter(Boolean),
      ),
    ];
    const baseEdge = {
      to: b,
      length: Math.max(gap + STATION_TRANSFER_EDGE_PENALTY, 0.01),
      institution_type_code: "",
      institution_type_codes: institutionTypeCodes,
      railway_class_code: "",
      line_name: "",
      operator: "",
      is_station_connector: true,
      station_name: infoA?.station_name || "",
      n02_group_code: infoA?.n02_group_code || "",
    };
    graph.adjacency.get(a).push(baseEdge);
    graph.adjacency.get(b).push({ ...baseEdge, to: a });
  }

  groups.forEach((nodeMap) => {
    const nodes = [...nodeMap.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, STATION_TRANSFER_MAX_NODES_PER_GROUP);
    for (let i = 0; i < nodes.length - 1; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        addConnectorEdge(nodes[i].key, nodes[j].key, nodes[i], nodes[j]);
      }
    }
  });
}

function stationMatchesPreferredInstitution(feature, allowedCodes) {
  const preferred = preferredInstitutionSet(allowedCodes);
  if (!preferred.size) return true;
  const code = stationInstitutionTypeCode(feature);
  return !code || preferred.has(String(code));
}

function filterStationsByPreferredInstitution(features, allowedCodes) {
  return (features || []).filter((feature) =>
    stationMatchesPreferredInstitution(feature, allowedCodes),
  );
}

function stationSetFrom(features, getter) {
  return new Set(
    (features || []).map(getter).filter((value) => value && value !== "-"),
  );
}

function filterStationCandidatesNear(
  features,
  referenceFeatures,
  maxDistanceMeters = 1800,
) {
  if (!features?.length || !referenceFeatures?.length) return [];
  return (features || []).filter((feature) => {
    const coord = getFeatureDisplayCoordinate(feature);
    return (referenceFeatures || []).some((reference) => {
      const referenceCoord = getFeatureDisplayCoordinate(reference);
      return (
        coord &&
        referenceCoord &&
        distanceMeters(coord, referenceCoord) <= maxDistanceMeters
      );
    });
  });
}

function resolveRouteEndpointStationCandidates(endpoint, train, allowedCodes) {
  const candidates = resolveStationCandidates(endpoint);
  const name = typeof endpoint === "string" ? endpoint : stopName(endpoint);
  const code = typeof endpoint === "string" ? null : stopStationCode(endpoint);
  if (!name || !code || !candidates.length) return candidates;

  const preferredCandidates = filterStationsByPreferredInstitution(
    candidates,
    allowedCodes,
  );
  const sameNameCandidates = resolveStationCandidates({
    name,
    n02_station_code: null,
  });
  const sameNamePreferred = filterStationsByPreferredInstitution(
    sameNameCandidates,
    allowedCodes,
  );
  const nearbySameNamePreferred = filterStationCandidatesNear(
    sameNamePreferred,
    candidates,
    1800,
  );

  // N02 station codes are line-specific.  Long limited-express segments often
  // omit intermediate stops, so the endpoint code may be a same-station line
  // that is not the actual through route (for example 大分 on 久大線 while
  // ソニック should leave via 日豊線, or 大月/Fuji-Q through-running points).
  // Keep the exact code as a fallback, but add nearby same-name candidates in
  // the preferred institution class so Dijkstra can infer the real railroad
  // between distant stop pairs.
  if (nearbySameNamePreferred.length) {
    return dedupeStationFeatures([...nearbySameNamePreferred, ...candidates]);
  }

  if (preferredCandidates.length) return candidates;

  const sameNamePreferredFallback = filterStationsByPreferredInstitution(
    sameNameCandidates,
    allowedCodes,
  );
  if (!sameNamePreferredFallback.length) return candidates;

  console.warn(
    "Route endpoint code resolves only to non-preferred institution; adding same-name preferred-institution candidates.",
    {
      train_id: train?.id,
      station: name,
      n02_station_code: code,
      allowed_institution_type_codes: allowedCodes,
      exact_candidates: candidates.map((feature) => ({
        name: stationName(feature),
        n02_station_code: stationCode(feature),
        line_name: stationLineName(feature),
        operator: stationOperator(feature),
        institution_type_code: stationInstitutionTypeCode(feature),
      })),
      preferred_same_name_candidates: sameNamePreferredFallback.map(
        (feature) => ({
          name: stationName(feature),
          n02_station_code: stationCode(feature),
          line_name: stationLineName(feature),
          operator: stationOperator(feature),
          institution_type_code: stationInstitutionTypeCode(feature),
        }),
      ),
    },
  );
  return dedupeStationFeatures([...sameNamePreferredFallback, ...candidates]);
}

function edgeMatchesRequiredHints(edge, segmentHints) {
  const requiredLines = segmentHints.requiredLines || new Set();
  const requiredOperators = segmentHints.requiredOperators || new Set();

  // route_sections[].line_names / operator_names are explicit per-segment
  // constraints.  Short in-station connector edges are allowed so line-specific
  // station codes can still reach the actual RailroadSection geometry at the
  // same physical station.
  if (edge.is_station_connector) return true;
  if (requiredLines.size && !requiredLines.has(edge.line_name || ""))
    return false;
  if (requiredOperators.size && !requiredOperators.has(edge.operator || ""))
    return false;
  return true;
}

function solveRouteSectionOnN02Graph(
  section,
  segmentIndex,
  train,
  graph,
  allowedCodes,
) {
  const { fromStations, toStations } = resolveSectionEndpoints(
    section,
    train,
    allowedCodes,
  );

  if (!fromStations.length || !toStations.length) {
    console.warn(
      "Route section endpoint station not found; segment skipped.",
      section,
    );
    return null;
  }

  const baseHints = buildSegmentRouteHints(
    section,
    fromStations,
    toStations,
    train,
  );
  const solveAttempts = buildSegmentRouteSolveAttempts(baseHints);

  let best = null;
  let usedHints = null;
  let lastCandidateFailure = false;

  for (const segmentHints of solveAttempts) {
    const fromCandidates = collectStationCandidateGraphNodes(
      fromStations,
      graph,
      segmentHints,
      allowedCodes,
    ).slice(0, 12);
    const toCandidates = collectStationCandidateGraphNodes(
      toStations,
      graph,
      segmentHints,
      allowedCodes,
    ).slice(0, 12);
    if (!fromCandidates.length || !toCandidates.length) {
      lastCandidateFailure = true;
      continue;
    }

    // ONE multi-source → multi-target Dijkstra per attempt instead of a
    // from×to nested loop of full runs (12×12 = up to 144 per attempt). All
    // from-candidates are seeded into the heap at their snap-penalty cost, so
    // each settled target yields the pair-optimal (path cost + from-snap)
    // route; the to-snap and line-mismatch scoring below is unchanged.
    let attemptBest = null;
    const fromByKey = new Map(fromCandidates.map((c) => [c.key, c]));
    const toByKey = new Map(toCandidates.map((c) => [c.key, c]));
    const solvedTargets = dijkstraFromCandidateSources(
      graph,
      fromCandidates,
      new Set(toByKey.keys()),
      train,
      allowedCodes,
      segmentHints,
    );
    solvedTargets.forEach((solved) => {
      if (!solved.pathKeys || solved.pathKeys.length < 2) return;
      const fromCandidate = fromByKey.get(solved.sourceKey);
      const toCandidate = toByKey.get(solved.targetKey);
      if (!fromCandidate || !toCandidate) return;
      const straight = distanceMeters(
        graph.nodes.get(fromCandidate.key),
        graph.nodes.get(toCandidate.key),
      );
      const physicalLength = pathLengthMeters(graph, solved.pathKeys);
      const detourLimit = Math.max(straight * 3.8 + 6000, 12000);
      if (straight > 1500 && physicalLength > detourLimit) {
        console.warn("Rejected likely detour path.", {
          section,
          physicalLength,
          straight,
          detourLimit,
          hints: segmentHints,
        });
        return;
      }
      // Snap distance is not a drawable route. Treat it as an error term, not
      // as a cheap substitute for real rail geometry. This prevents short
      // segments such as 成田空港→空港第2ビル from being truncated by choosing
      // two far-along station candidates whose Dijkstra path is only a few
      // dozen meters long.
      const snapPenalty =
        (fromCandidate.distance + toCandidate.distance) *
        STATION_SNAP_COST_FACTOR;
      const totalCost = solved.cost + snapPenalty;
      const linePenalty = routeLineMismatchPenalty(
        graph,
        solved.pathKeys,
        segmentHints,
      );
      const scoredCost = totalCost + linePenalty;
      if (!attemptBest || scoredCost < attemptBest.scoredCost) {
        attemptBest = {
          pathKeys: solved.pathKeys,
          scoredCost,
          totalCost,
          physicalLength,
          snapFrom: fromCandidate.distance,
          snapTo: toCandidate.distance,
          fromCandidate,
          toCandidate,
        };
      }
    });

    // Important: the first successful attempt wins. This prevents a soft fallback
    // from adding/choosing a parallel or detour route when the strict N02 route-line
    // constraint already produced a valid single primary segment.
    if (
      attemptBest &&
      attemptBest.pathKeys &&
      attemptBest.pathKeys.length >= 2
    ) {
      best = attemptBest;
      usedHints = segmentHints;
      break;
    }
  }

  if (!best || !best.pathKeys || best.pathKeys.length < 2) {
    console.warn(
      "No graph path found for route section; segment skipped.",
      section,
      baseHints,
      { lastCandidateFailure },
    );
    return null;
  }

  const segmentHints = usedHints || baseHints;
  const rawCoordinates = best.pathKeys.map((key) => graph.nodes.get(key));
  const coordinates = completeRouteEndpointCoordinates(
    rawCoordinates,
    best.fromCandidate?.stationFeature || fromStations[0],
    best.toCandidate?.stationFeature || toStations[0],
  );
  return {
    type: "Feature",
    properties: {
      train_id: train.id,
      route_id: `${train.id}-runtime-primary`,
      variant_rank: 0,
      is_primary: true,
      route_choice: "single_best_path",
      geometry_role: "single_primary_segment",
      source:
        "browser_dijkstra_on_embedded_n02_railroadsection_graph_python_equivalent",
      segment_index: segmentIndex,
      from: section.from || stationName(fromStations[0]),
      to: section.to || stationName(toStations[0]),
      from_n02_station_code:
        section.from_n02_station_code || stationCode(fromStations[0]),
      to_n02_station_code:
        section.to_n02_station_code || stationCode(toStations[0]),
      allowed_institution_type_codes: allowedCodes,
      preferred_line_names: [...segmentHints.preferredLines],
      required_line_names: [...segmentHints.requiredLines],
      required_operator_names: [...segmentHints.requiredOperators],
      preferred_operator_names: [...segmentHints.preferredOperators],
      solve_mode: segmentHints.solve_mode || "base",
      require_preferred_institution: Boolean(
        segmentHints.requirePreferredInstitution,
      ),
      used_institution_type_codes: usedInstitutionTypeCodes(
        graph,
        best.pathKeys,
      ),
      route_template_key: getTrainRouteTemplateKey(train),
      path_coordinate_count: coordinates.length,
      raw_path_coordinate_count: rawCoordinates.length,
      snap_distance_m: {
        from: Math.round(best.snapFrom * 100) / 100,
        to: Math.round(best.snapTo * 100) / 100,
      },
      endpoint_display_gap_m: {
        from:
          Math.round(
            distanceMeters(
              getFeatureDisplayCoordinate(
                best.fromCandidate?.stationFeature || fromStations[0],
              ),
              rawCoordinates[0],
            ) * 100,
          ) / 100,
        to:
          Math.round(
            distanceMeters(
              getFeatureDisplayCoordinate(
                best.toCandidate?.stationFeature || toStations[0],
              ),
              rawCoordinates[rawCoordinates.length - 1],
            ) * 100,
          ) / 100,
      },
      physical_length_m:
        Math.round(pathLengthForCoordinates(coordinates) * 100) / 100,
      raw_physical_length_m: Math.round(best.physicalLength * 100) / 100,
      cost: Math.round(best.totalCost * 100) / 100,
    },
    geometry: { type: "LineString", coordinates },
  };
}

function normalizeRouteHintText(value) {
  return String(value || "").trim();
}

function sectionEndpointNames(section) {
  return [
    normalizeRouteHintText(section?.from),
    normalizeRouteHintText(section?.to),
  ].filter(Boolean);
}

function sectionHasAnyEndpoint(section, names) {
  const endpoints = sectionEndpointNames(section);
  return endpoints.some((name) => names.includes(name));
}

function sectionHasEndpointPair(section, aNames, bNames) {
  const endpoints = sectionEndpointNames(section);
  return (
    endpoints.some((name) => aNames.includes(name)) &&
    endpoints.some((name) => bNames.includes(name))
  );
}

function inferSectionRouteConstraints(section, train) {
  const text = [
    train?.id,
    train?.number,
    train?.train_type,
    train?.company,
    train?.origin,
    train?.destination,
  ]
    .map(normalizeRouteHintText)
    .join(" ");
  const lineNames = new Set();
  const operatorNames = new Set();

  // JR Kyushu Sonic: N02 often gives 大分 as 久大線 and 小倉 as 鹿児島線,
  // while the actual limited express runs on 日豊線 between 大分/別府/中津/小倉.
  if (
    /ソニック|sonic/i.test(text) &&
    sectionHasAnyEndpoint(section, ["大分", "別府", "中津", "小倉"])
  ) {
    lineNames.add("日豊線");
    operatorNames.add("九州旅客鉄道");
  }

  // Haruka: keep the route on JR West around Kansai Airport/Osaka and stop
  // the solver from preferring nearby subway geometry at 天王寺/大阪/新大阪.
  if (/はるか|haruka/i.test(text)) {
    operatorNames.add("西日本旅客鉄道");
    if (sectionHasEndpointPair(section, ["関西空港"], ["日根野"]))
      lineNames.add("関西空港線");
    else if (sectionHasEndpointPair(section, ["日根野"], ["天王寺"]))
      lineNames.add("阪和線");
    else if (sectionHasEndpointPair(section, ["天王寺"], ["大阪"]))
      lineNames.add("大阪環状線");
    else if (sectionHasEndpointPair(section, ["大阪"], ["新大阪"]))
      lineNames.add("東海道線");
  }

  return {
    line_names: [...lineNames],
    operator_names: [...operatorNames],
  };
}

function buildSegmentRouteHints(section, fromStations, toStations, train) {
  const allowedCodes = getAllowedInstitutionTypeCodes(train);
  const preferredLines = new Set(
    (train.route_policy?.preferred_line_names || [])
      .map(String)
      .filter(Boolean),
  );
  const preferredOperators = new Set(
    [
      ...(train.route_policy?.preferred_operator_names || []),
      // 公司 field soft-biases the solver toward that operator's tracks.
      ...derivedPreferredOperatorNames(train),
    ]
      .map(String)
      .filter(Boolean),
  );
  const inferredConstraints = inferSectionRouteConstraints(section, train);
  const explicitRequiredLines = new Set([
    ...(section.line_names || []).map(String).filter(Boolean),
    ...(inferredConstraints.line_names || []),
  ]);
  const explicitRequiredOperators = new Set([
    ...(section.operator_names || section.operator_hints || [])
      .map(String)
      .filter(Boolean),
    ...(inferredConstraints.operator_names || []),
  ]);
  const requiredLines = new Set(explicitRequiredLines);
  const requiredOperators = new Set(explicitRequiredOperators);
  requiredLines.forEach((value) => value && preferredLines.add(value));
  requiredOperators.forEach((value) => value && preferredOperators.add(value));

  const fromPreferredInstitutionStations = filterStationsByPreferredInstitution(
    fromStations,
    allowedCodes,
  );
  const toPreferredInstitutionStations = filterStationsByPreferredInstitution(
    toStations,
    allowedCodes,
  );
  const fromPreferredPool = fromPreferredInstitutionStations.length
    ? fromPreferredInstitutionStations
    : fromStations;
  const toPreferredPool = toPreferredInstitutionStations.length
    ? toPreferredInstitutionStations
    : toStations;

  const fromLines = stationSetFrom(fromStations, stationLineName);
  const toLines = stationSetFrom(toStations, stationLineName);
  const fromOperators = stationSetFrom(fromStations, stationOperator);
  const toOperators = stationSetFrom(toStations, stationOperator);
  const fromPreferredLines = stationSetFrom(fromPreferredPool, stationLineName);
  const toPreferredLines = stationSetFrom(toPreferredPool, stationLineName);
  const fromPreferredOperators = stationSetFrom(
    fromPreferredPool,
    stationOperator,
  );
  const toPreferredOperators = stationSetFrom(toPreferredPool, stationOperator);

  const allCommonLines = new Set(
    [...fromLines].filter((line) => toLines.has(line)),
  );
  const allCommonOperators = new Set(
    [...fromOperators].filter((operator) => toOperators.has(operator)),
  );
  const preferredInstitutionCommonLines = new Set(
    [...fromPreferredLines].filter((line) => toPreferredLines.has(line)),
  );
  const preferredInstitutionCommonOperators = new Set(
    [...fromPreferredOperators].filter((operator) =>
      toPreferredOperators.has(operator),
    ),
  );

  // For JR/Shinkansen/JR-conventional trains, common subway/private station
  // names at large interchanges should not become equally good hints.  Prefer
  // common lines/operators from the allowed institution class first, and keep
  // all-company common hints only as a fallback.
  const commonLines = preferredInstitutionCommonLines.size
    ? preferredInstitutionCommonLines
    : allCommonLines;
  const commonOperators = preferredInstitutionCommonOperators.size
    ? preferredInstitutionCommonOperators
    : allCommonOperators;

  commonLines.forEach((line) => preferredLines.add(line));
  commonOperators.forEach((operator) => preferredOperators.add(operator));
  if (!preferredLines.size && fromPreferredLines.size === 1)
    fromPreferredLines.forEach((line) => preferredLines.add(line));
  if (!preferredLines.size && toPreferredLines.size === 1)
    toPreferredLines.forEach((line) => preferredLines.add(line));
  if (
    !preferredOperators.size &&
    fromPreferredOperators.size === 1 &&
    toPreferredOperators.size === 1
  ) {
    const fromOperator = [...fromPreferredOperators][0];
    const toOperator = [...toPreferredOperators][0];
    if (fromOperator === toOperator) preferredOperators.add(fromOperator);
  }

  return {
    preferredLines,
    preferredOperators,
    requiredLines,
    requiredOperators,
    explicitRequiredLines,
    explicitRequiredOperators,
    commonLines,
    commonOperators,
    allCommonLines,
    allCommonOperators,
    preferredInstitutionCommonLines,
    preferredInstitutionCommonOperators,
    fromLines,
    toLines,
    fromOperators,
    toOperators,
    fromPreferredLines,
    toPreferredLines,
    fromPreferredOperators,
    toPreferredOperators,
    requirePreferredInstitution: false,
    solve_mode: "base",
  };
}

function cloneSegmentHints(baseHints, overrides = {}) {
  return {
    preferredLines: new Set(
      overrides.preferredLines || baseHints.preferredLines || [],
    ),
    preferredOperators: new Set(
      overrides.preferredOperators || baseHints.preferredOperators || [],
    ),
    requiredLines: new Set(
      overrides.requiredLines || baseHints.requiredLines || [],
    ),
    requiredOperators: new Set(
      overrides.requiredOperators || baseHints.requiredOperators || [],
    ),
    explicitRequiredLines: new Set(baseHints.explicitRequiredLines || []),
    explicitRequiredOperators: new Set(
      baseHints.explicitRequiredOperators || [],
    ),
    commonLines: new Set(baseHints.commonLines || []),
    commonOperators: new Set(baseHints.commonOperators || []),
    allCommonLines: new Set(baseHints.allCommonLines || []),
    allCommonOperators: new Set(baseHints.allCommonOperators || []),
    preferredInstitutionCommonLines: new Set(
      baseHints.preferredInstitutionCommonLines || [],
    ),
    preferredInstitutionCommonOperators: new Set(
      baseHints.preferredInstitutionCommonOperators || [],
    ),
    fromLines: new Set(baseHints.fromLines || []),
    toLines: new Set(baseHints.toLines || []),
    fromOperators: new Set(baseHints.fromOperators || []),
    toOperators: new Set(baseHints.toOperators || []),
    fromPreferredLines: new Set(baseHints.fromPreferredLines || []),
    toPreferredLines: new Set(baseHints.toPreferredLines || []),
    fromPreferredOperators: new Set(baseHints.fromPreferredOperators || []),
    toPreferredOperators: new Set(baseHints.toPreferredOperators || []),
    requirePreferredInstitution: Boolean(
      overrides.requirePreferredInstitution ??
      baseHints.requirePreferredInstitution,
    ),
    solve_mode: overrides.solve_mode || baseHints.solve_mode || "base",
  };
}

function buildSegmentRouteSolveAttempts(baseHints) {
  const attempts = [];
  const explicitLines = baseHints.explicitRequiredLines || new Set();
  const explicitOperators = baseHints.explicitRequiredOperators || new Set();
  const commonLines = baseHints.commonLines || new Set();
  const commonOperators = baseHints.commonOperators || new Set();

  function pushAttempt(overrides) {
    const attempt = cloneSegmentHints(baseHints, overrides);
    const key = [
      attempt.solve_mode,
      attempt.requirePreferredInstitution ? "home" : "soft",
      [...(attempt.requiredLines || [])].sort().join(","),
      [...(attempt.requiredOperators || [])].sort().join(","),
    ].join("|");
    if (attempts.some((existing) => existing.__attemptKey === key)) return;
    attempt.__attemptKey = key;
    attempts.push(attempt);
  }

  // Strict section hints, including inferred known-service constraints such
  // as Sonic=日豊線/九州旅客鉄道 and Haruka=JR西日本 lines, are tried first.
  if (explicitLines.size) {
    pushAttempt({
      requiredLines: explicitLines,
      requiredOperators: explicitOperators,
      requirePreferredInstitution: true,
      solve_mode: "explicit_section_route_required_home_institution",
    });
    pushAttempt({
      requiredLines: explicitLines,
      requiredOperators: explicitOperators,
      requirePreferredInstitution: false,
      solve_mode: "explicit_section_route_required_soft_institution",
    });
    return attempts;
  }

  if (explicitOperators.size) {
    // Only an operator is pinned (e.g. inferred 西日本旅客鉄道) and the JSON gave no
    // explicit line — common when the route is split at every pass-through stop.
    // Prefer the single line shared by both endpoints BEFORE falling back to
    // operator-only, so finely-split sections follow the real through line instead
    // of wandering onto a parallel same-operator line at big interchanges (the
    // cause of はるか drifting around 天王寺/新今宮).
    if (commonLines.size) {
      pushAttempt({
        requiredLines: commonLines,
        requiredOperators: explicitOperators,
        requirePreferredInstitution: true,
        solve_mode: "operator_pinned_common_line_required_home_institution",
      });
      pushAttempt({
        requiredLines: commonLines,
        requiredOperators: explicitOperators,
        requirePreferredInstitution: false,
        solve_mode: "operator_pinned_common_line_required_soft_institution",
      });
    }
    pushAttempt({
      requiredLines: new Set(),
      requiredOperators: explicitOperators,
      requirePreferredInstitution: true,
      solve_mode: "explicit_operator_required_home_institution",
    });
    pushAttempt({
      requiredLines: new Set(),
      requiredOperators: explicitOperators,
      requirePreferredInstitution: false,
      solve_mode: "explicit_operator_required_soft_institution",
    });
    return attempts;
  }

  if (commonLines.size && commonOperators.size) {
    pushAttempt({
      requiredLines: commonLines,
      requiredOperators: commonOperators,
      requirePreferredInstitution: true,
      solve_mode: "common_line_and_operator_required_home_institution",
    });
  }

  if (commonLines.size) {
    pushAttempt({
      requiredLines: commonLines,
      requiredOperators: new Set(),
      requirePreferredInstitution: true,
      solve_mode: "common_line_required_home_institution",
    });
  }

  if (commonOperators.size) {
    pushAttempt({
      requiredLines: new Set(),
      requiredOperators: commonOperators,
      requirePreferredInstitution: true,
      solve_mode: "common_operator_required_home_institution",
    });
  }

  pushAttempt({
    requiredLines: baseHints.requiredLines,
    requiredOperators: baseHints.requiredOperators,
    requirePreferredInstitution: true,
    solve_mode: "home_institution_soft_line_operator_hints",
  });

  // Only after all home-institution / same-operator attempts fail do we allow
  // other operators. The large non-preferred penalties still keep fallback
  // routes from snapping to subway/private lines unless the home route is
  // unavailable or an extreme detour.
  if (commonLines.size) {
    pushAttempt({
      requiredLines: commonLines,
      requiredOperators: new Set(),
      requirePreferredInstitution: false,
      solve_mode: "common_line_required_other_operator_fallback",
    });
  }

  pushAttempt({
    requiredLines: baseHints.requiredLines,
    requiredOperators: baseHints.requiredOperators,
    requirePreferredInstitution: false,
    solve_mode:
      commonLines.size || commonOperators.size
        ? "soft_fallback_after_home_attempts"
        : "no_common_line_soft_fallback",
  });

  // Final safety net: a fully unbiased, institution-only attempt with the
  // preferred line/operator hints CLEARED. Every attempt above keeps the
  // preferred-line penalty, which can make a long same-line detour cheaper
  // than the real path when a segment must leave the shared line onto a
  // branch/through line (e.g. 宇和海 between 伊予大洲 and 内子 must run
  // 予讃線 -> 内子線 -> 予讃線). Those detours then trip the detour guard and
  // the whole segment gets dropped, leaving a big visible gap. Clearing the
  // hints lets the shortest valid JR path win instead of cutting the segment
  // off. It runs last, so it only takes over when every biased attempt failed.
  pushAttempt({
    requiredLines: new Set(),
    requiredOperators: new Set(),
    preferredLines: new Set(),
    preferredOperators: new Set(),
    requirePreferredInstitution: true,
    solve_mode: "institution_only_unbiased_fallback",
  });

  return attempts;
}

function usedInstitutionTypeCodes(graph, pathKeys) {
  const used = new Set();
  for (let i = 0; i < pathKeys.length - 1; i += 1) {
    const edge = findEdge(graph, pathKeys[i], pathKeys[i + 1]);
    if (edge?.institution_type_code)
      used.add(String(edge.institution_type_code));
  }
  return [...used].sort();
}

// Per-edge penalty for leaving the preferred line/operator. Shared by the
// Dijkstra edge relaxation and the post-hoc whole-path scoring so the penalty
// formula has one definition. Callers must skip station-connector edges.
function nonPreferredLineOperatorPenalty(
  edge,
  preferredLines,
  preferredOperators,
) {
  let penalty = 0;
  if (
    preferredLines.size &&
    edge.line_name &&
    !preferredLines.has(edge.line_name)
  ) {
    penalty += edge.length * NON_PREFERRED_LINE_LENGTH_FACTOR;
  }
  if (
    preferredOperators.size &&
    edge.operator &&
    !preferredOperators.has(edge.operator)
  ) {
    penalty += edge.length * NON_PREFERRED_OPERATOR_LENGTH_FACTOR;
  }
  return penalty;
}

function routeLineMismatchPenalty(graph, pathKeys, segmentHints) {
  const preferredLines = segmentHints.preferredLines || new Set();
  const preferredOperators = segmentHints.preferredOperators || new Set();
  if (!preferredLines.size && !preferredOperators.size) return 0;
  let penalty = 0;
  for (let i = 0; i < pathKeys.length - 1; i += 1) {
    const edge = findEdge(graph, pathKeys[i], pathKeys[i + 1]);
    if (!edge || edge.is_station_connector) continue;
    penalty += nonPreferredLineOperatorPenalty(
      edge,
      preferredLines,
      preferredOperators,
    );
  }
  return penalty;
}

function findEdge(graph, fromKey, toKey) {
  return (
    (graph.adjacency.get(fromKey) || []).find((edge) => edge.to === toKey) ||
    null
  );
}

function collectStationCandidateGraphNodes(
  stationFeatures,
  graph,
  hints,
  allowedCodes,
) {
  const seen = new Set();
  const candidates = [];
  stationFeatures.forEach((feature) => {
    getStationCandidateGraphNodes(feature, graph, hints, allowedCodes).forEach(
      (candidate) => {
        if (seen.has(candidate.key)) return;
        seen.add(candidate.key);
        candidates.push(candidate);
      },
    );
  });
  candidates.sort((a, b) => a.score - b.score || a.distance - b.distance);
  return candidates;
}

function getStationCandidateGraphNodes(
  stationFeature,
  graph,
  hints = { preferredLines: new Set(), preferredOperators: new Set() },
  allowedCodes = [...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES],
) {
  const allowedKey = (allowedCodes || []).map(String).sort().join(",");
  const cacheKey = `${stationCode(stationFeature) || stationName(stationFeature)}|${stationLineName(stationFeature)}|${stationOperator(stationFeature)}|${allowedKey}|home:${hints.requirePreferredInstitution ? 1 : 0}|reqL:${[...(hints.requiredLines || [])].join("/")}|reqO:${[...(hints.requiredOperators || [])].join("/")}|prefL:${[...(hints.preferredLines || [])].join("/")}|prefO:${[...(hints.preferredOperators || [])].join("/")}`;
  if (cacheKey && graph.stationSnapCache.has(cacheKey))
    return graph.stationSnapCache.get(cacheKey);

  const candidateMap = new Map();
  const sourceLines = iterateGeometryLines(stationFeature.geometry);
  const sourceCoords = sourceLines.length
    ? sourceLines.flat()
    : [getFeatureDisplayCoordinate(stationFeature)];
  const stationLine = stationLineName(stationFeature);
  const stationOperatorName = stationOperator(stationFeature);

  function maybeUpsertCandidate(nearest) {
    if (!nearest || !nearest.key) return;
    const meta = graph.nodeMeta.get(nearest.key);
    if (!meta) return;
    const hasPreferredInstitution = graphNodeHasPreferredInstitution(
      meta,
      allowedCodes,
    );
    if (hints.requirePreferredInstitution && !hasPreferredInstitution) return;
    if (
      (hints.requiredLines || new Set()).size &&
      !intersects(hints.requiredLines, meta.line_names)
    )
      return;
    if (
      (hints.requiredOperators || new Set()).size &&
      !intersects(hints.requiredOperators, meta.operators)
    )
      return;
    let score = nearest.distance;
    if (stationLine && meta.line_names?.has(stationLine)) score -= 40;
    if (stationOperatorName && meta.operators?.has(stationOperatorName))
      score -= 15;
    if (intersects(hints.preferredLines, meta.line_names)) {
      score -= 25;
    } else if ((hints.preferredLines || new Set()).size) {
      score += NON_PREFERRED_LINE_STATION_SNAP_PENALTY;
    }
    if (intersects(hints.preferredOperators, meta.operators)) {
      score -= 10;
    } else if ((hints.preferredOperators || new Set()).size) {
      score += NON_PREFERRED_OPERATOR_STATION_SNAP_PENALTY;
    }
    if (!hasPreferredInstitution) score += NON_PREFERRED_STATION_SNAP_PENALTY;
    const candidate = {
      key: nearest.key,
      distance: nearest.distance,
      score,
      hasPreferredInstitution,
      stationFeature,
    };
    const previous = candidateMap.get(nearest.key);
    if (
      !previous ||
      candidate.score < previous.score ||
      (candidate.score === previous.score &&
        candidate.distance < previous.distance)
    ) {
      candidateMap.set(nearest.key, candidate);
    }
  }

  sourceCoords.forEach((coord) => {
    // Station geometries are often LineString objects. The same railroad node can be
    // discovered from multiple station-geometry vertices; keep the best snap per node
    // instead of freezing the first, possibly hundreds-of-meters-away encounter.
    nearbyGraphNodes(coord, graph, 0.006, 160).forEach((nearest) => {
      if (nearest.distance <= STATION_SNAP_MAX_DISTANCE_METERS)
        maybeUpsertCandidate(nearest);
    });
  });

  const candidates = [...candidateMap.values()].sort(
    (a, b) => a.score - b.score || a.distance - b.distance,
  );
  const sliced = candidates.slice(0, 16);
  graph.stationSnapCache.set(cacheKey, sliced);
  return sliced;
}

// Multi-source → multi-target Dijkstra. Every from-candidate is seeded into
// the heap at its snap-penalty cost (distance × STATION_SNAP_COST_FACTOR), so
// a single run over the graph settles, for each target node, the pair-optimal
// combination of (source snap + path cost) — replacing the former per-pair
// dijkstraBetweenExactNodes nested loop (up to sources×targets full runs per
// attempt) with exactly one run per attempt. The search stops as soon as all
// targets are settled. Each result reports which source won via `sourceKey`
// (tracked through relaxation) plus the PURE path cost with the seed snap
// penalty subtracted back out, so the caller's scoring stays unchanged.
function dijkstraFromCandidateSources(
  graph,
  sourceCandidates,
  targetKeys,
  train,
  allowedCodes,
  segmentHints = {
    preferredLines: new Set(),
    preferredOperators: new Set(),
    requiredLines: new Set(),
    requiredOperators: new Set(),
  },
) {
  const distance = new Map();
  const previous = new Map();
  const sourceOf = new Map();
  const seedCost = new Map();
  const heap = new MinHeap();
  sourceCandidates.forEach((candidate) => {
    const init = candidate.distance * STATION_SNAP_COST_FACTOR;
    if (init < (distance.get(candidate.key) ?? Infinity)) {
      distance.set(candidate.key, init);
      sourceOf.set(candidate.key, candidate.key);
      seedCost.set(candidate.key, init);
      heap.push({ key: candidate.key, priority: init });
    }
  });
  const visited = new Set();
  const remaining = new Set(targetKeys);
  const settled = [];

  while (heap.size() && remaining.size) {
    const current = heap.pop();
    if (visited.has(current.key)) continue;
    visited.add(current.key);
    if (remaining.has(current.key)) {
      remaining.delete(current.key);
      settled.push({ targetKey: current.key, settledCost: current.priority });
    }
    const edges = graph.adjacency.get(current.key) || [];
    edges.forEach((edge) => {
      if (!edgeMatchesAllowedCodes(edge, allowedCodes, train, segmentHints))
        return;
      if (!edgeMatchesRequiredHints(edge, segmentHints)) return;
      let weight =
        edge.length +
        (edge.is_station_connector
          ? 0
          : institutionPreferencePenaltyForEdge(edge, allowedCodes, train));
      // Preferred hints should be strong but not hard unless the user put them in section.line_names/operator_hints.
      if (!edge.is_station_connector) {
        weight += nonPreferredLineOperatorPenalty(
          edge,
          segmentHints.preferredLines || new Set(),
          segmentHints.preferredOperators || new Set(),
        );
      }
      const nextCost = current.priority + weight;
      if (nextCost < (distance.get(edge.to) ?? Infinity)) {
        distance.set(edge.to, nextCost);
        previous.set(edge.to, current.key);
        sourceOf.set(edge.to, sourceOf.get(current.key));
        heap.push({ key: edge.to, priority: nextCost });
      }
    });
  }

  return settled.map((entry) => {
    const sourceKey = sourceOf.get(entry.targetKey);
    return {
      targetKey: entry.targetKey,
      sourceKey,
      // Pure path cost (matches the old per-pair solved.cost): subtract the
      // winning source's seeded snap cost back out.
      cost: entry.settledCost - (seedCost.get(sourceKey) || 0),
      pathKeys: reconstructPath(previous, sourceKey, entry.targetKey),
    };
  });
}

function pathLengthMeters(graph, pathKeys) {
  let length = 0;
  for (let i = 0; i < pathKeys.length - 1; i += 1) {
    length += distanceMeters(
      graph.nodes.get(pathKeys[i]),
      graph.nodes.get(pathKeys[i + 1]),
    );
  }
  return length;
}

function pathLengthForCoordinates(coordinates) {
  let length = 0;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    length += distanceMeters(coordinates[i], coordinates[i + 1]);
  }
  return length;
}

function completeRouteEndpointCoordinates(
  coordinates,
  fromStationFeature,
  toStationFeature,
) {
  if (!Array.isArray(coordinates) || coordinates.length < 2)
    return coordinates || [];
  let completed = trimRouteEndpointToStationDisplay(
    coordinates,
    fromStationFeature,
    true,
  );
  completed = trimRouteEndpointToStationDisplay(
    completed,
    toStationFeature,
    false,
  );
  return completed;
}

function trimRouteEndpointToStationDisplay(
  coordinates,
  stationFeature,
  isStart,
) {
  if (!stationFeature || !Array.isArray(coordinates) || coordinates.length < 2)
    return coordinates;
  const displayCoord = getFeatureDisplayCoordinate(stationFeature);
  if (!displayCoord) return coordinates;

  const endpointIndex = isStart ? 0 : coordinates.length - 1;
  const endpoint = coordinates[endpointIndex];
  if (coordinatesClose(displayCoord, endpoint, 1.5)) return coordinates;

  const searchLimit = Math.min(12, coordinates.length - 1);
  let best = null;
  const firstSegment = isStart
    ? 0
    : Math.max(0, coordinates.length - 1 - searchLimit);
  const lastSegment = isStart ? searchLimit - 1 : coordinates.length - 2;
  for (let i = firstSegment; i <= lastSegment; i += 1) {
    const projected = projectPointToSegmentMeters(
      displayCoord,
      coordinates[i],
      coordinates[i + 1],
    );
    if (projected.t < -0.02 || projected.t > 1.02) continue;
    if (!best || projected.distance < best.distance)
      best = { ...projected, index: i };
  }

  if (best && best.distance <= 45) {
    if (isStart) {
      const tail = coordinates.slice(best.index + 1);
      return coordinatesClose(displayCoord, tail[0], 1.5)
        ? tail
        : [displayCoord, ...tail];
    }
    const head = coordinates.slice(0, best.index + 1);
    return coordinatesClose(head[head.length - 1], displayCoord, 1.5)
      ? head
      : [...head, displayCoord];
  }

  // Airport and underground stations in N02 are represented as short station
  // LineStrings. If the chosen routable endpoint is one end of that station
  // geometry, add the station display point so the visible route reaches the
  // stop marker instead of appearing to break near the terminal.
  const stationGap = distanceMeters(displayCoord, endpoint);
  if (stationGap <= STATION_SNAP_MAX_DISTANCE_METERS) {
    return isStart
      ? [displayCoord, ...coordinates]
      : [...coordinates, displayCoord];
  }
  return coordinates;
}

function coordinatesClose(a, b, toleranceMeters = 1.5) {
  return a && b && distanceMeters(a, b) <= toleranceMeters;
}

function projectPointToSegmentMeters(point, a, b) {
  const lat =
    (((Number(point[1]) + Number(a[1]) + Number(b[1])) / 3) * Math.PI) / 180;
  const metersPerLon = 111320 * Math.cos(lat);
  const metersPerLat = 110540;
  const px = Number(point[0]) * metersPerLon;
  const py = Number(point[1]) * metersPerLat;
  const ax = Number(a[0]) * metersPerLon;
  const ay = Number(a[1]) * metersPerLat;
  const bx = Number(b[0]) * metersPerLon;
  const by = Number(b[1]) * metersPerLat;
  const dx = bx - ax;
  const dy = by - ay;
  const denom = dx * dx + dy * dy;
  const t = denom > 0 ? ((px - ax) * dx + (py - ay) * dy) / denom : 0;
  const clamped = Math.max(0, Math.min(1, t));
  const qx = ax + clamped * dx;
  const qy = ay + clamped * dy;
  return {
    distance: Math.hypot(px - qx, py - qy),
    t,
  };
}

function reconstructPath(previous, sourceKey, targetKey) {
  const path = [targetKey];
  let current = targetKey;
  while (current !== sourceKey) {
    current = previous.get(current);
    if (!current) return [];
    path.push(current);
  }
  path.reverse();
  return path;
}

function normalizeGraphCoord(coord) {
  return [
    Number(Number(coord[0]).toFixed(5)),
    Number(Number(coord[1]).toFixed(5)),
  ];
}

function coordKey(coord) {
  const [lon, lat] = normalizeGraphCoord(coord);
  return `${lon},${lat}`;
}

function graphGridKey(coord, cellSize) {
  const [lon, lat] = normalizeGraphCoord(coord);
  return `${Math.floor(lon / cellSize)},${Math.floor(lat / cellSize)}`;
}

function distanceMeters(a, b) {
  const lon1 = Number(a[0]);
  const lat1 = Number(a[1]);
  const lon2 = Number(b[0]);
  const lat2 = Number(b[1]);
  const radius = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const x =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(x));
}

// =========================================================================
//  §30.  Geometry helpers & matched-route feature assembly
// =========================================================================

function iterateGeometryLines(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  if (geometry.type === "LineString")
    return [geometry.coordinates.map(normalizeGraphCoord)];
  if (geometry.type === "MultiLineString")
    return geometry.coordinates.map((line) => line.map(normalizeGraphCoord));
  if (geometry.type === "Point")
    return [[normalizeGraphCoord(geometry.coordinates)]];
  return [];
}

class MinHeap {
  constructor() {
    this.items = [];
  }
  size() {
    return this.items.length;
  }
  push(item) {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }
  pop() {
    if (this.items.length === 1) return this.items.pop();
    const top = this.items[0];
    this.items[0] = this.items.pop();
    this.bubbleDown(0);
    return top;
  }
  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= this.items[index].priority) break;
      [this.items[parent], this.items[index]] = [
        this.items[index],
        this.items[parent],
      ];
      index = parent;
    }
  }
  bubbleDown(index) {
    const length = this.items.length;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (
        left < length &&
        this.items[left].priority < this.items[smallest].priority
      )
        smallest = left;
      if (
        right < length &&
        this.items[right].priority < this.items[smallest].priority
      )
        smallest = right;
      if (smallest === index) break;
      [this.items[smallest], this.items[index]] = [
        this.items[index],
        this.items[smallest],
      ];
      index = smallest;
    }
  }
}

function getMatchedRouteFeatures(train) {
  let candidates = generateMatchedRouteFeaturesForTrain(train);

  if (!candidates.length) {
    candidates = matchedRoutesGeoJson.features
      .filter((feature) => {
        const p = feature.properties || {};
        return p.train_id === train.id && p.is_primary !== false;
      })
      .sort(
        (a, b) =>
          Number(a.properties?.segment_index ?? 0) -
          Number(b.properties?.segment_index ?? 0),
      );
  }

  if (!candidates.length) {
    const templateKey = getTrainRouteTemplateKey(train);
    if (templateKey) {
      candidates = matchedRoutesGeoJson.features
        .filter((feature) => {
          const p = feature.properties || {};
          return p.route_template_key === templateKey && p.is_primary !== false;
        })
        .sort(
          (a, b) =>
            Number(a.properties?.segment_index ?? 0) -
            Number(b.properties?.segment_index ?? 0),
        );
    }
  }

  if (!candidates.length) {
    console.warn(
      `No N02 railway route could be generated for train ${train.id}. Route will not be drawn.`,
    );
    setStatus(
      els.fieldStatus,
      "No N02 railway path could be generated from embedded N02 data. Check station codes / route_policy. No fake straight line was drawn.",
      "warn",
    );
    return [];
  }

  const routeId = candidates[0].properties?.route_id || "";
  return candidates
    .filter((feature) => (feature.properties?.route_id || "") === routeId)
    .map((feature, index) => {
      const normalized = normalizeSingleRouteGeometry(feature);
      if (!normalized) return null;
      const segmentIndex = Number(
        normalized.properties?.segment_index ?? index,
      );
      return {
        ...normalized,
        properties: {
          ...(normalized.properties || {}),
          ride_segment: isRideSegment(train, segmentIndex),
        },
      };
    })
    .filter(Boolean);
}

function isRideSegment(train, segmentIndex) {
  const stops = train.stops || [];
  // A geometry segment is ridden (shown) only when both of its endpoints are
  // effectively ridden — pass-through endpoints inherit their interval state.
  return Boolean(
    effectiveStopRide(stops, segmentIndex) &&
      effectiveStopRide(stops, segmentIndex + 1),
  );
}

function normalizeSingleRouteGeometry(feature) {
  if (!feature?.geometry) return null;
  if (feature.geometry.type === "LineString") return feature;
  if (feature.geometry.type === "MultiLineString") {
    const role = feature.properties?.geometry_role;
    if (role === "single_path_with_gaps") return feature;
    console.warn(
      "Rejected MultiLineString because it is not declared as one route with gaps.",
      feature,
    );
    return null;
  }
  console.warn(
    "Rejected matched route with unsupported geometry type.",
    feature,
  );
  return null;
}

// matched-stops features indexed by train_id (built once — the dataset is
// static after load). getStopFeature used to linear-scan ALL features for
// every stop of every train on every marker rebuild: O(trains × stops ×
// matchedStops). Scanning only the train's own few features preserves the
// exact first-match semantics at a tiny fraction of the cost.
let _matchedStopsByTrain = null;
function getMatchedStopsForTrain(trainId) {
  if (!_matchedStopsByTrain) {
    _matchedStopsByTrain = new Map();
    for (const f of matchedStopsGeoJson.features) {
      const tid = (f.properties || {}).train_id;
      if (tid == null) continue;
      let arr = _matchedStopsByTrain.get(tid);
      if (!arr) _matchedStopsByTrain.set(tid, (arr = []));
      arr.push(f);
    }
  }
  return _matchedStopsByTrain.get(trainId) || [];
}

function getStopFeature(stop, train) {
  const explicit = getMatchedStopsForTrain(train.id).find((f) => {
    const p = f.properties || {};
    return (
      p.train_id === train.id &&
      (p.n02_station_code === stopStationCode(stop) ||
        p.station === stopName(stop) ||
        p.name === stopName(stop))
    );
  });
  if (explicit) {
    return {
      ...explicit,
      properties: {
        ...(explicit.properties || {}),
        ...stop,
        name: stopName(stop),
        n02_station_code:
          stopStationCode(stop) ||
          explicit.properties?.n02_station_code ||
          null,
      },
    };
  }
  const station = resolveStationForTrain(stop, train);
  if (!station) return null;
  return {
    type: "Feature",
    properties: {
      ...stop,
      name: stopName(stop),
      n02_station_code: stopStationCode(stop) || stationCode(station),
      n02_group_code: stop.n02_group_code || stationGroupCode(station),
      train_id: train.id,
      train_type: train.train_type || "",
      company: train.company || "",
      number: train.number,
      line_name: stationLineName(station),
      operator: stationOperator(station),
      source: "station display_point",
    },
    geometry: {
      type: "Point",
      coordinates: getFeatureDisplayCoordinate(station),
    },
  };
}

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
  const weight =
    Number(train.style?.weight || DEFAULT_TRAIN_WEIGHT) * DISPLAY.routeWidthScale;
  // Unridden intervals are now hidden ENTIRELY (opacity 0), not drawn pale.
  // opacity 0 makes the GPU path drop the segment (see buildDeckRouteRecords'
  // `opacity <= 0` guard) and the SVG path render nothing. The whole-train
  // "dimmed" state (other selected date) still applies to ridden segments.
  const opacity =
    train.visible === false || !ridden
      ? 0
      : focused
        ? 1
        : dimmed
          ? DISPLAY.dimOpacity
          : DISPLAY.riddenOpacity;
  const width = focused ? weight + DISPLAY.focusBoost : weight;
  return { opacity, width };
}

// NEUTRAL station dots (railprint C4: hue is reserved for LINES). The
// actually-ridden boarding/alighting pair (ride boundary) = BLACK ink dot
// with a white ring; every other stop / pass-through station = WHITE dot
// with an ink ring. Dimming rides the alpha channel.
const RP_INK_RGB = [26, 26, 26]; // tokens.ink
const RP_WHITE_RGB = [255, 255, 255];

function stopMarkerStyleValues(
  active,
  isBoundary,
  { focused = false, dimmed = false } = {},
) {
  const baseRadius = isBoundary ? DISPLAY.terminalRadius : DISPLAY.stopRadius;
  const alpha = dimmed ? DISPLAY.dimOpacity : 1;
  return {
    radius: focused ? baseRadius + DISPLAY.focusBoost : baseRadius,
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
  const alpha = dimmed ? DISPLAY.dimOpacity : active ? 0.9 : 0.4;
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

function getFeatureDisplayCoordinate(feature) {
  const p = feature.properties || {};
  if (Array.isArray(p.display_point)) return p.display_point;
  if (feature.geometry?.type === "Point") return feature.geometry.coordinates;
  return getFeaturePathCoordinates(feature)[0];
}

function getFeaturePathCoordinates(feature) {
  if (!feature?.geometry) return [];
  if (
    feature.geometry.type === "LineString" ||
    feature.geometry.type === "Point"
  )
    return clone(feature.geometry.coordinates);
  if (feature.geometry.type === "MultiLineString")
    return feature.geometry.coordinates.flatMap((line) => line);
  return [];
}

function coordinatesEqual(a, b) {
  return (
    a && b && Number(a[0]) === Number(b[0]) && Number(a[1]) === Number(b[1])
  );
}

// =========================================================================
//  §32.  Map fit, bounds clamping & import progress UI
// =========================================================================

// Bounds over every coordinate of the given GeoJSON features (LineString /
// MultiLineString / Point), as MapLibre [[w,s],[e,n]]. null when empty.
function featureCollectionBounds(features) {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity,
    any = false;
  (features || []).forEach((feature) => {
    getFeaturePathCoordinates(feature).forEach((c) => {
      if (!Array.isArray(c) || c.length < 2) return;
      any = true;
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    });
  });
  return any
    ? [
        [w, s],
        [e, n],
      ]
    : null;
}

// Bounds over [lat,lng] point pairs (the app's legacy point order).
function latLngPointsBounds(points) {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity,
    any = false;
  (points || []).forEach((p) => {
    if (!Array.isArray(p) || p.length < 2) return;
    any = true;
    if (p[1] < w) w = p[1];
    if (p[1] > e) e = p[1];
    if (p[0] < s) s = p[0];
    if (p[0] > n) n = p[0];
  });
  return any
    ? [
        [w, s],
        [e, n],
      ]
    : null;
}

// Smoothly animate the map to [[w,s],[e,n]] bounds for focus actions.
// maxZoom follows the MapLibre zoom convention (one lower than the old
// Leaflet numbers for the same view).
function smoothFitBounds(bounds, opts) {
  if (!map || !bounds) return;
  const { maxZoom = 12, padding = 90 } = opts || {};
  map.fitBounds(bounds, {
    padding,
    maxZoom,
    duration: 800,
    essential: true,
  });
}

function fitTrainBounds(train) {
  if (!train) return;
  const features = getMatchedRouteFeatures(train);
  const bounds = featureCollectionBounds(features);
  if (bounds) {
    smoothFitBounds(bounds, { padding: 90, maxZoom: 11 });
    return;
  }
  const points = (train.stops || [])
    .map((stop) => resolveStationForTrain(stop, train))
    .filter(Boolean)
    .map(toLatLng);
  const ptBounds = latLngPointsBounds(points);
  if (ptBounds) smoothFitBounds(ptBounds, { padding: 90, maxZoom: 11 });
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
  map.fitBounds(toLngLatBounds(JAPAN_MAIN_ISLANDS_BOUNDS), {
    padding: 28,
    duration: 0,
  });
}

// Force the map to stay over Japan. minZoom is roughly whatever makes the
// full territory fit inside the central ~50% of the viewport; maxBounds stops
// panning past a padded envelope. Recomputed on resize because the fit zoom
// depends on the pixel viewport.
function applyJapanMapConstraints() {
  if (!map) return;
  const [sw, ne] = JAPAN_FULL_TERRITORY_BOUNDS; // [lat,lng] pairs
  const latPad = (ne[0] - sw[0]) * 0.5;
  const lngPad = (ne[1] - sw[1]) * 0.5;
  map.setMaxBounds([
    [sw[1] - lngPad, Math.max(-85, sw[0] - latPad)],
    [ne[1] + lngPad, Math.min(85, ne[0] + latPad)],
  ]);
  const cam = map.cameraForBounds(toLngLatBounds(JAPAN_FULL_TERRITORY_BOUNDS));
  if (!cam || !isFinite(cam.zoom)) return;
  // Fit-zoom fills the viewport; one level lower leaves the ~25% ocean margin
  // the old Leaflet half-viewport padding produced.
  const minZoom = Math.max(2, cam.zoom - 1);
  map.setMinZoom(minZoom);
  if (map.getZoom() < minZoom) map.setZoom(minZoom);
}

// =========================================================================
//  §33.  Validation (export textarea, store, branch-leak, per-train)
// =========================================================================

function validateTextareaJson() {
  try {
    const parsed = parseImportedCanonicalStore(els.importJson.value);
    const trains = parsed.trains.map(normalizeImportedTrain);

    if (!trains.length) {
      throw new Error("Imported store contains no trains.");
    }

    const nextStore = buildCanonicalTrainStore();

    // Mirror the import path: keep ONE running id set and validate each new
    // train individually, then validate the whole store once at the end.
    // The old loop rebuilt the id set AND re-validated every train added so
    // far per appended train — O(N²) full validations (each with station
    // resolution inside), freezing the UI for seconds on a large paste.
    const existingIds = new Set(nextStore.trains.map((t) => t.id));
    trains.forEach((train) => {
      train.id = makeUniqueTrainId(train.id, existingIds);
      existingIds.add(train.id);
      nextStore.trains.push(train);
    });
    validateTrainStore(nextStore);

    setStatus(
      els.importStatus,
      `JSON valid. ${trains.length} train(s) can be appended progressively.`,
      "ok",
    );
  } catch (error) {
    setStatus(els.importStatus, error.message, "err");
  }
}

function validateTrainStore(store) {
  if (!store || typeof store !== "object" || Array.isArray(store))
    throw new Error("JSON root must be an object.");
  assertOnlyKeys(store, ["schema_version", "trains"], "Store");
  if (!ACCEPTED_SCHEMA_VERSIONS.includes(store.schema_version))
    throw new Error(
      `schema_version must be one of ${ACCEPTED_SCHEMA_VERSIONS.join(", ")}.`,
    );
  if (!Array.isArray(store.trains)) throw new Error("trains must be an array.");
  const ids = new Set();
  store.trains.forEach((train, index) => validateTrain(train, index, ids));
  return true;
}

// §6.4 advisory branch-leak detection. Non-fatal (console warnings only) so
// import never fails on these, but it flags (a) route_sections that cross a
// junction / 支线分理处 without a hard line constraint, and (b) pass_through
// stops whose resolved line is on none of the adjacent sections' line_names —
// the classic "wrong branch" leak (e.g. シーサイドライナー picking up 有田 /
// 肥前浜 past 早岐). Defensive: silently returns if station data isn't loaded.
function warnBranchLeak(train) {
  try {
    if (typeof resolveStationCandidates !== "function") return;
    const stops = train.stops || [];
    const sections = Array.isArray(train.route_sections)
      ? train.route_sections
      : [];
    const linesOf = (stopLike) => {
      const set = new Set();
      (resolveStationCandidates(stopLike) || []).forEach((feature) => {
        const ln = stationLineName(feature);
        if (ln) set.add(String(ln));
      });
      return set;
    };
    sections.forEach((section, i) => {
      if (Array.isArray(section.line_names) && section.line_names.length)
        return;
      const fromLines = linesOf({
        name: section.from,
        n02_station_code: section.from_n02_station_code,
      });
      const toLines = linesOf({
        name: section.to,
        n02_station_code: section.to_n02_station_code,
      });
      if (fromLines.size > 1 || toLines.size > 1) {
        console.warn(
          `[§6.4] Train ${train.id} section ${i + 1} (${section.from}→${section.to}) crosses a junction but has no line_names; routing may leak onto the wrong branch.`,
        );
      }
    });
    stops.forEach((stop, idx) => {
      if (stop.stop_type !== "pass_through") return;
      const adjLines = new Set();
      [sections[idx - 1], sections[idx]].forEach((s) =>
        (s?.line_names || []).forEach((l) => adjLines.add(String(l))),
      );
      if (!adjLines.size) return;
      const stopLines = linesOf(stop);
      if (!stopLines.size) return;
      if (![...stopLines].some((l) => adjLines.has(l))) {
        console.warn(
          `[§6.4] Train ${train.id} pass_through "${stopName(stop)}" (lines: ${[...stopLines].join("/")}) is on none of the adjacent section line_names (${[...adjLines].join("/")}); likely wrong-branch leak.`,
        );
      }
    });
  } catch (_) {
    // Advisory only; never block import on the heuristic.
  }
}

function validateTrain(train, index, ids) {
  const prefix = `Train ${index + 1}`;
  ["id", "number", "origin", "destination"].forEach((key) => {
    if (!train[key] || typeof train[key] !== "string")
      throw new Error(`${prefix}: ${key} is required.`);
  });
  // Optional metadata: 車輛類型 / 營運公司 ("/"-separated = 直通).
  ["train_type", "company"].forEach((key) => {
    if (train[key] !== undefined && typeof train[key] !== "string")
      throw new Error(`${prefix}: ${key} must be a string when present.`);
  });
  if (ids.has(train.id))
    throw new Error(`${prefix}: duplicate id ${train.id}.`);
  ids.add(train.id);
  if (
    train.date !== undefined &&
    train.date !== UNDATED &&
    !isValidDateString(train.date)
  ) {
    throw new Error(`${prefix}: date must be "YYYY-MM-DD" or "${UNDATED}".`);
  }
  if (!Array.isArray(train.stops) || train.stops.length < 2)
    throw new Error(`${prefix}: stops must contain at least 2 rows.`);
  if (train.stops[0].departure && train.stops[0].arrival)
    throw new Error(
      `${prefix}: first stop should not need both arrival and departure.`,
    );
  const last = train.stops[train.stops.length - 1];
  if (last.departure && last.arrival)
    throw new Error(
      `${prefix}: final stop should not need both arrival and departure.`,
    );
  train.stops.forEach((stop, stopIndex) => {
    if (!stopName(stop))
      throw new Error(`${prefix} stop ${stopIndex + 1}: name is required.`);
    if (!stop.stop_type)
      throw new Error(
        `${prefix} stop ${stopIndex + 1}: stop_type is required.`,
      );
    if (typeof stop.ride_segment !== "boolean") {
      throw new Error(
        `${prefix} stop ${stopIndex + 1}: ride_segment must be boolean.`,
      );
    }
    ["arrival", "departure"].forEach((field) => {
      if (
        stop[field] !== null &&
        stop[field] !== undefined &&
        typeof stop[field] !== "string"
      ) {
        throw new Error(
          `${prefix} stop ${stopIndex + 1}: ${field} must be a string or null.`,
        );
      }
    });
  });
  if (train.route_sections) {
    if (!Array.isArray(train.route_sections))
      throw new Error(`${prefix}: route_sections must be an array.`);
    train.route_sections.forEach((section, sectionIndex) => {
      if (
        !(section.from || section.from_n02_station_code) ||
        !(section.to || section.to_n02_station_code)
      ) {
        throw new Error(
          `${prefix} route section ${sectionIndex + 1}: from/to names or N02 station codes are required.`,
        );
      }
      ["line_names", "operator_names"].forEach((field) => {
        const values = section[field] || [];
        if (
          !Array.isArray(values) ||
          values.some((value) => typeof value !== "string")
        ) {
          throw new Error(
            `${prefix} route section ${sectionIndex + 1}: ${field} must be an array of strings.`,
          );
        }
      });
    });
  }
  if (train.route_policy) {
    if (train.route_policy.mode !== "single_primary_route")
      throw new Error(
        `${prefix}: route_policy.mode must be single_primary_route.`,
      );
    if (typeof train.route_policy.jr_only !== "boolean")
      throw new Error(`${prefix}: route_policy.jr_only must be boolean.`);
    if (train.route_policy.allow_alternatives !== false)
      throw new Error(
        `${prefix}: route_policy.allow_alternatives must be false.`,
      );
    if (train.route_policy.allow_browser_straight_line_fallback !== false)
      throw new Error(
        `${prefix}: route_policy.allow_browser_straight_line_fallback must be false.`,
      );
    const allowed = train.route_policy.allowed_institution_type_codes || [];
    if (
      !Array.isArray(allowed) ||
      allowed.some((code) => !N02_INSTITUTION_TYPE_CODES.has(String(code)))
    ) {
      throw new Error(
        `${prefix}: route_policy.allowed_institution_type_codes must contain only N02_002 codes 1/2/3/4/5.`,
      );
    }
    ["preferred_line_names", "preferred_operator_names"].forEach((field) => {
      const values = train.route_policy[field] || [];
      if (
        !Array.isArray(values) ||
        values.some((value) => typeof value !== "string")
      ) {
        throw new Error(
          `${prefix}: route_policy.${field} must be an array of strings.`,
        );
      }
    });
    if (
      train.route_policy.institution_filter_mode &&
      !["soft", "hard"].includes(train.route_policy.institution_filter_mode)
    ) {
      throw new Error(
        `${prefix}: route_policy.institution_filter_mode must be soft or hard.`,
      );
    }
  }
  const color = train.style?.color;
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color))
    throw new Error(`${prefix}: style.color must be #RRGGBB.`);
  warnBranchLeak(train);
}

// =========================================================================
//  §34.  Popups & tooltips (stop / route-segment HTML)
// =========================================================================

function buildStopPopup(stopFeature, train) {
  const p = stopFeature.properties || {};
  return popupHtml(`${train.number || ""}`, [
    ["Train ID", train.id],
    ["Type / Company", trainTypeCompanyLabel(train) || "-"],
    ["Station", p.name || p.station],
    ["Arrival", p.arrival || "-"],
    ["Departure", p.departure || "-"],
    ["stop_type", p.stop_type],
    ["Normal color", p.ride_segment === true ? "Yes" : "No / pale"],
    ["N02_005c", p.n02_station_code || "-"],
    ["N02_005g", p.n02_group_code || "-"],
    ["Line", p.line_name || "-"],
    ["Operator", p.operator || "-"],
    ["Computed", p.pass_through_computed ? "Yes" : "No"],
    ["Route source", p.source || "station overlay"],
  ]);
}

function routeSectionForSegment(train, p) {
  const sections = Array.isArray(train.route_sections)
    ? train.route_sections
    : [];
  const idx = Number(p.segment_index);
  if (Number.isInteger(idx) && sections[idx]) return sections[idx];
  return sections.find((s) => s.from === p.from && s.to === p.to) || null;
}

function buildTrainSegmentPopup(train, feature) {
  const p = feature.properties || {};
  const ridden = p.ride_segment === true;
  const fromStop = (train.stops || []).find((x) => stopName(x) === p.from);
  const toStop = (train.stops || []).find((x) => stopName(x) === p.to);
  // Branch portion may run under a different number; show it for this segment.
  const section = routeSectionForSegment(train, p);
  const segNumber = (section && section.number) || train.number || "-";
  const segName = (section && section.name) || "";
  const isBranch = Boolean(
    section && section.number && section.number !== train.number,
  );
  const rows = [
    ["Train ID", train.id],
    ["車號", segNumber],
    ["Type / Company", trainTypeCompanyLabel(train) || "-"],
  ];
  if (isBranch)
    rows.push([
      "支線車號 / Branch",
      `${section.number}${segName ? "　" + segName : ""}`,
    ]);
  return popupHtml(`${segNumber} ${segName || ""}`, [
    ...rows,
    ["Segment", `${p.from || ""} → ${p.to || ""}`],
    ["Departure", (fromStop && fromStop.departure) || "-"],
    ["Arrival", (toStop && toStop.arrival) || "-"],
    ["Ride", ridden ? "Yes" : "No"],
    ["segment_index", p.segment_index ?? "-"],
    ["Route ID", p.route_id || "-"],
    ["Route choice", p.route_choice || "-"],
    ["Route source", p.source || "matched route"],
    [
      "Allowed N02_002",
      (
        p.allowed_institution_type_codes ||
        train.route_policy?.allowed_institution_type_codes ||
        []
      ).join(", ") || "-",
    ],
    ["Visible", train.visible === false ? "No" : "Yes"],
  ]);
}

function popupHtml(title, rows) {
  return `<div class="popup-title">${escapeHtml(title)}</div><div class="popup-grid">${rows
    .map(
      ([key, value]) =>
        `<span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong>`,
    )
    .join("")}</div>`;
}

// =========================================================================
//  §35.  Misc utilities (status line, color, portable HTML, download, HTML escaping)
// =========================================================================

function setStatus(el, message, type) {
  el.textContent = message;
  el.className = `status ${type || ""}`;
}

function normalizeColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(value || "") ? value : DEFAULT_TRAIN_COLOR;
}

function buildPortableHtml() {
  // Snapshot of the live DOM. (The old embedded-data branch targeted a
  // #data-default-trains node that no longer exists in index.html; the
  // snapshot still references relative vendor/app.js//api URLs, so it is a
  // same-folder snapshot rather than a truly standalone file.)
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
// (end of app.js)
