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
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "../public", filename), "utf8"),
      context,
      { filename },
    );
  }
  return context;
}

function readReadings(country) {
  return JSON.parse(
    fs.readFileSync(
      path.join(__dirname, `../data/station-readings-${country}.json`),
      "utf8",
    ),
  );
}

test("Hong Kong station names localize like Taiwan's (no Japanese reading sublines)", () => {
  const context = loadI18n();
  context.table = readReadings("hk");
  vm.runInContext(
    'I18N.setCountry("hk"); I18N.setStationReadings(table);',
    context,
  );

  const stationName = (lang, name, code) => {
    context.lang = lang;
    context.name = name;
    context.code = code;
    return vm.runInContext(
      "I18N.setLang(lang); I18N.stationName(name, code);",
      context,
    );
  };

  assert.equal(stationName("zh-Hant", "九龍", "AEL-MTR-KOW"), "九龍");
  assert.equal(stationName("zh-Hans", "九龍", "AEL-MTR-KOW"), "九龙");
  assert.equal(stationName("en", "九龍", "AEL-MTR-KOW"), "Kowloon");
  // MTR publishes no Japanese translation; display falls back to the official
  // Traditional name while the table keeps the field empty.
  assert.equal(stationName("ja", "九龍", "AEL-MTR-KOW"), "九龍");
  assert.equal(context.table.byCode["AEL-MTR-KOW"].ja, "");

  // The network-specific simplification (MTR's own simplified site spelling).
  assert.equal(stationName("zh-Hans", "鰂魚涌", "ISL-MTR-QUB"), "鲗鱼涌");

  // Localized-name mode: the reading subline machinery stays off for HK.
  assert.equal(
    vm.runInContext('I18N.nameReadingsList("九龍", "AEL-MTR-KOW").length', context),
    0,
  );
  assert.equal(
    vm.runInContext('I18N.setLang("en"); I18N.placeName("烏溪沙", "TML-MTR-WKS")', context),
    "Wu Kai Sha",
  );
});

test("Macao station names localize through the MO readings table", () => {
  const context = loadI18n();
  context.table = readReadings("mo");
  vm.runInContext(
    'I18N.setCountry("mo"); I18N.setStationReadings(table);',
    context,
  );
  assert.equal(
    vm.runInContext(
      'I18N.setLang("en"); I18N.stationName("媽閣", "MLM-TAIPA-MLM-BARRA")',
      context,
    ),
    "Barra",
  );
  assert.equal(
    vm.runInContext(
      'I18N.setLang("zh-Hans"); I18N.stationName("媽閣", "MLM-TAIPA-MLM-BARRA")',
      context,
    ),
    "妈阁",
  );
});

test("Hong Kong and Macao region variants resolve across the UI languages", () => {
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

  assert.equal(translated("hk", "zh-Hant", "country.hk"), "香港");
  assert.equal(translated("mo", "zh-Hant", "country.mo"), "澳門");
  assert.equal(translated("mo", "en", "country.mo"), "Macao");

  assert.equal(translated("hk", "zh-Hant", "stat.all"), "全港");
  assert.equal(translated("hk", "en", "stat.all"), "Territory-wide");
  assert.equal(translated("hk", "ja", "stat.all"), "香港全域");
  assert.equal(translated("mo", "zh-Hant", "stat.all"), "全澳");

  // The two coverage buckets STAT_CATEGORIES_BY_COUNTRY.hk points at.
  assert.equal(translated("hk", "zh-Hant", "stat.metro"), "港鐵重鐵");
  assert.equal(translated("hk", "en", "stat.metro"), "MTR heavy rail");
  assert.equal(translated("hk", "zh-Hant", "stat.tram"), "輕鐵");
  assert.equal(translated("mo", "zh-Hant", "stat.metro"), "澳門輕軌");

  assert.equal(translated("hk", "zh-Hant", "btn.loadSampleAllHk"), "載入香港示例資料");
  assert.equal(translated("mo", "zh-Hant", "btn.loadSampleAllMo"), "載入澳門示例資料");
  assert.equal(translated("hk", "zh-Hant", "app.title"), "香港鐵路列車管理");
});
