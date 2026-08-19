"use strict";

// Standing regression cover for the railway audit
// (scripts/validation/validate-railway-topology.mjs). Each test pins a property of the
// DRAWN network that a geometry or renderer change could silently break; the
// audit itself is the measuring instrument, so a defect class that reappears
// fails here instead of only showing up on the map.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const RailNetwork = require("../public/rail-network.js");

// The style module is a classic browser script over two globals; evaluate it
// the way index.html does so its expressions can be read back as data.
function loadRailMapStyle() {
  const win = { console, RailNetwork };
  win.window = win;
  const context = vm.createContext(win);
  for (const filename of ["railmap-basemap.js", "railmap-style.js"]) {
    const file = path.join(__dirname, "../public", filename);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename });
  }
  return win.RailMapStyle;
}

const PACKAGE_PATH = path.join(__dirname, "../public/rail/jp-2025.json");

const auditPromise = import("../scripts/validation/validate-railway-topology.mjs");
const topologyPromise = import("../scripts/railway/lib/railway-topology.mjs");

let cachedReport = null;
async function japanReport() {
  if (cachedReport) return cachedReport;
  const { auditCountry } = await auditPromise;
  // Corridor detection is a separate, slower sweep with its own test.
  cachedReport = auditCountry("jp", { corridors: false });
  return cachedReport;
}

function codeCount(report, code) {
  let total = 0;
  for (const line of report.lines)
    for (const problem of line.problems) if (problem.code === code) total += 1;
  for (const problem of report.orphanProblems || [])
    if (problem.code === code) total += 1;
  return total;
}

function detailsFor(report, code) {
  const rows = [];
  for (const line of report.lines)
    for (const problem of line.problems)
      if (problem.code === code)
        rows.push(`${line.operator}／${line.name}: ${problem.detail}`);
  return rows.join("\n");
}

test("no drawn stroke is cut loose at a switch or off a platform", async () => {
  const report = await japanReport();
  // A branch joins its line AT A STATION: it is drawn over the shared metres
  // from the platform out to the physical switch, never started at the switch.
  assert.equal(
    codeCount(report, "branch_stops_at_junction"),
    0,
    detailsFor(report, "branch_stops_at_junction"),
  );
  assert.equal(
    codeCount(report, "wrong_terminus"),
    0,
    detailsFor(report, "wrong_terminus"),
  );
  assert.equal(
    codeCount(report, "station_not_on_line"),
    0,
    detailsFor(report, "station_not_on_line"),
  );
});

test("shared track is drawn twice from ONE set of coordinates", async () => {
  const report = await japanReport();
  // The branch's lead-in copies the trunk's own vertices, and grooming
  // protects any vertex two strokes share, so a shared stretch is coincident
  // to the last decimal. Anything else means the two strokes drifted apart
  // and the corridor renders as a pair of lines a few metres wide.
  assert.equal(
    codeCount(report, "shared_track_not_overlapping"),
    0,
    detailsFor(report, "shared_track_not_overlapping"),
  );
});

test("every long chord follows the official N02 alignment", async () => {
  const report = await japanReport();
  // Shinkansen tunnels are digitised as kilometre-long straights; those are
  // fine. A chord that LEAVES the surveyed alignment is a hole being bridged.
  assert.equal(
    codeCount(report, "disconnected_geometry"),
    0,
    detailsFor(report, "disconnected_geometry"),
  );
});

test("a stroke never opens by folding back over itself", async () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const { distanceMeters, pathLengthMeters } = await topologyPromise;

  // trimFoldedEnds' invariant, stated from the outside: a stroke may not open
  // with a short excursion that costs more than 2.5× the straight line back to
  // where it started. That shape is a spur out of the station which the line
  // immediately retraces — a 180° thorn on the map and a doubled measurement
  // for any ride sliced across it.
  //
  // The budget below mirrors the trim's own (FOLD_MAX_METERS, FOLD_MAX_SHARE):
  // on a funicular or a 800 m tram link, "300 m out and back" is a third of
  // the railway and may well be its real shape, so the trim leaves it alone
  // and so does this test. Those show up as sharp_artificial_turn warnings in
  // the audit instead, where a human can judge them.
  //
  // A fold with a PLATFORM inside it is likewise left alone, and that is the
  // stronger rule of the two: trimming it would take a station off the line
  // that calls there, which is a worse map than the thorn (広島電鉄 宇品線,
  // 神戸新交通 ポートアイランド線 — both people-mover/tram loops whose opening
  // stretch genuinely serves stops before doubling back).
  const offenders = [];
  for (const line of network.lineById.values()) {
    const platforms = new Set(
      (line.stationOrder || [])
        .map((id) => network.stationById.get(id))
        .filter(Boolean)
        .map((station) => `${station.lon},${station.lat}`),
    );
    for (const [partIndex, coordinates] of (line.parts || []).entries()) {
      const budget = Math.min(1200, pathLengthMeters(coordinates) * 0.2);
      for (const ends of [coordinates, coordinates.slice().reverse()]) {
        let travelled = 0;
        let servesPlatform = false;
        for (let index = 1; index < ends.length; index += 1) {
          travelled += distanceMeters(ends[index - 1], ends[index]);
          if (travelled > budget) break;
          if (platforms.has(`${ends[index][0]},${ends[index][1]}`))
            servesPlatform = true;
          const chord = distanceMeters(ends[0], ends[index]);
          if (!servesPlatform && chord <= 160 && travelled >= 2.5 * Math.max(chord, 1))
            offenders.push(
              `${line.lineId}#${partIndex}: ${travelled.toFixed(0)} m of track to get ${chord.toFixed(0)} m from the platform`,
            );
        }
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
  // Sanity: the check is looking at real geometry, not an empty set.
  assert.ok(
    [...network.lineById.values()].reduce(
      (sum, line) => sum + pathLengthMeters(line.parts[0]),
      0,
    ) > 20_000_000,
  );
});

test("the official network is drawn, and what is not is accounted for", async () => {
  const report = await japanReport();
  assert.ok(report.n02, "N02 sections must be available to the audit");
  const groups = [...report.n02.perGroup.values()];
  const missKm = groups.reduce((sum, group) => sum + group.missKm, 0);
  const isolatedKm = groups.reduce((sum, group) => sum + group.isolatedKm, 0);
  // 27 845 km of official track. What stays undrawn is (a) a second alignment
  // of a corridor the map already draws once — inherent to one stroke per
  // line — and (b) a small tail of genuinely isolated corridor, itemised in
  // the report. Both are budgeted; a regression shows up as growth.
  //
  // Raised from 120 to 170 km for the 2026-08-15 rebuild, with the growth
  // named rather than absorbed. The validator itemises it and the largest
  // pieces are all track this map should not draw as passenger railway:
  //   ~16 km  東海道線 新垂井線, a freight-only bypass excluded from 営業キロ
  //   ~11 km  留萌線, withdrawn in 2026 and deleted by the audit, still in N02
  //   ~19 km  石北線's superseded alignment around 常紋
  //   ~74 km  海峡線, whose two stations N02 leaves on unconnected track groups
  // Drawing any of them would mean asserting track the sources do not support.
  assert.ok(missKm < 170, `undrawn official track grew to ${missKm.toFixed(1)} km`);
  // 30 -> 90 km, the same growth split out by kind. "Isolated" means a corridor
  // no drawn stroke runs along, which is exactly what the four items above are:
  // a freight bypass, a withdrawn line, a superseded alignment, and a line whose
  // own sections do not join up. They are undrawn because the sources do not
  // support drawing them, not because a stroke wandered off them.
  assert.ok(
    isolatedKm < 90,
    `isolated undrawn corridor grew to ${isolatedKm.toFixed(1)} km`,
  );
  // Every N02 (operator, line) is drawn somewhere, even the ones whose
  // operator has since rebranded (東京地下鉄 → 東京メトロ).
  //
  // Except the ones the 2026-08-13 audit WITHDREW. N02-25 is a survey with a
  // base date of 2025-12-31 and still carries lines that have since closed;
  // the audit deletes those with a source URL apiece, and a closed railway is
  // exactly what a current map should not draw. 留萌線 closed in 2026 —
  // see rebuild-inventory/evidence/network-corrections-2026-08-13.json.
  const WITHDRAWN = new Set(["北海道旅客鉄道／留萌線"]);
  const undrawn = report.n02.unmatchedByName.filter(
    (entry) =>
      entry.coveredRatio < 0.9 &&
      !WITHDRAWN.has(`${entry.operator}／${entry.name}`),
  );
  assert.deepEqual(
    undrawn,
    [],
    undrawn.map((entry) => `${entry.operator}／${entry.name}`).join(", "),
  );
});

test("railway weight is screen-space and half a station circle", async () => {
  const { RENDER_STYLE } = await auditPromise;
  const source = fs.readFileSync(
    path.join(__dirname, "../public/railmap-style.js"),
    "utf8",
  );
  const token = (pattern, label) => {
    const match = source.match(pattern);
    assert.ok(match, `${label} not found in railmap-style.js`);
    return Number(match[1]);
  };
  const stationDiameter = token(
    /const STATION_DIAMETER_PX = ([0-9.]+);/,
    "STATION_DIAMETER_PX",
  );
  const ratio = token(
    /const RAIL_WIDTH_TO_STATION_DIAMETER = ([0-9.]+);/,
    "RAIL_WIDTH_TO_STATION_DIAMETER",
  );
  const parallelGap = token(
    /parallelGapPx: ([0-9.]+),/,
    "RAILWAY_STYLE.parallelGapPx",
  );
  // The audit mirrors these numbers to answer "at what zoom do two railways
  // stop overlapping?"; the mirror must not drift from the renderer.
  assert.equal(stationDiameter, RENDER_STYLE.stationDiameterPx);
  assert.equal(stationDiameter * ratio, RENDER_STYLE.railWidthPx);
  assert.equal(parallelGap, RENDER_STYLE.parallelGapPx);
  // …and neither may the ramp those weights ride, which is half of that same
  // answer now: a corridor separates at the zoom where the real gap first
  // clears the stroke AS DRAWN AT THAT ZOOM, not at full token weight.
  const style = loadRailMapStyle();
  assert.equal(RENDER_STYLE.fullWeightZoom, style.RAILWAY_FULL_WEIGHT_ZOOM);
  assert.equal(RENDER_STYLE.weightZoomBase, style.RAILWAY_WEIGHT_ZOOM_BASE);
  assert.equal(RENDER_STYLE.minWeightScale, style.RAILWAY_MIN_WEIGHT_SCALE);
  // The contract itself: a rail stroke is half the station circle it threads.
  assert.equal(
    RENDER_STYLE.railWidthPx,
    RENDER_STYLE.stationDiameterPx * 0.5,
  );
  // …and both are painted as that token through railwayScale() and nothing
  // else: no second ramp, no per-layer rescaling on the way to the paint
  // property. That is what makes the mirrored numbers above the numbers the
  // map draws at the ramp's anchor, and a fixed proportion of them everywhere
  // else.
  const layerWidth = source.match(
    /"line-width": railwayScale\(RAILWAY_STYLE\.railWidthPx\),/,
  );
  const layerRadius = source.match(
    /"circle-radius": railwayScale\(RAILWAY_STYLE\.stationRadiusPx\),/,
  );
  assert.ok(layerWidth, "rn-segments-line must paint the token rail width");
  assert.ok(layerRadius, "rn-stations-dot must paint the token station radius");
});

// Everything that draws a railway rides the SAME zoom ramp — that is the
// whole contract, because a weight that thins while the lane beside it holds
// (or the reverse) is what welds a parallel bundle shut or fans it open. The
// table RailMap paints from is the exhaustive list of railway weights and lane
// offsets, so a weight that opted out, or one that invented a ramp of its own,
// shows up here.
test("every railway weight rides the one shared scale ramp", () => {
  const style = loadRailMapStyle();
  const entries = style.railwayScreenPaintEntries();
  assert.ok(entries.length >= 10);
  // The expressions come out of a VM realm, so compare their shape as data.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // The ramp's own anchors, read once from the module and then demanded of
  // every value: two stops, the floor and the full-weight anchor.
  const anchors = style.railwayScale(1);
  assert.ok(same(anchors[1], ["exponential", style.RAILWAY_WEIGHT_ZOOM_BASE]));
  assert.ok(same(anchors[2], ["zoom"]));
  assert.equal(anchors[3], style.RAILWAY_MIN_WEIGHT_ZOOM);
  assert.equal(anchors[5], style.RAILWAY_FULL_WEIGHT_ZOOM);

  // The factor a value is scaled by at the floor. A weight is either a plain
  // number of pixels or ["*", <base>, factor]; either way the two stops must
  // differ by nothing except the factor, or the ramp is scaling two different
  // things at its two ends.
  // MapLibre accepts ["zoom"] ONLY as the input of a top-level step or
  // interpolate, so a ramp buried inside arithmetic — lane × ramp(distance),
  // say — is not a subtler way of writing the same weight: it is a style the
  // validator throws out, taking the whole layer with it.
  const rampIsTopLevel = (expr) => {
    const buried = (node) =>
      Array.isArray(node) &&
      (JSON.stringify(node) === '["zoom"]' || node.some(buried));
    return (
      Array.isArray(expr) &&
      expr[0] === "interpolate" &&
      JSON.stringify(expr[2]) === '["zoom"]' &&
      !expr.slice(3).some(buried)
    );
  };
  const floorScaleOf = (expr, label) => {
    assert.equal(expr[0], "interpolate", label);
    assert.ok(rampIsTopLevel(expr), `${label} buries ["zoom"] inside a value`);
    assert.ok(same(expr[1], anchors[1]), `${label} uses another curve`);
    assert.ok(same(expr[2], ["zoom"]), label);
    assert.equal(expr[3], anchors[3], `${label} floors at another zoom`);
    assert.equal(expr[5], anchors[5], `${label} anchors at another zoom`);
    const [atFloor, atFull] = [expr[4], expr[6]];
    if (typeof atFull === "number") return atFloor / atFull;
    assert.equal(atFull[0], "*", label);
    assert.equal(atFull[2], 1, label);
    assert.equal(atFloor[0], "*", label);
    assert.ok(same(atFloor[1], atFull[1]), `${label} scales two base values`);
    return atFloor[2];
  };

  for (const entry of entries) {
    const label = `${entry.layer} ${entry.property}`;
    // icon-offset is the ONE value that must NOT carry the ramp: MapLibre
    // multiplies it by icon-size, which does, so ramping it too would apply
    assert.equal(
      floorScaleOf(entry.value, label),
      style.RAILWAY_MIN_WEIGHT_SCALE,
      label,
    );
  }
});

// The ramp itself, as a reader meets it: full token weight from the anchor in,
// half the weight every two levels out, and a floor it never goes under.
test("the railway thins with the map scale, anchored on Taiwan's own view", () => {
  const style = loadRailMapStyle();
  const anchor = style.RAILWAY_FULL_WEIGHT_ZOOM;

  // The anchor IS a map scale, not a zoom that happened to look right: at
  // mid-latitude it is the zoom at which one CSS pixel is worth
  // RAILWAY_FULL_WEIGHT_METERS_PER_PIXEL metres of ground, on MapLibre's
  // 512 px tiles. Taiwan's whole-island default view sits there (z7.17 at
  // 23.6°N on a 1280 px map), which is what makes it the reference the other
  // four countries are calibrated against.
  const metresPerPixel = (zoom, latitude) =>
    (78271.51696 * Math.cos((latitude * Math.PI) / 180)) / Math.pow(2, zoom);
  assert.ok(
    Math.abs(
      metresPerPixel(anchor, 35) - style.RAILWAY_FULL_WEIGHT_METERS_PER_PIXEL,
    ) < 25,
    `z${anchor} at 35°N is ${metresPerPixel(anchor, 35).toFixed(0)} m/px`,
  );
  assert.ok(style.railwayScaleAt(7.17) === 1);

  // Zooming IN past the anchor changes nothing — the tokens are the drawn
  // weights there, and a city view draws exactly what it drew before the ramp
  // existed.
  assert.equal(style.railwayScaleAt(anchor), 1);
  assert.equal(style.railwayScaleAt(anchor + 6), 1);
  // Pulling back halves the weight every two levels…
  assert.ok(Math.abs(style.railwayScaleAt(anchor - 2) - 0.5) < 1e-12);
  assert.ok(Math.abs(style.railwayScaleAt(anchor - 1) - Math.SQRT1_2) < 1e-12);
  // …until the floor, past which lines would stop reading as lines.
  assert.equal(style.railwayScaleAt(style.RAILWAY_MIN_WEIGHT_ZOOM - 1), 1 / 3);
  assert.equal(style.railwayScaleAt(0), 1 / 3);

  // The ramp is monotone the whole way: no zoom at which pulling back makes
  // the railway heavier.
  let previous = 0;
  for (let zoom = 0; zoom <= 22; zoom += 0.25) {
    const scale = style.railwayScaleAt(zoom);
    assert.ok(scale >= previous, `scale drops at z${zoom}`);
    previous = scale;
  }

  // And what MapLibre is handed evaluates to exactly that — the interpolation
  // curve has to reproduce the JS ramp, or the diagnostics measure one thing
  // while the map draws another.
  const expression = style.railwayScale(4);
  for (const zoom of [2, 3.83, 5, 6, 7, 9, 14]) {
    const drawn = style.evaluateScreenValue(expression, zoom, {});
    assert.ok(
      Math.abs(drawn - 4 * style.railwayScaleAt(zoom)) < 1e-12,
      `z${zoom}: style draws ${drawn}, ramp says ${4 * style.railwayScaleAt(zoom)}`,
    );
  }
});

test("independent railways sharing a corridor stay separate lines", async () => {
  const { auditCountry } = await auditPromise;
  const report = auditCountry("hk", { corridors: true });
  const corridors = report.corridors;
  assert.ok(corridors.length > 0);
  // Hong Kong's light rail routes genuinely run on ONE set of tracks, so they
  // must measure as coincident; the Airport Express beside the Tung Chung
  // line is two separate railways and must not be welded into one.
  const lightRail = corridors.find(
    (corridor) =>
      corridor.lines.every((line) => line.name.startsWith("輕鐵")) &&
      corridor.lengthMeters > 5000,
  );
  assert.ok(lightRail, "expected a long light-rail shared corridor");
  assert.equal(lightRail.topology, "SHARED");

  const separate = corridors.filter((corridor) => corridor.topology === "INDEPENDENT");
  assert.ok(separate.length > 0);
  for (const corridor of separate)
    assert.ok(
      corridor.medianGap > 0,
      `${corridor.lines[0].name} and ${corridor.lines[1].name} were merged`,
    );
});

// ── services counted as railways ───────────────────────────────────────────

test("a corridor holding one railway may not hold two drawn lines", async () => {
  const { checkServiceLanes } = await auditPromise;
  const { CorridorRenderMode } = await import(
    "../scripts/railway/lib/parallel-corridors.mjs"
  );
  // Two route numbers of one railway, drawn a lane apart: the defect this
  // check exists for. Synthetic, because the packages no longer contain one.
  const at = [114.0, 22.4];
  const feature = (lineId, lane) => ({
    geometry: { type: "LineString", coordinates: [at, [at[0] + 0.001, at[1]]] },
    properties: { lineId, lane },
  });
  const corridor = {
    renderMode: CorridorRenderMode.SAME_RAILWAY,
    start: at,
    end: at,
    lengthMeters: 4400,
    lines: [
      { lineId: "a", name: "輕鐵610綫", operator: "MTR", railwayId: "one-railway" },
      { lineId: "b", name: "輕鐵615綫", operator: "MTR", railwayId: "one-railway" },
    ],
  };
  const split = [];
  checkServiceLanes(
    { segments: { features: [feature("a", -0.5), feature("b", 0.5)] } },
    [corridor],
    split,
  );
  assert.equal(split.length, 1);
  assert.equal(split[0].code, "service_misclassified_as_independent_parallel");
  assert.equal(split[0].severity, "ERROR");
  assert.equal(split[0].renderedLaneCount, 2);
  assert.equal(split[0].expectedLaneCount, 1);

  // The same corridor drawn as one railway is silent…
  const together = [];
  checkServiceLanes(
    { segments: { features: [feature("a", 0), feature("b", 0)] } },
    [corridor],
    together,
  );
  assert.deepEqual(together, []);
  // …and two genuinely different railways a lane apart are not this defect.
  const independent = [];
  checkServiceLanes(
    { segments: { features: [feature("a", -0.5), feature("b", 0.5)] } },
    [{ ...corridor, renderMode: CorridorRenderMode.INDEPENDENT_PARALLEL }],
    independent,
  );
  assert.deepEqual(independent, []);
});

test("no country draws one railway as several parallel railways", async () => {
  const { auditCountry } = await auditPromise;
  // The standing check, over the real packages. 香港輕鐵 is the case that
  // matters: eleven route numbers, one track network, one drawn railway.
  for (const country of ["hk", "tw", "mo"]) {
    const report = auditCountry(country);
    const split = [
      ...report.lines.flatMap((line) => line.problems),
      ...(report.orphanProblems || []),
    ].filter(
      (problem) => problem.code === "service_misclassified_as_independent_parallel",
    );
    assert.deepEqual(
      split.map((problem) => problem.message),
      [],
      `${country} draws a service as a railway`,
    );
  }
});

test("the corridor report says how many railways each corridor holds", async () => {
  const { auditCountry } = await auditPromise;
  const { CorridorRenderMode } = await import(
    "../scripts/railway/lib/parallel-corridors.mjs"
  );
  const report = auditCountry("hk");
  const modes = new Set(report.corridors.map((corridor) => corridor.renderMode));
  // Hong Kong has both: 輕鐵 route numbers over one railway, and 機場快綫
  // beside 東涌綫 — two railways in one corridor.
  assert.ok(modes.has(CorridorRenderMode.SAME_RAILWAY));
  assert.ok(modes.has(CorridorRenderMode.INDEPENDENT_PARALLEL));
  // Every corridor names the railway identity behind each of its two lines,
  // so a service counted as a railway is visible in the report itself.
  for (const corridor of report.corridors)
    for (const line of corridor.lines)
      assert.ok(line.railwayId, `${line.lineId} reports no railway identity`);
});
