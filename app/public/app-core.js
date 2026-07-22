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
    undatedValue = "undated",
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

  function dateSortKey(date, undatedValue = "undated") {
    return date === undatedValue ? "￿" : date;
  }

  function compareTrainsByDateAndDeparture(
    a,
    b,
    undatedValue = "undated",
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

  function normalizeNullableTime(value) {
    return value === undefined || value === "" ? null : value;
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
    addDaysToDateString,
    compareTrainsByDateAndDeparture,
    dateSortKey,
    dayIndexForSegment,
    dayIndexForStop,
    getTrainDepartureMinutes,
    inferDateFromTrainId,
    isValidDateString,
    makeUniqueTrainId,
    normalizeDateString,
    normalizeNullableTime,
    normalizeTrainDate,
    parseFeatureCollectionChunked,
    parseTimeToMinutes,
    trainDayBreaks,
    trainHasCrossDayTimes,
  });
});
