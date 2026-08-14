#!/usr/bin/env node
/*
 * promote-lines.mjs — move one session's lines from a staging package into the
 * published one, and touch nothing else.
 *
 * The staged rebuild builds a country a few lines at a time, but every country
 * builder (build-hong-kong-rail-package.py, build-taiwan-rail-package.py,
 * scripts/railway/n02/build_package.py) writes a WHOLE package. Run twice, the
 * second run would erase the first session's accepted work. So builders write
 * to data/staging/<cc>-2025.staging.json and only this script writes
 * public/rail/<cc>-2025.json, upserting by `line.id`.
 *
 * Two properties make the staged rebuild safe, and test/rail-package-promotion
 * .test.mjs holds both:
 *
 *   ORDER-INDEPENDENT — promoting A then B gives byte-identical output to
 *   promoting B then A, because the published `lines` array is re-sorted by id
 *   (code-unit order) on every write.
 *
 *   NON-DESTRUCTIVE — a line not named by this session is carried over by
 *   reference, so it cannot drift even if staging holds a different version of
 *   it.
 *
 * Derived fields (`lanes`, `stats`) are NOT written here — they are a function
 * of the whole package, so recompute-package-derived.mjs owns them and must run
 * after every promotion.
 *
 * Usage:
 *   node scripts/railway/promote-lines.mjs --country hk --session 2
 *   node scripts/railway/promote-lines.mjs --country hk --lines hk-mtr-isl,hk-mtr-twl
 *   node scripts/railway/promote-lines.mjs --country jp --session 16 --dry-run
 *   node scripts/railway/promote-lines.mjs --country jp --session 18 --prune
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveRowsAgainstPackage, rowsForSession } from "./lib/rebuild-batches.mjs";

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const COUNTRIES = new Set(["jp", "tw", "hk", "mo", "kr"]);

export function publishedPath(country) {
  return path.join(APP_DIR, "public", "rail", `${country}-2025.json`);
}

export function stagingPath(country) {
  return path.join(APP_DIR, "data", "staging", `${country}-2025.staging.json`);
}

/** Code-unit order: locale-independent, so the same input always sorts the same. */
function byId(a, b) {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function assertCompatible(target, source) {
  for (const field of ["format", "country", "crs"]) {
    if (source[field] === undefined) continue;
    if (target[field] !== undefined && target[field] !== source[field])
      throw new Error(
        `staging ${field} "${source[field]}" does not match published "${target[field]}"`,
      );
  }
}

function assertUniqueIds(lines, label) {
  const seen = new Set();
  for (const line of lines) {
    if (!line || typeof line.id !== "string" || !line.id)
      throw new Error(`${label} contains a line without an id`);
    if (seen.has(line.id))
      throw new Error(`${label} contains duplicate line id ${line.id}`);
    seen.add(line.id);
  }
}

/**
 * Pure core: returns the package that promoting `ids` from `source` into
 * `target` produces, plus what changed. Neither argument is mutated.
 */
export function promoteLines(target, source, ids) {
  assertCompatible(target, source);
  assertUniqueIds(target.lines || [], "published package");
  assertUniqueIds(source.lines || [], "staging package");

  const sourceById = new Map((source.lines || []).map((line) => [line.id, line]));
  const kept = new Map((target.lines || []).map((line) => [line.id, line]));

  const added = [];
  const replaced = [];
  const missing = [];
  for (const id of ids) {
    const line = sourceById.get(id);
    if (!line) {
      missing.push(id);
      continue;
    }
    if (kept.has(id)) replaced.push(id);
    else added.push(id);
    kept.set(id, line);
  }
  if (missing.length)
    throw new Error(
      `staging package has no line(s): ${missing.slice(0, 8).join(", ")}` +
        (missing.length > 8 ? ` (+${missing.length - 8} more)` : ""),
    );

  const promoted = new Set(ids);
  const untouched = (target.lines || []).filter((line) => !promoted.has(line.id));

  return {
    package: { ...target, lines: [...kept.values()].sort(byId) },
    added,
    replaced,
    untouched,
  };
}

function parseArgs(argv) {
  const at = (flag) =>
    argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
  return {
    country: at("--country"),
    session: at("--session"),
    lines: at("--lines"),
    from: at("--from"),
    into: at("--into"),
    dryRun: argv.includes("--dry-run"),
    prune: argv.includes("--prune"),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.country || !COUNTRIES.has(args.country))
    throw new Error("--country must be one of jp, tw, hk, mo, kr");
  if (!args.session && !args.lines)
    throw new Error("pass --session <n> or --lines <id,id,...>");

  const targetPath = args.into || publishedPath(args.country);
  const sourcePath = args.from || stagingPath(args.country);
  if (!fs.existsSync(sourcePath))
    throw new Error(
      `staging package not found: ${path.relative(APP_DIR, sourcePath)}\n` +
        "Run the country builder with its staging output first.",
    );

  const target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

  let ids;
  let unresolved = [];
  if (args.lines) {
    ids = args.lines
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  } else {
    const rows = rowsForSession(args.session);
    if (rows[0].country !== args.country)
      throw new Error(
        `session ${args.session} builds ${rows[0].country}, not ${args.country}`,
      );
    ({ ids, unresolved } = resolveRowsAgainstPackage(rows, source));
  }
  if (!ids.length) throw new Error("nothing to promote");

  const result = promoteLines(target, source, ids);

  process.stdout.write(
    `${args.country}: promote ${ids.length} line(s) — ` +
      `${result.added.length} added, ${result.replaced.length} replaced, ` +
      `${result.untouched.length} untouched\n`,
  );
  // A row the staging package cannot supply is evidence, not noise: it is
  // either a line the source dropped or one a later correction added. It is
  // reported at every run and never silently skipped.
  for (const row of unresolved)
    process.stdout.write(
      `  UNRESOLVED  ${row.line_id}  (${row.operator} / ${row.line}) — ` +
        "not in the staging package; record it in the ledger before accepting this batch\n",
    );

  // --prune removes lines this session OWNS that the builder no longer produces.
  //
  // Without it a line promoted under an earlier, buggier build stays in the
  // package for good: the builder stops emitting it, every later run leaves it
  // untouched, and the map keeps drawing geometry nothing can reproduce. That is
  // the opposite failure from the one the staging rule guards against, and it is
  // just as bad, so the removal is scoped to THIS session's rows — it can never
  // touch a line another session owns.
  let pruned = [];
  if (args.prune) {
    if (!args.session)
      throw new Error("--prune needs --session, so the removal stays scoped to one batch");
    const owned = new Set(
      resolveRowsAgainstPackage(rowsForSession(args.session), target).ids,
    );
    const keep = new Set(ids);
    pruned = result.package.lines
      .map((line) => line.id)
      .filter((id) => owned.has(id) && !keep.has(id));
    if (pruned.length)
      result.package.lines = result.package.lines.filter(
        (line) => !pruned.includes(line.id),
      );
    for (const id of pruned)
      process.stdout.write(
        `  PRUNED      ${id} — this session owns it and the builder no longer produces it\n`,
      );
  }

  if (args.dryRun) {
    process.stdout.write("  --dry-run: nothing written\n");
    return;
  }
  fs.writeFileSync(targetPath, `${JSON.stringify(result.package)}\n`);
  process.stdout.write(
    `  wrote ${path.relative(APP_DIR, targetPath)} (${result.package.lines.length} lines)\n` +
      "  now run: node scripts/railway/recompute-package-derived.mjs --country " +
      `${args.country}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
