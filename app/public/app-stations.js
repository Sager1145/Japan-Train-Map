// =========================================================================
//  app-stations.js — §11: station resolution & generic data accessors
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §11.  Station resolution & generic data accessors
// =========================================================================

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stationName(feature) {
  return (
    feature.properties.station_name ||
    feature.properties.name ||
    feature.properties.N02_005
  );
}

function stationCode(feature) {
  const p = feature.properties || {};
  return p.n02_station_code || p.N02_005c || null;
}

// jsonspec 1.3 keeps the historical serialized key `n02_station_code` for
// backwards compatibility, but the value follows the active official railway
// source: six-digit N02_005c in Japan, TDX StationUID in Taiwan (TYMC-A13,
// TRA-1000, ...).  Keep format detection centralized so validation and popup
// labels cannot drift.
function stationCodeSystem(code) {
  const value = String(code || "").trim();
  if (/^\d{6}$/.test(value)) return "N02";
  if (/^[A-Z][A-Z0-9]*-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value))
    return "TDX";
  return null;
}

function isValidSourceStationCode(code) {
  return code === null || code === undefined || stationCodeSystem(code) !== null;
}

function stationCodeFieldLabel(code) {
  return stationCodeSystem(code) === "TDX" ? "TDX StationUID" : "N02_005c";
}

function stationGroupCode(feature) {
  const p = feature.properties || {};
  return (
    p.n02_group_code ||
    p.N02_005g ||
    p.official_station_group_id ||
    p.stationGroupId ||
    null
  );
}

function stationLineName(feature) {
  const p = feature.properties || {};
  return p.line_name || p.N02_003 || "-";
}

function stationOperator(feature) {
  const p = feature.properties || {};
  return p.operator || p.N02_004 || "-";
}

function stationInstitutionTypeCode(feature) {
  const p = feature.properties || {};
  return String(p.institution_type_code || p.N02_002 || "");
}

function stopName(stop) {
  return stop.name || "";
}

function stopStationCode(stop) {
  return stop.n02_station_code || stop.N02_005c || null;
}

// Normalize a station name for tolerant matching against imperfect JSON.
// The rule itself lives in AppCore (one owner for every station-name key in
// the system — resolution index here, i18n's reading lookup, and the build
// scripts); this is the app-family alias. Runtime property access on purpose:
// safe under any script order and in the precompute VM replay.
function normalizeStationName(value) {
  return window.AppCore.normalizeStationName(value);
}

function stationLookupKeys(name, code) {
  const keys = [];
  if (code) {
    const cleanCode = String(code).trim();
    if (cleanCode) keys.push(cleanCode);
  }
  if (name) {
    const cleanName = String(name).trim();
    if (cleanName) keys.push(cleanName);
    // Index a normalized alias too, so a stop written 柳ケ浦 still finds 柳ヶ浦.
    const normalized = normalizeStationName(name);
    if (normalized && normalized !== cleanName) keys.push(normalized);
  }
  return [...new Set(keys)];
}

// Async, frame-budget-sliced construction of BOTH station-resolution indexes
// (the name/code candidate index and the code -> name map) in a single pass
// over the feature list. Replaces the two synchronous O(N) loops that used to
// run inline in loadAppData and extended boot Block 1's long task. Yields to
// the browser (setTimeout 0) whenever the current slice has run ~12 ms, and
// builds into local Maps that are atomically swapped into the module globals
// only at the end, so no consumer can observe a half-built index mid-slice.
// Builds the name/code candidate index plus the code -> name map in one pass.
async function buildStationIndexesSliced(collection) {
  const candidates = new Map();
  const nameByCode = new Map();
  const features = (collection && collection.features) || [];
  const now = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now();
  let t0 = now();
  for (let i = 0; i < features.length; i += 1) {
    const feature = features[i];
    const name = stationName(feature);
    const code = stationCode(feature);
    stationLookupKeys(name, code).forEach((key) => {
      let arr = candidates.get(key);
      if (!arr) {
        arr = [];
        candidates.set(key, arr);
      }
      arr.push(feature);
    });
    if (code) nameByCode.set(String(code), name);
    if ((i & 1023) === 1023 && now() - t0 > 12) {
      // _statsYield, not setTimeout(0): exempt from the >=1 s background-tab
      // timer clamp, so a boot in a hidden tab isn't stretched by seconds.
      await _statsYield();
      t0 = now();
    }
  }
  stationCandidatesIndex = candidates;
  stationNameByCode = nameByCode;
}

// Display coordinates of a train's UNAMBIGUOUS stops (single name candidate or
// carrying a station code). These anchor the geographic disambiguation of any
// same-name stop, so e.g. 池田 on a Hokkaido train resolves to 根室線 池田 rather
// than 阪急 池田 in Osaka. `excludeStop` skips the stop currently being resolved.
function trainAnchorCoordinates(train, excludeStop) {
  const coords = [];
  (train?.stops || []).forEach((stop) => {
    if (stop === excludeStop) return;
    const candidates = resolveStationCandidates(stop);
    if (!candidates.length) return;
    if (candidates.length === 1 || stopStationCode(stop)) {
      const coord = getFeatureDisplayCoordinate(candidates[0]);
      if (coord) coords.push(coord);
    }
  });
  return coords;
}

// Train-aware single-station resolution. Prefers candidates in the train's
// allowed institution class and, when a name is still ambiguous, picks the one
// nearest the train's anchor stops. With no train context it simply returns
// the first by-name candidate.
function resolveStationForTrain(stopOrName, train) {
  const candidates = resolveStationCandidates(stopOrName);
  if (candidates.length <= 1) return candidates[0] || null;

  const allowedCodes = train ? getAllowedInstitutionTypeCodes(train) : null;
  const preferred = allowedCodes
    ? filterStationsByPreferredInstitution(candidates, allowedCodes)
    : [];
  const pool = preferred.length ? preferred : candidates;
  if (pool.length === 1) return pool[0];

  const excludeStop = typeof stopOrName === "object" ? stopOrName : null;
  const anchors = train ? trainAnchorCoordinates(train, excludeStop) : [];
  if (!anchors.length) return pool[0];

  let best = pool[0];
  let bestDistance = Infinity;
  pool.forEach((feature) => {
    const coord = getFeatureDisplayCoordinate(feature);
    if (!coord) return;
    let nearest = Infinity;
    anchors.forEach((anchor) => {
      const d = distanceMeters(coord, anchor);
      if (d < nearest) nearest = d;
    });
    if (nearest < bestDistance) {
      bestDistance = nearest;
      best = feature;
    }
  });
  return best;
}

function dedupeStationFeatures(features) {
  const seen = new Set();
  const candidates = [];
  (features || []).forEach((feature) => {
    const signature = `${stationCode(feature) || ""}|${stationName(feature) || ""}|${stationLineName(feature) || ""}|${stationOperator(feature) || ""}|${JSON.stringify(feature.geometry?.coordinates?.[0] || [])}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    candidates.push(feature);
  });
  return candidates;
}

function resolveStationCandidates(stopOrName) {
  if (!stopOrName) return [];
  const name =
    typeof stopOrName === "string" ? stopOrName : stopName(stopOrName);
  const code =
    typeof stopOrName === "string" ? null : stopStationCode(stopOrName);
  const cleanName = name ? String(name).trim() : "";
  const cleanCode = code ? String(code).trim() : "";

  // A source station code is line/operator-specific. Do not union code matches with
  // same-name matches, otherwise an inconsistent imported pair such as
  // { name: "千葉", n02_station_code: "003859" } can mix 越中島 and 千葉
  // candidates and make Dijkstra jump to the wrong city/line.
  const normalizedQueryName = normalizeStationName(cleanName);
  const codeCandidates = cleanCode
    ? dedupeStationFeatures(stationCandidatesIndex.get(cleanCode) || [])
    : [];
  if (codeCandidates.length) {
    if (!cleanName) return codeCandidates;
    const codeAndNameCandidates = codeCandidates.filter(
      (feature) =>
        normalizeStationName(stationName(feature)) === normalizedQueryName,
    );
    if (codeAndNameCandidates.length) return codeAndNameCandidates;
    console.warn(
      "Station source code/name mismatch; falling back to station name candidates.",
      {
        name: cleanName,
        n02_station_code: cleanCode,
        code_candidates: codeCandidates.map((feature) => ({
          name: stationName(feature),
          n02_station_code: stationCode(feature),
          line_name: stationLineName(feature),
          operator: stationOperator(feature),
        })),
      },
    );
  }

  // Try the exact name first, then the normalized alias (handles ケ/ヶ, width).
  const nameCandidates = cleanName
    ? dedupeStationFeatures(
        stationCandidatesIndex.get(cleanName) ||
          stationCandidatesIndex.get(normalizedQueryName) ||
          [],
      )
    : [];
  return nameCandidates.length ? nameCandidates : codeCandidates;
}
