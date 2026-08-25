"use strict";

// Turn/length maths for the Macao and Hong Kong micro-kink gates, which asked
// the same two questions of their packages with two character-for-character
// copies of these helpers until 2026-08-25.
//
// These measure the turn on UNPROJECTED lon/lat degrees, which is wrong by the
// aspect ratio at any latitude away from the equator (public/rail-network.js
// records what that costs: at 35.56°N it once misreported a 9.3° bend). Both
// suites are characterisation gates — they pin what the mo/hk packages look
// like today, at a >60°-on-a-sub-40 m-edge threshold that was chosen against
// these numbers — so the degrees stay unprojected on purpose for now, and this
// file exists to deduplicate them, not to correct them. Fixing the projection
// is a separate change that has to re-justify the threshold.
//
// Do NOT merge this with scripts/railway/lib/railway-topology.mjs: that leaf
// grades the network with different arithmetic, and merging would move these
// suites' numbers. test/railway-topology-audit.test.js pins that separation in
// "the equirectangular copies that are deliberately different stay different",
// which lists both consumers by path.
//
// It lives in scripts/lib/ rather than in test/ for the same reason
// app-family-sandbox.mjs does — four suites already read that module from
// here. It also has to: `npm test` is a bare `node --test`, whose default
// discovery collects EVERY .js under a directory named test/, helpers
// included, so a plain helper there would be run and counted as an empty test
// file (measured: a two-file probe reports 2 tests, 1 of them the helper).

const turnDegrees = (a, b, c) => {
  const v1 = [b[0] - a[0], b[1] - a[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  const l1 = Math.hypot(...v1);
  const l2 = Math.hypot(...v2);
  if (!l1 || !l2) return 0;
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
};

const metres = (a, b) => {
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * 111_320 * Math.cos(lat), (b[1] - a[1]) * 111_320);
};

module.exports = { turnDegrees, metres };
