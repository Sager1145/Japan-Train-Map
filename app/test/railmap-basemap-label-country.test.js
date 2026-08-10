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

// A miniature positron: one background, one fill, one road line, and two
// label (symbol) layers — one with an original filter, one without.
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

// Even-odd ray cast; the outlines carry no holes, so ring 0 suffices.
function areaContains(area, lon, lat) {
  return area.coordinates.some((poly) => {
    const ring = poly[0];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      )
        inside = true !== inside;
    }
    return inside;
  });
}

// Values built inside the VM context carry that realm's Array prototype,
// which node's deepStrictEqual rejects; normalize through JSON first.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function withinArea(filter) {
  // ["within", area] or ["all", base, ["within", area]]
  if (filter[0] === "within") return filter[1];
  const within = filter[filter.length - 1];
  assert.equal(within[0], "within");
  return within[1];
}

test("basemap label layers carry the per-country gate metadata", async () => {
  const win = makeContext();
  const basemap = await win.RailMapBasemap.loadBasemap("light");
  const byId = new Map(basemap.layers.map((l) => [l.id, l]));

  // Symbol layers: combined jp+tw gate baked, pre-gate filter in metadata.
  const city = byId.get("label_city");
  assert.deepEqual(plain(city.filter.slice(0, 2)), [
    "all",
    ["==", ["get", "class"], "city"],
  ]);
  assert.equal(city.filter[2][0], "within");
  assert.deepEqual(plain(city.metadata[LABEL_BASE_KEY]), [
    "==",
    ["get", "class"],
    "city",
  ]);
  const airport = byId.get("airport");
  assert.equal(airport.filter[0], "within");
  assert.equal(airport.metadata[LABEL_BASE_KEY], null);

  // Non-symbol detail keeps the combined gate and is NOT label-gated.
  const road = byId.get("highway_minor");
  assert.equal(road.filter[0], "within");
  assert.equal(road.metadata, undefined);
  const detailArea = withinArea(road.filter);
  assert.equal(detailArea.coordinates.length, 4);
  assert.ok(areaContains(detailArea, 114.1694, 22.3193), "detail keeps Hong Kong");
  assert.ok(areaContains(detailArea, 113.5439, 22.1987), "detail keeps Macao");
  assert.ok(areaContains(detailArea, 114.0579, 22.5431), "detail keeps Shenzhen context");
  assert.ok(areaContains(detailArea, 113.5767, 22.2707), "detail keeps Zhuhai context");
  assert.equal(
    basemap.sources["jp-tw-detail-mask"].data.geometry.coordinates.length,
    5,
    "world exterior plus four regional detail holes",
  );
  const gate = win.RailMapBasemap.labelGateFilterForCountry;
  assert.equal(gate(road, "tw"), undefined);
  assert.equal(gate(byId.get("water"), "tw"), undefined);

  // Per-country gates select the active outline plus Hong Kong and Macao;
  // unknown/null falls back to all four full-detail regions.
  const tw = withinArea(gate(city, "tw"));
  const jp = withinArea(gate(city, "jp"));
  const hk = withinArea(gate(city, "hk"));
  const mo = withinArea(gate(city, "mo"));
  const both = withinArea(gate(city, null));
  assert.equal(tw.coordinates.length, 7);
  assert.equal(jp.coordinates.length, 7);
  assert.equal(hk.coordinates.length, 1);
  assert.equal(mo.coordinates.length, 1);
  assert.equal(both.coordinates.length, 4);

  // The split outlines caption the active country and both SARs, while nearby
  // mainland cities and the inactive country remain excluded.
  const cities = {
    taipei: [121.56, 25.03],
    kaohsiung: [120.3, 22.62],
    magong: [119.57, 23.57],
    tokyo: [139.69, 35.68],
    naha: [127.68, 26.21],
    ishigaki: [124.16, 24.34],
    wakkanai: [141.67, 45.42],
    busan: [129.04, 35.1],
    seoul: [126.98, 37.57],
    fuzhou: [119.31, 26.07],
    shanghai: [121.47, 31.23],
    vladivostok: [131.89, 43.12],
    hongKong: [114.1694, 22.3193],
    macao: [113.5439, 22.1987],
    shenzhen: [114.0579, 22.5431],
    zhuhai: [113.5767, 22.2707],
  };
  const referenceCities = ["hongKong", "macao"];
  const inTw = ["taipei", "kaohsiung", "magong"].concat(referenceCities);
  const inJp = ["tokyo", "naha", "ishigaki", "wakkanai"].concat(
    referenceCities,
  );
  for (const [name, [lon, lat]] of Object.entries(cities)) {
    assert.equal(areaContains(tw, lon, lat), inTw.includes(name), `tw ${name}`);
    assert.equal(areaContains(jp, lon, lat), inJp.includes(name), `jp ${name}`);
  }
  assert.ok(areaContains(hk, ...cities.hongKong), "hk captions Hong Kong");
  assert.ok(areaContains(hk, ...cities.shenzhen), "hk captions Shenzhen context");
  assert.ok(!areaContains(hk, ...cities.macao), "hk excludes distant Macao labels");
  assert.ok(areaContains(mo, ...cities.macao), "mo captions Macao");
  assert.ok(areaContains(mo, ...cities.zhuhai), "mo captions Zhuhai context");
  assert.ok(!areaContains(mo, ...cities.hongKong), "mo excludes distant Hong Kong labels");
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

test("switching the country re-filters the live basemap label layers", async () => {
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

  // The app's country switch flows through switchNetworkCountry.
  await RailMap.switchNetworkCountry("tw");
  assert.equal(RailMap._labelCountry, "tw");
  assert.deepEqual(
    Array.from(filters.keys()).sort(),
    ["airport", "label_city"],
    "only label layers are re-filtered",
  );
  // Already-loaded tiles only re-evaluate filters on a re-parse, so the
  // switch must reload the label layers' vector source — exactly once.
  assert.deepEqual(plain(reloads), ["openmaptiles"]);
  // Re-applying the SAME country is a no-op: no reload storm at boot, where
  // the style already bakes the boot country's gate.
  reloads.length = 0;
  RailMap.setBasemapLabelCountry("tw");
  assert.deepEqual(plain(reloads), []);
  let area = withinArea(filters.get("label_city"));
  assert.equal(area.coordinates.length, 7);
  assert.ok(areaContains(area, 121.56, 25.03), "tw gate keeps Taipei");
  assert.ok(areaContains(area, 114.1694, 22.3193), "tw gate keeps Hong Kong");
  assert.ok(areaContains(area, 113.5439, 22.1987), "tw gate keeps Macao");
  assert.ok(!areaContains(area, 139.69, 35.68), "tw gate drops Tokyo");
  assert.ok(!areaContains(area, 114.0579, 22.5431), "tw gate drops Shenzhen");

  await RailMap.switchNetworkCountry("jp");
  area = withinArea(filters.get("label_city"));
  assert.ok(areaContains(area, 139.69, 35.68), "jp gate keeps Tokyo");
  assert.ok(areaContains(area, 114.1694, 22.3193), "jp gate keeps Hong Kong");
  assert.ok(areaContains(area, 113.5439, 22.1987), "jp gate keeps Macao");
  assert.ok(!areaContains(area, 121.56, 25.03), "jp gate drops Taipei");
  assert.ok(!areaContains(area, 113.5767, 22.2707), "jp gate drops Zhuhai");
  // The original place filter survives every re-gate.
  assert.deepEqual(plain(filters.get("label_city")[1]), [
    "==",
    ["get", "class"],
    "city",
  ]);

  // A later install re-gates the cached (combined-gate) style in place.
  const staged = { id: "label_city-staged", type: "symbol" };
  Object.assign(staged, byId.get("label_city"), { id: "label_city-staged" });
  const gate = win.RailMapBasemap.labelGateFilterForCountry(
    staged,
    RailMap._labelCountry,
  );
  assert.ok(areaContains(withinArea(gate), 139.69, 35.68));
  assert.ok(!areaContains(withinArea(gate), 121.56, 25.03));
});
