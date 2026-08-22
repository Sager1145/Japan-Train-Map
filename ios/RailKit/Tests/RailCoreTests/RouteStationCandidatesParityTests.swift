import Foundation
import Testing

@testable import RailCore

/// Station geometry snapping from `app-route-solver.js`, over the complete
/// shipped Hong Kong and Macao graphs and station collections.
struct RouteStationCandidatesParityTests {
    struct Fixture: Decodable {
        struct Hints: Decodable {
            let preferredLines: [String]
            let preferredOperators: [String]
            let requiredLines: [String]
            let requiredOperators: [String]
            let requirePreferredInstitution: Bool
        }
        struct Candidate: Decodable {
            let key: String
            let distance: Double
            let score: Double
            let hasPreferredInstitution: Bool
            let stationIndex: Int
        }
        struct Probe: Decodable {
            let stationIndex: Int
            let allowedCodes: [String]
            let baseHints: Hints
            let base: [Candidate]
            let preferredHints: Hints
            let preferred: [Candidate]
            let strictHints: Hints
            let strict: [Candidate]
        }
        struct Collection: Decodable {
            let stationIndices: [Int]
            let hints: Hints
            let allowedCodes: [String]
            let result: [Candidate]
        }
        struct CountryCase: Decodable {
            let country: String
            let graphNodeCount: Int
            let probes: [Probe]
            let collection: Collection
        }
        let cases: [CountryCase]
    }

    static func fixture() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "route-station-candidates.json")
    }

    static func dataURL(_ base: String, _ country: String) throws -> URL {
        try PortFixtures.repositoryRoot().appending(path: "app/data/\(base)-\(country).json")
    }

    static func hints(_ value: Fixture.Hints) -> RouteSolver.SegmentHints {
        .init(
            preferredLines: Set(value.preferredLines),
            preferredOperators: Set(value.preferredOperators),
            requiredLines: Set(value.requiredLines),
            requiredOperators: Set(value.requiredOperators),
            requirePreferredInstitution: value.requirePreferredInstitution)
    }

    static func expect(
        _ actual: [RouteSolver.StationNodeCandidate],
        _ expected: [Fixture.Candidate],
        _ label: String
    ) {
        #expect(actual.count == expected.count, "\(label) candidate count")
        for (left, right) in zip(actual, expected) {
            #expect(left.key == right.key, "\(label) key")
            #expect(left.stationIndex == right.stationIndex, "\(label) station")
            #expect(left.hasPreferredInstitution == right.hasPreferredInstitution, "\(label) institution")
            #expect(left.distance.ulpDistance(to: right.distance) <= 2, "\(label) distance")
            #expect(left.score.ulpDistance(to: right.score) <= 4, "\(label) score")
        }
    }

    @Test func graphNodeCandidates() throws {
        for item in try Self.fixture().cases {
            let sections = try RouteGraph.SectionFeatureCollection.load(
                contentsOf: Self.dataURL("rail-sections", item.country)).features
            let stationCollection = try Stations.FeatureCollection.load(
                contentsOf: Self.dataURL("stations", item.country))
            let stations = Stations.Index(stationCollection)
            let graph = RouteGraph.build(from: sections)
            #expect(graph.nodeCount == item.graphNodeCount)

            for probe in item.probes {
                Self.expect(
                    RouteSolver.stationCandidateGraphNodes(
                        stationIndex: probe.stationIndex, stations: stations, graph: graph,
                        hints: Self.hints(probe.baseHints), allowedCodes: probe.allowedCodes),
                    probe.base, "\(item.country)/\(probe.stationIndex)/base")
                Self.expect(
                    RouteSolver.stationCandidateGraphNodes(
                        stationIndex: probe.stationIndex, stations: stations, graph: graph,
                        hints: Self.hints(probe.preferredHints), allowedCodes: probe.allowedCodes),
                    probe.preferred, "\(item.country)/\(probe.stationIndex)/preferred")
                Self.expect(
                    RouteSolver.stationCandidateGraphNodes(
                        stationIndex: probe.stationIndex, stations: stations, graph: graph,
                        hints: Self.hints(probe.strictHints), allowedCodes: probe.allowedCodes),
                    probe.strict, "\(item.country)/\(probe.stationIndex)/strict")
            }

            let collection = item.collection
            Self.expect(
                RouteSolver.collectStationCandidateGraphNodes(
                    stationIndices: collection.stationIndices,
                    stations: stations,
                    graph: graph,
                    hints: Self.hints(collection.hints),
                    allowedCodes: collection.allowedCodes),
                collection.result, "\(item.country)/collection")
        }
    }
}
