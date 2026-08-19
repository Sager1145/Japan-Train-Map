"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const RailNetwork = require("../public/rail-network.js");

const PACKAGE_PATH = path.join(__dirname, "../public/rail/jp-2025.json");

function coordinateKey(coordinate) {
  return `${coordinate[0]},${coordinate[1]}`;
}

function decodedIntervals(line) {
  let previousEnd = null;
  return line.segments.map((row) => {
    const coordinates = row[1]
      ? [previousEnd, ...row[2]]
      : row[2].map((coordinate) => [...coordinate]);
    previousEnd = coordinates.at(-1);
    return coordinates;
  });
}

test("every Japanese package line is seam-free before it reaches the renderer", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  // 2025.4.2 keeps the 2025.3.4 loop repair, then reapplies the branch and
  // doubling-back repairs after the OSM attribute/official-colour enrichment.
  //
  // 649 lines, up from 607: the 2026-08-15 rebuild draws each railway's
  // separate alignments as their own strokes, so a line with a rejoining route
  // or a physically detached half yields more than one. The count is a
  // characterisation, not a rule — everything below it is the rule, and it is
  // unchanged: every line's intervals match its station order, and every
  // interval meets its neighbour exactly.
  assert.equal(pkg.version, "2025.4.2");
  // 661: down from 664 with the 2026-08-18 live-line gap repairs. Five severed
  // sibling strokes rejoined their railways — 石北線-2 (生田原–西留辺蘂 T-junction
  // blind spot), 常磐線-2 (広野–Jヴィレッジ, N02's missing 218 m approach),
  // 日豊線-2/-2-p1 (中山香–杵築) and 山陽線-4 with the old 山陽線-2 (戸田–富海) —
  // while 日豊線's 立石 paired stroke re-emerged as 日豊線-p1 and 長崎線 gained a
  // -3 as its 旧線/新線 ring split out of the trunk: −5 strokes, +2.
  // 660: the 2026-08-18 audit pseudo-edge removals deleted the three
  // 成田-skipping edges of the 成田線 K4 clique, so 成田線-4 (久住–成田–下総松崎)
  // is no longer produced — the trunk itself runs through 成田 now and the
  // 佐倉/成田空港 branches join it there.
  // 658: the 2026-08-18 official-shape batch. 長崎線's trunk runs 鳥栖–長崎 via
  // the 市布新線 and the 旧線 via 長与 is a rejoining 喜々津–浦上 branch, so
  // 長崎線-3 (西浦上–長崎) folds into the trunk; 東海道線(JR東日本)'s trunk runs
  // 東京–熱海 via 品川・川崎・横浜 with the 品鶴線 as its own 品川–鶴見 stroke,
  // so the old 東京–品川 tail and 品川–鶴見 ring dissolve and the 相鉄連絡線
  // renumbers -4 → -3.
  // Still 658 after the 2026-08-18 京王新線 split: the 新線 (新線新宿–初台–
  // 幡ヶ谷–笹塚, carved from the「京王線」N02 key) arrives as its own line
  // exactly as the 初台–幡ヶ谷 orphan 京王線-2 folds away — 京王線 itself now
  // runs 新宿–笹塚 direct, the way its trains do.
  // 657 after the whole-country multi-line-station rebuild: the current
  // inventory no longer emits 函館線-4 (鹿部–大沼), because that interval is
  // already the final arm of 函館線-3. Full-staging prune removes the stale
  // duplicate instead of letting an unreproducible stroke survive promotion.
  // 654 on 2026-08-19: the three strokes that only carried a station the
  // graph's switchback pseudo-edge had skipped — 養老線-2 (室 大垣),
  // 西九州線-2 (東山代 伊万里 川東) and 東北線-7 (王子 上中里, renumbered to
  // -6) — are gone, their track now drawn by the trunks through 大垣, 伊万里
  // and 赤羽.
  // 652 on 2026-08-19: the same treatment for two edges that ride the
  // 日暮里—尾久—赤羽 支線 past 尾久 — 王子—日暮里 and 東十条—日暮里 — leaves the
  // 電車線 trunk continuous through 王子, 上中里, 田端 and 西日暮里, so the two
  // strokes that only carried the skipped station (東北線-5 and the old
  // 東北線-4) are no longer produced. 予讃線 loses no stroke: deleting the
  // 伊予若宮信号場 wye's fourth side just shortens 予讃線-3 to the official
  // 新谷—伊予大洲 section.
  assert.equal(pkg.lines.length, 652);

  let intervalCount = 0;
  for (const line of pkg.lines) {
    const expectedIntervals =
      line.stations.length - (line.isLoop ? 0 : 1);
    assert.equal(
      line.segments.length,
      expectedIntervals,
      `${line.id} station/interval topology`,
    );
    const intervals = decodedIntervals(line);
    intervalCount += intervals.length;
    intervals.forEach((coordinates, index) => {
      const start = line.stations[index];
      const end = line.stations[(index + 1) % line.stations.length];
      assert.ok(coordinates.length >= 2, `${line.id}:${index} has no line`);
      assert.equal(
        coordinateKey(coordinates[0]),
        coordinateKey([start[2], start[3]]),
        `${line.id}:${index} does not start at its station`,
      );
      assert.equal(
        coordinateKey(coordinates.at(-1)),
        coordinateKey([end[2], end[3]]),
        `${line.id}:${index} does not end at its station`,
      );
      assert.equal(
        line.segments[index][1],
        index === 0 ? 0 : 1,
        `${line.id}:${index} must encode one shared seam`,
      );
      if (index > 0)
        assert.equal(
          coordinateKey(intervals[index - 1].at(-1)),
          coordinateKey(coordinates[0]),
          `${line.id}:${index} has a station-boundary gap`,
        );
    });
  }
  assert.ok(intervalCount > pkg.lines.length * 10);
});

test("Tokyo and Osaka metro lines use verified official line colours", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const expected = new Map([
    ["jp-東京地下鉄-3号線銀座線", "#ff9500"],
    ["jp-東京地下鉄-4号線丸ノ内線", "#f62e36"],
    ["jp-大阪市高速電気軌道-1号線(御堂筋線)", "#db260a"],
    ["jp-大阪市高速電気軌道-4号線(中央線)", "#00a53c"],
  ]);
  for (const [id, color] of expected) {
    const line = pkg.lines.find((candidate) => candidate.id === id);
    assert.ok(line, `missing ${id}`);
    assert.equal(line.color, color, id);
    assert.match(line.colorSource, /^https:\/\//, id);
  }
});

test("Tokyo Station dots follow their line-matched platforms", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const tokyo = (id) => {
    const line = pkg.lines.find((candidate) => candidate.id === id);
    assert.ok(line, `missing ${id}`);
    const station = line.stations.find((candidate) => candidate[1] === "東京");
    assert.ok(station, `${id} is missing 東京`);
    return [station[2], station[3]];
  };

  const sobu = tokyo("jp-東日本旅客鉄道-総武線");
  const jrEastShinkansen = tokyo("jp-東日本旅客鉄道-東北新幹線");
  const jrSurfaceNorth = tokyo("jp-東日本旅客鉄道-東北線-2");
  const jrSurfaceSouth = tokyo("jp-東日本旅客鉄道-東海道線");
  const jrCentralShinkansen = tokyo("jp-東海旅客鉄道-東海道新幹線");

  // West → east follows the requested platform layout: 総武 underground,
  // shared middle surface, JR East 20-23, then JR Central 14-19.
  assert.ok(sobu[0] < jrSurfaceNorth[0]);
  assert.ok(jrSurfaceNorth[0] < jrEastShinkansen[0]);
  assert.ok(jrSurfaceNorth[0] < jrCentralShinkansen[0]);

  // The conventional JR through lines elect the same, direction-matched
  // surface platform and are welded to one physical track junction, instead of
  // being two merely coincident station records.
  assert.deepEqual(jrSurfaceNorth, jrSurfaceSouth);
  assert.deepEqual(jrSurfaceNorth, [139.7671827, 35.6811274]);

  // The two Shinkansen must never collapse back onto one copied N02 feature.
  assert.notDeepEqual(jrEastShinkansen, jrCentralShinkansen);

  // 総武's following interval must leave from its own underground marker;
  // moving only the dot while leaving the line behind would still look broken.
  const sobuLine = pkg.lines.find(
    (candidate) => candidate.id === "jp-東日本旅客鉄道-総武線",
  );
  const firstInterval = decodedIntervals(sobuLine)[0];
  assert.deepEqual(firstInterval[0], sobu);
  assert.equal(sobuLine.stations[1][1], "新日本橋");
  assert.deepEqual(firstInterval.at(-1), [
    sobuLine.stations[1][2],
    sobuLine.stations[1][3],
  ]);
  assert.ok(
    firstInterval.some(([lon, lat]) => lon === 139.7668911 && lat === 35.6832467),
    "総武線 東京–新日本橋 must follow the west tunnel bore",
  );

  // All four visible Tokyo approaches use registered physical rails instead
  // of N02's coarse station-to-station chords.  The surface north/south pair
  // also meets the same track-10 node immediately beside its one shared dot.
  const physicalInterval = (id, from, to) => {
    const line = pkg.lines.find((candidate) => candidate.id === id);
    assert.ok(line, `missing ${id}`);
    const index = line.stations.findIndex(
      (station, stationIndex) =>
        station[1] === from && line.stations[stationIndex + 1]?.[1] === to,
    );
    assert.ok(index >= 0, `${id} is missing ${from}–${to}`);
    return decodedIntervals(line)[index];
  };
  const surfaceNorth = physicalInterval(
    "jp-東日本旅客鉄道-東北線-2",
    "神田",
    "東京",
  );
  const surfaceSouth = physicalInterval(
    "jp-東日本旅客鉄道-東海道線",
    "東京",
    "有楽町",
  );
  assert.deepEqual(surfaceNorth.at(-1), [139.7671827, 35.6811274]);
  assert.deepEqual(surfaceSouth[0], surfaceNorth.at(-1));
  const northLine = pkg.lines.find(
    (candidate) => candidate.id === "jp-東日本旅客鉄道-東北線-2",
  );
  const southLine = pkg.lines.find(
    (candidate) => candidate.id === "jp-東日本旅客鉄道-東海道線",
  );
  assert.equal(northLine.railwayIdentity, "jp-jr-east-ueno-tokyo-through");
  assert.equal(southLine.railwayIdentity, northLine.railwayIdentity);
  const tohokuFamily = pkg.lines.filter((candidate) =>
    /^jp-東日本旅客鉄道-東北線(?:-|$)/.test(candidate.id),
  );
  assert.ok(tohokuFamily.length > 2, "the split Tohoku family is missing");
  assert.deepEqual(
    new Set(tohokuFamily.map((candidate) => candidate.railwayIdentity)),
    new Set([northLine.railwayIdentity]),
    "every Tohoku display stroke must inherit the registered through-rail identity",
  );
  const bearing = (a, b) =>
    (Math.atan2(
      (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180),
      b[1] - a[1],
    ) *
      180) /
    Math.PI;
  const northBearing = bearing(surfaceNorth.at(-2), surfaceNorth.at(-1));
  const southBearing = bearing(surfaceSouth[0], surfaceSouth[1]);
  const junctionTurn = Math.abs(((southBearing - northBearing + 540) % 360) - 180);
  assert.ok(junctionTurn < 5, `Tokyo through rail turns ${junctionTurn.toFixed(1)}°`);
  const northTotalMeters = northLine.segments.reduce(
    (sum, segment) => sum + segment[0] * 1000,
    0,
  );
  const rendered = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const renderedJunctions = rendered.stations.features.filter(
    (feature) =>
      feature.properties.stationGroupId === "003766" &&
      [northLine.id, southLine.id].includes(feature.properties.lineId),
  );
  assert.equal(renderedJunctions.length, 2);
  assert.deepEqual(
    renderedJunctions[0].geometry.coordinates,
    renderedJunctions[1].geometry.coordinates,
  );
  // The tangent itself is checked on the source geometry above (junctionTurn);
  // the render just has to keep both dots on that one node.
  assert.ok(
    physicalInterval("jp-東日本旅客鉄道-東北新幹線", "上野", "東京").some(
      ([lon, lat]) => lon === 139.7678569 && lat === 35.6816523,
    ),
  );
  assert.ok(
    physicalInterval("jp-東海旅客鉄道-東海道新幹線", "品川", "東京").some(
      ([lon, lat]) => lon === 139.7677665 && lat === 35.6801443,
    ),
  );

  // N02 files the south half of the 総武快速/横須賀 tunnel under 東海道線.
  // Its 品鶴 stroke must therefore start at the SAME underground Tokyo dot,
  // then follow the underground 新橋・品川 platforms before 西大井.
  const southContinuation = pkg.lines.find((candidate) =>
    candidate.id.startsWith("jp-東日本旅客鉄道-総武線-") &&
    candidate.stations.slice(0, 4).map((station) => station[1]).join("/") ===
      "東京/新橋/品川/西大井",
  );
  assert.ok(southContinuation, "missing the underground south continuation");
  assert.equal(southContinuation.color, sobuLine.color);
  assert.deepEqual(
    [southContinuation.stations[0][2], southContinuation.stations[0][3]],
    sobu,
  );
  const southIntervals = decodedIntervals(southContinuation);
  assert.deepEqual(southIntervals[0][0], sobu);
  assert.ok(
    southIntervals[0].at(-1)[1] < sobu[1],
    "the continuation must leave 東京 southbound",
  );
  assert.deepEqual(southIntervals[0].at(-1), [
    southContinuation.stations[1][2],
    southContinuation.stations[1][3],
  ]);
});

test("Japanese tunnel and bridge measures remain valid after branch splitting", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  let rows = 0;
  for (const line of pkg.lines) {
    const totalMeters = line.segments.reduce(
      (sum, segment) => sum + segment[0] * 1000,
      0,
    );
    for (const structure of line.structure || []) {
      rows += 1;
      assert.ok(structure[0] >= 0, `${line.id} structure begins before its line`);
      assert.ok(structure[1] > structure[0], `${line.id} has an empty structure interval`);
      assert.ok(
        structure[1] <= totalMeters + 1,
        `${line.id} structure ends beyond its line`,
      );
      assert.ok(structure[2] === 1 || structure[2] === 2);
    }
  }
  assert.ok(rows > 16000, `only ${rows} structure intervals survived`);
});

test("Japan renders one complete feature per line, never one per station interval", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const ids = network.segments.features.map(
    (feature) => feature.properties.lineId,
  );

  // Every line is drawn, and nothing is drawn that is not a line. A line that
  // shares a corridor with an INDEPENDENT railway carries one extra feature
  // per lane it takes (rail-network.js splitPartByLanes) — still its own
  // lineId, still one railway — so the count is per line PLUS the lane table,
  // never per station interval.
  assert.equal(new Set(ids).size, pkg.lines.length);
  assert.ok(network.segments.features.length >= pkg.lines.length);
  // One feature per (line, lane VALUE). A line that takes one lane adds four:
  // the lane itself and the three quarter-steps that ease it in and out. Two
  // stretches at the same lane share all four.
  const lanedPairs = new Set(
    (pkg.lanes || []).map((row) => `${row[0]}\u0000${row[4]}`),
  );
  assert.ok(
    network.segments.features.length <= pkg.lines.length + 4 * lanedPairs.size,
    `${network.segments.features.length} features for ${pkg.lines.length} lines and ${lanedPairs.size} laned pairs`,
  );
  // Exactly one render feature per package line: a railway is drawn on its
  // own surveyed geometry, never split into a feature per screen offset.
  for (const line of pkg.lines) {
    assert.equal(
      network.segments.features.filter(
        (feature) => feature.properties.lineId === line.id,
      ).length,
      1,
      `${line.id} emits more than one feature`,
    );
  }
  // Lines that carry a branch under one id — a TOPOLOGY property, so it is
  // counted from the strokes.
  const multiPart = [...network.lineById.values()].filter(
    (line) => line.parts.length > 1,
  ).length;
  for (const feature of network.segments.features) {
    const parts =
      feature.geometry.type === "MultiLineString"
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];
    // One feature per line, but a line that carries a branch renders as
    // several DISJOINT strokes so nothing can draw through the junction.
    assert.ok(parts.length >= 1);
    assert.equal(parts.length, feature.properties.partCount);

    for (const part of parts) assert.ok(part.length >= 2);
    assert.ok(feature.properties.strokeCount >= 1);
    assert.ok(feature.properties.intervalCount >= 1);
    assert.equal(feature.properties.segmentId, undefined);
  }
  // Only the handful of package lines that carry a branch under one id.
  assert.ok(multiPart > 0 && multiPart < 100, `multi-part lines: ${multiPart}`);

  // The split is TOPOLOGICAL and per-corridor, never per-hop. A stroke with k
  // lane stretches yields at most k×8 + 1 pieces: each stretch is a gap, three
  // quarter-steps easing in, the full lane, three easing out
  // (rail-network.js RAMP_STEPS), and a final gap closes the stroke. Anything
  // above that means the renderer started cutting the line for some other
  // reason.
  const laneRowsPerLine = new Map();
  for (const row of pkg.lanes || [])
    laneRowsPerLine.set(row[0], (laneRowsPerLine.get(row[0]) || 0) + 1);
  const piecesPerLine = new Map();
  for (const feature of network.segments.features) {
    const parts =
      feature.geometry.type === "MultiLineString"
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];
    const id = feature.properties.lineId;
    piecesPerLine.set(id, (piecesPerLine.get(id) || 0) + parts.length);
  }
  for (const line of pkg.lines) {
    const strokes = network.lineById.get(line.id).parts.length;
    const ceiling = strokes + 8 * (laneRowsPerLine.get(line.id) || 0);
    assert.ok(
      piecesPerLine.get(line.id) <= ceiling,
      `${line.id}: ${piecesPerLine.get(line.id)} drawn pieces for ${strokes} strokes and ${laneRowsPerLine.get(line.id) || 0} lanes`,
    );
  }
});

test("every display part begins and ends on one of its line's stations", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);

  const metres = (a, b) => {
    const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
    return Math.hypot(
      (a[0] - b[0]) * 111320 * Math.cos(lat),
      (a[1] - b[1]) * 111320,
    );
  };

  for (const line of pkg.lines) {
    const stations = line.stations.map((station) => [station[2], station[3]]);
    // TOPOLOGY parts, not the render features. Lane splitting cuts the drawn
    // geometry at corridor boundaries, which is exactly the render/topology
    // separation: what a route is sliced from, and what has to start and end
    // on a platform, is this list.
    const parts = network.lineById.get(line.id).parts;
    for (const part of parts) {
      // A branch only truly merges at a STATION — it is led in over the
      // trunk's own coordinates from the platform to the switch — and a line
      // that ends at a terminus stops on that terminus. So no part may begin
      // or end loose on open track.
      for (const endpoint of [part[0], part[part.length - 1]]) {
        const nearest = Math.min(
          ...stations.map((station) => metres(station, endpoint)),
        );
        assert.ok(
          nearest <= 1,
          `${line.id} has a part endpoint ${Math.round(nearest)} m from any station`,
        );
      }
    }
  }
});

test("no Japanese display line draws back over track it already laid", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);

  const metres = (a, b) => {
    const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
    return Math.hypot(
      (a[0] - b[0]) * 111320 * Math.cos(lat),
      (a[1] - b[1]) * 111320,
    );
  };

  for (const feature of network.segments.features) {
    const parts =
      feature.geometry.type === "MultiLineString"
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];
    for (const part of parts) {
      // A retrace shows up as an about-face: two consecutive edges pointing
      // back along each other. Only kilometre-scale ones are the bug — a real
      // switchback station (二本木 on the 妙高はねうまライン) is a genuine
      // hundred-metre stub that the map should keep drawing.
      for (let index = 1; index < part.length - 1; index += 1) {
        const back = metres(part[index - 1], part[index]);
        const forward = metres(part[index], part[index + 1]);
        if (back < 1000 || forward < 1000) continue;
        const closing = metres(part[index - 1], part[index + 1]);
        assert.ok(
          closing > Math.min(back, forward) * 0.5,
          `${feature.properties.lineId} doubles back at vertex ${index}`,
        );
      }
    }
  }
});

test("official Japanese branch endpoints omitted by the old package are restored", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const stationNames = (operator, name) =>
    new Set(
      pkg.lines
        .filter((line) => line.operator === operator && line.name === name)
        .flatMap((line) => line.stations.map((station) => station[1])),
    );
  const narita = stationNames("東日本旅客鉄道", "成田線");
  const nemuro = stationNames("北海道旅客鉄道", "根室線");

  for (const name of ["空港第2ビル", "成田空港"])
    assert.ok(narita.has(name), `Narita branch is missing ${name}`);
  for (const name of ["滝川", "芦別", "富良野"])
    assert.ok(nemuro.has(name), `Nemuro western component is missing ${name}`);
});
