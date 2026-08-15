// Some double-track railways send their two directions through different
// tunnels rather than side by side. 上越線 is the case: the down line takes the
// 新清水トンネル loop while the up line keeps the older bore, and 湯檜曽 and 土合
// each have two platforms in different places as a result.
//
// N02 states THAT this is so — it files a second platform feature at each end
// of such a section — but carries no direction attribute, so which bore is
// which has to come from a source. These tests pin both halves: the geometry is
// derived, the 上り/下り label is sourced, and neither is invented.

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
    // Two stations, one interval: it is the track between one pair of platforms.
    assert.equal(line.stations.length, 2, `${line.id} should join two platforms`);
    assert.equal(line.segments.length, 1);

    // Its platforms are NOT the partner's. That is the whole point — if they
    // were, this would be a duplicate stroke rather than the other direction's
    // track, and welding it to the partner's dots would fold it back on itself.
    const partnerPoints = new Set(
      partner.stations.map((station) => `${station[2]},${station[3]}`),
    );
    for (const station of line.stations)
      assert.ok(
        !partnerPoints.has(`${station[2]},${station[3]}`),
        `${line.id} reuses ${station[1]}'s platform from its partner`,
      );

    // And it draws real track, not a hairline.
    assert.ok(line.segments[0][0] > 0.1, `${line.id} has no length`);
  }
});

test("上越線's two bores are drawn separately, with the sourced direction", () => {
  const up = byId.get("jp-東日本旅客鉄道-上越線-p1");
  const down = byId.get("jp-東日本旅客鉄道-上越線");
  assert.ok(up && down);

  // The up line keeps the older alignment and the down line takes the loop, so
  // the loop is much the longer of the two. 湯檜曽 -> 土合 is 3.5 km by the
  // operator's kilometrage; the loop is roughly twice that on the ground.
  const upKm = up.segments[0][0];
  assert.ok(upKm > 3 && upKm < 6, `up bore is ${upKm} km`);
  assert.equal(up.alignmentDirection, "up");
  assert.ok(up.alignmentSource, "the direction label must name its source");

  const pairs = down.alignmentPairs || [];
  const record = pairs.find((entry) => entry.with === up.id);
  assert.ok(record, "the down line does not record the pair");
  assert.equal(record.direction, "down");
  assert.equal(record.from, "湯檜曽");
  assert.equal(record.to, "土合");
});

test("an unsourced pair says so rather than claiming a direction", () => {
  for (const line of paired) {
    if (line.alignmentSource) continue;
    assert.equal(
      line.alignmentDirection,
      "unassigned",
      `${line.id} claims a direction with no source behind it`,
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
