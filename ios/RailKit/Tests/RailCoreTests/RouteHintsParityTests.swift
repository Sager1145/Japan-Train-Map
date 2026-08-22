import Foundation
import Testing

@testable import RailCore

struct RouteHintsParityTests {
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
        struct Hints: Decodable {
            let preferredLines: [String]
            let preferredOperators: [String]
            let requiredLines: [String]
            let requiredOperators: [String]
            let explicitRequiredLines: [String]
            let explicitRequiredOperators: [String]
            let commonLines: [String]
            let commonOperators: [String]
            let allCommonLines: [String]
            let allCommonOperators: [String]
            let preferredInstitutionCommonLines: [String]
            let preferredInstitutionCommonOperators: [String]
            let fromLines: [String]
            let toLines: [String]
            let fromOperators: [String]
            let toOperators: [String]
            let fromPreferredLines: [String]
            let toPreferredLines: [String]
            let fromPreferredOperators: [String]
            let toPreferredOperators: [String]
            let requirePreferredInstitution: Bool
            let solveMode: String
        }
        struct HintCase: Decodable {
            let train: Train
            let section: RouteSection
            let fromStationIndices: [Int]
            let toStationIndices: [Int]
            let hints: Hints
            let attempts: [Hints]
        }
        struct CountryCase: Decodable {
            let country: String
            let cases: [HintCase]
        }
        let cases: [CountryCase]
    }

    static func fixture() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "route-hints.json")
    }

    static func stations(_ country: String) throws -> Stations.Index {
        Stations.Index(try Stations.FeatureCollection.load(contentsOf:
            PortFixtures.repositoryRoot().appending(path: "app/data/stations-\(country).json")))
    }

    static func train(_ value: Fixture.Train) -> RouteSolver.TrainContext {
        .init(
            id: value.id, number: value.number, trainType: value.trainType,
            company: value.company, origin: value.origin, destination: value.destination,
            preferredLineNames: value.preferredLineNames,
            preferredOperatorNames: value.preferredOperatorNames,
            allowedInstitutionTypeCodes: value.allowedInstitutionTypeCodes,
            institutionFilterMode: value.institutionFilterMode)
    }

    static func sorted(_ values: Set<String>) -> [String] {
        values.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
    }

    static func expect(_ actual: RouteSolver.SegmentHints, _ expected: Fixture.Hints, _ label: String) {
        #expect(sorted(actual.preferredLines) == expected.preferredLines, "\(label) preferred lines")
        #expect(sorted(actual.preferredOperators) == expected.preferredOperators, "\(label) preferred operators")
        #expect(sorted(actual.requiredLines) == expected.requiredLines, "\(label) required lines")
        #expect(sorted(actual.requiredOperators) == expected.requiredOperators, "\(label) required operators")
        #expect(sorted(actual.explicitRequiredLines) == expected.explicitRequiredLines)
        #expect(sorted(actual.explicitRequiredOperators) == expected.explicitRequiredOperators)
        #expect(sorted(actual.commonLines) == expected.commonLines)
        #expect(sorted(actual.commonOperators) == expected.commonOperators)
        #expect(sorted(actual.allCommonLines) == expected.allCommonLines)
        #expect(sorted(actual.allCommonOperators) == expected.allCommonOperators)
        #expect(sorted(actual.preferredInstitutionCommonLines) == expected.preferredInstitutionCommonLines)
        #expect(sorted(actual.preferredInstitutionCommonOperators) == expected.preferredInstitutionCommonOperators)
        #expect(sorted(actual.fromLines) == expected.fromLines)
        #expect(sorted(actual.toLines) == expected.toLines)
        #expect(sorted(actual.fromOperators) == expected.fromOperators)
        #expect(sorted(actual.toOperators) == expected.toOperators)
        #expect(sorted(actual.fromPreferredLines) == expected.fromPreferredLines)
        #expect(sorted(actual.toPreferredLines) == expected.toPreferredLines)
        #expect(sorted(actual.fromPreferredOperators) == expected.fromPreferredOperators)
        #expect(sorted(actual.toPreferredOperators) == expected.toPreferredOperators)
        #expect(actual.requirePreferredInstitution == expected.requirePreferredInstitution)
        #expect(actual.solveMode == expected.solveMode)
    }

    @Test func segmentHintsAndAttempts() throws {
        for countryCase in try Self.fixture().cases {
            let stationIndex = try Self.stations(countryCase.country)
            for (caseIndex, item) in countryCase.cases.enumerated() {
                let base = RouteSolver.buildSegmentRouteHints(
                    section: item.section,
                    fromStationIndices: item.fromStationIndices,
                    toStationIndices: item.toStationIndices,
                    stations: stationIndex,
                    train: Self.train(item.train),
                    country: countryCase.country)
                let label = "\(countryCase.country)/\(caseIndex)"
                Self.expect(base, item.hints, label)
                let attempts = RouteSolver.buildSegmentRouteSolveAttempts(base)
                #expect(attempts.count == item.attempts.count, "\(label) attempt count")
                for (index, pair) in zip(attempts, item.attempts).enumerated() {
                    Self.expect(pair.0, pair.1, "\(label)/attempt-\(index)")
                }
            }
        }
    }
}
