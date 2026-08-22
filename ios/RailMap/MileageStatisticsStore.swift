import Foundation
import Observation
import RailCore

@MainActor
@Observable
final class MileageStatisticsStore {
    enum State {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    private(set) var state: State = .idle
    private(set) var view: Statistics.MileageStatsView?
    private(set) var totalsByMask: [Int: Double] = [:]
    private(set) var lineTotals: [(name: String, byMask: [Int: Double])] = []
    private(set) var lineOperators: [String: String] = [:]
    private var task: Task<Void, Never>?

    func load(country: String, trains: [Train], rides: [RiddenRouteStore.DrawnRide]) {
        task?.cancel()
        state = .loading
        task = Task {
            do {
                let result = try await Self.build(country: country, trains: trains, rides: rides)
                try Task.checkCancellation()
                view = result.view
                totalsByMask = result.totalsByMask
                lineTotals = result.lineTotals
                lineOperators = result.lineOperators
                state = .loaded
            } catch is CancellationError {
                return
            } catch {
                view = nil
                lineTotals = []
                lineOperators = [:]
                state = .failed(error.localizedDescription)
            }
        }
    }

    private nonisolated static func build(
        country: String, trains: [Train], rides: [RiddenRouteStore.DrawnRide]
    ) async throws -> BuildResult {
        let suffix = country == "jp" ? "" : "-\(country)"
        guard let url = Bundle.main.url(
            forResource: "rail-sections\(suffix)", withExtension: "json")
        else { throw StatisticsError.missingSections(country) }
        let sections = try Statistics.SectionFeatureCollection.load(contentsOf: url).sections
        try Task.checkCancellation()
        let edgeIndex = Statistics.buildEdgeIndex(sections: sections, country: country)
        let ridesByID = Dictionary(uniqueKeysWithValues: rides.map { ($0.id, $0) })
        var statisticsTrains: [Statistics.Train] = []
        var entries: [Statistics.TrainEntry] = []
        statisticsTrains.reserveCapacity(trains.count)
        entries.reserveCapacity(trains.count)

        for train in trains {
            try Task.checkCancellation()
            let stops = train.stops.map {
                Statistics.Stop(
                    arrival: $0.arrival, departure: $0.departure,
                    stopType: $0.stopType, rideSegment: $0.rideSegment)
            }
            let statisticsTrain = Statistics.Train(
                id: train.id, trainType: train.trainType,
                date: train.date, stops: stops)
            statisticsTrains.append(statisticsTrain)
            let features = ridesByID[train.id]?.segments.map { segment in
                Statistics.RouteFeature(
                    lines: [segment.coordinates], hasGeometry: true,
                    rideSegment: Statistics.isRideSegment(
                        stops, segmentIndex: segment.segmentIndex),
                    from: segment.from, to: segment.to)
            } ?? []
            entries.append(Statistics.collectTrainStatsEntry(
                features: features, index: edgeIndex))
        }
        let view = Statistics.buildMileageStatsView(
            index: edgeIndex, trains: statisticsTrains, entries: entries,
            country: country, selectedDate: Statistics.allDates,
            trainDate: { $0.date ?? "" }, dateLabel: { $0 })
        return BuildResult(
            view: view, totalsByMask: edgeIndex.totalsByMask,
            lineTotals: edgeIndex.lineTotByCat.pairs.map { ($0.key, $0.value) },
            lineOperators: Dictionary(uniqueKeysWithValues: edgeIndex.lineOperator.pairs.map {
                ($0.key, $0.value)
            }))
    }

    private struct BuildResult: Sendable {
        let view: Statistics.MileageStatsView
        let totalsByMask: [Int: Double]
        let lineTotals: [(name: String, byMask: [Int: Double])]
        let lineOperators: [String: String]
    }

    enum StatisticsError: LocalizedError {
        case missingSections(String)
        var errorDescription: String? {
            switch self {
            case .missingSections(let country):
                "Statistics rail sections for \(country) are missing from the app bundle."
            }
        }
    }
}
