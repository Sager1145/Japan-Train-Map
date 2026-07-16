// Precompute per-train route geometry OFFLINE and emit the train store as
// per-train "part" files, so the browser (critically: iPhone Safari, which
// kills the tab on memory pressure) never has to build the 600k-node route
// graphs or run Dijkstra during the initial page load.
//
// How it stays byte-identical to the client: instead of reimplementing the
// solver, this script evaluates the REAL app/public/app.js inside a Node `vm`
// context with just enough browser stubs, feeds it the same datasets the
// browser would fetch, appends each train through the same
// parseImportedCanonicalStore/appendImportedTrain normalization the boot path
// uses, and runs the same generateMatchedRouteFeaturesForTrain solve. The
// cached template features + cache key are then exported per train. At boot
// the frontend seeds runtimeRouteCache with each part's entry, so
// prepareTrainRouteSolve() is a pure cache hit and no graph is ever built.
//
// Output (all under app/data/train-parts/):
//   manifest.json  { format, schema_version, total, parts: ["part-000", ...] }
//   part-NNN.json  { format, train: <raw train from train-store.json>,
//                    route: null | { cache_key, features } | { cache_key, unsolvable: true } }
//
// Run:  node app/scripts/precompute-train-parts.mjs
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
const OUT_DIR = path.join(DATA_DIR, "train-parts");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

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

    // Rebuild the cache key EXACTLY as prepareTrainRouteSolve() does. Kept in
    // lockstep by the assertion below: after solving, prepareTrainRouteSolve
    // must report a cache hit under this key, or we abort the export.
    const routeSections = getRideRouteSectionsForTrain(train);
    let cacheKey = null;
    if (routeSections.length) {
      const templateKey = getTrainRouteTemplateKey({
        ...train,
        route_sections: routeSections,
      });
      const allowedCodes = getAllowedInstitutionTypeCodes(train);
      const policyKey = [
        ...(train.route_policy?.preferred_line_names || []).map(
          (value) => \`line:\${value}\`,
        ),
        ...(train.route_policy?.preferred_operator_names || []).map(
          (value) => \`operator:\${value}\`,
        ),
        ...derivedPreferredOperatorNames(train).map(
          (value) => \`operator:\${value}\`,
        ),
        \`institution_filter:\${train.route_policy?.institution_filter_mode || "soft"}\`,
      ]
        .sort()
        .join("|");
      cacheKey = \`\${allowedCodes.join(",")}|\${policyKey}|\${templateKey}\`;
    }

    const t0 = performance.now();
    const features = generateMatchedRouteFeaturesForTrain(train);
    const ms = Math.round(performance.now() - t0);

    let route = null;
    if (cacheKey) {
      if (runtimeRouteCache.has(cacheKey)) {
        route = { cache_key: cacheKey, features: runtimeRouteCache.get(cacheKey) };
      } else if (runtimeRouteNegativeCache.has(cacheKey)) {
        route = { cache_key: cacheKey, unsolvable: true };
      } else {
        throw new Error(
          \`Cache-key drift for train \${id}: the solver cached under a different key than this script computed. Update the key assembly in precompute-train-parts.mjs to match prepareTrainRouteSolve().\`,
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

async function main() {
  const started = performance.now();
  console.log("Loading datasets...");
  const railSections = readJson(path.join(DATA_DIR, "rail-sections.json"));
  const stations = readJson(path.join(DATA_DIR, "stations.json"));
  const matchedStops = readJson(path.join(DATA_DIR, "matched-stops.json"));
  const trainStoreText = fs.readFileSync(
    path.join(DATA_DIR, "train-store.json"),
    "utf8",
  );

  const context = makeSandbox();
  const appSource = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  console.log("Evaluating app.js in sandbox...");
  vm.runInContext(appSource, context, { filename: "app.js" });

  // Fresh output dir.
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const partNames = [];
  let solvedCount = 0;
  let unsolvableCount = 0;
  let noRouteCount = 0;

  context.__host = {
    railSections,
    stations,
    matchedStops,
    trainStoreText,
    onTrainSolved({ index, id, raw, route, featureCount, ms }) {
      const name = `part-${String(index).padStart(3, "0")}`;
      partNames.push(name);
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

  const manifest = {
    format: 1,
    schema_version: summary.schemaVersion || "1.3",
    generated_at: new Date().toISOString(),
    total: summary.total,
    solved: solvedCount,
    unsolvable: unsolvableCount,
    no_route: noRouteCount,
    parts: partNames,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

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
