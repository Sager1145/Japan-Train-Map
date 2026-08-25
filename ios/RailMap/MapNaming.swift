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
/// ## The witness
///
/// Three of those inputs move when the reader acts, and the renderer would see
/// them. The fourth does not: ``StationReadingsStore`` decodes the five
/// regions' tables on its own executor and installs them into the naming
/// engines over the seconds after launch, and nothing observable about
/// `AppLocalization` changes shape when one lands. So the signature carries
/// ``AppLocalization/readingsGeneration``, which counts them in. Without it a
/// map drawn in the first moments after launch would keep un-annotated names
/// until something else happened to force a rebuild.
struct MapNaming: Equatable, Sendable {

    /// Everything that can change an answer, flattened so `==` is one compare.
    var signature: String = ""

    /// How many regional readings tables have been installed. Nothing here
    /// branches on it — the display sites ask `AppLocalization` per station and
    /// get the right answer either way — but it is the witness that a table
    /// which arrived after the last build is now in place.
    var readingsGeneration = 0

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
        readingsGeneration = localization.readingsGeneration
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
            // The table-arrival witness. See the type's note.
            String(readingsGeneration),
            departureTag, arrivalTag, startTag, endTag,
        ].joined(separator: "\u{0000}")
    }
}
