// =========================================================================
//  app-store-ops.js — §17–20: train CRUD, canonical export, import parsing & blank-train factory
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §17.  Train CRUD (add / update / duplicate / delete / move / visibility)
// =========================================================================

// A progressive load/import (boot restore, local-file open, JSON import, SSE
// live reload) OWNS trainStore while it streams trains in. The interactive edit
// actions must not run mid-import: they reassign or splice trainStore while
// runProgressiveAppend is still appending to it — yielding a mixed/partly
// clobbered store — and their debounced autosave would PUT that PARTIAL store to
// the server (which boot's finalPersist:false never corrects, so other tabs
// would reload fewer trains than were actually loaded). Every mutating handler
// funnels through this guard: while an import runs it no-ops with a brief hint.
function importBusy() {
  // A country switch owns the store globals exactly like a progressive import
  // does — but it also RE-POINTS every persistence target (TRAIN_STORE_API,
  // the country-scoped IndexedDB names) mid-flight. An edit slipping into its
  // async windows (flush drain, server fetch) would mutate a store that is
  // about to be replaced and could autosave old-country data into the new
  // country's store, so mutations are blocked for the whole switch too.
  if (!importInProgress && !countrySwitchInFlight) return false;
  if (els.importStatus) setStatus(els.importStatus, I18N.t("status.importBusy"), "warn");
  return true;
}

function addTrain(train) {
  if (importBusy()) return;
  const base = train || createBlankTrain();
  const candidate = clone(base);
  candidate.id = uniqueId(candidate.id || "LE");
  trainStore.trains.push(candidate);
  selectedTrainId = candidate.id;
  focusedTrainId = candidate.id;
  applyMutationResult(MutationResults.trainCollectionChanged);
}

function duplicateTrain(trainId) {
  if (importBusy()) return;
  const train = getTrain(trainId);
  if (!train) return;
  const copy = clone(train);
  copy.id = uniqueId(`${train.id}-copy`);
  copy.number = `${train.number || "Train"} Copy`;
  trainStore.trains.push(copy);
  selectedTrainId = copy.id;
  focusedTrainId = copy.id;
  applyMutationResult(MutationResults.trainCollectionChanged);
}

function deleteTrain(trainId) {
  if (importBusy()) return;
  const index = trainStore.trains.findIndex((t) => t.id === trainId);
  if (index < 0) return;
  trainStore.trains.splice(index, 1);
  selectedTrainId =
    trainStore.trains[Math.min(index, trainStore.trains.length - 1)]?.id ||
    null;
  if (focusedTrainId === trainId) focusedTrainId = null;
  applyMutationResult(MutationResults.trainCollectionChanged);
}

function deleteAllTrains() {
  if (importBusy()) return;
  AppActions.resetTrainStore();
  selectedTrainId = null;
  focusedTrainId = null;
  applyMutationResult(MutationResults.trainCollectionChanged);
}

function toggleTrainVisibility(trainId) {
  if (importBusy()) return;
  const train = getTrain(trainId);
  if (!train) return;
  train.visible = train.visible === false;
  // Incremental update: a visibility flip changes (a) this card's shown/hidden
  // label and (b) the map. It does NOT change the date buckets, the editor, or
  // the import target, so we skip rebuilding those. The map still gets one full
  // renderTrainLayers pass because overlapping parallel routes share global
  // offset slots that must be recomputed when the visible set changes. Saving
  // is debounced (no synchronous full serialization here).
  applyMutationResult(MutationResults.visibilityChanged);
}

function moveTrain(trainId, direction) {
  if (importBusy()) return;
  const index = trainStore.trains.findIndex((t) => t.id === trainId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= trainStore.trains.length) return;
  const [train] = trainStore.trains.splice(index, 1);
  trainStore.trains.splice(next, 0, train);
  applyMutationResult(MutationResults.trainOrderChanged);
}

// =========================================================================
//  §18.  Canonical export & serialization (single definition of the saved schema)
// =========================================================================

function exportTrainStore() {
  return JSON.stringify(buildCanonicalTrainStore(), null, 2);
}

// Canonical shape builders shared by both the export and import paths so the
// serialized stop/style/route_policy schema has a single definition.
function canonicalStopShape(stop) {
  return {
    name: stop.name || "",
    n02_station_code: stop.n02_station_code || null,
    arrival: normalizeNullableTime(stop.arrival),
    departure: normalizeNullableTime(stop.departure),
    stop_type: stop.stop_type || "passenger_stop",
    ride_segment: Boolean(stop.ride_segment),
  };
}

function canonicalStyle(style) {
  // Only `color` is per-train now. Line width is a GLOBAL webpage setting
  // (顯示調節 → 線路粗細 = DISPLAY.routeWidthScale) and unridden intervals are
  // hidden entirely, so `weight` / `unridden_opacity` are no longer stored per
  // train — any inbound values (legacy or hand-authored) are dropped here.
  return { color: style?.color || DEFAULT_TRAIN_COLOR };
}

function canonicalRoutePolicy(routePolicy) {
  return {
    mode: "single_primary_route",
    jr_only: routePolicy?.jr_only === true,
    allow_alternatives: false,
    allow_browser_straight_line_fallback: false,
    allowed_institution_type_codes:
      routePolicy?.allowed_institution_type_codes || [
        ...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES,
      ],
    preferred_line_names: Array.isArray(routePolicy?.preferred_line_names)
      ? routePolicy.preferred_line_names.map(String).filter(Boolean)
      : [],
    preferred_operator_names: Array.isArray(
      routePolicy?.preferred_operator_names,
    )
      ? routePolicy.preferred_operator_names.map(String).filter(Boolean)
      : [],
    institution_filter_mode: routePolicy?.institution_filter_mode || "soft",
  };
}

function normalizeExportRouteSection(section) {
  const normalized = {
    from: section.from || "",
    to: section.to || "",
    from_n02_station_code: section.from_n02_station_code || null,
    to_n02_station_code: section.to_n02_station_code || null,
  };
  if (Array.isArray(section.line_names) && section.line_names.length)
    normalized.line_names = [...section.line_names];
  if (Array.isArray(section.operator_names) && section.operator_names.length)
    normalized.operator_names = [...section.operator_names];
  // Branch-portion train number / name (optional; see normalizeImportedRouteSection).
  if (section.number) normalized.number = String(section.number);
  if (section.name) normalized.name = String(section.name);
  return normalized;
}

function getRideRouteSectionsForTrain(train) {
  const stops = train?.stops || [];
  const sections = Array.isArray(train?.route_sections)
    ? train.route_sections
    : [];
  const calculated = [];

  for (let index = 0; index < stops.length - 1; index += 1) {
    const fromStop = stops[index];
    const toStop = stops[index + 1];
    const existing = findRouteSectionForStopPair(
      sections,
      fromStop,
      toStop,
      index,
    );

    if (existing) {
      calculated.push(normalizeExportRouteSection(existing));
      continue;
    }

    const from = resolveStationForTrain(fromStop, train);
    const to = resolveStationForTrain(toStop, train);
    calculated.push({
      from: stopName(fromStop),
      to: stopName(toStop),
      from_n02_station_code: from
        ? stationCode(from)
        : fromStop.n02_station_code || null,
      to_n02_station_code: to
        ? stationCode(to)
        : toStop.n02_station_code || null,
    });
  }

  return calculated;
}

function findRouteSectionForStopPair(
  sections,
  fromStop,
  toStop,
  preferredIndex,
) {
  const preferred = sections[preferredIndex];
  if (routeSectionMatchesStopPair(preferred, fromStop, toStop))
    return preferred;
  return sections.find((section) =>
    routeSectionMatchesStopPair(section, fromStop, toStop),
  );
}

function routeSectionMatchesStopPair(section, fromStop, toStop) {
  if (!section) return false;
  const fromCode = stopStationCode(fromStop);
  const toCode = stopStationCode(toStop);
  const sectionFromCode = section.from_n02_station_code || null;
  const sectionToCode = section.to_n02_station_code || null;
  const codeMatches = Boolean(
    fromCode &&
    toCode &&
    sectionFromCode &&
    sectionToCode &&
    String(fromCode) === String(sectionFromCode) &&
    String(toCode) === String(sectionToCode),
  );
  const nameMatches = Boolean(
    stopName(fromStop) &&
    stopName(toStop) &&
    stopName(fromStop) === (section.from || "") &&
    stopName(toStop) === (section.to || ""),
  );

  // Official source station codes are line/operator-specific. A stop can be displayed with one
  // line-code while the route_section intentionally uses another line-code
  // for the same physical station transfer/through-running point.  Treat a
  // same-name adjacent pair as the same route section instead of forcing the
  // stop code and route-section code to be identical.
  return codeMatches || nameMatches;
}

function normalizeExportTrain(train) {
  const normalized = {
    id: train.id || "",
    date: normalizeTrainDate(train),
    number: train.number || "",
    train_type: train.train_type || "",
    company: normalizeTrainCompany(train.company),
    origin: train.origin || "",
    destination: train.destination || "",
    direction: train.direction || "down",
    visible: train.visible !== false,
    style: canonicalStyle(train.style),
    route_policy: canonicalRoutePolicy(train.route_policy),
    route_sections: getRideRouteSectionsForTrain(train).map(leanExportSection),
    stops: Array.isArray(train.stops)
      ? train.stops.map(canonicalStopShape)
      : [],
  };
  // Route geometry is intentionally NOT persisted into the store anymore.
  // It is cached cross-session in IndexedDB (warmed into runtimeRouteCache on
  // boot) and re-solved on a miss, so embedding it here only bloated
  // train-store.json (~96% of the file) and the in-memory train objects.
  return normalized;
}

function normalizeTrainCompany(value) {
  const company = typeof value === "string" ? value.trim() : "";
  return activeCountry === "tw"
    ? RailOperatorBranding.normalizeTaiwanCompanyName(company)
    : company;
}

// Export-only: drop a route_section's from/to NAME when it is derivable from
// the section's code (== the station table's authoritative name, jsonspec
// §13.4), so the persisted/exported archive keeps each station's name once (on
// its stop) instead of repeating it in every section. A name with no code, or
// one that differs from the code's name (alias/override), is kept. Codes and
// line/operator hints are always kept. NOTE: applied ONLY here in the export
// path — getRideRouteSectionsForTrain() itself stays untouched because it also
// feeds live routing / in-memory state (which must keep the resolved names).
function leanExportSection(section) {
  const fromCode = section.from_n02_station_code || null;
  const toCode = section.to_n02_station_code || null;
  const out = {};
  if (section.from && (!fromCode || stationNameForCode(fromCode) !== section.from))
    out.from = section.from;
  if (section.to && (!toCode || stationNameForCode(toCode) !== section.to))
    out.to = section.to;
  out.from_n02_station_code = fromCode;
  out.to_n02_station_code = toCode;
  if (Array.isArray(section.line_names) && section.line_names.length)
    out.line_names = [...section.line_names];
  if (Array.isArray(section.operator_names) && section.operator_names.length)
    out.operator_names = [...section.operator_names];
  if (section.number) out.number = String(section.number);
  if (section.name) out.name = String(section.name);
  return out;
}

function buildCanonicalTrainStore() {
  return {
    schema_version: SCHEMA_VERSION,
    trains: trainStore.trains.map(normalizeExportTrain),
  };
}

// =========================================================================
//  §19.  Import parsing & normalization (lenient inbound -> canonical shape)
// =========================================================================

function parseImportedCanonicalStore(json) {
  const parsed = typeof json === "string" ? JSON.parse(json) : json;

  if (Array.isArray(parsed)) {
    return { schema_version: SCHEMA_VERSION, trains: parsed };
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      "JSON root must be a store object, a trains array, or one train object.",
    );
  }

  if (Array.isArray(parsed.trains)) {
    assertOnlyKeys(parsed, ["schema_version", "trains"], "Store");

    if (!ACCEPTED_SCHEMA_VERSIONS.includes(parsed.schema_version)) {
      throw new Error(
        `schema_version must be one of ${ACCEPTED_SCHEMA_VERSIONS.join(", ")}.`,
      );
    }

    return parsed;
  }

  if (parsed.id && parsed.stops) {
    return { schema_version: SCHEMA_VERSION, trains: [parsed] };
  }

  throw new Error(
    "JSON must contain a trains array, be a trains array, or be a single train object.",
  );
}

function assertOnlyKeys(object, allowedKeys, label) {
  Object.keys(object || {}).forEach((key) => {
    if (!allowedKeys.includes(key))
      throw new Error(`${label} contains unsupported field: ${key}.`);
  });
}

function normalizeImportedStop(stop) {
  if (!stop || typeof stop !== "object" || Array.isArray(stop)) {
    throw new Error("Each stop must be an object.");
  }

  assertOnlyKeys(
    stop,
    [
      "name",
      "n02_station_code",
      "arrival",
      "departure",
      "stop_type",
      "ride_segment",
    ],
    "Stop",
  );

  if (!("name" in stop)) {
    throw new Error("Each stop must contain name.");
  }

  return canonicalStopShape(stop);
}

function normalizeImportedRouteSection(section) {
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    throw new Error("Each route_section must be an object.");
  }

  assertOnlyKeys(
    section,
    [
      "from",
      "to",
      "from_n02_station_code",
      "to_n02_station_code",
      "line_names",
      "operator_names",
      "number",
      "name",
    ],
    "Route section",
  );

  // §13.4: from/to names are optional — when absent, resolve them from the
  // from/to codes via the station table so all in-memory logic (name matching,
  // §6.4 branch checks, tooltips) keeps working on a lean stored section.
  const fromCode = section.from_n02_station_code || null;
  const toCode = section.to_n02_station_code || null;
  const normalized = {
    from: section.from || stationNameForCode(fromCode),
    to: section.to || stationNameForCode(toCode),
    from_n02_station_code: fromCode,
    to_n02_station_code: toCode,
    line_names: Array.isArray(section.line_names)
      ? section.line_names.map(String).filter(Boolean)
      : [],
    operator_names: Array.isArray(section.operator_names)
      ? section.operator_names.map(String).filter(Boolean)
      : [],
  };
  // Optional per-section branch train number / name: some limited expresses run
  // a branch portion under a DIFFERENT 号 (e.g. はやぶさ↔こまち, しおかぜ↔いしづち).
  // When present it is shown for that segment in the route popup.
  if (section.number) normalized.number = String(section.number);
  if (section.name) normalized.name = String(section.name);
  return normalized;
}

function normalizeImportedTrain(train, { fallbackDate = null } = {}) {
  if (!train || typeof train !== "object" || Array.isArray(train)) {
    throw new Error("Each train must be an object.");
  }

  assertOnlyKeys(
    train,
    [
      "id",
      "date",
      "number",
      "train_type",
      "company",
      "origin",
      "destination",
      "direction",
      "visible",
      "style",
      "route_policy",
      "route_sections",
      "stops",
    ],
    "Train",
  );

  if (!train.id) throw new Error("Each train must contain id.");
  if (!train.number) throw new Error(`Train ${train.id} must contain number.`);
  if (!train.origin) throw new Error(`Train ${train.id} must contain origin.`);
  if (!train.destination)
    throw new Error(`Train ${train.id} must contain destination.`);
  if (!Array.isArray(train.stops) || train.stops.length < 2) {
    throw new Error(`Train ${train.id} must contain at least 2 stops.`);
  }

  const normalized = {
    id: train.id,
    date: normalizeTrainDate(train, fallbackDate),
    number: train.number,
    train_type:
      typeof train.train_type === "string" ? train.train_type.trim() : "",
    company: normalizeTrainCompany(train.company),
    origin: train.origin,
    destination: train.destination,
    direction: train.direction || "down",
    visible: train.visible !== false,
    style: canonicalStyle(train.style),
    route_policy: canonicalRoutePolicy(train.route_policy),
    route_sections: Array.isArray(train.route_sections)
      ? train.route_sections.map(normalizeImportedRouteSection)
      : [],
    stops: train.stops.map(normalizeImportedStop),
  };
  return normalized;
}

// The concrete date to assign an undated imported train to: the currently
// selected date when one is active, otherwise null (let id-inference decide).
function currentImportFallbackDate() {
  return selectedDate && selectedDate !== ALL_DATES ? selectedDate : null;
}

function appendImportedTrain(
  rawTrain,
  fallbackDate = currentImportFallbackDate(),
) {
  const train = normalizeImportedTrain(rawTrain, { fallbackDate });
  const existingIds = new Set(trainStore.trains.map((t) => t.id));
  train.id = makeUniqueTrainId(train.id, existingIds);

  // Validate ONLY the incoming train. Previously this rebuilt the whole
  // canonical store and re-validated every already-appended train (including
  // warnBranchLeak's per-section station resolution) on EVERY append — an
  // O(N²) pass that dominated large imports. Id uniqueness against the
  // existing store is already guaranteed by makeUniqueTrainId, and the one
  // authoritative full-store validateTrainStore() still runs at the end of
  // the load in finalizeProgressiveLoad().
  validateTrain(
    normalizeExportTrain(train),
    trainStore.trains.length,
    existingIds,
  );

  trainStore.trains.push(train);

  return train.id;
}

function waitForImportPaint() {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Prefer yielding on a real paint (rAF) so progressively-loaded lines appear
    // as they solve — BUT never depend on it. Browsers suspend requestAnimationFrame
    // in a hidden/backgrounded tab, so an rAF-only wait hangs the ENTIRE progressive
    // import until the tab is foregrounded: the map would sit stuck at "0/N" if the
    // page loads in a background tab or the user switches away mid-load. The timeout
    // both drives progress while hidden and caps the per-slice yield when a heavy
    // frame delays rAF. When visible, rAF (~16ms) wins the race and UX is unchanged.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(done, 0));
    }
    const hidden = typeof document !== "undefined" && document.hidden;
    // Hidden tab: rAF is suspended AND setTimeout(0) is clamped to >= 1 s, so
    // drive progress with an unthrottled macrotask yield instead — a 119-train
    // load in a background tab stays seconds, not minutes.
    if (hidden) _statsYield().then(done);
    else setTimeout(done, 100);
  });
}

async function importCanonicalStoreAppendProgressive(json, onProgress) {
  if (importInProgress) {
    console.warn(
      "A progressive load/import is already running; ignoring concurrent import.",
    );
    return { count: 0, ids: [] };
  }
  importInProgress = true;
  try {
    const importedStore = parseImportedCanonicalStore(json);

    if (!importedStore.trains.length) {
      throw new Error("Imported store contains no trains.");
    }

    if (onProgress) {
      onProgress({
        count: 0,
        total: importedStore.trains.length,
        id: I18N.t("prog.preparingId"),
      });
    }

    // Append mode: unlike the "replace" paths this does NOT reset the store.
    // Undated trains fall back to the currently-selected date (spec 3.1);
    // trains carrying their own `date` keep it (spec 3.2), and when "全部"
    // is active the date is inferred from the id instead.
    const wasRecovery = storeRecoveryMode;
    // Roll back on failure: appendImportedTrain pushes each valid train
    // before an invalid one throws, and without this the half-appended
    // prefix stayed in the store (and the next edit autosaved it).
    const baselineCount = trainStore.trains.length;
    let appendedIds;
    try {
      appendedIds = await runProgressiveAppend(importedStore.trains, {
        persistEachStep: true,
        onProgress,
        fallbackDate: currentImportFallbackDate(),
      });
    } catch (error) {
      if (trainStore.trains.length > baselineCount)
        trainStore.trains.length = baselineCount;
      renderAll();
      throw error;
    }
    if (wasRecovery) {
      // The user explicitly imported data over the recovery view and every
      // train loaded. Resume saving — and re-issue the persist that the
      // recovery guard swallowed during the append above.
      exitStoreRecoveryMode();
      saveTrainStore();
    }

    return {
      count: appendedIds.length,
      ids: appendedIds,
    };
  } finally {
    importInProgress = false;
    // If a server-side store change arrived mid-import, reconcile it now
    // instead of dropping it (bug: deferred live reloads were never retried).
    drainPendingLiveReload();
  }
}

// =========================================================================
//  §20.  Blank-train factory, id helpers & persist/render glue
// =========================================================================

// The blank-train scaffold is COUNTRY-SPECIFIC data: Japan keeps its 東京→熱海
// starter (whose N02 codes the solver can route immediately); Taiwan starts
// from the airport-MRT corridor with TDX StationUIDs, so a new Taiwan train
// never carries Japanese stops into the Taiwan store.
function createBlankTrain() {
  if (activeCountry === "tw") return createBlankTrainTw();
  if (activeCountry === "hk")
    return createBlankRegionalTrain({
      id: "HK-MTR",
      trainType: "港鐵",
      company: "香港鐵路有限公司",
      origin: "香港",
      destination: "機場",
      originCode: "AEL-MTR-HOK",
      destinationCode: "AEL-MTR-AIR",
      lineName: "機場快綫",
      color: "#1C7670",
    });
  if (activeCountry === "kr")
    return createBlankRegionalTrain({
      id: "KR-KORAIL",
      trainType: "무궁화호",
      company: "한국철도공사",
      origin: "서울",
      destination: "영등포",
      originCode: "KR-GYEONGBUSEON-SEOUL",
      destinationCode: "KR-GYEONGBUSEON-YEONGDEUNGPO",
      lineName: "경부선",
      color: "#0067A3",
      institutionCode: "2",
    });
  if (activeCountry === "mo")
    return createBlankRegionalTrain({
      id: "MO-LRT",
      trainType: "輕軌",
      company: "澳門輕軌股份有限公司",
      origin: "媽閣",
      destination: "海洋",
      originCode: "MLM-TAIPA-MLM-BARRA",
      destinationCode: "MLM-TAIPA-MLM-OCEAN",
      lineName: "氹仔線",
      color: "#72BF44",
    });
  return createBlankTrainJp();
}

function createBlankRegionalTrain(config) {
  return {
    id: config.id,
    number: "",
    train_type: config.trainType,
    company: config.company,
    origin: config.origin,
    destination: config.destination,
    direction: "down",
    visible: true,
    style: { color: config.color },
    route_policy: {
      mode: "single_primary_route",
      jr_only: false,
      allow_alternatives: false,
      allow_browser_straight_line_fallback: false,
      allowed_institution_type_codes: [config.institutionCode || "4"],
      preferred_line_names: [config.lineName],
      preferred_operator_names: [config.company],
      institution_filter_mode: "hard",
    },
    route_sections: [
      {
        from_n02_station_code: config.originCode,
        to_n02_station_code: config.destinationCode,
        line_names: [config.lineName],
        operator_names: [config.company],
      },
    ],
    stops: [
      {
        name: config.origin,
        n02_station_code: config.originCode,
        arrival: null,
        departure: null,
        stop_type: "origin",
        ride_segment: true,
      },
      {
        name: config.destination,
        n02_station_code: config.destinationCode,
        arrival: null,
        departure: null,
        stop_type: "destination",
        ride_segment: true,
      },
    ],
  };
}

function createBlankTrainTw() {
  return {
    id: "TW-LE",
    number: "",
    train_type: "直達車",
    company: "桃園捷運",
    origin: "台北車站",
    destination: "機場第二航廈站",
    direction: "down",
    visible: true,
    style: {
      color: "#8246af",
    },
    route_policy: {
      mode: "single_primary_route",
      jr_only: false,
      allow_alternatives: false,
      allow_browser_straight_line_fallback: false,
      allowed_institution_type_codes: [
        ...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES,
      ],
      preferred_line_names: ["桃園機場捷運"],
      preferred_operator_names: ["桃園大眾捷運股份有限公司"],
    },
    // No route_sections scaffold: Taiwan geometry comes from the curated
    // matched-routes channel (per train_id), not the N02 solver.
    route_sections: [],
    stops: [
      {
        name: "台北車站",
        n02_station_code: "TYMC-A1",
        arrival: null,
        departure: null,
        stop_type: "origin",
        ride_segment: true,
      },
      {
        name: "機場第二航廈站",
        n02_station_code: "TYMC-A13",
        arrival: null,
        departure: null,
        stop_type: "destination",
        ride_segment: true,
      },
    ],
  };
}

function createBlankTrainJp() {
  return {
    id: "LE",
    number: "",
    train_type: "特急",
    company: "",
    origin: "東京",
    destination: "熱海",
    direction: "down",
    visible: true,
    style: {
      color: "#1d7f8c",
    },
    route_policy: {
      mode: "single_primary_route",
      jr_only: false,
      allow_alternatives: false,
      allow_browser_straight_line_fallback: false,
      allowed_institution_type_codes: [
        ...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES,
      ],
    },
    route_sections: [
      {
        from: "東京",
        to: "品川",
        from_n02_station_code: "003770",
        to_n02_station_code: "004095",
      },
      {
        from: "品川",
        to: "横浜",
        from_n02_station_code: "004095",
        to_n02_station_code: "004634",
      },
      {
        from: "横浜",
        to: "小田原",
        from_n02_station_code: "004634",
        to_n02_station_code: "005218",
      },
      {
        from: "小田原",
        to: "熱海",
        from_n02_station_code: "005218",
        to_n02_station_code: "005685",
      },
    ],
    stops: [
      {
        name: "東京",
        n02_station_code: "003770",
        arrival: null,
        departure: null,
        stop_type: "origin",
        ride_segment: true,
      },
      {
        name: "熱海",
        n02_station_code: "005685",
        arrival: null,
        departure: null,
        stop_type: "destination",
        ride_segment: true,
      },
    ],
  };
}

function uniqueId(seed) {
  // Collapse whitespace in interactive seeds (e.g. "LE-copy" from a name), then
  // delegate to the shared uniqueness loop used by the import path.
  const clean =
    String(seed || "train")
      .trim()
      .replace(/\s+/g, "-") || "train";
  return makeUniqueTrainId(clean, new Set(trainStore.trains.map((t) => t.id)));
}

function getTrain(id = selectedTrainId) {
  return trainStore.trains.find((t) => t.id === id);
}
