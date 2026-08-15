import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const RailNetwork = require("../public/rail-network.js");
const pkg = JSON.parse(
  readFileSync(new URL("../public/rail/jp-2025.json", import.meta.url), "utf8"),
);

test("Japan display package advertises the current reproducible contract", () => {
  assert.equal(pkg.format, "compact-v1");
  assert.equal(pkg.version, "2025.4.2");
  assert.equal(pkg.geometrySource.officialOnly, 1);
  assert.match(pkg.attributeSources.structure, /OpenStreetMap/);
  assert.match(pkg.attributeSources.colours, /sources\.md/);
});

test("every stored parallel lane is represented by final display geometry", () => {
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const displayed = new Set(
    network.segments.features.map(
      (feature) => `${feature.properties.lineId}\u0000${feature.properties.lane}`,
    ),
  );
  for (const row of pkg.lanes || [])
    assert.ok(displayed.has(`${row[0]}\u0000${row[4]}`), `${row[0]} lane ${row[4]}`);
});

test("station points and line intervals stay one-for-one after display grooming", () => {
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  assert.equal(network.stations.features.length, pkg.stats.stations);
  assert.equal(
    pkg.lines.reduce((sum, line) => sum + line.segments.length, 0),
    pkg.stats.intervals,
  );
  assert.ok(network.stationLanes.features.length > 0);
});
