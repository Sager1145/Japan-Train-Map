import RailCore
import SwiftUI

/// The 設定 workspace: region, language, map content, appearance.
struct SettingsView: View {
    @Environment(AppLocalization.self) private var localization
    @Binding var country: String
    @Binding var appearance: String
    @Bindable var network: RailNetworkStore
    @Bindable var controller: RailMapController

    var body: some View {
        Form {
            Section(localization.text("country.label", fallback: "Region")) {
                Picker(localization.text("country.label", fallback: "Rail network"), selection: $country) {
                    ForEach(RailNetworkStore.countries, id: \.code) { entry in
                        Text(
                            localization.text(
                                "country.\(entry.code)",
                                fallback: entry.label
                            )
                        )
                        .tag(entry.code)
                    }
                }
                .pickerStyle(.navigationLink)
            }

            Section(localization.text("lang.label", fallback: "Language")) {
                @Bindable var localization = localization
                Picker(localization.text("lang.label", fallback: "Language"), selection: $localization.language) {
                    Text("繁體中文").tag(Localization.Language.zhHant)
                    Text("简体中文").tag(Localization.Language.zhHans)
                    Text("日本語").tag(Localization.Language.ja)
                    Text("English").tag(Localization.Language.en)
                }
                .pickerStyle(.navigationLink)
            }

            Section(localization.text("ios.map", fallback: "Map")) {
                Toggle(localization.text("map.allRailways", fallback: "Complete rail network"), isOn: $controller.showsNetwork)
                Button(localization.text("btn.fit", fallback: "Frame loaded network")) { controller.fitToNetwork() }
                LabeledContent(localization.text("map.basemapOpacity", fallback: "Basemap opacity")) {
                    Slider(value: $controller.basemapOpacity, in: 0.15...1)
                        .frame(maxWidth: 180)
                }
                LabeledContent("Renderer", value: "Apple Maps")
            }

            Section(localization.text("ios.appearance", fallback: "Appearance")) {
                Picker(localization.text("theme.label", fallback: "Theme"), selection: $appearance) {
                    Text(localization.text("theme.system", fallback: "System")).tag("system")
                    Text(localization.text("theme.light", fallback: "Light")).tag("light")
                    Text(localization.text("theme.dark", fallback: "Dark")).tag("dark")
                }
                .pickerStyle(.segmented)
                Text("Line colours automatically use each operator's light or dark palette.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section(localization.text("ios.diagnostics", fallback: "Diagnostics")) {
                networkStatus
            }
        }
        .navigationTitle(localization.text("ios.settings", fallback: "Settings"))
    }

    @ViewBuilder
    private var networkStatus: some View {
        switch network.state {
        case .idle:
            LabeledContent("Package", value: "Idle")
        case .loading:
            HStack { ProgressView(); Text("Decoding package…") }
        case .loaded(let code, let lines, let elapsed):
            LabeledContent("Package", value: "\(code.uppercased()) · \(lines.count) lines")
            LabeledContent("Decode", value: "\(elapsed.milliseconds) ms")
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.red)
        }
    }
}
