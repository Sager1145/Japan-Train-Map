"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const LABEL_BASE_KEY = "railmap:labelBaseFilter";
const KOREA_FIX_SOURCE = "korea-boundary-z4-fix";
const KOREA_FIX_CASING = "korea_boundary_z4_fix_casing";
const KOREA_FIX_LINE = "korea_boundary_z4_fix_line";

// A miniature positron: one background, one fill, one road line, the two
// boundary lines the Korea repair anchors to, a sea-name layer (dropped
// worldwide) and two label layers — one with an original filter, one without.
const MINI_POSITRON = {
  sources: { openmaptiles: { type: "vector", url: "https://tiles.example/x" } },
  layers: [
    { id: "background", type: "background", paint: {} },
    {
      id: "water",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "water",
    },
    {
      id: "highway_minor",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
    },
    {
      id: "building",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "building",
    },
    {
      id: "station_facility_fill",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landuse",
      filter: ["==", ["get", "class"], "station"],
    },
    {
      id: "station_platform_outline",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["==", ["get", "class"], "platform"],
    },
    {
      id: "boundary_2",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter: ["==", ["get", "admin_level"], 2],
      paint: { "line-color": "hsl(0,0%,70%)" },
    },
    {
      id: "boundary_disputed",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter: ["==", ["get", "disputed"], 1],
      paint: { "line-color": "hsl(0,0%,70%)" },
    },
    {
      id: "water_name_point_label",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "water_name",
      layout: { "text-field": "{name}" },
    },
    {
      id: "label_city",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["==", ["get", "class"], "city"],
      layout: { "text-field": "{name}" },
    },
    {
      id: "airport",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "aerodrome_label",
      layout: { "text-field": "{name}" },
    },
  ],
};

function makeContext() {
  const win = { console, setTimeout, clearTimeout };
  win.window = win;
  win.fetch = async () => ({
    ok: true,
    json: async () => JSON.parse(JSON.stringify(MINI_POSITRON)),
  });
  const ctx = vm.createContext(win);
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "../public/railmap-basemap.js"),
      "utf8",
    ),
    ctx,
    { filename: "railmap-basemap.js" },
  );
  return win;
}

function loadRailMap(win) {
  win.RailMapStyle = {
    buildBaseStyle: () => ({}),
    railAttributionForCountry: () => "credit",
    EMPTY_FC: { type: "FeatureCollection", features: [] },
    SEGMENTS_SOURCE: "rn-segments",
    STATIONS_SOURCE: "rn-stations",
  };
  win.RailMapGeometry = {};
  win.RailNetwork = {};
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../public/railmap.js"), "utf8"),
    vm.createContext(win),
    { filename: "railmap.js" },
  );
  return win.RailMap;
}

// Values built inside the VM context carry that realm's Array prototype,
// which node's deepStrictEqual rejects; normalize through JSON first.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function containsWithin(value) {
  if (Array.isArray(value))
    return value[0] === "within" || value.some(containsWithin);
  return false;
}

// The regional-detail gate is gone for good: MapLibre evaluates ["within", …]
// per FEATURE, and OpenMapTiles merges same-class lines into a handful of huge
// MultiLineStrings at low zoom, so a single vertex across the outline dropped
// every road / railway / admin line in the tile. Every tile that held both
// Japan and a neighbour — the whole 129–135°E column, i.e. everything west of
// Kansai — lost 40–88% of its line work between z4 and z6.
test("the basemap keeps worldwide detail: no within gate, no mask", async () => {
  const win = makeContext();
  const basemap = await win.RailMapBasemap.loadBasemap("light");
  const byId = new Map(basemap.layers.map((l) => [l.id, l]));

  for (const layer of basemap.layers) {
    assert.ok(
      !containsWithin(layer.filter),
      `${layer.id} must not carry a geographic gate`,
    );
    assert.ok(
      !layer.metadata || !(LABEL_BASE_KEY in layer.metadata),
      `${layer.id} must not carry label-gate metadata`,
    );
  }

  // Original filters survive verbatim — nothing is wrapped in an ["all", …].
  assert.deepEqual(plain(byId.get("label_city").filter), [
    "==",
    ["get", "class"],
    "city",
  ]);
  assert.equal(byId.get("airport").filter, undefined);
  assert.equal(byId.get("highway_minor").filter, undefined);

  // No world-sized fill mask, and no layer reordering: the only added source
  // is the Korean border repair.
  assert.deepEqual(Object.keys(basemap.sources).sort(), [
    KOREA_FIX_SOURCE,
    "openmaptiles",
  ]);
  assert.equal(
    win.RailMapBasemap.labelGateFilterForCountry,
    undefined,
    "the per-country label gate is removed from the public surface",
  );
});

test("sea and lake name labels are dropped worldwide, order otherwise intact", async () => {
  const win = makeContext();
  const basemap = await win.RailMapBasemap.loadBasemap("light");
  assert.deepEqual(
    basemap.layers.map((l) => l.id),
    [
      "background",
      "water",
      "highway_minor",
      "building",
      "boundary_2",
      "boundary_disputed",
      KOREA_FIX_CASING,
      KOREA_FIX_LINE,
      "label_city",
      "airport",
    ],
  );
});

test("station_facility_area_is_not_visible", async () => {
  const win = makeContext();
  const basemap = await win.RailMapBasemap.loadBasemap("light");
  const ids = new Set(basemap.layers.map((layer) => layer.id));
  assert.equal(ids.has("station_facility_fill"), false);
  assert.equal(ids.has("station_platform_outline"), false);
  assert.equal(ids.has("building"), true, "ordinary buildings must remain");
  assert.equal(ids.has("highway_minor"), true, "ordinary transport lines must remain");
});

test("z4 Korean border repair replaces the triplicate tile geometry with one line", async () => {
  const win = makeContext();
  const basemap = await win.RailMapBasemap.loadBasemap("light");
  const byId = new Map(basemap.layers.map((l) => [l.id, l]));
  const source = basemap.sources[KOREA_FIX_SOURCE];
  const casing = byId.get(KOREA_FIX_CASING);
  const line = byId.get(KOREA_FIX_LINE);

  assert.equal(source.type, "geojson");
  assert.equal(source.data.geometry.type, "LineString");
  assert.equal(source.data.geometry.coordinates.length, 19);
  assert.deepEqual(plain(source.data.geometry.coordinates[0]), [
    126.6668701171875,
    37.82714141683739,
  ]);
  assert.deepEqual(plain(source.data.geometry.coordinates.at(-1)), [
    128.3642578125,
    38.62545397209084,
  ]);

  // Both repair layers exist only while MapLibre overzooms the faulty z4
  // source tile.  z3 and z5+ already contain one native boundary line.
  for (const layer of [casing, line]) {
    assert.equal(layer.source, KOREA_FIX_SOURCE);
    assert.equal(layer.minzoom, 4);
    assert.equal(layer.maxzoom, 5);
  }
  assert.equal(casing.paint["line-color"], "rgb(242,243,240)");
  assert.deepEqual(plain(casing.paint["line-width"]), [
    "interpolate",
    ["linear"],
    ["zoom"],
    4,
    8,
    5,
    15,
  ]);
  assert.equal(line.paint["line-color"], "hsl(0,0%,70%)");

  const disputedIndex = basemap.layers.findIndex(
    (layer) => layer.id === "boundary_disputed",
  );
  assert.equal(basemap.layers[disputedIndex + 1].id, KOREA_FIX_CASING);
  assert.equal(basemap.layers[disputedIndex + 2].id, KOREA_FIX_LINE);
  assert.ok(
    basemap.layers.findIndex((layer) => layer.id === "label_city") >
      disputedIndex + 2,
  );
});

test("z4 Korean border repair follows the dark basemap palette", async () => {
  const win = makeContext();
  const basemap = await win.RailMapBasemap.loadBasemap("dark");
  const byId = new Map(basemap.layers.map((l) => [l.id, l]));
  assert.equal(
    byId.get(KOREA_FIX_CASING).paint["line-color"],
    "rgb(12,12,12)",
  );
  assert.equal(
    byId.get(KOREA_FIX_LINE).paint["line-color"],
    "hsl(0,0%,38%)",
  );
});

test("switching the country leaves the basemap alone", async () => {
  const win = makeContext();
  const RailMap = loadRailMap(win);
  const basemap = await win.RailMapBasemap.loadBasemap("light");
  const byId = new Map(basemap.layers.map((l) => [l.id, l]));
  const filters = new Map();
  const reloads = [];
  RailMap._map = {
    getSource: () => null,
    getLayer: (id) => byId.get(id),
    getFilter: (id) => filters.get(id) || (byId.get(id) || {}).filter,
    setFilter: (id, filter) => filters.set(id, filter),
    style: { _reloadSource: (id) => reloads.push(id) },
  };
  RailMap._basemapLayerIds = basemap.layers.map((l) => l.id);

  assert.equal(
    RailMap.setBasemapLabelCountry,
    undefined,
    "the per-country label gate is removed from RailMap",
  );

  // The app's country switch flows through switchNetworkCountry. It touches
  // the rail sources only — no basemap re-filter, and above all no vector
  // source re-parse (that was the only reason the private _reloadSource was
  // ever called).
  await RailMap.switchNetworkCountry("tw");
  assert.deepEqual(Array.from(filters.keys()), []);
  assert.deepEqual(plain(reloads), []);
  await RailMap.switchNetworkCountry("jp");
  assert.deepEqual(Array.from(filters.keys()), []);
  assert.deepEqual(plain(reloads), []);
});
