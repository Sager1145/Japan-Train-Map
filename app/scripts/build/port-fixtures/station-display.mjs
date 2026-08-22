// =========================================================================
//  station-display.json — which station marks the map draws, where, and
//  what they are called
//
//  Three questions, one fixture, because they are the same question asked of
//  three collections and they share every hazard:
//
//    1. railmap-popup.js buildPopupModel — the C5 bilingual hover popup's
//       MODEL: given a station, which lines call there, in what order, with
//       what label, company and badge. (The HTML is the shell's problem and
//       is not recorded here.)
//    2. rail-network.js's station-label election — which of a complex's
//       platforms carries the name, so 東京 is named ONCE rather than nine
//       times. Two passes: one elected platform per station group, then a
//       600 m merge for the complexes the source data splits (JR East's 東京
//       and 東京メトロ's 東京 arrive as two groups four hundred metres apart).
//    3. railmap-geometry.js markerLabelWinners + markerRecordsToFC — the same
//       election again over a RIDE's own station dots, plus the three role
//       tiers that decide which of a ride's stations are named at all.
//
//  All three are ordering-and-identity problems rather than arithmetic, and
//  both of the differences between JavaScript and Swift that decide them are
//  invisible in a small sample:
//
//    * JavaScript compares strings by UTF-16 CODE UNIT. Swift's String — and
//      therefore Dictionary, Set and == — compares by canonical equivalence.
//      The shipped jp package spells 笹塚 with U+FA10 CJK COMPATIBILITY
//      IDEOGRAPH-585A, whose canonical decomposition is U+585A, so the two
//      languages disagree about whether that name equals the one a human
//      types. It is the only non-NFC name in all five packages (measured:
//      1 of 10,361 distinct names), which is exactly why volume alone would
//      never catch it — hence the synthetic packages below that put both
//      spellings 100 m apart.
//    * Array.prototype.sort is STABLE (ES2019). Swift's sort is not
//      guaranteed to be. The popup sorts its rows by label, and twelve real
//      station popups contain two rows with the SAME label (米原 lists
//      東海道線 (Tokaido Line) twice, from JR Central's two strokes), so the
//      tie is not hypothetical.
//
//  …and one that is not a language difference at all: the popup sorts with
//  `String.prototype.localeCompare`, whose answer depends on the HOST's
//  collation and locale. Node resolves it to en-US here. The `comparator`
//  section records every ordered pair the five packages actually compare
//  (3,511 of them) plus a block chosen to separate the plausible Swift
//  spellings, so the port can state what it matches rather than assume.
//
//  Inputs are the five shipped rail packages (12,685 stations, 804 lines) and
//  the five committed train stores (232 trains). Nothing reads
//  app/data/sample-data*/, which is gitignored: a fixture that cannot be
//  regenerated from a clean checkout cannot be checked by `--check`.
// =========================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const name = "station-display.json";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(SCRIPT_DIR, "..", "..", "..");
const require = createRequire(import.meta.url);
const AppCore = require(path.join(APP_DIR, "shared", "app-core.js"));
const RailNetwork = require(path.join(APP_DIR, "public", "rail-network.js"));

const COUNTRIES = ["mo", "hk", "tw", "kr", "jp"];

const readPublic = (file) =>
  fs.readFileSync(path.join(APP_DIR, "public", file), "utf8");
const readData = (file) =>
  JSON.parse(fs.readFileSync(path.join(APP_DIR, "data", file), "utf8"));

// ── loading the implementations under test ──────────────────────────────
//
// Every one of them is a classic script sharing one global lexical scope, so
// they are evaluated rather than imported — the technique loadFrontendScope
// uses in build-port-fixtures.mjs. A fixture generated from a re-typed copy
// would only prove that the copy and the port agree, which is not the
// question being asked.

/** railmap-popup.js, with the real branding tables underneath it. */
function loadPopupScope() {
  const branding = new Function(
    "window",
    `${readPublic("app-operator-branding.js")}\nreturn RailOperatorBranding;`,
  )({});
  // railmap-popup.js is an IIFE that captures `window` once and reads
  // `global.I18N` on every call, so the naming stubs below can be swapped in
  // and out between calls on this same object.
  const scope = { RailNetwork, RailOperatorBranding: branding };
  new Function("window", readPublic("railmap-popup.js"))(scope);
  return { popup: scope.RailMapPopup, scope };
}

// The app family that buildDeckMarkerRecords needs, in index.html order.
// It is a long list because a ride's marker records are the product of the
// whole itinerary pipeline — station resolution, ride flags, day spans — and
// the ROLE each record carries (terminal / stop / pass / xday / stop-center)
// is what the three label tiers key on. Re-deriving those roles here would
// make the fixture a second opinion about them.
const DECK_SCOPE_FILES = [
  "railmap-basemap.js", // window.RailMapBasemap
  "railmap-style.js", // window.RailMapStyle — railmap-geometry.js destructures it
  "railmap-geometry.js", // markerLabelWinners + markerRecordsToFC, under test
  "app-config.js", // DISPLAY_DEFAULTS and the style tokens
  "app-display-values.js", // DISPLAY — the marker radii come from here
  "app-coords.js", // getFeatureDisplayCoordinate
  "app-route-simplify.js", // distanceMeters, for the station resolver seam
  "app-datasets.js", // the dataset installs + the station indexes
  "app-stations.js", // station resolution
  "app-editor.js", // effectivelyRiddenStopIndexes / effectiveStopRide
  "app-dates.js", // getTrainDate / getTrainDaySpan — the xday diamonds
  "app-route-graph.js", // getAllowedInstitutionTypeCodes
  "app-route-solver.js", // filterStationsByPreferredInstitution
  "app-store-ops.js", // getRideRouteSectionsForTrain
  "app-route-features.js", // getStopFeature
  "app-style.js", // stopMarkerStyleValues / passThroughMarkerStyleValues
  "app-deck-records.js", // buildDeckMarkerRecords, under test
];

// The free variables those files expect the REST of the family to have
// declared. Six are deliberately stubs, and each is inert for everything this
// fixture records:
//
//   I18N                     presentation; nothing in a marker record reads it.
//   routeRecordScopeFlags    app-overlap-lanes.js. `focused` is hard-coded
//                            false there (the record cache must not depend on
//                            which train is picked) and `dimmed` follows the
//                            date scope, which is inactive here — so this stub
//                            returns exactly what the real one returns with no
//                            concrete day selected. Neither flag reaches a
//                            role, a name or a position.
//   anyRiddenCategoryHidden  the 新幹線/JR在來線/地下鐵/私鐵 toggles, all on by
//                            default; false is that default, and it is what
//                            keeps markerCategoryForStation unreachable.
//   markerCategoryForStation app-stats.js, and only called when the toggles
//                            above are NOT all on.
//   riddenFeature*           app-stats.js again, read only by the route-record
//                            path this fixture never enters.
//   routeSegmentStyleValues  app-style.js's LINE styling, likewise.
const DECK_PRELUDE = `
  const I18N = { t: (key) => key, stationName: (name) => name, nameReadingsList: () => [] };
  let trainStore = { trains: [] };
  let selectedDate = "__all__";
  let manualDates = [];
  let cachedRouteDateActive = false;
  function routeRecordScopeFlags() { return { focused: false, dimmed: false }; }
  function anyRiddenCategoryHidden() { return false; }
  function markerCategoryForStation() { return null; }
  const RIDDEN_CATEGORY_FILTER = { hsr: true, jr: true, metro: true, priv: true };
  function riddenFeatureVisible() { return true; }
  function riddenFeatureCategory() { return null; }
  function routeSegmentStyleValues() { return { opacity: 1, width: 1 }; }
  function yieldToEventLoop() { return Promise.resolve(); }
  function fetchText() { return Promise.resolve("[]"); }
  function railSectionsApiForCountry() { return ""; }
  function configureRouteSolverApi() {}
  function configureRouteGraphApi() {}
  function invalidateRouteCaches() {}
  function scheduleRender() {}
`;

const DECK_EPILOGUE = `
  // app-route-service.js's own wiring, reproduced because that file is the
  // solver's runtime lifecycle owner and pulls in far more than resolution.
  // The three functions handed over are the real ones.
  configureStationRouteResolver({
    allowedInstitutionCodes: getAllowedInstitutionTypeCodes,
    filterPreferredStations: filterStationsByPreferredInstitution,
    distanceMeters,
  });
  return {
    buildDeckMarkerRecords,
    markerRecordsToFC: window.RailMapGeometry.markerRecordsToFC,
    buildStationIndexesSliced,
    AppDatasets,
    setStore: (value) => { trainStore = value; },
  };
`;

function loadDeckScope() {
  const source = DECK_SCOPE_FILES.map(readPublic).join("\n");
  return new Function(
    "window",
    DECK_PRELUDE + "\n" + source + "\n" + DECK_EPILOGUE,
  )({ AppCore, RailNetwork });
}

// ── synthetic packages, written to break a port rather than pass it ──────
//
// These are real compact-v1 packages run through the real
// buildNetworkFromCompactPackage, so the Swift side can decode the very same
// JSON with its own CompactPackage and reach the same network — no
// hand-assembled network objects on either side.
//
// Every invisible character is written as an escape. Which invisible
// character a case is about IS the case, and a literal would be invisible in
// the diff that one day changes it.

const SASA_FA10 = "笹塚"; // 笹塚 — the spelling the jp package ships
const SASA_585A = "笹塚"; // 笹塚 — the spelling a human types
const RIGHT_QUOTE = "’";

/** One line of a synthetic package: N stations, N−1 chained intervals. */
function syntheticLine(id, name, operator, stations, extra = {}) {
  const coords = stations.map((row) => [row[2], row[3]]);
  return {
    id,
    name,
    operator,
    rank: 2,
    color: "#112233",
    stations,
    segments: coords.slice(1).map((coord, index) =>
      index === 0
        ? [1.5, 0, [coords[0], coord]]
        : [1.5, 1, [coord]],
    ),
    ...extra,
  };
}

const SYNTHETIC_PACKAGES = [
  {
    key: "shared-group",
    why:
      "Two railways calling at one station group. The popup keys its dedupe " +
      "on the DISPLAYED operator + name, so the two strokes of one railway " +
      "collapse to a single row while a second operator's identically named " +
      "line keeps its own — and those two rows then carry the SAME label, " +
      "which is the stable-sort tie.",
    package: {
      format: "compact-v1",
      version: "synthetic",
      country: "jp",
      lines: [
        syntheticLine("syn-a-main", "本線", "甲鉄道", [
          ["G1", "中央", 139.7, 35.68, "Chuo", 3],
          ["G2", "北", 139.71, 35.69, "Kita", 3],
        ]),
        syntheticLine("syn-a-main-2", "本線", "甲鉄道", [
          ["G1", "中央", 139.7, 35.68, "Chuo", 3],
          ["G3", "南", 139.71, 35.67, "Minami", 3],
        ]),
        syntheticLine("syn-b-main", "本線", "乙鉄道", [
          ["G1", "中央", 139.7, 35.68, "Chuo", 3],
          ["G4", "東", 139.72, 35.68, "Higashi", 3],
        ]),
      ],
    },
  },
  {
    key: "compatibility-ideograph",
    why:
      "The 笹塚 hazard, as a LINE name so it reaches the popup's dedupe key. " +
      "U+FA10 and U+585A are canonically equivalent and NOT code-unit equal, " +
      "so JavaScript keeps two rows and a Swift Set<String> keeps one. And " +
      "as a STATION name 100 m away, where the label election's " +
      "`other.name !== name` test decides whether one place or two get named.",
    package: {
      format: "compact-v1",
      version: "synthetic",
      country: "jp",
      lines: [
        syntheticLine("syn-fa10", `${SASA_FA10}線`, "丙鉄道", [
          ["H1", SASA_FA10, 139.6, 35.67, "Sasazuka", 3],
          ["H2", "西", 139.61, 35.67, "Nishi", 3],
        ]),
        syntheticLine("syn-585a", `${SASA_585A}線`, "丙鉄道", [
          ["H1", SASA_FA10, 139.6, 35.67, "Sasazuka", 3],
          ["H3", "東", 139.62, 35.67, "Higashi", 3],
        ]),
        // A separate GROUP, ~100 m away, spelled the other way. Only the
        // 600 m merge can drop it, and only if the two names are judged equal.
        syntheticLine("syn-sasa-far", "別線", "丁鉄道", [
          ["H9", SASA_585A, 139.60112, 35.67, "Sasazuka", 3],
          ["H8", "南", 139.6, 35.66, "Minami", 3],
        ]),
      ],
    },
  },
  {
    key: "collation",
    why:
      "The one real ordering disagreement, isolated: U+2019 RIGHT SINGLE " +
      "QUOTATION MARK sorts BEFORE a letter under ICU collation and AFTER it " +
      "by code unit, so San" + RIGHT_QUOTE + "yo Main Line and Sanyo Line " +
      "come out in opposite orders. Both spellings really ship — 下関 lists " +
      "them together.",
    package: {
      format: "compact-v1",
      version: "synthetic",
      country: "jp",
      lines: [
        syntheticLine(
          "syn-sanyo-w",
          "山陽線",
          "戊鉄道",
          [
            ["K1", "関", 130.94, 33.95, "Seki", 3],
            ["K2", "西", 130.93, 33.95, "Nishi", 3],
          ],
          { nameRoma: `San${RIGHT_QUOTE}yo Main Line` },
        ),
        syntheticLine(
          "syn-sanyo-k",
          "山陽線",
          "己鉄道",
          [
            ["K1", "関", 130.94, 33.95, "Seki", 3],
            ["K3", "東", 130.95, 33.95, "Higashi", 3],
          ],
          { nameRoma: "Sanyo Line" },
        ),
      ],
    },
  },
  {
    key: "merge-radius",
    why:
      "The 600 m merge, straddled by 0.36 m. 境 appears in four groups: the " +
      "first is accepted, the second at 599.8 m is dropped, and the third at " +
      "600.2 m is KEPT — which also proves that a dropped feature never " +
      "becomes an anchor, since the third sits 0.36 m from the second and " +
      "would have merged into it. The distance is rail-network.js's own " +
      "EQUIRECTANGULAR metric (111 320 m per degree), not the route solver's " +
      "haversine: the two are 0.1125% apart, which is 0.68 m at this " +
      "threshold, so a port that unified them would drop all three. A fourth " +
      "group carries a DIFFERENT name at 599.8 m and must survive — 新宿 and " +
      "新宿三丁目 stay two labels however close they sit.",
    package: {
      format: "compact-v1",
      version: "synthetic",
      country: "jp",
      lines: [
        syntheticLine("syn-merge-a", "甲線", "庚鉄道", [
          ["M1", "境", 139.0, 35.0, "Sakai", 3],
          ["M2", "甲端", 139.05, 35.0, "Kotan", 3],
        ]),
        // 0.006579812731° of longitude at 35°N is exactly 600 m here.
        syntheticLine("syn-merge-b", "乙線", "辛鉄道", [
          ["M3", "境", 139.006578, 35.0, "Sakai", 3],
          ["M4", "乙端", 139.05, 35.01, "Otsutan", 3],
        ]),
        syntheticLine("syn-merge-c", "丙線", "壬鉄道", [
          ["M5", "境", 139.006582, 35.0, "Sakai", 3],
          ["M6", "丙端", 139.05, 34.99, "Heitan", 3],
        ]),
        syntheticLine("syn-merge-d", "丁線", "癸鉄道", [
          ["M7", "境町", 139.006578, 35.0, "Sakaimachi", 3],
          ["M8", "丁端", 139.05, 34.98, "Teitan", 3],
        ]),
      ],
    },
  },
  {
    key: "merge-cell-edge",
    why:
      "The cell grid, and the case it lets through. Three groups named 際 sit " +
      "on one line of latitude: C1 at a cell boundary, C3 exactly 0.0055° " +
      "further on (501 m, ONE cell away — merged, and only the " +
      "eight-neighbour scan can find it), and C5 at 0.00645° (588 m, TWO " +
      "cells away).\n\n" +
      "C5 is NOT merged, and that is a defect in the JavaScript rather than a " +
      "rule. The cell is 0.0055° but the merge radius is 600 m, which at " +
      "35°N is 0.00658° of longitude — wider than a cell — so a qualifying " +
      "pair CAN land two cells apart and the ±1 scan then misses it. " +
      "(Latitude is safe: 600 m is 0.00539°, under one cell.) Measured " +
      "against all five shipped packages, no real pair reaches it — 0 of the " +
      "10,881 elected labels has a same-named neighbour inside 600 m — so " +
      "this is a latent defect, and the port reproduces it rather than " +
      "quietly widening the scan. Note the contrast with the ride election, " +
      "whose merge distance IS its cell size and which therefore cannot have " +
      "this hole.",
    package: {
      format: "compact-v1",
      version: "synthetic",
      country: "jp",
      lines: [
        syntheticLine("syn-cell-a", "甲線", "庚鉄道", [
          ["C1", "際", 139.19949, 35.0, "Kiwa", 3],
          ["C2", "甲端", 139.25, 35.0, "Kotan", 3],
        ]),
        syntheticLine("syn-cell-b", "乙線", "辛鉄道", [
          ["C3", "際", 139.20499, 35.0, "Kiwa", 3],
          ["C4", "乙端", 139.25, 35.01, "Otsutan", 3],
        ]),
        syntheticLine("syn-cell-c", "丙線", "壬鉄道", [
          ["C5", "際", 139.20594, 35.0, "Kiwa", 3],
          ["C6", "丙端", 139.25, 34.99, "Heitan", 3],
        ]),
      ],
    },
  },
  {
    key: "bare-line",
    why:
      "A line with neither a romanisation nor an operator: the label carries " +
      "no parenthesis and the company column is empty. Its colour is null, " +
      "which falls through to DEFAULT_LINE_COLOR — the popup swatch's only " +
      "fallback.",
    package: {
      format: "compact-v1",
      version: "synthetic",
      country: "jp",
      lines: [
        {
          id: "syn-bare",
          name: "無名線",
          operator: "",
          rank: 4,
          color: null,
          stations: [
            ["N1", "無", 140.0, 36.0],
            ["N2", "名", 140.01, 36.0],
          ],
          segments: [[0.9, 0, [[140.0, 36.0], [140.01, 36.0]]]],
        },
      ],
    },
  },
  {
    key: "loop",
    why:
      "A loop line has no terminals, so NO station keeps the line's own " +
      "minzoom and every dot is thinned by spacing alone — which changes " +
      "which platform of a shared group wins the label. isLoop is one of the " +
      "two fields a compact-package decoder has to carry for this election to " +
      "come out the same.",
    package: {
      format: "compact-v1",
      version: "synthetic",
      country: "jp",
      lines: [
        {
          id: "syn-loop",
          name: "環状線",
          operator: "子鉄道",
          rank: 1,
          color: "#445566",
          isLoop: true,
          stations: [
            ["L1", "環一", 135.5, 34.7, "Kan1", 3],
            ["L2", "環二", 135.51, 34.7, "Kan2", 3],
            ["L3", "環三", 135.51, 34.71, "Kan3", 3],
          ],
          segments: [
            [1.0, 0, [[135.5, 34.7], [135.51, 34.7]]],
            [1.0, 1, [[135.51, 34.71]]],
            [1.4, 1, [[135.5, 34.7]]],
          ],
        },
        syntheticLine("syn-loop-cross", "交差線", "丑鉄道", [
          ["L1", "環一", 135.5, 34.7, "Kan1", 3],
          ["L9", "交端", 135.49, 34.7, "Kotan", 3],
        ]),
      ],
    },
  },
];

// Popup calls that do not correspond to a station in any package.
const POPUP_PROBES = [
  ["", null, "an empty station id: no station, no group, no fallback line"],
  ["nope", null, "an unknown id takes the solo: group key, which holds nothing"],
  [
    "nope",
    "__first_line__",
    "the fallback line is added ONLY when the group produced no rows",
  ],
  ["nope", "also-nope", "a fallback that is not a line either adds nothing"],
  [
    "__first_station__",
    "__first_line__",
    "a real station: the fallback is not consulted, because rows already exist",
  ],
];

// ── the ride label election, driven past what a real store contains ──────
//
// `[role, name, lon, lat, category]`. The style fields markerRecordsToFC
// copies are given fixed values by the builder below rather than drawn from a
// display setting: this block is about the election, and a radius that moved
// with a slider default would make it churn for reasons that have nothing to
// do with which station is named.
const RIDE_PROBES = [
  {
    key: "rank-order",
    why:
      "One place, three roles, in the order that makes rank matter: a " +
      "pass-through arrives first and is named, then an intermediate stop " +
      "takes the name from it, then a terminal takes it again. The winner " +
      "moves twice, and the losers' dots still draw.",
    records: [
      ["pass", "東京", 139.767, 35.681],
      ["stop", "東京", 139.7671, 35.6811],
      ["terminal", "東京", 139.7672, 35.6812],
    ],
  },
  {
    key: "rank-order-reversed",
    why:
      "The same three in the opposite order. The terminal is accepted first " +
      "and neither later record outranks it, so the winner never moves — the " +
      "election is not a last-writer-wins.",
    records: [
      ["terminal", "東京", 139.767, 35.681],
      ["stop", "東京", 139.7671, 35.6811],
      ["pass", "東京", 139.7672, 35.6812],
    ],
  },
  {
    key: "xday-ties-terminal",
    why:
      "A cross-day break station shares rank 0 with a terminal. Equal rank " +
      "does NOT displace the incumbent — `rank < held.rank` is strict — so " +
      "whichever of the two arrives first keeps the name.",
    records: [
      ["xday", "沼津", 138.858, 35.104],
      ["terminal", "沼津", 138.8581, 35.1041],
    ],
  },
  {
    key: "stop-center-never-named",
    why:
      "stop-center is absent from MARKER_LABEL_RANK on purpose: it is the " +
      "black core of a stop whose own record already holds the name. A port " +
      "that gave it a default rank would let the core outrank its own dot.",
    records: [
      ["stop-center", "品川", 139.7387, 35.6284, "stop"],
      ["stop", "品川", 139.7387, 35.6284, "stop"],
    ],
  },
  {
    key: "empty-name",
    why:
      "A record with no name is skipped before the cell scan: it wins " +
      "nothing and blocks nothing.",
    records: [
      ["terminal", "", 139.7, 35.6],
      ["stop", "", 139.7, 35.6],
      ["stop", "有名", 139.7, 35.6],
    ],
  },
  {
    key: "cell-edge",
    why:
      "Two records 0.000002° apart that fall in DIFFERENT cells — the grid " +
      "is 0.0055° and 0.0055 × 25309 = 139.1995 lands between them. The " +
      "eight-neighbour scan is what makes the cell an optimisation rather " +
      "than the rule; a port that looked only in its own cell would name " +
      "this place twice.",
    records: [
      ["terminal", "境界", 139.19949, 35.0],
      ["terminal", "境界", 139.19951, 35.0],
    ],
  },
  {
    key: "square-not-circle",
    why:
      "The ride election's merge test is |Δlon| ≤ 0.0055 AND |Δlat| ≤ 0.0055 " +
      "— a SQUARE in raw degrees, unlike the network election's 600 m circle. " +
      "The diagonal pair below is 0.0054 on each axis (about 780 m on the " +
      "ground at 35°N) and still merges; the axis-aligned pair at 0.0056 " +
      "(about 510 m) does not.",
    records: [
      ["terminal", "角", 139.0, 35.0],
      ["terminal", "角", 139.0054, 35.0054],
      ["terminal", "角", 139.0056, 35.0],
    ],
  },
  {
    key: "held-keeps-its-position",
    why:
      "When a better-ranked record takes the name, the accepted bucket keeps " +
      "the FIRST record's coordinates and only its rank and index change. So " +
      "a third record is measured against where the place was first seen, " +
      "not against the current holder — which is why the third record here " +
      "starts a second place rather than joining the first. Reproduced, not " +
      "repaired.",
    records: [
      ["pass", "移動", 139.0, 35.0],
      ["terminal", "移動", 139.0054, 35.0],
      ["stop", "移動", 139.0107, 35.0],
    ],
  },
  {
    key: "compatibility-ideograph",
    why:
      "The two spellings of 笹塚 at the same point. `other.name !== name` is " +
      "a code-unit test, so JavaScript names the place twice; a port " +
      "comparing Swift Strings names it once.",
    records: [
      ["terminal", SASA_FA10, 139.6, 35.67],
      ["terminal", SASA_585A, 139.6, 35.67],
    ],
  },
  {
    key: "unknown-role",
    why:
      "A role the rank table does not contain is skipped entirely. " +
      "`m.role || m.category` also means an EMPTY role falls back to the " +
      "record's category, which here is a known one — so the second record " +
      "does win.",
    records: [
      ["mystery", "謎", 139.5, 35.5, "mystery"],
      ["", "謎", 139.5, 35.5, "stop"],
    ],
  },
  {
    key: "prototype-role",
    why:
      "MARKER_LABEL_RANK is an object literal, so a role lookup walks " +
      "Object.prototype. `toString` finds a FUNCTION there: not undefined, so " +
      "the record is NOT skipped, and not a number, so every `rank < …` " +
      "against it is false — it claims the name and can then never lose it, " +
      "not even to a terminal. No role the app produces reaches this, and it " +
      "is recorded so that a port choosing either `Int?` or a default rank " +
      "has to choose deliberately.",
    records: [
      ["toString", "原型", 139.4, 35.4],
      ["terminal", "原型", 139.4, 35.4],
      ["constructor", "原型二", 139.3, 35.3],
      ["terminal", "原型二", 139.3, 35.3],
    ],
  },
  {
    key: "non-finite-position",
    why:
      "Coordinates the cell grid cannot hold. `Math.floor(NaN / 0.0055)` is " +
      "NaN and the key is the string `NaN|NaN`, so every NaN shares ONE " +
      "bucket that its own ±1 neighbour scan cannot leave (NaN + 1 is NaN); " +
      "±Infinity behaves the same way; and a finite coordinate large enough " +
      "that x + 1 === x collapses the scan too. All three are unreachable " +
      "from a package or a store and all three are reachable from a caller " +
      "building a record, and in Swift the obvious spelling — Int(x) — TRAPS " +
      "rather than answering.",
    records: [
      ["terminal", "非数", NaN, 35.0],
      ["stop", "非数", NaN, 35.0],
      ["terminal", "無限", Infinity, 35.0],
      ["stop", "無限", Infinity, 35.0],
      ["terminal", "巨大", 1e300, 35.0],
      ["stop", "巨大", 1e300, 35.0],
      ["terminal", "負零", -0, 0],
      ["stop", "負零", 0, 0],
    ],
  },
];

// ── the comparator, measured rather than assumed ─────────────────────────
const COMPARATOR_PROBES = [
  ["あ", "ア", "hiragana あ vs katakana ア: a TERTIARY difference"],
  ["ア", "ｱ", "full-width ア vs half-width ｱ: tertiary again"],
  ["A", "a", "case is tertiary too, and here the two languages agree"],
  ["a", "B", "'a' < 'B' by collation, 'B' < 'a' by code unit"],
  ["", "a", "the empty string sorts first"],
  ["", "", "both empty"],
  [
    `山陽線 (San${RIGHT_QUOTE}yo Main Line)`,
    "山陽線 (Sanyo Line)",
    "THE case: the only ordered pair among 3,511 real ones where collation " +
      "and code-unit order disagree",
  ],
  ["中央線", "中央本線", "CJK, where both orders agree"],
  ["ガ", "ガ", "composed ガ vs decomposed カ+U+3099: collation says equal"],
  [SASA_585A, SASA_FA10, "the compatibility ideograph: collation says equal"],
  ["10", "9", "no numeric collation: '10' sorts before '9'"],
  ["A2", "A10", "the same, embedded"],
  ["é", "é", "composed vs decomposed e-acute"],
  ["台北", "臺北", "the two spellings of Taipei"],
  ["부산", "서울", "Hangul"],
  ["  a", "a", "localeCompare does not trim"],
  ["a-b", "ab", "punctuation is variable-weighted"],
  ["a b", "ab", "so is the space"],
  ["JR", "jr", ""],
  ["ＪＲ", "JR", "full-width ＪＲ vs ASCII JR: tertiary"],
  ["\u{20b9f}鉄道", "鉄道", "a surrogate pair at the front"],
  ["a", "a", "U+0085 NEL is not ECMAScript whitespace"],
  ["﻿a", "a", "U+FEFF ZWNBSP is ignorable to the collator"],
];

// ── helpers ─────────────────────────────────────────────────────────────

const nullable = (value) => (value === undefined ? null : value);

/**
 * The popup ROW fields for one line.
 *
 * Obtained by asking for a station that does not exist and letting
 * `lineIdFallback` supply the line: the row builder is a closure inside
 * buildPopupModel, and this is the only way to reach it without re-typing it.
 */
function lineRow(popup, network, lineId) {
  return popup.buildPopupModel(network, " no-such-station", lineId).lines[0];
}

function popupCase(popup, network, lineIndex, stationId) {
  const model = popup.buildPopupModel(network, stationId, null);
  return {
    stationId,
    name: model.name,
    nameRoma: model.nameRoma,
    rows: model.lines.map((row) => lineIndex.get(row.lineId)),
  };
}

/** Everything about one country's network that the two elections read. */
function countryTables(popup, pkg) {
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const lineIds = [...network.lineById.keys()];
  const lineIndex = new Map(lineIds.map((id, index) => [id, index]));
  const lines = lineIds.map((id) => {
    const line = network.lineById.get(id);
    const row = lineRow(popup, network, id);
    return {
      lineId: id,
      // The two fields CompactPackage's decoder does not carry, so the Swift
      // side can build the same network from the same package file.
      isLoop: Boolean(line.isLoop),
      // buildNetworkFromCompactPackage's own product: the package's `logo`
      // flag turned into a path, with the split-part (-2) and paired-alignment
      // (-p1) suffixes peeled off repeatedly, because the art is named after
      // the RAILWAY and not the stroke.
      packageLogo: line.logo ?? null,
      minZoom: line.minZoom,
      company: row.company,
      label: row.label,
      color: row.color,
      logo: row.logo ?? null,
      logoNeedsDarkMatte: row.logoNeedsDarkMatte,
    };
  });

  const cases = [...network.stationById.values()].map((station) =>
    popupCase(popup, network, lineIndex, station.stationId),
  );

  // The label election's answer: the elected features in the order the second
  // pass accepted them.
  const elected = network.stationLabels.features.map(
    (feature) => feature.properties.stationId,
  );

  // …and which complexes the 600 m merge silenced. Derived from the builder's
  // OWN two collections rather than by re-running the first pass here: the
  // first pass elects exactly one platform per group, so a group with no
  // elected platform is a group whose pick was merged into a neighbour. A
  // second copy of the pick rule in this file would only prove that the copy
  // and the port agree.
  const electedGroups = new Set(
    network.stationLabels.features.map(
      (feature) =>
        feature.properties.stationGroupId ||
        `solo:${feature.properties.stationId}`,
    ),
  );
  const droppedByMerge = [];
  for (const [groupKey, members] of network.groupMembers)
    if (!electedGroups.has(groupKey))
      droppedByMerge.push({
        groupKey,
        // Every spelling the group's platforms use. Usually one; a complex
        // whose operators disagree (台北 / 台北車站 / 臺北) has several, and
        // which one was elected is what the merge then compared.
        names: [...new Set(members.map((member) => member.name))],
        stationIds: members.map((member) => member.stationId),
      });

  return {
    network,
    lineIndex,
    cases,
    table: {
      lines,
      elected,
      droppedByMerge,
      stationCount: network.stations.features.length,
      // Every group elects exactly one platform, so this is also the number
      // of candidates the 600 m pass was handed.
      groupCount: network.groupMembers.size,
    },
  };
}

// ── the ride records ────────────────────────────────────────────────────

const STORE_SUFFIX = { jp: "", tw: "-tw", hk: "-hk", kr: "-kr", mo: "-mo" };

// A record and a feature are each one tab-joined row rather than an object,
// for size: 4,085 records and their 4,085 features as pretty-printed objects
// are 3.8 MB of this file and say nothing the column lists below do not. The
// same trade route-feature.json makes for geometry.
//
// It is exact in both directions. JavaScript prints the shortest decimal that
// reads back as the same double and Swift's Double(String) is correctly
// rounded, so every number round-trips bit for bit — asserted below on every
// value written.
const RECORD_COLUMNS =
  "lon\tlat\tname\tcategory\trole\tradius\tlineWidth\tfill\tstroke\talpha\tfocusScale\ttrainId\ttdate\tdspan";
const FEATURE_COLUMNS =
  "idx\ttid\ttdate\tdspan\tcategory\trole\tfocusScale\tradius\tlineWidth\tfill\tstroke\talpha\tname";

/** `String(value)`, with `null` and `undefined` both written as the empty cell. */
function cell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    const text = String(value);
    // `NaN`, `Infinity` and `-Infinity` are what JavaScript prints and what
    // Swift's Double(String) reads back; they are exempted from the identity
    // check below only because NaN !== NaN, not because they are approximate.
    if (!Number.isFinite(value)) return text;
    if (Number(text) !== value)
      throw new Error(`${value} does not round-trip through its own printing`);
    return text;
  }
  const text = String(value);
  if (text.includes("\t"))
    throw new Error(`a tab in ${JSON.stringify(text)} would forge a column`);
  return text;
}

const rgb = (array) => (Array.isArray(array) ? array.map(cell).join(",") : "");

function markerRecordRow(record) {
  return [
    cell(record.position[0]),
    cell(record.position[1]),
    cell(record.name),
    cell(record.category),
    cell(record.role),
    cell(record.radius),
    cell(record.lineWidth),
    rgb(record.fillColor),
    rgb(record.lineColor),
    cell(record.alpha),
    cell(record.focusScale),
    cell(record.train && record.train.id),
    cell(record.tdate),
    cell(record.dspan),
  ].join("\t");
}

function featureRow(feature) {
  const p = feature.properties;
  return [
    cell(p.idx),
    cell(p.tid),
    cell(p.tdate),
    cell(p.dspan),
    cell(p.category),
    cell(p.role),
    cell(p.focusScale),
    cell(p.radius),
    cell(p.lineWidth),
    cell(p.fill),
    cell(p.stroke),
    cell(p.alpha),
    cell(p.name),
  ].join("\t");
}

function probeRecords(rows) {
  return rows.map(([role, name, lon, lat, category], index) => ({
    position: [lon, lat],
    name,
    category: category === undefined ? role : category,
    role,
    radius: 6 + index,
    lineWidth: 0.75,
    fillColor: [26, 26, 26],
    lineColor: [255, 255, 255],
    alpha: 1,
    focusScale: 0.5,
    train: { id: `probe-${index}` },
    tdate: "2026-08-21",
    dspan: "|2026-08-21|",
  }));
}

// ── build ───────────────────────────────────────────────────────────────
//
// The whole fixture is computed here, at module load under a top-level await,
// and `build()` hands back the memoised result. buildStationIndexesSliced is
// async — it parks on a 12 ms budget so a boot in a hidden tab is not
// stretched by the background-timer clamp — and the generator calls `build()`
// synchronously, so there is no await available at that point. The generator
// already awaits the dynamic import() that loads this file, so the work
// happens before `build()` is ever reached. Re-implementing the index build
// synchronously to dodge the await is exactly the copy this exercise exists
// to avoid.

const { popup, scope } = loadPopupScope();

const packages = [];
const cases = [];
const networks = new Map();
for (const country of COUNTRIES) {
  const built = countryTables(popup, JSON.parse(
    fs.readFileSync(path.join(APP_DIR, "public", "rail", `${country}-2025.json`), "utf8"),
  ));
  networks.set(country, built);
  packages.push({ country, ...built.table });
  for (const entry of built.cases) cases.push({ country, ...entry });
}

// ── the header, with and without an app i18n layer ───────────────────────
//
// buildPopupModel tests `typeof I18N.stationName === "function"` and
// `typeof I18N.nameReadingsList === "function"` SEPARATELY, so an object
// carrying one and not the other is a real branch. The stubs record their
// arguments rather than resolving them: WHICH name is localised and WHICH
// readings are shown is i18n.js's business and is already its own port
// (port-fixtures/i18n.json). What belongs here is which two arguments the
// popup hands over — the raw name and the STATION ID, which is `lineId:group`
// and not an N02 code — and the difference between "no app i18n" (readings
// null, keep nameRoma) and "every reading toggle off" (readings [], no
// subline at all).
// Keyed, not merely shaped: two of these five carry the same pair of function
// names and differ only in what the second one returns, so the port has to be
// told which stub it is reproducing.
const NAMING_STUBS = [
  ["none", null, "no app i18n at all: the standalone railmap keeps nameRoma"],
  [
    "name-only",
    { stationName: (n, c) => `NAME<${n}|${c}>` },
    "stationName only: the name is localised and readings stay null",
  ],
  [
    "readings-only",
    { nameReadingsList: (n, c) => [`R<${n}|${c}>`] },
    "nameReadingsList only: readings appear under the ORIGINAL name",
  ],
  [
    "both-empty",
    { stationName: (n, c) => `NAME<${n}|${c}>`, nameReadingsList: () => [] },
    "both, with every reading toggle off: readings [] is not readings null",
  ],
  [
    "both",
    {
      stationName: (n, c) => `NAME<${n}|${c}>`,
      nameReadingsList: (n, c) => [`KANA<${n}>`, `ROMA<${c}>`],
    },
    "both: one subline per enabled reading",
  ],
];

const header = [];
{
  const jp = networks.get("jp");
  const sample = [
    "jp-東日本旅客鉄道-東北新幹線:003766", // 東京
    "jp-京王電鉄-京王新線:003806", // 笹塚, the U+FA10 spelling
    "no-such-station",
  ];
  for (const [key, stub, why] of NAMING_STUBS)
    for (const stationId of sample) {
      if (stub) scope.I18N = stub;
      else delete scope.I18N;
      const model = popup.buildPopupModel(jp.network, stationId, null);
      header.push({
        stationId,
        naming: key,
        carries: stub ? Object.keys(stub).sort() : [],
        name: model.name,
        nameRoma: model.nameRoma,
        readings: model.readings,
        why,
      });
    }
  delete scope.I18N;
}

// ── the synthetic packages ───────────────────────────────────────────────
const synthetic = SYNTHETIC_PACKAGES.map((entry) => {
  const network = RailNetwork.buildNetworkFromCompactPackage(entry.package);
  const lineIds = [...network.lineById.keys()];
  const lineIndex = new Map(lineIds.map((id, index) => [id, index]));
  return {
    key: entry.key,
    why: entry.why,
    package: entry.package,
    lines: lineIds.map((id) => {
      const line = network.lineById.get(id);
      const row = lineRow(popup, network, id);
      return {
        lineId: id,
        isLoop: Boolean(line.isLoop),
        packageLogo: line.logo ?? null,
        minZoom: line.minZoom,
        company: row.company,
        label: row.label,
        color: row.color,
        logo: row.logo ?? null,
        logoNeedsDarkMatte: row.logoNeedsDarkMatte,
      };
    }),
    cases: [...network.stationById.values()].map((station) => ({
      ...popupCase(popup, network, lineIndex, station.stationId),
      // Spelled out as well as indexed, because in these cases the ORDER is
      // the answer and an index list is unreadable in a diff.
      rowLabels: popup
        .buildPopupModel(network, station.stationId, null)
        .lines.map((row) => row.label),
    })),
    stationMinZoom: network.stations.features.map((feature) => [
      feature.properties.stationId,
      feature.properties.minz,
    ]),
    elected: network.stationLabels.features.map(
      (feature) => feature.properties.stationId,
    ),
  };
});

// ── popup calls with no station behind them ──────────────────────────────
const probes = [];
{
  const jp = networks.get("jp");
  const firstLine = [...jp.network.lineById.keys()][0];
  const firstStation = [...jp.network.stationById.keys()][0];
  for (const [stationId, fallback, why] of POPUP_PROBES) {
    const id = stationId === "__first_station__" ? firstStation : stationId;
    const line = fallback === "__first_line__" ? firstLine : fallback;
    const model = popup.buildPopupModel(jp.network, id, line);
    probes.push({
      stationId: id,
      lineIdFallback: nullable(line),
      name: model.name,
      nameRoma: model.nameRoma,
      rows: model.lines.map((row) => row.lineId),
      why,
    });
  }
}

// ── the rides ────────────────────────────────────────────────────────────
const deck = loadDeckScope();
// Installed ONCE, as boot does, and outside the loop because there is nothing
// per-country to install: matched-stops.json is a single committed file, not
// one set per country, so re-installing it each pass would only hand
// getStopFeature the same features again. (It would be answered correctly
// either way — the train-id index inside getStopFeature is keyed by the
// features array it was built from and rebuilds when that array is swapped.)
// The committed set names two trains, both Taiwanese; every other train in the
// five stores takes getStopFeature's resolver path, which is also what the
// four countries without a precomputed set do in the app.
const rides = [];
deck.AppDatasets.installMatchedData({
  matchedRoutes: readData("matched-routes.json"),
  matchedStops: readData("matched-stops.json"),
});
for (const country of COUNTRIES) {
  const suffix = STORE_SUFFIX[country];
  const stations = readData(`stations${suffix}.json`);
  deck.AppDatasets.installStations(stations);
  await deck.buildStationIndexesSliced(stations);
  const store = readData(`train-store${suffix}.json`);
  deck.setStore(store);
  const records = deck.buildDeckMarkerRecords(store.trains);
  rides.push({
    country,
    trainCount: store.trains.length,
    records: records.map(markerRecordRow),
    features: deck.markerRecordsToFC(records).features.map(featureRow),
  });
}

const rideProbes = RIDE_PROBES.map((entry) => {
  const records = probeRecords(entry.records);
  return {
    key: entry.key,
    why: entry.why,
    records: records.map(markerRecordRow),
    features: deck.markerRecordsToFC(records).features.map(featureRow),
  };
});

// markerRecordsToFC's own defaults, which no record a real ride produces ever
// reaches: every field the app fills in is left out here instead. `dspan` is
// built from `tdate`, `focusScale` falls back to 0.5 and `alpha` to 1 — both
// through `== null`, so a real 0 survives — and rgbCss answers black for a
// missing colour while a SHORT colour array prints the literal `undefined` in
// the channel it could not find.
const rideDefaults = (() => {
  const records = [
    {
      position: [139.7, 35.6],
      name: "既定",
      category: "stop",
      role: "terminal",
      radius: 5,
      lineWidth: 1,
    },
    {
      position: [139.8, 35.6],
      name: "既定二",
      category: "pass",
      role: "pass",
      radius: 3,
      lineWidth: 0.5,
      tdate: "2026-08-21",
      focusScale: 0,
      alpha: 0,
      fillColor: [1, 2],
      lineColor: "not an array",
      train: {},
    },
  ];
  return {
    why:
      "Every default markerRecordsToFC carries, none of which a real ride " +
      "reaches: the absent fields on the first record, and on the second a " +
      "focusScale and an alpha of ZERO (which `== null` keeps, where a " +
      "falsy test would replace them), a two-element colour and a colour " +
      "that is not an array at all.",
    records: records.map(markerRecordRow),
    features: deck.markerRecordsToFC(records).features.map(featureRow),
  };
})();

// ── the comparator ───────────────────────────────────────────────────────
const comparator = [];
{
  const seen = new Set();
  const add = (a, b, why) => {
    const key = `${a} ${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    comparator.push({
      a,
      b,
      sign: Math.sign(a.localeCompare(b)),
      ...(why ? { why } : {}),
    });
  };
  // Every ORDERED pair the five packages actually compare while sorting a
  // popup's rows. Not a sample: the sort's answer depends on the comparator's
  // answer for exactly these, and the one disagreement is one pair in 3,511.
  for (const entry of packages) {
    const labels = entry.lines.map((line) => line.label);
    for (const row of cases) {
      if (row.country !== entry.country || row.rows.length < 2) continue;
      for (let i = 0; i < row.rows.length; i += 1)
        for (let j = 0; j < row.rows.length; j += 1)
          if (i !== j) add(labels[row.rows[i]], labels[row.rows[j]]);
    }
  }
  for (const [a, b, why] of COMPARATOR_PROBES) add(a, b, why);
}

const FIXTURE = {
  describes:
    "railmap-popup.js buildPopupModel; rail-network.js's station-label " +
    "election (network.stationLabels); railmap-geometry.js markerLabelWinners " +
    "+ markerRecordsToFC and the three role tiers behind them",
  contract:
    "A station is named ONCE. 東京 is nine platforms of five railways and one " +
    "name, and the source data hands it over as TWO station groups four " +
    "hundred metres apart — so neither the group key nor a renderer-side " +
    "collision pass can produce that on its own, because every platform finds " +
    "room for its own copy. Both elections exist for that and for nothing " +
    "else: they grant a LABEL right and change nothing, so every platform " +
    "keeps its own dot and its own line identity.\n\n" +
    "What a port gets wrong here is never arithmetic:\n" +
    "  1. JavaScript compares strings by UTF-16 code unit; Swift's String " +
    "compares by canonical equivalence. The jp package spells 笹塚 with " +
    "U+FA10 — the only non-NFC name among 10,361 — so the hazard is real and " +
    "invisible at volume. Every name test here is a code-unit test: the " +
    "popup's operator+name dedupe key, the label election's " +
    "`other.name !== name`, and the group / line / station maps.\n" +
    "  2. Array.prototype.sort is stable and Swift's is not. Twelve real " +
    "popups list two rows with the SAME label, and the group's member order " +
    "is what decides which of them is drawn first.\n" +
    "  3. The row order comes from localeCompare, whose collation is the " +
    "HOST's. Of the 3,511 ordered label pairs the five packages compare, " +
    "exactly one disagrees with code-unit order — 下関's " +
    "山陽線 (San’yo Main Line) against 山陽線 (Sanyo Line), where U+2019 " +
    "sorts before a letter under ICU and after it by code unit.\n" +
    "  4. The two elections do NOT share a distance. The network's is 600 m " +
    "under rail-network.js's equirectangular metric; the ride's is a 0.0055° " +
    "SQUARE in raw degrees — about 500 m across in longitude at 35°N and " +
    "610 m in latitude everywhere. Unifying them changes which stations are " +
    "named.\n" +
    "  5. The role tiers are three because the roles are three densities. A " +
    "ride has exactly two ends, so naming them costs nothing and they appear " +
    "at z8; its intermediate stops are a handful per train (z10); the " +
    "stations it merely rolled through are every station on the line and are " +
    "worth naming only once the view is one district (z13). stop-center is " +
    "absent from the rank table on purpose — it is the black core of a stop " +
    "whose own record already holds the name.",
  cases,
  packages,
  header,
  synthetic,
  probes,
  recordColumns: RECORD_COLUMNS,
  featureColumns: FEATURE_COLUMNS,
  rides,
  rideProbes,
  rideDefaults,
  comparator,
};

export function build() {
  return FIXTURE;
}
