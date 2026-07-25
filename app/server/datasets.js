"use strict";

// Single owner of the datasets the API serves and the static build publishes
// under api/. server/create-app.js registers one route per entry;
// scripts/build-static-site.mjs (via createRequire) copies the same entries
// into the Pages bundle — so a new dataset is added here exactly once.

// Whole-file datasets: route name -> file name under app/data.
const DATA_FILES = {
  "rail-sections": "rail-sections.json",
  stations: "stations.json",
  "default-trains": "default-trains.json",
  "matched-routes": "matched-routes.json",
  "matched-stops": "matched-stops.json",
  "station-readings": "station-readings.json",
};

// Precomputed part datasets: manifest.json + part-NNN.json chunks in
// app/data/<dir>, served as /api/<dir>/:name and copied verbatim to
// api/<dir>/ in the static build. The error strings are pinned by
// test/server.test.js and by users' scripts — byte-identical, never derived.
const PART_DATASETS = [
  {
    dir: "sample-data",
    invalidNameError: "Invalid sample data name.",
    notFoundLabel: "Sample data",
    missingDataError:
      "Precomputed sample data is missing; run scripts/precompute-train-parts.mjs first.",
  },
  {
    dir: "new-year-grand-loop-data",
    invalidNameError: "Invalid grand-loop data name.",
    notFoundLabel: "Grand-loop data",
    missingDataError:
      "Precomputed New Year grand-loop data is missing; run npm run precompute:new-year-grand-loop first.",
  },
  {
    dir: "tokyo-limited-express-loop-data",
    invalidNameError: "Invalid Tokyo loop data name.",
    notFoundLabel: "Tokyo loop data",
    missingDataError:
      "Precomputed Tokyo limited-express loop data is missing; run npm run precompute:tokyo-limited-express-loop first.",
  },
];

module.exports = {
  DATA_FILES,
  PART_DATASETS,
};
