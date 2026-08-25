import RailCore
import SwiftUI

/// The 設定 workspace.
///
/// Grouped by `JRM_FLIGHTY_UI_REFACTOR_SPEC.md` §5.9's question — *does this
/// change the map, the interface, or the data?* — which is why every control
/// on this screen answers "the map" or "the interface" and there is nothing
/// here that can edit a ride. The three rules that follow from it are visible
/// in the code:
///
/// - A display preference must not imply that it edits the reader's data, so
///   the two places a reader might suspect it (the panel's own footer and the
///   reset button) say outright that the exported JSON is untouched.
/// - An operation that changes data does not belong here. Importing, sample
///   loading and deletion live in the Data workspace and are not mirrored.
/// - Every toggle explains what it reaches WHERE IT STANDS. There is no single
///   help paragraph at the top explaining nine unrelated switches.
///
/// ## Which lookup a label uses
///
/// The web app resolves every static string through `tc()` — `applyStatic`
/// does it for all of them — so any catalog key is one `key.tw` away from
/// being country-specific without its call site changing. Catalog keys here go
/// through ``AppLocalization/countryText(_:params:fallback:)`` for the same
/// reason; only the iOS-only `ios.*` keys, which have no web catalog entry and
/// therefore no variants, use `text`.
struct SettingsView: View {
    @Environment(AppLocalization.self) private var localization
    @Environment(DisplaySettings.self) private var display
    @Binding var appearance: String
    @Bindable var network: RailNetworkStore
    @Bindable var controller: RailMapController

    var body: some View {
        Form {
            languageSection
            stationNameSection
            appearanceSection
            mapContentSection
            rideLineSection
            stationMarkerSection
            selectionSection
            resetSection
            diagnosticsSection
        }
        .navigationTitle(localization.text("ios.settings", fallback: "Settings"))
        // The switch positions follow the interface language until the reader
        // pins them. `syncNameReadingDefaults` mutates observed state, so it
        // runs here and on change — never from `body`.
        .task { display.syncNameReadingDefaults(to: localization.language) }
        .onChange(of: localization.language) { _, language in
            display.syncNameReadingDefaults(to: language)
        }
    }

    // MARK: - 1. Language

    /// No region picker.
    ///
    /// There used to be one here, and it decided everything: which package was
    /// drawn, which store was open, which statistics were computed. The map
    /// now draws all five networks at once and each ride names its own region,
    /// so the only region choice left in the app is the one on the statistics
    /// screen — where the categories and the coverage denominator genuinely
    /// belong to one network.
    private var languageSection: some View {
        @Bindable var localization = localization
        return Section(localization.text("ios.regionLanguage", fallback: "Language")) {
            Picker(
                localization.countryText("lang.label", fallback: "Language"),
                selection: $localization.language
            ) {
                // Language names are written in the language they name — the
                // one list on the screen that must NOT be translated.
                Text(verbatim: "繁體中文").tag(Localization.Language.zhHant)
                Text(verbatim: "简体中文").tag(Localization.Language.zhHans)
                Text(verbatim: "日本語").tag(Localization.Language.ja)
                Text(verbatim: "English").tag(Localization.Language.en)
            }
            .pickerStyle(.navigationLink)
        }
    }

    // MARK: - 1b. Station name readings

    /// The three independent reading toggles.
    ///
    /// They sit beside the language picker rather than under the map controls
    /// because that is what they are about: how a station's NAME is written,
    /// not how the map is drawn. Until one of them is touched they follow the
    /// interface language — the rule lives once, in
    /// `Localization.localeDefaultReadingPrefs`.
    @ViewBuilder
    private var stationNameSection: some View {
        Section {
            if localization.localizesEveryStationName {
                Text(
                    localization.text(
                        "ios.note.readingsLocalized",
                        fallback:
                            "This region's station names come straight from the operator's own official name in each language."
                    )
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            } else {
                SettingToggleRow(
                    title: localization.countryText(
                        "disp.nameReadingKana", fallback: "Station kana readings"),
                    note: localization.text(
                        "ios.note.readingKana",
                        fallback: "Adds the kana reading under a Japanese station name."),
                    isOn: Binding(
                        get: { display.nameReadingKana },
                        set: { display.nameReadingKana = $0; pinNameReadings() })
                )
                SettingToggleRow(
                    title: localization.countryText(
                        "disp.nameReadingRomaji", fallback: "Station romaji readings"),
                    note: localization.text(
                        "ios.note.readingRomaji",
                        fallback: "Adds the Hepburn romanisation under a station name."),
                    isOn: Binding(
                        get: { display.nameReadingRomaji },
                        set: { display.nameReadingRomaji = $0; pinNameReadings() })
                )
                SettingToggleRow(
                    title: localization.countryText(
                        "disp.nameReadingZh", fallback: "Station Chinese names"),
                    note: localization.text(
                        "ios.note.readingZh",
                        fallback:
                            "Adds the Chinese name under a station, where the reference table has one."
                    ),
                    isOn: Binding(
                        get: { display.nameReadingZh },
                        set: { display.nameReadingZh = $0; pinNameReadings() })
                )
            }
        } header: {
            Text(localization.text("ios.stationNames", fallback: "Station names"))
        } footer: {
            if !localization.localizesEveryStationName && !display.nameReadingsCustomized {
                Text(
                    localization.text(
                        "ios.note.readingsFollowLanguage",
                        fallback:
                            "Until you change one of these, all three follow the interface language."
                    ))
            }
        }
    }

    /// The first explicit choice pins all three toggles: from then on they keep
    /// the reader's answer instead of tracking the interface language, exactly
    /// as `nameReadingsCustomized` does in the web app.
    private func pinNameReadings() {
        display.nameReadingsCustomized = true
        display.persist()
        localization.setNameReadings(display.nameReadingPrefs)
    }

    // MARK: - 2. Appearance

    private var appearanceSection: some View {
        Section {
            Picker(
                localization.countryText("theme.label", fallback: "Theme"), selection: $appearance
            ) {
                Text(localization.countryText("theme.system", fallback: "System")).tag("system")
                Text(localization.countryText("theme.light", fallback: "Light")).tag("light")
                Text(localization.countryText("theme.dark", fallback: "Dark")).tag("dark")
            }
            .pickerStyle(.segmented)
        } header: {
            Text(localization.text("ios.appearance", fallback: "Appearance"))
        } footer: {
            Text(
                localization.text(
                    "ios.note.theme",
                    fallback:
                        "Line colours automatically use each operator's light or dark palette."))
        }
    }

    // MARK: - 3. Map content

    private var mapContentSection: some View {
        Section {
            SettingToggleRow(
                title: localization.countryText("map.allRailways", fallback: "Complete rail network"),
                note: localization.text(
                    "ios.note.allRailways",
                    fallback: "The complete rail network drawn beneath your rides."),
                isOn: $controller.showsNetwork
            )
            VStack(alignment: .leading, spacing: 4) {
                Button(localization.countryText("btn.fit", fallback: "Frame loaded network")) {
                    controller.fitToNetwork()
                }
                Text(
                    localization.text(
                        "ios.note.fitToNetwork",
                        fallback: "Moves the map to frame the network that is currently loaded.")
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            DisplaySliderRow(
                title: localization.countryText("disp.mapOpacity", fallback: "Basemap opacity"),
                note: localization.text(
                    "ios.note.basemapOpacity", fallback: "Affects the basemap only."),
                value: $controller.basemapOpacity,
                range: 0...1,
                step: 0.05,
                format: { displayDecimal($0, places: 2) }
            )
            LabeledContent(localization.text("ios.renderer", fallback: "Renderer")) {
                Text(verbatim: "Apple Maps")
            }
        } header: {
            Text(localization.text("ios.mapContent", fallback: "Map content"))
        }
    }

    // MARK: - 3b. The ride's own lines

    private var rideLineSection: some View {
        @Bindable var display = display
        return Section(localization.countryText("map.routes", fallback: "Train routes")) {
            DisplaySliderRow(
                title: localization.countryText("disp.routeWidthScale", fallback: "Line width"),
                note: localization.text(
                    "ios.note.routeWidth", fallback: "Scales your ride's route line."),
                value: $display.routeWidthScale,
                range: 0.2...3,
                step: 0.1,
                format: { displayDecimal($0, places: 1) + "×" },
                onCommit: { display.persist() }
            )
            DisplaySliderRow(
                title: localization.countryText(
                    "disp.riddenOpacity", fallback: "Ridden segment opacity"),
                note: localization.text(
                    "ios.note.riddenOpacity", fallback: "Opacity of the segments recorded as ridden."
                ),
                value: $display.riddenOpacity,
                range: 0...1,
                step: 0.05,
                format: { displayDecimal($0, places: 2) },
                onCommit: { display.persist() }
            )
        }
    }

    // MARK: - 3c. Station markers

    private var stationMarkerSection: some View {
        @Bindable var display = display
        return Section(localization.text("ios.stationMarkers", fallback: "Station markers")) {
            DisplaySliderRow(
                title: localization.countryText(
                    "disp.terminalRadius", fallback: "Terminal (origin/dest) size"),
                note: localization.text(
                    "ios.note.terminalRadius", fallback: "The dot at a ride's origin and destination."
                ),
                value: $display.terminalRadius,
                range: 3...20,
                step: 1,
                format: displayPoints,
                onCommit: { display.persist() }
            )
            DisplaySliderRow(
                title: localization.countryText("disp.stopRadius", fallback: "Stop center-dot size"),
                note: localization.text(
                    "ios.note.stopRadius",
                    fallback: "The black centre inside an intermediate stop's dot."),
                value: $display.stopRadius,
                range: 2...16,
                step: 1,
                // The stored number is the web app's legacy slider value; what
                // it sets is that number times `stopCentreSliderScale`, so the
                // read-out shows the radius rather than the slider position.
                format: { displayPoints($0 * DisplaySettings.stopCentreSliderScale) },
                onCommit: { display.persist() }
            )
            DisplaySliderRow(
                title: localization.countryText(
                    "disp.passRadius", fallback: "Stop / pass-through outer size"),
                note: localization.text(
                    "ios.note.passRadius",
                    fallback: "The outer circle for intermediate calls and pass-throughs."),
                value: $display.passRadius,
                range: 1...12,
                step: 1,
                format: displayPoints,
                onCommit: { display.persist() }
            )
            DisplaySliderRow(
                title: localization.countryText(
                    "disp.markerStrokeScale", fallback: "Marker border width"),
                note: localization.text(
                    "ios.note.markerStroke", fallback: "The border width of every ride marker."),
                value: $display.markerStrokeScale,
                range: 0.5...3,
                step: 0.1,
                format: { displayDecimal($0, places: 1) + "×" },
                onCommit: { display.persist() }
            )
        }
    }

    // MARK: - 4. Selection and focus

    private var selectionSection: some View {
        @Bindable var display = display
        return Section(localization.text("ios.selectionFocus", fallback: "Selection & focus")) {
            DisplaySliderRow(
                title: localization.countryText("disp.focusBoost", fallback: "Selection zoom boost"),
                note: localization.text(
                    "ios.note.focusBoost",
                    fallback: "How much thicker the selected ride is drawn."),
                value: $display.focusBoost,
                range: 0...6,
                step: 1,
                format: { "+" + displayDecimal($0, places: 0) },
                onCommit: { display.persist() }
            )
            DisplaySliderRow(
                title: localization.countryText("disp.dimOpacity", fallback: "Off-date dimming"),
                note: localization.text(
                    "ios.note.dimOpacity",
                    fallback: "Rides that are not on the selected date fade to this opacity."),
                value: $display.dimOpacity,
                range: 0...1,
                step: 0.02,
                format: { displayDecimal($0, places: 2) },
                onCommit: { display.persist() }
            )
            SettingToggleRow(
                title: localization.countryText(
                    "disp.fullCrossDay", fallback: "Show full cross-day runs"),
                note: localization.text(
                    "ios.note.fullCrossDay",
                    fallback:
                        "Off draws the half of an overnight ride that runs on the other calendar day as a dashed line."
                ),
                isOn: Binding(
                    get: { display.showFullCrossDay },
                    set: { display.showFullCrossDay = $0; display.persist() }
                )
            )
        }
    }

    // MARK: - 5. Reset

    private var resetSection: some View {
        Section {
            Button(localization.countryText("disp.reset", fallback: "Reset to defaults")) {
                display.reset()
                // `reset` clears `nameReadingsCustomized`, which puts the three
                // reading toggles back to tracking the interface language —
                // `nil` is how the engine spells that.
                localization.setNameReadings(nil)
                display.syncNameReadingDefaults(to: localization.language)
                controller.basemapOpacity = 1
            }
        } footer: {
            Text(
                localization.text(
                    "ios.note.reset",
                    fallback:
                        "Resets the display settings on this screen only. Your rides and exported data are untouched."
                ))
        }
    }

    // MARK: - Diagnostics

    private var diagnosticsSection: some View {
        Section(localization.text("ios.diagnostics", fallback: "Diagnostics")) {
            networkStatus
        }
    }

    @ViewBuilder
    private var networkStatus: some View {
        let packageLabel = localization.text("ios.package", fallback: "Package")
        switch network.state {
        case .idle:
            LabeledContent(
                packageLabel,
                value: localization.text("ios.packageIdle", fallback: "Not loaded"))
        case .loading(let pending):
            HStack {
                ProgressView()
                Text(localization.text("ios.packageDecoding", fallback: "Decoding package…"))
                Spacer()
                Text(pending.map { $0.rawValue.uppercased() }.joined(separator: " "))
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
            }
        case .loaded(let regions, let failures, let elapsed):
            // One row per region, because five packages are five answers: a
            // combined line count would hide a package that failed to load
            // behind four that did not.
            ForEach(regions) { load in
                LabeledContent(
                    packageLabel,
                    value: localization.text(
                        "ios.packageLines",
                        params: [
                            "code": .string(load.region.rawValue.uppercased()),
                            "count": .number(Double(load.lineCount)),
                        ],
                        fallback: "\(load.region.rawValue.uppercased()) · \(load.lineCount) lines"))
            }
            ForEach(failures) { failure in
                Label(
                    "\(failure.region.rawValue.uppercased()) · \(failure.message)",
                    systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
            }
            LabeledContent(
                localization.text("ios.decodeTime", fallback: "Decode time"),
                value: "\(elapsed.milliseconds) ms")
        }
    }

}

// MARK: - Read-outs

/// `toFixed(n)`, the web app's slider read-out format.
///
/// File-scope rather than a member of the view: conforming to `View` isolates
/// the whole type to the main actor, and a `@MainActor` static function cannot
/// be handed to a plain `(Double) -> String` parameter.
private func displayDecimal(_ value: Double, places: Int) -> String {
    String(format: "%.\(places)f", value)
}

/// The web app's read-out says `px`. This one says `pt`, because that is what
/// the number is here — a point size the display scales, not a device pixel.
private func displayPoints(_ value: Double) -> String {
    displayDecimal(value, places: value == value.rounded() ? 0 : 1) + " pt"
}

/// A slider with its label above and its explanation below.
///
/// The label does not share a fixed-width row with the slider: at accessibility
/// text sizes a 180 pt slider beside a wrapped label is how a control ends up
/// two points wide (§10.1 — space is found by re-laying out, never by shrinking
/// type). `ViewThatFits` drops the read-out onto its own line when the title no
/// longer leaves room for it.
private struct DisplaySliderRow: View {
    let title: String
    var note: String?
    @Binding var value: Double
    let range: ClosedRange<Double>
    let step: Double
    let format: (Double) -> String
    var onCommit: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(title)
                    Spacer(minLength: 8)
                    readout
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                    readout
                }
            }
            Slider(value: $value, in: range, step: step) { editing in
                if !editing { onCommit() }
            }
            .accessibilityLabel(title)
            .accessibilityValue(format(value))
            if let note {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private var readout: some View {
        Text(format(value))
            .monospacedDigit()
            .foregroundStyle(.secondary)
    }
}

/// A toggle that carries its own explanation, so no part of this screen needs
/// a general help paragraph to be understood (§5.9).
private struct SettingToggleRow: View {
    let title: String
    let note: String
    @Binding var isOn: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle(title, isOn: $isOn)
            Text(note)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}
