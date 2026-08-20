#!/usr/bin/env node
/*
 * recompute-package-derived.mjs — restate a package's derived fields after a
 * promotion, and rewrite its gzip sidecar.
 *
 * `lanes` and `stats` are functions of the WHOLE package, not of any one line,
 * so a promotion that changed a single line still invalidates both. Leaving
 * them stale is worse than leaving them absent. Nothing reads `lanes` at
 * runtime any more — 38cf0a8 removed the screen-space lane offsets — so what
 * a stale table costs is the next person to audit geometry, who sees rows
 * move and has to prove the movement was not theirs.
 *
 *   lanes  — recomputed from the package's own display geometry by the same
 *            sweep build-parallel-corridors.mjs uses. Derived, never authored.
 *   stats  — `lines` / `intervals` / `stations` / `structure` are counted from
 *            the package. The two provenance counters
 *            (`sourceIntervalsRegeometried`, `sourceIntervalsKept`) describe
 *            how the N02 GEOMETRY BUILD went, which no amount of reading the
 *            finished package can recover, so they are carried through
 *            untouched and restated by finalize-japan-package.mjs when jp is
 *            whole again. They are stale-by-design mid-rebuild and are
 *            reported as such rather than being quietly recomputed to a
 *            number that would look authoritative and be wrong.
 *
 * Usage:
 *   node scripts/railway/recompute-package-derived.mjs --country hk
 *   node scripts/railway/recompute-package-derived.mjs            # every country
 *   node scripts/railway/recompute-package-derived.mjs --country hk --report
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { laneRowsForPackage } from "./build-parallel-corridors.mjs";

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];

const PROVENANCE_FIELDS = ["sourceIntervalsRegeometried", "sourceIntervalsKept"];

/** Pure core: the package with `lanes` and `stats` restated. Not mutated. */
export function recomputeDerived(pkg) {
  const lines = pkg.lines || [];
  const next = { ...pkg };

  // Always computed, never conditional on the field already existing. `lanes`
  // is derived from the package's own geometry, so an absent table means "not
  // computed yet", not "this country has no parallel corridors" — Taiwan's
  // published package had no table at all while the high-speed line runs
  // alongside the TRA trunk for most of the west coast.
  next.lanes = laneRowsForPackage(pkg);

  if ("stats" in pkg) {
    const stats = {
      ...pkg.stats,
      lines: lines.length,
      intervals: lines.reduce((sum, line) => sum + (line.segments || []).length, 0),
      stations: lines.reduce((sum, line) => sum + (line.stations || []).length, 0),
      structure: lines.reduce((sum, line) => sum + (line.structure || []).length, 0),
    };
    for (const field of PROVENANCE_FIELDS)
      if (field in (pkg.stats || {})) stats[field] = pkg.stats[field];
    next.stats = stats;
  }

  return next;
}

function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes("--country") ? argv[argv.indexOf("--country") + 1] : null;
  const reportOnly = argv.includes("--report");

  for (const country of only ? [only] : COUNTRIES) {
    const file = path.join(APP_DIR, "public", "rail", `${country}-2025.json`);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, "utf8");
    const pkg = JSON.parse(before);
    const next = recomputeDerived(pkg);
    const raw = `${JSON.stringify(next)}\n`;

    const laneCount = (next.lanes || []).length;
    const stats = next.stats;
    process.stdout.write(
      `${country}: ${next.lines.length} lines` +
        ("lanes" in next ? `, ${laneCount} lane stretches` : "") +
        (stats
          ? `, ${stats.intervals} intervals, ${stats.stations} stations, ${stats.structure} structure rows`
          : "") +
        `${raw === before ? " (unchanged)" : ""}\n`,
    );
    if (stats)
      for (const field of PROVENANCE_FIELDS)
        if (field in stats && stats[field])
          process.stdout.write(
            `  note: stats.${field} = ${stats[field]} is carried from the last full ` +
              "build and is not recomputed mid-rebuild\n",
          );

    if (reportOnly) continue;
    if (raw !== before) {
      fs.writeFileSync(file, raw);
      process.stdout.write(`  wrote ${country}-2025.json\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
