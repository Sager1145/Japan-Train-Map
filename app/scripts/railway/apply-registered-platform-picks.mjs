// Move a drawn stroke's station dot onto the platform the evidence registers,
// and drop the chord it needed to reach the wrong one.
//
// `station-platform-assignments.json` decides WHICH of the several N02 platform
// features a line stands on at a station: `platform_assignments` per source
// line, `display_part_platforms` per drawn stroke where two strokes of one N02
// line call at different platform groups. Both are read by
// build-japan-package-from-inventory.py, which is a FULL rebuild of the whole
// package from the inventory — the wrong tool for correcting one dot, and not
// idempotent for the three branch badges it drops on the way (see
// rebuild-japan-railway.mjs's step 1). This applies the same registered picks
// surgically to the package on disk instead, and reports rather than repeats
// the ones already applied.
//
// What a re-anchor changes, and nothing else:
//
//   stations[i]      the dot moves to the registered feature's own midpoint
//   segments[i]      if the interval carries its own first vertex, that vertex
//   segments[i-1]    the last vertex of the interval arriving at the station
//   both intervals   km restated by exactly what the replaced edge lost
//
// The vertex REPLACED is the chord: the cut ran from the platform it was given
// straight to the track its line actually uses, so the vertex after it already
// stands on the right metals and every other vertex is kept byte for byte.
// That only holds while the chord is a chord, so the script stops rather than
// guesses if the replacement would LENGTHEN the edge, if the target is not one
// of N02's own features for that group, or if the dot it is moving off is not
// one either.
//
// Registered and applied so far:
//   南海電気鉄道 高野線 岸里玉出   211 m chord — the 高野線's own 1・2番線 stand
//                                 178 m east of the 南海本線 island the dot had
//   西日本旅客鉄道 東海道線 大阪   180 m chord — the 大阪→福島 stroke is the
//                                 梅田貨物線, and since 2023-03-18 it calls at
//                                 うめきた地下ホーム 21–24番のりば, 185 m west
//                                 of the surface islands the main line uses
//
// Usage:
//   node scripts/railway/apply-registered-platform-picks.mjs
//   node scripts/railway/apply-registered-platform-picks.mjs --dry-run
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const PACKAGE_PATH = path.join(APP_DIR, "public", "rail", "jp-2025.json");
const EVIDENCE_PATH = path.join(
  APP_DIR,
  "data/raw/railway/jp/evidence/station-platform-assignments.json",
);
const FEATURES_PATH = path.join(
  APP_DIR,
  "data/raw/railway/jp/rebuild-inventory/stations/n02-platform-features.json",
);

// The package files a few operators under a brand name; the evidence is keyed
// by the N02 legal name, exactly as japan-station-platform-evidence.test.mjs
// reads it.
const OPERATOR_ALIASES = new Map([["東京地下鉄", "東京メトロ"]]);
// A registered target and an N02 feature midpoint are the same point or the
// row is stale.
const SAME_POINT_METERS = 1;
// Past this the vertex next to the anchor is not "the track this platform
// stands on" — the interval would have to be rebuilt, not re-anchored, and
// this script must not be the one to guess how.
const PLATFORM_REACH_METERS = 150;

const EARTH_RADIUS_METERS = 6371008.8;
const rad = (degrees) => (degrees * Math.PI) / 180;
function metres(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

const dryRun = process.argv.includes("--dry-run");
const evidence = JSON.parse(fs.readFileSync(EVIDENCE_PATH, "utf8"));
const n02Features = JSON.parse(fs.readFileSync(FEATURES_PATH, "utf8")).features;
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

/** The evidence key for a drawn stroke: its SOURCE line, not its stroke id. */
function sourceKeyOf(line) {
  const operator = OPERATOR_ALIASES.get(line.operator) || line.operator;
  return `${operator}␟${line.name}`;
}

/** The platform this stroke is registered to use at this station, if any. */
function registeredTarget(line, stationIndex) {
  const key = sourceKeyOf(line);
  const station = line.stations[stationIndex];
  const names = line.stations.map((row) => row[1]);
  // A per-stroke row wins over the source line's own pick — that is what it
  // is for: 高野線's 汐見橋線 stroke and 東海道線's 梅田貨物線 stroke each call
  // at a platform group their trunk never touches.
  for (const row of evidence.display_part_platforms || []) {
    if (row.line !== key) continue;
    const wanted = row.match_stations;
    const forward =
      names.length === wanted.length && names.every((name, i) => name === wanted[i]);
    const backward =
      names.length === wanted.length &&
      names.every((name, i) => name === wanted[wanted.length - 1 - i]);
    if (!forward && !backward) continue;
    const target = row.platform_midpoints[station[1]];
    if (target) return { target, why: `display_part_platforms ${row.match_stations.join("→")}` };
  }
  for (const row of evidence.platform_assignments || []) {
    if (row.line !== key || row.station_group !== station[0]) continue;
    return { target: row.prefer_midpoint_near, why: "platform_assignments" };
  }
  return null;
}

function n02MidpointsFor(line, group) {
  return (n02Features[`${sourceKeyOf(line)}␟${group}`] || []).map((row) => row.midpoint);
}

/**
 * Re-state a line's tunnel/bridge measures across a replaced end edge.
 *
 * `structure` is metres of the N02 walk, a DIFFERENT ruler from the display
 * polyline, and the two drift apart by anchoring, smoothing and branch cutting.
 * So this is applied only when the rows would otherwise claim track the line no
 * longer has — which is the proof that they were measured on the ruler the cut
 * just shortened. 南海 高野線's rows sit far below its total and stayed put:
 * measured against the eleven OSM tunnels and bridges long enough to match
 * unambiguously, they fit the SHORTENED line better (99 m of residual before,
 * 22 m after), so rebasing them would have moved them off their own tunnels.
 * 東海道線-2's last row ends at 871 m against a line of exactly 871 m, which
 * only one ruler can mean.
 *
 * Inside the replaced edge the map is proportional (the chord and the run that
 * replaces it cover the same ground, at different lengths); past it every
 * measure shifts by what the edge lost.
 */
function rebaseStructure(rows, cutStart, before, after) {
  const shift = before - after;
  const map = (measure) => {
    if (measure <= cutStart) return measure;
    if (measure >= cutStart + before) return measure - shift;
    return cutStart + ((measure - cutStart) * after) / before;
  };
  return rows.map((row) => {
    const start = Math.round(map(row[0]));
    const end = Math.max(start + 1, Math.round(map(row[1])));
    return [start, end, ...row.slice(2)];
  });
}

// ── apply ────────────────────────────────────────────────────────────────────

const applied = [];
const already = [];
const rebased = [];

for (const line of pkg.lines) {
  const stations = line.stations || [];
  stations.forEach((station, index) => {
    const registered = registeredTarget(line, index);
    if (!registered) return;
    const anchor = [station[2], station[3]];
    const { target, why } = registered;
    if (metres(anchor, target) <= SAME_POINT_METERS) {
      already.push(`${line.id} ${station[1]} (${why})`);
      return;
    }

    const midpoints = n02MidpointsFor(line, station[0]);
    const isSurveyed = (point) =>
      midpoints.some((midpoint) => metres(midpoint, point) <= SAME_POINT_METERS);
    if (!isSurveyed(target))
      throw new Error(
        `${line.id} ${station[1]}: the registered target ${target.join(",")} is not ` +
          `one of N02's ${midpoints.length} features for this group`,
      );
    if (!isSurveyed(anchor))
      throw new Error(
        `${line.id} ${station[1]}: the dot at ${anchor.join(",")} is not an N02 ` +
          `feature midpoint either — this is not a platform PICK, and re-anchoring ` +
          `it would overwrite whatever moved it`,
      );

    // Both intervals that touch this station, and which end of each is the
    // vertex standing on the dot. `segments[i][1] === 0` means the interval
    // carries its own first vertex; anything else opens on the station row
    // itself, which moves with the dot and needs no edit.
    const offsetOf = (segmentIndex) =>
      line.segments
        .slice(0, segmentIndex)
        .reduce((sum, segment) => sum + segment[0] * 1000, 0);
    const touches = [];
    const outgoing = line.segments[index];
    if (outgoing && outgoing[1] === 0)
      touches.push({ segment: outgoing, at: 0, offset: offsetOf(index) });
    const incoming = line.segments[index - 1];
    if (incoming)
      touches.push({
        segment: incoming,
        at: incoming[2].length - 1,
        offset: offsetOf(index),
        fromEnd: true,
      });

    const moves = [];
    for (const { segment, at, offset, fromEnd } of touches) {
      const points = segment[2];
      const neighbourIndex = at === 0 ? 1 : at - 1;
      const neighbour = points[neighbourIndex];
      if (!neighbour) continue;
      if (metres(points[at], anchor) > SAME_POINT_METERS)
        throw new Error(
          `${line.id} ${station[1]}: interval vertex ${points[at].join(",")} does not ` +
            `stand on the dot it is supposed to`,
        );
      const before = metres(points[at], neighbour);
      const after = metres(target, neighbour);
      if (after > before)
        throw new Error(
          `${line.id} ${station[1]}: moving the dot would LENGTHEN this interval's ` +
            `end edge (${before.toFixed(0)} m to ${after.toFixed(0)} m). The chord ` +
            `is not the edge being replaced; the interval needs rebuilding, not ` +
            `re-anchoring`,
        );
      if (after > PLATFORM_REACH_METERS)
        throw new Error(
          `${line.id} ${station[1]}: the vertex next to the dot is ${after.toFixed(0)} m ` +
            `from the registered platform — too far to be the track it stands on`,
        );
      moves.push({
        segment,
        at,
        before,
        after,
        // Where the replaced edge STARTS along the line, in the ruler the
        // structure rows were written in.
        cutStart: fromEnd ? offset - before : offset,
        km: Number((segment[0] - (before - after) / 1000).toFixed(3)),
      });
    }

    if (!dryRun) {
      station[2] = target[0];
      station[3] = target[1];
      for (const move of moves) {
        move.segment[2][move.at] = [...target];
        move.segment[0] = move.km;
      }
      const total = line.segments.reduce((sum, segment) => sum + segment[0] * 1000, 0);
      const overshoots = (line.structure || []).some((row) => row[1] > total + 1);
      if (overshoots) {
        let rows = line.structure;
        let shifted = 0;
        for (const move of [...moves].sort((left, right) => left.cutStart - right.cutStart)) {
          rows = rebaseStructure(rows, move.cutStart - shifted, move.before, move.after);
          shifted += move.before - move.after;
        }
        line.structure = rows;
        rebased.push(`${line.id} ${station[1]}: ${rows.length} structure rows re-based`);
      }
    }
    applied.push(
      `${line.id} ${station[1]}: dot ${metres(anchor, target).toFixed(0)} m to ` +
        `${target.join(",")} (${why}); ` +
        moves
          .map(
            (move) =>
              `end edge ${move.before.toFixed(0)} m → ${move.after.toFixed(0)} m, ` +
              `interval ${move.km} km`,
          )
          .join("; "),
    );
  });
}

if (applied.length && !dryRun)
  // `version` is the compact-package SCHEMA version. Which platform a dot
  // stands on is content, not encoding, so it does not move.
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg)}\n`);

process.stdout.write(
  `${already.length} registered pick(s) already drawn:\n` +
    already.map((row) => `  ${row}\n`).join("") +
    `${applied.length} re-anchored${dryRun ? " (dry run, nothing written)" : ""}:\n` +
    applied.map((row) => `  ${row}\n`).join("") +
    rebased.map((row) => `  ${row}\n`).join(""),
);
