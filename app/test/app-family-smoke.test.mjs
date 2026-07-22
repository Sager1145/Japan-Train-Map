// Smoke tests over the REAL frontend script family evaluated in a Node vm
// (the same replay approach as scripts/precompute-train-parts.mjs).
//
// The app is a set of classic scripts sharing one global lexical scope, so a
// stale cross-file reference only explodes at RUNTIME — `npm run lint` is a
// per-file syntax check and cannot see it. Test 1 fires every registered
// language-change listener WITHOUT i18n.js's try/catch, so an identifier that
// one file calls and another no longer defines fails the suite instead of
// being swallowed as a console warning.
//
// Tests 2–3 characterize the read-only recovery mode: a saved store that
// exists but cannot be loaded must yield a recovery sentinel (never writable
// defaults), and while recovery is active autosave must be inert.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// Replay EXACTLY the <script src> list from index.html (single source of
// truth for load order), keeping app-core.js + the app-*.js family — same
// filter as scripts/precompute-train-parts.mjs.
function readOrderedAppScripts() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) =>
    m[1].split(/[?#]/, 1)[0],
  );
  const appScripts = scripts.filter(
    (src) => !src.includes("/") && src.startsWith("app") && src.endsWith(".js"),
  );
  assert.ok(
    appScripts.includes("app-core.js") && appScripts.includes("app.js"),
    "index.html's script list is missing app-core.js/app.js",
  );
  return appScripts;
}

function makeDummyElement() {
  return {
    textContent: "",
    className: "",
    innerHTML: "",
    value: "",
    hidden: false,
    disabled: false,
    checked: false,
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
    dataset: {},
    content: "",
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      return child;
    },
    removeChild() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    focus() {},
    click() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
}

function loadAppFamily() {
  const i18nListeners = [];
  const mediaStub = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    performance,
    URL,
    TextEncoder,
    TextDecoder,
    crypto: { randomUUID },
    navigator: { userAgent: "node-smoke", maxTouchPoints: 0, language: "en" },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
      clear() {},
    },
    matchMedia: mediaStub,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    requestIdleCallback: (fn) => setTimeout(fn, 0),
    cancelIdleCallback() {},
    document: {
      hidden: false,
      documentElement: makeDummyElement(),
      body: makeDummyElement(),
      getElementById: () => makeDummyElement(),
      querySelector: () => makeDummyElement(),
      querySelectorAll: () => [],
      createElement: () => makeDummyElement(),
      createTextNode: () => makeDummyElement(),
      createDocumentFragment: () => makeDummyElement(),
      addEventListener() {},
      removeEventListener() {},
    },
    // Recording i18n stub: listeners are invoked by the tests DIRECTLY,
    // without i18n.js's try/catch, so listener errors fail the test.
    I18N: {
      t: (key) => String(key),
      placeName: (name) => String(name || ""),
      trainName: (name) => String(name || ""),
      setStationReadings() {},
      setLang() {},
      applyStatic() {},
      onChange: (fn) => i18nListeners.push(fn),
    },
    RailMap: {},
    maplibregl: {},
    fetch: () => {
      throw new Error("fetch is not available in the smoke-test sandbox");
    },
  };
  sandbox.location = { hash: "", href: "http://localhost/", pathname: "/" };
  sandbox.history = { replaceState() {}, pushState() {} };
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 800;
  sandbox.devicePixelRatio = 1;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of readOrderedAppScripts()) {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, name), "utf8");
    vm.runInContext(source, context, { filename: name });
  }
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
  assert.match(key, /^solver:3\|/);
});

test("precomputed sample geometry replaces stale warmed geometry", () => {
  const { context } = loadAppFamily();
  const result = vm.runInContext(
    `(() => {
      const key = "solver:3|hiroden-test";
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
