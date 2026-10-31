// Native Passport's journey-level cards, kept separate from network coverage.
let statsPassportAxis = "month";
let statsPassportYear = null;
const statsPassportRankMetric = { operators: "count", routes: "count" };
let statsPassportLastView = null;

function statsPassportControls(view) {
  statsPassportLastView = view;
  const host = document.getElementById("stats-headline");
  if (!host || host.dataset.passportControlsBound) return;
  host.dataset.passportControlsBound = "true";
  host.addEventListener("click", (event) => {
    const axis = event.target.closest("[data-stats-axis]");
    const metric = event.target.closest("[data-stats-rank-metric]");
    const journey = event.target.closest("[data-stats-journey]");
    if (axis) statsPassportAxis = axis.dataset.statsAxis;
    else if (metric) statsPassportRankMetric[metric.dataset.statsRank] = metric.dataset.statsRankMetric;
    else if (journey) { openJourneyDetail(journey.dataset.statsJourney); return; }
    else return;
    renderMileageStatsDom(statsPassportLastView);
  });
  host.addEventListener("change", (event) => {
    if (event.target.matches("[data-stats-year]")) {
      statsPassportYear = Number(event.target.value);
      renderMileageStatsDom(statsPassportLastView);
    }
  });
}

function statsPassportChart(passport) {
  const todayYear = new Date().getFullYear();
  const years = [...new Set([todayYear, ...passport.years.keys()])].sort((a, b) => b - a);
  const year = years.includes(statsPassportYear) ? statsPassportYear : todayYear;
  const locale = I18N.getLang?.() || "zh-Hant";
  const entries = statsPassportAxis === "year"
    ? [...passport.years.entries()].map(([id, row]) => ({ label: String(id), name: String(id), count: row.count }))
    : Array.from({ length: statsPassportAxis === "month" ? 12 : 7 }, (_, index) => {
      const id = index + 1;
      const map = statsPassportAxis === "month" ? passport.months.get(year) : passport.weekdays.get(year);
      const name = statsPassportAxis === "month"
        ? new Intl.DateTimeFormat(locale, { month: "long" }).format(new Date(2024, index, 1))
        : new Intl.DateTimeFormat(locale, { weekday: "long" }).format(new Date(2024, 0, 7 + index));
      return { label: statsPassportAxis === "month" ? String(id) : name.slice(0, 2), name, count: map?.get(id)?.count || 0 };
    });
  const max = Math.max(1, ...entries.map((entry) => entry.count));
  const best = entries.reduce((found, entry) => entry.count > (found?.count || 0) ? entry : found, null);
  const axes = ["year", "month", "weekday"].map((axis) => `
    <button type="button" data-stats-axis="${axis}" aria-pressed="${axis === statsPassportAxis}">${escapeHtml(I18N.t(`passport.axis.${axis}`))}</button>`).join("");
  return `<section class="passport-stat-card">
    <h3>${escapeHtml(I18N.t("passport.rhythm"))}</h3>
    <div class="passport-stat-segmented" role="group" aria-label="${escapeHtml(I18N.t("passport.axis"))}">${axes}</div>
    ${statsPassportAxis === "year" ? "" : `<label class="passport-stat-year">${escapeHtml(I18N.t("passport.year"))}
      <select data-stats-year>${years.map((value) => `<option value="${value}"${value === year ? " selected" : ""}>${value}</option>`).join("")}</select></label>`}
    ${best?.count ? `<p class="passport-stat-highlight">${escapeHtml(I18N.t("passport.mostJourneys"))} <strong>${escapeHtml(best.name)}</strong> · ${escapeHtml(I18N.t("stat.trains", { n: best.count }))}</p>` : ""}
    <div class="passport-stat-chart" role="list" aria-label="${escapeHtml(I18N.t("passport.rhythm"))}">
      ${entries.map((entry) => `<div class="passport-stat-column" role="listitem" aria-label="${escapeHtml(entry.name)}: ${escapeHtml(I18N.t("stat.trains", { n: entry.count }))}">
        <span>${entry.count || ""}</span><i style="height:${Math.max(2, (100 * entry.count) / max)}%"></i><small>${escapeHtml(entry.label)}</small>
      </div>`).join("")}
    </div>
    ${passport.undated ? `<p class="passport-stat-note">${escapeHtml(I18N.t("passport.undated", { n: passport.undated }))}</p>` : ""}
  </section>`;
}

function statsPassportJourneyRow(key, journey, value) {
  if (!journey) return "";
  const route = [journey.from, journey.to].filter(Boolean).join(" → ");
  return `<button class="passport-stat-journey" type="button" data-stats-journey="${escapeHtml(journey.id)}">
    <span>${escapeHtml(I18N.t(key))}<strong>${escapeHtml(journey.name)}</strong><small>${escapeHtml(route)}</small></span>
    <b>${escapeHtml(value)}</b>
  </button>`;
}

function statsPassportDistanceTime(passport) {
  const meanKm = passport.journeys ? passport.totalKm / passport.journeys : 0;
  const meanMinutes = passport.timedJourneys ? passport.totalMinutes / passport.timedJourneys : 0;
  const scale = [
    ["passport.earth", 40075.017], ["passport.moon", 384400], ["passport.sun", 4375517],
  ].filter(([, km]) => passport.totalKm / km >= 0.005);
  return `<section class="passport-stat-card"><h3>${escapeHtml(I18N.t("passport.distance"))}</h3>
    <div class="passport-stat-metric"><span>${escapeHtml(I18N.t("passport.perJourney"))}</span><strong>${formatStatKm(meanKm)} km</strong></div>
    ${scale.map(([key, km]) => `<div class="passport-stat-metric"><span>${escapeHtml(I18N.t(key))}</span><strong>${(passport.totalKm / km).toFixed(2)}×</strong></div>`).join("")}
    ${statsPassportJourneyRow("passport.longestDistance", passport.longestDistance, `${formatStatKm(passport.longestDistance?.km)} km`)}
    ${passport.shortestDistance?.id === passport.longestDistance?.id ? "" : statsPassportJourneyRow("passport.shortestDistance", passport.shortestDistance, `${formatStatKm(passport.shortestDistance?.km)} km`)}
  </section>
  <section class="passport-stat-card"><h3>${escapeHtml(I18N.t("passport.time"))}</h3>
    <div class="passport-stat-metric"><span>${escapeHtml(I18N.t("passport.perJourney"))}</span><strong>${escapeHtml(formatStatDuration(meanMinutes))}</strong></div>
    ${[["passport.day", 1440], ["passport.week", 10080], ["passport.month", 43200], ["passport.yearTime", 525600]].filter(([, minutes]) => passport.totalMinutes / minutes >= 0.005).map(([key, minutes]) => `<div class="passport-stat-metric"><span>${escapeHtml(I18N.t(key))}</span><strong>${(passport.totalMinutes / minutes).toFixed(2)}×</strong></div>`).join("")}
    ${statsPassportJourneyRow("passport.longestTime", passport.longestTime, formatStatDuration(passport.longestTime?.minutes))}
    ${passport.shortestTime?.id === passport.longestTime?.id ? "" : statsPassportJourneyRow("passport.shortestTime", passport.shortestTime, formatStatDuration(passport.shortestTime?.minutes))}
  </section>`;
}

function statsPassportRanking(key, rows, toggle = false) {
  const metric = statsPassportRankMetric[key] || "count";
  const sorted = [...rows].sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name, "ja"));
  const item = (row) => `<div class="passport-stat-rank"><span>${escapeHtml(row.pair ? `${row.name} ↔ ${row.pair}` : row.name)}</span><strong>${metric === "count" ? escapeHtml(I18N.t("stat.trains", { n: row.count })) : `${formatStatKm(row.km)} km`}</strong></div>`;
  return `<section class="passport-stat-card"><h3>${escapeHtml(I18N.t(`passport.${key}`))}</h3>
    ${toggle ? `<div class="passport-stat-segmented" role="group" aria-label="${escapeHtml(I18N.t("passport.rankMetric"))}">
      ${["count", "km"].map((value) => `<button type="button" data-stats-rank="${key}" data-stats-rank-metric="${value}" aria-pressed="${metric === value}">${escapeHtml(I18N.t(`passport.rank.${value}`))}</button>`).join("")}</div>` : ""}
    ${sorted.slice(0, 8).map(item).join("")}
    ${sorted.length > 8 ? `<details><summary>${escapeHtml(I18N.t("passport.showMore", { n: sorted.length - 8 }))}</summary>${sorted.slice(8).map(item).join("")}</details>` : ""}
  </section>`;
}

function statsPassportCardsHtml(passport) {
  if (!passport || !passport.journeys) return "";
  return `<div class="passport-stat-cards">
    ${statsPassportChart(passport)}
    ${statsPassportDistanceTime(passport)}
    ${statsPassportRanking("stations", passport.stations)}
    ${statsPassportRanking("operators", passport.operators, true)}
    ${statsPassportRanking("routes", passport.routes, true)}
  </div>`;
}
