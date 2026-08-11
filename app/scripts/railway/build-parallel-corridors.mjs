#!/usr/bin/env node
/*
 * build-parallel-corridors.mjs — write each package's parallel-lane table.
 *
 * Two independent railways sharing a corridor have to be DRAWN apart, and the
 * renderer needs to know which stretch of which stroke takes which lane. That
 * answer is a sweep over the whole drawn network (an edge index plus a 25 m
 * walk of every kilometre of track), which is far too much work to redo in the
 * browser on every boot — so it is computed here and stored in the package as
 * a `lanes` table that rail-network.js simply reads.
 *
 * The table is DERIVED, not authored: it is a pure function of the package's
 * own display geometry, so regenerating it after any geometry change is
 * mandatory and test/railway-parallel-corridors.test.js fails if the stored
 * table and a freshly computed one disagree.
 *
 * Usage:
 *   node scripts/railway/build-parallel-corridors.mjs            # every country
 *   node scripts/railway/build-parallel-corridors.mjs --country jp
 *   node scripts/railway/build-parallel-corridors.mjs --report   # don't write
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import { detectIndependentOverlappingCorridors } from "./lib/parallel-corridors.mjs";

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const RailNetwork = require(path.join(APP_DIR, "public/rail-network.js"));

const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];

/** The drawn strokes of a package, with the identity each lane decision needs. */
export function displayPartsForPackage(pkg) {
  // Build WITHOUT the stored table: lanes must never feed back into the
  // geometry they are derived from.
  const network = RailNetwork.buildNetworkFromCompactPackage({ ...pkg, lanes: undefined });
  const parts = [];
  for (const line of network.lineById.values()) {
    const stationPoints = (line.stationOrder || [])
      .map((id) => network.stationById.get(id))
      .filter(Boolean)
      .map((station) => [station.lon, station.lat]);
    (line.parts || []).forEach((coordinates, partIndex) => {
      if (coordinates.length < 2) return;
      parts.push({
        lineId: line.lineId,
        groupKey: `${line.operator}\u0000${line.name}`,
        // Which RAILWAY this stroke is — the only thing that may add a lane.
        railwayId: line.railwayId,
        partIndex,
        coordinates,
        stationPoints,
      });
    });
  }
  return parts;
}

export function laneRowsForPackage(pkg) {
  return detectIndependentOverlappingCorridors(displayPartsForPackage(pkg)).rows;
}

function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes("--country") ? argv[argv.indexOf("--country") + 1] : null;
  const reportOnly = argv.includes("--report");

  for (const country of only ? [only] : COUNTRIES) {
    const file = path.join(APP_DIR, `public/rail/${country}-2025.json`);
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    const started = Date.now();
    const { rows, corridors } = detectIndependentOverlappingCorridors(
      displayPartsForPackage(pkg),
    );
    const km = corridors.reduce((sum, c) => sum + (c.toMeters - c.fromMeters), 0) / 1000;
    const lines = new Set(rows.map((row) => row[0]));
    const widest = corridors.reduce(
      (most, c) => Math.max(most, c.members ? c.members.length : 0),
      0,
    );
    process.stdout.write(
      `${country}: ${rows.length} lane stretches over ${lines.size} lines, ` +
        `${km.toFixed(1)} km, widest corridor ${widest} lines (${Date.now() - started} ms)\n`,
    );
    for (const corridor of corridors
      .slice()
      .sort((a, b) => b.toMeters - b.fromMeters - (a.toMeters - a.fromMeters))
      .slice(0, 8))
      process.stdout.write(
        `    ${((corridor.toMeters - corridor.fromMeters) / 1000).toFixed(2)} km ` +
          `lane ${corridor.lane > 0 ? "+" : ""}${corridor.lane}  ${corridor.lineId}#${corridor.partIndex}` +
          `  with ${(corridor.members || []).filter((id) => id !== corridor.lineId).join(", ")}\n`,
      );
    if (reportOnly) continue;
    const previous = JSON.stringify(pkg.lanes || null);
    if (previous === JSON.stringify(rows)) {
      process.stdout.write(`  ${country}: table unchanged\n`);
      continue;
    }
    pkg.lanes = rows;
    fs.writeFileSync(file, `${JSON.stringify(pkg)}\n`);
    process.stdout.write(`  ${country}: wrote lanes table\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
