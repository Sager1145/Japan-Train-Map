/*
 * railmap-geometry.js — record → GeoJSON conversion + overlap-fan geometry.
 *
 * Pure functions turning the app's route / marker / expand records into the
 * FeatureCollections the RailMap sources consume, plus the fitted-curve
 * sampling (curvePointAt / fanPerpAt) that places and animates the
 * overlap-lane fans, their diagnostics, and the hover-region debug shapes.
 *
 * Publishes the RailMapGeometry global (consumed by railmap.js).
 */
(function (global) {
  "use strict";

  const {
    EMPTY_FC,
    HOVER_PICK_PAD_PX,
    HOVER_FAN_HOLD_PX,
    HOVER_GROUP_SWITCH_PX,
  } = global.RailMapStyle;

  // ───────────────────────────── record → GeoJSON conversion ─────────────────────────────
  function rgbaCss(arr) {
    if (!Array.isArray(arr)) return "rgba(0,0,0,1)";
    const a = arr.length > 3 ? arr[3] / 255 : 1;
    return "rgba(" + arr[0] + "," + arr[1] + "," + arr[2] + "," + +a.toFixed(3) + ")";
  }

  function routeRecordsToFC(records) {
    return {
      type: "FeatureCollection",
      features: records.map((r, i) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: r.path },
        properties: {
          idx: i,
          tid: (r.train && r.train.id) || "",
          tdate: r.tdate || "",
          color: "rgb(" + r.color[0] + "," + r.color[1] + "," + r.color[2] + ")",
          alpha: r.color.length > 3 ? r.color[3] / 255 : 1,
          width: r.width,
        },
      })),
    };
  }

  // Pick geometry — STATE-AWARE. Hover must only trigger directly ON a
  // visible line, never across the not-yet-expanded fan region:
  //   collapsed  -> every record's hit geometry sits on the TRUE TRACK
  //                 (where the line is actually drawn), narrow width;
  //   fan open   -> ONLY the open group's member records move to their
  //                 per-lane offset paths (matching the visibly fanned
  //                 lines; the spacing-wide lanes tile the corridor so the
  //                 pointer can slide between the parallel lines).
  // `idx` maps a picked feature back to the full record in _records
  // (tooltip lane info, click target, group key).
  function routePickRecordsToFC(
    records,
    groupInfo,
    openGroup,
    fanDir,
    fanSpacingDeg,
    transition,
  ) {
    const features = records.map((r, i) => {
      const tid = (r.train && r.train.id) || "";
      const transitioning = Boolean(
        transition &&
          (r.groupKey === transition.fromGroup ||
            r.groupKey === transition.toGroup),
      );
      const fanned = Boolean(
        transitioning || (openGroup && r.groupKey === openGroup),
      );
      // Fanned hit areas follow the CURRENT dynamic fan direction (the
      // smoothed-corridor perpendicular under the pointer) so they always
      // sit on the visibly fanned lines; static pickPath is the fallback.
      let coords = r.path;
      if (fanned) {
        if (transitioning) {
          const off = transitionOffsetForTid(
            transition,
            tid,
            fanSpacingDeg,
            fanDir,
          );
          coords = r.path.map((p) => [p[0] + off.dx, p[1] + off.dy]);
        } else if (fanDir && r.laneMult != null && fanSpacingDeg) {
          const dx = fanDir.sx * r.laneMult * fanSpacingDeg;
          const dy = fanDir.sy * r.laneMult * fanSpacingDeg;
          coords = r.path.map((p) => [p[0] + dx, p[1] + dy]);
        } else {
          coords = r.pickPath || r.path;
        }
      }
      return {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: coords,
        },
        properties: {
          idx: i,
          tid,
          pickWidth:
            fanned && r.pickWidth != null
              ? r.pickWidth
              : Math.max(r.width + 8, 14),
          nopick: r.nopick ? 1 : 0,
        },
      };
    });
    // Source-feature seams have no visible geometry between their endpoints,
    // but they are part of the same overlap corridor. Tiny pick-only bridges
    // keep that corridor continuous both before and after the fan opens.
    if (groupInfo)
      groupInfo.forEach((gi, groupKey) => {
        (gi.pickBridges || []).forEach((bridge) => {
          const transitioning = Boolean(
            transition &&
              (groupKey === transition.fromGroup ||
                groupKey === transition.toGroup),
          );
          const fanned = Boolean(
            transitioning || (openGroup && groupKey === openGroup),
          );
          let coords = bridge.path;
          if (fanned) {
            let dx;
            let dy;
            if (transitioning) {
              const off = transitionOffsetForTid(
                transition,
                bridge.tid,
                fanSpacingDeg,
                fanDir,
              );
              dx = off.dx;
              dy = off.dy;
            } else {
              const d = fanDir || gi;
              dx = d.sx * bridge.laneMult * fanSpacingDeg;
              dy = d.sy * bridge.laneMult * fanSpacingDeg;
            }
            coords = bridge.path.map((p) => [p[0] + dx, p[1] + dy]);
          }
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: coords },
            properties: {
              idx: bridge.idx,
              tid: bridge.tid,
              pickWidth: bridge.pickWidth,
              nopick: 0,
            },
          });
        });
      });
    return { type: "FeatureCollection", features };
  }

  // HOVER-EXPAND geometry for ONE hovered group: every member train's
  // complete course (all its lines), RIGIDLY translated into its lane by the
  // group's constant shift vector — corners, radii and lengths untouched
  // (colorA has the record's alpha baked in). `gi` comes from app.js's
  // buildDeckRouteRecords groupInfo; spacingDeg is the current lane spacing.
  function routeExpandFC(expandRecords, gi, spacingDeg, dir) {
    if (!gi) return EMPTY_FC;
    const d = dir || gi; // dynamic hover direction, else the static vector
    const features = [];
    expandRecords.forEach((r, i) => {
      const tid = (r.train && r.train.id) || "";
      const mult = gi.mults[tid];
      if (mult === undefined) return; // not a member of the hovered group
      const dx = d.sx * mult * spacingDeg;
      const dy = d.sy * mult * spacingDeg;
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: r.path.map((p) => [p[0] + dx, p[1] + dy]),
        },
        properties: {
          idx: i,
          tid,
          colorA: rgbaCss(r.color),
          width: r.width,
        },
      });
    });
    return { type: "FeatureCollection", features };
  }

  function transitionOffsetForTid(transition, tid, spacingDeg, toDir) {
    const fromGi = transition.fromGi;
    const toGi = transition.toGi;
    const hasFromOffset =
      transition.fromOffsets &&
      Object.prototype.hasOwnProperty.call(transition.fromOffsets, tid);
    const fromMult =
      !hasFromOffset &&
      fromGi &&
      Object.prototype.hasOwnProperty.call(fromGi.mults, tid)
        ? fromGi.mults[tid]
        : 0;
    const toMult =
      toGi && Object.prototype.hasOwnProperty.call(toGi.mults, tid)
        ? toGi.mults[tid]
        : 0;
    const fromDir = transition.fromDir || fromGi || { sx: 0, sy: 0 };
    const nextDir = toDir || toGi || { sx: 0, sy: 0 };
    const t = Math.max(0, Math.min(1, transition.progress || 0));
    const ox = hasFromOffset
      ? transition.fromOffsets[tid].x * spacingDeg
      : fromDir.sx * fromMult * spacingDeg;
    const oy = hasFromOffset
      ? transition.fromOffsets[tid].y * spacingDeg
      : fromDir.sy * fromMult * spacingDeg;
    const nx = nextDir.sx * toMult * spacingDeg;
    const ny = nextDir.sy * toMult * spacingDeg;
    return { dx: ox + (nx - ox) * t, dy: oy + (ny - oy) * t };
  }

  // Interpolate the UNION of two overlap groups. Shared trains travel directly
  // from their old lane to the new one; old-only trains glide home while
  // new-only trains leave the true track. No source swap is visually exposed.
  function routeExpandTransitionFC(
    expandRecords,
    transition,
    spacingDeg,
    toDir,
  ) {
    if (!transition || !transition.fromGi || !transition.toGi) return EMPTY_FC;
    const features = [];
    expandRecords.forEach((r, i) => {
      const tid = (r.train && r.train.id) || "";
      if (
        !(
          transition.fromOffsets &&
          Object.prototype.hasOwnProperty.call(transition.fromOffsets, tid)
        ) &&
        !Object.prototype.hasOwnProperty.call(transition.fromGi.mults, tid) &&
        !Object.prototype.hasOwnProperty.call(transition.toGi.mults, tid)
      )
        return;
      const off = transitionOffsetForTid(
        transition,
        tid,
        spacingDeg,
        toDir,
      );
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: r.path.map((p) => [p[0] + off.dx, p[1] + off.dy]),
        },
        properties: {
          idx: i,
          tid,
          colorA: rgbaCss(r.color),
          width: r.width,
        },
      });
    });
    return { type: "FeatureCollection", features };
  }

  function curvePointAt(curve, metres) {
    const pts = curve.pts;
    const cum = curve.cum;
    const target = Math.max(0, Math.min(curve.totalMeters, metres));
    let lo = 0;
    let hi = cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid;
      else hi = mid;
    }
    const span = cum[lo + 1] - cum[lo] || 1;
    const t = (target - cum[lo]) / span;
    return [
      pts[lo][0] + (pts[lo + 1][0] - pts[lo][0]) * t,
      pts[lo][1] + (pts[lo + 1][1] - pts[lo][1]) * t,
    ];
  }

  // Continuous local perpendicular of the heavily low-passed corridor curve.
  // Direction is interpolated from app.js's precomputed broad-scale unit
  // tangents, so switching the nearest polyline segment cannot change the
  // fitting window. `hintS` keeps the projection on the same local branch at a
  // tiny protrusion/self-near bend; it yields only when a truly closer branch
  // is more than 70 physical metres away from the hinted neighbourhood.
  function fanPerpAt(curve, lngLat, hintS) {
    const pts = curve.pts;
    const cs = curve.coslat;
    const px = lngLat.lng * cs;
    const py = lngLat.lat;
    let globalHit = null;
    let localHit = null;
    const localRadius = Math.min(
      6500,
      Math.max(1200, (curve.radiusMeters || 800) * 2.4),
    );
    for (let i = 0; i < pts.length - 1; i += 1) {
      const ax = pts[i][0] * cs;
      const ay = pts[i][1];
      const vx = pts[i + 1][0] * cs - ax;
      const vy = pts[i + 1][1] - ay;
      const l2 = vx * vx + vy * vy || 1e-12;
      let t = ((px - ax) * vx + (py - ay) * vy) / l2;
      t = Math.max(0, Math.min(1, t));
      const dx = px - (ax + vx * t);
      const dy = py - (ay + vy * t);
      const d2 = dx * dx + dy * dy;
      const s = curve.cum[i] + (curve.cum[i + 1] - curve.cum[i]) * t;
      const hit = { d2, s, i, t, tx: vx, ty: vy };
      if (!globalHit || d2 < globalHit.d2) globalHit = hit;
      if (
        hintS != null &&
        Math.abs(s - hintS) <= localRadius &&
        (!localHit || d2 < localHit.d2)
      )
        localHit = hit;
    }
    if (!globalHit) return { x: 0, y: -1, s: 0, distance2: Infinity };
    const toleranceDeg = 70 / 111320;
    const hit =
      localHit && localHit.d2 <= globalHit.d2 + toleranceDeg * toleranceDeg
        ? localHit
        : globalHit;
    const dirs = curve.dirs;
    let tx;
    let ty;
    if (dirs && dirs[hit.i] && dirs[hit.i + 1]) {
      tx = dirs[hit.i][0] + (dirs[hit.i + 1][0] - dirs[hit.i][0]) * hit.t;
      ty = dirs[hit.i][1] + (dirs[hit.i + 1][1] - dirs[hit.i][1]) * hit.t;
    } else {
      // Compatibility with an older cached curve during hot reload.
      const radius = curve.radiusMeters || 800;
      const p0 = curvePointAt(curve, hit.s - radius);
      const p1 = curvePointAt(curve, hit.s + radius);
      tx = (p1[0] - p0[0]) * cs;
      ty = p1[1] - p0[1];
    }
    if (Math.hypot(tx, ty) < 1e-12) {
      tx = hit.tx;
      ty = hit.ty;
    }
    const len = Math.hypot(tx, ty) || 1;
    return {
      x: ty / len,
      y: -tx / len,
      s: hit.s,
      distance2: hit.d2,
    }; // right-hand perpendicular
  }

  function fitCurvesToFC(groupInfo) {
    const features = [];
    const seen = new Set();
    if (groupInfo)
      groupInfo.forEach((gi, groupKey) => {
        const curve = gi && gi.curve;
        if (!curve || seen.has(curve) || !curve.pts || curve.pts.length < 2)
          return;
        seen.add(curve);
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: curve.pts },
          properties: {
            groupKey,
            samples: curve.pts.length,
            lengthM: Math.round(curve.totalMeters || 0),
            radiusM: Math.round(curve.radiusMeters || 0),
            sigmaM: Math.round(curve.smoothingSigmaMeters || 0),
            requestedMinRadiusM: Math.round(
              curve.requestedMinRadiusMeters || 0,
            ),
            achievedMinRadiusM:
              curve.achievedMinRadiusMeters == null
                ? null
                : Math.round(curve.achievedMinRadiusMeters),
            achievedDirectionRadiusM:
              curve.achievedDirectionRadiusMeters == null
                ? null
                : Math.round(curve.achievedDirectionRadiusMeters),
            minDetailM: Math.round(curve.minDetailMeters || 0),
            maxDeviationM: Math.round(curve.maxDeviationMeters || 0),
            actualMaxDeviationM: Math.round(
              curve.actualMaxDeviationMeters || 0,
            ),
            fitType: curve.fitType || "",
          },
        });
      });
    return { type: "FeatureCollection", features };
  }

  function angleDelta(a, b) {
    if (!a || !b) return 0;
    const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y));
    return (Math.acos(dot) * 180) / Math.PI;
  }

  // Deterministic pointer-equivalent sweep over EVERY fitted overlap curve.
  // Each sample is projected through fanPerpAt with the previous arc position
  // as its hint, exactly like a real mouse traversal. The compact report is
  // published on the map container for browser regression checks.
  function diagnoseFitCurves(groupInfo) {
    const curves = [];
    const seen = new Set();
    let nearParallelGroups = 0;
    let nearParallelMaxSeparationMeters = 0;
    const nearParallelSamples = [];
    if (groupInfo)
      groupInfo.forEach((gi, groupKey) => {
        if (gi && gi._nearParallel) {
          nearParallelGroups += 1;
          nearParallelMaxSeparationMeters = Math.max(
            nearParallelMaxSeparationMeters,
            Number(gi._nearParallel.maxSeparationMeters) || 0,
          );
          const line = gi._line || [];
          const middle = line.length ? line[Math.floor(line.length / 2)] : null;
          nearParallelSamples.push({
            groupKey,
            lng: middle ? +middle[0].toFixed(5) : null,
            lat: middle ? +middle[1].toFixed(5) : null,
            trains: Object.keys(gi.mults || {}).sort(),
            maxSeparationMeters: +(
              Number(gi._nearParallel.maxSeparationMeters) || 0
            ).toFixed(1),
          });
        }
        const curve = gi && gi.curve;
        if (!curve || seen.has(curve) || !curve.pts || curve.pts.length < 2)
          return;
        seen.add(curve);
        curves.push({ groupKey, gi, curve });
      });
    let samples = 0;
    let backtracks = 0;
    let directionJumps = 0;
    let maxStepDeg = 0;
    let radiusMeasurements = 0;
    let radiusShortfalls = 0;
    let minRadiusRatio = Infinity;
    let directionRadiusMeasurements = 0;
    let directionRadiusShortfalls = 0;
    let minDirectionRadiusRatio = Infinity;
    let deviationMeasurements = 0;
    let deviationOverruns = 0;
    let maxDeviationRatio = 0;
    let stationContinuousCurves = 0;
    let stationJoinsRounded = 0;
    const fitTypes = new Set();
    const radiusFlaggedGroups = [];
    const flaggedGroups = [];
    curves.forEach(({ groupKey, curve }) => {
      if (curve.fitType) fitTypes.add(curve.fitType);
      if (curve.stationJoinCount > 0) {
        stationContinuousCurves += 1;
        stationJoinsRounded += curve.stationJoinCount;
      }
      if (
        curve.requestedMinRadiusMeters > 0 &&
        curve.achievedMinRadiusMeters != null
      ) {
        const ratio =
          curve.achievedMinRadiusMeters / curve.requestedMinRadiusMeters;
        radiusMeasurements += 1;
        minRadiusRatio = Math.min(minRadiusRatio, ratio);
        if (ratio < 0.999) {
          radiusShortfalls += 1;
          radiusFlaggedGroups.push({
            groupKey,
            requestedM: Math.round(curve.requestedMinRadiusMeters),
            achievedM: Math.round(curve.achievedMinRadiusMeters),
            sourceLengthM: Math.round(curve.sourceTotalMeters || 0),
            chordM: Math.round(curve.endpointChordMeters || 0),
            ratio: +ratio.toFixed(3),
            fitType: curve.fitType || null,
            stationJoinCount: curve.stationJoinCount || 0,
            stationSmoothingPasses: curve.stationSmoothingPasses || 0,
          });
        }
      }
      if (
        curve.requestedMinRadiusMeters > 0 &&
        curve.achievedDirectionRadiusMeters != null
      ) {
        const ratio =
          curve.achievedDirectionRadiusMeters /
          curve.requestedMinRadiusMeters;
        directionRadiusMeasurements += 1;
        minDirectionRadiusRatio = Math.min(minDirectionRadiusRatio, ratio);
        if (ratio < 0.999) directionRadiusShortfalls += 1;
      }
      if (
        curve.maxDeviationMeters > 0 &&
        curve.actualMaxDeviationMeters != null
      ) {
        const ratio =
          curve.actualMaxDeviationMeters / curve.maxDeviationMeters;
        deviationMeasurements += 1;
        maxDeviationRatio = Math.max(maxDeviationRatio, ratio);
        if (ratio > 1.02) deviationOverruns += 1;
      }
      let hintS = null;
      let previous = null;
      let previousSampleIndex = null;
      let groupMax = 0;
      // fanPerpAt projects against the complete curve, so checking every one
      // of thousands of 30 m display samples becomes quadratic after station
      // corridors are joined. Uniformly cover every curve with at most 320
      // pointer-equivalent samples; all overlap intervals remain represented.
      const sampleStride = Math.max(1, Math.ceil(curve.pts.length / 320));
      const sampleAt = (sampleIndex) => {
        const p = curve.pts[sampleIndex];
        const current = fanPerpAt(
          curve,
          { lng: p[0], lat: p[1] },
          hintS,
        );
        samples += 1;
        if (hintS != null && current.s + 1 < hintS) backtracks += 1;
        const skippedSteps =
          previousSampleIndex == null
            ? 1
            : Math.max(1, sampleIndex - previousSampleIndex);
        const stepDeg = angleDelta(previous, current) / skippedSteps;
        if (stepDeg > groupMax) groupMax = stepDeg;
        if (stepDeg > maxStepDeg) maxStepDeg = stepDeg;
        if (stepDeg > 4) directionJumps += 1;
        hintS = current.s;
        previous = current;
        previousSampleIndex = sampleIndex;
      };
      let lastSample = -1;
      for (let i = 0; i < curve.pts.length; i += sampleStride) {
        sampleAt(i);
        lastSample = i;
      }
      if (lastSample !== curve.pts.length - 1) sampleAt(curve.pts.length - 1);
      if (groupMax > 4)
        flaggedGroups.push({ groupKey, maxStepDeg: +groupMax.toFixed(2) });
    });

    // Inspect all distinct fitted-curve endpoint pairs that geometrically
    // meet. Their target directions may differ, but the group transition rAF
    // interpolates them; reporting the worst angle makes boundary testing
    // explicit and reproducible.
    const ends = [];
    curves.forEach(({ groupKey, gi, curve }) => {
      [0, curve.pts.length - 1].forEach((i) => {
        const p = curve.pts[i];
        const raw = fanPerpAt(curve, { lng: p[0], lat: p[1] }, curve.cum[i]);
        const staticX = (gi.sx || 0) * curve.coslat;
        const staticY = gi.sy || 0;
        const flip = raw.x * staticX + raw.y * staticY < 0;
        ends.push({
          groupKey,
          p,
          dir: { x: flip ? -raw.x : raw.x, y: flip ? -raw.y : raw.y },
        });
      });
    });
    let boundaries = 0;
    let maxBoundaryDeg = 0;
    let rawMaxBoundaryDeg = 0;
    const boundaryFlaggedGroups = [];
    for (let i = 0; i < ends.length; i += 1)
      for (let j = i + 1; j < ends.length; j += 1) {
        if (ends[i].groupKey === ends[j].groupKey) continue;
        const lat = (ends[i].p[1] + ends[j].p[1]) / 2;
        const cs = Math.cos((lat * Math.PI) / 180) || 1e-6;
        const metres =
          Math.hypot(
            (ends[i].p[0] - ends[j].p[0]) * cs,
            ends[i].p[1] - ends[j].p[1],
          ) * 111320;
        if (metres > 180) continue;
        boundaries += 1;
        const rawDelta = angleDelta(ends[i].dir, ends[j].dir);
        rawMaxBoundaryDeg = Math.max(rawMaxBoundaryDeg, rawDelta);
        maxBoundaryDeg = Math.max(
          maxBoundaryDeg,
          Math.min(rawDelta, 180 - rawDelta),
        );
        const axisDelta = Math.min(rawDelta, 180 - rawDelta);
        if (axisDelta > 1)
          boundaryFlaggedGroups.push({
            a: ends[i].groupKey,
            b: ends[j].groupKey,
            lng: +((ends[i].p[0] + ends[j].p[0]) / 2).toFixed(5),
            lat: +((ends[i].p[1] + ends[j].p[1]) / 2).toFixed(5),
            metres: +metres.toFixed(1),
            deltaDeg: +axisDelta.toFixed(2),
          });
      }
    return {
      curves: curves.length,
      samples,
      appliedFitSettings: curves.length
        ? {
            precision: curves[0].curve.samplingPrecision,
            minRadiusM: curves[0].curve.requestedMinRadiusMeters,
            minDetailM: curves[0].curve.minDetailMeters,
            maxDeviationM: curves[0].curve.maxDeviationMeters,
          }
        : null,
      backtracks,
      directionJumps,
      maxStepDeg: +maxStepDeg.toFixed(2),
      fitTypes: Array.from(fitTypes).sort(),
      radiusMeasurements,
      radiusShortfalls,
      minRadiusRatio: isFinite(minRadiusRatio)
        ? +minRadiusRatio.toFixed(3)
        : null,
      radiusFlaggedGroups: radiusFlaggedGroups
        .sort((a, b) => a.ratio - b.ratio)
        .slice(0, 20),
      directionRadiusMeasurements,
      directionRadiusShortfalls,
      minDirectionRadiusRatio: isFinite(minDirectionRadiusRatio)
        ? +minDirectionRadiusRatio.toFixed(3)
        : null,
      deviationMeasurements,
      deviationOverruns,
      maxDeviationRatio: +maxDeviationRatio.toFixed(3),
      nearParallelGroups,
      nearParallelMaxSeparationMeters:
        +nearParallelMaxSeparationMeters.toFixed(1),
      nearParallelSamples: nearParallelSamples.slice(0, 100),
      stationContinuousCurves,
      stationJoinsRounded,
      boundaries,
      maxBoundaryDeg: +maxBoundaryDeg.toFixed(2),
      rawMaxBoundaryDeg: +rawMaxBoundaryDeg.toFixed(2),
      boundaryFlaggedGroups: boundaryFlaggedGroups
        .sort((a, b) => b.deltaDeg - a.deltaDeg)
        .slice(0, 20),
      flaggedGroups: flaggedGroups.slice(0, 20),
    };
  }

  function hoverRegionsToFC(map, state) {
    if (!map || !state || !state.point) return EMPTY_FC;
    const features = [];
    const lngLat = (x, y) => {
      const p = map.unproject([x, y]);
      return [p.lng, p.lat];
    };
    const polygon = (kind, ring, radiusPx) => {
      if (!ring.length) return;
      const closed = ring.concat([ring[0]]);
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [closed] },
        properties: { kind, radiusPx },
      });
    };
    const square = (kind, center, radiusPx) => {
      const x = center.x;
      const y = center.y;
      polygon(
        kind,
        [
          lngLat(x - radiusPx, y - radiusPx),
          lngLat(x + radiusPx, y - radiusPx),
          lngLat(x + radiusPx, y + radiusPx),
          lngLat(x - radiusPx, y + radiusPx),
        ],
        radiusPx,
      );
    };
    const circle = (kind, center, radiusPx) => {
      const ring = [];
      for (let i = 0; i < 48; i += 1) {
        const a = (i * Math.PI * 2) / 48;
        ring.push(
          lngLat(
            center.x + Math.cos(a) * radiusPx,
            center.y + Math.sin(a) * radiusPx,
          ),
        );
      }
      polygon(kind, ring, radiusPx);
    };
    square("pick", state.point, state.routePadPx || HOVER_PICK_PAD_PX);
    if (state.holdPoint)
      circle("hold", state.holdPoint, HOVER_FAN_HOLD_PX);
    if (state.switchPoint)
      circle("switch", state.switchPoint, HOVER_GROUP_SWITCH_PX);
    return { type: "FeatureCollection", features };
  }

  function rgbCss(arr) {
    if (!Array.isArray(arr)) return "rgb(0,0,0)";
    return "rgb(" + arr[0] + "," + arr[1] + "," + arr[2] + ")";
  }

  function markerRecordsToFC(records) {
    return {
      type: "FeatureCollection",
      features: records.map((m, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: m.position },
        properties: {
          idx: i,
          tid: (m.train && m.train.id) || "",
          tdate: m.tdate || "",
          category: m.category,
          role: m.role || m.category,
          focusScale: m.focusScale == null ? 0.5 : m.focusScale,
          radius: m.radius,
          lineWidth: m.lineWidth,
          fill: rgbCss(m.fillColor),
          stroke: rgbCss(m.lineColor),
          alpha: m.alpha != null ? m.alpha : 1,
        },
      })),
    };
  }

  global.RailMapGeometry = {
    routeRecordsToFC,
    routePickRecordsToFC,
    routeExpandFC,
    routeExpandTransitionFC,
    transitionOffsetForTid,
    fanPerpAt,
    fitCurvesToFC,
    diagnoseFitCurves,
    hoverRegionsToFC,
    markerRecordsToFC,
  };
})(window);
