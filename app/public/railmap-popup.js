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
  const COMPANY_LABELS = {
    東日本旅客鉄道: "JR東日本",
    西日本旅客鉄道: "JR西日本",
    東海旅客鉄道: "JR東海",
    九州旅客鉄道: "JR九州",
    北海道旅客鉄道: "JR北海道",
    四国旅客鉄道: "JR四国",
    東京地下鉄: "東京メトロ",
    東京都: "都営",
    大阪市高速電気軌道: "大阪メトロ",
    名古屋市: "名古屋市営",
    横浜市: "横浜市営",
    神戸市: "神戸市営",
    京都市: "京都市営",
    札幌市: "札幌市営",
    仙台市: "仙台市営",
    福岡市: "福岡市営",
    熊本市: "熊本市電",
    鹿児島市: "鹿児島市電",
    函館市: "函館市電",
    一般社団法人札幌市交通事業振興公社: "札幌市電",
    東急電鉄: "東急",
    京王電鉄: "京王",
    京成電鉄: "京成",
    京浜急行電鉄: "京急",
    小田急電鉄: "小田急",
    西武鉄道: "西武",
    東武鉄道: "東武",
    相模鉄道: "相鉄",
    近畿日本鉄道: "近鉄",
    南海電気鉄道: "南海",
    京阪電気鉄道: "京阪",
    阪急電鉄: "阪急",
    阪神電気鉄道: "阪神",
    名古屋鉄道: "名鉄",
    西日本鉄道: "西鉄",
  };
  function companyLabel(operator) {
    if (!operator) return "";
    if (COMPANY_LABELS[operator]) return COMPANY_LABELS[operator];
    return operator
      .replace(/(?:株式会社|有限会社)/g, "")
      .replace(/^(?:一般社団法人|一般財団法人|公益社団法人|公益財団法人|地方独立行政法人)/, "")
      .trim();
  }
  function companyFor(operator, lineName) {
    const label = companyLabel(operator);
    if (!label) return "";
    if (lineName.startsWith(label)) return "";
    if (operator && lineName.startsWith(operator)) return "";
    return label;
  }
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
        '<img class="rp-line-logo" src="' +
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
    const seen = new Set();
    const add = (lineId) => {
      if (seen.has(lineId)) return;
      const line = network.lineById.get(lineId);
      if (!line) return;
      seen.add(lineId);
      rows.push({
        lineId: line.lineId,
        company: companyFor(line.operator, line.name),
        label: bilingualLabel(line.name, line.nameRoma),
        color: line.color || DEFAULT_LINE_COLOR,
        logo: line.logo || null,
      });
    };
    for (const m of members) add(m.lineId);
    if (rows.length === 0 && lineIdFallback) add(lineIdFallback);
    rows.sort((a, b) => a.label.localeCompare(b.label));
    return {
      name: st ? st.name : stationId,
      nameRoma: st && st.nameRoma ? st.nameRoma : "",
      lines: rows,
    };
  }
  function stationPopupHtml(model, opts) {
    const header = model.nameRoma
      ? '<span class="rp-popup-ja">' +
        escHtml(model.name) +
        '</span><span class="rp-popup-roma">' +
        escHtml(model.nameRoma) +
        "</span>"
      : '<span class="rp-popup-ja">' + escHtml(model.name) + "</span>";
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
