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

// ---- selectedDate / manualDates persistence (pure UI state) -------------
// Kept in localStorage (not the train store) so the canonical store schema
// stays exactly { schema_version, trains:[...] } as required.
const UI_STATE_STORAGE_KEY = "n02-train-manager-ui-state";

function persistUiDateState() {
  try {
    localStorage.setItem(
      UI_STATE_STORAGE_KEY,
      JSON.stringify({
        selectedDate,
        manualDates,
        mapFollowsSelectedDate,
        focusZoomEnabled,
      }),
    );
  } catch (err) {
    // Non-fatal: private-mode / disabled storage just means no restore.
  }
}

// Returns true when a previously-saved selectedDate was restored, so the
// boot path knows whether to apply the "earliest date" first-run default.
function restoreUiDateState() {
  try {
    const raw = localStorage.getItem(UI_STATE_STORAGE_KEY);
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
  } catch (err) {
    // Ignore malformed saved UI state.
  }
  return false;
}

// Ensure selectedDate still points at something renderable after the train
// set changes (import / delete / boot). Never force-switches to the *last*
// date: keeps a still-valid selection, otherwise falls back to earliest.
function reconcileSelectedDate({ preferEarliestWhenAll = false } = {}) {
  const dates = getAvailableDates(trainStore.trains);
  if (selectedDate === ALL_DATES) {
    if (preferEarliestWhenAll && dates.length) selectedDate = dates[0];
    return;
  }
  if (!dates.includes(selectedDate)) {
    selectedDate = dates.length ? dates[0] : ALL_DATES;
  }
}

