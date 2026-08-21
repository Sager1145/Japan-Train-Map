// Give 埼京線 its own line, and its own 大宮 platform.
//
// N02 files 埼京線 under 東北線 — it IS 東北本線's 別線, 大宮 to 赤羽 — and the
// package inherited that as ONE station order with the branch welded to the
// front of the trunk:
//
//   [北与野 与野本町 … 北赤羽] 赤羽 川口 … さいたま新都心 大宮 土呂 … 盛岡
//    ~~~~~~ 埼京線 ~~~~~~~~~~        ~~~~~~~~~~ 東北本線 ~~~~~~~~~~~~~~~~
//
// Two things are wrong with that. The branch has no 大宮 — its order starts at
// 北与野, so the 1.7 km it actually runs from 大宮 is simply absent, even though
// N02 surveys it (the 3-vertex west platform, then one 27-vertex section down
// to 北与野). And 大宮 appears once, anchored on the 宇都宮線 platforms, because
// compact-v1 stores one row per station per line and a line can only have one.
//
// So a ride on 埼京線 had nowhere right to be drawn. canonicalizeRouteFeature
// projected 北与野 to 大宮 onto the only 東北線 part that holds 大宮 — the main
// line, 100 m east — and snapEndpoint then bridged the difference with a
// straight chord: the drawn 埼京線 came up the 宇都宮線, turned 73 degrees and
// ran due west into a platform on the far side of the station. That elbow is
// what a user sees; the missing branch link is what causes it.
//
// The fix is the split the other six interleaved branches already had
// (split-interleaved-branches.mjs), plus the one thing none of them needed: the
// junction station comes across with its OWN anchor. 埼京線 and 川越線 share
// 大宮 19・20番線 on the west side of the station, and N02 carries that platform
// as its own 東北線 feature, so the branch's 大宮 anchors on the same coordinate
// 川越線 already uses and the two through-services meet at one marker — while
// 宇都宮線・高崎線・京浜東北線 keep their own marker on the eastern platforms.
//
// The trunk keeps 赤羽 (it runs through it, and 東北線-2 already starts there);
// 北与野 to 北赤羽 leave. Every interval outside the change is kept BYTE FOR
// BYTE — the surveyed geometry in the package beats anything derived here — and
// the one new interval, 大宮 to 北与野, is assembled vertex for vertex out of
// N02 rail sections, halting rather than guessing if any of them has moved.
//
// Idempotent: a package already carrying the branch is reported and skipped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const PACKAGE_PATH = path.join(APP_DIR, "public", "rail", "jp-2025.json");
const SECTIONS_PATH = path.join(APP_DIR, "data", "rail-sections.json");

const TRUNK_ID = "jp-東日本旅客鉄道-東北線";
const BRANCH_ID = "jp-東日本旅客鉄道-東北線-5";
// Everything at the front of the trunk's order that is 埼京線 and only 埼京線.
// 赤羽 is the junction and stays on both.
const BRANCH_ONLY = [
  "北与野",
  "与野本町",
  "南与野",
  "中浦和",
  "武蔵浦和",
  "北戸田",
  "戸田",
  "戸田公園",
  "浮間舟渡",
  "北赤羽",
];

// 大宮 19・20番線, as N02 surveys it: the 東北線 platform on the WEST side of
// the station, the one 川越線 and the two 新幹線 also stand on. Anchored where
// every other line in this package anchors — the midpoint of the platform
// LineString by length — which is the coordinate 川越線 already carries.
const OMIYA_WEST_PLATFORM = [
  [139.62235, 35.90806],
  [139.62313, 35.906],
  [139.62381, 35.90445],
];
const OMIYA_WEST_ANCHOR = [139.623037, 35.906245];

// The N02 東北線 sections the 埼京線 runs on between the two, named by their
// endpoints so a re-survey that moves them stops this script instead of
// silently laying the line somewhere else.
const SAIKYO_SECTION_ENDS = [
  [
    [139.62381, 35.90445],
    [139.629, 35.89148],
  ],
  [
    [139.629, 35.89148],
    [139.62797, 35.88991],
  ],
];
// Where 北与野's platform sits on the second of those sections. The interval
// stops here; the vertices past it belong to 北与野 to 与野本町, which the
// package already carries. The anchor itself is then appended rather than
// written over that vertex — every interval in the package ends ON its
// station, and 北与野 → 与野本町 opens with exactly the same pair the other way
// round, which is the station-boundary repeat the renderer already drops.
const KITAYONO_TRACK_VERTEX = [139.62851, 35.89068];

const EARTH_RADIUS_METERS = 6371008.8;
const rad = (degrees) => (degrees * Math.PI) / 180;
function metres(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}
const same = (a, b) => Boolean(a && b && a[0] === b[0] && a[1] === b[1]);

const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
const trunk = pkg.lines.find((line) => line.id === TRUNK_ID);
if (!trunk) throw new Error(`${TRUNK_ID} missing`);

const names = trunk.stations.map((row) => row[1]);
if (!BRANCH_ONLY.some((name) => names.includes(name))) {
  console.log(`${TRUNK_ID}: already split`);
  process.exit(0);
}

// The branch must be exactly the head of the trunk's order — that is the shape
// this correction is written for, and anything else means the package has been
// reshaped since and needs looking at rather than editing.
BRANCH_ONLY.forEach((name, index) => {
  if (names[index] !== name)
    throw new Error(
      `${TRUNK_ID}: expected ${name} at index ${index}, found ${names[index]}`,
    );
});
if (names[BRANCH_ONLY.length] !== "赤羽")
  throw new Error(`${TRUNK_ID}: expected 赤羽 to follow the 埼京線 stations`);

// ── the one new interval: 大宮 to 北与野 ─────────────────────────────────────

function saikyoIntervalToKitayono(kitayonoAnchor) {
  const sections = JSON.parse(fs.readFileSync(SECTIONS_PATH, "utf8"));
  const tohoku = sections.features.filter(
    (feature) =>
      feature.properties?.N02_003 === "東北線" &&
      feature.properties?.N02_004 === "東日本旅客鉄道",
  );
  const sectionBetween = ([from, to]) => {
    const found = tohoku.find((feature) => {
      const coordinates = feature.geometry?.coordinates || [];
      return (
        same(coordinates[0], from) &&
        same(coordinates[coordinates.length - 1], to)
      );
    });
    if (!found)
      throw new Error(
        `N02 東北線 section ${JSON.stringify(from)} to ${JSON.stringify(to)} not found`,
      );
    return found.geometry.coordinates.map((c) => [c[0], c[1]]);
  };

  const platform = sectionBetween([
    OMIYA_WEST_PLATFORM[0],
    OMIYA_WEST_PLATFORM[OMIYA_WEST_PLATFORM.length - 1],
  ]);
  if (JSON.stringify(platform) !== JSON.stringify(OMIYA_WEST_PLATFORM))
    throw new Error("大宮 west platform geometry has changed in N02");

  // Start ON the anchor, then continue down the platform the way the train
  // leaves it. The anchor is the midpoint of the platform's first edge, so the
  // vertex it stands between is behind us and only the second one is ahead.
  const coordinates = [OMIYA_WEST_ANCHOR, OMIYA_WEST_PLATFORM[1]];
  const push = (point) => {
    if (!same(coordinates[coordinates.length - 1], point))
      coordinates.push([point[0], point[1]]);
  };
  for (const point of SAIKYO_SECTION_ENDS.map(sectionBetween).flat()) push(point);

  const stop = coordinates.findIndex((point) =>
    same(point, KITAYONO_TRACK_VERTEX),
  );
  if (stop < 0) throw new Error("北与野's track vertex is not on the 埼京線 chain");
  return coordinates.slice(0, stop + 1).concat([kitayonoAnchor]);
}

// ── structure spans travel with the intervals they lie on ────────────────────

function structureIndexFor(line, stationNames) {
  const index = new Map();
  let segmentStart = 0;
  for (let i = 0; i < line.segments.length; i += 1) {
    const lengthMeters = line.segments[i][0] * 1000;
    const segmentEnd = segmentStart + lengthMeters;
    const rows = (line.structure || [])
      .filter(
        (row) => Number(row[0]) < segmentEnd && Number(row[1]) > segmentStart,
      )
      .map((row) => [
        Math.max(0, Math.round(Number(row[0]) - segmentStart)),
        Math.min(
          Math.round(lengthMeters),
          Math.round(Number(row[1]) - segmentStart),
        ),
        ...row.slice(2),
      ])
      .filter((row) => row[1] > row[0]);
    index.set(`${stationNames[i]} ${stationNames[i + 1]}`, rows);
    segmentStart = segmentEnd;
  }
  return index;
}

function remapStructure(index, stationNames, segments) {
  const rows = [];
  let segmentStart = 0;
  for (let i = 0; i < stationNames.length - 1; i += 1) {
    for (const row of index.get(`${stationNames[i]} ${stationNames[i + 1]}`) ||
      [])
      rows.push([
        Math.round(segmentStart + Number(row[0])),
        Math.round(segmentStart + Number(row[1])),
        ...row.slice(2),
      ]);
    segmentStart += segments[i][0] * 1000;
  }
  return rows;
}

// ── split ───────────────────────────────────────────────────────────────────

const oldStructure = structureIndexFor(trunk, names);
const cut = BRANCH_ONLY.length; // index of 赤羽
const omiyaRow = trunk.stations[names.indexOf("大宮")];

const kitayonoRow = trunk.stations[0];
const newInterval = saikyoIntervalToKitayono([kitayonoRow[2], kitayonoRow[3]]);
let newIntervalKm = 0;
for (let i = 1; i < newInterval.length; i += 1)
  newIntervalKm += metres(newInterval[i - 1], newInterval[i]) / 1000;

const branch = {
  id: BRANCH_ID,
  name: trunk.name,
  operator: trunk.operator,
  // 大宮 comes across on its OWN platform, not the trunk's.
  stations: [
    [
      omiyaRow[0],
      omiyaRow[1],
      OMIYA_WEST_ANCHOR[0],
      OMIYA_WEST_ANCHOR[1],
      ...omiyaRow.slice(4),
    ],
    ...trunk.stations.slice(0, cut + 1).map((row) => [...row]),
  ],
  // 北与野 → 与野本町 opened the trunk and so carried its own first vertex.
  // On the branch it follows 大宮 → 北与野, and the encoding says an interval
  // after the first shares its predecessor's last point rather than repeating
  // it: drop the leading anchor and raise the shared-seam flag.
  segments: [
    [Number(newIntervalKm.toFixed(3)), 0, newInterval],
    [trunk.segments[0][0], 1, trunk.segments[0][2].slice(1)],
    ...trunk.segments.slice(1, cut).map((row) => [row[0], row[1], row[2]]),
  ],
};
// Everything that describes the RAILWAY rather than where it runs. Skipped:
// the topology fields, and alignmentPairs — the trunk's pairs name 松川・金谷川
// 200 km away and asserting them here would claim the branch has a twin bore.
for (const [key, value] of Object.entries(trunk)) {
  if (
    ["id", "stations", "segments", "structure", "alignmentPairs"].includes(key)
  )
    continue;
  if (key in branch) continue;
  branch[key] = value;
}
const branchNames = branch.stations.map((row) => row[1]);
const branchStructure = remapStructure(
  oldStructure,
  branchNames,
  branch.segments,
);
if (branchStructure.length) branch.structure = branchStructure;

// 赤羽 to 川口 opened the trunk's second interval and therefore carried no
// first vertex of its own. It is the first now, so give it the one it
// inherited: 赤羽's anchor, which decodeIntervals writes over anyway.
const akabaneAnchor = trunk.stations[cut].slice(2, 4);
const firstKept = trunk.segments[cut];
trunk.stations = trunk.stations.slice(cut);
trunk.segments = [
  [firstKept[0], 0, [[akabaneAnchor[0], akabaneAnchor[1]], ...firstKept[2]]],
  ...trunk.segments.slice(cut + 1),
];
const trunkNames = trunk.stations.map((row) => row[1]);
const trunkStructure = remapStructure(oldStructure, trunkNames, trunk.segments);
if (trunkStructure.length) trunk.structure = trunkStructure;
else delete trunk.structure;

const existing = pkg.lines.findIndex((line) => line.id === BRANCH_ID);
if (existing >= 0) pkg.lines[existing] = branch;
else pkg.lines.splice(pkg.lines.indexOf(trunk) + 1, 0, branch);

// `version` is the compact-package SCHEMA version, and this correction adds no
// field and changes no encoding — only which line some of the rows sit on.
fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg)}\n`);

const km = (line) => line.segments.reduce((sum, row) => sum + row[0], 0);
console.log(
  `${TRUNK_ID}\n` +
    `  trunk  ${trunk.stations.length} stations ${km(trunk).toFixed(2)} km  (${trunkNames[0]} to ${trunkNames[trunkNames.length - 1]})\n` +
    `  branch ${branch.stations.length} stations ${km(branch).toFixed(2)} km  (${branchNames.join(" ")})\n` +
    `  大宮 to 北与野 rebuilt from N02: ${newInterval.length} vertices, ${newIntervalKm.toFixed(3)} km\n` +
    `package: ${pkg.lines.length} lines, version ${pkg.version}`,
);
