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

    /// Loads whatever the library says is current — a bundled sample, or the
    /// reader's own saved store.
    ///
    /// The store is held here as well as decoded, because saving needs the
    /// whole `TrainStore` (schema version included) and not just the trains.
    private(set) var store: TrainStore?

    /// Replace one edited train and rebuild the date buckets from the same
    /// ported rules used on load. The editor commits a complete draft once,
    /// so views never observe a half-edited canonical record.
    func replace(_ train: Train, replacing originalID: String, country: String) {
        // A running import owns the store (§8.7): an edit committed against
        // the pre-import trains would be overwritten seconds later without a
        // trace of what happened to it.
        guard !isImporting else { return }
        guard var next = store,
            let index = next.trains.firstIndex(where: { $0.id == originalID })
        else { return }

        // An id edit cannot silently collide with another record. Leave the
        // original id in place; the validation surface can explain the
        // collision without destroying either journey.
        var candidate = train
        if candidate.id != originalID,
            next.trains.contains(where: { $0.id == candidate.id })
        {
            candidate.id = originalID
        }
        next.trains[index] = candidate
        store = next
        selectedTrainID = candidate.id

        Task {
            do {
                state = .loaded(try await Self.group(store: next, country: country))
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }

    @discardableResult
    func add(country: String) -> String? {
        mutate(country: country) { workspace in
            StoreOperations.addTrain(in: &workspace)
        }
    }

    /// Inserts a completed editor draft. Keeping this separate from the
    /// no-argument web-parity action lets the SwiftUI add flow remain atomic:
    /// cancelling the sheet never leaves a blank journey in the store.
    @discardableResult
    func add(_ train: Train, country: String) -> String? {
        mutate(country: country) { workspace in
            StoreOperations.addTrain(train, in: &workspace)
        }
    }

    @discardableResult
    func duplicate(_ id: String, country: String) -> String? {
        mutate(country: country) { workspace in
            StoreOperations.duplicateTrain(id, in: &workspace)
        }
    }

    func delete(_ id: String, country: String) {
        _ = mutate(country: country) { workspace in
            StoreOperations.deleteTrain(id, in: &workspace)
        }
    }

    func toggleVisibility(_ id: String, country: String) {
        _ = mutate(country: country) { workspace in
            StoreOperations.toggleTrainVisibility(id, in: &workspace)
        }
    }

    @discardableResult
    func rebuildRouteSections(_ id: String, country: String) -> Int? {
        guard let train = store?.trains.first(where: { $0.id == id }) else { return nil }
        var rebuilt = train
        rebuilt.routeSections = TrainValidation.normalizeExportTrain(
            train, country: country, stations: .empty).routeSections
        replace(rebuilt, replacing: id, country: country)
        return rebuilt.routeSections?.count ?? 0
    }

    func move(_ id: String, by offset: Int, country: String) {
        _ = mutate(country: country) { workspace in
            StoreOperations.moveTrain(id, by: offset, in: &workspace)
        }
    }

    /// One import's per-journey position, as the engine reports it.
    struct ImportProgress: Sendable {
        var completed: Int
        var total: Int
        /// The id the engine has just appended. The JSON-text door reports a
        /// count without one — its event carries a message KEY, not an id —
        /// so this is nil in replace mode rather than filled with a guess.
        var trainID: String?
    }

    struct ImportSummary: Sendable {
        var mode: ImportPreflight.Mode
        var imported: Int
        var ids: [String]
        /// Journeys in the store once the commit landed.
        var storeCount: Int
    }

    /// A progressive load owns the store while it streams journeys in.
    ///
    /// `ImportEngine.Session` has this flag too, but it lives on a scratch
    /// copy that the shell throws away; this is the shell's own, and it is
    /// what keeps an edit made while a large import runs from being silently
    /// overwritten by the commit (§8.7 — "防止并发修改造成不明确结果").
    private(set) var isImporting = false

    /// The staged import: parse and validate off the main actor, report every
    /// journey as it lands, and only then replace the store in one assignment.
    ///
    /// The engine is unchanged and undriven by this method — it runs its own
    /// door end to end. What is new is that the door's per-journey events are
    /// forwarded out instead of being dropped, which is the whole difference
    /// between "importing 47/201" and a spinner.
    ///
    /// Atomicity is structural rather than promised: the door mutates a
    /// scratch `Session` on a detached task, and the three lines that publish
    /// its result run together on the main actor after it has finished. A
    /// throw anywhere before them leaves the store exactly as it was, which is
    /// what lets the error surface say so (§13.3).
    ///
    /// Cancelling does not stop the engine — its loop has no interruption
    /// point, and pretending otherwise would mean re-implementing the loop and
    /// its fixture-pinned ordering. It stops the RESULT from being applied,
    /// so the store is left untouched either way.
    func runImport(
        text: String,
        country: String,
        mode: ImportPreflight.Mode,
        sourceLabel: String = "JSON",
        onProgress: @MainActor (ImportProgress) -> Void
    ) async throws -> ImportSummary {
        guard !isImporting else { throw ImportBusy() }
        isImporting = true
        defer { isImporting = false }

        let current = store?.trains ?? []
        let (stream, continuation) = AsyncStream<ImportProgress>.makeStream(
            bufferingPolicy: .bufferingNewest(1))

        let work = Task.detached(priority: .userInitiated) { () throws -> Commit in
            defer { continuation.finish() }
            var session = ImportEngine.Session(
                trains: mode == .append ? current : [],
                selectedTrainID: nil,
                focusedTrainID: nil,
                selectedDate: Dates.allDates,
                country: country)

            switch mode {
            case .replaceAll:
                // The door announces progress through its event sink; only the
                // per-journey label carries a live count, and the two bookend
                // events (prepare/done) would otherwise reset the bar to 0.
                session.onEvent = { event in
                    guard case .progressBar(let count, let total, let label) = event,
                        label == ImportEngine.MessageKey.loading
                    else { return }
                    continuation.yield(
                        ImportProgress(completed: count, total: total, trainID: nil))
                }
                try session.replaceTrainStoreFromJSONText(text, sourceLabel: sourceLabel)
                return Commit(
                    trains: session.trains,
                    selectedTrainID: session.selectedTrainID,
                    ids: session.trains.map(\.id))
            case .append:
                let document = try TrainValidation.parseImportedCanonicalStore(text: text)
                let result = try session.importCanonicalStoreAppendProgressive(document) {
                    progress in
                    // The append door opens with a placeholder row whose "id"
                    // is the i18n KEY `prog.preparingId`, not a journey. It is
                    // dropped here rather than shown as one.
                    continuation.yield(
                        ImportProgress(
                            completed: progress.count, total: progress.total,
                            trainID: progress.count == 0 ? nil : progress.id))
                }
                return Commit(
                    trains: session.trains,
                    selectedTrainID: session.selectedTrainID,
                    ids: result.ids)
            }
        }

        for await progress in stream { onProgress(progress) }
        let commit = try await work.value
        // A cancelled import discards a finished result rather than applying
        // half of it: the store is the one thing that must not be left in a
        // state nobody asked for.
        try Task.checkCancellation()
        // The same reasoning for a region switched under the import: those
        // journeys were normalised under one country's company rules and
        // belong to that country's store, not to whatever is on screen now.
        if let showing = loaded?.country, showing != country { throw ImportSuperseded() }

        let next = TrainStore(schemaVersion: TrainValidation.schemaVersion, trains: commit.trains)
        let grouped = try await Self.group(store: next, country: country)
        store = next
        selectedTrainID = commit.selectedTrainID
        state = .loaded(grouped)
        return ImportSummary(
            mode: mode, imported: commit.ids.count, ids: commit.ids,
            storeCount: commit.trains.count)
    }

    private struct Commit: Sendable {
        var trains: [Train]
        var selectedTrainID: String?
        var ids: [String]
    }

    struct ImportBusy: LocalizedError {
        var errorDescription: String? {
            "An import is already running; it owns the journeys until it finishes."
        }
    }

    struct ImportSuperseded: LocalizedError {
        var errorDescription: String? {
            "The region changed while this import was running, so its journeys were not applied."
        }
    }

    func importJSON(_ text: String, country: String) throws {
        var session = ImportEngine.Session(
            trains: store?.trains ?? [],
            selectedTrainID: selectedTrainID,
            focusedTrainID: nil,
            selectedDate: Dates.allDates,
            country: country
        )
        try session.replaceTrainStoreFromJSONText(text, sourceLabel: "JSON")
        let next = TrainStore(schemaVersion: TrainValidation.schemaVersion, trains: session.trains)
        store = next
        selectedTrainID = session.selectedTrainID
        let selection = session.selectedTrainID
        Task {
            do {
                state = .loaded(try await Self.group(store: next, country: country))
                selectedTrainID = selection
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }

    func deleteAll(country: String) {
        _ = mutate(country: country) { workspace in
            StoreOperations.deleteAllTrains(in: &workspace)
        }
    }

    func exportJSON(country: String) -> String? {
        guard let store else { return nil }
        return StoreOperations.exportTrainStore(
            StoreOperations.Workspace(
                store: store,
                selectedTrainID: selectedTrainID,
                country: country
            )
        )
    }

    /// Run one of RailCore's verified store transitions and rebuild the view
    /// model once. The selected id returned is useful for presenting a newly
    /// added or duplicated journey immediately.
    @discardableResult
    private func mutate(
        country: String,
        operation: (inout StoreOperations.Workspace) -> StoreOperations.MutationResult?
    ) -> String? {
        guard !isImporting else { return selectedTrainID }
        guard let store else { return nil }
        var workspace = StoreOperations.Workspace(
            store: store,
            selectedTrainID: selectedTrainID,
            focusedTrainID: nil,
            country: country
        )
        guard operation(&workspace) != nil else { return workspace.selectedTrainID }
        self.store = workspace.store
        selectedTrainID = workspace.selectedTrainID
        let selection = workspace.selectedTrainID
        Task {
            do {
                state = .loaded(try await Self.group(store: workspace.store, country: country))
                selectedTrainID = selection
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
        return workspace.selectedTrainID
    }

    func load(country: String, from library: RideLibrary) {
        state = .loading
        library.refreshSavedState(country: country)

        Task {
            do {
                let store: TrainStore
                switch library.source {
                case .mine:
                    store = try library.savedStore(country: country)
                case .sample(let resource):
                    // A sample belongs to one country. Asked for a country
                    // whose sample is not the current one — after a country
                    // switch — fall to that country's own first sample rather
                    // than showing rides with no railway under them.
                    let wanted = RideLibrary.Sample.all.first { $0.resource == resource }
                    if wanted?.country == country {
                        store = try library.sample(resource)
                    } else if let fallback = RideLibrary.Sample.forCountry(country).first {
                        store = try library.sample(fallback.resource)
                        library.use(.sample(fallback.resource))
                    } else {
                        store = TrainStore(schemaVersion: "1.3", trains: [])
                    }
                }
                self.store = store
                state = .loaded(try await Self.group(store: store, country: country))
                selectedTrainID = nil
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }

    /// A national store is 201 itineraries, so the grouping runs off the main
    /// actor and the main actor only sees the finished value.
    private nonisolated static func group(
        store: TrainStore, country: String
    ) async throws -> Loaded {
        let started = ContinuousClock.now

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
