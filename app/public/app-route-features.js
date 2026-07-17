// =========================================================================
//  app-route-features.js — §30: geometry helpers & matched-route feature assembly
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// =========================================================================
//  §30.  Geometry helpers & matched-route feature assembly
// =========================================================================

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

class MinHeap {
  constructor() {
    this.items = [];
  }
  size() {
    return this.items.length;
  }
  push(item) {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }
  pop() {
    if (this.items.length === 1) return this.items.pop();
    const top = this.items[0];
    this.items[0] = this.items.pop();
    this.bubbleDown(0);
    return top;
  }
  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= this.items[index].priority) break;
      [this.items[parent], this.items[index]] = [
        this.items[index],
        this.items[parent],
      ];
      index = parent;
    }
  }
  bubbleDown(index) {
    const length = this.items.length;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (
        left < length &&
        this.items[left].priority < this.items[smallest].priority
      )
        smallest = left;
      if (
        right < length &&
        this.items[right].priority < this.items[smallest].priority
      )
        smallest = right;
      if (smallest === index) break;
      [this.items[smallest], this.items[index]] = [
        this.items[index],
        this.items[smallest],
      ];
      index = smallest;
    }
  }
}

function getMatchedRouteFeatures(train) {
  let candidates = generateMatchedRouteFeaturesForTrain(train);

  if (!candidates.length) {
    candidates = matchedRoutesGeoJson.features
      .filter((feature) => {
        const p = feature.properties || {};
        return p.train_id === train.id && p.is_primary !== false;
      })
      .sort(
        (a, b) =>
          Number(a.properties?.segment_index ?? 0) -
          Number(b.properties?.segment_index ?? 0),
      );
  }

  if (!candidates.length) {
    const templateKey = getTrainRouteTemplateKey(train);
    if (templateKey) {
      candidates = matchedRoutesGeoJson.features
        .filter((feature) => {
          const p = feature.properties || {};
          return p.route_template_key === templateKey && p.is_primary !== false;
        })
        .sort(
          (a, b) =>
            Number(a.properties?.segment_index ?? 0) -
            Number(b.properties?.segment_index ?? 0),
        );
    }
  }

  if (!candidates.length) {
    // During a progressive load the streaming warm-up solves trains one at a
    // time, so a repaint that lands before THIS train has been warmed legitimately
    // finds no route yet — it is not a failure. Stay silent; the train draws on
    // the next repaint once its geometry is cached. Only warn for a genuine
    // miss outside an import.
    if (!importInProgress) {
      console.warn(
        `No N02 railway route could be generated for train ${train.id}. Route will not be drawn.`,
      );
      setStatus(
        els.fieldStatus,
        "No N02 railway path could be generated from embedded N02 data. Check station codes / route_policy. No fake straight line was drawn.",
        "warn",
      );
    }
    return [];
  }

  const routeId = candidates[0].properties?.route_id || "";
  return candidates
    .filter((feature) => (feature.properties?.route_id || "") === routeId)
    .map((feature, index) => {
      const normalized = normalizeSingleRouteGeometry(feature);
      if (!normalized) return null;
      const segmentIndex = Number(
        normalized.properties?.segment_index ?? index,
      );
      return {
        ...normalized,
        properties: {
          ...(normalized.properties || {}),
          ride_segment: isRideSegment(train, segmentIndex),
        },
      };
    })
    .filter(Boolean);
}

function isRideSegment(train, segmentIndex) {
  const stops = train.stops || [];
  // A geometry segment is ridden (shown) only when both of its endpoints are
  // effectively ridden — pass-through endpoints inherit their interval state.
  return Boolean(
    effectiveStopRide(stops, segmentIndex) &&
      effectiveStopRide(stops, segmentIndex + 1),
  );
}

function normalizeSingleRouteGeometry(feature) {
  if (!feature?.geometry) return null;
  if (feature.geometry.type === "LineString") return feature;
  if (feature.geometry.type === "MultiLineString") {
    const role = feature.properties?.geometry_role;
    if (role === "single_path_with_gaps") return feature;
    console.warn(
      "Rejected MultiLineString because it is not declared as one route with gaps.",
      feature,
    );
    return null;
  }
  console.warn(
    "Rejected matched route with unsupported geometry type.",
    feature,
  );
  return null;
}

// matched-stops features indexed by train_id (built once — the dataset is
// static after load). getStopFeature used to linear-scan ALL features for
// every stop of every train on every marker rebuild: O(trains × stops ×
// matchedStops). Scanning only the train's own few features preserves the
// exact first-match semantics at a tiny fraction of the cost.
let _matchedStopsByTrain = null;
function getMatchedStopsForTrain(trainId) {
  if (!_matchedStopsByTrain) {
    _matchedStopsByTrain = new Map();
    for (const f of matchedStopsGeoJson.features) {
      const tid = (f.properties || {}).train_id;
      if (tid == null) continue;
      let arr = _matchedStopsByTrain.get(tid);
      if (!arr) _matchedStopsByTrain.set(tid, (arr = []));
      arr.push(f);
    }
  }
  return _matchedStopsByTrain.get(trainId) || [];
}

function getStopFeature(stop, train) {
  const explicit = getMatchedStopsForTrain(train.id).find((f) => {
    const p = f.properties || {};
    return (
      p.train_id === train.id &&
      (p.n02_station_code === stopStationCode(stop) ||
        p.name === stopName(stop))
    );
  });
  if (explicit) {
    return {
      ...explicit,
      properties: {
        ...(explicit.properties || {}),
        ...stop,
        name: stopName(stop),
        n02_station_code:
          stopStationCode(stop) ||
          explicit.properties?.n02_station_code ||
          null,
      },
    };
  }
  const station = resolveStationForTrain(stop, train);
  if (!station) return null;
  return {
    type: "Feature",
    properties: {
      ...stop,
      name: stopName(stop),
      n02_station_code: stopStationCode(stop) || stationCode(station),
      n02_group_code: stop.n02_group_code || stationGroupCode(station),
      train_id: train.id,
      train_type: train.train_type || "",
      company: train.company || "",
      number: train.number,
      line_name: stationLineName(station),
      operator: stationOperator(station),
      source: "station display_point",
    },
    geometry: {
      type: "Point",
      coordinates: getFeatureDisplayCoordinate(station),
    },
  };
}

