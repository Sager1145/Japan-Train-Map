// =========================================================================
//  port-fixtures/import.mjs — freeze what the import engine DOES, in order
//
//  app-import.js §16 is the only way data gets into this app. Every store the
//  archive contains, every pasted export, every agent import and every boot
//  goes through it, and what it produces is not a value but a SEQUENCE: the
//  store is built one train at a time, each train draws before the next is
//  fetched, and the progress callback fires between them. A fixture that
//  recorded only the final store would pass a port that appended in reverse,
//  reported progress before appending, or emitted its "done" bar before the
//  last train — all of which are visibly wrong on screen and none of which
//  change the answer at the end.
//
//  So every case below records the ordered event stream, and the port has to
//  reproduce it element for element.
//
//  ── the two front doors, in the order the engine opens them ─────────────
//  appendImportedTrain is where the asymmetry validation.json documents
//  actually bites, because it runs BOTH doors, in this order:
//
//      normalizeImportedTrain(raw)      §19 — key whitelist, canonical shape
//      makeUniqueTrainId(train.id, …)   §3.2 — collisions are renamed
//      validateTrain(normalizeExportTrain(train), …)   §33 — the schema
//
//  That composition is not the union of the two doors' rules, and it is not
//  either one of them:
//
//    * the key whitelist DOES apply (door 1), though validateTrain has none;
//    * a numeric train_type is coerced to "" by door 1, so door 2 never sees
//      the number it would have rejected — the import path accepts what the
//      validator refuses;
//    * TRAIN_ID_PATTERN DOES apply (door 2), though door 1 never checks it —
//      but it is applied to the id AFTER makeUniqueTrainId has trimmed it,
//      so " odr_001 " imports as "odr_001" where validateTrain alone rejects
//      it, and a colliding "odr_001" imports as "odr_001-2";
//    * a null row in `stops` or `route_sections` — the three inputs that
//      CRASH validateTrain with a TypeError rather than rejecting them — is
//      converted to a clean Error by door 1 before door 2 can trip over it.
//      Through this front door the crash is unreachable. The cases are here
//      anyway, recording `errorName: "Error"`, because "unreachable" is a
//      property of the composition that a port can silently lose.
//
//  ── how the JavaScript is run ──────────────────────────────────────────
//  Not by copying it. app-import.js is a classic script in a family sharing
//  one global lexical scope, and it reads ~40 names its siblings declare, so
//  the only faithful way to run it is to replay the whole family — which is
//  what scripts/lib/app-family-sandbox.mjs already does for the precompute
//  exporter and the smoke tests. This module reuses that harness unchanged.
//
//  Inside it, the shell is replaced by RECORDERS rather than by silence: the
//  DOM/map/persistence entry points the engine calls (renderAll,
//  appendTrainToLayers, appendTrainListItemIncremental, setImportProgress,
//  setStatus, and the journal write behind PersistenceService.scheduleSave)
//  become functions that append to the event log and do nothing else. The
//  stub IS the observation point, so the boundary the Swift port draws is
//  the same line the fixture measures across.
//
//  Two things are deliberately NOT recorded, because they are wall-clock
//  dependent and pinning them would make the fixture fail on a slow machine:
//  the frame-budget yields (waitForImportPaint) and the renderProgressiveCounts
//  that rides on them. The engine's contract is the ORDER of its effects, not
//  how many frames it took.
//
//  ── the station index is empty, deliberately ───────────────────────────
//  appendImportedTrain reaches the station table through normalizeExportTrain.
//  With no datasets fetched it answers "" / unresolved, which is the real
//  state the app imports in before app-datasets.js has finished — the same
//  state validation.json pins, so the two fixtures agree about the shared
//  export path instead of disagreeing about which table was installed.
// =========================================================================

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  evaluateAppScripts,
  makeSandbox,
} from "../../lib/app-family-sandbox.mjs";

export const name = "import.json";

// The generator hands `build` an APP_DIR, but `build` is called
// SYNCHRONOUSLY and every entry point here is async — the engine's whole
// shape is "append, yield a frame, append". So the work happens at module
// top level (which `await import()` does await) and `build` just returns it.
// That means resolving APP_DIR from this file's own location instead.
const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── the sandbox ─────────────────────────────────────────────────────────

const context = makeSandbox({
  userAgent: "port-fixture-import",
  fetchErrorMessage: "fetch is not available in the import fixture sandbox",
});
// The engine warns about parts it skipped and route warm-ups that failed.
// Both are expected here; keep the generator's own output readable.
const quietConsole = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
context.console = quietConsole;
// Every timer the replayed app sets, so the generator's process can exit.
// The autosave debounce (450 ms) outlives a short case, and a pending timer
// keeps Node alive forever — which would hang `verify.sh` rather than fail it.
const timers = new Set();
const hostSetTimeout = setTimeout;
context.setTimeout = (fn, ms, ...rest) => {
  const handle = hostSetTimeout(fn, ms, ...rest);
  timers.add(handle);
  return handle;
};
evaluateAppScripts(context);

const run = (expr) => vm.runInContext(expr, context);

// An EMPTY station index, not a missing one — see the header.
run("stationCandidatesIndex = new Map();");

// ── recorders ───────────────────────────────────────────────────────────
//
// Every shell entry point §16 calls becomes an event. `renderAll` has four
// call sites with four different reasons (reset, the append loop's optional
// final repaint, finalize's authoritative one, and the append-mode rollback),
// and the whole `finalRender: false` optimisation is an assertion about which
// of them run and in what order, so it is recorded rather than silenced.
//
// `PersistenceService` is frozen, so `scheduleSave` cannot be wrapped. It is
// `saveTrainStore`, whose first unconditional act (HAS_BACKEND is true in
// this sandbox) is `schedulePendingServerStoreJournal()` — a plain function
// declaration, and therefore an exact marker for every scheduleSave that gets
// past the recovery/sample guards. `flushServerStoreSave` is neutralised so
// the debounced timer behind it can never reach the network.
context.__events = [];
run(`
  setImportProgress = (count, total, label) =>
    __events.push({ e: "bar", count, total, label: String(label) });
  setStatus = (element, message, tone) =>
    __events.push({ e: "status", label: String(message), tone: tone === undefined ? null : tone });
  renderAll = () => __events.push({ e: "render" });
  renderProgressiveCounts = () => {};
  appendTrainToLayers = (train) => __events.push({ e: "draw", id: train && train.id });
  appendTrainListItemIncremental = (train) => __events.push({ e: "listItem", id: train && train.id });
  warmRouteCacheForTrain = async (train) => { __events.push({ e: "warm", id: train && train.id }); };
  schedulePendingServerStoreJournal = () => __events.push({ e: "persist" });
  flushServerStoreSave = async () => {};
  // Pure DOM, top to bottom, and the only thing loadSampleData wants from it
  // is a side effect this fixture reads off dataSourceMode instead.
  updateDataSourceUi = () => {};
  setImportFinishedListener(() => __events.push({ e: "finished" }));
`);

// ── serialisation ───────────────────────────────────────────────────────
//
// Inputs keep their own key order (assertOnlyKeys throws on the FIRST
// offending key, so the order decides which key an error names). Outputs are
// canonicalised with keys sorted by UTF-16 code unit, because Swift's Codable
// emits no defined order and only a canonical spelling compares as a value.
// Both rules are validation.mjs's, restated rather than shared: these files
// are owned by different ports and a shared helper is a shared file.
function stableStringify(value) {
  // JSON has no `undefined`, and JSON.stringify answers with the JS value
  // `undefined` rather than with text — which would splice a bare `undefined`
  // into the output and make the whole fixture unparseable. The generator
  // only ever hands one in for "this part does not exist", and `null` is the
  // only spelling JSON has for that.
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

const readStore = (file) =>
  JSON.parse(fs.readFileSync(path.join(APP_DIR, "data", file), "utf8"));

const stores = {
  jp: readStore("train-store.json"),
  tw: readStore("train-store-tw.json"),
};

// ── driving one case ────────────────────────────────────────────────────

/**
 * Put the engine's mutable globals into a known state.
 *
 * `existing` is assigned straight into trainStore rather than imported,
 * because "a store that is already loaded" is the precondition — routing it
 * through appendImportedTrain would make the precondition depend on the very
 * function under test.
 */
function reset({ country = "jp", selectedDate = "__all__", existing = [] } = {}) {
  context.__existing = clone(existing);
  run(`
    activeCountry = ${JSON.stringify(country)};
    trainStore = { schema_version: SCHEMA_VERSION, trains: __existing };
    selectedTrainId = null;
    focusedTrainId = null;
    selectedDate = ${JSON.stringify(selectedDate)};
    importInProgress = false;
    storeRecoveryMode = false;
    dataSourceMode = "user";
    storeSaveDirty = false;
    clearTimeout(serverStoreSaveTimer);
    serverStoreSaveTimer = null;
    clearTimeout(_appendRenderTimer);
    _appendRenderTimer = null;
    __events.length = 0;
  `);
}

/** The engine state a case is judged on, after it has run. */
function readState() {
  return JSON.parse(
    run(`JSON.stringify({
      trainIds: trainStore.trains.map((t) => t.id),
      selectedTrainId,
      focusedTrainId,
      selectedDate,
      importInProgress,
      storeRecoveryMode,
    })`),
  );
}

/**
 * Run one expression inside the sandbox, recording either its JSON value or
 * the throw — validation.mjs's `attempt`, adapted for an async call whose
 * result has to cross the vm boundary.
 *
 * The expression is evaluated ONCE, which matters because every one of these
 * mutates the store.
 */
async function call(expression) {
  context.__result = null;
  const outcome = JSON.parse(
    await run(`(async () => {
      try {
        __result = await (${expression});
        return JSON.stringify({ ok: true });
      } catch (error) {
        return JSON.stringify({ ok: false, errorName: error.name, error: error.message });
      }
    })()`),
  );
  return {
    ...outcome,
    returned: context.__result === undefined ? null : clone(context.__result),
  };
}

const runCases = [];

// Which entry point a case drives. Named rather than spelled as a JS
// expression so the port can dispatch on the name instead of parsing the
// call — the options object goes into the fixture as data for the same
// reason. `call` is still recorded, but only as documentation.
const DOORS = {
  text: ({ document, options }) =>
    `replaceTrainStoreFromJsonText(${document}, "SRC")`,
  store: ({ document, options }) =>
    `replaceTrainStoreFromStoreProgressive(${document}, "SRC", ${options})`,
  append: ({ document, recordProgress }) =>
    `importCanonicalStoreAppendProgressive(${document}${
      recordProgress ? ', (p) => __events.push({ e: "progress", ...p })' : ""
    })`,
  parts: ({ options }) =>
    `replaceTrainStoreFromPartsProgressive({ parts: __names, parts_api: "sample-data" }, "SRC", ${options})`,
};

/**
 * One whole progressive run: precondition, the entry point, the ordered event
 * stream it produced, and the state it left behind.
 *
 * `rawText` hands the text door a literal string instead of the serialised
 * document, which is the only way to reach its JSON.parse failure. `nullDocument`
 * passes a literal null, which is what the "no store at all" caller does.
 */
async function addRun(label, {
  door,
  options = {},
  country,
  selectedDate,
  existing,
  input,
  rawText,
  nullDocument = false,
  recordProgress = false,
  storeFile,
  parts,
  note,
}) {
  const document = nullDocument
    ? "null"
    : rawText !== undefined
      ? JSON.stringify(rawText)
      : door === "text"
        ? "JSON.stringify(__input)"
        : "__input";
  const expression = DOORS[door]({
    document,
    options: JSON.stringify(options),
    recordProgress,
  });
  reset({ country, selectedDate, existing });
  if (input !== undefined) context.__input = clone(input);
  // A parts run needs the network under it. `parts` maps a part NAME to the
  // body its request answers with; a name that is absent 404s on both tries
  // and is skipped, which is the case the "warn" status tone exists for.
  if (parts) {
    context.__names = Object.keys(parts);
    context.fetch = async (url) => {
      const key = url.split("/").pop();
      if (!(key in parts) || parts[key] === undefined)
        return { ok: false, status: 404, statusText: "Not Found" };
      return { ok: true, json: async () => clone(parts[key]) };
    };
  }
  const outcome = await call(expression);
  const state = readState();
  runCases.push({
    label,
    ...(note ? { note } : {}),
    door,
    options,
    ...(rawText === undefined ? {} : { rawText }),
    ...(nullDocument ? { nullDocument: true } : {}),
    ...(recordProgress ? { recordProgress: true } : {}),
    country: country || "jp",
    selectedDate: selectedDate === undefined ? "__all__" : selectedDate,
    existing: JSON.stringify(existing || []),
    // A committed store is named, not repeated: the port reads the same file
    // this generator did, so the two cannot drift apart the way a copy can.
    ...(storeFile ? { storeFile } : {}),
    ...(input === undefined || storeFile ? {} : { input: JSON.stringify(input) }),
    ...(parts ? { parts: stableStringify(parts) } : {}),
    call: expression.replace(/\s+/g, " ").trim(),
    events: clone(context.__events),
    ...(outcome.ok
      ? { ok: true, returned: stableStringify(outcome.returned) }
      : { ok: false, errorName: outcome.errorName, error: outcome.error }),
    state,
  });
  // The autosave debounce must not outlive the case that armed it.
  run("clearTimeout(serverStoreSaveTimer); serverStoreSaveTimer = null; storeSaveDirty = false;");
}

// ── the runs ────────────────────────────────────────────────────────────

const lean = {
  id: "lean_001",
  number: "1M",
  origin: "東京",
  destination: "品川",
  stops: [
    { name: "東京", departure: "08:00", ride_segment: true },
    { name: "品川", arrival: "08:08" },
  ],
};
const withLean = (extra) => ({ ...lean, ...extra });
const leanStore = (trains) => ({ schema_version: "1.3", trains });

// Both committed stores, whole, through both replace doors. Not a sample:
// the sequence is the product, and an off-by-one in it is invisible in three
// trains and glaring in two hundred.
await addRun("the committed jp store, replaced from a parsed value", {
  country: "jp",
  input: stores.jp,
  storeFile: "train-store.json",
  door: "store",
  options: { showAllDates: true, selectFirstTrain: false, persistEachStep: false, finalPersist: false },
});
await addRun("the committed tw store, replaced from a parsed value", {
  country: "tw",
  input: stores.tw,
  storeFile: "train-store-tw.json",
  door: "store",
  options: { showAllDates: true, selectFirstTrain: false, persistEachStep: false, finalPersist: false },
});
await addRun("the committed jp store, replaced from JSON text", {
  country: "jp",
  input: stores.jp,
  storeFile: "train-store.json",
  door: "text",
  note:
    "the text door differs from the value door in three ways at once: it " +
    "always persists each step, its final bar counts `total` rather than the " +
    "trains that actually appended, and its status line comes BEFORE that bar " +
    "instead of after.",
});
await addRun("the committed tw store, appended over an empty store", {
  country: "tw",
  input: stores.tw,
  storeFile: "train-store-tw.json",
  door: "append",
  recordProgress: true,
});

// ---- single trains ------------------------------------------------------
await addRun("a single train object as the whole document", {
  input: lean,
  door: "store",
  note: "parseImportedCanonicalStore's third branch: `parsed.id && parsed.stops`.",
});
await addRun("a single train object as JSON text", {
  input: lean,
  door: "text",
});
await addRun("a bare trains array", {
  input: [lean, { ...lean, id: "lean_002" }],
  door: "store",
  note: "an array is wrapped, and the whitelist never runs on it.",
});
await addRun("a store with exactly one train", {
  input: leanStore([lean]),
  door: "store",
});

// ---- empty documents: three doors, three different answers --------------
await addRun("an empty store, replaced from a parsed value", {
  input: leanStore([]),
  door: "store",
  options: { showAllDates: true },
  note:
    "an empty store is still a REPLACEMENT — it resets and finalises with " +
    "selectFirstTrain forced false, and emits NEITHER a prepare bar nor a " +
    "done bar. The other two doors throw on the same document.",
});
await addRun("an empty store, replaced from JSON text", {
  input: leanStore([]),
  door: "text",
  note: "throws, and the message interpolates the caller's source label.",
});
await addRun("an empty store, appended", {
  input: leanStore([]),
  door: "append",
  recordProgress: true,
  note: "throws a DIFFERENT message from the text door, with no label in it.",
});
await addRun("an empty array as the document", {
  input: [],
  door: "store",
});
await addRun("no document at all", {
  door: "store",
  nullDocument: true,
  note:
    "THROWS, and the comment above the code says it should not. `store || " +
    "{ trains: [] }` synthesises a store with an array `trains` and therefore " +
    "takes the STORE branch of parseImportedCanonicalStore — where the " +
    "synthesised object has no schema_version and is rejected. The empty-store " +
    "path the fallback exists to reach can only be reached by passing an " +
    "object that already carries schema_version, so a null store aborts the " +
    "replacement instead of clearing the screen.",
});

// ---- malformed and unknown-shaped documents -----------------------------
await addRun("malformed JSON text", {
  door: "text",
  rawText: "{not json",
  note: "the message is V8's own JSON.parse text and is not a contract; only the kind is.",
});
await addRun("JSON text that is not an object", {
  door: "text",
  rawText: "42",
});
await addRun("a document with an unknown top-level key", {
  input: { schema_version: "1.3", trains: [lean], nickname: "mine" },
  door: "store",
  note: "the store whitelist runs only because `trains` is an array.",
});
await addRun("a document with an unknown top-level key and no trains array", {
  input: { id: "lean_001", stops: lean.stops, number: "1M", origin: "東京", destination: "品川", trains: "no" },
  door: "store",
  note:
    "`trains` is consulted only through Array.isArray, so this falls through " +
    "to the single-train branch, the STORE whitelist never runs — and the " +
    "TRAIN whitelist then rejects the same key from the other door.",
});
await addRun("a document with an unsupported schema_version", {
  input: { schema_version: "9.9", trains: [lean] },
  door: "store",
});

// ---- duplicate ids ------------------------------------------------------
await addRun("two trains sharing an id in one document", {
  input: leanStore([lean, clone(lean)]),
  door: "store",
  note:
    "ACCEPTED, and the second is renamed to lean_001-2. validateTrainStore " +
    "would reject this exact document outright; the import engine never asks " +
    "it — makeUniqueTrainId renames first, and the authoritative " +
    "validateTrainStore in finalizeProgressiveLoad then sees no duplicate.",
});
await addRun("three trains sharing an id", {
  input: leanStore([lean, clone(lean), clone(lean)]),
  door: "store",
});
await addRun("a train whose id collides with one already in the store", {
  existing: [
    {
      id: "lean_001",
      date: "2026-08-01",
      number: "9M",
      train_type: "",
      company: "",
      origin: "東京",
      destination: "品川",
      direction: "down",
      visible: true,
      style: { color: "#d9364f" },
      route_policy: {},
      route_sections: [],
      stops: [
        { name: "東京", n02_station_code: null, arrival: null, departure: "07:00", stop_type: "origin", ride_segment: true },
        { name: "品川", n02_station_code: null, arrival: "07:08", departure: null, stop_type: "destination", ride_segment: false },
      ],
    },
  ],
  input: leanStore([lean]),
  door: "append",
  recordProgress: true,
  note: "append mode does NOT reset, so the collision is against a live store.",
});
await addRun("a colliding id that also occupies the -2 slot", {
  existing: [
    { id: "lean_001", date: "2026-08-01", number: "9M", train_type: "", company: "", origin: "東京", destination: "品川", direction: "down", visible: true, style: { color: "#d9364f" }, route_policy: {}, route_sections: [], stops: [{ name: "東京", n02_station_code: null, arrival: null, departure: "07:00", stop_type: "origin", ride_segment: true }, { name: "品川", n02_station_code: null, arrival: "07:08", departure: null, stop_type: "destination", ride_segment: false }] },
    { id: "lean_001-2", date: "2026-08-01", number: "9M", train_type: "", company: "", origin: "東京", destination: "品川", direction: "down", visible: true, style: { color: "#d9364f" }, route_policy: {}, route_sections: [], stops: [{ name: "東京", n02_station_code: null, arrival: null, departure: "07:00", stop_type: "origin", ride_segment: true }, { name: "品川", n02_station_code: null, arrival: "07:08", departure: null, stop_type: "destination", ride_segment: false }] },
  ],
  input: leanStore([lean]),
  door: "append",
  recordProgress: true,
});

// ---- a document that fails PART WAY through -----------------------------
// The rollback contract, and the reason it exists: appendImportedTrain pushes
// each valid train before an invalid one throws.
const failingStore = leanStore([
  { ...lean, id: "good_001" },
  { ...lean, id: "good_002" },
  { ...lean, id: "bad_003", stops: [{ name: "東京" }] },
  { ...lean, id: "good_004" },
]);
await addRun("append mode rolls the store back when a train fails", {
  input: failingStore,
  door: "append",
  recordProgress: true,
  note:
    "the two valid trains that already appended are truncated away, one extra " +
    "renderAll fires for the rollback, and the error is rethrown.",
});
await addRun("append mode rolls back to the trains that were already there", {
  existing: [
    { id: "prior_001", date: "2026-08-01", number: "9M", train_type: "", company: "", origin: "東京", destination: "品川", direction: "down", visible: true, style: { color: "#d9364f" }, route_policy: {}, route_sections: [], stops: [{ name: "東京", n02_station_code: null, arrival: null, departure: "07:00", stop_type: "origin", ride_segment: true }, { name: "品川", n02_station_code: null, arrival: "07:08", departure: null, stop_type: "destination", ride_segment: false }] },
  ],
  input: failingStore,
  door: "append",
  recordProgress: true,
});
await addRun("a replace path does NOT roll back when a train fails", {
  input: failingStore,
  door: "store",
  note:
    "the half-appended prefix survives in the store and the error propagates. " +
    "Only append mode has the rollback; the replace paths leave the store in " +
    "the state the failure found it.",
});
await addRun("the failing train is the first one", {
  input: leanStore([{ ...lean, id: "bad_001", stops: [{ name: "東京" }] }, { ...lean, id: "good_002" }]),
  door: "append",
  recordProgress: true,
});

// ---- the third replace door: published per-train parts -------------------
await addRun("three published parts", {
  parts: {
    "part-000": { format: 1, train: { ...lean, id: "p_000" } },
    "part-001": { format: 1, train: { ...lean, id: "p_001" } },
    "part-002": { format: 1, train: { ...lean, id: "p_002" } },
  },
  door: "parts",
  options: { showAllDates: true, selectFirstTrain: false },
});
await addRun("a published part that cannot be fetched is skipped", {
  parts: {
    "part-000": { format: 1, train: { ...lean, id: "p_000" } },
    "part-001": undefined,
    "part-002": { format: 1, train: { ...lean, id: "p_002" } },
  },
  door: "parts",
  note:
    "the skipped part costs NO events at all — no progress bar tick, nothing " +
    "— so `count` and `index` come apart, the final bar reports the trains " +
    "that actually arrived rather than the total, and the status tone turns " +
    "warn. This is the one door whose done-bar count is not `total`.",
});
await addRun("a published part with an unexpected shape is skipped", {
  parts: {
    "part-000": { format: 2, train: { ...lean, id: "p_000" } },
    "part-001": { format: 1, train: { ...lean, id: "p_001" } },
  },
  door: "parts",
});
await addRun("every published part fails", {
  parts: { "part-000": undefined, "part-001": undefined },
  door: "parts",
  note:
    "unlike the two store doors, this one does not treat 'nothing loaded' as " +
    "an error — it finalises an empty store and reports 0.",
});

// ---- the fallback date (§3.1/§3.2) --------------------------------------
await addRun("an undated train appended while a single date is selected", {
  selectedDate: "2026-08-05",
  input: leanStore([lean]),
  door: "append",
  recordProgress: true,
  note: "append mode passes currentImportFallbackDate(); the replace paths pass null.",
});
await addRun("an undated train appended while 全部 is selected", {
  selectedDate: "__all__",
  input: leanStore([lean]),
  door: "append",
  recordProgress: true,
  note: "ALL_DATES is not a date: the fallback is null and the id decides.",
});
await addRun("an undated train replaced while a single date is selected", {
  selectedDate: "2026-08-05",
  input: leanStore([lean]),
  door: "store",
  note: "the replace paths never pass a fallback, so the same train lands undated.",
});
await addRun("a train whose id spells its date, appended under a fallback", {
  selectedDate: "2026-08-05",
  input: leanStore([withLean({ id: "20260703_lean" })]),
  door: "append",
  recordProgress: true,
});

// ---- the selection policy after a replace -------------------------------
for (const options of [
  {},
  { selectFirstTrain: false },
  { showAllDates: true },
  { showAllDates: true, selectFirstTrain: false },
  { selectFirstTrain: true, showAllDates: false },
]) {
  await addRun(`selection policy ${JSON.stringify(options)}`, {
    selectedDate: "1999-01-01",
    input: leanStore([withLean({ id: "a_001", date: "2026-07-03" }), withLean({ id: "b_002", date: "2026-07-01" })]),
    door: "store",
    options,
    note:
      "reconcileSelectedDate runs after the append, so a selection the new " +
      "store cannot render drops to the EARLIEST available date — not the " +
      "first one appended.",
  });
}

// ---- re-entrancy --------------------------------------------------------
// Driven outside addRun because the precondition is the one thing addRun
// always clears: importInProgress has to be left SET going in.
for (const [door, label, expression] of [
  ["text", "replaceTrainStoreFromJsonText", 'replaceTrainStoreFromJsonText(JSON.stringify(__input), "SRC")'],
  ["store", "replaceTrainStoreFromStoreProgressive", 'replaceTrainStoreFromStoreProgressive(__input, "SRC", {})'],
  ["append", "importCanonicalStoreAppendProgressive", "importCanonicalStoreAppendProgressive(__input)"],
]) {
  reset({});
  context.__input = clone(leanStore([lean]));
  run("importInProgress = true;");
  const outcome = await call(expression);
  runCases.push({
    label: `${label} while an import is already running`,
    note:
      "the guard returns early WITHOUT clearing importInProgress and WITHOUT " +
      "announcing importFinished — the run that owns the flag still owns it. " +
      "The text door returns undefined where the other two return a count.",
    door,
    options: {},
    importAlreadyRunning: true,
    country: "jp",
    selectedDate: "__all__",
    existing: "[]",
    input: JSON.stringify(leanStore([lean])),
    call: expression.replace(/\s+/g, " ").trim(),
    events: clone(context.__events),
    ...(outcome.ok
      ? { ok: true, returned: stableStringify(outcome.returned) }
      : { ok: false, errorName: outcome.errorName, error: outcome.error }),
    state: readState(),
  });
}

// ---- shapes the Train port recorded as "accepted but arguably not" ------
//
// Each of these validates today, and each is reachable from a hand-written or
// machine-generated file. They are here because the composition is what
// decides them, and it decides some of them differently from either door on
// its own.
const acceptedButArguablyNot = [
  [
    "a stop whose name is a number",
    withLean({ stops: [{ name: 12, departure: "08:00" }, { name: "品川" }] }),
    "stopName returns the raw value as a truthiness test, and canonicalStopShape " +
      "then spells it with String() — so the validator only ever sees \"12\".",
  ],
  [
    "ride_segment is the string \"false\"",
    withLean({ stops: [{ name: "東京", ride_segment: "false" }, { name: "品川" }] }),
    "a non-empty string is truthy, so this RIDES the segment it says it does not.",
  ],
  [
    "route_sections is the number 0",
    withLean({ route_sections: 0 }),
    "validateTrain skips a falsy-but-present route_sections entirely; the " +
      "import path does not skip it, it REPLACES it with [] — so the two " +
      "doors disagree about what the train even contains.",
  ],
  [
    "route_policy is the number 0",
    withLean({ route_policy: 0 }),
    "same falsy-skip in the validator, same replacement with the canonical " +
      "defaults on import.",
  ],
  [
    "line_names is null",
    withLean({ route_sections: [{ from: "東京", to: "品川", line_names: null }] }),
    "`x || []` turns a null array into an empty one.",
  ],
  [
    "a four-digit station code that is a number",
    withLean({ stops: [{ name: "東京", n02_station_code: 3770 }, { name: "品川" }] }),
    "rejected — but on its LENGTH, not its type: the grammar wants six " +
      "digits, and 3770 spells four of them.",
  ],
  [
    "a six-digit station code that is a number",
    withLean({ stops: [{ name: "東京", n02_station_code: 123456 }, { name: "品川" }] }),
    "ACCEPTED: stationCodeSystem coerces with String() before matching, so a " +
      "JSON number is a valid N02_005c. The import path keeps it a number all " +
      "the way into the canonical store — which is the one place the Swift " +
      "model cannot follow, because Stop.n02StationCode is a String?.",
  ],
  [
    "no stop is ridden",
    withLean({ stops: [{ name: "東京", ride_segment: false }, { name: "品川", ride_segment: false }] }),
    "jsonspec §8.6.4 notwithstanding, nothing checks it: this validates, " +
      "exports, and draws nothing.",
  ],
  [
    "the clock runs backwards",
    withLean({ stops: [{ name: "東京", departure: "18:00" }, { name: "品川", arrival: "06:00" }] }),
    "no two stops are ever compared.",
  ],
  [
    "times that are not times",
    withLean({ stops: [{ name: "東京", departure: "banana" }, { name: "品川", arrival: "26:99" }] }),
    "normalizeNullableTime only trims; nothing parses a time.",
  ],
  [
    "direction is a number",
    withLean({ direction: 42 }),
    "accepted by both doors — and normalizeImportedTrain keeps the NUMBER, " +
      "because `train.direction || \"down\"` never coerces.",
  ],
  [
    "visible is the string \"yes\"",
    withLean({ visible: "yes" }),
    "the test is `!== false`, so every value except false means visible.",
  ],
  ["visible is 0", withLean({ visible: 0 })],
  [
    "train_type is a number",
    withLean({ train_type: 7 }),
    "THE asymmetry: validateTrain rejects a numeric train_type outright, but " +
      "normalizeImportedTrain has already coerced it to \"\" by the time the " +
      "validator runs — so the import engine ACCEPTS what the validator refuses.",
  ],
  [
    "an id that is not in the documented charset",
    withLean({ id: "odr.001" }),
    "REJECTED, though normalizeImportedTrain never applies TRAIN_ID_PATTERN: " +
      "the pattern arrives with the second door.",
  ],
  [
    "an id with surrounding whitespace",
    withLean({ id: "  odr_001  " }),
    "ACCEPTED and silently trimmed. makeUniqueTrainId runs between the two " +
      "doors and trims the base, so the id validateTrain sees is not the id " +
      "the document contained.",
  ],
  [
    "an id that is only whitespace",
    withLean({ id: "   " }),
    "ACCEPTED as the id \"train\": a whitespace-only base is falsy after " +
      "trimming, and makeUniqueTrainId's second fallback catches it.",
  ],
  [
    "a stop whose name is null",
    withLean({ stops: [{ name: null }, { name: "品川" }] }),
    "the import whitelist's guard is `\"name\" in stop`, so this passes door " +
      "one and is caught by door two.",
  ],
  [
    "a stop row that is null",
    withLean({ stops: [null, { name: "品川" }] }),
    "one of the three inputs that CRASH validateTrain with a TypeError — but " +
      "not through this door: normalizeImportedStop rejects it as a plain " +
      "Error first, so the crash is unreachable from an import.",
  ],
  [
    "a route_sections row that is null",
    withLean({ route_sections: [null] }),
    "likewise converted to an Error by normalizeImportedRouteSection before " +
      "the validator can dereference it.",
  ],
  [
    "a stop_type outside the enum",
    withLean({ stops: [{ name: "東京", stop_type: "skipped" }, { name: "品川" }] }),
    "the import path never consults STOP_TYPES — the validator does, and " +
      "rejects it.",
  ],
  [
    "style is a string",
    withLean({ style: "red" }),
    "`train.style?.color` on a string is undefined, so the default colour wins.",
  ],
  ["an unsupported train key", withLean({ nickname: "x" })],
  ["route_geometry, the removed field", withLean({ route_geometry: [] })],
];

for (const [label, train, note] of acceptedButArguablyNot) {
  await addRun(label, {
    input: leanStore([train]),
    door: "store",
    note,
  });
}

// ── appendImportedTrain on its own ──────────────────────────────────────
//
// The composition, isolated from the loop around it, so a disagreement names
// the per-train step rather than the sequence.
const appendCases = [];
async function addAppend(label, { country = "jp", selectedDate = "__all__", existing = [], train, fallbackDate }, note) {
  reset({ country, selectedDate, existing });
  context.__train = clone(train);
  const expression =
    fallbackDate === undefined
      ? "appendImportedTrain(__train)"
      : `appendImportedTrain(__train, ${JSON.stringify(fallbackDate)})`;
  const outcome = await call(expression);
  appendCases.push({
    label,
    ...(note ? { note } : {}),
    country,
    selectedDate,
    existing: JSON.stringify(existing),
    train: JSON.stringify(train),
    // Absent and null are different arguments here: the parameter's default
    // is `currentImportFallbackDate()`, and a default only applies to
    // `undefined`. Passing null explicitly therefore SUPPRESSES the selected
    // date, which a port that reads a nil argument as "use the default" gets
    // backwards — so which one the call made is recorded, not just its value.
    explicitFallback: fallbackDate !== undefined,
    ...(fallbackDate === undefined ? {} : { fallbackDate }),
    ...(outcome.ok
      ? {
          ok: true,
          id: outcome.returned,
          // The canonical export of the store the append left behind: the id
          // alone would not show that the train it pushed was normalised.
          store: stableStringify(JSON.parse(run("JSON.stringify(buildCanonicalTrainStore())"))),
        }
      : { ok: false, errorName: outcome.errorName, error: outcome.error }),
  });
}

await addAppend("a committed jp train", { train: stores.jp.trains[0] });
await addAppend("a committed tw train", { country: "tw", train: stores.tw.trains[0] });
await addAppend("the leanest train the importer accepts", { train: lean });
await addAppend(
  "a numeric train_type",
  { train: withLean({ train_type: 7 }) },
  "accepted here and rejected by validateTrain on its own — the coercion in " +
    "door one happens before door two can see the number.",
);
await addAppend("an id outside TRAIN_ID_PATTERN", { train: withLean({ id: "odr.001" }) });
await addAppend("an id with surrounding whitespace", { train: withLean({ id: " odr_001 " }) });
await addAppend("an id in kana", { train: withLean({ id: "はやぶさ" }) });
await addAppend("an id with a trailing newline", { train: withLean({ id: "odr_001\n" }) },
  "rejected: JavaScript's `$` matches only at the very end of the input, " +
    "where ICU's matches before a final line terminator too.");
await addAppend("an id in fullwidth digits", { train: withLean({ id: "００１" }) });
await addAppend("a null stop row", { train: withLean({ stops: [null, { name: "品川" }] }) },
  "an Error, not the TypeError validateTrain raises on the same shape.");
await addAppend("a null route_sections row", { train: withLean({ route_sections: [null] }) });
await addAppend("an unsupported key", { train: withLean({ nickname: "x" }) });
await addAppend("not an object", { train: "train" });
await addAppend("null", { train: null });
await addAppend("an array", { train: [lean] });
await addAppend("one stop", { train: withLean({ stops: [{ name: "東京" }] }) });
await addAppend("an explicit fallback date", { train: lean, fallbackDate: "2026-08-05" });
await addAppend("an explicit null fallback date", { train: lean, fallbackDate: null });
await addAppend(
  "an explicit null fallback date, with a date selected",
  { selectedDate: "2026-08-05", train: lean, fallbackDate: null },
  "the null WINS: a default argument applies only to undefined, so passing " +
    "null suppresses currentImportFallbackDate() and the train lands undated " +
    "even though a day is on screen. This is the case that separates a port " +
    "reading nil as \"absent\" from one reading it as \"no fallback\".",
);
await addAppend(
  "no fallback argument, with a date selected",
  { selectedDate: "2026-08-05", train: lean },
  "the default argument is currentImportFallbackDate(), evaluated per call.",
);
await addAppend("no fallback argument, with 全部 selected", { selectedDate: "__all__", train: lean });

// ── currentImportFallbackDate ───────────────────────────────────────────
const fallbackDateCases = [];
for (const selectedDate of ["2026-08-05", "__all__", "undated", "", null, "0"]) {
  reset({ selectedDate });
  // `selectedDate` is set through the same assignment the app uses, so the
  // falsy spellings really are falsy rather than the string "null".
  run(`selectedDate = ${JSON.stringify(selectedDate)};`);
  fallbackDateCases.push({
    selectedDate,
    result: JSON.parse(run("JSON.stringify(currentImportFallbackDate() ?? null)")),
  });
}

// ── sampleManifestDates ─────────────────────────────────────────────────
const manifestDatesCases = [];
function addManifestDates(label, manifest, note) {
  context.__manifest = manifest === undefined ? undefined : clone(manifest);
  manifestDatesCases.push({
    label,
    ...(note ? { note } : {}),
    manifest: JSON.stringify(manifest === undefined ? null : manifest),
    dates: JSON.parse(run("JSON.stringify(sampleManifestDates(__manifest))")),
  });
}
addManifestDates("no manifest", null);
addManifestDates("no dates map", { parts: ["a"] });
addManifestDates("dates is an array", { dates: ["2026-07-03"] },
  "an array IS an object, so this reaches the filter and its indices are the keys.");
addManifestDates("dates is an array OF arrays", { dates: [["part-000"], []] },
  "and the indices are then real answers: \"0\" is a day whose list is " +
    "non-empty. A port that reads keys off an array but cannot read VALUES " +
    "back off one returns [] here and looks right on every other case.");
addManifestDates("dates is a string", { dates: "2026-07-03" });
addManifestDates("an ordinary dates map", {
  dates: { "2026-07-05": ["part-002"], "2026-07-03": ["part-000", "part-001"] },
});
addManifestDates("empty and non-array day lists are dropped", {
  dates: { "2026-07-03": [], "2026-07-04": ["part-000"], "2026-07-05": null, "2026-07-06": "part-001" },
});
addManifestDates("the empty-string key is dropped", {
  dates: { "": ["part-000"], "2026-07-04": ["part-001"] },
  },
  "precompute files undated trains under \"\", and `key &&` is what keeps " +
    "that bucket out of the boot's random-day choice.",
);
addManifestDates("keys sort by UTF-16 code unit, not by locale", {
  dates: { "2026-1-3": ["a"], "2026-12-03": ["a"], "2026-2-03": ["a"], "2026-02-03": ["a"] },
  },
  "Array.prototype.sort with no comparator compares code units, so \"2026-1-3\" " +
    "sorts before \"2026-12-03\" and both before \"2026-2-03\".",
);

// ── the manifest predicate (makeManifestLoader) ─────────────────────────
//
// Driven through the REAL loader with fetch stubbed, so the memoisation and
// the shape test are both the app's own.
const manifestCases = [];
async function addManifest(label, payload, { attachPartsApi = false, fail = false } = {}, note) {
  context.__payload = payload === undefined ? undefined : clone(payload);
  context.fetch = async () =>
    fail
      ? { ok: false, status: 404, statusText: "Not Found" }
      : { ok: true, json: async () => clone(context.__payload) };
  const value = JSON.parse(
    await run(`(async () => {
      const load = makeManifestLoader("sample-data", { attachPartsApi: ${attachPartsApi} });
      return JSON.stringify(await load() ?? null);
    })()`),
  );
  manifestCases.push({
    label,
    ...(note ? { note } : {}),
    payload: JSON.stringify(payload === undefined ? null : payload),
    api: "sample-data",
    attachPartsApi,
    fetchFails: fail,
    manifest: value === null ? null : stableStringify(value),
  });
}
const goodManifest = { format: 1, schema_version: "1.3", parts: ["part-000", "part-001"], dates: { "2026-07-03": ["part-000"] } };
await addManifest("a well-formed manifest", goodManifest);
await addManifest("a well-formed manifest, with parts_api attached", goodManifest, { attachPartsApi: true });
await addManifest("the fetch fails", goodManifest, { fail: true },
  "an unreachable manifest memoises as null and is never retried.");
await addManifest("a null body", null);
await addManifest("the wrong format", { ...goodManifest, format: 2 });
await addManifest("format as a string", { ...goodManifest, format: "1" },
  "`!== 1` is strict, so the string \"1\" is a different format.");
await addManifest("no parts", { ...goodManifest, parts: undefined });
await addManifest("an empty parts list", { ...goodManifest, parts: [] });
await addManifest("parts is an object", { ...goodManifest, parts: { 0: "part-000" } });
await addManifest("an unaccepted schema_version", { ...goodManifest, schema_version: "1.2" });
await addManifest("no schema_version", { ...goodManifest, schema_version: undefined });
await addManifest("extra keys survive", { ...goodManifest, total: 2, full: "sample-full" },
  "the manifest has no whitelist: anything else it carries is passed through.");

// ── the parts source ────────────────────────────────────────────────────
//
// One request per train, a five-wide prefetch window ahead of the cursor, one
// retry, then skip. `fetched` is the ORDER the URLs were asked for, which is
// the only way the window is observable.
const partCases = [];
async function addParts(label, { names, bodies, failures = {} }, note) {
  context.__bodies = clone(bodies);
  context.__failures = clone(failures);
  const fetched = [];
  const attempts = new Map();
  context.fetch = async (url) => {
    fetched.push(url);
    const key = url.split("/").pop();
    const seen = (attempts.get(key) || 0) + 1;
    attempts.set(key, seen);
    const failFor = failures[key];
    if (failFor && seen <= failFor) return { ok: false, status: 500, statusText: "Server Error" };
    if (!(key in bodies)) return { ok: false, status: 404, statusText: "Not Found" };
    return { ok: true, json: async () => clone(bodies[key]) };
  };
  context.__names = clone(names);
  const got = JSON.parse(
    await run(`(async () => {
      const source = makeTrainPartsSource({ parts: __names, parts_api: "sample-data" });
      const out = [];
      for (let i = 0; i < source.total; i += 1) {
        const train = await source.get(i);
        out.push(train === null || train === undefined ? null : train.id);
      }
      return JSON.stringify({ total: source.total, ids: out });
    })()`),
  );
  partCases.push({
    label,
    ...(note ? { note } : {}),
    names,
    bodies: stableStringify(bodies),
    failures,
    total: got.total,
    ids: got.ids,
    fetched,
  });
}
const partBody = (id) => ({ format: 1, train: { ...lean, id } });
await addParts("three good parts", {
  names: ["part-000", "part-001", "part-002"],
  bodies: { "part-000": partBody("p0"), "part-001": partBody("p1"), "part-002": partBody("p2") },
  },
  "the window is index..index+4 INCLUSIVE — five parts, not four — clamped to " +
    "the last index, and each part is fetched exactly once because the " +
    "in-flight map is consulted before a new request is made.",
);
await addParts("eight parts, so the window is not clamped", {
  names: Array.from({ length: 8 }, (_, i) => `part-00${i}`),
  bodies: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`part-00${i}`, partBody(`p${i}`)])),
});
await addParts("one part", { names: ["part-000"], bodies: { "part-000": partBody("p0") } });
await addParts("no parts at all", { names: [], bodies: {} });
await addParts("a part that 404s on both attempts", {
  names: ["part-000", "part-001"],
  bodies: { "part-001": partBody("p1") },
  },
  "one retry, then null — a single flaky request skips one train instead of " +
    "aborting the whole boot.",
);
await addParts("a part that fails once and succeeds on the retry", {
  names: ["part-000", "part-001"],
  bodies: { "part-000": partBody("p0"), "part-001": partBody("p1") },
  failures: { "part-000": 1 },
  },
  "NOTE the prefetch: part-000's single allowed failure is consumed by the " +
    "prefetch issued for it, so the retry the cursor makes is a second request.",
);
await addParts("a part with the wrong format", {
  names: ["part-000"],
  bodies: { "part-000": { format: 2, train: lean } },
});
await addParts("a part with no train", {
  names: ["part-000"],
  bodies: { "part-000": { format: 1 } },
});
await addParts("a part that is null", { names: ["part-000"], bodies: { "part-000": null } });

// ── seedRouteCacheFromPart ──────────────────────────────────────────────
//
// Observed through RouteService's own predicates rather than by wrapping it
// (the service is frozen), which is the stronger check anyway: it asks what
// the cache CONTAINS afterwards.
const seedCases = [];
function addSeed(label, part, note) {
  context.__part = part === undefined ? undefined : clone(part);
  const key = (part && part.route && part.route.cache_key) || "";
  seedCases.push({
    label,
    ...(note ? { note } : {}),
    part: JSON.stringify(part === undefined ? null : part),
    ...JSON.parse(
      run(`(() => {
        RouteService.resetForCountry();
        seedRouteCacheFromPart(__part);
        const key = ${JSON.stringify(key)};
        return JSON.stringify({
          cached: key ? RouteService.has(key) : false,
          negative: key ? RouteService.isNegative(key) : false,
          cacheSize: RouteService.cacheSize(),
        });
      })()`),
    ),
  });
}
const feature = { type: "Feature", geometry: { type: "LineString", coordinates: [[139, 35], [140, 36]] }, properties: {} };
addSeed("a solved part", { route: { cache_key: "k1", features: [feature] } });
addSeed("an unsolvable part", { route: { cache_key: "k1", unsolvable: true } });
addSeed("unsolvable AND carrying features", { route: { cache_key: "k1", unsolvable: true, features: [feature] } },
  "unsolvable wins: the negative cache is seeded and the features are dropped.");
addSeed("unsolvable is the string \"true\"", { route: { cache_key: "k1", unsolvable: "true", features: [feature] } },
  "the test is `=== true`, so a truthy non-boolean falls through to the features branch.");
addSeed("no route", { format: 1, train: lean });
addSeed("no part", null);
addSeed("a cache_key that is empty", { route: { cache_key: "", features: [feature] } });
addSeed("a cache_key that is a number", { route: { cache_key: 12, features: [feature] } },
  "`typeof !== \"string\"` rejects it before the features are looked at.");
addSeed("an empty features array", { route: { cache_key: "k1", features: [] } });
addSeed("features is not an array", { route: { cache_key: "k1", features: {} } });

// ── which parts one sample day loads ────────────────────────────────────
//
// loadSampleData's day selection, driven through the real function with the
// progressive loader replaced by a recorder — so the selection rule is the
// app's and only the load is stubbed.
const sampleNameCases = [];
async function addSampleNames(label, manifest, date, note) {
  context.__manifest = clone(manifest);
  context.__picked = null;
  const outcome = JSON.parse(
    await run(`(async () => {
      const originalLoadManifest = loadSampleManifest;
      const originalReplace = replaceTrainStoreFromPartsProgressive;
      loadSampleManifest = async () => __manifest;
      replaceTrainStoreFromPartsProgressive = async (manifest, label, options) => {
        __picked = { parts: manifest.parts, label: String(label), options };
        return { count: 0, ids: [] };
      };
      try {
        await loadSampleData({ date: ${JSON.stringify(date)} });
        return JSON.stringify({ ok: true, dataSourceMode, sampleModeDate: sampleModeDate ?? null });
      } catch (error) {
        return JSON.stringify({ ok: false, errorName: error.name, error: error.message });
      } finally {
        loadSampleManifest = originalLoadManifest;
        replaceTrainStoreFromPartsProgressive = originalReplace;
      }
    })()`),
  );
  sampleNameCases.push({
    label,
    ...(note ? { note } : {}),
    manifest: JSON.stringify(manifest),
    date: date === undefined ? null : date,
    ...outcome,
    picked: context.__picked === null ? null : stableStringify(clone(context.__picked)),
  });
}
const dayManifest = {
  format: 1,
  schema_version: "1.3",
  parts: ["part-000", "part-001", "part-002"],
  dates: { "2026-07-03": ["part-000", "part-001"], "2026-07-04": ["part-002"], "2026-07-05": [] },
};
await addSampleNames("one published day", dayManifest, "2026-07-03");
await addSampleNames("the whole sample", dayManifest, null,
  "a null date loads manifest.parts and lands on the combined 全部 view.");
await addSampleNames("a day the manifest does not have", dayManifest, "2026-07-09",
  "falls back to the WHOLE sample rather than loading nothing — but the mode " +
    "still says sample-single, because the mode is decided by the argument " +
    "and the names by the manifest.");
await addSampleNames("a day whose list is empty", dayManifest, "2026-07-05",
  "an empty array IS an array, so this loads zero parts — sampleManifestDates " +
    "would never have offered this day, but an explicit request reaches it.");
await addSampleNames("a manifest with no dates map", { format: 1, schema_version: "1.3", parts: ["part-000"] }, "2026-07-03");

// ── done ────────────────────────────────────────────────────────────────

for (const handle of timers) clearTimeout(handle);
timers.clear();

const fixture = {
  describes: "app-import.js §16 — the progressive load / import engine",
  contract:
    "The import engine is the app's only inbound path, and what it produces " +
    "is a SEQUENCE, not a value: reset, prepare, then per train append -> warm " +
    "-> draw -> list -> progress, then one authoritative render, then finish. " +
    "A port that lands on the same store having reported progress in a " +
    "different order is a port whose progressive load looks wrong on screen " +
    "and whose partial states cannot be reasoned about. The per-train step is " +
    "the composition of BOTH front doors — normalizeImportedTrain, then " +
    "makeUniqueTrainId, then validateTrain on the exported shape — and that " +
    "composition accepts things neither door accepts alone.",
  cases: runCases,
  appendCases,
  fallbackDateCases,
  manifestCases,
  manifestDatesCases,
  partCases,
  seedCases,
  sampleNameCases,
};

export function build() {
  return fixture;
}
