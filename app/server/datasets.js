"use strict";

// Single owner of the datasets the API serves and the static build publishes
// under api/. server/create-app.js registers one route per entry;
// scripts/build-static-site.mjs (via createRequire) copies the same entries
// into the Pages bundle — so a new dataset is added here exactly once.

// Whole-file datasets: route name -> file name under app/data.
const DATA_FILES = {
  // Route-solver / statistics geometry, one pair per country and never mixed
  // (see railSectionsApiForCountry). Both pairs carry the SAME schema — Japan
  // through the historical N02_* property names, Taiwan through the neutral
  // aliases the frontend reads for either.
  "rail-sections": "rail-sections.json",
  stations: "stations.json",
  "rail-sections-tw": "rail-sections-tw.json",
  "stations-tw": "stations-tw.json",
  "default-trains": "default-trains.json",
  "matched-routes": "matched-routes.json",
  "matched-stops": "matched-stops.json",
  "station-readings": "station-readings.json",
  "station-readings-tw": "station-readings-tw.json",
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
    // Taiwan keeps a FULLY SEPARATE sample dataset (each country's 資料 card
    // only offers its own country's data; see COUNTRY_SAMPLE_DATA_APIS).
    dir: "sample-data-tw",
    invalidNameError: "Invalid Taiwan sample data name.",
    notFoundLabel: "Taiwan sample data",
    missingDataError:
      "Precomputed Taiwan sample data is missing; run npm run precompute:tw first.",
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
