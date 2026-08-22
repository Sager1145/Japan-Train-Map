import Foundation
import Testing

@testable import RailCore

/// `app-route-solver.js` §29 against real Hong Kong and Macao rail sections.
struct RouteSolverParityTests {
    struct Fixture: Decodable {
        struct Properties: Decodable {
            let lineName: String
            let `operator`: String
            let institutionTypeCode: String
            let railwayClassCode: String
        }
        struct Input: Decodable {
            let properties: Properties
            let lines: [[[Double]]]
        }
        struct Edge: Decodable {
            let to: String
            let length: Double
            let institution_type_code: String
            let railway_class_code: String
            let line_name: String
            let `operator`: String
        }
        struct EdgeRuleSample: Decodable {
            let edge: Edge
            let allowedCodes: [String]
            let disallowedCodes: [String]
            let hasAllowed: Bool
            let hasDisallowed: Bool
            let softDisallowedPenalty: Double
            let hardDisallowedPenalty: Double
            let mismatchedLineOperatorPenalty: Double
        }
        struct Candidate: Decodable {
            let key: String
            let distance: Double
        }
        struct Train: Decodable { let institutionFilterMode: String }
        struct Hints: Decodable {
            let preferredLines: [String]
            let preferredOperators: [String]
            let requiredLines: [String]
            let requiredOperators: [String]
            let requirePreferredInstitution: Bool
        }
        struct Result: Decodable {
            let targetKey: String
            let sourceKey: String
            let cost: Double
            let pathKeys: [String]
        }
        struct SolveCase: Decodable {
            let name: String
            let sources: [Candidate]
            let targets: [String]
            let train: Train
            let allowedCodes: [String]
            let hints: Hints
            let result: [Result]
            let pathLengths: [Double]
            let mismatchPenalties: [Double]
            let usedInstitutionTypeCodes: [[String]]
        }
        struct CountryCase: Decodable {
            let country: String
            let input: Input
            let nodeCount: Int
            let edgeRuleSample: EdgeRuleSample
            let cases: [SolveCase]
        }
        let cases: [CountryCase]
    }

    static func fixture() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "route-solver-core.json")
    }

    static func graph(_ item: Fixture.CountryCase) -> RouteGraph.Graph {
        let p = item.input.properties
        let lines = item.input.lines.map { line in
            line.compactMap(Coordinate.init(pair:))
        }
        return RouteGraph.build(from: [
            RouteGraph.SectionFeature(
                properties: RouteGraph.SectionProperties(
                    lineName: p.lineName,
                    operator: p.operator,
                    institutionTypeCode: p.institutionTypeCode,
                    railwayClassCode: p.railwayClassCode),
                lines: lines)
        ])
    }

    static func edge(_ value: Fixture.Edge) -> RouteGraph.Edge {
        RouteGraph.Edge(
            to: value.to,
            length: value.length,
            institutionTypeCode: value.institution_type_code,
            railwayClassCode: value.railway_class_code,
            lineName: value.line_name,
            operator: value.operator,
            connector: nil)
    }

    static func hints(_ value: Fixture.Hints) -> RouteSolver.SegmentHints {
        RouteSolver.SegmentHints(
            preferredLines: Set(value.preferredLines),
            preferredOperators: Set(value.preferredOperators),
            requiredLines: Set(value.requiredLines),
            requiredOperators: Set(value.requiredOperators),
            requirePreferredInstitution: value.requirePreferredInstitution)
    }

    /// A route sums many haversine edge lengths. The existing measured
    /// Darwin↔V8 ceiling is 2 ULP per edge; these fixture paths contain at
    /// most 22 vertices, so 48 ULP is a deliberately finite accumulated cap.
    static let accumulatedULPBudget: Int64 = 48

    static func expectClose(_ actual: Double, _ expected: Double, _ label: String) {
        #expect(
            actual.ulpDistance(to: expected) <= accumulatedULPBudget,
            "\(label): \(actual) vs \(expected) (\(actual.ulpDistance(to: expected)) ULP)")
    }

    @Test func edgeRules() throws {
        for item in try Self.fixture().cases {
            let sample = item.edgeRuleSample
            let edge = Self.edge(sample.edge)
            #expect(RouteSolver.edgeHasPreferredInstitution(
                edge, allowedCodes: sample.allowedCodes) == sample.hasAllowed)
            #expect(RouteSolver.edgeHasPreferredInstitution(
                edge, allowedCodes: sample.disallowedCodes) == sample.hasDisallowed)
            Self.expectClose(
                RouteSolver.institutionPreferencePenalty(
                    for: edge,
                    allowedCodes: sample.disallowedCodes,
                    train: .init(institutionFilterMode: "soft")),
                sample.softDisallowedPenalty,
                "\(item.country) soft institution penalty")
            #expect(RouteSolver.institutionPreferencePenalty(
                for: edge,
                allowedCodes: sample.disallowedCodes,
                train: .init(institutionFilterMode: "hard")
            ).bitPattern == sample.hardDisallowedPenalty.bitPattern)
            Self.expectClose(
                RouteSolver.nonPreferredLineOperatorPenalty(
                    for: edge,
                    preferredLines: ["__different_line__"],
                    preferredOperators: ["__different_operator__"]),
                sample.mismatchedLineOperatorPenalty,
                "\(item.country) line/operator penalty")
        }
    }

    @Test func multiSourceDijkstra() throws {
        for item in try Self.fixture().cases {
            let graph = Self.graph(item)
            #expect(graph.nodeCount == item.nodeCount)
            for testCase in item.cases {
                let segmentHints = Self.hints(testCase.hints)
                let actual = RouteSolver.dijkstra(
                    graph: graph,
                    sourceCandidates: testCase.sources.map {
                        .init(key: $0.key, distance: $0.distance)
                    },
                    targetKeys: Set(testCase.targets),
                    train: .init(institutionFilterMode: testCase.train.institutionFilterMode),
                    allowedCodes: testCase.allowedCodes,
                    hints: segmentHints)
                #expect(actual.count == testCase.result.count)
                for (index, pair) in zip(actual, testCase.result).enumerated() {
                    #expect(pair.0.targetKey == pair.1.targetKey)
                    #expect(pair.0.sourceKey == pair.1.sourceKey)
                    #expect(pair.0.pathKeys == pair.1.pathKeys)
                    Self.expectClose(
                        pair.0.cost, pair.1.cost,
                        "\(item.country)/\(testCase.name) result \(index) cost")
                    Self.expectClose(
                        RouteSolver.pathLengthMeters(graph: graph, pathKeys: pair.0.pathKeys),
                        testCase.pathLengths[index],
                        "\(item.country)/\(testCase.name) result \(index) length")
                    Self.expectClose(
                        RouteSolver.routeLineMismatchPenalty(
                            graph: graph, pathKeys: pair.0.pathKeys, hints: segmentHints),
                        testCase.mismatchPenalties[index],
                        "\(item.country)/\(testCase.name) result \(index) mismatch")
                    #expect(RouteSolver.usedInstitutionTypeCodes(
                        graph: graph, pathKeys: pair.0.pathKeys
                    ) == testCase.usedInstitutionTypeCodes[index])
                }
            }
        }
    }
}
