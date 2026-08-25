import Foundation
import Observation
import RailCore

/// Owner of the 里程統計 numbers.
///
/// Every figure on the statistics screen comes out of `RailCore.Statistics`,
/// which is the ported reference implementation and is covered by parity
/// fixtures. Nothing is aggregated here — this type only decides *when* the
/// ported functions run, on which inputs, and what the screen is told while
/// they are running.
///
/// Two things beyond the original port live here:
///
/// - **A date scope of its own.** `app-stats.js` reads the one global
///   `selectedDate` that the date bar writes, so the web panel silently
///   follows the ride list's filter. The native app has a tab bar rather than
///   one page, and the rides workspace owns its own `selectedDate`; a
///   statistics screen that changed the ride list's filter (or was changed by
///   it) from another tab would be a filter that moves while you are not
///   looking at it. So the scope is held here and nowhere else.
/// - **Stages (§7.8 / §13.2).** Building the edge index parses the whole rail
///   network, which is seconds, not milliseconds. A bare spinner would say
///   nothing for that whole time, so the phase in flight — and the ride count
///   while rides are being matched — is published as it goes.
@MainActor
@Observable
final class MileageStatisticsStore {
    enum State {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    /// §7.8 ProgressSummary: the stage in flight, how far it has got when that
    /// is knowable, and whether the reader has to wait for it.
    struct Progress: Equatable {
        enum Stage: Equatable {
            /// Reading and indexing `rail-sections*.json`.
            case readingNetwork
            /// Matching each ride's drawn geometry onto network edges.
            case matchingRides
            /// The deduped union, the service rows, the most-ridden sections.
            case aggregating
            /// Re-running the day slice after the scope changed.
            case scopingDay

            var localizationKey: String {
                switch self {
                case .readingNetwork: "ios.stats.stage.readingNetwork"
                case .matchingRides: "ios.stats.stage.matchingRides"
                case .aggregating: "ios.stats.stage.aggregating"
                case .scopingDay: "ios.stats.stage.scopingDay"
                }
            }
        }

        var stage: Stage
        var completed: Int?
        var total: Int?
        /// Nothing here blocks the rest of the app, and the screen keeps the
        /// previous answer on display while a rescope runs.
        var interactionContinues: Bool = true
    }

    private(set) var state: State = .idle
    private(set) var view: Statistics.MileageStatsView?
    private(set) var totalsByMask: [Int: Double] = [:]
    /// `idx.totals.all` — the denominator of the headline coverage figure.
    private(set) var totalKm: Double = 0
    private(set) var lineTotals: [(name: String, byMask: [Int: Double])] = []
    private(set) var lineOperators: [String: String] = [:]
    private(set) var progress: Progress?

    /// The statistics screen's own date bucket, in the same vocabulary the
    /// date bar uses: `Dates.allDates`, `Dates.undated`, or `YYYY-MM-DD`.
    ///
    /// Deliberately not shared with `RailWorkspaceView.selectedDate`.
    private(set) var selectedDate: String = Dates.allDates

    /// The date buckets the loaded rides actually occupy, in date-bar order.
    /// Used to keep a stale scope from surviving a reload.
    private(set) var availableDates: [String] = []

    private var task: Task<Void, Never>?
    private var scopeTask: Task<Void, Never>?
    private var context: Context?

    var failureMessage: String? {
        if case .failed(let message) = state { return message }
        return nil
    }

    /// Load the numbers for one region, or for all of them at once.
    ///
    /// `countries` is a list because §5.3.1's scope now has an 全部 entry. One
    /// entry behaves exactly as this method always did; several are read as a
    /// single network — see `EdgeIndexCache.merged`, and `categoryCountry`
    /// for which vocabulary the rows are then named in.
    func load(countries: [String], trains: [Train], rides: [RiddenRouteStore.DrawnRide]) {
        task?.cancel()
        scopeTask?.cancel()
        state = .loading
        let total = trains.count
        let country = Self.categoryCountry(for: countries)
        task = Task { [weak self] in
            guard let self else { return }
            do {
                self.progress = Progress(stage: .readingNetwork)
                let index = try await Self.readNetwork(countries: countries)
                try Task.checkCancellation()

                self.progress = Progress(stage: .matchingRides, completed: 0, total: total)
                let prepared = try await Self.matchRides(
                    trains: trains, rides: rides, index: index,
                    report: { [weak self] done in
                        Task { @MainActor in
                            guard let self, self.progress?.stage == .matchingRides else { return }
                            self.progress = Progress(
                                stage: .matchingRides, completed: done, total: total)
                        }
                    })
                try Task.checkCancellation()

                self.progress = Progress(stage: .aggregating)
                let context = Context(
                    country: country, index: index,
                    trains: prepared.trains, entries: prepared.entries)

                // A scope that no longer names a real day cannot be answered.
                // Falling back to the combined view rather than to the first
                // remaining day keeps the reset visible: the screen says 全部
                // and reads `--`, instead of quietly reporting a day nobody
                // asked about.
                let dates = Dates.availableDates(prepared.trains.map(\.forDateBucket))
                if self.selectedDate != Dates.allDates,
                    !dates.contains(self.selectedDate)
                {
                    self.selectedDate = Dates.allDates
                }
                let scope = self.selectedDate

                let result = try await Self.aggregate(context: context, selectedDate: scope)
                try Task.checkCancellation()

                self.context = context
                self.availableDates = dates
                self.view = result
                self.totalsByMask = index.totalsByMask
                self.totalKm = index.totalKm
                self.lineTotals = index.lineTotByCat.pairs.map { ($0.key, $0.value) }
                self.lineOperators = Dictionary(
                    index.lineOperator.pairs.map { ($0.key, $0.value) },
                    uniquingKeysWith: { first, _ in first })
                self.progress = nil
                self.state = .loaded
                // The scope can be moved while the load is still running; the
                // answer just computed is then for the wrong day.
                if self.selectedDate != scope { self.rescope() }
            } catch is CancellationError {
                return
            } catch {
                self.context = nil
                self.view = nil
                self.availableDates = []
                self.lineTotals = []
                self.lineOperators = [:]
                self.progress = nil
                self.state = .failed(error.localizedDescription)
            }
        }
    }

    /// Move the statistics screen's own date scope.
    ///
    /// Only the day slice depends on it — `overall` is computed from every
    /// entry regardless — but the whole view model is rebuilt through the same
    /// `buildMileageStatsView` the web app calls, rather than assembling a
    /// `MileageStatsView` here out of parts. Recomputing an aggregate we could
    /// have cached is cheap next to the risk of a hand-assembled view drifting
    /// from the ported one; the expensive half (reading the network, matching
    /// every ride) is what the cached `Context` skips.
    func selectDate(_ date: String) {
        guard date != selectedDate else { return }
        selectedDate = date
        rescope()
    }

    private func rescope() {
        guard let context else { return }
        scopeTask?.cancel()
        let scope = selectedDate
        scopeTask = Task { [weak self] in
            guard let self else { return }
            do {
                self.progress = Progress(stage: .scopingDay)
                let result = try await Self.aggregate(context: context, selectedDate: scope)
                try Task.checkCancellation()
                self.view = result
                self.progress = nil
                self.state = .loaded
            } catch is CancellationError {
                return
            } catch {
                self.progress = nil
                self.state = .failed(error.localizedDescription)
            }
        }
    }

    // MARK: - the phases

    /// The region's edge index, from the cache that owns it.
    ///
    /// This used to read and index `rail-sections*.json` itself, once per
    /// load. The numbers now reload on every edit rather than only on an add
    /// or a delete, and the network is the same file every time — see
    /// ``EdgeIndexCache``, which is also what the map's ridden-line category
    /// filter classifies against.
    private nonisolated static func readNetwork(
        countries: [String]
    ) async throws -> Statistics.EdgeIndex {
        let index = try await EdgeIndexCache.shared.merged(countries: countries)
        try Task.checkCancellation()
        return index
    }

    /// Whose vocabulary the category rows are named in.
    ///
    /// One region answers for itself. Several have no single answer, and the
    /// catalog's own default is the one that fits: `Statistics.categories`
    /// falls through to the FULL list — 新幹線, 在來線, JR, 地下鐵, 私鐵, 路面
    /// 電車 — which is exactly the union an all-regions panel has to be able
    /// to show. Naming it after any one of the five would hide the rows the
    /// other four need.
    private nonisolated static func categoryCountry(for countries: [String]) -> String {
        countries.count == 1 ? countries[0] : Region.jp.code
    }

    private nonisolated static func matchRides(
        trains: [Train], rides: [RiddenRouteStore.DrawnRide], index: Statistics.EdgeIndex,
        report: @Sendable (Int) -> Void
    ) async throws -> Prepared {
        let ridesByID = Dictionary(rides.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var statisticsTrains: [Statistics.Train] = []
        var entries: [Statistics.TrainEntry] = []
        statisticsTrains.reserveCapacity(trains.count)
        entries.reserveCapacity(trains.count)

        for (position, train) in trains.enumerated() {
            try Task.checkCancellation()
            let stops = train.stops.map {
                Statistics.Stop(
                    arrival: $0.arrival, departure: $0.departure,
                    stopType: $0.stopType, rideSegment: $0.rideSegment)
            }
            // `date` carries the normalised date BUCKET, not the raw field:
            // the day slice compares it against a bucket the date bar named,
            // and `getTrainDate` in the web app normalises there too. A train
            // with no usable date lands in `Dates.undated`, which is a bucket
            // the reader can select, not a missing value.
            let statisticsTrain = Statistics.Train(
                id: train.id, trainType: train.trainType,
                date: Dates.trainDate(train.forDates), stops: stops)
            statisticsTrains.append(statisticsTrain)
            let features = ridesByID[train.id]?.segments.map { segment in
                Statistics.RouteFeature(
                    lines: [segment.coordinates], hasGeometry: true,
                    rideSegment: Statistics.isRideSegment(
                        stops, segmentIndex: segment.segmentIndex),
                    from: segment.from, to: segment.to)
            } ?? []
            entries.append(Statistics.collectTrainStatsEntry(
                features: features, index: index))
            // Reported in blocks: one hop to the main actor per train would
            // cost more than the matching itself on a small store.
            if position % 25 == 24 { report(position + 1) }
        }
        report(trains.count)
        return Prepared(trains: statisticsTrains, entries: entries)
    }

    private nonisolated static func aggregate(
        context: Context, selectedDate: String
    ) async throws -> Statistics.MileageStatsView {
        try Task.checkCancellation()
        // `dateLabel` is the identity: the label is a translation, so the day
        // bucket travels to the screen unresolved and `Dates.dateLabelKey` is
        // read there. That is exactly why the port made it a parameter.
        return Statistics.buildMileageStatsView(
            index: context.index, trains: context.trains, entries: context.entries,
            country: context.country, selectedDate: selectedDate,
            trainDate: { $0.date ?? Dates.undated },
            dateLabel: { $0 })
    }

    private struct Context: Sendable {
        let country: String
        let index: Statistics.EdgeIndex
        let trains: [Statistics.Train]
        let entries: [Statistics.TrainEntry]
    }

    private struct Prepared: Sendable {
        let trains: [Statistics.Train]
        let entries: [Statistics.TrainEntry]
    }
}

private extension Statistics.Train {
    /// The already-normalised bucket, handed back to `Dates` so the screen's
    /// date list is built by the same rule the date bar uses.
    var forDateBucket: Dates.Train {
        Dates.Train(id: id, date: date, stops: [])
    }
}
