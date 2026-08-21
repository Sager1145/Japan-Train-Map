// =========================================================================
//  app-playback.js — 行程播放：沿已乘路線逐趟播放的動畫引擎
//
//  What it is: one rAF clock that walks a queue of trains along the SAME
//  geometry the map already draws, moving the camera so the running train
//  sits in the middle of the UNCOVERED viewport.
//
//  Two laws, and they are coupled on purpose (see §2):
//    · duration — a clamped curve on the run's ridden length, so every
//      journey lands between a floor and a ceiling no matter how long it is;
//    · zoom     — derived from the resulting ground speed against ONE target
//      SCREEN speed, so a long journey ends up further out (and therefore
//      covers ground visibly faster) while a short one is played close in.
//  Deriving zoom from speed rather than from length independently is what
//  stops the two laws from cancelling: keyed separately, a 5 km hop played
//  at z15 ran across the screen SIX TIMES faster than a 400 km hop at z8 —
//  the exact opposite of "short lines play slower".
//
//  Ownership: this module owns the playback clock, the queue snapshot and
//  the player bar. It never writes selectedTrainId / selectedDate / the
//  store — the running train is highlighted through RailMap.setSelected,
//  which is paint-only and rebuilds nothing.
//
//  Part of the app-*.js family: a classic script in one shared global
//  lexical scope, loaded in the order index.html defines. Nothing here
//  touches the DOM, maplibregl or requestAnimationFrame at load time — the
//  Node vm replay (scripts/lib/app-family-sandbox.mjs, used by
//  `npm run precompute` and the family smoke test) evaluates this file with
//  only stubs for all three.
// =========================================================================

const Playback = (function () {
  "use strict";

  // ── §1 tuning ──────────────────────────────────────────────────────────
  // Calibrated against the shipped Japan sample (201 trains / 2303 ridden
  // intervals): hop lengths p10 0.9 km, p50 3.2 km, p90 20.3 km; journey
  // lengths p50 16 km, p90 270 km, max 826 km.
  const TUNE = Object.freeze({
    // Journey duration, seconds, as a function of ridden km. The clamp IS
    // the "shortest / longest playback time" contract: nothing plays for
    // under T_MIN, nothing for over T_MAX, however extreme its length.
    T_MIN: 4,
    T_MAX: 20,
    T_BASE: 3,
    T_SLOPE: 0.7,
    // How the journey's time budget is split between its ridden intervals.
    // Share ∝ metres^HOP_EXP with HOP_EXP < 1 means a short interval gets
    // more time PER METRE than a long one — "short interval slower, long
    // interval faster" — while the journey total stays exactly the budget.
    //
    // Raised from 0.30 when the zoom stopped following each interval: with a
    // fixed zoom for the whole journey, the interval-to-interval speed spread
    // is now seen at ONE scale, and 0.30 made a 260 km hop blur past between
    // two 7 km ones. 0.45 keeps the short-slow/long-fast ordering while
    // halving the spread.
    HOP_EXP: 0.45,
    // Target speed of the marker across the SCREEN, px/s at 1×. This is the
    // only number tuned by eye; every zoom in the run follows from it.
    V_PX: 210,
    Z_MIN: 8.2,
    Z_MAX: 15.4,
    // Exponential smoothing of the zoom track, seconds. The track itself is
    // already piecewise-linear between interval midpoints; this takes the
    // last corner off it (and off the first frame after a train change).
    // Deliberately SLOWER than CENTER_TAU. The catch-up zoom is a function of
    // the gap, so if the two converged at the same rate the zoom would keep
    // pace with the closing distance and the train would hang at the same
    // pixel offset for the whole arc. Letting the position close first lands
    // the train in the middle, and the detail zoom arrives just after.
    ZOOM_TAU: 0.55,
    // The camera chases the train rather than being placed on it: each frame
    // the OFFSET between them decays by this time constant while the train's
    // own motion is fed forward untouched. Feeding the motion forward is what
    // keeps the dot exactly centred during a run (a plain ease-toward-target
    // would trail it by speed × tau, ~95 px, forever); decaying the offset is
    // what absorbs a change of train without anybody waiting for a camera
    // animation to finish.
    CENTER_TAU: 0.32,
    // While catching up, the camera frames BOTH itself and the train, which
    // draws the zoom-out-then-in arc a flyTo would have drawn — for free, and
    // with the next train already running underneath it. This floor is lower
    // than Z_MIN because a cross-country hand-off needs to pull back further
    // than any actual journey does.
    Z_CATCHUP_MIN: 6,
    // Arming the player frames the WHOLE scope first — the day, the queue or
    // the one selected train — so the reader sees what is about to be played
    // before any of it moves.
    OVERVIEW_MS: 800,
    OVERVIEW_MAX_ZOOM: 13.5,
    // …and pressing play then closes in on the first train's starting frame
    // and WAITS for it. Deliberately unlike the hand-off between trains,
    // which starts the next journey immediately and lets the camera catch up:
    // mid-queue there is already a train on screen to carry the eye, and at
    // the very start there is not.
    INTRO_MS: 900,
    TERMINUS_HOLD_MS: 200, // a beat on arrival, so the terminus reads as one
    FINALE_MS: 1600,
    // How long the closing overview is held before the run reports itself
    // finished. A video export records through this, so it is the last thing
    // the exported file shows.
    FINALE_HOLD_MS: 900,
    // The day-overview fit that closes a run. fitTrainsBounds defaults to 11,
    // which is too far out for a day spent inside one city.
    FINALE_MAX_ZOOM: 13.5,
    // A tab that stalls (GC, a slow tile batch) must not teleport the marker.
    MAX_FRAME_S: 0.1,
    // How long a station stays "just reached" after the head passes it.
    STATION_PULSE_S: 0.45,
    SPEED_MIN: 0.5,
    SPEED_MAX: 4,
    SPEED_STEP: 0.25,
  });

  // Metres per pixel at zoom 0 on the equator, MapLibre's 512 px tile grid.
  const MPP_ZOOM0 = 78271.517;
  const DEG = Math.PI / 180;

  // ── §2 state ───────────────────────────────────────────────────────────
  // "idle" nothing running · "armed" queue resolved and the scope framed,
  // waiting for play · "playing" the rAF clock owns the camera ·
  // "transitioning" the beat held at a terminus before the next train ·
  // "paused" clock parked at its current offset · "ended" finished, the
  // finale fit is showing and the bar offers a replay.
  //
  // There is deliberately no "flying between trains" state: the camera is a
  // chaser, so a change of train is a change of what it chases, not a
  // separate animation the run has to wait out.
  let phase = "idle";
  let queue = []; // frozen snapshot of trains, in list order
  let queueIndex = 0;
  let path = null; // compiled path of queue[queueIndex]
  let elapsed = 0; // seconds into the current journey, already speed-scaled
  let speed = 1;
  let rafId = null;
  let lastFrameMs = 0;
  let zoomSmoothed = null;
  // Where the camera is RELATIVE to the train, in degrees. The whole camera
  // is derived from this: centre = train + camError, and camError decays.
  let camError = null;
  let finishTimer = null;
  let armTimer = null;
  const finishListeners = new Set();
  let transitionTimer = null;
  // Distinguishes one camera hand-off from the next: a moveend queued for the
  // journey the user just skipped past must not start the clock for the one
  // that replaced it.
  let transitionToken = 0;
  let restoreHandlers = null;
  let restoreSelected = null;
  let suppressExternalStop = false;
  let stationIndex = -1;
  let stationPulse = 0;
  // Stretches earlier trains in this run already covered, kept lit behind the
  // running train so a day's itinerary accumulates on the map.
  let trailDone = [];

  // Compiled paths outlive one playback: replaying a day costs nothing the
  // second time. Keyed on the same inputs the route render keys on, so an
  // edited train recompiles and an untouched one does not.
  const pathCache = new Map();

  // ── §3 geometry: compile a train into a playable path ──────────────────

  // Metres between two [lng,lat] pairs. Equirectangular on the shared
  // constants, same approximation the route modules use.
  function metersBetween(a, b) {
    return distanceMeters(a, b);
  }

  function pathCacheKey(train) {
    const rides = (train.stops || [])
      .map((s) => (s && s.ride_segment ? 1 : 0))
      .join("");
    return `${train.id}:${getTrainRouteTemplateKey(train)}:${rides}`;
  }

  // Raw (unquantized) coordinate lines of one route feature. Deliberately NOT
  // iterateGeometryLines: that snaps every vertex to the 5-decimal graph grid,
  // which is right for identity keys and wrong for a marker that has to slide
  // along the drawn stroke without stepping.
  function featureLines(feature) {
    const g = feature && feature.geometry;
    if (!g || !g.coordinates) return [];
    if (g.type === "LineString") return [g.coordinates];
    if (g.type === "MultiLineString") return g.coordinates;
    return [];
  }

  // A train's ridden geometry as CONTIGUOUS runs plus the interval table.
  //
  // Runs exist because a route may legitimately arrive as one path WITH GAPS
  // (geometry_role: single_path_with_gaps) or lose a middle interval to
  // ride_segment:false. Concatenating across such a hole would draw a chord
  // straight over the map; keeping runs separate lets the trail skip it and
  // the marker step across it.
  function compilePath(train) {
    const key = pathCacheKey(train);
    const cached = pathCache.get(key);
    if (cached) return cached;

    const features = getMatchedRouteFeatures(train).filter(
      (f) => f && f.properties && f.properties.ride_segment === true,
    );
    const runs = []; // { coords, cum, total }
    const hops = []; // { s0, s1, meters, t0, t1, zoom }
    let run = null;
    let globalS = 0;

    const startRun = (first) => {
      run = { coords: [first], cum: [0], total: 0 };
      runs.push(run);
    };
    const pushCoord = (c) => {
      const last = run.coords[run.coords.length - 1];
      const step = metersBetween(last, c);
      if (step <= 0) return; // duplicate vertex at an interval boundary
      run.coords.push(c);
      run.total += step;
      run.cum.push(run.total);
      globalS += step;
    };

    features.forEach((feature) => {
      const hopStart = globalS;
      featureLines(feature).forEach((line) => {
        if (!line || line.length < 2) return;
        if (!run) startRun(line[0]);
        else {
          const last = run.coords[run.coords.length - 1];
          // A new line that does not continue the current run opens a new one.
          // 1 m is well under the 5-decimal grid the geometry sits on, so an
          // exact continuation always joins and a real hole never does.
          if (metersBetween(last, line[0]) > 1) startRun(line[0]);
        }
        for (let i = 1; i < line.length; i += 1) pushCoord(line[i]);
      });
      if (globalS > hopStart)
        hops.push({
          s0: hopStart,
          s1: globalS,
          meters: globalS - hopStart,
          // The stop-pair this interval joins: features were filtered to the
          // RIDDEN ones, so their position in `features` no longer matches
          // their position in train.stops. segment_index still does.
          segIndex: Number(feature.properties.segment_index ?? -1),
        });
    });

    if (!hops.length || globalS <= 0) return null;

    // Run offsets in the GLOBAL arc coordinate: runs concatenate, so a gap
    // between them contributes zero length and the marker crosses it in one
    // frame rather than sliding over open country.
    let offset = 0;
    runs.forEach((r) => {
      r.offset = offset;
      offset += r.total;
    });

    const km = globalS / 1000;
    const budget = Math.min(
      TUNE.T_MAX,
      Math.max(TUNE.T_MIN, TUNE.T_BASE + TUNE.T_SLOPE * Math.sqrt(km)),
    );
    const weights = hops.map((h) => Math.pow(h.meters, TUNE.HOP_EXP));
    const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
    let clock = 0;
    hops.forEach((h, i) => {
      h.t0 = clock;
      clock += (budget * weights[i]) / weightSum;
      h.t1 = clock;
    });

    // ONE zoom for the whole journey. It used to be computed per ridden
    // interval, which is where the "short interval closer, long interval
    // further" reading came from — but a limited express with thirty-odd
    // stops then re-framed the map at every one of them, and a map that
    // rescales every second is unreadable however correct each frame is.
    // So the scale is fixed by the JOURNEY's average ground speed against
    // the same screen-speed target: a short journey still plays close in and
    // a long one still plays pulled back, and nothing moves in between.
    // (Which intervals feel slow or fast is unchanged — that lives in the
    // time split above, not in the scale.)
    const midPoint = positionAtDistance(runs, globalS / 2);
    const lat = midPoint ? midPoint[1] : 36;
    const averageSpeed = globalS / Math.max(0.001, clock);
    const zoom = Math.min(
      TUNE.Z_MAX,
      Math.max(
        TUNE.Z_MIN,
        Math.log2(
          (MPP_ZOOM0 * Math.cos(lat * DEG)) /
            Math.max(0.05, averageSpeed / TUNE.V_PX),
        ),
      ),
    );

    const compiled = {
      zoom,
      stations: buildStationList(train, runs, hops),
      trainId: train.id,
      color: (train.style && train.style.color) || DEFAULT_TRAIN_COLOR,
      runs,
      hops,
      totalMeters: globalS,
      duration: clock,
      start: positionAtDistance(runs, 0),
      end: positionAtDistance(runs, globalS),
    };
    pathCache.set(key, compiled);
    return compiled;
  }

  // The stations the running train actually STOPS at, in running order, with
  // the arc distance each sits at.
  //
  // Membership follows the data, not a guess: pass_through stops are excluded
  // because the schema already calls them non-stops (jsonspec §7.2), and a
  // stop only enters at all if it bounds a RIDDEN interval — an unridden or
  // hidden stretch contributes no stations, exactly as it contributes no
  // geometry. origin / passenger_stop / operational_stop / destination all
  // qualify, and so does a stop that declares no type.
  function buildStationList(train, runs, hops) {
    const stops = train.stops || [];
    const color = (train.style && train.style.color) || DEFAULT_TRAIN_COLOR;
    // stop index → arc distance, from the intervals that survived the filter.
    const distanceByStop = new Map();
    hops.forEach((h) => {
      if (h.segIndex < 0) return;
      if (!distanceByStop.has(h.segIndex)) distanceByStop.set(h.segIndex, h.s0);
      distanceByStop.set(h.segIndex + 1, h.s1);
    });
    const stations = [];
    [...distanceByStop.keys()]
      .sort((a, b) => a - b)
      .forEach((stopIndex) => {
        const stop = stops[stopIndex];
        if (!stop || stop.stop_type === "pass_through") return;
        const name = stopName(stop);
        if (!name) return;
        const s = distanceByStop.get(stopIndex);
        const coord = positionAtDistance(runs, s);
        if (!coord) return;
        stations.push({
          s,
          coord,
          color,
          // Localized here rather than at draw time: the label layer reads a
          // baked string, and a language switch repaints the whole map anyway
          // (which ends playback and drops these compiled paths).
          name:
            typeof I18N !== "undefined" && typeof I18N.stationName === "function"
              ? I18N.stationName(name, stopStationCode(stop))
              : name,
        });
      });
    return stations;
  }

  // Global arc distance → [lng,lat]. Binary search inside the owning run.
  function positionAtDistance(runs, s) {
    if (!runs.length) return null;
    let run = runs[0];
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      if (s >= runs[i].offset) {
        run = runs[i];
        break;
      }
    }
    const local = Math.max(0, Math.min(run.total, s - run.offset));
    const cum = run.cum;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= local) lo = mid;
      else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    const r = span > 0 ? (local - cum[lo]) / span : 0;
    const a = run.coords[lo];
    const b = run.coords[hi];
    return [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r];
  }

  // Which run the head is in, and how far along THAT run it is (0..1) — the
  // two numbers the trail gradient needs.
  function runProgressAtDistance(runs, s) {
    let index = 0;
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      if (s >= runs[i].offset) {
        index = i;
        break;
      }
    }
    const run = runs[index];
    const local = Math.max(0, Math.min(run.total, s - run.offset));
    return { index, t: run.total > 0 ? local / run.total : 1 };
  }

  // Journey time → global arc distance. Linear inside each interval, so the
  // pace changes at stations and nowhere else.
  function distanceAtTime(p, t) {
    const hops = p.hops;
    if (t <= 0) return 0;
    if (t >= p.duration) return p.totalMeters;
    let lo = 0;
    let hi = hops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hops[mid].t1 < t) lo = mid + 1;
      else hi = mid;
    }
    const h = hops[lo];
    const span = h.t1 - h.t0;
    const r = span > 0 ? (t - h.t0) / span : 1;
    return h.s0 + (h.s1 - h.s0) * r;
  }

  // The zoom that still shows the train while the camera is behind it. The
  // camera sits at the centre, so seeing a train `d` away needs a viewport
  // spanning about 2d; the margin keeps it off the very edge. Once the gap
  // closes this returns zTarget unchanged and the arc ends by itself.
  function catchUpZoom(center, trainCoord, zTarget) {
    const gap = metersBetween(center, trainCoord);
    if (gap < 200) return zTarget;
    const container = map.getContainer();
    const shortSide = Math.max(
      240,
      Math.min(container.clientWidth || 0, container.clientHeight || 0) || 240,
    );
    const mpp = (gap * 2.3) / shortSide;
    const zFit = Math.log2(
      (MPP_ZOOM0 * Math.cos(trainCoord[1] * DEG)) / Math.max(0.05, mpp),
    );
    return Math.max(TUNE.Z_CATCHUP_MIN, Math.min(zTarget, zFit));
  }

  // ── §4 queue ───────────────────────────────────────────────────────────

  // What "play" means right now, resolved ONCE and then frozen: a queue that
  // re-derived itself mid-run would change under the highlight this module
  // moves from train to train.
  //
  //   a highlighted train  → just that train (even if hidden: the user asked)
  //   a concrete date      → that day, in list order
  //   全部                 → everything, in list order
  // Search narrows all three, because the list on screen is what "按照列車
  // 列表播放" names.
  function resolveQueue() {
    const picked = selectedTrainId || focusedTrainId;
    if (picked) {
      const train = getTrain(picked);
      return train ? [train] : [];
    }
    return getVisibleListTrains().filter(
      (train) =>
        train.visible !== false &&
        trainPassesListFilter(train) &&
        (train.stops || []).length > 1,
    );
  }

  // ── §5 map plumbing ────────────────────────────────────────────────────

  const GESTURES = [
    "dragPan",
    "scrollZoom",
    "boxZoom",
    "dragRotate",
    "keyboard",
    "doubleClickZoom",
    "touchZoomRotate",
    "touchPitch",
  ];

  // Gestures are IGNORED while the player owns the camera: a pinch competing
  // with a per-frame jumpTo produces a fight neither side wins.
  function setGesturesEnabled(enabled) {
    if (!map) return;
    if (enabled) {
      if (!restoreHandlers) return;
      restoreHandlers.forEach((name) => {
        const handler = map[name];
        if (handler && handler.enable) handler.enable();
      });
      restoreHandlers = null;
      return;
    }
    if (restoreHandlers) return;
    restoreHandlers = [];
    GESTURES.forEach((name) => {
      const handler = map[name];
      if (!handler || !handler.disable) return;
      if (handler.isEnabled && !handler.isEnabled()) return;
      restoreHandlers.push(name);
      handler.disable();
    });
  }

  // The playhead is a MAP LAYER, not a maplibregl.Marker. A Marker is a DOM
  // element sitting beside the canvas, and canvas.captureStream() — which is
  // how the video export reads the map — sees only the canvas. A DOM playhead
  // would simply be missing from every exported file, so both the live view
  // and the recording read the same one point out of the same source.
  function placeHead(coord, color) {
    if (typeof RailMap === "undefined") return;
    RailMap.setPlaybackHead(coord, color);
  }

  function removeHead() {
    if (typeof RailMap !== "undefined") RailMap.setPlaybackHead(null);
  }

  // ── §6 clock ───────────────────────────────────────────────────────────

  function frame(now) {
    rafId = null;
    if (phase !== "playing" || !path) return;
    const dt = Math.min(
      TUNE.MAX_FRAME_S,
      Math.max(0, (now - lastFrameMs) / 1000),
    );
    lastFrameMs = now;
    elapsed += dt * speed;

    const done = elapsed >= path.duration;
    const t = done ? path.duration : elapsed;
    const s = distanceAtTime(path, t);
    const coord = positionAtDistance(path.runs, s);
    if (!coord) {
      finishTrain();
      return;
    }

    // ── camera ──
    // Decay the offset, then rebuild the centre from the train's CURRENT
    // position. Reduced motion snaps instead of chasing.
    const decay = reducedMotion() ? 0 : Math.exp(-dt / TUNE.CENTER_TAU);
    if (!camError) camError = [0, 0];
    camError = [camError[0] * decay, camError[1] * decay];
    const center = [coord[0] + camError[0], coord[1] + camError[1]];
    const zTarget = path.zoom;
    // Still a long way off? Pull back far enough to hold both ends, and let
    // the same decay bring the zoom back in as the gap closes.
    const zAimed = catchUpZoom(center, coord, zTarget);
    if (zoomSmoothed == null || reducedMotion()) zoomSmoothed = zAimed;
    else
      zoomSmoothed +=
        (zAimed - zoomSmoothed) * (1 - Math.exp(-dt / TUNE.ZOOM_TAU));

    // Camera first, then the marker and the trail, so all three describe the
    // same instant in the same frame. The marker rides the TRAIN, never the
    // camera — during a catch-up those differ, and the train is the truth.
    map.jumpTo({ center, zoom: zoomSmoothed });
    placeHead(coord, path.color);
    const rp = runProgressAtDistance(path.runs, s);
    RailMap.setPlaybackProgress(rp.index, rp.t);
    advanceStations(s, dt);
    renderProgress(t / path.duration);

    if (done) {
      finishTrain();
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  // Light every station the head has now reached, and keep the newest one
  // swollen for a moment so an arrival reads as an event. The pulse is the
  // only per-frame paint work here; between arrivals this settles to a no-op.
  function advanceStations(s, dt) {
    const stations = path.stations;
    let arrived = false;
    while (
      stationIndex + 1 < stations.length &&
      stations[stationIndex + 1].s <= s + 0.5
    ) {
      stationIndex += 1;
      arrived = true;
    }
    if (arrived) {
      stationPulse = 1;
      renderStationLabel();
    } else if (stationPulse > 0) {
      stationPulse = Math.max(0, stationPulse - dt / TUNE.STATION_PULSE_S);
    }
    RailMap.setPlaybackStationIndex(stationIndex, stationPulse);
  }

  function finishTrain() {
    phase = "transitioning";
    renderProgress(1);
    // The whole journey is covered now, so it joins the lit backlog and the
    // next train's trail starts on top of it rather than replacing it.
    if (path)
      path.runs.forEach((r) =>
        trailDone.push({ coords: r.coords, color: path.color }),
      );
    transitionTimer = setTimeout(() => {
      transitionTimer = null;
      queueIndex += 1;
      if (queueIndex >= queue.length) {
        finish();
        return;
      }
      beginTrain();
    }, TUNE.TERMINUS_HOLD_MS);
  }

  // Camera hand-off into a journey.
  //
  // `intro` is the FIRST one of a run: the camera closes in on the starting
  // frame and the clock waits for it. Every hand-off after that does the
  // opposite — starts immediately and lets the camera catch up — because
  // mid-queue there is already a train on screen carrying the eye, and at
  // the very start of a run there is not.
  function beginTrain({ intro = false } = {}) {
    const train = queue[queueIndex];
    path = train ? compilePath(train) : null;
    while (!path && queueIndex < queue.length - 1) {
      queueIndex += 1;
      path = compilePath(queue[queueIndex]);
    }
    if (!path) {
      finish();
      return;
    }
    elapsed = 0;
    withoutExternalStop(() => RailMap.setSelected(path.trainId));
    RailMap.setPlaybackTrail(
      trailDone,
      path.runs.map((r) => r.coords),
      path.color,
    );
    RailMap.setPlaybackProgress(0, 0);
    RailMap.setPlaybackStations(path.stations);
    stationIndex = -1;
    stationPulse = 0;
    placeHead(path.start, path.color);
    renderStationLabel();

    transitionToken += 1;
    const token = transitionToken;
    const runClock = () => {
      if (token !== transitionToken) return;
      phase = "playing";
      setGesturesEnabled(false);
      lastFrameMs = performance.now();
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(frame);
      renderBar();
    };

    if (intro) {
      // Land on the starting frame BEFORE anything moves.
      const duration = reducedMotion() ? 0 : TUNE.INTRO_MS;
      camError = [0, 0];
      zoomSmoothed = path.zoom;
      phase = "transitioning";
      renderBar();
      if (!duration) {
        map.jumpTo({ center: path.start, zoom: path.zoom });
        runClock();
        return;
      }
      map.easeTo({
        center: path.start,
        zoom: path.zoom,
        duration,
        easing: (x) => 1 - Math.pow(1 - x, 3),
        essential: true,
      });
      map.once("moveend", runClock);
      // Safety net for an ease MapLibre finishes without firing moveend
      // (interrupted, or clamped by maxBounds).
      if (transitionTimer != null) clearTimeout(transitionTimer);
      transitionTimer = setTimeout(runClock, duration + 260);
      return;
    }

    // Mid-queue: no camera animation to wait on, and therefore no gap between
    // trains. All the hand-off does is record how far behind the camera is;
    // the frame loop closes that gap (and draws the zoom arc) as it goes.
    const from = map.getCenter();
    camError = [from.lng - path.start[0], from.lat - path.start[1]];
    if (zoomSmoothed == null) zoomSmoothed = map.getZoom();
    runClock();
  }

  // ── §7 lifecycle ───────────────────────────────────────────────────────

  function reducedMotion() {
    return (
      typeof REDUCED_MOTION_MEDIA !== "undefined" && REDUCED_MOTION_MEDIA.matches
    );
  }

  // RailMap.setSelected is also what renderRoutesInView calls, and any render
  // during playback stops it (see notifyExternalRender). Our own selection
  // moves must not trip that guard.
  function withoutExternalStop(fn) {
    suppressExternalStop = true;
    try {
      fn();
    } finally {
      suppressExternalStop = false;
    }
  }

  // Opening the player does NOT start it. It resolves the queue, opens the
  // transport, and frames the whole scope — so the first thing on screen is
  // what is about to be played, not a camera already halfway into it.
  //
  // `autoBegin` is for the video export, where nobody is going to press play:
  // the overview still happens (it opens the file) and the run begins once
  // that move has landed.
  function start({ autoBegin = false } = {}) {
    if (phase === "paused") {
      resume();
      return false;
    }
    if (phase === "armed") {
      if (autoBegin) begin();
      return true;
    }
    if (phase === "playing" || phase === "transitioning") return false;
    if (!map || typeof RailMap === "undefined") return false;
    if (importBusy()) {
      setStatus(els.fieldStatus, I18N.t("play.busy"), "warn");
      return false;
    }
    const list = resolveQueue();
    if (!list.length) {
      setStatus(els.fieldStatus, I18N.t("play.empty"), "warn");
      return false;
    }
    queue = list;
    queueIndex = 0;
    trailDone = [];
    camError = null;
    zoomSmoothed = null;
    restoreSelected = focusedTrainId || selectedTrainId || null;
    path = null;
    stationIndex = -1;
    stationPulse = 0;
    phase = "armed";
    showBar(true);
    renderBar();
    renderStationLabel();
    const overview = fitScopeOverview();
    if (autoBegin) {
      if (armTimer != null) clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        armTimer = null;
        begin();
      }, overview + 120);
    }
    return true;
  }

  // Frame everything the queue covers. Returns how long the move will take,
  // so a caller that has to wait for it can.
  function fitScopeOverview() {
    const duration = reducedMotion() ? 0 : TUNE.OVERVIEW_MS;
    fitTrainsBounds(queue, {
      maxZoom: TUNE.OVERVIEW_MAX_ZOOM,
      duration,
    });
    return duration;
  }

  // Pressing play: close in on the first train's own frame, and only start
  // the clock once the camera is there.
  function begin() {
    if (phase !== "armed") return;
    if (armTimer != null) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    beginTrain({ intro: true });
  }

  function pause() {
    if (phase !== "playing" && phase !== "transitioning") return;
    phase = "paused";
    cancelClock();
    // A paused map belongs to the reader again — this is when they want to
    // look around — so the gestures the running player ignores come back.
    setGesturesEnabled(true);
    renderBar();
  }

  function resume() {
    if (phase !== "paused" || !path) return;
    // Wherever the reader left the camera IS the new offset; the chase closes
    // it from there rather than snapping.
    const from = map.getCenter();
    const at = positionAtDistance(path.runs, distanceAtTime(path, elapsed));
    if (at) camError = [from.lng - at[0], from.lat - at[1]];
    zoomSmoothed = map.getZoom();
    phase = "playing";
    setGesturesEnabled(false);
    lastFrameMs = performance.now();
    rafId = requestAnimationFrame(frame);
    renderBar();
  }

  function toggle() {
    if (phase === "playing" || phase === "transitioning") pause();
    else if (phase === "paused") resume();
    else if (phase === "armed") begin();
    else start();
  }

  function skip(delta) {
    if (phase === "idle" || phase === "ended") return;
    transitionToken += 1;
    const next = queueIndex + delta;
    if (next < 0 || next >= queue.length) return;
    cancelClock();
    queueIndex = next;
    beginTrain();
  }

  function cancelClock() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    if (transitionTimer != null) clearTimeout(transitionTimer);
    transitionTimer = null;
  }

  // The closing move: frame the day the last played train belongs to, so the
  // run ends on the itinerary it just drew instead of on a national overview.
  function finaleFit() {
    const last = queue[Math.min(queueIndex, queue.length - 1)];
    if (!last) return;
    const date = getTrainDate(last);
    const sameDay = getTrainsForDate(trainStore.trains, date);
    const trains = sameDay.length ? sameDay : [last];
    fitTrainsBounds(trains, {
      onlyVisible: true,
      maxZoom: TUNE.FINALE_MAX_ZOOM,
      duration: reducedMotion() ? 0 : TUNE.FINALE_MS,
    });
  }

  function finish() {
    phase = "ended";
    cancelClock();
    // The playhead STAYS at the terminus through the closing overview: it is
    // where the journey ended, and it is the last frame of an exported video.
    setGesturesEnabled(true);
    finaleFit();
    renderBar();
    const hold =
      (reducedMotion() ? 0 : TUNE.FINALE_MS) + TUNE.FINALE_HOLD_MS;
    finishTimer = setTimeout(() => {
      finishTimer = null;
      announceFinished(false);
    }, hold);
  }

  function announceFinished(aborted) {
    finishListeners.forEach((fn) => {
      try {
        fn({ aborted: Boolean(aborted) });
      } catch (err) {
        console.warn("[playback] finish listener failed", err);
      }
    });
  }

  // `restoreSelection:false` is for the stop that a REPAINT triggers: that
  // repaint is about to set the selection itself (renderRoutesInView ends on
  // RailMap.setSelected), and putting the pre-playback train back first would
  // fight whatever the user just picked.
  function stop({ keepBar = false, restoreSelection = true } = {}) {
    if (phase === "idle") return;
    phase = "idle";
    transitionToken += 1;
    cancelClock();
    removeHead();
    if (typeof RailMap !== "undefined") {
      RailMap.clearPlayback();
      if (restoreSelection)
        withoutExternalStop(() => RailMap.setSelected(restoreSelected));
    }
    setGesturesEnabled(true);
    // The relayout the map's own moveend handler skipped for every playback
    // frame (see app-map-init.js) — one pass, now that the camera has settled.
    if (typeof updateEndpointLabels === "function") updateEndpointLabels();
    path = null;
    queue = [];
    queueIndex = 0;
    trailDone = [];
    camError = null;
    zoomSmoothed = null;
    if (finishTimer != null) {
      clearTimeout(finishTimer);
      finishTimer = null;
    }
    if (armTimer != null) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    if (!keepBar) showBar(false);
    renderBar();
    announceFinished(true);
  }

  // Anything that redraws the train layers has changed the date scope, the
  // selection, the filter or the store itself — all four invalidate a frozen
  // queue, so playback ends rather than running against stale geometry.
  function notifyExternalRender() {
    if (suppressExternalStop) return;
    if (phase === "idle") return;
    stop({ restoreSelection: false });
  }

  function invalidatePaths() {
    pathCache.clear();
  }

  // Compile every journey in the CURRENT scope up front and report what the
  // run will cost. Two jobs in one pass: the caller gets a duration it can
  // show before committing to a recording, and the compile — the one piece of
  // per-train work that is not free — is done before the clock starts rather
  // than as a hitch at every change of train.
  function prepare() {
    const list = resolveQueue();
    let seconds = 0;
    let playable = 0;
    list.forEach((train) => {
      const compiled = compilePath(train);
      if (!compiled) return;
      playable += 1;
      seconds += compiled.duration;
    });
    if (playable > 1)
      seconds += (playable - 1) * (TUNE.TERMINUS_HOLD_MS / 1000);
    return {
      trains: playable,
      skipped: list.length - playable,
      // The clock is scaled by the speed multiplier, the closing overview is
      // not — it is a fixed camera move either way.
      seconds: seconds / speed + (TUNE.FINALE_MS + TUNE.FINALE_HOLD_MS) / 1000,
    };
  }

  // What a burnt-in video caption needs, in one call: the player bar is DOM
  // and never reaches the canvas, so the recorder redraws this itself.
  function captionState() {
    const train = queue[queueIndex];
    const station =
      path && stationIndex >= 0 ? path.stations[stationIndex] : null;
    return {
      title: train
        ? I18N.t("video.caption", {
            date: dateLabel(getTrainDate(train)),
            train: train.number || train.id,
            from: train.origin || "?",
            to: train.destination || "?",
          })
        : "",
      station: station ? station.name : "",
      progress: path ? Math.min(1, elapsed / path.duration) : 0,
      color: path ? path.color : DEFAULT_TRAIN_COLOR,
    };
  }

  // What the current scope IS, in the words the sidebar uses for it. The
  // export dialog names it so "record" can never be ambiguous about which
  // trains it is about to record.
  function scopeLabel() {
    const picked = selectedTrainId || focusedTrainId;
    if (picked) {
      const train = getTrain(picked);
      if (train) return train.number || train.id;
    }
    if (selectedDate === ALL_DATES) return I18N.t("date.all");
    return dateLabel(selectedDate);
  }

  function onFinish(fn) {
    if (typeof fn !== "function") return () => {};
    finishListeners.add(fn);
    return () => finishListeners.delete(fn);
  }

  function currentPhase() {
    return phase;
  }

  // The player owns the session (the bar is up, the queue is frozen).
  function isActive() {
    return phase !== "idle" && phase !== "ended";
  }

  // The player owns the CAMERA, i.e. it is issuing a jumpTo every frame.
  // Narrower than isActive on purpose: while armed or paused the map is
  // still, and the things that skip work during playback — the endpoint-label
  // relayout above all — have no reason to skip it then.
  function isDrivingCamera() {
    return phase === "playing" || phase === "transitioning";
  }

  function setSpeed(value) {
    const step = TUNE.SPEED_STEP;
    const raw = Number(value) || 1;
    speed = Math.min(
      TUNE.SPEED_MAX,
      Math.max(TUNE.SPEED_MIN, Math.round(raw / step) * step),
    );
    renderBar();
    return speed;
  }

  // ── §8 player bar ──────────────────────────────────────────────────────

  function showBar(visible) {
    const bar = els.playbackBar;
    if (!bar) return;
    bar.hidden = !visible;
  }

  // The station name in the bar is the guaranteed-legible copy of what the
  // map is showing: map labels are collision-managed and a dense district can
  // drop one, but the bar always names the station just reached.
  function renderStationLabel() {
    const el = els.playbackStation;
    if (!el) return;
    const station =
      path && stationIndex >= 0 ? path.stations[stationIndex] : null;
    el.textContent = station ? station.name : "";
    el.hidden = !station;
  }

  function renderProgress(fraction) {
    const fill = els.playbackProgressFill;
    if (!fill) return;
    const f = Math.max(0, Math.min(1, Number(fraction) || 0));
    fill.style.transform = `scaleX(${f})`;
  }

  function renderBar() {
    const bar = els.playbackBar;
    if (!bar) return;
    const playing = phase === "playing" || phase === "transitioning";
    if (els.playbackToggle) {
      els.playbackToggle.textContent = playing
        ? I18N.t("play.pause")
        : phase === "ended"
          ? I18N.t("play.replay")
          : I18N.t("play.resume");
      els.playbackToggle.setAttribute("aria-pressed", playing ? "true" : "false");
    }
    if (els.playbackSpeedValue)
      els.playbackSpeedValue.textContent = `${speed.toFixed(2).replace(/0$/, "")}×`;
    if (els.playbackSpeed && Number(els.playbackSpeed.value) !== speed)
      els.playbackSpeed.value = String(speed);
    if (els.playbackLabel) {
      const train = queue[queueIndex];
      els.playbackLabel.textContent =
        phase === "ended" || !train
          ? I18N.t("play.done")
          : I18N.t("play.now", {
              index: queueIndex + 1,
              total: queue.length,
              train: train.number || train.id,
              from: train.origin || "?",
              to: train.destination || "?",
            });
    }
    if (els.playbackPrev) els.playbackPrev.disabled = queueIndex <= 0;
    if (els.playbackNext)
      els.playbackNext.disabled = queueIndex >= queue.length - 1;
  }

  function bindUi() {
    if (els.playTrains)
      els.playTrains.addEventListener("click", () => {
        if (isActive()) stop();
        else start();
      });
    if (els.playbackToggle)
      els.playbackToggle.addEventListener("click", () => {
        if (phase === "ended") {
          // Replay means replay: re-arm and run, opening on the same
          // whole-scope overview the first run opened on.
          stop({ keepBar: true });
          start({ autoBegin: true });
        } else toggle();
      });
    // The close button always closes something. Three states reach it and
    // each needs a different act, and the one that used to do nothing at all
    // was the last of them: a bar left up by a finished export, with the run
    // already idle, so stop() returned immediately and the ✕ was inert.
    if (els.playbackStop)
      els.playbackStop.addEventListener("click", () => {
        const video =
          typeof PlaybackVideo !== "undefined" ? PlaybackVideo : null;
        // Recording: cancel it — which stops the run and KEEPS the partial
        // file on offer rather than throwing the recording away.
        if (video && video.isRecording()) {
          video.cancel();
          return;
        }
        // Anything that is not IDLE gets the full stop, "ended" above all.
        // isActive() deliberately excludes "ended" — it answers "does the
        // player own the session", and a finished run does not — but the map
        // after a finished run is still carrying the trail, the station beads,
        // the playhead and the selection highlight, and only stop() takes
        // those down. Closing on isActive() left every one of them behind.
        if (phase !== "idle") {
          stop();
          if (video) video.dismissBanner();
          return;
        }
        // Idle, but the bar is still up carrying a finished file.
        if (video) video.dismissBanner();
        setGesturesEnabled(true);
        showBar(false);
      });
    if (els.playbackPrev)
      els.playbackPrev.addEventListener("click", () => skip(-1));
    if (els.playbackNext)
      els.playbackNext.addEventListener("click", () => skip(1));
    if (els.playbackSpeed) {
      els.playbackSpeed.min = String(TUNE.SPEED_MIN);
      els.playbackSpeed.max = String(TUNE.SPEED_MAX);
      els.playbackSpeed.step = String(TUNE.SPEED_STEP);
      els.playbackSpeed.value = String(speed);
      // input, not change: the slider only writes one number and the next
      // frame reads it. Nothing here rebuilds records, so there is nothing
      // to debounce.
      els.playbackSpeed.addEventListener("input", () =>
        setSpeed(els.playbackSpeed.value),
      );
    }
    // rAF is suspended in a hidden tab, so a backgrounded page would resume
    // with one enormous frame. Park the clock instead.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && phase === "playing") pause();
    });
    if (typeof I18N !== "undefined" && I18N.onChange)
      I18N.onChange(() => {
        // Station names are baked into the compiled paths, so a language
        // switch has to drop them or the next playback would label the map
        // in the previous language.
        invalidatePaths();
        renderBar();
        renderStationLabel();
      });
    renderBar();
  }

  return {
    start,
    pause,
    resume,
    toggle,
    stop,
    skip,
    setSpeed,
    begin,
    prepare,
    isDrivingCamera,
    onFinish,
    captionState,
    scopeLabel,
    phase: currentPhase,
    isActive,
    bindUi,
    notifyExternalRender,
    invalidatePaths,
    TUNE,
  };
})();
