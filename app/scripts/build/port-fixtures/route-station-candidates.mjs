// app-route-solver.js §29 — real station geometry → graph-node candidates.

import fs from "node:fs";
import path from "node:path";

export const name = "route-station-candidates.json";

const SCOPE_FILES = [
  "app-operator-branding.js", "railmap-basemap.js", "railmap-style.js",
  "app-coords.js", "app-config.js", "app-route-simplify.js",
  "app-datasets.js", "app-state.js", "app-stations.js", "app-store-ops.js",
  "app-route-features.js", "app-route-graph.js", "app-route-solver.js",
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
       coordKey: (...a) => coordKey(...a), coordinatesClose: (...a) => coordinatesClose(...a),
       distanceMeters: (...a) => distanceMeters(...a), graphGridKey: (...a) => graphGridKey(...a),
       normalizeGraphCoord: (...a) => normalizeGraphCoord(...a),
       pathLengthForCoordinates: (...a) => pathLengthForCoordinates(...a),
       resolveEndpointCandidates: (...a) => resolveRouteEndpointStationCandidates(...a),
       solveSection: (...a) => solveRouteSectionOnN02Graph(...a),
     });
     configureRouteGraphApi({
       allowedInstitutionCodes: (...a) => getAllowedInstitutionTypeCodes(...a),
       intersects: (...a) => intersects(...a), keyDigest: (...a) => routeKeyDigest(...a),
       nearbyNodes: (...a) => nearbyGraphNodes(...a),
       preferredOperatorNames: (...a) => derivedPreferredOperatorNames(...a),
       resolveSectionEndpoints: (...a) => resolveSectionEndpoints(...a),
       templateKey: (...a) => getTrainRouteTemplateKey(...a),
     });
     return { buildRouteGraphFromFeatures, getStationCandidateGraphNodes,
       collectStationCandidateGraphNodes, filterStationCandidatesNear,
       filterStationsByPreferredInstitution, stationInstitutionTypeCode }`,
  )({ AppCore, RailNetwork });
}

function cleanCandidate(candidate, stationIndex) {
  return {
    key: candidate.key,
    distance: candidate.distance,
    score: candidate.score,
    hasPreferredInstitution: candidate.hasPreferredInstitution,
    stationIndex,
  };
}

function hintObject(value) {
  return {
    preferredLines: new Set(value.preferredLines),
    preferredOperators: new Set(value.preferredOperators),
    requiredLines: new Set(value.requiredLines),
    requiredOperators: new Set(value.requiredOperators),
    requirePreferredInstitution: value.requirePreferredInstitution,
  };
}

function countryCase(js, APP_DIR, country) {
  const sections = JSON.parse(fs.readFileSync(
    path.join(APP_DIR, "data", `rail-sections-${country}.json`), "utf8"));
  const stations = JSON.parse(fs.readFileSync(
    path.join(APP_DIR, "data", `stations-${country}.json`), "utf8"));
  const graph = js.buildRouteGraphFromFeatures(sections.features);
  const baseHints = {
    preferredLines: [], preferredOperators: [], requiredLines: [],
    requiredOperators: [], requirePreferredInstitution: false,
  };
  const probes = [];
  const stride = Math.max(1, Math.floor(stations.features.length / 24));
  for (let index = 0; index < stations.features.length && probes.length < 6; index += stride) {
    const feature = stations.features[index];
    const code = js.stationInstitutionTypeCode(feature);
    const allowedCodes = code ? [String(code)] : ["1", "2", "3", "4", "5"];
    const candidates = js.getStationCandidateGraphNodes(
      feature, graph, hintObject(baseHints), allowedCodes,
    );
    if (!candidates.length) continue;
    const preferredHints = {
      ...baseHints,
      preferredLines: [String(feature.properties?.line_name || feature.properties?.N02_003 || "__line__")],
      preferredOperators: [String(feature.properties?.operator || feature.properties?.N02_004 || "__operator__")],
    };
    const strictHints = {
      ...baseHints,
      requiredLines: ["__line_that_does_not_exist__"],
      requirePreferredInstitution: true,
    };
    probes.push({
      stationIndex: index,
      allowedCodes,
      baseHints,
      base: candidates.map((candidate) => cleanCandidate(candidate, index)),
      preferredHints,
      preferred: js.getStationCandidateGraphNodes(
        feature, graph, hintObject(preferredHints), allowedCodes,
      ).map((candidate) => cleanCandidate(candidate, index)),
      strictHints,
      strict: js.getStationCandidateGraphNodes(
        feature, graph, hintObject(strictHints), allowedCodes,
      ).map((candidate) => cleanCandidate(candidate, index)),
    });
  }

  const collectIndices = probes.slice(0, 3).map((probe) => probe.stationIndex);
  const collected = js.collectStationCandidateGraphNodes(
    collectIndices.map((index) => stations.features[index]),
    graph, hintObject(baseHints), ["1", "2", "3", "4", "5"],
  ).map((candidate) => ({
    ...cleanCandidate(candidate, stations.features.indexOf(candidate.stationFeature)),
  }));

  return {
    country,
    graphNodeCount: graph.nodes.size,
    probes,
    collection: {
      stationIndices: collectIndices,
      hints: baseHints,
      allowedCodes: ["1", "2", "3", "4", "5"],
      result: collected,
    },
  };
}

export function build({ AppCore, RailNetwork, APP_DIR }) {
  const js = loadScope(APP_DIR, AppCore, RailNetwork);
  return {
    describes: "app-route-solver.js station geometry snapping and candidate scoring",
    contract: "For real station and RailroadSection collections, Swift must retain the same graph nodes in the same score order with the same distances and preference scores.",
    cases: [countryCase(js, APP_DIR, "mo"), countryCase(js, APP_DIR, "hk")],
  };
}
