// =========================================================================
//  app-render.js — §23b: render orchestration & sidebar (renderAll, date bar, train list)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §23.  Render orchestration & sidebar (date bar + train list)
// =========================================================================

// Reflect the auto-focus toggle state on its button.
function updateFocusZoomButton() {
  const btn = els.toggleFocusZoom;
  if (!btn) return;
  btn.textContent = I18N.t("btn.autoFocus") + I18N.t(focusZoomEnabled ? "state.on" : "state.off");
  btn.setAttribute("aria-pressed", focusZoomEnabled ? "true" : "false");
  btn.classList.toggle("active", focusZoomEnabled);
}


function renderAll({ updateJsonTextarea = true } = {}) {
  perfMeasure("renderDateButtons", renderDateButtons);
  perfMeasure("renderTrainList", renderTrainList);
  updateImportTarget();
  perfMeasure("renderEditor", renderEditor);
  perfMeasure("renderTrainLayers", renderTrainLayers);
  scheduleMileageStats();
  // Serializing the whole store to fill the export textarea is O(store size).
  // Callers in hot loops (progressive import) skip it; everyone else gets a
  // debounced refresh so the serialization never blocks the interaction.
  if (updateJsonTextarea) scheduleExportTextareaRefresh();
}

// Human-readable label for a date bucket used in buttons / titles.
function dateLabel(date) {
  if (date === ALL_DATES) return I18N.t("date.all");
  if (date === UNDATED) return I18N.t("date.undated");
  return date;
}

// The date-selector bar: a "全部" button plus one button per available date
// (dynamically generated, no fixed cap), ordered earliest-first. The active
// date is highlighted. Clicking only re-scopes the sidebar list.
function renderDateButtons() {
  if (!els.dateBar) return;
  const dates = getAvailableDates(trainStore.trains);
  els.dateBar.innerHTML = "";
  const fragment = document.createDocumentFragment();

  const makeButton = (date, label, count) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `date-btn${date === selectedDate ? " active" : ""}`;
    btn.dataset.date = date;
    const countHtml =
      count === null ? "" : `<span class="date-count">${count}</span>`;
    btn.innerHTML = `${escapeHtml(label)}${countHtml}`;
    btn.addEventListener("click", () => selectDateBucket(date));
    fragment.appendChild(btn);
  };

  makeButton(ALL_DATES, I18N.t("date.all"), trainStore.trains.length);
  dates.forEach((date) => {
    makeButton(
      date,
      dateLabel(date),
      getTrainsForDate(trainStore.trains, date).length,
    );
  });

  els.dateBar.appendChild(fragment);
  if (els.mapDateFilter) {
    els.mapDateFilter.checked = mapFollowsSelectedDate;
    // The hard-hide toggle only has an effect while a CONCRETE date is
    // selected ("全部" has no "current date" to restrict the map to).
    // Disable it there so it can't look broken.
    els.mapDateFilter.disabled = selectedDate === ALL_DATES;
  }
}

// Switch the sidebar date filter. Does NOT reload the basemap or drop any
// imported train — it only changes which trains the list shows (and, when
// the "map follows date" toggle is on, which trains draw).
function setSelectedDate(date) {
  selectedDate = date;
  persistUiDateState();
  renderDateButtons();
  renderTrainList();
  updateImportTarget();
  // A concrete date now always re-scopes the map (dim other dates), and
  // returning to "全部" restores full opacity — so always redraw.
  renderTrainLayers();
  // The 統計 tab's 當日統計 block follows the active date bucket.
  scheduleMileageStats();
}

// Clicking a date button (including "全部") clears any train selection so the
// date scope takes effect: a concrete date shows that day solid + other dates
// dimmed; "全部" deselects and shows every train at full opacity. With
// auto-focus on, a concrete date also zooms the map to that whole day.
function selectDateBucket(date) {
  selectedTrainId = null;
  focusedTrainId = null;
  setSelectedDate(date);
  renderEditor();
  updateSelectionHighlight();
  scrollActiveDateButtonIntoView();
  if (focusZoomEnabled && date !== ALL_DATES) fitDateBounds(date);
}

// Two-stage train pick shared by the sidebar card and the on-map route line.
// First interaction with a day (selecting a train whose date is not the active
// one — e.g. from "全部" or another date) only switches to that day and
// highlights ALL of its trains. A second click, once that day is active,
// selects the single train. Within the already-active day the first click
// selects directly.
function pickTrain(id) {
  const train = getTrain(id);
  if (!train) return;
  const date = getTrainDate(train);
  if (selectedDate !== date) {
    // Stage 1: enter the day and highlight the whole day (no single selection).
    selectDateBucket(date);
    return;
  }
  // Stage 2: the day is already active — select this single train.
  selectTrain(id, { fit: focusZoomEnabled });
}

// Trains to show in the current sidebar scope, already sorted. "全部" shows
// everything (date ASC, departure ASC, undated last); a concrete date shows
// only that day's trains sorted by departure.
function getVisibleListTrains() {
  const base =
    selectedDate === ALL_DATES
      ? trainStore.trains
      : getTrainsForDate(trainStore.trains, selectedDate);
  return sortTrainsByDateAndDeparture(base);
}

function renderTrainList() {
  const query = els.search.value.trim().toLowerCase();
  const showingAll = selectedDate === ALL_DATES;

  if (els.listTitle) {
    els.listTitle.textContent = showingAll
      ? I18N.t("list.allTitle", { count: trainStore.trains.length })
      : I18N.t("list.dateTitle", { date: dateLabel(selectedDate) });
  }

  const trains = getVisibleListTrains().filter(
    (train) => !query || trainMatchesQuery(train, query),
  );

  els.list.innerHTML = "";

  if (!trains.length) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = showingAll
      ? query
        ? I18N.t("empty.allSearch")
        : I18N.t("empty.allNone")
      : query
        ? I18N.t("empty.dateSearch")
        : I18N.t("empty.dateNone");
    els.list.appendChild(empty);
    return;
  }

  // Build the whole list in a detached fragment so the live DOM only reflows
  // once on insertion instead of once per train.
  const fragment = document.createDocumentFragment();
  trains.forEach((train) =>
    fragment.appendChild(buildTrainListItemElement(train, showingAll)),
  );
  els.list.appendChild(fragment);
}

// Build ONE sidebar card. Shared by the full renderTrainList() and the
// incremental per-train append used during progressive import, so both render
// identically.
// List cards intentionally show only the primary Japanese name. Parenthetical
// English glosses and kana readings remain in the source data/editor/export,
// but are visual noise in this dense overview and made wrapping much worse.
function listPrimaryName(value) {
  const source = String(value || "");
  const isSecondary = /[\p{Script=Latin}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  let result = "";
  let group = "";
  let depth = 0;

  for (const char of source) {
    if (char === "(" || char === "（") {
      if (depth === 0) group = "";
      group += char;
      depth += 1;
    } else if ((char === ")" || char === "）") && depth > 0) {
      group += char;
      depth -= 1;
      if (depth === 0) {
        if (!isSecondary.test(group.slice(1, -1))) result += group;
        group = "";
      }
    } else if (depth > 0) {
      group += char;
    } else {
      result += char;
    }
  }

  // Preserve malformed/unclosed source text instead of silently deleting it.
  if (group) result += group;
  return result
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildTrainListItemElement(train, showingAll) {
  const item = document.createElement("button");
  item.type = "button";
  item.dataset.trainId = train.id;
  item.className = `train-item${train.id === selectedTrainId ? " selected" : ""}${train.id === focusedTrainId ? " focused" : ""}`;
  // In the combined "全部" view each card shows its date badge; per-date views
  // omit it (the whole list is one date already).
  const dateBadge = showingAll
    ? `<span class="train-date-badge">${escapeHtml(dateLabel(getTrainDate(train)))}</span> `
    : "";
  const depMinutes = getTrainDepartureMinutes(train);
  const depText = depMinutes === Infinity ? "—:—" : formatMinutes(depMinutes);
  const primaryNumber = listPrimaryName(train.number || train.id);
  const primaryTypeCompany = listPrimaryName(trainTypeCompanyLabel(train));
  const primaryOrigin = listPrimaryName(train.origin || "?");
  const primaryDestination = listPrimaryName(train.destination || "?");
  const visibility = train.visible === false ? I18N.t("state.hidden") : I18N.t("state.shown");
  item.innerHTML = `
        <span class="swatch" style="background:${escapeAttr(train.style?.color || DEFAULT_TRAIN_COLOR)}"></span>
        <span class="train-item-main">
          <span class="train-title">${dateBadge}${escapeHtml(primaryNumber)} ${escapeHtml(primaryTypeCompany)}</span>
          <span class="train-meta">${escapeHtml(primaryOrigin)} → ${escapeHtml(primaryDestination)} · ${I18N.t("tag.dep")} ${escapeHtml(depText)} · ${train.stops?.length || 0} ${I18N.t("unit.stops")} <span class="train-state">${escapeHtml(visibility)}</span></span>
        </span>
      `;
  item.addEventListener("click", () => pickTrain(train.id));
  return item;
}

// Same date + search predicate renderTrainList() applies, for a single train.
function trainPassesListFilter(train) {
  const query = els.search.value.trim().toLowerCase();
  if (query && !trainMatchesQuery(train, query)) return false;
  if (selectedDate !== ALL_DATES && getTrainDate(train) !== selectedDate)
    return false;
  return true;
}

// Append exactly one card during progressive import (O(1)) instead of
// rebuilding the whole list each iteration (which was O(N^2) over the import).
// The authoritative sorted list is rebuilt once by the final renderAll().
function appendTrainListItemIncremental(train) {
  if (!trainPassesListFilter(train)) return;
  const empty = els.list.querySelector(".list-empty");
  if (empty) empty.remove();
  els.list.appendChild(
    buildTrainListItemElement(train, selectedDate === ALL_DATES),
  );
}

// Lightweight search match. Match only the human-facing fields (id, number,
// direction, endpoints, date, and stop names) rather than JSON.stringify(train)
// on every keystroke. Built lazily and reused.
function trainMatchesQuery(train, query) {
  const parts = [
    train.id,
    train.number,
    train.train_type,
    train.company,
    train.direction,
    train.origin,
    train.destination,
    getTrainDate(train),
  ];
  (train.stops || []).forEach((stop) => {
    if (stop && stop.name) parts.push(stop.name);
  });
  return parts.join(" ").toLowerCase().includes(query);
}

// Toggle the `.selected` / `.focused` classes on the existing list cards
// instead of rebuilding the whole list. Selecting a train used to call
// renderAll() — a full date-bar + list + editor + map rebuild — just to move
// a highlight. This touches only the two affected nodes' classList.
function updateSelectionHighlight() {
  const kids = els.list.children;
  for (let i = 0; i < kids.length; i += 1) {
    const el = kids[i];
    const id = el.dataset && el.dataset.trainId;
    if (!id) continue;
    el.classList.toggle("selected", id === selectedTrainId);
    el.classList.toggle("focused", id === focusedTrainId);
  }
}

// Select + focus a train with the minimum work needed: update the list
// highlight in place, refresh the editor for the new selection, and redraw
// the map ONCE (focus changes route dimming, so the map layer does need a
// pass). Crucially this does NOT rebuild the date bar or the whole list, and
// the export textarea refresh is debounced — so clicking through trains stays
// snappy. Shared by the sidebar list and the on-map route click.
function selectTrain(id, { fit = false } = {}) {
  selectedTrainId = id;
  focusedTrainId = id;
  // Jump the sidebar to this train's own date so the correct date button is
  // active and the correct card is shown/highlighted (e.g. clicking a route on
  // the map while a different date — or "全部" — is selected).
  const train = getTrain(id);
  const trainDate = train ? getTrainDate(train) : null;
  if (trainDate && trainDate !== selectedDate) {
    selectedDate = trainDate;
    persistUiDateState();
    renderDateButtons();
    renderTrainList();
    updateImportTarget();
  }
  updateSelectionHighlight();
  scrollActiveDateButtonIntoView();
  scrollSelectedCardIntoView();
  perfMeasure("renderEditor", renderEditor);
  perfMeasure("renderTrainLayers", renderTrainLayers);
  scheduleExportTextareaRefresh();
  if (fit && train) fitTrainBounds(train);
}

// Bring the highlighted sidebar card into view after a map-driven selection.
function scrollSelectedCardIntoView() {
  if (!els.list || !selectedTrainId) return;
  const card = els.list.querySelector(`[data-train-id="${selectedTrainId}"]`);
  if (card && typeof card.scrollIntoView === "function") {
    card.scrollIntoView({ block: "nearest" });
  }
}

// Scroll the (horizontally scrolling) date bar so the active date button is
// visible — used whenever a pick auto-jumps the selected date.
function scrollActiveDateButtonIntoView() {
  if (!els.dateBar) return;
  const active = els.dateBar.querySelector(".date-btn.active");
  if (active && typeof active.scrollIntoView === "function") {
    active.scrollIntoView({ block: "nearest", inline: "center" });
  }
}

// Auto-focus the map on every train of a given date (its whole-day view).
function fitDateBounds(date) {
  if (!map) return;
  const dayTrains = getTrainsForDate(trainStore.trains, date).filter(
    (t) => t.visible !== false,
  );
  const features = [];
  dayTrains.forEach((train) => {
    getMatchedRouteFeatures(train).forEach((feature) => features.push(feature));
  });
  const bounds = featureCollectionBounds(features);
  if (bounds) {
    smoothFitBounds(bounds, { maxZoom: 11 });
    return;
  }
  const points = [];
  dayTrains.forEach((train) =>
    (train.stops || []).forEach((stop) => {
      const ll = resolveStationForTrain(stop, train);
      if (ll) points.push(toLatLng(ll));
    }),
  );
  const ptBounds = latLngPointsBounds(points);
  if (ptBounds) smoothFitBounds(ptBounds, { maxZoom: 11 });
}

// Render minutes-from-midnight back to "HH:mm" (wrapping next-day times).
function formatMinutes(total) {
  const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = String(Math.floor(wrapped / 60)).padStart(2, "0");
  const mm = String(wrapped % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Show where an imported JSON will land, so the user knows before importing.
function updateImportTarget() {
  if (!els.importTarget) return;
  if (selectedDate && selectedDate !== ALL_DATES) {
    els.importTarget.innerHTML = I18N.t("import.targetDate", {
      date: escapeHtml(dateLabel(selectedDate)),
    });
  } else {
    els.importTarget.innerHTML = I18N.t("import.targetAuto");
  }
}

// Add a manual (possibly empty) date bucket, then jump to it.
async function addManualDate() {
  const input = await uiPrompt(I18N.t("prompt.addDate"), "");
  if (input === null) return;
  const normalized = normalizeDateString(input);
  if (!normalized) {
    setStatus(
      els.importStatus,
      I18N.t("status.invalidDate", { input }),
      "err",
    );
    return;
  }
  if (!manualDates.includes(normalized)) manualDates.push(normalized);
  setSelectedDate(normalized);
  setStatus(
    els.importStatus,
    I18N.t("status.dateAdded", { date: normalized }),
    "ok",
  );
}

// Drop manually-created date buttons that hold no trains. Dates still backed
// by at least one train are derived from the trains and cannot be removed
// here (delete the trains instead).
function removeEmptyDates() {
  const used = new Set(trainStore.trains.map(getTrainDate));
  const before = manualDates.length;
  manualDates = manualDates.filter((date) => used.has(date));
  reconcileSelectedDate();
  persistUiDateState();
  renderAll();
  const removed = before - manualDates.length;
  setStatus(
    els.importStatus,
    removed ? I18N.t("status.emptyDatesRemoved", { count: removed }) : I18N.t("status.noEmptyDates"),
    removed ? "ok" : "warn",
  );
}

