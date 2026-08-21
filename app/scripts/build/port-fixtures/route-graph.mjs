// =========================================================================
//  route-graph.json — app-route-graph.js §27–28, frozen for the Swift port
//
//  What this covers, and where it stops.
//
//  app-route-graph.js is two things wearing one hat. The half frozen here is
//  the DATA STRUCTURE half: turning rail-section features into a routable
//  graph, the coarse bbox index that lets a regional build avoid scanning
//  22k features, the LRU of regional subgraphs, the nearest-node lookup the
//  station snap runs on, and the cache/template keys that decide whether any
//  of it runs at all. The other half — Dijkstra, the institution rules, the
//  route hints — lives in app-route-solver.js and is a separate port.
//
//  The seam between them is `routeSolverApi`, which app-route-service.js
//  wires up. Of the nine functions it carries, graph construction uses four
//  (coordKey, distanceMeters, graphGridKey, normalizeGraphCoord) and all four
//  are pure coordinate arithmetic that this fixture takes from the real
//  frontend files. The fifth it touches, addStationTransferConnectorEdges, is
//  the solver's and is stubbed to a no-op here — see the note on `regions`
//  below. Nothing else in this fixture reaches across the seam.
//
//  Three things are load-bearing beyond their appearance, and each has cases
//  aimed at it rather than volume:
//
//  1. NODE IDENTITY IS COORDINATE IDENTITY. A node's key is coordKey of its
//     quantised coordinate, so two vertices that ought to be one node are one
//     node only if both languages SPELL the coordinate the same way.
//     JavaScript writes an integral coordinate "139"; a port whose language
//     writes "139.0" splits that node in two and every path through it
//     disappears. `integralSpellingSample` is the deliberate hunt for those
//     keys in real data.
//
//  2. ORDER IS OBSERVABLE. nearbyGraphNodes sorts by distance with
//     Array.prototype.sort, which is stable, so ties keep the order the grid
//     scan found them in — which is the insertion order of a bucket, which is
//     the order the features were walked. Adjacency lists are likewise arrays,
//     and Dijkstra relaxes them in order. The digests below therefore pin
//     bucket order and adjacency order, not just their contents.
//
//  3. THE POLICY KEY IS SORTED WITH JAVASCRIPT'S COMPARATOR. cacheKey embeds
//     `[...].sort()`, whose default comparator orders by UTF-16 code unit.
//     The strings being sorted are line and operator names in Japanese,
//     Chinese and Korean, where a language that sorts by canonical
//     equivalence instead can legitimately disagree — and the cache key is a
//     persisted format.
//
//  Inputs are the shipped datasets: app/data/rail-sections*.json (the solver's
//  own routable geometry), app/data/stations*.json, and the five committed
//  train stores. No coordinate in this file was invented.
// =========================================================================

import fs from "node:fs";
import path from "node:path";

export const name = "route-graph.json";

const COUNTRIES = ["mo", "hk", "tw", "kr", "jp"];

// app-config.js countrySuffixed(): Japan is the unsuffixed original.
const dataFile = (base, country) =>
  country === "jp" ? `${base}.json` : `${base}-${country}.json`;

// ── loading app-route-graph.js ──────────────────────────────────────────
// It is a classic script with no exports that reads bare globals declared by
// its siblings in the SAME lexical scope (activeCountry, railSectionsGeoJson,
// stationsGeoJson, importInProgress, ROUTE_SOLVER_CACHE_VERSION …). The only
// faithful way to run it is to reproduce that scope, which is what the
// generator's loadFrontendScope and the precompute VM both do: concatenating
// the files and evaluating them through one `new Function` IS that scope.
//
// The chain is dictated by index.html, not chosen. Every file below is here
// because something above it refuses to evaluate or run without it:
//
//   app-operator-branding.js  RailOperatorBranding.normalizeTaiwanCompanyName,
//                             which companyParts applies for Taiwan
//   railmap-basemap.js        window.RailMapBasemap, read by railmap-style.js
//   railmap-style.js          window.RailMapStyle.RAILWAY_STYLE, read at
//                             app-config.js's top level
//   app-coords.js             the coordinate primitives (quant5 grid)
//   app-config.js             activeCountry, ROUTE_SOLVER_CACHE_VERSION,
//                             DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES
//   app-route-simplify.js     distanceMeters (the one haversine)
//   app-datasets.js           railSectionsGeoJson / stationsGeoJson + the
//                             named installs that write them
//   app-state.js              importInProgress, which selects the LRU budget
//   app-stations.js           station accessors used by route-section resolution
//   app-store-ops.js          getRideRouteSectionsForTrain — the sections a
//                             cache key is built from
//   app-route-graph.js        the module under test
//   app-route-solver.js       graphGridKey, the one graph-construction
//                             primitive that happens to be declared over there
const SCOPE_FILES = [
  "app-operator-branding.js",
  "railmap-basemap.js",
  "railmap-style.js",
  "app-coords.js",
  "app-config.js",
  "app-route-simplify.js",
  "app-datasets.js",
  "app-state.js",
  "app-stations.js",
  "app-store-ops.js",
  "app-route-graph.js",
  "app-route-solver.js",
];

function loadRouteGraphScope(APP_DIR, AppCore, RailNetwork) {
  const source = SCOPE_FILES.map((file) =>
    fs.readFileSync(path.join(APP_DIR, "public", file), "utf8"),
  ).join("\n");
  const factory = new Function(
    "window",
    `${source}
     // The four pure primitives graph construction needs, wired exactly as
     // app-route-service.js wires them — same functions, same file. The fifth
     // (addStationTransferConnectorEdges) belongs to the solver and is a
     // no-op here so that what this fixture records is the graph THIS module
     // builds, with no edge from the port that has not been written yet.
     configureRouteSolverApi({
       coordKey: (...a) => coordKey(...a),
       distanceMeters: (...a) => distanceMeters(...a),
       graphGridKey: (...a) => graphGridKey(...a),
       normalizeGraphCoord: (...a) => normalizeGraphCoord(...a),
       addStationTransferConnectorEdges: () => {},
     });
     return {
       // §27 keys
       getTrainRouteTemplateKey, routeKeyDigest,
       buildTrainRouteSolveContext, getAllowedInstitutionTypeCodes,
       derivedInstitutionTypeCodes, derivedPreferredOperatorNames,
       ROUTE_SOLVER_CACHE_VERSION,
       // §27 graph construction
       buildRouteGraphFromFeatures, getRuntimeRouteGraph,
       // §28 index + regional graphs
       railFeaturesInBbox, stationFeaturesInBbox, featureBbox,
       bboxIntersects, padBboxMeters, bboxDiagonalMeters,
       quantizeBboxOutward, getRegionalRouteGraph, trimRegionalGraphCache,
       pathTouchesRegionEdge, nearbyGraphNodes, intersects,
       RAIL_INDEX_CELL_DEG, REGION_QUANT_DEG,
       REGIONAL_GRAPH_NODE_BUDGET, REGIONAL_GRAPH_LOAD_NODE_BUDGET,
       // the mutable module state a caller has to drive
       setCountry: (value) => { activeCountry = value; },
       setImportInProgress: (value) => { importInProgress = value; },
       install: (sections, stations) => {
         AppDatasets.installRailSections(sections);
         AppDatasets.installStations(stations);
         invalidateRouteGraphIndexes();
       },
       regionCacheState: () => ({
         keys: [...regionalGraphCache.keys()],
         residentNodes: regionalGraphNodeCount,
       }),
     };`,
  );
  return factory({ AppCore, RailNetwork });
}

// ── digests ─────────────────────────────────────────────────────────────
// Japan's graph is 377,098 nodes and 765,426 directed edges. Writing every
// key would be a 30 MB fixture, so each list is frozen as its routeKeyDigest
// — the app's OWN 53-bit digest, not an invented hash, which means the digest
// is itself a ported function under test. A disagreement in the digest and a
// clean `routeKeyDigest` case list together say "the list moved"; a
// disagreement in both says "the digest moved", which is why the digest gets
// its own cases below.
//
// Everything fed to a digest is joined with \n after being sorted with
// JavaScript's default comparator (UTF-16 code units). Where ORDER is part of
// the answer — a grid bucket, an adjacency list — the order is inside the
// line, not in the sort.

/** Sorted with the default comparator, then digested. */
function digestSorted(js, lines) {
  return js.routeKeyDigest([...lines].sort().join("\n"));
}

/** Evenly spaced picks from a sorted list, ends included, no duplicates. */
function stride(list, count) {
  if (list.length <= count) return list.map((value, index) => ({ index, value }));
  const out = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i * (list.length - 1)) / (count - 1));
    if (seen.has(index)) continue;
    seen.add(index);
    out.push({ index, value: list[index] });
  }
  return out;
}

function edgeRecord(edge) {
  return {
    to: edge.to,
    length: edge.length,
    institution_type_code: edge.institution_type_code,
    railway_class_code: edge.railway_class_code,
    line_name: edge.line_name,
    operator: edge.operator,
  };
}

function nodeRecord(graph, key) {
  const coord = graph.nodes.get(key);
  const meta = graph.nodeMeta.get(key);
  return {
    key,
    coordinate: coord,
    line_names: [...meta.line_names].sort(),
    operators: [...meta.operators].sort(),
    institution_type_codes: [...meta.institution_type_codes].sort(),
    railway_class_codes: [...meta.railway_class_codes].sort(),
    // In adjacency order: Dijkstra relaxes an adjacency list in the order the
    // features were walked, so this is a sequence, not a set.
    edges: graph.adjacency.get(key).map(edgeRecord),
  };
}

/**
 * One country's whole graph, reduced to something a test can hold.
 *
 * Counts and digests cover it exhaustively; the samples exist so that a
 * failure names a node instead of only saying "the digest moved".
 */
function graphCase(js, country, sections, graph) {
  const nodeKeys = [...graph.nodes.keys()].sort();
  const cellKeys = [...graph.grid.keys()].sort();

  let directedEdgeCount = 0;
  const undirected = new Set();
  const adjacencyLines = [];
  const metaLines = [];
  for (const key of nodeKeys) {
    const edges = graph.adjacency.get(key);
    directedEdgeCount += edges.length;
    for (const edge of edges) {
      // Ordered by string exactly as routeCoordinateSegmentKey orders its two
      // ends, so the undirected identity of an edge is spelled the one way.
      undirected.add(key <= edge.to ? `${key}|${edge.to}` : `${edge.to}|${key}`);
      // `length` is deliberately absent: it is a haversine, and the measured
      // libm budget between V8 and Darwin is 2 ULP (see FixtureParityTests
      // .distances). A digest cannot carry a tolerance, so lengths are
      // compared per-edge in the samples instead.
      adjacencyLines.push(
        [
          key,
          edge.to,
          edge.institution_type_code,
          edge.railway_class_code,
          edge.line_name,
          edge.operator,
        ].join("\t"),
      );
    }
    const meta = graph.nodeMeta.get(key);
    metaLines.push(
      [
        key,
        [...meta.line_names].sort().join(","),
        [...meta.operators].sort().join(","),
        [...meta.institution_type_codes].sort().join(","),
        [...meta.railway_class_codes].sort().join(","),
      ].join("\t"),
    );
  }

  // A node key whose halves carry no decimal point is the JSNumber trap in
  // real data: JavaScript spells the quantised coordinate "139", a port whose
  // language spells it "139.0" invents a second node at the same place.
  const integral = nodeKeys.filter((key) =>
    key.split(",").some((half) => !half.includes(".")),
  );

  // The busiest junctions: the nodes where a mis-ordered adjacency list would
  // change which path Dijkstra finds first.
  const byDegree = [...nodeKeys].sort(
    (a, b) => graph.adjacency.get(b).length - graph.adjacency.get(a).length,
  );

  const sampleKeys = [
    ...stride(nodeKeys, 60).map((entry) => entry.value),
    ...byDegree.slice(0, 12),
    ...integral.slice(0, 12),
  ];

  return {
    country,
    sectionFeatureCount: sections.features.length,
    nodeCount: graph.nodes.size,
    directedEdgeCount,
    undirectedEdgeCount: undirected.size,
    gridCellCount: graph.grid.size,
    cellSize: graph.cellSize,
    digests: {
      // Every node key, sorted. The single most load-bearing list here: it is
      // the set of coordinate identities the whole app agrees on.
      nodeKeys: digestSorted(js, nodeKeys),
      undirectedEdgeKeys: digestSorted(js, [...undirected]),
      // Walked in sorted-node order, each adjacency list in ITS order.
      adjacency: js.routeKeyDigest(adjacencyLines.join("\n")),
      nodeMeta: js.routeKeyDigest(metaLines.join("\n")),
      // Each bucket in insertion order — the tie-break nearbyGraphNodes
      // inherits from the stable sort.
      grid: js.routeKeyDigest(
        cellKeys.map((cell) => `${cell}\t${graph.grid.get(cell).join(",")}`).join("\n"),
      ),
    },
    nodeKeySample: stride(nodeKeys, 200),
    gridCellSample: stride(cellKeys, 24).map((entry) => ({
      index: entry.index,
      cell: entry.value,
      nodeKeys: graph.grid.get(entry.value),
    })),
    integralSpellingCount: integral.length,
    integralSpellingSample: integral.slice(0, 40),
    nodeSample: [...new Set(sampleKeys)].map((key) => nodeRecord(graph, key)),
  };
}

// ── the spatial index, driven with real station coordinates ─────────────

/**
 * bboxes built from ADJACENT pairs of real station display points, which is
 * the shape sectionEndpointBbox produces for a route section: the two ends of
 * one hop. The station files are written line by line, so consecutive entries
 * are consecutive stops — a bbox spanning a third of the country would be a
 * region nothing in production ever builds.
 *
 * Picks are evenly spaced through the file rather than random, so the fixture
 * is reproducible.
 */
function stationBboxes(stationPoints, count) {
  const out = [];
  const n = stationPoints.length;
  if (n < 2) return out;
  for (const { index } of stride(stationPoints.slice(0, n - 1), count)) {
    const a = stationPoints[index];
    const b = stationPoints[index + 1];
    out.push([
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
    ]);
  }
  return out;
}

function spatialIndexCases(js, country, sections, stationPoints) {
  const featureIndexOf = new Map();
  sections.features.forEach((feature, index) => featureIndexOf.set(feature, index));

  const cases = [];
  // Single-station (zero-area) bboxes first: a degenerate bbox is what a
  // route section between two platforms of one station produces, and
  // Math.floor(x0) === Math.floor(x1) is the loop's smallest case.
  for (const point of stride(stationPoints, 10).map((entry) => entry.value))
    cases.push([point[0], point[1], point[0], point[1]]);
  for (const bbox of stationBboxes(stationPoints, 10)) cases.push(bbox);

  return cases.map((bbox) => {
    const quantized = js.quantizeBboxOutward(bbox);
    const padded = js.padBboxMeters(bbox, 30000);
    return {
      country,
      bbox,
      diagonalMeters: js.bboxDiagonalMeters(bbox),
      padded30km: padded,
      quantized,
      // Feature ORDER is part of the answer: railFeaturesInBbox scans cells x
      // then y and de-duplicates by object identity, so a port that iterates
      // a dictionary instead of an ordered bucket returns the same set in a
      // different order — and the regional graph built from it then carries
      // its adjacency lists in a different order.
      featureIndices: js
        .railFeaturesInBbox(bbox)
        .map((feature) => featureIndexOf.get(feature)),
      quantizedFeatureIndices: js
        .railFeaturesInBbox(quantized)
        .map((feature) => featureIndexOf.get(feature)),
      stationIndicesInQuantized: js
        .stationFeaturesInBbox(quantized)
        .map((feature) => feature.__stationIndex),
    };
  });
}

// ── nearbyGraphNodes ────────────────────────────────────────────────────

function nearbyCases(js, country, graph, stationPoints) {
  const cases = [];
  const push = (coord, radiusDeg, limit) => {
    cases.push({
      country,
      coord,
      radiusDeg,
      limit,
      // Order is the answer, not an accident: the sort is by distance and
      // Array.prototype.sort is stable, so equal distances keep grid-scan
      // order, and the caller then takes the first `limit`.
      result: js.nearbyGraphNodes(coord, graph, radiusDeg, limit),
    });
  };
  for (const { value } of stride(stationPoints, 24)) {
    push(value, 0.0015, 30); // the defaults
    push(value, 0.0035, 30); // STATION_TRANSFER_NODE_RADIUS_DEG
  }
  // Adversarial, still on real coordinates: a radius smaller than one cell
  // still scans a 3×3 block (cellRadius is floored at 1), a limit of 0 must
  // return nothing at all, and a wide radius crosses many buckets so the
  // scan order decides the tie-break.
  for (const { value } of stride(stationPoints, 4)) {
    push(value, 0.00001, 30);
    push(value, 0.0015, 0);
    push(value, 0.03, 120);
  }
  return cases;
}

/**
 * Station coordinates whose candidate list contains an exact distance TIE —
 * the only cases in which the stability of Array.prototype.sort is visible in
 * the answer.
 *
 * They are not contrived. Two nodes symmetric about the query point are
 * exactly equidistant, because the haversine's longitude term is squared and
 * the quantisation grid puts vertices at regular offsets; scanning the shipped
 * station files with the default radius finds 102 such stations in Japan and 3
 * in Hong Kong, and none at all in Macao, Taiwan or Korea. Which is the point:
 * a port that sorts with an unstable sort passes every other case in this
 * fixture, and passes on three countries out of five.
 *
 * The scan stops at the first few hits rather than running to the end of the
 * file — this fixture is regenerated by `verify.sh --check` on every run, and
 * a full sweep of 10,233 Japanese stations is not worth a minute of it.
 */
function tieBreakingCases(js, country, graph, stationPoints) {
  const hasTie = (result) => {
    const seen = new Set();
    for (const entry of result) {
      if (seen.has(entry.distance)) return true;
      seen.add(entry.distance);
    }
    return false;
  };
  const found = [];
  for (const coord of stationPoints) {
    if (found.length >= 8) break;
    if (hasTie(js.nearbyGraphNodes(coord, graph, 0.0015, 30))) found.push(coord);
  }
  const cases = [];
  for (const coord of found)
    for (const [radiusDeg, limit] of [
      [0.0015, 30],
      [0.0035, 30],
      [0.03, 120],
    ]) {
      const result = js.nearbyGraphNodes(coord, graph, radiusDeg, limit);
      cases.push({
        country,
        coord,
        radiusDeg,
        limit,
        tiedDistanceCount:
          result.length - new Set(result.map((entry) => entry.distance)).size,
        result,
      });
    }
  return cases;
}

// ── regional graphs and their LRU ───────────────────────────────────────

/**
 * A scripted sequence through getRegionalRouteGraph, recording the cache
 * after every call.
 *
 * The LRU is a Map used as an ordered structure — `delete` then `set` is the
 * touch, and `keys().next().value` is the eviction victim — so its behaviour
 * is entirely a matter of insertion order. A port backed by an unordered
 * dictionary passes every count in this fixture and evicts the wrong region.
 *
 * The sequence deliberately revisits an earlier bbox (index 1 repeats index
 * 0's) so a hit's LRU touch is recorded, and runs long enough on Japan to
 * cross REGIONAL_GRAPH_NODE_BUDGET and force an eviction.
 */
function regionCases(js, country, stationPoints, importInProgress) {
  js.setImportInProgress(importInProgress);
  // Ten regions is not an arbitrary length: on Japan it is what carries the
  // resident total past REGIONAL_GRAPH_NODE_BUDGET, so the steady-state run
  // evicts mid-sequence and the importInProgress run — twice the budget —
  // does not. A shorter script leaves that branch untaken and the two runs
  // indistinguishable.
  const bboxes = stationBboxes(stationPoints, 10);
  // The repeat at the front is the point of the sequence: step 1 is a HIT on
  // step 0's region, and a hit deletes and re-inserts the key, which moves it
  // to the young end. A port that treats the cache as a plain dictionary
  // returns the same graph and then evicts the wrong region later.
  const script = [bboxes[0], ...bboxes];
  const steps = [];
  for (const bbox of script) {
    const margin = Math.max(30000, js.bboxDiagonalMeters(bbox) * 0.6);
    const padded = js.padBboxMeters(bbox, margin);
    const graph = js.getRegionalRouteGraph(padded);
    const state = js.regionCacheState();
    steps.push({
      bbox,
      margin,
      padded,
      regionBbox: graph.regionBbox,
      nodeCount: graph.nodes.size,
      cacheKeys: state.keys,
      residentNodes: state.residentNodes,
    });
  }
  // Eviction, driven directly. The shipped budgets (300k / 600k nodes) are
  // larger than a handful of realistic single-hop regions, so a build
  // sequence alone would never reach the branch that actually drops a graph —
  // including its last clause, which keeps one region resident no matter how
  // small the target, so the in-flight solve still has its graph.
  const trims = [];
  const resident = js.regionCacheState().residentNodes;
  for (const fraction of [1, 0.75, 0.5, 0.25, 0]) {
    const target = Math.floor(resident * fraction);
    js.trimRegionalGraphCache(target);
    const state = js.regionCacheState();
    trims.push({ target, cacheKeys: state.keys, residentNodes: state.residentNodes });
  }
  js.setImportInProgress(false);
  return {
    country,
    importInProgress,
    budget: importInProgress
      ? js.REGIONAL_GRAPH_LOAD_NODE_BUDGET
      : js.REGIONAL_GRAPH_NODE_BUDGET,
    steps,
    trims,
  };
}

// ── cache and template keys ─────────────────────────────────────────────

function trainProjection(train) {
  const policy = train.route_policy || {};
  return {
    id: train.id,
    train_type: train.train_type ?? null,
    company: train.company ?? null,
    route_policy: {
      preferred_line_names: policy.preferred_line_names ?? null,
      preferred_operator_names: policy.preferred_operator_names ?? null,
      allowed_institution_type_codes: policy.allowed_institution_type_codes ?? null,
      institution_filter_mode: policy.institution_filter_mode ?? null,
    },
  };
}

/**
 * The cache key of every train in every shipped store.
 *
 * `routeSections` is recorded rather than recomputed. buildTrainRouteSolveContext
 * gets them from getRideRouteSectionsForTrain, which lives in app-store-ops.js
 * and belongs to the train store, not to the graph — so the fixture carries
 * the sections it produced as INPUT, and the port is asked for the part that
 * is this module's: template key, allowed codes, policy key, cache key.
 */
function cacheKeyCases(js, country, store) {
  const cases = [];
  for (const train of store.trains || []) {
    const context = js.buildTrainRouteSolveContext(train);
    if (!context) continue;
    cases.push({
      country,
      train: trainProjection(train),
      routeSections: context.routeSections,
      allowedCodes: context.allowedCodes,
      derivedInstitutionTypeCodes: js.derivedInstitutionTypeCodes(train),
      // Insertion order, NOT sorted — a Set spread. The policy key sorts it
      // afterwards, but the solver reads this list as it stands.
      derivedPreferredOperatorNames: js.derivedPreferredOperatorNames(train),
      templateKey: context.templateKey,
      templateKeyDigest: js.routeKeyDigest(context.templateKey),
      cacheKey: context.cacheKey,
      cacheKeyDigest: js.routeKeyDigest(context.cacheKey),
    });
  }
  return cases;
}

// Digest inputs chosen to break a naive port rather than to pass it: the empty
// string the JavaScript coerces to with String(key || ""), surrogate pairs
// (charCodeAt walks UTF-16 code units, not scalars, so an emoji is TWO
// iterations), and strings long enough to wrap Math.imul many times.
const DIGEST_INPUTS = [
  "",
  "0",
  "a",
  "solver:17|1,2,3,4,5|institution_filter:soft|",
  "007958->007996|lines:関西空港線|operators:西日本旅客鉄道",
  "경북선|한국철도공사",
  "𝄞𝄢🚄", // surrogate pairs: two code units each
  " ￿",
  "x".repeat(1000),
  "東海道新幹線".repeat(400),
];

// ── build ───────────────────────────────────────────────────────────────

export function build({ AppCore, RailNetwork, APP_DIR }) {
  const js = loadRouteGraphScope(APP_DIR, AppCore, RailNetwork);

  const cases = [];
  const spatialIndex = [];
  const nearbyNodes = [];
  const tieBreaking = [];
  const regions = [];
  const cacheKeys = [];

  for (const country of COUNTRIES) {
    const sections = JSON.parse(
      fs.readFileSync(
        path.join(APP_DIR, "data", dataFile("rail-sections", country)),
        "utf8",
      ),
    );
    const stations = JSON.parse(
      fs.readFileSync(
        path.join(APP_DIR, "data", dataFile("stations", country)),
        "utf8",
      ),
    );
    // stationFeaturesInBbox returns the feature objects; the fixture has to
    // name them, and their position in the shipped file is the only identity
    // they have.
    stations.features.forEach((feature, index) => {
      feature.__stationIndex = index;
    });

    js.setCountry(country);
    js.install(sections, stations);

    const graph = js.buildRouteGraphFromFeatures(sections.features);
    cases.push(graphCase(js, country, sections, graph));

    const stationPoints = stations.features.map(
      (feature) => feature.properties.display_point,
    );
    spatialIndex.push(...spatialIndexCases(js, country, sections, stationPoints));
    nearbyNodes.push(...nearbyCases(js, country, graph, stationPoints));
    tieBreaking.push(...tieBreakingCases(js, country, graph, stationPoints));
    regions.push(regionCases(js, country, stationPoints, false));

    const storePath = path.join(APP_DIR, "data", dataFile("train-store", country));
    if (fs.existsSync(storePath))
      cacheKeys.push(
        ...cacheKeyCases(js, country, JSON.parse(fs.readFileSync(storePath, "utf8"))),
      );
  }

  // Japan again, with importInProgress set: the load budget is double the
  // steady one, and which of the two applies decides whether a region built
  // for an early train survives to the later train that needs it.
  js.setCountry("jp");
  js.install(
    JSON.parse(fs.readFileSync(path.join(APP_DIR, "data", "rail-sections.json"), "utf8")),
    JSON.parse(fs.readFileSync(path.join(APP_DIR, "data", "stations.json"), "utf8")),
  );
  const jpStations = JSON.parse(
    fs.readFileSync(path.join(APP_DIR, "data", "stations.json"), "utf8"),
  ).features.map((feature) => feature.properties.display_point);
  regions.push(regionCases(js, "jp", jpStations, true));

  return {
    describes:
      "app-route-graph.js §27–28 — graph construction, the rail-section " +
      "spatial index, regional subgraphs and their LRU, nearest-node lookup, " +
      "and the route template/cache keys",
    contract:
      "A graph node's identity IS its coordinate, spelled by coordKey on the " +
      "5-decimal grid, so two vertices merge into one node only when both " +
      "languages spell the quantised coordinate identically — JavaScript " +
      "writes an integral coordinate '139', and a port that writes '139.0' " +
      "silently splits every such node. The route cache key is a PERSISTED " +
      "format built from that same spelling plus two Array.prototype.sort " +
      "calls over CJK/Hangul line and operator names, which order by UTF-16 " +
      "code unit rather than by canonical equivalence. And order is an " +
      "answer, not an accident: grid buckets and adjacency lists are arrays " +
      "walked in insertion order, nearbyGraphNodes leans on Array.prototype" +
      ".sort being stable to break distance ties by that order, and the " +
      "regional LRU is a Map whose insertion order chooses the eviction.",
    constants: {
      railIndexCellDeg: js.RAIL_INDEX_CELL_DEG,
      regionQuantDeg: js.REGION_QUANT_DEG,
      regionalGraphNodeBudget: js.REGIONAL_GRAPH_NODE_BUDGET,
      regionalGraphLoadNodeBudget: js.REGIONAL_GRAPH_LOAD_NODE_BUDGET,
      routeSolverCacheVersion: js.ROUTE_SOLVER_CACHE_VERSION,
    },
    cases,
    keyDigests: DIGEST_INPUTS.map((input) => ({
      input,
      digest: js.routeKeyDigest(input),
    })),
    spatialIndex,
    nearbyNodes,
    tieBreaking,
    regions,
    cacheKeys,
  };
}
