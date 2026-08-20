"use strict";

/*
 * Every drawn railway keeps its operator's colour AND stays separable from the
 * map under it — in both themes, in all five countries.
 *
 * The surfaces are not copied here: they are read out of the vendored positron
 * style and out of railmap-basemap.js's own dark remap, so a basemap change
 * that darkens the water or lightens a landuse fill fails this test instead of
 * silently swallowing a line.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];
const FORBIDDEN = new Set(["#000000", "#ffffff"]);
// The line has to read as ITS OWN colour against the page, and merely as a
// different tone against every fill the basemap paints under it. 3:1 is the
// WCAG non-text minimum; 1.5:1 is the point where two same-hue tones stop
// reading as one shape at hairline width.
const MIN_BACKGROUND_CONTRAST = 3;
const MIN_SURFACE_CONTRAST = 1.5;
// Fills, not strokes: a railway is drawn over these. The basemap's own thin
// lines (roads, waterways, boundaries, its greyed-out railway layer) sit under
// the network's surface-coloured keyline casing, which separates them already.
const SURFACE_LAYERS = [
  "background",
  "park",
  "water",
  "landuse_residential",
  "landcover_wood",
  "landcover_ice_shelf",
  "building",
];

function parseColor(value) {
  const text = String(value).trim();
  let match = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (match) {
    const digits =
      match[1].length <= 4
        ? match[1]
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : match[1];
    return [0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16));
  }
  match = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (match)
    return match[1]
      .split(",")
      .slice(0, 3)
      .map((part) => Math.round(parseFloat(part)));
  match = /^hsla?\(([^)]+)\)$/i.exec(text);
  assert.ok(match, `unparsed colour literal: ${text}`);
  const parts = match[1].split(",");
  const hue = parseFloat(parts[0]) / 360;
  const saturation = parseFloat(parts[1]) / 100;
  const lightness = parseFloat(parts[2]) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue * 6) % 2) - 1));
  const base = lightness - chroma / 2;
  const sector = Math.floor(hue * 6) % 6;
  const rgb = [
    [chroma, secondary, 0],
    [secondary, chroma, 0],
    [0, chroma, secondary],
    [0, secondary, chroma],
    [secondary, 0, chroma],
    [chroma, 0, secondary],
  ][sector];
  return rgb.map((channel) => Math.round((channel + base) * 255));
}

function relativeLuminance(value) {
  const channels = parseColor(value)
    .map((channel) => channel / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(left, right) {
  const values = [relativeLuminance(left), relativeLuminance(right)].sort(
    (a, b) => b - a,
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function hsl(value) {
  const [red, green, blue] = parseColor(value).map((channel) => channel / 255);
  const high = Math.max(red, green, blue);
  const low = Math.min(red, green, blue);
  const lightness = (high + low) / 2;
  if (high === low) return { hue: 0, saturation: 0, lightness };
  const delta = high - low;
  const saturation =
    lightness > 0.5 ? delta / (2 - high - low) : delta / (high + low);
  let hue;
  if (high === red) hue = ((green - blue) / delta) % 6;
  else if (high === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue = (hue / 6 + 1) % 1;
  return { hue, saturation, lightness };
}

/** The real basemap for a theme, straight through railmap-basemap.js. */
async function basemapFor(theme) {
  const positron = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../public/basemap/positron.json"), "utf8"),
  );
  const win = { console, setTimeout, clearTimeout };
  win.window = win;
  win.fetch = async () => ({
    ok: true,
    json: async () => JSON.parse(JSON.stringify(positron)),
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../public/railmap-basemap.js"), "utf8"),
    vm.createContext(win),
    { filename: "railmap-basemap.js" },
  );
  return {
    basemap: await win.RailMapBasemap.loadBasemap(theme),
    surfaceColors: JSON.parse(
      JSON.stringify(win.RailMapBasemap.MAP_SURFACE_COLORS[theme]),
    ),
  };
}

function surfaceColours(basemap) {
  const byId = new Map(basemap.layers.map((layer) => [layer.id, layer]));
  const colours = new Map();
  for (const id of SURFACE_LAYERS) {
    const layer = byId.get(id);
    assert.ok(layer, `basemap lost its ${id} layer`);
    const paint = layer.paint || {};
    const value = paint["background-color"] ?? paint["fill-color"];
    if (typeof value === "string") colours.set(id, value);
  }
  assert.ok(
    colours.size >= SURFACE_LAYERS.length - 1,
    `expected literal fills for the basemap surfaces, got ${colours.size}`,
  );
  return colours;
}

function packageFor(country) {
  return JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../public/rail", `${country}-2025.json`),
      "utf8",
    ),
  );
}

test("no drawn railway is black, white, or lost in the basemap", async () => {
  const themes = {
    light: await basemapFor("light"),
    dark: await basemapFor("dark"),
  };
  for (const country of COUNTRIES) {
    const pkg = packageFor(country);
    for (const theme of ["light", "dark"]) {
      const { surfaceColors } = themes[theme];
      const surfaces = surfaceColours(themes[theme].basemap);
      for (const line of pkg.lines) {
        const value = theme === "dark" ? line.colorDark || line.color : line.color;
        assert.match(value, /^#[0-9a-f]{6}$/, `${line.id} ${theme}`);
        assert.ok(!FORBIDDEN.has(value), `${line.id} ${theme} is black/white`);
        assert.ok(
          contrast(value, surfaceColors.background) >= MIN_BACKGROUND_CONTRAST,
          `${line.id} ${theme} (${value}) sinks into the map background`,
        );
        for (const [id, surface] of surfaces)
          assert.ok(
            contrast(value, surface) >= MIN_SURFACE_CONTRAST,
            `${line.id} ${theme} (${value}) is indistinguishable from ${id} (${surface})`,
          );
      }
    }
  }
});

test("display colours move lightness only — the operator's hue survives", () => {
  for (const country of COUNTRIES) {
    const pkg = packageFor(country);
    for (const line of pkg.lines) {
      assert.match(line.colorReference, /^#[0-9a-f]{6}$/, `${line.id} reference`);
      const reference = hsl(line.colorReference);
      for (const value of [line.color, line.colorDark]) {
        const variant = hsl(value);
        if (reference.saturation < 0.08) continue; // a neutral has no hue to keep
        assert.ok(
          Math.abs(variant.hue - reference.hue) < 0.02 ||
            Math.abs(variant.hue - reference.hue) > 0.98,
          `${line.id}: ${value} is a different hue from ${line.colorReference}`,
        );
        assert.ok(
          Math.abs(variant.saturation - reference.saturation) < 0.06,
          `${line.id}: ${value} changed saturation, not just lightness`,
        );
      }
    }
  }
});

test("a reference colour that already reads is used verbatim", async () => {
  const light = (await basemapFor("light")).surfaceColors.background;
  const dark = (await basemapFor("dark")).surfaceColors.background;
  for (const country of COUNTRIES) {
    for (const line of packageFor(country).lines) {
      if (contrast(line.colorReference, light) >= MIN_BACKGROUND_CONTRAST)
        assert.equal(
          line.color,
          line.colorReference,
          `${line.id}: light variant deviates from a reference that already reads`,
        );
      if (contrast(line.colorReference, dark) >= MIN_BACKGROUND_CONTRAST)
        assert.equal(
          line.colorDark,
          line.colorReference,
          `${line.id}: dark variant deviates from a reference that already reads`,
        );
    }
  }
});
