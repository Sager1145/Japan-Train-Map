// =========================================================================
//  port-fixtures/dates.mjs — freeze what app-dates.js answers today
//
//  app-dates.js is §6 of the app family: which date bucket a train lives in,
//  how the buckets sort, which calendar days an overnight itinerary touches,
//  and which of those days a given route segment runs on. None of that is
//  checkable by eye, and dates are the one area where two languages disagree
//  silently — a month that is 0-based on one side and 1-based on the other,
//  or a "midnight" that is UTC here and local there, moves an answer by a
//  whole day without ever throwing.
//
//  So every expected value below is READ OUT OF THE RUNNING JAVASCRIPT. This
//  module never states a date rule of its own; it drives the real functions
//  and writes down what came back. A fixture generated from a re-implementation
//  would only prove that the re-implementation and the port agree.
//
//  Inputs are the two committed itinerary stores (app/data/train-store.json
//  and train-store-tw.json): 229 real trains on 38 real dates, including the
//  one overnight run the data actually contains (Sunrise Izumo, 2026-07-29,
//  whose times climb to 34:00). Where a code path cannot be reached by the
//  stores as written — a train with no `date` field, a train with neither
//  date nor id, an overnight itinerary that rolls over a month boundary —
//  the case is a PROJECTION of a real train (a field dropped, or the real
//  stop times re-dated to another real store date), never a fabricated
//  itinerary. Each projection says which it is in its `source`.
// =========================================================================

import fs from "node:fs";
import path from "node:path";

export const name = "dates.json";

// ── loading app-dates.js ────────────────────────────────────────────────
// app-dates.js is a classic script, not a module: it has no exports, and it
// reads bare globals (ALL_DATES, UNDATED, manualDates, trainStore,
// selectedDate) that its siblings declare in the SAME lexical scope. So it
// cannot be `import`ed — the only faithful way to run it is to reproduce that
// scope, which is what the main generator's loadFrontendScope does and what
// the precompute VM does. Concatenating the files and evaluating them through
// one `new Function` IS that scope.
//
// The chain is dictated by index.html, not chosen: app-config.js owns
// ALL_DATES and re-exports AppCore's date helpers as bare globals, and its
// top level reads window.RailMapStyle.RAILWAY_STYLE, which railmap-style.js
// publishes and which in turn needs railmap-basemap.js and rail-network.js.
// None of those touch the DOM while loading, so they evaluate headless.
const SCOPE_FILES = [
  "railmap-basemap.js", // publishes window.RailMapBasemap
  "railmap-style.js", // publishes window.RailMapStyle (needs the two above)
  "app-config.js", // ALL_DATES + the AppCore date helpers as bare globals
  "app-dates.js", // the module under test
  "app-state.js", // trainStore / selectedDate / manualDates, in index.html order
];

// I18N is the ONE thing app-dates.js reaches for that is not a date rule:
// dateLabel spells two of its three answers through the translation table,
// which is UI state (it follows the interface language). Stubbing `t` to
// return the key keeps the fixture recording the part that IS a date rule —
// which of the three branches a bucket takes — and leaves the wording to the
// app shell. The stub is a local binding in the shared scope, so it cannot
// leak into the generator's globals or into another fixture module.
const I18N_STUB = "const I18N = { t: (key) => key };\n";

function loadDateScope(APP_DIR, AppCore, RailNetwork) {
  const source =
    I18N_STUB +
    SCOPE_FILES.map((file) =>
      fs.readFileSync(path.join(APP_DIR, "public", file), "utf8"),
    ).join("\n");
  const factory = new Function(
    "window",
    `${source}
     return {
       ALL_DATES, UNDATED,
       // app-dates.js §6
       getTrainDate, sortTrainsByDateAndDeparture, getAvailableDates,
       getTrainsForDate, getTrainDaySpan, trainSpansDate, segmentDateForTrain,
       reconcileSelectedDate, dateLabel,
       // the app-core.js primitives those rules are built on, pinned directly
       // so a disagreement names the primitive rather than the rule
       addDaysToDateString, dateSortKey, trainDayBreaks, trainHasCrossDayTimes,
       compareTrainsByDateAndDeparture, getTrainDepartureMinutes,
       // the mutable globals the module reads: app-dates.js takes no
       // parameters for them, so driving it means writing them
       setManualDates: (value) => { manualDates = value; },
       setTrainStore: (value) => { trainStore = value; },
       setSelectedDate: (value) => { selectedDate = value; },
       getSelectedDate: () => selectedDate,
     };`,
  );
  return factory({ AppCore, RailNetwork });
}

// ── inputs ──────────────────────────────────────────────────────────────

function readStore(APP_DIR, file) {
  return JSON.parse(
    fs.readFileSync(path.join(APP_DIR, "data", file), "utf8"),
  ).trains;
}

// Only the fields a date rule reads: the two times, and stop_type, which
// getTrainDepartureMinutes falls back to when the first stop has no departure.
// Station names and coordinates play no part here, and carrying them would
// make the fixture a second copy of the store rather than a record of an
// answer.
function projectTrain(train) {
  return {
    id: train.id,
    date: train.date ?? null,
    stops: (train.stops || []).map((stop) => ({
      arrival: stop && stop.arrival != null ? stop.arrival : null,
      departure: stop && stop.departure != null ? stop.departure : null,
      stop_type: stop && stop.stop_type != null ? stop.stop_type : null,
    })),
  };
}

// A train shape the JS actually receives: jsonspec allows `date` to be absent
// entirely, and absent is what makes normalizeTrainDate fall through to the
// id, so the projection deletes the key rather than nulling it.
function withoutDate(train) {
  const copy = projectTrain(train);
  delete copy.date;
  return copy;
}

export function build({ AppCore, RailNetwork, APP_DIR }) {
  const js = loadDateScope(APP_DIR, AppCore, RailNetwork);
  const { ALL_DATES, UNDATED } = js;

  const jpTrains = readStore(APP_DIR, "train-store.json");
  const twTrains = readStore(APP_DIR, "train-store-tw.json");

  // The single overnight itinerary in the committed data. Everything about
  // cross-day spans is measured against this train, so it is found by the rule
  // rather than by index: an edit to the store must not silently turn these
  // cases into single-day ones without anybody noticing.
  const overnight = jpTrains.find((train) => js.trainHasCrossDayTimes(train));
  if (!overnight)
    throw new Error(
      "no cross-day train in train-store.json — every day-span case would be " +
        "single-day and would stop testing anything",
    );

  const storeDates = [
    ...new Set([...jpTrains, ...twTrains].map((train) => train.date)),
  ]
    .filter(Boolean)
    .sort();

  // ---- the train inputs, referenced by index everywhere below ----------
  const trains = [];
  const add = (source, train) => {
    trains.push({ index: trains.length, source, ...train });
    return trains.length - 1;
  };

  const jpIndices = jpTrains.map((train) => add("jp", projectTrain(train)));
  const twIndices = twTrains.map((train) => add("tw", projectTrain(train)));
  const overnightIndex = jpIndices[jpTrains.indexOf(overnight)];

  // Projection 1: the `date` field dropped. Every id in both stores begins
  // with its own YYYYMMDD, so this is the path where normalizeTrainDate falls
  // through to inferDateFromTrainId — reachable in the real app whenever an
  // import supplies ids but no dates.
  const inferredIndices = [
    ...jpTrains.slice(0, 6),
    overnight,
    ...twTrains.slice(0, 3),
  ].map((train) =>
    add("projection — date dropped, so it is inferred from the id", withoutDate(train)),
  );

  // Projection 2: neither date nor id. That is the only way a train reaches
  // the UNDATED bucket, and it is the state a train is in the instant the
  // editor creates it, before anything has been typed.
  const undatedIndices = [jpTrains[0], overnight, twTrains[0]].map((train) => {
    const copy = withoutDate(train);
    delete copy.id;
    return add("projection — date and id dropped, falls through to UNDATED", copy);
  });

  // Projection 3: the real overnight stop times carried onto other real store
  // dates. 2026-07-31 is the one that matters — it makes the day span roll
  // over a month boundary, which no committed itinerary does, and a port that
  // adds a day by incrementing the day-of-month passes everything else and
  // fails only here.
  const redatedIndices = ["2026-07-31", "2026-08-01", "2026-08-13"].map((date) =>
    add(`projection — the overnight itinerary re-dated to ${date}`, {
      ...projectTrain(overnight),
      date,
    }),
  );

  // The fixture's own record of an input is what the JS is fed, so the two can
  // never end up describing different trains.
  // Projection 4: the stops dropped. This is the ONLY way to reach the
  // comparator's last branch. getTrainDepartureMinutes answers Infinity when
  // nothing parses, `Infinity !== Infinity` is false, so two such trains fall
  // through to String#localeCompare on their ids — and every train in both
  // committed stores has a departure time, so nothing else in this fixture
  // ever gets there. The three chosen trains share a date (2026-07-03), which
  // is what makes the date and departure branches both tie. Their ids are the
  // real ones, so the tiebreak is pinned against real input rather than a
  // string picked to make a point.
  const tiedIndices = jpTrains.slice(0, 3).map((train) =>
    add("projection — stops dropped, so the id tiebreak decides", {
      ...projectTrain(train),
      stops: [],
    }),
  );

  const trainAt = (index) => {
    const { index: _index, source: _source, ...train } = trains[index];
    return train;
  };
  const allIndices = trains.map((_, index) => index);

  // ---- day spans (the fixture's `cases`) -------------------------------
  const cases = allIndices.map((index) => {
    const span = js.getTrainDaySpan(trainAt(index));
    return {
      train: index,
      trainDate: js.getTrainDate(trainAt(index)),
      hasCrossDayTimes: js.trainHasCrossDayTimes(trainAt(index)),
      breaks: js.trainDayBreaks(trainAt(index)),
      spanDate: span.date,
      spanBreaks: span.breaks,
      dates: span.dates,
      key: span.key,
      sig: span.sig,
    };
  });

  // ---- available dates -------------------------------------------------
  // manualDates is a global the module reads, so each case installs it and
  // reads the answer back. The manual values are real store dates plus the
  // shapes the date bar actually produces: the UNDATED sentinel, a
  // slash-written date (normalizeDateString rewrites "/" to "-"), and padding.
  const availableDatesCases = [
    { trains: jpIndices, manualDates: [] },
    { trains: twIndices, manualDates: [] },
    { trains: allIndices, manualDates: [] },
    { trains: [], manualDates: [] },
    { trains: [], manualDates: ["2026-07-26"] },
    { trains: jpIndices, manualDates: [UNDATED] },
    { trains: jpIndices, manualDates: ["2026-08-05", "2026-07-04", UNDATED] },
    { trains: twIndices, manualDates: ["2026/08/05", " 2026-08-06 "] },
    // Rejected shapes. 2026-06-31 is the case worth having: the JS checks the
    // day only as 1..31, so a day that does not exist in that month is
    // ACCEPTED. Reproduce it, do not fix it.
    {
      trains: [],
      manualDates: [ALL_DATES, "2026-13-01", "2026-06-31", "", "not-a-date"],
    },
    { trains: undatedIndices, manualDates: [] },
    { trains: inferredIndices, manualDates: [] },
  ].map((item) => {
    js.setManualDates([...item.manualDates]);
    return { ...item, dates: js.getAvailableDates(item.trains.map(trainAt)) };
  });

  // ---- trains in one bucket -------------------------------------------
  const trainsForDateCases = [...storeDates, UNDATED, ALL_DATES].map((date) => ({
    date,
    // Indices, not ids: two of the projections have no id at all.
    trains: allIndices.filter(
      (index) => js.getTrainsForDate([trainAt(index)], date).length === 1,
    ),
  }));

  // ---- sort order ------------------------------------------------------
  // Deterministic permutations only — the fixture must regenerate to the same
  // bytes, so nothing here may be shuffled at random. Feeding an already
  // sorted list, its reverse and a stride interleave is what catches a
  // comparator that is right on pairs and wrong over a whole ordering.
  const stride = (list, step) => {
    const out = [];
    for (let offset = 0; offset < step; offset += 1)
      for (let i = offset; i < list.length; i += step) out.push(list[i]);
    return out;
  };
  const sortOrders = [
    { label: "jp store order", input: jpIndices },
    { label: "jp reversed", input: [...jpIndices].reverse() },
    { label: "jp stride 7", input: stride(jpIndices, 7) },
    { label: "tw store order", input: twIndices },
    { label: "both stores, tw first", input: [...twIndices, ...jpIndices] },
    { label: "every input including the projections", input: allIndices },
    // Same date, no departure time anywhere: the id tiebreak alone decides.
    { label: "id tiebreak only", input: [...tiedIndices].reverse() },
    { label: "empty", input: [] },
  ].map((item) => {
    // Mapped back by object identity, not by id: the projections repeat ids
    // and two of them carry none at all, so a lookup by id is ambiguous where
    // identity is not.
    const objects = item.input.map(trainAt);
    const sorted = js.sortTrainsByDateAndDeparture(objects);
    return {
      ...item,
      order: sorted.map((train) => item.input[objects.indexOf(train)]),
    };
  });

  // ---- the comparator itself ------------------------------------------
  // Only the SIGN is recorded. The middle branch returns `departureA -
  // departureB`, a minute count rather than a sign, and String#localeCompare's
  // magnitude is explicitly implementation-defined; Array.prototype.sort reads
  // nothing but the sign, so the sign is the whole contract.
  const comparisons = [];
  for (let i = 0; i < trains.length; i += 1) {
    const j = (i * 7 + 3) % trains.length;
    comparisons.push({
      a: i,
      b: j,
      sign: Math.sign(js.compareTrainsByDateAndDeparture(trainAt(i), trainAt(j))),
    });
  }
  // Every ordered pair among the tied trains, so the tiebreak is compared in
  // both directions and against itself rather than sampled.
  for (const a of tiedIndices)
    for (const b of tiedIndices)
      comparisons.push({
        a,
        b,
        sign: Math.sign(js.compareTrainsByDateAndDeparture(trainAt(a), trainAt(b))),
      });

  // ---- the id tiebreak, probed over the charset ids may use ------------
  // The last branch of the comparator is String#localeCompare, which uses the
  // RUNTIME's default locale — the JavaScript pins nothing. Over the
  // [A-Za-z0-9_-] charset jsonspec §3.2 allows, ICU's collation and UTF-16
  // code-unit order genuinely disagree: "a_b" sorts before "a-b" under ICU and
  // after it by code unit, and "AB" sorts after "ab" under ICU and before it
  // by code unit. Every id in both stores is [0-9a-z_] with its separators in
  // fixed positions, so real data cannot tell the two rules apart and the
  // fixture would let a port pick the wrong one.
  //
  // These probes close that hole. The ids are probes, not itineraries — but
  // they are compared through the REAL comparator, on two copies of a real
  // stopless train sharing a real date, so both earlier branches tie and the
  // tiebreak is what answers.
  const idProbes = [
    "20260703_01_haruka", // two real ids, as the control
    "20260703_02_tokaido_shinkansen_hikari_kodama",
    "a_b",
    "a-b",
    "AB",
    "ab",
    "A",
    "a",
    "Z",
    "_",
    "0",
    "-",
  ];
  const tiebreakProbeDate = jpTrains[0].date;
  const probeTrain = (id) => ({ id, date: tiebreakProbeDate, stops: [] });
  const idTiebreak = [];
  for (const a of idProbes)
    for (const b of idProbes)
      idTiebreak.push({
        a,
        b,
        sign: Math.sign(
          js.compareTrainsByDateAndDeparture(probeTrain(a), probeTrain(b)),
        ),
      });
  // The locale the runtime resolved to when these answers were recorded. Not
  // an input — a note for whoever has to explain a future disagreement.
  const tiebreakLocale = new Intl.Collator().resolvedOptions().locale;

  // ---- departure minutes ----------------------------------------------
  // Infinity is not representable in JSON, so it is written as null and the
  // port has to read that back as "sorts last". Recording it is the point: it
  // is what a train with no parseable departure carries into the comparator,
  // and `Infinity !== Infinity` being false is what sends two such trains to
  // the id tiebreak instead of to a NaN comparison result.
  const departureMinutes = allIndices.map((index) => {
    const minutes = js.getTrainDepartureMinutes(trainAt(index));
    return { train: index, minutes: Number.isFinite(minutes) ? minutes : null };
  });

  // ---- does a train run on this date at all ---------------------------
  const spansDate = [];
  for (const index of [
    overnightIndex,
    ...redatedIndices,
    jpIndices[0],
    twIndices[0],
    undatedIndices[0],
    inferredIndices[0],
  ])
    for (const date of [
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
      "2026-08-13",
      "2026-08-14",
      UNDATED,
      ALL_DATES,
      "", // falsy: the guard treats "no date" as "everything is in scope"
    ])
      spansDate.push({
        train: index,
        date,
        spans: js.trainSpansDate(trainAt(index), date),
      });

  // ---- which day a route segment runs on ------------------------------
  // The overnight train breaks after stop 14, so segment 14 (stops 14 → 15) is
  // already the next day. Indices around the break, at both ends of the
  // itinerary, and out of range on both sides.
  const segmentDates = [];
  for (const index of [overnightIndex, ...redatedIndices, jpIndices[0]]) {
    const span = js.getTrainDaySpan(trainAt(index));
    for (const segmentIndex of [-1, 0, 1, 13, 14, 15, 16, 100, 215, 216, 217, 1000])
      segmentDates.push({
        train: index,
        segmentIndex,
        date: js.segmentDateForTrain(span, segmentIndex),
      });
  }

  // ---- reconcileSelectedDate ------------------------------------------
  // Reads the trainStore and selectedDate globals and writes selectedDate
  // back, so each case installs both and reads the result out again.
  const reconcile = [
    { selectedDate: ALL_DATES, trains: jpIndices, manualDates: [] },
    { selectedDate: "2026-07-26", trains: jpIndices, manualDates: [] },
    // A still-valid selection survives; a selection the store no longer has
    // falls back to the EARLIEST date, never to the last.
    { selectedDate: "2026-08-05", trains: jpIndices, manualDates: [] },
    { selectedDate: "2026-08-05", trains: twIndices, manualDates: [] },
    { selectedDate: "2026-08-05", trains: jpIndices, manualDates: ["2026-08-05"] },
    { selectedDate: UNDATED, trains: jpIndices, manualDates: [] },
    { selectedDate: UNDATED, trains: undatedIndices, manualDates: [] },
    { selectedDate: "2026-07-26", trains: [], manualDates: [] },
    { selectedDate: ALL_DATES, trains: [], manualDates: [] },
    { selectedDate: "2026-07-26", trains: [], manualDates: ["2026-08-09"] },
  ].map((item) => {
    js.setManualDates([...item.manualDates]);
    js.setTrainStore({ schema_version: "1.3", trains: item.trains.map(trainAt) });
    js.setSelectedDate(item.selectedDate);
    js.reconcileSelectedDate();
    return { ...item, result: js.getSelectedDate() };
  });

  // ---- date labels -----------------------------------------------------
  // With I18N stubbed to return the key, this records the BRANCH each bucket
  // takes, which is the date rule. The wording behind the two keys is the
  // shell's business.
  const labels = [ALL_DATES, UNDATED, ...storeDates, "2026-06-31"].map(
    (date) => ({ date, label: js.dateLabel(date) }),
  );

  // ---- day arithmetic --------------------------------------------------
  // addDaysToDateString belongs to app-core.js rather than app-dates.js, but
  // it is the engine under every multi-day span and it is exactly where a port
  // silently loses a day. The JS does the whole thing in UTC milliseconds
  // (Date.UTC, plus n × 86 400 000, read back through getUTC*), so it has no
  // time zone and therefore no DST — which is only visible if the fixture asks
  // it about a day that WOULD be 23 or 25 hours long somewhere. No committed
  // itinerary lands on such a day (the stores run July–August), so the four
  // 2026 transitions, the year boundary and a leap day are added explicitly.
  // They are arithmetic probes, not itineraries.
  const dstProbes = [
    "2026-03-07", // the day before US spring-forward (2026-03-08)
    "2026-03-08",
    "2026-03-28", // the day before EU spring-forward (2026-03-29)
    "2026-03-29",
    "2026-10-24", // the day before EU fall-back (2026-10-25)
    "2026-10-25",
    "2026-10-31", // the day before US fall-back (2026-11-01)
    "2026-11-01",
    "2026-12-31", // year rollover
    "2028-02-28", // leap day follows
    "2027-02-28", // the same date in a common year
    // Days that pass isValidDateString (which checks 1..31 and never asks the
    // month) but do not exist. Date.UTC rolls them forward, so the +0 answer
    // and the +1 answer disagree about which month the date is even in.
    "2026-06-31",
    "2026-02-30",
    // Date.UTC maps a year of 0..99 onto 1900 + y, and the result is spelled
    // with an UNPADDED year, so these come back as 1926-…, 2000-01-01,
    // 100-01-02 and 10000-01-01 — none of which isValidDateString accepts.
    "0026-07-04",
    "0099-12-31",
    "0100-01-01",
    "9999-12-31",
  ];
  const dayArithmetic = [];
  for (const date of [...storeDates, ...dstProbes])
    for (const days of [0, 1, 2, 7, 31, 365, -1])
      dayArithmetic.push({ date, days, result: js.addDaysToDateString(date, days) });
  // The shapes the function rejects, taken from what the date bar can hand it.
  for (const date of [ALL_DATES, UNDATED, "2026-13-01", "2026/07/04", ""])
    dayArithmetic.push({ date, days: 1, result: js.addDaysToDateString(date, 1) });

  // ---- the sort key that forces UNDATED last ---------------------------
  const sortKeys = [ALL_DATES, UNDATED, ...storeDates].map((date) => ({
    date,
    key: js.dateSortKey(date),
  }));

  return {
    describes:
      "app-dates.js §6 (date buckets, ordering, cross-day spans) over the " +
      "app-core.js date primitives it is built on",
    contract:
      "A train lives in exactly ONE date bucket — its own `date`, or the date " +
      "inferred from its id, or UNDATED — and every per-day view is derived " +
      "from that, never stored beside it. An overnight train stays in one " +
      "bucket while physically covering several calendar days, so " +
      "getTrainDaySpan derives the days it touches from its own stop times " +
      "(25:10 is 01:10 the next day) and the map filters on the resulting " +
      "span key. The arithmetic behind those days is UTC-only: " +
      "addDaysToDateString goes through Date.UTC plus a whole number of " +
      "86 400 000 ms and reads back through getUTC*, so it carries no time " +
      "zone and DST cannot reach it — a port that adds a day through a local " +
      "calendar answers differently for anyone west of UTC, and differently " +
      "again twice a year. Bucket ordering is a plain UTF-16 string " +
      "comparison with UNDATED mapped to U+FFFF so it sorts last; the train " +
      "comparator falls from date to departure minute to String#localeCompare " +
      "on the id, and only the SIGN of its result is contractual.",
    trains,
    cases,
    availableDates: availableDatesCases,
    trainsForDate: trainsForDateCases,
    sortOrders,
    comparisons,
    idTiebreak,
    tiebreakLocale,
    departureMinutes,
    spansDate,
    segmentDates,
    reconcile,
    labels,
    dayArithmetic,
    sortKeys,
  };
}
