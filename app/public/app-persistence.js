// =========================================================================
//  app-persistence.js — §12–15: train-store persistence — debounced server autosave, File System Access handles, user IndexedDB store, route-geometry cache, local JSON open/save
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

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
// JSON.stringify is deferred until the debounced flush actually runs, so a
// rapid burst of small
// mutations (visible toggles, field edits, ride_segment toggles) no longer
// pays one — let alone two — full serializations on the synchronous path.
let storeSaveDirty = false;

// --- Read-only recovery mode -----------------------------------------------
// Entered when a SAVED store exists but cannot be loaded (fails validation,
// corrupt JSON, or an unreadable backend). The old behavior fell back to the
// built-in defaults with autosave still armed, so the user's next edit
// silently overwrote their unreadable-but-recoverable data with the defaults.
// In recovery mode autosave is disabled and the raw saved JSON is pinned into
// the export textarea for rescue; only an explicit, successful data action
// (import / open local JSON / restore / reset / clear) leaves the mode.
let storeRecoveryMode = false;

function enterStoreRecoveryMode({ message = "", rawText = null } = {}) {
  storeRecoveryMode = true;
  // Cancel anything the autosave debounce queued before the failure was known.
  clearTimeout(serverStoreSaveTimer);
  clearTimeout(exportTextareaTimer);
  pendingServerStoreText = null;
  storeSaveDirty = false;
  if (rawText && els.json) els.json.value = rawText;
  if (els.importStatus)
    setStatus(
      els.importStatus,
      I18N.t("status.recoveryEntered", { msg: message }),
      "err",
    );
}

function exitStoreRecoveryMode() {
  storeRecoveryMode = false;
}

function saveTrainStore() {
  // Recovery mode: the saved store failed to load, so what is on screen is a
  // fallback view — persisting it would destroy the recoverable original.
  if (storeRecoveryMode) {
    setStatus(els.jsonStatus, I18N.t("status.recoveryNoSave"), "warn");
    return;
  }
  // Sample data has no memory: while a sample is on screen NOTHING persists,
  // so browsing/editing the sample can never overwrite the user's saved data.
  if (!HAS_BACKEND && isSampleMode()) {
    if (!sampleEditHintShown) {
      sampleEditHintShown = true;
      setStatus(els.jsonStatus, I18N.t("status.sampleNoSave"), "warn");
    }
    return;
  }
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
  // Static deploy: there is no server to PUT to — user data is persisted to
  // the browser's IndexedDB instead, chunked one record per day.
  if (!HAS_BACKEND) {
    pendingServerStoreText = null;
    return flushUserStoreSave();
  }
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

// Static-deploy counterpart of the server PUT: write the canonical store to
// IndexedDB (per-day chunks, diffed). Shares storeSaveDirty with the debounce
// machinery so force-flush callers behave identically on both deployments.
let userStoreSaveInFlight = false;
let userStoreSavePromise = null;
async function flushUserStoreSave() {
  if (isSampleMode()) {
    storeSaveDirty = false;
    return;
  }
  if (userStoreSaveInFlight) return userStoreSavePromise;
  if (!storeSaveDirty) return;
  storeSaveDirty = false;
  userStoreSaveInFlight = true;
  userStoreSavePromise = (async () => {
    try {
      const canonical = perfMeasure("serialize store", () =>
        buildCanonicalTrainStore(),
      );
      await writeUserStoreChunks(canonical);
      userStoreAvailable = canonical.trains.length > 0;
      setStatus(els.jsonStatus, I18N.t("status.autosaveLocalOk"), "ok");
      updateDataSourceUi();
    } catch (error) {
      console.warn("Autosave to browser storage (IndexedDB) failed.", error);
      setStatus(
        els.jsonStatus,
        I18N.t("status.autosaveFail", { msg: error.message }),
        "warn",
      );
    } finally {
      userStoreSaveInFlight = false;
      // A newer change may have arrived while this write was in flight.
      if (storeSaveDirty) flushUserStoreSave();
    }
  })();
  return userStoreSavePromise;
}

// The read-only export textarea is a display convenience, not part of the
// edit path. Refreshing it ran a full exportTrainStore() (whole-store
// JSON.stringify) on EVERY mutation. Debounce it so rapid edits coalesce into
// a single serialization once the user pauses, off the interaction's hot path.
let exportTextareaTimer = null;
function scheduleExportTextareaRefresh() {
  // Recovery mode pins the broken store's raw JSON in the export box for
  // rescue; routine renders must not overwrite it with the fallback view.
  if (storeRecoveryMode) return;
  clearTimeout(exportTextareaTimer);
  exportTextareaTimer = setTimeout(() => {
    if (els.json)
      els.json.value = perfMeasure("export textarea", () => exportTrainStore());
  }, 300);
}

// Load the saved store from the server. Returns:
//   - the parsed, validated store;
//   - null when nothing has been saved yet (HTTP 404) — defaults are safe;
//   - { recovery: true, rawText, message } when a store EXISTS but cannot be
//     loaded (network/HTTP failure, corrupt JSON, or validation failure).
// Callers must treat the recovery sentinel as read-only: falling back to
// writable defaults here is what used to let the next autosave overwrite the
// user's recoverable data.
async function loadTrainStoreFromServer() {
  let res;
  try {
    res = await fetch(`${API_BASE}/${TRAIN_STORE_API}`, {
      cache: "no-store",
    });
  } catch (error) {
    // Network failure: we cannot know whether a saved store exists, so do NOT
    // hand back writable defaults.
    console.warn("Could not reach the server train-store endpoint.", error);
    return { recovery: true, rawText: null, message: error.message };
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`Server train-store read failed: ${res.status}.`);
    return {
      recovery: true,
      rawText: null,
      message: `${res.status} ${res.statusText}`,
    };
  }
  let text = "";
  try {
    text = await res.text();
    const parsed = JSON.parse(text);
    validateTrainStore(parsed);
    return parsed;
  } catch (error) {
    console.warn(
      "Saved train store failed to parse/validate; entering read-only recovery mode instead of overwritable defaults.",
      error,
    );
    return { recovery: true, rawText: text, message: error.message };
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
//  §13b. User train store (IndexedDB, chunked one record per calendar day)
// =========================================================================
// The static (GitHub Pages) deploy has no backend, so the user's own data is
// persisted right here in the browser. Layout:
//   object store "dates": key = date string ("" for undated trains), value =
//     { date, trains: [<canonical train>...],
//       routes: [{ cache_key, features } | { cache_key, unsolvable: true }] }
//   object store "meta":  key "meta", value =
//     { schema_version, updated_at, dates: [<date keys in store order>] }
// Each record also carries that day's precomputed route geometry (taken from
// the runtime route cache), so restoring the user store on a later boot seeds
// the cache exactly like the published sample parts do — no on-device
// re-solve, which is what crashes memory-tight iPhones.
// Writes are diffed per day: only days whose serialized content changed are
// rewritten, and days that disappeared are deleted.

function openUserStoreDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(USER_STORE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(USER_STORE_DATES_STORE))
        db.createObjectStore(USER_STORE_DATES_STORE);
      if (!db.objectStoreNames.contains(USER_STORE_META_STORE))
        db.createObjectStore(USER_STORE_META_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Could not open the user store DB."));
  });
}

// Serialized per-day chunk texts from the last successful write, so the next
// write only touches days whose content actually changed.
let userStoreWrittenChunks = new Map();

// Group the canonical trains per day (preserving store order) and attach each
// day's route geometry from the runtime cache. Returns Map<dateKey, record>.
function buildUserStoreChunks(canonicalStore) {
  const chunks = new Map();
  const liveById = new Map(trainStore.trains.map((t) => [t.id, t]));
  for (const train of canonicalStore.trains) {
    const dateKey = typeof train.date === "string" ? train.date : "";
    if (!chunks.has(dateKey))
      chunks.set(dateKey, { date: dateKey, trains: [], routes: [] });
    const chunk = chunks.get(dateKey);
    chunk.trains.push(train);
    // Attach the solved geometry (or the negative-cache marker) so a later
    // boot never has to re-run the solver for this train.
    try {
      const context = buildTrainRouteSolveContext(liveById.get(train.id) || train);
      if (context && context.cacheKey) {
        if (runtimeRouteCache.has(context.cacheKey)) {
          chunk.routes.push({
            cache_key: context.cacheKey,
            features: runtimeRouteCache.get(context.cacheKey),
          });
        } else if (runtimeRouteNegativeCache.has(context.cacheKey)) {
          chunk.routes.push({ cache_key: context.cacheKey, unsolvable: true });
        }
      }
    } catch (err) {
      // Geometry is an optimization — the store itself must still be saved.
    }
  }
  return chunks;
}

// Write the canonical store to IndexedDB, one record per day, diffed against
// the previous write. `force` bypasses the diff (used by "save as my data").
async function writeUserStoreChunks(canonicalStore, { force = false } = {}) {
  // Belt-and-braces: in recovery mode the on-screen store is a fallback view,
  // and the per-day diff would DELETE days missing from it. Only an explicit,
  // confirmed force-save (保存為我的資料) may write.
  if (storeRecoveryMode && !force) return;
  const chunks = buildUserStoreChunks(canonicalStore);
  const serialized = new Map();
  for (const [dateKey, record] of chunks)
    serialized.set(dateKey, JSON.stringify(record));

  const toPut = [];
  for (const [dateKey, text] of serialized) {
    if (force || userStoreWrittenChunks.get(dateKey) !== text)
      toPut.push([dateKey, chunks.get(dateKey)]);
  }
  const toDelete = [];
  for (const dateKey of userStoreWrittenChunks.keys()) {
    if (!serialized.has(dateKey)) toDelete.push(dateKey);
  }
  // When the diff baseline is empty (fresh boot in sample mode, or a forced
  // save), stale days from an older session may still exist in the DB. A
  // forced write clears the store first so the result is exactly `chunks`.
  const meta = {
    schema_version: canonicalStore.schema_version || SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    dates: [...serialized.keys()],
  };

  const db = await openUserStoreDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(
        [USER_STORE_DATES_STORE, USER_STORE_META_STORE],
        "readwrite",
      );
      const dateStore = tx.objectStore(USER_STORE_DATES_STORE);
      const run = () => {
        for (const dateKey of toDelete) dateStore.delete(dateKey);
        for (const [dateKey, record] of toPut) dateStore.put(record, dateKey);
        if (serialized.size) {
          tx.objectStore(USER_STORE_META_STORE).put(meta, USER_STORE_META_KEY);
        } else {
          tx.objectStore(USER_STORE_META_STORE).delete(USER_STORE_META_KEY);
        }
      };
      if (force) {
        const clearReq = dateStore.clear();
        clearReq.onsuccess = run;
      } else {
        run();
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error || new Error("Could not write the user store."));
      tx.onabort = () =>
        reject(tx.error || new Error("User store write was aborted."));
    });
  } finally {
    db.close();
  }
  userStoreWrittenChunks = serialized;
}

// Read the whole user store back. Returns null when nothing is saved (or the
// saved data is unreadable), so callers can fall back to the sample.
// `routes` collects every day's cached geometry for seeding the runtime cache.
async function readUserStoreAll() {
  let db;
  try {
    db = await openUserStoreDb();
  } catch (err) {
    console.warn("User store unavailable (IndexedDB).", err);
    return null;
  }
  try {
    const { meta, records } = await new Promise((resolve, reject) => {
      const tx = db.transaction(
        [USER_STORE_DATES_STORE, USER_STORE_META_STORE],
        "readonly",
      );
      const metaReq = tx
        .objectStore(USER_STORE_META_STORE)
        .get(USER_STORE_META_KEY);
      const recordsByKey = new Map();
      const cursorReq = tx.objectStore(USER_STORE_DATES_STORE).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          recordsByKey.set(String(cursor.key), cursor.value);
          cursor.continue();
        }
      };
      tx.oncomplete = () =>
        resolve({ meta: metaReq.result || null, records: recordsByKey });
      tx.onerror = () =>
        reject(tx.error || new Error("Could not read the user store."));
    });
    if (!records.size) return null;
    // Reassemble in the order the days were written (meta), falling back to
    // ascending date order for any record the meta list doesn't know about.
    const orderedKeys = [];
    const seen = new Set();
    for (const key of (meta && meta.dates) || []) {
      if (records.has(key) && !seen.has(key)) {
        orderedKeys.push(key);
        seen.add(key);
      }
    }
    for (const key of [...records.keys()].sort()) {
      if (!seen.has(key)) orderedKeys.push(key);
    }
    const trains = [];
    const routes = [];
    const chunkTexts = new Map();
    for (const key of orderedKeys) {
      const record = records.get(key);
      if (!record || !Array.isArray(record.trains)) continue;
      trains.push(...record.trains);
      if (Array.isArray(record.routes)) routes.push(...record.routes);
      chunkTexts.set(key, JSON.stringify(record));
    }
    if (!trains.length) return null;
    // Seed the write-diff baseline so the first autosave after a restore only
    // rewrites days that actually changed.
    userStoreWrittenChunks = chunkTexts;
    return {
      store: {
        schema_version:
          (meta && meta.schema_version) || SCHEMA_VERSION,
        trains,
      },
      routes,
    };
  } catch (err) {
    console.warn("Could not read the user store from IndexedDB.", err);
    return null;
  } finally {
    db.close();
  }
}

async function clearUserStore() {
  const db = await openUserStoreDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(
        [USER_STORE_DATES_STORE, USER_STORE_META_STORE],
        "readwrite",
      );
      tx.objectStore(USER_STORE_DATES_STORE).clear();
      tx.objectStore(USER_STORE_META_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error || new Error("Could not clear the user store."));
    });
  } finally {
    db.close();
  }
  userStoreWrittenChunks = new Map();
  userStoreAvailable = false;
}

// Seed the runtime route cache from stored user-route entries (same contract
// as seedRouteCacheFromPart, minus the part wrapper).
function seedRouteCacheEntries(routes) {
  if (!Array.isArray(routes)) return;
  for (const route of routes) {
    if (!route || typeof route.cache_key !== "string" || !route.cache_key)
      continue;
    if (route.unsolvable === true) {
      runtimeRouteNegativeCache.add(route.cache_key);
    } else if (
      Array.isArray(route.features) &&
      route.features.length &&
      !runtimeRouteCache.has(route.cache_key)
    ) {
      runtimeRouteCache.set(route.cache_key, route.features);
    }
  }
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
  // Guard against namespacing the persistent route cache by a hash of ZERO
  // features: every caller runs after ensureSolverReady(), but if one ever
  // slips in early, failing loud beats silently caching under a bogus key.
  if (!railSectionsGeoJson)
    throw new Error(
      "rail-sections not loaded yet; await ensureSolverReady() before touching the route cache.",
    );
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

