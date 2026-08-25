import RailCore
import SwiftUI

import UniformTypeIdentifiers

/// The native top-level destinations — §2.1, and only three of them.
///
/// ```text
/// Upcoming          Passport / 统计          All Journeys        Search
/// ```
///
/// The system `TabView` lives inside one resident Sheet. SwiftUI therefore owns
/// the Liquid Glass bottom bar and gives Search its semantic trailing surface;
/// the Sheet still owns Compact / Medium / Large resizing over the single map.
/// See `BottomChrome.swift` and `ContentView.workspaceTabs`.
///
/// `Data Library` and `Settings` are not destinations either. Both are *tasks*:
/// the reader arrives with something to do, does it, and leaves. They open from
/// the panel header's own entry, over the workspace, and closing one returns to
/// the destination, the filters and the scroll position it was opened from.
///
/// The map is not a destination and not a tab. It is the root layer every
/// destination shares (§4.2) — one `MKMapView`, under the sheet, whose inputs
/// change with the question being asked of it.
///
/// ## What this shell owns
///
/// Every store, and the `PlaybackController`. It used to belong to the rides
/// workspace, which was right while that was the only surface that could play
/// anything. §5.3.5 gives the statistics destination a replay entry point over
/// the same transport, so one controller per destination would mean a run
/// started in one going on playing, unreachable, while another drew a map that
/// knew nothing about it.
struct ContentView: View {
    /// Which destination is on top. §2.1's first tab: what is coming is the
    /// question a journey app is opened with, and an Upcoming with nothing in
    /// it says so plainly and offers the log one tap away (§13.1).
    @State private var selection = PrimaryTab.upcoming
    @State private var network = RailNetworkStore()
    @State private var itineraries = ItineraryStore()
    @State private var library = RideLibrary()
    @State private var mapController = RailMapController()
    @State private var riddenRoutes = RiddenRouteStore()
    @State private var mileageStatistics = MileageStatisticsStore()
    @State private var localization = AppLocalization()
    /// One transport for the whole app. See the type note above.
    @State private var playback = PlaybackController()
    /// Published into the environment rather than passed down: the two places
    /// that care are the settings panel that edits these numbers and the map
    /// that draws with them, and they sit in different branches of the tree.
    /// Threading them through every view between would make the ride list an
    /// intermediary in a conversation it takes no part in.
    @State private var displaySettings = DisplaySettings()
    /// Which region Passport is reporting on — the only region selector left.
    ///
    /// The map, the ride list and the data screen all hold every region at
    /// once now. A statistic mostly cannot: its categories and its coverage
    /// denominator are one network's, so Passport keeps a switch and this is
    /// where it is remembered between launches.
    ///
    /// `"all"` is the exception, and it is a real one rather than a label:
    /// the five networks are geographically disjoint, so their indexes can be
    /// laid side by side into a single denominator and a single set of
    /// category rows. See `EdgeIndexCache.merged`.
    @AppStorage("statistics-region") private var statisticsRegionCode = Region.jp.rawValue

    /// The stored value that means every region at once.
    private static let allRegionsCode = "all"

    var body: some View {
        // One map, and one resident sheet over it. The system TabView is inside
        // that sheet, so its bar moves with the panel rather than becoming a
        // second bottom layer underneath it.
        RailWorkspaceView(
            store: network,
            itineraries: itineraries,
            library: library,
            riddenRoutes: riddenRoutes,
            controller: mapController,
            playback: playback,
            statistics: mileageStatistics,
            statisticsRegion: statisticsRegion,
            selection: $selection
        )
        .environment(localization)
        .environment(network)
        .environment(displaySettings)
        .task {
            // Every region, once, at launch. Nothing waits for a region to be
            // chosen because there is nothing to choose.
            network.loadAll()
            itineraries.load(from: library)
        }
        .task(id: routeLoadKey) {
            guard let loaded = itineraries.loaded else {
                riddenRoutes.clear()
                return
            }
            riddenRoutes.load(trains: loaded.trains)
        }
        .task(id: statisticsLoadKey) {
            guard let loaded = itineraries.loaded else { return }
            let region = statisticsRegion.wrappedValue
            // 全部 counts every region's network, ridden or not: a coverage
            // figure of 0 % for a country you have never been to is an answer,
            // and it is the same answer the per-region scope gives.
            let countries = region.map { [$0.code] } ?? Region.ordered.map(\.code)
            let trains = region.map { scope in
                loaded.trains.filter { Region.resolved($0) == scope }
            } ?? loaded.trains
            let ids = Set(trains.map(\.id))
            mileageStatistics.load(
                countries: countries, trains: trains,
                rides: riddenRoutes.rides.filter { ids.contains($0.id) })
        }
#if DEBUG
        // Which destination to open on, for the same reason
        // `RAILMAP_UI_TEST_SELECT` exists: a `simctl` screenshot harness
        // cannot tap a selector, so two of the three would only ever be
        // reviewed by hand.
        .task {
            switch ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_TAB"] {
            case "upcoming": selection = .upcoming
            case "passport", "statistics", "stats": selection = .stats
            case "all", "journeys": selection = .all
            case "search", "add": selection = .search
            default: break
            }
        }
        // Which region the statistics report on, for a harness that cannot
        // open a menu. Writing the stored default from outside the app is not
        // a substitute: `cfprefsd` caches an app's preferences across launches
        // in the simulator, so a value written to the plist between two
        // launches is not necessarily the value the app reads.
        .task {
            guard let wanted = ProcessInfo.processInfo
                .environment["RAILMAP_UI_TEST_STATS_REGION"],
                Region(rawValue: wanted) != nil || wanted == Self.allRegionsCode
            else { return }
            statisticsRegionCode = wanted
        }
#endif
        // `initial: true`: the variant region has its own stored key now (see
        // `AppLocalization.variantKey`), so the launch value has to be pushed
        // rather than assumed to already agree.
        .onChange(of: statisticsRegionCode, initial: true) { _, code in
            // The eleven country-variant catalog keys — 捷運 / 地下鐵 and the
            // rest — all belong to the statistics vocabulary, so they follow
            // this switch rather than a region the app no longer has. 全部 has
            // no region's vocabulary, and takes the catalog's base spelling.
            localization.setVariantRegion(Region(rawValue: code) ?? .jp)
        }
    }

    /// The stored region code, as the scope Passport binds to. `nil` is 全部.
    private var statisticsRegion: Binding<Region?> {
        Binding(
            get: {
                guard statisticsRegionCode != Self.allRegionsCode else { return nil }
                // An unrecognised code is Japan rather than 全部: a value this
                // build does not know is a stale preference, not a request for
                // every network at once.
                return Region(rawValue: statisticsRegionCode) ?? .jp
            },
            set: { statisticsRegionCode = $0?.rawValue ?? Self.allRegionsCode })
    }

    /// Every ride, in full, as the value the route load is keyed on.
    ///
    /// It used to be `id:visible` per train, and that was a claim the record
    /// could not keep: a `DrawnRide` bakes in the journey's colour, its
    /// visibility, its stops and the days it spans, and its geometry is solved
    /// from the stops, the route sections and the route policy. Every one of
    /// those is editable — `ItineraryStore.replace` commits a whole train, and
    /// an import can overwrite one under the id it already had — so a key made
    /// of ids and visibility says "nothing changed" for edits that changed
    /// everything the map draws. The list then showed the new record while the
    /// map drew the old line in the old colour, playback followed the old
    /// path, and the statistics counted the old stops, until something else
    /// happened to move the key.
    ///
    /// `[Train]` is `Equatable`, so this is exact rather than a proxy for
    /// exactness, and it is cheap where it has to be: SwiftUI compares the id
    /// on every body evaluation, and `Array ==` returns on buffer identity
    /// when the store has not been regrouped since. A regroup that produced an
    /// identical list costs one elementwise comparison and correctly reloads
    /// nothing.
    ///
    /// Optional rather than defaulted to `[]`, so "still loading" and "no
    /// rides at all" stay distinguishable — the first must not clear the
    /// routes, and the second must.
    private var routeLoadKey: [Train]? { itineraries.loaded?.trains }

    /// The same, plus what the statistics additionally depend on: which region
    /// Passport is reporting on, and the drawn geometry the coverage is
    /// measured against.
    private var statisticsLoadKey: StatisticsLoadKey {
        StatisticsLoadKey(
            region: statisticsRegionCode,
            trains: routeLoadKey,
            rides: riddenRoutes.rides.map { "\($0.id):\($0.vertexCount)" })
    }

    private struct StatisticsLoadKey: Equatable {
        var region: String
        var trains: [Train]?
        var rides: [String]
    }
}

#Preview {
    ContentView()
}
