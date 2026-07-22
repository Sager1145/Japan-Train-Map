import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(
  SCRIPT_DIR,
  "..",
  "data",
  "special-samples",
  "tokyo-limited-express-loop.json",
);
const OPERATOR = "東日本旅客鉄道";
const DATE = "2026-05-29";

const services = [
  ["01", "しおさい1号（4001M）", "特急", "千葉", "004165", "08:10", "成東", "004189", "08:48", ["総武線"], "#0067c0"],
  ["02", "普通 1634M", "普通", "成東", "004190", "09:02", "大網", "004450", "09:19", ["東金線"], "#e9a900"],
  ["03", "わかしお10号（1060M）", "特急", "大網", "004451", "09:47", "東京", "003785", "10:37", ["外房線", "京葉線"], "#00b2e5"],
  ["04", "ひたち8号（8M・予約区間）", "特急", "東京", "003770", "11:43", "品川", "004095", "11:51", ["東海道線"], "#e60012"],
  ["05", "踊り子9号（3029M）", "特急", "品川", "004095", "12:08", "大船", "004959", "12:36", ["東海道線"], "#f68b1e"],
  ["06", "普通（12:41 熱海方面）", "普通", "大船", "004959", "12:41", "茅ヶ崎", "005024", "12:52", ["東海道線"], "#f68b1e"],
  ["07", "普通 1261F（橋本行）", "普通", "茅ヶ崎", "005023", "12:59", "橋本", "004254", "14:20", ["相模線"], "#009793"],
  ["08", "快速（14:25 八王子行）", "快速", "橋本", "004253", "14:25", "八王子", "003953", "14:36", ["横浜線"], "#9acd32"],
  ["09", "かいじ32号（3132M）", "特急", "八王子", "003947", "15:34", "立川", "003634", "15:42", ["中央線"], "#f15a22"],
  ["10", "中央線快速（15:46 東京方面）", "快速", "立川", "003634", "15:46", "西国分寺", "003614", "15:51", ["中央線"], "#f15a22"],
  ["11", "普通（15:59 東京方面）", "普通", "西国分寺", "003611", "15:59", "武蔵浦和", "003006", "16:25", ["武蔵野線"], "#f15a22"],
  ["12", "普通（16:28 大宮行）", "普通", "武蔵浦和", "003008", "16:28", "大宮", "002912", "16:40", ["東北線"], "#00ac9a"],
  ["13", "草津・四万4号（予約区間）", "特急", "大宮", "002912", "17:44", "浦和", "002989", "17:50", ["東北線"], "#e60012"],
  ["14", "スペーシア日光4号（予約区間）", "特急", "浦和", "002989", "18:11", "新宿", "003701", "18:35", ["東北線", "赤羽線", "山手線"], "#e60012"],
  ["15", "あずさ50号（5050M）", "特急", "新宿", "003693", "20:11", "船橋", "003593", "20:38", ["中央線", "総武線"], "#f15a22"],
  ["16", "中央・総武線各駅停車 1904Y（千葉行）", "普通", "船橋", "003593", "20:41", "西千葉", "004124", "21:00", ["総武線"], "#ffd400"],
];

function makeTrain(service) {
  const [
    order,
    number,
    trainType,
    origin,
    originCode,
    departure,
    destination,
    destinationCode,
    arrival,
    lineNames,
    color,
  ] = service;
  return {
    id: `tokyo_limited_express_loop_20260529_${order}`,
    date: DATE,
    number,
    train_type: trainType,
    company: "JR東日本",
    origin,
    destination,
    direction: destination,
    visible: true,
    style: { color },
    route_policy: {
      mode: "single_primary_route",
      jr_only: true,
      allow_alternatives: false,
      allow_browser_straight_line_fallback: false,
      preferred_line_names: lineNames,
      preferred_operator_names: [OPERATOR],
      institution_filter_mode: "soft",
      allowed_institution_type_codes: ["2"],
    },
    route_sections: [
      {
        from_n02_station_code: originCode,
        to_n02_station_code: destinationCode,
        line_names: lineNames,
        operator_names: [OPERATOR],
      },
    ],
    stops: [
      {
        name: origin,
        n02_station_code: originCode,
        arrival: null,
        departure,
        stop_type: "origin",
        ride_segment: true,
      },
      {
        name: destination,
        n02_station_code: destinationCode,
        arrival,
        departure: null,
        stop_type: "destination",
        ride_segment: true,
      },
    ],
  };
}

const store = { schema_version: "1.3", trains: services.map(makeTrain) };
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, `${JSON.stringify(store, null, 2)}\n`);
console.log(`Wrote ${store.trains.length} trains to ${OUTPUT}`);
