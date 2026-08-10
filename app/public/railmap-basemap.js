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
    // stationDot/stationRing recolor the rn-stations-dot circles per theme
    // (dark values track the CSS dark tokens --rail-dim / --white).
    light: {
      background: "rgb(242,243,240)",
      fade: "#FFFFFF",
      casing: "#1A1A1A",
      stationDot: "#D7DEDA",
      stationRing: "#FFFFFF",
    },
    dark: {
      background: "rgb(12,12,12)",
      fade: "#0C0C0C",
      casing: "#F5EEE9",
      stationDot: "#48484A",
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

  // ─────── regional detail: full basemap in Japan, Taiwan, Hong Kong + Macao ───────
  // Outside these regional outlines the basemap reduces to
  // physical reference — ocean/coastlines, rivers and country borders; no
  // roads, urban areas, buildings, or state borders, and no place labels.
  // OpenMapTiles features carry no country attribute, so the gate is
  // geometric. Outline edges are tight where a neighbor is close
  // (Tsushima–Busan gap, Sōya–Sakhalin gap, Nemuro strait, Taiwan strait) and
  // generous over open ocean. Kinmen / Matsu sit on the Chinese coast and are
  // excluded — they cannot be kept without also keeping mainland cities.
  // One outline polygon per switchable country. The combined MultiPolygon
  // still drives the physical-detail gate and the fill mask; label (symbol)
  // layers are gated to the ACTIVE country plus the two always-visible SARs
  // (see the label gate below).
  const COUNTRY_DETAIL_OUTLINES = {
    jp: [
      [
        [122.4, 24.0], // south of Yonaguni
        [143.5, 26.3], // open Pacific, keeps Ogasawara
        [147.0, 41.5], // Pacific side of Honshu / Hokkaido
        [146.0, 43.4], // east of Cape Nosappu, west of Habomai / Shikotan
        [145.45, 44.35], // Nemuro strait, west of Kunashir
        [144.2, 45.2], // Sea of Okhotsk
        [142.3, 45.7], // between Cape Sōya and Sakhalin
        [140.0, 45.7],
        [139.2, 43.5], // west of Okushiri
        [137.0, 42.0], // mid Sea of Japan, east of Primorye
        [135.0, 39.5],
        [133.5, 38.0], // east of Ulleungdo / Dokdo, keeps Oki
        [131.5, 36.5],
        [129.3, 34.9], // Tsushima–Busan gap
        [128.9, 34.2],
        [128.2, 33.2], // west of Gotō, east of Jeju
        [128.0, 32.0],
        [127.2, 28.8], // East China Sea, west of Okinawa
        [125.3, 26.2],
        [122.4, 24.6], // west of Yonaguni, east of Taiwan
        [122.4, 24.0],
      ],
    ],
    tw: [
      [
        [119.0, 21.8], // southwest of Penghu
        [122.3, 21.7], // keeps Lanyu, north of Batanes
        [122.35, 25.45],
        [121.7, 25.7], // north of Keelung
        [119.7, 24.9], // Taiwan strait, keeps Penghu, south of Pingtan
        [119.0, 21.8],
      ],
    ],
  };

  // Hong Kong and Macao are reference regions in the Japan/Taiwan modes. These
  // simplified 1:10m Natural Earth map-unit outlines (public domain) retain
  // the major islands and land border; broader Pearl River context for the
  // dedicated HK/MO modes is defined separately below.
  const REFERENCE_DETAIL_POLYGONS = {
    hk: [
      [
        [
          [114.11744, 22.22187],
          [114.13282, 22.21613],
          [114.12574, 22.20523],
          [114.15463, 22.2036],
          [114.13909, 22.19111],
          [114.14536, 22.1787],
          [114.11085, 22.17707],
          [114.1067, 22.23579],
          [114.11744, 22.22187],
        ],
      ],
      [
        [
          [114.21559, 22.28563],
          [114.25148, 22.25906],
          [114.24529, 22.24189],
          [114.25611, 22.2036],
          [114.23276, 22.21149],
          [114.22267, 22.23884],
          [114.21176, 22.21613],
          [114.21949, 22.19188],
          [114.20769, 22.18956],
          [114.20932, 22.20755],
          [114.19142, 22.20995],
          [114.18385, 22.24103],
          [114.16489, 22.22785],
          [114.11256, 22.27151],
          [114.13909, 22.28872],
          [114.1657, 22.27936],
          [114.19679, 22.29186],
          [114.21559, 22.28563],
        ],
      ],
      [
        [
          [114.05177, 22.32852],
          [114.05022, 22.31993],
          [114.03142, 22.32457],
          [114.02963, 22.30899],
          [114.01271, 22.31135],
          [114.01271, 22.29808],
          [114.02215, 22.30191],
          [114.01889, 22.26459],
          [113.99537, 22.26777],
          [114.00725, 22.2521],
          [113.99244, 22.2412],
          [114.01498, 22.22708],
          [114.00017, 22.21613],
          [113.98194, 22.20824],
          [113.98064, 22.23725],
          [113.94565, 22.23725],
          [113.92148, 22.22399],
          [113.9284, 22.21076],
          [113.91912, 22.20502],
          [113.90626, 22.20401],
          [113.89251, 22.2224],
          [113.84645, 22.19709],
          [113.8392, 22.2049],
          [113.8392, 22.2342],
          [113.85678, 22.246],
          [113.8506, 22.25678],
          [113.89251, 22.29271],
          [113.9284, 22.28486],
          [113.97674, 22.29808],
          [114.04379, 22.34577],
          [114.05177, 22.32852],
        ],
      ],
      [
        [
          [114.17322, 22.56395],
          [114.23471, 22.55618],
          [114.20932, 22.52371],
          [114.25457, 22.55097],
          [114.25327, 22.53946],
          [114.27801, 22.52985],
          [114.27768, 22.51166],
          [114.28924, 22.50519],
          [114.33513, 22.50642],
          [114.25375, 22.45177],
          [114.21176, 22.47057],
          [114.21713, 22.44794],
          [114.20224, 22.45808],
          [114.16749, 22.44807],
          [114.21176, 22.4206],
          [114.20932, 22.39867],
          [114.23821, 22.43537],
          [114.26718, 22.43073],
          [114.27255, 22.40965],
          [114.28899, 22.42601],
          [114.27646, 22.444],
          [114.32374, 22.48005],
          [114.34759, 22.42292],
          [114.35987, 22.46117],
          [114.37021, 22.44001],
          [114.39975, 22.43614],
          [114.4013, 22.41275],
          [114.38177, 22.41905],
          [114.37021, 22.39798],
          [114.38974, 22.36595],
          [114.37639, 22.37063],
          [114.3576, 22.33242],
          [114.31861, 22.38939],
          [114.30006, 22.38158],
          [114.27801, 22.39098],
          [114.26873, 22.37844],
          [114.27646, 22.34805],
          [114.26637, 22.36595],
          [114.25839, 22.36209],
          [114.27255, 22.32071],
          [114.31162, 22.29731],
          [114.28899, 22.28718],
          [114.28956, 22.27391],
          [114.30315, 22.26919],
          [114.29672, 22.25829],
          [114.27833, 22.27045],
          [114.25554, 22.32233],
          [114.25302, 22.29576],
          [114.23894, 22.28168],
          [114.19549, 22.31826],
          [114.19142, 22.2989],
          [114.17189, 22.28872],
          [114.15952, 22.32225],
          [114.12355, 22.33714],
          [114.10483, 22.36986],
          [114.02052, 22.35037],
          [113.98268, 22.36677],
          [113.97063, 22.38707],
          [113.96437, 22.38068],
          [113.97462, 22.37206],
          [113.94483, 22.36209],
          [113.9144, 22.37613],
          [113.9183, 22.38784],
          [113.89698, 22.40876],
          [113.94101, 22.42678],
          [113.99863, 22.48855],
          [114.01271, 22.48611],
          [114.01116, 22.47289],
          [114.02988, 22.47826],
          [114.03061, 22.49551],
          [114.08237, 22.52936],
          [114.14872, 22.53811],
          [114.17322, 22.56395],
        ],
      ],
    ],
    mo: [
      [
        [
          [113.5586, 22.16303],
          [113.57407, 22.16075],
          [113.56023, 22.14155],
          [113.57797, 22.13963],
          [113.58749, 22.12486],
          [113.56674, 22.12336],
          [113.56634, 22.10769],
          [113.5468, 22.10537],
          [113.53224, 22.15261],
          [113.5586, 22.16303],
        ],
      ],
      [
        [
          [113.5538, 22.21149],
          [113.55152, 22.18956],
          [113.52475, 22.17373],
          [113.52019, 22.18488],
          [113.53525, 22.20755],
          [113.52434, 22.21255],
          [113.53891, 22.22077],
          [113.5538, 22.21149],
        ],
      ],
    ],
  };
  const REFERENCE_DETAIL_AREA_COORDINATES = REFERENCE_DETAIL_POLYGONS.hk.concat(
    REFERENCE_DETAIL_POLYGONS.mo,
  );
  // A switched-to SAR needs geographic CONTEXT, not a hard clip at its land
  // boundary.  The normal Hong Kong viewport includes Shenzhen across the
  // land border; the Macao viewport includes Zhuhai, Hengqin and the western
  // Pearl River shore.  Keep full roads/buildings/land-use inside these
  // compact context windows while still masking the rest of mainland China.
  // Japan/Taiwan label views continue to use the exact SAR polygons above, so
  // this broader context does not introduce Shenzhen/Zhuhai captions there.
  const ACTIVE_REGION_CONTEXT_POLYGONS = {
    hk: [
      [
        [113.72, 22.04],
        [114.62, 22.04],
        [114.62, 22.75],
        [113.72, 22.75],
        [113.72, 22.04],
      ],
    ],
    mo: [
      [
        [113.25, 21.94],
        [113.92, 21.94],
        [113.92, 22.5],
        [113.25, 22.5],
        [113.25, 21.94],
      ],
    ],
  };
  const ACTIVE_CONTEXT_AREA_COORDINATES = [
    ACTIVE_REGION_CONTEXT_POLYGONS.hk,
    ACTIVE_REGION_CONTEXT_POLYGONS.mo,
  ];
  const DETAIL_AREA = {
    type: "MultiPolygon",
    coordinates: [
      COUNTRY_DETAIL_OUTLINES.jp,
      COUNTRY_DETAIL_OUTLINES.tw,
    ].concat(ACTIVE_CONTEXT_AREA_COORDINATES),
  };

  // ───────────── per-country label gate (basemap captions the active country) ─────────────
  // Place / road / water / airport captions appear for the active country plus
  // Hong Kong and Macao: in Taiwan mode Yaeyama labels vanish, and in Japan
  // mode Taiwan's do, while both SARs remain available in either mode. The
  // loaded style is cached per theme and shared across country switches, so
  // the baked filter stays the country-neutral combined gate; each symbol
  // layer instead records its pre-gate filter under this metadata key, and
  // labelGateFilterForCountry() recomputes the per-country filter wherever the
  // stack is (re)built, (re)installed, or the country flips.
  const LABEL_BASE_FILTER_KEY = "railmap:labelBaseFilter";

  function countryLabelArea(country) {
    if (ACTIVE_REGION_CONTEXT_POLYGONS[country]) {
      return {
        type: "MultiPolygon",
        coordinates: [ACTIVE_REGION_CONTEXT_POLYGONS[country]],
      };
    }
    const outline = COUNTRY_DETAIL_OUTLINES[country];
    return outline
      ? {
          type: "MultiPolygon",
          coordinates: [outline].concat(REFERENCE_DETAIL_AREA_COORDINATES),
        }
      : DETAIL_AREA;
  }

  // The ["within", …] filter a label-gated basemap layer should carry for
  // `country` ("jp"/"tw"; anything else falls back to the combined area), or
  // undefined for layers without the label gate. Accepts both raw style-JSON
  // layers and live StyleLayer instances (both expose .metadata).
  function labelGateFilterForCountry(layer, country) {
    const meta = layer && layer.metadata;
    if (!meta || !Object.prototype.hasOwnProperty.call(meta, LABEL_BASE_FILTER_KEY))
      return undefined;
    const base = meta[LABEL_BASE_FILTER_KEY];
    const within = ["within", countryLabelArea(country)];
    return base ? ["all", base, within] : within;
  }

  // Sea/ocean name labels are removed everywhere, both themes.
  const DETAIL_LAYERS_DROPPED = [
    "water_name_point_label",
    "water_name_line_label",
  ];
  // Layers that keep rendering worldwide, above the detail mask.
  const DETAIL_LAYERS_WORLDWIDE = [
    "water", // ocean + lakes: coastlines everywhere
    "waterway", // rivers everywhere
    "boundary_2", // country borders
    "boundary_disputed",
    // Pier polygons draw OVER the water fill, so they cannot go under the
    // mask; "within" cannot gate polygons, so foreign piers leak (high zoom
    // only, near-invisible).
    "road_area_pier",
  ];
  const DETAIL_MASK_SOURCE_ID = "jp-tw-detail-mask";
  const DETAIL_MASK_LAYER_ID = "jp_tw_detail_mask";

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

  // Line and symbol layers are gated per feature with ["within", …] (the
  // expression supports points/lines only). Polygon detail — landuse, wood,
  // parks, buildings, airport areas — cannot be feature-gated, so those fill
  // layers are moved below an opaque background-colored world mask with
  // allowed detail regions cut out as holes. Water, rivers and borders draw
  // above the mask; roads stay above water so bridge ordering is intact.
  function applyRegionalDetailPolicy(basemap) {
    const dropped = new Set(DETAIL_LAYERS_DROPPED);
    const worldwide = new Set(DETAIL_LAYERS_WORLDWIDE);
    const hasCountryBorders = basemap.layers.some(
      (layer) => layer.id === "boundary_2",
    );
    const head = []; // background + polygon detail, buried by the mask outside
    const tail = []; // water, rivers, borders + within-gated line/symbol detail
    basemap.layers.forEach((layer) => {
      if (dropped.has(layer.id)) return;
      const isFill = layer.type === "fill" || layer.type === "fill-extrusion";
      const isBackground = layer.type === "background";
      let next = layer;
      if (!worldwide.has(layer.id) && !isFill && !isBackground) {
        const within = ["within", DETAIL_AREA];
        next = Object.assign({}, layer, {
          filter: layer.filter ? ["all", layer.filter, within] : within,
        });
        // Symbol layers are the label layers: mark them for the per-country
        // label gate, remembering the pre-gate filter (null = none).
        if (layer.type === "symbol") {
          const labelMeta = {};
          labelMeta[LABEL_BASE_FILTER_KEY] = layer.filter || null;
          next.metadata = Object.assign({}, layer.metadata, labelMeta);
        }
      }
      if (isBackground || (isFill && !worldwide.has(layer.id))) head.push(next);
      else tail.push(next);
    });
    basemap.sources = Object.assign({}, basemap.sources);
    basemap.sources[DETAIL_MASK_SOURCE_ID] = {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-180, -85],
              [180, -85],
              [180, 85],
              [-180, 85],
              [-180, -85],
            ],
          ].concat(
            // Exterior rings of every allowed detail polygon become holes
            // (reversed to clockwise winding).
            DETAIL_AREA.coordinates.map((poly) => poly[0].slice().reverse()),
          ),
        },
      },
    };
    if (hasCountryBorders) {
      basemap.sources[KOREA_BOUNDARY_FIX_SOURCE_ID] = {
        type: "geojson",
        data: KOREA_BOUNDARY_CENTERLINE,
      };
      const boundaryEnd = Math.max(
        tail.findIndex((layer) => layer.id === "boundary_2"),
        tail.findIndex((layer) => layer.id === "boundary_disputed"),
      );
      tail.splice(boundaryEnd + 1, 0, ...koreaBoundaryFixLayers());
    }
    basemap.layers = head.concat(
      [
        {
          id: DETAIL_MASK_LAYER_ID,
          type: "fill",
          source: DETAIL_MASK_SOURCE_ID,
          paint: {
            // The exact positron background literal, so the dark recolor
            // tables and the runtime theme switch restyle the mask for free.
            "fill-color": "rgb(242,243,240)",
            "fill-antialias": false,
          },
        },
      ],
      tail,
    );
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
        applyRegionalDetailPolicy(basemap);
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
    labelGateFilterForCountry,
    MAP_SURFACE_COLORS,
    BASEMAP_CROSSFADE_MS,
    BASEMAP_STAGE_OPACITY,
  };
})(window);
