import Foundation
import Testing

@testable import RailCore

/// `RailCore.DisplayParts` against `port-fixtures/display-parts.json`.
///
/// The expected answers are whatever `rail-network.js` returns today, produced
/// by calling its exported `displayPartsForLine` and
/// `continuousCoordinatesForLine`.
///
/// ── what is checked, and to what standard ────────────────────────────────
///
/// Every line of all five packages — 804 of them, 437,725 output vertices —
/// is run. The output splits into two kinds of vertex, and they are held to
/// different standards on purpose:
///
///   * **Copied vertices (98.55%).** Everything after the station-approach
///     pass only selects, trims and drops, so almost every vertex the map
///     draws is a vertex the package handed over. A copy that differs is a
///     port bug and nothing else, so these are pinned bit for bit — by
///     `verbatimDigest`, an FNV-1a over 64-bit words that mixes each vertex's
///     index as well as its two doubles. `(h ^ w) &* prime` is a bijection on
///     `UInt64`, so a single changed word necessarily changes the digest; the
///     digest is a *smaller* check than storing the coordinates, not a weaker
///     one, and storing all 437,725 would be a ~10 MB fixture.
///
///   * **Computed vertices (1.45%: 6,346 on 76 lines).**
///     `nearestCutOnPath` interpolates where the alignment passes a platform
///     and `warpTipToAnchor` blends a run of vertices onto the anchor. Both
///     run on cumulative `distanceMeters`, which contains `Math.cos` — and V8
///     does not call the platform's `cos`, it ships its own fdlibm port. Over
///     the 60,001 real latitudes in these packages the two disagree by one ULP
///     on 3.2% of them. So these vertices carry a **measured ULP ceiling**
///     rather than bit equality, in the manner of
///     `FixtureParityTests.distances`.
///
/// ── and what the ceiling is NOT allowed to absorb ────────────────────────
///
/// Part counts and per-part vertex counts are exact, with no tolerance at all.
/// That is the assertion that matters, because every decision this function
/// makes is a distance compared against a threshold: a wrong answer moves a
/// stroke boundary or welds a branch to its trunk, and shows up as a different
/// part count or a different vertex count long before it shows up as a
/// different coordinate. A ULP ceiling on coordinates cannot hide any of it.
///
/// That is not hypothetical. With the platform's `hypot` in place of V8's,
/// three Japanese lines split one vertex differently — see
/// ``DisplayParts/jsHypot(_:_:)``, which is why the port reproduces V8's
/// algorithm there rather than tolerating it here.
struct DisplayPartsParityTests {

    // MARK: - the fixture

    struct Fixture: Decodable {
        struct Selection: Decodable {
            let lines: Int
            let totalOutputVertices: Int
            let multiPartLines: Int
            let storedLines: Int
            let storedVertices: Int
        }
        struct SynthesisedCount: Decodable {
            let total: Int
            let lines: Int
            let ofTotalVertices: Int
        }
        struct Case: Decodable {
            let country: String
            let lineId: String
            let name: String
            let partLengths: [Int]
            let verbatimDigest: String
            /// Flat `[partIndex, vertexIndex, lon, lat, …]`.
            let synthesised: [Double]
            let continuousLength: Int
            /// Index into `geometries`, or nil for a line pinned without its
            /// coordinates stored.
            let geometry: Int?

            var label: String { "\(country):\(lineId)" }
        }
        struct Geometry: Decodable {
            let label: String
            /// One flat `[lon, lat, lon, lat, …]` per part.
            let parts: [[Double]]
        }
        struct Synthetic: Decodable {
            let label: String
            let note: String
            /// The branches this topology was written to reach, verified
            /// against an instrumented copy of `rail-network.js` when the
            /// fixture was written.
            let reaches: [String]
            /// The compact-v1 line itself, in exactly the shape a shipped
            /// package stores — so it decodes through the same decoder the
            /// real packages do.
            let line: CompactPackage.Line
            /// The same object read a second time for the two fields
            /// `CompactPackage.Line` does not carry.
            let topology: DisplayParts.LineTopology
            let partLengths: [Int]
            let verbatimDigest: String
            let synthesised: [Double]
            let continuousLength: Int
            let parts: [[Double]]

            enum CodingKeys: String, CodingKey {
                case label, note, reaches, line, partLengths, verbatimDigest
                case synthesised, continuousLength, parts
            }

            init(from decoder: Decoder) throws {
                let row = try decoder.container(keyedBy: CodingKeys.self)
                label = try row.decode(String.self, forKey: .label)
                note = try row.decode(String.self, forKey: .note)
                reaches = try row.decode([String].self, forKey: .reaches)
                line = try row.decode(CompactPackage.Line.self, forKey: .line)
                topology = try row.decode(DisplayParts.LineTopology.self, forKey: .line)
                partLengths = try row.decode([Int].self, forKey: .partLengths)
                verbatimDigest = try row.decode(String.self, forKey: .verbatimDigest)
                synthesised = try row.decode([Double].self, forKey: .synthesised)
                continuousLength = try row.decode(Int.self, forKey: .continuousLength)
                parts = try row.decode([[Double]].self, forKey: .parts)
            }
        }
        let geometrySelection: Selection
        let synthesisedVertices: SynthesisedCount
        /// The per-line `reversalTails` / `extraSegments`, keyed
        /// `"country:lineId"` — recorded for every line of every package that
        /// carries either, so a port cannot silently miss one.
        let topologyExtras: [String: DisplayParts.LineTopology]
        let cases: [Case]
        let geometries: [Geometry]
        let synthetic: [Synthetic]
    }

    static func load() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "display-parts.json")
    }

    // MARK: - the two standards

    /// A measured ULP budget, not a tolerance picked to make the test pass.
    ///
    /// The first run of this suite asserted bit-for-bit equality on every
    /// vertex and found 17 of 804 lines disagreeing — always in a coordinate,
    /// never in a part count or a vertex count. Two suspects were chased
    /// before the budget was accepted, and one of them was real:
    ///
    ///   1. `Math.hypot`. V8 does not call libm for it; it scales by the
    ///      largest magnitude and Kahan-sums the squares. Over 604 pairs from
    ///      this app's own coordinate range the two disagree by one ULP on 235
    ///      (39%), and that one *did* change decisions — 野田線, 小田急箱根
    ///      鉄道線 and 土讃線 each split a stroke one vertex differently. It is
    ///      plain algebra, so the port reproduces V8's algorithm exactly
    ///      (verified 604/604) rather than tolerating it. Six of the 23
    ///      original disagreements were this.
    ///
    ///   2. `Math.cos`. V8 ships its own fdlibm port rather than calling the
    ///      platform's. Over the 60,001 real latitudes in these five packages
    ///      the two disagree by one ULP on 1,927 (3.2%). That is not
    ///      reproducible without shipping fdlibm, which is a far bigger
    ///      decision than one function's port, so it is measured instead.
    ///
    /// The residue reaches only the 1.45% of vertices the approach pass
    /// computes, and a coordinate ULP at these magnitudes is about 2 × 10⁻⁹ m
    /// on the ground — nine orders of magnitude below the tightest threshold
    /// anything here decides with (the 1 m `anchorOnTrackMeters` test). A
    /// relative epsilon loose enough to absorb a libm difference would also
    /// absorb a wrong constant or a reassociated term; this ceiling cannot.
    ///
    /// Measured: the worst disagreement across all 6,346 computed vertices is
    /// **4 ULP**, on tw-krtc-r (高雄捷運紅線) part 0 vertex 165 — a latitude of
    /// 22.677946177640084 answered as 22.6779461776401. Four ULP of latitude
    /// there is 3 × 10⁻⁹ m on the ground: nine orders of magnitude below the
    /// tightest threshold anything in this file decides with (the 1 m
    /// `anchorOnTrackMeters` test), and twelve below the 35 m retrace radius.
    ///
    /// If it ever fails, the answer moved for a reason that is not the math
    /// library, and the diff is a real behavioural change.
    static let ulpCeiling: Int64 = 4

    /// The share of computed vertices allowed to be inexact at all.
    ///
    /// Measured at 131 of 6,346 — 2.06% — which is itself a signal worth
    /// pinning: a port change that pushes it up is changing the arithmetic
    /// even while staying inside the ULP ceiling. Note how much smaller it is
    /// than the 3.2% of latitudes where the two `cos` implementations differ:
    /// most of those differences are absorbed before they reach a coordinate.
    static let inexactShareCeiling = 0.04

    /// FNV-1a over 64-bit words, mirroring the generator exactly: each part
    /// mixes its vertex count, then each COPIED vertex mixes its index and the
    /// IEEE-754 bit patterns of its lon and lat. Computed vertices are skipped
    /// here and checked against `synthesised` instead.
    ///
    /// `&*` is deliberate — this is modular arithmetic, and a trapping `*`
    /// would crash on the first case.
    static func verbatimDigest(
        _ parts: [[Coordinate]], computed: [Int: Set<Int>]
    ) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        func mix(_ word: UInt64) { hash = (hash ^ word) &* 0x0000_0100_0000_01b3 }
        for (partIndex, part) in parts.enumerated() {
            mix(UInt64(part.count))
            let skip = computed[partIndex] ?? []
            for (index, point) in part.enumerated() where !skip.contains(index) {
                mix(UInt64(index))
                mix(point.lon.bitPattern)
                mix(point.lat.bitPattern)
            }
        }
        let hex = String(hash, radix: 16)
        return "0x" + String(repeating: "0", count: 16 - hex.count) + hex
    }

    /// `[partIndex, vertexIndex, lon, lat, …]` → positions, and the expected
    /// coordinate at each.
    static func computedVertices(_ flat: [Double]) -> (
        positions: [Int: Set<Int>], expected: [Int: [Int: Coordinate]]
    ) {
        var positions: [Int: Set<Int>] = [:]
        var expected: [Int: [Int: Coordinate]] = [:]
        var cursor = 0
        while cursor + 3 < flat.count {
            let part = Int(flat[cursor])
            let vertex = Int(flat[cursor + 1])
            positions[part, default: []].insert(vertex)
            expected[part, default: [:]][vertex] = Coordinate(
                lon: flat[cursor + 2], lat: flat[cursor + 3])
            cursor += 4
        }
        return (positions, expected)
    }

    /// `[lon, lat, lon, lat, …]` back into coordinates.
    static func unflatten(_ flat: [Double]) -> [Coordinate] {
        stride(from: 0, to: flat.count - 1, by: 2)
            .map { Coordinate(lon: flat[$0], lat: flat[$0 + 1]) }
    }

    /// What one line's comparison produced: the disagreements that are real,
    /// and the arithmetic residue that is measured rather than asserted away.
    struct Tally {
        var failures: [String] = []
        var comparedComputed = 0
        var inexactComputed = 0
        var worstULP: Int64 = 0
        var worstCase = ""

        mutating func absorb(_ other: Tally) {
            failures += other.failures
            comparedComputed += other.comparedComputed
            inexactComputed += other.inexactComputed
            if other.worstULP > worstULP {
                worstULP = other.worstULP
                worstCase = other.worstCase
            }
        }
    }

    /// Checks one line's parts against one fixture row.
    ///
    /// Structure first and without tolerance; then the copied vertices as one
    /// digest; then the computed vertices one at a time, in ULP.
    static func check(
        _ parts: [[Coordinate]], label: String, name: String,
        partLengths: [Int], expectedDigest: String, synthesised: [Double]
    ) -> Tally {
        var tally = Tally()
        guard parts.map(\.count) == partLengths else {
            tally.failures.append(
                "\(label) (\(name)): \(parts.count) parts \(parts.map(\.count)) "
                    + "vs \(partLengths.count) parts \(partLengths)")
            return tally
        }
        let (positions, expected) = computedVertices(synthesised)
        let digest = verbatimDigest(parts, computed: positions)
        if digest != expectedDigest {
            tally.failures.append(
                "\(label) (\(name)): a COPIED vertex differs — verbatim digest "
                    + "\(digest) vs \(expectedDigest)")
        }
        for (partIndex, byVertex) in expected {
            for (vertexIndex, want) in byVertex {
                let got = parts[partIndex][vertexIndex]
                tally.comparedComputed += 1
                let lonULP = got.lon.ulpDistance(to: want.lon)
                let latULP = got.lat.ulpDistance(to: want.lat)
                let worst = Swift.max(lonULP, latULP)
                if worst == 0 { continue }
                tally.inexactComputed += 1
                if worst > tally.worstULP {
                    tally.worstULP = worst
                    tally.worstCase =
                        "\(label) part \(partIndex) vertex \(vertexIndex): "
                        + "(\(got.lon), \(got.lat)) vs (\(want.lon), \(want.lat))"
                }
            }
        }
        return tally
    }

    // MARK: - every line of every package

    @Test("every line of all five packages emits the same strokes")
    func everyLine() throws {
        let fixture = try Self.load()
        #expect(fixture.cases.count == 804)
        #expect(fixture.geometrySelection.lines == fixture.cases.count)

        var linesByCountry: [String: [String: CompactPackage.Line]] = [:]
        for country in PortFixtures.countries {
            let package = try PortFixtures.package(country: country)
            linesByCountry[country] = Dictionary(
                package.lines.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        }

        var total = Tally()
        var multiPart = 0
        var totalVertices = 0
        var computedVertices = 0

        for item in fixture.cases {
            let line = try #require(
                linesByCountry[item.country]?[item.lineId],
                "\(item.country) package has no line \(item.lineId)")
            let topology = fixture.topologyExtras[item.label] ?? DisplayParts.LineTopology()
            let parts = DisplayParts.parts(for: line, topology: topology)

            if item.partLengths.count > 1 { multiPart += 1 }
            totalVertices += item.partLengths.reduce(0, +)
            computedVertices += item.synthesised.count / 4

            total.absorb(
                Self.check(
                    parts, label: item.label, name: item.name,
                    partLengths: item.partLengths, expectedDigest: item.verbatimDigest,
                    synthesised: item.synthesised))

            // The wrapper: one part is returned as itself, several are
            // concatenated. Checked against the port's OWN parts so this says
            // something about `continuousCoordinates` rather than repeating
            // what the parts check already said.
            let continuous = DisplayParts.continuousCoordinates(for: line, topology: topology)
            let flattened = parts.flatMap { $0 }
            if continuous.count != item.continuousLength || continuous != flattened {
                total.failures.append(
                    "\(item.label): continuousCoordinates is \(continuous.count) vertices, "
                        + "fixture says \(item.continuousLength), own parts flatten to "
                        + "\(flattened.count)")
            }
        }

        let report = total.failures.prefix(40).joined(separator: "\n")
        #expect(
            total.failures.isEmpty,
            "\(total.failures.count) disagreement(s):\n\(report)")

        // The measured residue. Both numbers are assertions about the
        // ARITHMETIC, not about the answers: the answers are the part lengths
        // and the digest above, and those carry no tolerance.
        #expect(
            total.worstULP <= Self.ulpCeiling,
            "worst computed-vertex disagreement \(total.worstULP) ULP: \(total.worstCase)")
        #expect(total.comparedComputed == fixture.synthesisedVertices.total)
        #expect(
            Double(total.inexactComputed) / Double(Swift.max(total.comparedComputed, 1))
                < Self.inexactShareCeiling,
            "\(total.inexactComputed)/\(total.comparedComputed) computed vertices inexact"
        )

        // The coverage this file claims, asserted rather than described: if a
        // package rebuild ever pre-splits the last branch line, every case
        // still passes while the branch machinery stops being exercised by
        // real data at all — and this is the only place that would say so.
        #expect(multiPart == fixture.geometrySelection.multiPartLines)
        #expect(multiPart >= 20, "no real line splits any more; the branch rules are untested")
        #expect(totalVertices == fixture.geometrySelection.totalOutputVertices)
        #expect(computedVertices == fixture.synthesisedVertices.total)
    }

    /// The 97 lines whose coordinates are stored, compared vertex by vertex.
    ///
    /// Every multi-part line is in here unconditionally, plus Macao and Hong
    /// Kong entire, plus every line `rail-network.js` argues from by name
    /// (阪和線 at 鳳, 成田線, 会津線, 紀勢線 at 亀山, 五能線 at 東八森, the
    /// paired up/down alignments, the loops that close through the seam), plus
    /// a reproducible stride through the rest. This buys diagnosability: a
    /// digest says THAT a line moved, and this says WHERE.
    @Test("stored geometries agree vertex for vertex")
    func storedGeometries() throws {
        let fixture = try Self.load()
        #expect(fixture.geometries.count == fixture.geometrySelection.storedLines)
        #expect(fixture.geometries.count >= 90)

        var byLabel: [String: Fixture.Case] = [:]
        for item in fixture.cases { byLabel[item.label] = item }

        var checkedVertices = 0
        var worstULP: Int64 = 0
        for (index, stored) in fixture.geometries.enumerated() {
            let item = try #require(byLabel[stored.label], "no case for \(stored.label)")
            #expect(item.geometry == index, "\(stored.label) points at the wrong geometry")
            let line = try #require(
                PortFixtures.package(country: item.country).lines.first { $0.id == item.lineId })
            let topology = fixture.topologyExtras[item.label] ?? DisplayParts.LineTopology()
            let parts = DisplayParts.parts(for: line, topology: topology)
            let (positions, _) = Self.computedVertices(item.synthesised)

            guard parts.count == stored.parts.count else {
                Issue.record("\(stored.label): \(parts.count) parts vs \(stored.parts.count)")
                continue
            }
            for (partIndex, flat) in stored.parts.enumerated() {
                let expected = Self.unflatten(flat)
                let actual = parts[partIndex]
                guard actual.count == expected.count else {
                    Issue.record(
                        "\(stored.label) part \(partIndex): \(actual.count) vertices vs \(expected.count)"
                    )
                    continue
                }
                let computed = positions[partIndex] ?? []
                for vertex in actual.indices {
                    let lonULP = actual[vertex].lon.ulpDistance(to: expected[vertex].lon)
                    let latULP = actual[vertex].lat.ulpDistance(to: expected[vertex].lat)
                    let worst = Swift.max(lonULP, latULP)
                    if worst == 0 { continue }
                    // A COPIED vertex has no budget at all: it is a copy, so
                    // anything but bit equality is a port bug.
                    let ceiling: Int64 = computed.contains(vertex) ? Self.ulpCeiling : 0
                    if worst > ceiling {
                        Issue.record(
                            """
                            \(stored.label) part \(partIndex) vertex \(vertex) \
                            (\(computed.contains(vertex) ? "computed" : "copied")): \
                            (\(actual[vertex].lon), \(actual[vertex].lat)) vs \
                            (\(expected[vertex].lon), \(expected[vertex].lat)) — \(worst) ULP
                            """
                        )
                        break
                    }
                    worstULP = Swift.max(worstULP, worst)
                }
                checkedVertices += expected.count
            }
        }
        #expect(checkedVertices == fixture.geometrySelection.storedVertices)
        #expect(worstULP <= Self.ulpCeiling)
    }

    // MARK: - the branches real data cannot reach

    /// Eight hand-built topologies, each written for one branch that the
    /// shipped packages never take.
    ///
    /// Their coordinates are invented; their SHAPES are the ones the
    /// JavaScript's comments argue from — a spur the station order walked out
    /// to and came back from (室蘭線's 本輪西 → 輪西 → 東室蘭), a branch
    /// leaving from a platform rather than from open track (阪和線 opening a
    /// part at 鳳 to reach 東羽衣), a station order that jumps back across the
    /// line (室蘭線's 岩見沢 → 御崎, 138 km down its own main line).
    ///
    /// All eight are laid out on a 0.005° grid, and none of them produces a
    /// computed vertex — so unlike the real packages, these are checked bit
    /// for bit with no ULP budget whatsoever.
    @Test("the synthetic topologies reproduce every unreachable branch")
    func synthetic() throws {
        let fixture = try Self.load()
        #expect(fixture.synthetic.count >= 8)

        var reached = Set<String>()
        for item in fixture.synthetic {
            reached.formUnion(item.reaches)
            let parts = DisplayParts.parts(for: item.line, topology: item.topology)
            let tally = Self.check(
                parts, label: item.label, name: item.note, partLengths: item.partLengths,
                expectedDigest: item.verbatimDigest, synthesised: item.synthesised)
            #expect(tally.failures.isEmpty, "\(tally.failures.joined(separator: "\n"))")
            #expect(tally.worstULP == 0, "\(item.label) should be exact: \(tally.worstCase)")
            guard parts.map(\.count) == item.partLengths else { continue }

            for (partIndex, flat) in item.parts.enumerated() {
                let expected = Self.unflatten(flat)
                for vertex in expected.indices
                where parts[partIndex][vertex] != expected[vertex] {
                    Issue.record(
                        """
                        \(item.label) part \(partIndex) vertex \(vertex): \
                        (\(parts[partIndex][vertex].lon), \(parts[partIndex][vertex].lat)) \
                        vs (\(expected[vertex].lon), \(expected[vertex].lat))
                        """
                    )
                    break
                }
            }
            let continuous = DisplayParts.continuousCoordinates(
                for: item.line, topology: item.topology)
            #expect(continuous.count == item.continuousLength, "\(item.label) continuous")
            #expect(continuous == parts.flatMap { $0 }, "\(item.label) continuous")
        }

        // Named individually so that deleting a synthetic case is a failure
        // rather than a quietly smaller suite.
        for branch in [
            "excursion split",
            "cut vertex overwritten (not a platform anchor)",
            "cut vertex appended (platform anchor)",
            "retrace onto a closed part",
            "pure-duplicate interval skipped",
            "lost station anchor restored",
            "lost station anchor too far to restore",
            "empty-groomed fallback",
            "reversalTails protection",
            "extraSegmentParts draws a stroke",
            "anchor displacement over the 250 m ceiling",
        ] {
            #expect(reached.contains(branch), "no synthetic case reaches: \(branch)")
        }
    }

    /// A three-part line is the shape the whole function exists for: a trunk,
    /// a stroke that reverses off it, and a branch re-served from the station
    /// the order jumped back to. No shipped line produces one today, so this
    /// asserts the synthetic one still does.
    @Test("a station order that jumps back across the line still emits three strokes")
    func threeStrokes() throws {
        let fixture = try Self.load()
        let item = try #require(
            fixture.synthetic.first { $0.label == "synthetic:retrace-onto-closed-part" })
        let parts = DisplayParts.parts(for: item.line, topology: item.topology)
        #expect(parts.count == 3)
        // Every stroke begins and ends on a platform anchor: that is the
        // contract that makes a branch sliceable, and the reason a lead-in is
        // walked back to a station rather than cut at the switch.
        let anchors = Set(item.line.stations.map { Grooming.coordinateKey($0.coordinate) })
        for (index, part) in parts.enumerated() {
            #expect(
                anchors.contains(Grooming.coordinateKey(part[0])),
                "part \(index) does not start on a platform")
            #expect(
                anchors.contains(Grooming.coordinateKey(part[part.count - 1])),
                "part \(index) does not end on a platform")
        }
    }

    // MARK: - the primitives the tolerance rests on

    /// `Math.hypot` is reproduced exactly, and that is load-bearing.
    ///
    /// This is the primitive that was NOT tolerated, because a one-ULP
    /// difference in it moved a stroke boundary on three real lines. The
    /// property asserted here is the one the algorithm gives: scaling by the
    /// largest magnitude makes the sum of squares exact for the trivial cases
    /// and immune to overflow for the extreme ones.
    @Test("jsHypot reproduces V8's scaled Kahan sum")
    func hypot() {
        // Exact cases every implementation must agree on, so a port that
        // mis-transcribed the scaling shows up immediately.
        #expect(DisplayParts.jsHypot(3, 4) == 5)
        #expect(DisplayParts.jsHypot(0, 0) == 0)
        #expect(DisplayParts.jsHypot(0, -7) == 7)
        #expect(DisplayParts.jsHypot(-7, 0) == 7)
        // Scaling is what keeps these finite; a naive a*a + b*b overflows the
        // first and flushes the second to zero.
        #expect(DisplayParts.jsHypot(1e200, 1e200).isFinite)
        #expect(DisplayParts.jsHypot(1e-200, 1e-200) > 0)
        // JavaScript answers Infinity even when the other argument is NaN.
        #expect(DisplayParts.jsHypot(.infinity, .nan) == .infinity)
        #expect(DisplayParts.jsHypot(.nan, 1).isNaN)
    }

    // MARK: - the fields CompactPackage does not carry

    /// `reversalTails` and `extraSegments` read straight out of the shipped
    /// packages must find exactly the set the generator found in JavaScript.
    ///
    /// Three lines in five countries carry either — 阿里山線's reversal tails
    /// and 輕鐵 505 / 751's extra segments — and the one with reversal tails is
    /// the one whose grooming needs thirteen passes to reach stability. A
    /// loader that quietly returned nothing would leave every real line
    /// passing and 阿里山's switchback tails groomed away.
    @Test("the topology loader finds the same reversalTails and extraSegments")
    func topologyLoader() throws {
        let fixture = try Self.load()
        let root = try PortFixtures.repositoryRoot()
        var found: [String: DisplayParts.LineTopology] = [:]
        for country in PortFixtures.countries {
            let url = root.appending(path: "app/public/rail/\(country)-2025.json")
            for (id, topology) in try DisplayParts.LineTopology.byLineID(contentsOf: url) {
                found["\(country):\(id)"] = topology
            }
        }
        #expect(Set(found.keys) == Set(fixture.topologyExtras.keys))
        for (label, expected) in fixture.topologyExtras {
            let actual = try #require(found[label])
            #expect(actual.reversalTails.count == expected.reversalTails.count, "\(label)")
            for index in expected.reversalTails.indices where index < actual.reversalTails.count {
                #expect(actual.reversalTails[index] == expected.reversalTails[index], "\(label)")
            }
            #expect(actual.extraSegments.count == expected.extraSegments.count, "\(label)")
            for index in expected.extraSegments.indices where index < actual.extraSegments.count {
                #expect(actual.extraSegments[index].from == expected.extraSegments[index].from)
                #expect(actual.extraSegments[index].to == expected.extraSegments[index].to)
                // Every shipped row is a documented data gap carrying no
                // geometry, so `extraSegmentParts` draws nothing today. If a
                // package ever ships one WITH geometry this flips, and the
                // synthetic case above is what proves the drawing path works.
                #expect(actual.extraSegments[index].geometry == nil, "\(label)")
            }
        }
        #expect(fixture.topologyExtras.keys.contains("tw:tw-alsr-alishan"))
    }
}
