// =========================================================================
//  overlap-lanes.json — how several rides sharing one corridor are drawn
//  side by side instead of on top of each other.
//
//  The pair under test is app-overlap-lanes.js + app-deck-records.js. They
//  are mutually recursive in the JavaScript (the record builder calls the
//  corridor solver; the corridor solver's chain walker is called back from
//  the record builder's component pass), so they are one unit of work and
//  one fixture.
//
//  ── how the answers are produced ────────────────────────────────────────
//
//  Nothing here re-implements anything. The whole frontend classic-script
//  family is evaluated in the same Node `vm` sandbox the offline precompute
//  uses (scripts/lib/app-family-sandbox.mjs), the committed train stores are
//  solved through the app's own PrecomputeAdapter, and the resulting route
//  items are handed to the real `buildDeckOverlapMap` / `buildDeckRouteRecords`
//  and to the real intermediate builders they are composed of.
//
//  Two consequences worth stating, because they are what makes the file
//  slower than every other fixture generator here:
//
//    * it costs a route solve. Measured: the whole generator takes 13 s
//      without this file and 50 s with it, and the 37 s is two route solves
//      over the N02 and TDX graphs for the 25 curated trains below. Solving
//      is the only way to obtain real ride geometry: `data/sample-data/` is
//      gitignored
//      (the deploy workflow regenerates it), so the committed inputs are the
//      two train stores plus `data/matched-routes.json`, which carries the
//      curated geometry of the four rides the solver cannot route — one of
//      which is the Taiwan round-island loop, and therefore the case where a
//      single ride doubles back onto its own track.
//    * the trains are named rather than sampled. Overlap lanes only exist
//      where several rides genuinely coincide, and a random slice of a store
//      is mostly rides that share nothing. The list is chosen for corridors
//      the repository already knows are awkward — see CURATED below.
//
//  ── what is pinned ──────────────────────────────────────────────────────
//
//  Each scenario carries its INPUT (the route items, verbatim, as the app
//  built them) and the expected value of every named intermediate product
//  the JavaScript's own comments enumerate:
//
//    segments   the overlap map — sharing sets, near-parallel interaction
//               groups and the canonical corridor direction per segment key
//    lines      per (train, line): lane slot, lane multiplier, bridged
//               slivers, maximal runs, the drawn vertex subset, each run's
//               groupKey and its shift axis
//    groups     the stitched corridors — representative geometry, endpoint
//               joins, components, the unified shift axis, lane multipliers,
//               pick bridges
//    records    the records the renderer consumes, with their paths
//    curves     every `smoothCorridorCurve` call the build actually made,
//               input and output, captured by DELEGATION: the global is
//               replaced by a wrapper that calls the real function and
//               records what went in and what came back. The corridor solver
//               is otherwise unreachable from outside — its inputs are chains
//               assembled deep inside the record builder — and re-deriving
//               those chains here would be re-implementing the function this
//               fixture exists to pin.
//    probes     the same solver under all ten fit-curve settings
//               combinations, over corridor lines, two degenerate shapes and
//               whole railway alignments. This is the section that reaches
//               the fallbacks; see the comment above the probes themselves
//               for what was measured about which branches real data reaches.
//
//  ── the seam ────────────────────────────────────────────────────────────
//
//  `smoothCurveStationJoins` (app-overlap-lanes.js §1669-2145, with
//  `refreshFittedCurveGeometry` and `rebuildLimitedDirectionField`) is NOT
//  ported and is NOT pinned here. It runs after the corridor phase and
//  rewrites `gi.curve` for corridors that meet at a station — measured on the
//  Tokyo scenario, 9 of 17 groups get a different curve out of it, typically
//  a 20-point per-run curve replaced by a 210-point re-fit of the
//  concatenated source. Nothing else it touches is observable from here: it
//  assigns `gi.curve` only, so `sx`, `sy`, `mults`, `pickBridges` and every
//  record field below are the JavaScript's final values, unmodified.
//
//  The `curves` section pins `smoothCorridorCurve` itself, which the join
//  pass never calls, so the corridor fit is checked against the real
//  function's real inputs whether or not the pass that runs after it exists.
// =========================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const name = "overlap-lanes.json";

// ── the trains ──────────────────────────────────────────────────────────
//
// Chosen for coincidence, not for coverage of the store. Each group names
// what it is here to exercise; every one of them is a ride that was actually
// taken and is committed in app/data/train-store*.json.
const CURATED = {
  jp: [
    // Tokyo's trunk corridors. 埼京線 and 湘南新宿ライン share the 山手貨物線
    // from Ōsaki to Ikebukuro; 京浜東北線 and 根岸線 and 横浜線 share the
    // Tōkaidō/Negishi corridor south of Tokyo; 中央線快速 and 中央・総武線
    // 各駅停車 run on four parallel tracks through the same right of way,
    // which is the near-parallel grouping rule's whole reason to exist.
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
    // The west-coast trunk, ridden in BOTH directions on consecutive days
    // (Taichung→Changhua by 自強, Changhua→Taichung by 區間) — the up/down
    // paired-alignment case, where the two rides traverse one corridor in
    // opposite senses and must still land in a stable lane order.
    "20260805_02_tra_local_3262_xinwuri_taichung",
    "20260806_01_tra_tze_chiang_3000_137_taichung_changhua",
    "20260806_02_tra_local_2204_changhua_taichung",
    // Kaohsiung MRT red line, ridden as six consecutive out-and-back legs of
    // one day, plus the circular light rail — the loop-line seam.
    "20260810_01_krtc_red_kaohsiung_gangshan_station",
    "20260810_02_krtc_red_gangshan_station_siaogang",
    "20260810_03_krtc_red_siaogang_sanduo",
    "20260810_04_krtc_red_sanduo_kaisyuan",
    "20260810_05_klrt_c3_counterclockwise_loop",
    "20260810_06_krtc_red_kaisyuan_kaohsiung",
    "20260812_01_krtc_red_kaohsiung_zuoying",
    // The round-island loop: 臺北 → 臺北 the long way, 194 curated features,
    // the one ride in either store that doubles back onto its own track. It
    // is unsolvable, so its geometry comes from data/matched-routes.json —
    // committed solver output, which is the point.
    "20260813_01_star_of_taiwan_round_island_loop",
  ],
};

// Railway alignments whose own display geometry reaches a fit branch no ride
// corridor does — see the `alignment:` probes in the driver. Each was found by
// scanning all 804 lines of the five shipped packages for a fit that falls
// through to the circular-arc fallback, and all four below reach it at the
// DEFAULT settings.
const ALIGNMENTS = {
  jp: [
    // 大江戸線 and 丸ノ内線 are both ridden by the curated jp rides; 名城線 is
    // Nagoya's loop, the shortest of the three.
    { country: "jp", lineId: "jp-東京都-12号線大江戸線" },
    { country: "jp", lineId: "jp-東京地下鉄-4号線丸ノ内線" },
    { country: "jp", lineId: "jp-名古屋市-4号線名城線" },
  ],
  tw: [
    // 高雄環狀輕軌 — the circular light rail the curated tw rides ride round.
    { country: "tw", lineId: "tw-klrt-c" },
    { country: "tw", lineId: "tw-trtc-br" },
    // The high-speed main line: 350 km, and the one alignment that reaches the
    // fallback only at a large requested radius rather than at the default.
    { country: "tw", lineId: "tw-thsr-main" },
  ],
};

// The datasets each country's solve needs, in the same shape
// precompute-train-parts.mjs assembles them.
const DATASETS = {
  jp: { sections: "rail-sections.json", stations: "stations.json", store: "train-store.json" },
  tw: {
    sections: "rail-sections-tw.json",
    stations: "stations-tw.json",
    store: "train-store-tw.json",
  },
};

// ── the driver ──────────────────────────────────────────────────────────
//
// Runs INSIDE the sandbox. Every value it returns came out of a frontend
// function; the only thing this code does is call them in the order
// buildDeckRouteRecords calls them and copy what they answered.
//
// `recordCurves` is the one piece of instrumentation: it replaces the global
// `smoothCorridorCurve` with a wrapper that DELEGATES to the real one and
// records (input, output). The corridor solver is otherwise unreachable from
// outside — its inputs are chains assembled deep inside the record builder —
// and re-deriving those chains here would be re-implementing the function
// this fixture exists to pin.
const DRIVER = `(() => {
  const ids = __IDS__;
  const trains = ids.map((id) => getTrain(id)).filter(Boolean);
  if (trains.length !== ids.length)
    throw new Error("curated train missing from the solved store");
  // The render pipeline's own order (app-route-render.js): no date scope is
  // active in the sandbox, so visibleTrains is every train, in store order
  // sorted the way the train list sorts them.
  trains.sort(compareTrainsByDateAndDeparture);
  const items = buildRouteItems(trains);

  const flat = (line) => {
    const out = [];
    for (const p of line) out.push(p[0], p[1]);
    return out;
  };
  // FNV-1a over the IEEE-754 bits of a number series. Used for the probe
  // outputs' cum/dirs only: those two are as long as pts, and storing all
  // three for 180 probe curves tripled the file for no added resolution — the
  // mix is a bijection on 64-bit words, so a single changed double always
  // changes the digest. The real corridor fits under "curves" store all three
  // in full, because those are the ones a disagreement has to be located in.
  // A decimated copy of a number series, plus its true length. Used for the
  // probe outputs' cum/dirs only: those two are as long as pts, and storing
  // all three in full for 144 probe curves tripled the file. A digest would
  // have been smaller still, and was the first thing tried — but a digest can
  // only be compared under BIT equality, and the corridor fit is not
  // bit-identical (see the ULP ceiling in the parity test), so it would have
  // pinned nothing. The real corridor fits under "curves" store all three in
  // full, because those are the ones a disagreement has to be located in.
  const SAMPLE_MAX = 200;
  const sampleOf = (series) => {
    const stride = Math.max(1, Math.ceil(series.length / SAMPLE_MAX));
    const out = [];
    for (let i = 0; i < series.length; i += stride) out.push(series[i]);
    return { length: series.length, stride, values: out };
  };
  const settingsOut = (s) => ({
    precision: s.fitCurvePrecision ?? null,
    minRadius: s.fitCurveMinRadius ?? null,
    minDetail: s.fitCurveMinDetail ?? null,
    maxDeviation: s.fitCurveMaxDeviation ?? null,
  });
  const curveOut = (curve) =>
    curve
      ? {
          pts: flat(curve.pts),
          cum: curve.cum,
          dirs: flat(curve.dirs),
          totalMeters: curve.totalMeters,
          sourceTotalMeters: curve.sourceTotalMeters,
          endpointChordMeters: curve.endpointChordMeters,
          radiusMeters: curve.radiusMeters,
          smoothingSigmaMeters: curve.smoothingSigmaMeters,
          directionSigmaMeters: curve.directionSigmaMeters,
          requestedMinRadiusMeters: curve.requestedMinRadiusMeters,
          achievedMinRadiusMeters: curve.achievedMinRadiusMeters,
          achievedDirectionRadiusMeters: curve.achievedDirectionRadiusMeters,
          minDetailMeters: curve.minDetailMeters,
          maxDeviationMeters: curve.maxDeviationMeters,
          actualMaxDeviationMeters: curve.actualMaxDeviationMeters,
          samplingPrecision: curve.samplingPrecision,
          fitType: curve.fitType,
          coslat: curve.coslat,
        }
      : null;

  // ── inputs ──
  // The geometry each item contributes, as iterateGeometryLines normalised
  // it (quant5 on both axes). Recorded rather than the raw feature geometry
  // because that normalisation belongs to app-coords.js, which is already
  // ported (Grid.normalizeGraphCoord) and pinned by coords.json.
  const itemRecords = items.map((item) => {
    const flags = routeRecordScopeFlags(item.train);
    const ridden =
      item.feature.properties && item.feature.properties.ride_segment === true;
    const style = routeSegmentStyleValues(item.train, ridden, flags);
    return {
      trainId: item.train.id,
      // deckOverlapItemDrawn — lane membership.
      drawn: deckOverlapItemDrawn(item),
      // buildDeckRouteRecords' own, WIDER filter: an off-date ride is excluded
      // from the overlap map but still draws, dimmed.
      recordDrawn: !(ridden && !riddenFeatureVisible(item.feature)) && style.opacity > 0,
      noPick: flags.dimmed === true,
      width: style.width,
      lines: iterateGeometryLines(item.feature.geometry).map(flat),
    };
  });

  // ── the overlap map, and the raw indices behind it ──
  const overlap = buildDeckOverlapMap(items);
  const rank = buildDeckOverlapTrainRank(items);
  const pairsByItem = items.map((item) => getRouteLinePairs(item.feature));

  const segmentKeys = [];
  const seen = new Set();
  items.forEach((item, itemIndex) => {
    pairsByItem[itemIndex].forEach(({ orig, segKeys }) => {
      for (let i = 0; i < segKeys.length; i += 1) {
        if (seen.has(segKeys[i])) continue;
        seen.add(segKeys[i]);
        const ids = overlap.idsForKey(segKeys[i]);
        const groupKey = overlap.groupKeyForKey(segKeys[i]);
        const near = overlap.nearGroupInfo(groupKey);
        segmentKeys.push({
          key: segKeys[i],
          ids: ids ? [...ids] : null,
          slots: ids ? [...ids].map((tid) => overlap.slotFor(ids, tid)) : null,
          groupKey,
          near: near
            ? {
                pairCount: near.pairCount,
                maxSeparationMeters: near.maxSeparationMeters,
                thresholdMeters: near.thresholdMeters,
              }
            : null,
          // dirForKey is only meaningful from a node the key actually has, so
          // probe it from the node the ORIGINAL segment starts at.
          dirFromA: overlap.dirForKey(segKeys[i], overlapNodeKey(orig[i])),
          dirFromB: overlap.dirForKey(segKeys[i], overlapNodeKey(orig[i + 1])),
        });
      }
    });
  });

  // ── per line: lanes, runs, drawn subset, groupKey, shift axis ──
  const lines = [];
  items.forEach((item, itemIndex) => {
    const tid = item.train.id;
    const noPick = routeRecordScopeFlags(item.train).dimmed === true;
    if (!deckOverlapItemDrawn(item)) return;
    pairsByItem[itemIndex].forEach(({ orig, keepIdx, segKeys }, lineIndex) => {
      if (!orig || orig.length < 2) return;
      const nSeg = orig.length - 1;
      const lanes = assignSegmentOverlapLanes(overlap, orig, segKeys, tid, noPick);
      const runs = maximalOverlapRuns(lanes.segIds, nSeg);
      const subset = buildDrawnVertexSubset(orig, keepIdx, runs, nSeg);
      lines.push({
        itemIndex,
        lineIndex,
        trainId: tid,
        segKeys,
        // Set IDENTITY is what run boundaries are computed from, so what is
        // pinned is which segments share an identity, not the sets themselves.
        segIdsSig: lanes.segIds.map((ids) =>
          ids ? [...ids].sort().join("\\u0000") : null,
        ),
        segSlot: lanes.segSlot,
        segMult: lanes.segMult,
        segBridged: lanes.segBridged,
        lineHasOverlap: lanes.lineHasOverlap,
        runs: runs.map((r) => [r.a, r.b]),
        drawnIdx: (() => {
          const out = [];
          subset.posOf.forEach((position, original) => out.push(original, position));
          return out;
        })(),
        drawnLen: subset.drawnLen,
        runGroupKeys: runs.map(({ a, b }) =>
          lanes.segIds[a]
            ? canonicalRunGroupKey(overlap, segKeys, lanes.segBridged, a, b)
            : "",
        ),
        runAxes: runs.map(({ a, b }) => {
          const axis = corridorRunShiftAxis(overlap, orig, segKeys, a, b);
          return [axis.latRef, axis.coslatRef, axis.dx, axis.dy, axis.len];
        }),
      });
    });
  });

  // ── the fitted curves, captured by delegation ──
  const curveCalls = [];
  const realSmooth = smoothCorridorCurve;
  globalThis.smoothCorridorCurve = function (line) {
    const output = realSmooth(line);
    curveCalls.push({ input: line, output });
    return output;
  };
  let built;
  try {
    built = buildDeckRouteRecords(items);
  } finally {
    globalThis.smoothCorridorCurve = realSmooth;
  }

  const groups = [];
  built.groupInfo.forEach((gi, key) => {
    groups.push({
      key,
      sx: gi.sx,
      sy: gi.sy,
      // An ARRAY of pairs, not an object: the key order of gi.mults is the
      // sharing set's insertion order, it decides the order pick bridges come
      // out in, and a JSON object decoded into a dictionary would lose it.
      mults: Object.keys(gi.mults).map((trainId) => ({
        trainId,
        mult: gi.mults[trainId],
      })),
      line: flat(gi._line),
      pa: gi._pa,
      pb: gi._pb,
      latRef: gi._latRef,
      sig: gi._sig,
      endpointNodeKeys: gi._curveEndpointNodeKeys || null,
      nearParallel: gi._nearParallel
        ? {
            pairCount: gi._nearParallel.pairCount,
            maxSeparationMeters: gi._nearParallel.maxSeparationMeters,
            thresholdMeters: gi._nearParallel.thresholdMeters,
          }
        : null,
      corridorJoins: (gi._corridorJoins || []).map((j) => ({
        aKey: j.a.key,
        aSide: j.a.side,
        bKey: j.b.key,
        bSide: j.b.side,
        metres: j.metres,
        score: j.score,
      })),
      pickBridges: (gi.pickBridges || []).map((b) => ({
        trainId: b.tid,
        recordIndex: b.idx,
        laneMult: b.laneMult,
        pickWidth: b.pickWidth,
        path: flat(b.path),
      })),
    });
  });

  // ── adversarial curve probes ────────────────────────────────────────
  //
  // Measured on the two scenarios above: every corridor the real build fits
  // is accepted by the FIRST B-spline evaluation. The chord pull (§6), the
  // circular-arc fallback (§7), the hard-validation rejection (§10) and the
  // low-density-resampling retreat (§11) are never reached, so a port that
  // dropped all four would pass a fixture built only from the real build and
  // then produce a wrong hover direction the first time a reader moved the
  // 最小半徑 slider.
  //
  // The inputs stay real — they are corridor lines this build actually
  // produced, plus two degenerate shapes JSON can express and a solve cannot
  // (a two-vertex line, a line that never moves). What varies is the four
  // fit-curve settings, which are a user-facing slider group, so every
  // combination below is one a reader can ask for.
  const probeLines = [];
  const seenProbe = new Set();
  const addProbe = (label, line, alignment) => {
    if (!line || seenProbe.has(label)) return;
    seenProbe.add(label);
    probeLines.push({ label, line, alignment: Boolean(alignment) });
  };
  // Whole railway alignments are up to 350 km long and sample out to the
  // 3,200-point solve cap, so they run under four settings rather than all
  // ten. The four are the ones that decide something: the default (which is
  // where three of them reach the circular-arc fallback), both output
  // densities, and the deviation budget that rejects.
  const ALIGNMENT_VARIANTS = new Set([
    "default", "precision-half", "radius-large-deviation-large", "max-deviation-min",
  ]);
  const byLength = [...built.groupInfo.entries()]
    .map(([key, gi]) => ({ key, line: gi._line }))
    .sort((a, b) => a.line.length - b.line.length || (a.key < b.key ? -1 : 1));
  if (byLength.length) {
    addProbe("shortest-corridor", byLength[0].line);
    addProbe("longest-corridor", byLength[byLength.length - 1].line);
    addProbe("median-corridor", byLength[byLength.length >> 1].line);
  }
  // The longest single drawn line in the scenario: on tw that is a stretch of
  // the round-island loop, which is where the tight bends are.
  const longestItemLine = items
    .flatMap((item) => iterateGeometryLines(item.feature.geometry))
    .reduce((best, line) => (!best || line.length > best.length ? line : best), null);
  addProbe("longest-item-line", longestItemLine);
  addProbe("two-vertex", longestItemLine ? longestItemLine.slice(0, 2) : null);
  addProbe(
    "zero-length",
    longestItemLine ? [longestItemLine[0], longestItemLine[0].slice()] : null,
  );

  const SETTINGS = [
    { label: "default", settings: {} },
    { label: "min-radius-max", settings: { fitCurveMinRadius: 40000 } },
    { label: "min-radius-min", settings: { fitCurveMinRadius: 100 } },
    { label: "max-deviation-min", settings: { fitCurveMaxDeviation: 20 } },
    { label: "min-detail-max", settings: { fitCurveMinDetail: 30000 } },
    { label: "precision-half", settings: { fitCurvePrecision: 0.5 } },
    { label: "precision-double", settings: { fitCurvePrecision: 2 } },
    {
      label: "radius-large-deviation-large",
      settings: { fitCurveMinRadius: 20000, fitCurveMaxDeviation: 40000 },
    },
    // Out-of-range and unparseable values, which normalizeFitCurveInputs
    // clamps and ||-defaults rather than rejecting.
    { label: "out-of-range", settings: { fitCurvePrecision: 9, fitCurveMinRadius: 1 } },
    { label: "unset", settings: { fitCurvePrecision: null, fitCurveMinRadius: 0 } },
  ];
  // Railway alignments, not ride corridors. Measured: over all 394 drawn
  // lines of both scenarios, all 36 corridor representatives and 18 settings
  // combinations, the circular-arc fallback (§7) is NEVER taken — every
  // corridor is accepted by the first B-spline evaluation, and a port that
  // omitted §7 entirely would pass. It is reachable, and reachable at the
  // DEFAULT settings, on the railways themselves: a metro loop line has
  // endpoints a few hundred metres apart with tens of kilometres of track
  // between them, which is exactly the hairpin the fallback exists for. These
  // are the shipped packages' own display geometry, so they are real; the
  // named lines are ones the curated rides above actually ride.
  __ALIGNMENTS__.forEach(({ country: pkgCountry, lineId }) => {
    const pkg = __packages[pkgCountry];
    const line = (pkg.lines || []).find((candidate) => candidate.id === lineId);
    if (!line) throw new Error("alignment probe line missing: " + lineId);
    RailNetwork.displayPartsForLine(line).forEach((part, index) => {
      if (part && part.length >= 2)
        addProbe("alignment:" + lineId + "#" + index, part, true);
    });
  });

  const savedSettings = { ...APPLIED_FIT_CURVE_SETTINGS };
  const probes = [];
  try {
    for (const variant of SETTINGS) {
      Object.keys(APPLIED_FIT_CURVE_SETTINGS).forEach((key) => {
        delete APPLIED_FIT_CURVE_SETTINGS[key];
      });
      Object.assign(APPLIED_FIT_CURVE_SETTINGS, savedSettings, variant.settings);
      for (const probe of probeLines) {
        if (probe.alignment && !ALIGNMENT_VARIANTS.has(variant.label)) continue;
        probes.push({
          label: variant.label + "/" + probe.label,
          settings: settingsOut(APPLIED_FIT_CURVE_SETTINGS),
          input: flat(probe.line),
          // The UNCACHED entry point: the memo in front of it is an
          // optimisation whose contents are not observable, and going
          // through it here would only test the memo.
          output: (() => {
            const curve = smoothCorridorCurveUncached(probe.line);
            if (!curve) return null;
            const out = curveOut(curve);
            out.cumSample = sampleOf(out.cum);
            out.dirsSample = sampleOf(out.dirs);
            delete out.cum;
            delete out.dirs;
            return out;
          })(),
        });
      }
    }
  } finally {
    Object.keys(APPLIED_FIT_CURVE_SETTINGS).forEach((key) => {
      delete APPLIED_FIT_CURVE_SETTINGS[key];
    });
    Object.assign(APPLIED_FIT_CURVE_SETTINGS, savedSettings);
  }

  return {
    trainOrder: trains.map((t) => t.id),
    rank: Object.fromEntries(rank),
    items: itemRecords,
    spacingPx: built.spacingPx,
    hasOverlaps: built.hasOverlaps,
    segments: segmentKeys,
    lines,
    groups,
    records: built.records.map((r) => ({
      trainId: r.train.id,
      path: flat(r.path),
      laneMult: r.laneMult,
      overlapCount: r.overlapCount,
      overlapSlot: r.overlapSlot,
      groupKey: r.groupKey,
      shiftX: r.shiftX,
      shiftY: r.shiftY,
      pickWidth: r.pickWidth,
      nopick: r.nopick,
      sortKey: r.sortKey,
      lane: r.lane,
    })),
    expandRecords: built.expandRecords.map((r) => ({
      trainId: r.train.id,
      path: flat(r.path),
    })),
    curves: curveCalls.map(({ input, output }) => ({
      input: flat(input),
      output: curveOut(output),
    })),
    probes,
    settings: settingsOut(APPLIED_FIT_CURVE_SETTINGS),
  };
})()`;

// The whole solve-and-drive step happens in a CHILD process, for two reasons
// that both come down to the same thing: `build()` is called synchronously by
// the generator, and `PrecomputeAdapter.solveStore` is `async`. A child that
// writes its answer to a temp file is the shortest way to await a promise from
// synchronous code without the generator's contract having to change.
// (It also keeps the two countries' 600k-node route graphs from sharing one
// heap, which the second solve is happier for.)
const CHILD = `
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const APP_DIR = process.env.OVERLAP_FIXTURE_APP_DIR;
const country = process.env.OVERLAP_FIXTURE_COUNTRY;
const outFile = process.env.OVERLAP_FIXTURE_OUT;
const CURATED = JSON.parse(process.env.OVERLAP_FIXTURE_IDS);
const DATASETS = JSON.parse(process.env.OVERLAP_FIXTURE_DATASETS);

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
  { filename: "overlap-lanes-fixture-solve.js" },
);
// The compact packages the alignment probes read. They are not otherwise
// loaded in the sandbox: the app fetches them at runtime, and fetch throws.
context.__packages = Object.fromEntries(
  JSON.parse(process.env.OVERLAP_FIXTURE_ALIGNMENTS)
    .map((entry) => entry.country)
    .filter((c, i, all) => all.indexOf(c) === i)
    .map((c) => [
      c,
      readJson(path.join("public", "rail", c + "-2025.json")),
    ]),
);
const driver = JSON.parse(process.env.OVERLAP_FIXTURE_DRIVER);
const result = vm.runInContext(driver, context, {
  filename: "overlap-lanes-fixture-driver.js",
});
fs.writeFileSync(outFile, JSON.stringify(result));
`;

function runCountry(APP_DIR, country) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "overlap-lanes-fixture-"));
  const childFile = path.join(scratch, "child.mjs");
  const outFile = path.join(scratch, "out.json");
  try {
    fs.writeFileSync(childFile, CHILD);
    execFileSync(process.execPath, [childFile], {
      env: {
        ...process.env,
        OVERLAP_FIXTURE_APP_DIR: APP_DIR,
        OVERLAP_FIXTURE_COUNTRY: country,
        OVERLAP_FIXTURE_OUT: outFile,
        OVERLAP_FIXTURE_IDS: JSON.stringify(CURATED[country]),
        OVERLAP_FIXTURE_DATASETS: JSON.stringify(DATASETS),
        OVERLAP_FIXTURE_ALIGNMENTS: JSON.stringify(ALIGNMENTS[country]),
        OVERLAP_FIXTURE_DRIVER: JSON.stringify(
          DRIVER.replace("__IDS__", JSON.stringify(CURATED[country])).replace(
            "__ALIGNMENTS__",
            JSON.stringify(ALIGNMENTS[country]),
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

export function build({ APP_DIR }) {
  const cases = [];
  for (const country of ["jp", "tw"]) {
    const result = runCountry(APP_DIR, country);
    cases.push({ label: `${country}:curated-rides`, country, ...result });
  }
  return {
    describes:
      "app-overlap-lanes.js + app-deck-records.js — the overlap map, the " +
      "per-line lane assignment, the corridor stitching, the B-spline " +
      "corridor fit and the deck records the renderer consumes",
    contract:
      "A lane is a decision made from distances, so a last-bit difference " +
      "moves a ride into a different lane, and a ride in the wrong lane is a " +
      "visibly wrong map. Every structural answer here — which segments share " +
      "a set, which set a segment's identity is, how the runs split, which " +
      "groupKey a run gets, which vertices are drawn — must be exact. " +
      "Ordering is load-bearing throughout: the overlap map is built out of " +
      "insertion-ordered Maps that are scanned for a maximum, walked as a " +
      "graph, and sorted with a STABLE Array.prototype.sort, and the corridor " +
      "direction index in particular answers differently if a component is " +
      "visited in a different order.",
    seam:
      "smoothCurveStationJoins (with refreshFittedCurveGeometry and " +
      "rebuildLimitedDirectionField) is not ported and not pinned. It runs " +
      "after the corridor phase and assigns gi.curve only — measured on the " +
      "jp scenario, 9 of 17 groups receive a different curve from it. Every " +
      "other field below is the JavaScript's final value.",
    cases,
  };
}
