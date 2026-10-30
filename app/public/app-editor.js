// =========================================================================
//  app-editor.js — §24: editor panel & stops table (per-train field + stop editing)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §24.  Editor panel & stops table (per-train field + stop editing)
// =========================================================================

function renderEditor() {
  const train = getTrain();
  const disabled = !train;
  [
    els.id,
    els.number,
    els.trainType,
    els.company,
    els.direction,
    els.origin,
    els.destination,
    els.color,
  ].forEach((el) => (el.disabled = disabled));
  document.getElementById("duplicate-train").disabled = disabled;
  document.getElementById("delete-train").disabled = disabled;
  document.getElementById("delete-all-trains").disabled =
    !trainStore.trains.length;
  document.getElementById("fit-selected").disabled = disabled;
  document.getElementById("clear-selection").disabled =
    !selectedTrainId && !focusedTrainId;
  document.getElementById("toggle-visible").disabled = disabled;
  if (!train) {
    els.id.value =
      els.number.value =
      els.trainType.value =
      els.company.value =
      els.direction.value =
      els.origin.value =
      els.destination.value =
        "";
    els.color.value = DEFAULT_TRAIN_COLOR;
    els.stopsBody.innerHTML = "";
    return;
  }
  els.id.value = train.id || "";
  els.number.value = train.number || "";
  els.trainType.value = train.train_type || "";
  els.company.value = train.company || "";
  els.direction.value = train.direction || "";
  els.origin.value = train.origin || "";
  els.destination.value = train.destination || "";
  els.color.value = normalizeColor(train.style?.color || DEFAULT_TRAIN_COLOR);
  renderStopsTable(train);
}

// Colour palette for branch (支線) groups in the stops table. Each maximal run
// of consecutive route_sections that share the same line_names (+ branch number)
// becomes one branch and gets the next colour.
const BRANCH_COLORS = [
  "#2563eb",
  "#16a34a",
  "#db2777",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#dc2626",
  "#4d7c0f",
];

// Derive branches from the train's per-adjacent-stop route_sections. A branch
// spans stops [startIdx..endIdx] (inclusive); adjacent branches SHARE the
// boundary stop, which is the divergence station (支线分理处). Trains with no
// line_names collapse to a single unlabeled branch (ordinary single-line view).
function deriveTrainBranches(train) {
  const stops = train.stops || [];
  if (stops.length < 2)
    return [
      {
        line: "",
        number: "",
        startIdx: 0,
        endIdx: Math.max(0, stops.length - 1),
        colorIndex: 0,
      },
    ];
  const sections = getRideRouteSectionsForTrain(train);
  if (!sections.length)
    return [
      { line: "", number: "", startIdx: 0, endIdx: stops.length - 1, colorIndex: 0 },
    ];
  const keyOf = (s) =>
    `${(s.line_names || []).map(String).slice().sort().join(",")}|${s.number || ""}`;
  const branches = [];
  let cur = null;
  sections.forEach((sec, i) => {
    const k = keyOf(sec);
    if (!cur || cur.key !== k) {
      cur = {
        key: k,
        line: (sec.line_names || [])[0] || "",
        number: sec.number || "",
        startIdx: i,
        endIdx: i + 1,
        colorIndex: branches.length,
      };
      branches.push(cur);
    } else {
      cur.endIdx = i + 1;
    }
  });
  return branches;
}

function renderStopsTable(train) {
  els.stopsBody.innerHTML = "";
  const stops = train.stops || [];
  const branches = deriveTrainBranches(train);
  const showHeaders =
    branches.length > 1 ||
    (branches[0] && (branches[0].line || branches[0].number));

  // Owning branch of each stop = first branch that contains it (so a shared
  // junction is owned by the earlier branch and only toggled/edited once).
  const ownerOf = new Array(stops.length).fill(0);
  const ownedSeen = new Set();
  branches.forEach((b, bi) => {
    for (let i = b.startIdx; i <= b.endIdx; i += 1) {
      if (!ownedSeen.has(i)) {
        ownerOf[i] = bi;
        ownedSeen.add(i);
      }
    }
  });

  // data-label carries the (localized) column header into each cell: the
  // mobile card layout hides <thead> and renders these as per-field captions.
  const editableRow = (stop, index, color) => {
    const tr = document.createElement("tr");
    tr.style.borderLeft = `4px solid ${color}`;
    tr.innerHTML = `
          <td>${index + 1}</td>
          <td><input data-stop-field="name" data-stop-index="${index}" value="${escapeAttr(stopName(stop))}"></td>
          <td data-label="${escapeAttr(I18N.t("th.platform"))}"><input type="number" min="0" step="1" inputmode="numeric" data-stop-field="platform_number" data-stop-index="${index}" value="${escapeAttr(stop.platform_number ?? "")}"></td>
          <td data-label="${escapeAttr(I18N.t("th.arr"))}"><input data-stop-field="arrival" data-stop-index="${index}" value="${escapeAttr(stop.arrival ?? "")}"></td>
          <td data-label="${escapeAttr(I18N.t("th.dep"))}"><input data-stop-field="departure" data-stop-index="${index}" value="${escapeAttr(stop.departure ?? "")}"></td>
          <td data-label="${escapeAttr(I18N.t("th.type"))}">
            <select data-stop-field="stop_type" data-stop-index="${index}">
              ${STOP_TYPES.map((type) => `<option value="${type}" ${stop.stop_type === type ? "selected" : ""}>${I18N.t("stoptype." + type)}</option>`).join("")}
            </select>
          </td>
          <td data-label="${escapeAttr(I18N.t("th.ride"))}">
            <input
              type="checkbox"
              data-stop-field="ride_segment"
              data-stop-index="${index}"
              ${(isPassThroughStop(stop) ? effectiveStopRide(train.stops, index) : stop.ride_segment) ? "checked" : ""}
              ${isPassThroughStop(stop) ? "disabled" : ""}
              title="${escapeAttr(isPassThroughStop(stop) ? I18N.t("tip.passRideFollows") : I18N.t("tip.rideSegment"))}"
            >
          </td>
          <td class="stop-actions">
            <button class="icon" title="${escapeAttr(I18N.t("btn.moveUp"))}" aria-label="${escapeAttr(I18N.t("btn.moveUp"))}" data-stop-action="up" data-stop-index="${index}">↑</button>
            <button class="icon" title="${escapeAttr(I18N.t("btn.moveDown"))}" aria-label="${escapeAttr(I18N.t("btn.moveDown"))}" data-stop-action="down" data-stop-index="${index}">↓</button>
            <button class="icon danger" title="${escapeAttr(I18N.t("btn.delete"))}" aria-label="${escapeAttr(I18N.t("btn.delete"))}" data-stop-action="delete" data-stop-index="${index}">×</button>
          </td>
        `;
    return tr;
  };

  const editableSeen = new Set();
  branches.forEach((b, bi) => {
    const color = BRANCH_COLORS[b.colorIndex % BRANCH_COLORS.length];
    if (showHeaders) {
      const label =
        (b.line || I18N.t("branch.noline")) + (b.number ? ` · ${b.number}` : "");
      const htr = document.createElement("tr");
      htr.className = "branch-header";
      htr.innerHTML = `<td colspan="8" style="border-left:4px solid ${color}">
            <span class="branch-swatch" style="background:${color}"></span>
            <strong>${escapeHtml(label)}</strong>
            ${b.number ? `<span class="branch-tag">${escapeHtml(I18N.t("branch.tag"))}</span>` : ""}
            <label class="branch-ride"><input type="checkbox" data-branch-ride="${bi}"> ${escapeHtml(I18N.t("branch.rideAll"))}</label>
          </td>`;
      els.stopsBody.appendChild(htr);
    }
    for (let i = b.startIdx; i <= b.endIdx; i += 1) {
      const stop = stops[i];
      if (!stop) continue;
      if (editableSeen.has(i)) {
        // Already rendered editable in the previous branch — show the shared
        // divergence station as a read-only anchor so each branch starts at it.
        const tr = document.createElement("tr");
        tr.className = "branch-junction";
        tr.style.borderLeft = `4px solid ${color}`;
        tr.innerHTML = `
              <td>${i + 1}</td>
              <td>${escapeHtml(stopName(stop))} <span class="branch-tag">${escapeHtml(I18N.t("branch.junction"))}</span></td>
              <td data-label="${escapeAttr(I18N.t("th.platform"))}">${stop.platform_number == null ? "" : escapeHtml(String(stop.platform_number))}</td>
              <td data-label="${escapeAttr(I18N.t("th.arr"))}">${escapeHtml(stop.arrival ?? "")}</td>
              <td data-label="${escapeAttr(I18N.t("th.dep"))}">${escapeHtml(stop.departure ?? "")}</td>
              <td data-label="${escapeAttr(I18N.t("th.type"))}">${escapeHtml(I18N.t("stoptype." + stop.stop_type))}</td>
              <td></td><td></td>`;
        els.stopsBody.appendChild(tr);
        continue;
      }
      editableSeen.add(i);
      els.stopsBody.appendChild(editableRow(stop, i, showHeaders ? color : ""));
    }
  });

  // Branch master toggle: ride/hide every owned stopping station in one click.
  branches.forEach((b, bi) => {
    const cb = els.stopsBody.querySelector(`[data-branch-ride="${bi}"]`);
    if (!cb) return;
    const owned = [];
    for (let i = b.startIdx; i <= b.endIdx; i += 1) {
      if (ownerOf[i] === bi && isStoppingStation(stops[i])) owned.push(stops[i]);
    }
    const on = owned.filter((s) => s.ride_segment === true).length;
    cb.checked = owned.length > 0 && on === owned.length;
    cb.indeterminate = on > 0 && on < owned.length;
    cb.addEventListener("change", (event) => {
      const t = getTrain();
      if (!t) return;
      // Same guard as every other mutating handler; the redraw snaps the
      // already-flipped checkbox back to the stored state.
      if (importBusy()) {
        renderStopsTable(t);
        return;
      }
      const value = event.target.checked;
      for (let i = b.startIdx; i <= b.endIdx; i += 1) {
        if (ownerOf[i] === bi && isStoppingStation(t.stops[i])) {
          t.stops[i].ride_segment = value;
          setAdjacentPassThroughStops(t, i, value);
        }
      }
      saveTrainStore();
      perfMeasure("renderTrainLayers", renderTrainLayers);
      scheduleExportTextareaRefresh();
      renderStopsTable(t);
    });
  });

  els.stopsBody.querySelectorAll("[data-stop-field]").forEach((input) => {

    input.addEventListener("change", (event) => {
      const train = getTrain();
      const index = Number(event.target.dataset.stopIndex);
      const field = event.target.dataset.stopField;
      if (!train?.stops?.[index]) return;
      // Same guard as every other mutating handler; the redraw snaps the
      // edited control back to the stored state.
      if (importBusy()) {
        renderStopsTable(train);
        return;
      }

      let refreshStopsTable = false;
      // Snapshot for revert: field-level stop edits used to bypass validation
      // entirely, so blanking a station name (or breaking the first/last-stop
      // time shape) persisted a store that validateTrainStore rejects on the
      // next boot — dropping the user into read-only recovery mode.
      const previousStops =
        field === "ride_segment" ? null : clone(train.stops);

      if (field === "ride_segment") {
        // Pass-through stations are not individually toggleable; their visibility
        // is derived from the bounding stops. Ignore any stray event and redraw.
        if (isPassThroughStop(train.stops[index])) {
          renderStopsTable(train);
          return;
        }
        const enabled = event.target.checked;
        train.stops[index][field] = enabled;

        // Pass-through stops remain directly toggleable. When a real
        // stopping station is toggled, mirror that value to all
        // pass-through stops between it and the neighbouring stopping
        // stations on both sides. This keeps a disabled station from
        // leaving bright orphan through markers, and also restores the
        // same intermediate through-stops when the station is re-enabled.
        if (isStoppingStation(train.stops[index])) {
          refreshStopsTable = setAdjacentPassThroughStops(
            train,
            index,
            enabled,
          );
        }
      } else {
        train.stops[index][field] = normalizeStopValue(
          field,
          event.target.value,
        );
        refreshStopsTable = field === "stop_type";
      }

      if (field === "name") applyStationMetadata(train.stops[index], train);

      if (previousStops) {
        const error = stopEditValidationError(train);
        if (error) {
          train.stops = previousStops;
          setStatus(els.fieldStatus, error.message, "err");
          renderStopsTable(train);
          return;
        }
      }

      saveTrainStore();
      perfMeasure("renderTrainLayers", renderTrainLayers);
      scheduleExportTextareaRefresh();
      if (refreshStopsTable) renderStopsTable(train);
    });
  });

  els.stopsBody.querySelectorAll("[data-stop-action]").forEach((button) => {
    button.addEventListener("click", () =>
      mutateStop(Number(button.dataset.stopIndex), button.dataset.stopAction),
    );
  });
}

function saveSelectedFields() {
  if (importBusy()) return;
  const train = getTrain();
  if (!train) return;
  const oldId = train.id;
  const next = {
    ...train,
    id: els.id.value.trim(),
    number: els.number.value.trim(),
    train_type: els.trainType.value.trim(),
    company:
      activeCountry === "tw"
        ? RailOperatorBranding.normalizeTaiwanCompanyName(els.company.value)
        : els.company.value.trim(),
    direction: els.direction.value.trim(),
    origin: els.origin.value.trim(),
    destination: els.destination.value.trim(),
    style: {
      color: els.color.value,
    },
  };
  try {
    const temp = clone(trainStore);
    temp.trains = temp.trains.map((t) => (t.id === oldId ? next : t));
    validateTrainStore(temp);
    AppActions.replaceTrainStore(temp);
    selectedTrainId = next.id;
    applyMutationResult(MutationResults.trainDetailsChanged);
    setStatus(els.fieldStatus, I18N.t("status.fieldsSaved"), "ok");
  } catch (error) {
    setStatus(els.fieldStatus, error.message, "err");
  }
}

function addStopToSelected() {
  if (importBusy()) return;
  const train = getTrain();
  if (!train) return;
  train.stops = train.stops || [];
  const stop = {
    name: train.destination || "",
    n02_station_code: null,
    platform_number: null,
    arrival: null,
    departure: null,
    stop_type: "passenger_stop",
    ride_segment: true,
  };
  applyStationMetadata(stop, train);
  train.stops.push(stop);
  applyMutationResult(MutationResults.routeChanged);
}

function normalizeStopValue(field, value) {
  // Time fields follow AppCore's blank-time rule (whitespace-only → null), the
  // same normalization imported JSON goes through — see normalizeNullableTime.
  if (field === "arrival" || field === "departure")
    return normalizeNullableTime(value);
  if (field === "platform_number") {
    const normalized = String(value).trim();
    return normalized === "" ? null : Number(normalized);
  }
  return value;
}

function isPassThroughStop(stop) {
  return stop?.stop_type === "pass_through";
}

function isStoppingStation(stop) {
  return Boolean(stop) && !isPassThroughStop(stop);
}

function findPreviousStoppingStationIndex(stops, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (isStoppingStation(stops[cursor])) return cursor;
  }
  return -1;
}

function findNextStoppingStationIndex(stops, index) {
  for (let cursor = index + 1; cursor < stops.length; cursor += 1) {
    if (isStoppingStation(stops[cursor])) return cursor;
  }
  return -1;
}

function setPassThroughStopsBetween(stops, startIndex, endIndex, enabled) {
  if (startIndex < 0 || endIndex < 0 || startIndex >= endIndex) return false;
  let changed = false;
  for (let cursor = startIndex + 1; cursor < endIndex; cursor += 1) {
    const stop = stops[cursor];
    if (!isPassThroughStop(stop)) continue;
    if (stop.ride_segment !== enabled) {
      stop.ride_segment = enabled;
      changed = true;
    }
  }
  return changed;
}

function setAdjacentPassThroughStops(train, stopIndex, enabled) {
  const stops = train?.stops || [];
  const previousStopIndex = findPreviousStoppingStationIndex(stops, stopIndex);
  const nextStopIndex = findNextStoppingStationIndex(stops, stopIndex);
  const changedBefore = setPassThroughStopsBetween(
    stops,
    previousStopIndex,
    stopIndex,
    enabled,
  );
  const changedAfter = setPassThroughStopsBetween(
    stops,
    stopIndex,
    nextStopIndex,
    enabled,
  );
  return changedBefore || changedAfter;
}

// Effective "ridden" (shown) state of a stop for display & hiding.
//   - A real stopping station uses its own ride_segment flag (user-toggleable).
//   - A pass-through (非停車站) is NOT individually toggleable: it inherits the
//     ride state of the stop-to-stop interval it lies in, i.e. it is shown only
//     when BOTH bounding stopping stations are ridden. So hiding the interval
//     between two stops automatically hides every pass-through inside it.
// "Hidden" everywhere means truly not drawn (see routeSegmentStyleValues /
// the marker loops), not merely a lower opacity.
function effectiveStopRide(stops, index) {
  const stop = stops && stops[index];
  if (!stop) return false;
  if (isStoppingStation(stop)) return stop.ride_segment === true;
  const prev = findPreviousStoppingStationIndex(stops, index);
  const next = findNextStoppingStationIndex(stops, index);
  if (prev < 0 || next < 0) return stop.ride_segment === true;
  return (
    stops[prev].ride_segment === true && stops[next].ride_segment === true
  );
}

// Ordered indexes of a train's effectively-ridden STOPPING stations (pass-
// throughs excluded). First/last entry = the ride boundary pair — the same
// rule drives the stats ride-time span and the terminal-dot markers, so it
// lives once, next to effectiveStopRide.
function effectivelyRiddenStopIndexes(stops) {
  const ridden = [];
  (stops || []).forEach((stop, idx) => {
    if (!stop || stop.stop_type === "pass_through") return;
    if (!effectiveStopRide(stops, idx)) return;
    ridden.push(idx);
  });
  return ridden;
}

function applyStationMetadata(stop, train) {
  const station = resolveStationForTrain(stop, train);
  if (!station) return;
  stop.name = stationName(station);
  stop.n02_station_code = stationCode(station);
  stop.n02_group_code = stationGroupCode(station);
}

// Validate one train after a stop-level edit, mirroring what the boot path
// will enforce (validateTrainStore on load). Returns null when the edit is
// safe to persist, otherwise the validation error so the caller can revert —
// without this, deleting below 2 stops or blanking a name saved a store the
// app itself refused to load on the next boot (read-only recovery mode).
function stopEditValidationError(train) {
  try {
    validateTrain(normalizeExportTrain(train), 0, new Set());
    return null;
  } catch (error) {
    return error;
  }
}

function mutateStop(index, action) {
  if (importBusy()) return;
  const train = getTrain();
  if (!train || !train.stops?.[index]) return;
  const previousStops = clone(train.stops);
  if (action === "delete") train.stops.splice(index, 1);
  if (action === "up" && index > 0)
    [train.stops[index - 1], train.stops[index]] = [
      train.stops[index],
      train.stops[index - 1],
    ];
  if (action === "down" && index < train.stops.length - 1)
    [train.stops[index + 1], train.stops[index]] = [
      train.stops[index],
      train.stops[index + 1],
    ];
  const error = stopEditValidationError(train);
  if (error) {
    train.stops = previousStops;
    setStatus(els.fieldStatus, error.message, "err");
    renderStopsTable(train);
    return;
  }
  applyMutationResult(MutationResults.routeChanged);
}
