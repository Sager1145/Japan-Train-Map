// Cut the out-and-back lead-in off station intervals that start by running
// the wrong way.
//
// rebuild-japan-package-geometry.py paths each interval through a graph whose
// NODES are N02 section endpoints, and snaps a station to the nearest node.
// Where a station sits partway along a section — or on a parallel alignment
// that only meets the through track some distance away — the nearest node is
// behind the platform, so the path leaves the station, runs back down the line
// it came from, turns round and passes the platform a second time.
//
// 常磐線 取手 → 藤代 is the clearest case: 11.36 km of path for a 6.0 km
// 営業キロ, because it first runs 2.5 km back towards 天王台 along the
// 緩行線 alignment. The renderer answers a retrace by breaking the line, so
// 取手 also grew a 3.9 km stub stroke that starts and ends at the same
// platform.
//
// This is NOT a general "shorten long intervals" pass. A Japanese railway has
// real reversals — 木次線's 三段式スイッチバック at 出雲坂根, the 阪和線 stub to
// 東羽衣, the reverse into 新千歳空港 — and they must keep doubling back. So
// every repair is listed explicitly here with the official 営業キロ it should
// land on, and the script refuses a case whose result misses that figure.
//
// Idempotent: an interval already free of a lead-in fold is left untouched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..', '..');
const PACKAGE_PATH = path.join(APP_DIR, 'public', 'rail', 'jp-2025.json');
const PACKAGE_VERSION = '2025.3.3';

const CASES = [
  {
    // 姫新線 院庄 → 津山 4.5 km.  The graph path passes the 津山 platform,
    // continues about 420 m east through the yard, then reverses over the same
    // N02 alignment to reach the station node.  Drop that arrival fold so the
    // through line reaches the platform once and continues towards 東津山.
    lineId: 'jp-西日本旅客鉄道-姫新線',
    from: '院庄',
    to: '津山',
    officialKm: 4.5,
  },
  {
    // 常磐線 取手 → 藤代 6.0 km. 取手 is where the 緩行線 from 綾瀬 terminates,
    // so the platform's nearest N02 node sits on that alignment and the path
    // had to run 2.5 km back towards 天王台 to reach the through track.
    lineId: 'jp-東日本旅客鉄道-常磐線',
    from: '取手',
    to: '藤代',
    officialKm: 6.0,
  },
];

// How far into an interval to look for a lead-in that folds back, and how
// close to the platform the path has to return for it to count as one. Both
// are far larger than the interleave script's, because the fold here is a run
// down a whole parallel alignment, not a station-approach stub.
const FOLD_LOOK_METERS = 8000;
const FOLD_RETURN_METERS = 300;
const FOLD_RATIO = 3;
// The repaired interval has to land on its official 営業キロ. Track geometry
// runs a few percent long against 営業キロ, and a platform anchor can sit over
// 100 m off the centre-line, so allow the larger of 12% and 300 m.
const OFFICIAL_TOLERANCE = 0.12;
const OFFICIAL_TOLERANCE_METERS = 300;

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
function pathMetres(coordinates) {
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) total += metres(coordinates[i - 1], coordinates[i]);
  return total;
}
const same = (a, b) => Boolean(a && b && a[0] === b[0] && a[1] === b[1]);

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
    coordinates[coordinates.length - 1] = [line.stations[next][2], line.stations[next][3]];
    previousEnd = coordinates[coordinates.length - 1];
    out.push(coordinates);
  });
  return out;
}

const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
let changed = 0;

for (const plan of CASES) {
  const line = pkg.lines.find((item) => item.id === plan.lineId);
  if (!line) throw new Error(`${plan.lineId} missing`);
  const names = line.stations.map((row) => row[1]);
  const index = names.findIndex(
    (name, i) => name === plan.from && names[(i + 1) % names.length] === plan.to,
  );
  if (index < 0) throw new Error(`${plan.lineId}: no ${plan.from} → ${plan.to} interval`);

  const intervals = decodeIntervals(line);
  const before = intervals[index];
  // Both ends: a fold can just as easily sit at the arrival platform.
  // Never reverse the decoded interval in place: trimFold intentionally
  // returns its input when that end is clean, and Array#reverse would then
  // mutate `before` before the endpoint-safety check below.
  const after = trimFold(trimFold(before).slice().reverse()).slice().reverse();
  const beforeKm = pathMetres(before) / 1000;
  const afterKm = pathMetres(after) / 1000;

  if (after.length === before.length) {
    console.log(`${plan.lineId} ${plan.from} → ${plan.to}: no lead-in fold (${beforeKm.toFixed(2)} km)`);
    continue;
  }
  const tolerance = Math.max(
    plan.officialKm * OFFICIAL_TOLERANCE,
    OFFICIAL_TOLERANCE_METERS / 1000,
  );
  if (Math.abs(afterKm - plan.officialKm) > tolerance)
    throw new Error(
      `${plan.lineId} ${plan.from} → ${plan.to}: trimmed to ${afterKm.toFixed(2)} km, ` +
        `official 営業キロ is ${plan.officialKm} km — refusing to write a path that is still wrong`,
    );
  if (!same(after[0], before[0]) || !same(after[after.length - 1], before[before.length - 1]))
    throw new Error(`${plan.lineId} ${plan.from} → ${plan.to}: endpoints moved`);

  // Re-encode in place. The row keeps its shared-seam flag, so the first
  // vertex stays implicit exactly as the reader expects.
  const shared = line.segments[index][1] === 1;
  line.segments[index] = [
    Number(afterKm.toFixed(3)),
    shared ? 1 : 0,
    shared ? after.slice(1) : after,
  ];
  console.log(
    `${plan.lineId} ${plan.from} → ${plan.to}: ${beforeKm.toFixed(2)} → ${afterKm.toFixed(2)} km ` +
      `(official ${plan.officialKm} km), ${before.length - after.length} lead-in vertices dropped`,
  );
  changed += 1;
}

if (changed) {
  pkg.version = PACKAGE_VERSION;
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg)}\n`);
  console.log(`package: ${pkg.lines.length} lines, version ${pkg.version}`);
} else {
  console.log('nothing to repair');
}
