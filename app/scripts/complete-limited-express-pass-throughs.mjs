// Fill in the pass-through stations that eight 特急 records never encoded.
//
// Most trains in the store list every station they run through, marking the
// ones they do not call at as `pass_through`. Eight limited expresses instead
// carry COARSE route_sections — 南千歳 → 沼ノ端 as a single hop, say — so the
// stations in between are absent entirely: the map draws no pass-through dot
// for them and the record understates what the train actually passed.
//
// The stations to insert come from the SOLVED route geometry in the
// precomputed parts, not from the package's station order: that order threads
// branch stations between trunk neighbours (函館線's 砂原支線 sits between
// 東森 and 森; 室蘭線's 輪西 between 本輪西 and 東室蘭), and walking it would
// invent stations the train never saw. A station counts as passed when its
// anchor lies within PASS_RADIUS of the drawn path for that hop, and it is
// ordered by how far along that path it sits.
//
// Stop types and times are untouched: every inserted station is a
// `pass_through` with null times, exactly like the hand-entered ones.
// Idempotent — re-running inserts nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..');
const REPO_DIR = path.resolve(APP_DIR, '..');
const PARTS_DIR = path.join(APP_DIR, 'data', 'sample-data');
// How close a station anchor has to sit to the drawn path to count as passed.
// The candidate distances are sharply bimodal: 234 sit within 75 m (the path
// runs through them) and exactly three land past 100 m, each a station on a
// DIFFERENT railway that merely runs alongside — 荒尾 on the 美濃赤坂支線
// beside the 大垣–垂井 main line (112 m), 福島 on the 大阪環状線 beside the
// 東海道本線 (139 m), 東森 on 北斗20's coarse 森–大沼公園 hop (168 m). Two of
// those three would be plain wrong, so the cut goes below all of them: a
// missing pass-through understates the record, an invented one falsifies it.
const PASS_RADIUS = 75; // metres from the drawn path
const NEAR_MISS_RADIUS = 400; // reported, never inserted

const stations = JSON.parse(
  fs.readFileSync(path.join(APP_DIR, 'data', 'stations.json'), 'utf8'),
);

const M_PER_DEG = 111320;
const cosLat = (lat) => Math.cos((lat * Math.PI) / 180);
function segDistance(p, a, b) {
  const k = cosLat(p[1]);
  const px = p[0] * k, py = p[1];
  const ax = a[0] * k, ay = a[1];
  const bx = b[0] * k, by = b[1];
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return {
    distance: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * M_PER_DEG,
    t,
  };
}
function metres(a, b) {
  const k = cosLat((a[1] + b[1]) / 2);
  return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * M_PER_DEG;
}

// Every N02 station, indexed by a coarse grid for the along-path search.
const CELL = 0.01;
const grid = new Map();
const gkey = (x, y) => `${x}|${y}`;
for (const feature of stations.features) {
  const p = feature.properties;
  const point = p.display_point;
  if (!point) continue;
  const k = gkey(Math.floor(point[0] / CELL), Math.floor(point[1] / CELL));
  let rows = grid.get(k);
  if (!rows) grid.set(k, (rows = []));
  rows.push({
    code: p.N02_005c,
    name: p.N02_005,
    line: p.N02_003,
    operator: p.N02_004,
    point,
  });
}

const nearMisses = [];

function stationsAlong(coordinates, lineNames, operatorNames, label, endpoints) {
  const wanted = new Set(lineNames || []);
  const operators = new Set(operatorNames || []);
  const found = new Map(); // code -> {name, code, along}
  const misses = new Map(); // code -> closest approach, for the report
  let along = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    const a = coordinates[i - 1];
    const b = coordinates[i];
    const edge = metres(a, b);
    const gx0 = Math.floor(Math.min(a[0], b[0]) / CELL) - 1;
    const gx1 = Math.floor(Math.max(a[0], b[0]) / CELL) + 1;
    const gy0 = Math.floor(Math.min(a[1], b[1]) / CELL) - 1;
    const gy1 = Math.floor(Math.max(a[1], b[1]) / CELL) + 1;
    for (let x = gx0; x <= gx1; x += 1)
      for (let y = gy0; y <= gy1; y += 1) {
        for (const station of grid.get(gkey(x, y)) || []) {
          if (wanted.size && !wanted.has(station.line)) continue;
          if (operators.size && !operators.has(station.operator)) continue;
          const hit = segDistance(station.point, a, b);
          if (hit.distance > NEAR_MISS_RADIUS) continue;
          if (hit.distance > PASS_RADIUS) {
            if (!endpoints.has(station.code)) {
              const seen = misses.get(station.code);
              if (!seen || hit.distance < seen.distance)
                misses.set(station.code, { name: station.name, distance: hit.distance });
            }
            continue;
          }
          const at = along + edge * hit.t;
          const previous = found.get(station.code);
          if (!previous || hit.distance < previous.distance)
            found.set(station.code, {
              code: station.code,
              name: station.name,
              along: at,
              distance: hit.distance,
            });
        }
      }
    along += edge;
  }
  for (const [code, miss] of misses)
    if (!found.has(code))
      nearMisses.push(
        `${label}: ${miss.name} closest ${Math.round(miss.distance)} m — alongside, not on, this path; left out`,
      );
  return [...found.values()].sort((a, b) => a.along - b.along);
}

const partByTrain = new Map();
for (const file of fs.readdirSync(PARTS_DIR)) {
  if (!file.startsWith('part-')) continue;
  const data = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, file), 'utf8'));
  if (data.train?.id) partByTrain.set(data.train.id, data);
}

const storeFiles = [
  path.join(APP_DIR, 'data', 'train-store.json'),
  ...fs
    .readdirSync(path.join(REPO_DIR, 'samples'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(REPO_DIR, 'samples', name)),
].filter((file) => fs.existsSync(file));

const summary = [];
for (const file of storeFiles) {
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  const trains = Array.isArray(store) ? store : store.trains;
  if (!Array.isArray(trains)) continue;
  let touched = false;

  for (const train of trains) {
    if (!(train.train_type || '').includes('特急')) continue;
    const part = partByTrain.get(train.id);
    if (!part) continue;
    const features = (part.route?.features || []).filter(
      (f) => f.geometry?.type === 'LineString' && f.properties?.segment_index != null,
    );
    if (!features.length) continue;

    const known = new Set(train.stops.map((s) => s.n02_station_code));
    const sections = [];
    const stops = [];
    let added = 0;

    features.sort((a, b) => a.properties.segment_index - b.properties.segment_index);
    for (const [index, feature] of features.entries()) {
      const p = feature.properties;
      const between = stationsAlong(
        feature.geometry.coordinates,
        p.required_line_names || p.preferred_line_names,
        p.required_operator_names || p.preferred_operator_names,
        `${train.id} ${p.from}->${p.to}`,
        new Set([p.from_n02_station_code, p.to_n02_station_code]),
      ).filter(
        (station) =>
          station.code !== p.from_n02_station_code &&
          station.code !== p.to_n02_station_code &&
          !known.has(station.code) &&
          // N02 codes are PER LINE, so a junction where the train changes line
          // has one code for each. Matching on code alone would re-insert the
          // hop's own endpoint under its other code and emit a zero-length
          // 長万部 → 長万部 section, which nothing can slice.
          station.name !== p.from &&
          station.name !== p.to,
      );
      const chain = [
        { code: p.from_n02_station_code, name: p.from },
        ...between,
        { code: p.to_n02_station_code, name: p.to },
      ].filter(
        (station, i, all) => i === 0 || station.name !== all[i - 1].name,
      );
      added += between.length;
      for (let i = 0; i + 1 < chain.length; i += 1)
        sections.push({
          from_n02_station_code: chain[i].code,
          to_n02_station_code: chain[i + 1].code,
          line_names: p.required_line_names || p.preferred_line_names || [],
          operator_names:
            p.required_operator_names || p.preferred_operator_names || [],
        });
      const original = train.stops.find(
        (s) => s.n02_station_code === p.from_n02_station_code,
      );
      if (index === 0)
        stops.push(original || { name: p.from, n02_station_code: p.from_n02_station_code });
      for (const station of between)
        stops.push({
          name: station.name,
          n02_station_code: station.code,
          arrival: null,
          departure: null,
          stop_type: 'pass_through',
          ride_segment: true,
        });
      const arriving = train.stops.find(
        (s) => s.n02_station_code === p.to_n02_station_code,
      );
      stops.push(
        arriving || { name: p.to, n02_station_code: p.to_n02_station_code },
      );
    }
    if (!added) continue;

    train.route_sections = sections;
    train.stops = stops;
    touched = true;
    if (file === storeFiles[0])
      summary.push(`${train.id} ${train.number}: +${added} pass-through station(s)`);
  }

  if (touched) {
    fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
    console.log(`updated ${path.relative(REPO_DIR, file)}`);
  }
}

for (const line of summary) console.log(`  ${line}`);
if (!summary.length) console.log('  nothing to add — every 特急 already lists its pass-throughs');
if (nearMisses.length) {
  console.log('\nnear misses (deliberately left out):');
  for (const line of [...new Set(nearMisses)]) console.log(`  ${line}`);
}
