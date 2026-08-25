import Foundation
import Observation
import RailCore

/// SwiftUI-facing owner for the verified web localization runtime.
///
/// The build phase places the generated catalog in the bundle as raw JSON so
/// `RailCore.Localization` can preserve the main fork's fallback chains,
/// country variants, and `{placeholder}` semantics. This object only bridges
/// that engine into Observation and persists the reader's language choice.
@MainActor
@Observable
final class AppLocalization {
    private static let preferenceKey = "interface-language"

    /// The locale this app's own dates and numbers are formatted in.
    ///
    /// `Foundation`'s `.formatted()` reads `Locale.current`, which is the
    /// DEVICE's language — and this app has a language switch of its own. On
    /// an English phone set to 日本語, every string came out Japanese except
    /// the one line that names a date, which read "Aug 23, 2026 at 5:09" in
    /// the middle of a Japanese panel. Anything the reader is shown follows
    /// the language they picked here, dates included.
    var locale: Locale {
        Locale(identifier: language.rawValue)
    }

    var language: Localization.Language {
        didSet {
            engine?.setLanguage(language.rawValue)
            for region in Region.allCases {
                namingEngines[region]?.setLanguage(language.rawValue)
            }
            UserDefaults.standard.set(language.rawValue, forKey: Self.preferenceKey)
        }
    }

    private var engine: Localization?

    /// One naming engine per region, because a station's language is a
    /// property of the station rather than of the app.
    ///
    /// The web app has a region switch, so it holds ONE readings table and
    /// `Localization` reads its `country` field to decide whether a name is
    /// *annotated* with kana and romaji (Japan) or *replaced* by its official
    /// name in the reader's language (Taiwan, Hong Kong, Macao, Korea). This
    /// app draws all five networks at once, so one table cannot answer for the
    /// map: a Taiwanese station would be handed Japanese rules.
    ///
    /// Rather than change the ported rule — which is fixture-checked against
    /// the JavaScript — the app holds one engine per region and picks by the
    /// station's own region. Each engine is the same catalog and language with
    /// a different table installed, and `Localization` is a value type whose
    /// dictionaries are copy-on-write, so five of them cost five tables rather
    /// than five catalogs.
    private var namingEngines: [Region: Localization] = [:]

    /// Which region's wording the country-variant keys resolve in — `I18N.tc`.
    ///
    /// With no region switch left, this is no longer "the country you are
    /// looking at". It follows the statistics screen's own region selector,
    /// because that is where the eleven variant-bearing keys actually appear
    /// (捷運 / 地下鐵, 高鐵 / 新幹線, 私鐵 / 사철). Everywhere else the base
    /// key reads correctly in all five regions.
    private(set) var variantRegion: Region = .jp

    init() {
        let saved = UserDefaults.standard.string(forKey: Self.preferenceKey)
        language = Localization.Language(rawValue: saved ?? "") ?? Self.systemLanguage

        guard let url = Bundle.main.url(forResource: "Localizable", withExtension: "json"),
            let catalog = try? Localization.Catalog(contentsOf: url)
        else { return }
        engine = Localization(
            catalog: catalog,
            language: language,
            readingPrefs: DisplaySettings.persistedNameReadingPrefs())
        // One naming engine per region, seeded empty and filled as each table
        // is read. An engine with `.empty` installed declares country "JP",
        // which annotates rather than replaces — so a name drawn in the moment
        // before its table lands is the package's own spelling, never another
        // language's name.
        for region in Region.allCases {
            var naming = Localization(
                catalog: catalog,
                language: language,
                readingPrefs: DisplaySettings.persistedNameReadingPrefs())
            naming.setCountry(region.code)
            namingEngines[region] = naming
        }
        setVariantRegion(
            Region(rawValue: UserDefaults.standard.string(forKey: Self.variantKey) ?? "") ?? .jp)
        loadStationReadings()
    }

    /// Which region's wording the statistics screen last asked for.
    /// Deliberately NOT `"statistics-region"`, which is the key the shell's
    /// `@AppStorage` owns.
    ///
    /// These two shared one key, and the value only ever travelled one way —
    /// the shell pushes the region in through `setVariantRegion` — so nothing
    /// went wrong for as long as every value that could be stored was a
    /// `Region`. The scope now has an 全部 entry, which is not: writing "all"
    /// made this line read it back as `nil`, fall through to `.jp`, and SAVE
    /// that over the reader's choice, so choosing 全部 silently selected Japan
    /// a moment later. Two owners of one key is the fault; one key each is the
    /// fix.
    private static let variantKey = "statistics-variant-region"

    /// `I18N.setCountry` for the UI catalog only — the readings tables are all
    /// installed at once and are chosen per station, not per app state.
    func setVariantRegion(_ region: Region) {
        variantRegion = region
        engine?.setCountry(region.code)
        UserDefaults.standard.set(region.rawValue, forKey: Self.variantKey)
    }

    // MARK: - Station name readings

    /// Install every region's readings table.
    ///
    /// Decoding happens on `StationReadingsStore`'s own executor: the five
    /// tables are about a megabyte together and the reader is looking at a map
    /// while they are read. They land one at a time, in whatever order they
    /// finish, and each one only affects the names of its own region.
    private func loadStationReadings() {
        for region in Region.allCases {
            Task { [weak self] in
                let table = await StationReadingsStore.shared.table(for: region.code)
                guard let self else { return }
                self.namingEngines[region]?.setStationReadings(table)
                self.readingsGeneration += 1
            }
        }
    }

    /// How many regional readings tables have been installed.
    ///
    /// The map's renderer is not a SwiftUI view and cannot observe a table
    /// landing — see ``MapNaming``, which carries this number so that a map
    /// drawn before a table arrived is rebuilt once it has.
    private(set) var readingsGeneration = 0

    /// `I18N.setNameReadings`. `nil` puts the three toggles back to following
    /// the UI language.
    func setNameReadings(_ prefs: Localization.ReadingPrefs?) {
        engine?.setNameReadings(prefs)
        for region in Region.allCases { namingEngines[region]?.setNameReadings(prefs) }
    }

    /// What the display sites should actually annotate with right now.
    var activeReadingPrefs: Localization.ReadingPrefs {
        engine?.activeReadingPrefs ?? Localization.localeDefaultReadingPrefs(language)
    }

    /// Whether a region's readings table localises the base station NAME
    /// (Taiwan, Hong Kong, Macao, Korea) instead of annotating a Japanese name
    /// with kana/romaji sublines. The three reading toggles do nothing at all
    /// in those regions, and the settings panel says so rather than offering
    /// switches that cannot change anything.
    func localizesStationNames(in region: Region) -> Bool {
        guard let naming = namingEngines[region] else { return false }
        return Localization.localizedNameCountries.contains(naming.stationReadings.country)
    }

    /// Whether every region drawn localises names — the settings panel's
    /// question, now that all five are on screen at once. Japan is always one
    /// of them, so this is `false` and the reading toggles always do
    /// something; it stays a function of the regions rather than a constant
    /// because a build that shipped without the Japanese package should say so
    /// rather than offer three switches that change nothing.
    var localizesEveryStationName: Bool {
        Region.allCases.allSatisfy { localizesStationNames(in: $0) }
    }

    /// Which engine answers for a name.
    ///
    /// The station code names its own region — Japan's are six digits, every
    /// other package spells `"<region>-official-…"` — so most callers need
    /// pass nothing. A name with no code and no stated region is read as
    /// Japanese, which annotates rather than replaces and therefore cannot put
    /// the wrong language's name on a station.
    private func naming(_ region: Region?, _ code: String?) -> Localization? {
        namingEngines[region ?? Region.fromStationCode(code) ?? .jp]
    }

    /// `I18N.stationName` — the localised base name.
    func stationName(_ name: String?, code: String? = nil, region: Region? = nil) -> String {
        naming(region, code)?.stationName(name, code: code) ?? (name ?? "")
    }

    /// `I18N.nameReadingsTyped` — the enabled readings for a name, typed so a
    /// paired display can align the same kind of reading on the same line.
    func nameReadingsTyped(
        _ name: String?, code: String? = nil, region: Region? = nil
    ) -> [Localization.Reading] {
        naming(region, code)?.nameReadingsTyped(name, code: code) ?? []
    }

    /// Every name the readings table holds for a station, in every language it
    /// carries and regardless of the reading toggles — what
    /// `StationPlaceStore` matches an Apple Maps answer against. See
    /// `Localization.stationNameAliases`.
    func stationNameAliases(
        _ name: String?, code: String? = nil, region: Region? = nil
    ) -> [String] {
        naming(region, code)?.stationNameAliases(name, code: code) ?? []
    }

    /// `I18N.nameReadings` — the enabled readings joined with `" / "`.
    func nameReadings(_ name: String?, code: String? = nil, region: Region? = nil) -> String {
        naming(region, code)?.nameReadings(name, code: code) ?? ""
    }

    /// `I18N.placeName` — a station or proper noun as the active language
    /// displays it, readings included.
    func placeName(_ name: String?, code: String? = nil, region: Region? = nil) -> String {
        naming(region, code)?.placeName(name, code: code) ?? (name ?? "")
    }

    /// The shipped web catalog first, this app's own strings second, the
    /// caller's own words last.
    ///
    /// ``AppStrings/table`` is where the second step reads from — every native
    /// table in the app, merged once. It used to be one table per screen,
    /// consulted by one function per screen, each passing its own table in
    /// through `fallback`; see ``AppStrings`` for why that ended and what the
    /// merge rests on.
    func text(
        _ key: String,
        params: [String: Localization.Param]? = nil,
        fallback: String? = nil
    ) -> String {
        guard let engine else {
            return Self.fill(AppStrings.table[key]?[language] ?? fallback ?? key, params: params)
        }
        let value = engine.t(key, params)
        if value != key { return value }
        return Self.fill(AppStrings.table[key]?[language] ?? fallback ?? key, params: params)
    }

    /// `I18N.tc` — the country-variant lookup.
    ///
    /// The web app does not reserve this for a handful of call sites:
    /// `applyStatic` resolves EVERY `data-i18n` attribute through `tc`, so any
    /// static string is one `key.tw` away from being country-specific without
    /// its call site changing. Native screens follow the same rule — a catalog
    /// key goes through here, and only the iOS-only `ios.*` keys use `text`.
    ///
    /// A missed variant falls through to `text`, which is what keeps that rule
    /// free: the shipped catalog declares variants for eleven keys, and the
    /// rest resolve exactly as `text` would.
    func countryText(
        _ key: String,
        params: [String: Localization.Param]? = nil,
        fallback: String? = nil
    ) -> String {
        guard let engine else { return text(key, params: params, fallback: fallback) }
        let variant = engine.countryVariantKey(key)
        if variant != key {
            let value = engine.t(variant, params)
            if value != variant { return value }
        }
        return text(key, params: params, fallback: fallback)
    }

    private static func fill(
        _ template: String, params: [String: Localization.Param]?
    ) -> String {
        guard let params else { return template }
        var result = template
        for (key, value) in params {
            let replacement: String?
            switch value {
            case .string(let string): replacement = string
            case .number(let number): replacement = JSNumber.string(number)
            case .bool(let bool): replacement = bool ? "true" : "false"
            case .null: replacement = nil
            }
            if let replacement {
                result = result.replacingOccurrences(of: "{\(key)}", with: replacement)
            }
        }
        return result
    }

    private static var systemLanguage: Localization.Language {
        for identifier in Locale.preferredLanguages {
            if identifier.hasPrefix("zh-Hans") || identifier.hasPrefix("zh-CN") {
                return .zhHans
            }
            if identifier.hasPrefix("zh") { return .zhHant }
            if identifier.hasPrefix("ja") { return .ja }
            if identifier.hasPrefix("en") { return .en }
        }
        return .zhHant
    }
}
