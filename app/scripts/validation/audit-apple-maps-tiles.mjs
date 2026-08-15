#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_DIR = path.resolve(APP_DIR, "..");
const ROOT = path.join(APP_DIR, "data", "raw", "railway", "jp", "apple-maps");
const OUT_DIR = path.join(REPO_DIR, "outputs", "railway-audit", "apple-tile-audit");
const PACKAGE = path.join(APP_DIR, "public", "rail", "jp-2025.json");
const LEVELS = ["z1", "z2", "z3"];
const GRID = 0.2;

function parseCsv(file) {
  const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const headers = rows.shift().split(",");
  return rows.map((line) =>
    Object.fromEntries(line.split(",").map((value, index) => [headers[index], value])),
  );
}

function pngSize(file) {
  const fd = fs.openSync(file, "r");
  const header = Buffer.alloc(24);
  fs.readSync(fd, header, 0, header.length, 0);
  fs.closeSync(fd);
  if (header.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  return [header.readUInt32BE(16), header.readUInt32BE(20)];
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function gridKey(lon, lat) {
  return `${Math.floor(lon / GRID)}:${Math.floor(lat / GRID)}`;
}

function buildGrid(points) {
  const grid = new Map();
  for (const point of points) {
    const key = gridKey(point[0], point[1]);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(point);
  }
  return grid;
}

function countInBounds(grid, west, south, east, north) {
  let count = 0;
  const x0 = Math.floor(west / GRID);
  const x1 = Math.floor(east / GRID);
  const y0 = Math.floor(south / GRID);
  const y1 = Math.floor(north / GRID);
  for (let x = x0; x <= x1; x += 1)
    for (let y = y0; y <= y1; y += 1)
      for (const [lon, lat] of grid.get(`${x}:${y}`) || [])
        if (lon >= west && lon <= east && lat >= south && lat <= north) count += 1;
  return count;
}

const pkg = JSON.parse(fs.readFileSync(PACKAGE, "utf8"));
const stationByKey = new Map();
const vertices = [];
for (const line of pkg.lines) {
  for (const row of line.stations) {
    const key = `${row[0]}:${row[2]}:${row[3]}`;
    stationByKey.set(key, [Number(row[2]), Number(row[3]), row[1]]);
  }
  for (const segment of line.segments)
    for (const coordinate of segment[2]) vertices.push([coordinate[0], coordinate[1]]);
}
const stations = [...stationByKey.values()];
const stationGrid = buildGrid(stations);
const vertexGrid = buildGrid(vertices);

fs.mkdirSync(OUT_DIR, { recursive: true });
const auditRows = [];
const hashes = new Map();
const levelSummary = {};

for (const level of LEVELS) {
  const manifest = parseCsv(path.join(ROOT, "manifests", `manifest_${level}.csv`));
  const coveredStations = new Set();
  let missing = 0;
  let invalidPng = 0;
  for (const row of manifest) {
    const file = path.join(ROOT, "out", level, `${row.id}.png`);
    const exists = fs.existsSync(file);
    if (!exists) missing += 1;
    const stat = exists ? fs.statSync(file) : null;
    const size = exists ? pngSize(file) : null;
    if (exists && !size) invalidPng += 1;
    const hash = exists
      ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
      : "";
    if (hash) {
      if (!hashes.has(hash)) hashes.set(hash, []);
      hashes.get(hash).push(row.id);
    }
    const west = Number(row.west);
    const east = Number(row.east);
    const south = Number(row.south);
    const north = Number(row.north);
    stations.forEach((point, index) => {
      if (point[0] >= west && point[0] <= east && point[1] >= south && point[1] <= north)
        coveredStations.add(index);
    });
    auditRows.push({
      id: row.id,
      level,
      apple_zoom: row.z,
      row: row.row,
      col: row.col,
      center_lat: row.lat,
      center_lon: row.lon,
      west,
      south,
      east,
      north,
      exists: exists ? 1 : 0,
      bytes: stat?.size || 0,
      width: size?.[0] || 0,
      height: size?.[1] || 0,
      sha256: hash,
      station_points: countInBounds(stationGrid, west, south, east, north),
      railway_vertices: countInBounds(vertexGrid, west, south, east, north),
    });
  }
  levelSummary[level] = {
    expected: manifest.length,
    present: manifest.length - missing,
    missing,
    invalidPng,
    stationsCovered: coveredStations.size,
    stationsTotal: stations.length,
    uncoveredStations: stations
      .filter((unused, index) => !coveredStations.has(index))
      .map(([lon, lat, name]) => ({ name, lon, lat })),
  };
  console.log(
    `${level}: ${manifest.length - missing}/${manifest.length} tiles, ` +
      `${coveredStations.size}/${stations.length} unique station points covered`,
  );
}

const duplicateGroups = [...hashes.values()].filter((ids) => ids.length > 1);
const headers = Object.keys(auditRows[0]);
fs.writeFileSync(
  path.join(OUT_DIR, "tiles.csv"),
  `${headers.join(",")}\n${auditRows
    .map((row) => headers.map((key) => csvCell(row[key])).join(","))
    .join("\n")}\n`,
);
const summary = {
  generatedAt: new Date().toISOString(),
  packageVersion: pkg.version,
  tiles: auditRows.length,
  uniqueHashes: hashes.size,
  duplicateGroups,
  uniqueStationPoints: stations.length,
  railwayVertices: vertices.length,
  levels: levelSummary,
  semanticPixelComparison:
    "not_run: the temporary image-analysis dependency install was rejected by the execution environment",
};
fs.writeFileSync(path.join(OUT_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`tiles: ${auditRows.length}; duplicate image groups: ${duplicateGroups.length}`);
console.log(`wrote ${path.relative(REPO_DIR, OUT_DIR)}/tiles.csv and summary.json`);

if (
  auditRows.some((row) => !row.exists || !row.width || !row.height) ||
  duplicateGroups.length
)
  process.exitCode = 1;
