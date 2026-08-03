"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("rail network loader follows the active country and replaces cached data", async () => {
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
    STATIONS_LAYER: "rail-stations-layer",
  };
  win.RailMapGeometry = {};

  let country = "tw";
  const requests = [];
  win.activeRailPackageUrl = () => `./rail/${country}-2025.json`;
  win.fetch = async (url, options) => {
    requests.push([url, options && options.cache]);
    return { ok: true, json: async () => ({ country: country.toUpperCase() }) };
  };
  win.RailNetwork = {
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

  win.RailMap.setNetworkVisible(true);
  win.RailMap.setNetworkStationsVisible(true);
  const taiwan = await win.RailMap.ensureNetwork();
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
  const japan = await win.RailMap.switchNetworkCountry();
  assert.equal(japan.country, "JP");
  assert.deepEqual(requests, [
    ["./rail/tw-2025.json", "no-cache"],
    ["./rail/jp-2025.json", "no-cache"],
  ]);
  assert.deepEqual(uploaded.get("rail-stations").features, ["JP"]);
  assert.equal(win.RailMap._networkVisibleWanted, true);
  assert.equal(win.RailMap._networkStationsVisibleWanted, true);
});
