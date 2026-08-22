import Foundation
import Observation
import RailCore

/// The rides — what this app is actually for.
///
/// The web app is *N02 特急列車管理*: a tool for recording which trains you have
/// ridden. The network drawn underneath is context; the itineraries are the
/// subject. This loads them from the same committed stores the web app reads.
///
/// Decoding and grouping both come from `RailCore` — `Train` and `Dates` are
/// ported and checked against the JavaScript by fixtures — so this type holds
/// no rules of its own. That is deliberate: a date grouped differently here
/// than in the web app would be a silent divergence no fixture could catch,
/// because it would live outside the tier the fixtures cover.
@MainActor
@Observable
final class ItineraryStore {

    enum LoadState {
        case idle
        case loading
        case loaded(Loaded)
        case failed(String)
    }

    struct Loaded {
        var country: String
        var trains: [Train]
        /// Dates in the order the web app's date bar shows them, each with the
        /// trains whose own bucket is that date.
        ///
        /// Deliberately *not* "the trains that run on this date": an overnight
        /// train belongs to one bucket while spanning two days on the map. The
        /// distinction is `Dates`', and it is documented there — conflating
        /// the two would list the Sunrise twice.
        var days: [Day]
        var elapsed: Duration

        struct Day: Identifiable {
            var date: String
            var trains: [Train]
            var id: String { date }
        }
    }

    private(set) var state: LoadState = .idle

    /// The train the reader is looking at. Selection lives here rather than in
    /// a view because the map and the list both need it, and they are in
    /// different halves of the layout.
    var selectedTrainID: String?

    /// Which countries ship a committed store. The other three packages draw
    /// a network but carry no recorded rides, and offering an empty list for
    /// them would read as a failure rather than as an absence.
    static let storeFiles: [String: String] = [
        "jp": "train-store",
        "tw": "train-store-tw",
    ]

    func load(country: String) {
        guard let resource = Self.storeFiles[country] else {
            state = .loaded(Loaded(country: country, trains: [], days: [], elapsed: .zero))
            selectedTrainID = nil
            return
        }
        state = .loading
        Task {
            do {
                let loaded = try await Self.decode(country: country, resource: resource)
                state = .loaded(loaded)
                selectedTrainID = nil
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }

    /// A national store is 1.2 MB of JSON and 201 itineraries, so it decodes
    /// off the main actor and the main actor only sees the finished value.
    private nonisolated static func decode(
        country: String, resource: String
    ) async throws -> Loaded {
        let started = ContinuousClock.now
        guard let url = Bundle.main.url(forResource: resource, withExtension: "json") else {
            throw LoadError.missingResource(resource)
        }
        let store = try JSONDecoder().decode(TrainStore.self, from: Data(contentsOf: url))

        // Both the ordering and the bucketing are the web app's, ported. The
        // date bar's order comes from `availableDates`, which sorts on a
        // purpose-built key rather than on the date string; the membership
        // comes from `trains(_:inBucket:)`. Neither is reinvented here.
        // `Dates` takes its own minimal train shape rather than the full
        // `Train`: the two were ported in parallel and neither could depend on
        // the other. Bridging here keeps that seam visible instead of pretending
        // it does not exist — and it is a real seam to close, because two
        // models of one thing eventually disagree about it.
        let sorted = Dates.sortByDateAndDeparture(store.trains.map(\.forDates))
            .compactMap { bridged in store.trains.first { $0.id == bridged.id } }

        let days = Dates.availableDates(sorted.map(\.forDates)).map { date in
            let bucket = Dates.trains(sorted.map(\.forDates), inBucket: date)
            let ids = Set(bucket.compactMap(\.id))
            return Loaded.Day(date: date, trains: sorted.filter { ids.contains($0.id) })
        }
        return Loaded(
            country: country,
            trains: sorted,
            days: days,
            elapsed: ContinuousClock.now - started
        )
    }

    var loaded: Loaded? {
        if case .loaded(let value) = state { return value }
        return nil
    }

    var selectedTrain: Train? {
        guard let id = selectedTrainID else { return nil }
        return loaded?.trains.first { $0.id == id }
    }

    enum LoadError: LocalizedError {
        case missingResource(String)

        var errorDescription: String? {
            switch self {
            case .missingResource(let name):
                """
                \(name).json is not in the app bundle. Run ios/copy-rail-packages.sh — \
                the itinerary stores are read from app/data rather than committed twice.
                """
            }
        }
    }
}
