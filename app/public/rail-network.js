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
  // A corner no railway turns. The standing topology audit reports 110° or
  // more carried by 60 m of track either side
  // (scripts/validation/validate-railway-topology.mjs, SHARP_TURN_DEGREES /
  // SHARP_TURN_RUN_METERS); nothing in here may WELD one, or the drawn network
  // reports a defect the survey does not have.
  const SHARP_TURN_DEGREES = 110;
  // Turns across a joint are read over a RUN of track rather than off the two
  // adjoining edges, for the same reason the audit reads them that way: both
  // sides are surveyed geometry, where consecutive vertices can be a metre
  // apart and say nothing about which way the rail runs.
  const TURN_RUN_METERS = 60;
  // How far off a terminal's own outbound heading a platform may sit and still
  // count as lying BEYOND the end of the track rather than beside it. Under
  // 45° the offset is mostly along the rail; over it, mostly across.
  const ANCHOR_OFF_AXIS_DEGREES = 45;

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
  // Shared track has to be groomed ONCE, not once per stroke that draws it.
  // A branch's lead-in is a literal copy of the trunk's vertices, so if the
  // groomer drops a kink from one copy and keeps it in the other, the two
  // strokes stop being coincident and the shared metres render as a pair of
  // lines a few metres apart. Any vertex that appears in more than one stroke
  // of the same line is therefore protected from grooming: whatever survives,
  // survives in both.
  function coordinateKey(coordinate) {
    return `${coordinate[0]},${coordinate[1]}`;
  }

  function sharedVertexKeys(parts) {
    const seen = new Map();
    for (const coordinates of parts) {
      const own = new Set();
      for (const coordinate of coordinates) own.add(coordinateKey(coordinate));
      for (const key of own) seen.set(key, (seen.get(key) || 0) + 1);
    }
    const shared = new Set();
    for (const [key, count] of seen) if (count > 1) shared.add(key);
    return shared;
  }

  function smoothMicroKinks(coordinates, limits, protectedKeys) {
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
          !protectedKeys?.has(coordinateKey(corner)) &&
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

  // Where `point` sits on an already-drawn stroke.
  //
  // This has to measure to the TRACK, not to its vertices. N02 digitises long
  // easements with vertices hundreds of metres apart, so a switch that lies
  // exactly on the drawn centre-line can still be 90 m from the nearest
  // vertex. Testing vertices made those junctions look like they belonged to
  // some other stroke, and the trunk was cut in two at the junction (阪和線
  // split at 鳳, 東北線 at 日暮里) instead of carrying straight on.
  function nearestVertexIndex(coordinates, point) {
    let bestIndex = -1;
    let best = Infinity;
    for (let index = 0; index < coordinates.length - 1; index += 1) {
      const distance = pointSegmentDistanceMeters(
        point,
        coordinates[index],
        coordinates[index + 1],
      );
      if (distance >= best) continue;
      best = distance;
      // Cut at whichever end of the matched edge the point is nearer, so the
      // trunk keeps every vertex up to the switch and the branch keeps the
      // rest.
      bestIndex =
        distanceMeters(point, coordinates[index]) <=
        distanceMeters(point, coordinates[index + 1])
          ? index
          : index + 1;
    }
    if (coordinates.length === 1) {
      best = distanceMeters(coordinates[0], point);
      bestIndex = 0;
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

  // ─────────────────── station approach (render anchoring) ──────────────────
  //
  // A drawn railway must run THROUGH the centre of every station circle it
  // calls at, and a terminal stroke must END on that centre — with no elbow in
  // the last few hundred metres, no lateral connector, and no hairpin.
  //
  // The package cannot deliver that on its own, and the reason is worth
  // stating because it looks like a renderer bug and is not. A package station
  // anchor is the OFFICIAL station point — an N02 polygon centroid, an OSM
  // station node — and the package builders make every interval begin and end
  // on it by OVERWRITING the track vertex nearest the platform with it
  // (rebuild-japan-package-geometry.py weld_line_intervals). Wherever that
  // official point sits off the surveyed centre-line — routinely tens of
  // metres, a few hundred at a large terminal — the overwrite IS the artefact:
  // the interval's last edge abandons the alignment and stabs sideways at the
  // anchor, so the line reaches its dot around a corner no railway has.
  //
  // Replacing one vertex can only ever produce that corner, so this pass
  // rebuilds the approach from the track the overwrite hid:
  //
  //   1. lift the anchor out and read the surveyed alignment straight through
  //      the platform — the tail of the arriving interval joined to the head of
  //      the departing one, which between them still hold every vertex the
  //      overwrite did not touch;
  //   2. find where that alignment actually passes the platform (the nearest
  //      point on it) and CUT it there, so the two intervals meet at the
  //      station's true chainage rather than wherever the package split them;
  //   3. slide the two ends of the cut sideways onto the anchor, by a
  //      displacement that fades in across an approach window.
  //
  // Reading BOTH sides is what makes step 2 trustworthy, and it is the whole
  // difference between a fix and a new defect. From one side the deleted vertex
  // can only be guessed by extrapolating a heading, and on a curve that guess
  // is metres out — which would invent a displacement, and a correction, at the
  // ~95% of platforms that are already exactly on their track (every station in
  // Macao and Hong Kong, all but a handful in Taiwan). With the neighbour on
  // each side the nearest point is measured, not guessed, so those platforms
  // measure zero and this pass leaves their geometry untouched to the vertex.
  //
  // The fade is a smoothstep, whose slope is ZERO at both ends, and that is
  // what makes a real correction invisible. It begins without a corner where it
  // meets untouched track, and it arrives at the anchor along the alignment's
  // OWN heading — so a station the line passes through keeps the tangent it had
  // (both sides blend independently and still agree there), and a terminal ends
  // pointing the way it was going. The steepest point of the blend is 1.5·d/L,
  // a few degrees for any displacement with room for its window.
  //
  // What is NOT touched: the package, the station coordinate, the routing
  // graph, the marker position. The topology anchor and the render anchor are
  // the same point BECAUSE the drawn line is brought to it, never the reverse.
  //
  // Even at zero displacement step 2 earns its place. The package cuts the two
  // intervals at the vertex it overwrote, which is not where the platform is,
  // so vertices belonging ahead of the station arrive behind it and the drawn
  // line doubles back over itself to reach the dot. Cutting at the measured
  // chainage puts every vertex on the side it belongs to, and that alone
  // straightens a large share of the corners.
  const ANCHOR_ON_TRACK_METERS = 1;
  // Past this the platform is not off its track, the DATA is wrong — the wrong
  // line matched, the wrong endpoint, a station that belongs to a neighbouring
  // group. Bending a railway that far would hide the fault under a graceful
  // curve, so the approach is left exactly as the package drew it and
  // scripts/validation/validate-station-render-anchoring.mjs reports it for correction.
  // The characterised packages peak at 159 m (東海道線/大阪), so nothing today
  // reaches this; it exists so a future bad row cannot silently bend a trunk.
  const ANCHOR_MAX_DISPLACEMENT_METERS = 250;
  // Metres of approach per metre of sideways correction.
  const ANCHOR_WINDOW_RATIO = 12;
  const ANCHOR_MIN_WINDOW_METERS = 180;
  const ANCHOR_MAX_WINDOW_METERS = 2400;
  // Neither the search for the platform nor one end's blend may spend more
  // than this share of an interval, so nothing here can ever reach past a
  // NEIGHBOURING station and rewrite its approach instead.
  const ANCHOR_MAX_INTERVAL_SHARE = 0.45;
  // The blend has to be carried by a RUN of vertices. N02 can leave a single
  // kilometre-long edge across the whole window, and a displacement applied to
  // its two ends alone is the very corner this pass exists to remove.
  const ANCHOR_STEP_METERS = 20;
  // How far either side of the package's own cut the platform is looked for.
  const ANCHOR_REACH_METERS = 700;
  // An edge this short is a seam, not a shape. The cut can land within a metre
  // of a surveyed vertex, and keeping both leaves a stub edge whose direction
  // is meaningless — invisible at any zoom, but it is still a corner, and the
  // audit that has to trust the corner count should not have to explain it.
  const ANCHOR_SEAM_METERS = 3;
  // Branch splitting can cut at a switch a few metres from an already-seated
  // platform and leave the exact anchor behind on the discarded overlap.  The
  // approach is still the same surveyed stroke, so restore that vertex in the
  // nearest edge after grooming.  This deliberately stays tiny: a larger gap
  // is a source-data fault and must remain visible to the anchoring audit.
  const LOST_ANCHOR_MAX_METERS = 5;

  function smoothstep(ratio) {
    const t = ratio <= 0 ? 0 : ratio >= 1 ? 1 : ratio;
    return t * t * (3 - 2 * t);
  }

  // The vertices within `reachMeters` of one end of an interval — the only
  // part of it a station approach may read or rewrite.
  function reachIndexFromEnd(coordinates, atEnd, reachMeters) {
    let travelled = 0;
    if (atEnd) {
      for (let index = coordinates.length - 1; index > 0; index -= 1) {
        travelled += distanceMeters(coordinates[index], coordinates[index - 1]);
        if (travelled >= reachMeters) return index - 1;
      }
      return 0;
    }
    for (let index = 0; index < coordinates.length - 1; index += 1) {
      travelled += distanceMeters(coordinates[index], coordinates[index + 1]);
      if (travelled >= reachMeters) return index + 1;
    }
    return coordinates.length - 1;
  }

  // The point on `path` nearest the platform, as a cut: which edge it lands on
  // and where along it.
  function nearestCutOnPath(path, anchor) {
    const latitude = anchor[1];
    const target = localMetric(anchor, latitude);
    let best = null;
    for (let index = 0; index < path.length - 1; index += 1) {
      const a = localMetric(path[index], latitude);
      const b = localMetric(path[index + 1], latitude);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      const ratio = lengthSquared
        ? Math.max(
            0,
            Math.min(
              1,
              ((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) /
                lengthSquared,
            ),
          )
        : 0;
      const point = [
        path[index][0] + (path[index + 1][0] - path[index][0]) * ratio,
        path[index][1] + (path[index + 1][1] - path[index][1]) * ratio,
      ];
      const distance = distanceMeters(anchor, point);
      if (!best || distance < best.distance)
        best = { index, ratio, point, distance };
    }
    return best;
  }

  function pathBeforeCut(path, cut) {
    const kept = path.slice(0, cut.index + 1);
    if (!sameCoordinate(kept[kept.length - 1], cut.point)) kept.push(cut.point);
    return kept;
  }

  function pathAfterCut(path, cut) {
    const kept = path.slice(cut.index + 1);
    if (!sameCoordinate(kept[0], cut.point)) kept.unshift(cut.point);
    return kept;
  }

  // Slide the last `windowMeters` of the alignment onto the anchor.
  function warpTipToAnchor(coordinates, anchor, windowMeters) {
    const tip = coordinates[coordinates.length - 1];
    const shift = [anchor[0] - tip[0], anchor[1] - tip[1]];
    const cumulative = [0];
    for (let index = 1; index < coordinates.length; index += 1)
      cumulative.push(
        cumulative[index - 1] +
          distanceMeters(coordinates[index - 1], coordinates[index]),
      );
    const total = cumulative[cumulative.length - 1];
    const window = Math.min(windowMeters, total);
    if (!(window > 0)) {
      const pinned = coordinates.slice(0, -1);
      pinned.push([anchor[0], anchor[1]]);
      return pinned;
    }
    const start = total - window;
    const output = [];
    const push = (point) => {
      if (!sameCoordinate(output[output.length - 1], point)) output.push(point);
    };
    const measures = [];
    for (let index = 0; index < coordinates.length; index += 1) {
      if (cumulative[index] < start) push(coordinates[index]);
      else measures.push(cumulative[index]);
    }
    measures.push(start);
    const steps = Math.max(1, Math.ceil(window / ANCHOR_STEP_METERS));
    for (let step = 1; step < steps; step += 1)
      measures.push(start + (window * step) / steps);
    measures.sort((left, right) => left - right);
    for (const measure of measures) {
      const point = interpolateAt(coordinates, cumulative, measure).point;
      const weight = smoothstep((measure - start) / window);
      push([point[0] + shift[0] * weight, point[1] + shift[1] * weight]);
    }
    // Exactly, not nearly: the anchor has to be the very coordinate the marker
    // is drawn at, so the two can be compared by identity downstream.
    output[output.length - 1] = [anchor[0], anchor[1]];
    return output.length >= 2 ? output : coordinates;
  }

  function anchorWindowMeters(displacement, budgetMeters) {
    return Math.min(
      Math.max(displacement * ANCHOR_WINDOW_RATIO, ANCHOR_MIN_WINDOW_METERS),
      ANCHOR_MAX_WINDOW_METERS,
      Math.max(budgetMeters, ANCHOR_STEP_METERS),
    );
  }

  // Bring the approach on one side of a platform onto the anchor. `approach`
  // runs towards the station and ends on the cut; the returned run ends on the
  // anchor itself.
  function anchorApproach(approach, anchor, displacement, budgetMeters) {
    if (approach.length < 2) return null;
    const built =
      displacement <= ANCHOR_ON_TRACK_METERS
        ? // The alignment already passes through the platform: seat the anchor
          // at the cut and reshape nothing.
          approach.slice(0, -1)
        : warpTipToAnchor(
            approach,
            anchor,
            anchorWindowMeters(displacement, budgetMeters),
          ).slice(0, -1);
    while (
      built.length > 1 &&
      distanceMeters(built[built.length - 1], anchor) <= ANCHOR_SEAM_METERS
    )
      built.pop();
    built.push([anchor[0], anchor[1]]);
    return built.length >= 2 ? built : null;
  }

  // The vertex `span` metres along `coordinates` from `from` in direction
  // `step`, or the last one reached if the stroke ends first.
  function windowedPoint(coordinates, from, step, span) {
    let travelled = 0;
    let last = null;
    for (
      let index = from + step;
      index >= 0 && index < coordinates.length;
      index += step
    ) {
      travelled += distanceMeters(coordinates[index - step], coordinates[index]);
      last = coordinates[index];
      if (travelled >= span) break;
    }
    return last;
  }

  // The corner the trunk would have to turn at `index` to pick `tail` up.
  function spliceTurnDegrees(current, index, tail) {
    const before = windowedPoint(current, index, -1, TURN_RUN_METERS);
    const after = windowedPoint(tail, 0, +1, TURN_RUN_METERS);
    if (!before || !after) return 0;
    return turnDegrees(before, current[index], after);
  }

  // Do the two intervals meeting at this platform SHARE their track out of it?
  //
  // A branch only joins its trunk AT A STATION, so the rail between platform
  // and switch is run over twice — once arriving, once leaving. Joined
  // head-to-tail the pair then FOLDS back on itself instead of running
  // through, and the nearest point on a fold is its own apex: the last
  // surveyed vertex before the about-face. That distance is the LONGITUDINAL
  // gap up to the platform, and reading it as a sideways displacement is how
  // 成田 came to be drawn 93 m off its own survey — the 我孫子支線 leaves over
  // the 600 m of rail the 佐原 main line arrives on, so the fold apex measured
  // 205 m, and 205 m blended across the full 2.4 km window swung the main line
  // clear of the basemap track that the 空港支線, drawn from the very same
  // coordinates, still sat on.
  //
  // This is the two-sided form of the terminal rule below, and it rests on the
  // same argument: the platform lies beyond the alignment either side can
  // read, and the package's own final edge is better evidence than a heading
  // extrapolated around a reversal. So the approach is left exactly as drawn.
  function foldedAtPlatform(head, tail, cut) {
    if (head.length < 2 || !tail.length) return false;
    const seam = head[head.length - 1];
    // Anywhere but the apex and the pair is not folding here: the platform sat
    // on track one side or the other genuinely runs through.
    if (distanceMeters(cut.point, seam) > ANCHOR_SEAM_METERS) return false;
    const before = windowedPoint(head, head.length - 1, -1, TURN_RUN_METERS);
    const after =
      tail.length >= 2
        ? windowedPoint(tail, 0, +1, TURN_RUN_METERS)
        : tail[0];
    if (!before || !after) return false;
    return turnDegrees(before, seam, after) >= 180 - REVERSAL_MAX_DEGREES;
  }

  // Does this platform lie PAST the end of the track its line surveyed?
  //
  // Asking it structurally — is the nearest point on the path its own last
  // vertex — is exact when the platform sits straight off the end and blind the
  // moment anything at all lies in between. At 亀山 the 紀勢線 approach carries
  // 5-7 m of surveyed jitter before its final vertex, so the nearest point
  // landed mid-edge and the platform 171 m beyond the end read as a sideways
  // displacement: the line was rebuilt through 800 m of approach and drawn up
  // to 78 m off its own survey. The two 関西線 platforms are the same
  // coordinate on the same track, and they tripped the structural test and were
  // left alone. One station, one geometry, opposite verdicts.
  //
  // So ask the rail instead. From the last surveyed vertex, along the heading
  // its final run of track is on, is the platform AHEAD? Within 45° of that
  // heading the gap up to it is LONGITUDINAL — there is no rail between the two
  // to be off — and the package's own final edge is the only evidence of where
  // the track goes, which is the same argument the terminal rule below rests
  // on. Past 45° the platform is BESIDE the line rather than beyond it, which
  // is a displacement and is rebuilt as one (東武日光's dot on JR日光駅's
  // platform read 93°).
  function beyondSurveyedEnd(coordinates, anchor, atStart) {
    const endIndex = atStart ? 0 : coordinates.length - 1;
    const end = coordinates[endIndex];
    const back = windowedPoint(
      coordinates,
      endIndex,
      atStart ? +1 : -1,
      TURN_RUN_METERS,
    );
    if (!back) return false;
    return turnDegrees(back, end, anchor) < ANCHOR_OFF_AXIS_DEGREES;
  }

  // Rebuild the drawn approach on both sides of ONE platform.
  //
  // `incoming` arrives at the station and `outgoing` leaves it; either is null
  // at the two ends of an open line, where the platform is a terminal and the
  // stroke simply stops on it.
  function anchorStationApproach(incoming, outgoing, anchor, budgets) {
    const head = incoming ? incoming.slice(0, -1) : [];
    // Where the departing interval's own vertices begin. The package re-emits
    // the vertex next to a platform on BOTH sides of it; read once, or the
    // alignment appears to double back across the station.
    let tailStart = outgoing ? 1 : 0;
    if (
      outgoing &&
      head.length &&
      outgoing.length > 1 &&
      sameCoordinate(head[head.length - 1], outgoing[1])
    )
      tailStart = 2;
    const tail = outgoing ? outgoing.slice(tailStart) : [];
    const headFrom = head.length
      ? reachIndexFromEnd(head, true, budgets.incomingReach)
      : 0;
    const tailTo = tail.length
      ? reachIndexFromEnd(tail, false, budgets.outgoingReach)
      : -1;
    const path = head.slice(headFrom).concat(tail.slice(0, tailTo + 1));
    if (path.length < 2) return null;

    const cut = nearestCutOnPath(path, anchor);
    if (!cut) return null;
    if (foldedAtPlatform(head.slice(headFrom), tail.slice(0, tailTo + 1), cut))
      return null;
    // A cut AT the far end of what we can read means the platform lies beyond
    // the last surveyed vertex the line has — which only a terminal can do,
    // and which leaves nothing to measure it against. The package's own final
    // edge is then the only evidence of where the track runs, and it is
    // better evidence than an extrapolated heading: the two are the same on
    // straight track, and where they differ it is because the alignment is on
    // a curve, which is exactly where extrapolating is wrong. So the approach
    // is left as drawn, and only a platform the track OVERSHOOTS — the drive
    // past the buffer and back that ends 90 Japanese strokes — is rebuilt.
    if (
      !outgoing &&
      ((cut.index === path.length - 2 && cut.ratio >= 1) ||
        beyondSurveyedEnd(path, anchor, false))
    )
      return null;
    if (
      !incoming &&
      ((cut.index === 0 && cut.ratio <= 0) ||
        beyondSurveyedEnd(path, anchor, true))
    )
      return null;

    if (cut.distance > ANCHOR_MAX_DISPLACEMENT_METERS) return null;

    const result = { displacement: cut.distance };
    if (incoming) {
      const approach = anchorApproach(
        pathBeforeCut(path, cut),
        anchor,
        cut.distance,
        budgets.incomingWindow,
      );
      if (!approach) return null;
      result.incoming = incoming.slice(0, headFrom).concat(approach);
    }
    if (outgoing) {
      const departure = anchorApproach(
        pathAfterCut(path, cut).reverse(),
        anchor,
        cut.distance,
        budgets.outgoingWindow,
      );
      if (!departure) return null;
      result.outgoing = departure
        .reverse()
        .concat(outgoing.slice(tailStart + tailTo + 1));
    }
    return result;
  }

  // Every interval runs platform to platform, so every station is an approach
  // from one or both sides. Reach and window are capped at a share of each
  // interval, so one station's rebuild can never run into its neighbour's.
  function anchorIntervalsToStations(intervals, compactLine) {
    const stationCount = compactLine.stations.length;
    if (!intervals.length) return intervals;
    const shares = intervals.map(
      (coordinates) => pathLength(coordinates) * ANCHOR_MAX_INTERVAL_SHARE,
    );
    // A closed line has one interval per station, so its first platform is
    // approached from the last interval rather than from nothing.
    const closed = intervals.length >= stationCount;
    for (let station = 0; station < stationCount; station += 1) {
      const incomingIndex =
        station > 0 ? station - 1 : closed ? intervals.length - 1 : -1;
      const outgoingIndex = station < intervals.length ? station : -1;
      const incoming = incomingIndex >= 0 ? intervals[incomingIndex] : null;
      const outgoing = outgoingIndex >= 0 ? intervals[outgoingIndex] : null;
      if (!incoming && !outgoing) continue;
      if ((incoming && incoming.length < 2) || (outgoing && outgoing.length < 2))
        continue;
      const row = compactLine.stations[station];
      const rebuilt = anchorStationApproach(
        incoming,
        outgoing,
        [row[2], row[3]],
        {
          incomingReach: Math.min(
            ANCHOR_REACH_METERS,
            incomingIndex >= 0 ? shares[incomingIndex] : 0,
          ),
          outgoingReach: Math.min(
            ANCHOR_REACH_METERS,
            outgoingIndex >= 0 ? shares[outgoingIndex] : 0,
          ),
          incomingWindow: incomingIndex >= 0 ? shares[incomingIndex] : 0,
          outgoingWindow: outgoingIndex >= 0 ? shares[outgoingIndex] : 0,
        },
      );
      if (!rebuilt) continue;
      if (rebuilt.incoming && rebuilt.incoming.length >= 2)
        intervals[incomingIndex] = rebuilt.incoming;
      if (rebuilt.outgoing && rebuilt.outgoing.length >= 2)
        intervals[outgoingIndex] = rebuilt.outgoing;
    }
    return intervals;
  }

  // Vertices the grooming may not trim past or smooth away: every platform
  // anchor, plus any end of track the line deliberately runs into and reverses
  // at (`reversalTails`, e.g. the 阿里山 zigzag). A reversal tail and a
  // station-throat artefact are the same shape — out and straight back — so
  // the stroke-end fold guard cannot tell them apart by geometry and would eat
  // the real one. Only the package knows which is which, so it says so.
  function stationAnchorKeys(compactLine) {
    const keys = new Set();
    for (const row of compactLine.stations)
      keys.add(coordinateKey([row[2], row[3]]));
    for (const point of compactLine.reversalTails || [])
      keys.add(coordinateKey(point));
    return keys;
  }

  function restoreLostStationAnchors(parts, stationPoints) {
    const present = new Set();
    for (const coordinates of parts)
      for (const point of coordinates) present.add(coordinateKey(point));

    for (const anchor of stationPoints) {
      const key = coordinateKey(anchor);
      if (present.has(key)) continue;
      let best = null;
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const cut = nearestCutOnPath(parts[partIndex], anchor);
        if (!cut || (best && cut.distance >= best.cut.distance)) continue;
        best = { partIndex, cut };
      }
      if (!best || best.cut.distance > LOST_ANCHOR_MAX_METERS) continue;
      const coordinates = parts[best.partIndex];
      coordinates.splice(best.cut.index + 1, 0, [anchor[0], anchor[1]]);
      present.add(key);
    }
    return parts;
  }

  // Decode every interval and weld both of its ends to the authoritative
  // station anchor. The weld is what anchorIntervalsToStations then turns into
  // a real approach; on its own it is only a promise that the interval chain
  // is seam-free.
  function decodeIntervals(compactLine) {
    const stationCount = compactLine.stations.length;
    const intervals = [];
    let previousLastCoordinate = null;
    compactLine.segments.forEach((row, index) => {
      const decoded = row[1]
        ? [previousLastCoordinate].concat(
            row[2].map((coordinate) => [coordinate[0], coordinate[1]]),
          )
        : row[2].map((coordinate) => [coordinate[0], coordinate[1]]);
      const startStation = compactLine.stations[index];
      const endStation = compactLine.stations[(index + 1) % stationCount];
      decoded[0] = [startStation[2], startStation[3]];
      decoded[decoded.length - 1] = [endStation[2], endStation[3]];
      previousLastCoordinate = decoded[decoded.length - 1];
      intervals.push(decoded);
    });
    return intervals;
  }

  // The compact package stores station intervals for routing and attribution,
  // but MapLibre should receive complete display geometry per line, not one
  // feature per station interval. Decode every interval, bring both ends onto
  // the authoritative station anchor, weld the shared boundary once, then
  // groom kinks at the line's own scale.
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
    const anchorKeys = stationAnchorKeys(compactLine);
    const laid = createTrackIndex();
    const parts = [];
    let current = [];
    const flush = () => {
      if (current.length >= 2) parts.push(current);
      current = [];
    };

    // Station approaches are rebuilt on the interval chain, BEFORE any of the
    // branch machinery below runs, so a branch lead-in copied off a trunk
    // copies the finished geometry and the two strokes stay coincident to the
    // vertex over the metres they share.
    const intervals = anchorIntervalsToStations(
      decodeIntervals(compactLine),
      compactLine,
    );

    intervals.forEach((decoded) => {
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
        if (
          inCurrent.distance <= RETRACE_MATCH_METERS &&
          spliceTurnDegrees(current, inCurrent.index, tail) >= SHARP_TURN_DEGREES
        ) {
          // The tail leaves the divergence back along the way the trunk came
          // in, so there is no trunk to carry on with: the station this
          // interval STARTS at is a reversal, and the two legs merely share
          // the rail between its platform and the switch. Splitting here would
          // weld a hairpin into open track short of the platform — 成田 at the
          // 我孫子支線 switch, 会津若松 a kilometre out — and leave the station
          // on the branch stroke alone. Close the stroke instead, the same
          // shape isReversalJoint draws where the two legs share no track at
          // all, and let this interval open its own part at the station, head
          // included, so both legs reach the platform.
          flush();
        } else if (inCurrent.distance <= RETRACE_MATCH_METERS) {
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
          //
          // Unless the cut vertex is a PLATFORM ANCHOR, which happens whenever
          // the branch leaves from a station rather than from open track — the
          // whole open part being the anchor alone is only its commonest shape
          // (阪和線 opens a part at 鳳 to reach 東羽衣). Overwriting an anchor
          // would cut the trunk loose ~40 m short of the station AND take the
          // station off the line it calls at. Append instead, so the
          // continuation still reads station → switch → onward.
          if (
            current.length >= 2 &&
            !anchorKeys.has(coordinateKey(current[current.length - 1]))
          )
            current[current.length - 1] = [tail[0][0], tail[0][1]];
          else if (!sameCoordinate(current[current.length - 1], tail[0]))
            current.push([tail[0][0], tail[0][1]]);
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

    // Trim on both sides of grooming. Before, because a fold hides real
    // corners from the groomer; after, because dropping a barb can expose a
    // smaller fold that was not one while the extra vertices were there.
    //
    // Neither pass may touch a platform anchor. Grooming a station out of the
    // line, or trimming a stroke back past one, puts the marker off the rail
    // it calls at — which is the very defect the approach pass exists to
    // remove, reintroduced two steps later.
    const trimmed = parts.map((coordinates) =>
      trimFoldedEnds(coordinates, anchorKeys),
    );
    const protectedKeys = sharedVertexKeys(trimmed);
    for (const key of anchorKeys) protectedKeys.add(key);
    const groomed = trimmed
      .map((coordinates) =>
        trimFoldedEnds(
          smoothMicroKinks(coordinates, limits, protectedKeys),
          anchorKeys,
        ),
      )
      .filter((coordinates) => coordinates.length >= 2);
    const chain = groomed.length
      ? restoreLostStationAnchors(groomed, stationPoints)
      : [[stationPoints[0], stationPoints[0]]];
    return chain.concat(extraSegmentParts(compactLine, stationPoints, limits));
  }

  // Track a line runs on that its station ORDER cannot carry.
  //
  // compact-v1 stores a line as distinct stations in order, and segment i runs
  // station i to station i+1. A line whose two directions are not mirror images
  // — Light Rail 505 takes different streets each way, 751 serves 安定 one way
  // only — has real edges that no such order puts next to each other. Dropping
  // them silently is `network_union_missing_branch_edge`: the drawn network
  // would be missing track the operator runs.
  //
  // Each entry names its two stations by index and MAY carry its own geometry.
  // One without geometry is recorded, not drawn: where the archived alignment
  // holds a single centre-line for both directions, cutting a stroke from it
  // would lay a second line exactly over the first and assert shared track that
  // the survey says is not shared. The edge is known, the geometry is a
  // documented gap, and supplying it later needs no change here.
  //
  // Each is its own part, so it joins the chain visually at the station anchors
  // it names while nothing can slice or smooth through the junction — the same
  // contract every branch stroke already has.
  function extraSegmentParts(compactLine, stationPoints, limits) {
    const rows = compactLine.extraSegments;
    if (!Array.isArray(rows) || !rows.length) return [];
    const parts = [];
    for (const row of rows) {
      if (!row || !Array.isArray(row.geometry) || row.geometry.length < 2) continue;
      const from = stationPoints[row.from];
      const to = stationPoints[row.to];
      if (!from || !to) continue;
      const coordinates = row.geometry.map((point) => [point[0], point[1]]);
      // Both ends onto the authoritative station anchors, exactly as
      // decodeIntervals does for the chain, so the two meet to the vertex.
      coordinates[0] = [from[0], from[1]];
      coordinates[coordinates.length - 1] = [to[0], to[1]];
      const anchors = new Set([coordinateKey(from), coordinateKey(to)]);
      const groomed = smoothMicroKinks(coordinates, limits, anchors);
      if (groomed.length >= 2) parts.push(groomed);
    }
    return parts;
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

  // ── stroke-end fold ──
  // A stroke must never OPEN by running out and folding straight back over
  // itself. Two things produce that spur, and both are artefacts:
  //
  //   * the station-boundary vertex repeat, when the repeat falls on the first
  //     interval of a new part. dropStationRepeat only sees it mid-part, so a
  //     part that opens at such a station starts with a 180° thorn
  //     (五能線 at 東八森, 常磐新線 at 青井 — 50–90 m out and straight back).
  //   * a lead-in that walked back PAST its connection station before the
  //     branch turned round, leaving a spur beyond the platform that the line
  //     immediately retraces (阪和線 north of 鳳, ~180 m out and back).
  //
  // Both read the same way: a short excursion whose end is still at the
  // station but which cost several times its own chord to walk. Re-open the
  // stroke at the far end of that excursion. The anchor vertex itself is kept,
  // so a part still begins exactly on its platform.
  const FOLD_MAX_METERS = 1200;
  const FOLD_RETURN_METERS = 160;
  const FOLD_RATIO = 2.5;
  // Never eat a real balloon loop or a line short enough that the "excursion"
  // is most of it.
  const FOLD_MAX_SHARE = 0.2;

  function foldedHeadIndex(coordinates, totalMeters, anchorKeys) {
    const budget = Math.min(FOLD_MAX_METERS, totalMeters * FOLD_MAX_SHARE);
    let travelled = 0;
    let folded = 0;
    for (let index = 1; index < coordinates.length; index += 1) {
      // A platform anchor ends the search: whatever lies beyond it is another
      // station's track and may not be trimmed away with the spur.
      if (anchorKeys?.has(coordinateKey(coordinates[index]))) break;
      travelled += distanceMeters(coordinates[index - 1], coordinates[index]);
      if (travelled > budget) break;
      const chord = distanceMeters(coordinates[0], coordinates[index]);
      if (chord <= FOLD_RETURN_METERS && travelled >= FOLD_RATIO * Math.max(chord, 1))
        folded = index;
    }
    return folded;
  }

  function trimFoldedEnds(coordinates, anchorKeys) {
    const total = pathLength(coordinates);
    let output = coordinates;
    const head = foldedHeadIndex(output, total, anchorKeys);
    if (head > 0) output = [output[0]].concat(output.slice(head));
    const reversed = output.slice().reverse();
    const tail = foldedHeadIndex(reversed, total, anchorKeys);
    if (tail > 0)
      output = reversed
        .slice(tail)
        .reverse()
        .concat([reversed[0]]);
    return output.length >= 2 ? output : coordinates;
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

  // The slice, plus WHICH WAY it runs along the stroke.
  //
  // The direction is reported rather than re-derived by whoever needs it. It
  // cannot be read back off the finished coordinates: on a closed line a ride
  // through the seam starts at measure 0 and continues at the far end of the
  // stroke, where the vertex "behind" the start and the vertex "ahead" of it
  // are the same place and no geometric test can separate them. Only the
  // branch that built the slice knows, so only it may say.
  // Enough to settle a tie between two bores of one railway, far too little to
  // pull a ride onto an unrelated line: a wrong-line candidate is out by
  // hundreds of metres, and the endpoint gate above refuses anything past 1.5 km.
  const ALIGNMENT_MATCH_BONUS = 25;

  function canonicalLineSlice(line, start, end, rawCoordinates) {
    const metric = lineMetrics(line)[start.partIndex];
    if (!metric) return { coordinates: [], backward: false };
    // A loop only wraps when the whole line is ONE closed part; a split line's
    // parts are open strokes even if the package marks the line as a loop.
    if (!line.isLoop || lineMetrics(line).length > 1) {
      if (start.measure <= end.measure)
        return {
          coordinates: sliceForward(metric, start, end, false),
          backward: false,
        };
      return {
        coordinates: sliceForward(metric, end, start, false).reverse(),
        backward: true,
      };
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
      ? { coordinates: forward, backward: false }
      : { coordinates: backward, backward: true };
  }

  // ───────────────────────── current service status ─────────────────────────
  // The package's `serviceSpans` rows are [firstStation, lastStation, code]
  // over the line's OWN `stations` array — station ordinals, never metres.
  // `structure` measures in metres of the N02 walk, which is a different ruler
  // from the display geometry (anchoring, branch cutting, fold trimming and
  // kink smoothing all move it), and that is exactly why nothing here reads
  // it. A station ordinal survives every one of those passes because the
  // stations are what those passes anchor TO.
  const SERVICE_STATUS_CODES = Object.freeze({
    1: "service_suspended",
    2: "substitute_bus",
    3: "no_passenger_train",
    4: "all_trains_pass",
  });
  // Which codes mean NO PASSENGER TRAIN RUNS ON THIS TRACK, i.e. which ones
  // the map draws as a broken line. `all_trains_pass` (4) is deliberately not
  // among them: on 陸羽西線 the trains run and the track is ordinary railway —
  // two STATIONS are passed without stopping. That is a fact about a station,
  // and drawing the rail between them broken would state something false.
  const SUSPENDED_SERVICE_CODES = new Set([1, 2, 3]);
  // Below this a complement piece is rounding noise at a cut, not railway.
  const SERVICE_CUT_EPSILON_METERS = 0.5;
  // Two stroke ends this close are the same place — the joint a line's drawn
  // parts break at. Further apart they are two separate stretches of railway
  // and nothing may be painted between them.
  const SERVICE_JOINT_METERS = 250;

  // A synthetic projection at an arbitrary arc length, in the shape
  // sliceForward() consumes. Interpolating on the SAME vertex array both
  // sides of the cut read is what makes the in-service piece and the
  // suspended piece meet at one identical coordinate, with no gap to show and
  // no overlap to double-draw.
  function cutAtMeasure(metric, partIndex, measure) {
    const cumulative = metric.cumulative;
    const total = cumulative[cumulative.length - 1] || 0;
    const clamped = Math.max(0, Math.min(total, measure));
    let index = 0;
    while (index < cumulative.length - 2 && cumulative[index + 1] < clamped)
      index += 1;
    const span = cumulative[index + 1] - cumulative[index];
    const ratio = span > 0 ? (clamped - cumulative[index]) / span : 0;
    const start = metric.coordinates[index];
    const end = metric.coordinates[index + 1];
    return {
      partIndex,
      index,
      ratio,
      measure: clamped,
      coordinate: [
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio,
      ],
    };
  }

  // Which END of a stroke a point stands at, as a measure along it. Used only
  // where an interval crosses the break between two strokes, to decide which
  // way each of them runs out to meet the other.
  function nearestEnd(metric, point) {
    const total = metric.cumulative[metric.cumulative.length - 1] || 0;
    const head = metric.coordinates[0];
    const tail = metric.coordinates[metric.coordinates.length - 1];
    return distanceMeters(head, point) <= distanceMeters(tail, point)
      ? { measure: 0, coordinate: head }
      : { measure: total, coordinate: tail };
  }

  function addRange(rangesByPart, partIndex, first, second) {
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    if (high - low <= SERVICE_CUT_EPSILON_METERS) return;
    if (!rangesByPart.has(partIndex)) rangesByPart.set(partIndex, []);
    rangesByPart.get(partIndex).push([low, high]);
  }

  function mergeMeasureRanges(ranges) {
    const sorted = ranges.slice().sort((left, right) => left[0] - right[0]);
    const merged = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([range[0], range[1]]);
    }
    return merged;
  }

  // The line's display strokes, split into the part still carrying trains and
  // the part that is not. Returns null when the line has no drawable suspended
  // span, so a package without `serviceSpans` — every package but jp, and jp
  // before this field existed — produces byte-identical output to before.
  function serviceSplitForLine(line, compactLine) {
    const spans = compactLine.serviceSpans;
    if (!Array.isArray(spans) || !spans.length) return null;
    const stations = compactLine.stations;
    const metrics = lineMetrics(line);
    if (!metrics.length) return null;

    const projectionCache = new Map();
    const anchorAt = (index) => {
      const row = stations[index];
      if (!row) return null;
      return projectPointToLine(line, [row[2], row[3]], projectionCache);
    };

    const rangesByPart = new Map();
    const codes = new Set();
    for (const span of spans) {
      const code = Number(span[2]);
      if (!SUSPENDED_SERVICE_CODES.has(code)) continue;
      const first = Math.max(0, Math.min(Number(span[0]), Number(span[1])));
      const last = Math.min(
        stations.length - 1,
        Math.max(Number(span[0]), Number(span[1])),
      );
      if (!(last > first)) continue;
      // One INTERVAL at a time, not one run at a time. A line's drawn strokes
      // break where no train can turn — 肥薩線 is cut in two at the 大畑 ループ
      // reversal, right in the middle of the closed 八代—吉松 — so a span can
      // straddle a break, and reading it as two runs would leave the 9.4 km
      // 大畑—矢岳 leg drawn solid inside a section that has had no train since
      // 2020.
      for (let index = first; index < last; index += 1) {
        const from = anchorAt(index);
        const to = anchorAt(index + 1);
        if (!from || !to) continue;
        if (from.partIndex === to.partIndex) {
          addRange(rangesByPart, from.partIndex, from.measure, to.measure);
          codes.add(code);
          continue;
        }
        // Across a break both strokes carry part of the interval, so each runs
        // out to the end that meets the other. Only when they really do meet:
        // two strokes of a line that are separately located (a disconnected
        // administrative line) are not a joint, and filling between them would
        // paint kilometres of railway the interval never touches.
        const fromEnd = nearestEnd(metrics[from.partIndex], to.coordinate);
        const toEnd = nearestEnd(metrics[to.partIndex], from.coordinate);
        if (distanceMeters(fromEnd.coordinate, toEnd.coordinate) > SERVICE_JOINT_METERS)
          continue;
        addRange(rangesByPart, from.partIndex, from.measure, fromEnd.measure);
        addRange(rangesByPart, to.partIndex, toEnd.measure, to.measure);
        codes.add(code);
      }
    }
    if (!rangesByPart.size) return null;

    const inService = [];
    const suspended = [];
    metrics.forEach((metric, partIndex) => {
      const total = metric.cumulative[metric.cumulative.length - 1] || 0;
      const ranges = rangesByPart.get(partIndex);
      if (!ranges) {
        inService.push(metric.coordinates);
        return;
      }
      const merged = mergeMeasureRanges(ranges);
      let cursor = 0;
      const emit = (target, from, to) => {
        if (to - from <= SERVICE_CUT_EPSILON_METERS) return;
        const coordinates = sliceForward(
          metric,
          cutAtMeasure(metric, partIndex, from),
          cutAtMeasure(metric, partIndex, to),
          false,
        );
        if (coordinates.length > 1) target.push(coordinates);
      };
      for (const [from, to] of merged) {
        emit(inService, cursor, from);
        emit(suspended, from, to);
        cursor = to;
      }
      emit(inService, cursor, total);
    });
    if (!suspended.length) return null;
    return {
      inService,
      suspended,
      // The gravest code on the line, for a future per-status treatment. One
      // dash rhythm serves all three today: three rhythms on one map say
      // "these differ" louder than they say how.
      serviceCode: Math.min(...codes),
    };
  }

  function geometryForParts(parts) {
    return parts.length === 1
      ? { type: "LineString", coordinates: parts[0] }
      : { type: "MultiLineString", coordinates: parts };
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
          // A paired alignment is the SAME railway's other direction on its own
          // track — 上越線's up line keeps the older bore while the down line
          // takes the 新清水トンネル loop, and the two have separate platforms.
          // Both fit a ride between the same two stations, so where the package
          // carries a SOURCED direction for the pair, the ride's own direction
          // of travel decides between them: forward through the line's station
          // order is 下り, against it 上り. A pair with no sourced direction
          // gets no nudge and geometry alone decides, which is the honest
          // outcome when nothing states which bore is which.
          const alignment = line.alignmentDirection;
          let bias = 0;
          if (alignment === "up" || alignment === "down") {
            const rode = start.measure <= end.measure ? "down" : "up";
            bias = alignment === rode ? -ALIGNMENT_MATCH_BONUS : ALIGNMENT_MATCH_BONUS;
          }
          const candidate = {
            line,
            start,
            end,
            fit,
            seam,
            score: fit + seam + bias,
          };
          if (!best || candidate.score < best.score) best = candidate;
        }
      }
      // Endpoint display coordinates may deliberately bridge a station marker
      // to its surveyed track. The characterized packages stay below 500 m;
      // 1.5 km leaves room for future rural station corrections while still
      // refusing an unrelated same-named railway elsewhere in the country.
      if (!best || Math.max(best.start.distance, best.end.distance) > 1500)
        return null;
      const sliced = canonicalLineSlice(
        best.line,
        best.start,
        best.end,
        rawCoordinates,
      );
      const canonical = sliced.coordinates;
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

  // A point at `target` metres along a stroke, and the vertex it falls in.
  function interpolateAt(coordinates, cumulative, target) {
    if (target <= 0) return { point: coordinates[0], index: 0 };
    const last = cumulative.length - 1;
    if (target >= cumulative[last]) return { point: coordinates[last], index: last };
    let index = 1;
    while (index < last && cumulative[index] < target) index += 1;
    const span = cumulative[index] - cumulative[index - 1];
    const ratio = span > 0 ? (target - cumulative[index - 1]) / span : 0;
    const a = coordinates[index - 1];
    const b = coordinates[index];
    return {
      point: [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio],
      index,
    };
  }

  // ───────────────────────── railway identity ──────────────────────────────
  //
  // WHICH RAILWAY a drawn line is, as distinct from WHICH SERVICE runs on it.
  //
  // A package line is a drawn stroke, and a package names its strokes after
  // whatever the operator publishes — which for some networks is a ROUTE
  // NUMBER rather than a railway. 香港輕鐵 publishes eleven of them (505, 507,
  // 610, 614, 614P, 615, 615P, 705, 706, 751, 761P) over ONE shared track
  // network: On Ting is served by 505, 507, 614, 614P and 751 over the same
  // rails, Ping Shan by 610, 614, 615 and 761P. Eleven services, one railway.
  // Drawn one per service, that railway would be eleven railways side by
  // side — a network the New Territories does not have.
  //
  // The distinction decides how a corridor is drawn, and nothing else:
  //
  //   same railway, several services    one stroke, exactly coincident
  //   different railways in a corridor  their own surveyed alignments
  //
  // A line absent from this table keeps operator+name as its identity, so
  // every line that is its own railway — which is nearly all of them — decides
  // exactly as it did before.
  //
  // Entries are FACTS ABOUT RAILWAYS, verified against the operator before
  // being added. Never infer one from a shared name stem, a route number, a
  // stop pattern or a pair of endpoints: 東海道新幹線 and 東海道線 share an
  // operator, a name stem and a corridor and are two entirely separate
  // railways, while 1号線 and 3号線 share neither name nor number and are one.
  const RAILWAY_IDENTITY = Object.freeze({
    // 香港輕鐵 — route numbers of one light rail system, one track network.
    // https://en.wikipedia.org/wiki/On_Ting_stop (505/507/614/614P/751)
    "hk-mtr-lr-505": "hk-mtr-light-rail",
    "hk-mtr-lr-507": "hk-mtr-light-rail",
    "hk-mtr-lr-610": "hk-mtr-light-rail",
    "hk-mtr-lr-614": "hk-mtr-light-rail",
    "hk-mtr-lr-614p": "hk-mtr-light-rail",
    "hk-mtr-lr-615": "hk-mtr-light-rail",
    "hk-mtr-lr-615p": "hk-mtr-light-rail",
    "hk-mtr-lr-705": "hk-mtr-light-rail",
    "hk-mtr-lr-706": "hk-mtr-light-rail",
    "hk-mtr-lr-751": "hk-mtr-light-rail",
    "hk-mtr-lr-761p": "hk-mtr-light-rail",
    // 横浜市営地下鉄ブルーライン — 湘南台〜関内 is legally 1号線 and 関内〜
    // あざみ野 is 3号線, but they are one through-operated railway: no train
    // begins or ends at 関内. Two line numbers, one railway.
    // https://ja.wikipedia.org/wiki/横浜市営地下鉄ブルーライン
    "jp-横浜市-1号線": "jp-横浜市-ブルーライン",
    "jp-横浜市-3号線": "jp-横浜市-ブルーライン",
  });

  // NOT in the table, and deliberately so: 香港電車's 電車東行綫 and 電車西行綫
  // are the two tracks of a double-track tramway, not two services on one
  // track (hktramways.com), so they are two railways to draw, each on its own
  // surveyed alignment.

  function railwayIdentityFor(lineId, compactLine) {
    // A geometry build can register a cross-name through railway at one exact
    // junction (Tokyo's 東北線→東海道線, the same display contract as 函館線's
    // two Sapporo strokes). Package evidence wins over the small static table:
    // it is tied to the surveyed geometry that makes the continuation true.
    return (
      compactLine.railwayIdentity ||
      RAILWAY_IDENTITY[lineId] ||
      visibilityGroupKey(compactLine)
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
        // Which RAILWAY this stroke is. Equal to operator+name unless the
        // package publishes one railway under several service names, and read
        // only where the question is "how many railways are here?" — never
        // for naming, colouring, popups or hit-testing, which are all still
        // the service's own.
        railwayId: railwayIdentityFor(lineId, compactLine),
        name: compactLine.name,
        operator: compactLine.operator,
        nameRoma: compactLine.nameRoma,
        isHSR: Boolean(compactLine.isHSR),
        isLoop: Boolean(compactLine.isLoop),
        // Paired alignments: this railway's other direction on its own track,
        // with the sourced 上り/下り label when the package carries one.
        alignmentOf: compactLine.alignmentOf || null,
        alignmentRole: compactLine.alignmentRole || null,
        alignmentDirection: compactLine.alignmentDirection || null,
        rank: compactLine.rank,
        color: compactLine.color,
        // A split part is the SAME railway as its parent and has no badge file
        // of its own — the art is named after the railway, not the stroke. So a
        // trailing `-2`/`-3` resolves to the parent's badge; without this,
        // 京王線-2 and its kind asked for a PNG that was never created and fell
        // through to an operator mark those railways do not have.
        // `-p1` is the same story for a paired alignment: 北陸線's 鳩原 loop is
        // the same railway as 北陸線 and wears the same badge.
        //
        // Both suffixes can stack — 日豊線's 立石 pair is a paired alignment OF a
        // split part, `日豊線-2-p1` — so this strips them repeatedly. Peeling one
        // left `日豊線-2`, a badge that was never drawn either.
        logo: compactLine.logo
          ? `/rail/logos/${lineId.replace(/(?:-p?\d+)+$/, "")}.png`
          : null,
        stationOrder: stationIds,
        km: totalKm,
        visibilityKm,
        minZoom: lineMinZoom,
      });

      // A line that carries branches renders as several disjoint strokes: they
      // meet at a station so the map still reads continuous, but nothing can
      // draw or slice straight through the junction (see displayPartsForLine).
      const lineParts = displayPartsForLine(compactLine);
      const lineGeometry = geometryForParts(lineParts);
      lineById.get(lineId).geometry = lineGeometry;
      lineById.get(lineId).parts = lineParts;
      // `parts` stays WHOLE whatever the service status says. Ride slicing,
      // hit-testing and the route solver all read it, and a ride recorded
      // before the suspension is still a ride: what closed is the timetable,
      // not the metals the train ran on.
      const serviceSplit = serviceSplitForLine(
        lineById.get(lineId),
        compactLine,
      );
      // One feature per line, on the line's own surveyed geometry — split in
      // two ONLY where the ledger says passenger trains have stopped running
      // over part of it, because a dash rhythm cannot be expressed per-vertex
      // and the alternative (dashing the whole line) would claim 肥薩線 is
      // closed over 124 km when 37 of them still carry trains. Every railway
      // still draws where it was surveyed: a shared corridor is shown by the
      // strokes that are really there, never by pushing one of them sideways.
      const baseProperties = {
        lineId,
        name: compactLine.name,
        operator: compactLine.operator,
        color: featureColor,
        minz: lineMinZoom,
        isHSR: compactLine.isHSR ? 1 : 0,
        isLoop: compactLine.isLoop ? 1 : 0,
        intervalCount: compactLine.segments.length,
        partCount: lineParts.length,
        strokeCount: lineParts.length,
        visibilityKm,
      };
      if (!serviceSplit) {
        lineFeatures.push({
          type: "Feature",
          geometry: lineGeometry,
          properties: baseProperties,
        });
      } else {
        // Both features carry the SAME minz and visibilityKm: they are one
        // railway at one level of detail, and a line whose closed half faded
        // out a zoom before its open half would read as two railways.
        if (serviceSplit.inService.length)
          lineFeatures.push({
            type: "Feature",
            geometry: geometryForParts(serviceSplit.inService),
            properties: {
              ...baseProperties,
              partCount: serviceSplit.inService.length,
              strokeCount: serviceSplit.inService.length,
            },
          });
        lineFeatures.push({
          type: "Feature",
          geometry: geometryForParts(serviceSplit.suspended),
          properties: {
            ...baseProperties,
            partCount: serviceSplit.suspended.length,
            strokeCount: serviceSplit.suspended.length,
            suspended: 1,
            serviceCode: serviceSplit.serviceCode,
            serviceStatus: SERVICE_STATUS_CODES[serviceSplit.serviceCode] || "",
            // The line's name is written ONCE. It goes on the stroke that
            // still runs trains, and only falls to the closed stroke when
            // there is no other — a wholly suspended railway is still a
            // railway with a name (美祢線 is the whole-line case).
            ...(serviceSplit.inService.length ? { labelSuppressed: 1 } : {}),
          },
        });
      }
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
            color: featureColor,
            colorKey: featureColor.slice(1).toLowerCase(),
            // Set by the interchange pass below, which needs every line read
            // before it can answer how many railways call here.
            interchange: 0,
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

    // Which platforms are interchanges.
    //
    // An interchange is where a passenger can change RAILWAY — so it is
    // counted in railway identities, never in lines and never in services.
    // 輕鐵 505, 610 and 615 all calling at one stop is one railway calling
    // once, and drawing that stop as an interchange would promise a change
    // of train that nobody makes.
    //
    // Drawn hollow: a station on one railway is a solid dot, a station where
    // two railways meet is an open circle, which is the convention every
    // transit map uses to say 'you can change here'.
    const railwaysAtGroup = new Map();
    for (const [groupKey, members] of groupMembers) {
      const railways = new Set();
      for (const member of members) {
        const line = lineById.get(member.lineId);
        if (line) railways.add(line.railwayId);
      }
      railwaysAtGroup.set(groupKey, railways.size);
    }
    for (const feature of stationFeatures) {
      const groupKey =
        feature.properties.stationGroupId ||
        `solo:${feature.properties.stationId}`;
      feature.properties.interchange =
        (railwaysAtGroup.get(groupKey) || 1) > 1 ? 1 : 0;
    }
    // Marker identity stays per (line, station) even when another railway
    // calls at the same named interchange: label deduplication may happen
    // elsewhere, but never by moving or merging the round station marks
    // themselves.
    //
    // …and "elsewhere" is here: exactly one platform per interchange group is
    // elected into `stationLabels`, and the style's text layer draws only that
    // collection.
    // 東京 is nine platforms of five railways and ONE name; a renderer-side
    // collision pass cannot produce that, because the platforms sit tens of
    // metres apart and every one of the nine finds room for its own copy.
    //
    // The election is a LABEL right, nothing else. It does not merge, move,
    // delete or re-colour a single mark: every platform keeps its own dot and
    // its own line identity in `stations`, and the elected
    // collection holds the VERY SAME feature objects rather than copies of
    // them — so a label cannot drift from the dot it names, and no property
    // of the render model changes because a name was or was not elected.
    // Choosing the platform that appears first in the package (lowest minz
    // wins ties, then stationId) makes the choice deterministic across
    // rebuilds rather than dependent on iteration order.
    const labelPickByGroup = new Map();
    for (const feature of stationFeatures) {
      const props = feature.properties;
      const groupKey = props.stationGroupId || `solo:${props.stationId}`;
      const current = labelPickByGroup.get(groupKey);
      if (
        !current ||
        props.minz < current.properties.minz ||
        (props.minz === current.properties.minz &&
          props.stationId < current.properties.stationId)
      )
        labelPickByGroup.set(groupKey, feature);
    }
    //
    // One more pass, because a "station" and a "station group" are not always
    // the same thing in the source data: 東京 is one place a passenger walks
    // around, but JR East's 東京 and 東京メトロ's 東京 arrive as two groups
    // several hundred metres apart, and naming both prints the name twice on
    // top of itself. Two elected names that READ the same and sit inside
    // LABEL_MERGE_METERS of each other are the same place being named twice,
    // so the second one steps down. Different names never merge, however
    // close (新宿 and 新宿三丁目 stay two labels), and no distance in this
    // pass reaches a single dot.
    const LABEL_MERGE_METERS = 600;
    const cellOf = (lon, lat, size) =>
      `${Math.floor(lon / size)}|${Math.floor(lat / size)}`;
    // ~400 m of longitude at 35°, which is the worst case across all five
    // packages; a slightly generous cell only costs a few extra comparisons.
    const CELL_DEGREES = 0.0055;
    const acceptedByCell = new Map();
    const elected = [...labelPickByGroup.values()].sort((a, b) => {
      if (a.properties.minz !== b.properties.minz)
        return a.properties.minz - b.properties.minz;
      return a.properties.stationId < b.properties.stationId ? -1 : 1;
    });
    const stationLabelFeatures = [];
    for (const feature of elected) {
      const [lon, lat] = feature.geometry.coordinates;
      const name = feature.properties.name;
      let duplicate = false;
      const cx = Math.floor(lon / CELL_DEGREES);
      const cy = Math.floor(lat / CELL_DEGREES);
      for (let dx = -1; dx <= 1 && !duplicate; dx += 1)
        for (let dy = -1; dy <= 1 && !duplicate; dy += 1) {
          const bucket = acceptedByCell.get(`${cx + dx}|${cy + dy}`);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other.properties.name !== name) continue;
            if (
              distanceMeters(other.geometry.coordinates, [lon, lat]) <=
              LABEL_MERGE_METERS
            ) {
              duplicate = true;
              break;
            }
          }
        }
      if (duplicate) continue;
      stationLabelFeatures.push(feature);
      const key = cellOf(lon, lat, CELL_DEGREES);
      if (!acceptedByCell.has(key)) acceptedByCell.set(key, []);
      acceptedByCell.get(key).push(feature);
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
      // The names: one elected platform per station complex, holding the SAME
      // feature objects `stations` holds. Nothing here is a copy and nothing
      // here is drawn as a mark — this collection exists so that 東京 is named
      // once rather than nine times, and for no other reason.
      stationLabels: {
        type: "FeatureCollection",
        features: stationLabelFeatures,
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
