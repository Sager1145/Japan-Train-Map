// =========================================================================
//  route-feature.json — canonicalizeRouteFeature, frozen for the Swift port
//
//  `rail-network.js` canonicalizeRouteFeature is the function that decides
//  the PIXELS of a ride. The route solver has already decided WHICH railway a
//  train used; this one projects the solved endpoints onto the already-built
//  complete display line and returns an exact slice of that same LineString,
//  which is what stops the ridden layer and the all-railways layer from
//  drifting apart at a station or grooming their micro-kinks differently.
//
//  Two things make it awkward to freeze, and both are handled here rather
//  than papered over:
//
//  1. Its first argument is a whole NETWORK, not a value. The network is the
//     output of buildNetworkFromCompactPackage, whose display geometry comes
//     out of displayPartsForLine — anchoring, branch cutting, fold trimming
//     and kink smoothing, none of which is ported yet. So the fixture carries
//     the network's drawn geometry as data. That is most of its weight and
//     there is no way around it: a slice of a line the port cannot build is
//     not a slice of anything.
//
//  2. The function reads the network EXHAUSTIVELY — `lineById.values()` is
//     scanned when the hints select nothing, and again when the hinted line
//     turns out not to reach the platform. Carrying all 652 Japanese lines
//     would be ~10 MB of coordinates, so each group of cases gets a network
//     SUBSET. Every case is then run twice, against the subset and against
//     the complete country network, and only emitted when the two agree
//     exactly — so the fixture is small without being a different question
//     from the one production asks. `verifiedAgainstFullNetwork` records that
//     on every case.
//
//  Inputs are real. The Japanese and Taiwanese hops are the solver's own
//  output (`app/data/matched-routes.json`), replayed exactly as
//  `getMatchedRouteFeatures` replays them, `continueFrom` and all. The other
//  three countries ship no checked-in solver output, so their hops are built
//  from the packages themselves: the raw path is `decodeIntervals` geometry
//  and the endpoints are the station anchors, which is the shape a solved hop
//  has. No coordinate anywhere in this file was invented.
//
//  The rule of the port applies here as everywhere: the expected value is
//  whatever the JavaScript returns today.
// =========================================================================

import fs from "node:fs";
import path from "node:path";

export const name = "route-feature.json";

// ── network subsetting ──────────────────────────────────────────────────

// A line is kept in a subset when it could possibly be chosen. Two ways in:
// it carries one of the hinted names/operators (a same-named railway on the
// far side of the country is a real candidate — the 1.5 km endpoint gate
// exists to refuse it, and refusing it is behaviour worth reproducing), or it
// passes near one of the raw endpoints. The second is what the
// "hinted line does not reach the platform, look anywhere" fallback needs:
// that fallback only ACCEPTS a replacement within 25 m of both endpoints, so
// a line outside this halo can change which line wins the scan but never
// which line is returned. The full-network re-check below is what actually
// proves that, case by case.
// ~500 m, twenty times the 25 m the fallback will actually accept.
const ENDPOINT_HALO_DEGREES = 0.005;

/** `routeHintValues`, replicated — for CHOOSING a subset, never for answers. */
function hintValues(properties, arrayFields, objectFields) {
  const values = new Set();
  for (const field of arrayFields) {
    const rows = properties?.[field];
    if (!Array.isArray(rows)) continue;
    for (const value of rows)
      if (value != null && value !== "") values.add(String(value));
  }
  for (const field of objectFields) {
    const rows = properties?.[field];
    if (!rows || typeof rows !== "object" || Array.isArray(rows)) continue;
    for (const value of Object.keys(rows)) if (value) values.add(value);
  }
  return values;
}

function geometryLines(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates || []];
  if (geometry?.type === "MultiLineString") return geometry.coordinates || [];
  return [];
}

function subsetLineIds(network, feature) {
  const properties = feature.properties || {};
  const names = hintValues(
    properties,
    ["required_line_names", "preferred_line_names"],
    ["used_line_names"],
  );
  const operators = hintValues(
    properties,
    ["required_operator_names", "preferred_operator_names"],
    ["used_operator_names"],
  );
  const ids = new Set();
  for (const [id, line] of network.lineById)
    if (names.has(line.name)) ids.add(id);
  if (!ids.size)
    for (const [id, line] of network.lineById)
      if (operators.has(line.operator)) ids.add(id);
  // No hint resolves to anything: the function falls back to the WHOLE
  // network, so the subset has to be the whole network too.
  if (!ids.size) for (const id of network.lineById.keys()) ids.add(id);

  const anchors = [];
  for (const coordinates of geometryLines(feature.geometry)) {
    if (coordinates.length < 2) continue;
    anchors.push(coordinates[0], coordinates[coordinates.length - 1]);
  }
  for (const [id, line] of network.lineById) {
    if (ids.has(id)) continue;
    let near = false;
    for (const part of line.parts) {
      for (const [lon, lat] of part) {
        for (const [ax, ay] of anchors)
          if (
            Math.abs(lon - ax) <= ENDPOINT_HALO_DEGREES &&
            Math.abs(lat - ay) <= ENDPOINT_HALO_DEGREES
          ) {
            near = true;
            break;
          }
        if (near) break;
      }
      if (near) break;
    }
    if (near) ids.add(id);
  }
  return ids;
}

/**
 * A network holding a subset of one country's lines — the SAME line objects,
 * never copies, so the display geometry is the shipped app's own.
 *
 * The two indexes are rebuilt by walking `lineById` in its original order, so
 * a name shared by several strokes (東鐵綫 is three of them) lists them in the
 * package's order here as well. That order is load-bearing: `bestFitFor`
 * keeps the first candidate on a tie, so reordering the buckets can change
 * which railway a ride is drawn on.
 */
function restrictNetwork(network, ids) {
  const lineById = new Map();
  const linesByName = new Map();
  const linesByOperator = new Map();
  const push = (index, key, value) => {
    if (!key) return;
    let rows = index.get(key);
    if (!rows) index.set(key, (rows = []));
    rows.push(value);
  };
  for (const [id, line] of network.lineById) {
    if (!ids.has(id)) continue;
    lineById.set(id, line);
    push(linesByName, line.name, line);
    push(linesByOperator, line.operator, line);
  }
  return {
    lineById,
    linesByName,
    linesByOperator,
    // Fresh per call. The cache is a memo keyed on `lineId#part|lon,lat` with
    // the coordinate at 7 decimals, so it cannot change an answer unless two
    // points a centimetre apart share a key — but starting empty makes every
    // case in this fixture independent of the ones before it, which is what
    // lets the Swift side run them in any order.
    routeProjectionCache: new Map(),
  };
}

// ── hops built from a package ───────────────────────────────────────────

/**
 * The raw path a solver would hand in for a ride from station `from` to
 * station `to` along one line: that line's own decoded interval geometry,
 * walked forward (through the seam on a loop line) with the shared vertex
 * emitted once. The endpoints are therefore the station anchors, which is
 * exactly what the solver's endpoints are.
 *
 * This is NOT the display geometry — `decodeIntervals` runs before the
 * anchoring, fold trimming and kink smoothing that `displayPartsForLine`
 * applies — so the projection distances these cases exercise are real ones.
 */
function packageHop(RailNetwork, compactLine, from, to) {
  const intervals = RailNetwork.decodeIntervals(compactLine);
  if (!intervals.length) return null;
  // Interval k runs from station k to station k+1, so a ride from station
  // `from` to station `to` is intervals from … to-1, counted forward and
  // wrapping through the seam on a loop line. Counting the STEPS rather than
  // watching for the destination index is what makes the last interval of an
  // open line work: there, `to` equals the interval count and no index ever
  // equals it.
  const count = intervals.length;
  const steps = (((to - from) % count) + count) % count || count;
  const coordinates = [];
  let index = from;
  for (let step = 0; step < steps; step += 1) {
    const interval = intervals[index];
    if (!interval || !interval.length) return null;
    for (const point of interval) {
      const last = coordinates[coordinates.length - 1];
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      coordinates.push([point[0], point[1]]);
    }
    index = (index + 1) % count;
  }
  if (coordinates.length < 2) return null;
  return coordinates;
}

/** A feature in the shape the solver emits: hints as {name: coordinateCount}. */
function hopFeature(compactLine, coordinates, extraProperties) {
  return {
    type: "Feature",
    properties: {
      used_line_names: { [compactLine.name]: coordinates.length },
      used_operator_names: { [compactLine.operator]: coordinates.length },
      ...extraProperties,
    },
    geometry: { type: "LineString", coordinates },
  };
}

// ── serialisation ───────────────────────────────────────────────────────

// Coordinates go out as `"lon lat;lon lat;…"` rather than as nested arrays.
//
// This is a size decision and it is a large one: the harness serialises with
// `JSON.stringify(…, null, 2)`, and a nested `[lon, lat]` seven levels deep
// costs about 94 bytes of indentation and punctuation per point. The display
// geometry these cases slice out of is 100,000 points — every vertex of every
// line the function may scan — so the readable form is a 9.4 MB fixture, and
// the alternative to shrinking it is dropping every Japanese trunk line, which
// is where the interesting topology lives.
//
// It is exact. JavaScript prints a Number as the SHORTEST decimal that reads
// back as the same double, and Swift's `Double(String)` is correctly rounded,
// so the pair round-trips bit for bit — asserted below on every coordinate
// written rather than assumed, because a fixture that quietly rounds is worse
// than no fixture. `Object.is` rather than `===` so a negative zero, which
// prints as "0" and would read back as +0, fails here instead of in Swift.
function encodePath(coordinates) {
  const parts = new Array(coordinates.length);
  for (let index = 0; index < coordinates.length; index += 1) {
    const [lon, lat] = coordinates[index];
    const text = `${lon} ${lat}`;
    const [readLon, readLat] = text.split(" ").map(Number);
    if (!Object.is(readLon, lon) || !Object.is(readLat, lat))
      throw new Error(`route-feature: ${text} does not round-trip`);
    parts[index] = text;
  }
  return parts.join(";");
}

// `used_line_names` is a JSON OBJECT in the solver's output and the function
// reads it with `Object.keys`, so its iteration order decides the order the
// candidate lines are collected in — and therefore which line wins a tie.
// Swift's JSONDecoder hands back an unordered Dictionary, so the key sequence
// is frozen here as an array, produced by `Object.keys` itself.
function hintArrays(properties) {
  const keysOf = (field) => {
    const rows = properties?.[field];
    if (!rows || typeof rows !== "object" || Array.isArray(rows)) return [];
    return Object.keys(rows);
  };
  const arrayOf = (field) => {
    const rows = properties?.[field];
    return Array.isArray(rows) ? [...rows] : [];
  };
  return {
    requiredLineNames: arrayOf("required_line_names"),
    preferredLineNames: arrayOf("preferred_line_names"),
    usedLineNames: keysOf("used_line_names"),
    requiredOperatorNames: arrayOf("required_operator_names"),
    preferredOperatorNames: arrayOf("preferred_operator_names"),
    usedOperatorNames: keysOf("used_operator_names"),
  };
}

function serializeFeature(feature) {
  const geometry = feature.geometry || null;
  return {
    geometryType: geometry ? geometry.type : null,
    // Always a list of lines, LineString included, so the Swift model has one
    // shape to decode. `geometryType` is what decides the OUTPUT type.
    lines: geometryLines(geometry).map(encodePath),
    hints: hintArrays(feature.properties || {}),
  };
}

function serializeResult(result) {
  if (!result) return null;
  const coordinates = geometryLines(result.geometry);
  return {
    geometryType: result.geometry.type,
    lines: coordinates.map(encodePath),
    displayGeometrySource: result.properties.display_geometry_source,
    displayLineIds: result.properties.display_line_ids,
  };
}

// ── the cases ───────────────────────────────────────────────────────────

export function build({ RailNetwork, railPackage, APP_DIR }) {
  const networks = new Map(); // country → full network
  const networkFor = (country) => {
    if (!networks.has(country))
      networks.set(
        country,
        RailNetwork.buildNetworkFromCompactPackage(railPackage(country)),
      );
    return networks.get(country);
  };
  const lineOf = (country, id) =>
    railPackage(country).lines.find((line) => line.id === id);

  const requests = [];
  const add = (request) => requests.push(request);

  // ── the solver's own output, replayed ─────────────────────────────────
  // These are the very features the browser feeds the function. Hops of one
  // train are chained through `continueFrom` exactly as getMatchedRouteFeatures
  // chains them, because that argument only means anything in sequence.
  //
  // Measured while building this: `continueFrom` never changes an answer. Not
  // here, not in any of the 220 checked-in solver hops, and not in any
  // station-to-station hop of any line of any of the five packages. The reason
  // is structural — `snapEndpoint` pins each hop's drawn end to the solver's
  // station node and the next hop's raw start IS that node, so the seam term
  // adds the same amount to every candidate. The chained cases are kept
  // anyway: they are what the browser actually does, and a port that mis-signs
  // the term would have to disagree with them somewhere.
  const matched = JSON.parse(
    fs.readFileSync(path.join(APP_DIR, "data", "matched-routes.json"), "utf8"),
  );
  const byTrain = new Map();
  for (const feature of matched.features) {
    const trainId = feature.properties.train_id;
    if (!byTrain.has(trainId)) byTrain.set(trainId, []);
    byTrain.get(trainId).push(feature);
  }
  const solverChain = (trainId, country, group, why, pick) => {
    const network = networkFor(country);
    const hops = byTrain.get(trainId) || [];
    let previousEnd = null;
    hops.forEach((feature, index) => {
      const drawn = RailNetwork.canonicalizeRouteFeature(network, feature, {
        continueFrom: previousEnd,
      });
      const geometry = (drawn || feature).geometry;
      const lines = geometryLines(geometry);
      const last = lines[lines.length - 1];
      const nextEnd = last && last.length ? last[last.length - 1] : null;
      if (!pick || pick(index, feature))
        add({
          name: `${country}/${group}/${index}-${feature.properties.from}→${feature.properties.to}`,
          why,
          country,
          group,
          feature,
          options: previousEnd ? { continueFrom: previousEnd } : null,
        });
      previousEnd = nextEnd;
    });
  };

  solverChain(
    "azusa_033",
    "jp",
    "chuo",
    "Real solver output, chained: あずさ33号 up the 中央線 and onto the 篠ノ井線 " +
      "at 塩尻. The last hop changes railway mid-train — the junction case " +
      "`continueFrom` exists for, and the one place a port that followed the " +
      "previous hop blindly rather than using it as a tie-break would show.",
    (index) => index >= 3, // the first three hops carry the fixture's largest slices
  );
  solverChain(
    "odr_001",
    "jp",
    "tokaido",
    "Real solver output through 東京 and 品川 — the densest junction in the " +
      "packages, where a hop's endpoints sit on several parts at once and " +
      "the hint carries four line names for one leg.",
    (index) => index <= 1,
  );
  solverChain(
    "20260802_01_taoyuan_airport_mrt_express_t2_taipei",
    "tw",
    "taoyuan-mrt",
    "Real solver output on the 桃園機場捷運 — a hop whose first station is " +
      "the line's own terminus, so one endpoint projects past the end of " +
      "the stroke and is clamped to it.",
    (index) => index <= 2,
  );
  solverChain(
    "20260813_01_star_of_taiwan_round_island_loop",
    "tw",
    "round-island",
    "Real solver output on the 縱貫線 through 臺北 — several railways share " +
      "the corridor, and the hinted one has to win against neighbours a few " +
      "metres away.",
    (index) => index >= 40 && index <= 43,
  );

  // ── package-built hops, for the topologies the checked-in solver output
  //    does not reach ─────────────────────────────────────────────────────

  const hop = (country, lineId, from, to, group, why, extra, options) => {
    const compactLine = lineOf(country, lineId);
    if (!compactLine) throw new Error(`${country}: no line ${lineId}`);
    const coordinates = packageHop(RailNetwork, compactLine, from, to);
    if (!coordinates) throw new Error(`${country}/${lineId}: empty hop`);
    const feature = hopFeature(compactLine, coordinates, extra);
    const stationName = (index) => compactLine.stations[index][1];
    add({
      name: `${country}/${group}/${lineId}/${stationName(from)}→${stationName(to)}`,
      why,
      country,
      group,
      feature,
      options: options || null,
    });
    return feature;
  };

  // Macao is the whole network in 168 vertices, which makes it the one place
  // the "no usable hint, scan everything" path can be frozen honestly.
  hop(
    "mo",
    "mo-mlm-taipa",
    0,
    3,
    "whole-network",
    "The complete Macao network — three lines, and the two branches join the " +
      "trunk at stations rather than crossing it. A hop along the trunk.",
  );
  hop(
    "mo",
    "mo-mlm-hengqin",
    0,
    1,
    "whole-network",
    "橫琴線 leaves 氹仔線 at 蓮花: both railways reach that platform, so the " +
      "branch's own first hop is the case where proximity alone cannot say " +
      "which stroke a ride belongs on.",
  );
  hop(
    "mo",
    "mo-mlm-spv",
    0,
    1,
    "whole-network",
    "石排灣線 leaves 氹仔線 at 協和醫院 — the second junction, and the branch " +
      "runs back alongside the trunk for its first hundred metres.",
  );

  // ── the same Macao hop with its hints taken away and put back wrong ────
  const trunkHop = packageHop(RailNetwork, lineOf("mo", "mo-mlm-taipa"), 4, 8);
  add({
    name: "mo/whole-network/no-hints",
    why:
      "A feature with no line or operator hint at all. `candidates` comes back " +
      "empty and the function falls back to scanning every line in the " +
      "network, which is the branch a fixture built only from solver output " +
      "would never reach.",
    country: "mo",
    group: "whole-network",
    feature: {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: trunkHop },
    },
    options: null,
  });
  add({
    name: "mo/whole-network/operator-fallback",
    why:
      "The line name names nothing in this package, so the operator index has " +
      "to answer instead — and then the operator filter runs over what it " +
      "returned, which is the only path that exercises both halves of the " +
      "candidate rule.",
    country: "mo",
    group: "whole-network",
    feature: {
      type: "Feature",
      properties: {
        required_line_names: ["氹仔綫"], // the正字 spelling; the package uses 線
        required_operator_names: ["澳門輕軌"],
      },
      geometry: { type: "LineString", coordinates: trunkHop },
    },
    options: null,
  });
  add({
    name: "mo/whole-network/required-name-array",
    why:
      "`required_line_names` is an ARRAY field and `used_line_names` an " +
      "object; the two are read by the same helper and collected into one set " +
      "in that order. Real solver output only ever carries the object form.",
    country: "mo",
    group: "whole-network",
    feature: {
      type: "Feature",
      properties: {
        required_line_names: ["氹仔線"],
        preferred_line_names: ["", null, "石排灣線"],
        used_line_names: { 氹仔線: 12 },
      },
      geometry: { type: "LineString", coordinates: trunkHop },
    },
    options: null,
  });
  add({
    name: "mo/whole-network/multi-line-string",
    why:
      "A MultiLineString in, a MultiLineString out — and the sub-line with a " +
      "single vertex is dropped before anything is projected, so the output " +
      "carries fewer strokes than the input did.",
    country: "mo",
    group: "whole-network",
    feature: {
      type: "Feature",
      properties: {
        used_line_names: { 氹仔線: trunkHop.length },
        used_operator_names: { 澳門輕軌: trunkHop.length },
        geometry_role: "single_path_with_gaps",
      },
      geometry: {
        type: "MultiLineString",
        coordinates: [
          trunkHop.slice(0, Math.ceil(trunkHop.length / 2)),
          [trunkHop[trunkHop.length - 1]],
          trunkHop.slice(Math.ceil(trunkHop.length / 2)),
        ],
      },
    },
    options: null,
  });
  add({
    name: "mo/whole-network/single-vertex",
    why:
      "One coordinate is not a path: the geometry filter drops it, `rawLines` " +
      "is empty and the function returns null before it touches the network.",
    country: "mo",
    group: "whole-network",
    feature: {
      type: "Feature",
      properties: { used_line_names: { 氹仔線: 1 } },
      geometry: { type: "LineString", coordinates: [trunkHop[0]] },
    },
    options: null,
  });

  // ── the hint against the rail ─────────────────────────────────────────
  // Both halves of the "hinted line does not reach the platform" rule, on
  // whole real networks. Naming a railway the train did not ride is not a
  // contrived input: it is what the solver produces whenever the package draws
  // a railway under another line's name (the 品鶴線 is 総武線-3 since the 東京
  // rebuild) or a stop row names a station whose platform is on other track
  // (成田エクスプレス lists 有楽町, which has none on the 東京トンネル).
  {
    const compactLine = lineOf("mo", "mo-mlm-taipa");
    const coordinates = packageHop(RailNetwork, compactLine, 0, 1);
    add({
      name: "mo/whole-network/hint-loses-to-the-rail",
      why:
        "A 氹仔線 hop hinted 石排灣線. The named railway is nowhere near " +
        "either platform, the wider look finds a line that reaches both " +
        "within 25 m, and the drawn ride follows the RAIL rather than the " +
        "name — without which the endpoint snap swings a right-angle chord " +
        "into the station.",
      country: "mo",
      group: "whole-network",
      feature: {
        type: "Feature",
        properties: {
          used_line_names: { 石排灣線: coordinates.length },
          used_operator_names: { 澳門輕軌: coordinates.length },
        },
        geometry: { type: "LineString", coordinates },
      },
      options: null,
    });
  }
  {
    const compactLine = lineOf("hk", "hk-mtr-ael");
    const coordinates = packageHop(RailNetwork, compactLine, 0, 1);
    add({
      name: "hk/whole-network/hint-beats-the-rail",
      why:
        "The other side of the same threshold. A 機場快綫 香港→九龍 hop " +
        "hinted 東涌綫: the two railways run the same tunnel, and 東涌綫's " +
        "stroke is 12.6 m and 5.1 m from the two 機場快綫 platforms — inside " +
        "the 60 m the rule calls a platform's width. So the wider look never " +
        "RUNS, and the ride is drawn on the railway the hint names even " +
        "though another stroke fits it exactly. A port that looks wider " +
        "whenever the fit is imperfect moves this ride onto 機場快綫.",
      country: "hk",
      group: "whole-network",
      feature: {
        type: "Feature",
        properties: {
          used_line_names: { 東涌綫: coordinates.length },
          used_operator_names: { MTR: coordinates.length },
        },
        geometry: { type: "LineString", coordinates },
      },
      options: null,
    });
  }

  // ── the operator filter, on the one hop in Japan where it decides ─────
  // 七尾 to 和倉温泉 is JR West's metals with のと鉄道's trains on them, and
  // the package draws BOTH railways over it. The name 七尾線 therefore
  // resolves to two strokes that fit the same ride equally, and the only
  // thing that separates them is which company the solver saw.
  {
    const compactLine = lineOf("jp", "jp-西日本旅客鉄道-七尾線");
    const intervalIndex = compactLine.stations.length - 2; // 七尾 → 和倉温泉
    const coordinates = packageHop(
      RailNetwork,
      compactLine,
      intervalIndex,
      intervalIndex + 1,
    );
    const geometry = { type: "LineString", coordinates };
    add({
      name: "jp/nanao/七尾→和倉温泉/operator-西日本旅客鉄道",
      why:
        "Name AND operator hinted: the operator filter cuts the two 七尾線 " +
        "strokes down to JR West's, and the ride is drawn on it.",
      country: "jp",
      group: "nanao",
      feature: {
        type: "Feature",
        properties: {
          used_line_names: { 七尾線: coordinates.length },
          used_operator_names: { 西日本旅客鉄道: coordinates.length },
        },
        geometry,
      },
      options: null,
    });
    add({
      name: "jp/nanao/七尾→和倉温泉/no-operator",
      why:
        "The SAME geometry with the operator hint removed. The filter is " +
        "skipped, both 七尾線 strokes stay in the running, and geometry " +
        "alone puts the ride on のと鉄道's. A port that drops the operator " +
        "filter draws this pair identically and fails.",
      country: "jp",
      group: "nanao",
      feature: {
        type: "Feature",
        properties: { used_line_names: { 七尾線: coordinates.length } },
        geometry,
      },
      options: null,
    });
    add({
      name: "jp/nanao/七尾→和倉温泉/operator-のと鉄道",
      why:
        "And the third corner: the operator hint naming the other company. " +
        "The filter keeps のと鉄道's stroke, which is also what geometry " +
        "chose — so this case pins that the filter selects rather than " +
        "merely reorders.",
      country: "jp",
      group: "nanao",
      feature: {
        type: "Feature",
        properties: {
          used_line_names: { 七尾線: coordinates.length },
          used_operator_names: { のと鉄道: coordinates.length },
        },
        geometry,
      },
      options: null,
    });
  }

  // A real Hong Kong hop offered to the COMPLETE Macao network. Nothing is
  // within 1.5 km of either endpoint, so the endpoint gate refuses the whole
  // feature — the gate whose comment says it exists to refuse "an unrelated
  // same-named railway elsewhere in the country". 60 km of the South China
  // Sea is the cleanest way to state that without inventing a coordinate.
  {
    const hkLine = lineOf("hk", "hk-mtr-tcl");
    const coordinates = packageHop(RailNetwork, hkLine, 0, 3);
    add({
      name: "mo/whole-network/out-of-country",
      why:
        "A real 東涌綫 hop handed to the complete Macao network. Every line " +
        "is 60 km away, the 1.5 km endpoint gate refuses it, and the caller " +
        "keeps the solver's own path — the null this function is allowed to " +
        "return.",
      country: "mo",
      group: "whole-network",
      feature: {
        type: "Feature",
        properties: { used_operator_names: { 澳門輕軌: coordinates.length } },
        geometry: { type: "LineString", coordinates },
      },
      options: null,
    });
  }

  // Hong Kong: 28 lines in 3,740 vertices, so the whole network again — and
  // it carries both of the loop lines and the two tram directions.
  hop(
    "hk",
    "hk-mtr-eal-low",
    2,
    6,
    "whole-network",
    "東鐵綫 is THREE lines in this package (羅湖, 落馬洲 and the 何東樓 車廠 " +
      "branch) and all three answer to the name. The candidate list therefore " +
      "arrives with three strokes and the fit has to separate them.",
  );
  hop(
    "hk",
    "hk-mtr-lr-705",
    11,
    3,
    "whole-network",
    "輕鐵705綫 is a closed loop drawn as ONE part, and this hop runs through " +
      "the seam: the wrapping branch of canonicalLineSlice emits the junction " +
      "once and then compares the forward and backward arcs against the raw " +
      "path's own length to decide which way round the train went.",
  );
  hop(
    "hk",
    "hk-mtr-lr-706",
    2,
    9,
    "whole-network",
    "The other 天水圍 loop, taken the way the station order runs — the " +
      "same wrapping code with the wrap not taken.",
  );
  hop(
    "hk",
    "hk-tram-east",
    10,
    20,
    "whole-network",
    "香港電車 is modelled as four physical tracks, and the east and west " +
      "directions are separate railways a few metres apart down the middle of " +
      "the same street. Nothing but the hint separates them.",
  );
  {
    const compactLine = lineOf("hk", "hk-tram-west");
    const forward = packageHop(RailNetwork, compactLine, 22, 30);
    add({
      name: "hk/whole-network/hk-tram-west/reversed",
      why:
        "The westbound track, ridden AGAINST the line's own station order: " +
        "start.measure > end.measure, so the slice is cut forward along the " +
        "stroke and then reversed. Half of all rides are this one.",
      country: "hk",
      group: "whole-network",
      feature: hopFeature(compactLine, [...forward].reverse()),
      options: null,
    });
  }
  hop(
    "hk",
    "hk-mtr-tml",
    0,
    12,
    "whole-network",
    "屯馬綫 end to end through 紅磡 — the longest single-part slice Hong Kong " +
      "has, and it crosses the corridor the 東鐵綫 strokes share.",
  );

  // Taiwan: the 阿里山線 is the only multi-part line in the package, cut where
  // its switchbacks are, and it is the reason both endpoints of a hop must
  // land on the SAME part.
  hop(
    "tw",
    "tw-alsr-alishan",
    0,
    4,
    "alishan",
    "阿里山線 below the switchbacks — part 0 of a line the package draws as " +
      "two disjoint strokes.",
  );
  hop(
    "tw",
    "tw-alsr-alishan",
    15,
    16,
    "alishan",
    "神木→阿里山, the 112-vertex tail above the 折返: part 1. Both endpoints " +
      "are on the same part, so the slice is legal.",
  );
  hop(
    "tw",
    "tw-alsr-alishan",
    13,
    16,
    "alishan",
    "屏遮那→阿里山, where the two parts overlap: BOTH of them reach 阿里山, " +
      "only part 0 also reaches 屏遮那. The per-part rule is what makes that " +
      "unambiguous — the slice stays on the stroke that holds both ends " +
      "rather than starting on one part and finishing on the other.",
  );
  hop(
    "tw",
    "tw-klrt-c",
    33,
    4,
    "kaohsiung",
    "高雄環狀輕軌 through the seam — Taiwan's closed loop, and a second " +
      "package's worth of the wrapping branch.",
  );

  // Korea: 82 lines, no checked-in solver output, and the country the port
  // has the least evidence for.
  hop(
    "kr",
    "kr-gyeongbuseon",
    10,
    14,
    "gyeongbu",
    "경부선 south of 서울 — the trunk every other Korean railway is measured " +
      "against, and its corridor carries the 경부고속선 alongside it.",
  );
  hop(
    "kr",
    "kr-seoul-jihacheol-7hoseon",
    20,
    26,
    "seoul-metro",
    "서울 지하철 7호선 through the densest part of the network, where a dozen " +
      "other lines pass within the endpoint halo.",
  );
  hop(
    "kr",
    "kr-incheongukjegonghangseon",
    0,
    5,
    "incheon-airport",
    "인천국제공항선 — a different operator's line sharing track and stations " +
      "with 서울 지하철 9호선, so the operator hint is what decides.",
  );

  // Japan: the topologies the two checked-in trains do not reach.
  hop(
    "jp",
    "jp-東日本旅客鉄道-上越線",
    13,
    16,
    "joetsu",
    "水上→土樽 through the 清水 bores. 上越線's up line keeps the older " +
      "tunnel while the down line takes the 新清水 loop, and the package " +
      "carries them as a SOURCED pair (上越線-p2, direction 上り) with " +
      "separate platforms. Both fit a ride between the same two stations, so " +
      "the ride's own direction of travel decides — forward through the " +
      "line's station order is 下り — worth ALIGNMENT_MATCH_BONUS against " +
      "the fit. Ridden forward, this lands on the main line.",
  );
  {
    const compactLine = lineOf("jp", "jp-東日本旅客鉄道-上越線");
    const forward = packageHop(RailNetwork, compactLine, 13, 16);
    const backward = [...forward].reverse();
    add({
      name: "jp/joetsu/上越線/土樽→水上",
      why:
        "The same geometry ridden the other way, and the answer is a " +
        "DIFFERENT railway: 上越線-p2, the up-line bore. The 25 m bonus is " +
        "the only thing that moved, which is the whole point of the pair — " +
        "geometry alone cannot tell the two tunnels apart, and the direction " +
        "of travel can. A port that drops the bias passes every other case " +
        "in this fixture and fails this one.",
      country: "jp",
      group: "joetsu",
      feature: hopFeature(compactLine, backward),
      options: null,
    });
  }
  hop(
    "jp",
    "jp-西日本旅客鉄道-大阪環状線",
    16,
    2,
    "osaka-loop",
    "大阪環状線 through the seam — the Japanese loop, 427 vertices in one " +
      "closed part.",
  );
  hop(
    "jp",
    "jp-九州旅客鉄道-肥薩線",
    2,
    6,
    "hisatsu",
    "肥薩線 is cut in two at the 大畑 ループ reversal, where no train can turn " +
      "through: a multi-part line whose break is in open country rather than " +
      "at a branch.",
  );
  hop(
    "jp",
    "jp-九州旅客鉄道-豊肥線",
    10,
    16,
    "hohi",
    "原水→内牧 across the 立野 switchback, where 豊肥線 is drawn as two " +
      "strokes 10 km apart at their nearest points. NO part reaches both " +
      "stations, so the endpoint gate refuses the hop and the caller keeps " +
      "the solver's own path. This is the null the 'both ends on the SAME " +
      "part' rule is FOR: the alternative answer, a slice that starts on one " +
      "stroke and ends on the other, is a train drawn onto track it never " +
      "touched.",
  );

  // ── run everything twice and keep only what agrees ────────────────────

  const groups = new Map(); // `${country}/${group}` → Set of line ids
  for (const request of requests) {
    const network = networkFor(request.country);
    const key = `${request.country}/${request.group}`;
    if (!groups.has(key)) groups.set(key, new Set());
    const into = groups.get(key);
    for (const id of subsetLineIds(network, request.feature)) into.add(id);
  }

  const networkList = [];
  const networkIndex = new Map();
  const restricted = new Map();
  for (const [key, ids] of groups) {
    const country = key.slice(0, key.indexOf("/"));
    const full = networkFor(country);
    const subset = restrictNetwork(full, ids);
    networkIndex.set(key, networkList.length);
    restricted.set(key, subset);
    networkList.push({
      key,
      country,
      // Whether this is the country's complete network, which is worth saying
      // out loud: where it is, no subsetting argument is needed at all.
      complete: ids.size === full.lineById.size,
      lines: [...subset.lineById.values()].map((line) => ({
        lineId: line.lineId,
        name: line.name,
        operator: line.operator,
        isLoop: Boolean(line.isLoop),
        alignmentDirection: line.alignmentDirection || null,
        parts: line.parts.map(encodePath),
      })),
    });
  }

  const cases = [];
  const disagreements = [];
  for (const request of requests) {
    const key = `${request.country}/${request.group}`;
    const full = networkFor(request.country);
    full.routeProjectionCache = new Map();
    const expectedFull = RailNetwork.canonicalizeRouteFeature(
      full,
      request.feature,
      request.options,
    );
    const subset = restrictNetwork(full, groups.get(key));
    const expectedSubset = RailNetwork.canonicalizeRouteFeature(
      subset,
      request.feature,
      request.options,
    );
    const agreed =
      JSON.stringify(serializeResult(expectedFull)) ===
      JSON.stringify(serializeResult(expectedSubset));
    if (!agreed) {
      disagreements.push(request.name);
      continue;
    }
    cases.push({
      name: request.name,
      why: request.why,
      country: request.country,
      network: networkIndex.get(key),
      // Proof, per case, that the trimmed network is not a different question:
      // the same feature was also run against the country's complete network
      // and produced this same answer.
      verifiedAgainstFullNetwork: true,
      feature: serializeFeature(request.feature),
      continueFrom: request.options?.continueFrom || null,
      expected: serializeResult(expectedSubset),
    });
  }
  if (disagreements.length)
    console.error(
      `  ! route-feature: ${disagreements.length} case(s) differ between the ` +
        `subset and the full network and were dropped: ${disagreements.join(", ")}`,
    );

  return {
    describes: "rail-network.js canonicalizeRouteFeature",
    contract:
      "The route solver decides WHICH railway a ride used; this decides the " +
      "pixels. It projects the solved endpoints onto the already-built " +
      "complete display line and returns an exact slice of that same " +
      "LineString, so the ridden layer and the all-railways layer cannot " +
      "drift apart, disagree at a station, or groom their micro-kinks " +
      "differently. Four rules carry the behaviour: both endpoints must land " +
      "on the SAME display part, because parts are separate railways and " +
      "allowing one endpoint on each is the 'train turns onto the wrong line' " +
      "bug; a hinted line that does not reach the platform AT ALL loses to a " +
      "line that does, but only to one within 25 m, because anything in " +
      "between is a disagreement about which platform and the hint is the " +
      "better judge of that; a sourced paired alignment lets the ride's own " +
      "direction of travel break the tie between two bores of one railway; " +
      "and each end is then pinned to the solver's own station node over the " +
      "short bridge from platform to track, which is what closes the seam " +
      "between consecutive hops routed over different parts.",
    networks: networkList,
    cases,
  };
}
