// =========================================================================
//  port-fixtures/validation.mjs — freeze what the itinerary schema accepts
//
//  app-validation.js §33 is the app's front door. Everything that ever
//  reaches the map — the committed stores, a pasted export, an agent import —
//  passes validateTrain first, so this file is not "some checks": it is the
//  definition of what an itinerary IS. A port that is stricter rejects data
//  the archive already contains; a port that is looser lets a train onto the
//  map that the web app would have refused, and the two forks stop being able
//  to exchange files.
//
//  So every expected value below is READ OUT OF THE RUNNING JAVASCRIPT,
//  including the verdicts that are arguably wrong. There are a lot of those,
//  and they are the point of the exercise rather than an embarrassment:
//  validateTrain never looks at a time's FORMAT, never compares one stop's
//  time to the next, and skips route_sections and route_policy entirely when
//  they are falsy-but-present. Each such case carries a `note` saying what
//  slipped through. Reproduce them; do not fix them here.
//
//  ── inputs ─────────────────────────────────────────────────────────────
//  The two committed itinerary stores (229 trains) drive the bulk of it, and
//  the adversarial cases are PROJECTIONS of a real train — one field replaced
//  on a real itinerary — rather than invented ones, so a rejection is always
//  attributable to the one thing that changed. The train they project from is
//  chosen by rule (fewest stops, ties by id) rather than by index: it keeps
//  every case small, and an edit to the store cannot silently swap it for
//  something with a different shape without the fixture diff showing it.
//
//  ── the station table is deliberately empty ────────────────────────────
//  Three of the functions here reach for the station index through bare
//  globals: normalizeImportedRouteSection resolves a missing section name
//  from its code, leanExportSection drops a name the code can reconstruct,
//  and normalizeExportTrain resolves each stop to a station feature. With no
//  index installed those answer "", keep every name, and fall back to the
//  stop's own code respectively — which is not a stub, it is the real state
//  the app boots in and imports in before app-datasets.js has fetched
//  anything. Pinning that state is what makes the export path a pure function
//  of the store, and it is why the port takes the station lookups as injected
//  closures defaulting to "no table" instead of pretending they do not exist.
// =========================================================================

import fs from "node:fs";
import path from "node:path";

export const name = "validation.json";

// ── loading the validator ───────────────────────────────────────────────
// app-validation.js is a classic script sharing one global lexical scope with
// its siblings (contract 1). It has no exports and it reads bare globals its
// siblings declare, so it cannot be `import`ed — the only faithful way to run
// it is to reproduce that scope, which is what the main generator's
// loadFrontendScope does and what the precompute VM does. Concatenating the
// files and evaluating them through one `new Function` IS that scope.
//
// The chain is dictated by index.html, not chosen. Each file is here because
// something below it reads a name only that file declares.
const SCOPE_FILES = [
  "app-operator-branding.js", // window.RailOperatorBranding — the TW company rule
  "railmap-basemap.js", // window.RailMapBasemap
  "railmap-style.js", // window.RailMapStyle — read at app-config.js's top level
  "app-config.js", // SCHEMA_VERSION, STOP_TYPES, TRAIN_ID_PATTERN, activeCountry …
  "app-datasets.js", // stationNameForCode and the map behind it
  "app-stations.js", // stopName, isValidSourceStationCode, resolveStationForTrain
  "app-store-ops.js", // §18/§19 — the canonical shapes and the import normalisers
  "app-validation.js", // §33 — the module under test
  "app-ui-utils.js", // isValidTrainColor
  "app-state.js", // trainStore / selectedDate, in index.html order
];

function loadValidationScope(APP_DIR, AppCore, RailNetwork) {
  const source = SCOPE_FILES.map((file) =>
    fs.readFileSync(path.join(APP_DIR, "public", file), "utf8"),
  ).join("\n");
  const factory = new Function(
    "window",
    `${source}
     return {
       // §33 — the module under test
       validateTrain, validateTrainStore,
       // §18 — the canonical export shapes
       buildCanonicalTrainStore, normalizeExportTrain,
       // §19 — lenient inbound
       parseImportedCanonicalStore, normalizeImportedTrain, assertOnlyKeys,
       // the predicates the rules are built on, pinned directly so that a
       // disagreement names the predicate rather than the rule
       isValidSourceStationCode, stationCodeSystem, isValidTrainColor,
       makeUniqueTrainId,
       // the constants the error messages are spelled from
       constants: {
         SCHEMA_VERSION,
         ACCEPTED_SCHEMA_VERSIONS: [...ACCEPTED_SCHEMA_VERSIONS],
         TRAIN_ID_PATTERN: TRAIN_ID_PATTERN.source,
         STOP_TYPES: [...STOP_TYPES],
         UNDATED,
         ALL_DATES,
         DEFAULT_TRAIN_COLOR,
         DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES: [...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES],
         N02_INSTITUTION_TYPE_CODES: [...N02_INSTITUTION_TYPE_CODES],
       },
       // the mutable globals these rules read: they take no parameters for
       // them, so driving them means writing them
       setTrainStore: (value) => { trainStore = value; },
       setActiveCountry: (value) => { activeCountry = value; },
       setSelectedDate: (value) => { selectedDate = value; },
       // An EMPTY station index, not a missing one. resolveStationCandidates
       // does stationCandidatesIndex.get(...) unguarded, so leaving it
       // undefined throws a TypeError out of the export path instead of
       // exercising it. See the header.
       installEmptyStationIndex: () => { stationCandidatesIndex = new Map(); },
     };`,
  );
  return factory({ AppCore, RailNetwork });
}

// ── serialisation: inputs keep their order, outputs are canonicalised ────
//
// INPUTS are written with plain JSON.stringify, which preserves the object's
// own key order — and key order is load-bearing here, because assertOnlyKeys
// throws on the FIRST offending key, so the order decides which key the
// error message names. A port therefore has to parse these inputs
// order-preservingly rather than into a dictionary.
//
// OUTPUTS are written with the stable stringifier below: keys sorted, every
// other byte exactly what JSON.stringify writes. Round-trip equality has to
// be checked on bytes, and Swift's Codable emits no defined key order, so a
// canonical ordering is the only comparison that means anything.
// `Array.prototype.sort` with no comparator sorts by UTF-16 code unit, which
// is what the Swift side has to reproduce (JSNumber.stringLessOrEqual) rather
// than inherit from whatever `String: Comparable` happens to do.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

// What a JS throw looks like as fixture data. `errorName` separates a
// deliberate rejection (Error) from a crash the validator did not intend
// (TypeError) — there is one of the latter, and folding it into "it threw"
// would let a port that throws for the RIGHT reason look identical to the app.
function attempt(run) {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, errorName: error.name, error: error.message };
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/** A real train with one thing changed. `mutate` receives a deep copy. */
function project(train, mutate) {
  const copy = clone(train);
  mutate(copy);
  return copy;
}

function readStore(APP_DIR, file) {
  return JSON.parse(fs.readFileSync(path.join(APP_DIR, "data", file), "utf8"));
}

export function build({ AppCore, RailNetwork, APP_DIR }) {
  const js = loadValidationScope(APP_DIR, AppCore, RailNetwork);
  js.installEmptyStationIndex();
  js.setSelectedDate(js.constants.ALL_DATES);

  const stores = [
    { country: "jp", file: "train-store.json" },
    { country: "tw", file: "train-store-tw.json" },
  ].map((entry) => ({ ...entry, store: readStore(APP_DIR, entry.file) }));

  // ---- every committed train, exported and validated -------------------
  // Not a sample. The canonical export is where the model, the six-field stop
  // shape, the section recomputation and the per-country company rule all
  // meet, and an off-by-one in any of them is invisible in a sample. The
  // source train is not repeated here: the port reads the same store file.
  const exportCases = [];
  const validateCases = [];
  for (const { country, store } of stores) {
    js.setActiveCountry(country);
    js.setTrainStore(store);
    const canonical = js.buildCanonicalTrainStore();
    canonical.trains.forEach((train, index) => {
      exportCases.push({
        country,
        index,
        id: store.trains[index].id,
        canonical: stableStringify(train),
      });
      validateCases.push({
        country,
        index,
        id: train.id,
        ...attempt(() => js.validateTrain(train, index, new Set())),
      });
    });
    // The whole store, so id uniqueness is checked across all of it.
    validateCases.push({
      country,
      index: -1,
      id: `__store__:${country}`,
      ...attempt(() => js.validateTrainStore(canonical)),
    });
  }

  // The train every adversarial case below is projected from: a real, short,
  // ordinary itinerary taken through the export path first, so it starts in
  // canonical shape and every rejection is attributable to the one field that
  // moved. Chosen by rule rather than by index — see the header.
  //
  // The four-stop floor is what makes `stops[1]` a genuine MIDDLE stop. The
  // absolute shortest itineraries in both stores have exactly two, and on
  // those the first-stop and last-stop time rules are the same row, so a case
  // meant to probe one of them silently probes the other instead.
  const shortest = (trains, minimumStops) =>
    [...trains]
      .filter((train) => train.stops.length >= minimumStops)
      .sort(
        (a, b) => a.stops.length - b.stops.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )[0];

  js.setActiveCountry("tw");
  js.setTrainStore(stores[1].store);
  const baseTw = js.normalizeExportTrain(shortest(stores[1].store.trains, 4));
  js.setActiveCountry("jp");
  js.setTrainStore(stores[0].store);
  const base = js.normalizeExportTrain(shortest(stores[0].store.trains, 4));
  // The two-stop itinerary, kept as its own baseline: it is the shape where
  // the first-stop and last-stop rules collide on one row.
  const baseTwoStop = js.normalizeExportTrain(shortest(stores[0].store.trains, 2));

  // ---- validateTrain, adversarially ------------------------------------
  // `note` appears only where the JavaScript's answer is arguably the wrong
  // one, or where a naive Swift translation would answer differently. It is
  // documentation, never an input.
  const cases = [];
  const addTrain = (label, train, note) =>
    cases.push({
      label,
      ...(note ? { note } : {}),
      train: JSON.stringify(train),
      ...attempt(() => js.validateTrain(train, 0, new Set())),
    });

  addTrain("baseline — a real train, unchanged", base);
  addTrain("baseline — a real Taiwanese train (TDX station codes)", baseTw);
  addTrain("baseline — a real two-stop itinerary", baseTwoStop);
  addTrain(
    "a two-stop itinerary whose only middle-stop row is both ends",
    project(baseTwoStop, (t) => {
      t.stops[0].arrival = "08:00";
      t.stops[0].departure = "08:01";
    }),
    "on a two-stop train stops[0] is also stops[length-1], so the first-stop " +
      "rule fires before the last-stop rule ever gets a chance.",
  );

  // -- the four required strings (§15.2)
  for (const key of ["id", "number", "origin", "destination"]) {
    addTrain(`${key} missing`, project(base, (t) => delete t[key]));
    addTrain(`${key} empty string`, project(base, (t) => (t[key] = "")));
    addTrain(`${key} is a number`, project(base, (t) => (t[key] = 12345)));
    addTrain(`${key} is null`, project(base, (t) => (t[key] = null)));
  }

  // -- optional metadata (§3.4)
  addTrain("train_type absent", project(base, (t) => delete t.train_type));
  addTrain("train_type empty", project(base, (t) => (t.train_type = "")));
  addTrain(
    "train_type is a number",
    project(base, (t) => (t.train_type = 7)),
    "validateTrain rejects it, but normalizeImportedTrain would already have " +
      'coerced the same value to "" — the two front doors disagree.',
  );
  addTrain("company is an array", project(base, (t) => (t.company = ["JR"])));
  addTrain(
    "direction is a number",
    project(base, (t) => (t.direction = 42)),
    "accepted: direction is never validated at all. jsonspec §3.1 only " +
      "recommends up/down/unknown, and the committed jp store puts station " +
      "names there, so there is no enum to enforce.",
  );
  addTrain(
    "visible is a string",
    project(base, (t) => (t.visible = "yes")),
    "accepted — jsonspec §15.2 says so explicitly: visible is normalised to a " +
      "boolean on import but validateTrain never type-checks it.",
  );
  addTrain(
    "visible is 0",
    project(base, (t) => (t.visible = 0)),
    "accepted here, and normalizeImportedTrain turns it into visible:true — " +
      "the test is `!== false`, so every falsy value except false means visible.",
  );

  // -- the id charset (§3.2)
  addTrain("id with a dot", project(base, (t) => (t.id = "odr.001")));
  addTrain("id with a space", project(base, (t) => (t.id = "odr 001")));
  addTrain("id in kana", project(base, (t) => (t.id = "はやぶさ")));
  addTrain("id is only underscores and dashes", project(base, (t) => (t.id = "_-_")));
  addTrain(
    "id with a trailing newline",
    project(base, (t) => (t.id = "odr_001\n")),
    "rejected: JavaScript's `$` matches only at the very end of the input. " +
      "ICU's `$` matches before a final line terminator too, so an " +
      "NSRegularExpression translation of the same pattern ACCEPTS this.",
  );
  addTrain(
    "id in fullwidth digits",
    project(base, (t) => (t.id = "００１")),
    "rejected because JavaScript's \\d without /u is ASCII 0-9 — and the " +
      "charset here is a literal [a-zA-Z0-9]. ICU's \\d is \\p{Nd}.",
  );

  // -- date (§3.3)
  addTrain("date absent", project(base, (t) => delete t.date));
  addTrain("date is the undated sentinel", project(base, (t) => (t.date = js.constants.UNDATED)));
  addTrain(
    "date is null",
    project(base, (t) => (t.date = null)),
    "absent is accepted and null is not: the guard is `!== undefined`, so the " +
      'one shape JSON can spell for "no date" is the one that fails.',
  );
  addTrain("date is slash-written", project(base, (t) => (t.date = "2026/07/03")));
  addTrain("date month 13", project(base, (t) => (t.date = "2026-13-01")));
  addTrain(
    "date 2026-06-31",
    project(base, (t) => (t.date = "2026-06-31")),
    "accepted: isValidDateString checks the day against 31 and never against " +
      "the month, so a date that does not exist passes.",
  );
  addTrain("date 2026-02-30", project(base, (t) => (t.date = "2026-02-30")), "accepted, same rule.");
  addTrain("date unpadded", project(base, (t) => (t.date = "2026-7-3")));
  addTrain("date in fullwidth digits", project(base, (t) => (t.date = "２０２６-07-03")));

  // -- stops (§7, §15.2)
  addTrain("stops absent", project(base, (t) => delete t.stops));
  addTrain("stops empty", project(base, (t) => (t.stops = [])));
  addTrain("stops has one row", project(base, (t) => (t.stops = [t.stops[0]])));
  addTrain("stops is an object", project(base, (t) => (t.stops = { 0: t.stops[0] })));
  addTrain(
    "stops has exactly two rows",
    project(base, (t) => (t.stops = [t.stops[0], t.stops[t.stops.length - 1]])),
  );
  addTrain(
    "stops[0] is null",
    project(base, (t) => (t.stops[0] = null)),
    "CRASH, not a rejection: the arrival/departure guard reads " +
      "train.stops[0].departure before anything has checked that the row is " +
      "an object, so this leaves validateTrain as a TypeError rather than as " +
      "the schema error the caller catches and shows to the reader.",
  );
  addTrain(
    "stops[1] is null",
    project(base, (t) => (t.stops[1] = null)),
    "CRASH, by the same route one line further down — stopName(null).",
  );
  addTrain("stops[0] is a string", project(base, (t) => (t.stops[0] = "関西空港")));

  addTrain("first stop has both arrival and departure", project(base, (t) => (t.stops[0].arrival = "08:00")));
  addTrain(
    "last stop has both arrival and departure",
    project(base, (t) => (t.stops[t.stops.length - 1].departure = "23:00")),
  );
  addTrain(
    "a middle stop has both",
    project(base, (t) => {
      t.stops[1].arrival = "08:10";
      t.stops[1].departure = "08:11";
    }),
  );

  addTrain("stop name empty", project(base, (t) => (t.stops[1].name = "")));
  addTrain("stop name null", project(base, (t) => (t.stops[1].name = null)));
  addTrain(
    "stop name is a number",
    project(base, (t) => (t.stops[1].name = 12)),
    'accepted: stopName returns `stop.name || ""`, so any truthy non-string ' +
      "name passes the emptiness test.",
  );
  addTrain("stop name is 0", project(base, (t) => (t.stops[1].name = 0)));
  addTrain("stop_type absent", project(base, (t) => delete t.stops[1].stop_type));
  addTrain("stop_type unknown", project(base, (t) => (t.stops[1].stop_type = "skipped")));
  addTrain("stop_type wrong case", project(base, (t) => (t.stops[1].stop_type = "Pass_Through")));
  for (const type of js.constants.STOP_TYPES)
    addTrain(`stop_type ${type}`, project(base, (t) => (t.stops[1].stop_type = type)));

  addTrain("ride_segment absent", project(base, (t) => delete t.stops[1].ride_segment));
  addTrain("ride_segment is a string", project(base, (t) => (t.stops[1].ride_segment = "true")));
  addTrain("ride_segment is 1", project(base, (t) => (t.stops[1].ride_segment = 1)));
  addTrain(
    "every ride_segment false",
    project(base, (t) => t.stops.forEach((stop) => (stop.ride_segment = false))),
    "accepted — jsonspec §8.6.4 calls this out: nothing checks that at least " +
      "one stop is ridden, so the train validates, exports, and draws nothing.",
  );

  // -- station codes (§2.3)
  addTrain("station code null", project(base, (t) => (t.stops[1].n02_station_code = null)));
  addTrain("station code absent", project(base, (t) => delete t.stops[1].n02_station_code));
  addTrain("station code empty string", project(base, (t) => (t.stops[1].n02_station_code = "")));
  addTrain("station code five digits", project(base, (t) => (t.stops[1].n02_station_code = "00377")));
  addTrain("station code seven digits", project(base, (t) => (t.stops[1].n02_station_code = "0037701")));
  addTrain("station code is the number 3770", project(base, (t) => (t.stops[1].n02_station_code = 3770)));
  addTrain(
    "station code is the number 123456",
    project(base, (t) => (t.stops[1].n02_station_code = 123456)),
    "accepted: stationCodeSystem does String(code) first, so a JSON number is " +
      "a valid station code as long as it spells six digits.",
  );
  addTrain("station code TDX", project(base, (t) => (t.stops[1].n02_station_code = "TRA-1000")));
  addTrain("station code TDX, three segments", project(base, (t) => (t.stops[1].n02_station_code = "KR-SEOUL-2H")));
  addTrain("station code lowercase first letter", project(base, (t) => (t.stops[1].n02_station_code = "tra-1000")));
  addTrain(
    "station code with a leading BOM",
    project(base, (t) => (t.stops[1].n02_station_code = "\uFEFF003770")),
    "accepted: stationCodeSystem trims first, and ECMAScript's trim removes " +
      "U+FEFF. Swift's .whitespacesAndNewlines does NOT, so a naive port rejects it.",
  );
  addTrain(
    "station code with a leading NEL (U+0085)",
    project(base, (t) => (t.stops[1].n02_station_code = "\u0085003770")),
    "rejected: U+0085 is neither WhiteSpace nor a LineTerminator in " +
      "ECMAScript, so trim leaves it in place. Swift's .whitespacesAndNewlines " +
      "DOES remove it, so a naive port accepts it — the mirror image of the BOM case.",
  );
  addTrain(
    "station code in fullwidth digits",
    project(base, (t) => (t.stops[1].n02_station_code = "００３７７０")),
    "rejected: JavaScript's \\d is ASCII-only. ICU's is not.",
  );
  addTrain("station code with surrounding spaces", project(base, (t) => (t.stops[1].n02_station_code = "  003770  ")));
  addTrain("station code with an inner space", project(base, (t) => (t.stops[1].n02_station_code = "003 770")));

  // -- times (§10). None of these is a format check, because there is none.
  addTrain(
    "arrival is not a time",
    project(base, (t) => (t.stops[1].arrival = "banana")),
    "accepted: validateTrain checks only that a time is a string or null. " +
      "jsonspec §10 states a format; nothing enforces it.",
  );
  addTrain("arrival is 25:99", project(base, (t) => (t.stops[1].arrival = "25:99")), "accepted — no format check.");
  addTrain(
    "arrival is the legacy +1 form",
    project(base, (t) => (t.stops[1].arrival = "10:00+1")),
    "accepted, and still parsed by parseTimeToMinutes (§10.1).",
  );
  addTrain(
    "cross-day times, 34:00",
    project(base, (t) => {
      t.stops[1].arrival = "33:59";
      t.stops[1].departure = "34:00";
    }),
    "accepted, and correct: §10.5 spells the next day by counting hours past 24.",
  );
  addTrain(
    "the timetable runs backwards",
    project(base, (t) => {
      const hour = (index) => String(23 - (index % 24)).padStart(2, "0");
      t.stops.forEach((stop, index) => {
        stop.arrival = index === 0 ? null : `${hour(index)}:00`;
        stop.departure = index === t.stops.length - 1 ? null : `${hour(index)}:05`;
      });
    }),
    "accepted: no rule compares one stop's time to the next, so a stop order " +
      "that contradicts the timetable is a valid itinerary.",
  );
  addTrain("arrival is a number", project(base, (t) => (t.stops[1].arrival = 830)));
  addTrain("departure is false", project(base, (t) => (t.stops[1].departure = false)));
  addTrain("arrival is absent", project(base, (t) => delete t.stops[1].arrival));

  // -- unknown keys are NOT validateTrain's business
  addTrain(
    "an unknown train key",
    project(base, (t) => (t.nickname = "スーパーはくと")),
    "accepted: assertOnlyKeys runs in the IMPORT path " +
      "(normalizeImportedTrain / parseImportedCanonicalStore), never inside " +
      "validateTrain, so a store loaded any other way keeps its extra keys.",
  );
  addTrain("an unknown stop key", project(base, (t) => (t.stops[1].platform = "3")), "accepted, same reason.");

  // -- route_sections (§6)
  addTrain("route_sections absent", project(base, (t) => delete t.route_sections));
  addTrain("route_sections empty", project(base, (t) => (t.route_sections = [])));
  addTrain(
    "route_sections is 0",
    project(base, (t) => (t.route_sections = 0)),
    "accepted: the block is guarded by `if (train.route_sections)`, so every " +
      "falsy non-array skips section validation entirely instead of failing it.",
  );
  addTrain("route_sections is the empty string", project(base, (t) => (t.route_sections = "")), "accepted, same guard.");
  addTrain("route_sections is a string", project(base, (t) => (t.route_sections = "関西空港線")));
  addTrain("route_sections is an object", project(base, (t) => (t.route_sections = { 0: {} })));
  addTrain("section with neither name nor code", project(base, (t) => (t.route_sections[0] = {})));
  addTrain("section with names only", project(base, (t) => (t.route_sections[0] = { from: "A", to: "B" })));
  addTrain(
    "section with codes only",
    project(base, (t) => (t.route_sections[0] = { from_n02_station_code: "007958", to_n02_station_code: "007996" })),
  );
  addTrain("section missing the `to` half", project(base, (t) => (t.route_sections[0] = { from: "A" })));
  addTrain("section code invalid", project(base, (t) => (t.route_sections[0].from_n02_station_code = "nope")));
  addTrain("section line_names is a string", project(base, (t) => (t.route_sections[0].line_names = "A")));
  addTrain(
    "section line_names is null",
    project(base, (t) => (t.route_sections[0].line_names = null)),
    "accepted: `section[field] || []` turns every falsy value into an empty " +
      "array before the type check runs.",
  );
  addTrain("section line_names holds a number", project(base, (t) => (t.route_sections[0].line_names = ["A", 2])));
  addTrain("section operator_names holds null", project(base, (t) => (t.route_sections[0].operator_names = [null])));
  addTrain("section is null", project(base, (t) => (t.route_sections[0] = null)));

  // -- route_policy (§5)
  addTrain("route_policy absent", project(base, (t) => delete t.route_policy));
  addTrain(
    "route_policy is 0",
    project(base, (t) => (t.route_policy = 0)),
    "accepted: `if (train.route_policy)` again — a falsy policy is not a " +
      "default policy, it is an unchecked one.",
  );
  addTrain("route_policy is a string", project(base, (t) => (t.route_policy = "jr")));
  addTrain("mode wrong", project(base, (t) => (t.route_policy.mode = "shortest")));
  addTrain("mode absent", project(base, (t) => delete t.route_policy.mode));
  addTrain("jr_only is a string", project(base, (t) => (t.route_policy.jr_only = "true")));
  addTrain("jr_only absent", project(base, (t) => delete t.route_policy.jr_only));
  addTrain("allow_alternatives true", project(base, (t) => (t.route_policy.allow_alternatives = true)));
  addTrain(
    "allow_alternatives is 0",
    project(base, (t) => (t.route_policy.allow_alternatives = 0)),
    "rejected: the test is `!== false`, and 0 is not false.",
  );
  addTrain("allow_alternatives absent", project(base, (t) => delete t.route_policy.allow_alternatives));
  addTrain(
    "allow_browser_straight_line_fallback true",
    project(base, (t) => (t.route_policy.allow_browser_straight_line_fallback = true)),
  );
  addTrain(
    "allowed_institution_type_codes is null",
    project(base, (t) => (t.route_policy.allowed_institution_type_codes = null)),
    "accepted: `|| []` again.",
  );
  addTrain(
    "allowed_institution_type_codes holds numbers",
    project(base, (t) => (t.route_policy.allowed_institution_type_codes = [1, 2])),
    "accepted: the membership test is on String(code), so the numeric 1 is " +
      "the string \"1\". A port that compares the raw JSON value rejects it.",
  );
  addTrain("allowed_institution_type_codes holds 6", project(base, (t) => (t.route_policy.allowed_institution_type_codes = ["6"])));
  addTrain("allowed_institution_type_codes holds 0", project(base, (t) => (t.route_policy.allowed_institution_type_codes = ["0"])));
  addTrain("allowed_institution_type_codes is a string", project(base, (t) => (t.route_policy.allowed_institution_type_codes = "12345")));
  addTrain("allowed_institution_type_codes empty", project(base, (t) => (t.route_policy.allowed_institution_type_codes = [])));
  addTrain("preferred_line_names is a string", project(base, (t) => (t.route_policy.preferred_line_names = "A")));
  addTrain("preferred_operator_names holds a number", project(base, (t) => (t.route_policy.preferred_operator_names = [1])));
  addTrain("preferred_line_names absent", project(base, (t) => delete t.route_policy.preferred_line_names));
  addTrain("institution_filter_mode hard", project(base, (t) => (t.route_policy.institution_filter_mode = "hard")));
  addTrain("institution_filter_mode nonsense", project(base, (t) => (t.route_policy.institution_filter_mode = "strict")));
  addTrain(
    "institution_filter_mode empty string",
    project(base, (t) => (t.route_policy.institution_filter_mode = "")),
    'accepted: the check is guarded by the value\'s own truthiness, so "" ' +
      'means "not supplied" rather than "invalid".',
  );
  addTrain("institution_filter_mode absent", project(base, (t) => delete t.route_policy.institution_filter_mode));

  // -- style (§4)
  addTrain("style absent", project(base, (t) => delete t.style));
  addTrain(
    "style is a string",
    project(base, (t) => (t.style = "#ff0000")),
    "accepted: `train.style?.color` is undefined on a string, and undefined is falsy.",
  );
  addTrain("style.color absent", project(base, (t) => (t.style = {})));
  addTrain(
    "style.color empty",
    project(base, (t) => (t.style.color = "")),
    "accepted: the check is guarded by the colour's own truthiness.",
  );
  addTrain("style.color null", project(base, (t) => (t.style.color = null)));
  addTrain("style.color three digits", project(base, (t) => (t.style.color = "#f00")));
  addTrain("style.color uppercase", project(base, (t) => (t.style.color = "#C41230")));
  addTrain("style.color named", project(base, (t) => (t.style.color = "red")));
  addTrain("style.color missing hash", project(base, (t) => (t.style.color = "ff0000")));
  addTrain(
    "style.color with a trailing newline",
    project(base, (t) => (t.style.color = "#ff0000\n")),
    "rejected for the same `$` reason as the id case: ICU would accept it.",
  );
  addTrain("style.color is a number", project(base, (t) => (t.style.color = 16711680)));
  addTrain(
    "style carries the removed legacy fields",
    project(base, (t) => {
      t.style.weight = 4;
      t.style.unridden_opacity = 0.3;
    }),
    "accepted by validateTrain; dropped by canonicalStyle on the way out (§4.1).",
  );

  // ---- duplicate ids ---------------------------------------------------
  // validateTrain takes the id set as a parameter and mutates it, so the
  // duplicate rule can only be seen across a sequence of calls.
  const idSequences = [
    { label: "two distinct ids", ids: ["odr_001", "odr_002"] },
    { label: "the same id twice", ids: ["odr_001", "odr_001"] },
    { label: "ids differing only in case", ids: ["ODR_001", "odr_001"] },
    { label: "the third repeats the first", ids: ["a", "b", "a"] },
    { label: "an invalid id does not enter the set", ids: ["a.b", "a.b"] },
  ].map((item) => {
    const ids = new Set();
    const results = item.ids.map((id, index) =>
      attempt(() => js.validateTrain(project(base, (t) => (t.id = id)), index, ids)),
    );
    return { ...item, results, finalIds: [...ids] };
  });

  // ---- validateTrainStore ----------------------------------------------
  // Every input is the literal JSON TEXT a reader could paste, parsed here
  // and handed straight to validateTrainStore. Text rather than a live value
  // because the key order in that text is what decides which unsupported key
  // the error message names — see the two ordering cases below.
  const storeCases = [];
  const addStore = (label, text, note) =>
    storeCases.push({
      label,
      ...(note ? { note } : {}),
      store: text,
      ...attempt(() => js.validateTrainStore(JSON.parse(text))),
    });

  const failingTrain = project(base, (t) => {
    t.id = "odr_002";
    t.stops = [];
  });

  addStore("a one-train store", JSON.stringify({ schema_version: "1.3", trains: [base] }));
  addStore("an empty store", '{"schema_version":"1.3","trains":[]}');
  addStore("root is an array", JSON.stringify([base]));
  addStore("root is an empty array", "[]");
  addStore("root is null", "null");
  addStore("root is a string", '"{}"');
  addStore("root is a number", "3");
  addStore("root is true", "true");
  addStore("schema_version 1.2", '{"schema_version":"1.2","trains":[]}');
  addStore("schema_version absent", '{"trains":[]}');
  addStore("schema_version is a number", '{"schema_version":1.3,"trains":[]}');
  addStore("trains absent", '{"schema_version":"1.3"}');
  addStore("trains is an object", '{"schema_version":"1.3","trains":{}}');
  addStore("trains is null", '{"schema_version":"1.3","trains":null}');
  addStore("an unsupported top-level key", '{"schema_version":"1.3","trains":[],"country":"jp"}');
  addStore(
    "two unsupported keys — document order decides which is named",
    '{"schema_version":"1.3","trains":[],"zebra":1,"apple":2}',
    "assertOnlyKeys throws on the FIRST offending key in Object.keys order, " +
      "so the message depends on key order. For ordinary string keys that is " +
      "the order they appear in the document, which is why a port must parse " +
      "order-preservingly instead of into a dictionary.",
  );
  addStore(
    "unsupported keys that look like array indices",
    '{"zebra":1,"2":1,"10":1,"1":1,"schema_version":"1.3","trains":[]}',
    'JavaScript lists integer-index keys FIRST, in ascending NUMERIC order, ' +
      'before every string key regardless of where they appeared — so "1" is ' +
      'named even though "zebra" came first and "2" came before it. A port ' +
      'that merely preserves document order names "zebra"; one that sorts ' +
      'keys as strings names "1" for the wrong reason and would name "10" ' +
      'before "2" in a case that had no "1".',
  );
  addStore(
    "integer-like keys with no 1, so numeric order is visible",
    '{"10":1,"2":1}',
    'numeric order, not string order: "2" is named, where a string sort would name "10".',
  );
  addStore(
    "the second train is the one that fails",
    JSON.stringify({ schema_version: "1.3", trains: [base, failingTrain] }),
  );
  addStore(
    "two trains sharing an id",
    JSON.stringify({ schema_version: "1.3", trains: [base, clone(base)] }),
  );

  // ---- parseImportedCanonicalStore -------------------------------------
  // Its input is either a string (JSON.parse first) or a live value. Both
  // paths are exercised; the string cases carry the raw text so that the port
  // parses the same bytes. A malformed-text case records only that it threw:
  // the message is V8's own and is not part of any contract.
  const parseCases = [];
  const addParse = (label, input, note) => {
    const isText = typeof input === "string";
    const result = attempt(() => js.parseImportedCanonicalStore(input));
    parseCases.push({
      label,
      ...(note ? { note } : {}),
      // Exactly one of these is present: `text` is a literal string handed to
      // the function (so it takes the JSON.parse branch), `input` is the JSON
      // spelling of a live value handed to it (so it does not). The spelling
      // preserves key order for the reason given at stableStringify. The
      // OUTPUT is `value`, and the two must not share a name or the second
      // spread silently eats the first.
      ...(isText ? { text: input } : { input: JSON.stringify(input) }),
      ...(result.ok
        ? { ok: true, value: stableStringify(result.value) }
        : { ok: false, errorName: result.errorName, error: result.error }),
    });
  };

  addParse("a full store as text", JSON.stringify({ schema_version: "1.3", trains: [base] }));
  addParse("a full store as a value", { schema_version: "1.3", trains: [base] });
  addParse("a bare trains array", [base]);
  addParse("an empty array", []);
  addParse("a single train object", base);
  addParse("a single train object as text", JSON.stringify(base));
  addParse("an object with id but no stops", { id: "x", number: "1", origin: "a", destination: "b" });
  addParse("an object with stops but no id", { stops: [{ name: "a" }, { name: "b" }] });
  addParse("an object with id and empty stops", { id: "x", stops: [] });
  addParse("null", null);
  addParse("true", true);
  addParse("a JSON null as text", "null");
  addParse("a JSON string as text", '"hello"');
  addParse("a JSON number as text", "42");
  addParse(
    "malformed text",
    "{not json",
    "the message is V8's own JSON.parse text and is not a contract; the port " +
      "only has to throw.",
  );
  addParse("an empty object", {});
  addParse("a store with an extra key", { schema_version: "1.3", trains: [], extra: 1 });
  addParse("a store with a bad schema_version", { schema_version: "9.9", trains: [] });
  addParse(
    "a train object that also carries a non-array `trains`",
    { id: "x", stops: [{ name: "a" }, { name: "b" }], trains: "no" },
    "the `trains` key is only consulted through Array.isArray, so this falls " +
      "through to the single-train branch and the whitelist never runs — an " +
      "object with an unsupported top-level key is accepted here.",
  );
  addParse(
    "a store whose trains array is nested one deep",
    { schema_version: "1.3", trains: [[base]] },
    "accepted by the parser: it never looks inside the array.",
  );

  // ---- assertOnlyKeys, on its own ---------------------------------------
  // The object is given as literal JSON text and parsed here, so that the key
  // order in the text is the key order the function sees.
  const assertKeyCases = [
    { label: "no keys", object: "{}", allowed: ["a"] },
    { label: "all allowed", object: '{"a":1,"b":2}', allowed: ["a", "b"] },
    { label: "one not allowed", object: '{"a":1,"c":3}', allowed: ["a", "b"] },
    { label: "document order decides", object: '{"z":1,"y":1}', allowed: [] },
    {
      label: "integer-like keys come first, in numeric order",
      object: '{"b":1,"10":1,"2":1,"a":1}',
      allowed: [],
    },
    { label: "a key named toString", object: '{"toString":1}', allowed: [] },
    { label: "a key that is the empty string", object: '{"":1}', allowed: [] },
    {
      label: "an array as the object",
      object: '["a","b"]',
      allowed: [],
    },
    {
      label: "an array whose indices are allowed",
      object: '["a","b"]',
      allowed: ["0", "1"],
    },
  ].map((item) => ({
    ...item,
    ...attempt(() => js.assertOnlyKeys(JSON.parse(item.object), item.allowed, "Label")),
  }));
  // null and undefined are not JSON values, so they get their own entries:
  // `Object.keys(object || {})` is what makes both of them pass.
  const assertKeyNullish = [
    { label: "null object", ...attempt(() => js.assertOnlyKeys(null, ["a"], "Label")) },
    { label: "undefined object", ...attempt(() => js.assertOnlyKeys(undefined, ["a"], "Label")) },
  ];

  // ---- normalizeImportedTrain -------------------------------------------
  const importCases = [];
  const addImport = (label, country, train, options, note) => {
    js.setActiveCountry(country);
    const result = attempt(() => js.normalizeImportedTrain(train, options || {}));
    js.setActiveCountry("jp");
    importCases.push({
      label,
      ...(note ? { note } : {}),
      country,
      input: JSON.stringify(train),
      fallbackDate: (options && options.fallbackDate) || null,
      ...(result.ok
        ? { ok: true, value: stableStringify(result.value) }
        : { ok: false, errorName: result.errorName, error: result.error }),
    });
  };

  // Real trains first: the import path has to be a fixed point on the data
  // the app already wrote, or every save/load cycle would drift.
  stores[0].store.trains
    .slice(0, 10)
    .forEach((train, index) => addImport(`a committed jp train (${index})`, "jp", train));
  stores[1].store.trains
    .slice(0, 6)
    .forEach((train, index) => addImport(`a committed tw train (${index})`, "tw", train));

  const lean = {
    id: "lean_001",
    number: "1M",
    origin: "東京",
    destination: "品川",
    stops: [{ name: "東京" }, { name: "品川" }],
  };
  const withLean = (extra) => ({ ...lean, ...extra });

  addImport("the leanest train the importer accepts", "jp", lean);
  addImport("the leanest train, with a fallback date", "jp", lean, { fallbackDate: "2026-08-05" });
  addImport("a train whose id spells its date", "jp", withLean({ id: "20260703_lean" }));
  addImport(
    "a train whose id spells its date, with a fallback",
    "jp",
    withLean({ id: "20260703_lean" }),
    { fallbackDate: "2026-08-05" },
    "the fallback beats the id: normalizeTrainDate tries train.date, then the " +
      "fallback, then the id.",
  );
  addImport("an explicit slash-written date beats the fallback", "jp", withLean({ date: "2026/08/06" }), { fallbackDate: "2026-08-05" });
  addImport("an invalid explicit date falls through to the fallback", "jp", withLean({ date: "2026-13-01" }), { fallbackDate: "2026-08-05" });

  addImport("an unsupported train key", "jp", withLean({ nickname: "x" }));
  addImport("route_geometry, the removed field", "jp", withLean({ route_geometry: [] }));
  addImport("an array", "jp", [lean]);
  addImport("null", "jp", null);
  addImport("a string", "jp", "train");
  addImport("id empty", "jp", withLean({ id: "" }));
  addImport("id is not in the documented charset", "jp", withLean({ id: "odr.001" }), undefined, "accepted: normalizeImportedTrain never applies TRAIN_ID_PATTERN — only validateTrain does.");
  addImport("number empty", "jp", withLean({ number: "" }));
  addImport("origin empty", "jp", withLean({ origin: "" }));
  addImport("destination empty", "jp", withLean({ destination: "" }));
  addImport("one stop", "jp", withLean({ stops: [{ name: "東京" }] }));
  addImport("stops is a string", "jp", withLean({ stops: "x" }));
  addImport("a stop with an unsupported key", "jp", withLean({ stops: [{ name: "東京", platform: 3 }, { name: "品川" }] }));
  addImport("a stop with no name key", "jp", withLean({ stops: [{ n02_station_code: "003770" }, { name: "品川" }] }));
  addImport(
    "a stop whose name is null",
    "jp",
    withLean({ stops: [{ name: null }, { name: "品川" }] }),
    undefined,
    'accepted: the guard is `"name" in stop`, so a present-but-empty name ' +
      "passes import and is only caught later by validateTrain.",
  );
  addImport("a stop that is null", "jp", withLean({ stops: [null, { name: "品川" }] }));
  addImport("a stop that is an array", "jp", withLean({ stops: [[], { name: "品川" }] }));
  addImport(
    "a stop with a legacy N02_005c key",
    "jp",
    withLean({ stops: [{ name: "東京", N02_005c: "003770" }, { name: "品川" }] }),
    undefined,
    "rejected by the whitelist even though stopStationCode still reads that key.",
  );
  addImport(
    "a stop_type outside the enum",
    "jp",
    withLean({ stops: [{ name: "東京", stop_type: "skipped" }, { name: "品川" }] }),
    undefined,
    "accepted: the import path never consults STOP_TYPES.",
  );
  addImport(
    "times that are not times",
    "jp",
    withLean({ stops: [{ name: "東京", departure: "banana" }, { name: "品川", arrival: "26:99" }] }),
    undefined,
    "accepted, and normalizeNullableTime only trims — it never parses.",
  );
  addImport(
    "times that are blank strings",
    "jp",
    withLean({ stops: [{ name: "東京", departure: "   " }, { name: "品川", arrival: "" }] }),
    undefined,
    "normalizeNullableTime collapses a whitespace-only time to null (§19).",
  );
  addImport(
    "a time that is a number",
    "jp",
    withLean({ stops: [{ name: "東京", departure: 830 }, { name: "品川" }] }),
    undefined,
    "normalizeNullableTime returns a non-string unchanged, so 830 survives " +
      "import and is then rejected by validateTrain.",
  );
  addImport("an invalid station code", "jp", withLean({ stops: [{ name: "東京", n02_station_code: "nope" }, { name: "品川" }] }), undefined, "accepted: the import path never applies the code grammar.");
  addImport("train_type is a number", "jp", withLean({ train_type: 7 }));
  addImport("train_type has padding", "jp", withLean({ train_type: "  特急  " }));
  addImport("company has padding", "jp", withLean({ company: "  JR東日本  " }));
  addImport(
    "a Taiwanese legacy company name",
    "tw",
    withLean({ company: "臺灣鐵路管理局" }),
    undefined,
    "the tw branch runs RailOperatorBranding.normalizeTaiwanCompanyName; the " +
      "jp branch does not, so the same train imports differently per country.",
  );
  addImport("the same legacy company name under jp", "jp", withLean({ company: "臺灣鐵路管理局" }));
  addImport("direction empty", "jp", withLean({ direction: "" }));
  addImport("direction is false", "jp", withLean({ direction: false }));
  addImport("visible false", "jp", withLean({ visible: false }));
  addImport("visible 0", "jp", withLean({ visible: 0 }), undefined, "normalises to true — the test is `!== false`.");
  addImport("visible null", "jp", withLean({ visible: null }), undefined, "normalises to true, same reason.");
  addImport("style with legacy fields", "jp", withLean({ style: { color: "#123456", weight: 4, unridden_opacity: 0.3 } }));
  addImport("style is a string", "jp", withLean({ style: "#123456" }));
  addImport("style.color absent", "jp", withLean({ style: {} }));
  // The falsy-colour branch of canonicalStyle. `style?.color || DEFAULT`
  // means a present-but-empty colour is replaced, not kept — which is the
  // only thing separating `||` from a nil-coalesce in the port.
  addImport("style.color empty", "jp", withLean({ style: { color: "" } }));
  addImport("style.color null", "jp", withLean({ style: { color: null } }));
  addImport("style.color false", "jp", withLean({ style: { color: false } }));
  addImport(
    "style.color is a number",
    "jp",
    withLean({ style: { color: 16711680 } }),
    undefined,
    "canonicalStyle does no validation at all: it takes any truthy value " +
      "through String(), so an unusable colour is stored and only " +
      "validateTrain rejects it.",
  );
  addImport("route_policy partly supplied", "jp", withLean({ route_policy: { jr_only: true, preferred_line_names: ["A", ""] } }));
  addImport("route_policy is a string", "jp", withLean({ route_policy: "jr" }));
  addImport("route_policy.jr_only is truthy but not true", "jp", withLean({ route_policy: { jr_only: 1 } }), undefined, "canonicalRoutePolicy tests `=== true`, so 1 becomes false.");
  addImport(
    "route_sections is a string",
    "jp",
    withLean({ route_sections: "x" }),
    undefined,
    "accepted and silently emptied: Array.isArray decides, and a non-array " +
      "becomes [] rather than an error.",
  );
  addImport("a route section that is null", "jp", withLean({ route_sections: [null] }));
  addImport("a route section with an unsupported key", "jp", withLean({ route_sections: [{ from: "A", to: "B", via: "x" }] }));
  addImport(
    "a route section with codes only",
    "jp",
    withLean({ route_sections: [{ from_n02_station_code: "003770", to_n02_station_code: "003771" }] }),
    undefined,
    'the names come back as "" because no station table is installed — see ' +
      "the header. With one installed they would be the codes' canonical names (§13.4).",
  );
  addImport("a route section with a branch number and name", "jp", withLean({ route_sections: [{ from: "A", to: "B", number: 95, name: "こまち" }] }));
  addImport("a route section with empty hint arrays", "jp", withLean({ route_sections: [{ from: "A", to: "B", line_names: [], operator_names: [""] }] }));
  addImport("a route section with a numeric line name", "jp", withLean({ route_sections: [{ from: "A", to: "B", line_names: [1, 2] }] }), undefined, "accepted: the import path maps through String(), so validateTrain never sees the numbers.");

  // ---- the export path, with the section list disturbed ----------------
  // getRideRouteSectionsForTrain recomputes one section per adjacent stop
  // pair and reuses an already-written section only when it MATCHES that
  // pair — preferring the section at the same index, then searching the whole
  // list. In both committed stores the same-index section always matches, so
  // the search fallback and the synthesis branch are never reached by the
  // stores as written. These projections reach them: rotating the list moves
  // every section off its index (so the search answers), reversing it does
  // the same in the other direction, truncating it forces synthesis for the
  // tail, and emptying it forces synthesis throughout.
  //
  // A projection, not an invention: the stops and the sections are the real
  // ones, only their pairing is disturbed.
  const rotate = (list, by) => list.map((_, i) => list[(i + by) % list.length]);
  const exportProjections = [];
  for (const { country, store } of stores) {
    js.setActiveCountry(country);
    js.setTrainStore(store);
    // The first train with enough sections for a rotation to change anything.
    const train = store.trains.find((candidate) => candidate.route_sections.length >= 3);
    if (!train)
      throw new Error(
        `no ${country} train with 3+ route sections — the rotation projections ` +
          "would be no-ops and would stop testing anything",
      );
    const variants = [
      ["sections rotated by one", (t) => (t.route_sections = rotate(t.route_sections, 1))],
      ["sections reversed", (t) => t.route_sections.reverse()],
      ["only the first section kept", (t) => (t.route_sections = t.route_sections.slice(0, 1))],
      ["only the last section kept", (t) => (t.route_sections = t.route_sections.slice(-1))],
      ["sections emptied", (t) => (t.route_sections = [])],
      ["sections dropped entirely", (t) => delete t.route_sections],
      [
        "every section name and code cleared",
        (t) =>
          t.route_sections.forEach((section) => {
            delete section.from;
            delete section.to;
            section.from_n02_station_code = null;
            section.to_n02_station_code = null;
          }),
      ],
      [
        "every stop code cleared, so only names can match",
        (t) => t.stops.forEach((stop) => (stop.n02_station_code = null)),
      ],
      [
        "every stop name cleared, so only codes can match",
        (t) => t.stops.forEach((stop) => (stop.name = "")),
      ],
    ];
    for (const [label, mutate] of variants) {
      const input = project(train, mutate);
      exportProjections.push({
        label: `${country}: ${label}`,
        country,
        id: train.id,
        input: JSON.stringify(input),
        canonical: stableStringify(js.normalizeExportTrain(input)),
      });
    }
  }
  js.setActiveCountry("jp");
  js.setTrainStore(stores[0].store);

  // ---- the predicates, probed directly ----------------------------------
  // Each rule below is a regex in the JavaScript and must NOT be a regex in
  // the port: ICU's `$` matches before a trailing newline and its `\d` is
  // \p{Nd}. These probes are what pins that.
  const codeProbes = [
    null, "", "003770", "00377", "0037701", "12345a", "TRA-1000", "TYMC-A13",
    "KR-GYEONGBUSEON-SEOUL", "TML-MTR-WKS", "MLM-TAIPA-MLM-BARRA", "TRAM-E-01E",
    "A-1", "A1", "-A1", "A-", "A--1", "a-1", "1-A", "AB-cd-12", "A_1", "A-1-",
    "003770\n", "\n003770", " 003770 ", "\t003770", "003770", "003770",
    "\uFEFF003770", "\u0085003770", "\u00A0003770", "\u3000003770", "\u2028003770",
    "００３７７０", "٠٠٣٧٧٠",
    "A-1\n", "Ａ-1", "003 770", "00-3770",
  ];
  const stationCodes = codeProbes.map((code) => ({
    code,
    system: js.stationCodeSystem(code),
    valid: js.isValidSourceStationCode(code),
  }));

  const colorProbes = [
    "#ff0000", "#FF0000", "#Ff00Aa", "#fff", "#ff00000", "ff0000", "#gg0000",
    "", "#ff0000\n", "\n#ff0000", " #ff0000", "#ff0000 ", "#ｆｆ0000",
    "#ff00 0", "##ff0000", "#ff000",
  ];
  const colors = colorProbes.map((value) => ({ value, valid: js.isValidTrainColor(value) }));

  const idPattern = new RegExp(js.constants.TRAIN_ID_PATTERN);
  const idProbes = [
    "a", "A", "0", "_", "-", "abc-123_XYZ", "", " a", "a ", "a.b", "a b",
    "a\nb", "a\n", "\na", "はやぶさ", "００１",
    "café", "a/b", "20260703_01_haruka", "a b",
  ];
  const ids = idProbes.map((value) => ({ value, valid: idPattern.test(value) }));

  // makeUniqueTrainId — what turns a duplicate id into odr_001-2.
  const uniqueIdCases = [
    { base: "odr_001", existing: [] },
    { base: "odr_001", existing: ["odr_001"] },
    { base: "odr_001", existing: ["odr_001", "odr_001-2"] },
    { base: "odr_001", existing: ["odr_001", "odr_001-2", "odr_001-3"] },
    { base: "odr_001", existing: ["odr_001-2"] },
    { base: "", existing: [] },
    { base: "   ", existing: [] },
    { base: "  odr_001  ", existing: [] },
    { base: "train", existing: ["train"] },
    { base: "train", existing: ["train", "train-2", "train-3", "train-4"] },
  ].map((item) => ({ ...item, result: js.makeUniqueTrainId(item.base, new Set(item.existing)) }));

  return {
    describes:
      "app-validation.js §33 (validateTrain / validateTrainStore) and the " +
      "app-store-ops.js §18–§19 canonical shapes and import normalisers " +
      "around it, over both committed itinerary stores",
    contract:
      "validateTrain is the definition of an itinerary: everything that " +
      "reaches the map goes through it, so what it accepts is the schema, and " +
      "a port that disagrees can no longer exchange files with the app it was " +
      "forked from. Its shape is narrower than jsonspec's prose in one " +
      "direction and much wider in the other. Narrower: the id charset, the " +
      "five stop_types, the six-digit N02 / TDX station-code grammar and the " +
      "#RRGGBB colour are hard rejections. Wider: a time is only ever checked " +
      "to be a string or null — never parsed, never compared to the next " +
      "stop's — so an itinerary whose clock runs backwards is valid; " +
      "`visible` is not type-checked at all; a falsy-but-present " +
      "route_sections or route_policy skips its whole block rather than " +
      "failing it; and every `x || []` turns a null array into an empty one. " +
      "The two front doors disagree where it looks deliberate: " +
      "normalizeImportedTrain coerces a numeric train_type to \"\" where " +
      "validateTrain rejects it, and enforces a key whitelist validateTrain " +
      "never applies. One input crashes rather than rejects: a null row in " +
      "`stops` reaches stops[0].departure before anything has checked it is " +
      "an object. The export side is the fixed point that makes a save/load " +
      "cycle lossless — canonicalStopShape writes all six stop fields every " +
      "time, canonicalStyle drops the removed weight / unridden_opacity, and " +
      "leanExportSection omits a section name only when the station table can " +
      "put it back.",
    constants: js.constants,
    baseTrainIds: { jp: base.id, tw: baseTw.id },
    cases,
    exportCases,
    validateCases,
    idSequences,
    storeCases,
    parseCases,
    exportProjections,
    assertKeyCases,
    assertKeyNullish,
    importCases,
    stationCodes,
    colors,
    ids,
    uniqueIdCases,
  };
}
