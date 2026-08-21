// =========================================================================
//  stats.mjs — freeze what app-stats.js answers about mileage coverage
//
//  §23a is the one place in the app where a number is a claim about the
//  user's life ("you have ridden 32 % of the JR network"), and the claim
//  rests on a property that is easy to lose in a port: coverage is a DEDUPED
//  UNION over N02 edges, not an accumulated sum. Riding 東京–品川 forty times
//  adds those edges to a Set forty times and to the total once. A port that
//  accumulates looks perfect on a two-train fixture and is wrong by a large
//  factor on a real store, so the aggregate cases below deliberately contain
//  rides that repeat, rides that overlap, and one scenario that lists the
//  SAME entry twice.
//
//  Everything here is produced by evaluating the real app-stats.js (plus
//  app-editor.js, which owns the ride-flag helpers trainRideMinutes reads).
//  Nothing is re-implemented: this file supplies inputs and records answers.
//
//  Inputs are the committed datasets — app/data/rail-sections*.json (the
//  untouched N02-25 section geometry the whole statistic is measured on),
//  app/data/stations*.json, app/data/matched-routes.json (real route-solver
//  output) and app/data/train-store*.json (the real itineraries). Nothing
//  reads app/data/sample-data*/, which is gitignored: a fixture that cannot
//  be regenerated from a clean checkout cannot be checked by `--check`.
// =========================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const name = "stats.json";

// The whole fixture is computed at module load, under a top-level await, and
// `build()` hands back the memoised result.
//
// That is not a style choice. buildStatsEdgeIndexSliced and
// buildMileageStatsView are `async` — they park on a 12 ms budget so opening
// the 統計 tab cannot freeze mid-interaction — and the generator calls
// `build()` synchronously, so there is no await available at that point to
// unwrap what they return. A module's top level has one; the generator
// already awaits the dynamic `import()` that loads this file, so the work
// happens before `build()` is ever reached. Re-implementing the two
// functions synchronously to dodge the await is exactly the copy this whole
// exercise exists to avoid.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(SCRIPT_DIR, "..", "..", "..");
const AppCore = createRequire(import.meta.url)(
  path.join(APP_DIR, "shared", "app-core.js"),
);

// ── loading the implementation under test ───────────────────────────────
// app-stats.js is a classic script sharing one global lexical scope, so it is
// evaluated rather than imported (the technique loadFrontendScope uses in
// build-port-fixtures.mjs). app-editor.js comes with it because
// trainRideMinutes reads effectivelyRiddenStopIndexes from there, and a
// hand-written copy of that rule would make the ride-time cases prove only
// that the copy agrees with the port.
//
// The prelude supplies the free variables the two files expect the rest of
// the app family to have declared. Three of them are deliberately stubs:
//
//   getMatchedRouteFeatures  — app-route-features.js, a separate port. Its
//                              output is an INPUT here, recorded feature by
//                              feature so the Swift side is fed exactly the
//                              same geometry and ride flags.
//   getTrainRouteTemplateKey — feeds only _statsTrainCache's signature, a
//                              browser perf cache that carries none of the
//                              statistic (and every train here has its own
//                              id, so nothing shares a cache entry).
//   dateLabel                — resolves through I18N, i.e. presentation.
//                              buildMileageStatsView's daily branch is
//                              recorded with the label injected, and the
//                              Swift port takes it as a parameter.
function loadStatsScope() {
  const source = ["app-stats.js", "app-editor.js"]
    .map((file) => fs.readFileSync(path.join(APP_DIR, "public", file), "utf8"))
    .join("\n");

  const prelude = `
    let activeCountry = "jp";
    let railSectionsGeoJson = null;
    let trainStore = { trains: [] };
    let selectedDate = null;
    const ALL_DATES = "__all__";
    const parseTimeToMinutes = window.AppCore.parseTimeToMinutes;
    let _injectedFeatures = new Map();
    function getMatchedRouteFeatures(train) {
      return _injectedFeatures.get(train.id) || [];
    }
    function getTrainRouteTemplateKey(train) {
      return String((train && train.id) || "");
    }
    function yieldToEventLoop() { return Promise.resolve(); }
    function getTrainDate(train) {
      return String((train && train.date) || "undated");
    }
    function dateLabel(date) { return date; }
  `;

  const epilogue = `
    return {
      exclusiveTrackBucket, filterCategoryForMask, classifySectionMask,
      markerCategoryForStation, activeStatCategories,
      sectionRailwayClassCode, sectionInstitutionTypeCode,
      sectionLineNameOf, sectionOperatorOf,
      buildStatsEdgeIndexSliced, collectTrainStatsEntry,
      aggregateMileageStats, topRiddenSegments, isEdgeSubset,
      dropContainedSections, serviceGroupOfTrain, serviceGroupStats,
      trainRideMinutes, sumRideMinutes, buildMileageStatsView,
      riddenFeatureCategory, riddenFeatureVisible,
      setCountry: (value) => { activeCountry = value; },
      setSections: (value) => { railSectionsGeoJson = value; },
      setSelectedDate: (value) => { selectedDate = value; },
      setInjectedFeatures: (value) => { _injectedFeatures = value; },
      resetIndex: () => { _statsEdgeIndex = null; _statsTrainCache.clear(); },
      currentIndex: () => _statsEdgeIndex,
    };
  `;

  return new Function("window", prelude + "\n" + source + "\n" + epilogue)({
    AppCore,
  });
}

// ── inputs ──────────────────────────────────────────────────────────────

const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];
/** Countries whose ridden-route cases are built below. */
const RIDE_COUNTRIES = ["jp", "tw", "mo"];

function dataFile(base, country) {
  // countrySuffixed: Japan keeps the unsuffixed historical name.
  return path.join(
    APP_DIR,
    "data",
    country === "jp" ? `${base}.json` : `${base}-${country}.json`,
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ── serialisation ───────────────────────────────────────────────────────

/** A Map keyed by category mask as a plain object. Keys are emitted
 *  ascending, which is the order JavaScript itself iterates integer-like
 *  object keys in — the order the breakdown rows are built in. */
function maskMapToObject(map) {
  const out = {};
  for (const [k, v] of [...map.entries()].sort((a, b) => a[0] - b[0]))
    out[String(k)] = v;
  return out;
}

function catObjectToObject(byCat) {
  const out = {};
  for (const key of Object.keys(byCat).sort((a, b) => Number(a) - Number(b)))
    out[key] = byCat[key];
  return out;
}

/** Map<lineName, perCategoryKm> as sorted rows, so the file is stable. */
function lineTableRows(map) {
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([line, byCat]) => ({ line, byCat: catObjectToObject(byCat) }));
}

// Coordinates are written the way route-feature.json writes them —
// "lon lat;lon lat;…" — rather than as nested JSON arrays. Number→String is
// shortest-round-trip in JavaScript and strtod is exact, so the doubles
// survive; four lines of indented JSON per vertex would not survive the
// reviewer.
function encodeLine(coords) {
  return coords.map((c) => `${c[0]} ${c[1]}`).join(";");
}

/** Geometry pool: the same ride geometry appears in many cases (the ride-flag
 *  variants all reuse one route), and inlining it each time would quadruple
 *  the file for no extra coverage. */
const geometryPool = [];
const geometryIds = new Map();
function poolGeometry(geometry) {
  const lines = !geometry
    ? []
    : geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.type === "MultiLineString"
        ? geometry.coordinates
        : [];
  const encoded = lines.map(encodeLine);
  const key = `${geometry ? geometry.type : "null"} ${encoded.join("")}`;
  if (geometryIds.has(key)) return geometryIds.get(key);
  const id = geometryPool.length;
  geometryPool.push({ id, type: geometry ? geometry.type : null, lines: encoded });
  geometryIds.set(key, id);
  return id;
}

function serializeFeature(feature) {
  const props = (feature && feature.properties) || {};
  return {
    geometry: poolGeometry(feature && feature.geometry),
    // Recorded exactly as it is, including the truthy-but-not-true spellings:
    // the feature filter is `!== true`, and that is the point.
    rideSegment: props.ride_segment === undefined ? null : props.ride_segment,
    from: props.from === undefined ? null : props.from,
    to: props.to === undefined ? null : props.to,
  };
}

function serializeEntry(entry) {
  return {
    km: entry.km,
    edges: entry.edges,
    spans: entry.spans.map(([key, km, mask]) => ({ key, km, mask })),
    segments: entry.segments.map((s) => ({
      from: s.from,
      to: s.to,
      km: s.km,
      bucket: s.bucket,
      edgeIds: s.edgeIds,
    })),
  };
}

function serializeAggregate(stats) {
  return {
    riddenAll: stats.riddenAll,
    unmatchedKm: stats.unmatchedKm,
    riddenByMask: maskMapToObject(stats.riddenByMask),
    lineRidByCat: lineTableRows(stats.lineRidByCat),
  };
}

function serializeTopRow(row) {
  return {
    from: row.from,
    to: row.to,
    count: row.count,
    km: row.km,
    bucket: row.bucket,
    // The edge ids themselves are recorded once, on the segments the rows are
    // built from (trains[].entry.segments[].edgeIds); repeating them here
    // would triple the file to re-assert the same numbers. The COUNT still
    // catches the rule that matters at this level — when a section is ridden
    // twice at different measured lengths, the longest ride's edges replace
    // the first ride's, not just its km.
    edgeIdCount: row.edgeIds ? row.edgeIds.length : null,
  };
}

function serializeTop(top) {
  return {
    // NOT sorted: byMask is a Map seeded from activeStatCategories(), so it
    // iterates in the country's own row order — and Taiwan's is 高鐵, 臺鐵,
    // 捷運, 輕軌, 其他 (1, 2, 8, 32, 16), which is not ascending. Sorting here
    // would hide a port that emitted the rows in the wrong order.
    byMask: [...top.byMask.entries()].map(([mask, rows]) => ({
      mask,
      rows: rows.map(serializeTopRow),
    })),
    all: top.all.map(serializeTopRow),
  };
}

// ── ridden geometry built from real N02 vertices ────────────────────────
// The route solver's output is a LineString whose vertices ARE N02 vertices
// (both the prebuilt matched routes and the in-browser solver run on the
// rail-sections graph), which is the whole reason repeat rides dedupe. So a
// ride can be stated here as a slice of a real section's coordinate list, and
// the cases that matter — a repeat, an overlap, a densified edge, an
// off-network bridge — are stated as edits to such a slice.

/** The longest section of one line, so a slice has vertices to spare.
 *
 *  Matched on operator as well as name: 山手線 alone is two unrelated
 *  railways (JR East's, and 神戸市's municipal subway line of the same name),
 *  which is the very reason rail-network.js groups on operator + name. */
function longestSection(collection, lineName, operator) {
  let best = null;
  for (const f of collection.features) {
    const p = f.properties || {};
    if ((p.N02_003 || p.line_name || "") !== lineName) continue;
    if (operator !== undefined && (p.N02_004 || p.operator || "") !== operator) continue;
    const n = (f.geometry && f.geometry.coordinates && f.geometry.coordinates.length) || 0;
    if (!best || n > best.geometry.coordinates.length) best = f;
  }
  if (!best) throw new Error(`no section on line ${lineName}`);
  return best;
}

function slice(feature, start, end) {
  const coords = feature.geometry.coordinates.slice(start, end).map((c) => [c[0], c[1]]);
  if (coords.length < 2) throw new Error("slice too short to be a ride");
  return coords;
}

function lineFeature(coords, props) {
  return { type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } };
}

function multiLineFeature(parts, props) {
  return { type: "Feature", properties: props, geometry: { type: "MultiLineString", coordinates: parts } };
}

/** Interpolated midpoints — what the route solver's station snaps and
 *  long-edge subdivision insert into an otherwise exact N02 edge. */
function densify(coords) {
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i += 1) {
    out.push([(coords[i - 1][0] + coords[i][0]) / 2, (coords[i - 1][1] + coords[i][1]) / 2]);
    out.push(coords[i]);
  }
  return out;
}

function duplicateVertices(coords) {
  const out = [];
  for (const c of coords) out.push([c[0], c[1]], [c[0], c[1]]);
  return out;
}

/** Lifts one vertex off the network, so the two hops around it match nothing
 *  and accumulate as pending distance. */
function offNetworkDetour(coords, index, delta) {
  const out = coords.map((c) => [c[0], c[1]]);
  out[index] = [out[index][0] + delta, out[index][1] + delta];
  return out;
}

/** Enough of a section's identity that a data change shows up as a fixture
 *  diff rather than as a silently different case. */
function sectionSignature(feature) {
  const p = feature.properties || {};
  const coords = feature.geometry.coordinates;
  return {
    line: p.N02_003 || p.line_name || "",
    operator: p.N02_004 || p.operator || "",
    vertexCount: coords.length,
    first: coords[0],
    last: coords[coords.length - 1],
  };
}

/** Real solver output for one train, in segment order. */
function matchedRouteFeatures(matched, trainId, ridePattern) {
  const found = matched.features
    .filter((f) => (f.properties || {}).train_id === trainId)
    .sort((a, b) => Number(a.properties.segment_index ?? 0) - Number(b.properties.segment_index ?? 0));
  if (!found.length) throw new Error(`matched-routes.json has no train ${trainId}`);
  return found.map((f, i) => ({
    type: "Feature",
    properties: {
      from: f.properties.from,
      to: f.properties.to,
      ride_segment: ridePattern ? ridePattern(i) : true,
    },
    geometry: { type: f.geometry.type, coordinates: f.geometry.coordinates },
  }));
}

const RIDDEN_STOPS = [
  { departure: "10:00", ride_segment: true },
  { arrival: "10:30", departure: "10:32", ride_segment: true },
  { arrival: "11:15", ride_segment: true },
];

function japanRides(jpSections, matched) {
  // One long section per mask the Japanese classifier can produce.
  const tokaido = longestSection(jpSections, "東海道新幹線", "東海旅客鉄道");
  const tadami = longestSection(jpSections, "只見線", "東日本旅客鉄道");
  const chiyoda = longestSection(jpSections, "9号線千代田線", "東京地下鉄");
  const arakawa = longestSection(jpSections, "荒川線", "東京都");
  const tazawako = longestSection(jpSections, "田沢湖線", "東日本旅客鉄道");

  const trains = [];
  const add = (id, why, features, train) => trains.push({ id, why, features, train });

  add(
    "odr_001",
    "Real solver output: 踊り子 down the 東海道線, four station-to-station hops whose vertices are N02 vertices.",
    matchedRouteFeatures(matched, "odr_001"),
    { train_type: "特急", date: "2026-07-03", stops: RIDDEN_STOPS },
  );
  add(
    "azusa_033",
    "Real solver output: あずさ33号 up the 中央線 and onto the 篠ノ井線 — many hops, one of which changes railway.",
    matchedRouteFeatures(matched, "azusa_033"),
    { train_type: "特急", date: "2026-07-03", stops: RIDDEN_STOPS },
  );
  add(
    "odr_001_repeat",
    "The SAME ride again under a second train id. The union must not grow; the per-train km must.",
    matchedRouteFeatures(matched, "odr_001"),
    { train_type: "特急", date: "2026-07-04", stops: RIDDEN_STOPS },
  );
  add(
    "odr_001_unridden",
    "The same geometry with every ride_segment false: nothing at all may be collected.",
    matchedRouteFeatures(matched, "odr_001", () => false),
    { train_type: "特急", date: "2026-07-04", stops: RIDDEN_STOPS },
  );
  add(
    "odr_001_half",
    "Alternate hops ridden. The flag is per FEATURE, so an unridden hop in the middle leaves a hole rather than shortening the ride.",
    matchedRouteFeatures(matched, "odr_001", (i) => i % 2 === 0),
    { train_type: "特急", date: "2026-07-04", stops: RIDDEN_STOPS },
  );
  add(
    "odr_001_truthy",
    "ride_segment = 1. Truthy, and still unridden: the filter is `!== true`.",
    matchedRouteFeatures(matched, "odr_001", () => 1),
    { train_type: "特急", date: "2026-07-05", stops: RIDDEN_STOPS },
  );
  add(
    "odr_001_string_true",
    'ride_segment = "true". Same rule, in the shape a hand-edited JSON file arrives in.',
    matchedRouteFeatures(matched, "odr_001", () => "true"),
    { train_type: "特急", date: "2026-07-05", stops: RIDDEN_STOPS },
  );

  add(
    "syn_tokaido_full",
    "A plain slice of 東海道新幹線 track — the 新幹線 mask, and the baseline the overlap cases are measured against.",
    [lineFeature(slice(tokaido, 0, 30), { from: "T0", to: "T29", ride_segment: true })],
    { train_type: "新幹線", date: "2026-07-06", stops: RIDDEN_STOPS },
  );
  add(
    "syn_tokaido_overlap",
    "A slice that OVERLAPS the previous one (vertices 15–44 against 0–29). The shared edges join the union once; both trains count them in full in their own km.",
    [lineFeature(slice(tokaido, 15, 45), { from: "T15", to: "T44", ride_segment: true })],
    { train_type: "新幹線", date: "2026-07-06", stops: RIDDEN_STOPS },
  );
  add(
    "syn_tokaido_inner",
    "A slice entirely INSIDE syn_tokaido_full (vertices 5–19): every edge is already in the union, so it adds nothing — and as a section it is contained, which is what dropContainedSections has to notice.",
    [lineFeature(slice(tokaido, 5, 20), { from: "T5", to: "T19", ride_segment: true })],
    { train_type: "新幹線", date: "2026-07-07", stops: RIDDEN_STOPS },
  );
  add(
    "syn_tokaido_reversed",
    "The same slice ridden the other way. Edge keys are direction-independent, so this is the same union — and the same section key, because the endpoints are sorted.",
    [lineFeature(slice(tokaido, 0, 30).reverse(), { from: "T29", to: "T0", ride_segment: true })],
    { train_type: "新幹線", date: "2026-07-07", stops: RIDDEN_STOPS },
  );
  add(
    "syn_tokaido_densified",
    "Interpolated midpoints in every N02 edge. A pair-by-pair lookup finds none of these; the anchor-merge walk re-matches each edge when it reaches the far endpoint, so the union must equal syn_tokaido_full's exactly.",
    [lineFeature(densify(slice(tokaido, 0, 30)), { from: "T0", to: "T29", ride_segment: true })],
    { train_type: "新幹線", date: "2026-07-08", stops: RIDDEN_STOPS },
  );
  add(
    "syn_tokaido_duplicate_vertices",
    "Every vertex repeated. The walk skips a hop that goes nowhere rather than treating it as an unmatched bridge.",
    [lineFeature(duplicateVertices(slice(tokaido, 0, 20)), { from: "T0", to: "T19", ride_segment: true })],
    { train_type: "新幹線", date: "2026-07-08", stops: RIDDEN_STOPS },
  );
  add(
    "syn_short_bridge",
    "A short OFF-network detour inside the ride: under MAX_BRIDGE_KM, so it is recorded as one connector span carrying the mask of the edge it reconnects to.",
    [lineFeature(offNetworkDetour(slice(tokaido, 0, 20), 8, 0.004), { from: "T0", to: "T19", ride_segment: true })],
    { train_type: "新幹線", date: "2026-07-09", stops: RIDDEN_STOPS },
  );
  add(
    "syn_long_bridge",
    "A LONG off-network jump (東海道新幹線 track to 山手線 track): the pending distance passes MAX_BRIDGE_KM, so the span is cut and filed with mask 0 — the unmatchedKm remainder.",
    [lineFeature(slice(tokaido, 0, 12).concat(slice(tadami, 0, 12)), { from: "T0", to: "Y11", ride_segment: true })],
    { train_type: "新幹線", date: "2026-07-09", stops: RIDDEN_STOPS },
  );
  add(
    "syn_multiline",
    "MultiLineString: one route with gaps. Each part is walked separately, so the gap between them is not a bridge at all.",
    [multiLineFeature([slice(tadami, 0, 12), slice(chiyoda, 0, 12)], { from: "Y0", to: "G11", ride_segment: true })],
    { train_type: "普通", date: "2026-07-10", stops: RIDDEN_STOPS },
  );
  add(
    "syn_same_endpoints",
    "from === to. The geometry still joins the union and the train's own km, but no section is recorded — 最常乘坐區間 has nothing to name.",
    [lineFeature(slice(tadami, 0, 20), { from: "Y0", to: "Y0", ride_segment: true })],
    { train_type: "普通", date: "2026-07-10", stops: RIDDEN_STOPS },
  );
  add(
    "syn_missing_endpoints",
    "No from/to at all, which is what a hop assembled from geometry alone looks like. Same rule.",
    [lineFeature(slice(tadami, 0, 20), { ride_segment: true })],
    { train_type: "普通", date: "2026-07-11", stops: RIDDEN_STOPS },
  );
  add(
    "syn_mixed_modes",
    "One hop crossing two modes — subway track then street tram. The section is filed under whichever mode carries the MOST of its distance, not the OR of every mask it touched.",
    [
      lineFeature(slice(chiyoda, 0, 30).concat(slice(arakawa, 0, 6)), {
        from: "G0",
        to: "A5",
        ride_segment: true,
      }),
    ],
    { train_type: "普通", date: "2026-07-11", stops: RIDDEN_STOPS },
  );
  add(
    "syn_mini_shinkansen",
    "田沢湖線 track — filed by N02-25 as 在来線 and moved to 新幹線 by the mini-Shinkansen reclassification. The ridden km must follow the corridor override, not the raw N02 code.",
    [lineFeature(slice(tazawako, 0, 25), { from: "D0", to: "D24", ride_segment: true })],
    { train_type: "新幹線", date: "2026-07-12", stops: RIDDEN_STOPS },
  );
  add(
    "syn_two_hops_same_section",
    "One train riding the same stretch there and back in two hops: two SECTIONS with the same sorted key, so the section is counted as two rides and one union contribution.",
    [
      lineFeature(slice(tadami, 0, 15), { from: "Y0", to: "Y14", ride_segment: true }),
      lineFeature(slice(tadami, 0, 15).reverse(), { from: "Y14", to: "Y0", ride_segment: true }),
    ],
    { train_type: "普通", date: "2026-07-12", stops: RIDDEN_STOPS },
  );
  add(
    "syn_partial_then_full",
    "The same named section measured twice, short first. topRiddenSegments keeps the LONGEST measurement, so a partially-solved repeat must not shrink the recorded length.",
    [
      lineFeature(slice(tadami, 0, 6), { from: "Y0", to: "Y14", ride_segment: true }),
      lineFeature(slice(tadami, 0, 15), { from: "Y0", to: "Y14", ride_segment: true }),
    ],
    { train_type: "普通", date: "2026-07-13", stops: RIDDEN_STOPS },
  );
  add(
    "syn_no_features",
    "A train with no route at all — one unsolvable train must not sink the panel.",
    [],
    { train_type: "特急", date: "2026-07-13", stops: RIDDEN_STOPS },
  );

  const at = Object.fromEntries(trains.map((t, i) => [t.id, i]));
  const all = trains.map((_, i) => i);

  return {
    trains,
    dailyDate: "2026-07-06",
    sourceLines: {
      東海道新幹線: sectionSignature(tokaido),
      只見線: sectionSignature(tadami),
      "9号線千代田線": sectionSignature(chiyoda),
      荒川線: sectionSignature(arakawa),
      田沢湖線: sectionSignature(tazawako),
    },
    scenarios: [
      { label: "single", why: "One real ride: the baseline every dedupe scenario is read against.", trainIndexes: [at.odr_001] },
      {
        label: "same-entry-listed-twice",
        why: "THE case this fixture exists for: the identical entry appears twice in the list. riddenAll must be unchanged from `single`, while the summed per-train km doubles. A port that accumulates instead of folding into a Set fails here and nowhere else.",
        trainIndexes: [at.odr_001, at.odr_001],
      },
      { label: "same-ride-two-trains", why: "The same geometry ridden by two trains on two dates — the real shape of a commute.", trainIndexes: [at.odr_001, at.odr_001_repeat] },
      { label: "overlapping-slices", why: "Two rides sharing a stretch of track: the union is the outer extent, not the sum.", trainIndexes: [at.syn_tokaido_full, at.syn_tokaido_overlap] },
      { label: "contained-slice", why: "A ride entirely inside another adds nothing to the union at all.", trainIndexes: [at.syn_tokaido_full, at.syn_tokaido_inner] },
      { label: "reversed-repeat", why: "Direction-independent edge keys: riding back does not discover new track.", trainIndexes: [at.syn_tokaido_full, at.syn_tokaido_reversed] },
      { label: "densified-matches-plain", why: "The densified ride must reach exactly the same union as the plain one.", trainIndexes: [at.syn_tokaido_densified, at.syn_tokaido_full] },
      { label: "bridges", why: "Both connector-span kinds at once: the short one carries a mask, the long one is unmatchedKm.", trainIndexes: [at.syn_short_bridge, at.syn_long_bridge] },
      {
        label: "bridges-repeated",
        why: "The same spans again. Spans dedupe by span key, so unmatchedKm must not double — the second sighting only ORs its mask into the first.",
        trainIndexes: [at.syn_short_bridge, at.syn_long_bridge, at.syn_short_bridge, at.syn_long_bridge],
      },
      { label: "unridden-only", why: "Every ride flag false or merely truthy: an empty union, and zero of everything.", trainIndexes: [at.odr_001_unridden, at.odr_001_truthy, at.odr_001_string_true, at.syn_no_features] },
      { label: "mini-shinkansen", why: "Ridden km on a reclassified corridor lands in 新幹線 and NOT in 在來線, while keeping its JR全線 bit.", trainIndexes: [at.syn_mini_shinkansen] },
      { label: "repeat-sections", why: "Sections ridden more than once, which is what drives the 最常乘坐區間 counts and the containment pass.", trainIndexes: [at.syn_two_hops_same_section, at.syn_partial_then_full, at.syn_tokaido_full, at.syn_tokaido_inner] },
      {
        label: "everything",
        why: "Every ride at once, in declaration order — the union-order case. The Set is iterated in insertion order, so this total depends on the order the trains were walked.",
        trainIndexes: all,
      },
      {
        label: "everything-reversed",
        why: "The same rides in the opposite order. The SET is the same; the sum is taken in a different order, so this total may legitimately differ from `everything` in its last bits. Recording both is what makes the order visible instead of accidental.",
        trainIndexes: [...all].reverse(),
      },
    ],
  };
}

function taiwanRides(twSections, matched) {
  const thsr = longestSection(twSections, "台灣高速鐵路", "台灣高速鐵路股份有限公司");
  const nanhui = longestSection(twSections, "南迴線", "國營臺灣鐵路股份有限公司");
  const alishan = longestSection(twSections, "阿里山線", "阿里山林業鐵路及文化資產管理處");

  const trains = [];
  const add = (id, why, features, train) => trains.push({ id, why, features, train });

  add(
    "20260802_01_taoyuan_airport_mrt_express_t2_taipei",
    "Real solver output on the Taiwanese package — a country whose buckets are exclusive, with no JR-style union to record.",
    matchedRouteFeatures(matched, "20260802_01_taoyuan_airport_mrt_express_t2_taipei"),
    { train_type: "直達車", date: "2026-08-02", stops: RIDDEN_STOPS },
  );
  add(
    "20260813_01_star_of_taiwan_round_island_loop",
    "Real solver output for the round-island loop: the ride that makes 臺鐵 coverage move.",
    matchedRouteFeatures(matched, "20260813_01_star_of_taiwan_round_island_loop"),
    { train_type: "自強", date: "2026-08-13", stops: RIDDEN_STOPS },
  );
  add(
    "tw_hsr",
    "高鐵 track: Taiwan's hsr bucket, decided by its own institution code 1.",
    [lineFeature(slice(thsr, 0, 25), { from: "H0", to: "H24", ride_segment: true })],
    { train_type: "高鐵", date: "2026-08-14", stops: RIDDEN_STOPS },
  );
  add(
    "tw_conv",
    '臺鐵 track: CONV-only, which is the mask Taiwan\'s national-railway toggle reads as "jr".',
    [lineFeature(slice(nanhui, 0, 25), { from: "W0", to: "W24", ride_segment: true })],
    { train_type: "區間車", date: "2026-08-14", stops: RIDDEN_STOPS },
  );
  add(
    "tw_alishan",
    "阿里山林業鐵路: class 31, the 特殊鐵道 slot — a bucket Japan fills with something else entirely.",
    [lineFeature(slice(alishan, 0, 20), { from: "A0", to: "A19", ride_segment: true })],
    { train_type: "阿里山小火車", date: "2026-08-15", stops: RIDDEN_STOPS },
  );
  add(
    "tw_hsr_repeat",
    "The 高鐵 ride again: the dedupe rule is country-independent.",
    [lineFeature(slice(thsr, 0, 25), { from: "H0", to: "H24", ride_segment: true })],
    { train_type: "高鐵", date: "2026-08-15", stops: RIDDEN_STOPS },
  );

  const at = Object.fromEntries(trains.map((t, i) => [t.id, i]));
  return {
    trains,
    dailyDate: "2026-08-14",
    sourceLines: {
      台灣高速鐵路: sectionSignature(thsr),
      南迴線: sectionSignature(nanhui),
      阿里山線: sectionSignature(alishan),
    },
    scenarios: [
      { label: "tw-single", why: "One real Taiwanese ride.", trainIndexes: [0] },
      { label: "tw-repeat", why: "The same 高鐵 track twice: one union contribution, two per-train sums.", trainIndexes: [at.tw_hsr, at.tw_hsr_repeat] },
      { label: "tw-everything", why: "Every Taiwanese ride, exercising the country's own category list.", trainIndexes: trains.map((_, i) => i) },
    ],
  };
}

function macaoRides(moSections) {
  const taipa = longestSection(moSections, "氹仔線", "澳門輕軌");
  const ride = () => [lineFeature(slice(taipa, 0, 15), { from: "M0", to: "M14", ride_segment: true })];
  const trains = [
    {
      id: "mo_lrt",
      why: "Macao is a single-category country: one bucket in activeStatCategories, so a port that hardcodes Japan's six rows has nowhere to put this.",
      features: ride(),
      train: { train_type: "輕軌", date: "2026-08-16", stops: RIDDEN_STOPS },
    },
    {
      id: "mo_lrt_repeat",
      why: "And again, because the dedupe rule does not care how small the network is.",
      features: ride(),
      train: { train_type: "輕軌", date: "2026-08-16", stops: RIDDEN_STOPS },
    },
  ];
  return {
    trains,
    dailyDate: "2026-08-16",
    sourceLines: { 氹仔線: sectionSignature(taipa) },
    scenarios: [
      { label: "mo-single", why: "One ride on a one-category country.", trainIndexes: [0] },
      { label: "mo-repeat", why: "Two identical rides, one union.", trainIndexes: [0, 1] },
    ],
  };
}

// ── hand-built inputs the real data has no example of ───────────────────

const ADVERSARIAL_SECTION_PROPS = [
  // The 東京都 tram carve-out, and the reason it must NOT be operator-wide:
  // Osaka Metro's subways are legally 軌道 (class 21) too.
  { N02_001: "21", N02_002: "3", N02_003: "荒川線", N02_004: "東京都" },
  { N02_001: "11", N02_002: "3", N02_003: "浅草線", N02_004: "東京都" },
  { N02_001: "21", N02_002: "3", N02_003: "御堂筋線", N02_004: "大阪市高速電気軌道" },
  // The three 軌道法 lines that are heavy rail, plus a near miss each way:
  // the exception is keyed on operator|line, not on either alone.
  { N02_001: "21", N02_002: "4", N02_003: "南北線", N02_004: "北大阪急行電鉄" },
  { N02_001: "21", N02_002: "4", N02_003: "けいはんな線", N02_004: "近畿日本鉄道" },
  { N02_001: "21", N02_002: "4", N02_003: "豊川線", N02_004: "名古屋鉄道" },
  { N02_001: "21", N02_002: "4", N02_003: "南北線", N02_004: "名古屋鉄道" },
  { N02_001: "21", N02_002: "4", N02_003: "豊川線", N02_004: "北大阪急行電鉄" },
  // Class 22 is a SUSPENDED MONORAIL under 軌道法, not a street tram.
  { N02_001: "22", N02_002: "5", N02_003: "千葉都市モノレール1号線", N02_004: "千葉都市モノレール" },
  // An institution code that is none of 1/2/4/5: no JR bit and no 私鐵 bit.
  { N02_001: "11", N02_002: "3", N02_003: "市営地下鉄", N02_004: "どこかの市" },
  // Numeric rather than string codes. sectionRailwayClassCode coerces with
  // String(), and `0 || fallback` is why it cannot simply read the field —
  // a numeric 0 falls through to the neutral alias.
  { N02_001: 21, N02_002: 4, N02_003: "数値線", N02_004: "数値鉄道" },
  { N02_001: 0, railway_class_code: "21", N02_002: 0, institution_type_code: "4", line_name: "混合線", operator: "混合鉄道" },
  // Missing everything — markerCategoryForStation's null gate.
  {},
  { N02_003: "名前だけ線" },
  // Hong Kong rides on operator and line name, so the 輕鐵 prefix needs both
  // a hit and a near miss.
  { railway_class_code: "21", institution_type_code: "4", line_name: "輕鐵505綫", operator: "MTR" },
  { railway_class_code: "21", institution_type_code: "4", line_name: "輕便鐵路", operator: "MTR" },
  { railway_class_code: "21", institution_type_code: "4", line_name: "港島綫", operator: "香港電車" },
  // Korea consults class 31 / 21 BEFORE the institution code, which is the
  // opposite order to Taiwan's class 21.
  { railway_class_code: "31", institution_type_code: "1", line_name: "모노레일", operator: "테스트" },
  { railway_class_code: "21", institution_type_code: "1", line_name: "트램", operator: "테스트" },
  { railway_class_code: "11", institution_type_code: "4", line_name: "경전철", operator: "테스트" },
];

const ADVERSARIAL_TRAINS = [
  { why: "ride_segment must be exactly true — a truthy 1 does not count.", country: "jp", trainType: "特急", stops: [{ departure: "10:00", ride_segment: 1 }, { arrival: "11:00", ride_segment: 1 }] },
  { why: 'Nor the string "true".', country: "jp", trainType: "特急", stops: [{ departure: "10:00", ride_segment: "true" }, { arrival: "11:00", ride_segment: "true" }] },
  { why: "Fewer than two ridden stops is no ride time at all.", country: "jp", trainType: "新幹線", stops: [{ departure: "10:00", ride_segment: true }, { arrival: "11:00", ride_segment: false }] },
  { why: "A pass-through inherits its interval, so it is never a ride boundary however it is flagged.", country: "jp", trainType: "普通", stops: [{ departure: "10:00", ride_segment: true }, { arrival: "10:30", departure: "10:31", stop_type: "pass_through", ride_segment: true }, { arrival: "11:00", ride_segment: true }] },
  { why: "A pass-through between two UNRIDDEN stops stays unridden.", country: "jp", trainType: "普通", stops: [{ departure: "10:00", ride_segment: false }, { arrival: "10:30", stop_type: "pass_through", ride_segment: true }, { arrival: "11:00", ride_segment: false }] },
  { why: "A pass-through at the very START has no previous stopping station, so it falls back to its own flag.", country: "jp", trainType: "普通", stops: [{ departure: "10:00", stop_type: "pass_through", ride_segment: true }, { arrival: "11:00", ride_segment: true }] },
  { why: "End before start wraps overnight (+24 h) — an itinerary past midnight written without a suffix.", country: "jp", trainType: "寝台特急", stops: [{ departure: "22:10", ride_segment: true }, { arrival: "06:05", ride_segment: true }] },
  { why: 'The explicit "+1" spelling, which parseTimeToMinutes already folds in — no second wrap.', country: "jp", trainType: "寝台特急", stops: [{ departure: "22:10", ride_segment: true }, { arrival: "06:05 +1", ride_segment: true }] },
  { why: "25:10 counts up past midnight the jsonspec way.", country: "jp", trainType: "寝台特急", stops: [{ departure: "22:10", ride_segment: true }, { arrival: "25:10", ride_segment: true }] },
  { why: "Departure missing on the first ridden stop falls back to its arrival; arrival missing on the last falls back to its departure.", country: "jp", trainType: "特急", stops: [{ arrival: "10:00", ride_segment: true }, { departure: "11:00", ride_segment: true }] },
  { why: "No usable time at either end is null, not zero.", country: "jp", trainType: "特急", stops: [{ ride_segment: true }, { ride_segment: true }] },
  { why: "An unparseable time is null too.", country: "jp", trainType: "特急", stops: [{ departure: "とても朝", ride_segment: true }, { arrival: "11:00", ride_segment: true }] },
  { why: "Identical times are a zero-minute ride, not an overnight wrap.", country: "jp", trainType: "特急", stops: [{ departure: "10:00", ride_segment: true }, { arrival: "10:00", ride_segment: true }] },
  { why: "More than two ridden stops: the span is FIRST departure to LAST arrival, ignoring everything between.", country: "jp", trainType: "特急", stops: [{ departure: "10:00", ride_segment: true }, { arrival: "23:00", departure: "23:01", ride_segment: true }, { arrival: "11:00", ride_segment: true }] },
  { why: "新幹線 wins the hsr tier by substring, anywhere in the type.", country: "jp", trainType: "東海道新幹線のぞみ", stops: [] },
  { why: "特急 is the ltd tier — and 通勤特急 matches it by the same substring rule.", country: "jp", trainType: "通勤特急", stops: [] },
  { why: "A type carrying both words: 新幹線 is tested first.", country: "jp", trainType: "新幹線特急", stops: [] },
  { why: "Missing type falls to other.", country: "jp", trainType: null, stops: [] },
  { why: "Taiwan matches its own vocabulary: 高鐵 is hsr.", country: "tw", trainType: "高鐵", stops: [] },
  { why: "…and simplified 高铁 too.", country: "tw", trainType: "高铁", stops: [] },
  { why: "自強 / 太魯閣 / 普悠瑪 / 莒光 are the reserved-seat tier.", country: "tw", trainType: "普悠瑪", stops: [] },
  { why: "Taiwan does not read Japan's words: 特急 is not a Taiwanese tier.", country: "tw", trainType: "特急", stops: [] },
  { why: "Japan does not read Taiwan's: 自強 is not a Japanese tier.", country: "jp", trainType: "自強", stops: [] },
  { why: "區間車 falls to Taiwan's other tier.", country: "tw", trainType: "區間車", stops: [] },
  { why: "Only jp and tw have their own vocabulary; every other country falls through to Japan's rules.", country: "kr", trainType: "특급", stops: [] },
];

const SUBSET_CASES = [
  { inner: [1, 2, 3], outer: [1, 2, 3, 4] },
  { inner: [1, 2, 3], outer: [0, 1, 2, 3] },
  { inner: [2, 4], outer: [1, 2, 3, 4, 5] },
  { inner: [1, 2, 3], outer: [1, 2] },
  { inner: [], outer: [1, 2] },
  { inner: [1], outer: [] },
  { inner: [5], outer: [1, 2, 3, 4] },
  { inner: [1, 5], outer: [1, 2, 3, 4] },
  { inner: [1, 2], outer: [1, 2] },
  { inner: [4], outer: [1, 2, 3, 4] },
  // A repeated id in `inner`: the merge advances j past each match, so the
  // second 2 cannot re-use the first one's position.
  { inner: [2, 2], outer: [1, 2, 3] },
  { inner: [2, 2], outer: [1, 2, 2, 3] },
];

const CONTAINMENT_CASES = [
  {
    why: "A→D ridden more often keeps B→C off the list.",
    rows: [
      { from: "A", to: "D", count: 2, km: 40, bucket: 2, edgeIds: [1, 2, 3, 4] },
      { from: "B", to: "C", count: 1, km: 20, bucket: 2, edgeIds: [2, 3] },
    ],
  },
  {
    why: "A short section ridden MORE than the long one it sits inside ranks first and keeps the long one as its own entry.",
    rows: [
      { from: "B", to: "C", count: 5, km: 20, bucket: 2, edgeIds: [2, 3] },
      { from: "A", to: "D", count: 2, km: 40, bucket: 2, edgeIds: [1, 2, 3, 4] },
    ],
  },
  {
    why: "Same edges, different mode: the bucket guard keeps both (sections of different modes never share edges anyway, so this is belt-and-braces).",
    rows: [
      { from: "A", to: "D", count: 2, km: 40, bucket: 1, edgeIds: [1, 2, 3, 4] },
      { from: "B", to: "C", count: 1, km: 20, bucket: 2, edgeIds: [2, 3] },
    ],
  },
  {
    why: "Three nested sections: containment is tested against everything ALREADY KEPT, not just the previous row.",
    rows: [
      { from: "A", to: "F", count: 9, km: 60, bucket: 2, edgeIds: [1, 2, 3, 4, 5] },
      { from: "B", to: "E", count: 3, km: 40, bucket: 2, edgeIds: [2, 3, 4] },
      { from: "C", to: "D", count: 2, km: 20, bucket: 2, edgeIds: [3] },
    ],
  },
  {
    why: "An empty edge list is never contained (isEdgeSubset refuses it), so an unmatched section survives.",
    rows: [
      { from: "A", to: "D", count: 2, km: 40, bucket: 2, edgeIds: [1, 2, 3, 4] },
      { from: "X", to: "Y", count: 1, km: 5, bucket: 2, edgeIds: [] },
    ],
  },
];

// ── build ───────────────────────────────────────────────────────────────

async function buildFixture() {
  const js = loadStatsScope();

  const sections = {};
  const stations = {};
  for (const country of COUNTRIES) {
    sections[country] = readJson(dataFile("rail-sections", country));
    stations[country] = readJson(dataFile("stations", country));
  }
  const matched = readJson(path.join(APP_DIR, "data", "matched-routes.json"));

  // ── 1. section classification, exhaustively ────────────────────────────
  // Every DISTINCT property tuple in every country's section table, so the
  // classifier is covered rather than sampled, plus the hand-built tuples
  // above for the rules the real data has one example of or none.
  const classificationCases = [];
  for (const country of COUNTRIES) {
    js.setCountry(country);
    const seen = new Set();
    const consider = (props) => {
      const key = JSON.stringify([
        props.N02_001, props.N02_002, props.N02_003, props.N02_004,
        props.railway_class_code, props.institution_type_code,
        props.line_name, props.operator,
      ]);
      if (seen.has(key)) return;
      seen.add(key);
      const mask = js.classifySectionMask(props);
      classificationCases.push({
        country,
        props,
        classCode: js.sectionRailwayClassCode(props),
        institutionCode: js.sectionInstitutionTypeCode(props),
        lineName: js.sectionLineNameOf(props),
        operator: js.sectionOperatorOf(props),
        mask,
        exclusiveBucket: js.exclusiveTrackBucket(mask),
        filterCategory: js.filterCategoryForMask(mask),
      });
    };
    for (const f of sections[country].features) consider(f.properties || {});
    for (const props of ADVERSARIAL_SECTION_PROPS) consider(props);
  }

  // markerCategoryForStation reads the SAME attributes off a station feature
  // (both schemas repeat the line's institution/class/operator on every
  // station) and answers null when neither code is present.
  const stationCategories = [];
  for (const country of COUNTRIES) {
    js.setCountry(country);
    const seen = new Set();
    const record = (props) => {
      const key = JSON.stringify([
        props.N02_001, props.N02_002, props.N02_003, props.N02_004,
        props.railway_class_code, props.institution_type_code,
        props.line_name, props.operator,
      ]);
      if (seen.has(key)) return;
      seen.add(key);
      stationCategories.push({
        country,
        props,
        category: js.markerCategoryForStation({ properties: props }),
      });
    };
    for (const f of stations[country].features) {
      const p = f.properties || {};
      record({
        N02_001: p.N02_001,
        N02_002: p.N02_002,
        N02_003: p.N02_003,
        N02_004: p.N02_004,
        railway_class_code: p.railway_class_code,
        institution_type_code: p.institution_type_code,
        line_name: p.line_name,
        operator: p.operator,
      });
    }
    // The two null gates and one property-less feature, which no real
    // station exercises.
    record({});
    record({ N02_003: "線名だけ" });
    stationCategories.push({
      country,
      props: null,
      category: js.markerCategoryForStation({}),
    });
  }

  // ── 2. the edge index ──────────────────────────────────────────────────
  // The whole section table per country, not a sample: this is where the
  // denominators come from, where first-wins line naming is decided, where a
  // line is resolved to its majority-km operator, and where the two 奥羽線
  // mini-Shinkansen corridors are traced by Dijkstra and moved into 新幹線.
  const indexes = [];
  for (const country of COUNTRIES) {
    js.setCountry(country);
    js.resetIndex();
    js.setSections(sections[country]);
    await js.buildStatsEdgeIndexSliced();
    const idx = js.currentIndex();

    const stride = Math.max(1, Math.floor(idx.km.length / 400)) + 1;
    const sampledEdges = [];
    for (let i = 0; i < idx.km.length; i += stride)
      sampledEdges.push({
        index: i,
        km: idx.km[i],
        mask: idx.mask[i],
        line: idx.lineArr[i],
        lineMask: idx.lineMaskArr[i],
      });

    // Edge KEYS matter as much as the values: they are what a ridden route's
    // vertices are looked up by, so a port that spells one differently
    // matches nothing at all. Sampled from the map in insertion order, which
    // is also the order the indices were assigned in.
    const sampledKeys = [];
    let n = 0;
    for (const [key, edgeIndex] of idx.map) {
      if (n++ % stride === 0) sampledKeys.push({ key, index: edgeIndex });
    }

    indexes.push({
      country,
      sectionCount: sections[country].features.length,
      edgeCount: idx.km.length,
      totalKm: idx.totals.all,
      totalsByMask: maskMapToObject(idx.totals.byMask),
      lineTotByCat: lineTableRows(idx.lineTotByCat),
      lineOperator: [...idx.lineOperator.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([line, operator]) => ({ line, operator })),
      sampledEdges,
      sampledKeys,
    });
  }

  // ── 3. rides, aggregation, sections, view ──────────────────────────────
  const rides = {
    jp: japanRides(sections.jp, matched),
    tw: taiwanRides(sections.tw, matched),
    mo: macaoRides(sections.mo),
  };

  const trainCases = [];
  const aggregates = [];
  const tops = [];
  const views = [];
  const filters = [];

  for (const country of RIDE_COUNTRIES) {
    js.setCountry(country);
    js.resetIndex();
    js.setSections(sections[country]);
    await js.buildStatsEdgeIndexSliced();
    const idx = js.currentIndex();

    const group = rides[country];
    js.setInjectedFeatures(new Map(group.trains.map((r) => [r.id, r.features])));

    const trains = group.trains.map((r) => ({ id: r.id, ...r.train }));
    const entries = trains.map((train) => js.collectTrainStatsEntry(train, idx));

    group.trains.forEach((ride, i) => {
      trainCases.push({
        country,
        id: ride.id,
        why: ride.why,
        // The train this ride belongs to. serviceGroupStats pairs trains with
        // entries BY INDEX, and the daily split filters on the date, so a
        // parity test that rebuilt the entries without these would be pairing
        // the right km with the wrong tier.
        trainType: ride.train.train_type ?? null,
        date: ride.train.date ?? null,
        stops: (ride.train.stops || []).map((stop) => ({
          arrival: stop.arrival ?? null,
          departure: stop.departure ?? null,
          stop_type: stop.stop_type ?? null,
          ride_segment: stop.ride_segment === undefined ? null : stop.ride_segment,
        })),
        features: ride.features.map(serializeFeature),
        entry: serializeEntry(entries[i]),
      });
    });

    for (const scenario of group.scenarios) {
      const picked = scenario.trainIndexes.map((i) => entries[i]);
      const pickedTrains = scenario.trainIndexes.map((i) => trains[i]);
      aggregates.push({
        country,
        label: scenario.label,
        why: scenario.why,
        trainIndexes: scenario.trainIndexes,
        // The per-train km these entries carry, summed the accumulating way.
        // It is here precisely so the contrast with riddenAll is on the page:
        // one repeats, the other does not.
        summedTrainKm: picked.reduce((sum, e) => sum + e.km, 0),
        aggregate: serializeAggregate(js.aggregateMileageStats(idx, picked)),
        services: js.serviceGroupStats(pickedTrains, picked),
        sumRideMinutes: js.sumRideMinutes(pickedTrains),
      });
      tops.push({
        country,
        label: scenario.label,
        trainIndexes: scenario.trainIndexes,
        top: serializeTop(js.topRiddenSegments(picked)),
      });
    }

    for (const date of [null, "__all__", group.dailyDate]) {
      js.setSelectedDate(date);
      const view = await js.buildMileageStatsView(idx, trains, entries, null);
      views.push({
        country,
        selectedDate: date,
        categories: view.categories.map((c) => c.mask),
        overall: {
          ...serializeAggregate(view.overall),
          rideMinutes: view.overall.rideMinutes,
          services: view.overall.services,
          // topSegments over the same entries is recorded in full under
          // `tops` (scenario "everything" / "tw-everything" / "mo-repeat"),
          // so the view only has to prove it wired the call up.
          topRowCount: view.overall.topSegments.all.length,
        },
        daily:
          view.daily === null
            ? null
            : {
                date: view.daily.date,
                trainCount: view.daily.trainCount,
                stats: {
                  ...serializeAggregate(view.daily.stats),
                  rideMinutes: view.daily.stats.rideMinutes,
                  services: view.daily.stats.services,
                },
              },
      });
    }
    js.setSelectedDate(null);

    // The ridden-line display filter runs off the same edge index, but
    // collapses a mask to ONE checkbox rather than to a coverage row.
    for (const ride of group.trains)
      for (const feature of ride.features)
        filters.push({
          country,
          rideId: ride.id,
          feature: serializeFeature(feature),
          category: js.riddenFeatureCategory(feature),
          visibleWithAllOn: js.riddenFeatureVisible(feature),
        });
    for (const degenerate of [
      { type: "Feature", properties: {}, geometry: null },
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [139, 35] } },
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
    ])
      filters.push({
        country,
        rideId: "degenerate",
        feature: serializeFeature(degenerate),
        category: js.riddenFeatureCategory(degenerate),
        visibleWithAllOn: js.riddenFeatureVisible(degenerate),
      });
  }

  // ── 4. containment, on its own ─────────────────────────────────────────
  const subsets = SUBSET_CASES.map((c) => ({ ...c, isSubset: js.isEdgeSubset(c.inner, c.outer) }));
  const containment = CONTAINMENT_CASES.map((c) => ({
    ...c,
    kept: js
      .dropContainedSections(c.rows.map((r) => ({ ...r })))
      .map((r) => ({ from: r.from, to: r.to })),
  }));

  // ── 5. ride time and service tiers, over the real stores ───────────────
  const rideTimes = [];
  const serviceSums = [];
  for (const country of ["jp", "tw"]) {
    js.setCountry(country);
    const store = readJson(dataFile("train-store", country));
    const trains = (store.trains || []).map((t) => ({
      id: t.id,
      train_type: t.train_type,
      stops: (t.stops || []).map((s) => ({
        arrival: s.arrival ?? null,
        departure: s.departure ?? null,
        stop_type: s.stop_type ?? null,
        ride_segment: s.ride_segment === undefined ? null : s.ride_segment,
      })),
    }));
    for (const train of trains)
      rideTimes.push({
        country,
        id: train.id,
        trainType: train.train_type ?? null,
        stops: train.stops,
        rideMinutes: js.trainRideMinutes(train),
        serviceGroup: js.serviceGroupOfTrain(train),
      });
    serviceSums.push({
      country,
      trainCount: trains.length,
      sumRideMinutes: js.sumRideMinutes(trains),
    });
  }

  const adversarialTrains = ADVERSARIAL_TRAINS.map((c, i) => {
    js.setCountry(c.country);
    const train = { id: `adversarial_${i}`, train_type: c.trainType, stops: c.stops };
    return {
      ...c,
      stops: c.stops.map((s) => ({
        arrival: s.arrival ?? null,
        departure: s.departure ?? null,
        stop_type: s.stop_type ?? null,
        ride_segment: s.ride_segment === undefined ? null : s.ride_segment,
      })),
      rideMinutes: js.trainRideMinutes(train),
      serviceGroup: js.serviceGroupOfTrain(train),
    };
  });
  js.setCountry("jp");

  return {
    describes:
      "app-stats.js §23a — section classification, the N02 edge index, and " +
      "mileage aggregation (the per-category breakdown, ride time, service " +
      "tiers and 最常乘坐區間). Everything app-stats-render.js does with the " +
      "result — formatting, Intl collation, DOM — is out of scope.",
    contract:
      "Coverage is a DEDUPED UNION over N02 edge ids, not an accumulated " +
      "sum: aggregateMileageStats folds every train's edges into ONE Set and " +
      "sums idx.km over that Set, so riding a section twice adds it to the " +
      "total once. Each aggregate case carries summedTrainKm beside it — the " +
      "accumulating answer — so the two can never be confused for each " +
      "other. Connector spans (the off-network bridges the solver leaves " +
      "between matched edges) dedupe separately by span key, are counted " +
      "nationally, and the mask-0 remainder is reported as unmatchedKm. " +
      "The ITERATION ORDER of that Set is load-bearing: it is JavaScript " +
      "insertion order, and a sum of hundreds of thousands of doubles taken " +
      "in another order is another double, which is why `everything` and " +
      "`everything-reversed` are both recorded. ride_segment must be " +
      "EXACTLY true — the feature filter is `!== true`, so 1 and \"true\" " +
      "are unridden. Per-train km is the opposite convention on purpose: it " +
      "accumulates repeats, because it pairs with ride time and ride count " +
      "in the service-tier rows.",
    cases: classificationCases,
    stationCategories,
    indexes,
    geometries: geometryPool,
    trains: trainCases,
    aggregates,
    tops,
    views,
    subsets,
    containment,
    rideTimes,
    adversarialTrains,
    serviceSums,
    filters,
    rideSources: Object.fromEntries(RIDE_COUNTRIES.map((c) => [c, rides[c].sourceLines])),
  };
}

const RESULT = await buildFixture();

export function build() {
  return RESULT;
}
