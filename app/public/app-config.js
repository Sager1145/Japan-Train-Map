// =========================================================================
//  app-config.js — §1–2: performance instrumentation + app-wide constants (schema, storage keys, map bounds, style defaults)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
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
// Static (GitHub Pages) deploy: api/sample-data/ holds the published SAMPLE
// dataset — a manifest (with a per-date index) plus one part file per train.
// It is read-only demo content: the user's own data never touches it. User
// data on the static deploy is persisted in IndexedDB instead (see
// USER_STORE_DB_NAME below), chunked ONE RECORD PER CALENDAR DAY so each edit
// rewrites only the day(s) it touched, never one monolithic blob.
const SAMPLE_DATA_API = "sample-data";
const USER_STORE_DB_NAME = "n02-user-train-store-db";
const USER_STORE_DATES_STORE = "dates";
const USER_STORE_META_STORE = "meta";
const USER_STORE_META_KEY = "meta";
const SERVER_AUTOSAVE_DEBOUNCE_MS = 450;
const FILE_HANDLE_DB_NAME = "n02-train-store-file-handle-db";
const FILE_HANDLE_STORE_NAME = "handles";
const FILE_HANDLE_KEY = "local-json-file-handle";
const ROUTE_CACHE_DB_NAME = "n02-route-geometry-cache";
const ROUTE_CACHE_STORE_NAME = "routes";
// Bump whenever route-solver semantics change. The value is part of every
// route cache key, so geometry produced by an older solver can never shadow a
// corrected precomputed sample route after a deployment.
const ROUTE_SOLVER_CACHE_VERSION = "2";
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
const SCHEMA_VERSION = "1.3";
const ACCEPTED_SCHEMA_VERSIONS = ["1.3"];
// Train ids flow into route_id, route cache keys and DOM ids, so they are
// restricted to the charset documented in jsonspec §3.2.
const TRAIN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
// The five stop_type values of jsonspec §7.2, in the order the editor's
// <select> lists them (running order, not the spec's table order). Doubles as
// the import-side whitelist.
const STOP_TYPES = [
  "origin",
  "passenger_stop",
  "pass_through",
  "operational_stop",
  "destination",
];
// Sentinel selectedDate value: show the combined "all trains" list.
const ALL_DATES = "__all__";
// Bucket for trains whose date could neither be supplied nor inferred.
const UNDATED = "undated";
const {
  compareTrainsByDateAndDeparture,
  dateSortKey,
  getTrainDepartureMinutes,
  inferDateFromTrainId,
  isValidDateString,
  makeUniqueTrainId,
  normalizeDateString,
  normalizeNullableTime,
  normalizeTrainDate,
  parseFeatureCollectionChunked: parseFeatureCollectionTextChunked,
  parseTimeToMinutes,
} = window.AppCore;
const DEFAULT_TRAIN_COLOR = "#d9364f";
// Single source of truth for the default route style numbers (railprint's
// glowing-line spec: ridden lines draw from a 4px base, zoom-scaled).
const DEFAULT_TRAIN_WEIGHT = 4;

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
