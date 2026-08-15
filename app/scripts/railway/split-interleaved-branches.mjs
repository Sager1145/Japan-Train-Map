// Pull branches out of trunk station orders that interleave them.
//
// Some package lines store a trunk AND a branch under one id, with the branch
// spliced into the middle of the trunk's station list:
//
//   函館線  … 赤井川 駒ヶ岳 [東森 尾白内 掛澗 渡島砂原 渡島沼尻 鹿部] 森 石倉 …
//   中央線  … 下諏訪 岡谷 [川岸 辰野 信濃川島 小野] 塩尻 みどり湖
//
// Both are wrong in the same way. The trunk's own segment across the junction
// is missing (函館線 has no 駒ヶ岳 → 森, 中央線 no 岡谷 → みどり湖), so the map
// reaches the far side by running down the branch and back; the branch is
// drawn in disconnected pieces; and any ride recorded by walking the order
// inherits the detour — 北斗21, a main-line train, was stored as
// 駒ヶ岳 → 東森 → 森, doubling back to a 砂原支線 station it never sees.
//
// For each case: give the trunk's corrected station window and the branch's
// own running order. Everything outside the window keeps its EXACT original
// interval row — the surveyed geometry in the package beats anything derived
// here. Only the pairs that genuinely change are rebuilt, reusing an original
// interval (either direction) when the pair already existed, otherwise the
// shortest path between the two stations in N02 rail-sections.json.
//
// Optional per case:
//   branchOnly  which stations leave the trunk, when it is not simply the
//               inside of branchOrder — a branch that DEAD-ENDS takes its last
//               station with it (南武線's 浜川崎), while a branch that rejoins
//               leaves both endpoints on the trunk (函館線's 森 and 大沼).
//   graphLines  extra N02 line names to path through, for a branch joined to
//               its other half by a different line (予讃線's two 新線 halves
//               are joined by the separate 内子線).
//   rebuild     station pairs whose ORIGINAL interval is itself wrong and has
//               to be re-pathed instead of reused.
//
// Idempotent: a line already in its corrected shape is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..', '..');
const REPO_DIR = path.resolve(APP_DIR, '..');
const PACKAGE_PATH = path.join(APP_DIR, 'public', 'rail', 'jp-2025.json');
const SECTIONS_PATH = path.join(APP_DIR, 'data', 'rail-sections.json');
const PACKAGE_VERSION = '2025.3.3';

const CASES = [
  {
    // 砂原支線. The main line runs 駒ヶ岳 → 森 直行; 東森 … 鹿部 are branch
    // stations (隣の駅: 尾白内 – 東森 – 森). 池田園 and 銚子口 have no row in
    // data/stations.json, so 鹿部 → 大沼 stays one interval without them.
    trunkId: 'jp-北海道旅客鉄道-函館線',
    branchId: 'jp-北海道旅客鉄道-函館線-2',
    trunkWindow: ['駒ヶ岳', '森'],
    branchOrder: ['森', '東森', '尾白内', '掛澗', '渡島砂原', '渡島沼尻', '鹿部', '大沼'],
  },
  {
    // 辰野支線 (旧線). Since the 塩嶺トンネル opened the main line has run
    // 岡谷 → みどり湖 → 塩尻; 川岸・辰野・信濃川島・小野 are the old route.
    // The package had みどり湖 stranded AFTER 塩尻, at the very end of the line.
    trunkId: 'jp-東日本旅客鉄道-中央線',
    branchId: 'jp-東日本旅客鉄道-中央線-2',
    trunkWindow: ['岡谷', 'みどり湖', '塩尻'],
    branchOrder: ['岡谷', '川岸', '辰野', '信濃川島', '小野', '塩尻'],
  },
  {
    // 南武支線 (浜川崎支線). Leaves the main line at 尻手 and dead-ends at
    // 浜川崎. The package spliced all four of its stations between 尻手 and
    // 川崎, so the main line had no 尻手 → 川崎 of its own and the branch was
    // drawn from 川崎, one station PAST its junction.
    trunkId: 'jp-東日本旅客鉄道-南武線',
    branchId: 'jp-東日本旅客鉄道-南武線-2',
    trunkWindow: ['尻手', '川崎'],
    branchOrder: ['尻手', '八丁畷', '川崎新町', '小田栄', '浜川崎'],
    branchOnly: ['八丁畷', '川崎新町', '小田栄', '浜川崎'],
  },
  {
    // 東武小泉線 has two services meeting at 東小泉. The package interleaved
    // the 太田 branch between 小泉町 and 西小泉, which made the final interval
    // run 太田 → 東小泉 → 西小泉 and double back at the junction. Keep the
    // 館林—西小泉 route as the trunk and make 東小泉—太田 its own branch.
    trunkId: 'jp-東武鉄道-小泉線',
    branchId: 'jp-東武鉄道-小泉線-2',
    trunkWindow: ['東小泉', '小泉町', '西小泉'],
    branchOrder: ['東小泉', '竜舞', '太田'],
    branchOnly: ['竜舞', '太田'],
  },
  {
    // 常陸太田支線. Branches at 上菅谷, dead-ends at 常陸太田. The package put
    // 南酒出 between 上菅谷 and 常陸鴻巣 on the main line and stranded the other
    // four branch stations at the very END of the list, after 安積永盛 — 100 km
    // from their junction.
    trunkId: 'jp-東日本旅客鉄道-水郡線',
    branchId: 'jp-東日本旅客鉄道-水郡線-2',
    trunkWindow: ['上菅谷', '常陸鴻巣'],
    branchOrder: ['上菅谷', '南酒出', '額田', '河合', '谷河原', '常陸太田'],
    branchOnly: ['南酒出', '額田', '河合', '谷河原', '常陸太田'],
  },
  {
    // 総武本線 has TWO routes into Tokyo out of 錦糸町: the 本線 runs
    // underground to 東京 (4.8 km, 新日本橋・馬喰町) and the 支線 surfaces at
    // 御茶ノ水 (4.3 km, 両国・浅草橋・秋葉原). The package zipped them into one
    // alternating list — 両国 浅草橋 馬喰町 秋葉原 新日本橋 御茶ノ水 東京 — so
    // neither route existed and the line drew as five disconnected stubs.
    trunkId: 'jp-東日本旅客鉄道-総武線',
    branchId: 'jp-東日本旅客鉄道-総武線-2',
    trunkWindow: ['錦糸町', '馬喰町', '新日本橋', '東京'],
    branchOrder: ['錦糸町', '両国', '浅草橋', '秋葉原', '御茶ノ水'],
    branchOnly: ['両国', '浅草橋', '秋葉原', '御茶ノ水'],
  },
  {
    // 予讃線 新線. 営業キロ follows the coast via 伊予長浜; the fast inland
    // route is two 予讃線 支線 sections (向井原–内子 23.5 km, 新谷–伊予大洲
    // 5.9 km) joined by the separate 内子線 (内子–新谷 5.3 km). The package
    // appended the five inland stations AFTER 高松, the far end of the line,
    // which bought a 211 km 高松 → 伊予大平 "interval" retracing the whole main
    // line, and a 内子 → 新谷 that went 64 km the long way round because 内子線
    // is not part of the 予讃線 N02 group.
    trunkId: 'jp-四国旅客鉄道-予讃線',
    branchId: 'jp-四国旅客鉄道-予讃線-2',
    trunkWindow: ['高松'],
    branchOrder: ['向井原', '伊予大平', '伊予中山', '伊予立川', '内子', '新谷', '伊予大洲'],
    branchOnly: ['伊予大平', '伊予中山', '伊予立川', '内子', '新谷'],
    graphLines: ['予讃線', '内子線'],
    rebuild: [['内子', '新谷']],
  },
];

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
function metres(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const nodeKey = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
const round5 = (c) => [Number(c[0].toFixed(5)), Number(c[1].toFixed(5))];
const same = (a, b) => Boolean(a && b && a[0] === b[0] && a[1] === b[1]);

const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
const sections = JSON.parse(fs.readFileSync(SECTIONS_PATH, 'utf8'));

function buildGraph(lineNames, operator) {
  const wanted = new Set(lineNames);
  const adjacency = new Map();
  const nodePoint = new Map();
  for (const feature of sections.features) {
    const p = feature.properties || {};
    if (!wanted.has(p.N02_003) || p.N02_004 !== operator) continue;
    const parts =
      feature.geometry.type === 'MultiLineString'
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];
    for (const coordinates of parts) {
      if (coordinates.length < 2) continue;
      let length = 0;
      for (let i = 1; i < coordinates.length; i += 1)
        length += metres(coordinates[i - 1], coordinates[i]);
      const a = nodeKey(coordinates[0]);
      const b = nodeKey(coordinates[coordinates.length - 1]);
      nodePoint.set(a, coordinates[0]);
      nodePoint.set(b, coordinates[coordinates.length - 1]);
      if (!adjacency.has(a)) adjacency.set(a, []);
      if (!adjacency.has(b)) adjacency.set(b, []);
      adjacency.get(a).push({ to: b, length, coordinates });
      adjacency.get(b).push({ to: a, length, coordinates: [...coordinates].reverse() });
    }
  }
  return { adjacency, nodePoint };
}

function shortestPath(graph, fromPoint, toPoint) {
  const nearest = (target) => {
    let best = null;
    let bestDistance = Infinity;
    for (const [k, coordinate] of graph.nodePoint) {
      const distance = metres(coordinate, target);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
      }
    }
    return best;
  };
  const start = nearest(fromPoint);
  const goal = nearest(toPoint);
  const best = new Map([[start, 0]]);
  const cameFrom = new Map();
  const queue = [[0, start]];
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [cost, node] = queue.shift();
    if (cost > (best.get(node) ?? Infinity)) continue;
    if (node === goal) break;
    for (const edge of graph.adjacency.get(node) || []) {
      const next = cost + edge.length;
      if (next < (best.get(edge.to) ?? Infinity)) {
        best.set(edge.to, next);
        cameFrom.set(edge.to, { from: node, edge });
        queue.push([next, edge.to]);
      }
    }
  }
  if (start !== goal && !cameFrom.has(goal))
    throw new Error('no N02 path between two stations of the same line');
  const chain = [];
  for (let node = goal; node !== start; ) {
    const step = cameFrom.get(node);
    chain.unshift(step.edge.coordinates);
    node = step.from;
  }
  const coordinates = [];
  for (const piece of chain)
    for (const c of piece) {
      const r = round5(c);
      if (!same(coordinates[coordinates.length - 1], r)) coordinates.push(r);
    }
  // Begin and end ON the platform anchor. Append rather than overwrite: the
  // anchor can sit ~170 m off the through track, and replacing the first/last
  // track vertex with it would delete the very node the neighbouring interval
  // leaves from, turning the join into a V the renderer reads as a reversal.
  if (!same(coordinates[0], fromPoint)) coordinates.unshift([fromPoint[0], fromPoint[1]]);
  if (!same(coordinates[coordinates.length - 1], toPoint))
    coordinates.push([toPoint[0], toPoint[1]]);
  return trimFold(trimFold(coordinates).reverse()).reverse();
}

// Drop a lead-in that runs backwards past its own platform.
//
// The graph's nodes are N02 section ENDPOINTS, so a station partway along a
// section starts the path at that section's FAR end: 総武本線's 地下線 is one
// section from the ramp east of 錦糸町 all the way to 東京, so "錦糸町 →
// 馬喰町" came out as 300 m east up the ramp, back through the platform, then
// west. That is a true 180° reversal at the joint, which the renderer answers
// by breaking the line there — the 総武線 trunk drew as four stubs.
//
// Keep the anchor, then resume at the furthest early vertex that is still at
// the station yet cost several times its own chord to reach.
const FOLD_LOOK_METERS = 1500;
const FOLD_RETURN_METERS = 250;
const FOLD_RATIO = 2;

function trimFold(coordinates) {
  let travelled = 0;
  let folded = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    travelled += metres(coordinates[i - 1], coordinates[i]);
    if (travelled > FOLD_LOOK_METERS) break;
    const chord = metres(coordinates[0], coordinates[i]);
    if (chord <= FOLD_RETURN_METERS && travelled >= FOLD_RATIO * Math.max(chord, 1))
      folded = i;
  }
  return folded > 0 ? [coordinates[0], ...coordinates.slice(folded)] : coordinates;
}

function decodeIntervals(line) {
  const out = [];
  let previousEnd = null;
  line.segments.forEach((row, index) => {
    const coordinates = row[1]
      ? [previousEnd].concat(row[2].map((c) => [c[0], c[1]]))
      : row[2].map((c) => [c[0], c[1]]);
    const next = (index + 1) % line.stations.length;
    coordinates[0] = [line.stations[index][2], line.stations[index][3]];
    coordinates[coordinates.length - 1] = [
      line.stations[next][2],
      line.stations[next][3],
    ];
    previousEnd = coordinates[coordinates.length - 1];
    out.push(coordinates);
  });
  return out;
}

function encodeRow(coordinates, shared) {
  let km = 0;
  for (let i = 1; i < coordinates.length; i += 1)
    km += metres(coordinates[i - 1], coordinates[i]) / 1000;
  return [Number(km.toFixed(3)), shared ? 1 : 0, shared ? coordinates.slice(1) : coordinates];
}

let changed = 0;
const branchStationCodes = new Set();
const TOPOLOGY_FIELDS = new Set(["id", "logo", "stations", "segments", "structure"]);

function inheritLineMetadata(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (TOPOLOGY_FIELDS.has(key) || key in target) continue;
    target[key] = value;
  }
}

function structureIndexFor(line, names) {
  const out = new Map();
  let segmentStart = 0;
  for (let index = 0; index < line.segments.length; index += 1) {
    const from = names[index];
    const to = names[(index + 1) % names.length];
    const lengthMeters = line.segments[index][0] * 1000;
    const segmentEnd = segmentStart + lengthMeters;
    const rows = (line.structure || [])
      .filter((row) => Number(row[0]) < segmentEnd && Number(row[1]) > segmentStart)
      .map((row) => [
        Math.max(0, Math.round(Number(row[0]) - segmentStart)),
        Math.min(Math.round(lengthMeters), Math.round(Number(row[1]) - segmentStart)),
        ...row.slice(2),
      ])
      .filter((row) => row[1] > row[0]);
    out.set(`${from}\u0000${to}`, rows);
    out.set(
      `${to}\u0000${from}`,
      rows.map((row) => [
        Math.max(0, Math.round(lengthMeters - Number(row[1]))),
        Math.max(0, Math.round(lengthMeters - Number(row[0]))),
        ...row.slice(2),
      ]),
    );
    segmentStart = segmentEnd;
  }
  return out;
}

function remapStructure(index, stationNames, segments) {
  const rows = [];
  let segmentStart = 0;
  for (let segmentIndex = 0; segmentIndex < stationNames.length - 1; segmentIndex += 1) {
    const key = `${stationNames[segmentIndex]}\u0000${stationNames[segmentIndex + 1]}`;
    for (const row of index.get(key) || [])
      rows.push([
        Math.round(segmentStart + Number(row[0])),
        Math.round(segmentStart + Number(row[1])),
        ...row.slice(2),
      ]);
    segmentStart += segments[segmentIndex][0] * 1000;
  }
  return rows;
}

for (const plan of CASES) {
  const trunk = pkg.lines.find((line) => line.id === plan.trunkId);
  if (!trunk) throw new Error(`${plan.trunkId} missing`);
  const names = trunk.stations.map((row) => row[1]);
  const oldStructure = structureIndexFor(trunk, names);
  // A branch runs BETWEEN two junction stations; those two stay on the trunk
  // (函館線's 森 and 大沼, 中央線's 岡谷 and 塩尻). Everything strictly inside
  // the branch order is what has to leave the trunk's station list.
  const branchOnly = plan.branchOnly || plan.branchOrder.slice(1, -1);
  if (!branchOnly.some((n) => names.includes(n))) {
    const branch = pkg.lines.find((line) => line.id === plan.branchId);
    if (!branch) throw new Error(`${plan.branchId} missing after split`);
    const before = JSON.stringify(branch);
    delete branch.logo;
    inheritLineMetadata(branch, trunk);
    if (JSON.stringify(branch) !== before) changed += 1;
    console.log(`${plan.trunkId}: already split`);
    continue;
  }

  // Only the window itself plus the branch-only stations: a branch endpoint
  // that is a trunk station OUTSIDE the window (函館線's 大沼) stays put.
  const affected = new Set([...plan.trunkWindow, ...branchOnly]);
  // A branch dumped at the very END of the trunk's list (水郡線's 額田 …
  // 常陸太田 sit after 安積永盛, 100 km from their junction; 予讃線's inland
  // stations sit after 高松, the far end of the line) is pure truncation:
  // those stations and the intervals reaching them simply go, and nothing
  // after them needs re-welding. Everything else has to be ONE contiguous
  // block — the only shape whose intervals can be rebuilt without disturbing
  // the rest of the line.
  const branchOnlySet = new Set(branchOnly);
  let tailStart = names.length;
  while (tailStart > 0 && branchOnlySet.has(names[tailStart - 1])) tailStart -= 1;
  const indices = names
    .map((n, i) => (affected.has(n) && i < tailStart ? i : -1))
    .filter((i) => i >= 0);
  const lo = Math.min(...indices);
  const hi = Math.max(...indices);
  if (hi - lo + 1 !== indices.length)
    throw new Error(`${plan.trunkId}: affected stations are not one contiguous block`);
  if (names[lo] !== plan.trunkWindow[0])
    throw new Error(`${plan.trunkId}: window must start at ${plan.trunkWindow[0]}`);
  // Intervals from `hi` onward are kept verbatim, so the corrected window has
  // to hand over at exactly that station — unless the block runs to the end of
  // what survives, in which case there is nothing after it to hand over to.
  const windowLast = plan.trunkWindow[plan.trunkWindow.length - 1];
  if (names[hi] !== windowLast && hi !== tailStart - 1)
    throw new Error(`${plan.trunkId}: window must hand over at ${names[hi]}`);

  const rowByName = new Map(trunk.stations.map((row) => [row[1], row]));
  const original = new Map();
  decodeIntervals(trunk).forEach((coordinates, index) => {
    const from = names[index];
    const to = names[(index + 1) % names.length];
    original.set(`${from}\u0000${to}`, coordinates);
    original.set(`${to}\u0000${from}`, [...coordinates].reverse());
  });
  const graph = buildGraph(plan.graphLines || [trunk.name], trunk.operator);
  const rebuild = new Set(
    (plan.rebuild || []).flatMap(([a, b]) => [
      `${a}\u0000${b}`,
      `${b}\u0000${a}`,
    ]),
  );
  const intervalFor = (from, to) => {
    const key = `${from}\u0000${to}`;
    const reused = rebuild.has(key) ? null : original.get(key);
    if (reused) return reused.map((c) => [c[0], c[1]]);
    const a = rowByName.get(from);
    const b = rowByName.get(to);
    return shortestPath(graph, [a[2], a[3]], [b[2], b[3]]);
  };

  // ── trunk ──
  const windowRows = plan.trunkWindow.map((n) => [...rowByName.get(n)]);
  const windowIntervals = plan.trunkWindow
    .slice(0, -1)
    .map((from, i) => intervalFor(from, plan.trunkWindow[i + 1]));
  const keptBefore = trunk.segments.slice(0, lo);
  const keptAfter = trunk.segments.slice(hi, tailStart - 1);
  trunk.stations = [
    ...trunk.stations.slice(0, lo),
    ...windowRows,
    ...trunk.stations.slice(hi + 1, tailStart),
  ];
  trunk.segments = [
    ...keptBefore,
    ...windowIntervals.map((coordinates, i) => encodeRow(coordinates, lo + i > 0)),
    ...keptAfter,
  ];
  const trunkStructure = remapStructure(
    oldStructure,
    trunk.stations.map((row) => row[1]),
    trunk.segments,
  );
  if (trunkStructure.length) trunk.structure = trunkStructure;
  else delete trunk.structure;

  // ── branch ──
  const branch = {
    id: plan.branchId,
    name: trunk.name,
    operator: trunk.operator,
    rank: trunk.rank,
    color: trunk.color,
    stations: plan.branchOrder.map((n) => [...rowByName.get(n)]),
    segments: plan.branchOrder
      .slice(0, -1)
      .map((from, i) => encodeRow(intervalFor(from, plan.branchOrder[i + 1]), i > 0)),
  };
  inheritLineMetadata(branch, trunk);
  const branchStructure = remapStructure(oldStructure, plan.branchOrder, branch.segments);
  if (branchStructure.length) branch.structure = branchStructure;
  const existing = pkg.lines.findIndex((line) => line.id === plan.branchId);
  if (existing >= 0) pkg.lines[existing] = branch;
  else pkg.lines.splice(pkg.lines.indexOf(trunk) + 1, 0, branch);

  for (const name of branchOnly) branchStationCodes.add(rowByName.get(name)[0]);
  const km = (line) => line.segments.reduce((sum, row) => sum + row[0], 0);
  console.log(
    `${plan.trunkId}\n  trunk  ${trunk.stations.length} stations ${km(trunk).toFixed(2)} km` +
      `\n  branch ${branch.stations.length} stations ${km(branch).toFixed(2)} km  (${plan.branchOrder.join(' → ')})`,
  );
  changed += 1;
}

if (changed) {
  pkg.version = PACKAGE_VERSION;
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg)}\n`);
  console.log(`package: ${pkg.lines.length} lines, version ${pkg.version}`);
}

// Any ride recorded by walking the old order inherited the detour. Strip
// branch stations a train merely PASSED; a train that actually calls at one
// really did ride the branch and is left alone.
const storeFiles = [
  path.join(APP_DIR, 'data', 'train-store.json'),
  ...fs
    .readdirSync(path.join(REPO_DIR, 'samples'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(REPO_DIR, 'samples', name)),
].filter((file) => fs.existsSync(file));
for (const file of storeFiles) {
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  const trains = Array.isArray(store) ? store : store.trains;
  if (!Array.isArray(trains)) continue;
  let touched = false;
  for (const train of trains) {
    const stops = train.stops || [];
    const offenders = stops.filter((s) => branchStationCodes.has(s.n02_station_code));
    if (!offenders.length) continue;
    if (offenders.some((s) => s.stop_type !== 'pass_through')) {
      console.log(`  ${train.id} calls at a branch station — left alone`);
      continue;
    }
    const dropped = offenders.map((s) => s.name).join(', ');
    train.stops = stops.filter((s) => !branchStationCodes.has(s.n02_station_code));
    // Splice the station out of the section chain and weld its two neighbours
    // into one hop, keeping that hop's own line and operator. Rebuilding every
    // section from one template would flatten a multi-line run — 北斗21 spans
    // 函館線, 室蘭線 and 千歳線 — onto whichever line came first.
    const sections = [];
    for (const section of train.route_sections || []) {
      const previous = sections[sections.length - 1];
      if (branchStationCodes.has(section.from_n02_station_code)) {
        if (previous) previous.to_n02_station_code = section.to_n02_station_code;
        else sections.push({ ...section });
        continue;
      }
      if (branchStationCodes.has(section.to_n02_station_code)) {
        sections.push({ ...section });
        continue;
      }
      sections.push({ ...section });
    }
    train.route_sections = sections.filter(
      (section) =>
        section.from_n02_station_code !== section.to_n02_station_code &&
        !branchStationCodes.has(section.from_n02_station_code) &&
        !branchStationCodes.has(section.to_n02_station_code),
    );
    touched = true;
    console.log(`  ${train.id}: dropped branch pass-through(s) ${dropped}`);
  }
  if (touched) {
    fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
    console.log(`  updated ${path.relative(REPO_DIR, file)}`);
  }
}
