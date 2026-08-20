#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
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

// `serviceSpans` gets the same treatment `structure` gets above, in its own
// units: rows are [firstStation, lastStation, code] over the line's `stations`
// array, so the clamp is to that array's bounds rather than to a length in
// metres. A row that survives names two real, distinct, correctly ordered
// stations of THIS line; anything else is dropped rather than published as an
// index the renderer would have to guess at.
let serviceSpanRows = 0;
let droppedServiceSpans = 0;
for (const line of pkg.lines) {
  const last = line.stations.length - 1;
  const spans = [];
  for (const row of line.serviceSpans || []) {
    const from = Math.max(0, Math.min(last, Math.round(Number(row[0]))));
    const to = Math.max(0, Math.min(last, Math.round(Number(row[1]))));
    const code = Math.round(Number(row[2]));
    if (!(to > from) || !(code >= 1 && code <= 4)) {
      droppedServiceSpans += 1;
      continue;
    }
    spans.push([from, to, code]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (spans.length) line.serviceSpans = spans;
  else delete line.serviceSpans;
  serviceSpanRows += spans.length;
}

pkg.version = "2025.5.0";
pkg.generatedAt = "2026-08-18T00:00:00.000Z";
pkg.geometrySource = {
  officialOnly: 0,
  providers: [
    "国土交通省 国土数値情報 鉄道データ N02-25",
    "OpenStreetMap contributors (東京駅の両新幹線・地上共用線・総武快速／横須賀線の実軌道)",
  ],
  license:
    "国土数値情報ダウンロードサービス 利用約款 (CC BY 4.0 相当); OpenStreetMap ODbL 1.0",
  method:
    "Station intervals cut from N02 RailroadSection geometry; branch services are split at surveyed junctions, repeat-coordinate spiral loops are retained, sibling families persist one railwayIdentity, and junction anchors are welded to an existing canonical platform point before display grooming. Final lanes are a pure recomputation: two-stroke continuations keep one screen-side lane through the exact station node and true branches ramp to lane 0 there. At 東京, both Shinkansen, the shared 東北・東海道 surface stroke, and both directions of the 総武快速・横須賀 underground stroke use registered OSM physical-track geometry through the adjacent interval.",
  sections: "data/rail-sections.json (N02-25)",
  osmGeometry: {
    lines: [
      "jp-東日本旅客鉄道-東北新幹線",
      "jp-東日本旅客鉄道-東北線-2",
      "jp-東日本旅客鉄道-東海道線",
      "jp-東日本旅客鉄道-総武線",
      "jp-東日本旅客鉄道-総武線-3",
      "jp-東海旅客鉄道-東海道新幹線",
    ],
    evidence: "data/raw/railway/jp/evidence/tokyo-station-platforms.json",
    license: "OpenStreetMap contributors, ODbL 1.0",
  },
};
pkg.attributeSources = {
  stationNames:
    "OpenStreetMap contributors, Geofabrik japan-latest.osm.pbf 2026-08-11, ODbL 1.0",
  structure:
    "OpenStreetMap tunnel/bridge/layer tags conflated to N02 at <=25 m and <=35 degrees bearing, ODbL 1.0",
  colours: "data/raw/railway/jp/colours/sources.md (per-value provenance)",
  multiLineStationAudit:
    "data/raw/railway/jp/evidence/multi-line-station-audit-rules.json; outputs/railway-audit/multi-line-stations/audit.json",
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
console.log(
  `jp: ${pkg.lines.length} lines, ${pkg.stats.intervals} intervals, ` +
    `${pkg.stats.stations} platforms, ${structureRows} structure rows ` +
    `(${clampedStructureRows} clamped), ${serviceSpanRows} service spans ` +
    `(${droppedServiceSpans} dropped), ${colourResult.applied} verified line colours ` +
    `(${colourResult.inherited} sources inherited), version ${pkg.version}`,
);
