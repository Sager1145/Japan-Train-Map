import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..");
const STORE_FILE = path.join(APP_DIR, "data", "train-store-tw.json");

const OPERATOR = "高雄捷運股份有限公司";
const COMPANY = "高雄捷運";
const RED_LINE = "高雄捷運紅線";
const LIGHT_RAIL_LINE = "高雄環狀輕軌";
const RED_COLOR = "#E20A17";
const LIGHT_RAIL_COLOR = "#78C7D3";

function station(name, code, time) {
  return { name, code, time };
}

function makeJourney({
  id,
  number,
  trainType,
  direction,
  color,
  line,
  stations,
}) {
  return {
    id,
    date: "2026-08-10",
    number,
    train_type: trainType,
    company: COMPANY,
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
      preferred_line_names: [line],
      preferred_operator_names: [OPERATOR],
      institution_filter_mode: "soft",
    },
    route_sections: stations.slice(0, -1).map((item, index) => ({
      from: item.name,
      to: stations[index + 1].name,
      from_n02_station_code: item.code,
      to_n02_station_code: stations[index + 1].code,
      line_names: [line],
      operator_names: [OPERATOR],
    })),
    stops: stations.map((item, index) => ({
      name: item.name,
      n02_station_code: item.code,
      arrival: index === 0 ? null : item.time,
      departure: index === stations.length - 1 ? null : item.time,
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

const kaohsiungToGangshanStation = makeJourney({
  id: "20260810_01_krtc_red_kaohsiung_gangshan_station",
  number: "高雄捷運 紅線（高雄車站→岡山車站）",
  trainType: "捷運",
  direction: "up",
  color: RED_COLOR,
  line: RED_LINE,
  stations: [
    station("高雄車站", "KRTC-R11", "14:38"),
    station("後驛", "KRTC-R12", "14:40"),
    station("凹子底", "KRTC-R13", "14:42"),
    station("巨蛋", "KRTC-R14", "14:44"),
    station("生態園區", "KRTC-R15", "14:46"),
    station("左營", "KRTC-R16", "14:48"),
    station("世運", "KRTC-R17", "14:51"),
    station("油廠國小", "KRTC-R18", "14:52"),
    station("楠梓科技園區", "KRTC-R19", "14:54"),
    station("後勁", "KRTC-R20", "14:57"),
    station("都會公園", "KRTC-R21", "14:58"),
    station("青埔", "KRTC-R22", "15:01"),
    station("橋頭糖廠", "KRTC-R22A", "15:02"),
    station("橋頭火車站", "KRTC-R23", "15:04"),
    station("岡山高醫", "KRTC-R24", "15:08"),
    station("岡山車站", "KRTC-RK1", "15:10"),
  ],
});

const gangshanStationToSiaogang = makeJourney({
  id: "20260810_02_krtc_red_gangshan_station_siaogang",
  number: "高雄捷運 紅線（岡山車站→小港）",
  trainType: "捷運",
  direction: "down",
  color: RED_COLOR,
  line: RED_LINE,
  stations: [
    station("岡山車站", "KRTC-RK1", "15:16"),
    station("岡山高醫", "KRTC-R24", "15:17"),
    station("橋頭火車站", "KRTC-R23", "15:21"),
    station("橋頭糖廠", "KRTC-R22A", "15:22"),
    station("青埔", "KRTC-R22", "15:24"),
    station("都會公園", "KRTC-R21", "15:26"),
    station("後勁", "KRTC-R20", "15:28"),
    station("楠梓科技園區", "KRTC-R19", "15:30"),
    station("油廠國小", "KRTC-R18", "15:32"),
    station("世運", "KRTC-R17", "15:34"),
    station("左營", "KRTC-R16", "15:36"),
    station("生態園區", "KRTC-R15", "15:39"),
    station("巨蛋", "KRTC-R14", "15:41"),
    station("凹子底", "KRTC-R13", "15:43"),
    station("後驛", "KRTC-R12", "15:44"),
    station("高雄車站", "KRTC-R11", "15:47"),
    station("美麗島", "KRTC-R10", "15:48"),
    station("中央公園", "KRTC-R9", "15:50"),
    station("三多商圈", "KRTC-R8", "15:52"),
    station("獅甲", "KRTC-R7", "15:54"),
    station("凱旋", "KRTC-R6", "15:57"),
    station("前鎮高中", "KRTC-R5", "15:59"),
    station("草衙", "KRTC-R4A", "16:01"),
    station("高雄國際機場", "KRTC-R4", "16:04"),
    station("小港", "KRTC-R3", "16:06"),
  ],
});

const siaogangToSanduo = makeJourney({
  id: "20260810_03_krtc_red_siaogang_sanduo",
  number: "高雄捷運 紅線（小港→三多商圈）",
  trainType: "捷運",
  direction: "up",
  color: RED_COLOR,
  line: RED_LINE,
  stations: [
    station("小港", "KRTC-R3", "16:12"),
    station("高雄國際機場", "KRTC-R4", "16:14"),
    station("草衙", "KRTC-R4A", "16:16"),
    station("前鎮高中", "KRTC-R5", "16:18"),
    station("凱旋", "KRTC-R6", "16:20"),
    station("獅甲", "KRTC-R7", "16:22"),
    station("三多商圈", "KRTC-R8", "16:24"),
  ],
});

const sanduoToKaisyuan = makeJourney({
  id: "20260810_04_krtc_red_sanduo_kaisyuan",
  number: "高雄捷運 紅線（三多商圈→凱旋）",
  trainType: "捷運",
  direction: "down",
  color: RED_COLOR,
  line: RED_LINE,
  stations: [
    station("三多商圈", "KRTC-R8", "17:03"),
    station("獅甲", "KRTC-R7", "17:05"),
    station("凱旋", "KRTC-R6", "17:08"),
  ],
});

const lightRailLoop = makeJourney({
  id: "20260810_05_klrt_c3_counterclockwise_loop",
  number: "高雄輕軌 逆行環狀（前鎮之星→前鎮之星）",
  trainType: "輕軌",
  direction: "down",
  color: LIGHT_RAIL_COLOR,
  line: LIGHT_RAIL_LINE,
  stations: [
    station("前鎮之星", "KLRT-NETWORK-C3", "17:18"),
    station("凱旋瑞田", "KLRT-NETWORK-C2", "17:21"),
    station("籬仔內", "KLRT-NETWORK-C1", "17:24"),
    station("輕軌機廠站", "KLRT-NETWORK-C37", "17:26"),
    station("凱旋二聖站", "KLRT-NETWORK-C36", "17:27"),
    station("凱旋武昌站", "KLRT-NETWORK-C35", "17:29"),
    station("五權國小站", "KLRT-NETWORK-C34", "17:31"),
    station("衛生局站", "KLRT-NETWORK-C33", "17:34"),
    station("凱旋公園站", "KLRT-NETWORK-C32", "17:37"),
    station("聖功醫院", "KLRT-NETWORK-C31", "17:39"),
    station("科工館", "KLRT-NETWORK-C30", "17:42"),
    station("樹德家商", "KLRT-NETWORK-C29", "17:45"),
    station("高雄高工", "KLRT-NETWORK-C28", "17:48"),
    station("灣仔內(大順鼎山)", "KLRT-NETWORK-C27", "17:50"),
    station("大順民族", "KLRT-NETWORK-C26", "17:53"),
    station("新上國小", "KLRT-NETWORK-C25", "17:56"),
    station("愛河之心", "KLRT-NETWORK-C24", "17:59"),
    station("龍華國小", "KLRT-NETWORK-C23", "18:02"),
    station("聯合醫院", "KLRT-NETWORK-C22", "18:04"),
    station("美術館", "KLRT-NETWORK-C21", "18:05"),
    station("內惟藝術中心", "KLRT-NETWORK-C21A", "18:07"),
    station("臺鐵美術館", "KLRT-NETWORK-C20", "18:09"),
    station("馬卡道", "KLRT-NETWORK-C19", "18:11"),
    station("鼓山", "KLRT-NETWORK-C18", "18:14"),
    station("鼓山區公所站", "KLRT-NETWORK-C17", "18:16"),
    station("文武聖殿站", "KLRT-NETWORK-C16", "18:18"),
    station("壽山公園站", "KLRT-NETWORK-C15", "18:20"),
    station("哈瑪星", "KLRT-NETWORK-C14", "18:23"),
    station("駁二蓬萊", "KLRT-NETWORK-C13", "18:25"),
    station("駁二大義", "KLRT-NETWORK-C12", "18:27"),
    station("真愛碼頭", "KLRT-NETWORK-C11", "18:29"),
    station("光榮碼頭", "KLRT-NETWORK-C10", "18:31"),
    station("旅運中心", "KLRT-NETWORK-C9", "18:33"),
    station("高雄展覽館", "KLRT-NETWORK-C8", "18:36"),
    station("軟體園區", "KLRT-NETWORK-C7", "18:39"),
    station("經貿園區", "KLRT-NETWORK-C6", "18:41"),
    station("夢時代", "KLRT-NETWORK-C5", "18:43"),
    station("凱旋中華", "KLRT-NETWORK-C4", "18:45"),
    station("前鎮之星", "KLRT-NETWORK-C3", "18:47"),
  ],
});

const kaisyuanToKaohsiung = makeJourney({
  id: "20260810_06_krtc_red_kaisyuan_kaohsiung",
  number: "高雄捷運 紅線（凱旋→高雄車站）",
  trainType: "捷運",
  direction: "up",
  color: RED_COLOR,
  line: RED_LINE,
  stations: [
    station("凱旋", "KRTC-R6", "18:54"),
    station("獅甲", "KRTC-R7", "18:56"),
    station("三多商圈", "KRTC-R8", "18:58"),
    station("中央公園", "KRTC-R9", "19:00"),
    station("美麗島", "KRTC-R10", "19:02"),
    station("高雄車站", "KRTC-R11", "19:04"),
  ],
});

const additions = [
  kaohsiungToGangshanStation,
  gangshanStationToSiaogang,
  siaogangToSanduo,
  sanduoToKaisyuan,
  lightRailLoop,
  kaisyuanToKaohsiung,
];
const additionIds = new Set(additions.map((train) => train.id));
const legacyAdditionIds = new Set([
  "20260810_01_krtc_red_kaohsiung_gangshan_hospital",
  "20260810_02_krtc_red_gangshan_hospital_siaogang",
]);

function departureOf(train) {
  return train.stops[0]?.departure ?? "99:99";
}

const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
const trains = store.trains.filter(
  (train) => !additionIds.has(train.id) && !legacyAdditionIds.has(train.id),
);
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
