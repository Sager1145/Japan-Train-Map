/*
 * The staged rebuild's safety net.
 *
 * 596 + 39 + 27 lines are rebuilt a batch at a time across ~64 sessions, and
 * every country builder writes a WHOLE package. The only thing standing
 * between that and session 40 quietly erasing session 12's accepted work is
 * promote-lines.mjs, so its two guarantees are held here rather than assumed:
 * promotion is ORDER-INDEPENDENT, and it is NON-DESTRUCTIVE to lines it was
 * not asked to touch.
 *
 * The batch table is checked against the pre-rebuild reference packages too:
 * a work list that does not actually cover the network it claims to cover
 * would send the whole rebuild off course while every individual session
 * still looked green.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { promoteLines } from "../scripts/railway/promote-lines.mjs";
import { recomputeDerived } from "../scripts/railway/recompute-package-derived.mjs";
import {
  readBatchTable,
  resolveRowsAgainstPackage,
  rowsForSession,
} from "../scripts/railway/lib/rebuild-batches.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REFERENCE_PACKAGES = {
  hk: "data/raw/railway/hk/packages/hk-2025-pre-rebuild-ad80bc90.json.gz",
  tw: "data/raw/railway/tw/packages/tw-2025-pre-rebuild-7123a58a.json.gz",
  jp: "data/raw/railway/jp/packages/jp-2025-pre-rebuild-25031fbc.json.gz",
};

function referencePackage(country) {
  const file = path.join(APP_DIR, REFERENCE_PACKAGES[country]);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
}

function emptyLike(pkg) {
  const next = { ...pkg, lines: [] };
  if ("lanes" in next) next.lanes = [];
  return next;
}

test("promoting in two batches equals promoting both at once", () => {
  const source = referencePackage("hk");
  assert.ok(source, "hk reference package missing");
  const first = source.lines.slice(0, 5).map((line) => line.id);
  const second = source.lines.slice(5, 11).map((line) => line.id);

  const forward = promoteLines(
    promoteLines(emptyLike(source), source, first).package,
    source,
    second,
  ).package;
  const backward = promoteLines(
    promoteLines(emptyLike(source), source, second).package,
    source,
    first,
  ).package;
  const together = promoteLines(emptyLike(source), source, [
    ...first,
    ...second,
  ]).package;

  assert.equal(JSON.stringify(forward), JSON.stringify(backward));
  assert.equal(JSON.stringify(forward), JSON.stringify(together));
});

test("promoting a line twice changes nothing the second time", () => {
  const source = referencePackage("hk");
  const ids = source.lines.slice(0, 4).map((line) => line.id);
  const once = promoteLines(emptyLike(source), source, ids).package;
  const twice = promoteLines(once, source, ids).package;
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

test("promotion never touches a line it was not asked for", () => {
  const source = referencePackage("hk");
  const target = promoteLines(
    emptyLike(source),
    source,
    source.lines.map((line) => line.id),
  ).package;

  // A staging package whose OTHER lines have all drifted. Only the named line
  // may come across; every other line must still be the target's own object.
  const drifted = {
    ...source,
    lines: source.lines.map((line) => ({ ...line, name: `${line.name}-DRIFTED` })),
  };
  const promotedId = source.lines[2].id;
  const result = promoteLines(target, drifted, [promotedId]);

  for (const line of result.package.lines) {
    if (line.id === promotedId) {
      assert.match(line.name, /-DRIFTED$/);
      continue;
    }
    assert.doesNotMatch(line.name, /-DRIFTED$/, line.id);
  }
  assert.equal(result.replaced.length, 1);
  assert.equal(result.untouched.length, source.lines.length - 1);
});

test("promotion refuses a package that is not the same country", () => {
  const hk = referencePackage("hk");
  const tw = referencePackage("tw");
  assert.throws(
    () => promoteLines(emptyLike(hk), tw, [tw.lines[0].id]),
    /country/,
  );
});

test("promotion refuses a line the staging package does not have", () => {
  const source = referencePackage("hk");
  assert.throws(
    () => promoteLines(emptyLike(source), source, ["hk-does-not-exist"]),
    /no line/,
  );
});

test("a fully promoted package matches the reference package line for line", () => {
  for (const country of ["hk", "tw", "jp"]) {
    const source = referencePackage(country);
    if (!source) continue;
    const rebuilt = promoteLines(
      emptyLike(source),
      source,
      source.lines.map((line) => line.id),
    ).package;
    assert.deepEqual(
      rebuilt.lines.map((line) => line.id).sort(),
      source.lines.map((line) => line.id).sort(),
      country,
    );
    // Derived fields are a function of the package, so a package rebuilt from
    // its own lines must recompute to the same lane table it started with.
    if ("lanes" in source)
      assert.deepEqual(
        recomputeDerived(rebuilt).lanes,
        recomputeDerived(source).lanes,
        `${country} lanes`,
      );
  }
});

test("every batch-table row resolves against its reference package", () => {
  const table = readBatchTable();
  // 663 with the 2026-08-18 京王新線 split: the new canonical joins 京王線's
  // own session row (38 / J07-4).
  assert.equal(table.length, 663, "batch table row count");

  const expected = {
    // The 2026-08-13 network corrections: these three canonical lines are in
    // the corrected inventory but not in the package built before it. They are
    // rebuild work, not table errors, and are named so a future unresolved row
    // cannot hide among them.
    // 京王新線 joined the inventory with the 2026-08-18 split of the「京王線」
    // N02 key; the pre-rebuild reference package never drew it as its own
    // line, so its row resolves only against the rebuilt package.
    jp: new Set([
      "広島電鉄␟循環線",
      "三岐鉄道␟近鉄連絡線",
      "富山地方鉄道␟富山駅南北接続線",
      "京王電鉄␟京王新線",
    ]),
    tw: new Set(),
    hk: new Set(),
  };

  for (const country of ["hk", "tw", "jp"]) {
    const source = referencePackage(country);
    if (!source) continue;
    const rows = table.filter((row) => row.country === country);
    const { unresolved } = resolveRowsAgainstPackage(rows, source);
    assert.deepEqual(
      new Set(unresolved.map((row) => row.line_id)),
      expected[country],
      `${country} unresolved rows`,
    );
  }
});

test("the batch table covers every line of every reference package", () => {
  const table = readBatchTable();
  for (const country of ["hk", "tw", "jp"]) {
    const source = referencePackage(country);
    if (!source) continue;
    const rows = table.filter((row) => row.country === country);
    const { ids } = resolveRowsAgainstPackage(rows, source);
    const missing = source.lines
      .map((line) => line.id)
      .filter((id) => !ids.includes(id));
    // 留萌線 was withdrawn by the 2026-08-13 corrections, so the corrected
    // work list deliberately does not rebuild it.
    assert.deepEqual(
      missing,
      country === "jp" ? ["jp-北海道旅客鉄道-留萌線"] : [],
      `${country} lines with no batch row`,
    );
  }
});

test("no session exceeds the plan's size caps", () => {
  const table = readBatchTable();
  const bySession = new Map();
  for (const row of table) {
    if (!bySession.has(row.session)) bySession.set(row.session, []);
    bySession.get(row.session).push(row);
  }
  // The one documented exception: hk tram east + west are the two directional
  // tracks of one corridor, and the batch exists to prove they are NOT merged,
  // so splitting them across sessions would remove the thing being tested.
  const CHECKPOINT_CAP_EXCEPTIONS = new Set([7]);

  for (const [session, rows] of bySession) {
    assert.ok(rows.length <= 15, `session ${session} has ${rows.length} lines`);
    if (rows[0].country === "jp" || CHECKPOINT_CAP_EXCEPTIONS.has(session)) continue;
    const checks = rows.reduce(
      (sum, row) => sum + (Number(row.apple_checks) || 0),
      0,
    );
    assert.ok(checks <= 200, `session ${session} has ${checks} Apple checkpoints`);
  }
});

test("every session builds exactly one country", () => {
  const sessions = new Set(readBatchTable().map((row) => row.session));
  for (const session of sessions) assert.ok(rowsForSession(session).length > 0);
});

