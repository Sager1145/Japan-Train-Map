// Some double-track railways send their two directions through different
// tunnels rather than side by side. 上越線 is the case: the down line takes the
// 新清水トンネル loop while the up line keeps 清水トンネル, and 湯檜曽 and 土合
// each have two platforms in different places as a result.
//
// Two things have to be true at once, and these tests pin them separately.
// The geometry is DERIVED: N02 files a second platform feature at each station
// inside such a span, so the run of stations that have one says where the
// alignments part and where they meet again. The 上り/下り label is SOURCED:
// N02 carries no direction attribute, so it comes from the evidence file.
//
// The gate matters as much as the geometry. Two platforms far apart is not by
// itself a directional split — 近鉄 大阪上本町's second platform is the
// underground 難波線 level — so a span is drawn only when a source says the
// two directions really do separate there.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const APP_DIR = path.join(import.meta.dirname, "..");
const RailNetwork = require(path.join(APP_DIR, "public", "rail-network.js"));
const pkg = JSON.parse(
  fs.readFileSync(path.join(APP_DIR, "public", "rail", "jp-2025.json"), "utf8"),
);
const byId = new Map(pkg.lines.map((line) => [line.id, line]));
const paired = pkg.lines.filter((line) => line.alignmentRole === "paired_alignment");

test("a paired alignment is its own stroke, not a second copy of its partner", () => {
  assert.ok(paired.length > 0, "no paired alignments in the package");
  for (const line of paired) {
    const partner = byId.get(line.alignmentOf);
    assert.ok(partner, `${line.id} names a partner that is not in the package`);
    assert.equal(line.operator, partner.operator);
    assert.equal(line.name, partner.name);
    // It spans the whole run of separated stations, one interval per pair.
    assert.ok(line.stations.length >= 2, `${line.id} should join two platforms`);
    assert.equal(line.segments.length, line.stations.length - 1);

    // Every station it passes through stands on its OWN platform, not the
    // partner's. That is the whole point — reusing them would make this a
    // duplicate stroke rather than the other direction's track, and welding it
    // to the partner's dots would fold it back to reach a platform it does not
    // serve. The LAST station is the deliberate exception, below.
    const partnerPoints = new Set(
      partner.stations.map((station) => `${station[2]},${station[3]}`),
    );
    for (const station of line.stations.slice(0, -1))
      assert.ok(
        !partnerPoints.has(`${station[2]},${station[3]}`),
        `${line.id} reuses ${station[1]}'s platform from its partner`,
      );

    // ...and the closing station keeps the shared platform, because that is
    // where the two alignments meet again. Without it the stroke would stop in
    // mid-air at the mouth of a tunnel instead of rejoining the railway.
    const last = line.stations.at(-1);
    assert.ok(
      partnerPoints.has(`${last[2]},${last[3]}`),
      `${line.id} ends at ${last[1]} without rejoining its partner`,
    );

    // And it draws real track, not a hairline.
    for (const segment of line.segments)
      assert.ok(segment[0] > 0.1, `${line.id} has a zero-length interval`);
  }
});

test("上越線's two bores are drawn separately, with the sourced direction", () => {
  const up = byId.get("jp-東日本旅客鉄道-上越線-p1");
  const down = byId.get("jp-東日本旅客鉄道-上越線");
  assert.ok(up && down);

  // The alignments part at 湯檜曽 and meet again at 土樽, so the up bore runs
  // 湯檜曽 -> 土合 -> 土樽: about 4 km on the surface past the 湯檜曽 loop, then
  // 清水トンネル's 9,702 m under the ridge. Anything much shorter means the
  // stroke stopped at 土合 inside the mountain instead of rejoining the line.
  assert.deepEqual(
    up.stations.map((station) => station[1]),
    ["湯檜曽", "土合", "土樽"],
  );
  const upKm = up.segments.reduce((total, segment) => total + segment[0], 0);
  assert.ok(upKm > 13 && upKm < 16, `up bore is ${upKm} km`);
  assert.equal(up.alignmentDirection, "up");
  assert.ok(up.alignmentSource, "the direction label must name its source");

  const pairs = down.alignmentPairs || [];
  const record = pairs.find((entry) => entry.with === up.id);
  assert.ok(record, "the down line does not record the pair");
  assert.equal(record.direction, "down");
  assert.equal(record.from, "湯檜曽");
  assert.equal(record.to, "土樽");
});

test("no alignment is drawn as a pair without a source saying it is one", () => {
  // The builder finds more candidates than this by geometry alone: 大阪上本町's
  // underground 難波線 platform is 180 m off the 大阪線 and looks identical to a
  // split. Drawing those would invent second directions that do not exist, so
  // the evidence file is the gate and every drawn pair carries its source.
  for (const line of paired) {
    assert.ok(
      line.alignmentSource,
      `${line.id} is drawn as a pair with no source behind it`,
    );
    assert.ok(
      line.alignmentDirection === "up" || line.alignmentDirection === "down",
      `${line.id} is sourced but claims no direction`,
    );
  }
});

test("the renderer carries the pairing through to the ride matcher", () => {
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const line = network.lineById.get("jp-東日本旅客鉄道-上越線-p1");
  assert.ok(line, "the paired alignment is not in the built network");
  // The matcher reads these three off the line to break a tie between two
  // bores by the ride's own direction of travel.
  assert.equal(line.alignmentRole, "paired_alignment");
  assert.equal(line.alignmentDirection, "up");
  assert.equal(line.alignmentOf, "jp-東日本旅客鉄道-上越線");
});
