(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.RailNetwork = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_LINE_COLOR = "#7C8A82";
  const RANK_MINZOOM = [3, 4, 5, 6, 7];
  const STATION_DOT_GAP_PX = 22;
  const STATION_LOD_K =
    (STATION_DOT_GAP_PX * 40075.017) /
    (256 * Math.cos((35 * Math.PI) / 180));
  const STATION_MINZ_CAP = 14;
  const ROMA_SOURCE = { 1: "osm", 2: "wikidata", 3: "official" };
  const MICRO_KINK_MAX_EDGE_METERS = 30;
  const MICRO_KINK_MIN_TURN_DEGREES = 55;
  const MICRO_KINK_MAX_DEVIATION_METERS = 3;

  function sameCoordinate(left, right) {
    return Boolean(
      left &&
        right &&
        left[0] === right[0] &&
        left[1] === right[1],
    );
  }

  function localMetric(point, latitude) {
    const radians = (latitude * Math.PI) / 180;
    return [
      point[0] * 111320 * Math.cos(radians),
      point[1] * 111320,
    ];
  }

  function distanceMeters(left, right) {
    const latitude = (left[1] + right[1]) / 2;
    const a = localMetric(left, latitude);
    const b = localMetric(right, latitude);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  function turnDegrees(previous, corner, following) {
    const latitude = corner[1];
    const a = localMetric(previous, latitude);
    const b = localMetric(corner, latitude);
    const c = localMetric(following, latitude);
    const incoming = [b[0] - a[0], b[1] - a[1]];
    const outgoing = [c[0] - b[0], c[1] - b[1]];
    const denominator = Math.hypot(...incoming) * Math.hypot(...outgoing);
    if (!denominator) return 0;
    const cosine = Math.max(
      -1,
      Math.min(
        1,
        (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) /
          denominator,
      ),
    );
    return (Math.acos(cosine) * 180) / Math.PI;
  }

  function pointSegmentDistanceMeters(point, start, end) {
    const latitude = point[1];
    const p = localMetric(point, latitude);
    const a = localMetric(start, latitude);
    const b = localMetric(end, latitude);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const ratio = lengthSquared
      ? Math.max(
          0,
          Math.min(
            1,
            ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) /
              lengthSquared,
          ),
        )
      : 0;
    return Math.hypot(
      p[0] - (a[0] + ratio * dx),
      p[1] - (a[1] + ratio * dy),
    );
  }

  // Remove only metre-scale GIS digitising barbs. The 3 m deviation cap is
  // deliberately much tighter than a real railway curve or switchback, so
  // the centre-line keeps its surveyed shape while tiny in/out reversals no
  // longer render as sharp thorns. Repeating to stability also cleans a
  // two-vertex barb without applying broad smoothing to the rest of the line.
  function smoothMicroKinks(coordinates) {
    let current = [];
    for (const coordinate of coordinates || []) {
      if (!sameCoordinate(current[current.length - 1], coordinate))
        current.push([coordinate[0], coordinate[1]]);
    }
    let changed = true;
    while (changed && current.length > 2) {
      changed = false;
      const next = [current[0]];
      for (let index = 1; index < current.length - 1; index += 1) {
        const previous = next[next.length - 1];
        const corner = current[index];
        const following = current[index + 1];
        const shortEdge = Math.min(
          distanceMeters(previous, corner),
          distanceMeters(corner, following),
        );
        const isMicroKink =
          shortEdge <= MICRO_KINK_MAX_EDGE_METERS &&
          turnDegrees(previous, corner, following) >=
            MICRO_KINK_MIN_TURN_DEGREES &&
          pointSegmentDistanceMeters(corner, previous, following) <=
            MICRO_KINK_MAX_DEVIATION_METERS;
        if (isMicroKink) changed = true;
        else if (!sameCoordinate(next[next.length - 1], corner)) next.push(corner);
      }
      if (!sameCoordinate(next[next.length - 1], current[current.length - 1]))
        next.push(current[current.length - 1]);
      current = next;
    }
    return current;
  }

  // The compact package stores station intervals for routing and attribution,
  // but MapLibre should receive ONE complete feature per display line. Decode
  // every interval, snap both ends to the authoritative station anchor, weld
  // the shared boundary once, then groom only metre-scale kinks. A branch is
  // represented by its own line id and therefore remains a complete feature
  // whose junction coordinate is shared with its trunk.
  function continuousCoordinatesForLine(compactLine) {
    const stationCount = compactLine.stations.length;
    const joined = [];
    let previousLastCoordinate = null;
    compactLine.segments.forEach((row, index) => {
      const decoded = row[1]
        ? [previousLastCoordinate].concat(
            row[2].map((coordinate) => [coordinate[0], coordinate[1]]),
          )
        : row[2].map((coordinate) => [coordinate[0], coordinate[1]]);
      const nextIndex = (index + 1) % stationCount;
      const startStation = compactLine.stations[index];
      const endStation = compactLine.stations[nextIndex];
      decoded[0] = [startStation[2], startStation[3]];
      decoded[decoded.length - 1] = [endStation[2], endStation[3]];
      if (joined.length && sameCoordinate(joined[joined.length - 1], decoded[0]))
        joined.push(...decoded.slice(1));
      else joined.push(...decoded);
      previousLastCoordinate = decoded[decoded.length - 1];
    });
    return smoothMicroKinks(joined);
  }

  function routeHintValues(properties, arrayFields, objectFields) {
    const values = new Set();
    for (const field of arrayFields) {
      const rows = properties?.[field];
      if (!Array.isArray(rows)) continue;
      for (const value of rows)
        if (value != null && value !== "") values.add(String(value));
    }
    for (const field of objectFields) {
      const rows = properties?.[field];
      if (!rows || typeof rows !== "object" || Array.isArray(rows)) continue;
      for (const value of Object.keys(rows)) if (value) values.add(value);
    }
    return values;
  }

  function addIndexValue(index, key, value) {
    if (!key) return;
    let rows = index.get(key);
    if (!rows) index.set(key, (rows = []));
    rows.push(value);
  }

  function lineMetric(line) {
    if (line._displayMetric) return line._displayMetric;
    const coordinates = line.geometry?.coordinates || [];
    const cumulative = [0];
    for (let index = 1; index < coordinates.length; index += 1) {
      cumulative.push(
        cumulative[index - 1] +
          distanceMeters(coordinates[index - 1], coordinates[index]),
      );
    }
    const metric = { coordinates, cumulative, length: cumulative.at(-1) || 0 };
    Object.defineProperty(line, "_displayMetric", {
      configurable: true,
      value: metric,
    });
    return metric;
  }

  function projectPointToLine(line, point, projectionCache) {
    if (!point || point.length < 2) return null;
    const cacheKey = `${line.lineId}|${Number(point[0]).toFixed(7)},${Number(point[1]).toFixed(7)}`;
    const cached = projectionCache?.get(cacheKey);
    if (cached) return cached;
    const metric = lineMetric(line);
    let best = null;
    for (let index = 0; index < metric.coordinates.length - 1; index += 1) {
      const start = metric.coordinates[index];
      const end = metric.coordinates[index + 1];
      const latitude = point[1];
      const p = localMetric(point, latitude);
      const a = localMetric(start, latitude);
      const b = localMetric(end, latitude);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      const ratio = lengthSquared
        ? Math.max(
            0,
            Math.min(
              1,
              ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) /
                lengthSquared,
            ),
          )
        : 0;
      const projected = [
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio,
      ];
      const distance = distanceMeters(point, projected);
      if (!best || distance < best.distance) {
        const segmentLength =
          metric.cumulative[index + 1] - metric.cumulative[index];
        best = {
          coordinate: projected,
          distance,
          index,
          ratio,
          measure: metric.cumulative[index] + segmentLength * ratio,
        };
      }
    }
    if (best && projectionCache) projectionCache.set(cacheKey, best);
    return best;
  }

  function pushCoordinate(coordinates, coordinate) {
    if (!sameCoordinate(coordinates[coordinates.length - 1], coordinate))
      coordinates.push([coordinate[0], coordinate[1]]);
  }

  function sliceForward(metric, start, end, wraps) {
    const output = [];
    pushCoordinate(output, start.coordinate);
    if (!wraps) {
      for (let index = start.index + 1; index <= end.index; index += 1)
        pushCoordinate(output, metric.coordinates[index]);
    } else {
      for (
        let index = start.index + 1;
        index < metric.coordinates.length;
        index += 1
      )
        pushCoordinate(output, metric.coordinates[index]);
      // A loop's last point repeats its first. Resume at vertex 1 so the
      // junction is emitted once and the resulting arc has no seam.
      for (let index = 1; index <= end.index; index += 1)
        pushCoordinate(output, metric.coordinates[index]);
    }
    pushCoordinate(output, end.coordinate);
    return output;
  }

  function pathLength(coordinates) {
    let total = 0;
    for (let index = 1; index < coordinates.length; index += 1)
      total += distanceMeters(coordinates[index - 1], coordinates[index]);
    return total;
  }

  function canonicalLineSlice(line, start, end, rawCoordinates) {
    const metric = lineMetric(line);
    if (!line.isLoop) {
      if (start.measure <= end.measure)
        return sliceForward(metric, start, end, false);
      return sliceForward(metric, end, start, false).reverse();
    }

    const forward = sliceForward(
      metric,
      start,
      end,
      end.measure < start.measure,
    );
    const backward = sliceForward(
      metric,
      end,
      start,
      start.measure < end.measure,
    ).reverse();
    const rawLength = pathLength(rawCoordinates || []);
    return Math.abs(pathLength(forward) - rawLength) <=
      Math.abs(pathLength(backward) - rawLength)
      ? forward
      : backward;
  }

  function routeGeometryLines(geometry) {
    if (geometry?.type === "LineString") return [geometry.coordinates || []];
    if (geometry?.type === "MultiLineString") return geometry.coordinates || [];
    return [];
  }

  // The route solver decides WHICH railway a ride used; this function decides
  // the pixels. It projects the solved endpoints onto the already-built
  // complete display line and returns an exact slice of that same LineString.
  // Consequently ridden and "all railway" layers cannot drift, disagree at a
  // station, or apply different micro-kink grooming.
  function canonicalizeRouteFeature(network, feature) {
    const rawLines = routeGeometryLines(feature?.geometry).filter(
      (coordinates) => coordinates.length >= 2,
    );
    if (!network || !rawLines.length) return null;
    const properties = feature.properties || {};
    const lineNames = routeHintValues(
      properties,
      ["required_line_names", "preferred_line_names"],
      ["used_line_names"],
    );
    const operatorNames = routeHintValues(
      properties,
      ["required_operator_names", "preferred_operator_names"],
      ["used_operator_names"],
    );
    let candidates = [];
    for (const name of lineNames)
      candidates.push(...(network.linesByName?.get(name) || []));
    if (!candidates.length)
      for (const operator of operatorNames)
        candidates.push(...(network.linesByOperator?.get(operator) || []));
    candidates = [...new Set(candidates)];
    if (operatorNames.size) {
      const operatorMatched = candidates.filter((line) =>
        operatorNames.has(line.operator),
      );
      if (operatorMatched.length) candidates = operatorMatched;
    }
    if (!candidates.length) candidates = [...network.lineById.values()];

    const canonicalLines = [];
    const usedLineIds = [];
    for (const rawCoordinates of rawLines) {
      const rawStart = rawCoordinates[0];
      const rawEnd = rawCoordinates[rawCoordinates.length - 1];
      let best = null;
      for (const line of candidates) {
        const start = projectPointToLine(
          line,
          rawStart,
          network.routeProjectionCache,
        );
        const end = projectPointToLine(
          line,
          rawEnd,
          network.routeProjectionCache,
        );
        if (!start || !end) continue;
        const score = start.distance + end.distance;
        if (!best || score < best.score) best = { line, start, end, score };
      }
      // Endpoint display coordinates may deliberately bridge a station marker
      // to its surveyed track. The characterized packages stay below 500 m;
      // 1.5 km leaves room for future rural station corrections while still
      // refusing an unrelated same-named railway elsewhere in the country.
      if (!best || Math.max(best.start.distance, best.end.distance) > 1500)
        return null;
      const canonical = canonicalLineSlice(
        best.line,
        best.start,
        best.end,
        rawCoordinates,
      );
      if (canonical.length < 2) return null;
      canonicalLines.push(canonical);
      usedLineIds.push(best.line.lineId);
    }

    return {
      ...feature,
      properties: {
        ...properties,
        display_geometry_source: "all-railways-complete-line",
        display_line_ids: [...new Set(usedLineIds)],
      },
      geometry:
        feature.geometry.type === "MultiLineString"
          ? { type: "MultiLineString", coordinates: canonicalLines }
          : { type: "LineString", coordinates: canonicalLines[0] },
    };
  }

  function minZoomForRank(rank) {
    return rank == null
      ? 0
      : RANK_MINZOOM[rank] != null
        ? RANK_MINZOOM[rank]
        : 0;
  }

  // Zoom-out visibility is decided by the COMPLETE LINE length: long trunks
  // survive the widest views and short lines drop out first.
  function minZoomForLength(totalKm) {
    if (totalKm >= 150) return 3;
    if (totalKm >= 70) return 4;
    if (totalKm >= 30) return 5;
    if (totalKm >= 12) return 6;
    return 7;
  }

  function stationMinZoomForLine(lineMinZoom, totalKm, stationCount) {
    if (stationCount < 2 || totalKm <= 0) return lineMinZoom;
    const averageSpacingKm = totalKm / (stationCount - 1);
    const densityMinZoom = Math.round(
      Math.log2(STATION_LOD_K / averageSpacingKm),
    );
    // Stations may declutter EARLIER than their line, but never outlive it:
    // minz is always >= the complete line's length-derived threshold.
    return Math.min(
      STATION_MINZ_CAP,
      Math.max(lineMinZoom, densityMinZoom),
    );
  }

  function visibilityGroupKey(compactLine) {
    // Some physical lines are stored as several disconnected/administrative
    // entries. Group those pieces only when BOTH operator and display name
    // agree; grouping by a generic name such as 本線 alone would incorrectly
    // bind unrelated railways across Japan.
    return `${compactLine.operator}\u0000${compactLine.name}`;
  }

  function buildNetworkFromCompactPackage(pkg) {
    if (!pkg || pkg.format !== "compact-v1" || !Array.isArray(pkg.lines))
      return null;

    const lineById = new Map();
    const stationById = new Map();
    const groupMembers = new Map();
    const linesByName = new Map();
    const linesByOperator = new Map();
    const lineFeatures = [];
    const stationFeatures = [];

    // The threshold uses the sum of every piece in the same physical display
    // line. All pieces therefore receive one identical minz and disappear as
    // a unit even when the package stores them under several line ids.
    const groupLengthKm = new Map();
    for (const compactLine of pkg.lines) {
      const totalKm = compactLine.segments.reduce(
        (sum, row) => sum + row[0],
        0,
      );
      const key = visibilityGroupKey(compactLine);
      groupLengthKm.set(key, (groupLengthKm.get(key) || 0) + totalKm);
    }

    for (const compactLine of pkg.lines) {
      const lineId = compactLine.id;
      const stationCount = compactLine.stations.length;
      const featureColor = compactLine.color || DEFAULT_LINE_COLOR;
      const visibilityKm = groupLengthKm.get(visibilityGroupKey(compactLine));
      const lineMinZoom = minZoomForLength(visibilityKm);
      const stationIds = compactLine.stations.map(
        (row) => `${lineId}:${row[0]}`,
      );
      const totalKm = compactLine.segments.reduce(
        (sum, row) => sum + row[0],
        0,
      );

      lineById.set(lineId, {
        lineId,
        name: compactLine.name,
        operator: compactLine.operator,
        nameRoma: compactLine.nameRoma,
        isHSR: Boolean(compactLine.isHSR),
        isLoop: Boolean(compactLine.isLoop),
        rank: compactLine.rank,
        color: compactLine.color,
        logo: compactLine.logo ? `/rail/logos/${lineId}.png` : null,
        stationOrder: stationIds,
        km: totalKm,
        visibilityKm,
        minZoom: lineMinZoom,
      });

      const lineCoordinates = continuousCoordinatesForLine(compactLine);
      const lineGeometry = {
        type: "LineString",
        coordinates: lineCoordinates,
      };
      lineFeatures.push({
        type: "Feature",
        geometry: lineGeometry,
        properties: {
          lineId,
          name: compactLine.name,
          operator: compactLine.operator,
          color: featureColor,
          minz: lineMinZoom,
          isHSR: compactLine.isHSR ? 1 : 0,
          isLoop: compactLine.isLoop ? 1 : 0,
          intervalCount: compactLine.segments.length,
          visibilityKm,
        },
      });
      lineById.get(lineId).geometry = lineGeometry;
      addIndexValue(linesByName, compactLine.name, lineById.get(lineId));
      addIndexValue(
        linesByOperator,
        compactLine.operator,
        lineById.get(lineId),
      );

      const stationMinZoom = stationMinZoomForLine(
        lineMinZoom,
        totalKm,
        stationCount,
      );

      compactLine.stations.forEach((row, index) => {
        const isTerminal =
          !compactLine.isLoop &&
          (index === 0 || index === stationCount - 1);
        const station = {
          stationId: stationIds[index],
          name: row[1],
          lineId,
          seq: index,
          lon: row[2],
          lat: row[3],
          stationGroupId: row[0],
        };
        if (row.length > 4) {
          station.nameRoma = row[4];
          station.romaSource = ROMA_SOURCE[row[5]];
        }
        stationById.set(station.stationId, station);

        const groupKey =
          station.stationGroupId || `solo:${station.stationId}`;
        let members = groupMembers.get(groupKey);
        if (!members) {
          members = [];
          groupMembers.set(groupKey, members);
        }
        members.push(station);

        stationFeatures.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [station.lon, station.lat],
          },
          properties: {
            stationId: station.stationId,
            lineId,
            name: station.name,
            nameRoma: station.nameRoma || "",
            stationGroupId: station.stationGroupId || "",
            lineMinz: lineMinZoom,
            // A non-loop line's two endpoints are structural and follow the
            // complete line exactly. Intermediate stations retain the denser
            // spacing-based LOD and may appear several zoom levels later.
            isTerminal: isTerminal ? 1 : 0,
            minz: isTerminal ? lineMinZoom : stationMinZoom,
          },
        });
      });
    }

    return {
      version: pkg.version,
      segments: {
        type: "FeatureCollection",
        // Historical API name retained for callers. Features are complete
        // display lines, not station-to-station fragments.
        features: lineFeatures,
      },
      stations: {
        type: "FeatureCollection",
        features: stationFeatures,
      },
      lineById,
      stationById,
      groupMembers,
      linesByName,
      linesByOperator,
      routeProjectionCache: new Map(),
    };
  }

  return Object.freeze({
    DEFAULT_LINE_COLOR,
    buildNetworkFromCompactPackage,
    minZoomForRank,
    minZoomForLength,
    continuousCoordinatesForLine,
    canonicalizeRouteFeature,
    smoothMicroKinks,
    stationMinZoomForLine,
  });
});
