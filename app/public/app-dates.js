// =========================================================================
//  app-dates.js — §6: date grouping, sorting & UI date-state persistence
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §6.  Date grouping, sorting & UI date-state persistence
// =========================================================================

// ------------------------------------------------------------------------
// Date grouping helpers. A train belongs to exactly one date bucket via its
// `date` field ("YYYY-MM-DD" or UNDATED). Every per-date / all-trains view is
// derived from the single `trainStore.trains` array, never stored separately,
// so the daily lists and the combined list can never drift out of sync.
// ------------------------------------------------------------------------
// The date bucket a train currently lives in (defensive re-normalize).
function getTrainDate(train) {
  return normalizeTrainDate(train);
}

function sortTrainsByDateAndDeparture(trains) {
  return [...trains].sort(compareTrainsByDateAndDeparture);
}

// All date buckets currently in use, plus any manually-created empty dates,
// ordered earliest-first with UNDATED forced to the end.
function getAvailableDates(trains) {
  const set = new Set();
  (trains || []).forEach((train) => set.add(getTrainDate(train)));
  manualDates.forEach((date) => {
    const normalized = date === UNDATED ? UNDATED : normalizeDateString(date);
    if (normalized) set.add(normalized);
  });
  return [...set].sort((a, b) => {
    const ka = dateSortKey(a);
    const kb = dateSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function getTrainsForDate(trains, date) {
  return (trains || []).filter((train) => getTrainDate(train) === date);
}

// ---- cross-day (overnight) itineraries ----------------------------------
// A train whose stop times run past midnight (25:10 = 01:10 the next day, see
// jsonspec §10.5) physically covers more than one calendar date while still
// living in ONE date bucket — its own `date`. Everything the map needs is
// derived here:
//   breaks — where the itinerary rolls into the next day (see trainDayBreaks)
//   dates  — the calendar dates it touches, day 0 first
//   key    — "|d0|d1|" span string; the GPU layers filter and dim on it, so a
//            cross-day train stays in scope on BOTH of its days.
//   sig    — key + break positions, for the record-cache signature (moving the
//            break re-splits the drawn segments even when the dates hold).
// Single-day trains (all of them, unless an overnight run is logged) share one
// cached object per date, so the hot render path allocates nothing.
const _singleDaySpanCache = new Map();
function getTrainDaySpan(train) {
  const date = getTrainDate(train);
  if (date !== UNDATED && trainHasCrossDayTimes(train)) {
    const breaks = trainDayBreaks(train);
    if (breaks.length) {
      const dates = [date];
      for (let day = 1; day <= breaks[breaks.length - 1].day; day += 1)
        dates.push(addDaysToDateString(date, day) || date);
      const key = `|${dates.join("|")}|`;
      const sig = `${key}${breaks.map((b) => `${b.index}>${b.day}`).join(",")}`;
      return { date, breaks, dates, key, sig };
    }
  }
  let span = _singleDaySpanCache.get(date);
  if (!span) {
    const key = `|${date}|`;
    span = { date, breaks: [], dates: [date], key, sig: key };
    _singleDaySpanCache.set(date, span);
  }
  return span;
}

// Does this train run on `date` at all — its own bucket, or a day it crosses
// into? Drives which trains a selected day keeps solid / interactive.
function trainSpansDate(train, date) {
  if (!date || date === ALL_DATES) return true;
  const span = getTrainDaySpan(train);
  return span.dates.indexOf(date) !== -1;
}

// The date a single route segment actually runs on (its far end's day).
function segmentDateForTrain(span, segmentIndex) {
  if (span.dates.length < 2) return span.date;
  return span.dates[dayIndexForSegment(span.breaks, segmentIndex)] || span.date;
}

// ---- selectedDate / manualDates persistence (pure UI state) -------------
// Kept in localStorage (not the train store) so the canonical store schema
// stays exactly { schema_version, trains:[...] } as required.
// The date filter is DATA-side state, so it is COUNTRY-SCOPED like the stores
// themselves (Japan keeps the historical unsuffixed key): Taiwan's manual
// dates and selected day never leak into Japan's date bar and vice versa.
const UI_STATE_STORAGE_KEY = "n02-train-manager-ui-state";
function uiDateStateStorageKey() {
  return typeof activeCountry !== "undefined" && activeCountry !== "jp"
    ? `${UI_STATE_STORAGE_KEY}-${activeCountry}`
    : UI_STATE_STORAGE_KEY;
}

function persistUiDateState() {
  try {
    localStorage.setItem(
      uiDateStateStorageKey(),
      JSON.stringify({
        selectedDate,
        manualDates,
        mapFollowsSelectedDate,
        focusZoomEnabled,
      }),
    );
  } catch {
    // Non-fatal: private-mode / disabled storage just means no restore.
  }
}

// Returns true when a previously-saved selectedDate was restored (a first run
// with no saved filter simply keeps the "全部" default).
function restoreUiDateState() {
  try {
    const raw = localStorage.getItem(uiDateStateStorageKey());
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.manualDates)) {
        manualDates = parsed.manualDates
          .map((d) => (d === UNDATED ? UNDATED : normalizeDateString(d)))
          .filter(Boolean);
      }
      if (typeof parsed.mapFollowsSelectedDate === "boolean")
        mapFollowsSelectedDate = parsed.mapFollowsSelectedDate;
      if (typeof parsed.focusZoomEnabled === "boolean")
        focusZoomEnabled = parsed.focusZoomEnabled;
      if (typeof parsed.selectedDate === "string") {
        selectedDate = parsed.selectedDate;
        return true;
      }
    }
  } catch {
    // Ignore malformed saved UI state.
  }
  return false;
}

// A country switch swaps the date-filter DATA: drop the old country's
// selection, then restore the NEW country's persisted selectedDate /
// manualDates (defaults when it has none). The two behavior toggles
// (地圖僅顯示當前日期 / auto-focus) are DISPLAY settings and keep their
// on-screen values — restoreUiDateState may have read the other country's
// persisted copies, so they are re-asserted afterwards.
function applyUiDateStateForCountrySwitch() {
  const keepFollow = mapFollowsSelectedDate;
  const keepFocus = focusZoomEnabled;
  selectedDate = ALL_DATES;
  manualDates = [];
  restoreUiDateState();
  mapFollowsSelectedDate = keepFollow;
  focusZoomEnabled = keepFocus;
}

// Ensure selectedDate still points at something renderable after the train
// set changes (import / delete / boot). Never force-switches to the *last*
// date: keeps a still-valid selection, otherwise falls back to earliest.
// "全部" is always renderable, so it is never narrowed to a single day here —
// a load that ends on the combined view stays on the combined view.
function reconcileSelectedDate() {
  const dates = getAvailableDates(trainStore.trains);
  if (selectedDate === ALL_DATES) return;
  if (!dates.includes(selectedDate)) {
    selectedDate = dates.length ? dates[0] : ALL_DATES;
  }
}

// Human-readable label for a date bucket used in buttons / titles. It lived in
// app-render.js, which meant app-ui-utils.js depended on the renderer to spell
// a date — the whole of that dependency cycle. A date label belongs with the
// date module.
function dateLabel(date) {
  if (date === ALL_DATES) return I18N.t("date.all");
  if (date === UNDATED) return I18N.t("date.undated");
  return date;
}
