// =========================================================================
//  app-import.js — §16: progressive load / import engine (one train at a time, time-budgeted)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

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
  // The whole store is being replaced: drop every scope's cached build.
  if (typeof invalidateDeckRouteCaches === "function")
    invalidateDeckRouteCaches();
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
// `source` is either a plain array of raw trains, or an async part source
// ({ total, get(index) → Promise<rawTrain|null> }) that fetches one train per
// network request (see makeTrainPartsSource). A null from a source means that
// part could not be fetched/validated — the loop skips it and keeps loading
// the rest instead of aborting the whole boot on one flaky mobile request.
async function runProgressiveAppend(
  source,
  { persistEachStep = true, onProgress, fallbackDate = null, finalRender = true } = {},
) {
  const fromArray = Array.isArray(source);
  const appendedIds = [];
  const total = fromArray ? source.length : source.total;
  // Time-budget chunked scheduling. Keep processing trains until ~FRAME_BUDGET_MS
  // of work has accumulated, THEN yield one frame — instead of paying a whole
  // frame per train (which made N trains cost >= N frames regardless of how
  // cheap each one was). Cached/cheap trains now fly through many per frame; a
  // heavy solve still yields right after. Wall-clock tracks real work and the
  // approach scales to any N.
  const FRAME_BUDGET_MS = 12;
  const now = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now();
  let frameStart = now();
  // Shared frame-budget yielder. Returns control to the browser (paint + input)
  // once the current slice has run FRAME_BUDGET_MS, and trims the transient
  // regional-graph cache on the way out so peak memory stays bounded no matter
  // how large the import is (GC also gets to run between slices). It is passed
  // down into the per-section streaming solve, so the yield granularity is a
  // single route section — even one 60-section itinerary can't freeze the tab.
  const yieldIfNeeded = async () => {
    if (now() - frameStart < FRAME_BUDGET_MS) return false;
    trimRegionalGraphCache(REGIONAL_GRAPH_LOAD_NODE_BUDGET);
    // Every painted frame carries live date-bar / list-header counts, so the
    // sidebar numbers track the cards streaming in instead of sitting at 0
    // until the final renderAll().
    renderProgressiveCounts();
    await waitForImportPaint();
    frameStart = now();
    return true;
  };
  // One initial yield so the progress UI paints before the first solve runs.
  await waitForImportPaint();
  frameStart = now();
  for (let index = 0; index < total; index += 1) {
    const rawTrain = fromArray ? source[index] : await source.get(index);
    if (rawTrain == null) continue; // unfetchable part: already warned, keep going
    const id = appendImportedTrain(rawTrain, fallbackDate);
    appendedIds.push(id);

    const appendedTrain = getTrain(id);
    // Solve this train's route ONE section at a time, yielding within the train
    // whenever the frame budget is spent. This is the crash fix: the cold solve
    // of a large store no longer blocks the main thread ("page unresponsive")
    // and can't pile the whole graph up in one synchronous burst (OOM).
    await warmRouteCacheForTrain(appendedTrain, { yieldIfNeeded });

    // Draw just this one train incrementally: one more line on the map, one
    // more card in the list (O(1)). No full-list rebuild, no full-map clear.
    perfMeasure("appendTrainToLayers", () =>
      appendTrainToLayers(appendedTrain),
    );
    appendTrainListItemIncremental(appendedTrain);
    if (onProgress) onProgress({ count: appendedIds.length, total, id });

    await yieldIfNeeded();
  }
  // Single authoritative repaint: full sorted list + date bar + cross-train
  // overlap offsets, all once at the end. The two "replace" callers run
  // finalizeProgressiveLoad() -> renderAll() synchronously the moment this
  // awaited call returns (no paint in between), so they pass finalRender:false
  // to skip this duplicate full pass (renderTrainList's 119 item builds + the
  // whole overlap/offset rebuild). Append mode has no finalize step and keeps
  // the default repaint so its imported lines settle to final styling.
  if (finalRender) renderAll();
  if (persistEachStep) saveTrainStore();
  return appendedIds;
}

// Pre-compute (and cache) one train's route geometry without touching the DOM,
// streaming the solve ONE section at a time and yielding a frame between
// sections (via the caller's shared frame-budget `yieldIfNeeded`) so the heavy
// solve is spread across animation frames instead of a single blocking burst.
// Failures are swallowed — the normal render path surfaces any genuine problem.
async function warmRouteCacheForTrain(train, { yieldIfNeeded } = {}) {
  if (!train) return;
  try {
    await warmRouteCacheForTrainStreaming(train, { yieldIfNeeded });
  } catch (err) {
    console.warn(
      `Route warm-up failed for ${train?.id}; will retry on render.`,
      err,
    );
  }
}

// Apply the caller's post-load selection policy, re-validate the canonical
// store and (optionally) persist. Shared tail of the two "replace" paths.
function finalizeProgressiveLoad(
  appendedIds,
  {
    finalPersist = true,
    showAllDates = false,
    selectFirstTrain = true,
  } = {},
) {
  selectedTrainId = selectFirstTrain ? appendedIds[0] || null : null;
  focusedTrainId = null;
  // Cancel any pending batched append-render: the authoritative renderAll()
  // below supersedes it (otherwise the timer fires ~120 ms later and runs one
  // redundant full renderTrainLayers after every import).
  if (_appendRenderTimer) {
    clearTimeout(_appendRenderTimer);
    _appendRenderTimer = null;
  }
  // A full replace can invalidate the previous date filter: keep a still-valid
  // selection, otherwise drop to the earliest available date. A "load
  // everything" caller passes showAllDates so the result lands on the combined
  // 全部 view — the user asked for every trip, so auto-selecting a single day
  // of what just loaded would hide most of it.
  if (showAllDates) selectedDate = ALL_DATES;
  reconcileSelectedDate();
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

    // Opening one's own local JSON is an explicit "load MY data" action: on
    // the static deploy it leaves sample mode and persists (to IndexedDB) just
    // like it persists to the server on the Node deployment.
    if (!HAS_BACKEND && isSampleMode()) {
      dataSourceMode = "user";
      sampleModeDate = null;
      updateDataSourceUi();
    }

    resetTrainStoreForProgressiveLoad();
    setImportProgress(0, total, I18N.t("prog.prepare", { label: sourceLabel, total }));

    const appendedIds = await runProgressiveAppend(importedStore.trains, {
      persistEachStep: true,
      // finalizeProgressiveLoad() -> renderAll() runs synchronously after this
      // awaited call returns, so skip runProgressiveAppend's duplicate
      // authoritative repaint (full list + overlap rebuild) here.
      finalRender: false,
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

    // The user explicitly replaced the store and every train loaded — if this
    // session was in read-only recovery, autosave may resume (finalize below
    // persists this replacement).
    exitStoreRecoveryMode();
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
    // `store` already arrived as a parsed object (server res.json() / defaults /
    // SSE payload) and is discarded by every caller after this. The old
    // JSON.stringify()+re-parse round-trip (a full serialize of the whole store
    // on every boot AND every live reload) bought nothing: parseImportedCanonicalStore
    // accepts an object directly, and the progressive append only READS from it
    // (normalizeImportedTrain builds fresh objects — it never mutates the source).
    const importedStore = parseImportedCanonicalStore(store || { trains: [] });
    const total = importedStore.trains.length;
    if (!total) {
      // An empty store is still a REPLACEMENT (e.g. switching to a country
      // with no saved data yet): clear what is on screen instead of leaving
      // the previous store's trains visible.
      resetTrainStoreForProgressiveLoad();
      finalizeProgressiveLoad([], {
        finalPersist: options.finalPersist !== false,
        showAllDates: Boolean(options.showAllDates),
        selectFirstTrain: false,
      });
      return { count: 0, ids: [] };
    }

    const persistEachStep = Boolean(options.persistEachStep);
    const finalPersist = options.finalPersist !== false;
    const showAllDates = Boolean(options.showAllDates);
    const selectFirstTrain = options.selectFirstTrain !== false;

    resetTrainStoreForProgressiveLoad();
    setImportProgress(0, total, I18N.t("prog.prepare", { label: sourceLabel, total }));

    const appendedIds = await runProgressiveAppend(importedStore.trains, {
      persistEachStep,
      // finalizeProgressiveLoad() -> renderAll() runs synchronously after this
      // awaited call returns, so skip runProgressiveAppend's duplicate
      // authoritative repaint (full list + overlap rebuild) here.
      finalRender: false,
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

    finalizeProgressiveLoad(appendedIds, {
      finalPersist,
      showAllDates,
      selectFirstTrain,
    });
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

// ---------------------------------------------------------------------------
// Sample-data parts (static deploys). The deploy pipeline runs the route
// solver OFFLINE (app/scripts/precompute-train-parts.mjs) and publishes the
// SAMPLE dataset as api/sample-data/: a manifest plus one part-NNN.json per
// train, each carrying the raw train AND its solved route geometry keyed by
// the exact cacheKey prepareTrainRouteSolve() computes. The manifest's `dates`
// map groups the part names per calendar day, so boot can load a single
// random day and the full sample loads only on explicit request. Parts are
// fetched one train at a time, seeding the runtime route cache, appending and
// drawing that train before the next — so the phone never parses one big
// store JSON, never builds a route graph and never runs Dijkstra during the
// initial load (the on-device cold solve is what crashed iPhone Safari).
// A stale part (train edited without regenerating parts) just misses the cache
// and falls back to the normal streaming solve for that one train.
// ---------------------------------------------------------------------------
// Memoized manifest fetch + validation, shared by the sample dataset and the
// curated special-dataset loaders. The memo caches the settled promise for the
// whole session — an unpublished/unreachable manifest memoizes as null and is
// NOT retried later. `attachPartsApi` stamps parts_api for datasets living
// outside SAMPLE_DATA_API, so makeTrainPartsSource fetches their parts from
// the right place.
function makeManifestLoader(api, { attachPartsApi = false } = {}) {
  let manifestPromise = null;
  return function loadManifest() {
    if (!manifestPromise) {
      manifestPromise = (async () => {
        try {
          // Revalidate the small manifest on every boot. Dataset files are
          // replaced in place on deploy, so accepting a still-fresh HTTP cache
          // entry here can pin the browser to an older geometry set.
          const manifest = await fetchJson(`${api}/manifest`, {
            cache: "no-cache",
          });
          if (
            !manifest ||
            manifest.format !== 1 ||
            !Array.isArray(manifest.parts) ||
            !manifest.parts.length ||
            !ACCEPTED_SCHEMA_VERSIONS.includes(manifest.schema_version)
          )
            return null;
          return attachPartsApi ? { ...manifest, parts_api: api } : manifest;
        } catch (err) {
          // No dataset published (or unreachable).
          return null;
        }
      })();
    }
    return manifestPromise;
  };
}

const loadSampleManifest = makeManifestLoader(SAMPLE_DATA_API);

// The manifest's per-day index, defensively filtered to non-empty name lists.
function sampleManifestDates(manifest) {
  const dates = manifest && manifest.dates;
  if (!dates || typeof dates !== "object") return [];
  return Object.keys(dates)
    .filter((key) => key && Array.isArray(dates[key]) && dates[key].length)
    .sort();
}

// Seed the runtime route cache from one part's precomputed solve so the
// subsequent warm-up is a pure cache hit. Safe by construction: a mismatched
// cache_key is simply never looked up, and a known-unsolvable train seeds the
// negative cache so the doomed graph build is skipped exactly as if this
// session had already solved (and failed) it.
function seedRouteCacheFromPart(part) {
  const route = part && part.route;
  if (!route || typeof route.cache_key !== "string" || !route.cache_key) return;
  if (route.unsolvable === true) {
    runtimeRouteCache.delete(route.cache_key);
    runtimeRouteNegativeCache.add(route.cache_key);
    return;
  }
  if (Array.isArray(route.features) && route.features.length) {
    // Published sample parts are the authoritative output of the current
    // solver. Always replace a warmed IndexedDB entry: before this overwrite,
    // an old Hatchobori solve could survive indefinitely under the same key
    // and hide a corrected part-099.json.
    runtimeRouteNegativeCache.delete(route.cache_key);
    runtimeRouteCache.set(route.cache_key, route.features);
  }
}

// Async train source over the published parts: fetches ONE train per request,
// keeping a small window of fetches in flight ahead of the append cursor so
// the per-file network latency overlaps with append/draw work instead of
// serialising 100+ round-trips. Each part is retried once and then skipped
// (returns null) so a single flaky mobile request can't abort the whole boot.
function makeTrainPartsSource(manifest) {
  const names = manifest.parts;
  const partsApi = manifest.parts_api || SAMPLE_DATA_API;
  const PREFETCH_WINDOW = 4;
  const inflight = new Map(); // index -> Promise<part|null>
  const fetchPart = (index) => {
    let pending = inflight.get(index);
    if (!pending) {
      pending = (async () => {
        const partPath = `${partsApi}/${names[index]}`;
        try {
          return await fetchJson(partPath, { cache: "no-cache" });
        } catch (err) {
          try {
            return await fetchJson(partPath, { cache: "no-cache" }); // one retry for transient failures
          } catch (retryErr) {
            console.warn(
              `Train part ${names[index]} failed to load; skipping this train.`,
              retryErr,
            );
            return null;
          }
        }
      })();
      inflight.set(index, pending);
    }
    return pending;
  };
  return {
    total: names.length,
    async get(index) {
      const last = Math.min(index + PREFETCH_WINDOW, names.length - 1);
      for (let ahead = index; ahead <= last; ahead += 1) fetchPart(ahead);
      const part = await fetchPart(index);
      inflight.delete(index); // consumed: let the part JSON be collected
      if (!part || part.format !== 1 || !part.train) {
        if (part) console.warn(`Train part ${names[index]} has an unexpected shape; skipping.`);
        return null;
      }
      seedRouteCacheFromPart(part);
      return part.train;
    },
  };
}

// "Replace" progressive load over the published per-train parts — the static
// deploy's counterpart of replaceTrainStoreFromStoreProgressive, sharing the
// same reset/append/finalize machinery and options.
async function replaceTrainStoreFromPartsProgressive(
  manifest,
  sourceLabel = "JSON",
  options = {},
) {
  if (importInProgress) {
    console.warn(
      "A progressive load/import is already running; ignoring concurrent replaceTrainStoreFromPartsProgressive.",
    );
    return { count: 0, ids: [] };
  }
  importInProgress = true;
  try {
    const source = makeTrainPartsSource(manifest);
    const total = source.total;

    const persistEachStep = Boolean(options.persistEachStep);
    const finalPersist = options.finalPersist !== false;
    const showAllDates = Boolean(options.showAllDates);
    const selectFirstTrain = options.selectFirstTrain !== false;

    resetTrainStoreForProgressiveLoad();
    setImportProgress(0, total, I18N.t("prog.prepare", { label: sourceLabel, total }));

    const appendedIds = await runProgressiveAppend(source, {
      persistEachStep,
      // finalizeProgressiveLoad() -> renderAll() runs synchronously after this
      // awaited call returns; skip the duplicate authoritative repaint.
      finalRender: false,
      onProgress: ({ count, total: t, id }) => {
        setImportProgress(
          count,
          t,
          I18N.t("prog.loading", { label: sourceLabel, count, total: t, id }),
        );
      },
    });

    finalizeProgressiveLoad(appendedIds, {
      finalPersist,
      showAllDates,
      selectFirstTrain,
    });
    const skipped = total - appendedIds.length;
    setImportProgress(total, total, I18N.t("prog.done", { count: appendedIds.length }));
    setStatus(
      els.importStatus,
      I18N.t("status.restoredAll", { label: sourceLabel, total: appendedIds.length }),
      skipped ? "warn" : "ok",
    );
    return { count: appendedIds.length, ids: appendedIds };
  } finally {
    importInProgress = false;
    drainPendingLiveReload();
  }
}

// ---------------------------------------------------------------------------
// Static-deploy data sources: sample data (ephemeral) vs the user's own store
// (IndexedDB). These four functions own the dataSourceMode transitions.
// ---------------------------------------------------------------------------

// Load the published sample — one day (date given) or all of it (date null).
// Sample data has NO memory: persistence is disabled for the whole session
// until the user restores their own data or explicitly saves the view.
async function loadSampleData({ date = null, bootLoadOptions = null } = {}) {
  const manifest = await loadSampleManifest();
  if (!manifest) throw new Error(I18N.t("err.noSampleData"));
  const names =
    date && manifest.dates && Array.isArray(manifest.dates[date])
      ? manifest.dates[date]
      : manifest.parts;
  // Flip the mode BEFORE the progressive load so any save triggered while the
  // sample streams in is dropped, never written over the user's store.
  dataSourceMode = date ? "sample-single" : "sample-all";
  sampleModeDate = date;
  sampleEditHintShown = false;
  updateDataSourceUi();
  const label = date
    ? I18N.t("src.sampleDay", { date })
    : I18N.t("src.sampleAll");
  const options = {
    // Explicit 「載入全部示例資料」click (no boot options): show the whole thing
    // on the combined 全部 view instead of dropping to one of its days.
    ...(bootLoadOptions || { showAllDates: !date, selectFirstTrain: false }),
    persistEachStep: false,
    finalPersist: false,
  };
  const result = await replaceTrainStoreFromPartsProgressive(
    { ...manifest, parts: names },
    label,
    options,
  );
  updateDataSourceUi();
  setStatus(
    els.importStatus,
    date
      ? I18N.t("status.sampleSingleLoaded", { date, count: result.count })
      : I18N.t("status.sampleAllLoaded", { count: result.count }),
    "ok",
  );
  return result;
}

// Loader for one independent curated dataset (e.g. the 2025-12-31 →
// 2026-01-01 New Year grand loop). Each dataset's manifest lives outside
// SAMPLE_DATA_API, so bootStaticData's random-day selection can never include
// it; loading one is ephemeral exactly like the sample (nothing persists, the
// whole itinerary shows on the combined 全部 view).
function makeCuratedDatasetLoader({ api, mode, missingKey, sourceKey, loadedKey }) {
  const loadManifest = makeManifestLoader(api, { attachPartsApi: true });
  return async function loadCuratedDataset() {
    const manifest = await loadManifest();
    if (!manifest) throw new Error(I18N.t(missingKey));
    // Flip the mode BEFORE the progressive load so any save triggered while
    // the dataset streams in is dropped, never written over the user's store.
    dataSourceMode = mode;
    sampleModeDate = null;
    sampleEditHintShown = false;
    updateDataSourceUi();
    const result = await replaceTrainStoreFromPartsProgressive(
      manifest,
      I18N.t(sourceKey),
      {
        showAllDates: true,
        selectFirstTrain: false,
        persistEachStep: false,
        finalPersist: false,
      },
    );
    updateDataSourceUi();
    setStatus(
      els.importStatus,
      I18N.t(loadedKey, { count: result.count }),
      "ok",
    );
    return result;
  };
}

const loadNewYearGrandLoopData = makeCuratedDatasetLoader({
  api: NEW_YEAR_GRAND_LOOP_API,
  mode: "sample-new-year-grand-loop",
  missingKey: "err.noNewYearGrandLoopData",
  sourceKey: "src.newYearGrandLoop",
  loadedKey: "status.newYearGrandLoopLoaded",
});

const loadTokyoLimitedExpressLoopData = makeCuratedDatasetLoader({
  api: TOKYO_LIMITED_EXPRESS_LOOP_API,
  mode: "sample-tokyo-limited-express-loop",
  missingKey: "err.noTokyoLimitedExpressLoopData",
  sourceKey: "src.tokyoLimitedExpressLoop",
  loadedKey: "status.tokyoLimitedExpressLoopLoaded",
});

// The dataset-replacing 資料來源 buttons, wired by bindEvents() as one shared
// handler each: confirm → disable → fit Japan → load → error status → refresh
// the source UI. Loading any of these never touches the user's saved data,
// but it DOES replace what is on screen — hence the per-button confirm.
const CURATED_DATASET_BUTTONS = [
  {
    buttonId: "load-sample-all",
    confirmKey: "confirm.loadSampleAll",
    load: () => loadSampleData({ date: null }),
  },
  {
    buttonId: "load-new-year-grand-loop",
    confirmKey: "confirm.loadNewYearGrandLoop",
    load: () => loadNewYearGrandLoopData(),
  },
  {
    buttonId: "load-tokyo-limited-express-loop",
    confirmKey: "confirm.loadTokyoLimitedExpressLoop",
    load: () => loadTokyoLimitedExpressLoopData(),
  },
];

// Bring the user's own saved data back on screen (leaves sample mode). The
// sample view is discarded; the IndexedDB store was never touched by it.
async function restoreUserStore({ bootLoadOptions = null } = {}) {
  const userData = await readUserStoreAll();
  if (!userData) {
    userStoreAvailable = false;
    updateDataSourceUi();
    setStatus(els.importStatus, I18N.t("status.noUserStore"), "warn");
    return false;
  }
  seedRouteCacheEntries(userData.routes);
  dataSourceMode = "user";
  sampleModeDate = null;
  userStoreAvailable = true;
  await replaceTrainStoreFromStoreProgressive(
    userData.store,
    I18N.t("src.userStore"),
    {
      ...(bootLoadOptions || { selectFirstTrain: false }),
      persistEachStep: false,
      // Data just came FROM storage; no need to immediately write it back.
      finalPersist: false,
    },
  );
  // The stored data restored cleanly — recovery mode (if any) is over.
  exitStoreRecoveryMode();
  updateDataSourceUi();
  return true;
}

// Persist whatever is currently on screen (typically a sample the user played
// with) as the user's own data, then switch to user mode with autosave on.
async function saveCurrentAsUserStore() {
  const canonical = buildCanonicalTrainStore();
  await writeUserStoreChunks(canonical, { force: true });
  // An explicit, confirmed overwrite of the user store supersedes whatever
  // failed to load — recovery mode (if any) ends here.
  exitStoreRecoveryMode();
  userStoreAvailable = canonical.trains.length > 0;
  dataSourceMode = "user";
  sampleModeDate = null;
  storeSaveDirty = false;
  updateDataSourceUi();
  setStatus(
    els.jsonStatus,
    I18N.t("status.savedAsMine", { count: canonical.trains.length }),
    "ok",
  );
}

// Static-deploy boot: the user's own data wins; otherwise ONE RANDOM sample
// day; built-in defaults only if the sample is unreachable.
async function bootStaticData(bootLoadOptions) {
  const userData = await readUserStoreAll();
  if (userData) {
    seedRouteCacheEntries(userData.routes);
    dataSourceMode = "user";
    userStoreAvailable = true;
    await replaceTrainStoreFromStoreProgressive(
      userData.store,
      I18N.t("src.userStore"),
      bootLoadOptions,
    );
    updateDataSourceUi();
    return;
  }
  userStoreAvailable = false;
  if (activeCountry !== "jp") {
    // Every bundled sample/default is a Japan dataset; another country with
    // no saved data starts with an empty, autosaving user store instead.
    dataSourceMode = "user";
    sampleModeDate = null;
    updateDataSourceUi();
    await replaceTrainStoreFromStoreProgressive(
      countryFallbackStore(),
      countryFallbackLabel(),
      { ...bootLoadOptions, persistEachStep: false, finalPersist: false },
    );
    updateDataSourceUi();
    return;
  }
  try {
    const manifest = await loadSampleManifest();
    if (manifest) {
      const dates = sampleManifestDates(manifest);
      const date = dates.length
        ? dates[Math.floor(Math.random() * dates.length)]
        : null;
      await loadSampleData({ date, bootLoadOptions });
      return;
    }
  } catch (err) {
    console.warn("Sample data boot failed; falling back to defaults.", err);
  }
  // No sample published/reachable: show the built-in defaults, still ephemeral.
  dataSourceMode = "sample-all";
  sampleModeDate = null;
  updateDataSourceUi();
  await replaceTrainStoreFromStoreProgressive(
    getDefaultTrainStore(),
    I18N.t("src.builtinDefault"),
    { ...bootLoadOptions, persistEachStep: false, finalPersist: false },
  );
  updateDataSourceUi();
}

// ---------------------------------------------------------------------------
// Country switching (日本 / 台灣): swaps the ACTIVE store — a separate server
// endpoint plus separate IndexedDB databases per country — then reloads that
// country's data and re-renders everything. Nothing about the other country's
// store is touched.
// ---------------------------------------------------------------------------
let countrySwitchInFlight = false;

function updateCountrySelect() {
  const select = document.getElementById("country-select");
  if (!select) return;
  select.value = activeCountry;
  select.disabled = countrySwitchInFlight;
}

function setupCountrySelect() {
  const select = document.getElementById("country-select");
  if (!select) return;
  updateCountrySelect();
  select.addEventListener("change", async () => {
    try {
      await switchActiveCountry(select.value);
    } catch (err) {
      console.error("Country switch failed.", err);
      setStatus(
        els.importStatus,
        I18N.t("status.countrySwitchFailed", {
          msg: (err && err.message) || "",
        }),
        "err",
      );
    } finally {
      // Reflect the real state — a refused or failed switch snaps back.
      updateCountrySelect();
    }
  });
}

async function switchActiveCountry(next) {
  if (!SUPPORTED_COUNTRIES.includes(next) || next === activeCountry) return;
  // A progressive load owns the store globals; switching mid-flight would
  // interleave two replacements. The select snaps back via the caller.
  if (countrySwitchInFlight || importInProgress) return;
  countrySwitchInFlight = true;
  updateCountrySelect();
  try {
    // Land any pending edits in the OLD country's store before re-pointing
    // every persistence target at the new one.
    try {
      await flushServerStoreSave();
    } catch (err) {
      console.warn(
        "Could not flush pending saves before the country switch.",
        err,
      );
    }
    activeCountry = next;
    try {
      localStorage.setItem(COUNTRY_STORAGE_KEY, next);
    } catch (_) {
      /* preference just won't survive a reload */
    }
    TRAIN_STORE_API = trainStoreApiForCountry(next);
    const networkCountryReady =
      typeof RailMap !== "undefined" &&
      typeof RailMap.switchNetworkCountry === "function"
        ? RailMap.switchNetworkCountry()
        : Promise.resolve(null);
    resetPersistenceStateForCountrySwitch();
    exitStoreRecoveryMode();
    selectedTrainId = null;
    focusedTrainId = null;
    dataSourceMode = "user";
    sampleModeDate = null;
    sampleEditHintShown = false;
    userStoreAvailable = false;
    // Re-frame the map over the new country BEFORE its data streams in.
    // Release the OLD country's pan/zoom cage first (its maxBounds/minZoom
    // would block or clamp the flight), glide over, then cage to the new
    // territory once the movement lands.
    if (typeof map !== "undefined" && map) {
      map.setMaxBounds(null);
      map.setMinZoom(2);
      fitActiveCountryOverview({ animate: true });
      map.once("moveend", () => applyJapanMapConstraints());
    }
    await Promise.all([
      loadActiveCountryStore({
        persistEachStep: false,
        finalPersist: false,
        selectFirstTrain: false,
      }),
      networkCountryReady,
    ]);
    // A failed restore just entered read-only recovery mode with its own
    // error message — don't paper over it with a success status.
    if (!storeRecoveryMode) {
      setStatus(
        els.importStatus,
        I18N.t("status.countrySwitched", {
          name: I18N.t(`country.${activeCountry}`),
        }),
        "ok",
      );
    }
  } finally {
    countrySwitchInFlight = false;
    updateCountrySelect();
  }
}

// Reflect dataSourceMode in the 資料 card: the mode line, and which of the
// source buttons are visible/enabled. Safe to call before the DOM listeners
// are bound and on the Node deployment (where the block is hidden entirely).
function updateDataSourceUi() {
  const statusEl = document.getElementById("data-source-status");
  const sourceBlock = document.getElementById("data-source-block");
  if (!statusEl || !sourceBlock) return;
  if (HAS_BACKEND) {
    // Node deployment: server autosave, no sample/user-store switching. The
    // built-in defaults are a Japan dataset, so "reset to defaults" only
    // makes sense while Japan is the active country.
    sourceBlock.hidden = true;
    const resetBtn = document.getElementById("reset-defaults");
    if (resetBtn) resetBtn.hidden = activeCountry !== "jp";
    return;
  }
  sourceBlock.hidden = false;
  let key = "mode.user";
  if (dataSourceMode === "sample-single") key = "mode.sampleSingle";
  else if (dataSourceMode === "sample-all") key = "mode.sampleAll";
  else if (dataSourceMode === "sample-new-year-grand-loop")
    key = "mode.newYearGrandLoop";
  else if (dataSourceMode === "sample-tokyo-limited-express-loop")
    key = "mode.tokyoLimitedExpressLoop";
  statusEl.textContent = I18N.t(key, { date: sampleModeDate || "" });
  statusEl.classList.toggle("sample-active", isSampleMode());
  const loadAllBtn = document.getElementById("load-sample-all");
  const loadNewYearBtn = document.getElementById("load-new-year-grand-loop");
  const loadTokyoLtdExpBtn = document.getElementById(
    "load-tokyo-limited-express-loop",
  );
  const saveMineBtn = document.getElementById("save-as-user-store");
  const restoreBtn = document.getElementById("restore-user-store");
  // Every bundled sample is a Japan dataset — hide the loaders elsewhere.
  const jpDatasets = activeCountry === "jp";
  if (loadAllBtn) {
    loadAllBtn.hidden = !jpDatasets;
    loadAllBtn.disabled = dataSourceMode === "sample-all";
  }
  if (loadNewYearBtn) {
    loadNewYearBtn.hidden = !jpDatasets;
    loadNewYearBtn.disabled = dataSourceMode === "sample-new-year-grand-loop";
  }
  if (loadTokyoLtdExpBtn) {
    loadTokyoLtdExpBtn.hidden = !jpDatasets;
    loadTokyoLtdExpBtn.disabled =
      dataSourceMode === "sample-tokyo-limited-express-loop";
  }
  if (saveMineBtn) saveMineBtn.hidden = !isSampleMode();
  if (restoreBtn) {
    restoreBtn.hidden = !isSampleMode();
    restoreBtn.disabled = !userStoreAvailable;
  }
  // The panel context line carries the sample-data badge — a source switch
  // (保存為我的資料 / loading a sample) must refresh it even when no list
  // re-render happens, or it keeps claiming the WRONG source.
  if (typeof updatePanelContextChip === "function") updatePanelContextChip();
}
