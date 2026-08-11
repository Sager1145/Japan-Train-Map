// Corrections to 特急 calling patterns found by checking the store against
// published timetables. One row per confirmed discrepancy, with the source of
// the ruling in the comment, so the next audit can see what was already
// settled and why. Idempotent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..', '..');
const REPO_DIR = path.resolve(APP_DIR, '..');

const CORRECTIONS = [
  {
    trainId: '20260715_02_soya',
    station: '砂川',
    to: 'pass_through',
    // 宗谷's 美唄 and 砂川 are parenthesised in the published calling list with
    // the note 「（ ）は宗谷の下り列車のみ停車」 — down train only. 52D is the
    // UP working (稚内 → 札幌), so it runs through both. 美唄 was already a
    // pass_through here; 砂川 was wrongly a call.
    why: 'ja.wikipedia 宗谷 (列車): （ ）は宗谷の下り列車のみ停車',
  },
];

const storeFiles = [
  path.join(APP_DIR, 'data', 'train-store.json'),
  ...fs
    .readdirSync(path.join(REPO_DIR, 'samples'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(REPO_DIR, 'samples', name)),
].filter((file) => fs.existsSync(file));

let changes = 0;
for (const file of storeFiles) {
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  const trains = Array.isArray(store) ? store : store.trains;
  if (!Array.isArray(trains)) continue;
  let touched = false;
  for (const correction of CORRECTIONS) {
    const train = trains.find((item) => item && item.id === correction.trainId);
    if (!train) continue;
    const stop = (train.stops || []).find((s) => s.name === correction.station);
    if (!stop) {
      console.warn(`  ${correction.trainId}: no ${correction.station} stop to correct`);
      continue;
    }
    if (stop.stop_type === correction.to) continue;
    console.log(
      `  ${correction.trainId} ${correction.station}: ${stop.stop_type} -> ${correction.to}  (${correction.why})`,
    );
    stop.stop_type = correction.to;
    stop.arrival = null;
    stop.departure = null;
    touched = true;
    changes += 1;
  }
  if (touched) {
    fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
    console.log(`updated ${path.relative(REPO_DIR, file)}`);
  }
}
if (!changes) console.log('  no corrections needed');
