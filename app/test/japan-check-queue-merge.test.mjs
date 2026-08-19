/*
 * The check queue's partial-rerun merge.
 *
 * build-japan-check-queue.py --lines rewrites one line's rows and keeps
 * everyone else's. check_ids are numbered per line (…-P000, …-S000), so the
 * merge cannot ask "which ids did this run write?": when a rebuild gives a line
 * FEWER stations than the last run, the ids past the new end are never written
 * again and would survive as orphan rows for platforms and intervals that no
 * longer exist. 京王線 went 33 -> 32 stations on 2026-08-18 and left exactly
 * that behind (…-P032, …-S031), which had to be deleted by hand.
 *
 * The merge is keyed on canonical_key instead. This holds that, plus the two
 * things it must not cost: untouched lines keep their rows verbatim (recorded
 * review verdicts included), and a full rebuild still passes its rows straight
 * through.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(APP_DIR, "scripts/railway/build-japan-check-queue.py");

const KEIO = "京王電鉄␟京王線";
const KEIO_NEW = "京王電鉄␟京王新線";
const SHINKANSEN = "東海旅客鉄道␟東海道新幹線";

// One row per checkpoint, trimmed to the fields the merge reads or must carry.
function rows(key, id, kind, count, verdict = "pending") {
  return Array.from({ length: count }, (_, index) => ({
    check_id: `JP-APPLE-${id}-${kind}${String(index).padStart(3, "0")}`,
    canonical_key: key,
    visual_review_status: verdict,
  }));
}

const KEIO_ID = "jp-京王電鉄-京王線";
const SHINKANSEN_ID = "jp-東海旅客鉄道-東海道新幹線";

// Last run's queue: 京王線 at 33 stations, plus a line this rerun never names.
const previous = [
  ...rows(KEIO, KEIO_ID, "P", 33),
  ...rows(KEIO, KEIO_ID, "S", 32),
  ...rows(SHINKANSEN, SHINKANSEN_ID, "P", 3, "verified"),
];
// This run: 京王線 is down to 32 stations.
const rebuilt = [...rows(KEIO, KEIO_ID, "P", 32), ...rows(KEIO, KEIO_ID, "S", 31)];

function merge(wanted) {
  const driver = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("check_queue", ${JSON.stringify(SCRIPT)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
previous, out, wanted = json.load(sys.stdin)
merged = module.merge_with_previous(previous, out, set(wanted) if wanted else None)
json.dump(merged, sys.stdout, ensure_ascii=False)
`;
  const result = spawnSync("python3", ["-c", driver], {
    input: JSON.stringify([previous, rebuilt, wanted]),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const python = spawnSync("python3", ["--version"]);
const skip = python.status === 0 ? false : "python3 is not on PATH";

test("shrinking_a_line_leaves_no_orphan_rows", { skip }, () => {
  const merged = merge([KEIO, KEIO_NEW]);
  const keio = merged.filter((row) => row.canonical_key === KEIO);
  assert.deepEqual(
    keio.map((row) => row.check_id),
    rebuilt.map((row) => row.check_id).sort(),
  );
  for (const orphan of [`JP-APPLE-${KEIO_ID}-P032`, `JP-APPLE-${KEIO_ID}-S031`])
    assert.equal(
      merged.some((row) => row.check_id === orphan),
      false,
      `${orphan} outlived the station it was numbered for`,
    );
});

test("lines_outside_the_rerun_keep_their_rows_and_verdicts", { skip }, () => {
  const merged = merge([KEIO, KEIO_NEW]);
  assert.deepEqual(
    merged.filter((row) => row.canonical_key === SHINKANSEN),
    previous.filter((row) => row.canonical_key === SHINKANSEN),
  );
  assert.deepEqual(
    merged.map((row) => row.check_id),
    [...merged.map((row) => row.check_id)].sort(),
  );
});

test("a_full_rebuild_is_the_whole_queue", { skip }, () => {
  assert.deepEqual(merge([]), rebuilt);
});
