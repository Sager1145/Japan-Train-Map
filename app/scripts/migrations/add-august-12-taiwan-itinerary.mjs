import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const STORE_FILE = path.join(APP_DIR, "data", "train-store-tw.json");

const DATE = "2026-08-12";
const KRTC_OPERATOR = "高雄捷運股份有限公司";
const KRTC_LINE = "高雄捷運紅線";
const TRA_OPERATOR = "國營臺灣鐵路股份有限公司";
const TRA_WESTERN_NORTH_LINE = "縱貫線北段";
const TRA_YILAN_LINE = "宜蘭線";
const THSR_OPERATOR = "台灣高速鐵路股份有限公司";
const THSR_LINE = "台灣高速鐵路";

function station(name, code, arrival, departure = arrival, lineToNext = null) {
  return { name, code, arrival, departure, lineToNext };
}

function makeJourney({
  id,
  number,
  trainType,
  company,
  direction,
  color,
  line,
  lines,
  operator,
  stations,
}) {
  const preferredLines = lines ?? [line];
  return {
    id,
    date: DATE,
    number,
    train_type: trainType,
    company,
    origin: stations[0].name,
    destination: stations.at(-1).name,
    direction,
    visible: true,
    style: { color },
    route_policy: {
      mode: "single_primary_route",
      jr_only: false,
      allow_alternatives: false,
      allow_browser_straight_line_fallback: false,
      allowed_institution_type_codes: ["1", "2", "3", "4", "5"],
      preferred_line_names: preferredLines,
      preferred_operator_names: [operator],
      institution_filter_mode: "soft",
    },
    route_sections: stations.slice(0, -1).map((item, index) => {
      const sectionLine = item.lineToNext ?? preferredLines[0];
      return {
        from: item.name,
        to: stations[index + 1].name,
        from_n02_station_code: item.code,
        to_n02_station_code: stations[index + 1].code,
        line_names: [sectionLine],
        operator_names: [operator],
      };
    }),
    stops: stations.map((item, index) => ({
      name: item.name,
      n02_station_code: item.code,
      arrival: index === 0 ? null : item.arrival,
      departure: index === stations.length - 1 ? null : item.departure,
      stop_type:
        index === 0
          ? "origin"
          : index === stations.length - 1
            ? "destination"
            : "passenger_stop",
      ride_segment: true,
    })),
  };
}

const kaohsiungToZuoying = makeJourney({
  id: "20260812_01_krtc_red_kaohsiung_zuoying",
  number: "高雄捷運 紅線（高雄車站→左營）",
  trainType: "捷運",
  company: "高雄捷運",
  direction: "up",
  color: "#E20A17",
  line: KRTC_LINE,
  operator: KRTC_OPERATOR,
  stations: [
    station("高雄車站", "KRTC-R11", null, "11:10"),
    station("後驛", "KRTC-R12", "11:12"),
    station("凹子底", "KRTC-R13", "11:14"),
    station("巨蛋", "KRTC-R14", "11:16"),
    station("生態園區", "KRTC-R15", "11:18"),
    station("左營", "KRTC-R16", "11:20", null),
  ],
});

const thsr826ZuoyingToTaipei = makeJourney({
  id: "20260812_02_thsr_826_zuoying_taipei",
  number: "台灣高鐵 826次（左營→台北）",
  trainType: "高鐵",
  company: "台灣高鐵",
  direction: "up",
  color: "#f1662d",
  line: THSR_LINE,
  operator: THSR_OPERATOR,
  stations: [
    station("左營", "THSR-1070", null, "12:25"),
    station("台南", "THSR-1060", "12:40", "12:41"),
    station("嘉義", "THSR-1050", "12:58", "13:00"),
    station("雲林", "THSR-1047", "13:11", "13:12"),
    station("彰化", "THSR-1043", "13:21", "13:24"),
    station("台中", "THSR-1040", "13:34", "13:36"),
    station("苗栗", "THSR-1035", "13:54", "13:56"),
    station("新竹", "THSR-1030", "14:07", "14:08"),
    station("桃園", "THSR-1020", "14:18", "14:20"),
    station("板橋", "THSR-1010", "14:31", "14:32"),
    station("台北", "THSR-1000", "14:39", null),
  ],
});

const tra1208TaipeiToKeelung = makeJourney({
  id: "20260812_03_tra_local_1208_taipei_keelung",
  number: "區間 1208次（臺北→基隆）",
  trainType: "區間",
  company: "台鐵",
  direction: "up",
  color: "#1971c2",
  line: TRA_WESTERN_NORTH_LINE,
  operator: TRA_OPERATOR,
  stations: [
    station("臺北", "TRA-1000", null, "15:38"),
    station("松山", "TRA-0990", "15:45"),
    station("南港", "TRA-0980", "15:48"),
    station("汐科", "TRA-0970", "15:54"),
    station("汐止", "TRA-0960", "16:01"),
    station("五堵", "TRA-0950", "16:03"),
    station("百福", "TRA-0940", "16:07"),
    station("七堵", "TRA-0930", "16:13"),
    station("八堵", "TRA-0920", "16:17"),
    station("三坑", "TRA-0910", "16:20"),
    station("基隆", "TRA-0900", "16:25", null),
  ],
});

const tra4209NuannuanToNangang = makeJourney({
  id: "20260812_04_tra_local_4209_nuannuan_nangang",
  number: "區間 4209次（暖暖→南港）",
  trainType: "區間",
  company: "台鐵",
  direction: "down",
  color: "#2b8a3e",
  lines: [TRA_YILAN_LINE, TRA_WESTERN_NORTH_LINE],
  operator: TRA_OPERATOR,
  stations: [
    station("暖暖", "TRA-7390", null, "19:33", TRA_YILAN_LINE),
    station("八堵", "TRA-0920", "19:36", "19:36", TRA_WESTERN_NORTH_LINE),
    station(
      "七堵",
      "TRA-0930",
      "19:41",
      "19:41",
      TRA_WESTERN_NORTH_LINE,
    ),
    station(
      "百福",
      "TRA-0940",
      "19:45",
      "19:45",
      TRA_WESTERN_NORTH_LINE,
    ),
    station(
      "五堵",
      "TRA-0950",
      "19:49",
      "19:49",
      TRA_WESTERN_NORTH_LINE,
    ),
    station(
      "汐止",
      "TRA-0960",
      "19:52",
      "19:52",
      TRA_WESTERN_NORTH_LINE,
    ),
    station(
      "汐科",
      "TRA-0970",
      "19:54",
      "19:54",
      TRA_WESTERN_NORTH_LINE,
    ),
    station("南港", "TRA-0980", "19:59", null),
  ],
});

const thsr161NangangToTaipei = makeJourney({
  id: "20260812_05_thsr_161_nangang_taipei",
  number: "台灣高鐵 161次（南港→台北）",
  trainType: "高鐵",
  company: "台灣高鐵",
  direction: "down",
  color: "#f1662d",
  line: THSR_LINE,
  operator: THSR_OPERATOR,
  stations: [
    station("南港", "THSR-0990", null, "20:20"),
    station("台北", "THSR-1000", "20:28", null),
  ],
});

const additions = [
  kaohsiungToZuoying,
  thsr826ZuoyingToTaipei,
  tra1208TaipeiToKeelung,
  tra4209NuannuanToNangang,
  thsr161NangangToTaipei,
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
