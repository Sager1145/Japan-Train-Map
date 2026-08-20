// Every published package's derived tables match a fresh recomputation.
//
// `lanes` and `stats` are pure functions of the package's own display
// geometry, so a promotion that moved a single line invalidates both. The
// DERIVED gate in scripts/validation/verify-batch.mjs already compares the
// STORED table against a fresh one — a real second opinion, not a recompute
// on both sides — but it reads its country from the batch table it is closing
// (`rows[0].country`), and every batch so far has been jp. tw, hk, kr and mo
// belong to no batch, so that gate had never once run on them.
//
// It showed. 732a5d7 changed the lane sweep's end rounding to
// `Math.ceil(total * 10) / 10` — a decimetre past the measured endpoint, so
// the ramp covers the last vertex — and regenerated jp alone. tw and kr kept
// the old `toFixed(1)` ending from 9965416, hk from dfb4496, and seven rows
// sat a decimetre short for two days without anything noticing.
//
// Nothing rendered wrong: 38cf0a8 removed every runtime reader of `lanes`
// (splitPartByLanes, parallelLaneOffset, laneProfiles), and the render
// snapshot does not hash it. What a stale table costs is the next person to
// audit geometry, who sees rows move and has to prove it was not their doing.
// This suite makes that impossible to inherit — it is country-agnostic on
// purpose, because the countries that drifted are exactly the ones no
// batch-scoped check could reach.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { recomputeDerived } from "../scripts/railway/recompute-package-derived.mjs";

const RAIL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public/rail",
);

const packages = fs
  .readdirSync(RAIL_DIR)
  .filter((name) => /^[a-z]{2}-2025\.json$/.test(name))
  .sort();

test("every rail package ships derived tables that match a fresh recomputation", () => {
  assert.ok(packages.length >= 5, `only ${packages.length} packages found`);

  for (const name of packages) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(RAIL_DIR, name), "utf8"),
    );
    const fresh = recomputeDerived(pkg);

    // Compared as VALUES. A package written by Node and a table recomputed
    // here agree on numbers long before they agree on text, and this project
    // has already lost days to a text diff that only ever saw `4.0` against
    // `4`.
    if ("lanes" in pkg)
      assert.deepEqual(
        pkg.lanes,
        fresh.lanes,
        `${name}: lanes are stale — run recompute-package-derived.mjs --country ${name.slice(0, 2)}`,
      );
    if ("stats" in pkg)
      assert.deepEqual(
        pkg.stats,
        fresh.stats,
        `${name}: stats are stale — run recompute-package-derived.mjs --country ${name.slice(0, 2)}`,
      );
  }
});
