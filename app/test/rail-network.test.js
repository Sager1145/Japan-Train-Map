"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const RailNetwork = require("../public/rail-network.js");

const PACKAGE_PATH = path.join(
  __dirname,
  "../public/rail/jp-2025.json",
);
const EXPECTED_COUNTS = Object.freeze({
  segments: 9442,
  stations: 10034,
  lines: 594,
  groups: 8967,
});
test("compact rail package produces the characterized render model", async () => {
  // Snapshot + expected hash are shared with scripts/test-rail-loader-parity.mjs
  // (one hash update per package regeneration). The shared module is ESM and
  // this file is CJS, hence the dynamic import.
  const { EXPECTED_RENDER_HASH, renderRelevantSnapshot } = await import(
    "../scripts/lib/render-snapshot.mjs"
  );
  const compactPackage = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const network =
    RailNetwork.buildNetworkFromCompactPackage(compactPackage);

  assert.ok(network);
  assert.deepEqual(
    {
      segments: network.segments.features.length,
      stations: network.stations.features.length,
      lines: network.lineById.size,
      groups: network.groupMembers.size,
    },
    EXPECTED_COUNTS,
  );
  assert.equal(network.stationById.size, EXPECTED_COUNTS.stations);

  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(renderRelevantSnapshot(network)))
    .digest("hex");
  assert.equal(digest, EXPECTED_RENDER_HASH);
});

test("rail package validation and zoom helpers preserve current behavior", () => {
  assert.equal(RailNetwork.buildNetworkFromCompactPackage(null), null);
  assert.equal(
    RailNetwork.buildNetworkFromCompactPackage({ format: "legacy", lines: [] }),
    null,
  );
  assert.equal(RailNetwork.minZoomForRank(null), 0);
  assert.equal(RailNetwork.minZoomForRank(0), 3);
  assert.equal(RailNetwork.minZoomForRank(99), 0);
  assert.equal(RailNetwork.stationMinZoomForLine(6, 0, 10), 6);
});
