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

  async function loadBasemap(force) {
    // Offline ⇒ basemap-less on purpose (the vector tile fetches would all fail).
    // `force` (the explicit online-retry path) skips the cheap navigator.onLine
    // gate and lets the fetch + origin probe decide.
    if (!force && typeof navigator !== "undefined" && navigator.onLine === false)
      return null;
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

  // positron.json is a LOCAL vendored file, so re-loading it "succeeds" even
  // while offline — before splicing the basemap in, verify the remote tile
  // origin is actually reachable (sprite JSON is the smallest stable asset).
  async function probeBasemapOrigin(basemap) {
    const url = basemap.sprite
      ? basemap.sprite + ".json"
      : basemap.glyphs
        ? basemap.glyphs
            .replace("{fontstack}", "Noto Sans Regular")
            .replace("{range}", "0-255")
        : null;
    if (!url || !/^https?:/i.test(url)) return true; // nothing remote to probe
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), LOAD_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, {
        cache: "no-store",
        signal: ctl ? ctl.signal : undefined,
      });
      return res.ok;
    } catch (e) {
      return false;
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
  function stationPopupHtml(model) {
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
  const TRAIN_PICK_SOURCE = "train-routes-pick";
  const TRAIN_EXPAND_SOURCE = "train-routes-expand-src";
  const TRAIN_MARKERS_SOURCE = "train-markers-base";
  const TRAIN_ROUTES_LAYER = "train-routes-line";
  const TRAIN_PICK_LAYER = "train-routes-pick-line";
  const TRAIN_EXPAND_LAYER = "train-routes-expand";
  const TRAIN_EXPAND_HOVER_LAYER = "train-routes-expand-hover";
  const TRAIN_HOVER_LAYER = "train-routes-hover";
  const TRAIN_SEL_CASING_LAYER = "train-routes-sel-casing";
  const TRAIN_SEL_LAYER = "train-routes-sel";
  const TRAIN_PASS_LAYER = "train-pass-dot";
  const TRAIN_STOPS_LAYER = "train-stops-dot";
  const TRAIN_SEL_PASS_LAYER = "train-sel-pass-dot";
  const TRAIN_SEL_STOPS_LAYER = "train-sel-stops-dot";

  const EMPTY_FC = { type: "FeatureCollection", features: [] };
  const NO_TRAIN = "__none__";
  // A filter that can never match (empty tid whitelist).
  const MATCH_NONE = ["in", ["get", "tid"], ["literal", []]];
  // HOVER SPOTLIGHT: while a route (or an expanded parallel group) is
  // hovered, every OTHER train's lines and station dots fade to this opacity
  // multiplier. Applied purely via paint expressions (no source updates).
  const HOVER_DIM = 0.15;
  // SELECTION SPOTLIGHT: while a single train is SELECTED, every other train
  // still drawn (its same-day siblings — other dates are removed upstream)
  // fades to this multiplier, station dots included. Softer than the hover
  // dim so a hover can still deepen the spotlight on top of a selection.
  const SELECT_DIM = 0.25;
  // (Opacity fades are rAF-driven — see the animated dim engine
  // `_applyDimPaint`; per-mode durations live in `_dimSpeedMs`.)

  // Marker circle paint shared by the four dot layers: per-feature fill/stroke
  // (rgb strings; alpha rides circle-opacity so the SEL layers can override
  // it) + railprint's zoom-scaled radius (r at z12, ×~0.48 at z5 — matching
  // stationRadiusExpression's 2.4/5 & 1.4/3 ratios). `radiusBoost` widens the
  // SEL layers' dots (focus emphasis without any record rebuild); `sel` layers
  // also force full opacity so a selected off-date train's dots un-dim.
  function markerRadiusExpr(radiusBoost) {
    const r = radiusBoost
      ? ["+", ["get", "radius"], radiusBoost]
      : ["get", "radius"];
    return ["interpolate", ["linear"], ["zoom"], 5, ["*", r, 0.48], 12, r];
  }
  function markerCirclePaint(opts) {
    const sel = !!(opts && opts.sel);
    return {
      "circle-color": ["get", "fill"],
      "circle-opacity": sel ? 1 : ["get", "alpha"],
      "circle-radius": markerRadiusExpr(0),
      "circle-stroke-color": ["get", "stroke"],
      "circle-stroke-opacity": sel ? 1 : ["get", "alpha"],
      "circle-stroke-width": sel
        ? ["*", ["get", "lineWidth"], opts.strokeScale || 1]
        : ["get", "lineWidth"],
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
    sources[TRAIN_PICK_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[TRAIN_EXPAND_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[TRAIN_MARKERS_SOURCE] = { type: "geojson", data: EMPTY_FC };
    // Pass-through dot LOD: below this zoom the (numerous) white dots simply
    // don't draw — a layer property, so crossing it re-renders nothing.
    const passMinzoom = Math.max(0, Number(opts.passMinzoom || 0));

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
    // Invisible PICK layer: when several trains share the same track, each
    // train's pick geometry is offset sideways into its own parallel lane
    // (earliest date = left/top lane), so sliding the pointer across an
    // overlapped stretch hovers/selects each train in date order. Zero
    // opacity — queryRenderedFeatures still hit-tests against line-width.
    layers.push({
      id: TRAIN_PICK_LAYER,
      type: "line",
      source: TRAIN_PICK_SOURCE,
      // nopick records (off-date trains while a concrete day is active) are
      // excluded from hit-testing entirely: no hover, no tooltip, no click.
      filter: ["!=", ["get", "nopick"], 1],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#000",
        "line-opacity": 0,
        "line-width": ["get", "pickWidth"],
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
    // Other trains' station dots sit UNDER the selected route. ONE marker
    // source feeds all four dot layers; the selected train's dots move to the
    // SEL layers purely via tid filters (selection = 4 setFilter calls, zero
    // setData).
    layers.push({
      id: TRAIN_PASS_LAYER,
      type: "circle",
      source: TRAIN_MARKERS_SOURCE,
      minzoom: passMinzoom,
      filter: [
        "all",
        ["==", ["get", "category"], "pass"],
        ["!=", ["get", "tid"], NO_TRAIN],
      ],
      paint: markerCirclePaint(),
    });
    layers.push({
      id: TRAIN_STOPS_LAYER,
      type: "circle",
      source: TRAIN_MARKERS_SOURCE,
      filter: [
        "all",
        ["==", ["get", "category"], "stop"],
        ["!=", ["get", "tid"], NO_TRAIN],
      ],
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
    // HOVER-EXPAND: while the pointer is on an overlapped stretch, that
    // group's trains draw temporarily fanned into date-ordered parallel
    // lanes. Each expand feature is the member train's COMPLETE course,
    // RIGIDLY translated by the group's constant shift vector — corners,
    // radii and lengths untouched, one intact copy of the whole line, never
    // broken into pieces mid-route. The source is group-scoped (filled on
    // hover). Opacity is animated 0→1 in JS; per-record alpha is baked into
    // colorA so the layer-level line-opacity acts as a pure fade multiplier.
    layers.push({
      id: TRAIN_EXPAND_LAYER,
      type: "line",
      source: TRAIN_EXPAND_SOURCE,
      filter: MATCH_NONE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "colorA"],
        "line-opacity": 0,
        "line-width": zoomScaledWidth(["*", ["get", "width"], RIDDEN_WIDTH_SCALE]),
      },
    });
    // The hovered train's own lane lights up a touch wider, mirroring the
    // whole-route hover layer.
    layers.push({
      id: TRAIN_EXPAND_HOVER_LAYER,
      type: "line",
      source: TRAIN_EXPAND_SOURCE,
      filter: MATCH_NONE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "colorA"],
        "line-opacity": 0,
        "line-width": zoomScaledWidth([
          "+",
          ["*", ["get", "width"], RIDDEN_WIDTH_SCALE],
          2,
        ]),
      },
    });
    // The selected train's own dots above its raised route (same source,
    // tid-filtered; full opacity + focus-boost radius via paint).
    layers.push({
      id: TRAIN_SEL_PASS_LAYER,
      type: "circle",
      source: TRAIN_MARKERS_SOURCE,
      minzoom: passMinzoom,
      filter: [
        "all",
        ["==", ["get", "category"], "pass"],
        ["==", ["get", "tid"], NO_TRAIN],
      ],
      paint: markerCirclePaint({ sel: true, strokeScale: 1 }),
    });
    layers.push({
      id: TRAIN_SEL_STOPS_LAYER,
      type: "circle",
      source: TRAIN_MARKERS_SOURCE,
      filter: [
        "all",
        ["==", ["get", "category"], "stop"],
        ["==", ["get", "tid"], NO_TRAIN],
      ],
      paint: markerCirclePaint({ sel: true, strokeScale: 2 }),
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
          tdate: r.tdate || "",
          color: "rgb(" + r.color[0] + "," + r.color[1] + "," + r.color[2] + ")",
          alpha: r.color.length > 3 ? r.color[3] / 255 : 1,
          width: r.width,
        },
      })),
    };
  }

  // Pick geometry: same records, but using the per-lane offset path (pickPath)
  // and a generous pixel hit width. `idx` maps a picked feature back to the
  // full record in _records (tooltip lane info, click target, group key).
  function routePickRecordsToFC(records) {
    return {
      type: "FeatureCollection",
      features: records.map((r, i) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: r.pickPath || r.path },
        properties: {
          idx: i,
          tid: (r.train && r.train.id) || "",
          pickWidth: r.pickWidth != null ? r.pickWidth : Math.max(r.width + 8, 14),
          nopick: r.nopick ? 1 : 0,
        },
      })),
    };
  }

  // HOVER-EXPAND geometry for ONE hovered group: every member train's
  // complete course (all its lines), RIGIDLY translated into its lane by the
  // group's constant shift vector — corners, radii and lengths untouched
  // (colorA has the record's alpha baked in). `gi` comes from app.js's
  // buildDeckRouteRecords groupInfo; spacingDeg is the current lane spacing.
  function routeExpandFC(expandRecords, gi, spacingDeg) {
    if (!gi) return EMPTY_FC;
    const features = [];
    expandRecords.forEach((r, i) => {
      const tid = (r.train && r.train.id) || "";
      const mult = gi.mults[tid];
      if (mult === undefined) return; // not a member of the hovered group
      const dx = gi.sx * mult * spacingDeg;
      const dy = gi.sy * mult * spacingDeg;
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: r.path.map((p) => [p[0] + dx, p[1] + dy]),
        },
        properties: {
          idx: i,
          tid,
          colorA: rgbaCss(r.color),
          width: r.width,
        },
      });
    });
    return { type: "FeatureCollection", features };
  }

  function rgbCss(arr) {
    if (!Array.isArray(arr)) return "rgb(0,0,0)";
    return "rgb(" + arr[0] + "," + arr[1] + "," + arr[2] + ")";
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
          tdate: m.tdate || "",
          category: m.category,
          radius: m.radius,
          lineWidth: m.lineWidth,
          fill: rgbCss(m.fillColor),
          stroke: rgbCss(m.lineColor),
          alpha: m.alpha != null ? m.alpha : 1,
        },
      })),
    };
  }

  // ───────────────────────────── the overlay manager ─────────────────────────────
  const RailMap = {
    loadBasemap,
    loadNetwork,
    buildBaseStyle,

    _map: null,
    _network: null,
    _handlers: {},
    _records: [],
    _expandRecords: [],
    _groupInfo: null, // groupKey → { sx, sy, mults } (rigid lane shifts)
    _laneSpacingDeg: 0,
    _markers: [],
    _visible: true,
    _selectedTrainId: null,
    _hoverTrainId: null,
    _expandedGroup: null,
    _expandedTids: [], // the hovered group's train set (expand target)
    _engagedTids: [], // trains whose true-track lines are currently hidden
    _expandFilterTids: [], // trains the expand layers currently show
    _expandT: 0,
    _expandAnimId: null,
    _tooltipEl: null,
    _tooltipRecord: null, // record the tooltip currently shows (dedup)
    _stationPopup: null,
    _stationPopupKey: null, // station|line the popup currently shows (dedup)
    _pendingHoverPoint: null, // latest mousemove point awaiting the rAF pass
    _hoverRafId: null,
    _basemapLayerIds: [],
    _basemapRetryInflight: null, // dedups concurrent retryBasemap() calls

    attach(map, network, handlers, basemapLayerIds) {
      this._map = map;
      this._network = network || null;
      this._handlers = handlers || {};
      this._basemapLayerIds = basemapLayerIds || [];
      this._wireInteractions();
      // ALL opacity fades on these layers are driven manually by the rAF dim
      // engine (_applyDimPaint) and the fan slide — MapLibre skips its own
      // transitions for data-driven paint values anyway, and its implicit
      // default 300 ms transition on CONSTANT values would trail the rAF
      // frames. Pin every animated opacity prop to zero so the rAF loop is
      // the single source of animation truth.
      const ZERO_T = { duration: 0, delay: 0 };
      [
        [TRAIN_ROUTES_LAYER, ["line-opacity"]],
        [TRAIN_SEL_CASING_LAYER, ["line-opacity"]],
        [TRAIN_SEL_LAYER, ["line-opacity"]],
        [TRAIN_EXPAND_LAYER, ["line-opacity"]],
        [TRAIN_EXPAND_HOVER_LAYER, ["line-opacity"]],
        [TRAIN_PASS_LAYER, ["circle-opacity", "circle-stroke-opacity"]],
        [TRAIN_STOPS_LAYER, ["circle-opacity", "circle-stroke-opacity"]],
        [TRAIN_SEL_PASS_LAYER, ["circle-opacity", "circle-stroke-opacity"]],
        [TRAIN_SEL_STOPS_LAYER, ["circle-opacity", "circle-stroke-opacity"]],
      ].forEach(([id, props]) => {
        if (!map.getLayer(id)) return;
        props.forEach((prop) =>
          map.setPaintProperty(id, prop + "-transition", ZERO_T),
        );
      });
      return this;
    },

    // ── data feeds (same contract as the old deck.gl overlay, plus the
    // full-line expand records + per-group rigid shift vectors) ──
    setData(records, expandRecords, groupInfo, laneSpacingDeg) {
      this._records = records || [];
      this._expandRecords = expandRecords || [];
      this._groupInfo = groupInfo || new Map();
      this._laneSpacingDeg = laneSpacingDeg || 0;
      this._pushRoutes();
      // A fan is open while the record pipeline is REBUILT (e.g. clicking a
      // lane switches to the single-day scope, which recomputes the overlap
      // groups). If the expanded group no longer exists in the new data, the
      // expand source would go empty while _engagedTids kept the member
      // trains' true-track lines filtered out of the base layer — the
      // clicked route vanished until a mouseleave collapsed the stale fan.
      // Force-collapse the stale fan synchronously instead.
      if (this._expandedGroup && !this._groupInfo.has(this._expandedGroup)) {
        this._forceCollapseExpand();
        return;
      }
      // Zoom/pan (or an in-place rebuild) with a fan open: re-translate the
      // expanded group's lanes at the fresh spacing and re-sync the member
      // tid sets — the group can survive a rebuild with DIFFERENT membership
      // (e.g. off-date trains dropped when a day becomes active), and stale
      // engaged tids would hide lines that no longer have expand twins.
      if (this._expandedGroup) {
        this._pushExpandFC(this._expandedGroup);
        const gi = this._groupInfo.get(this._expandedGroup);
        const tids = gi ? Object.keys(gi.mults) : [];
        this._expandedTids = tids;
        this._expandFilterTids = tids;
        const m = this._map;
        if (m && m.getLayer(TRAIN_EXPAND_LAYER))
          m.setFilter(TRAIN_EXPAND_LAYER, this._expandSelector(tids));
        if (this._engagedTids.length) {
          this._engagedTids = tids.slice();
          this._applyBaseFilters();
        } else {
          this._applyHoverFilter();
        }
      }
    },
    // Immediate (no animation) reset of the hover-expand state: clear the
    // group, un-hide every engaged train's true-track lines, empty the expand
    // source and restore the base/hover/selection filters. Used when new data
    // invalidates the currently expanded group.
    _forceCollapseExpand() {
      if (this._expandAnimId) {
        cancelAnimationFrame(this._expandAnimId);
        this._expandAnimId = null;
      }
      this._expandedGroup = null;
      this._expandedTids = [];
      this._expandFilterTids = [];
      this._engagedTids = [];
      this._expandT = 0;
      this._animGroup = null;
      this._setExpandOpacity(0);
      this._pushExpandFC(null, 0);
      const m = this._map;
      if (m && m.getLayer(TRAIN_EXPAND_LAYER))
        m.setFilter(TRAIN_EXPAND_LAYER, this._expandSelector([]));
      this._applyBaseFilters();
    },
    // Zoom-only lane refresh. When the view zooms, the parallel PICK lanes are
    // re-translated to keep constant ON-SCREEN spacing, but every train's base
    // route geometry (`record.path`) is byte-for-byte unchanged. The record
    // objects are mutated in place by the caller's cache, so `this._records`
    // already carries the fresh pickPaths — we only need to re-upload the
    // invisible pick source and skip re-tiling the (identical) visible base
    // route source. Halves the GPU re-upload on every zoom that has overlaps.
    updateLaneSpacing(laneSpacingDeg) {
      this._laneSpacingDeg = laneSpacingDeg || 0;
      const pick = this._src(TRAIN_PICK_SOURCE);
      if (pick)
        pick.setData(routePickRecordsToFC(this._visible ? this._records : []));
      if (this._expandedGroup) this._pushExpandFC(this._expandedGroup);
      return this;
    },
    setMarkers(records) {
      this._markers = records || [];
      this._pushMarkers();
    },
    setSelected(id) {
      if ((id || null) === this._selectedTrainId) return;
      this._selectedTrainId = id || null;
      this._applySelectionFilters();
      this._applyMarkerSelectionFilters();
      // Selection spotlight: fade the non-selected trains (lines + dots) to
      // SELECT_DIM — same paint-only mechanism as the hover dim.
      this._applyHoverDim();
    },
    // Date-scope dim as PAINT state: records carry their train's date in
    // `tdate`; the active date + dim value live in the opacity expressions.
    // Changing scope therefore FADES (the rAF dim engine ramps the `date`
    // strength) instead of waiting for the record rebuild, whose re-uploaded
    // features carry the same per-train paint inputs mid-fade.
    setDateScope(activeDate, dimOpacity) {
      const next = activeDate || null;
      const dim = Math.max(0, Math.min(1, Number(dimOpacity ?? 0.18)));
      if (next === this._activeDate && dim === this._dateDim) return this;
      this._activeDate = next;
      this._dateDim = dim;
      this._applyHoverDim();
      return this;
    },
    // Focus emphasis for the selected train: instead of baking the boost into
    // every record (which would force a full pipeline rebuild on each pick),
    // the SEL line draws `px` wider and the SEL dots `px` (stops) / `px/2`
    // (pass-through) larger via paint expressions.
    setFocusBoost(px) {
      this._focusBoost = Number(px) || 0;
      const m = this._map;
      if (!m) return;
      if (m.getLayer(TRAIN_SEL_LAYER))
        m.setPaintProperty(
          TRAIN_SEL_LAYER,
          "line-width",
          zoomScaledWidth([
            "*",
            ["+", ["get", "width"], this._focusBoost],
            RIDDEN_WIDTH_SCALE,
          ]),
        );
      if (m.getLayer(TRAIN_SEL_STOPS_LAYER))
        m.setPaintProperty(
          TRAIN_SEL_STOPS_LAYER,
          "circle-radius",
          markerRadiusExpr(this._focusBoost),
        );
      if (m.getLayer(TRAIN_SEL_PASS_LAYER))
        m.setPaintProperty(
          TRAIN_SEL_PASS_LAYER,
          "circle-radius",
          markerRadiusExpr(Math.round(this._focusBoost / 2)),
        );
    },
    // Selection = pure layer filtering on the single marker source: the
    // selected train's dots leave the base layers and enter the SEL layers.
    _applyMarkerSelectionFilters() {
      const m = this._map;
      if (!m) return;
      const id = this._selectedTrainId || NO_TRAIN;
      const f = (cat, mine) => [
        "all",
        ["==", ["get", "category"], cat],
        [mine ? "==" : "!=", ["get", "tid"], id],
      ];
      if (m.getLayer(TRAIN_PASS_LAYER))
        m.setFilter(TRAIN_PASS_LAYER, f("pass", false));
      if (m.getLayer(TRAIN_STOPS_LAYER))
        m.setFilter(TRAIN_STOPS_LAYER, f("stop", false));
      if (m.getLayer(TRAIN_SEL_PASS_LAYER))
        m.setFilter(TRAIN_SEL_PASS_LAYER, f("pass", true));
      if (m.getLayer(TRAIN_SEL_STOPS_LAYER))
        m.setFilter(TRAIN_SEL_STOPS_LAYER, f("stop", true));
    },
    setVisible(v) {
      this._visible = !!v;
      const vis = this._visible ? "visible" : "none";
      [
        TRAIN_ROUTES_LAYER,
        TRAIN_PICK_LAYER,
        TRAIN_EXPAND_LAYER,
        TRAIN_EXPAND_HOVER_LAYER,
        TRAIN_HOVER_LAYER,
        TRAIN_SEL_CASING_LAYER,
        TRAIN_SEL_LAYER,
      ].forEach((id) => this._setVisibility(id, vis));
    },
    setMarkerVisibility(category, v) {
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
    // Whether the vector (online) basemap is present in the live style.
    hasBasemap() {
      return this._basemapLayerIds.length > 0;
    },
    // Online retry: boot may have degraded to no-basemap (offline start /
    // fetch timeout). Re-fetches the vendored positron style, probes the
    // remote tile origin, then splices the basemap's sources + layers into
    // the LIVE style at the exact positions buildBaseStyle uses (pre-symbol
    // layers under the national network, symbol/label layers under the fade
    // layer). Injected layers start hidden — the caller decides visibility
    // via setBasemapMode, so a background retry never flips the view.
    // Resolves true when the vector basemap is available afterwards.
    async retryBasemap() {
      const m = this._map;
      if (!m) return false;
      if (this._basemapLayerIds.length) return true; // already present
      if (this._basemapRetryInflight) return this._basemapRetryInflight;
      this._basemapRetryInflight = (async () => {
        try {
          const basemap = await loadBasemap(true);
          if (!basemap) return false;
          if (!(await probeBasemapOrigin(basemap))) return false;
          if (basemap.glyphs && typeof m.setGlyphs === "function")
            m.setGlyphs(basemap.glyphs);
          if (basemap.sprite && typeof m.setSprite === "function")
            m.setSprite(basemap.sprite);
          for (const id of Object.keys(basemap.sources)) {
            if (!m.getSource(id)) m.addSource(id, basemap.sources[id]);
          }
          const bmLayers = basemap.layers;
          let firstSymbol = bmLayers.findIndex((l) => l && l.type === "symbol");
          if (firstSymbol < 0) firstSymbol = bmLayers.length;
          const addHidden = (l, beforeId) => {
            if (m.getLayer(l.id)) return;
            const layer = Object.assign({}, l, {
              layout: Object.assign({}, l.layout, { visibility: "none" }),
            });
            m.addLayer(layer, beforeId);
          };
          bmLayers.slice(0, firstSymbol).forEach((l) => addHidden(l, SEGMENTS_LAYER));
          bmLayers.slice(firstSymbol).forEach((l) => addHidden(l, FADE_LAYER));
          this._basemapLayerIds = bmLayers.map((l) => l.id);
          return true;
        } catch (e) {
          return false;
        } finally {
          this._basemapRetryInflight = null;
        }
      })();
      return this._basemapRetryInflight;
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
      const shown = this._visible ? this._records : [];
      const src = this._src(TRAIN_ROUTES_SOURCE);
      if (src) src.setData(routeRecordsToFC(shown));
      const pick = this._src(TRAIN_PICK_SOURCE);
      if (pick) pick.setData(routePickRecordsToFC(shown));
    },
    // The expand source is GROUP-SCOPED: it only ever holds the hovered
    // group's translated member courses (or nothing when collapsed).
    // `factor` scales the lane offsets (0 = on the true track, 1 = fully
    // fanned): _animateExpand pushes intermediate factors every frame so the
    // lanes SLIDE out/in instead of appearing at their final position.
    // Defaults to the current animation progress so settled states (open fan
    // during zoom / data refresh) keep their full offset.
    _pushExpandFC(group, factor) {
      const exp = this._src(TRAIN_EXPAND_SOURCE);
      if (!exp) return;
      const f =
        factor == null ? (this._expandT == null ? 1 : this._expandT) : factor;
      const gi =
        group && this._visible && this._groupInfo
          ? this._groupInfo.get(group)
          : null;
      exp.setData(
        gi
          ? routeExpandFC(this._expandRecords, gi, this._laneSpacingDeg * f)
          : EMPTY_FC,
      );
    },
    // ONE source holds every marker; the base/SEL split is pure layer
    // filtering (see _applyMarkerSelectionFilters) and category visibility is
    // layer visibility — so this pushes only when the record set changes.
    _pushMarkers() {
      const src = this._src(TRAIN_MARKERS_SOURCE);
      if (src) src.setData(markerRecordsToFC(this._markers));
    },
    // Expansion selects by TRAIN SET, not by the single hovered run: every
    // train sharing the hovered stretch shows as its COMPLETE course rigidly
    // translated into its lane — one intact copy of the whole line, corners /
    // radii / lengths unchanged, never broken into pieces mid-route.
    _expandSelector(tids) {
      return ["in", ["get", "tid"], ["literal", tids || []]];
    },
    // While a fan is engaged, the true-track layers (base / hover / sel)
    // EXCLUDE the engaged trains entirely — their translated copies fully
    // replace them, so nothing draws down the middle of the fan and nothing
    // draws twice.
    _notExpanded() {
      return ["!", this._expandSelector(this._engagedTids)];
    },
    _applyBaseFilters() {
      const m = this._map;
      if (!m) return;
      if (m.getLayer(TRAIN_ROUTES_LAYER))
        m.setFilter(TRAIN_ROUTES_LAYER, this._notExpanded());
      this._applySelectionFilters();
      this._applyHoverFilter();
    },
    _applySelectionFilters() {
      const m = this._map;
      if (!m) return;
      const id = this._selectedTrainId || NO_TRAIN;
      const f = ["all", ["==", ["get", "tid"], id], this._notExpanded()];
      if (m.getLayer(TRAIN_SEL_CASING_LAYER)) m.setFilter(TRAIN_SEL_CASING_LAYER, f);
      if (m.getLayer(TRAIN_SEL_LAYER)) m.setFilter(TRAIN_SEL_LAYER, f);
    },
    _applyHoverFilter() {
      const m = this._map;
      if (!m) return;
      if (m.getLayer(TRAIN_HOVER_LAYER))
        m.setFilter(TRAIN_HOVER_LAYER, [
          "all",
          ["==", ["get", "tid"], this._hoverTrainId || NO_TRAIN],
          this._notExpanded(),
        ]);
      // The expanded fan mirrors the hover: the hovered train's LANE widens.
      if (m.getLayer(TRAIN_EXPAND_HOVER_LAYER))
        m.setFilter(TRAIN_EXPAND_HOVER_LAYER, [
          "all",
          this._expandSelector(this._expandFilterTids),
          ["==", ["get", "tid"], this._hoverTrainId || NO_TRAIN],
        ]);
      this._applyHoverDim();
    },

    // ── hover spotlight: dim every train that is NOT being hovered ──
    // Active set = the expanded parallel group while a fan is showing (also
    // during its fade-out), else the single hovered train. Everything else —
    // route lines AND stop/pass-through dots — fades to HOVER_DIM.
    //
    // P0 path: this changes ONLY layer paint expressions (setPaintProperty),
    // never touches a GeoJSON source; the rAF dim engine below animates the
    // strengths.
    _activeHoverTids() {
      if (this._expandFilterTids.length) return this._expandFilterTids;
      if (this._hoverTrainId) return [this._hoverTrainId];
      return null;
    },
    // ── animated dim engine ────────────────────────────────────────────
    // MapLibre does NOT transition DATA-DRIVEN paint properties — every
    // opacity here is a per-feature expression (keyed on tid / tdate), so
    // declared *-transition values were silently ignored and every dim
    // change snapped. Instead, THREE dim modes each get an animated strength
    // (0..1) driven by ONE rAF loop; each frame rebuilds the opacity
    // expressions with the current strengths lerped in:
    //   date  -> off-date features lerp own-alpha -> flat _dateDim
    //   sel   -> non-selected features lerp own -> flat SELECT_DIM
    //   hover -> non-hovered features multiply toward HOVER_DIM;
    //            hovered features lerp their sel-dim away (spotlight wins)
    // Role-set changes (hover moving between trains, switching days) apply
    // at the current strength; engage/disengage is what animates.
    _dimSpeedMs: { hover: 250, sel: 350, date: 400 },
    _updateDimTargets() {
      if (!this._dimVals) {
        this._dimVals = { hover: 0, sel: 0, date: 0 };
        this._dimTargets = { hover: 0, sel: 0, date: 0 };
      }
      // Latch the last-known active sets so a fade-OUT still knows which
      // features were dimmed while the strength ramps back to 0.
      const hoverTids = this._activeHoverTids();
      if (hoverTids && hoverTids.length) this._dimHoverTids = hoverTids.slice();
      if (this._selectedTrainId) this._dimSelId = this._selectedTrainId;
      if (this._activeDate) this._dimDate = this._activeDate;
      this._dimTargets = {
        hover: hoverTids && hoverTids.length ? 1 : 0,
        sel: this._selectedTrainId ? 1 : 0,
        date: this._activeDate ? 1 : 0,
      };
      // Role changes at steady strength (e.g. sweeping the pointer between
      // trains) must re-apply immediately even when nothing is ramping.
      this._applyDimPaint();
      this._ensureDimAnim();
    },
    _ensureDimAnim() {
      if (this._dimRaf) return;
      const step = (now) => {
        this._dimRaf = null;
        const dt = Math.min(50, now - (this._dimLast || now));
        this._dimLast = now;
        let moving = false;
        ["hover", "sel", "date"].forEach((k) => {
          const target = this._dimTargets[k];
          const cur = this._dimVals[k];
          if (cur === target) return;
          const rate = dt / this._dimSpeedMs[k];
          const next =
            cur < target
              ? Math.min(target, cur + rate)
              : Math.max(target, cur - rate);
          this._dimVals[k] = next;
          if (next !== target) moving = true;
        });
        this._applyDimPaint();
        if (moving) {
          this._dimRaf = requestAnimationFrame(step);
        } else {
          this._dimLast = null;
        }
      };
      this._dimLast = performance.now();
      this._dimRaf = requestAnimationFrame(step);
    },
    _applyDimPaint() {
      const m = this._map;
      if (!m || !this._dimVals) return;
      const v = this._dimVals;
      const easeS = (s) => 1 - Math.pow(1 - s, 2); // gentle ease-out
      const sDate = easeS(v.date);
      const sSel = easeS(v.sel);
      const sHover = easeS(v.hover);
      // lerp helpers that collapse to plain values at the endpoints so the
      // steady-state expressions stay as small as before.
      const lerpNum = (expr, num, s) =>
        s >= 1 ? num : s <= 0 ? expr : ["+", ["*", expr, 1 - s], num * s];
      const lerpExpr = (a, b, s) =>
        s >= 1 ? b : s <= 0 ? a : ["+", ["*", a, 1 - s], ["*", b, s]];
      const dateDim = this._dateDim ?? 0.18;
      const dateWrap = (own) =>
        sDate > 0 && this._dimDate
          ? [
              "case",
              ["==", ["get", "tdate"], this._dimDate],
              own,
              lerpNum(own, dateDim, sDate),
            ]
          : own;
      // Non-selected features head toward the flat SELECT_DIM (NOT
      // multiplied into their alpha, or off-date trains would end up dimmer
      // than same-day ones).
      const selWrap = (own) =>
        sSel > 0 && this._dimSelId
          ? [
              "case",
              ["==", ["get", "tid"], this._dimSelId],
              own,
              lerpNum(own, SELECT_DIM, sSel),
            ]
          : own;
      const hoverActive = sHover > 0 && (this._dimHoverTids || []).length > 0;
      const inHover = hoverActive
        ? ["in", ["get", "tid"], ["literal", this._dimHoverTids]]
        : null;
      const hoverMul = 1 - (1 - HOVER_DIM) * sHover;
      const chain = (own) => {
        const base = selWrap(dateWrap(own));
        if (!hoverActive) return base;
        // Hovered features climb OUT of the selection dim toward their
        // date-scoped alpha; everyone else multiplies toward HOVER_DIM.
        return [
          "case",
          inHover,
          lerpExpr(base, dateWrap(own), sHover),
          ["*", base, hoverMul],
        ];
      };
      const set = (id, prop, value) => {
        if (m.getLayer(id)) m.setPaintProperty(id, prop, value);
      };
      const baseOpacity = chain(["get", "alpha"]);
      // SEL layers only ever contain the selected train (always "active"):
      // only the hover spotlight can dim them.
      const selLayerVal = hoverActive ? ["case", inHover, 1, hoverMul] : 1;
      set(TRAIN_ROUTES_LAYER, "line-opacity", baseOpacity);
      set(
        TRAIN_SEL_CASING_LAYER,
        "line-opacity",
        hoverActive ? ["*", 0.9, selLayerVal] : 0.9,
      );
      set(TRAIN_SEL_LAYER, "line-opacity", selLayerVal);
      [TRAIN_PASS_LAYER, TRAIN_STOPS_LAYER].forEach((id) => {
        set(id, "circle-opacity", baseOpacity);
        set(id, "circle-stroke-opacity", baseOpacity);
      });
      [TRAIN_SEL_PASS_LAYER, TRAIN_SEL_STOPS_LAYER].forEach((id) => {
        set(id, "circle-opacity", selLayerVal);
        set(id, "circle-stroke-opacity", selLayerVal);
      });
    },
    // Single entry point every dim-state change funnels through.
    _applyHoverDim() {
      this._updateDimTargets();
    },

    // ── hover-expand: fan an overlapped group out into its parallel lanes ──
    // _expandedGroup / _expandedTids = the hovered run's group and its trains
    // _engagedTids = trains whose true-track overlap-lines are hidden right
    //   now (their continuous expand twins replace them)
    // _expandFilterTids = the trains the expand layers currently SHOW (kept
    //   through the collapse slide so the lanes glide home before vanishing)
    //
    // PURE SLIDE — no opacity crossfade (a fade made the corridor visibly
    // flash on hover). At factor 0 every member's expand twin lies EXACTLY on
    // its true track with identical colour/width/alpha, so the base lines can
    // be swapped for the twins (and back) with zero visible change; the only
    // animated quantity is the lane-offset factor, so expanding slides the
    // lines apart and collapsing slides them home.
    _setExpandedGroup(g) {
      const next = g || null;
      if (next === this._expandedGroup) return;
      this._expandedGroup = next;
      const m = this._map;
      if (!m) return;
      const engage = () => {
        const t = this._expandedTids;
        const same =
          t.length === this._engagedTids.length &&
          t.every((x) => this._engagedTids.includes(x));
        if (same) return;
        this._engagedTids = t.slice();
        this._applyBaseFilters();
      };
      const release = () => {
        if (this._expandedGroup) return; // re-expanded meanwhile
        if (!this._engagedTids.length) return;
        this._engagedTids = [];
        this._applyBaseFilters();
      };
      if (next) {
        const gi = this._groupInfo ? this._groupInfo.get(next) : null;
        const nextTids = gi ? Object.keys(gi.mults) : [];
        // Fill the group-scoped expand source with the member trains'
        // translated complete courses (rigid shift, geometry untouched).
        // Offsets start at the CURRENT slide progress (0 when fresh — i.e.
        // exactly on the true track) and slide outward from there.
        this._animGroup = next;
        this._pushExpandFC(next, this._expandT || 0);
        this._expandedTids = nextTids;
        this._expandFilterTids = nextTids;
        if (m.getLayer(TRAIN_EXPAND_LAYER))
          m.setFilter(TRAIN_EXPAND_LAYER, this._expandSelector(nextTids));
        this._applyHoverFilter();
        // Twins are pixel-identical to the base lines at their current
        // factor, so the base->twin swap is invisible — engage at once.
        this._setExpandOpacity(1);
        engage();
        if (this._expandT === 1) {
          // Already fully fanned (pointer slid between groups): nothing to
          // animate — but cancel any queued collapse frame or it would keep
          // sliding the lanes home.
          if (this._expandAnimId) {
            cancelAnimationFrame(this._expandAnimId);
            this._expandAnimId = null;
          }
          return;
        }
        this._animateExpand(1, null);
      } else {
        this._expandedTids = [];
        // Slide the lanes home first; only then swap the twins back for the
        // (identical) true-track lines and empty the expand source.
        this._animateExpand(0, () => {
          release();
          this._expandFilterTids = [];
          this._animGroup = null;
          this._pushExpandFC(null, 0);
          if (m.getLayer(TRAIN_EXPAND_LAYER))
            m.setFilter(TRAIN_EXPAND_LAYER, this._expandSelector([]));
          this._applyHoverFilter();
        });
      }
    },
    _setExpandOpacity(v) {
      const m = this._map;
      if (!m) return;
      [TRAIN_EXPAND_LAYER, TRAIN_EXPAND_HOVER_LAYER].forEach((id) => {
        if (m.getLayer(id)) m.setPaintProperty(id, "line-opacity", v);
      });
    },
    // Animate ONLY the lane-offset factor (the slide); opacity stays put.
    _animateExpand(target, done) {
      if (this._expandAnimId) cancelAnimationFrame(this._expandAnimId);
      this._expandAnimId = null;
      const from = this._expandT || 0;
      if (from === target) {
        if (this._animGroup) this._pushExpandFC(this._animGroup, target);
        if (done) done();
        return;
      }
      const dur = 240;
      const t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3); // ease-out
        const v = from + (target - from) * e;
        this._expandT = v;
        // Slide the fan: re-translate the group's lanes at this frame's
        // progress so the lines physically move out/in.
        if (this._animGroup) this._pushExpandFC(this._animGroup, v);
        if (k < 1) {
          this._expandAnimId = requestAnimationFrame(step);
        } else {
          this._expandAnimId = null;
          if (done) done();
        }
      };
      this._expandAnimId = requestAnimationFrame(step);
    },

    // ── interactions: route/marker click + hover, station hover popup ──
    _wireInteractions() {
      const map = this._map;
      const self = this;
      const PAD = 6; // px hit slop around the pointer for line picking

      // preferLanes (hover only): while a fan is expanded, the fanned trains'
      // own station dots must not steal the pointer from the lanes — sliding
      // along the fan would flicker hover/tooltip at every station. Clicks
      // keep marker precedence so a station dot still opens its stop popup.
      function queryAt(point, preferLanes) {
        const markerLayers = [
          TRAIN_SEL_STOPS_LAYER,
          TRAIN_SEL_PASS_LAYER,
          TRAIN_STOPS_LAYER,
          TRAIN_PASS_LAYER,
        ].filter((id) => map.getLayer(id));
        const pickLayers = [TRAIN_PICK_LAYER].filter((id) => map.getLayer(id));
        const bbox = [
          [point.x - PAD, point.y - PAD],
          [point.x + PAD, point.y + PAD],
        ];
        let markerHit = null;
        const mk = map.queryRenderedFeatures(bbox, { layers: markerLayers });
        if (mk.length) {
          const rec = self._markers && self._markers[mk[0].properties.idx];
          // nopick dots (off-date trains while a day is active) are drawn but
          // never interactive — ignore the hit instead of returning it.
          if (rec && !rec.nopick) markerHit = { kind: "marker", record: rec };
        }
        const markerYieldsToFan =
          markerHit &&
          preferLanes &&
          self._expandedTids.length &&
          markerHit.record.train &&
          self._expandedTids.includes(markerHit.record.train.id);
        if (markerHit && !markerYieldsToFan) return markerHit;
        // Routes are picked against the invisible PICK lanes. Where trains
        // overlap, each train owns its own parallel lane (date-ordered
        // left→right / top→bottom), so query the EXACT cursor point first —
        // that resolves to the single lane under the pointer and lets a small
        // sideways mouse move step between the parallel trains. Only if the
        // exact point misses do we retry with the padded box (thin isolated
        // lines stay easy to grab).
        let rt = map.queryRenderedFeatures(point, { layers: pickLayers });
        if (!rt.length)
          rt = map.queryRenderedFeatures(bbox, { layers: pickLayers });
        if (rt.length) {
          const rec = self._records[rt[0].properties.idx];
          if (rec) return { kind: "route", record: rec };
        }
        return markerHit;
      }

      map.on("click", (e) => {
        const hit = queryAt(e.point);
        if (!hit) {
          // Blank ground (no route lane, no station dot): let the app react —
          // it switches the date filter back to "全部" so every date's routes
          // show. MapLibre suppresses click after a drag, so panning is safe.
          if (self._handlers.onBackgroundClick)
            self._handlers.onBackgroundClick({
              coordinate: [e.lngLat.lng, e.lngLat.lat],
            });
          return;
        }
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

      // Coalesce hover work to one pass per animation frame. mousemove can
      // fire at 120+ Hz on high-refresh pointing devices while each pass costs
      // up to four queryRenderedFeatures + tooltip DOM writes — frame-scale
      // work. Only the latest pointer position matters, so intermediate events
      // are dropped instead of queued.
      const processHover = () => {
        self._hoverRafId = null;
        const point = self._pendingHoverPoint;
        if (!point) return;
        const hit = queryAt(point, true);
        const id = hit && hit.record.train ? hit.record.train.id : null;
        // Hover-expand: pointer on an overlapped run fans that group's lines
        // out into their date-ordered lanes; empty ground collapses. Marker
        // hits (station dots take pick precedence) keep the current state so
        // sweeping along an expanded fan doesn't flicker at every station.
        const group =
          hit && hit.kind === "route"
            ? hit.record.overlapCount > 1
              ? hit.record.groupKey || null
              : null
            : hit && hit.kind === "marker"
              ? self._expandedGroup
              : null;
        self._setExpandedGroup(group);
        if (id !== self._hoverTrainId) {
          self._hoverTrainId = id;
          self._applyHoverFilter();
          if (self._handlers.onHover) self._handlers.onHover(id);
        }
        map.getCanvas().style.cursor = hit ? "pointer" : "";
        self._showTooltip(hit, point);
        self._maybeStationPopup(hit ? null : point);
      };
      map.on("mousemove", (e) => {
        self._pendingHoverPoint = e.point;
        if (self._hoverRafId === null || self._hoverRafId === undefined)
          self._hoverRafId = requestAnimationFrame(processHover);
      });
      map.getCanvas().addEventListener("mouseleave", () => {
        self._pendingHoverPoint = null;
        if (self._hoverRafId !== null && self._hoverRafId !== undefined) {
          cancelAnimationFrame(self._hoverRafId);
          self._hoverRafId = null;
        }
        self._setExpandedGroup(null);
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
      const record = hit ? hit.record : null;
      // Same hovered record as last time: the HTML can't have changed (it is
      // derived from the record alone), so just follow the pointer instead of
      // re-running getTooltip + innerHTML on every movement.
      if (record === this._tooltipRecord) {
        if (record && point && el.style.display !== "none") {
          el.style.left = point.x + 12 + "px";
          el.style.top = point.y + 12 + "px";
        }
        return;
      }
      this._tooltipRecord = record;
      const tip =
        record && this._handlers.getTooltip
          ? this._handlers.getTooltip({ object: record })
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
      // The network stations layer is OFF by default; getLayer() still finds a
      // hidden layer, so without this guard every idle mousemove paid a
      // queryRenderedFeatures against a layer that can never be hovered.
      if (map.getLayoutProperty(STATIONS_LAYER, "visibility") === "none") {
        this._removeStationPopup();
        return;
      }
      const feats = map.queryRenderedFeatures(point, { layers: [STATIONS_LAYER] });
      if (!feats.length) {
        this._removeStationPopup();
        return;
      }
      const p = feats[0].properties;
      // Same station as the popup already showing: skip the model rebuild +
      // setHTML + addTo churn (this used to run on every mousemove pixel).
      const popupKey = p.stationId + "|" + (p.lineId || "");
      if (this._stationPopup && this._stationPopupKey === popupKey) {
        map.getCanvas().style.cursor = "default";
        return;
      }
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
      this._stationPopupKey = popupKey;
      this._stationPopup
        .setLngLat(feats[0].geometry.coordinates)
        .setHTML(stationPopupHtml(model))
        .addTo(map);
    },
    _removeStationPopup() {
      this._stationPopupKey = null;
      if (this._stationPopup) this._stationPopup.remove();
    },
  };

  global.RailMap = RailMap;
})(window);
