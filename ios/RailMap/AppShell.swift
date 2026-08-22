import RailCore
import SwiftUI

import UniformTypeIdentifiers

/// The native top-level destinations.
///
/// The old prototype put four home-grown tabs inside a permanently presented
/// sheet. That made the sheet both navigation and content, and meant a tab
/// selection was not a system tab selection. The application shell now uses
/// `TabView`; each destination owns its own navigation stack and therefore
/// keeps its path when the reader changes tabs.
struct ContentView: View {
    @State private var selection = RootTab.rides
    @State private var network = RailNetworkStore()
    @State private var itineraries = ItineraryStore()
    @State private var library = RideLibrary()
    @State private var mapController = RailMapController()
    @State private var riddenRoutes = RiddenRouteStore()
    @State private var mileageStatistics = MileageStatisticsStore()
    @State private var localization = AppLocalization()
    /// Published into the environment rather than passed down: the two places
    /// that care are the settings panel that edits these numbers and the map
    /// that draws with them, and they sit in different branches of the tree.
    /// Threading them through every view between would make the ride list an
    /// intermediary in a conversation it takes no part in.
    @State private var displaySettings = DisplaySettings()
    @AppStorage("active-country") private var country = "jp"
    @AppStorage("appearance") private var appearance = "system"

    enum RootTab: Hashable {
        case rides
        case statistics
        case data
        case settings
    }

    var body: some View {
        TabView(selection: $selection) {
            RidesWorkspaceView(
                store: network,
                itineraries: itineraries,
                library: library,
                riddenRoutes: riddenRoutes,
                controller: mapController,
                country: $country
            )
                .tabItem { Label(localization.text("nav.trains", fallback: "Rides"), systemImage: "tram") }
                .tag(RootTab.rides)

            NavigationStack {
                StatisticsDashboardView(
                    itineraries: itineraries, statistics: mileageStatistics,
                    country: country)
            }
            .tabItem { Label(localization.text("nav.stats", fallback: "Statistics"), systemImage: "chart.bar.xaxis") }
            .tag(RootTab.statistics)

            NavigationStack {
                DataManagerView(
                    itineraries: itineraries,
                    library: library,
                    country: country
                )
            }
            .tabItem { Label(localization.text("nav.data", fallback: "Data"), systemImage: "arrow.up.arrow.down.square") }
            .tag(RootTab.data)

            NavigationStack {
                SettingsView(
                    country: $country,
                    appearance: $appearance,
                    network: network,
                    controller: mapController
                )
            }
            .tabItem { Label(localization.text("ios.settings", fallback: "Settings"), systemImage: "gearshape") }
            .tag(RootTab.settings)
        }
        .railTabBarBehavior()
        .environment(localization)
        .environment(network)
        .environment(displaySettings)
        .task(id: country) {
            localization.setCountry(country)
            network.load(country: country)
            itineraries.load(country: country, from: library)
        }
        .task(id: routeLoadKey) {
            guard let loaded = itineraries.loaded else {
                riddenRoutes.clear()
                return
            }
            riddenRoutes.load(
                dataset: library.routeDataset, country: country, trains: loaded.trains)
        }
        .task(id: statisticsLoadKey) {
            guard let loaded = itineraries.loaded else { return }
            mileageStatistics.load(
                country: country, trains: loaded.trains, rides: riddenRoutes.rides)
        }
    }

    private var routeLoadKey: String {
        let trainKey = itineraries.loaded?.trains.map {
            "\($0.id):\($0.visible == false ? 0 : 1)"
        }.joined(separator: "|") ?? "loading"
        return "\(country)|\(library.routeDataset)|\(trainKey)"
    }

    private var statisticsLoadKey: String {
        let rides = riddenRoutes.rides.map { "\($0.id):\($0.vertexCount)" }
            .joined(separator: "|")
        return "\(routeLoadKey)|\(rides)"
    }

}

private extension View {
    /// iOS 26 lets the system minimize the tab bar as scrolling moves content
    /// out of the way. Older supported systems retain their native tab bar.
    @ViewBuilder
    func railTabBarBehavior() -> some View {
        if #available(iOS 26.0, *) {
            self.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            self
        }
    }

}

#Preview {
    ContentView()
}
