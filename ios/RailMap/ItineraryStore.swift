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
        /// Which regions these rides touch, in the interface's order. The map
        /// draws all five networks whatever this says; it is here because the
        /// screens that summarise the rides — statistics, the data screen —
        /// have to say which regions they are summarising.
        var regions: [Region]
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

    /// What a save actually did (§8.3).
    ///
    /// `replace` used to return nothing, which meant the two ways it can
    /// decline — an import owns the store, or the new id belongs to another
    /// journey — were indistinguishable from success at every call site. The
    /// id collision in particular was resolved *silently*: the record was
    /// written back under its old id and nobody was told. §8.3 forbids the
    /// louder version of that ("ID 冲突不能静默覆盖另一条记录"), and this is
    /// what lets a surface say which of the two happened.
    ///
    /// Adding a return value keeps every existing `itineraries.replace(...)`
    /// call compiling untouched.
    enum SaveOutcome: Equatable {
        case saved
        /// Written, but under `keptID`: `requestedID` is another journey's.
        case savedKeepingID(keptID: String, requestedID: String)
        /// Nothing was written — an import owns the store right now.
        case refusedImportRunning
        /// Nothing was written — no journey with that id is in the store.
        case notFound
    }

    /// Replace one edited train and rebuild the date buckets from the same
    /// ported rules used on load. The editor commits a complete draft once,
    /// so views never observe a half-edited canonical record.
    @discardableResult
    func replace(_ train: Train, replacing originalID: String) -> SaveOutcome {
        // A running import owns the store (§8.7): an edit committed against
        // the pre-import trains would be overwritten seconds later without a
        // trace of what happened to it.
        guard !isImporting else { return .refusedImportRunning }
        guard var next = store,
            let index = next.trains.firstIndex(where: { $0.id == originalID })
        else { return .notFound }

        // An id edit cannot silently collide with another record. Leave the
        // original id in place; the validation surface can explain the
        // collision without destroying either journey.
        var candidate = train
        var outcome = SaveOutcome.saved
        if candidate.id != originalID,
            next.trains.contains(where: { $0.id == candidate.id })
        {
            outcome = .savedKeepingID(keptID: originalID, requestedID: candidate.id)
            candidate.id = originalID
        }
        next.trains[index] = candidate.taggingRegion()
        store = next
        selectedTrainID = candidate.id
        publishRecordIndex()

        Task {
            do {
                state = .loaded(try await Self.group(store: next))
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
        return outcome
    }

    /// The web-parity 新增列車 — a region's own starter itinerary.
    ///
    /// The region is an argument because there is no active one to read: the
    /// blank train `StoreOperations.createBlankTrain` builds is regional data
    /// (Japan's 東京→熱海, Taiwan's airport-MRT corridor), so *which* one is
    /// the reader's choice rather than an app-state lookup.
    @discardableResult
    func add(region: Region) -> String? {
        mutate(region: region) { workspace in
            StoreOperations.addTrain(in: &workspace)
        }
    }

    /// Inserts a completed editor draft. Keeping this separate from the
    /// no-argument web-parity action lets the SwiftUI add flow remain atomic:
    /// cancelling the sheet never leaves a blank journey in the store.
    @discardableResult
    func add(_ train: Train) -> String? {
        mutate(region: Region.resolved(train)) { workspace in
            StoreOperations.addTrain(train.taggingRegion(), in: &workspace)
        }
    }

    @discardableResult
    func duplicate(_ id: String) -> String? {
        mutate(region: region(of: id)) { workspace in
            StoreOperations.duplicateTrain(id, in: &workspace)
        }
    }

    func delete(_ id: String) {
        _ = mutate(region: region(of: id)) { workspace in
            StoreOperations.deleteTrain(id, in: &workspace)
        }
    }

    func toggleVisibility(_ id: String) {
        _ = mutate(region: region(of: id)) { workspace in
            StoreOperations.toggleTrainVisibility(id, in: &workspace)
        }
    }

    /// The region of the ride an operation acts on.
    ///
    /// Most `StoreOperations` transitions do not read the workspace's country
    /// at all — only `addTrain` does, for its blank scaffold — but handing one
    /// the wrong region would be a fact stated wrongly, and a later transition
    /// that starts reading it would inherit the mistake silently.
    private func region(of id: String) -> Region {
        store?.trains.first { $0.id == id }.map(Region.resolved) ?? .jp
    }

    @discardableResult
    func rebuildRouteSections(_ id: String) -> Int? {
        rebuildRoute(id)?.sections
    }

    /// What a rebuild did, in the two parts §8.4 asks the interface to keep
    /// apart: the sections were recomputed from the stops, and *then* the
    /// geometry is solved for them.
    struct RebuildOutcome: Equatable {
        /// Route sections written back to the record.
        var sections: Int
        /// Whether a geometry solve actually started. False when the app is
        /// running without a route store beneath it, and the surface then says
        /// "sections rebuilt" instead of claiming a solve nobody is running.
        var solving: Bool
    }

    /// `rebuildRouteSections`, plus the half that was missing.
    ///
    /// Recomputing `route_sections` changes the record, and until now that was
    /// the whole operation. The shell's route key covers the whole record now
    /// (see `ContentView.routeLoadKey`), so the reload is no longer in doubt —
    /// but it reloads the *set*, and this journey is the one the reader is
    /// waiting on. Solving it directly is what puts its own geometry back
    /// under its own section list immediately, and what lets §8.4's surface
    /// say whether a solve started rather than only that sections were
    /// rewritten.
    @discardableResult
    func rebuildRoute(_ id: String) -> RebuildOutcome? {
        guard let train = store?.trains.first(where: { $0.id == id }) else { return nil }
        var rebuilt = train
        rebuilt.routeSections = TrainValidation.normalizeExportTrain(
            train, country: Region.resolved(train).code, stations: .empty).routeSections
        guard case .saved = replace(rebuilt, replacing: id) else { return nil }
        let solving = RideStatusCenter.shared.resolveAgain(rebuilt)
        return RebuildOutcome(sections: rebuilt.routeSections?.count ?? 0, solving: solving)
    }

    /// Publish the ids the store holds, so the editor can see an id collision
    /// before the save is refused rather than after (§8.3).
    private func publishRecordIndex() {
        RideStatusCenter.shared.publish(trainIDs: Set(store?.trains.map(\.id) ?? []))
    }

    func move(_ id: String, by offset: Int) {
        _ = mutate(region: region(of: id)) { workspace in
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
        region: Region,
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
                country: region.code)

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
        // The imported journeys were normalised under one region's company
        // rules, so they are tagged with that region here rather than being
        // re-derived from stops that may carry no codes at all.
        let next = TrainStore(
            schemaVersion: TrainValidation.schemaVersion,
            trains: commit.trains.map { train in
                var copy = train
                copy.region = train.region ?? region.code
                return copy
            })
        let grouped = try await Self.group(store: next)
        store = next
        selectedTrainID = commit.selectedTrainID
        state = .loaded(grouped)
        publishRecordIndex()
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

    func importJSON(_ text: String, region: Region) throws {
        var session = ImportEngine.Session(
            trains: store?.trains ?? [],
            selectedTrainID: selectedTrainID,
            focusedTrainID: nil,
            selectedDate: Dates.allDates,
            country: region.code
        )
        try session.replaceTrainStoreFromJSONText(text, sourceLabel: "JSON")
        let next = MergedStore.tagged(
            TrainStore(schemaVersion: TrainValidation.schemaVersion, trains: session.trains))
        store = next
        selectedTrainID = session.selectedTrainID
        publishRecordIndex()
        let selection = session.selectedTrainID
        Task {
            do {
                state = .loaded(try await Self.group(store: next))
                selectedTrainID = selection
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }

    func deleteAll() {
        _ = mutate(region: .jp) { workspace in
            StoreOperations.deleteAllTrains(in: &workspace)
        }
    }

    /// Same, plus the note about which samples are in the working set — which
    /// is no longer true of an empty one.
    func deleteAll(clearing library: RideLibrary) {
        deleteAll()
        library.forgetLoadedSamples()
    }

    /// The canonical JSON for every ride, whatever region each belongs to.
    func exportJSON() -> String? {
        guard let store else { return nil }
        return MergedStore.export(store)
    }

    /// Run one of RailCore's verified store transitions and rebuild the view
    /// model once. The selected id returned is useful for presenting a newly
    /// added or duplicated journey immediately.
    @discardableResult
    private func mutate(
        region: Region,
        operation: (inout StoreOperations.Workspace) -> StoreOperations.MutationResult?
    ) -> String? {
        guard !isImporting else { return selectedTrainID }
        guard let store else { return nil }
        var workspace = StoreOperations.Workspace(
            store: store,
            selectedTrainID: selectedTrainID,
            focusedTrainID: nil,
            country: region.code
        )
        guard operation(&workspace) != nil else { return workspace.selectedTrainID }
        // A journey created by one of these transitions — `addTrain`'s blank
        // scaffold, `duplicateTrain`'s copy — arrives without a region, and
        // the scaffold's stops are the only thing that could say. Tagging the
        // whole store settles it once, here, rather than at every reader.
        self.store = MergedStore.tagged(workspace.store)
        selectedTrainID = workspace.selectedTrainID
        publishRecordIndex()
        let selection = workspace.selectedTrainID
        let tagged = self.store ?? workspace.store
        Task {
            do {
                state = .loaded(try await Self.group(store: tagged))
                selectedTrainID = selection
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
        return workspace.selectedTrainID
    }

    /// The reader's own rides, or nothing at all.
    ///
    /// **Nothing at all is the first-launch state, deliberately.** The web app
    /// boots into a sample so that a browser tab arriving from a link has
    /// something on it; this app does not, because a sample loaded without
    /// being asked for is 201 journeys the reader has to delete before their
    /// own store means anything. The samples are on the data screen, one
    /// region at a time, and loading one is an action.
    func load(from library: RideLibrary) {
        state = .loading
        library.migrateLegacyStores()
        library.refreshSavedState()

        Task {
            do {
                let saved = library.hasSavedStore
                    ? try library.savedStore()
                    : TrainStore(schemaVersion: TrainValidation.schemaVersion, trains: [])
                let store = await MergedStore.regionTagged(saved)
                self.store = store
                publishRecordIndex()
                state = .loaded(try await Self.group(store: store))
                selectedTrainID = nil
                // Written back, because the point of the pass is that it
                // happens once: a correction that is not saved is a correction
                // that runs again on every launch. Only when it changed
                // something — a store this app wrote is already tagged, and
                // rewriting it on every launch would be a file touched for
                // nothing.
                if store != saved { library.save(store) }
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }

    /// Fold a store — a bundled sample, or a file the reader opened — into the
    /// working set and save the result.
    ///
    /// Returns the ids that were added or updated, so the caller can say how
    /// many rides arrived rather than how many the file held.
    @discardableResult
    func merge(_ incoming: TrainStore, into library: RideLibrary) async -> [String] {
        // Placed BEFORE the fold, not corrected after it. Every bundled sample
        // is a web-app store with no `region` in it, and outside Japan its
        // codes name no region on their face — so a sample folded in untagged
        // is drawn and solved as Japanese, and the Macanese one reported
        // 無法繪製路線 until the app was next launched. See ``RegionCodeIndex``.
        let tagged = await MergedStore.regionTagged(incoming)
        // Refused while the working set is still being read from disk. Folding
        // into a store that is not there yet would merge into nothing and then
        // SAVE that — which is how loading a sample seconds after launch
        // deletes every ride the reader already had. Read after the tagging
        // rather than before: an `await` is a suspension point, so a working
        // set checked before it is not the one being folded into.
        guard let current = store else { return [] }
        let next = MergedStore.merging(tagged, into: current)
        store = next
        publishRecordIndex()
        library.save(next)
        Task {
            do { state = .loaded(try await Self.group(store: next)) }
            catch { state = .failed(error.localizedDescription) }
        }
        return incoming.trains.map(\.id)
    }

    /// Replace the whole working set with one store — the 重置示例 action,
    /// which is the only place the web app's "this sample IS the store"
    /// meaning survives.
    func replaceAll(with incoming: TrainStore, into library: RideLibrary) async {
        let next = await MergedStore.regionTagged(incoming)
        store = next
        selectedTrainID = nil
        publishRecordIndex()
        library.save(next)
        Task {
            do { state = .loaded(try await Self.group(store: next)) }
            catch { state = .failed(error.localizedDescription) }
        }
    }

    /// A national store is 201 itineraries, so the grouping runs off the main
    /// actor and the main actor only sees the finished value.
    private nonisolated static func group(store: TrainStore) async throws -> Loaded {
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
            regions: MergedStore.regions(of: sorted),
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
