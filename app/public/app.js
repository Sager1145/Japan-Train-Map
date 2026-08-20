// =========================================================================
//  app.js — N02 Limited Express Train Manager (frontend entry spine)
//
//  The frontend is a family of plain classic scripts (no ES modules, no
//  bundler) that share ONE global lexical scope — the architecture the
//  precompute exporter (scripts/build/precompute-train-parts.mjs) relies on to
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
//   app-live-refresh.js      §10    SSE store-changed listener + deferred
//                                   reload replay
//   app-api.js               §7     backend API client (URLs, HAS_BACKEND,
//                                   CLIENT_ID, fetchJson/fetchText)
//   app-dates.js             §6     date grouping/sorting + UI date state
//   app-dom.js               §8     the cached DOM element table (`els`)
//   app-datasets.js          §7     loaded country datasets + station indexes
//   app-state.js                    core mutable state owner + actions
//   app.js  (this file)      §7,9–10  API client & HAS_BACKEND flag, boot
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
//   app-stats.js             §23a   mileage statistics: section
//                                   classification, aggregation, scheduling
//   app-stats-render.js      §23a   the 統計 panel's DOM/HTML (consumes the
//                                   view app-stats.js builds)
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
//   app-country-session.js           country transition coordinator
//
//  DEPLOY CONTRACT: runtime-config.js supplies backend/static capabilities.
//  The static build writes that one configuration artifact and never rewrites
//  application source.
// =========================================================================

// =========================================================================
//  §7.  App-data loading (the API client itself lives in app-api.js)
// =========================================================================

async function loadAppData() {
  // Kick off the big solver-only dataset immediately, but only DOWNLOAD it here
  // (response.text(), no JSON.parse) so its ~1.1 s parse never blocks boot or
  // first paint. ensureRailSectionsLoaded() parses it in yielding chunks after
  // the map is on screen, right before the first solve.
  const railSectionsDownload = AppDatasets.startRailSectionsDownload();

  // Country-specific station names/readings. Japan uses N02 code-keyed kana /
  // romaji / Chinese readings; Taiwan uses official TDX/PTX four-language
  // station names. Keeping the tables separate prevents same-named Taiwanese
  // stations (板橋, 松山, 岡山, …) from falling through to Japanese readings.
  const stationReadingsReady = loadActiveCountryStationReadings();

  // `stations` (3.3 MB / 456 KB gz) feeds the marker/station-resolution paths
  // used by the very first render, so it blocks first paint — but its native
  // JSON.parse is a single ~100-250 ms long task on iPhone Safari, the largest
  // blocking parse left in the render path. DOWNLOAD it as text in parallel with
  // the small datasets, then parse it in yielding chunks (same path as
  // rail-sections) so it interleaves with paint/input instead of freezing.
  const stationsTextReady = fetchText(stationsApiForCountry(activeCountry));
  const [defaultStore, matchedRoutes, matchedStops] = await Promise.all([
    fetchJson("default-trains"),
    fetchJson("matched-routes"),
    fetchJson("matched-stops"),
  ]);
  AppDatasets.installSeedData({ defaultStore, matchedRoutes, matchedStops });
  AppDatasets.installStations(
    await parseFeatureCollectionChunked(await stationsTextReady),
  );

  // Build the two station-resolution indexes in ~12 ms slices so this no
  // longer lands as one long synchronous task at the tail of boot Block 1
  // (right after the chunked parse of stations). Still awaited here, so every
  // downstream consumer (the first route solve, later imports, SSE reloads)
  // sees a fully-built index exactly as before; the produced index contents are
  // byte-for-byte identical to the old synchronous passes.
  await buildStationIndexesSliced(stationsGeoJson);

  await stationReadingsReady;

  // Surface a rail-sections DOWNLOAD failure instead of leaving an unhandled
  // rejection; ensureRailSectionsLoaded() re-fetches on demand before the first
  // solve.
  railSectionsDownload.catch((err) =>
    console.error(
      "rail-sections download failed during boot; will retry before first route solve.",
      err,
    ),
  );
}

// Country switch: EVERY solver/statistics artifact resident in memory belongs
// to the country that was active when it was built — the two parsed datasets,
// the route graphs derived from them, the spatial indexes, the statistics edge
// index, and the station index that resolves a stop to a feature. Drop them
// all and load the new country's pair. Keeping any one of them would let a
// Taiwanese stop resolve, or route, against Japanese track: the countries
// share station names (松山, 板橋, 岡山 …), so the failure would not look like
// an error, it would look like a route.
async function reloadSolverDatasetsForCountrySwitch() {
  AppDatasets.clearRailSections();
  RouteService.invalidateDataset();
  _statsEdgeIndex = null;
  _statsIndexBuild = null;

  // Same split boot uses: rail-sections only DOWNLOADS here (the solver parses
  // it in yielding chunks on first need), while stations are parsed right away
  // because the first render after the switch already resolves stops through
  // the station index.
  const sectionsText = AppDatasets.startRailSectionsDownload();
  sectionsText.catch((err) =>
    console.error(
      "rail-sections download failed after the country switch; will retry before the first solve.",
      err,
    ),
  );
  AppDatasets.installStations(
    await parseFeatureCollectionChunked(
      await fetchText(stationsApiForCountry(activeCountry)),
    ),
  );
  await buildStationIndexesSliced(stationsGeoJson);
}

let stationReadingsLoadGeneration = 0;
async function loadActiveCountryStationReadings() {
  const country = activeCountry;
  const generation = ++stationReadingsLoadGeneration;
  try {
    const data = await fetchJson(stationReadingsApiForCountry(country));
    if (
      generation === stationReadingsLoadGeneration &&
      country === activeCountry &&
      window.I18N &&
      I18N.setStationReadings
    ) {
      I18N.setStationReadings(data);
    }
    return data;
  } catch (err) {
    console.warn(
      `${country} station-name table failed to load; localized station names unavailable.`,
      err,
    );
    if (
      generation === stationReadingsLoadGeneration &&
      country === activeCountry &&
      window.I18N &&
      I18N.setStationReadings
    ) {
      I18N.setStationReadings({
        country: country.toUpperCase(),
        byCode: {},
        byName: {},
      });
    }
    return null;
  }
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
  // Start the map's own downloads (vendored basemap style + the active rail
  // network package) IMMEDIATELY, in parallel with the /api datasets below.
  // Previously initMap() kicked these off only after loadAppData() had fully
  // downloaded AND parsed stations/default-trains/matched-* — serializing the
  // two multi-MB waterfalls and delaying first map paint by the whole first
  // phase. Both loaders resolve null on failure (never throw).
  const initialMapTheme = resolveDisplayTheme();
  const alternateMapTheme = initialMapTheme === "dark" ? "light" : "dark";
  const mapAssetsReady = {
    primary: Promise.all([
      RailMap.loadBasemap(initialMapTheme),
      // The national-network LAYER remains hidden by default, but its complete
      // centreline model is also the geometry authority for every ridden
      // route. Load it before the first route render so no solver geometry can
      // briefly paint and then jump onto the display network.
      RailMap.loadNetwork(activeRailPackageUrl()),
    ]),
    // The alternate theme is fetched ONLY to warm loadBasemap's cache for an
    // instant first theme switch. It used to sit inside the Promise.all that
    // gates map creation — a cache-warming download on the first-paint
    // critical path. Now it rides in parallel; initMap only awaits it in the
    // corner case where the initial theme failed to load (see
    // buildMapLayersControl's fallback).
    alternate: RailMap.loadBasemap(alternateMapTheme).catch(() => null),
  };
  // Static deploy: the sample-manifest round trip has no dependency on the
  // map, but used to start only after initMap's basemap + first-tiles
  // handshake resolved. makeManifestLoader memoizes the in-flight promise,
  // so this early kick just overlaps the fetch with map startup and the real
  // boot path below reuses the same promise. (User-store IndexedDB reads are
  // local-fast and the backend GET isn't memoized — both stay where they are.)
  if (!HAS_BACKEND && typeof loadSampleManifest === "function")
    loadSampleManifest().catch(() => {});
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
  // The route graph reports solve progress; the editor's status line is this
  // layer's business, not the solver's (app-route-graph.js §27).
  setRouteSolveReporter((messageKey, params, level) =>
    setStatus(els.fieldStatus, I18N.t(messageKey, params), level),
  );
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
    RouteService.ensureReady()
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
//  §10.  Background route-graph prebuild (live refresh moved to
//        app-live-refresh.js)
// =========================================================================


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
