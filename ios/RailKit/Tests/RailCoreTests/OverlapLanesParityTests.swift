import Foundation
import Testing

@testable import RailCore

/// `RailCore.OverlapLanes` against `port-fixtures/overlap-lanes.json`.
///
/// The expected answers come from running the real frontend — the whole
/// classic-script family in a Node `vm`, the two committed train stores solved
/// through the app's own precompute adapter, and the resulting route items
/// handed to `buildDeckOverlapMap` and `buildDeckRouteRecords` themselves.
///
/// ## What is held to what standard
///
/// **Exact, always.** Everything structural: which segments share a set, which
/// set's identity a segment carries, where the runs split, which groupKey a run
/// gets, which vertices are drawn, which lane slot each ride lands in, how many
/// points a fitted curve has and whether it was fitted at all. A lane is a
/// decision made from distances — a ride in the wrong lane is a visibly wrong
/// map — so none of these may be approximate. Vertices that are COPIED are also
/// exact, by bit pattern: a copy that differs is a port bug.
///
/// **A measured ULP ceiling, for computed geometry only.** The corridor fit
/// runs `exp`, `sin`, `cos` and `atan2` over a long iterative pipeline. V8
/// implements all four itself (`base/ieee754.cc`) and `RailCore.JSMath` carries
/// only `cos` and `hypot`, so the fitted coordinates cannot be bit-identical
/// without porting fdlibm three more times. What the ceiling is, and what it is
/// measured over, is stated at each `#expect` that uses one — never a relative
/// epsilon, which would be loose enough to absorb a wrong constant too.
struct OverlapLanesParityTests {

    // MARK: - the fixture

    struct Fixture: Decodable {
        let cases: [Case]

        struct Near: Decodable {
            let pairCount: Int
            let maxSeparationMeters: Double
            let thresholdMeters: Double
        }
        struct ItemRecord: Decodable {
            let trainId: String
            let drawn: Bool
            let recordDrawn: Bool
            let noPick: Bool
            let width: Double
            /// Flat `[lon, lat, lon, lat, …]` per line — the geometry as
            /// `iterateGeometryLines` normalised it.
            let lines: [[Double]]
        }
        struct Segment: Decodable {
            let key: String
            let ids: [String]?
            let slots: [Int]?
            let groupKey: String
            let near: Near?
            let dirFromA: Double
            let dirFromB: Double
        }
        struct Line: Decodable {
            let itemIndex: Int
            let lineIndex: Int
            let trainId: String
            let segKeys: [String]
            let segIdsSig: [String?]
            let segSlot: [Int]
            let segMult: [Double]
            let segBridged: [Bool]
            let lineHasOverlap: Bool
            let runs: [[Int]]
            /// Flat `[originalIndex, drawnPosition, …]`.
            let drawnIdx: [Int]
            let drawnLen: Double
            let runGroupKeys: [String]
            /// `[latRef, coslatRef, dx, dy, len]` per run.
            let runAxes: [[Double]]
        }
        struct Mult: Decodable {
            let trainId: String
            let mult: Double
        }
        struct CorridorJoin: Decodable {
            let aKey: String
            let aSide: Int
            let bKey: String
            let bSide: Int
            let metres: Double
            let score: Double
        }
        struct Bridge: Decodable {
            let trainId: String
            let recordIndex: Int
            let laneMult: Double
            let pickWidth: Double
            let path: [Double]
        }
        struct Group: Decodable {
            let key: String
            let sx: Double
            let sy: Double
            let mults: [Mult]
            let line: [Double]
            let pa: [Double]
            let pb: [Double]
            let latRef: Double
            let sig: String
            let endpointNodeKeys: [String]?
            let nearParallel: Near?
            let corridorJoins: [CorridorJoin]
            let pickBridges: [Bridge]
        }
        struct Record: Decodable {
            let trainId: String
            let path: [Double]
            let laneMult: Double
            let overlapCount: Int
            let overlapSlot: Int
            let groupKey: String
            let shiftX: Double
            let shiftY: Double
            let pickWidth: Double
            let nopick: Bool
            let sortKey: Double
            let lane: Int
        }
        struct Expand: Decodable {
            let trainId: String
            let path: [Double]
        }
        struct Settings: Decodable {
            let precision: Double?
            let minRadius: Double?
            let minDetail: Double?
            let maxDeviation: Double?
        }
        struct CurveOutput: Decodable {
            let pts: [Double]
            /// Present in full on the real corridor fits; the probes carry a
            /// decimated ``Sample`` instead, because storing all three series
            /// for 144 probe curves tripled the file.
            let cum: [Double]?
            let dirs: [Double]?
            let cumSample: Sample?
            let dirsSample: Sample?
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
        }
        /// A series pinned by its true length plus every `stride`-th value.
        struct Sample: Decodable {
            let length: Int
            let stride: Int
            let values: [Double]
        }
        struct CurveCall: Decodable {
            let input: [Double]
            let output: CurveOutput?
        }
        struct Probe: Decodable {
            let label: String
            let settings: Settings
            let input: [Double]
            let output: CurveOutput?
        }
        struct Case: Decodable {
            let label: String
            let country: String
            let trainOrder: [String]
            let rank: [String: Int]
            let items: [ItemRecord]
            let spacingPx: Double
            let hasOverlaps: Bool
            let segments: [Segment]
            let lines: [Line]
            let groups: [Group]
            let records: [Record]
            let expandRecords: [Expand]
            let curves: [CurveCall]
            let probes: [Probe]
            let settings: Settings
        }
    }

    static let fixture: Fixture = try! PortFixtures.decode(Fixture.self, "overlap-lanes.json")

    // MARK: - decoding helpers

    static func coordinates(_ flat: [Double]) -> [Coordinate] {
        stride(from: 0, to: flat.count, by: 2).map {
            Coordinate(lon: flat[$0], lat: flat[$0 + 1])
        }
    }

    static func settings(_ s: Fixture.Settings) -> OverlapLanes.FitCurveSettings {
        OverlapLanes.FitCurveSettings(
            precision: s.precision, minRadius: s.minRadius, minDetail: s.minDetail,
            maxDeviation: s.maxDeviation)
    }

    /// One scenario's inputs, rebuilt into what the port takes.
    struct Scenario: Sendable {
        let label: String
        let items: [OverlapLanes.Item]
        let snap: OverlapLanes.VertexSnap
        let lines: [[OverlapLanes.RouteLine]]
        let overlap: OverlapLanes.OverlapMap
        let expected: Fixture.Case
    }

    static let scenarios: [Scenario] = fixture.cases.map { expected in
        let items = expected.items.map { item in
            OverlapLanes.Item(
                trainId: item.trainId, drawn: item.drawn, recordDrawn: item.recordDrawn,
                noPick: item.noPick, strokeWidth: item.width,
                geometry: item.lines.map(coordinates))
        }
        let built = OverlapLanes.routeLines(for: items)
        return Scenario(
            label: expected.label, items: items, snap: built.snap, lines: built.lines,
            overlap: OverlapLanes.buildOverlapMap(
                items: items, lines: built.lines, rank: expected.rank),
            expected: expected)
    }

    // MARK: - §0 the vertex snap and the segment keys

    /// The keys everything downstream is bucketed on.
    ///
    /// This runs first because it is the one failure that explains every other
    /// one: `getRouteLinePairs` builds each key from the SNAPPED endpoints, and
    /// a port that keyed on the raw coordinates would produce a plausible map
    /// in which no corridor is ever shared.
    @Test("segment keys are built on the snapped endpoints", arguments: [0, 1])
    func segmentKeys(scenarioIndex: Int) {
        let scenario = Self.scenarios[scenarioIndex]
        var checked = 0
        for line in scenario.expected.lines {
            let actual = scenario.lines[line.itemIndex][line.lineIndex]
            #expect(
                actual.segKeys == line.segKeys,
                "\(scenario.label) item \(line.itemIndex) line \(line.lineIndex) segment keys")
            #expect(actual.keepIdx == nil, "ROUTE_SIMPLIFY_METERS is 0, so keepIdx is null")
            checked += actual.segKeys.count
        }
        #expect(checked > 0)
    }

    // MARK: - §1 the overlap map

    @Test("the overlap map's sharing sets, groups and directions", arguments: [0, 1])
    func overlapMap(scenarioIndex: Int) {
        let scenario = Self.scenarios[scenarioIndex]
        let overlap = scenario.overlap
        #expect(
            overlap.segmentKeys == scenario.expected.segments.map(\.key),
            "\(scenario.label): the segment keys, and the order they were first seen in")

        for segment in scenario.expected.segments {
            let ids = overlap.ids(for: segment.key)
            if let expectedIds = segment.ids {
                guard let ids else {
                    Issue.record("\(scenario.label) \(segment.key): expected a sharing set")
                    continue
                }
                // Order as well as membership: `Object.keys(gi.mults)` is this
                // order, and it decides the order pick bridges come out in.
                #expect(ids.order == expectedIds, "\(scenario.label) \(segment.key) sharing set")
                #expect(
                    expectedIds.map { ids.slot(of: $0) } == segment.slots,
                    "\(scenario.label) \(segment.key) lane slots")
            } else {
                #expect(ids == nil, "\(scenario.label) \(segment.key): expected no sharing set")
            }
            #expect(
                overlap.groupKey(for: segment.key) == segment.groupKey,
                "\(scenario.label) \(segment.key) interaction key")
            let near = overlap.nearGroupInfo(segment.groupKey)
            #expect(
                (near == nil) == (segment.near == nil),
                "\(scenario.label) \(segment.key) near-parallel presence")
            if let near, let expectedNear = segment.near {
                #expect(near.pairCount == expectedNear.pairCount)
                #expect(
                    near.maxSeparationMeters.bitPattern
                        == expectedNear.maxSeparationMeters.bitPattern,
                    "\(scenario.label) \(segment.key) max separation")
                #expect(near.thresholdMeters == expectedNear.thresholdMeters)
            }
        }
    }

    /// The canonical corridor direction, probed from both ends of every shared
    /// segment.
    ///
    /// Split out because it is the one answer in the overlap map that is
    /// decided by ITERATION ORDER and by nothing else — which end of a chain
    /// the walk starts from, and therefore which way every segment in it
    /// points. A Swift `Dictionary` in place of the JavaScript `Map` passes
    /// every other assertion in this file and fails this one.
    @Test("the canonical corridor direction of every shared segment", arguments: [0, 1])
    func corridorDirection(scenarioIndex: Int) {
        let scenario = Self.scenarios[scenarioIndex]
        var byKey: [String: (a: Coordinate, b: Coordinate)] = [:]
        for (itemIndex, item) in scenario.items.enumerated() where item.drawn {
            for line in scenario.lines[itemIndex] {
                for i in 0..<line.segKeys.count where byKey[line.segKeys[i]] == nil {
                    byKey[line.segKeys[i]] = (line.orig[i], line.orig[i + 1])
                }
            }
        }
        var shared = 0
        for segment in scenario.expected.segments {
            guard let geometry = byKey[segment.key] else { continue }
            let dirA = scenario.overlap.direction(
                for: segment.key, from: scenario.snap.nodeKey(geometry.a))
            let dirB = scenario.overlap.direction(
                for: segment.key, from: scenario.snap.nodeKey(geometry.b))
            #expect(dirA == segment.dirFromA, "\(scenario.label) \(segment.key) direction from a")
            #expect(dirB == segment.dirFromB, "\(scenario.label) \(segment.key) direction from b")
            if segment.ids != nil { shared += 1 }
        }
        #expect(shared > 100, "\(scenario.label): the scenario has to contain real overlaps")
    }

    // MARK: - §2 per-line lane assignment

    @Test("lane slots, multipliers, bridged slivers, runs and drawn subsets", arguments: [0, 1])
    func laneAssignment(scenarioIndex: Int) {
        let scenario = Self.scenarios[scenarioIndex]
        var bridged = 0
        for expected in scenario.expected.lines {
            let line = scenario.lines[expected.itemIndex][expected.lineIndex]
            let item = scenario.items[expected.itemIndex]
            let nSeg = line.orig.count - 1
            let lanes = OverlapLanes.assignSegmentOverlapLanes(
                overlap: scenario.overlap, orig: line.orig, segKeys: line.segKeys,
                trainId: item.trainId, noPick: item.noPick)
            let label = "\(scenario.label) \(expected.trainId)#\(expected.lineIndex)"

            // Set IDENTITY, not membership: two segments belong to one run
            // exactly when their sharing sets are the same instance, and
            // interning is what made one instance per distinct membership.
            let identities = lanes.segIdentity.map { index in
                index.map { scenario.overlap.sharedSets[$0].signature }
            }
            #expect(identities == expected.segIdsSig, "\(label) sharing-set identity per segment")
            #expect(lanes.segSlot == expected.segSlot, "\(label) lane slots")
            #expect(
                lanes.segMult.map(\.bitPattern) == expected.segMult.map(\.bitPattern),
                "\(label) lane multipliers")
            #expect(lanes.segBridged == expected.segBridged, "\(label) bridged slivers")
            #expect(lanes.lineHasOverlap == expected.lineHasOverlap, "\(label) has overlap")
            bridged += lanes.segBridged.filter { $0 }.count

            let runs = OverlapLanes.maximalOverlapRuns(
                segIdentity: lanes.segIdentity, nSeg: nSeg)
            #expect(runs.map { [$0.a, $0.b] } == expected.runs, "\(label) maximal runs")

            let subset = OverlapLanes.buildDrawnVertexSubset(
                orig: line.orig, keepIdx: line.keepIdx, runs: runs, nSeg: nSeg)
            var flatPositions: [Int] = []
            for (original, position) in subset.posOf.sorted(by: { $0.value < $1.value }) {
                flatPositions.append(original)
                flatPositions.append(position)
            }
            // The generator walked a JavaScript Map, whose order here is
            // ascending drawn position, so the two agree once sorted that way.
            #expect(flatPositions == expected.drawnIdx, "\(label) drawn vertex subset")
            #expect(
                subset.drawnLen.ulpDistance(to: expected.drawnLen) <= 1,
                "\(label) drawn length: \(subset.drawnLen) vs \(expected.drawnLen)")

            #expect(
                runs.map { run in
                    lanes.segIdentity[run.a] != nil
                        ? OverlapLanes.canonicalRunGroupKey(
                            overlap: scenario.overlap, segKeys: line.segKeys,
                            segBridged: lanes.segBridged, ra: run.a, rb: run.b)
                        : ""
                } == expected.runGroupKeys, "\(label) run group keys")

            for (index, run) in runs.enumerated() {
                let axis = OverlapLanes.corridorRunShiftAxis(
                    overlap: scenario.overlap, snap: scenario.snap, orig: line.orig,
                    segKeys: line.segKeys, ra: run.a, rb: run.b)
                let want = expected.runAxes[index]
                let got = [axis.latRef, axis.coslatRef, axis.dx, axis.dy, axis.len]
                #expect(
                    got.map(\.bitPattern) == want.map(\.bitPattern),
                    "\(label) run \(index) shift axis: \(got) vs \(want)")
            }
        }
        #expect(bridged > 0, "\(scenario.label): the sliver bridge has to be exercised")
    }

    // MARK: - §3 + §5 the corridors and the records

    static let bundles: [OverlapLanes.RecordBundle] = scenarios.map { scenario in
        OverlapLanes.buildRouteRecords(
            items: scenario.items, lines: scenario.lines, overlap: scenario.overlap,
            snap: scenario.snap, rank: scenario.expected.rank,
            spacingPx: scenario.expected.spacingPx,
            settings: settings(scenario.expected.settings))
    }

    @Test("the stitched corridors", arguments: [0, 1])
    func corridors(scenarioIndex: Int) {
        let scenario = Self.scenarios[scenarioIndex]
        let bundle = Self.bundles[scenarioIndex]
        #expect(
            bundle.corridors.map(\.key) == scenario.expected.groups.map(\.key),
            "\(scenario.label): the surviving group keys, in creation order")

        for expected in scenario.expected.groups {
            guard let gi = bundle.corridor(expected.key) else {
                Issue.record("\(scenario.label): group \(expected.key) is missing")
                continue
            }
            let label = "\(scenario.label) group \(expected.key)"
            // The shift vector is what the renderer translates by. It comes out
            // of a chord and a cosine, so it is held to the same bit standard
            // as the lane multiplier it is multiplied against.
            #expect(gi.sx.bitPattern == expected.sx.bitPattern, "\(label) sx")
            #expect(gi.sy.bitPattern == expected.sy.bitPattern, "\(label) sy")
            #expect(
                gi.mults.map(\.trainId) == expected.mults.map(\.trainId),
                "\(label) lane multiplier ORDER")
            #expect(
                gi.mults.map(\.mult) == expected.mults.map(\.mult), "\(label) lane multipliers")
            let line = Self.coordinates(expected.line)
            #expect(gi.line.count == line.count, "\(label) representative vertex count")
            #expect(gi.line == line, "\(label) representative geometry")
            #expect(gi.pa == Coordinate(pair: expected.pa), "\(label) pa")
            #expect(gi.pb == Coordinate(pair: expected.pb), "\(label) pb")
            #expect(gi.latRef.bitPattern == expected.latRef.bitPattern, "\(label) latRef")
            #expect(gi.signature == expected.sig, "\(label) membership signature")
            if let keys = expected.endpointNodeKeys {
                #expect(gi.curveEndpointNodeKeys == keys, "\(label) curve endpoint node keys")
            }
            #expect(
                (gi.nearParallel == nil) == (expected.nearParallel == nil),
                "\(label) near-parallel presence")
            if let near = gi.nearParallel, let want = expected.nearParallel {
                #expect(near.pairCount == want.pairCount, "\(label) near pair count")
                #expect(
                    near.maxSeparationMeters.bitPattern == want.maxSeparationMeters.bitPattern,
                    "\(label) near max separation")
            }
            #expect(
                gi.corridorJoins.count == expected.corridorJoins.count, "\(label) join count")
            for (index, join) in gi.corridorJoins.enumerated()
            where index < expected.corridorJoins.count {
                let want = expected.corridorJoins[index]
                #expect(join.a.key == want.aKey && join.a.side == want.aSide, "\(label) join a")
                #expect(join.b.key == want.bKey && join.b.side == want.bSide, "\(label) join b")
                #expect(join.metres.bitPattern == want.metres.bitPattern, "\(label) join metres")
                #expect(join.score.bitPattern == want.score.bitPattern, "\(label) join score")
            }
            #expect(
                gi.pickBridges.count == expected.pickBridges.count, "\(label) pick bridge count")
            for (index, bridge) in gi.pickBridges.enumerated()
            where index < expected.pickBridges.count {
                let want = expected.pickBridges[index]
                #expect(bridge.trainId == want.trainId, "\(label) bridge \(index) ride")
                #expect(bridge.recordIndex == want.recordIndex, "\(label) bridge \(index) record")
                #expect(bridge.laneMult == want.laneMult, "\(label) bridge \(index) lane")
                #expect(bridge.pickWidth == want.pickWidth, "\(label) bridge \(index) width")
                #expect(
                    bridge.path == Self.coordinates(want.path), "\(label) bridge \(index) path")
            }
        }
    }

    @Test("the records the renderer consumes", arguments: [0, 1])
    func records(scenarioIndex: Int) {
        let scenario = Self.scenarios[scenarioIndex]
        let bundle = Self.bundles[scenarioIndex]
        #expect(bundle.hasOverlaps == scenario.expected.hasOverlaps)
        #expect(
            bundle.records.count == scenario.expected.records.count,
            "\(scenario.label) record count")
        for (index, record) in bundle.records.enumerated()
        where index < scenario.expected.records.count {
            let want = scenario.expected.records[index]
            let label = "\(scenario.label) record \(index) (\(record.trainId))"
            #expect(record.trainId == want.trainId, "\(label) ride")
            let path = Self.coordinates(want.path)
            #expect(record.path.count == path.count, "\(label) vertex count")
            #expect(record.path == path, "\(label) geometry")
            #expect(record.laneMult == want.laneMult, "\(label) lane multiplier")
            #expect(record.overlapCount == want.overlapCount, "\(label) overlap count")
            #expect(record.overlapSlot == want.overlapSlot, "\(label) overlap slot")
            #expect(record.groupKey == want.groupKey, "\(label) group key")
            #expect(record.shiftX.bitPattern == want.shiftX.bitPattern, "\(label) shiftX")
            #expect(record.shiftY.bitPattern == want.shiftY.bitPattern, "\(label) shiftY")
            #expect(record.pickWidth == want.pickWidth, "\(label) pick width")
            #expect(record.nopick == want.nopick, "\(label) nopick")
            #expect(record.lane == want.lane, "\(label) lane")
            // The painter's order. Whole-metre length ranking is what makes an
            // opposite-direction traversal tie before the date fallback, so a
            // last-bit difference in a summed distance must not reach here.
            #expect(record.sortKey == want.sortKey, "\(label) sort key")
        }

        #expect(
            bundle.expandRecords.count == scenario.expected.expandRecords.count,
            "\(scenario.label) expand record count")
        for (index, record) in bundle.expandRecords.enumerated()
        where index < scenario.expected.expandRecords.count {
            let want = scenario.expected.expandRecords[index]
            #expect(record.trainId == want.trainId, "\(scenario.label) expand \(index) ride")
            #expect(
                record.path == Self.coordinates(want.path),
                "\(scenario.label) expand \(index) geometry")
        }
    }

    // MARK: - §4 the corridor fit

    /// The worst ULP distance seen on each of a fitted curve's four number
    /// series. Reported rather than merely asserted, so the ceilings below are
    /// evidence instead of a tolerance that happened to pass.
    struct FitDivergence {
        var points: Int64 = 0
        var cum: Int64 = 0
        var dirs: Int64 = 0
        var scalars: Int64 = 0

        mutating func merge(_ other: FitDivergence) {
            points = Swift.max(points, other.points)
            cum = Swift.max(cum, other.cum)
            dirs = Swift.max(dirs, other.dirs)
            scalars = Swift.max(scalars, other.scalars)
        }
    }

    /// The ceilings the fitted geometry is held to, and why they are not zero.
    ///
    /// Everything upstream of the fit is bit-identical — the overlap map, the
    /// lane slots, the run boundaries, the shift axes, the corridor joins and
    /// every record the renderer consumes. Only this section diverges, and only
    /// because it calls `exp`, `sin` and `atan2`: V8 answers all three from its
    /// own fdlibm port (`base/ieee754.cc`), `RailCore.JSMath` carries `cos` and
    /// `hypot` and not those, and porting fdlibm three more times is a
    /// different piece of work from porting this file.
    ///
    /// Measured, and the two numbers are worth separating:
    ///
    ///                        36 real corridor fits   144 adversarial probes
    ///     coordinates                  0 ULP                    1 ULP
    ///     arc-length table             0 ULP                  253 ULP
    ///     direction table             32 ULP                 8192 ULP
    ///     scalar summaries             1 ULP                   14 ULP
    ///
    /// **Every corridor this app actually fits comes out bit-identical**, in
    /// both its geometry and its arc-length table. The probes are the ones that
    /// diverge, and they are 350 km alignments and settings a reader would have
    /// to drag a slider to the end of its range to ask for.
    ///
    /// The direction table's number is the largest and the least alarming: a
    /// direction is `cos(angle)` and `sin(angle)`, and near a quarter turn one
    /// of the two is close to zero, where a 1-ULP difference in the angle
    /// becomes thousands of ULP in a value that is itself near 1e-16. As a unit
    /// vector the whole table still agrees to about 1e-15 — a millionth of a
    /// degree of bearing.
    ///
    /// The 253-ULP arc-length figure is a cumulative sum of 1,300 haversines
    /// along 丸ノ内線 at a 20 km requested radius: about 1.8 nanometres.
    static let radiusRelativeCeiling = 3e-9
    static let pointsUlpCeiling: Int64 = 1
    static let cumUlpCeiling: Int64 = 253
    static let dirsUlpCeiling: Int64 = 8192
    static let scalarUlpCeiling: Int64 = 14

    /// Compares one fitted curve. Structure is exact; the four number series
    /// are held to the ceilings above.
    static func compare(
        _ got: OverlapLanes.FittedCurve?, _ want: Fixture.CurveOutput?, label: String
    ) -> FitDivergence {
        var worst = FitDivergence()
        guard let want else {
            #expect(got == nil, "\(label): the JavaScript rejected this fit and the port did not")
            return worst
        }
        guard let got else {
            #expect(Bool(false), "\(label): the port rejected a fit the JavaScript accepted")
            return worst
        }
        // Structure first. A different point count or a different fallback is a
        // different curve, not a rounding difference, and saying so before the
        // ULP comparison keeps the failure readable.
        let wantPts = coordinates(want.pts)
        #expect(got.pts.count == wantPts.count, "\(label) vertex count")
        #expect(got.fitType == want.fitType, "\(label) fit type")
        #expect(got.samplingPrecision == want.samplingPrecision, "\(label) sampling precision")
        #expect(got.minDetailMeters == want.minDetailMeters, "\(label) min detail")
        #expect(got.maxDeviationMeters == want.maxDeviationMeters, "\(label) max deviation")
        #expect(
            got.requestedMinRadiusMeters == want.requestedMinRadiusMeters,
            "\(label) requested min radius")
        #expect(
            (got.achievedMinRadiusMeters == nil) == (want.achievedMinRadiusMeters == nil),
            "\(label) achieved radius finiteness")
        #expect(
            (got.achievedDirectionRadiusMeters == nil)
                == (want.achievedDirectionRadiusMeters == nil),
            "\(label) achieved direction radius finiteness")
        #expect(got.coslat.bitPattern == want.coslat.bitPattern, "\(label) cos(latitude)")
        guard got.pts.count == wantPts.count else { return worst }

        for (index, point) in got.pts.enumerated() {
            worst.points = Swift.max(worst.points, point.lon.ulpDistance(to: wantPts[index].lon))
            worst.points = Swift.max(worst.points, point.lat.ulpDistance(to: wantPts[index].lat))
        }
        #expect(
            worst.points <= pointsUlpCeiling, "\(label) geometry: worst \(worst.points) ULP")

        let gotDirs = got.dirs.flatMap { [$0.x, $0.y] }
        if let wantCum = want.cum {
            #expect(got.cum.count == wantCum.count, "\(label) arc-length table length")
            for (index, value) in got.cum.enumerated() where index < wantCum.count {
                worst.cum = Swift.max(worst.cum, value.ulpDistance(to: wantCum[index]))
            }
        }
        if let sample = want.cumSample {
            #expect(got.cum.count == sample.length, "\(label) arc-length table length")
            for (index, value) in sample.values.enumerated() {
                let position = index * sample.stride
                guard position < got.cum.count else { break }
                worst.cum = Swift.max(worst.cum, got.cum[position].ulpDistance(to: value))
            }
        }
        #expect(worst.cum <= cumUlpCeiling, "\(label) arc-length table: worst \(worst.cum) ULP")

        if let wantDirs = want.dirs {
            #expect(gotDirs.count == wantDirs.count, "\(label) direction table length")
            for (index, value) in gotDirs.enumerated() where index < wantDirs.count {
                worst.dirs = Swift.max(worst.dirs, value.ulpDistance(to: wantDirs[index]))
            }
        }
        if let sample = want.dirsSample {
            #expect(gotDirs.count == sample.length, "\(label) direction table length")
            for (index, value) in sample.values.enumerated() {
                let position = index * sample.stride
                guard position < gotDirs.count else { break }
                worst.dirs = Swift.max(worst.dirs, gotDirs[position].ulpDistance(to: value))
            }
        }
        #expect(worst.dirs <= dirsUlpCeiling, "\(label) direction table: worst \(worst.dirs) ULP")

        // Well-conditioned summaries: each is a sum or a single expression over
        // the geometry above, so a last-bit difference stays a last-bit
        // difference.
        for (name, pair) in [
            ("total metres", (got.totalMeters, want.totalMeters)),
            ("source total metres", (got.sourceTotalMeters, want.sourceTotalMeters)),
            ("endpoint chord", (got.endpointChordMeters, want.endpointChordMeters)),
            ("radius", (got.radiusMeters, want.radiusMeters)),
            ("smoothing sigma", (got.smoothingSigmaMeters, want.smoothingSigmaMeters)),
            ("direction sigma", (got.directionSigmaMeters, want.directionSigmaMeters)),
            (
                "actual max deviation",
                (got.actualMaxDeviationMeters, want.actualMaxDeviationMeters)
            ),
        ] {
            let distance = pair.0.ulpDistance(to: pair.1)
            worst.scalars = Swift.max(worst.scalars, distance)
            #expect(distance <= scalarUlpCeiling, "\(label) \(name): \(distance) ULP")
        }

        // The two achieved-radius diagnostics are ILL-CONDITIONED, and a ULP
        // ceiling is the wrong unit for them.
        //
        // Both are a curvature: one is `(ab·bc·ca) / (2·cross)` over three
        // nearly collinear points, the other is `arcLength / turn` over a turn
        // of ~1e-9 radians. The denominator is a cancelling difference, so on a
        // near-straight alignment the answer is enormous and its last bits mean
        // nothing — measured, 16,032,398 ULP apart on the 350 km high-speed
        // line, which is a RELATIVE difference of 2.1e-9 on a radius of 3.6e8
        // metres. Counting ULP on such a number is counting the wrong thing.
        //
        // What the two numbers are FOR is one comparison each, against
        // `requestedMinRadius * 0.999`, and that comparison decides whether the
        // fit is published at all. So this pins the decision — which side of
        // the threshold each lands on — rather than a tolerance on a number
        // whose conditioning makes any tolerance arbitrary. The decision itself
        // is already pinned exactly by the accept/reject check above; this
        // states the margin as well, so a port that landed on the right side by
        // luck rather than by agreement would still show up.
        let threshold = want.requestedMinRadiusMeters * 0.999
        for (name, pair) in [
            (
                "achieved min radius",
                (got.achievedMinRadiusMeters, want.achievedMinRadiusMeters)
            ),
            (
                "achieved direction radius",
                (
                    got.achievedDirectionRadiusMeters,
                    want.achievedDirectionRadiusMeters
                )
            ),
        ] {
            let gotValue = pair.0 ?? .infinity
            let wantValue = pair.1 ?? .infinity
            let sides =
                "\(label) \(name): \(gotValue) and \(wantValue) fall on opposite sides "
                + "of the \(threshold) m acceptance threshold"
            #expect((gotValue < threshold) == (wantValue < threshold), "\(sides)")
            let relative =
                wantValue.isFinite && wantValue != 0
                ? abs(gotValue - wantValue) / abs(wantValue) : 0
            #expect(
                relative <= radiusRelativeCeiling,
                "\(label) \(name): \(gotValue) vs \(wantValue), relative \(relative)")
        }
        return worst
    }

    /// The corridor fits the real build made, captured by delegating
    /// `smoothCorridorCurve` in the generator — so these are the function's own
    /// inputs, not inputs invented for it.
    @Test("every corridor fit the build performed", arguments: [0, 1])
    func corridorFits(scenarioIndex: Int) {
        let expected = Self.fixture.cases[scenarioIndex]
        let settings = Self.settings(expected.settings)
        var worst = FitDivergence()
        for (index, call) in expected.curves.enumerated() {
            let curve = OverlapLanes.smoothCorridorCurve(
                Self.coordinates(call.input), settings: settings)
            worst.merge(
                Self.compare(curve, call.output, label: "\(expected.label) curve \(index)"))
        }
        #expect(expected.curves.count > 10, "\(expected.label): real corridors to fit")
        let summary =
            "pts \(worst.points), cum \(worst.cum), dirs \(worst.dirs), "
            + "scalars \(worst.scalars)"
        #expect(
            worst.points <= Self.pointsUlpCeiling,
            "\(expected.label) worst fitted ULP: \(summary)")
    }

    /// Adversarial fits: every combination of the four fit-curve sliders over
    /// corridor lines, two degenerate shapes, and whole railway alignments —
    /// the last of which are the only inputs that reach the circular-arc
    /// fallback, and they reach it at the default settings.
    @Test("the fit's fallbacks and rejections", arguments: [0, 1])
    func fitProbes(scenarioIndex: Int) {
        let expected = Self.fixture.cases[scenarioIndex]
        var fitTypes: [String: Int] = [:]
        var rejected = 0
        var worst = FitDivergence()
        for probe in expected.probes {
            let curve = OverlapLanes.smoothCorridorCurve(
                Self.coordinates(probe.input), settings: Self.settings(probe.settings))
            worst.merge(
                Self.compare(
                    curve, probe.output, label: "\(expected.label) probe \(probe.label)"))
            if let output = probe.output {
                fitTypes[output.fitType, default: 0] += 1
            } else {
                rejected += 1
            }
        }
        // The branch-coverage claim, checked rather than asserted in prose.
        #expect(fitTypes["cubic-bspline-c2"] ?? 0 > 0, "\(expected.label): the B-spline path")
        #expect(
            fitTypes["circular-arc"] ?? 0 > 0,
            "\(expected.label): the circular-arc fallback must be reached")
        #expect(rejected > 0, "\(expected.label): the hard-validation rejection must be reached")
        let summary =
            "pts \(worst.points), cum \(worst.cum), dirs \(worst.dirs), "
            + "scalars \(worst.scalars)"
        #expect(
            worst.points <= Self.pointsUlpCeiling,
            "\(expected.label) worst probe ULP: \(summary)")
    }


    // MARK: - the measurements the port rests on

    /// `Math.cos` against the platform's, over the latitudes this file actually
    /// projects at.
    ///
    /// `PORTING.md` says to measure rather than assume, and this is the
    /// measurement for the lane machinery: every shift axis, every
    /// near-parallel separation and every snap cell is scaled by one of these
    /// cosines, and each of them feeds a comparison that decides a lane.
    @Test("V8's cos and the platform's, over this file's own latitudes")
    func cosineDivergence() {
        var latitudes: [Double] = []
        for scenario in Self.scenarios {
            for lines in scenario.lines {
                for line in lines {
                    for point in line.orig { latitudes.append(point.lat) }
                }
            }
        }
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
        // Not an assertion about a threshold — a record of what was measured,
        // so the choice of JSMath over the platform is evidence rather than
        // habit. It answered 308 of 9,942 (3.1 %), worst 1 ULP.
        //
        // And the consequence was measured too, by swapping the whole file
        // over to the platform's functions and re-running this suite:
        //
        //   Foundation.cos    6 corridor run shift axes and 1 fitted curve's
        //                     cos(latitude) disagree. No lane, no run boundary
        //                     and no record changes.
        //   Foundation.hypot  30+ shift axes disagree, and the fitted
        //                     arc-length tables go from 0 ULP to 5,726.
        //
        // Neither moved a ride into a different lane on this data, but both
        // move the vector the renderer translates the fan by, which is the same
        // kind of answer. `PORTING.md` records that `hypot` is the one that
        // surprises: it is wrong on about a third of real inputs.
        #expect(
            latitudes.count > 5000,
            "measured over \(latitudes.count) latitudes: \(disagreements) disagree, worst \(worst) ULP"
        )
        #expect(worst <= 1, "V8 and Darwin cos should never be more than 1 ULP apart")
    }
}
