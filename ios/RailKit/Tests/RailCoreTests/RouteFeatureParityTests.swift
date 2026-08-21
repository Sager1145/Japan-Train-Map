import Foundation
import Testing

@testable import RailCore

/// `canonicalizeRouteFeature` against the JavaScript that produced it.
///
/// The expected values in `port-fixtures/route-feature.json` are whatever
/// `rail-network.js` returns today. A failure here says this Swift disagrees
/// with the web app about where a ride is drawn — and since the drawn ride is
/// an exact slice of the all-railways geometry, a disagreement is not a
/// rounding difference in a number nobody looks at. It is a train drawn on a
/// different railway, or a right-angle chord swung into a station.
///
/// Geometry is compared **bit for bit**, vertex counts included. The slice is
/// made of copied vertices and two interpolated endpoints, so anything less
/// than exact equality would be hiding a decision that went the other way.
struct RouteFeatureParityTests {

    // MARK: - fixture

    struct Fixture: Decodable {
        struct Network: Decodable {
            struct Line: Decodable {
                let lineId: String
                let name: String?
                let `operator`: String?
                let isLoop: Bool
                let alignmentDirection: String?
                let parts: [String]
            }
            let key: String
            let country: String
            /// True where the trimmed network IS the country's whole network,
            /// which is the case that needs no argument at all.
            let complete: Bool
            let lines: [Line]
        }
        struct Hints: Decodable {
            let requiredLineNames: [String?]
            let preferredLineNames: [String?]
            let usedLineNames: [String]
            let requiredOperatorNames: [String?]
            let preferredOperatorNames: [String?]
            let usedOperatorNames: [String]
        }
        struct Feature: Decodable {
            let geometryType: String?
            let lines: [String]
            let hints: Hints
        }
        struct Expected: Decodable {
            let geometryType: String
            let lines: [String]
            let displayGeometrySource: String
            let displayLineIds: [String]
        }
        struct Case: Decodable {
            let name: String
            /// Why this case is in the fixture — the railway it is about.
            /// Quoted into failures, because "case 31 failed" is not a bug
            /// report and "the 上越線 up-line bore failed" is.
            let why: String
            let country: String
            let network: Int
            let verifiedAgainstFullNetwork: Bool
            let feature: Feature
            let continueFrom: [Double]?
            let expected: Expected?
        }
        let networks: [Network]
        let cases: [Case]
    }

    /// `"lon lat;lon lat;…"`.
    ///
    /// The fixture stores geometry as text rather than as nested arrays for
    /// size — the harness pretty-prints, and 70,000 display vertices as
    /// `[lon, lat]` pairs seven levels deep is a 9 MB file. It is exact in both
    /// directions: JavaScript prints the shortest decimal that reads back as
    /// the same double and `Double(String)` is correctly rounded, and the
    /// generator asserts the round trip on every coordinate it writes.
    static func path(_ text: String) throws -> [Coordinate] {
        if text.isEmpty { return [] }
        return try text.split(separator: ";").map { pair in
            let parts = pair.split(separator: " ")
            #expect(parts.count == 2, "malformed coordinate \(pair)")
            let lon = try #require(Double(parts[0]))
            let lat = try #require(Double(parts[1]))
            return Coordinate(lon: lon, lat: lat)
        }
    }

    static func load() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "route-feature.json")
    }

    static func network(_ row: Fixture.Network) throws -> RouteNetwork {
        RouteNetwork(
            lines: try row.lines.map { line in
                RouteNetwork.Line(
                    lineId: line.lineId,
                    name: line.name,
                    operator: line.operator,
                    isLoop: line.isLoop,
                    alignmentDirection: line.alignmentDirection,
                    parts: try line.parts.map(path)
                )
            })
    }

    static func feature(_ row: Fixture.Feature) throws -> RouteFeature {
        let lines = try row.lines.map(path)
        let geometry: RouteGeometry?
        switch row.geometryType {
        case "LineString": geometry = .lineString(lines.first ?? [])
        case "MultiLineString": geometry = .multiLineString(lines)
        default: geometry = nil
        }
        return RouteFeature(
            geometry: geometry,
            hints: RouteHints(
                requiredLineNames: row.hints.requiredLineNames,
                preferredLineNames: row.hints.preferredLineNames,
                usedLineNames: row.hints.usedLineNames,
                requiredOperatorNames: row.hints.requiredOperatorNames,
                preferredOperatorNames: row.hints.preferredOperatorNames,
                usedOperatorNames: row.hints.usedOperatorNames
            ))
    }

    // MARK: - the parity run

    @Test("every drawn ride is the same slice, vertex for vertex")
    func drawnGeometry() throws {
        let fixture = try Self.load()
        #expect(fixture.cases.count >= 40)

        var networks: [Int: RouteNetwork] = [:]
        for item in fixture.cases {
            let network = try networks[item.network] ?? {
                let built = try Self.network(fixture.networks[item.network])
                networks[item.network] = built
                return built
            }()

            // A fresh cache per case, as the generator uses: the memo is of a
            // pure function, and starting empty is what makes each frozen
            // answer independent of the case that ran before it.
            var cache = RouteProjectionCache()
            let got = network.canonicalizeRouteFeature(
                try Self.feature(item.feature),
                continueFrom: item.continueFrom.flatMap(Coordinate.init(pair:)),
                cache: &cache
            )

            guard let expected = item.expected else {
                #expect(
                    got == nil,
                    "\(item.name): the JavaScript draws nothing here — \(item.why)"
                )
                continue
            }
            guard let got else {
                Issue.record("\(item.name): drew nothing, expected a slice — \(item.why)")
                continue
            }

            #expect(
                got.displayGeometrySource == expected.displayGeometrySource,
                "\(item.name): display_geometry_source"
            )
            #expect(
                got.displayLineIds == expected.displayLineIds,
                "\(item.name): drawn on the wrong railway — \(item.why)"
            )

            switch (got.geometry, expected.geometryType) {
            case (.lineString, "LineString"), (.multiLineString, "MultiLineString"): break
            default:
                Issue.record("\(item.name): geometry type changed")
            }

            let drawn = got.geometry.lines
            #expect(drawn.count == expected.lines.count, "\(item.name): stroke count")
            for (index, text) in expected.lines.enumerated() where index < drawn.count {
                let want = try Self.path(text)
                let have = drawn[index]
                // The vertex COUNT is checked on its own because it is the
                // failure a plausible port produces: a dropped duplicate at a
                // seam, or an endpoint pinned where it should have been left on
                // its projection, changes the count before it changes anything
                // a reader would notice.
                #expect(
                    have.count == want.count,
                    "\(item.name) stroke \(index): \(have.count) vertices, expected \(want.count)"
                )
                for (vertex, coordinate) in want.enumerated() where vertex < have.count {
                    #expect(
                        have[vertex].lon.bitPattern == coordinate.lon.bitPattern
                            && have[vertex].lat.bitPattern == coordinate.lat.bitPattern,
                        "\(item.name) stroke \(index) vertex \(vertex): \(have[vertex]) vs \(coordinate)"
                    )
                }
            }
        }
    }

    /// Every case was also run against its country's COMPLETE network and gave
    /// this same answer.
    ///
    /// The fixture ships trimmed networks because the function scans
    /// `lineById` exhaustively and Japan is 652 lines of geometry. The trimming
    /// is only legitimate because each case is checked both ways before it is
    /// written, and this is where that claim is read back rather than trusted:
    /// a future regeneration that starts emitting unverified cases fails here.
    @Test("no case was frozen against a trimmed network alone")
    func verifiedAgainstCompleteNetwork() throws {
        let fixture = try Self.load()
        for item in fixture.cases {
            #expect(item.verifiedAgainstFullNetwork, "\(item.name)")
        }
    }

    /// The topologies this function exists for are actually present.
    ///
    /// Every rule in `canonicalizeRouteFeature` was written for a specific
    /// railway, and a fixture that lost one of them would keep passing while
    /// the rule it protected rotted. So the coverage is asserted, not assumed:
    /// this fails if a regeneration drops the loop lines, the split lines, the
    /// paired alignment or the cases with no answer.
    @Test("the fixture still covers the topologies the rules exist for")
    func coverage() throws {
        let fixture = try Self.load()

        let countries = Set(fixture.cases.map(\.country))
        #expect(countries == Set(PortFixtures.countries), "all five packages")

        // A closed line drawn as one part, where the slice may wrap the seam.
        let loops = fixture.networks.flatMap(\.lines).filter(\.isLoop)
        #expect(loops.count >= 3, "loop lines")

        // A line drawn as several disjoint strokes — a trunk and its branch, a
        // switchback, a reversal no train can drive through.
        let split = fixture.networks.flatMap(\.lines).filter { $0.parts.count > 1 }
        #expect(!split.isEmpty, "split lines")

        // The paired alignment with a sourced direction — the only rule in the
        // function that is not decided by geometry.
        let paired = fixture.networks.flatMap(\.lines).filter {
            $0.alignmentDirection == "up" || $0.alignmentDirection == "down"
        }
        #expect(!paired.isEmpty, "sourced paired alignments")

        // Refusing to draw is an answer. A fixture with no nulls in it cannot
        // tell a port that returns a wrong slice from one that returns none.
        #expect(fixture.cases.contains { $0.expected == nil }, "cases with no slice")

        #expect(
            fixture.cases.contains { $0.feature.geometryType == "MultiLineString" },
            "a MultiLineString hop"
        )
        #expect(fixture.cases.contains { $0.continueFrom != nil }, "chained hops")
        // The branch a fixture built only from solver output never reaches: the
        // hints resolve to nothing and every line in the network is a candidate.
        #expect(
            fixture.cases.contains {
                $0.feature.hints.usedLineNames.isEmpty
                    && $0.feature.hints.requiredLineNames.isEmpty
                    && $0.feature.hints.preferredLineNames.isEmpty
                    && $0.feature.hints.usedOperatorNames.isEmpty
                    && $0.feature.hints.requiredOperatorNames.isEmpty
                    && $0.feature.hints.preferredOperatorNames.isEmpty
            },
            "an unhinted hop"
        )
    }

    /// The interior of a drawn ride is the display line's own vertices.
    ///
    /// This is the property the whole function exists to guarantee, and it is
    /// checked here against the network rather than against the fixture's
    /// expected value — so it would still fail if the JavaScript and this port
    /// agreed on a slice that was not a slice. Only the two ends may be new:
    /// they are interpolated inside an edge, and then pinned to the solver's
    /// own station node.
    @Test("interior vertices are the complete line's, not new geometry")
    func interiorVerticesComeFromTheNetwork() throws {
        let fixture = try Self.load()
        var checked = 0
        for item in fixture.cases {
            guard let expected = item.expected else { continue }
            let row = fixture.networks[item.network]
            var vertices = Set<Coordinate>()
            for id in expected.displayLineIds {
                let line = try #require(row.lines.first { $0.lineId == id })
                for part in line.parts { for point in try Self.path(part) { vertices.insert(point) } }
            }
            for text in expected.lines {
                let drawn = try Self.path(text)
                for point in drawn.dropFirst().dropLast() {
                    #expect(
                        vertices.contains(point),
                        "\(item.name): drew a vertex that is on no display line"
                    )
                }
                checked += 1
            }
        }
        #expect(checked > 30)
    }
}

// What these cases do NOT pin, measured by mutating the Swift and watching
// which assertions moved. Recorded because an untested rule that looks tested
// is worse than one that is known not to be:
//
//   * **`continueFrom`.** Deleting the seam term entirely — scoring every
//     candidate as if no previous hop existed — passes every case here. The
//     reason is structural rather than a gap in the sample: `snapEndpoint`
//     pins each hop's drawn end to the solver's station node, and the next
//     hop's `rawStart` IS that node, so `continueFrom` equals `rawStart` in 13
//     of the 14 chained cases and the seam degenerates into weighting the
//     start endpoint twice — the same amount for every candidate. Searched
//     for a counter-example over the 220 checked-in solver hops and over every
//     station-to-station hop of every line in all five packages, about 30,000
//     in total: none of them changes its answer when `continueFrom` is
//     supplied. Whether the tie-break is reachable at all is a question for
//     the JavaScript, not for this port.
//
//   * **The 25 m ceiling on a replacement.** The wider look is exercised in
//     both directions — it runs and is taken (Macao), and it is not reached at
//     all (Hong Kong) — but the accepted replacement lands at exactly 0.0 m,
//     so any non-negative ceiling passes. Pinning 25 m needs a hop whose
//     platforms no stroke reaches within 25 m while some stroke reaches within
//     1.5 km; nothing in the shipped packages is that.
//
//   * **The order hint names are collected in.** Reversing it changes nothing
//     here: no case carries two hinted names whose lines both fit.
//
//   * **111 320 m per degree.** Replacing it with the haversine's implied
//     constant passes everything, because it scales every distance uniformly
//     and this function only ever compares distances with each other. The
//     absolute thresholds it also feeds — 60 m, 260 m, 1.5 km — are nowhere
//     near a boundary in these cases. `port-fixtures/distance.json` does not
//     cover it either: that fixture is the haversine, which is a different
//     function with a different constant.
