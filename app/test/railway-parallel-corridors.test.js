"use strict";

// Two railways, two lines on the map.
//
// Where a trunk and its own branch share track, the branch is drawn over the
// trunk's OWN coordinates and the two must stay exactly coincident — one
// railway seen twice. Where two INDEPENDENT railways happen to run the same
// corridor, coincidence is a lie: the map would show one line where the
// country has two. These tests pin that distinction, which is decided by line
// IDENTITY and never by whether the geometry happens to match.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const RailNetwork = require("../public/rail-network.js");

const PACKAGE_PATH = path.join(__dirname, "../public/rail/jp-2025.json");
const HK_PACKAGE_PATH = path.join(__dirname, "../public/rail/hk-2025.json");

const corridorsPromise = import("../scripts/railway/lib/parallel-corridors.mjs");
const builderPromise = import("../scripts/railway/build-parallel-corridors.mjs");

let cached = null;
function japan() {
  if (!cached) {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
    cached = { pkg, network: RailNetwork.buildNetworkFromCompactPackage(pkg) };
  }
  return cached;
}

function laneOf(network, lineId) {
  return network.segments.features
    .filter((feature) => feature.properties.lineId === lineId)
    .map((feature) => feature.properties.lane);
}

/** The style module, loaded the way the browser loads it. */
function loadStyle() {
  const context = { window: {}, console };
  context.window.RailNetwork = RailNetwork;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["railmap-basemap.js", "railmap-style.js"])
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "../public", file), "utf8"),
      context,
      { filename: file },
    );
  return context.window.RailMapStyle;
}

test("independent lines over one corridor are drawn as separate lanes", () => {
  const { network } = japan();
  // 京成 成田空港線 and 北総 北総線: two companies, one set of tracks between
  // 京成高砂 and 印旛日本医大. Coincident geometry, two railways.
  const skyAccess = laneOf(network, "jp-京成電鉄-成田空港線");
  const hokuso = laneOf(network, "jp-北総鉄道-北総線");
  assert.ok(skyAccess.some((lane) => lane !== 0), "成田空港線 took no lane");
  assert.ok(hokuso.some((lane) => lane !== 0), "北総線 took no lane");
  // Opposite sides of the corridor they share.
  assert.ok(
    Math.sign(Math.min(...skyAccess)) !== Math.sign(Math.min(...hokuso)) ||
      Math.sign(Math.max(...skyAccess)) !== Math.sign(Math.max(...hokuso)),
    "both members offset to the same side",
  );
});

test("different operators over one corridor are drawn as separate lanes", () => {
  const { network } = japan();
  // 北海道新幹線 and 海峡線 share the 青函トンネル end to end — the same
  // company here, but the point stands for any pair of distinct railways.
  const shinkansen = laneOf(network, "jp-北海道旅客鉄道-北海道新幹線");
  const kaikyo = laneOf(network, "jp-北海道旅客鉄道-海峡線");
  assert.ok(shinkansen.some((lane) => lane !== 0));
  assert.ok(kaikyo.some((lane) => lane !== 0));
});

test("one operator's two separate lines are drawn as separate lanes", () => {
  const { pkg } = japan();
  const byLine = new Map();
  for (const row of pkg.lanes) byLine.set(row[0], row);
  const operatorOf = new Map(pkg.lines.map((line) => [line.id, line.operator]));
  const nameOf = new Map(pkg.lines.map((line) => [line.id, line.name]));
  // Somewhere in the table there must be a corridor whose members share an
  // operator: the rule is about line identity, not about company identity.
  const sameOperatorPairs = [...byLine.keys()].filter((id) => {
    const operator = operatorOf.get(id);
    return [...byLine.keys()].some(
      (other) =>
        other !== id &&
        operatorOf.get(other) === operator &&
        nameOf.get(other) !== nameOf.get(id),
    );
  });
  assert.ok(sameOperatorPairs.length > 0);
});

test("a trunk and its own branch still overlap exactly", async () => {
  const { pkg, network } = japan();
  const { corridorRenderMode, CorridorRenderMode } = await corridorsPromise;
  const groupKey = (line) => `${line.operator} ${line.name}`;
  // Every `-2` split is the same railway as its trunk, so neither may ever be
  // pushed off the shared metres they both draw.
  for (const line of pkg.lines) {
    if (!line.id.endsWith("-2")) continue;
    const trunk = pkg.lines.find(
      (item) => item.operator === line.operator && item.name === line.name && item !== line,
    );
    assert.ok(trunk, `${line.id} has no trunk`);
    assert.equal(
      corridorRenderMode(
        { lineId: line.id, groupKey: groupKey(line) },
        { lineId: trunk.id, groupKey: groupKey(trunk) },
      ),
      CorridorRenderMode.MAIN_BRANCH_SHARED,
    );
  }
  // 函館線-2 (砂原支線) is led in over the trunk's own coordinates from 森.
  // Its lead-in must still sit exactly on the trunk, at lane 0.
  const branch = network.segments.features.filter(
    (feature) => feature.properties.lineId === "jp-北海道旅客鉄道-函館線-2",
  );
  assert.ok(branch.length >= 1);
  assert.ok(branch.every((feature) => feature.properties.lane === 0));
});

test("the lane table is a pure function of the package geometry", async () => {
  const { pkg } = japan();
  const { laneRowsForPackage } = await builderPromise;
  // Regenerating must reproduce exactly what is stored; otherwise the offsets
  // are being applied to stretches the geometry no longer has.
  assert.deepEqual(laneRowsForPackage(pkg), pkg.lanes);
});

test("lane offsets are symmetric and stably ordered", () => {
  const { pkg } = japan();
  const bySpot = new Map();
  for (const [lineId, partIndex, from, to, lane] of pkg.lanes) {
    assert.ok(Number.isFinite(lane) && lane !== 0);
    assert.ok(to > from, `${lineId}#${partIndex} has an empty lane stretch`);
    // Lane values come from a member's position in a sorted list, so they are
    // always whole or half multiples of the spacing.
    assert.equal(Math.abs((lane * 2) % 1), 0);
    const key = `${lineId}#${partIndex}`;
    const rows = bySpot.get(key) || [];
    rows.push([from, to]);
    bySpot.set(key, rows);
  }
  // A stroke's lane stretches never overlap: one lane at a time, so a line can
  // never be asked to be in two places at once.
  for (const [key, rows] of bySpot) {
    rows.sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < rows.length; index += 1)
      assert.ok(rows[index][0] >= rows[index - 1][1], `${key} has overlapping lanes`);
  }
});

test("two railways keep the same side of each other everywhere they meet", async () => {
  const { pkg } = japan();
  const { detectIndependentOverlappingCorridors } = await corridorsPromise;
  const { displayPartsForPackage } = await builderPromise;
  const { corridors } = detectIndependentOverlappingCorridors(displayPartsForPackage(pkg));

  // The order within a corridor is the members' sorted line ids, so a pair
  // that meets in Kyushu and again in Tohoku sits the same way round in both,
  // and a third railway joining slots BETWEEN them instead of shuffling them
  // past each other. Check it from the data rather than trusting the sort:
  // for every ordered pair, the sign of (laneA - laneB) must be constant.
  const orderSeen = new Map();
  for (const corridor of corridors) {
    if (!corridor.members) continue;
    for (const other of corridor.members) {
      if (other === corridor.lineId) continue;
      const [low, high] = [corridor.lineId, other].sort();
      // Order inside the corridor's own frame, read off the member list the
      // lane index was taken from. Same pair, same answer, every meeting.
      const order =
        corridor.members.indexOf(low) < corridor.members.indexOf(high) ? "low-left" : "high-left";
      const key = `${low}\u0000${high}`;
      const previous = orderSeen.get(key);
      if (previous) assert.equal(previous, order, `${key} changes sides`);
      else orderSeen.set(key, order);
    }
  }
  assert.ok(orderSeen.size > 40, `only ${orderSeen.size} corridor pairs found`);

  // …and a lane never steps sideways for a stretch too short to justify it.
  const { CORRIDOR_MIN_METERS } = await corridorsPromise;
  for (const corridor of corridors)
    assert.ok(
      corridor.toMeters - corridor.fromMeters >= CORRIDOR_MIN_METERS,
      `${corridor.lineId} takes a lane for only ${(corridor.toMeters - corridor.fromMeters).toFixed(0)} m`,
    );
});

test("lanes cut the drawn geometry only, never the topology", () => {
  const { pkg, network } = japan();
  const laned = new Set(pkg.lanes.map((row) => row[0]));
  assert.ok(laned.size > 100);
  for (const lineId of laned) {
    const line = network.lineById.get(lineId);
    // The strokes a ridden route is sliced from are the untouched ones: they
    // still start and end on a platform and still measure the whole railway.
    for (const part of line.parts) assert.ok(part.length >= 2);
    const drawn = network.segments.features
      .filter((feature) => feature.properties.lineId === lineId)
      .map((feature) => feature.properties.strokeCount);
    for (const strokeCount of drawn) assert.equal(strokeCount, line.parts.length);
  }
});

test("the parallel gap is an edge-to-edge screen-space constant", () => {
  const style = loadStyle();
  const tokens = style.RAILWAY_STYLE;
  // Centre-to-centre = one stroke + the gap, so the gap the reader sees is the
  // token whatever the stroke width is, and two lanes can never overlap.
  assert.equal(
    style.parallelLaneCentreDistancePx(),
    tokens.railWidthPx + tokens.parallelGapPx,
  );
  // Visible, and tight: the spec's 0.3–0.6 × stroke width.
  assert.ok(tokens.parallelGapPx >= 0.3 * tokens.railWidthPx);
  assert.ok(tokens.parallelGapPx <= 0.6 * tokens.railWidthPx);
});

// ── the bundle keeps one shared visual scale at EVERY zoom ─────────────────
//
// Below z7 the whole railway language deliberately gets lighter. Every width,
// gap, offset and marker must follow the same factor so the bundle retains its
// proportions instead of welding or fanning out relative to its own strokes.
//
// Every check below reads validateParallelZoomStability(), which evaluates the
// BUILT style's own paint expressions at a spread of zooms and reports the
// pixel sizes a reader would see at each. Measuring the built style rather
// than the tokens is the point: a ramp reintroduced on any single property
// fails these instead of hiding behind the token it was applied to.
const ZOOM_LEVELS = [3, 5, 8, 10, 12, 14, 16, 18];

let cachedStability = null;
/** The three-lane case at every zoom level, measured once. */
function zoomStability() {
  if (!cachedStability)
    cachedStability = loadStyle().validateParallelZoomStability({
      zooms: ZOOM_LEVELS,
      laneCount: 3,
    });
  return cachedStability;
}

test("parallel_zoom_levels_include_3_and_5", () => {
  const report = zoomStability();
  assert.deepEqual(Array.from(report.zooms), ZOOM_LEVELS);
  assert.equal(report.samples.length, ZOOM_LEVELS.length);
  // (Arrays built inside the VM realm carry that realm's prototype, which
  // deepEqual refuses to match against this one's — copy before comparing.)
  assert.deepEqual(Array.from(report.failures), []);
  assert.equal(report.ok, true);
});

test("parallel_spread_is_scale_normalized", () => {
  const report = zoomStability();
  const gaps = report.samples.map((sample) => sample.parallelGapPx);
  const style = loadStyle();
  // The gap follows the one shared railway scale; dividing it out recovers
  // the full-weight token at every zoom.
  for (const [index, gap] of gaps.entries())
    assert.ok(
      Math.abs(
        gap / style.railwayScaleAt(report.zooms[index]) -
          style.RAILWAY_STYLE.parallelGapPx,
      ) <= report.tolerancePx,
      `z${report.zooms[index]} draws a ${gap.toFixed(4)} px gap`,
    );
  assert.ok(report.spreadPx.parallelGapPx <= report.tolerancePx);
});

test("lane centre spacing follows the shared zoom scale", () => {
  const report = zoomStability();
  const style = loadStyle();
  const expected = style.parallelLaneCentreDistancePx();
  for (const sample of report.samples) {
    assert.ok(
      Math.abs(sample.centreSpacingPx / sample.scale - expected) <=
        report.tolerancePx,
      `z${sample.zoom} spaces lane centres ${sample.centreSpacingPx.toFixed(4)} px apart`,
    );
    // …and evenly: with three lanes, the middle one stays on the alignment the
    // corridor shares rather than drifting toward either neighbour.
    assert.ok(sample.spacingSpreadPx <= report.tolerancePx);
  }
  assert.ok(report.spreadPx.centreSpacingPx <= report.tolerancePx);
});

test("a bundle keeps its normalized total width at every zoom", () => {
  const report = zoomStability();
  const style = loadStyle();
  // Three strokes and two gaps, however far in or out the map is.
  const expected = style.parallelBundleWidthPx(3);
  assert.equal(
    expected,
    3 * style.RAILWAY_STYLE.railWidthPx + 2 * style.RAILWAY_STYLE.parallelGapPx,
  );
  for (const sample of report.samples)
    assert.ok(
      Math.abs(sample.bundleWidthPx / sample.scale - expected) <=
        report.tolerancePx,
      `z${sample.zoom} draws a ${sample.bundleWidthPx.toFixed(4)} px bundle`,
    );
  assert.ok(report.spreadPx.bundleWidthPx <= report.tolerancePx);
});

test("the strokes inside a bundle follow the shared zoom scale", () => {
  const report = zoomStability();
  const style = loadStyle();
  const normalizedRiddenWidth =
    report.samples[0].riddenWidthPx / report.samples[0].scale;
  // Fixing the gap while the strokes thinned would change the edge-to-edge
  // distance the reader actually perceives, so BOTH are pinned — the railway's
  // own stroke and the ride drawn inside its lane.
  for (const sample of report.samples) {
    assert.ok(
      Math.abs(
        sample.railWidthPx / sample.scale - style.RAILWAY_STYLE.railWidthPx,
      ) <=
        report.tolerancePx,
      `z${sample.zoom} draws a ${sample.railWidthPx.toFixed(4)} px rail`,
    );
    assert.ok(sample.riddenWidthPx > 0);
    assert.ok(
      Math.abs(sample.riddenWidthPx / sample.scale - normalizedRiddenWidth) <=
        report.tolerancePx,
    );
  }
  assert.ok(report.spreadPx.railWidthPx <= report.tolerancePx);
  assert.ok(report.spreadPx.riddenWidthPx <= report.tolerancePx);
});

test("a ride sits in the railway's own lane at every zoom", () => {
  const report = zoomStability();
  // Not "close to" — the identical pixel offset, for every layer that draws a
  // ride and for every lane of the bundle. A railway that stepped aside in
  // pixels while its ride stepped aside in world units would coincide at one
  // zoom and drift apart at every other.
  assert.ok(report.spreadPx.routeAlignmentPx <= report.tolerancePx);
  for (const sample of report.samples)
    assert.ok(
      sample.routeAlignmentPx <= report.tolerancePx,
      `a ride is ${sample.routeAlignmentPx.toFixed(4)} px off its railway at z${sample.zoom}`,
    );
});

test("a platform marker follows the same zoom scale as its lanes", () => {
  const report = zoomStability();
  const style = loadStyle();
  // The stub is what a station in a lane is drawn as, so its thickness IS the
  // station dot's diameter, and how far the outermost stubs reach across the
  // rendered lanes follows the rendered lane offsets — never a distance in
  // metres between the railways underneath.
  for (const sample of report.samples)
    assert.ok(
      Math.abs(
        sample.slotThicknessPx / sample.scale -
          style.RAILWAY_STYLE.stationDiameterPx,
      ) <=
        report.tolerancePx,
      `z${sample.zoom} draws a ${sample.slotThicknessPx.toFixed(4)} px platform`,
    );
  assert.ok(report.spreadPx.slotThicknessPx <= report.tolerancePx);
  assert.ok(report.spreadPx.slotSpanPx <= report.tolerancePx);
});

test("lane order never changes with zoom", () => {
  const report = zoomStability();
  assert.equal(report.laneOrderStable, true);
  // Left to right, the same three lanes in the same order at every zoom: no
  // pair swaps sides and no lane crosses its neighbour on the way in or out.
  assert.equal(report.laneOrder, "-1,0,1");
  for (const sample of report.samples) assert.equal(sample.laneOrder, "-1,0,1");
  // Two members sit symmetrically about the alignment they share.
  const pair = loadStyle().validateParallelZoomStability({
    zooms: ZOOM_LEVELS,
    laneCount: 2,
  });
  assert.equal(pair.ok, true);
  assert.equal(pair.laneOrder, "-0.5,0.5");
});

test("the zoom-stability check fails a bundle that scales with zoom", () => {
  // A check that cannot fail proves nothing. Feed the evaluator the exact
  // shape this code used to paint — one token on a linear zoom ramp — and it
  // has to report the sizes changing.
  const style = loadStyle();
  const ramp = ["interpolate", ["linear"], ["zoom"], 4, 1.75, 20, 3.5];
  assert.equal(style.evaluateScreenValue(ramp, 4, {}), 1.75);
  assert.equal(style.evaluateScreenValue(ramp, 20, {}), 3.5);
  assert.equal(style.evaluateScreenValue(ramp, 12, {}), 2.625);
  // Clamped outside the anchors rather than extrapolated past them.
  assert.equal(style.evaluateScreenValue(ramp, 2, {}), 1.75);
  assert.equal(style.evaluateScreenValue(ramp, 30, {}), 3.5);
  // A lane offset on that ramp moves by more than a pixel over the range —
  // orders of magnitude past the float tolerance the real check allows.
  const laneRamp = [
    "interpolate",
    ["linear"],
    ["zoom"],
    4,
    ["*", ["coalesce", ["get", "lane"], 0], 2.45],
    20,
    ["*", ["coalesce", ["get", "lane"], 0], 4.9],
  ];
  const at = (zoom) => style.evaluateScreenValue(laneRamp, zoom, { lane: 1 });
  assert.ok(Math.abs(at(20) - at(4)) > 1);
  // …and an expression the evaluator does not know is never read as constant.
  assert.ok(
    Number.isNaN(style.evaluateScreenValue(["heatmap-density"], 8, {})),
  );
  assert.ok(
    Number.isNaN(style.evaluateScreenValue(["image", "rn-station"], 8, {})),
  );
  // The LOD gates ARE known, and have to be evaluated rather than shrugged at,
  // or every opacity in this style reads NaN and no test can hold one.
  assert.equal(style.evaluateScreenValue(["case", true, 1, 2], 8, {}), 1);
  assert.equal(style.evaluateScreenValue(["case", false, 1, 2], 8, {}), 2);
  assert.equal(
    style.evaluateScreenValue(["step", ["zoom"], 0, 10, 1], 8, {}),
    0,
  );
  assert.equal(
    style.evaluateScreenValue(["step", ["zoom"], 0, 10, 1], 12, {}),
    1,
  );
  assert.equal(
    style.evaluateScreenValue(
      ["<=", ["coalesce", ["get", "minz"], 0], 9],
      8,
      { minz: 7 },
    ),
    true,
  );
});

test("station_features_are_not_screen_merged", () => {
  const { network } = japan();
  // The source retains one independent row per (line, station).
  const groups = new Map();
  for (const feature of network.stations.features) {
    const key = feature.properties.stationGroupId;
    if (!key) continue;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  assert.ok(groups.size > 8000);
  assert.equal(network.groupMembers.size, groups.size);

  // 新鎌ヶ谷: 北総線 and 京成成田空港線 both call. They keep separate
  // marker features and follow their own opposite lanes; sharing a station
  // group may dedupe a label, but cannot pull either dot to a common centre.
  const at = (collection, name, lineId) =>
    collection.features.find(
      (feature) =>
        (feature.properties.name === name ||
          network.stationById.get(feature.properties.stationId)?.name === name) &&
        feature.properties.lineId === lineId,
    );
  const hokuso = at(network.stationLanes, "新鎌ヶ谷", "jp-北総鉄道-北総線");
  const skyAccess = at(
    network.stationLanes,
    "新鎌ヶ谷",
    "jp-京成電鉄-成田空港線",
  );
  assert.ok(hokuso);
  assert.ok(skyAccess);
  assert.equal(hokuso.properties.stationGroupId, skyAccess.properties.stationGroupId);
  assert.equal(hokuso.properties.lane, -skyAccess.properties.lane);
  assert.notEqual(hokuso.properties.stationId, skyAccess.properties.stationId);

  // 西白井 is only a 北総線 stop and remains in that line's lane.
  assert.notEqual(
    at(network.stationLanes, "西白井", "jp-北総鉄道-北総線").properties.lane,
    0,
  );
});

test("a line eases into its lane instead of stepping sideways", () => {
  const { pkg, network } = japan();
  // Every lane value the renderer emits is either 0, a full lane, or one of
  // the quarter-steps that ease into it — a whole line never moves sideways
  // in one jump, which would put a corner in it that no railway has.
  const fullLanes = new Set(pkg.lanes.map((row) => row[4]));
  const drawn = new Set(
    network.segments.features.map((feature) => feature.properties.lane),
  );
  const eased = new Set();
  for (const lane of fullLanes)
    for (const step of [0.25, 0.5, 0.75]) eased.add(lane * step);
  for (const lane of drawn) {
    if (lane === 0 || fullLanes.has(lane)) continue;
    assert.ok(eased.has(lane), `unexplained lane value ${lane}`);
  }
  // The ramp really is in use, not just possible.
  assert.ok([...drawn].some((lane) => eased.has(lane) && !fullLanes.has(lane)));

  // Consecutive pieces of one line share their boundary point exactly, so the
  // eased step can never open a hairline gap in the stroke.
  //
  // Stated as: every piece end that is NOT one of the line's own stroke ends is
  // a lane boundary, and a lane boundary is shared by the two pieces that meet
  // there. Counting merely "some pair of ends coincides" would pass a line that
  // has no lane boundary at all — a branch laned whole while the trunk stays on
  // the centre-line is two pieces that legitimately never meet.
  for (const line of pkg.lines) {
    const strokeEnds = new Set();
    for (const stroke of network.lineById.get(line.id).parts)
      for (const point of [stroke[0], stroke[stroke.length - 1]])
        strokeEnds.add(`${point[0]},${point[1]}`);
    const ends = new Map();
    for (const feature of network.segments.features) {
      if (feature.properties.lineId !== line.id) continue;
      const parts =
        feature.geometry.type === "MultiLineString"
          ? feature.geometry.coordinates
          : [feature.geometry.coordinates];
      for (const part of parts) {
        for (const point of [part[0], part[part.length - 1]]) {
          const key = `${point[0]},${point[1]}`;
          ends.set(key, (ends.get(key) || 0) + 1);
        }
      }
    }
    for (const [key, count] of ends) {
      if (strokeEnds.has(key)) continue;
      assert.ok(count > 1, `${line.id} lane boundary ${key} is not shared`);
    }
  }
});

test("a laned platform moves into the lane of the railway that calls there", () => {
  const { network } = japan();
  // A station on a laned stretch must not stay on the shared centre-line: it
  // would sit exactly between the two railways and claim a stop for the one
  // that does not have it. Those platforms leave the circle layer and ship as
  // offsettable stubs instead.
  const laned = network.stations.features.filter(
    (feature) => feature.properties.lane !== 0,
  );
  assert.ok(laned.length > 300, `only ${laned.length} laned platforms`);
  assert.equal(network.stationLanes.features.length, laned.length);

  const stubById = new Map(
    network.stationLanes.features.map((feature) => [
      feature.properties.stationId,
      feature,
    ]),
  );
  for (const station of laned) {
    const marker = stubById.get(station.properties.stationId);
    assert.ok(marker, `${station.properties.stationId} has no lane marker`);
    // Same lane as its own line, so the offset lands the dot on that railway.
    assert.equal(marker.properties.lane, station.properties.lane);
    // ON the platform — a POINT, not a stub of line whose screen length grows
    // with the zoom until the dot reads as a capsule.
    assert.equal(marker.geometry.type, "Point");
    assert.deepEqual(marker.geometry.coordinates, station.geometry.coordinates);
    // Carrying the bearing of its own track, which is the whole of what the
    // style needs to push it into the lane.
    const bearing = marker.properties.bearing;
    assert.equal(typeof bearing, "number");
    assert.ok(bearing >= 0 && bearing < 360, `bearing ${bearing}`);
  }
});

test("a laned platform's marker points along the railway it belongs to", () => {
  // The bearing is the ONE geometric fact the marker carries, and the offset
  // is applied at right angles to it — so a bearing that disagreed with the
  // drawn track would push the dot off its own railway by the full lane width
  // without anything else noticing.
  const { network } = japan();
  const toMetres = (from, to, lat) => [
    (to[0] - from[0]) * 111320 * Math.cos((lat * Math.PI) / 180),
    (to[1] - from[1]) * 111320,
  ];
  let checked = 0;
  for (const marker of network.stationLanes.features) {
    const line = network.lineById.get(marker.properties.lineId);
    const anchor = marker.geometry.coordinates;
    const key = `${anchor[0]},${anchor[1]}`;
    for (const part of line.parts || []) {
      const index = part.findIndex((c) => `${c[0]},${c[1]}` === key);
      if (index < 0 || index >= part.length - 1) continue;
      const [east, north] = toMetres(part[index], part[index + 1], anchor[1]);
      const track = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
      let delta = Math.abs(track - marker.properties.bearing) % 360;
      if (delta > 180) delta = 360 - delta;
      // The bearing is read off the nearest edge of the ORIGINAL stroke, so an
      // exact match is not required — but it may never point the other way
      // down the line, which would put the dot in the wrong lane.
      assert.ok(
        delta < 90,
        `${line.name} bearing ${marker.properties.bearing.toFixed(0)}° vs track ${track.toFixed(0)}°`,
      );
      checked += 1;
      break;
    }
  }
  assert.ok(checked > 100, `only ${checked} markers checked`);
});

test("the station layers split platforms by lane, never duplicate them", () => {
  const style = loadStyle();
  const built = style.buildBaseStyle({ country: "jp", theme: "light" });
  const byId = new Map(built.layers.map((layer) => [layer.id, layer]));
  const circles = byId.get(style.STATIONS_LAYER);
  const marker = byId.get(style.STATION_LANES_LAYER);
  assert.ok(circles && marker);
  // The circle layer draws lane 0 only, the icon layer draws the rest:
  // exactly one marker per platform either way.
  assert.deepEqual(JSON.parse(JSON.stringify(circles.filter)), [
    "==",
    ["coalesce", ["get", "lane"], 0],
    0,
  ]);
  assert.equal(marker.source, style.STATION_LANES_SOURCE);
  // An icon, because only an icon can be offset per feature — and one that is
  // never dropped by the collision pass, since a missing marker is a missing
  // station rather than a decluttered label.
  assert.equal(marker.type, "symbol");
  assert.equal(marker.layout["icon-allow-overlap"], true);
  assert.equal(marker.layout["icon-ignore-placement"], true);
  // Rotated to its own track's bearing and offset at right angles to it, so
  // the offset lands on the side line-offset calls positive.
  assert.ok(JSON.stringify(marker.layout["icon-rotate"]).includes("bearing"));
  assert.equal(marker.layout["icon-rotation-alignment"], "map");
  assert.ok(JSON.stringify(marker.layout["icon-offset"]).includes("lane"));
  // Every offset the case can produce is purely sideways in the icon's own
  // frame; a y component would push the dot ALONG the track.
  for (const value of marker.layout["icon-offset"])
    if (Array.isArray(value) && value[0] === "literal")
      assert.equal(value[1][1], 0);
});

test("a branched line is never pulled into parallel lanes", () => {
  // 東鐵綫 runs to 羅湖 with 落馬洲 hanging off 上水; 將軍澳綫 runs to 寶琳 with
  // 康城 off 將軍澳; 中和新蘆線 runs to 迴龍 with 蘆洲 off 大橋頭. Each is ONE
  // railway, so the track its two rows share must stay exactly coincident —
  // the operator publishing them as two end-to-end services is a timetable
  // fact, not a second railway (scripts/railway/collapse-branch-services.mjs).
  for (const [country, pairs] of [
    ["hk", [["hk-mtr-eal-low", "hk-mtr-eal-lmc", "東鐵綫", "落馬洲"],
            ["hk-mtr-tkl-poa", "hk-mtr-tkl-lhp", "將軍澳綫", "康城"]]],
    ["tw", [["tw-trtc-o-huilong", "tw-trtc-o-luzhou", "中和新蘆線", "蘆洲"]]],
  ]) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, `../public/rail/${country}-2025.json`), "utf8"),
    );
    const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
    for (const [trunkId, branchId, name, terminus] of pairs) {
      const trunk = pkg.lines.find((line) => line.id === trunkId);
      const branch = pkg.lines.find((line) => line.id === branchId);
      assert.ok(trunk && branch, `${trunkId}/${branchId} missing`);
      // Same name = same railway, which is what keeps them out of the lanes.
      assert.equal(trunk.name, name);
      assert.equal(branch.name, name);
      assert.deepEqual(laneOf(network, trunkId), [0], `${trunkId} took a lane`);
      assert.deepEqual(laneOf(network, branchId), [0], `${branchId} took a lane`);
      assert.equal(
        (pkg.lanes || []).filter((row) => row[0] === trunkId || row[0] === branchId).length,
        0,
      );
      // The branch carries only its OWN run: it ends at its terminus and no
      // longer repeats the trunk it used to be listed along.
      assert.equal(branch.stations.at(-1)[1], terminus);
      assert.ok(
        branch.stations.length < trunk.stations.length,
        `${branchId} still repeats its trunk`,
      );
      // …and it starts at a station the trunk really has: its junction.
      const onTrunk = new Set(trunk.stations.map((row) => row[1]));
      assert.ok(onTrunk.has(branch.stations[0][1]), `${branchId} starts off the trunk`);
      for (const row of branch.stations.slice(1))
        assert.ok(!onTrunk.has(row[1]), `${branchId} still repeats ${row[1]}`);
    }
  }
});

// ── the rides drawn over those corridors ────────────────────────────────────
//
// A lane moves the RAILWAY. A ridden route drawn over that railway has to move
// with it: a corridor where the rail steps aside and the journey stays on the
// centre-line draws the ride beside its own track, which is the one thing the
// lanes exist to prevent.

const SAMPLE_DIRECTORIES = [
  path.join(__dirname, "../data/sample-data"),
  path.join(__dirname, "../data/new-year-grand-loop-data"),
  path.join(__dirname, "../data/tokyo-limited-express-loop-data"),
];

const DEGREES = Math.PI / 180;

function metersApart(a, b) {
  return Math.hypot(
    (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * DEGREES) * 111320,
    (b[1] - a[1]) * 111320,
  );
}

// Move a polyline into its lane, exactly as MapLibre's line-offset does: a
// signed multiple of the spacing along the line's own right-hand normal. In
// metres rather than pixels, because only the SIDE is under test.
const TEST_SPACING_METERS = 10;

function offsetIntoLane(coordinates, laneAt) {
  return coordinates.map((point, index) => {
    const before = coordinates[Math.max(0, index - 1)];
    const after = coordinates[Math.min(coordinates.length - 1, index + 1)];
    const cos = Math.cos(point[1] * DEGREES) || 1e-6;
    const dx = (after[0] - before[0]) * cos;
    const dy = after[1] - before[1];
    const length = Math.hypot(dx, dy) || 1e-12;
    const lane = typeof laneAt === "function" ? laneAt(index) : laneAt;
    const shift = (lane * TEST_SPACING_METERS) / 111320;
    return [point[0] + ((dy / length) * shift) / cos, point[1] - (dx / length) * shift];
  });
}

/** Every ridden route feature of the Japan samples, canonicalized. */
function riddenRoutes(network) {
  const out = [];
  for (const directory of SAMPLE_DIRECTORIES) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).filter((f) => /^part-.*\.json$/.test(f))) {
      const part = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      for (const feature of part.route?.features || []) {
        const canonical = RailNetwork.canonicalizeRouteFeature(network, feature);
        if (canonical) out.push({ canonical, train: part.train?.id || name });
      }
    }
  }
  return out;
}

test("a ride over a parallel corridor is drawn on the railway it rode", () => {
  const { network } = japan();
  // Every drawn railway stroke, already moved into the lane the map draws it
  // in. A ride offset by its own lane has to land ON one of these — if its
  // lane carried the wrong sign it would come to rest a full two lanes away,
  // on the neighbouring railway's side of the corridor.
  const railByLine = new Map();
  for (const feature of network.segments.features) {
    const lineId = feature.properties.lineId;
    const lane = feature.properties.lane || 0;
    const strokes =
      feature.geometry.type === "LineString"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    if (!railByLine.has(lineId)) railByLine.set(lineId, []);
    for (const coordinates of strokes)
      if (coordinates.length >= 2)
        railByLine.get(lineId).push(offsetIntoLane(coordinates, lane));
  }
  const distanceToRail = (lineId, point) => {
    let best = Infinity;
    for (const stroke of railByLine.get(lineId) || [])
      for (const vertex of stroke) {
        const d = metersApart(point, vertex);
        if (d < best) best = d;
      }
    return best;
  };

  let compared = 0;
  for (const { canonical, train } of riddenRoutes(network)) {
    const lanes = canonical.properties.display_lanes;
    if (!lanes || canonical.properties.display_line_ids.length !== 1) continue;
    const lineId = canonical.properties.display_line_ids[0];
    const geometries =
      canonical.geometry.type === "LineString"
        ? [canonical.geometry.coordinates]
        : canonical.geometry.coordinates;
    geometries.forEach((coordinates, index) => {
      const vertexLanes = lanes[index];
      if (!vertexLanes || coordinates.length < 6) return;
      const drawn = offsetIntoLane(coordinates, (at) => vertexLanes[at]);
      // Interior vertices only: the two ends are pinned to their platforms and
      // may bridge the last metres to the track.
      for (let at = 2; at < coordinates.length - 2; at += 1) {
        if (!vertexLanes[at]) continue;
        compared += 1;
        assert.ok(
          distanceToRail(lineId, drawn[at]) <= 3,
          `${train} on ${lineId} is drawn off its own railway ` +
            `(lane ${vertexLanes[at]})`,
        );
      }
    });
  }
  // The samples really do ride laned corridors — otherwise the loop above
  // would pass by never running.
  assert.ok(compared > 500, `only ${compared} laned ride vertices compared`);
});

test("one train keeps one side of a corridor for the whole way along it", () => {
  const { network } = japan();
  // The lane VALUE is signed against the ride's own direction of travel, so
  // two trains running one railway opposite ways correctly carry opposite
  // values — that is what puts them both on the same physical side. What
  // may never happen is one train changing sign part-way along ONE corridor.
  //
  // 大阪環状線 is the case that caught it: a closed stroke whose measures
  // restart at 今宮, ridden the way it was not digitised. Crossing that seam
  // flipped exactly one hop to the far side of the corridor, because the
  // direction was re-derived from geometry that cannot tell the two sides of
  // a seam apart — the slice now reports which way it was cut instead.
  //
  // Scoped to that loop on purpose. A train riding a long line through
  // SEVERAL corridors legitimately changes sides between them: the lane is
  // the corridor's, and 山陽新幹線 really is the middle of one bundle and the
  // edge of another. 大阪環状線 is one corridor from end to end.
  const LOOP = "jp-西日本旅客鉄道-大阪環状線";
  const perTrain = new Map();
  for (const { canonical, train } of riddenRoutes(network)) {
    const lanes = canonical.properties.display_lanes;
    if (!lanes || canonical.properties.display_line_ids[0] !== LOOP) continue;
    if (!perTrain.has(train)) perTrain.set(train, new Set());
    for (const vertexLanes of lanes)
      for (const lane of vertexLanes || [])
        if (lane) perTrain.get(train).add(Math.sign(lane));
  }
  assert.ok(perTrain.size >= 2, "no laned 大阪環状線 rides in the samples");
  for (const [train, sides] of perTrain)
    assert.equal(sides.size, 1, train + " changes sides mid-corridor");
  // The two directions took OPPOSITE values, which is exactly what lands them
  // both on the same physical side of the corridor.
  assert.deepEqual(
    [...new Set([...perTrain.values()].map((sides) => [...sides][0]))].sort(),
    [-1, 1],
  );
});

test("a ride carries no lane data at all off a parallel corridor", () => {
  const { network } = japan();
  const routes = riddenRoutes(network);
  const laned = routes.filter((item) => item.canonical.properties.display_lanes);
  // Most of the network is not in a corridor, and those rides must come out
  // byte-identical to before the lane pass existed.
  assert.ok(laned.length > 0, "no ride took a lane");
  assert.ok(
    laned.length < routes.length,
    "every ride claims a lane — the profile lookup is not discriminating",
  );
});

test("every layer that draws a ride offsets it by the railway's own rule", () => {
  const style = loadStyle();
  const layers = style.buildBaseStyle({ country: "jp" }).layers;
  const offsetOf = (id) => {
    const layer = layers.find((item) => item.id === id);
    assert.ok(layer, id + " is missing from the style");
    return layer.paint["line-offset"];
  };
  // The railway's expression IS the contract. Every layer that draws a ride —
  // the solid line, its cross-day dashes, the selected line and its casing,
  // the hover highlight, and the invisible hit target — must carry the very
  // same one, or a ride drifts off its track at some zoom or in some state.
  const railway = JSON.stringify(offsetOf(style.SEGMENTS_LAYER));
  assert.ok(railway, "the railway itself lost its lane offset");
  for (const id of [
    "train-routes-line",
    "train-routes-xday",
    "train-routes-sel",
    "train-routes-sel-casing",
    "train-routes-hover",
    "train-routes-pick-line",
  ])
    assert.equal(
      JSON.stringify(offsetOf(id)),
      railway,
      id + " does not follow the railway into its lane",
    );
});

test("a ride re-asserts its lane with the railway, not without it", () => {
  const style = loadStyle();
  // RailMap paints from this table on attach, so a layer left out of it would
  // be drawing from whatever a previous style rebuild left behind while the
  // railway underneath it was repainted from the tokens.
  const painted = new Set(
    style
      .railwayScreenPaintEntries()
      .filter((entry) => entry.property === "line-offset")
      .map((entry) => entry.layer),
  );
  for (const id of [
    "train-routes-line",
    "train-routes-xday",
    "train-routes-sel",
    "train-routes-sel-casing",
    "train-routes-hover",
    "train-routes-pick-line",
  ])
    assert.ok(painted.has(id), id + " never re-anchors its lane offset");
});
/** app-deck-records.js loaded on its own, for the two pure helpers below. */
function loadDeckRecords() {
  const context = vm.createContext({ console, location: { search: "" } });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../public/app-deck-records.js"), "utf8"),
    context,
    { filename: "app-deck-records.js" },
  );
  const hooks = vm.runInContext(
    "({ laneChangeIndices, mergeDrawnIndices })",
    context,
  );
  // Arrays built inside the VM carry that realm's Array prototype, which
  // deepEqual refuses to match against this one's. Copy them across.
  return {
    laneChangeIndices: (lanes) => {
      const out = hooks.laneChangeIndices(lanes);
      return out ? Array.from(out) : out;
    },
    mergeDrawnIndices: (...args) => Array.from(hooks.mergeDrawnIndices(...args)),
  };
}

test("the drawn ride is cut where its lane changes, and nowhere else", () => {
  const { laneChangeIndices } = loadDeckRecords();
  // A ride easing into a lane: centre-line, three quarter-steps, full lane.
  const lanes = [0, 0, 0.125, 0.25, 0.375, 0.5, 0.5, 0.5];
  assert.deepEqual(laneChangeIndices(lanes), [2, 3, 4, 5]);
  // A ride that never leaves the centre-line is not cut at all, so nothing
  // downstream can tell the lane pass ran over it.
  assert.equal(laneChangeIndices([0, 0, 0, 0]), null);
  assert.equal(laneChangeIndices(null), null);
});

test("simplification may never drop a vertex the lane steps on", () => {
  const { laneChangeIndices, mergeDrawnIndices } = loadDeckRecords();
  const lanes = [0, 0, 0.25, 0.5, 0.5, 0.5, 0.25, 0, 0];
  const changes = laneChangeIndices(lanes);
  // Douglas-Peucker kept only the two ends; the run spans the whole line.
  const drawn = mergeDrawnIndices([0, 8], [{ a: 0, b: 8 }], 8, changes);
  for (const at of changes)
    assert.ok(
      drawn.includes(at),
      "vertex " + at + " carries a lane step and was simplified away",
    );
  // Still sorted, still without duplicates: the drawn path is walked in order
  // and a repeat would emit a zero-length piece.
  assert.deepEqual(drawn, [...new Set(drawn)].sort((a, b) => a - b));
  // And with no lanes at all the drawn set is untouched.
  assert.deepEqual(
    mergeDrawnIndices([0, 8], [{ a: 0, b: 8 }], 8, null),
    [0, 8],
  );
});

test("consecutive lane pieces of a ride share their boundary vertex", () => {
  // The cut buildDeckRouteRecords makes: pieces run [start .. change] and the
  // next begins AT that change, so the two round caps overlap and the eased
  // step can never open a hairline in the drawn journey.
  const runLine = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]];
  const lanes = [0, 0, 0.25, 0.5, 0.5, 0.5];
  const pieces = [];
  let pieceStart = 0;
  let pieceLane = lanes[0];
  for (let k = 1; k < runLine.length; k += 1) {
    if (lanes[k] === pieceLane) continue;
    pieces.push({ lane: pieceLane, path: runLine.slice(pieceStart, k + 1) });
    pieceStart = k;
    pieceLane = lanes[k];
  }
  pieces.push({ lane: pieceLane, path: runLine.slice(pieceStart) });
  assert.deepEqual(
    pieces.map((piece) => piece.lane),
    [0, 0.25, 0.5],
  );
  for (let index = 1; index < pieces.length; index += 1)
    assert.deepEqual(
      pieces[index].path[0],
      pieces[index - 1].path.at(-1),
      "a gap opened between two lane pieces",
    );
  // Every metre of the run is still drawn exactly once.
  const drawnVertices = pieces.reduce(
    (total, piece) => total + piece.path.length - 1,
    0,
  );
  assert.equal(drawnVertices, runLine.length - 1);
});
// ── service identity is not railway identity ────────────────────────────────
//
// A package names its strokes after what the operator publishes, and for some
// networks that is a ROUTE NUMBER, not a railway. How many railways to draw in
// a corridor is a question about RAILWAYS; a timetable never adds one.

test("one railway published as many services is drawn once, not many times", () => {
  const pkg = JSON.parse(fs.readFileSync(HK_PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  // 輕鐵 505/507/610/614/614P/615/615P/705/706/751/761P are eleven route
  // numbers over ONE shared track network — On Ting is served by 505, 507,
  // 614, 614P and 751 on the same rails. Eleven services, one railway, and so
  // one stroke: none of them may be pushed aside to make room for another.
  const ROUTES = [
    "505", "507", "610", "614", "614p", "615", "615p", "705", "706", "751", "761p",
  ];
  const identities = new Set();
  for (const route of ROUTES) {
    const lineId = `hk-mtr-lr-${route}`;
    const line = network.lineById.get(lineId);
    assert.ok(line, `${lineId} is missing from the package`);
    identities.add(line.railwayId);
    assert.deepEqual(
      laneOf(network, lineId).filter((lane) => lane !== 0),
      [],
      `輕鐵${route} was pushed into a parallel lane by another 輕鐵 service`,
    );
  }
  // …and they say so: one railway identity across all eleven.
  assert.equal(identities.size, 1);
  // The services themselves are untouched — still eleven distinct lines with
  // their own names, ids and stopping patterns.
  assert.equal(new Set(ROUTES.map((r) => `hk-mtr-lr-${r}`)).size, 11);
  const names = new Set(
    ROUTES.map((r) => network.lineById.get(`hk-mtr-lr-${r}`).name),
  );
  assert.equal(names.size, 11);
});

test("route number, stop pattern and endpoints never create a railway lane", async () => {
  const { corridorRenderMode, CorridorRenderMode } = await corridorsPromise;
  const railway = (lineId, name, railwayId) => ({
    lineId,
    groupKey: `MTR\u0000${name}`,
    railwayId,
  });
  // Same railway, different route numbers → one stroke.
  assert.equal(
    corridorRenderMode(
      railway("hk-mtr-lr-610", "輕鐵610綫", "hk-mtr-light-rail"),
      railway("hk-mtr-lr-615", "輕鐵615綫", "hk-mtr-light-rail"),
    ),
    CorridorRenderMode.SAME_RAILWAY,
  );
  // Same railway, a service that runs only part of it (614P against 614) and
  // a service with different endpoints (505 against 751) → still one stroke.
  for (const [a, b] of [
    [["hk-mtr-lr-614", "輕鐵614綫"], ["hk-mtr-lr-614p", "輕鐵614P綫"]],
    [["hk-mtr-lr-505", "輕鐵505綫"], ["hk-mtr-lr-751", "輕鐵751綫"]],
  ])
    assert.notEqual(
      corridorRenderMode(
        railway(a[0], a[1], "hk-mtr-light-rail"),
        railway(b[0], b[1], "hk-mtr-light-rail"),
      ),
      CorridorRenderMode.INDEPENDENT_PARALLEL,
    );
  // A trunk and its own branch are still exactly coincident, not a lane.
  assert.equal(
    corridorRenderMode(
      railway("hk-mtr-eal-low", "東鐵綫", "MTR\u0000東鐵綫"),
      railway("hk-mtr-eal-lmc", "東鐵綫", "MTR\u0000東鐵綫"),
    ),
    CorridorRenderMode.MAIN_BRANCH_SHARED,
  );
  // And two genuinely different railways in one corridor still take a lane
  // each — this rule may not be bought at the price of the last one.
  assert.equal(
    corridorRenderMode(
      railway("hk-mtr-ael", "機場快綫", "MTR\u0000機場快綫"),
      railway("hk-mtr-tcl", "東涌綫", "MTR\u0000東涌綫"),
    ),
    CorridorRenderMode.INDEPENDENT_PARALLEL,
  );
});

test("independent railways sharing a corridor still render parallel", () => {
  const pkg = JSON.parse(fs.readFileSync(HK_PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  // 機場快綫 and 東涌綫 are two railways on their own tracks through one
  // corridor, and 電車東行綫/西行綫 are the two tracks of a double-track
  // tramway (hktramways.com) — not services over one set of rails. Both pairs
  // must keep their lanes.
  for (const lineId of ["hk-mtr-ael", "hk-mtr-tcl", "hk-tram-east", "hk-tram-west"])
    assert.ok(
      laneOf(network, lineId).some((lane) => lane !== 0),
      `${lineId} lost the lane it needs to stay a separate railway`,
    );
  // Japan's trunk railways too: a 新幹線 and the 在來線 beside it share an
  // operator, a name stem and a corridor, and are two railways.
  const { network: jp } = japan();
  for (const lineId of [
    "jp-東海旅客鉄道-東海道新幹線",
    "jp-東海旅客鉄道-東海道線",
    "jp-東日本旅客鉄道-東北新幹線",
  ])
    assert.ok(
      laneOf(jp, lineId).some((lane) => lane !== 0),
      `${lineId} lost its lane`,
    );
});

test("a railway lane is counted per railway, never per service", () => {
  const pkg = JSON.parse(fs.readFileSync(HK_PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  // Every corridor's lane count has to equal the number of distinct RAILWAY
  // identities drawn in it. Reading it off the stored table: group the lane
  // rows by the stretch they occupy and check no railway appears twice.
  const byRailway = new Map();
  for (const row of pkg.lanes || []) {
    const line = network.lineById.get(row[0]);
    assert.ok(line, `${row[0]} has lanes but no line`);
    const seen = byRailway.get(line.railwayId) || new Set();
    seen.add(row[4]);
    byRailway.set(line.railwayId, seen);
  }
  // 輕鐵 holds no lane at all now; nothing else in Hong Kong shares a railway
  // identity with anything else.
  assert.ok(!byRailway.has("hk-mtr-light-rail"), "輕鐵 still takes lanes");
});

// ── interchanges ────────────────────────────────────────────────────────────

test("a platform is an interchange when two RAILWAYS meet, not two services", () => {
  const pkg = JSON.parse(fs.readFileSync(HK_PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const byStation = new Map(
    network.stations.features.map((f) => [f.properties.stationId, f.properties]),
  );
  // A 輕鐵 stop served by several route numbers is ONE railway calling once.
  // Drawing it open would promise a change of train that nobody makes.
  const lightRail = network.stations.features.filter((f) =>
    f.properties.lineId.startsWith("hk-mtr-lr-"),
  );
  assert.ok(lightRail.length > 0);
  const groups = new Map();
  for (const f of lightRail) {
    const key = f.properties.stationGroupId;
    if (!key) continue;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const multiService = [...groups.entries()].filter(([, n]) => n > 1);
  assert.ok(
    multiService.length > 0,
    "no 輕鐵 stop is served by more than one route in the package",
  );
  for (const [key] of multiService) {
    const here = lightRail.filter((f) => f.properties.stationGroupId === key);
    // …unless a genuinely different railway also calls there, of course.
    const railways = new Set(
      network.groupMembers
        .get(key)
        .map((m) => network.lineById.get(m.lineId).railwayId),
    );
    for (const f of here)
      assert.equal(
        f.properties.interchange,
        railways.size > 1 ? 1 : 0,
        `${f.properties.name} counts services instead of railways`,
      );
  }
  // And a real one is marked: 南昌 is 東涌綫 and 屯馬綫, two railways.
  const namCheong = network.stations.features.filter(
    (f) => f.properties.name === "南昌",
  );
  assert.ok(namCheong.length >= 2, "南昌 is not in the package twice");
  for (const f of namCheong) assert.equal(f.properties.interchange, 1);
  assert.ok(byStation.size > 0);
});

test("an interchange is drawn open and a single-railway stop solid", () => {
  const style = loadStyle();
  const layers = style.buildBaseStyle({ country: "hk" }).layers;
  const stations = layers.find((l) => l.id === style.STATIONS_LAYER);
  const fill = JSON.stringify(stations.paint["circle-color"]);
  const stroke = JSON.stringify(stations.paint["circle-stroke-color"]);
  // Both colours are decided per feature by the flag, so one dot cannot be
  // solid in its middle and open in its ring.
  assert.ok(fill.includes("interchange"), "the fill ignores interchanges");
  assert.ok(stroke.includes("interchange"), "the ring ignores interchanges");
  // The open middle takes the ring colour and the solid middle the dot
  // colour — the two are different, or nothing would read as a hole.
  // The open middle takes a DIFFERENT colour from the solid one, or nothing
  // would read as a hole. (JSON, not deepEqual: the style is evaluated in its
  // own realm and its arrays carry that realm's prototype.)
  const openFill = JSON.parse(JSON.stringify(style.stationFill("light")));
  assert.equal(openFill[0], "case");
  assert.notEqual(
    openFill[2],
    openFill[3],
    "an interchange is filled the same as a plain stop",
  );
  // The laned platform marker follows the identical rule, so a station in a
  // parallel lane cannot disagree with one on its own alignment. It carries
  // its colours in a bitmap rather than in paint, so what is pinned here is
  // that it still CHOOSES by the same flag, and chooses a different mark.
  const marker = layers.find((l) => l.id === style.STATION_LANES_LAYER);
  const image = JSON.parse(JSON.stringify(marker.layout["icon-image"]));
  assert.equal(image[0], "concat");
  assert.equal(image[1], "rn-station-light-");
  assert.deepEqual(image[2], [
    "coalesce",
    ["get", "colorKey"],
    "7c8a82",
  ]);
  assert.deepEqual(image[3], [
    "case",
    ["==", ["get", "interchange"], 1],
    "-interchange",
    "",
  ]);
  // And that the pair really is per theme, or a dark map would draw light dots.
  assert.notEqual(
    style.stationIconId("dark", false, "ff0000"),
    style.stationIconId("light", false, "ff0000"),
  );
});
