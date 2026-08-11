// =========================================================================
//  app-stats-render.js — §23a-render: mileage-statistics presentation
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
//
//  Split out of app-stats.js, which had grown to carry three jobs at once:
//  section classification, mileage aggregation, and the DOM/HTML for the
//  統計 panel. Only the third touches the document. Everything here consumes
//  the finished view object that buildMileageStatsView() returns and writes
//  markup; nothing here decides what a kilometre counts towards.
//
//  Direction of dependency: app-stats.js (orchestration) calls INTO this
//  file — runMileageStatsJob() awaits the view, then hands it to
//  renderMileageStatsDom(). Nothing here calls back into the aggregator.
// =========================================================================

function formatStatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0
    ? I18N.t("fmt.duration", { h, m })
    : I18N.t("fmt.durationM", { m });
}

// ── 最常乘坐區間: how often each station-to-station interval was ridden ──────
//
// The unit is one matched route feature = one ridden interval between two
// adjacent stops (jsonspec §14.1), which is what "車站-車站之間的區間" means.
// A ride is counted per train, so riding 三島→沼津 on four different days is
// four rides. Direction is folded together: 三島→沼津 and 沼津→三島 are the
// same physical section, so they share one row.
//
// Returns { byMask: Map<mask, sorted rows> }, each row
// { from, to, count, km } — km is the interval's own length (not multiplied
// by the ride count), so it reads as "this section, ridden N times".
// Short distances keep one decimal: a 2-digit figure rounded to a whole km
// loses a meaningful share of itself (8.6 km reading as "9"), while anything
// from 100 km up is precise enough whole.
function formatStatKm(km) {
  const v = Number(km) || 0;
  if (Math.abs(v) < 100) return (Math.round(v * 10) / 10).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return Math.round(v).toLocaleString();
}
function formatStatPct(pct) {
  return pct > 0 && pct < 10 ? pct.toFixed(1) : String(Math.round(pct));
}

// ── Time-sliced stats job ───────────────────────────────────────────────────
// The UI recompute path: never blocks more than ~12 ms at a time. A newer
// schedule cancels an in-flight job via the token.
// Collator for the per-line breakdown order: `numeric` makes an embedded line
// number sort naturally (1号線 < 2号線 < 10号線 rather than 1 < 10 < 2) and latin
// letters compare alphabetically; Japanese names fall back to a stable locale
// order. One shared instance — constructing a Collator per compare is slow.
const STATS_LINE_COLLATOR = new Intl.Collator(["ja", "en"], {
  numeric: true,
  sensitivity: "base",
});

// Short operator label for a breakdown row, reusing railprint's popup mapping
// (東日本旅客鉄道 -> JR東日本). Falls back to the raw N02 operator name.
function statsCompanyLabel(operator) {
  if (!operator) return "";
  try {
    if (
      typeof RailMapPopup !== "undefined" &&
      typeof RailMapPopup.companyLabel === "function"
    )
      return RailMapPopup.companyLabel(operator);
  } catch (_) {
    /* fall through to the raw name */
  }
  return operator;
}

// Per-line coverage rows shown indented under a category row, ordered by
// operating company then line, each with its own coverage %. Lets a near-100%
// aggregate be audited line by line (and a line spotted that shouldn't be
// covered). Every category renders
// as the same collapsible 依線路 <details> button. `listAll` additionally
// includes unridden (0%) member lines — used for 新幹線 (only ~11 lines, so the
// 0% 山形/秋田新幹線 stay visible) and 地下鐵; the 在來線 / JR / 私鐵 lists
// stay ridden-only to avoid hundreds of 0% rows.
function categoryLineBreakdownHtml(s, categoryMask, listAll) {
  if (!s.lineTotByCat || !s.lineTotByCat.size) return "";
  const rows = [];
  s.lineTotByCat.forEach((tot, name) => {
    const t = tot[categoryMask] || 0;
    if (t <= 0) return;
    const rid = (s.lineRidByCat.get(name) || {})[categoryMask] || 0;
    if (rid > 0 || listAll) rows.push([name, t, rid]);
  });
  if (!rows.length) return "";
  // Stable, readable order instead of "whatever we rode most": group by
  // operating company, then by line within the company. STATS_LINE_COLLATOR is
  // numeric-aware, so an embedded line number sorts 1→2→10 (not 1→10→2) and any
  // latin letters fall in alphabetical order. Lines with no known operator sort
  // last so they can't split a company's block.
  const operatorOf = (name) => (s.lineOperator && s.lineOperator.get(name)) || "";
  rows.sort((a, b) => {
    const opA = operatorOf(a[0]);
    const opB = operatorOf(b[0]);
    if (opA !== opB) {
      if (!opA) return 1;
      if (!opB) return -1;
      const byOp = STATS_LINE_COLLATOR.compare(opA, opB);
      if (byOp) return byOp;
    }
    return STATS_LINE_COLLATOR.compare(a[0], b[0]);
  });
  const body =
    `<div class="stat-subrows">` +
    rows
      .map(([name, tot, rid]) => {
        const pct = tot > 0 ? (100 * rid) / tot : 0;
        // Show the company the rows are grouped by, otherwise a company-ordered
        // list reads as arbitrary (the line names alone give no clue).
        const co = statsCompanyLabel(operatorOf(name));
        const coHtml = co
          ? `<span class="stat-subco">${escapeHtml(co)}</span>`
          : "";
        return `
        <div class="stat-subrow">
          <span class="stat-sublabel">${coHtml}${escapeHtml(name)}</span>
          <span class="stat-subval"><span class="stat-subpct">${formatStatPct(pct)}%</span><span class="stat-subkm">${formatStatKm(rid)} / ${formatStatKm(tot)} km</span></span>
        </div>`;
      })
      .join("") +
    `</div>`;
  return `<details class="stat-lines"><summary class="stat-lines-summary">${escapeHtml(I18N.t("stats.byLineCount", { count: rows.length }))}</summary>${body}</details>`;
}

function renderMileageStatsDom(view) {
  const daily = document.getElementById("stats-daily");
  const headline = document.getElementById("stats-headline");
  const rows = document.getElementById("stats-rows");
  if (!headline || !rows || !view) return;
  const s = view.overall;

  // ── 當日統計: always rendered ABOVE the all-time block. With a concrete
  //    date it carries that day's numbers; on 全部 every value reads "--".
  if (daily) {
    if (view.daily) {
      const d = view.daily;
      daily.innerHTML = `
        <h3 class="subhead">${escapeHtml(I18N.t("stats.dailyTitle", { date: d.date }))}</h3>
        <div class="stats-daily-hero">
          <span class="stats-daily-km">${formatStatKm(d.stats.riddenAll)}<span class="unit">km</span></span>
          <span class="stats-sub">${escapeHtml(I18N.t("stat.time"))} ${escapeHtml(formatStatDuration(d.stats.rideMinutes || 0))} · ${escapeHtml(I18N.t("stat.trains", { n: d.trainCount }))}</span>
        </div>
        <!-- Use the same mutually-exclusive ride groups as 實際乘坐量. Each
             row includes distance, time and train count; the overlapping
             network-category mileage rows previously shown here were removed. -->
        ${serviceRowsHtml(d.stats.services)}
        <div class="divider"></div>`;
    } else {
      daily.innerHTML = `
        <h3 class="subhead">${escapeHtml(I18N.t("stats.dailyTitle", { date: "--" }))}</h3>
        <div class="stats-daily-hero">
          <span class="stats-daily-km">--<span class="unit">km</span></span>
          <span class="stats-sub">${escapeHtml(I18N.t("stat.time"))} -- · ${escapeHtml(I18N.t("stat.trains", { n: "--" }))}</span>
        </div>
        <div class="divider"></div>`;
    }
  }

  // ── Section 1: 路網覆蓋率 — deduped coverage percentages over N02 totals.
  const pctAll = s.totals.all > 0 ? (100 * s.riddenAll) / s.totals.all : 0;
  headline.innerHTML = `
    <h3 class="subhead">${escapeHtml(I18N.t("stats.coverageTitle"))}</h3>
    <div class="stats-hero">
      <span class="stats-pct">${formatStatPct(pctAll)}<span class="unit">%</span></span>
      <span class="stats-sub">${formatStatKm(s.riddenAll)} / ${formatStatKm(s.totals.all)} km · ${escapeHtml(I18N.tc("stat.all"))}</span>
    </div>
    <div class="stats-track"><div class="stats-fill" style="width:${Math.min(100, pctAll).toFixed(2)}%"></div></div>`;
  const timeRow = `
      <div class="stat-row">
        <div class="stat-row-head">
          <span class="stat-label">${escapeHtml(I18N.t("stat.time"))}</span>
          <span class="stat-val"><span class="stat-pct">${escapeHtml(formatStatDuration(s.rideMinutes || 0))}</span></span>
        </div>
      </div>`;
  // ── Section 2: 路網覆蓋率 per category. Every row expands into a per-line
  //    breakdown (依線路 button) so a near-100% figure is auditable line by
  //    line; 新幹線 and 地下鐵 list all member lines including unridden ones.
  rows.innerHTML =
    activeStatCategories().map((c) => {
      const tot = s.totals.byMask.get(c.mask) || 0;
      const rid = s.riddenByMask.get(c.mask) || 0;
      const pct = tot > 0 ? (100 * rid) / tot : 0;
      const detail = categoryLineBreakdownHtml(
        s,
        c.mask,
        c.mask === STAT_MASK_HSR || c.mask === STAT_MASK_METRO,
      );
      return `
      <div class="stat-row">
        <div class="stat-row-head">
          <span class="stat-label">${escapeHtml(I18N.tc(c.i18n))}</span>
          <span class="stat-val"><span class="stat-pct">${formatStatPct(pct)}%</span><span class="stat-km">${formatStatKm(rid)} / ${formatStatKm(tot)} km</span></span>
        </div>
        <div class="stats-track"><div class="stats-fill" style="width:${Math.min(100, pct).toFixed(2)}%"></div></div>
        ${detail}
      </div>`;
    }).join("") +
    `<div class="divider"></div>
     <h3 class="subhead">${escapeHtml(I18N.t("stats.actualTitle"))}</h3>` +
    serviceRowsHtml(s.services) +
    timeRow +
    topSegmentsHtml(s.topSegments);
}

// ── 最常乘坐區間 rows, one per category ───────────────────────────────────────
// The head shows that category's single most-ridden section; the rest expand
// in a 依次數 list. Categories with nothing ridden are omitted entirely rather
// than rendering an empty row.
const TOP_SEGMENT_LIMIT = 12;
// This section leads with 全部鐵道 (every ridden interval, no category filter)
// and then splits by mode. It deliberately does NOT reuse STAT_CATEGORIES:
// the coverage rows carry a JR（含新幹線）row that is a UNION of two other rows,
// which is meaningful for coverage percentages but would just duplicate
// sections here.
// Each row is one EXCLUSIVE mode (see exclusiveTrackBucket), so a section
// appears under exactly one of them — hence 在來線 here reads as JR在來線
// rather than the coverage section's "everything that is not 新幹線".
const TOP_SEGMENT_CATEGORIES = [
  { mask: null, i18n: "stat.allrail" },
  { mask: STAT_MASK_HSR, i18n: "stat.hsr" },
  { mask: STAT_MASK_CONV, i18n: "stat.jrconv" },
  { mask: STAT_MASK_METRO, i18n: "stat.metro" },
  { mask: STAT_MASK_PRIV, i18n: "stat.priv" },
  { mask: STAT_MASK_TRAM, i18n: "stat.tram" },
];
function topSegmentsHtml(top) {
  if (!top || !top.byMask) return "";
  const sectionLabel = (row) =>
    `${I18N.placeName(row.from)} ↔ ${I18N.placeName(row.to)}`;
  const blocks = TOP_SEGMENT_CATEGORIES.map((c) => {
    const rows = (c.mask === null ? top.all : top.byMask.get(c.mask)) || [];
    if (!rows.length) return "";
    const best = rows[0];
    const rest = rows
      .slice(0, TOP_SEGMENT_LIMIT)
      .map(
        (r) => `
        <div class="stat-subrow">
          <span class="stat-sublabel">${escapeHtml(sectionLabel(r))}</span>
          <span class="stat-subval">${escapeHtml(I18N.t("stat.rides", { n: r.count }))} · ${formatStatKm(r.km)} km</span>
        </div>`,
      )
      .join("");
    const more =
      rows.length > 1
        ? `<details class="stat-lines"><summary class="stat-lines-summary">${escapeHtml(I18N.t("stats.byCountCount", { count: rows.length }))}</summary><div class="stat-subrows">${rest}</div></details>`
        : "";
    return `
      <div class="stat-row">
        <div class="stat-row-head">
          <span class="stat-label">${escapeHtml(I18N.tc(c.i18n))}</span>
          <span class="stat-val"><span class="stat-km">${escapeHtml(sectionLabel(best))} · ${escapeHtml(I18N.t("stat.rides", { n: best.count }))}</span></span>
        </div>
        ${more}
      </div>`;
  }).join("");
  if (!blocks) return "";
  return `<div class="divider"></div>
     <h3 class="subhead">${escapeHtml(I18N.t("stats.topSegmentsTitle"))}</h3>
     <p class="hint">${escapeHtml(I18N.t("stats.topSegmentsHint"))}</p>${blocks}`;
}

// 有料特急 / 其他列車 rows: cumulative distance + time + ride count for each
// service group — deliberately NO percentage / progress bar (repeat rides
// count each time, so there is no meaningful denominator).
function serviceRowsHtml(services) {
  if (!services) return "";
  const row = (labelKey, g) => `
      <div class="stat-row">
        <div class="stat-row-head">
          <span class="stat-label">${escapeHtml(I18N.tc(labelKey))}</span>
          <span class="stat-val"><span class="stat-km">${formatStatKm(g.km)} km · ${escapeHtml(formatStatDuration(g.minutes))} · ${escapeHtml(I18N.t("stat.trains", { n: g.count }))}</span></span>
        </div>
      </div>`;
  return (
    row("stat.hsr", services.hsr) +
    row("stat.ltdexp", services.ltd) +
    row("stat.othertrains", services.other)
  );
}
