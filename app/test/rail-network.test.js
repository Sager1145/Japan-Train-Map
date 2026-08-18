"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const RailNetwork = require("../public/rail-network.js");

const PACKAGE_PATH = path.join(
  __dirname,
  "../public/rail/jp-2025.json",
);
// 607 lines, not 600: seven branches that the package had spliced into their
// trunk's station order each ship as their own `-2` entry
// (scripts/railway/split-interleaved-branches.mjs) — 砂原支線, 辰野支線, 南武支線,
// 常陸太田支線, the 総武本線 御茶ノ水 支線, the 予讃線 新線 and 東武小泉線's
// 太田支線. Their junction
// stations are second copies sharing the existing station groups, so `groups`
// is unchanged while `stations` grows by one per junction.
//
// Drawn features for those 607 lines: where two INDEPENDENT railways share
// a corridor each takes its own lane, and a lane — plus the quarter-steps that
// ease the line into and out of it — is a feature of its own so it can carry
// its own screen-space offset (rail-network.js splitPartByLanes, table from
// scripts/railway/build-parallel-corridors.mjs). Every feature still carries its
// line's own id.
const EXPECTED_COUNTS = Object.freeze({
  // Not 607 (one feature per line): a line that takes a parallel lane ships
  // one feature per lane VALUE, and the ramp in and out of a lane is two more.
  // 横浜市 1号線 and 3号線 are two line numbers of ONE railway (ブルーライン,
  // through-operated across 関内) and so share a stroke rather than a corridor.
  //
  // Rebuilt 2026-08-15: 649 lines against the old 607, because each railway's
  // separate alignments are now their own strokes. Stations rise with them
  // (a junction shared by two strokes is a platform row on each) while station
  // GROUPS fall slightly, since the rebuild draws 4 lines fewer — the ones with
  // no passenger adjacency at all, itemised in the ledger.
  // +3 lines / +3 segments / +7 platforms: 上越線's up bore in two spans (it
  // separates again past 土樽 for the 松川ループ) and 北陸線's 鳩原ループ — every
  // separated alignment a source confirms AND N02 carries as its own track. Candidates that are only one of those two are
  // recorded in the evidence file rather than drawn, so this number tracks
  // sourced fact, not a distance threshold.
  // 907 once lanes became a property of the RAILWAY rather than the stroke:
  // a railway drawn as several strokes shares one lane, so the split-at-lane-
  // boundary features it used to generate collapse.
  // +1 line / +1 segment / +3 platforms (2026-08-18): 東海道線's 新垂井線 —
  // 東海道線-2 now starts at 大垣 (closing the undrawn 大垣–垂井 main line)
  // and the 下り-only bypass of 垂井 is its own -2-p1 stroke.
  // −3 lines / −3 segments / +2 platforms (2026-08-18, gap repairs): five
  // severed strokes rejoined their railways (石北線-2, 常磐線-2, 日豊線-2 and
  // its -2-p1, 山陽線-4 plus the old 山陽線-2 span) while 日豊線-p1 and
  // 長崎線-3 appeared; the platform rows the removed strokes carried moved
  // onto the merged trunks, and the two new junction seats (喜々津 and 西浦上
  // on the 長崎線 ring) account for the net +2. Groups are unchanged — no
  // station appeared or vanished, only strokes.
  // −1 line / −7 segments / −6 platforms (2026-08-18, pseudo-edge removals):
  // deleting the 大井町—西大井 蛇窪 V edge let the 東海道線(JR東日本) family
  // settle around its real 品川–鶴見 ring (main 29→22 stations shed five
  // lane-split features; the ring -2 gained one), and deleting the three
  // 成田-skipping edges folded 成田線 to three strokes sharing 成田, removing
  // 成田線-4. The trimmed 中野 lead-in also dissolved 国分寺線's marginal
  // corridor stretch (one feature fewer) while 京成成田空港線's airport
  // corridor re-paired against the new 成田線-3 (one fewer). Groups are
  // unchanged — no station appeared or vanished, only strokes.
  // −2 lines / +1 segment (2026-08-18, official shapes): 長崎線's trunk now
  // runs 鳥栖–長崎 via the 市布新線 with the 旧線 as a rejoining 喜々津–浦上
  // branch (長崎線-3 folded in), and 東海道線(JR東日本)'s trunk runs 東京–熱海
  // via 品川・川崎・横浜 with the 品鶴線 as its own 品川–鶴見 stroke (相鉄連絡線
  // renumbers -4 → -3). Platform rows balance exactly (43 and 40 per family,
  // before and after), so stations and groups hold still; the +1 feature is
  // the 品鶴線's lane split — its 新幹線-corridor pairing re-solved from the
  // old ring's 2 features into 5 on the open stroke.
  segments: 915,
  stations: 10222,
  lines: 658,
  groups: 9039,
});
test("compact rail package produces the characterized render model", async () => {
  // Snapshot + expected hash are shared with test/rail-loader-parity.test.mjs
  // (one hash update per package regeneration). The shared module is ESM and
  // this file is CJS, hence the dynamic import.
  const { EXPECTED_RENDER_HASH, renderRelevantSnapshot } = await import(
    "../scripts/railway/lib/render-snapshot.mjs"
  );
  const compactPackage = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const network =
    RailNetwork.buildNetworkFromCompactPackage(compactPackage);

  assert.ok(network);
  assert.deepEqual(
    {
      segments: network.segments.features.length,
      stations: network.stations.features.length,
      lines: network.lineById.size,
      groups: network.groupMembers.size,
    },
    EXPECTED_COUNTS,
  );
  assert.equal(network.stationById.size, EXPECTED_COUNTS.stations);
  const lineMinZoom = new Map(
    network.segments.features.map((feature) => [
      feature.properties.lineId,
      feature.properties.minz,
    ]),
  );
  for (const station of network.stations.features) {
    const line = network.lineById.get(station.properties.lineId);
    assert.ok(
      station.properties.minz >= lineMinZoom.get(station.properties.lineId),
      `${station.properties.stationId} must not outlive its whole line`,
    );
    assert.equal(
      station.properties.lineMinz,
      lineMinZoom.get(station.properties.lineId),
    );
    if (station.properties.isTerminal) {
      assert.equal(line.isLoop, false);
      assert.equal(
        station.properties.minz,
        station.properties.lineMinz,
        `${station.properties.stationId} endpoint must follow its line`,
      );
    }
  }
  assert.ok(
    network.stations.features.some(
      (station) =>
        !station.properties.isTerminal &&
        station.properties.minz > station.properties.lineMinz,
    ),
    "dense intermediate stations must still wait for a closer zoom",
  );

  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(renderRelevantSnapshot(network)))
    .digest("hex");
  assert.equal(digest, EXPECTED_RENDER_HASH);
});

test("rail package validation and zoom helpers preserve current behavior", () => {
  assert.equal(RailNetwork.buildNetworkFromCompactPackage(null), null);
  assert.equal(
    RailNetwork.buildNetworkFromCompactPackage({ format: "legacy", lines: [] }),
    null,
  );
  assert.equal(RailNetwork.minZoomForRank(null), 0);
  assert.equal(RailNetwork.minZoomForRank(0), 3);
  assert.equal(RailNetwork.minZoomForRank(99), 0);
  assert.equal(RailNetwork.stationMinZoomForLine(6, 0, 10), 6);
});

test("line length LOD groups same-operator pieces and keeps other operators separate", () => {
  const makeLine = (id, operator, km, latitude) => ({
    id,
    name: "Main Line",
    operator,
    rank: 1,
    color: "#123456",
    stations: [
      [`${id}-a`, "A", 130, latitude],
      [`${id}-b`, "B", 130.1, latitude],
    ],
    segments: [[km, 0, [[130, latitude], [130.1, latitude]]]],
  });
  const network = RailNetwork.buildNetworkFromCompactPackage({
    format: "compact-v1",
    version: "lod-fixture",
    lines: [
      makeLine("piece-a", "Grouped Rail", 10, 30),
      makeLine("piece-b", "Grouped Rail", 25, 31),
      makeLine("other", "Other Rail", 10, 32),
    ],
  });
  const byId = new Map(
    network.segments.features.map((feature) => [
      feature.properties.lineId,
      feature.properties,
    ]),
  );

  assert.equal(byId.get("piece-a").visibilityKm, 35);
  assert.equal(byId.get("piece-b").visibilityKm, 35);
  assert.equal(byId.get("piece-a").minz, 5);
  assert.equal(byId.get("piece-b").minz, 5);
  assert.equal(byId.get("other").visibilityKm, 10);
  assert.equal(byId.get("other").minz, 7);
  for (const station of network.stations.features)
    assert.ok(
      station.properties.minz >= byId.get(station.properties.lineId).minz,
    );
});

test("network LOD is paint-time, never a tile-parse zoom filter", () => {
  const win = { console };
  win.window = win;
  win.RailNetwork = RailNetwork;
  win.RailMapBasemap = {
    MAP_SURFACE_COLORS: {
      light: {
        background: "#fff",
        fade: "#fff",
        stationDot: "#fff",
        stationRing: "#000",
      },
      dark: {
        background: "#000",
        fade: "#000",
        stationDot: "#000",
        stationRing: "#fff",
      },
    },
    namespaceBasemap: (value) => value,
  };
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../public/railmap-style.js"), "utf8"),
    vm.createContext(win),
    { filename: "railmap-style.js" },
  );
  const style = win.RailMapStyle.buildBaseStyle({
    country: "jp",
    theme: "light",
    fadeOpacity: 0,
  });
  const byId = new Map(style.layers.map((layer) => [layer.id, layer]));
  const lines = byId.get(win.RailMapStyle.SEGMENTS_LAYER);
  const stations = byId.get(win.RailMapStyle.STATIONS_LAYER);

  // The LOD gate is the point: it may never be a FILTER, because geojson
  // filters are evaluated per tile-parse and neighbouring tiles can disagree
  // about the zoom. A filter on a static per-feature property is fine — the
  // stations layer uses one to hand laned platforms to the stub layers that
  // can follow their railway into its lane.
  const mentionsZoom = (value) =>
    JSON.stringify(value ?? null).includes('["zoom"]');
  assert.equal(lines.filter, undefined);
  assert.ok(!mentionsZoom(stations.filter));
  assert.deepEqual(JSON.parse(JSON.stringify(stations.filter)), [
    "==",
    ["coalesce", ["get", "lane"], 0],
    0,
  ]);
  assert.equal(style.sources[win.RailMapStyle.SEGMENTS_SOURCE].tolerance, 0.5);
  assert.equal(style.sources[win.RailMapStyle.TRAIN_ROUTES_SOURCE].tolerance, 0.5);
  assert.equal(lines.paint["line-opacity"][0], "step");
  assert.equal(stations.paint["circle-opacity"][0], "step");
  assert.equal(stations.paint["circle-opacity"].at(-2), 14);
  assert.equal(stations.paint["circle-opacity"].length, 31);
  assert.deepEqual(
    JSON.parse(JSON.stringify(stations.paint["circle-opacity"])),
    JSON.parse(JSON.stringify(stations.paint["circle-stroke-opacity"])),
  );
});

test("the render model emits one seamless, lightly groomed feature per line", () => {
  const compactPackage = {
    format: "compact-v1",
    version: "fixture",
    lines: [
      {
        id: "fixture-trunk",
        name: "Fixture",
        operator: "Fixture Rail",
        rank: 1,
        color: "#123456",
        stations: [
          ["a", "A", 0, 0],
          ["b", "B", 0.001, 0],
          ["c", "C", 0.002, 0],
        ],
        segments: [
          [0.1, 0, [[0, 0], [0.00001, 0], [0, 0], [0.00101, 0]]],
          [0.1, 0, [[0.00099, 0], [0.002, 0]]],
        ],
      },
      {
        id: "fixture-branch",
        name: "Fixture branch",
        operator: "Fixture Rail",
        rank: 2,
        color: "#654321",
        stations: [
          ["b", "B", 0.001, 0],
          ["d", "D", 0.001, 0.001],
        ],
        segments: [[0.1, 0, [[0.001, 0], [0.001, 0.001]]]],
      },
    ],
  };
  const before = JSON.stringify(compactPackage);
  const network = RailNetwork.buildNetworkFromCompactPackage(compactPackage);

  assert.equal(network.segments.features.length, compactPackage.lines.length);
  const trunk = network.segments.features[0];
  const branch = network.segments.features[1];
  assert.equal(trunk.geometry.type, "LineString");
  assert.deepEqual(trunk.geometry.coordinates, [
    [0, 0],
    [0.001, 0],
    [0.002, 0],
  ]);
  assert.deepEqual(branch.geometry.coordinates[0], trunk.geometry.coordinates[1]);
  assert.equal(trunk.properties.intervalCount, 2);
  assert.strictEqual(network.lineById.get("fixture-trunk").geometry, trunk.geometry);
  const trunkStations = network.stations.features.filter(
    (feature) => feature.properties.lineId === "fixture-trunk",
  );
  assert.deepEqual(
    trunkStations.map((feature) => feature.properties.isTerminal),
    [1, 0, 1],
  );
  assert.equal(trunkStations[0].properties.minz, trunk.properties.minz);
  assert.equal(trunkStations[2].properties.minz, trunk.properties.minz);
  assert.equal(JSON.stringify(compactPackage), before, "loader must not mutate its package");
});

test("ridden geometry is an exact slice of the complete display line", () => {
  const network = RailNetwork.buildNetworkFromCompactPackage({
    format: "compact-v1",
    version: "ridden-fixture",
    lines: [
      {
        id: "fixture-line",
        name: "Fixture Line",
        operator: "Fixture Rail",
        rank: 1,
        color: "#123456",
        stations: [
          ["a", "A", 0, 0],
          ["b", "B", 0.001, 0],
          ["c", "C", 0.002, 0],
        ],
        segments: [
          [0.1, 0, [[0, 0], [0.00001, 0], [0, 0], [0.001, 0]]],
          [0.1, 0, [[0.001, 0], [0.0015, 0.0002], [0.002, 0]]],
        ],
      },
    ],
  });
  const route = RailNetwork.canonicalizeRouteFeature(network, {
    type: "Feature",
    properties: {
      required_line_names: ["Fixture Line"],
      required_operator_names: ["Fixture Rail"],
    },
    geometry: {
      type: "LineString",
      coordinates: [
        [0.001, 0],
        [0.0014, 0.0003],
        [0.002, 0],
      ],
    },
  });
  const displayLine = network.lineById.get("fixture-line").geometry.coordinates;

  assert.ok(route);
  assert.equal(
    route.properties.display_geometry_source,
    "all-railways-complete-line",
  );
  assert.deepEqual(route.properties.display_line_ids, ["fixture-line"]);
  // From B to the end, and B is wherever the drawn line passes it — not a
  // fixed vertex index. The station approach may add samples ahead of a
  // platform, and pinning the slice to index 1 would be asserting the vertex
  // COUNT of an approach rather than the property this test is about.
  const stationIndex = displayLine.findIndex(
    (coordinate) => coordinate[0] === 0.001 && coordinate[1] === 0,
  );
  assert.ok(stationIndex > 0, "B must be a vertex of the drawn line");
  assert.deepEqual(route.geometry.coordinates, displayLine.slice(stationIndex));
});
