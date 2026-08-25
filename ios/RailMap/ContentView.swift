import CoreLocation
import MapKit
import RailCore
import RailPresentation
import SwiftUI

/// The railway over Apple Maps, in the two shapes iOS asks for.
///
/// The compact case is a persistent map workspace: the map and the ride panel
/// remain interactive members of the same hierarchy. It deliberately is not a
/// modal sheet. The panel snaps between three semantic sizes and reserves room
/// for the system tab bar, while the drag handle is the only surface that owns
/// the vertical resize gesture.
///
/// The layout is chosen by the window's shape, not the device. A phone in
/// landscape has almost no height for a sheet but plenty of width for a
/// sidebar, and it reports a *compact* horizontal size class on every model
/// but the largest — so size class alone would put a sheet there and leave the
/// map a letterbox.
///
///   tall windows   a resizable persistent panel over the map
///   wide windows   the ride list beside the map
///
/// The map's controls run down the right edge in both, and in the panel
/// layout they ride above it — at full height they are removed rather than
/// pushed off screen. A control the panel slides over is one that stops
/// working without ever looking broken.
///
/// ## The panel is one surface with two resident layers (§4.4)
///
/// Opening a journey does not push a screen and does not present a second
/// card: it changes which of two permanently-mounted layers is on top. The
/// list underneath keeps its search text, its date filter, its scroll offset
/// and its expanded sections because it was never torn down — which is exactly
/// what §4.4 requires of returning from a journey ("返回列表时应回到原旅程附
/// 近，而不是回到列表顶部"). See ``View/residentLayer(isTop:)``.
///
/// ## Nothing here decides which action is primary (§3.3, §11.2)
///
/// Every surface below renders a `JourneyPresentation` resolved by
/// `JourneyPresentationResolver`. This view does not ask "is it hidden", "is
/// it playing", "did the route fail" — those states can all be true at once,
/// and the one place that turns them into a single primary task is a module
/// with tests over 288 state combinations. What is left here is the wiring:
/// which store call each resolved action makes.
struct RailWorkspaceView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(AppLocalization.self) private var localization

    @Bindable var store: RailNetworkStore
    @Bindable var itineraries: ItineraryStore
    @Bindable var library: RideLibrary
    @Bindable var riddenRoutes: RiddenRouteStore
    @Bindable var controller: RailMapController
    /// The app's ONE transport, owned by the shell.
    ///
    /// It used to be `@State` here, which was right while Journeys was the
    /// only workspace that could play anything. §5.3.5 gives Passport a replay
    /// entry point and §5.2 keeps the map live under Network, so a controller
    /// per workspace would mean a run started in one tab going on playing,
    /// unreachable, while another tab drew a map that knew nothing about it.
    @Bindable var playback: PlaybackController
    /// §5.3's numbers, computed once for the whole app.
    @Bindable var statistics: MileageStatisticsStore
    /// Which region the statistics destination is reporting on.
    /// `nil` is 全部 — see `StatisticsView.region`.
    @Binding var statisticsRegion: Region?
    /// §2.2 (revised): which of the three destinations is on top. The shell
    /// owns it because it survives every panel here.
    @Binding var selection: PrimaryTab
    /// §6.2's appearance preference. Read here because the Settings
    /// destination is presented from this view now (see `RidesSheet.utility`)
    /// rather than from the shell — a controller that is already presenting
    /// the resident sheet cannot present a second one.
    @AppStorage("appearance") private var appearance = "system"
    @State private var render: RailMapView.RenderStats?
    @State private var query = ""
    @State private var selectedDate = Dates.allDates
    /// Alerts and confirmations share one presentation slot. Independent
    /// booleans here can all become true during the same map/menu callback,
    /// which asks one hosting controller to present twice.
    @State private var dialog: RidesDialog?
    /// §10.3's ⌘F target.
    @FocusState private var searchFocused: Bool
    @State private var sheet: RidesSheet?
    @State private var importFlow = ImportFlow()
    @State private var videoExporter = PlaybackVideoExporter()
    @State private var videoSettings = VideoExportSettings()
    /// How long the film would run, taken from `Playback.plan` when the export
    /// options open — §5.6's summary has to state a length before the reader
    /// commits to a run that takes minutes.
    @State private var videoPlanSeconds = 0.0
    @State private var didRunDebugPlayback = false
    /// The N02 edge indexes the 已乘路線顯示 filter classifies against, one per
    /// region that has rides.
    ///
    /// Empty until the reader actually switches a category off. Building one
    /// parses a whole region's rail network, and three of the four boxes being
    /// ticked is the state the map spends its life in — so the default path
    /// pays nothing, exactly as `riddenFeatureCategory` is only reached in the
    /// web app when `anyRiddenCategoryHidden()`.
    @State private var categoryIndexes: [String: Statistics.EdgeIndex] = [:]
    /// Whether an index is being built right now.
    ///
    /// Reading a region's network takes seconds, and until it lands every ride
    /// stays visible — so without this the first tick of a category box is a
    /// control that appears to do nothing, which is indistinguishable from one
    /// that is broken.
    @State private var categoryIndexesBuilding = false
    @State private var manualDates: [String] = []
    @State private var newManualDate = ""
    @AppStorage("map-follows-selected-date") private var mapFollowsSelectedDate = false
    /// `focusZoomEnabled` — 自動縮放. Off to start with, as in the web app: a
    /// map that moves itself every time a row is tapped is a map the reader
    /// cannot keep a place in, so it is asked for rather than assumed.
    @AppStorage("auto-focus-zoom") private var autoFocusZoom = false
    /// Where the resident sheet is resting, as a STAGE rather than as a
    /// `PresentationDetent`.
    ///
    /// The detent is derived from this (see ``detentBinding(_:)``) and never
    /// stored, because two of the three detents are `.height()` values
    /// computed from the window: a stored detent would be a number from the
    /// previous window size, and a detent that is not in the set the sheet was
    /// given is a detent SwiftUI silently replaces.
    @State private var stageSelection: SheetStage = Self.launchStage

    /// Which stop the sheet opens at.
    ///
    /// `.medium` in the app. The environment override exists because the sheet
    /// is resized by dragging and there is no way to drive a drag from a
    /// screenshot harness — the same reason `RAILMAP_UI_TEST_SELECT` exists.
    /// Read once, and only in a debug build.
    private static var launchStage: SheetStage {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_STAGE"] {
        case "compact": return .compact
        case "expanded": return .expanded
        default: return .medium
        }
        #else
        return .medium
        #endif
    }
    /// The sheet's height right now, reported every frame while it is dragged.
    @State private var sheetHeight: CGFloat = 0

    /// How tall the map's control rail actually draws, so the fade that keeps
    /// it out from under the status bar knows where its top edge is. See
    /// `mapLayout`'s `railFade`.
    @State private var railHeight: CGFloat = 0

    /// §13's haptics, and only where they earn a place.
    ///
    /// The app had none at all. These three are the moments Apple's own rules
    /// name — a commit, a destructive commit, and a snap — and each fires on
    /// the CAUSAL event rather than on a state that happens to follow it, so
    /// the tap lands on the same frame as the change it belongs to. Deliberately
    /// not on every button: feedback everywhere trains a reader to feel nothing.
    ///
    /// Carries a counter because `sensoryFeedback` compares values, and two
    /// saves in a row are the same case — without it the second one is silent.
    private struct RailFeedback: Equatable {
        enum Kind { case saved, deleted, settled }
        var kind: Kind
        var count: Int
    }
    @State private var feedback: RailFeedback?

    private func signal(_ kind: RailFeedback.Kind) {
        feedback = RailFeedback(kind: kind, count: (feedback?.count ?? 0) + 1)
    }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// §10.1: the panel's smallest stop follows the reader's text size.
    ///
    /// `PanelHeader` draws its collapsed title at `compactTitleSize`, relative
    /// to `.title3`; this is the row that title sits in, measured against the
    /// same style so the two move together.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .title3) private var compactTitleRow: CGFloat = 48

    /// At accessibility sizes `PanelHeader` moves its controls onto their own
    /// 44-point row. The compact detent must reserve that row too; otherwise
    /// the adaptive layout is correct but the system sheet clips its bottom.
    private var compactHeaderRows: CGFloat {
        compactTitleRow + (dynamicTypeSize.isAccessibilitySize ? 50 : 0)
    }

    private enum RidesDialog {
        case addDate
        case delete(Train)
        case choose([Train])
    }

    /// Everything this workspace can present over itself.
    ///
    /// One enum rather than four `isPresented` bindings on one view: SwiftUI
    /// presents a single sheet per anchor, and four bindings racing for it is
    /// how a "Delete" dialog swallows the editor that was opening behind it.
    private enum RidesSheet: Identifiable {
        case newJourney(Train)
        case edit(Train)
        case detail(Train)
        case importData
        /// §5.6: exporting is a SECONDARY flow — the shape, quality and
        /// bitrate appear once it is opened, not beside the transport.
        case videoOptions
        /// 圖例與資料來源 — the map's own information button.
        case mapInfo
        /// 地圖圖層 — what of the reader's rides is drawn, and which
        /// categories of ridden line. A sheet rather than a menu because the
        /// reader sets several of these in one visit and a `Menu` closes on
        /// the first one, which is the same reason the web app's popover
        /// stays open ("Multiple layer selections intentionally keep the menu
        /// open").
        case mapLayers
        /// A station's own card — what used to be the map's callout.
        case station(StationCard)
        /// §4.1's Data Library and Settings. They are presented from HERE
        /// rather than from the shell because the shell is already presenting
        /// the resident bottom sheet, and one controller cannot present two.
        case utility(UtilityDestination)

        var id: String {
            switch self {
            case .newJourney(let train): "new:\(train.id)"
            case .edit(let train): "edit:\(train.id)"
            case .detail(let train): "detail:\(train.id)"
            case .importData: "import"
            case .videoOptions: "video"
            case .mapInfo: "info"
            case .mapLayers: "layers"
            case .station(let card): "station:\(card.id)"
            case .utility(let destination): "utility:\(destination.rawValue)"
            }
        }
    }

    var body: some View {
        GeometryReader { geometry in
            // Wider than tall, or a regular-width window: sidebar. Read from
            // the geometry so a rotation or an iPad window resize switches
            // layouts as it happens.
            Group {
                if geometry.size.width > geometry.size.height
                    || horizontalSizeClass == .regular
                {
                    sidebarLayout
                } else {
                    mapLayout(in: geometry)
                }
            }
            // §4.3's bottom clearance is NOT published from here any more, and
            // there is nothing left to publish: the system already gives it to
            // every scroll view inside the sheet.
            //
            // What used to be here read `geometry.safeAreaInsets.bottom` off
            // THIS proxy — the root of the window, outside the sheet — and
            // called it "the bar's height plus the home indicator". It is not:
            // the tab bar lives inside the presented sheet, so the root proxy
            // never sees it and the number was the home indicator alone. Both
            // halves of that were wrong, because the strip it was trying to
            // reproduce is already handed to the sheet's own content — a
            // `GeometryProxy` inside a `TabView` page reports 83 points of
            // bottom safe area on an iPhone 17 Pro (49 of bar, 34 of
            // indicator), and SwiftUI insets scrolling content by it without
            // being asked.
            //
            // The hand-rolled margins that consumed this were therefore not
            // making up a shortfall, they were ADDING to a sufficient inset:
            // `.contentMargins(.bottom:for: .scrollContent)` composes with the
            // safe area rather than replacing it, which left the ride card
            // ending 200 points above the window instead of 83 — §14.1's
            // 多余空白, measured by scrolling each panel to its end.
        }
        .onChange(of: playback.currentTrainID) { _, id in
            if let id { itineraries.selectedTrainID = id }
        }
        // §5.3.2: while Passport is on top the map IS its coverage map, so
        // changing what is being reported on has to move the map to it.
        // Otherwise the reader switches to 韓國 and reads a Korean percentage
        // over a picture of Honshū.
        .onChange(of: statisticsRegion) { _, region in
            frameStatisticsRegion(region)
        }
        // …and ARRIVING at Passport is the same event.
        //
        // Only the region itself was watched, so the camera moved when the
        // scope changed but not when the reader switched INTO the destination
        // that scope belongs to. Opening 統計 with the scope already on 日本
        // therefore showed a card headed 日本 over whatever the map happened to
        // be framing — in practice the five-network view across China and
        // Korea. The overlays had switched to coverage mode; the spatial
        // meaning had not, which is the half of §4.2 that makes the map the
        // shared context rather than a backdrop.
        //
        // Guarded on the destination rather than fired on every switch: coming
        // back to the journey list must NOT move the camera, because there the
        // reader's own last framing is the thing they were looking at.
        // A `task(id:)` rather than an `onChange`, and the key carries the
        // NETWORK's readiness as well as the destination. Two reasons, both
        // found by testing rather than by reading:
        //
        //   - `onChange` fires on a CHANGE, so a launch that opens straight
        //     onto Passport — the screenshot harness does exactly this — never
        //     fired it at all.
        //   - `frameStatisticsRegion` measures a rect from `store.lines`, and
        //     for the first moments of a launch that array is empty, so the
        //     rect is null and the call returns having moved nothing. The tab
        //     was reached before the data it frames against existed.
        //
        // The key flips at most twice — arriving, then the packages landing —
        // so this is not a camera that keeps jumping while five regions decode.
        .task(id: "\(selection == .stats)|\(store.lines.isEmpty)") {
            guard selection == .stats, !store.lines.isEmpty else { return }
            frameStatisticsRegion(statisticsRegion)
        }
        .task { manualDates = loadManualDates() }
        // Built off the main actor, published as each region's arrives, and
        // never torn down: a reader who ticks 地下鐵 back off a minute later
        // should not wait for the network to be read a second time.
        .task(id: categoryIndexKey) {
            guard controller.layers.categories.anyHidden else { return }
            let wanted = riddenCountries.filter { categoryIndexes[$0] == nil }
            guard !wanted.isEmpty else { return }
            categoryIndexesBuilding = true
            defer { categoryIndexesBuilding = false }
            for country in wanted {
                guard let index = try? await EdgeIndexCache.shared.index(country: country)
                else { continue }
                if Task.isCancelled { return }
                categoryIndexes[country] = index
            }
        }
#if DEBUG
        // A headless way to put the workspace into its selected state.
        //
        // The Hero is reached by tapping a row, and a tap is the one thing a
        // screenshot harness driving `simctl` cannot perform — so every state
        // in §5.2, including the ones that only appear when a route fails,
        // would otherwise be unreviewable outside a human session. Same shape,
        // and the same DEBUG-only reach, as `RAILMAP_UI_TEST_PLAYBACK` above.
        .task(id: "\(itineraries.loaded?.trains.count ?? 0)") {
            guard let wanted = ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_SELECT"],
                  itineraries.selectedTrainID == nil,
                  let trains = itineraries.loaded?.trains, !trains.isEmpty else { return }
            if let index = Int(wanted) {
                itineraries.selectedTrainID = trains[min(max(index, 0), trains.count - 1)].id
            } else {
                itineraries.selectedTrainID = wanted
            }
        }
        // Which region the camera starts on, and which sample is loaded —
        // the two things a `simctl` harness cannot tap its way to now that
        // the app boots with an empty store and a camera framing all five
        // networks at a zoom where the LOD draws almost nothing.
        .task(id: "\(store.lines.count)|\(controller.isMapReady)") {
            guard controller.isMapReady else { return }
            if let camera = ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_CAMERA"] {
                let values = camera.split(separator: ",").compactMap { Double($0) }
                if values.count == 3 {
                    try? await Task.sleep(for: .milliseconds(700))
                    controller.mapView?.setRegion(MKCoordinateRegion(
                        center: CLLocationCoordinate2D(latitude: values[0], longitude: values[1]),
                        span: MKCoordinateSpan(latitudeDelta: values[2], longitudeDelta: values[2])),
                        animated: false)
                    return
                }
            }
            guard let wanted = ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_REGION"],
                  let region = Region(rawValue: wanted) else { return }
            let rect = store.lines
                .filter { $0.region == region }
                .reduce(MKMapRect.null) { $0.union($1.mapRect) }
            guard !rect.isNull else { return }
            // After the map's own one-time framing, which fires when the last
            // region's lines land and would otherwise pull the camera back out
            // to all five networks a moment after this set it.
            try? await Task.sleep(for: .milliseconds(700))
            controller.mapView?.setVisibleMapRect(
                rect, edgePadding: UIEdgeInsets(top: 40, left: 40, bottom: 40, right: 40),
                animated: false)
        }
        // A sheet, for the same reason `RAILMAP_UI_TEST_SELECT` exists: the
        // legend, the importer and the export options are all reached by a tap
        // that a `simctl` harness cannot perform, so their layout would only
        // ever be reviewed by hand.
        .task(id: controller.isMapReady) {
            guard controller.isMapReady,
                  let wanted = ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_SHEET"]
            else { return }
            try? await Task.sleep(for: .milliseconds(900))
            switch wanted {
            case "info": sheet = .mapInfo
            case "import": sheet = .importData
            case "edit":
                if let train = itineraries.selectedTrain ?? itineraries.loaded?.trains.first {
                    sheet = .edit(train)
                }
            case "layers": sheet = .mapLayers
            // §4.1's two Utility destinations and the export options. All
            // three are reached by a tap on a control the harness cannot
            // press — the data button, the gear, and the transport's export
            // button — so without these the Data Library, Settings and the
            // shape/quality/bitrate sheet are the only surfaces left that
            // nothing but a hand session ever opens.
            case "data": sheet = .utility(.data)
            case "settings": sheet = .utility(.settings)
            case "video": sheet = .videoOptions
            case "station":
                // The station card replaced the map's callout, and a callout
                // was already unreachable from a `simctl` harness — a tap on a
                // bead is still a tap. The station is picked the same way the
                // map would have handed one up: whichever the network store
                // lists first, named and read exactly as the annotation names
                // and reads it.
                if let station = store.stations.first {
                    sheet = .station(
                        StationCard(
                            station: station,
                            displayName: localization.stationName(
                                station.name, code: station.id),
                            readings: localization.nameReadingsTyped(
                                station.name, code: station.id).map(\.text)))
                }
            default: break
            }
        }
        // The layer switches, which otherwise need a finger on a checkbox.
        // Same reason as `RAILMAP_UI_TEST_SHEET`: what a filter DOES is only
        // reviewable by turning it off and looking at the map, and a `simctl`
        // harness cannot turn anything off. Names the switches to clear, so
        // `routes,metro` draws the dots without their lines and drops every
        // 地下鐵 stretch.
        // At first appearance rather than when the map is ready: these are
        // the state a reader would have set BEFORE loading anything, and
        // turning 自動縮放 on after a journey is already selected correctly
        // moves nothing — a switch is not a command to jump.
        .task {
            guard let wanted = ProcessInfo.processInfo
                .environment["RAILMAP_UI_TEST_LAYERS"]
            else { return }
            for key in wanted.split(separator: ",").map(String.init) {
                switch key {
                case "routes": controller.layers.routes = false
                case "stops": controller.layers.stops = false
                case "terminals": controller.layers.terminals = false
                case "pass": controller.layers.passThrough = false
                case "hsr": controller.layers.categories.hsr = false
                case "jr": controller.layers.categories.jr = false
                case "metro": controller.layers.categories.metro = false
                case "priv": controller.layers.categories.priv = false
                case "network": controller.showsNetwork = true
                // Not a layer, but the same problem: 自動縮放 is a stored
                // preference with a switch in the date menu, and a harness
                // cannot open a menu either. Without it every screenshot of
                // the map is taken from the launch camera, which frames five
                // countries and shows a journey as four pixels.
                case "focus": autoFocusZoom = true
                default: break
                }
            }
        }
        // The ambiguous-tap chooser, which otherwise needs a finger landing
        // within 18 points of two rides at once. The list it shows is built
        // the same way a real tap builds it — see `RideTapResolver`, whose
        // arithmetic is unit-tested; this only reaches the dialog.
        .task(id: "\(itineraries.loaded?.trains.count ?? -1)") {
            guard let count = ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_CHOOSER"]
                .flatMap(Int.init), let trains = itineraries.loaded?.trains, trains.count >= count
            else { return }
            try? await Task.sleep(for: .milliseconds(1200))
            dialog = .choose(Array(trains.prefix(count)))
        }
        .task(id: "\(itineraries.loaded?.trains.count ?? -1)") {
            guard itineraries.loaded != nil,
                  let wanted = ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_SAMPLE"],
                  let sample = RideLibrary.Sample.all.first(where: { $0.resource == wanted }),
                  let incoming = try? library.sample(sample.resource) else { return }
            await itineraries.merge(incoming, into: library)
        }
#if DEBUG
        // What the reader would have typed into the search field.
        //
        // Same reason as every other hook in this block: a `simctl` harness
        // cannot type any more than it can tap, so without this the Search
        // destination is only ever reviewable in its EMPTY state — which is
        // exactly how it shipped with no field on it at all and nothing
        // noticed. The results state is now reachable from a screenshot run.
        .task {
            guard let wanted = ProcessInfo.processInfo
                .environment["RAILMAP_UI_TEST_QUERY"], !wanted.isEmpty
            else { return }
            query = wanted
        }
#endif
        .task(id: "\(riddenRoutes.rides.count)|\(controller.isMapReady)") {
            guard !didRunDebugPlayback,
                  ProcessInfo.processInfo.environment["RAILMAP_UI_TEST_PLAYBACK"] == "1",
                  controller.isMapReady, !riddenRoutes.rides.isEmpty,
                  let train = itineraries.loaded?.trains.first(where: {
                      rideIDs.contains($0.id)
                  }) else { return }
            didRunDebugPlayback = true
            try? await Task.sleep(for: .milliseconds(500))
            startPlayback([train])
            // Arming is not running. A harness that stopped at the overview
            // would screenshot a map with no train on it and call that
            // playback, so it presses play the way a reader does — after the
            // opening move has landed.
            try? await Task.sleep(
                for: .milliseconds(Int(Playback.Tuning.overviewMilliseconds) + 200))
            playback.begin()
        }
#endif
    }

    /// Everything this workspace can put OVER itself.
    ///
    /// Applied to the resident sheet's content rather than to the map beneath
    /// it (§9.5.6). A `UIViewController` that is already presenting cannot
    /// present again, and the resident sheet is always presenting — so an
    /// editor attached to the map root would be asking the one controller in
    /// the app that can never take it. Attached here, each of these stacks on
    /// top of the bottom chrome, which is also where the reader asked for it.
    private func withPresentations(_ content: some View) -> some View {
        content
        .alert(
            localization.journeyText("ios.journey.addDateTitle", fallback: "Add a date"),
            isPresented: addDateIsPresented
        ) {
            TextField("YYYY-MM-DD", text: $newManualDate)
            Button(localization.text("ios.cancel", fallback: "Cancel"), role: .cancel) {}
            Button(localization.journeyText("btn.add", fallback: "Add")) { addManualDate() }
                .disabled(Dates.normalizeDateString(newManualDate) == nil)
        } message: {
            Text(
                localization.journeyText(
                    "ios.journey.addDateDetail",
                    fallback: "Create an empty date to add journeys to later."))
        }
        .confirmationDialog(
            confirmationTitle,
            isPresented: confirmationIsPresented,
            titleVisibility: .visible
        ) {
            switch dialog {
            case .some(.delete(let train)):
                Button(
                    localization.countryText("btn.delete", fallback: "Delete"),
                    role: .destructive
                ) {
                    dialog = nil
                    afterPresentationDismisses {
                        let id = train.id
                        if itineraries.selectedTrainID == id {
                            itineraries.selectedTrainID = nil
                        }
                        itineraries.delete(id)
                        persistMine()
                        signal(.deleted)
                    }
                }
            case .some(.choose(let trains)):
                ForEach(trains, id: \.id) { train in
                    Button(chooserLabel(train)) {
                        dialog = nil
                        afterPresentationDismisses { pick(train) }
                    }
                }
            case .some(.addDate), .none:
                EmptyView()
            }
        } message: {
            if case .some(.delete) = dialog {
                // §13.3: say what the action affects before it is taken.
                Text(
                    localization.journeyText(
                        "ios.journey.deleteDetail",
                        fallback: "The journey is removed from the data on this device."))
            }
        }
        .sheet(item: $sheet) { presented in
            presentedSheet(presented)
        }
        // §13.2's harmony rule: the tap has to arrive with the change, so it is
        // driven by the same state the view is drawn from rather than by a
        // timer alongside it.
        .sensoryFeedback(trigger: feedback) { _, value in
            switch value?.kind {
            case .saved: .success
            case .deleted: .warning
            case .settled: .impact(flexibility: .soft)
            case nil: nil
            }
        }
        // The sheet settling on a stop. Not while it is dragged — that would be
        // a buzz following the finger; only on the value the system commits to.
        .onChange(of: stageSelection) { _, _ in signal(.settled) }
        .onDisappear {
            // The RECORDING cannot survive this: it captures the map view this
            // workspace owns, and a `MKMapView` that has left the screen
            // renders nothing worth writing to a file. `clearPlayback: false`
            // is what keeps the run itself going while the file is abandoned.
            videoExporter.cancel(clearPlayback: false)
            // The PLAYBACK deliberately does not stop here. §5.3.5 gives
            // Passport its own replay entry point over the same transport, and
            // the shell holds one `PlaybackController` for the whole app for
            // exactly that reason — so stopping it because a tab went off
            // screen would mean a run started in Journeys dying the moment the
            // reader opened Passport to watch it. A `TabView` calls
            // `onDisappear` on every tab switch, so this line was doing that
            // on each one. Stopping is a thing the reader asks for, from the
            // transport controls, in any workspace.
        }
    }

    private var addDateIsPresented: Binding<Bool> {
        Binding(
            get: {
                if case .some(.addDate) = dialog { return true }
                return false
            },
            set: { presented in
                if !presented, case .some(.addDate) = dialog { dialog = nil }
            })
    }

    private var confirmationIsPresented: Binding<Bool> {
        Binding(
            get: {
                switch dialog {
                case .some(.delete), .some(.choose): true
                case .some(.addDate), .none: false
                }
            },
            set: { presented in
                guard !presented else { return }
                switch dialog {
                case .some(.delete), .some(.choose): dialog = nil
                case .some(.addDate), .none: break
                }
            })
    }

    private var confirmationTitle: String {
        switch dialog {
        case .some(.delete(let train)):
            localization.journeyText(
                "ios.journey.deleteConfirm",
                ["train": .string(train.number)],
                fallback: "Delete {train}?")
        case .some(.choose):
            localization.countryText("choose.overlap", fallback: "Which journey?")
        case .some(.addDate), .none:
            ""
        }
    }

    /// Menu, context-menu, and alert action callbacks run before UIKit has
    /// finished dismissing their presentation controller. Mutating the map or
    /// opening another sheet in that callback refreshes this host while its
    /// alert is still visible. Publish the next state after that transition.
    private func afterPresentationDismisses(_ action: @escaping @MainActor () -> Void) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            action()
        }
    }

    /// Everything the workspace can present, by case.
    @ViewBuilder
    private func presentedSheet(_ presented: RidesSheet) -> some View {
        Group {
            switch presented {
            case .newJourney(let draft):
                RideEditorView(
                    train: draft,
                    title: localization.text("ios.editorTitleNew", fallback: "New")
                ) { added in
                    // §8.2: saving selects the new journey, so the route state
                    // that follows is reported in its own Hero.
                    if let id = itineraries.add(added) {
                        itineraries.selectedTrainID = id
                    }
                    persistMine()
                    signal(.saved)
                    sheet = nil
                }
            case .edit(let train):
                RideEditorView(
                    train: train,
                    title: localization.text("ios.edit", fallback: "Edit")
                ) { edited in
                    itineraries.replace(edited, replacing: train.id)
                    persistMine()
                    sheet = nil
                }
            case .videoOptions:
                VideoExportOptionsView(
                    settings: videoSettings,
                    sourceSize: controller.mapView?.bounds.size ?? .zero,
                    displayScale: controller.mapView?.window?.screen.scale ?? 3,
                    seconds: videoPlanSeconds
                ) {
                    sheet = nil
                    startVideoExport()
                }
            case .detail(let train):
                // §3.1: L4 metadata lives on a second surface, not in the Hero.
                NavigationStack {
                    RideDetailView(
                        train: train,
                        onSave: { edited in
                            itineraries.replace(edited, replacing: train.id)
                            persistMine()
                        },
                        onRebuild: { rebuildRoute(train) })
                    .toolbar {
                        // §14.4: a modal must be closable without a swipe, or
                        // Switch Control and keyboard readers cannot leave it.
                        ToolbarItem(placement: .cancellationAction) {
                            Button(localization.text("ios.cancel", fallback: "Cancel")) {
                                sheet = nil
                            }
                        }
                    }
                }
            case .importData:
                DataImportView(
                    flow: importFlow, itineraries: itineraries,
                    library: library)
            // §4.2: the map is the spatial context every destination shares,
            // and these three are the sheets ABOUT the map — so they are the
            // three that must not cover all of it. A legend that hides the
            // legend's subject, a layer switch whose effect is off screen, and
            // above all a station card that covers the station the reader just
            // tapped, are each a surface arguing with the thing it explains.
            //
            // Their detents are declared by the VIEWS, not here, which is the
            // pattern `VideoExportOptionsView` already set: a sheet knows what
            // shape it needs, and stating it at the presenter as well is a
            // second copy to keep in step. See each view's own
            // `presentationDetents`.
            case .mapInfo:
                MapInfoView()
            case .mapLayers:
                MapLayersView(controller: controller, classifying: categoryIndexesBuilding)
            case .station(let card):
                StationCardView(card: card)
            case .utility(let destination):
                UtilityDestinationView(
                    destination: destination,
                    itineraries: itineraries,
                    library: library,
                    appearance: $appearance,
                    network: store,
                    controller: controller)
            }
        }
        // One surface for every sheet this workspace presents (§14.2, §6.5).
        //
        // Four of them did not set this and therefore took the system default,
        // which on iOS 26 is Liquid Glass — and then drew a `List` whose rows
        // add their own translucent grouped background on top. The legend, the
        // layer switches and the station card were light glass over light
        // glass over a moving map, which is the one stacking §6.5 rules out
        // ("内容层不得另叠一块相同强度的大玻璃") and the reason their body copy
        // sat on whatever terrain the reader had panned under it.
        //
        // The argument for the resident panel being opaque is in
        // `RailSheetBackground`, and it is the same argument: these are places
        // the reader READS. Applied here rather than in each view because the
        // four that were wrong were wrong by omission, and an omission is not
        // fixed by asking four more views to remember.
        .presentationBackground(Color.railMenuPresentationStyle)
    }

    // MARK: - the map, and the resident sheet over it (§9.5.6)

    /// The whole compact interface: one map, and one sheet that never closes.
    ///
    /// The map is the ROOT, not a tab's content — every destination shares it
    /// (§4.2), which is why there is no map inside any of the panels any more.
    /// Everything else the reader touches lives in the sheet: the three
    /// destinations, the destination selector and the `+`.
    private func mapLayout(in geometry: GeometryProxy) -> some View {
        let metrics = chromeMetrics(in: geometry)
        // Two heights, and they are NOT interchangeable.
        //
        // The live preference is measured inside the sheet and comes back in
        // the DETENT's own units: at `.height(134)` it reads 134 exactly
        // (measured on an iPhone 17 Pro), because the system adds the bottom
        // safe area to a height detent itself rather than taking it out of
        // one. So `sheetHeight` is directly comparable to `metrics.compact`
        // and `metrics.medium`, and `sheetFrame` — the strip the sheet
        // actually covers in the window — is that plus the home indicator.
        //
        // Use the frame for anything positioned against the WINDOW, and the
        // content height for anything interpolated between two DETENTS.
        let sheetFrame = sheetHeight > 0
            ? sheetHeight + geometry.safeAreaInsets.bottom
            : metrics.compact
        // The stage is the SECOND kind, not the first, and it used to be given
        // the first.
        //
        // `BottomChromeMetrics.stage(nearest:)` picks the closest of `compact`,
        // `medium` and `screenHeight`, and all three of those are detent
        // heights. Handing it `sheetFrame` — one home indicator taller —
        // therefore moved every crossover down by 34 points: measured on an
        // iPhone 17 Pro, the panel became `.medium` at 243 pt, where
        // `headerExpansion` reads 0.387. So one drag ran the header's morph on
        // one clock and the things keyed off the STAGE — the destination's
        // content mounting, the title's wording over a selected journey, the
        // Docked action row, Reduce Motion's whole named-state swap — on
        // another, a third of the way out of step. Both now measure against the
        // same stops, and the stage changes where the morph is half done.
        let stage = chromeStage(metrics, contentHeight: sheetHeight)
        // §9.5.6's header morph is one of the second kind: it runs from the
        // compact detent to the medium one, so it has to be fed the same units
        // those two are written in. It used to take `sheetFrame`, which is one
        // home indicator taller, and the compact stop therefore reported
        // itself 12 % expanded instead of 0 (measured 0.122). The panel never
        // reached its own collapsed state: the title drew 1.5 pt too large,
        // and the subtitle — `opacity(0.122)`, height `16 × 0.122 ≈ 2 pt`,
        // `.clipped()` — left the smear of clipped glyph tops under the title
        // that §14.1 names outright ("没有标题、正文、残影或多余空白").
        let headerExpansion = metrics.headerExpansionProgress(
            for: sheetHeight > 0 ? sheetHeight : metrics.compact)
        // The gap between the map's controls and the top of the sheet, and it
        // is CONSTANT for the whole drag.
        //
        // This used to be `min(sheetFrame, metrics.medium) + 12`, which held 12
        // pt only while the sheet was at or below Half. Past Half the lift
        // stopped following and the gap became `medium + 12 − sheetFrame` — it
        // closed, hit zero, and then the panel slid up over the rail, so the
        // last thing a reader saw before the controls vanished was the sheet
        // eating them from below.
        //
        // The clamp was there to stop the rail being pushed off the top of the
        // window. That is a real hazard, but it is the wrong instrument for it:
        // holding the rail still while the sheet keeps moving is a visible
        // collision, and the reader is dragging at the time. ``railFade``
        // answers the hazard instead, by taking the rail away before it can be
        // sliced by the status bar.
        let lift = sheetFrame + 12
        // How present the rail is, as the sheet rises past Half.
        //
        // The rail keeps a constant gap, so past a certain height its own top
        // leaves the safe area. `railHeight` is measured rather than assumed —
        // the compass comes and goes with the map's heading, which is 52 pt of
        // difference — and the fade runs over the 60 pt before the cut, so the
        // controls are gone by the time they would be clipped rather than
        // half-drawn under the clock.
        //
        // Everything here is expressed as a distance UP FROM THE WINDOW'S
        // BOTTOM, which is the one convention `lift` is in, because mixing the
        // two heights this file warns about is exactly how this went wrong the
        // first time: `metrics.medium` is a detent height and excludes the home
        // indicator, `sheetFrame` includes it, and `geometry.size.height` is
        // the SAFE-AREA height rather than the window's. Written against the
        // root proxy's own units, the fade read 0.88 at the Half stop — the
        // rail was permanently, slightly dimmed at the stop the app opens on.
        //
        // `railCeiling` is therefore the safe area's TOP edge measured from the
        // window's bottom, and the fade is keyed to how far the sheet has risen
        // ABOVE Half rather than to an absolute height. That makes "fully
        // opaque at and below Half" true by construction instead of true by
        // arithmetic that has to be re-derived on every device.
        let railCeiling = geometry.size.height + geometry.safeAreaInsets.bottom
        let mediumFrame = metrics.medium + geometry.safeAreaInsets.bottom
        let above = max(0, sheetFrame - mediumFrame)
        let headroom = max(0, railCeiling - (mediumFrame + 12 + railHeight))
        let railFade: Double = above <= headroom
            ? 1
            : Double(1 - min((above - headroom) / 60, 1))
        // Whether the rail is on screen AT ALL, as opposed to merely faded.
        //
        // Both halves matter and neither implies the other: `.expanded` is the
        // outright removal §4.3 asks for, and `railFade == 0` is the same
        // question asked of the drag that has not settled yet — the rail is
        // already invisible and already above the window by then. Anything
        // this is false for is not drawn, not hit-testable and not in the
        // accessibility tree; see the note on `.opacity` below for why the
        // last of those is not optional.
        let railPresent = stage != .expanded && railFade > 0
        return ZStack(alignment: .bottomTrailing) {
            map
            playbackBar
                .padding(.horizontal, 12)
                // Visual translation instead of animated bottom padding: the
                // bar follows the same live edge without invalidating layout on
                // every frame of the system sheet gesture.
                .offset(y: -lift)
                // §9.2's default spring: the transport arrives because the
                // reader pressed play, not because they threw it, so damping
                // is 1.0 and there is no overshoot.
                .railAnimation(
                    RailMotion.spring, value: showsPlaybackBar,
                    reduceMotion: reduceMotion)
            // No artificial upper viewport. The previous medium-detent band
            // kept this rail inside a ScrollView whose top edge permanently
            // clipped/faded the first control on some phone heights. The rail
            // still clears the live sheet through `lift`; above that it draws
            // as one uninterrupted control group.
            controlStack()
                .padding(.trailing, 12)
                // Measured, not computed: `MapControlBar` has a conditional
                // compass and its contents have changed twice. A constant here
                // would be a stale constant.
                .background {
                    GeometryReader { rail in
                        Color.clear.preference(
                            key: RailControlHeightKey.self, value: rail.size.height)
                    }
                }
                .offset(y: -lift)
                // §4.3: a control the sheet is about to cover is removed, not
                // left looking pressable under an opaque surface. `railFade`
                // also takes it away before the constant gap can push it under
                // the status bar; `.expanded` remains an outright zero so the
                // full-screen panel never leaves a ghost behind it.
                //
                // Opacity is not enough on its own, and this is the half the
                // constant gap made necessary. The old clamped lift left the
                // rail parked at the Half height, so a zero-opacity rail was
                // still sitting where it had always been; now it keeps rising
                // with the sheet, and at Full it is a hundred and sixty points
                // ABOVE the top of the window. A `.opacity(0)` view is still in
                // the accessibility tree and still hit-testable — VoiceOver
                // reached an invisible off-screen 列車経路 button and could not
                // scroll it into view, which is how the UI test found this.
                .opacity(railPresent ? railFade : 0)
                .allowsHitTesting(railPresent)
                .accessibilityHidden(!railPresent)
        }
        .ignoresSafeArea()
        .onPreferenceChange(RailControlHeightKey.self) { height in
            // Guarded: the rail republishes the same height on every layout
            // pass, and writing it back unconditionally would invalidate the
            // body that measured it once per frame of the sheet drag.
            if abs(height - railHeight) > 0.5 { railHeight = height }
        }
        // What the sheet is covering, so "frame this" lands in the strip the
        // reader can actually see rather than behind the panel.
        .onChange(of: sheetHeight) { _, height in
            controller.bottomObstruction = height + geometry.safeAreaInsets.bottom
        }
        .residentBottomSheet(
            metrics: metrics,
            detent: detentBinding(metrics),
            liveHeight: $sheetHeight
        ) {
            withPresentations(workspaceTabs(
                stage: stage,
                headerExpansion: headerExpansion))
        }
    }

    /// The detents, for this window AND this text size.
    private func chromeMetrics(in geometry: GeometryProxy) -> BottomChromeMetrics {
        BottomChromeMetrics(
            screenHeight: geometry.size.height,
            // The tab bar's band does not scale; the title row over it does.
            compactRow: BottomChromeMetrics.compactTabBand + compactHeaderRows,
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize)
    }

    /// Where the sheet is NOW, from its live height rather than from the bound
    /// detent — §9.5.5 point 6. The binding only changes once the sheet has
    /// settled, so content keyed off it changes a beat after the finger.
    private func chromeStage(
        _ metrics: BottomChromeMetrics, contentHeight: CGFloat
    ) -> SheetStage {
        guard sheetHeight > 0 else { return stageSelection }
        return metrics.stage(nearest: contentHeight)
    }

    /// The bound detent, derived from the stage rather than stored.
    ///
    /// Two of the three detents are `.height()` values computed from the
    /// window, so a STORED detent is a number from whatever the window used to
    /// be — and a detent that is not in the set the sheet was handed is one
    /// SwiftUI quietly replaces with another. Deriving it means the binding is
    /// always a member of `metrics.detents`, at every window size, including
    /// the frame after a rotation.
    private func detentBinding(_ metrics: BottomChromeMetrics) -> Binding<PresentationDetent> {
        Binding(
            get: {
                // Through `available(_:)`: at an accessibility text size there
                // is no half stop, and handing the sheet a detent that is not
                // in the set it was given is one SwiftUI quietly replaces —
                // with no way for this binding to learn what it picked.
                switch metrics.available(stageSelection) {
                case .compact: metrics.compactDetent
                case .medium: metrics.mediumDetent
                case .expanded: .large
                }
            },
            set: { chosen in
                if chosen == .large { stageSelection = .expanded }
                else if chosen == metrics.compactDetent { stageSelection = .compact }
                else { stageSelection = .medium }
            })
    }

    // MARK: - system destinations (§2.2, revised)

    /// The system owns the bottom row. On iOS 26 and later the semantic Search
    /// role is automatically separated onto its own trailing Liquid Glass
    /// circle; the three ordinary destinations share the main capsule.
    @ViewBuilder
    private func workspaceTabs(
        stage: SheetStage,
        headerExpansion: CGFloat
    ) -> some View {
        if #available(iOS 18.0, *) {
            modernWorkspaceTabs(stage: stage, headerExpansion: headerExpansion)
        } else {
            legacyWorkspaceTabs(stage: stage, headerExpansion: headerExpansion)
        }
    }

    @available(iOS 18.0, *)
    private func modernWorkspaceTabs(
        stage: SheetStage,
        headerExpansion: CGFloat
    ) -> some View {
        TabView(selection: $selection) {
            Tab(
                tabTitle(.upcoming), systemImage: PrimaryTab.upcoming.systemImage,
                value: PrimaryTab.upcoming
            ) {
                tabPage(.upcoming, stage: stage, headerExpansion: headerExpansion) {
                    upcomingPanel
                }
            }

            Tab(
                tabTitle(.stats), systemImage: PrimaryTab.stats.systemImage,
                value: PrimaryTab.stats
            ) {
                tabPage(.stats, stage: stage, headerExpansion: headerExpansion) {
                    statisticsPanel
                }
            }

            Tab(
                tabTitle(.all), systemImage: PrimaryTab.all.systemImage,
                value: PrimaryTab.all
            ) {
                tabPage(.all, stage: stage, headerExpansion: headerExpansion) {
                    allJourneysPanel(stage: stage, expansion: headerExpansion)
                }
            }

            // Titled, like the other three, rather than left to the role's own
            // label. A `Tab(value:role:)` with no title is named by SwiftUI,
            // and SwiftUI names it in the BUNDLE's language — so the tab bar
            // read 今後の行程 / 統計 / すべての行程 / "Search", the one word on
            // the bar that ignored the in-app language switch. The role is
            // still declared, so it keeps its trailing search surface.
            Tab(
                tabTitle(.search), systemImage: PrimaryTab.search.systemImage,
                value: PrimaryTab.search, role: .search
            ) {
                tabPage(.search, stage: stage, headerExpansion: headerExpansion) {
                    searchPanel
                }
            }
        }
        // No `.searchable` here any more. It presented nothing: the semantic
        // Search role shows its field by morphing the tab bar, and
        // `railPersistentTabBar()` on the next line switches that morph off so
        // the bar stays continuous across the three stops (§14.3). The field
        // is drawn by `searchPanel` instead, on every OS version this app
        // deploys to. `railSearchFocused` went with it — ⌘F now moves focus to
        // that field directly, through the same `searchFocused` binding.
        .railPersistentTabBar()
        .modifier(SystemSheetTabSurface())
        // The visible titles are already resolved through AppLocalization,
        // but the system tab bar also owns selection/accessibility wording.
        // Keep that system-owned part in the same in-app language too.
        .environment(\.locale, localization.locale)
    }

    /// The app still deploys to iOS 17. It receives the same four semantic
    /// destinations through the old system TabView spelling; iOS 26+ is the
    /// path that gets the separately rendered Search role.
    private func legacyWorkspaceTabs(
        stage: SheetStage,
        headerExpansion: CGFloat
    ) -> some View {
        TabView(selection: $selection) {
            tabPage(.upcoming, stage: stage, headerExpansion: headerExpansion) {
                upcomingPanel
            }
                .tabItem { Label(tabTitle(.upcoming), systemImage: PrimaryTab.upcoming.systemImage) }
                .tag(PrimaryTab.upcoming)

            tabPage(.stats, stage: stage, headerExpansion: headerExpansion) {
                statisticsPanel
            }
                .tabItem { Label(tabTitle(.stats), systemImage: PrimaryTab.stats.systemImage) }
                .tag(PrimaryTab.stats)

            tabPage(.all, stage: stage, headerExpansion: headerExpansion) {
                allJourneysPanel(stage: stage, expansion: headerExpansion)
            }
                .tabItem { Label(tabTitle(.all), systemImage: PrimaryTab.all.systemImage) }
                .tag(PrimaryTab.all)

            tabPage(.search, stage: stage, headerExpansion: headerExpansion) {
                searchPanel
            }
                // Same as the iOS 18+ path above: the field belongs to
                // `searchPanel`. This `.searchable` had even less to give —
                // there is no search role before iOS 26 to hand it to.
                .tabItem { Label(tabTitle(.search), systemImage: PrimaryTab.search.systemImage) }
                .tag(PrimaryTab.search)
        }
        .modifier(SystemSheetTabSurface())
        .environment(\.locale, localization.locale)
    }

    private func tabPage<Content: View>(
        _ tab: PrimaryTab,
        stage: SheetStage,
        headerExpansion: CGFloat,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        VStack(spacing: 0) {
            PanelHeader(
                title: panelTitle(for: tab, stage: stage),
                subtitle: panelSubtitle(for: tab),
                stage: stage,
                expansionProgress: headerExpansion
            ) {
                panelActions(for: tab, stage: stage)
            }
            .layoutPriority(1)

            if stage != .compact {
                // Runs UNDER the tab bar, not up to it.
                //
                // iOS 26's bottom bar is a floating glass capsule, and the
                // rule that comes with it is that scrolling content passes
                // beneath it and is dimmed by the scroll edge effect — the bar
                // is a layer over the content, not the end of it.
                //
                // A scroll view does all of that by itself when it is the
                // thing holding the safe area: it draws through the inset and
                // adds the same inset to its CONTENT, so rows pass under the
                // glass and the last one still scrolls clear of it. What broke
                // it was the wrapper that used to be here — a `GeometryReader`
                // plus `.clipped()`, which took the safe area for itself, left
                // the list a region ending at the top of the bar, and then cut
                // every row along that line.
                //
                // Handing the region straight to `content()` is the fix, and
                // the reason there is no `ignoresSafeArea` here: that would
                // extend the drawing but take the content inset away with it,
                // trading a clipped last row for one parked under the glass
                // that cannot be scrolled out.
                content()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
        }
    }

    private func tabTitle(_ tab: PrimaryTab) -> String {
        localization.text(tab.tabLocalizationKey, fallback: tab.tabFallbackName)
    }

    /// §5.1's list, and §5.2's journey card, as one surface with two layers.
    private func allJourneysPanel(stage: SheetStage, expansion: CGFloat) -> some View {
        ZStack(alignment: .top) {
            ridesList
                .residentLayer(isTop: panelRoute.isHome)
            // The card's header morphs against the SAME live number the panel
            // header does, so one drag moves both on one clock. See
            // `RideCard.expansionProgress`.
            rideHero(stage: stage, expansion: expansion)
                .residentLayer(isTop: !panelRoute.isHome)
        }
    }

    /// §5.3's Passport, by its plainer name. The coverage map it used to draw
    /// inside itself is the root map now — one basemap for all three
    /// destinations, which is what stopped this screen from being a second
    /// `MKMapView` over the first one.
    /// The journeys the statistics destination is reporting on.
    ///
    /// The same two filters `PassportWorkspaceView` applies, spelled here as
    /// well because the map is outside that view now — and derived from the
    /// same two values, so the two cannot disagree about what is in scope.
    private var statisticsScopedTrains: [Train] {
        let trains = itineraries.loaded?.trains ?? []
        return trains.filter { train in
            if let statisticsRegion, Region.resolved(train) != statisticsRegion {
                return false
            }
            guard statistics.selectedDate != Dates.allDates else { return true }
            return Dates.trainSpans(train.forDates, date: statistics.selectedDate)
        }
    }

    private func openData() {
        afterPresentationDismisses { sheet = .utility(.data) }
    }

    private func openSettings() {
        afterPresentationDismisses { sheet = .utility(.settings) }
    }

    private var statisticsPanel: some View {
        PassportWorkspaceView(
            itineraries: itineraries,
            library: library,
            statistics: statistics,
            riddenRoutes: riddenRoutes,
            network: store,
            controller: controller,
            playback: playback,
            region: $statisticsRegion,
            openData: openData,
            openSettings: openSettings)
    }

    // MARK: - the panel header (§9.5.6: 左上大标题, 右上功能按钮)

    /// The panel's title, which at the smallest stop is not always the
    /// destination's name.
    ///
    /// §5.1.2 keeps the selected journey's Hero for Half and above — Docked
    /// gets "缩小标题行" — but a reduced title row still has to answer that
    /// section's own main question, 「这趟车从哪里到哪里，地图上是哪一条？」.
    /// Collapsed, this row was reading 「現在の行程」: the name of the STATE,
    /// not of the journey, while the one line that named the journey was the
    /// subtitle, which `PanelHeader` correctly fades out at that stop. So the
    /// panel could be collapsed over a route drawn on the map with nothing on
    /// screen saying which route it was.
    ///
    /// At Docked the row therefore carries the train, and at the two open
    /// stops it goes back to naming the state — because there the card below
    /// is already spelling the number, the endpoints and the times in full,
    /// and two headings saying the same thing is what §3.2 calls competing for
    /// the same level.
    private func panelTitle(for tab: PrimaryTab, stage: SheetStage) -> String {
        switch tab {
        case .upcoming:
            localization.text("nav.upcoming", fallback: "Upcoming")
        case .stats:
            localization.text("nav.stats", fallback: "Stats")
        case .all:
            if let train = selectedTrain {
                stage == .compact
                    ? train.number
                    : localization.text("ios.currentJourney", fallback: "Current journey")
            } else {
                localization.text("nav.allJourneys", fallback: "All journeys")
            }
        case .search:
            localization.countryText("sec.search", fallback: "Search & Add")
        }
    }

    private func panelSubtitle(for tab: PrimaryTab) -> String? {
        switch tab {
        case .upcoming:
            guard let count = upcomingCount else { return nil }
            return localization.journeyText(
                "ios.journey.daySummary", ["journeys": .number(Double(count))],
                fallback: "{journeys} journeys")
        case .stats:
            // Nothing. §5.3.1's Scope is the pair of capsules in the action
            // row beside this title — always visible, at every sheet stop —
            // and the subtitle used to spell the date one of them already
            // states. One value, one place it is written.
            return nil
        case .all:
            if let train = selectedTrain {
                let endpoints = [
                    localization.stationName(train.origin),
                    localization.stationName(train.destination),
                ]
                .filter { !$0.isEmpty }
                .joined(separator: " → ")
                let departure = train.stops.first?.departure ?? train.stops.first?.arrival
                let arrival = train.stops.last?.arrival ?? train.stops.last?.departure
                let times = [departure, arrival]
                    .compactMap { time in
                        guard let time, !time.isEmpty else { return nil }
                        return time
                    }
                    .joined(separator: "—")
                return [endpoints, times]
                    .filter { !$0.isEmpty }
                    .joined(separator: " · ")
            }
            // The FILTERED counts, not the store's: this line is now the
            // list's own summary row (§5.1), which the search field and the
            // date filter both narrow. A header that kept saying "231
            // journeys" over four search results would be describing a list
            // that is not on screen.
            guard let loaded = itineraries.loaded else { return nil }
            let days = filteredDays(loaded)
            let journeys = days.reduce(0) { $0 + $1.trains.count }
            return selectedDate == Dates.allDates
                ? localization.journeyText(
                    "ios.journey.listSummary",
                    [
                        "journeys": .number(Double(journeys)),
                        "days": .number(Double(days.count)),
                    ],
                    fallback: "{journeys} journeys · {days} days")
                : localization.journeyText(
                    "ios.journey.daySummary",
                    ["journeys": .number(Double(journeys))],
                    fallback: "{journeys} journeys")
        case .search:
            let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !needle.isEmpty, let loaded = itineraries.loaded else { return nil }
            let journeys = filteredDays(loaded, query: needle)
                .reduce(0) { $0 + $1.trains.count }
            return localization.journeyText(
                "ios.journey.daySummary",
                ["journeys": .number(Double(journeys))],
                fallback: "{journeys} journeys")
        }
    }

    /// The function buttons, top right.
    ///
    /// Two of them, at every destination and in the same order: what this
    /// destination can do, and the Utility entry §4.1 requires in one place on
    /// every surface. Anything a destination needs beyond that goes in the
    /// first menu rather than growing the row — §4.2 forbids a screen that
    /// floats a line of unrelated glyphs.
    @ViewBuilder
    private func panelActions(for tab: PrimaryTab, stage: SheetStage) -> some View {
        // Docked, over a selected journey, this row IS the journey's controls.
        //
        // §5.1.2 holds the Hero back until Half, so at this stop the card's
        // own action group is not on screen — and a panel collapsed over a
        // route the reader is looking at needs the one action the resolver
        // picked for that state, and a way back to the list. Both come from
        // the same `JourneyPresentation` the Hero would have used, so the
        // action here and the action there can never disagree.
        if tab == .all, stage == .compact, let train = selectedTrain {
            let presentation = presentation(for: train)
            if let primary = presentation.primaryAction {
                let appearance = primary.appearance(localization)
                SheetIconButton(
                    systemImage: appearance.systemImage,
                    accessibilityLabel: Text(appearance.label),
                    action: { perform(primary, on: train) }
                )
            }
            SheetIconButton(
                systemImage: "xmark",
                accessibilityLabel: Text(
                    localization.journeyText(
                        "ios.journey.backToList", fallback: "Back to the list"))
            ) {
                itineraries.selectedTrainID = nil
            }
        }
        // The list's transport, and ONLY while the list is what is on screen.
        //
        // With a journey selected there were two play buttons a thumb's width
        // apart — this one and the card's own — and both played the same
        // journey. §16's mapping rule: a control belongs beside what it
        // affects, and one action must not have two entries in one state. So
        // the scope is split by state rather than duplicated: selected, the
        // CARD owns playing that journey; back at the list, this one returns
        // and plays the queue the list defines.
        if tab == .all, panelRoute.isHome {
            playbackButton
        }
        if tab == .stats {
            dateScopeMenu
            regionMenu
        }
        if tab == .search {
            SheetIconButton(
                systemImage: "plus",
                accessibilityLabel: Text(
                    localization.text("ios.newJourney", fallback: "New journey"))
            ) {
                sheet = .newJourney(newJourneyScaffold(in: defaultRegion))
            }
        }
        Menu {
            destinationMenu(for: tab)
        } label: {
            // A gear, not a second ellipsis.
            //
            // This is the GLOBAL entry — Data Library, Settings, the date
            // filter — and the journey card below carries its own ellipsis for
            // that journey's secondary actions. Two identical glyphs on one
            // screen with two different scopes is precisely the ambiguity §16
            // calls a weak mapping: the reader cannot tell which "more" they
            // are about to open, and the label that would explain it is not
            // drawn. A gear says "this app's settings" without being read.
            SheetIconLabel(systemImage: "gearshape")
        }
        .accessibilityLabel(
            Text(localization.text("nav.utilities", fallback: "Data and settings")))
        // The label is the READER's language, so it is not an address. A UI
        // test that looked this control up by "Data and settings" found
        // nothing on a Japanese simulator and reported the utility menu
        // unreachable — which is the same trap `MapControlBar`'s controls were
        // pulled out of. Identifiers are language-independent; labels are for
        // people.
        .accessibilityIdentifier("utilityMenuButton")
    }

    @ViewBuilder
    private func destinationMenu(for tab: PrimaryTab) -> some View {
        if tab == .all || tab == .upcoming || tab == .search {
            if let loaded = itineraries.loaded, !loaded.days.isEmpty {
                dateFilterSection(loaded)
            }
            rideSourceSection
            Divider()
        }
        // Identified for the same reason the gear itself is, and it is the
        // same lesson a third time: `ConsoleSweepTests` looked these two up by
        // the English "Data" and "Settings", found neither on a Chinese
        // simulator, and walked past the Data Library and Settings without
        // failing loudly enough to be noticed — which is precisely the "clean
        // console that is a lie" that suite's own comments warn about.
        Button(action: openData) {
            Label(
                localization.text(
                    UtilityDestination.data.localizationKey,
                    fallback: UtilityDestination.data.fallbackName),
                systemImage: UtilityDestination.data.systemImage)
        }
        .accessibilityIdentifier("utilityDataButton")
        Button(action: openSettings) {
            Label(
                localization.text(
                    UtilityDestination.settings.localizationKey,
                    fallback: UtilityDestination.settings.fallbackName),
                systemImage: UtilityDestination.settings.systemImage)
        }
        .accessibilityIdentifier("utilitySettingsButton")
    }

    /// Move the map to the network the statistics are now reporting on —
    /// or, for 全部, back out to all five of them.
    ///
    /// Framed from the LINES rather than from the rides: the coverage figure
    /// is a fraction of the network, and a reader who has ridden two stations
    /// in Korea is being shown how little of Korea that is.
    private func frameStatisticsRegion(_ region: Region?) {
        let rect = store.lines
            .filter { region == nil || $0.region == region }
            .reduce(MKMapRect.null) { $0.union($1.mapRect) }
        guard !rect.isNull else { return }
        controller.fit(rect)
    }

    /// What the scope control reads, 全部 included.
    private var statisticsRegionName: String {
        guard let statisticsRegion else {
            return localization.text("ios.region.all", fallback: "All regions")
        }
        return localization.text(
            statisticsRegion.localizationKey, fallback: statisticsRegion.fallbackName)
    }

    /// §5.3.1's region scope, in the header rather than in a card.
    ///
    /// It is the only scope the statistics have that the reader chooses, and
    /// §9.5.6 gives every destination one row for exactly that. Labelled with
    /// the region's NAME rather than a glyph: a scope control whose current
    /// value is invisible is a control the reader has to open to read.
    /// §5.3.1's date Scope, in the header row rather than in a card.
    ///
    /// It used to live inside 當日統計, where the numbers it scopes are — a
    /// reasonable place for it while the daily block was its own card. The
    /// daily block is now a stamp inside the passport page, and a control
    /// buried a scroll into the panel cannot be found from the top of it.
    /// Here it is the neighbour of the region capsule, which is the other half
    /// of the same scope, and both are on screen at every sheet stop.
    ///
    /// It changes the statistics only. §5.3.1: "Passport 的日期 Scope 独立于
    /// Journeys 筛选，切换后不扰动旅程列表" — `dateFilterSection` is the other
    /// tabs' filter and is a different value with a different owner.
    private var dateScopeMenu: some View {
        Menu {
            // 全部 first and above a divider, for the same reason the region
            // menu puts it there: it is the absence of a scope, not a date.
            Button {
                statistics.selectDate(Dates.allDates)
            } label: {
                Label(
                    localization.countryText("date.all", fallback: "All dates"),
                    systemImage: statistics.selectedDate == Dates.allDates
                        ? "checkmark" : "calendar")
            }
            Divider()
            ForEach(statisticsDates, id: \.self) { date in
                Button {
                    statistics.selectDate(date)
                } label: {
                    Label(
                        statisticsDateLabel(date),
                        systemImage: date == statistics.selectedDate ? "checkmark" : "calendar")
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "calendar")
                    .font(.caption.weight(.bold))
                Text(statisticsDateLabel(statistics.selectedDate))
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 11)
            .frame(height: SheetIconButton<Image>.visualSide)
            .background(.quaternary.opacity(0.5), in: Capsule())
            .overlay { Capsule().stroke(Color.primary.opacity(0.06), lineWidth: 0.5) }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        // `statsText`, not `text`: the label lives in the statistics screen's
        // own string table, and `text` would have handed VoiceOver the English
        // fallback in every language.
        .accessibilityLabel(Text(localization.statsText("ios.stats.scope")))
        .accessibilityValue(Text(statisticsDateLabel(statistics.selectedDate)))
    }

    /// The days the statistics can be scoped to: this region's, in order.
    ///
    /// Region-filtered but never date-filtered, or choosing a day would empty
    /// the menu that chose it. Same slice `StatisticsDashboardContent.scoped`
    /// takes, so the menu cannot offer a day the numbers have no rides for.
    private var statisticsDates: [String] {
        guard let loaded = itineraries.loaded else { return [] }
        let trains = statisticsRegion.map { region in
            loaded.trains.filter { Region.resolved($0) == region }
        } ?? loaded.trains
        let ids = Set(trains.map(\.id))
        return loaded.days.compactMap { day in
            day.trains.contains { ids.contains($0.id) } ? day.date : nil
        }
    }

    /// `dateLabel` — the two sentinels need a word, a real bucket labels itself.
    private func statisticsDateLabel(_ date: String) -> String {
        let key = Dates.dateLabelKey(date)
        return localization.text(key, fallback: key)
    }

    private var regionMenu: some View {
        Menu {
            // 全部 first, and above a divider: it is not a sixth region, it is
            // the absence of the scope the other five apply.
            Button {
                statisticsRegion = nil
            } label: {
                Label(
                    localization.text("ios.region.all", fallback: "All regions"),
                    systemImage: statisticsRegion == nil ? "checkmark" : "globe.asia.australia")
            }
            Divider()
            ForEach(Region.ordered) { candidate in
                Button {
                    statisticsRegion = candidate
                } label: {
                    Label(
                        localization.text(
                            candidate.localizationKey, fallback: candidate.fallbackName),
                        systemImage: candidate == statisticsRegion ? "checkmark" : "map")
                }
            }
        } label: {
            HStack(spacing: 3) {
                Text(statisticsRegionName)
                .font(.subheadline.weight(.semibold))
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 11)
            .frame(height: SheetIconButton<Image>.visualSide)
            .background(.quaternary.opacity(0.5), in: Capsule())
            .overlay { Capsule().stroke(Color.primary.opacity(0.06), lineWidth: 0.5) }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .accessibilityLabel(Text(localization.text("country.label", fallback: "Region")))
        .accessibilityValue(Text(statisticsRegionName))
    }

    private var playbackButton: some View {
        SheetIconButton(
            systemImage: playback.isActive ? "stop.fill" : "play.fill",
            accessibilityLabel: Text(
                playback.isActive
                    ? localization.countryText("play.stop", fallback: "Stop playback")
                    : localization.countryText("btn.play", fallback: "Play rides"))
        ) {
            if playback.isActive {
                stopPlayback()
            } else {
                startPlayback(playbackScope)
            }
        }
        .disabled(!playback.isActive && playbackScope.isEmpty)
    }

    // MARK: - §5.1 (new): what is coming

    /// The journeys that have not happened yet, soonest first.
    ///
    /// "Not yet" is decided by the date the record carries, not by a live
    /// service: §1.1 forbids implying departures, delays or operation. A dated
    /// record on or after today is upcoming; an undated one is not — it has no
    /// position on a calendar to be ahead of, and putting it here would be
    /// claiming one.
    private var upcomingTrains: [Train] {
        let trains = itineraries.loaded?.trains ?? []
        let today = todayString
        return trains
            .filter { train in
                guard let date = train.date, !date.isEmpty else { return false }
                return date >= today
            }
            .sorted { lhs, rhs in
                let a = lhs.date ?? "", b = rhs.date ?? ""
                return a == b ? lhs.id < rhs.id : a < b
            }
    }

    /// Today, spelled the way a record spells a date.
    ///
    /// Deliberately not in `RailCore`. That module is pure and checked against
    /// recorded fixtures, and a function whose answer depends on when it is
    /// called can be neither — "what is today" is the app's question, not the
    /// ported logic's.
    private var todayString: String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let parts = calendar.dateComponents([.year, .month, .day], from: Date())
        return String(
            format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    private var upcomingCount: Int? {
        guard itineraries.loaded != nil else { return nil }
        return upcomingTrains.count
    }

    @ViewBuilder
    private var upcomingPanel: some View {
        let trains = upcomingTrains
        if trains.isEmpty {
            // §13.1: an empty upcoming list is not a failure and not an empty
            // app — there is a whole log behind the next tab. Say which of the
            // two this is rather than showing a bare "nothing here".
            VStack(spacing: 10) {
                Image(systemName: "calendar")
                    .font(.largeTitle)
                    .foregroundStyle(.tertiary)
                Text(localization.journeyText(
                    "ios.journey.noUpcoming", fallback: "No upcoming journeys."))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button(localization.text("nav.allJourneys", fallback: "All journeys")) {
                    selection = .all
                }
                .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.top, 24)
            // Scrollable so it survives the compact stop and an accessibility
            // text size, where an empty state can be taller than the panel.
            .modifier(ScrollableIfNeeded())
        } else {
            List {
                ForEach(trains, id: \.id) { train in
                    journeyRow(train, showsDate: true)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
    }

    private func groupedByDate(_ trains: [Train]) -> [ItineraryStore.Loaded.Day] {
        var order: [String] = []
        var byDate: [String: [Train]] = [:]
        for train in trains {
            let date = train.date ?? Dates.undated
            if byDate[date] == nil { order.append(date) }
            byDate[date, default: []].append(train)
        }
        return order.map { .init(date: $0, trains: byDate[$0] ?? []) }
    }

    // MARK: - wide windows: a sidebar, on iPad and on a phone in landscape

    private var sidebarLayout: some View {
        HStack(spacing: 0) {
            withPresentations(workspaceTabs(stage: .expanded, headerExpansion: 1))
            // Narrower on a phone, where the map has little enough width as it
            // is; a fixed 320 would eat half of a landscape iPhone.
            .frame(width: horizontalSizeClass == .regular ? 360 : 300)
            // The same opaque reading surface the resident sheet uses, not a
            // material. `RailSheetBackground`'s own note is the argument: the
            // panel is where the reader READS, and a surface that takes its
            // colour from whatever the map happens to be showing gives that
            // text a different background in every part of the country. It
            // applied only to the phone-portrait sheet, so one rotation turned
            // the same workspace from an opaque page into a translucent one.
            .background { RailSheetBackground() }

            Divider()

            ZStack(alignment: .bottomTrailing) {
                map
                controlStack().padding(12)
                playbackBar
                    .padding(12)
                    .railAnimation(
                        RailMotion.spring, value: showsPlaybackBar,
                        reduceMotion: reduceMotion)
            }
        }
        .ignoresSafeArea(edges: .bottom)
    }

    /// Which layer is on top. §4.4: closing a journey is returning to the list,
    /// and it does not clear the date filter.
    private var panelRoute: RideRoute {
        guard let id = itineraries.selectedTrainID, selectedTrain != nil else { return .home }
        return .ride(id)
    }

    private var selectedTrain: Train? {
        guard let id = itineraries.selectedTrainID else { return nil }
        return itineraries.loaded?.trains.first { $0.id == id }
    }

    // MARK: - shared parts

    /// Withheld until the map exists: `MKCompassButton` cannot be built
    /// without an `MKMapView`, and showing the stack without it would leave a
    /// gap that fills in a frame later.
    @ViewBuilder
    private func controlStack() -> some View {
        controlStackBody
    }

    @ViewBuilder
    private var controlStackBody: some View {
        if controller.isMapReady, let mapView = controller.mapView {
            MapControlBar(
                mapView: mapView, controller: controller,
                onLayers: { sheet = .mapLayers },
                onInfo: { sheet = .mapInfo })
            // The native interactive glass grows beyond its resting shape on
            // touch-down. This is drawing room, not a clipping viewport.
            .padding(MapControlBar.interactionBleed)
            // Keep the resting buttons at their original 12 pt screen margin
            // after adding the interaction bleed.
            .offset(x: MapControlBar.interactionBleed)
            .fixedSize(horizontal: true, vertical: false)
        }
    }

    // MARK: - §5.2 the selected journey

    @ViewBuilder
    private func rideHero(stage: SheetStage, expansion: CGFloat) -> some View {
        if let train = selectedTrain {
            let presentation = presentation(for: train)
            RideCard(
                train: train,
                presentation: presentation,
                stage: stage,
                expansionProgress: expansion,
                dateChipTitle: train.date,
                onClose: { itineraries.selectedTrainID = nil },
                onOpenDate: { date in
                    selectedDate = date
                    itineraries.selectedTrainID = nil
                },
                onPrimary: { perform($0, on: train) },
                onSecondary: { perform($0, on: train) }
            )
            .padding(.top, 4)
        }
    }

    /// §11.2's answer for one journey. The only caller of the resolver in the
    /// journey surfaces, so the priority order lives in one tested place.
    private func presentation(for train: Train) -> JourneyPresentation {
        JourneyPresentationResolver.selected(
            train: train,
            route: JourneyBridge.routeState(for: train.id, localization: localization),
            phase: playbackPhase(for: train))
    }

    /// The only sub-phase this workspace can be in for a *single* journey.
    ///
    /// Editing and saving belong to `RideEditorView`, which owns its own draft
    /// and its own atomic commit (§8.3); a failure to load is a workspace
    /// phase, not this journey's. So playback is what is left — and the
    /// resolver still refuses to report it while the route is not resolved.
    private func playbackPhase(for train: Train) -> JourneyWorkspacePhase? {
        guard playback.isActive, playback.currentTrainID == train.id else { return nil }
        return .playing(progress: playback.progress, isPaused: !playback.isPlaying)
    }

    // MARK: - §5.1 the journey list

    /// All Journeys is deliberately unfiltered by the Search destination's
    /// query. A hidden query must never make this list silently incomplete.
    private var ridesList: some View {
        journeyListState(searchQuery: "", groupsByDate: false)
    }

    /// The search destination, and its own field.
    ///
    /// The field is drawn here rather than left to `.searchable`, and that is
    /// the fix rather than a preference. `.searchable` was attached to the
    /// `TabView`, which on iOS 26 hands the field to the semantic Search role —
    /// and the role presents it by MORPHING THE TAB BAR, which this app has
    /// switched off: `railPersistentTabBar()` sets
    /// `tabBarMinimizeBehavior(.never)` so the bar stays positionally
    /// continuous across Docked / Half / Full (§14.3). The two requirements are
    /// in direct conflict, and the bar won, silently — the search destination
    /// shipped with nothing on it that could be typed into, at every stop.
    ///
    /// It was never only an iOS 26 problem, which is what settles the choice:
    /// `legacyWorkspaceTabs` has no search role at all, so on iOS 17–25 the
    /// same `.searchable` had no field to give either. A destination whose
    /// whole job is a query cannot depend on machinery that only one OS
    /// version has and this app has disabled there.
    private var searchPanel: some View {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return VStack(spacing: 0) {
            searchField
            Group {
                if needle.isEmpty {
                    // No action in this empty state any more: the `+` in the
                    // panel header adds a journey, and it is on screen in this
                    // state and in the results state alike. §16's mapping rule
                    // — the same one this file argues for the gear a few
                    // screens up — is that one action does not get two entries
                    // in one state.
                    ContentUnavailableView {
                        Label(
                            localization.countryText("sec.search", fallback: "Search journeys"),
                            systemImage: "magnifyingglass")
                    } description: {
                        Text(localization.countryText(
                            "ph.search", fallback: "Train, station, or identifier"))
                    }
                    .modifier(ScrollableIfNeeded())
                } else {
                    journeyListState(searchQuery: needle)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .background { keyboardShortcuts }
    }

    /// §6.4's `radius-control`, a 44-point row, and the field's own clear
    /// button — the three things that make this read as the system's search
    /// field rather than as a text box that happens to filter a list.
    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField(
                localization.countryText(
                    "ph.search", fallback: "Train, station, or identifier"),
                text: $query)
                .textFieldStyle(.plain)
                .focused($searchFocused)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("journeySearchField")
            if !query.isEmpty {
                Button {
                    query = ""
                    searchFocused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(RailPressStyle(dims: false))
                .accessibilityLabel(
                    Text(localization.text("ios.clear", fallback: "Clear search")))
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .background(
            Color(.tertiarySystemFill),
            in: RoundedRectangle(
                cornerRadius: RailStyle.controlCornerRadius,
                style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
    }

    @ViewBuilder
    private func journeyListState(searchQuery: String, groupsByDate: Bool = true) -> some View {
        switch itineraries.state {
        case .idle, .loading:
            workspaceStatus(JourneyPresentationResolver.workspace(phase: .loading))
        case .failed(let message):
            workspaceUnavailable(
                JourneyPresentationResolver.workspace(phase: .failed(.load(message))),
                systemImage: "exclamationmark.triangle")
        case .loaded(let loaded) where loaded.days.isEmpty:
            workspaceUnavailable(
                JourneyPresentationResolver.workspace(phase: .empty),
                systemImage: "tram",
                description: localization.journeyText(
                    "ios.journey.noRegionRecords",
                    fallback: "This region has a railway package, but no recorded journeys yet."))
        case .loaded(let loaded):
            let days = filteredDays(loaded, query: searchQuery)
            List {
                if groupsByDate {
                    ForEach(days) { day in
                        Section(day.date) {
                            ForEach(day.trains, id: \.id) { train in
                                journeyRow(train)
                            }
                        }
                    }
                } else {
                    ForEach(days.flatMap(\.trains), id: \.id) { train in
                        journeyRow(train, showsDate: selectedDate == Dates.allDates)
                    }
                }
            }
            .listStyle(.plain)
            .listSectionSpacing(.custom(2))
            .scrollContentBackground(.hidden)
            .background { keyboardShortcuts }
            .overlay {
                if days.isEmpty {
                    // §13.1: three empty states, three different single primary
                    // actions — and the search text is kept, not cleared.
                    workspaceUnavailable(
                        JourneyPresentationResolver.workspace(
                            phase: .empty,
                            hasSearchQuery: !searchQuery.isEmpty,
                            hasDateFilter: selectedDate != Dates.allDates),
                        systemImage: "magnifyingglass")
                }
            }
        }
    }

    /// The two shortcuts that have no button of their own (§10.3).
    ///
    /// Zero-opacity buttons rather than commands: `Commands` is a scene-level
    /// macOS concept, and on iPadOS a keyboard shortcut is delivered to a
    /// `Button` in the hierarchy. They are hidden from assistive technology —
    /// a reader using VoiceOver reaches search and the back-step through the
    /// search field and the panel's own close button, not through two unlabelled
    /// controls behind the list.
    @ViewBuilder
    private var keyboardShortcuts: some View {
        Button(localization.countryText("sec.search", fallback: "Search")) {
            selection = .search
            Task { @MainActor in
                await Task.yield()
                searchFocused = true
            }
        }
        .keyboardShortcut("f", modifiers: .command)
        .opacity(0)
        .accessibilityHidden(true)

        // §10.3: Escape steps back one level rather than clearing everything —
        // the same rule as a tap on empty map (§4.4), and the same code.
        Button(localization.text("ios.cancel", fallback: "Cancel")) {
            RailMotion.withoutAnimation { selectFromMap([]) }
        }
        .keyboardShortcut(.escape, modifiers: [])
        .opacity(0)
        .accessibilityHidden(true)

        // ⌘N and Space used to hang off two toolbar items that the panel
        // header replaced (§9.5.6). The buttons moved; the shortcuts are the
        // same two actions and belong wherever the actions are reachable from.
        Button(localization.text("ios.newJourney", fallback: "New journey")) {
            sheet = .newJourney(newJourneyScaffold(in: defaultRegion))
        }
        .keyboardShortcut("n", modifiers: .command)
        .opacity(0)
        .accessibilityHidden(true)

        // Space plays and pauses when focus is not in a text field. SwiftUI
        // withholds a modifier-less shortcut from a focused text field on its
        // own, which is what makes this safe on a key that also types.
        Button(localization.countryText("btn.play", fallback: "Play rides")) {
            RailMotion.withoutAnimation {
                if playback.isActive {
                    stopPlayback()
                } else if !playbackScope.isEmpty {
                    startPlayback(playbackScope)
                }
            }
        }
        .keyboardShortcut(.space, modifiers: [])
        .opacity(0)
        .accessibilityHidden(true)

        // Zoom, which no longer has a button.
        //
        // The rail dropped its ± pair because the rail must show all of itself
        // at Half without scrolling and pinch already covers touch
        // (`MapControlBar`'s note has the argument). Pinch is not available to
        // someone driving this from a keyboard, and §10.3 asks the keyboard to
        // reach the main map operations — so the two controller commands keep a
        // caller here rather than becoming dead code.
        //
        // `.command` with "+" and "-": the plus is typed as `=` on most
        // layouts, so both are bound, which is what every map app that offers
        // ⌘+ actually does.
        Button(localization.text("ios.zoomIn", fallback: "Zoom in")) {
            controller.zoomIn()
        }
        .keyboardShortcut("+", modifiers: .command)
        .opacity(0)
        .accessibilityHidden(true)

        Button(localization.text("ios.zoomIn", fallback: "Zoom in")) {
            controller.zoomIn()
        }
        .keyboardShortcut("=", modifiers: .command)
        .opacity(0)
        .accessibilityHidden(true)

        Button(localization.text("ios.zoomOut", fallback: "Zoom out")) {
            controller.zoomOut()
        }
        .keyboardShortcut("-", modifiers: .command)
        .opacity(0)
        .accessibilityHidden(true)
    }

    private func journeyRow(_ train: Train, showsDate: Bool? = nil) -> some View {
        // A Button rather than a `NavigationLink`: selecting a journey changes
        // which resident layer is on top, and §8.1 wants that reflected in the
        // list AND on the map at once rather than pushing a screen over both.
        Button {
            itineraries.selectedTrainID = train.id
        } label: {
            JourneySummaryRow(
                train: train,
                presentation: presentation(for: train),
                isSelected: itineraries.selectedTrainID == train.id,
                showsDate: showsDate ?? (selectedDate == Dates.allDates))
        }
        // §14.3's first line, on the control this app is tapped through more
        // than any other. `.plain` inside a `List` draws no highlight at all,
        // so selecting a journey used to give nothing back until the store
        // came round and the row's border changed — which is after the finger
        // has already lifted.
        .buttonStyle(RailRowPressStyle())
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 5, leading: 12, bottom: 5, trailing: 12))
        // §5.1: the row does not expose every verb. Swipe and context menu do.
        .contextMenu { rideContextMenu(train) }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) { dialog = .delete(train) } label: {
                Label(
                    localization.countryText("btn.delete", fallback: "Delete"),
                    systemImage: "trash")
            }
            Button {
                itineraries.toggleVisibility(train.id)
                persistMine()
            } label: {
                Label(
                    train.visible == false
                        ? localization.text("ios.showOnMap", fallback: "Show on map")
                        : localization.journeyText(
                            "ios.journey.hideFromMap", fallback: "Hide from map"),
                    systemImage: train.visible == false ? "eye" : "eye.slash"
                )
            }
            // §6.2's allowed roles do not include indigo, and this action is
            // not a state colour anyway: showing or hiding a journey on the map
            // is the tint role — 可点击、选中 — so it takes the app's accent.
            .tint(.accentColor)
        }
    }

    // MARK: - workspace-level states (§13.1, §13.2, §13.3)

    private func workspaceStatus(_ presentation: JourneyPresentation) -> some View {
        VStack(spacing: 10) {
            ProgressView()
            Text(localization.journeyText(presentation.title))
                .font(.headline)
            if let status = presentation.status {
                Text(localization.journeyText(status.title))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    private func workspaceUnavailable(
        _ presentation: JourneyPresentation,
        systemImage: String,
        description: String? = nil
    ) -> some View {
        ContentUnavailableView {
            Label(localization.journeyText(presentation.title), systemImage: systemImage)
        } description: {
            VStack(spacing: 8) {
                if let subtitle = presentation.subtitle {
                    Text(localization.journeyText(subtitle))
                }
                if let description { Text(description) }
                if let status = presentation.status {
                    // §13.3: what was kept, next to what went wrong.
                    Text(localization.journeyText(status.title))
                        .foregroundStyle(status.tone.color)
                }
            }
        } actions: {
            QuietActionGroup(
                presentation: presentation,
                perform: { perform($0, on: nil) },
                performSecondary: { perform($0, on: nil) }
            )
            .frame(maxWidth: 320)
        }
        // §4.1: "按钮、列表最后一行和滚动指示器必须避开底栏". The panel's
        // content region ends where the destination selector begins, and a
        // `ContentUnavailableView` is an inflexible block — at the medium stop
        // its action button was being cut in half by that edge. Scrolling is
        // how a block that cannot shrink gives way.
        .modifier(ScrollableIfNeeded())
    }

    // MARK: - what a resolved action actually does (§8)

    private func perform(_ action: JourneyPresentation.PrimaryAction, on train: Train?) {
        switch action {
        case .add:
            sheet = .newJourney(newJourneyScaffold(in: defaultRegion))
        case .importData:
            sheet = .importData
        case .locate:
            if let train { itineraries.selectedTrainID = train.id }
            controller.fitToSelection()
        case .showOnMap:
            guard let train else { return }
            itineraries.toggleVisibility(train.id)
            persistMine()
        case .rebuildRoute:
            guard let train else { return }
            _ = rebuildRoute(train)
        case .save:
            // §8.3: the draft and its atomic commit belong to the editor.
            if let train { sheet = .edit(train) }
        case .pause, .resume:
            playback.togglePause()
        case .retry:
            itineraries.load(from: library)
        case .clearSearch:
            query = ""
        }
    }

    private func perform(_ action: SecondaryAction, on train: Train?) {
        switch action {
        case .play:
            guard let train else { return }
            startPlayback([train])
        case .stop:
            stopPlayback()
        case .edit:
            if let train { sheet = .edit(train) }
        case .duplicate:
            guard let train else { return }
            itineraries.duplicate(train.id)
            persistMine()
        case .hide, .show:
            guard let train else { return }
            itineraries.toggleVisibility(train.id)
            persistMine()
        case .delete:
            if let train {
                afterPresentationDismisses { dialog = .delete(train) }
            }
        case .inspectDetails:
            if let train { sheet = .detail(train) }
        case .rebuildRoute:
            guard let train else { return }
            _ = rebuildRoute(train)
        case .cancel:
            itineraries.selectedTrainID = nil
        case .importData:
            sheet = .importData
        case .add:
            sheet = .newJourney(newJourneyScaffold(in: defaultRegion))
        }
    }

    /// §8.4: rebuilding regenerates route sections from the stops. It never
    /// deletes the journey, and a section that still cannot be solved stays
    /// undrawn rather than being straightened.
    @discardableResult
    private func rebuildRoute(_ train: Train) -> Int? {
        let count = itineraries.rebuildRouteSections(train.id)
        persistMine()
        return count
    }

    private func filteredDays(
        _ loaded: ItineraryStore.Loaded,
        query searchQuery: String = ""
    ) -> [ItineraryStore.Loaded.Day] {
        let source = selectedDate == Dates.allDates
            ? loaded.days
            : loaded.days.filter { $0.date == selectedDate }
        let needle = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return source }
        // §5.1's field list lives in `JourneySearchMatcher`, not in this
        // closure. It used to be spelled here, and it was missing `date` and
        // `direction` — which no test noticed, because every test searched by
        // train number. A contract that exists in one place can be checked;
        // one that exists inside a filter cannot.
        return source.compactMap { day in
            let trains = JourneySearchMatcher.filter(day.trains, query: needle)
            return trains.isEmpty ? nil : .init(date: day.date, trains: trains)
        }
    }

    /// §5.1's date filter, as a submenu of the header's menu.
    ///
    /// It was a toolbar item, and there is no toolbar in the sheet. A submenu rather
    /// than a flat section because the date list is as long as the log is:
    /// two hundred journeys over thirty days is thirty entries, and §4.2 does
    /// not want thirty of anything between the reader and Settings.
    @ViewBuilder
    private func dateFilterSection(_ loaded: ItineraryStore.Loaded) -> some View {
        Menu {
            Button {
                selectedDate = Dates.allDates
            } label: {
                Label(
                    localization.countryText("date.all", fallback: "All dates"),
                    systemImage: selectedDate == Dates.allDates ? "checkmark" : "calendar")
            }
            ForEach(availableDates(loaded), id: \.self) { date in
                Button {
                    selectedDate = date
                } label: {
                    Label(date, systemImage: selectedDate == date ? "checkmark" : "calendar")
                }
            }
            Divider()
            Button {
                newManualDate = ""
                afterPresentationDismisses { dialog = .addDate }
            } label: {
                Label(
                    localization.countryText("btn.addDate", fallback: "Add date"),
                    systemImage: "calendar.badge.plus")
            }
            Button(role: .destructive) {
                let used = Set(loaded.days.map(\.date))
                manualDates.removeAll { !used.contains($0) }
                persistManualDates()
                if selectedDate != Dates.allDates,
                    !availableDates(loaded).contains(selectedDate)
                {
                    selectedDate = Dates.allDates
                }
            } label: {
                Label(
                    localization.journeyText(
                        "btn.removeEmptyDates", fallback: "Remove empty dates"),
                    systemImage: "calendar.badge.minus")
            }
            .disabled(manualDates.isEmpty)
            Toggle(
                localization.journeyText(
                    "toggle.currentDate", fallback: "Map shows the selected date only"),
                isOn: $mapFollowsSelectedDate)
            // Beside the date filter because they are the same kind of
            // decision — what the MAP does when the list's scope or selection
            // changes — and the web app keeps its own 自動縮放 button in the
            // date bar for the same reason.
            Toggle(autoFocusLabel, isOn: $autoFocusZoom)
        } label: {
            Label(
                selectedDate == Dates.allDates
                    ? localization.countryText("date.all", fallback: "All dates")
                    : selectedDate,
                systemImage: "calendar")
        }
    }

    /// 自動縮放, without the separator the web app's button needs.
    ///
    /// `btn.autoFocus` is "自動フォーカス：" — a label that expects `state.on`
    /// or `state.off` to be appended, because in the browser it is one button
    /// that reports its own state. A `Toggle` reports its state itself, so the
    /// separator is trimmed rather than a fifth translation of the same two
    /// words being introduced to carry the string without it.
    private var autoFocusLabel: String {
        localization.countryText("btn.autoFocus", fallback: "Auto-focus")
            .trimmingCharacters(in: CharacterSet(charactersIn: ": \u{FF1A}\u{3000}"))
    }

    private func availableDates(_ loaded: ItineraryStore.Loaded) -> [String] {
        Dates.availableDates(loaded.trains.map(\.forDates), manualDates: manualDates)
    }

    private func addManualDate() {
        guard let normalized = Dates.normalizeDateString(newManualDate) else { return }
        if !manualDates.contains(normalized) { manualDates.append(normalized) }
        persistManualDates()
        selectedDate = normalized
    }

    private func manualDatesKey() -> String { "manual-dates" }

    private func loadManualDates() -> [String] {
        (UserDefaults.standard.array(forKey: manualDatesKey()) as? [String]) ?? []
    }

    private func persistManualDates() {
        UserDefaults.standard.set(manualDates, forKey: manualDatesKey())
    }

    /// The web app's 載入示例資料 / 保存為我的資料 / 恢復我的資料, as one menu.
    ///
    /// One menu rather than eleven buttons because on a phone they are eleven
    /// buttons the reader has to read every time; grouped, the destructive one
    /// is also somewhere it cannot be hit by accident.
    @ViewBuilder
    private var rideSourceSection: some View {
        Group {
                if itineraries.selectedTrainID != nil {
                    Button {
                        itineraries.selectedTrainID = nil
                    } label: {
                        Label(
                            localization.journeyText(
                                "ios.journey.clearSelection", fallback: "Clear selection"),
                            systemImage: "xmark.circle")
                    }
                    Divider()
                }
                // The samples are on the data screen, one section per region,
                // because loading one is now an ordinary edit to the working
                // set rather than a switch between two ways of using the app.
                // This menu keeps the two actions that are about the reader's
                // own rides.

                Section(localization.text("ios.myRides", fallback: "My rides")) {
                    Button {
                        if let store = itineraries.store {
                            library.save(store)
                        }
                    } label: {
                        Label(localization.countryText("btn.saveAsMine", fallback: "Save as my rides"), systemImage: "square.and.arrow.down")
                    }
                    .disabled(itineraries.store == nil)

                    Button {
                        itineraries.load(from: library)
                    } label: {
                        Label(localization.countryText("btn.restoreMine", fallback: "Restore my rides"), systemImage: "arrow.uturn.backward")
                    }
                    .disabled(!library.hasSavedStore)
                }
        }
    }

    /// New journey — and, because there is no active region any more, which
    /// region it starts in.
    ///
    /// `StoreOperations.createBlankTrain` is regional DATA, not a template
    /// with a parameter: Japan starts 東京→熱海 with N02 codes the solver can
    /// route immediately, Taiwan on the airport-MRT corridor with TDX
    /// StationUIDs, and so on. So the choice cannot be deferred to the editor
    /// without handing the reader a scaffold from the wrong country. A plain
    /// tap takes the region the reader is already working in; the menu offers
    /// the other four.
    private func newJourneyScaffold(in region: Region) -> Train {
        StoreOperations.createBlankTrain(country: region.code).taggingRegion()
    }

    /// Which region a new journey starts in when the reader just taps `+`:
    /// the one they are looking at, then the one they have most rides in,
    /// then Japan.
    private var defaultRegion: Region {
        if let train = itineraries.selectedTrain { return Region.resolved(train) }
        let trains = itineraries.loaded?.trains ?? []
        let counts = Dictionary(grouping: trains, by: Region.resolved).mapValues(\.count)
        return counts.max {
            $0.value != $1.value
                ? $0.value < $1.value
                : (Region.ordered.firstIndex(of: $0.key) ?? 0)
                    > (Region.ordered.firstIndex(of: $1.key) ?? 0)
        }?.key ?? .jp
    }

    @ViewBuilder
    private func rideContextMenu(_ train: Train) -> some View {
        Button {
            startPlayback([train])
        } label: {
            Label(localization.countryText("btn.play", fallback: "Play journey"), systemImage: "play.fill")
        }
        Button {
            sheet = .detail(train)
        } label: {
            Label(
                localization.text("ios.journeyInfo", fallback: "Journey information"),
                systemImage: "info.circle")
        }
        Button {
            itineraries.duplicate(train.id)
            persistMine()
        } label: {
            Label(localization.countryText("btn.duplicate", fallback: "Duplicate"), systemImage: "plus.square.on.square")
        }
        Button {
            itineraries.toggleVisibility(train.id)
            persistMine()
        } label: {
            Label(
                train.visible == false
                    ? localization.text("ios.showOnMap", fallback: "Show on map")
                    : localization.journeyText(
                        "ios.journey.hideFromMap", fallback: "Hide from map"),
                systemImage: train.visible == false ? "eye" : "eye.slash"
            )
        }
        Button {
            itineraries.move(train.id, by: -1)
            persistMine()
        } label: {
            Label(localization.countryText("btn.moveUp", fallback: "Move earlier"), systemImage: "arrow.up")
        }
        Button {
            itineraries.move(train.id, by: 1)
            persistMine()
        } label: {
            Label(localization.countryText("btn.moveDown", fallback: "Move later"), systemImage: "arrow.down")
        }
        Divider()
        Button(role: .destructive) {
            afterPresentationDismisses { dialog = .delete(train) }
        } label: {
            Label(localization.countryText("btn.delete", fallback: "Delete"), systemImage: "trash")
        }
    }

    private func persistMine() {
        // Any edit forks a bundled sample into the reader's own store. A
        // sample remains immutable on disk and the user's change is durable.
        guard let store = itineraries.store else { return }
        library.save(store)
    }

    /// The one basemap all three destinations share (§9.5.6, and the reader's
    /// own "需要三个 tab 都共用一个底图").
    ///
    /// One `MKMapView`, at the root, under the sheet. What changes between
    /// destinations is not the map but the QUESTION being asked of it, so what
    /// varies here are its inputs: which rides are drawn, and whether the
    /// complete network is on.
    private var map: some View {
        RailMapView(
            lines: lines,
            stations: store.stations,
            rides: mapRides,
            selectedTrainID: itineraries.selectedTrainID,
            selectedDate: selectedDate,
            // One display switch, one source of truth. Statistics can change
            // the reported region and frame the camera, but it must not force
            // the complete network back on after the reader turns it off.
            showsNetwork: controller.showsNetwork,
            basemapOpacity: controller.basemapOpacity,
            categoryIndexes: categoryIndexes,
            autoFocus: autoFocusZoom,
            controller: controller,
            playback: playback,
            onSelectRide: { selectFromMap($0) },
            onSelectStation: { sheet = .station($0) }
        ) { render = $0 }
        .ignoresSafeArea()
    }

    /// §4.4: a tap on empty map steps back exactly one level — first the
    /// journey selection, then a single-day filter. Never both at once, and
    /// never a jump to a state the reader cannot predict.
    ///
    /// A tap that lands on SEVERAL rides asks instead of choosing. That is the
    /// web app's `handleDeckRouteChoices`, and its reason is the same: a
    /// finger has no hover stage, so picking the nearest line silently selects
    /// a journey the reader may not have been pointing at — and where two
    /// rides run the same corridor, "nearest" is decided by a fraction of a
    /// point.
    private func selectFromMap(_ ids: [String]) {
        let trains = ids.compactMap { id in
            itineraries.loaded?.trains.first { $0.id == id }
        }
        switch trains.count {
        case 0:
            if itineraries.selectedTrainID != nil {
                itineraries.selectedTrainID = nil
            } else if selectedDate != Dates.allDates {
                selectedDate = Dates.allDates
            }
        case 1:
            pick(trains[0])
        default:
            dialog = .choose(trains)
        }
    }

    /// Select a ride the reader picked on the map, and make sure they can see
    /// it: the web app's chooser "both activates its day and selects it",
    /// because a ride on another day would otherwise vanish from the list the
    /// moment it was chosen.
    private func pick(_ train: Train) {
        if selectedDate != Dates.allDates,
            !Dates.trainSpans(train.forDates, date: selectedDate)
        {
            selectedDate = Dates.allDates
        }
        itineraries.selectedTrainID = train.id
    }

    /// One line of the chooser.
    ///
    /// The web app's `uiChoose` gives each item a label (date・number・type)
    /// and a sublabel (origin → destination). A system confirmation dialog
    /// renders one line per button and silently drops the rest, so the two are
    /// folded into one — and what gets dropped is the type and the operator,
    /// because two rides the reader cannot tell apart are usually two trains
    /// on the SAME corridor, where the number and the direction are what
    /// separate them and 「特急 JR西日本」 is what they have in common.
    private func chooserLabel(_ train: Train) -> String {
        let region = Region.resolved(train)
        let date = train.date.map { $0 == Dates.undated ? "" : $0 } ?? ""
        let name = train.number.isEmpty ? train.id : train.number
        let origin = localization.placeName(train.origin, region: region)
        let destination = localization.placeName(train.destination, region: region)
        let route = origin.isEmpty && destination.isEmpty
            ? "" : "\(origin) → \(destination)"
        // The date leads only when the list is not already scoped to one day:
        // scoped, every candidate carries the same date and it is a prefix
        // that pushes the distinguishing half off the end of the line.
        let parts = selectedDate == Dates.allDates ? [date, name, route] : [name, route]
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// Every visible ride, INCLUDING the ones outside the selected date.
    ///
    /// This used to drop off-date rides. That is not what the web app does and
    /// it is not what `DisplaySettings.dimOpacity` is for: an off-date ride is
    /// drawn faint so the reader can see the day in the context of the trip,
    /// and removing it makes the slider a control over nothing. The renderer
    /// is handed `selectedDate` and decides.
    ///
    /// `map-date-filter` (`mapFollowsSelectedDate`) is the reader asking for
    /// the harder version — only this date on the map — so that one still
    /// filters here.
    private var mapRides: [RiddenRouteStore.DrawnRide] {
        let visible = riddenRoutes.rides.filter(\.visible)
        // §5.3.2: while the statistics are on top, the map is their coverage
        // map — the same records the numbers counted, and only those. A map
        // showing five networks under a Japanese percentage invites the
        // reader to read the percentage as covering all of them.
        if selection == .stats {
            let scoped = Set(statisticsScopedTrains.map(\.id))
            return visible.filter { scoped.contains($0.id) }
        }
        guard mapFollowsSelectedDate, selectedDate != Dates.allDates,
              let trains = itineraries.loaded?.trains else { return visible }
        let inScope = Set(trains.filter {
            Dates.trainSpans($0.forDates, date: selectedDate)
        }.map(\.id))
        return visible.filter { inScope.contains($0.id) }
    }

    /// `resolveQueue` — what "play" means right now.
    ///
    ///   a chosen journey → just that one, **even if it is hidden**: the
    ///                      reader asked for it by name
    ///   otherwise        → the list as it stands, minus the hidden journeys
    ///                      and minus anything with fewer than two calls
    ///
    /// The hidden ones used to play anyway. A journey switched off is one the
    /// reader has taken off the map, and a queue that plays it puts it back on
    /// screen — with the camera following it — for as long as it runs.
    private var playbackScope: [Train] {
        guard let loaded = itineraries.loaded else { return [] }
        if let selected = itineraries.selectedTrainID,
           let train = loaded.trains.first(where: { $0.id == selected }) {
            return [train]
        }
        let searchQuery = selection == .search ? query : ""
        return filteredDays(loaded, query: searchQuery)
            .flatMap(\.trains)
            .filter { $0.visible != false && $0.stops.count > 1 }
    }

    /// Start a run, remembering what was selected before it.
    ///
    /// `restoreSelected` in the web app: the transport moves the selection
    /// from journey to journey as it plays (`onChange(of:playback.currentTrainID)`
    /// above), so stopping has to put back whatever the reader was looking at
    /// when they pressed play. Every entry point goes through here so that
    /// none of them can forget to.
    @discardableResult
    private func startPlayback(_ trains: [Train]) -> Bool {
        playback.start(
            trains: trains, rides: riddenRoutes.rides, reducedMotion: reduceMotion,
            restoringSelection: itineraries.selectedTrainID)
    }

    private var rideIDs: Set<String> { Set(riddenRoutes.rides.map(\.id)) }

    /// The regions the drawn rides belong to — the only ones whose network
    /// the category filter could ever need to classify against.
    private var riddenCountries: [String] {
        Array(Set(riddenRoutes.rides.map(\.country))).sorted()
    }

    /// Re-run the index build when a category is first switched off, or when a
    /// region gains its first ride. Not on the filter's exact value: turning
    /// 私鐵 off after 地下鐵 needs no index that turning 地下鐵 off did not.
    private var categoryIndexKey: String {
        "\(controller.layers.categories.anyHidden)|\(riddenCountries.joined(separator: ","))"
    }

    /// Whether the transport is on screen.
    ///
    /// Named, because it is what the two layouts animate on. `.transition` is
    /// inert unless the insertion happens inside an animated transaction, and
    /// the state that drives it lives in `PlaybackController` — where a
    /// `withAnimation` would make a store own a presentation decision. The
    /// same split `MapControlBar` already uses for `locationRefusal`: the
    /// store names the state, the view decides how it arrives.
    private var showsPlaybackBar: Bool {
        playback.isActive || playback.phase == .ended
    }

    @ViewBuilder
    private var playbackBar: some View {
        if showsPlaybackBar {
            VStack(spacing: 9) {
                if dynamicTypeSize.isAccessibilitySize {
                    accessibilityPlaybackLayout
                } else {
                    standardPlaybackLayout
                }
            }
            .buttonStyle(RailPressStyle(dims: false))
            .padding(12)
            // The transport is a control floating over the map, so it takes
            // the same surface every other floating control does. It used to
            // spell `.regularMaterial` here, which made it the ONE piece of
            // chrome that stayed a material while the rest became Liquid Glass
            // on iOS 26 — and, more seriously, the one that answered neither
            // Reduce Transparency nor Increase Contrast, because both of those
            // are handled inside `RailGlassSurface` and nowhere else.
            //
            // `interactive` is deliberately off: the buttons inside carry
            // their own press feedback, and a capsule that deforms wherever it
            // is touched would compete with them.
            .railGlass(in: RoundedRectangle(
                cornerRadius: RailStyle.chromeCornerRadius,
                style: .continuous))
            // Kept, and it is not decoration: §6.5 uses a heavy shadow for the
            // one job of separating a floating surface from the map.
            .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
            .frame(maxWidth: 540)
            .transition(RailMotion.panelTransition(reduceMotion: reduceMotion))
            .accessibilityElement(children: .contain)
        }
    }

    /// The compact transport used at ordinary text sizes.
    private var standardPlaybackLayout: some View {
        VStack(spacing: 9) {
            HStack(spacing: 10) {
                playbackTransportControls
                playbackIdentity(titleLines: 1, stationLines: 1)
                Spacer(minLength: 4)
                playbackStopButton
            }

            playbackProgress

            HStack(spacing: 10) {
                playbackQueueLabel
                focusToggle
                Spacer()
                speedSlider.frame(maxWidth: 120)
                speedReadout
                    .frame(minWidth: 34, alignment: .trailing)
                    .fixedSize(horizontal: true, vertical: false)
                videoControl
            }
        }
    }

    /// Accessibility text gets a content-led composition instead of a scaled
    /// copy of the two dense horizontal rows. Text may grow; transport chrome
    /// keeps a familiar size and each group gets the full available width.
    private var accessibilityPlaybackLayout: some View {
        VStack(alignment: .leading, spacing: 10) {
            playbackIdentity(titleLines: 3, stationLines: 2)

            HStack(spacing: 8) {
                playbackTransportControls
                playbackStopButton
                Spacer(minLength: 0)
            }
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)

            playbackProgress

            HStack(spacing: 8) {
                playbackQueueLabel
                focusToggle
                videoControl
                Spacer(minLength: 0)
            }
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)

            HStack(spacing: 10) {
                speedSlider
                speedReadout
                    .fixedSize(horizontal: true, vertical: false)
            }
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        }
        // In map layouts the vertical control rail shares this overlay. Keep
        // accessibility-sized text and controls out of its resting footprint;
        // the glass surfaces may overlap visually, but their hit targets must
        // never overlap.
        .padding(
            .trailing,
            MapControlBar.side + (2 * MapControlBar.interactionBleed) + 12)
    }

    private var playbackTransportControls: some View {
        HStack(spacing: 10) {
            Button { playback.previous() } label: {
                Image(systemName: "backward.end.fill")
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .disabled(!playback.canGoPrevious)
            .accessibilityLabel(
                Text(localization.journeyText("play.prev", fallback: "Previous train")))

            Button { playback.togglePause() } label: {
                Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                    .font(.title3)
                    .contentTransition(.symbolEffect(.replace))
                    .animation(RailMotion.replace, value: playback.isPlaying)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .disabled(playback.phase == .ended)
            .accessibilityLabel(
                Text(localization.journeyText(
                    playback.isPlaying ? "play.pause" : "play.resume",
                    fallback: playback.isPlaying ? "Pause" : "Resume")))

            Button { playback.next() } label: {
                Image(systemName: "forward.end.fill")
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .disabled(!playback.canGoNext)
            .accessibilityLabel(
                Text(localization.journeyText("play.next", fallback: "Next train")))
        }
    }

    private func playbackIdentity(titleLines: Int, stationLines: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(playback.title)
                .font(.caption.weight(.semibold))
                .lineLimit(titleLines)
                .fixedSize(horizontal: false, vertical: true)
            if !playback.stationName.isEmpty {
                Text(playback.stationName)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(stationLines)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var playbackStopButton: some View {
        Button { stopPlayback() } label: {
            Image(systemName: "xmark.circle.fill")
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .accessibilityLabel(localization.countryText("play.stop", fallback: "Stop playback"))
        .accessibilityIdentifier("playbackStopButton")
    }

    private var playbackProgress: some View {
        ProgressView(value: playback.progress)
            .tint(.accentColor)
    }

    private var playbackQueueLabel: some View {
        Label(
            "\(playback.queueIndex + 1)/\(max(playback.queueCount, 1))", systemImage: "tram"
        )
        .font(.caption2.monospacedDigit())
        .accessibilityLabel(
            localization.journeyText("ios.journey.playbackQueue", fallback: "Journey"))
        .accessibilityValue(
            Text("\(playback.queueIndex + 1)/\(max(playback.queueCount, 1))"))
    }

    private var focusToggle: some View {
        Toggle(isOn: $playback.autoFocus) {
            Label(
                localization.journeyText("play.focus", fallback: "Auto focus"),
                systemImage: "scope")
        }
        .font(.caption2)
        .toggleStyle(.button)
    }

    private var speedSlider: some View {
        Slider(
            value: Binding(get: { playback.speed }, set: { playback.setSpeed($0) }),
            in: Playback.Tuning.speedMin...Playback.Tuning.speedMax,
            step: Playback.Tuning.speedStep
        )
        .accessibilityLabel(localization.countryText("play.speed", fallback: "Playback speed"))
    }

    private var speedReadout: some View {
        Text("\(playback.speed.formatted(.number.precision(.fractionLength(2))))×")
            .font(.caption2.monospacedDigit())
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var videoControl: some View {
        switch videoExporter.state {
        case .recording:
            Button { videoExporter.cancel() } label: {
                Image(systemName: "record.circle.fill").foregroundStyle(.red)
            }
            .accessibilityLabel(localization.journeyText("video.cancel", fallback: "Cancel video export"))
        case .finishing:
            ProgressView().controlSize(.small)
                .accessibilityLabel(localization.journeyText("video.finishing", fallback: "Finishing video"))
        case .finished(let url, let partial):
            ShareLink(item: url) {
                Image(systemName: "square.and.arrow.up.fill")
                    // A cancelled run's film is offered like any other, and
                    // says so: `video.readyPartial` rather than `video.ready`.
                    .foregroundStyle(partial ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint))
            }
            .accessibilityLabel(
                localization.journeyText(
                    partial ? "video.readyPartial" : "video.share",
                    fallback: partial ? "Share partial video" : "Share video"))
        case .idle, .failed:
            Button {
                videoPlanSeconds = playback.prepare(
                    trains: playbackScope, rides: riddenRoutes.rides,
                    reducedMotion: reduceMotion
                ).seconds
                sheet = .videoOptions
            } label: {
                Image(systemName: "video.badge.plus")
            }
            .accessibilityLabel(localization.countryText("video.export", fallback: "Export playback video"))
        }
    }

    private func startVideoExport() {
        guard let mapView = controller.mapView else { return }
        videoSettings.persist()
        videoExporter.start(
            playback: playback, mapView: mapView,
            trains: playbackScope, rides: riddenRoutes.rides,
            reducedMotion: reduceMotion, settings: videoSettings)
    }

    private func stopPlayback() {
        if videoExporter.isRecording { videoExporter.cancel(clearPlayback: false) }
        playback.stop()
        // `restoreSelected`. Deliberately on STOP and not when a run reaches
        // its end: an ended run leaves its last journey selected, which is
        // what the reader was just watching and what the closing overview is
        // framing. Stopping is the reader saying they are done with the run,
        // and that is when the interrupted selection comes back.
        itineraries.selectedTrainID = playback.restoreSelectedTrainID
        playback.restoreSelectedTrainID = nil
    }

    /// Every region's lines, in one list.
    ///
    /// The store no longer holds them inside its `.loaded` case, because they
    /// arrive one region at a time and the map draws each as it lands rather
    /// than waiting for Japan.
    private var lines: [RailNetworkStore.DrawnLine] { store.lines }
}

/// Lets an inflexible block scroll rather than overflow.
///
/// The empty states are `VStack`s of a fixed height, and the panel they sit in
/// can be 130 points tall (§9.5.6's compact stop) or holding an accessibility
/// text size. Either way the block has to give way, and a `ScrollView` is how
/// a block that cannot shrink gives way.
private struct ScrollableIfNeeded: ViewModifier {
    func body(content: Content) -> some View {
        ScrollView { content }
            .scrollBounceBehavior(.basedOnSize)
    }
}

extension Coordinate {
    var clLocation: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
}

extension Duration {
    var milliseconds: Int {
        Int(components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000)
    }
}

#Preview {
    @Previewable @State var selection = PrimaryTab.all
    @Previewable @State var region: Region? = .jp
    RailWorkspaceView(
        store: RailNetworkStore(),
        itineraries: ItineraryStore(),
        library: RideLibrary(),
        riddenRoutes: RiddenRouteStore(),
        controller: RailMapController(),
        playback: PlaybackController(),
        statistics: MileageStatisticsStore(),
        statisticsRegion: $region,
        selection: $selection
    )
    .environment(AppLocalization())
}
