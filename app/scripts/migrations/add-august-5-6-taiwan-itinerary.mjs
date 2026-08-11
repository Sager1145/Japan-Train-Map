import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const STORE_FILE = path.join(APP_DIR, "data", "train-store-tw.json");

const TRA_OPERATOR = "國營臺灣鐵路股份有限公司";
const THSR_OPERATOR = "台灣高速鐵路股份有限公司";
const TRA_COMPANY = "台鐵";
const THSR_COMPANY = "台灣高鐵";
const TAICHUNG_LINE = "臺中線";
const THSR_LINE = "台灣高速鐵路";

function station(name, code, options = {}) {
  return { name, code, ...options };
}

function routePolicy(line, operator) {
  return {
    mode: "single_primary_route",
    jr_only: false,
    allow_alternatives: false,
    allow_browser_straight_line_fallback: false,
    allowed_institution_type_codes: ["1", "2", "3", "4", "5"],
    preferred_line_names: [line],
    preferred_operator_names: [operator],
    institution_filter_mode: "soft",
  };
}

function makeTrain({
  id,
  date,
  number,
  trainType,
  company,
  operator,
  direction,
  color,
  line,
  stations,
}) {
  return {
    id,
    date,
    number,
    train_type: trainType,
    company,
    origin: stations[0].name,
    destination: stations.at(-1).name,
    direction,
    visible: true,
    style: { color },
    route_policy: routePolicy(line, operator),
    route_sections: stations.slice(0, -1).map((item, index) => ({
      from: item.name,
      to: stations[index + 1].name,
      from_n02_station_code: item.code,
      to_n02_station_code: stations[index + 1].code,
      line_names: [line],
      operator_names: [operator],
    })),
    stops: stations.map((item, index) => ({
      name: item.name,
      n02_station_code: item.code,
      arrival: item.arrival ?? null,
      departure: item.departure ?? null,
      stop_type:
        index === 0
          ? "origin"
          : index === stations.length - 1
            ? "destination"
            : item.stopType ?? "passenger_stop",
      ride_segment: true,
    })),
  };
}

const thsr165 = makeTrain({
  id: "20260805_01_thsr_165_taipei_taichung",
  date: "2026-08-05",
  number: "台灣高鐵 165次（台北→台中）",
  trainType: "高鐵",
  company: THSR_COMPANY,
  operator: THSR_OPERATOR,
  direction: "down",
  color: "#f1662d",
  line: THSR_LINE,
  stations: [
    station("台北", "THSR-1000", { departure: "21:31" }),
    station("板橋", "THSR-1010", { departure: "21:39" }),
    station("桃園", "THSR-1020", { stopType: "pass_through" }),
    station("新竹", "THSR-1030", { stopType: "pass_through" }),
    station("苗栗", "THSR-1035", { stopType: "pass_through" }),
    station("台中", "THSR-1040", { arrival: "22:18" }),
  ],
});

const tra3262 = makeTrain({
  id: "20260805_02_tra_local_3262_xinwuri_taichung",
  date: "2026-08-05",
  number: "區間 3262次（新烏日→臺中）",
  trainType: "區間",
  company: TRA_COMPANY,
  operator: TRA_OPERATOR,
  direction: "up",
  color: "#1971c2",
  line: TAICHUNG_LINE,
  stations: [
    station("新烏日", "TRA-3340", { departure: "23:26" }),
    station("烏日", "TRA-3330", { arrival: "23:28", departure: "23:28" }),
    station("大慶", "TRA-3320", { arrival: "23:31", departure: "23:32" }),
    station("五權", "TRA-3310", { arrival: "23:34", departure: "23:35" }),
    station("臺中", "TRA-3300", { arrival: "23:37" }),
  ],
});

const tra137 = makeTrain({
  id: "20260806_01_tra_tze_chiang_3000_137_taichung_changhua",
  date: "2026-08-06",
  number: "自強(3000) 137次（臺中→彰化）",
  trainType: "自強(3000)",
  company: TRA_COMPANY,
  operator: TRA_OPERATOR,
  direction: "down",
  color: "#c92a2a",
  line: TAICHUNG_LINE,
  stations: [
    station("臺中", "TRA-3300", { departure: "14:10" }),
    station("五權", "TRA-3310", { stopType: "pass_through" }),
    station("大慶", "TRA-3320", { stopType: "pass_through" }),
    station("烏日", "TRA-3330", { stopType: "pass_through" }),
    station("新烏日", "TRA-3340", { stopType: "pass_through" }),
    station("成功", "TRA-3350", { stopType: "pass_through" }),
    station("彰化", "TRA-3360", { arrival: "14:23" }),
  ],
});

const tra2204 = makeTrain({
  id: "20260806_02_tra_local_2204_changhua_taichung",
  date: "2026-08-06",
  number: "區間 2204次（彰化→臺中）",
  trainType: "區間",
  company: TRA_COMPANY,
  operator: TRA_OPERATOR,
  direction: "up",
  color: "#2b8a3e",
  line: TAICHUNG_LINE,
  stations: [
    station("彰化", "TRA-3360", { departure: "14:13" }),
    station("成功", "TRA-3350", { arrival: "14:20", departure: "14:20" }),
    station("新烏日", "TRA-3340", { arrival: "14:24", departure: "14:29" }),
    station("烏日", "TRA-3330", { arrival: "14:31", departure: "14:31" }),
    station("大慶", "TRA-3320", { arrival: "14:34", departure: "14:35" }),
    station("五權", "TRA-3310", { arrival: "14:38", departure: "14:38" }),
    station("臺中", "TRA-3300", { arrival: "14:41" }),
  ],
});

const additions = [thsr165, tra3262, tra137, tra2204];
const additionIds = new Set(additions.map((train) => train.id));

function departureOf(train) {
  return train.stops[0]?.departure ?? "99:99";
}

const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
const trains = store.trains.filter((train) => !additionIds.has(train.id));
trains.push(...additions);
trains.sort(
  (a, b) =>
    a.date.localeCompare(b.date) ||
    departureOf(a).localeCompare(departureOf(b)) ||
    a.id.localeCompare(b.id),
);

const output = `${JSON.stringify({ schema_version: "1.3", trains })}\n`;
const temporary = `${STORE_FILE}.tmp`;
fs.writeFileSync(temporary, output);
fs.renameSync(temporary, STORE_FILE);
console.log(`Updated ${path.relative(APP_DIR, STORE_FILE)}`);
