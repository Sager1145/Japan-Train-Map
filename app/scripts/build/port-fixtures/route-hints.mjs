// app-route-solver.js §29 — segment hints and ordered fallback attempts.

import fs from "node:fs";
import path from "node:path";

export const name = "route-hints.json";

const FILES = [
  "app-operator-branding.js", "railmap-basemap.js", "railmap-style.js",
  "app-coords.js", "app-config.js", "app-route-simplify.js", "app-datasets.js",
  "app-state.js", "app-stations.js", "app-store-ops.js", "app-route-features.js",
  "app-route-graph.js", "app-route-solver.js",
];

function loadScope(APP_DIR, AppCore, RailNetwork) {
  const source = FILES.map((file) =>
    fs.readFileSync(path.join(APP_DIR, "public", file), "utf8"),
  ).join("\n");
  return new Function("window", `${source}
    configureStationRouteResolver({
      allowedInstitutionCodes: getAllowedInstitutionTypeCodes,
      filterPreferredStations: filterStationsByPreferredInstitution,
      distanceMeters,
    });
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
      install: (country, sections, stations) => {
        activeCountry = country;
        AppDatasets.installRailSections(sections);
        AppDatasets.installStations(stations);
        buildStationIndexesSliced(stations);
      },
      stationNameForCode, resolveSectionEndpoints,
      buildSegmentRouteHints, buildSegmentRouteSolveAttempts,
    };`)({ AppCore, RailNetwork });
}

const SET_FIELDS = [
  "preferredLines", "preferredOperators", "requiredLines", "requiredOperators",
  "explicitRequiredLines", "explicitRequiredOperators", "commonLines", "commonOperators",
  "allCommonLines", "allCommonOperators", "preferredInstitutionCommonLines",
  "preferredInstitutionCommonOperators", "fromLines", "toLines", "fromOperators",
  "toOperators", "fromPreferredLines", "toPreferredLines", "fromPreferredOperators",
  "toPreferredOperators",
];

function cleanHints(hints) {
  const out = {};
  SET_FIELDS.forEach((field) => { out[field] = [...(hints[field] || [])].sort(); });
  out.requirePreferredInstitution = Boolean(hints.requirePreferredInstitution);
  out.solveMode = hints.solve_mode || "base";
  return out;
}

function countryCase(js, APP_DIR, country) {
  const read = (base) => JSON.parse(fs.readFileSync(
    path.join(APP_DIR, "data", `${base}-${country}.json`), "utf8"));
  const sections = read("rail-sections");
  const stations = read("stations");
  const store = read("train-store");
  js.install(country, sections, stations);
  const stationIndex = new Map(stations.features.map((feature, index) => [feature, index]));
  const cases = [];
  for (const train of store.trains.slice(0, 3)) {
    for (const rawSection of (train.route_sections || []).slice(0, 4)) {
      const section = {
        ...rawSection,
        from: rawSection.from || js.stationNameForCode(rawSection.from_n02_station_code),
        to: rawSection.to || js.stationNameForCode(rawSection.to_n02_station_code),
      };
      const allowed = train.route_policy?.allowed_institution_type_codes || ["1", "2", "3", "4", "5"];
      const endpoints = js.resolveSectionEndpoints(section, train, allowed);
      if (!endpoints.fromStations.length || !endpoints.toStations.length) continue;
      const base = js.buildSegmentRouteHints(
        section, endpoints.fromStations, endpoints.toStations, train,
      );
      cases.push({
        train: {
          id: train.id || "", number: train.number || "", trainType: train.train_type || "",
          company: train.company || "", origin: train.origin || "",
          destination: train.destination || "",
          preferredLineNames: train.route_policy?.preferred_line_names || [],
          preferredOperatorNames: train.route_policy?.preferred_operator_names || [],
          allowedInstitutionTypeCodes: train.route_policy?.allowed_institution_type_codes || null,
          institutionFilterMode: train.route_policy?.institution_filter_mode || "soft",
        },
        section,
        fromStationIndices: endpoints.fromStations.map((feature) => stationIndex.get(feature)),
        toStationIndices: endpoints.toStations.map((feature) => stationIndex.get(feature)),
        hints: cleanHints(base),
        attempts: js.buildSegmentRouteSolveAttempts(base).map(cleanHints),
      });
    }
  }
  return { country, cases };
}

export function build({ AppCore, RailNetwork, APP_DIR }) {
  const js = loadScope(APP_DIR, AppCore, RailNetwork);
  return {
    describes: "app-route-solver.js inferred segment hints and fallback attempt order",
    contract: "Swift must derive the same hard/soft line, operator and institution constraints and try them in the same order for shipped train sections.",
    cases: [countryCase(js, APP_DIR, "mo"), countryCase(js, APP_DIR, "hk")],
  };
}
