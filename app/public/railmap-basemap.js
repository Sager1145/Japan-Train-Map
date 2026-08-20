/*
 * railmap-basemap.js — basemap style loading for the RailMap core.
 *
 * Ports railprint's basemap.ts: loads the vendored OpenFreeMap positron style
 * JSON (BOTH themes — dark is positron recolored to a dark palette, see
 * recolorPositronToDark), namespaces its sources/layers so a freshly staged
 * stack can coexist with the old one during an install crossfade, normalizes
 * the style, and probes the remote tile origin so a vendored style is never
 * spliced in while offline.
 *
 * Publishes the RailMapBasemap global (consumed by railmap-style.js and
 * railmap.js).
 */
(function (global) {
  "use strict";

  const BASEMAP_ATTRIBUTION = "© OpenStreetMap contributors｜OpenFreeMap";

  // ───────────────────────────── basemap loader (basemap.ts) ─────────────────────────────
  const LOAD_TIMEOUT_MS = 8000;
  const BASEMAP_CROSSFADE_MS = 460;
  const BASEMAP_STAGE_OPACITY = 0.001;
  // Both themes load the SAME vendored positron style; dark is positron with
  // its paint literals remapped (recolorPositronToDark). The upstream
  // OpenFreeMap Dark style is a different style family — 13 label layers vs
  // positron's 19, place labels capped at maxzoom 14/15 (city names vanish
  // when zoomed in), no airport/road-name labels, a mismatched sprite ref —
  // so its labels can never match the light theme. Deriving dark from
  // positron keeps every label layer, text field, font and zoom range
  // identical to light mode, and drops the remote style-JSON dependency.
  const BASEMAP_STYLE_URLS = {
    light: "./basemap/positron.json",
    dark: "./basemap/positron.json",
  };
  const BASEMAP_LOAD_CACHE = new Map();
  const MAP_SURFACE_COLORS = {
    // stationRing is the open middle of interchange markers. Ordinary dots
    // now inherit their railway colour, as in Apple Maps Transit.
    light: {
      background: "rgb(242,243,240)",
      fade: "#FFFFFF",
      casing: "#1A1A1A",
      stationRing: "#FFFFFF",
    },
    dark: {
      background: "rgb(12,12,12)",
      fade: "#0C0C0C",
      casing: "#F5EEE9",
      stationRing: "#2C2C2E",
    },
  };
  const LAYER_OPACITY_PROPS = {
    background: ["background-opacity"],
    fill: ["fill-opacity"],
    line: ["line-opacity"],
    circle: ["circle-opacity", "circle-stroke-opacity"],
    symbol: ["icon-opacity", "text-opacity"],
    raster: ["raster-opacity"],
    heatmap: ["heatmap-opacity"],
    "fill-extrusion": ["fill-extrusion-opacity"],
  };

  function opacityPropsForLayer(layer) {
    return (layer && LAYER_OPACITY_PROPS[layer.type]) || [];
  }

  function namespaceBasemap(basemap, namespace, startTransparent) {
    const sourceIds = Object.keys(basemap.sources);
    const sourceIdMap = new Map(
      sourceIds.map((id) => [id, namespace + id]),
    );
    const layerIdMap = new Map(
      basemap.layers.map((layer) => [layer.id, namespace + layer.id]),
    );
    const sources = {};
    sourceIds.forEach((id) => {
      sources[sourceIdMap.get(id)] = Object.assign({}, basemap.sources[id]);
    });
    const opacityTargets = new Map();
    const layers = basemap.layers.map((sourceLayer) => {
      const layer = Object.assign({}, sourceLayer, {
        id: layerIdMap.get(sourceLayer.id),
      });
      if (sourceLayer.source && sourceIdMap.has(sourceLayer.source))
        layer.source = sourceIdMap.get(sourceLayer.source);
      if (sourceLayer.ref && layerIdMap.has(sourceLayer.ref))
        layer.ref = layerIdMap.get(sourceLayer.ref);
      if (sourceLayer.layout)
        layer.layout = Object.assign({}, sourceLayer.layout);
      layer.paint = Object.assign({}, sourceLayer.paint);
      const targets = {};
      opacityPropsForLayer(layer).forEach((prop) => {
        targets[prop] = Object.prototype.hasOwnProperty.call(layer.paint, prop)
          ? layer.paint[prop]
          : 1;
        // Install the normal theme-transition timing with the initial style so
        // an interactive switch only updates opacity targets. Writing a
        // transition object to 100+ layers at click time delays the first frame
        // and makes the menu appear to change before the map.
        layer.paint[prop + "-transition"] = {
          duration: BASEMAP_CROSSFADE_MS,
          delay: 0,
        };
        if (startTransparent) {
          // A literal zero can let MapLibre skip loading a staged source. This
          // imperceptible value keeps the staged stack's tiles warm.
          layer.paint[prop] = BASEMAP_STAGE_OPACITY;
        }
      });
      // Pre-install color transitions the same way: theme switching recolors
      // this one stack in place (both themes are the same positron layers, so
      // a paint crossfade IS the theme crossfade — see railmap.js
      // _recolorBasemapStack), and it must only write color values at click
      // time.
      Object.keys(sourceLayer.paint || {}).forEach((prop) => {
        if (/-color$/.test(prop))
          layer.paint[prop + "-transition"] = {
            duration: BASEMAP_CROSSFADE_MS,
            delay: 0,
          };
      });
      opacityTargets.set(layer.id, targets);
      return layer;
    });
    return { sources, layers, opacityTargets };
  }

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

  // Sea/ocean name labels are removed everywhere, both themes.
  const DETAIL_LAYERS_DROPPED = [
    "water_name_point_label",
    "water_name_line_label",
  ];

  // Remove only basemap layers that explicitly identify a station/platform
  // AREA. Ordinary buildings, railway lines and station labels remain. The
  // vendored positron currently has no such layer, but this exact guard keeps
  // a future style refresh from reintroducing the pale facility polygons that
  // conflict with the project's on-line round station glyphs.
  function isStationFacilityAreaLayer(layer) {
    if (!layer || typeof layer !== "object") return false;
    const id = String(layer.id || "").toLowerCase();
    const sourceLayer = String(layer["source-layer"] || "").toLowerCase();
    const filter = JSON.stringify(layer.filter || []).toLowerCase();
    const identity = `${id} ${sourceLayer} ${filter}`;
    const identifiesStation = /(^|[^a-z])(station|platform|transit[_ -]?facility)([^a-z]|$)/.test(
      identity,
    );
    if (!identifiesStation) return false;
    if (layer.type === "fill" || layer.type === "fill-extrusion") return true;
    // A polygon outline is a line layer, but require its own id to identify
    // the station/facility so a generic transportation line filtered as
    // `class=transit` can never be mistaken for an area outline.
    return (
      layer.type === "line" &&
      /(station|platform|transit[_ -]?facility)/.test(id)
    );
  }

  // OpenFreeMap's z4 boundary tile encodes the Korean Demilitarized Zone as
  // three parallel admin_level=2 components inside one MultiLineString.  At
  // z3 and z5+ the same source is already a single country border, so repair
  // only the one overzoom interval that can display the triplicate geometry.
  // A theme-colored casing erases the three source lines, then the centerline
  // is redrawn with the native boundary_2 treatment.  The source feature has
  // no property that distinguishes its three components, so a style filter
  // cannot remove the two extras directly.
  const KOREA_BOUNDARY_FIX_SOURCE_ID = "korea-boundary-z4-fix";
  const KOREA_BOUNDARY_FIX_CASING_LAYER_ID =
    "korea_boundary_z4_fix_casing";
  const KOREA_BOUNDARY_FIX_LINE_LAYER_ID = "korea_boundary_z4_fix_line";
  const KOREA_BOUNDARY_CENTERLINE = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [
        [126.6668701171875, 37.82714141683739],
        [126.6668701171875, 37.93553306183642],
        [126.7218017578125, 37.95286091815649],
        [126.76025390625, 37.978845040497134],
        [126.84814453125, 38.08268954483802],
        [126.9195556640625, 38.1345565770541],
        [126.9744873046875, 38.2209197668312],
        [127.08984375, 38.28562496668374],
        [127.15576171875, 38.30718056188314],
        [127.37548828125, 38.320110845015364],
        [127.474365234375, 38.2942479732053],
        [127.7545166015625, 38.324420427006544],
        [127.7984619140625, 38.2942479732053],
        [128.0401611328125, 38.302869955150044],
        [128.1719970703125, 38.354580326598324],
        [128.2269287109375, 38.39764411353178],
        [128.2818603515625, 38.48369476951686],
        [128.2818603515625, 38.582526159353336],
        [128.3642578125, 38.62545397209084],
      ],
    },
  };

  function koreaBoundaryFixLayers() {
    const zoomRange = { minzoom: 4, maxzoom: 5 };
    const layout = { "line-cap": "round", "line-join": "round" };
    return [
      Object.assign(
        {
          id: KOREA_BOUNDARY_FIX_CASING_LAYER_ID,
          type: "line",
          source: KOREA_BOUNDARY_FIX_SOURCE_ID,
          layout,
          paint: {
            // Exact positron background literal: dark-theme recoloring maps
            // this to rgb(12,12,12), matching the regional detail mask.
            "line-color": "rgb(242,243,240)",
            // z4 tiles overzoom until z5.  Grow with that overzoom so the
            // casing continues to cover both outer source lines.
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              4,
              8,
              5,
              15,
            ],
          },
        },
        zoomRange,
      ),
      Object.assign(
        {
          id: KOREA_BOUNDARY_FIX_LINE_LAYER_ID,
          type: "line",
          source: KOREA_BOUNDARY_FIX_SOURCE_ID,
          layout,
          paint: {
            "line-color": "hsl(0,0%,70%)",
            "line-opacity": [
              "interpolate",
              ["linear"],
              ["zoom"],
              0,
              0.4,
              4,
              1,
            ],
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              3,
              1,
              5,
              1.2,
              12,
              3,
            ],
          },
        },
        zoomRange,
      ),
    ];
  }

  // Layer policy applied to the vendored positron style before it is staged.
  // The basemap is the WORLDWIDE style: every country keeps its roads, urban
  // areas, buildings, administrative lines and captions.
  //
  // A regional gate used to live here — a ["within", <Japan/Taiwan/HK/Macao
  // outline>] filter on every line and symbol layer, plus a world-sized fill
  // mask that buried foreign polygon detail, plus a per-country label gate.
  // It was removed on 2026-08-11: MapLibre evaluates "within" per FEATURE and
  // OpenMapTiles merges same-class lines into a few huge MultiLineStrings at
  // low zoom, so one vertex outside the outline dropped an entire tile's worth
  // of roads/railways/admin lines. Any tile holding both Japan and a neighbour
  // — everything west of 135°E, i.e. the 129–135°E column — lost 40–88% of its
  // line work at z4–z6 and only recovered around z7, which is the "half the
  // country has no detail until you zoom right in" bug. Point labels survived
  // ("within" is per-point), which is why place names stayed while lines went.
  function applyBasemapLayerPolicy(basemap) {
    const dropped = new Set(DETAIL_LAYERS_DROPPED);
    basemap.layers = basemap.layers.filter(
      (layer) => !dropped.has(layer.id) && !isStationFacilityAreaLayer(layer),
    );
    const hasCountryBorders = basemap.layers.some(
      (layer) => layer.id === "boundary_2",
    );
    if (hasCountryBorders) {
      basemap.sources = Object.assign({}, basemap.sources);
      basemap.sources[KOREA_BOUNDARY_FIX_SOURCE_ID] = {
        type: "geojson",
        data: KOREA_BOUNDARY_CENTERLINE,
      };
      const boundaryEnd = Math.max(
        basemap.layers.findIndex((layer) => layer.id === "boundary_2"),
        basemap.layers.findIndex((layer) => layer.id === "boundary_disputed"),
      );
      basemap.layers = basemap.layers.slice();
      basemap.layers.splice(boundaryEnd + 1, 0, ...koreaBoundaryFixLayers());
    }
    return basemap;
  }

  // ─────────────────── positron → dark recolor (label parity) ───────────────────
  // The dark basemap is the vendored positron style with every color literal
  // remapped to a dark palette anchored on MAP_SURFACE_COLORS.dark.background.
  // Tables are keyed by the EXACT literal spellings in basemap/positron.json
  // (both "rgb(a, b, c)" and "rgb(a,b,c)" spellings occur there).
  // Surface hierarchy preserved from light mode: bg < casing < minor < inner.
  const DARK_SURFACE_COLORS = {
    "rgb(242,243,240)": "rgb(12,12,12)", // background / piers
    "rgb(230, 233, 229)": "rgb(22,25,22)", // park
    "rgb(194, 200, 202)": "rgb(33,39,45)", // water
    "hsl(0,0%,98%)": "hsl(0,0%,11%)", // ice shelf / glacier
    "rgb(234, 234, 230)": "rgb(19,19,19)", // residential
    "rgb(220,224,220)": "rgb(18,22,18)", // wood
    "hsl(195,17%,78%)": "hsl(195,14%,26%)", // waterway lines
    "rgb(234, 234, 229)": "rgb(25,25,25)", // building fill
    "rgb(219, 219, 218)": "rgb(34,34,34)", // building outline
    "rgb(213, 213, 213)": "rgb(29,29,29)", // motorway / major road casing
    "rgb(234,234,234)": "rgb(30,30,30)", // tunnel motorway inner
    "hsl(0,0%,88%)": "hsl(0,0%,13%)", // minor roads / taxiway / runway casing
    "rgba(255, 255, 255, 1)": "rgba(36,36,36,1)", // aeroway area / runway
    "rgb(234, 234, 234)": "rgb(28,28,28)", // footpaths
    "#fff": "rgb(40,40,40)", // major / motorway road inner
    "hsla(0,0%,85%,0.69)": "hsla(0,0%,14%,0.69)", // subtle major roads
    "hsla(0,0%,85%,0.53)": "hsla(0,0%,14%,0.53)", // subtle motorways
    "#dddddd": "rgb(35,35,35)", // railway lines
    "#fafafa": "rgb(18,18,18)", // railway dashline
    "hsl(0,0%,70%)": "hsl(0,0%,38%)", // admin boundaries
  };
  const DARK_TEXT_COLORS = {
    "#000": "rgb(230,230,230)", // city / town / village / country labels
    "#333": "rgb(200,200,200)", // other places / state labels
    "#666": "rgb(158,158,158)", // road name / airport labels
    "#495e91": "#8ca2d6", // water name labels
    // Mid-grays legible on both themes — mapped to themselves so the
    // unmapped-literal warning below stays exact.
    "hsl(30,0%,62%)": "hsl(30,0%,62%)", // footpath name labels
    "hsl(0,0%,66%)": "hsl(0,0%,66%)", // waterway line labels
  };
  const DARK_TEXT_HALO_COLORS = {
    "#fff": "rgba(12,12,12,0.92)",
    "#ffffff": "rgba(12,12,12,0.92)",
    "#f8f4f0": "rgba(12,12,12,0.92)",
    "rgba(255,255,255,0.7)": "rgba(12,12,12,0.7)",
  };
  // The shared OFM sprite draws city dots as a black circle; swap in its
  // light variant (the one the upstream dark style targets) on dark.
  const DARK_ICON_IMAGES = {
    circle_11_black: "circle_11",
  };
  const COLOR_LITERAL_RE = /^(#|rgba?\(|hsla?\()/i;

  function mapStyleLiterals(value, table, unmapped) {
    if (Array.isArray(value))
      return value.map((item) => mapStyleLiterals(item, table, unmapped));
    if (typeof value !== "string") return value;
    if (Object.prototype.hasOwnProperty.call(table, value)) return table[value];
    if (unmapped && COLOR_LITERAL_RE.test(value)) unmapped.add(value);
    return value;
  }

  function recolorPositronToDark(basemap) {
    const unmapped = new Set();
    basemap.layers = basemap.layers.map((layer) => {
      let next = layer;
      if (layer.paint) {
        const paint = {};
        for (const prop of Object.keys(layer.paint)) {
          let table = null;
          if (prop === "text-color") table = DARK_TEXT_COLORS;
          else if (prop === "text-halo-color") table = DARK_TEXT_HALO_COLORS;
          else if (/-color$/.test(prop)) table = DARK_SURFACE_COLORS;
          paint[prop] = table
            ? mapStyleLiterals(layer.paint[prop], table, unmapped)
            : layer.paint[prop];
        }
        next = Object.assign({}, next, { paint });
      }
      if (layer.layout && layer.layout["icon-image"] != null) {
        next = Object.assign({}, next, {
          layout: Object.assign({}, next.layout, {
            "icon-image": mapStyleLiterals(
              next.layout["icon-image"],
              DARK_ICON_IMAGES,
              null,
            ),
          }),
        });
      }
      return next;
    });
    // A regenerated positron.json can change literal spellings; a miss keeps
    // that property in its light color, so make it visible instead of silent.
    if (unmapped.size)
      console.warn(
        "[basemap] dark recolor: unmapped color literals kept as-is:",
        Array.from(unmapped).join(", "),
      );
    return basemap;
  }

  function loadBasemap(theme, force) {
    // Backward compatibility with the former loadBasemap(force) signature.
    if (typeof theme === "boolean") {
      force = theme;
      theme = "light";
    }
    theme = theme === "dark" ? "dark" : "light";
    if (!force && BASEMAP_LOAD_CACHE.has(theme))
      return BASEMAP_LOAD_CACHE.get(theme);
    const pending = loadBasemapUncached(theme, force);
    if (!force) {
      BASEMAP_LOAD_CACHE.set(theme, pending);
      pending.then((result) => {
        if (!result && BASEMAP_LOAD_CACHE.get(theme) === pending)
          BASEMAP_LOAD_CACHE.delete(theme);
      });
    }
    return pending;
  }

  async function loadBasemapUncached(theme, force) {
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
        applyBasemapLayerPolicy(basemap);
        basemap.theme = theme;
        if (theme === "dark") recolorPositronToDark(basemap);
      }
      return basemap;
    } catch {
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
    } catch {
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  global.RailMapBasemap = {
    loadBasemap,
    probeBasemapOrigin,
    namespaceBasemap,
    opacityPropsForLayer,
    MAP_SURFACE_COLORS,
    BASEMAP_CROSSFADE_MS,
    BASEMAP_STAGE_OPACITY,
  };
})(window);
