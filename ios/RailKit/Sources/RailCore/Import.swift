import Foundation

// =========================================================================
//  Import.swift — how a document becomes a store, one train at a time.
//
//  Ported from app-import.js §16 (the progressive load / import engine) and
//  the `appendImportedTrain` step it drives, which lives in app-store-ops.js
//  §19 next to the normalisers ``TrainValidation`` already carries.
//
//  ## What this file is actually about
//
//  Not "parse a file". The engine's product is a SEQUENCE. It resets, then
//  builds the store one train at a time — append, warm that train's route,
//  draw that train's line, add that train's card, report progress — and only
//  then repaints once with the cross-train styling. Every partial state along
//  the way is a state the user sees, which is why the order is a contract and
//  not an implementation detail. `port-fixtures/import.json` records the
//  whole stream for each case rather than the store at the end.
//
//  ## The two front doors, and the order they open in
//
//  ``TrainValidation`` documents that `normalizeImportedTrain` and
//  `validateTrain` disagree. What ``Session/appendImportedTrain(_:fallbackDate:)``
//  adds is that the import path runs **both**, in this order:
//
//      normalizeImportedTrain   §19 — key whitelist, canonical defaults
//      makeUniqueTrainId        §3.2 — a colliding id is renamed, not refused
//      validateTrain(normalizeExportTrain(…))   §33 — the schema
//
//  and the composition is neither door's rules:
//
//    * the key whitelist applies, though `validateTrain` has none;
//    * a numeric `train_type` is coerced to `""` by the first door, so the
//      second never sees the number it would have rejected — **the import
//      engine accepts a train the validator refuses**;
//    * `TRAIN_ID_PATTERN` applies, though the first door never checks it —
//      but against the id `makeUniqueTrainId` produced, so `" odr_001 "`
//      imports as `odr_001` and `"   "` imports as `train`;
//    * a falsy-but-present `route_sections` is *skipped* by the validator and
//      *replaced with `[]`* by the importer, so the two doors do not even
//      agree on what the train contains;
//    * a null row in `stops` or `route_sections` — the inputs that make
//      `validateTrain` raise a `TypeError` rather than reject — is turned
//      into a plain ``TrainValidation/ValidationError`` by the first door.
//      **Through this front door the crash is unreachable.** That is a
//      property of the composition, not of either function, and it is easy
//      for a port to lose by reordering the two calls.
//
//  ## Where the shell begins
//
//  Everything here is a decision or a sequence. Everything that *does*
//  something to the world is announced as an ``Event`` and performed by the
//  shell: painting, drawing a line, writing to IndexedDB, fetching a part.
//  ``Session/onEvent`` is that seam, and it is deliberately the same seam the
//  fixture measures across — the JavaScript's `renderAll`, `setImportProgress`,
//  `setStatus`, `appendTrainToLayers`, `appendTrainListItemIncremental` and
//  the journal write behind `PersistenceService.scheduleSave` are replaced by
//  recorders in `port-fixtures/import.mjs`, so what the port emits and what
//  the app calls are compared position for position.
//
//  Two things the JavaScript does are deliberately NOT modelled, because they
//  are wall-clock scheduling rather than logic: the 12 ms frame budget with
//  its `waitForImportPaint` yields, and the `renderProgressiveCounts` that
//  rides on them. They change how often the page paints mid-load and nothing
//  about what it ends up showing or in what order. A shell that wants them
//  drives ``Session/runProgressiveAppend(source:persistEachStep:fallbackDate:finalRender:onProgress:)``
//  from its own async loop; the engine is synchronous so that its ordering is
//  checkable at all.
// =========================================================================

/// The progressive load / import engine — app-import.js §16.
public enum ImportEngine {

    // MARK: - what a run announces

    /// `onProgress({ count, total, id })` — the per-train callback the JS
    /// entry points take as an option.
    ///
    /// `count` is how many trains have actually been appended, `total` is how
    /// many the source offered, and the two come apart whenever a source skips
    /// one: a published part that will not load is passed over silently, so a
    /// run can finish having reported 2 of 3.
    public struct Progress: Equatable, Sendable {
        public let count: Int
        public let total: Int
        public let id: String

        public init(count: Int, total: Int, id: String) {
            self.count = count
            self.total = total
            self.id = id
        }
    }

    /// One thing the engine asks the shell to do, in the order it asks.
    ///
    /// The labels are translation **keys**, not text: the JavaScript spells
    /// them through `I18N.t(key, params)` and the parameters are the run's own
    /// values (the caller's source label, `total`, and the counts already on
    /// the event or in the ``Result``). Resolving them is the shell's job for
    /// the same reason `Dates.dateLabelKey` returns a key — the interface
    /// language is UI state and the import rules do not depend on it.
    public enum Event: Equatable, Sendable {
        /// `setImportProgress(count, total, label)` — the progress bar.
        case progressBar(count: Int, total: Int, label: String)
        /// `setStatus(els.importStatus, message, tone)` — the status line.
        case status(label: String, tone: String?)
        /// `renderAll()` — a full authoritative repaint.
        case render
        /// `PersistenceService.scheduleSave()`.
        case persist
        /// `warmRouteCacheForTrain(train)` — solve this train's route off the
        /// render path. Failures are swallowed there, so it cannot fail here.
        case warmRoute(id: String)
        /// `appendTrainToLayers(train)` — one more line on the map.
        case drawTrain(id: String)
        /// `appendTrainListItemIncremental(train)` — one more card in the list.
        case appendListItem(id: String)
        /// `notifyImportFinished()` — `importInProgress` has just gone false
        /// and the store is consistent again.
        ///
        /// The JavaScript's comment on that function says it "must be called
        /// from EVERY such site", and every entry point announces it from a
        /// `finally`. The one place it is *not* announced is the re-entrancy
        /// guard, which returns before taking ownership of the flag — see
        /// ``Session/importInProgress``.
        case finished
    }

    /// The i18n keys the engine names. Constants rather than literals because
    /// which message a door emits, and in what order relative to the progress
    /// bar, is part of what the fixture pins.
    public enum MessageKey {
        public static let prepare = "prog.prepare"
        public static let loading = "prog.loading"
        public static let done = "prog.done"
        /// The placeholder id the append door reports before the first train.
        public static let preparingID = "prog.preparingId"
        /// `replaceTrainStoreFromJsonText`'s summary.
        public static let loadedAll = "status.loadedAll"
        /// The summary of both other replace doors.
        public static let restoredAll = "status.restoredAll"
    }

    /// What the two counting entry points return.
    public struct Result: Equatable, Sendable {
        public let count: Int
        public let ids: [String]

        public init(count: Int, ids: [String]) {
            self.count = count
            self.ids = ids
        }
    }

    // MARK: - the source

    /// `runProgressiveAppend`'s `source`: either a plain array of raw trains,
    /// or an async part source that fetches one train per network request.
    ///
    /// `fetch` returning nil means "that part could not be fetched or had an
    /// unexpected shape". The loop skips it and keeps going rather than
    /// aborting the whole boot on one flaky mobile request — which is why a
    /// run's appended count can be lower than its total.
    public enum Source {
        case trains([TrainValidation.JSON])
        case parts(total: Int, fetch: (Int) throws -> TrainValidation.JSON?)

        public var total: Int {
            switch self {
            case .trains(let rows): rows.count
            case .parts(let total, _): total
            }
        }

        func train(at index: Int) throws -> TrainValidation.JSON? {
            switch self {
            case .trains(let rows): rows[index]
            case .parts(_, let fetch): try fetch(index)
            }
        }
    }

    /// The four options both "replace" doors take.
    ///
    /// The JavaScript reads them as `Boolean(options.x)` for the two that
    /// default off and `options.x !== false` for the two that default on, so
    /// an option that is present but not a boolean is coerced rather than
    /// rejected — `finalPersist: 0` is *true*, because `0 !== false`. These
    /// are typed `Bool` because every value that reaches them is a literal at
    /// a call site inside the app, never anything a document can carry; the
    /// defaults below are what those two coercions produce for an absent key.
    public struct ReplaceOptions: Equatable, Sendable {
        public var persistEachStep: Bool
        public var finalPersist: Bool
        public var showAllDates: Bool
        public var selectFirstTrain: Bool

        public init(
            persistEachStep: Bool = false,
            finalPersist: Bool = true,
            showAllDates: Bool = false,
            selectFirstTrain: Bool = true
        ) {
            self.persistEachStep = persistEachStep
            self.finalPersist = finalPersist
            self.showAllDates = showAllDates
            self.selectFirstTrain = selectFirstTrain
        }
    }

    // MARK: - the session

    /// The mutable state one import owns, and the entry points that drive it.
    ///
    /// This is the slice of the app's globals that §16 reads and writes —
    /// `trainStore`, `selectedTrainId`, `focusedTrainId`, `selectedDate` and
    /// `importInProgress`. The rest of the shell's state (`dataSourceMode`,
    /// `storeRecoveryMode`, the route cache) is not here: the engine reads
    /// those only to hand them straight back to the shell, and modelling them
    /// would be modelling the data-source card rather than the import.
    public struct Session {

        /// `trainStore.trains`.
        ///
        /// Plainly mutable, like the global it mirrors: the store is what the
        /// editor, the deleter and the country switch all write, and the
        /// engine holds no invariant over it that it enforces itself. All it
        /// does is append and, on a failed append-mode import, truncate.
        public var trains: [Train]
        public var selectedTrainID: String?
        public var focusedTrainID: String?
        /// `selectedDate`, where ``Dates/allDates`` is the combined view.
        ///
        /// The JavaScript's global can also be null; that spelling and the
        /// empty string answer identically everywhere §16 reads it (both are
        /// falsy), so one `String` covers both.
        public var selectedDate: String

        /// `importInProgress` — a progressive load OWNS the store while it
        /// streams trains in.
        ///
        /// Every entry point refuses to start while it is set and returns an
        /// empty result, *without* clearing it and *without* announcing
        /// ``Event/finished``: the run that owns the flag still owns it, and
        /// announcing that the store is consistent again would be a lie.
        ///
        /// `internal(set)` rather than `private(set)` for one reason: this
        /// engine is synchronous, so a second call can never arrive while a
        /// first is in flight, and the guard would be unreachable — and
        /// therefore untested — without a way to stage the precondition.
        /// A shell must not write it; the doors own it.
        public internal(set) var importInProgress = false

        /// Which country's rules the company normaliser applies (§3.4).
        public var country: String
        /// The station table the export path resolves names and codes
        /// through. ``TrainValidation/StationTable/empty`` is not a stub: it
        /// is the state the app boots and imports in, before app-datasets.js
        /// has fetched anything.
        public var stations: TrainValidation.StationTable
        /// Where the shell's work is announced. See the file header.
        public var onEvent: ((Event) -> Void)?

        public init(
            trains: [Train] = [],
            selectedTrainID: String? = nil,
            focusedTrainID: String? = nil,
            selectedDate: String = Dates.allDates,
            country: String = "jp",
            stations: TrainValidation.StationTable = .empty,
            onEvent: ((Event) -> Void)? = nil
        ) {
            self.trains = trains
            self.selectedTrainID = selectedTrainID
            self.focusedTrainID = focusedTrainID
            self.selectedDate = selectedDate
            self.country = country
            self.stations = stations
            self.onEvent = onEvent
        }

        /// Loaded into a local before it is called, so that a sink which
        /// happens to touch the session cannot overlap this method's
        /// exclusive access to `self`.
        private func emit(_ event: Event) {
            let sink = onEvent
            sink?(event)
        }

        // MARK: per-train

        /// The concrete date to give an undated imported train: the currently
        /// selected date when one is active, otherwise nil so that
        /// id-inference decides.
        ///
        /// ``Dates/allDates`` is a sentinel and not a date, which is why the
        /// combined view produces no fallback. Only the append door consults
        /// this; both replace doors pass nil, so the same undated train lands
        /// in a different bucket depending on which door it came through.
        public var currentImportFallbackDate: String? {
            guard !selectedDate.isEmpty, selectedDate != Dates.allDates else { return nil }
            return selectedDate
        }

        /// `appendImportedTrain` — one train through **both** front doors.
        ///
        /// See the file header for what the composition accepts that neither
        /// door accepts alone. Two details of the order matter:
        ///
        /// `existingIDs` is built *before* the rename and is not updated by
        /// it, so the id `validateTrain` then checks for duplication is one it
        /// cannot possibly collide with — which is the point. Uniqueness
        /// against the live store is `makeUniqueTrainId`'s job, and the
        /// validator's duplicate rule is left doing nothing here.
        ///
        /// Only the incoming train is validated. Rebuilding and re-validating
        /// the whole canonical store on every append was an O(N²) pass that
        /// dominated large imports; the one authoritative
        /// `validateTrainStore` still runs in
        /// ``finalizeProgressiveLoad(_:finalPersist:showAllDates:selectFirstTrain:)``.
        @discardableResult
        public mutating func appendImportedTrain(
            _ raw: TrainValidation.JSON, fallbackDate: String? = nil
        ) throws -> String {
            var train = try TrainValidation.normalizeImportedTrain(
                raw, fallbackDate: fallbackDate, country: country, stations: stations)
            var existingIDs = Set(trains.map(\.id))
            train.id = TrainValidation.makeUniqueTrainId(train.id, existingIDs: existingIDs)
            try TrainValidation.validateTrain(
                Self.canonicalJSON(
                    TrainValidation.normalizeExportTrain(
                        train, country: country, stations: stations)),
                index: trains.count,
                ids: &existingIDs)
            trains.append(train)
            return train.id
        }

        /// The exported train as the dynamic value `validateTrain` reads.
        ///
        /// Encoded and re-parsed rather than projected field by field: the
        /// canonical shape is ``Train``'s own `Codable` conformance and
        /// spelling it a second time here would be a second copy of it, free
        /// to drift. Key order does not matter on this path — `validateTrain`
        /// is precisely the door that applies no key whitelist — and the model
        /// carries no numbers, so `JSONEncoder` has no chance to spell one
        /// differently from `JSON.stringify`.
        private static func canonicalJSON(_ train: Train) throws -> TrainValidation.JSON {
            let data = try JSONEncoder().encode(train)
            return try TrainValidation.JSON.parse(String(decoding: data, as: UTF8.self))
        }

        /// The date rules read a lighter train than the model carries — an id,
        /// a date and the stop times. Projected explicitly rather than by
        /// giving ``Train`` a conformance, because that would be an edit to
        /// another port's file.
        private static func dateTrains(_ trains: [Train]) -> [Dates.Train] {
            trains.map { train in
                Dates.Train(
                    id: train.id,
                    date: train.date,
                    stops: train.stops.map {
                        Dates.Stop(
                            arrival: $0.arrival, departure: $0.departure, stopType: $0.stopType)
                    })
            }
        }

        /// `buildCanonicalTrainStore()`, as the value `validateTrainStore` reads.
        private func canonicalStoreJSON() throws -> TrainValidation.JSON {
            let store = TrainValidation.buildCanonicalTrainStore(
                trains, country: country, stations: stations)
            let data = try JSONEncoder().encode(store)
            return try TrainValidation.JSON.parse(String(decoding: data, as: UTF8.self))
        }

        // MARK: the shared machinery

        /// `resetTrainStoreForProgressiveLoad` — clear the store and the
        /// selection before a full progressive reload.
        ///
        /// The JavaScript also closes the click popup and drops the cached
        /// route render items; both are caches of things about to stop
        /// existing, and both belong to the shell. The repaint that ends it
        /// is announced, because a caller that fails immediately afterwards
        /// has still cleared the screen — which is visible, and which the
        /// fixture records.
        public mutating func resetTrainStoreForProgressiveLoad() {
            trains.removeAll()
            selectedTrainID = nil
            focusedTrainID = nil
            emit(.render)
        }

        /// `runProgressiveAppend` — the shared per-train loop.
        ///
        /// Every entry point runs this same append → warm → draw → list →
        /// progress sequence, so a change to that ordering only has to be made
        /// once. The map is built up one train at a time: each iteration adds
        /// exactly ONE line and its markers, and never clears and redraws.
        ///
        /// `finalRender` exists because the two replace doors run
        /// `finalizeProgressiveLoad` → repaint immediately after this returns,
        /// with no paint in between, so the loop's own authoritative repaint
        /// would be a duplicate full pass. The append door has no finalize
        /// step and keeps it. Note the order at the end — render, then persist
        /// — which is the opposite of finalize's.
        ///
        /// A throw from `appendImportedTrain` is *not* caught: the loop stops
        /// where it stopped and the store keeps every train appended so far.
        /// Only the append door undoes that.
        @discardableResult
        public mutating func runProgressiveAppend(
            source: Source,
            persistEachStep: Bool = true,
            fallbackDate: String? = nil,
            finalRender: Bool = true,
            onProgress: ((Progress) -> Void)? = nil
        ) throws -> [String] {
            var appendedIDs: [String] = []
            let total = source.total
            for index in 0..<total {
                // An unfetchable part: already warned about, keep going.
                guard let raw = try source.train(at: index) else { continue }
                let id = try appendImportedTrain(raw, fallbackDate: fallbackDate)
                appendedIDs.append(id)
                emit(.warmRoute(id: id))
                emit(.drawTrain(id: id))
                emit(.appendListItem(id: id))
                onProgress?(Progress(count: appendedIDs.count, total: total, id: id))
            }
            if finalRender { emit(.render) }
            if persistEachStep { emit(.persist) }
            return appendedIDs
        }

        /// `finalizeProgressiveLoad` — the shared tail of the three replace
        /// doors: selection policy, then the one authoritative validation.
        ///
        /// `appendedIds[0] || null` is reproduced exactly, empty string
        /// included: an id that is the empty string would select nothing.
        /// `makeUniqueTrainId` cannot produce one — a blank base becomes
        /// `"train"` — so the branch is unreachable today, which is a reason
        /// to keep it rather than to drop it.
        ///
        /// A "load everything" caller passes `showAllDates` so the result
        /// lands on the combined view: the user asked for every trip, and
        /// auto-selecting a single day of what just loaded would hide most of
        /// it. Otherwise a selection the new store cannot render falls back to
        /// the EARLIEST available date, never the last.
        public mutating func finalizeProgressiveLoad(
            _ appendedIDs: [String],
            finalPersist: Bool = true,
            showAllDates: Bool = false,
            selectFirstTrain: Bool = true
        ) throws {
            selectedTrainID =
                selectFirstTrain ? appendedIDs.first.flatMap { $0.isEmpty ? nil : $0 } : nil
            focusedTrainID = nil
            if showAllDates { selectedDate = Dates.allDates }
            selectedDate = Dates.reconcileSelectedDate(
                selectedDate, trains: Self.dateTrains(trains))
            try TrainValidation.validateTrainStore(canonicalStoreJSON())
            if finalPersist { emit(.persist) }
            emit(.render)
        }

        // MARK: the four doors

        /// `replaceTrainStoreFromJsonText` — a pasted or opened JSON document.
        ///
        /// The odd one out of the three store doors, in three ways at once: it
        /// always persists each step (so a run emits two ``Event/persist``
        /// events, the loop's and finalize's), its status line comes *before*
        /// the final progress bar rather than after, and an empty document is
        /// an error here where the value door treats it as a valid
        /// replacement.
        ///
        /// The shell owns what is left: leaving sample mode on a static
        /// deploy, and `PersistenceService.exitRecoveryMode()` once every
        /// train has loaded.
        public mutating func replaceTrainStoreFromJSONText(
            _ text: String, sourceLabel: String = "JSON"
        ) throws {
            // A concurrent call is ignored rather than queued; the running
            // import owns the store.
            guard !importInProgress else { return }
            importInProgress = true
            defer {
                importInProgress = false
                emit(.finished)
            }
            let store = try TrainValidation.parseImportedCanonicalStore(text: text)
            let rows = Self.trainRows(of: store)
            guard !rows.isEmpty else {
                throw TrainValidation.ValidationError(
                    kind: .error, message: "\(sourceLabel) contains no trains.")
            }
            let total = rows.count
            resetTrainStoreForProgressiveLoad()
            emit(.progressBar(count: 0, total: total, label: MessageKey.prepare))
            // The sink, not `self`: `onProgress` is an optional closure
            // parameter and therefore escaping, and an escaping closure may
            // not capture the mutable `self` of a mutating method.
            let sink = onEvent
            let appendedIDs = try runProgressiveAppend(
                source: .trains(rows), persistEachStep: true, finalRender: false
            ) { progress in
                // Per-item progress lives only in the bar's own text; the
                // status line is left for the final summary so the two do not
                // echo the same "n/total" at once.
                sink?(
                    .progressBar(
                        count: progress.count, total: progress.total, label: MessageKey.loading))
            }
            try finalizeProgressiveLoad(appendedIDs, finalPersist: true)
            emit(.status(label: MessageKey.loadedAll, tone: "ok"))
            emit(.progressBar(count: total, total: total, label: MessageKey.done))
        }

        /// `replaceTrainStoreFromStoreProgressive` — an already-parsed store
        /// (a server response, the built-in defaults, an SSE payload).
        ///
        /// The empty-store branch is a genuine replacement rather than a
        /// no-op: switching to a country with no saved data has to clear what
        /// is on screen instead of leaving the previous store's trains
        /// visible. It emits no progress bar at either end and forces
        /// `selectFirstTrain` off.
        ///
        /// It is reached less often than it looks. `store || { trains: [] }`
        /// synthesises an object whose `trains` IS an array, so a nil store
        /// takes the full-store branch of `parseImportedCanonicalStore` — and
        /// the synthesised object has no `schema_version`, so it is rejected.
        /// Passing no store therefore throws instead of clearing the screen;
        /// only an explicit `{"schema_version": "1.3", "trains": []}` reaches
        /// the branch. Reproduced, not fixed.
        @discardableResult
        public mutating func replaceTrainStoreFromStore(
            _ store: TrainValidation.JSON?,
            sourceLabel: String = "JSON",
            options: ReplaceOptions = ReplaceOptions()
        ) throws -> Result {
            guard !importInProgress else { return Result(count: 0, ids: []) }
            importInProgress = true
            defer {
                importInProgress = false
                emit(.finished)
            }
            let fallback = TrainValidation.JSON.object(
                TrainValidation.JSON.Object([("trains", .array([]))]))
            let source = (store?.isTruthy == true) ? store! : fallback
            let parsed = try TrainValidation.parseImportedCanonicalStore(value: source)
            let rows = Self.trainRows(of: parsed)
            guard !rows.isEmpty else {
                resetTrainStoreForProgressiveLoad()
                try finalizeProgressiveLoad(
                    [],
                    finalPersist: options.finalPersist,
                    showAllDates: options.showAllDates,
                    selectFirstTrain: false)
                return Result(count: 0, ids: [])
            }
            let total = rows.count
            resetTrainStoreForProgressiveLoad()
            emit(.progressBar(count: 0, total: total, label: MessageKey.prepare))
            // The sink, not `self`: `onProgress` is an optional closure
            // parameter and therefore escaping, and an escaping closure may
            // not capture the mutable `self` of a mutating method.
            let sink = onEvent
            let appendedIDs = try runProgressiveAppend(
                source: .trains(rows),
                persistEachStep: options.persistEachStep,
                finalRender: false
            ) { progress in
                sink?(
                    .progressBar(
                        count: progress.count, total: progress.total, label: MessageKey.loading))
            }
            try finalizeProgressiveLoad(
                appendedIDs,
                finalPersist: options.finalPersist,
                showAllDates: options.showAllDates,
                selectFirstTrain: options.selectFirstTrain)
            emit(.progressBar(count: total, total: total, label: MessageKey.done))
            emit(.status(label: MessageKey.restoredAll, tone: "ok"))
            return Result(count: appendedIDs.count, ids: appendedIDs)
        }

        /// `replaceTrainStoreFromPartsProgressive` — the static deploy's
        /// counterpart, over the published per-train parts.
        ///
        /// `fetchPart` is handed the part INDEX and answers with that part's
        /// raw train, or nil when it could not be fetched or had an unexpected
        /// shape. The network, the retry and the prefetch window belong to the
        /// shell; ``ImportEngine/prefetchIndices(from:count:)`` and
        /// ``ImportEngine/acceptPart(_:)`` are the two rules it needs.
        ///
        /// The only door whose "done" bar does not report `total`: it reports
        /// the trains that actually arrived, and its status tone turns warn
        /// when any were skipped. Note also that it treats "nothing loaded" as
        /// a successful empty load rather than as an error, unlike both store
        /// doors.
        @discardableResult
        public mutating func replaceTrainStoreFromParts(
            total: Int,
            sourceLabel: String = "JSON",
            options: ReplaceOptions = ReplaceOptions(),
            fetchPart: @escaping (Int) throws -> TrainValidation.JSON?
        ) throws -> Result {
            guard !importInProgress else { return Result(count: 0, ids: []) }
            importInProgress = true
            defer {
                importInProgress = false
                emit(.finished)
            }
            resetTrainStoreForProgressiveLoad()
            emit(.progressBar(count: 0, total: total, label: MessageKey.prepare))
            // The sink, not `self`: `onProgress` is an optional closure
            // parameter and therefore escaping, and an escaping closure may
            // not capture the mutable `self` of a mutating method.
            let sink = onEvent
            let appendedIDs = try runProgressiveAppend(
                source: .parts(total: total, fetch: fetchPart),
                persistEachStep: options.persistEachStep,
                finalRender: false
            ) { progress in
                sink?(
                    .progressBar(
                        count: progress.count, total: progress.total, label: MessageKey.loading))
            }
            try finalizeProgressiveLoad(
                appendedIDs,
                finalPersist: options.finalPersist,
                showAllDates: options.showAllDates,
                selectFirstTrain: options.selectFirstTrain)
            let skipped = total - appendedIDs.count
            // The bar's own arguments are (total, total); it is the message
            // parameter that counts what arrived, which is why the count is
            // also on the ``Result`` for the shell to interpolate.
            emit(.progressBar(count: total, total: total, label: MessageKey.done))
            emit(.status(label: MessageKey.restoredAll, tone: skipped != 0 ? "warn" : "ok"))
            return Result(count: appendedIDs.count, ids: appendedIDs)
        }

        /// `importCanonicalStoreAppendProgressive` — append mode, the third
        /// progressive entry point.
        ///
        /// Unlike the replace doors it does NOT reset the store, it is the
        /// only one that passes ``currentImportFallbackDate`` (so an undated
        /// train joins the day being looked at — §3.1), and it is the only one
        /// that ROLLS BACK: `appendImportedTrain` pushes each valid train
        /// before an invalid one throws, and without the truncation below the
        /// half-appended prefix stayed in the store and the next edit
        /// autosaved it.
        ///
        /// It also has no finalize step, so nothing here reconciles the
        /// selected date or runs the authoritative `validateTrainStore` — the
        /// loop's own `renderAll` and `scheduleSave` end it.
        ///
        /// `preparingID` is the placeholder the JavaScript reports as the id
        /// of the not-yet-started first train; it is `I18N.t("prog.preparingId")`
        /// there, so the shell resolves ``MessageKey/preparingID`` and passes
        /// the text in.
        ///
        /// Leaving read-only recovery mode once everything loaded is the
        /// shell's — it owns `storeRecoveryMode` and the persist that the
        /// recovery guard swallowed.
        @discardableResult
        public mutating func importCanonicalStoreAppendProgressive(
            _ document: TrainValidation.JSON,
            preparingID: String = MessageKey.preparingID,
            onProgress: ((Progress) -> Void)? = nil
        ) throws -> Result {
            guard !importInProgress else { return Result(count: 0, ids: []) }
            importInProgress = true
            defer {
                importInProgress = false
                emit(.finished)
            }
            let store = try TrainValidation.parseImportedCanonicalStore(value: document)
            let rows = Self.trainRows(of: store)
            guard !rows.isEmpty else {
                throw TrainValidation.ValidationError(
                    kind: .error, message: "Imported store contains no trains.")
            }
            onProgress?(Progress(count: 0, total: rows.count, id: preparingID))
            let baselineCount = trains.count
            do {
                let appendedIDs = try runProgressiveAppend(
                    source: .trains(rows),
                    persistEachStep: true,
                    fallbackDate: currentImportFallbackDate,
                    onProgress: onProgress)
                return Result(count: appendedIDs.count, ids: appendedIDs)
            } catch {
                if trains.count > baselineCount {
                    trains.removeLast(trains.count - baselineCount)
                }
                emit(.render)
                throw error
            }
        }

        /// `importedStore.trains` — the array the parser guarantees is there.
        private static func trainRows(of store: TrainValidation.JSON) -> [TrainValidation.JSON] {
            guard case .array(let rows)? = store["trains"] else { return [] }
            return rows
        }
    }

    // MARK: - the published dataset

    /// `makeManifestLoader`'s shape test — what a fetched manifest has to be
    /// before anything is loaded from it.
    ///
    /// Returns nil for everything it rejects, which is how the loader
    /// memoises "no dataset published (or unreachable)" for the session. The
    /// manifest has no key whitelist, so anything else it carries is passed
    /// through untouched; `attachPartsApi` stamps `parts_api` for datasets
    /// living outside the sample directory, so the parts fetcher knows where
    /// to look. The stamp takes the position `{ ...manifest, parts_api: api }`
    /// gives it: appended, unless the manifest already had the key, in which
    /// case that position is kept and the value replaced.
    public static func acceptedManifest(
        _ body: TrainValidation.JSON?, api: String, attachPartsApi: Bool = false
    ) -> TrainValidation.JSON? {
        guard let body, body.isTruthy else { return nil }
        guard body["format"] == .number(1) else { return nil }
        guard case .array(let parts)? = body["parts"], !parts.isEmpty else { return nil }
        let version = body["schema_version"] ?? .null
        guard TrainValidation.acceptedSchemaVersions.contains(where: { version == .string($0) })
        else { return nil }
        guard attachPartsApi, case .object(let object) = body else { return body }
        let pairs = object.keys.map { ($0, object[$0] ?? .null) }
        return .object(TrainValidation.JSON.Object(pairs + [("parts_api", .string(api))]))
    }

    /// `sampleManifestDates` — the manifest's per-day index, defensively
    /// filtered to non-empty name lists.
    ///
    /// The empty-string key is dropped by `key &&`, which is what keeps the
    /// undated bucket (precompute files an undated train under `""`) out of
    /// the boot's random-day choice. The sort is `Array.prototype.sort` with
    /// no comparator — UTF-16 code units, not a locale collation, so
    /// `"2026-1-3"` sorts before `"2026-12-03"` and both before `"2026-2-03"`.
    public static func sampleManifestDates(_ manifest: TrainValidation.JSON?) -> [String] {
        let dates = manifest?["dates"] ?? .null
        // `!dates || typeof dates !== "object"`. An array is an object, so it
        // reaches the filter with its indices as keys; null is caught by the
        // falsiness test rather than by `typeof`.
        guard dates.isTruthy else { return [] }
        switch dates {
        case .object, .array: break
        default: return []
        }
        let keys = dates.ownKeys.filter { key in
            guard !key.isEmpty else { return false }
            guard case .array(let names)? = Self.member(dates, key) else { return false }
            return !names.isEmpty
        }
        // `Array.prototype.sort` with no comparator, spelled as a strict weak
        // ordering: `≤ and not ≥`. Not `a != b && ≤`, because Swift's `!=` on
        // String is canonical equivalence and this ordering is not.
        return keys.sorted { a, b in
            JSNumber.stringLessOrEqual(a, b) && !JSNumber.stringLessOrEqual(b, a)
        }
    }

    /// `container[key]` the way JavaScript reads it, including the case
    /// ``TrainValidation/JSON/subscript(_:)`` deliberately does not cover.
    ///
    /// `ownKeys` reports an array's indices as string keys — that is how an
    /// array handed to `assertOnlyKeys` names `"0"` as an unsupported field —
    /// so a caller that walks `ownKeys` and then reads each key back has to be
    /// able to read those indices too. The object subscript answers nil for an
    /// array, which for `{"dates": [["part-000"]]}` would silently drop a day
    /// the JavaScript keeps.
    static func member(_ container: TrainValidation.JSON, _ key: String)
        -> TrainValidation.JSON?
    {
        if case .array(let items) = container, let index = Int(key),
            items.indices.contains(index)
        {
            return items[index]
        }
        return container[key]
    }

    /// Which part names one sample load reads — `loadSampleData`'s day rule.
    ///
    /// A day the manifest does not list falls back to the WHOLE sample rather
    /// than to nothing, while the mode still says "one day": the mode is
    /// decided by the argument and the names by the manifest, and the two are
    /// allowed to disagree. A day whose list is present but empty loads zero
    /// parts, because an empty array is still an array.
    public static func sampleParts(manifest: TrainValidation.JSON, date: String?)
        -> [TrainValidation.JSON]
    {
        if let date, !date.isEmpty, let dates = manifest["dates"], dates.isTruthy,
            case .array(let names)? = member(dates, date)
        {
            return names
        }
        guard case .array(let parts)? = manifest["parts"] else { return [] }
        return parts
    }

    /// What `loadSampleData` decides before it hands over to the parts door.
    ///
    /// Sample data has NO memory: persistence is disabled for the whole load,
    /// which is why both persist flags are forced off whatever the caller
    /// asked for. An explicit "load the whole sample" click (no boot options)
    /// lands on the combined view instead of dropping to one of its days.
    public struct SampleLoad: Equatable, Sendable {
        public let parts: [TrainValidation.JSON]
        /// `dataSourceMode` — `"sample-single"` or `"sample-all"`.
        public let mode: String
        /// `sampleModeDate` — the day, or nil for the whole sample.
        public let day: String?
        /// The i18n key naming the source in the status line.
        public let labelKey: String
        public let options: ReplaceOptions
    }

    public static func sampleLoad(
        manifest: TrainValidation.JSON, date: String?, bootLoadOptions: ReplaceOptions? = nil
    ) -> SampleLoad {
        let isDay = date != nil && !(date ?? "").isEmpty
        let boot =
            bootLoadOptions ?? ReplaceOptions(showAllDates: !isDay, selectFirstTrain: false)
        return SampleLoad(
            parts: sampleParts(manifest: manifest, date: date),
            mode: isDay ? "sample-single" : "sample-all",
            day: isDay ? date : nil,
            labelKey: isDay ? "src.sampleDay" : "src.sampleAll",
            options: ReplaceOptions(
                persistEachStep: false,
                finalPersist: false,
                showAllDates: boot.showAllDates,
                selectFirstTrain: boot.selectFirstTrain))
    }

    // MARK: - one published part

    /// How a part's precomputed solve enters the runtime route cache.
    ///
    /// Safe by construction either way: a mismatched cache key is simply never
    /// looked up, and a known-unsolvable train seeds the negative cache so the
    /// doomed graph build is skipped exactly as if this session had already
    /// solved (and failed) it.
    public enum SeedAction: Equatable, Sendable {
        case none
        /// `RouteService.seedNegative(cacheKey)`.
        case negative(cacheKey: String)
        /// `RouteService.seed(cacheKey, features)` — published parts are the
        /// authoritative output of the current solver, so this always REPLACES
        /// a warmed entry rather than deferring to it.
        case features(cacheKey: String, features: [TrainValidation.JSON])
    }

    /// `seedRouteCacheFromPart` — which cache action one part asks for.
    ///
    /// `unsolvable` wins over `features` when both are present, and the test
    /// on it is `=== true`, so a truthy non-boolean such as the string
    /// `"true"` falls through to the features branch instead.
    public static func seedAction(for part: TrainValidation.JSON?) -> SeedAction {
        guard let route = part?["route"], route.isTruthy else { return .none }
        guard case .string(let cacheKey)? = route["cache_key"], !cacheKey.isEmpty else {
            return .none
        }
        if route["unsolvable"] == .bool(true) { return .negative(cacheKey: cacheKey) }
        if case .array(let features)? = route["features"], !features.isEmpty {
            return .features(cacheKey: cacheKey, features: features)
        }
        return .none
    }

    /// One usable part: the raw train it carries, and the cache action to
    /// apply before that train is appended.
    public struct Part: Equatable, Sendable {
        public let train: TrainValidation.JSON
        public let seed: SeedAction
    }

    /// `makeTrainPartsSource`'s per-part shape test.
    ///
    /// nil means "skip this train": a part that arrives with an unexpected
    /// shape is warned about and passed over, exactly like one that would not
    /// download. The two are bundled here because the JavaScript seeds the
    /// cache *before* returning the train, and a shell that did it the other
    /// way round would warm a train whose solve had not been seeded yet.
    public static func acceptPart(_ part: TrainValidation.JSON?) -> Part? {
        guard let part, part.isTruthy else { return nil }
        guard part["format"] == .number(1), let train = part["train"], train.isTruthy else {
            return nil
        }
        return Part(train: train, seed: seedAction(for: part))
    }

    /// How wide `PREFETCH_WINDOW`'s window is, in parts.
    ///
    /// Five, not four: the loop is `ahead <= index + 4`, inclusive at both
    /// ends. Keeping this many fetches in flight ahead of the append cursor is
    /// what overlaps the per-file network latency with the append/draw work,
    /// instead of serialising a hundred round-trips.
    public static let prefetchWindow = 4

    /// The part indices to have in flight when the cursor reaches `index`.
    ///
    /// Clamped to the last index, so the window narrows to nothing at the tail
    /// rather than running off the end. Each of them is fetched at most once —
    /// the in-flight map is consulted first — so the shell must dedupe, not
    /// this.
    public static func prefetchIndices(from index: Int, count: Int) -> [Int] {
        let last = min(index + prefetchWindow, count - 1)
        guard last >= index else { return [] }
        return Array(index...last)
    }
}
