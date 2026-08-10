import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_DIR = path.join(APP_DIR, "..");
const SAMPLE_FILE = path.join(
  ROOT_DIR,
  "samples",
  "jr_limited_shinkansen_itinerary_20260703_20260727_n02_v1_3_expanded_pass_through.json",
);
const NEW_YEAR_GRAND_LOOP_FILE = path.join(
  APP_DIR,
  "data",
  "special-samples",
  "new-year-grand-loop.json",
);
const TOKYO_LIMITED_EXPRESS_LOOP_FILE = path.join(
  APP_DIR,
  "data",
  "special-samples",
  "tokyo-limited-express-loop.json",
);

const TRAIN_KEYS = [
  "id",
  "date",
  "number",
  "train_type",
  "company",
  "origin",
  "destination",
  "direction",
  "visible",
  "style",
  "route_policy",
  "route_sections",
  "stops",
];

const STOP_TYPES = new Set([
  "origin",
  "destination",
  "passenger_stop",
  "operational_stop",
  "pass_through",
]);

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function routeFeatureEndpoint(feature, atStart) {
  const geometry = feature?.geometry;
  const lines =
    geometry?.type === "LineString"
      ? [geometry.coordinates]
      : geometry?.type === "MultiLineString"
        ? geometry.coordinates
        : [];
  const line = atStart ? lines[0] : lines.at(-1);
  return atStart ? line?.[0] : line?.at(-1);
}

test("importable sample is the complete canonical train store", async () => {
  const [store, sample] = await Promise.all([
    readJson(path.join(APP_DIR, "data", "train-store.json")),
    readJson(SAMPLE_FILE),
  ]);

  assert.deepEqual(sample, store);
  assert.equal(sample.schema_version, "1.3");
  assert.ok(sample.trains.length > 0);

  const ids = new Set();
  for (const train of sample.trains) {
    assert.deepEqual(Object.keys(train).sort(), [...TRAIN_KEYS].sort());
    assert.match(train.id, /^[a-zA-Z0-9_-]+$/);
    assert.match(train.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof train.train_type, "string");
    assert.ok(train.train_type.length > 0);
    assert.equal(typeof train.company, "string");
    assert.ok(train.company.length > 0);
    assert.equal(ids.has(train.id), false, `duplicate train id: ${train.id}`);
    ids.add(train.id);

    assert.ok(train.stops.length >= 2);
    assert.equal(train.stops[0].stop_type, "origin");
    assert.equal(train.stops.at(-1).stop_type, "destination");
    assert.equal(train.route_sections.length, train.stops.length - 1);

    train.stops.forEach((stop) => {
      assert.equal(typeof stop.name, "string");
      assert.ok(stop.name.length > 0);
      assert.equal(typeof stop.n02_station_code, "string");
      assert.ok(stop.n02_station_code.length > 0);
      assert.ok(STOP_TYPES.has(stop.stop_type));
      assert.equal(typeof stop.ride_segment, "boolean");
      assert.ok(stop.arrival === null || typeof stop.arrival === "string");
      assert.ok(stop.departure === null || typeof stop.departure === "string");
    });

    train.route_sections.forEach((section, index) => {
      assert.equal(
        section.from_n02_station_code,
        train.stops[index].n02_station_code,
      );
      assert.equal(
        section.to_n02_station_code,
        train.stops[index + 1].n02_station_code,
      );
    });
  }
});

test("New Year grand loop is an independent canonical 1.3 store", async () => {
  const store = await readJson(NEW_YEAR_GRAND_LOOP_FILE);
  assert.equal(store.schema_version, "1.3");
  assert.equal(store.trains.length, 39);
  assert.deepEqual(
    [...new Set(store.trains.map((train) => train.date))],
    ["2025-12-31", "2026-01-01"],
  );

  const ids = new Set();
  for (const train of store.trains) {
    assert.deepEqual(Object.keys(train).sort(), [...TRAIN_KEYS].sort());
    assert.match(train.id, /^[a-zA-Z0-9_-]+$/);
    assert.equal(ids.has(train.id), false, `duplicate train id: ${train.id}`);
    ids.add(train.id);
    assert.match(train.company, /JR東日本/);
    assert.ok(train.stops.length >= 2);
    assert.equal(train.stops[0].stop_type, "origin");
    assert.equal(train.stops.at(-1).stop_type, "destination");
    assert.equal(train.route_sections.length, train.stops.length - 1);
    train.route_sections.forEach((section, index) => {
      assert.equal(section.from, train.stops[index].name);
      assert.equal(section.to, train.stops[index + 1].name);
      assert.equal(
        section.from_n02_station_code,
        train.stops[index].n02_station_code,
      );
      assert.equal(
        section.to_n02_station_code,
        train.stops[index + 1].n02_station_code,
      );
      assert.ok(section.line_names.length > 0);
      assert.deepEqual(section.operator_names, ["東日本旅客鉄道"]);
    });
  }

  assert.equal(store.trains[0].company, "東京メトロ/JR東日本");
  assert.equal(store.trains.some((train) => train.number.includes("13:49")), false);
  assert.equal(store.trains.some((train) => train.number.includes("21:03")), false);
  assert.ok(store.trains.some((train) => train.number.includes("14:14")));
  assert.ok(store.trains.some((train) => train.number.includes("21:18")));

  const byId = new Map(store.trains.map((train) => [train.id, train]));
  assert.equal(
    byId.get("new_year_grand_loop_20251231_22").stops.at(-1).arrival,
    "24:29",
  );
  assert.deepEqual(
    byId
      .get("new_year_grand_loop_20251231_05")
      .stops.filter((stop) => stop.stop_type === "pass_through")
      .map((stop) => stop.name),
    ["行田", "吹上", "北鴻巣", "北上尾", "宮原"],
  );
  assert.deepEqual(
    byId
      .get("new_year_grand_loop_20260101_32")
      .stops.filter((stop) => stop.stop_type === "pass_through")
      .map((stop) => stop.name),
    [
      "幕張豊砂",
      "新習志野",
      "二俣新町",
      "市川塩浜",
      "葛西臨海公園",
      "潮見",
      "越中島",
    ],
  );
  assert.deepEqual(
    byId
      .get("new_year_grand_loop_20260101_36")
      .stops.filter((stop) => stop.stop_type !== "pass_through")
      .map((stop) => stop.name),
    ["神田", "御茶ノ水", "四ツ谷", "新宿"],
  );
  assert.deepEqual(
    byId
      .get("new_year_grand_loop_20260101_38")
      .stops.filter((stop) => stop.stop_type === "pass_through")
      .map((stop) => stop.name),
    ["綾瀬", "亀有", "金町"],
  );
});

test("New Year grand-loop parts are separate, complete and fully solved", async () => {
  const [store, manifest, regularManifest] = await Promise.all([
    readJson(NEW_YEAR_GRAND_LOOP_FILE),
    readJson(
      path.join(APP_DIR, "data", "new-year-grand-loop-data", "manifest.json"),
    ),
    readJson(path.join(APP_DIR, "data", "sample-data", "manifest.json")),
  ]);
  assert.equal(manifest.total, 39);
  assert.equal(manifest.solved, 39);
  assert.equal(manifest.unsolvable, 0);
  assert.equal(manifest.no_route, 0);
  assert.deepEqual(Object.keys(manifest.dates), ["2025-12-31", "2026-01-01"]);
  assert.equal(
    regularManifest.parts.some((part) => manifest.parts.includes(part)),
    true,
    "part filenames may repeat across independent directories",
  );
  assert.equal(
    Object.keys(regularManifest.dates).some((date) => date.startsWith("2025-12-31")),
    false,
    "the regular random-sample manifest must not index the grand loop",
  );
  const parts = await Promise.all(
    manifest.parts.map((name) =>
      readJson(
        path.join(APP_DIR, "data", "new-year-grand-loop-data", `${name}.json`),
      ),
    ),
  );
  assert.deepEqual(
    parts.map((part) => part.train.id),
    store.trains.map((train) => train.id),
  );
  assert.equal(
    store.trains.every(
      (train) => !/(?:股份有限公司|管理局|管理處)/.test(train.company),
    ),
    true,
  );
  parts.forEach((part) => {
    assert.equal(typeof part.route?.cache_key, "string");
    assert.ok(part.route.cache_key.length > 0);
    assert.ok(Array.isArray(part.route.features));
    assert.ok(part.route.features.length > 0);
  });
});

test("Tokyo limited-express loop follows the TripIt booking times and revised ending", async () => {
  const store = await readJson(TOKYO_LIMITED_EXPRESS_LOOP_FILE);
  assert.equal(store.schema_version, "1.3");
  assert.equal(store.trains.length, 16);
  assert.deepEqual([...new Set(store.trains.map((train) => train.date))], [
    "2026-05-29",
  ]);

  const booked = [
    ["千葉", "08:10", "成東", "08:48"],
    ["大網", "09:47", "東京", "10:37"],
    ["東京", "11:43", "品川", "11:51"],
    ["品川", "12:08", "大船", "12:36"],
    ["八王子", "15:34", "立川", "15:42"],
    ["大宮", "17:44", "浦和", "17:50"],
    ["浦和", "18:11", "新宿", "18:35"],
    ["新宿", "20:11", "船橋", "20:38"],
  ];
  for (const [origin, departure, destination, arrival] of booked) {
    assert.ok(
      store.trains.some(
        (train) =>
          train.origin === origin &&
          train.destination === destination &&
          train.stops[0].departure === departure &&
          train.stops.at(-1).arrival === arrival,
      ),
      `missing booked segment ${origin} ${departure} -> ${destination} ${arrival}`,
    );
  }

  const tokyoToShinagawa = store.trains.find(
    (train) => train.origin === "東京" && train.destination === "品川",
  );
  assert.equal(tokyoToShinagawa?.number, "ひたち8号（8M・予約区間）");
  const omiyaToUrawa = store.trains.find(
    (train) => train.origin === "大宮" && train.destination === "浦和",
  );
  assert.equal(omiyaToUrawa?.number, "草津・四万4号（予約区間）");
  assert.equal(
    store.trains.some((train) =>
      /ときわ58号|草津・四万82号/.test(train.number),
    ),
    false,
  );

  const finalTrain = store.trains.at(-1);
  assert.equal(finalTrain.origin, "船橋");
  assert.equal(finalTrain.stops[0].departure, "20:41");
  assert.equal(finalTrain.destination, "西千葉");
  assert.equal(finalTrain.stops.at(-1).arrival, "21:00");
  assert.equal(store.trains.some((train) => train.destination === "千葉"), false);

  const expectedPassengerStops = new Map([
    ["tokyo_limited_express_loop_20260529_01", ["千葉", "佐倉", "八街", "成東"]],
    ["tokyo_limited_express_loop_20260529_03", ["大網", "土気", "蘇我", "東京"]],
    ["tokyo_limited_express_loop_20260529_04", ["東京", "品川"]],
    ["tokyo_limited_express_loop_20260529_05", ["品川", "川崎", "横浜", "大船"]],
    ["tokyo_limited_express_loop_20260529_09", ["八王子", "立川"]],
    ["tokyo_limited_express_loop_20260529_13", ["大宮", "浦和"]],
    ["tokyo_limited_express_loop_20260529_14", ["浦和", "池袋", "新宿"]],
    ["tokyo_limited_express_loop_20260529_15", ["新宿", "錦糸町", "船橋"]],
  ]);
  const byId = new Map(store.trains.map((train) => [train.id, train]));
  for (const [id, expectedStops] of expectedPassengerStops) {
    assert.deepEqual(
      byId
        .get(id)
        .stops.filter((stop) => stop.stop_type !== "pass_through")
        .map((stop) => stop.name),
      expectedStops,
      `${id} official passenger stops`,
    );
  }
  assert.equal(
    byId
      .get("tokyo_limited_express_loop_20260529_03")
      .stops.find((stop) => stop.name === "蘇我").departure,
    "10:02",
  );
  assert.equal(
    byId
      .get("tokyo_limited_express_loop_20260529_14")
      .stops.find((stop) => stop.name === "池袋").departure,
    "18:30",
  );
  assert.equal(
    byId.get("tokyo_limited_express_loop_20260529_14").company,
    "JR東日本/東武鉄道",
  );

  for (const train of store.trains) {
    assert.ok(train.stops.length >= 2);
    assert.equal(train.stops[0].stop_type, "origin");
    assert.equal(train.stops.at(-1).stop_type, "destination");
    assert.equal(train.route_sections.length, train.stops.length - 1);
    train.route_sections.forEach((section, index) => {
      assert.equal(section.from, train.stops[index].name);
      assert.equal(section.to, train.stops[index + 1].name);
      assert.equal(
        section.from_n02_station_code,
        train.stops[index].n02_station_code,
      );
      assert.equal(
        section.to_n02_station_code,
        train.stops[index + 1].n02_station_code,
      );
    });
  }
});

test("Tokyo limited-express loop parts are independent and fully solved", async () => {
  const [store, manifest, regularManifest] = await Promise.all([
    readJson(TOKYO_LIMITED_EXPRESS_LOOP_FILE),
    readJson(
      path.join(
        APP_DIR,
        "data",
        "tokyo-limited-express-loop-data",
        "manifest.json",
      ),
    ),
    readJson(path.join(APP_DIR, "data", "sample-data", "manifest.json")),
  ]);
  assert.equal(manifest.total, 16);
  assert.equal(manifest.solved, 16);
  assert.equal(manifest.unsolvable, 0);
  assert.equal(manifest.no_route, 0);
  assert.equal(regularManifest.dates["2026-05-29"], undefined);
  const parts = await Promise.all(
    manifest.parts.map((name) =>
      readJson(
        path.join(
          APP_DIR,
          "data",
          "tokyo-limited-express-loop-data",
          `${name}.json`,
        ),
      ),
    ),
  );
  assert.deepEqual(
    parts.map((part) => part.train.id),
    store.trains.map((train) => train.id),
  );
  parts.forEach((part) => {
    assert.equal(typeof part.route?.cache_key, "string");
    assert.ok(part.route.features.length > 0);
  });
});

test("Kumamoto weekday tram sample uses the official 2026 timetable minutes", async () => {
  const sample = await readJson(SAMPLE_FILE);
  const byId = new Map(sample.trains.map((train) => [train.id, train]));

  const toKarashimacho = byId.get(
    "20260721_10_kumamoto_tram_a_kumamotoeki_karashimacho",
  );
  assert.ok(toKarashimacho);
  assert.equal(
    toKarashimacho.stops.find((stop) => stop.name === "慶徳校前")?.arrival,
    "17:24",
  );
  assert.equal(
    toKarashimacho.stops.find((stop) => stop.name === "辛島町")?.arrival,
    "17:27",
  );

  const toSuidocho = byId.get(
    "20260721_11_kumamoto_tram_karashimacho_suidocho",
  );
  assert.ok(toSuidocho);
  assert.equal(toSuidocho.stops[0].departure, "17:34");
  assert.equal(
    toSuidocho.stops.find((stop) => stop.name === "熊本城・市役所前")
      ?.arrival,
    "17:37",
  );
  assert.equal(toSuidocho.stops.at(-1).arrival, "17:43");
});

test("Kagoshima weekday tram sample uses the official 2026 timetable minutes", async () => {
  const sample = await readJson(SAMPLE_FILE);
  const tram = sample.trains.find(
    (train) =>
      train.id ===
      "20260722_03a_kagoshima_tram_kagoshimachuoeki_miyakodori",
  );

  assert.ok(tram);
  assert.equal(tram.origin, "鹿児島中央駅前");
  assert.equal(tram.destination, "都通");
  assert.equal(tram.stops[0].departure, "09:24");
  assert.equal(tram.stops.at(-1).arrival, "09:25");
});

test("Kagoshima return sample transfers from local 1326D to rapid Nanohana 3328D", async () => {
  const sample = await readJson(SAMPLE_FILE);
  const byId = new Map(sample.trains.map((train) => [train.id, train]));
  const local = byId.get(
    "20260722_03_ibusuki_1326d_nishioyama_minamikagoshima",
  );
  const rapid = byId.get(
    "20260722_03b_nanohana3328d_minamikagoshima_kagoshima",
  );

  assert.ok(local);
  assert.equal(local.stops.at(-1).name, "南鹿児島");
  assert.equal(local.stops.at(-1).arrival, "08:37");
  assert.ok(rapid);
  assert.equal(rapid.train_type, "快速");
  assert.equal(rapid.stops[0].departure, "09:01");
  assert.equal(rapid.stops.at(-1).arrival, "09:07");
});

test("July 22 Kokura evening loop matches the revised itinerary", async () => {
  const sample = await readJson(SAMPLE_FILE);
  const trains = sample.trains.filter((train) =>
    train.id.startsWith("20260722_0") || train.id.startsWith("20260722_1"),
  );
  const revised = trains.filter(
    (train) => train.stops[0].departure >= "20:00",
  );

  assert.deepEqual(
    revised.map((train) => [
      train.origin,
      train.stops[0].departure,
      train.destination,
      train.stops.at(-1).arrival,
    ]),
    [
      ["小倉", "20:05", "黒崎", "20:13"],
      ["黒崎駅前", "20:20", "筑豊直方", "20:54"],
      ["直方", "21:26", "田川伊田", "22:01"],
      ["田川伊田", "22:04", "小倉", "22:53"],
      ["小倉", "23:00", "企救丘", "23:19"],
      ["企救丘", "23:30", "小倉", "23:50"],
    ],
  );
  assert.match(revised[0].number, /ソニック54号.*885系.*白いソニック/);
  assert.equal(revised[3].number, "普通986D（日田彦山線）");
  revised.forEach((train) => {
    assert.equal(train.route_sections.length, train.stops.length - 1);
  });
});

test("July 23 first leg is a single Sakura 740 from Kokura to Okayama", async () => {
  const sample = await readJson(SAMPLE_FILE);
  const trains = sample.trains.filter((train) => train.date === "2026-07-23");
  const [sakura] = trains;

  // The Kodama 940 + Sakura 740 split was consolidated back into one train:
  // the whole first leg is ridden on Sakura 740 (Kokura → Okayama).
  assert.equal(sakura.id, "20260723_01_sakura740");
  assert.equal(sakura.number, "さくら740号（Sakura 740）（740A）");
  assert.equal(sakura.origin, "小倉");
  assert.equal(sakura.stops[0].departure, "07:16");
  assert.equal(sakura.destination, "岡山");
  assert.equal(sakura.stops.at(-1).arrival, "08:50");
  // Its scheduled stops on the 山陽新幹線 (others are pass_through).
  assert.deepEqual(
    sakura.stops
      .filter((stop) => stop.stop_type !== "pass_through")
      .map((stop) => stop.name),
    ["小倉", "新下関", "新山口", "広島", "福山", "岡山"],
  );
});

test("revised July 22 and 23 precomputed routes have continuous section geometry", async () => {
  const manifest = await readJson(
    path.join(APP_DIR, "data", "sample-data", "manifest.json"),
  );
  const revisedIds = new Set([
    "20260722_08_sonic54_kokura_kurosaki",
    "20260722_09_chikuho_electric_kurosaki_nogata",
    "20260722_10_heichiku_ita_nogata_tagawaita",
    "20260722_11_hitahikosan_986d_tagawaita_kokura",
    "20260722_12_monorail_kokura_kikugaoka",
    "20260722_13_monorail_kikugaoka_kokura",
    "20260723_01_sakura740",
  ]);
  const parts = await Promise.all(
    manifest.parts.map((partName) =>
      readJson(
        path.join(APP_DIR, "data", "sample-data", `${partName}.json`),
      ),
    ),
  );

  parts
    .filter((part) => revisedIds.has(part.train.id))
    .forEach((part) => {
      const features = [...part.route.features].sort(
        (a, b) => a.properties.segment_index - b.properties.segment_index,
      );
      for (let index = 0; index < features.length - 1; index += 1) {
        assert.deepEqual(
          features[index].geometry.coordinates.at(-1),
          features[index + 1].geometry.coordinates[0],
          `${part.train.id} breaks between route sections ${index} and ${index + 1}`,
        );
      }
    });
});

test("every Japanese precomputed itinerary is continuous between adjacent ridden sections", async () => {
  const dataDir = path.join(APP_DIR, "data", "sample-data");
  const manifest = await readJson(path.join(dataDir, "manifest.json"));
  const parts = await Promise.all(
    manifest.parts.map((partName) =>
      readJson(path.join(dataDir, `${partName}.json`)),
    ),
  );
  let joinsChecked = 0;

  parts.forEach((part) => {
    const features = [...part.route.features].sort(
      (a, b) =>
        Number(a.properties?.segment_index ?? 0) -
        Number(b.properties?.segment_index ?? 0),
    );
    assert.equal(
      features.length,
      part.train.route_sections.length,
      `${part.train.id} is missing one or more ridden route sections`,
    );
    features.forEach((feature, index) => {
      assert.equal(
        Number(feature.properties?.segment_index),
        index,
        `${part.train.id} is missing ridden route section ${index}`,
      );
    });
    for (let index = 0; index < features.length - 1; index += 1) {
      const previous = features[index];
      const current = features[index + 1];
      if (
        Number(current.properties?.segment_index) !==
        Number(previous.properties?.segment_index) + 1
      ) {
        continue;
      }
      assert.equal(
        current.properties?.from_n02_station_code,
        previous.properties?.to_n02_station_code,
        `${part.train.id} has mismatched boundary metadata at route section ${index + 1}`,
      );
      assert.deepEqual(
        routeFeatureEndpoint(current, true),
        routeFeatureEndpoint(previous, false),
        `${part.train.id} breaks at ${previous.properties?.to || `route section ${index + 1}`}`,
      );
      joinsChecked += 1;
    }
  });

  assert.ok(joinsChecked > 0);
});

test("precomputed sample parts cover every canonical train with solved geometry", async (t) => {
  let manifest;
  try {
    manifest = await readJson(
      path.join(APP_DIR, "data", "sample-data", "manifest.json"),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.skip("precomputed sample data is generated by npm run precompute");
      return;
    }
    throw error;
  }

  const store = await readJson(path.join(APP_DIR, "data", "train-store.json"));
  assert.equal(manifest.total, store.trains.length);
  assert.equal(manifest.solved, store.trains.length);
  assert.equal(manifest.unsolvable, 0);
  assert.equal(manifest.no_route, 0);
  assert.equal(manifest.parts.length, store.trains.length);

  const parts = await Promise.all(
    manifest.parts.map((partName) =>
      readJson(
        path.join(APP_DIR, "data", "sample-data", `${partName}.json`),
      ),
    ),
  );
  assert.deepEqual(
    parts.map((part) => part.train.id),
    store.trains.map((train) => train.id),
  );
  parts.forEach((part) => {
    assert.equal(part.format, 1);
    assert.equal(part.route?.unsolvable, undefined);
    assert.equal(typeof part.route?.cache_key, "string");
    assert.ok(part.route.cache_key.length > 0);
    assert.ok(Array.isArray(part.route.features));
    assert.ok(part.route.features.length > 0);
  });

  const indexedParts = Object.values(manifest.dates).flat();
  assert.deepEqual(indexedParts, manifest.parts);
  assert.deepEqual(
    await readJson(
      path.join(APP_DIR, "data", "sample-data", "sample-full.json"),
    ),
    store,
  );
});

test("Taiwan precomputed parts include every added official-line journey", async (t) => {
  const dataDir = path.join(APP_DIR, "data", "sample-data-tw");
  let manifest;
  try {
    manifest = await readJson(path.join(dataDir, "manifest.json"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.skip("Taiwan sample data is generated by npm run precompute:tw");
      return;
    }
    throw error;
  }

  const store = await readJson(
    path.join(APP_DIR, "data", "train-store-tw.json"),
  );
  const officialSections = await readJson(
    path.join(APP_DIR, "data", "rail-sections-tw.json"),
  );
  assert.equal(manifest.total, 23);
  assert.equal(manifest.total, store.trains.length);
  assert.equal(manifest.solved, store.trains.length);
  assert.equal(manifest.unsolvable, 0);
  assert.equal(manifest.no_route, 0);
  assert.equal(manifest.dates["2026-08-02"].length, 4);
  assert.equal(manifest.dates["2026-08-08"].length, 4);
  assert.equal(manifest.dates["2026-08-09"].length, 4);
  assert.equal(manifest.dates["2026-08-10"].length, 6);

  const parts = await Promise.all(
    manifest.parts.map((partName) =>
      readJson(path.join(dataDir, `${partName}.json`)),
    ),
  );
  assert.deepEqual(
    parts.map((part) => part.train.id),
    store.trains.map((train) => train.id),
  );
  parts.forEach((part) => {
    part.route.features.forEach((feature) => {
      const properties = feature.properties;
      assert.equal(properties.route_choice, "official_interval_exact");
      assert.equal(properties.preserve_ordered_geometry, true);
      const lineName = properties.required_line_names[0];
      const operator = properties.required_operator_names[0];
      const coordinates = feature.geometry.coordinates;
      const matches = officialSections.features
        .filter(
          (candidate) =>
            candidate.properties.line_name === lineName &&
            candidate.properties.operator === operator,
        )
        .flatMap((candidate) => {
          const official = candidate.geometry.coordinates;
          if (
            official[0][0] === coordinates[0][0] &&
            official[0][1] === coordinates[0][1] &&
            official.at(-1)[0] === coordinates.at(-1)[0] &&
            official.at(-1)[1] === coordinates.at(-1)[1]
          )
            return [official];
          if (
            official.at(-1)[0] === coordinates[0][0] &&
            official.at(-1)[1] === coordinates[0][1] &&
            official[0][0] === coordinates.at(-1)[0] &&
            official[0][1] === coordinates.at(-1)[1]
          )
            return [[...official].reverse()];
          return [];
        });
      assert.equal(
        matches.length,
        1,
        `${part.train.id}:${properties.from}→${properties.to} is not one exact official interval`,
      );
      assert.deepEqual(coordinates, matches[0]);
    });
  });

  const metroIds = new Set([
    "20260802_02_trtc_bl_taipei_main_ximen",
    "20260802_03_trtc_bl_ximen_zhongxiao_fuxing",
    "20260802_04_trtc_bl_zhongxiao_fuxing_ximen",
  ]);
  const metroParts = parts.filter((part) => metroIds.has(part.train.id));
  assert.equal(metroParts.length, 3);
  metroParts.forEach((part) => {
    assert.equal(part.route?.unsolvable, undefined);
    assert.equal(
      part.route.features.length,
      part.train.route_sections.length,
      `${part.train.id} did not solve every physical station interval`,
    );
    part.route.features.forEach((feature) => {
      assert.deepEqual(feature.properties.required_line_names, ["板南線"]);
      assert.deepEqual(feature.properties.required_operator_names, [
        "臺北大眾捷運股份有限公司",
      ]);
      assert.deepEqual(feature.properties.used_institution_type_codes, ["3"]);
    });
  });

  const kaohsiungIds = new Set([
    "20260810_01_krtc_red_kaohsiung_gangshan_station",
    "20260810_02_krtc_red_gangshan_station_siaogang",
    "20260810_03_krtc_red_siaogang_sanduo",
    "20260810_04_krtc_red_sanduo_kaisyuan",
    "20260810_05_klrt_c3_counterclockwise_loop",
    "20260810_06_krtc_red_kaisyuan_kaohsiung",
  ]);
  const kaohsiungParts = parts.filter((part) =>
    kaohsiungIds.has(part.train.id),
  );
  assert.equal(kaohsiungParts.length, 6);
  kaohsiungParts.forEach((part) => {
    assert.equal(
      part.route.features.length,
      part.train.route_sections.length,
      `${part.train.id} did not solve every physical station interval`,
    );
    part.route.features.forEach((feature) => {
      assert.deepEqual(feature.properties.required_operator_names, [
        "高雄捷運股份有限公司",
      ]);
      assert.deepEqual(feature.properties.used_institution_type_codes, ["3"]);
    });
  });
  const kaohsiungRedParts = kaohsiungParts.filter(
    (part) => part.train.train_type === "捷運",
  );
  assert.equal(kaohsiungRedParts.length, 5);
  kaohsiungRedParts.forEach((part) => {
    part.route.features.forEach((feature) => {
      assert.deepEqual(feature.properties.required_line_names, [
        "高雄捷運紅線",
      ]);
    });
  });
  const lightRailLoop = kaohsiungParts.find(
    (part) => part.train.id === "20260810_05_klrt_c3_counterclockwise_loop",
  );
  assert.equal(lightRailLoop.route.features.length, 38);
  lightRailLoop.route.features.forEach((feature) => {
    assert.deepEqual(feature.properties.required_line_names, [
      "高雄環狀輕軌",
    ]);
  });
  assert.deepEqual(
    lightRailLoop.route.features
      .filter((_, index) => index === 0 || index === 37)
      .map((feature) => [feature.properties.from, feature.properties.to]),
    [
      ["前鎮之星", "凱旋瑞田"],
      ["凱旋中華", "前鎮之星"],
    ],
  );

  const tra191 = parts.find(
    (part) =>
      part.train.id ===
      "20260808_01_tra_tze_chiang_3000_191_taichung_chiayi",
  );
  assert.ok(tra191);
  assert.equal(tra191.route.features.length, 22);
  assert.deepEqual(
    [...new Set(tra191.route.features.flatMap(
      (feature) => feature.properties.required_line_names,
    ))].sort(),
    ["臺中線", "縱貫線南段"].sort(),
  );
  tra191.route.features.forEach((feature) => {
    assert.deepEqual(feature.properties.required_operator_names, [
      "國營臺灣鐵路股份有限公司",
    ]);
  });

  const alishanIds = new Set([
    "20260808_02_alsr_5_chiayi_alishan",
    "20260809_01_alsr_8_alishan_chiayi",
  ]);
  const alishanParts = parts.filter((part) => alishanIds.has(part.train.id));
  assert.equal(alishanParts.length, 2);
  alishanParts.forEach((part) => {
    assert.equal(part.route.features.length, 16);
    part.route.features.forEach((feature) => {
      assert.deepEqual(feature.properties.required_line_names, ["阿里山線"]);
      assert.deepEqual(feature.properties.required_operator_names, [
        "阿里山林業鐵路及文化資產管理處",
      ]);
    });
  });
  const uphillAlishan = alishanParts.find(
    (part) => part.train.id === "20260808_02_alsr_5_chiayi_alishan",
  );
  const sacredTreeToAlishan = uphillAlishan.route.features.find(
    (feature) =>
      feature.properties.from === "神木" && feature.properties.to === "阿里山",
  );
  assert.equal(
    sacredTreeToAlishan.geometry.coordinates.length,
    86,
    "the Alishan station-throat reversal tail was shortened",
  );

  const shenmuIds = new Set([
    "20260808_03_alsr_120_alishan_shenmu",
    "20260808_04_alsr_121_shenmu_alishan",
  ]);
  const shenmuParts = parts.filter((part) => shenmuIds.has(part.train.id));
  assert.equal(shenmuParts.length, 2);
  shenmuParts.forEach((part) => {
    assert.equal(part.route.features.length, 1);
    assert.deepEqual(part.route.features[0].properties.required_line_names, [
      "神木線",
    ]);
    assert.deepEqual(
      part.route.features[0].properties.required_operator_names,
      ["阿里山林業鐵路及文化資產管理處"],
    );
  });

  const zhushanIds = new Set([
    "20260809_02_alsr_zhushan_observation_alishan_zhushan",
    "20260809_03_alsr_zhushan_observation_zhushan_alishan",
  ]);
  const zhushanParts = parts.filter((part) => zhushanIds.has(part.train.id));
  assert.equal(zhushanParts.length, 2);
  zhushanParts.forEach((part) => {
    assert.equal(part.route.features.length, 2);
    part.route.features.forEach((feature) => {
      assert.deepEqual(feature.properties.required_line_names, ["祝山線"]);
      assert.deepEqual(feature.properties.required_operator_names, [
        "阿里山林業鐵路及文化資產管理處",
      ]);
    });
  });

  const tra125 = parts.find(
    (part) =>
      part.train.id ===
      "20260809_04_tra_tze_chiang_3000_125_chiayi_kaohsiung",
  );
  assert.ok(tra125);
  assert.equal(tra125.route.features.length, 29);
  tra125.route.features.forEach((feature) => {
    assert.deepEqual(feature.properties.required_line_names, ["縱貫線南段"]);
    assert.deepEqual(feature.properties.required_operator_names, [
      "國營臺灣鐵路股份有限公司",
    ]);
  });
  assert.deepEqual(await readJson(path.join(dataDir, "sample-full.json")), store);
});

test("Hiroden line 1 precomputed route stays on the main-line Hatchobori stop", async (t) => {
  let manifest;
  try {
    manifest = await readJson(
      path.join(APP_DIR, "data", "sample-data", "manifest.json"),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.skip("precomputed sample data is generated by npm run precompute");
      return;
    }
    throw error;
  }
  const dateParts = await Promise.all(
    (manifest.dates["2026-07-20"] || []).map((partName) =>
      readJson(
        path.join(APP_DIR, "data", "sample-data", `${partName}.json`),
      ),
    ),
  );
  const part = dateParts.find(
    (candidate) =>
      candidate.train.id ===
      "20260720_41_hiroden1_hiroshimaeki_fukuromachi",
  );
  assert.ok(part, "Hiroden line 1 sample part is missing");

  const hatchoboriSegments = part.route.features.filter(
    (feature) =>
      feature.properties.from_n02_station_code === "008058" ||
      feature.properties.to_n02_station_code === "008058",
  );
  assert.equal(hatchoboriSegments.length, 2);
  hatchoboriSegments.forEach((feature) => {
    const gaps = feature.properties.endpoint_display_gap_m;
    assert.ok(
      Math.max(gaps.from, gaps.to) < 60,
      `Hatchobori endpoint jumped off the main line: ${JSON.stringify(gaps)}`,
    );
  });

  const orderedSegments = [...part.route.features].sort(
    (a, b) => a.properties.segment_index - b.properties.segment_index,
  );
  for (let index = 0; index < orderedSegments.length - 1; index += 1) {
    const currentCoordinates = orderedSegments[index].geometry.coordinates;
    const nextCoordinates = orderedSegments[index + 1].geometry.coordinates;
    assert.deepEqual(
      currentCoordinates.at(-1),
      nextCoordinates[0],
      `Hiroden route breaks between segment ${index} and ${index + 1}`,
    );
  }
});
