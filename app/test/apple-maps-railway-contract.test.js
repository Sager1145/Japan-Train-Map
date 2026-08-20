"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const RailNetwork = require("../public/rail-network.js");

const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];
const ZOOMS = [3, 5, 8, 10, 12, 14, 16, 18];

function loadStyle() {
  const context = { window: {}, console };
  context.window.RailNetwork = RailNetwork;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["railmap-basemap.js", "railmap-style.js"])
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "../public", file), "utf8"),
      context,
      { filename: file },
    );
  return context.window.RailMapStyle;
}

const style = loadStyle();

function packageAndNetwork(country) {
  const packagePath = path.join(
    __dirname,
    "../public/rail",
    `${country}-2025.json`,
  );
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return { pkg, network: RailNetwork.buildNetworkFromCompactPackage(pkg) };
}

function stationLayers() {
  const built = style.buildBaseStyle({ country: "jp", theme: "light" });
  const byId = new Map(built.layers.map((layer) => [layer.id, layer]));
  return {
    built,
    plain: byId.get(style.STATIONS_LAYER),
  };
}

function stringsIn(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, found);
  return found;
}

test("station_glyph_is_circle_at_all_zooms", () => {
  const { plain } = stationLayers();
  assert.equal(plain.type, "circle");
  for (const zoom of ZOOMS) {
    const radius = style.evaluateScreenValue(
      plain.paint["circle-radius"],
      zoom,
      {},
    );
    assert.ok(radius > 0, `z${zoom} circle radius is not positive`);
    assert.ok(
      Math.abs(
        radius / style.railwayScaleAt(zoom) -
          style.RAILWAY_STYLE.stationRadiusPx,
      ) <= 1e-9,
    );
  }
});

test("apple_maps_transit_line_weight_and_casing", () => {
  const built = style.buildBaseStyle({ country: "jp", theme: "dark" });
  const byId = new Map(built.layers.map((layer) => [layer.id, layer]));
  const casing = byId.get(style.SEGMENTS_CASING_LAYER);
  const line = byId.get(style.SEGMENTS_LAYER);
  assert.ok(casing);
  assert.ok(line);
  assert.ok(built.layers.indexOf(casing) < built.layers.indexOf(line));
  assert.equal(casing.source, line.source);
  assert.equal(casing.paint["line-color"], "rgb(7,8,10)");
  assert.equal(casing.layout["line-cap"], "round");
  assert.equal(casing.layout["line-join"], "round");
  const zoom = 14;
  const core = style.evaluateScreenValue(line.paint["line-width"], zoom, {});
  const outer = style.evaluateScreenValue(
    casing.paint["line-width"],
    zoom,
    {},
  );
  // Measured off macOS 「地圖」→ 大眾運輸 at 東京駅 city view, 2026-08-12: an
  // ordinary transit line reads at ~2.8 pt there and its bead at ~6.2 pt, and
  // this map drew 3 px / 6 px against it until 2026-08-20, when the whole
  // railway was halved by request — Japan stacks four to six railways through
  // corridors Apple's reference never draws at once, and at 3 px they welded
  // shut. These literals are the contract, deliberately NOT read back from
  // RAILWAY_STYLE — a test that derives the number it is checking cannot fail
  // when the number moves.
  assert.equal(core, 1.5);
  assert.ok(Math.abs((outer - core) / 2 - 0.3) <= 1e-9);
  // The keyline is a FIFTH of the core either side, the proportion it held at
  // the old weight (0.6 on 3): halving the stroke had to halve its edge too,
  // or the quiet separator becomes the thickest thing about a fine line.
  assert.ok(Math.abs((outer - core) / 2 / core - 0.2) <= 1e-9);
  // The bead did NOT follow the stroke down: it stays at the 6 px Apple's
  // Transit view was measured at, which puts it at four strokes rather than
  // two. That is the retune's one deliberate asymmetry — the line was what
  // read too heavy, and a station a reader cannot find is not a lighter map.
  const dot = byId.get(style.STATIONS_LAYER);
  const radius = style.evaluateScreenValue(
    dot.paint["circle-radius"],
    zoom,
    {},
  );
  assert.equal(radius * 2, 6);
  assert.ok(Math.abs(radius * 2 - core / 0.25) <= 1e-9);
  // The stroke sits at half the band this project read off Apple's Transit
  // view — the whole point of the 2026-08-20 retune, so landing back on
  // Apple's own number would undo it — while the bead stays inside it.
  assert.ok(core >= 1.2 && core <= 1.7, `line core ${core} px is outside the halved band`);
  assert.ok(radius * 2 >= 5.2 && radius * 2 <= 7.0, `station bead ${radius * 2} px is outside the Apple Transit band`);
});

test("all_railway_lines_use_the_exact_theme_package_colour", () => {
  for (const country of COUNTRIES) {
    for (const theme of ["light", "dark"]) {
      const expected =
        theme === "dark"
          ? [
              "coalesce",
              ["get", "colorDark"],
              ["get", "color"],
              RailNetwork.DEFAULT_LINE_COLOR,
            ]
          : ["coalesce", ["get", "color"], RailNetwork.DEFAULT_LINE_COLOR];
      const built = style.buildBaseStyle({ country, theme });
      const byId = new Map(built.layers.map((layer) => [layer.id, layer]));
      for (const layerId of [
        style.SEGMENTS_LAYER,
        style.SEGMENTS_SUSPENDED_LAYER,
      ]) {
        const actual = JSON.parse(
          JSON.stringify(byId.get(layerId).paint["line-color"]),
        );
        assert.deepEqual(actual, expected);
      }
    }
  }
});

test("apple_maps_selected_route_casing_is_restrained", () => {
  const built = style.buildBaseStyle({ country: "jp", theme: "dark" });
  const byId = new Map(built.layers.map((layer) => [layer.id, layer]));
  const route = byId.get(style.TRAIN_ROUTES_LAYER);
  const casing = byId.get(style.TRAIN_SEL_CASING_LAYER);
  // The default ride weight (app-config.js DEFAULT_TRAIN_WEIGHT), halved with
  // the network stroke on 2026-08-20.
  const feature = { width: 2 };
  const zoom = 14;
  const core = style.evaluateScreenValue(
    route.paint["line-width"],
    zoom,
    feature,
  );
  const outer = style.evaluateScreenValue(
    casing.paint["line-width"],
    zoom,
    feature,
  );
  assert.ok(core > style.RAILWAY_STYLE.railWidthPx);
  assert.equal(Math.round(((outer - core) / 2) * 10) / 10, 0.7);
  assert.ok(outer < core * 2);
});

test("station_glyph_never_morphs_to_logo", () => {
  const { plain } = stationLayers();
  assert.equal(plain.layout["icon-image"], undefined);
});

test("station_source_has_no_clustering", () => {
  const { built } = stationLayers();
  for (const sourceId of [style.STATIONS_SOURCE]) {
    const source = built.sources[sourceId];
    assert.equal(source.type, "geojson");
    assert.equal(source.cluster, undefined);
    assert.equal(source.clusterRadius, undefined);
    assert.equal(source.clusterProperties, undefined);
  }
});

test("station_minz_is_independent_lod", () => {
  for (const country of COUNTRIES) {
    const { network } = packageAndNetwork(country);
    for (const feature of network.stations.features) {
      assert.ok(Number.isFinite(feature.properties.minz));
      assert.ok(feature.properties.stationId);
      assert.ok(feature.properties.lineId);
      assert.equal(feature.geometry.type, "Point");
    }
  }
  const { network } = packageAndNetwork("jp");
  assert.ok(
    network.stations.features.some(
      (feature) => feature.properties.minz > feature.properties.lineMinz,
    ),
    "the fixture must exercise independent intermediate-station omission",
  );
});

test("interchange_is_open_circle", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(style.stationFill("light"))), [
    "case",
    ["==", ["get", "interchange"], 1],
    "#FFFFFF",
    ["coalesce", ["get", "color"], "#7C8A82"],
  ]);
});

test("single_line_station_is_solid_circle", () => {
  const fill = Array.from(style.stationFill("light"));
  assert.deepEqual(JSON.parse(JSON.stringify(fill.at(-1))), [
    "coalesce",
    ["get", "color"],
    "#7C8A82",
  ]);
});

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((value) => parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(left, right) {
  const values = [relativeLuminance(left), relativeLuminance(right)].sort(
    (a, b) => b - a,
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("every_japan_line_has_non_black_non_white_contrasting_theme_colours", () => {
  const { pkg, network } = packageAndNetwork("jp");
  const forbidden = new Set(["#000000", "#ffffff"]);
  for (const line of pkg.lines) {
    assert.match(line.color, /^#[0-9a-f]{6}$/);
    assert.match(line.colorDark, /^#[0-9a-f]{6}$/);
    assert.match(line.colorReference, /^#[0-9a-f]{6}$/);
    assert.ok(!forbidden.has(line.color), `${line.id} light is black/white`);
    assert.ok(!forbidden.has(line.colorDark), `${line.id} dark is black/white`);
    assert.ok(contrast(line.color, "#f2f3f0") >= 3, `${line.id} light disappears into the map`);
    assert.ok(contrast(line.colorDark, "#0c0c0c") >= 3, `${line.id} dark disappears into the map`);
  }
  for (const feature of [
    ...network.segments.features,
    ...network.stations.features,
  ]) {
    assert.match(feature.properties.colorDark, /^#[0-9a-f]{6}$/);
  }
});

test("labels_may_dedupe_without_merging_markers", () => {
  for (const country of COUNTRIES) {
    const { pkg, network } = packageAndNetwork(country);
    const expected = pkg.lines.reduce((sum, line) => sum + line.stations.length, 0);
    assert.equal(network.stations.features.length, expected);
    assert.equal(network.stationById.size, expected);
    assert.ok(network.groupMembers.size <= expected);
  }
});

test("five_country_build_and_validation_scope", async () => {
  const topology = await import(
    "../scripts/validation/validate-railway-topology.mjs"
  );
  const anchoring = await import(
    "../scripts/validation/validate-station-render-anchoring.mjs"
  );
  assert.deepEqual(Array.from(topology.COUNTRIES), COUNTRIES);
  assert.deepEqual(Array.from(anchoring.COUNTRIES), COUNTRIES);
  for (const country of COUNTRIES)
    assert.ok(packageAndNetwork(country).pkg.lines.length > 0);
});

// ───────────────────────── the names (Apple Transit parity) ─────────────────────────
// Apple's 大眾運輸 view names two things: the station, beside its bead, and the
// line, along the line. This project follows it into text and nowhere else —
// the marks stay round dots at every zoom (see the tests above), and these
// layers must never become a way to smuggle a badge back in.

// Text needs glyphs, and glyphs arrive with the basemap. A stub basemap is
// enough to make buildBaseStyle stage the label layers.
const GLYPH_BASEMAP = Object.freeze({
  version: 8,
  glyphs: "https://example.invalid/fonts/{fontstack}/{range}.pbf",
  sources: {},
  layers: [],
});

function labelLayers(theme) {
  const built = style.buildBaseStyle({
    country: "jp",
    theme: theme || "light",
    basemap: JSON.parse(JSON.stringify(GLYPH_BASEMAP)),
  });
  const byId = new Map(built.layers.map((layer) => [layer.id, layer]));
  return {
    built,
    byId,
    stationLabel: byId.get(style.STATIONS_LABEL_LAYER),
    lineLabel: byId.get(style.SEGMENTS_LABEL_LAYER),
  };
}

test("network_labels_are_text_only_and_never_a_badge", () => {
  const { stationLabel, lineLabel } = labelLayers();
  for (const layer of [stationLabel, lineLabel]) {
    assert.ok(layer, "both network label layers must be staged");
    assert.equal(layer.type, "symbol");
    assert.ok(layer.layout["text-field"], "a label layer must carry text");
    // The whole point: no icon of any kind on a label layer, so no zoom, no
    // theme and no data value can turn a station name into an operator mark.
    assert.equal(layer.layout["icon-image"], undefined);
    assert.equal(layer.layout["icon-size"], undefined);
    for (const found of stringsIn([layer.layout, layer.paint]))
      assert.ok(
        !/logo|badge|operator|\bjr\b/i.test(found),
        `${layer.id} must not reference an operator mark: ${found}`,
      );
  }
});

test("line_name_is_written_along_the_line", () => {
  const { lineLabel } = labelLayers();
  assert.equal(lineLabel.source, style.SEGMENTS_SOURCE);
  // "line", not "point": a name written ALONG a railway, never dropped on one.
  assert.equal(lineLabel.layout["symbol-placement"], "line");
  assert.ok(lineLabel.layout["text-max-angle"] > 0);
  assert.equal(lineLabel.layout["text-allow-overlap"], false);
});

test("station_label_dedupes_by_group_without_merging_markers", () => {
  const { stationLabel, byId } = labelLayers();
  // The dedupe is a SOURCE of its own, never a filter or a flag on the marks…
  assert.equal(stationLabel.source, style.STATION_LABELS_SOURCE);
  assert.equal(stationLabel.filter, undefined);
  assert.notEqual(style.STATION_LABELS_SOURCE, style.STATIONS_SOURCE);
  // …and the mark layers keep reading the untouched platform source.
  assert.equal(byId.get(style.STATIONS_LAYER).source, style.STATIONS_SOURCE);
  for (const country of COUNTRIES) {
    const { pkg, network } = packageAndNetwork(country);
    const features = network.stations.features;
    // Every platform still ships, whatever the labels do.
    const platforms = pkg.lines.reduce(
      (total, line) => total + line.stations.length,
      0,
    );
    assert.equal(features.length, platforms, `${country} lost a platform`);
    const elected = network.stationLabels.features;
    assert.ok(elected.length > 0, `${country} elected no station names`);
    assert.ok(
      elected.length <= network.groupMembers.size,
      `${country} elected more names than it has station groups`,
    );
    // The elected features ARE platform features, not copies of them: a name
    // that could drift from its dot is a name on the wrong station.
    const byIdentity = new Set(features);
    const perGroup = new Map();
    for (const feature of elected) {
      assert.ok(
        byIdentity.has(feature),
        `${country} labelled a feature that is not one of its platforms`,
      );
      const key =
        feature.properties.stationGroupId ||
        `solo:${feature.properties.stationId}`;
      perGroup.set(key, (perGroup.get(key) || 0) + 1);
      assert.equal(perGroup.get(key), 1, `${country} named ${key} twice`);
    }
    // The render model the DOTS are drawn from gained nothing at all — no new
    // property, so the characterized render hash cannot move because of a
    // labelling decision (test/rail-network.test.js owns that hash).
    for (const feature of features)
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          feature.properties,
          "labelPrimary",
        ),
        false,
      );
  }
});

test("station_label_never_outlives_its_own_dot", () => {
  const { stationLabel, byId } = labelLayers();
  const dot = byId.get(style.STATIONS_LAYER);
  // Same minz on the same feature object, so the two gates are comparable.
  // Same per-feature minz gate, plus a floor: a name can appear later than its
  // bead but never earlier, at any zoom, for any minz a package can hold.
  for (const zoom of ZOOMS)
    for (const minz of [0, 3, 7, 10, 14]) {
      const feature = { minz };
      const labelOpacity = style.evaluateScreenValue(
        stationLabel.paint["text-opacity"],
        zoom,
        feature,
      );
      const dotOpacity = style.evaluateScreenValue(
        dot.paint["circle-opacity"],
        zoom,
        feature,
      );
      assert.ok(
        labelOpacity <= dotOpacity,
        `z${zoom} minz${minz}: label ${labelOpacity} outlived dot ${dotOpacity}`,
      );
    }
});

test("network_labels_are_absent_without_glyphs", () => {
  // No basemap ⇒ no glyph endpoint ⇒ no text layers at all, rather than a
  // styleglyphsmissing error every frame. The marks are the contract.
  const built = style.buildBaseStyle({ country: "jp", theme: "light" });
  const ids = new Set(built.layers.map((layer) => layer.id));
  assert.equal(ids.has(style.STATIONS_LABEL_LAYER), false);
  assert.equal(ids.has(style.SEGMENTS_LABEL_LAYER), false);
  // …and the dots are still there, unlabelled.
  assert.equal(ids.has(style.STATIONS_LAYER), true);
});

test("station_glyph_follows_the_boot_theme", () => {
  // buildBaseStyle used to stamp "light" into the station colours whatever the
  // theme argument said, so a dark boot drew light platforms until the first
  // manual theme switch repainted them.
  for (const theme of ["light", "dark"]) {
    const built = style.buildBaseStyle({ country: "jp", theme });
    const byId = new Map(built.layers.map((layer) => [layer.id, layer]));
    const dot = byId.get(style.STATIONS_LAYER);
    assert.equal(
      JSON.stringify(dot.paint["circle-color"]),
      JSON.stringify(style.stationFill(theme)),
    );
    assert.equal(
      JSON.stringify(dot.paint["circle-stroke-color"]),
      JSON.stringify(style.stationStroke(theme)),
    );
  }
});

test("underground_structure_is_preserved_without_guessing_other_countries", () => {
  // Japan now carries OSM-conflated tunnel/bridge measures with provenance.
  // The other four packages still have no common segment-level field, so the
  // renderer must not infer underground status from a line name or mode.
  const SURFACE_FIELDS =
    /^(underground|tunnel|subway|elevated|surface|grade|structure)$/i;
  for (const country of COUNTRIES.filter((country) => country !== "jp")) {
    const { pkg } = packageAndNetwork(country);
    const seen = new Set();
    const walk = (value, depth) => {
      if (depth > 4 || !value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 50)) walk(item, depth + 1);
        return;
      }
      for (const key of Object.keys(value)) {
        if (SURFACE_FIELDS.test(key)) seen.add(key);
        walk(value[key], depth + 1);
      }
    };
    walk(pkg, 0);
    assert.deepEqual(
      [...seen],
      [],
      `${country} now carries a surface attribute — close the underground gap`,
    );
  }
  const { pkg: japan } = packageAndNetwork("jp");
  const structureRows = japan.lines.reduce(
    (sum, line) => sum + (line.structure?.length || 0),
    0,
  );
  assert.ok(structureRows > 16000);
  assert.match(japan.attributeSources.structure, /OpenStreetMap/);

  // A dashed network overlay is deliberately deferred until those measures
  // are cut onto the final branched/lane display features; painting whole
  // subway lines dashed would be a false shortcut.
  //
  // That condition has now been met for ONE kind of measure and one only —
  // current service status — so the rule tightens rather than relaxes. The
  // field's own layers still may not carry a dash: `serviceStatus` on a line
  // is a summary ("partial_service_suspended"), and a ["case", ["get",
  // "serviceStatus"], …] on SEGMENTS_LAYER would draw all 124 km of 肥薩線
  // broken to describe 87 of them. The dash is allowed only on the layers fed
  // by geometry that rail-network.js has already cut to the ledger's station
  // spans.
  const { byId } = labelLayers();
  for (const id of [style.SEGMENTS_LAYER, style.SEGMENTS_CASING_LAYER])
    assert.equal(byId.get(id).paint["line-dasharray"], undefined);
  for (const id of [
    style.SEGMENTS_SUSPENDED_LAYER,
    style.SEGMENTS_SUSPENDED_CASING_LAYER,
  ]) {
    const layer = byId.get(id);
    const dash = layer.paint["line-dasharray"];
    assert.ok(Array.isArray(dash) && dash.length === 2, `${id} has no dash`);
    // …and it draws ONLY the cut features, never the whole field.
    assert.deepEqual(JSON.parse(JSON.stringify(layer.filter)), [
      "==",
      ["get", "suspended"],
      1,
    ]);
    // Butt caps: a round cap adds half a line width of ink at each end of
    // every dash, lengthening the mark and shortening the gap until the line
    // reads solid again (the reason TRAIN_XDAY_LAYER gives).
    assert.equal(layer.layout["line-cap"], "butt");
  }
  // The dash is one RHYTHM in pixels, expressed per layer in that layer's own
  // widths. MapLibre measures line-dasharray in line widths, so the casing —
  // 1.4× the core — needs a proportionally smaller pair or its dashes run 40%
  // long and hang a grey tail off both ends of every mark. Equal pairs on the
  // two layers is the bug this asserts against.
  const core = byId.get(style.SEGMENTS_SUSPENDED_LAYER).paint["line-dasharray"];
  const casing = byId.get(style.SEGMENTS_SUSPENDED_CASING_LAYER).paint[
    "line-dasharray"
  ];
  const coreWidth = 1.5;
  const casingWidth = 1.5 + 0.3 * 2;
  for (let index = 0; index < 2; index += 1)
    assert.ok(
      Math.abs(core[index] * coreWidth - casing[index] * casingWidth) < 0.01,
      `dash ${index} is ${core[index] * coreWidth} px on the core and ${
        casing[index] * casingWidth
      } px on the casing`,
    );
  // Same rhythm as the map's only other dash, the cross-day train — whose
  // reference stroke is DEFAULT_TRAIN_WEIGHT (2) × RIDDEN_WIDTH_SCALE.
  assert.ok(Math.abs(core[0] * coreWidth - 1.6 * 2 * 1.18) < 0.01);
  assert.ok(Math.abs(core[1] * coreWidth - 1.4 * 2 * 1.18) < 0.01);
});
