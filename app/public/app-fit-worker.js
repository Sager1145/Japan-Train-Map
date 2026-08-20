// =========================================================================
//  app-fit-worker.js — fitted-curve solver worker
//
//  NOT part of the ordered index.html script family: loaded only via
//  `new Worker("app-fit-worker.js")` by scheduleFitCurveWorker
//  (app-overlap-lanes.js). It imports the real solver sources, so the curves
//  it produces are byte-identical to the synchronous fallback path — the stub
//  below is the only cross-file global the fit path reaches that importScripts
//  cannot supply (mirroring the vm harness in
//  test/fit-curve-invariants.test.js).
// =========================================================================

// Written by the page before each solve via the message's `settings`
// snapshot; app-overlap-lanes.js reads it as a free variable.
var APPLIED_FIT_CURVE_SETTINGS = {};

// A Worker has its own global scope, so the classic-script family's bare
// bindings do not reach here — everything the fit path needs has to arrive
// through importScripts. `distanceMeters` comes with app-route-simplify.js,
// which this worker loads anyway, so it costs nothing beyond what is already
// imported and there is no copy of it to keep in sync.
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
