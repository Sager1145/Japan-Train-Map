import Foundation
import Testing

@testable import RailCore

/// `RailCore.ImportEngine` against app-import.js §16 and the
/// `appendImportedTrain` step it drives, over `port-fixtures/import.json`.
///
/// ## Why the event stream is the assertion
///
/// The engine's product is an ORDER, not a value. It resets the store, then
/// builds it one train at a time — append, warm, draw, add a card, report —
/// and repaints authoritatively once at the end. Each of those is a state the
/// user sees, so a port that lands on the same 201 trains having drawn them
/// after the final repaint, or reported progress before appending, or emitted
/// its "done" bar while a train was still arriving, is wrong in a way no
/// end-state comparison can detect. Every run case below therefore compares
/// the whole recorded stream element for element before it looks at the store.
///
/// ## What these tests are guarding against specifically
///
///   - **The two front doors are composed, not chosen between.** A numeric
///     `train_type` is accepted here and rejected by `validateTrain` alone; an
///     id outside `TRAIN_ID_PATTERN` is rejected here though
///     `normalizeImportedTrain` alone accepts it; `"  odr_001  "` imports
///     trimmed and `"   "` imports as `train`. Swapping the two calls, or
///     dropping either, passes a naive fixture and fails these.
///   - **Duplicate ids are renamed, not refused.** Two identical trains in one
///     document import as `lean_001` and `lean_001-2`, which is the opposite of
///     what `validateTrainStore` would say about the same document.
///   - **Only append mode rolls back.** The replace doors leave the
///     half-appended prefix in the store.
///   - **The three doors disagree about an empty document**, about where the
///     status line sits relative to the final bar, and about how many times
///     they persist.
///   - **A skipped part costs no events at all**, so `count` and the loop
///     index come apart and the final bar stops reporting `total`.
struct ImportParityTests {

    // MARK: - fixture shape

    struct Fixture: Decodable {

        /// One recorded shell call. The generator writes a tagged union with
        /// a one-letter tag; the fields that do not apply are simply absent.
        struct EventRow: Decodable, Equatable {
            let e: String
            let count: Int?
            let total: Int?
            let label: String?
            let tone: String?
            let id: String?
        }

        struct State: Decodable {
            let trainIds: [String]
            let selectedTrainId: String?
            let focusedTrainId: String?
            let selectedDate: String
            let importInProgress: Bool
        }

        struct Options: Decodable {
            let persistEachStep: Bool?
            let finalPersist: Bool?
            let showAllDates: Bool?
            let selectFirstTrain: Bool?

            /// The JavaScript reads an absent key through `Boolean(undefined)`
            /// or `undefined !== false`, which is exactly what
            /// ``ImportEngine/ReplaceOptions``'s defaults spell.
            var resolved: ImportEngine.ReplaceOptions {
                ImportEngine.ReplaceOptions(
                    persistEachStep: persistEachStep ?? false,
                    finalPersist: finalPersist ?? true,
                    showAllDates: showAllDates ?? false,
                    selectFirstTrain: selectFirstTrain ?? true)
            }
        }

        struct RunCase: Decodable {
            let label: String
            let note: String?
            /// Which entry point: text / store / append / parts.
            let door: String
            let options: Options
            let country: String
            let selectedDate: String
            /// The canonical trains already in the store, as JSON text.
            let existing: String
            /// Named instead of repeated for the two committed stores — the
            /// port reads the same file the generator did.
            let storeFile: String?
            let input: String?
            /// A literal string handed to the text door, so it parses first.
            let rawText: String?
            let nullDocument: Bool?
            let recordProgress: Bool?
            /// Part name → body, for the parts door.
            let parts: String?
            let importAlreadyRunning: Bool?
            let events: [EventRow]
            let ok: Bool
            let returned: String?
            let errorName: String?
            let error: String?
            let state: State
        }

        struct AppendCase: Decodable {
            let label: String
            let note: String?
            let country: String
            let selectedDate: String
            let existing: String
            let train: String
            /// Whether the call passed the argument at all. Absent means the
            /// JavaScript's default ran, which is `currentImportFallbackDate()`
            /// and not null.
            let explicitFallback: Bool
            let fallbackDate: String?
            let ok: Bool
            let id: String?
            let store: String?
            let errorName: String?
            let error: String?
        }

        struct FallbackDateCase: Decodable {
            let selectedDate: String?
            let result: String?
        }

        struct ManifestCase: Decodable {
            let label: String
            let payload: String
            let api: String
            let attachPartsApi: Bool
            let fetchFails: Bool
            let manifest: String?
        }

        struct ManifestDatesCase: Decodable {
            let label: String
            let manifest: String
            let dates: [String]
        }

        struct PartCase: Decodable {
            let label: String
            let names: [String]
            let bodies: String
            let failures: [String: Int]
            let total: Int
            let ids: [String?]
            let fetched: [String]
        }

        struct SeedCase: Decodable {
            let label: String
            let part: String
            let cached: Bool
            let negative: Bool
            let cacheSize: Int
        }

        struct SampleNameCase: Decodable {
            let label: String
            let manifest: String
            let date: String?
            let ok: Bool
            let dataSourceMode: String?
            let sampleModeDate: String?
            let picked: String?
        }

        let cases: [RunCase]
        let appendCases: [AppendCase]
        let fallbackDateCases: [FallbackDateCase]
        let manifestCases: [ManifestCase]
        let manifestDatesCases: [ManifestDatesCase]
        let partCases: [PartCase]
        let seedCases: [SeedCase]
        let sampleNameCases: [SampleNameCase]
    }

    static func load() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "import.json")
    }

    // MARK: - helpers

    /// The canonical spelling of an encodable value: keys sorted by UTF-16
    /// code unit, which is what the generator's `stableStringify` writes.
    ///
    /// Round-tripped through the parser rather than compared as raw encoder
    /// bytes, for the reason `TrainValidationParityTests.canonicalText` gives:
    /// `JSONEncoder` emits keys in no defined order and escapes `/` where
    /// `JSON.stringify` does not, so comparing its output would compare two
    /// encoders' habits rather than two values.
    static func canonicalText<T: Encodable>(_ value: T) throws -> String {
        let data = try JSONEncoder().encode(value)
        return try TrainValidation.JSON.parse(String(decoding: data, as: UTF8.self)).canonicalText
    }

    /// Compares a call's outcome with the JavaScript's.
    ///
    /// Only a deliberate `Error` has its message compared: a `SyntaxError`
    /// carries V8's parser wording and a `TypeError` carries V8's own, and
    /// pinning either would make a Node upgrade look like a port regression.
    /// The *kind* is always pinned, because "it rejected this" and "it fell
    /// over on this" are different answers.
    static func expectVerdict(
        _ label: String, ok: Bool, errorName: String?, error: String?, _ run: () throws -> Void
    ) {
        do {
            try run()
            #expect(ok, "\(label): expected \(errorName ?? "a throw"), got success")
        } catch let failure as TrainValidation.ValidationError {
            #expect(!ok, "\(label): expected success, threw \(failure.message)")
            #expect(failure.kind.rawValue == errorName, "\(label): wrong error kind")
            if errorName == "Error" {
                #expect(failure.message == error, "\(label): wrong message")
            }
        } catch {
            Issue.record("\(label): threw an unexpected \(type(of: error)): \(error)")
        }
    }

    /// The trains a case starts with, decoded from the canonical text the
    /// generator assigned straight into `trainStore`.
    static func existingTrains(_ text: String) throws -> [Train] {
        try JSONDecoder().decode([Train].self, from: Data(text.utf8))
    }

    static func storeText(_ file: String) throws -> String {
        let url = try PortFixtures.repositoryRoot().appending(path: "app/data/\(file)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// Re-spells an emitted ``ImportEngine/Event`` in the generator's shape,
    /// so the two streams compare as data rather than through a hand-written
    /// case-by-case assertion.
    static func row(_ event: ImportEngine.Event) -> Fixture.EventRow {
        switch event {
        case .progressBar(let count, let total, let label):
            Fixture.EventRow(e: "bar", count: count, total: total, label: label, tone: nil, id: nil)
        case .status(let label, let tone):
            Fixture.EventRow(e: "status", count: nil, total: nil, label: label, tone: tone, id: nil)
        case .render:
            Fixture.EventRow(e: "render", count: nil, total: nil, label: nil, tone: nil, id: nil)
        case .persist:
            Fixture.EventRow(e: "persist", count: nil, total: nil, label: nil, tone: nil, id: nil)
        case .warmRoute(let id):
            Fixture.EventRow(e: "warm", count: nil, total: nil, label: nil, tone: nil, id: id)
        case .drawTrain(let id):
            Fixture.EventRow(e: "draw", count: nil, total: nil, label: nil, tone: nil, id: id)
        case .appendListItem(let id):
            Fixture.EventRow(e: "listItem", count: nil, total: nil, label: nil, tone: nil, id: id)
        case .finished:
            Fixture.EventRow(e: "finished", count: nil, total: nil, label: nil, tone: nil, id: nil)
        }
    }

    static func progressRow(_ progress: ImportEngine.Progress) -> Fixture.EventRow {
        Fixture.EventRow(
            e: "progress", count: progress.count, total: progress.total, label: nil, tone: nil,
            id: progress.id)
    }

    // MARK: - coverage

    /// The cases this suite exists for, by name.
    ///
    /// Every assertion below is a loop over a fixture section, so a fixture
    /// that lost its interesting cases would still pass — loudly reporting
    /// nothing. These are the shapes that separate a real port from one that
    /// picked a single door and stopped; if a name here disappears, the
    /// generator changed and this suite has to be re-read, not re-run.
    @Test func coverage() throws {
        let fixture = try Self.load()
        let runs = Set(fixture.cases.map(\.label))
        for required in [
            // both committed stores, through the doors that differ
            "the committed jp store, replaced from a parsed value",
            "the committed tw store, replaced from a parsed value",
            "the committed jp store, replaced from JSON text",
            "the committed tw store, appended over an empty store",
            // the three answers to an empty document
            "an empty store, replaced from a parsed value",
            "an empty store, replaced from JSON text",
            "an empty store, appended",
            // the document shapes
            "a single train object as the whole document",
            "a store with exactly one train",
            "malformed JSON text",
            "a document with an unknown top-level key",
            "a document with an unknown top-level key and no trains array",
            "two trains sharing an id in one document",
            "a train whose id collides with one already in the store",
            // rollback, and its absence
            "append mode rolls the store back when a train fails",
            "a replace path does NOT roll back when a train fails",
            // the asymmetry, end to end
            "train_type is a number",
            "an id that is not in the documented charset",
            "an id with surrounding whitespace",
            "a stop row that is null",
            "a route_sections row that is null",
            // the parts door's own skipping
            "a published part that cannot be fetched is skipped",
        ] {
            #expect(runs.contains(required), "the fixture no longer covers: \(required)")
        }
        #expect(fixture.cases.count >= 60, "run cases shrank")
        #expect(fixture.appendCases.count >= 20, "append cases shrank")
        #expect(fixture.manifestCases.count >= 10, "manifest cases shrank")
        #expect(fixture.manifestDatesCases.count >= 8, "manifest-date cases shrank")
        #expect(fixture.partCases.count >= 8, "part cases shrank")
        #expect(fixture.seedCases.count >= 10, "seed cases shrank")
        #expect(fixture.sampleNameCases.count >= 5, "sample-load cases shrank")
        #expect(fixture.fallbackDateCases.count >= 6, "fallback-date cases shrank")
        // The two committed stores, whole: 201 + 28 trains, and four events
        // each plus the door's own bookends.
        let japanese = fixture.cases.first { $0.label == "the committed jp store, replaced from a parsed value" }
        #expect(japanese?.state.trainIds.count == 201, "the jp store is no longer 201 trains")
        #expect(japanese?.events.count == 810, "the jp run no longer emits 810 events")
    }

    // MARK: - whole runs

    /// Every progressive run: the ordered event stream first, then what the
    /// door returned, then the state it left behind.
    @Test func progressiveRuns() throws {
        let fixture = try Self.load()
        for testCase in fixture.cases {
            // One log, shared by the ambient shell events and the caller's own
            // `onProgress`, so the merged order is what the JavaScript's single
            // recorder saw.
            let log = EventLog()
            var session = ImportEngine.Session(
                trains: try Self.existingTrains(testCase.existing),
                selectedDate: testCase.selectedDate,
                country: testCase.country,
                stations: .empty,
                onEvent: { log.append(Self.row($0)) })
            if testCase.importAlreadyRunning == true {
                // The precondition the re-entrancy guard exists for. A
                // synchronous engine can never have a run genuinely in flight,
                // so the flag is staged directly — which is what its
                // `internal(set)` exists for.
                session.importInProgress = true
            }
            let onProgress: (ImportEngine.Progress) -> Void = { log.append(Self.progressRow($0)) }

            var returned: ImportEngine.Result?
            Self.expectVerdict(
                testCase.label, ok: testCase.ok, errorName: testCase.errorName,
                error: testCase.error
            ) {
                switch testCase.door {
                case "text":
                    let text: String
                    if let raw = testCase.rawText {
                        text = raw
                    } else if testCase.nullDocument == true {
                        text = "null"
                    } else {
                        text = try Self.documentText(testCase)
                    }
                    try session.replaceTrainStoreFromJSONText(text, sourceLabel: "SRC")
                case "store":
                    let document: TrainValidation.JSON? =
                        testCase.nullDocument == true
                        ? nil : try TrainValidation.JSON.parse(Self.documentText(testCase))
                    returned = try session.replaceTrainStoreFromStore(
                        document, sourceLabel: "SRC", options: testCase.options.resolved)
                case "append":
                    let document = try TrainValidation.JSON.parse(Self.documentText(testCase))
                    returned = try session.importCanonicalStoreAppendProgressive(
                        document,
                        onProgress: testCase.recordProgress == true ? onProgress : nil)
                case "parts":
                    let source = try PartsSource(testCase)
                    returned = try session.replaceTrainStoreFromParts(
                        total: source.total, sourceLabel: "SRC",
                        options: testCase.options.resolved,
                        fetchPart: source.fetch)
                default:
                    Issue.record("\(testCase.label): unknown door \(testCase.door)")
                }
            }

            // The stream, element for element and length included — a port
            // that emits a prefix of the right events is not a port that emits
            // the right events.
            #expect(
                log.rows == testCase.events,
                "\(testCase.label): event stream differs\n  expected \(testCase.events)\n  got      \(log.rows)"
            )
            if testCase.ok, let expected = testCase.returned {
                // The text door returns nothing at all, which the generator
                // spells as JSON null.
                let actual =
                    returned.map { "{\"count\":\($0.count),\"ids\":\(Self.idsJSON($0.ids))}" }
                    ?? "null"
                #expect(actual == expected, "\(testCase.label): wrong return value")
            }
            #expect(
                session.trains.map(\.id) == testCase.state.trainIds,
                "\(testCase.label): the store holds different trains")
            #expect(
                session.selectedTrainID == testCase.state.selectedTrainId,
                "\(testCase.label): wrong selected train")
            #expect(
                session.focusedTrainID == testCase.state.focusedTrainId,
                "\(testCase.label): wrong focused train")
            #expect(
                session.selectedDate == testCase.state.selectedDate,
                "\(testCase.label): wrong selected date")
            #expect(
                session.importInProgress == testCase.state.importInProgress,
                "\(testCase.label): importInProgress not restored")
        }
    }

    /// The document a case feeds its door, from the named store file when it
    /// has one and from the inline text otherwise.
    static func documentText(_ testCase: Fixture.RunCase) throws -> String {
        if let file = testCase.storeFile { return try storeText(file) }
        guard let input = testCase.input else {
            throw CocoaError(.fileNoSuchFile)
        }
        return input
    }

    static func idsJSON(_ ids: [String]) -> String {
        "[\(ids.map { TrainValidation.JSON.string($0).canonicalText }.joined(separator: ","))]"
    }

    /// A reference box, because the session's event sink is a plain closure
    /// and a captured `var` array would be captured by value here.
    final class EventLog {
        private(set) var rows: [Fixture.EventRow] = []
        func append(_ row: Fixture.EventRow) { rows.append(row) }
    }

    /// The parts door's network, replayed from the recorded bodies.
    ///
    /// The engine takes the fetcher as a closure precisely so that the
    /// retry/prefetch machinery stays in the shell; this is the smallest shell
    /// that satisfies it — a body that is absent answers nil, which is what
    /// two failed attempts produce.
    struct PartsSource {
        let total: Int
        let fetch: (Int) throws -> TrainValidation.JSON?

        init(_ testCase: Fixture.RunCase) throws {
            guard let text = testCase.parts,
                case .object(let bodies) = try TrainValidation.JSON.parse(text)
            else {
                self.total = 0
                self.fetch = { _ in nil }
                return
            }
            let names = bodies.keys
            self.total = names.count
            self.fetch = { index in
                guard index < names.count else { return nil }
                // `undefined` bodies are dropped by JSON.stringify, so an
                // absent key is the recorded spelling of "this part 404s".
                guard let body = bodies[names[index]] else { return nil }
                return ImportEngine.acceptPart(body)?.train
            }
        }
    }

    // MARK: - appendImportedTrain on its own

    /// The composition, isolated from the loop, so a disagreement names the
    /// per-train step rather than the sequence.
    ///
    /// One case is deliberately excluded from the store comparison. A JSON
    /// number survives `normalizeImportedStop` as a number in JavaScript and
    /// only becomes a string inside `stationCodeSystem`; `Stop.n02StationCode`
    /// is a `String?`, so the port spells `123456` where the app keeps `123456`
    /// unquoted. The verdict is identical — which is the rule being tested —
    /// and the divergence is the typed model's, already documented on
    /// `TrainValidation.normalizeNullableTime` for the same reason.
    static let modelCannotRepresent: Set<String> = [
        "a six-digit station code that is a number"
    ]

    @Test func appendImportedTrain() throws {
        let fixture = try Self.load()
        for label in Self.modelCannotRepresent {
            #expect(
                fixture.appendCases.contains { $0.label == label }
                    || fixture.cases.contains { $0.label == label },
                "\(label) is no longer in the fixture — remove it from modelCannotRepresent")
        }
        for testCase in fixture.appendCases {
            var session = ImportEngine.Session(
                trains: try Self.existingTrains(testCase.existing),
                selectedDate: testCase.selectedDate,
                country: testCase.country,
                stations: .empty)
            let train = try TrainValidation.JSON.parse(testCase.train)
            var produced: String?
            Self.expectVerdict(
                testCase.label, ok: testCase.ok, errorName: testCase.errorName,
                error: testCase.error
            ) {
                // A case that passed no argument drove the JavaScript's
                // DEFAULT, which is `currentImportFallbackDate()` evaluated
                // per call — where one that passed an explicit null suppressed
                // exactly that. Reading a nil argument as "absent" would merge
                // the two and answer the second one wrong.
                produced = try session.appendImportedTrain(
                    train,
                    fallbackDate: testCase.explicitFallback
                        ? testCase.fallbackDate : session.currentImportFallbackDate)
            }
            guard testCase.ok else { continue }
            #expect(produced == testCase.id, "\(testCase.label): wrong id")
            guard let expected = testCase.store,
                !Self.modelCannotRepresent.contains(testCase.label)
            else { continue }
            let store = TrainValidation.buildCanonicalTrainStore(
                session.trains, country: testCase.country, stations: .empty)
            #expect(
                try Self.canonicalText(store) == expected,
                "\(testCase.label): the appended train normalised differently")
        }
    }

    // MARK: - the small rules

    /// `currentImportFallbackDate` — a real date, or nothing.
    ///
    /// The JavaScript's `selectedDate` can be null; that spelling and the
    /// empty string are both falsy and answer identically, which is why the
    /// port carries one `String`.
    @Test func fallbackDate() throws {
        let fixture = try Self.load()
        for testCase in fixture.fallbackDateCases {
            let session = ImportEngine.Session(selectedDate: testCase.selectedDate ?? "")
            #expect(
                session.currentImportFallbackDate == testCase.result,
                "selectedDate \(testCase.selectedDate ?? "null")")
        }
    }

    /// `makeManifestLoader`'s shape test.
    ///
    /// A failed fetch is the shell's business, so those cases assert only that
    /// the shell has nothing to hand on — the loader memoises null and never
    /// retries, which is a property of the memo rather than of this predicate.
    @Test func manifests() throws {
        let fixture = try Self.load()
        for testCase in fixture.manifestCases {
            guard !testCase.fetchFails else {
                #expect(testCase.manifest == nil, "\(testCase.label): a failed fetch loads nothing")
                continue
            }
            let payload = try TrainValidation.JSON.parse(testCase.payload)
            let accepted = ImportEngine.acceptedManifest(
                payload, api: testCase.api, attachPartsApi: testCase.attachPartsApi)
            #expect(
                accepted?.canonicalText == testCase.manifest,
                "\(testCase.label): wrong manifest")
        }
    }

    /// `sampleManifestDates` — including the sort, which is by UTF-16 code
    /// unit and not by any locale collation.
    @Test func manifestDates() throws {
        let fixture = try Self.load()
        for testCase in fixture.manifestDatesCases {
            let manifest = try TrainValidation.JSON.parse(testCase.manifest)
            #expect(
                ImportEngine.sampleManifestDates(manifest) == testCase.dates,
                "\(testCase.label): wrong day list")
        }
    }

    /// The parts source: the shape test, the prefetch window, and which parts
    /// a run ends up with.
    ///
    /// The window is replayed here rather than in `RailCore` because the
    /// fetching is the shell's — what the port owns is
    /// ``ImportEngine/prefetchIndices(from:count:)`` and
    /// ``ImportEngine/acceptPart(_:)``, and this drives both against the
    /// request order the app actually produced.
    @Test func parts() throws {
        let fixture = try Self.load()
        for testCase in fixture.partCases {
            guard case .object(let bodies) = try TrainValidation.JSON.parse(testCase.bodies) else {
                Issue.record("\(testCase.label): bodies is not an object")
                continue
            }
            var attempts: [String: Int] = [:]
            var firstAttempts: [String] = []
            // One request, with the retry the JavaScript makes: a failure is
            // tried exactly once more before the part is skipped.
            func request(_ index: Int) -> TrainValidation.JSON? {
                let name = testCase.names[index]
                firstAttempts.append(name)
                for _ in 0..<2 {
                    let seen = (attempts[name] ?? 0) + 1
                    attempts[name] = seen
                    if seen <= (testCase.failures[name] ?? 0) { continue }
                    guard let body = bodies[name] else { continue }
                    return body
                }
                return nil
            }
            var inflight: [Int: TrainValidation.JSON?] = [:]
            var ids: [String?] = []
            for index in 0..<testCase.names.count {
                for ahead in ImportEngine.prefetchIndices(
                    from: index, count: testCase.names.count)
                where inflight[ahead] == nil {
                    inflight[ahead] = request(ahead)
                }
                let part = inflight[index] ?? nil
                inflight.removeValue(forKey: index)
                ids.append(ImportEngine.acceptPart(part)?["id"])
            }
            #expect(testCase.names.count == testCase.total, "\(testCase.label): wrong total")
            #expect(ids == testCase.ids, "\(testCase.label): wrong trains")
            // The order of FIRST attempts, not of every request. A retry runs
            // inside the same promise as the attempt that failed, so in the
            // browser it interleaves with the prefetches already in flight and
            // the app's recorded order is 000, 001, 000 — the "001" belongs to
            // V8's scheduling of two concurrent promises, not to any rule this
            // port owns. What the port decides is which indices are asked for
            // and in what order, which is exactly the first-attempt sequence.
            var seen = Set<String>()
            let expectedFirstAttempts =
                testCase.fetched
                .map { String($0.split(separator: "/").last ?? "") }
                .filter { seen.insert($0).inserted }
            #expect(
                firstAttempts == expectedFirstAttempts,
                "\(testCase.label): wrong prefetch order")
        }
    }

    /// `seedRouteCacheFromPart` — which cache action a part asks for.
    ///
    /// The fixture observes it through `RouteService`'s own predicates
    /// afterwards; the port answers with the action itself, so the two are
    /// compared through what the action would do.
    @Test func seeding() throws {
        let fixture = try Self.load()
        for testCase in fixture.seedCases {
            let part = try TrainValidation.JSON.parse(testCase.part)
            let action = ImportEngine.seedAction(for: part == .null ? nil : part)
            switch action {
            case .none:
                #expect(!testCase.cached && !testCase.negative, "\(testCase.label): expected no seed")
                #expect(testCase.cacheSize == 0, "\(testCase.label): expected an empty cache")
            case .negative:
                #expect(testCase.negative && !testCase.cached, "\(testCase.label): expected a negative seed")
                #expect(testCase.cacheSize == 0, "\(testCase.label): a negative seed adds no entry")
            case .features(_, let features):
                #expect(testCase.cached && !testCase.negative, "\(testCase.label): expected a seeded solve")
                #expect(testCase.cacheSize == 1, "\(testCase.label): expected exactly one entry")
                #expect(!features.isEmpty, "\(testCase.label): seeded an empty feature list")
            }
        }
    }

    /// `loadSampleData`'s day rule, and the mode it lands in.
    @Test func sampleLoads() throws {
        let fixture = try Self.load()
        for testCase in fixture.sampleNameCases {
            let manifest = try TrainValidation.JSON.parse(testCase.manifest)
            let load = ImportEngine.sampleLoad(manifest: manifest, date: testCase.date)
            #expect(load.mode == testCase.dataSourceMode, "\(testCase.label): wrong data-source mode")
            #expect(load.day == testCase.sampleModeDate, "\(testCase.label): wrong sample day")
            guard let expected = testCase.picked else { continue }
            let spelled = TrainValidation.JSON.object(
                TrainValidation.JSON.Object([
                    ("label", .string(load.labelKey)),
                    (
                        "options",
                        .object(
                            TrainValidation.JSON.Object([
                                ("finalPersist", .bool(load.options.finalPersist)),
                                ("persistEachStep", .bool(load.options.persistEachStep)),
                                ("selectFirstTrain", .bool(load.options.selectFirstTrain)),
                                ("showAllDates", .bool(load.options.showAllDates)),
                            ]))
                    ),
                    ("parts", .array(load.parts)),
                ])
            ).canonicalText
            #expect(spelled == expected, "\(testCase.label): loaded a different set of parts")
        }
    }
}

extension ImportEngine.Part {
    /// The train's `id`, for the parts test's compact comparison.
    subscript(key: String) -> String? {
        guard case .string(let value)? = train[key] else { return nil }
        return value
    }
}
