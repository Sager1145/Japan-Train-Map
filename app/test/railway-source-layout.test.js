"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const APP_DIR = path.join(__dirname, "..");
const RAW_RAILWAY_DIR = path.join(APP_DIR, "data", "raw", "railway");

test("downloaded railway sources are retained in one country-based archive", () => {
  const expectedSources = [
    "jp/N02-25_GML.zip",
    "jp/packages/jp-2025-recovered-copy-97d39339.json.gz",
    "hk/hk-track-alignments.json",
    "hk/hk-tram-alignments.json",
    "hk/hk-tramways-stops-en.csv",
    "hk/hk-tramways-stops-sc.csv",
    "hk/hk-tramways-stops-tc.csv",
    "mo/mo-track-alignments.json",
    "kr/kr-track-alignments.json",
    "kr/official/manifest.json",
  ];

  for (const relativePath of expectedSources) {
    assert.equal(
      fs.existsSync(path.join(RAW_RAILWAY_DIR, relativePath)),
      true,
      relativePath,
    );
  }
  assert.equal(
    fs.existsSync(path.join(APP_DIR, "scripts", "railway", "data")),
    false,
    "downloaded data must not drift back into executable tooling",
  );
});

test("published country packages remain available after source consolidation", () => {
  for (const country of ["jp", "tw", "hk", "mo", "kr"]) {
    assert.equal(
      fs.existsSync(
        path.join(APP_DIR, "public", "rail", `${country}-2025.json`),
      ),
      true,
      country,
    );
  }
});

