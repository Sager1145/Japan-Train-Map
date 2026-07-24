// =========================================================================
//  app-display-features.js — §4: display-feature helpers — basemap opacity, endpoint labels, deck hover/tooltip
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §4.  Display-feature helpers (basemap opacity, endpoint labels, deck hover/tooltip)
// =========================================================================

// ------------------------------------------------------------------------
// Helpers backing the new display features: basemap opacity, the
// "only first/last endpoint" toggle, and the hover / selection station-name
// and line-name labels. Kept together so the feature is easy to find.
// ------------------------------------------------------------------------
function applyMapOpacity() {
  if (!map || !window.RailMap) return;
  const v = Math.max(0, Math.min(1, Number(DISPLAY.mapOpacity)));
  // The slider now drives a white fade layer ABOVE the basemap (railprint's
  // positron needs no fading, so the default is fully visible = fade 0).
  RailMap.setFadeOpacity(1 - v);
}

// The very first origin + the very last destination among the given trains.
// Trip order = index in the canonical store (legs are built in travel order).
// The id→index map is built once per call instead of an Array.indexOf per
// train (which made this O(n²) and it runs on every hover change / zoomend).
function computeGlobalEndpoints(trains) {
  if (!trains || !trains.length) return { firstId: null, lastId: null };
  const orderById = new Map();
  trainStore.trains.forEach((t, i) => orderById.set(t.id, i));
  const tripIndex = (t) => {
    const i = orderById.get(t.id);
    return i === undefined ? Number.MAX_SAFE_INTEGER : i;
  };
  let first = trains[0];
  let last = trains[0];
  let fi = tripIndex(first);
  let li = tripIndex(last);
  trains.forEach((t) => {
    const idx = tripIndex(t);
    if (idx < fi) {
      fi = idx;
      first = t;
    }
    if (idx > li) {
      li = idx;
      last = t;
    }
  });
  return { firstId: first.id, lastId: last.id };
}

// Endpoints for the current view scope. With a concrete date selected, use
// that day's first origin + last destination; with "全部", fall back to the
// whole trip's global endpoints.
function computeScopedEndpoints(trains) {
  if (selectedDate !== ALL_DATES) {
    const dayTrains = (trains || []).filter(
      (t) => getTrainDate(t) === selectedDate,
    );
    if (dayTrains.length) return computeGlobalEndpoints(dayTrains);
  }
  return computeGlobalEndpoints(trains);
}

// On-map origin/destination name labels come from two sources: (1) whenever a
// concrete date is selected, that day's very first origin ("起點") and very last
// destination ("終點") are ALWAYS labelled, so picking a date immediately shows
// where the day begins and ends; (2) the hovered train wins, otherwise the
// selected train, keeps its own endpoints labelled. Overlapping labels are
// pushed apart by layoutEndpointLabels() below — most visibly on a round-trip
// day (e.g. 沼津→沼津 / 札幌→札幌) whose start and end sit on the SAME point.
let hoverLabelTrainId = null;

// One reusable canvas 2D context to measure label text width without forcing a
// DOM reflow (used by the overlap-avoidance layout).
let _labelMeasureCtx = null;
function measureLabelTextWidth(text) {
  if (!_labelMeasureCtx) {
    const cnv = document.createElement("canvas");
    _labelMeasureCtx = cnv.getContext("2d");
    _labelMeasureCtx.font =
      "700 11px system-ui, -apple-system, 'Segoe UI', sans-serif";
  }
  return _labelMeasureCtx.measureText(text || "").width;
}

// Build one label descriptor for a train's origin/destination stop, or null when
// the stop can't be resolved. `dayEndpoint` adds a 起點/終點 badge + emphasis.
function buildEndpointLabelSpec(train, kind, opts = {}) {
  const stop = (train.stops || []).find((x) => x.stop_type === kind);
  if (!stop) return null;
  const feature = getStopFeature(stop, train);
  if (!feature) return null;
  const name = I18N.placeName(
    feature.properties.name || stopName(stop),
    stationCode(feature),
  );
  if (!name) return null;
  const latlng = toLatLng(feature);
  const time = kind === "origin" ? stop.departure : stop.arrival;
  const timeTag = I18N.t(kind === "origin" ? "tag.dep" : "tag.arr");
  const badgeText = opts.dayEndpoint
    ? I18N.t(kind === "origin" ? "tag.start" : "tag.end")
    : "";
  const badgeHtml = badgeText
    ? `<span class="station-label-badge">${escapeHtml(badgeText)}</span>`
    : "";
  const timeHtml = time
    ? ` <span class="station-label-time">${escapeHtml(timeTag)} ${escapeHtml(time)}</span>`
    : "";
  const plain =
    (badgeText ? badgeText + " " : "") +
    name +
    (time ? ` ${timeTag} ${time}` : "");
  return {
    latlng,
    tid: train.id,
    html: `${badgeHtml}${escapeHtml(name)}${timeHtml}`,
    key: `${latlng[0].toFixed(5)},${latlng[1].toFixed(5)}|${kind}`,
    dayEndpoint: !!opts.dayEndpoint,
    // Estimated rendered width (px): text + horizontal padding (+ badge chip).
    width: Math.min(300, measureLabelTextWidth(plain) + (badgeText ? 38 : 20)),
  };
}

function updateEndpointLabels() {
  if (!map) return;

  const specs = [];
  const seen = new Set();
  const add = (spec) => {
    if (!spec || seen.has(spec.key)) return;
    seen.add(spec.key);
    specs.push(spec);
  };

  // (1) Selected day's first origin + last destination — always labelled.
  if (selectedDate !== ALL_DATES) {
    const ep = computeScopedEndpoints(trainStore.trains);
    const firstTrain =
      ep.firstId && trainStore.trains.find((t) => t.id === ep.firstId);
    const lastTrain =
      ep.lastId && trainStore.trains.find((t) => t.id === ep.lastId);
    if (firstTrain && firstTrain.visible !== false)
      add(buildEndpointLabelSpec(firstTrain, "origin", { dayEndpoint: true }));
    if (lastTrain && lastTrain.visible !== false)
      add(buildEndpointLabelSpec(lastTrain, "destination", { dayEndpoint: true }));
  }

  // (2) Hovered / selected train's own endpoints.
  const id = hoverLabelTrainId || selectedTrainId;
  if (id) {
    const train = trainStore.trains.find((t) => t.id === id);
    if (train && train.visible !== false) {
      const dateActive = selectedDate !== ALL_DATES;
      // A cross-day train is on-date for both of the days it runs on, so its
      // endpoint labels must not vanish while its line is still drawn.
      const offDate =
        mapFollowsSelectedDate &&
        dateActive &&
        !trainSpansDate(train, selectedDate);
      if (!offDate) {
        add(buildEndpointLabelSpec(train, "origin"));
        add(buildEndpointLabelSpec(train, "destination"));
      }
    }
  }

  const laid = specs.length ? layoutEndpointLabels(specs) : [];
  const nextKeys = new Set(laid.map((s) => s.key));

  // Diff/reuse instead of remove-all/recreate-all: an EXISTING label element
  // survives across updates, so its CSS opacity transition actually fires
  // (hover spotlight dim/undim fades); vanishing labels fade OUT before
  // removal and new ones fade IN from 0.
  endpointLabelMarkers.forEach((entry, key) => {
    if (nextKeys.has(key) || entry.fadeTimer) return;
    entry.el.style.opacity = "0";
    entry.fadeTimer = setTimeout(() => {
      entry.marker.remove();
      endpointLabelMarkers.delete(key);
    }, 420);
  });

  // Non-interactive DOM markers (pointer-events:none) so they never block
  // route/marker picking. MapLibre markers track their lng/lat through
  // pan/zoom automatically; the overlap layout only recomputes on re-render.
  laid.forEach((spec) => {
    // Hover spotlight: while a train is hovered, other trains' endpoint
    // labels fade with the rest of the map (mirrors railmap's HOVER_DIM).
    const target =
      hoverLabelTrainId && spec.tid !== hoverLabelTrainId ? "0.25" : "1";
    // Horizontal viewport clamp: a station near the container edge would
    // center its card half off-screen; shift the marker offset sideways so
    // the whole label stays visible (re-run on zoomend/moveend).
    {
      const pt = map.project([spec.latlng[1], spec.latlng[0]]);
      const half = spec.width / 2;
      const cw = map.getContainer().clientWidth;
      const left = pt.x + spec.offset[0] - half;
      const right = pt.x + spec.offset[0] + half;
      let dx = 0;
      if (left < 4) dx = 4 - left;
      else if (right > cw - 4) dx = cw - 4 - right;
      if (dx) spec.offset = [spec.offset[0] + dx, spec.offset[1]];
    }
    const cls =
      (spec.dayEndpoint
        ? "station-label station-label--endpoint"
        : "station-label") +
      " station-label--" +
      spec.direction;
    const anchor = spec.direction === "top" ? "bottom" : "top";
    let entry = endpointLabelMarkers.get(spec.key);
    if (entry && entry.anchor !== anchor) {
      // Marker anchors are immutable — a top/bottom flip needs a rebuild.
      clearTimeout(entry.fadeTimer);
      entry.marker.remove();
      endpointLabelMarkers.delete(spec.key);
      entry = null;
    }
    if (entry) {
      if (entry.fadeTimer) {
        clearTimeout(entry.fadeTimer);
        entry.fadeTimer = null;
      }
      // Swap only OUR classes. The Marker constructor appended MapLibre's
      // own classes (maplibregl-marker … — they provide position:absolute);
      // overwriting className wiped them and the label fell out of the
      // marker positioning flow, rendering as a full-width bar.
      if (entry.cls !== cls) {
        entry.cls.split(" ").forEach((c) => entry.el.classList.remove(c));
        cls.split(" ").forEach((c) => entry.el.classList.add(c));
        entry.cls = cls;
      }
      if (entry.el.innerHTML !== spec.html) entry.el.innerHTML = spec.html;
      entry.marker
        .setLngLat([spec.latlng[1], spec.latlng[0]])
        .setOffset(spec.offset);
      entry.el.style.opacity = target;
    } else {
      const el = document.createElement("div");
      el.className = cls;
      el.innerHTML = spec.html;
      el.style.opacity = "0";
      const marker = new maplibregl.Marker({
        element: el,
        anchor,
        offset: spec.offset,
      })
        .setLngLat([spec.latlng[1], spec.latlng[0]])
        .addTo(map);
      endpointLabelMarkers.set(spec.key, {
        marker,
        el,
        anchor,
        cls,
        fadeTimer: null,
      });
      // Two frames so the initial opacity:0 is committed before the target
      // value lands — otherwise the transition is skipped.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          el.style.opacity = target;
        }),
      );
    }
  });
}

// Overlap-avoidance for the endpoint labels: each label is placed just above or
// just below its station dot, alternating and stacking outward so labels that
// would collide get pushed apart and all stay readable. Pure pixel-space layout;
// relative distances only change on zoom and the labels are rebuilt on every
// marker render (including the zoomend handler), so no per-pan work is needed.
function layoutEndpointLabels(specs) {
  const BASE = 10; // gap from the dot to the first label
  const H = 20; // estimated label box height (single line)
  const PAD = 4; // gap kept between neighbouring boxes
  const placed = [];
  const hits = (a, b) =>
    a.x1 < b.x2 + PAD && a.x2 > b.x1 - PAD && a.y1 < b.y2 + PAD && a.y2 > b.y1 - PAD;
  specs.forEach((spec) => {
    const p = map
      ? map.project([spec.latlng[1], spec.latlng[0]])
      : { x: 0, y: 0 };
    const halfW = spec.width / 2;
    let picked = null;
    for (let k = 0; k < 8 && !picked; k++) {
      const step = BASE + k * (H + PAD);
      // Try above the dot first, then below, at increasing distance.
      for (const cand of [
        { direction: "top", offY: -step },
        { direction: "bottom", offY: step },
      ]) {
        const y1 =
          cand.direction === "top" ? p.y + cand.offY - H : p.y + cand.offY;
        const y2 =
          cand.direction === "top" ? p.y + cand.offY : p.y + cand.offY + H;
        const box = { x1: p.x - halfW, x2: p.x + halfW, y1, y2 };
        if (!placed.some((q) => hits(box, q))) {
          placed.push(box);
          picked = { direction: cand.direction, offset: [0, cand.offY] };
          break;
        }
      }
    }
    if (!picked)
      picked = { direction: "top", offset: [0, -(BASE + 8 * (H + PAD))] };
    spec.direction = picked.direction;
    spec.offset = picked.offset;
  });
  return specs;
}

// deck.gl hover -> mirror the hovered train into the endpoint labels.
function handleDeckHover(id) {
  hoverLabelTrainId = id || null;
  updateEndpointLabels();
}

// deck.gl floating tooltip: a marker shows just its station name; a route
// segment shows the line name plus its origin -> destination endpoints.
// One skin for every hover surface: the railprint card (.rp-popup design
// tokens \u2014 theme-aware, same as the C5 station popup and the confirm modal).
const DECK_TIP_RAILPRINT = {
  background: "var(--white)",
  color: "var(--ink)",
  fontSize: "var(--font-md)",
  fontWeight: "400",
  padding: "6px 10px",
  border: "var(--hairline)",
  borderRadius: "var(--radius-button)",
  boxShadow: "var(--shadow-lg)",
  maxWidth: "260px",
  whiteSpace: "normal",
};
// The route-segment tip draws its card on an INNER element (.map-line-tip,
// shifted above the cursor), so its container must reset every key the card
// skin sets \u2014 the tooltip element is reused across skins and a leftover
// border/background would draw an empty ghost box.
const DECK_TIP_TRANSPARENT = {
  background: "transparent",
  color: "inherit",
  fontSize: "inherit",
  fontWeight: "inherit",
  padding: "0",
  border: "none",
  borderRadius: "0",
  boxShadow: "none",
  maxWidth: "none",
  whiteSpace: "normal",
};

function deckGetTooltip(info) {
  const o = info && info.object;
  if (!o) return null;
  if (o.category) {
    const pr = (o.feature && o.feature.properties) || {};
    const name = pr.name || "";
    if (!name) return null;
    // Railprint-style station popup (every line through the station), using the
    // same RailNetwork data + processing as the national-network hover popup.
    // Lazily fetch the network package the first time a station is hovered;
    // until it is ready, show the compact name/time card, and clear the
    // tooltip dedup cache on load so it upgrades in place on the next move.
    const railprintHtml = buildStationLinesPopup(pr, o.train);
    if (railprintHtml)
      return {
        html: railprintHtml,
        style: DECK_TIP_RAILPRINT,
        // Pin the card to the station itself (railprint presentation:
        // anchored popup that auto-flips at viewport edges) instead of
        // trailing the cursor; style stays as the fallback for renderers
        // that ignore anchorLngLat.
        anchorLngLat: Array.isArray(o.position) ? o.position : null,
      };
    if (typeof RailMap !== "undefined" && !RailMap._network) {
      RailMap.ensureNetwork().then((net) => {
        if (net) RailMap._tooltipRecord = null;
      });
    }
    const times = [];
    if (pr.arrival) times.push(`${I18N.t("tag.arr")} ${escapeHtml(pr.arrival)}`);
    if (pr.departure) times.push(`${I18N.t("tag.dep")} ${escapeHtml(pr.departure)}`);
    // The stop's date rides along after its times.
    if (times.length && o.train) {
      const d = dateLabel(getTrainDate(o.train));
      if (d) times.push(`<span class="rp-popup-date">${escapeHtml(d)}</span>`);
    }
    const timeHtml = times.length
      ? `<div class="rp-popup-times">${times.join("\u3000")}</div>`
      : "";
    const code = pr.n02_station_code || pr.N02_005c || null;
    return {
      html: `<div class="rp-popup"><div class="rp-popup-head"><span class="rp-popup-ja">${escapeHtml(I18N.placeName(name, code))}</span></div>${timeHtml}</div>`,
      style: DECK_TIP_RAILPRINT,
    };
  }
  const t = o.train;
  if (!t) return null;
  // Branch sections run under their own 車號 (jsonspec §6.1b); the tooltip used
  // to always show the trunk number, so a こまち leg read "はやぶさ…".
  const seg = segmentNumberLabel(t, (o.feature && o.feature.properties) || {});
  const line = seg.number || "";
  const meta = trainTypeCompanyLabel(t);
  const origin = t.origin || "";
  const dest = t.destination || "";
  const oStop = (t.stops || []).find((x) => x.stop_type === "origin");
  const dStop = (t.stops || []).find((x) => x.stop_type === "destination");
  const times = [];
  if (oStop && oStop.departure) times.push(`${I18N.t("tag.dep")} ${escapeHtml(oStop.departure)}`);
  if (dStop && dStop.arrival) times.push(`${I18N.t("tag.arr")} ${escapeHtml(dStop.arrival)}`);
  // The train's running date rides along after its times.
  {
    const d = dateLabel(getTrainDate(t));
    if (d) times.push(`<span class="rp-popup-date">${escapeHtml(d)}</span>`);
  }
  const metaHtml = meta
    ? `<span class="rp-popup-roma">${escapeHtml(meta)}</span>`
    : "";
  const routeHtml = `<div class="rp-popup-route">${escapeHtml(I18N.placeName(origin, oStop && stopStationCode(oStop)))} \u2192 ${escapeHtml(I18N.placeName(dest, dStop && stopStationCode(dStop)))}</div>`;
  const timeHtml = times.length
    ? `<div class="rp-popup-times">${times.join("\u3000")}</div>`
    : "";
  // Hovering an overlapped stretch: show which parallel lane this train is
  // (date order, left/top = earliest) and hint that sliding sideways switches.
  const overlapHtml =
    o.overlapCount > 1
      ? `<div class="rp-popup-times">\u21c6 ${I18N.t("tip.overlap", {
          slot: o.overlapSlot + 1,
          count: o.overlapCount,
        })}</div>`
      : "";
  // The visible box is an INNER element shifted above the cursor via CSS; the
  // OUTER element is positioned by deck.gl through its own transform, so we must
  // NOT set transform on it (doing so wipes deck's positioning and hides the
  // popup entirely — the bug this replaces).
  return {
    html: `<div class="map-line-tip"><div class="rp-popup"><div class="rp-popup-head"><span class="rp-popup-ja">${escapeHtml(I18N.trainName(line))}</span>${metaHtml}</div>${routeHtml}${timeHtml}${overlapHtml}</div></div>`,
    style: DECK_TIP_TRANSPARENT,
  };
}

// GPU route rendering. Train routes, markers, the national rail network and
// the basemap all render in MapLibre GL (see railmap.js — the railprint-style
// map core). The old Leaflet SVG fallback path is gone with Leaflet itself.

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  return m
    ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
    : [217, 54, 79];
}

