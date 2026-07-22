// =========================================================================
//  app-stats.js — §23a: mileage statistics (railprint-style coverage, classified from N02-25)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  Mileage statistics (railprint-style coverage, classified from N02-25)
// =========================================================================
// Every train's actually-ridden route geometry is mapped onto the N02
// RailroadSection edge set (route coordinates lie exactly on N02 vertices —
// both the prebuilt matched-routes and the in-browser solver run on the same
// rail-sections graph), so repeat rides across trains/dates dedupe naturally.
// Categories follow N02_002 事業者種別 (1=新幹線, 2=JR在来線, 3=公営, 4=民営,
// 5=第三セクター):
//   新幹線   = code 1
//   普通鐵道 = everything except code 1 (在来線)
//   JR       = codes 1+2 (JR全線)
//   地下鐵   = recorded BY OPERATOR: every line run by the metro companies /
//              municipal subway operators below (軌道 classes 21/22 — 都電・
//              市電 trams — excluded even for these operators)
//   私鐵     = codes 4+5 minus the metro operators above
const STAT_MASK_HSR = 1;
const STAT_MASK_CONV = 2;
const STAT_MASK_JR = 4;
const STAT_MASK_METRO = 8;
const STAT_MASK_PRIV = 16;
const STAT_CATEGORIES = [
  { mask: STAT_MASK_HSR, i18n: "stat.hsr" },
  { mask: STAT_MASK_CONV, i18n: "stat.conv" },
  { mask: STAT_MASK_JR, i18n: "stat.jr" },
  { mask: STAT_MASK_METRO, i18n: "stat.metro" },
  { mask: STAT_MASK_PRIV, i18n: "stat.priv" },
];
// 地下鐵 operators (N02_004 names): the two metro companies + every municipal
// subway operator in Japan.
const METRO_OPERATOR_NAMES = new Set([
  "東京地下鉄", // 東京メトロ
  "大阪市高速電気軌道", // Osaka Metro
  "東京都", // 都営地下鉄 (都電 excluded via tram class below)
  "札幌市",
  "仙台市",
  "横浜市",
  "名古屋市",
  "京都市",
  "神戸市",
  "福岡市",
]);
// 都電荒川線 is the ONLY street tram run by a metro-list operator (東京都).
// NOTE: Osaka Metro's subway lines are legally 軌道 (class 21) too, so the
// tram exclusion must be scoped to 東京都 — never applied operator-wide.
const TRAM_RAILWAY_CLASSES = new Set(["21", "22"]);

function classifyN02SectionMask(props) {
  const code = String(props.N02_002 || "");
  const cls = String(props.N02_001 || "");
  const op = props.N02_004 || "";
  let mask = 0;
  if (code === "1") mask |= STAT_MASK_HSR;
  else mask |= STAT_MASK_CONV;
  if (code === "1" || code === "2") mask |= STAT_MASK_JR;
  const isMetro =
    METRO_OPERATOR_NAMES.has(op) &&
    !(op === "東京都" && TRAM_RAILWAY_CLASSES.has(cls));
  if (isMetro) mask |= STAT_MASK_METRO;
  if ((code === "4" || code === "5") && !isMetro) mask |= STAT_MASK_PRIV;
  return mask;
}

// Zero km accumulator keyed by category mask, for per-line-per-category sums.
function statsZeroCatKm() {
  const o = {};
  for (const c of STAT_CATEGORIES) o[c.mask] = 0;
  return o;
}

function statsEdgeKm(ax, ay, bx, by) {
  const kx = 111.32 * Math.cos((((ay + by) / 2) * Math.PI) / 180);
  const dx = (ax - bx) * kx;
  const dy = (ay - by) * 110.574;
  return Math.hypot(dx, dy);
}

// N02 coordinates mix 5-decimal (most lines) and full-precision 8-decimal
// vertices (e.g. 北陸新幹線), while the route solver's graph normalizes all
// nodes to 5 decimals — so edge keys MUST quantize to the same 5-decimal grid
// on both sides or full-precision lines never match their ridden routes.
function statsQuant(v) {
  return Math.round(v * 1e5) / 1e5;
}
function statsEdgeKey(a, b) {
  const ax = statsQuant(a[0]);
  const ay = statsQuant(a[1]);
  const bx = statsQuant(b[0]);
  const by = statsQuant(b[1]);
  return ax < bx || (ax === bx && ay < by)
    ? ax + "," + ay + "|" + bx + "," + by
    : bx + "," + by + "|" + ax + "," + ay;
}

// Built once from rail-sections (the untouched N02-25 data) and reused for
// every stats refresh: edge key -> index into parallel km/mask arrays.
let _statsEdgeIndex = null;

// ── Per-train ridden-edge cache ─────────────────────────────────────────────
// Walking every train's route geometry cost ~430 ms with a full store — far
// too heavy to re-run after every renderAll (the debounced recompute landed
// mid-interaction and froze hover/lane-slide). Each train's walk result is
// cached under a signature covering its route identity + ride flags, so a
// recompute only walks trains that materially changed; the cross-train union
// is a cheap Set merge (a few ms).
const _statsTrainCache = new Map(); // train.id -> { sig, edges: [], spans: [] }

function statsTrainSig(train) {
  let rides = "";
  const stops = train.stops || [];
  for (let i = 0; i < stops.length; i += 1)
    rides += stops[i].ride_segment ? "1" : "0";
  return `${getTrainRouteTemplateKey(train)}:${rides}`;
}

function pruneStatsTrainCache() {
  const trains = trainStore.trains || [];
  if (_statsTrainCache.size <= trains.length + 32) return;
  const live = new Set(trains.map((t) => t.id));
  for (const id of [..._statsTrainCache.keys()])
    if (!live.has(id)) _statsTrainCache.delete(id);
}

// Walk ONE train's ridden geometry onto the edge index. Anchor-merge walk:
// the route solver densifies some N02 edges with interpolated points (station
// snaps / long-edge subdivision), so a naive pair-by-pair lookup misses them.
// Keep the last on-network anchor and try (anchor -> current) at every vertex
// — a subdivided N02 edge re-matches as soon as the walk reaches its far
// endpoint. Off-network connector spans are recorded with the category mask
// of the edge they reconnect to (mask 0 = truly unattributable).
function collectTrainStatsEntry(train, idx) {
  const sig = statsTrainSig(train);
  const cached = _statsTrainCache.get(train.id);
  if (cached && cached.sig === sig && cached.km !== undefined) return cached;
  const edges = [];
  const spans = []; // [spanKey, km, mask]
  const MAX_BRIDGE_KM = 4;
  const recordSpan = (from, to, km, mask) => {
    if (km > 0) spans.push([statsEdgeKey(from, to), km, mask]);
  };
  const walk = (coords) => {
    if (!coords || coords.length < 2) return;
    let anchor = coords[0];
    let pendingKm = 0;
    for (let i = 1; i < coords.length; i += 1) {
      const prev = coords[i - 1];
      const v = coords[i];
      if (anchor[0] === v[0] && anchor[1] === v[1]) continue;
      const e = idx.map.get(statsEdgeKey(anchor, v));
      if (e !== undefined) {
        edges.push(e);
        anchor = v;
        pendingKm = 0; // pending hops were interior to this matched edge
        continue;
      }
      const e2 = idx.map.get(statsEdgeKey(prev, v));
      if (e2 !== undefined) {
        recordSpan(anchor, prev, pendingKm, idx.mask[e2]);
        edges.push(e2);
        anchor = v;
        pendingKm = 0;
        continue;
      }
      pendingKm += statsEdgeKm(prev[0], prev[1], v[0], v[1]);
      if (pendingKm > MAX_BRIDGE_KM || i === coords.length - 1) {
        recordSpan(anchor, v, pendingKm, 0);
        anchor = v;
        pendingKm = 0;
      }
    }
  };
  let features = [];
  try {
    features = getMatchedRouteFeatures(train) || [];
  } catch (err) {
    features = []; // a single unsolvable train must not sink the whole panel
  }
  for (const f of features) {
    if (!f || !f.geometry) continue;
    if (!f.properties || f.properties.ride_segment !== true) continue;
    if (f.geometry.type === "LineString") walk(f.geometry.coordinates);
    else if (f.geometry.type === "MultiLineString")
      f.geometry.coordinates.forEach(walk);
  }
  // This train's OWN cumulative ridden distance (repeat segments count each
  // time — it pairs with ride time / ride count in the service-type rows,
  // unlike the deduped network-coverage sums).
  let km = 0;
  for (const e of edges) km += idx.km[e];
  for (const [, spanKm] of spans) km += spanKm;
  const entry = { sig, edges, spans, km };
  _statsTrainCache.set(train.id, entry);
  return entry;
}

// ── Service-type rows (新幹線 / 有料特急 / 其他列車): cumulative km+time+count ──
function serviceGroupOfTrain(train) {
  const t = String((train && train.train_type) || "");
  if (t.includes("新幹線")) return "hsr";
  if (t.includes("特急")) return "ltd";
  return "other";
}

function serviceGroupStats(trains, entries) {
  const groups = {
    hsr: { km: 0, minutes: 0, count: 0 },
    ltd: { km: 0, minutes: 0, count: 0 },
    other: { km: 0, minutes: 0, count: 0 },
  };
  for (let i = 0; i < trains.length; i += 1) {
    const g = groups[serviceGroupOfTrain(trains[i])];
    g.km += (entries[i] && entries[i].km) || 0;
    const m = trainRideMinutes(trains[i]);
    if (m !== null) g.minutes += m;
    g.count += 1;
  }
  return groups;
}

function aggregateMileageStats(idx, entries) {
  const ridden = new Set();
  const extraSpans = new Map(); // spanKey -> { km, mask } (dedupe repeat rides)
  for (const en of entries) {
    for (const e of en.edges) ridden.add(e);
    for (const [key, km, mask] of en.spans) {
      const cur = extraSpans.get(key);
      if (cur === undefined) extraSpans.set(key, { km, mask });
      else cur.mask |= mask;
    }
  }
  let riddenAll = 0;
  let unmatchedKm = 0;
  const riddenByMask = new Map(STAT_CATEGORIES.map((c) => [c.mask, 0]));
  // Deduped ridden km per line, split by category (drives the per-line
  // breakdown under each coverage row). Same ridden edge Set as the category sums.
  const lineRidByCat = new Map();
  for (const e of ridden) {
    riddenAll += idx.km[e];
    const km = idx.km[e];
    const m = idx.mask[e];
    for (const c of STAT_CATEGORIES)
      if (m & c.mask) riddenByMask.set(c.mask, riddenByMask.get(c.mask) + km);
    const ln = idx.lineArr && idx.lineArr[e];
    if (ln) {
      const lm = idx.lineMaskArr ? idx.lineMaskArr[e] : m;
      let o = lineRidByCat.get(ln);
      if (!o) lineRidByCat.set(ln, (o = statsZeroCatKm()));
      for (const c of STAT_CATEGORIES) if (lm & c.mask) o[c.mask] += km;
    }
  }
  // Connector spans: counted nationally, attributed to their reconnect
  // category when known; mask-0 remainder is reported as unmatchedKm.
  for (const span of extraSpans.values()) {
    riddenAll += span.km;
    if (span.mask === 0) {
      unmatchedKm += span.km;
      continue;
    }
    for (const c of STAT_CATEGORIES)
      if (span.mask & c.mask)
        riddenByMask.set(c.mask, riddenByMask.get(c.mask) + span.km);
  }
  return {
    totals: idx.totals,
    riddenAll,
    riddenByMask,
    unmatchedKm,
    lineTotByCat: idx.lineTotByCat,
    lineRidByCat,
  };
}

// Ride TIME of one train: first effectively-ridden stopping station's
// departure -> last one's arrival (falling back to the other field when one
// is missing; "+1" day offsets are handled by parseTimeToMinutes, and a plain
// end-before-start wraps overnight). null = no usable times.
function trainRideMinutes(train) {
  const stops = train.stops || [];
  const ridden = [];
  stops.forEach((stop, idx) => {
    if (!stop || stop.stop_type === "pass_through") return;
    if (!effectiveStopRide(stops, idx)) return;
    ridden.push(idx);
  });
  if (ridden.length < 2) return null;
  const first = stops[ridden[0]];
  const last = stops[ridden[ridden.length - 1]];
  const start =
    parseTimeToMinutes(first.departure) ?? parseTimeToMinutes(first.arrival);
  let end =
    parseTimeToMinutes(last.arrival) ?? parseTimeToMinutes(last.departure);
  if (start === null || end === null) return null;
  if (end < start) end += 24 * 60;
  return end - start;
}

function sumRideMinutes(trains) {
  let total = 0;
  for (const t of trains) {
    const m = trainRideMinutes(t);
    if (m !== null) total += m;
  }
  return total;
}

function formatStatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0
    ? I18N.t("fmt.duration", { h, m })
    : I18N.t("fmt.durationM", { m });
}

// View model shared by the sync path and the time-sliced job: the all-time
// aggregate plus (when a concrete date bucket is active) that day's own
// km/time aggregate, computed from the SAME per-train cache entries.
function buildMileageStatsView(idx, trains, entries) {
  const overall = aggregateMileageStats(idx, entries);
  overall.rideMinutes = sumRideMinutes(trains);
  overall.services = serviceGroupStats(trains, entries);
  let daily = null;
  if (selectedDate && selectedDate !== ALL_DATES) {
    const dayTrains = [];
    const dayEntries = [];
    trains.forEach((t, i) => {
      if (getTrainDate(t) === selectedDate) {
        dayTrains.push(t);
        dayEntries.push(entries[i]);
      }
    });
    const stats = aggregateMileageStats(idx, dayEntries);
    stats.rideMinutes = sumRideMinutes(dayTrains);
    stats.services = serviceGroupStats(dayTrains, dayEntries);
    daily = { date: dateLabel(selectedDate), trainCount: dayTrains.length, stats };
  }
  return { overall, daily };
}


// ── Ridden-line category display filter (map layers control) ────────────────
// Four checkboxes (新幹線 / JR在來線 / 地下鐵 / 私鐵) hide/show RIDDEN route
// lines by category. Unridden intervals and the 全部鐵路線 network overlay are
// untouched. Each route feature is classified once by dominant km over the
// same N02 edge index the mileage stats use.
const RIDDEN_CATEGORY_FILTER = { hsr: true, jr: true, metro: true, priv: true };
const _featureCategoryCache = new WeakMap();

function riddenFeatureCategory(feature) {
  if (_featureCategoryCache.has(feature))
    return _featureCategoryCache.get(feature);
  // Read-only: NEVER build the (expensive) edge index from the render path —
  // the stats job builds it off-thread-budget; until then stay visible.
  const idx = _statsEdgeIndex;
  if (!idx) return null; // network still loading -> undetermined, stays visible
  const km = { hsr: 0, jr: 0, metro: 0, priv: 0 };
  const lines =
    feature.geometry.type === "LineString"
      ? [feature.geometry.coordinates]
      : feature.geometry.type === "MultiLineString"
        ? feature.geometry.coordinates
        : [];
  for (const cs of lines) {
    for (let i = 1; i < cs.length; i += 1) {
      const e = idx.map.get(statsEdgeKey(cs[i - 1], cs[i]));
      if (e === undefined) continue;
      const m = idx.mask[e];
      const k = idx.km[e];
      if (m & STAT_MASK_HSR) km.hsr += k;
      else if (m & STAT_MASK_METRO) km.metro += k;
      else if (m & STAT_MASK_JR) km.jr += k;
      else km.priv += k;
    }
  }
  let best = null;
  let bestKm = 0;
  for (const c of ["hsr", "metro", "jr", "priv"]) {
    if (km[c] > bestKm) {
      bestKm = km[c];
      best = c;
    }
  }
  _featureCategoryCache.set(feature, best);
  return best;
}

function riddenFeatureVisible(feature) {
  const c = riddenFeatureCategory(feature);
  return c === null || RIDDEN_CATEGORY_FILTER[c] !== false;
}

function setRiddenCategoryFilter(cat, on) {
  RIDDEN_CATEGORY_FILTER[cat] = Boolean(on);
  if (typeof invalidateDeckRouteCaches === "function")
    invalidateDeckRouteCaches();
  if (typeof renderTrainLayers === "function") renderTrainLayers();
}

function anyRiddenCategoryHidden() {
  return (
    RIDDEN_CATEGORY_FILTER.hsr === false ||
    RIDDEN_CATEGORY_FILTER.jr === false ||
    RIDDEN_CATEGORY_FILTER.metro === false ||
    RIDDEN_CATEGORY_FILTER.priv === false
  );
}

// Category of ONE station, classified from its own N02 line attributes
// (stations.json carries N02_001/N02_002/N02_004). Used to hide a hidden
// category's STATION DOTS along with its lines.
function markerCategoryForStation(stationFeature) {
  const p = stationFeature && stationFeature.properties;
  if (!p || (!p.N02_002 && !p.N02_001)) return null;
  const mask = classifyN02SectionMask(p);
  if (mask & STAT_MASK_HSR) return "hsr";
  if (mask & STAT_MASK_METRO) return "metro";
  if (mask & STAT_MASK_JR) return "jr";
  return "priv";
}

function formatStatKm(km) {
  return Math.round(km).toLocaleString();
}
function formatStatPct(pct) {
  return pct > 0 && pct < 10 ? pct.toFixed(1) : String(Math.round(pct));
}

// ── Time-sliced stats job ───────────────────────────────────────────────────
// The UI recompute path: never blocks more than ~12 ms at a time. A newer
// schedule cancels an in-flight job via the token.
let _statsJobToken = 0;
// Yield one macrotask WITHOUT the background-tab timer clamp. setTimeout(0) is
// throttled to >= 1 s in hidden tabs, which stretched the chunked rail-sections
// parse (~85 yields) and the stats edge-index build (~170 yields) to MINUTES
// whenever the page loaded in a background tab or the user switched apps
// mid-load — extremely common on iPhone. MessageChannel messages are ordinary
// macrotasks (paint and input still interleave between slices) but are exempt
// from timer throttling, so hidden-tab loads run at full speed.
const _statsYield =
  typeof MessageChannel === "function"
    ? () =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            resolve();
          };
          channel.port2.postMessage(null);
        })
    : () => new Promise((resolve) => setTimeout(resolve, 0));

// The sliced index build is NEVER cancelled — it runs once, shared by every
// job via ensureStatsEdgeIndexAsync(). (An earlier version aborted on job
// supersession, so the constant renderAll stream during a progressive import
// restarted the build forever and the panel stayed blank until import ended.)
let _statsIndexBuild = null;
function ensureStatsEdgeIndexAsync() {
  if (_statsEdgeIndex) return Promise.resolve();
  if (!_statsIndexBuild)
    _statsIndexBuild = buildStatsEdgeIndexSliced().finally(() => {
      _statsIndexBuild = null; // allow retry if rail-sections weren't ready
    });
  return _statsIndexBuild;
}

async function buildStatsEdgeIndexSliced() {
  if (_statsEdgeIndex || !railSectionsGeoJson) return;
  const feats = railSectionsGeoJson.features;
  const map = new Map();
  const kmArr = [];
  const maskArr = [];
  // Per-line (N02_003) attribution for the coverage breakdown: each category row
  // expands into its member lines with each line's own ridden km, so a near-100%
  // aggregate is auditable line by line. Kept as parallel arrays (first feature
  // on an edge wins the line name); the ~550 distinct N02 line names make this
  // cheap. lineMaskArr keeps the NAMING feature's own category, so a station edge
  // shared with a Shinkansen doesn't file the conventional line under 新幹線.
  const lineArr = []; // edge index -> line name (N02_003), "" when unnamed
  const lineMaskArr = []; // edge index -> naming feature's own category mask
  let t0 = performance.now();
  for (let fi = 0; fi < feats.length; fi += 1) {
    const f = feats[fi];
    const coords = f.geometry && f.geometry.coordinates;
    if (!Array.isArray(coords)) continue;
    const props = f.properties || {};
    const mask = classifyN02SectionMask(props);
    const lineName = String(props.N02_003 || "");
    for (let i = 1; i < coords.length; i += 1) {
      const a = coords[i - 1];
      const b = coords[i];
      const key = statsEdgeKey(a, b);
      let ei = map.get(key);
      if (ei === undefined) {
        ei = kmArr.length;
        map.set(key, ei);
        kmArr.push(statsEdgeKm(a[0], a[1], b[0], b[1]));
        maskArr.push(mask);
        lineArr.push(lineName);
        lineMaskArr.push(lineName ? mask : 0);
      } else {
        maskArr[ei] |= mask;
        if (!lineArr[ei] && lineName) {
          lineArr[ei] = lineName;
          lineMaskArr[ei] = mask;
        }
      }
    }
    if ((fi & 127) === 127 && performance.now() - t0 > 12) {
      await _statsYield();
      t0 = performance.now();
    }
  }
  const totals = { all: 0, byMask: new Map(STAT_CATEGORIES.map((c) => [c.mask, 0])) };
  // line name -> per-category total km, so a line's breakdown row reflects ONLY
  // the track it has in that category (a through-running line's private km and
  // JR km stay apart, and the sub-rows reconcile with the category header).
  const lineTotByCat = new Map();
  for (let i = 0; i < kmArr.length; i += 1) {
    totals.all += kmArr[i];
    const km = kmArr[i];
    const m = maskArr[i];
    for (const c of STAT_CATEGORIES)
      if (m & c.mask) totals.byMask.set(c.mask, totals.byMask.get(c.mask) + km);
    const ln = lineArr[i];
    if (ln) {
      const lm = lineMaskArr[i];
      let o = lineTotByCat.get(ln);
      if (!o) lineTotByCat.set(ln, (o = statsZeroCatKm()));
      for (const c of STAT_CATEGORIES) if (lm & c.mask) o[c.mask] += km;
    }
  }
  _statsEdgeIndex = {
    map,
    km: kmArr,
    mask: maskArr,
    totals,
    lineArr,
    lineMaskArr,
    lineTotByCat,
  };
}

async function runMileageStatsJob() {
  const token = ++_statsJobToken;
  const headline = document.getElementById("stats-headline");
  const rows = document.getElementById("stats-rows");
  if (!headline || !rows) return;
  if (!railSectionsGeoJson) {
    headline.innerHTML = `<div class="stats-loading">${escapeHtml(I18N.t("stats.loading"))}</div>`;
    rows.innerHTML = "";
    ensureRailSectionsLoaded()
      .then(() => scheduleMileageStats())
      .catch(() => {});
    return;
  }
  if (!_statsEdgeIndex) {
    await ensureStatsEdgeIndexAsync();
    if (token !== _statsJobToken || !_statsEdgeIndex) return;
  }
  const idx = _statsEdgeIndex;
  pruneStatsTrainCache();
  const trains = trainStore.trains || [];
  const entries = [];
  let t0 = performance.now();
  for (const train of trains) {
    entries.push(collectTrainStatsEntry(train, idx));
    if (performance.now() - t0 > 12) {
      await _statsYield();
      if (token !== _statsJobToken) return; // superseded by a newer schedule
      t0 = performance.now();
    }
  }
  renderMileageStatsDom(buildMileageStatsView(idx, trains, entries));
}

// Per-line coverage rows shown indented under a category row: every line in that
// category the user has actually ridden (ridden km > 0), most-ridden first, with
// each line's own coverage %. Lets a near-100% aggregate be audited line by line
// (and a line spotted that shouldn't be covered). `open` renders the rows inline
// (used for 新幹線, only 8 lines); otherwise they go in a collapsed <details>
// since 在來線 / JR can list dozens. Empty until the edge index is built.
function categoryLineBreakdownHtml(s, categoryMask, open) {
  if (!s.lineTotByCat || !s.lineTotByCat.size) return "";
  const rows = [];
  s.lineTotByCat.forEach((tot, name) => {
    const t = tot[categoryMask] || 0;
    if (t <= 0) return;
    const rid = (s.lineRidByCat.get(name) || {})[categoryMask] || 0;
    if (rid > 0) rows.push([name, t, rid]);
  });
  if (!rows.length) return "";
  rows.sort((a, b) => b[2] - a[2]); // most-ridden first
  const body =
    `<div class="stat-subrows">` +
    rows
      .map(([name, tot, rid]) => {
        const pct = tot > 0 ? (100 * rid) / tot : 0;
        return `
        <div class="stat-subrow">
          <span class="stat-sublabel">${escapeHtml(name)}</span>
          <span class="stat-subval"><span class="stat-subpct">${formatStatPct(pct)}%</span><span class="stat-subkm">${formatStatKm(rid)} / ${formatStatKm(tot)} km</span></span>
        </div>`;
      })
      .join("") +
    `</div>`;
  if (open) return body;
  return `<details class="stat-lines"><summary class="stat-lines-summary">${escapeHtml(I18N.t("stats.byLine"))}（${rows.length}）</summary>${body}</details>`;
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
      <span class="stats-sub">${formatStatKm(s.riddenAll)} / ${formatStatKm(s.totals.all)} km · ${escapeHtml(I18N.t("stat.all"))}</span>
    </div>
    <div class="stats-track"><div class="stats-fill" style="width:${Math.min(100, pctAll).toFixed(2)}%"></div></div>`;
  const timeRow = `
      <div class="stat-row">
        <div class="stat-row-head">
          <span class="stat-label">${escapeHtml(I18N.t("stat.time"))}</span>
          <span class="stat-val"><span class="stat-pct">${escapeHtml(formatStatDuration(s.rideMinutes || 0))}</span></span>
        </div>
      </div>`;
  // ── Section 2: 路網覆蓋率 per category. The 新幹線 row expands into a
  //    per-line breakdown so a near-100% figure is auditable line by line.
  rows.innerHTML =
    STAT_CATEGORIES.map((c) => {
      const tot = s.totals.byMask.get(c.mask) || 0;
      const rid = s.riddenByMask.get(c.mask) || 0;
      const pct = tot > 0 ? (100 * rid) / tot : 0;
      const detail = categoryLineBreakdownHtml(s, c.mask, c.mask === STAT_MASK_HSR);
      return `
      <div class="stat-row">
        <div class="stat-row-head">
          <span class="stat-label">${escapeHtml(I18N.t(c.i18n))}</span>
          <span class="stat-val"><span class="stat-pct">${formatStatPct(pct)}%</span><span class="stat-km">${formatStatKm(rid)} / ${formatStatKm(tot)} km</span></span>
        </div>
        <div class="stats-track"><div class="stats-fill" style="width:${Math.min(100, pct).toFixed(2)}%"></div></div>
        ${detail}
      </div>`;
    }).join("") +
    `<div class="divider"></div>
     <h3 class="subhead">${escapeHtml(I18N.t("stats.actualTitle"))}</h3>` +
    serviceRowsHtml(s.services) +
    timeRow;
}

// 有料特急 / 其他列車 rows: cumulative distance + time + ride count for each
// service group — deliberately NO percentage / progress bar (repeat rides
// count each time, so there is no meaningful denominator).
function serviceRowsHtml(services) {
  if (!services) return "";
  const row = (labelKey, g) => `
      <div class="stat-row">
        <div class="stat-row-head">
          <span class="stat-label">${escapeHtml(I18N.t(labelKey))}</span>
          <span class="stat-val"><span class="stat-km">${formatStatKm(g.km)} km · ${escapeHtml(formatStatDuration(g.minutes))} · ${escapeHtml(I18N.t("stat.trains", { n: g.count }))}</span></span>
        </div>
      </div>`;
  return (
    row("stat.hsr", services.hsr) +
    row("stat.ltdexp", services.ltd) +
    row("stat.othertrains", services.other)
  );
}

// Debounced: renderAll fires on every store mutation; the time-sliced job
// re-runs once things settle. Per-train caching means an unchanged train
// costs one signature check, so a full refresh is a few ms of merged Sets.
// The mileage-stats panel lives entirely inside its own workspace tab. When
// that tab is hidden there is nothing to show, so the job is skipped — which is
// what keeps the 12 MB rail-sections parse (runMileageStatsJob lazy-loads it)
// OFF the boot path on the static/iPhone deploy, whose default tab is the 列車
// list. setActiveWorkspaceTab() re-schedules the moment the 統計 tab is opened,
// and renderAll() keeps it live while it stays open.
function mileageStatsTabActive() {
  const card = document.getElementById("mileage-stats");
  return Boolean(card) && !card.classList.contains("tab-hidden");
}
let _statsRenderTimer = null;
function scheduleMileageStats() {
  if (!mileageStatsTabActive()) return;
  if (_statsRenderTimer) clearTimeout(_statsRenderTimer);
  _statsRenderTimer = setTimeout(() => {
    _statsRenderTimer = null;
    runMileageStatsJob().catch((err) =>
      console.warn("mileage stats job failed", err),
    );
  }, 400);
}

