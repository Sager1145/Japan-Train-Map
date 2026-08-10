/*
 * railmap-style.js — the visual style layer of the RailMap core.
 *
 * railprint's design tokens (tokens.ts), the shared MapLibre source/layer
 * ids, the hover/selection spotlight constants, the marker circle paint
 * builders, and buildBaseStyle (style.ts): the full map style with the N02
 * network in official line colors, the ridden-train and selection layers,
 * and the fit-curve / hover-region debug layers, optionally over a
 * namespaced basemap.
 *
 * Publishes the RailMapStyle global (consumed by railmap-geometry.js,
 * railmap.js and railmap-interactions.js).
 */
(function (global) {
  "use strict";

  const { MAP_SURFACE_COLORS, namespaceBasemap, labelGateFilterForCountry } =
    global.RailMapBasemap;

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
  const DEFAULT_LINE_COLOR = global.RailNetwork.DEFAULT_LINE_COLOR;

  // The network under the map is a per-COUNTRY package (jp-2025 / tw-2025), so
  // the credit carried on its source is per-country too — crediting N02 for
  // Taiwanese geometry would be a false licence declaration. Japan's station
  // romanizations come from OSM and are credited with the network; Taiwan's
  // names ship inside the official TDX record, so no OSM credit applies there.
  // Keep each string in sync with the package's own .sources.md.
  const RAIL_ATTRIBUTIONS = {
    jp:
      "出典「国土数値情報（鉄道データ N02）」（国土交通省）を加工して作成 (CC BY 4.0)" +
      "｜Romanizations © OpenStreetMap contributors, ODbL",
    tw:
      "資料來源：交通部運輸資料流通服務（TDX/PTX）、內政部國土測繪中心、" +
      "農業部阿里山林業鐵路及文化資產管理處、臺北市政府捷運工程局，經加工製作" +
      "（政府資料開放授權條款第1版）",
    hk:
      "資料來源：香港鐵路有限公司官方行程指南及開放數據，經加工製作",
    mo:
      "資料來源：澳門輕軌股份有限公司官方路線及車站資料，經加工製作",
  };
  function railAttributionForCountry(country) {
    return RAIL_ATTRIBUTIONS[country] || RAIL_ATTRIBUTIONS.jp;
  }

  // ───────────────────── ridden/unridden paint constants (style.ts) ──────────────────────
  const UNRIDDEN_OPACITY = 0.48;
  const RIDDEN_WIDTH_SCALE = 1.18;
  const UNRIDDEN_WIDTH_SCALE = 0.65;

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

  // MapLibre permits the camera expression ["zoom"] only as the input of a
  // top-level step/interpolate expression. Each step then applies the line's
  // data-driven minz property at paint time, avoiding tile-parse filters while
  // keeping the entire line/station group on one integer zoom threshold.
  function lineLengthVisibilityOpacity(visibleOpacity) {
    const gate = (zoom) => [
      "case",
      ["<=", ["coalesce", ["get", "minz"], 0], zoom],
      visibleOpacity,
      0,
    ];
    const expression = ["step", ["zoom"], gate(0)];
    // Complete lines top out at z7, while dense intermediate stations can be
    // deferred as far as z14. Keep evaluating the per-feature threshold all
    // the way through that range; an unconditional z7 value would make every
    // dense station appear at once and defeat station decluttering.
    for (let zoom = 1; zoom <= 14; zoom += 1)
      expression.push(zoom, gate(zoom));
    return expression;
  }

  // ───────────────────────────── source / layer ids ─────────────────────────────
  const SEGMENTS_SOURCE = "rn-segments";
  const STATIONS_SOURCE = "rn-stations";
  const SEGMENTS_LAYER = "rn-segments-line";
  const STATIONS_LAYER = "rn-stations-dot";
  const FADE_LAYER = "rp-fade";
  const TRAIN_ROUTES_SOURCE = "train-routes";
  const TRAIN_PICK_SOURCE = "train-routes-pick";
  const TRAIN_PICK_FAN_SOURCE = "train-routes-pick-fan";
  const TRAIN_EXPAND_SOURCE = "train-routes-expand-src";
  const TRAIN_MARKERS_SOURCE = "train-markers-base";
  const FIT_CURVES_SOURCE = "train-fit-curves-src";
  const HOVER_REGIONS_SOURCE = "train-hover-regions-src";
  const TRAIN_ROUTES_LAYER = "train-routes-line";
  // Cross-day continuation: the half of an overnight train that belongs to the
  // OTHER calendar day draws dashed instead of solid (same source, same
  // colour/width — only the stroke pattern says "not this day").
  const TRAIN_XDAY_LAYER = "train-routes-xday";
  const TRAIN_XDAY_STOP_LAYER = "train-xday-stop";
  const XDAY_ICON_ID = "railmap-xday-diamond";
  const TRAIN_PICK_LAYER = "train-routes-pick-line";
  const TRAIN_PICK_FAN_LAYER = "train-routes-pick-fan-line";
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
  // Hover hit geometry in SCREEN pixels. Fresh entry gets a moderate 8px pad;
  // active hover adds only 5px so it stays stable without becoming magnetic.
  const HOVER_PICK_PAD_PX = 8;
  const HOVER_STICKY_PAD_PX = 5;
  const HOVER_FAN_HOLD_PX = 10;
  const HOVER_GROUP_SWITCH_PX = 7;
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
  // The one marker-size zoom ramp (full size at z12, ×0.48 at z5) shared by
  // every point marker — circle radii and the cross-day diamond icon scale
  // must shrink in lockstep or the diamond reads over/under-sized next to
  // its neighbouring stop dots.
  function zoomMarkerRamp(expr) {
    return [
      "interpolate",
      ["linear"],
      ["zoom"],
      5,
      ["*", expr, 0.48],
      12,
      expr,
    ];
  }

  function markerRadiusExpr(radiusBoost) {
    const r = radiusBoost
      ? ["+", ["get", "radius"], radiusBoost]
      : ["get", "radius"];
    return zoomMarkerRamp(r);
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

  // The cross-day diamond is rasterized at XDAY_ICON_BASE_RADIUS CSS px (see
  // RailMap._ensureXDayIcon), so icon-size only has to scale it to the record's
  // own radius — on the same zoom ramp as every circle marker.
  const XDAY_ICON_BASE_RADIUS = 10;
  function xdayIconSizeExpr() {
    return zoomMarkerRamp(["/", ["get", "radius"], XDAY_ICON_BASE_RADIUS]);
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

  // Stop-dot LOD: below `stopMarkerMinzoom` the intermediate stop dots (every
  // role except "terminal" — the black stop-centers included) don't draw. The
  // gate can't be a layer `minzoom`, because the stops layers also carry the
  // terminal markers, which must stay visible at every zoom — and it can't be
  // a ["zoom"] filter expression either: the vendored MapLibre build only
  // evaluates filter zoom when a tile is parsed, which for this geojson
  // circle source empirically never re-gates on zoom (verified: a bare
  // [">=",["zoom"],7] filter still rendered every dot at zoom 6). So the gate
  // is a plain role filter that RailMap re-applies whenever the view crosses
  // the threshold (see the zoom watcher in attach()). Configured once by
  // buildBaseStyle (opts.stopMinzoom, 0 = no LOD); shared with
  // _applyMarkerSelectionFilters so both filter builders agree.
  let stopMarkerMinzoom = 0;
  function stopMarkerZoomGate(zoom) {
    if (!(stopMarkerMinzoom > 0)) return null;
    if (Number(zoom) >= stopMarkerMinzoom) return null;
    return ["==", ["get", "role"], "terminal"];
  }

  // ───────────────────────────── the base style (style.ts buildBaseStyle) ────────────────
  function buildBaseStyle(opts) {
    const basemap = opts.basemap || null;
    const network = opts.network || null;
    const theme = opts.theme === "dark" ? "dark" : "light";
    const themeColors = MAP_SURFACE_COLORS[theme];
    const fadeOpacity = Math.max(0, Math.min(1, Number(opts.fadeOpacity || 0)));

    // ONE basemap stack serves both themes. Light and dark are the same
    // positron layers differing only in paint colors (railmap-basemap.js), so
    // theme switching recolors this stack in place with paint transitions.
    // Never stage a second stack: two identical symbol stacks fight in
    // MapLibre's global label collision pass, and the staged (invisible) copy
    // wins placement — the visible theme's labels all vanish.
    const primaryStack = basemap
      ? namespaceBasemap(basemap, "", false)
      : null;
    const sources = Object.assign({}, primaryStack ? primaryStack.sources : {});
    sources[SEGMENTS_SOURCE] = {
      type: "geojson",
      data: network ? network.segments : EMPTY_FC,
      attribution: railAttributionForCountry(opts.country),
      // Never let source tiling simplify a railway as the map zooms out.
      // Scale hierarchy comes only from hiding complete shorter lines; every
      // line that remains visible keeps all of its canonical coordinates.
      tolerance: 0,
    };
    sources[STATIONS_SOURCE] = {
      type: "geojson",
      data: network ? network.stations : EMPTY_FC,
    };
    // Ridden routes use exact slices of the same complete network lines and
    // therefore keep the same unsimplified coordinates at every zoom.
    sources[TRAIN_ROUTES_SOURCE] = {
      type: "geojson",
      data: EMPTY_FC,
      tolerance: 0,
    };
    sources[TRAIN_PICK_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[TRAIN_PICK_FAN_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[TRAIN_EXPAND_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[TRAIN_MARKERS_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[FIT_CURVES_SOURCE] = { type: "geojson", data: EMPTY_FC };
    sources[HOVER_REGIONS_SOURCE] = { type: "geojson", data: EMPTY_FC };
    // Pass-through dot LOD: below this zoom the (numerous) white dots simply
    // don't draw — a layer property, so crossing it re-renders nothing.
    const passMinzoom = Math.max(0, Number(opts.passMinzoom || 0));
    // Stop-dot LOD (see stopMarkerZoomGate): the intermediate stop dots follow
    // at a LOWER threshold, so zooming out sheds pass-throughs first and stops
    // later, while terminals never disappear.
    stopMarkerMinzoom = Math.max(0, Number(opts.stopMinzoom || 0));
    // Stops-layer filter shared by the base and SEL variants: category, tid
    // ownership, and the stop-dot LOD gate. The map always boots at the
    // nationwide overview (zoom 4, below any sensible threshold), so build
    // the boot filters gated; attach() re-derives them from the live zoom
    // right away, correcting any boot path that starts zoomed in.
    const stopsLayerFilter = (mine) => {
      const filter = [
        "all",
        ["==", ["get", "category"], "stop"],
        [mine ? "==" : "!=", ["get", "tid"], NO_TRAIN],
      ];
      const zoomGate = stopMarkerZoomGate(0);
      if (zoomGate) filter.push(zoomGate);
      return filter;
    };

    const layers = [];
    // Plain background used for the explicit no-basemap mode and graceful
    // degradation when the online style is unavailable.
    layers.push({
      id: "rp-bg",
      type: "background",
      paint: { "background-color": themeColors.background },
    });
    // Keep the complete basemap stack below the fade and every railway layer.
    // This guarantees that roads, labels and theme masks can never cover the
    // ordinary network or any ridden route. Label layers are re-gated from the
    // cached style's combined jp+tw area to the BOOT country, so the other
    // country's captions never flash before the app hands RailMap the active
    // country (railmap-basemap.js, per-country label gate).
    const bmLayers = (primaryStack ? primaryStack.layers : []).map((layer) => {
      const labelGate = labelGateFilterForCountry(layer, opts.country);
      return labelGate
        ? Object.assign({}, layer, { filter: labelGate })
        : layer;
    });
    layers.push(...bmLayers);

    // Optional map-opacity tint affects only the basemap. Theme switching
    // recolors the basemap stack in place; this layer stays unchanged.
    layers.push({
      id: FADE_LAYER,
      type: "background",
      paint: {
        "background-color": themeColors.fade,
        "background-opacity": fadeOpacity,
        "background-opacity-transition": { duration: 0, delay: 0 },
      },
    });

    // ── the full national network — railprint's "unridden field" ──
    // Hidden by default: the network is opt-in via the layers-control switch.
    layers.push({
      id: SEGMENTS_LAYER,
      type: "line",
      source: SEGMENTS_SOURCE,
      layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
      paint: {
        "line-color": ["coalesce", ["get", "color"], DEFAULT_LINE_COLOR],
        // Do not put this zoom gate in a layer FILTER. GeoJSON filters are
        // evaluated while individual source tiles are parsed, so neighbouring
        // tiles can temporarily use different zoom levels and hide only part
        // of one line. Paint expressions are evaluated uniformly every frame.
        "line-opacity": lineLengthVisibilityOpacity(UNRIDDEN_OPACITY),
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
      layout: { visibility: "none" },
      paint: {
        // Theme-dependent: _applyThemePaint rewrites both colors on switch.
        "circle-color": MAP_SURFACE_COLORS.light.stationDot,
        "circle-opacity": lineLengthVisibilityOpacity(1),
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 1.4, 12, 3],
        "circle-stroke-color": MAP_SURFACE_COLORS.light.stationRing,
        "circle-stroke-opacity": lineLengthVisibilityOpacity(1),
        "circle-stroke-width": 1,
      },
    });

    // ── the trains ("ridden") — full-color line (glow removed by request) ──
    // line-sort-key (higher = on top) carries the static painter's order:
    // dimmed off-date tier under the active tier, then shorter total ride
    // over longer, then earlier date over later (see buildDeckRouteRecords).
    layers.push({
      id: TRAIN_ROUTES_LAYER,
      type: "line",
      source: TRAIN_ROUTES_SOURCE,
      layout: {
        "line-cap": "round",
        "line-join": "round",
        "line-sort-key": ["get", "sortKey"],
      },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": ["get", "alpha"],
        "line-width": zoomScaledWidth(["*", ["get", "width"], RIDDEN_WIDTH_SCALE]),
      },
    });
    // Cross-day continuation of an overnight train, dashed. Filter-driven and
    // empty by default: RailMap.setDateScope decides, per selected day, which
    // records move here from the solid layer above (and the toggle
    // "顯示完整跨天行程" empties it again). Butt caps keep the dashes crisp —
    // round caps at this width read as a dotted line.
    layers.push({
      id: TRAIN_XDAY_LAYER,
      type: "line",
      source: TRAIN_ROUTES_SOURCE,
      filter: MATCH_NONE,
      layout: {
        "line-cap": "butt",
        "line-join": "round",
        "line-sort-key": ["get", "sortKey"],
      },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": ["get", "alpha"],
        "line-width": zoomScaledWidth(["*", ["get", "width"], RIDDEN_WIDTH_SCALE]),
        "line-dasharray": [1.6, 1.4],
      },
    });
    // Invisible true-track PICK layer used while the fan is collapsed. Zero
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
    // FAN-SCOPED pick lanes: while a hover fan is open, only the open group's
    // per-lane hit areas live here. A pooled one-tid layer translates this
    // true geometry on the GPU together with its visible lane.
    layers.push({
      id: TRAIN_PICK_FAN_LAYER,
      type: "line",
      source: TRAIN_PICK_FAN_SOURCE,
      filter: ["!=", ["get", "nopick"], 1],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#000",
        "line-opacity": 0,
        "line-width": ["get", "pickWidth"],
        "line-translate": [0, 0],
        "line-translate-anchor": "map",
      },
    });
    // Whole hovered route lights up (full opacity, a touch wider).  The
    // opacity starts at zero because RailMap's rAF dim engine owns both the
    // hover enter/leave fade and the A -> B crossfade when the pointer moves
    // directly between routes.  Keeping the old/new tids in this layer while
    // their paint weights cross prevents a filter swap from snapping.
    layers.push({
      id: TRAIN_HOVER_LAYER,
      type: "line",
      source: TRAIN_ROUTES_SOURCE,
      filter: ["==", ["get", "tid"], NO_TRAIN],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": 0,
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
      filter: stopsLayerFilter(false),
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
    // Cross-day break station: the last station of the outgoing day, drawn as
    // a diamond so it never reads as an ordinary stop. Symbol layers paint
    // above every line/circle layer, so the diamond always sits on top of the
    // route it interrupts. Overlap-allowed: this one must never be dropped by
    // label collision.
    layers.push({
      id: TRAIN_XDAY_STOP_LAYER,
      type: "symbol",
      source: TRAIN_MARKERS_SOURCE,
      filter: ["==", ["get", "category"], "xday"],
      layout: {
        "icon-image": XDAY_ICON_ID,
        "icon-size": xdayIconSizeExpr(),
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-pitch-alignment": "map",
        "icon-rotation-alignment": "map",
      },
      paint: { "icon-opacity": ["get", "alpha"] },
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
        "line-translate": [0, 0],
        "line-translate-anchor": "map",
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
        "line-translate": [0, 0],
        "line-translate-anchor": "map",
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
      filter: stopsLayerFilter(true),
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
        // Rejected station joins ride the same debug source as short marker
        // segments; draw them red and wider so the exact boundary that stayed
        // discontinuous is visible among the white fitted curves.
        "line-color": [
          "case",
          ["==", ["get", "kind"], "station-join-failure"],
          "#ff3b30",
          "#ffffff",
        ],
        "line-opacity": 1,
        "line-width": [
          "case",
          ["==", ["get", "kind"], "station-join-failure"],
          5,
          2.5,
        ],
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
    const stacks = {};
    if (primaryStack) {
      stacks[theme] = {
        layerIds: primaryStack.layers.map((layer) => layer.id),
        sourceIds: Object.keys(primaryStack.sources),
        opacityTargets: primaryStack.opacityTargets,
      };
    }
    // Application-only metadata must not be passed through MapLibre's style
    // validator, so keep it non-enumerable and hand it directly to attach().
    Object.defineProperty(style, "__railMapBasemapStacks", {
      value: stacks,
      enumerable: false,
    });
    return style;
  }

  global.RailMapStyle = {
    buildBaseStyle,
    railAttributionForCountry,
    stopMarkerZoomGate,
    zoomScaledWidth,
    RIDDEN_WIDTH_SCALE,
    markerRadiusExpr,
    selectedStopRadiusExpr,
    EMPTY_FC,
    NO_TRAIN,
    MATCH_NONE,
    HOVER_DIM,
    HOVER_PICK_PAD_PX,
    HOVER_STICKY_PAD_PX,
    HOVER_FAN_HOLD_PX,
    HOVER_GROUP_SWITCH_PX,
    SELECT_DIM,
    SEGMENTS_SOURCE,
    STATIONS_SOURCE,
    SEGMENTS_LAYER,
    STATIONS_LAYER,
    FADE_LAYER,
    TRAIN_ROUTES_SOURCE,
    TRAIN_PICK_SOURCE,
    TRAIN_PICK_FAN_SOURCE,
    TRAIN_EXPAND_SOURCE,
    TRAIN_MARKERS_SOURCE,
    FIT_CURVES_SOURCE,
    HOVER_REGIONS_SOURCE,
    TRAIN_ROUTES_LAYER,
    TRAIN_XDAY_LAYER,
    TRAIN_XDAY_STOP_LAYER,
    XDAY_ICON_ID,
    XDAY_ICON_BASE_RADIUS,
    TRAIN_PICK_LAYER,
    TRAIN_PICK_FAN_LAYER,
    TRAIN_EXPAND_LAYER,
    TRAIN_EXPAND_HOVER_LAYER,
    TRAIN_HOVER_LAYER,
    TRAIN_SEL_CASING_LAYER,
    TRAIN_SEL_LAYER,
    TRAIN_PASS_LAYER,
    TRAIN_STOPS_LAYER,
    TRAIN_SEL_PASS_LAYER,
    TRAIN_SEL_STOPS_LAYER,
    FIT_CURVES_CASING_LAYER,
    FIT_CURVES_LAYER,
    HOVER_REGIONS_FILL_LAYER,
    HOVER_REGIONS_LINE_LAYER,
  };
})(window);
