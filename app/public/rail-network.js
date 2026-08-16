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
    // A cut AT the far end of what we can read means the platform lies beyond
    // the last surveyed vertex the line has — which only a terminal can do,
    // and which leaves nothing to measure it against. The package's own final
    // edge is then the only evidence of where the track runs, and it is
    // better evidence than an extrapolated heading: the two are the same on
    // straight track, and where they differ it is because the alignment is on
    // a curve, which is exactly where extrapolating is wrong. So the approach
    // is left as drawn, and only a platform the track OVERSHOOTS — the drive
    // past the buffer and back that ends 90 Japanese strokes — is rebuilt.
    if (!outgoing && cut.index === path.length - 2 && cut.ratio >= 1) return null;
    if (!incoming && cut.index === 0 && cut.ratio <= 0) return null;

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
    const canonicalLanes = [];
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
      // Where this stroke runs in a parallel lane, the ride runs in it too —
      // read at the same measures, off the same profile, and signed by the
      // direction the slice itself reports. Taken BEFORE the endpoints are
      // snapped below, so a platform bridge cannot shift the measures.
      canonicalLanes.push(
        routeLanesForSlice(
          network.laneProfiles?.get(
            `${best.line.lineId}#${best.start.partIndex}`,
          ),
          canonical,
          best.start.measure,
          sliced.backward,
        ),
      );
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
        // One lane value per drawn vertex, per geometry line — null for a
        // route that never leaves the centre-line, which is nearly all of
        // them. buildDeckRouteRecords cuts the drawn record on it.
        ...(canonicalLanes.some(Boolean)
          ? { display_lanes: canonicalLanes }
          : null),
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

  // ───────────────────── independent parallel corridors ─────────────────────
  //
  // Where a trunk and its own branch share track, the branch is drawn over the
  // trunk's OWN coordinates and the two are exactly coincident — one railway,
  // seen twice (displayPartsForLine). Where two DIFFERENT railways happen to
  // run the same corridor, coincidence would be a lie: the map would show one
  // line where the country has two, and no amount of zooming would reveal the
  // second.
  //
  // So the two cases are told apart by IDENTITY, never by geometry:
  //
  //   same line id                 SINGLE                 one stroke
  //   same operator + name group   MAIN_BRANCH_SHARED     exactly coincident
  //   anything else in a corridor  INDEPENDENT_PARALLEL   its own lane
  //
  // The lane table is computed offline (scripts/railway/build-parallel-corridors.mjs —
  // the sweep is far too heavy for boot) and shipped in the package as rows of
  // `[lineId, partIndex, fromMeters, toMeters, laneOffset]`. `laneOffset` is a
  // SIGNED MULTIPLE of the lane spacing, symmetric about the shared alignment
  // (±0.5 for two railways, −1/0/+1 for three), so the station markers on that
  // alignment stay in the middle of the bundle and the whole corridor keeps
  // one left-to-right order from end to end.
  //
  // Only the RENDER geometry is split. `line.parts` — what ridden routes are
  // sliced from, what the route solver's output is matched against — is
  // untouched, so no lane can move a train off its track.
  function laneRowsByPart(pkg) {
    const byPart = new Map();
    if (!Array.isArray(pkg.lanes)) return byPart;
    for (const row of pkg.lanes) {
      const key = `${row[0]}#${row[1]}`;
      let rows = byPart.get(key);
      if (!rows) byPart.set(key, (rows = []));
      rows.push({ from: Number(row[2]), to: Number(row[3]), lane: Number(row[4]) });
    }
    for (const rows of byPart.values()) rows.sort((a, b) => a.from - b.from);
    return byPart;
  }

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

  // A lane may not simply switch on. Stepping a whole line sideways at one
  // point puts a corner in it that no railway has, so every lane fades in and
  // out over a short run of track: the first RAMP_METERS of the stretch are
  // drawn at a quarter, a half and three quarters of the offset before the
  // full lane begins, and the last RAMP_METERS come back the same way. Each
  // step is a quarter of a lane — well under a pixel — and consecutive pieces
  // share their boundary vertex, so the line reads as one continuous stroke
  // easing across rather than as two strokes with a jog between them.
  //
  // The ramp costs almost nothing: pieces are grouped by lane VALUE per line,
  // so a line with several stretches at the same lane shares one feature per
  // quarter-step no matter how many boundaries it has.
  const RAMP_METERS = 220;
  const RAMP_STEPS = 4;

  function rampedRow(row, previousEnd, nextStart) {
    const span = row.to - row.from;
    // Never let the two ramps meet, and never eat into a neighbour.
    const room = Math.min(
      RAMP_METERS,
      span / 3,
      Math.max(0, row.from - previousEnd),
      Math.max(0, nextStart - row.to),
    );
    if (!(room > 1)) return [{ from: row.from, to: row.to, lane: row.lane }];
    const out = [];
    // Ease IN over the track BEFORE the stretch, so the stretch itself is at
    // full offset for its whole length.
    for (let step = 1; step < RAMP_STEPS; step += 1)
      out.push({
        from: row.from - room + ((step - 1) * room) / (RAMP_STEPS - 1),
        to: row.from - room + (step * room) / (RAMP_STEPS - 1),
        lane: (row.lane * step) / RAMP_STEPS,
      });
    out.push({ from: row.from, to: row.to, lane: row.lane });
    for (let step = RAMP_STEPS - 1; step >= 1; step -= 1)
      out.push({
        from: row.to + ((RAMP_STEPS - 1 - step) * room) / (RAMP_STEPS - 1),
        to: row.to + ((RAMP_STEPS - step) * room) / (RAMP_STEPS - 1),
        lane: (row.lane * step) / RAMP_STEPS,
      });
    return out;
  }

  // Every lane stretch of one stroke, expanded into its ramp-in / full /
  // ramp-out pieces and laid out in measure order.
  //
  // THE single source of the lane profile. The stroke is cut by it
  // (splitPartByLanes) and every ridden route drawn over that stroke is
  // offset by it (laneAtMeasure, routeLanesForSlice): one function, so a
  // train can never ease into its lane a few metres before or after the
  // railway underneath it does.
  function rampedRows(rows, total) {
    const ramped = [];
    rows.forEach((row, index) => {
      const previousEnd = index > 0 ? rows[index - 1].to : 0;
      const nextStart = index < rows.length - 1 ? rows[index + 1].from : total;
      ramped.push(...rampedRow(row, previousEnd, nextStart));
    });
    return ramped;
  }

  // The lane at one point along a stroke. Outside every stretch — and in the
  // gaps the ramps do not reach — the railway is on its own alignment, 0.
  function laneAtMeasure(ramped, measure) {
    if (!ramped) return 0;
    for (const row of ramped)
      if (measure >= row.from && measure <= row.to) return row.lane;
    return 0;
  }

  // The lane each vertex of a ridden route's canonical slice belongs in.
  //
  // A ridden route is an exact slice of the drawn stroke (canonicalLineSlice),
  // so its lane is never a fresh judgement: it is the SAME profile, read at
  // the same measures. That is the whole point — a train has to sit on the
  // railway it rode, and a corridor where the railway steps into a lane and
  // the train stays on the centre-line would draw the ride beside its own
  // track.
  //
  // The sign does need care. line-offset is measured against the feature's
  // OWN direction of travel, while the profile is stated in the stroke's, so
  // a train running the stroke backwards must take the opposite sign or it
  // would be pushed out to the far side of the railway it is riding.
  function routeLanesForSlice(profile, coordinates, startMeasure, reversed) {
    if (!profile || !profile.ramped.length || coordinates.length < 2) return null;
    const sign = reversed ? -1 : 1;
    const total = profile.total;
    const lanes = new Array(coordinates.length);
    let travelled = 0;
    let laned = false;
    for (let index = 0; index < coordinates.length; index += 1) {
      if (index > 0)
        travelled += distanceMeters(coordinates[index - 1], coordinates[index]);
      let measure = startMeasure + sign * travelled;
      // A closed line's slice may run off the end of the stroke and resume at
      // 0; an open one cannot, so there a measure outside the stroke is float
      // drift at an endpoint and belongs at the end it drifted off.
      if (profile.isLoop && total > 0)
        measure = ((measure % total) + total) % total;
      else measure = Math.max(0, Math.min(total, measure));
      lanes[index] = laneAtMeasure(profile.ramped, measure) * sign;
      if (lanes[index]) laned = true;
    }
    // A route that never leaves the centre-line carries no lane data at all,
    // so nothing downstream can tell this pass ran.
    return laned ? lanes : null;
  }

  // Cut one stroke into `{ lane, coordinates }` pieces. Gaps between lane rows
  // are lane 0 — the railway on its own surveyed alignment.
  function splitPartByLanes(coordinates, rows) {
    const cumulative = [0];
    for (let index = 1; index < coordinates.length; index += 1)
      cumulative.push(
        cumulative[index - 1] +
          distanceMeters(coordinates[index - 1], coordinates[index]),
      );
    const total = cumulative[cumulative.length - 1];
    if (!rows || !rows.length || !(total > 0)) return [{ lane: 0, coordinates }];

    const slice = (from, to, lane) => {
      const start = interpolateAt(coordinates, cumulative, from);
      const end = interpolateAt(coordinates, cumulative, to);
      const piece = [start.point];
      for (let index = start.index; index < end.index; index += 1)
        if (!sameCoordinate(piece[piece.length - 1], coordinates[index]))
          piece.push(coordinates[index]);
      if (!sameCoordinate(piece[piece.length - 1], end.point)) piece.push(end.point);
      return piece.length >= 2 ? { lane, coordinates: piece } : null;
    };

    // Expand each stretch into its ramp-in / full / ramp-out pieces first, so
    // the walk below only has to lay them end to end.
    const ramped = rampedRows(rows, total);

    const pieces = [];
    let cursor = 0;
    for (const row of ramped) {
      const from = Math.max(cursor, Math.min(row.from, total));
      const to = Math.max(from, Math.min(row.to, total));
      if (from > cursor) {
        const gap = slice(cursor, from, 0);
        if (gap) pieces.push(gap);
      }
      // Consecutive pieces share their boundary vertex exactly, so the two
      // round-capped ends overlap and the eased step never opens a hairline.
      const lanePiece = slice(from, to, row.lane);
      if (lanePiece) pieces.push(lanePiece);
      cursor = to;
    }
    if (cursor < total) {
      const tail = slice(cursor, total, 0);
      if (tail) pieces.push(tail);
    }
    return pieces.length ? pieces : [{ lane: 0, coordinates }];
  }

  // Which lane a point on this stroke is in, and which way the track runs
  // there. A station belonging to a line that is in a lane has to move into
  // that lane with it — otherwise the dot stays on the shared centre-line and
  // says "both these railways stop here" when only one of them does.
  //
  // MapLibre has no per-feature circle offset, so the marker cannot be a
  // circle layer. It ships instead as a POINT carrying the bearing of the
  // track under it, and the style draws it as an icon rotated to that bearing
  // and pushed sideways by icon-offset — which, because the offset rotates
  // with the icon, lands in exactly the place line-offset would put it.
  //
  // The bearing is the whole reason this is computed here: it is a fact about
  // the railway's geometry, not about how wide a lane is drawn. The distance
  // stays in the style with every other screen weight, where it also picks up
  // the scale ramp those weights ride.
  // The platform is a VERTEX of the stroke it belongs to (the approach pass
  // guarantees it), so when this stroke holds it, read the direction there and
  // nowhere else. Measuring to the nearest track instead can answer from a
  // stretch of the SAME line running the other way — a branch beside its own
  // trunk — and a bearing 180° out puts the dot a full lane on the wrong side
  // of its railway. Three Tōhoku Line platforms did exactly that.
  function laneAtPoint(coordinates, rows, point) {
    if (!rows || !rows.length) return null;
    let measure = 0;
    let best = Infinity;
    let at = 0;
    let direction = null;
    let exact = false;
    for (let index = 1; index < coordinates.length; index += 1) {
      const a = coordinates[index - 1];
      const b = coordinates[index];
      if (!exact && sameCoordinate(point, a) && index === 1) {
        // The stroke OPENS on this platform; its first edge leaves it.
        exact = true;
        best = 0;
        at = 0;
        direction = [b[0] - a[0], b[1] - a[1]];
      } else if (!exact && sameCoordinate(point, b)) {
        exact = true;
        best = 0;
        at = measure + distanceMeters(a, b);
        direction = [b[0] - a[0], b[1] - a[1]];
      } else if (!exact) {
        const distance = pointSegmentDistanceMeters(point, a, b);
        if (distance < best) {
          best = distance;
          at = measure;
          direction = [b[0] - a[0], b[1] - a[1]];
        }
      }
      measure += distanceMeters(a, b);
    }
    if (best > STATION_TOUCH_METERS || !direction) return null;
    const row = rows.find((item) => at >= item.from && at <= item.to);
    if (!row || !row.lane) return null;
    return { lane: row.lane, direction, exact };
  }

  // Compass bearing of the track under a platform: degrees clockwise from
  // north, in the line's own direction of travel. The style rotates the
  // marker by it, so the marker's own +x axis is "right of travel" — the very
  // side line-offset calls positive, which is what keeps a platform and the
  // railway it belongs to in the same lane by construction.
  function stationLaneBearing(direction, latitude) {
    const east = direction[0] * (Math.cos((latitude * Math.PI) / 180) || 1);
    const north = direction[1];
    if (!east && !north) return null;
    const degrees = (Math.atan2(east, north) * 180) / Math.PI;
    return ((degrees % 360) + 360) % 360;
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
  // Given a lane each, that railway would be drawn as eleven railways side by
  // side — a network the New Territories does not have.
  //
  // The distinction decides parallel rendering, and nothing else:
  //
  //   same railway, several services    one stroke, exactly coincident
  //   different railways in a corridor  separate lanes
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
  // track (hktramways.com), so they are two railways to draw and do take
  // neighbouring lanes.

  function railwayIdentityFor(lineId, compactLine) {
    return RAILWAY_IDENTITY[lineId] || visibilityGroupKey(compactLine);
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
    const stationLaneFeatures = [];
    const laneRows = laneRowsByPart(pkg);
    // "lineId#partIndex" → the expanded lane profile of that stroke, for the
    // ridden routes canonicalizeRouteFeature slices out of it.
    const laneProfiles = new Map();

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
        logo: compactLine.logo
          ? `/rail/logos/${lineId.replace(/-p?\d+$/, "")}.png`
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
      const lineGeometry =
        lineParts.length === 1
          ? { type: "LineString", coordinates: lineParts[0] }
          : { type: "MultiLineString", coordinates: lineParts };
      // Render geometry, grouped by lane. A line outside every parallel
      // corridor keeps exactly one feature, unchanged; a line that shares a
      // corridor gets one extra feature per lane it takes, each still carrying
      // its own lineId so hit-testing, popups and colours are unaffected.
      const byLane = new Map();
      lineParts.forEach((coordinates, partIndex) => {
        const rows = laneRows.get(`${lineId}#${partIndex}`);
        // Keep the expanded profile: the ridden routes sliced out of this very
        // stroke are offset by it, so both read one set of ramps.
        if (rows && rows.length) {
          const total = pathLength(coordinates);
          laneProfiles.set(`${lineId}#${partIndex}`, {
            ramped: rampedRows(rows, total),
            total,
            isLoop: Boolean(compactLine.isLoop) && lineParts.length === 1,
          });
        }
        for (const piece of splitPartByLanes(coordinates, rows)) {
          let group = byLane.get(piece.lane);
          if (!group) byLane.set(piece.lane, (group = []));
          group.push(piece.coordinates);
        }
      });
      // A line in no corridor at all keeps the very geometry object the line
      // record holds, so nothing downstream can tell the lane pass ran.
      const untouched = byLane.size === 1 && byLane.has(0);
      for (const [lane, groupParts] of [...byLane.entries()].sort(
        (a, b) => a[0] - b[0],
      )) {
        lineFeatures.push({
          type: "Feature",
          geometry: untouched
            ? lineGeometry
            : groupParts.length === 1
              ? { type: "LineString", coordinates: groupParts[0] }
              : { type: "MultiLineString", coordinates: groupParts },
          properties: {
            lineId,
            name: compactLine.name,
            operator: compactLine.operator,
            color: featureColor,
            minz: lineMinZoom,
            isHSR: compactLine.isHSR ? 1 : 0,
            isLoop: compactLine.isLoop ? 1 : 0,
            intervalCount: compactLine.segments.length,
            partCount: untouched ? lineParts.length : groupParts.length,
            strokeCount: lineParts.length,
            // Signed multiple of the lane spacing; 0 = the line's own
            // surveyed alignment. The style turns it into screen pixels.
            lane,
            visibilityKm,
          },
        });
      }
      lineById.get(lineId).geometry = lineGeometry;
      lineById.get(lineId).parts = lineParts;
      addIndexValue(linesByName, compactLine.name, lineById.get(lineId));
      addIndexValue(
        linesByOperator,
        compactLine.operator,
        lineById.get(lineId),
      );

      // Which vertices each stroke of this line holds — built once, and only
      // for a line that takes a lane somewhere, since it exists solely to
      // decide which stroke a platform belongs to.
      const lanedPartKeys = lineParts.some((unused, partIndex) =>
        laneRows.has(`${lineId}#${partIndex}`),
      )
        ? lineParts.map((coordinates) => {
            const keys = new Set();
            for (const coordinate of coordinates)
              keys.add(coordinateKey(coordinate));
            return keys;
          })
        : null;

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

        // Does this platform sit on a stretch where its line runs in a lane?
        //
        // Only the stroke that HOLDS the platform may answer. A line drawn as
        // several strokes can lay a branch back alongside its own trunk, and
        // asking "which laned stretch is nearest?" then lets the branch answer
        // for a trunk station — which both puts the dot in a lane its railway
        // does not take there and, because the branch runs the other way,
        // reads the bearing backwards and pushes it out the far side.
        let stationLane = null;
        if (lanedPartKeys) {
          const anchorKey = coordinateKey([station.lon, station.lat]);
          const holder = lanedPartKeys.findIndex((keys) => keys.has(anchorKey));
          const scan = holder >= 0 ? [holder] : lanedPartKeys.map((k, i) => i);
          for (const partIndex of scan) {
            const rows = laneRows.get(`${lineId}#${partIndex}`);
            if (!rows) continue;
            const found = laneAtPoint(lineParts[partIndex], rows, [
              station.lon,
              station.lat,
            ]);
            if (found) {
              stationLane = found;
              break;
            }
          }
        }
        const laneValue = stationLane ? stationLane.lane : 0;
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
            lane: laneValue,
            lineMinz: lineMinZoom,
            // A non-loop line's two endpoints are structural and follow the
            // complete line exactly. Intermediate stations retain the denser
            // spacing-based LOD and may appear several zoom levels later.
            isTerminal: isTerminal ? 1 : 0,
            minz: isTerminal ? lineMinZoom : stationMinZoom,
          },
        });
        if (!stationLane) return;
        const bearing = stationLaneBearing(
          stationLane.direction,
          station.lat,
        );
        if (bearing == null) return;
        stationLaneFeatures.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [station.lon, station.lat],
          },
          properties: {
            stationId: station.stationId,
            lineId,
            stationGroupId: station.stationGroupId || "",
            color: featureColor,
            colorKey: featureColor.slice(1).toLowerCase(),
            interchange: 0,
            lane: laneValue,
            // Which way the track runs here; the style turns it into the side
            // of the alignment this platform's railway is drawn on.
            bearing,
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
    for (const feature of [...stationFeatures, ...stationLaneFeatures]) {
      const groupKey =
        feature.properties.stationGroupId ||
        `solo:${feature.properties.stationId}`;
      feature.properties.interchange =
        (railwaysAtGroup.get(groupKey) || 1) > 1 ? 1 : 0;
    }
    // Marker identity stays per (line, station) even when another railway
    // calls at the same named interchange. A platform on a non-zero lane is
    // therefore kept in stationLaneFeatures and follows that railway's final
    // offset; label deduplication may happen elsewhere, but never by moving or
    // merging the round station marks themselves.
    //
    // …and "elsewhere" is here: exactly one platform per interchange group is
    // elected into `stationLabels`, and the style's text layer draws only that
    // collection.
    // 東京 is nine platforms of five railways and ONE name; a renderer-side
    // collision pass cannot produce that, because the platforms sit tens of
    // metres apart and every one of the nine finds room for its own copy.
    //
    // The election is a LABEL right, nothing else. It does not merge, move,
    // delete or re-colour a single mark: every platform keeps its own dot, its
    // own lane and its own line identity in `stations`, and the elected
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
      // Platforms whose line runs in a lane, each carrying the bearing of the
      // track under it. The circle layer filters them out and the style draws
      // these instead — rotated to that bearing and offset into the lane — so
      // every dot sits on the railway that actually calls there.
      stationLanes: {
        type: "FeatureCollection",
        features: stationLaneFeatures,
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
      // Read by canonicalizeRouteFeature so a ridden route takes the very lane
      // its railway is drawn in.
      laneProfiles,
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
