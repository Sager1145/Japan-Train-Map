// 函館線 砂原支線, southern half: 大沼 – 鹿部.
//
// The coastal route around 駒ヶ岳 (the 砂原線) is only half in the package. Its
// northern half is present as 東森 – 尾白内 – 掛澗 – 渡島砂原 – 渡島沼尻 – 鹿部,
// but the southern half — 大沼 – 池田園 – 銚子口 – 鹿部 — is absent, because
// data/stations.json carries no 池田園 or 銚子口 entry and the package builder
// walks the station list. The TRACK is in N02 all along, so the map simply
// stopped drawing 16.8 km of the coast.
//
// This restores it as its own package line (the `-2` convention already used
// for six other split corridors), with one 大沼 → 鹿部 interval whose geometry
// is the shortest 函館線 path between those two stations in N02 — which is the
// coastal route, the main line round 駒ヶ岳 being far longer. The two missing
// intermediate stations stay missing; that is a station-table gap, not a
// geometry one, and drawing the corridor is strictly better than a hole.
//
// Idempotent: re-running replaces the entry rather than adding a second.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..');
const PACKAGE_PATH = path.join(APP_DIR, 'public', 'rail', 'jp-2025.json');
const SECTIONS_PATH = path.join(APP_DIR, 'data', 'rail-sections.json');

const LINE_NAME = '函館線';
const OPERATOR = '北海道旅客鉄道';
const NEW_ID = 'jp-北海道旅客鉄道-函館線-2';
const FROM = '大沼';
const TO = '鹿部';

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
const key = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
const sections = JSON.parse(fs.readFileSync(SECTIONS_PATH, 'utf8'));

const trunk = pkg.lines.find(
  (line) => line.operator === OPERATOR && line.name === LINE_NAME,
);
if (!trunk) throw new Error(`${OPERATOR} ${LINE_NAME} not in the package`);
const stationRow = (name) => {
  const row = trunk.stations.find((station) => station[1] === name);
  if (!row) throw new Error(`${name} is not a ${LINE_NAME} station`);
  return row;
};
const fromStation = stationRow(FROM);
const toStation = stationRow(TO);

// ── build the N02 graph for this line and find the shortest 大沼 → 鹿部 path ──
const adjacency = new Map();
const point = new Map();
function addEdge(a, b, coordinates) {
  const ka = key(a);
  const kb = key(b);
  point.set(ka, a);
  point.set(kb, b);
  let length = 0;
  for (let i = 1; i < coordinates.length; i += 1)
    length += metres(coordinates[i - 1], coordinates[i]);
  if (!adjacency.has(ka)) adjacency.set(ka, []);
  if (!adjacency.has(kb)) adjacency.set(kb, []);
  adjacency.get(ka).push({ to: kb, length, coordinates });
  adjacency.get(kb).push({ to: ka, length, coordinates: [...coordinates].reverse() });
}
for (const feature of sections.features) {
  const properties = feature.properties || {};
  if (properties.N02_003 !== LINE_NAME || properties.N02_004 !== OPERATOR) continue;
  const lines =
    feature.geometry.type === 'MultiLineString'
      ? feature.geometry.coordinates
      : [feature.geometry.coordinates];
  for (const coordinates of lines) {
    if (coordinates.length < 2) continue;
    addEdge(coordinates[0], coordinates[coordinates.length - 1], coordinates);
  }
}

function nearestNode(target) {
  let best = null;
  let bestDistance = Infinity;
  for (const [k, coordinate] of point) {
    const distance = metres(coordinate, target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = k;
    }
  }
  return { node: best, distance: bestDistance };
}

const start = nearestNode([fromStation[2], fromStation[3]]);
const goal = nearestNode([toStation[2], toStation[3]]);
console.log(
  `start node ${start.distance.toFixed(0)} m from ${FROM}, goal node ${goal.distance.toFixed(0)} m from ${TO}`,
);

const best = new Map([[start.node, 0]]);
const cameFrom = new Map();
const queue = [[0, start.node]];
while (queue.length) {
  queue.sort((a, b) => a[0] - b[0]);
  const [cost, node] = queue.shift();
  if (cost > (best.get(node) ?? Infinity)) continue;
  if (node === goal.node) break;
  for (const edge of adjacency.get(node) || []) {
    const next = cost + edge.length;
    if (next < (best.get(edge.to) ?? Infinity)) {
      best.set(edge.to, next);
      cameFrom.set(edge.to, { from: node, edge });
      queue.push([next, edge.to]);
    }
  }
}
if (!cameFrom.has(goal.node)) throw new Error('no N02 path between the two stations');

const chain = [];
for (let node = goal.node; node !== start.node; ) {
  const step = cameFrom.get(node);
  chain.unshift(step.edge.coordinates);
  node = step.from;
}
const coordinates = [];
for (const piece of chain) {
  for (const c of piece) {
    const rounded = [Number(c[0].toFixed(5)), Number(c[1].toFixed(5))];
    const last = coordinates[coordinates.length - 1];
    if (!last || last[0] !== rounded[0] || last[1] !== rounded[1])
      coordinates.push(rounded);
  }
}
// The package's contract: an interval starts and ends exactly on its stations.
coordinates[0] = [fromStation[2], fromStation[3]];
coordinates[coordinates.length - 1] = [toStation[2], toStation[3]];

let km = 0;
for (let i = 1; i < coordinates.length; i += 1)
  km += metres(coordinates[i - 1], coordinates[i]) / 1000;
console.log(`restored ${FROM} → ${TO}: ${km.toFixed(2)} km, ${coordinates.length} points`);
// 砂原支線 大沼 → 鹿部 is ~13.6 km by the operator's own kilometrage; the main
// line round 駒ヶ岳 to 森 and back would be over 50 km, so anything in this
// window is unambiguously the coastal route.
if (km < 10 || km > 25)
  throw new Error(`path length ${km.toFixed(2)} km is not the coastal branch`);

const entry = {
  id: NEW_ID,
  name: LINE_NAME,
  operator: OPERATOR,
  rank: trunk.rank,
  color: trunk.color,
  stations: [fromStation, toStation].map((row) => [...row]),
  segments: [[Number(km.toFixed(3)), 0, coordinates]],
};

const existing = pkg.lines.findIndex((line) => line.id === NEW_ID);
if (existing >= 0) pkg.lines[existing] = entry;
else {
  const after = pkg.lines.findIndex((line) => line.id === trunk.id);
  pkg.lines.splice(after + 1, 0, entry);
}
pkg.version = '2025.3.1';
fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg)}\n`);
console.log(`package now has ${pkg.lines.length} lines (version ${pkg.version})`);
