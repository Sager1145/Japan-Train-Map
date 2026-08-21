// =========================================================================
//  i18n.json — the answers i18n.js gives today, and the String Catalog it
//              hands the Swift app instead of its two JavaScript catalogs
//
//  Two jobs live here, and the split is the point.
//
//  THE CATALOGS ARE DATA. i18n-strings.js holds 432 keys × { zh, en } plus a
//  complete Japanese overlay. Those belong in the iOS app as a resource, not
//  as transcribed Swift source, so this module writes them to
//  ios/Resources/Localizable.xcstrings — generated from the real JavaScript, on
//  every fixture run, because a hand-copied translation table is a table that
//  goes stale silently and no test can tell.
//
//  THE RUNTIME IS LOGIC. t / tc, the country-variant key rule, the four
//  per-language fallback chains and the place-name glosses are a port like any
//  other, so the rest of this file freezes what they return.
//
//  ── the one thing the catalog folds in ─────────────────────────────────
//
//  The app has four UI languages but only three maintained ones. Simplified
//  Chinese is DERIVED at runtime: t() runs the Traditional copy through
//  toSimplifiedChinese(), a 236-entry character/phrase map that lives in
//  i18n.js and is reachable from nowhere else. So the emitted catalog carries
//  zh-Hans as a materialised localisation — computed here by calling the real
//  t() with the language set to zh-Hans, never by re-typing the map — and the
//  Swift port has no converter at all.
//
//  That is a deliberate asymmetry: three languages keep their fallback chains
//  in the port, and the fourth is pre-folded because it is a derivation rather
//  than a translation. It also removes the whole class of bug where one entry
//  of a 236-row table is mistyped in Swift and one screen quietly reads wrong.
//
//  Every entry gets a zh-Hans localisation, including entries that would fall
//  back — t() under zh-Hans always returns a string, even for an entry with no
//  zh and no en, where it simplifies the KEY. Pre-folding all of it is what
//  lets the Swift rule for zh-Hans be a plain lookup with no residue.
//
//  ── running it ─────────────────────────────────────────────────────────
//
//      cd app && node scripts/build/build-port-fixtures.mjs
//
//  regenerates the fixture AND rewrites ios/Resources/Localizable.xcstrings.
//  With --check neither is written; the catalog is compared against the file
//  on disk and a difference fails the gate, because a stale catalog is a
//  shipped app disagreeing with the web app it was forked from.
// =========================================================================

import fs from "node:fs";
import path from "node:path";

export const name = "i18n.json";

// The four UI languages, in the order i18n.js lists them in SUPPORTED.
const LANGUAGES = ["zh-Hant", "zh-Hans", "ja", "en"];

// The countries I18N.setCountry accepts, plus a set it does not. The whitelist
// has bitten before: a country outside it silently becomes "jp", so every
// country-variant string reverts to the Japanese copy rather than failing.
const WHITELISTED_COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];
const REJECTED_COUNTRIES = ["us", "", null, "JP", "TW", "jp ", "japan"];
const PROBED_COUNTRIES = [...WHITELISTED_COUNTRIES, "us"];

// Property names that exist on Object.prototype. STRINGS and JA_STRINGS are
// plain object literals, so `STRINGS[key]` walks the prototype chain and these
// keys "exist". See the prototypeKeys section for what that does.
const PROTOTYPE_KEYS = [
  "toString",
  "constructor",
  "__proto__",
  "valueOf",
  "hasOwnProperty",
  "propertyIsEnumerable",
];

// ── loading the real scripts ─────────────────────────────────────────────
//
// i18n-strings.js and i18n.js are classic scripts sharing one global lexical
// scope, and i18n.js touches the DOM on load (its own DOMContentLoaded pass
// calls applyStatic). Evaluating them is the whole point — a fixture built
// from a re-typed copy of 432 translations would only prove the copy and the
// port agree, which is not the question — so the host objects are stubbed just
// far enough for the file to run.
//
// The stubs are deliberately inert rather than DOM-like: applyStatic and the
// <select> wiring are the parts of i18n.js this port does NOT cover, and a
// stub that did something would let a DOM behaviour leak into the fixture.

function readCatalogs(APP_DIR) {
  const source = fs.readFileSync(
    path.join(APP_DIR, "public", "i18n-strings.js"),
    "utf8",
  );
  const scope = {};
  new Function("window", source)(scope);
  return scope.I18NStrings;
}

// NAMES and KANA — the proper-noun glosses — are closure-local consts inside
// i18n.js's IIFE, so no amount of loading reaches them. Rather than re-type 48
// entries into this file, the export list is widened by one anchored
// substitution: the real objects come out, and if the anchor ever moves the
// substitution throws instead of silently exporting nothing.
const GLOSS_ANCHOR = "  window.I18N = {";
const GLOSS_EXPORT = "  window.__i18nGlosses = { NAMES, KANA };\n";

function loadI18N(APP_DIR, AppCore, catalogs) {
  let source = fs.readFileSync(path.join(APP_DIR, "public", "i18n.js"), "utf8");
  if (!source.includes(GLOSS_ANCHOR))
    throw new Error(
      `i18n.js no longer contains ${JSON.stringify(GLOSS_ANCHOR)} — the gloss ` +
        `export in scripts/build/port-fixtures/i18n.mjs needs a new anchor`,
    );
  source = source.replace(GLOSS_ANCHOR, GLOSS_EXPORT + GLOSS_ANCHOR);

  const document = {
    // "complete" runs init() synchronously, which is the state every caller of
    // I18N sees in the browser. "loading" would defer it to a listener that
    // never fires here, leaving the module in a different state than the app's.
    readyState: "complete",
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    documentElement: {},
    title: "",
  };
  const window = { I18NStrings: catalogs, AppCore };
  // localStorage is stubbed empty rather than absent so detectInitialLang takes
  // its "nothing saved" path deterministically instead of its ReferenceError
  // path.
  const localStorage = { getItem: () => null, setItem: () => {} };
  new Function("window", "document", "localStorage", source)(
    window,
    document,
    localStorage,
  );
  return { I18N: window.I18N, glosses: window.__i18nGlosses };
}

// ── the String Catalog ───────────────────────────────────────────────────

/**
 * Builds an .xcstrings object from a live I18N and its catalogs.
 *
 * zh-Hant / en / ja are copied RAW: whatever the catalogs hold, and nothing
 * when they hold nothing, so the resource never claims a translation that is
 * really a fallback. zh-Hans is the exception documented at the top of this
 * file — it is produced by the real t(), which folds the fallback chain and
 * runs the Traditional→Simplified converter.
 */
function buildStringCatalog(I18N, { STRINGS, JA_STRINGS }) {
  const strings = {};
  I18N.setLang("zh-Hans");
  for (const key of Object.keys(STRINGS)) {
    const entry = STRINGS[key];
    const localizations = {};
    const put = (lang, value) => {
      if (value === undefined || value === null) return;
      localizations[lang] = {
        stringUnit: { state: "translated", value },
      };
    };
    put("zh-Hant", entry.zh);
    put("en", entry.en);
    // Object.hasOwn, not a bare read: a key named "toString" would otherwise
    // take Object.prototype's method as its Japanese copy. t() does exactly
    // that — see the prototypeKeys cases — but a resource must not.
    if (Object.hasOwn(JA_STRINGS, key)) put("ja", JA_STRINGS[key]);
    put("zh-Hans", I18N.t(key));
    strings[key] = { extractionState: "manual", localizations };
  }
  return {
    // The maintained copy is the Traditional Chinese one; English is a
    // translation of it and Simplified is generated from it.
    sourceLanguage: "zh-Hant",
    strings,
    version: "1.0",
  };
}

/**
 * Xcode's own .xcstrings spelling: two-space indent, `"key" : value`, keys
 * sorted. Matching it means opening the file in Xcode does not immediately
 * rewrite it into a diff nobody authored.
 */
function serializeXcstrings(value, depth = 0) {
  const pad = "  ".repeat(depth);
  const inner = "  ".repeat(depth + 1);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[\n\n" + pad + "]";
    return (
      "[\n" +
      value.map((v) => inner + serializeXcstrings(v, depth + 1)).join(",\n") +
      "\n" +
      pad +
      "]"
    );
  }
  // Default string sort, which is by UTF-16 code unit — the same order
  // JavaScript compares keys in, and stable across platforms.
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "{\n\n" + pad + "}";
  return (
    "{\n" +
    keys
      .map(
        (k) =>
          inner + JSON.stringify(k) + " : " + serializeXcstrings(value[k], depth + 1),
      )
      .join(",\n") +
    "\n" +
    pad +
    "}"
  );
}

/**
 * Writes (or, under --check, verifies) ios/Resources/Localizable.xcstrings.
 *
 * The generator's --check contract is that nothing on disk may move, so this
 * mirrors it: a stale catalog fails the gate with the command that fixes it,
 * rather than being silently rewritten by a verification run.
 */
function emitCatalogFile(APP_DIR, catalog) {
  const target = path.join(APP_DIR, "..", "ios", "Resources", "Localizable.xcstrings");
  const text = serializeXcstrings(catalog) + "\n";
  const previous = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (previous === text) return;
  if (process.argv.includes("--check")) {
    console.error(
      "  ! ios/Resources/Localizable.xcstrings no longer matches i18n-strings.js" +
        " — rerun scripts/build/build-port-fixtures.mjs without --check",
    );
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  console.log(
    `  ${previous ? "~" : "+"} ios/Resources/Localizable.xcstrings (${
      Object.keys(catalog.strings).length
    } keys)`,
  );
}

// ── inputs ───────────────────────────────────────────────────────────────

/** JSON has no `undefined`; the fixture spells it null and says so. */
const nullable = (v) => (v === undefined ? null : v);

/**
 * Records a value AND its JavaScript type.
 *
 * t() does not always return a string — see prototypeKeys — and a fixture that
 * wrote `null` for those would be hiding the finding rather than freezing it.
 */
function typed(value) {
  const kind = typeof value;
  return kind === "string" ? { jsType: "string", value } : { jsType: kind, value: null };
}

/** Keys the catalogs do not contain, and what each is defending. */
const MISSING_KEYS = [
  ["nope.nope", "an ordinary typo: t() returns the key, so the UI shows it"],
  ["", "the empty key"],
  ["app.title.kr", "a country variant that was never written"],
  ["app.title.", "one character past a real key: lookups are exact, never prefix"],
  ["APP.TITLE", "the catalogs are case sensitive"],
  [
    "語言測試",
    "a non-ASCII key. Every real key is ASCII and no non-ASCII string is " +
      "canonically equal to an ASCII one, so a Swift Dictionary cannot " +
      "accidentally match where JavaScript's own lookup does not",
  ],
  [" app.title", "a leading space: nothing is trimmed"],
];

/** Parameter sets for fill(). Each carries why it is here. */
const FILL_CASES = [
  ["list.allTitle", { count: 3 }, "String(3) is '3' in JavaScript and '3.0' " +
    "through Swift's String(Double) — JSNumber.string is what makes these agree"],
  ["list.allTitle", { count: 0 }, "0 is falsy in JS but not nullish, so it fills"],
  ["list.allTitle", {}, "no such param: the placeholder is left standing"],
  ["list.allTitle", null, "no params at all: fill() short-circuits before the regex"],
  ["list.allTitle", { count: null }, "an explicitly null param leaves the placeholder"],
  ["list.allTitle", { count: 1.5 }, "an ordinary fraction"],
  [
    "list.allTitle",
    { count: 0.30000000000000004 },
    "0.1 + 0.2: shortest round-trip printing, 17 significant digits",
  ],
  ["list.allTitle", { count: 1e21 }, "past the exponential threshold: JS prints 1e+21"],
  ["list.allTitle", { count: -0 }, "negative zero prints as '0'"],
  ["list.allTitle", { count: true }, "String(true)"],
  [
    "list.allTitle",
    { count: "$&" },
    "the replacement is a FUNCTION, so $& is inserted literally instead of " +
      "expanding to the match — a port using a regex template would print 「3」",
  ],
  [
    "list.allTitle",
    { count: "{count}" },
    "the replacement is not re-scanned: one pass, left to right",
  ],
  ["list.allTitle", { count: "" }, "an empty string is not nullish, so it replaces"],
  [
    "play.now",
    { index: 1, total: 2, train: "のぞみ", from: "東京", to: "新大阪" },
    "five placeholders, with a full-width ／ between the first two",
  ],
  ["play.now", { index: 1 }, "a partially supplied set fills what it can"],
  [
    "status.routeGeneratedSkipped",
    { train: "A", count: 2, skipped: 1 },
    "three placeholders, in all four languages",
  ],
  [
    "import.targetDate",
    { date: "2026-08-21" },
    "a value inside markup: the catalog carries HTML for the -html sites",
  ],
  // Raw templates: keys that are not in the catalog, so t() falls through to
  // filling the KEY itself. That path is reachable from any typo'd data-i18n
  // attribute, and it is where the placeholder scanner is most exposed.
  ["x {count} y", { count: 7 }, "an unknown key is filled as if it were copy"],
  ["{}", { count: 7 }, "\\w+ needs one character: an empty brace pair never matches"],
  [
    "{}",
    { "": 7 },
    "…and supplying a parameter NAMED '' does not make it one: a scanner that " +
      "accepted a zero-length name would substitute here and nothing else " +
      "would notice",
  ],
  ["{ count }", { count: 7 }, "spaces are not \\w"],
  ["{count", { count: 7 }, "unterminated"],
  ["count}", { count: 7 }, "unopened"],
  ["{{count}}", { count: 7 }, "the inner match wins; the outer braces survive"],
  ["{count}{count}", { count: 7 }, "every occurrence, not just the first"],
  ["{a-b}", { "a-b": 7 }, "- is not \\w, so this is not a placeholder at all"],
  ["{a_1}", { a_1: 7 }, "_ and digits are \\w"],
  [
    "{語}",
    { 語: 7 },
    "\\w is ASCII-only in a JS regex without the u flag: a CJK name never matches",
  ],
  [
    '{"schema_version":"1.3","trains":[...]}',
    { schema_version: 7 },
    "a real catalog value contains this brace run; quotes are not \\w",
  ],
];

/**
 * Reading preferences. `null` means "no explicit choice yet", which is the
 * state every caller sees until the 顯示 panel is touched.
 */
const ALL_PREFS = [null];
for (const kana of [false, true])
  for (const romaji of [false, true])
    for (const zh of [false, true]) ALL_PREFS.push({ kana, romaji, zh });
/** The two that matter where the prefs cannot change the answer. */
const SPARSE_PREFS = [null, { kana: true, romaji: true, zh: true }];

/**
 * Station-readings payloads.
 *
 * The readings DATA (app/data/station-readings.json) belongs to the stations
 * port; what belongs here is the plumbing i18n.js wraps it in — the country
 * whitelist that decides whether a table localises names or annotates them,
 * the byCode-then-byName lookup order, the AppCore re-keying of byName, and
 * the falsy-field fallbacks. So these tables are synthetic and small, and each
 * row exists to reach one of those branches.
 */
const READINGS_TABLES = [
  {
    label: "none",
    note:
      "the pre-boot state, and any standalone embedding: the gloss " +
      "dictionaries inside i18n.js are all there is",
    payload: null,
    prefs: ALL_PREFS,
  },
  {
    label: "jp-readings",
    note:
      "a Japan table: annotates a Japanese name with kana/romaji/zh sublines " +
      "rather than replacing it",
    payload: {
      country: "JP",
      byCode: {
        "1101": { kana: "さっぽろ", romaji: "Sapporo", zh_Hant: "札幌", zh_Hans: "札幌" },
        DUP: { kana: "剣山", romaji: "剣山", zh_Hant: "剣山", zh_Hans: "剣山" },
        EMPTY: { kana: "", romaji: "", zh_Hant: "", zh_Hans: "" },
        NFD: { kana: "ガ", romaji: "Ga", zh_Hant: "", zh_Hans: "" },
        HANT: { kana: "", romaji: "", zh_Hant: "繁體", zh_Hans: "" },
        HANS: { kana: "", romaji: "", zh_Hant: "", zh_Hans: "简体" },
      },
      byName: {
        // Re-keyed through AppCore.normalizeStationName on the way in, so the
        // ideographic space and the ヶ never reach the lookup.
        "柳ヶ浦": { kana: "やなぎがうら", romaji: "Yanagigaura", zh_Hant: "柳浦", zh_Hans: "柳浦" },
        "東　京": { kana: "とうきょう", romaji: "Tōkyō", zh_Hant: "东京", zh_Hans: "东京" },
        "剣山": { kana: "けんざん", romaji: "Kenzan", zh_Hant: "剑山", zh_Hans: "剑山" },
        // NFKC folds half-width katakana up to full-width before anything else.
        "ﾃｽﾄ": { kana: "てすと", romaji: "Tesuto", zh_Hant: "", zh_Hans: "" },
        // The other three small-kana folds, which the ヶ→ケ case never reaches.
        "ヵ試ゖゕ": { kana: "かこけか", romaji: "Kakokeka", zh_Hant: "", zh_Hans: "" },
        // U+FEFF is ECMAScript whitespace and IS stripped — Foundation's
        // CharacterSet.whitespacesAndNewlines does not contain it.
        "空\u{feff}白": { kana: "くうはく", romaji: "Kūhaku", zh_Hant: "", zh_Hans: "" },
      },
    },
    prefs: ALL_PREFS,
  },
  {
    label: "tw-localized",
    note:
      "a Taiwan table: LOCALIZED_NAME_COUNTRIES, so the base name itself is " +
      "replaced and no reading subline is produced at all — the prefs cannot " +
      "change the answer here",
    payload: {
      country: "tw",
      byCode: {
        "TW-1": { zh_Hant: "臺北", zh_Hans: "台北", ja: "台北", en: "Taipei" },
        "TW-2": { zh_Hant: "高雄", zh_Hans: "", ja: "", en: "" },
      },
      byName: {
        "臺　中": { zh_Hant: "臺中", zh_Hans: "台中", ja: "台中", en: "Taichung" },
        // The official Traditional name differs from the name the caller
        // passes, which is what makes the ja/en/zh-Hans fallback TO it
        // distinguishable from giving up and returning the caller's name.
        "台南": { zh_Hant: "臺南", zh_Hans: "", ja: "", en: "" },
      },
    },
    prefs: SPARSE_PREFS,
  },
  {
    label: "unknown-country",
    note:
      "a country outside LOCALIZED_NAME_COUNTRIES falls back to JP, so a " +
      "table of localised names is read as reading annotations instead",
    payload: {
      country: "zz",
      byCode: { "TW-1": { zh_Hant: "臺北", zh_Hans: "台北", ja: "台北", en: "Taipei" } },
      byName: {},
    },
    prefs: SPARSE_PREFS,
  },
  {
    label: "missing-country",
    note: "String(data.country || 'JP').toUpperCase(): absent means Japan",
    payload: { byCode: {}, byName: {} },
    prefs: SPARSE_PREFS,
  },
  {
    label: "fullwidth-country",
    note:
      "the whitelist is checked after toUpperCase but without any width " +
      "folding, so ｔｗ uppercases to ＴＷ and misses",
    payload: { country: "ｔｗ", byCode: {}, byName: {} },
    prefs: SPARSE_PREFS,
  },
  {
    label: "lowercase-country",
    note: "…while a plain 'hk' uppercases into the whitelist and is accepted",
    payload: {
      country: "hk",
      byCode: { "HK-1": { zh_Hant: "中環", zh_Hans: "中环", ja: "セントラル", en: "Central" } },
      byName: {},
    },
    prefs: SPARSE_PREFS,
  },
  {
    label: "not-an-object",
    note:
      "setStationReadings ignores a non-object entirely, so the Hong Kong " +
      "table installed by the row above is still in place",
    payload: "nonsense",
    prefs: SPARSE_PREFS,
  },
];

/** Names fed to placeName / stationName / nameReadingsTyped. */
const PROBE_NAMES = [
  ["剣山", null, "a NAMES + KANA entry: both glosses available"],
  ["あずさ", null, "kana-only service name: NAMES has it, KANA deliberately does not"],
  ["京浜東北線", null, "a line name, not a station"],
  ["東京", null, "in neither gloss dictionary"],
  ["", null, "empty: returns '' before anything else runs"],
  [null, null, "missing: `return jp || ''`"],
  ["東京", "1101", "a byCode hit supplies what the dictionaries do not"],
  ["柳ケ浦", null, "byName, reached through AppCore's ヶ→ケ folding"],
  ["東　京", null, "byName, reached through the whitespace strip"],
  ["剣山", "DUP", "byCode wins over byName and over the gloss dictionaries — " +
    "and every reading here equals the name, so all of them are dropped"],
  ["剣山", "EMPTY", "a row of empty strings: every reading is falsy and skipped"],
  [
    "ガ",
    "NFD",
    "a composed ガ name against a DECOMPOSED ガ reading. JavaScript's !== " +
      "compares UTF-16 code units and keeps the reading, so the app prints " +
      "ガ（ガ）; Swift's == holds under canonical equivalence and would drop it",
  ],
  ["站", "HANT", "prefs.zh with only zh_Hant: zh-Hans falls back to it"],
  ["站", "HANS", "prefs.zh with only zh_Hans: zh-Hant falls back to it"],
  ["台北", "TW-1", "the localised-name path"],
  ["高雄", "TW-2", "empty ja/en fall back to the official Traditional name"],
  ["臺中", null, "localised by byName"],
  ["中環", "HK-1", "the Hong Kong table"],
  ["不明", "NOPE", "neither code nor name is in the table"],
  ["テスト", null, "NFKC folds the table's half-width ﾃｽﾄ onto this name"],
  [
    "カ試けか",
    null,
    "the table's key is ヵ試ゖゕ: the ヵ→カ / ゖ→け / ゕ→か folds are what bring " +
      "the two together, and the ヶ→ケ case alone never reaches them",
  ],
  ["空白", null, "the table's key carries a U+FEFF that the whitespace strip removes"],
  [
    "台南",
    null,
    "the row's ja/en/zh_Hans are empty, and its zh_Hant differs from this " +
      "name — so falling back to the official Traditional name and giving up " +
      "and returning the caller's name are finally two different answers",
  ],
  [
    "はや\u{3075}\u{3099}さ",
    null,
    "NFD はやぶさ: ふ + U+3099 COMBINING VOICED SOUND MARK. Canonically equal " +
      "to the NAMES key, so a Swift Dictionary keyed on String finds the " +
      "romanisation and JavaScript's own object lookup does not. Reachable: " +
      "text that has passed through an HFS+ path or an NFD-normalising editor " +
      "arrives decomposed",
  ],
  [
    "う\u{3059}\u{3099}しお",
    null,
    "the same, for a name whose dakuten is in the middle of the reading",
  ],
  [
    "空\u{0085}白",
    null,
    "U+0085 NEL is NOT ECMAScript whitespace, so this does not normalise onto " +
      "空白 and misses the row — while Swift's " +
      "CharacterSet.whitespacesAndNewlines would strip it and find one",
  ],
];

// ── build ────────────────────────────────────────────────────────────────

export function build({ APP_DIR, AppCore }) {
  const catalogs = readCatalogs(APP_DIR);
  const { STRINGS, JA_STRINGS } = catalogs;
  const keys = Object.keys(STRINGS);
  const { I18N, glosses } = loadI18N(APP_DIR, AppCore, catalogs);

  const catalog = buildStringCatalog(I18N, catalogs);
  emitCatalogFile(APP_DIR, catalog);

  const localizationCount = Object.values(catalog.strings).reduce(
    (sum, e) => sum + Object.keys(e.localizations).length,
    0,
  );

  // ── every key in every language ───────────────────────────────────────
  I18N.setCountry("jp");
  const cases = [];
  for (const lang of LANGUAGES) {
    I18N.setLang(lang);
    for (const key of keys) cases.push({ key, lang, ...typed(I18N.t(key)) });
  }

  // ── keys the catalogs do not contain ──────────────────────────────────
  const unknown = [];
  for (const lang of LANGUAGES) {
    I18N.setLang(lang);
    for (const [key] of MISSING_KEYS) unknown.push({ key, lang, ...typed(I18N.t(key)) });
  }

  // ── the prototype chain ───────────────────────────────────────────────
  const prototypeKeys = [];
  for (const lang of LANGUAGES) {
    I18N.setLang(lang);
    for (const key of PROTOTYPE_KEYS) {
      const value = I18N.t(key);
      let throwsWithParams;
      try {
        I18N.t(key, { a: 1 });
        throwsWithParams = null;
      } catch (e) {
        throwsWithParams = e.constructor.name;
      }
      prototypeKeys.push({ key, lang, ...typed(value), throwsWithParams });
    }
  }

  // ── the prototype chain again, reached through a PARAMETER name ───────
  //
  // `params[k]` is an object lookup too, so a placeholder named after an
  // Object.prototype property finds one, and `String(params[k])` writes a
  // native function's source into the copy. Same root cause as prototypeKeys,
  // same conclusion: no Swift Dictionary reproduces it.
  //
  // Only the FACT is frozen, never the text. The spelling of a native
  // function's source is engine-specific, and freezing it would make --check
  // depend on which Node built the fixture.
  const prototypeParams = [];
  I18N.setLang("zh-Hant");
  for (const key of PROTOTYPE_KEYS) {
    const template = "{" + key + "}";
    prototypeParams.push({
      template,
      leftStanding: I18N.t(template, {}) === template,
    });
  }

  // ── fill() ────────────────────────────────────────────────────────────
  const fill = [];
  for (const lang of LANGUAGES) {
    I18N.setLang(lang);
    for (const [key, params] of FILL_CASES)
      fill.push({
        key,
        lang,
        params: params === null ? null : jsonParams(params),
        value: I18N.t(key, params),
      });
  }

  // ── setCountry ────────────────────────────────────────────────────────
  //
  // The active country is not readable through the API, so it is probed:
  // stat.metro has a variant for all four non-Japanese countries, so its tc()
  // answer names the country that is actually active, and "jp" is the only
  // value that leaves the base key standing.
  I18N.setLang("en");
  const countries = [];
  for (const input of [...WHITELISTED_COUNTRIES, ...REJECTED_COUNTRIES]) {
    I18N.setCountry(input);
    countries.push({
      input: nullable(input),
      accepted: WHITELISTED_COUNTRIES.includes(input),
      statMetro: I18N.tc("stat.metro"),
    });
  }
  I18N.setCountry(undefined);
  countries.push({
    input: null,
    accepted: false,
    statMetro: I18N.tc("stat.metro"),
    note: "setCountry(undefined), identical to setCountry(null)",
  });

  // ── the country-variant key rule, over every key ──────────────────────
  //
  // countryVariantKey is not exported, so what is frozen is its observable
  // output: the whole tc() answer for every key under every probed country.
  // `variantExists` beside it is catalog membership — data, not a second
  // implementation of the rule — and it is what the Swift asserts its own
  // resolved key against.
  I18N.setLang("zh-Hant");
  const variantKeys = [];
  for (const country of PROBED_COUNTRIES) {
    I18N.setCountry(country);
    for (const key of keys)
      variantKeys.push({
        key,
        country,
        variantExists: !!STRINGS[key + "." + country],
        value: I18N.tc(key),
      });
  }

  // Whole tc() answers in every language for the keys where the rule actually
  // does something. Layer labels go through tc(), and a wrong variant there is
  // a legend naming the wrong railway.
  const variantBases = new Set();
  for (const key of keys) {
    const m = /^(.*)\.(tw|hk|mo|kr)$/.exec(key);
    if (m) variantBases.add(m[1]);
  }
  const tcProbeKeys = [
    ...[...variantBases].sort(),
    // "country" is not a key at all — but country.tw/hk/mo/kr are, so tc()
    // resolves it for four of the five countries and returns the bare key for
    // Japan. Frozen because it is the rule's sharpest edge.
    "country",
    "country.label",
    "country.jp",
    "map.riddenGroup",
    "nope",
    "",
  ];
  const tc = [];
  for (const country of PROBED_COUNTRIES) {
    I18N.setCountry(country);
    for (const lang of LANGUAGES) {
      I18N.setLang(lang);
      for (const key of tcProbeKeys) tc.push({ key, country, lang, ...typed(I18N.tc(key)) });
    }
  }
  I18N.setCountry("jp");

  // ── setLang ───────────────────────────────────────────────────────────
  const languages = [];
  for (const input of [
    "zh-Hant",
    "zh-Hans",
    "ja",
    "en",
    "zh",
    "fr",
    "",
    null,
    "JA",
    "zh-hant",
    "zh-Hant ",
  ]) {
    I18N.setLang("en");
    I18N.setLang(input);
    languages.push({ input: nullable(input), active: I18N.getLang() });
  }
  I18N.setLang("en");
  I18N.setLang(undefined);
  languages.push({ input: null, active: I18N.getLang(), note: "setLang(undefined)" });

  // ── reading preferences ───────────────────────────────────────────────
  const readingDefaults = [...LANGUAGES, "xx", ""].map((lang) => ({
    lang,
    prefs: I18N.localeDefaultReadingPrefs(lang),
  }));

  // ── place names ───────────────────────────────────────────────────────
  const placeNames = [];
  for (const table of READINGS_TABLES) {
    I18N.setStationReadings(table.payload);
    for (const lang of LANGUAGES) {
      I18N.setLang(lang);
      for (const prefs of table.prefs) {
        I18N.setNameReadings(prefs);
        for (const [jp, code] of PROBE_NAMES)
          placeNames.push({
            table: table.label,
            lang,
            prefs,
            jp: nullable(jp),
            code: nullable(code),
            readings: I18N.nameReadingsTyped(jp, code),
            readingsList: I18N.nameReadingsList(jp, code),
            nameReadings: I18N.nameReadings(jp, code),
            stationName: I18N.stationName(jp, code),
            placeName: I18N.placeName(jp, code),
          });
      }
    }
  }

  // Every gloss the dictionaries hold, in every language. These are the only
  // proper-noun readings that live in i18n.js itself; a missing one is a
  // service name that silently loses its romanisation.
  I18N.setStationReadings({ country: "JP", byCode: {}, byName: {} });
  const glossKeys = [
    ...new Set([...Object.keys(glosses.NAMES), ...Object.keys(glosses.KANA)]),
  ].sort();
  const glossCases = [];
  for (const lang of LANGUAGES) {
    I18N.setLang(lang);
    for (const prefs of SPARSE_PREFS) {
      I18N.setNameReadings(prefs);
      for (const jp of glossKeys)
        glossCases.push({
          jp,
          lang,
          prefs,
          readings: I18N.nameReadingsTyped(jp),
          placeName: I18N.placeName(jp),
          trainName: I18N.trainName(jp),
        });
    }
  }

  // ── the fallback chains, on a catalog with holes ──────────────────────
  //
  // All 432 shipped keys carry all three maintained languages, so the four
  // per-language fallback chains in t() are unreachable from real data. They
  // are still the logic being ported, so they are driven from a second,
  // doctored catalog loaded into its own scope — the real t(), a fake
  // dictionary. The Swift side decodes `synthetic.catalog` and runs its own
  // lookup over it, so the holes are real holes in a real resource rather than
  // a mocked-out branch.
  const synthetic = buildSyntheticCatalogCases(APP_DIR, AppCore);

  return {
    describes:
      "i18n.js — I18N.{t, tc, setCountry, setLang, getLang, placeName, " +
      "trainName, nameReadings, nameReadingsList, nameReadingsTyped, " +
      "stationName, localeDefaultReadingPrefs, setNameReadings, " +
      "setStationReadings} over the i18n-strings.js catalogs",
    contract:
      "432 keys, four UI languages, three of them maintained: the Simplified " +
      "Chinese UI is generated at runtime from the Traditional copy by a " +
      "236-entry map that lives in i18n.js and is reachable from nowhere but " +
      "t(). The Swift port has no converter — ios/RailMap/Localizable." +
      "xcstrings, written by this module on every fixture run, carries " +
      "zh-Hans as a materialised localisation produced by calling the real " +
      "t(). Three languages keep their fallback chains in the port; the " +
      "fourth is pre-folded because it is a derivation, not a translation.\n\n" +
      "The country-variant rule is a blind string suffix: with Taiwan active " +
      "'app.title' resolves to 'app.title.tw' IF that key exists, and " +
      "otherwise stays put. Every lookup around it is exact-match, and three " +
      "consequences look like defects and are frozen here deliberately:\n" +
      "  1. setCountry's whitelist is [jp, tw, hk, mo, kr], case sensitive " +
      "and untrimmed. Anything else becomes 'jp', so a mistyped country does " +
      "not fail — it silently serves the Japanese copy.\n" +
      "  2. Korea has no app.title.kr, app.hint.kr, ph.trainType.kr or " +
      "info.packageBody.kr, so the Korean dataset shows the Japanese title " +
      "and hint; Hong Kong and Macao fall back the same way for the stat.* " +
      "categories they never declared. The fallback is the design, which " +
      "strings are missing is not, and `variantKeys` is the list.\n" +
      "  3. tc('country') answers 'country' under Japan and '台灣' under " +
      "Taiwan: country.tw/hk/mo/kr are region LABELS that happen to look like " +
      "country variants of a key named 'country', and country.jp — which does " +
      "exist — is unreachable through tc(), because 'jp' short-circuits " +
      "before the suffix is ever built.\n\n" +
      "t() does not always return a string. STRINGS and JA_STRINGS are object " +
      "literals, so STRINGS['toString'] finds Object.prototype's method and " +
      "the `if (entry)` guard passes. In Japanese, JA_STRINGS[key] is read " +
      "first and `??` accepts a function, so t('toString') returns " +
      "Object.prototype.toString itself and t('toString', params) throws " +
      "TypeError; the other three languages read entry.zh / entry.en off that " +
      "function, find nothing, and return the key. A Swift Dictionary has no " +
      "prototype chain and no String reproduces 'a Function came out of t()', " +
      "so prototypeKeys records the JavaScript TYPE and the port returns the " +
      "key in all four languages. That is the one divergence in this port, " +
      "and it is unreachable from any data-i18n attribute or call site in the " +
      "app.\n\n" +
      "Everything else compares by UTF-16 code unit, because that is what " +
      "JavaScript does and this copy is CJK with full-width punctuation: " +
      "nameReadingsTyped drops a reading that === the name, so a decomposed " +
      "reading against a composed name is KEPT by JavaScript and would be " +
      "dropped by Swift's ==.",
    catalog: {
      path: "ios/Resources/Localizable.xcstrings",
      sourceLanguage: catalog.sourceLanguage,
      version: catalog.version,
      languages: LANGUAGES,
      keyCount: keys.length,
      localizationCount,
      // Present for every entry, which is what lets the Swift rule for
      // zh-Hans be a lookup with no fallback of its own.
      zhHansCount: Object.values(catalog.strings).filter(
        (e) => e.localizations["zh-Hans"],
      ).length,
      note:
        "generated by app/scripts/build/port-fixtures/i18n.mjs. zh-Hant, en " +
        "and ja are copied raw from the catalogs; zh-Hans is materialised " +
        "through the real toSimplifiedChinese by way of t()",
    },
    notes: {
      missingKeys: MISSING_KEYS.map(([key, note]) => ({ key, note })),
      fill: FILL_CASES.map(([key, , note]) => ({ key, note })),
      readingsTables: READINGS_TABLES.map((t) => ({ label: t.label, note: t.note })),
      probeNames: PROBE_NAMES.map(([jp, code, note]) => ({
        jp: nullable(jp),
        code: nullable(code),
        note,
      })),
    },
    cases,
    unknown,
    prototypeKeys,
    prototypeParams,
    fill,
    countries,
    variantKeys,
    tc,
    languages,
    readingDefaults,
    placeNames,
    glosses: glossCases,
    synthetic,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Params, tagged so the Swift side can rebuild the JavaScript value exactly. */
function jsonParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null) out[k] = { type: "null" };
    else if (typeof v === "number") out[k] = { type: "number", number: v };
    else if (typeof v === "boolean") out[k] = { type: "bool", bool: v };
    else out[k] = { type: "string", string: String(v) };
  }
  return out;
}

/**
 * A second i18n scope over a doctored catalog, to reach the fallback chains
 * that 432 complete entries never do.
 *
 * The synthetic catalog is emitted in .xcstrings shape by the same builder the
 * shipped one uses, so what the Swift decodes has exactly the structure — and
 * exactly the holes — a real resource would.
 */
function buildSyntheticCatalogCases(APP_DIR, AppCore) {
  const STRINGS = {
    "syn.full": { zh: "完整", en: "Full" },
    "syn.zhOnly": { zh: "只有繁體" },
    "syn.enOnly": { en: "English only" },
    "syn.jaOnly": {},
    "syn.zhJa": { zh: "繁體與日文" },
    "syn.enJa": { en: "English and Japanese" },
    "syn.zhEn": { zh: "繁體與英文", en: "Traditional and English" },
    "syn.empty": {},
    // A CJK KEY with nothing in it. Under zh-Hans, t() simplifies the KEY —
    // the one place the converter is applied to something that is not a
    // translation, and the reason every entry gets a materialised zh-Hans
    // rather than only the ones that have a zh.
    "syn.語言測試": {},
    "syn.emptyValues": { zh: "", en: "" },
    "syn.placeholder": { zh: "共 {n} 個車站", en: "{n} stations" },
    "syn.variant": { zh: "基底", en: "Base" },
    "syn.variant.tw": { zh: "臺灣版", en: "Taiwan" },
    "syn.onlyVariant.hk": { zh: "香港版", en: "Hong Kong" },
  };
  const JA_STRINGS = {
    "syn.full": "完全",
    "syn.jaOnly": "日本語のみ",
    "syn.zhJa": "繁体と日本語",
    "syn.enJa": "英語と日本語",
    "syn.emptyJa": "",
    "syn.variant": "基底",
  };
  const catalogs = { STRINGS, JA_STRINGS };
  const { I18N } = loadI18N(APP_DIR, AppCore, catalogs);
  const catalog = buildStringCatalog(I18N, catalogs);

  // syn.emptyJa exists only in the Japanese overlay. STRINGS misses it, so
  // `if (entry)` fails and every language returns the key — Japanese included,
  // even though a Japanese string for it is sitting right there.
  const keys = [...Object.keys(STRINGS), "syn.emptyJa", "syn.absent"];
  const cases = [];
  I18N.setCountry("jp");
  for (const lang of LANGUAGES) {
    I18N.setLang(lang);
    for (const key of keys) cases.push({ key, lang, ...typed(I18N.t(key)) });
  }
  const filled = [];
  for (const lang of LANGUAGES) {
    I18N.setLang(lang);
    filled.push({
      key: "syn.placeholder",
      lang,
      params: jsonParams({ n: 12 }),
      value: I18N.t("syn.placeholder", { n: 12 }),
    });
  }
  const variants = [];
  for (const country of PROBED_COUNTRIES) {
    I18N.setCountry(country);
    for (const lang of LANGUAGES) {
      I18N.setLang(lang);
      for (const key of ["syn.variant", "syn.onlyVariant", "syn.full"])
        variants.push({ key, country, lang, ...typed(I18N.tc(key)) });
    }
  }
  return {
    note:
      "a doctored catalog run through the real t(). Nothing here occurs in " +
      "the shipped catalogs, which are complete in all three maintained " +
      "languages — these are the holes the fallback chains exist for.",
    catalog,
    cases,
    filled,
    variants,
  };
}
