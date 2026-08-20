import assert from "node:assert/strict";
import test from "node:test";

import {
  attributionFilterFor,
  lateralDistance,
  ownTrackAt,
  wayNameSpellings,
} from "../scripts/railway/lib/track-attribution.mjs";

// No OSM cache is read here on purpose. The wrong_track criterion runs inside
// validate-basemap-alignment.mjs against the machine-local cell cache, which CI
// does not have; what this file pins is the part that has to be right whatever
// the cache says — WHICH railway a way name stands for, and whether a distance
// to that way is an offset or an overshoot.

const keikyuAirport = {
  name: "空港線",
  operator: "京浜急行電鉄",
  operatorShort: "京急",
};
const running = (name, operatorJa) => ({ name, operatorJa, running: true });

test("a way is this line's own only when its NAME says so", () => {
  const filter = attributionFilterFor(keikyuAirport);
  assert.equal(filter.owns(running("京浜急行電鉄空港線", "京浜急行電鉄")), true);
  // The defect this criterion exists for: the trunk belongs to the same
  // company, and station-track-claim's operator-only rung would accept it.
  assert.equal(filter.owns(running("京浜急行電鉄本線", "京浜急行電鉄")), false);
  assert.equal(filter.identifiable(running("京浜急行電鉄本線", "京浜急行電鉄")), true);
});

test("a way that names no railway cannot disagree with anybody", () => {
  const filter = attributionFilterFor(keikyuAirport);
  for (const meta of [
    running(null, "京浜急行電鉄"),
    running("陣田我王トンネル", "九州旅客鉄道"),
    running("多摩川橋梁", "京浜急行電鉄"),
  ]) {
    assert.equal(filter.identifiable(meta), false);
    assert.equal(filter.owns(meta), false);
  }
});

test("OSM's decorated corridor names resolve to the line they decorate", () => {
  // ・-joined: one pair of metals carrying several lines.
  const kyushuShinkansen = attributionFilterFor({
    name: "九州新幹線",
    operator: "九州旅客鉄道",
    operatorShort: "JR九州",
  });
  assert.equal(
    kyushuShinkansen.owns(running("山陽新幹線・博多南線・九州新幹線", "西日本旅客鉄道")),
    true,
  );
  // A qualified pair — the way IS the parent and the qualified child.
  const narita = attributionFilterFor({
    name: "成田線",
    operator: "東日本旅客鉄道",
    operatorShort: "JR東日本",
  });
  assert.equal(narita.owns(running("成田線（我孫子支線）", "東日本旅客鉄道")), true);
  // A branch filed under its parent, space separated.
  const tsurumi = attributionFilterFor({
    name: "鶴見線",
    operator: "東日本旅客鉄道",
    operatorShort: "JR東日本",
  });
  assert.equal(tsurumi.owns(running("JR鶴見線 大川支線", "東日本旅客鉄道")), true);
  // A romaji gloss is a translation, not a different railway.
  const sagamihara = attributionFilterFor({
    name: "相模原線",
    operator: "京王電鉄",
    operatorShort: "京王",
  });
  assert.equal(
    sagamihara.owns(running("京王電鉄相模原線 (Keio Railway Sagamihara Line)", "京王電鉄")),
    true,
  );
  // The operator's BRAND, which claimFilterFor deliberately will not strip.
  const tobuNikko = attributionFilterFor({
    name: "日光線",
    operator: "東武鉄道",
    operatorShort: "東武",
  });
  assert.equal(tobuNikko.owns(running("東武日光線", "東武鉄道")), true);
  // …and that must not make JR's 日光線 300 m away into 東武's.
  const chikuho = attributionFilterFor({
    name: "筑豊線",
    operator: "九州旅客鉄道",
    operatorShort: "JR九州",
  });
  assert.equal(chikuho.owns(running("JR福北ゆたか線", "九州旅客鉄道")), true);
});

test("a JR-branded nickname stays JR's — 阪急 keeps its 宝塚線", () => {
  const fukuchiyama = attributionFilterFor({
    name: "福知山線",
    operator: "西日本旅客鉄道",
    operatorShort: "JR西日本",
  });
  assert.equal(fukuchiyama.owns(running("JR宝塚線", "西日本旅客鉄道")), true);
  // 阪急's own 宝塚本線 runs beside it for kilometres; without the JR the
  // nickname is somebody else's line name, and must not resolve.
  assert.equal(fukuchiyama.owns(running("阪急電鉄宝塚本線", "阪急電鉄")), false);
  assert.equal(fukuchiyama.owns(running("宝塚線", "阪急電鉄")), false);
  const hankyu = attributionFilterFor({
    name: "宝塚本線",
    operator: "阪急電鉄",
    operatorShort: "阪急",
  });
  assert.equal(hankyu.owns(running("阪急電鉄宝塚本線", "阪急電鉄")), true);
  // The other direction is NOT symmetric and is deliberately left alone:
  // normaliseLineName drops a leading JR (that is what makes OSM's JR日光線
  // comparable at 日光), so "JR宝塚線" reads as a bare 宝塚線 and 阪急's filter
  // accepts it — at the weakest rung, the one that exists for company
  // boundaries. It can only ever SUPPRESS a finding on a line whose own metals
  // are lying right beside it under their own name, never invent one, so it is
  // a missed report at worst. Tightening it would mean teaching
  // station-track-claim that a JR prefix is load-bearing, which is the opposite
  // of why it strips it.
  assert.equal(hankyu.owns(running("JR宝塚線", "西日本旅客鉄道")), true);
});

test("a service with its own tracks is NOT a rename of the line it runs on", () => {
  // 京浜東北線 runs on the 東北本線's 電車線 — a different pair of rails 15-30 m
  // from the 列車線, which is exactly the offset the criterion has to keep
  // reporting. Same for the 総武 rapid/local pair and the freight roads.
  const tohoku = attributionFilterFor({
    name: "東北線",
    operator: "東日本旅客鉄道",
    operatorShort: "JR東日本",
  });
  assert.equal(tohoku.owns(running("京浜東北線", "東日本旅客鉄道")), false);
  assert.equal(tohoku.owns(running("JR東北本線", "東日本旅客鉄道")), true);
  const sobu = attributionFilterFor({
    name: "総武線",
    operator: "東日本旅客鉄道",
    operatorShort: "JR東日本",
  });
  assert.equal(sobu.owns(running("総武緩行線", "東日本旅客鉄道")), false);
  const tokaido = attributionFilterFor({
    name: "東海道線",
    operator: "東日本旅客鉄道",
    operatorShort: "JR東日本",
  });
  assert.equal(tokaido.owns(running("東海道貨物線", "東日本旅客鉄道")), false);
});

test("a company boundary keeps the neighbour's name on the line's own metals", () => {
  // 神戸高速線's metals are tagged 神戸高速鉄道 while 阪神 and 阪急 both run
  // them; station-track-claim ranks that last rather than dropping it, and the
  // attribution filter keeps that rung.
  const hanshin = attributionFilterFor({
    name: "神戸高速線",
    operator: "阪神電気鉄道",
    operatorShort: "阪神",
  });
  assert.equal(hanshin.owns(running("神戸高速線", "神戸高速鉄道")), true);
});

test("a branch filed under its parent without the space is still the parent's", () => {
  // OSM way/233363367 is spelt JR阪和線東羽衣支線 — no bracket, no space. It is
  // the 東羽衣支線's only track, and the package's 阪和線-2 IS that branch, so
  // the audit was reporting the branch for standing on itself.
  const hanwa = attributionFilterFor({
    name: "阪和線",
    operator: "西日本旅客鉄道",
    operatorShort: "JR西日本",
  });
  assert.equal(hanwa.owns(running("JR阪和線東羽衣支線", "西日本旅客鉄道")), true);
  assert.ok(wayNameSpellings("JR阪和線東羽衣支線", []).includes("東羽衣支線"));
  // The rule is a 支線 tail and nothing looser: a bare "…線…線" split would
  // fold a line's own freight road into it and hide the offset this criterion
  // is for. 東海道貨物線 is a different pair of metals and must stay foreign.
  const tokaido = attributionFilterFor({
    name: "東海道線",
    operator: "東日本旅客鉄道",
    operatorShort: "JR東日本",
  });
  assert.equal(tokaido.owns(running("東海道本線東海道貨物線", "東日本旅客鉄道")), false);
  assert.equal(tokaido.owns(running("東海道貨物線", "東日本旅客鉄道")), false);
});

// A stand-in for railway-topology's edge index: `within` hands back a Map of
// meta → distance, which is all ownTrackAt reads.
const fakeIndex = (ways) => ({
  within(point, radiusMeters, accept) {
    const found = new Map();
    for (const meta of ways) {
      if (accept && !accept(meta)) continue;
      const hit = lateralDistance(meta.coordinates, point);
      if (hit && hit.distance <= radiusMeters) found.set(meta, hit.distance);
    }
    return found;
  },
});
// A north-south way `offsetDegrees` east of 136.0765, spanning `south`..`north`.
const northSouth = (name, operatorJa, offsetDegrees, south, north) => ({
  name,
  operatorJa,
  running: true,
  coordinates: [
    [136.0765 + offsetDegrees, south],
    [136.0765 + offsetDegrees, north],
  ],
});

test("own metals are the NEAREST ones of ours, whichever rung names them", () => {
  // 敦賀, after the 2024 三セク handover: OSM files the through track as
  // 北陸本線 under ハピラインふくい — the company-boundary rung — right beside
  // the stroke, and a 北陸本線 under 西日本旅客鉄道 sits across the throat.
  // Ranking by rung first answered with the far one, an order of magnitude out.
  const hokuriku = attributionFilterFor({
    name: "北陸線",
    operator: "西日本旅客鉄道",
    operatorShort: "JR西日本",
  });
  const point = [136.0765, 35.6346];
  const near = northSouth("北陸本線", "ハピラインふくい", 0.0001, 35.633, 35.636);
  const far = northSouth("北陸本線", "西日本旅客鉄道", 0.0009, 35.633, 35.636);
  const found = ownTrackAt(point, hokuriku, fakeIndex([far, near]), 120);
  assert.equal(found.way, near);
  assert.ok(found.distance < 15, `${found.distance}`);
  // With only the far one mapped, that is still the answer — nothing is hidden.
  assert.equal(ownTrackAt(point, hokuriku, fakeIndex([far]), 120).way, far);
});

test("own metals presenting themselves end-on are 'cannot tell', not 'far away'", () => {
  // 品川's north throat: OSM splits the corridor at a joint beside the sample,
  // so both 東海道本線 ways carrying the line end there. The offset is ~30 m and
  // unmeasurable; answering with a way 100 m up the line reported a separate
  // alignment that does not exist.
  const tokaido = attributionFilterFor({
    name: "東海道線",
    operator: "東日本旅客鉄道",
    operatorShort: "JR東日本",
  });
  const point = [136.0765, 35.6346];
  const joint = northSouth("東海道本線", "東日本旅客鉄道", 0.0003, 35.6349, 35.6360);
  const distant = northSouth("東海道本線", "東日本旅客鉄道", 0.0011, 35.633, 35.636);
  assert.equal(lateralDistance(joint.coordinates, point).clamped, true);
  assert.equal(ownTrackAt(point, tokaido, fakeIndex([joint, distant]), 120), null);
  // Without the joint in reach the distant way is a real, interior offset and
  // is reported — the rule suppresses only the unmeasurable case.
  assert.equal(ownTrackAt(point, tokaido, fakeIndex([distant]), 120).way, distant);
});

test("wayNameSpellings returns nothing for a way that identifies no railway", () => {
  assert.deepEqual(wayNameSpellings("", []), []);
  assert.deepEqual(wayNameSpellings("大杉トンネル", []), []);
  assert.ok(wayNameSpellings("JR青梅短絡線", []).includes("JR青梅短絡線"));
});

test("lateralDistance separates an offset from an overshoot", () => {
  // A north-south way one degree of nothing wide, at 京急蒲田's latitude.
  const way = [
    [139.72382, 35.5604],
    [139.72382, 35.5608],
  ];
  // Beside its middle: a real sideways offset.
  const beside = lateralDistance(way, [139.7242, 35.5606]);
  assert.equal(beside.clamped, false);
  assert.ok(beside.distance > 30 && beside.distance < 40, `${beside.distance}`);
  // Past its north end: the distance is how far along we walked off it.
  const past = lateralDistance(way, [139.72382, 35.5612]);
  assert.equal(past.clamped, true);
  // Too short to be a polyline at all.
  assert.equal(lateralDistance([[139.72382, 35.5604]], [139.72382, 35.5612]), null);
});
