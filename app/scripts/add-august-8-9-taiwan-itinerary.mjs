import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..");
const STORE_FILE = path.join(APP_DIR, "data", "train-store-tw.json");

const TRA_OPERATOR = "國營臺灣鐵路股份有限公司";
const ALISHAN_OPERATOR = "阿里山林業鐵路及文化資產管理處";
const TRA_COMPANY = "台鐵";
const ALISHAN_COMPANY = "阿里山林鐵";
const TAICHUNG_LINE = "臺中線";
const WESTERN_SOUTH_LINE = "縱貫線南段";
const ALISHAN_LINE = "阿里山線";
const SHENMU_LINE = "神木線";
const ZHUSHAN_LINE = "祝山線";

function station(name, code, options = {}) {
  return { name, code, ...options };
}

function routePolicy(lines, operator) {
  return {
    mode: "single_primary_route",
    jr_only: false,
    allow_alternatives: false,
    allow_browser_straight_line_fallback: false,
    allowed_institution_type_codes: ["1", "2", "3", "4", "5"],
    preferred_line_names: lines,
    preferred_operator_names: [operator],
    institution_filter_mode: "soft",
  };
}

function makeJourney({
  id,
  date,
  number,
  trainType,
  company,
  operator,
  direction,
  color,
  lines,
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
    route_policy: routePolicy(lines, operator),
    route_sections: stations.slice(0, -1).map((item, index) => ({
      from: item.name,
      to: stations[index + 1].name,
      from_n02_station_code: item.code,
      to_n02_station_code: stations[index + 1].code,
      line_names: [item.line ?? lines[0]],
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
            : item.stopType ?? "pass_through",
      ride_segment: true,
    })),
  };
}

const tra191 = makeJourney({
  id: "20260808_01_tra_tze_chiang_3000_191_taichung_chiayi",
  date: "2026-08-08",
  number: "自強(3000) 191次（臺中→嘉義）",
  trainType: "自強(3000)",
  company: TRA_COMPANY,
  operator: TRA_OPERATOR,
  direction: "down",
  color: "#0B4DA2",
  lines: [TAICHUNG_LINE, WESTERN_SOUTH_LINE],
  stations: [
    station("臺中", "TRA-3300", {
      departure: "07:39",
      line: TAICHUNG_LINE,
    }),
    station("五權", "TRA-3310", { line: TAICHUNG_LINE }),
    station("大慶", "TRA-3320", { line: TAICHUNG_LINE }),
    station("烏日", "TRA-3330", { line: TAICHUNG_LINE }),
    station("新烏日", "TRA-3340", { line: TAICHUNG_LINE }),
    station("成功", "TRA-3350", { line: TAICHUNG_LINE }),
    station("彰化", "TRA-3360", {
      arrival: "07:53",
      departure: "07:55",
      stopType: "passenger_stop",
      line: WESTERN_SOUTH_LINE,
    }),
    station("花壇", "TRA-3370", { line: WESTERN_SOUTH_LINE }),
    station("大村", "TRA-3380", { line: WESTERN_SOUTH_LINE }),
    station("員林", "TRA-3390", { line: WESTERN_SOUTH_LINE }),
    station("永靖", "TRA-3400", { line: WESTERN_SOUTH_LINE }),
    station("社頭", "TRA-3410", { line: WESTERN_SOUTH_LINE }),
    station("田中", "TRA-3420", { line: WESTERN_SOUTH_LINE }),
    station("二水", "TRA-3430", { line: WESTERN_SOUTH_LINE }),
    station("林內", "TRA-3450", { line: WESTERN_SOUTH_LINE }),
    station("石榴", "TRA-3460", { line: WESTERN_SOUTH_LINE }),
    station("斗六", "TRA-3470", { line: WESTERN_SOUTH_LINE }),
    station("斗南", "TRA-3480", { line: WESTERN_SOUTH_LINE }),
    station("石龜", "TRA-3490", { line: WESTERN_SOUTH_LINE }),
    station("大林", "TRA-4050", { line: WESTERN_SOUTH_LINE }),
    station("民雄", "TRA-4060", { line: WESTERN_SOUTH_LINE }),
    station("嘉北", "TRA-4070", { line: WESTERN_SOUTH_LINE }),
    station("嘉義", "TRA-4080", {
      arrival: "08:43",
      line: WESTERN_SOUTH_LINE,
    }),
  ],
});

const alishanStations = [
  ["嘉義", "TRA-4080"],
  ["北門", "AFR-I0000000551"],
  ["鹿麻產", "AFR-Q0000004483"],
  ["竹崎", "AFR-Q0000001023"],
  ["木屐寮", "AFR-Q0000004496"],
  ["樟腦寮", "AFR-Q0000001054"],
  ["獨立山", "AFR-Q0000001073"],
  ["梨園寮", "AFR-Q0000001080"],
  ["交力坪", "AFR-Q0000001047"],
  ["水社寮", "AFR-Q0000002368"],
  ["奮起湖", "AFR-Q0000002380"],
  ["多林", "AFR-Q0000001597"],
  ["十字路", "AFR-Q0000001623"],
  ["屏遮那", "AFR-Q0000001627"],
  ["二萬平", "AFR-Q0000001630"],
  ["神木", "AFR-Q0000001660"],
  ["阿里山", "AFR-Q0000001651"],
];

function alishanStation(name, code, options = {}) {
  return station(name, code, { line: ALISHAN_LINE, ...options });
}

const alishan5Times = new Map([
  ["嘉義", { departure: "10:00" }],
  ["北門", { arrival: "10:08", departure: "10:08" }],
  ["竹崎", { arrival: "10:39", departure: "10:39" }],
  ["交力坪", { arrival: "11:43", departure: "11:43" }],
  ["奮起湖", { arrival: "12:16", departure: "13:21" }],
  ["二萬平", { arrival: "14:38", departure: "14:38" }],
  ["阿里山", { arrival: "14:56" }],
]);

const alishan5 = makeJourney({
  id: "20260808_02_alsr_5_chiayi_alishan",
  date: "2026-08-08",
  number: "阿里山號 5次（嘉義→阿里山）",
  trainType: "阿里山號",
  company: ALISHAN_COMPANY,
  operator: ALISHAN_OPERATOR,
  direction: "up",
  color: "#C41230",
  lines: [ALISHAN_LINE],
  stations: alishanStations.map(([name, code]) => {
    const times = alishan5Times.get(name);
    return alishanStation(name, code, {
      ...times,
      ...(times && name !== "嘉義" && name !== "阿里山"
        ? { stopType: "passenger_stop" }
        : {}),
    });
  }),
});

const alishan8Times = new Map([
  ["阿里山", { departure: "11:50" }],
  ["二萬平", { arrival: "12:09", departure: "12:09" }],
  ["奮起湖", { arrival: "13:29", departure: "13:29" }],
  ["交力坪", { arrival: "14:04", departure: "14:04" }],
  ["竹崎", { arrival: "15:07", departure: "15:07" }],
  ["北門", { arrival: "15:39", departure: "15:39" }],
  ["嘉義", { arrival: "15:45" }],
]);

const alishan8 = makeJourney({
  id: "20260809_01_alsr_8_alishan_chiayi",
  date: "2026-08-09",
  number: "阿里山號 8次（阿里山→嘉義）",
  trainType: "阿里山號",
  company: ALISHAN_COMPANY,
  operator: ALISHAN_OPERATOR,
  direction: "down",
  color: "#C41230",
  lines: [ALISHAN_LINE],
  stations: [...alishanStations].reverse().map(([name, code]) => {
    const times = alishan8Times.get(name);
    return alishanStation(name, code, {
      ...times,
      ...(times && name !== "阿里山" && name !== "嘉義"
        ? { stopType: "passenger_stop" }
        : {}),
    });
  }),
});

const alishan = ["阿里山", "AFR-Q0000001651"];
const shenmu = ["神木", "AFR-Q0000001660"];

const shenmu120 = makeJourney({
  id: "20260808_03_alsr_120_alishan_shenmu",
  date: "2026-08-08",
  number: "神木線 120次（阿里山→神木）",
  trainType: "支線列車",
  company: ALISHAN_COMPANY,
  operator: ALISHAN_OPERATOR,
  direction: "down",
  color: "#C41230",
  lines: [SHENMU_LINE],
  stations: [
    station(alishan[0], alishan[1], {
      departure: "15:50",
      line: SHENMU_LINE,
    }),
    station(shenmu[0], shenmu[1], {
      arrival: "15:57",
      line: SHENMU_LINE,
    }),
  ],
});

const shenmu121 = makeJourney({
  id: "20260808_04_alsr_121_shenmu_alishan",
  date: "2026-08-08",
  number: "神木線 121次（神木→阿里山）",
  trainType: "支線列車",
  company: ALISHAN_COMPANY,
  operator: ALISHAN_OPERATOR,
  direction: "up",
  color: "#C41230",
  lines: [SHENMU_LINE],
  stations: [
    station(shenmu[0], shenmu[1], {
      departure: "16:10",
      line: SHENMU_LINE,
    }),
    station(alishan[0], alishan[1], {
      arrival: "16:17",
      line: SHENMU_LINE,
    }),
  ],
});

const zhushanStations = [
  ["阿里山", "AFR-Q0000001651"],
  ["對高岳", "AFR-M0000005225"],
  ["祝山", "AFR-Q0000004704"],
];

const zhushanObservation = makeJourney({
  id: "20260809_02_alsr_zhushan_observation_alishan_zhushan",
  date: "2026-08-09",
  number: "祝山線觀日列車（阿里山→祝山）",
  trainType: "觀日列車",
  company: ALISHAN_COMPANY,
  operator: ALISHAN_OPERATOR,
  direction: "up",
  color: "#C41230",
  lines: [ZHUSHAN_LINE],
  stations: zhushanStations.map(([name, code], index) =>
    station(name, code, {
      line: ZHUSHAN_LINE,
      ...(index === 0 ? { departure: "04:40" } : {}),
      ...(index === zhushanStations.length - 1 ? { arrival: "05:05" } : {}),
    }),
  ),
});

const zhushanReturn = makeJourney({
  id: "20260809_03_alsr_zhushan_observation_zhushan_alishan",
  date: "2026-08-09",
  number: "祝山線觀日列車（祝山→阿里山）",
  trainType: "觀日列車",
  company: ALISHAN_COMPANY,
  operator: ALISHAN_OPERATOR,
  direction: "down",
  color: "#C41230",
  lines: [ZHUSHAN_LINE],
  stations: [...zhushanStations].reverse().map(([name, code], index, list) =>
    station(name, code, {
      line: ZHUSHAN_LINE,
      ...(index === 0 ? { departure: "06:20" } : {}),
      ...(index === list.length - 1 ? { arrival: "06:45" } : {}),
    }),
  ),
});

const tra125Stations = [
  ["嘉義", "TRA-4080"],
  ["水上", "TRA-4090"],
  ["南靖", "TRA-4100"],
  ["後壁", "TRA-4110"],
  ["新營", "TRA-4120"],
  ["柳營", "TRA-4130"],
  ["林鳳營", "TRA-4140"],
  ["隆田", "TRA-4150"],
  ["拔林", "TRA-4160"],
  ["善化", "TRA-4170"],
  ["南科", "TRA-4180"],
  ["新市", "TRA-4190"],
  ["永康", "TRA-4200"],
  ["大橋", "TRA-4210"],
  ["臺南", "TRA-4220"],
  ["保安", "TRA-4250"],
  ["仁德", "TRA-4260"],
  ["中洲", "TRA-4270"],
  ["大湖", "TRA-4290"],
  ["路竹", "TRA-4300"],
  ["岡山", "TRA-4310"],
  ["橋頭", "TRA-4320"],
  ["楠梓", "TRA-4330"],
  ["新左營", "TRA-4340"],
  ["左營", "TRA-4350"],
  ["內惟", "TRA-4360"],
  ["美術館", "TRA-4370"],
  ["鼓山", "TRA-4380"],
  ["三塊厝", "TRA-4390"],
  ["高雄", "TRA-4400"],
];

const tra125Times = new Map([
  ["嘉義", { departure: "16:19" }],
  ["新營", { arrival: "16:32", departure: "16:34" }],
  ["永康", { arrival: "16:53", departure: "16:54" }],
  ["臺南", { arrival: "16:59", departure: "17:01" }],
  ["新左營", { arrival: "17:25", departure: "17:26" }],
  ["高雄", { arrival: "17:34" }],
]);

const tra125 = makeJourney({
  id: "20260809_04_tra_tze_chiang_3000_125_chiayi_kaohsiung",
  date: "2026-08-09",
  number: "自強(3000) 125次（嘉義→高雄）",
  trainType: "自強(3000)",
  company: TRA_COMPANY,
  operator: TRA_OPERATOR,
  direction: "down",
  color: "#0B4DA2",
  lines: [WESTERN_SOUTH_LINE],
  stations: tra125Stations.map(([name, code]) => {
    const times = tra125Times.get(name);
    return station(name, code, {
      line: WESTERN_SOUTH_LINE,
      ...times,
      ...(times && name !== "嘉義" && name !== "高雄"
        ? { stopType: "passenger_stop" }
        : {}),
    });
  }),
});

const additions = [
  tra191,
  alishan5,
  shenmu120,
  shenmu121,
  zhushanObservation,
  zhushanReturn,
  alishan8,
  tra125,
];
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
