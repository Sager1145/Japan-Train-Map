#!/usr/bin/env node
/*
 * fetch-osm-station-platforms.mjs — the narrow SECOND fetch the station-zone
 * audit needs (RAILWAY_MULTILINE_STATION_AUDIT_PROMPT.md 2.2).
 *
 * The corridor cache that validate-basemap-alignment.mjs downloads holds
 * `way["railway"~"^(rail|light_rail|…)$"] … out tags geom` — ways only, and
 * `railway=platform` is not in that list. So the audit can say "this dot is
 * 60 m from a NAMED track of its own line while standing on somebody's rails"
 * and cannot say which platform it belongs on. That verdict
 * (`possible_wrong_platform`, 180 occurrences on 2026-08-19) is exactly what
 * platforms decide.
 *
 * Same grid, same politeness, same resumability as the corridor fetch — one
 * file per 1° cell under <cache>/platforms/, skipped when it already exists.
 * Nothing else in the repo reads the network; run this by hand.
 *
 * Usage:
 *   node scripts/validation/fetch-osm-station-platforms.mjs            # fetch missing cells
 *   node scripts/validation/fetch-osm-station-platforms.mjs --plan     # list, no network
 *   --cells E139N35,E135N34   only these
 *   --sleep-ms N              politeness gap (default 3000)
 *   --endpoints a,b           override mirrors (or env OVERPASS_ENDPOINTS)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cachedCells, DEFAULT_CACHE_DIR } from "../railway/lib/osm-basemap-cache.mjs";

const CELL_MARGIN_DEGREES = 0.02;
const OVERPASS_ENDPOINTS = (
  process.env.OVERPASS_ENDPOINTS ||
  "https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter"
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const USER_AGENT =
  "Japan-Train-Map/railway-platform-audit (github.com/Sager1145/Japan-Train-Map; local data-quality audit)";

function parseCellId(id) {
  const match = /^E(\d+)N(\d+)$/u.exec(id);
  if (!match) return null;
  return { id, e: Number(match[1]), n: Number(match[2]) };
}

function query(cell) {
  const south = cell.n - CELL_MARGIN_DEGREES;
  const west = cell.e - CELL_MARGIN_DEGREES;
  const north = cell.n + 1 + CELL_MARGIN_DEGREES;
  const east = cell.e + 1 + CELL_MARGIN_DEGREES;
  const bbox = `${south},${west},${north},${east}`;
  // nwr so multipolygon platforms come along; station/halt nodes carry the
  // identity a platform's own tags often omit.
  return (
    `[out:json][timeout:300];(` +
    `nwr["railway"="platform"](${bbox});` +
    `nwr["public_transport"="platform"](${bbox});` +
    `node["railway"~"^(station|halt)$"](${bbox});` +
    `);out tags geom;`
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchCell(cell, options) {
  const body = `data=${encodeURIComponent(query(cell))}`;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const endpoint =
      OVERPASS_ENDPOINTS[(options.endpointCursor + attempt) % OVERPASS_ENDPOINTS.length];
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
        body,
        signal: AbortSignal.timeout(300000),
      });
      if (!response.ok) {
        process.stderr.write(`  ${cell.id}: HTTP ${response.status} from ${endpoint}\n`);
        await sleep(Math.min(60000, 5000 * 2 ** attempt));
        continue;
      }
      const payload = await response.json();
      const elements = [];
      for (const element of payload.elements || []) {
        const tags = element.tags || {};
        if (element.type === "node") {
          if (element.lat == null) continue;
          elements.push({ type: "node", id: element.id, tags, geometry: [{ lat: element.lat, lon: element.lon }] });
        } else if (Array.isArray(element.geometry)) {
          elements.push({ type: element.type, id: element.id, tags, geometry: element.geometry });
        } else if (Array.isArray(element.members)) {
          // A multipolygon platform: keep every member ring we were given.
          const geometry = element.members.flatMap((member) => member.geometry || []);
          if (geometry.length) elements.push({ type: "relation", id: element.id, tags, geometry });
        }
      }
      return {
        format: "osm-platform-cell",
        cell: cell.id,
        bbox: [south(cell), west(cell), north(cell), east(cell)],
        marginDegrees: CELL_MARGIN_DEGREES,
        fetchedAt: new Date().toISOString(),
        endpoint,
        elementCount: elements.length,
        elements,
      };
    } catch (error) {
      process.stderr.write(`  ${cell.id}: ${error.message} via ${endpoint}\n`);
      await sleep(Math.min(60000, 5000 * 2 ** attempt));
    }
  }
  return null;
}

const south = (cell) => cell.n - CELL_MARGIN_DEGREES;
const west = (cell) => cell.e - CELL_MARGIN_DEGREES;
const north = (cell) => cell.n + 1 + CELL_MARGIN_DEGREES;
const east = (cell) => cell.e + 1 + CELL_MARGIN_DEGREES;

function parseArgs(argv) {
  const options = { plan: false, cells: null, sleepMs: 3000, endpointCursor: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--plan") options.plan = true;
    else if (flag === "--cells") options.cells = new Set(argv[++index].split(","));
    else if (flag === "--sleep-ms") options.sleepMs = Number(argv[++index]);
    else if (flag === "--endpoints") OVERPASS_ENDPOINTS.splice(0, OVERPASS_ENDPOINTS.length, ...argv[++index].split(","));
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = path.join(DEFAULT_CACHE_DIR, "platforms");
  fs.mkdirSync(outputDir, { recursive: true });
  // The rail cache defines the covered area: a platform outside it has no
  // track to be adjacent to.
  const cells = cachedCells()
    .map((cell) => parseCellId(cell.id))
    .filter(Boolean)
    .filter((cell) => !options.cells || options.cells.has(cell.id));
  const missing = cells.filter(
    (cell) => !fs.existsSync(path.join(outputDir, `${cell.id}.json`)),
  );
  process.stderr.write(
    `platform cells: ${cells.length} in the rail cache, ${cells.length - missing.length} already fetched, ${missing.length} to go\n`,
  );
  if (options.plan) {
    for (const cell of missing) process.stdout.write(`${cell.id}\n`);
    return;
  }
  let done = 0;
  for (const cell of missing) {
    if (done > 0) await sleep(options.sleepMs);
    process.stderr.write(`fetching ${cell.id}…\n`);
    const record = await fetchCell(cell, options);
    options.endpointCursor += 1;
    if (!record) {
      process.stderr.write(`  ${cell.id}: giving up for this run (rerun to resume)\n`);
      continue;
    }
    const file = path.join(outputDir, `${cell.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
    fs.renameSync(`${file}.tmp`, file);
    process.stderr.write(`  ${cell.id}: ${record.elementCount} platform/station elements\n`);
    done += 1;
  }
  process.stderr.write(`platform fetch: ${done}/${missing.length} cells written\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
