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
// Idempotent: a line already in its corrected shape is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..');
const REPO_DIR = path.resolve(APP_DIR, '..');
const PACKAGE_PATH = path.join(APP_DIR, 'public', 'rail', 'jp-2025.json');
const SECTIONS_PATH = path.join(APP_DIR, 'data', 'rail-sections.json');
const PACKAGE_VERSION = '2025.3.2';

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

function buildGraph(lineName, operator) {
  const adjacency = new Map();
  const nodePoint = new Map();
  for (const feature of sections.features) {
    const p = feature.properties || {};
    if (p.N02_003 !== lineName || p.N02_004 !== operator) continue;
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
  return coordinates;
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
for (const plan of CASES) {
  const trunk = pkg.lines.find((line) => line.id === plan.trunkId);
  if (!trunk) throw new Error(`${plan.trunkId} missing`);
  const names = trunk.stations.map((row) => row[1]);
  // A branch runs BETWEEN two junction stations; those two stay on the trunk
  // (函館線's 森 and 大沼, 中央線's 岡谷 and 塩尻). Everything strictly inside
  // the branch order is what has to leave the trunk's station list.
  const branchOnly = plan.branchOrder.slice(1, -1);
  if (!branchOnly.some((n) => names.includes(n))) {
    console.log(`${plan.trunkId}: already split`);
    continue;
  }

  // Only the window itself plus the branch-only stations: a branch endpoint
  // that is a trunk station OUTSIDE the window (函館線's 大沼) stays put.
  const affected = new Set([...plan.trunkWindow, ...branchOnly]);
  const indices = names
    .map((n, i) => (affected.has(n) ? i : -1))
    .filter((i) => i >= 0);
  const lo = Math.min(...indices);
  const hi = Math.max(...indices);
  if (hi - lo + 1 !== indices.length)
    throw new Error(`${plan.trunkId}: affected stations are not one contiguous block`);
  if (names[lo] !== plan.trunkWindow[0])
    throw new Error(`${plan.trunkId}: window must start at ${plan.trunkWindow[0]}`);
  // Intervals from `hi` onward are kept verbatim, so the corrected window has
  // to hand over at exactly that station — unless the block runs to the end of
  // the line, in which case there is nothing after it to hand over to.
  const windowLast = plan.trunkWindow[plan.trunkWindow.length - 1];
  if (names[hi] !== windowLast && hi !== names.length - 1)
    throw new Error(`${plan.trunkId}: window must hand over at ${names[hi]}`);

  const rowByName = new Map(trunk.stations.map((row) => [row[1], row]));
  const original = new Map();
  decodeIntervals(trunk).forEach((coordinates, index) => {
    const from = names[index];
    const to = names[(index + 1) % names.length];
    original.set(`${from} ${to}`, coordinates);
    original.set(`${to} ${from}`, [...coordinates].reverse());
  });
  const graph = buildGraph(trunk.name, trunk.operator);
  const intervalFor = (from, to) => {
    const reused = original.get(`${from} ${to}`);
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
  const keptAfter = trunk.segments.slice(hi);
  trunk.stations = [...trunk.stations.slice(0, lo), ...windowRows, ...trunk.stations.slice(hi + 1)];
  trunk.segments = [
    ...keptBefore,
    ...windowIntervals.map((coordinates, i) => encodeRow(coordinates, lo + i > 0)),
    ...keptAfter,
  ];

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
