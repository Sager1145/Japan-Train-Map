import Foundation
import RailCore
import Testing

/// `Localization` against the JavaScript that generated `port-fixtures/i18n.json`,
/// over the String Catalog generated beside it.
///
/// Two things are being checked at once and they fail differently:
///
/// - **the catalog is the right catalog.** `ios/Resources/Localizable.xcstrings`
///   is generated from `app/public/i18n-strings.js`, so if somebody edits the
///   copy and does not regenerate, the 1,728 `translations` cases go red with
///   the old string beside the new one. That is the whole reason the catalog is
///   generated rather than transcribed.
/// - **the runtime is the right runtime.** The fallback chains, the
///   country-variant rule, the placeholder fill and the glosses are ported code
///   and are checked against what the JavaScript answers today.
///
/// Every comparison is by UTF-16 code unit rather than `==`. That is not
/// ceremony: Swift's `String` is equal under canonical equivalence, so a port
/// that normalised its answers — or one that stored a decomposed spelling of a
/// name — would pass `==` while returning different bytes than the web app, and
/// this copy is CJK with full-width punctuation throughout.
struct LocalizationParityTests {

    // MARK: - Fixture shape

    struct Fixture: Decodable {
        struct CatalogInfo: Decodable {
            let path: String
            let sourceLanguage: String
            let version: String
            let languages: [String]
            let keyCount: Int
            let localizationCount: Int
            let zhHansCount: Int
        }
        /// A `t()` answer. `value` is `null` exactly when the JavaScript
        /// returned something that is not a string — see `jsType`.
        struct Case: Decodable {
            let key: String
            let lang: String
            let jsType: String
            let value: String?
        }
        /// Whether the JavaScript left a placeholder standing. Only the fact is
        /// recorded — the text a native function stringifies to is
        /// engine-specific and would make the fixture depend on the Node build.
        struct PrototypeParamCase: Decodable {
            let template: String
            let leftStanding: Bool
        }
        struct PrototypeCase: Decodable {
            let key: String
            let lang: String
            let jsType: String
            let value: String?
            /// The exception class `t(key, params)` throws, or `nil`.
            let throwsWithParams: String?
        }
        struct FillCase: Decodable {
            let key: String
            let lang: String
            let params: [String: ParamValue]?
            let value: String
        }
        struct CountryCase: Decodable {
            let input: String?
            let accepted: Bool
            let statMetro: String
        }
        struct VariantCase: Decodable {
            let key: String
            let country: String
            let variantExists: Bool
            let value: String
        }
        struct TCCase: Decodable {
            let key: String
            let country: String
            let lang: String
            let jsType: String
            let value: String?
        }
        struct LanguageCase: Decodable {
            let input: String?
            let active: String
        }
        struct PrefsCase: Decodable {
            let lang: String
            let prefs: Prefs
        }
        struct PlaceNameCase: Decodable {
            let table: String
            let lang: String
            let prefs: Prefs?
            let jp: String?
            let code: String?
            let readings: [ReadingPart]
            let readingsList: [String]
            let nameReadings: String
            let stationName: String
            let placeName: String
        }
        struct GlossCase: Decodable {
            let jp: String
            let lang: String
            let prefs: Prefs?
            let readings: [ReadingPart]
            let placeName: String
            let trainName: String
        }
        struct Synthetic: Decodable {
            let catalog: Localization.Catalog
            let cases: [Case]
            let filled: [FillCase]
            let variants: [TCCase]
        }
        struct Prefs: Decodable, Equatable {
            let kana: Bool
            let romaji: Bool
            let zh: Bool
        }
        struct ReadingPart: Decodable, Equatable {
            let type: String
            let text: String
        }

        let catalog: CatalogInfo
        let cases: [Case]
        let unknown: [Case]
        let prototypeKeys: [PrototypeCase]
        let prototypeParams: [PrototypeParamCase]
        let fill: [FillCase]
        let countries: [CountryCase]
        let variantKeys: [VariantCase]
        let tc: [TCCase]
        let languages: [LanguageCase]
        let readingDefaults: [PrefsCase]
        let placeNames: [PlaceNameCase]
        let glosses: [GlossCase]
        let synthetic: Synthetic
    }

    /// A `fill` parameter, tagged in the fixture so the JavaScript value can be
    /// rebuilt exactly — in particular so that a number stays a number and goes
    /// through `JSNumber.string` rather than Swift's own printing.
    struct ParamValue: Decodable {
        let type: String
        let string: String?
        let number: Double?
        let bool: Bool?

        var param: Localization.Param {
            switch type {
            case "string": return .string(string ?? "")
            case "number": return .number(number ?? .nan)
            case "bool": return .bool(bool ?? false)
            default: return .null
            }
        }
    }

    // MARK: - Loading

    static func fixture() throws -> Fixture {
        try PortFixtures.decode(Fixture.self, "i18n.json")
    }

    /// The generated String Catalog, read as the JSON it is.
    ///
    /// Deliberately not through `Bundle`: `RailCore` has no bundle, and the
    /// lookup rules being tested are the web app's rather than Foundation's.
    static func catalog() throws -> Localization.Catalog {
        let url = try PortFixtures.repositoryRoot()
            .appending(path: "ios/Resources/Localizable.xcstrings")
        guard FileManager.default.fileExists(atPath: url.path) else {
            Issue.record(
                """
                ios/Resources/Localizable.xcstrings is missing. Generate it with:
                  cd app && node scripts/build/build-port-fixtures.mjs
                """
            )
            throw CocoaError(.fileNoSuchFile)
        }
        return try Localization.Catalog(contentsOf: url)
    }

    static func language(_ raw: String) throws -> Localization.Language {
        try #require(Localization.Language(rawValue: raw), "unknown language \(raw)")
    }

    // MARK: - The catalog itself

    @Test("the String Catalog carries every key in every language")
    func catalogShape() throws {
        let fixture = try Self.fixture()
        let catalog = try Self.catalog()

        #expect(catalog.sourceLanguage == fixture.catalog.sourceLanguage)
        #expect(catalog.version == fixture.catalog.version)
        #expect(catalog.strings.count == fixture.catalog.keyCount)

        let localizations = catalog.strings.values.reduce(0) {
            $0 + ($1.localizations?.count ?? 0)
        }
        #expect(localizations == fixture.catalog.localizationCount)

        // Every entry has a zh-Hans. That is not a nicety: the Simplified
        // Chinese UI is generated rather than translated, so it is materialised
        // at build time, and the port's zh-Hans rule is a plain lookup with no
        // fallback of its own. If an entry ever lacked one the port would
        // silently answer with the key where the web app answers with converted
        // copy.
        let withHans = catalog.strings.values.filter {
            $0.localizations?["zh-Hans"] != nil
        }
        #expect(withHans.count == fixture.catalog.zhHansCount)
        #expect(withHans.count == catalog.strings.count)
    }

    /// Every catalog key is ASCII, which is what makes a Swift `Dictionary`
    /// safe to look them up in.
    ///
    /// `Dictionary<String, _>` compares keys under canonical equivalence while
    /// JavaScript compares UTF-16 code units, so in general a Swift table can
    /// find an entry the JavaScript would miss. It cannot here, because no
    /// non-ASCII string is canonically equal to an ASCII one — but that is a
    /// property of the data, so it is asserted rather than assumed.
    @Test("every key is ASCII, so canonical equivalence cannot widen a lookup")
    func keysAreASCII() throws {
        let catalog = try Self.catalog()
        for key in catalog.strings.keys {
            let isASCII = key.unicodeScalars.allSatisfy { $0.isASCII }
            #expect(
                isASCII,
                """
                \(key) is not ASCII — the Dictionary lookup in Localization.rawString \
                can now match where the JavaScript's own lookup does not
                """)
        }
    }

    // MARK: - t()

    @Test("every key in every language reads exactly as the JavaScript reads it")
    func translations() throws {
        let fixture = try Self.fixture()
        var localization = Localization(catalog: try Self.catalog())
        #expect(fixture.cases.count == fixture.catalog.keyCount * 4)

        for item in fixture.cases {
            localization.setLanguage(item.lang)
            #expect(localization.language.rawValue == item.lang)
            let expected = try #require(item.value)
            let actual = localization.t(item.key)
            #expect(
                Self.identical(actual, expected),
                "t(\(item.key)) in \(item.lang): \(Self.show(actual)) != \(Self.show(expected))"
            )
        }
    }

    @Test("a key the catalog does not carry comes back as the key")
    func unknownKeys() throws {
        let fixture = try Self.fixture()
        var localization = Localization(catalog: try Self.catalog())
        for item in fixture.unknown {
            localization.setLanguage(item.lang)
            let expected = try #require(item.value)
            #expect(Self.identical(localization.t(item.key), expected), "t(\(item.key))")
        }
    }

    /// The one place this port deliberately answers differently, recorded so
    /// that the difference is a decision rather than a surprise.
    ///
    /// `STRINGS` and `JA_STRINGS` are JavaScript object literals, so
    /// `STRINGS["toString"]` finds `Object.prototype`'s method and the
    /// `if (entry)` guard passes. Three of the four languages then read
    /// `entry.zh` / `entry.en` off that function, find nothing, and fall back to
    /// the key — which is what this port answers. The Japanese branch reads
    /// `JA_STRINGS[key]` first and `??` accepts a function, so `t("toString")`
    /// returns `Object.prototype.toString` **itself**, and `t("toString",
    /// params)` throws `TypeError: str.replace is not a function`.
    ///
    /// No `String` reproduces that, and a Swift `Dictionary` has no prototype
    /// chain to reproduce it with. It is also unreachable: every key in the app
    /// comes from a literal or a `data-i18n` attribute, and none of them is a
    /// property of `Object.prototype`.
    @Test("prototype keys agree in three languages, and are documented in the fourth")
    func prototypeKeys() throws {
        let fixture = try Self.fixture()
        var localization = Localization(catalog: try Self.catalog())
        var divergences = 0
        for item in fixture.prototypeKeys {
            localization.setLanguage(item.lang)
            let actual = localization.t(item.key)
            if item.jsType == "string" {
                let expected = try #require(item.value)
                #expect(Self.identical(actual, expected), "t(\(item.key)) in \(item.lang)")
                #expect(item.throwsWithParams == nil)
            } else {
                // The port answers with the key; the JavaScript answers with an
                // object off the prototype chain and throws if asked to fill it.
                #expect(item.lang == "ja", "the leak is Japanese-only")
                #expect(item.throwsWithParams == "TypeError")
                #expect(Self.identical(actual, item.key))
                divergences += 1
            }
        }
        #expect(divergences == 6, "one per Object.prototype name, Japanese only")
    }

    // MARK: - fill()

    /// The same prototype leak, reached through a PARAMETER name instead of a
    /// key — recorded for the same reason, and closed the same way.
    ///
    /// `params[k]` is a JavaScript object lookup too, so `{toString}` finds
    /// `Object.prototype.toString`, which is neither `undefined` nor `null`, so
    /// `fill` substitutes `String(fn)` — a native function's source text — into
    /// the copy. A Swift `[String: Param]` has no prototype chain and leaves the
    /// placeholder standing.
    ///
    /// Unreachable in the app: none of the 30 placeholder names used across all
    /// three catalogs is a property of `Object.prototype`, which is asserted
    /// here rather than assumed, because that is the property that keeps this
    /// harmless.
    @Test("a placeholder named after a prototype property leaks in JavaScript only")
    func prototypeParams() throws {
        let fixture = try Self.fixture()
        var localization = Localization(catalog: try Self.catalog())
        localization.setLanguage("zh-Hant")
        for item in fixture.prototypeParams {
            #expect(!item.leftStanding, "the JavaScript substitutes here")
            #expect(
                Self.identical(localization.t(item.template, [:]), item.template),
                "\(item.template) is left standing by the port")
        }

        // No catalog string can reach it: every placeholder name in the shipped
        // copy, in all four languages, is an ordinary identifier.
        let catalog = try Self.catalog()
        let prototypeNames: Set<String> = [
            "toString", "constructor", "__proto__", "valueOf", "hasOwnProperty",
            "propertyIsEnumerable", "toLocaleString", "isPrototypeOf",
        ]
        for entry in catalog.strings.values {
            for localized in entry.localizations?.values ?? [:].values {
                for name in Self.placeholderNames(localized.stringUnit.value) {
                    #expect(
                        !prototypeNames.contains(name),
                        "a catalog string uses {\(name)}, which reaches Object.prototype")
                }
            }
        }
    }

    /// The `\{(\w+)\}` names in a string, found the way `fill` finds them.
    static func placeholderNames(_ template: String) -> [String] {
        let scalars = Array(template.unicodeScalars)
        var names: [String] = []
        var index = 0
        while index < scalars.count {
            guard scalars[index] == "{" else {
                index += 1
                continue
            }
            var end = index + 1
            while end < scalars.count,
                CharacterSet.alphanumerics.contains(scalars[end]) || scalars[end] == "_",
                scalars[end].isASCII
            {
                end += 1
            }
            if end > index + 1, end < scalars.count, scalars[end] == "}" {
                names.append(String(String.UnicodeScalarView(scalars[(index + 1)..<end])))
                index = end + 1
            } else {
                index += 1
            }
        }
        return names
    }

    @Test("placeholders fill the way a function replacement fills them")
    func placeholders() throws {
        let fixture = try Self.fixture()
        var localization = Localization(catalog: try Self.catalog())
        for item in fixture.fill {
            localization.setLanguage(item.lang)
            let params = item.params?.mapValues(\.param)
            let actual = localization.t(item.key, params)
            #expect(
                Self.identical(actual, item.value),
                "t(\(item.key), \(String(describing: item.params))) in \(item.lang): \(Self.show(actual)) != \(Self.show(item.value))"
            )
        }
    }

    // MARK: - Country

    @Test("setCountry accepts five countries and silently answers jp for the rest")
    func countryWhitelist() throws {
        let fixture = try Self.fixture()
        var localization = Localization(catalog: try Self.catalog())
        localization.setLanguage("en")
        for item in fixture.countries {
            localization.setCountry(item.input)
            #expect(
                (localization.country == item.input) == item.accepted,
                "setCountry(\(String(describing: item.input)))")
            if !item.accepted { #expect(localization.country == "jp") }
            #expect(
                Self.identical(localization.tc("stat.metro"), item.statMetro),
                "stat.metro under \(String(describing: item.input))")
        }
    }

    @Test("the country-variant rule resolves every key under every country")
    func countryVariants() throws {
        let fixture = try Self.fixture()
        let catalog = try Self.catalog()
        var localization = Localization(catalog: catalog)
        localization.setLanguage("zh-Hant")
        #expect(fixture.variantKeys.count == fixture.catalog.keyCount * 6)

        var fellBack = 0
        for item in fixture.variantKeys {
            localization.setCountry(item.country)
            // The resolved key, checked against catalog membership rather than
            // against a second copy of the rule.
            let variant = item.key + "." + item.country
            #expect(catalog.contains(variant) == item.variantExists, "\(variant)")
            let resolved = localization.countryVariantKey(item.key)
            let shouldResolve = item.country != "jp" && item.variantExists
            #expect(
                Self.identical(resolved, shouldResolve ? variant : item.key),
                "countryVariantKey(\(item.key)) under \(item.country)")
            #expect(
                Self.identical(localization.tc(item.key), item.value),
                "tc(\(item.key)) under \(item.country)")
        }

        // Japan short-circuits before the suffix is built, so country.jp — a
        // key that exists — is unreachable through tc("country"), while every
        // other country finds its own label. Counted rather than asserted by
        // eye, because it is the shape of the rule that matters.
        localization.setCountry("jp")
        #expect(Self.identical(localization.tc("country"), "country"))
        #expect(catalog.contains("country.jp"))
        localization.setCountry("tw")
        #expect(!Self.identical(localization.tc("country"), "country"))
        _ = fellBack
    }

    @Test("tc reads the same in all four languages under all six countries")
    func countryVariantValues() throws {
        let fixture = try Self.fixture()
        var localization = Localization(catalog: try Self.catalog())
        for item in fixture.tc {
            localization.setLanguage(item.lang)
            localization.setCountry(item.country)
            let expected = try #require(item.value)
            #expect(
                Self.identical(localization.tc(item.key), expected),
                "tc(\(item.key)) under \(item.country) in \(item.lang)")
        }
    }

    /// The gaps the fallback covers, named so a reader knows they are gaps.
    ///
    /// Korea declared none of the header strings, so the Korean dataset is
    /// titled in Japanese. That is what the JavaScript does today and therefore
    /// what the port does; it is listed here because "the fallback works" and
    /// "the copy is missing" look identical from inside the test.
    @Test("the countries with no variant fall back to the Japanese copy")
    func documentedVariantGaps() throws {
        let catalog = try Self.catalog()
        var localization = Localization(catalog: catalog)
        localization.setLanguage("en")
        for key in ["app.title", "app.hint", "ph.trainType", "info.packageBody"] {
            #expect(!catalog.contains(key + ".kr"), "\(key).kr")
            localization.setCountry("kr")
            localization.setLanguage("en")
            let korean = localization.t(key)
            localization.setCountry("jp")
            #expect(
                Self.identical(korean, localization.t(key)),
                "\(key) under Korea is the Japanese copy")
        }
    }

    // MARK: - Language switching

    @Test("setLang migrates zh, rejects everything else, and never guesses")
    func languageSwitching() throws {
        let fixture = try Self.fixture()
        var localization = Localization(catalog: try Self.catalog())
        for item in fixture.languages {
            // The JavaScript leaves the language ALONE when the value is
            // unsupported, so each case starts from a known one.
            localization.setLanguage("en")
            localization.setLanguage(item.input)
            #expect(
                localization.language.rawValue == item.active,
                "setLang(\(String(describing: item.input)))")
        }
    }

    // MARK: - Readings and proper names

    @Test("the reading toggles default from the UI language")
    func readingDefaults() throws {
        let fixture = try Self.fixture()
        for item in fixture.readingDefaults {
            let prefs = Localization.localeDefaultReadingPrefs(item.lang)
            #expect(prefs.kana == item.prefs.kana, "\(item.lang)")
            #expect(prefs.romaji == item.prefs.romaji, "\(item.lang)")
            #expect(prefs.zh == item.prefs.zh, "\(item.lang)")
        }
    }

    /// The readings plumbing, over the synthetic tables the fixture installs.
    ///
    /// The readings DATA belongs to the stations port. What is checked here is
    /// what `i18n.js` wraps around it: the country whitelist that decides
    /// whether a table localises names or annotates them, the byCode-then-byName
    /// lookup order, the `normalizeStationName` re-keying, and the empty-string
    /// fallbacks.
    @Test("place names read as the JavaScript reads them, table by table")
    func placeNames() throws {
        let fixture = try Self.fixture()
        var localization = Localization(catalog: try Self.catalog())
        var installed = ""
        for item in fixture.placeNames {
            if item.table != installed {
                installed = item.table
                localization.setStationReadings(Self.readings(named: item.table))
            }
            localization.setLanguage(item.lang)
            localization.setNameReadings(
                item.prefs.map {
                    Localization.ReadingPrefs(kana: $0.kana, romaji: $0.romaji, zh: $0.zh)
                })

            let typed = localization.nameReadingsTyped(item.jp, code: item.code)
            let label = "\(item.table)/\(item.lang)/\(item.jp ?? "nil")/\(item.code ?? "nil")"
            #expect(typed.count == item.readings.count, "readings count at \(label)")
            for (actual, expected) in zip(typed, item.readings) {
                #expect(actual.kind.rawValue == expected.type, "reading kind at \(label)")
                #expect(Self.identical(actual.text, expected.text), "reading text at \(label)")
            }
            let list = localization.nameReadingsList(item.jp, code: item.code)
            #expect(list.count == item.readingsList.count, "list at \(label)")
            for (actual, expected) in zip(list, item.readingsList) {
                #expect(Self.identical(actual, expected), "list entry at \(label)")
            }
            #expect(
                Self.identical(
                    localization.nameReadings(item.jp, code: item.code), item.nameReadings),
                "nameReadings at \(label)")
            #expect(
                Self.identical(
                    localization.stationName(item.jp, code: item.code), item.stationName),
                "stationName at \(label)")
            #expect(
                Self.identical(
                    localization.placeName(item.jp, code: item.code), item.placeName),
                "placeName at \(label)")
        }
    }

    /// The declared country, folded and whitelisted the way `setStationReadings`
    /// folds and whitelists it.
    ///
    /// This is the one rule in the port with no observable consequence of its
    /// own: `country` is only ever consulted through
    /// `localizedNameCountries.contains(_:)`, so storing `"ZZ"` and storing
    /// `"JP"` behave identically and no parity case can tell them apart. It is
    /// asserted anyway because the value is public API — the app shell reads it
    /// to decide whether to offer the reading toggles at all — and because a
    /// mutation that dropped the whitelist otherwise survives the whole suite.
    @Test("the readings table's country is upper-cased, then whitelisted")
    func readingCountryNormalisation() throws {
        let expected: [(String, String?, String)] = [
            ("lower case is folded up", "tw", "TW"),
            ("as is a mixed one", "Hk", "HK"),
            ("an already-upper code is kept", "KR", "KR"),
            ("Japan is not in the set, and is the default anyway", "jp", "JP"),
            ("nor is anything unknown", "zz", "JP"),
            ("an empty country is Japan", "", "JP"),
            ("so is a missing one", nil, "JP"),
            // uppercased() is not a width fold: ｔｗ becomes ＴＷ, which is not
            // "TW" by any comparison.
            ("full-width ｔｗ upper-cases to ＴＷ and misses", "ｔｗ", "JP"),
        ]
        for (note, declared, want) in expected {
            let readings = Localization.StationReadings(country: declared)
            #expect(Self.identical(readings.country, want), "\(note)")
        }
        #expect(Self.identical(Localization.StationReadings.empty.country, "JP"))
    }

    @Test("every gloss in both dictionaries, in every language")
    func glosses() throws {
        let fixture = try Self.fixture()
        var localization = Localization(catalog: try Self.catalog())
        localization.setStationReadings(Localization.StationReadings(country: "JP"))
        // 42 romaji entries and 14 kana ones, over four languages and two
        // preference sets. A transcription slip in either dictionary fails here
        // rather than silently dropping one service's romanisation.
        #expect(fixture.glosses.count == 42 * 4 * 2)
        for item in fixture.glosses {
            localization.setLanguage(item.lang)
            localization.setNameReadings(
                item.prefs.map {
                    Localization.ReadingPrefs(kana: $0.kana, romaji: $0.romaji, zh: $0.zh)
                })
            let typed = localization.nameReadingsTyped(item.jp)
            #expect(typed.count == item.readings.count, "\(item.jp) in \(item.lang)")
            for (actual, expected) in zip(typed, item.readings) {
                #expect(actual.kind.rawValue == expected.type, "\(item.jp) in \(item.lang)")
                #expect(Self.identical(actual.text, expected.text), "\(item.jp) in \(item.lang)")
            }
            #expect(
                Self.identical(localization.placeName(item.jp), item.placeName),
                "placeName(\(item.jp)) in \(item.lang)")
            #expect(
                Self.identical(localization.trainName(item.jp), item.trainName),
                "trainName(\(item.jp)) in \(item.lang)")
        }
    }

    /// A decomposed reading against a composed name.
    ///
    /// `nameReadingsTyped` drops a reading that equals the name. JavaScript's
    /// `!==` compares UTF-16 code units, so カ + U+3099 does NOT equal ガ and the
    /// reading is KEPT — the web app prints ガ（ガ）. Swift's `==` holds under
    /// canonical equivalence and would drop it, which is why `Localization`
    /// compares through `utf16Equal`. The fixture carries the case; this asserts
    /// what it is defending, so that deleting the guard fails with a reason.
    @Test("a canonically equal reading is still a different string")
    func decomposedReadingSurvives() throws {
        var localization = Localization(
            catalog: try Self.catalog(),
            language: .zhHant,
            stationReadings: Localization.StationReadings(
                country: "JP",
                byCode: ["NFD": .init(kana: "\u{30AB}\u{3099}")]))
        localization.setNameReadings(
            Localization.ReadingPrefs(kana: true, romaji: false, zh: false))
        let composed = "\u{30AC}"
        #expect(composed == "\u{30AB}\u{3099}", "Swift calls these equal")
        #expect(!Self.identical(composed, "\u{30AB}\u{3099}"), "JavaScript does not")
        #expect(
            Self.identical(
                localization.placeName(composed, code: "NFD"),
                composed + "（\u{30AB}\u{3099}）"))
    }

    // MARK: - The fallback chains

    /// The four per-language fallback chains, over a catalog with holes.
    ///
    /// All 432 shipped keys carry Traditional Chinese, English and Japanese, so
    /// none of these chains is reachable from the shipped catalog — which is
    /// precisely why they need a fixture of their own rather than being assumed
    /// correct. The catalog here is generated by the same emitter from a
    /// doctored copy of the dictionaries, so the holes are real holes in a real
    /// resource.
    @Test("a key present in one language and missing in another falls back")
    func fallbackChains() throws {
        let fixture = try Self.fixture()
        var localization = Localization(catalog: fixture.synthetic.catalog)
        for item in fixture.synthetic.cases {
            localization.setLanguage(item.lang)
            let expected = try #require(item.value)
            #expect(
                Self.identical(localization.t(item.key), expected),
                "t(\(item.key)) in \(item.lang): \(Self.show(localization.t(item.key))) != \(Self.show(expected))"
            )
        }
        for item in fixture.synthetic.filled {
            localization.setLanguage(item.lang)
            #expect(
                Self.identical(
                    localization.t(item.key, item.params?.mapValues(\.param)), item.value),
                "t(\(item.key), …) in \(item.lang)")
        }
        for item in fixture.synthetic.variants {
            localization.setLanguage(item.lang)
            localization.setCountry(item.country)
            let expected = try #require(item.value)
            #expect(
                Self.identical(localization.tc(item.key), expected),
                "tc(\(item.key)) under \(item.country) in \(item.lang)")
        }
    }

    /// Traditional Chinese never falls back to Japanese, and Japanese falls back
    /// through English before Traditional Chinese.
    ///
    /// The four chains are asymmetric, and an asymmetry is exactly the kind of
    /// thing a port tidies up by accident. `syn.jaOnly` and `syn.zhEn` are the
    /// two keys that tell them apart, so they are named here rather than left to
    /// be one row of the loop above.
    @Test("the chains are asymmetric, and the asymmetry is the JavaScript's")
    func chainOrder() throws {
        let fixture = try Self.fixture()
        var localization = Localization(catalog: fixture.synthetic.catalog)

        // A key with only a Japanese copy is invisible to the other three.
        for language in ["zh-Hant", "en"] {
            localization.setLanguage(language)
            #expect(Self.identical(localization.t("syn.jaOnly"), "syn.jaOnly"))
        }
        localization.setLanguage("ja")
        #expect(Self.identical(localization.t("syn.jaOnly"), "日本語のみ"))

        // A key with no Japanese copy reaches Japanese through ENGLISH, not
        // through Traditional Chinese.
        localization.setLanguage("ja")
        #expect(Self.identical(localization.t("syn.zhEn"), "Traditional and English"))
        #expect(Self.identical(localization.t("syn.zhOnly"), "只有繁體"))

        // …and English reaches Traditional Chinese when it has nothing.
        localization.setLanguage("en")
        #expect(Self.identical(localization.t("syn.zhOnly"), "只有繁體"))
    }

    // MARK: - Helpers

    /// The synthetic readings tables the fixture's `placeNames` cases install,
    /// in the order it installs them. The rows are inputs, not data owned by
    /// this port — the shipped readings table belongs to the stations port.
    static func readings(named table: String) -> Localization.StationReadings? {
        switch table {
        case "none":
            return nil
        case "jp-readings":
            return Localization.StationReadings(
                country: "JP",
                byCode: [
                    "1101": .init(
                        kana: "さっぽろ", romaji: "Sapporo", zhHant: "札幌", zhHans: "札幌"),
                    "DUP": .init(kana: "剣山", romaji: "剣山", zhHant: "剣山", zhHans: "剣山"),
                    "EMPTY": .init(kana: "", romaji: "", zhHant: "", zhHans: ""),
                    "NFD": .init(kana: "\u{30AB}\u{3099}", romaji: "Ga", zhHant: "", zhHans: ""),
                    "HANT": .init(kana: "", romaji: "", zhHant: "繁體", zhHans: ""),
                    "HANS": .init(kana: "", romaji: "", zhHant: "", zhHans: "简体"),
                ],
                byName: [
                    "柳ヶ浦": .init(
                        kana: "やなぎがうら", romaji: "Yanagigaura", zhHant: "柳浦", zhHans: "柳浦"),
                    "東　京": .init(kana: "とうきょう", romaji: "Tōkyō", zhHant: "东京", zhHans: "东京"),
                    "剣山": .init(kana: "けんざん", romaji: "Kenzan", zhHant: "剑山", zhHans: "剑山"),
                    // NFKC folds half-width katakana up before anything else.
                    "ﾃｽﾄ": .init(kana: "てすと", romaji: "Tesuto"),
                    // The three small-kana folds the ヶ→ケ case never reaches.
                    "ヵ試ゖゕ": .init(kana: "かこけか", romaji: "Kakokeka"),
                    // U+FEFF is ECMAScript whitespace and is stripped;
                    // CharacterSet.whitespacesAndNewlines does not contain it,
                    // and does contain the U+0085 that the probe below carries.
                    "空\u{FEFF}白": .init(kana: "くうはく", romaji: "Kūhaku"),
                ])
        case "tw-localized":
            return Localization.StationReadings(
                country: "tw",
                byCode: [
                    "TW-1": .init(zhHant: "臺北", zhHans: "台北", ja: "台北", en: "Taipei"),
                    "TW-2": .init(zhHant: "高雄", zhHans: "", ja: "", en: ""),
                ],
                byName: [
                    "臺　中": .init(zhHant: "臺中", zhHans: "台中", ja: "台中", en: "Taichung"),
                    // Official Traditional name ≠ the name the caller passes,
                    // which is what makes "fall back to zhHant" and "give up
                    // and return the caller's name" two different answers.
                    "台南": .init(zhHant: "臺南", zhHans: "", ja: "", en: ""),
                ])
        case "unknown-country":
            return Localization.StationReadings(
                country: "zz",
                byCode: ["TW-1": .init(zhHant: "臺北", zhHans: "台北", ja: "台北", en: "Taipei")])
        case "missing-country":
            return Localization.StationReadings()
        case "fullwidth-country":
            return Localization.StationReadings(country: "ｔｗ")
        case "lowercase-country":
            return Localization.StationReadings(
                country: "hk",
                byCode: [
                    "HK-1": .init(zhHant: "中環", zhHans: "中环", ja: "セントラル", en: "Central")
                ])
        case "not-an-object":
            // setStationReadings ignores anything that is not an object, so the
            // table installed before this one is still installed.
            return nil
        default:
            Issue.record("unknown readings table \(table)")
            return nil
        }
    }

    /// JavaScript `===` for two strings.
    ///
    /// Swift's `==` holds under canonical equivalence, so it would let a port
    /// that normalised its answers pass while returning different bytes than the
    /// web app. Every string comparison in this file goes through here.
    static func identical(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf16.count == rhs.utf16.count && lhs.utf16.elementsEqual(rhs.utf16)
    }

    /// A failure message that shows the code units, because two strings that
    /// differ only by normalisation print identically.
    static func show(_ value: String) -> String {
        let units = value.utf16.map { String(format: "%04X", $0) }.joined(separator: " ")
        return "\"\(value)\" [\(units)]"
    }
}
