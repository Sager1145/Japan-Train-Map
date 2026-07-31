// =========================================================================
//  app-map-init.js — §21: map initialization (MapLibre GL + railprint-style map core)
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §21.  Map initialization (MapLibre GL + railprint-style map core)
// =========================================================================
// The map renders with MapLibre GL, styled after yzhouwang/railprint
// (see railmap.js for the ported style system):
//   - OpenFreeMap Positron/Dark vector styles (online tiles), with a plain
//     theme-matched background when unavailable or the user chooses no map,
//   - the full MLIT N02 national network + stations from railprint's
//     jp-2025 rail package, every line in its official color, revealed
//     by zoom tier (rank) and station spacing — OFF by default, toggled
//     via the "All Railway Lines" switch in the layers control,
//   - train routes/markers as GeoJSON layers with railprint's "ridden"
//     treatment: full official color, dark ink casing under the selected
//     route (no glow).

// Custom map-corner control: basemap picker + overlay checkboxes (replaces
// the old Leaflet layers control).
function buildMapLayersControl(hasBasemap) {
  const wrap = document.createElement("details");
  wrap.className = "map-layers-control";
  // Collapsed by default on every screen size — it opens on click/tap. (It used
  // to auto-open on desktop, covering the top-right of the map on load.)
  wrap.open = false;

  const summary = document.createElement("summary");
  summary.className = "map-layers-summary";
  const summaryText = document.createElement("span");
  summary.appendChild(summaryText);
  wrap.appendChild(summary);

  const body = document.createElement("div");
  body.className = "map-layers-body";

  const selectLabel = document.createElement("label");
  selectLabel.className = "map-basemap-field";
  const selectLabelText = document.createElement("span");
  selectLabel.appendChild(selectLabelText);
  const select = document.createElement("select");
  // "OpenFreeMap (online)" is ALWAYS offered: when boot has no basemap the
  // option becomes the online-retry entry point (picking it re-attempts the
  // basemap via RailMap.retryBasemap and reverts on failure).
  const options = [
    ["positron", "map.positron"],
    ["none", "map.noBasemap"],
  ];
  const optionNodes = new Map();
  options.forEach(([value, labelKey]) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = I18N.t(labelKey);
    select.appendChild(o);
    optionNodes.set(value, { node: o, labelKey });
  });
  selectLabel.appendChild(select);
  body.appendChild(selectLabel);
  select.value = hasBasemap ? "positron" : "none";
  RailMap.setBasemapMode(select.value);
  let prevMode = select.value;
  let positronState = hasBasemap ? "" : "unavailable";

  const updateControlTranslations = () => {
    summaryText.textContent = I18N.t("map.layers");
    selectLabelText.textContent = I18N.t("map.basemap");
    select.setAttribute("aria-label", I18N.t("map.basemap"));
    optionNodes.forEach(({ node, labelKey }, value) => {
      node.textContent = I18N.t(labelKey);
      if (value === "positron" && positronState)
        node.textContent += ` — ${I18N.t("map." + positronState)}`;
    });
  };
  updateControlTranslations();

  const ensureBasemap = async () => {
    if (RailMap.hasBasemap()) return true;
    positronState = "connecting";
    updateControlTranslations();
    const ok = await RailMap.retryBasemap();
    positronState = ok ? "" : "retryFailed";
    updateControlTranslations();
    if (!ok)
      setTimeout(() => {
        if (!RailMap.hasBasemap()) {
          positronState = "unavailable";
          updateControlTranslations();
        }
      }, 2500);
    return ok;
  };
  select.addEventListener("change", async () => {
    const mode = select.value;
    if (mode === "positron" && !RailMap.hasBasemap()) {
      select.disabled = true;
      const ok = await ensureBasemap();
      select.disabled = false;
      if (!ok) {
        // Stay on the previous (working) basemap; the option label reports
        // the failure so the user knows to retry later.
        select.value = prevMode;
        return;
      }
    }
    prevMode = mode;
    RailMap.setBasemapMode(mode);
  });
  // Auto-recovery: when the browser regains connectivity, pre-warm the vector
  // basemap in the background. The view only switches if the user has already
  // picked "OpenFreeMap (online)" — otherwise the option just becomes available.
  if (!hasBasemap) {
    window.addEventListener("online", () => {
      if (RailMap.hasBasemap()) return;
      ensureBasemap().then((ok) => {
        if (ok && select.value === "positron") RailMap.setBasemapMode("positron");
      });
    });
  }

  // Latest desired state of the 全部鐵路線 overlay. ensureNetwork() lazily loads
  // the 9.2 MB package on first opt-in (~1 s); if the user toggles back OFF
  // during that load, this guards the deferred .then() from re-showing the
  // layers against the user's newer intent (toggle-off-during-load race).
  let networkOverlayWanted = false;
  const toggles = [
    ["map.routes", (v) => RailMap.setVisible(v), true],
    ["map.stops", (v) => RailMap.setMarkerVisibility("stop", v), true],
    ["map.terminals", (v) => RailMap.setMarkerVisibility("terminal", v), true],
    ["map.passThrough", (v) => RailMap.setMarkerVisibility("pass", v), true],
    // 全部線路（全國路網 + 車站點）：opt-in, OFF by default. The network package
    // is deferred out of boot (RailMap.ensureNetwork), so first opt-in loads it
    // lazily, THEN reveals the now-populated hidden layers.
    [
      "map.allRailways",
      (v) => {
        networkOverlayWanted = v;
        if (v) {
          RailMap.ensureNetwork().then(() => {
            if (!networkOverlayWanted) return; // toggled back off during load
            RailMap.setNetworkVisible(true);
            RailMap.setNetworkStationsVisible(true);
          });
        } else {
          RailMap.setNetworkVisible(false);
          RailMap.setNetworkStationsVisible(false);
        }
      },
      false,
    ],
  ];
  const toggleLabels = [];
  toggles.forEach(([labelKey, apply, on]) => {
    const item = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    cb.addEventListener("change", () => apply(cb.checked));
    const labelText = document.createElement("span");
    labelText.textContent = I18N.t(labelKey);
    item.appendChild(cb);
    item.appendChild(labelText);
    toggleLabels.push({ labelText, labelKey });
    body.appendChild(item);
  });

  // 已乘路線 category toggles: hide/show RIDDEN route lines per category
  // (新幹線 / JR在來線 / 地下鐵 / 私鐵). 全部鐵路線 above stays independent.
  const riddenHead = document.createElement("div");
  riddenHead.className = "map-layers-subhead";
  const riddenHeadText = document.createElement("span");
  riddenHeadText.textContent = I18N.t("map.riddenGroup");
  riddenHead.appendChild(riddenHeadText);
  toggleLabels.push({ labelText: riddenHeadText, labelKey: "map.riddenGroup" });
  body.appendChild(riddenHead);
  [
    ["stat.hsr", "hsr"],
    ["map.riddenJr", "jr"],
    ["stat.metro", "metro"],
    ["map.riddenPriv", "priv"],
  ].forEach(([labelKey, cat]) => {
    const item = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = RIDDEN_CATEGORY_FILTER[cat] !== false;
    cb.addEventListener("change", () => setRiddenCategoryFilter(cat, cb.checked));
    const labelText = document.createElement("span");
    labelText.textContent = I18N.t(labelKey);
    item.appendChild(cb);
    item.appendChild(labelText);
    toggleLabels.push({ labelText, labelKey });
    body.appendChild(item);
  });
  const translateAll = () => {
    updateControlTranslations();
    toggleLabels.forEach(({ labelText, labelKey }) => {
      labelText.textContent = I18N.t(labelKey);
    });
  };
  I18N.onChange(translateAll);

  wrap.appendChild(body);
  map.getContainer().appendChild(wrap);
}

// One compact, human-readable home for every map symbol explanation and data
// credit. This replaces MapLibre's fragmented attribution strip so the map has
// exactly one bottom-right information button on desktop and mobile.
function buildMapInfoControl() {
  const control = document.createElement("details");
  control.className = "map-info-control";

  const summary = document.createElement("summary");
  summary.className = "map-info-summary";
  summary.setAttribute("data-i18n-aria-label", "info.button");
  summary.setAttribute("aria-expanded", "false");
  summary.innerHTML = '<span aria-hidden="true">i</span>';

  const panel = document.createElement("div");
  panel.className = "map-info-panel";
  panel.innerHTML = `
    <header class="map-info-header">
      <h2 data-i18n="info.title">圖例與資料來源</h2>
      <p data-i18n="info.intro">快速理解地圖符號，以及本地圖使用的資料與授權。</p>
    </header>

    <section class="map-info-section" aria-labelledby="map-info-legend-heading">
      <h3 id="map-info-legend-heading" data-i18n="info.legendHeading">地圖圖例</h3>
      <div class="map-info-legend-row">
        <span class="map-info-symbol map-info-symbol--route" aria-hidden="true"></span>
        <div><strong data-i18n="info.routeTitle">列車路線</strong><p data-i18n="info.routeDesc">使用列車指定色顯示；選中時增加墨色底襯。</p></div>
      </div>
      <div class="map-info-legend-row">
        <span class="map-info-symbol map-info-symbol--stop" aria-hidden="true"></span>
        <div><strong data-i18n="info.stopTitle">中途停靠站</strong><p data-i18n="info.stopDesc">與通過站使用相同大小的空心圓，中心增加黑點。</p></div>
      </div>
      <div class="map-info-legend-row">
        <span class="map-info-symbol map-info-symbol--pass" aria-hidden="true"></span>
        <div><strong data-i18n="info.passTitle">通過站</strong><p data-i18n="info.passDesc">與中途停靠站外圈同尺寸，但中心保持留白。</p></div>
      </div>
      <div class="map-info-legend-row">
        <span class="map-info-symbol map-info-symbol--terminal" aria-hidden="true"></span>
        <div><strong data-i18n="info.terminalTitle">起點與終點</strong><p data-i18n="info.terminalDesc">使用較大的墨色圓點與白色外圈，保持行程端點醒目。</p></div>
      </div>
      <div class="map-info-legend-row">
        <span class="map-info-symbol map-info-symbol--network" aria-hidden="true"></span>
        <div><strong data-i18n="info.networkTitle">全部鐵路線</strong><p data-i18n="info.networkDesc">可在地圖圖層中開啟，顯示官方路線色與灰色車站點。</p></div>
      </div>
    </section>

    <section class="map-info-section" aria-labelledby="map-info-sources-heading">
      <h3 id="map-info-sources-heading" data-i18n="info.sourcesHeading">資料與授權</h3>
      <div class="map-info-sources">
        <article class="map-info-source">
          <strong data-i18n="info.n02Title">日本鐵路網</strong>
          <p data-i18n="info.n02Body">國土交通省「國土數值情報（鐵道資料 N02）」經加工製作。</p>
          <div class="map-info-links"><a href="https://nlftp.mlit.go.jp/ksj/" target="_blank" rel="noopener noreferrer">MLIT N02</a><a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a></div>
        </article>
        <article class="map-info-source">
          <strong data-i18n="info.basemapTitle">地圖底圖</strong>
          <p data-i18n="info.basemapBody">亮色使用 OpenFreeMap Positron，暗色使用官方 Dark 樣式。</p>
          <div class="map-info-links"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a><a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a></div>
        </article>
        <article class="map-info-source">
          <strong data-i18n="info.namesTitle">站名羅馬字</strong>
          <p data-i18n="info.namesBody">OpenStreetMap contributors，依 ODbL 授權。</p>
        </article>
        <article class="map-info-source">
          <strong data-i18n="info.packageTitle">鐵路資料包</strong>
          <p data-i18n="info.packageBody">使用 railprint 的 jp-2025 日本鐵路資料包。</p>
          <div class="map-info-links"><a href="https://github.com/yzhouwang/railprint" target="_blank" rel="noopener noreferrer">railprint</a></div>
        </article>
      </div>
    </section>
  `;

  control.append(summary, panel);
  map.getContainer().appendChild(control);
  I18N.applyStatic(control);

  control.addEventListener("toggle", () => {
    summary.setAttribute("aria-expanded", control.open ? "true" : "false");
  });
  control.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && control.open) {
      control.open = false;
      summary.focus();
    }
  });
  map.getContainer().addEventListener("pointerdown", (event) => {
    if (control.open && !control.contains(event.target)) control.open = false;
  });
}

async function initMap(mapAssetsReady) {
  // The theme-selected OpenFreeMap style + railprint's jp-2025 package load in
  // parallel (pre-started at boot, before the /api datasets); either may be
  // null (source unavailable) — the style builder degrades the same way railprint does
  // (plain background / no network overlay). The alternate theme is loaded
  // ONLY to warm RailMap.loadBasemap's cache (instant first theme switch);
  // the style itself stages a single stack that theme switches recolor in
  // place — a second staged stack would collide-out every basemap label.
  const theme = resolveDisplayTheme();
  const alternateTheme = theme === "dark" ? "light" : "dark";
  const [basemap, alternateBasemap, network] = await (mapAssetsReady ||
    Promise.all([
      RailMap.loadBasemap(theme),
      RailMap.loadBasemap(alternateTheme),
      Promise.resolve(null),
    ]));
  const style = RailMap.buildBaseStyle({
    basemap,
    network,
    theme,
    fadeOpacity: 1 - Math.max(0, Math.min(1, Number(DISPLAY.mapOpacity))),
    // Pass-through dot LOD: the numerous white dots only draw from this zoom
    // (layer minzoom — no marker rebuild when the view crosses it).
    passMinzoom: PASSTHROUGH_MIN_ZOOM,
    // Stop-dot LOD: intermediate stop dots follow at a lower threshold
    // (filter-level, rebuilt by RailMap on threshold crossings, since
    // terminals share those layers and always draw).
    stopMinzoom: STOP_MIN_ZOOM,
  });
  const isSmallScreen = window.matchMedia("(max-width: 900px)").matches;
  map = new maplibregl.Map({
    container: "map",
    style,
    // A custom bottom-right i control presents attribution together with the
    // map legend in one structured, readable panel.
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    center: [138.2, 36.4],
    zoom: 4,
    // Cap the device pixel ratio. A DPR-3 iPhone would otherwise allocate a
    // WebGL canvas backing store ~9x (3^2) the CSS-pixel area — a leading cause
    // of WebKit terminating the tab under memory pressure ("jetsam"). 2 keeps
    // retina crispness (~4x) on desktop; phones are capped tighter (~2.25x).
    pixelRatio: Math.min(window.devicePixelRatio || 1, isSmallScreen ? 1.5 : 2),
    // Japan is a single small region viewed at zoom >= 4, so the antimeridian
    // world-copy wrapping is never visible — skip it to save render work/memory.
    renderWorldCopies: false,
    // Bound the basemap vector-tile cache on phones so panning doesn't grow the
    // GPU/JS tile pool without limit (desktop keeps MapLibre's adaptive default).
    ...(isSmallScreen ? { maxTileCacheSize: 24 } : {}),
    // fadeDuration:0 — the train overlay's opacity fades are rAF-driven via
    // setPaintProperty on line/circle layers (see railmap's dim engine), NOT by
    // MapLibre's symbol/label crossfade, so a non-zero fadeDuration buys the
    // overlay nothing. It DOES keep MapLibre's symbol-placement render loop
    // (_updatePlacement) scheduling frames while basemap labels crossfade, which
    // prevents the map from settling to idle after route data stops changing.
    // Snapping labels in (no 200ms crossfade) lets _triggerRenderFrame quiesce.
    fadeDuration: 0,
  });
  // The drawer overlays a fixed-size WebGL viewport. Camera padding keeps the
  // initial view centred in the uncovered area without resizing or distorting
  // the canvas.
  applySidebarMapPadding(sidebarCurrentSize(), 0);
  if (map.touchZoomRotate && map.touchZoomRotate.disableRotation)
    map.touchZoomRotate.disableRotation();
  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false }),
    "top-left",
  );

  // Bounded readiness wait: a stalled tile origin must not hang boot — the
  // rail/train sources are same-origin GeoJSON and usable immediately.
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    map.on("load", finish);
    setTimeout(finish, 9000);
  });

  RailMap.attach(
    map,
    network,
    {
      onClick: handleDeckRouteClick,
      onMarkerClick: handleDeckMarkerClick,
      onBackgroundClick: handleMapBackgroundClick,
      onHover: handleDeckHover,
      getTooltip: deckGetTooltip,
    },
    basemap ? basemap.layers.map((l) => l.id) : [],
    basemap ? Object.keys(basemap.sources) : [],
    theme,
    style.__railMapBasemapStacks,
  );
  // Selected-train width boost lives in the SEL layer's paint expression
  // (records stay selection-independent — picking a train rebuilds nothing).
  RailMap.setFocusBoost(DISPLAY.focusBoost);
  RailMap.setFitCurvesVisible(DISPLAY.showFitCurves);
  RailMap.setHoverRegionsVisible(DISPLAY.showHoverRegions);
  buildMapLayersControl(Boolean(basemap || alternateBasemap));
  buildMapInfoControl();

  // Online basemap tile failures degrade to the plain background — never fatal.
  map.on("error", (e) => {
    const msg = (e && e.error && e.error.message) || "";
    const url = (e && e.error && e.error.url) || "";
    if (url.includes("openfreemap") || msg.includes("openfreemap")) return;
    console.warn("[map]", msg || e);
  });

  // The OpenFreeMap Dark style's landcover_wood layer uses a "wood-pattern"
  // fill image that its sprite doesn't ship, so MapLibre logged a "could not be
  // loaded" error for EVERY tile that contains woodland (hundreds of lines of
  // console spam). Supply a 1×1 transparent pixel for any missing style image:
  // the fill falls back to its base color and the console stays clean.
  map.on("styleimagemissing", (e) => {
    const id = e && e.id;
    if (!id || map.hasImage(id)) return;
    map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  // Marker LOD is handled by the pass layers' minzoom (no re-render); zoom
  // only re-layouts the endpoint labels (their overlap layout is pixel-space).
  map.on("zoomend", () => {
    if (!cachedOrderedTrains.length) return;
    updateEndpointLabels();
    // Parallel pick lanes are offset in degrees computed from a PIXEL spacing
    // at the previous view; refresh them so the lanes keep a constant
    // on-screen spacing (no-op when the px→degree factor barely moved).
    maybeRefreshOverlapOffsets();
  });

  // Long north/south pans change the latitude correction even at constant
  // zoom — refresh the lane offsets when the drift exceeds the threshold.
  map.on("moveend", maybeRefreshOverlapOffsets);

  // Endpoint labels clamp themselves inside the viewport (pixel-space), so a
  // pan that carries a labelled station toward the edge needs a re-layout.
  map.on("moveend", () => {
    if (cachedOrderedTrains.length) updateEndpointLabels();
  });

  // Clamp the map over Japan; minZoom depends on the pixel viewport.
  applyJapanMapConstraints();
  map.on("resize", applyJapanMapConstraints);

  // Trackpad pinch ANYWHERE on the page zooms the MAP, never the browser
  // page (page zoom stays available via the browser's ±% menu / keyboard
  // shortcuts). In Chromium/Edge a trackpad pinch arrives as a wheel event
  // with ctrlKey set; preventDefault blocks the browser's page zoom. Over
  // the map canvas MapLibre's own scroll-zoom handler already consumes the
  // gesture, so we only forward pinches that land on the sidebar / other UI,
  // anchored at the current map center. Plain (non-pinch) two-finger scroll
  // is untouched so the sidebar still scrolls normally.
  // Attached to the SIDEBAR, not `document`: a non-passive wheel listener on
  // document disables the compositor fast path for every scroll on the page
  // (the browser must wait for JS before starting any scroll, even with the
  // early return). The map canvas is already covered by MapLibre's own
  // handler, and #sidebar + #map fill the whole viewport, so scoping the
  // listener loses nothing.
  // Shared pinch→map-zoom forwarder. anchorAtCursor keeps the point under
  // the pointer fixed (matches MapLibre's own scroll-zoom feel over the
  // canvas); the sidebar path anchors at the map center instead (the cursor
  // isn't over the map there).
  const forwardPinchZoom = (e, anchorAtCursor) => {
    e.preventDefault(); // block the browser page-zoom
    if (!map) return;
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 20; // DOM_DELTA_LINE -> px
    else if (e.deltaMode === 2) delta *= 60; // DOM_DELTA_PAGE -> px
    delta = Math.max(-50, Math.min(50, delta));
    const target = Math.max(
      map.getMinZoom(),
      Math.min(map.getMaxZoom(), map.getZoom() - delta * 0.01),
    );
    if (anchorAtCursor) {
      const rect = map.getContainer().getBoundingClientRect();
      const around = map.unproject([
        e.clientX - rect.left,
        e.clientY - rect.top,
      ]);
      map.easeTo({ zoom: target, around, duration: 0 });
    } else {
      map.setZoom(target);
    }
  };
  const sidebarEl = document.getElementById("sidebar");
  (sidebarEl || document).addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return; // not a pinch: keep normal scrolling
      if (map && map.getContainer().contains(e.target)) return; // map's own
      forwardPinchZoom(e, false);
    },
    { passive: false },
  );
  // MapLibre's scroll-zoom handler is bound to the CANVAS container, but
  // popups (segment/stop click popup, station hover popup), the layers
  // control and the nav/attribution controls live in the OUTER map container
  // — a trackpad pinch over any of them used to fall through to the browser
  // and zoom the whole page. Catch those here and forward them to the map,
  // anchored at the cursor. Events whose target is inside the canvas
  // container are left alone (MapLibre consumes and preventDefaults them),
  // and plain (non-ctrl) scrolling is untouched so popup content can still
  // scroll internally.
  map.getContainer().addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return; // not a pinch
      if (map.getCanvasContainer().contains(e.target)) return; // MapLibre's
      forwardPinchZoom(e, true);
    },
    { passive: false },
  );
  // Safari reports a trackpad pinch as gesture* events instead; blocking the
  // default suppresses its full-page zoom the same way. On touch devices the
  // same gesture* events fire for finger pinches ANYWHERE on the page, so
  // there the block only covers the map — a document-wide preventDefault
  // would disable Safari's accessibility pinch zoom over the sidebar.
  const coarsePointer = window.matchMedia("(pointer: coarse)");
  ["gesturestart", "gesturechange", "gestureend"].forEach((type) =>
    document.addEventListener(
      type,
      (e) => {
        if (
          coarsePointer.matches &&
          (!map || !map.getContainer().contains(e.target))
        )
          return;
        e.preventDefault();
      },
      { passive: false },
    ),
  );
}

// The one click-opened popup (route segment or stop). Tracked so a store
// replacement (live reload / delete-all) can close it — otherwise a popup
// left open kept showing data for a train that no longer exists.
let _clickPopup = null;
function openClickPopup(coordinate, html) {
  if (_clickPopup) _clickPopup.remove();
  _clickPopup = new maplibregl.Popup({ maxWidth: "320px" })
    .setLngLat(coordinate)
    .setHTML(html)
    .addTo(map);
}
function closeClickPopup() {
  if (_clickPopup) {
    _clickPopup.remove();
    _clickPopup = null;
  }
}

// Blank-map click (no route lane / station dot under the pointer) steps the
// view BACK one level instead of jumping straight to "全部":
//   1. a train is selected      -> clear the selection, stay on its day
//                                  (the whole day's routes re-appear solid);
//   2. a concrete day, no train -> back to the all-dates view ("全部");
//   3. already "全部", nothing selected -> no-op (idle clicks re-render
//      nothing).
function handleMapBackgroundClick() {
  if (selectedTrainId || focusedTrainId) {
    const day = selectedDate; // selection always lives on a concrete day
    selectDateBucket(day);
    return;
  }
  if (selectedDate !== ALL_DATES) selectDateBucket(ALL_DATES);
}

// Shared click guard for on-map route lines and station dots. Off-date
// trains are not clickable while a concrete day is active (their pick lanes
// are filtered out in railmap, this guard is belt-and-braces). `selectsNow`
// tells the caller whether the click actually SELECTS the train — a stage-1
// click from "全部" (or another day) just activates the train's day, exactly
// like pressing that date button, and must not open a popup.
function interactiveTrainFromClick(info) {
  if (!info || !info.object) return null;
  const { train, feature } = info.object;
  if (!train) return null;
  const trainDate = getTrainDate(train);
  if (selectedDate !== ALL_DATES && trainDate !== selectedDate) return null;
  return { train, feature, selectsNow: trainDate === selectedDate };
}

// Route click -> select the train. Deliberately NO popup: the old segment
// popup dumped ~12 rows of solver diagnostics (route_id, route_choice, source,
// allowed N02_002, segment_index …) into a panel big enough to cover the map
// and the controls. The hover tooltip already names the train — including the
// branch number on 併結 / 直通 sections — and the editor shows the rest.
function handleDeckRouteClick(info) {
  const hit = interactiveTrainFromClick(info);
  if (!hit) return;
  pickTrain(hit.train.id);
}
