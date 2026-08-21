import Foundation
import Testing

@testable import RailCore

/// `RailCore.Grooming` against `port-fixtures/grooming.json`.
///
/// The expected answers are whatever `rail-network.js` returns today, produced
/// by calling its exported `smoothMicroKinks` — not by a copy of it living in
/// the generator, which would only prove that the copy and this port agree.
///
/// The three helpers that choose a line's limits are *not* exported, so the
/// fixture records the limits object each case ran under. That makes the
/// contract "given exactly these limits and these coordinates, the answer is
/// this", and the derivation from a line's median station spacing is checked
/// separately, against every line of all five packages.
struct GroomingParityTests {

    // MARK: - the fixture

    struct Fixture: Decodable {
        struct Scale: Decodable {
            /// `null` is the top rung's absent ceiling — JSON cannot spell
            /// Infinity. A port that reads it as 0 sends every line in five
            /// countries to the tram thresholds.
            let maxSpacingMeters: Double?
            let edge: Double
            let turn: Double
            let deviation: Double
        }
        struct Spacing: Decodable {
            let country: String
            let lineId: String
            let medianSpacingMeters: Double
            let limitsIndex: Int
        }
        struct Input: Decodable {
            let label: String
            /// `nil` for the synthetic probes, which belong to no package.
            let country: String?
            let lineId: String?
            let medianSpacingMeters: Double?
            let ownLimitsIndex: Int?
            let coordinates: [[Double]]
        }
        struct LimitValues: Decodable {
            let edge: Double
            let turn: Double
            let deviation: Double
        }
        struct Case: Decodable {
            let note: String
            /// Index into `inputs`; several cases share one geometry.
            let input: Int
            /// The rung this case's limits came from, or -1 for a bespoke
            /// probe. Informational — `limits` is what was actually passed.
            let limitsIndex: Int
            /// `nil` means the JavaScript was handed no limits at all and fell
            /// back to the trunk rung.
            let limits: LimitValues?
            /// `nil` means no set was passed; `[]` means an empty one.
            let protectedIndices: [Int]?
            let protectedKeys: [String]?
            /// Indices into the case's input coordinates. The groomer never
            /// synthesises a vertex, so its output is always a subsequence of
            /// its input; the generator asserts that when it writes this file.
            let keptIndices: [Int]
        }
        struct SyntheticSpacing: Decodable {
            let note: String
            let segmentKilometres: [Double]
            let medianSpacingMeters: Double
            let limitsIndex: Int
        }
        let scales: [Scale]
        let spikeMinTurnDegrees: Double
        let spacings: [Spacing]
        let syntheticSpacings: [SyntheticSpacing]
        let inputs: [Input]
        let cases: [Case]
    }

    static func load() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "grooming.json")
    }

    // MARK: - the ladder

    @Test("the scale ladder is the same ladder, rung for rung and in order")
    func ladder() throws {
        let fixture = try Self.load()
        #expect(fixture.scales.count == Grooming.microKinkScales.count)
        for (index, expected) in fixture.scales.enumerated()
        where index < Grooming.microKinkScales.count {
            let rung = Grooming.microKinkScales[index]
            // Order is the rule, not a presentation detail: the lookup returns
            // the FIRST rung whose ceiling the spacing fits under, so a port
            // that sorts these differently answers differently.
            #expect(
                rung.maxSpacingMeters.bitPattern
                    == (expected.maxSpacingMeters ?? .infinity).bitPattern,
                "rung \(index) ceiling"
            )
            #expect(rung.edge.bitPattern == expected.edge.bitPattern)
            #expect(rung.turn.bitPattern == expected.turn.bitPattern)
            #expect(rung.deviation.bitPattern == expected.deviation.bitPattern)
        }
        #expect(Grooming.spikeMinTurnDegrees == fixture.spikeMinTurnDegrees)
        #expect(Grooming.defaultMicroKink == Grooming.microKinkScales.last)
    }

    /// Every line of all five packages, because this is the part of the
    /// machinery whose real inputs span the whole ladder: the shipped packages
    /// run from a 169 m tram spacing to a 46 km high-speed hop, and a line that
    /// lands one rung off is groomed with thresholds meant for a different kind
    /// of railway.
    @Test("median station spacing, and the rung it selects, match for every line")
    func spacingSelectsTheSameRung() throws {
        let fixture = try Self.load()
        #expect(fixture.spacings.count > 700)

        var byCountry: [String: [String: CompactPackage.Line]] = [:]
        for country in PortFixtures.countries {
            let package = try PortFixtures.package(country: country)
            byCountry[country] = Dictionary(
                package.lines.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        }

        var rungCounts: [Int: Int] = [:]
        for item in fixture.spacings {
            let line = try #require(
                byCountry[item.country]?[item.lineId],
                "\(item.country) package has no line \(item.lineId)")
            let meters = Grooming.medianSpacingMeters(line)
            #expect(
                meters.bitPattern == item.medianSpacingMeters.bitPattern,
                "\(item.lineId): median spacing \(meters) vs \(item.medianSpacingMeters)"
            )
            #expect(
                Grooming.microKinkLimits(for: line)
                    == Grooming.microKinkScales[item.limitsIndex],
                "\(item.lineId) at \(meters) m belongs on rung \(item.limitsIndex)"
            )
            rungCounts[item.limitsIndex, default: 0] += 1
        }
        // All three rungs carry real lines. If one ever empties, the fixture
        // has stopped covering the range even though every case still passes.
        for rung in 0..<Grooming.microKinkScales.count {
            #expect((rungCounts[rung] ?? 0) > 10, "rung \(rung) is barely populated")
        }
    }

    /// The two rules of the ladder that real data cannot reach.
    ///
    /// Both are measured facts about the shipped packages, not guesses: no line
    /// in five countries carries a zero-length segment, and none has a median
    /// spacing of exactly 700 or 1600 m — the nearest are 698 and 701. So the
    /// `> 0` filter and the ceiling's inclusive `<=` are invisible to every
    /// real line, and a port that got either wrong passed the test above.
    @Test("the ladder's unreachable rules: zero-length segments and exact ceilings")
    func syntheticSpacings() throws {
        let fixture = try Self.load()
        #expect(fixture.syntheticSpacings.count >= 8)

        for item in fixture.syntheticSpacings {
            let meters = Grooming.medianSpacingMeters(
                segmentKilometres: item.segmentKilometres)
            #expect(
                meters.bitPattern == item.medianSpacingMeters.bitPattern,
                "\(item.note): \(meters) vs \(item.medianSpacingMeters)"
            )
            #expect(
                Grooming.microKinkLimits(medianSpacingMeters: meters)
                    == Grooming.microKinkScales[item.limitsIndex],
                "\(item.note): \(meters) m belongs on rung \(item.limitsIndex)"
            )
        }
    }

    // MARK: - the groomer

    @Test("grooming keeps exactly the same vertices, bit for bit")
    func grooming() throws {
        let fixture = try Self.load()
        #expect(fixture.cases.count > 200)

        for item in fixture.cases {
            let input = fixture.inputs[item.input]
            let coordinates = input.coordinates.compactMap(Coordinate.init(pair:))
            #expect(coordinates.count == input.coordinates.count, "\(input.label) decoded")

            let limits = item.limits.map {
                // The ceiling is irrelevant to the groomer — only edge, turn
                // and deviation are read — so a rung is reconstructed with an
                // unbounded one rather than guessed at.
                Grooming.Limits(
                    maxSpacingMeters: .infinity,
                    edge: $0.edge, turn: $0.turn, deviation: $0.deviation)
            }
            let protectedKeys = item.protectedIndices.map { indices in
                Set(indices.map { Grooming.coordinateKey(coordinates[$0]) })
            }

            let groomed = Grooming.smoothMicroKinks(
                coordinates, limits: limits, protectedKeys: protectedKeys)

            // Vertex count first, and separately: a port that drops or keeps
            // one extra vertex has drawn a different polyline, and saying so in
            // those words is more useful than an index-out-of-range further
            // down.
            #expect(
                groomed.count == item.keptIndices.count,
                """
                \(item.note): kept \(groomed.count) of \(coordinates.count), \
                JavaScript kept \(item.keptIndices.count)
                """
            )
            for (position, index) in item.keptIndices.enumerated()
            where position < groomed.count {
                let expected = coordinates[index]
                #expect(
                    groomed[position].lon.bitPattern == expected.lon.bitPattern
                        && groomed[position].lat.bitPattern == expected.lat.bitPattern,
                    "\(item.note): vertex \(position) should be input[\(index)]"
                )
            }
        }
    }

    /// The half of the contract that is about identity rather than geometry.
    ///
    /// `rail-network.js` keys a protected vertex on the RAW coordinate,
    /// `"\(lon),\(lat)"`, where `app-coords.js` quantises to the 5-decimal grid
    /// first. The packages carry six decimals, so the two disagree on most real
    /// vertices — and a port that reaches for the quantised key protects a set
    /// of points that mostly do not exist on the line it is grooming.
    @Test("protected keys are spelled from the raw coordinate, the JavaScript way")
    func protectedKeySpelling() throws {
        let fixture = try Self.load()
        var checked = 0
        var wouldDifferUnderQuantisation = 0

        for item in fixture.cases {
            guard let indices = item.protectedIndices, let expected = item.protectedKeys
            else { continue }
            let coordinates = fixture.inputs[item.input].coordinates.compactMap(
                Coordinate.init(pair:))
            var built: Set<String> = []
            for index in indices {
                let key = Grooming.coordinateKey(coordinates[index])
                built.insert(key)
                if key != Grid.coordKey(coordinates[index]) {
                    wouldDifferUnderQuantisation += 1
                }
                checked += 1
            }
            #expect(built == Set(expected), "\(item.note): protected key spelling")
        }

        #expect(checked > 100, "only \(checked) protected keys in the fixture")
        // Not a property of the port — a measurement of the fixture, kept so
        // that "these two key functions are interchangeable" can never quietly
        // become true of the cases here without someone noticing.
        #expect(
            wouldDifferUnderQuantisation > checked / 2,
            """
            \(wouldDifferUnderQuantisation)/\(checked) protected keys differ from the \
            quantised spelling — the distinction has stopped being testable
            """
        )
    }

    /// The fixture's own coverage, asserted rather than trusted.
    ///
    /// Everything above would still pass on a fixture that had quietly decayed
    /// into cases where nothing is groomed and nothing is protected — which is
    /// the failure mode a golden file has. These are the properties that make
    /// the cases worth running.
    @Test("the cases still cover grooming, protection and both empty-set shapes")
    func coverage() throws {
        let fixture = try Self.load()

        var groomedSomething = 0
        var emptyProtection = 0
        var missingProtection = 0
        var populatedProtection = 0
        var protectionChangedTheAnswer = 0

        // The de-duplicated length, which every case reaches no matter what its
        // limits say. Counting against the raw length would score the station
        // seams as grooming and hide a fixture with no barbs left in it.
        func dedupedCount(_ coordinates: [[Double]]) -> Int {
            var count = 0
            var last: [Double]?
            for point in coordinates where !(last?[0] == point[0] && last?[1] == point[1]) {
                count += 1
                last = point
            }
            return count
        }

        var unprotected: [Int: [Int]] = [:]  // input index → answer at rung
        for item in fixture.cases where item.protectedIndices?.isEmpty == true {
            unprotected[item.input * 10 + max(item.limitsIndex, 0)] = item.keptIndices
        }

        for item in fixture.cases {
            let coordinates = fixture.inputs[item.input].coordinates
            if item.keptIndices.count < dedupedCount(coordinates) { groomedSomething += 1 }
            switch item.protectedIndices?.count {
            case nil: missingProtection += 1
            case 0: emptyProtection += 1
            default:
                populatedProtection += 1
                let key = item.input * 10 + max(item.limitsIndex, 0)
                if let base = unprotected[key], base != item.keptIndices {
                    protectionChangedTheAnswer += 1
                }
            }
        }

        #expect(groomedSomething > 50, "only \(groomedSomething) cases remove a vertex")
        #expect(emptyProtection > 100, "empty protected sets")
        #expect(missingProtection > 0, "no case passes a missing protected set")
        #expect(populatedProtection > 30, "populated protected sets")
        // The one that matters: a populated set whose answer equals the
        // unprotected answer proves nothing about which vertices are
        // untouchable, and that is exactly the part a port gets silently wrong.
        #expect(
            protectionChangedTheAnswer > 20,
            "only \(protectionChangedTheAnswer) cases where protection changes the answer"
        )

        // And that the synthetic probes are still here. They are the only cases
        // that sit exactly on `shortEdge <= edge` and `deflection >= turn`; real
        // geometry never lands on a threshold, so without them a port that
        // wrote `<` for `<=` passes everything.
        let probes = fixture.inputs.filter { $0.country == nil }
        #expect(probes.count >= 10, "\(probes.count) synthetic probes")
    }
}
