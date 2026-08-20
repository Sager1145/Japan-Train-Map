/*
 * The corner-radius contract, pinned.
 *
 * scripts/validation/validate-corner-radius.mjs is the audit; this is the gate
 * that keeps its answer from drifting. It asks three questions, and the third
 * is the one that matters most: PROVE THE GATE IS LIVE. A suite that only ever
 * asserts "zero errors" cannot tell a clean map from an audit that stopped
 * looking, so the falsification test drops the promised radius to nothing and
 * requires the same run to fail.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  COUNTRIES,
  auditCountry,
} from "../scripts/validation/validate-corner-radius.mjs";

const reports = new Map(
  COUNTRIES.map((country) => [country, auditCountry(country)]),
);

const errorsIn = (report) =>
  [...report.findings, ...report.reversalFindings].filter(
    (row) => row.severity === "ERROR",
  );

test("no visible curve is drawn as a corner in any package", () => {
  for (const country of COUNTRIES) {
    const report = reports.get(country);
    assert.ok(report, `${country} has no package`);
    const errors = errorsIn(report);
    assert.deepEqual(
      errors.map((row) => `z${row.zoom} ${row.code} ${row.name}: ${row.detail}`),
      [],
      `${country} draws a curve as a corner`,
    );
    assert.equal(
      report.findings.filter((row) => row.severity === "WARNING").length,
      0,
      `${country} has a corner over ${60}° that the alignment does not turn`,
    );
  }
});

test("the residue is curvature the pen is wider than, and stays small", () => {
  // Corners the simplifier still hands to a single vertex while the alignment
  // curves wide enough to see. Zero is reachable but rejected: it needs a
  // tolerance finer than the promised radius asks for, at 16% more vertices
  // everywhere (see SEGMENT_SIMPLIFY_TOLERANCE_PX). These twelve are all
  // 30–36° bends on z6 or z8 where the alignment itself turns 23–37°, so the
  // drawn line spends a wide bend on one vertex rather than inventing a corner
  // — and the number is here so a regression cannot hide among them.
  //
  // It moved 3 → 12 when the 2026-08-20 retune halved the stroke: the residue
  // is curvature the PEN is wider than, so a finer pen leaves more of it
  // standing. Whoever changes railWidthPx again re-derives the tolerance and
  // re-measures this budget; it is a reading of the map, not a constant.
  const collapsed = COUNTRIES.reduce(
    (total, country) =>
      total +
      reports
        .get(country)
        .byZoom.reduce((sum, row) => sum + row.collapsed, 0),
    0,
  );
  assert.ok(
    collapsed <= 12,
    `${collapsed} corners collapsed, budget 12 — a curve got handed to one vertex again`,
  );

  // And the drawn line stays where the surveyed one is. geojson-vt overshoots
  // its own tolerance because a vertex is scored against a finer chord than
  // the one that survives; this is that overshoot, measured.
  for (const country of COUNTRIES) {
    const worst = Math.max(
      0,
      ...reports.get(country).byZoom.map((row) => row.worstDisplacementPx),
    );
    assert.ok(
      worst <= 0.25,
      `${country} draws ${worst.toFixed(2)} px off its own alignment`,
    );
  }
});

test("every real switchback is still drawn as a switchback", () => {
  // The ten reversals a train actually reverses at, plus 大畑's loop, found by
  // the topology audit's own criterion rather than by a hand-kept list. Named
  // one by one, because "13 reversals, 0 flattened" would pass just as well
  // with the wrong thirteen.
  const sites = new Map();
  for (const country of COUNTRIES)
    for (const row of reports.get(country).reversals)
      sites.set(`${row.site.replace(/ \(.*/, "")}·${row.name}`, row);

  const expected = [
    "姨捨·篠ノ井線",
    "出雲坂根·木次線",
    "真幸·肥薩線",
    "大畑·肥薩線",
    "立野·豊肥線",
    "西留辺蘂·石北線", // 常紋信号場; the nearest PLATFORM is 西留辺蘂
    "塔ノ沢·鉄道線", // 出山信号場 on the 箱根登山鉄道
    "大平台·鉄道線", // 上大平台信号場
    "二萬平·阿里山線",
    "阿里山·阿里山線",
    "神木·阿里山線",
  ];
  for (const name of expected)
    assert.ok(sites.has(name), `${name} is no longer a reversal in the package`);

  // A fold whose out-and-back is shorter on screen than the stroke is wide
  // cannot be drawn as a fold by anybody, so the requirement is exactly: at
  // every zoom where the excursion clears the pen, the drawn line still folds.
  for (const country of COUNTRIES) {
    const report = reports.get(country);
    const flattened = report.reversalFindings.filter(
      (row) => row.severity === "ERROR",
    );
    assert.deepEqual(
      flattened.map(
        (row) => `z${row.zoom} ${row.name} ${row.at.join(",")} ${row.detail}`,
      ),
      [],
      `${country} irons a switchback flat`,
    );
  }
});

test("the promised radius is what the audit is failing on", () => {
  // Falsification. Ask for no radius at all and the same packages, the same
  // zooms and the same code must come back loud: if they do not, the gate
  // above is measuring nothing.
  const withoutRadius = auditCountry("jp", { minRadiusStrokes: 0 });
  const errors = errorsIn(withoutRadius);
  // 50 at the time of writing — 43 corners and 7 switchbacks — against 0 with
  // the radius in place.
  assert.ok(
    errors.length >= 25,
    `dropping the minimum radius to 0 produced only ${errors.length} errors — the gate is not live`,
  );
  assert.ok(
    errors.some((row) => row.code === "corner_collapsed_by_generalisation"),
    "the corner rule never fires",
  );

  // …and the same handle proves the reversal half is live too: with no floor
  // under the excursion, the folds that are genuinely sub-pixel at a
  // nationwide view are reported instead of excused.
  assert.ok(
    errors.some((row) => row.code === "reversal_flattened_by_generalisation"),
    "the switchback rule never fires",
  );
});
