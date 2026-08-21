// =========================================================================
//  operator-branding.json — the answers app-operator-branding.js gives today
//
//  RailOperatorBranding is a classifier: given an operator string it decides
//  what a passenger sees (a short company label) and which artwork a line
//  wears. Nothing about it is computed — it is eleven lookup tables and four
//  fallback chains — so the cases that matter are not the ones anybody would
//  sample. They are the operator strings that miss a table by one character,
//  the ones whose label is a key in a *different* table, and the ones whose
//  answer depends on JavaScript's UTF-16 string semantics.
//
//  Hence: every distinct operator string in all five shipped packages (208 of
//  them), every line in all five packages (804), and a block of inputs
//  written to break a port rather than to pass one.
// =========================================================================

import fs from "node:fs";
import path from "node:path";

export const name = "operator-branding.json";

// The module is a classic script, not CommonJS: it declares `const
// RailOperatorBranding` and hands it to `window`. Evaluating the real file is
// the whole point — a fixture generated from a re-typed copy of these tables
// would only prove that the copy and the Swift agree, which is not the
// question being asked. `new Function` reproduces the browser's
// one-shared-lexical-scope contract without needing a DOM; the returned
// object is the same frozen API the frontend gets off `window`.
function loadOperatorBranding(APP_DIR) {
  const source = fs.readFileSync(
    path.join(APP_DIR, "public", "app-operator-branding.js"),
    "utf8",
  );
  return new Function("window", `${source}\nreturn RailOperatorBranding;`)({});
}

const COUNTRIES = ["mo", "hk", "tw", "kr", "jp"];

// ── inputs designed to fail a port ───────────────────────────────────────
//
// Each entry carries the reason it is here, and the reason travels into the
// fixture so that whoever reads a failure sees what the case was defending.
//
// Every character that cannot be seen is written as an escape. Which invisible
// character a case is about IS the case, and a literal would be invisible in
// the diff that one day changes it.
const ADVERSARIAL_OPERATORS = [
  [null, "String(operator || '') — a missing operator is the empty string"],
  ["", "empty string: every table misses and the fallback returns ''"],
  ["   ", "whitespace only: labelOne sees '' after the trim and returns ''"],
  [
    "東急電鉄 ",
    "a trailing space is trimmed before the table lookup, so this still resolves",
  ],
  [
    "\u{3000}WILLER\u{3000}TRAINS\u{3000}",
    "U+3000 IDEOGRAPHIC SPACE is ECMAScript WhiteSpace: JS trims the ends and " +
      "keeps the one in the middle, which is part of this operator's real name",
  ],
  [
    "\u{00a0}東急電鉄\u{00a0}",
    "U+00A0 NO-BREAK SPACE is ECMAScript WhiteSpace and is trimmed",
  ],
  [
    "\u{feff}東急電鉄",
    "U+FEFF ZWNBSP is ECMAScript WhiteSpace — JS trims it, and Swift's " +
      "CharacterSet.whitespacesAndNewlines does NOT contain it",
  ],
  [
    "\u{0085}東急電鉄",
    "U+0085 NEL is NOT ECMAScript WhiteSpace — JS keeps it, and Swift's " +
      "CharacterSet.whitespacesAndNewlines WOULD strip it",
  ],
  ["東急電鉄/京王電鉄", "'/' separates co-operators; each half is labelled"],
  ["東急電鉄 / 京王電鉄", "each half is trimmed before its own lookup"],
  ["東急電鉄//京王電鉄", "empty halves are dropped by filter(Boolean)"],
  ["/", "split('/') of a bare separator is two empty halves, so the label is ''"],
  [
    "台鐵/臺灣高鐵",
    "normalizeTaiwanCompanyName maps both halves, and the joined result is " +
      "then not a key in OPERATOR_LOGOS — two operators means no logo",
  ],
  [
    "株式会社東急電鉄",
    "the exact-match tables are consulted BEFORE 株式会社 is stripped, so this " +
      "resolves to 東急電鉄 rather than to the 東急 label",
  ],
  ["東急電鉄株式会社", "the 株式会社 strip is global, not anchored"],
  [
    "公益財団法人株式会社有限会社テスト鉄道",
    "order of operations: the global 株式会社/有限会社 strip runs first, which " +
      "is what leaves 公益財団法人 at the start for the anchored strip to remove",
  ],
  ["株式会社", "everything is stripped, so the label is empty"],
  [
    "テスト鉄道公益財団法人",
    "the 法人 strip is anchored to the start and must not fire here",
  ],
  [
    "一般財団法人青函トンネル記念館",
    "not in COMPANY_LABELS, so the anchored 一般財団法人 strip is what shortens it",
  ],
  [
    "一般社団法人札幌市交通事業振興公社",
    "IS in COMPANY_LABELS, so the table wins and the 法人 strip never runs",
  ],
  [
    "\u{30a2}\u{30eb}\u{30d2}\u{309a}\u{30b3}交通",
    "NFD アルピコ交通 — ヒ + U+309A COMBINING KATAKANA-HIRAGANA SEMI-VOICED " +
      "SOUND MARK. Canonically equal to the table key, so a Swift Dictionary " +
      "keyed on String matches it; JavaScript compares UTF-16 code units and " +
      "does not",
  ],
  [
    "\u{ff2d}\u{ff34}\u{ff32}",
    "full-width forms are compatibility-equivalent, never canonically equal: " +
      "no table hit in either language",
  ],
  ["mtr", "the tables are case sensitive"],
  ["MTR", "the Hong Kong table's own key"],
  ["MTR Corporation Limited", "an alias carrying ASCII spaces"],
  ["香港鐵路有限公司 MTR Corporation", "the bilingual alias: one key, with a space"],
  [
    "香港电车",
    "simplified Hong Kong Tramways: labels to 香港電車, and the JavaScript is " +
      "explicit that it is its own operator with no logo asset",
  ],
  [
    "澳门轻轨",
    "simplified Macao LRT: its label is the KEY of the second lookup into " +
      "OPERATOR_LOGOS, which is the only two-hop path in operatorLogo",
  ],
  ["Macao LRT", "the English alias takes the same two-hop path"],
  [
    "台灣高速鐵路股份有限公司X",
    "one character past a real key: the tables are exact-match, never prefix",
  ],
  [
    "台灣高速鐵路股份有限公",
    "one character short of a real key, for the same reason",
  ],
  [
    "\u{20b9f}鉄道",
    "U+20B9F 𠮟 is a surrogate pair: two UTF-16 code units, one Swift Character",
  ],
  [
    "東京地下鉄",
    "the package's operator string is 東京メトロ; 東京地下鉄 survives only inside " +
      "line ids. It labels, and it reaches no logo",
  ],
  [
    "大阪市高速電気軌道",
    "the same shape as 東京地下鉄: labels to 大阪メトロ, while the package's own " +
      "operator string is the ASCII 'Osaka Metro'. Neither reaches a logo",
  ],
];

// (operator, lineName) pairs. companyFor has three exits and the packages
// reach only two of them, so the third is driven from here.
const ADVERSARIAL_COMPANY_FOR = [
  [null, null, "both missing"],
  ["東急電鉄", null, "no line name: nothing can prefix-match, so the label shows"],
  ["東急電鉄", "", "the same, with an empty name"],
  ["", "東急東横線", "no label means no company, whatever the name says"],
  [
    "東急電鉄",
    "東急東横線",
    "the LABEL prefixes the name — the popup would otherwise read 東急 東急東横線",
  ],
  [
    "九州旅客鉄道",
    "九州旅客鉄道テスト線",
    "the third exit: the label JR九州 does not prefix the name, but the RAW " +
      "operator does",
  ],
  [
    "九州旅客鉄道",
    "JR九州テスト線",
    "the second exit for the same operator, reached through the label",
  ],
  [
    "カ",
    "\u{30ab}\u{3099}線",
    "カ against a decomposed ガ線 (カ + U+3099). JavaScript's startsWith " +
      "compares UTF-16 code units and says yes, so the company is suppressed; " +
      "Swift's hasPrefix compares grapheme clusters and says no. The two apps " +
      "would print different popups for this line",
  ],
  [
    "\u{30ac}",
    "\u{30ab}\u{3099}線",
    "the mirror image: a composed ガ against the decomposed name, where JS says " +
      "no and a canonical-equivalence prefix test says yes",
  ],
  [
    "台灣高速鐵路股份有限公司",
    "台灣高鐵",
    "the label is the whole name, and startsWith is satisfied by equality",
  ],
  [
    "台灣高鐵",
    "台灣高速鐵路",
    "the reverse is not a prefix, so the company still shows",
  ],
];

// Synthetic line objects. The real ones cover the tables; these cover the
// shape of the argument, which the JavaScript reads as `line.lineId ||
// line.id` and never validates.
const ADVERSARIAL_LINES = [
  [null, "a missing line resolves to no logo at all"],
  [{}, "an empty object: no badge, no id, no operator"],
  [
    { id: "jp-三岐鉄道-北勢線", operator: "三岐鉄道" },
    "`id` instead of `lineId` — the compact package's field name, still accepted",
  ],
  [
    { lineId: "", id: "jp-三岐鉄道-北勢線", operator: "三岐鉄道" },
    "an empty lineId is falsy, so `id` is what the LINE_LOGOS lookup sees",
  ],
  [
    { lineId: "jp-東日本旅客鉄道-中央線", logo: "", operator: "東日本旅客鉄道" },
    "an empty badge is falsy: it is skipped before the audit set is consulted",
  ],
  [
    {
      lineId: "jp-東日本旅客鉄道-中央線",
      logo: "/rail/logos/jp-東日本旅客鉄道-中央線.png",
      operator: "東日本旅客鉄道",
    },
    "the audit set rejects this company mark, so the JR East operator mark wins",
  ],
  [
    {
      lineId: "JP-東日本旅客鉄道-中央線",
      logo: "/rail/logos/jp-東日本旅客鉄道-中央線.png",
      operator: "東日本旅客鉄道",
    },
    "the audit set is only consulted for ids starting with a lower-case 'jp-'",
  ],
  [
    {
      lineId: "tw-trtc-bl",
      logo: "/rail/logos/anything.png",
      operator: "臺北大眾捷運股份有限公司",
    },
    "a non-jp line keeps whatever badge the package gave it, unexamined",
  ],
  [
    { lineId: "tw-trtc-bl", operator: "臺北大眾捷運股份有限公司" },
    "with no package badge, the per-line table answers before the operator does",
  ],
  [
    { lineId: "jp-東京地下鉄-4号線丸ノ内線分岐線", operator: "東京メトロ" },
    "the 丸ノ内線 branch has its own Mb identity, which outranks the operator badge",
  ],
  [
    { operator: "東急電鉄" },
    "no id at all: LINE_LOGOS is asked about `undefined` and answers nothing",
  ],
  [
    {
      lineId: "jp-九州旅客鉄道-九州新幹線",
      logo: "/rail/logos/jp-九州旅客鉄道-九州新幹線.png",
      operator: "九州旅客鉄道",
    },
    "JR publishes no per-route Shinkansen symbol: the package raster is " +
      "rejected and the line table supplies the operating company's pictogram",
  ],
];

const ADVERSARIAL_DARK_MATTE = [
  [null, "String(logo || '') — a missing logo is not in the set"],
  ["", "the empty string is not in the set"],
  [
    "/rail/operator-logos/jp/q7496602.png ",
    "logoNeedsDarkMatte does NOT trim: a trailing space misses the set",
  ],
  [
    "/RAIL/OPERATOR-LOGOS/JP/Q7496602.PNG",
    "the set is case sensitive, like every other table here",
  ],
];

export function build({ RailNetwork, APP_DIR }) {
  const branding = loadOperatorBranding(APP_DIR);

  // The object this classifier is actually handed is network.lineById's, not
  // the compact package's row, and the difference matters: the package stores
  // `logo: 1` (which only ever meant "artwork was downloaded"), and
  // buildNetworkFromCompactPackage is what turns that flag into a
  // `/rail/logos/<id>.png` path — stripping the -2 / -p1 suffixes of split
  // parts and paired alignments on the way, because the art is named after the
  // railway rather than the stroke. A fixture built from raw package rows
  // would be checking an input the app never passes.
  //
  // Parsed here rather than through the shared `railPackage` cache: this build
  // hands whole packages to another module, and a cache other fixture modules
  // read should not be exposed to that.
  const networks = COUNTRIES.map((country) => ({
    country,
    lines: [
      ...RailNetwork.buildNetworkFromCompactPackage(
        JSON.parse(
          fs.readFileSync(
            path.join(APP_DIR, "public", "rail", `${country}-2025.json`),
            "utf8",
          ),
        ),
      ).lineById.values(),
    ],
  }));

  const operatorCases = [];
  const companyForCases = [];
  const lineCases = [];
  const darkMatteCases = [];
  const seenOperators = new Set();
  const seenLogos = new Set();

  const nullable = (value) => (value === undefined ? null : value);

  const addOperatorCase = (operator, country, note) => {
    operatorCases.push({
      operator: nullable(operator),
      country: country || null,
      companyLabel: branding.companyLabel(operator),
      normalizeTaiwanCompanyName: branding.normalizeTaiwanCompanyName(operator),
      operatorLogo: branding.operatorLogo(operator) || null,
      ...(note ? { note } : {}),
    });
  };

  const addCompanyForCase = (operator, lineName, note) => {
    companyForCases.push({
      operator: nullable(operator),
      lineName: nullable(lineName),
      company: branding.companyFor(operator, lineName),
      ...(note ? { note } : {}),
    });
  };

  const addLineCase = (line, country, note) => {
    lineCases.push({
      country: country || null,
      input: line
        ? {
            lineId: nullable(line.lineId),
            id: nullable(line.id),
            operator: nullable(line.operator),
            logo: nullable(line.logo),
          }
        : null,
      verifiedPackageLineLogo: branding.verifiedPackageLineLogo(line) || null,
      lineLogo: line ? branding.lineLogo(line.lineId || line.id) || null : null,
      logoForLine: branding.logoForLine(line) || null,
      ...(note ? { note } : {}),
    });
  };

  const addDarkMatteCase = (logo, note) => {
    darkMatteCases.push({
      logo: nullable(logo),
      needsDarkMatte: branding.logoNeedsDarkMatte(logo),
      ...(note ? { note } : {}),
    });
  };

  // ── every operator, every line, every package ─────────────────────────
  for (const { country, lines } of networks)
    for (const line of lines) {
      if (!seenOperators.has(line.operator)) {
        seenOperators.add(line.operator);
        addOperatorCase(line.operator, country);
      }
      addCompanyForCase(line.operator, line.name);
      addLineCase(line, country);
      const resolved = branding.logoForLine(line);
      if (resolved && !seenLogos.has(resolved)) {
        seenLogos.add(resolved);
        addDarkMatteCase(resolved);
      }
    }

  // ── and the inputs written to break a port ────────────────────────────
  for (const [operator, note] of ADVERSARIAL_OPERATORS)
    addOperatorCase(operator, null, note);
  for (const [operator, lineName, note] of ADVERSARIAL_COMPANY_FOR)
    addCompanyForCase(operator, lineName, note);
  for (const [line, note] of ADVERSARIAL_LINES) addLineCase(line, null, note);
  for (const [logo, note] of ADVERSARIAL_DARK_MATTE) addDarkMatteCase(logo, note);
  // Every asset the dark-matte set names, whether or not a line resolves to it
  // today. The set is the reason that artwork stays legible in both themes,
  // and a port that dropped an entry would still pass on the lines alone.
  for (const logo of [
    "/rail/operator-logos/jp-badges/badge-011.png",
    "/rail/operator-logos/jp/q7496602.png",
    "/rail/operator-logos/jp/q11657221.svg",
  ])
    addDarkMatteCase(logo, "a member of LOGOS_REQUIRING_DARK_MATTE");

  return {
    describes:
      "app-operator-branding.js — RailOperatorBranding.{companyLabel, " +
      "normalizeTaiwanCompanyName, companyFor, operatorLogo, lineLogo, " +
      "verifiedPackageLineLogo, logoForLine, logoNeedsDarkMatte}",
    contract:
      "Eleven exact-match tables and four fallback chains, and the exactness " +
      "IS the contract: every lookup is by whole string, never by prefix, and " +
      "JavaScript compares those strings by UTF-16 code unit. A Swift " +
      "Dictionary keyed on String compares by canonical equivalence instead, " +
      "so a decomposed name matches a composed key there and misses here; " +
      "String.hasPrefix and CharacterSet.whitespacesAndNewlines disagree with " +
      "startsWith and ECMAScript trim in the same way. The cost of getting " +
      "this wrong is small and constant — a passenger reads the wrong company " +
      "name, or a line wears another railway's mark — which is exactly why " +
      "nobody would catch it by eye.\n\n" +
      "Three answers below look like defects and are reproduced deliberately, " +
      "because a port that quietly fixes one is a port whose disagreements can " +
      "no longer be read:\n" +
      "  1. operatorLogo keys on the RAW operator string while several logo " +
      "tables are keyed on the short LABEL, so 東急 / 京王 / 小田急 / 西武 / " +
      "東武 / 阪急 / 阪神 / 近鉄 / 南海 / 名鉄 / 京成 / 京急 / 相鉄 and the " +
      "municipal operators all label correctly and still resolve to no logo.\n" +
      "  2. verifiedPackageLineLogo consults JAPAN_NON_LINE_LOGO_IDS with the " +
      "stroke's own id, but a split part or paired alignment carries its " +
      "PARENT's artwork under a suffixed id (jp-東日本旅客鉄道-中央線-2) that " +
      "the set does not contain — so 17 strokes keep the very company marks " +
      "the audit set exists to reject.\n" +
      "  3. the label tables are consulted before the 株式会社 strip, so " +
      "株式会社東急電鉄 becomes 東急電鉄 rather than 東急.",
    cases: operatorCases,
    companyFor: companyForCases,
    lines: lineCases,
    darkMatte: darkMatteCases,
  };
}
