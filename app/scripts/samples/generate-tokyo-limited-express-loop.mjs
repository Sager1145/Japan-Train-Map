import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeLoopTrain, writeLoopStore } from "../lib/build-loop-train.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(
  SCRIPT_DIR,
  "..",
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

const SERVICE_DETAILS = {
  "01": {
    passengerStops: ["千葉", "佐倉", "八街", "成東"],
    times: {
      佐倉: { departure: "08:23" },
      八街: { departure: "08:38" },
    },
  },
  "03": {
    routePieces: [
      { to: "蘇我", lineNames: ["外房線"] },
      { to: "東京", lineNames: ["京葉線"] },
    ],
    passengerStops: ["大網", "土気", "蘇我", "東京"],
    times: {
      土気: { arrival: "09:50", departure: "09:51" },
      蘇我: { arrival: "10:00", departure: "10:02" },
    },
  },
  "04": {
    passengerStops: ["東京", "品川"],
  },
  "05": {
    passengerStops: ["品川", "川崎", "横浜", "大船"],
    times: {
      川崎: { arrival: "12:16", departure: "12:16" },
      横浜: { arrival: "12:23", departure: "12:24" },
    },
  },
  "09": {
    passengerStops: ["八王子", "立川"],
  },
  "13": {
    passengerStops: ["大宮", "浦和"],
  },
  "14": {
    company: "JR東日本/東武鉄道",
    routePieces: [
      { to: "赤羽", lineNames: ["東北線"] },
      { to: "池袋", lineNames: ["赤羽線"] },
      { to: "新宿", lineNames: ["山手線"] },
    ],
    passengerStops: ["浦和", "池袋", "新宿"],
    times: {
      池袋: { arrival: "18:29", departure: "18:30" },
    },
  },
  "15": {
    routePieces: [
      { to: "御茶ノ水", lineNames: ["中央線"] },
      { to: "船橋", lineNames: ["総武線"] },
    ],
    passengerStops: ["新宿", "錦糸町", "船橋"],
    times: {
      錦糸町: { arrival: "20:27", departure: "20:27" },
    },
  },
};

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
  return makeLoopTrain({
    order,
    id: `tokyo_limited_express_loop_20260529_${order}`,
    date: DATE,
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
    operator: OPERATOR,
    details: SERVICE_DETAILS[order] || {},
  });
}

writeLoopStore(OUTPUT, services.map(makeTrain));
