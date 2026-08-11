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
          // Cross-day scoping: `edate` is the date THIS segment runs on and
          // `dspan` lists every date its train touches ("|d0|d1|"). Equal to
          // tdate for an ordinary train, so the defaults keep old records
          // behaving exactly as before.
          edate: r.edate || r.tdate || "",
          dspan: r.dspan || "|" + (r.tdate || "") + "|",
          color: rgbCss(r.color),
          alpha: r.color.length > 3 ? r.color[3] / 255 : 1,
          width: r.width,
          // Painter's order (higher = on top): emphasis tier, then shorter
          // total ride, then earlier date — assigned per train by
          // buildDeckRouteRecords.
          sortKey: r.sortKey || 0,
          // The parallel lane of the RAILWAY this stretch was ridden on, in
          // the same units the network strokes use, so the ride and its rail
          // take the identical screen offset and can never draw apart.
          lane: r.lane || 0,
        },
      })),
    };
  }

  // STATIC pick geometry. Hover must only trigger directly ON a visible
  // line, never across the not-yet-expanded fan region, so every record's
  // hit geometry sits on the TRUE TRACK (where the line is actually drawn),
  // narrow width. The open fan's per-lane hit areas live in the separate
  // fan-scoped source (routePickFanBaseFC below), so this dataset never depends
  // on fan state or lane spacing. `idx` maps a picked feature back to the
  // full record in _records (tooltip lane info, click target, group key).
  function routePickRecordsToFC(records, groupInfo) {
    const features = records.map((r, i) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: r.path },
      properties: {
        idx: i,
        tid: (r.train && r.train.id) || "",
        pickWidth: Math.max(r.width + 10, 16),
        nopick: r.nopick ? 1 : 0,
        // Hit-testing follows the line the reader can actually see, so the
        // pick target takes its record's lane too.
        lane: r.lane || 0,
      },
    }));
    // Source-feature seams have no visible geometry between their endpoints,
    // but they are part of the same overlap corridor. Tiny pick-only bridges
    // keep that corridor continuous before the fan opens.
    if (groupInfo)
      groupInfo.forEach((gi) => {
        (gi.pickBridges || []).forEach((bridge) => {
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: bridge.path },
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

  // FAN-ONLY pick geometry: true-track records for the active group(s). Each
  // tid gets its own pooled layer; that layer's constant line-translate moves
  // the geometry and its native MapLibre hit area together on the GPU.
  function routePickFanBaseFC(records, groupInfo, groups) {
    const active = new Set((groups || []).filter(Boolean));
    if (!active.size) return EMPTY_FC;
    const features = [];
    records.forEach((r, i) => {
      if (!active.has(r.groupKey)) return;
      const tid = (r.train && r.train.id) || "";
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: r.path },
        properties: {
          idx: i,
          tid,
          pickWidth: r.pickWidth != null ? r.pickWidth : Math.max(r.width + 10, 16),
          nopick: r.nopick ? 1 : 0,
        },
      });
    });
    if (groupInfo)
      groupInfo.forEach((gi, groupKey) => {
        if (!active.has(groupKey)) return;
        (gi.pickBridges || []).forEach((bridge) => {
          features.push({
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: bridge.path,
            },
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

  // ── expand-FC template cache ──────────────────────────────────────────
  // Opening a fan uploads each member's true complete course exactly once.
  // Animation changes only per-layer line-translate paint values afterwards.
  let _expandTpl = { records: null, key: "", features: null, indices: null };
  function _expandTemplate(expandRecords, memberOf) {
    const indices = [];
    for (let i = 0; i < expandRecords.length; i += 1) {
      const r = expandRecords[i];
      if (memberOf((r.train && r.train.id) || "")) indices.push(i);
    }
    const key = indices.join(",");
    if (_expandTpl.records === expandRecords && _expandTpl.key === key)
      return _expandTpl;
    const features = indices.map((i) => {
      const r = expandRecords[i];
      return {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: r.path.map((p) => [p[0], p[1]]),
        },
        properties: {
          idx: i,
          tid: (r.train && r.train.id) || "",
          colorA: rgbaCss(r.color),
          width: r.width,
        },
      };
    });
    _expandTpl = { records: expandRecords, key, features, indices };
    return _expandTpl;
  }

  function routeExpandBaseFC(expandRecords, tids) {
    const members = new Set((tids || []).filter(Boolean));
    if (!members.size) return EMPTY_FC;
    const tpl = _expandTemplate(expandRecords, (tid) => members.has(tid));
    return { type: "FeatureCollection", features: tpl.features };
  }

  // Arc-length point sampling on a fitted curve ({pts, cum, totalMeters}).
  // The app family no longer delegates here (its fittedCurvePointAt copy in
  // app-overlap-lanes.js is deliberate — delegating through window.RailMap*
  // crashed the fit worker, 08-05); this survives as fanPerpAt's hot-reload
  // fallback and an export for standalone embedders.
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
    const cum = curve.cum;
    const cs = curve.coslat;
    const px = lngLat.lng * cs;
    const py = lngLat.lat;
    let globalHit = null;
    let localHit = null;
    const localRadius = Math.min(
      6500,
      Math.max(1200, (curve.radiusMeters || 800) * 2.4),
    );
    const lowerBound = (target) => {
      let lo = 0;
      let hi = cum.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const hitOnSegment = (i) => {
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
      const s = cum[i] + (cum[i + 1] - cum[i]) * t;
      return { d2, s, i, t, tx: vx, ty: vy };
    };
    const scan = (start, end, best) => {
      let hit = best || null;
      for (let i = start; i <= end; i += 1) {
        const candidate = hitOnSegment(i);
        if (!hit || candidate.d2 < hit.d2) hit = candidate;
      }
      return hit;
    };
    let localStart = 0;
    let localEnd = -1;
    if (hintS != null && cum && cum.length === pts.length) {
      localStart = Math.max(0, lowerBound(hintS - localRadius) - 1);
      localEnd = Math.min(
        pts.length - 2,
        lowerBound(hintS + localRadius) - 1,
      );
      localHit = scan(localStart, localEnd, null);
      // If the hinted branch is within the 70 m branch tolerance, no other
      // branch can beat it by MORE than 70 m (distance is non-negative), so
      // the expensive whole-curve scan cannot change the answer.
      const toleranceDeg = 70 / 111320;
      if (localHit && localHit.d2 <= toleranceDeg * toleranceDeg)
        globalHit = localHit;
    }
    if (!globalHit) {
      if (localHit) {
        globalHit = localHit;
        globalHit = scan(0, localStart - 1, globalHit);
        globalHit = scan(localEnd + 1, pts.length - 2, globalHit);
      } else {
        globalHit = scan(0, pts.length - 2, null);
      }
    }
    if (!globalHit) return { x: 0, y: -1, s: 0, distance2: Infinity };
    const toleranceDeg = 70 / 111320;
    const allowedLocalDistance = Math.sqrt(globalHit.d2) + toleranceDeg;
    const hit =
      localHit && localHit.d2 <= allowedLocalDistance * allowedLocalDistance
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
    const seenFailures = new Set();
    if (groupInfo)
      groupInfo.forEach((gi, groupKey) => {
        // A rejected station join keeps its member curves separate; surface
        // each rejected boundary as its own (red-styled) segment so the
        // overlay shows exactly where — and the popup properties say why —
        // the chain was not continued.
        const failure = gi && gi.stationJoinFailure;
        if (failure && !seenFailures.has(failure)) {
          seenFailures.add(failure);
          (failure.joins || []).forEach((join) => {
            features.push({
              type: "Feature",
              geometry: { type: "LineString", coordinates: [join.a, join.b] },
              properties: {
                kind: "station-join-failure",
                reason: failure.reason,
                gapM: join.gapM,
                turnDeg: join.turnDeg,
                requestedMinRadiusM: failure.requestedMinRadiusM,
                achievedMinRadiusM: failure.achievedMinRadiusM,
                maxDeviationM: failure.maxDeviationM,
                actualMaxDeviationM: failure.actualMaxDeviationM,
              },
            });
          });
        }
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
            stationJoinCount: curve.stationJoinCount || 0,
            stationJoinIdMatchedCount:
              curve.stationJoinIdMatchedCount || 0,
            stationJoinRadiusRelaxed: curve.stationJoinRadiusRelaxed === true,
            acceptedMinRadiusM:
              curve.acceptedMinRadiusMeters == null
                ? null
                : Math.round(curve.acceptedMinRadiusMeters),
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
    let stationJoinsIdMatched = 0;
    let stationJoinRadiusRelaxedCurves = 0;
    const fitTypes = new Set();
    const radiusFlaggedGroups = [];
    const flaggedGroups = [];
    // Station-join rejections marked by smoothCurveStationJoins: dedupe the
    // shared failure objects so each rejected component reports once.
    const stationJoinFailures = [];
    const seenJoinFailures = new Set();
    if (groupInfo)
      groupInfo.forEach((gi) => {
        const failure = gi && gi.stationJoinFailure;
        if (!failure || seenJoinFailures.has(failure)) return;
        seenJoinFailures.add(failure);
        stationJoinFailures.push(failure);
      });
    curves.forEach(({ groupKey, curve }) => {
      if (curve.fitType) fitTypes.add(curve.fitType);
      if (curve.stationJoinCount > 0) {
        stationContinuousCurves += 1;
        stationJoinsRounded += curve.stationJoinCount;
        stationJoinsIdMatched += curve.stationJoinIdMatchedCount || 0;
      }
      if (
        curve.requestedMinRadiusMeters > 0 &&
        curve.achievedMinRadiusMeters != null
      ) {
        // A station-continuous curve accepted under the radius relaxation
        // carries the floor that was actually enforced; shortfalls measure
        // against that floor so a deliberate acceptance is not re-flagged.
        const acceptedMin =
          curve.acceptedMinRadiusMeters || curve.requestedMinRadiusMeters;
        const ratio =
          curve.achievedMinRadiusMeters / curve.requestedMinRadiusMeters;
        radiusMeasurements += 1;
        minRadiusRatio = Math.min(minRadiusRatio, ratio);
        if (curve.stationJoinRadiusRelaxed === true)
          stationJoinRadiusRelaxedCurves += 1;
        if (curve.achievedMinRadiusMeters < acceptedMin * 0.999) {
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

    // Inspect fitted-curve endpoint pairs that geometrically meet AND share a
    // train. Without the shared-train requirement the sweep also paired
    // endpoints of unrelated corridors that merely pass near each other —
    // boundaries no hover transition can ever cross — and those false pairs
    // dominated the reported worst angle. Their target directions may still
    // differ; the group transition rAF interpolates them, and reporting the
    // worst REAL angle makes boundary testing explicit and reproducible.
    const trainsByCurve = new Map();
    if (groupInfo)
      groupInfo.forEach((gi) => {
        const curve = gi && gi.curve;
        if (!curve) return;
        let set = trainsByCurve.get(curve);
        if (!set) trainsByCurve.set(curve, (set = new Set()));
        Object.keys((gi && gi.mults) || {}).forEach((id) => set.add(id));
      });
    const ends = [];
    curves.forEach(({ groupKey, gi, curve }) => {
      const trains = trainsByCurve.get(curve) || new Set();
      [0, curve.pts.length - 1].forEach((i) => {
        const p = curve.pts[i];
        const raw = fanPerpAt(curve, { lng: p[0], lat: p[1] }, curve.cum[i]);
        const staticX = (gi.sx || 0) * curve.coslat;
        const staticY = gi.sy || 0;
        const flip = raw.x * staticX + raw.y * staticY < 0;
        ends.push({
          groupKey,
          p,
          trains,
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
        let sharedTrain = false;
        ends[i].trains.forEach((id) => {
          if (ends[j].trains.has(id)) sharedTrain = true;
        });
        if (!sharedTrain) continue;
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
      stationJoinsIdMatched,
      stationJoinRadiusRelaxedCurves,
      stationJoinFailureCount: stationJoinFailures.length,
      stationJoinFailures: stationJoinFailures.slice(0, 20),
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
          dspan: m.dspan || "|" + (m.tdate || "") + "|",
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
    routePickFanBaseFC,
    routeExpandBaseFC,
    curvePointAt,
    fanPerpAt,
    fitCurvesToFC,
    diagnoseFitCurves,
    hoverRegionsToFC,
    markerRecordsToFC,
  };
})(window);
