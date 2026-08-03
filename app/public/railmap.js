/*
 * railmap.js — MapLibre GL map core, styled after yzhouwang/railprint.
 *
 * The map core is a family of classic scripts, each publishing one global;
 * index.html loads them in this order:
 *
 *   railmap-basemap.js       RailMapBasemap   basemap style loading + probing
 *   railmap-popup.js         RailMapPopup     C5 station popup model + HTML
 *   railmap-style.js         RailMapStyle     design tokens, layer/source ids,
 *                                             spotlight constants, buildBaseStyle
 *   railmap-geometry.js      RailMapGeometry  record → GeoJSON + overlap-fan math
 *   railmap.js  (this file)  RailMap          the overlay manager: attach, data
 *                                             feeds, basemap install/crossfade,
 *                                             filters, dim/expand animations
 *   railmap-interactions.js  —                extends RailMap with click/hover
 *                                             wiring, tooltip + station popup
 *
 * Together they are a faithful port of railprint's map styling stack
 * (src/design/tokens.ts + src/lib/map/basemap.ts + src/lib/map/style.ts +
 * src/lib/map/popup.ts) into dependency-free browser scripts:
 *
 *   - BASEMAP: OpenFreeMap `positron` for BOTH themes — dark is positron
 *     recolored to a dark palette (railmap-basemap.js), so label layers,
 *     fonts and zoom behavior match light mode exactly. If the online tile
 *     source is unavailable, the rail renders over a theme-matched plain
 *     background.
 *   - NETWORK: the active country's compact-v1 rail package (Japan or Taiwan).
 *     Drawn exactly like railprint's "unridden" field: each line in its
 *     official color at 0.48 opacity, thin, with
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

  const {
    loadBasemap,
    probeBasemapOrigin,
    namespaceBasemap,
    opacityPropsForLayer,
    MAP_SURFACE_COLORS,
    BASEMAP_CROSSFADE_MS,
  } = global.RailMapBasemap;
  const {
    buildBaseStyle,
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
  } = global.RailMapStyle;
  const {
    routeRecordsToFC,
    routePickRecordsToFC,
    routePickFanFC,
    routeExpandFC,
    routeExpandTransitionFC,
    transitionOffsetForTid,
    fanPerpAt,
    fitCurvesToFC,
    diagnoseFitCurves,
    hoverRegionsToFC,
    markerRecordsToFC,
  } = global.RailMapGeometry;

  // ───────────────────────────── rail package loader ─────────────────────────────
  // Loads the active country's rail package in compact-v1 format (stations and
  // segments nested per line, derivable fields omitted — see
  // scripts/railpkg.py for the format spec) and builds the two GeoJSON
  // collections + the geo index the hover popup needs (buildSegmentCollection /
  // buildStationCollection / geo-index, ported).
  //   station row: [stationGroupId, name, lon, lat, (nameRoma, romaSourceCode)]
  //   segment row: [km, sharedFirstPoint, coordinates, (arcDirection)]
  //   segment i joins station i to station (i+1) % n (loop lines close the ring)
  async function loadNetwork(packageUrl) {
    try {
      const url =
        packageUrl ||
        (typeof global.activeRailPackageUrl === "function"
          ? global.activeRailPackageUrl()
          : "./rail/jp-2025.json");
      // Rail packages are replaced in place. Revalidate the URL so a newly
      // rebuilt official package cannot be shadowed by the 24-hour static
      // JSON browser cache.
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) return null;
      return global.RailNetwork.buildNetworkFromCompactPackage(await res.json());
    } catch (e) {
      console.warn("[railmap] rail package unavailable:", e);
      return null;
    }
  }

  // ───────────────────────────── the overlay manager ─────────────────────────────
  const RailMap = {
    loadBasemap,
    loadNetwork,
    buildBaseStyle,

    _map: null,
    _network: null,
    _networkPromise: null, // dedups concurrent ensureNetwork() lazy loads
    _networkGeneration: 0, // invalidates a load started for the prior country
    _networkVisibleWanted: false,
    _networkStationsVisibleWanted: false,
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
    // The single installed basemap stack ({layerIds, sourceIds}); both themes
    // share it and theme switches recolor it in place (_recolorBasemapStack).
    _basemapStack: null,
    _basemapMode: "none",
    _theme: "light",
    _basemapInstalledTheme: null,
    _basemapRetryInflight: null, // dedups concurrent retryBasemap() calls
    // Cross-day: draw an overnight train's other-day half dashed. The app's
    // "顯示完整跨天行程" toggle flips this to false, which makes that half draw
    // exactly like any other line.
    _crossDayDash: true,
    _basemapGeneration: 0,
    _basemapTransitionDuration: BASEMAP_CROSSFADE_MS,
    _fadeOpacity: 0,

    attach(
      map,
      network,
      handlers,
      basemapLayerIds,
      basemapSourceIds,
      theme,
      basemapStacks,
    ) {
      this._map = map;
      this._network = network || null;
      this._handlers = handlers || {};
      const stackValues = Object.values(basemapStacks || {});
      this._basemapStack = stackValues.length ? stackValues[0] : null;
      this._basemapLayerIds = this._basemapStack
        ? (this._basemapStack.layerIds || []).slice()
        : basemapLayerIds || [];
      this._basemapSourceIds = this._basemapStack
        ? (this._basemapStack.sourceIds || []).slice()
        : basemapSourceIds || [];
      this._basemapMode = this._basemapLayerIds.length ? "positron" : "none";
      this._theme = theme === "dark" ? "dark" : "light";
      this._basemapInstalledTheme = this._basemapLayerIds.length
        ? this._theme
        : null;
      const initialFade = map.getLayer(FADE_LAYER)
        ? Number(map.getPaintProperty(FADE_LAYER, "background-opacity"))
        : 0;
      this._fadeOpacity = Number.isFinite(initialFade) ? initialFade : 0;
      this._wireInteractions();
      // ALL opacity fades on these layers are driven manually by the rAF dim
      // engine (_applyDimPaint) and the fan slide — MapLibre skips its own
      // transitions for data-driven paint values anyway, and its implicit
      // default 300 ms transition on CONSTANT values would trail the rAF
      // frames. Pin every animated opacity prop to zero so the rAF loop is
      // the single source of animation truth.
      this._ensureXDayIcon();
      // A basemap/theme swap installs a fresh style, which drops runtime
      // images; MapLibre asks for the missing one instead of silently drawing
      // nothing, so re-rasterize on demand.
      map.on("styleimagemissing", (e) => {
        if (e && e.id === XDAY_ICON_ID) this._ensureXDayIcon();
      });
      const ZERO_T = { duration: 0, delay: 0 };
      [
        [TRAIN_ROUTES_LAYER, ["line-opacity"]],
        [TRAIN_XDAY_LAYER, ["line-opacity"]],
        [TRAIN_XDAY_STOP_LAYER, ["icon-opacity"]],
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
      // Pin the solid/dashed cross-day split from the start: a setDateScope
      // that landed before attach() only stored state (no map to filter yet),
      // and setData never re-applies these filters.
      this._applyBaseFilters();
      // Stop-dot LOD: the gate is a plain role filter (filter ["zoom"]
      // expressions never re-gate on zoom in this MapLibre build — see
      // stopMarkerZoomGate), so RailMap owns the crossing itself. The
      // per-frame check is a float compare; setFilter runs only on the flip.
      this._applyMarkerSelectionFilters();
      map.on("zoom", () => {
        const gated = stopMarkerZoomGate(map.getZoom()) != null;
        if (gated !== this._stopMarkersGated)
          this._applyMarkerSelectionFilters();
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
      this._pushPickFan();
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
      // The static pick source sits on the true track (spacing-independent);
      // only the fan-scoped lanes move with the spacing.
      this._pushPickFan();
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
    setDateScope(activeDate, dimOpacity, crossDayDash) {
      const next = activeDate || null;
      const dim = Math.max(0, Math.min(1, Number(dimOpacity ?? 0.18)));
      const dash =
        crossDayDash === undefined ? this._crossDayDash : Boolean(crossDayDash);
      if (
        next === this._activeDate &&
        dim === this._dateDim &&
        dash === this._crossDayDash
      )
        return this;
      this._activeDate = next;
      this._dateDim = dim;
      this._crossDayDash = dash;
      // Every train-line layer filters on the cross-day split, so re-apply the
      // whole base/selection/hover set rather than just the two line layers.
      this._applyBaseFilters();
      this._applyHoverDim();
      return this;
    },
    // Toggle-only entry point ("顯示完整跨天行程"): re-splits the solid/dashed
    // layers without touching the date scope.
    setCrossDayDash(enabled) {
      const dash = Boolean(enabled);
      if (dash === this._crossDayDash) return this;
      this._crossDayDash = dash;
      this._applyBaseFilters();
      return this;
    },
    // Which records belong to the DASHED layer right now: the parts of a
    // cross-day train that run on a different date than the selected one,
    // while that train also runs on the selected date (`dspan` holds every
    // date it touches). With no day selected — the 全部 view — nothing is
    // dashed: there is no "other day" to contrast against.
    _xDaySelector() {
      const date = this._activeDate;
      if (!date || !this._crossDayDash) return MATCH_NONE;
      return [
        "all",
        ["!=", ["get", "edate"], date],
        ["in", "|" + date + "|", ["get", "dspan"]],
      ];
    },
    _applyXDayFilters() {
      const m = this._map;
      if (!m) return;
      if (m.getLayer(TRAIN_ROUTES_LAYER))
        m.setFilter(TRAIN_ROUTES_LAYER, [
          "all",
          this._notExpanded(),
          ["!", this._xDaySelector()],
        ]);
      if (m.getLayer(TRAIN_XDAY_LAYER))
        m.setFilter(TRAIN_XDAY_LAYER, [
          "all",
          this._notExpanded(),
          this._xDaySelector(),
        ]);
    },
    // The cross-day diamond, rasterized once per style: an ink lozenge with a
    // white rim, matching the ride-boundary dot's colour pair but never its
    // shape. Drawn at 2× so it stays crisp on retina.
    _ensureXDayIcon() {
      const m = this._map;
      if (!m || typeof m.addImage !== "function") return;
      if (m.hasImage && m.hasImage(XDAY_ICON_ID)) return;
      const ratio = 2;
      const r = XDAY_ICON_BASE_RADIUS;
      const size = Math.round(r * 2 * ratio);
      const canvas =
        typeof document !== "undefined"
          ? document.createElement("canvas")
          : null;
      if (!canvas) return;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const c = size / 2;
      const rim = 2 * ratio;
      const half = c - rim / 2 - ratio * 0.5;
      const diamond = (radius) => {
        ctx.beginPath();
        ctx.moveTo(c, c - radius);
        ctx.lineTo(c + radius, c);
        ctx.lineTo(c, c + radius);
        ctx.lineTo(c - radius, c);
        ctx.closePath();
      };
      diamond(half);
      ctx.fillStyle = "rgb(26,26,26)";
      ctx.fill();
      ctx.lineJoin = "miter";
      ctx.lineWidth = rim;
      ctx.strokeStyle = "rgb(255,255,255)";
      ctx.stroke();
      try {
        m.addImage(
          XDAY_ICON_ID,
          ctx.getImageData(0, 0, size, size),
          { pixelRatio: ratio },
        );
      } catch (e) {
        // A concurrent styleimagemissing can add it first; that is fine.
      }
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
      // Keep the attach() zoom watcher's flip detection in sync with what
      // these filters actually encode.
      const stopZoomGate = stopMarkerZoomGate(m.getZoom());
      this._stopMarkersGated = stopZoomGate != null;
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
        // Stop-dot zoom LOD, evaluated against the LIVE zoom: setFilter
        // replaces the boot-time filter wholesale, so every rebuild must
        // re-derive the gate or intermediate stop dots would resurface at low
        // zoom after a selection change or marker toggle. The zoom watcher in
        // attach() calls back in here when the view crosses the threshold.
        if (cat === "stop" && stopZoomGate) filters.push(stopZoomGate);
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
        // Route lines only — station dots (the cross-day diamond included)
        // belong to setMarkerVisibility, not to the 路線 layer switch.
        TRAIN_ROUTES_LAYER,
        TRAIN_XDAY_LAYER,
        TRAIN_PICK_LAYER,
        TRAIN_PICK_FAN_LAYER,
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
    // Deferred (worker) fit results attach to the same gi objects this
    // instance already holds, so hover needs nothing — only the debug
    // overlay and its published diagnostics report must refresh.
    notifyFitCurvesUpdated() {
      this._pushFitCurves();
      if (this._fitCurvesVisible) this._refreshFitCurveDiagnostics();
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
        // The cross-day diamond stands in for a station dot, so it follows the
        // same "are station markers shown at all" switch.
        this._setVisibility(TRAIN_XDAY_STOP_LAYER, vis);
        this._applyMarkerSelectionFilters();
      } else if (category === "pass") {
        const vis = v ? "visible" : "none";
        this._setVisibility(TRAIN_PASS_LAYER, vis);
        this._setVisibility(TRAIN_SEL_PASS_LAYER, vis);
      }
    },
    setNetworkVisible(v) {
      this._networkVisibleWanted = Boolean(v);
      this._setVisibility(
        SEGMENTS_LAYER,
        this._networkVisibleWanted ? "visible" : "none",
      );
    },
    setNetworkStationsVisible(v) {
      this._networkStationsVisibleWanted = Boolean(v);
      this._setVisibility(
        STATIONS_LAYER,
        this._networkStationsVisibleWanted ? "visible" : "none",
      );
    },
    // Lazily fetch + build + upload the active country's network package the
    // FIRST time it is actually needed (user opts into 全部鐵路線). The map is
    // built with EMPTY_FC network sources at boot (buildBaseStyle degrades that
    // way), so this just setData's the real collections into the two existing,
    // still-hidden sources. Deduped so concurrent toggles parse once.
    ensureNetwork() {
      if (this._network) return Promise.resolve(this._network);
      if (this._networkPromise) return this._networkPromise;
      const m = this._map;
      const generation = this._networkGeneration;
      const request = loadNetwork()
        .then((network) => {
          if (generation !== this._networkGeneration) return null;
          if (!network) {
            if (this._networkPromise === request) this._networkPromise = null;
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
              if (generation !== this._networkGeneration) return false;
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
          if (this._networkPromise === request) this._networkPromise = null;
          console.warn("[railmap] network load failed:", e);
          return null;
        });
      this._networkPromise = request;
      return request;
    },
    // Drop the previous country's in-memory network and reload only if the
    // user had already opted into the national-network overlay (or another
    // feature, such as station hover, had already loaded the network).
    switchNetworkCountry() {
      const shouldReload = Boolean(
        this._networkVisibleWanted ||
          this._networkStationsVisibleWanted ||
          this._network ||
          this._networkPromise,
      );
      this._networkGeneration += 1;
      this._network = null;
      this._networkPromise = null;
      this._stationPopupKey = null;
      if (this._stationPopup) this._stationPopup.remove();
      const seg = this._src(SEGMENTS_SOURCE);
      const sta = this._src(STATIONS_SOURCE);
      if (seg) seg.setData(EMPTY_FC);
      if (sta) sta.setData(EMPTY_FC);
      if (!shouldReload) return Promise.resolve(null);
      return this.ensureNetwork().then((network) => {
        // Country switching does not recreate the layer control. Re-apply its
        // current intent after the new sources are populated so a checked
        // "All Railway Lines" box can never leave an invisible Taiwan layer.
        this.setNetworkVisible(this._networkVisibleWanted);
        this.setNetworkStationsVisible(this._networkStationsVisibleWanted);
        return network;
      });
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
    // Theme switch = recolor the ONE installed basemap stack in place. Both
    // themes are the same positron layers (railmap-basemap.js), so writing the
    // target theme's color paint values — with the transitions pre-installed
    // at style build — crossfades every surface AND label smoothly. This
    // replaced the old dual staged-stack crossfade: two identical symbol
    // stacks fight in MapLibre's global label collision pass, and the staged
    // invisible copy won placement, blanking the visible theme's labels.
    _recolorBasemapStack(basemap, duration) {
      const m = this._map;
      const stack = this._basemapStack;
      if (!m || !stack || !basemap || !Array.isArray(basemap.layers))
        return false;
      const layerIds = stack.layerIds || [];
      if (layerIds.length !== basemap.layers.length) return false;
      const transition = {
        duration: Math.max(0, Number(duration) || 0),
        delay: 0,
      };
      const updateTransition =
        transition.duration !== this._basemapTransitionDuration;
      basemap.layers.forEach((layer, index) => {
        const id = layerIds[index];
        if (!m.getLayer(id)) return;
        Object.keys(layer.paint || {}).forEach((prop) => {
          if (!/-color$/.test(prop)) return;
          if (updateTransition)
            m.setPaintProperty(id, prop + "-transition", transition);
          m.setPaintProperty(id, prop, layer.paint[prop]);
        });
        // The city-dot sprite swaps between its black/light variants per
        // theme (layout, so it snaps — the dot is tiny and position-stable).
        const icon = layer.layout ? layer.layout["icon-image"] : undefined;
        if (icon !== undefined) {
          const current = m.getLayoutProperty(id, "icon-image");
          if (JSON.stringify(current) !== JSON.stringify(icon))
            m.setLayoutProperty(id, "icon-image", icon);
        }
      });
      this._basemapTransitionDuration = transition.duration;
      return true;
    },
    _applyThemePaint(theme, duration) {
      const m = this._map;
      if (!m) return;
      const colors = MAP_SURFACE_COLORS[theme === "dark" ? "dark" : "light"];
      const transition = {
        duration: Math.max(0, Number(duration) || 0),
        delay: 0,
      };
      if (m.getLayer("rp-bg")) {
        m.setPaintProperty(
          "rp-bg",
          "background-color-transition",
          transition,
        );
        m.setPaintProperty("rp-bg", "background-color", colors.background);
      }
      if (m.getLayer(FADE_LAYER)) {
        m.setPaintProperty(
          FADE_LAYER,
          "background-color-transition",
          transition,
        );
        m.setPaintProperty(FADE_LAYER, "background-color", colors.fade);
      }
      if (m.getLayer(TRAIN_SEL_CASING_LAYER))
        m.setPaintProperty(TRAIN_SEL_CASING_LAYER, "line-color", colors.casing);
    },
    _applyEffectiveFade(duration) {
      const m = this._map;
      if (!m || !m.getLayer(FADE_LAYER)) return;
      const transition = {
        duration: Math.max(0, Number(duration) || 0),
        delay: 0,
      };
      m.setPaintProperty(
        FADE_LAYER,
        "background-opacity-transition",
        transition,
      );
      m.setPaintProperty(
        FADE_LAYER,
        "background-opacity",
        this._fadeOpacity,
      );
    },
    _waitForBasemapSources(sourceIds, timeoutMs) {
      const m = this._map;
      if (!m || !sourceIds.length || typeof m.isSourceLoaded !== "function")
        return Promise.resolve();
      return new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = () => {
          if (done) return;
          done = true;
          if (timer !== null) clearTimeout(timer);
          if (typeof m.off === "function") m.off("sourcedata", check);
          resolve();
        };
        const check = () => {
          if (sourceIds.every((id) => m.getSource(id) && m.isSourceLoaded(id)))
            finish();
        };
        timer = setTimeout(finish, Math.max(0, Number(timeoutMs) || 1200));
        if (typeof m.on === "function") m.on("sourcedata", check);
        check();
        if (typeof m.triggerRepaint === "function") m.triggerRepaint();
      });
    },
    async _installBasemap(basemap, options = {}) {
      const m = this._map;
      if (!m || !basemap) return false;
      const visible = this._basemapMode === "positron";
      const oldLayerIds = this._basemapLayerIds.slice();
      const oldSourceIds = this._basemapSourceIds.slice();
      const animate =
        options.animate !== false &&
        visible &&
        oldLayerIds.some((id) => m.getLayer(id));
      const namespace =
        "rp-bm-" +
        ++this._basemapGeneration +
        "-" +
        (basemap.theme === "dark" ? "dark-" : "light-");
      const staged = namespaceBasemap(basemap, namespace, animate);
      const addedLayerIds = [];
      const addedSourceIds = [];
      try {
        // Stage the new basemap below the fade/railway stack while the old
        // basemap remains live. Once its tiles settle, cross-fade both stacks
        // directly instead of passing through a solid white/black cover.
        for (const id of Object.keys(staged.sources)) {
          if (!m.getSource(id)) {
            m.addSource(id, staged.sources[id]);
            addedSourceIds.push(id);
          }
        }
        if (basemap.glyphs && typeof m.setGlyphs === "function")
          m.setGlyphs(basemap.glyphs);
        if (basemap.sprite && typeof m.setSprite === "function")
          m.setSprite(basemap.sprite);

        const bmLayers = staged.layers;
        const addLayer = (sourceLayer, beforeId) => {
          const layer = Object.assign({}, sourceLayer);
          if (!visible) {
            layer.layout = Object.assign({}, layer.layout, { visibility: "none" });
          }
          m.addLayer(layer, beforeId);
          addedLayerIds.push(layer.id);
        };
        bmLayers.forEach((layer) => addLayer(layer, FADE_LAYER));

        if (animate) {
          await this._waitForBasemapSources(
            Object.keys(staged.sources),
            2200,
          );
          const transition = {
            duration: BASEMAP_CROSSFADE_MS,
            delay: 0,
          };
          oldLayerIds.forEach((id) => {
            const layer = m.getLayer(id);
            if (!layer) return;
            opacityPropsForLayer(layer).forEach((prop) => {
              m.setPaintProperty(id, prop + "-transition", transition);
              m.setPaintProperty(id, prop, 0);
            });
          });
          staged.opacityTargets.forEach((targets, id) => {
            if (!m.getLayer(id)) return;
            Object.keys(targets).forEach((prop) => {
              m.setPaintProperty(id, prop + "-transition", transition);
              m.setPaintProperty(id, prop, targets[prop]);
            });
          });
          await new Promise((resolve) =>
            setTimeout(resolve, BASEMAP_CROSSFADE_MS + 40),
          );
        }

        oldLayerIds
          .slice()
          .reverse()
          .forEach((id) => {
            if (m.getLayer(id)) m.removeLayer(id);
          });
        oldSourceIds.forEach((id) => {
          if (m.getSource(id)) m.removeSource(id);
        });

        this._basemapLayerIds = bmLayers.map((l) => l.id);
        this._basemapSourceIds = Object.keys(staged.sources);
        this._basemapInstalledTheme = basemap.theme || this._theme;
        this._basemapStack = {
          layerIds: this._basemapLayerIds.slice(),
          sourceIds: this._basemapSourceIds.slice(),
        };
        // The staged install wrote fresh transitions; future theme recolors
        // rely on the build-time BASEMAP_CROSSFADE_MS transitions.
        this._basemapTransitionDuration = BASEMAP_CROSSFADE_MS;
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
        return false;
      }
    },
    // Switches only the basemap palette, preserving all railway overlays and
    // the current view. Dark mode uses the recolored positron style
    // (railmap-basemap.js), keeping labels identical to light mode.
    async setBasemapTheme(theme, options = {}) {
      theme = theme === "dark" ? "dark" : "light";
      this._theme = theme;
      const animate = options.animate !== false;
      const duration = animate ? BASEMAP_CROSSFADE_MS : 0;
      this._applyThemePaint(theme, duration);
      if (!this._map) return false;
      if (this._basemapRetryInflight) await this._basemapRetryInflight;
      if (this._theme !== theme) return false; // superseded by a newer switch
      if (this._basemapInstalledTheme === theme && this._basemapStack)
        return true;
      if (this._basemapStack) {
        // The themed style is cache-warm after boot, so this resolves in a
        // microtask and the recolor starts within the same frame as the click.
        const basemap = await loadBasemap(theme);
        if (this._theme !== theme) return false;
        if (basemap && this._recolorBasemapStack(basemap, duration)) {
          this._basemapInstalledTheme = theme;
          return true;
        }
        // Recolor impossible (layer-count mismatch) — reinstall wholesale.
      }
      this._basemapRetryInflight = (async () => {
        try {
          const basemap = await loadBasemap(theme, true);
          if (!basemap) return false;
          if (!(await probeBasemapOrigin(basemap))) return false;
          return await this._installBasemap(basemap, { animate });
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
      if (this._basemapStack) {
        // Present but possibly painted for another theme (installed while a
        // switch raced) — converge via the cheap in-place recolor.
        if (this._basemapInstalledTheme !== this._theme)
          return this.setBasemapTheme(this._theme, { animate: false });
        return true;
      }
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
      this._fadeOpacity = Math.max(0, Math.min(1, Number(v) || 0));
      this._applyEffectiveFade(0);
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
      // Diagnostics dataset for the (default-OFF) hover-region debug overlay.
      // Gated on _hoverRegionsVisible: building this ~18-field object +
      // JSON.stringify + DOM dataset write ran on EVERY hover frame otherwise,
      // pure waste when the overlay is off (which it is in production).
      if (this._hoverRegionsVisible && this._map && this._map.getContainer) {
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
          // Debug approximation on the 256px-tile zoom convention (raw
          // getZoom()) — intentionally 2× the 512px (z + 1) convention that
          // app-overlap-lanes.js's overlapOffsetDeg uses for real lane
          // spacing. Report-only precision; do not "fix" one to the other.
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
    // Re-upload the STATIC pick source: every record's true-track hit area.
    // Depends only on the record set (never on fan state or lane spacing), so
    // it uploads on data changes alone — fan open/close touches only the
    // small fan-scoped source below.
    _pushPick() {
      const pick = this._src(TRAIN_PICK_SOURCE);
      if (pick)
        pick.setData(
          routePickRecordsToFC(
            this._visible ? this._records : [],
            this._groupInfo,
          ),
        );
      // The fan source mirrors the current fan state against the NEW records.
      this._pushPickFan();
    },
    // Re-upload the FAN pick source: only the open (or transitioning) group's
    // member records, translated into their per-lane hit paths. Empty while
    // collapsed. Orders of magnitude smaller than the static source, so the
    // per-hover re-tile cost no longer scales with the whole dataset.
    _pickFanEmpty: true,
    _pushPickFan() {
      const src = this._src(TRAIN_PICK_FAN_SOURCE);
      if (!src) return;
      const group = this._expandedGroup;
      const transition = this._groupTransition;
      if (!this._visible || (!group && !transition)) {
        if (!this._pickFanEmpty) {
          src.setData(EMPTY_FC);
          this._pickFanEmpty = true;
        }
        return;
      }
      const fc = routePickFanFC(
        this._records,
        this._groupInfo,
        group,
        this._fanDirGroup === group ? this._fanDirVec() : null,
        this._currentLaneSpacingDeg(),
        transition,
      );
      src.setData(fc);
      this._pickFanEmpty = fc.features.length === 0;
    },
    // The expand source is GROUP-SCOPED: it only ever holds the hovered
    // group's translated member courses (or nothing when collapsed).
    // `factor` scales the lane offsets (0 = on the true track, 1 = fully
    // fanned): _animateExpand pushes intermediate factors every frame so the
    // lanes SLIDE out/in instead of appearing at their final position.
    // Defaults to the current animation progress so settled states (open fan
    // during zoom / data refresh) keep their full offset.
    // Coalesce animated expand-source uploads to AT MOST ONE per frame. The
    // slide (_animateExpand), the fan-direction easing (_ensureFanDirAnim)
    // and a group transition can all run in the same frame; each used to
    // issue its own setData (a worker re-tile), so a single frame could pay
    // for two or three. The scheduled push reads the freshest state when it
    // fires; any synchronous (authoritative) push cancels what's pending.
    _scheduleExpandPush(group, factor) {
      this._pendingExpandPush = { group, factor };
      if (this._expandPushRaf != null) return;
      this._expandPushRaf = requestAnimationFrame(() => {
        this._expandPushRaf = null;
        const p = this._pendingExpandPush;
        this._pendingExpandPush = null;
        if (p) this._pushExpandFC(p.group, p.factor);
      });
    },
    _pushExpandFC(group, factor) {
      // A synchronous push is the latest truth — drop any stale queued frame.
      if (this._expandPushRaf != null) {
        cancelAnimationFrame(this._expandPushRaf);
        this._expandPushRaf = null;
        this._pendingExpandPush = null;
      }
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
          // Mid-ease frames go through the per-frame coalescer (the slide
          // animation may want the same frame's upload); the settled angle
          // commits synchronously so the final geometry is exact.
          if (settled) this._pushExpandFC(g);
          else this._scheduleExpandPush(g);
          // The sticky hit box safely covers the few-pixel angular drift. A
          // full pick-source upload every animation frame caused needless
          // main-thread stalls; commit hit geometry once at the settled angle.
          if (settled) this._pushPickFan();
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
      // Owns the base layer's filter: solid lines are "not expanded AND not
      // the cross-day half", the dashed layer takes the remainder.
      this._applyXDayFilters();
      // Engaged trains' TRUE-TRACK hit areas leave the static pick layer while
      // their fan lanes (in the fan pick source) replace them — otherwise the
      // emptied corridor centre would still hit-test as the member trains.
      if (m.getLayer(TRAIN_PICK_LAYER))
        m.setFilter(TRAIN_PICK_LAYER, [
          "all",
          ["!=", ["get", "nopick"], 1],
          this._notExpanded(),
        ]);
      this._applySelectionFilters();
      this._applyHoverFilter();
    },
    _applySelectionFilters() {
      const m = this._map;
      if (!m) return;
      const id = this._selectedTrainId || NO_TRAIN;
      // The dashed cross-day half stays dashed even when its train is picked:
      // the SEL layers would redraw it solid (and wider) on top otherwise.
      const f = [
        "all",
        ["==", ["get", "tid"], id],
        this._notExpanded(),
        ["!", this._xDaySelector()],
      ];
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
          // Same reason as the SEL layers: hovering must not un-dash the
          // cross-day half by drawing it solid on top.
          ["!", this._xDaySelector()],
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
        // Rebuilding the data-driven opacity expressions forces MapLibre to
        // re-evaluate paint for EVERY feature on up to nine layers — doing
        // that at 60–120 Hz for a 250–400 ms fade is the single biggest
        // main-thread cost while a hover engages. ~30 Hz is visually
        // indistinguishable for an opacity ramp; the final (settled) frame
        // always applies so end states are exact.
        if (!moving || now - (this._dimPaintAt || 0) >= 30)
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
      this._dimPaintAt = performance.now();
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
      // In scope = the feature's train RUNS on the selected day. `dspan` lists
      // every date the train touches, so an overnight train stays undimmed on
      // both of its days (its off-day half is told apart by the dash, not by
      // fading it into the background).
      const dateWrap = (own) =>
        sDate > 0 && this._dimDate
          ? [
              "case",
              ["in", "|" + this._dimDate + "|", ["get", "dspan"]],
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
      set(TRAIN_XDAY_LAYER, "line-opacity", baseOpacity);
      set(TRAIN_XDAY_STOP_LAYER, "icon-opacity", baseOpacity);
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
          this._pushPickFan();
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
        this._pushPickFan();
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
        this._pushPickFan();
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
        if (k < 1) {
          this._scheduleExpandPush(targetGroup, 1);
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
        this._pushPickFan();
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
        // progress so the lines physically move out/in. Mid-animation frames
        // coalesce with any same-frame fan-direction push; the final frame
        // commits synchronously so the settled position is exact.
        if (k < 1) {
          if (this._animGroup) this._scheduleExpandPush(this._animGroup, v);
          this._expandAnimId = requestAnimationFrame(step);
        } else {
          if (this._animGroup) this._pushExpandFC(this._animGroup, v);
          this._expandAnimId = null;
          if (done) done();
        }
      };
      this._expandAnimId = requestAnimationFrame(step);
    },
  };

  global.RailMap = RailMap;
})(window);
