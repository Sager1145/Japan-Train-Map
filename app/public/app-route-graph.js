// =========================================================================
//  app-route-graph.js — §27–28: route matching, template keys, runtime route caches, graph construction & rail-section spatial index
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §27.  Route matching, template keys, feature generation & full graph construction
// =========================================================================

function getTrainRouteTemplateKey(train) {
  return (train.route_sections || [])
    .map((section) => {
      const from = section.from_n02_station_code || section.from || "";
      const to = section.to_n02_station_code || section.to || "";
      const lines = (section.line_names || [])
        .map(String)
        .filter(Boolean)
        .sort()
        .join(",");
      const operators = (section.operator_names || [])
        .map(String)
        .filter(Boolean)
        .sort()
        .join(",");

      // line_names/operator_names change the route solver constraints, so they
      // must be part of the cache/template key.  Without this, editing only
      // line_names could incorrectly reuse an earlier path for the same endpoints.
      return `${from}->${to}|lines:${lines}|operators:${operators}`;
    })
    .join("|");
}

let runtimeRouteGraph = null;
const runtimeRouteCache = new Map();
// Negative cache: cacheKeys whose solve produced ZERO usable geometry (all
// sections failed — bad/mismatched station codes, or no path under the policy).
// A failure is deterministic for a given (rail data + sections + policy), all of
// which are encoded in cacheKey, so re-solving can only fail again. Without this
// the ~25 unsolvable trains rebuilt regional graphs and ran Dijkstra on every
// prewarm, final render and live refresh — a big chunk of the ~53 s hot reload.
// Editing a train changes its cacheKey, so a fix is re-solved automatically.
const runtimeRouteNegativeCache = new Set();
const ROUTE_NEG_CACHE_MARKER = "__neg__::";
const STATION_SNAP_MAX_DISTANCE_METERS = 500;
const STATION_SNAP_COST_FACTOR = 4;
// N02_002 institution type codes are treated as preferences by default, not
// as a hard whitelist. Some JR service geometry shares or crosses private
// railway sections around airports/through-service corridors; hard-filtering
// them can create visible gaps. Set route_policy.institution_filter_mode =
// "hard" only when a strict institution whitelist is intentionally required.
const NON_PREFERRED_INSTITUTION_LENGTH_FACTOR = 180;
const NON_PREFERRED_INSTITUTION_EDGE_PENALTY = 5000;
const NON_PREFERRED_STATION_SNAP_PENALTY = 20000;
// Soft preferred-line/operator bias for route Dijkstra. These are deliberately
// BOUNDED, length-proportional multipliers (a non-preferred metre costs a few
// preferred metres) — NOT the old route-dominating 140x/100x plus a flat
// per-edge constant. The flat per-edge penalty scaled with the *number* of
// N02 micro-segments, so a short branch line (e.g. 内子線, ~93 vertices over
// 5 km) accumulated ~400k of penalty and a finely-segmented same-line detour
// looked cheaper than the real path. Keeping the bias proportional to distance
// makes it resolution-independent and stops a same-line detour from beating a
// shorter mixed-line path.
const NON_PREFERRED_OPERATOR_LENGTH_FACTOR = 6;
const NON_PREFERRED_LINE_LENGTH_FACTOR = 8;
const NON_PREFERRED_OPERATOR_STATION_SNAP_PENALTY = 12000;
const NON_PREFERRED_LINE_STATION_SNAP_PENALTY = 15000;
const STATION_TRANSFER_NODE_RADIUS_DEG = 0.0035;
const STATION_TRANSFER_MAX_SNAP_METERS = 520;
const STATION_TRANSFER_MAX_NODE_GAP_METERS = 900;
const STATION_TRANSFER_EDGE_PENALTY = 180;
const STATION_TRANSFER_MAX_NODES_PER_GROUP = 24;
// When adjacent route_sections share the same explicit station code, keep the
// next solve on the same physical station record chosen by the previous solve.
// N02 can assign an old and a relocated platform to one station name/group
// (Hiroden Inaricho is one example); solving the sections independently can
// otherwise end one feature at the new platform and start the next at the old
// one, leaving a visible gap even though connecting rail geometry exists.
const ROUTE_SECTION_CONTINUITY_STATION_METERS = 60;

// Build every input that identifies one deterministic route solve. The
// precompute exporter calls this same helper inside its VM sandbox, so cache-key
// construction cannot drift between the browser and the static build.
function buildTrainRouteSolveContext(train) {
  const routeSections = getRideRouteSectionsForTrain(train);
  if (!routeSections.length) return null;

  const templateKey = getTrainRouteTemplateKey({
    ...train,
    route_sections: routeSections,
  });
  const allowedCodes = getAllowedInstitutionTypeCodes(train);
  const policyKey = [
    ...(train.route_policy?.preferred_line_names || []).map(
      (value) => `line:${value}`,
    ),
    ...(train.route_policy?.preferred_operator_names || []).map(
      (value) => `operator:${value}`,
    ),
    ...derivedPreferredOperatorNames(train).map(
      (value) => `operator:${value}`,
    ),
    `institution_filter:${train.route_policy?.institution_filter_mode || "soft"}`,
  ]
    .sort()
    .join("|");
  const cacheKey = `solver:${ROUTE_SOLVER_CACHE_VERSION}|${allowedCodes.join(",")}|${policyKey}|${templateKey}`;
  return { routeSections, templateKey, allowedCodes, cacheKey };
}

// Shared setup for both the render lookup and the streaming route solver:
// resolve the deterministic solve context, then short-circuit on a cache hit or
// a known-unsolvable (negative-cached) train. Returns { done:true, result } when
// the caller should return immediately, otherwise the fields the section solve
// needs. Side-effect-free apart from the "Generating…" status line.
// Deduping the cached template geometry is a pure function of that immutable
// array (segment coincidence, not train identity), yet the cache-HIT path below
// re-ran it for every train on every render — ~230ms across the full set each
// cold repaint, the single largest chunk of a scope switch. Memoize it per
// template array (WeakMap → auto-drops when a re-solve replaces the array), so a
// hit only pays the cheap per-train clone. cloneRouteFeaturesForTrain rewrites
// properties but SHARES each feature's geometry object, so the returned features
// also carry STABLE geometry across renders — which lets getRouteLinePairs cache
// its snapped segKeys by geometry instead of recomputing them every repaint.
// Deduping the template first is behaviour-identical to deduping the clone: the
// clone never touches coordinates, and dedupe's only extra property
// (geometry_role) does not overlap the clone's (train_id/route_id/source).
const _dedupedTemplateCache = new WeakMap();
function dedupedRouteTemplate(cached) {
  let deduped = _dedupedTemplateCache.get(cached);
  if (!deduped) {
    deduped = dedupeSameTrainRouteFeatures(cached);
    _dedupedTemplateCache.set(cached, deduped);
  }
  return deduped;
}

function prepareTrainRouteSolve(train) {
  const context = buildTrainRouteSolveContext(train);
  if (!context) return { done: true, result: [] };
  const { cacheKey } = context;
  if (runtimeRouteCache.has(cacheKey)) {
    const cached = runtimeRouteCache.get(cacheKey);
    return {
      done: true,
      result: cloneRouteFeaturesForTrain(dedupedRouteTemplate(cached), train),
    };
  }

  // Known-unsolvable with this exact data + policy: skip the regional-graph
  // build + Dijkstra entirely and return empty, exactly as a fresh solve would.
  if (runtimeRouteNegativeCache.has(cacheKey)) {
    return { done: true, result: [] };
  }

  setStatus(
    els.fieldStatus,
    `Generating N02 railway route for ${train.number || train.id}...`,
    "warn",
  );
  return { done: false, ...context };
}

// Solve ONE ride section on its on-demand regional subgraph (falling back to the
// full graph only if a region proves too small — see solveRouteSectionOnDemand,
// so results are identical to a full-graph solve). Pushes a "from→to" note into
// `warnings` when a section can't route. Shared by the sync + streaming solvers.
function solveTrainRouteSection(
  train,
  section,
  segmentIndex,
  allowedCodes,
  generated,
  warnings,
  continuityAnchor = null,
) {
  const result = solveRouteSectionOnDemand(
    section,
    segmentIndex,
    train,
    allowedCodes,
    continuityAnchor,
  );
  if (!result) {
    warnings.push(
      `${section.from || section.from_n02_station_code}→${section.to || section.to_n02_station_code}`,
    );
    return;
  }
  generated.push(result);
}

function routeSectionBoundarySharesExplicitStop(previousSection, section) {
  if (!previousSection || !section) return false;
  const previousCode = String(
    previousSection.to_n02_station_code || "",
  ).trim();
  const nextCode = String(section.from_n02_station_code || "").trim();
  if (previousCode && nextCode) return previousCode === nextCode;
  const previousName = normalizeStationName(previousSection.to || "");
  const nextName = normalizeStationName(section.from || "");
  return Boolean(previousName && nextName && previousName === nextName);
}

function routeFeatureEndCoordinate(feature) {
  const geometry = feature?.geometry;
  const lines =
    geometry?.type === "LineString"
      ? [geometry.coordinates]
      : geometry?.type === "MultiLineString"
        ? geometry.coordinates
        : [];
  return lines.length && lines[lines.length - 1].length
    ? lines[lines.length - 1][lines[lines.length - 1].length - 1]
    : null;
}

// Shared tail for both solvers: cache the solved template geometry, persist it,
// refresh this train's entries in the matched-routes collection, and return the
// train-concrete deduped features. Identical to the original function's tail.
function commitTrainRouteSolve(train, cacheKey, templateKey, generated, warnings) {
  if (!generated.length) {
    console.warn(
      `Unable to generate N02 railway route for train ${train.id}.`,
      warnings,
    );
    setStatus(
      els.fieldStatus,
      `Unable to generate N02 railway route for ${train.number || train.id}. ${warnings.length} segment(s) failed.`,
      "warn",
    );
    // Remember the failure so re-renders / prewarms / live refreshes in this
    // session (and future sessions, via IndexedDB) don't re-run the same doomed
    // graph build + Dijkstra. Cleared implicitly when the train's data changes
    // (its cacheKey changes).
    runtimeRouteNegativeCache.add(cacheKey);
    persistRouteNegativeEntry(cacheKey);
    return [];
  }

  const templateFeatures = stitchAdjacentRouteFeatureEndpoints(
    generated.map((feature) => ({
      ...feature,
      properties: {
        ...(feature.properties || {}),
        train_id: "__template__",
        route_id: `${cacheKey}-primary`,
        route_template_key: templateKey,
      },
    })),
  );
  runtimeRouteCache.set(cacheKey, templateFeatures);
  // Persist the freshly solved geometry so later sessions skip both the solve
  // and (if every train hits the cache) the route-graph build entirely.
  persistRouteCacheEntry(cacheKey, templateFeatures);
  // Solved geometry is kept only in runtimeRouteCache (this session) and
  // IndexedDB (cross-session). It is deliberately NOT attached back onto the
  // train object, so train-store.json and the in-memory store stay lean.

  const concrete = dedupeSameTrainRouteFeatures(
    cloneRouteFeaturesForTrain(templateFeatures, train),
  );
  // Replace (not append after) this train's previous features: re-solves for
  // an edited train used to pile up stale entries forever — a slow memory
  // leak that also fed stale geometry to the train_id fallback lookup.
  matchedRoutesGeoJson.features = matchedRoutesGeoJson.features.filter(
    (f) => (f.properties || {}).train_id !== train.id,
  );
  concrete.forEach((feature) => matchedRoutesGeoJson.features.push(feature));

  setStatus(
    els.fieldStatus,
    `Generated ${concrete.length} N02 route segment(s) for ${train.number || train.id}${warnings.length ? `; ${warnings.length} segment(s) skipped.` : "."}`,
    warnings.length ? "warn" : "ok",
  );
  return concrete;
}

// Render-path route lookup. The train has almost always been pre-warmed, so
// prepareTrainRouteSolve() returns a cache hit. On a genuine cache MISS this
// NEVER solves synchronously on the render/click thread: a cold solve builds
// ~0.4 s regional graphs per region (~2 s total for a long train) and would
// freeze the tab — the reported "selecting a rail is slow". Instead it returns
// [] and hands the train to the background solve queue, which solves it one
// section at a time (yielding to paint/input) and repaints when done. During a
// progressive load the streaming warm-up already owns solving, so we simply
// defer to it. getMatchedRouteFeatures() falls back to any precomputed
// matched-routes geometry meanwhile, so covered trains still draw instantly.
function generateMatchedRouteFeaturesForTrain(train) {
  const prep = prepareTrainRouteSolve(train);
  if (prep.done) return prep.result;
  if (importInProgress) return [];
  // Rail-sections may still be loading in the background (boot no longer
  // awaits it). Solving now would run Dijkstra over an EMPTY dataset and
  // negative-cache the train as unsolvable — persistently. Skip this frame,
  // kick the solver warm-up, and repaint once it is ready.
  if (!railSectionsGeoJson) {
    requestSolverThenRerender();
    return [];
  }
  // Cold miss with data ready: solve OFF the render thread, draw a beat later.
  requestTrainRouteSolve(train);
  return [];
}

// Streaming solve — used by the progressive load/import warm-up. Solves the
// train ONE section at a time and calls the caller's shared `yieldIfNeeded()`
// after each, so a long itinerary hands the main thread back mid-train (paint +
// input stay live, and GC can reclaim transient graph memory between slices).
// Writes the exact same runtime/negative caches + matched-routes features as the
// synchronous solver, so the later render-time lookup is an untouched cache hit.
async function warmRouteCacheForTrainStreaming(train, { yieldIfNeeded } = {}) {
  let prep = prepareTrainRouteSolve(train);
  if (prep.done) return prep.result;

  // Genuine cache miss: this is the first point that actually needs the
  // solver, so pay the one-time rail-sections load + IndexedDB warm-up here
  // (boot no longer blocks on either). The warm-up may itself satisfy this
  // train, so re-check before running a fresh solve.
  await ensureSolverReady();
  prep = prepareTrainRouteSolve(train);
  if (prep.done) return prep.result;

  const { routeSections, templateKey, allowedCodes, cacheKey } = prep;
  const generated = [];
  const warnings = [];
  for (
    let segmentIndex = 0;
    segmentIndex < routeSections.length;
    segmentIndex += 1
  ) {
    const previousFeature = generated[generated.length - 1];
    const continuityAnchor =
      segmentIndex > 0 &&
      previousFeature?.properties?.segment_index === segmentIndex - 1 &&
      routeSectionBoundarySharesExplicitStop(
        routeSections[segmentIndex - 1],
        routeSections[segmentIndex],
      )
        ? routeFeatureEndCoordinate(previousFeature)
        : null;
    solveTrainRouteSection(
      train,
      routeSections[segmentIndex],
      segmentIndex,
      allowedCodes,
      generated,
      warnings,
      continuityAnchor,
    );
    if (yieldIfNeeded) await yieldIfNeeded();
  }
  return commitTrainRouteSolve(train, cacheKey, templateKey, generated, warnings);
}

function dedupeSameTrainRouteFeatures(features) {
  const seenSegments = new Set();
  const cleaned = [];
  (features || []).forEach((feature) => {
    const uniqueLines = [];
    iterateGeometryLines(feature.geometry).forEach((line) => {
      const uniqueLine = [];
      for (let i = 0; i < line.length - 1; i += 1) {
        const from = line[i];
        const to = line[i + 1];
        if (coordinatesEqual(from, to)) continue;
        const key = routeCoordinateSegmentKey(from, to);
        if (seenSegments.has(key)) continue;
        seenSegments.add(key);
        if (!uniqueLine.length) uniqueLine.push(from);
        else if (!coordinatesEqual(uniqueLine[uniqueLine.length - 1], from)) {
          if (uniqueLine.length >= 2) uniqueLines.push(uniqueLine);
          uniqueLine.length = 0;
          uniqueLine.push(from);
        }
        uniqueLine.push(to);
      }
      if (uniqueLine.length >= 2) uniqueLines.push(uniqueLine);
    });

    if (!uniqueLines.length) return;
    const geometry =
      uniqueLines.length === 1
        ? { type: "LineString", coordinates: uniqueLines[0] }
        : { type: "MultiLineString", coordinates: uniqueLines };
    cleaned.push({
      ...feature,
      properties: {
        ...(feature.properties || {}),
        geometry_role:
          uniqueLines.length > 1
            ? "single_path_with_gaps"
            : feature.properties?.geometry_role,
      },
      geometry,
    });
  });
  return stitchAdjacentRouteFeatureEndpoints(cleaned);
}

function stitchAdjacentRouteFeatureEndpoints(features) {
  for (let index = 1; index < features.length; index += 1) {
    const previous = features[index - 1];
    const current = features[index];
    if (
      Number(current.properties?.segment_index) !==
      Number(previous.properties?.segment_index) + 1
    ) {
      continue;
    }
    const previousEnd = routeFeatureEndCoordinate(previous);
    const currentLines =
      current.geometry?.type === "LineString"
        ? [current.geometry.coordinates]
        : current.geometry?.type === "MultiLineString"
          ? current.geometry.coordinates
          : [];
    const currentStart = currentLines[0]?.[0];
    if (
      !previousEnd ||
      !currentStart ||
      distanceMeters(previousEnd, currentStart) >
        ROUTE_SECTION_CONTINUITY_STATION_METERS
    ) {
      continue;
    }
    if (coordinatesClose(previousEnd, currentStart, 0.25)) {
      currentLines[0][0] = previousEnd;
    } else {
      currentLines[0].unshift(previousEnd);
    }
  }
  return features;
}

function cloneRouteFeaturesForTrain(features, train) {
  return features.map((feature) => ({
    ...feature,
    properties: {
      ...(feature.properties || {}),
      train_id: train.id,
      route_id: `${train.id}-runtime-primary`,
      source:
        feature.properties?.source || "browser_dijkstra_on_embedded_n02_graph",
    },
  }));
}

// -------------------------------------------------------------------------
// 車輛類型 (train_type) / 營運公司 (company) helpers.
// `company` may contain several operators separated by "/" — that marks a
// 直通 (through-running) service. Type + company together SOFT-bias which
// tracks the route solver renders on (institution codes + operator names);
// an explicit route_policy always wins.
// -------------------------------------------------------------------------
const COMPANY_OPERATOR_ALIASES = {
  JR北海道: "北海道旅客鉄道",
  JR東日本: "東日本旅客鉄道",
  JR东日本: "東日本旅客鉄道",
  JR東海: "東海旅客鉄道",
  JR西日本: "西日本旅客鉄道",
  JR四国: "四国旅客鉄道",
  JR四國: "四国旅客鉄道",
  JR九州: "九州旅客鉄道",
  東京メトロ: "東京地下鉄",
  东京地下铁: "東京地下鉄",
  都営地下鉄: "東京都",
  都営: "東京都",
  京急: "京浜急行電鉄",
  京急電鉄: "京浜急行電鉄",
  東急: "東急電鉄",
  小田急: "小田急電鉄",
  京王: "京王電鉄",
  京成: "京成電鉄",
  西武: "西武鉄道",
  東武: "東武鉄道",
  相鉄: "相模鉄道",
  近鉄: "近畿日本鉄道",
  阪急: "阪急電鉄",
  阪神: "阪神電気鉄道",
  名鉄: "名古屋鉄道",
  西鉄: "西日本鉄道",
};

function companyParts(train) {
  return String(train?.company || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isThroughService(train) {
  return companyParts(train).length > 1;
}

// "特急 · JR西日本" / "普通 · 京急電鉄/都営地下鉄（直通）"
function trainCompanyLabel(train) {
  const parts = companyParts(train);
  if (!parts.length) return "";
  const joined = parts.join("/");
  return isThroughService(train)
    ? `${joined}（${I18N.t("tag.through")}）`
    : joined;
}

function trainTypeCompanyLabel(train) {
  return [String(train?.train_type || "").trim(), trainCompanyLabel(train)]
    .filter(Boolean)
    .join(" · ");
}

// Map the human company field to N02_004 operator names for the solver's
// soft operator bias (accepts both marketing names and official names).
function derivedPreferredOperatorNames(train) {
  const names = new Set();
  companyParts(train).forEach((part) => {
    names.add(COMPANY_OPERATOR_ALIASES[part] || part);
  });
  return [...names];
}

// Derive N02_002 institution-type codes from train_type + company. Empty
// result = no signal (caller keeps the full default set).
function derivedInstitutionTypeCodes(train) {
  const type = String(train?.train_type || "");
  const text = `${type} ${companyParts(train).join(" ")}`;
  const codes = new Set();
  if (/新幹線|新干线|shinkansen/i.test(text)) codes.add("1");
  if (/JR|旅客鉄道|旅客铁道/i.test(text) && !/新幹線|新干线/.test(type))
    codes.add("2");
  if (/都営|東京都交通局|市営|公営|市交通局/.test(text)) codes.add("3");
  if (
    /メトロ|地下鉄|地下铁|私鉄|私铁|電鉄|电铁|電気鉄道|京急|京成|東急|小田急|近鉄|阪急|阪神|名鉄|西鉄|西武|東武|モノレール|ゆりかもめ|長野電鉄|富士山麓|富士急/.test(
      text,
    )
  )
    codes.add("4");
  if (
    /第三セクター|三セク|三陸鉄道|しなの鉄道|あいの風|IGR|青い森|肥薩おれんじ|道南いさりび|IRいしかわ|松浦鉄道|横浜高速鉄道/.test(
      text,
    )
  )
    codes.add("5");
  return [...codes].sort();
}

function getAllowedInstitutionTypeCodes(train) {
  const explicit = train.route_policy?.allowed_institution_type_codes;
  const codes =
    Array.isArray(explicit) && explicit.length
      ? explicit.map(String)
      : [...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES];
  const unique = [...new Set(codes)].sort();
  // When route_policy does NOT narrow the codes itself (still the full
  // default set), derive a soft narrowing from 車輛類型/公司. With the
  // default institution_filter_mode "soft" this only biases the solver —
  // it never creates gaps.
  const fullDefault = [...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES].sort();
  if (unique.join(",") === fullDefault.join(",")) {
    const derived = derivedInstitutionTypeCodes(train);
    if (derived.length) return derived;
  }
  return unique;
}

// Core graph builder shared by the full-network graph and the on-demand
// regional subgraphs. Builds nodes / edges / nodeMeta / spatial-grid from
// ONLY the given rail-section features (station transfer edges added later).
function buildRouteGraphFromFeatures(features) {
  const nodes = new Map();
  const adjacency = new Map();
  const grid = new Map();
  const nodeMeta = new Map();
  const cellSize = 0.01;

  function ensureNode(coord) {
    const normalized = normalizeGraphCoord(coord);
    const key = coordKey(normalized);
    if (!nodes.has(key)) {
      nodes.set(key, normalized);
      adjacency.set(key, []);
      nodeMeta.set(key, {
        line_names: new Set(),
        operators: new Set(),
        institution_type_codes: new Set(),
        railway_class_codes: new Set(),
      });
      const gk = graphGridKey(normalized, cellSize);
      if (!grid.has(gk)) grid.set(gk, []);
      grid.get(gk).push(key);
    }
    return key;
  }

  function recordNodeMeta(key, properties) {
    const meta = nodeMeta.get(key);
    if (!meta) return;
    const lineName = properties?.N02_003 || properties?.line_name || "";
    const operator = properties?.N02_004 || properties?.operator || "";
    const institution = String(
      properties?.N02_002 || properties?.institution_type_code || "",
    );
    const railwayClass = String(
      properties?.N02_001 || properties?.railway_class_code || "",
    );
    if (lineName) meta.line_names.add(lineName);
    if (operator) meta.operators.add(operator);
    if (institution) meta.institution_type_codes.add(institution);
    if (railwayClass) meta.railway_class_codes.add(railwayClass);
  }

  function addRailEdge(aCoord, bCoord, properties) {
    const a = ensureNode(aCoord);
    const b = ensureNode(bCoord);
    if (a === b) return;
    recordNodeMeta(a, properties);
    recordNodeMeta(b, properties);
    const length = distanceMeters(nodes.get(a), nodes.get(b));
    const edge = {
      to: b,
      length: Math.max(length, 0.01),
      institution_type_code: String(
        properties?.N02_002 || properties?.institution_type_code || "",
      ),
      railway_class_code: String(
        properties?.N02_001 || properties?.railway_class_code || "",
      ),
      line_name: properties?.N02_003 || properties?.line_name || "",
      operator: properties?.N02_004 || properties?.operator || "",
    };
    adjacency.get(a).push(edge);
    adjacency.get(b).push({ ...edge, to: a });
  }

  // Python-equivalent rule: the routable graph is built ONLY from RailroadSection.
  // N02 Station LineString is used only for station snap candidates, never as a train-runnable edge.
  (features || []).forEach((feature) => {
    const props = feature.properties || {};
    iterateGeometryLines(feature.geometry).forEach((line) => {
      for (let i = 0; i < line.length - 1; i += 1)
        addRailEdge(line[i], line[i + 1], props);
    });
  });

  return {
    nodes,
    adjacency,
    grid,
    nodeMeta,
    cellSize,
    stationSnapCache: new Map(),
  };
}

// Full-network graph (~377k nodes). Retained as the guaranteed-correct
// fallback for on-demand solving; built lazily and memoized only if a
// regional subgraph proves insufficient — never eagerly at startup.
function getRuntimeRouteGraph() {
  if (runtimeRouteGraph) return runtimeRouteGraph;
  // Never memoise a graph built from missing data: with boot no longer
  // awaiting rail-sections, a premature call here would permanently cache an
  // EMPTY full-network graph and every solve would silently fail.
  if (!railSectionsGeoJson)
    throw new Error(
      "rail-sections not loaded yet; await ensureSolverReady() before solving.",
    );
  const graph = buildRouteGraphFromFeatures(
    (railSectionsGeoJson && railSectionsGeoJson.features) || [],
  );
  addStationTransferConnectorEdges(graph);
  runtimeRouteGraph = graph;
  return runtimeRouteGraph;
}

// =========================================================================
//  §28.  On-demand regional route graphs & rail-section spatial index
// =========================================================================

// ---- On-demand regional route graphs ------------------------------------
// Instead of holding the whole-Japan graph resident, build small per-region
// subgraphs on demand and LRU-cache them. A subgraph built from EVERY rail
// feature inside a bbox is structurally identical to the full graph
// restricted to that bbox, so Dijkstra returns the SAME optimal path as long
// as that path stays inside the bbox. We check that at solve time
// (pathTouchesRegionEdge) and widen / fall back to the full graph otherwise,
// so on-demand results never differ from the all-Japan graph.

const RAIL_INDEX_CELL_DEG = 0.1;
let railSectionSpatialIndex = null;

function featureBbox(feature) {
  if (feature.__railBbox !== undefined) return feature.__railBbox;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  iterateGeometryLines(feature.geometry).forEach((line) => {
    for (const pt of line) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[1] > maxY) maxY = pt[1];
    }
  });
  const bbox = minX === Infinity ? null : [minX, minY, maxX, maxY];
  feature.__railBbox = bbox;
  return bbox;
}

// Coarse grid index over rail-section feature bboxes. Cheap (just bboxes +
// references), built once, so regional builds avoid scanning all 22k features.
function getRailSectionSpatialIndex() {
  if (railSectionSpatialIndex) return railSectionSpatialIndex;
  // Same poisoning hazard as getRuntimeRouteGraph: memoising an index over
  // zero features would make every regional solve come up empty forever.
  if (!railSectionsGeoJson)
    throw new Error(
      "rail-sections not loaded yet; await ensureSolverReady() before solving.",
    );
  const grid = new Map();
  const feats = (railSectionsGeoJson && railSectionsGeoJson.features) || [];
  feats.forEach((feature) => {
    const bbox = featureBbox(feature);
    if (!bbox) return;
    const x0 = Math.floor(bbox[0] / RAIL_INDEX_CELL_DEG);
    const x1 = Math.floor(bbox[2] / RAIL_INDEX_CELL_DEG);
    const y0 = Math.floor(bbox[1] / RAIL_INDEX_CELL_DEG);
    const y1 = Math.floor(bbox[3] / RAIL_INDEX_CELL_DEG);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const k = `${x},${y}`;
        let arr = grid.get(k);
        if (!arr) {
          arr = [];
          grid.set(k, arr);
        }
        arr.push(feature);
      }
    }
  });
  railSectionSpatialIndex = grid;
  return grid;
}

function bboxIntersects(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function railFeaturesInBbox(bbox) {
  const grid = getRailSectionSpatialIndex();
  const x0 = Math.floor(bbox[0] / RAIL_INDEX_CELL_DEG);
  const x1 = Math.floor(bbox[2] / RAIL_INDEX_CELL_DEG);
  const y0 = Math.floor(bbox[1] / RAIL_INDEX_CELL_DEG);
  const y1 = Math.floor(bbox[3] / RAIL_INDEX_CELL_DEG);
  const seen = new Set();
  const out = [];
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      const arr = grid.get(`${x},${y}`);
      if (!arr) continue;
      for (const f of arr) {
        if (seen.has(f)) continue;
        seen.add(f);
        const fb = featureBbox(f);
        if (fb && bboxIntersects(fb, bbox)) out.push(f);
      }
    }
  }
  return out;
}

function stationFeaturesInBbox(bbox) {
  const feats = (stationsGeoJson && stationsGeoJson.features) || [];
  const out = [];
  for (const f of feats) {
    const c = getFeatureDisplayCoordinate(f);
    if (
      c &&
      c[0] >= bbox[0] &&
      c[0] <= bbox[2] &&
      c[1] >= bbox[1] &&
      c[1] <= bbox[3]
    )
      out.push(f);
  }
  return out;
}

// Expand a bbox by a metric margin (longitude scaled by latitude).
function padBboxMeters(bbox, meters) {
  const latPad = meters / 111320;
  const midLat = (bbox[1] + bbox[3]) / 2;
  const lonPad =
    meters / (111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  return [
    bbox[0] - lonPad,
    bbox[1] - latPad,
    bbox[2] + lonPad,
    bbox[3] + latPad,
  ];
}

function bboxDiagonalMeters(bbox) {
  return distanceMeters([bbox[0], bbox[1]], [bbox[2], bbox[3]]);
}

const REGION_QUANT_DEG = 0.25;
// Steady-state cap on total resident regional-graph nodes. Was 140,000 — smaller
// than a SINGLE cross-Japan region (50k–72k nodes), so a multi-region load
// evicted a region and then rebuilt the identical one 2–3× within one pass
// (56–61 builds observed for 117 trains). For reference the full-Japan graph is
// ~377k nodes and is already a tolerated fallback, so holding ~4–5 regions
// resident here is well within that envelope while erasing most re-builds.
const REGIONAL_GRAPH_NODE_BUDGET = 300000;
// During an active progressive load we suspend eviction so a region built for an
// early train is still resident when a later train needs it again — but cap the
// transient so a pathological all-Japan load can't blow up memory. Trimmed back
// to the steady budget by trimRegionalGraphCache() when the load finishes.
const REGIONAL_GRAPH_LOAD_NODE_BUDGET = 600000;
const regionalGraphCache = new Map(); // quantized-bbox key -> graph (insertion order = LRU)
let regionalGraphNodeCount = 0;

// Evict least-recently-used regional graphs until the resident node count is at
// or below `target` (always keeping at least one so the in-flight solve has its
// graph). Shared by the on-demand builder and the post-load trim.
function trimRegionalGraphCache(target) {
  while (regionalGraphNodeCount > target && regionalGraphCache.size > 1) {
    const oldestKey = regionalGraphCache.keys().next().value;
    const oldest = regionalGraphCache.get(oldestKey);
    regionalGraphCache.delete(oldestKey);
    regionalGraphNodeCount -= oldest.nodes.size;
  }
}

function quantizeBboxOutward(bbox) {
  return [
    Math.floor(bbox[0] / REGION_QUANT_DEG) * REGION_QUANT_DEG,
    Math.floor(bbox[1] / REGION_QUANT_DEG) * REGION_QUANT_DEG,
    Math.ceil(bbox[2] / REGION_QUANT_DEG) * REGION_QUANT_DEG,
    Math.ceil(bbox[3] / REGION_QUANT_DEG) * REGION_QUANT_DEG,
  ];
}

// Build (or reuse from LRU) the regional subgraph covering a bbox. Quantizing
// the bbox outward lets nearby sections share one subgraph; an LRU node budget
// caps total resident graph memory.
function getRegionalRouteGraph(bbox) {
  const qbbox = quantizeBboxOutward(bbox);
  const key = qbbox.map((v) => v.toFixed(2)).join(",");
  const cached = regionalGraphCache.get(key);
  if (cached) {
    regionalGraphCache.delete(key); // LRU touch
    regionalGraphCache.set(key, cached);
    return cached;
  }
  const graph = buildRouteGraphFromFeatures(railFeaturesInBbox(qbbox));
  addStationTransferConnectorEdges(graph, stationFeaturesInBbox(qbbox));
  graph.regionBbox = qbbox;
  regionalGraphCache.set(key, graph);
  regionalGraphNodeCount += graph.nodes.size;
  // While a load OR a single interactive solve is building several regions
  // back-to-back, keep them resident up to the larger transient budget: a train
  // spanning >REGIONAL_GRAPH_NODE_BUDGET nodes of regions used to evict its OWN
  // earlier regions and then rebuild them for a later section (each build ~0.4 s
  // — the biggest chunk of the ~2 s "selecting a rail is slow" freeze). We trim
  // back to the steady budget once the solve/load settles (see below +
  // finalizeProgressiveLoad).
  trimRegionalGraphCache(
    importInProgress || _solveInProgress
      ? REGIONAL_GRAPH_LOAD_NODE_BUDGET
      : REGIONAL_GRAPH_NODE_BUDGET,
  );
  return graph;
}

// Resolve BOTH endpoint station candidate lists of a route section (shared
// by the bbox helper and the on-graph solver so the from/to lookup pattern
// lives in exactly one place).
function resolveSectionEndpoints(section, train, allowedCodes) {
  return {
    fromStations: resolveRouteEndpointStationCandidates(
      { name: section.from, n02_station_code: section.from_n02_station_code },
      train,
      allowedCodes,
    ),
    toStations: resolveRouteEndpointStationCandidates(
      { name: section.to, n02_station_code: section.to_n02_station_code },
      train,
      allowedCodes,
    ),
  };
}

// Bounding box of a section's resolved endpoint station candidates.
function sectionEndpointBbox(section, train, allowedCodes) {
  const { fromStations, toStations } = resolveSectionEndpoints(
    section,
    train,
    allowedCodes,
  );
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  [...fromStations, ...toStations].forEach((f) => {
    const c = getFeatureDisplayCoordinate(f);
    if (!c) return;
    if (c[0] < minX) minX = c[0];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[1] > maxY) maxY = c[1];
  });
  return minX === Infinity ? null : [minX, minY, maxX, maxY];
}

// True if any vertex of the solved feature lies within marginDeg of the
// region edge — a signal the true optimum might leave the region, so the
// search should widen (or fall back to the full graph).
function pathTouchesRegionEdge(feature, regionBbox, marginDeg) {
  if (!feature || !regionBbox) return false;
  const coords = (feature.geometry && feature.geometry.coordinates) || [];
  for (const c of coords) {
    if (
      c[0] <= regionBbox[0] + marginDeg ||
      c[0] >= regionBbox[2] - marginDeg ||
      c[1] <= regionBbox[1] + marginDeg ||
      c[1] >= regionBbox[3] - marginDeg
    ) {
      return true;
    }
  }
  return false;
}

// On-demand replacement for "solve on the full graph". Uses a small regional
// subgraph; widens it (and finally falls back to the full graph) if the
// solved path reaches the region edge, so the result matches the all-Japan
// graph while keeping resident graph memory bounded.
function solveRouteSectionOnDemand(
  section,
  segmentIndex,
  train,
  allowedCodes,
  continuityAnchor = null,
) {
  const endpointBbox = sectionEndpointBbox(section, train, allowedCodes);
  if (!endpointBbox) {
    return solveRouteSectionOnN02Graph(
      section,
      segmentIndex,
      train,
      getRuntimeRouteGraph(),
      allowedCodes,
      continuityAnchor,
    );
  }
  const straight = bboxDiagonalMeters(endpointBbox);
  const margins = [
    Math.max(30000, straight * 0.6),
    Math.max(90000, straight * 1.5),
  ];
  let lastResult = null;
  for (const margin of margins) {
    const graph = getRegionalRouteGraph(padBboxMeters(endpointBbox, margin));
    const result = solveRouteSectionOnN02Graph(
      section,
      segmentIndex,
      train,
      graph,
      allowedCodes,
      continuityAnchor,
    );
    if (result) {
      lastResult = result;
      if (!pathTouchesRegionEdge(result, graph.regionBbox, 0.02)) return result;
    }
  }
  // The region wasn't conclusively large enough — use the full graph so the
  // answer is provably identical to the original all-Japan solve.
  const full = solveRouteSectionOnN02Graph(
    section,
    segmentIndex,
    train,
    getRuntimeRouteGraph(),
    allowedCodes,
    continuityAnchor,
  );
  return full || lastResult;
}

function intersects(a, b) {
  if (!a || !b) return false;
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function nearbyGraphNodes(coord, graph, radiusDeg = 0.0015, limit = 30) {
  const [lon, lat] = normalizeGraphCoord(coord);
  const baseX = Math.floor(lon / graph.cellSize);
  const baseY = Math.floor(lat / graph.cellSize);
  const cellRadius = Math.max(1, Math.ceil(radiusDeg / graph.cellSize));
  const found = [];
  const seen = new Set();
  for (let dx = -cellRadius; dx <= cellRadius; dx += 1) {
    for (let dy = -cellRadius; dy <= cellRadius; dy += 1) {
      const bucket = graph.grid.get(`${baseX + dx},${baseY + dy}`) || [];
      bucket.forEach((key) => {
        if (seen.has(key)) return;
        seen.add(key);
        const distance = distanceMeters([lon, lat], graph.nodes.get(key));
        found.push({ key, distance });
      });
    }
  }
  found.sort((a, b) => a.distance - b.distance);
  return found.slice(0, limit);
}
