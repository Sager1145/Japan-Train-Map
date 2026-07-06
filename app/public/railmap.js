/*
 * railmap.js — MapLibre GL map core, styled after yzhouwang/railprint.
 *
 * This module is a faithful port of railprint's map styling stack
 * (src/design/tokens.ts + src/lib/map/basemap.ts + src/lib/map/style.ts +
 * src/lib/map/popup.ts) into a dependency-free browser script:
 *
 *   - BASEMAP: OpenFreeMap `positron` vector style, VENDORED same-origin at
 *     ./basemap/positron.json (only tiles/glyphs/sprite come from
 *     tiles.openfreemap.org at runtime). Offline / fetch failure => the rail
 *     renders over a plain background (railprint's graceful degradation);
 *     the pre-downloaded raster tiles in ./tiles remain available as a
 *     selectable fallback basemap.
 *   - NETWORK: the full MLIT N02 national network from railprint's rail
 *     package (./rail/jp-2025.json — 594 lines in official color, 9,442
 *     segments, 10,034 stations). Drawn exactly like railprint's "unridden"
 *     field: each line in its official color at 0.48 opacity, thin, with
 *     zoom-tiered reveal (rank -> minzoom) — and station dots in neutral
 *     grey revealed by average inter-station spacing.
 *   - TRAINS ("ridden"): full-color thick lines (the glow underlay was
 *     removed by request); the selected train gets a dark ink casing
 *     underlay + white-fill/ink-ring station dots (railprint C3 selection
 *     treatment).
 *   - HOVER: hovering a network station opens railprint's C5 bilingual popup
 *     listing every line through the physical station (logo or color swatch
 *     + line name + short company label).
 *
 * The public API mirrors the old deck.gl overlay manager (attach / setData /
 * setMarkers / setSelected / setVisible / setMarkerVisibility) so the app's
 * record-building pipeline plugs in unchanged.
 */
(function (global) {
  "use strict";

  // ───────────────────────── design tokens (railprint tokens.ts) ─────────────────────────
  const tokens = {
    railLit: "#00A040",
    railText: "#006B2D",
    railDim: "#D7DEDA", // unridden network lines + unridden station dots
    railBg: "#EAF4EE",
    ink: "#1A1A1A", // primary text / selection casing / ridden station dots
    inkMuted: "#6B756F",
    white: "#FFFFFF",
  };
  // Line treatment (railprint DESIGN.md glowing-line spec).
  const stroke = { ridden: 4, unridden: 2 };
  const DEFAULT_LINE_COLOR = "#7C8A82";

  const BASEMAP_ATTRIBUTION = "© OpenStreetMap contributors｜OpenFreeMap";
  const RAIL_ATTRIBUTION =
    "出典「国土数値情報（鉄道データ N02）」（国土交通省）を加工して作成 (CC BY 4.0)";
  const ROMAJI_ATTRIBUTION = "Romanizations © OpenStreetMap contributors, ODbL";

  // ───────────────────────── C9 zoom-tiered LOD (railprint style.ts) ─────────────────────
  // rank 0 Shinkansen … 4 minor -> reveal zoom. Lines with no rank ⇒ always visible.
  const RANK_MINZOOM = [3, 4, 5, 6, 7];
  function minzForRank(rank) {
    return rank == null ? 0 : RANK_MINZOOM[rank] != null ? RANK_MINZOOM[rank] : 0;
  }
  // C9b — station dot LOD by average spacing: a dot reveals once adjacent dots
  // would clear ~22px on screen (web-mercator at ~lat 35°).
  const STATION_DOT_GAP_PX = 22;
  const STATION_LOD_K =
    (STATION_DOT_GAP_PX * 40075.017) / (256 * Math.cos((35 * Math.PI) / 180));
  const STATION_MINZ_CAP = 14;
  function stationMinzForLine(lineMinz, totalKm, stationCount) {
    if (stationCount < 2 || totalKm <= 0) return lineMinz;
    const avgSpacingKm = totalKm / (stationCount - 1);
    const byDensity = Math.round(Math.log2(STATION_LOD_K / avgSpacingKm));
    return Math.min(STATION_MINZ_CAP, Math.max(lineMinz, byDensity));
  }

  // ───────────────────── ridden/unridden paint constants (style.ts) ──────────────────────
  const UNRIDDEN_OPACITY = 0.48;
  const RIDDEN_WIDTH_SCALE = 1.18;
  const UNRIDDEN_WIDTH_SCALE = 0.65;
  const CASING_COLOR = tokens.ink;

  // Zoom-scaled width for a per-feature base width `w` (px at z9), matching
  // railprint's interpolate stops: ×0.6 at z4, ×1 at z9, ×1.6 at z14.
  function zoomScaledWidth(wExpr) {
    return [
      "interpolate",
      ["linear"],
      ["zoom"],
      4,
      ["*", wExpr, 0.6],
      9,
      wExpr,
      14,
      ["*", wExpr, 1.6],
    ];
  }

  // ───────────────────────────── basemap loader (basemap.ts) ─────────────────────────────
  const LOAD_TIMEOUT_MS = 8000;

  function normalizeBasemap(raw) {
    if (typeof raw !== "object" || raw === null) return null;
    const sources = raw.sources;
    const layers = raw.layers;
    if (typeof sources !== "object" || sources === null || !Array.isArray(layers))
      return null;
    const stamped = {};
    for (const id of Object.keys(sources)) {
      stamped[id] = Object.assign({}, sources[id], {
        attribution: sources[id].attribution || BASEMAP_ATTRIBUTION,
      });
    }
    const out = { sources: stamped, layers };
    if (typeof raw.glyphs === "string") out.glyphs = raw.glyphs;
    if (typeof raw.sprite === "string") out.sprite = raw.sprite;
    return out;
  }

  async function loadBasemap() {
    // Offline ⇒ basemap-less on purpose (the vector tile fetches would all fail).
    if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), LOAD_TIMEOUT_MS) : null;
    try {
      const res = await fetch("./basemap/positron.json", ctl ? { signal: ctl.signal } : undefined);
      if (!res.ok) return null;
      return normalizeBasemap(await res.json());
    } catch (e) {
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  // ───────────────────────────── rail package loader ─────────────────────────────
  // Loads railprint's jp-2025 RailGeoPackage and builds the two GeoJSON
  // collections + the geo index the hover popup needs (buildSegmentCollection /
  // buildStationCollection / geo-index, ported).
  async function loadNetwork() {
    try {
      const res = await fetch("./rail/jp-2025.json");
      if (!res.ok) return null;
      const pkg = await res.json();
      if (!pkg || !Array.isArray(pkg.lines)) return null;

      const lineById = new Map();
      const colorByLine = new Map();
      const lineMinzByLine = new Map();
      for (const l of pkg.lines) {
        lineById.set(l.lineId, l);
        colorByLine.set(l.lineId, l.color || DEFAULT_LINE_COLOR);
        lineMinzByLine.set(l.lineId, minzForRank(l.rank));
      }

      // Segments — one LineString per RailSegment, static official `color` + `minz`.
      const segFeatures = pkg.segments.map((seg) => ({
        type: "Feature",
        geometry: seg.geometry,
        properties: {
          segmentId: seg.segmentId,
          lineId: seg.lineId,
          color: colorByLine.get(seg.lineId) || DEFAULT_LINE_COLOR,
          minz: lineMinzByLine.get(seg.lineId) || 0,
        },
      }));

      // Per line: total km, spacing-derived dot reveal zoom, termini (anchor at line zoom).
      const kmByLine = new Map();
      for (const s of pkg.segments)
        kmByLine.set(s.lineId, (kmByLine.get(s.lineId) || 0) + s.km);
      const dotMinzByLine = new Map();
      const terminiByLine = new Map();
      for (const l of pkg.lines) {
        const lineMinz = lineMinzByLine.get(l.lineId) || 0;
        const n = (l.stationOrder || []).length;
        dotMinzByLine.set(
          l.lineId,
          stationMinzForLine(lineMinz, kmByLine.get(l.lineId) || 0, n),
        );
        if (!l.isLoop && n >= 2)
          terminiByLine.set(
            l.lineId,
            new Set([l.stationOrder[0], l.stationOrder[n - 1]]),
          );
      }

      const stationById = new Map();
      const groupMembers = new Map(); // groupKey -> [station, ...]
      const stFeatures = pkg.stations.map((st) => {
        stationById.set(st.stationId, st);
        const gk = st.stationGroupId || "solo:" + st.stationId;
        let arr = groupMembers.get(gk);
        if (!arr) groupMembers.set(gk, (arr = []));
        arr.push(st);
        const term = terminiByLine.get(st.lineId);
        const minz =
          term && term.has(st.stationId)
            ? lineMinzByLine.get(st.lineId) || 0
            : dotMinzByLine.get(st.lineId) || 0;
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [st.lon, st.lat] },
          properties: {
            stationId: st.stationId,
            lineId: st.lineId,
            name: st.name,
            nameRoma: st.nameRoma || "",
            stationGroupId: st.stationGroupId || "",
            minz,
          },
        };
      });

      return {
        version: pkg.version,
        segments: { type: "FeatureCollection", features: segFeatures },
        stations: { type: "FeatureCollection", features: stFeatures },
        lineById,
        stationById,
        groupMembers,
      };
    } catch (e) {
      console.warn("[railmap] rail package unavailable:", e);
      return null;
    }
  }

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
  function popupHtml(model) {
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
    return (
      '<div class="rp-popup"><div class="rp-popup-head">' +
      header +
      "</div>" +
      (rows ? '<ul class="rp-line-list">' + rows + "</ul>" : "") +
      "</div>"
    );
  }

  // ───────────────────────────── source / layer ids ─────────────────────────────
  const SEGMENTS_SOURCE = "rn-segments";
  const STATIONS_SOURCE = "rn-stations";
  const SEGMENTS_LAYER = "rn-segments-line";
  const STATIONS_LAYER = "rn-stations-dot";
  const FADE_LAYER = "rp-fade";
  const LOCAL_RASTER_SOURCE = "local-raster";
  const LOCAL_RASTER_LAYER = "local-raster-layer";
  const TRAIN_ROUTES_SOURCE = "train-routes";
  const TRAIN_MARKERS_SOURCE = "train-markers-base";
  const TRAIN_MARKERS_SEL_SOURCE = "train-markers-sel";
  const TRAIN_ROUTES_LAYER = "train-routes-line";
  const TRAIN_HOVER_LAYER = "train-routes-hover";
  const TRAIN_SEL_CASING_LAYER = "train-routes-sel-casing";
  const TRAIN_SEL_LAYER = "train-routes-sel";
  const TRAIN_PASS_LAYER = "train-pass-dot";
  const TRAIN_STOPS_LAYER = "train-stops-dot";
  const TRAIN_SEL_PASS_LAYER = "train-sel-pass-dot";
  const TRAIN_SEL_STOPS_LAYER = "train-sel-stops-dot";

  const EMPTY_FC = { type: "FeatureCollection", features: [] };
  const NO_TRAIN = "__none__";

  // Marker circle paint shared by the four dot layers: per-feature fill/stroke
  // (precomputed rgba strings) + railprint's zoom-scaled radius (r at z12,
  // ×~0.48 at z5 — matching stationRadiusExpression's 2.4/5 & 1.4/3 ratios).
  function markerCirclePaint() {
    return {
      "circle-color": ["get", "fill"],
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        5,
        ["*", ["get", "radius"], 0.48],
        12,
        ["get", "radius"],
      ],
      "circle-stroke-color": ["get", "stroke"],
      "circle-stroke-width": ["get", "lineWidth"],
      "circle-pitch-alignment": "map",
    };
  }

  // ───────────────────────────── the base style (style.ts buildBaseStyle) ────────────────
  function buildBaseStyle(opts) {
    const basemap = opts.basemap || null;
    const network = opts.network || null;
    const fadeOpacity = Math.max(0, Math.min(1, Number(opts.fadeOpacity || 0)));

    const sources = Object.assign({}, basemap ? basemap.sources : {});
    // Pre-downloaded CARTO raster tiles: the offline fallback basemap. Present
    // in the style either way; visible only when the vector basemap is absent
    // (or the user picks it in the basemap control).
    sources[LOCAL_RASTER_SOURCE] = {
      type: "raster",
      tiles: [location.href.replace(/[^/]*$/, "") + "tiles/{z}/{x}/{y}.png"],
      tileSize: 256,
      minzoom: 4,
      maxzoom: 12,
      attribution: "Offline tiles © OpenStreetMap contributors © CARTO",
    };
    sources[SEGMENTS_SOURCE] = {
      type: "geojson",
      data: network ? network.segments : EMPTY_FC,
      attribution: RAIL_ATTRIBUTION + "｜" + ROMAJI_ATTRIBUTION,
    };
    sources[STATIONS_SOURCE] = {
      type: "geojson",
      data: network ? network.stations : EMPTY_FC,
    };
    sources[TRAIN_ROUTES_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[TRAIN_MARKERS_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[TRAIN_MARKERS_SEL_SOURCE] = { type: "geojson", data: EMPTY_FC };

    const layers = [];
    // Plain background — also railprint's offline degradation surface.
    layers.push({
      id: "rp-bg",
      type: "background",
      paint: { "background-color": "rgb(242,243,240)" },
    });
    layers.push({
      id: LOCAL_RASTER_LAYER,
      type: "raster",
      source: LOCAL_RASTER_SOURCE,
      layout: { visibility: basemap ? "none" : "visible" },
      paint: { "raster-opacity": 1 },
    });
    // The positron layer stack splits around its FIRST symbol (label) layer:
    // the national-network layers slot in between, so the network draws above
    // the basemap's land/water/roads but UNDER every place/city label (and
    // under all train layers, which come later still).
    const bmLayers = basemap ? basemap.layers : [];
    let firstSymbol = bmLayers.findIndex((l) => l && l.type === "symbol");
    if (firstSymbol < 0) firstSymbol = bmLayers.length;
    layers.push(...bmLayers.slice(0, firstSymbol));

    // ── the full national network — railprint's "unridden field" ──
    // Hidden by default: the network is opt-in via the layers-control switch.
    layers.push({
      id: SEGMENTS_LAYER,
      type: "line",
      source: SEGMENTS_SOURCE,
      filter: [">=", ["zoom"], ["get", "minz"]],
      layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
      paint: {
        "line-color": ["coalesce", ["get", "color"], DEFAULT_LINE_COLOR],
        "line-opacity": UNRIDDEN_OPACITY,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          stroke.unridden * 0.6 * UNRIDDEN_WIDTH_SCALE,
          9,
          stroke.unridden * 1 * UNRIDDEN_WIDTH_SCALE,
          14,
          stroke.unridden * 1.25 * UNRIDDEN_WIDTH_SCALE,
        ],
      },
    });
    layers.push({
      id: STATIONS_LAYER,
      type: "circle",
      source: STATIONS_SOURCE,
      filter: [">=", ["zoom"], ["get", "minz"]],
      layout: { visibility: "none" },
      paint: {
        "circle-color": tokens.railDim,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 1.4, 12, 3],
        "circle-stroke-color": tokens.white,
        "circle-stroke-width": 1,
      },
    });

    // The basemap's label (symbol) layers ride ABOVE the network so city /
    // place names are never covered by the all-lines overlay.
    layers.push(...bmLayers.slice(firstSymbol));
    // Optional white fade above the whole basemap (the 顯示調節 mapOpacity
    // slider); railprint default is NO fade (opacity 0).
    layers.push({
      id: FADE_LAYER,
      type: "background",
      paint: { "background-color": tokens.white, "background-opacity": fadeOpacity },
    });

    // ── the trains ("ridden") — full-color line (glow removed by request) ──
    layers.push({
      id: TRAIN_ROUTES_LAYER,
      type: "line",
      source: TRAIN_ROUTES_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": ["get", "alpha"],
        "line-width": zoomScaledWidth(["*", ["get", "width"], RIDDEN_WIDTH_SCALE]),
      },
    });
    // Whole hovered route lights up (full opacity, a touch wider).
    layers.push({
      id: TRAIN_HOVER_LAYER,
      type: "line",
      source: TRAIN_ROUTES_SOURCE,
      filter: ["==", ["get", "tid"], NO_TRAIN],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": 1,
        "line-width": zoomScaledWidth([
          "+",
          ["*", ["get", "width"], RIDDEN_WIDTH_SCALE],
          2,
        ]),
      },
    });
    // Other trains' station dots sit UNDER the selected route.
    layers.push({
      id: TRAIN_PASS_LAYER,
      type: "circle",
      source: TRAIN_MARKERS_SOURCE,
      filter: ["==", ["get", "category"], "pass"],
      paint: markerCirclePaint(),
    });
    layers.push({
      id: TRAIN_STOPS_LAYER,
      type: "circle",
      source: TRAIN_MARKERS_SOURCE,
      filter: ["==", ["get", "category"], "stop"],
      paint: markerCirclePaint(),
    });
    // C3 — DARK selection casing UNDER the selected line, the line's own hue on
    // top; the dark halo peeking out reads as "selected" on the light basemap.
    layers.push({
      id: TRAIN_SEL_CASING_LAYER,
      type: "line",
      source: TRAIN_ROUTES_SOURCE,
      filter: ["==", ["get", "tid"], NO_TRAIN],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": CASING_COLOR,
        "line-opacity": 0.9,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          stroke.ridden * 1.4,
          9,
          stroke.ridden * 2,
          14,
          stroke.ridden * 2.6,
        ],
      },
    });
    layers.push({
      id: TRAIN_SEL_LAYER,
      type: "line",
      source: TRAIN_ROUTES_SOURCE,
      filter: ["==", ["get", "tid"], NO_TRAIN],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": 1,
        "line-width": zoomScaledWidth(["*", ["get", "width"], RIDDEN_WIDTH_SCALE]),
      },
    });
    // The selected train's own dots above its raised route.
    layers.push({
      id: TRAIN_SEL_PASS_LAYER,
      type: "circle",
      source: TRAIN_MARKERS_SEL_SOURCE,
      filter: ["==", ["get", "category"], "pass"],
      paint: markerCirclePaint(),
    });
    layers.push({
      id: TRAIN_SEL_STOPS_LAYER,
      type: "circle",
      source: TRAIN_MARKERS_SEL_SOURCE,
      filter: ["==", ["get", "category"], "stop"],
      paint: markerCirclePaint(),
    });

    const style = { version: 8, sources, layers };
    if (basemap && basemap.glyphs) style.glyphs = basemap.glyphs;
    if (basemap && basemap.sprite) style.sprite = basemap.sprite;
    return style;
  }

  // ───────────────────────────── record → GeoJSON conversion ─────────────────────────────
  function rgbaCss(arr) {
    if (!Array.isArray(arr)) return "rgba(0,0,0,1)";
    const a = arr.length > 3 ? arr[3] / 255 : 1;
    return "rgba(" + arr[0] + "," + arr[1] + "," + arr[2] + "," + +a.toFixed(3) + ")";
  }

  function routeRecordsToFC(records) {
    return {
      type: "FeatureCollection",
      features: records.map((r, i) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: r.path },
        properties: {
          idx: i,
          tid: (r.train && r.train.id) || "",
          color: "rgb(" + r.color[0] + "," + r.color[1] + "," + r.color[2] + ")",
          alpha: r.color.length > 3 ? r.color[3] / 255 : 1,
          width: r.width,
        },
      })),
    };
  }

  function markerRecordsToFC(records) {
    return {
      type: "FeatureCollection",
      features: records.map((m, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: m.position },
        properties: {
          idx: i,
          tid: (m.train && m.train.id) || "",
          category: m.category,
          radius: m.radius,
          lineWidth: m.lineWidth,
          fill: rgbaCss(m.fillColor),
          stroke: rgbaCss(m.lineColor),
        },
      })),
    };
  }

  // ───────────────────────────── the overlay manager ─────────────────────────────
  const RailMap = {
    available: true,
    tokens,
    DEFAULT_LINE_COLOR,
    loadBasemap,
    loadNetwork,
    buildBaseStyle,

    _map: null,
    _network: null,
    _handlers: {},
    _records: [],
    _markers: [],
    _visible: true,
    _markerVis: { stop: true, pass: true },
    _selectedTrainId: null,
    _hoverTrainId: null,
    _tooltipEl: null,
    _stationPopup: null,
    _basemapLayerIds: [],

    attach(map, network, handlers, basemapLayerIds) {
      this._map = map;
      this._network = network || null;
      this._handlers = handlers || {};
      this._basemapLayerIds = basemapLayerIds || [];
      this._wireInteractions();
      return this;
    },

    // ── data feeds (same contract as the old deck.gl overlay) ──
    setData(records) {
      this._records = records || [];
      this._pushRoutes();
    },
    setMarkers(records) {
      this._markers = records || [];
      this._pushMarkers();
    },
    setSelected(id) {
      if ((id || null) === this._selectedTrainId) return;
      this._selectedTrainId = id || null;
      this._applySelectionFilters();
      this._pushMarkers();
    },
    setVisible(v) {
      this._visible = !!v;
      const vis = this._visible ? "visible" : "none";
      [
        TRAIN_ROUTES_LAYER,
        TRAIN_HOVER_LAYER,
        TRAIN_SEL_CASING_LAYER,
        TRAIN_SEL_LAYER,
      ].forEach((id) => this._setVisibility(id, vis));
    },
    setMarkerVisibility(category, v) {
      this._markerVis[category] = !!v;
      const vis = v ? "visible" : "none";
      if (category === "stop") {
        this._setVisibility(TRAIN_STOPS_LAYER, vis);
        this._setVisibility(TRAIN_SEL_STOPS_LAYER, vis);
      } else if (category === "pass") {
        this._setVisibility(TRAIN_PASS_LAYER, vis);
        this._setVisibility(TRAIN_SEL_PASS_LAYER, vis);
      }
    },
    setNetworkVisible(v) {
      this._setVisibility(SEGMENTS_LAYER, v ? "visible" : "none");
    },
    setNetworkStationsVisible(v) {
      this._setVisibility(STATIONS_LAYER, v ? "visible" : "none");
    },
    // Basemap mode: 'positron' (vector) | 'raster' (offline tiles) | 'none'.
    setBasemapMode(mode) {
      const posVis = mode === "positron" ? "visible" : "none";
      this._basemapLayerIds.forEach((id) => this._setVisibility(id, posVis));
      this._setVisibility(LOCAL_RASTER_LAYER, mode === "raster" ? "visible" : "none");
    },
    setFadeOpacity(v) {
      if (!this._map || !this._map.getLayer(FADE_LAYER)) return;
      this._map.setPaintProperty(
        FADE_LAYER,
        "background-opacity",
        Math.max(0, Math.min(1, v)),
      );
    },

    _setVisibility(layerId, vis) {
      const m = this._map;
      if (m && m.getLayer(layerId)) m.setLayoutProperty(layerId, "visibility", vis);
    },
    _src(id) {
      const m = this._map;
      return m ? m.getSource(id) : null;
    },
    _pushRoutes() {
      const src = this._src(TRAIN_ROUTES_SOURCE);
      if (src) src.setData(routeRecordsToFC(this._visible ? this._records : []));
    },
    _pushMarkers() {
      const sel = this._selectedTrainId;
      const shown = this._markers.filter(
        (m) => this._markerVis[m.category] !== false,
      );
      const base = sel ? shown.filter((m) => !m.train || m.train.id !== sel) : shown;
      const selMk = sel ? shown.filter((m) => m.train && m.train.id === sel) : [];
      this._baseMarkerRecords = base;
      this._selMarkerRecords = selMk;
      const bs = this._src(TRAIN_MARKERS_SOURCE);
      if (bs) bs.setData(markerRecordsToFC(base));
      const ss = this._src(TRAIN_MARKERS_SEL_SOURCE);
      if (ss) ss.setData(markerRecordsToFC(selMk));
    },
    _applySelectionFilters() {
      const m = this._map;
      if (!m) return;
      const id = this._selectedTrainId || NO_TRAIN;
      const f = ["==", ["get", "tid"], id];
      if (m.getLayer(TRAIN_SEL_CASING_LAYER)) m.setFilter(TRAIN_SEL_CASING_LAYER, f);
      if (m.getLayer(TRAIN_SEL_LAYER)) m.setFilter(TRAIN_SEL_LAYER, f);
    },
    _applyHoverFilter() {
      const m = this._map;
      if (!m || !m.getLayer(TRAIN_HOVER_LAYER)) return;
      m.setFilter(TRAIN_HOVER_LAYER, [
        "==",
        ["get", "tid"],
        this._hoverTrainId || NO_TRAIN,
      ]);
    },

    // ── interactions: route/marker click + hover, station hover popup ──
    _wireInteractions() {
      const map = this._map;
      const self = this;
      const PAD = 6; // px hit slop around the pointer for line picking

      function queryAt(point) {
        const markerLayers = [
          TRAIN_SEL_STOPS_LAYER,
          TRAIN_SEL_PASS_LAYER,
          TRAIN_STOPS_LAYER,
          TRAIN_PASS_LAYER,
        ].filter((id) => map.getLayer(id));
        const routeLayers = [TRAIN_ROUTES_LAYER, TRAIN_SEL_LAYER].filter((id) =>
          map.getLayer(id),
        );
        const bbox = [
          [point.x - PAD, point.y - PAD],
          [point.x + PAD, point.y + PAD],
        ];
        const mk = map.queryRenderedFeatures(bbox, { layers: markerLayers });
        if (mk.length) {
          const p = mk[0].properties;
          const rec =
            mk[0].layer.source === TRAIN_MARKERS_SEL_SOURCE
              ? self._selMarkerRecords && self._selMarkerRecords[p.idx]
              : self._baseMarkerRecords && self._baseMarkerRecords[p.idx];
          if (rec) return { kind: "marker", record: rec };
        }
        const rt = map.queryRenderedFeatures(bbox, { layers: routeLayers });
        if (rt.length) {
          const rec = self._records[rt[0].properties.idx];
          if (rec) return { kind: "route", record: rec };
        }
        return null;
      }

      map.on("click", (e) => {
        const hit = queryAt(e.point);
        if (!hit) return;
        const info = {
          object: hit.record,
          coordinate: [e.lngLat.lng, e.lngLat.lat],
        };
        if (hit.kind === "marker") {
          if (self._handlers.onMarkerClick) self._handlers.onMarkerClick(info);
        } else if (self._handlers.onClick) {
          self._handlers.onClick(info);
        }
      });

      map.on("mousemove", (e) => {
        const hit = queryAt(e.point);
        const id = hit && hit.record.train ? hit.record.train.id : null;
        if (id !== self._hoverTrainId) {
          self._hoverTrainId = id;
          self._applyHoverFilter();
          if (self._handlers.onHover) self._handlers.onHover(id);
        }
        map.getCanvas().style.cursor = hit ? "pointer" : "";
        self._showTooltip(hit, e.point);
        self._maybeStationPopup(hit ? null : e.point);
      });
      map.getCanvas().addEventListener("mouseleave", () => {
        if (self._hoverTrainId !== null) {
          self._hoverTrainId = null;
          self._applyHoverFilter();
          if (self._handlers.onHover) self._handlers.onHover(null);
        }
        self._showTooltip(null);
        self._removeStationPopup();
      });
    },

    // Floating tooltip fed by the app's getTooltip handler (same contract as
    // the deck.gl getTooltip: {html, style} or null).
    _showTooltip(hit, point) {
      const map = this._map;
      if (!this._tooltipEl) {
        const el = document.createElement("div");
        el.className = "railmap-tooltip";
        el.style.cssText =
          "position:absolute;z-index:30;pointer-events:none;display:none;";
        map.getContainer().appendChild(el);
        this._tooltipEl = el;
      }
      const el = this._tooltipEl;
      const tip =
        hit && this._handlers.getTooltip
          ? this._handlers.getTooltip({ object: hit.record })
          : null;
      if (!tip) {
        el.style.display = "none";
        return;
      }
      el.innerHTML = tip.html || "";
      const st = tip.style || {};
      for (const k of Object.keys(st)) el.style[k] = st[k];
      el.style.display = "block";
      el.style.left = point.x + 12 + "px";
      el.style.top = point.y + 12 + "px";
    },

    // C5 — bilingual hover popup on the NETWORK station dots (only when the
    // pointer isn't on a train route/marker, which take precedence).
    _maybeStationPopup(point) {
      const map = this._map;
      if (!point || !this._network || !map.getLayer(STATIONS_LAYER)) {
        this._removeStationPopup();
        return;
      }
      const feats = map.queryRenderedFeatures(point, { layers: [STATIONS_LAYER] });
      if (!feats.length) {
        this._removeStationPopup();
        return;
      }
      const p = feats[0].properties;
      const model = buildPopupModel(this._network, p.stationId, p.lineId);
      if (!model) return;
      const gl = global.maplibregl;
      if (!gl) return;
      if (!this._stationPopup) {
        this._stationPopup = new gl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 10,
          maxWidth: "260px",
        });
      }
      map.getCanvas().style.cursor = "default";
      this._stationPopup
        .setLngLat(feats[0].geometry.coordinates)
        .setHTML(popupHtml(model))
        .addTo(map);
    },
    _removeStationPopup() {
      if (this._stationPopup) this._stationPopup.remove();
    },
  };

  global.RailMap = RailMap;
})(window);
