// Precompute per-train route geometry OFFLINE and emit the train store as
// per-train "part" files, so the browser (critically: iPhone Safari, which
// kills the tab on memory pressure) never has to build the 600k-node route
// graphs or run Dijkstra during the initial page load.
//
// How it stays byte-identical to the client: instead of reimplementing the
// solver, this script evaluates the REAL frontend scripts (the ordered
// app-*.js family listed in app/public/index.html) inside a Node `vm`
// context with just enough browser stubs, feeds it the same datasets the
// browser would fetch, appends each train through the same
// parseImportedCanonicalStore/appendImportedTrain normalization the boot path
// uses, and runs the same streaming route solve. The cached template features
// + cache key are then exported per train. At boot the frontend seeds
// runtimeRouteCache with each part's entry, so
// prepareTrainRouteSolve() is a pure cache hit and no graph is ever built.
//
// Output (all under app/data/sample-data/ — the published SAMPLE dataset):
//   manifest.json  { format, schema_version, total, parts: ["part-000", ...],
//                    dates: { "2026-07-03": ["part-000", ...], ... } }
//   part-NNN.json  { format, train: <raw train from train-store.json>,
//                    route: null | { cache_key, features } | { cache_key, unsolvable: true } }
//
// Every train is its own file, and the manifest's `dates` map groups the part
// names by calendar day (trains without a date land under ""), so the static
// frontend can load a single random day's sample on boot and the full sample
// only on explicit request.
//
// Run:  node app/scripts/precompute-train-parts.mjs
// Alternate store/output:
//   PRECOMPUTE_STORE=data/special-samples/example.json
//   PRECOMPUTE_OUT_DIR=data/example-parts node scripts/precompute-train-parts.mjs
// (No dependencies; used by the GitHub Pages deploy workflow on every push.)

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(APP_DIR, "data");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const STORE_PATH = process.env.PRECOMPUTE_STORE
  ? path.resolve(process.cwd(), process.env.PRECOMPUTE_STORE)
  : path.join(DATA_DIR, "train-store.json");
const OUT_DIR = process.env.PRECOMPUTE_OUT_DIR
  ? path.resolve(process.cwd(), process.env.PRECOMPUTE_OUT_DIR)
  : path.join(DATA_DIR, "sample-data");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// The frontend is a family of ordered classic scripts sharing one global
// lexical scope. Replay EXACTLY the <script src> list from index.html — the
// single source of truth for load order — keeping app-core.js and the
// app-*.js family and skipping the browser-only libraries the sandbox stubs
// instead (vendor/maplibre, i18n*.js, rail-network.js, railmap*.js). Reading
// the list from index.html keeps this exporter in lockstep when app modules
// are added, removed, or reordered.
function readOrderedAppScripts() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) =>
    m[1].split(/[?#]/, 1)[0],
  );
  const appScripts = scripts.filter(
    (src) => !src.includes("/") && src.startsWith("app") && src.endsWith(".js"),
  );
  if (!appScripts.includes("app-core.js") || !appScripts.includes("app.js")) {
    throw new Error(
      "index.html's script list is missing app-core.js/app.js — cannot replay the app module family.",
    );
  }
  return appScripts;
}

// ---------------------------------------------------------------------------
// Browser stubs — the minimum surface app.js touches at module-eval time and
// on the solve path. Dummy DOM elements swallow status writes.
// ---------------------------------------------------------------------------
function makeDummyElement() {
  const el = {
    textContent: "",
    className: "",
    innerHTML: "",
    value: "",
    hidden: false,
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
  return el;
}

function makeSandbox() {
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
    navigator: { userAgent: "node-precompute", maxTouchPoints: 0, language: "en" },
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
      addEventListener() {},
      removeEventListener() {},
    },
    // Solve-path code never calls these; stubs exist so module-eval references
    // (if any) don't explode.
    I18N: {
      t: (key) => String(key),
      setStationReadings() {},
      placeName: (name) => String(name || ""),
      lang: () => "zh-Hant",
    },
    RailMap: {},
    maplibregl: {},
    fetch: () => {
      throw new Error("fetch is not available in the precompute sandbox");
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
  return vm.createContext(sandbox);
}

// ---------------------------------------------------------------------------
// Driver — runs INSIDE the vm context so it can reach app.js's top-level
// lexical bindings (railSectionsGeoJson, runtimeRouteCache, ...).
// ---------------------------------------------------------------------------
const DRIVER_SOURCE = `
(async () => {
  railSectionsGeoJson = __host.railSections;
  stationsGeoJson = __host.stations;
  matchedRoutesGeoJson = { type: "FeatureCollection", features: [] };
  matchedStopsGeoJson = __host.matchedStops;
  await buildStationIndexesSliced(stationsGeoJson);

  const store = parseImportedCanonicalStore(__host.trainStoreText);
  const results = [];
  for (let i = 0; i < store.trains.length; i += 1) {
    const raw = store.trains[i];
    // Same normalization + id de-dup the browser boot path applies.
    const id = appendImportedTrain(raw, null);
    const train = getTrain(id);

    // Use the browser's exact deterministic solve context. This keeps the
    // exporter in lockstep if route-policy inputs are added later.
    const solveContext = buildTrainRouteSolveContext(train);
    const cacheKey = solveContext ? solveContext.cacheKey : null;

    const t0 = performance.now();
    // The interactive render path intentionally queues cold solves so clicks
    // never block. Offline export must await that same streaming solver
    // directly, then verify the render lookup is a pure cache hit.
    const features = await warmRouteCacheForTrainStreaming(train);
    const ms = Math.round(performance.now() - t0);

    let route = null;
    if (cacheKey) {
      if (runtimeRouteCache.has(cacheKey)) {
        route = { cache_key: cacheKey, features: runtimeRouteCache.get(cacheKey) };
      } else if (runtimeRouteNegativeCache.has(cacheKey)) {
        route = { cache_key: cacheKey, unsolvable: true };
      } else {
        throw new Error(
          \`Route solve for train \${id} produced neither a positive nor negative cache entry.\`,
        );
      }
      // Belt and braces: the client-side prepare must see this as a pure hit.
      const prep = prepareTrainRouteSolve(train);
      if (!prep.done) {
        throw new Error(\`Seeded cache miss for train \${id} — export would not skip the on-device solve.\`);
      }
    }

    __host.onTrainSolved({
      index: i,
      id,
      raw,
      route,
      featureCount: features.length,
      ms,
    });
    results.push({ id, solved: Boolean(route && !route.unsolvable), featureCount: features.length });
  }
  return { total: store.trains.length, schemaVersion: store.schema_version, results };
})()
`;

// Assemble manifest.json from already-emitted part files (used after sliced
// runs; see PRECOMPUTE_RANGE below). Validates that every train in the store
// has its part on disk, in order.
function finalizeManifestFromParts() {
  const store = JSON.parse(
    fs.readFileSync(STORE_PATH, "utf8"),
  );
  const partNames = [];
  const partsByDate = new Map();
  let solvedCount = 0;
  let unsolvableCount = 0;
  let noRouteCount = 0;
  for (let i = 0; i < store.trains.length; i += 1) {
    const name = `part-${String(i).padStart(3, "0")}`;
    const part = JSON.parse(
      fs.readFileSync(path.join(OUT_DIR, `${name}.json`), "utf8"),
    );
    partNames.push(name);
    const dateKey =
      part.train && typeof part.train.date === "string" ? part.train.date : "";
    if (!partsByDate.has(dateKey)) partsByDate.set(dateKey, []);
    partsByDate.get(dateKey).push(name);
    if (!part.route) noRouteCount += 1;
    else if (part.route.unsolvable) unsolvableCount += 1;
    else solvedCount += 1;
  }
  if (solvedCount === 0)
    throw new Error("No train solved — refusing to publish empty parts.");
  const manifest = {
    format: 1,
    schema_version: store.schema_version || "1.3",
    generated_at: new Date().toISOString(),
    total: store.trains.length,
    solved: solvedCount,
    unsolvable: unsolvableCount,
    no_route: noRouteCount,
    parts: partNames,
    full: "sample-full",
    dates: Object.fromEntries(
      [...partsByDate.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  // Keep one combined big JSON of the whole sample next to the chunks.
  fs.writeFileSync(
    path.join(OUT_DIR, "sample-full.json"),
    fs.readFileSync(STORE_PATH),
  );
  console.log(
    `Finalized manifest for ${store.trains.length} parts (${solvedCount} solved, ${unsolvableCount} unsolvable, ${noRouteCount} without route sections).`,
  );
}

async function main() {
  // Finalize-only mode: build the manifest from parts emitted by sliced runs.
  if (process.env.PRECOMPUTE_FINALIZE) {
    finalizeManifestFromParts();
    return;
  }

  const started = performance.now();
  console.log("Loading datasets...");
  const railSections = readJson(path.join(DATA_DIR, "rail-sections.json"));
  const stations = readJson(path.join(DATA_DIR, "stations.json"));
  const matchedStops = readJson(path.join(DATA_DIR, "matched-stops.json"));
  let trainStoreText = fs.readFileSync(
    STORE_PATH,
    "utf8",
  );

  // Optional slice mode: PRECOMPUTE_RANGE="start:end" (end-exclusive train
  // indexes) solves only that window and APPENDS its parts into OUT_DIR
  // without touching the rest. Useful for memory/time-boxed environments;
  // run PRECOMPUTE_FINALIZE=1 once afterwards to write the manifest. The
  // default (no env) behaviour — fresh dir, full store, manifest — is
  // unchanged, and is what CI uses.
  const rangeEnv = process.env.PRECOMPUTE_RANGE || "";
  let sliceStart = 0;
  if (rangeEnv) {
    const match = rangeEnv.match(/^(\d+):(\d+)$/);
    if (!match)
      throw new Error('PRECOMPUTE_RANGE must look like "0:20" (end-exclusive).');
    sliceStart = Number(match[1]);
    const sliceEnd = Number(match[2]);
    const full = JSON.parse(trainStoreText);
    trainStoreText = JSON.stringify({
      ...full,
      trains: full.trains.slice(sliceStart, sliceEnd),
    });
    console.log(
      `Slice mode: trains ${sliceStart}..${Math.min(sliceEnd, full.trains.length)} of ${full.trains.length}.`,
    );
  }

  const context = makeSandbox();
  const appScripts = readOrderedAppScripts();
  console.log(
    `Evaluating the app script family in sandbox (${appScripts.length} files)...`,
  );
  for (const name of appScripts) {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, name), "utf8");
    vm.runInContext(source, context, { filename: name });
  }

  // Fresh output dir (slice mode appends into the existing one instead).
  if (!rangeEnv) fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const partNames = [];
  // date string ("" for undated trains) -> part names for that day, in store order.
  const partsByDate = new Map();
  let solvedCount = 0;
  let unsolvableCount = 0;
  let noRouteCount = 0;

  context.__host = {
    railSections,
    stations,
    matchedStops,
    trainStoreText,
    onTrainSolved({ index, id, raw, route, featureCount, ms }) {
      const name = `part-${String(sliceStart + index).padStart(3, "0")}`;
      partNames.push(name);
      const dateKey = typeof raw.date === "string" ? raw.date : "";
      if (!partsByDate.has(dateKey)) partsByDate.set(dateKey, []);
      partsByDate.get(dateKey).push(name);
      if (!route) noRouteCount += 1;
      else if (route.unsolvable) unsolvableCount += 1;
      else solvedCount += 1;
      fs.writeFileSync(
        path.join(OUT_DIR, `${name}.json`),
        JSON.stringify({ format: 1, train: raw, route }),
      );
      console.log(
        `  [${index + 1}] ${id}: ${
          route ? (route.unsolvable ? "UNSOLVABLE" : `${featureCount} feature(s)`) : "no route sections"
        } (${ms} ms)`,
      );
    },
  };

  console.log("Solving trains...");
  const summary = await vm.runInContext(DRIVER_SOURCE, context, {
    filename: "precompute-driver.js",
  });

  if (partNames.length !== summary.total) {
    throw new Error(
      `Emitted ${partNames.length} parts for ${summary.total} trains — aborting.`,
    );
  }

  if (!rangeEnv) {
    const manifest = {
      format: 1,
      schema_version: summary.schemaVersion || "1.3",
      generated_at: new Date().toISOString(),
      total: summary.total,
      solved: solvedCount,
      unsolvable: unsolvableCount,
      no_route: noRouteCount,
      parts: partNames,
      full: "sample-full",
      dates: Object.fromEntries(
        [...partsByDate.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    fs.writeFileSync(
      path.join(OUT_DIR, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    // Alongside the per-train chunks, keep ONE combined file with the whole
    // sample store (no geometry — same shape a user would import/export), so
    // the complete sample also exists as a single big JSON.
    fs.writeFileSync(path.join(OUT_DIR, "sample-full.json"), trainStoreText);
  }

  const bytes = partNames.reduce(
    (sum, name) => sum + fs.statSync(path.join(OUT_DIR, `${name}.json`)).size,
    0,
  );
  console.log(
    `\nDone in ${Math.round((performance.now() - started) / 1000)} s: ${summary.total} trains ` +
      `(${solvedCount} solved, ${unsolvableCount} unsolvable, ${noRouteCount} without route sections), ` +
      `${(bytes / 1024 / 1024).toFixed(1)} MB of parts in ${path.relative(process.cwd(), OUT_DIR)}.`,
  );
  if (solvedCount === 0) {
    throw new Error("No train solved — refusing to publish empty parts.");
  }
}

main().catch((err) => {
  console.error("\nprecompute-train-parts FAILED:", err);
  process.exit(1);
});
