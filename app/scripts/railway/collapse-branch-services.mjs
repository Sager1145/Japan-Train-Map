#!/usr/bin/env node
/*
 * collapse-branch-services.mjs — one railway with a branch, not two railways
 * sharing the same track.
 *
 * Metro operators publish a branched line as two complete end-to-end services:
 *
 *   東鐵綫 to 羅湖 and 東鐵綫 to 落馬洲, both listed from 金鐘, sharing every
 *   station as far as 上水 — 34 km of the same track.
 *   中和新蘆線 to 蘆洲 and to 迴龍, both listed from 南勢角, sharing 12 stations.
 *
 * Stored that way the package says these are two DIFFERENT railways that
 * happen to run one corridor, and the renderer answers that correctly — by
 * pulling them into parallel lanes for the whole shared length
 * (scripts/railway/lib/parallel-corridors.mjs). The map then claims Hong Kong has two
 * East Rail Lines and Taipei two 中和新蘆線.
 *
 * Each has ONE, with a branch. So the branch row keeps only its own run — from
 * the junction station to its terminus — and BOTH rows carry the LINE's name,
 * which is what makes corridorRenderMode read them as MAIN_BRANCH_SHARED and
 * leave them exactly coincident over the track they really do share.
 *
 * scripts/railway/build-hong-kong-rail-package.py (branch_variants) and
 * scripts/railway/build-taiwan-rail-package.py already emit this shape. This migration
 * applies the same correction to the shipped packages, because rebuilding them
 * needs source files that are fetched rather than committed.
 *
 * Idempotent: a package already in the corrected shape is left alone.
 *
 * Usage:
 *   node scripts/railway/collapse-branch-services.mjs
 *   node scripts/railway/collapse-branch-services.mjs --country hk
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const CASES = [
  {
    // 東鐵綫: 金鐘 → 羅湖, with 上水 → 落馬洲 branching off at 上水.
    country: "hk",
    trunkId: "hk-mtr-eal-low",
    branchId: "hk-mtr-eal-lmc",
    name: "東鐵綫",
    nameRoma: "East Rail Line",
  },
  {
    // 將軍澳綫: 北角 → 寶琳, with 將軍澳 → 康城 branching off at 將軍澳.
    country: "hk",
    trunkId: "hk-mtr-tkl-poa",
    branchId: "hk-mtr-tkl-lhp",
    name: "將軍澳綫",
    nameRoma: "Tseung Kwan O Line",
  },
  {
    // 中和新蘆線: 南勢角 (O01) → 迴龍 (O21) is the numbered line; the 蘆洲
    // stations are numbered O50–O54 and hang off 大橋頭 (O12), which is where
    // the Y-junction is.
    country: "tw",
    trunkId: "tw-trtc-o-huilong",
    branchId: "tw-trtc-o-luzhou",
    name: "中和新蘆線",
    nameRoma: "Zhonghe-Xinlu Line",
  },
];

// The solver datasets are generated from the same line list, so a rebuild
// renames AND re-emits them. Do both here, or the audit and the mileage
// statistics would go on reporting two railways where the map now draws one,
// and the section↔package check would compare a five-interval branch against
// the sixteen intervals it used to repeat.
//
// The files are written line by line in package order, so the package itself
// says how many rows each line owns; anything above that count at the head of
// the collapsed branch's block is the trunk it no longer repeats. Idempotent:
// with nothing extra, nothing is dropped.
function syncDerivedDatasets(country, pkg, renames, branchIds) {
  const groupKey = (name, operator) => `${name}\u0000${operator}`;
  for (const [name, spec] of [
    ["rail-sections", (line) => line.segments.length],
    ["stations", (line) => line.stations.length],
  ]) {
    const file = path.join(APP_DIR, "data", `${name}-${country}.json`);
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const before = data.features.length;
    for (const feature of data.features) {
      const replacement = renames.get(feature.properties?.line_name);
      if (replacement) feature.properties.line_name = replacement;
    }
    const groups = new Map();
    for (const feature of data.features) {
      const key = groupKey(feature.properties.line_name, feature.properties.operator);
      const rows = groups.get(key) || [];
      rows.push(feature);
      groups.set(key, rows);
    }
    const wanted = new Map();
    for (const line of pkg.lines) {
      const key = groupKey(line.name, line.operator);
      wanted.set(key, (wanted.get(key) || 0) + spec(line));
    }
    const keep = new Set();
    // `wanted` is the whole group's share, but each line consumes part of it,
    // so the excess has to be measured against what is STILL owed — otherwise
    // the branch looks like it is already short and keeps the trunk rows it
    // was supposed to drop.
    const owed = new Map(wanted);
    for (const line of pkg.lines) {
      const key = groupKey(line.name, line.operator);
      const rows = groups.get(key);
      if (!rows) continue;
      const take = spec(line);
      const excess = rows.length - (owed.get(key) || 0);
      if (branchIds.has(line.id) && excess > 0) rows.splice(0, excess);
      for (const feature of rows.splice(0, take)) keep.add(feature);
      owed.set(key, (owed.get(key) || 0) - take);
    }
    const trimmed = data.features.filter((feature) => keep.has(feature));
    if (trimmed.length === before && !renames.size) continue;
    data.features = trimmed;
    fs.writeFileSync(file, JSON.stringify(data));
    process.stdout.write(
      `  ${name}-${country}.json: ${before} → ${trimmed.length} rows\n`,
    );
  }
}

function collapse(country) {
  const file = path.join(APP_DIR, `public/rail/${country}-2025.json`);
  if (!fs.existsSync(file)) return;
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const renames = new Map();
  const branchIds = new Set();
  const lineById = new Map(pkg.lines.map((line) => [line.id, line]));
  let changed = 0;

  for (const plan of CASES.filter((item) => item.country === country)) {
    const trunk = lineById.get(plan.trunkId);
    const branch = lineById.get(plan.branchId);
    if (!trunk || !branch) throw new Error(`${plan.trunkId}/${plan.branchId} missing`);

    const onTrunk = new Set(trunk.stations.map((row) => row[1]));
    // The junction is the LAST station the branch still shares with the trunk.
    let junction = 0;
    for (let index = 0; index < branch.stations.length; index += 1) {
      if (onTrunk.has(branch.stations[index][1])) continue;
      junction = Math.max(0, index - 1);
      break;
    }
    if (junction === 0 && trunk.name === plan.name && branch.name === plan.name) {
      process.stdout.write(`${plan.name}: already collapsed\n`);
      continue;
    }
    if (!onTrunk.has(branch.stations[junction][1]))
      throw new Error(`${plan.branchId}: no junction station shared with its trunk`);

    for (const line of [trunk, branch])
      if (line.name !== plan.name) renames.set(line.name, plan.name);
    branchIds.add(branch.id);
    const junctionName = branch.stations[junction][1];
    const terminus = branch.stations.at(-1)[1];
    // Segment i runs station i → station i+1, so dropping the first `junction`
    // stations drops exactly the first `junction` segments. The surveyed
    // geometry of what is left is untouched.
    branch.stations = branch.stations.slice(junction);
    branch.segments = branch.segments.slice(junction);
    // The first row of a line carries its own opening vertex; a continuing row
    // leaves it implicit and inherits it from the row before. What is now the
    // first row used to be a continuing one, so give it back the vertex it was
    // borrowing — the junction station itself, which is where the dropped row
    // ended.
    const first = branch.segments[0];
    if (first && first[1] === 1) {
      const [, , lon, lat] = branch.stations[0];
      first[1] = 0;
      first[2] = [[lon, lat], ...first[2]];
    }
    for (const line of [trunk, branch]) {
      line.name = plan.name;
      if (line.nameRoma) line.nameRoma = plan.nameRoma;
    }
    const km = (line) => line.segments.reduce((sum, row) => sum + row[0], 0);
    process.stdout.write(
      `${plan.name}: trunk ${trunk.stations.length} stations ${km(trunk).toFixed(2)} km, ` +
        `branch ${junctionName} → ${terminus} ${branch.stations.length} stations ${km(branch).toFixed(2)} km\n`,
    );
    changed += 1;
  }

  // Always re-sync: the package can already be collapsed while the derived
  // datasets still carry the rows it dropped (a half-applied migration).
  for (const plan of CASES.filter((item) => item.country === country))
    branchIds.add(plan.branchId);
  syncDerivedDatasets(country, pkg, renames, branchIds);
  if (!changed) return;
  // The lane table is derived from the drawn geometry and this changes it;
  // drop it so a stale table can never be shipped.
  delete pkg.lanes;
  fs.writeFileSync(file, `${JSON.stringify(pkg)}\n`);
  process.stdout.write(
    `${country}: ${pkg.lines.length} lines — now run scripts/railway/build-parallel-corridors.mjs\n`,
  );
}

const argv = process.argv.slice(2);
const only = argv.includes("--country") ? argv[argv.indexOf("--country") + 1] : null;
for (const country of only ? [only] : ["hk", "tw"]) collapse(country);
