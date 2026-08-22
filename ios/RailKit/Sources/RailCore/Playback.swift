import Foundation

// ─────────────────────────────────────────────────────────────────────────
//  Playback — the itinerary playback clock, ported from `app-playback.js`.
//
//  What survives the port is the part that answers questions about *time and
//  place*: how long a journey plays for, how that budget is split between its
//  station-to-station intervals, where the head is at time t, which stations
//  it has passed, and where the camera should be. What does not survive is
//  everything that drove MapLibre — see "What the shell still owns" below.
//
//  The two laws are coupled on purpose, and the JavaScript's header is worth
//  repeating because both are easy to "improve" into nonsense:
//
//    · duration — a clamped curve on the run's ridden length, so every
//      journey lands between a floor and a ceiling however long it is;
//    · zoom     — derived from the resulting ground speed against ONE target
//      SCREEN speed, so a long journey ends up further out (and therefore
//      covers ground visibly faster) while a short one is played close in.
//
//  Deriving zoom from speed rather than from length independently is what
//  stops the two laws from cancelling: keyed separately, a 5 km hop played at
//  z15 ran across the screen SIX TIMES faster than a 400 km hop at z8 — the
//  exact opposite of "short lines play slower".
//
//  ## Two rules this file exists to keep
//
//  **Zoom is one constant per journey, not per interval.** It used to be
//  computed per ridden interval, and a limited express with thirty-odd stops
//  then re-framed the map at every one of them. A map that rescales every
//  second is unreadable however correct each frame is. The apparent
//  speeding-up and slowing-down between stations is real and is still there —
//  it lives in the *time allocation* (``Tuning/hopExponent``), not in the
//  camera. ``Path/zoom`` is a single number for the whole run.
//
//  **The camera is a chase, not a sequence of flyTos.** ``advanceCamera(_:)``
//  decays the OFFSET between camera and train while feeding the train's own
//  motion forward untouched. Feeding the motion forward is what keeps the dot
//  exactly centred during a run (a plain ease-toward-target would trail it by
//  speed × tau, about 95 px, forever); decaying the offset is what absorbs a
//  change of train without anybody waiting for a camera animation to finish.
//  There is deliberately no "flying between trains" state, and nothing here
//  waits for tiles: a frame is computed from `dt` and the previous frame's
//  state, never from a completion callback.
//
//  ## What the shell still owns
//
//  Everything below is *absent from this file on purpose*, and a MapKit shell
//  has to build all of it:
//
//    · the frame clock itself (`requestAnimationFrame` → `CADisplayLink`),
//      including parking it when the app backgrounds. This file supplies the
//      per-frame arithmetic; it does not schedule anything.
//    · applying ``CameraFrame`` to the map. The JavaScript issues one
//      `map.jumpTo` per frame — never `flyTo`/`easeTo` while running — and a
//      MapKit shell must do the equivalent (`setCamera` with no animation, or
//      an `MKMapCamera` written straight onto `mapView.camera`). Note the
//      zoom is a **web-Mercator zoom level**; MapKit takes an altitude or a
//      span, so the shell owns that conversion.
//    · every layer: the playhead dot, the trail behind it, the per-run
//      gradient the ``RunProgress`` numbers feed, the station beads and their
//      pulse, the "just reached" label. `setPlaybackHead`, `setPlaybackTrail`,
//      `setPlaybackProgress`, `setPlaybackStations`, `setPlaybackStationIndex`
//      and `clearPlayback` are all shell.
//    · the queue and the phases (`idle`/`armed`/`playing`/`transitioning`/
//      `paused`/`ended`), the player bar, gesture suppression while the
//      camera is owned, the whole-scope overview at the start and the
//      day-overview finale at the end, and the caption/scope strings. Those
//      are policy about a UI, not about time and place.
//    · `resolveQueue` — which trains "play" means — because it reads the
//      selection, the date filter and the search box.
//    · the compiled-path cache. ``cacheKey(train:)`` is ported because the
//      key is the contract; the `Map` it indexes is the shell's.
//    · localisation of station names: ``compile(train:features:localize:)``
//      takes the closure the JavaScript spells `I18N.stationName`.
//
//  The video export (`app-playback-video.js`) is deliberately NOT ported. It
//  exists only because a WebGL canvas cannot be read back, so the web app
//  records `canvas.captureStream()` into a `<video>` and composites captions
//  over it. iOS has neither that constraint nor that solution.
// ─────────────────────────────────────────────────────────────────────────

public enum Playback {

    // MARK: - §1 tuning

    /// `TUNE`. Calibrated against the shipped Japan sample (201 trains / 2 303
    /// ridden intervals): hop lengths p10 0.9 km, p50 3.2 km, p90 20.3 km;
    /// journey lengths p50 16 km, p90 270 km, max 826 km.
    ///
    /// These are `Object.freeze`d in the JavaScript and read by the video
    /// exporter, so they are part of the module's surface rather than private
    /// constants.
    public enum Tuning {

        /// Journey duration, seconds, as a function of ridden km. The clamp IS
        /// the "shortest / longest playback time" contract: nothing plays for
        /// under `tMin`, nothing for over `tMax`, however extreme its length.
        public static let tMin = 4.0
        public static let tMax = 20.0
        public static let tBase = 3.0
        public static let tSlope = 0.7

        /// How the journey's time budget is split between its ridden
        /// intervals. Share ∝ metres^`hopExponent` with the exponent < 1 means
        /// a short interval gets more time PER METRE than a long one — "short
        /// interval slower, long interval faster" — while the journey total
        /// stays exactly the budget.
        ///
        /// Raised from 0.30 when the zoom stopped following each interval:
        /// with a fixed zoom for the whole journey the interval-to-interval
        /// speed spread is now seen at ONE scale, and 0.30 made a 260 km hop
        /// blur past between two 7 km ones. 0.45 keeps the short-slow /
        /// long-fast ordering while halving the spread.
        ///
        /// **This is where the pace lives.** Anyone tempted to reintroduce a
        /// per-interval zoom should change this number instead.
        public static let hopExponent = 0.45

        /// Target speed of the marker across the SCREEN, px/s at 1×. The only
        /// number here tuned by eye; every zoom in the run follows from it.
        public static let velocityPixelsPerSecond = 210.0
        public static let zoomMin = 8.2
        public static let zoomMax = 15.4

        /// Exponential smoothing of the zoom track, seconds. The track itself
        /// is already piecewise-linear between interval midpoints; this takes
        /// the last corner off it (and off the first frame after a train
        /// change).
        ///
        /// Deliberately SLOWER than ``centerTau``. The catch-up zoom is a
        /// function of the gap, so if the two converged at the same rate the
        /// zoom would keep pace with the closing distance and the train would
        /// hang at the same pixel offset for the whole arc. Letting the
        /// position close first lands the train in the middle, and the detail
        /// zoom arrives just after.
        public static let zoomTau = 0.55

        /// The camera chases the train rather than being placed on it: each
        /// frame the OFFSET between them decays by this time constant while
        /// the train's own motion is fed forward untouched.
        public static let centerTau = 0.32

        /// While catching up, the camera frames BOTH itself and the train,
        /// which draws the zoom-out-then-in arc a `flyTo` would have drawn —
        /// for free, and with the next train already running underneath it.
        /// This floor is lower than ``zoomMin`` because a cross-country
        /// hand-off needs to pull back further than any actual journey does.
        public static let zoomCatchUpMin = 6.0

        /// Arming the player frames the WHOLE scope first — the day, the queue
        /// or the one selected train — so the reader sees what is about to be
        /// played before any of it moves. Shell-owned; kept because the video
        /// exporter reads them and because ``plan(compiled:speed:)`` counts
        /// the finale into its estimate.
        public static let overviewMilliseconds = 800.0
        public static let overviewMaxZoom = 13.5
        public static let introMilliseconds = 900.0

        /// A beat on arrival, so the terminus reads as one.
        public static let terminusHoldMilliseconds = 200.0
        public static let finaleMilliseconds = 1600.0
        public static let finaleHoldMilliseconds = 900.0
        public static let finaleMaxZoom = 13.5

        /// A tab that stalls (GC, a slow tile batch) must not teleport the
        /// marker. On iOS the equivalent stall is a dropped display link.
        public static let maxFrameSeconds = 0.1

        /// How long a station stays "just reached" after the head passes it.
        public static let stationPulseSeconds = 0.45

        public static let speedMin = 0.5
        public static let speedMax = 4.0
        public static let speedStep = 0.25
    }

    /// Metres per pixel at zoom 0 on the equator, MapLibre's 512 px tile grid.
    ///
    /// A MapKit shell converting ``Path/zoom`` to an altitude or a span has to
    /// start from this number, because it is the definition the zoom was
    /// computed against.
    public static let metersPerPixelAtZoom0 = 78271.517

    /// `DEG` — degrees to radians.
    static let degreesToRadians = Double.pi / 180

    // MARK: - §3 geometry: compile a train into a playable path

    /// One solved hop as `getMatchedRouteFeatures` hands it over.
    ///
    /// `rideSegment` is the answer to `properties.ride_segment === true`, not
    /// to `if (properties.ride_segment)`. The distinction is load-bearing and
    /// real hand-edited data exercises it: `1` and `"true"` are both truthy
    /// and both mean *not ridden* here. The shell that decodes the feature
    /// owns that test, the same way `Statistics` does.
    public struct RiddenFeature: Sendable, Equatable {
        public var geometry: RouteGeometry?
        public var rideSegment: Bool
        /// `Number(properties.segment_index ?? -1)` — the index of the stop
        /// this interval departs from, and the only surviving link back to
        /// `train.stops`. Features were filtered to the RIDDEN ones, so their
        /// position in the array no longer matches their position in `stops`.
        ///
        /// A `Double` rather than an `Int` because `Number()` of a
        /// non-numeric string is NaN, and NaN is a usable `Map` key in
        /// JavaScript. Such a key never resolves to a stop (`stops[NaN]` is
        /// `undefined`), so it produces no station either way — the port
        /// drops it, which is observationally identical.
        public var segmentIndex: Double

        public init(geometry: RouteGeometry?, rideSegment: Bool, segmentIndex: Double) {
            self.geometry = geometry
            self.rideSegment = rideSegment
            self.segmentIndex = segmentIndex
        }
    }

    /// A CONTIGUOUS stretch of drawn geometry.
    ///
    /// Runs exist because a route may legitimately arrive as one path WITH
    /// GAPS (`geometry_role: single_path_with_gaps`) or lose a middle interval
    /// to `ride_segment: false`. Concatenating across such a hole would draw a
    /// chord straight over the map; keeping runs separate lets the trail skip
    /// it and the marker step across it.
    ///
    /// The gap contributes **zero length**, so in the global arc coordinate
    /// the runs simply concatenate and the head crosses the hole in one frame
    /// rather than sliding over open country.
    public struct Run: Sendable, Equatable {
        public var coords: [Coordinate]
        /// Cumulative metres from this run's own start, one entry per vertex.
        public var cum: [Double]
        public var total: Double
        /// Where this run begins in the journey's global arc coordinate.
        public var offset: Double
    }

    /// One ridden interval: a stretch of arc, and the slice of the journey's
    /// time budget it was given.
    public struct Hop: Sendable, Equatable {
        public var s0: Double
        public var s1: Double
        public var meters: Double
        public var segmentIndex: Double
        public var t0: Double
        public var t1: Double
    }

    /// A station the running train actually STOPS at, with the arc distance it
    /// sits at.
    public struct Station: Sendable, Equatable {
        public var s: Double
        public var coord: Coordinate
        public var color: String
        /// Already localised. The JavaScript bakes the string in here rather
        /// than at draw time, because the label layer reads a baked string and
        /// a language switch repaints the whole map anyway (which ends
        /// playback and drops every compiled path).
        public var name: String
    }

    /// A train compiled into something playable.
    public struct Path: Sendable, Equatable {
        /// ONE zoom for the whole journey — see this file's header.
        public var zoom: Double
        public var stations: [Station]
        public var trainID: String
        public var color: String
        public var runs: [Run]
        public var hops: [Hop]
        public var totalMeters: Double
        public var duration: Double
        public var start: Coordinate?
        public var end: Coordinate?
    }

    /// `compilePath`. Returns nil when the train has no ridden geometry at all
    /// — the JavaScript's `if (!hops.length || globalS <= 0) return null`,
    /// which the queue reads as "skip this train".
    ///
    /// - Parameters:
    ///   - features: `getMatchedRouteFeatures(train)`, unfiltered. The
    ///     `ride_segment === true` filter is applied here, in order, because
    ///     the order is what the arc coordinate is built from.
    ///   - localize: `I18N.stationName`. Defaults to identity, which is what
    ///     the fixture's sandbox supplies; a shell passes
    ///     `Localization.stationName(_:code:)`.
    public static func compile(
        train: Train,
        features: [RiddenFeature],
        localize: (String, String?) -> String = { name, _ in name }
    ) -> Path? {
        let ridden = features.filter { $0.rideSegment }

        var runs: [Run] = []
        var hops: [Hop] = []
        var globalS = 0.0

        // `run` is the run currently being appended to. Held as an index
        // because `Run` is a value type; the JavaScript holds the object.
        var current: Int? = nil

        func startRun(_ first: Coordinate) {
            runs.append(Run(coords: [first], cum: [0], total: 0, offset: 0))
            current = runs.count - 1
        }

        // The JavaScript wraps this call in `metersBetween`, whose comment
        // says "equirectangular on the shared constants, same approximation
        // the route modules use". That comment is wrong, and the parity run
        // proves it: the bare `distanceMeters` this resolves to in the
        // app-family scope is app-route-simplify.js's HAVERSINE, because
        // rail-network.js's equirectangular one of the same name is closed
        // over inside that module and never reaches the family. The two read
        // ~0.1125 % apart, so it is not a distinction without a difference —
        // and six of the seven fixture journeys match this port bit for bit,
        // which they could not do against the other metric. Ported as it
        // behaves, not as it is described.
        func pushCoord(_ c: Coordinate) {
            guard let index = current else { return }
            let last = runs[index].coords[runs[index].coords.count - 1]
            let step = Geometry.distanceMeters(last, c)
            // A duplicate vertex at an interval boundary. `step <= 0` is
            // false for NaN, exactly as in JavaScript, so a NaN step would be
            // appended and would poison the run's cum — which is the honest
            // reproduction: nothing upstream can produce one.
            if step <= 0 { return }
            runs[index].coords.append(c)
            runs[index].total += step
            runs[index].cum.append(runs[index].total)
            globalS += step
        }

        for feature in ridden {
            let hopStart = globalS
            for line in featureLines(feature) {
                if line.count < 2 { continue }
                if current == nil {
                    startRun(line[0])
                } else {
                    let index = current!
                    let last = runs[index].coords[runs[index].coords.count - 1]
                    // A new line that does not continue the current run opens
                    // a new one. 1 m is well under the 5-decimal grid the
                    // geometry sits on, so an exact continuation always joins
                    // and a real hole never does.
                    if Geometry.distanceMeters(last, line[0]) > 1 { startRun(line[0]) }
                }
                for i in 1..<line.count { pushCoord(line[i]) }
            }
            if globalS > hopStart {
                hops.append(
                    Hop(
                        s0: hopStart, s1: globalS, meters: globalS - hopStart,
                        segmentIndex: feature.segmentIndex, t0: 0, t1: 0
                    )
                )
            }
        }

        if hops.isEmpty || globalS <= 0 { return nil }

        var offset = 0.0
        for i in runs.indices {
            runs[i].offset = offset
            offset += runs[i].total
        }

        let km = globalS / 1000
        let budget = min(
            Tuning.tMax,
            max(Tuning.tMin, Tuning.tBase + Tuning.tSlope * km.squareRoot())
        )
        let weights = hops.map { pow($0.meters, Tuning.hopExponent) }
        // `|| 1` in the JavaScript: a zero sum would divide every share by
        // zero. Unreachable while globalS > 0, kept because it is the code.
        var weightSum = weights.reduce(0, +)
        if weightSum == 0 || weightSum.isNaN { weightSum = 1 }
        var clock = 0.0
        for i in hops.indices {
            hops[i].t0 = clock
            clock += budget * weights[i] / weightSum
            hops[i].t1 = clock
        }

        // ONE zoom for the whole journey, fixed by the JOURNEY's average
        // ground speed against the same screen-speed target. A short journey
        // still plays close in and a long one still plays pulled back, and
        // nothing moves in between. Which intervals feel slow or fast is
        // unchanged — that lives in the time split above, not in the scale.
        let midPoint = position(in: runs, atDistance: globalS / 2)
        let lat = midPoint?.lat ?? 36
        let averageSpeed = globalS / max(0.001, clock)
        let zoom = min(
            Tuning.zoomMax,
            max(
                Tuning.zoomMin,
                log2(
                    (metersPerPixelAtZoom0 * JSMath.cos(lat * degreesToRadians))
                        / max(0.05, averageSpeed / Tuning.velocityPixelsPerSecond)
                )
            )
        )

        let color = train.style?.color ?? TrainValidation.defaultTrainColor
        return Path(
            zoom: zoom,
            stations: stationList(train: train, runs: runs, hops: hops, localize: localize),
            trainID: train.id,
            color: color,
            runs: runs,
            hops: hops,
            totalMeters: globalS,
            duration: clock,
            start: position(in: runs, atDistance: 0),
            end: position(in: runs, atDistance: globalS)
        )
    }

    /// `featureLines` — raw (unquantized) coordinate lines of one route
    /// feature.
    ///
    /// Deliberately NOT `iterateGeometryLines`: that snaps every vertex to the
    /// 5-decimal graph grid, which is right for identity keys and wrong for a
    /// marker that has to slide along the drawn stroke without stepping.
    ///
    /// `RouteGeometry` carries only the two shapes the route pipeline
    /// produces, so a feature with any other geometry — or none — decodes to
    /// `nil` and contributes nothing, which is the JavaScript's
    /// `if (!g || !g.coordinates) return []` and its final `return []`.
    static func featureLines(_ feature: RiddenFeature) -> [[Coordinate]] {
        feature.geometry?.lines ?? []
    }

    /// `buildStationList` — the stations the running train actually STOPS at,
    /// in running order, with the arc distance each sits at.
    ///
    /// Membership follows the data, not a guess: `pass_through` stops are
    /// excluded because the schema already calls them non-stops (jsonspec
    /// §7.2), and a stop only enters at all if it bounds a RIDDEN interval —
    /// an unridden or hidden stretch contributes no stations, exactly as it
    /// contributes no geometry. `origin` / `passenger_stop` /
    /// `operational_stop` / `destination` all qualify, and so does a stop that
    /// declares no type.
    static func stationList(
        train: Train, runs: [Run], hops: [Hop], localize: (String, String?) -> String
    ) -> [Station] {
        let stops = train.stops
        let color = train.style?.color ?? TrainValidation.defaultTrainColor

        // stop index → arc distance, from the intervals that survived the
        // filter. The `if (!has)` on `s0` and the unconditional `set` on
        // `s1` are not symmetric by accident: for a stop that both ends hop k
        // and begins hop k+1, hop k's ARRIVAL distance is the one that wins.
        // They are equal when the two hops are contiguous and differ across a
        // gap, and the arrival is the right answer there.
        var distanceByStop: [Int: Double] = [:]
        var order: [Int] = []
        func set(_ key: Int, _ value: Double) {
            if distanceByStop.updateValue(value, forKey: key) == nil { order.append(key) }
        }
        for hop in hops {
            // NaN fails this test in JavaScript too (`NaN < 0` is false), and
            // then indexes nothing; see ``RiddenFeature/segmentIndex``.
            guard hop.segmentIndex >= 0, let index = exactIndex(hop.segmentIndex) else { continue }
            if distanceByStop[index] == nil { set(index, hop.s0) }
            set(index + 1, hop.s1)
        }

        var stations: [Station] = []
        for stopIndex in order.sorted() {
            guard stopIndex < stops.count else { continue }  // `stops[i]` → undefined
            let stop = stops[stopIndex]
            if stop.stopType == "pass_through" { continue }
            let name = stop.name
            if name.isEmpty { continue }
            guard let s = distanceByStop[stopIndex],
                let coord = position(in: runs, atDistance: s)
            else { continue }
            stations.append(
                Station(s: s, coord: coord, color: color, name: localize(name, stop.n02StationCode))
            )
        }
        return stations
    }

    /// JavaScript resolves `array[x]` through the *string* form of `x`, so
    /// only an exact non-negative integer ever names an element. `stops[1.5]`
    /// and `stops[NaN]` are both `undefined`.
    private static func exactIndex(_ value: Double) -> Int? {
        guard value.isFinite, value >= 0, value == value.rounded(.towardZero),
            value <= Double(Int.max - 1)
        else { return nil }
        return Int(value)
    }

    // MARK: - reading a path

    /// `positionAtDistance` — global arc distance → coordinate, by binary
    /// search inside the owning run.
    ///
    /// The interpolation is plain arithmetic (`a + (b - a) * r`) on vertices
    /// that were *copied*, not computed, so given the same `cum` it is exact
    /// to the bit.
    public static func position(in runs: [Run], atDistance s: Double) -> Coordinate? {
        if runs.isEmpty { return nil }
        // Last run whose offset the distance has reached; runs[0] if none,
        // which is also what a NaN `s` selects.
        var run = runs[0]
        for i in stride(from: runs.count - 1, through: 0, by: -1) where s >= runs[i].offset {
            run = runs[i]
            break
        }
        let local = max(0, min(run.total, s - run.offset))
        let cum = run.cum
        var lo = 0
        var hi = cum.count - 1
        while lo < hi - 1 {
            let mid = (lo + hi) >> 1
            if cum[mid] <= local { lo = mid } else { hi = mid }
        }
        let span = cum[hi] - cum[lo]
        let r = span > 0 ? (local - cum[lo]) / span : 0
        let a = run.coords[lo]
        let b = run.coords[hi]
        return Coordinate(lon: a.lon + (b.lon - a.lon) * r, lat: a.lat + (b.lat - a.lat) * r)
    }

    /// Which run the head is in, and how far along THAT run it is (0…1) — the
    /// two numbers the trail gradient needs.
    public struct RunProgress: Sendable, Equatable {
        public var index: Int
        public var t: Double
    }

    /// `runProgressAtDistance`.
    public static func runProgress(in runs: [Run], atDistance s: Double) -> RunProgress {
        var index = 0
        for i in stride(from: runs.count - 1, through: 0, by: -1) where s >= runs[i].offset {
            index = i
            break
        }
        let run = runs[index]
        let local = max(0, min(run.total, s - run.offset))
        return RunProgress(index: index, t: run.total > 0 ? local / run.total : 1)
    }

    /// `distanceAtTime` — journey time → global arc distance. Linear inside
    /// each interval, so the pace changes at stations and nowhere else.
    ///
    /// This function is where the whole "short interval slower, long interval
    /// faster" reading comes from: the interval boundaries are evenly spaced
    /// in *arc*, and unevenly spaced in *time* by ``Tuning/hopExponent``.
    public static func distance(in path: Path, atTime t: Double) -> Double {
        let hops = path.hops
        if t <= 0 { return 0 }
        if t >= path.duration { return path.totalMeters }
        var lo = 0
        var hi = hops.count - 1
        while lo < hi {
            let mid = (lo + hi) >> 1
            if hops[mid].t1 < t { lo = mid + 1 } else { hi = mid }
        }
        let h = hops[lo]
        let span = h.t1 - h.t0
        let r = span > 0 ? (t - h.t0) / span : 1
        return h.s0 + (h.s1 - h.s0) * r
    }

    // MARK: - §6 the camera

    /// The camera's state between frames. There is nothing else: no target, no
    /// animation, no queue of moves.
    public struct CameraChase: Sendable, Equatable {
        /// `camError` — where the camera is RELATIVE to the train, in degrees.
        /// The whole camera is derived from this: centre = train + offset, and
        /// the offset decays. `nil` is the JavaScript's `null`, which the
        /// first frame reads as (0, 0).
        public var offsetLon: Double?
        public var offsetLat: Double?
        /// `zoomSmoothed`. `nil` means "no track yet", and the first frame
        /// adopts the aimed zoom outright instead of easing toward it.
        public var zoom: Double?

        public init(offsetLon: Double? = nil, offsetLat: Double? = nil, zoom: Double? = nil) {
            self.offsetLon = offsetLon
            self.offsetLat = offsetLat
            self.zoom = zoom
        }

        /// The hand-off the JavaScript performs mid-queue and on resume:
        /// wherever the camera happens to be IS the new offset, and the chase
        /// closes it from there rather than snapping. Nothing waits.
        public mutating func handOff(cameraCenter: Coordinate, to head: Coordinate) {
            offsetLon = cameraCenter.lon - head.lon
            offsetLat = cameraCenter.lat - head.lat
        }
    }

    public struct CameraFrame: Sendable, Equatable {
        public var center: Coordinate
        /// Web-Mercator zoom level, not a MapKit altitude. See
        /// ``metersPerPixelAtZoom0``.
        public var zoom: Double
    }

    /// `Math.exp`, for the only range the chase can reach.
    ///
    /// V8 answers `Math.exp` from its own fdlibm port (`base/ieee754.cc`)
    /// rather than from the platform, and this was measured rather than
    /// assumed: over the frame deltas this module actually produces, Darwin's
    /// `exp` disagrees with V8's on about one input in fifteen, by 1 ULP.
    /// `pow`, `log2` and `hypot` were measured on the same run and agree, so
    /// they are still the platform's — see `PlaybackParityTests.libm`, which
    /// carries V8's answers for all four.
    ///
    /// One ULP of `exp` is a nanometre of camera, which nobody can see. It is
    /// ported anyway because the camera track is the one output of this file
    /// that is checked frame by frame, and a check that passes only because
    /// the quantity being scaled happens to be zero is not a check.
    ///
    /// Only fdlibm's `k == 0` branch is here. `advanceCamera` calls this with
    /// `-dt / tau`, `dt` is already clamped to ``Tuning/maxFrameSeconds`` and
    /// the smaller tau is ``Tuning/centerTau``, so |x| ≤ 0.3125 — inside the
    /// 0.5 ln 2 threshold below which fdlibm performs no argument reduction
    /// at all. Anything larger would need the reduction and the 2^k scaling,
    /// so it traps rather than silently falling back to a function that
    /// answers differently.
    ///
    /// It belongs in `JSMath` beside `cos` and `hypot`; it is here because
    /// this port owns three files and that is not one of them.
    static func jsExp(_ x: Double) -> Double {
        let P1 = 1.66666666666666019037e-01
        let P2 = -2.77777777770155933842e-03
        let P3 = 6.61375632143793436117e-05
        let P4 = -1.65339022054652515390e-06
        let P5 = 4.13813679705723846039e-08

        let hx = UInt32(truncatingIfNeeded: x.bitPattern >> 32) & 0x7fff_ffff
        precondition(
            hx <= 0x3fd6_2e42,
            """
            Playback.jsExp was called with |x| > 0.5 ln 2. It is only ever \
            passed -dt / tau with dt clamped to MAX_FRAME_S, so this means an \
            unclamped frame delta; fdlibm's argument reduction is not ported, \
            and substituting the platform's exp would silently change the \
            answer.
            """
        )
        if hx < 0x3e30_0000 { return 1 + x }  // |x| < 2^-28: 1 + x is exact enough
        let t = x * x
        let c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
        return 1 - ((x * c) / (c - 2.0) - x)
    }

    /// `catchUpZoom` — the zoom that still shows the train while the camera is
    /// behind it.
    ///
    /// The camera sits at the centre, so seeing a train `gap` away needs a
    /// viewport spanning about 2 × gap; the 2.3 margin keeps it off the very
    /// edge. Once the gap closes this returns `target` unchanged and the arc
    /// ends by itself — which is how a `flyTo`-shaped zoom-out-then-in move
    /// gets drawn for free, with the next train already running underneath it.
    ///
    /// - Parameter shortSidePixels: `min(clientWidth, clientHeight)` of the
    ///   map view. The floor of 240 is applied here, as in the JavaScript,
    ///   which also treats a zero measurement as 240.
    public static func catchUpZoom(
        center: Coordinate, head: Coordinate, target: Double, shortSidePixels: Double
    ) -> Double {
        let gap = Geometry.distanceMeters(center, head)
        if gap < 200 { return target }
        let shortSide = max(240, shortSidePixels.isZero || shortSidePixels.isNaN ? 240 : shortSidePixels)
        let mpp = (gap * 2.3) / shortSide
        let zFit = log2(
            (metersPerPixelAtZoom0 * JSMath.cos(head.lat * degreesToRadians)) / max(0.05, mpp)
        )
        return max(Tuning.zoomCatchUpMin, min(target, zFit))
    }

    /// One frame of the chase.
    ///
    /// Decay the offset, then rebuild the centre from the train's CURRENT
    /// position — the train's own motion is fed forward untouched, which is
    /// what keeps the dot centred during a run instead of trailing it by
    /// speed × tau forever.
    ///
    /// Reduced motion snaps instead of chasing: `decay` becomes 0 and the zoom
    /// adopts its aim outright, so the camera is placed on the train every
    /// frame with no arc at all.
    ///
    /// - Parameter dt: seconds, **already clamped** to
    ///   ``Tuning/maxFrameSeconds`` — which is what ``frameDelta(nowMilliseconds:lastFrameMilliseconds:)``
    ///   and therefore ``Playhead/advance(nowMilliseconds:path:speed:shortSidePixels:reducedMotion:)``
    ///   guarantee. ``jsExp(_:)`` traps outside that range rather than
    ///   answering differently from V8.
    public static func advanceCamera(
        _ chase: inout CameraChase,
        dt: Double,
        head: Coordinate,
        targetZoom: Double,
        shortSidePixels: Double,
        reducedMotion: Bool
    ) -> CameraFrame {
        let decay = reducedMotion ? 0 : jsExp(-dt / Tuning.centerTau)
        let lon = (chase.offsetLon ?? 0) * decay
        let lat = (chase.offsetLat ?? 0) * decay
        chase.offsetLon = lon
        chase.offsetLat = lat
        let center = Coordinate(lon: head.lon + lon, lat: head.lat + lat)
        let aimed = catchUpZoom(
            center: center, head: head, target: targetZoom, shortSidePixels: shortSidePixels
        )
        if chase.zoom == nil || reducedMotion {
            chase.zoom = aimed
        } else {
            chase.zoom! += (aimed - chase.zoom!) * (1 - jsExp(-dt / Tuning.zoomTau))
        }
        return CameraFrame(center: center, zoom: chase.zoom!)
    }

    // MARK: - stations passed

    /// `stationIndex` / `stationPulse`: which station the head has most
    /// recently reached, and how "just reached" it still is.
    public struct StationCursor: Sendable, Equatable {
        /// -1 before the first station, as in the JavaScript.
        public var index: Int = -1
        public var pulse: Double = 0

        public init(index: Int = -1, pulse: Double = 0) {
            self.index = index
            self.pulse = pulse
        }

        /// `advanceStations`. Light every station the head has now reached,
        /// and keep the newest one swollen for a moment so an arrival reads as
        /// an event.
        ///
        /// The half-metre lookahead is the JavaScript's, and it matters at a
        /// terminus: the last station sits at exactly `totalMeters`, and the
        /// final frame's `s` is that same value — but an interpolated arc
        /// distance one frame earlier can land a hair short of it.
        ///
        /// - Returns: whether a station was reached this frame, which is what
        ///   the label re-render is gated on.
        @discardableResult
        public mutating func advance(
            to s: Double, dt: Double, stations: [Station]
        ) -> Bool {
            var arrived = false
            while index + 1 < stations.count, stations[index + 1].s <= s + 0.5 {
                index += 1
                arrived = true
            }
            if arrived {
                pulse = 1
            } else if pulse > 0 {
                pulse = max(0, pulse - dt / Tuning.stationPulseSeconds)
            }
            return arrived
        }
    }

    // MARK: - the playhead

    /// Everything one frame answers. The shell paints from this and nothing
    /// else.
    public struct Frame: Sendable, Equatable {
        /// Seconds into the current journey, already speed-scaled.
        public var elapsed: Double
        /// The journey time this frame describes — `elapsed`, clamped to the
        /// duration on the last frame so the head lands exactly on the
        /// terminus rather than a fraction past it.
        public var time: Double
        public var distance: Double
        /// nil only when the path has no runs, which `compile` cannot produce.
        public var head: Coordinate?
        public var camera: CameraFrame?
        public var runProgress: RunProgress
        public var stations: StationCursor
        /// `time / duration` — the progress bar's fraction, before the bar's
        /// own clamp to 0…1.
        public var progress: Double
        /// The journey is over; the shell holds the terminus for
        /// ``Tuning/terminusHoldMilliseconds`` and then moves to the next.
        public var finished: Bool
    }

    /// The mutable half of a running journey.
    ///
    /// Deliberately not an object with a timer inside it: the shell owns the
    /// clock and calls ``advance(dt:path:speed:shortSidePixels:reducedMotion:)``
    /// once per display-link callback.
    public struct Playhead: Sendable, Equatable {
        public var elapsed: Double = 0
        public var camera = CameraChase()
        public var stations = StationCursor()
        /// `lastFrameMs`. The clock's own reading of when it last ran, which
        /// is what makes ``advance(nowMilliseconds:path:speed:shortSidePixels:reducedMotion:)``
        /// a faithful port of `frame(now)` rather than of an idealised `dt`.
        public var lastFrameMilliseconds: Double = 0

        public init(
            elapsed: Double = 0, camera: CameraChase = CameraChase(),
            stations: StationCursor = StationCursor(), lastFrameMilliseconds: Double = 0
        ) {
            self.elapsed = elapsed
            self.camera = camera
            self.stations = stations
            self.lastFrameMilliseconds = lastFrameMilliseconds
        }

        /// `runClock`'s `lastFrameMs = performance.now()`. Call this whenever
        /// the clock starts or restarts — beginning a journey, resuming from a
        /// pause — or the first frame after the gap will be charged the whole
        /// gap (and then clamped to ``Tuning/maxFrameSeconds``, which is the
        /// safety net rather than the intent).
        public mutating func startClock(atMilliseconds now: Double) {
            lastFrameMilliseconds = now
        }

        /// `frame()`, minus the paint calls.
        ///
        /// The order is the JavaScript's and is load-bearing: camera first,
        /// then the marker and the trail, so all three describe the same
        /// instant. The marker rides the TRAIN, never the camera — during a
        /// catch-up those differ, and the train is the truth.
        public mutating func advance(
            nowMilliseconds now: Double,
            path: Path,
            speed: Double,
            shortSidePixels: Double,
            reducedMotion: Bool
        ) -> Frame {
            let dt = Playback.frameDelta(
                nowMilliseconds: now, lastFrameMilliseconds: lastFrameMilliseconds)
            lastFrameMilliseconds = now
            elapsed += dt * speed
            let finished = elapsed >= path.duration
            let t = finished ? path.duration : elapsed
            let s = Playback.distance(in: path, atTime: t)
            guard let head = Playback.position(in: path.runs, atDistance: s) else {
                // The JavaScript finishes the train outright on a null
                // coordinate rather than painting a broken frame.
                return Frame(
                    elapsed: elapsed, time: t, distance: s, head: nil, camera: nil,
                    runProgress: RunProgress(index: 0, t: 1), stations: stations,
                    progress: t / path.duration, finished: true
                )
            }
            let camera = Playback.advanceCamera(
                &self.camera, dt: dt, head: head, targetZoom: path.zoom,
                shortSidePixels: shortSidePixels, reducedMotion: reducedMotion
            )
            let progress = Playback.runProgress(in: path.runs, atDistance: s)
            stations.advance(to: s, dt: dt, stations: path.stations)
            return Frame(
                elapsed: elapsed, time: t, distance: s, head: head, camera: camera,
                runProgress: progress, stations: stations,
                progress: t / path.duration, finished: finished
            )
        }
    }

    /// The `dt` clamp. A stalled frame (GC, a slow tile batch, a backgrounded
    /// app) must not teleport the marker, so the clock advances by at most
    /// ``Tuning/maxFrameSeconds`` however long the gap really was.
    public static func frameDelta(nowMilliseconds: Double, lastFrameMilliseconds: Double)
        -> Double
    {
        min(Tuning.maxFrameSeconds, max(0, (nowMilliseconds - lastFrameMilliseconds) / 1000))
    }

    // MARK: - §7 what a run will cost

    /// `prepare()`'s answer.
    public struct Plan: Sendable, Equatable {
        public var trains: Int
        public var skipped: Int
        public var seconds: Double
    }

    /// `prepare()` — what the run will cost, from the paths already compiled
    /// for the current scope. `nil` entries are trains that produced no
    /// geometry; they are counted as skipped and cost nothing.
    ///
    /// The clock is scaled by the speed multiplier; the closing overview is
    /// not — it is a fixed camera move either way.
    ///
    /// **Two things this estimate gets wrong, reproduced rather than fixed.**
    /// A port that quietly corrected either would be a port whose
    /// disagreements can no longer be read.
    ///
    ///  1. The terminus holds are added *before* the division, so they are
    ///     scaled by `speed` — but `finishTrain` waits
    ///     ``Tuning/terminusHoldMilliseconds`` on a plain timer that the speed
    ///     multiplier does not touch. At 4× a nine-train run is reported 1.2 s
    ///     short of the pause it will actually take.
    ///  2. Neither the opening whole-scope overview
    ///     (``Tuning/overviewMilliseconds``) nor the intro ease onto the first
    ///     train (``Tuning/introMilliseconds``) is counted, though the run
    ///     spends both before the clock starts — about 1.7 s unaccounted for
    ///     at the front, against a closing 2.5 s that *is* counted.
    public static func plan(compiled: [Path?], speed: Double) -> Plan {
        var seconds = 0.0
        var playable = 0
        for path in compiled {
            guard let path else { continue }
            playable += 1
            seconds += path.duration
        }
        if playable > 1 {
            seconds += Double(playable - 1) * (Tuning.terminusHoldMilliseconds / 1000)
        }
        return Plan(
            trains: playable,
            skipped: compiled.count - playable,
            seconds: seconds / speed
                + (Tuning.finaleMilliseconds + Tuning.finaleHoldMilliseconds) / 1000
        )
    }

    /// `setSpeed`'s quantisation: snap to ``Tuning/speedStep`` and clamp.
    ///
    /// The `Number(value) || 1` in the JavaScript maps NaN **and zero** to 1,
    /// which is not the same as clamping — a slider that somehow reported 0
    /// plays at 1×, not at the 0.5× floor.
    public static func clampSpeed(_ value: Double) -> Double {
        let raw = (value.isNaN || value == 0) ? 1 : value
        return min(
            Tuning.speedMax,
            max(Tuning.speedMin, JSNumber.round(raw / Tuning.speedStep) * Tuning.speedStep)
        )
    }

    // MARK: - the compiled-path cache key

    /// `pathCacheKey`. Compiled paths outlive one playback: replaying a day
    /// costs nothing the second time. Keyed on the same inputs the route
    /// render keys on, so an edited train recompiles and an untouched one does
    /// not — and on the ride flags as well, because those decide which
    /// features survive the filter and therefore the whole arc coordinate.
    ///
    /// The cache itself belongs to the shell; only the key is a contract.
    public static func cacheKey(train: Train) -> String {
        let rides = train.stops.map { $0.rideSegment ? "1" : "0" }.joined()
        let sections = (train.routeSections ?? []).map {
            RouteGraph.RouteSection(
                from: $0.from, to: $0.to,
                fromStationCode: $0.fromN02StationCode,
                toStationCode: $0.toN02StationCode,
                lineNames: $0.lineNames ?? [], operatorNames: $0.operatorNames ?? []
            )
        }
        return "\(train.id):\(RouteGraph.templateKey(sections: sections)):\(rides)"
    }
}
