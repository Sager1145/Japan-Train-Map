// Smoke tests over the REAL frontend script family evaluated in a Node vm
// (the same replay approach as scripts/precompute-train-parts.mjs).
//
// The app is a set of classic scripts sharing one global lexical scope, so a
// stale cross-file reference only explodes at RUNTIME. The lint task now runs
// concatenated `no-undef`; test 1 remains a runtime family smoke check by
// firing every registered language-change listener WITHOUT i18n.js's
// try/catch, so a swallowed listener error still fails the suite.
//
// Tests 2–3 characterize the read-only recovery mode: a saved store that
// exists but cannot be loaded must yield a recovery sentinel (never writable
// defaults), and while recovery is active autosave must be inert.

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import {
  evaluateAppScripts,
  makeSandbox,
} from "../scripts/lib/app-family-sandbox.mjs";

function loadAppFamily({ indexedDB } = {}) {
  const i18nListeners = [];
  const context = makeSandbox({
    userAgent: "node-smoke",
    fetchErrorMessage: "fetch is not available in the smoke-test sandbox",
    indexedDB,
    // Recording i18n stub: listeners are invoked by the tests DIRECTLY,
    // without i18n.js's try/catch, so listener errors fail the test.
    i18n: { onChange: (fn) => i18nListeners.push(fn) },
  });
  evaluateAppScripts(context);
  return { context, i18nListeners };
}

test("every language-change listener runs without undefined identifiers", () => {
  const { context, i18nListeners } = loadAppFamily();
  // Keep the run timer-free: the stats job and export refresh are debounced
  // side effects that this test does not characterize.
  vm.runInContext(
    "mileageStatsTabActive = () => false; scheduleExportTextareaRefresh = () => {};",
    context,
  );
  vm.runInContext("bindEvents()", context);
  assert.ok(
    i18nListeners.length >= 1,
    "bindEvents() registered no I18N.onChange listener",
  );
  for (const listener of i18nListeners) listener("en");
});

test("recovery mode blocks autosave and pins the raw JSON for rescue", () => {
  const { context } = loadAppFamily();
  const run = (code) => vm.runInContext(code, context);
  run('enterStoreRecoveryMode({ message: "boom", rawText: "RAW-STORE-JSON" })');
  assert.equal(run("storeRecoveryMode"), true);
  assert.equal(run("els.json.value"), "RAW-STORE-JSON");
  run("saveTrainStore()");
  assert.equal(run("storeSaveDirty"), false, "recovery must block autosave");
  // Routine renders must not overwrite the pinned rescue JSON.
  run("scheduleExportTextareaRefresh()");
  assert.equal(run("els.json.value"), "RAW-STORE-JSON");
  run("exitStoreRecoveryMode()");
  assert.equal(run("storeRecoveryMode"), false);
  run("saveTrainStore()");
  assert.equal(run("storeSaveDirty"), true, "autosave must resume after exit");
  run("clearTimeout(serverStoreSaveTimer)"); // don't leave the debounce armed
  run("clearTimeout(pendingServerStoreJournalTimer)");
});

test("backend edits stage a recovery journal before the network debounce", async () => {
  const { context } = loadAppFamily();
  context.__journalBodies = [];
  vm.runInContext(
    `writePendingServerStoreSave = async (body) => {
       __journalBodies.push(body);
     };
     saveTrainStore();`,
    context,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(context.__journalBodies.length, 1);
  assert.deepEqual(JSON.parse(context.__journalBodies[0]), {
    schema_version: "1.3",
    trains: [],
  });
  assert.equal(
    vm.runInContext("serverStoreSaveInFlight", context),
    false,
    "the 450ms network save must not have started yet",
  );
  vm.runInContext(
    `clearTimeout(serverStoreSaveTimer);
     clearTimeout(pendingServerStoreJournalTimer);
     pendingServerStoreText = null;`,
    context,
  );
});

test("unloadable saved store yields a recovery sentinel; 404 yields null", async () => {
  const { context } = loadAppFamily();

  // Saved store exists but fails validation -> recovery sentinel + raw text.
  const invalidText = '{"schema_version":"9.9","trains":[]}';
  context.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => invalidText,
  });
  let result = await vm.runInContext("loadTrainStoreFromServer()", context);
  assert.equal(result && result.recovery, true);
  assert.equal(result.rawText, invalidText);
  assert.match(result.message, /schema_version/);

  // Corrupt JSON -> recovery sentinel too.
  context.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '{"schema_version":"1.3","trains":[',
  });
  result = await vm.runInContext("loadTrainStoreFromServer()", context);
  assert.equal(result && result.recovery, true);

  // Nothing saved yet (404) -> null: writable defaults are safe.
  context.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found" });
  result = await vm.runInContext("loadTrainStoreFromServer()", context);
  assert.equal(result, null);

  // Network failure -> recovery sentinel (we cannot know a store is absent).
  context.fetch = async () => {
    throw new Error("network down");
  };
  result = await vm.runInContext("loadTrainStoreFromServer()", context);
  assert.equal(result && result.recovery, true);
});

test("pending backend autosave replays only against its exact server base", async () => {
  const canonicalStore = (id) => ({
    schema_version: "1.3",
    trains: [
      {
        id,
        date: "2026-07-24",
        number: id,
        origin: "A",
        destination: "B",
        stops: [
          {
            name: "A",
            stop_type: "origin",
            departure: "10:00",
            ride_segment: true,
          },
          {
            name: "B",
            stop_type: "destination",
            arrival: "11:00",
            ride_segment: true,
          },
        ],
      },
    ],
  });
  const baseStore = canonicalStore("base");
  const pendingStore = canonicalStore("pending");
  const baseText = JSON.stringify(baseStore);
  const pendingText = JSON.stringify(pendingStore);

  const replay = loadAppFamily();
  replay.context.__baseStore = baseStore;
  replay.context.__baseText = baseText;
  replay.context.__pendingText = pendingText;
  replay.context.__sentBodies = [];
  replay.context.__deletedPending = [];
  replay.context.fetch = async (_url, options) => {
    replay.context.__sentBodies.push(options.body);
    return { ok: true, status: 200, statusText: "OK" };
  };
  vm.runInContext(
    `lastKnownServerStoreExists = true;
     lastKnownServerStoreText = __baseText;
     readPendingServerStoreSaves = async () => [{
       client_id: "old-tab",
       body: __pendingText,
       base_body: __baseText,
       base_exists: true,
       updated_at: "2026-07-24T00:00:00.000Z",
     }];
     deletePendingServerStoreSave = async (id, body) => {
       __deletedPending.push([id, body]);
     };`,
    replay.context,
  );
  const replayed = await vm.runInContext(
    "recoverPendingServerStoreSaves(__baseStore)",
    replay.context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(replayed)), pendingStore);
  assert.deepEqual(replay.context.__sentBodies, [pendingText]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(replay.context.__deletedPending)),
    [["old-tab", pendingText]],
  );

  const conflict = loadAppFamily();
  conflict.context.__baseStore = baseStore;
  conflict.context.__pendingText = pendingText;
  vm.runInContext(
    `lastKnownServerStoreExists = true;
     lastKnownServerStoreText = JSON.stringify({
       schema_version: "1.3",
       trains: [],
     });
     readPendingServerStoreSaves = async () => [{
       client_id: "old-tab",
       body: __pendingText,
       base_body: "different-old-base",
       base_exists: true,
       updated_at: "2026-07-24T00:00:00.000Z",
     }];`,
    conflict.context,
  );
  const conflicted = await vm.runInContext(
    "recoverPendingServerStoreSaves(__baseStore)",
    conflict.context,
  );
  assert.equal(conflicted.recovery, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(conflicted.pendingStore)),
    pendingStore,
  );
});

test("static user-store compare-before-write detects stale day records", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const original = { date: "2026-07-24", trains: [{ id: "a" }] };
      const changed = { date: "2026-07-24", trains: [{ id: "b" }] };
      const baseline = JSON.stringify(original);
      return {
        unchanged: userStoreChunkConflicts(baseline, original),
        changed: userStoreChunkConflicts(baseline, changed),
        concurrentlyCreated: userStoreChunkConflicts(undefined, changed),
        stillMissing: userStoreChunkConflicts(undefined, undefined),
      };
    })()`,
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    unchanged: false,
    changed: true,
    concurrentlyCreated: true,
    stillMissing: false,
  });
});

test("two static tabs cannot overwrite the same IndexedDB day", async () => {
  const indexedDB = new IDBFactory();
  const first = loadAppFamily({ indexedDB });
  const second = loadAppFamily({ indexedDB });
  const store = (number) => ({
    schema_version: "1.3",
    trains: [
      {
        id: "shared-day",
        date: "2026-07-24",
        number,
        stops: [],
      },
    ],
  });

  first.context.__store = store("base");
  first.context.__nextStore = store("first-tab");
  second.context.__nextStore = store("second-tab");
  await vm.runInContext(
    `trainStore = __store;
     writeUserStoreChunks(__store, { force: true })`,
    first.context,
  );
  const secondLoaded = await vm.runInContext(
    "readUserStoreAll()",
    second.context,
  );
  assert.equal(secondLoaded.store.trains[0].number, "base");

  await vm.runInContext(
    `trainStore = __nextStore;
     writeUserStoreChunks(__nextStore)`,
    first.context,
  );
  await assert.rejects(
    vm.runInContext(
      `trainStore = __nextStore;
       writeUserStoreChunks(__nextStore)`,
      second.context,
    ),
    (error) =>
      error &&
      error.name === "UserStoreConflictError" &&
      error.dateKey === "2026-07-24",
  );

  const verify = loadAppFamily({ indexedDB });
  const stored = await vm.runInContext("readUserStoreAll()", verify.context);
  assert.equal(stored.store.trains[0].number, "first-tab");
});

test("station graph candidates keep the best snap for each graph node", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const distant = { properties: { id: "distant" } };
      const exact = { properties: { id: "exact" } };
      const original = getStationCandidateGraphNodes;
      getStationCandidateGraphNodes = (feature) => [{
        key: "shared-node",
        score: feature === distant ? 150 : 0,
        distance: feature === distant ? 150 : 0,
        stationFeature: feature,
      }];
      try {
        return collectStationCandidateGraphNodes(
          [distant, exact],
          {},
          {},
          ["4"],
        ).map((candidate) => candidate.stationFeature.properties.id);
      } finally {
        getStationCandidateGraphNodes = original;
      }
    })()`,
    context,
  );
  assert.deepEqual([...result], ["exact"]);
});

test("station snap cache distinguishes duplicate codes at different geometries", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const north = {
        properties: {
          N02_002: "4",
          N02_003: "白島線",
          N02_004: "広島電鉄",
          N02_005: "八丁堀",
          N02_005c: "008047",
        },
        geometry: { type: "LineString", coordinates: [[1, 1]] },
      };
      const south = {
        properties: { ...north.properties },
        geometry: { type: "LineString", coordinates: [[2, 2]] },
      };
      const meta = {
        institution_type_codes: new Set(["4"]),
        line_names: new Set(["白島線"]),
        operators: new Set(["広島電鉄"]),
      };
      const graph = {
        stationSnapCache: new Map(),
        nodeMeta: new Map([["north", meta], ["south", meta]]),
      };
      const hints = {
        preferredLines: new Set(),
        preferredOperators: new Set(),
        requiredLines: new Set(),
        requiredOperators: new Set(),
        requirePreferredInstitution: true,
      };
      const original = nearbyGraphNodes;
      nearbyGraphNodes = (coord) => [{
        key: coord[0] === 1 ? "north" : "south",
        distance: 0,
      }];
      try {
        const a = getStationCandidateGraphNodes(north, graph, hints, ["4"]);
        const b = getStationCandidateGraphNodes(south, graph, hints, ["4"]);
        return {
          first: a[0].key,
          second: b[0].key,
          cacheSize: graph.stationSnapCache.size,
        };
      } finally {
        nearbyGraphNodes = original;
      }
    })()`,
    context,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(result)),
    { first: "north", second: "south", cacheSize: 2 },
  );
});

test("route cache keys include the solver version", () => {
  const { context } = loadAppFamily();
  const key = vm.runInContext(
    `buildTrainRouteSolveContext({
      route_policy: { allowed_institution_type_codes: ["4"] },
      route_sections: [{
        from_n02_station_code: "008062",
        to_n02_station_code: "008058",
      }],
      stops: [
        { name: "胡町", n02_station_code: "008062", ride_segment: true },
        { name: "八丁堀", n02_station_code: "008058", ride_segment: true },
      ],
    }).cacheKey`,
    context,
  );
  assert.match(key, /^solver:14\|/);
});

test("precomputed sample geometry replaces stale warmed geometry", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const key = "solver:14|hiroden-test";
      runtimeRouteCache.set(key, [{ geometry: { coordinates: [[0, 0], [9, 9]] } }]);
      runtimeRouteNegativeCache.add(key);
      seedRouteCacheFromPart({ route: {
        cache_key: key,
        features: [{ geometry: { coordinates: [[0, 0], [1, 0]] } }],
      } });
      return {
        coordinates: runtimeRouteCache.get(key)[0].geometry.coordinates,
        negative: runtimeRouteNegativeCache.has(key),
      };
    })()`,
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    coordinates: [[0, 0], [1, 0]],
    negative: false,
  });
});

test("out-and-back geometry keeps the later cross-day traversal", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const features = dedupeSameTrainRouteFeatures([
        {
          type: "Feature",
          properties: { segment_index: 0 },
          geometry: {
            type: "LineString",
            coordinates: [[139, 35], [140, 35]],
          },
        },
        {
          type: "Feature",
          properties: { segment_index: 1 },
          geometry: {
            type: "LineString",
            coordinates: [[140, 35], [139, 35]],
          },
        },
      ]);
      const breaks = trainDayBreaks({
        date: "2026-07-24",
        stops: [
          { name: "A", departure: "22:00" },
          { name: "B", arrival: "23:00", departure: "23:30" },
          { name: "A", arrival: "25:00" },
        ],
      });
      return {
        retained: features.map((feature) => feature.properties.segment_index),
        days: [0, 1].map((index) => dayIndexForSegment(breaks, index)),
      };
    })()`,
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    retained: [0, 1],
    days: [0, 1],
  });
});

// A→D is ridden with B→C inside it, so listing both reports the same trip
// twice. The suppression only runs downward: the longer section wins when it
// is ridden at least as often, and a short section ridden MORE than the long
// one it sits inside keeps both rows.
test("最常乘坐區間 drops sections contained in a more-ridden one", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const row = (from, to, count, edgeIds, bucket) =>
        ({ from, to, count, km: edgeIds.length, bucket, edgeIds });
      const HSR = STAT_MASK_HSR, CONV = STAT_MASK_CONV;
      // Same track, long section ridden more -> the inner one goes.
      const absorbed = dropContainedSections([
        row("A", "D", 5, [1, 2, 3], CONV),
        row("B", "C", 3, [2], CONV),
      ]).map((r) => r.from + r.to);
      // Same track, inner section ridden more -> both stay.
      const kept = dropContainedSections([
        row("B", "C", 9, [2], CONV),
        row("A", "D", 4, [1, 2, 3], CONV),
      ]).map((r) => r.from + r.to);
      // Different mode: 新幹線 must never swallow a 在來線 section.
      const crossMode = dropContainedSections([
        row("A", "D", 5, [1, 2, 3], HSR),
        row("B", "C", 3, [2], CONV),
      ]).map((r) => r.from + r.to);
      // Overlapping but neither contained -> both stay.
      const overlap = dropContainedSections([
        row("A", "C", 5, [1, 2], CONV),
        row("B", "D", 4, [2, 3], CONV),
      ]).map((r) => r.from + r.to);
      return { absorbed, kept, crossMode, overlap };
    })()`,
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    absorbed: ["AD"],
    kept: ["BC", "AD"],
    crossMode: ["AD", "BC"],
    overlap: ["AC", "BD"],
  });
});
