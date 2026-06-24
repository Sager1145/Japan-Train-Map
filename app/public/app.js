const LOCAL_JSON_FILENAME = "n02-train-store.json";
    // The server-side data/train-store.json (served at /api/train-store) is now
    // the single source of truth: the editor auto-saves there and loads from it
    // on every boot, replacing the old browser-localStorage backup.
    const TRAIN_STORE_API = "train-store";
    const SERVER_AUTOSAVE_DEBOUNCE_MS = 450;
    const FILE_HANDLE_DB_NAME = "n02-train-store-file-handle-db";
    const FILE_HANDLE_STORE_NAME = "handles";
    const FILE_HANDLE_KEY = "local-json-file-handle";
    const JAPAN_MAIN_ISLANDS_BOUNDS = [[30.85, 129.1], [45.75, 146.2]];

    // Single source of truth for protocol/schema constants reused across the app.
    const SCHEMA_VERSION = "1.2";
    const DEFAULT_TRAIN_COLOR = "#d9364f";
    // Single source of truth for the default route style numbers. Previously the
    // literals 6 and 0.22 were repeated across the canonical serializer, editor,
    // field save, blank-train factory and renderer.
    const DEFAULT_TRAIN_WEIGHT = 6;
    const DEFAULT_UNRIDDEN_OPACITY = 0.22;
    const DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES = ["1", "2", "3", "4", "5"];
    const N02_INSTITUTION_TYPE_CODES = new Set(DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES);

    // Document-relative (not root-absolute) so every API call — including the
    // train-store save/load — resolves next to index.html. This keeps the app
    // working when it is served from a sub-path (e.g. behind a reverse proxy at
    // /something/) instead of only from the domain root.
    const API_BASE = "./api";
    const fetchJson = async (path) => {
      const res = await fetch(`${API_BASE}/${path}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status} ${res.statusText}`);
      return res.json();
    };

    // Data is now served by the backend instead of being embedded in the page.
    let railSectionsGeoJson, stationsGeoJson, defaultTrainStore, matchedRoutesGeoJson, matchedStopsGeoJson;
    let stationCandidatesIndex;

    async function loadAppData() {
      [
        railSectionsGeoJson,
        stationsGeoJson,
        defaultTrainStore,
        matchedRoutesGeoJson,
        matchedStopsGeoJson
      ] = await Promise.all([
        fetchJson("rail-sections"),
        fetchJson("stations"),
        fetchJson("default-trains"),
        fetchJson("matched-routes"),
        fetchJson("matched-stops")
      ]);

      stationCandidatesIndex = buildStationCandidatesIndex(stationsGeoJson);
    }
    let trainStore = { schema_version: SCHEMA_VERSION, trains: [] };
    let selectedTrainId = null;
    let focusedTrainId = null;
    let map, railSectionLayer, stationLayer, limitedExpressRouteLayer, stopLayer, passThroughLayer, limitedExpressRouteRenderer;
    let importInProgress = false;

    const els = {
      list: document.getElementById("train-list"),
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
      name: document.getElementById("field-name"),
      direction: document.getElementById("field-direction"),
      origin: document.getElementById("field-origin"),
      destination: document.getElementById("field-destination"),
      color: document.getElementById("field-color"),
      weight: document.getElementById("field-weight")
    };

    document.addEventListener("DOMContentLoaded", async () => {
      try {
        await loadAppData();
      } catch (err) {
        console.error(err);
        const status = document.getElementById("import-status");
        if (status) {
          // Use the shared status helper so this critical failure gets the same
          // ".status err" styling as every other error path (the CSS only
          // defines .status.err, not .status.error).
          setStatus(status, `資料載入失敗：${err.message}`, "err");
        }
        return;
      }
      initMap();
      bindEvents();
      fitJapanMainIslands();
      renderAll();

      // Boot from the server-saved store; if nothing has been saved yet, fall
      // back to the built-in defaults (and do not persist them until edited).
      const savedStore = await loadTrainStoreFromServer();
      await replaceTrainStoreFromStoreProgressive(
        savedStore || getDefaultTrainStore(),
        savedStore ? "伺服器保存的 train-store.json" : "內建預設 JSON",
        { persistEachStep: false, finalPersist: false }
      );
      if (!savedStore) {
        setStatus(els.importStatus, "尚未有保存的 train-store.json，已載入內建預設資料。編輯後會自動保存到伺服器。", "warn");
      }

      // Warm up the heavy N02 routing graph in the background so the first local
      // JSON open / import doesn't pay that one-time build cost synchronously
      // (which would freeze the UI mid-open).
      scheduleRouteGraphPrebuild();
    });

    // Build the (expensive, one-time) N02 routing graph during browser idle time
    // instead of lazily on the first route solve. getRuntimeRouteGraph() is
    // memoized, so this is a no-op if the boot store already triggered the build.
    function scheduleRouteGraphPrebuild() {
      const prebuild = () => {
        try {
          getRuntimeRouteGraph();
        } catch (err) {
          console.warn("Route graph prebuild failed; it will be built lazily on first use.", err);
        }
      };
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(prebuild, { timeout: 3000 });
      } else {
        setTimeout(prebuild, 0);
      }
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function stationName(feature) {
      return feature.properties.station_name || feature.properties.name || feature.properties.N02_005 || feature.properties.station || feature.properties.id;
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
        stationLookupKeys(stationName(feature), stationCode(feature)).forEach((key) => {
          if (!index.has(key)) index.set(key, []);
          index.get(key).push(feature);
        });
      });
      return index;
    }

    function resolveStation(stopOrName) {
      return resolveStationCandidates(stopOrName)[0] || null;
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

    // Train-aware single-station resolution. Unlike resolveStation (which blindly
    // returns the first by-name candidate), this prefers candidates in the train's
    // allowed institution class and, when a name is still ambiguous, picks the one
    // nearest the train's anchor stops. With no train context it behaves exactly like
    // resolveStation, so existing callers are unaffected.
    function resolveStationForTrain(stopOrName, train) {
      const candidates = resolveStationCandidates(stopOrName);
      if (candidates.length <= 1) return candidates[0] || null;

      const allowedCodes = train ? getAllowedInstitutionTypeCodes(train) : null;
      const preferred = allowedCodes ? filterStationsByPreferredInstitution(candidates, allowedCodes) : [];
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
      const name = typeof stopOrName === "string" ? stopOrName : stopName(stopOrName);
      const code = typeof stopOrName === "string" ? null : stopStationCode(stopOrName);
      const cleanName = name ? String(name).trim() : "";
      const cleanCode = code ? String(code).trim() : "";

      // A station code is line-specific in N02.  Do not union code matches with
      // same-name matches, otherwise an inconsistent imported pair such as
      // { name: "千葉", n02_station_code: "003859" } can mix 越中島 and 千葉
      // candidates and make Dijkstra jump to the wrong city/line.
      const normalizedQueryName = normalizeStationName(cleanName);
      const codeCandidates = cleanCode ? dedupeStationFeatures(stationCandidatesIndex.get(cleanCode) || []) : [];
      if (codeCandidates.length) {
        if (!cleanName) return codeCandidates;
        const codeAndNameCandidates = codeCandidates.filter((feature) => normalizeStationName(stationName(feature)) === normalizedQueryName);
        if (codeAndNameCandidates.length) return codeAndNameCandidates;
        console.warn("N02 station code/name mismatch; falling back to station name candidates.", {
          name: cleanName,
          n02_station_code: cleanCode,
          code_candidates: codeCandidates.map((feature) => ({
            name: stationName(feature),
            n02_station_code: stationCode(feature),
            line_name: stationLineName(feature),
            operator: stationOperator(feature)
          }))
        });
      }

      // Try the exact name first, then the normalized alias (handles ケ/ヶ, width).
      const nameCandidates = cleanName
        ? dedupeStationFeatures(
            stationCandidatesIndex.get(cleanName)
            || stationCandidatesIndex.get(normalizedQueryName)
            || []
          )
        : [];
      return nameCandidates.length ? nameCandidates : codeCandidates;
    }

    function getDefaultTrainStore() {
      return {
        schema_version: SCHEMA_VERSION,
        trains: (defaultTrainStore.trains || []).map(normalizeExportTrain)
      };
    }

    // Persist every change to the server-side store (debounced). This is the
    // single source of truth that replaces the old localStorage backup.
    function saveTrainStore() {
      scheduleServerStoreSave(exportTrainStore());
    }

    let serverStoreSaveTimer = null;
    let serverStoreSaveInFlight = false;
    let pendingServerStoreText = null;

    function scheduleServerStoreSave(jsonText = exportTrainStore()) {
      pendingServerStoreText = jsonText;
      clearTimeout(serverStoreSaveTimer);
      serverStoreSaveTimer = setTimeout(() => flushServerStoreSave(), SERVER_AUTOSAVE_DEBOUNCE_MS);
    }

    async function flushServerStoreSave() {
      if (serverStoreSaveInFlight) return;
      if (pendingServerStoreText === null) return;
      serverStoreSaveInFlight = true;
      const jsonText = pendingServerStoreText;
      pendingServerStoreText = null;
      try {
        const res = await fetch(`${API_BASE}/${TRAIN_STORE_API}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: jsonText
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        setStatus(els.jsonStatus, "已自動保存到伺服器 train-store.json。", "ok");
      } catch (error) {
        console.warn("Autosave to server train-store failed.", error);
        setStatus(els.jsonStatus, `自動保存到伺服器失敗：${error.message}`, "warn");
      } finally {
        serverStoreSaveInFlight = false;
        // A newer change may have arrived while this request was in flight.
        if (pendingServerStoreText !== null) flushServerStoreSave();
      }
    }

    // Load the saved store from the server. Returns null when nothing has been
    // saved yet (HTTP 404) or the saved data is unreadable, so the caller can
    // fall back to the built-in defaults.
    async function loadTrainStoreFromServer() {
      try {
        const res = await fetch(`${API_BASE}/${TRAIN_STORE_API}`, { cache: "no-store" });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const parsed = await res.json();
        validateTrainStore(parsed);
        return parsed;
      } catch (error) {
        console.warn("Could not load saved train store from server; using defaults.", error);
        return null;
      }
    }

    let localJsonFileHandle = null;

    function supportsFileSystemAccess() {
      return typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function";
    }

    function openFileHandleDb() {
      return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          reject(new Error("IndexedDB is unavailable."));
          return;
        }
        const request = indexedDB.open(FILE_HANDLE_DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(FILE_HANDLE_STORE_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not open IndexedDB."));
      });
    }

    async function idbSetValue(key, value) {
      const db = await openFileHandleDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(FILE_HANDLE_STORE_NAME, "readwrite");
        tx.objectStore(FILE_HANDLE_STORE_NAME).put(value, key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error || new Error("Could not write IndexedDB.")); };
      });
    }

    async function idbDeleteValue(key) {
      const db = await openFileHandleDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(FILE_HANDLE_STORE_NAME, "readwrite");
        tx.objectStore(FILE_HANDLE_STORE_NAME).delete(key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error || new Error("Could not delete IndexedDB value.")); };
      });
    }

    async function storeFileHandle(handle) {
      if (!supportsFileSystemAccess() || !handle) return;
      try {
        await idbSetValue(FILE_HANDLE_KEY, handle);
      } catch (error) {
        console.warn("Could not persist file handle.", error);
      }
    }

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

    async function writeLocalJsonFile(jsonText = exportTrainStore(), promptIfMissing = true) {
      if (!supportsFileSystemAccess()) {
        downloadText(LOCAL_JSON_FILENAME, jsonText, "application/json");
        setStatus(els.jsonStatus, "此瀏覽器不支援直接寫入本地檔案，已改為下載 JSON。", "warn");
        return false;
      }

      if (!localJsonFileHandle && promptIfMissing) {
        localJsonFileHandle = await window.showSaveFilePicker({
          suggestedName: LOCAL_JSON_FILENAME,
          types: [{ description: "Train store JSON", accept: { "application/json": [".json"] } }]
        });
        await storeFileHandle(localJsonFileHandle);
      }

      if (!localJsonFileHandle) return false;
      if (!await verifyFileHandlePermission(localJsonFileHandle, true)) {
        throw new Error("沒有本地 JSON 的寫入權限。");
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
          types: [{ description: "Train store JSON", accept: { "application/json": [".json"] } }]
        });
        if (!handle) return;
        localJsonFileHandle = handle;
        await storeFileHandle(handle);
        const file = await handle.getFile();
        // replaceTrainStoreFromJsonText() already finishes with finalizeProgressiveLoad()
        // -> renderAll(), so an extra renderAll() here is a redundant full repaint
        // (and full store re-serialization). Don't double-render.
        await replaceTrainStoreFromJsonText(await file.text(), `本地 JSON：${file.name}`);
        return;
      }

      els.localJsonFileInput.value = "";
      els.localJsonFileInput.click();
    }

    // Clear the in-memory store and selection before a full progressive reload.
    // Shared by the two "replace" import paths so the reset has one definition.
    function resetTrainStoreForProgressiveLoad() {
      trainStore = { schema_version: SCHEMA_VERSION, trains: [] };
      selectedTrainId = null;
      focusedTrainId = null;
      renderAll();
    }

    // Shared per-train progressive append loop. Every import/restore path runs the
    // same append -> (optional persist) -> repaint -> progress -> yield sequence;
    // keeping it here means a change to that ordering only has to be made once.
    // Repaint the map/list at most once per this many appended trains during an
    // import. The previous code repainted and re-serialized the entire store on
    // every single train, which made importing N trains O(N^2). Now appends are
    // O(N); the user still sees periodic progress, and one authoritative repaint
    // + persist happens when the loop finishes.
    const PROGRESSIVE_APPEND_REPAINT_BATCH = 25;

    async function runProgressiveAppend(trains, { persistEachStep = true, onProgress } = {}) {
      const appendedIds = [];
      const total = trains.length;
      for (let index = 0; index < total; index += 1) {
        const id = appendImportedTrain(trains[index]);
        appendedIds.push(id);
        if (onProgress) onProgress({ count: appendedIds.length, total, id });

        // Fix #2: yield to the browser, then solve THIS train's route off the
        // render path. Spreading the (cached or freshly solved) route work one
        // train per frame keeps the page responsive and the progress bar moving,
        // instead of solving a whole batch synchronously inside renderAll().
        await waitForImportPaint();
        warmRouteCacheForTrain(getTrain(id));

        // Repaint only on batch boundaries; routes are already cached by the
        // warm-up above, so these renders do cheap lookups, not Dijkstra.
        const isLast = index === total - 1;
        if (!isLast && (index + 1) % PROGRESSIVE_APPEND_REPAINT_BATCH === 0) {
          renderAll({ updateJsonTextarea: false });
        }
      }
      // Single full repaint + persist for the whole batch.
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
        console.warn(`Route warm-up failed for ${train?.id}; will retry on render.`, err);
      }
    }

    // Re-select the first imported train, re-validate the canonical store and
    // (optionally) persist. Shared tail of the two "replace" import paths.
    function finalizeProgressiveLoad(appendedIds, { finalPersist = true } = {}) {
      selectedTrainId = appendedIds[0] || null;
      focusedTrainId = null;
      validateTrainStore(buildCanonicalTrainStore());
      if (finalPersist) saveTrainStore();
      renderAll();
    }

    async function replaceTrainStoreFromJsonText(jsonText, sourceLabel = "JSON") {
      if (importInProgress) {
        console.warn("A progressive load/import is already running; ignoring concurrent replaceTrainStoreFromJsonText.");
        return;
      }
      importInProgress = true;
      try {
        const importedStore = parseImportedCanonicalStore(jsonText);
        const total = importedStore.trains.length;
        if (!total) throw new Error(`${sourceLabel} contains no trains.`);

        resetTrainStoreForProgressiveLoad();
        setImportProgress(0, total, `準備逐條載入 ${sourceLabel}：0/${total}`);

        const appendedIds = await runProgressiveAppend(importedStore.trains, {
          persistEachStep: true,
          onProgress: ({ count, total: t, id }) => {
            setImportProgress(count, t, `正在逐條載入 ${sourceLabel}：${count}/${t}：${id}`);
            setStatus(els.importStatus, `正在逐條載入 ${sourceLabel}：${count}/${t}：${id}`, "ok");
          }
        });

        finalizeProgressiveLoad(appendedIds, { finalPersist: true });
        setStatus(els.importStatus, `已逐條載入 ${sourceLabel}，共 ${total} 趟列車。`, "ok");
        setImportProgress(total, total, `完成：${total} 趟列車`);
      } finally {
        importInProgress = false;
      }
    }

    async function replaceTrainStoreFromStoreProgressive(store, sourceLabel = "JSON", options = {}) {
      if (importInProgress) {
        console.warn("A progressive load/import is already running; ignoring concurrent replaceTrainStoreFromStoreProgressive.");
        return { count: 0, ids: [] };
      }
      importInProgress = true;
      try {
        const importedStore = parseImportedCanonicalStore(JSON.stringify(store || { trains: [] }));
        const total = importedStore.trains.length;
        if (!total) {
          renderAll();
          return { count: 0, ids: [] };
        }

        const persistEachStep = Boolean(options.persistEachStep);
        const finalPersist = options.finalPersist !== false;

        resetTrainStoreForProgressiveLoad();
        setImportProgress(0, total, `準備逐條載入 ${sourceLabel}：0/${total}`);
        setStatus(els.importStatus, `正在從 ${sourceLabel} 逐條恢復列車：0/${total}`, "ok");

        const appendedIds = await runProgressiveAppend(importedStore.trains, {
          persistEachStep,
          onProgress: ({ count, total: t, id }) => {
            setImportProgress(count, t, `正在逐條載入 ${sourceLabel}：${count}/${t}：${id}`);
            setStatus(els.importStatus, `正在從 ${sourceLabel} 逐條恢復列車：${count}/${t}：${id}`, "ok");
          }
        });

        finalizeProgressiveLoad(appendedIds, { finalPersist });
        setImportProgress(total, total, `完成：${total} 趟列車`);
        setStatus(els.importStatus, `已從 ${sourceLabel} 逐條恢復 ${total} 趟列車。`, "ok");
        return { count: appendedIds.length, ids: appendedIds };
      } finally {
        importInProgress = false;
      }
    }


    function addTrain(train) {
      const base = train || createBlankTrain();
      const candidate = clone(base);
      candidate.id = uniqueId(candidate.id || "LE");
      trainStore.trains.push(candidate);
      selectedTrainId = candidate.id;
      focusedTrainId = candidate.id;
      persistAndRender();
    }

    function updateTrain(trainId, patchOrFullTrain) {
      const index = trainStore.trains.findIndex((t) => t.id === trainId);
      if (index < 0) return;
      const current = trainStore.trains[index];
      trainStore.trains[index] = patchOrFullTrain.id ? patchOrFullTrain : { ...current, ...patchOrFullTrain };
      selectedTrainId = trainStore.trains[index].id;
      if (focusedTrainId === trainId || focusedTrainId === current.id) focusedTrainId = selectedTrainId;
      persistAndRender();
    }

    function duplicateTrain(trainId) {
      const train = getTrain(trainId);
      if (!train) return;
      const copy = clone(train);
      copy.id = uniqueId(`${train.id}-copy`);
      copy.name = `${train.name || "Train"} Copy`;
      trainStore.trains.push(copy);
      selectedTrainId = copy.id;
      focusedTrainId = copy.id;
      persistAndRender();
    }

    function deleteTrain(trainId) {
      const index = trainStore.trains.findIndex((t) => t.id === trainId);
      if (index < 0) return;
      trainStore.trains.splice(index, 1);
      selectedTrainId = trainStore.trains[Math.min(index, trainStore.trains.length - 1)]?.id || null;
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
      persistAndRender();
    }

    function moveTrain(trainId, direction) {
      const index = trainStore.trains.findIndex((t) => t.id === trainId);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= trainStore.trains.length) return;
      const [train] = trainStore.trains.splice(index, 1);
      trainStore.trains.splice(next, 0, train);
      persistAndRender();
    }

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
        ride_segment: Boolean(stop.ride_segment)
      };
    }

    function canonicalStyle(style) {
      return {
        color: style?.color || DEFAULT_TRAIN_COLOR,
        weight: Number(style?.weight || DEFAULT_TRAIN_WEIGHT),
        unridden_opacity: Number(style?.unridden_opacity ?? DEFAULT_UNRIDDEN_OPACITY)
      };
    }

    function canonicalRoutePolicy(routePolicy) {
      return {
        mode: "single_primary_route",
        jr_only: routePolicy?.jr_only === true,
        allow_alternatives: false,
        allow_browser_straight_line_fallback: false,
        allowed_institution_type_codes: routePolicy?.allowed_institution_type_codes || [...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES],
        preferred_line_names: Array.isArray(routePolicy?.preferred_line_names) ? routePolicy.preferred_line_names.map(String).filter(Boolean) : [],
        preferred_operator_names: Array.isArray(routePolicy?.preferred_operator_names) ? routePolicy.preferred_operator_names.map(String).filter(Boolean) : [],
        institution_filter_mode: routePolicy?.institution_filter_mode || "soft"
      };
    }

    function normalizeExportRouteSection(section) {
      const normalized = {
        from: section.from || "",
        to: section.to || "",
        from_n02_station_code: section.from_n02_station_code || null,
        to_n02_station_code: section.to_n02_station_code || null
      };
      if (Array.isArray(section.line_names) && section.line_names.length) normalized.line_names = [...section.line_names];
      if (Array.isArray(section.operator_names) && section.operator_names.length) normalized.operator_names = [...section.operator_names];
      return normalized;
    }

    function getRideRouteSectionsForTrain(train) {
      const stops = train?.stops || [];
      const sections = Array.isArray(train?.route_sections) ? train.route_sections : [];
      const calculated = [];

      for (let index = 0; index < stops.length - 1; index += 1) {
        const fromStop = stops[index];
        const toStop = stops[index + 1];
        const existing = findRouteSectionForStopPair(sections, fromStop, toStop, index);

        if (existing) {
          calculated.push(normalizeExportRouteSection(existing));
          continue;
        }

        const from = resolveStationForTrain(fromStop, train);
        const to = resolveStationForTrain(toStop, train);
        calculated.push({
          from: stopName(fromStop),
          to: stopName(toStop),
          from_n02_station_code: from ? stationCode(from) : fromStop.n02_station_code || null,
          to_n02_station_code: to ? stationCode(to) : toStop.n02_station_code || null
        });
      }

      return calculated;
    }

    function findRouteSectionForStopPair(sections, fromStop, toStop, preferredIndex) {
      const preferred = sections[preferredIndex];
      if (routeSectionMatchesStopPair(preferred, fromStop, toStop)) return preferred;
      return sections.find((section) => routeSectionMatchesStopPair(section, fromStop, toStop));
    }

    function routeSectionMatchesStopPair(section, fromStop, toStop) {
      if (!section) return false;
      const fromCode = stopStationCode(fromStop);
      const toCode = stopStationCode(toStop);
      const sectionFromCode = section.from_n02_station_code || null;
      const sectionToCode = section.to_n02_station_code || null;
      const codeMatches = Boolean(
        fromCode && toCode && sectionFromCode && sectionToCode &&
        String(fromCode) === String(sectionFromCode) &&
        String(toCode) === String(sectionToCode)
      );
      const nameMatches = Boolean(
        stopName(fromStop) && stopName(toStop) &&
        stopName(fromStop) === (section.from || "") &&
        stopName(toStop) === (section.to || "")
      );

      // N02 station codes are line-specific.  A stop can be displayed with one
      // line-code while the route_section intentionally uses another line-code
      // for the same physical station transfer/through-running point.  Treat a
      // same-name adjacent pair as the same route section instead of forcing the
      // stop code and route-section code to be identical.
      return codeMatches || nameMatches;
    }

    // Optional persisted route geometry (fix #1). Defensive: any malformed cache
    // is dropped (returns null) so it can be re-solved, never breaking the
    // export/import round-trip.
    function normalizeRouteGeometryCache(cache) {
      if (!cache || typeof cache !== "object" || Array.isArray(cache)) return null;
      if (typeof cache.key !== "string" || !cache.key) return null;
      if (!Array.isArray(cache.features) || !cache.features.length) return null;
      return { key: cache.key, features: cache.features };
    }

    function normalizeExportTrain(train) {
      const normalized = {
        id: train.id || "",
        number: train.number || "",
        name: train.name || "",
        origin: train.origin || "",
        destination: train.destination || "",
        direction: train.direction || "down",
        visible: train.visible !== false,
        style: canonicalStyle(train.style),
        route_policy: canonicalRoutePolicy(train.route_policy),
        route_sections: getRideRouteSectionsForTrain(train),
        stops: Array.isArray(train.stops) ? train.stops.map(canonicalStopShape) : []
      };
      const geometryCache = normalizeRouteGeometryCache(train.route_geometry_cache);
      if (geometryCache) normalized.route_geometry_cache = geometryCache;
      return normalized;
    }

    function buildCanonicalTrainStore() {
      return {
        schema_version: SCHEMA_VERSION,
        trains: trainStore.trains.map(normalizeExportTrain)
      };
    }

    function parseImportedCanonicalStore(json) {
      const parsed = typeof json === "string" ? JSON.parse(json) : json;

      if (Array.isArray(parsed)) {
        return { schema_version: SCHEMA_VERSION, trains: parsed };
      }

      if (!parsed || typeof parsed !== "object") {
        throw new Error("JSON root must be a store object, a trains array, or one train object.");
      }

      if (Array.isArray(parsed.trains)) {
        assertOnlyKeys(parsed, ["schema_version", "trains"], "Store");

        if (parsed.schema_version !== SCHEMA_VERSION) {
          throw new Error(`schema_version must be "${SCHEMA_VERSION}".`);
        }

        return parsed;
      }

      if (parsed.id && parsed.stops) {
        return { schema_version: SCHEMA_VERSION, trains: [parsed] };
      }

      throw new Error("JSON must contain a trains array, be a trains array, or be a single train object.");
    }

    function assertOnlyKeys(object, allowedKeys, label) {
      Object.keys(object || {}).forEach((key) => {
        if (!allowedKeys.includes(key)) throw new Error(`${label} contains unsupported field: ${key}.`);
      });
    }

    function normalizeImportedStop(stop) {
      if (!stop || typeof stop !== "object" || Array.isArray(stop)) {
        throw new Error("Each stop must be an object.");
      }

      assertOnlyKeys(stop, ["name", "n02_station_code", "arrival", "departure", "stop_type", "ride_segment"], "Stop");

      if (!("name" in stop)) {
        throw new Error("Each stop must contain name.");
      }

      return canonicalStopShape(stop);
    }

    function normalizeImportedRouteSection(section) {
      if (!section || typeof section !== "object" || Array.isArray(section)) {
        throw new Error("Each route_section must be an object.");
      }

      assertOnlyKeys(section, ["from", "to", "from_n02_station_code", "to_n02_station_code", "line_names", "operator_names", "operator_hints"], "Route section");

      return {
        from: section.from || "",
        to: section.to || "",
        from_n02_station_code: section.from_n02_station_code || null,
        to_n02_station_code: section.to_n02_station_code || null,
        line_names: Array.isArray(section.line_names) ? section.line_names.map(String).filter(Boolean) : [],
        operator_names: Array.isArray(section.operator_names || section.operator_hints)
          ? (section.operator_names || section.operator_hints).map(String).filter(Boolean)
          : []
      };
    }

    function normalizeImportedTrain(train) {
      if (!train || typeof train !== "object" || Array.isArray(train)) {
        throw new Error("Each train must be an object.");
      }

      assertOnlyKeys(train, ["id", "number", "name", "origin", "destination", "direction", "visible", "style", "route_policy", "route_sections", "stops", "route_geometry_cache"], "Train");

      if (!train.id) throw new Error("Each train must contain id.");
      if (!train.number) throw new Error(`Train ${train.id} must contain number.`);
      if (!train.name) throw new Error(`Train ${train.id} must contain name.`);
      if (!train.origin) throw new Error(`Train ${train.id} must contain origin.`);
      if (!train.destination) throw new Error(`Train ${train.id} must contain destination.`);
      if (!Array.isArray(train.stops) || train.stops.length < 2) {
        throw new Error(`Train ${train.id} must contain at least 2 stops.`);
      }

      const normalized = {
        id: train.id,
        number: train.number,
        name: train.name,
        origin: train.origin,
        destination: train.destination,
        direction: train.direction || "down",
        visible: train.visible !== false,
        style: canonicalStyle(train.style),
        route_policy: canonicalRoutePolicy(train.route_policy),
        route_sections: Array.isArray(train.route_sections)
          ? train.route_sections.map(normalizeImportedRouteSection)
          : [],
        stops: train.stops.map(normalizeImportedStop)
      };
      // Carry an optional persisted route geometry (fix #1) onto the in-memory
      // train so the first render can reuse it instead of solving.
      const geometryCache = normalizeRouteGeometryCache(train.route_geometry_cache);
      if (geometryCache) normalized.route_geometry_cache = geometryCache;
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

    function appendImportedTrain(rawTrain) {
      const train = normalizeImportedTrain(rawTrain);
      const existingIds = new Set(trainStore.trains.map((t) => t.id));
      train.id = makeUniqueTrainId(train.id, existingIds);

      const tempStore = buildCanonicalTrainStore();
      tempStore.trains.push(normalizeExportTrain(train));
      validateTrainStore(tempStore);

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
        console.warn("A progressive load/import is already running; ignoring concurrent import.");
        return { count: 0, ids: [] };
      }
      importInProgress = true;
      try {
        const importedStore = parseImportedCanonicalStore(json);

        if (!importedStore.trains.length) {
          throw new Error("Imported store contains no trains.");
        }

        if (onProgress) {
          onProgress({ count: 0, total: importedStore.trains.length, id: "準備載入" });
        }

        // Append mode: unlike the "replace" paths this does NOT reset the store.
        const appendedIds = await runProgressiveAppend(importedStore.trains, {
          persistEachStep: true,
          onProgress
        });

        return {
          count: appendedIds.length,
          ids: appendedIds
        };
      } finally {
        importInProgress = false;
      }
    }

    function createBlankTrain() {
      return {
        id: "LE",
        number: "",
        name: "New Limited Express",
        origin: "東京",
        destination: "熱海",
        direction: "down",
        visible: true,
        style: { color: "#1d7f8c", weight: DEFAULT_TRAIN_WEIGHT, unridden_opacity: DEFAULT_UNRIDDEN_OPACITY },
        route_policy: {
          mode: "single_primary_route",
          jr_only: false,
          allow_alternatives: false,
          allow_browser_straight_line_fallback: false,
          allowed_institution_type_codes: [...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES]
        },
        route_sections: [
          { from: "東京", to: "品川", from_n02_station_code: "003770", to_n02_station_code: "004095" },
          { from: "品川", to: "横浜", from_n02_station_code: "004095", to_n02_station_code: "004634" },
          { from: "横浜", to: "小田原", from_n02_station_code: "004634", to_n02_station_code: "005218" },
          { from: "小田原", to: "熱海", from_n02_station_code: "005218", to_n02_station_code: "005685" }
        ],
        stops: [
          { name: "東京", n02_station_code: "003770", arrival: null, departure: null, stop_type: "origin", ride_segment: true },
          { name: "熱海", n02_station_code: "005685", arrival: null, departure: null, stop_type: "destination", ride_segment: true }
        ]
      };
    }

    function uniqueId(seed) {
      // Collapse whitespace in interactive seeds (e.g. "LE-copy" from a name), then
      // delegate to the shared uniqueness loop used by the import path.
      const clean = String(seed || "train").trim().replace(/\s+/g, "-") || "train";
      return makeUniqueTrainId(clean, new Set(trainStore.trains.map((t) => t.id)));
    }

    function getTrain(id = selectedTrainId) {
      return trainStore.trains.find((t) => t.id === id);
    }

    function persistAndRender() {
      saveTrainStore();
      renderAll();
    }

    function initMap() {
      map = L.map("map", { preferCanvas: true }).setView([36.4, 138.2], 5);
      // Canvas (not SVG) for the train routes: with many trains the routes expand
      // into thousands of path segments, and an SVG DOM of that size makes every
      // pan/zoom and re-render slow. Canvas keeps interaction smooth; click/popup
      // still work via Leaflet's canvas renderer.
      limitedExpressRouteRenderer = L.canvas({ padding: 0.5 });

      const simpleOsmLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
        subdomains: "abcd",
        maxZoom: 20,
        attribution: "© OpenStreetMap contributors © CARTO"
      });
      const simpleOsmLabelLayer = L.layerGroup([
        L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
          subdomains: "abcd",
          maxZoom: 20,
          attribution: "© OpenStreetMap contributors © CARTO"
        }),
        L.tileLayer("https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png", {
          subdomains: "abcd",
          maxZoom: 20,
          attribution: "© OpenStreetMap contributors © CARTO",
          pane: "markerPane"
        })
      ]);
      const osmOnlineLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap contributors"
      });
      const localTileLayer = L.tileLayer("./tiles/{z}/{x}/{y}.png", {
        maxZoom: 14,
        attribution: "Local tiles / © OpenStreetMap contributors if derived from OSM"
      });
      const noBasemapLayer = L.layerGroup();

      railSectionLayer = L.geoJSON(railSectionsGeoJson, {
        style: () => ({ color: "#777", weight: 1, opacity: 0.45 }),
        onEachFeature: (feature, layer) => {
          const p = feature.properties || {};
          layer.bindPopup(buildRailPopup(p));
        }
      });

      stationLayer = L.layerGroup();
      L.geoJSON(stationsGeoJson, {
        style: () => ({ color: "#444", weight: 3, opacity: 0.35, dashArray: "3 4" }),
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(`${stationName(feature)} station geometry`);
          layer.bindPopup(buildStationPopup(feature));
        }
      }).addTo(stationLayer);
      stationsGeoJson.features.forEach((feature) => {
        L.circleMarker(toLatLng(feature), {
          radius: 4,
          color: "#444",
          weight: 1,
          fillColor: "#fff",
          fillOpacity: 0.85
        }).bindTooltip(stationName(feature)).bindPopup(buildStationPopup(feature)).addTo(stationLayer);
      });

      limitedExpressRouteLayer = L.layerGroup();
      stopLayer = L.layerGroup();
      passThroughLayer = L.layerGroup();

      simpleOsmLayer.addTo(map);
      railSectionLayer.addTo(map);
      limitedExpressRouteLayer.addTo(map);
      stopLayer.addTo(map);
      passThroughLayer.addTo(map);
      map.attributionControl.addAttribution('「国土数値情報（鉄道データ N02）」（国土交通省）を加工して作成');

      L.control.layers({
        "Simple OSM": simpleOsmLayer,
        "Simple OSM + Labels": simpleOsmLabelLayer,
        "OSM Standard": osmOnlineLayer,
        "Local Tiles": localTileLayer,
        "No Basemap": noBasemapLayer
      }, {
        "N02 Railway Sections": railSectionLayer,
        "N02 Stations": stationLayer,
        "Limited Express Routes": limitedExpressRouteLayer,
        "Stops": stopLayer,
        "Pass-through Stations": passThroughLayer
      }).addTo(map);
    }

    function bindEvents() {
      document.getElementById("add-train").addEventListener("click", () => addTrain());
      document.getElementById("duplicate-train").addEventListener("click", () => duplicateTrain(selectedTrainId));
      document.getElementById("delete-train").addEventListener("click", () => {
        if (selectedTrainId && confirm("Delete selected train?")) deleteTrain(selectedTrainId);
      });
      document.getElementById("delete-all-trains").addEventListener("click", () => {
        if (trainStore.trains.length && confirm("Delete all trains?")) {
          deleteAllTrains();
          setStatus(els.jsonStatus, "All trains deleted.", "warn");
        }
      });
      document.getElementById("fit-selected").addEventListener("click", () => fitTrainBounds(getTrain()));
      document.getElementById("clear-selection").addEventListener("click", () => {
        selectedTrainId = null;
        focusedTrainId = null;
        renderAll();
      });
      document.getElementById("save-fields").addEventListener("click", saveSelectedFields);
      document.getElementById("toggle-visible").addEventListener("click", () => toggleTrainVisibility(selectedTrainId));
      document.getElementById("move-up").addEventListener("click", () => moveTrain(selectedTrainId, -1));
      document.getElementById("move-down").addEventListener("click", () => moveTrain(selectedTrainId, 1));
      document.getElementById("add-stop").addEventListener("click", addStopToSelected);
      document.getElementById("rebuild-route").addEventListener("click", rebuildSelectedRoute);
      document.getElementById("open-local-json").addEventListener("click", async () => {
        try {
          fitJapanMainIslands();
          setImportProgress(0, 1, "正在打開本地 JSON...");
          await openLocalJsonFile();
          // Opening a local file replaces the store; persist it to the server now.
          await flushServerStoreSave();
        } catch (error) {
          setStatus(els.importStatus, error.message, "err");
        }
      });
      document.getElementById("save-local-json").addEventListener("click", async () => {
        try {
          await writeLocalJsonFile(exportTrainStore(), true);
          setStatus(els.jsonStatus, `已保存到 ${LOCAL_JSON_FILENAME}。`, "ok");
        } catch (error) {
          setStatus(els.jsonStatus, error.message, "err");
        }
      });
      els.localJsonFileInput.addEventListener("change", async () => {
        const file = els.localJsonFileInput.files?.[0];
        if (!file) return;
        try {
          // No trailing renderAll(): replaceTrainStoreFromJsonText() already
          // repaints once via finalizeProgressiveLoad().
          await replaceTrainStoreFromJsonText(await file.text(), `本地 JSON：${file.name}`);
        } catch (error) {
          setStatus(els.importStatus, error.message, "err");
        }
      });
      document.getElementById("validate-import-json").addEventListener("click", validateTextareaJson);
      document.getElementById("apply-import-json").addEventListener("click", async () => {
        // The progressive import owns the importInProgress lock; the handler only
        // pre-checks it (cheap reject) and disables the button against double-clicks.
        if (importInProgress) return;
        const applyButton = document.getElementById("apply-import-json");
        applyButton.disabled = true;
        try {
          fitJapanMainIslands();
          resetImportProgress();
          els.search.value = "";
          const result = await importCanonicalStoreAppendProgressive(els.importJson.value, ({ count, total, id }) => {
            setImportProgress(count, total, `正在逐條載入 ${count}/${total}：${id}`);
            setStatus(els.importStatus, `Imported ${count}/${total}: ${id}`, "ok");
          });
          setImportProgress(result.count, result.count, `完成：${result.count} 趟列車`);
          setStatus(
            els.importStatus,
            `Imported ${result.count} train(s): ${result.ids.join(", ")}`,
            "ok"
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
        setStatus(els.jsonStatus, "Current train store exported to textarea.", "ok");
      });
      document.getElementById("download-json").addEventListener("click", async () => {
        try {
          await writeLocalJsonFile(exportTrainStore(), true);
          setStatus(els.jsonStatus, `已保存到 ${LOCAL_JSON_FILENAME}。`, "ok");
        } catch (error) {
          setStatus(els.jsonStatus, error.message, "err");
        }
      });
      document.getElementById("download-html").addEventListener("click", () => downloadText("index.html", buildPortableHtml(), "text/html"));
      document.getElementById("reset-defaults").addEventListener("click", () => {
        trainStore = getDefaultTrainStore();
        selectedTrainId = trainStore.trains[0]?.id || null;
        focusedTrainId = null;
        persistAndRender();
        setStatus(els.jsonStatus, "Reset to embedded defaults.", "ok");
      });
      document.getElementById("clear-storage").addEventListener("click", async () => {
        try {
          // Cancel any pending autosave so it can't immediately re-create the file.
          clearTimeout(serverStoreSaveTimer);
          pendingServerStoreText = null;
          const res = await fetch(`${API_BASE}/${TRAIN_STORE_API}`, { method: "DELETE" });
          if (!res.ok && res.status !== 404) throw new Error(`${res.status} ${res.statusText}`);
          await deleteStoredFileHandle();
          setStatus(els.jsonStatus, "已清除伺服器保存的 train-store.json 與本地檔案授權。重新載入時會使用內建預設資料。", "warn");
        } catch (error) {
          setStatus(els.jsonStatus, `清除保存資料失敗：${error.message}`, "err");
        }
      });
      els.search.addEventListener("input", renderTrainList);
    }

    function renderAll({ updateJsonTextarea = true } = {}) {
      renderTrainList();
      renderEditor();
      renderTrainLayers();
      // Serializing the whole store to fill the export textarea is O(store size).
      // Callers in hot loops (progressive import) skip it and let the final
      // render populate the textarea once.
      if (updateJsonTextarea) els.json.value = exportTrainStore();
    }

    function renderTrainList() {
      const query = els.search.value.trim().toLowerCase();
      els.list.innerHTML = "";
      // Build the whole list in a detached fragment so the live DOM only reflows
      // once on insertion instead of once per train.
      const fragment = document.createDocumentFragment();
      trainStore.trains
        .filter((train) => !query || JSON.stringify(train).toLowerCase().includes(query))
        .forEach((train) => {
          const item = document.createElement("button");
          item.type = "button";
          item.className = `train-item${train.id === selectedTrainId ? " selected" : ""}${train.id === focusedTrainId ? " focused" : ""}`;
          item.innerHTML = `
            <span class="swatch" style="background:${escapeAttr(train.style?.color || DEFAULT_TRAIN_COLOR)}"></span>
            <span style="min-width:0">
              <span class="train-title">${escapeHtml(train.number || train.id)} ${escapeHtml(train.name || "")}</span>
              <span class="train-meta">${escapeHtml(train.origin || "?")} → ${escapeHtml(train.destination || "?")} · ${train.stops?.length || 0} stops</span>
            </span>
            <span class="train-meta">${train.visible === false ? "hidden" : "shown"}</span>
          `;
          item.addEventListener("click", () => {
            selectedTrainId = train.id;
            focusedTrainId = train.id;
            renderAll();
            fitTrainBounds(train);
          });
          fragment.appendChild(item);
        });
      els.list.appendChild(fragment);
    }

    function renderEditor() {
      const train = getTrain();
      const disabled = !train;
      [els.id, els.number, els.name, els.direction, els.origin, els.destination, els.color, els.weight].forEach((el) => el.disabled = disabled);
      document.getElementById("duplicate-train").disabled = disabled;
      document.getElementById("delete-train").disabled = disabled;
      document.getElementById("delete-all-trains").disabled = !trainStore.trains.length;
      document.getElementById("fit-selected").disabled = disabled;
      document.getElementById("clear-selection").disabled = !selectedTrainId && !focusedTrainId;
      document.getElementById("toggle-visible").disabled = disabled;
      if (!train) {
        els.id.value = els.number.value = els.name.value = els.direction.value = els.origin.value = els.destination.value = "";
        els.color.value = DEFAULT_TRAIN_COLOR;
        els.weight.value = DEFAULT_TRAIN_WEIGHT;
        els.stopsBody.innerHTML = "";
        return;
      }
      els.id.value = train.id || "";
      els.number.value = train.number || "";
      els.name.value = train.name || "";
      els.direction.value = train.direction || "";
      els.origin.value = train.origin || "";
      els.destination.value = train.destination || "";
      els.color.value = normalizeColor(train.style?.color || DEFAULT_TRAIN_COLOR);
      els.weight.value = train.style?.weight || DEFAULT_TRAIN_WEIGHT;
      renderStopsTable(train);
    }

    function renderStopsTable(train) {
      els.stopsBody.innerHTML = "";
      (train.stops || []).forEach((stop, index) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${index + 1}</td>
          <td><input data-stop-field="name" data-stop-index="${index}" value="${escapeAttr(stopName(stop))}"></td>
          <td><input data-stop-field="arrival" data-stop-index="${index}" value="${escapeAttr(stop.arrival ?? "")}"></td>
          <td><input data-stop-field="departure" data-stop-index="${index}" value="${escapeAttr(stop.departure ?? "")}"></td>
          <td>
            <select data-stop-field="stop_type" data-stop-index="${index}">
              ${["origin","passenger_stop","pass_through","operational_stop","destination"].map((type) => `<option value="${type}" ${stop.stop_type === type ? "selected" : ""}>${type}</option>`).join("")}
            </select>
          </td>
          <td>
            <input
              type="checkbox"
              data-stop-field="ride_segment"
              data-stop-index="${index}"
              ${stop.ride_segment ? "checked" : ""}
              title="此站是否按实际乘坐区间正常显示；关闭时站点和相邻区间淡色显示"
            >
          </td>
          <td class="stop-actions">
            <button class="icon" title="Move up" data-stop-action="up" data-stop-index="${index}">↑</button>
            <button class="icon" title="Move down" data-stop-action="down" data-stop-index="${index}">↓</button>
            <button class="icon danger" title="Delete" data-stop-action="delete" data-stop-index="${index}">×</button>
          </td>
        `;
        els.stopsBody.appendChild(tr);
      });

      els.stopsBody.querySelectorAll("[data-stop-field]").forEach((input) => {
        input.addEventListener("change", (event) => {
          const train = getTrain();
          const index = Number(event.target.dataset.stopIndex);
          const field = event.target.dataset.stopField;
          if (!train?.stops?.[index]) return;

          let refreshStopsTable = false;

          if (field === "ride_segment") {
            const enabled = event.target.checked;
            train.stops[index][field] = enabled;

            // Pass-through stops remain directly toggleable. When a real
            // stopping station is toggled, mirror that value to all
            // pass-through stops between it and the neighbouring stopping
            // stations on both sides. This keeps a disabled station from
            // leaving bright orphan through markers, and also restores the
            // same intermediate through-stops when the station is re-enabled.
            if (isStoppingStation(train.stops[index])) {
              refreshStopsTable = setAdjacentPassThroughStops(train, index, enabled);
            }
          } else {
            train.stops[index][field] = normalizeStopValue(field, event.target.value);
            refreshStopsTable = field === "stop_type";
          }

          if (field === "name") applyStationMetadata(train.stops[index], train);

          saveTrainStore();
          renderTrainLayers();
          els.json.value = exportTrainStore();
          if (refreshStopsTable) renderStopsTable(train);
        });
      });

      els.stopsBody.querySelectorAll("[data-stop-action]").forEach((button) => {
        button.addEventListener("click", () => mutateStop(Number(button.dataset.stopIndex), button.dataset.stopAction));
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
        name: els.name.value.trim(),
        direction: els.direction.value.trim(),
        origin: els.origin.value.trim(),
        destination: els.destination.value.trim(),
        style: {
          ...(train.style || {}),
          color: els.color.value,
          weight: Number(els.weight.value || DEFAULT_TRAIN_WEIGHT)
        }
      };
      try {
        const temp = clone(trainStore);
        temp.trains = temp.trains.map((t) => t.id === oldId ? next : t);
        validateTrainStore(temp);
        trainStore = temp;
        selectedTrainId = next.id;
        persistAndRender();
        setStatus(els.fieldStatus, "Fields saved.", "ok");
      } catch (error) {
        setStatus(els.fieldStatus, error.message, "err");
      }
    }

    function addStopToSelected() {
      const train = getTrain();
      if (!train) return;
      train.stops = train.stops || [];
      const stop = { name: train.destination || "", n02_station_code: null, arrival: null, departure: null, stop_type: "passenger_stop", ride_segment: true };
      applyStationMetadata(stop, train);
      train.stops.push(stop);
      persistAndRender();
    }

    function normalizeStopValue(field, value) {
      if ((field === "arrival" || field === "departure") && value.trim() === "") return null;
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
      const changedBefore = setPassThroughStopsBetween(stops, previousStopIndex, stopIndex, enabled);
      const changedAfter = setPassThroughStopsBetween(stops, stopIndex, nextStopIndex, enabled);
      return changedBefore || changedAfter;
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
      if (action === "up" && index > 0) [train.stops[index - 1], train.stops[index]] = [train.stops[index], train.stops[index - 1]];
      if (action === "down" && index < train.stops.length - 1) [train.stops[index + 1], train.stops[index]] = [train.stops[index], train.stops[index + 1]];
      persistAndRender();
    }

    function rebuildSelectedRoute() {
      const train = getTrain();
      if (!train) return;
      const stops = train.stops || [];

      train.route_sections = getRideRouteSectionsForTrain(train);

      persistAndRender();
      setStatus(
        els.fieldStatus,
        `Route sections rebuilt. ${train.route_sections.length} segment(s) calculated. Non-true stops/segments are rendered in pale color.`,
        "ok"
      );
    }

    function renderTrainLayers() {
      limitedExpressRouteLayer.clearLayers();
      stopLayer.clearLayers();
      passThroughLayer.clearLayers();

      const visibleTrains = trainStore.trains.filter((train) => train.visible !== false);
      const focusActive = Boolean(focusedTrainId && visibleTrains.some((train) => train.id === focusedTrainId));
      const orderedTrains = focusActive
        ? [...visibleTrains.filter((train) => train.id !== focusedTrainId), ...visibleTrains.filter((train) => train.id === focusedTrainId)]
        : visibleTrains;
      const splitForOverlap = !focusActive;
      const routeFeaturesByTrain = new Map(orderedTrains.map((train) => [train.id, getMatchedRouteFeatures(train)]));
      const overlapRecords = splitForOverlap
        ? orderedTrains.flatMap((train) => getRouteSegmentRecords(train, routeFeaturesByTrain.get(train.id) || []))
        : [];
      const overlapMap = splitForOverlap ? buildRouteOverlapMap(overlapRecords, orderedTrains) : new Map();
      const routeItems = orderedTrains.flatMap((train) => (
        getRouteRenderItems(train, splitForOverlap, routeFeaturesByTrain.get(train.id) || [], overlapMap)
      ));
      const routeItemsByTrain = groupRouteItemsByTrain(routeItems);

      orderedTrains.forEach((train) => {
        (routeItemsByTrain.get(train.id) || []).forEach((item) => {
          renderTrainRouteSegment(train, item.feature, {
            dimmed: focusActive && train.id !== focusedTrainId,
            focused: focusActive && train.id === focusedTrainId,
            overlap: item.overlapInfo || null
          }).addTo(limitedExpressRouteLayer);
        });
      });

      orderedTrains.forEach((train) => {
        const markerOptions = {
          dimmed: focusActive && train.id !== focusedTrainId,
          focused: focusActive && train.id === focusedTrainId
        };
        (train.stops || []).forEach((stop) => {
          const stopFeature = getStopFeature(stop, train);
          if (!stopFeature) return;
          if (stopFeature.properties.stop_type === "pass_through") renderPassThroughMarker(stopFeature, train, markerOptions).addTo(passThroughLayer);
          else renderStopMarker(stopFeature, train, markerOptions).addTo(stopLayer);
        });
        getComputedPassThroughFeatures(train).forEach((feature) => renderPassThroughMarker(feature, train, markerOptions).addTo(passThroughLayer));
      });
    }

    function getRouteRenderItems(train, splitForOverlap, features, overlapMap) {
      return features.flatMap((feature, featureIndex) => {
        if (!splitForOverlap) {
          return [{ train, feature, overlapInfo: null, featureIndex, unitIndex: 0 }];
        }

        return splitRouteFeatureIntoStyledRuns(train, feature, overlapMap).map((runFeature, unitIndex) => ({
          train,
          feature: runFeature,
          overlapInfo: runFeature.properties?.overlap_count > 1
            ? { count: runFeature.properties.overlap_count, slot: runFeature.properties.overlap_slot || 0 }
            : null,
          featureIndex,
          unitIndex
        }));
      });
    }

    function getRouteSegmentRecords(train, features) {
      const records = [];
      features.forEach((feature) => {
        iterateGeometryLines(feature.geometry).forEach((line) => {
          for (let index = 0; index < line.length - 1; index += 1) {
            const from = line[index];
            const to = line[index + 1];
            if (coordinatesEqual(from, to)) continue;
            records.push({ train, overlapKey: routeCoordinateSegmentKey(from, to) });
          }
        });
      });
      return records;
    }

    function splitRouteFeatureIntoStyledRuns(train, feature, overlapMap) {
      const runs = [];
      iterateGeometryLines(feature.geometry).forEach((line, lineIndex) => {
        let currentCoords = [];
        let currentStyleKey = "";
        let currentOverlapInfo = null;

        function flushRun() {
          if (currentCoords.length < 2) return;
          runs.push({
            type: "Feature",
            properties: {
              ...(feature.properties || {}),
              overlap_count: currentOverlapInfo?.count || 1,
              overlap_slot: currentOverlapInfo?.slot || 0,
              overlap_line_index: lineIndex
            },
            geometry: { type: "LineString", coordinates: currentCoords }
          });
        }

        for (let index = 0; index < line.length - 1; index += 1) {
          const from = line[index];
          const to = line[index + 1];
          if (coordinatesEqual(from, to)) continue;
          const overlapKey = routeCoordinateSegmentKey(from, to);
          const overlapInfo = getRouteOverlapInfoForKey(overlapKey, train.id, overlapMap);
          const styleKey = overlapInfo
            ? `overlap:${overlapInfo.count}:${overlapInfo.slot}`
            : (feature.properties?.ride_segment === true ? "ridden" : "unridden");

          if (!currentCoords.length) {
            currentCoords = [from, to];
            currentStyleKey = styleKey;
            currentOverlapInfo = overlapInfo;
            continue;
          }

          if (styleKey === currentStyleKey && coordinatesEqual(currentCoords[currentCoords.length - 1], from)) {
            currentCoords.push(to);
            continue;
          }

          flushRun();
          currentCoords = [from, to];
          currentStyleKey = styleKey;
          currentOverlapInfo = overlapInfo;
        }

        flushRun();
      });
      return runs;
    }

    function routeCoordinateSegmentKey(a, b) {
      return [coordKey(a), coordKey(b)].sort().join("|");
    }

    function groupRouteItemsByTrain(routeItems) {
      const grouped = new Map();
      routeItems.forEach((item) => {
        if (!grouped.has(item.train.id)) grouped.set(item.train.id, []);
        grouped.get(item.train.id).push(item);
      });
      return grouped;
    }

    function buildRouteOverlapMap(routeItems, orderedTrains) {
      const trainOrder = new Map(orderedTrains.map((train, index) => [train.id, index]));
      const overlapMap = new Map();

      routeItems.forEach((item) => {
        if (!item.overlapKey) return;
        if (!overlapMap.has(item.overlapKey)) {
          overlapMap.set(item.overlapKey, { trainIds: new Set(), slots: [] });
        }
        overlapMap.get(item.overlapKey).trainIds.add(item.train.id);
      });

      overlapMap.forEach((info) => {
        info.slots = [...info.trainIds].sort((a, b) => (trainOrder.get(a) ?? 0) - (trainOrder.get(b) ?? 0));
      });

      return overlapMap;
    }

    function getRouteOverlapInfoForKey(overlapKey, trainId, overlapMap) {
      const info = overlapMap.get(overlapKey);
      if (!info || info.trainIds.size < 2) return null;
      return {
        count: info.trainIds.size,
        slot: Math.max(0, info.slots.indexOf(trainId))
      };
    }

    function getComputedPassThroughFeatures(train) {
      const explicitKeys = new Set();
      (train.stops || []).forEach((stop) => stationLookupKeys(stopName(stop), stopStationCode(stop)).forEach((key) => explicitKeys.add(key)));
      const computed = [];
      const seen = new Set(explicitKeys);
      getRideRouteSectionsForTrain(train).forEach((section) => {
        [
          { name: section.from, n02_station_code: section.from_n02_station_code },
          { name: section.to, n02_station_code: section.to_n02_station_code }
        ].forEach((candidate) => {
          const station = resolveStationForTrain(candidate, train);
          if (!station) return;
          const keys = stationLookupKeys(stationName(station), stationCode(station));
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
              train_name: train.name,
              number: train.number,
              line_name: stationLineName(station),
              operator: stationOperator(station),
              source: "computed from route_sections"
            },
            geometry: { type: "Point", coordinates: getFeatureDisplayCoordinate(station) }
          });
        });
      });
      return computed;
    }

    function getTrainRouteTemplateKey(train) {
      return (train.route_sections || [])
        .map((section) => {
          const from = section.from_n02_station_code || section.from || "";
          const to = section.to_n02_station_code || section.to || "";
          const lines = (section.line_names || []).map(String).filter(Boolean).sort().join(",");
          const operators = (section.operator_names || section.operator_hints || []).map(String).filter(Boolean).sort().join(",");

          // line_names/operator_names change the route solver constraints, so they
          // must be part of the cache/template key.  Without this, editing only
          // line_names could incorrectly reuse an earlier path for the same endpoints.
          return `${from}->${to}|lines:${lines}|operators:${operators}`;
        })
        .join("|");
    }


    let runtimeRouteGraph = null;
    const runtimeRouteCache = new Map();
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

      const templateKey = getTrainRouteTemplateKey({ ...train, route_sections: routeSections });
      const allowedCodes = getAllowedInstitutionTypeCodes(train);
      const policyKey = [
        ...(train.route_policy?.preferred_line_names || []).map((value) => `line:${value}`),
        ...(train.route_policy?.preferred_operator_names || []).map((value) => `operator:${value}`),
        `institution_filter:${train.route_policy?.institution_filter_mode || "soft"}`
      ].sort().join("|");
      const cacheKey = `${allowedCodes.join(",")}|${policyKey}|${templateKey}`;
      if (runtimeRouteCache.has(cacheKey)) {
        const cached = runtimeRouteCache.get(cacheKey);
        return dedupeSameTrainRouteFeatures(cloneRouteFeaturesForTrain(cached, train));
      }

      // Fix #1: reuse geometry persisted in the train's JSON. If the train carries
      // a cached route whose key still matches its current sections/policy, seed
      // the in-memory cache from it and skip the expensive Dijkstra solve. Any
      // change to stops/sections/policy changes cacheKey, so a stale cache is
      // simply ignored and re-solved below.
      const persisted = train.route_geometry_cache;
      if (persisted && persisted.key === cacheKey && Array.isArray(persisted.features) && persisted.features.length) {
        runtimeRouteCache.set(cacheKey, persisted.features);
        return dedupeSameTrainRouteFeatures(cloneRouteFeaturesForTrain(persisted.features, train));
      }

      setStatus(els.fieldStatus, `Generating N02 railway route for ${train.number || train.id}...`, "warn");
      const graph = getRuntimeRouteGraph();
      const generated = [];
      const warnings = [];

      routeSections.forEach((section, segmentIndex) => {
        const result = solveRouteSectionOnN02Graph(section, segmentIndex, train, graph, allowedCodes);
        if (!result) {
          warnings.push(`${section.from || section.from_n02_station_code}→${section.to || section.to_n02_station_code}`);
          return;
        }
        generated.push(result);
      });

      if (!generated.length) {
        console.warn(`Unable to generate N02 railway route for train ${train.id}.`, warnings);
        setStatus(
          els.fieldStatus,
          `Unable to generate N02 railway route for ${train.number || train.id}. ${warnings.length} segment(s) failed.`,
          "warn"
        );
        return [];
      }

      const templateFeatures = generated.map((feature) => ({
        ...feature,
        properties: {
          ...(feature.properties || {}),
          train_id: "__template__",
          route_id: `${cacheKey}-primary`,
          route_template_key: templateKey
        }
      }));
      runtimeRouteCache.set(cacheKey, templateFeatures);
      // Fix #1: persist the freshly solved geometry onto the train so exporting /
      // auto-saving carries it and future opens can skip the solve entirely.
      train.route_geometry_cache = { key: cacheKey, features: templateFeatures };

      const concrete = dedupeSameTrainRouteFeatures(cloneRouteFeaturesForTrain(templateFeatures, train));
      concrete.forEach((feature) => matchedRoutesGeoJson.features.push(feature));

      setStatus(
        els.fieldStatus,
        `Generated ${concrete.length} N02 route segment(s) for ${train.number || train.id}${warnings.length ? `; ${warnings.length} segment(s) skipped.` : "."}`,
        warnings.length ? "warn" : "ok"
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
        const geometry = uniqueLines.length === 1
          ? { type: "LineString", coordinates: uniqueLines[0] }
          : { type: "MultiLineString", coordinates: uniqueLines };
        cleaned.push({
          ...feature,
          properties: { ...(feature.properties || {}), geometry_role: uniqueLines.length > 1 ? "single_path_with_gaps" : feature.properties?.geometry_role },
          geometry
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
          source: feature.properties?.source || "browser_dijkstra_on_embedded_n02_graph"
        }
      }));
    }

    function getAllowedInstitutionTypeCodes(train) {
      const explicit = train.route_policy?.allowed_institution_type_codes;
      const codes = Array.isArray(explicit) && explicit.length ? explicit.map(String) : [...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES];
      return [...new Set(codes)].sort();
    }

    function getRuntimeRouteGraph() {
      if (runtimeRouteGraph) return runtimeRouteGraph;

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
            railway_class_codes: new Set()
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
        const institution = String(properties?.N02_002 || properties?.institution_type_code || "");
        const railwayClass = String(properties?.N02_001 || properties?.railway_class_code || "");
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
          institution_type_code: String(properties?.N02_002 || properties?.institution_type_code || ""),
          railway_class_code: String(properties?.N02_001 || properties?.railway_class_code || ""),
          line_name: properties?.N02_003 || properties?.line_name || "",
          operator: properties?.N02_004 || properties?.operator || ""
        };
        adjacency.get(a).push(edge);
        adjacency.get(b).push({ ...edge, to: a });
      }

      // Python-equivalent rule: the routable graph is built ONLY from RailroadSection.
      // N02 Station LineString is used only for station snap candidates, never as a train-runnable edge.
      (railSectionsGeoJson.features || []).forEach((feature) => {
        const props = feature.properties || {};
        iterateGeometryLines(feature.geometry).forEach((line) => {
          for (let i = 0; i < line.length - 1; i += 1) addRailEdge(line[i], line[i + 1], props);
        });
      });

      const graph = {
        nodes,
        adjacency,
        grid,
        nodeMeta,
        cellSize,
        stationSnapCache: new Map()
      };
      addStationTransferConnectorEdges(graph);

      runtimeRouteGraph = graph;
      console.info(`Runtime N02 railroad-only route graph built: ${nodes.size} nodes.`);
      return runtimeRouteGraph;
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
      const hardFilter = train?.route_policy?.institution_filter_mode === "hard" || Boolean(segmentHints.requirePreferredInstitution);
      if (!hardFilter) return true;
      return edgeHasPreferredInstitution(edge, allowedCodes);
    }

    function institutionPreferencePenaltyForEdge(edge, allowedCodes, train) {
      if (train?.route_policy?.institution_filter_mode === "hard") return 0;
      const preferred = preferredInstitutionSet(allowedCodes);
      if (!preferred.size || !edge.institution_type_code || preferred.has(String(edge.institution_type_code))) return 0;
      return edge.length * NON_PREFERRED_INSTITUTION_LENGTH_FACTOR + NON_PREFERRED_INSTITUTION_EDGE_PENALTY;
    }

    function graphNodeHasPreferredInstitution(meta, allowedCodes) {
      const preferred = preferredInstitutionSet(allowedCodes);
      if (!preferred.size) return true;
      return intersects(meta?.institution_type_codes, preferred);
    }

    function addStationTransferConnectorEdges(graph) {
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
        if (!nearest || !nearest.key || nearest.distance > STATION_TRANSFER_MAX_SNAP_METERS) return;
        const existing = group.get(nearest.key);
        if (!existing || nearest.distance < existing.distance) {
          group.set(nearest.key, {
            key: nearest.key,
            distance: nearest.distance,
            station_name: stationName(feature),
            n02_group_code: stationGroupCode(feature),
            line_name: stationLineName(feature),
            operator: stationOperator(feature),
            institution_type_code: stationInstitutionTypeCode(feature)
          });
        }
      }

      (stationsGeoJson.features || []).forEach((feature) => {
        const key = stationTransferGroupKey(feature);
        const group = getGroup(key);
        const sourceLines = iterateGeometryLines(feature.geometry);
        const sourceCoords = sourceLines.length ? sourceLines.flat() : [getFeatureDisplayCoordinate(feature)];
        sourceCoords.forEach((coord) => {
          nearbyGraphNodes(coord, graph, STATION_TRANSFER_NODE_RADIUS_DEG, 30)
            .forEach((nearest) => rememberNode(group, nearest, feature));
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
        const institutionTypeCodes = [...new Set(
          [infoA?.institution_type_code, infoB?.institution_type_code].map((c) => String(c || "")).filter(Boolean)
        )];
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
          n02_group_code: infoA?.n02_group_code || ""
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
      return (features || []).filter((feature) => stationMatchesPreferredInstitution(feature, allowedCodes));
    }

    function stationSetFrom(features, getter) {
      return new Set((features || []).map(getter).filter((value) => value && value !== "-"));
    }

    function filterStationCandidatesNear(features, referenceFeatures, maxDistanceMeters = 1800) {
      if (!features?.length || !referenceFeatures?.length) return [];
      return (features || []).filter((feature) => {
        const coord = getFeatureDisplayCoordinate(feature);
        return (referenceFeatures || []).some((reference) => {
          const referenceCoord = getFeatureDisplayCoordinate(reference);
          return coord && referenceCoord && distanceMeters(coord, referenceCoord) <= maxDistanceMeters;
        });
      });
    }

    function resolveRouteEndpointStationCandidates(endpoint, train, allowedCodes) {
      const candidates = resolveStationCandidates(endpoint);
      const name = typeof endpoint === "string" ? endpoint : stopName(endpoint);
      const code = typeof endpoint === "string" ? null : stopStationCode(endpoint);
      if (!name || !code || !candidates.length) return candidates;

      const preferredCandidates = filterStationsByPreferredInstitution(candidates, allowedCodes);
      const sameNameCandidates = resolveStationCandidates({ name, n02_station_code: null });
      const sameNamePreferred = filterStationsByPreferredInstitution(sameNameCandidates, allowedCodes);
      const nearbySameNamePreferred = filterStationCandidatesNear(sameNamePreferred, candidates, 1800);

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

      const sameNamePreferredFallback = filterStationsByPreferredInstitution(sameNameCandidates, allowedCodes);
      if (!sameNamePreferredFallback.length) return candidates;

      console.warn("Route endpoint code resolves only to non-preferred institution; adding same-name preferred-institution candidates.", {
        train_id: train?.id,
        station: name,
        n02_station_code: code,
        allowed_institution_type_codes: allowedCodes,
        exact_candidates: candidates.map((feature) => ({
          name: stationName(feature),
          n02_station_code: stationCode(feature),
          line_name: stationLineName(feature),
          operator: stationOperator(feature),
          institution_type_code: stationInstitutionTypeCode(feature)
        })),
        preferred_same_name_candidates: sameNamePreferredFallback.map((feature) => ({
          name: stationName(feature),
          n02_station_code: stationCode(feature),
          line_name: stationLineName(feature),
          operator: stationOperator(feature),
          institution_type_code: stationInstitutionTypeCode(feature)
        }))
      });
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
      if (requiredLines.size && !requiredLines.has(edge.line_name || "")) return false;
      if (requiredOperators.size && !requiredOperators.has(edge.operator || "")) return false;
      return true;
    }

    function solveRouteSectionOnN02Graph(section, segmentIndex, train, graph, allowedCodes) {
      const fromStations = resolveRouteEndpointStationCandidates({ name: section.from, n02_station_code: section.from_n02_station_code }, train, allowedCodes);
      const toStations = resolveRouteEndpointStationCandidates({ name: section.to, n02_station_code: section.to_n02_station_code }, train, allowedCodes);

      if (!fromStations.length || !toStations.length) {
        console.warn("Route section endpoint station not found; segment skipped.", section);
        return null;
      }

      const baseHints = buildSegmentRouteHints(section, fromStations, toStations, train);
      const solveAttempts = buildSegmentRouteSolveAttempts(baseHints);

      let best = null;
      let usedHints = null;
      let lastCandidateFailure = false;

      for (const segmentHints of solveAttempts) {
        const fromCandidates = collectStationCandidateGraphNodes(fromStations, graph, segmentHints, allowedCodes).slice(0, 12);
        const toCandidates = collectStationCandidateGraphNodes(toStations, graph, segmentHints, allowedCodes).slice(0, 12);
        if (!fromCandidates.length || !toCandidates.length) {
          lastCandidateFailure = true;
          continue;
        }

        let attemptBest = null;
        fromCandidates.forEach((fromCandidate) => {
          toCandidates.forEach((toCandidate) => {
            const solved = dijkstraBetweenExactNodes(graph, fromCandidate.key, toCandidate.key, train, allowedCodes, segmentHints);
            if (!solved) return;
            const straight = distanceMeters(graph.nodes.get(fromCandidate.key), graph.nodes.get(toCandidate.key));
            const physicalLength = pathLengthMeters(graph, solved.pathKeys);
            const detourLimit = Math.max(straight * 3.8 + 6000, 12000);
            if (straight > 1500 && physicalLength > detourLimit) {
              console.warn("Rejected likely detour path.", { section, physicalLength, straight, detourLimit, hints: segmentHints });
              return;
            }
            // Snap distance is not a drawable route. Treat it as an error term, not
            // as a cheap substitute for real rail geometry. This prevents short
            // segments such as 成田空港→空港第2ビル from being truncated by choosing
            // two far-along station candidates whose Dijkstra path is only a few
            // dozen meters long.
            const snapPenalty = (fromCandidate.distance + toCandidate.distance) * STATION_SNAP_COST_FACTOR;
            const totalCost = solved.cost + snapPenalty;
            const linePenalty = routeLineMismatchPenalty(graph, solved.pathKeys, segmentHints);
            const scoredCost = totalCost + linePenalty;
            if (!attemptBest || scoredCost < attemptBest.scoredCost) {
              attemptBest = {
                ...solved,
                scoredCost,
                totalCost,
                physicalLength,
                snapFrom: fromCandidate.distance,
                snapTo: toCandidate.distance,
                fromCandidate,
                toCandidate
              };
            }
          });
        });

        // Important: the first successful attempt wins. This prevents a soft fallback
        // from adding/choosing a parallel or detour route when the strict N02 route-line
        // constraint already produced a valid single primary segment.
        if (attemptBest && attemptBest.pathKeys && attemptBest.pathKeys.length >= 2) {
          best = attemptBest;
          usedHints = segmentHints;
          break;
        }
      }

      if (!best || !best.pathKeys || best.pathKeys.length < 2) {
        console.warn("No graph path found for route section; segment skipped.", section, baseHints, { lastCandidateFailure });
        return null;
      }

      const segmentHints = usedHints || baseHints;
      const rawCoordinates = best.pathKeys.map((key) => graph.nodes.get(key));
      const coordinates = completeRouteEndpointCoordinates(
        rawCoordinates,
        best.fromCandidate?.stationFeature || fromStations[0],
        best.toCandidate?.stationFeature || toStations[0]
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
          source: "browser_dijkstra_on_embedded_n02_railroadsection_graph_python_equivalent",
          segment_index: segmentIndex,
          from: section.from || stationName(fromStations[0]),
          to: section.to || stationName(toStations[0]),
          from_n02_station_code: section.from_n02_station_code || stationCode(fromStations[0]),
          to_n02_station_code: section.to_n02_station_code || stationCode(toStations[0]),
          allowed_institution_type_codes: allowedCodes,
          preferred_line_names: [...segmentHints.preferredLines],
          required_line_names: [...segmentHints.requiredLines],
          required_operator_names: [...segmentHints.requiredOperators],
          preferred_operator_names: [...segmentHints.preferredOperators],
          solve_mode: segmentHints.solve_mode || "base",
          require_preferred_institution: Boolean(segmentHints.requirePreferredInstitution),
          used_institution_type_codes: usedInstitutionTypeCodes(graph, best.pathKeys),
          route_template_key: getTrainRouteTemplateKey(train),
          path_coordinate_count: coordinates.length,
          raw_path_coordinate_count: rawCoordinates.length,
          snap_distance_m: { from: Math.round(best.snapFrom * 100) / 100, to: Math.round(best.snapTo * 100) / 100 },
          endpoint_display_gap_m: {
            from: Math.round(distanceMeters(getFeatureDisplayCoordinate(best.fromCandidate?.stationFeature || fromStations[0]), rawCoordinates[0]) * 100) / 100,
            to: Math.round(distanceMeters(getFeatureDisplayCoordinate(best.toCandidate?.stationFeature || toStations[0]), rawCoordinates[rawCoordinates.length - 1]) * 100) / 100
          },
          physical_length_m: Math.round(pathLengthForCoordinates(coordinates) * 100) / 100,
          raw_physical_length_m: Math.round(best.physicalLength * 100) / 100,
          cost: Math.round(best.totalCost * 100) / 100
        },
        geometry: { type: "LineString", coordinates }
      };
    }

    function normalizeRouteHintText(value) {
      return String(value || "").trim();
    }

    function sectionEndpointNames(section) {
      return [normalizeRouteHintText(section?.from), normalizeRouteHintText(section?.to)].filter(Boolean);
    }

    function sectionHasAnyEndpoint(section, names) {
      const endpoints = sectionEndpointNames(section);
      return endpoints.some((name) => names.includes(name));
    }

    function sectionHasEndpointPair(section, aNames, bNames) {
      const endpoints = sectionEndpointNames(section);
      return endpoints.some((name) => aNames.includes(name)) && endpoints.some((name) => bNames.includes(name));
    }

    function inferSectionRouteConstraints(section, train) {
      const text = [train?.id, train?.number, train?.name, train?.origin, train?.destination]
        .map(normalizeRouteHintText)
        .join(" ");
      const lineNames = new Set();
      const operatorNames = new Set();

      // JR Kyushu Sonic: N02 often gives 大分 as 久大線 and 小倉 as 鹿児島線,
      // while the actual limited express runs on 日豊線 between 大分/別府/中津/小倉.
      if (/ソニック|sonic/i.test(text) && sectionHasAnyEndpoint(section, ["大分", "別府", "中津", "小倉"])) {
        lineNames.add("日豊線");
        operatorNames.add("九州旅客鉄道");
      }

      // Haruka: keep the route on JR West around Kansai Airport/Osaka and stop
      // the solver from preferring nearby subway geometry at 天王寺/大阪/新大阪.
      if (/はるか|haruka/i.test(text)) {
        operatorNames.add("西日本旅客鉄道");
        if (sectionHasEndpointPair(section, ["関西空港"], ["日根野"])) lineNames.add("関西空港線");
        else if (sectionHasEndpointPair(section, ["日根野"], ["天王寺"])) lineNames.add("阪和線");
        else if (sectionHasEndpointPair(section, ["天王寺"], ["大阪"])) lineNames.add("大阪環状線");
        else if (sectionHasEndpointPair(section, ["大阪"], ["新大阪"])) lineNames.add("東海道線");
      }

      return {
        line_names: [...lineNames],
        operator_names: [...operatorNames]
      };
    }

    function buildSegmentRouteHints(section, fromStations, toStations, train) {
      const allowedCodes = getAllowedInstitutionTypeCodes(train);
      const preferredLines = new Set((train.route_policy?.preferred_line_names || []).map(String).filter(Boolean));
      const preferredOperators = new Set((train.route_policy?.preferred_operator_names || []).map(String).filter(Boolean));
      const inferredConstraints = inferSectionRouteConstraints(section, train);
      const explicitRequiredLines = new Set([
        ...(section.line_names || []).map(String).filter(Boolean),
        ...(inferredConstraints.line_names || [])
      ]);
      const explicitRequiredOperators = new Set([
        ...(section.operator_names || section.operator_hints || []).map(String).filter(Boolean),
        ...(inferredConstraints.operator_names || [])
      ]);
      const requiredLines = new Set(explicitRequiredLines);
      const requiredOperators = new Set(explicitRequiredOperators);
      requiredLines.forEach((value) => value && preferredLines.add(value));
      requiredOperators.forEach((value) => value && preferredOperators.add(value));

      const fromPreferredInstitutionStations = filterStationsByPreferredInstitution(fromStations, allowedCodes);
      const toPreferredInstitutionStations = filterStationsByPreferredInstitution(toStations, allowedCodes);
      const fromPreferredPool = fromPreferredInstitutionStations.length ? fromPreferredInstitutionStations : fromStations;
      const toPreferredPool = toPreferredInstitutionStations.length ? toPreferredInstitutionStations : toStations;

      const fromLines = stationSetFrom(fromStations, stationLineName);
      const toLines = stationSetFrom(toStations, stationLineName);
      const fromOperators = stationSetFrom(fromStations, stationOperator);
      const toOperators = stationSetFrom(toStations, stationOperator);
      const fromPreferredLines = stationSetFrom(fromPreferredPool, stationLineName);
      const toPreferredLines = stationSetFrom(toPreferredPool, stationLineName);
      const fromPreferredOperators = stationSetFrom(fromPreferredPool, stationOperator);
      const toPreferredOperators = stationSetFrom(toPreferredPool, stationOperator);

      const allCommonLines = new Set([...fromLines].filter((line) => toLines.has(line)));
      const allCommonOperators = new Set([...fromOperators].filter((operator) => toOperators.has(operator)));
      const preferredInstitutionCommonLines = new Set([...fromPreferredLines].filter((line) => toPreferredLines.has(line)));
      const preferredInstitutionCommonOperators = new Set([...fromPreferredOperators].filter((operator) => toPreferredOperators.has(operator)));

      // For JR/Shinkansen/JR-conventional trains, common subway/private station
      // names at large interchanges should not become equally good hints.  Prefer
      // common lines/operators from the allowed institution class first, and keep
      // all-company common hints only as a fallback.
      const commonLines = preferredInstitutionCommonLines.size ? preferredInstitutionCommonLines : allCommonLines;
      const commonOperators = preferredInstitutionCommonOperators.size ? preferredInstitutionCommonOperators : allCommonOperators;

      commonLines.forEach((line) => preferredLines.add(line));
      commonOperators.forEach((operator) => preferredOperators.add(operator));
      if (!preferredLines.size && fromPreferredLines.size === 1) fromPreferredLines.forEach((line) => preferredLines.add(line));
      if (!preferredLines.size && toPreferredLines.size === 1) toPreferredLines.forEach((line) => preferredLines.add(line));
      if (!preferredOperators.size && fromPreferredOperators.size === 1 && toPreferredOperators.size === 1) {
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
        solve_mode: "base"
      };
    }

    function cloneSegmentHints(baseHints, overrides = {}) {
      return {
        preferredLines: new Set(overrides.preferredLines || baseHints.preferredLines || []),
        preferredOperators: new Set(overrides.preferredOperators || baseHints.preferredOperators || []),
        requiredLines: new Set(overrides.requiredLines || baseHints.requiredLines || []),
        requiredOperators: new Set(overrides.requiredOperators || baseHints.requiredOperators || []),
        explicitRequiredLines: new Set(baseHints.explicitRequiredLines || []),
        explicitRequiredOperators: new Set(baseHints.explicitRequiredOperators || []),
        commonLines: new Set(baseHints.commonLines || []),
        commonOperators: new Set(baseHints.commonOperators || []),
        allCommonLines: new Set(baseHints.allCommonLines || []),
        allCommonOperators: new Set(baseHints.allCommonOperators || []),
        preferredInstitutionCommonLines: new Set(baseHints.preferredInstitutionCommonLines || []),
        preferredInstitutionCommonOperators: new Set(baseHints.preferredInstitutionCommonOperators || []),
        fromLines: new Set(baseHints.fromLines || []),
        toLines: new Set(baseHints.toLines || []),
        fromOperators: new Set(baseHints.fromOperators || []),
        toOperators: new Set(baseHints.toOperators || []),
        fromPreferredLines: new Set(baseHints.fromPreferredLines || []),
        toPreferredLines: new Set(baseHints.toPreferredLines || []),
        fromPreferredOperators: new Set(baseHints.fromPreferredOperators || []),
        toPreferredOperators: new Set(baseHints.toPreferredOperators || []),
        requirePreferredInstitution: Boolean(overrides.requirePreferredInstitution ?? baseHints.requirePreferredInstitution),
        solve_mode: overrides.solve_mode || baseHints.solve_mode || "base"
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
          [...(attempt.requiredOperators || [])].sort().join(",")
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
          solve_mode: "explicit_section_route_required_home_institution"
        });
        pushAttempt({
          requiredLines: explicitLines,
          requiredOperators: explicitOperators,
          requirePreferredInstitution: false,
          solve_mode: "explicit_section_route_required_soft_institution"
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
            solve_mode: "operator_pinned_common_line_required_home_institution"
          });
          pushAttempt({
            requiredLines: commonLines,
            requiredOperators: explicitOperators,
            requirePreferredInstitution: false,
            solve_mode: "operator_pinned_common_line_required_soft_institution"
          });
        }
        pushAttempt({
          requiredLines: new Set(),
          requiredOperators: explicitOperators,
          requirePreferredInstitution: true,
          solve_mode: "explicit_operator_required_home_institution"
        });
        pushAttempt({
          requiredLines: new Set(),
          requiredOperators: explicitOperators,
          requirePreferredInstitution: false,
          solve_mode: "explicit_operator_required_soft_institution"
        });
        return attempts;
      }

      if (commonLines.size && commonOperators.size) {
        pushAttempt({
          requiredLines: commonLines,
          requiredOperators: commonOperators,
          requirePreferredInstitution: true,
          solve_mode: "common_line_and_operator_required_home_institution"
        });
      }

      if (commonLines.size) {
        pushAttempt({
          requiredLines: commonLines,
          requiredOperators: new Set(),
          requirePreferredInstitution: true,
          solve_mode: "common_line_required_home_institution"
        });
      }

      if (commonOperators.size) {
        pushAttempt({
          requiredLines: new Set(),
          requiredOperators: commonOperators,
          requirePreferredInstitution: true,
          solve_mode: "common_operator_required_home_institution"
        });
      }

      pushAttempt({
        requiredLines: baseHints.requiredLines,
        requiredOperators: baseHints.requiredOperators,
        requirePreferredInstitution: true,
        solve_mode: "home_institution_soft_line_operator_hints"
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
          solve_mode: "common_line_required_other_operator_fallback"
        });
      }

      pushAttempt({
        requiredLines: baseHints.requiredLines,
        requiredOperators: baseHints.requiredOperators,
        requirePreferredInstitution: false,
        solve_mode: commonLines.size || commonOperators.size ? "soft_fallback_after_home_attempts" : "no_common_line_soft_fallback"
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
        solve_mode: "institution_only_unbiased_fallback"
      });

      return attempts;
    }

    function usedInstitutionTypeCodes(graph, pathKeys) {
      const used = new Set();
      for (let i = 0; i < pathKeys.length - 1; i += 1) {
        const edge = findEdge(graph, pathKeys[i], pathKeys[i + 1]);
        if (edge?.institution_type_code) used.add(String(edge.institution_type_code));
      }
      return [...used].sort();
    }

    // Per-edge penalty for leaving the preferred line/operator. Shared by the
    // Dijkstra edge relaxation and the post-hoc whole-path scoring so the penalty
    // formula has one definition. Callers must skip station-connector edges.
    function nonPreferredLineOperatorPenalty(edge, preferredLines, preferredOperators) {
      let penalty = 0;
      if (preferredLines.size && edge.line_name && !preferredLines.has(edge.line_name)) {
        penalty += edge.length * NON_PREFERRED_LINE_LENGTH_FACTOR;
      }
      if (preferredOperators.size && edge.operator && !preferredOperators.has(edge.operator)) {
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
        penalty += nonPreferredLineOperatorPenalty(edge, preferredLines, preferredOperators);
      }
      return penalty;
    }

    function findEdge(graph, fromKey, toKey) {
      return (graph.adjacency.get(fromKey) || []).find((edge) => edge.to === toKey) || null;
    }

    function collectStationCandidateGraphNodes(stationFeatures, graph, hints, allowedCodes) {
      const seen = new Set();
      const candidates = [];
      stationFeatures.forEach((feature) => {
        getStationCandidateGraphNodes(feature, graph, hints, allowedCodes).forEach((candidate) => {
          if (seen.has(candidate.key)) return;
          seen.add(candidate.key);
          candidates.push(candidate);
        });
      });
      candidates.sort((a, b) => a.score - b.score || a.distance - b.distance);
      return candidates;
    }

    function getStationCandidateGraphNodes(stationFeature, graph, hints = { preferredLines: new Set(), preferredOperators: new Set() }, allowedCodes = [...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES]) {
      const allowedKey = (allowedCodes || []).map(String).sort().join(",");
      const cacheKey = `${stationCode(stationFeature) || stationName(stationFeature)}|${stationLineName(stationFeature)}|${stationOperator(stationFeature)}|${allowedKey}|home:${hints.requirePreferredInstitution ? 1 : 0}|reqL:${[...(hints.requiredLines || [])].join("/")}|reqO:${[...(hints.requiredOperators || [])].join("/")}|prefL:${[...(hints.preferredLines || [])].join("/")}|prefO:${[...(hints.preferredOperators || [])].join("/")}`;
      if (cacheKey && graph.stationSnapCache.has(cacheKey)) return graph.stationSnapCache.get(cacheKey);

      const candidateMap = new Map();
      const sourceLines = iterateGeometryLines(stationFeature.geometry);
      const sourceCoords = sourceLines.length ? sourceLines.flat() : [getFeatureDisplayCoordinate(stationFeature)];
      const stationLine = stationLineName(stationFeature);
      const stationOperatorName = stationOperator(stationFeature);

      function maybeUpsertCandidate(nearest) {
        if (!nearest || !nearest.key) return;
        const meta = graph.nodeMeta.get(nearest.key);
        if (!meta) return;
        const hasPreferredInstitution = graphNodeHasPreferredInstitution(meta, allowedCodes);
        if (hints.requirePreferredInstitution && !hasPreferredInstitution) return;
        if ((hints.requiredLines || new Set()).size && !intersects(hints.requiredLines, meta.line_names)) return;
        if ((hints.requiredOperators || new Set()).size && !intersects(hints.requiredOperators, meta.operators)) return;
        let score = nearest.distance;
        if (stationLine && meta.line_names?.has(stationLine)) score -= 40;
        if (stationOperatorName && meta.operators?.has(stationOperatorName)) score -= 15;
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
          stationFeature
        };
        const previous = candidateMap.get(nearest.key);
        if (!previous || candidate.score < previous.score || (candidate.score === previous.score && candidate.distance < previous.distance)) {
          candidateMap.set(nearest.key, candidate);
        }
      }

      sourceCoords.forEach((coord) => {
        // Station geometries are often LineString objects. The same railroad node can be
        // discovered from multiple station-geometry vertices; keep the best snap per node
        // instead of freezing the first, possibly hundreds-of-meters-away encounter.
        nearbyGraphNodes(coord, graph, 0.006, 160).forEach((nearest) => {
          if (nearest.distance <= STATION_SNAP_MAX_DISTANCE_METERS) maybeUpsertCandidate(nearest);
        });
      });

      const candidates = [...candidateMap.values()].sort((a, b) => a.score - b.score || a.distance - b.distance);
      const sliced = candidates.slice(0, 16);
      graph.stationSnapCache.set(cacheKey, sliced);
      return sliced;
    }

    function dijkstraBetweenExactNodes(graph, sourceKey, targetKey, train, allowedCodes, segmentHints = { preferredLines: new Set(), preferredOperators: new Set(), requiredLines: new Set(), requiredOperators: new Set() }) {
      const distance = new Map([[sourceKey, 0]]);
      const previous = new Map();
      const heap = new MinHeap();
      heap.push({ key: sourceKey, priority: 0 });
      const visited = new Set();

      while (heap.size()) {
        const current = heap.pop();
        if (visited.has(current.key)) continue;
        visited.add(current.key);
        if (current.key === targetKey) {
          return { cost: current.priority, pathKeys: reconstructPath(previous, sourceKey, targetKey) };
        }
        const edges = graph.adjacency.get(current.key) || [];
        edges.forEach((edge) => {
          if (!edgeMatchesAllowedCodes(edge, allowedCodes, train, segmentHints)) return;
          if (!edgeMatchesRequiredHints(edge, segmentHints)) return;
          let weight = edge.length + (edge.is_station_connector ? 0 : institutionPreferencePenaltyForEdge(edge, allowedCodes, train));
          // Preferred hints should be strong but not hard unless the user put them in section.line_names/operator_hints.
          if (!edge.is_station_connector) {
            weight += nonPreferredLineOperatorPenalty(edge, segmentHints.preferredLines || new Set(), segmentHints.preferredOperators || new Set());
          }
          const nextCost = current.priority + weight;
          if (nextCost < (distance.get(edge.to) ?? Infinity)) {
            distance.set(edge.to, nextCost);
            previous.set(edge.to, current.key);
            heap.push({ key: edge.to, priority: nextCost });
          }
        });
      }
      return null;
    }

    function pathLengthMeters(graph, pathKeys) {
      let length = 0;
      for (let i = 0; i < pathKeys.length - 1; i += 1) {
        length += distanceMeters(graph.nodes.get(pathKeys[i]), graph.nodes.get(pathKeys[i + 1]));
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

    function completeRouteEndpointCoordinates(coordinates, fromStationFeature, toStationFeature) {
      if (!Array.isArray(coordinates) || coordinates.length < 2) return coordinates || [];
      let completed = trimRouteEndpointToStationDisplay(coordinates, fromStationFeature, true);
      completed = trimRouteEndpointToStationDisplay(completed, toStationFeature, false);
      return completed;
    }

    function trimRouteEndpointToStationDisplay(coordinates, stationFeature, isStart) {
      if (!stationFeature || !Array.isArray(coordinates) || coordinates.length < 2) return coordinates;
      const displayCoord = getFeatureDisplayCoordinate(stationFeature);
      if (!displayCoord) return coordinates;

      const endpointIndex = isStart ? 0 : coordinates.length - 1;
      const endpoint = coordinates[endpointIndex];
      if (coordinatesClose(displayCoord, endpoint, 1.5)) return coordinates;

      const searchLimit = Math.min(12, coordinates.length - 1);
      let best = null;
      const firstSegment = isStart ? 0 : Math.max(0, coordinates.length - 1 - searchLimit);
      const lastSegment = isStart ? searchLimit - 1 : coordinates.length - 2;
      for (let i = firstSegment; i <= lastSegment; i += 1) {
        const projected = projectPointToSegmentMeters(displayCoord, coordinates[i], coordinates[i + 1]);
        if (projected.t < -0.02 || projected.t > 1.02) continue;
        if (!best || projected.distance < best.distance) best = { ...projected, index: i };
      }

      if (best && best.distance <= 45) {
        if (isStart) {
          const tail = coordinates.slice(best.index + 1);
          return coordinatesClose(displayCoord, tail[0], 1.5) ? tail : [displayCoord, ...tail];
        }
        const head = coordinates.slice(0, best.index + 1);
        return coordinatesClose(head[head.length - 1], displayCoord, 1.5) ? head : [...head, displayCoord];
      }

      // Airport and underground stations in N02 are represented as short station
      // LineStrings. If the chosen routable endpoint is one end of that station
      // geometry, add the station display point so the visible route reaches the
      // stop marker instead of appearing to break near the terminal.
      const stationGap = distanceMeters(displayCoord, endpoint);
      if (stationGap <= STATION_SNAP_MAX_DISTANCE_METERS) {
        return isStart ? [displayCoord, ...coordinates] : [...coordinates, displayCoord];
      }
      return coordinates;
    }

    function coordinatesClose(a, b, toleranceMeters = 1.5) {
      return a && b && distanceMeters(a, b) <= toleranceMeters;
    }

    function projectPointToSegmentMeters(point, a, b) {
      const lat = ((Number(point[1]) + Number(a[1]) + Number(b[1])) / 3) * Math.PI / 180;
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
        t
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
      return [Number(Number(coord[0]).toFixed(5)), Number(Number(coord[1]).toFixed(5))];
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
      const p1 = lat1 * Math.PI / 180;
      const p2 = lat2 * Math.PI / 180;
      const dp = (lat2 - lat1) * Math.PI / 180;
      const dl = (lon2 - lon1) * Math.PI / 180;
      const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
      return 2 * radius * Math.asin(Math.sqrt(x));
    }

    function iterateGeometryLines(geometry) {
      if (!geometry || !geometry.coordinates) return [];
      if (geometry.type === "LineString") return [geometry.coordinates.map(normalizeGraphCoord)];
      if (geometry.type === "MultiLineString") return geometry.coordinates.map((line) => line.map(normalizeGraphCoord));
      if (geometry.type === "Point") return [[normalizeGraphCoord(geometry.coordinates)]];
      return [];
    }

    class MinHeap {
      constructor() { this.items = []; }
      size() { return this.items.length; }
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
          [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
          index = parent;
        }
      }
      bubbleDown(index) {
        const length = this.items.length;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          let smallest = index;
          if (left < length && this.items[left].priority < this.items[smallest].priority) smallest = left;
          if (right < length && this.items[right].priority < this.items[smallest].priority) smallest = right;
          if (smallest === index) break;
          [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
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
          .sort((a, b) => Number(a.properties?.segment_index ?? 0) - Number(b.properties?.segment_index ?? 0));
      }

      if (!candidates.length) {
        const templateKey = getTrainRouteTemplateKey(train);
        if (templateKey) {
          candidates = matchedRoutesGeoJson.features
            .filter((feature) => {
              const p = feature.properties || {};
              return p.route_template_key === templateKey && p.is_primary !== false;
            })
            .sort((a, b) => Number(a.properties?.segment_index ?? 0) - Number(b.properties?.segment_index ?? 0));
        }
      }

      if (!candidates.length) {
        console.warn(`No N02 railway route could be generated for train ${train.id}. Route will not be drawn.`);
        setStatus(els.fieldStatus, "No N02 railway path could be generated from embedded N02 data. Check station codes / route_policy. No fake straight line was drawn.", "warn");
        return [];
      }

      const routeId = candidates[0].properties?.route_id || "";
      return candidates
        .filter((feature) => (feature.properties?.route_id || "") === routeId)
        .map((feature, index) => {
          const normalized = normalizeSingleRouteGeometry(feature);
          if (!normalized) return null;
          const segmentIndex = Number(normalized.properties?.segment_index ?? index);
          return {
            ...normalized,
            properties: {
              ...(normalized.properties || {}),
              ride_segment: isRideSegment(train, segmentIndex)
            }
          };
        })
        .filter(Boolean);
    }

    function isRideSegment(train, segmentIndex) {
      const stops = train.stops || [];
      return Boolean(stops[segmentIndex]?.ride_segment && stops[segmentIndex + 1]?.ride_segment);
    }

    function normalizeSingleRouteGeometry(feature) {
      if (!feature?.geometry) return null;
      if (feature.geometry.type === "LineString") return feature;
      if (feature.geometry.type === "MultiLineString") {
        const role = feature.properties?.geometry_role;
        if (role === "single_path_with_gaps") return feature;
        console.warn("Rejected MultiLineString because it is not declared as one route with gaps.", feature);
        return null;
      }
      console.warn("Rejected matched route with unsupported geometry type.", feature);
      return null;
    }

    function getStopFeature(stop, train) {
      const explicit = matchedStopsGeoJson.features.find((f) => {
        const p = f.properties || {};
        return p.train_id === train.id && (p.n02_station_code === stopStationCode(stop) || p.station === stopName(stop) || p.name === stopName(stop));
      });
      if (explicit) {
        return {
          ...explicit,
          properties: {
            ...(explicit.properties || {}),
            ...stop,
            name: stopName(stop),
            n02_station_code: stopStationCode(stop) || explicit.properties?.n02_station_code || null
          }
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
          train_name: train.name,
          number: train.number,
          line_name: stationLineName(station),
          operator: stationOperator(station),
          source: "station display_point"
        },
        geometry: { type: "Point", coordinates: getFeatureDisplayCoordinate(station) }
      };
    }

    function renderTrainRouteSegment(train, segmentFeature, renderOptions = {}) {
      const ridden = segmentFeature.properties?.ride_segment === true;
      const color = train.style?.color || DEFAULT_TRAIN_COLOR;
      const weight = Number(train.style?.weight || DEFAULT_TRAIN_WEIGHT);
      const unriddenOpacity = Number(train.style?.unridden_opacity ?? DEFAULT_UNRIDDEN_OPACITY);
      const isOverlap = Boolean(renderOptions.overlap);
      const overlapSlot = renderOptions.overlap?.slot || 0;
      const overlapCount = renderOptions.overlap?.count || 1;
      const focused = renderOptions.focused === true;
      const dimmed = renderOptions.dimmed === true;
      const baseOpacity = train.visible === false ? 0 : (
        focused ? 1 :
        dimmed ? 0.18 :
        ridden ? 0.9 : unriddenOpacity
      );
      const overlapOpacityFactor = isOverlap && !focused && !dimmed
        ? Math.max(0.28, 1 / Math.sqrt(Math.max(1, overlapCount)))
        : 1;

      return L.geoJSON(segmentFeature, {
        renderer: limitedExpressRouteRenderer,
        style: {
          color,
          weight: focused ? weight + 2 : (ridden ? weight : Math.max(2, weight - 1)),
          opacity: baseOpacity * overlapOpacityFactor,
          dashArray: focused || dimmed || isOverlap ? null : (ridden ? null : "4 6"),
          dashOffset: null,
          lineCap: "round"
        },
        onEachFeature: (feature, layer) => {
          layer.bindPopup(buildTrainSegmentPopup(train, feature));
          layer.on("click", () => {
            selectedTrainId = train.id;
            focusedTrainId = train.id;
            renderAll();
          });
        }
      });
    }

    function renderStopMarker(stopFeature, train, renderOptions = {}) {
      const isTerminal = stopFeature.properties.stop_type === "origin" || stopFeature.properties.stop_type === "destination";
      const active = stopFeature.properties.ride_segment === true;
      const color = train.style?.color || DEFAULT_TRAIN_COLOR;
      const focused = renderOptions.focused === true;
      const dimmed = renderOptions.dimmed === true;
      return L.circleMarker(toLatLng(stopFeature), {
        radius: focused ? (isTerminal ? 11 : 9) : (isTerminal ? 9 : 7),
        color,
        weight: focused ? 4 : (active ? 3 : 2),
        fillColor: active ? "#fff" : color,
        fillOpacity: active ? 1 : 0.12,
        opacity: dimmed ? 0.22 : (active ? 1 : 0.32)
      }).bindPopup(buildStopPopup(stopFeature, train));
    }

    function renderPassThroughMarker(stopFeature, train, renderOptions = {}) {
      const active = stopFeature.properties.ride_segment !== false;
      const color = train.style?.color || DEFAULT_TRAIN_COLOR;
      const focused = renderOptions.focused === true;
      const dimmed = renderOptions.dimmed === true;
      return L.circleMarker(toLatLng(stopFeature), {
        radius: focused ? 5 : 4,
        color,
        weight: focused ? 2 : 1,
        fillColor: color,
        fillOpacity: active ? 0.35 : 0.12,
        opacity: dimmed ? 0.18 : (active ? 0.45 : 0.18)
      }).bindPopup(buildStopPopup(stopFeature, train));
    }

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
      if (feature.geometry.type === "LineString" || feature.geometry.type === "Point") return clone(feature.geometry.coordinates);
      if (feature.geometry.type === "MultiLineString") return feature.geometry.coordinates.flatMap((line) => line);
      return [];
    }

    function coordinatesEqual(a, b) {
      return a && b && Number(a[0]) === Number(b[0]) && Number(a[1]) === Number(b[1]);
    }

    function fitTrainBounds(train) {
      if (!train) return;
      const features = getMatchedRouteFeatures(train);
      if (features.length) {
        const group = L.featureGroup(features.map((feature) => L.geoJSON(feature)));
        map.fitBounds(group.getBounds(), { padding: [32, 32], maxZoom: 13 });
        return;
      }
      const points = (train.stops || []).map((stop) => resolveStationForTrain(stop, train)).filter(Boolean).map(toLatLng);
      if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 13 });
    }

    function setImportProgress(count, total, label = "") {
      const safeTotal = Math.max(1, Number(total || 0));
      const safeCount = Math.max(0, Math.min(Number(count || 0), safeTotal));
      const pct = Math.round((safeCount / safeTotal) * 100);
      els.importProgressWrap.hidden = false;
      els.importProgressFill.style.width = `${pct}%`;
      els.importProgressText.textContent = label || `${safeCount}/${safeTotal} (${pct}%)`;
    }

    function resetImportProgress() {
      els.importProgressFill.style.width = "0%";
      els.importProgressText.textContent = "";
      els.importProgressWrap.hidden = true;
    }

    function fitJapanMainIslands() {
      if (!map) return;
      map.fitBounds(JAPAN_MAIN_ISLANDS_BOUNDS, { padding: [28, 28], animate: false });
    }

    function validateTextareaJson() {
      try {
        const parsed = parseImportedCanonicalStore(els.importJson.value);
        const trains = parsed.trains.map(normalizeImportedTrain);

        if (!trains.length) {
          throw new Error("Imported store contains no trains.");
        }

        const nextStore = buildCanonicalTrainStore();

        trains.forEach((train) => {
          const existingIds = new Set(nextStore.trains.map((t) => t.id));
          train.id = makeUniqueTrainId(train.id, existingIds);
          nextStore.trains.push(train);
          validateTrainStore(nextStore);
        });

        setStatus(
          els.importStatus,
          `JSON valid. ${trains.length} train(s) can be appended progressively.`,
          "ok"
        );
      } catch (error) {
        setStatus(els.importStatus, error.message, "err");
      }
    }

    function validateTrainStore(store) {
      if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error("JSON root must be an object.");
      assertOnlyKeys(store, ["schema_version", "trains"], "Store");
      if (store.schema_version !== SCHEMA_VERSION) throw new Error(`schema_version must be "${SCHEMA_VERSION}".`);
      if (!Array.isArray(store.trains)) throw new Error("trains must be an array.");
      const ids = new Set();
      store.trains.forEach((train, index) => validateTrain(train, index, ids));
      return true;
    }

    function validateTrain(train, index, ids) {
      const prefix = `Train ${index + 1}`;
      ["id", "name", "number", "origin", "destination"].forEach((key) => {
        if (!train[key] || typeof train[key] !== "string") throw new Error(`${prefix}: ${key} is required.`);
      });
      if (ids.has(train.id)) throw new Error(`${prefix}: duplicate id ${train.id}.`);
      ids.add(train.id);
      if (!Array.isArray(train.stops) || train.stops.length < 2) throw new Error(`${prefix}: stops must contain at least 2 rows.`);
      if (train.stops[0].departure && train.stops[0].arrival) throw new Error(`${prefix}: first stop should not need both arrival and departure.`);
      const last = train.stops[train.stops.length - 1];
      if (last.departure && last.arrival) throw new Error(`${prefix}: final stop should not need both arrival and departure.`);
      train.stops.forEach((stop, stopIndex) => {
        if (!stopName(stop)) throw new Error(`${prefix} stop ${stopIndex + 1}: name is required.`);
        if (!stop.stop_type) throw new Error(`${prefix} stop ${stopIndex + 1}: stop_type is required.`);
        if (typeof stop.ride_segment !== "boolean") {
          throw new Error(`${prefix} stop ${stopIndex + 1}: ride_segment must be boolean.`);
        }
        ["arrival", "departure"].forEach((field) => {
          if (stop[field] !== null && stop[field] !== undefined && typeof stop[field] !== "string") {
            throw new Error(`${prefix} stop ${stopIndex + 1}: ${field} must be a string or null.`);
          }
        });
      });
      if (train.route_sections) {
        if (!Array.isArray(train.route_sections)) throw new Error(`${prefix}: route_sections must be an array.`);
        train.route_sections.forEach((section, sectionIndex) => {
          if (!(section.from || section.from_n02_station_code) || !(section.to || section.to_n02_station_code)) {
            throw new Error(`${prefix} route section ${sectionIndex + 1}: from/to names or N02 station codes are required.`);
          }
          ["line_names", "operator_names"].forEach((field) => {
            const values = section[field] || [];
            if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
              throw new Error(`${prefix} route section ${sectionIndex + 1}: ${field} must be an array of strings.`);
            }
          });
        });
      }
      if (train.route_policy) {
        if (train.route_policy.mode !== "single_primary_route") throw new Error(`${prefix}: route_policy.mode must be single_primary_route.`);
        if (typeof train.route_policy.jr_only !== "boolean") throw new Error(`${prefix}: route_policy.jr_only must be boolean.`);
        if (train.route_policy.allow_alternatives !== false) throw new Error(`${prefix}: route_policy.allow_alternatives must be false.`);
        if (train.route_policy.allow_browser_straight_line_fallback !== false) throw new Error(`${prefix}: route_policy.allow_browser_straight_line_fallback must be false.`);
        const allowed = train.route_policy.allowed_institution_type_codes || [];
        if (!Array.isArray(allowed) || allowed.some((code) => !N02_INSTITUTION_TYPE_CODES.has(String(code)))) {
          throw new Error(`${prefix}: route_policy.allowed_institution_type_codes must contain only N02_002 codes 1/2/3/4/5.`);
        }
        ["preferred_line_names", "preferred_operator_names"].forEach((field) => {
          const values = train.route_policy[field] || [];
          if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
            throw new Error(`${prefix}: route_policy.${field} must be an array of strings.`);
          }
        });
        if (train.route_policy.institution_filter_mode && !["soft", "hard"].includes(train.route_policy.institution_filter_mode)) {
          throw new Error(`${prefix}: route_policy.institution_filter_mode must be soft or hard.`);
        }
      }
      const color = train.style?.color;
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`${prefix}: style.color must be #RRGGBB.`);
    }

    function buildStopPopup(stopFeature, train) {
      const p = stopFeature.properties || {};
      return popupHtml(`${train.number || ""} ${train.name || ""}`, [
        ["Train ID", train.id],
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
        ["Route source", p.source || "station overlay"]
      ]);
    }

    function buildTrainSegmentPopup(train, feature) {
      const p = feature.properties || {};
      const ridden = p.ride_segment === true;
      return popupHtml(`${train.number || ""} ${train.name || ""}`, [
        ["Train ID", train.id],
        ["Segment", `${p.from || ""} → ${p.to || ""}`],
        ["Ride", ridden ? "Yes" : "No"],
        ["segment_index", p.segment_index ?? "-"],
        ["Route ID", p.route_id || "-"],
        ["Route choice", p.route_choice || "-"],
        ["Route source", p.source || "matched route"],
        ["Allowed N02_002", (p.allowed_institution_type_codes || train.route_policy?.allowed_institution_type_codes || []).join(", ") || "-"],
        ["Visible", train.visible === false ? "No" : "Yes"]
      ]);
    }

    function buildStationPopup(feature) {
      const p = feature.properties || {};
      return popupHtml(stationName(feature), [
        ["N02_005c", stationCode(feature) || "-"],
        ["N02_005g", stationGroupCode(feature) || "-"],
        ["N02_001", p.railway_class_code || p.N02_001 || "-"],
        ["N02_002", p.institution_type_code || p.N02_002 || "-"],
        ["N02_003", stationLineName(feature)],
        ["N02_004", stationOperator(feature)],
        ["Geometry", feature.geometry?.type || "-"],
        ["Display lon", getFeatureDisplayCoordinate(feature)[0].toFixed(6)],
        ["Display lat", getFeatureDisplayCoordinate(feature)[1].toFixed(6)]
      ]);
    }

    function buildRailPopup(p) {
      return popupHtml(p.line_name || p.N02_003 || "Railway section", [
        ["Section ID", p.section_id || "-"],
        ["From", p.from || "-"],
        ["To", p.to || "-"],
        ["N02_001", p.railway_class_code || p.N02_001 || "-"],
        ["N02_002", p.institution_type_code || p.N02_002 || "-"],
        ["N02_003", p.line_name || p.N02_003 || "-"],
        ["N02_004", p.operator || p.N02_004 || "-"],
        ["N02 source", "embedded GeoJSON demo"]
      ]);
    }

    function popupHtml(title, rows) {
      return `<div class="popup-title">${escapeHtml(title)}</div><div class="popup-grid">${
        rows.map(([key, value]) => `<span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong>`).join("")
      }</div>`;
    }

    function setStatus(el, message, type) {
      el.textContent = message;
      el.className = `status ${type || ""}`;
    }

    function normalizeColor(value) {
      return /^#[0-9a-fA-F]{6}$/.test(value || "") ? value : DEFAULT_TRAIN_COLOR;
    }

    function buildPortableHtml() {
      const dataNode = document.getElementById("data-default-trains");
      if (dataNode) {
        dataNode.textContent = `\n${exportTrainStore()}\n  `;
      }
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
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/`/g, "&#96;");
    }
