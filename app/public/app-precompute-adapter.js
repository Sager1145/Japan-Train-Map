// =========================================================================
//  app-precompute-adapter.js — explicit offline precompute contract
//
//  The Node VM calls this single global adapter instead of reaching into the
//  app family's arbitrary lexical state. Browser behavior is unchanged.
// =========================================================================

async function precomputeTrainStoreParts(host) {
  activeCountry = host.country;
  AppDatasets.installRailSections(host.railSections);
  AppDatasets.installStations(host.stations);
  AppDatasets.installMatchedData({
    matchedRoutes: { type: "FeatureCollection", features: [] },
    matchedStops: host.matchedStops,
  });
  await buildStationIndexesSliced(stationsGeoJson);

  const store = parseImportedCanonicalStore(host.trainStoreText);
  const results = [];
  for (let index = 0; index < store.trains.length; index += 1) {
    const raw = store.trains[index];
    const id = appendImportedTrain(raw, null);
    const train = getTrain(id);
    const solveContext = buildTrainRouteSolveContext(train);
    const cacheKey = solveContext ? solveContext.cacheKey : null;

    const startedAt = performance.now();
    const features = await RouteService.warmTrain(train);
    const ms = Math.round(performance.now() - startedAt);

    let route = null;
    if (cacheKey) {
      if (RouteService.has(cacheKey)) {
        route = { cache_key: cacheKey, features: RouteService.get(cacheKey) };
      } else if (RouteService.isNegative(cacheKey)) {
        const matched = (host.matchedRoutes.features || [])
          .filter((feature) => {
            const props = feature.properties || {};
            return props.train_id === id && props.is_primary !== false;
          })
          .sort(
            (a, b) =>
              Number(a.properties?.segment_index ?? 0) -
              Number(b.properties?.segment_index ?? 0),
          );
        if (matched.length) {
          RouteService.seed(cacheKey, matched);
          route = { cache_key: cacheKey, features: matched };
        } else {
          route = { cache_key: cacheKey, unsolvable: true };
        }
      } else {
        throw new Error(
          `Route solve for train ${id} produced neither a positive nor negative cache entry.`,
        );
      }
      const prepared = prepareTrainRouteSolve(train);
      if (!prepared.done) {
        throw new Error(
          `Seeded cache miss for train ${id} — export would not skip the on-device solve.`,
        );
      }
    }

    host.onTrainSolved({
      index,
      id,
      raw,
      route,
      featureCount:
        route && Array.isArray(route.features)
          ? route.features.length
          : features.length,
      ms,
    });
    results.push({
      id,
      solved: Boolean(route && !route.unsolvable),
      featureCount: features.length,
    });
  }
  return {
    total: store.trains.length,
    schemaVersion: store.schema_version,
    results,
  };
}

window.PrecomputeAdapter = Object.freeze({
  solveStore: precomputeTrainStoreParts,
});
