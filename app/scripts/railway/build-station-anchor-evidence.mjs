#!/usr/bin/env node
/*
 * build-station-anchor-evidence.mjs — turn measured station-zone findings into
 * `station_anchor_overrides` rows, with the safety check that makes a batch
 * defensible.
 *
 * The multi-line audit reports dots that stand on the wrong platform of a
 * shared station. Moving one means overriding an official N02 station feature
 * with an OSM measurement, so every row this writes carries:
 *
 *   - the OSM platform element it moves to, and that platform's own geometry
 *   - how far the dot moves, and how far the target sits from a NAMED track of
 *     the line's own (the claim)
 *   - the audit verdict that produced it
 *
 * and the row is only written when the target sits within ANCHOR_ON_TRACK_M of
 * that named track. Without that gate a "fix" can drop a dot onto a platform
 * the line does not serve — 盛岡's 山田線 candidate is 110 m from any 山田線
 * track, and 伊万里's is 124 m, so both are refused here rather than
 * discovered later on the map.
 *
 * `--write` is ADDITIVE. The rows this generator can see are only the ones the
 * audit still calls wrong: a row that has been applied makes its station read
 * `agrees_on_platform` on the next audit, so regenerating the array from
 * scratch would delete the whole applied batch and silently revert the package
 * (measured: eleven applied rows rewritten down to one). Applied rows are
 * therefore read back and carried through unchanged, and so are the two
 * blocks that record a human judgement — `reverted` (applied, then withdrawn)
 * and `known_false_positives` (never applied, and never to be proposed again).
 * Removing a row is a hand edit: move it into `reverted` with a reason.
 *
 * Usage:
 *   node scripts/railway/build-station-anchor-evidence.mjs            # dry run
 *   node scripts/railway/build-station-anchor-evidence.mjs --write    # write evidence
 *   --limit N   take only the N largest NEW moves (batching; carried rows are
 *               never affected by it)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadOsmPlatformIndex, loadOsmTrackIndex } from "../railway/lib/osm-basemap-cache.mjs";
import { claimFilterFor, claimedTrackAt, pickPlatform } from "../railway/lib/station-track-claim.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_DIR = path.resolve(APP_DIR, "..");
const PACKAGE = path.join(APP_DIR, "public/rail/jp-2025.json");
const AUDIT = path.join(REPO_DIR, "outputs/railway-audit/multi-line-stations/audit.json");
const EVIDENCE = path.join(
  APP_DIR,
  "data/raw/railway/jp/evidence/station-anchor-overrides.json",
);
const PLATFORM_DIR = path.join(REPO_DIR, "outputs/osm-basemap-cache/platforms");
// The builder matches an override against the N02 FEATURE midpoint, which is
// not the package's station coordinate: anchoring re-seats the drawn dot onto
// the track, so the two differ by metres to tens of metres. Recording the
// package coordinate made the guard fire ("found 0") on the first build.
const N02_FEATURES = path.join(
  APP_DIR,
  "data/raw/railway/jp/rebuild-inventory/stations/n02-platform-features.json",
);

// The target must lie on a NAMED track of the line's own; 25 m is the same
// station gate the audit calibrated against known-good lines.
const ANCHOR_ON_TRACK_M = 25;
const FIXABLE = new Set(["wrong_platform", "package_wrong"]);

const metres = (a, b) =>
  Math.hypot(
    (a[0] - b[0]) * 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180),
    (a[1] - b[1]) * 111320,
  );

/** The OSM platform's own coordinates, straight out of the cell cache. */
function platformGeometry(kind, id) {
  for (const file of fs.readdirSync(PLATFORM_DIR).filter((name) => name.endsWith(".json"))) {
    const record = JSON.parse(fs.readFileSync(path.join(PLATFORM_DIR, file), "utf8"));
    for (const element of record.elements || [])
      if (element.type === kind && element.id === id)
        return element.geometry.map((node) => [node.lon, node.lat]);
  }
  return null;
}

/** Whatever the evidence file already holds, or empty blocks if there is none. */
function previousEvidence() {
  const empty = {
    station_anchor_overrides: [],
    reverted: [],
    known_false_positives: [],
    // Hand-written judgements this generator cannot re-derive. `not_fixed`
    // records a station investigated and deliberately left alone (旭川: OSM
    // maps no platform there, so there is nothing sourced to move the dot
    // onto), and `second_purpose` records a criterion for writing a row that
    // the FIXABLE verdict set cannot express. Both are prose decisions, and a
    // --write that dropped them would erase the reason a station is missing
    // from the array and invite the next batch to re-derive it from scratch.
    not_fixed: [],
  };
  if (!fs.existsSync(EVIDENCE)) return { ...empty, second_purpose: "" };
  const previous = JSON.parse(fs.readFileSync(EVIDENCE, "utf8"));
  for (const block of Object.keys(empty))
    if (Array.isArray(previous[block])) empty[block] = previous[block];
  return { ...empty, second_purpose: previous.second_purpose || "" };
}

/**
 * Rows a human has already thrown out, keyed line␟station.
 *
 * A revert is a JUDGEMENT — 名古屋's pick measured worse after it was applied,
 * 東武日光's claim was another railway's line of the same name — and the
 * evidence that produced the row is unchanged, so the generator would propose
 * it again on the next run and quietly undo the decision. It is read back and
 * honoured instead, and the verdicts are carried into the file it rewrites.
 *
 * `known_false_positives` answers the same way for a pick that was judged
 * wrong BEFORE it was ever applied — 紙屋町東's is the 名古屋 family again, a
 * bus stop 135 m away named for a different stop — so that the refusal is a
 * recorded decision rather than an accident of what the cache happens to hold.
 */
function withdrawnRows(previous = previousEvidence()) {
  return [
    ...previous.reverted.map((row) => ({ ...row, withdrawal: "reverted by hand" })),
    ...previous.known_false_positives.map((row) => ({
      ...row,
      withdrawal: "registered known false positive",
    })),
  ];
}

/** line␟station for any row of any block; the one key this file is joined on. */
const rowKey = (row) => `${row.line}␟${row.station}`;

export function buildRows(options = {}) {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE, "utf8"));
  const audit = JSON.parse(fs.readFileSync(AUDIT, "utf8"));
  const previous = previousEvidence();
  const carried = previous.station_anchor_overrides;
  const alreadyApplied = new Set(carried.map(rowKey));
  const reverted = new Map(withdrawnRows(previous).map((row) => [rowKey(row), row]));
  const { index: trackIndex } = loadOsmTrackIndex();
  const platforms = loadOsmPlatformIndex();
  const byId = new Map(pkg.lines.map((line) => [line.id, line]));
  const features = JSON.parse(fs.readFileSync(N02_FEATURES, "utf8")).features;
  const rows = [];
  const refused = [];
  for (const group of audit.station_groups)
    for (const row of group.lines) {
      if (!FIXABLE.has(row.basemap_verdict)) continue;
      const line = byId.get(row.display_line_id);
      const station = line?.stations.find((entry) => entry[0] === group.station_group);
      if (!station) continue;
      const current = [station[2], station[3]];
      const filter = claimFilterFor(line);
      const trackDistanceAt = (point) => {
        const hit = claimedTrackAt(point, filter, trackIndex, 250);
        return hit ? hit.distance : Infinity;
      };
      // The line's other stops bound the search: at 紙屋町 the 宇品線's own
      // metals are the wye curve, so the platforms 紙屋町西 actually uses lost
      // the adjacency test to one of 本通's, 148 m down 鯉城通り.
      const otherStations = line.stations
        .filter((entry) => entry[0] !== group.station_group)
        .map((entry) => [entry[2], entry[3]]);
      const pick = pickPlatform(current, [], { trackDistanceAt }, platforms.index, {
        radiusMeters: 250,
        otherStations,
      });
      const reject = (why) =>
        refused.push({ station: group.station_name, line: row.display_line_id, why });
      const key = `${line.operator}␟${line.name}␟${station[1]}`;
      // An applied row is never re-derived: the audit that produced it has
      // since been re-run against the FIXED package, so anything measured here
      // would describe the dot after the move, not the defect it answers.
      if (alreadyApplied.has(key)) continue;
      const withdrawn = reverted.get(key);
      if (withdrawn) {
        reject(`${withdrawn.withdrawal} and not re-proposed — ${withdrawn.why}`);
        continue;
      }
      if (!pick) {
        reject("no platform candidate within 250 m");
        continue;
      }
      const onTrack = trackDistanceAt(pick.platform.midpoint);
      if (!(onTrack <= ANCHOR_ON_TRACK_M)) {
        reject(
          `target platform is ${onTrack.toFixed(1)} m from a named track of this line ` +
            `(gate ${ANCHOR_ON_TRACK_M} m)`,
        );
        continue;
      }
      // Which N02 feature the build is currently anchored on: the one nearest
      // the drawn dot among the features that group offers.
      const candidates =
        features[`${line.operator}\u241F${line.name}\u241F${group.station_group}`] || [];
      if (!candidates.length) {
        reject("no N02 platform feature recorded for this line and group");
        continue;
      }
      const n02Feature = candidates.reduce((best, entry) =>
        metres(current, entry.midpoint) < metres(current, best.midpoint) ? entry : best,
      );
      const [kind, id] = pick.platform.key.split("/");
      const geometry = platformGeometry(kind, Number(id));
      if (!geometry || geometry.length < 2) {
        reject("platform element has no usable geometry in the cache");
        continue;
      }
      rows.push({
        line: `${line.operator}␟${line.name}`,
        station: station[1],
        station_group: group.station_group,
        n02_midpoint: n02Feature.midpoint,
        package_station_point: current,
        platform_coords: geometry.map((point) => [
          Number(point[0].toFixed(7)),
          Number(point[1].toFixed(7)),
        ]),
        osm: pick.platform.key,
        platform_ref: pick.platform.ref,
        measured: {
          audit_verdict: row.basemap_verdict,
          dot_moves_m: Number(metres(current, pick.platform.midpoint).toFixed(1)),
          n02_feature_to_package_point_m: Number(
            metres(n02Feature.midpoint, current).toFixed(1),
          ),
          current_to_own_track_m: row.point_to_claimed_track_m,
          target_to_own_track_m: Number(onTrack.toFixed(1)),
          approach_median_offset_m: row.approach_median_offset_m,
        },
        reason:
          `N02 files this line's ${station[1]} feature ${row.point_to_claimed_track_m} m from a ` +
          `way named for the line itself, while OSM platform ${pick.platform.key}` +
          `${pick.platform.ref ? ` (ref ${pick.platform.ref})` : ""} sits ${onTrack.toFixed(1)} m ` +
          `from it. Only the station feature is replaced; the RailroadSection is untouched.`,
      });
    }
  rows.sort((a, b) => b.measured.dot_moves_m - a.measured.dot_moves_m);
  return {
    rows: options.limit ? rows.slice(0, options.limit) : rows,
    carried,
    refused,
    reverted: previous.reverted,
    knownFalsePositives: previous.known_false_positives,
    notFixed: previous.not_fixed,
    secondPurpose: previous.second_purpose,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const limit = argv.includes("--limit") ? Number(argv[argv.indexOf("--limit") + 1]) : 0;
  const { rows, carried, refused, reverted, knownFalsePositives, notFixed, secondPurpose } =
    buildRows({ limit });
  for (const row of carried)
    process.stdout.write(
      `  CARRIED ${row.station.padEnd(10)} ${row.line.padEnd(28)} already applied — ${row.osm}\n`,
    );
  for (const row of rows)
    process.stdout.write(
      `  NEW     ${row.station.padEnd(10)} ${row.line.padEnd(28)} moves ${String(row.measured.dot_moves_m).padStart(6)} m  ` +
        `target ${row.measured.target_to_own_track_m} m from own track  ${row.osm}\n`,
    );
  for (const row of refused)
    process.stdout.write(`  REFUSED ${row.station.padEnd(10)} ${row.line}: ${row.why}\n`);
  // Carried first, then new — the merged array is what would be written, and
  // the two are only ever added to, never replaced by each other.
  const merged = [...carried, ...rows].sort(
    (a, b) => b.measured.dot_moves_m - a.measured.dot_moves_m,
  );
  if (!argv.includes("--write")) {
    process.stdout.write(
      `\n${carried.length} carried + ${rows.length} new = ${merged.length} row(s), ` +
        `${refused.length} refused — dry run\n`,
    );
    return;
  }
  const payload = {
    schema_version: 1,
    purpose:
      "Replace ONE N02 station (platform) feature with its surveyed OSM platform, where the audit " +
      "measured the drawn dot on the wrong platform of a shared station. Track geometry is never " +
      "touched by this block.",
    ...(secondPurpose ? { second_purpose: secondPurpose } : {}),
    generator: "scripts/railway/build-station-anchor-evidence.mjs",
    safety:
      `A row exists only when the target platform is within ${ANCHOR_ON_TRACK_M} m of a way the ` +
      "line can claim — named for the line itself, and carrying no operator tag that names " +
      "somebody else — and only when no OTHER station of the same line stands closer to that " +
      "platform than this one does; the builder additionally refuses to apply a row whose N02 " +
      "feature has moved more than 1 m from the recorded midpoint. A platform mapped as an area " +
      "is measured at the centre of its outline, which is where the builder puts the dot.",
    idempotence:
      "--write is additive. An applied row makes its station read agrees_on_platform on the next " +
      "audit, so it can only be carried over, never re-derived; `reverted` and " +
      "`known_false_positives` are read back for the same reason. Removing a row is a hand edit: " +
      "move it into `reverted` with the measurement that condemns it.",
    retrieved: new Date().toISOString().slice(0, 10),
    source:
      "OpenStreetMap (ODbL) platform elements from outputs/osm-basemap-cache/platforms; " +
      "verdicts from outputs/railway-audit/multi-line-stations/audit.json",
    refused,
    station_anchor_overrides: merged,
    not_fixed: notFixed,
    reverted,
    known_false_positives: knownFalsePositives,
  };
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(payload, null, 1)}\n`);
  process.stdout.write(
    `\nwrote ${merged.length} override(s) (${carried.length} carried + ${rows.length} new) ` +
      `to ${path.relative(REPO_DIR, EVIDENCE)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
