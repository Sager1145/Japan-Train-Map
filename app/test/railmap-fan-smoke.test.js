// Smoke test for the split pick sources + coalesced expand pushes
// (hover-fan performance work). Loads the classic railmap-* scripts into a
// mock window with a fake MapLibre map and drives the fan open/close and
// data/scope paths that changed, asserting:
//   - the static pick source is NOT re-uploaded on fan open/close;
//   - the fan pick source holds only the open group's lanes (+ empties on close);
//   - animated expand uploads coalesce to at most one setData per frame;
//   - filters exclude engaged trains from the static pick layer while fanned.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeWindow() {
  const win = {};
  win.window = win;
  win.performance = { now: () => nowMs };
  win.console = console;
  // Deterministic rAF: callbacks run when we call flushFrames().
  win.__rafQueue = [];
  win.requestAnimationFrame = (cb) => {
    win.__rafQueue.push(cb);
    return win.__rafQueue.length;
  };
  win.cancelAnimationFrame = (id) => {
    if (id >= 1 && id <= win.__rafQueue.length) win.__rafQueue[id - 1] = null;
  };
  // Minimal basemap stub so railmap-style.js can load.
  win.RailMapBasemap = {
    MAP_SURFACE_COLORS: {
      light: { background: "#fff", fade: "#fff", casing: "#111" },
      dark: { background: "#000", fade: "#000", casing: "#eee" },
    },
    namespaceBasemap: (b) => ({ sources: {}, layers: [], opacityTargets: new Map() }),
    loadBasemap: async () => null,
    probeBasemapOrigin: async () => false,
    opacityPropsForLayer: () => [],
    BASEMAP_CROSSFADE_MS: 0,
  };
  win.RailNetwork = {};
  win.RailMapPopup = {
    buildPopupModel: () => null,
    stationPopupHtml: () => "",
  };
  return win;
}

let nowMs = 0;

function flushFrames(win, n = 1) {
  for (let i = 0; i < n; i += 1) {
    nowMs += 16;
    const q = win.__rafQueue;
    win.__rafQueue = [];
    q.forEach((cb) => cb && cb(nowMs));
  }
}

function loadScripts(win) {
  const pub = path.join(__dirname, "..", "public");
  const ctx = vm.createContext(win);
  for (const f of [
    "railmap-style.js",
    "railmap-geometry.js",
    "railmap.js",
    "railmap-interactions.js",
  ]) {
    vm.runInContext(fs.readFileSync(path.join(pub, f), "utf8"), ctx, {
      filename: f,
    });
  }
  return win;
}

// Fake MapLibre map: counts setData per source, records filters/paints.
function makeMap(win) {
  const style = win.RailMapStyle;
  const layerIds = new Set([
    style.TRAIN_ROUTES_LAYER,
    style.TRAIN_PICK_LAYER,
    style.TRAIN_PICK_FAN_LAYER,
    style.TRAIN_EXPAND_LAYER,
    style.TRAIN_EXPAND_HOVER_LAYER,
    style.TRAIN_HOVER_LAYER,
    style.TRAIN_SEL_CASING_LAYER,
    style.TRAIN_SEL_LAYER,
    style.TRAIN_PASS_LAYER,
    style.TRAIN_STOPS_LAYER,
    style.TRAIN_SEL_PASS_LAYER,
    style.TRAIN_SEL_STOPS_LAYER,
  ]);
  const sources = new Map();
  const counts = {};
  const lastData = {};
  const srcFor = (id) => {
    if (!sources.has(id))
      sources.set(id, {
        setData(fc) {
          counts[id] = (counts[id] || 0) + 1;
          lastData[id] = fc;
        },
      });
    return sources.get(id);
  };
  const filters = {};
  const canvas = { style: {}, addEventListener() {} };
  return {
    counts,
    lastData,
    filters,
    getSource: (id) => srcFor(id),
    getLayer: (id) => (layerIds.has(id) ? { id } : undefined),
    setFilter(id, f) {
      filters[id] = f;
    },
    setPaintProperty() {},
    setLayoutProperty() {},
    getPaintProperty: () => 0,
    getZoom: () => 8,
    getCenter: () => ({ lat: 35 }),
    unproject: () => ({ lng: 139, lat: 35 }),
    on() {},
    once() {},
    off() {},
    queryRenderedFeatures: () => [],
    getCanvas: () => canvas,
    getContainer: () => ({ dataset: {}, appendChild() {} }),
    triggerRepaint() {},
  };
}

function fixtureData() {
  // Two trains sharing a corridor (one overlap group) + one lone train.
  const tA = { id: "A" };
  const tB = { id: "B" };
  const tC = { id: "C" };
  const line = [
    [139.0, 35.0],
    [139.1, 35.05],
    [139.2, 35.1],
  ];
  const mk = (train, mult) => ({
    path: line,
    pickPath: line,
    shiftX: 0.5,
    shiftY: -0.5,
    laneMult: mult,
    color: [10, 20, 30, 255],
    width: 4,
    train,
    feature: {},
    pickWidth: 12,
    overlapCount: 2,
    overlapSlot: 0,
    groupKey: "G1",
    nopick: false,
    tdate: "2026-07-01",
  });
  const records = [
    mk(tA, -0.5),
    mk(tB, 0.5),
    {
      path: line,
      pickPath: line,
      shiftX: 0,
      shiftY: 0,
      laneMult: 0,
      color: [1, 2, 3, 255],
      width: 4,
      train: tC,
      feature: {},
      pickWidth: 14,
      overlapCount: 1,
      overlapSlot: 0,
      groupKey: "",
      nopick: false,
      tdate: "2026-07-02",
    },
  ];
  const expandRecords = [
    { path: line, color: [10, 20, 30, 255], width: 4, train: tA },
    { path: line, color: [40, 50, 60, 255], width: 4, train: tB },
    { path: line, color: [1, 2, 3, 255], width: 4, train: tC },
  ];
  const groupInfo = new Map([
    [
      "G1",
      { sx: 0.5, sy: -0.5, mults: { A: -0.5, B: 0.5 }, curve: null },
    ],
  ]);
  return { records, expandRecords, groupInfo };
}

test("fan open/close touches only the fan pick source; expand pushes coalesce", () => {
  const win = loadScripts(makeWindow());
  const style = win.RailMapStyle;
  const RailMap = win.RailMap;
  const map = makeMap(win);
  RailMap.attach(map, null, {}, [], [], "light", {});

  const { records, expandRecords, groupInfo } = fixtureData();
  RailMap.setData(records, expandRecords, groupInfo, 0.001);
  flushFrames(win, 2);

  const staticAfterData = map.counts[style.TRAIN_PICK_SOURCE] || 0;
  assert.ok(staticAfterData >= 1, "static pick uploaded on setData");

  // ── open the fan ──
  RailMap._setFanDirTarget("G1", { lng: 139.1, lat: 35.05 });
  RailMap._setExpandedGroup("G1");
  // run the slide animation to completion (240ms / 16ms ≈ 15 frames + slack)
  flushFrames(win, 25);

  assert.strictEqual(
    map.counts[style.TRAIN_PICK_SOURCE] || 0,
    staticAfterData,
    "static pick source must NOT re-upload on fan open",
  );
  const fanFC = map.lastData[style.TRAIN_PICK_FAN_SOURCE];
  assert.ok(fanFC && fanFC.features.length === 2, "fan source holds the two lanes");
  // JSON compare: arrays from the vm context have a foreign Array prototype,
  // which deepStrictEqual rejects.
  assert.strictEqual(
    JSON.stringify(fanFC.features.map((f) => f.properties.tid).sort()),
    JSON.stringify(["A", "B"]),
  );
  // Engaged trains are filtered out of the static pick layer.
  const pickFilter = JSON.stringify(map.filters[style.TRAIN_PICK_LAYER] || null);
  assert.ok(pickFilter.includes("A") && pickFilter.includes("B"));

  // Expand slide must coalesce: never more uploads than frames elapsed + the
  // synchronous open/commit pushes (was previously up to 2-3 per frame).
  const expandUploads = map.counts[style.TRAIN_EXPAND_SOURCE] || 0;
  assert.ok(
    expandUploads <= 25 + 3,
    `expand uploads (${expandUploads}) stay ≤ one per frame`,
  );

  // ── close the fan ──
  RailMap._setExpandedGroup(null);
  flushFrames(win, 25);
  assert.strictEqual(
    map.counts[style.TRAIN_PICK_SOURCE] || 0,
    staticAfterData,
    "static pick source must NOT re-upload on fan close",
  );
  const fanAfterClose = map.lastData[style.TRAIN_PICK_FAN_SOURCE];
  assert.strictEqual(fanAfterClose.features.length, 0, "fan source empties");
  // Static pick layer filter releases the engaged trains again.
  const releasedFilter = JSON.stringify(map.filters[style.TRAIN_PICK_LAYER]);
  assert.ok(releasedFilter.includes('"literal",[]'));
});

test("updateLaneSpacing skips the static pick source entirely", () => {
  const win = loadScripts(makeWindow());
  const style = win.RailMapStyle;
  const RailMap = win.RailMap;
  const map = makeMap(win);
  RailMap.attach(map, null, {}, [], [], "light", {});
  const { records, expandRecords, groupInfo } = fixtureData();
  RailMap.setData(records, expandRecords, groupInfo, 0.001);
  const staticBefore = map.counts[style.TRAIN_PICK_SOURCE] || 0;
  RailMap.updateLaneSpacing(0.002);
  assert.strictEqual(
    map.counts[style.TRAIN_PICK_SOURCE] || 0,
    staticBefore,
    "zoom-driven lane spacing must not re-upload the static pick source",
  );
});

test("routeExpandFC reuses its feature template across animation frames", () => {
  const win = loadScripts(makeWindow());
  const geo = win.RailMapGeometry;
  const { expandRecords, groupInfo } = fixtureData();
  const gi = groupInfo.get("G1");
  const a = geo.routeExpandFC(expandRecords, gi, 0.001, null);
  const y1 = a.features[0].geometry.coordinates[0][1];
  const b = geo.routeExpandFC(expandRecords, gi, 0.002, null);
  // Same skeleton objects (no per-frame allocation) …
  assert.strictEqual(a.features[0], b.features[0]);
  assert.strictEqual(a.features.length, 2); // members A + B only
  // … but the coordinates moved with the new spacing.
  assert.notStrictEqual(b.features[0].geometry.coordinates[0][1], y1);
});

test("routePickFanFC returns EMPTY when no group and lanes for an open group", () => {
  const win = loadScripts(makeWindow());
  const geo = win.RailMapGeometry;
  const { records, groupInfo } = fixtureData();
  assert.strictEqual(
    geo.routePickFanFC(records, groupInfo, null, null, 0.001, null).features
      .length,
    0,
  );
  const fc = geo.routePickFanFC(
    records,
    groupInfo,
    "G1",
    { sx: 0.5, sy: -0.5 },
    0.001,
    null,
  );
  assert.strictEqual(fc.features.length, 2);
  // Lanes are actually translated off the true track.
  const y0 = fc.features[0].geometry.coordinates[0][1];
  assert.notStrictEqual(y0, 35.0);
});
