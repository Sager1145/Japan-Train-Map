"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadI18n() {
  const listeners = {};
  const window = {
    navigator: { language: "zh-TW" },
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      readyState: "complete",
      documentElement: { lang: "", dataset: {} },
      getElementById: () => null,
      querySelectorAll: () => [],
      addEventListener(type, listener) {
        listeners[type] = listener;
      },
    },
    addEventListener() {},
    dispatchEvent() {},
    CustomEvent: function CustomEvent(type, init) {
      return { type, detail: init && init.detail };
    },
  };
  window.window = window;
  window.globalThis = window;
  const context = vm.createContext(window);
  for (const filename of ["app-core.js", "i18n-strings.js", "i18n.js"]) {
    const sourceDir = filename === "app-core.js" ? "../shared" : "../public";
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, sourceDir, filename), "utf8"),
      context,
      { filename },
    );
  }
  return context;
}

test("Taiwan station names switch among the four official/fallback languages", () => {
  const context = loadI18n();
  const table = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../data/station-readings-tw.json"), "utf8"),
  );
  context.table = table;
  vm.runInContext('I18N.setCountry("tw"); I18N.setStationReadings(table);', context);

  const stationName = (lang, name, code) => {
    context.lang = lang;
    context.name = name;
    context.code = code;
    return vm.runInContext(
      "I18N.setLang(lang); I18N.stationName(name, code);",
      context,
    );
  };

  assert.equal(stationName("zh-Hant", "台北車站", "TYMC-A1"), "台北車站");
  assert.equal(stationName("zh-Hans", "台北車站", "TYMC-A1"), "台北车站");
  assert.equal(stationName("ja", "台北車站", "TYMC-A1"), "台北駅");
  assert.equal(stationName("en", "台北車站", "TYMC-A1"), "Taipei Main Station");

  // TRA publishes no official Japanese translation for this record, so display
  // safely falls back to its official Traditional name while the table stays empty.
  assert.equal(stationName("ja", "臺北", "TRA-1000"), "臺北");
  assert.equal(table.byCode["TRA-1000"].ja, "");
});

test("Taiwan no longer resolves same-named stations through Japan readings", () => {
  const context = loadI18n();
  const taiwan = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../data/station-readings-tw.json"), "utf8"),
  );
  context.taiwan = taiwan;
  vm.runInContext(
    'I18N.setCountry("tw"); I18N.setStationReadings(taiwan); I18N.setLang("en");',
    context,
  );
  assert.equal(
    vm.runInContext('I18N.placeName("板橋", "TRA-1020")', context),
    "Banqiao",
  );
  assert.equal(
    vm.runInContext('I18N.placeName("松山", "TRA-0990")', context),
    "Songshan",
  );
  assert.equal(vm.runInContext('I18N.nameReadingsList("板橋", "TRA-1020").length', context), 0);
});

test("region labels and island-wide statistics follow the active region and language", () => {
  const context = loadI18n();
  const translated = (country, lang, key) => {
    context.country = country;
    context.lang = lang;
    context.key = key;
    return vm.runInContext(
      "I18N.setCountry(country); I18N.setLang(lang); I18N.tc(key);",
      context,
    );
  };

  assert.equal(translated("jp", "zh-Hant", "country.label"), "地區");
  assert.equal(translated("tw", "zh-Hans", "country.label"), "地区");
  assert.equal(translated("tw", "ja", "country.label"), "地域");
  assert.equal(translated("tw", "en", "country.label"), "Region");

  assert.equal(translated("jp", "zh-Hant", "stat.all"), "全國");
  assert.equal(translated("tw", "zh-Hant", "stat.all"), "全島");
  assert.equal(translated("tw", "zh-Hans", "stat.all"), "全岛");
  assert.equal(translated("tw", "ja", "stat.all"), "全島");
  assert.equal(translated("tw", "en", "stat.all"), "Island-wide");

  assert.equal(
    translated("tw", "zh-Hant", "status.countrySwitchFailed"),
    "切換地區失敗：{msg}",
  );
  assert.equal(
    translated("tw", "en", "status.countrySwitchFailed"),
    "Region switch failed: {msg}",
  );
});
