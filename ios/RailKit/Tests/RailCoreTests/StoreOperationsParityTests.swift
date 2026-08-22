import Foundation
import RailCore
import Testing

/// `app-store-ops.js` §17–§20 against `port-fixtures/store-ops.json`.
///
/// The fixture is the JavaScript's own answers, so a disagreement here is a
/// port defect and never a judgement about what the answer should be.
///
/// Three of these tests compare **bytes**, and it is worth being explicit
/// about which bytes, because the three are different claims:
///
///   1. ``committedFileIsReproducibleByteForByte(country:)`` re-serialises
///      each committed store from its own parsed form and compares to the
///      file. That is the serialiser checked against 1.3 MB of real archive —
///      every CJK station name, every null, every nesting depth — with no
///      fixture in between. It also pins the two files' *shapes*: Japan is
///      pretty-printed with a trailing newline, Taiwan is minified without
///      one, and the port has to be able to spell both.
///   2. ``canonicalExportBytes(country:)`` compares
///      ``StoreOperations/exportTrainStore(_:stations:)`` to the fixture. That
///      is the *operation* checked against V8.
///   3. ``exportIsNotAFixedPointOverTheArchive(country:)`` compares the two
///      to each other and asserts they DISAGREE, in the exact way the
///      JavaScript disagrees. Saving the Japanese archive rewrites 87 of its
///      201 trains, and a port that quietly made that go away would stop
///      reproducing what the app does to the user's file.
struct StoreOperationsParityTests {

    // MARK: - the fixture

    struct Fixture: Decodable {
        struct Constants: Decodable {
            let schemaVersion: String
            let allDates: String
            let undated: String
            let defaultTrainColor: String
            let defaultAllowedInstitutionTypeCodes: [String]

            private enum CodingKeys: String, CodingKey {
                case schemaVersion = "SCHEMA_VERSION"
                case allDates = "ALL_DATES"
                case undated = "UNDATED"
                case defaultTrainColor = "DEFAULT_TRAIN_COLOR"
                case defaultAllowedInstitutionTypeCodes = "DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES"
            }
        }

        /// One handler call. `idRef` is resolved against the store as it
        /// stands when the step runs, which is how "duplicate the copy you
        /// just made" is expressed without naming an id that does not exist
        /// yet.
        struct Step: Decodable {
            let op: String
            let id: String?
            let idRef: String?
            let direction: Int
            /// The train `addTrain` was handed, as JSON text; nil means it was
            /// called with no argument at all.
            let train: String?
        }

        struct Before: Decodable {
            let ids: [String]
            let selected: String?
            let focused: String?
        }

        struct After: Decodable {
            let schemaVersion: String
            let ids: [String]
            let selected: String?
            let focused: String?
            /// nil where the key is ABSENT, which is a third state and not the
            /// same as false.
            let visible: [Bool?]
        }

        struct CRUDCase: Decodable {
            let label: String
            let country: String
            let shape: String
            let script: [Step]
            let before: Before
            let after: After
            /// One per step; nil where the handler returned before signalling.
            let mutations: [String?]
            let returned: [String?]
            let ok: Bool
            let errorName: String?
            let error: String?
            /// Sorted-key spelling of every train the script appended.
            let created: [String]
        }

        struct Blank: Decodable {
            let country: String
            let train: String
        }

        struct Committed: Decodable {
            let fileEqualsPretty2: Bool
            let fileEqualsPretty2Newline: Bool
            let fileEqualsMinified: Bool
            let fileEndsWithNewline: Bool
            let exportEqualsFile: Bool
            let firstDifferingIndex: Int?
            let trainsIdentical: Int
            let trainsDifferingByKeyOrderOnly: Int
            let trainsDifferingByValue: Int
        }

        struct Export: Decodable {
            let country: String
            let text: String
            let committed: Committed
        }

        struct StringifyCase: Decodable {
            let input: String
            let indent: Int
            let output: String
        }

        struct RideSectionCase: Decodable {
            let country: String
            let index: Int
            let id: String
            let sections: String
        }

        struct RideSectionProjection: Decodable {
            let label: String
            let input: String
            let sections: String
            let exported: String
        }

        struct UniqueIDCase: Decodable {
            let seed: String?
            let existing: [String]
            let result: String
        }

        struct AppendCase: Decodable {
            let label: String
            let country: String
            let input: String
            let fallbackDate: String?
            let repeatCount: Int
            let ok: Bool
            let errorName: String?
            let error: String?
            let returnedIds: [String]
            let appendedCount: Int
            let appended: [String]

            private enum CodingKeys: String, CodingKey {
                case label, country, input, fallbackDate, ok, errorName, error
                case repeatCount = "repeat"
                case returnedIds, appendedCount, appended
            }
        }

        struct FallbackDateCase: Decodable {
            let selectedDate: String?
            let result: String?
        }

        let constants: Constants
        let cases: [CRUDCase]
        let syntheticTrains: String
        let blankTrains: [Blank]
        let exports: [Export]
        let stringifyCases: [StringifyCase]
        let rideSections: [RideSectionCase]
        let rideSectionProjections: [RideSectionProjection]
        let uniqueIds: [UniqueIDCase]
        let appendCases: [AppendCase]
        let fallbackDates: [FallbackDateCase]
    }

    static func load() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "store-ops.json")
    }

    // MARK: - helpers

    static func storeURL(_ country: String) throws -> URL {
        let file = country == "jp" ? "train-store.json" : "train-store-\(country).json"
        return try PortFixtures.repositoryRoot().appending(path: "app/data/\(file)")
    }

    static func storeText(_ country: String) throws -> String {
        String(decoding: try Data(contentsOf: storeURL(country)), as: UTF8.self)
    }

    /// Byte equality on strings that can be a megabyte long.
    ///
    /// `#expect(a == b)` on a 1.18 MB archive prints both, which is not a
    /// diagnosis. This reports the first differing UTF-16 index — the same
    /// unit the fixture counts in — and a window either side, which names the
    /// field that moved.
    static func expectSameBytes(_ actual: String, _ expected: String, _ label: String) {
        guard actual != expected else { return }
        let a = Array(actual.utf16)
        let b = Array(expected.utf16)
        var index = 0
        while index < a.count && index < b.count && a[index] == b[index] { index += 1 }
        let window = { (units: [UInt16]) -> String in
            let low = max(0, index - 90)
            let high = min(units.count, index + 90)
            return String(decoding: units[low..<high], as: UTF16.self)
        }
        Issue.record(
            """
            \(label): differs at UTF-16 index \(index) \
            (\(a.count) vs \(b.count) units)
              swift: …\(window(a))…
              js   : …\(window(b))…
            """)
    }

    /// The first differing UTF-16 index, or nil when the two agree — the
    /// same measurement the fixture records.
    static func firstDifference(_ a: String, _ b: String) -> Int? {
        guard a != b else { return nil }
        let left = Array(a.utf16)
        let right = Array(b.utf16)
        var index = 0
        while index < left.count && index < right.count && left[index] == right[index] {
            index += 1
        }
        return index
    }

    // MARK: - the constants the operations are spelled from

    @Test func constants() throws {
        let fixture = try Self.load()
        #expect(TrainValidation.schemaVersion == fixture.constants.schemaVersion)
        #expect(StoreOperations.allDates == fixture.constants.allDates)
        #expect(TrainValidation.undated == fixture.constants.undated)
        #expect(TrainValidation.defaultTrainColor == fixture.constants.defaultTrainColor)
        #expect(
            TrainValidation.defaultAllowedInstitutionTypeCodes
                == fixture.constants.defaultAllowedInstitutionTypeCodes)
    }

    // MARK: - the byte format

    /// `JSON.stringify(value, null, indent)` on shapes the stores do not
    /// contain: the escapes, the empty containers, and the nesting.
    @Test func stringifyMatchesJSONStringify() throws {
        let fixture = try Self.load()
        #expect(!fixture.stringifyCases.isEmpty)
        for testCase in fixture.stringifyCases {
            let value = try TrainValidation.JSON.parse(testCase.input)
            Self.expectSameBytes(
                StoreOperations.stringify(value, indent: testCase.indent),
                testCase.output,
                "stringify(indent: \(testCase.indent)) of \(testCase.input)")
        }
    }

    /// The string quoter here and the one behind `JSON.canonicalText` are two
    /// copies of the same rule, because this file may not edit `Train.swift`.
    /// This is what keeps them from drifting: on a single string value the
    /// two spellings are the whole output, so they must be identical.
    @Test func quotingAgreesWithTheCanonicalSpelling() throws {
        let fixture = try Self.load()
        var probes = fixture.stringifyCases.map(\.input)
        probes.append(contentsOf: fixture.blankTrains.map(\.train))
        probes.append(contentsOf: ["", "\u{0}\u{1f}", "a/b", "\u{2028}", "🚄", "が", "が"])
        for probe in probes {
            #expect(
                StoreOperations.stringify(.string(probe)) == TrainValidation.JSON.string(probe).canonicalText,
                "the two quoters disagree on \(probe.debugDescription)")
        }
    }

    /// Each committed store, re-serialised from its own parsed form, byte for
    /// byte against the file.
    ///
    /// No fixture between the two — this is the serialiser against 1.3 MB of
    /// real archive. It also pins the files' shapes, and they are not the
    /// same shape: `train-store.json` is `JSON.stringify(store, null, 2)` plus
    /// a trailing newline, `train-store-tw.json` is minified with none. Which
    /// one holds is read out of the fixture rather than assumed, so that a
    /// reformat of either file shows up as a fixture diff instead of a silent
    /// pass.
    @Test(arguments: ["jp", "tw"]) func committedFileIsReproducibleByteForByte(country: String)
        throws
    {
        let fixture = try Self.load()
        guard let expected = fixture.exports.first(where: { $0.country == country })?.committed
        else {
            Issue.record("\(country): the fixture records no export")
            return
        }
        let raw = try Self.storeText(country)
        let parsed = try TrainValidation.JSON.parse(raw)

        #expect(
            expected.fileEqualsPretty2 || expected.fileEqualsPretty2Newline
                || expected.fileEqualsMinified,
            "\(country): the committed file is not JSON.stringify output at all, so this test proves nothing until that is understood")
        #expect(raw.hasSuffix("\n") == expected.fileEndsWithNewline)

        if expected.fileEqualsPretty2 {
            Self.expectSameBytes(StoreOperations.stringify(parsed, indent: 2), raw, "\(country) 2sp")
        }
        if expected.fileEqualsPretty2Newline {
            Self.expectSameBytes(
                StoreOperations.stringify(parsed, indent: 2) + "\n", raw, "\(country) 2sp + NL")
        }
        if expected.fileEqualsMinified {
            Self.expectSameBytes(StoreOperations.stringify(parsed, indent: 0), raw, "\(country) min")
        }
    }

    /// `exportTrainStore` over each committed store, byte for byte against
    /// what the JavaScript wrote for the same input.
    ///
    /// The station table is empty, which is the state the fixture was
    /// generated in and a real boot state — see the fixture's header.
    @Test(arguments: ["jp", "tw"]) func canonicalExportBytes(country: String) throws {
        let fixture = try Self.load()
        guard let expected = fixture.exports.first(where: { $0.country == country }) else {
            Issue.record("\(country): the fixture records no export")
            return
        }
        let store = try JSONDecoder().decode(
            TrainStore.self, from: try Data(contentsOf: Self.storeURL(country)))
        let workspace = StoreOperations.Workspace(store: store, country: country)
        Self.expectSameBytes(
            StoreOperations.exportTrainStore(workspace), expected.text, "\(country) export")
    }

    /// The export against the file it came from — a disagreement, reproduced.
    ///
    /// Japan's archive predates the current route-policy writer, so a save
    /// rewrites 87 of its 201 trains: 41 only in key order
    /// (`institution_filter_mode` used to sit before
    /// `allowed_institution_type_codes`) and 46 in value (the two
    /// `preferred_*` arrays the writer now always emits did not exist).
    /// Taiwan's differs for a different reason entirely — its file is
    /// minified, so the export cannot equal it whatever the values are.
    ///
    /// The stored trains are read through the order-preserving parser rather
    /// than through `Train`, because the whole question is about key order and
    /// the typed model deliberately does not carry the file's.
    @Test(arguments: ["jp", "tw"]) func exportIsNotAFixedPointOverTheArchive(country: String) throws
    {
        let fixture = try Self.load()
        guard let expected = fixture.exports.first(where: { $0.country == country }) else {
            Issue.record("\(country): the fixture records no export")
            return
        }
        let raw = try Self.storeText(country)
        let store = try JSONDecoder().decode(
            TrainStore.self, from: try Data(contentsOf: Self.storeURL(country)))
        let workspace = StoreOperations.Workspace(store: store, country: country)
        let text = StoreOperations.exportTrainStore(workspace)

        #expect((text == raw) == expected.committed.exportEqualsFile)
        #expect(Self.firstDifference(text, raw) == expected.committed.firstDifferingIndex)

        guard case .array(let storedTrains)? = try TrainValidation.JSON.parse(raw)["trains"] else {
            Issue.record("\(country): the store has no trains array")
            return
        }
        var identical = 0
        var orderOnly = 0
        var valueDiff = 0
        for (index, train) in store.trains.enumerated() where index < storedTrains.count {
            let exported = StoreOperations.json(
                TrainValidation.normalizeExportTrain(train, country: country, stations: .empty))
            if StoreOperations.stringify(storedTrains[index], indent: 2)
                == StoreOperations.stringify(exported, indent: 2)
            {
                identical += 1
            } else if storedTrains[index].canonicalText == exported.canonicalText {
                orderOnly += 1
            } else {
                valueDiff += 1
            }
        }
        #expect(identical == expected.committed.trainsIdentical)
        #expect(orderOnly == expected.committed.trainsDifferingByKeyOrderOnly)
        #expect(valueDiff == expected.committed.trainsDifferingByValue)
    }

    // MARK: - §20: the blank-train factory

    /// All six scaffolds, as bytes: a blank train flows straight into
    /// `addTrain` and then into the export, so its key order is the export's
    /// key order for a train that has never been saved.
    ///
    /// The `xx` case is the `if`-chain with no `else`: an unrecognised country
    /// gets Japan's starter.
    @Test func blankTrains() throws {
        let fixture = try Self.load()
        #expect(fixture.blankTrains.count == 6)
        for blank in fixture.blankTrains {
            Self.expectSameBytes(
                StoreOperations.stringify(
                    StoreOperations.json(StoreOperations.createBlankTrain(country: blank.country)),
                    indent: 2),
                blank.train,
                "createBlankTrain(\(blank.country))")
        }
    }

    // MARK: - §17: the CRUD transitions

    /// Every recorded script, replayed.
    ///
    /// The starting store is rebuilt from the committed file (or from the
    /// fixture's synthetic trains) rather than carried in the case, so a case
    /// cannot pass by comparing the fixture to itself.
    @Test func crudTransitions() throws {
        let fixture = try Self.load()
        #expect(!fixture.cases.isEmpty)
        let synthetic = try JSONDecoder().decode(
            TrainStore.self, from: Data(fixture.syntheticTrains.utf8))
        var committed: [String: TrainStore] = [:]
        for country in ["jp", "tw"] {
            committed[country] = try JSONDecoder().decode(
                TrainStore.self, from: try Data(contentsOf: Self.storeURL(country)))
        }

        for testCase in fixture.cases {
            guard let store = committed[testCase.country] else { continue }
            let trains: [Train]
            switch testCase.shape {
            case "full": trains = store.trains
            case "one": trains = Array(store.trains.prefix(1))
            case "none": trains = []
            case "synthetic": trains = synthetic.trains
            default:
                Issue.record("\(testCase.label): unknown shape \(testCase.shape)")
                continue
            }
            #expect(trains.map(\.id) == testCase.before.ids, "\(testCase.label): wrong start")

            var workspace = StoreOperations.Workspace(
                store: TrainStore(schemaVersion: TrainValidation.schemaVersion, trains: trains),
                selectedTrainID: testCase.before.selected,
                focusedTrainID: testCase.before.focused,
                country: testCase.country)

            var mutations: [String?] = []
            var returned: [String?] = []
            var failure: Error?
            do {
                for step in testCase.script {
                    // `idRef: "last"` names a train that did not exist when
                    // the case was written.
                    let id = step.idRef == "last" ? workspace.store.trains.last?.id : step.id
                    switch step.op {
                    case "add":
                        let train = try step.train.map {
                            try JSONDecoder().decode(Train.self, from: Data($0.utf8))
                        }
                        mutations.append(StoreOperations.addTrain(train, in: &workspace)?.rawValue)
                        returned.append(nil)
                    case "duplicate":
                        mutations.append(
                            StoreOperations.duplicateTrain(id, in: &workspace)?.rawValue)
                        returned.append(nil)
                    case "delete":
                        mutations.append(StoreOperations.deleteTrain(id, in: &workspace)?.rawValue)
                        returned.append(nil)
                    case "deleteAll":
                        mutations.append(StoreOperations.deleteAllTrains(in: &workspace)?.rawValue)
                        returned.append(nil)
                    case "toggle":
                        mutations.append(
                            StoreOperations.toggleTrainVisibility(id, in: &workspace)?.rawValue)
                        returned.append(nil)
                    case "move":
                        mutations.append(
                            StoreOperations.moveTrain(id, by: step.direction, in: &workspace)?
                                .rawValue)
                        returned.append(nil)
                    case "getTrain":
                        mutations.append(nil)
                        returned.append(StoreOperations.train(withID: id, in: workspace)?.id)
                    case "getTrainDefault":
                        mutations.append(nil)
                        returned.append(StoreOperations.selectedTrain(in: workspace)?.id)
                    default:
                        Issue.record("\(testCase.label): unknown step \(step.op)")
                    }
                }
            } catch {
                failure = error
            }

            #expect(
                (failure == nil) == testCase.ok,
                "\(testCase.label): Swift \(failure == nil ? "succeeded" : "threw") where the JavaScript did not")
            guard failure == nil else { continue }

            #expect(
                workspace.store.schemaVersion == testCase.after.schemaVersion,
                "\(testCase.label): schema_version")
            #expect(workspace.store.trains.map(\.id) == testCase.after.ids, "\(testCase.label): ids")
            #expect(workspace.selectedTrainID == testCase.after.selected, "\(testCase.label): selected")
            #expect(workspace.focusedTrainID == testCase.after.focused, "\(testCase.label): focused")
            #expect(
                workspace.store.trains.map(\.visible) == testCase.after.visible,
                "\(testCase.label): visible")
            #expect(mutations == testCase.mutations, "\(testCase.label): mutation results")
            #expect(returned == testCase.returned, "\(testCase.label): return values")

            // Trains the script appended, compared by VALUE: a duplicate keeps
            // the key order of the file it was read from, and the typed model
            // does not carry that. See the fixture's note.
            let appended = workspace.store.trains.dropFirst(testCase.before.ids.count)
                .map { StoreOperations.json($0).canonicalText }
            #expect(Array(appended) == testCase.created, "\(testCase.label): created trains")
        }
    }

    // MARK: - §20: uniqueId

    /// `uniqueId` — trim, collapse whitespace runs to `-`, then count.
    ///
    /// The seeds include U+00A0, U+FEFF, U+3000 and a tab, which is where a
    /// port that reached for `CharacterSet.whitespacesAndNewlines` parts
    /// company with the app: that set omits U+FEFF and includes U+0085, and
    /// ECMAScript's `\s` is the other way round on both.
    @Test func uniqueIDs() throws {
        let fixture = try Self.load()
        #expect(!fixture.uniqueIds.isEmpty)
        for testCase in fixture.uniqueIds {
            // Only the ids are read, so the rest of each train is a stub.
            let workspace = StoreOperations.Workspace(
                store: TrainStore(
                    trains: testCase.existing.map {
                        Train(id: $0, number: "", origin: "", destination: "", stops: [])
                    }))
            #expect(
                StoreOperations.uniqueID(testCase.seed, in: workspace) == testCase.result,
                "uniqueId(\(testCase.seed.debugDescription), \(testCase.existing))")
        }
    }

    // MARK: - §18: getRideRouteSectionsForTrain, the seam

    /// Every committed train's ride sections, as bytes.
    ///
    /// This is the list `RouteGraph.solveContext` keys a solve on, so a
    /// disagreement here is a disagreement about every cached route.
    @Test(arguments: ["jp", "tw"]) func rideRouteSections(country: String) throws {
        let fixture = try Self.load()
        let store = try JSONDecoder().decode(
            TrainStore.self, from: try Data(contentsOf: Self.storeURL(country)))
        let expected = fixture.rideSections.filter { $0.country == country }
        #expect(store.trains.count == expected.count)
        for testCase in expected where testCase.index < store.trains.count {
            let train = store.trains[testCase.index]
            #expect(train.id == testCase.id)
            let sections = StoreOperations.rideRouteSections(for: train)
            Self.expectSameBytes(
                StoreOperations.stringify(.array(sections.map(StoreOperations.json))),
                testCase.sections,
                "\(country)[\(testCase.index)] \(testCase.id) ride sections")
        }
    }

    /// The reuse rule's other branches: both committed stores are already in
    /// step with their stops, so the whole-list search and the synthesis
    /// branch are dead code over them.
    ///
    /// Two of the projections are deliberately not representable as a typed
    /// ``Train`` — a `route_sections` that is the number 0, and a train with
    /// no `stops` key at all. Both are legal *input* to the JavaScript, which
    /// reads them through `Array.isArray` and `train?.stops || []`, and both
    /// are exactly the shapes `Train` exists to refuse. They are kept in the
    /// fixture because the JavaScript's answer for them is worth recording;
    /// the decode failure here is the documented divergence, not a defect.
    @Test func rideRouteSectionProjections() throws {
        let fixture = try Self.load()
        #expect(!fixture.rideSectionProjections.isEmpty)
        let notCanonical: Set<String> = ["route_sections not an array", "stops absent"]
        for projection in fixture.rideSectionProjections {
            let train: Train
            do {
                train = try JSONDecoder().decode(
                    Train.self, from: Data(projection.input.utf8))
            } catch {
                #expect(
                    notCanonical.contains(projection.label),
                    "\(projection.label): did not decode as a canonical Train, and is not one of the shapes documented as unrepresentable")
                continue
            }
            #expect(
                !notCanonical.contains(projection.label),
                "\(projection.label): decoded as a canonical Train after all; update the documented list")
            let sections = StoreOperations.rideRouteSections(for: train)
            Self.expectSameBytes(
                StoreOperations.stringify(.array(sections.map(StoreOperations.json))),
                projection.sections,
                "\(projection.label): ride sections")
            Self.expectSameBytes(
                StoreOperations.stringify(
                    StoreOperations.json(
                        TrainValidation.normalizeExportTrain(train, country: "jp", stations: .empty)),
                    indent: 2),
                projection.exported,
                "\(projection.label): export")
        }
    }

    // MARK: - §19: appendImportedTrain

    /// The import path's one-train front door, over both stores.
    ///
    /// What lands in the store is the IMPORT normalisation and not the export
    /// one — its sections keep the empty `line_names` / `operator_names`
    /// arrays that `leanExportSection` drops — so the appended trains are
    /// compared as bytes.
    @Test func appendImportedTrains() throws {
        let fixture = try Self.load()
        #expect(!fixture.appendCases.isEmpty)
        var committed: [String: TrainStore] = [:]
        for country in ["jp", "tw"] {
            committed[country] = try JSONDecoder().decode(
                TrainStore.self, from: try Data(contentsOf: Self.storeURL(country)))
        }

        for testCase in fixture.appendCases {
            guard let store = committed[testCase.country] else { continue }
            var workspace = StoreOperations.Workspace(store: store, country: testCase.country)
            let raw = try TrainValidation.JSON.parse(testCase.input)
            var returned: [String] = []
            var failure: TrainValidation.ValidationError?
            do {
                for _ in 0..<testCase.repeatCount {
                    returned.append(
                        try StoreOperations.appendImportedTrain(
                            raw, fallbackDate: testCase.fallbackDate, in: &workspace))
                }
            } catch let error as TrainValidation.ValidationError {
                failure = error
            }

            let label = "\(testCase.country): \(testCase.label)"
            #expect((failure == nil) == testCase.ok, "\(label): wrong verdict")
            if let failure {
                #expect(failure.kind.rawValue == testCase.errorName, "\(label): wrong kind")
                // Only a deliberate `Error` carries a contractual message; a
                // TypeError carries V8's own wording. See the validation port.
                if testCase.errorName == "Error" {
                    #expect(failure.message == testCase.error, "\(label): wrong message")
                }
            }
            #expect(returned == testCase.returnedIds, "\(label): returned ids")
            #expect(
                workspace.store.trains.count - store.trains.count == testCase.appendedCount,
                "\(label): appended count")

            let appended = workspace.store.trains.dropFirst(store.trains.count)
            #expect(appended.count == testCase.appended.count, "\(label): appended count")
            for (train, expected) in zip(appended, testCase.appended) {
                Self.expectSameBytes(
                    StoreOperations.stringify(StoreOperations.json(train), indent: 2),
                    expected,
                    "\(label): appended \(train.id)")
            }
        }
    }

    /// `currentImportFallbackDate` — "全部" is not a date.
    @Test func importFallbackDate() throws {
        let fixture = try Self.load()
        #expect(!fixture.fallbackDates.isEmpty)
        for testCase in fixture.fallbackDates {
            #expect(
                StoreOperations.currentImportFallbackDate(selectedDate: testCase.selectedDate)
                    == testCase.result,
                "currentImportFallbackDate(\(testCase.selectedDate.debugDescription))")
        }
    }
}
