import Foundation
import Testing

@testable import RailCore

/// `RailCore.Train` and `RailCore.TrainValidation` against `app-validation.js`
/// §33 and the `app-store-ops.js` §18–§19 shapes around it, over
/// `port-fixtures/validation.json`.
///
/// The inputs are the 229 real itineraries in the two committed train stores
/// plus 146 adversarial projections of them, and every expected value is what
/// the JavaScript answered when the fixture was generated. So a failure here
/// says one thing only: this Swift disagrees with the app it was forked from,
/// and the two can no longer exchange files.
///
/// ## What these tests are guarding against specifically
///
/// The validator is four regular expressions and a pile of truthiness tests,
/// and every one of those translates wrong by default:
///
///   - ICU's `$` matches before a trailing newline where JavaScript's does
///     not, so `NSRegularExpression` would accept `"odr_001\n"` as a train id
///     and `"#ff0000\n"` as a colour.
///   - ICU's `\d` is `\p{Nd}`, so it would accept `"００３７７０"` as a
///     six-digit Japanese station code.
///   - `CharacterSet.whitespacesAndNewlines` differs from ECMAScript's trim
///     at both ends: it drops U+0085, which JavaScript keeps, and keeps
///     U+FEFF, which JavaScript drops. Both change a station code's verdict.
///   - Swift's `String ==` is canonical equivalence; JavaScript's `===` is
///     UTF-16 code units. The names being compared are CJK.
///   - `Object.keys` puts integer-index keys first in numeric order, so which
///     unsupported field an error names is not document order.
///
/// Each has at least one case below that fails if the port takes the obvious
/// route.
struct TrainValidationParityTests {

    // MARK: - fixture shape

    struct Fixture: Decodable {
        struct Constants: Decodable {
            let schemaVersion: String
            let acceptedSchemaVersions: [String]
            let trainIDPattern: String
            let stopTypes: [String]
            let undated: String
            let defaultTrainColor: String
            let defaultAllowedInstitutionTypeCodes: [String]

            private enum CodingKeys: String, CodingKey {
                case schemaVersion = "SCHEMA_VERSION"
                case acceptedSchemaVersions = "ACCEPTED_SCHEMA_VERSIONS"
                case trainIDPattern = "TRAIN_ID_PATTERN"
                case stopTypes = "STOP_TYPES"
                case undated = "UNDATED"
                case defaultTrainColor = "DEFAULT_TRAIN_COLOR"
                case defaultAllowedInstitutionTypeCodes = "DEFAULT_ALLOWED_INSTITUTION_TYPE_CODES"
            }
        }

        /// What a JavaScript call returned or threw. `errorName` separates a
        /// deliberate rejection (`Error`, whose message is contractual) from a
        /// crash the validator did not intend (`TypeError`) or a parse failure
        /// (`SyntaxError`) — for those two only the kind is compared, because
        /// the wording belongs to V8 and not to this schema.
        struct Verdict: Decodable {
            let ok: Bool
            let errorName: String?
            let error: String?
        }

        struct TrainCase: Decodable {
            let label: String
            let note: String?
            let train: String
            let ok: Bool
            let errorName: String?
            let error: String?
        }

        struct ExportCase: Decodable {
            let country: String
            let index: Int
            let id: String
            let canonical: String
        }

        /// A real train whose section list has been disturbed, so that the
        /// export path's reuse-search and synthesis branches are reached.
        struct ExportProjection: Decodable {
            let label: String
            let country: String
            let id: String
            let input: String
            let canonical: String
        }

        struct ValidateCase: Decodable {
            let country: String
            let index: Int
            let id: String
            let ok: Bool
            let errorName: String?
            let error: String?
        }

        struct IDSequence: Decodable {
            let label: String
            let ids: [String]
            let results: [Verdict]
            let finalIds: [String]
        }

        struct StoreCase: Decodable {
            let label: String
            let store: String
            let ok: Bool
            let errorName: String?
            let error: String?
        }

        struct ParseCase: Decodable {
            let label: String
            /// A literal string handed to the function, so it parses first.
            let text: String?
            /// The JSON spelling of a live value handed to it, so it does not.
            let input: String?
            let ok: Bool
            let errorName: String?
            let error: String?
            /// The canonical spelling of the returned store, on success.
            let value: String?
        }

        struct AssertKeyCase: Decodable {
            let label: String
            let object: String
            let allowed: [String]
            let ok: Bool
            let errorName: String?
            let error: String?
        }

        struct NullishCase: Decodable {
            let label: String
            let ok: Bool
        }

        struct ImportCase: Decodable {
            let label: String
            let country: String
            let input: String
            let fallbackDate: String?
            let ok: Bool
            let errorName: String?
            let error: String?
            let value: String?
        }

        struct CodeProbe: Decodable {
            let code: String?
            let system: String?
            let valid: Bool
        }

        struct StringProbe: Decodable {
            let value: String
            let valid: Bool
        }

        struct UniqueIDCase: Decodable {
            let base: String
            let existing: [String]
            let result: String
        }

        let constants: Constants
        let cases: [TrainCase]
        let exportCases: [ExportCase]
        let exportProjections: [ExportProjection]
        let validateCases: [ValidateCase]
        let idSequences: [IDSequence]
        let storeCases: [StoreCase]
        let parseCases: [ParseCase]
        let assertKeyCases: [AssertKeyCase]
        let assertKeyNullish: [NullishCase]
        let importCases: [ImportCase]
        let stationCodes: [CodeProbe]
        let colors: [StringProbe]
        let ids: [StringProbe]
        let uniqueIdCases: [UniqueIDCase]
    }

    static func load() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "validation.json")
    }

    // MARK: - helpers

    /// The canonical spelling of anything the model encodes.
    ///
    /// Round-tripped through the JSON parser rather than compared as raw
    /// encoder bytes on purpose. `JSONEncoder` emits keys in no defined order
    /// and escapes `/` where `JSON.stringify` does not, so comparing its
    /// output directly would be comparing two encoders' habits. Parsing it
    /// back and re-spelling it canonically compares the *values*, which is
    /// what "round-trips without loss" has to mean.
    static func canonicalText<T: Encodable>(_ value: T) throws -> String {
        let data = try JSONEncoder().encode(value)
        return try TrainValidation.JSON.parse(String(decoding: data, as: UTF8.self)).canonicalText
    }

    static func storeURL(_ country: String) throws -> URL {
        let file = country == "jp" ? "train-store.json" : "train-store-\(country).json"
        return try PortFixtures.repositoryRoot().appending(path: "app/data/\(file)")
    }

    /// Runs a call that may throw and compares it to the JavaScript's verdict.
    ///
    /// The message is only compared for a deliberate `Error`. A `TypeError`
    /// carries V8's own wording ("Cannot read properties of null (reading
    /// 'departure')") and a `SyntaxError` carries V8's parser text; neither is
    /// part of any contract, and pinning them would make a Node upgrade look
    /// like a port regression. The *kind* is pinned, because "it rejected
    /// this" and "it fell over on this" are not the same answer.
    static func expectVerdict(
        _ label: String, ok: Bool, errorName: String?, error: String?,
        _ run: () throws -> Void
    ) {
        do {
            try run()
            #expect(ok, "\(label): Swift accepted it; the JavaScript threw \(error ?? "")")
        } catch let failure as TrainValidation.ValidationError {
            guard !ok else {
                Issue.record("\(label): Swift threw \(failure.message); the JavaScript accepted it")
                return
            }
            #expect(failure.kind.rawValue == errorName, "\(label): wrong kind of failure")
            if errorName == "Error" {
                #expect(failure.message == error, "\(label): wrong message")
            }
        } catch {
            Issue.record("\(label): unexpected error \(error)")
        }
    }

    // MARK: - the constants the messages are spelled from

    @Test func constants() throws {
        let fixture = try Self.load()
        #expect(TrainValidation.schemaVersion == fixture.constants.schemaVersion)
        #expect(TrainValidation.acceptedSchemaVersions == fixture.constants.acceptedSchemaVersions)
        #expect(TrainValidation.trainIDPatternSource == fixture.constants.trainIDPattern)
        // Order is contractual: the five values are joined into the error
        // message when a stop_type is rejected.
        #expect(TrainValidation.stopTypes == fixture.constants.stopTypes)
        #expect(TrainValidation.undated == fixture.constants.undated)
        #expect(TrainValidation.defaultTrainColor == fixture.constants.defaultTrainColor)
        #expect(
            TrainValidation.defaultAllowedInstitutionTypeCodes
                == fixture.constants.defaultAllowedInstitutionTypeCodes)
    }

    // MARK: - the model round-trips the committed archive

    /// Decode → encode → compare, on every train in both stores.
    ///
    /// The comparison is against the *file's own* canonical spelling, not
    /// against another Swift value, so this cannot pass by the encoder and the
    /// decoder agreeing with each other. A field the model forgot, a `null`
    /// turned into an absent key, or an absent key turned into a `null` all
    /// show up as a differing train.
    @Test(arguments: ["jp", "tw"]) func committedStoreRoundTrips(country: String) throws {
        let raw = try Data(contentsOf: Self.storeURL(country))
        let original = try TrainValidation.JSON.parse(String(decoding: raw, as: UTF8.self))
        let store = try JSONDecoder().decode(TrainStore.self, from: raw)

        guard case .array(let originalTrains)? = original["trains"] else {
            Issue.record("\(country): the store has no trains array")
            return
        }
        #expect(store.trains.count == originalTrains.count)
        for (index, train) in store.trains.enumerated() where index < originalTrains.count {
            #expect(
                try Self.canonicalText(train) == originalTrains[index].canonicalText,
                "\(country) train \(index) (\(train.id)) did not round-trip")
        }
        // And the whole store, so `schema_version` and the root shape are
        // covered too.
        #expect(try Self.canonicalText(store) == original.canonicalText)
    }

    // MARK: - the canonical export

    /// `buildCanonicalTrainStore` over every committed train.
    ///
    /// This is where the model, the six-field stop shape, the section
    /// recomputation from stop pairs, `leanExportSection`'s name-dropping and
    /// the per-country company rule all meet. The fixture was generated with
    /// no station table installed — a real boot state — and the port is driven
    /// the same way, which is what makes the answer a pure function of the
    /// store.
    @Test(arguments: ["jp", "tw"]) func canonicalExport(country: String) throws {
        let fixture = try Self.load()
        let raw = try Data(contentsOf: Self.storeURL(country))
        let store = try JSONDecoder().decode(TrainStore.self, from: raw)
        let canonical = TrainValidation.buildCanonicalTrainStore(
            store.trains, country: country, stations: .empty)

        let expected = fixture.exportCases.filter { $0.country == country }
        #expect(canonical.trains.count == expected.count)
        for (index, train) in canonical.trains.enumerated() where index < expected.count {
            #expect(
                try Self.canonicalText(train) == expected[index].canonical,
                "\(country) train \(index) (\(expected[index].id)) exported differently")
        }
    }

    /// The export path with the section list deliberately out of step.
    ///
    /// `getRideRouteSectionsForTrain` reuses a written section only when it
    /// matches the stop pair, preferring the section at the same index and
    /// otherwise searching the whole list. Both committed stores are already
    /// in step, so the search fallback and the synthesis branch are dead code
    /// over them — rotating, reversing, truncating and emptying the list is
    /// what reaches them, and clearing the stop names or the stop codes is
    /// what forces the match to go through one key rather than either.
    @Test func exportProjections() throws {
        let fixture = try Self.load()
        #expect(!fixture.exportProjections.isEmpty)
        for projection in fixture.exportProjections {
            let train = try JSONDecoder().decode(
                Train.self, from: Data(projection.input.utf8))
            let exported = TrainValidation.normalizeExportTrain(
                train, country: projection.country, stations: .empty)
            #expect(
                try Self.canonicalText(exported) == projection.canonical,
                "\(projection.label) (\(projection.id)) exported differently")
        }
    }

    /// Every committed train, and each whole store, through `validateTrain`.
    ///
    /// All 229 pass in the JavaScript; the value of the case is that it stays
    /// that way. A port that tightened any rule would reject data the archive
    /// already contains, and this is where that shows up.
    @Test(arguments: ["jp", "tw"]) func committedTrainsValidate(country: String) throws {
        let fixture = try Self.load()
        let raw = try Data(contentsOf: Self.storeURL(country))
        let store = try JSONDecoder().decode(TrainStore.self, from: raw)
        let canonical = TrainValidation.buildCanonicalTrainStore(
            store.trains, country: country, stations: .empty)

        for expected in fixture.validateCases where expected.country == country {
            if expected.index < 0 {
                // The whole store, so id uniqueness is checked across all of it.
                let json = try TrainValidation.JSON.parse(
                    String(decoding: try JSONEncoder().encode(canonical), as: UTF8.self))
                Self.expectVerdict(
                    expected.id, ok: expected.ok, errorName: expected.errorName,
                    error: expected.error
                ) { try TrainValidation.validateTrainStore(json) }
                continue
            }
            let json = try TrainValidation.JSON.parse(
                String(
                    decoding: try JSONEncoder().encode(canonical.trains[expected.index]),
                    as: UTF8.self))
            var ids = Set<String>()
            Self.expectVerdict(
                "\(country)[\(expected.index)] \(expected.id)", ok: expected.ok,
                errorName: expected.errorName, error: expected.error
            ) { try TrainValidation.validateTrain(json, index: expected.index, ids: &ids) }
        }
    }

    // MARK: - the adversarial cases

    /// 146 projections of a real itinerary, one field changed each.
    ///
    /// Three of them are crashes rather than rejections and are expected to
    /// stay crashes: a `null` row in `stops`, or in `route_sections`, reaches
    /// a property access before anything has checked it is an object.
    @Test func adversarialTrains() throws {
        let fixture = try Self.load()
        #expect(!fixture.cases.isEmpty)
        for testCase in fixture.cases {
            let train = try TrainValidation.JSON.parse(testCase.train)
            var ids = Set<String>()
            Self.expectVerdict(
                testCase.label, ok: testCase.ok, errorName: testCase.errorName,
                error: testCase.error
            ) { try TrainValidation.validateTrain(train, index: 0, ids: &ids) }
        }
        // The crash cases have to still be crashes, or the fixture has been
        // regenerated against a JavaScript that fixed them and this file's
        // claim about them is stale.
        let crashes = fixture.cases.filter { $0.errorName == "TypeError" }
        #expect(crashes.count == 3, "expected the three known null-row crashes")
    }

    /// The duplicate-id rule, which only exists across a sequence of calls
    /// because `validateTrain` mutates the caller's id set.
    ///
    /// The last sequence is the one worth having: an id that fails the charset
    /// check never enters the set, so the same bad id can be offered twice and
    /// gets the same charset error both times rather than a duplicate error
    /// the second time.
    @Test func duplicateIDs() throws {
        let fixture = try Self.load()
        for sequence in fixture.idSequences {
            var ids = Set<String>()
            // Rebuilt from the same base train the fixture projected from.
            for (index, id) in sequence.ids.enumerated() {
                let expected = sequence.results[index]
                let base = try TrainValidation.JSON.parse(fixture.cases[0].train)
                let train = Self.replacing(base, key: "id", with: .string(id))
                Self.expectVerdict(
                    "\(sequence.label)[\(index)]", ok: expected.ok, errorName: expected.errorName,
                    error: expected.error
                ) { try TrainValidation.validateTrain(train, index: index, ids: &ids) }
            }
            #expect(ids == Set(sequence.finalIds), "\(sequence.label): wrong surviving id set")
        }
    }

    /// Rebuilds an object with one key replaced, keeping every other key in
    /// place — the fixture's `project()` in Swift.
    static func replacing(
        _ value: TrainValidation.JSON, key: String, with replacement: TrainValidation.JSON
    ) -> TrainValidation.JSON {
        guard case .object(let object) = value else { return value }
        let pairs = object.keys.map { existing in
            (existing, existing == key ? replacement : object[existing]!)
        }
        return .object(TrainValidation.JSON.Object(pairs))
    }

    // MARK: - the store and the parser

    @Test func stores() throws {
        let fixture = try Self.load()
        for testCase in fixture.storeCases {
            let store = try TrainValidation.JSON.parse(testCase.store)
            Self.expectVerdict(
                testCase.label, ok: testCase.ok, errorName: testCase.errorName,
                error: testCase.error
            ) { try TrainValidation.validateTrainStore(store) }
        }
    }

    /// `parseImportedCanonicalStore` over both of its input forms.
    ///
    /// The `text` cases go through the parser first, which is the branch a
    /// pasted export takes; the `input` cases are handed a live value, which
    /// is the branch a programmatic import takes. They differ: only the text
    /// branch can fail with a `SyntaxError`.
    @Test func importedStores() throws {
        let fixture = try Self.load()
        for testCase in fixture.parseCases {
            var produced: TrainValidation.JSON?
            Self.expectVerdict(
                testCase.label, ok: testCase.ok, errorName: testCase.errorName,
                error: testCase.error
            ) {
                if let text = testCase.text {
                    produced = try TrainValidation.parseImportedCanonicalStore(text: text)
                } else if let input = testCase.input {
                    produced = try TrainValidation.parseImportedCanonicalStore(
                        value: try TrainValidation.JSON.parse(input))
                } else {
                    Issue.record("\(testCase.label): the case carries neither text nor input")
                }
            }
            if testCase.ok, let produced, let expected = testCase.value {
                #expect(produced.canonicalText == expected, "\(testCase.label): wrong store")
            }
        }
    }

    /// `assertOnlyKeys`, including the two ordering traps.
    ///
    /// `{"b":1,"10":1,"2":1,"a":1}` must name `"2"`: JavaScript lists
    /// integer-index keys first in ascending *numeric* order, so a port that
    /// preserves document order names `"b"` and one that sorts keys as strings
    /// names `"10"`.
    @Test func onlyKeys() throws {
        let fixture = try Self.load()
        for testCase in fixture.assertKeyCases {
            let object = try TrainValidation.JSON.parse(testCase.object)
            Self.expectVerdict(
                testCase.label, ok: testCase.ok, errorName: testCase.errorName,
                error: testCase.error
            ) { try TrainValidation.assertOnlyKeys(object, testCase.allowed, "Label") }
        }
        // `Object.keys(object || {})` is what makes a nil object pass rather
        // than throw, and both stores' import paths rely on it.
        for testCase in fixture.assertKeyNullish {
            #expect(testCase.ok, "\(testCase.label): the fixture expects a pass")
            #expect(throws: Never.self) {
                try TrainValidation.assertOnlyKeys(nil, ["a"], "Label")
            }
        }
    }

    // MARK: - the lenient inbound path

    /// Case labels whose JavaScript answer the typed ``Train`` cannot hold.
    ///
    /// `normalizeNullableTime` returns a non-string unchanged, so the number
    /// `830` survives import as a *number* in `departure` and is only rejected
    /// later by `validateTrain`. `Stop.departure` is `String?`, so the port
    /// stores nil instead. That is a deliberate narrowing of the model rather
    /// than a disagreement about the rule: the value is unusable either way
    /// and the alternative is to make every stop field dynamic. Listed here so
    /// the skip is visible, and asserted to still exist so it cannot rot.
    /// `canonicalStyle` likewise does no validation — it takes any truthy
    /// value straight through, so a numeric colour is *stored* as a number and
    /// only `validateTrain` rejects it. `TrainStyle.color` is `String?`, so
    /// the port spells it `"16711680"` instead.
    static let modelCannotRepresent: Set<String> = [
        "a time that is a number",
        "style.color is a number",
    ]

    @Test func importedTrains() throws {
        let fixture = try Self.load()
        for label in Self.modelCannotRepresent {
            #expect(
                fixture.importCases.contains { $0.label == label },
                "\(label) is no longer in the fixture — remove it from modelCannotRepresent")
        }
        for testCase in fixture.importCases {
            let input = try TrainValidation.JSON.parse(testCase.input)
            var produced: Train?
            Self.expectVerdict(
                testCase.label, ok: testCase.ok, errorName: testCase.errorName,
                error: testCase.error
            ) {
                produced = try TrainValidation.normalizeImportedTrain(
                    input, fallbackDate: testCase.fallbackDate, country: testCase.country,
                    stations: .empty)
            }
            guard testCase.ok, let produced, let expected = testCase.value,
                !Self.modelCannotRepresent.contains(testCase.label)
            else { continue }
            #expect(
                try Self.canonicalText(produced) == expected,
                "\(testCase.label): normalised differently")
        }
    }

    // MARK: - the predicates

    /// The station-code grammar (jsonspec §2.3).
    ///
    /// The probes that matter are the invisible ones: a leading U+FEFF is
    /// trimmed by ECMAScript and accepted, a leading U+0085 is not trimmed and
    /// rejected, and fullwidth digits are rejected because JavaScript's `\d`
    /// is ASCII. `CharacterSet.whitespacesAndNewlines` gets the first two
    /// backwards and `NSRegularExpression` gets the third wrong.
    @Test func stationCodes() throws {
        let fixture = try Self.load()
        for probe in fixture.stationCodes {
            let code: TrainValidation.JSON = probe.code.map { .string($0) } ?? .null
            #expect(
                TrainValidation.stationCodeSystem(code) == probe.system,
                "system of \(String(reflecting: probe.code))")
            #expect(
                TrainValidation.isValidSourceStationCode(code) == probe.valid,
                "validity of \(String(reflecting: probe.code))")
        }
        // A JSON number spelling six digits is a valid N02 code, because
        // `String(code)` runs first. Pinned here as well as in the train cases
        // because it is the reason `JSNumber.string` is used rather than
        // Swift's own `description` — the latter would spell "123456.0".
        #expect(TrainValidation.stationCodeSystem(.number(123_456)) == "N02")
        #expect(TrainValidation.stationCodeSystem(.number(3770)) == nil)
    }

    @Test func colors() throws {
        let fixture = try Self.load()
        for probe in fixture.colors {
            #expect(
                TrainValidation.isValidTrainColor(probe.value) == probe.valid,
                "colour \(String(reflecting: probe.value))")
        }
        // Neither nil nor "" is a colour, and neither throws: the JavaScript
        // tests `value || ""`.
        #expect(!TrainValidation.isValidTrainColor(nil))
    }

    @Test func trainIDs() throws {
        let fixture = try Self.load()
        for probe in fixture.ids {
            #expect(
                TrainValidation.matchesTrainIDPattern(probe.value) == probe.valid,
                "id \(String(reflecting: probe.value))")
        }
    }

    @Test func uniqueTrainIDs() throws {
        let fixture = try Self.load()
        for testCase in fixture.uniqueIdCases {
            #expect(
                TrainValidation.makeUniqueTrainId(
                    testCase.base, existingIDs: Set(testCase.existing)) == testCase.result,
                "makeUniqueTrainId(\(String(reflecting: testCase.base)))")
        }
    }

    // MARK: - the canonical spelling itself

    /// The stable stringifier the two sides compare on has to agree about
    /// numbers and key order, or every comparison above is vacuous.
    @Test func canonicalSpelling() throws {
        // JavaScript prints an integral number without a fractional part.
        #expect(TrainValidation.JSON.number(139).canonicalText == "139")
        #expect(TrainValidation.JSON.number(-0.0).canonicalText == "0")
        #expect(TrainValidation.JSON.number(0.00001).canonicalText == "0.00001")
        // Keys sorted by UTF-16 code unit: uppercase before lowercase, and
        // "10" before "2" (this is a string sort, unlike Object.keys').
        let object = try TrainValidation.JSON.parse(#"{"b":1,"A":2,"2":3,"10":4}"#)
        #expect(object.canonicalText == #"{"10":4,"2":3,"A":2,"b":1}"#)
        // But Object.keys puts the integer-index keys first, numerically.
        #expect(object.ownKeys == ["2", "10", "b", "A"])
        // Non-ASCII is not escaped; the control characters are.
        #expect(TrainValidation.JSON.string("関西空港").canonicalText == #""関西空港""#)
        #expect(TrainValidation.JSON.string("a\nb\u{1}").canonicalText == #""a\nb\u0001""#)
        // A repeated key keeps its first position and its last value.
        let repeated = try TrainValidation.JSON.parse(#"{"a":1,"b":2,"a":3}"#)
        #expect(repeated.ownKeys == ["a", "b"])
        #expect(repeated["a"] == .number(3))
    }
}
