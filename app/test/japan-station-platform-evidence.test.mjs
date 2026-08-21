// Two evidence files decide, per line, WHICH platform a Japanese station's dot
// stands on: `platform_assignments` picks between the several features N02
// files for one (line, station group), and `station_anchor_overrides` replaces
// one of those features with a surveyed OSM platform. Neither leaves a trace in
// the finished package that anything reading it could recognise — the dot is
// just a coordinate — so a rebuild that lost the evidence, or a builder change
// that stopped honouring it, would move the dots back and every other gate
// would still pass. Both defects it guards against were live in 2026-08:
//
//   * 立川's 青梅線 dot stood on the platform feature N02 copies from 中央線,
//     and the 西立川–立川 interval had to come down the 青梅短絡線 to reach it —
//     313.7 m from the passenger line at its worst, and invisible to the
//     corridor audit because the 短絡線 is active track.
//   * 姫路's 播但線 and 姫新線 dots stood on the platform demolished when the
//     station went onto its viaduct in 2008, 52 m from any of their own metals,
//     with a 55 m hook drawn to reach them.
//
// Everything here is measured against COMMITTED data only — the package, the
// two evidence files and the N02 platform-feature table — so it runs in CI
// without the OSM cache.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const APP_DIR = path.join(import.meta.dirname, "..");
const read = (...parts) => JSON.parse(fs.readFileSync(path.join(APP_DIR, ...parts), "utf8"));

const pkg = read("public", "rail", "jp-2025.json");
const overrides = read(
  "data", "raw", "railway", "jp", "evidence", "station-anchor-overrides.json",
);
const assignments = read(
  "data", "raw", "railway", "jp", "evidence", "station-platform-assignments.json",
);
const n02Features = read(
  "data", "raw", "railway", "jp", "rebuild-inventory", "stations", "n02-platform-features.json",
).features;

// The package files a few operators under a brand name; the evidence is keyed
// by the N02 legal name, which is what the builder reads.
const OPERATOR_ALIASES = new Map([["東京地下鉄", "東京メトロ"]]);

function metres(a, b) {
  return Math.hypot(
    (a[0] - b[0]) * 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180),
    (a[1] - b[1]) * 111320,
  );
}

function pointToSegment(point, start, end) {
  const kx = 111320 * Math.cos((((start[1] + end[1]) / 2) * Math.PI) / 180);
  const ky = 111320;
  const px = (point[0] - start[0]) * kx;
  const py = (point[1] - start[1]) * ky;
  const bx = (end[0] - start[0]) * kx;
  const by = (end[1] - start[1]) * ky;
  const lengthSquared = bx * bx + by * by;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, (px * bx + py * by) / lengthSquared));
  return Math.hypot(px - t * bx, py - t * by);
}

function pointToOutline(point, coords) {
  if (coords.length < 2) return metres(point, coords[0]);
  let best = Infinity;
  for (let i = 0; i + 1 < coords.length; i += 1) {
    const distance = pointToSegment(point, coords[i], coords[i + 1]);
    if (distance < best) best = distance;
  }
  return best;
}

/**
 * Every drawn dot a source line puts at one station group.
 *
 * A row names the SOURCE line, and a source line can be drawn as several
 * display strokes (高野線 and 高野線-2). All of them inherit the pick, so all
 * of them are held to it — except a stroke the evidence singles out by its own
 * station sequence in `display_part_platforms`, which the builder applies
 * after the assignment and which is reported here as the dot's real target.
 */
function drawnDots(sourceLine, stationGroup) {
  const [operator, name] = sourceLine.split("␟");
  const forms = new Set([operator, OPERATOR_ALIASES.get(operator)].filter(Boolean));
  const found = [];
  for (const line of pkg.lines) {
    if (!forms.has(line.operator) || line.name !== name) continue;
    const names = line.stations.map((station) => station[1]);
    for (const station of line.stations)
      if (station[0] === stationGroup)
        found.push({
          id: line.id,
          point: [station[2], station[3]],
          partTarget: partPlatformTarget(sourceLine, names, station[1]),
        });
  }
  return found;
}

/**
 * The platform one stroke is registered to use at one station, if any.
 *
 * `display_part_platforms` rows match a stroke by its exact station sequence in
 * either direction — a drawing direction is not a fact — which is how 高野線's
 * 汐見橋線 stroke keeps terminating on the 南海本線 island while the main
 * stroke stands on 高野線 1・2番線 178 m away.
 */
function partPlatformTarget(sourceLine, stationNames, stationName) {
  for (const row of assignments.display_part_platforms) {
    if (row.line !== sourceLine) continue;
    const wanted = row.match_stations;
    const forward = stationNames.length === wanted.length
      && stationNames.every((name, index) => name === wanted[index]);
    const backward = stationNames.length === wanted.length
      && stationNames.every((name, index) => name === wanted[wanted.length - 1 - index]);
    if (!forward && !backward) continue;
    const target = row.platform_midpoints[stationName];
    if (target) return target;
  }
  return null;
}

test("every registered platform assignment is the feature the package drew", () => {
  const rows = assignments.platform_assignments;
  assert.ok(rows.length > 0, "no platform_assignments rows to check");
  for (const row of rows) {
    const key = `${row.line}␟${row.station_group}`;
    const candidates = n02Features[key];
    assert.ok(candidates, `${key} is not in the N02 platform-feature table`);
    assert.ok(
      candidates.length > 1,
      `${key} has one N02 feature, so the row decides nothing`,
    );
    const dots = drawnDots(row.line, row.station_group);
    assert.ok(dots.length > 0, `${key} is not drawn anywhere in the package`);
    // The pick is exact: the builder pins a registered group's dot to the
    // chosen feature's own midpoint instead of re-projecting it onto track.
    assert.ok(
      candidates.some(
        (candidate) => metres(candidate.midpoint, row.prefer_midpoint_near) <= 1,
      ),
      `${key} names a target no candidate is 1 m from`,
    );
    for (const dot of dots) {
      const target = dot.partTarget || row.prefer_midpoint_near;
      const rejected = candidates.filter(
        (candidate) => metres(candidate.midpoint, target) > 1,
      );
      assert.ok(rejected.length > 0, `${key} names a target no candidate is 1 m from`);
      const chosen = metres(dot.point, target);
      for (const other of rejected)
        assert.ok(
          chosen < metres(dot.point, other.midpoint),
          `${dot.id} at ${row.station}: dot is ${chosen.toFixed(1)} m from the ` +
            `${dot.partTarget ? "stroke's registered" : "chosen"} feature and ` +
            `${metres(dot.point, other.midpoint).toFixed(1)} m from a rejected ` +
            "one — the assignment is not being honoured",
        );
    }
  }
});

test("every station anchor override stands on the platform it names", () => {
  const rows = overrides.station_anchor_overrides;
  assert.ok(rows.length > 0, "no station_anchor_overrides rows to check");
  for (const row of rows) {
    const dots = drawnDots(row.line, row.station_group);
    assert.ok(dots.length > 0, `${row.line} ${row.station} is not drawn in the package`);
    for (const dot of dots) {
      const toPlatform = pointToOutline(dot.point, row.platform_coords);
      const toN02 = metres(dot.point, row.n02_midpoint);
      // 10 m is loose enough for the outline estimator and the package's 6 dp,
      // and far tighter than the 23-207 m every row moves its dot.
      assert.ok(
        toPlatform <= 10,
        `${dot.id} at ${row.station}: dot is ${toPlatform.toFixed(1)} m from the OSM ` +
          `platform ${row.osm} the override names`,
      );
      assert.ok(
        toPlatform < toN02,
        `${dot.id} at ${row.station}: dot is ${toN02.toFixed(1)} m from the N02 feature ` +
          `the override replaces and ${toPlatform.toFixed(1)} m from its platform — the ` +
          "override is not being applied",
      );
    }
  }
});
