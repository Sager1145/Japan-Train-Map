// =========================================================================
//  app-deck-records.js — §26b: overlap map construction & deck route/marker record builders
//
//  Part of the app-*.js family split out of the old single-file app.js:
//  plain classic scripts sharing one global lexical scope, loaded in the
//  order defined by index.html (the module map lives in app.js's header).
// =========================================================================

// Index every ORIGINAL route segment by the direction-independent key the
// route dedupe uses, so shared N02 track (identical source coordinates) is
// detected exactly — INDEPENDENT of how each feature's geometry was
// simplified for display (per-feature simplification keeps different vertex
// subsets, which used to fragment corridors into confetti). Slot order is by
// DATE (earliest first, then departure time, then id) so parallel pick lanes
// read left→right / top→bottom in chronological order, and a train keeps the
// same lane along the whole shared stretch.
function buildDeckOverlapMap(items) {
  // Ensure the shared vertex canonicaliser is current FIRST, so the segKeys
  // getRouteLinePairs hands back below (and to the record builder) are snapped
  // against the shared representative set. Coincident N02 track keys identically
  // across trains, so a shared corridor no longer fragments into single-train
  // slivers. ensureRouteVertexSnap only rebuilds (and bumps the version) when the
  // route geometry set changed — scope / visibility / style / ride toggles reuse
  // the existing snap and its stamped segKeys instead of re-snapping every pass.
  ensureRouteVertexSnap(items, OVERLAP_SNAP_METERS);
  const uniqueTrains = [];
  const seenIds = new Set();
  items.forEach((it) => {
    if (it.train && !seenIds.has(it.train.id)) {
      seenIds.add(it.train.id);
      uniqueTrains.push(it.train);
    }
  });
  uniqueTrains.sort(compareTrainsByDateAndDeparture);
  const rank = new Map(uniqueTrains.map((t, i) => [t.id, i]));
  // Count ONLY segments that will actually produce a drawn record — the same
  // predicate buildDeckRouteRecords uses to drop records (unridden sections
  // are hidden entirely; dimmed trains vanish when dimOpacity is 0). Anything
  // invisible must not occupy a lane slot or inflate the ×N count, or the fan
  // and the pick corridor get phantom gaps.
  const itemDrawn = (item) => {
    const train = item.train;
    if (!train) return false;
    const flags = routeRecordScopeFlags(train);
    // Off-date (dimmed) trains never occupy a parallel lane: while a concrete
    // day is active, its routes must not shift sideways because of overlaps
    // with OTHER days' routes, and the dim lines are not hoverable anyway.
    if (flags.dimmed) return false;
    const ridden =
      item.feature.properties && item.feature.properties.ride_segment === true;
    if (ridden && !riddenFeatureVisible(item.feature)) return false;
    const { opacity } = routeSegmentStyleValues(train, ridden, flags);
    return opacity > 0;
  };
  const seg = new Map();
  const segmentGeometry = new Map();
  items.forEach((item) => {
    const tid = item.train && item.train.id;
    if (!tid || !itemDrawn(item)) return;
    getRouteLinePairs(item.feature).forEach(({ orig, segKeys }) => {
      for (let i = 0; i < segKeys.length; i += 1) {
        let ids = seg.get(segKeys[i]);
        if (!ids) {
          ids = new Set();
          seg.set(segKeys[i], ids);
        }
        ids.add(tid);
        if (!segmentGeometry.has(segKeys[i]))
          segmentGeometry.set(segKeys[i], {
            key: segKeys[i],
            a: orig[i],
            b: orig[i + 1],
          });
      }
    });
  });

  // Add different-but-parallel tracks to the overlap graph. A metre-grid
  // keeps this near O(n): each segment is compared only with geometries whose
  // bounding boxes enter the same neighbourhood. Matched segment keys share
  // both membership and a stable interaction key, so JR and Shinkansen routes
  // fan together even though their raw coordinates differ.
  const nearGroupByKey = new Map();
  const nearMaxByGroup = new Map();
  let nearPairCount = 0;
  if (OVERLAP_NEAR_PARALLEL_METERS > 0 && segmentGeometry.size > 1) {
    const cellM = Math.max(20, OVERLAP_NEAR_PARALLEL_METERS);
    const gridX = (lng) => lng * 80000;
    const gridY = (lat) => lat * 110540;
    const buckets = new Map();
    const pairs = [];
    const descriptors = [...segmentGeometry.values()];
    descriptors.forEach((d) => {
      const ax = gridX(d.a[0]);
      const ay = gridY(d.a[1]);
      const bx = gridX(d.b[0]);
      const by = gridY(d.b[1]);
      d.minX = Math.min(ax, bx);
      d.maxX = Math.max(ax, bx);
      d.minY = Math.min(ay, by);
      d.maxY = Math.max(ay, by);
      const qx0 = Math.floor(
        (d.minX - OVERLAP_NEAR_PARALLEL_METERS) / cellM,
      );
      const qx1 = Math.floor(
        (d.maxX + OVERLAP_NEAR_PARALLEL_METERS) / cellM,
      );
      const qy0 = Math.floor(
        (d.minY - OVERLAP_NEAR_PARALLEL_METERS) / cellM,
      );
      const qy1 = Math.floor(
        (d.maxY + OVERLAP_NEAR_PARALLEL_METERS) / cellM,
      );
      const checked = new Set();
      for (let gx = qx0; gx <= qx1; gx += 1)
        for (let gy = qy0; gy <= qy1; gy += 1) {
          const list = buckets.get(gx + "," + gy);
          if (!list) continue;
          list.forEach((other) => {
            if (checked.has(other.key)) return;
            checked.add(other.key);
            const aIds = seg.get(d.key);
            const bIds = seg.get(other.key);
            // A route must never overlap itself at a loop, siding, or tight
            // station throat.
            if ([...aIds].some((id) => bIds.has(id))) return;
            const separation = nearParallelSegmentSeparation(
              d.a,
              d.b,
              other.a,
              other.b,
              OVERLAP_NEAR_PARALLEL_METERS,
            );
            if (separation == null) return;
            pairs.push({ a: d.key, b: other.key, separation });
          });
        }
      const ix0 = Math.floor(d.minX / cellM);
      const ix1 = Math.floor(d.maxX / cellM);
      const iy0 = Math.floor(d.minY / cellM);
      const iy1 = Math.floor(d.maxY / cellM);
      for (let gx = ix0; gx <= ix1; gx += 1)
        for (let gy = iy0; gy <= iy1; gy += 1) {
          const key = gx + "," + gy;
          let list = buckets.get(key);
          if (!list) buckets.set(key, (list = []));
          list.push(d);
        }
    });

    if (pairs.length) {
      // Expand membership only through DIRECT geometric neighbours. Do not
      // flood train ids through an entire spatial component: A beside B and B
      // later beside C must not make C appear on A's earlier section.
      const expandedIds = new Map();
      const expandedFor = (key) => {
        let ids = expandedIds.get(key);
        if (!ids) {
          ids = new Set(seg.get(key) || []);
          expandedIds.set(key, ids);
        }
        return ids;
      };
      pairs.forEach((pair) => {
        const aIds = expandedFor(pair.a);
        const bIds = expandedFor(pair.b);
        (seg.get(pair.b) || []).forEach((id) => aIds.add(id));
        (seg.get(pair.a) || []).forEach((id) => bIds.add(id));
      });
      const expandedSig = new Map();
      expandedIds.forEach((ids, key) =>
        expandedSig.set(key, [...ids].sort().join("\u0000")),
      );
      // A shared interaction group is valid only when both physical tracks
      // resolve to the same direct membership. This keeps a three-way station
      // throat from transitively merging unrelated lines.
      const validPairs = pairs.filter(
        (pair) => expandedSig.get(pair.a) === expandedSig.get(pair.b),
      );
      const parent = new Map();
      const componentTrainIds = new Map();
      const find = (key) => {
        let root = key;
        while (parent.get(root) !== root) root = parent.get(root);
        let cur = key;
        while (parent.get(cur) !== cur) {
          const next = parent.get(cur);
          parent.set(cur, root);
          cur = next;
        }
        return root;
      };
      const union = (a, b) => {
        if (!parent.has(a)) {
          parent.set(a, a);
          componentTrainIds.set(a, new Set(seg.get(a) || []));
        }
        if (!parent.has(b)) {
          parent.set(b, b);
          componentTrainIds.set(b, new Set(seg.get(b) || []));
        }
        const ar = find(a);
        const br = find(b);
        if (ar === br) return true;
        const aIds = componentTrainIds.get(ar) || new Set();
        const bIds = componentTrainIds.get(br) || new Set();
        // The direct pair check above prevents a route overlapping itself,
        // but a plain DSU can reintroduce that bug transitively: A↔B and B↔C
        // would merge A with C even when A/C are two branches of one train.
        // A physical interaction component may contain each train only once.
        for (const id of aIds) if (bIds.has(id)) return false;
        parent.set(br, ar);
        bIds.forEach((id) => aIds.add(id));
        componentTrainIds.set(ar, aIds);
        componentTrainIds.delete(br);
        return true;
      };
      const acyclicPairs = validPairs.filter((pair) => union(pair.a, pair.b));
      const acceptedKeys = new Set();
      acyclicPairs.forEach((pair) => {
        acceptedKeys.add(pair.a);
        acceptedKeys.add(pair.b);
      });
      const components = new Map();
      parent.forEach((_, key) => {
        if (!acceptedKeys.has(key)) return;
        const root = find(key);
        let keys = components.get(root);
        if (!keys) components.set(root, (keys = []));
        keys.push(key);
      });
      components.forEach((keys) => {
        const canonical = "near:" + keys.slice().sort()[0];
        keys.forEach((key) => {
          seg.set(key, new Set(expandedIds.get(key) || seg.get(key) || []));
          nearGroupByKey.set(key, canonical);
        });
      });
      acyclicPairs.forEach((pair) => {
        const group = nearGroupByKey.get(pair.a);
        if (!group) return;
        nearMaxByGroup.set(
          group,
          Math.max(nearMaxByGroup.get(group) || 0, pair.separation),
        );
      });
      nearPairCount = acyclicPairs.length;
    }
  }

  // Intern the sharing sets: ONE canonical Set instance per distinct train
  // membership, so the record builder can detect run boundaries by simple
  // identity comparison — a corridor stays a single run however many
  // original segments long it is.
  const canonicalIds = new Map(); // sorted-ids signature -> Set
  seg.forEach((ids, key) => {
    const idsSig = [...ids].sort().join("\u0000");
    const canon = canonicalIds.get(idsSig);
    if (!canon) canonicalIds.set(idsSig, ids);
    else if (canon !== ids) seg.set(key, canon);
  });

  // --- canonical corridor direction ----------------------------------------
  // Every train offsets its lane relative to the SAME reference direction, or
  // lanes would swap sides wherever trains traverse shared track opposite
  // ways or the bearing crosses an axis. Overlapped segments (≥2 trains) form
  // chains; walk each connected chain once, orienting every segment away from
  // the walk start so the direction is CONTINUOUS through every bend and
  // station. Then flip the whole chain, if needed, so its net direction is
  // east-dominant (or north-dominant for N-S chains): with lane normals taken
  // right of this direction, slot 0 (earliest date) is the left/top lane.
  const adjacency = new Map(); // coordKey -> [segKey...]
  seg.forEach((ids, key) => {
    if (ids.size < 2) return;
    key.split("|").forEach((nodeKey) => {
      let list = adjacency.get(nodeKey);
      if (!list) {
        list = [];
        adjacency.set(nodeKey, list);
      }
      list.push(key);
    });
  });
  const segFrom = new Map(); // segKey -> canonical FROM coordKey
  const nodeXY = (nodeKey) => nodeKey.split(",").map(Number);
  const otherEnd = (segKey, nodeKey) => {
    const [a, b] = segKey.split("|");
    return a === nodeKey ? b : a;
  };
  const visited = new Set();
  adjacency.forEach((_, startNode) => {
    if (visited.has(startNode)) return;
    // Collect the connected component, preferring a degree-1 end as the walk
    // start so a simple chain gets one continuous direction end-to-end.
    const compNodes = [];
    const stack = [startNode];
    visited.add(startNode);
    while (stack.length) {
      const n = stack.pop();
      compNodes.push(n);
      (adjacency.get(n) || []).forEach((sk) => {
        const o = otherEnd(sk, n);
        if (!visited.has(o)) {
          visited.add(o);
          stack.push(o);
        }
      });
    }
    const start =
      compNodes.find((n) => (adjacency.get(n) || []).length === 1) ||
      compNodes[0];
    // Orient each edge away from the walk.
    const compSegs = [];
    const seenNode = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const n = queue.shift();
      (adjacency.get(n) || []).forEach((sk) => {
        if (segFrom.has(sk)) return;
        segFrom.set(sk, n);
        compSegs.push(sk);
        const o = otherEnd(sk, n);
        if (!seenNode.has(o)) {
          seenNode.add(o);
          queue.push(o);
        }
      });
    }
    // Net direction of the chain; flip everything if it points west/south.
    let dxSum = 0;
    let dySum = 0;
    compSegs.forEach((sk) => {
      const from = segFrom.get(sk);
      const to = otherEnd(sk, from);
      const [fx, fy] = nodeXY(from);
      const [tx, ty] = nodeXY(to);
      dxSum += (tx - fx) * Math.cos((((fy + ty) / 2) * Math.PI) / 180);
      dySum += ty - fy;
    });
    const flip =
      Math.abs(dxSum) >= Math.abs(dySum) ? dxSum < 0 : dySum < 0;
    if (flip)
      compSegs.forEach((sk) => segFrom.set(sk, otherEnd(sk, segFrom.get(sk))));
  });

  const orderedCache = new WeakMap(); // ids Set -> date-ordered id array
  return {
    // The sharing-train set of one ORIGINAL segment — the same Set instance
    // for every train on the segment, so run boundaries computed from its
    // identity coincide EXACTLY across all sharing trains. null = unshared.
    idsForKey(key) {
      const ids = seg.get(key);
      return ids && ids.size >= 2 ? ids : null;
    },
    groupKeyForKey(key) {
      return nearGroupByKey.get(key) || key;
    },
    nearGroupInfo(groupKey) {
      if (!String(groupKey || "").startsWith("near:")) return null;
      return {
        pairCount: nearPairCount,
        maxSeparationMeters: nearMaxByGroup.get(groupKey) || 0,
        thresholdMeters: OVERLAP_NEAR_PARALLEL_METERS,
      };
    },
    // Date-ordered lane slot of `tid` inside a sharing set from idsForKey.
    slotFor(ids, tid) {
      if (!ids) return 0;
      let ordered = orderedCache.get(ids);
      if (!ordered) {
        ordered = [...ids].sort(
          (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
        );
        orderedCache.set(ids, ordered);
      }
      return Math.max(0, ordered.indexOf(tid));
    },
    // +1 when traversing the original segment `key` starting from the vertex
    // whose coordKey is `fromKey` runs WITH the corridor's canonical direction.
    dirForKey(key, fromKey) {
      const from = segFrom.get(key);
      if (from == null) return 1;
      return from === fromKey ? 1 : -1;
    },
  };
}

// Merge the simplified vertex subset with the exact run-boundary vertices
// (both ascending original indices), so lane transitions bend precisely where
// the overlap membership changes — never displaced by the simplification.
function mergeDrawnIndices(keepIdx, runs, nSeg) {
  if (!keepIdx) {
    const all = new Array(nSeg + 1);
    for (let i = 0; i <= nSeg; i += 1) all[i] = i;
    return all;
  }
  const boundarySet = new Set();
  runs.forEach((r) => {
    boundarySet.add(r.a);
    boundarySet.add(r.b);
  });
  const extras = [...boundarySet].sort((x, y) => x - y);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < keepIdx.length || j < extras.length) {
    const ki = i < keepIdx.length ? keepIdx[i] : Infinity;
    const ej = j < extras.length ? extras[j] : Infinity;
    if (ki <= ej) {
      out.push(ki);
      i += 1;
      if (ki === ej) j += 1;
    } else {
      out.push(ej);
      j += 1;
    }
  }
  return out;
}

// Flatten cached route items into MapLibre route records. Returns
// { records, expandRecords, groupInfo, spacingDeg }:
//
//   records       — base + pick runs. One polyline per maximal stretch of
//                   constant overlap MEMBERSHIP (same sharing-train set), so
//                   run boundaries coincide exactly across all sharing
//                   trains. The visible line stays on its TRUE track; the
//                   invisible pickPath is the run rigidly translated into
//                   the train's date-ordered lane.
//   expandRecords — one polyline per (train, line): the train's complete
//                   course on its true track. When a group is hovered,
//                   railmap.js translates every member train's complete
//                   course RIGIDLY by that group's shift vector — corners,
//                   radii and lengths unchanged, the whole line moved intact,
//                   never chopped into little pieces mid-route.
//   groupInfo     — Map(groupKey → { sx, sy, mults: {tid: laneMultiplier} }):
//                   the group's unit shift vector (degree space) and every
//                   member's slot-centered lane multiplier.
//   spacingDeg    — the current lane spacing (degrees) matching pickPath.
//
// Overlap detection and run boundaries use the ORIGINAL geometry (exact
// shared N02 coordinates); drawn paths use the Douglas-Peucker subset plus
// the exact boundary vertices.
function buildDeckRouteRecords(items) {
  const sig = cachedRouteSignature;
  const spacingPx = currentOverlapSpacingPx(items);
  const spacingDeg = overlapOffsetDeg(spacingPx);
  // Fast path (zoom/pan OR returning to an already-built scope): geometry,
  // styles, runs, shift vectors and lane multipliers are unchanged — only
  // re-express the pixel lane spacing in degrees and re-translate the pick
  // lanes if the zoom drifted since this scope was last shown.
  const cachedBundle = sig ? _deckRecordsCacheBySig.get(sig) : null;
  if (cachedBundle) {
    if (spacingDeg !== cachedBundle.spacingDeg) {
      cachedBundle.records.forEach((r) => {
        if (r.overlapCount > 1) {
          r.pickPath = applyLaneShift(
            r.path,
            r.shiftX,
            r.shiftY,
            r.laneMult * spacingDeg,
          );
          r.pickWidth = Math.max(spacingPx, 6);
        }
      });
      cachedBundle.spacingDeg = spacingDeg;
    }
    // Per-scope flags must be restored on a cross-scope cache hit (they are
    // module-level state written by the build below).
    _deckHasOverlaps = cachedBundle.hasOverlaps;
    _lastOverlapSpacingDeg = spacingDeg;
    return cachedBundle;
  }
  const overlap = getDeckOverlapMapCached(items);
  _deckHasOverlaps = false;
  const records = [];
  const expandRecords = [];
  const groupInfo = new Map();
  items.forEach((item) => {
    const train = item.train;
    const feature = item.feature;
    const tid = train && train.id;
    const ridden =
      feature.properties && feature.properties.ride_segment === true;
    if (ridden && !riddenFeatureVisible(feature)) return; // category toggled off
    const rgb = hexToRgb(
      train.style && train.style.color
        ? train.style.color
        : DEFAULT_TRAIN_COLOR,
    );
    const scopeFlags = routeRecordScopeFlags(train);
    // Which calendar day THIS piece of the itinerary runs on. Identical to the
    // train's own date unless the train crosses midnight, in which case the
    // stretch past the day break carries the next date and draws dashed while
    // the neighbouring day is selected (see RailMap.setDateScope).
    const daySpan = getTrainDaySpan(train);
    const edate = segmentDateForTrain(
      daySpan,
      Number(feature.properties?.segment_index ?? 0),
    );
    const { opacity, width } = routeSegmentStyleValues(
      train,
      ridden,
      scopeFlags,
    );
    if (opacity <= 0) return; // hidden trains contribute nothing to the GPU buffer
    // Off-date trains still DRAW (dimmed) while a day is active, but they are
    // not interactive: no hover, no tooltip, no click-select, no fan lanes.
    const noPick = scopeFlags.dimmed === true;
    const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
    const color = [rgb[0], rgb[1], rgb[2], alpha];
    getRouteLinePairs(feature).forEach(({ orig, keepIdx, segKeys }) => {
      if (!orig || orig.length < 2) return;
      const nSeg = orig.length - 1;
      // Per ORIGINAL segment: sharing-train set, this train's lane slot and
      // the signed lane multiplier (slots centered around the true track).
      const segIds = new Array(nSeg);
      const segSlot = new Array(nSeg);
      const segMult = new Array(nSeg);
      let lineHasOverlap = false;
      for (let i = 0; i < nSeg; i += 1) {
        // Off-date trains are excluded from the overlap map entirely: even
        // where their track coincides with a same-day shared corridor they
        // stay on the true track (no lane slot, no fan membership).
        const ids = noPick ? null : overlap.idsForKey(segKeys[i]);
        segIds[i] = ids;
        if (ids) {
          lineHasOverlap = true;
          segSlot[i] = overlap.slotFor(ids, tid);
          segMult[i] = segSlot[i] - (ids.size - 1) / 2;
        } else {
          segSlot[i] = 0;
          segMult[i] = 0;
        }
      }
      // ── bridge hair-thin overlap-key gaps ────────────────────────────────
      // A shared corridor interrupted by a SHORT single-train sliver (segIds
      // null) whose two neighbours carry the IDENTICAL sharing set is really
      // one continuous corridor: the sliver only lost its key to a micro-vertex
      // difference (see OVERLAP_BRIDGE_MAX_METERS). Re-attach it to that set so
      // the run below stays one piece — the fan no longer collapses+reopens as
      // the pointer slides across the sliver. Bridged segments are flagged so
      // they are excluded from the (cross-train-identical) groupKey, whose
      // members' keys diverge exactly here.
      const segBridged = new Array(nSeg).fill(false);
      if (!noPick) {
        let i = 0;
        while (i < nSeg) {
          if (segIds[i] !== null) {
            i += 1;
            continue;
          }
          let j = i;
          while (j < nSeg && segIds[j] === null) j += 1; // gap spans [i, j)
          const before = i > 0 ? segIds[i - 1] : null;
          const after = j < nSeg ? segIds[j] : null;
          if (before && before === after) {
            let gapM = 0;
            for (let k = i; k < j; k += 1)
              gapM += distanceMeters(orig[k], orig[k + 1]);
            if (gapM <= OVERLAP_BRIDGE_MAX_METERS) {
              const slot = overlap.slotFor(before, tid);
              const mult = slot - (before.size - 1) / 2;
              for (let k = i; k < j; k += 1) {
                segIds[k] = before;
                segSlot[k] = slot;
                segMult[k] = mult;
                segBridged[k] = true;
              }
              lineHasOverlap = true;
            }
          }
          i = j;
        }
      }
      if (lineHasOverlap) _deckHasOverlaps = true;
      // Maximal runs of constant overlap membership (Set identity — the same
      // instance for every sharing train, so run boundaries coincide exactly
      // across all of them and so do the derived groupKeys).
      const runs = [];
      let a = 0;
      for (let i = 1; i < nSeg; i += 1) {
        if (segIds[i] !== segIds[a]) {
          runs.push({ a, b: i });
          a = i;
        }
      }
      runs.push({ a, b: nSeg }); // each run spans original vertices [a .. b]
      // Drawn vertices: the simplified subset + the exact run boundaries.
      const drawnIdx = mergeDrawnIndices(keepIdx, runs, nSeg);
      const drawn = new Array(drawnIdx.length);
      const posOf = new Map(); // original index -> position in drawn
      for (let k = 0; k < drawnIdx.length; k += 1) {
        drawn[k] = orig[drawnIdx[k]];
        posOf.set(drawnIdx[k], k);
      }

      // ── base + pick records, one per run ──
      // The visible line stays on its TRUE track at full width (no permanent
      // fan-out). The invisible PICK target is translated into per-train
      // lanes; hovering an overlapped run temporarily shows every member
      // train's COMPLETE course rigidly translated into those lanes
      // (railmap.js + the expand record below). groupKey identifies the
      // shared run: its smallest ORIGINAL segment key is identical for every
      // train sharing it, whichever way each train traverses the track and
      // however each geometry was simplified.
      runs.forEach(({ a: ra, b: rb }) => {
        const ka = posOf.get(ra);
        const kb = posOf.get(rb);
        const runLine = drawn.slice(ka, kb + 1);
        if (runLine.length < 2) return;
        const ids = segIds[ra];
        const n = ids ? ids.size : 1;
        const mult = segMult[ra];
        let groupKey = "";
        if (n > 1) {
          // Smallest ORIGINAL segment key in the run — but only over segments
          // that are NATIVELY shared. A bridged sliver carries this train's
          // own key, which differs across members, so including it could hand
          // two members different groupKeys and split one fan in two. Every
          // bridged run still contains its shared flank segments, so a real
          // key is always found.
          for (let i = ra; i < rb; i += 1) {
            if (segBridged[i]) continue;
            const interactionKey = overlap.groupKeyForKey(segKeys[i]);
            if (groupKey === "" || interactionKey < groupKey)
              groupKey = interactionKey;
          }
          if (groupKey === "") {
            groupKey = overlap.groupKeyForKey(segKeys[ra]);
            for (let i = ra + 1; i < rb; i += 1) {
              const interactionKey = overlap.groupKeyForKey(segKeys[i]);
              if (interactionKey < groupKey) groupKey = interactionKey;
            }
          }
        }
        // One shift vector + lane multipliers per GROUP. The shift direction
        // is the perpendicular of the CHORD joining the overlap run's start
        // and end points (a straight start-station → end-station line), so
        // the whole fan translates along ONE consistent axis no matter where
        // on the run the pointer hovers or how the track curves in between.
        // The chord is canonically oriented (lexicographic endpoint order)
        // so every sharing train derives the identical vector; sx is
        // pre-divided by cos(latRef) so the shift spans the same PIXEL
        // distance regardless of heading.
        let gi = null;
        if (n > 1) {
          gi = groupInfo.get(groupKey);
          if (!gi) {
            let latSum = 0;
            for (let i = ra; i < rb; i += 1)
              latSum += (orig[i][1] + orig[i + 1][1]) / 2;
            const latRef = latSum / (rb - ra);
            const coslatRef = Math.cos((latRef * Math.PI) / 180) || 1e-6;
            // Chord endpoints in canonical (train-independent) order.
            let pa = orig[ra];
            let pb = orig[rb];
            if (pb[0] < pa[0] || (pb[0] === pa[0] && pb[1] < pa[1])) {
              const t = pa;
              pa = pb;
              pb = t;
            }
            let dx = (pb[0] - pa[0]) * coslatRef;
            let dy = pb[1] - pa[1];
            let len = Math.hypot(dx, dy);
            if (len < 1e-9) {
              // Degenerate chord (run starts and ends at the same station,
              // e.g. a loop): fall back to the canonical dominant direction.
              dx = 0;
              dy = 0;
              for (let i = ra; i < rb; i += 1) {
                const d = overlap.dirForKey(segKeys[i], overlapNodeKey(orig[i]));
                const latMid = (orig[i][1] + orig[i + 1][1]) / 2;
                const coslat = Math.cos((latMid * Math.PI) / 180) || 1e-6;
                dx += (orig[i + 1][0] - orig[i][0]) * coslat * d;
                dy += (orig[i + 1][1] - orig[i][1]) * d;
              }
              len = Math.hypot(dx, dy) || 1;
            }
            const mults = {};
            ids.forEach((id) => {
              mults[id] = overlap.slotFor(ids, id) - (ids.size - 1) / 2;
            });
            gi = {
              sx: dy / len / coslatRef, // right-hand perpendicular of chord
              sy: -dx / len,
              mults,
              // Run endpoints, geometry + reference latitude, kept for the
              // corridor stitching pass below (which builds the smoothed
              // corridor curve and the fallback unified vector).
              _pa: orig[ra],
              _pb: orig[rb],
              _line: runLine,
              _lines: [runLine],
              _latRef: latRef,
              _nearParallel: overlap.nearGroupInfo(groupKey),
            };
            groupInfo.set(groupKey, gi);
          } else {
            // A near-parallel interaction key can be encountered on more than
            // one physical run. Keep distinct geometry here; after every
            // record has been seen, rebuildGroupRepresentativeGeometry joins
            // compatible sequential fragments and recomputes the whole axis.
            if (!gi._lines) gi._lines = [gi._line];
            const duplicate = gi._lines.some((other) => {
              const same =
                distanceMeters(other[0], runLine[0]) <= 0.05 &&
                distanceMeters(other[other.length - 1], runLine[runLine.length - 1]) <=
                  0.05;
              const reverse =
                distanceMeters(other[0], runLine[runLine.length - 1]) <= 0.05 &&
                distanceMeters(other[other.length - 1], runLine[0]) <= 0.05;
              return same || reverse;
            });
            if (!duplicate) gi._lines.push(runLine);
          }
        }
        records.push({
          path: runLine,
          pickPath: gi
            ? applyLaneShift(runLine, gi.sx, gi.sy, mult * spacingDeg)
            : runLine,
          shiftX: gi ? gi.sx : 0,
          shiftY: gi ? gi.sy : 0,
          laneMult: mult,
          color,
          width,
          train,
          feature,
          pickWidth: n > 1 ? Math.max(spacingPx, 6) : Math.max(width + 4, 10),
          overlapCount: n,
          overlapSlot: segSlot[ra],
          groupKey,
          nopick: noPick,
          tdate: getTrainDate(train),
          edate,
          dspan: daySpan.key,
        });
      });

      // ── one expand record for the whole line (true-track geometry) ──
      // Every line of every train gets one, so a hovered group can translate
      // each member train's COMPLETE course intact — including sections that
      // overlap nothing.
      expandRecords.push({ path: drawn, color, width, train });
    });
  });

  // ── one shift axis per contiguous CORRIDOR ──
  // A single visual overlap corridor is usually split into many runs (the
  // source geometry is chopped into per-feature LineStrings), so each run
  // got its own chord above and the fan direction changed as the pointer
  // moved between runs. Stitch together groups whose member-train sets are
  // identical and whose runs touch end-to-end, then give the whole chain ONE
  // shift vector: the perpendicular of the straight line joining the
  // corridor's overall start and end points. Hovering anywhere along the
  // corridor now fans along the same axis.
  if (groupInfo.size > 0) {
    groupInfo.forEach((gi) => rebuildGroupRepresentativeGeometry(gi));
    const parent = new Map();
    const find = (k) => {
      let r = k;
      while (parent.get(r) !== r) r = parent.get(r);
      let c = k;
      while (parent.get(c) !== c) {
        const nx = parent.get(c);
        parent.set(c, r);
        c = nx;
      }
      return r;
    };
    const union = (a, b) => {
      parent.set(find(a), find(b));
    };
    groupInfo.forEach((gi, key) => {
      parent.set(key, key);
      gi._sig = Object.keys(gi.mults).sort().join("|"); // membership signature
    });
    // Select one geometrically continuous partner per run endpoint.  Matching
    // by proximity as well as snapped identity closes feature seams; greedy
    // one-to-one pairing prevents a nearby fork from merging into the chain.
    const endpoints = [];
    groupInfo.forEach((gi, key) => {
      [gi._pa, gi._pb].forEach((p, side) => {
        const out = corridorEndpointOutward(gi, side);
        if (out)
          endpoints.push({
            id: key + "::" + side,
            key,
            side,
            p,
            out,
            sig: gi._sig,
            nearParallel: Boolean(gi._nearParallel),
          });
      });
    });
    const cellDeg = Math.max(1e-6, OVERLAP_CORRIDOR_JOIN_METERS / 80000);
    const buckets = new Map();
    const candidates = [];
    endpoints.forEach((end) => {
      const gx = Math.floor(end.p[0] / cellDeg);
      const gy = Math.floor(end.p[1] / cellDeg);
      for (let dx = -2; dx <= 2; dx += 1)
        for (let dy = -1; dy <= 1; dy += 1) {
          const list = buckets.get(end.sig + "::" + (gx + dx) + "," + (gy + dy));
          if (!list) continue;
          list.forEach((other) => {
            const match = corridorEndpointPair(other, end);
            if (match) candidates.push({ a: other, b: end, ...match });
          });
        }
      const bk = end.sig + "::" + gx + "," + gy;
      let list = buckets.get(bk);
      if (!list) buckets.set(bk, (list = []));
      list.push(end);
    });
    candidates.sort((a, b) => a.score - b.score);
    const joins = selectOneToOneEndpointPairs(candidates, 8);
    joins.forEach((join) => {
      union(join.a.key, join.b.key);
    });
    // Per component: endpoint degrees, so the corridor's global start/end
    // are the endpoints touched by exactly one run.
    const comps = new Map(); // root → { keys, eps: Map(ck → {p, n}), latSum, n }
    groupInfo.forEach((gi, key) => {
      const root = find(key);
      let c = comps.get(root);
      if (!c)
        comps.set(
          root,
          (c = { keys: [], keySet: new Set(), eps: new Map(), latSum: 0, n: 0 }),
        );
      c.keys.push(key);
      c.keySet.add(key);
      c.latSum += gi._latRef;
      c.n += 1;
      [gi._pa, gi._pb].forEach((p) => {
        const ck = overlapNodeKey(p);
        const e = c.eps.get(ck);
        if (e) e.n += 1;
        else c.eps.set(ck, { p, n: 1 });
      });
    });
    const corridorAliases = new Map();
    const corridorMasters = new Set();
    comps.forEach((c) => {
      const componentJoins = joins.filter(
        (j) => c.keySet.has(j.a.key) && c.keySet.has(j.b.key),
      );
      const usePerRunCurves = () => {
        c.keys.forEach((k) => {
          const g = groupInfo.get(k);
          corridorAliases.set(k, k);
          corridorMasters.add(k);
          g._corridorJoins = [];
          g.curve = smoothStandaloneCorridorRun(g._line, false);
        });
      };
      const lone = c.keys.length === 1 ? groupInfo.get(c.keys[0]) : null;
      const isClosed =
        (c.keys.length > 1 && componentJoins.length === c.keys.length) ||
        (lone &&
          lone._line &&
          lone._line.length > 3 &&
          distanceMeters(lone._pa, lone._pb) <= OVERLAP_SNAP_METERS);
      if (isClosed) {
        // An open B-spline would insert an arbitrary seam into this cycle.
        // A multi-run cycle can keep its open member runs independently. A
        // single self-closing run has no safe seam at all, so use only its
        // static group vector until a periodic solver is available.
        if (lone) {
          const key = c.keys[0];
          corridorAliases.set(key, key);
          corridorMasters.add(key);
          lone._corridorJoins = [];
          lone.curve = smoothStandaloneCorridorRun(lone._line, true);
        } else usePerRunCurves();
        return;
      }
      // Smoothed corridor centerline: chain the member runs end-to-end and
      // normalize into a very smooth curve. railmap.js derives the fan's
      // shift direction from this curve's LOCAL perpendicular under the
      // pointer, so the direction turns smoothly as the pointer moves.
      const chain = buildCorridorChain(c, groupInfo, joins);
      const curve = chain ? smoothCorridorCurve(chain) : null;
      const canonicalKey = c.keys.slice().sort()[0];
      const master = groupInfo.get(canonicalKey);
      const nearInfos = c.keys
        .map((k) => groupInfo.get(k)._nearParallel)
        .filter(Boolean);
      if (curve) curve.nearParallel = nearInfos.length > 0;
      if (nearInfos.length) {
        master._nearParallel = {
          pairCount: Math.max(...nearInfos.map((info) => info.pairCount || 0)),
          maxSeparationMeters: Math.max(
            ...nearInfos.map((info) => info.maxSeparationMeters || 0),
          ),
          thresholdMeters: Math.max(
            ...nearInfos.map((info) => info.thresholdMeters || 0),
          ),
        };
      }
      if (!curve && c.keys.length > 1) {
        // The unified candidate failed at least one final hard constraint.
        // Preserve independently validated runs instead of publishing a
        // geometrically invalid shared direction field.
        usePerRunCurves();
        return;
      }
      corridorMasters.add(canonicalKey);
      c.keys.forEach((k) => corridorAliases.set(k, canonicalKey));
      master._corridorJoins = componentJoins.filter((j) => j.metres > 0.05);
      if (curve)
        c.keys.forEach((k) => {
          groupInfo.get(k).curve = curve;
        });
      if (c.keys.length < 2) return; // lone run keeps its own chord
      const ends = [];
      c.eps.forEach((e) => {
        if (e.n === 1) ends.push(e.p);
      });
      if (ends.length < 2) return; // closed loop: keep per-run vectors
      const coslat = Math.cos(((c.latSum / c.n) * Math.PI) / 180) || 1e-6;
      // Farthest pair of degree-1 endpoints = corridor start / end stations
      // (robust even if a branch gives more than two loose ends).
      let pa = ends[0];
      let pb = ends[1];
      let best = -1;
      for (let i = 0; i < ends.length; i += 1)
        for (let j = i + 1; j < ends.length; j += 1) {
          const ddx = (ends[j][0] - ends[i][0]) * coslat;
          const ddy = ends[j][1] - ends[i][1];
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 > best) {
            best = d2;
            pa = ends[i];
            pb = ends[j];
          }
        }
      if (pb[0] < pa[0] || (pb[0] === pa[0] && pb[1] < pa[1])) {
        const t = pa;
        pa = pb;
        pb = t;
      }
      const dx = (pb[0] - pa[0]) * coslat;
      const dy = pb[1] - pa[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return;
      const sx = dy / len / coslat;
      const sy = -dx / len;
      c.keys.forEach((k) => {
        const g = groupInfo.get(k);
        g.sx = sx;
        g.sy = sy;
      });
    });
    // Collapse all runs in one continuous corridor onto ONE interaction key.
    // Previously only the curve was shared: the open fan moved the current
    // run's pick lane but left the adjacent run on the true track, so crossing
    // the run boundary produced a miss/collapse/reopen flash.
    const representative = new Map();
    records.forEach((r, index) => {
      if (r.overlapCount <= 1 || !r.groupKey) return;
      const canonicalKey = corridorAliases.get(r.groupKey) || r.groupKey;
      const g = groupInfo.get(canonicalKey);
      r.groupKey = canonicalKey;
      if (g) {
        r.shiftX = g.sx;
        r.shiftY = g.sy;
        r.pickPath = applyLaneShift(r.path, g.sx, g.sy, r.laneMult * spacingDeg);
      }
      const tid = r.train && r.train.id;
      const rk = canonicalKey + "::" + tid;
      if (!representative.has(rk)) representative.set(rk, index);
    });
    corridorMasters.forEach((canonicalKey) => {
      const g = groupInfo.get(canonicalKey);
      g.pickBridges = [];
      (g._corridorJoins || []).forEach((join) => {
        Object.keys(g.mults).forEach((tid) => {
          const index = representative.get(canonicalKey + "::" + tid);
          if (index === undefined) return;
          g.pickBridges.push({
            path: [join.a.p, join.b.p],
            tid,
            idx: index,
            laneMult: g.mults[tid],
            pickWidth: Math.max(spacingPx, 8),
          });
        });
      });
    });
    // Only canonical entries remain addressable by railmap.js.
    [...groupInfo.keys()].forEach((key) => {
      const canonicalKey = corridorAliases.get(key);
      if (canonicalKey && canonicalKey !== key) groupInfo.delete(key);
    });
    // Membership changes at stations create separate corridor curves. Round
    // their shared endpoints only after aliases collapse, so each physical
    // curve is edited once and both sides receive the exact same tangent.
    smoothCurveStationJoins(groupInfo);
  }

  const bundle = {
    records,
    expandRecords,
    groupInfo,
    spacingDeg,
    hasOverlaps: _deckHasOverlaps,
  };
  if (sig) _deckCachePut(_deckRecordsCacheBySig, sig, bundle);
  _lastOverlapSpacingDeg = spacingDeg;
  return bundle;
}


// Flatten the visible trains' stop + pass-through markers into deck.gl
// ScatterplotLayer records. Fill/line colours, radius and stroke width are
// precomputed to match renderStopMarker() / renderPassThroughMarker()
// exactly (radius + width are in screen pixels). category lets the layers
// control toggle "Stops" / "Pass-through Stations" independently.
function deckMarkerRecord(feature, train, opts, kind) {
  const p = feature.properties || {};
  const coord = getFeatureDisplayCoordinate(feature);
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const focused = opts.focused === true;
  const dimmed = opts.dimmed === true;
  let s;
  let category;
  let role;
  if (kind === "pass") {
    s = passThroughMarkerStyleValues(p.ride_segment !== false, {
      focused,
      dimmed,
    });
    category = "pass";
    role = "pass";
  } else {
    // The actual boarding/alighting boundary is a large filled terminal.
    // Intermediate stops use the same white outer circle as pass-throughs;
    // buildDeckMarkerRecords adds their small black center as a second record.
    s = stopMarkerStyleValues(p.ride_segment === true, p.ride_boundary === true, {
      focused,
      dimmed,
    });
    category = "stop";
    role = p.ride_boundary === true ? "terminal" : "stop";
  }
  // Alpha is carried as its own value (not premultiplied into the colours):
  // the base marker layers draw it via circle-opacity while the SEL layers
  // override it to 1, so a selected off-date train's dots un-dim without any
  // record rebuild. fillOpacity === lineOpacity in every style helper.
  return {
    position: [coord[0], coord[1]],
    radius: s.radius,
    lineWidth: s.lineWidth,
    fillColor: [s.fill[0], s.fill[1], s.fill[2]],
    lineColor: [s.strokeCol[0], s.strokeCol[1], s.strokeCol[2]],
    alpha: s.fillOpacity,
    category,
    role,
    focusScale: role === "terminal" ? 1 : 0.5,
    feature,
    train,
    // Off-date dots draw dimmed (paint-level, via tdate) but are not
    // hover/click targets.
    nopick: dimmed === true,
    tdate: getTrainDate(train),
    dspan: getTrainDaySpan(train).key,
  };
}

// Computed pass-through stations only depend on a train's route_sections +
// ride flags (never on focus / selection / zoom), but resolving every passed
// station for all 67 trains is costly. Memoize so a focus-only change (a
// route/marker click) doesn't recompute them — this is the main fix for the
// on-click latency now that markers rebuild on the GPU on every selection.
const _computedPassThroughCache = new Map();
// Every stop/section edit mints a new key, so cap the cache (simple FIFO
// eviction) to keep long editing sessions from growing it without bound.
const _COMPUTED_PASS_CACHE_MAX = 300;
function getComputedPassThroughFeaturesCached(train) {
  const key = `${train.id}|${getTrainRouteTemplateKey(train)}|${(train.stops || []).map((s) => (s.ride_segment ? 1 : 0)).join("")}`;
  let v = _computedPassThroughCache.get(key);
  if (!v) {
    v = getComputedPassThroughFeatures(train);
    if (_computedPassThroughCache.size >= _COMPUTED_PASS_CACHE_MAX) {
      const oldest = _computedPassThroughCache.keys().next().value;
      _computedPassThroughCache.delete(oldest);
    }
    _computedPassThroughCache.set(key, v);
  }
  return v;
}

// Every ridden station draws a dot. The first and last effectively-ridden
// stops are large filled terminals; intermediate stops and pass-throughs use
// the same small white circle with an ink ring, with a black center added only
// to intermediate stops.
// SELECTION-INDEPENDENT: pass-through dots are always emitted (the layer
// minzoom gates them) and focus flags are never baked, so the record set only
// changes with the route signature / display settings.
function buildDeckMarkerRecords(orderedTrains) {
  const records = [];
  (orderedTrains || []).forEach((train) => {
    if (train.visible === false) return;
    const opts = routeRecordScopeFlags(train);
    const stops = train.stops || [];
    // First + last effectively-ridden stopping station = the black-dot pair.
    const ridden = [];
    stops.forEach((stop, idx) => {
      if (stop.stop_type === "pass_through") return;
      if (!effectiveStopRide(stops, idx)) return;
      ridden.push(idx);
    });
    const boundarySet = new Set(
      ridden.length ? [ridden[0], ridden[ridden.length - 1]] : [],
    );
    // Cross-day break stations (jsonspec §13.6): the last station of each
    // outgoing day gets ONE diamond instead of its ordinary dot — the same
    // station reads as "day D ends here" and "day D+1 starts here".
    const daySpan = getTrainDaySpan(train);
    const xdayStops = daySpan.breaks.length
      ? new Set(daySpan.breaks.map((b) => b.index))
      : null;
    // Category filter (新幹線/JR在來線/地下鐵/私鐵): only resolved when at
    // least one toggle is off, so the default path pays nothing extra.
    const catFilterOn = anyRiddenCategoryHidden();
    stops.forEach((stop, idx) => {
      const stopFeature = getStopFeature(stop, train);
      if (!stopFeature) return;
      const isPass = stopFeature.properties.stop_type === "pass_through";
      // Hidden (not effectively ridden) markers are dropped entirely.
      const eff = effectiveStopRide(stops, idx);
      if (!eff) return;
      if (catFilterOn) {
        const st = resolveStationForTrain(stop, train);
        const cat = st ? markerCategoryForStation(st) : null;
        if (cat && RIDDEN_CATEGORY_FILTER[cat] === false) return;
      }
      stopFeature.properties.ride_segment = eff;
      stopFeature.properties.ride_boundary = boundarySet.has(idx);
      const rec = deckMarkerRecord(
        stopFeature,
        train,
        opts,
        isPass ? "pass" : "stop",
      );
      if (rec && xdayStops && xdayStops.has(idx)) {
        // The diamond REPLACES this station's dot (a dot underneath would
        // only peek out around the icon). Its own symbol layer draws it, so
        // only category/role and the radius the icon scales from matter.
        rec.category = "xday";
        rec.role = "xday";
        // A diamond of half-diagonal r covers half the area of a circle of the
        // same r, so match the terminal dot's visual weight by growing it.
        rec.radius = Math.max(rec.radius, DISPLAY.terminalRadius) * 1.35;
        records.push(rec);
        return;
      }
      if (rec) records.push(rec);
      // 中途停靠站: pass-through-sized circle + BLACK center dot (the black
      // core is a second record on the same layer, drawn on top).
      if (
        rec &&
        !isPass &&
        stopFeature.properties.ride_boundary !== true
      ) {
        const centerRadius = stopCenterRadius(rec.radius);
        records.push({
          ...rec,
          radius: centerRadius,
          lineWidth: 0,
          fillColor: [26, 26, 26],
          lineColor: [26, 26, 26],
          role: "stop-center",
          // Preserve the center/outer ratio when selected focus enlarges both.
          focusScale: (centerRadius / rec.radius) * 0.5,
          nopick: true,
        });
      }
    });
    getComputedPassThroughFeaturesCached(train).forEach((feature) => {
      if (feature.properties && feature.properties.ride_segment === false)
        return;
      if (catFilterOn) {
        const cat = markerCategoryForStation(feature);
        if (cat && RIDDEN_CATEGORY_FILTER[cat] === false) return;
      }
      const rec = deckMarkerRecord(feature, train, opts, "pass");
      if (rec) records.push(rec);
    });
  });
  return records;
}

// Marker click -> select train + open the stop popup at the marker. Same
// off-date guard + stage-1/stage-2 popup gating as handleDeckRouteClick.
function handleDeckMarkerClick(info) {
  const hit = interactiveTrainFromClick(info);
  if (!hit) return;
  pickTrain(hit.train.id);
  if (hit.selectsNow && info.coordinate && map) {
    openClickPopup(info.coordinate, buildStopPopup(hit.feature, hit.train));
  }
}

function routeCoordinateSegmentKey(a, b) {
  return [coordKey(a), coordKey(b)].sort().join("|");
}

function getComputedPassThroughFeatures(train) {
  const explicitKeys = new Set();
  (train.stops || []).forEach((stop) =>
    stationLookupKeys(stopName(stop), stopStationCode(stop)).forEach((key) =>
      explicitKeys.add(key),
    ),
  );
  const computed = [];
  const seen = new Set(explicitKeys);
  getRideRouteSectionsForTrain(train).forEach((section) => {
    [
      { name: section.from, n02_station_code: section.from_n02_station_code },
      { name: section.to, n02_station_code: section.to_n02_station_code },
    ].forEach((candidate) => {
      const station = resolveStationForTrain(candidate, train);
      if (!station) return;
      const keys = stationLookupKeys(
        stationName(station),
        stationCode(station),
      );
      if (keys.some((key) => seen.has(key))) return;
      keys.forEach((key) => seen.add(key));
      computed.push({
        type: "Feature",
        properties: {
          name: stationName(station),
          n02_station_code: stationCode(station),
          n02_group_code: stationGroupCode(station),
          // station's own N02 line attributes — the ridden-category marker
          // filter classifies computed pass-throughs from these
          N02_001: station.properties?.N02_001 || "",
          N02_002: station.properties?.N02_002 || "",
          N02_004: station.properties?.N02_004 || "",
          stop_type: "pass_through",
          pass_through_computed: true,
          train_id: train.id,
          train_type: train.train_type || "",
          company: train.company || "",
          number: train.number,
          line_name: stationLineName(station),
          operator: stationOperator(station),
          source: "computed from route_sections",
        },
        geometry: {
          type: "Point",
          coordinates: getFeatureDisplayCoordinate(station),
        },
      });
    });
  });
  return computed;
}
