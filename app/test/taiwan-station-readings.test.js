"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const TABLE_PATH = path.join(__dirname, "../data/station-readings-tw.json");
const PACKAGE_PATH = path.join(__dirname, "../public/rail/tw-2025.json");
const STORE_PATH = path.join(__dirname, "../data/train-store-tw.json");

test("Taiwan station table covers every network alias and canonical sample UID", () => {
  const table = JSON.parse(fs.readFileSync(TABLE_PATH, "utf8"));
  const compactPackage = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));

  assert.equal(table.country, "TW");
  assert.deepEqual(table.languages, ["zh-Hant", "zh-Hans", "ja", "en"]);
  assert.equal(table.stats.byCode, 1149);
  assert.equal(table.stats.officialStationUIDs, 544);
  assert.equal(table.stats.matchedOfficialStationUIDs, 529);
  assert.equal(table.stats.networkAliases, 586);
  assert.equal(table.stats.fallbackAliases, 23);

  // Keep line-specific interchange codes even when the compact display map
  // merges them into one physical station marker.
  assert.equal(table.byCode["TRTC-R10"].en, "Taipei Main Station");

  for (const line of compactPackage.lines) {
    for (const station of line.stations) {
      const code = `${line.id}:${station[0]}`;
      const row = table.byCode[code];
      assert.ok(row, `missing network station alias ${code}`);
      assert.equal(typeof row.zh_Hant, "string");
      assert.ok(row.zh_Hant, `${code} has no official Traditional name`);
      assert.equal(typeof row.zh_Hans, "string");
      assert.ok(row.zh_Hans, `${code} has no Simplified fallback`);
      assert.equal(typeof row.ja, "string");
      assert.equal(typeof row.en, "string");
    }
  }

  for (const train of store.trains) {
    for (const stop of train.stops) {
      if (!stop.n02_station_code) continue;
      assert.ok(
        table.byCode[stop.n02_station_code],
        `missing canonical Taiwan code ${stop.n02_station_code}`,
      );
    }
  }
});

test("Taiwan station translations use official values and documented fallbacks", () => {
  const table = JSON.parse(fs.readFileSync(TABLE_PATH, "utf8"));

  assert.deepEqual(table.byCode["TYMC-A1"], {
    name: "台北車站",
    zh_Hant: "台北車站",
    zh_Hans: "台北车站",
    ja: "台北駅",
    en: "Taipei Main Station",
  });
  assert.deepEqual(table.byCode["TRA-1000"], {
    name: "臺北",
    zh_Hant: "臺北",
    zh_Hans: "台北",
    ja: "",
    en: "Taipei",
  });
  assert.deepEqual(table.byCode["NTDLRT-V01"], {
    name: "紅樹林",
    zh_Hant: "紅樹林",
    zh_Hans: "红树林",
    ja: "紅樹林",
    en: "Hongshulin",
  });
  assert.deepEqual(table.byCode["NTMC-LB08"], {
    name: "鶯歌車站",
    zh_Hant: "鶯歌車站",
    zh_Hans: "莺歌车站",
    ja: "",
    en: "Yingge Railway Station",
  });

  const alishan =
    table.byCode[
      "tw-alsr-alishan:tw-official-afr-q0000004483"
    ];
  assert.deepEqual(alishan, {
    name: "鹿麻產",
    zh_Hant: "鹿麻產",
    zh_Hans: "鹿麻产",
    ja: "",
    en: "",
  });
  assert.deepEqual(table.byCode["AFR-Q0000004483"], alishan);

  // Ambiguous names require an exact StationUID: Taipei and Taichung publish
  // different official English translations for 市政府.
  assert.equal(table.byName["市政府"], undefined);
  assert.equal(table.byCode["TRTC-BL18"].en, "Taipei City Hall");
  assert.equal(table.byCode["TMRT-G9"].en, "Taichung City Hall");
});
