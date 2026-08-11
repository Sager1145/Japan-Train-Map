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
  summary.setAttribute("role", "button");
  summary.setAttribute("aria-haspopup", "true");
  summary.setAttribute("aria-expanded", "false");
  summary.setAttribute("aria-controls", "map-layers-body");
  const summaryText = document.createElement("span");
  summary.appendChild(summaryText);
  wrap.appendChild(summary);

  const body = document.createElement("div");
  body.className = "map-layers-body";
  body.id = "map-layers-body";
  body.setAttribute("role", "group");

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
    o.textContent = I18N.tc(labelKey);
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
    summary.setAttribute("aria-label", I18N.t("map.layers"));
    body.setAttribute("aria-label", I18N.t("map.layers"));
    selectLabelText.textContent = I18N.t("map.basemap");
    select.setAttribute("aria-label", I18N.t("map.basemap"));
    optionNodes.forEach(({ node, labelKey }, value) => {
      node.textContent = I18N.tc(labelKey);
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

  // Latest desired state of the 全部鐵路線 overlay. Its geometry model is
  // already loaded because ridden routes use it too; ensureNetwork() still
  // covers recovery after a failed request and country-switch races.
  let networkOverlayWanted = false;
  const toggles = [
    ["map.routes", (v) => RailMap.setVisible(v), true],
    ["map.stops", (v) => RailMap.setMarkerVisibility("stop", v), true],
    ["map.terminals", (v) => RailMap.setMarkerVisibility("terminal", v), true],
    ["map.passThrough", (v) => RailMap.setMarkerVisibility("pass", v), true],
    // 全部線路（全國路網 + 車站點）：opt-in, OFF by default. The complete-line
    // model is shared with ridden routes, while this switch controls only the
    // background network and station layers.
    [
      "map.allRailways",
      (v) => {
        networkOverlayWanted = v;
        // Record intent immediately, even while the lazy fetch is in flight.
        // RailMap uses this state to reload the correct package on a country
        // switch and to recover from a prior failed network request.
        RailMap.setNetworkVisible(v);
        RailMap.setNetworkStationsVisible(v);
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
    labelText.textContent = I18N.tc(labelKey);
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
  riddenHeadText.textContent = I18N.tc("map.riddenGroup");
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
    labelText.textContent = I18N.tc(labelKey);
    item.appendChild(cb);
    item.appendChild(labelText);
    toggleLabels.push({ labelText, labelKey });
    body.appendChild(item);
  });
  const translateAll = () => {
    updateControlTranslations();
    toggleLabels.forEach(({ labelText, labelKey }) => {
      labelText.textContent = I18N.tc(labelKey);
    });
  };
  I18N.onChange(translateAll);

  wrap.appendChild(body);
  map.getContainer().appendChild(wrap);

  // Match a system menu/popover: expose state to assistive technology,
  // dismiss on Escape or an outside tap, and never stack it over the map-info
  // popover. Multiple layer selections intentionally keep the menu open.
  wrap.addEventListener("toggle", () => {
    summary.setAttribute("aria-expanded", wrap.open ? "true" : "false");
    map.getContainer().classList.toggle("layers-menu-open", wrap.open);
    if (wrap.open) {
      const info = map.getContainer().querySelector(".map-info-control");
      if (info) info.open = false;
    }
  });
  wrap.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && wrap.open) {
      wrap.open = false;
      summary.focus();
    }
  });
  map.getContainer().addEventListener("pointerdown", (event) => {
    if (wrap.open && !wrap.contains(event.target)) wrap.open = false;
  });
}

// One compact, human-readable home for every map symbol explanation and data
// credit. This replaces MapLibre's fragmented attribution strip so the map has
// exactly one bottom-right information button on desktop and mobile.
function buildMapInfoControl() {
  const control = document.createElement("details");
  control.className = "map-info-control";

  const summary = document.createElement("summary");
  summary.className = "map-info-summary";
  // Same disclosure semantics as .map-layers-summary — the two corner
  // popovers must read identically to assistive tech.
  summary.setAttribute("role", "button");
  summary.setAttribute("aria-haspopup", "true");
  summary.setAttribute("aria-expanded", "false");
  summary.setAttribute("aria-controls", "map-info-panel");
  summary.setAttribute("data-i18n-aria-label", "info.button");
  summary.innerHTML = '<span aria-hidden="true">i</span>';

  const panel = document.createElement("div");
  panel.className = "map-info-panel";
  panel.id = "map-info-panel";
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
        <article class="map-info-source" data-country="jp">
          <strong data-i18n="info.n02Title">日本鐵路網</strong>
          <p data-i18n="info.n02Body">國土交通省「國土數值情報（鐵道資料 N02）」經加工製作。</p>
          <div class="map-info-links"><a href="https://nlftp.mlit.go.jp/ksj/" target="_blank" rel="noopener noreferrer">MLIT N02</a><a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a></div>
        </article>
        <article class="map-info-source" data-country="tw">
          <strong data-i18n="info.twRailTitle">台灣鐵路網</strong>
          <p data-i18n="info.twRailBody">結合交通部「TDX 運輸資料流通服務平臺」、內政部國土測繪中心、農業部阿里山林業鐵路及文化資產管理處與臺北市政府捷運工程局的官方資料經加工製作。</p>
          <div class="map-info-links"><a href="https://tdx.transportdata.tw/" target="_blank" rel="noopener noreferrer">TDX</a><a href="https://data.gov.tw/dataset/73220" target="_blank" rel="noopener noreferrer" data-i18n="info.twNlsc">國土測繪中心</a><a href="https://afrch.forest.gov.tw/" target="_blank" rel="noopener noreferrer" data-i18n="info.twAfr">阿里山林鐵</a><a href="https://data.taipei/dataset/detail?id=afccd2ac-75b1-4362-9099-45983e332776" target="_blank" rel="noopener noreferrer" data-i18n="info.twTaipei">臺北捷運 GIS</a><a href="https://data.gov.tw/license" target="_blank" rel="noopener noreferrer" data-i18n="info.twLicense">政府資料開放授權條款</a></div>
        </article>
        <article class="map-info-source" data-country="hk">
          <strong data-i18n="info.hkRailTitle">香港鐵路網</strong>
          <p data-i18n="info.hkRailBody">依香港鐵路有限公司官方行程指南與開放數據加工製作，包含港鐵重鐵及全部 11 條輕鐵路線。</p>
          <div class="map-info-links"><a href="https://www.mtr.com.hk/en/customer/jp/index.php" target="_blank" rel="noopener noreferrer">MTR Journey Planner</a><a href="https://data.gov.hk/en-data/dataset/mtr-data-routes-fares-barrier-free-facilities" target="_blank" rel="noopener noreferrer">MTR Open Data</a></div>
        </article>
        <article class="map-info-source" data-country="mo">
          <strong data-i18n="info.moRailTitle">澳門輕軌網</strong>
          <p data-i18n="info.moRailBody">依澳門輕軌股份有限公司官方現行路線與車站資料加工製作。</p>
          <div class="map-info-links"><a href="https://www.mlm.com.mo/en/route.html" target="_blank" rel="noopener noreferrer">Macao LRT Lines</a></div>
        </article>
        <article class="map-info-source">
          <strong data-i18n="info.basemapTitle">地圖底圖</strong>
          <p data-i18n="info.basemapBody">亮色使用 OpenFreeMap Positron，暗色使用官方 Dark 樣式。</p>
          <div class="map-info-links"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a><a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a></div>
        </article>
        <article class="map-info-source" data-country="jp">
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
  // Attribution articles are per-country ([data-country]); hide the ones that
  // don't apply to the active dataset (MLIT N02 for Japan, TDX for Taiwan).
  if (typeof applyCountryVisibility === "function")
    applyCountryVisibility(control);

  control.addEventListener("toggle", () => {
    summary.setAttribute("aria-expanded", control.open ? "true" : "false");
    if (control.open) {
      const layers = map.getContainer().querySelector(".map-layers-control");
      if (layers) layers.open = false;
    }
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

// ───────────────────────── errored-tile recovery ─────────────────────────
// MapLibre never retries a tile whose request failed: `_loadTile` sets
// `tile.state = "errored"` and `reload()` deliberately skips errored tiles, so
// one transient network blip on tiles.openfreemap.org leaves that map square
// permanently blank — the map even reports `areTilesLoaded()` as done. That is
// the "a few squares never load, or only load once you zoom right in" symptom:
// zooming far enough asks for DIFFERENT tile ids, which succeed.
//
// `map.refreshTiles(sourceId, ids)` is the one public API that re-requests an
// errored tile, so retry each failure a few times with a widening backoff.
// Country-independent by construction: it keys off whatever source failed, so
// jp / tw / hk / mo all recover the same way.
const TILE_RETRY_DELAYS_MS = [900, 2600, 6500];
const tileRetryState = new Map();

function tileRetryKey(sourceId, canonical) {
  return `${sourceId}\u0000${canonical.z}/${canonical.x}/${canonical.y}`;
}

function retryErroredTile(map, event) {
  const tile = event && event.tile;
  const sourceId = event && event.sourceId;
  if (!tile || !sourceId || !tile.tileID || typeof map.refreshTiles !== "function")
    return;
  // 404 means the tile genuinely does not exist (past the source's coverage);
  // MapLibre already handles that by overzooming a parent. Only transport
  // failures and 5xx are worth re-requesting.
  const status = event.error && event.error.status;
  if (status === 404 || status === 403) return;
  const canonical = tile.tileID.canonical;
  const key = tileRetryKey(sourceId, canonical);
  const attempt = tileRetryState.get(key) || 0;
  if (attempt >= TILE_RETRY_DELAYS_MS.length) return;
  tileRetryState.set(key, attempt + 1);
  setTimeout(() => {
    // refreshTiles only touches tiles the source still holds in view, so a
    // tile the user has since panned away from is a no-op rather than waste.
    try {
      map.refreshTiles(sourceId, [
        { z: canonical.z, x: canonical.x, y: canonical.y },
      ]);
    } catch (error) {
      // Source removed (country switch / style reinstall) — nothing to retry.
    }
  }, TILE_RETRY_DELAYS_MS[attempt]);
}

// The per-tile backoff above covers a blip while the user sits still. The
// other case is a spell of no connectivity: every visible tile burns its three
// attempts, and the squares stay blank even after the network returns. So on a
// genuine environment change — network back, or the tab shown again after a
// sleep that killed its in-flight requests — clear the counters and re-request
// whatever is still errored. Rate-limited so a flapping connection can't turn
// this into a request loop.
const TILE_SWEEP_COOLDOWN_MS = 5000;
let lastTileSweepAt = 0;

function installTileRetryRecovery(map) {
  const sweep = () => {
    if (typeof map.refreshTiles !== "function") return;
    const now = Date.now();
    if (now - lastTileSweepAt < TILE_SWEEP_COOLDOWN_MS) return;
    lastTileSweepAt = now;
    const managers = map.style && map.style.tileManagers;
    if (!managers) return;
    tileRetryState.clear();
    for (const sourceId of Object.keys(managers)) {
      const manager = managers[sourceId];
      if (!manager || typeof manager.getIds !== "function") continue;
      const stale = [];
      for (const id of manager.getIds()) {
        const tile = manager.getTileByID(id);
        if (tile && tile.state === "errored") {
          const c = tile.tileID.canonical;
          stale.push({ z: c.z, x: c.x, y: c.y });
        }
      }
      if (!stale.length) continue;
      try {
        map.refreshTiles(sourceId, stale);
      } catch (error) {
        // Source disappeared between the scan and the refresh — ignore.
      }
    }
  };
  window.addEventListener("online", sweep);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) sweep();
  });
}

async function initMap(mapAssetsReady) {
  // The theme-selected OpenFreeMap style + active complete-line package load in
  // parallel (pre-started at boot, before the /api datasets); either may be
  // null (source unavailable) — the style builder degrades the same way railprint does
  // (plain background / no network overlay). The alternate theme is loaded
  // ONLY to warm RailMap.loadBasemap's cache (instant first theme switch);
  // the style itself stages a single stack that theme switches recolor in
  // place — a second staged stack would collide-out every basemap label.
  const theme = resolveDisplayTheme();
  const alternateTheme = theme === "dark" ? "light" : "dark";
  // `mapAssetsReady` is { primary: Promise<[basemap, network]>, alternate:
  // Promise<basemap|null> } — map creation blocks only on its own theme; the
  // alternate warm rides in parallel and is awaited solely in the fallback
  // below when the initial theme failed.
  const assets = mapAssetsReady || {
    primary: Promise.all([RailMap.loadBasemap(theme), RailMap.loadNetwork()]),
    alternate: RailMap.loadBasemap(alternateTheme).catch(() => null),
  };
  const [basemap, network] = await assets.primary;
  const style = RailMap.buildBaseStyle({
    basemap,
    network,
    theme,
    // Credits the rail source for the country the map boots into; a later
    // switch re-credits it in place (RailMap.switchNetworkCountry).
    country: activeCountry,
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
      onRouteChoices: handleDeckRouteChoices,
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
  // Show the layers control if EITHER theme's basemap loaded: when the
  // initial theme failed but the alternate succeeded, a theme switch can
  // still rescue the basemap, so the control must stay. Short-circuit keeps
  // the await off the path whenever the initial theme is fine.
  buildMapLayersControl(Boolean(basemap || (await assets.alternate)));
  buildMapInfoControl();

  // Online basemap tile failures degrade to the plain background — never fatal.
  map.on("error", (e) => {
    retryErroredTile(map, e);
    const msg = (e && e.error && e.error.message) || "";
    const url = (e && e.error && e.error.url) || "";
    if (url.includes("openfreemap") || msg.includes("openfreemap")) return;
    console.warn("[map]", msg || e);
  });
  installTileRetryRecovery(map);

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
  });

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
  // closeOnClick:false — the blank-tap handler owns dismissal as its FIRST
  // stage (close the popup, change nothing else), so a stray tap can't both
  // close the popup AND pop the selection context in one go.
  const popup = new maplibregl.Popup({ maxWidth: "320px", closeOnClick: false })
    .setLngLat(coordinate)
    .setHTML(html)
    .addTo(map);
  // The X button bypasses closeClickPopup — keep the tracker in sync.
  popup.on("close", () => {
    if (_clickPopup === popup) _clickPopup = null;
  });
  _clickPopup = popup;
}
function closeClickPopup() {
  if (_clickPopup) {
    _clickPopup.remove();
    _clickPopup = null;
  }
}

// Blank-map click (no route lane / station dot under the pointer) steps the
// view BACK one level instead of jumping straight to "全部":
//   0. a stop popup is open     -> close only the popup, keep the selection;
//   1. a train is selected      -> clear the selection, stay on its day
//                                  (the whole day's routes re-appear solid);
//   2. a concrete day, no train -> back to the all-dates view ("全部");
//   3. already "全部", nothing selected -> no-op (idle clicks re-render
//      nothing).
function handleMapBackgroundClick() {
  if (_clickPopup) {
    closeClickPopup();
    return;
  }
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
  // Moving on to a line dismisses a stop popup left open by a marker click
  // (parity with the old closeOnClick behavior).
  closeClickPopup();
  pickTrain(hit.train.id);
}

// Ambiguous coarse-pointer tap over CROSSING route lines. Touch has no hover
// stage to disambiguate, so railmap hands over every distinct train under the
// tap; list them for an explicit choice. Picking one both activates its day
// and selects it — the user already disambiguated, so the two-stage pick
// would only cost an extra tap.
function handleDeckRouteChoices(info) {
  const records = (info && info.records) || [];
  // Same off-date guard as a direct click on each line.
  const candidates = records
    .map((record) => interactiveTrainFromClick({ object: record }))
    .filter(Boolean)
    .map((hit) => hit.train);
  if (!candidates.length) return;
  if (candidates.length === 1 || typeof uiChoose !== "function") {
    closeClickPopup();
    pickTrain(candidates[0].id);
    return;
  }
  closeClickPopup();
  const items = candidates.map((train) => ({
    label: [
      dateLabel(getTrainDate(train)),
      listPrimaryName(train.number || train.id),
      listPrimaryName(trainTypeCompanyLabel(train)),
    ]
      .filter(Boolean)
      .join("・"),
    sublabel: `${listPrimaryName(train.origin || "?")} → ${listPrimaryName(train.destination || "?")}`,
    color: train.style?.color || DEFAULT_TRAIN_COLOR,
  }));
  uiChoose(I18N.t("choose.overlap"), items).then((index) => {
    if (index == null) return;
    const train = candidates[index];
    if (!getTrain(train.id)) return; // deleted while the dialog was open
    selectDateBucket(getTrainDate(train));
    selectTrain(train.id, { fit: focusZoomEnabled });
  });
}
