// =========================================================================
//  station-join-smoothing.json — the pass that rounds the shared endpoints
//  where two corridor curves meet at a station.
//
//  `smoothCurveStationJoins` (app-overlap-lanes.js §2041) with the two
//  functions it exists to call, `refreshFittedCurveGeometry` (§1527) and
//  `rebuildLimitedDirectionField` (§1597). This is the seam the overlap-lanes
//  fixture and `OverlapLanes.swift` both named and left open: the pass runs
//  after the corridor phase, assigns `gi.curve` and nothing else, and every
//  other field those two files pin is already the JavaScript's final value.
//
//  ── how the answers are produced ────────────────────────────────────────
//
//  Nothing here re-implements anything. Two sources of input, both real:
//
//    real/       the whole frontend classic-script family evaluated in the
//                same Node `vm` sandbox the offline precompute uses, the
//                committed train stores solved through the app's own
//                PrecomputeAdapter, and `buildDeckRouteRecords` run for
//                real. The pass itself is captured by DELEGATION: the global
//                is replaced by a wrapper that snapshots `groupInfo` before
//                the real function runs and again after, so what is pinned is
//                the exact groupInfo the app hands it and the exact
//                assignment it makes. This is the same curated ride list the
//                overlap-lanes fixture uses, for the same reason — overlap
//                lanes only exist where several rides genuinely coincide.
//
//    synth/      mirrors of the shape the fit worker builds
//                (`runFitCurveJobs`, §2146: a curve, its train membership and
//                its two snapped-node keys), assembled from SHIPPED PACKAGE
//                geometry — real display parts of real railways, sliced at
//                their shared endpoints and fitted by the real
//                `smoothCorridorCurveUncached`. Every one of them was chosen
//                by sweeping the shared endpoints of the shipped packages —
//                190 of them in jp, 9 in tw — and keeping the ones that reach
//                a branch the real scenarios do not.
//
//  The pass reads no globals and no settings: `smoothJoinedStationCurve`
//  takes its radius, detail and deviation budgets from the TEMPLATE curve's
//  own fields. So the four fit-curve sliders appear here only as a way to
//  produce differently-constrained input curves, never as an input to the
//  function under test — which is why the port needs no settings argument.
//
//  ── the branches, and which case reaches each ───────────────────────────
//
//  Measured by instrumenting `stationJoinConstraintReport` over 260 mirrors
//  built from every shared endpoint in the jp package under five slider
//  settings. The verdict distribution was:
//
//      radius ok, deviation ok, direction ok        189
//      radius short but RELAXED and accepted         32
//      radius short, rejected                        24
//      radius + deviation short, rejected            10
//      deviation short only, rejected                 5
//      direction short                                0
//
//  `direction` is unreachable, and not by accident: `rebuildLimitedDirection
//  Field` clamps every step to `minRadius * 1.03` and then reports the
//  achieved radius of what it just clamped, so it cannot return a value below
//  `minRadius` unless two consecutive points sit at the same arc length.
//  It is ported anyway — the port reproduces the code, not the reachable
//  subset of it — and the fixture records the count so a future change that
//  makes it reachable shows up as a moved answer rather than as nothing.
//
//  The synthetic cases named below cover: the cycle (never emitted, needs a
//  periodic solver), the ambiguity margin (a fork whose two prongs are
//  equally plausible joins to nothing), a fork where one prong does win, a
//  node-id match, the geometric fallback when node keys are absent, a
//  node-id match rejected on distance, curves too short to have endpoints at
//  all, a curve shared by two groups, and a mirror too small to run.
// =========================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const name = "station-join-smoothing.json";

// The curated rides. Duplicated from overlap-lanes.mjs rather than imported,
// because that module exports `name` and `build` only, and adding an export
// to it would be an edit to a file another port owns. The lists must stay
// the same list: the seam this fixture closes is measured on the scenario
// that one pins, and "9 of 17 groups" is only checkable against it.
const CURATED = {
  jp: [
    "20260704_03_keikyu_asakusa_line",
    "20260704_04_oedo_line",
    "20260704_05_mita_line",
    "20260704_06_marunouchi_line",
    "20260704_07_saikyo_line",
    "20260704_08_shonan_shinjuku_line",
    "20260704_09_negishi_line",
    "20260704_10_minatomirai_line",
    "20260704_11_keihin_tohoku_line",
    "20260704_12_yokohama_line",
    "20260705_03_chuo_line",
    "20260705_04_chuo_sobu_line",
    "20260705_07_yamanote_line",
  ],
  tw: [
    "20260805_02_tra_local_3262_xinwuri_taichung",
    "20260806_01_tra_tze_chiang_3000_137_taichung_changhua",
    "20260806_02_tra_local_2204_changhua_taichung",
    "20260810_01_krtc_red_kaohsiung_gangshan_station",
    "20260810_02_krtc_red_gangshan_station_siaogang",
    "20260810_03_krtc_red_siaogang_sanduo",
    "20260810_04_krtc_red_sanduo_kaisyuan",
    "20260810_05_klrt_c3_counterclockwise_loop",
    "20260810_06_krtc_red_kaisyuan_kaohsiung",
    "20260812_01_krtc_red_kaohsiung_zuoying",
    "20260813_01_star_of_taiwan_round_island_loop",
  ],
};

const DATASETS = {
  jp: { sections: "rail-sections.json", stations: "stations.json", store: "train-store.json" },
  tw: {
    sections: "rail-sections-tw.json",
    stations: "stations-tw.json",
    store: "train-store-tw.json",
  },
};

// ── the synthetic mirrors ───────────────────────────────────────────────
//
// `sharedNode` names a snapped node key at which two or more display parts
// of the shipped package end. Each participating part is sliced to `slice`
// vertices FROM that end and fitted; the mirror is those curves, all sharing
// one train id, each stamped with its own two node keys. Every node key
// below was found by sweeping the package, not invented — the comment on
// each says which branch it is here for.
//
// `chunks` cuts ONE display part into consecutive pieces instead, which is
// the only way to build a cycle: three chunks of a closed loop line connect
// end-to-end-to-end and close, and `walkStationJoinChains` must then emit
// nothing at all rather than cut the ring at an arbitrary edge.
export const SYNTHETIC = {
  jp: [
    {
      // 博多: 九州新幹線, 博多南線 and 山陽新幹線 all end here, and the two
      // best candidate pairs score within the 50-point ambiguity margin of
      // one another. selectOneToOneEndpointPairs drops BOTH ends rather than
      // joining whichever happened to sort first, so nothing joins.
      label: "fork-ambiguous-hakata",
      kind: "sharedNode",
      nodeKey: "130.42118,33.58958",
      slice: 150,
    },
    {
      // 立野: 豊肥線's two parts plus 高森線. Three candidate pairs, one
      // selected — the fork case where a prong DOES win, and the winning
      // chain is then accepted under the relaxed radius floor.
      label: "fork-resolved-tateno",
      kind: "sharedNode",
      nodeKey: "130.96514,32.87763",
      slice: 150,
    },
    {
      // 新神戸/三宮 area: 神戸市営 山手線 meets 西神線 at 74.8°, and the
      // station-continuous refit cannot hold the requested radius. The only
      // constraint it misses is the radius and it misses it by too much for
      // STATION_JOIN_RADIUS_RELAX, so the chain is REJECTED and both member
      // curves keep their own spline. This is the failure report.
      label: "reject-radius-kobe",
      kind: "sharedNode",
      nodeKey: "135.14566,34.65832",
      slice: 150,
    },
    {
      // 万葉線 新湊港線 meets 高岡軌道線. Radius short, but within
      // STATION_JOIN_RADIUS_RELAX × requested with both other constraints
      // met — the relaxation branch, which stamps the accepted floor on the
      // curve so diagnostics measure against what was accepted.
      label: "relax-radius-manyo",
      kind: "sharedNode",
      nodeKey: "137.06597,36.78883",
      slice: 150,
      base: true,
    },
    {
      // The same join with the deviation budget turned down to 1500 m: now
      // it misses BOTH constraints, so the failure reason is the joined
      // "radius+deviation" rather than either alone.
      label: "reject-radius-deviation-manyo",
      kind: "sharedNode",
      nodeKey: "137.06597,36.78883",
      slice: 150,
      settings: { fitCurveMaxDeviation: 1500 },
    },
    {
      // 成田線 area, deviation budget 1500 m: the refit holds the radius and
      // the direction field but wanders 1547 m from the raw railway, so the
      // reason is "deviation" ALONE. The one case that separates the three
      // constraints from one another.
      label: "reject-deviation-narita",
      kind: "sharedNode",
      nodeKey: "140.38725,35.76969",
      slice: 150,
      settings: { fitCurveMaxDeviation: 1500 },
    },
    {
      // 名城線 is Nagoya's loop, but its display part does NOT close (6.3 km
      // apart), so cutting it in three gives a three-curve OPEN chain: two
      // join edges, a component of length 3, and a failure report carrying
      // both of them.
      label: "chain-of-three-meijo",
      kind: "chunks",
      lineId: "jp-名古屋市-4号線名城線",
      part: 0,
      count: 3,
    },
  ],
  tw: [
    {
      // 高雄環狀輕軌 closes exactly (its first and last vertex are the same
      // point), so three chunks of it form a ring. Every curve is connected
      // on both sides, no walk ever starts, and the ring is marked visited
      // and never emitted. Zero joins, zero failures, nothing changed — the
      // one outcome that looks identical to "nothing matched" and is not.
      label: "cycle-klrt",
      kind: "chunks",
      lineId: "tw-klrt-c",
      part: 0,
      count: 3,
    },
    {
      // 花蓮: 北迴線 meets 臺東線. A plain two-curve join under the tw
      // package's own coordinate distribution.
      label: "pair-hualien",
      kind: "sharedNode",
      nodeKey: "121.60079,23.99261",
      slice: 150,
      base: true,
    },
    {
      // 阿里山 沼平/祝山: FOUR display parts end at one node — the switchback
      // the repository has its own repair script for. Every pair either
      // folds back on itself or turns too hard, so the candidate list comes
      // out EMPTY and four curves at one station join nothing.
      label: "fork-none-alishan",
      kind: "sharedNode",
      nodeKey: "120.80501,23.51062",
      slice: 150,
    },
  ],
};

// ── the driver ──────────────────────────────────────────────────────────
//
// Runs INSIDE the sandbox. Every value it returns came out of a frontend
// function; this code calls them and copies what they answered.
const DRIVER = `(() => {
  const ids = __IDS__;
  const SYNTHETIC = __SYNTHETIC__;

  const flat = (line) => {
    const out = [];
    for (const p of line) out.push(p[0], p[1]);
    return out;
  };
  // Every field smoothJoinedStationCurve spreads out of its template, so a
  // port fed this back reconstructs the exact object the JavaScript held.
  const curveFields = (c) => ({
    pts: flat(c.pts),
    cum: c.cum,
    dirs: flat(c.dirs),
    totalMeters: c.totalMeters,
    sourceTotalMeters: c.sourceTotalMeters,
    endpointChordMeters: c.endpointChordMeters,
    radiusMeters: c.radiusMeters,
    smoothingSigmaMeters: c.smoothingSigmaMeters,
    directionSigmaMeters: c.directionSigmaMeters,
    requestedMinRadiusMeters: c.requestedMinRadiusMeters,
    achievedMinRadiusMeters: c.achievedMinRadiusMeters,
    achievedDirectionRadiusMeters: c.achievedDirectionRadiusMeters,
    minDetailMeters: c.minDetailMeters,
    maxDeviationMeters: c.maxDeviationMeters,
    actualMaxDeviationMeters: c.actualMaxDeviationMeters,
    samplingPrecision: c.samplingPrecision,
    fitType: c.fitType,
    coslat: c.coslat,
  });
  const curveIn = (c) => ({
    ...curveFields(c),
    // curve._sourceLines — the raw railway geometry the deviation check
    // measures against. The Swift FittedCurve does not carry it (it is the
    // fit's input), so the port takes it beside the curve.
    sourceLines: (c._sourceLines || []).map(flat),
  });
  const curveOut = (c) => ({
    ...curveFields(c),
    sourceLineLengths: (c._sourceLines || []).map((l) => l.length),
    finalDeviationValid: Boolean(c._finalDeviationValid),
    finalDirectionValid: Boolean(c._finalDirectionValid),
    stationSmoothingPasses: c.stationSmoothingPasses ?? null,
    stationJoinRadiusRelaxed: Boolean(c.stationJoinRadiusRelaxed),
    acceptedMinRadiusMeters: c.acceptedMinRadiusMeters ?? null,
    stationJoinCount: c.stationJoinCount ?? null,
    stationJoinOriginalMaxDeg: c.stationJoinOriginalMaxDeg ?? null,
    stationJoinMaxGapMeters: c.stationJoinMaxGapMeters ?? null,
    stationJoinIdMatchedCount: c.stationJoinIdMatchedCount ?? null,
  });

  // Snapshot a groupInfo the way the pass sees it: curve IDENTITY matters
  // (several groups may share one object, and the pass keys three Maps and a
  // Set on it), so curves are numbered by first appearance and groups carry
  // the number rather than a copy.
  const snapshot = (groupInfo) => {
    const index = new Map();
    const curves = [];
    const groups = [];
    groupInfo.forEach((gi, groupKey) => {
      let curveIndex = -1;
      if (gi.curve) {
        if (!index.has(gi.curve)) {
          index.set(gi.curve, curves.length);
          curves.push(gi.curve);
        }
        curveIndex = index.get(gi.curve);
      }
      groups.push({
        groupKey,
        curve: curveIndex,
        trainIds: Object.keys(gi.mults || {}),
        // Absent is not the same as empty: collectStationJoinEndpoints takes
        // the first owner whose property is TRUTHY, and [] is truthy.
        endpointNodeKeys: gi._curveEndpointNodeKeys
          ? gi._curveEndpointNodeKeys.map((k) => (k == null ? null : String(k)))
          : null,
      });
    });
    return { index, curves, groups };
  };

  // Run the real pass over a real groupInfo and record both sides of it.
  const capture = (groupInfo, run) => {
    const before = snapshot(groupInfo);
    const result = run();
    const failureIds = new Map();
    result.failures.forEach((f, i) => failureIds.set(f, i));
    const joined = [];
    const joinedIds = new Map();
    const after = [];
    groupInfo.forEach((gi) => {
      let ref = -1;
      if (gi.curve) {
        if (before.index.has(gi.curve)) ref = before.index.get(gi.curve);
        else {
          if (!joinedIds.has(gi.curve)) {
            joinedIds.set(gi.curve, joined.length);
            joined.push(gi.curve);
          }
          ref = before.curves.length + joinedIds.get(gi.curve);
        }
      }
      after.push({
        curve: ref,
        failure: gi.stationJoinFailure ? failureIds.get(gi.stationJoinFailure) ?? -1 : -1,
      });
    });
    return {
      curves: before.curves.map(curveIn),
      groups: before.groups,
      expected: {
        roundedJoins: result.roundedJoins,
        failures: result.failures.map((f) => ({
          reason: f.reason,
          joins: f.joins,
          groupKeys: f.groupKeys,
          requestedMinRadiusM: f.requestedMinRadiusM,
          achievedMinRadiusM: f.achievedMinRadiusM,
          maxDeviationM: f.maxDeviationM,
          actualMaxDeviationM: f.actualMaxDeviationM,
        })),
        joined: joined.map(curveOut),
        groups: after,
      },
    };
  };

  // ── the real scenario ──
  const trains = ids.map((id) => getTrain(id)).filter(Boolean);
  if (trains.length !== ids.length)
    throw new Error("curated train missing from the solved store");
  trains.sort(compareTrainsByDateAndDeparture);
  const items = buildRouteItems(trains);
  let realCase = null;
  const realPass = smoothCurveStationJoins;
  globalThis.smoothCurveStationJoins = function (groupInfo) {
    let answer = null;
    realCase = capture(groupInfo, () => (answer = realPass(groupInfo)));
    return answer;
  };
  try {
    buildDeckRouteRecords(items);
  } finally {
    globalThis.smoothCurveStationJoins = realPass;
  }
  if (!realCase) throw new Error("the station-join pass never ran");

  // ── the synthetic mirrors ──
  const pkg = __package;
  const parts = [];
  (pkg.lines || []).forEach((line) => {
    let ps;
    try {
      ps = RailNetwork.displayPartsForLine(line);
    } catch (error) {
      return;
    }
    (ps || []).forEach((p, i) => {
      if (p && p.length >= 4) parts.push({ lineId: line.id, part: i, pts: p });
    });
  });
  const partsByNode = new Map();
  parts.forEach((pt, index) => {
    [[0, pt.pts[0]], [1, pt.pts[pt.pts.length - 1]]].forEach(([side, p]) => {
      const key = overlapNodeKey(p);
      if (!partsByNode.has(key)) partsByNode.set(key, []);
      partsByNode.get(key).push({ index, side });
    });
  });
  // Slice a display part so the shared endpoint is vertex 0 of the slice.
  const sliceFrom = (pts, side, n) =>
    side === 0
      ? pts.slice(0, Math.min(n, pts.length))
      : pts.slice(Math.max(0, pts.length - n)).reverse();
  const partOf = (lineId, part) => {
    const found = parts.find((p) => p.lineId === lineId && p.part === part);
    if (!found) throw new Error("display part missing: " + lineId + "#" + part);
    return found.pts;
  };
  const fitWith = (settings, lines) => {
    const saved = { ...APPLIED_FIT_CURVE_SETTINGS };
    Object.keys(APPLIED_FIT_CURVE_SETTINGS).forEach((k) => {
      delete APPLIED_FIT_CURVE_SETTINGS[k];
    });
    Object.assign(APPLIED_FIT_CURVE_SETTINGS, saved, settings || {});
    try {
      // The UNCACHED entry point: the memo in front of it hands out clones
      // and would only test itself.
      return lines.map((line) => smoothCorridorCurveUncached(line));
    } finally {
      Object.keys(APPLIED_FIT_CURVE_SETTINGS).forEach((k) => {
        delete APPLIED_FIT_CURVE_SETTINGS[k];
      });
      Object.assign(APPLIED_FIT_CURVE_SETTINGS, saved);
    }
  };
  // The mirror the fit worker builds (runFitCurveJobs §2146): a curve, its
  // train membership, its two snapped-node keys.
  const mirrorOf = (entries) => {
    const mirror = new Map();
    entries.forEach((entry) => {
      mirror.set(entry.groupKey, {
        curve: entry.curve,
        mults: Object.fromEntries((entry.trainIds || []).map((id) => [id, 0])),
        _curveEndpointNodeKeys: entry.nodeKeys,
      });
    });
    return mirror;
  };
  const runMirror = (label, entries) => {
    const mirror = mirrorOf(entries);
    return { label, ...capture(mirror, () => smoothCurveStationJoins(mirror)) };
  };
  const nodeKeysOf = (line) => [
    overlapNodeKey(line[0]),
    overlapNodeKey(line[line.length - 1]),
  ];

  const synthetic = [];
  SYNTHETIC.forEach((spec) => {
    if (spec.kind === "sharedNode") {
      const members = partsByNode.get(spec.nodeKey);
      if (!members || members.length < 2)
        throw new Error("no shared endpoint at " + spec.nodeKey);
      const lines = members
        .map((m) => sliceFrom(parts[m.index].pts, m.side, spec.slice))
        .filter((line) => line.length >= 4);
      const curves = fitWith(spec.settings, lines);
      const entries = [];
      curves.forEach((curve, i) => {
        if (!curve) return;
        entries.push({
          groupKey:
            parts[members[i].index].lineId + "#" + parts[members[i].index].part +
            "/" + members[i].side,
          curve,
          trainIds: ["T1"],
          nodeKeys: spec.nodeKeys === false ? null : nodeKeysOf(lines[i]),
        });
      });
      synthetic.push(runMirror(spec.label, entries));
      return;
    }
    if (spec.kind === "chunks") {
      const pts = partOf(spec.lineId, spec.part);
      const step = Math.floor(pts.length / spec.count);
      const lines = [];
      for (let i = 0; i < spec.count; i += 1)
        lines.push(
          i === spec.count - 1
            ? pts.slice(i * step)
            : pts.slice(i * step, (i + 1) * step + 1),
        );
      const curves = fitWith(spec.settings, lines);
      const entries = [];
      curves.forEach((curve, i) => {
        if (!curve) return;
        entries.push({
          groupKey: spec.lineId + "#" + spec.part + "@" + i,
          curve,
          trainIds: ["T1"],
          nodeKeys: nodeKeysOf(lines[i]),
        });
      });
      synthetic.push(runMirror(spec.label, entries));
      return;
    }
    throw new Error("unknown synthetic kind: " + spec.kind);
  });

  // ── the mirrors built to fail ──
  //
  // Each is the same real pair of curves, rearranged into a shape the real
  // pipeline cannot produce but the function must survive. A port that
  // passes the cases above and fails one of these is a port that guessed.
  const base = (() => {
    // The pair every mirror below is a rearrangement of. It has to be one
    // that JOINS under the ordinary rules, or "no shared trains" and "no
    // node keys" would prove nothing: a pair that was never going to join
    // does not join for a reason the case is not about.
    const spec = SYNTHETIC.find((s) => s.base) ||
      SYNTHETIC.find((s) => s.kind === "sharedNode");
    const members = partsByNode.get(spec.nodeKey);
    const lines = members
      .map((m) => sliceFrom(parts[m.index].pts, m.side, spec.slice))
      .filter((line) => line.length >= 4)
      .slice(0, 2);
    return { lines, curves: fitWith(null, lines) };
  })();
  const baseEntry = (i, overrides) => ({
    groupKey: "base" + i,
    curve: base.curves[i],
    trainIds: ["T1"],
    nodeKeys: nodeKeysOf(base.lines[i]),
    ...overrides,
  });

  // groupInfo.size < 2: the pass returns before it looks at anything.
  synthetic.push(runMirror("degenerate-single-group", [baseEntry(0)]));
  // Both curves null. indexStationJoinCurveOwners sees nothing to own.
  synthetic.push(
    runMirror("degenerate-null-curves", [
      baseEntry(0, { curve: null }),
      baseEntry(1, { curve: null }),
    ]),
  );
  // A curve with three points is below the pass's own floor and must be
  // invisible to it — including to the endpoint collector, which would
  // otherwise read pts[0] and pts[2] as a corridor.
  const truncated = (() => {
    const c = { ...base.curves[0] };
    c.pts = c.pts.slice(0, 3);
    c.cum = c.cum.slice(0, 3);
    c.dirs = c.dirs.slice(0, 3);
    return c;
  })();
  synthetic.push(
    runMirror("degenerate-three-point-curve", [
      baseEntry(0, { curve: truncated }),
      baseEntry(1),
    ]),
  );
  // No shared ride: two curves that touch at a station but carry disjoint
  // membership are two corridors, not one, and must not be welded.
  synthetic.push(
    runMirror("no-shared-trains", [
      baseEntry(0, { trainIds: ["T1"] }),
      baseEntry(1, { trainIds: ["T2"] }),
    ]),
  );
  // No node keys at all: the deliberately conservative geometric fallback
  // (60° instead of 90°, and 25° beyond 40 m) decides on its own.
  synthetic.push(
    runMirror("geometry-fallback-no-node-keys", [
      baseEntry(0, { nodeKeys: null }),
      baseEntry(1, { nodeKeys: null }),
    ]),
  );
  // Matching node ids on endpoints that are nowhere near each other. Stable
  // node identity selects the station first, but the 120 m gate still
  // rejects the pair — a port that treats an id match as sufficient joins
  // two curves across the country here.
  const distant = (() => {
    const other = parts.find((p) => p.pts.length >= 60 && p.lineId !== parts[0].lineId);
    const line = other.pts.slice(0, 60);
    return { line, curve: fitWith(null, [line])[0] };
  })();
  synthetic.push(
    runMirror("node-id-match-too-far", [
      baseEntry(0, { nodeKeys: ["SAME", "far-a"] }),
      {
        groupKey: "distant",
        curve: distant.curve,
        trainIds: ["T1"],
        nodeKeys: ["SAME", "far-b"],
      },
    ]),
  );
  // One curve OBJECT owned by two groups — the many-to-one the owners index
  // exists for. Both groups must receive the joined curve, and the failure
  // report (when there is one) must list both group keys.
  synthetic.push(
    runMirror("shared-curve-object", [
      baseEntry(0),
      { ...baseEntry(0), groupKey: "base0-alias" },
      baseEntry(1),
    ]),
  );

  return { real: realCase, synthetic };
})()`;

// The solve-and-drive step happens in a CHILD process for the same two
// reasons overlap-lanes.mjs uses one: `build()` is synchronous and
// `PrecomputeAdapter.solveStore` is `async`, and the two countries' route
// graphs are happier not sharing a heap.
const CHILD = `
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const APP_DIR = process.env.SJS_APP_DIR;
const country = process.env.SJS_COUNTRY;
const outFile = process.env.SJS_OUT;
const CURATED = JSON.parse(process.env.SJS_IDS);
const DATASETS = JSON.parse(process.env.SJS_DATASETS);

const sandbox = await import(
  path.join(APP_DIR, "scripts", "lib", "app-family-sandbox.mjs")
);
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(APP_DIR, p), "utf8"));
const files = DATASETS[country];
const store = readJson("data/" + files.store);
const wanted = new Set(CURATED);
const kept = store.trains.filter((train) => wanted.has(train.id));
if (kept.length !== wanted.size)
  throw new Error(
    country + ": " + (wanted.size - kept.length) +
      " curated train(s) are not in " + files.store,
  );

const context = sandbox.makeSandbox({ userAgent: "node-port-fixtures" });
sandbox.evaluateAppScripts(context, sandbox.readOrderedAppScripts());
context.__host = {
  country,
  railSections: readJson("data/" + files.sections),
  stations: readJson("data/" + files.stations),
  matchedStops: readJson("data/matched-stops.json"),
  matchedRoutes: readJson("data/matched-routes.json"),
  trainStoreText: JSON.stringify({ ...store, trains: kept }),
  onTrainSolved() {},
};
await vm.runInContext(
  "globalThis.PrecomputeAdapter.solveStore(__host)",
  context,
  { filename: "station-join-fixture-solve.js" },
);
// The compact package the synthetic mirrors are built from. The app fetches
// it at runtime and fetch throws in here, so it is handed in.
context.__package = readJson(path.join("public", "rail", country + "-2025.json"));
const driver = JSON.parse(process.env.SJS_DRIVER);
const result = vm.runInContext(driver, context, {
  filename: "station-join-fixture-driver.js",
});
fs.writeFileSync(outFile, JSON.stringify(result));
`;

function runCountry(APP_DIR, country) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "station-join-fixture-"));
  const childFile = path.join(scratch, "child.mjs");
  const outFile = path.join(scratch, "out.json");
  try {
    fs.writeFileSync(childFile, CHILD);
    execFileSync(process.execPath, [childFile], {
      env: {
        ...process.env,
        SJS_APP_DIR: APP_DIR,
        SJS_COUNTRY: country,
        SJS_OUT: outFile,
        SJS_IDS: JSON.stringify(CURATED[country]),
        SJS_DATASETS: JSON.stringify(DATASETS),
        SJS_DRIVER: JSON.stringify(
          DRIVER.replace("__IDS__", JSON.stringify(CURATED[country])).replace(
            "__SYNTHETIC__",
            JSON.stringify(SYNTHETIC[country]),
          ),
        ),
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    return JSON.parse(fs.readFileSync(outFile, "utf8"));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ── Number.prototype.toFixed ────────────────────────────────────────────
//
// The join report rounds through `+x.toFixed(1)` and `+x.toFixed(2)`, and
// toFixed is not printf: the spec picks the integer n minimising
// |n / 10^f − x| against the EXACT value of x and, on a tie, picks the
// LARGER n. Swift's `String(format:)` rounds the same tie to even, and
// `(x * 10).rounded()` rounds a product that has already lost the tie. Both
// are wrong in the same rare place, so the port carries its own and this
// pins it — evaluated by V8 itself, not described.
const TO_FIXED_CASES = [
  // Exact ties, where "larger n" and "to even" disagree.
  0.25, 0.75, 1.25, 2.5, 0.5, 1.5, 3.5, 0.125, 0.375, 2.675, 1.005, 8.325,
  // Values whose decimal expansion is not what it looks like.
  1.0000000000000002, 0.30000000000000004, 179.99999999999997,
  // The distributions the two call sites actually produce: a gap in metres
  // and a turn in degrees.
  0, 1e-7, 0.049999999999999996, 39.99999999999999, 119.99999999999999,
  74.83999999999999, 89.99999999999999, 1234.5649999999998,
  // Signs and magnitudes the call sites cannot produce but the helper must
  // still answer for.
  -0.25, -2.5, -0.0, 1e21, 12345678901234.567,
];

export function build({ APP_DIR }) {
  const cases = [];
  for (const country of ["jp", "tw"]) {
    const result = runCountry(APP_DIR, country);
    cases.push({
      label: `${country}:curated-rides`,
      country,
      kind: "real",
      ...result.real,
    });
    for (const mirror of result.synthetic)
      cases.push({
        label: `${country}:${mirror.label}`,
        country,
        kind: "synthetic",
        curves: mirror.curves,
        groups: mirror.groups,
        expected: mirror.expected,
      });
  }
  return {
    describes:
      "app-overlap-lanes.js smoothCurveStationJoins — the pass that rounds " +
      "the shared endpoints where two corridor curves meet at a station, " +
      "with refreshFittedCurveGeometry and rebuildLimitedDirectionField",
    contract:
      "This pass decides which of a scenario's fitted corridor curves are " +
      "REPLACED by one station-continuous refit, and a curve is what the " +
      "hover fan takes its local perpendicular from — so which groups end up " +
      "sharing which curve object is exact, always, as are the accept/reject " +
      "verdict, the failure reason, the join count and every diagnostic " +
      "stamped on an accepted curve. Identity is load-bearing twice over: " +
      "the pass keys three Maps and a Set on the curve OBJECT, so two groups " +
      "sharing one curve are one node in its graph and two equal-but-" +
      "distinct curves are two; and `curveIndex` in this fixture is that " +
      "identity, never a value to compare. Ordering is load-bearing too — " +
      "candidates are ranked by a score and selected greedily with a STABLE " +
      "sort, and the chain walk starts from whichever degree-1 end the curve " +
      "list reaches first. The refit's own coordinates are pure arithmetic " +
      "over the input curve (box filters, prefix sums) and are expected bit " +
      "for bit; the arc-length and tangent fields run through haversine, " +
      "atan2, sin and exp and carry a measured ULP ceiling instead.",
    seam:
      "The station-join pass reads no globals and no settings: " +
      "smoothJoinedStationCurve takes its radius, detail and deviation " +
      "budgets from the template curve's own fields, so the four fit-curve " +
      "sliders appear here only as a way to produce differently-constrained " +
      "input curves. What is NOT covered: the fit worker's serialisation " +
      "(runFitCurveJobs) and the caches, neither of which is behaviour.",
    // Evaluated by this process's V8, so it is the same answer the app gets.
    toFixed: TO_FIXED_CASES.flatMap((value) =>
      [1, 2].map((digits) => ({
        value,
        digits,
        text: value.toFixed(digits),
        number: +value.toFixed(digits),
      })),
    ),
    cases,
  };
}
