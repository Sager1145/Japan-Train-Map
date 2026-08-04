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
//   路面電車 = 軌道 classes 21/22 that are NOT run by a metro operator
//   私鐵     = codes 4+5 minus the metro operators and minus the trams above
const STAT_MASK_HSR = 1;
const STAT_MASK_CONV = 2;
const STAT_MASK_JR = 4;
const STAT_MASK_METRO = 8;
const STAT_MASK_PRIV = 16;
const STAT_MASK_TRAM = 32;
const STAT_CATEGORIES = [
  { mask: STAT_MASK_HSR, i18n: "stat.hsr" },
  { mask: STAT_MASK_CONV, i18n: "stat.conv" },
  { mask: STAT_MASK_JR, i18n: "stat.jr" },
  { mask: STAT_MASK_METRO, i18n: "stat.metro" },
  { mask: STAT_MASK_PRIV, i18n: "stat.priv" },
  { mask: STAT_MASK_TRAM, i18n: "stat.tram" },
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
// Only class 21 (軌道) is a street tram. Class 22 is a SUSPENDED MONORAIL built
// under the same 軌道法 — 千葉都市モノレール is its only holder in N02, and it
// belongs with the other monorails in 私鐵・第三部門, not with the trams.
const TRAM_RAILWAY_CLASSES = new Set(["21"]);
// Heavy-rail lines that happen to be licensed under 軌道法 (class 21) but are
// nothing like a street tram: full-size trains, mostly through-services onto
// subways. Without this they would all be counted as 路面電車.
const TRAM_CLASS_HEAVY_RAIL_LINES = new Set([
  "北大阪急行電鉄|南北線", // through-service with Osaka Metro 御堂筋線
  "近畿日本鉄道|けいはんな線", // through-service with Osaka Metro 中央線
  "名古屋鉄道|豊川線", // ordinary 名鉄 line, 軌道法 only for historic reasons
]);

// The coverage masks deliberately OVERLAP (JR is the union of 新幹線 + JR在來線,
// and 普通鐵道 means "everything that is not 新幹線"), which is right for
// percentages but wrong for asking "what kind of track is this section?".
// This collapses an edge's mask to exactly ONE bucket, most specific first, so
// a section can be attributed to a single mode.
function exclusiveTrackBucket(mask) {
  if (mask & STAT_MASK_HSR) return STAT_MASK_HSR;
  if (mask & STAT_MASK_METRO) return STAT_MASK_METRO;
  if (mask & STAT_MASK_TRAM) return STAT_MASK_TRAM;
  if (mask & STAT_MASK_PRIV) return STAT_MASK_PRIV;
  return STAT_MASK_CONV; // JR 在來線 (and any unclassified conventional track)
}

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
  // 路面電車 is its own category: every 軌道 line that is not one of the metro
  // operators' (Osaka Metro's subways are legally 軌道 too). Trams are then
  // held OUT of 私鐵・第三部門 so the two rows do not double-count each other.
  const isTram =
    TRAM_RAILWAY_CLASSES.has(cls) &&
    !isMetro &&
    !TRAM_CLASS_HEAVY_RAIL_LINES.has(`${op}|${props.N02_003 || ""}`);
  if (isTram) mask |= STAT_MASK_TRAM;
  if ((code === "4" || code === "5") && !isMetro && !isTram)
    mask |= STAT_MASK_PRIV;
  return mask;
}

// ── Mini-Shinkansen reclassification (§23a-mini) ─────────────────────────────
// 山形新幹線 / 秋田新幹線 run on gauge-converted track that N02-25 STILL files as
// 在来線 (N02_002 = "2") under the plain line names 奥羽線 / 田沢湖線 — there is no
// Shinkansen attribute to key on. 博多南線 is the same story (Shinkansen rolling
// stock on a line N02 files as 在来線). Track that ONLY carries Shinkansen must
// count as 新幹線 and NOT as 在来線, or the 新幹線 denominator reads ~8 points high
// (~285 km missing) and these lines can never appear in the breakdown.
//
// A corridor edge is MOVED (not copied): its 在来線 bit is cleared and its 新幹線
// bit set — the JR全線 bit is left intact (it is still JR track). Whole-line
// corridors match by N02_003 name; the two 奥羽線 sub-corridors are traced along
// the 奥羽線 subgraph between their gauge-conversion endpoints.
// NOTE: the ~1.8 km 越後湯沢–ガーラ湯沢 spur (Shinkansen-only, filed under 上越線)
// is deliberately NOT reclassified — it has no separable N02 section geometry
// and is unridden; add it here as a corridor if it ever needs to show.
const HSR_RECLASSIFY_FULL_LINES = new Map([
  ["田沢湖線", "秋田新幹線"], // 盛岡–大曲, ~75.6 km (whole line)
  ["博多南線", "博多南線"], // 博多–博多南, ~8.9 km (label kept, category → 新幹線)
]);
const HSR_RECLASSIFY_OU_LINE = "奥羽線";
const HSR_RECLASSIFY_OU_CORRIDORS = [
  // 山形新幹線: 奥羽線 福島(001373) – 新庄(001004), ~148.6 km
  { display: "山形新幹線", from: [140.45972, 37.75341], to: [140.3059, 38.76386] },
  // 秋田新幹線: 奥羽線 大曲(000854) – 秋田(000783), ~51.7 km (盛岡–大曲 is 田沢湖線)
  { display: "秋田新幹線", from: [140.47996, 39.46546], to: [140.12947, 39.71836] },
];

// Tuple min-heap for the corridor trace: AppCore's shared [priority, value]
// heap (the route solver keeps its own object-shaped heap — different API).
const StatsMinHeap = window.AppCore.TupleMinHeap;

// N02 5-decimal grid + shared geometry primitives. AppCore (app-core.js) is
// the single owner of the grid rule: N02 mixes 5-decimal and full-precision
// 8-decimal vertices (e.g. 北陸新幹線), and the route solver's graph, the deck
// segment keys and the build-time station expansion all quantize through the
// same functions — so edge keys here match ridden-route geometry byte for
// byte. Local aliases keep the hot loops' call sites short.
const statsQuant = window.AppCore.quant5;
const statsNodeKey = window.AppCore.coordKey5;
const statsEdgeKey = window.AppCore.edgeKey5;
const statsEdgeKm = window.AppCore.equirectKm;

// Nearest subgraph node to an endpoint (station) coordinate, so a corridor snaps
// onto its line even when the station point isn't itself a graph vertex. Returns
// the node key, or null when the subgraph is empty.
function snapToNearestStatsNode(coord, nodeXY) {
  const x = statsQuant(coord[0]);
  const y = statsQuant(coord[1]);
  let best = null;
  let bestKm = Infinity;
  nodeXY.forEach(([nx, ny], key) => {
    const d = statsEdgeKm(x, y, nx, ny);
    if (d < bestKm) {
      bestKm = d;
      best = key;
    }
  });
  return best;
}

// Dijkstra shortest path between two nodes of a single-line subgraph, returned as
// the Set of edge indices it traverses. adj: node key -> [[neighborKey, edgeIdx]].
function traceStatsCorridorEdges(adj, kmArr, fromKey, toKey) {
  const edges = new Set();
  if (fromKey === toKey || !adj.has(fromKey) || !adj.has(toKey)) return edges;
  const dist = new Map([[fromKey, 0]]);
  const prev = new Map(); // node key -> [prevKey, edge index]
  const heap = new StatsMinHeap();
  heap.push(0, fromKey);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (u === toKey) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const [v, ei] of adj.get(u) || []) {
      const nd = d + kmArr[ei];
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, [u, ei]);
        heap.push(nd, v);
      }
    }
  }
  let cur = toKey;
  while (prev.has(cur)) {
    const [p, ei] = prev.get(cur);
    edges.add(ei);
    cur = p;
  }
  return edges;
}

// Zero km accumulator keyed by category mask, for per-line-per-category sums.
function statsZeroCatKm() {
  const o = {};
  for (const c of STAT_CATEGORIES) o[c.mask] = 0;
  return o;
}

// (statsQuant / statsNodeKey / statsEdgeKey / statsEdgeKm are aliases of the
// AppCore grid primitives — declared above, next to StatsMinHeap.)

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
  // `segments` is part of the cached shape, so an entry cached by an older
  // build (no segments) is treated as a miss and rebuilt.
  if (cached && cached.sig === sig && cached.segments !== undefined)
    return cached;
  const edges = [];
  const spans = []; // [spanKey, km, mask]
  // One record per matched route feature = one station-to-station ridden
  // interval, which is the unit the 最常乘坐區間 section counts.
  const segments = []; // [{ from, to, km, mask }]
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
    // Remember where this feature's contribution starts so its own km and
    // category mask can be summed back out of the shared accumulators.
    const edgeStart = edges.length;
    const spanStart = spans.length;
    if (f.geometry.type === "LineString") walk(f.geometry.coordinates);
    else if (f.geometry.type === "MultiLineString")
      f.geometry.coordinates.forEach(walk);
    const from = f.properties.from;
    const to = f.properties.to;
    if (from && to && from !== to) {
      let segKm = 0;
      // Attribute the section to the mode carrying the MOST of its distance.
      // OR-ing every edge's mask instead would file a JR section under 私鐵 and
      // 地下鐵 the moment its geometry clipped one parallel edge in a dense
      // terminal area — which is exactly what it used to do.
      const kmByBucket = new Map();
      const addKm = (mask, km) => {
        const b = exclusiveTrackBucket(mask);
        kmByBucket.set(b, (kmByBucket.get(b) || 0) + km);
      };
      for (let i = edgeStart; i < edges.length; i += 1) {
        segKm += idx.km[edges[i]];
        addKm(idx.mask[edges[i]], idx.km[edges[i]]);
      }
      for (let i = spanStart; i < spans.length; i += 1) {
        segKm += spans[i][1];
        if (spans[i][2]) addKm(spans[i][2], spans[i][1]);
      }
      let bucket = 0;
      let bestKm = -1;
      for (const [b, km] of kmByBucket) {
        if (km > bestKm) {
          bestKm = km;
          bucket = b;
        }
      }
      // The edges this interval actually covers, sorted so containment can be
      // tested as a set-subset later (see dropContainedSections). Edge ids are
      // the unit of "same track": two intervals that share none cannot contain
      // one another, which is what keeps 新幹線 from swallowing the 在來線
      // running beside it.
      const segEdges = edges.slice(edgeStart).sort((a, b) => a - b);
      segments.push({ from, to, km: segKm, bucket, edgeIds: segEdges });
    }
  }
  // This train's OWN cumulative ridden distance (repeat segments count each
  // time — it pairs with ride time / ride count in the service-type rows,
  // unlike the deduped network-coverage sums).
  let km = 0;
  for (const e of edges) km += idx.km[e];
  for (const [, spanKm] of spans) km += spanKm;
  const entry = { sig, edges, spans, km, segments };
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
    lineOperator: idx.lineOperator,
  };
}

// Ride TIME of one train: first effectively-ridden stopping station's
// departure -> last one's arrival (falling back to the other field when one
// is missing; "+1" day offsets are handled by parseTimeToMinutes, and a plain
// end-before-start wraps overnight). null = no usable times.
function trainRideMinutes(train) {
  const stops = train.stops || [];
  const ridden = effectivelyRiddenStopIndexes(stops);
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
function topRiddenSegments(entries) {
  const acc = new Map(); // key -> { from, to, count, km, mask }
  for (const en of entries) {
    for (const sg of en.segments || []) {
      const pair = [sg.from, sg.to];
      const key = pair.slice().sort().join("\u0000");
      const cur = acc.get(key);
      if (cur) {
        cur.count += 1;
        // Keep the longest measurement: a partially-solved repeat ride must
        // not shrink the section's recorded length.
        if (sg.km > cur.km) {
          cur.km = sg.km;
          cur.bucket = sg.bucket; // the best-measured ride also decides the mode
          cur.edgeIds = sg.edgeIds; // …and its edges define the section's extent
        }
      } else {
        acc.set(key, {
          from: sg.from,
          to: sg.to,
          count: 1,
          km: sg.km,
          bucket: sg.bucket,
          edgeIds: sg.edgeIds,
        });
      }
    }
  }
  const byMask = new Map(STAT_CATEGORIES.map((c) => [c.mask, []]));
  const all = [];
  for (const row of acc.values()) {
    all.push(row);
    // One section lands in exactly one mode row.
    if (byMask.has(row.bucket)) byMask.get(row.bucket).push(row);
  }
  const byRides = (a, b) => b.count - a.count || b.km - a.km;
  for (const [mask, rows] of byMask) {
    rows.sort(byRides);
    byMask.set(mask, dropContainedSections(rows));
  }
  all.sort(byRides);
  return { byMask, all: dropContainedSections(all) };
}

// True when every edge of `inner` also appears in `outer` — i.e. `inner` is a
// stretch of the very same track. Both arrays are sorted ascending, so this is
// a linear merge rather than a Set build per comparison.
function isEdgeSubset(inner, outer) {
  if (!inner || !outer || !inner.length || inner.length > outer.length)
    return false;
  let j = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const want = inner[i];
    while (j < outer.length && outer[j] < want) j += 1;
    if (j >= outer.length || outer[j] !== want) return false;
    j += 1;
  }
  return true;
}

// Riding A→D necessarily rides B→C inside it, so listing both says the same
// trip twice. Walking the already ride-sorted list and dropping any section
// contained in one ALREADY KEPT means the longer section wins only when it is
// ridden at least as often; a short section ridden more than the long one it
// sits inside still ranks first and keeps the long one as a separate entry.
// The bucket check is belt-and-braces on top of the edge test: sections of
// different modes never share edges anyway.
function dropContainedSections(rows) {
  const kept = [];
  for (const row of rows) {
    let contained = false;
    for (const k of kept) {
      if (k.bucket === row.bucket && isEdgeSubset(row.edgeIds, k.edgeIds)) {
        contained = true;
        break;
      }
    }
    if (!contained) kept.push(row);
  }
  return kept;
}

// View model shared by the sync path and the time-sliced job: the all-time
// aggregate plus (when a concrete date bucket is active) that day's own
// km/time aggregate, computed from the SAME per-train cache entries.
function buildMileageStatsView(idx, trains, entries) {
  const overall = aggregateMileageStats(idx, entries);
  overall.rideMinutes = sumRideMinutes(trains);
  overall.services = serviceGroupStats(trains, entries);
  overall.topSegments = topRiddenSegments(entries);
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
  // Operator (N02_004) of the SAME naming feature, so the per-line breakdown can
  // be grouped by company. A mini-Shinkansen corridor keeps its source line's
  // operator (奥羽線/田沢湖線 = JR東日本, 博多南線 = JR西日本), which is correct.
  const lineOpArr = []; // edge index -> naming feature's operator
  // Mini-Shinkansen reclassification accumulators (applied after the full pass):
  // whole-line corridors collect their edge indices; the two 奥羽線 sub-corridors
  // collect a subgraph to trace along afterwards. Every edge is recorded against
  // the CURRENT feature's line name (not the first-wins lineArr), so a corridor
  // edge co-located with another line is still captured.
  const hsrFullHits = new Map(); // display line -> Set<edge index>
  for (const disp of HSR_RECLASSIFY_FULL_LINES.values())
    if (!hsrFullHits.has(disp)) hsrFullHits.set(disp, new Set());
  const ouAdj = new Map(); // 奥羽線 node key -> [[neighborKey, edge index]]
  const ouNodeXY = new Map(); // 奥羽線 node key -> [x, y] for endpoint snapping
  let t0 = performance.now();
  for (let fi = 0; fi < feats.length; fi += 1) {
    const f = feats[fi];
    const coords = f.geometry && f.geometry.coordinates;
    if (!Array.isArray(coords)) continue;
    const props = f.properties || {};
    const mask = classifyN02SectionMask(props);
    const lineName = String(props.N02_003 || "");
    const operatorName = String(props.N02_004 || "");
    const fullReclass = HSR_RECLASSIFY_FULL_LINES.get(lineName) || null;
    const isOuLine = lineName === HSR_RECLASSIFY_OU_LINE;
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
        lineOpArr.push(lineName ? operatorName : "");
      } else {
        maskArr[ei] |= mask;
        if (!lineArr[ei] && lineName) {
          lineArr[ei] = lineName;
          lineMaskArr[ei] = mask;
          lineOpArr[ei] = operatorName;
        }
      }
      if (fullReclass) {
        hsrFullHits.get(fullReclass).add(ei);
      } else if (isOuLine) {
        const ka = statsNodeKey(a);
        const kb = statsNodeKey(b);
        if (!ouNodeXY.has(ka))
          ouNodeXY.set(ka, [statsQuant(a[0]), statsQuant(a[1])]);
        if (!ouNodeXY.has(kb))
          ouNodeXY.set(kb, [statsQuant(b[0]), statsQuant(b[1])]);
        let la = ouAdj.get(ka);
        if (!la) ouAdj.set(ka, (la = []));
        let lb = ouAdj.get(kb);
        if (!lb) ouAdj.set(kb, (lb = []));
        la.push([kb, ei]);
        lb.push([ka, ei]);
      }
    }
    if ((fi & 127) === 127 && performance.now() - t0 > 12) {
      await _statsYield();
      t0 = performance.now();
    }
  }
  // Apply the mini-Shinkansen reclassification BEFORE totals are summed, so the
  // 新幹線 / 在來線 denominators and the per-line breakdown all reflect it. Each
  // corridor edge moves out of 在來線 into 新幹線 (JR全線 bit left intact) and is
  // relabeled so it files under its Shinkansen name.
  const applyHsrCorridorOverride = (ei, display) => {
    maskArr[ei] = (maskArr[ei] & ~STAT_MASK_CONV) | STAT_MASK_HSR;
    lineArr[ei] = display;
    lineMaskArr[ei] = STAT_MASK_HSR | STAT_MASK_JR;
  };
  try {
    hsrFullHits.forEach((set, display) =>
      set.forEach((ei) => applyHsrCorridorOverride(ei, display)),
    );
    for (const corr of HSR_RECLASSIFY_OU_CORRIDORS) {
      const from = snapToNearestStatsNode(corr.from, ouNodeXY);
      const to = snapToNearestStatsNode(corr.to, ouNodeXY);
      if (!from || !to) continue;
      const corridorEdges = traceStatsCorridorEdges(ouAdj, kmArr, from, to);
      corridorEdges.forEach((ei) => applyHsrCorridorOverride(ei, corr.display));
    }
  } catch (err) {
    // A tracing hiccup must never blank the panel — worst case the two 奥羽線
    // corridors stay filed under 在來線 (the pre-fix behavior).
    console.warn("mini-Shinkansen corridor reclassification skipped:", err);
  }
  const totals = { all: 0, byMask: new Map(STAT_CATEGORIES.map((c) => [c.mask, 0])) };
  // line name -> per-category total km, so a line's breakdown row reflects ONLY
  // the track it has in that category (a through-running line's private km and
  // JR km stay apart, and the sub-rows reconcile with the category header).
  const lineTotByCat = new Map();
  // line name -> operator -> km. The company shown for a line is the one owning
  // the MOST of its track, not whichever edge happened to be indexed first: a
  // line shares the odd edge with another operator at a joint station (e.g. the
  // 山形新幹線 corridor touches 山形鉄道 track), and first-wins let that one edge
  // label the whole line with the wrong company.
  const lineOpKm = new Map();
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
      const op = lineOpArr[i];
      if (op) {
        let byOp = lineOpKm.get(ln);
        if (!byOp) lineOpKm.set(ln, (byOp = new Map()));
        byOp.set(op, (byOp.get(op) || 0) + km);
      }
    }
  }
  // Resolve each line to its majority-km operator.
  const lineOperator = new Map();
  lineOpKm.forEach((byOp, ln) => {
    let best = "";
    let bestKm = -1;
    byOp.forEach((v, op) => {
      if (v > bestKm) {
        bestKm = v;
        best = op;
      }
    });
    if (best) lineOperator.set(ln, best);
  });
  _statsEdgeIndex = {
    map,
    km: kmArr,
    mask: maskArr,
    totals,
    lineArr,
    lineMaskArr,
    lineTotByCat,
    lineOperator,
  };
}

async function runMileageStatsJob() {
  const token = ++_statsJobToken;
  const headline = document.getElementById("stats-headline");
  const rows = document.getElementById("stats-rows");
  if (!headline || !rows) return;
  // The coverage graph is built from the Japan-only N02 datasets; for any
  // other active country say so instead of downloading the 12 MB
  // rail-sections file to compute a meaningless all-zero table.
  if (!activeCountryHasRouteSolver()) {
    headline.innerHTML = `<div class="stats-loading">${escapeHtml(I18N.t("stats.unavailableCountry"))}</div>`;
    rows.innerHTML = "";
    return;
  }
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
  // ── Section 2: 路網覆蓋率 per category. Every row expands into a per-line
  //    breakdown (依線路 button) so a near-100% figure is auditable line by
  //    line; 新幹線 and 地下鐵 list all member lines including unridden ones.
  rows.innerHTML =
    STAT_CATEGORIES.map((c) => {
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
          <span class="stat-label">${escapeHtml(I18N.t(c.i18n))}</span>
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

