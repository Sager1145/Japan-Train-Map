#!/usr/bin/env node
/*
 * audit-duplicate-strokes.mjs — the standing "is one railway drawn twice"
 * audit (Japan by default; any country package with --country).
 *
 * A corridor painted two or three times reads as one thick line, and none of
 * the copies is on the real track. The multi-line station audit could not see
 * it: it checks that sibling strokes MEET, never that they are drawing
 * DIFFERENT track.
 *
 * The two coincidence cases look identical in the package and are told apart
 * by the basemap, not by geometry (see duplicate-strokes.mjs):
 *
 *   支線共用軌      a branch over its trunk's own rails — must stay coincident
 *   routed wrong    two strokes of a 複々線 corridor on ONE alignment
 *
 * so the OSM cell cache is required for a verdict. Without it every row is
 * reported `undecidable` rather than guessed at.
 *
 * Usage:
 *   node scripts/validation/audit-duplicate-strokes.mjs
 *   node scripts/validation/audit-duplicate-strokes.mjs --country tw
 *   node scripts/validation/audit-duplicate-strokes.mjs --strict
 *       exit 1 when any adjudicated `duplicate` remains outside the ledger
 *   --json out.json     machine-readable report as well
 *   --cache-dir DIR     override the OSM cell cache location
 *
 * NOT part of npm test: the verdict needs the machine-local OSM cache that
 * validate-basemap-alignment.mjs --fetch downloads. Run it after a geometry
 * rebuild, like the basemap audit and the Apple check queue.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { findDuplicateStrokes } from "../railway/lib/duplicate-strokes.mjs";
import { loadOsmTrackIndex, DEFAULT_CACHE_DIR } from "../railway/lib/osm-basemap-cache.mjs";
import { claimFilterFor } from "../railway/lib/station-track-claim.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_DIR = path.resolve(APP_DIR, "..");
const OUTPUT_DIR = path.join(REPO_DIR, "outputs", "railway-audit", "duplicate-strokes");
const LEDGER_FILE = path.join(
  APP_DIR,
  "data/raw/railway/jp/evidence/duplicate-stroke-exclusions.json",
);

function parseArgs(argv) {
  const options = { country: "jp", strict: false, json: null, cacheDir: DEFAULT_CACHE_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--country") options.country = argv[++index];
    else if (flag === "--strict") options.strict = true;
    else if (flag === "--json") options.json = argv[++index];
    else if (flag === "--cache-dir") options.cacheDir = argv[++index];
  }
  return options;
}

function loadLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return { adjudicated: [] };
  return JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
}

function ledgerKey(lines) {
  return [...lines].sort().join(" ");
}

export function buildReport(options = {}) {
  const country = options.country || "jp";
  const packagePath = path.join(APP_DIR, "public/rail", `${country}-2025.json`);
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const osm = loadOsmTrackIndex({ cacheDir: options.cacheDir });
  const rows = findDuplicateStrokes(pkg, {
    osmIndex: osm.ways ? osm.index : null,
    claimFilterFor,
  });
  const ledger = loadLedger();
  const excluded = new Map(
    (ledger.adjudicated || []).map((entry) => [ledgerKey(entry.lines), entry]),
  );
  for (const row of rows) {
    const entry = excluded.get(ledgerKey(row.lines));
    row.excluded_by_ledger = entry ? entry.reason : null;
  }
  const open = rows.filter((row) => !row.excluded_by_ledger);
  const counts = {};
  for (const row of open) counts[row.duplicate_verdict] = (counts[row.duplicate_verdict] || 0) + 1;
  return {
    schema_version: 1,
    country,
    package_version: pkg.version,
    osm_cache: { cells: osm.cells.length, ways: osm.ways, oldest_fetch: osm.oldestFetch },
    summary: {
      lines: pkg.lines.length,
      relationships_reported: rows.length,
      excluded_by_ledger: rows.length - open.length,
      verdicts: counts,
      duplicate_meters_total: open
        .filter((row) => row.duplicate_verdict === "duplicate")
        .reduce((sum, row) => sum + row.duplicate_meters, 0),
    },
    relationships: rows,
  };
}

function markdown(report) {
  const rows = report.relationships.filter((row) => !row.excluded_by_ledger);
  const section = (verdict, title, note) => {
    const picked = rows.filter((row) => row.duplicate_verdict === verdict);
    const lines = [`## ${title}（${picked.length}）`, "", note, ""];
    if (!picked.length) return [...lines, "- 无", ""];
    lines.push(
      "| 重复里程 | 最长连续 | OSM 股道 | 线路 A | 线路 B |",
      "| ---: | ---: | ---: | --- | --- |",
    );
    for (const row of picked)
      lines.push(
        `| ${row.duplicate_meters} m | ${row.longest_duplicate_run_meters} m | ` +
          `${row.coincident_osm_tracks ?? "—"} | \`${row.lines[0]}\` | \`${row.lines[1]}\` |`,
      );
    return [...lines, ""];
  };
  return [
    "# 重复绘制审计（同一条铁路被画了多次）",
    "",
    `package \`${report.country}\` ${report.package_version} · OSM 缓存 ` +
      `${report.osm_cache.cells} cell / ${report.osm_cache.ways} way（最早 ${report.osm_cache.oldest_fetch}）`,
    "",
    "判据：逐点点到线段，10 m 重采样。≤3 m 连续 ≥200 m 记为重合；",
    "重合是**缺陷还是契约**由底图股道数裁决——普通複線在 OSM 里就是 2 条 way，",
    "所以只有 ≥4 条（两组独立复线）才说明两笔各该有自己的走向。",
    "",
    ...section(
      "duplicate",
      "真重复：走廊有两组独立复线，两笔却挤在同一条上",
      "修法按 prompt 3.3：先问这一笔该不该存在（多半该存在），再把被抄的那笔重新路由到自己的 N02 区段；确属冗余才剪除并在测试里钉住。",
    ),
    ...section(
      "needs_human",
      "需人工：股道数 3，缓存判不出是複線+待避 还是半测绘的複々線",
      "要么补测该走廊的 OSM 股道，要么按官方线路图判定后写进排除账本。",
    ),
    ...section(
      "shared_track_by_contract",
      "合法共轨：单组复线，支线画在干线自己的坐标上",
      "这是 MAIN_BRANCH_SHARED 契约要求的逐点重合，**不是缺陷，不要修**。",
    ),
    ...section("undecidable", "无法判定：该处没有可认领的 OSM 轨道", "缺底图证据，不做结论。"),
    "",
  ].join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport(options);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${report.country}-report.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(OUTPUT_DIR, `${report.country}-README.md`), markdown(report));
  if (options.json) fs.writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
  const verdicts = report.summary.verdicts;
  process.stdout.write(
    `${report.country} duplicate strokes: ` +
      `${verdicts.duplicate || 0} duplicate (${report.summary.duplicate_meters_total} m), ` +
      `${verdicts.needs_human || 0} manual, ` +
      `${verdicts.shared_track_by_contract || 0} shared-by-contract, ` +
      `${report.summary.excluded_by_ledger} excluded\n`,
  );
  if (options.strict && (verdicts.duplicate || 0) > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
