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

    // The closing station keeps its partner's platform, because that is where
    // the two alignments meet again. Without it the stroke would stop in mid-air
    // at the mouth of a tunnel instead of rejoining the railway.
    const partnerPoints = new Set(
      partner.stations.map((station) => `${station[2]},${station[3]}`),
    );
    const last = line.stations.at(-1);
    assert.ok(
      partnerPoints.has(`${last[2]},${last[3]}`),
      `${line.id} ends at ${last[1]} without rejoining its partner`,
    );

    // And the track between really is different track. This is the invariant
    // that holds whichever way the two alignments part: 上越線 separates at the
    // PLATFORMS, so 湯檜曽 and 土合 stand in two places, while 北陸線 separates
    // only BETWEEN stations — 敦賀 and 新疋田 each have one platform and the
    // 鳩原 loop swings a kilometre away in between. Sharing both dots is fine;
    // sharing the track is not, because then this is a duplicate stroke.
    const partnerTrack = partner.segments.flatMap((segment) => segment[2]);
    const widest = Math.max(
      ...line.segments
        .flatMap((segment) => segment[2])
        .map((point) =>
          Math.min(
            ...partnerTrack.map((other) =>
              Math.hypot(
                (other[0] - point[0]) *
                  111320 *
                  Math.cos((point[1] * Math.PI) / 180),
                (other[1] - point[1]) * 111320,
              ),
            ),
          ),
        ),
    );
    assert.ok(
      widest >= 150,
      `${line.id} never gets more than ${Math.round(widest)} m from its partner`,
    );

    // And it draws real track, not a hairline.
    for (const segment of line.segments)
      assert.ok(segment[0] > 0.1, `${line.id} has a zero-length interval`);
  }
});

test("北陸線's 鳩原 loop is labelled by station order, not the operator's word", () => {
  // The trap this pins: the matcher decides which bore a ride used from
  // `start.measure <= end.measure`, i.e. the line's own station order. This
  // package orders 北陸線 敦賀 → 米原, which is the operator's 上り direction, so
  // the loop — 上り線 to the railway — is ridden WITH the station order and has
  // to be labelled "down" here. Copying the operator's word would send every
  // 北陸線 ride to the wrong bore, and it would look right in the evidence file.
  const loop = byId.get("jp-西日本旅客鉄道-北陸線-p1");
  assert.ok(loop, "北陸線's loop is not in the package");
  assert.equal(loop.alignmentDirection, "down");
  assert.deepEqual(
    loop.stations.map((station) => station[1]),
    ["敦賀", "新疋田"],
  );
  // ~9.7 km round the spiral against 6.6 km direct — if these were close the
  // detector would have found ordinary double track, not the loop.
  const loopKm = loop.segments.reduce((total, segment) => total + segment[0], 0);
  assert.ok(loopKm > 9 && loopKm < 10.5, `loop is ${loopKm} km`);
  const direct = byId.get("jp-西日本旅客鉄道-北陸線");
  assert.ok(loopKm > direct.segments[0][0] * 1.3);
});

test("上越線's two bores are drawn separately, with the sourced direction", () => {
  const down = byId.get("jp-東日本旅客鉄道-上越線");
  // Found by the span it covers, not by its id: 上越線 separates TWICE — again
  // past 土樽 for the 松川ループ — so which suffix lands on which span is not
  // something this test should care about.
  const up = paired.find(
    (line) => line.alignmentOf === down.id && line.stations[0][1] === "水上",
  );
  assert.ok(up && down, "上越線's 清水 span is not in the package");

  // The bores part 117 m SOUTH of 湯檜曽 — the down line dives into 新清水トンネル
  // there — and meet again at 土樽. compact-v1 has no slot for track before a
  // line's first station, so the stroke starts at 水上, the last station both
  // still share, and is coincident with the down line until the portal. Without
  // that it stopped at 湯檜曽's up platform 71 m from the down line, joined to
  // nothing: a branch dangling in mid-air.
  // It is much the longer of the two because it is the
  // 1931 line: it climbs the 湯檜曽ループ spiral and then takes 清水トンネル's
  // 9,702 m, where the down bore simply goes under the ridge in 新清水トンネル.
  // If this ever drops to ~14 km the two bores have swapped, which is the bug
  // that put the main line on the loop and left this stroke on the tunnel.
  assert.deepEqual(
    up.stations.map((station) => station[1]),
    ["水上", "湯檜曽", "土合", "土樽"],
  );
  const upKm = up.segments.reduce((total, segment) => total + segment[0], 0);
  assert.ok(upKm > 19 && upKm < 23, `up bore is ${upKm} km`);
  // ...and the down bore's own 湯檜曽 -> 土合 hop stays close to the operator's
  // 3.493 km. It measured 7.529 when the main line was drawn on the loop.
  const hop = down.segments[down.stations.findIndex((s) => s[1] === "湯檜曽")][0];
  assert.ok(hop > 3 && hop < 4.5, `down bore's 湯檜曽 hop is ${hop} km`);
  assert.equal(up.alignmentDirection, "up");
  assert.ok(up.alignmentSource, "the direction label must name its source");

  const pairs = down.alignmentPairs || [];
  const record = pairs.find((entry) => entry.with === up.id);
  assert.ok(record, "the down line does not record the pair");
  assert.equal(record.direction, "down");
  assert.equal(record.from, "水上");
  assert.equal(record.to, "土樽");
});

test("上越線's spirals are on the up line, which is how the bores tell apart", () => {
  // The strongest check available, because it reads a property of the track
  // rather than a number that drifts: a spiral turns a full circle, and
  // ja.wikipedia's ループ線 article states that BOTH 上越線 spirals — 湯檜曽ループ
  // and 松川ループ — are 上り線のみ. The down bore has no spiral at all; it goes
  // under the ridge in 新清水トンネル and takes a horseshoe past 土樽.
  //
  // So if the two bores are ever drawn as each other again — which is exactly
  // what happened when the main stroke was anchored on the up line's platform
  // and climbed the loop for 7.5 km against an audited 3.5 — the circle shows
  // up on the wrong stroke and this fails, saying so in one line.
  const down = byId.get("jp-東日本旅客鉄道-上越線");
  const names = down.stations.map((station) => station[1]);

  const turning = (points) => {
    let total = 0;
    for (let i = 2; i < points.length; i += 1) {
      const [a, b, c] = [points[i - 2], points[i - 1], points[i]];
      const bearing = (from, to) =>
        Math.atan2(
          to[1] - from[1],
          (to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180),
        );
      // Wrap to (-pi, pi]. NOT with `%`: JavaScript's remainder keeps the
      // sign of the dividend, so a vertex that turns past -180 degrees — the
      // down bore has one — leaks a whole -360 into the total and reports a
      // straight run through 新清水トンネル as a spiral.
      const delta = bearing(b, c) - bearing(a, b);
      total += delta - 2 * Math.PI * Math.round(delta / (2 * Math.PI));
    }
    return (total * 180) / Math.PI;
  };

  for (const [from, to] of [
    ["水上", "土樽"],
    ["土樽", "越後中里"],
  ]) {
    const up = paired.find(
      (line) =>
        line.alignmentOf === down.id &&
        line.stations[0][1] === from &&
        line.stations.at(-1)[1] === to,
    );
    assert.ok(up, `上越線 ${from}–${to} is not drawn as a pair`);

    const downTrack = down.segments
      .slice(names.indexOf(from), names.indexOf(to))
      .flatMap((segment) => segment[2]);
    const upTrack = up.segments.flatMap((segment) => segment[2]);

    assert.ok(
      Math.abs(turning(upTrack)) > 250,
      `${from}–${to}: the up line should carry the spiral, but turns only ` +
        `${Math.round(turning(upTrack))}°`,
    );
    assert.ok(
      Math.abs(turning(downTrack)) < 180,
      `${from}–${to}: the down line should have no spiral, but turns ` +
        `${Math.round(turning(downTrack))}°`,
    );
  }
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

// The defect this pins is the one that showed on the map: a paired alignment
// drawn from its own platform outward, ending in mid-air because the bores part
// BETWEEN stations. Both ends have to land exactly on the primary stroke — the
// far end on the rejoin station, the near end on the last shared station.
test("a paired alignment meets the primary stroke at both of its ends", () => {
  const metres = (a, b) =>
    Math.hypot(
      (a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180),
      (a[1] - b[1]) * 111320,
    );
  for (const line of paired) {
    const partner = byId.get(line.alignmentOf);
    const partnerPoints = partner.segments.flatMap((segment) => segment[2]);
    const own = line.segments.flatMap((segment) => segment[2]);
    for (const [label, end] of [
      ["start", own[0]],
      ["end", own.at(-1)],
    ]) {
      const gap = Math.min(...partnerPoints.map((point) => metres(end, point)));
      assert.ok(
        gap < 1,
        `${line.id} ${label}s ${gap.toFixed(0)} m from ${partner.id}, joined to nothing`,
      );
    }
  }
});
