import Foundation
import RailCore
import RailPresentation

/// Every string this app invented, in one registry.
///
/// The shipped web catalog (`Localizable.json`) is still the first place any
/// key is looked up — that is what keeps the two products from describing
/// 匯出 JSON differently. This registry is the *second* place: the sentences
/// the native screens introduced and the web app has no key for.
///
/// ## Why this file exists
///
/// It used to be five tables and five lookup functions. Each screen's port
/// added its own — `DataStrings`/`dataText`, `EditorStrings`/`editorText`,
/// `JourneyStrings`/`journeyText`, `StatisticsStrings`/`statsText` — and each
/// one carried a comment explaining that `AppLocalization` already owned a
/// table like it but belonged to another port's in-flight work, so adding to
/// it from here would be an edit to a file someone else was writing.
///
/// That reason expired when the ports landed. The tables themselves are not
/// duplication — they are data, and keeping each screen's sentences in that
/// screen's own file is why they are easy to find and easy to review. What was
/// duplicated is the *mechanism*: four functions doing the same lookup with
/// four subtly different fallback rules. There is one lookup now, and the
/// per-screen entry points below are thin forwarders that keep 400-odd call
/// sites unchanged.
///
/// ## The invariant this rests on
///
/// Merging five tables into one is only behaviour-preserving if no key appears
/// in two of them — otherwise a key that used to resolve from its own screen's
/// table could start resolving from another's. Measured at the time of the
/// merge: **zero keys shared between any two tables, and zero keys shadowing
/// the shipped web catalog.** ``assertNoCollisions()`` turns that measurement
/// into something that fails loudly rather than silently picking a winner.
enum AppStrings {

    /// The five contributors, named, so a collision can say *which two*.
    private static let contributors: [(name: String, table: Table)] = [
        ("ShellStrings", ShellStrings.table),
        ("DataStrings", DataStrings.table),
        ("EditorStrings", EditorStrings.table),
        ("JourneyStrings", JourneyStrings.table),
        ("StatisticsStrings", StatisticsStrings.table),
    ]

    typealias Table = [String: [Localization.Language: String]]

    /// Every native key, from every screen.
    static let table: Table = {
        var merged = Table()
        merged.reserveCapacity(contributors.reduce(0) { $0 + $1.table.count })
        for (_, table) in contributors {
            merged.merge(table) { existing, _ in existing }
        }
        assertNoCollisions()
        return merged
    }()

    /// Fails the DEBUG build if two screens ever spell the same key.
    ///
    /// A precondition rather than a test because the app target has no test
    /// target under it: `RailKit` is where `swift test` can reach, and these
    /// tables are above it. Building the app in Debug is the only moment this
    /// invariant can be checked at all, so it is checked there.
    private static func assertNoCollisions() {
        #if DEBUG
            var owner: [String: String] = [:]
            for (name, table) in contributors {
                for key in table.keys {
                    if let first = owner[key] {
                        assertionFailure(
                            "the native string key \"\(key)\" is spelled by both \(first) and "
                                + "\(name). One key belongs to one screen — merge the entries or "
                                + "namespace one of them, or the winner is whichever table was "
                                + "listed first.")
                    }
                    owner[key] = name
                }
            }
        #endif
    }
}

extension AppLocalization {

    /// The data workspace's own sentences — the web catalog first, this app's
    /// table second.
    ///
    /// A forwarder rather than a distinct rule: `text` already consults
    /// ``AppStrings/table``, which now contains what `DataStrings` used to be
    /// passed in as a `fallback`. Behaviour is unchanged — a key in the
    /// catalog resolves there, a key in the table resolves from the table, and
    /// a key in neither returns itself.
    func dataText(_ key: String, _ params: [String: Localization.Param]? = nil) -> String {
        text(key, params: params)
    }

    /// The ride editor's own sentences. Same rule as ``dataText(_:_:)``.
    func editorText(_ key: String, _ params: [String: Localization.Param]? = nil) -> String {
        text(key, params: params)
    }

    /// The journey surfaces' own sentences.
    ///
    /// `countryText` rather than `text` so that a key which grows a country
    /// variant (`key.tw`, `key.hk`, …) starts resolving to it without this
    /// call site changing — the rule ``countryText(_:params:fallback:)``
    /// documents. A key with no variant costs one dictionary miss and resolves
    /// exactly as `text` would.
    ///
    /// The `fallback` parameter is still here and still last in the chain:
    /// catalog, then ``AppStrings/table``, then the caller's own string.
    func journeyText(
        _ key: String,
        _ params: [String: Localization.Param]? = nil,
        fallback: String? = nil
    ) -> String {
        countryText(key, params: params, fallback: fallback)
    }

    /// Resolves one string the presentation layer left unresolved.
    ///
    /// `key == nil` is `PresentationText`'s marker for a *record value* — a
    /// train number, a station name, a `Foundation` error message. Those go
    /// straight through: sending a train number to a translation table is how
    /// a record ends up renamed by its own interface.
    func journeyText(_ text: PresentationText) -> String {
        guard let key = text.key else { return text.fallback }
        return journeyText(
            key,
            text.params.isEmpty ? nil : text.params,
            fallback: text.fallback)
    }

    /// The statistics screen's own sentences.
    func statsText(_ key: String, params: [String: Localization.Param]? = nil) -> String {
        text(key, params: params)
    }

    /// A category label that follows the active country's variant
    /// (`stat.conv` → `stat.conv.tw` = 臺鐵), which is `I18N.tc` in the web app.
    func statsCategoryText(_ key: String) -> String {
        countryText(key)
    }
}
