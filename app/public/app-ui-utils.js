// =========================================================================
//  app-ui-utils.js — §34–35: popups & tooltips (stop / route-segment HTML) + misc utilities (status line, color, portable HTML, download)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §34.  Popups & tooltips (stop / route-segment HTML)
// =========================================================================

// Railprint-style hover popup for a ridden-route station marker: the SAME data
// source (the RailNetwork package) and processing (RailMapPopup.buildPopupModel
// groups every line through the station's group, deduped, with logos/colours)
// as the national-network station hover popup — plus this train's own stop
// times under the name. Returns null when the network package isn't loaded yet
// or the station isn't in it, so the caller can lazily load it and fall back.
function buildStationLinesPopup(pr, train) {
  const net = typeof RailMap !== "undefined" ? RailMap._network : null;
  if (!net || typeof RailMapPopup === "undefined") return null;
  const group = pr.n02_group_code || pr.N02_005g;
  const members = group ? net.groupMembers.get(String(group)) : null;
  if (!members || !members.length) return null;
  const model = RailMapPopup.buildPopupModel(net, members[0].stationId);
  if (!model || !model.lines.length) return null;
  const times = [];
  if (pr.arrival) times.push(`${I18N.t("tag.arr")} ${escapeHtml(pr.arrival)}`);
  if (pr.departure)
    times.push(`${I18N.t("tag.dep")} ${escapeHtml(pr.departure)}`);
  if (times.length && train) {
    const d = dateLabel(getTrainDate(train));
    if (d) times.push(`<span class="rp-popup-date">${escapeHtml(d)}</span>`);
  }
  const subhead = times.length
    ? `<div class="rp-popup-times">${times.join("　")}</div>`
    : "";
  return RailMapPopup.stationPopupHtml(model, { subhead });
}

function buildStopPopup(stopFeature, train) {
  const p = stopFeature.properties || {};
  const stopTypeLabel = STOP_TYPES.includes(p.stop_type)
    ? I18N.t(`stoptype.${p.stop_type}`)
    : p.stop_type;
  return popupHtml(`${train.number || ""}`, [
    [I18N.t("popup.trainId"), train.id],
    [I18N.t("popup.typeCompany"), trainTypeCompanyLabel(train) || "-"],
    [I18N.t("popup.station"), p.name],
    [I18N.t("popup.arrival"), p.arrival || "-"],
    [I18N.t("popup.departure"), p.departure || "-"],
    [I18N.t("popup.stopType"), stopTypeLabel],
    [
      I18N.t("popup.rideSegment"),
      p.ride_segment === true ? I18N.t("popup.yes") : I18N.t("popup.noPale"),
    ],
    // N02_005c / N02_005g are N02 field codes — kept literal on purpose.
    ["N02_005c", p.n02_station_code || "-"],
    ["N02_005g", p.n02_group_code || "-"],
    [I18N.t("popup.line"), p.line_name || "-"],
    [I18N.t("popup.operator"), p.operator || "-"],
    [
      I18N.t("popup.computed"),
      p.pass_through_computed ? I18N.t("popup.yes") : I18N.t("popup.no"),
    ],
    [I18N.t("popup.routeSource"), p.source || "station overlay"],
  ]);
}

function routeSectionForSegment(train, p) {
  const sections = Array.isArray(train.route_sections)
    ? train.route_sections
    : [];
  const idx = Number(p.segment_index);
  if (Number.isInteger(idx) && sections[idx]) return sections[idx];
  return sections.find((s) => s.from === p.from && s.to === p.to) || null;
}

// The segment number shown for a hovered/clicked route piece: a 併結 / 直通
// section may run under its own 車號 (jsonspec §6.1b), otherwise the train's.
function segmentNumberLabel(train, properties) {
  const section = routeSectionForSegment(train, properties || {});
  const number = (section && section.number) || train.number || "";
  const name = (section && section.name) || "";
  const isBranch = Boolean(
    section && section.number && section.number !== train.number,
  );
  return { number, name, isBranch };
}

function popupHtml(title, rows) {
  return `<div class="popup-title">${escapeHtml(title)}</div><div class="popup-grid">${rows
    .map(
      ([key, value]) =>
        `<span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong>`,
    )
    .join("")}</div>`;
}

// =========================================================================
//  §35.  Misc utilities (status line, color, portable HTML, download, HTML escaping)
// =========================================================================

function setStatus(el, message, type) {
  el.textContent = message;
  el.className = `status ${type || ""}`;
}

function normalizeColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(value || "") ? value : DEFAULT_TRAIN_COLOR;
}

function buildPortableHtml() {
  // Snapshot of the live DOM. (The old embedded-data branch targeted a
  // #data-default-trains node that no longer exists in index.html; the
  // snapshot still references relative vendor/app.js//api URLs, so it is a
  // same-folder snapshot rather than a truly standalone file.)
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
// (end of app-ui-utils.js — the last script of the app-*.js family)
