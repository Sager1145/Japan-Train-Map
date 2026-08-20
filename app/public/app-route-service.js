// =========================================================================
//  app-route-service.js — route solving, cache, queue, and invalidation owner
//
//  The graph and solver files contain route-domain algorithms. This service
//  owns their mutable runtime lifecycle and is the application-facing seam for
//  cache lookup, streaming solves, background queueing, and country resets.
// =========================================================================

const _pendingRouteSolves = new Set();
let _routeSolveDraining = false;
let solverReadyPromise = null;
let solverRenderKickPending = false;

configureStationRouteResolver({
  allowedInstitutionCodes: getAllowedInstitutionTypeCodes,
  filterPreferredStations: filterStationsByPreferredInstitution,
  distanceMeters,
});
configureRouteSolverApi({
  addStationTransferConnectorEdges: (...args) =>
    addStationTransferConnectorEdges(...args),
  coordKey: (...args) => coordKey(...args),
  coordinatesClose: (...args) => coordinatesClose(...args),
  distanceMeters: (...args) => distanceMeters(...args),
  graphGridKey: (...args) => graphGridKey(...args),
  normalizeGraphCoord: (...args) => normalizeGraphCoord(...args),
  pathLengthForCoordinates: (...args) => pathLengthForCoordinates(...args),
  resolveEndpointCandidates: (...args) =>
    resolveRouteEndpointStationCandidates(...args),
  solveSection: (...args) => solveRouteSectionOnN02Graph(...args),
});
configureRouteGraphApi({
  allowedInstitutionCodes: (...args) => getAllowedInstitutionTypeCodes(...args),
  intersects: (...args) => intersects(...args),
  keyDigest: (...args) => routeKeyDigest(...args),
  nearbyNodes: (...args) => nearbyGraphNodes(...args),
  preferredOperatorNames: (...args) => derivedPreferredOperatorNames(...args),
  resolveSectionEndpoints: (...args) => resolveSectionEndpoints(...args),
  templateKey: (...args) => getTrainRouteTemplateKey(...args),
});
// Make a solve's verdict outlive the session. The route graph announces what
// it decided; choosing IndexedDB as the place to keep it is this service's
// call, not the graph's — so app-route-graph.js no longer reaches into the
// persistence layer at all.
setRouteCacheStore({
  solved: (cacheKey, templateFeatures) =>
    persistRouteCacheEntry(cacheKey, templateFeatures),
  unsolvable: (cacheKey) => persistRouteNegativeEntry(cacheKey),
});

// One-time gate for the parsed rail sections and persisted route cache.
// Memoisation is cleared after failure so a later solve can retry.
function ensureSolverReady() {
  if (!solverReadyPromise) {
    solverReadyPromise = (async () => {
      await ensureRailSectionsLoaded();
      await warmRouteCacheFromIndexedDb();
    })();
    solverReadyPromise.catch(() => {
      solverReadyPromise = null;
    });
  }
  return solverReadyPromise;
}

// A render-time cache miss can occur before the dataset is ready. Start the
// readiness work and publish one repaint without solving against empty data.
function requestSolverThenRerender() {
  if (solverRenderKickPending) return;
  solverRenderKickPending = true;
  ensureSolverReady()
    .then(() => {
      solverRenderKickPending = false;
      renderTrainLayers();
    })
    .catch(() => {
      solverRenderKickPending = false;
    });
}

function generateMatchedRouteFeaturesForTrain(train) {
  const prep = prepareTrainRouteSolve(train);
  if (prep.done) return prep.result;
  if (importInProgress) return [];
  if (!railSectionsGeoJson) {
    requestSolverThenRerender();
    return [];
  }
  requestTrainRouteSolve(train);
  return [];
}

async function warmRouteCacheForTrainStreaming(
  train,
  { yieldIfNeeded } = {},
) {
  let prep = prepareTrainRouteSolve(train);
  if (prep.done) return prep.result;
  await ensureSolverReady();
  prep = prepareTrainRouteSolve(train);
  if (prep.done) return prep.result;
  return solveTrainRouteStreaming(train, { yieldIfNeeded });
}

async function drainPendingRouteSolves() {
  if (_routeSolveDraining) return;
  _routeSolveDraining = true;
  setRouteSolveInProgress(true);
  try {
    let frameStart = performance.now();
    const yieldIfNeeded = async () => {
      if (performance.now() - frameStart < 12) return;
      await waitForImportPaint();
      frameStart = performance.now();
    };
    while (_pendingRouteSolves.size) {
      const id = _pendingRouteSolves.values().next().value;
      _pendingRouteSolves.delete(id);
      const train = getTrain(id);
      if (!train) continue;
      try {
        await warmRouteCacheForTrainStreaming(train, { yieldIfNeeded });
        appendTrainToLayers(train);
      } catch (err) {
        console.warn(`Background route solve failed for ${id}.`, err);
      }
    }
  } finally {
    setRouteSolveInProgress(false);
    trimRegionalGraphCache(REGIONAL_GRAPH_NODE_BUDGET);
    _routeSolveDraining = false;
    renderTrainLayers();
  }
}

function requestTrainRouteSolve(train) {
  if (!train || _pendingRouteSolves.has(train.id)) return;
  _pendingRouteSolves.add(train.id);
  drainPendingRouteSolves();
}

function resetRouteServiceForCountry() {
  invalidateRouteGraphIndexes();
  runtimeRouteCache.clear();
  runtimeRouteNegativeCache.clear();
  _pendingRouteSolves.clear();
  solverReadyPromise = null;
  solverRenderKickPending = false;
}

function seedRuntimeRouteCache(cacheKey, features) {
  runtimeRouteNegativeCache.delete(cacheKey);
  runtimeRouteCache.set(cacheKey, features);
}

function seedRuntimeRouteNegativeCache(cacheKey) {
  runtimeRouteCache.delete(cacheKey);
  runtimeRouteNegativeCache.add(cacheKey);
}

/**
 * @typedef {Object} RouteServiceContract
 * @property {() => Promise<void>} ensureReady
 * @property {(train: Object) => Array<Object>} featuresForTrain
 * @property {(train: Object, options?: Object) => Promise<Array<Object>>} warmTrain
 * @property {(train: Object) => void} requestSolve
 * @property {(cacheKey: string) => boolean} has
 * @property {(cacheKey: string) => Array<Object>|undefined} get
 * @property {(cacheKey: string) => boolean} isNegative
 * @property {() => number} cacheSize
 * @property {(cacheKey: string, features: Array<Object>) => void} seed
 * @property {(cacheKey: string) => void} seedNegative
 * @property {() => void} resetForCountry
 * @property {() => void} invalidateDataset
 */

/** @type {Readonly<RouteServiceContract>} */
const RouteService = Object.freeze({
  ensureReady: ensureSolverReady,
  featuresForTrain: generateMatchedRouteFeaturesForTrain,
  warmTrain: warmRouteCacheForTrainStreaming,
  requestSolve: requestTrainRouteSolve,
  has: (cacheKey) => runtimeRouteCache.has(cacheKey),
  get: (cacheKey) => runtimeRouteCache.get(cacheKey),
  isNegative: (cacheKey) => runtimeRouteNegativeCache.has(cacheKey),
  cacheSize: () => runtimeRouteCache.size,
  seed: seedRuntimeRouteCache,
  seedNegative: seedRuntimeRouteNegativeCache,
  resetForCountry: resetRouteServiceForCountry,
  invalidateDataset: invalidateRouteGraphIndexes,
});
