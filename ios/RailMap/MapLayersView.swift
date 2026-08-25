import RailCore
import SwiftUI

/// 地圖圖層 — what of the reader's own journeys is drawn.
///
/// The web app's is a `<details>` popover in the map's top-right corner
/// (`buildLayersControl` in app-map-init.js): the four journey-geometry
/// switches, then a 已乘路線顯示 subhead with four category switches.
///
/// A sheet rather than a `Menu`, and the reason is in the web app's own
/// comment: "Multiple layer selections intentionally keep the menu open." A
/// SwiftUI `Menu` closes on the first tap, which turns setting three of these
/// into three trips to the control bar.
///
/// The complete network is controlled by the train button on the map itself,
/// next to this panel's layers button. Keeping that one direct control avoids
/// presenting the same state twice in adjacent surfaces.
struct MapLayersView: View {
    @Environment(AppLocalization.self) private var localization
    @Environment(\.dismiss) private var dismiss

    @Bindable var controller: RailMapController
    /// Whether a region's network is being read right now so the categories
    /// can be told apart. Until it has been, every ride stays drawn.
    var classifying: Bool

    var body: some View {
        NavigationStack {
            List {
                // 全部線路: the shipped network. Its lines are the rail's own
                // train button and are deliberately not repeated here (see the
                // type note); what had no switch at all until now is what it
                // draws AT each station.
                Section {
                    Toggle(
                        localization.text(
                            "ios.layers.networkStations", fallback: "Stations"),
                        isOn: $controller.layers.networkStations)
                    .accessibilityIdentifier("layerNetworkStations")
                    Toggle(
                        localization.text(
                            "ios.layers.networkStationNames", fallback: "Station names"),
                        isOn: $controller.layers.networkStationNames)
                    .accessibilityIdentifier("layerNetworkStationNames")
                } header: {
                    Text(localization.text(
                        "ios.layers.networkGroup", fallback: "All railways"))
                } footer: {
                    Text(localization.text(
                        "ios.note.networkLayers",
                        fallback: """
                            Both follow the rail network switch on the map. Station names \
                            also wait for the zoom level that gives them room.
                            """))
                }

                // 已乘坐線路: the reader's own journeys. 列車経路 is the master
                // — see `MapLayers.routes` — so the three station switches
                // under it are disabled rather than forced off while it is
                // down. Forcing them would throw away the arrangement the
                // reader had; disabling them keeps the panel honest about what
                // the map is drawing without spending their settings to do it.
                Section {
                    Toggle(
                        localization.countryText("map.routes", fallback: "Train routes"),
                        isOn: $controller.layers.routes)
                    .accessibilityIdentifier("layerRoutes")
                    Group {
                        Toggle(
                            localization.countryText("map.stops", fallback: "Intermediate stops"),
                            isOn: $controller.layers.stops)
                        .accessibilityIdentifier("layerStops")
                        Toggle(
                            localization.countryText(
                                "map.terminals", fallback: "Terminals (origin / destination)"),
                            isOn: $controller.layers.terminals)
                        .accessibilityIdentifier("layerTerminals")
                        Toggle(
                            localization.countryText(
                                "map.passThrough", fallback: "Pass-through stations"),
                            isOn: $controller.layers.passThrough)
                        .accessibilityIdentifier("layerPassThrough")
                    }
                    .disabled(!controller.layers.routes)
                } header: {
                    Text(localization.countryText(
                        "map.riddenGroup", fallback: "Ridden lines"))
                }

                Section {
                    // `text` rather than `countryText`, and these four are the
                    // only strings on this panel where the distinction exists.
                    //
                    // All four carry country variants — 高鐵 / 新幹線,
                    // 捷運 / 地下鐵 / 地鐵, 사철 — and resolving them would
                    // follow the variant region, which is Passport's scope
                    // switch and nothing to do with this map. That is right on
                    // the statistics screen, where the numbers ARE one
                    // network's. It is wrong here: this map draws all five
                    // networks at once and each filter acts on all of them, so
                    // a Japanese reader with Passport set to Taiwan would be
                    // offered a 台灣高速鐵道 switch that also hides every
                    // 新幹線 on screen — a label narrower than the thing it
                    // controls.
                    //
                    // The base spelling is Japan's, which is not neutral
                    // either; it is at least STABLE, and it does not change
                    // under a switch on another screen.
                    Toggle(
                        localization.text("stat.hsr", fallback: "Shinkansen"),
                        isOn: $controller.layers.categories.hsr)
                    Toggle(
                        localization.text("map.riddenJr", fallback: "JR conventional"),
                        isOn: $controller.layers.categories.jr)
                    Toggle(
                        localization.text("stat.metro", fallback: "Subway"),
                        isOn: $controller.layers.categories.metro)
                    Toggle(
                        localization.text("map.riddenPriv", fallback: "Private / other"),
                        isOn: $controller.layers.categories.priv)
                } header: {
                    // Not `map.riddenGroup` any more: the section above now
                    // carries that heading, and two sections under one title
                    // read as one section that lost its grouping. These four
                    // filter which KINDS of ridden line are drawn, which is a
                    // narrower question than the group above.
                    Text(localization.text(
                        "ios.layers.riddenCategories", fallback: "Ridden line types"))
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(
                            localization.text(
                                "ios.note.riddenCategories",
                                fallback: """
                                    Each ridden section is classified by the network it covers \
                                    most of. Sections the network cannot identify stay visible.
                                    """))
                        if classifying {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.mini)
                                // The statistics screen's own stage name,
                                // because it is the same stage: both are
                                // waiting on `EdgeIndexCache` to read one
                                // region's network. A second translation of
                                // one sentence is a second thing to keep true.
                                Text(localization.statsText("ios.stats.stage.readingNetwork"))
                            }
                            .transition(.opacity)
                        }
                    }
                    // This is a status replacement, not spatial motion. A short
                    // opacity-only transition remains useful under Reduce
                    // Motion and avoids collapsing the footer in one frame.
                    .animation(RailMotion.reduced, value: classifying)
                }
            }
            .navigationTitle(localization.countryText("map.layers", fallback: "Map layers"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(localization.text("ios.done", fallback: "Done")) { dismiss() }
                }
            }
        }
        // §4.2: this sheet is ABOUT the map, so it must not cover all of it —
        // half by default, full when the reader pulls it up. Declared here
        // rather than at the presenter, the way `VideoExportOptionsView` does.
        .presentationDetents([.medium, .large])
    }
}
