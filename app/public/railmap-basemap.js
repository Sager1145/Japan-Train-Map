/*
 * railmap-basemap.js — basemap style loading for the RailMap core.
 *
 * Ports railprint's basemap.ts: loads the OpenFreeMap positron (vendored) or
 * dark style JSON, namespaces its sources/layers so the stacks of two themes
 * can coexist during a crossfade, normalizes the style, and probes the remote
 * tile origin so a vendored style is never spliced in while offline.
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
  const BASEMAP_STYLE_URLS = {
    light: "./basemap/positron.json",
    dark: "https://tiles.openfreemap.org/styles/dark",
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
          // imperceptible value keeps both theme tile stacks warm from boot.
          layer.paint[prop] = BASEMAP_STAGE_OPACITY;
        }
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

  function replaceStyleLiteral(value, from, to) {
    if (Array.isArray(value))
      return value.map((item) => replaceStyleLiteral(item, from, to));
    return value === from ? to : value;
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
        // The upstream OpenFreeMap Dark style has two bugs we patch locally:
        //   1. icon-image "circle-11" (its sprite exposes it as "circle_11"),
        //      so city dots go missing.
        //   2. Label text is near-BLACK on its near-black background — place
        //      labels are rgb(101,101,101), water_name is pure black — so the
        //      labels are effectively invisible/illegible (the reported dark-mode
        //      "labels display wrong"). Force legible light text + a dark halo on
        //      every symbol layer that draws text, mirroring the light basemap.
        if (theme === "dark") {
          const DARK_LABEL_COLOR = "rgb(201,201,201)";
          const DARK_LABEL_HALO = "rgba(12,12,12,0.9)";
          basemap.layers = basemap.layers.map((layer) => {
            let next = layer;
            if (layer.layout && layer.layout["icon-image"] != null) {
              next = Object.assign({}, next, {
                layout: Object.assign({}, next.layout, {
                  "icon-image": replaceStyleLiteral(
                    next.layout["icon-image"],
                    "circle-11",
                    "circle_11",
                  ),
                }),
              });
            }
            if (layer.layout && layer.layout["text-field"] != null) {
              next = Object.assign({}, next, {
                paint: Object.assign({}, next.paint, {
                  "text-color": DARK_LABEL_COLOR,
                  "text-halo-color": DARK_LABEL_HALO,
                  "text-halo-width": 1,
                }),
              });
            }
            return next;
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
