// =========================================================================
//  app-config.js — §1–2: performance instrumentation + app-wide constants (schema, storage keys, map bounds, style defaults)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

const LOCAL_JSON_FILENAME = "n02-train-store.json";
// Country-scoped export filename (Japan keeps the historical name), so a saved
// Taiwan store can never be mistaken for — or overwrite — a Japan export.
function countryLocalJsonFilename() {
  return typeof activeCountry !== "undefined" && activeCountry !== "jp"
    ? `n02-train-store-${activeCountry}.json`
    : LOCAL_JSON_FILENAME;
}

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
//
// Countries keep FULLY SEPARATE stores (separate server file + endpoint,
// separate IndexedDB databases) and the UI shows one country at a time.
// TRAIN_STORE_API therefore always names the ACTIVE country's endpoint.
// apiResourceUrl() applies the active deployment's configured file suffix.
// Japan keeps the historical unsuffixed names so existing data stays
// reachable.
let TRAIN_STORE_API = "train-store";
const COUNTRY_STORAGE_KEY = "n02-active-country";
const SUPPORTED_COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];
let activeCountry = "jp";
// Every per-country resource name flows through AppCore.countrySuffixed
// (Japan keeps the historical unsuffixed name, others get "-{country}") —
// one spelling of the rule instead of a hardcoded ternary per mapper.
function trainStoreApiForCountry(country) {
  return AppCore.countrySuffixed("train-store", country);
}
function railPackageUrlForCountry(country) {
  return `./rail/${country}-2025.json`;
}
function stationReadingsApiForCountry(country) {
  return AppCore.countrySuffixed("station-readings", country);
}
// Solver + statistics geometry, one FULLY SEPARATE pair per country. The two
// pairs answer the same schema (line_name / operator / institution_type_code /
// railway_class_code on sections; station_name / n02_station_code /
// n02_group_code / display_point on stations — Japan writes the N02_* spelling
// of it), so every consumer stays country-generic and only the choice of file
// differs. They are never loaded together: same-named stations exist in both
// countries (松山, 板橋, 岡山 …), so a mixed graph could route a Taiwanese
// train onto Japanese track.
function railSectionsApiForCountry(country) {
  return AppCore.countrySuffixed("rail-sections", country);
}
function stationsApiForCountry(country) {
  return AppCore.countrySuffixed("stations", country);
}
function activeRailPackageUrl() {
  return railPackageUrlForCountry(activeCountry);
}
// Resolve the persisted country BEFORE any store/IndexedDB access (called at
// the top of boot). Guarded so the precompute sandbox stub is enough.
function loadActiveCountry() {
  try {
    const saved = localStorage.getItem(COUNTRY_STORAGE_KEY);
    if (SUPPORTED_COUNTRIES.includes(saved)) activeCountry = saved;
  } catch (_) {
    /* localStorage unavailable: stay on the default country */
  }
  TRAIN_STORE_API = trainStoreApiForCountry(activeCountry);
  if (window.I18N && typeof I18N.setCountry === "function") {
    I18N.setCountry(activeCountry);
    // i18n's own DOMContentLoaded pass has already run by now (its listener
    // registers first), so a non-default country must re-resolve the
    // country-variant strings (app.title.tw, ph.trainType.tw …).
    if (activeCountry !== "jp" && typeof I18N.applyStatic === "function")
      I18N.applyStatic(document);
  }
}
// Elements tagged data-country="jp"/"tw" (attribution articles, the N02 stats
// hint, the kana toggle …) only apply to one dataset; hide the rest. Runs at
// boot and again on every country switch (updateDataSourceUi).
function applyCountryVisibility(root) {
  const scope = root || document;
  scope.querySelectorAll("[data-country]").forEach((el) => {
    el.hidden = el.getAttribute("data-country") !== activeCountry;
  });
}
// Country-scoped IndexedDB database name (user store, pending-save journal,
// local-file handles). Japan keeps the historical unsuffixed names.
function countryDbName(base) {
  return AppCore.countrySuffixed(base, activeCountry);
}
// Does the ACTIVE country ship a solver dataset pair? Both supported
// countries now do (railSectionsApiForCountry), so the in-browser solver and
// the mileage statistics built on the same graph run for either — each on its
// own country's files, never on a mixture. A country added without datasets
// must return false here: its cache misses then stay misses instead of
// solving foreign stops against another country's network, where a same-named
// station (松山, 板橋, 岡山 …) would let a "successful" solve draw the train
// in the wrong country.
function activeCountryHasRouteSolver() {
  return SUPPORTED_COUNTRIES.includes(activeCountry);
}
// Static (GitHub Pages) deploy: api/sample-data/ holds the published SAMPLE
// dataset — a manifest (with a per-date index) plus one part file per train.
// It is read-only demo content: the user's own data never touches it. User
// data on the static deploy is persisted in IndexedDB instead (see
// USER_STORE_DB_NAME below), chunked ONE RECORD PER CALENDAR DAY so each edit
// rewrites only the day(s) it touched, never one monolithic blob.
//
// Each country has a FULLY SEPARATE sample dataset (like everything else about
// its data): Japan keeps the historical unsuffixed api/sample-data/, Taiwan
// publishes api/sample-data-tw/ (npm run precompute:tw). The 資料 card shows
// only the ACTIVE country's loaders.
const SAMPLE_DATA_API = "sample-data";
const COUNTRY_SAMPLE_DATA_APIS = {
  jp: SAMPLE_DATA_API,
  tw: "sample-data-tw",
  hk: "sample-data-hk",
  mo: "sample-data-mo",
  kr: "sample-data-kr",
};
const NEW_YEAR_GRAND_LOOP_API = "new-year-grand-loop-data";
const TOKYO_LIMITED_EXPRESS_LOOP_API = "tokyo-limited-express-loop-data";
const USER_STORE_DB_NAME = "n02-user-train-store-db";
const USER_STORE_DATES_STORE = "dates";
const USER_STORE_META_STORE = "meta";
const USER_STORE_META_KEY = "meta";
const SERVER_AUTOSAVE_DEBOUNCE_MS = 450;
// Before a backend PUT, keep one browser-local recovery copy per tab. A
// visibility-change flush may be terminated with the page, and fetch
// keepalive cannot carry stores above its 64 KiB body budget.
const PENDING_SERVER_STORE_DB_NAME = "n02-pending-server-train-store-db";
const PENDING_SERVER_STORE_NAME = "pending";
const FILE_HANDLE_DB_NAME = "n02-train-store-file-handle-db";
const FILE_HANDLE_STORE_NAME = "handles";
const FILE_HANDLE_KEY = "local-json-file-handle";
const ROUTE_CACHE_DB_NAME = "n02-route-geometry-cache";
const ROUTE_CACHE_STORE_NAME = "routes";
// Bump whenever route-solver semantics change. The value is part of every
// route cache key, so geometry produced by an older solver can never shadow a
// corrected precomputed sample route after a deployment.
// 15: route_id / route_template_key now carry a digest of their key instead
// of the key itself, so entries persisted by 14 would compare unequal against
// a freshly built template key and silently miss the matched-routes fallback.
// 16: adjacent Taiwan sections reuse the exact groomed rail-package interval
// instead of graph-shortcutting switchbacks (and preserve ordered retraces).
// 17: consecutive Japan sections that share an explicit station are stitched
// across large N02 station throats, preventing stale discontinuous geometry.
const ROUTE_SOLVER_CACHE_VERSION = "17";
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
// Taiwan overview (main island) and pan-clamp territory (incl. Penghu).
const TAIWAN_MAIN_ISLAND_BOUNDS = [
  [21.85, 119.9],
  [25.35, 122.05],
];
const TAIWAN_FULL_TERRITORY_BOUNDS = [
  [21.6, 119.2],
  [25.5, 122.1],
];
const HONG_KONG_BOUNDS = [
  [22.14, 113.82],
  [22.58, 114.45],
];
const MACAO_BOUNDS = [
  [22.1, 113.52],
  [22.23, 113.61],
];
// South Korea: the overview frames the mainland network (목포/부산 up to
// 도라산 on the 경의선), the territory clamp adds Jeju and the offshore margin.
const KOREA_MAINLAND_BOUNDS = [
  [34.2, 125.8],
  [38.4, 129.6],
];
const KOREA_FULL_TERRITORY_BOUNDS = [
  [33.0, 124.5],
  [38.7, 131.1],
];
const COUNTRY_OVERVIEW_BOUNDS = {
  jp: JAPAN_MAIN_ISLANDS_BOUNDS,
  tw: TAIWAN_MAIN_ISLAND_BOUNDS,
  hk: HONG_KONG_BOUNDS,
  mo: MACAO_BOUNDS,
  kr: KOREA_MAINLAND_BOUNDS,
};
const COUNTRY_TERRITORY_BOUNDS = {
  jp: JAPAN_FULL_TERRITORY_BOUNDS,
  tw: TAIWAN_FULL_TERRITORY_BOUNDS,
  hk: HONG_KONG_BOUNDS,
  mo: MACAO_BOUNDS,
  kr: KOREA_FULL_TERRITORY_BOUNDS,
};
// The map frames / clamps to the ACTIVE country (see loadActiveCountry).
function activeCountryOverviewBounds() {
  return COUNTRY_OVERVIEW_BOUNDS[activeCountry] || JAPAN_MAIN_ISLANDS_BOUNDS;
}
function activeCountryTerritoryBounds() {
  return COUNTRY_TERRITORY_BOUNDS[activeCountry] || JAPAN_FULL_TERRITORY_BOUNDS;
}

// Protocol/schema constants: AppCore (app-core.js, shared with the Node
// server backstop) is the single source of truth; re-exported here as the
// bare globals the app family reads. ACCEPTED_SCHEMA_VERSIONS is frozen.
const SCHEMA_VERSION = window.AppCore.SCHEMA_VERSION;
const ACCEPTED_SCHEMA_VERSIONS = window.AppCore.ACCEPTED_SCHEMA_VERSIONS;
// Train ids flow into route_id, route cache keys and DOM ids, so they are
// restricted to the charset documented in jsonspec §3.2.
const TRAIN_ID_PATTERN = window.AppCore.TRAIN_ID_PATTERN;
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
const UNDATED = window.AppCore.UNDATED;
const {
  addDaysToDateString,
  compareTrainsByDateAndDeparture,
  dateSortKey,
  dayIndexForSegment,
  getTrainDepartureMinutes,
  isValidDateString,
  makeUniqueTrainId,
  normalizeDateString,
  normalizeNullableTime,
  normalizeTrainDate,
  parseFeatureCollectionChunked: parseFeatureCollectionTextChunked,
  parseTimeToMinutes,
  trainDayBreaks,
  trainHasCrossDayTimes,
} = window.AppCore;
const DEFAULT_TRAIN_COLOR = "#d9364f";
// Single source of truth for the default route style numbers (railprint's
// glowing-line spec: ridden lines draw from a 2px base, zoom-scaled).
// Halved from 4 on 2026-08-20 together with the network stroke it is drawn
// over (railmap-style.js RAILWAY_STYLE): a ride reads as a ride because it is
// heavier than the field beneath it, and that is a RATIO — one of the two
// halving alone would either bury the ride or leave it a ribbon over a thread.
// The dash rhythm in railmap-style.js keys off this number too.
const DEFAULT_TRAIN_WEIGHT = 2;

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
