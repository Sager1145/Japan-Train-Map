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
    assert.equal(train.company, "JR東日本");
    assert.equal(train.stops.length, 2);
    assert.equal(train.stops[0].stop_type, "origin");
    assert.equal(train.stops[1].stop_type, "destination");
    assert.equal(train.route_sections.length, 1);
    assert.equal(
      train.route_sections[0].from_n02_station_code,
      train.stops[0].n02_station_code,
    );
    assert.equal(
      train.route_sections[0].to_n02_station_code,
      train.stops[1].n02_station_code,
    );
  }

  assert.equal(store.trains.some((train) => train.number.includes("13:49")), false);
  assert.equal(store.trains.some((train) => train.number.includes("21:03")), false);
  assert.ok(store.trains.some((train) => train.number.includes("14:14")));
  assert.ok(store.trains.some((train) => train.number.includes("21:18")));
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

test("July 23 starts with 500-series Kodama 940 and Sakura 740 at Shin-Yamaguchi", async () => {
  const sample = await readJson(SAMPLE_FILE);
  const trains = sample.trains.filter((train) => train.date === "2026-07-23");
  const [kodama, sakura] = trains;

  assert.equal(kodama.number, "こだま940号（500系）");
  assert.deepEqual(
    kodama.stops.map((stop) => [stop.name, stop.arrival, stop.departure]),
    [
      ["小倉", null, "06:39"],
      ["新下関", "06:47", "06:51"],
      ["厚狭", "07:01", "07:06"],
      ["新山口", "07:15", null],
    ],
  );
  assert.equal(sakura.number, "さくら740号（Sakura 740）（740A）");
  assert.equal(sakura.origin, "新山口");
  assert.equal(sakura.stops[0].departure, "07:38");
  assert.equal(sakura.destination, "岡山");
  assert.equal(sakura.stops.at(-1).arrival, "08:50");
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
    "20260723_01a_kodama940_kokura_shinyamaguchi",
    "20260723_01b_sakura740_shinyamaguchi_okayama",
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
