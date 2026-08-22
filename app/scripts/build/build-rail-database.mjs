#!/usr/bin/env node
/*
 * build-rail-database.mjs — write data/rail.db, the relational mirror of the
 * published railway data.
 *
 * The five display packages, the multilingual station-name tables, the route
 * solver's section/station datasets and the badge attribution files all
 * describe ONE network, but each is shaped for the consumer that reads it: a
 * package is per-line arrays tuned for transfer size, a reading table is two
 * keyed dictionaries, the solver data is GeoJSON. Answering "which lines call
 * at this station", "what is this station called in Korean", or "which
 * operator runs the most tunnel kilometres" means joining across all four by
 * hand, in whatever language the caller happens to be written in.
 *
 * This builds those joins once, as tables. It is DERIVED output: the packages
 * stay the source of truth, and this file is rewritten from scratch on every
 * run. Nothing in the app reads the database — it exists for querying,
 * reporting and cross-checking.
 *
 * Usage:
 *   node scripts/build/build-rail-database.mjs               # data/rail.db
 *   node scripts/build/build-rail-database.mjs --out /tmp/x.db
 *   node scripts/build/build-rail-database.mjs --no-geometry # attributes only
 *   node scripts/build/build-rail-database.mjs --quiet
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APP_DIR, buildDatabase } from "./rail-database/load.mjs";

function parseArguments(argv) {
  const options = {
    outFile: path.join(APP_DIR, "data", "rail.db"),
    geometry: true,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      index += 1;
      options.outFile = path.resolve(argv[index]);
    } else if (argument === "--no-geometry") {
      options.geometry = false;
    } else if (argument === "--quiet") {
      options.quiet = true;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const log = options.quiet ? () => {} : (message) => process.stdout.write(`${message}\n`);
  const startedAt = Date.now();

  log(`Building ${path.relative(APP_DIR, options.outFile)}${options.geometry ? "" : " (no geometry)"}`);
  const counts = buildDatabase({ ...options, log });

  const bytes = fs.statSync(options.outFile).size;
  const width = Math.max(...Object.keys(counts).map((name) => name.length));
  for (const name of Object.keys(counts).sort())
    log(`  ${name.padEnd(width)}  ${counts[name].toLocaleString("en-US").padStart(9)}`);
  log(
    `Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${(bytes / 1024 / 1024).toFixed(1)} MB`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
