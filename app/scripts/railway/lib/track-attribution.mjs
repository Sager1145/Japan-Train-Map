/*
 * track-attribution.mjs — decide whether a drawn line is on ITS OWN railway,
 * by NAME, not by distance.
 *
 * Why this exists: validate-basemap-alignment.mjs measures every sample to the
 * NEAREST active OSM rail way and only reports past 50 m. A line drawn on the
 * wrong railway's metals is 0.2–1.3 m from a rail, so that gate can never fire
 * — 京浜急行電鉄's 空港線 leaves 京急蒲田 along 90 m of 京急本線 track before
 * cutting across to its own, and the corridor audit scored the whole line
 * clean (median 1.97 m, max 9.67 m, findings 0). The only way to see it is to
 * ask WHOSE track the stroke is standing on.
 *
 * That is the same question scripts/railway/lib/station-track-claim.mjs already
 * answers inside a station, so this module reuses its identity ladder rather
 * than inventing a second one. Two things are added on top, both about reading
 * OSM's corridor-wide NAMES rather than a station's platform roads:
 *
 *  1. The operator-only level is dropped. `claimFilterFor` ranks "any running
 *     way this company owns" third, which is right for a platform road and
 *     fatal here: 京急本線 IS a 京浜急行電鉄 way, so a 京急 branch drawn on the
 *     京急 trunk claims its own operator's track and the defect disappears.
 *     Attribution is decided on the NAME; the operator only strengthens or
 *     weakens a name that already agrees.
 *
 *  2. A way name is expanded into every spelling it can stand for, because
 *     OSM Japan decorates corridor names in ways a station never sees:
 *       東海道本線（横須賀線）   a qualified pair — the way IS both
 *       JR鶴見線 大川支線        a branch named after its parent
 *       山陽新幹線・博多南線     one pair of metals, several lines
 *       京王電鉄相模原線 (Keio…) a romaji gloss
 *       東武日光線               the operator's BRAND, not its legal name
 *     Without the expansion each of those reads as somebody else's railway and
 *     the audit reports a line for running on its own track. The brand prefix
 *     comes from the package's own `operatorShort`, so nothing is guessed.
 *
 * What the criterion deliberately does NOT report:
 *   · genuine shared track — where a branch really does run on the trunk's
 *     metals, OSM names the way for the trunk and NOTHING named for the branch
 *     is in reach, so `claimedTrackAt` finds nothing and the sample is skipped.
 *     A verdict is only ever issued when the line's own metals are mapped
 *     HERE and the stroke is demonstrably not on them.
 *   · company boundaries and through running — a way carrying the line's name
 *     under a neighbour's operator still matches (station-track-claim's
 *     `name_other_operator` level), because 神戸高速線, 亀山, 上越妙高, 児島 and
 *     関西空港 are all places where the neighbour's name on the metals is the
 *     correct one.
 *   · unnamed ways and structure names (…トンネル / …橋梁) — a way that does
 *     not say which railway it is cannot disagree with us. Undecidable is
 *     reported as nothing, never as a defect.
 *
 * Finally, a mismatch is classified rather than judged. Where the line's own
 * way runs PARALLEL to the one the stroke is standing on, this is a multi-track
 * corridor whose tracks OSM names separately (東海道本線 / 京浜東北線 / 山手線
 * are 15–30 m apart and N02 draws one centre-line for the railway): the stroke
 * is on the right railway at the wrong track offset, which is a survey
 * resolution matter. Where the two DIVERGE, the stroke is on a track heading
 * somewhere else — the 京急蒲田 shape. Only the divergent class is a candidate
 * defect, and the audit says which is which instead of guessing.
 */
import { claimFilterFor } from "./station-track-claim.mjs";
import { headingDegrees, angleBetweenHeadings, pointSegmentDistanceMeters } from "./railway-topology.mjs";

// A structure, not a railway: naming a way after the tunnel it runs through
// says nothing about which line owns it.
const STRUCTURE_NAME = /(?:トンネル|隧道|橋梁|架道橋|高架橋)$/u;

/**
 * Taiwan names a great many running ways after the structure they cross, and
 * with a plainer vocabulary than Japan: 曾文溪橋, 竹東大橋, 客城鐵橋,
 * 鯉魚潭拱橋, 枋野二號橋, 山里隧道, 嘉和遮體 (a rockfall shelter). Japan's list
 * has 橋梁 but not a bare 橋, so every one of those read as "somebody else's
 * railway" — 南迴線 alone stood on 123 such samples. A name ending in a
 * structure noun cannot say which railway owns it, so it must be undecidable.
 * Line names end in 線, never in 橋 or 隧道, so the suffixes cannot collide.
 */
const STRUCTURE_NAME_HANT = /(?:隧道|明隧道|遮體|橋梁|鐵橋|拱橋|大橋|陸橋|高架橋|架道橋|橋)$/u;
// Korean structures, for the same reason. None showed up in the cached cells —
// kr geometry is OSM-derived and follows the named ways — so this is a guard,
// not a fix for a measured miss.
const STRUCTURE_NAME_KO = /(?:터널|철교|대교|교량|고가교)$/u;

/**
 * Marketing names OSM writes on the metals instead of the legal line name.
 *
 * Only PURE RENAMES belong here: the 愛称 and the 線名 are one and the same
 * pair of rails, so a stroke on one is on the other. A service that has its own
 * tracks in a shared corridor does NOT — 京浜東北線 runs on the 東北本線's
 * 電車線, a different pair of rails 15-30 m from the 列車線, and collapsing the
 * two would hide exactly the offset this criterion is for. Same reason
 * 総武緩行線, 中央緩行線, 東海道貨物線, 梅田貨物線, 尻手短絡線 and 青梅短絡線
 * are absent: each is its own track.
 *
 * Keyed on the way's spelling EXACTLY as OSM writes it, whitespace stripped —
 * not on the normalised form. `normaliseLineName` drops a leading JR, and
 * several of these names belong to somebody else without it: 阪急電鉄 runs a
 * 宝塚線, a 京都線 and a 神戸線 of its own, all beside the JR line of the same
 * bare name. Keyed loosely, an 阪急宝塚本線 way would have counted as JR's
 * 福知山線 metals. So the JR-branded nicknames are listed only with their JR,
 * and only the spellings that are nobody else's appear bare.
 */
const LINE_NICKNAMES = new Map([
  // JR九州 — 折尾–桂川 and 桂川–博多 are timetabled as one 福北ゆたか線.
  ["JR福北ゆたか線", ["筑豊線", "篠栗線"]],
  ["福北ゆたか線", ["筑豊線", "篠栗線"]],
  // JR西日本 アーバンネットワーク — every one of these renames a whole line.
  ["JR大和路線", ["関西線"]],
  ["大和路線", ["関西線"]],
  ["JR琵琶湖線", ["東海道線", "北陸線"]],
  ["琵琶湖線", ["東海道線", "北陸線"]],
  ["JR京都線", ["東海道線"]],
  ["JR神戸線", ["東海道線", "山陽線"]],
  ["JR宝塚線", ["福知山線"]],
  ["JR学研都市線", ["片町線"]],
  ["学研都市線", ["片町線"]],
  ["JRゆめ咲線", ["桜島線"]],
  ["ゆめ咲線", ["桜島線"]],
  ["JR嵯峨野線", ["山陰線"]],
  ["嵯峨野線", ["山陰線"]],
]);
/**
 * Taiwan's equivalent — again, only where one name and another are the SAME
 * pair of rails.
 *
 * 山線、海線共用路段 is literally "the section the mountain line and the coast
 * line share": one railway carrying both 臺中線 and 海岸線 between 彰化 and
 * 追分, and OSM says so on the way itself. Left out, both lines report 198
 * samples on somebody else's track over track they genuinely share.
 *
 * 舊山線 is deliberately absent even though it is 山線 with one character in
 * front: it is the ABANDONED 1908 alignment through 勝興, a different pair of
 * rails, and the whole point of the audit is to notice a stroke that has
 * wandered onto it. Keyed on the exact spelling, it cannot be reached from
 * 山線 — the same protection the JR-branded jp nicknames rely on.
 */
const LINE_NICKNAMES_HANT = new Map([
  ["山線、海線共用路段", ["臺中線", "海岸線"]],
  ["山海線共用路段", ["臺中線", "海岸線"]],
]);

/**
 * System names OSM puts in front of a line name, per country.
 *
 * These are stripped from BOTH the way name and the package line name, because
 * unlike Japan — where OSM writes the longer name (東武日光線) and the package
 * the shorter (日光線) — Taiwan and Korea disagree in both directions at once:
 *
 *   OSM 捷運文湖線          package 文湖線           OSM is longer
 *   OSM 捷運紅線            package 高雄捷運紅線     package is longer
 *   OSM 7호선               package 서울 지하철 7호선  package is longer
 *   OSM 부산 도시철도 3호선   package 부산 도시철도 3호선  they agree
 *
 * Stripping one side only fixes half the rows; stripping both fixes all of
 * them, and stripping is ADDITIVE (the undecorated spelling is added, the
 * decorated one is kept), so a pair that already agrees still agrees.
 *
 * What this deliberately does NOT do is merge two systems. 高雄捷運 and
 * 環狀輕軌 survive it as 橘線/紅線 versus 環狀輕軌 — different tails, no
 * collision — which is why the adjudicated 高雄捷運橘線 ↔ 環狀輕軌 parallel
 * stays visible instead of being defined away. Where stripping DOES bring two
 * real railways together — Seoul's 1호선 and 인천 도시철도 1호선 both reduce to
 * 1호선, and they meet at 부평 — the operator does the separating, exactly as
 * it does for jp's two 日光線: a way whose operator disagrees is only ever
 * accepted by the last rung of the ladder, after every better-identified way
 * in reach has been tried.
 */
const SYSTEM_PREFIXES_HANT = [
  "臺北大眾捷運",
  "台北大眾捷運",
  "高雄捷運",
  "臺中捷運",
  "台中捷運",
  "新北捷運",
  "桃園捷運",
  "阿里山森林鐵路",
  "臺北",
  "台北",
  "高雄",
  "臺中",
  "台中",
  "新北",
  "桃園",
  "捷運",
];
const SYSTEM_PREFIXES_KO = [
  "서울 지하철",
  "서울 경전철",
  "부산 도시철도",
  "대구 도시철도",
  "인천 도시철도",
  "광주 도시철도",
  "대전 도시철도",
  "의정부 경전철",
  "용인 경전철",
  "수도권 전철",
];

/**
 * A suffix naming ONE running track of a railway the package draws as one
 * centre-line.
 *
 * 縱貫線東正線 / 縱貫線西正線 / 縱貫線中正線 are the up, down and centre main
 * tracks of the 縱貫線 — the same railway, surveyed track by track. This is not
 * the jp 京浜東北線-on-東北本線 case that LINE_NICKNAMES refuses: there the two
 * names are different SERVICES on different pairs of rails; here 正線 means
 * "main running track" and the name in front of it is the railway's own. The
 * offset between them is still visible, as the INFO ("same corridor,
 * neighbouring track") grade the criterion already has.
 */
const TRACK_QUALIFIER_HANT = /(?:[東西南北中上下]?正線)$/u;

/**
 * A suffix naming one SECTION of a railway the package files as two lines.
 *
 * The tw package splits 縱貫線 into 縱貫線北段 and 縱貫線南段 at 彰化; OSM does
 * not, and writes 縱貫線 (or 縱貫線 (南段)) along the whole thing. Both package
 * lines are the 縱貫線, so both may stand on its metals — and because they are
 * the same railway, the fact that stripping the suffix lets one claim the
 * other's track is the correct answer, not a hole.
 */
const SECTION_SUFFIX_HANT = /(?:[東西南北中]段)$/u;

// A parenthesised gloss written in Latin letters is a translation, not a line.
const ROMAJI_GLOSS = /[（(][ -~À-ɏ]+[）)]\s*$/u;

/**
 * Per-country naming rules. Every country the audit can run for MUST have an
 * entry: falling back to Japan's rules for an unlisted country is how a run
 * reports "no findings" because it could not read a single way name.
 */
const COUNTRY_RULES = new Map([
  [
    "jp",
    {
      separators: /[;/・]/u,
      structure: STRUCTURE_NAME,
      nicknames: LINE_NICKNAMES,
      systemPrefixes: [],
      trackQualifier: null,
      sectionSuffix: null,
      // 東海道本線（横須賀線）→ both; JR鶴見線 大川支線 → both.
      spacedTail: /^(\S+線)\s+(\S+線)$/u,
      fold: (text) => text,
      railwayWord: null,
    },
  ],
  [
    "tw",
    {
      // "、" is how Chinese OSM joins two names on one pair of metals.
      separators: /[;/・、]/u,
      structure: STRUCTURE_NAME_HANT,
      nicknames: LINE_NICKNAMES_HANT,
      systemPrefixes: SYSTEM_PREFIXES_HANT,
      trackQualifier: TRACK_QUALIFIER_HANT,
      sectionSuffix: SECTION_SUFFIX_HANT,
      spacedTail: /^(\S+線)\s+(\S+線)$/u,
      // OSM writes both 台東線 (153 ways) and 臺東線 (82) for one railway; the
      // package writes 臺東線. Folding 臺→台 makes the two comparable, and no
      // pair of distinct Taiwanese railways differs only by that character.
      fold: (text) => text.replace(/臺/gu, "台"),
      // 縱貫鐵路東正線(南段) is the 縱貫線. Same shape as jp's 本線 → 線.
      railwayWord: /鐵路$/u,
    },
  ],
  [
    "kr",
    {
      separators: /[;/]/u,
      structure: STRUCTURE_NAME_KO,
      nicknames: new Map(),
      systemPrefixes: SYSTEM_PREFIXES_KO,
      trackQualifier: null,
      sectionSuffix: null,
      // 서울 지하철 2호선 신정지선 → 신정지선, and 서울 지하철 7호선 → 7호선:
      // the trailing space-separated token, whenever it ends in 선 and is not
      // the whole name. jp's rule is the same idea with 線 and both halves.
      spacedTail: /^.+\s(\S+선)$/u,
      fold: (text) => text,
      railwayWord: null,
    },
  ],
  [
    "hk",
    {
      separators: /[;/・、]/u,
      structure: STRUCTURE_NAME_HANT,
      nicknames: new Map(),
      // Not surveyed for this batch: hk/mo keep the structure and separator
      // rules (which cannot over-match) and no prefix rules, so the criterion
      // stays conservative rather than guessing at systems nobody measured.
      systemPrefixes: [],
      trackQualifier: null,
      sectionSuffix: null,
      spacedTail: /^(\S+線)\s+(\S+線)$/u,
      fold: (text) => text.replace(/臺/gu, "台"),
      railwayWord: null,
    },
  ],
  [
    "mo",
    {
      separators: /[;/・、]/u,
      structure: STRUCTURE_NAME_HANT,
      nicknames: new Map(),
      systemPrefixes: [],
      trackQualifier: null,
      sectionSuffix: null,
      spacedTail: /^(\S+線)\s+(\S+線)$/u,
      fold: (text) => text.replace(/臺/gu, "台"),
      railwayWord: null,
    },
  ],
]);

export function namingRulesFor(country) {
  const rules = COUNTRY_RULES.get(country);
  if (!rules) throw new Error(`no track-attribution naming rules for country ${country}`);
  return rules;
}

/**
 * Every line spelling one written name can legitimately stand for.
 *
 * Used on BOTH sides of the comparison — the OSM way's name and the package
 * line's own name go through the same expansion, because Taiwan and Korea
 * decorate in both directions (see SYSTEM_PREFIXES_HANT). Expansion is purely
 * additive: the name as written is always among the results, so a pair that
 * already agreed still agrees.
 *
 * Returns an empty array for a name that identifies no railway at all — a
 * structure name, or nothing — and the caller must treat that as undecidable,
 * never as a disagreement.
 */
export function wayNameSpellings(rawName, brandPrefixes = [], country = "jp") {
  const rules = namingRulesFor(country);
  const name = String(rawName || "").trim();
  if (!name) return [];
  const seeds = new Set();
  const add = (value) => {
    const text = String(value || "").trim();
    if (!text || rules.structure.test(text)) return;
    seeds.add(text);
  };
  // The nickname table is consulted on the WHOLE name first, before any
  // splitting: 山線、海線共用路段 is one name whose "、" is part of it, and
  // splitting first left the two halves 山線 and 海線共用路段, neither of which
  // is a key. (It is consulted again at the end, on each derived spelling.)
  for (const legal of rules.nicknames.get(name.replace(/\s+/gu, "")) || []) seeds.add(legal);
  // ";" and "/" are station-track-claim's own multi-value separators; "・" and
  // "、" are how OSM joins the lines that share one pair of metals.
  for (const part of name.split(rules.separators)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const plain = trimmed.replace(ROMAJI_GLOSS, "").trim();
    add(plain);
    // 東海道本線（横須賀線） / 臺中線 (山線) / 縱貫鐵路東正線(南段) — the way is
    // the parent AND the qualified child.
    const bracketed = /^(.+?)\s*[（(]([^）)]+)[）)]$/u.exec(plain);
    if (bracketed) {
      add(bracketed[1]);
      add(bracketed[2]);
    }
    // JR阪和線東羽衣支線 — the SAME shape with the space left out, which is how
    // OSM writes most of them. Restricted to a 支線 tail on purpose: "…線…支線"
    // can only be a branch filed under the railway it branches from, whereas a
    // bare "…線…線" split would let 東海道本線東海道貨物線 read as the 本線 and
    // collapse a distinct pair of metals into its parent — the very offset this
    // criterion exists to see. 阪和線-2 IS the 東羽衣支線, and without this it
    // was reported for standing on its own branch's only track.
    const suffixed = /^(.+?線)(.+支線)$/u.exec(plain);
    if (suffixed) {
      add(suffixed[1]);
      add(suffixed[2]);
    }
    // JR鶴見線 大川支線 / 서울 지하철 2호선 신정지선 — a branch filed under its
    // parent, space separated.
    const spaced = rules.spacedTail.exec(plain);
    if (spaced) for (const group of spaced.slice(1)) add(group);
  }
  const out = new Set(seeds);
  // Each of those without the operator's brand prefix, so OSM's 東武日光線 can
  // be read as 東武鉄道's 日光線. `claimFilterFor` strips the operator's LEGAL
  // name only, on purpose (it is what keeps 東武日光線 and JR日光線 apart at
  // 日光); the brand comes from the package, so this adds a spelling the cache
  // supports rather than relaxing that rule.
  //
  // …then the system prefixes, the track qualifier and the railway word, each
  // fed back in so a name carrying several decorations at once comes apart:
  // 縱貫鐵路東正線 needs the qualifier gone before 鐵路 → 線 can apply.
  for (let pass = 0; pass < 3; pass += 1) {
    for (const seed of [...out]) {
      for (const brand of brandPrefixes)
        if (brand && seed.startsWith(brand) && seed.length > brand.length)
          add2(out, rules, seed.slice(brand.length));
      for (const prefix of rules.systemPrefixes)
        if (seed.startsWith(prefix) && seed.length > prefix.length)
          add2(out, rules, seed.slice(prefix.length));
      for (const suffix of [rules.trackQualifier, rules.sectionSuffix]) {
        if (!suffix) continue;
        const stripped = seed.replace(suffix, "");
        if (stripped !== seed && stripped.length >= 2) add2(out, rules, stripped);
      }
      if (rules.railwayWord) {
        const asLine = seed.replace(rules.railwayWord, "線");
        if (asLine !== seed) add2(out, rules, asLine);
      }
      const folded = rules.fold(seed);
      if (folded !== seed) add2(out, rules, folded);
    }
  }
  // …and the legal name behind a marketing one, so OSM's 福北ゆたか線 can be
  // read as the 筑豊本線 metals it is written on, and 山線、海線共用路段 as the
  // two railways that share it. Looked up on the spelling as written (see
  // LINE_NICKNAMES): normalising first would drop the JR that separates
  // JR宝塚線 from 阪急's.
  for (const seed of [...out])
    for (const legal of rules.nicknames.get(seed.replace(/\s+/gu, "")) || []) out.add(legal);
  return [...out];
}

/** Add a derived spelling, honouring the country's structure-name veto. */
function add2(out, rules, value) {
  const text = String(value || "").trim();
  if (!text || rules.structure.test(text)) return;
  out.add(text);
}

/**
 * The identity test for a whole corridor.
 *
 * `levels` are station-track-claim's ladder minus its operator-only rung,
 * widened on BOTH sides: every spelling the way name can stand for is tried
 * against every spelling the PACKAGE line name can stand for. One ladder per
 * package spelling is built and the rungs are OR-ed rung by rung, so the
 * ordering the ladder exists for — a way this line's own operator runs beats a
 * way merely carrying its name — survives the widening.
 *
 * `owns(meta)` answers the audit's actual question — "is this way this line's
 * own railway" — and `identifiable(meta)` separates "somebody else's" from
 * "cannot tell".
 */
export function attributionFilterFor(line, country = line.country || "jp") {
  // Same company-form stripping station-track-claim uses, so 高雄捷運股份有限公司
  // yields the brand 高雄捷運 that OSM actually writes on the metals.
  const brands = [line.operatorShort, line.operator]
    .map((value) => String(value || "").replace(/株式会社|股份有限公司|有限公司|公司|\s+/gu, ""))
    .filter((value) => value && value.length >= 2);
  // The package's own name, expanded the same way a way name is: OSM writes
  // 7호선 where the package writes 서울 지하철 7호선, and 捷運紅線 where the
  // package writes 高雄捷運紅線. `wayNameSpellings` always returns the name as
  // written, so jp — whose rule table has no prefixes to strip and no folding —
  // gets exactly the single spelling it had before.
  const lineSpellings = wayNameSpellings(line.name, brands, country);
  const bases = (lineSpellings.length ? lineSpellings : [line.name]).map((alias) =>
    claimFilterFor({ ...line, name: alias }),
  );
  const spellings = (meta) => wayNameSpellings(meta.name, brands, country);
  const widen = (rung) => ({
    strength: bases[0].levels[rung].strength,
    accept: (meta) => {
      const candidates = [meta];
      for (const spelling of spellings(meta)) candidates.push({ ...meta, name: spelling });
      for (const base of bases)
        for (const candidate of candidates) if (base.levels[rung].accept(candidate)) return true;
      return false;
    },
  });
  // operator_and_name, name, name_other_operator — the three rungs that need
  // the name to agree. The operator-only rung is what hid the 京急蒲田 defect.
  const levels = [0, 1, 3].map(widen);
  return {
    name: bases[0].name,
    aliases: lineSpellings,
    operators: bases[0].operators,
    brands,
    levels,
    identifiable: (meta) => spellings(meta).length > 0,
    owns: (meta) => levels.some((level) => level.accept(meta)),
  };
}

/**
 * Distance from `point` to a way, and whether that distance is SIDEWAYS.
 *
 * A polyline's nearest point can be its own first or last vertex, and then the
 * measurement is not an offset at all — it is how far past the END of the way
 * the point lies. OSM splits a railway into a way per tag change, so a stroke
 * running along one continuous rail crosses from a way carrying its own line's
 * name onto one carrying a neighbour's, and every metre it then walks reads as
 * another metre "away from its own track". Measured, that artefact was the bulk
 * of the first survey: 105 m runs reporting a 110 m own-track distance, on
 * railways the stroke never left (三陸鉄道's 北リアス線 where OSM has merged the
 * two halves into リアス線, 久留里線 where one way is spelt "R久留里線",
 * 赤穂線 where one is spelt "JR Akō Line").
 *
 * Only an INTERIOR nearest point measures a parallel track. `clamped` says the
 * answer is longitudinal and the caller must not treat it as a disagreement.
 */
export function lateralDistance(coordinates, point) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  let best = null;
  for (let index = 1; index < coordinates.length; index += 1) {
    const distance = pointSegmentDistanceMeters(point, coordinates[index - 1], coordinates[index]);
    if (!best || distance < best.distance) best = { distance, index };
  }
  // Within a metre of either end, the projection has run off the polyline.
  const ends = [coordinates[0], coordinates[coordinates.length - 1]];
  const clamped = ends.some(
    (end) => Math.abs(pointSegmentDistanceMeters(point, end, end) - best.distance) < 1,
  );
  return { distance: best.distance, clamped };
}

/**
 * The line's own claimed track BESIDE `point`, or null when none is in reach.
 *
 * The identity ladder is station-track-claim's minus its operator-only rung
 * (see `attributionFilterFor`), but it is used only to decide WHICH ways are
 * ours — not which of them answers. Inside a station the strongest rung wins
 * because the question is "which platform road is mine"; here the question is
 * "how far away are my metals", and the answer to that is the NEAREST way that
 * is mine by any accepted rung. Ranking by rung first got 北陸線 at 敦賀 wrong
 * by an order of magnitude: OSM files the through track as 北陸本線 under
 * ハピラインふくい (the third rung, since the 2024 三セク handover) 7.8 m away,
 * while a 北陸本線 under 西日本旅客鉄道 — first rung — sits 82.7 m off across
 * the throat, and the audit reported the 82.7.
 *
 * Then: the nearest own metals decide the verdict, INCLUDING when they present
 * themselves end-on. A clamped nearest is not a weaker answer to fall through
 * from, it is a statement that the offset cannot be measured here (see
 * `lateralDistance`), so the sample is undecidable. Falling through to a
 * further, interior way instead reported ITS distance as "how far my own track
 * is", which was false wherever OSM had merely split the corridor at a joint:
 * at 品川 the line's own 東海道本線 runs 32 m away, and because both ways
 * carrying it end beside the sample the audit answered 98.8 m and raised a
 * WARNING. Ten of the jp WARNINGs were that artefact.
 *
 * Both rules only ever move the answer CLOSER or to "cannot tell", so neither
 * can invent a disagreement. 京急蒲田 — the shape this criterion was built for
 * — is untouched: the 空港線's own metals are 33 m away and interior there.
 */
export function ownTrackAt(point, filter, index, radiusMeters) {
  let best = null;
  for (const level of filter.levels) {
    const found = index.within(point, radiusMeters, level.accept);
    for (const [meta] of found) {
      const hit = lateralDistance(meta.coordinates, point);
      if (!hit) continue;
      if (!best || hit.distance < best.distance)
        best = { distance: hit.distance, clamped: hit.clamped, way: meta, strength: level.strength };
    }
  }
  if (!best || best.clamped) return null;
  return { strength: best.strength, distance: best.distance, way: best.way };
}

/**
 * Local bearing of `coordinates` at the point on it nearest `point`.
 *
 * Used to say whether the way the stroke stands on runs PARALLEL to the line's
 * own way (a multi-track corridor) or DIVERGES from it (a junction).
 */
export function bearingAt(coordinates, point) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  let best = null;
  for (let index = 1; index < coordinates.length; index += 1) {
    const distance = pointSegmentDistanceMeters(point, coordinates[index - 1], coordinates[index]);
    if (!best || distance < best.distance)
      best = { distance, a: coordinates[index - 1], b: coordinates[index] };
  }
  return best ? headingDegrees(best.a, best.b) : null;
}

/** Smallest angle between two headings, ignoring which way round they point. */
export function axisDifference(a, b) {
  if (a == null || b == null) return null;
  const raw = angleBetweenHeadings(a, b);
  return raw > 90 ? 180 - raw : raw;
}
