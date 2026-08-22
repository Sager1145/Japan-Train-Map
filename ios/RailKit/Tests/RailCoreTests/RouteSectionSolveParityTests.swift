import Foundation
import Testing

@testable import RailCore

struct RouteSectionSolveParityTests {
    struct Fixture: Decodable {
        struct Train: Decodable {
            let id: String
            let number: String
            let trainType: String
            let company: String
            let origin: String
            let destination: String
            let preferredLineNames: [String]
            let preferredOperatorNames: [String]
            let allowedInstitutionTypeCodes: [String]?
            let institutionFilterMode: String
        }
        struct Connectors: Decodable { let directedCount: Int; let digest: String }
        struct Pair: Decodable { let from: Double; let to: Double }
        struct Properties: Decodable {
            let allowed_institution_type_codes: [String]
            let preferred_line_names: [String]
            let required_line_names: [String]
            let required_operator_names: [String]
            let preferred_operator_names: [String]
            let solve_mode: String
            let require_preferred_institution: Bool
            let used_institution_type_codes: [String]
            let path_coordinate_count: Int
            let raw_path_coordinate_count: Int
            let snap_distance_m: Pair
            let physical_length_m: Double
            let raw_physical_length_m: Double
            let cost: Double
        }
        struct Geometry: Decodable { let coordinates: [[Double]] }
        struct Feature: Decodable { let properties: Properties; let geometry: Geometry }
        struct Solve: Decodable {
            let section: RouteSection
            let continuityAnchor: [Double]?
            let feature: Feature?
        }
        struct CountryCase: Decodable {
            let country: String
            let train: Train
            let graphNodeCount: Int
            let connectors: Connectors
            let solved: [Solve]
            let officialSolved: [Solve]
        }
        let cases: [CountryCase]
    }

    static func fixture() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "route-section-solve.json")
    }

    static func url(_ base: String, _ country: String) throws -> URL {
        try PortFixtures.repositoryRoot().appending(path: "app/data/\(base)-\(country).json")
    }

    static func context(_ value: Fixture.Train) -> RouteSolver.TrainContext {
        .init(
            id: value.id, number: value.number, trainType: value.trainType,
            company: value.company, origin: value.origin, destination: value.destination,
            preferredLineNames: value.preferredLineNames,
            preferredOperatorNames: value.preferredOperatorNames,
            allowedInstitutionTypeCodes: value.allowedInstitutionTypeCodes,
            institutionFilterMode: value.institutionFilterMode)
    }

    static func jsSorted(_ values: [String]) -> [String] {
        values.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
    }

    static func connectorSummary(_ graph: RouteGraph.Graph) -> (Int, String) {
        var lines: [String] = []
        for (from, edges) in graph.adjacency {
            for edge in edges {
                guard let connector = edge.connector else { continue }
                lines.append([
                    from, edge.to,
                    connector.institutionTypeCodes.joined(separator: ","),
                    connector.stationName, connector.groupCode,
                ].joined(separator: "|"))
            }
        }
        lines = jsSorted(lines)
        return (lines.count, RouteGraph.keyDigest(lines.joined(separator: "\n")))
    }

    static func roundedHundredth(_ value: Double) -> Double {
        JSNumber.round(value * 100) / 100
    }

    @Test func completeSectionSolves() throws {
        for item in try Self.fixture().cases {
            let sections = try RouteGraph.SectionFeatureCollection.load(
                contentsOf: Self.url("rail-sections", item.country)).features
            let stationCollection = try Stations.FeatureCollection.load(
                contentsOf: Self.url("stations", item.country))
            let stations = Stations.Index(stationCollection)
            let graph = RouteGraph.build(from: sections)
            #expect(graph.nodeCount == item.graphNodeCount)
            RouteSolver.addStationTransferConnectorEdges(
                graph: graph, stations: stationCollection.features)
            let summary = Self.connectorSummary(graph)
            #expect(summary.0 == item.connectors.directedCount, "\(item.country) connector count")
            #expect(summary.1 == item.connectors.digest, "\(item.country) connector digest")

            for (segmentIndex, expected) in item.solved.enumerated() {
                let actual = RouteSolver.solveSection(
                    expected.section,
                    segmentIndex: segmentIndex,
                    train: Self.context(item.train), country: item.country,
                    graph: graph, stations: stations,
                    continuityAnchor: expected.continuityAnchor.flatMap(Coordinate.init(pair:)))
                if expected.feature == nil {
                    #expect(actual == nil)
                    continue
                }
                let feature = try #require(expected.feature)
                let solved = try #require(actual)
                let expectedCoordinates = feature.geometry.coordinates.compactMap(Coordinate.init(pair:))
                #expect(solved.coordinates == expectedCoordinates, "\(item.country)/\(segmentIndex) geometry")
                #expect(solved.coordinates.count == feature.properties.path_coordinate_count)
                #expect(solved.rawPathKeys.count == feature.properties.raw_path_coordinate_count)
                #expect(Set(solved.allowedInstitutionTypeCodes)
                        == Set(feature.properties.allowed_institution_type_codes))
                #expect(solved.usedInstitutionTypeCodes == feature.properties.used_institution_type_codes)
                #expect(solved.hints.preferredLines == Set(feature.properties.preferred_line_names))
                #expect(solved.hints.requiredLines == Set(feature.properties.required_line_names))
                #expect(solved.hints.requiredOperators == Set(feature.properties.required_operator_names))
                #expect(solved.hints.preferredOperators == Set(feature.properties.preferred_operator_names))
                #expect(solved.hints.solveMode == feature.properties.solve_mode)
                #expect(solved.hints.requirePreferredInstitution
                        == feature.properties.require_preferred_institution)
                #expect(Self.roundedHundredth(solved.snapFrom)
                        == feature.properties.snap_distance_m.from)
                #expect(Self.roundedHundredth(solved.snapTo)
                        == feature.properties.snap_distance_m.to)
                #expect(Self.roundedHundredth(solved.physicalLength)
                        == feature.properties.physical_length_m)
                #expect(Self.roundedHundredth(solved.rawPhysicalLength)
                        == feature.properties.raw_physical_length_m)
                #expect(Self.roundedHundredth(solved.cost) == feature.properties.cost)
            }

            let officialIndex = RouteSolver.OfficialIntervalIndex(sections: sections)
            for (segmentIndex, expected) in item.officialSolved.enumerated() {
                let feature = try #require(expected.feature)
                let actual = RouteSolver.solveOfficialInterval(
                    expected.section, segmentIndex: segmentIndex,
                    train: Self.context(item.train), country: item.country,
                    allowedCodes: feature.properties.allowed_institution_type_codes,
                    intervalIndex: officialIndex, stations: stations,
                    continuityAnchor: expected.continuityAnchor.flatMap(Coordinate.init(pair:)))
                let solved = try #require(actual)
                #expect(solved.coordinates
                        == feature.geometry.coordinates.compactMap(Coordinate.init(pair:)),
                        "\(item.country)/\(segmentIndex) official geometry")
                #expect(solved.rawPathKeys.count == feature.properties.raw_path_coordinate_count)
                #expect(solved.hints.preferredLines == Set(feature.properties.preferred_line_names))
                #expect(solved.hints.requiredLines == Set(feature.properties.required_line_names))
                #expect(solved.hints.requiredOperators == Set(feature.properties.required_operator_names))
                #expect(solved.hints.preferredOperators == Set(feature.properties.preferred_operator_names))
                #expect(solved.hints.solveMode == feature.properties.solve_mode)
                #expect(solved.usedInstitutionTypeCodes == feature.properties.used_institution_type_codes)
                #expect(Self.roundedHundredth(solved.physicalLength)
                        == feature.properties.physical_length_m)
                #expect(Self.roundedHundredth(solved.cost) == feature.properties.cost)
            }

            let graphStore = RouteGraph.RouteGraphStore(sections: sections)
            graphStore.augment = { regionalGraph, bbox in
                let features = bbox.map { box in
                    stationCollection.features.filter { feature in
                        guard let pair = Stations.displayCoordinate(feature),
                              let coordinate = Coordinate(pair: pair) else { return false }
                        return coordinate.lon >= box.minX && coordinate.lon <= box.maxX
                            && coordinate.lat >= box.minY && coordinate.lat <= box.maxY
                    }
                } ?? stationCollection.features
                RouteSolver.addStationTransferConnectorEdges(
                    graph: regionalGraph, stations: features)
            }
            for (segmentIndex, expected) in item.solved.enumerated() {
                let actual = RouteSolver.solveSectionOnDemand(
                    expected.section, segmentIndex: segmentIndex,
                    train: Self.context(item.train), country: item.country,
                    graphStore: graphStore, stations: stations,
                    continuityAnchor: expected.continuityAnchor.flatMap(Coordinate.init(pair:)))
                let feature = try #require(expected.feature)
                let solved = try #require(actual)
                #expect(solved.coordinates
                        == feature.geometry.coordinates.compactMap(Coordinate.init(pair:)),
                        "\(item.country)/\(segmentIndex) regional geometry")
            }
        }
    }
}
