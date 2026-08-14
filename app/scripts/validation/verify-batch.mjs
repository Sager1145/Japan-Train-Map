#!/usr/bin/env node
/*
 * verify-batch.mjs — the acceptance gate for one staged-rebuild session.
 *
 * A session is finished when all five of these hold, and the point of running
 * them from one command is that a session cannot be declared done by checking
 * only the easy ones:
 *
 *   1  COVERAGE     every line the batch table assigns to this session is
 *                   present in the published package — and every row that is
 *                   not is named, because an unresolved row is a finding, not
 *                   a rounding error.
 *   2  DERIVED      `lanes` and `stats` match a fresh recomputation. A stale
 *                   lane table offsets strokes onto geometry that has moved,
 *                   which looks like a rendering bug three sessions later.
 *   3  TOPOLOGY     validate-railway-topology.mjs, scoped to THIS batch's lines.
 *                   Whole-network completeness (`missing_line`) is excluded
 *                   until S66 — see WHOLE_NETWORK_CODES for why.
 *   4  ANCHORING    validate-station-render-anchoring.mjs --strict.
 *   5  APPLE        the session's rows in the country's Apple check queue all
 *                   carry a terminal status. `UNVERIFIED` counts as terminal;
 *                   an untouched row does not. jp has no queue until S16
 *                   generates one, and that absence is reported, not skipped.
 *
 * Exit code is 1 if any gate fails, so a session cannot be closed on a green
 * summary that was never actually green.
 *
 * Usage:
 *   node scripts/validation/verify-batch.mjs --session 2
 *   node scripts/validation/verify-batch.mjs --session 2 --skip-validators
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  parseCsv,
  resolveRowsAgainstPackage,
  rowsForSession,
} from "../railway/lib/rebuild-batches.mjs";
import { recomputeDerived } from "../railway/recompute-package-derived.mjs";

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const TERMINAL_STATUSES = new Set([
  "pass",
  "fail",
  "auto_pass",
  "unverified",
  "not_applicable",
  "data_coverage_gap",
]);

function checkQueuePath(country) {
  return path.join(
    APP_DIR,
    "data",
    "raw",
    "railway",
    country,
    "rebuild-inventory",
    "evidence",
    "apple-maps-reference",
    "check-queue.csv",
  );
}

function runValidator(script, args) {
  const result = spawnSync(
    process.execPath,
    [path.join(APP_DIR, script), ...args],
    { cwd: APP_DIR, encoding: "utf8" },
  );
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  // Prefer the validators' own tally lines. Matching "ERROR" anywhere would
  // surface a finding about some OTHER country's unbuilt lines as if it were
  // this batch's verdict, which is how a green run gets read as red.
  const summary = output
    .split("\n")
    .filter((line) => /^\s*(PASS:|Lines checked:)|platforms —/.test(line))
    .map((line) => line.trim())
    .slice(-2)
    .join(" | ");
  return { ok: result.status === 0, summary: summary || "(no summary line)" };
}

// `missing_line` says a railway nobody has built yet is not drawn. Until the
// last session lands, that is true of every line still in the queue, and the
// validator attributes it to whichever drawn line shares its name — JR East's
// 中央線 was failed for JR Tokai's 中央線 (200 km, owned by S29) being absent.
// Failing a batch for another batch's unfinished work makes the gate unusable
// mid-rebuild, so it is excluded HERE and only here: S66 runs the validator
// whole, where every missing_line must be gone.
const WHOLE_NETWORK_CODES = new Set(["missing_line"]);

/** Topology ERRORs on THIS batch's lines, ignoring whole-network completeness. */
function batchTopology(country, ids) {
  const jsonPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "verify-batch-")),
    "topology.json",
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(APP_DIR, "scripts/validation/validate-railway-topology.mjs"),
      "--country",
      country,
      "--json",
      jsonPath,
    ],
    { cwd: APP_DIR, encoding: "utf8" },
  );
  if (!fs.existsSync(jsonPath))
    return {
      ok: false,
      summary: `validator produced no report (exit ${result.status})`,
      errors: [],
    };
  const reports = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const wanted = new Set(ids);
  const errors = [];
  let checked = 0;
  for (const report of reports)
    for (const line of report.lines || []) {
      if (!wanted.has(line.lineId)) continue;
      checked += 1;
      for (const problem of line.problems || [])
        if (
          problem.severity === "ERROR" &&
          !WHOLE_NETWORK_CODES.has(problem.code)
        )
          errors.push({ lineId: line.lineId, ...problem });
    }
  return {
    ok: errors.length === 0,
    summary:
      `${checked} batch line(s) checked | ${errors.length} ERROR(s) ` +
      `(whole-network completeness excluded until S66)`,
    errors,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const session = argv.includes("--session")
    ? argv[argv.indexOf("--session") + 1]
    : null;
  const skipValidators = argv.includes("--skip-validators");
  if (!session) throw new Error("pass --session <n>");

  const rows = rowsForSession(session);
  const country = rows[0].country;
  const batchCode = rows[0].batch_code;
  const packagePath = path.join(APP_DIR, "public", "rail", `${country}-2025.json`);
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const failures = [];

  process.stdout.write(
    `\n== session ${session} · ${batchCode} · ${country} · ${rows.length} rows ==\n\n`,
  );

  // 1 — coverage
  const { ids, unresolved } = resolveRowsAgainstPackage(rows, pkg);
  process.stdout.write(
    `1 coverage    ${ids.length} display line(s) present for ${rows.length - unresolved.length}/${rows.length} rows\n`,
  );
  for (const row of unresolved)
    process.stdout.write(
      `                MISSING ${row.line_id} (${row.operator} / ${row.line})\n`,
    );
  if (unresolved.length)
    failures.push(`${unresolved.length} batch row(s) not in the published package`);

  // 2 — derived fields
  const fresh = recomputeDerived(pkg);
  const laneDrift =
    "lanes" in pkg && JSON.stringify(pkg.lanes) !== JSON.stringify(fresh.lanes);
  const statsDrift =
    "stats" in pkg && JSON.stringify(pkg.stats) !== JSON.stringify(fresh.stats);
  process.stdout.write(
    `2 derived     lanes ${"lanes" in pkg ? (laneDrift ? "STALE" : "current") : "n/a"}` +
      `, stats ${"stats" in pkg ? (statsDrift ? "STALE" : "current") : "n/a"}\n`,
  );
  if (laneDrift || statsDrift)
    failures.push("derived fields are stale — run recompute-package-derived.mjs");

  // 3 / 4 — the standing validators
  if (skipValidators) {
    process.stdout.write("3 topology    skipped (--skip-validators)\n");
    process.stdout.write("4 anchoring   skipped (--skip-validators)\n");
  } else {
    const topology = batchTopology(country, ids);
    process.stdout.write(
      `3 topology    ${topology.ok ? "PASS" : "FAIL"}  ${topology.summary}\n`,
    );
    for (const problem of topology.errors.slice(0, 8))
      process.stdout.write(`                ${problem.lineId}: ${problem.detail}\n`);
    if (!topology.ok)
      failures.push(`${topology.errors.length} topology ERROR(s) on this batch's lines`);

    const anchoring = runValidator(
      "scripts/validation/validate-station-render-anchoring.mjs",
      ["--country", country, "--strict"],
    );
    process.stdout.write(
      `4 anchoring   ${anchoring.ok ? "PASS" : "FAIL"}  ${anchoring.summary}\n`,
    );
    if (!anchoring.ok)
      failures.push("validate-station-render-anchoring --strict failed");
  }

  // 5 — Apple check queue
  const queuePath = checkQueuePath(country);
  if (!fs.existsSync(queuePath)) {
    process.stdout.write(
      `5 apple       NO QUEUE — ${path.relative(APP_DIR, queuePath)} does not exist\n`,
    );
    failures.push(
      `${country} has no Apple check queue; generate it before accepting a batch`,
    );
  } else {
    // Filter by the DISPLAY ids gate 1 resolved, not by the batch table's own
    // `line_id`. For tw and hk the two are the same string, but a jp row
    // carries the canonical `operator␟line` key while the queue is written
    // against display lines — matching raw strings there selects nothing, and a
    // zero-row selection passes this gate without a single checkpoint reviewed.
    const wanted = new Set(ids);
    const queue = parseCsv(fs.readFileSync(queuePath, "utf8")).filter((row) =>
      wanted.has(row.line_id),
    );
    const done = queue.filter((row) =>
      TERMINAL_STATUSES.has(String(row.visual_review_status || "").toLowerCase()),
    );
    process.stdout.write(
      `5 apple       ${done.length}/${queue.length} checkpoints have a terminal review status\n`,
    );
    if (queue.length && done.length !== queue.length)
      failures.push(
        `${queue.length - done.length} Apple checkpoint(s) still have no terminal status`,
      );
  }

  process.stdout.write("\n");
  if (!failures.length) {
    process.stdout.write(`session ${session} (${batchCode}): ALL GATES PASS\n`);
    return;
  }
  for (const failure of failures) process.stdout.write(`BLOCKED — ${failure}\n`);
  process.stdout.write(
    `\nsession ${session} (${batchCode}) is NOT accepted. ` +
      "Record every unresolved item in RAILWAY_REBUILD_LEDGER.md before moving on.\n",
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
