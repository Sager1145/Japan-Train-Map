// =========================================================================
//  app-coords.js — the shared coordinate primitives
//
//  Four functions that every route module needs and that each happened to
//  be declared wherever it was first written: normalizeGraphCoord and
//  coordKey in the solver, routeCoordinateSegmentKey in the deck records,
//  iterateGeometryLines in the route features. Because they lived inside
//  those modules, using a coordinate primitive meant taking a dependency on
//  a whole subsystem — which is why route-simplify, route-graph and
//  route-solver were each in a cycle with a module they otherwise had no
//  business depending on.
//
//  They belong together and they belong at the bottom: this file depends on
//  nothing but window.AppCore, which owns the 5-decimal grid rule itself.
//
//  The feature->coordinate accessors joined them for the same reason. Seven
//  modules ask a GeoJSON feature where it is; the two functions that answer
//  were declared in app-style.js, so route solving, route graphing, deck
//  records, persistence and station resolution all appeared to depend on the
//  styling module. `clone` came with them: it is the deep copy those
//  accessors return coordinates through, and its only other callers are data
//  modules that were reaching into app-stations.js for it.
//
//  These formats are compatibility surfaces. Route-cache keys, stats edge
//  keys and overlap caches are all keyed on the exact bytes emitted here, so
//  a change to the spelling is a change to every persisted cache.
// =========================================================================

function normalizeGraphCoord(coord) {
  // AppCore.quant5 is the single owner of the N02 5-decimal grid rule: graph
  // nodes, stats edge keys, deck segment keys and the build-time station
  // expansion must all quantize identically or cross-module coordinate
  // identities drift apart.
  return [
    window.AppCore.quant5(Number(coord[0])),
    window.AppCore.quant5(Number(coord[1])),
  ];
}

// Hot enough (two calls per drawn route segment — ~700k per full-Japan
// repaint) that the intermediate array normalizeGraphCoord returns is worth
// skipping. Same quant5 rule, same bytes.
function coordKey(coord) {
  const quant5 = window.AppCore.quant5;
  return quant5(Number(coord[0])) + "," + quant5(Number(coord[1]));
}

// Direction-independent key of one drawn route segment. Deliberately NOT
// AppCore.edgeKey5: this key's historical byte format orders the two node
// keys as STRINGS (Array.sort), while edgeKey5 orders numerically — the
// overlap caches keyed on this exact format must not change. It still sits on
// the shared 5-decimal grid because coordKey quantizes via AppCore.quant5.
// Built once per drawn segment (~350k times on a full-Japan store), so it
// compares the two node keys directly instead of allocating a two-element
// array and running Array.sort on it. Array.sort's default comparator orders
// by the elements' string values, which for two strings is exactly `<=` —
// the emitted bytes are unchanged.
function routeCoordinateSegmentKey(a, b) {
  const ka = coordKey(a);
  const kb = coordKey(b);
  return ka <= kb ? ka + "|" + kb : kb + "|" + ka;
}

// Normalized lines are a pure function of the (immutable) geometry object, so
// memoize per geometry. refreshRouteVertexSnap re-walks every matched route on
// EACH overlap rebuild, and the route-graph builders re-walk rail features, and
// all of them previously re-ran normalizeGraphCoord (toFixed rounding) over the
// same constant coordinates every pass. Every caller only READS the returned
// arrays (segKeys / bbox / graph edges / flat() copies are built into fresh
// structures; none mutate a coordinate pair or a line array), so sharing the
// cached arrays is behavior-identical. WeakMap-keyed so entries drop with the
// feature geometry. Empty results are not cached (cheap, and Point-without-
// coordinates is already screened out above).
const _geometryLinesCache = new WeakMap();

function iterateGeometryLines(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  const memo = _geometryLinesCache.get(geometry);
  if (memo) return memo;
  let result;
  if (geometry.type === "LineString")
    result = [geometry.coordinates.map(normalizeGraphCoord)];
  else if (geometry.type === "MultiLineString")
    result = geometry.coordinates.map((line) => line.map(normalizeGraphCoord));
  else if (geometry.type === "Point")
    result = [[normalizeGraphCoord(geometry.coordinates)]];
  else return [];
  _geometryLinesCache.set(geometry, result);
  return result;
}

// Deep copy of plain JSON data. Callers of getFeaturePathCoordinates mutate
// what they get back, so the LineString/Point branch must not hand out the
// feature's own array.
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Where a feature is, for display purposes: an explicit display_point wins,
// then a Point's own coordinates, then the first vertex of its path.
function getFeatureDisplayCoordinate(feature) {
  const p = feature.properties || {};
  if (Array.isArray(p.display_point)) return p.display_point;
  if (feature.geometry?.type === "Point") return feature.geometry.coordinates;
  return getFeaturePathCoordinates(feature)[0];
}

function getFeaturePathCoordinates(feature) {
  if (!feature?.geometry) return [];
  if (
    feature.geometry.type === "LineString" ||
    feature.geometry.type === "Point"
  )
    return clone(feature.geometry.coordinates);
  if (feature.geometry.type === "MultiLineString")
    return feature.geometry.coordinates.flatMap((line) => line);
  return [];
}
