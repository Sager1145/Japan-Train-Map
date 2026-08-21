import Foundation
import RailCore
import Testing

/// `Stations` against the JavaScript that generated `port-fixtures/stations.json`.
///
/// Resolution is the step that decides which feature a written name means, so
/// a disagreement here is not a rendering difference — it is a train calling at
/// a different station. The fixture therefore carries every station name in all
/// five shipped packages, every stop name in all five committed train stores,
/// and every station code, each resolved against the country index that has to
/// answer it.
///
/// **Every comparison in this file is by UTF-16 code unit.** Swift's `==` on
/// `String` is canonical equivalence, and this data contains a name where that
/// is the wrong question: the shipped `jp` package spells 笹塚 with U+FA10,
/// whose canonical decomposition is the U+585A that anybody typing the name
/// produces. `==` calls those equal. JavaScript does not, the index does not,
/// and a test that used `==` would pass a port that answered with the other
/// spelling.
struct StationsParityTests {

    // MARK: - Reading the fixture

    /// The row encoding: fields separated by U+0000, split on code units so a
    /// field's exact bytes survive the split.
    static func fields(_ row: String) -> [String] {
        var out: [String] = []
        var current: [UInt16] = []
        for unit in row.utf16 {
            if unit == 0 {
                out.append(String(decoding: current, as: UTF16.self))
                current = []
            } else {
                current.append(unit)
            }
        }
        out.append(String(decoding: current, as: UTF16.self))
        return out
    }

    /// `a === b`, which is what every lookup in the ported code performs.
    static func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }

    /// A readable rendering of a string's code units, for a failure message —
    /// two strings that print identically are exactly the interesting case.
    static func units(_ value: String) -> String {
        value.utf16.map { String(format: "%04X", $0) }.joined(separator: " ")
    }

    struct Fixture: Decodable {
        struct Nullish: Decodable {
            let input: String
            let output: String
        }
        struct CodeDetail: Decodable {
            let code: String
            let system: String?
            let valid: Bool
            let fieldLabel: String
        }
        struct LookupKeyCase: Decodable {
            let name: String?
            let code: String?
            let keys: [String]
        }
        struct CountrySummary: Decodable {
            let country: String
            let features: Int
            let packageNames: Int
            let storeNames: Int
        }
        struct AccessorCase: Decodable {
            let country: String
            let index: Int
            let name: String?
            let code: String?
            let groupCode: String?
            let lineName: String
            let `operator`: String
            let institutionTypeCode: String
            let displayCoordinate: [Double]?
        }
        struct StopShape: Decodable {
            let name: String?
            let n02_station_code: String?
            let N02_005c: String?
        }
        struct StopCase: Decodable {
            let stop: StopShape
            let name: String
            let code: String?
        }
        struct Dedupe: Decodable {
            let inputCount: Int
            let keptIndices: [Int]
            let tail: [Stations.Feature]
        }
        struct FeatureKey: Decodable, Equatable {
            let name: String?
            let code: String?
            let lineName: String
            let `operator`: String
            let institutionTypeCode: String
            let coordinate: [Double]?
        }
        struct ResolverCase: Decodable {
            let allowed: [String]?
            let allowedWasRequested: Bool
            let preferredIndices: [Int]?
            let resolved: FeatureKey?
        }
        struct QueryCase: Decodable {
            let kind: String
            let name: String?
            let stopIndex: Int?
            let candidates: [FeatureKey]
            let anchors: [[Double]]?
            let withoutResolver: FeatureKey?
            let withResolver: [ResolverCase]
        }
        struct TrainShape: Decodable {
            let stops: [StopShape]?
        }
        struct TrainCase: Decodable {
            let index: Int
            let train: TrainShape
            let anchors: [[Double]]
            let queries: [QueryCase]
        }
        struct ReadingTable: Decodable {
            let country: String
            let declaredCountry: String?
            let byCode: Int
            let byName: Int
        }

        let normalize: [String]
        let normalizeNullish: [Nullish]
        let codeSystem: [String]
        let codeSystemDetail: [CodeDetail]
        let codeSystemNullish: [CodeDetail]
        let lookupKeys: [LookupKeyCase]
        let countries: [CountrySummary]
        let sharedNames: [String]
        let lookupKeyRows: [String]
        let nameByCodeRows: [String]
        let cases: [String]
        let synthetic: [Stations.Feature]
        let accessors: [AccessorCase]
        let stops: [StopCase]
        let dedupe: Dedupe
        let trains: [TrainCase]
        let readingTables: [ReadingTable]
        let readings: [String]
    }

    static func fixture() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "stations.json")
    }

    /// The `stations*.json` the app actually resolves against, and the indexes
    /// built from them, cached across the suite.
    ///
    /// They are not carried in the fixture: they are the port's INPUT, they are
    /// already in the repository, and a copy inside the fixture would be a copy
    /// that can drift from the one the web app loads. Japan alone is 3.3 MB and
    /// 10,233 features, so caching is worth it — and the lock is not optional,
    /// because Swift Testing runs these tests concurrently and several of them
    /// want the same country. Recursive, since building an index reads a
    /// collection through the same lock.
    private final class Store: @unchecked Sendable {
        private let lock = NSRecursiveLock()
        private var collections: [String: Stations.FeatureCollection] = [:]
        private var indexes: [String: Stations.Index] = [:]

        func collection(_ country: String) throws -> Stations.FeatureCollection {
            lock.lock()
            defer { lock.unlock() }
            if let cached = collections[country] { return cached }
            let suffix = country == "jp" ? "" : "-\(country)"
            let url = try PortFixtures.repositoryRoot()
                .appending(path: "app/data/stations\(suffix).json")
            let loaded = try Stations.FeatureCollection.load(contentsOf: url)
            collections[country] = loaded
            return loaded
        }

        func index(_ country: String) throws -> Stations.Index {
            lock.lock()
            defer { lock.unlock() }
            if let cached = indexes[country] { return cached }
            let built = Stations.Index(try collection(country))
            indexes[country] = built
            return built
        }
    }

    private static let store = Store()

    static func collection(_ country: String) throws -> Stations.FeatureCollection {
        try store.collection(country)
    }

    static func index(_ country: String) throws -> Stations.Index {
        try store.index(country)
    }

    static func stop(_ shape: Fixture.StopShape) -> Stations.Stop {
        Stations.Stop(
            name: shape.name, n02StationCode: shape.n02_station_code, n02_005c: shape.N02_005c)
    }

    static func key(_ feature: Stations.Feature) -> Fixture.FeatureKey {
        Fixture.FeatureKey(
            name: Stations.stationName(feature),
            code: Stations.stationCode(feature),
            lineName: Stations.stationLineName(feature),
            operator: Stations.stationOperator(feature),
            institutionTypeCode: Stations.stationInstitutionTypeCode(feature),
            coordinate: Stations.displayCoordinate(feature))
    }

    /// Feature keys compared field by field, strings by code unit and
    /// coordinates bit for bit.
    static func matches(_ made: Fixture.FeatureKey?, _ expected: Fixture.FeatureKey?) -> Bool {
        guard let made, let expected else { return made == nil && expected == nil }
        func optional(_ a: String?, _ b: String?) -> Bool {
            switch (a, b) {
            case (nil, nil): return true
            case (let a?, let b?): return same(a, b)
            default: return false
            }
        }
        guard optional(made.name, expected.name), optional(made.code, expected.code),
            same(made.lineName, expected.lineName), same(made.operator, expected.operator),
            same(made.institutionTypeCode, expected.institutionTypeCode)
        else { return false }
        switch (made.coordinate, expected.coordinate) {
        case (nil, nil): return true
        case (let a?, let b?):
            return a.count == b.count
                && zip(a, b).allSatisfy { $0.bitPattern == $1.bitPattern }
        default: return false
        }
    }

    // MARK: - normalizeStationName

    /// The one key rule for every station-name identity in the system.
    ///
    /// Every distinct name in every package and every store goes through it,
    /// plus the block written to break it: decomposed spellings, both width
    /// families, the four small-kana variants, and each of the sixteen
    /// whitespace characters that ECMAScript and Foundation disagree about.
    @Test("normalizeStationName folds every shipped name the way the JavaScript does")
    func normalize() throws {
        let fixture = try Self.fixture()
        #expect(fixture.normalize.count > 10_000)

        for row in fixture.normalize {
            let parts = Self.fields(row)
            let (input, expected) = (parts[0], parts[1])
            let made = Stations.normalizeStationName(input)
            #expect(
                Self.same(made, expected),
                """
                normalizeStationName(\(Self.units(input)))
                  made     \(Self.units(made))
                  expected \(Self.units(expected))
                """)
        }
        for item in fixture.normalizeNullish {
            #expect(
                Self.same(Stations.normalizeStationName(nil), item.output),
                "normalizeStationName(\(item.input))")
        }
    }

    /// The one name in the shipped data whose spelling makes Swift and
    /// JavaScript disagree, called out on its own because everything else in
    /// this file rests on getting it right.
    ///
    /// 笹塚 (Keio, station 003806) is stored with U+FA10, a CJK COMPATIBILITY
    /// IDEOGRAPH that canonically decomposes to U+585A. Swift's `String` says
    /// the two spellings are one string; the index says they are two keys.
    @Test("the compatibility-ideograph name is two keys, not one")
    func compatibilityIdeographStaysTwoKeys() throws {
        let shipped = "笹\u{FA10}"
        let typed = "笹\u{585A}"

        // The premise: Swift really does consider these equal, so a port that
        // used `==` or a String-keyed table would be testing nothing here.
        #expect(shipped == typed)
        #expect(!Self.same(shipped, typed))
        #expect(Set([shipped, typed]).count == 1)

        // The rule: the raw name and its normalized alias are two keys.
        let keys = Stations.stationLookupKeys(name: shipped, code: nil)
        #expect(keys.count == 2)
        #expect(Self.same(keys[0], shipped))
        #expect(Self.same(keys[1], typed))

        // And both spellings reach the same station through different branches
        // — the shipped one by exact match, the typed one by the alias.
        let jp = try Self.index("jp")
        let viaShipped = jp.candidateIndices(for: .name(shipped))
        let viaTyped = jp.candidateIndices(for: .name(typed))
        #expect(!viaShipped.isEmpty)
        #expect(viaShipped == viaTyped)
    }

    // MARK: - Station codes

    @Test("every shipped station code is attributed to the same source system")
    func codeSystems() throws {
        let fixture = try Self.fixture()
        #expect(fixture.codeSystem.count > 12_000)

        for row in fixture.codeSystem {
            let parts = Self.fields(row)
            let (code, expected) = (parts[0], parts[1])
            let made = Stations.stationCodeSystem(code) ?? ""
            #expect(Self.same(made, expected), "stationCodeSystem(\(Self.units(code)))")
        }
        for item in fixture.codeSystemDetail {
            #expect(
                Stations.stationCodeSystem(item.code) == item.system,
                "stationCodeSystem(\(Self.units(item.code)))")
            #expect(
                Stations.isValidSourceStationCode(item.code) == item.valid,
                "isValidSourceStationCode(\(Self.units(item.code)))")
            #expect(
                Self.same(Stations.stationCodeFieldLabel(item.code), item.fieldLabel),
                "stationCodeFieldLabel(\(Self.units(item.code)))")
        }
        // An absent code is a valid one — a stop need not carry a source code —
        // while the empty string is not, because it belongs to no system. Both
        // `null` and `undefined` reach the JavaScript here and behave
        // identically, which is why Swift can collapse them to nil.
        for item in fixture.codeSystemNullish {
            #expect(Stations.stationCodeSystem(nil) == item.system, "\(item.code)")
            #expect(Stations.isValidSourceStationCode(nil) == item.valid, "\(item.code)")
            #expect(Self.same(Stations.stationCodeFieldLabel(nil), item.fieldLabel), "\(item.code)")
        }
        #expect(Stations.isValidSourceStationCode("") == false)
    }

    // MARK: - The index keys

    /// `stationLookupKeys` over every feature of all five collections, which is
    /// the index-construction rule itself.
    ///
    /// The rows also pin the ACCESSORS: each carries the name and code the
    /// JavaScript read off that feature, in feature order, so a port whose
    /// property fallback chain picks a different spelling fails here rather
    /// than silently indexing the wrong string.
    @Test("every feature is filed under the same keys")
    func lookupKeys() throws {
        let fixture = try Self.fixture()

        for item in fixture.lookupKeys {
            let made = Stations.stationLookupKeys(name: item.name, code: item.code)
            #expect(
                made.count == item.keys.count
                    && zip(made, item.keys).allSatisfy(Self.same),
                """
                stationLookupKeys(name: \(item.name.map(Self.units) ?? "nil"), \
                code: \(item.code.map(Self.units) ?? "nil"))
                  made     \(made.map(Self.units))
                  expected \(item.keys.map(Self.units))
                """)
        }

        var cursor: [String: Int] = [:]
        for row in fixture.lookupKeyRows {
            let parts = Self.fields(row)
            let country = parts[0]
            let position = cursor[country, default: 0]
            cursor[country] = position + 1

            let feature = try Self.collection(country).features[position]
            let name = Stations.stationName(feature) ?? ""
            let code = Stations.stationCode(feature) ?? ""
            #expect(Self.same(name, parts[1]), "\(country)[\(position)] station name")
            #expect(Self.same(code, parts[2]), "\(country)[\(position)] station code")

            let made = Stations.stationLookupKeys(name: name, code: code)
            let expected = Array(parts.dropFirst(3))
            #expect(
                made.count == expected.count && zip(made, expected).allSatisfy(Self.same),
                """
                \(country)[\(position)] keys
                  made     \(made.map(Self.units))
                  expected \(expected.map(Self.units))
                """)
        }
        for summary in fixture.countries {
            #expect(cursor[summary.country] == summary.features, "\(summary.country)")
        }
    }

    /// The code → name map the same pass produces, over every code it indexed.
    ///
    /// Note what it does NOT do: trim. A code with stray spaces finds nothing,
    /// which is why the probe rows include padded spellings of a real code.
    @Test("the code to name map answers for every indexed code")
    func nameByCode() throws {
        let fixture = try Self.fixture()

        for row in fixture.nameByCodeRows {
            let parts = Self.fields(row)
            let index = try Self.index(parts[0])
            let made = index.name(forCode: parts[1])
            #expect(
                Self.same(made, parts[2]),
                """
                \(parts[0]) stationNameForCode(\(Self.units(parts[1])))
                  made     \(Self.units(made))
                  expected \(Self.units(parts[2]))
                """)
        }
    }

    // MARK: - Resolution

    /// The whole of it: every package name, every store stop name, every shared
    /// name against every country, every feature as a stop object, and the
    /// adversarial block.
    ///
    /// The `w` flag marks the branch where a station code and a station name
    /// disagree. That is not a diagnostic — a source code is line- and
    /// operator-specific, so the code pool is never unioned with the name pool,
    /// and the fall-back from one to the other is a decision the port has to
    /// take in the same places.
    @Test("every written name resolves to the same candidates, in the same order")
    func resolution() throws {
        let fixture = try Self.fixture()
        #expect(fixture.cases.count > 30_000)

        var warnedCases = 0
        for row in fixture.cases {
            let parts = Self.fields(row)
            let country = parts[0]
            let mode = parts[1]
            let subject = parts[2]
            let extra = parts[3]
            let expectedWarned = parts[4] == "w"
            let expected =
                parts[5].isEmpty ? [] : parts[5].split(separator: ",").map { Int($0)! }

            let index = try Self.index(country)
            let features = index.features
            let query: Stations.Query?
            switch mode {
            case "s":
                query = .name(subject)
            case "o":
                query = .stop(Stations.Stop(name: subject, n02StationCode: extra))
            case "f", "c", "m", "l":
                let feature = features[Int(subject)!]
                let name = Stations.stationName(feature)
                let code = Stations.stationCode(feature)
                switch mode {
                case "f": query = .stop(Stations.Stop(name: name, n02StationCode: code))
                case "c": query = .stop(Stations.Stop(name: "", n02StationCode: code))
                case "m":
                    let other = Stations.stationCode(features[Int(extra)!])
                    query = .stop(Stations.Stop(name: name, n02StationCode: other))
                default: query = .stop(Stations.Stop(name: name, n02_005c: code))
                }
            default:
                Issue.record("unknown case mode \(mode)")
                continue
            }

            var warned = false
            let made = index.candidateIndices(for: query, warned: &warned)
            if expectedWarned { warnedCases += 1 }
            #expect(
                made == expected,
                "\(country) \(mode) \(Self.units(subject)) → \(made) but the JavaScript says \(expected)"
            )
            #expect(
                warned == expectedWarned,
                "\(country) \(mode) \(Self.units(subject)) code/name mismatch flag")
        }
        // The mismatch branch is not a rarity the fixture happened to miss.
        #expect(warnedCases > 1_000)
    }

    /// A name that is a strict prefix of another must not drag it in, and a
    /// name two countries spell the same way must answer differently in each.
    @Test("prefixes and shared names stay separate")
    func prefixesAndSharedNames() throws {
        let fixture = try Self.fixture()
        let jp = try Self.index("jp")

        let osaka = jp.candidates(for: .name("大阪"))
        #expect(!osaka.isEmpty)
        for feature in osaka {
            #expect(Self.same(Stations.stationName(feature) ?? "", "大阪"))
        }
        #expect(!jp.candidateIndices(for: .name("大阪城公園")).isEmpty)

        // 松山 is Ehime in Japan and Taipei in Taiwan. The two indexes are
        // never loaded together precisely because this resolves in both.
        #expect(fixture.sharedNames.contains { Self.same($0, "松山") })
        let jpMatsuyama = jp.candidates(for: .name("松山"))
        let twMatsuyama = try Self.index("tw").candidates(for: .name("松山"))
        #expect(!jpMatsuyama.isEmpty)
        #expect(!twMatsuyama.isEmpty)
        #expect(
            !Self.same(
                Stations.stationOperator(jpMatsuyama[0]),
                Stations.stationOperator(twMatsuyama[0])))

        // A blank name is not a name: it must reach no bucket at all, or every
        // blank stop in an imported file would collide in one.
        for blank in ["", " ", "　", "\u{FEFF}", "\u{00A0}", "\t\n"] {
            #expect(jp.candidateIndices(for: .name(blank)).isEmpty, "\(Self.units(blank))")
        }
        // U+0085 is the exception that proves the point: ECMAScript does not
        // trim it, so it is a one-character NAME, not blank — and it simply
        // finds nothing. A port trimming with Foundation's whitespace set would
        // treat it as blank and take the other branch to the same answer.
        #expect(jp.candidateIndices(for: .name("\u{0085}")).isEmpty)
        #expect(!Stations.stationLookupKeys(name: "\u{0085}", code: nil).isEmpty)
        #expect(Stations.stationLookupKeys(name: "\u{FEFF}", code: nil).isEmpty)
    }

    // MARK: - Accessors, stops, dedupe

    @Test("the property fallback chains pick the same field")
    func accessors() throws {
        let fixture = try Self.fixture()

        for item in fixture.accessors {
            let feature: Stations.Feature =
                item.country == "synthetic"
                ? fixture.synthetic[item.index]
                : try Self.collection(item.country).features[item.index]
            let label = "\(item.country)[\(item.index)]"

            switch (Stations.stationName(feature), item.name) {
            case (nil, nil): break
            case (let made?, let expected?):
                #expect(Self.same(made, expected), "\(label) stationName")
            default:
                Issue.record("\(label) stationName presence")
            }
            switch (Stations.stationCode(feature), item.code) {
            case (nil, nil): break
            case (let made?, let expected?):
                #expect(Self.same(made, expected), "\(label) stationCode")
            default:
                Issue.record("\(label) stationCode presence")
            }
            switch (Stations.stationGroupCode(feature), item.groupCode) {
            case (nil, nil): break
            case (let made?, let expected?):
                #expect(Self.same(made, expected), "\(label) stationGroupCode")
            default:
                Issue.record("\(label) stationGroupCode presence")
            }
            #expect(
                Self.same(Stations.stationLineName(feature), item.lineName),
                "\(label) stationLineName")
            #expect(
                Self.same(Stations.stationOperator(feature), item.operator),
                "\(label) stationOperator")
            #expect(
                Self.same(
                    Stations.stationInstitutionTypeCode(feature), item.institutionTypeCode),
                "\(label) stationInstitutionTypeCode — String(3), not String(3.0)")

            switch (Stations.displayCoordinate(feature), item.displayCoordinate) {
            case (nil, nil): break
            case (let made?, let expected?):
                #expect(
                    made.count == expected.count
                        && zip(made, expected).allSatisfy { $0.bitPattern == $1.bitPattern },
                    "\(label) displayCoordinate")
            default:
                Issue.record("\(label) displayCoordinate presence")
            }
        }
    }

    @Test("stop fields fall back the same way")
    func stopAccessors() throws {
        let fixture = try Self.fixture()
        for item in fixture.stops {
            let made = Self.stop(item.stop)
            #expect(Self.same(Stations.stopName(made), item.name))
            switch (Stations.stopStationCode(made), item.code) {
            case (nil, nil): break
            case (let a?, let b?): #expect(Self.same(a, b))
            default: Issue.record("stopStationCode presence")
            }
        }
    }

    /// The dedupe signature, including the two places JavaScript's own quirks
    /// show through: `JSON.stringify` printing 139 as `139`, and `0 || []`
    /// turning a Point at longitude zero into a feature with no coordinate.
    ///
    /// The tail of the input is the pair that separates a code-unit signature
    /// from a `String` one — two features identical but for which spelling of
    /// 笹塚 they carry. JavaScript keeps both; a `Set<String>` keeps one.
    @Test("deduplication keeps exactly the features the JavaScript keeps")
    func dedupe() throws {
        let fixture = try Self.fixture()
        let mo = try Self.collection("mo").features
        let input = fixture.synthetic + mo + mo + fixture.dedupe.tail
        #expect(input.count == fixture.dedupe.inputCount)
        #expect(Stations.dedupeStationFeatureIndices(input) == fixture.dedupe.keptIndices)
    }

    // MARK: - Train-aware resolution

    /// `resolveStationForTrain`, in both configurations.
    ///
    /// With no resolver the function is pure by-name resolution — the state the
    /// app is in before the route service loads. With one, the orchestration is
    /// what this port owns: consult the allowed codes, prefer the resolver's
    /// subset, fall back to the whole pool when it is empty, and break a
    /// remaining tie by distance to the train's anchor stops.
    ///
    /// The resolver here is a DOUBLE replaying what the fixture recorded, not a
    /// second port of the route modules' classifier. What is checked is
    /// therefore exactly what this file is responsible for: which resolver call
    /// happens, when, and what the answer does to the result. Distance is the
    /// real `Geometry.distanceMeters`, whose parity is already established by
    /// `distance.json`.
    final class Double_: StationRouteResolver {
        let allowed: [String]?
        let preferred: [Int]?
        var allowedRequested = false
        var filterCalled = false

        init(allowed: [String]?, preferred: [Int]?) {
            self.allowed = allowed
            self.preferred = preferred
        }

        func allowedInstitutionCodes(_ train: Stations.Train) -> [String]? {
            allowedRequested = true
            return allowed
        }

        func filterPreferredStations(_ candidates: [Stations.Feature], allowedCodes: [String])
            -> [Int]
        {
            filterCalled = true
            return preferred ?? []
        }

        func distanceMeters(_ a: [Double], _ b: [Double]) -> Double {
            guard let from = Coordinate(pair: a), let to = Coordinate(pair: b) else {
                return .nan
            }
            return Geometry.distanceMeters(from, to)
        }
    }

    @Test("a train's context picks the same station the JavaScript picks")
    func trainAwareResolution() throws {
        let fixture = try Self.fixture()
        let jp = try Self.index("jp")
        #expect(fixture.trains.count > 15)

        for item in fixture.trains {
            let stops = (item.train.stops ?? []).map(Self.stop)
            let train = Stations.Train(stops: stops)
            let label = "train[\(item.index)]"

            let anchors = jp.trainAnchorCoordinates(train, excluding: nil)
            #expect(
                anchors.count == item.anchors.count
                    && zip(anchors, item.anchors).allSatisfy { made, expected in
                        made.count == expected.count
                            && zip(made, expected).allSatisfy { $0.bitPattern == $1.bitPattern }
                    },
                "\(label) anchors: \(anchors.count) vs \(item.anchors.count)")

            for probe in item.queries {
                let query: Stations.Query =
                    probe.kind == "stop" ? .stop(stops[probe.stopIndex!]) : .name(probe.name ?? "")
                let name = probe.name ?? "stop[\(probe.stopIndex ?? -1)]"
                let where_ = "\(label) \(probe.kind) \(name)"

                let candidates = jp.candidates(for: query).map(Self.key)
                #expect(
                    candidates.count == probe.candidates.count
                        && zip(candidates, probe.candidates).allSatisfy(Self.matches),
                    "\(where_) candidates")

                // A stop resolved as an OBJECT is excluded from its own anchor
                // set; the same stop resolved by NAME is not. The exclusion is
                // by identity, so a train calling twice at one station keeps
                // the other visit.
                if let expectedAnchors = probe.anchors {
                    let made = jp.trainAnchorCoordinates(
                        train, excluding: stops[probe.stopIndex!])
                    #expect(
                        made.count == expectedAnchors.count
                            && zip(made, expectedAnchors).allSatisfy { a, b in
                                a.count == b.count
                                    && zip(a, b).allSatisfy { $0.bitPattern == $1.bitPattern }
                            },
                        "\(where_) anchors excluding the stop itself")
                }

                #expect(
                    Self.matches(
                        jp.resolveStationForTrain(query, train: train, resolver: nil)
                            .map { jp.features[$0] }.map(Self.key),
                        probe.withoutResolver),
                    "\(where_) with no resolver installed")

                for run in probe.withResolver {
                    let resolver = Double_(allowed: run.allowed, preferred: run.preferredIndices)
                    let made = jp.resolveStationForTrain(
                        query, train: train, resolver: resolver)
                    #expect(
                        Self.matches(made.map { jp.features[$0] }.map(Self.key), run.resolved),
                        "\(where_) with allowed \(run.allowed.map(String.init(describing:)) ?? "null")"
                    )
                    #expect(
                        resolver.allowedRequested == run.allowedWasRequested,
                        "\(where_) asked for the allowed codes")
                    // An empty allowed-code ARRAY is truthy, so it still calls
                    // the filter; a null does not. Both end up with the whole
                    // pool, by different routes.
                    #expect(
                        resolver.filterCalled == (run.preferredIndices != nil),
                        "\(where_) consulted the preference filter")
                }
            }
        }
    }

    // MARK: - Station readings

    /// The reading table's KEYING, which is a station-name resolution rule and
    /// the same rule as the index: `byName` is re-keyed through
    /// `normalizeStationName` at load, so a hit cannot depend on how the
    /// external table spelled its keys. That is not a no-op on the shipped
    /// data — five Hong Kong keys and one Korean one change.
    ///
    /// Which of the four languages a caller then shows is a display preference
    /// and is NOT ported. The two projections below exist only to observe the
    /// lookup through what `i18n.js` exports, since `stationReading` is
    /// module-private there: a table that declares TW/HK/MO/KR rewrites the
    /// name itself, and one that does not produces a zh reading subline. Both
    /// read the row directly, with no display dictionary in between.
    @Test("the reading lookup answers by code first and by normalized name second")
    func readings() throws {
        let fixture = try Self.fixture()
        var tables: [String: Stations.Readings] = [:]
        for table in fixture.readingTables {
            let suffix = table.country == "jp" ? "" : "-\(table.country)"
            let url = try PortFixtures.repositoryRoot()
                .appending(path: "app/data/station-readings\(suffix).json")
            let (readings, raw) = try Stations.Readings.load(contentsOf: url)
            tables[table.country] = readings

            // A count that came up short would mean Swift's Dictionary merged
            // two keys the JavaScript kept apart — the same canonical-
            // equivalence collapse this whole port is written against, arriving
            // through JSONDecoder instead.
            #expect(raw.byCode?.count == table.byCode, "\(table.country) byCode key count")
            #expect(raw.byName?.count == table.byName, "\(table.country) byName key count")
            #expect(readings.codeKeyCount == table.byCode, "\(table.country) byCode re-keyed")
            #expect(readings.nameKeyCount == table.byName, "\(table.country) byName re-keyed")
        }

        for row in fixture.readings {
            let parts = Self.fields(row)
            let readings = tables[parts[0]]!
            let code = parts[1].isEmpty ? nil : parts[1]
            let name = parts[2].isEmpty ? nil : parts[2]
            let row_ = readings.reading(code: code, name: name)
            let label = "\(parts[0]) code=\(parts[1]) name=\(Self.units(parts[2]))"

            #expect(
                Self.same(
                    Self.stationNameProjection(readings, row: row_, name: name), parts[3]),
                "\(label) localized name")
            #expect(
                Self.same(Self.readingSublineProjection(readings, row: row_, name: name), parts[4]),
                "\(label) reading subline")
        }
    }

    /// `I18N.stationName` under zh-Hant, which is `row.zh_Hant || name` for a
    /// table that declares one of the four localized-name countries and the
    /// name unchanged for any other. The language pick is the display rule; the
    /// row it reads is the ported lookup.
    static func stationNameProjection(
        _ readings: Stations.Readings, row: Stations.Readings.Row?, name: String?
    ) -> String {
        guard let name, !name.utf16.isEmpty else { return name ?? "" }
        guard Stations.Readings.localizedNameCountries.contains(readings.declaredCountry)
        else { return name }
        guard let row else { return name }
        if let value = row["zh_Hant"], value.isTruthy { return value.jsString }
        return name
    }

    /// `I18N.nameReadingsTyped` under zh-Hant with only the zh toggle on. It
    /// has no dictionary fallback, so it reports the table and nothing else —
    /// and it is suppressed for the four localized-name countries, which is why
    /// the two projections are complementary rather than redundant.
    static func readingSublineProjection(
        _ readings: Stations.Readings, row: Stations.Readings.Row?, name: String?
    ) -> String {
        guard let name, !name.utf16.isEmpty else { return "[]" }
        guard !Stations.Readings.localizedNameCountries.contains(readings.declaredCountry)
        else { return "[]" }
        guard let row else { return "[]" }
        var zh: String?
        if let value = row["zh_Hant"], value.isTruthy {
            zh = value.jsString
        } else if let value = row["zh_Hans"], value.isTruthy {
            zh = value.jsString
        }
        guard let zh, !same(zh, name) else { return "[]" }
        return "[{\"type\":\"zh\",\"text\":\(Stations.Value.string(zh).jsonStringified)}]"
    }

    // MARK: - Coverage

    /// What the fixture actually covers, asserted rather than described, so
    /// that a future regeneration cannot quietly shrink it.
    @Test("the fixture covers every name the app has to resolve")
    func coverage() throws {
        let fixture = try Self.fixture()
        #expect(fixture.countries.count == 5)

        var packageNames = 0
        var storeNames = 0
        for summary in fixture.countries {
            let features = try Self.collection(summary.country).features.count
            #expect(features == summary.features, "\(summary.country)")
            packageNames += summary.packageNames
            storeNames += summary.storeNames
        }
        // 10,361 package station names across the five packages (10,328
        // distinct once the 33 names two countries share are counted once),
        // and 1,689 stop names across the five committed stores.
        #expect(packageNames == 10_361)
        #expect(storeNames > 1_600)
        #expect(fixture.sharedNames.count == 33)

        // Every bare-name query in the fixture is one of those names, one of
        // the shared ones against a country that does not have it, or an
        // adversarial input — and there are more cases than names because
        // every feature is also queried as a stop object, three ways.
        #expect(fixture.cases.count > packageNames + storeNames)
    }
}
