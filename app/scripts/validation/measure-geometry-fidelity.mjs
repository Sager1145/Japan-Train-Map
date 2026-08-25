#!/usr/bin/env node
/*
 * measure-geometry-fidelity.mjs — the corner/vertex census the smoothing work
 * is judged on.
 *
 * Reports, per country, over the DRAWN geometry (rail-network.js display
 * parts — the same rows the topology audit grades):
 *
 *   lines · parts · vertices · total km · mean edge length
 *   turn-angle histogram in the six bands the brief names
 *   the short-edge/long-edge split of every turn (root cause (a) vs (c))
 *   screen-angle counts at a target zoom (root cause (c))
 *
 * Usage:
 *   node scripts/validation/measure-geometry-fidelity.mjs
 *   node scripts/validation/measure-geometry-fidelity.mjs --country jp
 *   node scripts/validation/measure-geometry-fidelity.mjs --json out.json
 *   node scripts/validation/measure-geometry-fidelity.mjs --per-line out.csv
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// The census grades the same geometry the topology audit does, so it measures
// it with the audit's own primitives rather than a second copy of them. They
// were a copy until 2026-08-25, character for character — 0 bit differences
// over 435,238 real package coordinates. Still re-exported: nothing in the
// repo imports them off this module today, but they were part of its surface
// and dropping that is a separate decision from removing the duplication.
import {
  distanceMeters,
  turnDegrees,
} from "../railway/lib/railway-topology.mjs";

export { distanceMeters, turnDegrees };

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "../..");
const RailNetwork = require(path.join(APP_DIR, "public/rail-network.js"));

const COUNTRIES = ["jp", "tw", "hk", "mo", "kr"];
const BANDS = [
  ["ge110", 110, Infinity],
  ["b90_110", 90, 110],
  ["b60_90", 60, 90],
  ["b45_60", 45, 60],
  ["b30_45", 30, 45],
  ["b20_30", 20, 30],
];

export function loadCountry(country) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(APP_DIR, "public/rail", `${country}-2025.json`), "utf8"),
  );
  const network = RailNetwork.buildNetworkFromCompactPackage(pkg);
  const rows = [];
  for (const line of network.lineById.values()) {
    const parts = line.parts || [line.geometry?.coordinates || []];
    parts.forEach((coordinates, partIndex) => {
      if (coordinates.length >= 2)
        rows.push({ lineId: line.lineId, name: line.name, partIndex, coordinates });
    });
  }
  return { pkg, network, rows };
}

/** Mercator metres per pixel at a zoom, on MapLibre's 512 px tiles. */
function metersPerPixel(zoom, latitude) {
  return (
    ((156543.03392 / 2) * Math.cos((latitude * Math.PI) / 180)) /
    Math.pow(2, zoom)
  );
}

export function censusForRows(rows) {
  const bands = Object.fromEntries(BANDS.map(([name]) => [name, 0]));
  // Root cause (a) vs (c): a turn carried by a SHORT edge is digitising noise,
  // one carried by two long edges is a real curve discretised too coarsely.
  const shortEdgeTurns = Object.fromEntries(BANDS.map(([name]) => [name, 0]));
  let vertices = 0;
  let edges = 0;
  let totalMeters = 0;
  // Screen deflection at z15: what a reader actually sees on a high-zoom view.
  let screenZ15Over3 = 0;
  let screenZ15Over6 = 0;

  for (const row of rows) {
    const coordinates = row.coordinates;
    vertices += coordinates.length;
    for (let index = 1; index < coordinates.length; index += 1) {
      totalMeters += distanceMeters(coordinates[index - 1], coordinates[index]);
      edges += 1;
    }
    for (let index = 1; index < coordinates.length - 1; index += 1) {
      const previous = coordinates[index - 1];
      const corner = coordinates[index];
      const following = coordinates[index + 1];
      const turn = turnDegrees(previous, corner, following);
      const legIn = distanceMeters(previous, corner);
      const legOut = distanceMeters(corner, following);
      const shortLeg = Math.min(legIn, legOut);
      for (const [name, low, high] of BANDS) {
        if (turn >= low && turn < high) {
          bands[name] += 1;
          if (shortLeg < 30) shortEdgeTurns[name] += 1;
          break;
        }
      }
      if (turn >= 3) {
        // A corner is only VISIBLE if both its edges are long enough on screen
        // to read as edges — under ~2 px they merge into the stroke.
        const mpp = metersPerPixel(15, corner[1]);
        if (legIn / mpp >= 2 && legOut / mpp >= 2) {
          if (turn >= 3) screenZ15Over3 += 1;
          if (turn >= 6) screenZ15Over6 += 1;
        }
      }
    }
  }

  return {
    lines: new Set(rows.map((row) => row.lineId)).size,
    parts: rows.length,
    vertices,
    totalKm: Number((totalMeters / 1000).toFixed(3)),
    meanEdgeMeters: edges ? Number((totalMeters / edges).toFixed(1)) : 0,
    bands,
    shortEdgeTurns,
    screenZ15Over3,
    screenZ15Over6,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes("--country")
    ? argv[argv.indexOf("--country") + 1].split(",")
    : COUNTRIES;
  const jsonAt = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;
  const perLineAt = argv.includes("--per-line")
    ? argv[argv.indexOf("--per-line") + 1]
    : null;

  const report = {};
  const perLine = ["country,line_id,name,parts,vertices,km"];
  for (const country of only) {
    const { pkg, rows } = loadCountry(country);
    report[country] = censusForRows(rows);
    report[country].packageBytes = fs.statSync(
      path.join(APP_DIR, "public/rail", `${country}-2025.json`),
    ).size;
    report[country].packageVersion = pkg.version;
    if (perLineAt) {
      const byLine = new Map();
      for (const row of rows) {
        if (!byLine.has(row.lineId))
          byLine.set(row.lineId, { name: row.name, parts: 0, vertices: 0, meters: 0 });
        const entry = byLine.get(row.lineId);
        entry.parts += 1;
        entry.vertices += row.coordinates.length;
        for (let index = 1; index < row.coordinates.length; index += 1)
          entry.meters += distanceMeters(
            row.coordinates[index - 1],
            row.coordinates[index],
          );
      }
      for (const [lineId, entry] of byLine)
        perLine.push(
          `${country},${lineId},"${entry.name}",${entry.parts},${entry.vertices},${(entry.meters / 1000).toFixed(4)}`,
        );
    }
  }

  const header =
    "country  lines parts  vertices    km       edge   >=110 90-110 60-90 45-60 30-45 20-30   z15>3deg";
  console.log(header);
  for (const country of only) {
    const row = report[country];
    console.log(
      [
        country.padEnd(8),
        String(row.lines).padStart(5),
        String(row.parts).padStart(5),
        String(row.vertices).padStart(9),
        row.totalKm.toFixed(0).padStart(8),
        `${row.meanEdgeMeters}m`.padStart(8),
        String(row.bands.ge110).padStart(6),
        String(row.bands.b90_110).padStart(6),
        String(row.bands.b60_90).padStart(6),
        String(row.bands.b45_60).padStart(6),
        String(row.bands.b30_45).padStart(6),
        String(row.bands.b20_30).padStart(6),
        String(row.screenZ15Over3).padStart(10),
      ].join(" "),
    );
  }
  console.log("\nshort-edge (<30 m) share of each band — root cause (a):");
  for (const country of only) {
    const row = report[country];
    console.log(
      `  ${country}  ` +
        BANDS.map(
          ([name]) => `${name}:${row.shortEdgeTurns[name]}/${row.bands[name]}`,
        ).join("  "),
    );
  }

  if (jsonAt) {
    fs.writeFileSync(jsonAt, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nwrote ${jsonAt}`);
  }
  if (perLineAt) {
    fs.writeFileSync(perLineAt, `${perLine.join("\n")}\n`);
    console.log(`wrote ${perLineAt}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
