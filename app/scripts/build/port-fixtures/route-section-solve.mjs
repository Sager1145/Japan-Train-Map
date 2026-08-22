// app-route-solver.js §29 — complete station-to-station section solves.

import fs from "node:fs";
import path from "node:path";

export const name = "route-section-solve.json";

const FILES = [
  "app-operator-branding.js", "railmap-basemap.js", "railmap-style.js",
  "app-coords.js", "app-config.js", "app-route-simplify.js", "app-datasets.js",
  "app-state.js", "app-stations.js", "app-store-ops.js", "app-route-features.js",
  "app-route-graph.js", "app-route-solver.js",
];

function loadScope(APP_DIR, AppCore, RailNetwork) {
  const source = FILES.map((file) => fs.readFileSync(
    path.join(APP_DIR, "public", file), "utf8")).join("\n");
  return new Function("window", `${source}
    configureStationRouteResolver({ allowedInstitutionCodes: getAllowedInstitutionTypeCodes,
      filterPreferredStations: filterStationsByPreferredInstitution, distanceMeters });
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
    return {
      install: (country, sections, stations) => { activeCountry = country;
        AppDatasets.installRailSections(sections); AppDatasets.installStations(stations);
        buildStationIndexesSliced(stations); },
      stationNameForCode, buildRouteGraphFromFeatures, addStationTransferConnectorEdges,
      solveRouteSectionOnN02Graph, solveTaiwanRouteSectionOnOfficialInterval,
      getAllowedInstitutionTypeCodes, routeKeyDigest,
    };`)({ AppCore, RailNetwork });
}

function trainProjection(train) {
  return {
    id: train.id || "", number: train.number || "", trainType: train.train_type || "",
    company: train.company || "", origin: train.origin || "", destination: train.destination || "",
    preferredLineNames: train.route_policy?.preferred_line_names || [],
    preferredOperatorNames: train.route_policy?.preferred_operator_names || [],
    allowedInstitutionTypeCodes: train.route_policy?.allowed_institution_type_codes || null,
    institutionFilterMode: train.route_policy?.institution_filter_mode || "soft",
  };
}

function connectorSummary(js, graph) {
  const lines = [];
  graph.adjacency.forEach((edges, from) => edges.forEach((edge) => {
    if (!edge.is_station_connector) return;
    // Length is one haversine and Darwin↔V8 has a measured 2-ULP ceiling;
    // graph identity therefore covers endpoints and metadata, as route-graph.mjs does.
    lines.push([from, edge.to, (edge.institution_type_codes || []).join(","),
      edge.station_name || "", edge.n02_group_code || ""].join("|"));
  }));
  lines.sort();
  return { directedCount: lines.length, digest: js.routeKeyDigest(lines.join("\n")) };
}

function countryCase(js, APP_DIR, country) {
  const read = (base) => JSON.parse(fs.readFileSync(
    path.join(APP_DIR, "data", `${base}-${country}.json`), "utf8"));
  const sections = read("rail-sections");
  const stations = read("stations");
  const store = read("train-store");
  js.install(country, sections, stations);
  const graph = js.buildRouteGraphFromFeatures(sections.features);
  js.addStationTransferConnectorEdges(graph, stations.features);
  const train = store.trains[0];
  const allowed = js.getAllowedInstitutionTypeCodes(train);
  const solved = [];
  const officialSolved = [];
  let continuity = null;
  for (const [index, raw] of (train.route_sections || []).slice(0, 6).entries()) {
    const section = { ...raw,
      from: raw.from || js.stationNameForCode(raw.from_n02_station_code),
      to: raw.to || js.stationNameForCode(raw.to_n02_station_code) };
    const feature = js.solveRouteSectionOnN02Graph(
      section, index, train, graph, allowed, continuity,
    );
    solved.push({ section, continuityAnchor: continuity, feature });
    const officialFeature = js.solveTaiwanRouteSectionOnOfficialInterval(
      section, index, train, allowed, continuity,
    );
    officialSolved.push({ section, continuityAnchor: continuity, feature: officialFeature });
    if (feature?.geometry?.coordinates?.length)
      continuity = feature.geometry.coordinates[feature.geometry.coordinates.length - 1];
  }
  return { country, train: trainProjection(train), graphNodeCount: graph.nodes.size,
    connectors: connectorSummary(js, graph), solved, officialSolved };
}

export function build({ AppCore, RailNetwork, APP_DIR }) {
  const js = loadScope(APP_DIR, AppCore, RailNetwork);
  return {
    describes: "app-route-solver.js complete graph and official-interval section solves",
    contract: "Swift must add the same station-transfer connectors, preserve exact ordered official interval geometry in TW/HK/MO, and return the same real rail geometry and route metadata for consecutive shipped route sections.",
    cases: [countryCase(js, APP_DIR, "mo"), countryCase(js, APP_DIR, "hk")],
  };
}
