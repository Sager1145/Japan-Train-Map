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
    light: { background: "rgb(242,243,240)", fade: "#FFFFFF", casing: "#1A1A1A" },
    dark: { background: "rgb(12,12,12)", fade: "#0C0C0C", casing: "#F5EEE9" },
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
        basemap.theme = theme;
        if (theme === "dark") recolorPositronToDark(basemap);
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
