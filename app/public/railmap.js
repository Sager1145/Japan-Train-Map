/*
 * railmap.js — MapLibre GL map core, styled after yzhouwang/railprint.
 *
 * This module is a faithful port of railprint's map styling stack
 * (src/design/tokens.ts + src/lib/map/basemap.ts + src/lib/map/style.ts +
 * src/lib/map/popup.ts) into a dependency-free browser script:
 *
 *   - BASEMAP: OpenFreeMap `positron` for the light theme and OpenFreeMap's
 *     official `dark` style for the dark theme. If the online tile source is
 *     unavailable, the rail renders over a theme-matched plain background.
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
  const BASEMAP_STYLE_URLS = {
    light: "./basemap/positron.json",
    dark: "https://tiles.openfreemap.org/styles/dark",
  };
  const MAP_SURFACE_COLORS = {
    light: { background: "rgb(242,243,240)", fade: "#FFFFFF", casing: "#1A1A1A" },
    dark: { background: "rgb(12,12,12)", fade: "#0C0C0C", casing: "#F5EEE9" },
  };

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

  function replaceStyleLiteral(value, from, to) {
    if (Array.isArray(value))
      return value.map((item) => replaceStyleLiteral(item, from, to));
    return value === from ? to : value;
  }

  async function loadBasemap(theme, force) {
    // Backward compatibility with the former loadBasemap(force) signature.
    if (typeof theme === "boolean") {
      force = theme;
      theme = "light";
    }
    theme = theme === "dark" ? "dark" : "light";
    // No network ⇒ basemap-less on purpose (the vector tile fetches would fail).
    // `force` (the explicit online-retry path) skips the cheap navigator.onLine
    // gate and lets the fetch + origin probe decide.
    if (!force && typeof navigator !== "undefined" && navigator.onLine === false)
      return null;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), LOAD_TIMEOUT_MS) : null;
    try {
      const res = await fetch(
        BASEMAP_STYLE_URLS[theme],
        ctl ? { signal: ctl.signal } : undefined,
      );
      if (!res.ok) return null;
      const basemap = normalizeBasemap(await res.json());
      if (basemap) {
        basemap.theme = theme;
        // The official Dark style currently refers to "circle-11", while the
        // official shared sprite exposes the matching icon as "circle_11".
        // Correct that compatibility typo locally to avoid missing city dots.
        if (theme === "dark") {
          basemap.layers = basemap.layers.map((layer) => {
            if (!layer.layout || layer.layout["icon-image"] == null) return layer;
            return Object.assign({}, layer, {
              layout: Object.assign({}, layer.layout, {
                "icon-image": replaceStyleLiteral(
                  layer.layout["icon-image"],
                  "circle-11",
                  "circle_11",
                ),
              }),
            });
          });
        }
      }
      return basemap;
    } catch (e) {
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  // The light style JSON is vendored, so re-loading it can "succeed" without
  // connectivity. Before splicing either theme into the map, verify the remote
  // tile origin is actually reachable (sprite JSON is the smallest stable asset).
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
  // Loads the jp-2025 rail package in its compact-v1 format (stations and
  // segments nested per line, derivable fields omitted — see
  // scripts/railpkg.py for the format spec) and builds the two GeoJSON
  // collections + the geo index the hover popup needs (buildSegmentCollection /
  // buildStationCollection / geo-index, ported).
  //   station row: [stationGroupId, name, lon, lat, (nameRoma, romaSourceCode)]
  //   segment row: [km, sharedFirstPoint, coordinates, (arcDirection)]
  //   segment i joins station i to station (i+1) % n (loop lines close the ring)
  async function loadNetwork() {
    try {
      const res = await fetch("./rail/jp-2025.json");
      if (!res.ok) return null;
      const pkg = await res.json();
      if (!pkg || pkg.format !== "compact-v1" || !Array.isArray(pkg.lines))
        return null;

      const ROMA_SOURCE = { 1: "osm", 2: "wikidata" };
      const lineById = new Map();
      const stationById = new Map();
      const groupMembers = new Map(); // groupKey -> [station, ...]
      const segFeatures = [];
      const stFeatures = [];

      for (const cl of pkg.lines) {
        const lid = cl.id;
        const n = cl.stations.length;
        const color = cl.color || DEFAULT_LINE_COLOR;
        const lineMinz = minzForRank(cl.rank);
        const stationIds = cl.stations.map((row) => lid + ":" + row[0]);

        let km = 0;
        for (const row of cl.segments) km += row[0];

        lineById.set(lid, {
          lineId: lid,
          name: cl.name,
          operator: cl.operator,
          nameRoma: cl.nameRoma,
          isHSR: !!cl.isHSR,
          isLoop: !!cl.isLoop,
          rank: cl.rank,
          color: cl.color,
          logo: cl.logo ? "/rail/logos/" + lid + ".png" : null,
          stationOrder: stationIds,
          km,
        });

        // Segments — one LineString each, static official `color` + `minz`.
        // A row's `shared` flag means its first coordinate is the previous
        // segment's last and was omitted on disk.
        let prevLast = null;
        for (let i = 0; i < cl.segments.length; i++) {
          const row = cl.segments[i];
          const coords = row[1] ? [prevLast].concat(row[2]) : row[2];
          prevLast = coords[coords.length - 1];
          segFeatures.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: coords },
            properties: {
              segmentId:
                lid + ":" + cl.stations[i][0] + "-" + cl.stations[(i + 1) % n][0],
              lineId: lid,
              color,
              minz: lineMinz,
            },
          });
        }

        // Stations — spacing-derived dot reveal zoom, termini anchor at line zoom.
        const dotMinz = stationMinzForLine(lineMinz, km, n);
        const termini =
          !cl.isLoop && n >= 2
            ? new Set([stationIds[0], stationIds[n - 1]])
            : null;
        for (let i = 0; i < n; i++) {
          const row = cl.stations[i];
          const st = {
            stationId: stationIds[i],
            name: row[1],
            lineId: lid,
            seq: i,
            lon: row[2],
            lat: row[3],
            stationGroupId: row[0],
          };
          if (row.length > 4) {
            st.nameRoma = row[4];
            st.romaSource = ROMA_SOURCE[row[5]];
          }
          stationById.set(st.stationId, st);
          const gk = st.stationGroupId || "solo:" + st.stationId;
          let arr = groupMembers.get(gk);
          if (!arr) groupMembers.set(gk, (arr = []));
          arr.push(st);
          stFeatures.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [st.lon, st.lat] },
            properties: {
              stationId: st.stationId,
              lineId: lid,
              name: st.name,
              nameRoma: st.nameRoma || "",
              stationGroupId: st.stationGroupId || "",
              minz: termini && termini.has(st.stationId) ? lineMinz : dotMinz,
            },
          });
        }
      }

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
  const TRAIN_ROUTES_SOURCE = "train-routes";
  const TRAIN_PICK_SOURCE = "train-routes-pick";
  const TRAIN_EXPAND_SOURCE = "train-routes-expand-src";
  const TRAIN_MARKERS_SOURCE = "train-markers-base";
  const FIT_CURVES_SOURCE = "train-fit-curves-src";
  const HOVER_REGIONS_SOURCE = "train-hover-regions-src";
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
  const FIT_CURVES_CASING_LAYER = "train-fit-curves-casing";
  const FIT_CURVES_LAYER = "train-fit-curves-line";
  const HOVER_REGIONS_FILL_LAYER = "train-hover-regions-fill";
  const HOVER_REGIONS_LINE_LAYER = "train-hover-regions-line";

  const EMPTY_FC = { type: "FeatureCollection", features: [] };
  const NO_TRAIN = "__none__";
  // A filter that can never match (empty tid whitelist).
  const MATCH_NONE = ["in", ["get", "tid"], ["literal", []]];
  // HOVER SPOTLIGHT: while a route (or an expanded parallel group) is
  // hovered, every OTHER train's lines and station dots fade to this opacity
  // multiplier. Applied purely via paint expressions (no source updates).
  const HOVER_DIM = 0.15;
  // Hover hit geometry in SCREEN pixels. Fresh entry stays forgiving at 6px,
  // but an active hover now releases after roughly 8–9px instead of the old
  // 16–30px magnetic zone that forced a long mouse excursion to cancel.
  const HOVER_PICK_PAD_PX = 6;
  const HOVER_STICKY_PAD_PX = 4;
  const HOVER_FAN_HOLD_PX = 8;
  const HOVER_GROUP_SWITCH_PX = 6;
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

  // Selected marker growth stays role-aware: a terminal keeps the full focus
  // boost, while an intermediate stop grows by exactly the same amount as a
  // pass-through marker. The small black center dot scales proportionally but
  // never expands to cover its white outer circle.
  function selectedStopRadiusExpr(focusBoost) {
    const boost = Math.max(0, Number(focusBoost) || 0);
    return markerRadiusExpr([
      "*",
      boost,
      ["coalesce", ["get", "focusScale"], 0.5],
    ]);
  }

  const SELECTED_STOP_STROKE_SCALE = [
    "case",
    ["==", ["get", "role"], "terminal"],
    2,
    1,
  ];

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
    const theme = opts.theme === "dark" ? "dark" : "light";
    const themeColors = MAP_SURFACE_COLORS[theme];
    const fadeOpacity = Math.max(0, Math.min(1, Number(opts.fadeOpacity || 0)));

    const sources = Object.assign({}, basemap ? basemap.sources : {});
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
    sources[FIT_CURVES_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[HOVER_REGIONS_SOURCE] = { type: "geojson", data: EMPTY_FC };
    // Pass-through dot LOD: below this zoom the (numerous) white dots simply
    // don't draw — a layer property, so crossing it re-renders nothing.
    const passMinzoom = Math.max(0, Number(opts.passMinzoom || 0));

    const layers = [];
    // Plain background used for the explicit no-basemap mode and graceful
    // degradation when the online style is unavailable.
    layers.push({
      id: "rp-bg",
      type: "background",
      paint: { "background-color": themeColors.background },
    });
    // The basemap layer stack splits around its FIRST symbol (label) layer:
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
      paint: {
        "background-color": themeColors.fade,
        "background-opacity": fadeOpacity,
      },
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
      layout: {
        "circle-sort-key": [
          "case",
          ["==", ["get", "role"], "stop-center"],
          2,
          1,
        ],
      },
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
        "line-color": themeColors.casing,
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
      layout: {
        "circle-sort-key": [
          "case",
          ["==", ["get", "role"], "stop-center"],
          2,
          1,
        ],
      },
      paint: markerCirclePaint({
        sel: true,
        strokeScale: SELECTED_STOP_STROKE_SCALE,
      }),
    });

    // Direction-fit debug overlay. These are intentionally the LAST style
    // layers so the exact curve used by hover direction remains visible above
    // routes, expanded lanes, markers and basemap labels. A black casing plus
    // white dashed core gives an inverse/high-contrast read on every colour.
    layers.push({
      id: FIT_CURVES_CASING_LAYER,
      type: "line",
      source: FIT_CURVES_SOURCE,
      layout: {
        visibility: "none",
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": "#000000",
        "line-opacity": 0.92,
        "line-width": 6,
        "line-dasharray": [2.2, 1.8],
      },
    });
    layers.push({
      id: FIT_CURVES_LAYER,
      type: "line",
      source: FIT_CURVES_SOURCE,
      layout: {
        visibility: "none",
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": "#ffffff",
        "line-opacity": 1,
        "line-width": 2.5,
        "line-dasharray": [2.2, 1.8],
      },
    });

    // Screen-space hover diagnostics, converted to geographic polygons on
    // each pointer frame. Cyan = active route query box, orange = temporary
    // fan hold radius, magenta = overlap-group switch deadzone. These remain
    // last in the style so the real monitored area is never hidden by labels.
    const hoverRegionColor = [
      "match",
      ["get", "kind"],
      "pick",
      "#00d5ff",
      "hold",
      "#ff9800",
      "switch",
      "#ff2db2",
      "#ffffff",
    ];
    layers.push({
      id: HOVER_REGIONS_FILL_LAYER,
      type: "fill",
      source: HOVER_REGIONS_SOURCE,
      layout: { visibility: "none" },
      paint: {
        "fill-color": hoverRegionColor,
        "fill-opacity": 0.14,
      },
    });
    layers.push({
      id: HOVER_REGIONS_LINE_LAYER,
      type: "line",
      source: HOVER_REGIONS_SOURCE,
      layout: {
        visibility: "none",
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": hoverRegionColor,
        "line-opacity": 0.95,
        "line-width": 2.5,
        "line-dasharray": [2, 1.2],
      },
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

  // Pick geometry — STATE-AWARE. Hover must only trigger directly ON a
  // visible line, never across the not-yet-expanded fan region:
  //   collapsed  -> every record's hit geometry sits on the TRUE TRACK
  //                 (where the line is actually drawn), narrow width;
  //   fan open   -> ONLY the open group's member records move to their
  //                 per-lane offset paths (matching the visibly fanned
  //                 lines; the spacing-wide lanes tile the corridor so the
  //                 pointer can slide between the parallel lines).
  // `idx` maps a picked feature back to the full record in _records
  // (tooltip lane info, click target, group key).
  function routePickRecordsToFC(
    records,
    groupInfo,
    openGroup,
    fanDir,
    fanSpacingDeg,
    transition,
  ) {
    const features = records.map((r, i) => {
      const tid = (r.train && r.train.id) || "";
      const transitioning = Boolean(
        transition &&
          (r.groupKey === transition.fromGroup ||
            r.groupKey === transition.toGroup),
      );
      const fanned = Boolean(
        transitioning || (openGroup && r.groupKey === openGroup),
      );
      // Fanned hit areas follow the CURRENT dynamic fan direction (the
      // smoothed-corridor perpendicular under the pointer) so they always
      // sit on the visibly fanned lines; static pickPath is the fallback.
      let coords = r.path;
      if (fanned) {
        if (transitioning) {
          const off = transitionOffsetForTid(
            transition,
            tid,
            fanSpacingDeg,
            fanDir,
          );
          coords = r.path.map((p) => [p[0] + off.dx, p[1] + off.dy]);
        } else if (fanDir && r.laneMult != null && fanSpacingDeg) {
          const dx = fanDir.sx * r.laneMult * fanSpacingDeg;
          const dy = fanDir.sy * r.laneMult * fanSpacingDeg;
          coords = r.path.map((p) => [p[0] + dx, p[1] + dy]);
        } else {
          coords = r.pickPath || r.path;
        }
      }
      return {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: coords,
        },
        properties: {
          idx: i,
          tid,
          pickWidth:
            fanned && r.pickWidth != null
              ? r.pickWidth
              : Math.max(r.width + 8, 14),
          nopick: r.nopick ? 1 : 0,
        },
      };
    });
    // Source-feature seams have no visible geometry between their endpoints,
    // but they are part of the same overlap corridor. Tiny pick-only bridges
    // keep that corridor continuous both before and after the fan opens.
    if (groupInfo)
      groupInfo.forEach((gi, groupKey) => {
        (gi.pickBridges || []).forEach((bridge) => {
          const transitioning = Boolean(
            transition &&
              (groupKey === transition.fromGroup ||
                groupKey === transition.toGroup),
          );
          const fanned = Boolean(
            transitioning || (openGroup && groupKey === openGroup),
          );
          let coords = bridge.path;
          if (fanned) {
            let dx;
            let dy;
            if (transitioning) {
              const off = transitionOffsetForTid(
                transition,
                bridge.tid,
                fanSpacingDeg,
                fanDir,
              );
              dx = off.dx;
              dy = off.dy;
            } else {
              const d = fanDir || gi;
              dx = d.sx * bridge.laneMult * fanSpacingDeg;
              dy = d.sy * bridge.laneMult * fanSpacingDeg;
            }
            coords = bridge.path.map((p) => [p[0] + dx, p[1] + dy]);
          }
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: coords },
            properties: {
              idx: bridge.idx,
              tid: bridge.tid,
              pickWidth: bridge.pickWidth,
              nopick: 0,
            },
          });
        });
      });
    return { type: "FeatureCollection", features };
  }

  // HOVER-EXPAND geometry for ONE hovered group: every member train's
  // complete course (all its lines), RIGIDLY translated into its lane by the
  // group's constant shift vector — corners, radii and lengths untouched
  // (colorA has the record's alpha baked in). `gi` comes from app.js's
  // buildDeckRouteRecords groupInfo; spacingDeg is the current lane spacing.
  function routeExpandFC(expandRecords, gi, spacingDeg, dir) {
    if (!gi) return EMPTY_FC;
    const d = dir || gi; // dynamic hover direction, else the static vector
    const features = [];
    expandRecords.forEach((r, i) => {
      const tid = (r.train && r.train.id) || "";
      const mult = gi.mults[tid];
      if (mult === undefined) return; // not a member of the hovered group
      const dx = d.sx * mult * spacingDeg;
      const dy = d.sy * mult * spacingDeg;
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

  function transitionOffsetForTid(transition, tid, spacingDeg, toDir) {
    const fromGi = transition.fromGi;
    const toGi = transition.toGi;
    const hasFromOffset =
      transition.fromOffsets &&
      Object.prototype.hasOwnProperty.call(transition.fromOffsets, tid);
    const fromMult =
      !hasFromOffset &&
      fromGi &&
      Object.prototype.hasOwnProperty.call(fromGi.mults, tid)
        ? fromGi.mults[tid]
        : 0;
    const toMult =
      toGi && Object.prototype.hasOwnProperty.call(toGi.mults, tid)
        ? toGi.mults[tid]
        : 0;
    const fromDir = transition.fromDir || fromGi || { sx: 0, sy: 0 };
    const nextDir = toDir || toGi || { sx: 0, sy: 0 };
    const t = Math.max(0, Math.min(1, transition.progress || 0));
    const ox = hasFromOffset
      ? transition.fromOffsets[tid].x * spacingDeg
      : fromDir.sx * fromMult * spacingDeg;
    const oy = hasFromOffset
      ? transition.fromOffsets[tid].y * spacingDeg
      : fromDir.sy * fromMult * spacingDeg;
    const nx = nextDir.sx * toMult * spacingDeg;
    const ny = nextDir.sy * toMult * spacingDeg;
    return { dx: ox + (nx - ox) * t, dy: oy + (ny - oy) * t };
  }

  // Interpolate the UNION of two overlap groups. Shared trains travel directly
  // from their old lane to the new one; old-only trains glide home while
  // new-only trains leave the true track. No source swap is visually exposed.
  function routeExpandTransitionFC(
    expandRecords,
    transition,
    spacingDeg,
    toDir,
  ) {
    if (!transition || !transition.fromGi || !transition.toGi) return EMPTY_FC;
    const features = [];
    expandRecords.forEach((r, i) => {
      const tid = (r.train && r.train.id) || "";
      if (
        !(
          transition.fromOffsets &&
          Object.prototype.hasOwnProperty.call(transition.fromOffsets, tid)
        ) &&
        !Object.prototype.hasOwnProperty.call(transition.fromGi.mults, tid) &&
        !Object.prototype.hasOwnProperty.call(transition.toGi.mults, tid)
      )
        return;
      const off = transitionOffsetForTid(
        transition,
        tid,
        spacingDeg,
        toDir,
      );
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: r.path.map((p) => [p[0] + off.dx, p[1] + off.dy]),
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

  function curvePointAt(curve, metres) {
    const pts = curve.pts;
    const cum = curve.cum;
    const target = Math.max(0, Math.min(curve.totalMeters, metres));
    let lo = 0;
    let hi = cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid;
      else hi = mid;
    }
    const span = cum[lo + 1] - cum[lo] || 1;
    const t = (target - cum[lo]) / span;
    return [
      pts[lo][0] + (pts[lo + 1][0] - pts[lo][0]) * t,
      pts[lo][1] + (pts[lo + 1][1] - pts[lo][1]) * t,
    ];
  }

  // Continuous local perpendicular of the heavily low-passed corridor curve.
  // Direction is interpolated from app.js's precomputed broad-scale unit
  // tangents, so switching the nearest polyline segment cannot change the
  // fitting window. `hintS` keeps the projection on the same local branch at a
  // tiny protrusion/self-near bend; it yields only when a truly closer branch
  // is more than 70 physical metres away from the hinted neighbourhood.
  function fanPerpAt(curve, lngLat, hintS) {
    const pts = curve.pts;
    const cs = curve.coslat;
    const px = lngLat.lng * cs;
    const py = lngLat.lat;
    let globalHit = null;
    let localHit = null;
    const localRadius = Math.min(
      6500,
      Math.max(1200, (curve.radiusMeters || 800) * 2.4),
    );
    for (let i = 0; i < pts.length - 1; i += 1) {
      const ax = pts[i][0] * cs;
      const ay = pts[i][1];
      const vx = pts[i + 1][0] * cs - ax;
      const vy = pts[i + 1][1] - ay;
      const l2 = vx * vx + vy * vy || 1e-12;
      let t = ((px - ax) * vx + (py - ay) * vy) / l2;
      t = Math.max(0, Math.min(1, t));
      const dx = px - (ax + vx * t);
      const dy = py - (ay + vy * t);
      const d2 = dx * dx + dy * dy;
      const s = curve.cum[i] + (curve.cum[i + 1] - curve.cum[i]) * t;
      const hit = { d2, s, i, t, tx: vx, ty: vy };
      if (!globalHit || d2 < globalHit.d2) globalHit = hit;
      if (
        hintS != null &&
        Math.abs(s - hintS) <= localRadius &&
        (!localHit || d2 < localHit.d2)
      )
        localHit = hit;
    }
    if (!globalHit) return { x: 0, y: -1, s: 0, distance2: Infinity };
    const toleranceDeg = 70 / 111320;
    const hit =
      localHit && localHit.d2 <= globalHit.d2 + toleranceDeg * toleranceDeg
        ? localHit
        : globalHit;
    const dirs = curve.dirs;
    let tx;
    let ty;
    if (dirs && dirs[hit.i] && dirs[hit.i + 1]) {
      tx = dirs[hit.i][0] + (dirs[hit.i + 1][0] - dirs[hit.i][0]) * hit.t;
      ty = dirs[hit.i][1] + (dirs[hit.i + 1][1] - dirs[hit.i][1]) * hit.t;
    } else {
      // Compatibility with an older cached curve during hot reload.
      const radius = curve.radiusMeters || 800;
      const p0 = curvePointAt(curve, hit.s - radius);
      const p1 = curvePointAt(curve, hit.s + radius);
      tx = (p1[0] - p0[0]) * cs;
      ty = p1[1] - p0[1];
    }
    if (Math.hypot(tx, ty) < 1e-12) {
      tx = hit.tx;
      ty = hit.ty;
    }
    const len = Math.hypot(tx, ty) || 1;
    return {
      x: ty / len,
      y: -tx / len,
      s: hit.s,
      distance2: hit.d2,
    }; // right-hand perpendicular
  }

  function fitCurvesToFC(groupInfo) {
    const features = [];
    const seen = new Set();
    if (groupInfo)
      groupInfo.forEach((gi, groupKey) => {
        const curve = gi && gi.curve;
        if (!curve || seen.has(curve) || !curve.pts || curve.pts.length < 2)
          return;
        seen.add(curve);
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: curve.pts },
          properties: {
            groupKey,
            samples: curve.pts.length,
            lengthM: Math.round(curve.totalMeters || 0),
            radiusM: Math.round(curve.radiusMeters || 0),
            sigmaM: Math.round(curve.smoothingSigmaMeters || 0),
            requestedMinRadiusM: Math.round(
              curve.requestedMinRadiusMeters || 0,
            ),
            achievedMinRadiusM:
              curve.achievedMinRadiusMeters == null
                ? null
                : Math.round(curve.achievedMinRadiusMeters),
            achievedDirectionRadiusM:
              curve.achievedDirectionRadiusMeters == null
                ? null
                : Math.round(curve.achievedDirectionRadiusMeters),
            minDetailM: Math.round(curve.minDetailMeters || 0),
            maxDeviationM: Math.round(curve.maxDeviationMeters || 0),
            actualMaxDeviationM: Math.round(
              curve.actualMaxDeviationMeters || 0,
            ),
            fitType: curve.fitType || "",
          },
        });
      });
    return { type: "FeatureCollection", features };
  }

  function angleDelta(a, b) {
    if (!a || !b) return 0;
    const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y));
    return (Math.acos(dot) * 180) / Math.PI;
  }

  // Deterministic pointer-equivalent sweep over EVERY fitted overlap curve.
  // Each sample is projected through fanPerpAt with the previous arc position
  // as its hint, exactly like a real mouse traversal. The compact report is
  // published on the map container for browser regression checks.
  function diagnoseFitCurves(groupInfo) {
    const curves = [];
    const seen = new Set();
    let nearParallelGroups = 0;
    let nearParallelMaxSeparationMeters = 0;
    const nearParallelSamples = [];
    if (groupInfo)
      groupInfo.forEach((gi, groupKey) => {
        if (gi && gi._nearParallel) {
          nearParallelGroups += 1;
          nearParallelMaxSeparationMeters = Math.max(
            nearParallelMaxSeparationMeters,
            Number(gi._nearParallel.maxSeparationMeters) || 0,
          );
          const line = gi._line || [];
          const middle = line.length ? line[Math.floor(line.length / 2)] : null;
          nearParallelSamples.push({
            groupKey,
            lng: middle ? +middle[0].toFixed(5) : null,
            lat: middle ? +middle[1].toFixed(5) : null,
            trains: Object.keys(gi.mults || {}).sort(),
            maxSeparationMeters: +(
              Number(gi._nearParallel.maxSeparationMeters) || 0
            ).toFixed(1),
          });
        }
        const curve = gi && gi.curve;
        if (!curve || seen.has(curve) || !curve.pts || curve.pts.length < 2)
          return;
        seen.add(curve);
        curves.push({ groupKey, gi, curve });
      });
    let samples = 0;
    let backtracks = 0;
    let directionJumps = 0;
    let maxStepDeg = 0;
    let radiusMeasurements = 0;
    let radiusShortfalls = 0;
    let minRadiusRatio = Infinity;
    let directionRadiusMeasurements = 0;
    let directionRadiusShortfalls = 0;
    let minDirectionRadiusRatio = Infinity;
    let deviationMeasurements = 0;
    let deviationOverruns = 0;
    let maxDeviationRatio = 0;
    let stationContinuousCurves = 0;
    let stationJoinsRounded = 0;
    const fitTypes = new Set();
    const radiusFlaggedGroups = [];
    const flaggedGroups = [];
    curves.forEach(({ groupKey, curve }) => {
      if (curve.fitType) fitTypes.add(curve.fitType);
      if (curve.stationJoinCount > 0) {
        stationContinuousCurves += 1;
        stationJoinsRounded += curve.stationJoinCount;
      }
      if (
        curve.requestedMinRadiusMeters > 0 &&
        curve.achievedMinRadiusMeters != null
      ) {
        const ratio =
          curve.achievedMinRadiusMeters / curve.requestedMinRadiusMeters;
        radiusMeasurements += 1;
        minRadiusRatio = Math.min(minRadiusRatio, ratio);
        if (ratio < 0.999) {
          radiusShortfalls += 1;
          radiusFlaggedGroups.push({
            groupKey,
            requestedM: Math.round(curve.requestedMinRadiusMeters),
            achievedM: Math.round(curve.achievedMinRadiusMeters),
            sourceLengthM: Math.round(curve.sourceTotalMeters || 0),
            chordM: Math.round(curve.endpointChordMeters || 0),
            ratio: +ratio.toFixed(3),
            fitType: curve.fitType || null,
            stationJoinCount: curve.stationJoinCount || 0,
            stationSmoothingPasses: curve.stationSmoothingPasses || 0,
          });
        }
      }
      if (
        curve.requestedMinRadiusMeters > 0 &&
        curve.achievedDirectionRadiusMeters != null
      ) {
        const ratio =
          curve.achievedDirectionRadiusMeters /
          curve.requestedMinRadiusMeters;
        directionRadiusMeasurements += 1;
        minDirectionRadiusRatio = Math.min(minDirectionRadiusRatio, ratio);
        if (ratio < 0.999) directionRadiusShortfalls += 1;
      }
      if (
        curve.maxDeviationMeters > 0 &&
        curve.actualMaxDeviationMeters != null
      ) {
        const ratio =
          curve.actualMaxDeviationMeters / curve.maxDeviationMeters;
        deviationMeasurements += 1;
        maxDeviationRatio = Math.max(maxDeviationRatio, ratio);
        if (ratio > 1.02) deviationOverruns += 1;
      }
      let hintS = null;
      let previous = null;
      let previousSampleIndex = null;
      let groupMax = 0;
      // fanPerpAt projects against the complete curve, so checking every one
      // of thousands of 30 m display samples becomes quadratic after station
      // corridors are joined. Uniformly cover every curve with at most 320
      // pointer-equivalent samples; all overlap intervals remain represented.
      const sampleStride = Math.max(1, Math.ceil(curve.pts.length / 320));
      const sampleAt = (sampleIndex) => {
        const p = curve.pts[sampleIndex];
        const current = fanPerpAt(
          curve,
          { lng: p[0], lat: p[1] },
          hintS,
        );
        samples += 1;
        if (hintS != null && current.s + 1 < hintS) backtracks += 1;
        const skippedSteps =
          previousSampleIndex == null
            ? 1
            : Math.max(1, sampleIndex - previousSampleIndex);
        const stepDeg = angleDelta(previous, current) / skippedSteps;
        if (stepDeg > groupMax) groupMax = stepDeg;
        if (stepDeg > maxStepDeg) maxStepDeg = stepDeg;
        if (stepDeg > 4) directionJumps += 1;
        hintS = current.s;
        previous = current;
        previousSampleIndex = sampleIndex;
      };
      let lastSample = -1;
      for (let i = 0; i < curve.pts.length; i += sampleStride) {
        sampleAt(i);
        lastSample = i;
      }
      if (lastSample !== curve.pts.length - 1) sampleAt(curve.pts.length - 1);
      if (groupMax > 4)
        flaggedGroups.push({ groupKey, maxStepDeg: +groupMax.toFixed(2) });
    });

    // Inspect all distinct fitted-curve endpoint pairs that geometrically
    // meet. Their target directions may differ, but the group transition rAF
    // interpolates them; reporting the worst angle makes boundary testing
    // explicit and reproducible.
    const ends = [];
    curves.forEach(({ groupKey, gi, curve }) => {
      [0, curve.pts.length - 1].forEach((i) => {
        const p = curve.pts[i];
        const raw = fanPerpAt(curve, { lng: p[0], lat: p[1] }, curve.cum[i]);
        const staticX = (gi.sx || 0) * curve.coslat;
        const staticY = gi.sy || 0;
        const flip = raw.x * staticX + raw.y * staticY < 0;
        ends.push({
          groupKey,
          p,
          dir: { x: flip ? -raw.x : raw.x, y: flip ? -raw.y : raw.y },
        });
      });
    });
    let boundaries = 0;
    let maxBoundaryDeg = 0;
    let rawMaxBoundaryDeg = 0;
    const boundaryFlaggedGroups = [];
    for (let i = 0; i < ends.length; i += 1)
      for (let j = i + 1; j < ends.length; j += 1) {
        if (ends[i].groupKey === ends[j].groupKey) continue;
        const lat = (ends[i].p[1] + ends[j].p[1]) / 2;
        const cs = Math.cos((lat * Math.PI) / 180) || 1e-6;
        const metres =
          Math.hypot(
            (ends[i].p[0] - ends[j].p[0]) * cs,
            ends[i].p[1] - ends[j].p[1],
          ) * 111320;
        if (metres > 180) continue;
        boundaries += 1;
        const rawDelta = angleDelta(ends[i].dir, ends[j].dir);
        rawMaxBoundaryDeg = Math.max(rawMaxBoundaryDeg, rawDelta);
        maxBoundaryDeg = Math.max(
          maxBoundaryDeg,
          Math.min(rawDelta, 180 - rawDelta),
        );
        const axisDelta = Math.min(rawDelta, 180 - rawDelta);
        if (axisDelta > 1)
          boundaryFlaggedGroups.push({
            a: ends[i].groupKey,
            b: ends[j].groupKey,
            lng: +((ends[i].p[0] + ends[j].p[0]) / 2).toFixed(5),
            lat: +((ends[i].p[1] + ends[j].p[1]) / 2).toFixed(5),
            metres: +metres.toFixed(1),
            deltaDeg: +axisDelta.toFixed(2),
          });
      }
    return {
      curves: curves.length,
      samples,
      appliedFitSettings: curves.length
        ? {
            precision: curves[0].curve.samplingPrecision,
            minRadiusM: curves[0].curve.requestedMinRadiusMeters,
            minDetailM: curves[0].curve.minDetailMeters,
            maxDeviationM: curves[0].curve.maxDeviationMeters,
          }
        : null,
      backtracks,
      directionJumps,
      maxStepDeg: +maxStepDeg.toFixed(2),
      fitTypes: Array.from(fitTypes).sort(),
      radiusMeasurements,
      radiusShortfalls,
      minRadiusRatio: isFinite(minRadiusRatio)
        ? +minRadiusRatio.toFixed(3)
        : null,
      radiusFlaggedGroups: radiusFlaggedGroups
        .sort((a, b) => a.ratio - b.ratio)
        .slice(0, 20),
      directionRadiusMeasurements,
      directionRadiusShortfalls,
      minDirectionRadiusRatio: isFinite(minDirectionRadiusRatio)
        ? +minDirectionRadiusRatio.toFixed(3)
        : null,
      deviationMeasurements,
      deviationOverruns,
      maxDeviationRatio: +maxDeviationRatio.toFixed(3),
      nearParallelGroups,
      nearParallelMaxSeparationMeters:
        +nearParallelMaxSeparationMeters.toFixed(1),
      nearParallelSamples: nearParallelSamples.slice(0, 100),
      stationContinuousCurves,
      stationJoinsRounded,
      boundaries,
      maxBoundaryDeg: +maxBoundaryDeg.toFixed(2),
      rawMaxBoundaryDeg: +rawMaxBoundaryDeg.toFixed(2),
      boundaryFlaggedGroups: boundaryFlaggedGroups
        .sort((a, b) => b.deltaDeg - a.deltaDeg)
        .slice(0, 20),
      flaggedGroups: flaggedGroups.slice(0, 20),
    };
  }

  function hoverRegionsToFC(map, state) {
    if (!map || !state || !state.point) return EMPTY_FC;
    const features = [];
    const lngLat = (x, y) => {
      const p = map.unproject([x, y]);
      return [p.lng, p.lat];
    };
    const polygon = (kind, ring, radiusPx) => {
      if (!ring.length) return;
      const closed = ring.concat([ring[0]]);
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [closed] },
        properties: { kind, radiusPx },
      });
    };
    const square = (kind, center, radiusPx) => {
      const x = center.x;
      const y = center.y;
      polygon(
        kind,
        [
          lngLat(x - radiusPx, y - radiusPx),
          lngLat(x + radiusPx, y - radiusPx),
          lngLat(x + radiusPx, y + radiusPx),
          lngLat(x - radiusPx, y + radiusPx),
        ],
        radiusPx,
      );
    };
    const circle = (kind, center, radiusPx) => {
      const ring = [];
      for (let i = 0; i < 48; i += 1) {
        const a = (i * Math.PI * 2) / 48;
        ring.push(
          lngLat(
            center.x + Math.cos(a) * radiusPx,
            center.y + Math.sin(a) * radiusPx,
          ),
        );
      }
      polygon(kind, ring, radiusPx);
    };
    square("pick", state.point, state.routePadPx || HOVER_PICK_PAD_PX);
    if (state.holdPoint)
      circle("hold", state.holdPoint, HOVER_FAN_HOLD_PX);
    if (state.switchPoint)
      circle("switch", state.switchPoint, HOVER_GROUP_SWITCH_PX);
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
          role: m.role || m.category,
          focusScale: m.focusScale == null ? 0.5 : m.focusScale,
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
    _networkPromise: null, // dedups concurrent ensureNetwork() lazy loads
    _handlers: {},
    _records: [],
    _expandRecords: [],
    _groupInfo: null, // groupKey → { sx, sy, mults } (rigid lane shifts)
    _laneSpacingDeg: 0,
    _markers: [],
    // Intermediate stops and trip terminals share two physical circle layers,
    // but their role filters remain independently toggleable in the map UI.
    _markerVisibility: { stop: true, terminal: true, pass: true },
    _visible: true,
    _fitCurvesVisible: false,
    _hoverRegionsVisible: false,
    _hoverDebugState: null,
    _selectedTrainId: null,
    _hoverTrainId: null,
    _expandedGroup: null,
    _expandedTids: [], // the hovered group's train set (expand target)
    _engagedTids: [], // trains whose true-track lines are currently hidden
    _expandFilterTids: [], // trains the expand layers currently show
    _expandT: 0,
    _expandAnimId: null,
    _groupTransition: null,
    _groupTransitionRaf: null,
    _tooltipEl: null,
    _tooltipRecord: null, // record the tooltip currently shows (dedup)
    _stationPopup: null,
    _stationPopupKey: null, // station|line the popup currently shows (dedup)
    _pendingHoverPoint: null, // latest mousemove point awaiting the rAF pass
    _hoverRafId: null,
    _lastGroupPoint: null, // px of the last real overlapped-run hit (fan hysteresis anchor)
    _groupSwitchCandidate: null,
    _groupSwitchAnchor: null,
    _basemapLayerIds: [],
    _basemapSourceIds: [],
    _basemapMode: "none",
    _theme: "light",
    _basemapInstalledTheme: null,
    _basemapRetryInflight: null, // dedups concurrent retryBasemap() calls

    attach(map, network, handlers, basemapLayerIds, basemapSourceIds, theme) {
      this._map = map;
      this._network = network || null;
      this._handlers = handlers || {};
      this._basemapLayerIds = basemapLayerIds || [];
      this._basemapSourceIds = basemapSourceIds || [];
      this._basemapMode = this._basemapLayerIds.length ? "positron" : "none";
      this._theme = theme === "dark" ? "dark" : "light";
      this._basemapInstalledTheme = this._basemapLayerIds.length
        ? this._theme
        : null;
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
      // A data rebuild replaces group objects, so finish any in-flight
      // cross-group interpolation at its current target before uploading.
      if (this._groupTransitionRaf) {
        cancelAnimationFrame(this._groupTransitionRaf);
        this._groupTransitionRaf = null;
      }
      this._groupTransition = null;
      this._records = records || [];
      this._expandRecords = expandRecords || [];
      this._groupInfo = groupInfo || new Map();
      this._laneSpacingDeg = laneSpacingDeg || 0;
      // Baseline zoom for the degree-valued spacing: while the map zooms,
      // _currentLaneSpacingDeg() rescales by 2^(z0 − z) so the fan keeps its
      // constant ON-SCREEN spacing continuously instead of drifting during
      // the gesture and snapping at zoomend.
      this._laneSpacingZoom = this._map ? this._map.getZoom() : null;
      this._pushRoutes();
      this._pushFitCurves();
      // The exhaustive pointer-equivalent sweep is intentionally debug-only:
      // normal route/date changes should not pay for it. Turning on the fitted
      // curve overlay runs and publishes the report immediately.
      if (this._fitCurvesVisible) this._refreshFitCurveDiagnostics();
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
      if (this._groupTransitionRaf) {
        cancelAnimationFrame(this._groupTransitionRaf);
        this._groupTransitionRaf = null;
      }
      this._groupTransition = null;
      this._groupSwitchCandidate = null;
      this._groupSwitchAnchor = null;
      this._fanSwitchFromDir = null;
      this._fanCurve = null;
      this._fanCurveS = null;
      this._fanCurveSign = 1;
      this._expandedGroup = null;
      this._expandedTids = [];
      this._expandFilterTids = [];
      this._engagedTids = [];
      this._expandT = 0;
      this._animGroup = null;
      this._setExpandOpacity(0);
      this._pushExpandFC(null, 0);
      this._pushPick();
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
      this._laneSpacingZoom = this._map ? this._map.getZoom() : null;
      this._pushPick();
      if (this._expandedGroup) this._pushExpandFC(this._expandedGroup);
      return this;
    },
    // Effective lane spacing at the CURRENT zoom. The app supplies spacing in
    // degrees computed for the zoom it was pushed at; degrees-per-pixel halve
    // with each zoom level, so rescaling by 2^(z0 − z) keeps the fan's pixel
    // spacing constant throughout the zoom gesture. (The small cos(lat) drift
    // from panning is corrected by the app's zoomend/moveend re-push.)
    _currentLaneSpacingDeg() {
      const base = this._laneSpacingDeg || 0;
      const m = this._map;
      if (!m || !base || this._laneSpacingZoom == null) return base;
      return base * Math.pow(2, this._laneSpacingZoom - m.getZoom());
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
    // the SEL line and role-aware marker paint expressions add it at draw time.
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
          selectedStopRadiusExpr(this._focusBoost),
        );
      if (m.getLayer(TRAIN_SEL_PASS_LAYER))
        m.setPaintProperty(
          TRAIN_SEL_PASS_LAYER,
          "circle-radius",
          markerRadiusExpr(this._focusBoost / 2),
        );
    },
    // Selection = pure layer filtering on the single marker source: the
    // selected train's dots leave the base layers and enter the SEL layers.
    _applyMarkerSelectionFilters() {
      const m = this._map;
      if (!m) return;
      const id = this._selectedTrainId || NO_TRAIN;
      const shown = this._markerVisibility || {
        stop: true,
        terminal: true,
        pass: true,
      };
      let stopRoleFilter = null;
      if (shown.stop === false && shown.terminal === false) {
        stopRoleFilter = MATCH_NONE;
      } else if (shown.stop === false) {
        stopRoleFilter = ["==", ["get", "role"], "terminal"];
      } else if (shown.terminal === false) {
        stopRoleFilter = ["!=", ["get", "role"], "terminal"];
      }
      const f = (cat, mine) => {
        const filters = [
          "all",
          ["==", ["get", "category"], cat],
          [mine ? "==" : "!=", ["get", "tid"], id],
        ];
        if (cat === "stop" && stopRoleFilter) filters.push(stopRoleFilter);
        return filters;
      };
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
    setFitCurvesVisible(v) {
      this._fitCurvesVisible = Boolean(v);
      const vis = this._fitCurvesVisible ? "visible" : "none";
      this._setVisibility(FIT_CURVES_CASING_LAYER, vis);
      this._setVisibility(FIT_CURVES_LAYER, vis);
      if (this._fitCurvesVisible) {
        this._pushFitCurves();
        this._refreshFitCurveDiagnostics();
      }
    },
    setHoverRegionsVisible(v) {
      this._hoverRegionsVisible = Boolean(v);
      const vis = this._hoverRegionsVisible ? "visible" : "none";
      this._setVisibility(HOVER_REGIONS_FILL_LAYER, vis);
      this._setVisibility(HOVER_REGIONS_LINE_LAYER, vis);
      if (!this._hoverRegionsVisible) {
        const src = this._src(HOVER_REGIONS_SOURCE);
        if (src) src.setData(EMPTY_FC);
      }
      this._pushHoverRegions(this._hoverDebugState);
    },
    setMarkerVisibility(category, v) {
      if (!this._markerVisibility)
        this._markerVisibility = { stop: true, terminal: true, pass: true };
      if (!(category in this._markerVisibility)) return;
      this._markerVisibility[category] = Boolean(v);
      if (category === "stop" || category === "terminal") {
        const anyStops =
          this._markerVisibility.stop || this._markerVisibility.terminal;
        const vis = anyStops ? "visible" : "none";
        this._setVisibility(TRAIN_STOPS_LAYER, vis);
        this._setVisibility(TRAIN_SEL_STOPS_LAYER, vis);
        this._applyMarkerSelectionFilters();
      } else if (category === "pass") {
        const vis = v ? "visible" : "none";
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
    // Lazily fetch + build + upload the 9.2 MB national-network package the
    // FIRST time it is actually needed (user opts into 全部鐵路線). The map is
    // built with EMPTY_FC network sources at boot (buildBaseStyle degrades that
    // way), so this just setData's the real collections into the two existing,
    // still-hidden sources. Deduped so concurrent toggles parse once.
    ensureNetwork() {
      if (this._network) return Promise.resolve(this._network);
      if (this._networkPromise) return this._networkPromise;
      const m = this._map;
      this._networkPromise = loadNetwork()
        .then((network) => {
          if (!network) {
            this._networkPromise = null; // allow a later retry
            return null;
          }
          this._network = network;
          if (m) {
            // Upload into the pre-created (still-hidden) EMPTY_FC sources.
            // Returns false if the style isn't ready yet (getSource undefined) —
            // e.g. the overlay is toggled during the initial map load — in which
            // case we apply once the style finishes ('load'), so the data is
            // never silently dropped.
            const applyNetwork = () => {
              const seg = m.getSource(SEGMENTS_SOURCE);
              const sta = m.getSource(STATIONS_SOURCE);
              if (seg) seg.setData(network.segments);
              if (sta) sta.setData(network.stations);
              return Boolean(seg && sta);
            };
            if (!applyNetwork() && typeof m.once === "function")
              m.once("load", applyNetwork);
          }
          return network;
        })
        .catch((e) => {
          this._networkPromise = null;
          console.warn("[railmap] network load failed:", e);
          return null;
        });
      return this._networkPromise;
    },
    // Basemap mode: 'positron' (online vector) | 'none'.
    setBasemapMode(mode) {
      this._basemapMode = mode === "positron" ? "positron" : "none";
      const posVis = mode === "positron" ? "visible" : "none";
      this._basemapLayerIds.forEach((id) => this._setVisibility(id, posVis));
    },
    // Whether the vector (online) basemap is present in the live style.
    hasBasemap() {
      return this._basemapLayerIds.length > 0;
    },
    _applyThemePaint(theme) {
      const m = this._map;
      if (!m) return;
      const colors = MAP_SURFACE_COLORS[theme === "dark" ? "dark" : "light"];
      if (m.getLayer("rp-bg"))
        m.setPaintProperty("rp-bg", "background-color", colors.background);
      if (m.getLayer(FADE_LAYER))
        m.setPaintProperty(FADE_LAYER, "background-color", colors.fade);
      if (m.getLayer(TRAIN_SEL_CASING_LAYER))
        m.setPaintProperty(TRAIN_SEL_CASING_LAYER, "line-color", colors.casing);
    },
    async _installBasemap(basemap) {
      const m = this._map;
      if (!m || !basemap) return false;
      const visible = this._basemapMode === "positron";
      const addedLayerIds = [];
      const addedSourceIds = [];
      try {
        // Remove only the previous basemap stack. Rail routes, markers,
        // interaction sources and camera state remain untouched.
        this._basemapLayerIds
          .slice()
          .reverse()
          .forEach((id) => {
            if (m.getLayer(id)) m.removeLayer(id);
          });
        this._basemapSourceIds.forEach((id) => {
          if (m.getSource(id)) m.removeSource(id);
        });

        for (const id of Object.keys(basemap.sources)) {
          if (!m.getSource(id)) {
            m.addSource(id, basemap.sources[id]);
            addedSourceIds.push(id);
          }
        }
        if (basemap.glyphs && typeof m.setGlyphs === "function")
          m.setGlyphs(basemap.glyphs);
        if (basemap.sprite && typeof m.setSprite === "function")
          m.setSprite(basemap.sprite);

        const bmLayers = basemap.layers;
        let firstSymbol = bmLayers.findIndex((l) => l && l.type === "symbol");
        if (firstSymbol < 0) firstSymbol = bmLayers.length;
        const addLayer = (sourceLayer, beforeId) => {
          const layer = Object.assign({}, sourceLayer);
          if (!visible) {
            layer.layout = Object.assign({}, layer.layout, { visibility: "none" });
          }
          m.addLayer(layer, beforeId);
          addedLayerIds.push(layer.id);
        };
        bmLayers.slice(0, firstSymbol).forEach((l) => addLayer(l, SEGMENTS_LAYER));
        bmLayers.slice(firstSymbol).forEach((l) => addLayer(l, FADE_LAYER));
        this._basemapLayerIds = bmLayers.map((l) => l.id);
        this._basemapSourceIds = Object.keys(basemap.sources);
        this._basemapInstalledTheme = basemap.theme || this._theme;
        return true;
      } catch (e) {
        console.warn("[map] failed to install basemap theme", e);
        addedLayerIds
          .slice()
          .reverse()
          .forEach((id) => {
            if (m.getLayer(id)) m.removeLayer(id);
          });
        addedSourceIds.forEach((id) => {
          if (m.getSource(id)) m.removeSource(id);
        });
        this._basemapLayerIds = [];
        this._basemapSourceIds = [];
        this._basemapInstalledTheme = null;
        return false;
      }
    },
    // Switches only the basemap stack, preserving all railway overlays and
    // the current view. OpenFreeMap's official Dark style is used in dark mode.
    async setBasemapTheme(theme, options = {}) {
      theme = theme === "dark" ? "dark" : "light";
      this._theme = theme;
      this._applyThemePaint(theme);
      if (!this._map) return false;
      if (this._basemapRetryInflight) await this._basemapRetryInflight;
      if (this._basemapInstalledTheme === theme) return true;
      this._basemapRetryInflight = (async () => {
        try {
          const basemap = await loadBasemap(theme, true);
          if (!basemap) return false;
          if (!(await probeBasemapOrigin(basemap))) return false;
          if (typeof options.beforeInstall === "function")
            await options.beforeInstall();
          return await this._installBasemap(basemap);
        } finally {
          this._basemapRetryInflight = null;
        }
      })();
      return this._basemapRetryInflight;
    },
    // Online retry: boot may have degraded to no-basemap. Load the style for
    // the active page theme and splice it into the live map without touching
    // railway overlays or camera state.
    async retryBasemap() {
      const m = this._map;
      if (!m) return false;
      if (this._basemapLayerIds.length) return true; // already present
      if (this._basemapRetryInflight) return this._basemapRetryInflight;
      this._basemapRetryInflight = (async () => {
        try {
          const basemap = await loadBasemap(this._theme, true);
          if (!basemap) return false;
          if (!(await probeBasemapOrigin(basemap))) return false;
          return await this._installBasemap(basemap);
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
      this._pushPick();
    },
    _pushFitCurves() {
      // The fitted-curve overlay is a debug layer that is HIDDEN by default
      // (setFitCurvesVisible false; layer visibility 'none'). Uploading its
      // source on every route render forces a worker re-tile + repaint for
      // geometry nobody sees. Skip when hidden — setFitCurvesVisible() pushes
      // on enable and every subsequent data change while visible still pushes,
      // so the curves populate the moment the overlay is turned on.
      if (!this._fitCurvesVisible) return;
      const src = this._src(FIT_CURVES_SOURCE);
      if (src) src.setData(fitCurvesToFC(this._groupInfo));
    },
    _pushHoverRegions(state) {
      this._hoverDebugState = state || null;
      const fc = this._hoverRegionsVisible
        ? hoverRegionsToFC(this._map, this._hoverDebugState)
        : EMPTY_FC;
      const src = this._src(HOVER_REGIONS_SOURCE);
      if (src && this._hoverRegionsVisible) src.setData(fc);
      if (this._map && this._map.getContainer) {
        const container = this._map.getContainer();
        container.dataset.hoverRegionReport = JSON.stringify({
          visible: this._hoverRegionsVisible,
          routePadPx:
            state && state.routePadPx != null
              ? state.routePadPx
              : HOVER_PICK_PAD_PX,
          stickyPadPx: HOVER_STICKY_PAD_PX,
          holdRadiusPx: HOVER_FAN_HOLD_PX,
          switchRadiusPx: HOVER_GROUP_SWITCH_PX,
          zoom: this._map ? +this._map.getZoom().toFixed(2) : null,
          stickyRadiusApproxMeters:
            this._map && state && state.point
              ? +(
                  (156543.03392 *
                    Math.cos(
                      (this._map.unproject(state.point).lat * Math.PI) / 180,
                    ) *
                    HOVER_FAN_HOLD_PX) /
                  Math.pow(2, this._map.getZoom())
                ).toFixed(1)
              : null,
          hasHold: Boolean(state && state.holdPoint),
          hasSwitch: Boolean(state && state.switchPoint),
          hovered: Boolean(this._hoverTrainId),
          expanded: Boolean(this._expandedGroup),
          pointer: state && state.point ? state.point : null,
          holdCenter: state && state.holdPoint ? state.holdPoint : null,
          distanceFromHoldPx:
            state && state.point && state.holdPoint
              ? +Math.hypot(
                  state.point.x - state.holdPoint.x,
                  state.point.y - state.holdPoint.y,
                ).toFixed(2)
              : null,
          featureKinds: fc.features.map((f) => f.properties.kind),
        });
      }
    },
    _refreshFitCurveDiagnostics() {
      this._fitCurveDiagnostics = diagnoseFitCurves(this._groupInfo);
      if (this._map && this._map.getContainer) {
        const container = this._map.getContainer();
        container.dataset.fitCurveReport = JSON.stringify(
          this._fitCurveDiagnostics,
        );
        container.dataset.fitCurveCount = String(
          this._fitCurveDiagnostics.curves,
        );
      }
      return this._fitCurveDiagnostics;
    },
    // Re-upload the pick source for the CURRENT fan state: true-track hit
    // areas while collapsed, per-lane hit areas for the open group's members.
    _pushPick() {
      const pick = this._src(TRAIN_PICK_SOURCE);
      if (pick)
        pick.setData(
          routePickRecordsToFC(
            this._visible ? this._records : [],
            this._groupInfo,
            this._expandedGroup,
            this._fanDirGroup === this._expandedGroup ? this._fanDirVec() : null,
            this._currentLaneSpacingDeg(),
            this._groupTransition,
          ),
        );
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
      const transition = this._groupTransition;
      const spacing = this._currentLaneSpacingDeg();
      exp.setData(
        transition && group === transition.toGroup
          ? routeExpandTransitionFC(
              this._expandRecords,
              transition,
              spacing,
              this._fanDirGroup === group ? this._fanDirVec() : null,
            )
          : gi
          ? routeExpandFC(
              this._expandRecords,
              gi,
              spacing * f,
              this._fanDirGroup === group ? this._fanDirVec() : null,
            )
          : EMPTY_FC,
      );
    },

    // ── dynamic fan direction ────────────────────────────────────────────
    // The fan's shift axis is NOT a constant per group: it is the local
    // perpendicular of the corridor's smoothed curve (app.js groupInfo
    // `curve`) at the point under the pointer. _setFanDirTarget is fed by
    // every hover pass; the angle then eases toward the target in its own
    // rAF loop so the fan ROTATES smoothly while the pointer travels the
    // corridor instead of snapping at every sample.
    _fanTheta: null, // current animated angle of the perpendicular (scaled space)
    _fanThetaTarget: null,
    _fanCoslat: 1,
    _fanCurve: null, // curve object the angle currently refers to
    _fanCurveS: null, // last projected arc position (same-branch hysteresis)
    _fanCurveSign: 1, // fixed within one fitted curve; avoids axis flip-flop
    _fanDirGroup: null, // group the direction was computed for
    _fanSwitchFromDir: null,
    _fanDirVec() {
      if (this._fanTheta == null) return null;
      const cs = this._fanCoslat || 1;
      return {
        sx: Math.cos(this._fanTheta) / cs, // degree-space, like gi.sx/sy
        sy: Math.sin(this._fanTheta),
      };
    },
    _setFanDirTarget(group, lngLat) {
      const gi = this._groupInfo ? this._groupInfo.get(group) : null;
      if (!gi) return;
      const previousGroup = this._fanDirGroup;
      const previousDir = this._fanDirVec();
      const curve = gi.curve || null;
      let ux;
      let uy;
      let cs;
      if (curve && lngLat) {
        const sameCurve = this._fanCurve === curve;
        const p = fanPerpAt(curve, lngLat, sameCurve ? this._fanCurveS : null);
        ux = p.x;
        uy = p.y;
        cs = curve.coslat;
        this._fanCurveS = p.s;
        if (!sameCurve) {
          // A curve axis is equivalent under a 180° flip. A fresh fan aligns
          // with the canonical group axis; an already-open fan entering a new
          // interval aligns with its CURRENT visible side. This prevents lane
          // offsets from needlessly rotating almost 180° at a group boundary.
          const keepVisibleSide =
            previousDir &&
            previousGroup &&
            previousGroup !== group &&
            (this._expandedGroup || this._animGroup) &&
            (this._expandT || 0) > 0;
          const refX = keepVisibleSide ? previousDir.sx * cs : gi.sx * cs;
          const refY = keepVisibleSide ? previousDir.sy : gi.sy;
          this._fanCurveSign = ux * refX + uy * refY < 0 ? -1 : 1;
        }
        ux *= this._fanCurveSign;
        uy *= this._fanCurveSign;
      } else {
        // No curve: fall back to the group's static vector.
        cs =
          Math.cos((((gi._latRef || 0) * Math.PI) / 180)) || 1e-6;
        ux = gi.sx * cs;
        uy = gi.sy;
        this._fanCurveS = null;
        this._fanCurveSign = 1;
      }
      const target = Math.atan2(uy, ux);
      if (previousGroup && previousGroup !== group)
        this._fanSwitchFromDir = previousDir;
      this._fanCoslat = cs;
      this._fanDirGroup = group;
      // Only a fresh fan snaps to its initial direction. Once a fan is open,
      // crossing into a different corridor also takes the nearest angular path
      // and eases, so the translation axis cannot jump at the boundary.
      const canEase =
        this._fanTheta != null &&
        (this._expandedGroup || this._animGroup) &&
        (this._expandT || 0) > 0;
      this._fanCurve = curve;
      if (!canEase) {
        this._fanTheta = target;
        this._fanThetaTarget = target;
        return;
      }
      // Take the nearest equivalent angle so easing never goes the long way
      // around the circle.
      let d = target - this._fanTheta;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this._fanThetaTarget = this._fanTheta + d;
      this._ensureFanDirAnim();
    },
    _ensureFanDirAnim() {
      if (this._fanDirRaf) return;
      this._fanDirLast = performance.now();
      const step = (now) => {
        this._fanDirRaf = null;
        if (this._fanTheta == null || this._fanThetaTarget == null) return;
        const dt = Math.min(50, now - (this._fanDirLast || now));
        this._fanDirLast = now;
        const d = this._fanThetaTarget - this._fanTheta;
        let settled = false;
        if (Math.abs(d) < 0.002) {
          this._fanTheta = this._fanThetaTarget;
          settled = true;
        } else {
          // Exponential ease: frame-rate independent, always smooth.
          this._fanTheta += d * (1 - Math.exp(-dt / 90));
          this._fanDirRaf = requestAnimationFrame(step);
        }
        const g = this._expandedGroup || this._animGroup;
        if (g && this._fanDirGroup === g) {
          this._pushExpandFC(g);
          // The sticky hit box safely covers the few-pixel angular drift. A
          // full pick-source upload every animation frame caused needless
          // main-thread stalls; commit hit geometry once at the settled angle.
          if (settled) this._pushPick();
        }
      };
      this._fanDirRaf = requestAnimationFrame(step);
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
      const previous = this._expandedGroup;
      if (next === previous) return;
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
        const previousGi =
          previous && this._groupInfo ? this._groupInfo.get(previous) : null;
        // OPEN GROUP → DIFFERENT OPEN GROUP: interpolate lane configurations
        // instead of replacing one translated GeoJSON source with the other.
        if (previous && previousGi && gi && (this._expandT || 0) > 0) {
          if (this._expandAnimId) {
            cancelAnimationFrame(this._expandAnimId);
            this._expandAnimId = null;
          }
          const activeTransition = this._groupTransition;
          let fromOffsets = null;
          let previousTids = Object.keys(previousGi.mults);
          if (activeTransition) {
            previousTids = [
              ...new Set(
                Object.keys(activeTransition.fromGi.mults)
                  .concat(Object.keys(activeTransition.toGi.mults))
                  .concat(Object.keys(activeTransition.fromOffsets || {})),
              ),
            ];
            fromOffsets = {};
            const currentDir =
              this._fanSwitchFromDir || activeTransition.toGi;
            previousTids.forEach((tid) => {
              const off = transitionOffsetForTid(
                activeTransition,
                tid,
                1,
                currentDir,
              );
              fromOffsets[tid] = { x: off.dx, y: off.dy };
            });
          }
          const unionTids = [...new Set(previousTids.concat(nextTids))];
          this._expandT = 1;
          this._animGroup = next;
          this._expandedTids = unionTids;
          this._expandFilterTids = unionTids;
          this._engagedTids = unionTids.slice();
          this._groupTransition = {
            fromGroup: previous,
            toGroup: next,
            fromGi: previousGi,
            toGi: gi,
            fromDir: this._fanSwitchFromDir || previousGi,
            fromOffsets,
            progress: 0,
          };
          this._fanSwitchFromDir = null;
          if (m.getLayer(TRAIN_EXPAND_LAYER))
            m.setFilter(TRAIN_EXPAND_LAYER, this._expandSelector(unionTids));
          this._setExpandOpacity(1);
          this._applyBaseFilters();
          this._applyHoverFilter();
          this._pushExpandFC(next, 1);
          this._pushPick();
          this._animateGroupTransition(next, nextTids);
          return;
        }
        // Fill the group-scoped expand source with the member trains'
        // translated complete courses (rigid shift, geometry untouched).
        // Offsets start at the CURRENT slide progress (0 when fresh — i.e.
        // exactly on the true track) and slide outward from there.
        this._animGroup = next;
        this._pushExpandFC(next, this._expandT || 0);
        this._expandedTids = nextTids;
        this._expandFilterTids = nextTids;
        // The open group's hit areas move from the true track out to the
        // per-lane paths (they only exist there while the fan is open).
        this._pushPick();
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
        if (this._groupTransitionRaf) {
          cancelAnimationFrame(this._groupTransitionRaf);
          this._groupTransitionRaf = null;
        }
        this._groupTransition = null;
        this._expandedTids = [];
        // Hit areas snap back to the true track right away (the fan is
        // closing; hovering the line itself may legitimately re-open it).
        this._pushPick();
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
    _animateGroupTransition(targetGroup, targetTids) {
      if (this._groupTransitionRaf)
        cancelAnimationFrame(this._groupTransitionRaf);
      this._groupTransitionRaf = null;
      const transition = this._groupTransition;
      if (!transition) return;
      const duration = 320;
      const t0 = performance.now();
      const step = (now) => {
        if (
          !this._groupTransition ||
          this._groupTransition !== transition ||
          this._expandedGroup !== targetGroup
        ) {
          this._groupTransitionRaf = null;
          return;
        }
        const k = Math.min(1, (now - t0) / duration);
        // smoothstep has zero velocity at both ends, eliminating the small
        // arrival kick that ease-out produced at overlap boundaries.
        transition.progress = k * k * (3 - 2 * k);
        this._pushExpandFC(targetGroup, 1);
        if (k < 1) {
          this._groupTransitionRaf = requestAnimationFrame(step);
          return;
        }
        this._groupTransitionRaf = null;
        this._groupTransition = null;
        this._expandedTids = targetTids.slice();
        this._expandFilterTids = targetTids.slice();
        this._engagedTids = targetTids.slice();
        const m = this._map;
        if (m && m.getLayer(TRAIN_EXPAND_LAYER))
          m.setFilter(TRAIN_EXPAND_LAYER, this._expandSelector(targetTids));
        this._applyBaseFilters();
        this._applyHoverFilter();
        this._pushExpandFC(targetGroup, 1);
        this._pushPick();
      };
      this._groupTransitionRaf = requestAnimationFrame(step);
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

      // While a fan is open, follow the zoom CONTINUOUSLY: re-translate the
      // expanded lanes each frame at the effective (zoom-rescaled) spacing so
      // they hold their on-screen positions through the whole gesture instead
      // of drifting apart and snapping back at zoomend. One push per frame.
      map.on("zoom", () => {
        if (self._hoverRegionsVisible && self._hoverDebugState)
          self._pushHoverRegions(self._hoverDebugState);
        if (!self._expandedGroup && !self._animGroup) return;
        if (self._zoomExpandRaf) return;
        self._zoomExpandRaf = requestAnimationFrame(() => {
          self._zoomExpandRaf = null;
          const g = self._expandedGroup || self._animGroup;
          if (g) self._pushExpandFC(g);
        });
      });

      // preferLanes (hover only): while a fan is expanded, the fanned trains'
      // own station dots must not steal the pointer from the lanes — sliding
      // along the fan would flicker hover/tooltip at every station. Clicks
      // keep marker precedence so a station dot still opens its stop popup.
      //
      // stickyTids (STICKY HOVER): the currently hovered line — or the open
      // fan's member set — has absolute pick priority. While the pointer is
      // still on ANY sticky geometry (its line or its station dots), other
      // lines crossing beneath it are invisible to picking; only once the
      // pointer actually LEAVES the sticky geometry does the normal
      // resolution (foreign lines / ground) apply again.
      function queryAt(point, preferLanes, stickyTids) {
        const sticky = stickyTids && stickyTids.length ? stickyTids : null;
        const markerLayers = [
          TRAIN_SEL_STOPS_LAYER,
          TRAIN_SEL_PASS_LAYER,
          TRAIN_STOPS_LAYER,
          TRAIN_PASS_LAYER,
        ].filter((id) => map.getLayer(id));
        const pickLayers = [TRAIN_PICK_LAYER].filter((id) => map.getLayer(id));
        const bbox = [
          [point.x - HOVER_PICK_PAD_PX, point.y - HOVER_PICK_PAD_PX],
          [point.x + HOVER_PICK_PAD_PX, point.y + HOVER_PICK_PAD_PX],
        ];
        // Enlarged ROUTE grab box while a hover is already engaged (hover
        // queries only — clicks and fresh hovers keep the tight pad).
        // Markers keep the tight bbox so station dots don't grab from afar.
        const routePad =
          preferLanes && sticky ? HOVER_STICKY_PAD_PX : HOVER_PICK_PAD_PX;
        const routeBbox =
          routePad === HOVER_PICK_PAD_PX
            ? bbox
            : [
                [point.x - routePad, point.y - routePad],
                [point.x + routePad, point.y + routePad],
              ];
        // Markers: prefer a sticky train's dot over foreign dots. nopick dots
        // (off-date trains while a day is active) are never interactive.
        let markerHit = null;
        const mk = map.queryRenderedFeatures(bbox, { layers: markerLayers });
        if (mk.length) {
          const recOf = (f) => self._markers && self._markers[f.properties.idx];
          const usable = (rec) => rec && !rec.nopick;
          let rec = null;
          if (sticky) {
            const f = mk.find((f0) => {
              const r = recOf(f0);
              return usable(r) && r.train && sticky.includes(r.train.id);
            });
            rec = f ? recOf(f) : null;
          }
          if (!rec) {
            const f = mk.find((f0) => usable(recOf(f0)));
            rec = f ? recOf(f) : null;
          }
          if (rec)
            markerHit = {
              kind: "marker",
              record: rec,
              sticky: Boolean(
                sticky && rec.train && sticky.includes(rec.train.id),
              ),
            };
        }
        // Routes are picked against the invisible PICK lanes (which hug the
        // visible lines: true track while collapsed, per-lane paths for an
        // open fan). Query the EXACT cursor point first — that resolves to
        // the single lane under the pointer — and only fall back to the
        // padded box when the exact point misses (thin isolated lines stay
        // easy to grab). Sticky trains win within each candidate set.
        const routeFrom = (feats) => {
          if (!feats.length) return null;
          let f = null;
          if (sticky)
            f = feats.find((f0) => sticky.includes(f0.properties.tid));
          if (!f) f = feats[0];
          const rec = self._records[f.properties.idx];
          return rec
            ? {
                kind: "route",
                record: rec,
                sticky: Boolean(sticky && sticky.includes(f.properties.tid)),
              }
            : null;
        };
        let routeHit = routeFrom(
          map.queryRenderedFeatures(point, { layers: pickLayers }),
        );
        if (!routeHit)
          routeHit = routeFrom(
            map.queryRenderedFeatures(routeBbox, { layers: pickLayers }),
          );
        // STICKY RESOLUTION: while any sticky geometry is under the pointer,
        // foreign hits are discarded entirely.
        if (sticky && ((markerHit && markerHit.sticky) || (routeHit && routeHit.sticky))) {
          if (markerHit && !markerHit.sticky) markerHit = null;
          if (routeHit && !routeHit.sticky) routeHit = null;
        }
        const markerYieldsToFan =
          markerHit &&
          preferLanes &&
          self._expandedTids.length &&
          markerHit.record.train &&
          self._expandedTids.includes(markerHit.record.train.id);
        if (markerHit && !markerYieldsToFan) return markerHit;
        if (routeHit) return routeHit;
        return markerHit;
      }

      // The sticky set for the CURRENT hover state: the open fan's members,
      // else the single hovered train.
      function currentStickyTids() {
        if (self._expandedGroup && self._expandedTids.length)
          return self._expandedTids;
        if (self._hoverTrainId) return [self._hoverTrainId];
        return null;
      }

      map.on("click", (e) => {
        // Clicks resolve with the same sticky priority the hover shows: at a
        // crossing you select the line you are hovering, never the one
        // beneath it.
        const hit = queryAt(e.point, false, currentStickyTids());
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
        // STICKY HOVER: while the pointer is still on the hovered line (or
        // an open fan's lanes / their station dots), lines crossing beneath
        // it are unpickable — queryAt only surfaces them once the pointer
        // has actually left the sticky geometry.
        const stickyBefore = currentStickyTids();
        let hit = queryAt(point, true, stickyBefore);
        let id = hit && hit.record.train ? hit.record.train.id : null;
        // Snapshot the GENUINE geometric pick before the endpoint / fan
        // hysteresis below can replace `hit` with a synthesized tooltip
        // record. The hold anchor (_lastGroupPoint) must only advance on a
        // REAL corridor touch — see the anchor update further down. Advancing
        // it on a hysteresis HOLD made the fan-hold radius measure from the
        // CURRENT pointer every frame, so a slow drift (each step < the hold
        // radius) re-anchored forever and the fan trailed the pointer across
        // the screen, never releasing; a fast flick (one step past the radius)
        // collapsed normally. Gating on the raw hit restores a fixed release.
        const rawHit = hit;
        // Hover-expand: pointer on an overlapped run fans that group's lines
        // out into their date-ordered lanes; empty ground collapses. Marker
        // hits (station dots take pick precedence) keep the current state so
        // sweeping along an expanded fan doesn't flicker at every station.
        // Group under the pointer BEFORE hysteresis: an overlapped route run
        // gives its groupKey; a station dot keeps the current fan; a thin line
        // or blank ground gives none.
        const rawGroup =
          hit && hit.kind === "route"
            ? hit.record.overlapCount > 1
              ? hit.record.groupKey || null
              : null
            : hit && hit.kind === "marker"
              ? self._expandedGroup
              : null;
        let group = rawGroup;
        let endpointHeld = false;
        // ENDPOINT GROUP HYSTERESIS: do not switch on the first sample from an
        // adjacent group. Keep the current configuration until the pointer has
        // travelled clearly into the candidate interval; returning to the old
        // group cancels the candidate immediately.
        if (
          group &&
          self._expandedGroup &&
          group !== self._expandedGroup
        ) {
          if (self._groupSwitchCandidate !== group) {
            self._groupSwitchCandidate = group;
            self._groupSwitchAnchor = { x: point.x, y: point.y };
            group = self._expandedGroup;
            endpointHeld = true;
          } else if (self._groupSwitchAnchor) {
            const sx = point.x - self._groupSwitchAnchor.x;
            const sy = point.y - self._groupSwitchAnchor.y;
            if (
              sx * sx + sy * sy <
              HOVER_GROUP_SWITCH_PX * HOVER_GROUP_SWITCH_PX
            ) {
              group = self._expandedGroup;
              endpointHeld = true;
            } else {
              self._groupSwitchCandidate = null;
              self._groupSwitchAnchor = null;
            }
          }
        } else if (group === self._expandedGroup) {
          self._groupSwitchCandidate = null;
          self._groupSwitchAnchor = null;
        }
        // Keep the hovered lane/tooltip stable inside the same deadzone. The
        // raw feature may belong to the neighbouring group even though the
        // visible fan intentionally still represents the current one.
        if (
          endpointHeld &&
          self._tooltipRecord &&
          self._tooltipRecord.groupKey === group
        ) {
          hit = { kind: "route", record: self._tooltipRecord, sticky: true };
          id = self._tooltipRecord.train
            ? self._tooltipRecord.train.id
            : null;
        }
        // FAN HYSTERESIS: a hair-thin mismatched sliver inside a shared
        // corridor (or a pick seam between two runs) momentarily resolves to no
        // group. Don't collapse the open fan for it — hold the current group
        // while the pointer is still on a member train (or just barely off it)
        // AND within FAN_HOLD_PX of the last real group hit. Following a member
        // train genuinely OFF the corridor travels past that radius and
        // collapses as usual. The app-side bridge removes most such slivers;
        // this also covers pick seams and gaps longer than the bridge limit.
        if (!group && self._expandedGroup && self._lastGroupPoint) {
          const onMember =
            hit && hit.kind === "route" && id && self._expandedTids.includes(id);
          if (onMember || !hit) {
            const dx = point.x - self._lastGroupPoint.x;
            const dy = point.y - self._lastGroupPoint.y;
            if (
              dx * dx + dy * dy <=
              HOVER_FAN_HOLD_PX * HOVER_FAN_HOLD_PX
            ) {
              group = self._expandedGroup;
              if (
                self._tooltipRecord &&
                self._tooltipRecord.groupKey === group
              ) {
                hit = {
                  kind: "route",
                  record: self._tooltipRecord,
                  sticky: true,
                };
                id = self._tooltipRecord.train
                  ? self._tooltipRecord.train.id
                  : null;
              }
            }
          }
        }
        // Anchor the hold radius at the latest REAL overlapped-run hit for the
        // group that is (now) open; clear it once the fan is genuinely down so a
        // later re-entry starts fresh. Marker holds and hysteresis holds
        // deliberately leave it put (rawHit, not the possibly-rewritten hit, so
        // a synthesized hold record can't re-anchor), so the radius measures
        // travel since the pointer last truly touched the corridor.
        if (
          rawHit &&
          rawHit.kind === "route" &&
          rawHit.record.overlapCount > 1 &&
          group &&
          (rawHit.record.groupKey || null) === group
        )
          self._lastGroupPoint = { x: point.x, y: point.y };
        else if (!group) {
          self._lastGroupPoint = null;
          self._groupSwitchCandidate = null;
          self._groupSwitchAnchor = null;
        }
        // Dynamic fan direction: perpendicular of the corridor's smoothed
        // curve at the pointer position (eases while sliding along the
        // corridor). Must be set BEFORE _setExpandedGroup so a fresh fan
        // opens along the correct axis.
        if (group) self._setFanDirTarget(group, map.unproject(point));
        self._setExpandedGroup(group);
        if (id !== self._hoverTrainId) {
          self._hoverTrainId = id;
          self._applyHoverFilter();
          if (self._handlers.onHover) self._handlers.onHover(id);
        }
        map.getCanvas().style.cursor = hit ? "pointer" : "";
        self._pushHoverRegions({
          point: { x: point.x, y: point.y },
          routePadPx: stickyBefore
            ? HOVER_STICKY_PAD_PX
            : HOVER_PICK_PAD_PX,
          holdPoint:
            self._expandedGroup && self._lastGroupPoint
              ? { x: self._lastGroupPoint.x, y: self._lastGroupPoint.y }
              : null,
          switchPoint: self._groupSwitchAnchor
            ? { x: self._groupSwitchAnchor.x, y: self._groupSwitchAnchor.y }
            : null,
        });
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
        self._lastGroupPoint = null;
        self._groupSwitchCandidate = null;
        self._groupSwitchAnchor = null;
        self._fanCurve = null;
        self._fanCurveS = null;
        self._fanCurveSign = 1;
        self._pushHoverRegions(null);
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
          "position:absolute;left:0;top:0;z-index:30;pointer-events:none;display:none;will-change:transform;";
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
          el.style.transform =
            "translate(" + (point.x + 12) + "px," + (point.y + 12) + "px)";
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
      el.style.transform =
        "translate(" + (point.x + 12) + "px," + (point.y + 12) + "px)";
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
