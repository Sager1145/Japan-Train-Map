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
    style.TRAIN_XDAY_LAYER,
    style.TRAIN_XDAY_STOP_LAYER,
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
  const paints = {};
  const layouts = {};
  const listeners = {};
  const canvas = { style: {}, addEventListener() {} };
  return {
    counts,
    lastData,
    filters,
    paints,
    getSource: (id) => srcFor(id),
    getLayer: (id) => (layerIds.has(id) ? { id } : undefined),
    addLayer(layer) {
      layerIds.add(layer.id);
      filters[layer.id] = layer.filter;
      paints[layer.id] = { ...(layer.paint || {}) };
      layouts[layer.id] = { ...(layer.layout || {}) };
    },
    setFilter(id, f) {
      filters[id] = f;
    },
    setPaintProperty(id, prop, value) {
      if (!paints[id]) paints[id] = {};
      paints[id][prop] = value;
    },
    setLayoutProperty(id, prop, value) {
      if (!layouts[id]) layouts[id] = {};
      layouts[id][prop] = value;
    },
    getPaintProperty: (id, prop) => (paints[id] ? paints[id][prop] : 0),
    getZoom: () => 8,
    getCenter: () => ({ lat: 35 }),
    unproject: () => ({ lng: 139, lat: 35 }),
    project: (p) => ({ x: p[0] ?? p.lng, y: p[1] ?? p.lat }),
    on(event, cb) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    emit(event, payload) {
      (listeners[event] || []).forEach((cb) => cb(payload));
    },
    once() {},
    off() {},
    queryRenderedFeatures: () => [],
    getCanvas: () => canvas,
    getContainer: () => ({ dataset: {}, appendChild() {} }),
    triggerRepaint() {},
  };
}

function evalPaint(expr, properties) {
  if (!Array.isArray(expr)) return expr;
  const op = expr[0];
  if (op === "get") return properties[expr[1]];
  if (op === "literal") return expr[1];
  if (op === "match") {
    const input = evalPaint(expr[1], properties);
    for (let i = 2; i < expr.length - 1; i += 2) {
      if (input === expr[i]) return evalPaint(expr[i + 1], properties);
    }
    return evalPaint(expr.at(-1), properties);
  }
  if (op === "+")
    return expr.slice(1).reduce((sum, part) => sum + evalPaint(part, properties), 0);
  if (op === "*")
    return expr.slice(1).reduce((product, part) => product * evalPaint(part, properties), 1);
  if (op === "-") {
    if (expr.length === 2) return -evalPaint(expr[1], properties);
    return evalPaint(expr[1], properties) - evalPaint(expr[2], properties);
  }
  throw new Error(`Unsupported paint expression in test: ${JSON.stringify(expr)}`);
}

function paintOpacity(map, layer, tid, prop = "line-opacity") {
  return evalPaint(map.paints[layer][prop], { tid, alpha: 1 });
}

function assertNear(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

function fixtureData() {
  // Two trains sharing a corridor (G1), an adjacent corridor shared by one of
  // them plus a fourth train (G2 — exercises the cross-group transition), and
  // one lone train.
  const tA = { id: "A" };
  const tB = { id: "B" };
  const tC = { id: "C" };
  const tD = { id: "D" };
  const line = [
    [139.0, 35.0],
    [139.1, 35.05],
    [139.2, 35.1],
  ];
  const line2 = [
    [139.2, 35.1],
    [139.3, 35.15],
    [139.4, 35.2],
  ];
  const mk = (train, mult, groupKey = "G1", path = line) => ({
    path,
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
    groupKey,
    nopick: false,
    tdate: "2026-07-01",
  });
  const records = [
    mk(tA, -0.5),
    mk(tB, 0.5),
    mk(tB, -0.5, "G2", line2),
    mk(tD, 0.5, "G2", line2),
    {
      path: line,
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
    { path: line2, color: [70, 80, 90, 255], width: 4, train: tD },
  ];
  const groupInfo = new Map([
    [
      "G1",
      { sx: 0.5, sy: -0.5, mults: { A: -0.5, B: 0.5 }, curve: null },
    ],
    [
      "G2",
      { sx: 0.5, sy: -0.5, mults: { B: -0.5, D: 0.5 }, curve: null },
    ],
  ]);
  return { records, expandRecords, groupInfo };
}

test("fan open/close uploads true geometry once; animation is paint-only", () => {
  const win = loadScripts(makeWindow());
  const style = win.RailMapStyle;
  const RailMap = win.RailMap;
  const map = makeMap(win);
  RailMap.attach(map, null, {}, [], [], "light", {});

  const { records, expandRecords, groupInfo } = fixtureData();
  RailMap.setData(records, expandRecords, groupInfo, 12);
  flushFrames(win, 2);

  const staticAfterData = map.counts[style.TRAIN_PICK_SOURCE] || 0;
  assert.ok(staticAfterData >= 1, "static pick uploaded on setData");

  // ── open the fan ──
  RailMap._setFanDirTarget("G1", { lng: 139.1, lat: 35.05 });
  RailMap._setExpandedGroup("G1");
  const expandUploadsAfterOpen = map.counts[style.TRAIN_EXPAND_SOURCE] || 0;
  const fanUploadsAfterOpen = map.counts[style.TRAIN_PICK_FAN_SOURCE] || 0;
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
  assert.strictEqual(
    map.counts[style.TRAIN_EXPAND_SOURCE] || 0,
    expandUploadsAfterOpen,
    "slide frames never re-upload expand GeoJSON",
  );
  assert.strictEqual(
    map.counts[style.TRAIN_PICK_FAN_SOURCE] || 0,
    fanUploadsAfterOpen,
    "slide frames never re-upload pick GeoJSON",
  );
  const assigned = RailMap._fanLanePool.filter((slot) => slot.tid);
  assert.strictEqual(assigned.length, 2, "one pooled slot per member tid");
  assigned.forEach((slot) => {
    const visible = map.paints[slot.visibleId]["line-translate"];
    assert.ok(Math.hypot(visible[0], visible[1]) > 0, `${slot.tid} translated`);
    assert.strictEqual(
      JSON.stringify(map.paints[slot.hoverId]["line-translate"]),
      JSON.stringify(visible),
    );
    assert.strictEqual(
      JSON.stringify(map.paints[slot.pickId]["line-translate"]),
      JSON.stringify(visible),
    );
  });
  // Engaged trains are filtered out of the static pick layer.
  const pickFilter = JSON.stringify(map.filters[style.TRAIN_PICK_LAYER] || null);
  assert.ok(pickFilter.includes("A") && pickFilter.includes("B"));

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

test("zoom keeps GPU lane offsets without any fan source upload", () => {
  const win = loadScripts(makeWindow());
  const style = win.RailMapStyle;
  const RailMap = win.RailMap;
  const map = makeMap(win);
  RailMap.attach(map, null, {}, [], [], "light", {});
  const { records, expandRecords, groupInfo } = fixtureData();
  RailMap.setData(records, expandRecords, groupInfo, 12);
  RailMap._setFanDirTarget("G1", { lng: 139.1, lat: 35.05 });
  RailMap._setExpandedGroup("G1");
  flushFrames(win, 25);
  const expandBefore = map.counts[style.TRAIN_EXPAND_SOURCE] || 0;
  const pickBefore = map.counts[style.TRAIN_PICK_FAN_SOURCE] || 0;
  const translations = RailMap._fanLanePool.map((slot) =>
    JSON.stringify(slot.translate),
  );
  map.emit("zoom");
  flushFrames(win, 2);
  assert.strictEqual(
    map.counts[style.TRAIN_EXPAND_SOURCE] || 0,
    expandBefore,
  );
  assert.strictEqual(
    map.counts[style.TRAIN_PICK_FAN_SOURCE] || 0,
    pickBefore,
  );
  assert.strictEqual(
    JSON.stringify(RailMap._fanLanePool.map((slot) => JSON.stringify(slot.translate))),
    JSON.stringify(translations),
  );
});

test("a settled group switch re-scopes the fan sources to the target group", () => {
  const win = loadScripts(makeWindow());
  const style = win.RailMapStyle;
  const RailMap = win.RailMap;
  const map = makeMap(win);
  RailMap.attach(map, null, {}, [], [], "light", {});
  const { records, expandRecords, groupInfo } = fixtureData();
  RailMap.setData(records, expandRecords, groupInfo, 12);
  RailMap._setFanDirTarget("G1", { lng: 139.1, lat: 35.05 });
  RailMap._setExpandedGroup("G1");
  flushFrames(win, 25);

  // Fully-fanned G1 → G2 takes the cross-group transition path.
  RailMap._setFanDirTarget("G2", { lng: 139.3, lat: 35.15 });
  RailMap._setExpandedGroup("G2");
  const midFC = map.lastData[style.TRAIN_PICK_FAN_SOURCE];
  // Mid-transition both corridors stay hit-testable (union upload).
  assert.strictEqual(
    JSON.stringify([...new Set(midFC.features.map((f) => f.properties.tid))].sort()),
    JSON.stringify(["A", "B", "D"]),
  );
  flushFrames(win, 30); // 320ms transition + slack

  // Settled: the FROM group's records must leave the pick source, or the
  // staying member's tid-filtered pool layer would keep a translated ghost
  // hit lane along the old corridor.
  const settledFC = map.lastData[style.TRAIN_PICK_FAN_SOURCE];
  assert.strictEqual(
    JSON.stringify(
      [...new Set(settledFC.features.map((f) => f.properties.tid))].sort(),
    ),
    JSON.stringify(["B", "D"]),
  );
  const settledExpand = map.lastData[style.TRAIN_EXPAND_SOURCE];
  assert.strictEqual(
    JSON.stringify(
      [...new Set(settledExpand.features.map((f) => f.properties.tid))].sort(),
    ),
    JSON.stringify(["B", "D"]),
  );
  const assigned = RailMap._fanLanePool
    .filter((slot) => slot.tid)
    .map((slot) => slot.tid)
    .sort();
  assert.strictEqual(JSON.stringify(assigned), JSON.stringify(["B", "D"]));
});

test("hovering directly from route A to B crossfades every opacity layer", () => {
  const win = loadScripts(makeWindow());
  const style = win.RailMapStyle;
  const RailMap = win.RailMap;
  const map = makeMap(win);
  RailMap.attach(map, null, {}, [], [], "light", {});

  RailMap._hoverTrainId = "A";
  RailMap._applyHoverFilter();
  flushFrames(win, 30);
  assertNear(
    paintOpacity(map, style.TRAIN_ROUTES_LAYER, "A"),
    1,
    "route A is bright after hover settles",
  );
  assertNear(
    paintOpacity(map, style.TRAIN_ROUTES_LAYER, "B"),
    style.HOVER_DIM,
    "route B is dim before the switch",
  );

  RailMap._hoverTrainId = "B";
  RailMap._applyHoverFilter();

  // The first committed state remains visually identical to the prior frame;
  // both tids are retained in the focus filter while their weights cross.
  assertNear(
    paintOpacity(map, style.TRAIN_ROUTES_LAYER, "A"),
    1,
    "route A does not snap dim on the switch frame",
  );
  assertNear(
    paintOpacity(map, style.TRAIN_ROUTES_LAYER, "B"),
    style.HOVER_DIM,
    "route B does not snap bright on the switch frame",
  );
  const switchingFilter = JSON.stringify(map.filters[style.TRAIN_HOVER_LAYER]);
  assert.ok(switchingFilter.includes("A") && switchingFilter.includes("B"));

  flushFrames(win, 8);
  const aMid = paintOpacity(map, style.TRAIN_ROUTES_LAYER, "A");
  const bMid = paintOpacity(map, style.TRAIN_ROUTES_LAYER, "B");
  assert.ok(aMid > style.HOVER_DIM && aMid < 1, "route A fades down");
  assert.ok(bMid > style.HOVER_DIM && bMid < 1, "route B fades up");

  // Route, cross-day, icon, circle fill and circle stroke all share the exact
  // same animated expression, so no marker or dashed continuation can snap.
  const baseExpr = JSON.stringify(
    map.paints[style.TRAIN_ROUTES_LAYER]["line-opacity"],
  );
  [
    [style.TRAIN_XDAY_LAYER, "line-opacity"],
    [style.TRAIN_XDAY_STOP_LAYER, "icon-opacity"],
    [style.TRAIN_PASS_LAYER, "circle-opacity"],
    [style.TRAIN_PASS_LAYER, "circle-stroke-opacity"],
    [style.TRAIN_STOPS_LAYER, "circle-opacity"],
    [style.TRAIN_STOPS_LAYER, "circle-stroke-opacity"],
  ].forEach(([layer, prop]) => {
    assert.strictEqual(JSON.stringify(map.paints[layer][prop]), baseExpr);
  });
  const focusAMid = paintOpacity(map, style.TRAIN_HOVER_LAYER, "A");
  const focusBMid = paintOpacity(map, style.TRAIN_HOVER_LAYER, "B");
  assert.ok(focusAMid > 0 && focusAMid < 1, "old wide focus fades out");
  assert.ok(focusBMid > 0 && focusBMid < 1, "new wide focus fades in");
  const selectedExpr = JSON.stringify(
    map.paints[style.TRAIN_SEL_LAYER]["line-opacity"],
  );
  [
    [style.TRAIN_SEL_PASS_LAYER, "circle-opacity"],
    [style.TRAIN_SEL_PASS_LAYER, "circle-stroke-opacity"],
    [style.TRAIN_SEL_STOPS_LAYER, "circle-opacity"],
    [style.TRAIN_SEL_STOPS_LAYER, "circle-stroke-opacity"],
  ].forEach(([layer, prop]) => {
    assert.strictEqual(JSON.stringify(map.paints[layer][prop]), selectedExpr);
  });
  assertNear(
    paintOpacity(map, style.TRAIN_SEL_CASING_LAYER, "A"),
    paintOpacity(map, style.TRAIN_SEL_LAYER, "A") * 0.9,
    "selected casing follows the same crossfade",
  );

  flushFrames(win, 24);
  assertNear(
    paintOpacity(map, style.TRAIN_ROUTES_LAYER, "A"),
    style.HOVER_DIM,
    "route A finishes dimmed",
  );
  assertNear(
    paintOpacity(map, style.TRAIN_ROUTES_LAYER, "B"),
    1,
    "route B finishes bright",
  );
  const settledFilter = JSON.stringify(map.filters[style.TRAIN_HOVER_LAYER]);
  assert.ok(!settledFilter.includes("A") && settledFilter.includes("B"));

  RailMap._hoverTrainId = null;
  RailMap._applyHoverFilter();
  flushFrames(win, 8);
  const aLeaveMid = paintOpacity(map, style.TRAIN_ROUTES_LAYER, "A");
  const focusBLeaveMid = paintOpacity(map, style.TRAIN_HOVER_LAYER, "B");
  assert.ok(aLeaveMid > style.HOVER_DIM && aLeaveMid < 1, "other routes fade back in");
  assert.ok(
    focusBLeaveMid > 0 && focusBLeaveMid < 1,
    "wide focus fades out on mouseleave",
  );
  flushFrames(win, 24);
  assertNear(
    paintOpacity(map, style.TRAIN_ROUTES_LAYER, "A"),
    1,
    "route A returns to normal after mouseleave",
  );
  assertNear(
    paintOpacity(map, style.TRAIN_HOVER_LAYER, "B"),
    0,
    "wide focus is gone after mouseleave",
  );
  assert.ok(!JSON.stringify(map.filters[style.TRAIN_HOVER_LAYER]).includes("B"));
});

test("switching lanes in an expanded fan crossfades only the wide focus", () => {
  const win = loadScripts(makeWindow());
  const style = win.RailMapStyle;
  const RailMap = win.RailMap;
  const map = makeMap(win);
  RailMap.attach(map, null, {}, [], [], "light", {});
  const { records, expandRecords, groupInfo } = fixtureData();
  RailMap.setData(records, expandRecords, groupInfo, 12);

  RailMap._hoverTrainId = "A";
  RailMap._applyHoverFilter();
  flushFrames(win, 30);
  RailMap._setExpandedGroup("G1");
  flushFrames(win, 35);

  // Both members of the open overlap group stay in the bright spotlight.
  assertNear(paintOpacity(map, style.TRAIN_ROUTES_LAYER, "A"), 1, "fan A bright");
  assertNear(paintOpacity(map, style.TRAIN_ROUTES_LAYER, "B"), 1, "fan B bright");
  assertNear(
    paintOpacity(map, style.TRAIN_ROUTES_LAYER, "C"),
    style.HOVER_DIM,
    "non-member C dim",
  );

  RailMap._hoverTrainId = "B";
  RailMap._applyHoverFilter();
  flushFrames(win, 8);

  assertNear(
    paintOpacity(map, style.TRAIN_ROUTES_LAYER, "A"),
    1,
    "fan member A remains bright",
  );
  assertNear(
    paintOpacity(map, style.TRAIN_ROUTES_LAYER, "B"),
    1,
    "fan member B remains bright",
  );
  const expandedAMid = paintOpacity(
    map,
    style.TRAIN_EXPAND_HOVER_LAYER,
    "A",
  );
  const expandedBMid = paintOpacity(
    map,
    style.TRAIN_EXPAND_HOVER_LAYER,
    "B",
  );
  assert.ok(expandedAMid > 0 && expandedAMid < 1, "old fan lane focus fades out");
  assert.ok(expandedBMid > 0 && expandedBMid < 1, "new fan lane focus fades in");
});

test("routeExpandBaseFC keeps true geometry for pooled GPU translation", () => {
  const win = loadScripts(makeWindow());
  const geo = win.RailMapGeometry;
  const { expandRecords, groupInfo } = fixtureData();
  const a = geo.routeExpandBaseFC(expandRecords, ["A", "B"]);
  const b = geo.routeExpandBaseFC(expandRecords, ["A", "B"]);
  assert.strictEqual(a.features[0], b.features[0]);
  assert.strictEqual(a.features.length, 2);
  assert.strictEqual(a.features[0].geometry.coordinates[0][1], 35.0);
});

test("routePickFanBaseFC returns true-track lanes for active groups", () => {
  const win = loadScripts(makeWindow());
  const geo = win.RailMapGeometry;
  const { records, groupInfo } = fixtureData();
  assert.strictEqual(
    geo.routePickFanBaseFC(records, groupInfo, []).features.length,
    0,
  );
  const fc = geo.routePickFanBaseFC(records, groupInfo, ["G1"]);
  assert.strictEqual(fc.features.length, 2);
  const y0 = fc.features[0].geometry.coordinates[0][1];
  assert.strictEqual(y0, 35.0);
});

test("fanPerpAt applies the 70m branch tolerance to distance, not squared distance", () => {
  const win = loadScripts(makeWindow());
  const { fanPerpAt } = win.RailMapGeometry;
  const deg = (metres) => metres / 111320;
  const curve = (localMetres) => ({
    pts: [
      [0, deg(localMetres)],
      [0.01, deg(localMetres)],
      [1, deg(100)],
      [0.01, deg(100)],
      [0, deg(100)],
    ],
    cum: [0, 100, 50000, 100000, 100100],
    totalMeters: 100100,
    coslat: 1,
    radiusMeters: 800,
    dirs: [[1, 0], [1, 0], [1, 0], [-1, 0], [-1, 0]],
  });
  const point = { lng: 0.005, lat: 0 };

  const withinTolerance = fanPerpAt(curve(150), point, 50);
  assert.ok(withinTolerance.s < 1200, "50m farther hinted branch stays engaged");

  const outsideTolerance = fanPerpAt(curve(180), point, 50);
  assert.ok(outsideTolerance.s > 90000, "80m farther hinted branch yields globally");
});
