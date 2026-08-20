// =========================================================================
//  app-validation.js — §33: validation (export textarea, store, branch-leak, per-train)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §33.  Validation (export textarea, store, branch-leak, per-train)
// =========================================================================

function validateTextareaJson() {
  try {
    const parsed = parseImportedCanonicalStore(els.importJson.value);
    const trains = parsed.trains.map(normalizeImportedTrain);

    if (!trains.length) {
      throw new Error("Imported store contains no trains.");
    }

    const nextStore = buildCanonicalTrainStore();

    // Mirror the import path: keep ONE running id set and validate each new
    // train individually, then validate the whole store once at the end.
    // The old loop rebuilt the id set AND re-validated every train added so
    // far per appended train — O(N²) full validations (each with station
    // resolution inside), freezing the UI for seconds on a large paste.
    const existingIds = new Set(nextStore.trains.map((t) => t.id));
    trains.forEach((train) => {
      train.id = makeUniqueTrainId(train.id, existingIds);
      existingIds.add(train.id);
      nextStore.trains.push(train);
    });
    validateTrainStore(nextStore);

    setStatus(
      els.importStatus,
      `JSON valid. ${trains.length} train(s) can be appended progressively.`,
      "ok",
    );
  } catch (error) {
    setStatus(els.importStatus, error.message, "err");
  }
}

function validateTrainStore(store) {
  if (!store || typeof store !== "object" || Array.isArray(store))
    throw new Error("JSON root must be an object.");
  assertOnlyKeys(store, ["schema_version", "trains"], "Store");
  if (!ACCEPTED_SCHEMA_VERSIONS.includes(store.schema_version))
    throw new Error(
      `schema_version must be one of ${ACCEPTED_SCHEMA_VERSIONS.join(", ")}.`,
    );
  if (!Array.isArray(store.trains)) throw new Error("trains must be an array.");
  const ids = new Set();
  store.trains.forEach((train, index) => validateTrain(train, index, ids));
  return true;
}

// §6.4 advisory branch-leak detection. Non-fatal (console warnings only) so
// import never fails on these, but it flags (a) route_sections that cross a
// junction / 支线分理处 without a hard line constraint, and (b) pass_through
// stops whose resolved line is on none of the adjacent sections' line_names —
// the classic "wrong branch" leak (e.g. シーサイドライナー picking up 有田 /
// 肥前浜 past 早岐). Defensive: silently returns if station data isn't loaded.
function warnBranchLeak(train) {
  try {
    if (typeof resolveStationCandidates !== "function") return;
    const stops = train.stops || [];
    const sections = Array.isArray(train.route_sections)
      ? train.route_sections
      : [];
    const linesOf = (stopLike) => {
      const set = new Set();
      (resolveStationCandidates(stopLike) || []).forEach((feature) => {
        const ln = stationLineName(feature);
        if (ln) set.add(String(ln));
      });
      return set;
    };
    sections.forEach((section, i) => {
      if (Array.isArray(section.line_names) && section.line_names.length)
        return;
      const fromLines = linesOf({
        name: section.from,
        n02_station_code: section.from_n02_station_code,
      });
      const toLines = linesOf({
        name: section.to,
        n02_station_code: section.to_n02_station_code,
      });
      if (fromLines.size > 1 || toLines.size > 1) {
        console.warn(
          `[§6.4] Train ${train.id} section ${i + 1} (${section.from}→${section.to}) crosses a junction but has no line_names; routing may leak onto the wrong branch.`,
        );
      }
    });
    stops.forEach((stop, idx) => {
      if (stop.stop_type !== "pass_through") return;
      const adjLines = new Set();
      [sections[idx - 1], sections[idx]].forEach((s) =>
        (s?.line_names || []).forEach((l) => adjLines.add(String(l))),
      );
      if (!adjLines.size) return;
      const stopLines = linesOf(stop);
      if (!stopLines.size) return;
      if (![...stopLines].some((l) => adjLines.has(l))) {
        console.warn(
          `[§6.4] Train ${train.id} pass_through "${stopName(stop)}" (lines: ${[...stopLines].join("/")}) is on none of the adjacent section line_names (${[...adjLines].join("/")}); likely wrong-branch leak.`,
        );
      }
    });
  } catch {
    // Advisory only; never block import on the heuristic.
  }
}

function validateTrain(train, index, ids) {
  const prefix = `Train ${index + 1}`;
  ["id", "number", "origin", "destination"].forEach((key) => {
    if (!train[key] || typeof train[key] !== "string")
      throw new Error(`${prefix}: ${key} is required.`);
  });
  // Optional metadata: 車輛類型 / 營運公司 ("/"-separated = 直通).
  ["train_type", "company"].forEach((key) => {
    if (train[key] !== undefined && typeof train[key] !== "string")
      throw new Error(`${prefix}: ${key} must be a string when present.`);
  });
  // §3.2: ids feed route_id / cache keys / DOM ids, so keep them to the
  // documented charset instead of accepting arbitrary text.
  if (!TRAIN_ID_PATTERN.test(train.id))
    throw new Error(
      `${prefix}: id must match ${TRAIN_ID_PATTERN.source} (letters, digits, "_" and "-").`,
    );
  if (ids.has(train.id))
    throw new Error(`${prefix}: duplicate id ${train.id}.`);
  ids.add(train.id);
  if (
    train.date !== undefined &&
    train.date !== UNDATED &&
    !isValidDateString(train.date)
  ) {
    throw new Error(`${prefix}: date must be "YYYY-MM-DD" or "${UNDATED}".`);
  }
  if (!Array.isArray(train.stops) || train.stops.length < 2)
    throw new Error(`${prefix}: stops must contain at least 2 rows.`);
  if (train.stops[0].departure && train.stops[0].arrival)
    throw new Error(
      `${prefix}: first stop should not need both arrival and departure.`,
    );
  const last = train.stops[train.stops.length - 1];
  if (last.departure && last.arrival)
    throw new Error(
      `${prefix}: final stop should not need both arrival and departure.`,
    );
  train.stops.forEach((stop, stopIndex) => {
    if (!stopName(stop))
      throw new Error(`${prefix} stop ${stopIndex + 1}: name is required.`);
    if (!stop.stop_type)
      throw new Error(
        `${prefix} stop ${stopIndex + 1}: stop_type is required.`,
      );
    // §7.2: an unrecognised stop_type silently falls through every
    // `=== "pass_through"` test and gets treated as a stopping station, so
    // reject it here rather than mis-rendering it later.
    if (!STOP_TYPES.includes(stop.stop_type))
      throw new Error(
        `${prefix} stop ${stopIndex + 1}: stop_type must be one of ${STOP_TYPES.join(" / ")}.`,
      );
    if (typeof stop.ride_segment !== "boolean") {
      throw new Error(
        `${prefix} stop ${stopIndex + 1}: ride_segment must be boolean.`,
      );
    }
    if (!isValidSourceStationCode(stop.n02_station_code)) {
      throw new Error(
        `${prefix} stop ${stopIndex + 1}: n02_station_code must be a six-digit N02_005c, a TDX StationUID, or null.`,
      );
    }
    ["arrival", "departure"].forEach((field) => {
      if (
        stop[field] !== null &&
        stop[field] !== undefined &&
        typeof stop[field] !== "string"
      ) {
        throw new Error(
          `${prefix} stop ${stopIndex + 1}: ${field} must be a string or null.`,
        );
      }
    });
  });
  if (train.route_sections) {
    if (!Array.isArray(train.route_sections))
      throw new Error(`${prefix}: route_sections must be an array.`);
    train.route_sections.forEach((section, sectionIndex) => {
      if (
        !(section.from || section.from_n02_station_code) ||
        !(section.to || section.to_n02_station_code)
      ) {
        throw new Error(
          `${prefix} route section ${sectionIndex + 1}: from/to names or official station codes are required.`,
        );
      }
      ["from_n02_station_code", "to_n02_station_code"].forEach((field) => {
        if (!isValidSourceStationCode(section[field])) {
          throw new Error(
            `${prefix} route section ${sectionIndex + 1}: ${field} must be a six-digit N02_005c, a TDX StationUID, or null.`,
          );
        }
      });
      ["line_names", "operator_names"].forEach((field) => {
        const values = section[field] || [];
        if (
          !Array.isArray(values) ||
          values.some((value) => typeof value !== "string")
        ) {
          throw new Error(
            `${prefix} route section ${sectionIndex + 1}: ${field} must be an array of strings.`,
          );
        }
      });
    });
  }
  if (train.route_policy) {
    if (train.route_policy.mode !== "single_primary_route")
      throw new Error(
        `${prefix}: route_policy.mode must be single_primary_route.`,
      );
    if (typeof train.route_policy.jr_only !== "boolean")
      throw new Error(`${prefix}: route_policy.jr_only must be boolean.`);
    if (train.route_policy.allow_alternatives !== false)
      throw new Error(
        `${prefix}: route_policy.allow_alternatives must be false.`,
      );
    if (train.route_policy.allow_browser_straight_line_fallback !== false)
      throw new Error(
        `${prefix}: route_policy.allow_browser_straight_line_fallback must be false.`,
      );
    const allowed = train.route_policy.allowed_institution_type_codes || [];
    if (
      !Array.isArray(allowed) ||
      allowed.some((code) => !N02_INSTITUTION_TYPE_CODES.has(String(code)))
    ) {
      throw new Error(
        `${prefix}: route_policy.allowed_institution_type_codes must contain only N02_002 codes 1/2/3/4/5.`,
      );
    }
    ["preferred_line_names", "preferred_operator_names"].forEach((field) => {
      const values = train.route_policy[field] || [];
      if (
        !Array.isArray(values) ||
        values.some((value) => typeof value !== "string")
      ) {
        throw new Error(
          `${prefix}: route_policy.${field} must be an array of strings.`,
        );
      }
    });
    if (
      train.route_policy.institution_filter_mode &&
      !["soft", "hard"].includes(train.route_policy.institution_filter_mode)
    ) {
      throw new Error(
        `${prefix}: route_policy.institution_filter_mode must be soft or hard.`,
      );
    }
  }
  const color = train.style?.color;
  if (color && !isValidTrainColor(color))
    throw new Error(`${prefix}: style.color must be #RRGGBB.`);
  warnBranchLeak(train);
}
