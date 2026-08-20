// =========================================================================
//  app-fit-worker.js — fitted-curve solver worker
//
//  NOT part of the ordered index.html script family: loaded only via
//  `new Worker("app-fit-worker.js")` by scheduleFitCurveWorker
//  (app-overlap-lanes.js). It imports the real solver sources, so the curves
//  it produces are byte-identical to the synchronous fallback path — the two
//  stubs below are the only cross-file globals the fit path reaches
//  (mirroring the vm harness in test/fit-curve-invariants.test.js).
// =========================================================================

// Written by the page before each solve via the message's `settings`
// snapshot; app-overlap-lanes.js reads it as a free variable.
var APPLIED_FIT_CURVE_SETTINGS = {};

// Exact copy of app-route-solver.js's distanceMeters. A Worker has its own
// global scope, so the classic-script family's bare binding does not reach
// here, and importScripts("app-route-solver.js") would drag in the whole
// route-graph machinery this worker never runs. Copying the one leaf function
// is the cheaper trade — the duplication is deliberate, not an oversight.
//
// The copy is kept honest by test/distance-meters-parity.test.js, which
// compares this body against app-route-solver.js's character for character.
// If you edit either, edit both. Do NOT swap in rail-network.js's same-named
// equirectangular version: it reads ~0.1125% longer and would desynchronise
// the worker from the synchronous fallback path.
function distanceMeters(a, b) {
  const lon1 = Number(a[0]);
  const lat1 = Number(a[1]);
  const lon2 = Number(b[0]);
  const lat2 = Number(b[1]);
  const radius = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const x =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(x));
}

importScripts("app-route-simplify.js", "app-overlap-lanes.js");

self.onmessage = (event) => {
  const { requestId, settings, jobs, joinGroups } = event.data || {};
  // Replace (not merge) the applied settings so a removed key can never leak
  // from an earlier request. The corridor-curve memo keys off these values,
  // so repeat solves at unchanged settings stay cache hits across requests.
  Object.keys(APPLIED_FIT_CURVE_SETTINGS).forEach((key) => {
    delete APPLIED_FIT_CURVE_SETTINGS[key];
  });
  Object.assign(APPLIED_FIT_CURVE_SETTINGS, settings || {});
  const result = runFitCurveJobs(jobs, joinGroups);
  self.postMessage({ requestId, ...result });
};
