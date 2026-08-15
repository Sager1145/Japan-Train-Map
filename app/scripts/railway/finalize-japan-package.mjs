#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_PATH = path.join(APP_DIR, "public", "rail", "jp-2025.json");
const LINE_COLOURS_PATH = path.join(
  APP_DIR,
  "data",
  "raw",
  "railway",
  "jp",
  "colours",
  "line-colours.json",
);
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

const COLOUR_OPERATOR_ALIASES = new Map([
  ["東京メトロ", "東京地下鉄"],
  ["Osaka Metro", "大阪市高速電気軌道"],
]);

function normalized(value) {
  return String(value || "").normalize("NFKC").replace(/[\s　]/g, "");
}

function verifiedLineColours() {
  const rows = JSON.parse(fs.readFileSync(LINE_COLOURS_PATH, "utf8"));
  const byKey = new Map();
  for (const row of rows) {
    const operator = normalized(row.operator_n02);
    const names = new Set([row.line_n02, row.line_normalised, ...(row.aliases || [])]);
    for (const name of names) byKey.set(`${operator}\0${normalized(name)}`, row);
  }
  return byKey;
}

function applyVerifiedLineColours(lines) {
  const colours = verifiedLineColours();
  let applied = 0;
  for (const line of lines) {
    const operator = normalized(COLOUR_OPERATOR_ALIASES.get(line.operator) || line.operator);
    const row = colours.get(`${operator}\0${normalized(line.name)}`);
    if (!row?.color) continue;
    line.color = row.color.toLowerCase();
    line.colorDark = (row.color_dark || row.color).toLowerCase();
    line.colorSource = row.source_url || row.source;
    if (row.line_code) line.lineCode = row.line_code;
    applied += 1;
  }

  // Derived physical pieces keep the exact provenance of their parent line.
  const sourceByIdentity = new Map();
  for (const line of lines) {
    if (line.colorSource)
      sourceByIdentity.set(
        `${normalized(line.operator)}\0${normalized(line.name)}\0${line.color}`,
        line.colorSource,
      );
  }
  let inherited = 0;
  for (const line of lines) {
    if (line.colorSource) continue;
    const source = sourceByIdentity.get(
      `${normalized(line.operator)}\0${normalized(line.name)}\0${line.color}`,
    );
    if (!source) continue;
    line.colorSource = source;
    inherited += 1;
  }
  return { applied, inherited };
}

const colourResult = applyVerifiedLineColours(pkg.lines);

let structureRows = 0;
let clampedStructureRows = 0;
for (const line of pkg.lines) {
  const totalMeters = line.segments.reduce((sum, row) => sum + Number(row[0]) * 1000, 0);
  const structure = [];
  for (const row of line.structure || []) {
    const from = Math.max(0, Math.min(totalMeters, Number(row[0])));
    const to = Math.max(from, Math.min(totalMeters, Number(row[1])));
    if (!(to > from)) continue;
    const normalized = [Math.round(from), Math.round(to), ...row.slice(2)];
    if (normalized[0] !== row[0] || normalized[1] !== row[1]) clampedStructureRows += 1;
    structure.push(normalized);
  }
  if (structure.length) line.structure = structure;
  else delete line.structure;
  structureRows += structure.length;
}

pkg.version = "2025.4.2";
pkg.generatedAt = "2026-08-13T00:00:00.000Z";
pkg.geometrySource = {
  officialOnly: 1,
  providers: ["国土交通省 国土数値情報 鉄道データ N02-25"],
  license: "国土数値情報ダウンロードサービス 利用約款 (CC BY 4.0 相当)",
  method:
    "Station intervals cut from N02 RailroadSection geometry; branch services are split at their surveyed junctions, repeat-coordinate spiral loops are retained, and station anchors are welded before display grooming.",
  sections: "data/rail-sections.json (N02-25)",
};
pkg.attributeSources = {
  stationNames:
    "OpenStreetMap contributors, Geofabrik japan-latest.osm.pbf 2026-08-11, ODbL 1.0",
  structure:
    "OpenStreetMap tunnel/bridge/layer tags conflated to N02 at <=25 m and <=35 degrees bearing, ODbL 1.0",
  colours: "data/raw/railway/jp/colours/sources.md (per-value provenance)",
};
pkg.stats = {
  lines: pkg.lines.length,
  intervals: pkg.lines.reduce((sum, line) => sum + line.segments.length, 0),
  stations: pkg.lines.reduce((sum, line) => sum + line.stations.length, 0),
  structure: structureRows,
  sourceIntervalsRegeometried:
    pkg.stats?.sourceIntervalsRegeometried || pkg.stats?.regeometried || 0,
  sourceIntervalsKept: pkg.stats?.sourceIntervalsKept || pkg.stats?.kept_old || 0,
};

const raw = `${JSON.stringify(pkg)}\n`;
fs.writeFileSync(PACKAGE_PATH, raw);
fs.writeFileSync(`${PACKAGE_PATH}.gz`, zlib.gzipSync(raw, { level: 9, mtime: 0 }));
console.log(
  `jp: ${pkg.lines.length} lines, ${pkg.stats.intervals} intervals, ` +
    `${pkg.stats.stations} platforms, ${structureRows} structure rows ` +
    `(${clampedStructureRows} clamped), ${colourResult.applied} verified line colours ` +
    `(${colourResult.inherited} sources inherited), version ${pkg.version}`,
);
