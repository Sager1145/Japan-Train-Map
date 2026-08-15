/*
 * Track a line runs on that its station order cannot carry.
 *
 * compact-v1 stores a line as DISTINCT stations in order, with segment i
 * running station i to station i+1. Hong Kong's Light Rail 505 and 751 break
 * that: their two directions are not mirror images — 505 takes different
 * streets each way, 751 serves 安定 only towards 天逸 — so no ordering of
 * distinct stations has a real service edge between every consecutive pair.
 *
 * Before `extraSegments`, the builder refused to publish those two lines at
 * all, because the alternative was to publish them with the direction-unique
 * edges silently missing, which is `network_union_missing_branch_edge`: a drawn
 * network short of track the operator runs.
 *
 * Two rules are held here, and they pull in opposite directions on purpose:
 *
 *   RECORDED — every service edge the order cannot represent is in the package.
 *   NOT DRAWN WITHOUT EVIDENCE — an entry with no geometry produces no stroke.
 *     The archived alignment holds one polyline per line and does not separate
 *     the tracks (audit HK-LR-GEOM-002); a stroke cut from it would sit exactly
 *     on the chain and assert shared track the survey denies.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const RailNetwork = require("../public/rail-network.js");
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function hongKongPackage() {
  return JSON.parse(
    fs.readFileSync(path.join(APP_DIR, "public", "rail", "hk-2025.json"), "utf8"),
  );
}

// A two-station line plus one extra edge between the same pair, standing in for
// the second street a direction takes. Synthetic because no archived alignment
// separates the tracks yet — which is the whole point of the geometry gap.
function lineWithExtraSegment(geometry) {
  const extra = { from: 0, to: 2, status: "verified" };
  if (geometry) extra.geometry = geometry;
  return {
    id: "xx-test-line",
    name: "Test",
    operator: "Test",
    rank: 3,
    color: "#123456",
    stations: [
      ["a", "A", 114.0, 22.3],
      ["b", "B", 114.01, 22.3],
      ["c", "C", 114.02, 22.3],
    ],
    segments: [
      [1.03, 0, [[114.0, 22.3], [114.01, 22.3]]],
      [1.03, 0, [[114.01, 22.3], [114.02, 22.3]]],
    ],
    extraSegments: [extra],
  };
}

test("505 and 751 are published, with the edges their order cannot carry", () => {
  const pkg = hongKongPackage();
  for (const id of ["hk-mtr-lr-505", "hk-mtr-lr-751"]) {
    const line = pkg.lines.find((row) => row.id === id);
    assert.ok(line, `${id} must be in the package`);
    assert.ok(
      Array.isArray(line.extraSegments) && line.extraSegments.length > 0,
      `${id} must record the edges its station order cannot carry`,
    );
    for (const extra of line.extraSegments) {
      assert.ok(
        Number.isInteger(extra.from) && Number.isInteger(extra.to),
        "an extra segment names its two stations by index",
      );
      assert.ok(line.stations[extra.from], `${id} from-index in range`);
      assert.ok(line.stations[extra.to], `${id} to-index in range`);
      assert.notEqual(extra.from, extra.to);
      assert.ok(extra.status, "an extra segment carries a status");
      if (extra.status === "data_coverage_gap")
        assert.ok(extra.evidence, "a gap names the evidence for the gap");
    }
  }
});

test("the recorded edges are the ones the audit found, and no others", () => {
  const pkg = hongKongPackage();
  const named = (id) => {
    const line = pkg.lines.find((row) => row.id === id);
    return new Set(
      line.extraSegments.map((extra) =>
        [line.stations[extra.from][1], line.stations[extra.to][1]].sort().join("↔"),
      ),
    );
  };
  // Light Rail 505: 往兆康 runs 建安→山景(南)→山景(北)→石排 and calls at 麒麟;
  // 往三聖 runs 石排→鳴琴→建安 and 兆康 drops straight to 青松.
  assert.deepEqual(
    named("hk-mtr-lr-505"),
    new Set(["兆康↔青松", "石排↔鳴琴", "山景 (南)↔建安"]),
  );
  // Light Rail 751: 安定 is served towards 天逸 only, so the other direction
  // runs 屯門→市中心→友愛.
  assert.deepEqual(named("hk-mtr-lr-751"), new Set(["友愛↔市中心"]));
});

test("an extra segment with no geometry draws no stroke", () => {
  const withoutGeometry = RailNetwork.displayPartsForLine(lineWithExtraSegment(null));
  const plain = lineWithExtraSegment(null);
  delete plain.extraSegments;
  assert.deepEqual(
    withoutGeometry,
    RailNetwork.displayPartsForLine(plain),
    "recording an edge must not add geometry the survey has not supplied",
  );
});

test("an extra segment with geometry draws one more stroke, welded to its stations", () => {
  const detour = [
    [114.0, 22.3],
    [114.01, 22.305],
    [114.02, 22.3],
  ];
  const plain = lineWithExtraSegment(null);
  delete plain.extraSegments;
  const before = RailNetwork.displayPartsForLine(plain);
  const after = RailNetwork.displayPartsForLine(lineWithExtraSegment(detour));

  assert.equal(after.length, before.length + 1, "exactly one extra stroke");
  const added = after[after.length - 1];
  assert.deepEqual(added[0], [114.0, 22.3], "starts on the station it names");
  assert.deepEqual(
    added[added.length - 1],
    [114.02, 22.3],
    "ends on the station it names",
  );
  // Its own alignment, not a copy of the chain: the detour vertex survives.
  assert.ok(
    added.some((point) => point[1] > 22.3),
    "the extra stroke keeps its own geometry",
  );
});

test("hk lines the order does carry gain no extra segments", () => {
  const pkg = hongKongPackage();
  const withExtras = pkg.lines
    .filter((line) => Array.isArray(line.extraSegments) && line.extraSegments.length)
    .map((line) => line.id)
    .sort();
  assert.deepEqual(
    withExtras,
    ["hk-mtr-lr-505", "hk-mtr-lr-751"],
    "only the two non-mirror lines need the field",
  );
});
