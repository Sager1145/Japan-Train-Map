(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AppCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---- protocol/schema constants (jsonspec) ------------------------------
  // Shared by the browser (public/app-config.js re-exports them as bare globals) and
  // the Node server backstop (server/train-store.js requires this file), so a
  // schema bump can never drift between the two sides.
  const SCHEMA_VERSION = "1.3";
  const ACCEPTED_SCHEMA_VERSIONS = Object.freeze(["1.3"]);
  // Train ids flow into route_id, route cache keys and DOM ids, so they are
  // restricted to the charset documented in jsonspec §3.2.
  const TRAIN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
  // Bucket for trains whose date could neither be supplied nor inferred.
  const UNDATED = "undated";

  // Country-scoped resource naming: Japan keeps every historical unsuffixed
  // name; any other country gets "-{country}". The ONE spelling of that
  // rule, shared by the browser mappers (app-config.js) and the server's
  // per-country store registry (server/create-app.js) — so a future country
  // can never inherit Japan's store/db/API names by falling through a
  // hardcoded `=== "tw"` ternary.
  function countrySuffixed(base, country) {
    return country === "jp" ? base : `${base}-${country}`;
  }

  // ---- N02 5-decimal grid + shared geometry primitives -------------------
  // N02 coordinates mix 5-decimal (most lines) and full-precision 8-decimal
  // vertices (e.g. 北陸新幹線). Every cross-module coordinate identity —
  // route-solver graph nodes, stats edge matching, deck-record segment keys,
  // the build-time station expansion — MUST quantize to the same 5-decimal
  // grid or full-precision lines never match their ridden routes, so the rule
  // lives here exactly once.
  function quant5(v) {
    return Math.round(v * 1e5) / 1e5;
  }
  // "lon,lat" node key on the 5-decimal grid.
  function coordKey5(coord) {
    return quant5(coord[0]) + "," + quant5(coord[1]);
  }
  // Direction-independent segment key: the two node keys, smaller first.
  function edgeKey5(a, b) {
    const ax = quant5(a[0]);
    const ay = quant5(a[1]);
    const bx = quant5(b[0]);
    const by = quant5(b[1]);
    return ax < bx || (ax === bx && ay < by)
      ? ax + "," + ay + "|" + bx + "," + by
      : bx + "," + by + "|" + ax + "," + ay;
  }
  // Tolerant station-name normalization — the ONE key rule for every
  // station-name identity in the system: the station-resolution index
  // (app-stations.js), the reading-table byName lookup (i18n.js, which also
  // re-keys station-readings.json through this at load), and the build
  // scripts' station-code lookup (scripts/lib/expand-route-stations.mjs).
  // NFKC folds full/half-width differences; internal whitespace and the
  // small/large kana variants (柳ヶ浦 vs 柳ケ浦) that N02, hand-written JSON
  // and the readings table spell inconsistently are unified.
  function normalizeStationName(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, "")
      .replace(/ヶ/g, "ケ")
      .replace(/ヵ/g, "カ")
      .replace(/ゖ/g, "け")
      .replace(/ゕ/g, "か");
  }

  // Equirectangular km between two lon/lat points: the cheap distance used
  // for graph edge weights and stats sums (the route solver's haversine
  // `distanceMeters` stays separate — different accuracy class on purpose).
  function equirectKm(ax, ay, bx, by) {
    const kx = 111.32 * Math.cos((((ay + by) / 2) * Math.PI) / 180);
    return Math.hypot((ax - bx) * kx, (ay - by) * 110.574);
  }

  // Minimal binary min-heap over [priority, value] tuples, shared by the
  // stats corridor trace and the build-time station expansion. (The route
  // solver keeps its own object-shaped heap — different item API.)
  class TupleMinHeap {
    constructor() {
      this._h = [];
    }
    get size() {
      return this._h.length;
    }
    push(priority, value) {
      const h = this._h;
      h.push([priority, value]);
      let i = h.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (h[p][0] <= h[i][0]) break;
        [h[p], h[i]] = [h[i], h[p]];
        i = p;
      }
    }
    pop() {
      const h = this._h;
      const top = h[0];
      const last = h.pop();
      if (h.length) {
        h[0] = last;
        let i = 0;
        const n = h.length;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let s = i;
          if (l < n && h[l][0] < h[s][0]) s = l;
          if (r < n && h[r][0] < h[s][0]) s = r;
          if (s === i) break;
          [h[s], h[i]] = [h[i], h[s]];
          i = s;
        }
      }
      return top;
    }
  }

  function isValidDateString(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
      return false;
    const [, month, day] = value.split("-").map(Number);
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }

  function normalizeDateString(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim().replace(/\//g, "-");
    return isValidDateString(normalized) ? normalized : null;
  }

  function inferDateFromTrainId(id) {
    const match = /(?:^|[^0-9])(\d{4})(\d{2})(\d{2})(?:[^0-9]|$)/.exec(
      String(id || ""),
    );
    if (!match) return null;
    const candidate = `${match[1]}-${match[2]}-${match[3]}`;
    return isValidDateString(candidate) ? candidate : null;
  }

  function normalizeTrainDate(
    train,
    fallbackDate = null,
    undatedValue = UNDATED,
  ) {
    const explicit = normalizeDateString(train && train.date);
    if (explicit) return explicit;
    const fallback = normalizeDateString(fallbackDate);
    if (fallback) return fallback;
    const inferred = inferDateFromTrainId(train && train.id);
    return inferred || undatedValue;
  }

  function parseTimeToMinutes(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d{1,2}):(\d{2})(?:\s*\+\s*(\d+))?/.exec(value.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const dayOffset = match[3] ? Number(match[3]) : 0;
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    return dayOffset * 24 * 60 + hours * 60 + minutes;
  }

  // ---- cross-day (overnight) itineraries ---------------------------------
  // jsonspec §10.1/§10.5: a train that runs past midnight keeps counting up —
  // 25:10 means 01:10 the NEXT day. (The legacy "10:00+1" suffix parses the
  // same way, so old JSON keeps working.) Everything below turns those times
  // into "which calendar day is this part of the itinerary on".
  //
  // Cheap pre-test so the common case — no cross-day time anywhere — costs a
  // couple of string compares per stop instead of a regex per time.
  function isCrossDayTimeString(value) {
    if (typeof value !== "string") return false;
    const text = value.trim();
    if (text.includes("+")) return true;
    const colon = text.indexOf(":");
    return colon > 0 && Number(text.slice(0, colon)) >= 24;
  }

  function trainHasCrossDayTimes(train) {
    const stops = Array.isArray(train && train.stops) ? train.stops : [];
    for (let i = 0; i < stops.length; i += 1) {
      const stop = stops[i];
      if (!stop) continue;
      if (isCrossDayTimeString(stop.arrival)) return true;
      if (isCrossDayTimeString(stop.departure)) return true;
    }
    return false;
  }

  // The moment the train is first AT a stop. A stop that itself straddles
  // midnight (arrival 23:58 / departure 25:03) therefore still counts as
  // belonging to the outgoing day.
  function stopDayMinutes(stop) {
    const arrival = parseTimeToMinutes(stop && stop.arrival);
    if (arrival !== null) return arrival;
    return parseTimeToMinutes(stop && stop.departure);
  }

  // Day breaks of one train: `{ index, day }` means the itinerary rolls into
  // day `day` (0-based, counted from the train's own `date`) AFTER stops[index]
  // — so `index` is the last station of the outgoing day, the one the map
  // marks with the cross-day symbol. Untimed stops (pass-throughs carry no
  // times) inherit the previous timed stop's day, which puts the break on the
  // last station whose recorded time is still before midnight.
  function trainDayBreaks(train) {
    if (!trainHasCrossDayTimes(train)) return [];
    const stops = Array.isArray(train && train.stops) ? train.stops : [];
    const breaks = [];
    let lastTimedIndex = -1;
    let lastDay = 0;
    for (let i = 0; i < stops.length; i += 1) {
      const minutes = stopDayMinutes(stops[i]);
      if (minutes === null) continue;
      const day = Math.floor(minutes / 1440);
      // A train whose FIRST timed stop already reads 25:xx is mis-dated, not
      // cross-day: with no earlier station there is nothing to break away from.
      if (day > lastDay && lastTimedIndex >= 0)
        breaks.push({ index: lastTimedIndex, day });
      if (day > lastDay) lastDay = day;
      lastTimedIndex = i;
    }
    return breaks;
  }

  // The day a STOP belongs to. The break station itself closes the outgoing
  // day (`stopIndex > index`), which is why one symbol serves both directions:
  // it is the last station of day D and the first of day D+1.
  function dayIndexForStop(breaks, stopIndex) {
    let day = 0;
    for (let i = 0; i < (breaks || []).length; i += 1)
      if (stopIndex > breaks[i].index) day = breaks[i].day;
    return day;
  }

  // The day a route SEGMENT belongs to. Segment s runs stops[s] → stops[s+1],
  // so the segment LEAVING the break station is already next-day — exactly the
  // stretch drawn dashed while its neighbouring day is selected.
  function dayIndexForSegment(breaks, segmentIndex) {
    let day = 0;
    for (let i = 0; i < (breaks || []).length; i += 1)
      if (segmentIndex >= breaks[i].index) day = breaks[i].day;
    return day;
  }

  function addDaysToDateString(date, days) {
    if (!isValidDateString(date)) return null;
    if (!days) return date;
    const [year, month, day] = date.split("-").map(Number);
    const shifted = new Date(
      Date.UTC(year, month - 1, day) + days * 86400000,
    );
    const pad = (n) => String(n).padStart(2, "0");
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  }

  function getTrainDepartureMinutes(train) {
    const stops = Array.isArray(train && train.stops) ? train.stops : [];
    if (!stops.length) return Infinity;
    const firstStopDeparture = parseTimeToMinutes(stops[0].departure);
    if (firstStopDeparture !== null) return firstStopDeparture;
    const originStop = stops.find(
      (stop) => stop && stop.stop_type === "origin",
    );
    if (originStop) {
      const originDeparture = parseTimeToMinutes(originStop.departure);
      if (originDeparture !== null) return originDeparture;
    }
    for (const stop of stops) {
      const departure = parseTimeToMinutes(stop && stop.departure);
      if (departure !== null) return departure;
    }
    return Infinity;
  }

  function dateSortKey(date, undatedValue = UNDATED) {
    return date === undatedValue ? "￿" : date;
  }

  function compareTrainsByDateAndDeparture(
    a,
    b,
    undatedValue = UNDATED,
  ) {
    const dateA = dateSortKey(
      normalizeTrainDate(a, null, undatedValue),
      undatedValue,
    );
    const dateB = dateSortKey(
      normalizeTrainDate(b, null, undatedValue),
      undatedValue,
    );
    if (dateA < dateB) return -1;
    if (dateA > dateB) return 1;
    const departureA = getTrainDepartureMinutes(a);
    const departureB = getTrainDepartureMinutes(b);
    if (departureA !== departureB) return departureA - departureB;
    return String(a.id).localeCompare(String(b.id));
  }

  // Blank means "no time": undefined, empty and whitespace-only entries all
  // collapse to null, and real times shed stray padding — the same rule the
  // stop editor applies on input, so imported JSON can't disagree with it.
  function normalizeNullableTime(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }

  function makeUniqueTrainId(baseId, existingIds) {
    const cleanBase = String(baseId || "train").trim() || "train";
    let id = cleanBase;
    let counter = 2;
    while (existingIds.has(id)) {
      id = `${cleanBase}-${counter}`;
      counter += 1;
    }
    return id;
  }

  async function parseFeatureCollectionChunked(
    text,
    {
      now = () =>
        typeof performance !== "undefined" ? performance.now() : Date.now(),
      yieldControl = () => Promise.resolve(),
    } = {},
  ) {
    const length = text.length;
    const featuresKey = text.indexOf('"features"');
    let index =
      featuresKey === -1 ? -1 : text.indexOf("[", featuresKey);
    if (index === -1) return JSON.parse(text);
    index += 1;

    const features = [];
    let sliceStartedAt = now();
    while (index < length) {
      let charCode = text.charCodeAt(index);
      while (
        index < length &&
        (charCode === 32 ||
          charCode === 10 ||
          charCode === 13 ||
          charCode === 9 ||
          charCode === 44)
      ) {
        index += 1;
        charCode = text.charCodeAt(index);
      }
      if (index >= length || charCode === 93) break;

      const start = index;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (; index < length; index += 1) {
        const current = text.charCodeAt(index);
        if (inString) {
          if (escaped) escaped = false;
          else if (current === 92) escaped = true;
          else if (current === 34) inString = false;
        } else if (current === 34) {
          inString = true;
        } else if (current === 123) {
          depth += 1;
        } else if (current === 125) {
          depth -= 1;
          if (depth === 0) {
            index += 1;
            break;
          }
        }
      }
      features.push(JSON.parse(text.slice(start, index)));
      if ((features.length & 255) === 0 && now() - sliceStartedAt > 8) {
        await yieldControl();
        sliceStartedAt = now();
      }
    }
    return { type: "FeatureCollection", features };
  }

  return Object.freeze({
    ACCEPTED_SCHEMA_VERSIONS,
    SCHEMA_VERSION,
    TRAIN_ID_PATTERN,
    TupleMinHeap,
    UNDATED,
    addDaysToDateString,
    compareTrainsByDateAndDeparture,
    coordKey5,
    countrySuffixed,
    dateSortKey,
    edgeKey5,
    equirectKm,
    quant5,
    dayIndexForSegment,
    dayIndexForStop,
    getTrainDepartureMinutes,
    inferDateFromTrainId,
    isValidDateString,
    makeUniqueTrainId,
    normalizeDateString,
    normalizeNullableTime,
    normalizeStationName,
    normalizeTrainDate,
    parseFeatureCollectionChunked,
    parseTimeToMinutes,
    trainDayBreaks,
    trainHasCrossDayTimes,
  });
});
