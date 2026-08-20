// The track-attribution identity test reads OSM's names in five countries.
//
// `scripts/railway/lib/track-attribution.mjs` answers one question — "is the
// way this stroke is standing on THIS LINE's own railway" — and it answers it
// on the NAME. That makes it exactly as good as its ability to read the names
// OSM actually writes, and OSM writes them differently in every country:
//
//   OSM 東武日光線          package 日光線            jp: OSM is longer
//   OSM 捷運文湖線          package 文湖線            tw: OSM is longer
//   OSM 捷運紅線            package 高雄捷運紅線      tw: the package is longer
//   OSM 7호선               package 서울 지하철 7호선   kr: the package is longer
//   OSM 台東線              package 臺東線            tw: one character apart
//
// Measured before this suite existed: 60.6% of Taiwan's 120,819 samples stood
// on a way the criterion could not read as their own, against 6.6% in Japan.
// Almost none of that was a defect — it was 捷運, 臺/台 and 正線. The
// criterion never reported them (an unreadable name is "cannot tell", and
// cannot-tell is reported as nothing), so the audit came back green on a
// network it could barely see. That is the failure mode this file exists for:
// a naming rule that stops working does not turn a check red, it turns it
// blind, and the only way to notice is to assert on inputs whose right answer
// is already known.
//
// So both halves are asserted. The rows that MUST match are the decorations
// found in the cached OSM cells; the rows that MUST NOT are the pairs a
// looser rule would happily merge — 舊山線 is 山線 with one character in
// front and is the abandoned 1908 alignment; 京浜東北線 is 東北本線's
// 電車線, a different pair of rails; 環狀輕軌 and 高雄捷運 are two systems one
// company runs. Merging any of those would delete exactly the defect class the
// criterion is for.

import assert from "node:assert/strict";
import test from "node:test";

import {
  attributionFilterFor,
  namingRulesFor,
  wayNameSpellings,
} from "../scripts/railway/lib/track-attribution.mjs";

/** A minimal index meta: a named, running way with an operator. */
function way(name, operator = null) {
  return { name, operator, operatorJa: null, running: true, service: null, layer: 0 };
}

function owns(country, line, osmWay) {
  return attributionFilterFor({ ...line, country }, country).owns(osmWay);
}

// [country, package line, OSM way, must the line own it?]
const ATTRIBUTION_ROWS = [
  // ── tw: the system prefix, in both directions ──
  ["tw", { name: "文湖線", operator: "臺北大眾捷運股份有限公司" }, way("捷運文湖線", "臺北大眾捷運股份有限公司"), true],
  ["tw", { name: "松山新店線", operator: "臺北大眾捷運股份有限公司" }, way("捷運松山新店線", "臺北大眾捷運股份有限公司"), true],
  ["tw", { name: "淡水信義線", operator: "臺北大眾捷運股份有限公司" }, way("捷運淡水信義線", "臺北大眾捷運股份有限公司"), true],
  ["tw", { name: "高雄捷運紅線", operator: "高雄捷運股份有限公司" }, way("捷運紅線", "高雄捷運公司"), true],
  ["tw", { name: "高雄捷運橘線", operator: "高雄捷運股份有限公司" }, way("捷運橘線", "高雄捷運公司"), true],
  ["tw", { name: "環狀線", operator: "新北大眾捷運股份有限公司" }, way("捷運環狀線", "新北捷運公司"), true],
  ["tw", { name: "三鶯線", operator: "新北大眾捷運股份有限公司" }, way("捷運三鶯線", "新北捷運公司"), true],
  ["tw", { name: "高雄環狀輕軌", operator: "高雄捷運股份有限公司" }, way("高雄捷運環狀輕軌", "高雄捷運公司"), true],
  ["tw", { name: "祝山線", operator: "阿里山林業鐵路及文化資產管理處" }, way("阿里山森林鐵路祝山線"), true],
  // ── tw: 臺/台, the 正線 track qualifier, 鐵路, the 北段/南段 split ──
  ["tw", { name: "臺東線", operator: "國營臺灣鐵路股份有限公司" }, way("台東線", "國營臺灣鐵路股份有限公司"), true],
  ["tw", { name: "縱貫線北段", operator: "國營臺灣鐵路股份有限公司" }, way("縱貫線東正線", "國營臺灣鐵路股份有限公司"), true],
  ["tw", { name: "縱貫線南段", operator: "國營臺灣鐵路股份有限公司" }, way("縱貫鐵路西正線(南段)", "國營臺灣鐵路股份有限公司"), true],
  ["tw", { name: "宜蘭線", operator: "國營臺灣鐵路股份有限公司" }, way("宜蘭線東正線", "國營臺灣鐵路股份有限公司"), true],
  ["tw", { name: "臺中線", operator: "國營臺灣鐵路股份有限公司" }, way("臺中線 (山線)"), true],
  // ── tw: the section OSM says outright is shared ──
  ["tw", { name: "臺中線", operator: "國營臺灣鐵路股份有限公司" }, way("山線、海線共用路段", "國營臺灣鐵路股份有限公司"), true],
  ["tw", { name: "海岸線", operator: "國營臺灣鐵路股份有限公司" }, way("山線、海線共用路段", "國營臺灣鐵路股份有限公司"), true],
  // ── tw: what must NEVER be merged ──
  ["tw", { name: "臺中線", operator: "國營臺灣鐵路股份有限公司" }, way("舊山線"), false],
  ["tw", { name: "高雄捷運橘線", operator: "高雄捷運股份有限公司" }, way("高雄捷運環狀輕軌", "高雄捷運公司"), false],
  ["tw", { name: "高雄捷運紅線", operator: "高雄捷運股份有限公司" }, way("高雄捷運橘線", "高雄捷運公司"), false],
  ["tw", { name: "海岸線", operator: "國營臺灣鐵路股份有限公司" }, way("成追線", "國營臺灣鐵路股份有限公司"), false],
  ["tw", { name: "阿里山線", operator: "阿里山林業鐵路及文化資產管理處" }, way("阿里山森林鐵路登山本線 (已崩塌舊線)"), false],
  ["tw", { name: "阿里山線", operator: "阿里山林業鐵路及文化資產管理處" }, way("阿里山森林鐵路水山支線"), false],
  // ── kr: the system prefix and the branch filed under its parent ──
  ["kr", { name: "서울 지하철 7호선", operator: "서울교통공사" }, way("7호선", "서울교통공사"), true],
  ["kr", { name: "서울 지하철 2호선", operator: "서울교통공사" }, way("2호선", "서울교통공사"), true],
  ["kr", { name: "서울 지하철 9호선", operator: "서울시메트로9호선" }, way("9호선", "서울시메트로9호선"), true],
  ["kr", { name: "서울 지하철 2호선 신정지선", operator: "서울교통공사" }, way("신정지선", "서울교통공사"), true],
  ["kr", { name: "서울 지하철 2호선 성수지선", operator: "서울교통공사" }, way("성수지선", "서울교통공사"), true],
  ["kr", { name: "서울 경전철 신림선", operator: "로템SRS" }, way("신림선"), true],
  ["kr", { name: "부산 도시철도 3호선", operator: "부산교통공사" }, way("부산 도시철도 3호선", "부산교통공사"), true],
  // ── kr: what must NEVER be merged ──
  ["kr", { name: "서울 지하철 7호선", operator: "서울교통공사" }, way("5호선", "서울교통공사"), false],
  ["kr", { name: "서울 지하철 2호선", operator: "서울교통공사" }, way("신정지선", "서울교통공사"), false],
  ["kr", { name: "경부선", operator: "한국철도공사" }, way("경부고속선", "한국철도공사"), false],
  ["kr", { name: "동해선", operator: "한국철도공사" }, way("동해본선", "한국철도공사"), false],
  // ── jp: the rules the module was built for, unchanged by the widening ──
  ["jp", { name: "日光線", operator: "東武鉄道", operatorShort: "東武" }, way("東武日光線", "東武鉄道"), true],
  ["jp", { name: "横須賀線", operator: "東日本旅客鉄道" }, way("東海道本線（横須賀線）", "東日本旅客鉄道"), true],
  ["jp", { name: "筑豊線", operator: "九州旅客鉄道" }, way("JR福北ゆたか線", "九州旅客鉄道"), true],
  ["jp", { name: "東北線", operator: "東日本旅客鉄道" }, way("京浜東北線", "東日本旅客鉄道"), false],
  ["jp", { name: "福知山線", operator: "西日本旅客鉄道" }, way("阪急宝塚本線", "阪急電鉄"), false],
];

test("every country's OSM spellings resolve to the line the package draws", () => {
  const wrong = [];
  for (const [country, line, osmWay, expected] of ATTRIBUTION_ROWS) {
    const actual = owns(country, line, osmWay);
    if (actual !== expected)
      wrong.push(
        `${country} ${line.name} × ${osmWay.name}: owns=${actual}, expected ${expected}`,
      );
  }
  assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
});

// A way named after the structure it runs through says nothing about which
// railway owns it. Taiwan names hundreds of running ways that way, with a
// plainer vocabulary than Japan's — a bare 橋 rather than 橋梁 — and before the
// tw structure list existed, 南迴線 alone stood on 123 samples of "somebody
// else's railway" that were bridges and a rockfall shelter.
test("a structure name is undecidable, never a disagreement", () => {
  const rows = [
    ["tw", "嘉和遮體"],
    ["tw", "新武呂溪橋"],
    ["tw", "曾文溪橋"],
    ["tw", "竹東大橋"],
    ["tw", "客城鐵橋"],
    ["tw", "鯉魚潭拱橋"],
    ["tw", "山里隧道"],
    ["tw", "舊山線大安溪鐵橋"],
    ["jp", "第一多摩川橋梁"],
    ["jp", "青函トンネル"],
    ["kr", "한강철교"],
  ];
  for (const [country, name] of rows)
    assert.equal(
      wayNameSpellings(name, [], country).length,
      0,
      `${country} ${name} should identify no railway`,
    );
});

// Expansion is additive on purpose: the name as written must always survive,
// or a pair that already agreed would stop agreeing.
test("expansion never loses the name as written", () => {
  const rows = [
    ["jp", "東海道本線"],
    ["tw", "縱貫線"],
    ["tw", "高雄捷運環狀輕軌"],
    ["kr", "경부선"],
    ["kr", "부산 도시철도 3호선"],
    ["hk", "東鐵綫"],
    ["mo", "氹仔線"],
  ];
  for (const [country, name] of rows)
    assert.ok(
      wayNameSpellings(name, [], country).includes(name),
      `${country} ${name} lost its own spelling`,
    );
});

// A country with no rule table would silently borrow Japan's, and a Japanese
// rule table cannot read a Korean name — the audit would report nothing and
// look clean. Every country the audit accepts must have its own entry.
test("every audited country has naming rules, and an unknown one throws", () => {
  for (const country of ["jp", "tw", "hk", "mo", "kr"])
    assert.ok(namingRulesFor(country), `${country} has no naming rules`);
  assert.throws(() => namingRulesFor("xx"), /no track-attribution naming rules/);
});
