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

function buildStopPopup(stopFeature, train) {
  const p = stopFeature.properties || {};
  return popupHtml(`${train.number || ""}`, [
    ["Train ID", train.id],
    ["Type / Company", trainTypeCompanyLabel(train) || "-"],
    ["Station", p.name],
    ["Arrival", p.arrival || "-"],
    ["Departure", p.departure || "-"],
    ["stop_type", p.stop_type],
    ["Normal color", p.ride_segment === true ? "Yes" : "No / pale"],
    ["N02_005c", p.n02_station_code || "-"],
    ["N02_005g", p.n02_group_code || "-"],
    ["Line", p.line_name || "-"],
    ["Operator", p.operator || "-"],
    ["Computed", p.pass_through_computed ? "Yes" : "No"],
    ["Route source", p.source || "station overlay"],
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

function buildTrainSegmentPopup(train, feature) {
  const p = feature.properties || {};
  const ridden = p.ride_segment === true;
  const fromStop = (train.stops || []).find((x) => stopName(x) === p.from);
  const toStop = (train.stops || []).find((x) => stopName(x) === p.to);
  // Branch portion may run under a different number; show it for this segment.
  const section = routeSectionForSegment(train, p);
  const segNumber = (section && section.number) || train.number || "-";
  const segName = (section && section.name) || "";
  const isBranch = Boolean(
    section && section.number && section.number !== train.number,
  );
  const rows = [
    ["Train ID", train.id],
    ["車號", segNumber],
    ["Type / Company", trainTypeCompanyLabel(train) || "-"],
  ];
  if (isBranch)
    rows.push([
      "支線車號 / Branch",
      `${section.number}${segName ? "　" + segName : ""}`,
    ]);
  return popupHtml(`${segNumber} ${segName || ""}`, [
    ...rows,
    ["Segment", `${p.from || ""} → ${p.to || ""}`],
    ["Departure", (fromStop && fromStop.departure) || "-"],
    ["Arrival", (toStop && toStop.arrival) || "-"],
    ["Ride", ridden ? "Yes" : "No"],
    ["segment_index", p.segment_index ?? "-"],
    ["Route ID", p.route_id || "-"],
    ["Route choice", p.route_choice || "-"],
    ["Route source", p.source || "matched route"],
    [
      "Allowed N02_002",
      (
        p.allowed_institution_type_codes ||
        train.route_policy?.allowed_institution_type_codes ||
        []
      ).join(", ") || "-",
    ],
    ["Visible", train.visible === false ? "No" : "Yes"],
  ]);
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
