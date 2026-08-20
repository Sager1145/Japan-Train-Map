/*
 * osm-basemap-cache.mjs — read the OSM cell cache that
 * scripts/validation/validate-basemap-alignment.mjs fetches, and hand back an
 * edge index that still carries every tag a claim decision needs.
 *
 * The corridor audit only ever asks "how far is this point from ANY active
 * rail way", so its own index throws the tags away. A STATION-ZONE question is
 * a different question — "is this line drawn on ITS OWN track" — and at a
 * junction every candidate is within a few metres of something, so the answer
 * has to come from operator/name/usage/layer, never from distance alone
 * (RAILWAY_MULTILINE_STATION_AUDIT_PROMPT.md 2.3). Hence a second index over
 * the same cache rather than a second download.
 *
 * The cache is machine-local and lives outside app/ on purpose (npm run lint
 * JSON-parses every *.json under app/). Nothing here fetches: a missing cell
 * is reported as uncovered, never guessed at.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createEdgeIndex } from "./railway-topology.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_DIR = path.resolve(APP_DIR, "..");
export const DEFAULT_CACHE_DIR = path.join(REPO_DIR, "outputs", "osm-basemap-cache");

// Same vocabulary the corridor audit fetches with, so the two read one cache.
export const ACTIVE_RAILWAY = new Set([
  "rail",
  "light_rail",
  "subway",
  "tram",
  "monorail",
  "narrow_gauge",
  "funicular",
]);
// Yard throats, sidings and crossovers are real rails that no scheduled train
// is drawn along; a station point that lands on one is misplaced, not proven.
export const NON_RUNNING_SERVICE = new Set([
  "yard",
  "siding",
  "spur",
  "crossover",
]);

const INDEX_CELL_DEGREES = 0.005;

function cellFileName(file) {
  return /^E\d+N\d+\.json$/u.test(file);
}

/** Every cached cell as `{ id, file }`, in stable order. */
export function cachedCells(cacheDir = DEFAULT_CACHE_DIR) {
  if (!fs.existsSync(cacheDir)) return [];
  return fs
    .readdirSync(cacheDir)
    .filter(cellFileName)
    .sort()
    .map((file) => ({ id: file.replace(/\.json$/u, ""), file: path.join(cacheDir, file) }));
}

/**
 * An edge index over every ACTIVE running rail way in the cache.
 *
 * Meta per way: id, name(+ja), operator(+ja), gauge, usage, service, layer,
 * tunnel, bridge, railway. Ways whose `service` is a non-running kind are
 * indexed too but flagged, so a caller can reject them explicitly rather than
 * silently never seeing them.
 */
export function loadOsmTrackIndex(options = {}) {
  const cacheDir = options.cacheDir || DEFAULT_CACHE_DIR;
  const index = createEdgeIndex(INDEX_CELL_DEGREES);
  const seen = new Set();
  const cells = [];
  let oldestFetch = null;
  let ways = 0;
  for (const cell of cachedCells(cacheDir)) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(cell.file, "utf8"));
    } catch {
      continue; // a torn write is refetchable, not fatal
    }
    if (record?.format !== "osm-basemap-cell" || !Array.isArray(record.elements)) continue;
    cells.push(cell.id);
    if (!oldestFetch || record.fetchedAt < oldestFetch) oldestFetch = record.fetchedAt;
    for (const way of record.elements) {
      if (seen.has(way.id)) continue; // cells overlap via the fetch margin
      seen.add(way.id);
      const tags = way.tags || {};
      if (!ACTIVE_RAILWAY.has(tags.railway)) continue;
      const coordinates = (way.geometry || []).map((node) => [node.lon, node.lat]);
      if (coordinates.length < 2) continue;
      index.add(coordinates, {
        id: way.id,
        railway: tags.railway,
        name: tags.name || tags["name:ja"] || null,
        nameJa: tags["name:ja"] || null,
        operator: tags.operator || null,
        operatorJa: tags["operator:ja"] || null,
        gauge: tags.gauge || null,
        usage: tags.usage || null,
        service: tags.service || null,
        layer: Number(tags.layer) || 0,
        tunnel: Boolean(tags.tunnel && tags.tunnel !== "no"),
        bridge: Boolean(tags.bridge && tags.bridge !== "no"),
        running: !NON_RUNNING_SERVICE.has(tags.service),
      });
      ways += 1;
    }
  }
  return { index, ways, cells, oldestFetch };
}

// ── platforms ────────────────────────────────────────────────────────────────
//
// A second, narrower cache written by
// scripts/validation/fetch-osm-station-platforms.mjs into <cache>/platforms/.
// The corridor query never asked for railway=platform, and without platforms
// the audit can see that a dot stands on somebody's rails but not whose
// platform it belongs to.

const PLATFORM_DIR = "platforms";

// The fetch asks Overpass for `public_transport=platform` as well as
// `railway=platform`, and in Japan that second query is overwhelmingly ROAD
// furniture: measured over the 72 cached cells, 154,006 of the 168,881 indexed
// elements (91.2%) are `highway=bus_stop`. A bus shelter is not a place a train
// calls at, and one of them — node/9418004134, 広電バス's 立町 — was picked as
// 紙屋町東's 宇品線 platform, 199 m away and named for the NEXT stop on a
// different line.
//
// So every element is classified once, here, by what it says it SERVES:
//
//   rail      it names a rail platform tag or a rail mode — trusted in full
//   road      it names a road-bus identity and NO rail one — never a platform
//             a train calls at
//   unstated  it says neither — kept, and only ranked below `rail`
//
// The third class is why this is a three-way answer and not a boolean. Japan's
// tram and metro platforms are routinely mapped as a bare
// `public_transport=platform` way with no mode tag at all — 都電荒川線's 熊野前
// (way/445412130), 札幌市電's すすきの (way/431614567), JR京都駅0番のりば
// (way/516319355) — so "declares no rail mode" cannot mean "is not rail".
// Only a POSITIVE road declaration rejects; absence of evidence demotes.
//
// Measured against the same cache: NOT ONE of the 154,006 `highway=bus_stop`
// elements also declares a rail platform tag or a rail mode, so this rejection
// cannot cost a tram stop. The tram operators that do appear among the bus
// stops — 広電, 東京都交通局, 富山地方鉄道, 鹿児島市 — appear there as their own
// BUS divisions, while their tramway platforms are `railway=platform` (with or
// without `tram=yes`). Operator is deliberately NOT consulted: the campaign's
// rule is that a mismatched operator demotes rather than discards, and mode
// tags answer this question without it.
const RAIL_PLATFORM_RAILWAY = new Set([
  "platform",
  "platform_edge",
  "tram_stop",
  "station",
  "halt",
]);
const RAIL_MODE_TAGS = ["train", "tram", "subway", "light_rail", "monorail", "funicular"];
const ROAD_MODE_TAGS = ["bus", "trolleybus", "share_taxi"];

/** `rail` | `road` | `unstated` — what this platform element says it serves. */
export function platformServiceOf(tags = {}) {
  if (RAIL_PLATFORM_RAILWAY.has(tags.railway)) return "rail";
  for (const mode of RAIL_MODE_TAGS) if (tags[mode] === "yes") return "rail";
  // `highway` is occasionally a multi-value tag (`crossing;bus_stop`).
  if (String(tags.highway || "").split(";").includes("bus_stop")) return "road";
  for (const mode of ROAD_MODE_TAGS) if (tags[mode] === "yes") return "road";
  return "unstated";
}

function metresBetween(a, b) {
  return Math.hypot(
    (a[0] - b[0]) * 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180),
    (a[1] - b[1]) * 111320,
  );
}

/** The point half way along an open polyline, by arc length. */
function arcMidpoint(coordinates) {
  const measures = [0];
  for (let index = 1; index < coordinates.length; index += 1)
    measures.push(
      measures[index - 1] + metresBetween(coordinates[index - 1], coordinates[index]),
    );
  const half = measures.at(-1) / 2;
  for (let index = 1; index < coordinates.length; index += 1) {
    if (measures[index] < half) continue;
    const span = measures[index] - measures[index - 1];
    const ratio = span ? (half - measures[index - 1]) / span : 0;
    return [
      coordinates[index - 1][0] +
        ratio * (coordinates[index][0] - coordinates[index - 1][0]),
      coordinates[index - 1][1] +
        ratio * (coordinates[index][1] - coordinates[index - 1][1]),
    ];
  }
  return coordinates.at(-1);
}

/**
 * The centre of a platform element.
 *
 * A platform mapped as an AREA closes on itself, and a closed way is a path
 * AROUND the platform rather than along it, so neither the mean of its vertices
 * nor half its perimeter is its middle. The mean leans on where the ring
 * happens to close and on how densely each end was drawn (和歌山市's ring
 * counts one corner twice out of five, which pulls the centre 16 m towards it);
 * half the perimeter lands on the far END.
 *
 * So a ring is split at its two farthest-apart vertices — the platform's two
 * ends — and the arc midpoints of the two sides are averaged, which is the
 * middle of the outline's own medial axis. This is the same rule
 * build-japan-package-from-inventory.py applies when it turns a registered
 * platform into a station anchor, and it has to be: an override's safety gate
 * measures the platform this function reports, and the package then draws the
 * dot where the builder puts it. Two different centres and the gate is checking
 * a point nothing uses.
 */
function midpointOf(coordinates) {
  const closed =
    coordinates.length > 3 &&
    coordinates[0][0] === coordinates.at(-1)[0] &&
    coordinates[0][1] === coordinates.at(-1)[1];
  if (closed) {
    const ring = coordinates.slice(0, -1);
    let first = 0;
    let second = 0;
    let span = -1;
    for (let index = 0; index < ring.length; index += 1)
      for (let other = index + 1; other < ring.length; other += 1) {
        const gap = metresBetween(ring[index], ring[other]);
        if (gap > span) {
          span = gap;
          first = index;
          second = other;
        }
      }
    const side = (start, end) => {
      const chain = [];
      for (let cursor = start; ; cursor = (cursor + 1) % ring.length) {
        chain.push(ring[cursor]);
        if (cursor === end) return chain;
      }
    };
    const middles = [side(first, second), side(second, first)].map((chain) =>
      chain.length === 1 ? chain[0] : arcMidpoint(chain),
    );
    return [
      (middles[0][0] + middles[1][0]) / 2,
      (middles[0][1] + middles[1][1]) / 2,
    ];
  }
  let x = 0;
  let y = 0;
  for (const point of coordinates) {
    x += point[0];
    y += point[1];
  }
  return [x / coordinates.length, y / coordinates.length];
}

/** Compass bearing of a platform's long axis, first vertex to last. */
function axisBearing(coordinates) {
  if (coordinates.length < 2) return null;
  const a = coordinates[0];
  const b = coordinates[coordinates.length - 1];
  const latitude = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const east = (b[0] - a[0]) * Math.cos(latitude);
  const north = b[1] - a[1];
  if (!east && !north) return null;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

/**
 * Every cached platform, indexed by position.
 *
 * Node platforms are indexed as a degenerate two-point edge so one index
 * answers for ways, relations and nodes alike; `axis` is null for those, and a
 * caller must not pretend a point has an orientation.
 *
 * Everything the cache holds is indexed, road furniture included, and every
 * entry carries `serves` (see platformServiceOf) so the CALLER decides. Making
 * the loader drop bus stops would hide the 91% from the counts that are
 * supposed to describe the cache; `byService` reports the split instead.
 */
export function loadOsmPlatformIndex(options = {}) {
  const cacheDir = options.cacheDir || DEFAULT_CACHE_DIR;
  const directory = path.join(cacheDir, PLATFORM_DIR);
  const index = createEdgeIndex(INDEX_CELL_DEGREES);
  const cells = [];
  const seen = new Set();
  const byService = { rail: 0, road: 0, unstated: 0 };
  let platforms = 0;
  let stations = 0;
  if (!fs.existsSync(directory))
    return { index, platforms, stations, byService, cells, oldestFetch: null };
  let oldestFetch = null;
  for (const file of fs.readdirSync(directory).filter(cellFileName).sort()) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
    } catch {
      continue;
    }
    if (record?.format !== "osm-platform-cell" || !Array.isArray(record.elements)) continue;
    cells.push(record.cell);
    if (!oldestFetch || record.fetchedAt < oldestFetch) oldestFetch = record.fetchedAt;
    for (const element of record.elements) {
      const key = `${element.type}/${element.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tags = element.tags || {};
      const coordinates = (element.geometry || []).map((node) => [node.lon, node.lat]);
      if (!coordinates.length) continue;
      const isPlatform =
        tags.railway === "platform" || tags.public_transport === "platform";
      if (!isPlatform) {
        if (tags.railway === "station" || tags.railway === "halt") stations += 1;
        continue;
      }
      const meta = {
        key,
        id: element.id,
        kind: element.type,
        serves: platformServiceOf(tags),
        name: tags.name || tags["name:ja"] || null,
        ref: tags.ref || tags["railway:ref"] || null,
        operator: tags["operator:ja"] || tags.operator || null,
        line: tags.line || tags["railway:line"] || null,
        layer: Number(tags.layer) || 0,
        midpoint: midpointOf(coordinates),
        axis: axisBearing(coordinates),
        length:
          coordinates.length > 1
            ? Math.hypot(
                (coordinates.at(-1)[0] - coordinates[0][0]) * 111320 *
                  Math.cos((coordinates[0][1] * Math.PI) / 180),
                (coordinates.at(-1)[1] - coordinates[0][1]) * 111320,
              )
            : 0,
      };
      index.add(coordinates.length > 1 ? coordinates : [coordinates[0], coordinates[0]], meta);
      byService[meta.serves] += 1;
      platforms += 1;
    }
  }
  return { index, platforms, stations, byService, cells, oldestFetch };
}

