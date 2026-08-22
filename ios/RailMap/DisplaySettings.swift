import Foundation
import Observation
import RailCore
import SwiftUI

/// The 顯示調節 values, and nothing that acts on them.
///
/// Ported from `app/public/app-display-values.js`, which exists in the web app
/// for the same reason this file does: `DISPLAY` is read by nearly every render
/// module, and declaring it inside the control panel that edits it put three
/// renderers in a cycle with a settings panel they never touch. Ownership is
/// the same here — this file DECLARES the values and persists them; the panel
/// (`SettingsView`) edits them; the renderer (`RailMapView`) reads them.
///
/// These are presentation knobs only. They are **not** part of the canonical
/// train store, so the exported JSON stays exactly
/// `{ schema_version, trains: [...] }` — a display preference must never be
/// able to change what a reader's data says.
///
/// ## What is deliberately absent
///
/// Four of the web app's sliders are not here. `fitCurvePrecision`,
/// `fitCurveMinRadius`, `fitCurveMinDetail` and `fitCurveMaxDeviation` feed the
/// corridor curve fitter, which is not wired into this renderer; a slider with
/// nothing behind it is a control that lies. `showFitCurves` and
/// `showHoverRegions` are desktop debug overlays for a pointer this app does
/// not have. `mapOpacity` lives on `RailMapController.basemapOpacity`, which
/// already owned it before this file existed, and `uiMode` has no meaning where
/// the layout is chosen from the window's shape.
@MainActor
@Observable
final class DisplaySettings {

    // MARK: - the values

    /// Multiplies each ride's route line width.
    var routeWidthScale: Double = Defaults.routeWidthScale
    /// Opacity of ridden (`ride_segment == true`) route segments.
    var riddenOpacity: Double = Defaults.riddenOpacity
    /// Opacity of rides not on the selected date.
    var dimOpacity: Double = Defaults.dimOpacity
    /// Radius of the origin / destination markers: the one dot on a ride
    /// deliberately bigger than the station dot the network already drew there.
    var terminalRadius: Double = Defaults.terminalRadius
    /// The black centre inside an intermediate stop marker.
    ///
    /// Stored as the web app's legacy 2…16 slider number rather than as a
    /// radius, so a settings payload written by either client still reads: the
    /// radius is this times ``stopCentreSliderScale``.
    var stopRadius: Double = Defaults.stopRadius
    /// Intermediate calls and pass-throughs draw at exactly the network's own
    /// station radius — the ride must not disagree with the map underneath it
    /// about how big a station is.
    var passRadius: Double = Defaults.passRadius
    /// Multiplies every marker's stroke width.
    var markerStrokeScale: Double = Defaults.markerStrokeScale
    /// Extra line width and marker radius for the selected ride.
    var focusBoost: Double = Defaults.focusBoost
    /// Cross-day (overnight) rides. `false` draws the half that runs on the
    /// other calendar day dashed while a date is selected; `true` draws the
    /// whole itinerary solid, like every other ride.
    var showFullCrossDay: Bool = Defaults.showFullCrossDay

    /// Station-name reading annotations: three INDEPENDENT toggles. Until the
    /// reader touches one (``nameReadingsCustomized``) they follow the UI
    /// language, which is the presentation the web app hardwired before the
    /// toggles existed.
    var nameReadingKana: Bool = Defaults.nameReadingKana
    var nameReadingRomaji: Bool = Defaults.nameReadingRomaji
    var nameReadingZh: Bool = Defaults.nameReadingZh
    var nameReadingsCustomized: Bool = Defaults.nameReadingsCustomized

    // MARK: - defaults

    /// The legacy factor between the stored `stopRadius` number and the radius
    /// it sets. Spelled once here; the read-out and the renderer both use it.
    ///
    /// `nonisolated` because global-actor isolation does not reach a nested
    /// type: `Defaults` below is not on the main actor, and a main-actor
    /// constant cannot be a default value there.
    nonisolated static let stopCentreSliderScale: Double = 0.4

    enum Defaults {
        static let routeWidthScale: Double = 1
        static let riddenOpacity: Double = 1
        static let dimOpacity: Double = 0.18
        static let terminalRadius = Double(RailStyle.stationTerminalRadius)
        static let stopRadius =
            Double(RailStyle.stationStopCentreRadius) / DisplaySettings.stopCentreSliderScale
        static let passRadius = Double(RailStyle.stationRadius)
        static let markerStrokeScale: Double = 1
        static let focusBoost: Double = 2
        static let showFullCrossDay = false
        static let nameReadingKana = false
        static let nameReadingRomaji = false
        static let nameReadingZh = false
        static let nameReadingsCustomized = false
    }

    // MARK: - persistence

    /// Versioned like the web app's key, and for the same reason: the 2026-08-20
    /// retune halved the railway's weight, so sizes tuned against the old weight
    /// have to be re-seeded rather than carried over.
    private static let storageKey = "display-settings-v5"

    private var isLoading = false

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
        load()
    }

    private let userDefaults: UserDefaults

    /// Put every value back to its default. The web app's 重置為預設.
    func reset() {
        routeWidthScale = Defaults.routeWidthScale
        riddenOpacity = Defaults.riddenOpacity
        dimOpacity = Defaults.dimOpacity
        terminalRadius = Defaults.terminalRadius
        stopRadius = Defaults.stopRadius
        passRadius = Defaults.passRadius
        markerStrokeScale = Defaults.markerStrokeScale
        focusBoost = Defaults.focusBoost
        showFullCrossDay = Defaults.showFullCrossDay
        nameReadingKana = Defaults.nameReadingKana
        nameReadingRomaji = Defaults.nameReadingRomaji
        nameReadingZh = Defaults.nameReadingZh
        nameReadingsCustomized = Defaults.nameReadingsCustomized
        persist()
    }

    /// Write the current values. Call after an edit settles rather than on
    /// every tick of a drag.
    func persist() {
        guard !isLoading else { return }
        userDefaults.set(
            [
                "routeWidthScale": routeWidthScale,
                "riddenOpacity": riddenOpacity,
                "dimOpacity": dimOpacity,
                "terminalRadius": terminalRadius,
                "stopRadius": stopRadius,
                "passRadius": passRadius,
                "markerStrokeScale": markerStrokeScale,
                "focusBoost": focusBoost,
                "showFullCrossDay": showFullCrossDay,
                "nameReadingKana": nameReadingKana,
                "nameReadingRomaji": nameReadingRomaji,
                "nameReadingZh": nameReadingZh,
                "nameReadingsCustomized": nameReadingsCustomized,
            ] as [String: Any],
            forKey: Self.storageKey
        )
    }

    private func load() {
        guard let saved = userDefaults.dictionary(forKey: Self.storageKey) else { return }
        isLoading = true
        defer { isLoading = false }
        func number(_ key: String, _ fallback: Double) -> Double {
            (saved[key] as? NSNumber)?.doubleValue ?? fallback
        }
        func flag(_ key: String, _ fallback: Bool) -> Bool {
            (saved[key] as? NSNumber)?.boolValue ?? fallback
        }
        routeWidthScale = number("routeWidthScale", Defaults.routeWidthScale)
        riddenOpacity = number("riddenOpacity", Defaults.riddenOpacity)
        dimOpacity = number("dimOpacity", Defaults.dimOpacity)
        terminalRadius = number("terminalRadius", Defaults.terminalRadius)
        stopRadius = number("stopRadius", Defaults.stopRadius)
        passRadius = number("passRadius", Defaults.passRadius)
        markerStrokeScale = number("markerStrokeScale", Defaults.markerStrokeScale)
        focusBoost = number("focusBoost", Defaults.focusBoost)
        showFullCrossDay = flag("showFullCrossDay", Defaults.showFullCrossDay)
        nameReadingKana = flag("nameReadingKana", Defaults.nameReadingKana)
        nameReadingRomaji = flag("nameReadingRomaji", Defaults.nameReadingRomaji)
        nameReadingZh = flag("nameReadingZh", Defaults.nameReadingZh)
        nameReadingsCustomized = flag("nameReadingsCustomized", Defaults.nameReadingsCustomized)
    }

    // MARK: - derived values the renderer asks for

    /// The radius the stop-centre slider's stored number actually sets.
    var stopCentreRadius: Double { stopRadius * Self.stopCentreSliderScale }

    // MARK: - the reading toggles, as the localization engine wants them

    /// `pushNameReadingPrefs()`. `nil` while the toggles are still following
    /// the UI language, which is what `Localization.activeReadingPrefs` reads
    /// as "fall back to `localeDefaultReadingPrefs`" — so an untouched reader
    /// is served by ONE spelling of the language rule rather than by a copy of
    /// it made at seed time.
    var nameReadingPrefs: Localization.ReadingPrefs? {
        guard nameReadingsCustomized else { return nil }
        return Localization.ReadingPrefs(
            kana: nameReadingKana, romaji: nameReadingRomaji, zh: nameReadingZh)
    }

    /// `syncNameReadingDefaultsToLang(lang)`: until the reader touches one of
    /// the three toggles, they display the language's defaults.
    ///
    /// Only the *switch positions* are updated here. What the map and the
    /// popups actually annotate with is the engine's `activeReadingPrefs`,
    /// which already answers the language default on its own — this exists so
    /// the settings panel does not show three switches off while the map is
    /// drawing kana.
    ///
    /// Must not be called from a view's `body`: it mutates observed state.
    func syncNameReadingDefaults(to language: Localization.Language) {
        guard !nameReadingsCustomized else { return }
        let defaults = Localization.localeDefaultReadingPrefs(language)
        guard defaults != Localization.ReadingPrefs(
            kana: nameReadingKana, romaji: nameReadingRomaji, zh: nameReadingZh)
        else { return }
        nameReadingKana = defaults.kana
        nameReadingRomaji = defaults.romaji
        nameReadingZh = defaults.zh
        persist()
    }

    /// The saved toggles, read without an instance.
    ///
    /// `AppLocalization` is built before any view exists and has to seed the
    /// engine at that moment — the on-map station labels are drawn whether or
    /// not the reader ever opens Settings. Both objects read the same key, so
    /// this cannot disagree with the instance that loads a moment later.
    static func persistedNameReadingPrefs(
        userDefaults: UserDefaults = .standard
    ) -> Localization.ReadingPrefs? {
        guard let saved = userDefaults.dictionary(forKey: storageKey),
            (saved["nameReadingsCustomized"] as? NSNumber)?.boolValue == true
        else { return nil }
        func flag(_ key: String) -> Bool { (saved[key] as? NSNumber)?.boolValue ?? false }
        return Localization.ReadingPrefs(
            kana: flag("nameReadingKana"),
            romaji: flag("nameReadingRomaji"),
            zh: flag("nameReadingZh"))
    }
}
