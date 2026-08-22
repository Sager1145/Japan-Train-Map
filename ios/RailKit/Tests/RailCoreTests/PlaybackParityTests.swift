import Foundation
import Testing

@testable import RailCore

/// `port-fixtures/playback.json` — the itinerary playback timeline of
/// `app-playback.js` §3/§6.
///
/// Two of these cases exist because the repository has already paid for the
/// rule once and must not lose it again:
///
///  * ``zoomIsOneConstantPerJourney`` — a compiled path carries exactly ONE
///    zoom, and the intervals inside it carry metres-per-second that differ by
///    an order of magnitude. That is the whole rule: the pace a reader sees
///    between stations lives in the time split, not in the camera. A port that
///    re-derived zoom per interval would still pass every position check here
///    and would make the map rescale at every stop.
///  * ``sequences`` — the mid-queue hand-off and the resume, which are the only
///    places the camera actually has something to chase. A single-train run
///    begins with an intro ease, so its offset is (0, 0) and a port that
///    *placed* the camera on the train instead of chasing it would match every
///    one of the 3 584 single-train frame values and none of the hand-off ones.
///
/// Everything is compared on `Double.bitPattern` except the two quantities
/// that are sums of `Geometry.distanceMeters` — see ``arcDistancesAreLibmBound``
/// for the measurement and why a ULP ceiling rather than an epsilon.
struct PlaybackParityTests {

    // MARK: - fixture shapes

    /// A JSON value whose *type* is part of the case. `ride_segment` arrives
    /// as `true`, `false`, `1` or `"true"`, and decoding that into `Bool`
    /// would erase exactly the distinction under test.
    enum AnyJSON: Decodable, Sendable {
        case string(String), number(Double), bool(Bool), null

        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if c.decodeNil() {
                self = .null
            } else if let b = try? c.decode(Bool.self) {
                self = .bool(b)
            } else if let d = try? c.decode(Double.self) {
                self = .number(d)
            } else if let s = try? c.decode(String.self) {
                self = .string(s)
            } else {
                self = .null
            }
        }

        /// `x === true`, which is what the ride filter asks.
        var isExactlyTrue: Bool {
            if case .bool(true) = self { return true }
            return false
        }
    }

    struct PooledGeometry: Decodable {
        let id: Int
        let type: String?
        let lines: [String]
    }

    struct FeatureCase: Decodable {
        let geometry: Int
        let rideSegment: AnyJSON
        /// `Number(segment_index ?? -1)`, already coerced. JSON cannot carry
        /// NaN, so a null here is the NaN a non-numeric `segment_index` would
        /// produce — which names no stop either way.
        let segmentIndex: Double?
    }

    struct PathCase: Decodable {
        struct RunRow: Decodable {
            let offset: Double
            let total: Double
            let coordCount: Int
            let coords: String
            let cum: String
        }
        struct StationRow: Decodable {
            let s: Double
            let coord: [Double]
            let color: String
            let name: String
        }
        let zoom: Double
        let duration: Double
        let totalMeters: Double
        let color: String
        let trainId: String
        let start: [Double]?
        let end: [Double]?
        let runs: [RunRow]
        /// `s0 s1 meters segIndex t0 t1`
        let hops: [String]
        let stations: [StationRow]
    }

    /// One recorded run of the module's own rAF callback.
    ///
    /// `startedAt` is what `runClock` put in `lastFrameMs`, and each row opens
    /// with the frame's TIMESTAMP rather than its length — because `frame(now)`
    /// derives `dt` from the gap and then clamps it, so a fixture recording an
    /// already-clamped `dt` would hide the clamp entirely.
    struct FrameRun: Decodable {
        let startedAt: Double
        let rows: [String]
    }

    struct TrainCase: Decodable {
        let trainId: String
        let why: String
        let cacheKey: String
        let features: [FeatureCase]
        let path: PathCase
        /// `t s lon lat runIndex runT`
        let samples: [String]
        /// `s lon lat runIndex runT`
        let distanceSamples: [String]
        /// `now headLon headLat centerLon centerLat zoom runIndex runT
        /// stationIndex stationPulse barFraction`
        let frames: FrameRun
        let stalledFrames: FrameRun
    }

    struct SyntheticCase: Decodable {
        let key: String
        let why: String
        let features: [FeatureCase]
        let color: String
        let path: PathCase?
        let samples: [String]
        let distanceSamples: [String]
    }

    struct SequenceCase: Decodable {
        struct Step: Decodable {
            /// `intro` | `handoff` | `resume`
            let kind: String
            let trainId: String
            let center: [Double]
            let zoom: Double
            let startedAt: Double
            let frames: [String]
        }
        let key: String
        let why: String
        let steps: [Step]
    }

    struct CatchUpCase: Decodable {
        let center: [Double]
        let train: [Double]
        let target: Double
        let shortSide: Double
        let zoom: Double
    }

    struct SpeedCase: Decodable {
        let input: AnyJSON
        let speed: Double
    }

    struct PlanCase: Decodable {
        let scope: String
        let speed: Double
        let trains: Int
        let skipped: Int
        let seconds: Double
    }

    struct Tuning: Decodable {
        let T_MIN: Double, T_MAX: Double, T_BASE: Double, T_SLOPE: Double
        let HOP_EXP: Double, V_PX: Double, Z_MIN: Double, Z_MAX: Double
        let ZOOM_TAU: Double, CENTER_TAU: Double, Z_CATCHUP_MIN: Double
        let OVERVIEW_MS: Double, OVERVIEW_MAX_ZOOM: Double, INTRO_MS: Double
        let TERMINUS_HOLD_MS: Double, FINALE_MS: Double, FINALE_HOLD_MS: Double
        let FINALE_MAX_ZOOM: Double, MAX_FRAME_S: Double, STATION_PULSE_S: Double
        let SPEED_MIN: Double, SPEED_MAX: Double, SPEED_STEP: Double
    }

    /// `{ x, y }` — one input and V8's answer for it.
    struct LibmCase: Decodable {
        let x: Double
        let y: Double
    }

    struct Libm: Decodable {
        let pow: [LibmCase]
        let exp: [LibmCase]
        let log2: [LibmCase]
        let cos: [LibmCase]
    }

    struct Fixture: Decodable {
        let libm: Libm
        let tuning: Tuning
        let mppZoom0: Double
        let degreesToRadians: Double
        let geometries: [PooledGeometry]
        let cases: [TrainCase]
        let sequences: [SequenceCase]
        let synthetic: [SyntheticCase]
        let catchUp: [CatchUpCase]
        let speeds: [SpeedCase]
        let plans: [PlanCase]
    }

    // MARK: - loading

    nonisolated(unsafe) private static var loaded: Fixture?
    nonisolated(unsafe) private static var loadedStore: TrainStore?

    static func fixture() throws -> Fixture {
        if let loaded { return loaded }
        let value = try PortFixtures.decode(Fixture.self, "playback.json")
        loaded = value
        return value
    }

    /// The committed Japanese store, decoded through the ported `Train` model.
    /// The fixture names its itineraries by id rather than copying them, so
    /// this is the same store the JavaScript solved.
    static func store() throws -> TrainStore {
        if let loadedStore { return loadedStore }
        let url = try PortFixtures.repositoryRoot().appending(path: "app/data/train-store.json")
        let value = try JSONDecoder().decode(TrainStore.self, from: Data(contentsOf: url))
        loadedStore = value
        return value
    }

    static func train(_ id: String) throws -> Train {
        let store = try store()
        guard let train = store.trains.first(where: { $0.id == id }) else {
            throw CocoaError(.fileNoSuchFile)
        }
        return train
    }

    // MARK: - decoding the packed rows

    static func numbers(_ row: String) -> [Double] {
        // strtod is exact and JavaScript's Number→String is shortest
        // round-trip, so the doubles arrive unchanged.
        row.split(separator: " ").map { Double($0) ?? .nan }
    }

    static func coordinates(_ encoded: String) -> [Coordinate] {
        guard !encoded.isEmpty else { return [] }
        return encoded.split(separator: ";").map { pair in
            let parts = pair.split(separator: " ")
            return Coordinate(lon: Double(parts[0]) ?? .nan, lat: Double(parts[1]) ?? .nan)
        }
    }

    static func features(
        _ rows: [FeatureCase], _ pool: [PooledGeometry]
    ) -> [Playback.RiddenFeature] {
        rows.map { row in
            let pooled = pool[row.geometry]
            let lines = pooled.lines.map(coordinates)
            let geometry: RouteGeometry?
            switch pooled.type {
            case "LineString": geometry = .lineString(lines.first ?? [])
            case "MultiLineString": geometry = .multiLineString(lines)
            default: geometry = nil
            }
            return Playback.RiddenFeature(
                geometry: geometry,
                rideSegment: row.rideSegment.isExactlyTrue,
                segmentIndex: row.segmentIndex ?? .nan
            )
        }
    }

    // MARK: - measuring a disagreement

    /// Accumulates how far apart the two implementations are, in ULP, so a
    /// test can state a measured ceiling instead of an invented epsilon. A
    /// relative epsilon loose enough to absorb a library difference is also
    /// loose enough to absorb a wrong constant.
    struct Divergence {
        var worst: Int64 = 0
        var inexact = 0
        var total = 0
        var worstLabel = ""

        mutating func record(_ got: Double, _ want: Double, _ label: @autoclosure () -> String) {
            total += 1
            if got.bitPattern == want.bitPattern { return }
            if got.isNaN && want.isNaN { return }
            inexact += 1
            let ulps = got.ulpDistance(to: want)
            if ulps > worst {
                worst = ulps
                worstLabel = "\(label()): \(got) vs \(want)"
            }
        }

        var summary: String {
            "\(inexact)/\(total) inexact, worst \(worst) ULP — \(worstLabel)"
        }
    }

    /// The four quantities kept apart, because they diverge for different
    /// reasons and a single worst-of-everything number would hide which.
    ///
    ///  * `positions` — longitude and latitude. Interpolated with `+ - * /`
    ///    from vertices that were COPIED, so the only thing that can move them
    ///    is the arc coordinate they are indexed by.
    ///  * `arcs` — metres. Running sums of `Geometry.distanceMeters`, which is
    ///    a haversine over Darwin's `sin`/`cos`/`asin` rather than V8's fdlibm
    ///    port of them.
    ///  * `times` — seconds. Derived from `arcs` through `pow`.
    ///  * `ratios` — the 0…1 fractions and the zoom track, which divide two
    ///    nearly equal members of `arcs` and therefore amplify whatever is in
    ///    them.
    struct Trackers {
        var positions = Divergence()
        var arcs = Divergence()
        var times = Divergence()
        var ratios = Divergence()

        var summary: String {
            """
            positions \(positions.summary)
            arcs      \(arcs.summary)
            times     \(times.summary)
            ratios    \(ratios.summary)
            """
        }
    }

    // MARK: - the measured ceilings

    // A measurement, not a tolerance chosen to pass. Over the whole fixture —
    // seven real itineraries, eight synthetic feature lists, two hand-off
    // sequences, 28 370 compared coordinates, 27 991 compared arc distances,
    // 621 compared interval times and 16 721 compared fractions:
    //
    //     positions   71 / 28 370 inexact, worst 1 ULP
    //     arcs     1 063 / 27 991 inexact, worst 4 ULP
    //     times       38 /    621 inexact, worst 3 ULP
    //     ratios     835 / 16 721 inexact, worst 6 ULP
    //
    // Everything else is exact: every compiled `zoom`, every `catchUpZoom`,
    // every `totalMeters` and `duration`, every station name, colour and
    // vertex, and every run and interval count — on all seven journeys,
    // including the Sunrise's 825.7 km over 10 954 vertices.
    //
    // And all four numbers come from ONE EDGE OF ONE RIDE. Six of the seven
    // itineraries are bit-exact end to end (``arcDistancesAreLibmBound``
    // asserts that, so it cannot quietly stop being true). The seventh,
    // 20260721_08_asoboy3, first disagrees at its 49th vertex, on the 103.3 m
    // edge (130.70397, 32.78174) → (130.70495, 32.78217) near 立野:
    // `Geometry.distanceMeters` is a haversine over Darwin's `sin`/`cos`/
    // `asin` rather than V8's fdlibm port of them, and this pair is one of the
    // ~3 % `FixtureParityTests.distances` already measures at 1–2 ULP. The arc
    // coordinate is a RUNNING SUM, so all 581 later `cum` entries inherit that
    // one difference, every position interpolated between two of them inherits
    // it once more, and every 0…1 fraction — which divides two nearly equal
    // members of the same sum — amplifies it to 6 ULP.
    //
    // So these ceilings are not this port's error; they are
    // `Geometry.distanceMeters`'s, propagated. Porting V8's `sin` and `asin`
    // into `JSMath` beside `cos` would take all four to zero and is the only
    // change that would. A relative epsilon would be the wrong tool: one loose
    // enough to absorb a library difference is also loose enough to absorb a
    // wrong constant.

    /// Longitude and latitude. Interpolated with `+ - * /` from vertices that
    /// were COPIED, so the only thing that can move them is the arc
    /// coordinate they are indexed by.
    static let POSITION_ULP: Int64 = 1
    /// Arc distances in metres — the running sums themselves.
    static let ARC_ULP: Int64 = 4
    /// Interval times in seconds, derived from the arcs through `pow`.
    static let TIME_ULP: Int64 = 3
    /// The 0…1 fractions and the smoothed zoom, which divide two nearly equal
    /// arc distances and therefore amplify whatever is in them.
    static let RATIO_ULP: Int64 = 6

    // MARK: - the compiled path

    @Test("a real itinerary compiles to the same path")
    func compiledPaths() throws {
        let fixture = try Self.fixture()
        #expect(fixture.cases.count >= 4)

        var t = Trackers()

        for item in fixture.cases {
            let train = try Self.train(item.trainId)
            let features = Self.features(item.features, fixture.geometries)
            let path = try #require(
                Playback.compile(train: train, features: features),
                "\(item.trainId) compiled to nothing"
            )
            try Self.expectPath(path, item.path, label: item.trainId, into: &t)
            #expect(Playback.cacheKey(train: train) == item.cacheKey)
        }

        // Positions are interpolated with `+ - * /` on vertices that were
        // COPIED rather than computed, so they are exact given the same arc
        // distances. The arc distances themselves are sums of thousands of
        // haversines, and `Geometry.distanceMeters` is already known to sit
        // within 2 ULP of V8 on ~3 % of real inputs (FixtureParityTests
        // .distances) because Darwin's sin/cos/asin are not V8's fdlibm port.
        // Summing that many terms cannot absorb it. This is the measurement,
        // not a tolerance chosen to pass.
        #expect(t.positions.worst <= Self.POSITION_ULP, "compiled paths:\n\(t.summary)")
        #expect(t.arcs.worst <= Self.ARC_ULP, "compiled paths:\n\(t.summary)")
        #expect(t.times.worst <= Self.TIME_ULP, "compiled paths:\n\(t.summary)")
    }

    static func expectPath(
        _ got: Playback.Path, _ want: PathCase, label: String, into t: inout Trackers
    ) throws {
        var arcs = t.arcs, times = t.times, positions = t.positions
        defer { t.arcs = arcs; t.times = times; t.positions = positions }
        #expect(got.trainID == want.trainId, "\(label): train id")
        #expect(got.color == want.color, "\(label): colour")
        #expect(got.zoom.bitPattern == want.zoom.bitPattern, "\(label): zoom")
        arcs.record(got.totalMeters, want.totalMeters, "\(label).totalMeters")
        times.record(got.duration, want.duration, "\(label).duration")

        #expect(got.runs.count == want.runs.count, "\(label): run count")
        for (i, run) in got.runs.enumerated() where i < want.runs.count {
            let expected = want.runs[i]
            #expect(run.coords.count == expected.coordCount, "\(label): run \(i) vertex count")
            // Vertices are copied, never computed. Anything but bit equality
            // here means the port dropped or kept a different vertex.
            let wantCoords = coordinates(expected.coords)
            #expect(run.coords.count == wantCoords.count, "\(label): run \(i) coords")
            for (j, c) in run.coords.enumerated() where j < wantCoords.count {
                #expect(
                    c.lon.bitPattern == wantCoords[j].lon.bitPattern
                        && c.lat.bitPattern == wantCoords[j].lat.bitPattern,
                    "\(label): run \(i) vertex \(j)"
                )
            }
            arcs.record(run.offset, expected.offset, "\(label).run\(i).offset")
            arcs.record(run.total, expected.total, "\(label).run\(i).total")
            let wantCum = numbers(expected.cum)
            #expect(run.cum.count == wantCum.count, "\(label): run \(i) cum length")
            for (j, value) in run.cum.enumerated() where j < wantCum.count {
                arcs.record(value, wantCum[j], "\(label).run\(i).cum[\(j)]")
            }
        }

        #expect(got.hops.count == want.hops.count, "\(label): interval count")
        for (i, hop) in got.hops.enumerated() where i < want.hops.count {
            let row = numbers(want.hops[i])
            arcs.record(hop.s0, row[0], "\(label).hop\(i).s0")
            arcs.record(hop.s1, row[1], "\(label).hop\(i).s1")
            arcs.record(hop.meters, row[2], "\(label).hop\(i).meters")
            #expect(hop.segmentIndex == row[3], "\(label): hop \(i) segment index")
            times.record(hop.t0, row[4], "\(label).hop\(i).t0")
            times.record(hop.t1, row[5], "\(label).hop\(i).t1")
        }

        #expect(got.stations.count == want.stations.count, "\(label): station count")
        for (i, station) in got.stations.enumerated() where i < want.stations.count {
            let expected = want.stations[i]
            #expect(station.name == expected.name, "\(label): station \(i) name")
            #expect(station.color == expected.color, "\(label): station \(i) colour")
            arcs.record(station.s, expected.s, "\(label).station\(i).s")
            positions.record(station.coord.lon, expected.coord[0], "\(label).station\(i).lon")
            positions.record(station.coord.lat, expected.coord[1], "\(label).station\(i).lat")
        }

        if let start = want.start {
            let mine = try #require(got.start, "\(label): start")
            positions.record(mine.lon, start[0], "\(label).start.lon")
            positions.record(mine.lat, start[1], "\(label).start.lat")
        }
        if let end = want.end {
            let mine = try #require(got.end, "\(label): end")
            positions.record(mine.lon, end[0], "\(label).end.lon")
            positions.record(mine.lat, end[1], "\(label).end.lat")
        }
    }

    // MARK: - the timeline

    @Test("the timeline answers the same position at every sampled instant")
    func timeline() throws {
        let fixture = try Self.fixture()
        var t = Trackers()
        var sampled = 0

        for item in fixture.cases {
            let train = try Self.train(item.trainId)
            let path = try #require(
                Playback.compile(
                    train: train, features: Self.features(item.features, fixture.geometries))
            )
            sampled += try Self.expectSamples(
                path, times: item.samples, distances: item.distanceSamples,
                label: item.trainId, into: &t
            )
        }

        // A journey has two endpoints and hundreds of interior instants, and
        // only the interior ones reach the binary search — so this number
        // being large is the point of the case, not decoration.
        #expect(sampled > 1500, "only \(sampled) timeline samples")
        #expect(t.positions.worst <= Self.POSITION_ULP, "timeline:\n\(t.summary)")
        #expect(t.arcs.worst <= Self.ARC_ULP, "timeline:\n\(t.summary)")
        #expect(t.ratios.worst <= Self.RATIO_ULP, "timeline:\n\(t.summary)")
    }

    static func expectSamples(
        _ path: Playback.Path, times: [String], distances: [String],
        label: String, into t: inout Trackers
    ) throws -> Int {
        var positions = t.positions, arcs = t.arcs, ratios = t.ratios
        defer { t.positions = positions; t.arcs = arcs; t.ratios = ratios }
        for (i, row) in times.enumerated() {
            let want = numbers(row)
            let s = Playback.distance(in: path, atTime: want[0])
            arcs.record(s, want[1], "\(label).sample[\(i)].s @t=\(want[0])")
            let coord = Playback.position(in: path.runs, atDistance: s)
            positions.record(coord?.lon ?? .nan, want[2], "\(label).sample[\(i)].lon")
            positions.record(coord?.lat ?? .nan, want[3], "\(label).sample[\(i)].lat")
            let progress = Playback.runProgress(in: path.runs, atDistance: s)
            #expect(
                Double(progress.index) == want[4],
                "\(label): sample \(i) run index at t=\(want[0])")
            ratios.record(progress.t, want[5], "\(label).sample[\(i)].runT")
        }
        for (i, row) in distances.enumerated() {
            let want = numbers(row)
            let coord = Playback.position(in: path.runs, atDistance: want[0])
            positions.record(coord?.lon ?? .nan, want[1], "\(label).distance[\(i)].lon")
            positions.record(coord?.lat ?? .nan, want[2], "\(label).distance[\(i)].lat")
            let progress = Playback.runProgress(in: path.runs, atDistance: want[0])
            #expect(
                Double(progress.index) == want[3],
                "\(label): distance sample \(i) run index at s=\(want[0])")
            ratios.record(progress.t, want[4], "\(label).distance[\(i)].runT")
        }
        return times.count + distances.count
    }

    // MARK: - the rule the zoom carries

    /// One zoom for the whole journey — never per interval.
    ///
    /// This does not check a number against the fixture; the numbers are
    /// checked above. It checks the *shape* of the answer, which is what a
    /// port drifts on: a compiled path exposes exactly one zoom, and its
    /// intervals move at speeds that differ enough that a per-interval zoom
    /// would be visibly different. If someone reintroduces one, the position
    /// checks will all still pass and this will not.
    @Test("zoom is one constant per journey, and the pace lives in the time split")
    func zoomIsOneConstantPerJourney() throws {
        let fixture = try Self.fixture()
        var sawWideSpread = false

        for item in fixture.cases {
            let train = try Self.train(item.trainId)
            let path = try #require(
                Playback.compile(
                    train: train, features: Self.features(item.features, fixture.geometries))
            )
            guard path.hops.count > 3 else { continue }

            // Metres per second, interval by interval.
            let speeds = path.hops.compactMap { hop -> Double? in
                let span = hop.t1 - hop.t0
                return span > 0 ? hop.meters / span : nil
            }
            let fastest = speeds.max() ?? 0
            let slowest = speeds.min() ?? 0
            #expect(slowest > 0, "\(item.trainId): an interval with no time")
            if fastest / slowest > 3 { sawWideSpread = true }

            // Share ∝ metres^HOP_EXP with the exponent below 1: a shorter
            // interval must get MORE time per metre than a longer one. That
            // ordering is the feature; the exponent is only its dial.
            let sorted = path.hops.sorted { $0.meters < $1.meters }
            if let shortest = sorted.first, let longest = sorted.last,
                longest.meters > shortest.meters * 2
            {
                let shortPace = (shortest.t1 - shortest.t0) / shortest.meters
                let longPace = (longest.t1 - longest.t0) / longest.meters
                #expect(
                    shortPace > longPace,
                    """
                    \(item.trainId): the short interval is not getting more time \
                    per metre than the long one — HOP_EXP is the whole reason \
                    the run reads as slowing into a station
                    """
                )
            }

            // And the budget is spent exactly: the intervals tile [0, duration].
            #expect(path.hops.first!.t0 == 0, "\(item.trainId): the clock does not start at 0")
            #expect(
                path.hops.last!.t1.bitPattern == path.duration.bitPattern,
                "\(item.trainId): the intervals do not add up to the duration"
            )
            for i in 1..<path.hops.count {
                #expect(
                    path.hops[i].t0.bitPattern == path.hops[i - 1].t1.bitPattern,
                    "\(item.trainId): a gap between intervals \(i - 1) and \(i)"
                )
            }
        }

        #expect(
            sawWideSpread,
            """
            no sampled journey had intervals more than 3× apart in ground speed. \
            That spread is what ONE zoom has to cover, so a fixture without it \
            cannot show that the zoom is not following the intervals.
            """
        )
        // The zoom clamps are a contract in their own right — nothing plays \
        // further out than Z_MIN or closer in than Z_MAX, however extreme.
        for item in fixture.cases {
            #expect(item.path.zoom >= Playback.Tuning.zoomMin)
            #expect(item.path.zoom <= Playback.Tuning.zoomMax)
            #expect(item.path.duration >= Playback.Tuning.tMin)
            #expect(item.path.duration <= Playback.Tuning.tMax)
        }
    }

    // MARK: - the camera

    @Test("a single-train run produces the same camera track frame by frame")
    func frames() throws {
        let fixture = try Self.fixture()
        var t = Trackers()
        var frames = 0

        for item in fixture.cases {
            let train = try Self.train(item.trainId)
            let path = try #require(
                Playback.compile(
                    train: train, features: Self.features(item.features, fixture.geometries))
            )
            for (name, run) in [("frames", item.frames), ("stalled", item.stalledFrames)] {
                // An intro hand-off: the camera was eased onto the first frame
                // and the clock waited for it, so the chase starts with no
                // offset and the zoom track already at the journey's zoom.
                var playhead = Playback.Playhead(
                    camera: Playback.CameraChase(offsetLon: 0, offsetLat: 0, zoom: path.zoom),
                    lastFrameMilliseconds: run.startedAt
                )
                frames += Self.replay(
                    run.rows, path: path, playhead: &playhead,
                    label: "\(item.trainId).\(name)", into: &t
                )
            }
        }

        #expect(frames > 500, "only \(frames) frames replayed")
        #expect(t.positions.worst <= Self.POSITION_ULP, "camera:\n\(t.summary)")
        #expect(t.ratios.worst <= Self.RATIO_ULP, "camera:\n\(t.summary)")
    }

    /// The hand-off and the resume — where the chase has something to chase.
    @Test("the camera chases across a hand-off instead of flying")
    func sequences() throws {
        let fixture = try Self.fixture()
        #expect(!fixture.sequences.isEmpty)
        var t = Trackers()

        for sequence in fixture.sequences {
            var playhead = Playback.Playhead()
            var path: Playback.Path? = nil
            var lastCenter: Coordinate? = nil
            var maxOffsetDegrees = 0.0

            for (index, step) in sequence.steps.enumerated() {
                let label = "\(sequence.key)[\(index)] \(step.kind) \(step.trainId)"
                switch step.kind {
                case "intro", "handoff":
                    let train = try Self.train(step.trainId)
                    guard
                        let item = fixture.cases.first(where: { $0.trainId == step.trainId })
                    else {
                        Issue.record("\(label): the fixture has no features for this train")
                        continue
                    }
                    let compiled = try #require(
                        Playback.compile(
                            train: train,
                            features: Self.features(item.features, fixture.geometries))
                    )
                    path = compiled
                    // beginTrain resets the clock and the station cursor for
                    // every journey, intro or not.
                    playhead.elapsed = 0
                    playhead.stations = Playback.StationCursor()
                    if step.kind == "intro" {
                        playhead.camera = Playback.CameraChase(
                            offsetLon: 0, offsetLat: 0, zoom: compiled.zoom)
                    } else {
                        // Mid-queue: no camera animation to wait on, and
                        // therefore no gap between trains. All the hand-off
                        // does is record how far behind the camera is.
                        if let lastCenter {
                            #expect(
                                lastCenter.lon.bitPattern == step.center[0].bitPattern
                                    && lastCenter.lat.bitPattern == step.center[1].bitPattern,
                                "\(label): the camera was not where the previous journey left it"
                            )
                            #expect(
                                playhead.camera.zoom?.bitPattern == step.zoom.bitPattern,
                                "\(label): the smoothed zoom did not carry across the hand-off"
                            )
                        }
                        let start = try #require(compiled.start)
                        playhead.camera.handOff(
                            cameraCenter: Coordinate(lon: step.center[0], lat: step.center[1]),
                            to: start)
                    }
                case "resume":
                    // Wherever the reader left the camera IS the new offset,
                    // and the chase closes it from there rather than snapping.
                    let compiled = try #require(path, "\(label): resume with no journey")
                    let at = try #require(
                        Playback.position(
                            in: compiled.runs,
                            atDistance: Playback.distance(in: compiled, atTime: playhead.elapsed))
                    )
                    playhead.camera.handOff(
                        cameraCenter: Coordinate(lon: step.center[0], lat: step.center[1]), to: at)
                    playhead.camera.zoom = step.zoom
                default:
                    Issue.record("\(label): unknown step kind")
                    continue
                }

                maxOffsetDegrees = max(
                    maxOffsetDegrees,
                    abs(playhead.camera.offsetLon ?? 0) + abs(playhead.camera.offsetLat ?? 0))

                // runClock restarts the frame clock at every hand-off.
                playhead.startClock(atMilliseconds: step.startedAt)
                let compiled = try #require(path)
                _ = Self.replay(
                    step.frames, path: compiled, playhead: &playhead, label: label, into: &t)
                if let row = step.frames.last.map(Self.numbers) {
                    lastCenter = Coordinate(lon: row[3], lat: row[4])
                }
            }

            // If the offset were ever zero at a hand-off there would be no
            // chase to check, and the whole sequence would be measuring the
            // same thing the single-train frames already measure.
            #expect(
                maxOffsetDegrees > 1,
                """
                \(sequence.key): the camera was never more than 1° behind the \
                train, so this sequence never exercised the catch-up at all
                """
            )
        }

        #expect(t.positions.worst <= Self.POSITION_ULP, "camera across hand-offs:\n\(t.summary)")
        #expect(t.ratios.worst <= Self.RATIO_ULP, "camera across hand-offs:\n\(t.summary)")
    }

    /// Replays one recorded frame run and returns how many frames it compared.
    @discardableResult
    static func replay(
        _ rows: [String], path: Playback.Path, playhead: inout Playback.Playhead,
        label: String, into t: inout Trackers
    ) -> Int {
        var camera = t.positions, ratios = t.ratios
        defer { t.positions = camera; t.ratios = ratios }
        // Column 0 is the frame's timestamp. The clamp to MAX_FRAME_S lives
        // inside advance(), exactly where `frame(now)` puts it; feeding a
        // pre-clamped dt would hide the one case the stalled runs exist for.
        for (i, row) in rows.enumerated() {
            let want = numbers(row)
            let frame = playhead.advance(
                nowMilliseconds: want[0], path: path, speed: 1,
                // The fixture's stub map reports a 900 px short side.
                shortSidePixels: 900, reducedMotion: false
            )
            let head = frame.head
            camera.record(head?.lon ?? .nan, want[1], "\(label)[\(i)].head.lon")
            camera.record(head?.lat ?? .nan, want[2], "\(label)[\(i)].head.lat")
            camera.record(frame.camera?.center.lon ?? .nan, want[3], "\(label)[\(i)].center.lon")
            camera.record(frame.camera?.center.lat ?? .nan, want[4], "\(label)[\(i)].center.lat")
            ratios.record(frame.camera?.zoom ?? .nan, want[5], "\(label)[\(i)].zoom")
            #expect(
                Double(frame.runProgress.index) == want[6], "\(label): frame \(i) run index")
            ratios.record(frame.runProgress.t, want[7], "\(label)[\(i)].runT")
            #expect(
                Double(frame.stations.index) == want[8],
                "\(label): frame \(i) station index")
            ratios.record(frame.stations.pulse, want[9], "\(label)[\(i)].stationPulse")
            // renderProgress's own clamp, which is the only part of the bar
            // that is arithmetic rather than DOM.
            let bar = max(0, min(1, frame.progress.isNaN ? 0 : frame.progress))
            ratios.record(bar, want[10], "\(label)[\(i)].barFraction")
        }
        return rows.count
    }

    /// A stalled frame must not teleport the marker.
    @Test("a stalled frame advances by at most MAX_FRAME_S")
    func stalledFrameIsClamped() throws {
        let fixture = try Self.fixture()
        var sawStall = false
        for item in fixture.cases {
            var previous = item.stalledFrames.startedAt
            for row in item.stalledFrames.rows {
                let now = Self.numbers(row)[0]
                let raw = (now - previous) / 1000
                previous = now
                if raw > Playback.Tuning.maxFrameSeconds { sawStall = true }
                #expect(
                    Playback.frameDelta(nowMilliseconds: now, lastFrameMilliseconds: now - raw * 1000)
                        <= Playback.Tuning.maxFrameSeconds
                )
            }
        }
        // The recorded five-second stall is the case; without it this test
        // would be asserting a clamp that never fires.
        #expect(sawStall, "no recorded frame was long enough to hit the clamp")
        #expect(Playback.frameDelta(nowMilliseconds: 0, lastFrameMilliseconds: 100) == 0)
        #expect(Playback.frameDelta(nowMilliseconds: 5000, lastFrameMilliseconds: 0) == 0.1)
    }

    // MARK: - the geometry a real store never produces

    @Test("a hole in the ride opens a second run instead of drawing a chord")
    func syntheticGeometry() throws {
        let fixture = try Self.fixture()
        #expect(fixture.synthetic.count >= 6)
        var t = Trackers()
        var sawMultipleRuns = false
        var sawNull = false

        let base = try Self.train(Self.syntheticBaseID)
        for item in fixture.synthetic {
            var train = base
            train.id = item.path?.trainId ?? "\(Self.syntheticBaseID)__\(item.key)"
            let features = Self.features(item.features, fixture.geometries)
            let path = Playback.compile(train: train, features: features)

            guard let want = item.path else {
                #expect(path == nil, "\(item.key): compiled something out of nothing")
                sawNull = true
                continue
            }
            let got = try #require(path, "\(item.key): compiled to nothing")
            if got.runs.count > 1 { sawMultipleRuns = true }
            try Self.expectPath(got, want, label: item.key, into: &t)
            _ = try Self.expectSamples(
                got, times: item.samples, distances: item.distanceSamples,
                label: item.key, into: &t)
        }

        #expect(
            sawMultipleRuns,
            """
            no synthetic case produced more than one run. Nothing in the \
            committed store has a hole in it, so without one of these the run \
            machinery is never exercised — and a port that concatenates across \
            a hole passes every real case and draws a chord across the map.
            """
        )
        #expect(sawNull, "no synthetic case made compilePath return null")
        #expect(t.positions.worst <= Self.POSITION_ULP, "synthetic:\n\(t.summary)")
        #expect(t.arcs.worst <= Self.ARC_ULP, "synthetic:\n\(t.summary)")
        #expect(t.times.worst <= Self.TIME_ULP, "synthetic:\n\(t.summary)")
    }

    static let syntheticBaseID = "20260730_06_osaka_loop"

    /// The `ride_segment` filter is `=== true`, not "truthy".
    @Test("a truthy-but-not-true ride flag means NOT ridden")
    func rideSegmentIsIdentity() throws {
        let fixture = try Self.fixture()
        guard let item = fixture.synthetic.first(where: { $0.key == "ride_segment_truthy" }) else {
            Issue.record("the truthy ride-flag case is gone")
            return
        }
        // Every flag in this case is truthy — 1 and "true" — and every one of
        // them decodes to "not ridden", so nothing survives the filter.
        #expect(item.features.allSatisfy { !$0.rideSegment.isExactlyTrue })
        #expect(item.path == nil)
    }

    // MARK: - catch-up zoom

    @Test("the catch-up zoom frames both ends, and floors below Z_MIN")
    func catchUpZoom() throws {
        let fixture = try Self.fixture()
        #expect(fixture.catchUp.count > 20)
        var zooms = Divergence()
        var sawFloor = false
        var sawPassThrough = false

        for item in fixture.catchUp {
            let got = Playback.catchUpZoom(
                center: Coordinate(lon: item.center[0], lat: item.center[1]),
                head: Coordinate(lon: item.train[0], lat: item.train[1]),
                target: item.target,
                shortSidePixels: item.shortSide
            )
            zooms.record(got, item.zoom, "catchUp \(item.center)→\(item.train) @\(item.shortSide)")
            if got == Playback.Tuning.zoomCatchUpMin { sawFloor = true }
            if got == item.target { sawPassThrough = true }
        }

        // The floor is deliberately BELOW Z_MIN: a cross-country hand-off has
        // to pull back further than any actual journey does.
        #expect(Playback.Tuning.zoomCatchUpMin < Playback.Tuning.zoomMin)
        #expect(sawFloor, "no case reached Z_CATCHUP_MIN")
        #expect(sawPassThrough, "no case returned the target unchanged — the 200 m short-circuit")
        // Exact, and worth saying: catchUpZoom is the one place the port
        // reaches for JSMath.cos, and log2 of the same argument agrees.
        #expect(zooms.worst == 0, "catch-up zoom: \(zooms.summary)")
    }

    // MARK: - the transport

    @Test("the speed slider quantises and clamps the same way")
    func speedQuantisation() throws {
        let fixture = try Self.fixture()
        for item in fixture.speeds {
            // Number(value) — the DOM hands the module a string, so the
            // coercion is the shell's. What is ported is what happens after.
            let input: Double
            switch item.input {
            case .number(let d): input = d
            case .string(let s): input = Double(s) ?? .nan
            case .bool(let b): input = b ? 1 : 0
            case .null: input = 0  // Number(null) is 0
            }
            #expect(
                Playback.clampSpeed(input).bitPattern == item.speed.bitPattern,
                "speed for \(input)"
            )
        }
        // `Number(value) || 1` maps zero to 1, not to the 0.5 floor. Clamping
        // instead would be a plausible simplification and a different answer.
        #expect(Playback.clampSpeed(0) == 1)
        #expect(Playback.clampSpeed(.nan) == 1)
    }

    @Test("prepare() costs a run the same way")
    func plans() throws {
        let fixture = try Self.fixture()
        #expect(!fixture.plans.isEmpty)
        var seconds = Divergence()

        // The queue for the whole-store scope is the list order, which is
        // `sortTrainsByDateAndDeparture` — the same rule Dates already ports.
        // The order matters: `seconds` is a running sum, and a sum of seven
        // doubles added in a different order is a different double.
        let cases = fixture.cases
        let queue = Dates.sortByDateAndDeparture(
            try cases.map { item in
                let train = try Self.train(item.trainId)
                return Dates.Train(
                    id: train.id, date: train.date,
                    stops: train.stops.map {
                        Dates.Stop(
                            arrival: $0.arrival, departure: $0.departure, stopType: $0.stopType)
                    })
            })

        for plan in fixture.plans {
            let ids = plan.scope == "__all__" ? queue.compactMap(\.id) : [plan.scope]
            let compiled: [Playback.Path?] = try ids.map { id in
                guard let item = cases.first(where: { $0.trainId == id }) else { return nil }
                return Playback.compile(
                    train: try Self.train(id),
                    features: Self.features(item.features, fixture.geometries))
            }
            let got = Playback.plan(compiled: compiled, speed: plan.speed)
            #expect(got.trains == plan.trains, "\(plan.scope) @\(plan.speed)× train count")
            #expect(got.skipped == plan.skipped, "\(plan.scope) @\(plan.speed)× skipped")
            seconds.record(got.seconds, plan.seconds, "plan \(plan.scope) @\(plan.speed)×")
        }
        #expect(seconds.worst <= Self.TIME_ULP, "plan seconds: \(seconds.summary)")
    }

    // MARK: - constants

    @Test("the tuning block is the same block")
    func tuning() throws {
        let fixture = try Self.fixture()
        let t = fixture.tuning
        #expect(Playback.Tuning.tMin == t.T_MIN)
        #expect(Playback.Tuning.tMax == t.T_MAX)
        #expect(Playback.Tuning.tBase == t.T_BASE)
        #expect(Playback.Tuning.tSlope == t.T_SLOPE)
        #expect(Playback.Tuning.hopExponent == t.HOP_EXP)
        #expect(Playback.Tuning.velocityPixelsPerSecond == t.V_PX)
        #expect(Playback.Tuning.zoomMin == t.Z_MIN)
        #expect(Playback.Tuning.zoomMax == t.Z_MAX)
        #expect(Playback.Tuning.zoomTau == t.ZOOM_TAU)
        #expect(Playback.Tuning.centerTau == t.CENTER_TAU)
        #expect(Playback.Tuning.zoomCatchUpMin == t.Z_CATCHUP_MIN)
        #expect(Playback.Tuning.overviewMilliseconds == t.OVERVIEW_MS)
        #expect(Playback.Tuning.overviewMaxZoom == t.OVERVIEW_MAX_ZOOM)
        #expect(Playback.Tuning.introMilliseconds == t.INTRO_MS)
        #expect(Playback.Tuning.terminusHoldMilliseconds == t.TERMINUS_HOLD_MS)
        #expect(Playback.Tuning.finaleMilliseconds == t.FINALE_MS)
        #expect(Playback.Tuning.finaleHoldMilliseconds == t.FINALE_HOLD_MS)
        #expect(Playback.Tuning.finaleMaxZoom == t.FINALE_MAX_ZOOM)
        #expect(Playback.Tuning.maxFrameSeconds == t.MAX_FRAME_S)
        #expect(Playback.Tuning.stationPulseSeconds == t.STATION_PULSE_S)
        #expect(Playback.Tuning.speedMin == t.SPEED_MIN)
        #expect(Playback.Tuning.speedMax == t.SPEED_MAX)
        #expect(Playback.Tuning.speedStep == t.SPEED_STEP)
        #expect(Playback.metersPerPixelAtZoom0 == fixture.mppZoom0)
        #expect(Playback.degreesToRadians == fixture.degreesToRadians)
    }

    // MARK: - which library function each disagreement comes from

    /// V8 does not call libm.
    ///
    /// `Math.pow`, `Math.exp`, `Math.log2` and `Math.cos` are all answered
    /// from V8's own fdlibm port in `base/ieee754.cc`, so that a JavaScript
    /// program gives the same answer on every platform. Darwin's are
    /// different, also correct, implementations. PORTING.md's instruction is
    /// to measure before reaching for `JSMath` and to say what was measured;
    /// this is that measurement, on the inputs this module actually produces
    /// rather than on a sweep.
    ///
    /// What it found, and why the port is spelled the way it is:
    ///
    ///  * `cos` — the port uses ``JSMath/cos(_:)``. It is the only one of the
    ///    four that reaches a zoom, and a zoom is compared for bit equality.
    ///  * `pow`, `exp`, `log2` — Darwin agrees with V8 on every input this
    ///    module produces, so the port calls the platform. The simpler code is
    ///    the better code when it gives the same answer; if this case ever
    ///    starts failing, that is the signal to port the fdlibm version of
    ///    whichever one moved, and the failure message names it.
    @Test("V8's arithmetic against Darwin's, one function at a time")
    func libm() throws {
        let fixture = try Self.fixture()

        var powD = Divergence()
        for item in fixture.libm.pow {
            powD.record(pow(item.x, Playback.Tuning.hopExponent), item.y, "pow(\(item.x), 0.45)")
        }
        // Both spellings of exp, because the answer decided which one the
        // port uses: Darwin's disagrees, so `Playback.jsExp` carries fdlibm's
        // k == 0 branch instead.
        var expPlatform = Divergence()
        var expJS = Divergence()
        for item in fixture.libm.exp {
            expPlatform.record(exp(item.x), item.y, "exp(\(item.x))")
            expJS.record(Playback.jsExp(item.x), item.y, "Playback.jsExp(\(item.x))")
        }
        var log2D = Divergence()
        for item in fixture.libm.log2 {
            log2D.record(log2(item.x), item.y, "log2(\(item.x))")
        }
        // Both spellings of cos, because the answer decides which one the port
        // is allowed to use.
        var cosPlatform = Divergence()
        var cosJS = Divergence()
        for item in fixture.libm.cos {
            cosPlatform.record(Foundation.cos(item.x), item.y, "cos(\(item.x))")
            cosJS.record(JSMath.cos(item.x), item.y, "JSMath.cos(\(item.x))")
        }

        #expect(fixture.libm.pow.count > 100, "too few pow inputs to conclude anything")
        #expect(powD.worst == 0, "Math.pow moved — port V8's: \(powD.summary)")
        #expect(expJS.worst == 0, "Playback.jsExp is no longer V8's exp: \(expJS.summary)")
        #expect(
            expPlatform.worst >= expJS.worst,
            """
            Darwin's exp now agrees with V8 at least as closely as \
            Playback.jsExp does (\(expPlatform.summary)). That is a fact about \
            a toolchain rather than a reason to drop jsExp, but the note \
            claiming the platform disagrees is now stale.
            """
        )
        #expect(log2D.worst == 0, "Math.log2 moved — port V8's: \(log2D.summary)")
        #expect(cosJS.worst == 0, "JSMath.cos is no longer V8's cos: \(cosJS.summary)")
        #expect(
            cosPlatform.worst >= cosJS.worst,
            """
            Darwin's cos now agrees with V8 at least as closely as JSMath.cos \
            does (\(cosPlatform.summary)). That is a fact about a toolchain \
            rather than a reason to drop JSMath.cos, but any comment claiming \
            the platform disagrees is now stale.
            """
        )
    }

    // MARK: - what the numbers cost

    /// The measurement PORTING.md asks for, stated once rather than implied by
    /// every ceiling above.
    ///
    /// `Geometry.distanceMeters` is a haversine built out of `sin`, `cos` and
    /// `asin`. V8 answers all three from its own fdlibm port rather than from
    /// the platform, and Darwin's differ on a few per cent of real coordinates
    /// by 1–2 ULP. A single distance absorbs that; an arc coordinate is the
    /// running SUM of thousands of them, and every position on the timeline is
    /// interpolated out of that sum, so it does not.
    ///
    /// This case records where that lands, in ULP, on the longest journey in
    /// the store — so that a port change which makes it worse is visible as a
    /// number rather than as a passing test.
    @Test("arc distances are libm-bound, and this is how far")
    func arcDistancesAreLibmBound() throws {
        let fixture = try Self.fixture()
        var exactJourneys: [String] = []
        var inexactJourneys: [String] = []

        for item in fixture.cases {
            let train = try Self.train(item.trainId)
            let path = try #require(
                Playback.compile(
                    train: train, features: Self.features(item.features, fixture.geometries))
            )
            // A journey's ARC is exact when every cumulative distance in it is.
            var t = Trackers()
            try Self.expectPath(path, item.path, label: item.trainId, into: &t)
            _ = try Self.expectSamples(
                path, times: item.samples, distances: item.distanceSamples,
                label: item.trainId, into: &t)

            // The two headline numbers survive whatever the interior does:
            // totalMeters is the sum the duration curve reads, and the zoom is
            // the whole camera. Both are bit-exact on every journey.
            #expect(
                path.totalMeters.bitPattern == item.path.totalMeters.bitPattern,
                "\(item.trainId): totalMeters")
            #expect(
                path.zoom.bitPattern == item.path.zoom.bitPattern, "\(item.trainId): zoom")

            let worst = max(
                max(t.positions.worst, t.arcs.worst), max(t.times.worst, t.ratios.worst))
            if worst == 0 { exactJourneys.append(item.trainId) } else {
                inexactJourneys.append("\(item.trainId) (\(worst) ULP)")
            }
        }
        // Six of seven, bit-exact from end to end. Pinned as a number rather
        // than left as a claim in a comment: if a toolchain change, a data
        // change or a port change makes another journey inexact, this is where
        // it shows up, and the message names which one.
        #expect(
            exactJourneys.count >= fixture.cases.count - 1,
            """
            only \(exactJourneys.count) of \(fixture.cases.count) journeys are \
            bit-exact. Inexact: \(inexactJourneys.joined(separator: ", ")). \
            One is expected — see the note on the measured ceilings — and it is \
            Geometry.distanceMeters, not this file. More than one means \
            something else moved.
            """
        )
    }
}
