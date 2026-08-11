// 函館市電 5 系統, 2026-07-17 midday run (五稜郭公園前 → 函館駅前).
//
// The entry was stored as ONE 五稜郭公園前 → 函館駅前 section with only its two
// terminals as stops. A tram calls at every stop, so the record showed no
// intermediate stations at all, and the single 16-minute hop left the solver
// free to pick any 函館市 path between the terminals instead of the actual
// 湯の川線 → 松風町 → 大森線 alignment.
//
// This rewrites it as one section per stop, on the line each stop belongs to,
// using the N02 codes from data/stations.json. Idempotent: re-running it
// produces the same record.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const REPO_DIR = path.resolve(APP_DIR, "..");
const TRAIN_ID = "20260717_01_hakodate_tram";

// 五稜郭公園前 → 函館駅前 in running order. 松風町 is where 5 系統 leaves the
// 湯の川線 and takes the 大森線 down to 函館駅前; the N02 code carried across
// that boundary is the 湯の川線 one, matching how every other multi-line train
// in the store keeps a single code for its transfer station.
const STOPS = [
  { name: "五稜郭公園前", code: "000441", line: "湯の川線" },
  { name: "中央病院前", code: "000445", line: "湯の川線" },
  { name: "千代台", code: "000447", line: "湯の川線" },
  { name: "堀川町", code: "000451", line: "湯の川線" },
  { name: "昭和橋", code: "000453", line: "湯の川線" },
  { name: "千歳町", code: "000454", line: "湯の川線" },
  { name: "新川町", code: "000456", line: "湯の川線" },
  { name: "松風町", code: "000461", line: "大森線" },
  { name: "函館駅前", code: "000458", line: null },
];
const DEPARTURE = "12:06";
const ARRIVAL = "12:22";

function buildSections() {
  return STOPS.slice(0, -1).map((stop, index) => ({
    from_n02_station_code: stop.code,
    to_n02_station_code: STOPS[index + 1].code,
    line_names: [stop.line],
    operator_names: ["函館市"],
  }));
}

function buildStops() {
  return STOPS.map((stop, index) => ({
    name: stop.name,
    n02_station_code: stop.code,
    arrival: index === STOPS.length - 1 ? ARRIVAL : null,
    departure: index === 0 ? DEPARTURE : null,
    stop_type:
      index === 0
        ? "origin"
        : index === STOPS.length - 1
          ? "destination"
          : "passenger_stop",
    ride_segment: true,
  }));
}

function patch(train) {
  train.route_policy = {
    ...train.route_policy,
    preferred_line_names: ["湯の川線", "大森線"],
  };
  train.route_sections = buildSections();
  train.stops = buildStops();
  return train;
}

const storeFiles = [
  path.join(APP_DIR, "data", "train-store.json"),
  ...fs
    .readdirSync(path.join(REPO_DIR, "samples"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(REPO_DIR, "samples", name)),
];

let patched = 0;
for (const file of storeFiles) {
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, "utf8");
  const store = JSON.parse(raw);
  const trains = Array.isArray(store) ? store : store.trains;
  if (!Array.isArray(trains)) continue;
  const train = trains.find((item) => item && item.id === TRAIN_ID);
  if (!train) continue;
  patch(train);
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
  patched += 1;
  console.log(`patched ${TRAIN_ID} in ${path.relative(REPO_DIR, file)}`);
}

if (!patched) {
  console.error(`no store contained ${TRAIN_ID}`);
  process.exitCode = 1;
}
