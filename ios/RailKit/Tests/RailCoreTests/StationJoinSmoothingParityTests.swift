import Foundation
import Testing

@testable import RailCore

/// `RailCore.StationJoinSmoothing` against `port-fixtures/station-join-smoothing.json`.
///
/// The expected answers come from running the real frontend: the whole
/// classic-script family in a Node `vm`, the committed train stores solved
/// through the app's own precompute adapter, and `buildDeckRouteRecords` run
/// for real with `smoothCurveStationJoins` wrapped so that the `groupInfo` it
/// is handed and the assignment it makes are both recorded. The synthetic
/// mirrors are the same function called on the structure the fit worker builds,
/// over display parts of the shipped packages.
///
/// ## What is held to what standard
///
/// **Exact, always.** Everything structural: which groups end up sharing which
/// curve, how many station-continuous curves came out, how long each is,
/// whether a chain was accepted or rejected and why, how many joins it
/// absorbed, and every diagnostic stamped on an accepted curve. A curve is
/// what the hover fan takes its local perpendicular from — the wrong curve is
/// a fan pointing the wrong way — so none of this may be approximate.
///
/// **Bit-exact, and this is the interesting part.** The refit's own
/// coordinates. Unlike the corridor fit it follows, this pass is pure
/// arithmetic over its input: a latitude cosine (V8's, via ``JSMath``), three
/// box filters implemented as prefix sums, and a division back into degrees.
/// No `exp`, no `atan2`, no `sqrt`. So `pts` is expected to match bit for bit
/// and does; the ceiling below is for the fields DERIVED from `pts`, which run
/// through haversine (`Geometry.distanceMeters`, 2 ULP against V8 by
/// construction), `atan2` and `sin`.
///
/// **A measured ULP ceiling, for those derived fields only.** Stated at the
/// `#expect` that uses one, never a relative epsilon.
struct StationJoinSmoothingParityTests {

    // MARK: - the fixture

    struct Fixture: Decodable {
        let cases: [Case]
        let toFixed: [ToFixed]

        struct ToFixed: Decodable {
            let value: Double
            let digits: Int
            let text: String
            let number: Double
        }
        struct CurveIn: Decodable {
            let pts: [Double]
            let cum: [Double]
            let dirs: [Double]
            let totalMeters: Double
            let sourceTotalMeters: Double
            let endpointChordMeters: Double
            let radiusMeters: Double
            let smoothingSigmaMeters: Double
            let directionSigmaMeters: Double
            let requestedMinRadiusMeters: Double
            let achievedMinRadiusMeters: Double?
            let achievedDirectionRadiusMeters: Double?
            let minDetailMeters: Double
            let maxDeviationMeters: Double
            let actualMaxDeviationMeters: Double
            let samplingPrecision: Double
            let fitType: String
            let coslat: Double
            let sourceLines: [[Double]]
        }
        struct CurveOut: Decodable {
            let pts: [Double]
            let cum: [Double]
            let dirs: [Double]
            let totalMeters: Double
            let sourceTotalMeters: Double
            let endpointChordMeters: Double
            let radiusMeters: Double
            let smoothingSigmaMeters: Double
            let directionSigmaMeters: Double
            let requestedMinRadiusMeters: Double
            let achievedMinRadiusMeters: Double?
            let achievedDirectionRadiusMeters: Double?
            let minDetailMeters: Double
            let maxDeviationMeters: Double
            let actualMaxDeviationMeters: Double
            let samplingPrecision: Double
            let fitType: String
            let coslat: Double
            let sourceLineLengths: [Int]
            let finalDeviationValid: Bool
            let finalDirectionValid: Bool
            let stationSmoothingPasses: Int?
            let stationJoinRadiusRelaxed: Bool
            let acceptedMinRadiusMeters: Double?
            let stationJoinCount: Int?
            let stationJoinOriginalMaxDeg: Double?
            let stationJoinMaxGapMeters: Double?
            let stationJoinIdMatchedCount: Int?
        }
        struct Group: Decodable {
            let groupKey: String
            /// `-1` for a group with no curve.
            let curve: Int
            let trainIds: [String]
            let endpointNodeKeys: [String?]?
        }
        struct JoinEdge: Decodable {
            let a: [Double]
            let b: [Double]
            let gapM: Double
            let turnDeg: Double
            let matchKind: String
            let nodeKey: String?
        }
        struct Failure: Decodable {
            let reason: String
            let joins: [JoinEdge]
            let groupKeys: [String]
            let requestedMinRadiusM: Double?
            let achievedMinRadiusM: Double?
            let maxDeviationM: Double?
            let actualMaxDeviationM: Double?
        }
        struct Assignment: Decodable {
            /// `-1` none; below `curves.count` the input curve of that index;
            /// otherwise `curves.count + j`, the `j`-th station-continuous
            /// curve this pass produced.
            let curve: Int
            /// `-1` for no failure.
            let failure: Int
        }
        struct Expected: Decodable {
            let roundedJoins: Int
            let failures: [Failure]
            let joined: [CurveOut]
            let groups: [Assignment]
        }
        struct Case: Decodable {
            let label: String
            let country: String
            let kind: String
            let curves: [CurveIn]
            let groups: [Group]
            let expected: Expected
        }
    }

    static let fixture: Fixture = try! PortFixtures.decode(
        Fixture.self, "station-join-smoothing.json")

    // MARK: - decoding helpers

    static func coordinates(_ flat: [Double]) -> [Coordinate] {
        stride(from: 0, to: flat.count, by: 2).map {
            Coordinate(lon: flat[$0], lat: flat[$0 + 1])
        }
    }

    static func inputs(_ expected: Fixture.Case)
        -> (curves: [StationJoinSmoothing.CurveEntry], groups: [StationJoinSmoothing.Group])
    {
        let curves = expected.curves.map { c in
            StationJoinSmoothing.CurveEntry(
                curve: OverlapLanes.FittedCurve(
                    pts: coordinates(c.pts), cum: c.cum,
                    dirs: stride(from: 0, to: c.dirs.count, by: 2).map {
                        (x: c.dirs[$0], y: c.dirs[$0 + 1])
                    },
                    totalMeters: c.totalMeters, sourceTotalMeters: c.sourceTotalMeters,
                    endpointChordMeters: c.endpointChordMeters, radiusMeters: c.radiusMeters,
                    smoothingSigmaMeters: c.smoothingSigmaMeters,
                    directionSigmaMeters: c.directionSigmaMeters,
                    requestedMinRadiusMeters: c.requestedMinRadiusMeters,
                    achievedMinRadiusMeters: c.achievedMinRadiusMeters,
                    achievedDirectionRadiusMeters: c.achievedDirectionRadiusMeters,
                    minDetailMeters: c.minDetailMeters, maxDeviationMeters: c.maxDeviationMeters,
                    actualMaxDeviationMeters: c.actualMaxDeviationMeters,
                    samplingPrecision: c.samplingPrecision, fitType: c.fitType,
                    coslat: c.coslat),
                sourceLines: c.sourceLines.map(coordinates))
        }
        let groups = expected.groups.map {
            StationJoinSmoothing.Group(
                groupKey: $0.groupKey, curveIndex: $0.curve < 0 ? nil : $0.curve,
                trainIds: $0.trainIds, endpointNodeKeys: $0.endpointNodeKeys)
        }
        return (curves, groups)
    }

    /// The worst ULP distance seen in each family of derived field, and where
    /// it was. The `where` is not decoration: a ULP is a relative unit, so a
    /// large count on a quantity that is near zero and a large count on one
    /// that is not are different findings.
    struct Divergence {
        var points: Int64 = 0
        var cum: Int64 = 0
        var dirs: Int64 = 0
        /// The same tangents as `dirs`, but compared as the ANGLE they encode
        /// rather than as its cosine and sine. Near a zero crossing a fixed
        /// angular difference is worth arbitrarily many ULP of the cosine, so
        /// this is the number that says how far the direction field really
        /// moved.
        var angles: Int64 = 0
        var scalars: Int64 = 0
        /// `achievedDirectionRadiusMeters` alone: a quotient by a DIFFERENCE
        /// of adjacent angles, so it is where the cancellation lands.
        var directionRadius: Int64 = 0
        var dirsAt = ""
        var scalarsAt = ""
        mutating func merge(_ other: Divergence) {
            points = Swift.max(points, other.points)
            cum = Swift.max(cum, other.cum)
            angles = Swift.max(angles, other.angles)
            directionRadius = Swift.max(directionRadius, other.directionRadius)
            if other.dirs > dirs {
                dirs = other.dirs
                dirsAt = other.dirsAt
            }
            if other.scalars > scalars {
                scalars = other.scalars
                scalarsAt = other.scalarsAt
            }
        }
        mutating func note(dirs value: Int64, _ what: @autoclosure () -> String) {
            if value > dirs {
                dirs = value
                dirsAt = what()
            }
        }
        mutating func note(scalar value: Int64, _ what: @autoclosure () -> String) {
            if value > scalars {
                scalars = value
                scalarsAt = what()
            }
        }
        var summary: String {
            "pts \(points), cum \(cum), dirs \(dirs) [\(dirsAt)], angles \(angles), "
                + "scalars \(scalars) [\(scalarsAt)], directionRadius \(directionRadius)"
        }
    }

    // MARK: - the pass

    /// Every case: the assignment, the failure reports and the refits.
    @Test(
        "the station-join pass", arguments: 0..<fixture.cases.count)
    func stationJoins(caseIndex: Int) {
        let expected = Self.fixture.cases[caseIndex]
        let label = expected.label
        let (curves, groups) = Self.inputs(expected)
        let outcome = StationJoinSmoothing.smoothCurveStationJoins(
            curves: curves, groups: groups)

        // ── the assignment, which is the whole point of the pass ──
        #expect(
            outcome.roundedJoins == expected.expected.roundedJoins,
            "\(label): station boundaries absorbed")
        #expect(
            outcome.joined.count == expected.expected.joined.count,
            "\(label): station-continuous curves produced")
        #expect(outcome.groupCurve.count == expected.expected.groups.count, "\(label): groups")
        for (index, assignment) in expected.expected.groups.enumerated()
        where index < outcome.groupCurve.count {
            let wanted: StationJoinSmoothing.CurveRef =
                assignment.curve < 0
                ? .none
                : (assignment.curve < curves.count
                    ? .input(assignment.curve) : .joined(assignment.curve - curves.count))
            #expect(
                outcome.groupCurve[index] == wanted,
                "\(label) group \(index) (\(groups[index].groupKey)) curve")
            #expect(
                outcome.groupFailure[index] == (assignment.failure < 0 ? nil : assignment.failure),
                "\(label) group \(index) failure stamp")
        }

        // ── the failure reports ──
        #expect(
            outcome.failures.count == expected.expected.failures.count,
            "\(label): failure count")
        for (index, wanted) in expected.expected.failures.enumerated()
        where index < outcome.failures.count {
            let actual = outcome.failures[index]
            #expect(actual.reason == wanted.reason, "\(label) failure \(index) reason")
            #expect(actual.groupKeys == wanted.groupKeys, "\(label) failure \(index) groups")
            #expect(
                actual.requestedMinRadiusM == wanted.requestedMinRadiusM,
                "\(label) failure \(index) requested radius")
            #expect(
                actual.achievedMinRadiusM == wanted.achievedMinRadiusM,
                "\(label) failure \(index) achieved radius")
            #expect(
                actual.maxDeviationM == wanted.maxDeviationM,
                "\(label) failure \(index) deviation budget")
            #expect(
                actual.actualMaxDeviationM == wanted.actualMaxDeviationM,
                "\(label) failure \(index) actual deviation")
            #expect(actual.joins.count == wanted.joins.count, "\(label) failure \(index) joins")
            for (j, join) in wanted.joins.enumerated() where j < actual.joins.count {
                let got = actual.joins[j]
                #expect(got.matchKind == join.matchKind, "\(label) failure \(index) join \(j) kind")
                #expect(got.nodeKey == join.nodeKey, "\(label) failure \(index) join \(j) node")
                // `+x.toFixed(1)` and `+x.toFixed(2)`: exact, not near.
                #expect(
                    got.gapM.bitPattern == join.gapM.bitPattern,
                    "\(label) failure \(index) join \(j) gap \(got.gapM) vs \(join.gapM)")
                #expect(
                    got.turnDeg.bitPattern == join.turnDeg.bitPattern,
                    "\(label) failure \(index) join \(j) turn \(got.turnDeg) vs \(join.turnDeg)")
                #expect(
                    got.a.lon.bitPattern == join.a[0].bitPattern
                        && got.a.lat.bitPattern == join.a[1].bitPattern
                        && got.b.lon.bitPattern == join.b[0].bitPattern
                        && got.b.lat.bitPattern == join.b[1].bitPattern,
                    "\(label) failure \(index) join \(j) endpoints")
            }
        }

        // ── the refits ──
        var worst = Divergence()
        for (index, wanted) in expected.expected.joined.enumerated()
        where index < outcome.joined.count {
            worst.merge(Self.compare(outcome.joined[index], wanted, label: "\(label) joined \(index)"))
        }
        #expect(
            worst.points == 0,
            "\(label): the refit is arithmetic over its input, so its coordinates are expected bit for bit — \(worst.summary)")
        // The ceilings, and what each one is measuring. `JSMath` carries V8's
        // `cos` and `hypot` and this file uses both; V8 implements `atan2`,
        // `asin`, `sin` and `exp` itself as well and `JSMath` does not carry
        // them, so those four are the platform's and these are what that
        // costs. Measured over all 26 cases:
        //
        //   pts               0     nothing computed here is transcendental
        //   cum               1     haversine, 2 ULP from V8 by construction
        //   angles            5     atan2 + the two Gaussian passes' exp
        //   dirs            128     the SAME 5 ULP of angle, seen through a
        //                           cosine that happens to be 0.036 there
        //   scalars           0     every other field, exactly
        //   directionRadius 766     a quotient by a difference of adjacent
        //                           angles: 5 ULP of angle over a turn of
        //                           ~1e-5 rad is 1.7e-13 relative, and the
        //                           field is a diagnostic compared against a
        //                           threshold eight times away from it
        //
        // The two large numbers are the same 5 ULP of angle twice, which is
        // why the angle itself is measured beside them rather than left to be
        // inferred from a cosine near a zero crossing.
        #expect(worst.cum <= 2, "\(label) arc length: \(worst.summary)")
        #expect(worst.angles <= 8, "\(label) direction field: \(worst.summary)")
        #expect(worst.dirs <= 160, "\(label) tangents: \(worst.summary)")
        #expect(worst.scalars <= 4, "\(label) derived scalars: \(worst.summary)")
        #expect(
            worst.directionRadius <= 1024,
            "\(label) achieved direction radius: \(worst.summary)")
    }

    static func compare(
        _ actual: StationJoinSmoothing.JoinedCurve, _ wanted: Fixture.CurveOut, label: String
    ) -> Divergence {
        var worst = Divergence()
        let curve = actual.curve

        // Structural first: a length mismatch makes every ULP below noise.
        #expect(curve.pts.count * 2 == wanted.pts.count, "\(label): vertex count")
        #expect(curve.cum.count == wanted.cum.count, "\(label): arc-length samples")
        #expect(curve.dirs.count * 2 == wanted.dirs.count, "\(label): tangent samples")
        #expect(curve.fitType == wanted.fitType, "\(label): fit type")
        #expect(
            actual.sourceLines.map(\.count) == wanted.sourceLineLengths,
            "\(label): the raw source lines carried through")
        #expect(
            actual.finalDeviationValid == wanted.finalDeviationValid,
            "\(label): deviation validation")
        #expect(
            actual.finalDirectionValid == wanted.finalDirectionValid,
            "\(label): direction validation")
        #expect(
            actual.stationSmoothingPasses == wanted.stationSmoothingPasses,
            "\(label): low-pass iterations")
        #expect(
            actual.stationJoinRadiusRelaxed == wanted.stationJoinRadiusRelaxed,
            "\(label): the relaxed-radius acceptance")
        #expect(
            actual.acceptedMinRadiusMeters == wanted.acceptedMinRadiusMeters,
            "\(label): the accepted radius floor")
        #expect(actual.stationJoinCount == wanted.stationJoinCount, "\(label): joins absorbed")
        #expect(
            actual.stationJoinIdMatchedCount == wanted.stationJoinIdMatchedCount,
            "\(label): joins matched by node id")
        // Both go through `+x.toFixed(n)`, so they are exact or they are wrong.
        #expect(
            actual.stationJoinOriginalMaxDeg == wanted.stationJoinOriginalMaxDeg,
            "\(label): worst original turn")
        #expect(
            actual.stationJoinMaxGapMeters == wanted.stationJoinMaxGapMeters,
            "\(label): worst join gap")

        if curve.pts.count * 2 == wanted.pts.count {
            for (i, p) in curve.pts.enumerated() {
                worst.points = Swift.max(
                    worst.points,
                    Swift.max(
                        p.lon.ulpDistance(to: wanted.pts[i * 2]),
                        p.lat.ulpDistance(to: wanted.pts[i * 2 + 1])))
            }
        }
        if curve.cum.count == wanted.cum.count {
            for (i, v) in curve.cum.enumerated() {
                worst.cum = Swift.max(worst.cum, v.ulpDistance(to: wanted.cum[i]))
            }
        }
        if curve.dirs.count * 2 == wanted.dirs.count {
            for (i, d) in curve.dirs.enumerated() {
                worst.note(dirs: d.x.ulpDistance(to: wanted.dirs[i * 2]), "cos=\(d.x)")
                worst.note(dirs: d.y.ulpDistance(to: wanted.dirs[i * 2 + 1]), "sin=\(d.y)")
                worst.angles = Swift.max(
                    worst.angles,
                    atan2(d.y, d.x).ulpDistance(
                        to: atan2(wanted.dirs[i * 2 + 1], wanted.dirs[i * 2])))
            }
        }
        func scalar(_ a: Double, _ b: Double, _ what: String) {
            worst.note(scalar: a.ulpDistance(to: b), "\(what)=\(a)")
        }
        scalar(curve.totalMeters, wanted.totalMeters, "totalMeters")
        scalar(curve.sourceTotalMeters, wanted.sourceTotalMeters, "sourceTotalMeters")
        scalar(curve.endpointChordMeters, wanted.endpointChordMeters, "endpointChordMeters")
        scalar(curve.smoothingSigmaMeters, wanted.smoothingSigmaMeters, "smoothingSigma")
        scalar(curve.directionSigmaMeters, wanted.directionSigmaMeters, "directionSigma")
        scalar(curve.actualMaxDeviationMeters, wanted.actualMaxDeviationMeters, "deviation")
        scalar(curve.coslat, wanted.coslat, "coslat")
        // Copied from the template rather than recomputed, so exact.
        #expect(
            curve.requestedMinRadiusMeters.bitPattern
                == wanted.requestedMinRadiusMeters.bitPattern, "\(label): requested radius")
        #expect(
            curve.minDetailMeters.bitPattern == wanted.minDetailMeters.bitPattern,
            "\(label): min detail")
        #expect(
            curve.maxDeviationMeters.bitPattern == wanted.maxDeviationMeters.bitPattern,
            "\(label): deviation budget")
        #expect(
            curve.samplingPrecision.bitPattern == wanted.samplingPrecision.bitPattern,
            "\(label): sampling precision")
        #expect(
            curve.radiusMeters.bitPattern == wanted.radiusMeters.bitPattern,
            "\(label): radius")
        #expect(
            (curve.achievedMinRadiusMeters == nil) == (wanted.achievedMinRadiusMeters == nil),
            "\(label): achieved radius presence")
        if let a = curve.achievedMinRadiusMeters, let b = wanted.achievedMinRadiusMeters {
            scalar(a, b, "achievedMinRadius")
        }
        #expect(
            (curve.achievedDirectionRadiusMeters == nil)
                == (wanted.achievedDirectionRadiusMeters == nil),
            "\(label): achieved direction radius presence")
        if let a = curve.achievedDirectionRadiusMeters,
            let b = wanted.achievedDirectionRadiusMeters
        {
            worst.directionRadius = Swift.max(worst.directionRadius, a.ulpDistance(to: b))
        }
        return worst
    }

    // MARK: - the baselines this port was asked to reproduce

    /// The measurement `OverlapLanes.swift` recorded when it left this pass
    /// unported, checked rather than quoted.
    @Test("the Tokyo scenario replaces 9 of 17 groups' curves")
    func tokyoBaseline() {
        guard let expected = Self.fixture.cases.first(where: { $0.label == "jp:curated-rides" })
        else {
            Issue.record("the jp scenario is missing from the fixture")
            return
        }
        let (curves, groups) = Self.inputs(expected)
        let outcome = StationJoinSmoothing.smoothCurveStationJoins(
            curves: curves, groups: groups)
        var replaced = 0
        for ref in outcome.groupCurve {
            if case .joined = ref { replaced += 1 }
        }
        #expect(groups.count == 17, "the scenario's interaction groups")
        #expect(replaced == 9, "groups whose curve the pass replaces")
        #expect(outcome.joined.count == 3, "station-continuous curves produced")
        #expect(outcome.roundedJoins == 6, "station boundaries absorbed")
        // "typically a 20-point per-run fit by a 210-point re-fit of the
        // concatenated source" — the 210 is the largest of the three.
        #expect(
            outcome.joined.map(\.curve.pts.count).max() == 210,
            "the longest refit's vertex count")
    }

    /// The branches the synthetic mirrors exist to reach, counted rather than
    /// described. A port that no-ops passes every "nothing happened" case in
    /// this fixture and fails here.
    @Test("the adversarial mirrors reach the branches they were chosen for")
    func branchCoverage() {
        var reasons: [String: Int] = [:]
        var relaxed = 0
        var joined = 0
        var idMatched = 0
        var geometryMatched = 0
        var cappedPasses = 0
        var multiCurveChains = 0
        for expected in Self.fixture.cases {
            let (curves, groups) = Self.inputs(expected)
            let outcome = StationJoinSmoothing.smoothCurveStationJoins(
                curves: curves, groups: groups)
            for failure in outcome.failures {
                reasons[failure.reason, default: 0] += 1
                for join in failure.joins {
                    if join.matchKind == "node-id" { idMatched += 1 } else { geometryMatched += 1 }
                }
            }
            for curve in outcome.joined {
                joined += 1
                if curve.stationJoinRadiusRelaxed { relaxed += 1 }
                if curve.stationSmoothingPasses >= 12 { cappedPasses += 1 }
                if curve.stationJoinCount > 1 { multiCurveChains += 1 }
                idMatched += curve.stationJoinIdMatchedCount
                geometryMatched += curve.stationJoinCount - curve.stationJoinIdMatchedCount
            }
        }
        #expect(joined >= 10, "chains accepted: \(joined)")
        #expect(relaxed >= 4, "accepted under the relaxed radius floor: \(relaxed)")
        #expect(cappedPasses >= 3, "refits that hit the 12-pass cap: \(cappedPasses)")
        #expect(multiCurveChains >= 2, "chains of three or more curves: \(multiCurveChains)")
        #expect(reasons["radius"] ?? 0 >= 2, "radius rejections: \(reasons)")
        #expect(reasons["deviation"] ?? 0 >= 1, "deviation-only rejections: \(reasons)")
        #expect(
            reasons["radius+deviation"] ?? 0 >= 1, "joint rejections: \(reasons)")
        // Both match kinds are reached, which is what makes the 90°/60° split
        // between them checkable at all.
        #expect(idMatched > 0 && geometryMatched > 0, "id \(idMatched), geometry \(geometryMatched)")
        // `direction` is unreachable — see the fixture header and
        // `rebuildLimitedDirectionField`. Recorded so a change that makes it
        // reachable shows up here rather than nowhere.
        #expect(reasons["direction"] == nil, "the direction branch stays unreached: \(reasons)")
        #expect(reasons["solver"] == nil, "a chain of two 4-point curves is never under 4 points")
    }

    // MARK: - Number.prototype.toFixed

    /// The join report rounds through `+x.toFixed(1)` and `+x.toFixed(2)`,
    /// and toFixed is not printf.
    ///
    /// The specification picks the integer `n` minimising `|n / 10^f − x|`
    /// against the exact value of `x`, breaking a tie toward the LARGER `n`.
    /// `String(format: "%.1f", 0.25)` answers `"0.2"` and JavaScript answers
    /// `"0.3"`, so a port that reaches for the format string is wrong on every
    /// tie — and a gap of exactly 0.25 m between two station endpoints is not
    /// an exotic input.
    @Test("toFixed rounds ties the way JavaScript does, not the way printf does")
    func toFixed() {
        var printfDisagreements = 0
        for expected in Self.fixture.toFixed {
            let text = StationJoinSmoothing.toFixedString(expected.value, expected.digits)
            #expect(
                text == expected.text,
                "toFixed(\(expected.value), \(expected.digits)): \(text) vs \(expected.text)")
            let number = StationJoinSmoothing.toFixedNumber(expected.value, expected.digits)
            #expect(
                number.bitPattern == expected.number.bitPattern,
                "+toFixed(\(expected.value), \(expected.digits))")
            if String(format: "%.*f", expected.digits, expected.value) != expected.text {
                printfDisagreements += 1
            }
        }
        // The measurement, not a threshold: this is how many of the pinned
        // cases the obvious implementation gets wrong.
        #expect(
            printfDisagreements == 6,
            "String(format:) disagrees with JavaScript on \(printfDisagreements) of \(Self.fixture.toFixed.count) cases")
    }

    // MARK: - the measurements the port rests on

    /// How much room the pass's decisions have, in the units a library
    /// difference is measured in.
    ///
    /// `PORTING.md` says to measure rather than assume. Three of the four
    /// libm functions this pass reaches for are not in ``JSMath`` and V8
    /// implements all three itself (`base/ieee754.cc`): `acos` decides a
    /// candidate's turn, `atan2` builds the direction field, and `sin`
    /// finishes it. Porting fdlibm three more times is not what this port is
    /// for, so the question is what a last-bit difference in them could
    /// REACH.
    ///
    /// `acos` is the one that could change an answer rather than a coordinate:
    /// its output is compared against 90°, 60° and 25° to decide whether two
    /// curves join at all. So this measures the closest any real candidate
    /// came to one of those thresholds, and the closest two candidates' scores
    /// came to each other — the two ways a 1-ULP turn could change which
    /// curves get welded. Both margins are enormous, which is why the parity
    /// test above passes bit for bit on every structural answer.
    @Test("how close this pass's decisions come to their thresholds")
    func decisionMargins() {
        let thresholds = [
            (90 * Double.pi) / 180, (60 * Double.pi) / 180, (25 * Double.pi) / 180,
        ]
        var turns: [Double] = []
        var closestThreshold = Double.infinity
        var closestScores = Double.infinity
        var closestGate = Double.infinity
        var latitudes: [Double] = []
        for expected in Self.fixture.cases {
            let (curves, groups) = Self.inputs(expected)
            let (order, owners) = StationJoinSmoothing.indexStationJoinCurveOwners(
                curves: curves, groups: groups)
            let ends = StationJoinSmoothing.collectStationJoinEndpoints(
                curves: curves, order: order, owners: owners, groups: groups)
            for entry in curves {
                for p in entry.curve.pts { latitudes.append(p.lat) }
            }
            for i in 0..<ends.count {
                for j in (i + 1)..<ends.count where ends[i].curveIndex != ends[j].curveIndex {
                    let dot = Swift.max(
                        -1,
                        Swift.min(
                            1,
                            -(ends[i].outward.x * ends[j].outward.x
                                + ends[i].outward.y * ends[j].outward.y)))
                    let turn = acos(dot)
                    turns.append(turn)
                    for threshold in thresholds {
                        closestThreshold = Swift.min(closestThreshold, abs(turn - threshold))
                    }
                    // The two distance gates the same pair is measured by.
                    let metres = Geometry.distanceMeters(ends[i].p, ends[j].p)
                    closestGate = Swift.min(
                        closestGate, Swift.min(abs(metres - 120), abs(metres - 40)))
                }
            }
            let candidates = StationJoinSmoothing.pairStationJoinCandidates(ends)
            for k in 1..<Swift.max(1, candidates.count) {
                let gap = abs(candidates[k].score - candidates[k - 1].score)
                if gap > 0 { closestScores = Swift.min(closestScores, gap) }
            }
        }
        #expect(turns.count > 100, "candidate turns measured: \(turns.count)")
        // 1 ULP at these magnitudes is about 2e-16 radians. Recorded, not
        // asserted against a tuned bound: the point is the ORDER of the
        // margin, which is fourteen decades of room.
        #expect(
            closestThreshold > 1e-6,
            "closest any turn came to an angular gate: \(closestThreshold) rad")
        #expect(
            closestGate > 1e-6, "closest any pair came to a distance gate: \(closestGate) m")
        #expect(
            closestScores > 1e-6,
            "closest two candidate scores came to each other: \(closestScores)")

        // And the measurement that justifies the functions this file DOES take
        // from V8, over this pass's own latitudes rather than another file's.
        var disagreements = 0
        var worst: Int64 = 0
        for latitude in latitudes {
            let radians = (latitude * .pi) / 180
            let v8 = JSMath.cos(radians)
            let platform = Foundation.cos(radians)
            if v8.bitPattern != platform.bitPattern {
                disagreements += 1
                worst = Swift.max(worst, v8.ulpDistance(to: platform))
            }
        }
        #expect(
            latitudes.count > 5000,
            "over \(latitudes.count) latitudes, V8's cos and Darwin's disagree on \(disagreements), worst \(worst) ULP")
        #expect(worst <= 1, "V8 and Darwin cos should never be more than 1 ULP apart")
    }
}
