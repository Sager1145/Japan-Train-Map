"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// One RailMap in a sandbox, with everything it reaches for stubbed and every
// fetch recorded. `respond` decides what a package URL answers with, which is
// the only thing the tests below differ in, so the rest of the rig lives here
// rather than once per test.
function loadRailMap(respond) {
  const win = { console };
  win.window = win;
  win.RailMapBasemap = {
    loadBasemap: async () => null,
    probeBasemapOrigin: async () => false,
    namespaceBasemap: (value) => value,
    opacityPropsForLayer: () => [],
    MAP_SURFACE_COLORS: {},
    BASEMAP_CROSSFADE_MS: 0,
  };
  win.RailMapStyle = {
    buildBaseStyle: () => ({}),
    EMPTY_FC: { type: "FeatureCollection", features: [] },
    SEGMENTS_SOURCE: "rail-segments",
    STATIONS_SOURCE: "rail-stations",
    SEGMENTS_LAYER: "rail-segments-layer",
    SEGMENTS_CASING_LAYER: "rail-segments-casing-layer",
    STATIONS_LAYER: "rail-stations-layer",
    railAttributionForCountry: (country) => `rail:${country}`,
  };
  win.RailMapGeometry = {};

  const requests = [];
  win.activeRailPackageUrl = () => {
    throw new Error("the implicit global URL hook must not be called");
  };
  win.fetch = async (url, options) => {
    requests.push([url, options && options.cache]);
    return { ok: true, json: async () => respond(url) };
  };
  win.RailNetwork = {
    // loadNetwork takes a LIST of package URLs — North America draws us-2025
    // and ca-2025 together, because the cross-border trains need both networks
    // — and merges them before building.
    //
    // Deliberately more permissive than the real mergeCompactPackages in
    // rail-network.js, which filters to `format: "compact-v1"` with an array of
    // lines, answers null when nothing survives that filter, and throws when
    // two packages carry the same line id. None of those rules are reproduced
    // here, so these tests say nothing about merge SEMANTICS: they cover the
    // loader's fetch → merge → build path, and the merge itself is checked
    // where it lives.
    mergeCompactPackages: (packages) =>
      packages.length === 1
        ? packages[0]
        : {
            ...packages[0],
            version: packages.map((pkg) => pkg.version).join("+"),
            country: packages.map((pkg) => pkg.country).join("+"),
          },
    buildNetworkFromCompactPackage: (compactPackage) => ({
      country: compactPackage.country,
      segments: { type: "FeatureCollection", features: [compactPackage.country] },
      stations: { type: "FeatureCollection", features: [compactPackage.country] },
    }),
  };

  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../public/railmap.js"), "utf8"),
    vm.createContext(win),
    { filename: "railmap.js" },
  );

  const uploaded = new Map();
  const visibility = new Map();
  win.RailMap._map = {
    getSource(id) {
      return { setData: (data) => uploaded.set(id, data) };
    },
    getLayer(id) {
      return { id };
    },
    setLayoutProperty(id, property, value) {
      if (property === "visibility") visibility.set(id, value);
    },
  };

  return { win, requests, uploaded, visibility };
}

test("rail network loader follows the active country and replaces cached data", async () => {
  let country = "tw";
  const { win, requests, uploaded, visibility } = loadRailMap(() => ({
    country: country.toUpperCase(),
  }));

  win.RailMap.setNetworkVisible(true);
  win.RailMap.setNetworkStationsVisible(true);
  const taiwan = await win.RailMap.ensureNetwork("./rail/tw-2025.json");
  assert.equal(taiwan.country, "TW");
  assert.deepEqual(requests, [
    ["./rail/tw-2025.json", "no-cache"],
  ]);
  assert.deepEqual(uploaded.get("rail-segments").features, ["TW"]);
  assert.equal(visibility.get("rail-segments-layer"), "visible");
  assert.equal(visibility.get("rail-stations-layer"), "visible");

  // Model a prior load that was cleared/failed while the layer-control box
  // remains checked. The visibility intent must still force a country reload.
  win.RailMap._network = null;
  win.RailMap._networkPromise = null;
  country = "jp";
  const japan = await win.RailMap.switchNetworkCountry(
    "jp",
    "./rail/jp-2025.json",
  );
  assert.equal(japan.country, "JP");
  assert.deepEqual(requests, [
    ["./rail/tw-2025.json", "no-cache"],
    ["./rail/jp-2025.json", "no-cache"],
  ]);
  assert.deepEqual(uploaded.get("rail-stations").features, ["JP"]);
  assert.equal(win.RailMap._networkVisibleWanted, true);
  assert.equal(win.RailMap._networkStationsVisibleWanted, true);
});

// The reason loadNetwork takes a list at all. Every other country hands it one
// URL and the single-package path above covers them; this is the only shape
// where the loader has to fetch twice and hand ONE network to the map, and
// without a case for it the multi-package branch ships unrun.
test("North America fetches both packages and builds one merged network", async () => {
  const packages = {
    "./rail/us-2025.json": { country: "US", version: "2025.1" },
    "./rail/ca-2025.json": { country: "CA", version: "2025.2" },
  };
  const { win, requests, uploaded } = loadRailMap((url) => packages[url]);

  win.RailMap.setNetworkVisible(true);
  win.RailMap.setNetworkStationsVisible(true);
  const northAmerica = await win.RailMap.ensureNetwork([
    "./rail/us-2025.json",
    "./rail/ca-2025.json",
  ]);

  // Both packages were asked for, both under the same revalidating fetch the
  // single-package path uses: a rebuilt package must not be shadowed by the
  // 24-hour static JSON cache on either side of the border.
  assert.deepEqual(requests, [
    ["./rail/us-2025.json", "no-cache"],
    ["./rail/ca-2025.json", "no-cache"],
  ]);

  // One network reached the map, and it is the merged one — not whichever
  // package happened to answer first.
  assert.equal(northAmerica.country, "US+CA");
  assert.deepEqual(uploaded.get("rail-segments").features, ["US+CA"]);
  assert.deepEqual(uploaded.get("rail-stations").features, ["US+CA"]);
});

// A package that fails to load must take the whole network down rather than
// leave the map drawing one country's half of a two-country network, which
// would read as "Canada has no railways" instead of as a failure.
test("North America builds nothing when one of the two packages fails", async () => {
  const { win, requests, uploaded } = loadRailMap(() => ({ country: "US" }));
  win.fetch = async (url, options) => {
    requests.push([url, options && options.cache]);
    return url.includes("ca-2025")
      ? { ok: false, json: async () => ({}) }
      : { ok: true, json: async () => ({ country: "US" }) };
  };

  const network = await win.RailMap.ensureNetwork([
    "./rail/us-2025.json",
    "./rail/ca-2025.json",
  ]);
  assert.equal(network, null);
  assert.deepEqual(requests, [
    ["./rail/us-2025.json", "no-cache"],
    ["./rail/ca-2025.json", "no-cache"],
  ]);
  assert.equal(uploaded.size, 0);
});
