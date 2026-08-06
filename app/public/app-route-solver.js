// =========================================================================
//  app-route-solver.js — §29: route solving — institution/edge rules, route hints & Dijkstra
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §29.  Route solving: institution/edge rules, route hints & Dijkstra
// =========================================================================

function preferredInstitutionSet(allowedCodes) {
  return new Set((allowedCodes || []).map(String).filter(Boolean));
}

function edgeHasPreferredInstitution(edge, allowedCodes) {
  const allowed = preferredInstitutionSet(allowedCodes);
  if (!allowed.size) return true;
  if (edge?.is_station_connector) {
    // A transfer connector bridges two physical platforms in the same station
    // group. Only allow it when every platform institution it joins is permitted,
    // so a JR-only train cannot hop onto an Osaka-Metro / private platform that
    // happens to share the station group (e.g. 天王寺 group 007439). Unknown
    // institutions are treated as acceptable to avoid over-filtering.
    const codes = edge.institution_type_codes || [];
    if (!codes.length) return true;
    return codes.every((code) => !code || allowed.has(String(code)));
  }
  if (!edge?.institution_type_code) return true;
  return allowed.has(String(edge.institution_type_code));
}

function edgeMatchesAllowedCodes(edge, allowedCodes, train, segmentHints = {}) {
  const hardFilter =
    train?.route_policy?.institution_filter_mode === "hard" ||
    Boolean(segmentHints.requirePreferredInstitution);
  if (!hardFilter) return true;
  return edgeHasPreferredInstitution(edge, allowedCodes);
}

function institutionPreferencePenaltyForEdge(edge, allowedCodes, train) {
  if (train?.route_policy?.institution_filter_mode === "hard") return 0;
  const preferred = preferredInstitutionSet(allowedCodes);
  if (
    !preferred.size ||
    !edge.institution_type_code ||
    preferred.has(String(edge.institution_type_code))
  )
    return 0;
  return (
    edge.length * NON_PREFERRED_INSTITUTION_LENGTH_FACTOR +
    NON_PREFERRED_INSTITUTION_EDGE_PENALTY
  );
}

function graphNodeHasPreferredInstitution(meta, allowedCodes) {
  const preferred = preferredInstitutionSet(allowedCodes);
  if (!preferred.size) return true;
  return intersects(meta?.institution_type_codes, preferred);
}

function addStationTransferConnectorEdges(graph, stationFeatures) {
  const stations =
    stationFeatures || (stationsGeoJson && stationsGeoJson.features) || [];
  const groups = new Map();
  const edgeKeys = new Set();

  function stationTransferGroupKey(feature) {
    const groupCode = stationGroupCode(feature);
    if (groupCode) return `group:${groupCode}`;
    const coord = getFeatureDisplayCoordinate(feature) || [0, 0];
    const lonBucket = Math.round(Number(coord[0]) * 10) / 10;
    const latBucket = Math.round(Number(coord[1]) * 10) / 10;
    return `name:${stationName(feature)}@${lonBucket},${latBucket}`;
  }

  function getGroup(key) {
    if (!groups.has(key)) groups.set(key, new Map());
    return groups.get(key);
  }

  function rememberNode(group, nearest, feature) {
    if (
      !nearest ||
      !nearest.key ||
      nearest.distance > STATION_TRANSFER_MAX_SNAP_METERS
    )
      return;
    const existing = group.get(nearest.key);
    if (!existing || nearest.distance < existing.distance) {
      group.set(nearest.key, {
        key: nearest.key,
        distance: nearest.distance,
        station_name: stationName(feature),
        n02_group_code: stationGroupCode(feature),
        line_name: stationLineName(feature),
        operator: stationOperator(feature),
        institution_type_code: stationInstitutionTypeCode(feature),
      });
    }
  }

  stations.forEach((feature) => {
    const key = stationTransferGroupKey(feature);
    const group = getGroup(key);
    const sourceLines = iterateGeometryLines(feature.geometry);
    const sourceCoords = sourceLines.length
      ? sourceLines.flat()
      : [getFeatureDisplayCoordinate(feature)];
    sourceCoords.forEach((coord) => {
      nearbyGraphNodes(
        coord,
        graph,
        STATION_TRANSFER_NODE_RADIUS_DEG,
        30,
      ).forEach((nearest) => rememberNode(group, nearest, feature));
    });
  });

  function addConnectorEdge(a, b, infoA, infoB) {
    if (!a || !b || a === b) return;
    const key = [a, b].sort().join("|");
    if (edgeKeys.has(key)) return;
    const aCoord = graph.nodes.get(a);
    const bCoord = graph.nodes.get(b);
    if (!aCoord || !bCoord) return;
    const gap = distanceMeters(aCoord, bCoord);
    if (gap > STATION_TRANSFER_MAX_NODE_GAP_METERS) return;
    edgeKeys.add(key);
    // Record the institution of each bridged platform so the institution filter
    // can reject connectors that would cross into a non-allowed operator class.
    const institutionTypeCodes = [
      ...new Set(
        [infoA?.institution_type_code, infoB?.institution_type_code]
          .map((c) => String(c || ""))
          .filter(Boolean),
      ),
    ];
    const baseEdge = {
      to: b,
      length: Math.max(gap + STATION_TRANSFER_EDGE_PENALTY, 0.01),
      institution_type_code: "",
      institution_type_codes: institutionTypeCodes,
      railway_class_code: "",
      line_name: "",
      operator: "",
      is_station_connector: true,
      station_name: infoA?.station_name || "",
      n02_group_code: infoA?.n02_group_code || "",
    };
    graph.adjacency.get(a).push(baseEdge);
    graph.adjacency.get(b).push({ ...baseEdge, to: a });
  }

  groups.forEach((nodeMap) => {
    const nodes = [...nodeMap.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, STATION_TRANSFER_MAX_NODES_PER_GROUP);
    for (let i = 0; i < nodes.length - 1; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        addConnectorEdge(nodes[i].key, nodes[j].key, nodes[i], nodes[j]);
      }
    }
  });
}

function stationMatchesPreferredInstitution(feature, allowedCodes) {
  const preferred = preferredInstitutionSet(allowedCodes);
  if (!preferred.size) return true;
  const code = stationInstitutionTypeCode(feature);
  return !code || preferred.has(String(code));
}

function filterStationsByPreferredInstitution(features, allowedCodes) {
  return (features || []).filter((feature) =>
    stationMatchesPreferredInstitution(feature, allowedCodes),
  );
}

function stationSetFrom(features, getter) {
  return new Set(
    (features || []).map(getter).filter((value) => value && value !== "-"),
  );
}

function filterStationCandidatesNear(
  features,
  referenceFeatures,
  maxDistanceMeters = 1800,
) {
  if (!features?.length || !referenceFeatures?.length) return [];
  return (features || []).filter((feature) => {
    const coord = getFeatureDisplayCoordinate(feature);
    return (referenceFeatures || []).some((reference) => {
      const referenceCoord = getFeatureDisplayCoordinate(reference);
      return (
        coord &&
        referenceCoord &&
        distanceMeters(coord, referenceCoord) <= maxDistanceMeters
      );
    });
  });
}

function resolveRouteEndpointStationCandidates(endpoint, train, allowedCodes) {
  const candidates = resolveStationCandidates(endpoint);
  const name = typeof endpoint === "string" ? endpoint : stopName(endpoint);
  const code = typeof endpoint === "string" ? null : stopStationCode(endpoint);
  if (!name || !code || !candidates.length) return candidates;

  const preferredCandidates = filterStationsByPreferredInstitution(
    candidates,
    allowedCodes,
  );
  const sameNameCandidates = resolveStationCandidates({
    name,
    n02_station_code: null,
  });
  const sameNamePreferred = filterStationsByPreferredInstitution(
    sameNameCandidates,
    allowedCodes,
  );
  const nearbySameNamePreferred = filterStationCandidatesNear(
    sameNamePreferred,
    candidates,
    1800,
  );

  // N02 station codes are line-specific.  Long limited-express segments often
  // omit intermediate stops, so the endpoint code may be a same-station line
  // that is not the actual through route (for example 大分 on 久大線 while
  // ソニック should leave via 日豊線, or 大月/Fuji-Q through-running points).
  // Keep the exact code as a fallback, but add nearby same-name candidates in
  // the preferred institution class so Dijkstra can infer the real railroad
  // between distant stop pairs.
  if (nearbySameNamePreferred.length) {
    return dedupeStationFeatures([...candidates, ...nearbySameNamePreferred]);
  }

  if (preferredCandidates.length) return candidates;

  const sameNamePreferredFallback = filterStationsByPreferredInstitution(
    sameNameCandidates,
    allowedCodes,
  );
  if (!sameNamePreferredFallback.length) return candidates;

  console.warn(
    "Route endpoint code resolves only to non-preferred institution; adding same-name preferred-institution candidates.",
    {
      train_id: train?.id,
      station: name,
      n02_station_code: code,
      allowed_institution_type_codes: allowedCodes,
      exact_candidates: candidates.map((feature) => ({
        name: stationName(feature),
        n02_station_code: stationCode(feature),
        line_name: stationLineName(feature),
        operator: stationOperator(feature),
        institution_type_code: stationInstitutionTypeCode(feature),
      })),
      preferred_same_name_candidates: sameNamePreferredFallback.map(
        (feature) => ({
          name: stationName(feature),
          n02_station_code: stationCode(feature),
          line_name: stationLineName(feature),
          operator: stationOperator(feature),
          institution_type_code: stationInstitutionTypeCode(feature),
        }),
      ),
    },
  );
  return dedupeStationFeatures([...candidates, ...sameNamePreferredFallback]);
}

function edgeMatchesRequiredHints(edge, segmentHints) {
  const requiredLines = segmentHints.requiredLines || new Set();
  const requiredOperators = segmentHints.requiredOperators || new Set();

  // route_sections[].line_names / operator_names are explicit per-segment
  // constraints.  Short in-station connector edges are allowed so line-specific
  // station codes can still reach the actual RailroadSection geometry at the
  // same physical station.
  if (edge.is_station_connector) return true;
  if (requiredLines.size && !requiredLines.has(edge.line_name || ""))
    return false;
  if (requiredOperators.size && !requiredOperators.has(edge.operator || ""))
    return false;
  return true;
}

function solveRouteSectionOnN02Graph(
  section,
  segmentIndex,
  train,
  graph,
  allowedCodes,
  continuityAnchor = null,
) {
  const { fromStations, toStations } = resolveSectionEndpoints(
    section,
    train,
    allowedCodes,
  );

  if (!fromStations.length || !toStations.length) {
    console.warn(
      "Route section endpoint station not found; segment skipped.",
      section,
    );
    return null;
  }

  const baseHints = buildSegmentRouteHints(
    section,
    fromStations,
    toStations,
    train,
  );
  const solveAttempts = buildSegmentRouteSolveAttempts(baseHints);

  let best = null;
  let usedHints = null;
  let lastCandidateFailure = false;

  for (const segmentHints of solveAttempts) {
    let fromCandidates = collectStationCandidateGraphNodes(
      fromStations,
      graph,
      segmentHints,
      allowedCodes,
    ).slice(0, 12);
    if (continuityAnchor) {
      const continuousCandidates = fromCandidates.filter((candidate) => {
        const stationCoord = getFeatureDisplayCoordinate(
          candidate.stationFeature,
        );
        return (
          stationCoord &&
          distanceMeters(stationCoord, continuityAnchor) <=
            ROUTE_SECTION_CONTINUITY_STATION_METERS
        );
      });
      if (continuousCandidates.length) fromCandidates = continuousCandidates;
    }
    const toCandidates = collectStationCandidateGraphNodes(
      toStations,
      graph,
      segmentHints,
      allowedCodes,
    ).slice(0, 12);
    if (!fromCandidates.length || !toCandidates.length) {
      lastCandidateFailure = true;
      continue;
    }

    // ONE multi-source → multi-target Dijkstra per attempt instead of a
    // from×to nested loop of full runs (12×12 = up to 144 per attempt). All
    // from-candidates are seeded into the heap at their snap-penalty cost, so
    // each settled target yields the pair-optimal (path cost + from-snap)
    // route; the to-snap and line-mismatch scoring below is unchanged.
    let attemptBest = null;
    const fromByKey = new Map(fromCandidates.map((c) => [c.key, c]));
    const toByKey = new Map(toCandidates.map((c) => [c.key, c]));
    const solvedTargets = dijkstraFromCandidateSources(
      graph,
      fromCandidates,
      new Set(toByKey.keys()),
      train,
      allowedCodes,
      segmentHints,
    );
    solvedTargets.forEach((solved) => {
      if (!solved.pathKeys || solved.pathKeys.length < 2) return;
      const fromCandidate = fromByKey.get(solved.sourceKey);
      const toCandidate = toByKey.get(solved.targetKey);
      if (!fromCandidate || !toCandidate) return;
      const straight = distanceMeters(
        graph.nodes.get(fromCandidate.key),
        graph.nodes.get(toCandidate.key),
      );
      const physicalLength = pathLengthMeters(graph, solved.pathKeys);
      const detourLimit = Math.max(straight * 3.8 + 6000, 12000);
      if (straight > 1500 && physicalLength > detourLimit) {
        console.warn("Rejected likely detour path.", {
          section,
          physicalLength,
          straight,
          detourLimit,
          hints: segmentHints,
        });
        return;
      }
      // Snap distance is not a drawable route. Treat it as an error term, not
      // as a cheap substitute for real rail geometry. This prevents short
      // segments such as 成田空港→空港第2ビル from being truncated by choosing
      // two far-along station candidates whose Dijkstra path is only a few
      // dozen meters long.
      const snapPenalty =
        (fromCandidate.distance + toCandidate.distance) *
        STATION_SNAP_COST_FACTOR;
      const totalCost = solved.cost + snapPenalty;
      const linePenalty = routeLineMismatchPenalty(
        graph,
        solved.pathKeys,
        segmentHints,
      );
      const scoredCost = totalCost + linePenalty;
      if (!attemptBest || scoredCost < attemptBest.scoredCost) {
        attemptBest = {
          pathKeys: solved.pathKeys,
          scoredCost,
          totalCost,
          physicalLength,
          snapFrom: fromCandidate.distance,
          snapTo: toCandidate.distance,
          fromCandidate,
          toCandidate,
        };
      }
    });

    // Important: the first successful attempt wins. This prevents a soft fallback
    // from adding/choosing a parallel or detour route when the strict N02 route-line
    // constraint already produced a valid single primary segment.
    if (
      attemptBest &&
      attemptBest.pathKeys &&
      attemptBest.pathKeys.length >= 2
    ) {
      best = attemptBest;
      usedHints = segmentHints;
      break;
    }
  }

  if (!best || !best.pathKeys || best.pathKeys.length < 2) {
    console.warn(
      "No graph path found for route section; segment skipped.",
      section,
      baseHints,
      { lastCandidateFailure },
    );
    return null;
  }

  const segmentHints = usedHints || baseHints;
  const rawCoordinates = best.pathKeys.map((key) => graph.nodes.get(key));
  let coordinates = completeRouteEndpointCoordinates(
    rawCoordinates,
    best.fromCandidate?.stationFeature || fromStations[0],
    best.toCandidate?.stationFeature || toStations[0],
  );
  if (
    continuityAnchor &&
    coordinates.length &&
    distanceMeters(continuityAnchor, coordinates[0]) <=
      ROUTE_SECTION_CONTINUITY_STATION_METERS
  ) {
    coordinates = coordinatesClose(continuityAnchor, coordinates[0], 0.25)
      ? [continuityAnchor, ...coordinates.slice(1)]
      : [continuityAnchor, ...coordinates];
  }
  return {
    type: "Feature",
    properties: {
      train_id: train.id,
      route_id: `${train.id}-runtime-primary`,
      variant_rank: 0,
      is_primary: true,
      route_choice: "single_best_path",
      geometry_role: "single_primary_segment",
      source:
        "browser_dijkstra_on_embedded_n02_railroadsection_graph_python_equivalent",
      segment_index: segmentIndex,
      from: section.from || stationName(fromStations[0]),
      to: section.to || stationName(toStations[0]),
      from_n02_station_code:
        section.from_n02_station_code || stationCode(fromStations[0]),
      to_n02_station_code:
        section.to_n02_station_code || stationCode(toStations[0]),
      allowed_institution_type_codes: allowedCodes,
      preferred_line_names: [...segmentHints.preferredLines],
      required_line_names: [...segmentHints.requiredLines],
      required_operator_names: [...segmentHints.requiredOperators],
      preferred_operator_names: [...segmentHints.preferredOperators],
      solve_mode: segmentHints.solve_mode || "base",
      require_preferred_institution: Boolean(
        segmentHints.requirePreferredInstitution,
      ),
      used_institution_type_codes: usedInstitutionTypeCodes(
        graph,
        best.pathKeys,
      ),
      route_template_key: routeKeyDigest(getTrainRouteTemplateKey(train)),
      path_coordinate_count: coordinates.length,
      raw_path_coordinate_count: rawCoordinates.length,
      snap_distance_m: {
        from: Math.round(best.snapFrom * 100) / 100,
        to: Math.round(best.snapTo * 100) / 100,
      },
      endpoint_display_gap_m: {
        from:
          Math.round(
            distanceMeters(
              getFeatureDisplayCoordinate(
                best.fromCandidate?.stationFeature || fromStations[0],
              ),
              rawCoordinates[0],
            ) * 100,
          ) / 100,
        to:
          Math.round(
            distanceMeters(
              getFeatureDisplayCoordinate(
                best.toCandidate?.stationFeature || toStations[0],
              ),
              rawCoordinates[rawCoordinates.length - 1],
            ) * 100,
          ) / 100,
      },
      physical_length_m:
        Math.round(pathLengthForCoordinates(coordinates) * 100) / 100,
      raw_physical_length_m: Math.round(best.physicalLength * 100) / 100,
      cost: Math.round(best.totalCost * 100) / 100,
    },
    geometry: { type: "LineString", coordinates },
  };
}

function normalizeRouteHintText(value) {
  return String(value || "").trim();
}

function sectionEndpointNames(section) {
  return [
    normalizeRouteHintText(section?.from),
    normalizeRouteHintText(section?.to),
  ].filter(Boolean);
}

function sectionHasAnyEndpoint(section, names) {
  const endpoints = sectionEndpointNames(section);
  return endpoints.some((name) => names.includes(name));
}

function sectionHasEndpointPair(section, aNames, bNames) {
  const endpoints = sectionEndpointNames(section);
  return (
    endpoints.some((name) => aNames.includes(name)) &&
    endpoints.some((name) => bNames.includes(name))
  );
}

function inferSectionRouteConstraints(section, train) {
  const text = [
    train?.id,
    train?.number,
    train?.train_type,
    train?.company,
    train?.origin,
    train?.destination,
  ]
    .map(normalizeRouteHintText)
    .join(" ");
  const lineNames = new Set();
  const operatorNames = new Set();

  // JR Kyushu Sonic: N02 often gives 大分 as 久大線 and 小倉 as 鹿児島線,
  // while the actual limited express runs on 日豊線 between 大分/別府/中津/小倉.
  if (
    /ソニック|sonic/i.test(text) &&
    sectionHasAnyEndpoint(section, ["大分", "別府", "中津", "小倉"])
  ) {
    lineNames.add("日豊線");
    operatorNames.add("九州旅客鉄道");
  }

  // Haruka: keep the route on JR West around Kansai Airport/Osaka and stop
  // the solver from preferring nearby subway geometry at 天王寺/大阪/新大阪.
  if (/はるか|haruka/i.test(text)) {
    operatorNames.add("西日本旅客鉄道");
    if (sectionHasEndpointPair(section, ["関西空港"], ["日根野"]))
      lineNames.add("関西空港線");
    else if (sectionHasEndpointPair(section, ["日根野"], ["天王寺"]))
      lineNames.add("阪和線");
    else if (sectionHasEndpointPair(section, ["天王寺"], ["大阪"]))
      lineNames.add("大阪環状線");
    else if (sectionHasEndpointPair(section, ["大阪"], ["新大阪"]))
      lineNames.add("東海道線");
  }

  return {
    line_names: [...lineNames],
    operator_names: [...operatorNames],
  };
}

function buildSegmentRouteHints(section, fromStations, toStations, train) {
  const allowedCodes = getAllowedInstitutionTypeCodes(train);
  const preferredLines = new Set(
    (train.route_policy?.preferred_line_names || [])
      .map(String)
      .filter(Boolean),
  );
  const preferredOperators = new Set(
    [
      ...(train.route_policy?.preferred_operator_names || []),
      // 公司 field soft-biases the solver toward that operator's tracks.
      ...derivedPreferredOperatorNames(train),
    ]
      .map(String)
      .filter(Boolean),
  );
  const inferredConstraints = inferSectionRouteConstraints(section, train);
  const explicitRequiredLines = new Set([
    ...(section.line_names || []).map(String).filter(Boolean),
    ...(inferredConstraints.line_names || []),
  ]);
  const explicitRequiredOperators = new Set([
    ...(section.operator_names || [])
      .map(String)
      .filter(Boolean),
    ...(inferredConstraints.operator_names || []),
  ]);
  const requiredLines = new Set(explicitRequiredLines);
  const requiredOperators = new Set(explicitRequiredOperators);
  requiredLines.forEach((value) => value && preferredLines.add(value));
  requiredOperators.forEach((value) => value && preferredOperators.add(value));

  const fromPreferredInstitutionStations = filterStationsByPreferredInstitution(
    fromStations,
    allowedCodes,
  );
  const toPreferredInstitutionStations = filterStationsByPreferredInstitution(
    toStations,
    allowedCodes,
  );
  const fromPreferredPool = fromPreferredInstitutionStations.length
    ? fromPreferredInstitutionStations
    : fromStations;
  const toPreferredPool = toPreferredInstitutionStations.length
    ? toPreferredInstitutionStations
    : toStations;

  const fromLines = stationSetFrom(fromStations, stationLineName);
  const toLines = stationSetFrom(toStations, stationLineName);
  const fromOperators = stationSetFrom(fromStations, stationOperator);
  const toOperators = stationSetFrom(toStations, stationOperator);
  const fromPreferredLines = stationSetFrom(fromPreferredPool, stationLineName);
  const toPreferredLines = stationSetFrom(toPreferredPool, stationLineName);
  const fromPreferredOperators = stationSetFrom(
    fromPreferredPool,
    stationOperator,
  );
  const toPreferredOperators = stationSetFrom(toPreferredPool, stationOperator);

  const allCommonLines = new Set(
    [...fromLines].filter((line) => toLines.has(line)),
  );
  const allCommonOperators = new Set(
    [...fromOperators].filter((operator) => toOperators.has(operator)),
  );
  const preferredInstitutionCommonLines = new Set(
    [...fromPreferredLines].filter((line) => toPreferredLines.has(line)),
  );
  const preferredInstitutionCommonOperators = new Set(
    [...fromPreferredOperators].filter((operator) =>
      toPreferredOperators.has(operator),
    ),
  );

  // For JR/Shinkansen/JR-conventional trains, common subway/private station
  // names at large interchanges should not become equally good hints.  Prefer
  // common lines/operators from the allowed institution class first, and keep
  // all-company common hints only as a fallback.
  const commonLines = preferredInstitutionCommonLines.size
    ? preferredInstitutionCommonLines
    : allCommonLines;
  const commonOperators = preferredInstitutionCommonOperators.size
    ? preferredInstitutionCommonOperators
    : allCommonOperators;

  commonLines.forEach((line) => preferredLines.add(line));
  commonOperators.forEach((operator) => preferredOperators.add(operator));
  if (!preferredLines.size && fromPreferredLines.size === 1)
    fromPreferredLines.forEach((line) => preferredLines.add(line));
  if (!preferredLines.size && toPreferredLines.size === 1)
    toPreferredLines.forEach((line) => preferredLines.add(line));
  if (
    !preferredOperators.size &&
    fromPreferredOperators.size === 1 &&
    toPreferredOperators.size === 1
  ) {
    const fromOperator = [...fromPreferredOperators][0];
    const toOperator = [...toPreferredOperators][0];
    if (fromOperator === toOperator) preferredOperators.add(fromOperator);
  }

  return {
    preferredLines,
    preferredOperators,
    requiredLines,
    requiredOperators,
    explicitRequiredLines,
    explicitRequiredOperators,
    commonLines,
    commonOperators,
    allCommonLines,
    allCommonOperators,
    preferredInstitutionCommonLines,
    preferredInstitutionCommonOperators,
    fromLines,
    toLines,
    fromOperators,
    toOperators,
    fromPreferredLines,
    toPreferredLines,
    fromPreferredOperators,
    toPreferredOperators,
    requirePreferredInstitution: false,
    solve_mode: "base",
  };
}

function cloneSegmentHints(baseHints, overrides = {}) {
  return {
    preferredLines: new Set(
      overrides.preferredLines || baseHints.preferredLines || [],
    ),
    preferredOperators: new Set(
      overrides.preferredOperators || baseHints.preferredOperators || [],
    ),
    requiredLines: new Set(
      overrides.requiredLines || baseHints.requiredLines || [],
    ),
    requiredOperators: new Set(
      overrides.requiredOperators || baseHints.requiredOperators || [],
    ),
    explicitRequiredLines: new Set(baseHints.explicitRequiredLines || []),
    explicitRequiredOperators: new Set(
      baseHints.explicitRequiredOperators || [],
    ),
    commonLines: new Set(baseHints.commonLines || []),
    commonOperators: new Set(baseHints.commonOperators || []),
    allCommonLines: new Set(baseHints.allCommonLines || []),
    allCommonOperators: new Set(baseHints.allCommonOperators || []),
    preferredInstitutionCommonLines: new Set(
      baseHints.preferredInstitutionCommonLines || [],
    ),
    preferredInstitutionCommonOperators: new Set(
      baseHints.preferredInstitutionCommonOperators || [],
    ),
    fromLines: new Set(baseHints.fromLines || []),
    toLines: new Set(baseHints.toLines || []),
    fromOperators: new Set(baseHints.fromOperators || []),
    toOperators: new Set(baseHints.toOperators || []),
    fromPreferredLines: new Set(baseHints.fromPreferredLines || []),
    toPreferredLines: new Set(baseHints.toPreferredLines || []),
    fromPreferredOperators: new Set(baseHints.fromPreferredOperators || []),
    toPreferredOperators: new Set(baseHints.toPreferredOperators || []),
    requirePreferredInstitution: Boolean(
      overrides.requirePreferredInstitution ??
      baseHints.requirePreferredInstitution,
    ),
    solve_mode: overrides.solve_mode || baseHints.solve_mode || "base",
  };
}

function buildSegmentRouteSolveAttempts(baseHints) {
  const attempts = [];
  const explicitLines = baseHints.explicitRequiredLines || new Set();
  const explicitOperators = baseHints.explicitRequiredOperators || new Set();
  const commonLines = baseHints.commonLines || new Set();
  const commonOperators = baseHints.commonOperators || new Set();

  function pushAttempt(overrides) {
    const attempt = cloneSegmentHints(baseHints, overrides);
    const key = [
      attempt.solve_mode,
      attempt.requirePreferredInstitution ? "home" : "soft",
      [...(attempt.requiredLines || [])].sort().join(","),
      [...(attempt.requiredOperators || [])].sort().join(","),
    ].join("|");
    if (attempts.some((existing) => existing.__attemptKey === key)) return;
    attempt.__attemptKey = key;
    attempts.push(attempt);
  }

  // Strict section hints, including inferred known-service constraints such
  // as Sonic=日豊線/九州旅客鉄道 and Haruka=JR西日本 lines, are tried first.
  if (explicitLines.size) {
    pushAttempt({
      requiredLines: explicitLines,
      requiredOperators: explicitOperators,
      requirePreferredInstitution: true,
      solve_mode: "explicit_section_route_required_home_institution",
    });
    pushAttempt({
      requiredLines: explicitLines,
      requiredOperators: explicitOperators,
      requirePreferredInstitution: false,
      solve_mode: "explicit_section_route_required_soft_institution",
    });
    return attempts;
  }

  if (explicitOperators.size) {
    // Only an operator is pinned (e.g. inferred 西日本旅客鉄道) and the JSON gave no
    // explicit line — common when the route is split at every pass-through stop.
    // Prefer the single line shared by both endpoints BEFORE falling back to
    // operator-only, so finely-split sections follow the real through line instead
    // of wandering onto a parallel same-operator line at big interchanges (the
    // cause of はるか drifting around 天王寺/新今宮).
    if (commonLines.size) {
      pushAttempt({
        requiredLines: commonLines,
        requiredOperators: explicitOperators,
        requirePreferredInstitution: true,
        solve_mode: "operator_pinned_common_line_required_home_institution",
      });
      pushAttempt({
        requiredLines: commonLines,
        requiredOperators: explicitOperators,
        requirePreferredInstitution: false,
        solve_mode: "operator_pinned_common_line_required_soft_institution",
      });
    }
    pushAttempt({
      requiredLines: new Set(),
      requiredOperators: explicitOperators,
      requirePreferredInstitution: true,
      solve_mode: "explicit_operator_required_home_institution",
    });
    pushAttempt({
      requiredLines: new Set(),
      requiredOperators: explicitOperators,
      requirePreferredInstitution: false,
      solve_mode: "explicit_operator_required_soft_institution",
    });
    return attempts;
  }

  if (commonLines.size && commonOperators.size) {
    pushAttempt({
      requiredLines: commonLines,
      requiredOperators: commonOperators,
      requirePreferredInstitution: true,
      solve_mode: "common_line_and_operator_required_home_institution",
    });
  }

  if (commonLines.size) {
    pushAttempt({
      requiredLines: commonLines,
      requiredOperators: new Set(),
      requirePreferredInstitution: true,
      solve_mode: "common_line_required_home_institution",
    });
  }

  if (commonOperators.size) {
    pushAttempt({
      requiredLines: new Set(),
      requiredOperators: commonOperators,
      requirePreferredInstitution: true,
      solve_mode: "common_operator_required_home_institution",
    });
  }

  pushAttempt({
    requiredLines: baseHints.requiredLines,
    requiredOperators: baseHints.requiredOperators,
    requirePreferredInstitution: true,
    solve_mode: "home_institution_soft_line_operator_hints",
  });

  // Only after all home-institution / same-operator attempts fail do we allow
  // other operators. The large non-preferred penalties still keep fallback
  // routes from snapping to subway/private lines unless the home route is
  // unavailable or an extreme detour.
  if (commonLines.size) {
    pushAttempt({
      requiredLines: commonLines,
      requiredOperators: new Set(),
      requirePreferredInstitution: false,
      solve_mode: "common_line_required_other_operator_fallback",
    });
  }

  pushAttempt({
    requiredLines: baseHints.requiredLines,
    requiredOperators: baseHints.requiredOperators,
    requirePreferredInstitution: false,
    solve_mode:
      commonLines.size || commonOperators.size
        ? "soft_fallback_after_home_attempts"
        : "no_common_line_soft_fallback",
  });

  // Final safety net: a fully unbiased, institution-only attempt with the
  // preferred line/operator hints CLEARED. Every attempt above keeps the
  // preferred-line penalty, which can make a long same-line detour cheaper
  // than the real path when a segment must leave the shared line onto a
  // branch/through line (e.g. 宇和海 between 伊予大洲 and 内子 must run
  // 予讃線 -> 内子線 -> 予讃線). Those detours then trip the detour guard and
  // the whole segment gets dropped, leaving a big visible gap. Clearing the
  // hints lets the shortest valid JR path win instead of cutting the segment
  // off. It runs last, so it only takes over when every biased attempt failed.
  pushAttempt({
    requiredLines: new Set(),
    requiredOperators: new Set(),
    preferredLines: new Set(),
    preferredOperators: new Set(),
    requirePreferredInstitution: true,
    solve_mode: "institution_only_unbiased_fallback",
  });

  return attempts;
}

function usedInstitutionTypeCodes(graph, pathKeys) {
  const used = new Set();
  for (let i = 0; i < pathKeys.length - 1; i += 1) {
    const edge = findEdge(graph, pathKeys[i], pathKeys[i + 1]);
    if (edge?.institution_type_code)
      used.add(String(edge.institution_type_code));
  }
  return [...used].sort();
}

// Per-edge penalty for leaving the preferred line/operator. Shared by the
// Dijkstra edge relaxation and the post-hoc whole-path scoring so the penalty
// formula has one definition. Callers must skip station-connector edges.
function nonPreferredLineOperatorPenalty(
  edge,
  preferredLines,
  preferredOperators,
) {
  let penalty = 0;
  if (
    preferredLines.size &&
    edge.line_name &&
    !preferredLines.has(edge.line_name)
  ) {
    penalty += edge.length * NON_PREFERRED_LINE_LENGTH_FACTOR;
  }
  if (
    preferredOperators.size &&
    edge.operator &&
    !preferredOperators.has(edge.operator)
  ) {
    penalty += edge.length * NON_PREFERRED_OPERATOR_LENGTH_FACTOR;
  }
  return penalty;
}

function routeLineMismatchPenalty(graph, pathKeys, segmentHints) {
  const preferredLines = segmentHints.preferredLines || new Set();
  const preferredOperators = segmentHints.preferredOperators || new Set();
  if (!preferredLines.size && !preferredOperators.size) return 0;
  let penalty = 0;
  for (let i = 0; i < pathKeys.length - 1; i += 1) {
    const edge = findEdge(graph, pathKeys[i], pathKeys[i + 1]);
    if (!edge || edge.is_station_connector) continue;
    penalty += nonPreferredLineOperatorPenalty(
      edge,
      preferredLines,
      preferredOperators,
    );
  }
  return penalty;
}

function findEdge(graph, fromKey, toKey) {
  return (
    (graph.adjacency.get(fromKey) || []).find((edge) => edge.to === toKey) ||
    null
  );
}

function collectStationCandidateGraphNodes(
  stationFeatures,
  graph,
  hints,
  allowedCodes,
) {
  // Several line-specific station records can snap to the same graph node.
  // Keep the best candidate for that node instead of whichever station
  // feature happened to appear first.  The latter can preserve a distant
  // same-name platform and later make endpoint completion draw a long spike.
  const candidateByKey = new Map();
  stationFeatures.forEach((feature) => {
    getStationCandidateGraphNodes(feature, graph, hints, allowedCodes).forEach(
      (candidate) => {
        const previous = candidateByKey.get(candidate.key);
        if (
          !previous ||
          candidate.score < previous.score ||
          (candidate.score === previous.score &&
            candidate.distance < previous.distance)
        ) {
          candidateByKey.set(candidate.key, candidate);
        }
      },
    );
  });
  const candidates = [...candidateByKey.values()];
  candidates.sort((a, b) => a.score - b.score || a.distance - b.distance);
  return candidates;
}

function getStationCandidateGraphNodes(
  stationFeature,
  graph,
  hints = { preferredLines: new Set(), preferredOperators: new Set() },
  allowedCodes = [...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES],
) {
  const allowedKey = (allowedCodes || []).map(String).sort().join(",");
  // N02 can contain multiple physical station geometries with the same code,
  // line and operator (for example the two 白島線 八丁堀 records).  Geometry
  // must therefore participate in the cache key or one platform can reuse
  // another platform's graph-node candidates.
  const stationGeometryKey = JSON.stringify(
    stationFeature?.geometry?.coordinates ||
      getFeatureDisplayCoordinate(stationFeature) ||
      null,
  );
  const cacheKey = `${stationCode(stationFeature) || stationName(stationFeature)}|${stationLineName(stationFeature)}|${stationOperator(stationFeature)}|geometry:${stationGeometryKey}|${allowedKey}|home:${hints.requirePreferredInstitution ? 1 : 0}|reqL:${[...(hints.requiredLines || [])].join("/")}|reqO:${[...(hints.requiredOperators || [])].join("/")}|prefL:${[...(hints.preferredLines || [])].join("/")}|prefO:${[...(hints.preferredOperators || [])].join("/")}`;
  if (cacheKey && graph.stationSnapCache.has(cacheKey))
    return graph.stationSnapCache.get(cacheKey);

  const candidateMap = new Map();
  const sourceLines = iterateGeometryLines(stationFeature.geometry);
  const sourceCoords = sourceLines.length
    ? sourceLines.flat()
    : [getFeatureDisplayCoordinate(stationFeature)];
  const stationLine = stationLineName(stationFeature);
  const stationOperatorName = stationOperator(stationFeature);

  function maybeUpsertCandidate(nearest) {
    if (!nearest || !nearest.key) return;
    const meta = graph.nodeMeta.get(nearest.key);
    if (!meta) return;
    const hasPreferredInstitution = graphNodeHasPreferredInstitution(
      meta,
      allowedCodes,
    );
    if (hints.requirePreferredInstitution && !hasPreferredInstitution) return;
    if (
      (hints.requiredLines || new Set()).size &&
      !intersects(hints.requiredLines, meta.line_names)
    )
      return;
    if (
      (hints.requiredOperators || new Set()).size &&
      !intersects(hints.requiredOperators, meta.operators)
    )
      return;
    let score = nearest.distance;
    if (stationLine && meta.line_names?.has(stationLine)) score -= 40;
    if (stationOperatorName && meta.operators?.has(stationOperatorName))
      score -= 15;
    if (intersects(hints.preferredLines, meta.line_names)) {
      score -= 25;
    } else if ((hints.preferredLines || new Set()).size) {
      score += NON_PREFERRED_LINE_STATION_SNAP_PENALTY;
    }
    if (intersects(hints.preferredOperators, meta.operators)) {
      score -= 10;
    } else if ((hints.preferredOperators || new Set()).size) {
      score += NON_PREFERRED_OPERATOR_STATION_SNAP_PENALTY;
    }
    if (!hasPreferredInstitution) score += NON_PREFERRED_STATION_SNAP_PENALTY;
    const candidate = {
      key: nearest.key,
      distance: nearest.distance,
      score,
      hasPreferredInstitution,
      stationFeature,
    };
    const previous = candidateMap.get(nearest.key);
    if (
      !previous ||
      candidate.score < previous.score ||
      (candidate.score === previous.score &&
        candidate.distance < previous.distance)
    ) {
      candidateMap.set(nearest.key, candidate);
    }
  }

  sourceCoords.forEach((coord) => {
    // Station geometries are often LineString objects. The same railroad node can be
    // discovered from multiple station-geometry vertices; keep the best snap per node
    // instead of freezing the first, possibly hundreds-of-meters-away encounter.
    nearbyGraphNodes(coord, graph, 0.006, 160).forEach((nearest) => {
      if (nearest.distance <= STATION_SNAP_MAX_DISTANCE_METERS)
        maybeUpsertCandidate(nearest);
    });
  });

  const candidates = [...candidateMap.values()].sort(
    (a, b) => a.score - b.score || a.distance - b.distance,
  );
  const sliced = candidates.slice(0, 16);
  graph.stationSnapCache.set(cacheKey, sliced);
  return sliced;
}

// Multi-source → multi-target Dijkstra. Every from-candidate is seeded into
// the heap at its snap-penalty cost (distance × STATION_SNAP_COST_FACTOR), so
// a single run over the graph settles, for each target node, the pair-optimal
// combination of (source snap + path cost) — replacing the former per-pair
// dijkstraBetweenExactNodes nested loop (up to sources×targets full runs per
// attempt) with exactly one run per attempt. The search stops as soon as all
// targets are settled. Each result reports which source won via `sourceKey`
// (tracked through relaxation) plus the PURE path cost with the seed snap
// penalty subtracted back out, so the caller's scoring stays unchanged.
function dijkstraFromCandidateSources(
  graph,
  sourceCandidates,
  targetKeys,
  train,
  allowedCodes,
  segmentHints = {
    preferredLines: new Set(),
    preferredOperators: new Set(),
    requiredLines: new Set(),
    requiredOperators: new Set(),
  },
) {
  const distance = new Map();
  const previous = new Map();
  const sourceOf = new Map();
  const seedCost = new Map();
  const heap = new MinHeap();
  sourceCandidates.forEach((candidate) => {
    const init = candidate.distance * STATION_SNAP_COST_FACTOR;
    if (init < (distance.get(candidate.key) ?? Infinity)) {
      distance.set(candidate.key, init);
      sourceOf.set(candidate.key, candidate.key);
      seedCost.set(candidate.key, init);
      heap.push({ key: candidate.key, priority: init });
    }
  });
  const visited = new Set();
  const remaining = new Set(targetKeys);
  const settled = [];

  while (heap.size() && remaining.size) {
    const current = heap.pop();
    if (visited.has(current.key)) continue;
    visited.add(current.key);
    if (remaining.has(current.key)) {
      remaining.delete(current.key);
      settled.push({ targetKey: current.key, settledCost: current.priority });
    }
    const edges = graph.adjacency.get(current.key) || [];
    edges.forEach((edge) => {
      if (!edgeMatchesAllowedCodes(edge, allowedCodes, train, segmentHints))
        return;
      if (!edgeMatchesRequiredHints(edge, segmentHints)) return;
      let weight =
        edge.length +
        (edge.is_station_connector
          ? 0
          : institutionPreferencePenaltyForEdge(edge, allowedCodes, train));
      // Preferred hints should be strong but not hard unless the user put them in section.line_names/operator_names.
      if (!edge.is_station_connector) {
        weight += nonPreferredLineOperatorPenalty(
          edge,
          segmentHints.preferredLines || new Set(),
          segmentHints.preferredOperators || new Set(),
        );
      }
      const nextCost = current.priority + weight;
      if (nextCost < (distance.get(edge.to) ?? Infinity)) {
        distance.set(edge.to, nextCost);
        previous.set(edge.to, current.key);
        sourceOf.set(edge.to, sourceOf.get(current.key));
        heap.push({ key: edge.to, priority: nextCost });
      }
    });
  }

  return settled.map((entry) => {
    const sourceKey = sourceOf.get(entry.targetKey);
    return {
      targetKey: entry.targetKey,
      sourceKey,
      // Pure path cost (matches the old per-pair solved.cost): subtract the
      // winning source's seeded snap cost back out.
      cost: entry.settledCost - (seedCost.get(sourceKey) || 0),
      pathKeys: reconstructPath(previous, sourceKey, entry.targetKey),
    };
  });
}

function pathLengthMeters(graph, pathKeys) {
  let length = 0;
  for (let i = 0; i < pathKeys.length - 1; i += 1) {
    length += distanceMeters(
      graph.nodes.get(pathKeys[i]),
      graph.nodes.get(pathKeys[i + 1]),
    );
  }
  return length;
}

function pathLengthForCoordinates(coordinates) {
  let length = 0;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    length += distanceMeters(coordinates[i], coordinates[i + 1]);
  }
  return length;
}

function completeRouteEndpointCoordinates(
  coordinates,
  fromStationFeature,
  toStationFeature,
) {
  if (!Array.isArray(coordinates) || coordinates.length < 2)
    return coordinates || [];
  let completed = trimRouteEndpointToStationDisplay(
    coordinates,
    fromStationFeature,
    true,
  );
  completed = trimRouteEndpointToStationDisplay(
    completed,
    toStationFeature,
    false,
  );
  return completed;
}

function trimRouteEndpointToStationDisplay(
  coordinates,
  stationFeature,
  isStart,
) {
  if (!stationFeature || !Array.isArray(coordinates) || coordinates.length < 2)
    return coordinates;
  const displayCoord = getFeatureDisplayCoordinate(stationFeature);
  if (!displayCoord) return coordinates;

  const endpointIndex = isStart ? 0 : coordinates.length - 1;
  const endpoint = coordinates[endpointIndex];
  if (coordinatesClose(displayCoord, endpoint, 1.5)) return coordinates;

  const searchLimit = Math.min(12, coordinates.length - 1);
  let best = null;
  const firstSegment = isStart
    ? 0
    : Math.max(0, coordinates.length - 1 - searchLimit);
  const lastSegment = isStart ? searchLimit - 1 : coordinates.length - 2;
  for (let i = firstSegment; i <= lastSegment; i += 1) {
    const projected = projectPointToSegmentMeters(
      displayCoord,
      coordinates[i],
      coordinates[i + 1],
    );
    if (projected.t < -0.02 || projected.t > 1.02) continue;
    if (!best || projected.distance < best.distance)
      best = { ...projected, index: i };
  }

  if (best && best.distance <= 45) {
    if (isStart) {
      const tail = coordinates.slice(best.index + 1);
      return coordinatesClose(displayCoord, tail[0], 1.5)
        ? tail
        : [displayCoord, ...tail];
    }
    const head = coordinates.slice(0, best.index + 1);
    return coordinatesClose(head[head.length - 1], displayCoord, 1.5)
      ? head
      : [...head, displayCoord];
  }

  // Airport and underground stations in N02 are represented as short station
  // LineStrings. If the chosen routable endpoint is one end of that station
  // geometry, add the station display point so the visible route reaches the
  // stop marker instead of appearing to break near the terminal.
  const stationGap = distanceMeters(displayCoord, endpoint);
  if (stationGap <= STATION_SNAP_MAX_DISTANCE_METERS) {
    return isStart
      ? [displayCoord, ...coordinates]
      : [...coordinates, displayCoord];
  }
  return coordinates;
}

function coordinatesClose(a, b, toleranceMeters = 1.5) {
  return a && b && distanceMeters(a, b) <= toleranceMeters;
}

function projectPointToSegmentMeters(point, a, b) {
  const lat =
    (((Number(point[1]) + Number(a[1]) + Number(b[1])) / 3) * Math.PI) / 180;
  const metersPerLon = 111320 * Math.cos(lat);
  const metersPerLat = 110540;
  const px = Number(point[0]) * metersPerLon;
  const py = Number(point[1]) * metersPerLat;
  const ax = Number(a[0]) * metersPerLon;
  const ay = Number(a[1]) * metersPerLat;
  const bx = Number(b[0]) * metersPerLon;
  const by = Number(b[1]) * metersPerLat;
  const dx = bx - ax;
  const dy = by - ay;
  const denom = dx * dx + dy * dy;
  const t = denom > 0 ? ((px - ax) * dx + (py - ay) * dy) / denom : 0;
  const clamped = Math.max(0, Math.min(1, t));
  const qx = ax + clamped * dx;
  const qy = ay + clamped * dy;
  return {
    distance: Math.hypot(px - qx, py - qy),
    t,
  };
}

function reconstructPath(previous, sourceKey, targetKey) {
  const path = [targetKey];
  let current = targetKey;
  while (current !== sourceKey) {
    current = previous.get(current);
    if (!current) return [];
    path.push(current);
  }
  path.reverse();
  return path;
}

function normalizeGraphCoord(coord) {
  // AppCore.quant5 is the single owner of the N02 5-decimal grid rule: graph
  // nodes, stats edge keys, deck segment keys and the build-time station
  // expansion must all quantize identically or cross-module coordinate
  // identities drift apart.
  return [
    window.AppCore.quant5(Number(coord[0])),
    window.AppCore.quant5(Number(coord[1])),
  ];
}

// Hot enough (two calls per drawn route segment — ~700k per full-Japan
// repaint) that the intermediate array normalizeGraphCoord returns is worth
// skipping. Same quant5 rule, same bytes.
function coordKey(coord) {
  const quant5 = window.AppCore.quant5;
  return quant5(Number(coord[0])) + "," + quant5(Number(coord[1]));
}

function graphGridKey(coord, cellSize) {
  const [lon, lat] = normalizeGraphCoord(coord);
  return `${Math.floor(lon / cellSize)},${Math.floor(lat / cellSize)}`;
}

function distanceMeters(a, b) {
  const lon1 = Number(a[0]);
  const lat1 = Number(a[1]);
  const lon2 = Number(b[0]);
  const lat2 = Number(b[1]);
  const radius = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const x =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(x));
}
