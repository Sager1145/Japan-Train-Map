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
    laned: byId.get(style.STATION_LANES_LAYER),
  };
}

function stringsIn(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, found);
  return found;
}

test("station_glyph_is_circle_at_all_zooms", () => {
  const { plain, laned } = stationLayers();
  assert.equal(plain.type, "circle");
  assert.equal(laned.type, "symbol");
  for (const zoom of ZOOMS) {
    const radius = style.evaluateScreenValue(
      plain.paint["circle-radius"],
      zoom,
      {},
    );
    const iconSize = style.evaluateScreenValue(
      laned.layout["icon-size"],
      zoom,
      {},
    );
    assert.ok(radius > 0, `z${zoom} circle radius is not positive`);
    assert.ok(iconSize > 0, `z${zoom} laned circle size is not positive`);
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
  // Measured off macOS 「地圖」→ 大眾運輸 at 東京駅 city view, 2026-08-12:
  // an ordinary transit line reads at ~2.8 pt there and its bead at ~6.2 pt.
  // These two literals are the contract, deliberately NOT read back from
  // RAILWAY_STYLE — a test that derives the number it is checking cannot fail
  // when the number moves.
  assert.equal(core, 3);
  assert.ok(Math.abs((outer - core) / 2 - 0.6) <= 1e-9);
  // …and the bead is exactly twice the stroke, at the same zoom, from the
  // same built style: the "beads on a wire" proportion is what makes the
  // retune a retune rather than two independent numbers drifting.
  const dot = byId.get(style.STATIONS_LAYER);
  const radius = style.evaluateScreenValue(
    dot.paint["circle-radius"],
    zoom,
    {},
  );
  assert.equal(radius * 2, 6);
  assert.equal(radius * 2, core * 2);
  // Within the band this project read off Apple's Transit view. A future
  // retune may move inside it; leaving it is a decision, not a typo.
  assert.ok(core >= 2.4 && core <= 3.4, `line core ${core} px is outside the Apple Transit band`);
  assert.ok(radius * 2 >= 5.2 && radius * 2 <= 7.0, `station bead ${radius * 2} px is outside the Apple Transit band`);
});

test("apple_maps_selected_route_casing_is_restrained", () => {
  const built = style.buildBaseStyle({ country: "jp", theme: "dark" });
  const byId = new Map(built.layers.map((layer) => [layer.id, layer]));
  const route = byId.get(style.TRAIN_ROUTES_LAYER);
  const casing = byId.get(style.TRAIN_SEL_CASING_LAYER);
  const feature = { width: 4 };
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
  assert.equal(Math.round(((outer - core) / 2) * 10) / 10, 1.4);
  assert.ok(outer < core * 2);
});

test("station_glyph_never_morphs_to_logo", () => {
  const { plain, laned } = stationLayers();
  assert.equal(plain.layout["icon-image"], undefined);
  const images = stringsIn(laned.layout["icon-image"]).filter((value) =>
    value.startsWith("rn-station-"),
  );
  assert.deepEqual(images, ["rn-station-light-"]);
  for (const value of stringsIn(laned.layout["icon-image"]))
    assert.doesNotMatch(value, /logo|badge|operator|jr/i);
});

test("station_source_has_no_clustering", () => {
  const { built } = stationLayers();
  for (const sourceId of [style.STATIONS_SOURCE, style.STATION_LANES_SOURCE]) {
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

test("visible_station_center_matches_rendered_lane", () => {
  for (const country of COUNTRIES) {
    const { network } = packageAndNetwork(country);
    const lanedByStation = new Map(
      network.stationLanes.features.map((feature) => [
        feature.properties.stationId,
        feature,
      ]),
    );
    for (const feature of network.stations.features) {
      if (!feature.properties.lane) continue;
      const marker = lanedByStation.get(feature.properties.stationId);
      assert.ok(marker, `${country}:${feature.properties.stationId} lost its lane marker`);
      assert.equal(marker.properties.lineId, feature.properties.lineId);
      assert.equal(marker.properties.lane, feature.properties.lane);
      assert.ok(Number.isFinite(marker.properties.bearing));
    }
  }
});

test("interchange_is_open_circle", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(style.stationFill("light"))), [
    "case",
    ["==", ["get", "interchange"], 1],
    "#FFFFFF",
    ["coalesce", ["get", "color"], "#7C8A82"],
  ]);
  const { laned } = stationLayers();
  const image = JSON.parse(JSON.stringify(laned.layout["icon-image"]));
  assert.equal(image[0], "concat");
  assert.deepEqual(image[3], [
    "case",
    ["==", ["get", "interchange"], 1],
    "-interchange",
    "",
  ]);
});

test("single_line_station_is_solid_circle", () => {
  const fill = Array.from(style.stationFill("light"));
  assert.deepEqual(JSON.parse(JSON.stringify(fill.at(-1))), [
    "coalesce",
    ["get", "color"],
    "#7C8A82",
  ]);
  const { laned } = stationLayers();
  assert.equal(laned.layout["icon-image"].at(-1).at(-1), "");
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
  assert.equal(
    byId.get(style.STATION_LANES_LAYER).source,
    style.STATION_LANES_SOURCE,
  );
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
  assert.equal(ids.has(style.STATION_LANES_LAYER), true);
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
    const laned = byId.get(style.STATION_LANES_LAYER);
    assert.equal(
      JSON.stringify(laned.layout["icon-image"]),
      JSON.stringify(style.stationIconImage(theme)),
    );
  }
});

test("underground_dashes_have_no_data_to_stand_on", () => {
  // Apple dashes underground stretches. Five packages, no per-segment (or even
  // per-line) surface attribute anywhere in any of them — so this project
  // reports the coverage gap rather than guessing from a line's name. If a
  // package ever grows the field, this test fails and the gap can be closed
  // honestly.
  const SURFACE_FIELDS =
    /^(underground|tunnel|subway|elevated|surface|grade|structure)$/i;
  for (const country of COUNTRIES) {
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
  // …and no network layer may fake one meanwhile.
  const { byId } = labelLayers();
  for (const id of [style.SEGMENTS_LAYER, style.SEGMENTS_CASING_LAYER])
    assert.equal(byId.get(id).paint["line-dasharray"], undefined);
});
