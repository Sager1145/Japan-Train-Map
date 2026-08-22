// app-route-solver.js §29 — deterministic edge rules and multi-source Dijkstra.
// The inputs below are complete, unmodified RailroadSection features selected
// from the shipped Hong Kong and Macao datasets. Keeping the graphs small makes
// the fixture readable while still exercising real coordinate spelling, edge
// lengths, line/operator metadata and institution codes.

import fs from "node:fs";
import path from "node:path";

export const name = "route-solver-core.json";

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
  "app-route-features.js",
  "app-route-graph.js",
  "app-route-solver.js",
];

function loadScope(APP_DIR, AppCore, RailNetwork) {
  const source = SCOPE_FILES.map((file) =>
    fs.readFileSync(path.join(APP_DIR, "public", file), "utf8"),
  ).join("\n");
  return new Function(
    "window",
    `${source}
     configureRouteSolverApi({
       addStationTransferConnectorEdges: (...a) => addStationTransferConnectorEdges(...a),
       coordKey: (...a) => coordKey(...a),
       coordinatesClose: (...a) => coordinatesClose(...a),
       distanceMeters: (...a) => distanceMeters(...a),
       graphGridKey: (...a) => graphGridKey(...a),
       normalizeGraphCoord: (...a) => normalizeGraphCoord(...a),
       pathLengthForCoordinates: (...a) => pathLengthForCoordinates(...a),
       resolveEndpointCandidates: (...a) => resolveRouteEndpointStationCandidates(...a),
       solveSection: (...a) => solveRouteSectionOnN02Graph(...a),
     });
     configureRouteGraphApi({
       allowedInstitutionCodes: (...a) => getAllowedInstitutionTypeCodes(...a),
       intersects: (...a) => intersects(...a),
       keyDigest: (...a) => routeKeyDigest(...a),
       nearbyNodes: (...a) => nearbyGraphNodes(...a),
       preferredOperatorNames: (...a) => derivedPreferredOperatorNames(...a),
       resolveSectionEndpoints: (...a) => resolveSectionEndpoints(...a),
       templateKey: (...a) => getTrainRouteTemplateKey(...a),
     });
     return {
       buildRouteGraphFromFeatures, dijkstraFromCandidateSources,
       edgeHasPreferredInstitution, edgeMatchesAllowedCodes,
       edgeMatchesRequiredHints, institutionPreferencePenaltyForEdge,
       nonPreferredLineOperatorPenalty, routeLineMismatchPenalty,
       usedInstitutionTypeCodes, pathLengthMeters, coordKey,
       iterateGeometryLines,
     };`,
  )({ AppCore, RailNetwork });
}

function propertiesOf(feature) {
  const p = feature.properties || {};
  return {
    lineName: String(p.N02_003 || p.line_name || ""),
    operator: String(p.N02_004 || p.operator || ""),
    institutionTypeCode: String(
      p.N02_002 || p.institution_type_code || "",
    ),
    railwayClassCode: String(p.N02_001 || p.railway_class_code || ""),
  };
}

function chooseFeature(js, features) {
  return features.find((feature) => {
    const lines = js.iterateGeometryLines(feature.geometry);
    const keys = lines[0]?.map((coord) => js.coordKey(coord)) || [];
    return keys.length >= 10 && new Set(keys).size === keys.length;
  });
}

function hints(value = {}) {
  return {
    preferredLines: new Set(value.preferredLines || []),
    preferredOperators: new Set(value.preferredOperators || []),
    requiredLines: new Set(value.requiredLines || []),
    requiredOperators: new Set(value.requiredOperators || []),
    requirePreferredInstitution: Boolean(value.requirePreferredInstitution),
  };
}

function dijkstraCase(js, graph, name, sources, targets, train, allowed, hint) {
  const segmentHints = hints(hint);
  const result = js.dijkstraFromCandidateSources(
    graph,
    sources,
    new Set(targets),
    { route_policy: { institution_filter_mode: train.institutionFilterMode } },
    allowed,
    segmentHints,
  );
  return {
    name,
    sources,
    targets,
    train,
    allowedCodes: allowed,
    hints: hint,
    result,
    pathLengths: result.map((row) => js.pathLengthMeters(graph, row.pathKeys)),
    mismatchPenalties: result.map((row) =>
      js.routeLineMismatchPenalty(graph, row.pathKeys, segmentHints),
    ),
    usedInstitutionTypeCodes: result.map((row) =>
      js.usedInstitutionTypeCodes(graph, row.pathKeys),
    ),
  };
}

function countryCase(js, APP_DIR, country) {
  const sections = JSON.parse(
    fs.readFileSync(path.join(APP_DIR, "data", `rail-sections-${country}.json`), "utf8"),
  );
  const feature = chooseFeature(js, sections.features);
  if (!feature) throw new Error(`No fixture feature for ${country}`);
  const graph = js.buildRouteGraphFromFeatures([feature]);
  const lines = js.iterateGeometryLines(feature.geometry);
  const keys = lines[0].map((coord) => js.coordKey(coord));
  const p = propertiesOf(feature);
  const allowed = p.institutionTypeCode ? [p.institutionTypeCode] : ["1", "2", "3", "4", "5"];
  const disallowed = ["__not_the_real_code__"];
  const middle = Math.floor(keys.length / 2);
  const source = [{ key: keys[0], distance: 17.25 }];
  const targets = [keys[middle], keys[keys.length - 1]];
  const baseHints = {
    preferredLines: [], preferredOperators: [],
    requiredLines: [], requiredOperators: [],
    requirePreferredInstitution: false,
  };
  const preferredHints = {
    ...baseHints,
    preferredLines: [p.lineName === "" ? "__missing_line__" : p.lineName],
    preferredOperators: [p.operator === "" ? "__missing_operator__" : p.operator],
  };
  const mismatchedHints = {
    ...baseHints,
    preferredLines: ["__different_line__"],
    preferredOperators: ["__different_operator__"],
  };
  const requiredMismatch = {
    ...baseHints,
    requiredLines: ["__different_line__"],
  };
  const cases = [
    dijkstraCase(js, graph, "base", source, targets, { institutionFilterMode: "soft" }, allowed, baseHints),
    dijkstraCase(js, graph, "preferred-match", source, targets, { institutionFilterMode: "soft" }, allowed, preferredHints),
    dijkstraCase(js, graph, "preferred-mismatch", source, targets, { institutionFilterMode: "soft" }, allowed, mismatchedHints),
    dijkstraCase(js, graph, "required-mismatch", source, targets, { institutionFilterMode: "soft" }, allowed, requiredMismatch),
    dijkstraCase(js, graph, "hard-disallowed", source, targets, { institutionFilterMode: "hard" }, disallowed, baseHints),
    dijkstraCase(js, graph, "soft-disallowed", source, targets, { institutionFilterMode: "soft" }, disallowed, baseHints),
    dijkstraCase(
      js, graph, "multi-source",
      [{ key: keys[0], distance: 80 }, { key: keys[middle], distance: 3 }],
      [keys[0], keys[keys.length - 1]],
      { institutionFilterMode: "soft" }, allowed, baseHints,
    ),
  ];
  const sampleEdge = graph.adjacency.get(keys[0])[0];
  return {
    country,
    input: { properties: p, lines },
    nodeCount: graph.nodes.size,
    edgeRuleSample: {
      edge: sampleEdge,
      allowedCodes: allowed,
      disallowedCodes: disallowed,
      hasAllowed: js.edgeHasPreferredInstitution(sampleEdge, allowed),
      hasDisallowed: js.edgeHasPreferredInstitution(sampleEdge, disallowed),
      softDisallowedPenalty: js.institutionPreferencePenaltyForEdge(
        sampleEdge, disallowed,
        { route_policy: { institution_filter_mode: "soft" } },
      ),
      hardDisallowedPenalty: js.institutionPreferencePenaltyForEdge(
        sampleEdge, disallowed,
        { route_policy: { institution_filter_mode: "hard" } },
      ),
      mismatchedLineOperatorPenalty: js.nonPreferredLineOperatorPenalty(
        sampleEdge, new Set(["__different_line__"]),
        new Set(["__different_operator__"]),
      ),
    },
    cases,
  };
}

export function build({ AppCore, RailNetwork, APP_DIR }) {
  const js = loadScope(APP_DIR, AppCore, RailNetwork);
  return {
    describes: "app-route-solver.js §29 edge rules and multi-source/multi-target Dijkstra",
    contract: "The Swift solver must choose the same source, settle targets in the same order, reconstruct the same graph-node path, and reproduce the exact policy-weighted cost over real shipped RailroadSection features.",
    cases: [countryCase(js, APP_DIR, "mo"), countryCase(js, APP_DIR, "hk")],
  };
}
