// =========================================================================
//  playback.mjs — freeze what app-playback.js answers about time and place
//
//  §3/§6 of the playback engine decide how long a journey plays for, how that
//  budget is split between its station-to-station intervals, where the head
//  is at time t, which stations it has passed, and where the camera is. Two
//  of those answers are rules this repository has already paid for once and
//  must not lose again:
//
//    · ONE zoom per journey. It used to be computed per ridden interval, and
//      a limited express with thirty-odd stops then re-framed the map at
//      every one of them. The apparent speeding-up and slowing-down between
//      stations is still there — it lives in the TIME ALLOCATION
//      (share ∝ metres^TUNE.HOP_EXP), not in the camera. Every `path` below
//      carries exactly ONE zoom next to intervals whose metres-per-second
//      differ by an order of magnitude, which is the whole rule in one row.
//    · the camera CHASES. Each frame decays the offset between camera and
//      train and feeds the train's own motion forward untouched; nothing
//      waits for a flyTo and nothing waits for tiles. The `frames` rows are
//      the module's own per-frame camera track, produced by driving its rAF
//      callback with a virtual clock — not by re-deriving the recurrence
//      here, which would only prove a copy agrees with a port.
//
//  Everything is produced by evaluating the real app-playback.js inside the
//  real app family (scripts/lib/app-family-sandbox.mjs, the harness
//  `npm run precompute` uses). Nothing here re-implements any part of it.
//
//  ── the two things that are INPUTS here, not outputs ────────────────────
//
//  getMatchedRouteFeatures  — the route solver, a separate concern. Its
//      output is recorded feature by feature so the Swift side is fed exactly
//      the same geometry. Producing it means actually solving the real
//      itineraries against the committed 12 MB rail-sections.json, which is
//      why this is the slow fixture: about two minutes, and roughly 80 % of
//      that is the Sunrise's 216 intervals alone. That is what real geometry
//      for real itineraries costs; invented coordinates are tidy in exactly
//      the ways production data is not.
//  I18N.stationName         — presentation. The sandbox's inert stub returns
//      the name unchanged, and the Swift port takes the localiser as a
//      parameter rather than baking one in.
//
//  Inputs are committed datasets only: app/data/train-store.json (the real
//  itineraries), rail-sections.json, stations.json, matched-stops.json.
//  Nothing reads app/data/sample-data*/, which is gitignored — a fixture that
//  cannot be regenerated from a clean checkout cannot be checked by --check.
// =========================================================================

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  makeSandbox,
  evaluateAppScripts,
  readOrderedAppScripts,
} from "../../lib/app-family-sandbox.mjs";

export const name = "playback.json";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(SCRIPT_DIR, "..", "..", "..");
const DATA_DIR = path.join(APP_DIR, "data");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// ── which itineraries ───────────────────────────────────────────────────
//
// Seven, and each is here for a property none of the others has. The two
// extremes were found by solving the whole committed store once (201 trains,
// 218 s) and sorting by compiled ridden length; the figures quoted are that
// measurement, and the fixture re-records them so a data change shows up as a
// diff rather than as a stale comment.
const CASES = [
  {
    id: "20260722_03a_kagoshima_tram_kagoshimachuoeki_miyakodori",
    why:
      "The SHORTEST journey in the committed store: 313.9 m of 鹿児島市電, " +
      "eight vertices, one interval. Both clamps bite at once — duration " +
      "floors at T_MIN and zoom ceilings at Z_MAX — which is the end of the " +
      "length curve a port is likeliest to get wrong, because every term in " +
      "it is small enough to look like rounding.",
  },
  {
    id: "20260704_04_oedo_line",
    why:
      "A single-stop journey: two stops, one ridden interval. The whole time " +
      "budget goes to one hop and the interval split has nothing to split, " +
      "so t0/t1 must land exactly on 0 and the duration.",
  },
  {
    id: "20260730_06_osaka_loop",
    why:
      "大阪環状線 — a loop. The head comes back to within a few hundred " +
      "metres of where it started, so a port that identifies a position by " +
      "proximity rather than by arc distance answers plausibly and wrongly.",
  },
  {
    id: "20260721_08_asoboy3",
    why:
      "The longest DWELL in the store: 16 minutes at 立野, which is also a " +
      "switchback — the train reverses there. It proves the point the " +
      "playback clock quietly makes: the timetable does not reach this " +
      "module at all. A 16-minute stand gets no more of the budget than any " +
      "other interval boundary, because the split is metres^HOP_EXP and " +
      "nothing else.",
  },
  {
    id: "20260703_01_haruka",
    why:
      "37 ridden intervals, 4 stations: everything between 関西空港 and " +
      "新大阪 is pass_through. The pass_through exclusion at scale — and the " +
      "interval table still has 37 rows, because membership of the STATION " +
      "list and membership of the HOP list are different questions.",
  },
  {
    id: "20260713_06_hayabusa27",
    why:
      "824.2 km up the 東北新幹線: the second journey to hit the T_MAX " +
      "duration clamp, and the one showing the clamp is on duration alone — " +
      "its zoom is not at Z_MIN, so the two laws are still separate.",
  },
  {
    id: "20260729_05_sunrise_izumo",
    why:
      "The Sunrise: the LONGEST journey in the store (825.7 km), the most " +
      "intervals (216), the most vertices (10 954), 203 pass_through stops " +
      "carrying no time at all, and the only cross-midnight train in the " +
      "store (11 times spelled 24:xx / 25:xx, jsonspec §10.5). The cross-day " +
      "times are here to prove a negative: they change nothing. Playback " +
      "time is derived from METRES, so a train that runs past midnight plays " +
      "exactly like one that does not, and a port that reached for Dates " +
      "here would be building a feature this module does not have.",
  },
];

/** The loop the synthetic feature lists are edited out of. */
const SYNTHETIC_BASE_ID = "20260730_06_osaka_loop";

// ── exporting the closure ───────────────────────────────────────────────
//
// app-playback.js is an IIFE and the functions under test are closure-local,
// so no amount of loading reaches them. Rather than re-type them here, the
// module's own return statement is widened by one anchored substitution: the
// real functions come out, and if the anchor ever moves the substitution
// throws instead of silently exporting nothing. (The technique i18n.mjs uses
// for i18n.js's proper-noun glosses.)
const RETURN_ANCHOR = "\n  return {\n    start,\n";
const RETURN_EXPORT =
  "\n  return {\n    __internals: { compilePath, positionAtDistance," +
  " runProgressAtDistance, distanceAtTime, catchUpZoom, pathCacheKey," +
  " MPP_ZOOM0, DEG },\n    start,\n";

function patchedPlaybackSource() {
  const source = fs.readFileSync(path.join(APP_DIR, "public", "app-playback.js"), "utf8");
  if (!source.includes(RETURN_ANCHOR))
    throw new Error(
      "app-playback.js no longer ends its IIFE with `return {\\n    start,` — " +
        "the closure export in scripts/build/port-fixtures/playback.mjs needs a " +
        "new anchor",
    );
  return source.replace(RETURN_ANCHOR, RETURN_EXPORT);
}

// ── the sandbox program ─────────────────────────────────────────────────
//
// One program, run once, returning the whole fixture body as JSON. It has to
// live inside the sandbox because every answer in it is a call into the real
// module, and the module only exists there.
//
// Numbers that come in bulk — vertices, cumulative distances, interval rows,
// animation frames — are written as space/semicolon separated strings rather
// than as nested JSON arrays. Number→String is shortest-round-trip in
// JavaScript and strtod is exact, so the doubles survive intact; ten lines of
// indented JSON per animation frame would not survive the reviewer.
const PROGRAM = String.raw`
(function () {
  "use strict";
  const Playback = (0, eval)(
    "(function(){" + __playbackSource + "\n return Playback; })"
  )();
  const I = Playback.__internals;

  const encodeLine = (coords) => coords.map((c) => c[0] + " " + c[1]).join(";");
  const encodeRow = (values) => values.map((v) => "" + v).join(" ");

  // ── geometry pool ────────────────────────────────────────────────────
  // The same ride geometry appears in many cases (every synthetic variant is
  // an edit of one real route), and inlining it each time would multiply the
  // file for no extra coverage.
  const geometries = [];
  const geometryIds = new Map();
  function poolGeometry(geometry) {
    const lines = !geometry
      ? []
      : geometry.type === "LineString"
        ? [geometry.coordinates]
        : geometry.type === "MultiLineString"
          ? geometry.coordinates
          : [];
    const encoded = lines.map(encodeLine);
    const key = (geometry ? geometry.type : "null") + " " + encoded.join(" ");
    if (geometryIds.has(key)) return geometryIds.get(key);
    const id = geometries.length;
    geometries.push({ id: id, type: geometry ? geometry.type : null, lines: encoded });
    geometryIds.set(key, id);
    return id;
  }

  // One route feature as the port has to receive it. ride_segment is recorded
  // RAW, including the truthy-but-not-true spellings the adversarial cases
  // inject: the filter is "=== true", and that is the point. segment_index is
  // recorded twice — raw, and as the Number(x ?? -1) the JavaScript coerces
  // it to — because that coercion is type juggling on a JSON value, which is
  // the decoding shell's job in Swift rather than the ported function's.
  function serializeFeature(feature) {
    const props = (feature && feature.properties) || {};
    const raw = props.segment_index;
    return {
      geometry: poolGeometry(feature && feature.geometry),
      rideSegment: props.ride_segment === undefined ? null : props.ride_segment,
      segmentIndexRaw: raw === undefined ? null : raw,
      segmentIndex: Number(raw !== undefined && raw !== null ? raw : -1),
    };
  }

  function serializePath(p) {
    if (!p) return null;
    return {
      zoom: p.zoom,
      duration: p.duration,
      totalMeters: p.totalMeters,
      color: p.color,
      trainId: p.trainId,
      start: p.start,
      end: p.end,
      // The run COUNT is checked as hard as the contents: a port that
      // concatenates across a hole produces one run and a plausible total.
      // cum is recorded in full because every position on the timeline is
      // interpolated out of it, so a divergence anywhere in it is a
      // divergence in the answer.
      runs: p.runs.map((r) => ({
        offset: r.offset,
        total: r.total,
        coordCount: r.coords.length,
        coords: encodeLine(r.coords),
        cum: encodeRow(r.cum),
      })),
      // s0 s1 meters segIndex t0 t1
      hops: p.hops.map((h) => encodeRow([h.s0, h.s1, h.meters, h.segIndex, h.t0, h.t1])),
      stations: p.stations.map((s) => ({
        s: s.s, coord: s.coord, color: s.color, name: s.name,
      })),
    };
  }

  // ── the timeline sweep ───────────────────────────────────────────────
  //
  // A fixture that checks only the start and end of a journey proves almost
  // nothing about a timeline: distanceAtTime is piecewise linear with one
  // piece per ridden interval, and BOTH endpoints are short-circuited by the
  // "t <= 0" / "t >= duration" guards, so neither ever reaches the binary
  // search the function is made of. These do.
  function timelineTimes(p) {
    const set = new Set();
    const add = (t) => { if (Number.isFinite(t)) set.add(t); };
    const N = 400;
    for (let i = 0; i <= N; i += 1) add((p.duration * i) / N);
    for (const h of p.hops) {
      add(h.t0);
      add(h.t1);
      add(h.t0 + (h.t1 - h.t0) / 2);
      // "t1 < t" versus "t1 <= t" is a one-character difference that only
      // shows up within one ULP of a boundary.
      add(h.t1 + Number.EPSILON * Math.max(1, h.t1));
      add(h.t1 - Number.EPSILON * Math.max(1, h.t1));
    }
    add(-1); add(-Number.MIN_VALUE); add(0);
    add(p.duration); add(p.duration * (1 + Number.EPSILON)); add(p.duration * 2);
    return [...set].sort((a, b) => a - b);
  }

  // Arc distances worth asking about directly, independent of the clock.
  function timelineDistances(p) {
    const set = new Set([
      -1, 0, p.totalMeters / 2, p.totalMeters, p.totalMeters + 1, p.totalMeters * 2,
    ]);
    for (const r of p.runs) {
      set.add(r.offset);
      set.add(r.offset + r.total);
      set.add(r.offset - Number.EPSILON * Math.max(1, r.offset));
    }
    for (const s of p.stations) set.add(s.s);
    // Every vertex boundary of the first run and every midpoint between two,
    // so the binary search is WALKED rather than sampled. Capped so the
    // Sunrise's 10 954 vertices do not dominate the file; the sweep above
    // already covers it densely in time.
    const first = p.runs[0];
    const stride = Math.max(1, Math.ceil(first.cum.length / 500));
    for (let i = 0; i < first.cum.length; i += stride) {
      set.add(first.offset + first.cum[i]);
      if (i + 1 < first.cum.length)
        set.add(first.offset + (first.cum[i] + first.cum[i + 1]) / 2);
    }
    return [...set].filter(Number.isFinite).sort((a, b) => a - b);
  }

  // t s lon lat runIndex runT
  function sampleTimeline(p) {
    return timelineTimes(p).map((t) => {
      const s = I.distanceAtTime(p, t);
      const c = I.positionAtDistance(p.runs, s);
      const rp = I.runProgressAtDistance(p.runs, s);
      return encodeRow([t, s, c ? c[0] : NaN, c ? c[1] : NaN, rp.index, rp.t]);
    });
  }

  // s lon lat runIndex runT
  function sampleDistances(p) {
    return timelineDistances(p).map((s) => {
      const c = I.positionAtDistance(p.runs, s);
      const rp = I.runProgressAtDistance(p.runs, s);
      return encodeRow([s, c ? c[0] : NaN, c ? c[1] : NaN, rp.index, rp.t]);
    });
  }

  // ── recorders, and a virtual clock ───────────────────────────────────
  const SHORT_SIDE = 900;
  let virtualNow = 0;
  performance = { now: () => virtualNow };

  let rafCallback = null;
  requestAnimationFrame = (fn) => { rafCallback = fn; return 1; };
  cancelAnimationFrame = () => { rafCallback = null; };

  let containerSide = SHORT_SIDE;
  const jumps = [];
  let head = null, progress = null, stationCursor = null;
  let center = { lng: 0, lat: 0 };
  let zoom = 5;
  const moveendHandlers = [];
  map = {
    getContainer: () => ({ clientWidth: containerSide, clientHeight: containerSide * 2 }),
    getCenter: () => center,
    getZoom: () => zoom,
    jumpTo: (opts) => {
      center = { lng: opts.center[0], lat: opts.center[1] };
      zoom = opts.zoom;
      jumps.push([opts.center[0], opts.center[1], opts.zoom]);
    },
    easeTo: (opts) => {
      if (opts.center) center = { lng: opts.center[0], lat: opts.center[1] };
      if (opts.zoom !== undefined) zoom = opts.zoom;
    },
    flyTo: () => {},
    fitBounds: () => {},
    stop: () => {},
    once: (name, fn) => { if (name === "moveend") moveendHandlers.push(fn); },
    on: () => {}, off: () => {},
  };
  // Which train the module is playing, straight from the module: beginTrain
  // announces it through RailMap.setSelected. Deriving it from resolveQueue
  // instead would mean re-implementing the queue rule here.
  let currentTrainId = null;
  // renderProgress writes the bar's own clamped fraction, which is the one
  // number of the frame that never reaches jumpTo.
  let barFraction = null;
  els.playbackProgressFill = {
    style: {
      set transform(value) {
        barFraction = Number(String(value).replace(/^scaleX\(|\)$/g, ""));
      },
      get transform() { return ""; },
    },
  };
  const stubs = {
    setSelected: (id) => { currentTrainId = id; },
    setPlaybackHead: (coord) => { head = coord ? [coord[0], coord[1]] : null; },
    setPlaybackTrail: () => {},
    setPlaybackProgress: (index, t) => { progress = [index, t]; },
    setPlaybackStations: () => {},
    setPlaybackStationIndex: (index, pulse) => { stationCursor = [index, pulse]; },
    clearPlayback: () => {},
  };
  for (const key of Object.keys(stubs)) RailMap[key] = stubs[key];

  // stop() ends by relaying out the endpoint labels — the one pass the map's
  // moveend handler skipped for every playback frame. That is presentation
  // and it needs the full I18N the sandbox does not carry, so it is silenced
  // here rather than half-stubbed: nothing it does can reach a recorded row.
  updateEndpointLabels = () => {};

  const byId = new Map(trainStore.trains.map((t) => [t.id, t]));

  // dt headLon headLat centerLon centerLat zoom runIndex runT stationIndex
  // stationPulse barFraction
  //
  // The rows are the module's OWN frame output: the camera columns are what
  // it passed to map.jumpTo, the head columns are what it passed to
  // setPlaybackHead, and the station columns are what it passed to
  // setPlaybackStationIndex. Driving it this way rather than re-deriving the
  // recurrence is the difference between checking the port and checking a
  // copy of the port.
  function recordFrame(dtMs) {
    virtualNow += dtMs;
    const fn = rafCallback;
    if (!fn) return null;
    rafCallback = null;
    jumps.length = 0;
    fn(virtualNow);
    if (!jumps.length) return null;  // the journey ended on this frame
    const jump = jumps[jumps.length - 1];
    return encodeRow([
      // The frame's TIMESTAMP, not its length. frame(now) derives dt from
      // (now - lastFrameMs) and then clamps it, so a fixture that recorded an
      // already-clamped dt would hide the clamp — which is the whole point of
      // the stalled runs.
      virtualNow,
      head[0], head[1],
      jump[0], jump[1], jump[2],
      progress[0], progress[1],
      stationCursor[0], stationCursor[1],
      barFraction,
    ]);
  }

  function driveFrames(trainId, frameCount, options) {
    options = options || {};
    selectedTrainId = trainId;
    focusedTrainId = null;
    virtualNow = 0;
    moveendHandlers.length = 0;
    if (!Playback.start()) throw new Error("playback did not arm for " + trainId);
    Playback.begin();
    // The intro ease is the one camera move a run waits for; firing its
    // moveend is what the browser does when the ease lands. (Nothing else in
    // the run waits for anything — that is the chase.)
    while (moveendHandlers.length) moveendHandlers.shift()();
    if (Playback.phase() !== "playing")
      throw new Error("playback did not start for " + trainId + ": " + Playback.phase());

    // runClock has just set lastFrameMs to performance.now(), i.e. to this.
    // The port needs it: the first dt of a run is measured from here.
    const startedAt = virtualNow;
    const p = I.compilePath(byId.get(trainId));
    const step = options.stepSeconds || p.duration / frameCount;
    const rows = [];
    for (let i = 0; i < frameCount; i += 1) {
      const dtMs = options.stalls && i in options.stalls ? options.stalls[i] : step * 1000;
      const row = recordFrame(dtMs);
      if (!row) break;
      rows.push(row);
    }
    Playback.stop();
    selectedTrainId = null;
    return { startedAt: startedAt, rows: rows };
  }

  // ── the chase, with something to chase ───────────────────────────────
  //
  // A single-train run begins with an INTRO: the camera is eased onto the
  // first frame and the clock waits for it, so camError is (0, 0) and the
  // chase has nothing to close. Every other hand-off does the opposite — it
  // starts the next journey IMMEDIATELY and lets the camera catch up, which
  // is the only place the pulled-back zoom arc and the offset decay actually
  // run. So the sequences below are the cases that cover the second law at
  // all; the per-train "frames" above cover the first.
  //
  // Each step records the camera state it BEGINS from, which is all a port
  // needs to reproduce it: the chase is (offset, zoom) and nothing else.
  const STEP_MS = 1000 / 60;
  function stepFrames(count) {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      const row = recordFrame(STEP_MS);
      if (!row) break;
      rows.push(row);
    }
    return rows;
  }
  function introStep(count) {
    // Snapshot before the frames run, because the first frame moves it.
    const before = {
      center: [center.lng, center.lat], zoom: zoom, id: currentTrainId, at: virtualNow,
    };
    const rows = stepFrames(count);
    return {
      kind: "intro", trainId: before.id, center: before.center, zoom: before.zoom,
      startedAt: before.at, frames: rows,
    };
  }

  const sequences = [];
  {
    // The queue is the whole list, in list order, so skip() performs the real
    // mid-queue hand-off: no camera animation, no gap between trains, and a
    // camError the size of the distance between two itineraries.
    selectedTrainId = null;
    focusedTrainId = null;
    selectedDate = ALL_DATES;
    virtualNow = 0;
    moveendHandlers.length = 0;
    if (!Playback.start()) throw new Error("the queue did not arm");
    Playback.begin();
    while (moveendHandlers.length) moveendHandlers.shift()();
    const steps = [introStep(30)];
    for (let n = 0; n < 3; n += 1) {
      const before = { center: [center.lng, center.lat], zoom: zoom, at: virtualNow };
      Playback.skip(1);
      steps.push({
        kind: "handoff",
        trainId: currentTrainId,
        center: before.center,
        zoom: before.zoom,
        startedAt: before.at,
        frames: stepFrames(90),
      });
    }
    Playback.stop();
    sequences.push({
      key: "queue_handoff",
      why:
        "Three mid-queue hand-offs in one run. Each one starts the next " +
        "journey immediately and leaves the camera hundreds of kilometres " +
        "behind, so the offset decay and the pulled-back catch-up zoom both " +
        "run for real — the arc a flyTo would have drawn, drawn for free " +
        "with the next train already moving underneath it. A port that " +
        "placed the camera on the train instead would match every " +
        "single-train frame above and none of these.",
      steps: steps,
    });
  }
  {
    // Pause hands the map back to the reader; wherever they leave it IS the
    // new offset, and the chase closes it from there rather than snapping.
    selectedTrainId = __syntheticBaseId;
    focusedTrainId = null;
    virtualNow = 0;
    moveendHandlers.length = 0;
    if (!Playback.start()) throw new Error("the pause case did not arm");
    Playback.begin();
    while (moveendHandlers.length) moveendHandlers.shift()();
    const steps = [introStep(40)];
    Playback.pause();
    // The reader drags the map to 東京 and zooms out.
    center = { lng: 139.7673, lat: 35.6809 };
    zoom = 6.5;
    const before = { center: [center.lng, center.lat], zoom: zoom, at: virtualNow };
    Playback.resume();
    steps.push({
      kind: "resume",
      trainId: currentTrainId,
      center: before.center,
      zoom: before.zoom,
      startedAt: before.at,
      frames: stepFrames(90),
    });
    Playback.stop();
    selectedTrainId = null;
    sequences.push({
      key: "pause_resume",
      why:
        "Paused, the map moved by hand to 東京 and zoomed out to 6.5, then " +
        "resumed. resume() re-derives camError from where the reader left " +
        "the camera and from the head's CURRENT position (elapsed, not the " +
        "journey start), and adopts the map's zoom as the smoothed track.",
      steps: steps,
    });
  }

  // ── the real itineraries ─────────────────────────────────────────────
  const featuresById = new Map();
  for (const t of trainStore.trains) featuresById.set(t.id, getMatchedRouteFeatures(t));

  const cases = [];
  for (const id of __caseIds) {
    const train = byId.get(id);
    const p = I.compilePath(train);
    cases.push({
      trainId: id,
      cacheKey: I.pathCacheKey(train),
      features: featuresById.get(id).map(serializeFeature),
      path: serializePath(p),
      samples: sampleTimeline(p),
      distanceSamples: sampleDistances(p),
      frames: driveFrames(id, 120),
      // A stalled frame must not teleport the marker: TUNE.MAX_FRAME_S caps
      // dt however long the gap really was. Frame 3 is a five-second stall,
      // and frame 5 is a zero-length one.
      stalledFrames: driveFrames(id, 8, { stalls: { 3: 5000, 5: 0 } }),
    });
  }

  // ── synthetic feature lists, edited out of real solved geometry ───────
  //
  // Nothing in the committed store has a hole in it, arrives as a
  // MultiLineString, repeats a vertex or lies about ride_segment. Without
  // these the run machinery — two runs, a global arc that skips the hole in
  // one frame, a station table that survives a dropped interval — is never
  // exercised at all.
  const base = featuresById.get(__syntheticBaseId);
  const clone = (f, patch) => ({
    type: "Feature",
    properties: Object.assign({}, f.properties, patch || {}),
    geometry: { type: f.geometry.type, coordinates: f.geometry.coordinates },
  });
  const asMultiWithGap = (f) => {
    const c = f.geometry.coordinates;
    const cut = Math.floor(c.length / 2);
    return {
      type: "Feature",
      properties: Object.assign({}, f.properties),
      geometry: { type: "MultiLineString", coordinates: [c.slice(0, cut), c.slice(cut + 1)] },
    };
  };
  const doubled = (f) => {
    const out = [];
    for (const c of f.geometry.coordinates) out.push([c[0], c[1]], [c[0], c[1]]);
    return {
      type: "Feature",
      properties: Object.assign({}, f.properties),
      geometry: { type: "LineString", coordinates: out },
    };
  };
  const pointFeature = (f) => ({
    type: "Feature",
    properties: Object.assign({}, f.properties),
    geometry: {
      type: "LineString",
      coordinates: [f.geometry.coordinates[0], f.geometry.coordinates[0]],
    },
  });
  const oneVertex = (f) => ({
    type: "Feature",
    properties: Object.assign({}, f.properties),
    geometry: { type: "LineString", coordinates: [f.geometry.coordinates[0]] },
  });
  const withoutSegmentIndex = (f) => {
    const c = clone(f);
    delete c.properties.segment_index;
    return c;
  };

  const synthetic = [
    {
      key: "hole_from_unridden_interval",
      why:
        "The middle interval of 大阪環状線 marked ride_segment:false. The arc " +
        "coordinate still concatenates — the hole contributes ZERO length, so " +
        "the head crosses it in one frame rather than sliding over open " +
        "country — but the geometry is two runs, and a port that joins them " +
        "draws a chord straight across the city.",
      features: base.map((f, i) => clone(f, i === 3 ? { ride_segment: false } : {})),
    },
    {
      key: "multilinestring_gap",
      why:
        "One interval arriving as a MultiLineString with a real hole in it " +
        "(geometry_role: single_path_with_gaps). A second run opens INSIDE a " +
        "single interval, so one hop spans both halves.",
      features: [asMultiWithGap(base[0])].concat(base.slice(1)),
    },
    {
      key: "duplicate_vertices",
      why:
        "Every vertex of the first interval repeated. The 'step <= 0' guard " +
        "must drop the second copy: a cum array with repeats gives the binary " +
        "search a zero-width span to divide by.",
      features: [doubled(base[0])].concat(base.slice(1)),
    },
    {
      key: "ride_segment_truthy",
      why:
        'ride_segment = 1 and "true". Truthy, and still unridden, because the ' +
        "filter is '=== true'. Nothing survives it, so compilePath returns " +
        "null and the queue skips the train.",
      features: base.map((f, i) => clone(f, { ride_segment: i % 2 ? 1 : "true" })),
    },
    {
      key: "no_segment_index",
      why:
        "segment_index absent throughout. Number(x ?? -1) is -1, no hop may " +
        "name a stop, and the journey plays with an EMPTY station list — " +
        "geometry without stations, not a failure.",
      features: base.map(withoutSegmentIndex),
    },
    {
      key: "zero_length_interval",
      why:
        "An interval whose geometry is one point repeated: two vertices, no " +
        "distance. 'globalS > hopStart' is false, so the hop is dropped " +
        "entirely — and the stop indexes either side of it stop being " +
        "consecutive, which is what the station table has to survive.",
      features: base.map((f, i) => (i === 2 ? pointFeature(f) : clone(f))),
    },
    {
      key: "single_vertex_line",
      why:
        "A line of one vertex. 'line.length < 2' skips it before it can open " +
        "a run, so it contributes neither geometry nor a run boundary — and " +
        "its hop disappears with it.",
      features: base.map((f, i) => (i === 1 ? oneVertex(f) : clone(f))),
    },
    {
      key: "all_unridden",
      why: "Every interval unridden: no hops, no geometry, compilePath returns null.",
      features: base.map((f) => clone(f, { ride_segment: false })),
    },
  ];

  // compilePath memoises on pathCacheKey, which a synthetic feature list does
  // not change (it is id + route template + ride flags). Swapping the
  // resolver alone would therefore be answered from the cache, so each
  // variant gets its own train id as well.
  const realGetMatched = getMatchedRouteFeatures;
  let injected = null;
  getMatchedRouteFeatures = function (train) {
    if (injected && injected.id === train.id) return injected.features;
    return realGetMatched(train);
  };
  const baseTrain = byId.get(__syntheticBaseId);
  const syntheticOut = [];
  for (const item of synthetic) {
    const train = Object.assign({}, baseTrain, { id: baseTrain.id + "__" + item.key });
    injected = { id: train.id, features: item.features };
    const p = I.compilePath(train);
    injected = null;
    syntheticOut.push({
      key: item.key,
      why: item.why,
      features: item.features.map(serializeFeature),
      stops: train.stops.map((s) => ({
        name: s.name, stopType: s.stop_type, rideSegment: s.ride_segment,
        code: s.n02_station_code === undefined ? null : s.n02_station_code,
      })),
      color: (train.style && train.style.color) || DEFAULT_TRAIN_COLOR,
      path: serializePath(p),
      samples: p ? sampleTimeline(p) : [],
      distanceSamples: p ? sampleDistances(p) : [],
    });
  }
  getMatchedRouteFeatures = realGetMatched;

  // ── catchUpZoom, asked directly ──────────────────────────────────────
  //
  // The chase converges within a few frames, so the interesting part of this
  // function — the pulled-back arc a cross-country hand-off draws, and the
  // Z_CATCHUP_MIN floor that is deliberately BELOW Z_MIN — is barely visible
  // in a frame track.
  const osaka = [135.5023, 34.7024];
  const catchUp = [];
  const catchUpInputs = [
    [osaka, osaka, 12],
    [[135.5033, 34.7024], osaka, 12],        // ~90 m: under the 200 m floor
    [[135.5053, 34.7024], osaka, 12],        // ~275 m: just over it
    [[139.7673, 35.6809], osaka, 12],        // 東京, ~400 km
    [[139.7673, 35.6809], osaka, 8.2],
    [[135.51, 34.7024], osaka, 15.4],
    [[136.5, 34.7024], osaka, 10],
    [[135.5023, 89.9], [135.5023, 89.9], 12], // cos(lat) near zero
    [[135.5023, -34.7024], [135.5023, -34.7], 12],
  ];
  for (const input of catchUpInputs)
    for (const side of [0, 100, 240, 900, 4000]) {
      containerSide = side;
      catchUp.push({
        center: input[0], train: input[1], target: input[2], shortSide: side,
        zoom: I.catchUpZoom(input[0], input[1], input[2]),
      });
    }
  containerSide = SHORT_SIDE;

  // ── setSpeed's quantisation ──────────────────────────────────────────
  // -0.625 / 0.25 is -2.5, and Math.round ties toward +Infinity (-2), while
  // Swift's .rounded() ties away from zero (-3). Same for 1.125 / 0.25 = 4.5.
  const speeds = [];
  for (const value of [
    0, 0.1, 0.3, 0.375, 0.5, 0.625, -0.625, 1, 1.125, 1.2, 2.5, 3.9, 4, 10, -1, null, "2.25",
  ])
    speeds.push({ input: value, speed: Playback.setSpeed(value) });
  Playback.setSpeed(1);

  // ── prepare(): what a whole run costs ────────────────────────────────
  const plans = [];
  for (const speed of [0.5, 1, 2.5, 4]) {
    Playback.setSpeed(speed);
    // A queue of one, per train.
    for (const id of __caseIds) {
      selectedTrainId = id;
      const answer = Playback.prepare();
      plans.push({ scope: id, speed: speed, trains: answer.trains, skipped: answer.skipped, seconds: answer.seconds });
    }
    // …and the whole store, which is where the (playable - 1) terminus holds
    // enter the arithmetic.
    selectedTrainId = null;
    focusedTrainId = null;
    selectedDate = ALL_DATES;
    const all = Playback.prepare();
    plans.push({ scope: "__all__", speed: speed, trains: all.trains, skipped: all.skipped, seconds: all.seconds });
  }
  Playback.setSpeed(1);
  selectedTrainId = null;

  // ── V8's own arithmetic, on this module's own inputs ─────────────────
  //
  // PORTING.md: measure before reaching for JSMath, and say what you
  // measured. V8 answers Math.pow, Math.exp, Math.log2 and Math.cos from its
  // own fdlibm port rather than from the platform, so on a few per cent of
  // real inputs Darwin's libm is 1 ULP away. Which of those four (if any)
  // matters here cannot be read off the totals above, because a divergence in
  // an interval time could equally be Math.pow or the metres fed into it.
  // These rows isolate them: same input, V8's answer, one function at a time.
  //
  // The inputs are the values this module actually computes — hop lengths,
  // frame deltas, the zoom argument, the latitudes — not a sweep.
  const libm = { pow: [], exp: [], log2: [], cos: [] };
  const seen = { pow: new Set(), exp: new Set(), log2: new Set(), cos: new Set() };
  const addLibm = (kind, x, y) => {
    if (!Number.isFinite(x) || seen[kind].has(x)) return;
    seen[kind].add(x);
    libm[kind].push({ x: x, y: y });
  };
  const allPaths = [];
  for (const id of __caseIds) allPaths.push(I.compilePath(byId.get(id)));
  for (const item of syntheticOut) if (item.path) allPaths.push(item.path);
  for (const p of allPaths) {
    if (!p) continue;
    for (const h of p.hops) addLibm("pow", h.meters, Math.pow(h.meters, Playback.TUNE.HOP_EXP));
    for (const s of p.stations) addLibm("cos", s.coord[1] * I.DEG, Math.cos(s.coord[1] * I.DEG));
    // The zoom argument, regenerated from the compiled path. This is input
    // generation, not a second opinion: what is recorded is Math.log2's
    // answer, and it is compared against the port's log2 of the same double.
    const mid = I.positionAtDistance(p.runs, p.totalMeters / 2);
    const lat = mid ? mid[1] : 36;
    addLibm("cos", lat * I.DEG, Math.cos(lat * I.DEG));
    const speed = p.totalMeters / Math.max(0.001, p.duration);
    const arg =
      (I.MPP_ZOOM0 * Math.cos(lat * I.DEG)) /
      Math.max(0.05, speed / Playback.TUNE.V_PX);
    addLibm("log2", arg, Math.log2(arg));
  }
  for (const item of catchUp) {
    addLibm("cos", item.train[1] * I.DEG, Math.cos(item.train[1] * I.DEG));
    addLibm("log2", Math.pow(2, item.zoom), Math.log2(Math.pow(2, item.zoom)));
  }
  // Every frame delta the recorded runs produce, through both time constants.
  const deltas = new Set();
  const collect = (run, startedAt) => {
    let previous = startedAt;
    for (const row of run) {
      const now = Number(row.split(" ")[0]);
      deltas.add(Math.min(Playback.TUNE.MAX_FRAME_S, Math.max(0, (now - previous) / 1000)));
      previous = now;
    }
  };
  for (const item of cases) {
    collect(item.frames.rows, item.frames.startedAt);
    collect(item.stalledFrames.rows, item.stalledFrames.startedAt);
  }
  for (const sequence of sequences)
    for (const step of sequence.steps) collect(step.frames, step.startedAt);
  for (const dt of deltas) {
    addLibm("exp", -dt / Playback.TUNE.CENTER_TAU, Math.exp(-dt / Playback.TUNE.CENTER_TAU));
    addLibm("exp", -dt / Playback.TUNE.ZOOM_TAU, Math.exp(-dt / Playback.TUNE.ZOOM_TAU));
  }

  return JSON.stringify({
    libm: libm,
    tuning: Playback.TUNE,
    mppZoom0: I.MPP_ZOOM0,
    degreesToRadians: I.DEG,
    geometries: geometries,
    cases: cases,
    sequences: sequences,
    synthetic: syntheticOut,
    catchUp: catchUp,
    speeds: speeds,
    plans: plans,
  });
})()
`;

// ── run it ──────────────────────────────────────────────────────────────

const store = readJson(path.join(DATA_DIR, "train-store.json"));
const selected = CASES.map((entry) => {
  const train = store.trains.find((t) => t.id === entry.id);
  if (!train)
    throw new Error(
      `train-store.json no longer contains ${entry.id}. This fixture pins ` +
        `itineraries by id for a stated reason, so replace it with one that ` +
        `has the same property rather than dropping the case.`,
    );
  return train;
});

const context = makeSandbox({ userAgent: "node-port-fixtures" });
evaluateAppScripts(context, readOrderedAppScripts());

context.__host = {
  country: "jp",
  railSections: readJson(path.join(DATA_DIR, "rail-sections.json")),
  stations: readJson(path.join(DATA_DIR, "stations.json")),
  matchedStops: readJson(path.join(DATA_DIR, "matched-stops.json")),
  // The offline fallback for trains the solver cannot route. Every case here
  // solves, so it is never consulted; passing the real file keeps the adapter
  // on the same path the precompute build takes.
  matchedRoutes: readJson(path.join(DATA_DIR, "matched-routes.json")),
  trainStoreText: JSON.stringify({ ...store, trains: selected }),
  onTrainSolved() {},
};
await vm.runInContext("globalThis.PrecomputeAdapter.solveStore(__host)", context, {
  filename: "playback-fixture-driver.js",
});

context.__playbackSource = patchedPlaybackSource();
context.__caseIds = CASES.map((entry) => entry.id);
context.__syntheticBaseId = SYNTHETIC_BASE_ID;

const payload = JSON.parse(
  vm.runInContext(PROGRAM, context, { filename: "playback-fixture.js" }),
);

const why = new Map(CASES.map((entry) => [entry.id, entry.why]));

export function build() {
  return {
    describes:
      "app-playback.js §3/§6 — the playback timeline, its geometry and its camera",
    contract:
      "ONE zoom per journey, never per interval: the pace a reader sees " +
      "between stations lives in the time split (share ∝ metres^HOP_EXP), " +
      "not in the scale. And the camera is a CHASE — every frame decays the " +
      "offset between camera and train while feeding the train's own motion " +
      "forward untouched — so a change of train is a change of what is " +
      "chased rather than an animation the run waits out, and nothing here " +
      "waits for tiles.",
    rowFormats: {
      coords: "lon lat;lon lat;… (one run's vertices)",
      cum: "metres metres … (cumulative from the run's own start, one per vertex)",
      hops: "s0 s1 meters segIndex t0 t1",
      samples: "t s lon lat runIndex runT",
      distanceSamples: "s lon lat runIndex runT",
      frames:
        "now headLon headLat centerLon centerLat zoom runIndex runT stationIndex "
        + "stationPulse barFraction — `now` is the frame's TIMESTAMP in ms, "
        + "measured against the run's `startedAt`, because frame(now) derives "
        + "dt from the gap and then clamps it to MAX_FRAME_S",
    },
    libm: payload.libm,
    tuning: payload.tuning,
    mppZoom0: payload.mppZoom0,
    degreesToRadians: payload.degreesToRadians,
    geometries: payload.geometries,
    cases: payload.cases.map((item) => ({ ...item, why: why.get(item.trainId) })),
    sequences: payload.sequences,
    synthetic: payload.synthetic,
    catchUp: payload.catchUp,
    speeds: payload.speeds,
    plans: payload.plans,
  };
}
