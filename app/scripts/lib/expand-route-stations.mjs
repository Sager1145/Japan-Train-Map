// Shared build-time helper for the special-sample loop generators.
//
// Given a train's endpoint N02 station codes and the line(s) it runs on, walk
// the shortest path across those lines' N02 RailroadSection edges and return the
// ORDERED list of physical stations the route passes through (origin..dest
// inclusive). The loop generators use this to fill in every intermediate stop
// instead of emitting only origin+destination.
//
// Robustness:
//  - The graph spans ALL the given lines, and zero-cost transfer edges connect
//    every node sharing a station GROUP (N02_005g), so an endpoint coded on one
//    line (e.g. 日暮里 on 東北線) is still reachable from another (山手線).
//  - Stations are ordered by their FIRST index along the reconstructed path, so
//    two adjacent stations never come out swapped.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// Shared N02 5-decimal grid + geometry primitives: AppCore (shared/app-core.js)
// is the single owner of the grid rule, so this build-time graph quantizes
// exactly like the in-browser solver/stats and station lookups tolerate the
// same spelling variants the app tolerates.
const {
  quant5: q,
  coordKey5: nk,
  equirectKm,
  TupleMinHeap: MinHeap,
  normalizeStationName,
} = require("../../shared/app-core.js");

const DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
);

const edgeKm = (a, b) => equirectKm(a[0], a[1], b[0], b[1]);

let _rail = null;
let _stations = null;
let _stationGroupByCode = null;
function loadData() {
  if (!_rail)
    _rail = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "rail-sections.json"), "utf8"),
    );
  if (!_stations)
    _stations = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "stations.json"), "utf8"),
    );
  if (!_stationGroupByCode) {
    _stationGroupByCode = new Map();
    for (const feature of _stations.features || []) {
      const properties = feature.properties || {};
      if (properties.N02_005c && properties.N02_005g) {
        _stationGroupByCode.set(properties.N02_005c, properties.N02_005g);
      }
    }
  }
  return { rail: _rail, stations: _stations };
}

// (MinHeap is AppCore.TupleMinHeap — the shared [priority, value] tuple heap.)

// Build the multi-line subgraph + node→station map + code→nodes index.
function buildGraph(lineNames) {
  const { rail, stations } = loadData();
  const lines = new Set(lineNames);
  const adj = new Map(); // node key -> [[neighborKey, km, xy]]
  const xy = new Map(); // node key -> [x,y]
  const ensure = (coord) => {
    const k = nk(coord);
    if (!xy.has(k)) xy.set(k, [q(coord[0]), q(coord[1])]);
    if (!adj.has(k)) adj.set(k, []);
    return k;
  };
  for (const f of rail.features) {
    if (!lines.has(String(f.properties?.N02_003))) continue;
    const co = f.geometry?.coordinates;
    if (!Array.isArray(co)) continue;
    for (let i = 1; i < co.length; i += 1) {
      const ka = ensure(co[i - 1]);
      const kb = ensure(co[i]);
      if (ka === kb) continue;
      const w = edgeKm(xy.get(ka), xy.get(kb));
      adj.get(ka).push([kb, w]);
      adj.get(kb).push([ka, w]);
    }
  }
  // Station indexes (only for stations whose nodes are on this subgraph).
  const nodeStation = new Map(); // node key -> {code,name}
  const codeNodes = new Map(); // N02_005c -> [node keys]
  const groupNodes = new Map(); // N02_005g -> [node keys]
  for (const f of stations.features) {
    const p = f.properties || {};
    if (!lines.has(String(p.N02_003))) continue;
    for (const c of f.geometry?.coordinates || []) {
      const k = nk(c);
      if (!adj.has(k)) continue;
      if (!nodeStation.has(k))
        nodeStation.set(k, { code: p.N02_005c, name: p.N02_005 });
      if (p.N02_005c) {
        if (!codeNodes.has(p.N02_005c)) codeNodes.set(p.N02_005c, []);
        codeNodes.get(p.N02_005c).push(k);
      }
      if (p.N02_005g) {
        if (!groupNodes.has(p.N02_005g)) groupNodes.set(p.N02_005g, []);
        groupNodes.get(p.N02_005g).push(k);
      }
    }
  }
  // Zero-cost transfer edges between nodes of the same station group, so a
  // route can cross between the lines that meet at a shared station.
  for (const nodes of groupNodes.values()) {
    if (nodes.length < 2) continue;
    for (let i = 1; i < nodes.length; i += 1) {
      adj.get(nodes[0]).push([nodes[i], 0]);
      adj.get(nodes[i]).push([nodes[0], 0]);
    }
  }
  return { adj, xy, nodeStation, codeNodes, groupNodes };
}

function nodeForCode(code, g) {
  const nodes = g.codeNodes.get(code) || [];
  if (nodes.length) return nodes[0];
  loadData();
  const groupCode = _stationGroupByCode.get(code);
  const groupNodes = groupCode ? g.groupNodes.get(groupCode) || [] : [];
  return groupNodes.length ? groupNodes[0] : null;
}

function shortestPath(g, from, to) {
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const heap = new MinHeap();
  heap.push(0, from);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (u === to) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const [v, w] of g.adj.get(u) || []) {
      const nd = d + w;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, u);
        heap.push(nd, v);
      }
    }
  }
  if (to !== from && !prev.has(to)) return null;
  const path = [to];
  let cur = to;
  while (prev.has(cur)) {
    cur = prev.get(cur);
    path.push(cur);
  }
  return path.reverse();
}

// Returns [{code, name}, ...] origin..dest inclusive, or null if unroutable.
export function expandRouteStations(fromCode, toCode, lineNames) {
  const g = buildGraph(lineNames);
  const from = nodeForCode(fromCode, g);
  const to = nodeForCode(toCode, g);
  if (!from || !to) return null;
  const path = shortestPath(g, from, to);
  if (!path) return null;
  const best = new Map(); // code -> {idx, name}
  path.forEach((n, i) => {
    const st = g.nodeStation.get(n);
    if (!st || !st.code) return;
    const cur = best.get(st.code);
    if (!cur || i < cur.idx) best.set(st.code, { idx: i, name: st.name });
  });
  return [...best.entries()]
    .sort((a, b) => a[1].idx - b[1].idx)
    .map(([code, v]) => ({ code, name: v.name }));
}

export function findStationCode(name, lineNames) {
  const { stations } = loadData();
  const lines = new Set(lineNames || []);
  const findByName = (matchesName) =>
    (stations.features || []).find((candidate) => {
      const properties = candidate.properties || {};
      return (
        matchesName(properties.N02_005) &&
        (!lines.size || lines.has(String(properties.N02_003))) &&
        properties.N02_005c
      );
    });
  // Exact N02_005 match first (so no previously-succeeding lookup can change),
  // then the app's tolerant normalization (NFKC + ヶ/ヵ/ゖ/ゕ + whitespace) for
  // the spelling variants N02 and hand-written specs disagree on. A true miss
  // still returns null so callers keep their loud failure.
  const exact = findByName((candidate) => candidate === name);
  if (exact) return exact.properties.N02_005c;
  const normalizedName = normalizeStationName(name);
  const normalized = findByName(
    (candidate) => normalizeStationName(candidate) === normalizedName,
  );
  return normalized?.properties?.N02_005c || null;
}

// Expand explicitly split physical route pieces. This keeps line constraints
// exact at junctions (for example 根岸線→東海道線 at 横浜) while still
// emitting one stop for the shared station group.
export function expandRouteStationPieces(pieces) {
  const stations = [];
  const sections = [];
  for (const piece of pieces) {
    const expanded = expandRouteStations(
      piece.from_n02_station_code,
      piece.to_n02_station_code,
      piece.line_names,
    );
    if (!expanded?.length) return null;
    const deduped = expanded.filter(
      (station, index) =>
        index === 0 || station.name !== expanded[index - 1].name,
    );
    if (
      stations.length &&
      stations.at(-1).name !== deduped[0]?.name
    ) {
      return null;
    }
    if (!stations.length) stations.push(deduped[0]);
    for (const station of deduped.slice(1)) {
      const from = stations.at(-1);
      sections.push({
        from: from.name,
        to: station.name,
        from_n02_station_code: from.code,
        to_n02_station_code: station.code,
        line_names: piece.line_names,
      });
      stations.push(station);
    }
  }
  return { stations, sections };
}
