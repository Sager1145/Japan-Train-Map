#!/usr/bin/env node
/*
 * mark-batch-status.mjs — write one session's verdict back into the batch table.
 *
 * RAILWAY_REBUILD_BATCHES.csv is the authoritative per-line work list, and step 9
 * of every session's SOP is to move that session's rows off `pending`. Doing it
 * by hand across 66 sessions is how a table drifts from the ledger, so this is
 * the only writer.
 *
 * It rewrites the `status` field of the matching rows and NOTHING else: the file
 * is read as bytes, split on CRLF, and each line's last field replaced in place,
 * so a row this session does not own comes out byte-identical.
 *
 * Statuses (the session plan's vocabulary):
 *   done         built, and every gate including the Apple review passed
 *   unverified   built and gates 1-4 passed, but the Apple review is not closed
 *   blocked      not built, with the reason recorded in the ledger
 *   pending      not started
 *
 * `unverified` is not a soft `done`. A session that cannot capture Apple frames
 * ends `unverified`, and the ledger says why.
 *
 * `--lines` marks part of a session. A session that lands 7 of its 12 lines is
 * not 12 rows of anything: the 7 that landed and the 5 that did not have
 * different states, and writing one verdict across all of them loses the only
 * fact the table exists to carry.
 *
 * Usage:
 *   node app/scripts/railway/mark-batch-status.mjs --session 16 --status unverified
 *   node app/scripts/railway/mark-batch-status.mjs --session 17 --status unverified \
 *     --lines '北海道旅客鉄道␟宗谷線,北海道旅客鉄道␟釧網線'
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { BATCH_TABLE_PATH } from "./lib/rebuild-batches.mjs";

const STATUSES = new Set(["done", "unverified", "blocked", "pending"]);

function main() {
  const argv = process.argv.slice(2);
  const at = (flag) =>
    argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
  const session = at("--session");
  const status = at("--status");
  const dryRun = argv.includes("--dry-run");
  const only = new Set(
    (at("--lines") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  if (!session) throw new Error("pass --session <n>");
  if (!STATUSES.has(status))
    throw new Error(`--status must be one of ${[...STATUSES].join(", ")}`);

  const raw = fs.readFileSync(BATCH_TABLE_PATH, "utf8");
  const lines = raw.split("\r\n");
  const header = lines[0].split(",");
  const sessionAt = header.indexOf("session");
  const statusAt = header.indexOf("status");
  const lineAt = header.indexOf("line_id");
  if (sessionAt < 0 || statusAt < 0)
    throw new Error("batch table has no session/status column");
  if (only.size && lineAt < 0)
    throw new Error("batch table has no line_id column to match --lines against");

  let changed = 0;
  const seen = new Set();
  const out = lines.map((line, index) => {
    if (index === 0 || !line) return line;
    const cells = line.split(",");
    if (cells[sessionAt] !== String(session)) return line;
    if (only.size) {
      if (!only.has(cells[lineAt])) return line;
      seen.add(cells[lineAt]);
    }
    if (cells[statusAt] === status) return line;
    cells[statusAt] = status;
    changed += 1;
    return cells.join(",");
  });

  const missing = [...only].filter((id) => !seen.has(id));
  process.stdout.write(
    `session ${session}: ${changed} row(s) -> ${status}${dryRun ? " (--dry-run)" : ""}\n`,
  );
  // A --lines value that matched nothing is a typo or a stale id, and silently
  // marking one row fewer than asked is how a table stops meaning anything.
  for (const id of missing)
    process.stdout.write(`  NOT IN SESSION ${session}: ${id}\n`);
  if (missing.length) process.exitCode = 1;
  if (!dryRun && changed) fs.writeFileSync(BATCH_TABLE_PATH, out.join("\r\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
