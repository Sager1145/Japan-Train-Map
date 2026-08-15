#!/usr/bin/env node
/*
 * repair-alishan-switchbacks.mjs — restore the 阿里山線 reversal tails the
 * routed build could not see.
 *
 * The Alishan Forest Railway climbs the last 11 km out of 屏遮那 on zigzags:
 * the train runs forward into a dead-end tail, stops, and leaves again in the
 * opposite direction. build-taiwan-rail-package.py routes each station
 * interval as a shortest path over the official NLSC/MOA centrelines, and a
 * shortest path never walks into a dead end. Two of the four tails were
 * recovered there by pinning a via point at the buffer stop (第一分道 and
 * 第二分道, `alishan_main_vias`). The other two could not be:
 *
 *   * 神木 (第三分道). 神木 station is not on the through track at all — it
 *     sits at the END of a 118 m tail east of the junction, and the two
 *     running legs (871803298 from 二萬平, 573029765 to 阿里山) leave that
 *     junction 20° apart and stay 11–18 m apart for 100 m. The official
 *     station point projected onto the nearer of the two, 99 m short of the
 *     junction, so the interval pair 二萬平→神木→阿里山 hopped straight
 *     across the 20 m gap between the legs: no junction, no tail, no
 *     reversal, and the 神木 marker 200 m from the real platform. 神木線
 *     inherited the same wrong terminus.
 *   * 阿里山. Its tail was pinned, but at a via 120 m short of the end of
 *     track, so the line turned round in mid-air.
 *
 * Geometry authority for the repair is OpenStreetMap (relation 5570989
 * 阿里山線, ODbL) — the only source in reach that carries the tails as
 * traversable track, and the reference the fix was checked against. It is
 * used ONLY inside the switchback throats; everything else keeps the official
 * routed alignment, and every splice welds onto a package vertex that already
 * sits within 5 m of the OSM centreline.
 *
 * A reversal is emitted the way the renderer wants it (rail-network.js
 * displayPartsForLine): the line runs to the far end of the tail and comes
 * straight back, so the stroke breaks at the tail end and continues as the
 * opposite-direction leg.
 *
 * Idempotent: an interval that already reaches the junction and the tail end
 * is left untouched, so re-running after a package rebuild is safe.
 *
 * Usage:
 *   node scripts/railway/repair-alishan-switchbacks.mjs            # apply
 *   node scripts/railway/repair-alishan-switchbacks.mjs --report   # dry run
 *   node scripts/railway/repair-alishan-switchbacks.mjs --refresh  # re-fetch
 *                                                                 # the OSM
 *                                                                 # extract
 * After applying, restate the derived tables and the gzip sidecar:
 *   node scripts/railway/recompute-package-derived.mjs --country tw
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const PACKAGE_PATH = path.join(APP_DIR, "public", "rail", "tw-2025.json");
// The repaired package's version, as build-taiwan-rail-package.py would state
// it; the build's own constant is kept in step.
const PACKAGE_VERSION = "2025.6.1";
const SECTIONS_PATH = path.join(APP_DIR, "data", "rail-sections-tw.json");
const STATIONS_PATH = path.join(APP_DIR, "data", "stations-tw.json");
const EXTRACT_PATH = path.join(
  APP_DIR,
  "data",
  "raw",
  "railway",
  "tw",
  "osm",
  "alishan-switchbacks.json",
);

// The extract is the ways of the 阿里山線 route relation across the zigzag,
// plus the station and buffer-stop nodes that mark the tails. Re-fetch with
// --refresh; the checked-in file is what the repair actually reads.
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
// [west, south, east, north] — 屏遮那 to 沼平, the whole zigzag and no more.
const EXTRACT_BOX = [120.77, 23.495, 120.816, 23.526];
const OVERPASS_QUERIES = [
  "[out:json][timeout:90];rel(5570989);way(r);out body;node(w);out skel qt;",
  `[out:json][timeout:90];node["railway"~"station|halt|buffer_stop"]` +
    `(${EXTRACT_BOX[1]},${EXTRACT_BOX[0]},${EXTRACT_BOX[3]},${EXTRACT_BOX[2]});out body;`,
];

// ─────────────────────────── the four switchbacks ───────────────────────────
// Every id below is an OSM element in the extract. `junction` is where the two
// running legs meet at an acute angle; `tail` is the dead end beyond it that
// the train reverses in.
const JUNCTION_SHENMU = 2381222252;
const JUNCTION_ALISHAN = 2381221958;
const WAY_APPROACH_SHENMU = 871803298; // 二萬平 → 神木 junction
const WAY_TAIL_SHENMU = 789792698; // 神木 junction → 神木 (buffer stop)
const WAY_DESCENT_ALISHAN = 573029765; // 神木 junction → 阿里山
const WAY_TAIL_ALISHAN = 462911102; // 阿里山 junction → end of track
const NODE_TAIL_END_SHENMU = 2381222251;
const NODE_TAIL_END_ALISHAN = 2381221938;

// How close a package vertex has to lie to the OSM centreline to be usable as
// a splice weld. The routed geometry tracks OSM to within a few metres along
// these legs, so 5 m picks a vertex that is on the same track rather than one
// the grooming pushed off it.
const WELD_MAX_METERS = 5;
// Densification of inserted OSM edges. The package's own output edges are
// capped at MAX_OUTPUT_EDGE_KM = 0.2 km; 30 m matches the density the routed
// geometry already carries through these curves.
const INSERT_EDGE_METERS = 30;
const M_PER_DEG = 111_320;

// ───────────────────────────── small geometry ─────────────────────────────
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const asPoint = (coordinate) => [round6(coordinate[0]), round6(coordinate[1])];
const samePoint = (left, right) =>
  left && right && left[0] === right[0] && left[1] === right[1];

function meters(left, right) {
  const scale = Math.cos((((left[1] + right[1]) / 2) * Math.PI) / 180);
  return Math.hypot(
    (right[0] - left[0]) * M_PER_DEG * scale,
    (right[1] - left[1]) * M_PER_DEG,
  );
}

// A vertex the line arrives at and leaves along (nearly) the same bearing: the
// deflection from straight-on, so 180 degrees is a full about-face. The two
// legs of a tail are the same track, so anything short of a few degrees off
// 180 is a reversal rather than a corner, however tight the corner.
const REVERSAL_MIN_DEGREES = 170;

function turnDegrees(before, corner, after) {
  const scale = Math.cos((corner[1] * Math.PI) / 180);
  const incoming = Math.atan2(corner[1] - before[1], (corner[0] - before[0]) * scale);
  const outgoing = Math.atan2(after[1] - corner[1], (after[0] - corner[0]) * scale);
  let degrees = Math.abs(((outgoing - incoming) * 180) / Math.PI);
  if (degrees > 180) degrees = 360 - degrees;
  return degrees;
}

function pathMeters(coordinates) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1)
    total += meters(coordinates[index - 1], coordinates[index]);
  return total;
}

/** Perpendicular distance from `point` to segment a→b, plus the foot's ratio. */
function pointOnSegment(point, a, b) {
  const scale = Math.cos((point[1] * Math.PI) / 180);
  const ax = a[0] * scale;
  const bx = b[0] * scale;
  const px = point[0] * scale;
  const dx = bx - ax;
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (point[1] - a[1]) * dy) / lengthSquared))
    : 0;
  const foot = [a[0] + (b[0] - a[0]) * ratio, a[1] + dy * ratio];
  return { ratio, foot, distance: meters(point, foot) };
}

/** Nearest point on a polyline: {index, ratio, foot, distance}. */
function projectOnPath(point, polyline) {
  let best = null;
  for (let index = 1; index < polyline.length; index += 1) {
    const hit = pointOnSegment(point, polyline[index - 1], polyline[index]);
    if (!best || hit.distance < best.distance) best = { ...hit, index };
  }
  return best;
}

/** The part of `polyline` strictly after a projection, as fresh coordinates. */
function pathAfter(polyline, projection) {
  const rest = polyline.slice(projection.index);
  const foot = asPoint(projection.foot);
  return samePoint(foot, asPoint(rest[0])) ? rest.slice(1) : rest;
}

/** Subdivide so no inserted edge is longer than INSERT_EDGE_METERS. */
function densify(coordinates) {
  if (coordinates.length < 2) return coordinates.slice();
  const output = [coordinates[0]];
  for (let index = 1; index < coordinates.length; index += 1) {
    const left = coordinates[index - 1];
    const right = coordinates[index];
    const steps = Math.max(
      1,
      Math.ceil(meters(left, right) / INSERT_EDGE_METERS),
    );
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      output.push(
        asPoint([
          left[0] + (right[0] - left[0]) * ratio,
          left[1] + (right[1] - left[1]) * ratio,
        ]),
      );
    }
  }
  return output;
}

/** Drop consecutive duplicates left by rounding two sources onto each other. */
function dedupe(coordinates) {
  return coordinates.filter(
    (point, index) => index === 0 || !samePoint(point, coordinates[index - 1]),
  );
}

// ───────────────────────────── the OSM extract ─────────────────────────────
// The public Overpass instance answers one query at a time per client and
// hands out 429/504 for the rest, so the two queries go in sequence and a
// dispatcher hiccup is retried rather than losing the whole fetch.
async function overpass(query, attempt = 0) {
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "User-Agent": "Japan-Train-Map/repair-alishan-switchbacks (ODbL data use)",
    },
    body: new URLSearchParams({ data: query }),
  });
  const text = response.ok ? await response.text() : "";
  if (response.ok && text.startsWith("{")) return JSON.parse(text).elements;
  if (attempt < 3) {
    await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
    return overpass(query, attempt + 1);
  }
  throw new Error(
    `Overpass ${response.status} ${response.statusText}\n${text.slice(0, 400)}`,
  );
}

async function refreshExtract() {
  const collected = [];
  for (const query of OVERPASS_QUERIES) collected.push(await overpass(query));
  const [relationElements, nodeElements] = collected;
  const inBox = (node) =>
    node.lon >= EXTRACT_BOX[0] &&
    node.lon <= EXTRACT_BOX[2] &&
    node.lat >= EXTRACT_BOX[1] &&
    node.lat <= EXTRACT_BOX[3];
  const nodes = new Map();
  for (const element of [...relationElements, ...nodeElements])
    if (element.type === "node")
      nodes.set(element.id, { ...nodes.get(element.id), ...element });
  // Only the ways that actually cross the zigzag box: the relation runs the
  // whole 71 km from 嘉義 and none of the rest is what this repair splices.
  const keptWays = relationElements
    .filter(
      (element) =>
        element.type === "way" &&
        element.nodes.some((id) => nodes.has(id) && inBox(nodes.get(id))),
    )
    .map((element) => ({
      id: element.id,
      tags: element.tags || {},
      nodes: element.nodes,
    }));
  const usedNodes = new Set(keptWays.flatMap((way) => way.nodes));
  const keptNodes = [];
  for (const [id, node] of nodes) {
    const tagged = node.tags && Object.keys(node.tags).length > 0;
    if (!usedNodes.has(id) && !(tagged && inBox(node))) continue;
    keptNodes.push({
      id,
      lon: node.lon,
      lat: node.lat,
      ...(tagged ? { tags: node.tags } : {}),
    });
  }
  keptNodes.sort((left, right) => left.id - right.id);
  keptWays.sort((left, right) => left.id - right.id);
  const extract = {
    source: "OpenStreetMap — Overpass API",
    license: "ODbL 1.0 — © OpenStreetMap contributors",
    relation: { id: 5570989, name: "阿里山線" },
    scope:
      "ways of the 阿里山線 route relation that cross the 屏遮那–沼平 zigzag " +
      "box, plus the station and buffer-stop nodes that mark its reversal tails",
    box: EXTRACT_BOX,
    retrieved: new Date().toISOString().slice(0, 10),
    queries: OVERPASS_QUERIES,
    ways: keptWays,
    nodes: keptNodes,
  };
  fs.mkdirSync(path.dirname(EXTRACT_PATH), { recursive: true });
  fs.writeFileSync(EXTRACT_PATH, `${JSON.stringify(extract, null, 1)}\n`);
  return extract;
}

function loadExtract() {
  const extract = JSON.parse(fs.readFileSync(EXTRACT_PATH, "utf8"));
  const nodes = new Map(extract.nodes.map((node) => [node.id, node]));
  const ways = new Map(extract.ways.map((way) => [way.id, way]));
  /** A way's coordinates, oriented to start at `startNodeId`. */
  const chain = (wayId, startNodeId) => {
    const way = ways.get(wayId);
    if (!way) throw new Error(`OSM extract is missing way ${wayId}`);
    const ordered =
      way.nodes[0] === startNodeId ? way.nodes : way.nodes.slice().reverse();
    if (ordered[0] !== startNodeId)
      throw new Error(`way ${wayId} does not end at node ${startNodeId}`);
    return ordered.map((id) => {
      const node = nodes.get(id);
      if (!node) throw new Error(`OSM extract is missing node ${id}`);
      return asPoint([node.lon, node.lat]);
    });
  };
  const point = (nodeId) => {
    const node = nodes.get(nodeId);
    if (!node) throw new Error(`OSM extract is missing node ${nodeId}`);
    return asPoint([node.lon, node.lat]);
  };
  return { extract, chain, point };
}

// ──────────────────────────────── the repair ────────────────────────────────
/**
 * Weld the end of a package interval onto an OSM leg and carry it through to
 * the junction and out to the end of the reversal tail.
 *
 * Returns the rebuilt coordinates, or null when the interval already runs the
 * tail (idempotence).
 */
function extendIntoTail(coordinates, leg, tail, notes, label) {
  const tailEnd = tail[tail.length - 1];
  if (meters(coordinates[coordinates.length - 1], tailEnd) < 1) return null;
  let weld = -1;
  for (let index = coordinates.length - 1; index > 0; index -= 1) {
    const hit = projectOnPath(coordinates[index], leg);
    if (hit.distance <= WELD_MAX_METERS) {
      weld = index;
      break;
    }
  }
  if (weld < 0)
    throw new Error(`${label}: no vertex within ${WELD_MAX_METERS} m of the leg`);
  const projection = projectOnPath(coordinates[weld], leg);
  // The weld vertex is replaced by its own foot on the OSM leg rather than
  // kept before it: the two are metres apart and roughly across the track from
  // each other, so keeping both would put a barb at the joint.
  const rebuilt = dedupe([
    ...coordinates.slice(0, weld),
    ...densify([asPoint(projection.foot), ...pathAfter(leg, projection)]),
    ...densify(tail).slice(1),
  ]);
  notes.push(
    `${label}: welded at vertex ${weld}/${coordinates.length - 1} ` +
      `(${projection.distance.toFixed(1)} m off the OSM leg), ` +
      `+${(pathMeters(rebuilt) - pathMeters(coordinates)).toFixed(0)} m`,
  );
  return rebuilt;
}

/**
 * The mirror image: an interval that STARTS at the tail end, comes back down
 * the tail, and rejoins the routed alignment on the far leg.
 */
function leaveFromTail(coordinates, tail, leg, notes, label) {
  const tailEnd = tail[tail.length - 1];
  if (meters(coordinates[0], tailEnd) < 1) return null;
  let weld = -1;
  for (let index = 0; index < coordinates.length; index += 1) {
    const hit = projectOnPath(coordinates[index], leg);
    if (hit.distance <= WELD_MAX_METERS) {
      weld = index;
      break;
    }
  }
  if (weld < 0)
    throw new Error(`${label}: no vertex within ${WELD_MAX_METERS} m of the leg`);
  const projection = projectOnPath(coordinates[weld], leg);
  const down = densify(tail.slice().reverse());
  const along = densify([
    ...leg.slice(0, projection.index),
    asPoint(projection.foot),
  ]);
  // The weld vertex is replaced by its own foot on the OSM leg rather than
  // kept after it: the two are metres apart and roughly across the track from
  // each other, so keeping both would put a barb at the joint.
  const rest =
    weld + 1 < coordinates.length
      ? coordinates.slice(weld + 1)
      : coordinates.slice(weld);
  const rebuilt = dedupe([...down, ...along.slice(1), ...rest]);
  notes.push(
    `${label}: welded at vertex ${weld}/${coordinates.length - 1} ` +
      `(${projection.distance.toFixed(1)} m off the OSM leg), ` +
      `+${(pathMeters(rebuilt) - pathMeters(coordinates)).toFixed(0)} m`,
  );
  return rebuilt;
}

/**
 * Push an out-and-back reversal tail that stops short all the way to the end
 * of track. The cusp is found structurally — the vertex whose neighbours are
 * the same coordinate — so a tail that is already complete is left alone.
 */
function extendReversalCusp(coordinates, tail, notes, label) {
  let cusp = -1;
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    if (samePoint(coordinates[index - 1], coordinates[index + 1])) {
      cusp = index;
      break;
    }
  }
  if (cusp < 0) throw new Error(`${label}: no reversal cusp found`);
  const tailEnd = tail[tail.length - 1];
  const short = meters(coordinates[cusp], tailEnd);
  if (short < 1) return null;
  const projection = projectOnPath(coordinates[cusp], tail);
  if (projection.distance > WELD_MAX_METERS)
    throw new Error(
      `${label}: the cusp is ${projection.distance.toFixed(1)} m off the tail`,
    );
  const out = densify([
    coordinates[cusp],
    ...pathAfter(tail, projection),
  ]).slice(1);
  const back = out.slice(0, -1).reverse();
  const rebuilt = dedupe([
    ...coordinates.slice(0, cusp + 1),
    ...out,
    ...back,
    coordinates[cusp],
    ...coordinates.slice(cusp + 1),
  ]);
  notes.push(
    `${label}: cusp at vertex ${cusp} was ${short.toFixed(0)} m short of the ` +
      `end of track, +${(pathMeters(rebuilt) - pathMeters(coordinates)).toFixed(0)} m`,
  );
  return rebuilt;
}

function lineById(pkg, id) {
  const line = pkg.lines.find((row) => row.id === id);
  if (!line) throw new Error(`package has no line ${id}`);
  return line;
}

function setStationPoint(line, name, point, notes) {
  const station = line.stations.find((row) => row[1] === name);
  if (!station) throw new Error(`${line.id} has no station ${name}`);
  const moved = meters([station[2], station[3]], point);
  if (moved < 0.5) return;
  notes.push(
    `${line.id}:${name} anchor moved ${moved.toFixed(0)} m to the tail end`,
  );
  station[2] = point[0];
  station[3] = point[1];
}

/** Interval km, restated from the geometry the same way the build states it. */
function intervalKm(coordinates) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const left = coordinates[index - 1];
    const right = coordinates[index];
    const radians = (value) => (value * Math.PI) / 180;
    const dLon = radians(right[0] - left[0]);
    const dLat = radians(right[1] - left[1]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(radians(left[1])) * Math.cos(radians(right[1])) *
        Math.sin(dLon / 2) ** 2;
    total += 6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return Math.round(total * 1000) / 1000;
}

function repair(pkg, osm, notes) {
  const approachShenmu = osm.chain(WAY_APPROACH_SHENMU, JUNCTION_SHENMU)
    .slice()
    .reverse(); // 二萬平 → junction
  const tailShenmu = osm.chain(WAY_TAIL_SHENMU, JUNCTION_SHENMU); // → 神木
  const descentAlishan = osm.chain(WAY_DESCENT_ALISHAN, JUNCTION_SHENMU); // → 阿里山
  const tailAlishan = osm.chain(WAY_TAIL_ALISHAN, JUNCTION_ALISHAN);
  if (!samePoint(tailShenmu[tailShenmu.length - 1], osm.point(NODE_TAIL_END_SHENMU)))
    throw new Error("神木 tail does not end at its buffer stop");
  if (
    !samePoint(tailAlishan[tailAlishan.length - 1], osm.point(NODE_TAIL_END_ALISHAN))
  )
    throw new Error("阿里山 tail does not end at its buffer stop");
  const shenmuPoint = tailShenmu[tailShenmu.length - 1];

  const main = lineById(pkg, "tw-alsr-alishan");
  const shenmuLine = lineById(pkg, "tw-alsr-shenmu");
  const index = main.stations.findIndex((row) => row[1] === "神木");
  if (index < 1) throw new Error("阿里山線 has no 神木 station");

  // 二萬平 → 神木: climb to the junction and run the tail to the platform.
  const arrival = extendIntoTail(
    main.segments[index - 1][2],
    approachShenmu,
    tailShenmu,
    notes,
    "阿里山線 二萬平→神木",
  );
  if (arrival) main.segments[index - 1][2] = arrival;

  // 神木 → 阿里山: back down the tail, then away on the other leg.
  const departure = leaveFromTail(
    main.segments[index][2],
    tailShenmu,
    descentAlishan,
    notes,
    "阿里山線 神木→阿里山",
  );
  if (departure) main.segments[index][2] = departure;

  // 阿里山's own reversal tail stopped 120 m short of the end of track.
  const alishanTail = extendReversalCusp(
    main.segments[index][2],
    tailAlishan,
    notes,
    "阿里山線 阿里山 reversal tail",
  );
  if (alishanTail) main.segments[index][2] = alishanTail;

  // 神木線 shares the tail and inherited the same wrong terminus.
  const branch = extendIntoTail(
    shenmuLine.segments[0][2],
    descentAlishan.slice().reverse(), // 阿里山 → junction
    tailShenmu,
    notes,
    "神木線 阿里山→神木",
  );
  if (branch) shenmuLine.segments[0][2] = branch;

  for (const line of [main, shenmuLine]) {
    setStationPoint(line, "神木", shenmuPoint, notes);
    line.segments.forEach((segment) => {
      segment[0] = intervalKm(segment[2]);
    });
  }

  // Name the ends of track the line runs into and reverses at, so the
  // renderer's stroke-end fold guard keeps them (rail-network.js
  // stationAnchorKeys). Read back off the finished geometry rather than from
  // OSM, so every entry is one of the package's own vertices: a tail end is a
  // vertex the line arrives at and leaves along the same bearing, which is
  // what an out-and-back leaves behind and what no through alignment in this
  // package produces. 神木 needs no entry — its tail ends at a platform, and a
  // platform anchor already stops the guard.
  const tails = [];
  for (const [, , coordinates] of main.segments)
    for (let index = 1; index < coordinates.length - 1; index += 1)
      if (
        turnDegrees(
          coordinates[index - 1],
          coordinates[index],
          coordinates[index + 1],
        ) >= REVERSAL_MIN_DEGREES
      )
        tails.push(coordinates[index]);
  if (JSON.stringify(main.reversalTails) !== JSON.stringify(tails)) {
    main.reversalTails = tails;
    notes.push(
      `tw-alsr-alishan: ${tails.length} reversal tail end(s) declared ` +
        `(${tails.map((point) => point.join(",")).join("  ")})`,
    );
  }
  return new Set([main.id, shenmuLine.id]);
}

/**
 * The solver datasets restate the same intervals and the same station anchors,
 * and test/taiwan-solver-datasets.test.js compares every interval vertex for
 * vertex, so a repaired interval has to be restated in rail-sections-tw.json
 * too.
 *
 * Section rows are written line by line in package order and a trunk and its
 * own branch share a name and an operator (中和新蘆線), so each line consumes
 * its own run from the front of its group rather than re-filtering and getting
 * both — the same walk the test itself does.
 *
 * stations-tw.json is NOT in that order for every group (the 蘆洲 branch rows
 * precede the 迴龍 trunk's), and some of its anchors were written at full
 * float precision rather than rounded. Neither is this repair's business, so
 * the station rows are looked up by name inside the one line group each
 * belongs to and everything else is left exactly as the build left it.
 */
/**
 * Say so in the package. `geometrySource.officialOnly` was the claim that
 * every drawn metre came from Taiwanese government data, and after this repair
 * that is no longer true of two lines. Rather than leave a flag that lies, the
 * exception is named: which lines carry it, under which licence, and from
 * where — and scripts/railway/lib/tw_sample_lib.py reads exactly this to keep
 * curated samples off the affected lines.
 */
function declareOsmGeometry(pkg, extract, repairedLineIds) {
  const source = pkg.geometrySource;
  if (!source) throw new Error("package has no geometrySource");
  source.officialOnly = 0;
  source.osmSources = 1;
  source.osmGeometry = {
    reason:
      "阿里山 zigzag reversal tails (神木 第三分道, 阿里山) — no official " +
      "centreline carries them as traversable track",
    lines: [...repairedLineIds].sort(),
    license: extract.license,
    relation: extract.relation.id,
    retrieved: extract.retrieved,
    extract: "data/raw/railway/tw/osm/alishan-switchbacks.json",
  };
}

function repairDatasets(pkg, sections, stations, repairedLineIds, notes) {
  const queues = new Map();
  for (const feature of sections.features) {
    const key = `${feature.properties.line_name} ${feature.properties.operator}`;
    const queue = queues.get(key) || [];
    queue.push(feature);
    queues.set(key, queue);
  }
  const anchors = new Map();
  let restated = 0;
  for (const line of pkg.lines) {
    const rows = (
      queues.get(`${line.name} ${line.operator}`) || []
    ).splice(0, line.segments.length);
    if (rows.length !== line.segments.length)
      throw new Error(`${line.id}: solver/display interval count`);
    let previous = null;
    const intervals = line.segments.map((segment, index) => {
      const [, shared, coordinates] = segment;
      const full = shared && previous ? [previous, ...coordinates] : coordinates;
      const restatedRow = full.map((point) => point.slice());
      if (
        JSON.stringify(rows[index].geometry.coordinates) !==
        JSON.stringify(restatedRow)
      ) {
        rows[index].geometry.coordinates = restatedRow;
        restated += 1;
      }
      previous = full[full.length - 1];
      return full;
    });
    // Looking a station row up by name is only unambiguous for a line that is
    // alone in its (name, operator) group. Both repaired lines are, and no
    // other line's station rows need touching.
    if (!repairedLineIds.has(line.id)) continue;
    if (pkg.lines.some((row) => row !== line && row.name === line.name))
      throw new Error(`${line.id}: shares its name with another line`);
    line.stations.forEach((station, index) => {
      // The build anchors a station on the head of its outgoing interval; a
      // terminus has none and anchors on the tail of its incoming one.
      anchors.set(`${line.name}|${line.operator}|${station[1]}`, {
        point: [station[2], station[3]],
        anchor:
          index < intervals.length
            ? intervals[index].slice(0, 2)
            : intervals[index - 1].slice(-2).reverse(),
      });
    });
  }
  let moved = 0;
  for (const feature of stations.features) {
    const key =
      `${feature.properties.line_name}|${feature.properties.operator}` +
      `|${feature.properties.station_name}`;
    const wanted = anchors.get(key);
    if (!wanted) continue;
    if (
      samePoint(feature.properties.display_point, wanted.point) &&
      samePoint(feature.geometry.coordinates[1], wanted.anchor[1])
    )
      continue;
    feature.properties.display_point = wanted.point.slice();
    feature.geometry.coordinates = wanted.anchor.map((row) => row.slice());
    moved += 1;
  }
  notes.push(
    `solver datasets: ${restated} interval(s) and ${moved} station anchor(s) restated`,
  );
}

async function main(argv) {
  const report = argv.includes("--report");
  if (argv.includes("--refresh")) {
    const extract = await refreshExtract();
    process.stdout.write(
      `refreshed ${path.relative(APP_DIR, EXTRACT_PATH)} ` +
        `(${extract.ways.length} ways, ${extract.nodes.length} nodes)\n`,
    );
  }
  const osm = loadExtract();
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const notes = [];
  const repairedLineIds = repair(pkg, osm, notes);
  if (!notes.length) {
    process.stdout.write("阿里山線 switchback tails are already complete\n");
    return 0;
  }
  pkg.version = PACKAGE_VERSION;
  declareOsmGeometry(pkg, osm.extract, repairedLineIds);
  const sections = JSON.parse(fs.readFileSync(SECTIONS_PATH, "utf8"));
  const stations = JSON.parse(fs.readFileSync(STATIONS_PATH, "utf8"));
  repairDatasets(pkg, sections, stations, repairedLineIds, notes);
  for (const note of notes) process.stdout.write(`  ${note}\n`);
  if (report) {
    process.stdout.write("--report: nothing written\n");
    return 0;
  }
  // Compact, one line, trailing newline — what build-taiwan-rail-package.py
  // and recompute-package-derived.mjs both write.
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg)}\n`);
  fs.writeFileSync(SECTIONS_PATH, `${JSON.stringify(sections)}\n`);
  fs.writeFileSync(STATIONS_PATH, `${JSON.stringify(stations)}\n`);
  process.stdout.write(
    "wrote tw-2025.json, rail-sections-tw.json, stations-tw.json — now run " +
      "scripts/railway/recompute-package-derived.mjs --country tw\n",
  );
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
