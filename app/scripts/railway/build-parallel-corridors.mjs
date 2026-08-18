#!/usr/bin/env node
/*
 * build-parallel-corridors.mjs — write each package's parallel-lane table.
 *
 * Two independent railways sharing a corridor have to be DRAWN apart, and the
 * renderer needs to know which stretch of which stroke takes which lane. That
 * answer is a sweep over the whole drawn network (an edge index plus a 25 m
 * walk of every kilometre of track), which is far too much work to redo in the
 * browser on every boot — so it is computed here and stored in the package as
 * a `lanes` table that rail-network.js simply reads.
 *
 * The table is DERIVED, not authored: it is a pure function of the package's
 * own display geometry, so regenerating it after any geometry change is
 * mandatory and test/railway-parallel-corridors.test.js fails if the stored
 * table and a freshly computed one disagree.
 *
 * Usage:
 *   node scripts/railway/build-parallel-corridors.mjs            # every country
 *   node scripts/railway/build-parallel-corridors.mjs --country jp
 *   node scripts/railway/build-parallel-corridors.mjs --report   # don't write
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import { detectIndependentOverlappingCorridors } from "./lib/parallel-corridors.mjs";
import { distanceMeters, pathLengthMeters } from "./lib/railway-topology.mjs";

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const RailNetwork = require(path.join(APP_DIR, "public/rail-network.js"));

const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];

/** The drawn strokes of a package, with the identity each lane decision needs. */
export function displayPartsForPackage(pkg) {
  // Build WITHOUT the stored table: lanes must never feed back into the
  // geometry they are derived from.
  const network = RailNetwork.buildNetworkFromCompactPackage({ ...pkg, lanes: undefined });
  const parts = [];
  for (const line of network.lineById.values()) {
    const stationPoints = (line.stationOrder || [])
      .map((id) => network.stationById.get(id))
      .filter(Boolean)
      .map((station) => [station.lon, station.lat]);
    (line.parts || []).forEach((coordinates, partIndex) => {
      if (coordinates.length < 2) return;
      parts.push({
        lineId: line.lineId,
        groupKey: `${line.operator}\u0000${line.name}`,
        // Which RAILWAY this stroke is — the only thing that may add a lane.
        railwayId: line.railwayId,
        partIndex,
        coordinates,
        stationPoints,
      });
    });
  }
  return parts;
}

// A lane belongs to a RAILWAY at a junction, not just to the one display
// stroke on which the corridor detector happened to see the overlap.  Without
// this pass the trunk could be at -0.5 while its branch/continuation opened at
// 0 on the exact same station node, visibly tearing one physical junction in
// two.  A two-stroke continuation carries one screen-side lane through the
// station (flipping its stored sign when the second stroke is registered in
// the opposite direction); a true branch ends every incident lane before the
// station so all arms meet on lane 0.  Both use the renderer's normal ramps.
export function harmonizeSharedJunctionLanes(parts, rows) {
  const byPart = new Map();
  for (const row of rows) {
    const key = `${row[0]}#${row[1]}`;
    if (!byPart.has(key)) byPart.set(key, []);
    byPart.get(key).push([...row]);
  }
  const seats = new Map();
  const totalByPart = new Map();
  for (const part of parts) {
    const total = pathLengthMeters(part.coordinates);
    totalByPart.set(`${part.lineId}#${part.partIndex}`, total);
    const cumulative = [0];
    for (let index = 1; index < part.coordinates.length; index += 1)
      cumulative.push(
        cumulative[index - 1] +
          distanceMeters(part.coordinates[index - 1], part.coordinates[index]),
      );
    for (const station of part.stationPoints || []) {
      let nearest = Infinity;
      let vertex = -1;
      for (let index = 0; index < part.coordinates.length; index += 1) {
        const distance = distanceMeters(station, part.coordinates[index]);
        if (distance < nearest) {
          nearest = distance;
          vertex = index;
        }
      }
      if (nearest > 0.5 || vertex < 0) continue;
      const directionFrom = vertex === 0 ? part.coordinates[0] : part.coordinates[vertex - 1];
      const directionTo = vertex === 0 ? part.coordinates[1] : part.coordinates[vertex];
      const latitude = ((directionFrom[1] + directionTo[1]) / 2) * (Math.PI / 180);
      const directionBearing =
        ((Math.atan2(
          (directionTo[0] - directionFrom[0]) * Math.cos(latitude),
          directionTo[1] - directionFrom[1],
        ) *
          180) /
          Math.PI +
          360) %
        360;
      const key = `${part.railwayId}\0${station[0]},${station[1]}`;
      if (!seats.has(key)) seats.set(key, []);
      seats.get(key).push({
        part,
        total,
        measure: cumulative[vertex],
        endpoint: vertex === 0 || vertex === part.coordinates.length - 1,
        directionBearing,
      });
    }
  }

  const laneAt = (seat) => {
    const partRows = byPart.get(`${seat.part.lineId}#${seat.part.partIndex}`) || [];
    const found = partRows.find(
      (row) => seat.measure >= Number(row[2]) - 0.5 && seat.measure <= Number(row[3]) + 0.5,
    );
    return found ? Number(found[4]) : 0;
  };
  const approach = 250;
  const clearLaneAtJunction = (member) => {
    if (member.total <= 1) return;
    const key = `${member.part.lineId}#${member.part.partIndex}`;
    const from = Math.max(0, member.measure - approach);
    const to = Math.min(member.total, member.measure + approach);
    const next = [];
    for (const row of byPart.get(key) || []) {
      const rowFrom = Number(row[2]);
      const rowTo = Number(row[3]);
      if (rowTo <= from || rowFrom >= to) {
        next.push(row);
        continue;
      }
      if (rowFrom < from) next.push([row[0], row[1], rowFrom, Number(from.toFixed(1)), row[4]]);
      if (rowTo > to) next.push([row[0], row[1], Number(to.toFixed(1)), rowTo, row[4]]);
    }
    byPart.set(key, next);
  };

  const forceLaneAtContinuation = (member, lane) => {
    clearLaneAtJunction(member);
    const key = `${member.part.lineId}#${member.part.partIndex}`;
    const from = Math.max(0, member.measure - approach);
    const to = Math.min(member.total, member.measure + approach);
    const next = byPart.get(key) || [];
    next.push([
      member.part.lineId,
      member.part.partIndex,
      Number(from.toFixed(1)),
      Number(to.toFixed(1)),
      lane,
    ]);
    byPart.set(key, next);
  };

  for (const members of seats.values()) {
    if (members.length < 2) continue;
    const distinctLines = new Set(members.map((member) => member.part.lineId));
    const isTwoStrokeContinuation =
      distinctLines.size === 2 && members.every((member) => member.endpoint);
    const candidates = members
      .map((member) => ({ member, lane: laneAt(member) }))
      .filter((row) => row.lane !== 0)
      .sort((a, b) => a.member.part.lineId.localeCompare(b.member.part.lineId));
    if (isTwoStrokeContinuation && candidates.length) {
      const elected = candidates[0];
      for (const member of members) {
        const difference = Math.abs(
          ((member.directionBearing - elected.member.directionBearing + 540) % 360) - 180,
        );
        forceLaneAtContinuation(member, difference > 90 ? -elected.lane : elected.lane);
      }
    } else {
      for (const member of members) clearLaneAtJunction(member);
    }
  }

  const normalized = [];
  for (const [key, partRows] of byPart) {
    const total = totalByPart.get(key);
    for (const row of partRows) {
      if (Number(row[2]) <= 0.5) row[2] = 0;
      if (total != null && Math.abs(Number(row[3]) - total) <= 0.5)
        row[3] = Math.ceil(total * 10) / 10;
      if (Number(row[3]) - Number(row[2]) > 0.1) normalized.push(row);
    }
  }
  return normalized.sort(
    (a, b) =>
      a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || a[4] - b[4],
  );
}

export function laneRowsForPackage(pkg) {
  const parts = displayPartsForPackage(pkg);
  const detected = detectIndependentOverlappingCorridors(parts);
  return harmonizeSharedJunctionLanes(parts, detected.rows);
}

function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes("--country") ? argv[argv.indexOf("--country") + 1] : null;
  const reportOnly = argv.includes("--report");

  for (const country of only ? [only] : COUNTRIES) {
    const file = path.join(APP_DIR, `public/rail/${country}-2025.json`);
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    const started = Date.now();
    const parts = displayPartsForPackage(pkg);
    const detected = detectIndependentOverlappingCorridors(parts);
    const corridors = detected.corridors;
    const rows = harmonizeSharedJunctionLanes(parts, detected.rows);
    const km = corridors.reduce((sum, c) => sum + (c.toMeters - c.fromMeters), 0) / 1000;
    const lines = new Set(rows.map((row) => row[0]));
    const widest = corridors.reduce(
      (most, c) => Math.max(most, c.members ? c.members.length : 0),
      0,
    );
    process.stdout.write(
      `${country}: ${rows.length} lane stretches over ${lines.size} lines, ` +
        `${km.toFixed(1)} km, widest corridor ${widest} lines (${Date.now() - started} ms)\n`,
    );
    for (const corridor of corridors
      .slice()
      .sort((a, b) => b.toMeters - b.fromMeters - (a.toMeters - a.fromMeters))
      .slice(0, 8))
      process.stdout.write(
        `    ${((corridor.toMeters - corridor.fromMeters) / 1000).toFixed(2)} km ` +
          `lane ${corridor.lane > 0 ? "+" : ""}${corridor.lane}  ${corridor.lineId}#${corridor.partIndex}` +
          `  with ${(corridor.members || []).filter((id) => id !== corridor.lineId).join(", ")}\n`,
      );
    if (reportOnly) continue;
    const previous = JSON.stringify(pkg.lanes || null);
    if (previous === JSON.stringify(rows)) {
      process.stdout.write(`  ${country}: table unchanged\n`);
      continue;
    }
    pkg.lanes = rows;
    fs.writeFileSync(file, `${JSON.stringify(pkg)}\n`);
    process.stdout.write(`  ${country}: wrote lanes table\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
