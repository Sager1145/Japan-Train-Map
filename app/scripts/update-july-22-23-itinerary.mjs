import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_DIR = path.resolve(APP_DIR, "..");
const STORE_FILES = [
  path.join(APP_DIR, "data", "train-store.json"),
  path.join(
    REPO_DIR,
    "samples",
    "jr_limited_shinkansen_itinerary_20260703_20260727_n02_v1_3_expanded_pass_through.json",
  ),
];

const replacedIds = new Set([
  "20260722_08_kasasagi110",
  "20260722_09_kagoshima_local_2235m",
  "20260722_10_nichirin_seagaia14",
  "20260722_11_kodama880",
  "20260723_01_sakura740",
]);

const replacementPrefixes = [
  "20260722_08_",
  "20260722_09_",
  "20260722_10_",
  "20260722_11_",
  "20260722_12_",
  "20260722_13_",
  "20260723_01a_",
  "20260723_01b_",
];

function station(name, code, options = {}) {
  return { name, code, ...options };
}

function makeTrain({
  id,
  date,
  number,
  trainType,
  company,
  direction,
  color,
  institutionTypes,
  operator,
  stations,
}) {
  const lineNames = [...new Set(stations.slice(0, -1).map((item) => item.line))];
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
    route_policy: {
      mode: "single_primary_route",
      jr_only: company.startsWith("JR"),
      allow_alternatives: false,
      allow_browser_straight_line_fallback: false,
      allowed_institution_type_codes: institutionTypes,
      preferred_line_names: lineNames,
      preferred_operator_names: [operator],
      institution_filter_mode: "soft",
    },
    route_sections: stations.slice(0, -1).map((item, index) => ({
      from_n02_station_code: item.code,
      to_n02_station_code: stations[index + 1].code,
      line_names: [item.line],
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

const kagoshimaLine = "鹿児島線";
const chikuhoLine = "筑豊電気鉄道線";
const itaLine = "伊田線";
const hitahikosanLine = "日田彦山線";
const nippoLine = "日豊線";
const kokuraLine = "小倉線";
const sanyoShinkansen = "山陽新幹線";

const sonic54 = makeTrain({
  id: "20260722_08_sonic54_kokura_kurosaki",
  date: "2026-07-22",
  number: "ソニック54号（885系「白いソニック」）",
  trainType: "特急",
  company: "JR九州",
  direction: "博多",
  color: "#b45309",
  institutionTypes: ["2"],
  operator: "九州旅客鉄道",
  stations: [
    station("小倉", "008683", { departure: "20:05", line: kagoshimaLine }),
    station("西小倉", "008679", { stopType: "pass_through", line: kagoshimaLine }),
    station("九州工大前", "008664", { stopType: "pass_through", line: kagoshimaLine }),
    station("戸畑", "008667", { stopType: "pass_through", line: kagoshimaLine }),
    station("枝光", "008690", { stopType: "pass_through", line: kagoshimaLine }),
    station("スペースワールド", "008697", { stopType: "pass_through", line: kagoshimaLine }),
    station("八幡", "008700", { stopType: "pass_through", line: kagoshimaLine }),
    station("黒崎", "008702", { arrival: "20:13" }),
  ],
});

const chikuhoElectric = makeTrain({
  id: "20260722_09_chikuho_electric_kurosaki_nogata",
  date: "2026-07-22",
  number: "筑豊電気鉄道（黒崎駅前→筑豊直方）",
  trainType: "普通",
  company: "筑豊電気鉄道",
  direction: "筑豊直方",
  color: "#e67e22",
  institutionTypes: ["4"],
  operator: "筑豊電気鉄道",
  stations: [
    station("黒崎駅前", "008703", { departure: "20:20", line: chikuhoLine }),
    ...[
      ["西黒崎", "008704"], ["熊西", "008705"], ["萩原", "008711"],
      ["穴生", "008715"], ["森下", "008718"], ["今池", "008747"],
      ["永犬丸", "008770"], ["三ヶ森", "008776"], ["西山", "008782"],
      ["通谷", "008789"], ["東中間", "008793"], ["筑豊中間", "008799"],
      ["希望が丘高校前", "008806"], ["筑豊香月", "008814"], ["楠橋", "008826"],
      ["新木屋瀬", "008832"], ["木屋瀬", "008836"], ["遠賀野", "008844"],
      ["感田", "008853"],
    ].map(([name, code]) => station(name, code, { line: chikuhoLine })),
    station("筑豊直方", "008857", { arrival: "20:54" }),
  ],
});

const heichiku = makeTrain({
  id: "20260722_10_heichiku_ita_nogata_tagawaita",
  date: "2026-07-22",
  number: "平成筑豊鉄道 伊田線（直方→田川伊田）",
  trainType: "普通",
  company: "平成筑豊鉄道",
  direction: "田川伊田",
  color: "#2e8b57",
  institutionTypes: ["5"],
  operator: "平成筑豊鉄道",
  stations: [
    station("直方", "008861", { departure: "21:26", line: itaLine }),
    station("南直方御殿口", "008864", { arrival: "21:28", departure: "21:28", line: itaLine }),
    station("あかぢ", "008873", { arrival: "21:31", departure: "21:31", line: itaLine }),
    station("藤棚", "008876", { arrival: "21:33", departure: "21:33", line: itaLine }),
    station("中泉", "008878", { arrival: "21:35", departure: "21:35", line: itaLine }),
    station("市場", "008888", { arrival: "21:39", departure: "21:39", line: itaLine }),
    station("ふれあい生力", "008893", { arrival: "21:41", departure: "21:41", line: itaLine }),
    station("赤池", "008900", { arrival: "21:43", departure: "21:43", line: itaLine }),
    station("人見", "008905", { arrival: "21:45", departure: "21:45", line: itaLine }),
    station("金田", "008909", { arrival: "21:47", departure: "21:48", line: itaLine }),
    station("上金田", "008919", { arrival: "21:51", departure: "21:51", line: itaLine }),
    station("糒", "008925", { arrival: "21:54", departure: "21:54", line: itaLine }),
    station("田川市立病院", "008929", { arrival: "21:56", departure: "21:56", line: itaLine }),
    station("下伊田", "008940", { arrival: "21:58", departure: "21:58", line: itaLine }),
    station("田川伊田", "008960", { arrival: "22:01" }),
  ],
});

const hitahikosan986d = makeTrain({
  id: "20260722_11_hitahikosan_986d_tagawaita_kokura",
  date: "2026-07-22",
  number: "普通986D（日田彦山線）",
  trainType: "普通",
  company: "JR九州",
  direction: "小倉",
  color: "#2563eb",
  institutionTypes: ["2"],
  operator: "九州旅客鉄道",
  stations: [
    station("田川伊田", "008959", { departure: "22:04", line: hitahikosanLine }),
    ...[
      ["一本松", "008934"], ["香春", "008924"], ["採銅所", "008889"],
      ["呼野", "008856"], ["石原町", "008831"], ["志井", "008811"],
      ["志井公園", "008798"], ["石田", "008778"],
    ].map(([name, code]) => station(name, code, { line: hitahikosanLine })),
    station("城野", "008714", { line: nippoLine }),
    station("南小倉", "008698", { line: nippoLine }),
    station("西小倉", "008680", { line: nippoLine }),
    station("小倉", "008684", { arrival: "22:53" }),
  ],
});

const monorailStations = [
  ["小倉", "008685"], ["平和通", "008688"], ["旦過", "008689"],
  ["香春口三萩野", "008696"], ["片野", "008706"], ["城野", "008712"],
  ["北方", "008731"], ["競馬場前", "008752"], ["守恒", "008771"],
  ["徳力公団前", "008781"], ["徳力嵐山口", "008786"], ["志井", "008792"],
  ["企救丘", "008794"],
];

function monorailTrain({ id, direction, times, reverse = false }) {
  const ordered = reverse ? [...monorailStations].reverse() : monorailStations;
  return makeTrain({
    id,
    date: "2026-07-22",
    number: `北九州モノレール（${ordered[0][0]}→${ordered.at(-1)[0]}）`,
    trainType: "モノレール",
    company: "北九州高速鉄道",
    direction,
    color: "#005bac",
    institutionTypes: ["5"],
    operator: "北九州高速鉄道",
    stations: ordered.map(([name, code], index) =>
      station(name, code, {
        arrival: index === 0 ? null : times[index],
        departure: index === ordered.length - 1 ? null : times[index],
        line: index === ordered.length - 1 ? undefined : kokuraLine,
      }),
    ),
  });
}

const monorailOut = monorailTrain({
  id: "20260722_12_monorail_kokura_kikugaoka",
  direction: "企救丘",
  times: ["23:00", "23:01", "23:02", "23:04", "23:06", "23:07", "23:09", "23:10", "23:12", "23:14", "23:15", "23:17", "23:19"],
});

const monorailBack = monorailTrain({
  id: "20260722_13_monorail_kikugaoka_kokura",
  direction: "小倉",
  reverse: true,
  times: ["23:30", "23:31", "23:33", "23:35", "23:37", "23:38", "23:40", "23:42", "23:43", "23:45", "23:47", "23:48", "23:50"],
});

const kodama940 = makeTrain({
  id: "20260723_01a_kodama940_kokura_shinyamaguchi",
  date: "2026-07-23",
  number: "こだま940号（500系）",
  trainType: "新幹線",
  company: "JR西日本",
  direction: "新大阪",
  color: "#1d4ed8",
  institutionTypes: ["1"],
  operator: "西日本旅客鉄道",
  stations: [
    station("小倉", "008682", { departure: "06:39", line: sanyoShinkansen }),
    station("新下関", "008577", { arrival: "06:47", departure: "06:51", line: sanyoShinkansen }),
    station("厚狭", "008528", { arrival: "07:01", departure: "07:06", line: sanyoShinkansen }),
    station("新山口", "008479", { arrival: "07:15" }),
  ],
});

const sakura740 = makeTrain({
  id: "20260723_01b_sakura740_shinyamaguchi_okayama",
  date: "2026-07-23",
  number: "さくら740号（Sakura 740）（740A）",
  trainType: "新幹線",
  company: "JR西日本",
  direction: "新大阪",
  color: "#d35400",
  institutionTypes: ["1"],
  operator: "西日本旅客鉄道",
  stations: [
    station("新山口", "008479", { departure: "07:38", line: sanyoShinkansen }),
    station("徳山", "008530", { stopType: "pass_through", line: sanyoShinkansen }),
    station("新岩国", "008430", { stopType: "pass_through", line: sanyoShinkansen }),
    station("広島", "008025", { arrival: "08:09", departure: "08:10", line: sanyoShinkansen }),
    station("東広島", "008080", { stopType: "pass_through", line: sanyoShinkansen }),
    station("三原", "008017", { stopType: "pass_through", line: sanyoShinkansen }),
    station("新尾道", "007969", { stopType: "pass_through", line: sanyoShinkansen }),
    station("福山", "007864", { arrival: "08:33", departure: "08:34", line: sanyoShinkansen }),
    station("新倉敷", "007697", { stopType: "pass_through", line: sanyoShinkansen }),
    station("岡山", "007329", { arrival: "08:50" }),
  ],
});

const replacements = [
  sonic54,
  chikuhoElectric,
  heichiku,
  hitahikosan986d,
  monorailOut,
  monorailBack,
  kodama940,
  sakura740,
];

function departureOf(train) {
  return train.stops[0]?.departure ?? "99:99";
}

function updateStore(store) {
  const trains = store.trains.filter(
    (train) =>
      !replacedIds.has(train.id) &&
      !replacementPrefixes.some((prefix) => train.id.startsWith(prefix)),
  );
  trains.push(...replacements);
  trains.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      departureOf(a).localeCompare(departureOf(b)) ||
      a.id.localeCompare(b.id),
  );
  return { schema_version: "1.3", trains };
}

const sourceStore = JSON.parse(fs.readFileSync(STORE_FILES[0], "utf8"));
const updatedStore = updateStore(sourceStore);
const output = `${JSON.stringify(updatedStore, null, 2)}\n`;
for (const file of STORE_FILES) {
  fs.writeFileSync(file, output);
  console.log(`Updated ${path.relative(REPO_DIR, file)}`);
}
