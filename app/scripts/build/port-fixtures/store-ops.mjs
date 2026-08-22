// =========================================================================
//  port-fixtures/store-ops.mjs — freeze the train store's WRITE side
//
//  app-store-ops.js §17–§20 is the gate in front of the whole editor. §33
//  (validation.json) decides what an itinerary IS; this file decides how one
//  comes into existence, changes, and is written back out. Three things here
//  are contracts rather than conveniences:
//
//  1. THE CANONICAL EXPORT IS A BYTE FORMAT. `exportTrainStore()` is
//     `JSON.stringify(store, null, 2)`, and its bytes are what
//     `app/data/train-store.json` holds — so key ORDER, indentation, which
//     keys are written at all, and how a CJK station name is escaped are all
//     part of the answer, not presentation. `validation.json` already checks
//     the export's VALUES (through a sorted-key canonicalisation, because
//     Swift's Codable emits no defined key order). This file checks the
//     bytes, which is the thing an archive round trip actually depends on.
//
//  2. KEY ORDER IS OBSERVABLE. JavaScript object literals serialise in
//     insertion order, so `normalizeExportTrain`'s 13 fields, the route
//     policy's 8 and `leanExportSection`'s conditional `from`/`to` are a
//     spelling the port has to reproduce exactly. A Swift `JSONEncoder`
//     cannot: it emits keys in no defined order. So the port needs its own
//     serialiser and this is what pins it.
//
//  3. THE CRUD HANDLERS HAVE A PURE CORE. addTrain / duplicateTrain /
//     deleteTrain / deleteAllTrains / toggleTrainVisibility / moveTrain each
//     do a small state transition on (trains, selectedTrainId,
//     focusedTrainId) and then hand a named MutationResult to the renderer.
//     The transition is portable; the renderer is not. What is recorded here
//     is the transition, plus WHICH mutation result was signalled — the
//     latter because "this operation is a no-op" and "this operation changed
//     the collection" are different answers and the shell has to know which.
//
//  ── inputs ─────────────────────────────────────────────────────────────
//  Both committed stores, whole, plus adversarial stores built from them:
//  empty, one train, and the ends of the list. The adversarial cases are the
//  point — over a 201-train store, "delete the last one" and "move the first
//  one up" never reach the branches that decide what happens when the list
//  runs out, and those branches are where a naive port passes and then loses
//  the user's selection in the field.
//
//  ── the station table is deliberately empty ────────────────────────────
//  Same reason as validation.mjs: `leanExportSection` and
//  `getRideRouteSectionsForTrain` reach for the station index through bare
//  globals, and "nothing fetched yet" is the real state every boot and every
//  import runs in. With no index installed, no section name is dropped and a
//  stop falls back to its own code — which makes the whole export path a pure
//  function of the store, which is what makes it checkable.
// =========================================================================

import fs from "node:fs";
import path from "node:path";

export const name = "store-ops.json";

// ── loading the store operations ────────────────────────────────────────
// Classic scripts sharing one global lexical scope (contract 1), exactly as
// validation.mjs loads them and as the precompute VM does. Concatenating the
// files and evaluating them through one `new Function` IS that scope; never
// copy a body into this file, or the fixture only proves the copy and the
// port agree.
//
// The chain is dictated by index.html. app-render.js and app-import.js are
// deliberately ABSENT: everything they own here is DOM and persistence, and
// pulling them in would drag `document` into a fixture generator. The three
// names §17 reads out of them are supplied by the prelude below instead.
const SCOPE_FILES = [
  "app-operator-branding.js", // window.RailOperatorBranding — the TW company rule
  "railmap-basemap.js", // window.RailMapBasemap
  "railmap-style.js", // window.RailMapStyle — read at app-config.js's top level
  "app-config.js", // SCHEMA_VERSION, ALL_DATES, DEFAULT_* , activeCountry …
  "app-coords.js", // clone — the deep copy addTrain/duplicateTrain make
  "app-datasets.js", // stationNameForCode and the map behind it
  "app-stations.js", // stopName, stopStationCode, resolveStationForTrain
  "app-store-ops.js", // §17–§20 — the module under test
  "app-validation.js", // §33 — appendImportedTrain calls validateTrain
  "app-ui-utils.js", // isValidTrainColor
  "app-state.js", // trainStore / selectedTrainId / focusedTrainId / AppActions
];

// The names §17 reads that live in the view layer. `var`, so they are
// ordinary bindings of the same shared scope rather than properties of
// anything — which is what the real files' `const`/`let` declarations are.
//
// applyMutationResult is the seam between the store and the renderer. Its
// real body (app-render.js §22) reconciles the date bar, schedules a
// debounced save and re-renders four views; none of that is portable and none
// of it feeds back into the store. Replacing it with a recorder is what makes
// "which mutation result did this operation signal" an observable output.
//
// MutationResults' real members are frozen option objects. Only their
// IDENTITY is consulted here, so strings stand in: the fixture records which
// one was signalled, not what the renderer does with it.
const PRELUDE = `
  var countrySwitchInFlight = false;
  var MutationResults = {
    trainCollectionChanged: "trainCollectionChanged",
    trainOrderChanged: "trainOrderChanged",
    visibilityChanged: "visibilityChanged",
  };
  var lastMutationResult = null;
  var applyMutationResult = (result) => { lastMutationResult = result; };
`;

function loadStoreOpsScope(APP_DIR, AppCore, RailNetwork) {
  const source =
    PRELUDE +
    SCOPE_FILES.map((file) =>
      fs.readFileSync(path.join(APP_DIR, "public", file), "utf8"),
    ).join("\n");
  const factory = new Function(
    "window",
    `${source}
     return {
       // §17 — the CRUD handlers
       addTrain, duplicateTrain, deleteTrain, deleteAllTrains,
       toggleTrainVisibility, moveTrain, getTrain, uniqueId,
       // §18 — the canonical export, and the byte format on top of it
       exportTrainStore, buildCanonicalTrainStore, normalizeExportTrain,
       getRideRouteSectionsForTrain,
       // §19 — the import append path
       appendImportedTrain, normalizeImportedTrain, currentImportFallbackDate,
       // §20 — the blank-train factory
       createBlankTrain,
       constants: {
         SCHEMA_VERSION, ALL_DATES, UNDATED, DEFAULT_TRAIN_COLOR,
         DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES: [...DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES],
       },
       // The mutable globals these handlers read and write. They take no
       // parameters for them, so driving them means writing them.
       setTrainStore: (value) => { trainStore = value; },
       getTrainStore: () => trainStore,
       setActiveCountry: (value) => { activeCountry = value; },
       setSelectedDate: (value) => { selectedDate = value; },
       setSelection: (selected, focused) => {
         selectedTrainId = selected; focusedTrainId = focused;
       },
       getSelection: () => ({ selected: selectedTrainId, focused: focusedTrainId }),
       takeMutation: () => { const m = lastMutationResult; lastMutationResult = null; return m; },
       // An EMPTY station index, not a missing one: resolveStationCandidates
       // does stationCandidatesIndex.get(...) unguarded, so leaving it
       // undefined throws out of the export path instead of exercising it.
       installEmptyStationIndex: () => { stationCandidatesIndex = new Map(); },
     };`,
  );
  return factory({ AppCore, RailNetwork });
}

// ── serialisation ───────────────────────────────────────────────────────
//
// Two spellings, for two different questions, and mixing them up is how a
// byte-format fixture stops checking bytes.
//
// `bytes()` is plain JSON.stringify, which preserves insertion order. It is
// used wherever ORDER IS THE ANSWER: the canonical export, the blank-train
// scaffolds, the per-section export shape. The port has to reproduce these
// character for character.
const bytes = (value, indent) => JSON.stringify(value, null, indent);

// `stable()` sorts keys, and is used where the answer is a VALUE and the
// port's own encoder would be the only thing under test otherwise. Sorting is
// `Array.prototype.sort` with no comparator — UTF-16 code unit order, which
// the Swift side reproduces through JSNumber.stringLessOrEqual rather than
// inheriting from whatever `String: Comparable` does.
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(",")}}`;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/** What a JS throw looks like as fixture data — see validation.mjs. */
function attempt(run) {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, errorName: error.name, error: error.message };
  }
}

function readStore(APP_DIR, file) {
  return JSON.parse(fs.readFileSync(path.join(APP_DIR, "data", file), "utf8"));
}

export function build({ AppCore, RailNetwork, APP_DIR }) {
  const js = loadStoreOpsScope(APP_DIR, AppCore, RailNetwork);
  js.installEmptyStationIndex();
  js.setSelectedDate(js.constants.ALL_DATES);

  const stores = [
    { country: "jp", file: "train-store.json" },
    { country: "tw", file: "train-store-tw.json" },
  ].map((entry) => ({
    ...entry,
    raw: fs.readFileSync(path.join(APP_DIR, "data", entry.file), "utf8"),
    store: readStore(APP_DIR, entry.file),
  }));

  // ---- §20: the blank-train scaffolds ----------------------------------
  // Five countries, five different starters, and the whole reason the factory
  // is country-specific: a new Taiwan train must not carry Japanese N02 codes
  // into the Taiwan store. Recorded as BYTES because a scaffold flows
  // straight into addTrain and then into the export, so its key order is the
  // export's key order for a train that has never been saved.
  const blankTrains = ["jp", "tw", "hk", "kr", "mo", "xx"].map((country) => {
    js.setActiveCountry(country);
    return { country, train: bytes(js.createBlankTrain(), 2) };
  });

  // ---- §18: the export, byte for byte ----------------------------------
  const exports_ = [];
  for (const { country, store, raw } of stores) {
    js.setActiveCountry(country);
    js.setTrainStore(clone(store));
    const text = js.exportTrainStore();

    // How the export compares to the file it was read from. This is NOT an
    // equality the app guarantees, and recording the actual answer is the
    // point: the Japanese archive predates the current route-policy writer,
    // so a first save REWRITES 87 of its 201 trains — 41 by key order alone
    // (institution_filter_mode moved) and 46 by value (two preferred_* arrays
    // the writer now always emits). A port that "fixed" this would silently
    // stop reproducing what the app does to the archive.
    let identical = 0;
    let orderOnly = 0;
    let valueDiff = 0;
    store.trains.forEach((train) => {
      const exported = js.normalizeExportTrain(train);
      if (bytes(train, 2) === bytes(exported, 2)) identical += 1;
      else if (stable(train) === stable(exported)) orderOnly += 1;
      else valueDiff += 1;
    });
    let firstDiff = null;
    if (text !== raw) {
      firstDiff = 0;
      while (
        firstDiff < text.length &&
        firstDiff < raw.length &&
        text[firstDiff] === raw[firstDiff]
      )
        firstDiff += 1;
    }

    exports_.push({
      country,
      text,
      committed: {
        // The file's own serialisation. jp is pretty-printed with a trailing
        // newline; tw is minified with none — so `exportTrainStore()` cannot
        // equal the tw file no matter how correct it is, and the port has to
        // be able to spell both.
        fileEqualsPretty2: raw === bytes(store, 2),
        fileEqualsPretty2Newline: raw === `${bytes(store, 2)}\n`,
        fileEqualsMinified: raw === bytes(store),
        fileEndsWithNewline: raw.endsWith("\n"),
        // The export against the file.
        exportEqualsFile: text === raw,
        firstDifferingIndex: firstDiff,
        trainsIdentical: identical,
        trainsDifferingByKeyOrderOnly: orderOnly,
        trainsDifferingByValue: valueDiff,
      },
    });
  }

  // ---- the byte format itself ------------------------------------------
  // JSON.stringify(value, null, n) over shapes the stores do not contain, so
  // that a port's serialiser is checked on the escapes and the nesting rather
  // than only on the data that happens to be committed. Every one of these is
  // reachable from a hand-authored itinerary: a station name is free text.
  const stringifyValues = [
    {},
    [],
    { a: {}, b: [] },
    { a: [{}, [], [[]]] },
    { "": "" },
    { nested: { deep: { deeper: [1, 2, { x: null }] } } },
    { quote: 'a"b', backslash: "a\\b", slash: "a/b" },
    { tab: "a\tb", newline: "a\nb", cr: "a\rb", bs: "a\bb", ff: "a\fb" },
    // C0 controls with no short escape take \u00xx, LOWER-case hex.
    { control: "\u0000\u0001\u001f" },
    // Not escaped by JSON.stringify, despite being line terminators in
    // JavaScript source: a port that escapes them writes different bytes.
    { lineSeparator: "a\u2028b\u2029c" },
    // U+007F is not a C0 control and is emitted raw.
    { del: "a\u007fb" },
    // CJK is emitted raw — that is what makes a station name one token rather
    // than six escapes, and it is most of the committed archive.
    { name: "東京", tw: "臺北車站", kr: "서울", zh: "氹仔線" },
    // Outside the BMP: one scalar, two UTF-16 code units. A port that walks
    // scalars and converts each half on its own produces two replacement
    // characters here.
    { emoji: "🚄🇯🇵" },
    // Combining marks: U+304C as one scalar and as U+304B U+3099. JavaScript
    // keeps them distinct; Swift's String == does not.
    { composed: "\u304c", decomposed: "\u304b\u3099" },
    { nbsp: "a\u00a0b", bom: "\ufeffa", ideographicSpace: "a\u3000b" },
    // Booleans and null inside arrays, plus the one number shape the store
    // never has but a hand-authored file might.
    { flags: [true, false, null], n: [0, -0, 1, 1.5, 1e21, 1e-7, 100] },
  ];
  const stringifyCases = [];
  for (const value of stringifyValues)
    for (const indent of [0, 2])
      stringifyCases.push({
        input: bytes(value, 0),
        indent,
        output: bytes(value, indent === 0 ? undefined : indent),
      });

  // ---- §18: getRideRouteSectionsForTrain, the seam -------------------
  // Named by the route-graph port as belonging to the train store:
  // buildTrainRouteSolveContext takes its sections from here, so the cache key
  // of every solve is downstream of this function. Recorded for EVERY
  // committed train rather than a sample — the interesting behaviour is the
  // reuse rule (prefer the section at the same index, else search the whole
  // list, else synthesise from the stop pair) and which branch a train takes
  // depends on its own section list.
  const rideSections = [];
  for (const { country, store } of stores) {
    js.setActiveCountry(country);
    js.setTrainStore(clone(store));
    store.trains.forEach((train, index) => {
      rideSections.push({
        country,
        index,
        id: train.id,
        sections: bytes(js.getRideRouteSectionsForTrain(train), 0),
      });
    });
  }

  // The reuse rule's other branches. Both committed stores are already in
  // step with their stops, so the search fallback and the synthesis branch
  // are dead code over them; these projections are what reach them.
  const jpBase = stores[0].store.trains.reduce((best, train) =>
    train.stops.length < best.stops.length ||
    (train.stops.length === best.stops.length && train.id < best.id)
      ? train
      : best,
  );
  const project = (mutate) => {
    const copy = clone(jpBase);
    mutate(copy);
    return copy;
  };
  js.setActiveCountry("jp");
  const rideSectionProjections = [
    ["as committed", (t) => t],
    ["no route_sections", (t) => { t.route_sections = []; }],
    ["route_sections absent", (t) => { delete t.route_sections; }],
    ["route_sections not an array", (t) => { t.route_sections = 0; }],
    ["sections reversed", (t) => { t.route_sections.reverse(); }],
    ["sections rotated by one", (t) => { t.route_sections.push(t.route_sections.shift()); }],
    ["first section dropped", (t) => { t.route_sections.shift(); }],
    ["one extra section", (t) => { t.route_sections.push(clone(t.route_sections[0])); }],
    ["stop names cleared", (t) => { t.stops.forEach((s) => { s.name = ""; }); }],
    ["stop codes cleared", (t) => { t.stops.forEach((s) => { s.n02_station_code = null; }); }],
    ["section codes cleared", (t) => {
      t.route_sections.forEach((s) => {
        s.from_n02_station_code = null;
        s.to_n02_station_code = null;
      });
    }],
    ["section names cleared", (t) => {
      t.route_sections.forEach((s) => { delete s.from; delete s.to; });
    }],
    ["one stop only", (t) => { t.stops = [t.stops[0]]; }],
    ["no stops", (t) => { t.stops = []; }],
    ["stops absent", (t) => { delete t.stops; }],
    ["duplicate adjacent stops", (t) => { t.stops.splice(1, 0, clone(t.stops[0])); }],
    ["branch number and name on a section", (t) => {
      t.route_sections[0].number = "3021M";
      t.route_sections[0].name = "こまち";
      t.route_sections[0].line_names = ["田沢湖線"];
      t.route_sections[0].operator_names = ["東日本旅客鉄道"];
    }],
  ].map(([label, mutate]) => {
    const train = project(mutate);
    return {
      label,
      input: bytes(train, 0),
      sections: bytes(js.getRideRouteSectionsForTrain(train), 0),
      // The export shape of the same train, so leanExportSection's
      // conditional from/to keys are pinned as bytes too.
      exported: bytes(js.normalizeExportTrain(train), 2),
    };
  });

  // ---- §17: the CRUD transitions ---------------------------------------
  //
  // Each case restores a store, a selection and a country, replays a SCRIPT
  // of one or more handler calls, and records the whole resulting id list,
  // the selection, and which mutation result each step signalled.
  //
  // A script rather than a label, because a port has to replay it: a case
  // that only says "duplicate(last) twice" is a case the Swift side has to
  // re-derive from prose. Every step names its handler and its argument
  // literally, except where the argument is a train that does not exist yet
  // — `idRef: "last"` is "whatever the store's last train is NOW", which is
  // how "duplicate a train, then duplicate the copy" is expressed.
  //
  // The id list is recorded in full rather than as a digest: an off-by-one in
  // moveTrain is a two-element swap, and a digest turns that into "something
  // changed".
  const crud = [];
  const step = (op, extra = {}) => ({
    op,
    id: null,
    idRef: null,
    direction: 0,
    train: null,
    ...extra,
  });
  const resolveStepId = (j, s) =>
    s.idRef === "last"
      ? (j.getTrainStore().trains[j.getTrainStore().trains.length - 1]?.id ?? null)
      : s.id;
  const perform = (j, s) => {
    switch (s.op) {
      case "add":
        // `addTrain()` with no argument is the only call the app itself
        // makes: the button hands it nothing and it reaches for the blank
        // scaffold.
        return s.train === null ? j.addTrain() : j.addTrain(JSON.parse(s.train));
      case "duplicate":
        return j.duplicateTrain(resolveStepId(j, s));
      case "delete":
        return j.deleteTrain(resolveStepId(j, s));
      case "deleteAll":
        return j.deleteAllTrains();
      case "toggle":
        return j.toggleTrainVisibility(resolveStepId(j, s));
      case "move":
        return j.moveTrain(resolveStepId(j, s), s.direction);
      case "getTrain":
        return j.getTrain(resolveStepId(j, s))?.id ?? null;
      case "getTrainDefault":
        // getTrain() with NO argument, which is not the same call as
        // getTrain(null): a default parameter only fires for undefined, so
        // getTrain(null) looks for a train whose id is null and finds none.
        return j.getTrain()?.id ?? null;
      default:
        throw new Error(`unknown step ${s.op}`);
    }
  };

  const run = ({ label, country, shape, trains, selected, focused, script }) => {
    js.setActiveCountry(country);
    js.setTrainStore({ schema_version: js.constants.SCHEMA_VERSION, trains: clone(trains) });
    js.setSelection(selected, focused);
    js.takeMutation();
    const mutations = [];
    const returned = [];
    const outcome = attempt(() => {
      for (const s of script) {
        returned.push(perform(js, s) ?? null);
        mutations.push(js.takeMutation());
      }
    });
    const after = js.getTrainStore();
    const selection = js.getSelection();
    crud.push({
      label,
      country,
      // Which store the case starts from: "full" is the committed store the
      // port reads for itself, "one" its first train, "none" an empty store,
      // and "synthetic" the hand-built trains recorded alongside. The trains
      // are not repeated per case — 200 copies of a 201-train store would be
      // a fixture nobody reads.
      shape,
      script,
      before: { ids: trains.map((t) => t.id), selected, focused },
      after: {
        schemaVersion: after.schema_version,
        ids: after.trains.map((t) => t.id),
        selected: selection.selected,
        focused: selection.focused,
        // Visibility is the one field a CRUD handler edits in place, so it is
        // the one field worth carrying past the id list. null means the key
        // is absent, which is a third state and not the same as false.
        visible: after.trains.map((t) => t.visible ?? null),
      },
      mutations,
      returned,
      ok: outcome.ok,
      errorName: outcome.ok ? null : outcome.errorName,
      error: outcome.ok ? null : outcome.error,
      // Only the trains a script CREATES are recorded, and by VALUE rather
      // than by bytes. A duplicate is `clone(train)`, which keeps the key
      // order of the file the train was READ from — and 87 of the 201
      // Japanese trains carry a route_policy written before the current
      // writer existed, so their stored order is not the writer's order. That
      // order is not a contract and a typed port cannot hold it; the byte
      // format lives on the EXPORT, where the writer's order is the answer.
      created: after.trains.slice(trains.length).map(stable),
    });
  };

  // Three trains the committed stores cannot supply, in the canonical shape
  // so a typed port can hold them: an EMPTY number (duplicateTrain's
  // `|| "Train"` fallback), an explicit `visible: false` and an ABSENT
  // `visible` (the two sides of `train.visible === false`), and an id whose
  // "-copy" name is already taken (so uniqueId has to count).
  const syntheticStop = (name, code, type) => ({
    name,
    n02_station_code: code,
    arrival: null,
    departure: null,
    stop_type: type,
    ride_segment: true,
  });
  const syntheticTrain = (id, number, extra) => ({
    id,
    number,
    train_type: "",
    company: "",
    origin: "東京",
    destination: "熱海",
    direction: "down",
    ...extra,
    style: { color: "#1d7f8c" },
    route_policy: {
      mode: "single_primary_route",
      jr_only: false,
      allow_alternatives: false,
      allow_browser_straight_line_fallback: false,
      allowed_institution_type_codes: ["1", "2", "3", "4", "5"],
      preferred_line_names: [],
      preferred_operator_names: [],
      institution_filter_mode: "soft",
    },
    route_sections: [],
    stops: [
      syntheticStop("東京", "003770", "origin"),
      syntheticStop("熱海", "005685", "destination"),
    ],
  });
  const syntheticTrains = [
    syntheticTrain("a", "", { visible: false }),
    syntheticTrain("a-copy", "B", {}),
    syntheticTrain("c", "C", { visible: true }),
  ];

  for (const { country, store } of stores) {
    const all = store.trains;
    const first = all[0].id;
    const middle = all[Math.floor(all.length / 2)].id;

    // The shapes that decide the ends of every branch. `one` and `none` are
    // where the JavaScript's `?.id || null` and its Math.min(index, len - 1)
    // actually have something to say.
    const shapes = [
      { name: "full", trains: all },
      { name: "one", trains: [all[0]] },
      { name: "none", trains: [] },
      { name: "synthetic", trains: syntheticTrains },
    ];

    for (const shape of shapes) {
      const ids = shape.trains.map((t) => t.id);
      const anyId = ids[0] ?? null;
      const lastId = ids[ids.length - 1] ?? null;
      const base = {
        country,
        shape: shape.name,
        trains: shape.trains,
        selected: anyId,
        focused: anyId,
      };
      const at = (suffix) => `${country}/${shape.name}: ${suffix}`;
      const one = (label, ...script) => run({ ...base, label: at(label), script });

      one("add(blank)", step("add"));
      one(
        "add(explicit)",
        step("add", { train: bytes(syntheticTrain("IMPORTED 01", "9001M", { visible: true }), 0) }),
      );
      one("add(no id)", step("add", { train: bytes(syntheticTrain("", "x", { visible: true }), 0) }));
      if (anyId) {
        one("duplicate(first)", step("duplicate", { id: anyId }));
        one("duplicate(last)", step("duplicate", { id: lastId }));
        one(
          "duplicate(last) twice",
          step("duplicate", { id: lastId }),
          step("duplicate", { id: lastId }),
        );
        one("delete(first)", step("delete", { id: anyId }));
        one("delete(last)", step("delete", { id: lastId }));
        run({
          ...base,
          label: at("delete(selected, which is last)"),
          selected: lastId,
          focused: lastId,
          script: [step("delete", { id: lastId })],
        });
        run({
          ...base,
          label: at("delete(a train that is not the selection)"),
          selected: lastId,
          focused: lastId,
          script: [step("delete", { id: anyId })],
        });
        one("move(first, -1)", step("move", { id: anyId, direction: -1 }));
        one("move(first, +1)", step("move", { id: anyId, direction: 1 }));
        one("move(last, -1)", step("move", { id: lastId, direction: -1 }));
        one("move(last, +1)", step("move", { id: lastId, direction: 1 }));
        one("move(first, +2)", step("move", { id: anyId, direction: 2 }));
        one("move(first, 0)", step("move", { id: anyId, direction: 0 }));
        one("toggle(first)", step("toggle", { id: anyId }));
        one("toggle(first) twice", step("toggle", { id: anyId }), step("toggle", { id: anyId }));
        one(
          "toggle(first) three times",
          step("toggle", { id: anyId }),
          step("toggle", { id: anyId }),
          step("toggle", { id: anyId }),
        );
        one("getTrain(first)", step("getTrain", { id: anyId }));
      }
      one("duplicate(missing)", step("duplicate", { id: "nope" }));
      one("delete(missing)", step("delete", { id: "nope" }));
      one("move(missing, +1)", step("move", { id: "nope", direction: 1 }));
      one("toggle(missing)", step("toggle", { id: "nope" }));
      one("deleteAll", step("deleteAll"));
      one("add(blank) then deleteAll", step("add"), step("deleteAll"));
      one("getTrain(default = selection)", step("getTrainDefault"));
      one("getTrain(missing)", step("getTrain", { id: "nope" }));
      // getTrain(null) is not getTrain(): the default parameter only fires
      // for undefined, so this searches for a train whose id is null.
      one("getTrain(null)", step("getTrain", { id: null }));
    }

    // Order-sensitive cases on the whole store, where a middle element has
    // neighbours on both sides.
    const base = { country, shape: "full", trains: all, selected: middle, focused: middle };
    const full = (label, ...script) => run({ ...base, label: `${country}/full: ${label}`, script });
    full("move(middle, -1)", step("move", { id: middle, direction: -1 }));
    full("move(middle, +1)", step("move", { id: middle, direction: 1 }));
    full("delete(middle)", step("delete", { id: middle }));
    full("add(a train whose id already exists)", step("add", { train: bytes(all[0], 0) }));
    full(
      "duplicate(first) then duplicate the copy",
      step("duplicate", { id: first }),
      step("duplicate", { idRef: "last" }),
    );
    full(
      "delete every train, one at a time",
      ...all.map((train) => step("delete", { id: train.id })),
    );
    full(
      "move the first train all the way to the end",
      ...all.slice(1).map(() => step("move", { id: first, direction: 1 })),
    );

    // The synthetic store's own point: an id whose "-copy" name is already
    // taken, an empty number, and both spellings of "not hidden".
    const synth = {
      country,
      shape: "synthetic",
      trains: syntheticTrains,
      selected: "a",
      focused: "a",
    };
    const syn = (label, ...script) =>
      run({ ...synth, label: `${country}/synthetic: ${label}`, script });
    syn('duplicate(a) — "a-copy" is taken and the number is empty', step("duplicate", { id: "a" }));
    syn(
      "duplicate(a) twice",
      step("duplicate", { id: "a" }),
      step("duplicate", { id: "a" }),
    );
    syn(
      "toggle every train once",
      ...syntheticTrains.map((t) => step("toggle", { id: t.id })),
    );
    syn(
      "toggle every train twice",
      ...syntheticTrains.flatMap((t) => [step("toggle", { id: t.id }), step("toggle", { id: t.id })]),
    );
    run({
      ...synth,
      label: `${country}/synthetic: delete(a) with the selection on the middle train`,
      selected: "a-copy",
      focused: "a-copy",
      script: [step("delete", { id: "a" })],
    });
  }

  // ---- §20: uniqueId, the interactive seed cleaner ----------------------
  // uniqueId is NOT makeUniqueTrainId: it trims, then collapses every run of
  // JavaScript whitespace to a single "-", and only then delegates. The
  // whitespace class is ECMAScript's `\s`, which includes U+00A0, U+FEFF and
  // U+3000 — all reachable from a pasted station name — and excludes U+0085,
  // which a Foundation-based port would include.
  const uniqueIds = [];
  const uniqueIdSeeds = [
    "LE",
    "",
    null,
    "   ",
    "  LE  ",
    "a b",
    "a  b   c",
    "a\tb",
    "a\nb",
    "a b",
    "a　b",
    "a b",
    "﻿a",
    "ab",
    "LE-copy",
    "東京 発",
    "  ",
    "-",
  ];
  for (const existing of [[], ["LE"], ["LE", "LE-2"], ["a-b"], ["train"]])
    for (const seed of uniqueIdSeeds) {
      js.setTrainStore({
        schema_version: js.constants.SCHEMA_VERSION,
        trains: existing.map((id) => ({ id })),
      });
      uniqueIds.push({ seed, existing, result: js.uniqueId(seed) });
    }

  // ---- §19: appendImportedTrain ----------------------------------------
  // The import path's one-train front door: normalise, rename on collision,
  // validate the incoming train ONLY (not the whole store — that was an O(N²)
  // pass), then push. Note that what lands in the store is the IMPORTED
  // normalisation, not the export one: its route_sections keep the empty
  // line_names/operator_names arrays that leanExportSection would drop.
  const appendCases = [];
  const goodTrain = {
    id: "20260101_01_demo",
    number: "1M",
    train_type: "特急",
    company: "東日本旅客鉄道",
    origin: "東京",
    destination: "熱海",
    stops: [
      { name: "東京", n02_station_code: "003770", stop_type: "origin", ride_segment: true },
      { name: "熱海", n02_station_code: "005685", stop_type: "destination", ride_segment: true },
    ],
  };
  const appendInputs = [
    ["a minimal valid train", goodTrain, null],
    ["the same train twice", goodTrain, null, { repeat: 2 }],
    ["the same train three times", goodTrain, null, { repeat: 3 }],
    ["an undated train with a fallback date", { ...clone(goodTrain), id: "demo" }, "2026-05-04"],
    ["an undated train with no fallback", { ...clone(goodTrain), id: "demo" }, null],
    ["an id that collides with the store", null, null, { useFirstStoreId: true }],
    ["an id that needs cleaning", { ...clone(goodTrain), id: "has space" }, null],
    ["a colour that is rejected", { ...clone(goodTrain), style: { color: "red" } }, null],
    ["an unsupported field", { ...clone(goodTrain), speed: 320 }, null],
    ["one stop", { ...clone(goodTrain), stops: [{ name: "東京" }] }, null],
    ["no number", { ...clone(goodTrain), number: "" }, null],
    ["a stop_type that is rejected", {
      ...clone(goodTrain),
      stops: [
        { name: "東京", stop_type: "boarding" },
        { name: "熱海", stop_type: "destination" },
      ],
    }, null],
    ["route_sections carried through", {
      ...clone(goodTrain),
      route_sections: [
        {
          from: "東京",
          to: "熱海",
          from_n02_station_code: "003770",
          to_n02_station_code: "005685",
          line_names: ["東海道線"],
        },
      ],
    }, null],
  ];
  for (const { country, store } of stores) {
    js.setActiveCountry(country);
    for (const [label, input, fallbackDate, options = {}] of appendInputs) {
      js.setTrainStore(clone(store));
      const raw = options.useFirstStoreId
        ? { ...clone(goodTrain), id: store.trains[0].id }
        : input;
      const repeat = options.repeat ?? 1;
      const returned = [];
      const outcome = attempt(() => {
        for (let i = 0; i < repeat; i += 1)
          returned.push(js.appendImportedTrain(clone(raw), fallbackDate));
        return returned;
      });
      const after = js.getTrainStore();
      appendCases.push({
        label,
        country,
        input: bytes(raw, 0),
        fallbackDate,
        repeat,
        ok: outcome.ok,
        errorName: outcome.ok ? null : outcome.errorName,
        error: outcome.ok ? null : outcome.error,
        returnedIds: returned,
        appendedCount: after.trains.length - store.trains.length,
        // Whole, because this is the shape that lands in the store and the
        // import normalisation is not the export normalisation.
        appended: after.trains
          .slice(store.trains.length)
          .map((train) => bytes(train, 2)),
      });
    }
  }

  // currentImportFallbackDate: the one line of §19 that reads the date
  // selector. "全部" has no concrete date, so it yields null and lets
  // id inference decide.
  const fallbackDates = [
    js.constants.ALL_DATES,
    "2026-08-21",
    "",
    null,
    js.constants.UNDATED,
  ].map((selectedDate) => {
    js.setSelectedDate(selectedDate);
    return { selectedDate, result: js.currentImportFallbackDate() };
  });
  js.setSelectedDate(js.constants.ALL_DATES);

  return {
    describes:
      "app-store-ops.js §17–§20: the train CRUD handlers, the canonical " +
      "export as a byte format, the import append path and the blank-train " +
      "factory, over both committed itinerary stores",
    contract:
      "This is the write side of the store, and its output is an archive " +
      "format rather than a screenful. exportTrainStore() is " +
      "JSON.stringify(store, null, 2), so KEY ORDER, indentation and string " +
      "escaping are part of the answer: normalizeExportTrain's 13 fields, " +
      "canonicalRoutePolicy's 8 and leanExportSection's conditional from/to " +
      "are a spelling, not a set. A port whose encoder emits keys in another " +
      "order writes a file that diffs against the archive on every save even " +
      "when every value agrees — which is why the port needs its own " +
      "serialiser and not Codable. Two committed facts to keep in view: " +
      "train-store.json is exactly JSON.stringify(parsed, null, 2) plus a " +
      "trailing newline, while train-store-tw.json is minified with none, so " +
      "the same operation cannot equal both files and the port has to spell " +
      "both forms; and the export is NOT a fixed point over the Japanese " +
      "archive — 87 of its 201 trains come back with a differently written " +
      "route_policy, 41 by key order and 46 because the two preferred_* " +
      "arrays did not exist when they were saved. The CRUD handlers are a " +
      "state transition on (trains, selectedTrainId, focusedTrainId) plus a " +
      "named mutation result, and every one of them returns early — with NO " +
      "mutation result — when its target is missing or its move would leave " +
      "the list, which is a different answer from 'it ran and changed " +
      "nothing'. deleteTrain then re-selects trains[min(index, length - 1)], " +
      "which is null when the store empties and the PREVIOUS train when the " +
      "last one goes.",
    constants: js.constants,
    cases: crud,
    // The `shape: "synthetic"` cases' starting store, once.
    syntheticTrains: bytes({ schema_version: "1.3", trains: syntheticTrains }, 0),
    blankTrains,
    exports: exports_,
    stringifyCases,
    rideSections,
    rideSectionProjections,
    uniqueIds,
    appendCases,
    fallbackDates,
  };
}
