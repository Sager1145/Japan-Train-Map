/*
 * railmap-popup.js — railprint's C5 bilingual station hover popup.
 *
 * Builds the popup model (every line through the hovered physical station,
 * deduped across the station group) and renders it to HTML rows with the
 * line logo / color swatch + a short company label.
 *
 * Publishes the RailMapPopup global (consumed by railmap-interactions.js).
 */
(function (global) {
  "use strict";

  const DEFAULT_LINE_COLOR = global.RailNetwork.DEFAULT_LINE_COLOR;

  // ───────────────────────── C5 hover popup (popup.ts + company.ts) ─────────────────────
  const companyLabel = global.RailOperatorBranding.companyLabel;
  const companyFor = global.RailOperatorBranding.companyFor;
  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }
  function bilingualLabel(name, nameRoma) {
    return nameRoma ? name + " (" + nameRoma + ")" : name;
  }
  function assetUrl(p) {
    return encodeURI(String(p).replace(/^\//, "./"));
  }
  function lineBadgeHtml(row) {
    if (row.logo)
      return (
        '<img class="rp-line-logo' +
        (row.logoNeedsDarkMatte ? " rp-line-logo--dark-matte" : "") +
        '" src="' +
        escHtml(assetUrl(row.logo)) +
        '" alt="" loading="lazy" />'
      );
    return '<span class="rp-line-swatch" style="background:' + escHtml(row.color) + '"></span>';
  }
  function buildPopupModel(network, stationId, lineIdFallback) {
    const st = network.stationById.get(stationId);
    const groupKey = st && st.stationGroupId ? st.stationGroupId : "solo:" + stationId;
    const members = network.groupMembers.get(groupKey) || [];
    const rows = [];
    // A canonical railway can be stored as several drawable strokes (main,
    // branch, rejoin or paired alignment). At a shared station those records
    // are still one passenger-facing line, so key the popup by its displayed
    // operator + name instead of by the internal stroke id. Railway identity
    // is deliberately not used here: it may join differently named through
    // railways for lane continuity (東北線 → 東海道線 at 東京), and both names
    // must remain visible to passengers.
    const seen = new Set();
    const add = (lineId) => {
      const line = network.lineById.get(lineId);
      if (!line) return;
      const displayKey = `${line.operator || ""}\u0000${line.name || ""}`;
      if (seen.has(displayKey)) return;
      seen.add(displayKey);
      const logo = global.RailOperatorBranding.logoForLine(line);
      rows.push({
        lineId: line.lineId,
        company: companyFor(line.operator, line.name),
        label: bilingualLabel(line.name, line.nameRoma),
        color: line.color || DEFAULT_LINE_COLOR,
        // Prefer a package-provided/per-line badge, then fall back to the
        // operator mark when the line has no dedicated identity.
        logo,
        logoNeedsDarkMatte:
          typeof global.RailOperatorBranding.logoNeedsDarkMatte === "function" &&
          global.RailOperatorBranding.logoNeedsDarkMatte(logo),
      });
    };
    for (const m of members) add(m.lineId);
    if (rows.length === 0 && lineIdFallback) add(lineIdFallback);
    rows.sort((a, b) => a.label.localeCompare(b.label));
    const rawName = st ? st.name : stationId;
    const name =
      global.I18N && typeof global.I18N.stationName === "function"
        ? global.I18N.stationName(rawName, st ? st.stationId : stationId)
        : rawName;
    return {
      name,
      nameRoma: st && st.nameRoma ? st.nameRoma : "",
      // Header readings from the curated station-readings reference (kana /
      // romaji / Chinese per the app's 顯示 toggles) when the app's i18n layer
      // is present, one per line under the name; null keeps the standalone
      // railmap behavior (single nameRoma subline).
      readings:
        global.I18N && typeof global.I18N.nameReadingsList === "function"
          ? global.I18N.nameReadingsList(rawName, st ? st.stationId : stationId)
          : null,
      lines: rows,
    };
  }
  function stationPopupHtml(model, opts) {
    // readings === null -> standalone railmap (no app i18n): keep nameRoma.
    // readings === []   -> app context with every reading toggle off: no sublines.
    // Each reading renders as its OWN line under the name (.rp-popup-head is a
    // column flexbox), so the popup grows with however many are enabled.
    const subs =
      model.readings != null
        ? model.readings
        : model.nameRoma
          ? [model.nameRoma]
          : [];
    const header =
      '<span class="rp-popup-ja">' +
      escHtml(model.name) +
      "</span>" +
      subs
        .map((s) => '<span class="rp-popup-roma">' + escHtml(s) + "</span>")
        .join("");
    const rows = model.lines
      .map((r) => {
        const co = r.company
          ? '<span class="rp-line-co">' + escHtml(r.company) + "</span>"
          : "";
        return (
          '<li class="rp-line-row">' +
          co +
          lineBadgeHtml(r) +
          '<span class="rp-line-name">' +
          escHtml(r.label) +
          "</span></li>"
        );
      })
      .join("");
    const subhead = opts && opts.subhead ? opts.subhead : "";
    return (
      '<div class="rp-popup"><div class="rp-popup-head">' +
      header +
      "</div>" +
      subhead +
      (rows ? '<ul class="rp-line-list">' + rows + "</ul>" : "") +
      "</div>"
    );
  }

  // companyLabel is shared with the 統計 per-line breakdown, which groups its
  // rows by operating company and needs the same short label (JR東日本 etc.).
  global.RailMapPopup = { buildPopupModel, stationPopupHtml, companyLabel };
})(window);
