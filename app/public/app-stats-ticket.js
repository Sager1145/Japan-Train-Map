// Presentation-only ticket face. The 510 × 345 layout mirrors iOS TicketFace;
// mileage and membership arrive from buildMileageStatsView().
function statsTicketDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!match) return date || "";
  const part = (value) => String(Number(value));
  return `${match[1]}.${part(match[2])}.${part(match[3])}`;
}

function statsTicketSpelledDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!match) return date || "";
  return I18N.t("ticket.date", {
    y: match[1], m: String(Number(match[2])), d: String(Number(match[3])),
  });
}

function statsTicketField(label, value, unit = "") {
  const spoken = [label, value, unit].filter(Boolean).join(" ");
  return `<div class="ticket-field" aria-label="${escapeHtml(spoken)}">
    <span class="ticket-field-label" aria-hidden="true">${escapeHtml(label)}</span>
    <span class="ticket-field-value" aria-hidden="true">${escapeHtml(value)}${unit ? `<small>${escapeHtml(unit)}</small>` : ""}</span>
  </div>`;
}

function statsTicketFace({ kind, scope, distance, minutes, fields, span }) {
  const hour = Math.floor((Number(minutes) || 0) / 60);
  const minute = Math.round((Number(minutes) || 0) % 60);
  const now = new Date();
  const issuedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const issued = I18N.t("ticket.issued", { date: statsTicketDate(issuedDate) });
  return `<article class="ticket-face" role="group" aria-label="${escapeHtml(kind)}">
    <span class="ticket-mark" aria-hidden="true">RM</span>
    <h3 class="ticket-kind">${escapeHtml(kind)}</h3>
    <span class="ticket-scope">（${escapeHtml(scope)}）</span>
    <span class="ticket-kind-rule" aria-hidden="true"></span>
    <div class="ticket-display ticket-distance" aria-label="${escapeHtml(I18N.t("ticket.distance"))} ${escapeHtml(distance)} km">
      <span class="ticket-display-label" aria-hidden="true">${escapeHtml(I18N.t("ticket.distance"))}</span>
      <strong aria-hidden="true">${escapeHtml(distance)}<small>KM</small></strong>
    </div>
    <div class="ticket-display ticket-duration" aria-label="${escapeHtml(I18N.t("stat.time"))} ${escapeHtml(formatStatDuration(minutes))}">
      <span class="ticket-display-label" aria-hidden="true">${escapeHtml(I18N.t("stat.time"))}</span>
      <strong aria-hidden="true">${hour}<small>${escapeHtml(I18N.t("ticket.hours"))}</small>${minute}<small>${escapeHtml(I18N.t("ticket.minutes"))}</small></strong>
    </div>
    <div class="ticket-fields">${fields.map((field) => statsTicketField(...field)).join("")}</div>
    <div class="ticket-span">${escapeHtml(span || "")}</div>
    <div class="ticket-band" aria-hidden="true"></div>
    <div class="ticket-footer">${escapeHtml(issued)}<span>v1.0.0</span></div>
  </article>`;
}

function statsRecordTicketHtml(view) {
  const { overall: stats, ticket } = view;
  const networkKm = Math.max(0, stats.riddenAll - stats.unmatchedKm);
  const coverage = stats.totals.all > 0
    ? formatStatPct((100 * networkKm) / stats.totals.all)
    : "0";
  let span = "";
  if (ticket.firstDate) {
    span = ticket.firstDate === ticket.lastDate
      ? I18N.t("ticket.spanDay", { date: statsTicketSpelledDate(ticket.firstDate) })
      : I18N.t("ticket.span", {
          from: statsTicketSpelledDate(ticket.firstDate),
          to: statsTicketSpelledDate(ticket.lastDate),
        });
  }
  return statsTicketFace({
    kind: I18N.t("ticket.record"),
    scope: I18N.t(`country.${activeCountry}`),
    distance: formatStatKm(stats.riddenAll),
    minutes: stats.rideMinutes || 0,
    fields: [
      [I18N.t("ticket.rides"), ticket.rideCount.toLocaleString(), I18N.t("ticket.ridesUnit")],
      [I18N.t("ticket.stops"), ticket.stopCount.toLocaleString(), I18N.t("ticket.stopsUnit")],
      [I18N.t("ticket.coverage"), coverage, I18N.t("ticket.percentUnit")],
      [I18N.t("ticket.operators"), ticket.operatorCount.toLocaleString(), I18N.t("ticket.operatorsUnit")],
    ],
    span,
  });
}

function statsDailyTicketHtml(daily) {
  const services = daily.stats.services;
  const groups = [
    ["hsr", "stat.hsr", services.hsr],
    ["ltd", "stat.ltdexp", services.ltd],
    ["other", "stat.othertrains", services.other],
  ].filter(([group]) => activeServiceRows().includes(group));
  return statsTicketFace({
    kind: I18N.t("ticket.day"),
    scope: I18N.t(`country.${activeCountry}`),
    distance: formatStatKm(groups.reduce((sum, [, , group]) => sum + group.km, 0)),
    minutes: daily.stats.rideMinutes || 0,
    fields: [
      [I18N.t("ticket.rides"), daily.trainCount.toLocaleString(), I18N.t("ticket.ridesUnit")],
      ...groups.map(([, key, group]) => [I18N.t(key), formatStatKm(group.km), "KM"]),
    ],
    span: I18N.t("ticket.spanDay", { date: statsTicketSpelledDate(daily.rawDate) }),
  });
}

function bindStatsTicketPrint(hasTicket) {
  const button = document.getElementById("passport-print-ticket");
  if (!button) return;
  button.disabled = !hasTicket;
  if (button.dataset.ticketPrintBound) return;
  button.dataset.ticketPrintBound = "true";
  button.addEventListener("click", () => window.print());
}
