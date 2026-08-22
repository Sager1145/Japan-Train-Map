import Foundation
import RailCore

/// What the reader's language settles about the names on the map, as a value
/// the renderer can compare.
///
/// The map draws names in three places that the web app localises —
/// `stationNameReadings` (`app-ui-utils.js`), `buildEndpointLabelSpec` and
/// `buildStationPopupModel` — and every one of them asks the same two
/// questions of `I18N`: what is this station CALLED in the active language,
/// and which reading sublines does the reader want under it. Both answers live
/// on ``AppLocalization``, which is main-actor state; the renderer runs off
/// `MKMapView` delegate callbacks. So the lookups themselves are made through
/// ``RailMapView`` and this type carries only what a *comparison* needs.
///
/// ## Why a signature rather than a table of names
///
/// A pre-resolved table would have to hold every station the map might draw —
/// 10,217 of them for Japan — and be rebuilt on every SwiftUI update, because
/// a `body` runs whenever any observed value moves and there is nowhere in a
/// `UIViewRepresentable` to memoise one without changing the view's
/// initialiser. What the renderer actually needs from a value is the answer to
/// "has anything about the reader's language changed since the last build?",
/// and that is four strings and three flags.
///
/// ## The probe
///
/// Three of those inputs move when the reader acts, and the renderer would see
/// them. The fourth does not: ``StationReadingsStore`` decodes a country's
/// table on its own executor and installs it into the localisation engine some
/// milliseconds after the country is set, and nothing observable about
/// `AppLocalization` changes shape when it lands. So the signature carries one
/// resolved reading as a witness that the table is in place — 東京 for the
/// Japanese table, and ``localizesNames`` for the four countries whose tables
/// replace the name instead of annotating it. Without it a ride selected in
/// the first moments of a country switch would keep un-annotated names until
/// something else happened to force a rebuild.
struct MapNaming: Equatable, Sendable {

    /// Everything that can change an answer, flattened so `==` is one compare.
    var signature: String = ""

    /// Whether the active country's table localises the base NAME (Taiwan,
    /// Hong Kong, Macao, Korea) rather than annotating a Japanese one with
    /// kana/romaji sublines. Nothing here branches on it — the display sites
    /// ask `AppLocalization` and get the right answer either way — but it is
    /// part of the signature, and it is the witness for those four countries.
    var localizesNames = false

    /// `tag.dep` / `tag.arr` — the 発 / 着 prefix an endpoint card puts before
    /// its time.
    var departureTag = ""
    var arrivalTag = ""
    /// `tag.start` / `tag.end` — the 起點 / 終點 badge the selected DAY's first
    /// origin and last destination carry.
    var startTag = ""
    var endTag = ""

    init() {}

    /// The snapshot, taken during a SwiftUI update — which is the moment these
    /// values leave the main actor.
    @MainActor
    init(_ localization: AppLocalization) {
        localizesNames = localization.localizesStationNames
        departureTag = localization.text("tag.dep", fallback: "Dep")
        arrivalTag = localization.text("tag.arr", fallback: "Arr")
        startTag = localization.text("tag.start", fallback: "Start")
        endTag = localization.text("tag.end", fallback: "End")
        let prefs = localization.activeReadingPrefs
        signature = [
            localization.language.rawValue,
            prefs.kana ? "k" : "-",
            prefs.romaji ? "r" : "-",
            prefs.zh ? "z" : "-",
            localizesNames ? "L" : "-",
            // The table-arrival witness. See the type's note.
            localization.nameReadings(Self.probeName),
            departureTag, arrivalTag, startTag, endTag,
        ].joined(separator: "\u{0000}")
    }

    /// A station that is in the Japanese readings table and in no other, so
    /// resolving it is a cheap test of whether that table has been installed.
    private static let probeName = "東京"
}
