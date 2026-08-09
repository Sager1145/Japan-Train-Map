import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..");
const STORE_FILE = path.join(APP_DIR, "data", "train-store-tw.json");

const TRTC_OPERATOR = "臺北大眾捷運股份有限公司";
const TRTC_COMPANY = "台北捷運";
const BANNAN_LINE = "板南線";
const BANNAN_COLOR = "#0070BD";

function station(name, code, options = {}) {
  return { name, code, ...options };
}

function routePolicy() {
  return {
    mode: "single_primary_route",
    jr_only: false,
    allow_alternatives: false,
    allow_browser_straight_line_fallback: false,
    allowed_institution_type_codes: ["1", "2", "3", "4", "5"],
    preferred_line_names: [BANNAN_LINE],
    preferred_operator_names: [TRTC_OPERATOR],
    institution_filter_mode: "soft",
  };
}

function makeMetroJourney({ id, number, direction, stations }) {
  return {
    id,
    date: "2026-08-02",
    number,
    train_type: "捷運",
    company: TRTC_COMPANY,
    origin: stations[0].name,
    destination: stations.at(-1).name,
    direction,
    visible: true,
    style: { color: BANNAN_COLOR },
    route_policy: routePolicy(),
    route_sections: stations.slice(0, -1).map((item, index) => ({
      from: item.name,
      to: stations[index + 1].name,
      from_n02_station_code: item.code,
      to_n02_station_code: stations[index + 1].code,
      line_names: [BANNAN_LINE],
      operator_names: [TRTC_OPERATOR],
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
            : "passenger_stop",
      ride_segment: true,
    })),
  };
}

const taipeiMainToXimen = makeMetroJourney({
  id: "20260802_02_trtc_bl_taipei_main_ximen",
  number: "台北捷運 板南線（台北車站→西門）",
  direction: "up",
  stations: [
    station("台北車站", "TRTC-BL12", { departure: "14:45" }),
    station("西門", "TRTC-BL11", { arrival: "14:47" }),
  ],
});

const ximenToZhongxiaoFuxing = makeMetroJourney({
  id: "20260802_03_trtc_bl_ximen_zhongxiao_fuxing",
  number: "台北捷運 板南線（西門→忠孝復興）",
  direction: "down",
  stations: [
    station("西門", "TRTC-BL11", { departure: "15:52" }),
    station("台北車站", "TRTC-BL12", {
      arrival: "15:54",
      departure: "15:54",
    }),
    station("善導寺", "TRTC-BL13", {
      arrival: "15:56",
      departure: "15:56",
    }),
    station("忠孝新生", "TRTC-BL14", {
      arrival: "15:58",
      departure: "15:58",
    }),
    station("忠孝復興", "TRTC-BL15", { arrival: "16:00" }),
  ],
});

const zhongxiaoFuxingToXimen = makeMetroJourney({
  id: "20260802_04_trtc_bl_zhongxiao_fuxing_ximen",
  number: "台北捷運 板南線（忠孝復興→西門）",
  direction: "up",
  stations: [
    station("忠孝復興", "TRTC-BL15", { departure: "20:00" }),
    station("忠孝新生", "TRTC-BL14", {
      arrival: "20:02",
      departure: "20:02",
    }),
    station("善導寺", "TRTC-BL13", {
      arrival: "20:04",
      departure: "20:04",
    }),
    station("台北車站", "TRTC-BL12", {
      arrival: "20:06",
      departure: "20:06",
    }),
    station("西門", "TRTC-BL11", { arrival: "20:08" }),
  ],
});

const additions = [
  taipeiMainToXimen,
  ximenToZhongxiaoFuxing,
  zhongxiaoFuxingToXimen,
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
