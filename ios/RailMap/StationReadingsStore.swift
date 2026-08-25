import Foundation
import RailCore

/// The station-name readings table, read out of the app bundle.
///
/// `RailCore.Localization` already carries every rule this table feeds — the
/// code-before-name lookup, the kana/romaji/zh selection, the TW/HK/MO/KR
/// "localise the name itself" branch — but it deliberately owns no file
/// access, so until something hands it a table it answers as if the table were
/// empty. That is exactly what the app did before this file existed: five
/// `station-readings*.json` were being copied into the bundle by
/// `copy-rail-packages.sh` and nothing ever opened them.
///
/// ## The resource name is the web app's rule, not a second manifest
///
/// `AppCore.countrySuffixed` gives Japan the historical unsuffixed name and
/// every other country a `-{country}` suffix. `copy-rail-packages.sh` copies
/// the files under exactly those names for exactly this reason, so the rule is
/// spelled here once and the loader needs no table of its own.
///
/// ## What the five files actually contain
///
/// Japan's table is *pronunciation*: `kana`, `katakana`, `romaji`, `zh_Hant`,
/// `zh_Hans`, and no `country` field at all — which is why
/// `Localization.StationReadings` reads a missing country as `"JP"` and
/// annotates rather than replaces. The other four declare `country` and carry
/// `zh_Hant` / `zh_Hans` / `ja` / `en` official names instead, with no kana or
/// romaji anywhere; for those, `Localization` localises the base station name
/// and returns no reading sublines at all.
///
/// `katakana` and `name` are read by nobody: `StationReadingRow` has no field
/// for either, and neither does the JavaScript's row reader.
actor StationReadingsStore {

    static let shared = StationReadingsStore()

    /// All five, because all five are on screen at once.
    ///
    /// This used to hold one table and say so: the app had a region switch, so
    /// four of the five could never be asked for. Now every region is drawn
    /// together and a station's names come from its own region's table, so the
    /// cache holds what the map can ask for. About a megabyte of JSON in
    /// total, decoded once each.
    private var tables: [String: Localization.StationReadings] = [:]

    /// `AppCore.countrySuffixed("station-readings", country)`.
    nonisolated static func resourceName(country: String) -> String {
        country == "jp" ? "station-readings" : "station-readings-\(country)"
    }

    /// The table for a country, or `.empty` when the bundle has no such file.
    ///
    /// `.empty` is not a silent failure that looks like success: it declares
    /// country `"JP"`, so names are annotated with whatever the gloss
    /// dictionaries hold and never replaced with a wrong language's name.
    func table(for country: String) -> Localization.StationReadings {
        if let cached = tables[country] { return cached }
        let table = Self.decode(country: country) ?? .empty
        tables[country] = table
        return table
    }

    private nonisolated static func decode(country: String) -> Localization.StationReadings? {
        guard
            let url = Bundle.main.url(
                forResource: resourceName(country: country), withExtension: "json"),
            let data = try? Data(contentsOf: url, options: .mappedIfSafe),
            let raw = try? JSONDecoder().decode(RawTable.self, from: data)
        else { return nil }
        return Localization.StationReadings(
            country: raw.country,
            byCode: (raw.byCode ?? [:]).mapValues(\.row),
            byName: (raw.byName ?? [:]).mapValues(\.row)
        )
    }

    /// The file as shipped. Every unknown key — `note`, `languages`, `stats`,
    /// `sources`, and the rows' own `name` / `katakana` — is ignored by
    /// `Decodable`, which is what keeps this loader from having to track the
    /// generators that write those files.
    private struct RawTable: Decodable {
        let country: String?
        let byCode: [String: RawRow]?
        let byName: [String: RawRow]?
    }

    private struct RawRow: Decodable {
        let kana: String?
        let romaji: String?
        let zhHant: String?
        let zhHans: String?
        let ja: String?
        let en: String?

        enum CodingKeys: String, CodingKey {
            case kana, romaji, ja, en
            case zhHant = "zh_Hant"
            case zhHans = "zh_Hans"
        }

        /// The shipped tables store an unavailable translation as `""` rather
        /// than by omitting the field. They are carried through as-is:
        /// `Localization` tests every one of them for emptiness rather than
        /// for presence, so a blank can never win over a fallback.
        var row: Localization.StationReadingRow {
            Localization.StationReadingRow(
                kana: kana, romaji: romaji,
                zhHant: zhHant, zhHans: zhHans,
                ja: ja, en: en)
        }
    }
}
