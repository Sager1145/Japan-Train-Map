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
  // Micro-kink grooming is SCALE-RELATIVE. On a 150 km trunk a 30 m in-and-out
  // barb with a 3 m bulge is certainly GIS digitising noise; on a street tram
  // or a people-mover the very same numbers describe a REAL corner (a tram
  // rounds a city block in tens of metres). Applying the trunk thresholds to
  // those lines rubs their genuine corners flat. So each line picks its limits
  // from its own characteristic scale — the median distance between stations.
  const MICRO_KINK_SCALES = [
    // Street trams, people movers, funiculars: stops every few hundred metres
    // and curve radii to match. Only sub-10 m spikes are noise here.
    { maxSpacingMeters: 700, edge: 8, turn: 75, deviation: 0.8 },
    // Dense urban metro / short private lines.
    { maxSpacingMeters: 1600, edge: 16, turn: 65, deviation: 1.5 },
    // Ordinary regional and trunk railways (the historic thresholds).
    { maxSpacingMeters: Infinity, edge: 30, turn: 55, deviation: 3 },
  ];
  const DEFAULT_MICRO_KINK = MICRO_KINK_SCALES[MICRO_KINK_SCALES.length - 1];
  // At this deflection the two edges are effectively anti-parallel: the vertex
  // is a zero-width spike (out and straight back), which is digitising noise at
  // every scale. The lateral-deviation cap only makes sense for the shallower
  // range, where it separates a real sharp corner from a bulge.
  const SPIKE_MIN_TURN_DEGREES = 150;

  // ── branch topology (see displayPartsForLine) ──
  // A vertex this close to track the same line already drew counts as running
  // back over it rather than as new railway.
  const RETRACE_MATCH_METERS = 35;
  // Ignore the unavoidable few metres of coincidence at a shared station
  // boundary; only a sustained run of re-used track is a retrace.
  const RETRACE_MIN_RUN_METERS = 600;
  // What is left of an interval after its retraced head is trimmed has to be
  // real railway, not a stub of rounding noise.
  const RETRACE_MIN_TAIL_METERS = 150;
  // A station anchor can sit this far off the surveyed centre-line (measured
  // max ≈130 m on jp-2025), so this is how close a track vertex has to be to
  // count as "the line passes this station".
  const STATION_TOUCH_METERS = 150;
  // Two intervals meeting at this shallow an angle are not a curve — the line
  // is reversing onto other track (a branch), so the drawn line must break.
  const REVERSAL_MAX_DEGREES = 25;

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

  // The grooming limits a line of this median station spacing should use.
  function microKinkLimitsForSpacing(medianSpacingMeters) {
    if (!(medianSpacingMeters > 0)) return DEFAULT_MICRO_KINK;
    for (const scale of MICRO_KINK_SCALES)
      if (medianSpacingMeters <= scale.maxSpacingMeters) return scale;
    return DEFAULT_MICRO_KINK;
  }

  // Remove only GIS digitising barbs at the line's OWN scale. The deviation cap
  // stays far tighter than a real curve or switchback for that kind of railway,
  // so the centre-line keeps its surveyed shape while tiny in/out reversals no
  // longer render as sharp thorns. Repeating to stability also cleans a
  // two-vertex barb without applying broad smoothing to the rest of the line.
  function smoothMicroKinks(coordinates, limits) {
    const { edge, turn, deviation } = limits || DEFAULT_MICRO_KINK;
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
        const deflection = turnDegrees(previous, corner, following);
        const isMicroKink =
          shortEdge <= edge &&
          deflection >= turn &&
          (deflection >= SPIKE_MIN_TURN_DEGREES ||
            pointSegmentDistanceMeters(corner, previous, following) <=
              deviation);
        if (isMicroKink) changed = true;
        else if (!sameCoordinate(next[next.length - 1], corner)) next.push(corner);
      }
      if (!sameCoordinate(next[next.length - 1], current[current.length - 1]))
        next.push(current[current.length - 1]);
      current = next;
    }
    return current;
  }

  // ─────────────────────── laid-track index (retrace test) ───────────────────────
  // A coarse lon/lat bucket grid holding the edges a line has already drawn, so
  // "is this vertex running back over track we just laid?" is a local lookup
  // instead of a scan of the whole line.
  const TRACK_CELL_DEGREES = 0.004; // ~400 m — comfortably above the 35 m test

  function createTrackIndex() {
    const cells = new Map();
    const cellKey = (x, y) => `${x}|${y}`;
    return {
      add(coordinates) {
        for (let index = 1; index < coordinates.length; index += 1) {
          const a = coordinates[index - 1];
          const b = coordinates[index];
          const x0 = Math.floor(Math.min(a[0], b[0]) / TRACK_CELL_DEGREES);
          const x1 = Math.floor(Math.max(a[0], b[0]) / TRACK_CELL_DEGREES);
          const y0 = Math.floor(Math.min(a[1], b[1]) / TRACK_CELL_DEGREES);
          const y1 = Math.floor(Math.max(a[1], b[1]) / TRACK_CELL_DEGREES);
          for (let x = x0; x <= x1; x += 1)
            for (let y = y0; y <= y1; y += 1) {
              const key = cellKey(x, y);
              let rows = cells.get(key);
              if (!rows) cells.set(key, (rows = []));
              rows.push([a, b]);
            }
        }
      },
      isEmpty() {
        return cells.size === 0;
      },
      distanceTo(point) {
        const gx = Math.floor(point[0] / TRACK_CELL_DEGREES);
        const gy = Math.floor(point[1] / TRACK_CELL_DEGREES);
        let best = Infinity;
        for (let dx = -1; dx <= 1; dx += 1)
          for (let dy = -1; dy <= 1; dy += 1) {
            const rows = cells.get(cellKey(gx + dx, gy + dy));
            if (!rows) continue;
            for (const [a, b] of rows) {
              const distance = pointSegmentDistanceMeters(point, a, b);
              if (distance < best) best = distance;
            }
          }
        return best;
      },
    };
  }

  // How much of this interval's head runs back over track already drawn.
  // Returns the index of the first vertex that leaves it — the divergence
  // point where the branch actually parts company with its trunk.
  function retracedHeadIndex(coordinates, laid) {
    if (laid.isEmpty()) return 0;
    let run = 0;
    let index = 1;
    for (; index < coordinates.length; index += 1) {
      if (laid.distanceTo(coordinates[index]) > RETRACE_MATCH_METERS) break;
      run += distanceMeters(coordinates[index - 1], coordinates[index]);
    }
    return run >= RETRACE_MIN_RUN_METERS ? index - 1 : 0;
  }

  function nearestVertexIndex(coordinates, point) {
    let bestIndex = -1;
    let best = Infinity;
    for (let index = 0; index < coordinates.length; index += 1) {
      const distance = distanceMeters(coordinates[index], point);
      if (distance < best) {
        best = distance;
        bestIndex = index;
      }
    }
    return { index: bestIndex, distance: best };
  }

  function stationAt(stationPoints, point) {
    for (const station of stationPoints)
      if (distanceMeters(station, point) <= STATION_TOUCH_METERS) return station;
    return null;
  }

  // A branch only truly joins its trunk AT A STATION. The rail between the
  // station and the physical switch is shared, so the branch must be DRAWN over
  // it — but as its own coordinates, because the two are separate strokes and
  // must not be mathematically one connected line.
  //
  // So walk BACK along the track the branch leaves, from the divergence point
  // to the first station it passes: that slice, station-first, is the branch's
  // lead-in. Walking back is what makes it the "previous" station in the
  // branch's own direction of travel — never one reached by a hairpin.
  function branchLeadIn(sourceCoordinates, divergenceIndex, stationPoints) {
    for (let index = divergenceIndex; index >= 0; index -= 1) {
      const station = stationAt(stationPoints, sourceCoordinates[index]);
      if (!station) continue;
      const leadIn = sourceCoordinates
        .slice(index, divergenceIndex + 1)
        .map((c) => [c[0], c[1]]);
      // Start exactly on the platform anchor, not on the nearby track vertex.
      leadIn[0] = [station[0], station[1]];
      return leadIn;
    }
    return null;
  }

  // The compact package stores station intervals for routing and attribution,
  // but MapLibre should receive complete display geometry per line, not one
  // feature per station interval. Decode every interval, snap both ends to the
  // authoritative station anchor, weld the shared boundary once, then groom
  // kinks at the line's own scale.
  //
  // A package line is an ORDERED station list, and several real railways store
  // a trunk AND its branch under one id (室蘭線 carries 東室蘭–室蘭; 東北線
  // carries the 利府 branch). Concatenating that order blindly makes the drawn
  // line RETRACE — 室蘭線 ran 138 km back down its own main line to reach 御崎
  // — and because ridden routes are exact slices of this same geometry, a train
  // sliced across the retrace visibly turns onto the wrong railway.
  //
  // So the line is emitted as PARTS, cut wherever an interval doubles back over
  // track the line already drew. Two shapes of doubling-back, handled apart:
  //
  //   * the retrace comes straight back down the interval we are BUILDING —
  //     the station order took an excursion out to a branch tip and returned.
  //     Cut the current part at the divergence point: the excursion becomes a
  //     branch, and the trunk carries on along whatever this interval adds.
  //     (室蘭線: 本輪西 → 輪西 → 東室蘭 becomes trunk 本輪西 → 東室蘭 plus
  //     branch 東室蘭 → 輪西; 函館線 restores its 東森 → 森 main line.)
  //
  //   * the retrace lands on a part we already CLOSED — the order jumped back
  //     across the line. Just start a new part where the new track begins.
  //     (室蘭線's 岩見沢 → 御崎, 138 km back down its own main line.)
  //
  // Either way the branch is extended BACK to the station it leaves from, over
  // the trunk's own coordinates, because a branch only truly joins at a
  // station: the rail between platform and switch is shared and must be drawn
  // twice rather than turned into one connected line. The map reads continuous;
  // the topology stays separate, so nothing can slice through a junction.
  function displayPartsForLine(compactLine) {
    const stationCount = compactLine.stations.length;
    const stationPoints = compactLine.stations.map((station) => [
      station[2],
      station[3],
    ]);
    const limits = microKinkLimitsForSpacing(medianSpacingMeters(compactLine));
    const laid = createTrackIndex();
    const parts = [];
    let current = [];
    const flush = () => {
      if (current.length >= 2) parts.push(current);
      current = [];
    };

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
      previousLastCoordinate = decoded[decoded.length - 1];

      if (current.length) dropStationRepeat(current, decoded);

      let coordinates = decoded;
      const head = retracedHeadIndex(decoded, laid);
      if (head > 0) {
        const tail = decoded.slice(head);
        if (pathLength(tail) < RETRACE_MIN_TAIL_METERS) {
          // Nothing new at all — the interval is pure duplicate track. Skip it
          // entirely; the next interval opens a fresh part at its own station.
          flush();
          laid.add(decoded);
          return;
        }
        const divergence = decoded[head];
        const inCurrent = current.length
          ? nearestVertexIndex(current, divergence)
          : { index: -1, distance: Infinity };
        if (inCurrent.distance <= RETRACE_MATCH_METERS) {
          // The excursion we just drew hangs off THIS part at `divergence`.
          // Split there: the far side is the branch, the trunk resumes along
          // the fresh tail, and the branch is re-served from the station this
          // interval's tail runs to (its own lead-in, reversed).
          const excursion = current.slice(inCurrent.index);
          current = current.slice(0, inCurrent.index + 1);
          const leadIn = branchLeadIn(
            tail.slice().reverse(),
            tail.length - 1,
            stationPoints,
          );
          if (excursion.length >= 2) {
            const branch = leadIn
              ? leadIn.concat(excursion.slice(1))
              : excursion;
            if (branch.length >= 2) parts.push(branch);
          }
          // The cut vertex and the tail's first vertex are the same switch to
          // within the match radius; make them literally equal so the trunk
          // welds instead of jogging.
          current[current.length - 1] = [tail[0][0], tail[0][1]];
          coordinates = tail;
        } else {
          // The retrace lands on track from an already-closed part. Open a new
          // one at the divergence point — and lead it in along the retraced
          // head itself, which IS the trunk this branch leaves and is
          // guaranteed to reach a station (it starts at one).
          flush();
          const leadIn = branchLeadIn(decoded, head, stationPoints);
          coordinates = leadIn ? leadIn.concat(tail.slice(1)) : tail;
        }
      } else if (current.length && isReversalJoint(current, coordinates)) {
        // No shared track, but the line turns back on itself at the joint:
        // still a branch, and still must not be drawn as one stroke.
        flush();
      }

      if (!current.length) current = coordinates.map((c) => [c[0], c[1]]);
      else if (sameCoordinate(current[current.length - 1], coordinates[0]))
        current.push(...coordinates.slice(1).map((c) => [c[0], c[1]]));
      else current.push(...coordinates.map((c) => [c[0], c[1]]));
      laid.add(decoded);
    });
    flush();

    const groomed = parts
      .map((coordinates) => smoothMicroKinks(coordinates, limits))
      .filter((coordinates) => coordinates.length >= 2);
    return groomed.length ? groomed : [[stationPoints[0], stationPoints[0]]];
  }

  function medianSpacingMeters(compactLine) {
    const spacings = compactLine.segments
      .map((row) => Number(row[0]) * 1000)
      .filter((value) => value > 0)
      .sort((a, b) => a - b);
    if (!spacings.length) return 0;
    return spacings[Math.floor(spacings.length / 2)];
  }

  // Station-boundary vertex repeat.
  //
  // Where a station sits partway along a surveyed edge, the package ends the
  // arriving interval at the station anchor and starts the next one by
  // re-emitting the SAME neighbouring track vertex. Concatenated that reads
  // X, A, S, A, Y — the line runs to the platform, back out to A, then on. It
  // is only tens of metres, but it is a true 180° reversal, so it renders as a
  // thorn at (nearly) every station, it makes a ridden-route slice measure the
  // station twice, and it looks like a branch to any topology test.
  //
  // Only one of the two A's belongs. Keep whichever ordering is shorter —
  // that is by definition the one that does not double back. Detected
  // structurally (the identical vertex either side of the station), never by
  // distance, so a genuine stub track is left alone.
  function dropStationRepeat(current, next) {
    if (current.length < 3 || next.length < 3) return;
    const before = current[current.length - 3];
    const repeated = current[current.length - 2];
    const station = current[current.length - 1];
    const after = next[2];
    if (!sameCoordinate(repeated, next[1])) return;
    const keepFirst =
      distanceMeters(before, repeated) +
      distanceMeters(repeated, station) +
      distanceMeters(station, after);
    const keepSecond =
      distanceMeters(before, station) +
      distanceMeters(station, repeated) +
      distanceMeters(repeated, after);
    if (keepFirst <= keepSecond) next.splice(1, 1);
    else current.splice(current.length - 2, 1);
  }

  function isReversalJoint(current, next) {
    const joint = current[current.length - 1];
    if (!sameCoordinate(joint, next[0])) return false;
    const before = current[current.length - 2];
    const after = next[1];
    if (!before || !after) return false;
    // turnDegrees reports the deflection from straight-on; 180° is a full
    // about-face, so a reversal is a LARGE deflection.
    return turnDegrees(before, joint, after) >= 180 - REVERSAL_MAX_DEGREES;
  }

  // Retained for callers that want the historic single-stroke geometry.
  function continuousCoordinatesForLine(compactLine) {
    const parts = displayPartsForLine(compactLine);
    return parts.length === 1 ? parts[0] : parts.flat();
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

  // One metric per display PART. Parts are deliberately disjoint strokes (a
  // trunk and its branches), so measures never run across a junction and a
  // ridden-route slice can never leak from one railway onto another.
  function lineMetrics(line) {
    if (line._displayMetrics) return line._displayMetrics;
    const parts = line.parts || [line.geometry?.coordinates || []];
    const metrics = parts.map((coordinates) => {
      const cumulative = [0];
      for (let index = 1; index < coordinates.length; index += 1) {
        cumulative.push(
          cumulative[index - 1] +
            distanceMeters(coordinates[index - 1], coordinates[index]),
        );
      }
      return { coordinates, cumulative, length: cumulative.at(-1) || 0 };
    });
    Object.defineProperty(line, "_displayMetrics", {
      configurable: true,
      value: metrics,
    });
    return metrics;
  }

  function projectPointToPart(line, partIndex, point, projectionCache) {
    if (!point || point.length < 2) return null;
    const cacheKey = `${line.lineId}#${partIndex}|${Number(point[0]).toFixed(7)},${Number(point[1]).toFixed(7)}`;
    const cached = projectionCache?.get(cacheKey);
    if (cached) return cached;
    const metric = lineMetrics(line)[partIndex];
    if (!metric) return null;
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
          partIndex,
          measure: metric.cumulative[index] + segmentLength * ratio,
        };
      }
    }
    if (best && projectionCache) projectionCache.set(cacheKey, best);
    return best;
  }

  function projectPointToLine(line, point, projectionCache) {
    let best = null;
    const metrics = lineMetrics(line);
    for (let partIndex = 0; partIndex < metrics.length; partIndex += 1) {
      const candidate = projectPointToPart(
        line,
        partIndex,
        point,
        projectionCache,
      );
      if (candidate && (!best || candidate.distance < best.distance))
        best = candidate;
    }
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
    const metric = lineMetrics(line)[start.partIndex];
    if (!metric) return [];
    // A loop only wraps when the whole line is ONE closed part; a split line's
    // parts are open strokes even if the package marks the line as a loop.
    if (!line.isLoop || lineMetrics(line).length > 1) {
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

  // Distance from a platform anchor to its track that is still just the
  // station's own approach; beyond it, the projection is telling us something
  // is wrong with the data and should not be hidden.
  const ENDPOINT_SNAP_METERS = 260;

  function snapEndpoint(coordinates, index, rawPoint, projectedDistance) {
    if (!rawPoint || projectedDistance > ENDPOINT_SNAP_METERS) return;
    coordinates[index] = [rawPoint[0], rawPoint[1]];
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
  function canonicalizeRouteFeature(network, feature, options) {
    // A junction station sits on TWO display parts (a trunk and its branch),
    // both a perfect match for a hop that starts or ends there. Picking by
    // proximity alone can hand consecutive hops of one train different parts,
    // and the route then visibly breaks at the junction. `continueFrom` — the
    // previous hop's drawn endpoint — breaks that tie in favour of staying on
    // the rail the train is already on.
    const continueFrom = options && options.continueFrom;
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
        // Both endpoints must land on the SAME part. Parts are separate
        // railways (a trunk and its branch), so allowing one endpoint on each
        // is exactly the "train turns onto the wrong line" bug: the slice
        // would run from a branch, through the junction, onto other track.
        const partCount = lineMetrics(line).length;
        for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
          const start = projectPointToPart(
            line,
            partIndex,
            rawStart,
            network.routeProjectionCache,
          );
          const end = projectPointToPart(
            line,
            partIndex,
            rawEnd,
            network.routeProjectionCache,
          );
          if (!start || !end) continue;
          const fit = start.distance + end.distance;
          const seam = continueFrom
            ? distanceMeters(continueFrom, start.coordinate)
            : 0;
          const candidate = { line, start, end, fit, seam, score: fit + seam };
          if (!best || candidate.score < best.score) best = candidate;
        }
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
      // Finish ON the platform, not on the projection of it.
      //
      // A junction station belongs to two display parts, and the projection of
      // the same station onto each lands metres apart, so consecutive hops
      // routed over different parts left the drawn route visibly split open at
      // the junction. The solver's own endpoints ARE the station nodes and are
      // shared by both hops, so pinning the slice ends to them closes the seam
      // exactly. Only over the short bridge from platform to track — a distant
      // projection is a data problem and must stay visible, not be papered over
      // with a long straight chord.
      snapEndpoint(canonical, 0, rawStart, best.start.distance);
      snapEndpoint(canonical, canonical.length - 1, rawEnd, best.end.distance);
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

      // A line that carries branches renders as several disjoint strokes: they
      // meet at a station so the map still reads continuous, but nothing can
      // draw or slice straight through the junction (see displayPartsForLine).
      const lineParts = displayPartsForLine(compactLine);
      const lineGeometry =
        lineParts.length === 1
          ? { type: "LineString", coordinates: lineParts[0] }
          : { type: "MultiLineString", coordinates: lineParts };
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
          partCount: lineParts.length,
          visibilityKm,
        },
      });
      lineById.get(lineId).geometry = lineGeometry;
      lineById.get(lineId).parts = lineParts;
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
    displayPartsForLine,
    canonicalizeRouteFeature,
    smoothMicroKinks,
    stationMinZoomForLine,
  });
});
