import Foundation

/// What the map actually draws: one line's station intervals turned into
/// disjoint display strokes.
///
/// Ported from `app/public/rail-network.js` (`displayPartsForLine`,
/// `continuousCoordinatesForLine` and the two dozen helpers they stand on).
/// This is the most consequential geometry function in the codebase, so the
/// JavaScript's reasoning is carried over rather than summarised — the
/// railways each rule exists for are named, because a rule whose reason has
/// been lost is a rule the next reader deletes.
///
/// The shape of the problem: a package line is an ORDERED STATION LIST, and
/// several real railways store a trunk AND its branch under one id (室蘭線
/// carries 東室蘭–室蘭; 東北線 carries the 利府 branch). Concatenating that
/// order blindly makes the drawn line RETRACE — 室蘭線 ran 138 km back down
/// its own main line to reach 御崎 — and because ridden routes are exact
/// slices of this same geometry, a train sliced across the retrace visibly
/// turns onto the wrong railway.
///
/// So the line is emitted as PARTS, cut wherever an interval doubles back over
/// track the line already drew, and a branch is always extended BACK to the
/// station it leaves from over the trunk's own coordinates — because a branch
/// only truly joins at a station, and the rail between platform and switch is
/// shared and must be drawn twice rather than welded into one connected line.
/// The map reads continuous; the topology stays separate, so nothing can slice
/// through a junction.
///
/// Grooming (``Grooming/smoothMicroKinks(_:limits:protectedKeys:)``) and
/// interval decoding (``CompactPackage/decodeIntervals(_:)``) are already
/// ported and are used here rather than restated.
///
/// ── two things a later reader will need to know ─────────────────────────
///
/// **The branch machinery looks dead and is not.** The shipped packages were
/// rebuilt to split interleaved branches out ahead of time — 室蘭線 ships as
/// 室蘭線 + 室蘭線-2, 阪和線 as 阪和線 + 阪和線-2, 成田線 as three lines — so
/// measured across all 804 lines of five countries, the excursion split, the
/// retrace onto a closed part, the pure-duplicate skip, the empty-groomed
/// fallback, the lost-anchor restore and ``extraSegmentParts(_:stationPoints:limits:)``
/// drawing anything are taken ZERO times. They are covered instead by eight
/// synthetic topologies in `port-fixtures/display-parts.json`, built to the
/// shapes the comments below argue from. Deleting an "unreachable" branch
/// here breaks the first package rebuilt without the pre-split.
///
/// **Parity is exact where it decides and measured where it does not.** All
/// 804 lines agree with the JavaScript on part count, on every part's vertex
/// count, and on all 431,379 copied vertices bit for bit. The remaining
/// 6,346 vertices are computed by the station-approach pass, and 131 of them
/// differ by at most 4 ULP because V8 ships its own `cos`; see ``jsHypot(_:_:)``
/// and `DisplayPartsParityTests` for the measurement and for why `hypot`,
/// unlike `cos`, had to be reproduced rather than tolerated.
public enum DisplayParts {

    // MARK: - branch topology thresholds
    //
    // Every one of these is a number the JavaScript tuned against the shipped
    // packages, using `Grooming`'s equirectangular metric (111 320 m/degree),
    // NOT the route solver's haversine. Re-tuning one against a different
    // metric is a behaviour change wearing a refactor's clothes.

    /// A vertex this close to track the same line already drew counts as
    /// running back over it rather than as new railway.
    static let retraceMatchMeters = 35.0
    /// Ignore the unavoidable few metres of coincidence at a shared station
    /// boundary; only a sustained run of re-used track is a retrace.
    static let retraceMinRunMeters = 600.0
    /// What is left of an interval after its retraced head is trimmed has to
    /// be real railway, not a stub of rounding noise.
    static let retraceMinTailMeters = 150.0
    /// A station anchor can sit this far off the surveyed centre-line
    /// (measured max ≈130 m on jp-2025), so this is how close a track vertex
    /// has to be to count as "the line passes this station".
    static let stationTouchMeters = 150.0
    /// Two intervals meeting at this shallow an angle are not a curve — the
    /// line is reversing onto other track (a branch), so the drawn line must
    /// break.
    static let reversalMaxDegrees = 25.0
    /// A corner no railway turns. The standing topology audit reports 110° or
    /// more carried by 60 m of track either side
    /// (`scripts/validation/validate-railway-topology.mjs`); nothing in here
    /// may WELD one, or the drawn network reports a defect the survey does
    /// not have.
    static let sharpTurnDegrees = 110.0
    /// Turns across a joint are read over a RUN of track rather than off the
    /// two adjoining edges, for the same reason the audit reads them that
    /// way: both sides are surveyed geometry, where consecutive vertices can
    /// be a metre apart and say nothing about which way the rail runs.
    static let turnRunMeters = 60.0
    /// How far off a terminal's own outbound heading a platform may sit and
    /// still count as lying BEYOND the end of the track rather than beside
    /// it. Under 45° the offset is mostly along the rail; over it, mostly
    /// across.
    static let anchorOffAxisDegrees = 45.0

    // MARK: - station approach (render anchoring) thresholds
    //
    // A drawn railway must run THROUGH the centre of every station circle it
    // calls at, and a terminal stroke must END on that centre — with no elbow
    // in the last few hundred metres and no hairpin.
    //
    // The package cannot deliver that on its own, and the reason looks like a
    // renderer bug and is not. A package station anchor is the OFFICIAL
    // station point — an N02 polygon centroid, an OSM station node — and the
    // package builders make every interval begin and end on it by OVERWRITING
    // the track vertex nearest the platform with it. Wherever that official
    // point sits off the surveyed centre-line (routinely tens of metres, a few
    // hundred at a large terminal) the overwrite IS the artefact: the
    // interval's last edge abandons the alignment and stabs sideways at the
    // anchor.
    //
    // Replacing one vertex can only ever produce that corner, so this pass
    // rebuilds the approach from the track the overwrite hid: lift the anchor
    // out, read the alignment straight through the platform (arriving tail +
    // departing head, which between them still hold every vertex the overwrite
    // did not touch), CUT it where it actually passes the platform, and slide
    // the two ends of the cut sideways onto the anchor across a fading window.
    //
    // Reading BOTH sides is the difference between a fix and a new defect:
    // from one side the deleted vertex can only be guessed by extrapolating a
    // heading, and on a curve that guess is metres out — which would invent a
    // correction at the ~95% of platforms that are already exactly on their
    // track. With a neighbour each side the nearest point is measured, so
    // those platforms measure zero and this pass leaves them untouched.

    /// At or under this the alignment already passes through the platform:
    /// seat the anchor at the cut and reshape nothing.
    static let anchorOnTrackMeters = 1.0
    /// Past this the platform is not off its track, the DATA is wrong — the
    /// wrong line matched, the wrong endpoint, a station belonging to a
    /// neighbouring group. Bending a railway that far would hide the fault
    /// under a graceful curve. The characterised packages peak at 159 m
    /// (東海道線/大阪), so nothing today reaches this; it exists so a future
    /// bad row cannot silently bend a trunk.
    static let anchorMaxDisplacementMeters = 250.0
    /// Metres of approach per metre of sideways correction.
    static let anchorWindowRatio = 12.0
    static let anchorMinWindowMeters = 180.0
    static let anchorMaxWindowMeters = 2400.0
    /// Neither the search for the platform nor one end's blend may spend more
    /// than this share of an interval, so nothing here can ever reach past a
    /// NEIGHBOURING station and rewrite its approach instead.
    static let anchorMaxIntervalShare = 0.45
    /// The blend has to be carried by a RUN of vertices. N02 can leave a
    /// single kilometre-long edge across the whole window, and a displacement
    /// applied to its two ends alone is the very corner this pass removes.
    static let anchorStepMeters = 20.0
    /// How far either side of the package's own cut the platform is looked
    /// for.
    static let anchorReachMeters = 700.0
    /// An edge this short is a seam, not a shape. The cut can land within a
    /// metre of a surveyed vertex, and keeping both leaves a stub edge whose
    /// direction is meaningless.
    static let anchorSeamMeters = 3.0
    /// Branch splitting can cut at a switch a few metres from an
    /// already-seated platform and leave the exact anchor behind on the
    /// discarded overlap. The approach is still the same surveyed stroke, so
    /// restore that vertex in the nearest edge after grooming. Deliberately
    /// tiny: a larger gap is a source-data fault and must stay visible to the
    /// anchoring audit.
    static let lostAnchorMaxMeters = 5.0

    // MARK: - stroke-end fold thresholds
    //
    // A stroke must never OPEN by running out and folding straight back over
    // itself. Two things produce that spur, and both are artefacts:
    //
    //   * the station-boundary vertex repeat, when the repeat falls on the
    //     first interval of a new part — `dropStationRepeat` only sees it
    //     mid-part, so a part opening at such a station starts with a 180°
    //     thorn (五能線 at 東八森, 常磐新線 at 青井, 50–90 m out and back);
    //   * a lead-in that walked back PAST its connection station before the
    //     branch turned round, leaving a spur beyond the platform that the
    //     line immediately retraces (阪和線 north of 鳳, ~180 m out and back).
    //
    // Both read the same way: a short excursion whose end is still at the
    // station but which cost several times its own chord to walk.

    static let foldMaxMeters = 1200.0
    static let foldReturnMeters = 160.0
    static let foldRatio = 2.5
    /// Never eat a real balloon loop or a line short enough that the
    /// "excursion" is most of it.
    static let foldMaxShare = 0.2

    // MARK: - line topology the compact decoder does not carry

    /// One extra edge a line runs that its station ORDER cannot carry.
    ///
    /// compact-v1 stores a line as distinct stations in order, and segment i
    /// runs station i to station i+1. A line whose two directions are not
    /// mirror images — Light Rail 505 takes different streets each way, 751
    /// serves 安定 one way only — has real edges that no such order puts next
    /// to each other. Dropping them silently is
    /// `network_union_missing_branch_edge`.
    ///
    /// An entry MAY carry its own geometry. One without is recorded, not
    /// drawn: where the archived alignment holds a single centre-line for both
    /// directions, cutting a stroke from it would lay a second line exactly
    /// over the first and assert shared track the survey says is not shared.
    /// All four rows in the shipped packages are of that kind, so
    /// ``extraSegmentParts(_:stationPoints:limits:)`` draws nothing today —
    /// which is precisely why the fixture carries a synthetic line that does.
    public struct ExtraSegment: Sendable, Decodable {
        public let from: Int
        public let to: Int
        public let geometry: [Coordinate]?

        enum CodingKeys: String, CodingKey { case from, to, geometry }

        public init(from: Int, to: Int, geometry: [Coordinate]?) {
            self.from = from
            self.to = to
            self.geometry = geometry
        }

        public init(from decoder: Decoder) throws {
            let row = try decoder.container(keyedBy: CodingKeys.self)
            from = try row.decode(Int.self, forKey: .from)
            to = try row.decode(Int.self, forKey: .to)
            geometry = (try row.decodeIfPresent([[Double]].self, forKey: .geometry))?
                .compactMap(Coordinate.init(pair:))
        }
    }

    /// The two per-line fields `CompactPackage.Line` does not decode.
    ///
    /// They are kept out here rather than added there because
    /// `CompactPackage.swift` is shared with other ports in flight and because
    /// both fields are rare: across five countries exactly one line carries
    /// `reversalTails` (阿里山線) and two carry `extraSegments` (輕鐵 505 and
    /// 751). Rare is not the same as ignorable — the one line that has
    /// reversal tails is the one whose grooming needs thirteen passes.
    public struct LineTopology: Sendable, Decodable {
        /// Ends of track the line deliberately runs into and reverses at (the
        /// 阿里山 zigzag). A reversal tail and a station-throat artefact are
        /// the same shape — out and straight back — so the fold guard cannot
        /// tell them apart by geometry and would eat the real one. Only the
        /// package knows which is which, so it says so.
        public let reversalTails: [Coordinate]
        public let extraSegments: [ExtraSegment]

        public init(reversalTails: [Coordinate] = [], extraSegments: [ExtraSegment] = []) {
            self.reversalTails = reversalTails
            self.extraSegments = extraSegments
        }

        enum CodingKeys: String, CodingKey { case id, reversalTails, extraSegments }

        public init(from decoder: Decoder) throws {
            let row = try decoder.container(keyedBy: CodingKeys.self)
            reversalTails =
                (try row.decodeIfPresent([[Double]].self, forKey: .reversalTails))?
                .compactMap(Coordinate.init(pair:)) ?? []
            extraSegments =
                try row.decodeIfPresent([ExtraSegment].self, forKey: .extraSegments) ?? []
        }

        public var isEmpty: Bool { reversalTails.isEmpty && extraSegments.isEmpty }

        private struct PackageShape: Decodable {
            struct Row: Decodable {
                enum RowKeys: String, CodingKey { case id }
                let id: String
                let topology: LineTopology
                init(from decoder: Decoder) throws {
                    let row = try decoder.container(keyedBy: RowKeys.self)
                    id = try row.decode(String.self, forKey: .id)
                    topology = try LineTopology(from: decoder)
                }
            }
            let lines: [Row]
        }

        /// Reads the two fields straight out of a shipped package, keyed by
        /// line id. Only non-empty entries are returned.
        public static func byLineID(contentsOf url: URL) throws -> [String: LineTopology] {
            let shape = try JSONDecoder().decode(PackageShape.self, from: Data(contentsOf: url))
            var out: [String: LineTopology] = [:]
            for row in shape.lines where !row.topology.isEmpty { out[row.id] = row.topology }
            return out
        }
    }

    // MARK: - the metric
    //
    // Same equirectangular projection as ``Grooming``, and it MUST stay the
    // same one: every threshold above was tuned against 111 320 m/degree with
    // the longitude axis shrunk by cos(latitude), not against the route
    // solver's haversine.
    //
    // What is restated here rather than reused is `Math.hypot`, and the reason
    // is measured, not stylistic. **V8's `Math.hypot` is not the platform's
    // `hypot`.** V8 scales by the largest magnitude and Kahan-sums the squares
    // (`src/builtins/math.tq`, MathHypot); Darwin's libm uses its own
    // correctly-rounded algorithm. Over 604 pairs drawn from this app's own
    // coordinate range the two disagree by one ULP on 235 of them — 39%.
    //
    // That is invisible almost everywhere, because almost every distance in
    // this file is compared against a threshold and one ULP never decides a
    // 35 m test. It is NOT invisible here, for two reasons:
    //
    //   * `warpTipToAnchor` INTERPOLATES on cumulative distance, so a
    //     last-bit difference lands directly in an output coordinate;
    //   * `nearestVertexIndex` breaks a tie by comparing two distances to each
    //     other, so a last-bit difference moves the branch cut by a whole
    //     vertex — measured on 野田線, 小田急箱根 鉄道線 and 土讃線, whose
    //     strokes split one vertex differently under libm's hypot.
    //
    // Measured with libm's hypot: 23 of 804 lines disagreed with the
    // JavaScript, three of them in their PART LENGTHS. With V8's: 787 lines
    // agree bit for bit, the other 17 agree in every part length and every
    // copied vertex and differ only in computed coordinates, by at most 4 ULP.
    //
    // That residue is `Math.cos`, which V8 also implements itself (its own
    // fdlibm port, same file) and which differs from Darwin's on 3.2% of the
    // 60,001 real latitudes in these packages. It is deliberately NOT chased:
    // reproducing it means shipping a hand-written transcendental in RailCore
    // that every later port then depends on, and the difference reaches
    // nothing that matters — it lands only in the 1.45% of vertices the
    // approach pass computes, at 3 × 10⁻⁹ m on the ground, and it moves no
    // decision. `DisplayPartsParityTests` states the measurement and holds the
    // port to it. `Math.hypot` is a different case precisely because it DID
    // move decisions, and because it is plain algebra rather than a
    // transcendental.
    //
    // `Grooming` still calls the platform's `hypot`, and its own parity holds
    // because `smoothMicroKinks` only ever SELECTS vertices — every one of its
    // distances is compared against a rung threshold and none is emitted — so
    // no output can carry the difference. Fixing it there is still worth
    // doing, and when it happens these four functions collapse back into
    // `Grooming`'s.

    /// JavaScript's `Math.hypot`, exactly.
    ///
    /// Scale by the largest magnitude so the squares cannot overflow, Kahan-sum
    /// them, unscale. Reproduces V8 bit for bit on all 604 measured pairs.
    /// Written as plain `+`/`-`/`*` because the compensation term is only
    /// meaningful if nothing contracts it into an FMA — Swift does not contract
    /// by default, and the 604/604 agreement is the check that it did not.
    static func jsHypot(_ a: Double, _ b: Double) -> Double {
        let values = (abs(a), abs(b))
        var maxValue = 0.0
        var sawNaN = false
        // NaN and Infinity are answered before the sum, as V8 answers them: a
        // single infinite argument wins even against a NaN.
        for value in [values.0, values.1] {
            if value.isNaN { sawNaN = true } else if value > maxValue { maxValue = value }
        }
        if maxValue == .infinity { return .infinity }
        if sawNaN { return .nan }
        if maxValue == 0 { return 0 }
        var sum = 0.0
        var compensation = 0.0
        for value in [values.0, values.1] {
            let n = value / maxValue
            let summand = n * n - compensation
            let preliminary = sum + summand
            compensation = (preliminary - sum) - summand
            sum = preliminary
        }
        return sum.squareRoot() * maxValue
    }

    /// ``Grooming/distanceMeters(_:_:)`` spelled with ``jsHypot(_:_:)``.
    static func distanceMeters(_ left: Coordinate, _ right: Coordinate) -> Double {
        let latitude = (left.lat + right.lat) / 2
        let a = Grooming.localMetric(left, latitude: latitude)
        let b = Grooming.localMetric(right, latitude: latitude)
        return jsHypot(a.x - b.x, a.y - b.y)
    }

    /// Deflection at `corner`, in degrees: 0 is straight on, 180 is straight
    /// back. All three points are projected at the CORNER's latitude, not at
    /// each own, so the angle is measured in one consistent plane.
    static func turnDegrees(
        _ previous: Coordinate, _ corner: Coordinate, _ following: Coordinate
    ) -> Double {
        let latitude = corner.lat
        let a = Grooming.localMetric(previous, latitude: latitude)
        let b = Grooming.localMetric(corner, latitude: latitude)
        let c = Grooming.localMetric(following, latitude: latitude)
        let incoming = (x: b.x - a.x, y: b.y - a.y)
        let outgoing = (x: c.x - b.x, y: c.y - b.y)
        let denominator = jsHypot(incoming.x, incoming.y) * jsHypot(outgoing.x, outgoing.y)
        // JavaScript's `if (!denominator)`, true for 0, -0 and NaN. A
        // zero-length edge is reachable — the vertex after a removed spike can
        // repeat the one before it — and answering 0 rather than dividing is
        // what keeps that vertex from reading as a corner.
        if denominator == 0 || denominator.isNaN { return 0 }
        let cosine = Swift.max(
            -1,
            Swift.min(1, (incoming.x * outgoing.x + incoming.y * outgoing.y) / denominator))
        return (acos(cosine) * 180) / .pi
    }

    /// How far `point` bulges from the chord `start`–`end`, in metres.
    static func pointSegmentDistanceMeters(
        _ point: Coordinate, _ start: Coordinate, _ end: Coordinate
    ) -> Double {
        // All three at the POINT's latitude here, where `turnDegrees` uses the
        // corner's — written as the JavaScript writes them.
        let latitude = point.lat
        let p = Grooming.localMetric(point, latitude: latitude)
        let a = Grooming.localMetric(start, latitude: latitude)
        let b = Grooming.localMetric(end, latitude: latitude)
        let dx = b.x - a.x
        let dy = b.y - a.y
        let lengthSquared = dx * dx + dy * dy
        let ratio =
            lengthSquared != 0
            ? Swift.max(
                0, Swift.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
            : 0
        return jsHypot(p.x - (a.x + ratio * dx), p.y - (a.y + ratio * dy))
    }

    // MARK: - the laid-track index (the retrace test)

    /// A coarse lon/lat bucket grid holding the edges a line has already
    /// drawn, so "is this vertex running back over track we just laid?" is a
    /// local lookup instead of a scan of the whole line.
    struct TrackIndex {
        /// ~400 m — comfortably above the 35 m test, so a match can never fall
        /// outside the 3×3 neighbourhood the lookup reads.
        static let cellDegrees = 0.004

        /// The JavaScript keys these cells with the string `"\(x)|\(y)"`. A
        /// pair of Ints is the same partition (the mapping is injective both
        /// ways, negative cells included) without paying for the string.
        private struct Cell: Hashable {
            let x: Int
            let y: Int
        }

        private var cells: [Cell: [(Coordinate, Coordinate)]] = [:]

        var isEmpty: Bool { cells.isEmpty }

        mutating func add(_ coordinates: [Coordinate]) {
            guard coordinates.count > 1 else { return }
            for index in 1..<coordinates.count {
                let a = coordinates[index - 1]
                let b = coordinates[index]
                let x0 = Int(floor(Swift.min(a.lon, b.lon) / Self.cellDegrees))
                let x1 = Int(floor(Swift.max(a.lon, b.lon) / Self.cellDegrees))
                let y0 = Int(floor(Swift.min(a.lat, b.lat) / Self.cellDegrees))
                let y1 = Int(floor(Swift.max(a.lat, b.lat) / Self.cellDegrees))
                for x in x0...x1 {
                    for y in y0...y1 { cells[Cell(x: x, y: y), default: []].append((a, b)) }
                }
            }
        }

        /// Distance from `point` to the nearest laid EDGE — `.infinity` when
        /// no edge is indexed nearby, which the caller reads as "not a
        /// retrace".
        func distanceTo(_ point: Coordinate) -> Double {
            let gx = Int(floor(point.lon / Self.cellDegrees))
            let gy = Int(floor(point.lat / Self.cellDegrees))
            var best = Double.infinity
            for dx in -1...1 {
                for dy in -1...1 {
                    guard let rows = cells[Cell(x: gx + dx, y: gy + dy)] else { continue }
                    for (a, b) in rows {
                        let distance = pointSegmentDistanceMeters(point, a, b)
                        if distance < best { best = distance }
                    }
                }
            }
            return best
        }
    }

    // MARK: - small shared helpers

    static func pathLength(_ coordinates: [Coordinate]) -> Double {
        guard coordinates.count > 1 else { return 0 }
        var total = 0.0
        for index in 1..<coordinates.count {
            total += distanceMeters(coordinates[index - 1], coordinates[index])
        }
        return total
    }

    /// The vertex `span` metres along `coordinates` from `from` in direction
    /// `step`, or the last one reached if the stroke ends first. `nil` when
    /// the first step already runs off the end.
    static func windowedPoint(
        _ coordinates: [Coordinate], from: Int, step: Int, span: Double
    ) -> Coordinate? {
        var travelled = 0.0
        var last: Coordinate?
        var index = from + step
        while index >= 0 && index < coordinates.count {
            travelled += distanceMeters(coordinates[index - step], coordinates[index])
            last = coordinates[index]
            if travelled >= span { break }
            index += step
        }
        return last
    }

    /// How much of this interval's head runs back over track already drawn.
    ///
    /// Returns the index of the first vertex that leaves it — the divergence
    /// point where the branch actually parts company with its trunk. Note the
    /// retrace must begin at the interval's very FIRST vertex: the scan stops
    /// at the first vertex more than 35 m off laid track, so an interval that
    /// wanders onto old track halfway along is not a retrace by this test.
    static func retracedHeadIndex(_ coordinates: [Coordinate], laid: TrackIndex) -> Int {
        if laid.isEmpty { return 0 }
        var run = 0.0
        var index = 1
        while index < coordinates.count {
            if laid.distanceTo(coordinates[index]) > retraceMatchMeters { break }
            run += distanceMeters(coordinates[index - 1], coordinates[index])
            index += 1
        }
        return run >= retraceMinRunMeters ? index - 1 : 0
    }

    /// Where `point` sits on an already-drawn stroke.
    ///
    /// This has to measure to the TRACK, not to its vertices. N02 digitises
    /// long easements with vertices hundreds of metres apart, so a switch
    /// lying exactly on the drawn centre-line can still be 90 m from the
    /// nearest vertex. Testing vertices made those junctions look like they
    /// belonged to some other stroke, and the trunk was cut in two at the
    /// junction (阪和線 split at 鳳, 東北線 at 日暮里) instead of carrying on.
    static func nearestVertexIndex(
        _ coordinates: [Coordinate], _ point: Coordinate
    ) -> (index: Int, distance: Double) {
        var bestIndex = -1
        var best = Double.infinity
        if coordinates.count > 1 {
            for index in 0..<(coordinates.count - 1) {
                let distance = pointSegmentDistanceMeters(
                    point, coordinates[index], coordinates[index + 1])
                if distance >= best { continue }
                best = distance
                // Cut at whichever end of the matched edge the point is
                // nearer, so the trunk keeps every vertex up to the switch and
                // the branch keeps the rest.
                bestIndex =
                    distanceMeters(point, coordinates[index])
                    <= distanceMeters(point, coordinates[index + 1])
                    ? index : index + 1
            }
        }
        if coordinates.count == 1 {
            best = distanceMeters(coordinates[0], point)
            bestIndex = 0
        }
        return (bestIndex, best)
    }

    static func stationAt(_ stationPoints: [Coordinate], _ point: Coordinate) -> Coordinate? {
        for station in stationPoints
        where distanceMeters(station, point) <= stationTouchMeters {
            return station
        }
        return nil
    }

    /// A branch only truly joins its trunk AT A STATION. The rail between the
    /// station and the physical switch is shared, so the branch must be DRAWN
    /// over it — but as its own coordinates, because the two are separate
    /// strokes and must not be mathematically one connected line.
    ///
    /// So walk BACK along the track the branch leaves, from the divergence
    /// point to the first station it passes: that slice, station-first, is the
    /// branch's lead-in. Walking back is what makes it the "previous" station
    /// in the branch's own direction of travel — never one reached by a
    /// hairpin.
    static func branchLeadIn(
        _ sourceCoordinates: [Coordinate], divergenceIndex: Int, stationPoints: [Coordinate]
    ) -> [Coordinate]? {
        // Both call sites pass an index inside the array; JavaScript would
        // throw on anything else, so nil here only stands in for "impossible".
        guard divergenceIndex >= 0, divergenceIndex < sourceCoordinates.count else { return nil }
        var index = divergenceIndex
        while index >= 0 {
            guard let station = stationAt(stationPoints, sourceCoordinates[index]) else {
                index -= 1
                continue
            }
            var leadIn = Array(sourceCoordinates[index...divergenceIndex])
            // Start exactly on the platform anchor, not on the nearby track
            // vertex.
            leadIn[0] = station
            return leadIn
        }
        return nil
    }

    // MARK: - station approach

    static func smoothstep(_ ratio: Double) -> Double {
        // Written as the JavaScript writes it rather than as a clamp, because
        // the two disagree on NaN: both comparisons fail and `t` stays NaN.
        let t = ratio <= 0 ? 0 : (ratio >= 1 ? 1 : ratio)
        return t * t * (3 - 2 * t)
    }

    /// The vertices within `reachMeters` of one end of an interval — the only
    /// part of it a station approach may read or rewrite.
    static func reachIndexFromEnd(
        _ coordinates: [Coordinate], atEnd: Bool, reachMeters: Double
    ) -> Int {
        var travelled = 0.0
        if atEnd {
            var index = coordinates.count - 1
            while index > 0 {
                travelled += distanceMeters(coordinates[index], coordinates[index - 1])
                if travelled >= reachMeters { return index - 1 }
                index -= 1
            }
            return 0
        }
        var index = 0
        while index < coordinates.count - 1 {
            travelled += distanceMeters(coordinates[index], coordinates[index + 1])
            if travelled >= reachMeters { return index + 1 }
            index += 1
        }
        return coordinates.count - 1
    }

    /// The point on `path` nearest the platform, as a cut: which edge it lands
    /// on and where along it.
    struct Cut {
        let index: Int
        let ratio: Double
        let point: Coordinate
        let distance: Double
    }

    static func nearestCutOnPath(_ path: [Coordinate], _ anchor: Coordinate) -> Cut? {
        guard path.count > 1 else { return nil }
        let latitude = anchor.lat
        let target = Grooming.localMetric(anchor, latitude: latitude)
        var best: Cut?
        for index in 0..<(path.count - 1) {
            let a = Grooming.localMetric(path[index], latitude: latitude)
            let b = Grooming.localMetric(path[index + 1], latitude: latitude)
            let dx = b.x - a.x
            let dy = b.y - a.y
            let lengthSquared = dx * dx + dy * dy
            let ratio =
                lengthSquared != 0
                ? Swift.max(
                    0,
                    Swift.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSquared))
                : 0
            // Interpolated in lon/lat, though the ratio was solved in the
            // projected plane — as the JavaScript does. And the reported
            // distance is the equirectangular one to that interpolated point,
            // not the projected perpendicular: the two differ in the last
            // bits, and every downstream threshold was tuned against this one.
            let point = Coordinate(
                lon: path[index].lon + (path[index + 1].lon - path[index].lon) * ratio,
                lat: path[index].lat + (path[index + 1].lat - path[index].lat) * ratio
            )
            let distance = distanceMeters(anchor, point)
            if best == nil || distance < best!.distance {
                best = Cut(index: index, ratio: ratio, point: point, distance: distance)
            }
        }
        return best
    }

    static func pathBeforeCut(_ path: [Coordinate], _ cut: Cut) -> [Coordinate] {
        var kept = Array(path[0...cut.index])
        if !Grooming.sameCoordinate(kept.last, cut.point) { kept.append(cut.point) }
        return kept
    }

    static func pathAfterCut(_ path: [Coordinate], _ cut: Cut) -> [Coordinate] {
        var kept = Array(path[(cut.index + 1)...])
        // `kept[0]` on an empty array is `undefined` in JavaScript, which
        // `sameCoordinate` answers false for — so the cut point is inserted
        // and the result is a one-vertex path. Reproduced by testing the
        // optional rather than by indexing.
        if !Grooming.sameCoordinate(kept.first, cut.point) { kept.insert(cut.point, at: 0) }
        return kept
    }

    /// Slide the last `windowMeters` of the alignment onto the anchor.
    ///
    /// The fade is a smoothstep, whose slope is ZERO at both ends, and that is
    /// what makes a real correction invisible: it begins without a corner
    /// where it meets untouched track and arrives at the anchor along the
    /// alignment's OWN heading, so a through station keeps its tangent and a
    /// terminal ends pointing the way it was going. The steepest point of the
    /// blend is 1.5·d/L, a few degrees for any displacement with room for its
    /// window.
    static func warpTipToAnchor(
        _ coordinates: [Coordinate], anchor: Coordinate, windowMeters: Double
    ) -> [Coordinate] {
        guard let tip = coordinates.last else { return coordinates }
        let shift = (lon: anchor.lon - tip.lon, lat: anchor.lat - tip.lat)
        var cumulative: [Double] = [0]
        if coordinates.count > 1 {
            for index in 1..<coordinates.count {
                cumulative.append(
                    cumulative[index - 1]
                        + distanceMeters(coordinates[index - 1], coordinates[index]))
            }
        }
        let total = cumulative[cumulative.count - 1]
        let window = Swift.min(windowMeters, total)
        if !(window > 0) {
            // Also the NaN path, as `!(x > 0)` is in the JavaScript.
            var pinned = Array(coordinates.dropLast())
            pinned.append(anchor)
            return pinned
        }
        let start = total - window

        var output: [Coordinate] = []
        func push(_ point: Coordinate) {
            if !Grooming.sameCoordinate(output.last, point) { output.append(point) }
        }

        var measures: [Double] = []
        for index in 0..<coordinates.count {
            if cumulative[index] < start {
                push(coordinates[index])
            } else {
                measures.append(cumulative[index])
            }
        }
        measures.append(start)
        // The blend has to be carried by a RUN of vertices: N02 can leave a
        // single kilometre-long edge across the whole window, and applying a
        // displacement to its two ends alone is the corner this pass removes.
        let steps = Swift.max(1, Int(ceil(window / anchorStepMeters)))
        if steps > 1 {
            for step in 1..<steps { measures.append(start + (window * Double(step)) / Double(steps)) }
        }
        measures.sort()
        for measure in measures {
            let point = interpolateAt(coordinates, cumulative: cumulative, target: measure)
            let weight = smoothstep((measure - start) / window)
            push(
                Coordinate(
                    lon: point.lon + shift.lon * weight, lat: point.lat + shift.lat * weight))
        }
        // Exactly, not nearly: the anchor has to be the very coordinate the
        // marker is drawn at, so the two can be compared by identity
        // downstream. Assigned over the last element rather than pushed —
        // in JavaScript an empty `output` would take the write on index -1 and
        // stay empty, which then falls through to the `>= 2` guard below.
        guard !output.isEmpty else { return coordinates }
        output[output.count - 1] = anchor
        return output.count >= 2 ? output : coordinates
    }

    static func interpolateAt(
        _ coordinates: [Coordinate], cumulative: [Double], target: Double
    ) -> Coordinate {
        if target <= 0 { return coordinates[0] }
        let last = cumulative.count - 1
        if target >= cumulative[last] { return coordinates[last] }
        var index = 1
        while index < last && cumulative[index] < target { index += 1 }
        let span = cumulative[index] - cumulative[index - 1]
        let ratio = span > 0 ? (target - cumulative[index - 1]) / span : 0
        let a = coordinates[index - 1]
        let b = coordinates[index]
        return Coordinate(lon: a.lon + (b.lon - a.lon) * ratio, lat: a.lat + (b.lat - a.lat) * ratio)
    }

    static func anchorWindowMeters(displacement: Double, budgetMeters: Double) -> Double {
        Swift.min(
            Swift.max(displacement * anchorWindowRatio, anchorMinWindowMeters),
            anchorMaxWindowMeters,
            Swift.max(budgetMeters, anchorStepMeters)
        )
    }

    /// Bring the approach on one side of a platform onto the anchor.
    /// `approach` runs towards the station and ends on the cut; the returned
    /// run ends on the anchor itself.
    static func anchorApproach(
        _ approach: [Coordinate], anchor: Coordinate, displacement: Double, budgetMeters: Double
    ) -> [Coordinate]? {
        guard approach.count >= 2 else { return nil }
        var built: [Coordinate] =
            displacement <= anchorOnTrackMeters
            // The alignment already passes through the platform: seat the
            // anchor at the cut and reshape nothing.
            ? Array(approach.dropLast())
            : Array(
                warpTipToAnchor(
                    approach, anchor: anchor,
                    windowMeters: anchorWindowMeters(
                        displacement: displacement, budgetMeters: budgetMeters)
                ).dropLast())
        while built.count > 1
            && distanceMeters(built[built.count - 1], anchor) <= anchorSeamMeters
        {
            built.removeLast()
        }
        built.append(anchor)
        return built.count >= 2 ? built : nil
    }

    /// Do the two intervals meeting at this platform SHARE their track out of
    /// it?
    ///
    /// A branch only joins its trunk AT A STATION, so the rail between
    /// platform and switch is run over twice — once arriving, once leaving.
    /// Joined head-to-tail the pair then FOLDS back on itself instead of
    /// running through, and the nearest point on a fold is its own apex: the
    /// last surveyed vertex before the about-face. That distance is the
    /// LONGITUDINAL gap up to the platform, and reading it as a sideways
    /// displacement is how 成田 came to be drawn 93 m off its own survey — the
    /// 我孫子支線 leaves over the 600 m of rail the 佐原 main line arrives on,
    /// so the fold apex measured 205 m, and 205 m blended across the full
    /// 2.4 km window swung the main line clear of the basemap track that the
    /// 空港支線, drawn from the very same coordinates, still sat on.
    static func foldedAtPlatform(_ head: [Coordinate], _ tail: [Coordinate], _ cut: Cut) -> Bool {
        if head.count < 2 || tail.isEmpty { return false }
        let seam = head[head.count - 1]
        // Anywhere but the apex and the pair is not folding here: the platform
        // sat on track one side or the other genuinely runs through.
        if distanceMeters(cut.point, seam) > anchorSeamMeters { return false }
        let before = windowedPoint(head, from: head.count - 1, step: -1, span: turnRunMeters)
        let after =
            tail.count >= 2
            ? windowedPoint(tail, from: 0, step: +1, span: turnRunMeters)
            : tail[0]
        guard let before, let after else { return false }
        return turnDegrees(before, seam, after) >= 180 - reversalMaxDegrees
    }

    /// Does this platform lie PAST the end of the track its line surveyed?
    ///
    /// Asking it structurally — is the nearest point on the path its own last
    /// vertex — is exact when the platform sits straight off the end and blind
    /// the moment anything at all lies in between. At 亀山 the 紀勢線 approach
    /// carries 5–7 m of surveyed jitter before its final vertex, so the
    /// nearest point landed mid-edge and the platform 171 m beyond the end
    /// read as a sideways displacement: the line was rebuilt through 800 m of
    /// approach and drawn up to 78 m off its own survey.
    ///
    /// So ask the rail instead. From the last surveyed vertex, along the
    /// heading its final run of track is on, is the platform AHEAD? Within 45°
    /// the gap is LONGITUDINAL — there is no rail between the two to be off —
    /// and the package's own final edge is the only evidence of where the
    /// track goes. Past 45° the platform is BESIDE the line rather than beyond
    /// it, which is a displacement and is rebuilt as one (東武日光's dot on
    /// JR日光駅's platform read 93°).
    static func beyondSurveyedEnd(
        _ coordinates: [Coordinate], anchor: Coordinate, atStart: Bool
    ) -> Bool {
        let endIndex = atStart ? 0 : coordinates.count - 1
        let end = coordinates[endIndex]
        guard
            let back = windowedPoint(
                coordinates, from: endIndex, step: atStart ? +1 : -1, span: turnRunMeters)
        else { return false }
        return turnDegrees(back, end, anchor) < anchorOffAxisDegrees
    }

    struct RebuiltApproach {
        var incoming: [Coordinate]?
        var outgoing: [Coordinate]?
    }

    struct ApproachBudgets {
        let incomingReach: Double
        let outgoingReach: Double
        let incomingWindow: Double
        let outgoingWindow: Double
    }

    /// Rebuild the drawn approach on both sides of ONE platform.
    ///
    /// `incoming` arrives at the station and `outgoing` leaves it; either is
    /// nil at the two ends of an open line, where the platform is a terminal
    /// and the stroke simply stops on it.
    static func anchorStationApproach(
        incoming: [Coordinate]?, outgoing: [Coordinate]?, anchor: Coordinate,
        budgets: ApproachBudgets
    ) -> RebuiltApproach? {
        let head: [Coordinate] = incoming.map { Array($0.dropLast()) } ?? []
        // Where the departing interval's own vertices begin. The package
        // re-emits the vertex next to a platform on BOTH sides of it; read
        // once, or the alignment appears to double back across the station.
        var tailStart = outgoing != nil ? 1 : 0
        if let outgoing, !head.isEmpty, outgoing.count > 1,
            Grooming.sameCoordinate(head[head.count - 1], outgoing[1])
        {
            tailStart = 2
        }
        let tail: [Coordinate] =
            outgoing.map { $0.count > tailStart ? Array($0[tailStart...]) : [] } ?? []
        let headFrom =
            head.isEmpty ? 0 : reachIndexFromEnd(head, atEnd: true, reachMeters: budgets.incomingReach)
        let tailTo =
            tail.isEmpty
            ? -1 : reachIndexFromEnd(tail, atEnd: false, reachMeters: budgets.outgoingReach)
        let headSlice = Array(head[headFrom...])
        let tailSlice = tailTo >= 0 ? Array(tail[0...tailTo]) : []
        let path = headSlice + tailSlice
        if path.count < 2 { return nil }

        guard let cut = nearestCutOnPath(path, anchor) else { return nil }
        if foldedAtPlatform(headSlice, tailSlice, cut) { return nil }
        // A cut AT the far end of what we can read means the platform lies
        // beyond the last surveyed vertex the line has — which only a terminal
        // can do, and which leaves nothing to measure it against. The
        // package's own final edge is then the only evidence of where the
        // track runs, and it is better evidence than an extrapolated heading:
        // the two are the same on straight track, and where they differ it is
        // because the alignment is on a curve, which is exactly where
        // extrapolating is wrong. So the approach is left as drawn, and only a
        // platform the track OVERSHOOTS — the drive past the buffer and back
        // that ends 90 Japanese strokes — is rebuilt.
        if outgoing == nil
            && ((cut.index == path.count - 2 && cut.ratio >= 1)
                || beyondSurveyedEnd(path, anchor: anchor, atStart: false))
        {
            return nil
        }
        if incoming == nil
            && ((cut.index == 0 && cut.ratio <= 0)
                || beyondSurveyedEnd(path, anchor: anchor, atStart: true))
        {
            return nil
        }
        if cut.distance > anchorMaxDisplacementMeters { return nil }

        var result = RebuiltApproach()
        if let incoming {
            guard
                let approach = anchorApproach(
                    pathBeforeCut(path, cut), anchor: anchor, displacement: cut.distance,
                    budgetMeters: budgets.incomingWindow)
            else { return nil }
            result.incoming = Array(incoming[0..<headFrom]) + approach
        }
        if let outgoing {
            guard
                let departure = anchorApproach(
                    Array(pathAfterCut(path, cut).reversed()), anchor: anchor,
                    displacement: cut.distance, budgetMeters: budgets.outgoingWindow)
            else { return nil }
            let rest = tailStart + tailTo + 1
            result.outgoing =
                Array(departure.reversed())
                + (rest < outgoing.count ? Array(outgoing[rest...]) : [])
        }
        return result
    }

    /// Every interval runs platform to platform, so every station is an
    /// approach from one or both sides. Reach and window are capped at a share
    /// of each interval, so one station's rebuild can never run into its
    /// neighbour's.
    static func anchorIntervalsToStations(
        _ intervals: inout [[Coordinate]], stations: [CompactPackage.Station]
    ) {
        let stationCount = stations.count
        if intervals.isEmpty { return }
        // Measured ONCE, before anything is rebuilt: the shares are a budget
        // against the package's own geometry, not against whatever the
        // previous station's rebuild left behind.
        let shares = intervals.map { pathLength($0) * anchorMaxIntervalShare }
        // A closed line has one interval per station, so its first platform is
        // approached from the last interval rather than from nothing.
        let closed = intervals.count >= stationCount
        for station in 0..<stationCount {
            let incomingIndex = station > 0 ? station - 1 : (closed ? intervals.count - 1 : -1)
            let outgoingIndex = station < intervals.count ? station : -1
            let incoming = incomingIndex >= 0 ? intervals[incomingIndex] : nil
            let outgoing = outgoingIndex >= 0 ? intervals[outgoingIndex] : nil
            if incoming == nil && outgoing == nil { continue }
            if let incoming, incoming.count < 2 { continue }
            if let outgoing, outgoing.count < 2 { continue }
            let anchor = stations[station].coordinate
            let budgets = ApproachBudgets(
                incomingReach: Swift.min(
                    anchorReachMeters, incomingIndex >= 0 ? shares[incomingIndex] : 0),
                outgoingReach: Swift.min(
                    anchorReachMeters, outgoingIndex >= 0 ? shares[outgoingIndex] : 0),
                incomingWindow: incomingIndex >= 0 ? shares[incomingIndex] : 0,
                outgoingWindow: outgoingIndex >= 0 ? shares[outgoingIndex] : 0
            )
            guard
                let rebuilt = anchorStationApproach(
                    incoming: incoming, outgoing: outgoing, anchor: anchor, budgets: budgets)
            else { continue }
            if let built = rebuilt.incoming, built.count >= 2 { intervals[incomingIndex] = built }
            if let built = rebuilt.outgoing, built.count >= 2 { intervals[outgoingIndex] = built }
        }
    }

    // MARK: - anchors, seams and folds

    /// Vertices the grooming may not trim past or smooth away: every platform
    /// anchor, plus any end of track the line deliberately runs into and
    /// reverses at.
    static func stationAnchorKeys(
        _ line: CompactPackage.Line, topology: LineTopology
    ) -> Set<String> {
        var keys = Set<String>()
        for station in line.stations { keys.insert(Grooming.coordinateKey(station.coordinate)) }
        for point in topology.reversalTails { keys.insert(Grooming.coordinateKey(point)) }
        return keys
    }

    /// Any vertex appearing in more than one stroke of the same line.
    ///
    /// Not a nicety: a branch's lead-in is a literal copy of the trunk's
    /// vertices, so if the groomer drops a kink from one copy and keeps it in
    /// the other, the two strokes stop being coincident and the shared metres
    /// render as a pair of lines a few metres apart. Whatever survives has to
    /// survive in both.
    static func sharedVertexKeys(_ parts: [[Coordinate]]) -> Set<String> {
        var seen: [String: Int] = [:]
        for coordinates in parts {
            var own = Set<String>()
            for coordinate in coordinates { own.insert(Grooming.coordinateKey(coordinate)) }
            for key in own { seen[key, default: 0] += 1 }
        }
        var shared = Set<String>()
        for (key, count) in seen where count > 1 { shared.insert(key) }
        return shared
    }

    static func restoreLostStationAnchors(
        _ parts: inout [[Coordinate]], stationPoints: [Coordinate]
    ) {
        var present = Set<String>()
        for coordinates in parts {
            for point in coordinates { present.insert(Grooming.coordinateKey(point)) }
        }
        for anchor in stationPoints {
            let key = Grooming.coordinateKey(anchor)
            if present.contains(key) { continue }
            var best: (partIndex: Int, cut: Cut)?
            for partIndex in parts.indices {
                guard let cut = nearestCutOnPath(parts[partIndex], anchor) else { continue }
                // Strictly less-than, so the FIRST part wins a tie — the
                // JavaScript's `>=` continue, kept because which stroke gains
                // the vertex is observable.
                if let best, cut.distance >= best.cut.distance { continue }
                best = (partIndex, cut)
            }
            guard let best, best.cut.distance <= lostAnchorMaxMeters else { continue }
            parts[best.partIndex].insert(anchor, at: best.cut.index + 1)
            present.insert(key)
        }
    }

    /// Station-boundary vertex repeat.
    ///
    /// Where a station sits partway along a surveyed edge, the package ends
    /// the arriving interval at the station anchor and starts the next one by
    /// re-emitting the SAME neighbouring track vertex. Concatenated that reads
    /// X, A, S, A, Y — the line runs to the platform, back out to A, then on.
    /// It is only tens of metres, but it is a true 180° reversal, so it
    /// renders as a thorn at (nearly) every station, it makes a ridden-route
    /// slice measure the station twice, and it looks like a branch to any
    /// topology test.
    ///
    /// Only one of the two A's belongs. Keep whichever ordering is shorter —
    /// that is by definition the one that does not double back. Detected
    /// structurally (the identical vertex either side of the station), never
    /// by distance, so a genuine stub track is left alone.
    static func dropStationRepeat(_ current: inout [Coordinate], _ next: inout [Coordinate]) {
        if current.count < 3 || next.count < 3 { return }
        let before = current[current.count - 3]
        let repeated = current[current.count - 2]
        let station = current[current.count - 1]
        let after = next[2]
        if !Grooming.sameCoordinate(repeated, next[1]) { return }
        let keepFirst =
            distanceMeters(before, repeated) + distanceMeters(repeated, station)
            + distanceMeters(station, after)
        let keepSecond =
            distanceMeters(before, station) + distanceMeters(station, repeated)
            + distanceMeters(repeated, after)
        if keepFirst <= keepSecond {
            next.remove(at: 1)
        } else {
            current.remove(at: current.count - 2)
        }
    }

    static func foldedHeadIndex(
        _ coordinates: [Coordinate], totalMeters: Double, anchorKeys: Set<String>?
    ) -> Int {
        let budget = Swift.min(foldMaxMeters, totalMeters * foldMaxShare)
        var travelled = 0.0
        var folded = 0
        var index = 1
        while index < coordinates.count {
            // A platform anchor ends the search: whatever lies beyond it is
            // another station's track and may not be trimmed away with the
            // spur.
            if anchorKeys?.contains(Grooming.coordinateKey(coordinates[index])) ?? false { break }
            travelled += distanceMeters(coordinates[index - 1], coordinates[index])
            if travelled > budget { break }
            let chord = distanceMeters(coordinates[0], coordinates[index])
            if chord <= foldReturnMeters && travelled >= foldRatio * Swift.max(chord, 1) {
                folded = index
            }
            index += 1
        }
        return folded
    }

    /// Re-open a stroke at the far end of a folded excursion at either end.
    /// The anchor vertex itself is kept, so a part still begins exactly on its
    /// platform.
    static func trimFoldedEnds(_ coordinates: [Coordinate], anchorKeys: Set<String>?)
        -> [Coordinate]
    {
        // Measured once from the ORIGINAL stroke and reused for both ends, as
        // the JavaScript does: the tail's budget is not recomputed from what
        // the head trim left.
        let total = pathLength(coordinates)
        var output = coordinates
        let head = foldedHeadIndex(output, totalMeters: total, anchorKeys: anchorKeys)
        if head > 0 { output = [output[0]] + Array(output[head...]) }
        let reversed = Array(output.reversed())
        let tail = foldedHeadIndex(reversed, totalMeters: total, anchorKeys: anchorKeys)
        if tail > 0 {
            // `reversed[0]` is the stroke's own last vertex, appended back on
            // so the tail trim keeps its endpoint exactly as the head trim
            // keeps `output[0]`.
            output = Array(reversed[tail...].reversed()) + [reversed[0]]
        }
        return output.count >= 2 ? output : coordinates
    }

    static func isReversalJoint(_ current: [Coordinate], _ next: [Coordinate]) -> Bool {
        guard let joint = current.last, let first = next.first else { return false }
        if !Grooming.sameCoordinate(joint, first) { return false }
        guard current.count >= 2, next.count >= 2 else { return false }
        let before = current[current.count - 2]
        let after = next[1]
        // turnDegrees reports the deflection from straight-on; 180° is a full
        // about-face, so a reversal is a LARGE deflection.
        return turnDegrees(before, joint, after) >= 180 - reversalMaxDegrees
    }

    /// The corner the trunk would have to turn at `index` to pick `tail` up.
    static func spliceTurnDegrees(_ current: [Coordinate], index: Int, tail: [Coordinate]) -> Double
    {
        guard index >= 0, index < current.count else { return 0 }
        let before = windowedPoint(current, from: index, step: -1, span: turnRunMeters)
        let after = windowedPoint(tail, from: 0, step: +1, span: turnRunMeters)
        guard let before, let after else { return 0 }
        return turnDegrees(before, current[index], after)
    }

    /// Track a line runs on that its station ORDER cannot carry — see
    /// ``ExtraSegment``. Each is its own part, so it joins the chain visually
    /// at the station anchors it names while nothing can slice or smooth
    /// through the junction: the same contract every branch stroke has.
    static func extraSegmentParts(
        _ topology: LineTopology, stationPoints: [Coordinate], limits: Grooming.Limits
    ) -> [[Coordinate]] {
        if topology.extraSegments.isEmpty { return [] }
        var parts: [[Coordinate]] = []
        for row in topology.extraSegments {
            guard let geometry = row.geometry, geometry.count >= 2 else { continue }
            guard row.from >= 0, row.from < stationPoints.count,
                row.to >= 0, row.to < stationPoints.count
            else { continue }
            let from = stationPoints[row.from]
            let to = stationPoints[row.to]
            var coordinates = geometry
            // Both ends onto the authoritative station anchors, exactly as
            // decodeIntervals does for the chain, so the two meet to the
            // vertex.
            coordinates[0] = from
            coordinates[coordinates.count - 1] = to
            let anchors: Set<String> = [
                Grooming.coordinateKey(from), Grooming.coordinateKey(to),
            ]
            let groomed = Grooming.smoothMicroKinks(
                coordinates, limits: limits, protectedKeys: anchors)
            if groomed.count >= 2 { parts.append(groomed) }
        }
        return parts
    }

    // MARK: - the function

    /// The disjoint display strokes for one package line.
    ///
    /// Two shapes of doubling-back are handled apart:
    ///
    ///   * the retrace comes straight back down the interval we are BUILDING —
    ///     the station order took an excursion out to a branch tip and
    ///     returned. Cut the current part at the divergence point: the
    ///     excursion becomes a branch and the trunk carries on along whatever
    ///     this interval adds. (室蘭線: 本輪西 → 輪西 → 東室蘭 becomes trunk
    ///     本輪西 → 東室蘭 plus branch 東室蘭 → 輪西; 函館線 restores its
    ///     東森 → 森 main line.)
    ///
    ///   * the retrace lands on a part we already CLOSED — the order jumped
    ///     back across the line. Start a new part where the new track begins.
    ///     (室蘭線's 岩見沢 → 御崎, 138 km back down its own main line.)
    ///
    /// Either way the branch is extended BACK to the station it leaves from,
    /// over the trunk's own coordinates.
    public static func parts(
        for line: CompactPackage.Line, topology: LineTopology = LineTopology()
    ) -> [[Coordinate]] {
        let stationPoints = line.stations.map(\.coordinate)
        // A line with no stations returns `[[undefined, undefined]]` in
        // JavaScript — the fallback below indexes an empty array — which is
        // not a value Swift can produce and not a value anything downstream
        // could draw. No line in the five shipped packages is stationless, so
        // this returns nothing rather than inventing a shape to disagree over.
        guard !stationPoints.isEmpty else { return [] }

        let limits = Grooming.microKinkLimits(for: line)
        let anchorKeys = stationAnchorKeys(line, topology: topology)
        var laid = TrackIndex()
        var parts: [[Coordinate]] = []
        var current: [Coordinate] = []

        func flush() {
            if current.count >= 2 { parts.append(current) }
            current = []
        }

        // Station approaches are rebuilt on the interval chain, BEFORE any of
        // the branch machinery below runs, so a branch lead-in copied off a
        // trunk copies the finished geometry and the two strokes stay
        // coincident to the vertex over the metres they share.
        var intervals = CompactPackage.decodeIntervals(line)
        anchorIntervalsToStations(&intervals, stations: line.stations)

        for var decoded in intervals {
            // `dropStationRepeat` mutates BOTH sides, and the mutated interval
            // is what goes into `laid` and (absent a retrace) into the stroke.
            if !current.isEmpty { dropStationRepeat(&current, &decoded) }

            var coordinates = decoded
            let head = retracedHeadIndex(decoded, laid: laid)
            if head > 0 {
                let tail = Array(decoded[head...])
                if pathLength(tail) < retraceMinTailMeters {
                    // Nothing new at all — the interval is pure duplicate
                    // track. Skip it entirely; the next interval opens a fresh
                    // part at its own station.
                    flush()
                    laid.add(decoded)
                    continue
                }
                let divergence = decoded[head]
                let inCurrent =
                    !current.isEmpty
                    ? nearestVertexIndex(current, divergence)
                    : (index: -1, distance: Double.infinity)
                if inCurrent.distance <= retraceMatchMeters
                    && spliceTurnDegrees(current, index: inCurrent.index, tail: tail)
                        >= sharpTurnDegrees
                {
                    // The tail leaves the divergence back along the way the
                    // trunk came in, so there is no trunk to carry on with:
                    // the station this interval STARTS at is a reversal, and
                    // the two legs merely share the rail between its platform
                    // and the switch. Splitting here would weld a hairpin into
                    // open track short of the platform — 成田 at the 我孫子支線
                    // switch, 会津若松 a kilometre out — and leave the station
                    // on the branch stroke alone. Close the stroke instead,
                    // the same shape `isReversalJoint` draws where the two
                    // legs share no track at all, and let this interval open
                    // its own part at the station, head included, so both legs
                    // reach the platform.
                    flush()
                } else if inCurrent.distance <= retraceMatchMeters {
                    // The excursion we just drew hangs off THIS part at
                    // `divergence`. Split there: the far side is the branch,
                    // the trunk resumes along the fresh tail, and the branch
                    // is re-served from the station this interval's tail runs
                    // to (its own lead-in, reversed).
                    let excursion = Array(current[inCurrent.index...])
                    current = Array(current[0...inCurrent.index])
                    let leadIn = branchLeadIn(
                        Array(tail.reversed()), divergenceIndex: tail.count - 1,
                        stationPoints: stationPoints)
                    if excursion.count >= 2 {
                        let branch = leadIn.map { $0 + excursion.dropFirst() } ?? excursion
                        if branch.count >= 2 { parts.append(branch) }
                    }
                    // The cut vertex and the tail's first vertex are the same
                    // switch to within the match radius; make them literally
                    // equal so the trunk welds instead of jogging.
                    //
                    // Unless the cut vertex is a PLATFORM ANCHOR, which
                    // happens whenever the branch leaves from a station rather
                    // than from open track — the whole open part being the
                    // anchor alone is only its commonest shape (阪和線 opens a
                    // part at 鳳 to reach 東羽衣). Overwriting an anchor would
                    // cut the trunk loose ~40 m short of the station AND take
                    // the station off the line it calls at. Append instead, so
                    // the continuation still reads station → switch → onward.
                    if current.count >= 2
                        && !anchorKeys.contains(Grooming.coordinateKey(current[current.count - 1]))
                    {
                        current[current.count - 1] = tail[0]
                    } else if !Grooming.sameCoordinate(current.last, tail[0]) {
                        current.append(tail[0])
                    }
                    coordinates = tail
                } else {
                    // The retrace lands on track from an already-closed part.
                    // Open a new one at the divergence point — and lead it in
                    // along the retraced head itself, which IS the trunk this
                    // branch leaves and is guaranteed to reach a station (it
                    // starts at one).
                    flush()
                    let leadIn = branchLeadIn(
                        decoded, divergenceIndex: head, stationPoints: stationPoints)
                    coordinates = leadIn.map { $0 + tail.dropFirst() } ?? tail
                }
            } else if !current.isEmpty && isReversalJoint(current, coordinates) {
                // No shared track, but the line turns back on itself at the
                // joint: still a branch, and still must not be drawn as one
                // stroke.
                flush()
            }

            if current.isEmpty {
                current = coordinates
            } else if Grooming.sameCoordinate(current.last, coordinates.first) {
                current.append(contentsOf: coordinates.dropFirst())
            } else {
                current.append(contentsOf: coordinates)
            }
            laid.add(decoded)
        }
        flush()

        // Trim on both sides of grooming. Before, because a fold hides real
        // corners from the groomer; after, because dropping a barb can expose
        // a smaller fold that was not one while the extra vertices were there.
        //
        // Neither pass may touch a platform anchor. Grooming a station out of
        // the line, or trimming a stroke back past one, puts the marker off
        // the rail it calls at — the very defect the approach pass exists to
        // remove, reintroduced two steps later.
        let trimmed = parts.map { trimFoldedEnds($0, anchorKeys: anchorKeys) }
        var protectedKeys = sharedVertexKeys(trimmed)
        for key in anchorKeys { protectedKeys.insert(key) }
        var groomed =
            trimmed
            .map {
                trimFoldedEnds(
                    Grooming.smoothMicroKinks($0, limits: limits, protectedKeys: protectedKeys),
                    anchorKeys: anchorKeys)
            }
            .filter { $0.count >= 2 }

        var chain: [[Coordinate]]
        if groomed.isEmpty {
            // Everything collapsed. Emit the first platform twice so the line
            // still has a drawable, sliceable identity at its own station.
            chain = [[stationPoints[0], stationPoints[0]]]
        } else {
            restoreLostStationAnchors(&groomed, stationPoints: stationPoints)
            chain = groomed
        }
        return chain + extraSegmentParts(topology, stationPoints: stationPoints, limits: limits)
    }

    /// The historic single-stroke geometry, retained for callers that want it.
    ///
    /// One part is returned as itself; several are concatenated — which
    /// deliberately welds the junctions the parts exist to keep apart, so this
    /// is for callers that only need a bag of vertices, never for drawing.
    public static func continuousCoordinates(
        for line: CompactPackage.Line, topology: LineTopology = LineTopology()
    ) -> [Coordinate] {
        let parts = parts(for: line, topology: topology)
        return parts.count == 1 ? parts[0] : parts.flatMap { $0 }
    }
}
