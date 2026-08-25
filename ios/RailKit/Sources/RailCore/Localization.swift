import Foundation

/// The web app's interface language layer: `i18n.js` over the `i18n-strings.js`
/// catalogs.
///
/// The two halves of that pair are ported differently, on purpose.
///
/// **The catalogs are data.** 432 keys × Traditional Chinese and English, plus
/// a complete Japanese overlay, now live in `ios/RailMap/Localizable.xcstrings`
/// — generated from the real JavaScript by
/// `app/scripts/build/port-fixtures/i18n.mjs` on every fixture run. Nothing in
/// this file transcribes a translation, because a hand-copied translation table
/// is a table that goes stale silently and no test can tell.
///
/// **The runtime is logic**, and it is here: the four per-language fallback
/// chains, the country-variant key rule, the `{placeholder}` fill, and the
/// proper-noun glosses.
///
/// ## The fourth language is generated, and it is generated at build time
///
/// The app offers four UI languages but maintains three. Simplified Chinese is
/// derived at runtime by `toSimplifiedChinese()`, a 236-entry character and
/// phrase map that lives in `i18n.js` and is reachable from nowhere but `t()`
/// — it only ever converts a catalog value, or the key when the catalog has
/// nothing. So the generator materialises `zh-Hans` into the String Catalog by
/// calling the real `t()`, and this port carries no converter at all.
///
/// That is why the `zh-Hans` case below is a plain lookup while the other three
/// keep their fallback chains: pre-folding a *derivation* is not the same as
/// pre-folding a *translation*, and it removes the whole class of bug where one
/// row of a 236-entry table is mistyped in Swift and one screen quietly reads
/// wrong. Every entry carries a `zh-Hans`, including entries that would fall
/// back, which is what leaves that lookup with no residue.
///
/// ## Strings are compared the way JavaScript compares them
///
/// Every lookup here is exact-match, and JavaScript's notion of "exact" is
/// UTF-16 code units. Swift's `String` compares under canonical equivalence
/// instead, so a decomposed name matches a composed key in Swift and misses in
/// JavaScript. Where that difference is reachable — the gloss dictionaries,
/// keyed on Japanese proper nouns, and the reading-versus-name test — this file
/// uses `JSStringKey` and `utf16Equal` rather than `==`.
///
/// It is *not* reachable for catalog keys: every one of the 432 is ASCII, and
/// no non-ASCII string is canonically equal to an ASCII one, so a Swift
/// `Dictionary` cannot match where the JavaScript would not. `LocalizationParityTests`
/// asserts that property rather than assuming it.
public struct Localization: Sendable {

    // MARK: - Types

    /// The four UI languages, spelled as `i18n.js` spells them in `SUPPORTED`.
    public enum Language: String, CaseIterable, Sendable, Hashable {
        case zhHant = "zh-Hant"
        case zhHans = "zh-Hans"
        case ja = "ja"
        case en = "en"
    }

    /// A `.xcstrings` String Catalog, decoded straight from its JSON.
    ///
    /// Xcode compiles this file into per-language `.strings` tables and reads
    /// them through `Bundle`/`NSLocalizedString`, but none of that is used
    /// here: the lookup rules below are the web app's, not Foundation's — a
    /// four-language fallback chain, a country-variant key rule and a
    /// `{name}` placeholder syntax that `String(format:)` does not speak. So
    /// the catalog is consumed as data, which also keeps `RailCore` free of
    /// any bundle or platform dependency. See the port report for what the app
    /// shell has to do to make the file reachable at runtime.
    public struct Catalog: Decodable, Sendable {

        public struct Entry: Decodable, Sendable {
            /// One language's copy for one key. Named `Localized` rather
            /// than `Localization` so it does not shadow the enclosing type.
            public struct Localized: Decodable, Sendable {
                public struct Unit: Decodable, Sendable {
                    public let state: String
                    public let value: String
                }
                public let stringUnit: Unit
            }
            public let extractionState: String?
            public let localizations: [String: Localized]?
        }

        public let sourceLanguage: String
        public let version: String
        public let strings: [String: Entry]

        public init(data: Data) throws {
            self = try JSONDecoder().decode(Catalog.self, from: data)
        }

        public init(contentsOf url: URL) throws {
            try self.init(data: Data(contentsOf: url))
        }

        /// The raw stored string for one key in one language, or `nil` when the
        /// catalog does not carry that language for that key. The fallback
        /// chains live in `t`, not here.
        public func value(_ key: String, _ language: String) -> String? {
            strings[key]?.localizations?[language]?.stringUnit.value
        }

        /// Whether the catalog has an entry for a key at all — the test
        /// `countryVariantKey` performs, where `i18n.js` writes
        /// `STRINGS[variant] ? variant : key`. Every entry in the catalogs is
        /// an object, so "truthy" and "present" are the same question.
        public func contains(_ key: String) -> Bool { strings[key] != nil }
    }

    /// A value substituted into a `{name}` placeholder.
    ///
    /// Typed rather than `Any` because the JavaScript writes
    /// `String(params[k])`, and `String` of a number is the one conversion this
    /// codebase has already been burned by: JavaScript prints an integral
    /// `Number` as `3`, Swift's `String(3.0)` is `"3.0"`.
    public enum Param: Sendable, Equatable {
        case string(String)
        case number(Double)
        case bool(Bool)
        /// JavaScript `null` **or** `undefined`. `fill` leaves the placeholder
        /// standing for both, and cannot tell them apart.
        case null

        /// `String(value)`, or `nil` where the JavaScript declines to substitute.
        var jsString: String? {
            switch self {
            case .string(let s): return s
            case .number(let d): return JSNumber.string(d)
            case .bool(let b): return b ? "true" : "false"
            case .null: return nil
            }
        }
    }

    /// The three independent reading toggles the 顯示 panel exposes.
    public struct ReadingPrefs: Sendable, Equatable {
        public var kana: Bool
        public var romaji: Bool
        public var zh: Bool
        public init(kana: Bool, romaji: Bool, zh: Bool) {
            self.kana = kana
            self.romaji = romaji
            self.zh = zh
        }
    }

    public enum ReadingKind: String, Sendable, Equatable {
        case kana, romaji, zh
    }

    /// One reading, typed. Station-name display sites stack the texts one per
    /// line under the name; the type is what lets a paired display (origin →
    /// destination) align the same kind of reading on the same line.
    public struct Reading: Sendable, Equatable {
        public let kind: ReadingKind
        public let text: String
        public init(kind: ReadingKind, text: String) {
            self.kind = kind
            self.text = text
        }
    }

    /// One row of the readings table. Every field is optional and an empty
    /// string is treated as absent, because the JavaScript tests them with `||`
    /// and the shipped table stores missing translations as `""`.
    public struct StationReadingRow: Sendable, Equatable {
        public var kana: String?
        public var romaji: String?
        public var zhHant: String?
        public var zhHans: String?
        public var ja: String?
        public var en: String?
        public init(
            kana: String? = nil, romaji: String? = nil,
            zhHant: String? = nil, zhHans: String? = nil,
            ja: String? = nil, en: String? = nil
        ) {
            self.kana = kana
            self.romaji = romaji
            self.zhHant = zhHant
            self.zhHans = zhHans
            self.ja = ja
            self.en = en
        }
    }

    /// The readings table, normalised the way `setStationReadings` normalises it.
    ///
    /// The table's CONTENT (`app/data/station-readings.json`) belongs to the
    /// stations port; what this type carries is the plumbing `i18n.js` wraps it
    /// in — the declared country, folded to upper case and then whitelisted,
    /// and `byName` re-keyed through the one station-name key rule so that a
    /// hit can never depend on how the external table spelled its keys.
    public struct StationReadings: Sendable {
        /// Upper-cased and whitelisted: anything outside
        /// `localizedNameCountries` becomes `"JP"`, which means the table is
        /// read as Japanese reading annotations rather than as localised names.
        public let country: String
        fileprivate let byCode: [JSStringKey: StationReadingRow]
        fileprivate let byName: [JSStringKey: StationReadingRow]

        /// - Note: `byName` is re-keyed on the way in. If two source keys
        ///   normalise to the same key the JavaScript keeps the last in
        ///   insertion order, while a Swift `Dictionary` argument has no order
        ///   at all — the shipped table has no such collision (the JavaScript
        ///   comment records that it was verified), but a future one would
        ///   resolve differently in the two apps.
        public init(
            country: String? = nil,
            byCode: [String: StationReadingRow] = [:],
            byName: [String: StationReadingRow] = [:]
        ) {
            // String(data.country || "JP").toUpperCase(): an empty or missing
            // country is Japan, and the whitelist is consulted AFTER the fold
            // but with no width normalisation — a full-width ｔｗ upper-cases
            // to ＴＷ and misses.
            let declared = (country?.isEmpty == false ? country! : "JP").uppercased()
            self.country =
                Localization.localizedNameCountries.contains(declared) ? declared : "JP"
            self.byCode = Dictionary(
                uniqueKeysWithValues: byCode.map { (JSStringKey($0.key), $0.value) })
            var names: [JSStringKey: StationReadingRow] = [:]
            for (key, row) in byName {
                names[JSStringKey(Localization.normalizedReadingKey(key))] = row
            }
            self.byName = names
        }

        /// The state before any table is injected: no rows, and Japan, so
        /// names are annotated rather than replaced.
        public static let empty = StationReadings()
    }

    // MARK: - State

    public let catalog: Catalog
    /// `zh-Hant` by default, matching `detectInitialLang` with nothing saved.
    public private(set) var language: Language
    /// One of `supportedCountries`. Never anything else — see `setCountry`.
    public private(set) var country: String
    /// `nil` until the 顯示 panel is touched, which is when the locale
    /// defaults stop applying.
    public private(set) var readingPrefs: ReadingPrefs?
    public private(set) var stationReadings: StationReadings

    public init(
        catalog: Catalog,
        language: Language = .zhHant,
        country: String = "jp",
        readingPrefs: ReadingPrefs? = nil,
        stationReadings: StationReadings = .empty
    ) {
        self.catalog = catalog
        self.language = language
        self.country = Self.supportedCountries.contains(country) ? country : "jp"
        self.readingPrefs = readingPrefs
        self.stationReadings = stationReadings
    }

    // MARK: - Language and country

    /// `SUPPORTED` in `i18n.js`.
    public static let supportedLanguages = ["zh-Hant", "zh-Hans", "ja", "en"]

    /// The whitelist `setCountry` enforces, and `SUPPORTED_COUNTRIES` in
    /// `app-config.js`. It is the same list in both files and they are not
    /// wired together.
    public static let supportedCountries = ["jp", "tw", "hk", "mo", "kr"]

    /// Countries whose readings table localises the base station NAME rather
    /// than annotating a Japanese name with a kana/romaji subline.
    public static let localizedNameCountries: Set<String> = ["TW", "HK", "MO", "KR"]

    /// `I18N.setLang`. An unsupported value is IGNORED — the language does not
    /// change and nothing reports the miss — and the comparison is exact, so
    /// `"JA"` and `"zh-hant"` are both rejected.
    ///
    /// `"zh"` is migrated to `"zh-Hant"`: it is what the former two-language
    /// API stored, and a returning user's saved preference still spells it that
    /// way.
    public mutating func setLanguage(_ language: String?) {
        var requested = language
        if requested == "zh" { requested = "zh-Hant" }
        guard let requested, let next = Language(rawValue: requested) else { return }
        self.language = next
    }

    /// `I18N.setCountry`. Anything off the whitelist becomes `"jp"` rather than
    /// failing, so a mistyped or unsupported country does not break the UI — it
    /// silently serves the Japanese copy of every country-variant string.
    public mutating func setCountry(_ country: String?) {
        if let country, Self.supportedCountries.contains(country) {
            self.country = country
        } else {
            self.country = "jp"
        }
    }

    // MARK: - Lookup

    /// `I18N.t` — the translated string for a key, with `{name}` placeholders
    /// filled.
    ///
    /// A key the catalog does not carry returns THE KEY ITSELF, filled the same
    /// way. That is not an error path anybody notices: a typo'd `data-i18n`
    /// attribute renders as `nav.trainz` on screen and reads as a design.
    public func t(_ key: String, _ params: [String: Param]? = nil) -> String {
        Self.fill(rawString(key), params)
    }

    /// The stored copy for a key before placeholders are filled, following the
    /// per-language fallback chain.
    ///
    /// The four chains are asymmetric and the asymmetry is the JavaScript's:
    /// Japanese falls back through English to Traditional Chinese, Traditional
    /// Chinese falls back to English but never to Japanese, English falls back
    /// to Traditional Chinese, and Simplified Chinese has no chain at all
    /// because it is materialised at build time (see the type comment).
    ///
    /// All 432 shipped keys carry all three maintained languages, so none of
    /// these chains is reachable from the shipped catalog. They are exercised
    /// against a deliberately holed catalog in the parity tests.
    public func rawString(_ key: String) -> String {
        guard let entry = catalog.strings[key] else { return key }
        let localizations = entry.localizations ?? [:]
        func value(_ language: Language) -> String? {
            localizations[language.rawValue]?.stringUnit.value
        }
        switch language {
        case .ja: return value(.ja) ?? value(.en) ?? value(.zhHant) ?? key
        case .zhHant: return value(.zhHant) ?? value(.en) ?? key
        case .zhHans: return value(.zhHans) ?? key
        case .en: return value(.en) ?? value(.zhHant) ?? key
        }
    }

    /// `I18N.tc` — the country-aware lookup every layer label and statistics
    /// category goes through.
    public func tc(_ key: String, _ params: [String: Param]? = nil) -> String {
        t(countryVariantKey(key), params)
    }

    /// The country-variant rule: while a non-Japanese dataset is active,
    /// `"app.title"` resolves to `"app.title.tw"` when that key exists, so one
    /// `data-i18n` attribute serves every country.
    ///
    /// It is a blind string suffix and it short-circuits for Japan, which has
    /// two consequences worth knowing before reading a surprising answer:
    ///
    /// - A country that never declared a variant falls back to the Japanese
    ///   copy rather than to anything neutral. Korea has no `app.title.kr`, so
    ///   the Korean dataset is titled "N02 特急列車管理".
    /// - Because `"jp"` returns before the suffix is built, `country.jp` —
    ///   which does exist — is unreachable through `tc("country")`, while
    ///   `tc("country")` under Taiwan finds `country.tw` and answers 台灣. The
    ///   `country.*` keys are region labels that merely look like variants.
    public func countryVariantKey(_ key: String) -> String {
        if country == "jp" { return key }
        let variant = key + "." + country
        return catalog.contains(variant) ? variant : key
    }

    // MARK: - Placeholders

    /// `fill` in `i18n.js`: `str.replace(/\{(\w+)\}/g, …)` with a FUNCTION
    /// replacement.
    ///
    /// Three details of that one line decide the output, and all three are
    /// silently lost by the obvious Swift spelling:
    ///
    /// - `\w` in a JavaScript regex without the `u` flag is ASCII
    ///   `[A-Za-z0-9_]`. `{語}` is not a placeholder.
    /// - `\w+` needs at least one character, so `{}` never matches, and the
    ///   scan resumes AFTER a match, so `{{count}}` fills the inner one and
    ///   keeps the outer braces.
    /// - the replacement is a function, so `$&` and `$1` in a parameter's value
    ///   are inserted literally. `NSRegularExpression`'s template syntax would
    ///   expand them, and a station name is user data.
    ///
    /// A parameter that is missing, `null` or `undefined` leaves the whole
    /// placeholder standing — the UI shows `全部列車（{count}）` rather than an
    /// empty pair of brackets, which is how these bugs get spotted.
    static func fill(_ template: String, _ params: [String: Param]?) -> String {
        guard let params else { return template }
        let scalars = Array(template.unicodeScalars)
        var out = String.UnicodeScalarView()
        out.reserveCapacity(scalars.count)
        var index = 0
        while index < scalars.count {
            guard scalars[index] == "{" else {
                out.append(scalars[index])
                index += 1
                continue
            }
            var end = index + 1
            while end < scalars.count, isWordScalar(scalars[end]) { end += 1 }
            guard end > index + 1, end < scalars.count, scalars[end] == "}" else {
                out.append(scalars[index])
                index += 1
                continue
            }
            let name = String(String.UnicodeScalarView(scalars[(index + 1)..<end]))
            if let replacement = params[name]?.jsString {
                out.append(contentsOf: replacement.unicodeScalars)
            } else {
                // The callback returned the match itself.
                out.append(contentsOf: scalars[index...end])
            }
            index = end + 1
        }
        return String(out)
    }

    private static func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x5F: return true
        default: return false
        }
    }

    // MARK: - Readings and proper names

    /// `I18N.setNameReadings`. `nil` restores the locale defaults.
    public mutating func setNameReadings(_ prefs: ReadingPrefs?) {
        readingPrefs = prefs
    }

    /// `I18N.setStationReadings`. A `nil` table is IGNORED — the JavaScript
    /// guards with `if (data && typeof data === "object")`, so handing it
    /// nonsense leaves whatever table was installed before still installed.
    public mutating func setStationReadings(_ readings: StationReadings?) {
        guard let readings else { return }
        stationReadings = readings
    }

    /// Until the reading toggles are customised they follow the UI language.
    /// This is the ONE spelling of that default; `app-display-settings.js`
    /// seeds its toggle state from it and `activeReadingPrefs` falls back to it
    /// for the pre-boot window.
    ///
    /// Takes a raw string because the JavaScript does, and answers all-false
    /// for anything it does not recognise rather than guarding.
    public static func localeDefaultReadingPrefs(_ language: String) -> ReadingPrefs {
        ReadingPrefs(
            kana: language == "zh-Hant" || language == "zh-Hans",
            romaji: language == "en",
            zh: false)
    }

    public static func localeDefaultReadingPrefs(_ language: Language) -> ReadingPrefs {
        localeDefaultReadingPrefs(language.rawValue)
    }

    public var activeReadingPrefs: ReadingPrefs {
        readingPrefs ?? Self.localeDefaultReadingPrefs(language)
    }

    /// The readings row for a station: the exact code first, then a tolerant
    /// name match. Code before name because the code is the official identity
    /// and two stations share a name often enough to matter.
    func stationReadingRow(code: String?, name: String?) -> StationReadingRow? {
        if let code, !code.isEmpty, let row = stationReadings.byCode[JSStringKey(code)] {
            return row
        }
        if let name, !name.isEmpty,
            let row = stationReadings.byName[JSStringKey(Self.normalizedReadingKey(name))]
        {
            return row
        }
        return nil
    }

    /// `I18N.stationName` — the localised base name, for the countries whose
    /// readings table carries names rather than pronunciations.
    ///
    /// A missing official English or Japanese name deliberately falls back to
    /// the official Traditional Chinese one; the table itself stores those as
    /// empty strings, which is why every test here is emptiness rather than
    /// presence.
    public func stationName(_ name: String?, code: String? = nil) -> String {
        guard let name, !name.isEmpty else { return "" }
        guard Self.localizedNameCountries.contains(stationReadings.country) else {
            return name
        }
        guard let row = stationReadingRow(code: code, name: name) else { return name }
        switch language {
        case .zhHans: return nonEmpty(row.zhHans) ?? nonEmpty(row.zhHant) ?? name
        case .zhHant: return nonEmpty(row.zhHant) ?? name
        case .ja: return nonEmpty(row.ja) ?? nonEmpty(row.zhHant) ?? name
        case .en: return nonEmpty(row.en) ?? nonEmpty(row.zhHant) ?? name
        }
    }

    /// `I18N.nameReadingsTyped` — the enabled readings for a name, in the fixed
    /// order kana, romaji, zh, minus any reading that equals the name.
    ///
    /// The equality test is by UTF-16 code unit, which is not pedantry here: a
    /// decomposed ガ (カ + U+3099) and a composed ガ are canonically equal, so
    /// Swift's `==` would suppress a reading the web app prints.
    public func nameReadingsTyped(_ name: String?, code: String? = nil) -> [Reading] {
        guard let name, !name.isEmpty else { return [] }
        // TW/HK/MO/KR localise the base name itself into the active language.
        // They have no Japanese-style reading subline at all.
        guard !Self.localizedNameCountries.contains(stationReadings.country) else {
            return []
        }
        let prefs = activeReadingPrefs
        let row = stationReadingRow(code: code, name: name)
        var parts: [Reading] = []
        if prefs.kana {
            // `(r && r.kana) || KANA[jp]`: an empty field in the table falls
            // through to the gloss dictionary rather than winning as a blank.
            if let kana = nonEmpty(row?.kana) ?? Self.kanaGlosses[JSStringKey(name)],
                !kana.isEmpty, !utf16Equal(kana, name)
            {
                parts.append(Reading(kind: .kana, text: kana))
            }
        }
        if prefs.romaji {
            if let romaji = nonEmpty(row?.romaji) ?? Self.romajiGlosses[JSStringKey(name)],
                !romaji.isEmpty, !utf16Equal(romaji, name)
            {
                parts.append(Reading(kind: .romaji, text: romaji))
            }
        }
        // The Chinese reading has no gloss dictionary behind it: it exists only
        // where the readings table supplies one.
        if prefs.zh, let row {
            let zh =
                language == .zhHans
                ? nonEmpty(row.zhHans) ?? nonEmpty(row.zhHant)
                : nonEmpty(row.zhHant) ?? nonEmpty(row.zhHans)
            if let zh, !zh.isEmpty, !utf16Equal(zh, name) {
                parts.append(Reading(kind: .zh, text: zh))
            }
        }
        return parts
    }

    public func nameReadingsList(_ name: String?, code: String? = nil) -> [String] {
        nameReadingsTyped(name, code: code).map(\.text)
    }

    /// Every name the readings table holds for a station, whatever the reader
    /// has the app set to.
    ///
    /// This is not a display function and has no JavaScript counterpart: the
    /// web app only ever needs the names for the ACTIVE language, and
    /// `nameReadingsTyped` answers that — filtered by the three reading
    /// toggles, and empty for the four countries whose table localises the name
    /// itself.
    ///
    /// What needs all of them is matching a station against a service that
    /// answers in its own language rather than the app's. Apple Maps returns
    /// 台北车站 to a Chinese device and Taibei Station to an English one, and
    /// the app's language setting is independent of the device's — so a reader
    /// with the app in Chinese on an English phone would otherwise be handed
    /// names none of their station's spellings could match. See
    /// `StationPlaceLink`.
    public func stationNameAliases(_ name: String?, code: String? = nil) -> [String] {
        guard let name, !name.isEmpty else { return [] }
        guard let row = stationReadingRow(code: code, name: name) else { return [] }
        return [row.zhHant, row.zhHans, row.ja, row.en, row.romaji, row.kana]
            .compactMap(nonEmpty)
    }

    public func nameReadings(_ name: String?, code: String? = nil) -> String {
        nameReadingsList(name, code: code).joined(separator: " / ")
    }

    /// `I18N.placeName` — a proper noun as the active language displays it.
    ///
    /// Half-width brackets in the Latin-script locales, full-width in Chinese.
    public func placeName(_ name: String?, code: String? = nil) -> String {
        guard let name, !name.isEmpty else { return "" }
        if Self.localizedNameCountries.contains(stationReadings.country) {
            return stationName(name, code: code)
        }
        let readings = nameReadings(name, code: code)
        if readings.isEmpty { return name }
        return language == .zhHant || language == .zhHans
            ? name + "（" + readings + "）"
            : name + " (" + readings + ")"
    }

    /// The same dictionary covers limited-express service names.
    public func trainName(_ name: String?, code: String? = nil) -> String {
        placeName(name, code: code)
    }

    /// `AppCore.normalizeStationName` — the one station-name key rule.
    ///
    /// - Important: this duplicates `app/shared/app-core.js`, which the
    ///   stations port also needs. Whichever lands second should delete one of
    ///   the two; they must not be allowed to drift, because a difference means
    ///   the readings table and the station index disagree about what a station
    ///   is called.
    ///
    /// NFKC folds the full/half-width spellings apart, then every whitespace
    /// character is removed and the small kana variants that N02, hand-written
    /// JSON and the readings table spell inconsistently (柳ヶ浦 vs 柳ケ浦) are
    /// unified.
    public static func normalizedReadingKey(_ value: String?) -> String {
        guard let value else { return "" }
        var result = value.precomposedStringWithCompatibilityMapping  // NFKC
        // The JavaScript trims and then strips every `\s`, which is the same
        // set twice over, so only the strip survives here. That set is
        // ECMAScript's, NOT `CharacterSet.whitespacesAndNewlines`: it contains
        // U+FEFF, which Foundation's does not, and it excludes U+0085, which
        // Foundation's does.
        result = String(
            String.UnicodeScalarView(result.unicodeScalars.filter { !isJSWhitespace($0) }))
        // `.literal` so these are code-unit substitutions, matching a
        // JavaScript regex replace rather than a canonical-equivalence search.
        for (from, to) in [("ヶ", "ケ"), ("ヵ", "カ"), ("ゖ", "け"), ("ゕ", "か")] {
            result = result.replacingOccurrences(of: from, with: to, options: .literal)
        }
        return result
    }

    /// ECMAScript's `\s`: WhiteSpace ∪ LineTerminator.
    private static func isJSWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D,  // tab, LF, VT, FF, CR
            0x20,  // space
            0x00A0,  // no-break space
            0x1680,  // ogham space mark
            0x2000...0x200A,  // en quad … hair space
            0x2028, 0x2029,  // line / paragraph separator
            0x202F, 0x205F, 0x3000,  // narrow nbsp, medium math, ideographic
            0xFEFF:  // zero width no-break space
            return true
        default:
            return false
        }
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    // MARK: - Proper-noun glosses

    // NAMES and KANA from `i18n.js`: the romanised and kana readings of
    // limited-express service names and a handful of line names. These are the
    // only readings that live in the i18n layer itself — station readings come
    // from `app/data/station-readings.json` at runtime, and this file never
    // sees that table's contents.
    //
    // Unlike the UI copy these ARE transcribed, because they are keyed on
    // Japanese proper nouns rather than on identifiers and do not belong in a
    // String Catalog. The fixture drives every entry of both dictionaries in
    // every language, so a mistyped one fails immediately rather than quietly
    // dropping a romanisation.
    //
    // Keyed by `JSStringKey` because the keys are CJK: a decomposed lookup
    // string is canonically equal to a composed key, so a plain
    // `[String: String]` would match where the JavaScript does not.

    fileprivate static let romajiGlosses: [JSStringKey: String] = jsKeyed([
        "あずさ": "Azusa",
        "あそぼーい！": "Aso Boy!",
        "いなほ": "Inaho",
        "うずしお": "Uzushio",
        "おおぞら": "Ōzora",
        "かもめ": "Kamome",
        "きりしま": "Kirishima",
        "こだま": "Kodama",
        "こまち": "Komachi",
        "こまち+はやぶさ": "Komachi + Hayabusa",
        "さくら": "Sakura",
        "しなの": "Shinano",
        "しらゆき": "Shirayuki",
        "つがる": "Tsugaru",
        "ときわ": "Tokiwa",
        "にちりん": "Nichirin",
        "はくたか": "Hakutaka",
        "はこだてライナー": "Hakodate Liner",
        "はやぶさ": "Hayabusa",
        "はやぶさ+こまち": "Hayabusa + Komachi",
        "ひかり": "Hikari",
        "ひたち": "Hitachi",
        "ふじかわ": "Fujikawa",
        "みどり": "Midori",
        "シーサイドライナー": "Seaside Liner",
        "ソニック": "Sonic",
        "マリンライナー": "Marine Liner",
        "リレーかもめ": "Relay Kamome",
        "京浜東北線": "Keihin-Tōhoku Line",
        "剣山": "Tsurugisan",
        "北斗": "Hokuto",
        "南風": "Nanpū",
        "奥羽線 普通": "Ōu Line (Local)",
        "宗谷": "Sōya",
        "快速ノサップ": "Rapid Nosappu",
        "指宿枕崎線 普通": "Ibusuki-Makurazaki Line (Local)",
        "東北線・京浜東北線": "Tōhoku Line · Keihin-Tōhoku Line",
        "東海道線 普通": "Tōkaidō Line (Local)",
        "松浦鉄道 西九州線": "Matsuura Railway Nishi-Kyūshū Line",
        "武蔵野線・東北線": "Musashino Line · Tōhoku Line",
        "花咲線 普通": "Hanasaki Line (Local)",
        "鹿児島本線 普通": "Kagoshima Main Line (Local)",
    ])

    // Only names containing kanji are listed. A name already written entirely
    // in kana (あずさ, ソニック) gets no parenthetical, so the display stays
    // clean — which is why this dictionary is smaller than the romaji one
    // rather than a mirror of it.
    fileprivate static let kanaGlosses: [JSStringKey: String] = jsKeyed([
        "剣山": "つるぎさん",
        "北斗": "ほくと",
        "南風": "なんぷう",
        "奥羽線 普通": "おううせん ふつう",
        "宗谷": "そうや",
        "快速ノサップ": "かいそくノサップ",
        "指宿枕崎線 普通": "いぶすきまくらざきせん ふつう",
        "東北線・京浜東北線": "とうほくせん・けいひんとうほくせん",
        "東海道線 普通": "とうかいどうせん ふつう",
        "松浦鉄道 西九州線": "まつうらてつどう にしきゅうしゅうせん",
        "武蔵野線・東北線": "むさしのせん・とうほくせん",
        "花咲線 普通": "はなさきせん ふつう",
        "鹿児島本線 普通": "かごしまほんせん ふつう",
        "京浜東北線": "けいひんとうほくせん",
    ])

    fileprivate static func jsKeyed(_ table: KeyValuePairs<String, String>)
        -> [JSStringKey: String]
    {
        var out: [JSStringKey: String] = [:]
        out.reserveCapacity(table.count)
        for (key, value) in table { out[JSStringKey(key)] = value }
        return out
    }
}

// MARK: - UTF-16 string identity

/// A dictionary key that compares the way JavaScript compares strings.
///
/// Swift's `String` is equal under canonical equivalence: a decomposed ガ
/// (カ + U+3099) equals a composed one, and `Dictionary` therefore finds a key
/// the JavaScript's own lookup would miss. JavaScript compares UTF-16 code
/// units and has no such notion, so every exact-match table that can be handed
/// a CJK string is keyed on this instead.
fileprivate struct JSStringKey: Hashable, Sendable {
    let units: [UInt16]
    init(_ string: String) { units = Array(string.utf16) }
}

/// JavaScript `===` for two strings.
fileprivate func utf16Equal(_ lhs: String, _ rhs: String) -> Bool {
    lhs.utf16.count == rhs.utf16.count && lhs.utf16.elementsEqual(rhs.utf16)
}
