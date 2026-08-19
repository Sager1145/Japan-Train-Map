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
  assert.equal(pkg.geometrySource.officialOnly, 0);
  assert.deepEqual(pkg.geometrySource.osmGeometry.lines, [
    "jp-東日本旅客鉄道-東北新幹線",
    "jp-東日本旅客鉄道-東北線-2",
    "jp-東日本旅客鉄道-東海道線",
    "jp-東日本旅客鉄道-総武線",
    "jp-東日本旅客鉄道-総武線-3",
    "jp-東海旅客鉄道-東海道新幹線",
  ]);
  assert.match(pkg.geometrySource.osmGeometry.evidence, /tokyo-station-platforms\.json$/);
  assert.match(pkg.geometrySource.osmGeometry.license, /ODbL/);
  assert.match(pkg.attributeSources.structure, /OpenStreetMap/);
  assert.match(pkg.attributeSources.colours, /sources\.md/);
});

test("station points and line intervals stay one-for-one after display grooming", () => {
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  assert.equal(network.stations.features.length, pkg.stats.stations);
  assert.equal(
    pkg.lines.reduce((sum, line) => sum + line.segments.length, 0),
    pkg.stats.intervals,
  );
});
