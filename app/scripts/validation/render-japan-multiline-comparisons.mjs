#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(
  APP_DIR,
  "../outputs/railway-audit/multi-line-stations/screenshots",
);
const CURRENT = path.join(APP_DIR, "public/rail/jp-2025.json");
const BEFORE = path.join(
  APP_DIR,
  "data/raw/railway/jp/packages/jp-2025-pre-rebuild-25031fbc.json.gz",
);
const require = createRequire(import.meta.url);
const RailNetwork = require(path.join(APP_DIR, "public/rail-network.js"));

const stations = [
  {
    slug: "tokyo",
    name: "東京 / Tokyo",
    group: "003766",
    center: [139.7671, 35.6811],
    span: [0.025, 0.018],
  },
  {
    slug: "sapporo",
    name: "札幌 / Sapporo",
    group: "000227",
    center: [141.3507, 43.0686],
    span: [0.03, 0.02],
  },
];

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readPackages() {
  return {
    before: JSON.parse(zlib.gunzipSync(fs.readFileSync(BEFORE))),
    after: JSON.parse(fs.readFileSync(CURRENT, "utf8")),
  };
}

function renderPanel(pkg, target, panelX, title) {
  const width = 760;
  const mapTop = 105;
  const mapHeight = 690;
  const [cx, cy] = target.center;
  const [sx, sy] = target.span;
  const left = cx - sx;
  const right = cx + sx;
  const bottom = cy - sy;
  const top = cy + sy;
  const project = ([lon, lat]) => [
    panelX + ((lon - left) / (right - left)) * width,
    mapTop + ((top - lat) / (top - bottom)) * mapHeight,
  ];
  const inView = ([lon, lat], margin = 0.08) =>
    lon >= left - sx * margin && lon <= right + sx * margin &&
    lat >= bottom - sy * margin && lat <= top + sy * margin;

  const network = RailNetwork.buildNetworkFromCompactPackage({ ...pkg, lanes: undefined });
  const targetLines = new Set(
    pkg.lines
      .filter((line) => line.stations.some((station) => station[0] === target.group))
      .map((line) => line.id),
  );
  const paths = [];
  for (const line of network.lineById.values()) {
    const highlighted = targetLines.has(line.lineId);
    for (const coordinates of line.parts || []) {
      let run = [];
      const flush = () => {
        if (run.length < 2) {
          run = [];
          return;
        }
        const d = run
          .map((point, index) => {
            const [x, y] = project(point);
            return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
          })
          .join(" ");
        paths.push(
          `<path d="${d}" fill="none" stroke="${esc(line.color || "#8a98a8")}" ` +
            `stroke-width="${highlighted ? 3.2 : 0.9}" stroke-opacity="${highlighted ? 0.92 : 0.17}" ` +
            `stroke-linecap="round" stroke-linejoin="round"/>`,
        );
        run = [];
      };
      for (let index = 0; index < coordinates.length; index += 1) {
        const point = coordinates[index];
        const adjacentInView =
          inView(point) ||
          (index > 0 && inView(coordinates[index - 1])) ||
          (index + 1 < coordinates.length && inView(coordinates[index + 1]));
        if (adjacentInView) run.push(point);
        else flush();
      }
      flush();
    }
  }

  const anchors = [];
  for (const line of pkg.lines) {
    if (!targetLines.has(line.id)) continue;
    const station = line.stations.find((candidate) => candidate[0] === target.group);
    if (!station) continue;
    anchors.push({
      line,
      point: [station[2], station[3]],
      label: line.id.replace(/^jp-[^-]+-/, ""),
    });
  }
  const uniquePoints = new Set(anchors.map(({ point }) => point.join(",")));
  const identityCount = new Set(
    anchors.map(({ line }) => line.railwayIdentity || `${line.operator}\0${line.name}`),
  ).size;
  const anchorSvg = anchors
    .map(({ line, point }, index) => {
      const [x, y] = project(point);
      return (
        `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${index ? 5.2 : 6.6}" ` +
        `fill="#111820" stroke="${esc(line.color || "#fff")}" stroke-width="3"/>`
      );
    })
    .join("");
  const legend = anchors
    .map(({ line, label }, index) => {
      const x = panelX + 14 + (index % 2) * 365;
      const y = 828 + Math.floor(index / 2) * 18;
      return (
        `<line x1="${x}" y1="${y - 4}" x2="${x + 18}" y2="${y - 4}" ` +
        `stroke="${esc(line.color || "#fff")}" stroke-width="3"/>` +
        `<text x="${x + 24}" y="${y}" class="legend">${esc(label)}</text>`
      );
    })
    .join("");

  const grid = [];
  for (let index = 1; index < 6; index += 1) {
    const x = panelX + (width * index) / 6;
    const y = mapTop + (mapHeight * index) / 6;
    grid.push(`<line x1="${x}" y1="${mapTop}" x2="${x}" y2="${mapTop + mapHeight}"/>`);
    grid.push(`<line x1="${panelX}" y1="${y}" x2="${panelX + width}" y2="${y}"/>`);
  }

  return (
    `<g clip-path="url(#clip-${panelX})">` + paths.join("") + anchorSvg + `</g>` +
    `<g class="grid">${grid.join("")}</g>` +
    `<rect x="${panelX}" y="${mapTop}" width="${width}" height="${mapHeight}" class="frame"/>` +
    `<text x="${panelX}" y="42" class="title">${esc(title)}</text>` +
    `<text x="${panelX}" y="70" class="meta">${anchors.length} display strokes · ${uniquePoints.size} station point(s) · ${identityCount} railway identities</text>` +
    legend
  );
}

function renderComparison(packages, target) {
  const width = 1580;
  const height = 940;
  const leftX = 20;
  const rightX = 800;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <clipPath id="clip-${leftX}"><rect x="${leftX}" y="105" width="760" height="690" rx="8"/></clipPath>
    <clipPath id="clip-${rightX}"><rect x="${rightX}" y="105" width="760" height="690" rx="8"/></clipPath>
    <style>
      svg { background: #0c1118; }
      text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #eaf1f7; }
      .title { font-size: 25px; font-weight: 700; }
      .meta { font-size: 14px; fill: #aebdca; }
      .legend { font-size: 12px; fill: #c7d2dc; }
      .frame { fill: none; stroke: #40505f; stroke-width: 1.4; rx: 8; }
      .grid line { stroke: #26323e; stroke-width: 0.7; stroke-dasharray: 3 7; }
    </style>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="#0c1118"/>
  <text x="20" y="920" class="meta">${esc(target.name)} · direct package geometry comparison · station dots are line-specific anchors; final UI lane rendering is verified separately.</text>
  ${renderPanel(packages.before, target, leftX, "Before · archived package")}
  ${renderPanel(packages.after, target, rightX, "After · rebuilt + audited")}
</svg>\n`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const packages = readPackages();
for (const station of stations) {
  const file = path.join(OUT_DIR, `${station.slug}-before-after.svg`);
  fs.writeFileSync(file, renderComparison(packages, station));
  process.stdout.write(`${path.relative(APP_DIR, file)}\n`);
}
