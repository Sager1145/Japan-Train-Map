// =========================================================================
//  app.js — N02 Limited Express Train Manager (frontend entry spine)
//
//  The frontend is a family of plain classic scripts (no ES modules, no
//  bundler) that share ONE global lexical scope — the architecture the
//  precompute exporter (scripts/precompute-train-parts.mjs) relies on to
//  reach top-level bindings inside its Node vm sandbox. index.html loads
//  the family in this exact order (§N = section of the old monolith):
//
//   app-core.js              shared pure helpers (UMD; also used by tests)
//   i18n-strings.js          I18NStrings global: UI string catalogs
//   i18n.js                  I18N global: i18n runtime + place-name glosses
//   rail-network.js          RailNetwork global: N02 network package
//   railmap-*.js + railmap.js  RailMap global: MapLibre map core (railprint;
//                            its own module map lives in railmap.js's header)
//   app-config.js            §1–2   perf instrumentation + app constants
//   app-display-settings.js  §3     display-tuning settings & panel
//   app-display-features.js  §4     basemap opacity, endpoint labels,
//                                   deck hover/tooltip
//   app-route-simplify.js    §5     Douglas-Peucker pre-render decimation
//   app-dates.js             §6     date grouping/sorting + UI date state
//   app.js  (this file)      §7–10  API client & HAS_BACKEND flag, core
//                                   mutable state & DOM refs, boot
//                                   sequence, SSE live refresh + prebuild
//   app-stations.js          §11    station resolution & data accessors
//   app-persistence.js       §12–15 server autosave, file handles, user
//                                   IndexedDB store, route-geometry
//                                   cache, local JSON open/save
//   app-import.js            §16    progressive load / import engine
//   app-store-ops.js         §17–20 train CRUD, canonical export, import
//                                   parsing, blank-train factory
//   app-map-init.js          §21    MapLibre map initialization
//   app-events.js            §22    sidebar / editor / map event binding
//   app-stats.js             §23a   mileage statistics (N02 coverage)
//   app-render.js            §23b   render orchestration, date bar,
//                                   train list
//   app-editor.js            §24    editor panel & stops table
//   app-route-render.js      §25    route rebuild & layer/marker render
//   app-overlap-lanes.js     §26a   overlap lanes, corridor chains &
//                                   curve smoothing
//   app-deck-records.js      §26b   overlap map + deck record builders
//   app-route-graph.js       §27–28 template keys, route caches, graph
//                                   construction & spatial index
//   app-route-solver.js      §29    institution rules, hints & Dijkstra
//   app-route-features.js    §30    geometry helpers & matched-route
//                                   feature assembly
//   app-style.js             §31    visual styling (single source of
//                                   truth) & render primitives
//   app-map-fit.js           §32    map fit, bounds clamp & import
//                                   progress UI
//   app-validation.js        §33    validation (store / trains / JSON)
//   app-ui-utils.js          §34–35 popups & tooltips + misc utilities
//
//  DEPLOY CONTRACT (scripts/build-static-site.mjs): the static build
//  rewrites `const HAS_BACKEND = true;` in THIS file (and fails the build
//  if it goes missing), and appends `.json` to the ${API_BASE} fetch
//  templates in every app*.js file it stages.
// =========================================================================

// =========================================================================
//  §7.  Backend API client & app-data loading
// =========================================================================

// Document-relative (not root-absolute) so every API call — including the
// train-store save/load — resolves next to index.html. This keeps the app
// working when it is served from a sub-path (e.g. behind a reverse proxy at
// /something/) instead of only from the domain root.
const API_BASE = "./api";
// True on the Node/Express deployment, whose backend answers the write/live
// endpoints — /api/events (SSE live-refresh) and PUT/DELETE /api/train-store
// (server autosave / clear). The GitHub Pages STATIC build has no backend, so
// the deploy workflow rewrites this line to `false`; the app then skips those
// backend-only calls instead of firing requests that 404 on a static host. The
// read-only dataset/seed GETs (fetchJson, loadTrainStoreFromServer) are served
// as plain files on Pages and stay enabled either way. Local-file save/load via
// the File System Access API is independent of this flag.
const HAS_BACKEND = true;
// A per-tab id sent with every store write (X-Client-Id). The server echoes it
// in the SSE "store-changed" event so this tab can ignore the write it just
// made and only react to changes from *other* sources (another tab, or an AI
// agent calling /api/agent/import).
const CLIENT_ID =
  (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
  `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const fetchJson = async (path, options) => {
  // Use the browser's default HTTP cache. The server sends a weak ETag +
  // Cache-Control: max-age on every dataset, so reloads revalidate to a 304 (or
  // serve straight from cache within max-age) instead of re-downloading the full
  // multi-MB payload. The old `cache: "no-store"` defeated all of that.
  const res = await fetch(`${API_BASE}/${path}`, options);
  if (!res.ok)
    throw new Error(`Failed to load ${path}: ${res.status} ${res.statusText}`);
  return res.json();
};
// Same request semantics as fetchJson but returns the raw text WITHOUT the
// atomic native JSON.parse. Used for rail-sections so its ~1.1 s parse can be
// deferred and chunked (see parseFeatureCollectionChunked / ensureRailSectionsLoaded)
// instead of blocking the main thread the instant the 12 MB body arrives.
const fetchText = async (path) => {
  const res = await fetch(`${API_BASE}/${path}`);
  if (!res.ok)
    throw new Error(`Failed to load ${path}: ${res.status} ${res.statusText}`);
  return res.text();
};

// Data is now served by the backend instead of being embedded in the page.
let railSectionsGeoJson,
  stationsGeoJson,
  defaultTrainStore,
  matchedRoutesGeoJson,
  matchedStopsGeoJson;
let stationCandidatesIndex;
// N02_005c -> N02_005 station name. The station name is a per-station constant
// (see jsonspec §13.4): it is kept ONCE on each stop, and route_sections carry
// only codes — their from/to names are resolved from this map on load and
// stripped from the persisted/exported JSON so the archive doesn't repeat every
// station name in both the stops and the sections.
let stationNameByCode = new Map();
function stationNameForCode(code) {
  return (code && stationNameByCode.get(String(code))) || "";
}
// Tracks the in-flight (or resolved) rail-sections fetch. rail-sections.json is
// ~12 MB raw / 2.4 MB gzipped and is consumed ONLY by the route solver, which
// runs after the map is already on screen — so it is fetched in parallel with
// boot but never blocks first paint. ensureRailSectionsLoaded() awaits it right
// before the first solve.
let railSectionsReady = null;
// The boot DOWNLOAD of rail-sections (response.text(), no JSON.parse). Kept
// separate from railSectionsReady (the parse pipeline) so the ~1.1 s parse can
// be deferred off the first-paint path and run in yielding chunks later.
let railSectionsTextReady = null;

async function loadAppData() {
  // Kick off the big solver-only dataset immediately, but only DOWNLOAD it here
  // (response.text(), no JSON.parse) so its ~1.1 s parse never blocks boot or
  // first paint. ensureRailSectionsLoaded() parses it in yielding chunks after
  // the map is on screen, right before the first solve.
  railSectionsTextReady = fetchText("rail-sections");

  // Station readings (kana + romaji) keyed by N02 station code. Small file; we
  // kick it off in parallel and inject it into the i18n layer once loaded so
  // placeName() can annotate 東京（とうきょう）/ Tōkyō by station id. Non-fatal:
  // on failure the service-name dictionaries still cover any inline fallback.
  const stationReadingsReady = fetchJson("station-readings").catch((err) => {
    console.warn(
      "station-readings load failed; station kana/romaji unavailable.",
      err,
    );
    return null;
  });

  // `stations` (3.3 MB / 456 KB gz) feeds the marker/station-resolution paths
  // used by the very first render, so it blocks first paint — but its native
  // JSON.parse is a single ~100-250 ms long task on iPhone Safari, the largest
  // blocking parse left in the render path. DOWNLOAD it as text in parallel with
  // the small datasets, then parse it in yielding chunks (same path as
  // rail-sections) so it interleaves with paint/input instead of freezing.
  const stationsTextReady = fetchText("stations");
  [defaultTrainStore, matchedRoutesGeoJson, matchedStopsGeoJson] =
    await Promise.all([
      fetchJson("default-trains"),
      fetchJson("matched-routes"),
      fetchJson("matched-stops"),
    ]);
  stationsGeoJson = await parseFeatureCollectionChunked(await stationsTextReady);

  // Build the two station-resolution indexes in ~12 ms slices so this no
  // longer lands as one long synchronous task at the tail of boot Block 1
  // (right after the chunked parse of stations). Still awaited here, so every
  // downstream consumer (the first route solve, later imports, SSE reloads)
  // sees a fully-built index exactly as before; the produced index contents are
  // byte-for-byte identical to the old synchronous passes.
  await buildStationIndexesSliced(stationsGeoJson);

  const stationReadings = await stationReadingsReady;
  if (stationReadings && window.I18N && I18N.setStationReadings)
    I18N.setStationReadings(stationReadings);

  // Surface a rail-sections DOWNLOAD failure instead of leaving an unhandled
  // rejection; ensureRailSectionsLoaded() re-fetches on demand before the first
  // solve.
  railSectionsTextReady.catch((err) =>
    console.error(
      "rail-sections download failed during boot; will retry before first route solve.",
      err,
    ),
  );
}

// Guarantee the rail-sections dataset is present before any route solve. Awaits
// the background boot fetch; retries once if that fetch failed. Cheap and
// idempotent once the data is resident.
// Parse a large GeoJSON FeatureCollection WITHOUT one atomic multi-hundred-ms
// JSON.parse (rail-sections ~12 MB, stations ~3.3 MB). We locate the top-level
// "features" array and JSON.parse each feature object on its own, yielding to
// the event loop every few ms. Each per-feature parse is tiny, so the work
// becomes many short tasks the browser can interleave with paint/input instead
// of a single main-thread freeze. Only ".features" is read from either dataset
// (verified), so the rebuilt {type, features} is behaviourally identical to
// res.json() (top-level name/crs, which nothing consumes, are dropped). Falls
// back to a native parse if the shape is unexpected. Each feature is still
// parsed by native JSON.parse, so the feature objects are byte-for-byte
// identical to the old path.
async function parseFeatureCollectionChunked(text) {
  return parseFeatureCollectionTextChunked(text, {
    now: () => performance.now(),
    yieldControl: _statsYield,
  });
}

async function ensureRailSectionsLoaded() {
  if (railSectionsGeoJson) return railSectionsGeoJson;
  if (!railSectionsReady) {
    railSectionsReady = (async () => {
      // Reuse the in-flight/finished boot download; re-fetch once on failure.
      let text;
      try {
        text = await (railSectionsTextReady ||
          (railSectionsTextReady = fetchText("rail-sections")));
      } catch (err) {
        railSectionsTextReady = fetchText("rail-sections");
        text = await railSectionsTextReady;
      }
      const data = await parseFeatureCollectionChunked(text);
      railSectionsGeoJson = data;
      // Release the raw ~12 MB JSON string (≈24 MB as a JS string): the memoised
      // download promise would otherwise keep it resident for the whole session,
      // which matters on memory-tight iPhones.
      railSectionsTextReady = null;
      return data;
    })();
    // On any failure clear the memo so a later call retries cleanly.
    railSectionsReady.catch(() => {
      railSectionsReady = null;
    });
  }
  return railSectionsReady;
}

// One-time gate for everything the route SOLVER needs beyond the render path:
// the parsed rail-sections dataset plus the persisted route-geometry cache
// (IndexedDB). Boot no longer awaits either — on a static deploy every train
// ships with precomputed geometry (see sample-data parts below), so the solver may
// never run at all. The first genuine cache MISS awaits this instead, paying
// the one-time load exactly when it is needed. Memoised; cleared on failure so
// a later solve retries cleanly.
let solverReadyPromise = null;
function ensureSolverReady() {
  if (!solverReadyPromise) {
    solverReadyPromise = (async () => {
      await ensureRailSectionsLoaded();
      await warmRouteCacheFromIndexedDb();
    })();
    solverReadyPromise.catch(() => {
      solverReadyPromise = null;
    });
  }
  return solverReadyPromise;
}

// Render-path helper: a synchronous render found a train with no cached route
// while rail-sections are still loading. Kick the solver warm-up and repaint
// once, so the missing line appears without user interaction — and WITHOUT
// running (or negative-caching!) a solve on data that isn't there yet.
let solverRenderKickPending = false;
function requestSolverThenRerender() {
  if (solverRenderKickPending) return;
  solverRenderKickPending = true;
  ensureSolverReady()
    .then(() => {
      solverRenderKickPending = false;
      renderTrainLayers();
    })
    .catch(() => {
      solverRenderKickPending = false;
    });
}

// Set while a SINGLE train's route is being solved (sync or the async queue
// below). It lifts the regional-graph cache to the larger transient budget for
// the duration so a multi-region train doesn't evict-then-rebuild its own
// regions mid-solve (see getRegionalRouteGraph).
let _solveInProgress = false;

// Off-thread solve queue. A cold route solve builds ~0.4 s regional graphs per
// region — running it synchronously on a click/render froze the tab for ~2 s
// ("selecting a rail is slow"). Instead we enqueue the train, solve it in the
// background one section at a time (yielding to paint/input between sections),
// and repaint once its geometry is cached. The train draws a beat later rather
// than hanging the UI — the same deal the progressive import already makes.
const _pendingRouteSolves = new Set();
let _routeSolveDraining = false;
async function drainPendingRouteSolves() {
  if (_routeSolveDraining) return;
  _routeSolveDraining = true;
  _solveInProgress = true;
  try {
    let frameStart = performance.now();
    const yieldIfNeeded = async () => {
      if (performance.now() - frameStart < 12) return;
      await waitForImportPaint();
      frameStart = performance.now();
    };
    while (_pendingRouteSolves.size) {
      const id = _pendingRouteSolves.values().next().value;
      _pendingRouteSolves.delete(id);
      const train = getTrain(id);
      if (!train) continue;
      try {
        await warmRouteCacheForTrainStreaming(train, { yieldIfNeeded });
        // Draw it incrementally as soon as it's solved (invalidates the
        // signature-cached route items — which are geometry-independent — so the
        // freshly-solved geometry is actually picked up) and shows progressively
        // instead of all-at-once at the end.
        appendTrainToLayers(train);
      } catch (err) {
        console.warn(`Background route solve failed for ${id}.`, err);
      }
    }
  } finally {
    _solveInProgress = false;
    trimRegionalGraphCache(REGIONAL_GRAPH_NODE_BUDGET);
    _routeSolveDraining = false;
    // Repaint so the freshly-cached routes appear; markers follow the same
    // signature so this is a cheap cache-hit render.
    renderTrainLayers();
  }
}
function requestTrainRouteSolve(train) {
  if (!train || _pendingRouteSolves.has(train.id)) return;
  _pendingRouteSolves.add(train.id);
  drainPendingRouteSolves();
}
// =========================================================================
//  §8.  Core mutable state & cached DOM element references
// =========================================================================

let trainStore = { schema_version: SCHEMA_VERSION, trains: [] };
let selectedTrainId = null;
let focusedTrainId = null;
// Live maplibregl.Marker instances for the on-map origin/destination labels.
let endpointLabelMarkers = new Map(); // label key -> { marker, el, anchor, fadeTimer }
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
// Intermediate stop dots thin out next on the way out: below this zoom the
// stopping-station dots (their black centers included) stop drawing too, so a
// zoomed-out national view keeps only the route lines and terminal markers.
// Must stay strictly BELOW PASSTHROUGH_MIN_ZOOM (stops outlive pass-throughs
// while zooming out). Unlike the pass LOD this can't be a layer minzoom —
// terminals share the stops layers and are never hidden — so RailMap rebuilds
// the stops filters when the view crosses this threshold (never on pan, and a
// no-op float compare on other zoom frames).
const STOP_MIN_ZOOM = 7;
let cachedOrderedTrains = [];
let importInProgress = false;

// --- Data-source mode -------------------------------------------------------
// What the store on screen IS, and therefore whether edits persist:
//   "user"          user's own data — autosaved (server on Node, IndexedDB on
//                   the static deploy).
//   "sample-single" one random sample day (static deploy boot with no user
//                   data). Ephemeral: nothing persists.
//   "sample-all"    the full sample, loaded on explicit request. Ephemeral.
//   "sample-new-year-grand-loop" the independent New Year grand-loop sample.
//   "sample-tokyo-limited-express-loop" the independent Tokyo ltd-exp loop.
// The Node deployment always runs in "user" mode. Sample modes never write to
// the user's IndexedDB store — the user's saved data survives untouched and
// can be brought back with the "restore my data" button.
let dataSourceMode = "user";
let sampleModeDate = null; // the day shown while in "sample-single"
let userStoreAvailable = false; // last known "IndexedDB holds user data" state
let sampleEditHintShown = false; // one hint per sample session, not per edit
function isSampleMode() {
  return (
    dataSourceMode === "sample-single" ||
    dataSourceMode === "sample-all" ||
    dataSourceMode === "sample-new-year-grand-loop" ||
    dataSourceMode === "sample-tokyo-limited-express-loop"
  );
}

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
  toggleFocusZoom: document.getElementById("toggle-focus-zoom"),
};

// =========================================================================
//  §9.  Boot sequence (runs once on DOMContentLoaded)
// =========================================================================

document.addEventListener("DOMContentLoaded", async () => {
  installLongTaskObserver();
  // Resolve the active country FIRST: it decides which server endpoint and
  // which IndexedDB databases every later step talks to.
  loadActiveCountry();
  setupCountrySelect();
  // Seed the display-tuning knobs from localStorage before the first render so
  // the user's saved line widths / sizes / opacities apply on load.
  loadDisplaySettings();
  applyUiMode({ persist: false });
  setupUiModeSelect();
  await applyDisplayTheme({ updateMap: false, persist: false });
  setupThemeSelect();
  const followSystemTheme = () => {
    if (DISPLAY.theme === "system") applyDisplayTheme({ persist: false });
  };
  if (typeof THEME_MEDIA.addEventListener === "function")
    THEME_MEDIA.addEventListener("change", followSystemTheme);
  else if (typeof THEME_MEDIA.addListener === "function")
    THEME_MEDIA.addListener(followSystemTheme);
  applyPendingFitCurveSettings();
  // Start the map's own downloads (vendored basemap style + the 9.2 MB rail
  // network package) IMMEDIATELY, in parallel with the /api datasets below.
  // Previously initMap() kicked these off only after loadAppData() had fully
  // downloaded AND parsed stations/default-trains/matched-* — serializing the
  // two multi-MB waterfalls and delaying first map paint by the whole first
  // phase. Both loaders resolve null on failure (never throw).
  const initialMapTheme = resolveDisplayTheme();
  const alternateMapTheme = initialMapTheme === "dark" ? "light" : "dark";
  const mapAssetsReady = Promise.all([
    RailMap.loadBasemap(initialMapTheme),
    RailMap.loadBasemap(alternateMapTheme),
    // The 9.2 MB national-network package is HIDDEN by default (opt-in via the
    // 全部鐵路線 layer toggle). Deferred out of boot: RailMap.ensureNetwork()
    // fetches + builds + setData's it lazily the first time the user enables
    // that toggle, so its parse/build/upload never blocks first map paint.
    Promise.resolve(null),
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
  restoreUiDateState();
  await initMap(mapAssetsReady);
  applyMapOpacity();
  bindEvents();
  fitActiveCountryOverview();
  renderAll();

  // The train load no longer waits for the 12 MB rail-sections parse or the
  // IndexedDB route-cache warm-up: on a static deploy every train arrives with
  // its geometry precomputed (sample-data parts / stored user routes), and on the Node deployment the
  // first cache MISS awaits ensureSolverReady() itself. Trains therefore start
  // appearing right after the map paints.
  const bootLoadOptions = {
    persistEachStep: false,
    finalPersist: false,
    // No date is auto-selected once the load finishes: a returning user keeps
    // their restored selection if it is still valid, and a first run stays on
    // the combined "全部" view rather than jumping to one day of the data.
    // A freshly opened page starts as an overview. The user can choose a
    // train deliberately instead of the progressive loader selecting one.
    selectFirstTrain: false,
  };
  await loadActiveCountryStore(bootLoadOptions);

  // Warm the solver stack in the background — rail-sections, the persisted
  // route-geometry cache and the lightweight spatial index — so the first
  // edit / local JSON open doesn't pay those one-time costs synchronously.
  //
  // ONLY on the Node backend, where routes are solved on the client. On the
  // static/parts deploy (the memory-tight iPhone target) every train boots with
  // its geometry precomputed, so the solver is never touched unless a stale part
  // misses the cache — and warmRouteCacheForTrainStreaming() awaits
  // ensureSolverReady() itself at that point. Eagerly parsing the 12 MB
  // rail-sections + hashing ~405k coordinates on boot there was pure memory/CPU
  // pressure during the load window the parts system exists to protect. The
  // mileage-stats panel lazy-loads rail-sections on first open (see
  // runMileageStatsJob), so nothing else needs this eager warm-up either.
  // The solver's datasets are Japan-only; when another country is active the
  // solver can never run (prepareTrainRouteSolve gates it), so warming the
  // 12 MB rail-sections here would be pure wasted download + memory.
  if (HAS_BACKEND && activeCountryHasRouteSolver()) {
    ensureSolverReady()
      .then(() => scheduleRouteGraphPrebuild())
      .catch((err) =>
        console.warn(
          "Background solver warm-up failed; it will retry before the first solve.",
          err,
        ),
      );
  }

  // Listen for store changes pushed by the server (another tab's edit, or an
  // AI agent calling /api/agent/import) and live-reload the map so the new
  // route shows up automatically.
  subscribeToStoreEvents();
});

// Load the ACTIVE country's saved store and put it on screen. Runs once at
// boot and again on every country switch (each country has fully separate
// storage — see loadActiveCountry / countryDbName / TRAIN_STORE_API).
async function loadActiveCountryStore(bootLoadOptions) {
  if (!HAS_BACKEND) {
    // Static deploy: the user's own IndexedDB store wins; with no user data,
    // ONE RANDOM sample day is shown (ephemeral — sample has no memory). The
    // full sample loads only via the explicit 資料 card button. Parts are
    // fetched, seeded and DRAWN one train at a time, so the phone never
    // parses one big store JSON and never runs the route solver on boot.
    try {
      await bootStaticData(bootLoadOptions);
    } catch (err) {
      // The saved user store exists but failed to load (e.g. a stop the
      // validator rejects). Do NOT continue with autosave armed: a later
      // edit's per-day diff would delete every day missing from the partial
      // load. Enter read-only recovery with the raw JSON pinned for rescue.
      console.error("Static boot failed; entering read-only recovery mode.", err);
      let rawText = null;
      try {
        const userData = await readUserStoreAll();
        if (userData && userData.store)
          rawText = JSON.stringify(userData.store, null, 2);
      } catch (_) {
        /* rescue text is best-effort */
      }
      enterStoreRecoveryMode({ message: (err && err.message) || "", rawText });
      renderAll({ updateJsonTextarea: false });
      updateDataSourceUi();
    }
  } else {
    // Node deployment: the live server store is the source of truth; if
    // nothing has been saved yet, fall back to the built-in defaults (Japan)
    // or an empty store (other countries) and do not persist until edited.
    let savedStore = await loadTrainStoreFromServer();
    if (!savedStore?.recovery) {
      savedStore = await recoverPendingServerStoreSaves(savedStore);
    }
    if (savedStore && savedStore.recovery) {
      // A saved store EXISTS but cannot be loaded. Show the fallback
      // read-only: recovery mode keeps autosave off so the recoverable file
      // is never overwritten by a casual edit.
      await replaceTrainStoreFromStoreProgressive(
        savedStore.pendingStore || countryFallbackStore(),
        savedStore.pendingStore
          ? I18N.t("src.pendingRecovery")
          : countryFallbackLabel(),
        bootLoadOptions,
      );
      enterStoreRecoveryMode(savedStore);
    } else {
      await replaceTrainStoreFromStoreProgressive(
        savedStore || countryFallbackStore(),
        savedStore ? I18N.t("src.serverStore") : countryFallbackLabel(),
        bootLoadOptions,
      );
      if (!savedStore && activeCountry === "jp") {
        setStatus(
          els.importStatus,
          I18N.t("status.noSavedStore"),
          "warn",
        );
      }
    }
    updateDataSourceUi();
  }
}

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
  if (!HAS_BACKEND) return; // static deploy: no /api/events endpoint to subscribe to
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
    // Each country has its own store; ignore changes to one we're not showing.
    if (detail.store && detail.store !== TRAIN_STORE_API) return;
    handleExternalStoreChange(detail);
  });

  storeEventSource.onerror = () => {
    // EventSource reconnects on its own; nothing to do but note it once.
  };
}

async function handleExternalStoreChange(detail) {
  // Re-check the event's target store at USE time, not only at receive time:
  // an event deferred below can be drained AFTER a country switch re-pointed
  // TRAIN_STORE_API, and acting on the OLD country's event then (worst case a
  // `cleared` event) would wrongly replace the NEW country's view.
  if (detail && detail.store && detail.store !== TRAIN_STORE_API) return;
  // If a progressive import is mid-flight, defer; drainPendingLiveReload()
  // catches up as soon as the import's finally-block clears importInProgress.
  if (importInProgress) {
    liveReloadPending = true;
    liveReloadPendingDetail = detail; // newest event wins
    return;
  }
  try {
    if (detail && detail.cleared) {
      // Store was cleared on the server: fall back to built-in defaults. A
      // recovery-mode session has nothing left to protect once the broken
      // store is gone, so normal (writable) behavior resumes.
      lastKnownServerStoreText = null;
      lastKnownServerStoreExists = false;
      exitStoreRecoveryMode();
      await replaceTrainStoreFromStoreProgressive(
        countryFallbackStore(),
        I18N.t("src.serverCleared"),
        { persistEachStep: false, finalPersist: false },
      );
      setStatus(els.importStatus, I18N.t("status.serverClearedFallback"), "warn");
      return;
    }
    const savedStore = await loadTrainStoreFromServer();
    // A recovery sentinel means the store on disk is (still) unloadable —
    // keep showing what we have rather than reloading a broken view.
    if (!savedStore || savedStore.recovery) return;
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
    // Another source produced a store that loads cleanly — if this tab was in
    // read-only recovery, the danger has passed.
    exitStoreRecoveryMode();
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
    // Rail-sections may still be loading (boot no longer awaits it). Skip —
    // the index is built lazily by the first solve — rather than memoising an
    // EMPTY spatial index that would make every later solve come up dry.
    if (!railSectionsGeoJson) return;
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
