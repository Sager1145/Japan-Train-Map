import MapKit
import RailCore
import RailPresentation
import SwiftUI

/// The railway over Apple Maps, drawn through `MKMapView` rather than
/// SwiftUI's `Map`.
///
/// The first version used SwiftUI's `Map` with one `MapPolyline` per station
/// interval, and the simulator said what was wrong with that:
///
///     Exceeded Metal Buffer threshold of 50000 with a count of 50796
///     resources, pruning resources now
///     _UIInterruptScrollDecelerationGestureRecognizer has been in possible
///     phase for 21.899 seconds
///
/// Japan is 9,568 intervals. Every one became its own overlay, its own
/// renderer and its own set of Metal buffers, VectorKit hit its ceiling and
/// started pruning mid-render, and the gesture recogniser stalled for
/// twenty-two seconds. SwiftUI's `MapPolyline` cannot fix this: it initialises
/// from coordinates, `MKMapPoint`s, an `MKPolyline` or an `MKRoute`, and there
/// is no batch form — one polyline is always one overlay.
///
/// `MKMultiPolyline` is the batch form, so this drops to UIKit. Every line of
/// one colour becomes a single overlay drawn by a single
/// `MKMultiPolylineRenderer`, which takes Japan from 9,568 overlays to roughly
/// one per distinct railway colour.
///
/// Geometry is untouched. The vertices submitted are exactly the ones
/// `RailCore.decodeIntervals` produces, which is exactly what the JavaScript
/// draws — this changes only how they are handed to MapKit.
extension RailNetworkStore.DrawnLine: LODLine {}

/// One line's decimated geometry, kept with the line so the vertex budget can
/// shed the least important rather than simply the last built.
private struct LineBuild: LODBuild {
    let line: RailNetworkStore.DrawnLine
    let polylines: [MKPolyline]
    var drawnVertexCount: Int { polylines.reduce(0) { $0 + $1.pointCount } }
}

struct RailMapView: View {
    var lines: [RailNetworkStore.DrawnLine]
    var stations: [RailNetworkStore.DrawnStation]
    var rides: [RiddenRouteStore.DrawnRide]
    var selectedTrainID: String?
    /// The date the reader has scoped the ride list to, or `Dates.allDates`.
    ///
    /// The map needs it for two things it cannot otherwise decide: which rides
    /// are off-date and should draw at `DisplaySettings.dimOpacity` rather than
    /// vanish, and — with `DrawnRide.daySpan` — which half of an overnight ride
    /// runs on the other calendar day, which `showFullCrossDay` either dashes
    /// or draws solid. Defaulted so a preview needs no date.
    var selectedDate: String = Dates.allDates
    /// Whether the network is drawn. Kept separate from `lines` on purpose:
    /// hiding the network used to be expressed by passing an empty list, which
    /// made showing it again indistinguishable from loading a country, so the
    /// map re-framed itself and threw away wherever the reader had panned to.
    var showsNetwork: Bool
    var basemapOpacity: Double
    /// The N02 edge indexes the ridden-line category filter classifies
    /// against, one per region, and only for the regions that have rides.
    ///
    /// Handed in rather than reached for: building one parses the whole rail
    /// network, and the render path must never do that (`app-stats.js` says so
    /// in as many words). A region that is missing here is undetermined, and
    /// an undetermined ride stays visible — which is also the state while the
    /// indexes are still being built, and the state whenever every category is
    /// switched on and nothing needs classifying at all.
    var categoryIndexes: [String: Statistics.EdgeIndex] = [:]
    /// `focusZoomEnabled` — 自動縮放. Whether choosing a journey, or a day,
    /// moves the map to frame what was chosen.
    var autoFocus: Bool = false
    /// The wire to the control bar, which lives elsewhere in the layout — at
    /// the bottom of the screen on iPhone, at the foot of the sidebar on iPad.
    var controller: RailMapController
    var playback: PlaybackController
    /// Every ride under the tap, nearest first — empty when the tap landed on
    /// none. See ``Coordinator/handleMapTap(_:)``: a touch cannot hover, so
    /// the choice between crossing lines is handed up rather than guessed at.
    var onSelectRide: ([String]) -> Void
    /// A tap on a network station's bead. Handed up rather than answered here,
    /// because the answer is a sheet and a sheet presented from inside the map
    /// is a sheet that disappears with it.
    var onSelectStation: (StationCard) -> Void = { _ in }
    /// Reports back what the renderer actually did, so the numbers on screen
    /// are measurements rather than estimates.
    var onRender: (RenderStats) -> Void

    /// The 顯示調節 numbers.
    ///
    /// Read from the environment rather than taken as a parameter: `AppShell`
    /// publishes one `DisplaySettings`, the panel that edits it and the map
    /// that draws with it sit in different branches of the tree, and threading
    /// it through every view between would make the ride list an intermediary
    /// in a conversation it takes no part in. Optional so a preview that never
    /// installed one draws at the defaults instead of trapping.
    ///
    /// `@Environment` has no `init(wrappedValue:)`, so this is NOT part of the
    /// memberwise initialiser and `ContentView`'s call site is untouched.
    @Environment(DisplaySettings.self) private var displaySettings: DisplaySettings?

    /// The reader's language, for the three places on this map that carry a
    /// station's NAME rather than its mark: the network's station callout, the
    /// ride's own station captions, and the origin / destination cards.
    ///
    /// Read from the environment for the same reason `displaySettings` is —
    /// `AppShell` publishes one and the map is not on the path between it and
    /// the settings panel — and optional for the same reason: a preview that
    /// installed none draws the packages' own names rather than trapping.
    @Environment(AppLocalization.self) private var localization: AppLocalization?

    /// A snapshot of the 顯示調節 values, taken during a SwiftUI update and
    /// then carried by value.
    ///
    /// The renderer runs off `MKMapView` delegate callbacks that are not
    /// SwiftUI updates, so it must not hold the observable object and re-read
    /// it whenever a region changes — that is how one redraw ends up mixing
    /// two generations of settings. It also gives the coordinator something it
    /// can compare, which is what tells a settings change from a pan.
    struct DisplayValues: Equatable {
        var routeWidthScale = DisplaySettings.Defaults.routeWidthScale
        var riddenOpacity = DisplaySettings.Defaults.riddenOpacity
        var dimOpacity = DisplaySettings.Defaults.dimOpacity
        var focusBoost = DisplaySettings.Defaults.focusBoost
        var showFullCrossDay = DisplaySettings.Defaults.showFullCrossDay
        var markers = MapRideMarkers.Settings(
            terminalRadius: DisplaySettings.Defaults.terminalRadius,
            passRadius: DisplaySettings.Defaults.passRadius,
            stopCentreRadius: DisplaySettings.Defaults.stopRadius
                * DisplaySettings.stopCentreSliderScale,
            markerStrokeScale: DisplaySettings.Defaults.markerStrokeScale,
            focusBoost: DisplaySettings.Defaults.focusBoost)

        init() {}

        /// `DisplaySettings` is main-actor state; a SwiftUI update is on the
        /// main actor, and this is the moment the values leave it.
        @MainActor
        init(_ settings: DisplaySettings) {
            routeWidthScale = settings.routeWidthScale
            riddenOpacity = settings.riddenOpacity
            dimOpacity = settings.dimOpacity
            focusBoost = settings.focusBoost
            showFullCrossDay = settings.showFullCrossDay
            markers = MapRideMarkers.Settings(
                terminalRadius: settings.terminalRadius,
                passRadius: settings.passRadius,
                stopCentreRadius: settings.stopCentreRadius,
                markerStrokeScale: settings.markerStrokeScale,
                focusBoost: settings.focusBoost)
        }
    }

    struct RenderStats: Equatable {
        var zoom: Double
        var visibleLines: Int
        var overlays: Int
        var vertices: Int
        var buildMilliseconds: Int
        /// Lines whose bounding box never met the build rect. A large number
        /// here is the off-screen cull earning its keep; a zero at a city zoom
        /// would mean it is not working.
        var culledOffScreen: Int = 0
        /// The threshold actually in force. Below `zoom` when the vertex
        /// budget had to raise the bar — worth seeing rather than guessing at.
        var threshold: Double = 0
    }

    /// The environment read happens HERE, in a `body`.
    ///
    /// A `UIViewRepresentable` has no body, and `updateUIView` is not a scope
    /// SwiftUI is documented to install observation tracking around — so a
    /// 顯示調節 value first read inside it might never schedule an update when
    /// the reader next moved the slider. Read in a body it is tracked like any
    /// other observable property, and the surface below then takes the numbers
    /// as a plain value, exactly the way it already takes the lines and the
    /// rides.
    var body: some View {
        Surface(
            lines: lines,
            stations: stations,
            rides: rides,
            selectedTrainID: selectedTrainID,
            selectedDate: selectedDate,
            showsNetwork: showsNetwork,
            // Read HERE, in a body, for the same reason the 顯示調節 numbers
            // are: `updateUIView` is not a scope SwiftUI installs observation
            // tracking around, so a switch first read down there might never
            // schedule the update that redraws it.
            layers: controller.layers,
            categoryIndexes: categoryIndexes,
            autoFocus: autoFocus,
            basemapOpacity: basemapOpacity,
            controller: controller,
            playback: playback,
            display: displaySettings.map(DisplayValues.init) ?? DisplayValues(),
            naming: localization.map(MapNaming.init) ?? MapNaming(),
            localization: localization,
            onSelectRide: onSelectRide,
            onSelectStation: onSelectStation,
            onRender: onRender
        )
    }

    /// The `MKMapView` itself, and everything that draws into it.
    struct Surface: UIViewRepresentable {
        var lines: [RailNetworkStore.DrawnLine]
        var stations: [RailNetworkStore.DrawnStation]
        var rides: [RiddenRouteStore.DrawnRide]
        var selectedTrainID: String?
        var selectedDate: String
        var showsNetwork: Bool
        var layers: MapLayers
        var categoryIndexes: [String: Statistics.EdgeIndex]
        var autoFocus: Bool
        var basemapOpacity: Double
        var controller: RailMapController
        var playback: PlaybackController
        var display: DisplayValues
        /// What the reader's language settles, as a value the renderer can
        /// compare — see ``MapNaming``. The lookups themselves go through
        /// `localization`.
        var naming: MapNaming
        var localization: AppLocalization?
        var onSelectRide: ([String]) -> Void
        var onSelectStation: (StationCard) -> Void
        var onRender: (RenderStats) -> Void

        func makeUIView(context: Context) -> MKMapView {
            let mapView = MKMapView()
            mapView.delegate = context.coordinator
            mapView.showsCompass = true
            mapView.showsScale = true

            // `.muted` is MapKit's own term for "something is being drawn over
            // me", and excluding points of interest stops Apple's transit lines
            // competing with ours for the same ink.
            let configuration = MKStandardMapConfiguration(
                elevationStyle: .flat, emphasisStyle: .muted)
            configuration.pointOfInterestFilter = .excludingAll
            mapView.preferredConfiguration = configuration

            context.coordinator.mapView = mapView
            context.coordinator.onSelectRide = onSelectRide
            context.coordinator.onSelectStation = onSelectStation
            context.coordinator.controller = controller
            context.coordinator.playback = playback
            playback.mapRenderer = context.coordinator
            playback.mapRendererViewSize = mapView.bounds.size
            controller.mapView = mapView
            let tap = UITapGestureRecognizer(
                target: context.coordinator, action: #selector(Coordinator.handleMapTap(_:)))
            tap.delegate = context.coordinator
            mapView.addGestureRecognizer(tap)

            // Two SENSORS, not gestures: they never move the map and never
            // consume a touch, they only let the coordinator know that a finger
            // is on it. See `Coordinator.handleManipulation(_:)` for what that
            // answer is worth — MapKit reports where the map ENDED UP, and
            // never whether the reader is still moving it.
            //
            // `cancelsTouchesInView = false` is what makes them harmless: every
            // touch still reaches MapKit's own pinch and pan untouched, and
            // `shouldRecognizeSimultaneouslyWith` (which this coordinator
            // answers `true` to) is documented to GUARANTEE simultaneous
            // recognition from either side of a pair.
            for sensor in [
                UIPinchGestureRecognizer(
                    target: context.coordinator,
                    action: #selector(Coordinator.handleManipulation(_:))),
                UIPanGestureRecognizer(
                    target: context.coordinator,
                    action: #selector(Coordinator.handleManipulation(_:))),
            ] as [UIGestureRecognizer] {
                sensor.delegate = context.coordinator
                sensor.cancelsTouchesInView = false
                sensor.delaysTouchesBegan = false
                sensor.delaysTouchesEnded = false
                mapView.addGestureRecognizer(sensor)
                context.coordinator.manipulationSensors.append(sensor)
            }

            // Dark mode is not just a darker basemap: the packages ship a separate
            // colour per line for it, so the overlays have to be rebuilt with the
            // other palette. MapKit recolours itself; these do not.
            mapView.registerForTraitChanges([UITraitUserInterfaceStyle.self]) {
                (view: MKMapView, _: UITraitCollection) in
                context.coordinator.appearanceChanged(on: view)
            }
            return mapView
        }

        func updateUIView(_ mapView: MKMapView, context: Context) {
            context.coordinator.onRender = onRender
            context.coordinator.controller = controller
            context.coordinator.playback = playback
            context.coordinator.onSelectRide = onSelectRide
            context.coordinator.onSelectStation = onSelectStation
            context.coordinator.localization = localization
            playback.mapRenderer = context.coordinator
            playback.mapRendererViewSize = mapView.bounds.size
            context.coordinator.update(
                lines: lines,
                stations: stations,
                rides: rides,
                selectedTrainID: selectedTrainID,
                selectedDate: selectedDate,
                showsNetwork: showsNetwork,
                layers: layers,
                categoryIndexes: categoryIndexes,
                autoFocus: autoFocus,
                basemapOpacity: basemapOpacity,
                display: display,
                naming: naming,
                on: mapView
            )
        }

        func makeCoordinator() -> Coordinator { Coordinator() }

        final class Coordinator: NSObject, MKMapViewDelegate, PlaybackMapRendering,
            UIGestureRecognizerDelegate {
            weak var mapView: MKMapView?
            var controller: RailMapController?
            weak var playback: PlaybackController?
            var onRender: (RenderStats) -> Void = { _ in }
            var onSelectRide: ([String]) -> Void = { _ in }
            var onSelectStation: (StationCard) -> Void = { _ in }
            /// The localisation engine's owner. A `@MainActor` class, and
            /// therefore `Sendable`, so a nonisolated coordinator may hold it;
            /// see ``localized(_:code:)`` for how it is read.
            var localization: AppLocalization?

            private var lines: [RailNetworkStore.DrawnLine] = []
            private var stations: [RailNetworkStore.DrawnStation] = []
            private var rides: [RiddenRouteStore.DrawnRide] = []
            private var selectedTrainID: String?
            private var selectedDate = Dates.allDates
            private var naming = MapNaming()
            private var minZoomByLineId: [String: Int] = [:]
            /// Starts where `RailMapController.showsNetwork` starts, so the
            /// first update is not told the layer just changed.
            private var showsNetwork = false
            private var layers = MapLayers()
            private var categoryIndexes: [String: Statistics.EdgeIndex] = [:]
            /// Drawn segment → the ridden-line category it belongs to, `""`
            /// for "the index could not say".
            ///
            /// Classifying walks every vertex of every segment, and a rebuild
            /// happens on each zoom tier and each pan out of the built rect —
            /// so without this the filter would put an O(vertices) pass inside
            /// the pan gesture. The web app caches the same answer on the
            /// geometry object itself; here the geometry has no identity to
            /// hang it on, so it is keyed and dropped when the rides or the
            /// indexes move. The CATEGORY is cached rather than the visibility
            /// that follows from it, which is what makes flipping a checkbox
            /// free.
            private var segmentCategories: [String: String] = [:]
            /// A journey chosen with 自動縮放 on, waiting for its geometry.
            /// See where it is read, below.
            private var pendingFocusTrainID: String?
            private var basemapOpacity = 1.0
            /// Set only when a genuinely new set of lines arrives. Framing the map
            /// is a reasonable thing to do when a country finishes loading and a
            /// rude thing to do at any other time.
            private var framePending = false
            /// The zoom bucket the current overlays were built for. Rebuilding on
            /// every region change would put a full decimation pass inside the
            /// pan gesture; rebuilding when the integer zoom changes puts it at
            /// the handful of moments where what is drawn actually changes.
            private var builtForZoom: Int?
            /// The rect the current overlays were built for — the visible one plus
            /// its padding. Panning inside it does no work; leaving it rebuilds.
            private var builtRect: MKMapRect = .null
            private var lastPlaybackSnapshot: PlaybackMapSnapshot?
            private var playbackOverlays: [MKOverlay] = []
            private var playbackAnnotations: [MKAnnotation] = []
            private var networkAnnotations: [MKAnnotation] = []
            private var rideStationAnnotations: [MKAnnotation] = []
            private var endpointAnnotations: [EndpointLabelAnnotation] = []
            private var display = DisplayValues()
            /// The value of ``RailStyle/scale(atZoom:)`` the marks on screen were
            /// last drawn at. Every weight on this map is a token times that one
            /// factor, so re-applying it is the whole of a rescale — and comparing
            /// against it is what keeps a pan that did not change the scale from
            /// touching a single renderer.
            private var styledScale: CGFloat = .nan
            /// When a tap was last answered with a ride of this map's own —
            /// read by ``mapView(_:didSelect:)`` half a second later, and
            /// cleared as the next touch arrives, so it only ever describes
            /// the touch in hand.
            private var rideAnsweredTap: ContinuousClock.Instant?

            func update(
                lines: [RailNetworkStore.DrawnLine],
                stations: [RailNetworkStore.DrawnStation],
                rides: [RiddenRouteStore.DrawnRide],
                selectedTrainID: String?,
                selectedDate: String,
                showsNetwork: Bool,
                layers: MapLayers,
                categoryIndexes: [String: Statistics.EdgeIndex],
                autoFocus: Bool,
                basemapOpacity: Double,
                display: DisplayValues,
                naming: MapNaming,
                on mapView: MKMapView
            ) {
                let linesChanged = lines.map(\.id) != self.lines.map(\.id)
                let stationsChanged = stations.map(\.id) != self.stations.map(\.id)
                let ridesChanged = rides.map(Self.rideSignature)
                    != self.rides.map(Self.rideSignature)
                let selectionChanged = selectedTrainID != self.selectedTrainID
                let visibilityChanged = showsNetwork != self.showsNetwork
                    || basemapOpacity != self.basemapOpacity
                    || layers != self.layers
                // Compared by which regions have one, not by value: an edge
                // index holds a dictionary with an entry per network edge, and
                // comparing two of those on every update would cost more than
                // the drawing does. An index is built once per region and
                // never mutated, so its presence is the whole of the news.
                let indexesChanged = Set(categoryIndexes.keys) != Set(self.categoryIndexes.keys)
                // Every 顯示調節 number is a width, a radius or an opacity of
                // something already drawn, so a change to one is a rebuild like
                // any other rather than a separate code path.
                let displayChanged = display != self.display
                // The date scope is paint, not a filter: it decides which
                // rides draw at `dimOpacity` and which half of an overnight
                // one is dashed. Both are properties of things already built,
                // so a scope change is a rebuild like the others.
                let dateChanged = selectedDate != self.selectedDate
                let namingChanged = naming != self.naming
                guard linesChanged || stationsChanged || ridesChanged
                        || selectionChanged || visibilityChanged || indexesChanged
                        || displayChanged || dateChanged || namingChanged else { return }

                if ridesChanged || indexesChanged {
                    segmentCategories.removeAll(keepingCapacity: true)
                }
                self.layers = layers
                self.categoryIndexes = categoryIndexes

                self.display = display
                self.selectedDate = selectedDate
                self.naming = naming
                self.showsNetwork = showsNetwork
                self.basemapOpacity = basemapOpacity
                self.selectedTrainID = selectedTrainID
                if ridesChanged { self.rides = rides }
                if stationsChanged {
                    self.stations = stations
                    indexStations()
                }

                if linesChanged {
                    self.lines = lines
                    self.minZoomByLineId = Dictionary(
                        uniqueKeysWithValues: lines.map { ($0.id, $0.minZoom) })

                    // A new country's extent, handed to the controller so the 定位
                    // button frames what is actually loaded rather than a
                    // remembered extent — and kept even while the network is
                    // hidden, so the button still works.
                    let region = Self.region(covering: lines)
                    let controller = self.controller
                    DispatchQueue.main.async { controller?.fitRegion = region }

                    // Frame only for a real dataset, and only once. An empty list
                    // is the gap between countries, not something to look at.
                    // …unless the reader has already told the camera where
                    // to be. The regions land one at a time and the last of
                    // them can be seconds after launch, so a journey chosen in
                    // the meantime would be framed and then yanked back out to
                    // all five networks by a dataset finishing loading. A
                    // deliberate move outranks a housekeeping one.
                    framePending = !lines.isEmpty && !(controller?.hasFramedForReader ?? false)
                }

                let selectedRide = rides.first { $0.id == selectedTrainID }
                let selectionRegion = selectedRide.flatMap { Self.region(covering: $0.strokes) }
                let controller = self.controller
                // 自動縮放, and it is decided HERE rather than at the dozen
                // places that can change a selection, because this is the
                // first moment the answer exists: the region to frame is the
                // chosen ride's own geometry, and the shell does not hold it.
                //
                // A journey wins over a day. `selectDateBucket` in the web app
                // clears the selection before it fits, so the two can never
                // both be the news there; here a tap on a journey in another
                // day moves both at once, and framing the day would throw away
                // the more specific of the two answers.
                if autoFocus, selectionChanged { pendingFocusTrainID = selectedTrainID }
                if !autoFocus || selectedTrainID == nil { pendingFocusTrainID = nil }
                var focusRegion: MKCoordinateRegion? = nil
                if let pending = pendingFocusTrainID, pending == selectedTrainID,
                    let selectionRegion {
                    // The request survives until the geometry exists. A
                    // journey chosen from the list is very often chosen before
                    // its route has finished solving, and a fit that could not
                    // be answered at that instant used to be a fit that never
                    // happened — the map simply stayed where it was and the
                    // switch looked broken.
                    focusRegion = selectionRegion
                    pendingFocusTrainID = nil
                } else if autoFocus, dateChanged, selectedDate != Dates.allDates,
                    selectedTrainID == nil {
                    // "Whole-day auto-focus skips hidden trains; the
                    // single-train fit does not" — and every ride that reaches
                    // this surface is already a visible one.
                    focusRegion = Self.region(
                        covering: rides
                            .filter { $0.daySpan.date == selectedDate }
                            .flatMap(\.strokes))
                }
                DispatchQueue.main.async {
                    controller?.selectionRegion = selectionRegion
                    guard let focusRegion else { return }
                    controller?.fit(focusRegion)
                }

                builtForZoom = nil
                rebuild(on: mapView)

                if framePending, !(controller?.hasFramedForReader ?? false),
                    let region = Self.region(covering: lines) {
                    framePending = false
                    mapView.setRegion(region, animated: false)
                }
            }

            /// Everything about one ride that changes what is DRAWN for it.
            ///
            /// The stops and the day-span signature are here because they are
            /// inputs: the stops decide which dots exist and what role each
            /// carries, and the day span decides where the cross-day diamond
            /// lands and which segments dash. Before those were read, a ride
            /// edited into a different stop list with the same geometry would
            /// have kept its old markers.
            ///
            /// The stops are digested rather than counted. A count answers
            /// "were any added or removed", which is not the question — turning
            /// `ride_segment` off for one call, or making a stop a
            /// pass-through, changes which dots are drawn and how without
            /// changing how many stops there are. This is the second gate an
            /// edit has to pass (the first is `ContentView.routeLoadKey`), and
            /// a gate that only counts holds the reloaded ride back at exactly
            /// the edits the reload existed to show.
            static func rideSignature(_ ride: RiddenRouteStore.DrawnRide) -> String {
                "\(ride.id):\(ride.vertexCount):\(ride.colorHex):\(ride.visible ? 1 : 0)"
                    + ":\(ride.trainType ?? ""):\(stopsDigest(ride.stops)):\(ride.daySpan.sig)"
            }

            /// The stops, as the one number the signature needs.
            ///
            /// `Hasher` rather than a joined string: this runs for every ride
            /// on every `updateUIView`, and a national store is 201 journeys of
            /// twenty-odd calls each. Seeded per process, which is all that is
            /// asked of it — the comparison is always between two values read
            /// in the same run.
            private static func stopsDigest(_ stops: [Stop]) -> Int {
                var hasher = Hasher()
                hasher.combine(stops.count)
                for stop in stops {
                    hasher.combine(stop.name)
                    hasher.combine(stop.stopType)
                    hasher.combine(stop.rideSegment)
                }
                return hasher.finalize()
            }

            /// The reader's date scope, as the paint rules read it.
            private var dateScope: MapDateScope.Scope {
                MapDateScope.Scope(
                    date: selectedDate, dimOpacity: display.dimOpacity,
                    showFullCrossDay: display.showFullCrossDay)
            }

            /// A station name and its reading sublines, in the reader's
            /// language.
            struct Named: Sendable {
                var display: String
                var readings: [Localization.Reading]
            }

            /// `stationNameReadings(name, code)` — the ONE spelling of the
            /// display rule, resolved through the app's localisation engine.
            ///
            /// `MainActor.assumeIsolated` rather than a pre-resolved table.
            /// Japan ships 10,217 stations and a `UIViewRepresentable` has
            /// nowhere to memoise a table of them without changing the view's
            /// initialiser, which `ContentView` calls — so the table would be
            /// rebuilt on every SwiftUI update, which is far more work than
            /// the handful of lookups a rebuild actually makes.
            ///
            /// The assumption is sound and it is checkable: every path into
            /// this coordinator is a main-thread callback. `makeUIView` and
            /// `updateUIView` are `@MainActor` by `UIViewRepresentable`'s own
            /// declaration, MapKit delivers every `MKMapViewDelegate` message
            /// on the main thread, `PlaybackController` is `@MainActor` and so
            /// is everything it calls `renderPlayback` from, and the tap and
            /// trait-change callbacks are UIKit's own.
            ///
            /// The `code` is not optional decoration: `stationReadingRow`
            /// tries it BEFORE the name, and same-named stations are common
            /// enough that dropping it annotates the wrong one.
            func localized(_ name: String, code: String? = nil) -> Named {
                guard !name.isEmpty, let localization else {
                    return Named(display: name, readings: [])
                }
                return MainActor.assumeIsolated {
                    Named(
                        display: localization.stationName(name, code: code),
                        readings: localization.nameReadingsTyped(name, code: code))
                }
            }

            /// The region as it MOVES, rather than once it has come to rest.
            ///
            /// `regionDidChangeAnimated` is delivered when a change SETTLES —
            /// at the end of a programmatic animated move, and coarsely during
            /// a gesture — so a "frame the selection" spent its whole 300–550
            /// ms flight drawing the railway at the weight of the zoom it left
            /// from, and stepped to the right weight on arrival. §9.1 asks the
            /// intermediate frames to explain the change; a weight that only
            /// updates at the end explains nothing and announces itself with a
            /// jump.
            ///
            /// Only the two cheap halves belong here. `rebuild` must NOT be
            /// called from this callback: its guard is
            /// `bucket != builtForZoom || !builtRect.contains(visibleRect)`,
            /// and the second half fails on nearly every frame of a pan — so
            /// wiring the settled callback's whole body to this one would
            /// rebuild the entire network sixty times a second. It stays where
            /// its zoom-bucket guard is the right one.
            ///
            /// `restyle` carries its own throttle (a 0.005 epsilon on the
            /// scale, see below), and `layoutEndpointLabels` returns
            /// immediately when there are no endpoint labels — which is the
            /// state the map is in unless a journey is selected.
            func mapViewDidChangeVisibleRegion(_ mapView: MKMapView) {
                restyle(on: mapView)
                // Screen-space work: these labels de-overlap each other and
                // clamp to the window's edges, so a label clamped at the right
                // edge stayed clamped after a pan carried it into the middle.
                layoutEndpointLabels(on: mapView)
            }


            func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
                // Not while the reader is still moving the map.
                //
                // This callback is documented as the SETTLED region, and during
                // a pinch MapKit sends it several times anyway — once per pause
                // in the fingers, near enough. Each one that crosses a zoom
                // tier ran the whole rebuild, and a rebuild is 150–460 ms of
                // main-thread work (measured over Japan with the network on):
                // decimating every eligible line, rebuilding every overlay and
                // re-adding every annotation. Three of those inside one pinch
                // is three freezes while the fingers are still moving, and it
                // is the larger half of why the map lagged them.
                //
                // Deferring costs the LOD tier a moment: lines the new zoom
                // admits appear when the fingers lift rather than during the
                // gesture. The strokes already drawn keep being drawn and keep
                // their ramp (`restyle` below still runs every frame), so what
                // the reader loses is detail arriving late — against a map that
                // stopped following them, which is what the report was.
                if isManipulating {
                    rebuildDeferredByGesture = true
                } else {
                    rebuild(on: mapView)
                }
                // The weight ramp is continuous in zoom while a rebuild happens
                // only when the zoom BUCKET changes, so re-applying it is its own
                // step. It costs a width per renderer and a frame per visible dot,
                // and only when the scale has actually moved.
                restyle(on: mapView)
                layoutEndpointLabels(on: mapView)
                // The compass needle tracks the map continuously, so heading is
                // reported on every region change rather than only on rebuilds —
                // a rotation that does not cross a zoom bucket rebuilds nothing.
                let heading = mapView.camera.heading
                let mode = mapView.userTrackingMode
                DispatchQueue.main.async { [controller] in
                    controller?.mapDidChange(heading: heading, trackingMode: mode)
                }
            }

            func mapView(
                _ mapView: MKMapView, didChange mode: MKUserTrackingMode, animated: Bool
            ) {
                let heading = mapView.camera.heading
                DispatchQueue.main.async { [controller] in
                    controller?.mapDidChange(heading: heading, trackingMode: mode)
                }
            }

            // MARK: - building

            /// Light/dark flipped. The zoom bucket has not changed, so the normal
            /// guard would skip the rebuild — clear it first, or the map keeps the
            /// previous palette until the reader happens to zoom.
            func appearanceChanged(on mapView: MKMapView) {
                builtForZoom = nil
                rebuild(on: mapView)
            }

            private func rebuild(on mapView: MKMapView) {
                // With both layers absent there is nothing to build. Hiding the
                // complete network does not hide the reader's routes.
                guard showsNetwork || !rides.isEmpty else {
                    mapView.removeOverlays(mapView.overlays)
                    if !networkAnnotations.isEmpty { mapView.removeAnnotations(networkAnnotations) }
                    networkAnnotations = []
                    if !rideStationAnnotations.isEmpty {
                        mapView.removeAnnotations(rideStationAnnotations)
                    }
                    rideStationAnnotations = []
                    builtForZoom = nil
                    return
                }

                // Before the first layout pass the view has no width, and the
                // zoom derived from it is nonsense — it was reading z = -8 and
                // culling every line. Wait for a real size.
                guard mapView.bounds.width > 1, !lines.isEmpty || !rides.isEmpty else { return }

                let zoom = Self.zoomLevel(of: mapView)
                let bucket = Int(zoom.rounded())
                let visibleRect = mapView.visibleMapRect
                // Rebuild when the zoom tier changes, or when the map has been
                // panned past what was built for. Panning within the padded rect
                // is free, which is what keeps the gesture smooth.
                guard bucket != builtForZoom || !builtRect.contains(visibleRect) else { return }
                builtForZoom = bucket
                let buildRect = NetworkLOD.buildRect(for: visibleRect)
                builtRect = buildRect

                let started = ContinuousClock.now

                // What is eligible: near enough to be seen, important enough for
                // this zoom. See NetworkLOD — that policy is deliberately stricter
                // than the web app's at low zoom, and deliberately outside the
                // ported tier, because there is no JavaScript to check it against.
                let selection = showsNetwork
                    ? NetworkLOD.select(from: lines, zoom: zoom, buildRect: buildRect)
                    : nil

                // Decimation is ours to IMPLEMENT — MapLibre gets it free from
                // geojson-vt and MapKit has no equivalent — but it is not ours
                // to SET. How far the drawn line may leave the surveyed one is
                // a contract both apps keep, and `RailStyle.simplifyTolerance`
                // is the web app's own number. The half a point that stood here
                // was eight times it, and because the parity fixtures compare
                // the two apps ABOVE this line, nothing reported the difference
                // but the map.
                let epsilon = Self.metresPerPixel(
                    zoom: zoom, latitude: mapView.region.center.latitude)
                    * RailStyle.simplifyTolerance

                let builds: [LineBuild] = (selection?.lines ?? []).map { line in
                    var polylines: [MKPolyline] = []
                    for interval in line.intervals where interval.count >= 2 {
                        let kept = Geometry.douglasPeuckerIndices(interval, epsilonMeters: epsilon)
                        let points = kept.map { interval[$0].clLocation }
                        guard points.count >= 2 else { continue }
                        polylines.append(MKPolyline(coordinates: points, count: points.count))
                    }
                    return LineBuild(line: line, polylines: polylines)
                }

                // The budget is applied to what decimation actually produced, not
                // to the stored vertex count. Budgeting on the raw count cut a
                // national view of Japan from 262 lines to 7, by weighing 394,285
                // stored vertices against a budget meant for the ~12,000 drawn.
                let fitted = NetworkLOD.fitToBudget(builds, zoom: zoom)
                let visible = fitted.kept.map(\.line)

                // One palette or the other, chosen once per rebuild rather than
                // per line: mixing them would be a map half in each mode.
                let dark = mapView.traitCollection.userInterfaceStyle == .dark

                var byColor: [String: [MKPolyline]] = [:]
                var colors: [String: UIColor] = [:]
                var vertices = 0
                for build in fitted.kept {
                    let key = dark ? build.line.colorDarkHex : build.line.colorHex
                    colors[key] = UIColor(dark ? build.line.colorDark : build.line.color)
                    byColor[key, default: []].append(contentsOf: build.polylines)
                    vertices += build.drawnVertexCount
                }

                // The scale this build's marks are sized for. One factor, read
                // once, handed to every weight below — see RailStyle. Rounded
                // by the same rule `restyle` rounds by, so a mark built here
                // and a mark rescaled there are never a fraction of a pixel
                // apart.
                let scale = Self.quantised(RailStyle.scale(atZoom: zoom), on: mapView)
                styledScale = scale

                mapView.removeOverlays(mapView.overlays)
                // The rescale's view set belongs to the annotations about to be
                // replaced. MapKit hands back the ones it puts on the map next
                // (`didAdd`), so clearing here is what keeps the set the CURRENT
                // marks rather than every mark this map has ever shown.
                displayedAnnotationViews.removeAllObjects()
                if !networkAnnotations.isEmpty { mapView.removeAnnotations(networkAnnotations) }
                networkAnnotations = []
                if !rideStationAnnotations.isEmpty { mapView.removeAnnotations(rideStationAnnotations) }
                rideStationAnnotations = []
                if !endpointAnnotations.isEmpty { mapView.removeAnnotations(endpointAnnotations) }
                endpointAnnotations = []
                overlayStyles.removeAll(keepingCapacity: true)
                overlayRenderers.removeAll(keepingCapacity: true)
                if basemapOpacity < 0.999 {
                    let corners = [
                        MKMapPoint(x: buildRect.minX, y: buildRect.minY),
                        MKMapPoint(x: buildRect.maxX, y: buildRect.minY),
                        MKMapPoint(x: buildRect.maxX, y: buildRect.maxY),
                        MKMapPoint(x: buildRect.minX, y: buildRect.maxY),
                    ].map(\.coordinate)
                    let veil = MKPolygon(coordinates: corners, count: corners.count)
                    veil.title = "basemap-veil"
                    mapView.addOverlay(veil, level: .aboveRoads)
                }
                var overlays: [MKMultiPolyline] = []
                for (key, polylines) in byColor {
                    let multi = MKMultiPolyline(polylines)
                    let styleKey = "network|\(key)"
                    multi.title = styleKey
                    overlayStyles[styleKey] = OverlayStyle(
                        color: colors[key] ?? .systemGray,
                        // The rail stroke is a quarter of the station dot, and it
                        // is a TOKEN — the full-scale weight, not the drawn one.
                        // The previous fixed 1.5 pt drew a nationwide Japan as one
                        // fused mass of railway, which is the thing the ramp
                        // exists to prevent.
                        widthToken: RailStyle.railWidth,
                        alpha: RailStyle.networkOpacity
                    )
                    overlays.append(multi)
                }
                mapView.addOverlays(overlays, level: .aboveRoads)

                // A ride's stroke: the seed weight, the reader's 線路粗細
                // multiplier, the focus boost when it is the selected one, and
                // then RIDDEN_WIDTH_SCALE — in that order, because the boost is a
                // width the reader chose and not a proportion of one.
                func rideWidthToken(selected: Bool) -> CGFloat {
                    let seed = RailStyle.riddenWidth * CGFloat(display.routeWidthScale)
                    let focused = selected ? CGFloat(display.focusBoost) : 0
                    return (seed + focused) * RailStyle.riddenWidthScale
                }
                // The two scopes a ride's stroke answers to, both ported in
                // `MapDateScope`: the SELECTION spotlight, and the DATE scope
                // the reader set on the ride list. `dimOpacity` finally has a
                // subject — an off-date ride draws faint rather than
                // disappearing, which is what makes the slider a control over
                // something.
                let hasSelection = rides.contains { $0.id == selectedTrainID }
                let scope = dateScope
                func rideAlpha(_ ride: RiddenRouteStore.DrawnRide, selected: Bool) -> CGFloat {
                    MapDateScope.alpha(
                        own: CGFloat(display.riddenOpacity), span: ride.daySpan,
                        scope: scope, isSelected: selected, hasSelection: hasSelection)
                }

                var rideCasings: [MKMultiPolyline] = []
                var rideOverlays: [MKMultiPolyline] = []
                // 列車路線 off draws no route lines and leaves every station
                // dot alone — `RailMap.setVisible` moves the route, cross-day,
                // hover and selection layers and no marker layer at all.
                let orderedRides = layers.routes
                    ? rides.sorted { left, right in
                        left.id != selectedTrainID && right.id == selectedTrainID
                    }
                    : []
                for (index, ride) in orderedRides.enumerated() {
                    // Split by the calendar day each SEGMENT runs on, which is
                    // why the strokes are taken from `segments` rather than
                    // from `strokes`: `Dates.segmentDate` needs the segment's
                    // own index and the flattened list has thrown it away.
                    var solid: [MKPolyline] = []
                    var crossDay: [MKPolyline] = []
                    let riddenStops = MapRideMarkers.rideFlags(ride.stops)
                    for segment in ride.segments {
                        // 已乘路線顯示: a segment whose category the reader has
                        // switched off is not drawn. Per SEGMENT rather than
                        // per journey, because that is the granularity the web
                        // app classifies at — a 新幹線 run with a metro leg on
                        // the end loses the leg, not the run.
                        guard draws(segment: segment, of: ride, riddenStops: riddenStops)
                        else { continue }
                        let stroke = segment.coordinates
                        guard stroke.count >= 2 else { continue }
                        // Straight off the ride's own coordinates. Rule R14 is
                        // withdrawn (commit 38cf0a8): a drawn vertex is the
                        // surveyed vertex, so nothing between here and the
                        // renderer may move one sideways. Decimation is allowed
                        // because it only ever DROPS vertices, and only ones
                        // that cannot move the line by more than the shared
                        // `RailStyle.simplifyTolerance` the network is held to.
                        let kept = Geometry.douglasPeuckerIndices(stroke, epsilonMeters: epsilon)
                        let points = kept.map { stroke[$0].clLocation }
                        guard points.count >= 2 else { continue }
                        let polyline = MKPolyline(coordinates: points, count: points.count)
                        if MapDateScope.isCrossDayContinuation(
                            ride.daySpan, segmentIndex: segment.segmentIndex, scope: scope) {
                            crossDay.append(polyline)
                        } else {
                            solid.append(polyline)
                        }
                    }
                    guard !solid.isEmpty || !crossDay.isEmpty else { continue }
                    let selected = ride.id == selectedTrainID
                    let color = Self.uiColor(hex: ride.colorHex) ?? .systemBlue
                    let width = rideWidthToken(selected: selected)
                    let alpha = rideAlpha(ride, selected: selected)

                    // Same source, same colour, same width — only the stroke
                    // pattern says "not this day" (`TRAIN_XDAY_LAYER`).
                    for (suffix, polylines, dashed) in [
                        ("ride", solid, false), ("ride-xday", crossDay, true),
                    ] where !polylines.isEmpty {
                        let styleKey = "\(suffix)|\(index)|\(ride.id)"
                        let multi = MKMultiPolyline(polylines)
                        multi.title = styleKey
                        overlayStyles[styleKey] = OverlayStyle(
                            color: color, widthToken: width, alpha: alpha, dashed: dashed)
                        rideOverlays.append(multi)

                        // §10.5: a selection has to change more than a colour.
                        // The casing is a dark halo UNDER the selected line,
                        // 0.7 pt per side at full scale — Apple's restrained
                        // selected-transit outline rather than a glow — and it
                        // rides the same ramp, or "selected" would read
                        // differently at every zoom. It follows the dash too:
                        // a solid casing under a dashed core would fill the
                        // gaps back in and undo the distinction.
                        guard selected else { continue }
                        let casingKey = "\(suffix)-casing|\(index)|\(ride.id)"
                        let casing = MKMultiPolyline(polylines)
                        casing.title = casingKey
                        overlayStyles[casingKey] = OverlayStyle(
                            // `MAP_SURFACE_COLORS[theme].casing`, the same two
                            // values the web app's selection halo uses.
                            color: Self.uiColor(hex: dark ? "#F5EEE9" : "#1A1A1A") ?? .label,
                            widthToken: width + RailStyle.selectionCasingEdge * 2,
                            alpha: 0.9,
                            dashed: dashed
                        )
                        rideCasings.append(casing)
                    }
                }
                // Casings first so the coloured cores land on top of them.
                mapView.addOverlays(rideCasings, level: .aboveRoads)
                mapView.addOverlays(rideOverlays, level: .aboveRoads)

                // One place, one name.
                //
                // Three things on this map name stations — an endpoint card, a
                // ride's own caption beside its dot, and the network's own
                // label — and each used to decide alone, so a station that was
                // all three printed its name three times: 我孫子 on the card,
                // 我孫子 beside the dot, 我孫子 again from the network under
                // them. They are ranked rather than merged, most specific
                // first: the card, which also carries the time; then the
                // journey's caption; then the network's. Whichever reaches a
                // place first claims it and the rest stay quiet.
                //
                // A "place" is a name within `labelMergeMeters` of a name, not
                // a coordinate — 東京's JR and Metro platforms are hundreds of
                // metres apart and both name the same place, which is the rule
                // the two label ELECTIONS already merge on
                // (`StationDisplay.markerLabelWinners`). Comparing coordinates
                // would leave exactly those pairs doubled.
                var namedPlaces: [String: [Coordinate]] = [:]
                func claimName(_ name: String, at position: Coordinate) -> Bool {
                    let key = Stations.normalizeStationName(name)
                    guard !key.isEmpty else { return false }
                    if let taken = namedPlaces[key], taken.contains(where: {
                        Geometry.distanceMeters($0, position) <= Self.labelMergeMeters
                    }) { return false }
                    namedPlaces[key, default: []].append(position)
                    return true
                }

                // The cards are built here, ahead of every dot, because they
                // hold the first claim on a name. They are still ADDED last,
                // where they always were.
                let endpointSpecList = endpointSpecs()
                for spec in endpointSpecList {
                    _ = claimName(spec.rawName, at: spec.coordinate)
                }

                // 選了一條線路之後，站名只屬於它 — and that cannot be had by
                // filtering the deck-wide election by `tid`. A station two
                // rides both call at hands its name to whichever record
                // arrived first (`markerLabelWinners` resolves ties by
                // arrival), so filtering afterwards would leave the selected
                // ride unnamed at exactly its busiest stations. The election is
                // re-run over that ride's own records instead.
                var selectedRideNames: Set<String> = []
                if let ride = rides.first(where: { $0.id == selectedTrainID }) {
                    selectedRideNames = namedRecordKeys(of: ride, settings: display.markers)
                }

                // Every visible ride's calls, flattened into the deck marker
                // records `RailCore.StationDisplay` already knows how to elect
                // names for. Not just the selected ride's: the election exists
                // because a station reached by twenty trains ships twenty records
                // that all know the same name, and only one of them may print it.
                let drawn = markerRecords(for: rides, settings: display.markers)
                // A journey every one of whose ridden segments is switched off
                // by category loses its station dots with its line. Its beads
                // would otherwise be left floating over a route that is not
                // drawn, which reads as a fault rather than as a filter.
                //
                // The web app decides this per STATION, from the line
                // attributes its own station dataset repeats on every station
                // (`markerCategoryForStation`). The ride markers here are
                // built from the journey's stops, which carry no such
                // attributes, so the decision is made at the journey's
                // granularity instead: a dot is kept whenever any part of the
                // line it sits on is still drawn.
                var fullyHiddenRides: Set<String> = []
                if layers.categories.anyHidden {
                    for ride in rides {
                        let riddenStops = MapRideMarkers.rideFlags(ride.stops)
                        let ridden = ride.segments.filter {
                            Statistics.isRideSegment(
                                riddenStops, segmentIndex: $0.segmentIndex)
                        }
                        guard !ridden.isEmpty,
                            ridden.allSatisfy({
                                !draws(segment: $0, of: ride, riddenStops: riddenStops)
                            })
                        else { continue }
                        fullyHiddenRides.insert(ride.id)
                    }
                }
                // Each role has its own floor: terminals and cross-day breaks
                // at every zoom, intermediate stops from `STOP_MIN_ZOOM`, the
                // numerous pass-throughs only from `PASSTHROUGH_MIN_ZOOM`. So
                // pulling back sheds pass-throughs first and stops second,
                // while a ride's two ends — the whole of what it says at a
                // national view — never leave.
                var markerAnnotations: [MKAnnotation] = []
                var lastEmitted: RideStationAnnotation?
                for item in drawn {
                    let record = item.record
                    let feature = item.feature
                    // 中途停靠站 / 端點站 / 通過站, and the categories above.
                    // `lastEmitted` is cleared on the way out so a dropped
                    // dot's black core cannot land inside the previous dot.
                    guard layers.draws(role: feature.role),
                        !fullyHiddenRides.contains(feature.tid) else {
                        lastEmitted = nil
                        continue
                    }
                    guard MapRideMarkers.drawsDot(item, atZoom: zoom)
                            || feature.role == "stop-center" else {
                        lastEmitted = nil
                        continue
                    }
                    if feature.role == "stop-center" {
                        // MapKit draws one view per annotation, so the black core
                        // goes INSIDE the dot it sits in rather than on a second
                        // annotation at the same point — two annotations one point
                        // apart would fight the collision pass over a mark that is
                        // not even pickable. The record is still emitted, so the
                        // record set and its indices stay the web app's.
                        lastEmitted?.core = RideStationAnnotation.Core(
                            radius: CGFloat(feature.radius),
                            focusScale: CGFloat(feature.focusScale),
                            color: Self.uiColor(channels: record.fillColor) ?? .black)
                        continue
                    }
                    lastEmitted = nil
                    guard buildRect.contains(MKMapPoint(record.position.clLocation)) else { continue }
                    let selected = feature.tid == selectedTrainID
                    let annotation = RideStationAnnotation(
                        coordinate: record.position.clLocation,
                        name: feature.name,
                        rawName: record.name,
                        stationCode: item.stationCode,
                        role: feature.role,
                        radius: CGFloat(feature.radius),
                        lineWidth: CGFloat(feature.lineWidth),
                        focusScale: CGFloat(feature.focusScale),
                        fill: Self.uiColor(channels: record.fillColor) ?? .white,
                        stroke: Self.uiColor(channels: record.lineColor) ?? .black,
                        // The record's OWN alpha, put through the same two
                        // scopes the ride's stroke goes through — a dot on an
                        // off-date ride dims with the line it sits on.
                        alpha: CGFloat(feature.alpha) * MapDateScope.alpha(
                            own: 1, span: item.daySpan, scope: scope,
                            isSelected: selected, hasSelection: hasSelection),
                        focusBoost: CGFloat(display.focusBoost),
                        selected: selected)
                    markerAnnotations.append(annotation)
                    lastEmitted = annotation
                    // …and its name, if it won one and the view is wide enough for
                    // its tier. Each floor is a hard gate rather than a fade,
                    // because a zero-opacity label would still hold its space in
                    // the collision pass and silently suppress a name that IS
                    // shown — the finding recorded on `RideLabelTier`.
                    //
                    // Which election answers depends on whether the reader has
                    // chosen a journey: with none chosen the deck-wide one
                    // does, and with one chosen only that ride's own names are
                    // drawn at all — every other journey's captions and the
                    // whole network's labels go quiet, so what is left on the
                    // map is the chosen line and the stations along it.
                    let labelName = hasSelection
                        ? (selected && selectedRideNames.contains(Self.markerKey(record))
                            ? record.name : "")
                        : feature.name
                    guard !labelName.isEmpty, let tier = annotation.labelTier,
                          zoom >= RailStyle.zoom(fromMapLibre: Double(tier.minZoom)),
                          // …and if this place is not already named by an
                          // endpoint card or by another journey's caption.
                          claimName(labelName, at: record.position)
                    else { continue }
                    // The election runs on the package's own names — see
                    // `markerRecords` — and only the winner is translated, so
                    // which record carries a name never depends on the
                    // reader's language.
                    markerAnnotations.append(RideLabelAnnotation(
                        coordinate: annotation.coordinate,
                        text: localized(labelName, code: item.stationCode).display,
                        rawName: record.name, stationCode: item.stationCode,
                        tier: tier, dotRadiusToken: annotation.drawnRadiusToken,
                        selected: annotation.selected))
                }
                rideStationAnnotations = markerAnnotations

                // The network's own station names come LAST, after every name
                // the reader's journeys have already claimed — which is why
                // this block moved down here from above the ride markers. It
                // is the most general of the three sources and therefore the
                // one that yields: a station on a journey is named by the
                // journey, and the network names everything else.
                //
                // `layers.networkStations` is read UNDER `showsNetwork` rather
                // than beside it: with the network off there is no line for a
                // station to sit on, so the dots go with it either way.
                if showsNetwork, layers.networkStations {
                    // `DrawnStation.minZoom` is a MapLibre number, so it has to
                    // be read against a MapLibre zoom. Compared against this
                    // app's zoom it fired one level early, which at a city view
                    // is not a subtlety: jp drew 3,963 dots where the web app
                    // draws 348.
                    let stationZoom = RailStyle.mapLibreZoom(from: zoom)
                    let stationAnnotations = stations.compactMap { station -> StationAnnotation? in
                        guard Double(station.minZoom) <= stationZoom else { return nil }
                        let point = MKMapPoint(station.coordinate.clLocation)
                        guard buildRect.contains(point) else { return nil }
                        // `buildStationPopupModel` keys its readings on the
                        // platform's OWN id (`lineId:stationId`), which the
                        // four localised-name tables carry alongside the
                        // official code; Japan's table has neither, and falls
                        // through to the by-name lookup exactly as it does in
                        // the web app.
                        let named = self.localized(station.name, code: station.id)
                        return StationAnnotation(
                            station: station, displayName: named.display,
                            // The name switch is folded in HERE rather than in
                            // the view, so the annotation's display priority is
                            // computed from what will actually be printed. A
                            // dot that keeps a named station's priority while
                            // drawing no name wins collisions it should have
                            // lost, and the labels that do draw get thinned
                            // out around it.
                            //
                            // Two more conditions join it. A chosen journey
                            // takes the map's naming for itself, so the whole
                            // network goes unnamed while one is selected; and
                            // otherwise a name already claimed by a journey's
                            // own caption is not written a second time.
                            showsName: layers.networkStationNames && station.showsLabel
                                && !hasSelection
                                && claimName(station.name, at: station.coordinate),
                            // `nil` is the standalone case — no localisation
                            // engine at all — which is what keeps the single
                            // `nameRoma` subline. See `StationCardView`.
                            readings: self.localization == nil
                                ? nil : named.readings.map(\.text))
                    }
                    networkAnnotations = stationAnnotations
                    mapView.addAnnotations(stationAnnotations)
                }
                mapView.addAnnotations(markerAnnotations)

                // The selected ride's origin / destination cards, and — when a
                // day is in scope — that DAY's first origin and last
                // destination with a 起點/終點 badge, which is `updateEndpointLabels`
                // step (1). `computeScopedEndpoints` is not ported: the scoped
                // pair is derived here from the rides the map already holds.
                endpointAnnotations = endpointSpecList.map(EndpointLabelAnnotation.init)
                if !endpointAnnotations.isEmpty {
                    mapView.addAnnotations(endpointAnnotations)
                    layoutEndpointLabels(on: mapView)
                }

                if let lastPlaybackSnapshot {
                    paintPlayback(lastPlaybackSnapshot, on: mapView, applyCamera: false)
                }

                let elapsed = ContinuousClock.now - started
#if DEBUG
                // Debug builds only, and that is not tidiness.
                //
                // This sits on the map REBUILD path — every pan that crosses a
                // LOD threshold, every zoom step, every ride edit — and `NSLog`
                // is synchronous: it formats, takes a lock, writes to the
                // unified log AND to stderr, on the main thread, before the
                // frame it belongs to can be presented. Seven of these fire in
                // the first second of launch alone.
                //
                // Nothing is lost by gating it. The same numbers are handed
                // back as `RenderStats` immediately below, which is what the
                // diagnostics panel in Settings reads — so the data has a
                // supported in-app home on every build, and this line is only
                // the console mirror of it.
                // "off", not "0", when the complete network is switched off.
                //
                // The count and the reason for it are different facts, and this
                // line reported only the count: a map with the network layer
                // off — which is how the app STARTS, `showsNetwork` defaults to
                // false — printed `lines=0/804` on every pan, which reads as
                // eight hundred lines being dropped by the LOD rule. The
                // difference between "nothing qualified" and "nobody asked" is
                // the whole diagnostic value of the field.
                let drawnLines = showsNetwork ? "\(visible.count)" : "off"
                NSLog(
                    "railmap: z=%.2f thr=%.1f lines=%@/%d (culled %d) overlays=%d vertices=%d "
                        + "stations=%d ridedots=%d ridelabels=%d %dms",
                    zoom, fitted.threshold, drawnLines, lines.count,
                    selection?.culledOffScreen ?? 0,
                    overlays.count + rideOverlays.count + rideCasings.count,
                    vertices,
                    networkAnnotations.count,
                    rideStationAnnotations.filter { $0 is RideStationAnnotation }.count,
                    rideStationAnnotations.filter { $0 is RideLabelAnnotation }.count,
                    elapsed.milliseconds)
#endif
                // Deferred: a rebuild can be triggered from inside updateUIView,
                // and writing SwiftUI state during a view update is undefined
                // behaviour — in practice the panel simply never showed the
                // numbers. Hand them back on the next turn of the loop instead.
                let stats = RenderStats(
                    zoom: zoom,
                    visibleLines: visible.count,
                    overlays: overlays.count + rideOverlays.count + rideCasings.count,
                    vertices: vertices,
                    buildMilliseconds: elapsed.milliseconds,
                    culledOffScreen: selection?.culledOffScreen ?? 0,
                    threshold: fitted.threshold
                )
                DispatchQueue.main.async { [onRender] in onRender(stats) }
            }

            /// The marker records, built once per ride set rather than per pan.
            ///
            /// `buildDeckMarkerRecords` is documented SELECTION-INDEPENDENT and
            /// nothing in it reads the zoom, so the record set only changes with
            /// the rides and the 顯示調節 sizes — while `rebuild` also runs
            /// whenever the map is panned out of the rect it was built for. The
            /// name election walks every ride's every call, so re-running it on a
            /// pan would be the most expensive thing a pan does.
            private var markerCache:
                (key: String, settings: MapRideMarkers.Settings, drawn: [MapRideMarkers.Drawn])?

            /// Whether one drawn segment's ridden-line category is switched on.
            ///
            /// Three ways to be visible without being classified, all of them
            /// the web app's: every category is on and nothing is classified
            /// at all; this region's edge index has not been built yet; or the
            /// index was consulted and none of the segment matched the
            /// network, which is undetermined rather than uncategorised.
            ///
            /// Only a RIDDEN section is filtered — `app-deck-records.js` reads
            /// `ride_segment === true` before it asks — so a stretch the
            /// reader travelled without riding keeps drawing whatever the
            /// checkboxes say.
            private func draws(
                segment: RiddenRouteStore.DrawnSegment,
                of ride: RiddenRouteStore.DrawnRide,
                riddenStops: [Statistics.Stop]
            ) -> Bool {
                guard layers.categories.anyHidden,
                    Statistics.isRideSegment(
                        riddenStops, segmentIndex: segment.segmentIndex)
                else { return true }

                let key = "\(ride.id)#\(segment.segmentIndex)"
                if let cached = segmentCategories[key] {
                    return cached.isEmpty || layers.categories[cached]
                }
                guard let index = categoryIndexes[ride.country] else { return true }
                let category = Statistics.riddenFeatureCategory(
                    Statistics.RouteFeature(
                        // Statistics and the edge index both remain WGS84;
                        // MapKit's GCJ-02 copy is presentation data only.
                        lines: [segment.sourceCoordinates], hasGeometry: true,
                        rideSegment: true, from: segment.from, to: segment.to),
                    index: index, country: ride.country)
                segmentCategories[key] = category ?? ""
                guard let category else { return true }
                return layers.categories[category]
            }

            private func markerRecords(
                for rides: [RiddenRouteStore.DrawnRide], settings: MapRideMarkers.Settings
            ) -> [MapRideMarkers.Drawn] {
                let key = rides.map(Self.rideSignature).joined(separator: "|")
                if let markerCache, markerCache.key == key, markerCache.settings == settings {
                    return markerCache.drawn
                }
                let drawn = MapRideMarkers.drawn(rides: rides, settings: settings)
                markerCache = (key, settings, drawn)
                return drawn
            }

            /// One marker record's identity, as the two elections' results can
            /// be compared across: its place and the name it carries.
            ///
            /// The role is deliberately not in it. A record that carries a name
            /// is never a `stop-center` — those are unnamed by construction —
            /// so place and name already single one out, and leaving the role
            /// out means a station whose role differs between the two elections
            /// still matches itself.
            static func markerKey(_ record: StationDisplay.MarkerRecord) -> String {
                "\(record.position.lat)|\(record.position.lon)|\(record.name)"
            }

            /// Which of ONE ride's records win a name among that ride's records
            /// alone — the election a selection restricts the map's naming to.
            ///
            /// Cached separately from `markerCache` rather than by calling
            /// `markerRecords` with a one-ride list: the two calls alternate
            /// every rebuild, and a single slot would mean each of them evicting
            /// the other's answer and the deck-wide election — the most
            /// expensive thing a pan does — running again on every pan.
            private var selectedNameCache:
                (key: String, settings: MapRideMarkers.Settings, keys: Set<String>)?

            private func namedRecordKeys(
                of ride: RiddenRouteStore.DrawnRide, settings: MapRideMarkers.Settings
            ) -> Set<String> {
                let key = Self.rideSignature(ride)
                if let selectedNameCache, selectedNameCache.key == key,
                    selectedNameCache.settings == settings {
                    return selectedNameCache.keys
                }
                var keys: Set<String> = []
                for item in MapRideMarkers.drawn(rides: [ride], settings: settings)
                where !item.feature.name.isEmpty {
                    keys.insert(Self.markerKey(item.record))
                }
                selectedNameCache = (key, settings, keys)
                return keys
            }

            /// How near two same-named labels have to be to be one place.
            ///
            /// `StationDisplay.labelMergeMeters`, which is internal to
            /// `RailCore`; the number is the web app's own and both label
            /// elections merge on it, so the cross-source claim above uses the
            /// same one rather than inventing a second distance.
            static let labelMergeMeters: Double = 600

            // MARK: - the origin / destination cards

            /// `computeScopedEndpoints` — the rides that own the selected
            /// day's first origin and last destination.
            ///
            /// The web app orders by position in `trainStore.trains`, which is
            /// the reader's own trip order; `rides` arrives here in that order,
            /// so first and last are literally that. The day's own trains are
            /// preferred and the whole trip stands in when the day has none,
            /// which is the JavaScript's fallback.
            private func scopedEndpointRides()
                -> (first: RiddenRouteStore.DrawnRide, last: RiddenRouteStore.DrawnRide)? {
                let visible = rides.filter(\.visible)
                let day = visible.filter { $0.daySpan.date == selectedDate }
                let pool = day.isEmpty ? visible : day
                guard let first = pool.first, let last = pool.last else { return nil }
                return (first, last)
            }

            /// `updateEndpointLabels` — its two sources, in its own order.
            private func endpointSpecs() -> [MapEndpointLabels.Spec] {
                var specs: [MapEndpointLabels.Spec] = []
                var seen: Set<String> = []
                func add(_ spec: MapEndpointLabels.Spec?) {
                    guard let spec, seen.insert(spec.key).inserted else { return }
                    specs.append(spec)
                }
                let scope = dateScope
                // (1) The selected day's very first origin and very last
                // destination are ALWAYS labelled, so picking a date
                // immediately shows where that day begins and ends.
                if scope.isActive, let pair = scopedEndpointRides() {
                    add(endpointSpec(for: pair.first, kind: .origin, dayEndpoint: true))
                    add(endpointSpec(for: pair.last, kind: .destination, dayEndpoint: true))
                }
                // (2) …and the selected ride keeps its own two ends.
                guard let ride = rides.first(where: { $0.id == selectedTrainID }), ride.visible
                else { return specs }
                // A cross-day ride is on-date for BOTH of the days it runs on,
                // so its cards must not vanish while its line is still drawn.
                guard MapDateScope.inScope(ride.daySpan, scope) else { return specs }
                add(endpointSpec(for: ride, kind: .origin))
                add(endpointSpec(for: ride, kind: .destination))
                return specs
            }

            /// `buildEndpointLabelSpec`, with the four pieces resolved.
            private func endpointSpec(
                for ride: RiddenRouteStore.DrawnRide,
                kind: MapEndpointLabels.Kind,
                dayEndpoint: Bool = false
            ) -> MapEndpointLabels.Spec? {
                guard let endpoint = MapEndpointLabels.endpointStop(of: ride, kind: kind)
                else { return nil }
                let named = localized(endpoint.stop.name, code: endpoint.stop.n02StationCode)
                // An origin shows when the ride LEFT and a destination when it
                // arrived — never both, because a card that showed both would
                // be describing the timetable rather than the journey's end.
                let clock = kind == .origin ? endpoint.stop.departure : endpoint.stop.arrival
                let tag = kind == .origin ? naming.departureTag : naming.arrivalTag
                let time = (clock?.isEmpty == false) ? "\(tag) \(clock!)" : ""
                let badge = dayEndpoint
                    ? (kind == .origin ? naming.startTag : naming.endTag) : ""
                return MapEndpointLabels.spec(
                    trainID: ride.id, kind: kind, at: endpoint.position,
                    name: named.display, rawName: endpoint.stop.name,
                    badge: badge, time: time,
                    readings: named.readings.map(\.text))
            }

            /// Re-runs the endpoint cards' overlap-avoidance layout.
            ///
            /// Pure pixel-space work, so it has to be redone whenever the
            /// projection moves — which is what the web app's re-run on
            /// `zoomend` / `moveend` is. It is at most two boxes, and MapKit keeps
            /// each card anchored to its own coordinate on its own, so nothing
            /// here runs during a pan.
            private func layoutEndpointLabels(on mapView: MKMapView) {
                guard !endpointAnnotations.isEmpty else { return }
                var specs = endpointAnnotations.map(\.spec)
                let points = specs.map {
                    mapView.convert($0.coordinate.clLocation, toPointTo: mapView)
                }
                MapEndpointLabels.layout(&specs, at: points)
                for index in specs.indices {
                    MapEndpointLabels.clampHorizontally(
                        &specs[index], at: points[index],
                        containerWidth: mapView.bounds.width)
                    // Placement is all `layout` and `clampHorizontally` touch;
                    // the text, the readings and the measured box are the ones
                    // the spec was built with. `configure` re-measures three
                    // labels and every reading with `sizeThatFits`, and this
                    // pass now runs on every frame of a pan (see
                    // `mapViewDidChangeVisibleRegion`) — so a card that did
                    // not move must not pay for it.
                    //
                    // Safe to skip because nothing else about the spec can have
                    // changed here: a rebuild REPLACES these annotations, and
                    // `mapView(_:viewFor:)` configures the fresh view with the
                    // fresh text before this pass ever sees it.
                    let placed = endpointAnnotations[index].spec
                    guard placed.direction != specs[index].direction
                        || placed.offset != specs[index].offset
                    else { continue }
                    endpointAnnotations[index].spec = specs[index]
                    (mapView.view(for: endpointAnnotations[index]) as? EndpointLabelView)?
                        .configure(endpointAnnotations[index])
                }
            }

            @objc func handleMapTap(_ recognizer: UITapGestureRecognizer) {
                guard recognizer.state == .ended, let mapView,
                      lastPlaybackSnapshot == nil else { return }
                let point = recognizer.location(in: mapView)
                // Projection here, arithmetic in `RideTapResolver`.
                //
                // Every ride under the finger is handed up, not just the
                // nearest: `railmap-interactions.js` can afford to pick one
                // because a mouse hovers first and the reader sees which line
                // is about to be chosen, while a finger commits on contact —
                // so the web app hands a coarse-pointer tap over crossing
                // lines to `handleDeckRouteChoices` and asks. One ride
                // selects, several are offered, none steps back (§4.4).
                let candidates = rides.map { ride in
                    RideTapResolver.Candidate(
                        id: ride.id,
                        strokes: ride.strokes.map { stroke in
                            stroke.map { coordinate in
                                let projected = mapView.convert(
                                    coordinate.clLocation, toPointTo: mapView)
                                return RideTapResolver.Point(
                                    x: projected.x, y: projected.y)
                            }
                        })
                }
                let hits = RideTapResolver.hits(
                    at: RideTapResolver.Point(x: point.x, y: point.y),
                    among: candidates)
                // The touch is CLAIMED when it lands on a ride, and the claim
                // is what `mapView(_:didSelect:)` reads half a second later.
                // See the comment there: this map answers a tap twice
                // otherwise.
                if !hits.isEmpty { rideAnsweredTap = .now }
                onSelectRide(hits)
            }

            func gestureRecognizer(
                _ gestureRecognizer: UIGestureRecognizer,
                shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
            ) -> Bool { true }

            /// The pinch and pan sensors added in `makeUIView`. They exist to
            /// answer one question — is a finger moving the map right now — and
            /// they answer it by their own `state`, so nothing has to be
            /// mirrored into a flag that can be left behind by a cancelled
            /// touch.
            var manipulationSensors: [UIGestureRecognizer] = []

            /// True while at least one sensor is mid-gesture.
            ///
            /// Read inside a sensor's own callback as well, where the
            /// recogniser that just ended already reports `.ended` — so a pinch
            /// releasing while the other hand still pans correctly stays
            /// manipulating.
            private var isManipulating: Bool {
                manipulationSensors.contains {
                    $0.state == .began || $0.state == .changed
                }
            }

            /// Set when a region change arrived mid-gesture and its rebuild was
            /// held back, so the release knows there is one owing.
            private var rebuildDeferredByGesture = false

            @objc func handleManipulation(_ recognizer: UIGestureRecognizer) {
                switch recognizer.state {
                case .ended, .cancelled, .failed:
                    guard !isManipulating, rebuildDeferredByGesture, let mapView else { return }
                    rebuildDeferredByGesture = false
                    // The map may still be gliding to a stop, and its own
                    // settled callback will arrive when it is. Building here as
                    // well is what makes the release feel immediate; the second
                    // one costs nothing, because `rebuild`'s guard answers
                    // "same zoom tier, still inside the built rect".
                    rebuild(on: mapView)
                default:
                    break
                }
            }

            /// Every view MapKit has just put on the map, collected for
            /// ``displayedAnnotationViews``.
            func mapView(_ mapView: MKMapView, didAdd views: [MKAnnotationView]) {
                for view in views { displayedAnnotationViews.add(view) }
            }

            /// A tap that landed on a MARK belongs to that mark.
            ///
            /// The recogniser is attached to the map view, so it also fires for
            /// touches inside annotation views — and every dot a ride puts on a
            /// station sits on that ride's own stroke. Without this, opening a
            /// station's card from one would select the journey underneath at
            /// the same time: two answers to one tap, and where two journeys
            /// call at the station, `handleDeckRouteChoices`' chooser and the
            /// card both trying to be presented at once — a `confirmationDialog`
            /// and a `sheet` asked for in the same frame.
            ///
            /// A deviation from `handleDeckMarkerClick`, which selects the
            /// marker's train as well as opening its popup, and a deliberate
            /// one. That popup is the web app's stop DATA grid — train id, stop
            /// type, `ride_segment`, route source — which is about the journey
            /// it belongs to and reasonably comes with it selected. What opens
            /// here is the station's own card, which is about the place: the
            /// same answer whichever journey called there, and not a reason to
            /// move the reader's selection, their camera (自動縮放) and the
            /// map's whole naming out from under the sheet as it appears.
            ///
            /// The origin/destination cards are unaffected and stay transparent
            /// to route picking, because `EndpointLabelView` turns interaction
            /// off — a touch on one is delivered as a touch on the map, and this
            /// asks the touch where it landed rather than asking the map what is
            /// drawn there.
            func gestureRecognizer(
                _ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch
            ) -> Bool {
                // Only the tap asks where it landed. The manipulation sensors
                // want every touch that moves the map, and a pinch very often
                // starts with a finger on a station bead.
                guard gestureRecognizer is UITapGestureRecognizer else { return true }
                // A new touch has been given no answer yet, whichever of the
                // two answers it ends up getting (`mapView(_:didSelect:)`).
                rideAnsweredTap = nil
                var view = touch.view
                while let current = view {
                    if current is MKAnnotationView { return false }
                    view = current.superview
                }
                return true
            }

            /// What one overlay is drawn with — a colour, an opacity, and a weight
            /// expressed as its FULL-SCALE token rather than as points on screen.
            ///
            /// Storing the token is the whole of the weight contract on this side:
            /// nothing here may hold a width that has already had a ramp applied
            /// to it, because then a rescale would have to know which factor to
            /// divide out. ``drawnWidth(_:atScale:)`` is the only place a token
            /// becomes points.
            private struct OverlayStyle {
                var color: UIColor
                var widthToken: CGFloat
                var alpha: CGFloat
                /// Dashed strokes carry the pair in LINE WIDTHS, so it is derived
                /// from the token and needs no ramp of its own — the same factor
                /// carries dash and stroke down together.
                var dashed = false
            }

            private var overlayStyles: [String: OverlayStyle] = [:]
            /// The renderers MapKit built, so a rescale can reach them. MapKit
            /// caches what `rendererFor` returns and never asks again, so a width
            /// written into `overlayStyles` after the fact would never be drawn.
            private var overlayRenderers: [String: MKOverlayRenderer] = [:]

            /// The annotation views MapKit currently has on the map, kept so a
            /// rescale does not have to ASK for each of them.
            ///
            /// `restyle` runs on every frame of a pinch, and it used to reach
            /// each mark with `mapView.view(for: annotation)`. That call is
            /// roughly 0.15–0.25 ms, which reads as free until you count the
            /// callers: a national view is ~535 station beads and ~390 ride
            /// dots, so the lookups alone cost **219 ms per frame** — measured,
            /// with the loop that writes every renderer's width and dash
            /// pattern costing 0 ms beside them. A pinch over Japan ran at two
            /// to four frames a second and the map visibly lagged the fingers.
            ///
            /// MapKit hands every view it puts on the map to `didAdd`, so the
            /// set is free to collect. It is WEAK: MapKit owns the views, may
            /// recycle one for another annotation and may drop it outright, and
            /// none of that is reported — so membership is not proof a view is
            /// still on screen, which is why the rescale also checks `window`.
            /// A recycled view answering to its new annotation is still exactly
            /// the view that wants the new scale.
            private let displayedAnnotationViews = NSHashTable<MKAnnotationView>.weakObjects()

            private static func drawnWidth(_ style: OverlayStyle?, atScale scale: CGFloat) -> CGFloat {
                (style?.widthToken ?? RailStyle.railWidth) * scale
            }

            /// Re-applies the one shared factor to everything already on screen.
            ///
            /// Cheap by construction: the strokes are a handful of renderers, the
            /// dots are only those MapKit is currently showing a view for, and the
            /// whole pass is skipped unless the factor actually moved. Above the
            /// anchor zoom it is pinned at 1, so city views never rescale at all.
            private func restyle(on mapView: MKMapView) {
                guard mapView.bounds.width > 1 else { return }
                // Once, not twice: this now runs on every frame of a pan or a
                // camera flight (see `mapViewDidChangeVisibleRegion`), and the
                // annotation pass below used to derive the same number a
                // second time.
                let zoom = Self.zoomLevel(of: mapView)
                // QUANTISED, and everything below is drawn from these rather
                // than from the raw pair.
                //
                // The factor is continuous in zoom, so on every frame of a
                // pinch it is a slightly different number — and a slightly
                // different number relaid out 557 station beads that were
                // already drawn at the width the new one rounds to. The map
                // paid ~87 ms a frame to change nothing a reader could see.
                //
                // A step is one device pixel on the widest mark the factor
                // drives, and a sixteenth of a zoom level on the label ramp
                // (which climbs 10 pt → 12 pt over four levels, so a step is
                // 1/32 pt of type). Both are below what the screen can show,
                // which is the whole argument: the ramp still runs on every
                // frame — §9.1's intermediate frames still explain the change —
                // it just stops re-running for differences that round away.
                let scale = Self.quantised(RailStyle.scale(atZoom: zoom), on: mapView)
                let markZoom = (zoom * 16).rounded() / 16
                // The throttle, and the reason this is safe to call per frame:
                // a factor that rounds to the mark already drawn cannot change
                // any weight by a visible amount, so both passes below are
                // skipped outright.
                //
                // Which of them was worth skipping is not what it looks like.
                // Writing a width and a dash pattern into every renderer and
                // asking each to redraw — the loop this note used to call "the
                // expensive half" — measured **0 ms** for 323 renderers, because
                // `setNeedsDisplay` only marks. The marks were the cost, and
                // only because of how they were reached; see
                // ``displayedAnnotationViews``.
                guard !styledScale.isFinite || scale != styledScale else { return }
                styledScale = scale
                for (key, renderer) in overlayRenderers {
                    let style = overlayStyles[key]
                    let width = Self.drawnWidth(style, atScale: scale)
                    if let polyline = renderer as? MKPolylineRenderer {
                        polyline.lineWidth = width
                        polyline.lineDashPattern = style?.dashed == true
                            ? RailStyle.dashPattern(atScale: scale) : nil
                    } else if let multi = renderer as? MKMultiPolylineRenderer {
                        multi.lineWidth = width
                        multi.lineDashPattern = style?.dashed == true
                            ? RailStyle.dashPattern(atScale: scale) : nil
                    } else {
                        continue
                    }
                    renderer.setNeedsDisplay()
                }
                // The marks, reached through the views MapKit already handed
                // over rather than by asking it for one per annotation. See
                // ``displayedAnnotationViews`` — the asking was the whole of
                // the cost, and a pinch paid it 900 times a frame.
                //
                // `window` is the on-screen test: the table is weak, but a view
                // MapKit has taken off the map and is holding for reuse is
                // still alive and still in it.
                // On screen, and not merely alive: MapKit keeps an annotation
                // view after it scrolls out — pooled for reuse, still in the
                // window — so `window` alone let a national pan grow the pass
                // from 557 marks to 941, most of them nowhere near the
                // viewport. The rect test is the one that answers "is this
                // drawn", and it is a `CGRect` intersection.
                let viewport = mapView.bounds
                for view in displayedAnnotationViews.allObjects
                where view.window != nil && viewport.intersects(view.frame) {
                    switch view {
                    case let station as StationAnnotationView:
                        station.applyScale(scale, zoom: markZoom)
                    case let dot as RideStationAnnotationView:
                        dot.applyScale(scale)
                    case let label as RideLabelAnnotationView:
                        label.applyScale(scale, zoom: markZoom)
                    default:
                        continue
                    }
                }
            }

            func renderPlayback(_ snapshot: PlaybackMapSnapshot?) {
                guard let mapView else { return }
                lastPlaybackSnapshot = snapshot
                clearPlayback(on: mapView)
                guard let snapshot else { return }
                paintPlayback(snapshot, on: mapView, applyCamera: snapshot.autoFocus)
            }

            private func clearPlayback(on mapView: MKMapView) {
                if !playbackOverlays.isEmpty { mapView.removeOverlays(playbackOverlays) }
                if !playbackAnnotations.isEmpty { mapView.removeAnnotations(playbackAnnotations) }
                playbackOverlays = []
                playbackAnnotations = []
            }

            private func paintPlayback(
                _ snapshot: PlaybackMapSnapshot, on mapView: MKMapView, applyCamera: Bool
            ) {
                clearPlayback(on: mapView)
                let color = Self.uiColor(hex: snapshot.path.color) ?? .systemBlue
                var segments: [MKPolyline] = []

                // The journeys already finished, in their own colours and at
                // full strength, laid down first so the running journey's
                // trail draws on top of them. See `PlaybackMapSnapshot.done`.
                for (index, trail) in snapshot.done.enumerated() where trail.coords.count >= 2 {
                    // Sampled the way the live trail is: these are whole
                    // journeys rather than the stretch covered so far, and a
                    // day of them is tens of thousands of vertices that say
                    // nothing a sample does not.
                    let strideBy = max(1, trail.coords.count / 64)
                    var sampled = Swift.stride(
                        from: 0, to: trail.coords.count, by: strideBy).map { trail.coords[$0] }
                    if sampled.last != trail.coords.last { sampled.append(trail.coords.last!) }
                    guard sampled.count >= 2 else { continue }
                    let line = MKPolyline(
                        coordinates: sampled.map(\.clLocation), count: sampled.count)
                    let styleKey = "playback-done|\(index)"
                    line.title = styleKey
                    overlayStyles[styleKey] = OverlayStyle(
                        color: Self.uiColor(hex: trail.colorHex) ?? color,
                        widthToken: RailStyle.railWidth * RailStyle.riddenWidthScale
                            + RailStyle.playbackTrailEdge * 2,
                        alpha: 1)
                    segments.append(line)
                }
                let currentRun = snapshot.frame.runProgress.index
                for (runIndex, run) in snapshot.path.runs.enumerated() where runIndex <= currentRun {
                    let localLimit = runIndex < currentRun
                        ? run.total
                        : max(0, min(run.total, snapshot.frame.distance - run.offset))
                    guard localLimit > 0 else { continue }
                    var points: [Coordinate] = [run.coords[0]]
                    for index in 1..<run.coords.count {
                        if run.cum[index] <= localLimit {
                            points.append(run.coords[index])
                        } else {
                            break
                        }
                    }
                    if let head = snapshot.frame.head, runIndex == currentRun,
                       points.last != head { points.append(head) }
                    guard points.count >= 2 else { continue }
                    let strideBy = max(1, points.count / 64)
                    var sampled = Swift.stride(from: 0, to: points.count, by: strideBy).map { points[$0] }
                    if sampled.last != points.last { sampled.append(points.last!) }
                    for index in 1..<sampled.count {
                        let pair = [sampled[index - 1].clLocation, sampled[index].clLocation]
                        let line = MKPolyline(coordinates: pair, count: pair.count)
                        let styleKey = "playback|\(runIndex)|\(segments.count)"
                        line.title = styleKey
                        let fraction = Double(segments.count + 1) / Double(max(sampled.count - 1, 1))
                        overlayStyles[styleKey] = OverlayStyle(
                            color: color,
                            // One step wider than the ride under it, so the
                            // covered stretch reads as lit rather than as a second
                            // line beside the first — and on the same ramp, since
                            // nothing on this map opts out of it.
                            widthToken: RailStyle.railWidth * RailStyle.riddenWidthScale
                                + RailStyle.playbackTrailEdge * 2,
                            alpha: 0.18 + 0.82 * fraction)
                        segments.append(line)
                    }
                }
                playbackOverlays = segments
                mapView.addOverlays(segments, level: .aboveLabels)

                var annotations: [PlaybackAnnotation] = snapshot.path.stations.enumerated().map {
                    let passed = $0.offset <= snapshot.frame.stations.index
                    return PlaybackAnnotation(
                        coordinate: $0.element.coord.clLocation,
                        // `buildPlaybackPath` names its stations through
                        // `I18N.stationName` in the web app; the ported path
                        // carries the package's own spelling, so the language
                        // is applied here instead. Without the stop's code —
                        // the path does not carry one — the readings table's
                        // by-name lookup answers, which is its documented
                        // second choice rather than a fallback.
                        title: self.localized($0.element.name).display, color: color,
                        kind: .station, active: passed,
                        pulse: $0.offset == snapshot.frame.stations.index
                            ? snapshot.frame.stations.pulse : 0)
                }
                if let head = snapshot.frame.head {
                    annotations.append(PlaybackAnnotation(
                        coordinate: head.clLocation, title: nil, color: color,
                        kind: .head, active: true, pulse: 0))
                }
                playbackAnnotations = annotations
                mapView.addAnnotations(annotations)

                if applyCamera, let camera = snapshot.frame.camera {
                    let width = max(Double(mapView.bounds.width), 1)
                    let height = max(Double(mapView.bounds.height), 1)
                    let longitudeDelta = 360 * (width / 256) / pow(2, camera.zoom)
                    mapView.setRegion(MKCoordinateRegion(
                        center: camera.center.clLocation,
                        span: MKCoordinateSpan(
                            latitudeDelta: longitudeDelta * height / width,
                            longitudeDelta: longitudeDelta)), animated: false)
                }
                playback?.mapRendererViewSize = mapView.bounds.size
            }

            private final class PlaybackAnnotation: NSObject, MKAnnotation {
                enum Kind { case station, head }
                dynamic var coordinate: CLLocationCoordinate2D
                let title: String?
                let color: UIColor
                let kind: Kind
                let active: Bool
                let pulse: Double
                init(
                    coordinate: CLLocationCoordinate2D, title: String?, color: UIColor,
                    kind: Kind, active: Bool, pulse: Double
                ) {
                    self.coordinate = coordinate
                    self.title = title
                    self.color = color
                    self.kind = kind
                    self.active = active
                    self.pulse = pulse
                }
            }

            private final class StationAnnotation: NSObject, MKAnnotation {
                let station: RailNetworkStore.DrawnStation
                dynamic var coordinate: CLLocationCoordinate2D
                /// The callout header, in the reader's language.
                ///
                /// `RailNetworkStore` builds the popup model off the main actor
                /// with no `StationDisplay.Naming` attached, so `popup.name` is
                /// the package's own spelling; `buildStationPopupModel` in the
                /// web app puts it through `I18N.stationName`. Applied here
                /// instead, which also means a language change is picked up by
                /// the next rebuild rather than needing the package decoded
                /// again.
                let displayName: String
                /// `nameReadingsList` — one line per enabled reading. Empty is
                /// a real answer (every toggle off), and different from the
                /// standalone case the `nameRoma` fallback covers.
                let readings: [String]?
                /// Whether this dot prints its name.
                ///
                /// `DrawnStation.showsLabel` is the election result — which of
                /// the platforms at one complex won the right to print the
                /// place's name — and this is that AND the reader's
                /// `networkStationNames` switch. Both have to be true, and the
                /// zoom floor in `relayout` still applies under them: a switch
                /// can take a name away, never make it appear earlier.
                let showsName: Bool
                var title: String? { displayName }
                var subtitle: String? {
                    if let first = readings?.first { return first }
                    guard readings == nil, !station.popup.nameRoma.isEmpty else { return nil }
                    return station.popup.nameRoma
                }
                init(
                    station: RailNetworkStore.DrawnStation,
                    displayName: String, showsName: Bool, readings: [String]?
                ) {
                    self.station = station
                    self.displayName = displayName
                    self.showsName = showsName
                    self.readings = readings
                    coordinate = station.coordinate.clLocation
                }
            }

            /// One dot a ride puts on a station it called at — a
            /// ``StationDisplay/MarkerFeature`` with its record's colours, in the
            /// form MapKit wants.
            ///
            /// Every size on it is a FULL-SCALE token; the view multiplies by the
            /// one shared factor when it draws.
            private final class RideStationAnnotation: NSObject, MKAnnotation {
                /// The black core of an intermediate stop, folded into the dot it
                /// sits in — its own record exists, but not its own annotation.
                struct Core {
                    let radius: CGFloat
                    let focusScale: CGFloat
                    let color: UIColor
                }

                dynamic var coordinate: CLLocationCoordinate2D
                /// Empty on every record that lost the label election, which is
                /// what lets one station reached by twenty rides print its name
                /// once.
                let name: String
                /// The package's own spelling of the place, whatever the
                /// election did to `name`.
                ///
                /// Carried because `name` cannot do this job: most dots lost
                /// the election and are empty, and a tap on one still has to
                /// find the station it stands on. See
                /// ``Coordinator/rideStationCard(name:code:at:)``.
                let rawName: String
                /// `n02_station_code` off the ride's own stop — the station
                /// GROUP, which is the identity `DrawnStation.stationCode`
                /// carries on the network's side of the same station.
                let stationCode: String?
                let role: String
                let radius: CGFloat
                let lineWidth: CGFloat
                let focusScale: CGFloat
                let fill: UIColor
                let stroke: UIColor
                let alpha: CGFloat
                let focusBoost: CGFloat
                let selected: Bool
                var core: Core?

                var title: String? { name.isEmpty ? nil : name }

                /// The label tier this role's name is drawn in — the three floors
                /// of `railmap-style.js` §7b, ported into `RailCore`. A role with
                /// no tier is never named.
                var labelTier: StationDisplay.RideLabelTier? {
                    StationDisplay.rideLabelTier(role: role)
                }

                /// `selectedStopRadiusExpr` — the boost is scaled by the record's
                /// own `focusScale`, so a terminal takes all of it and an
                /// intermediate stop grows by exactly what a pass-through would.
                var drawnRadiusToken: CGFloat {
                    selected ? radius + focusBoost * focusScale : radius
                }

                /// `SELECTED_STOP_STROKE_SCALE` — a selected terminal doubles its
                /// ring; everything else keeps its own.
                var drawnLineWidthToken: CGFloat {
                    selected && role == "terminal" ? lineWidth * 2 : lineWidth
                }

                init(
                    coordinate: CLLocationCoordinate2D, name: String,
                    rawName: String, stationCode: String?, role: String,
                    radius: CGFloat, lineWidth: CGFloat, focusScale: CGFloat,
                    fill: UIColor, stroke: UIColor, alpha: CGFloat,
                    focusBoost: CGFloat, selected: Bool
                ) {
                    self.coordinate = coordinate
                    self.name = name
                    self.rawName = rawName
                    self.stationCode = stationCode
                    self.role = role
                    self.radius = radius
                    self.lineWidth = lineWidth
                    self.focusScale = focusScale
                    self.fill = fill
                    self.stroke = stroke
                    self.alpha = alpha
                    self.focusBoost = focusBoost
                    self.selected = selected
                }
            }

            /// The NAME a marker won, as its own annotation.
            ///
            /// Split from the dot on purpose. MapLibre never collides circles and
            /// collides only symbols, so every dot draws and the names contend for
            /// space among themselves; MapKit collides whole annotation VIEWS, so a
            /// label riding inside its dot's view would make the dot lose its place
            /// to another dot's name — a record of a journey erased by a caption.
            ///
            /// Separated, the mapping is exact: dots are `.required`, and the
            /// labels carry `rideLabelTiersInPlacementOrder` as display priority,
            /// which is the same "a boarding station claims its space before an
            /// intermediate stop, which claims it before one merely rolled
            /// through" the style's layer order expresses.
            private final class RideLabelAnnotation: NSObject, MKAnnotation {
                dynamic var coordinate: CLLocationCoordinate2D
                let text: String
                /// The same two keys the dot carries. A caption is a separate
                /// annotation from the dot it names — see below — so a tap that
                /// lands on the NAME must be able to answer with the same card
                /// as a tap on the mark, without going back to the dot for it.
                let rawName: String
                let stationCode: String?
                let tier: StationDisplay.RideLabelTier
                /// Where the dot ends, so the text can sit beside it rather than
                /// on it. A token, like every other size here.
                let dotRadiusToken: CGFloat
                let selected: Bool
                var title: String? { text }
                init(
                    coordinate: CLLocationCoordinate2D, text: String,
                    rawName: String, stationCode: String?,
                    tier: StationDisplay.RideLabelTier, dotRadiusToken: CGFloat,
                    selected: Bool
                ) {
                    self.coordinate = coordinate
                    self.text = text
                    self.rawName = rawName
                    self.stationCode = stationCode
                    self.tier = tier
                    self.dotRadiusToken = dotRadiusToken
                    self.selected = selected
                }
            }

            /// A ride's origin / destination name card.
            private final class EndpointLabelAnnotation: NSObject, MKAnnotation {
                dynamic var coordinate: CLLocationCoordinate2D
                var spec: MapEndpointLabels.Spec
                var title: String? { spec.mainLine }
                init(spec: MapEndpointLabels.Spec) {
                    self.spec = spec
                    coordinate = spec.coordinate.clLocation
                }
            }

            private final class StationAnnotationView: MKAnnotationView {
                private let dot = UIView()
                private let nameLabel = HaloLabel()
                private var station: RailNetworkStore.DrawnStation?
                /// The name election AND the reader's switch, resolved by
                /// `StationAnnotation`. Views are recycled, so this has to be
                /// stored rather than read back off the annotation in
                /// `relayout` — a rescale runs without a fresh `configure`.
                private var showsName = false
                /// The zoom the name is currently sized for. Text does not ride
                /// the railway's scale ramp, but it does ride its own shallower
                /// one, so a rescale has to re-measure it.
                private var zoom: Double = 0
                /// The factor the dot below is currently drawn at. Held so a
                /// rescale is a resize rather than a rebuild.
                private var scale: CGFloat = 1

                override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
                    super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
                    addSubview(dot)
                    addSubview(nameLabel)
                    dot.layer.borderColor = UIColor.systemBackground.cgColor
                    // A name is drawn in the map's own label ink with the map's
                    // own surface haloed around it — never on a filled plate.
                    // See `MapLabelStyle`.
                    nameLabel.numberOfLines = 1
                    collisionMode = .rectangle
                    // No callout. A station's popup is a card in a sheet now —
                    // see `StationCardView`, and `mapView(_:didSelect:)` for
                    // how a tap gets there. A bubble anchored to the bead had
                    // to be small enough not to cover the map it was pointing
                    // at, which put a dozen railways' badges in a 280-point
                    // box that could not scroll and could not grow with the
                    // reader's type size.
                }

                required init?(coder: NSCoder) { nil }

                func configure(_ item: StationAnnotation, scale: CGFloat, zoom: Double) {
                    station = item.station
                    showsName = item.showsName
                    self.scale = scale
                    self.zoom = zoom
                    let station = item.station
                    dot.backgroundColor = Coordinator.uiColor(hex: station.colorHex) ?? .systemGray
                    // A deliberate deviation, and the only one on this label:
                    // `rn-stations-label` draws the package's own spelling,
                    // because `railmap.js` is a standalone library with no
                    // `I18N` under it. Here the name a station's CALLOUT gives
                    // and the name printed beside its bead would then be two
                    // different words in Taiwan, Hong Kong, Macao and Korea —
                    // whose readings tables exist precisely to name the place
                    // in the reader's language. Japan is unaffected: its table
                    // annotates rather than replaces, so this is the identity.
                    nameLabel.text = item.displayName
                    // An interchange is counted in RAILWAYS, which is exactly
                    // what the popup's rows already are: `buildPopupModel`
                    // dedupes them on displayed operator + name, so several
                    // services of one railway leave a station reading as one.
                    displayPriority = MapLabelStyle.stationDisplayPriority(
                        interchange: station.popup.lines.count > 1,
                        isTerminal: station.isTerminal,
                        named: item.showsName)
                    accessibilityLabel = item.displayName
                    relayout()
                }

                func applyScale(_ scale: CGFloat, zoom: Double) {
                    guard scale != self.scale || zoom != self.zoom else { return }
                    self.scale = scale
                    self.zoom = zoom
                    relayout()
                }

                /// The dot is one token times the one shared factor, and its ring
                /// is another — an EIGHTH of the dot, so a ring that kept its
                /// absolute width while the dot shrank cannot swallow the colour it
                /// is there to separate. A terminal used to be drawn 8 pt against
                /// an ordinary 6 pt; neither number was a token, and the web app
                /// draws every network platform at the same radius.
                private func relayout() {
                    guard station != nil else { return }
                    let dark = traitCollection.userInterfaceStyle == .dark
                    let diameter = max(1, RailStyle.stationDiameter * scale)
                    dot.frame = CGRect(
                        x: 0, y: 12 - diameter / 2, width: diameter, height: diameter)
                    dot.layer.cornerRadius = diameter / 2
                    dot.layer.borderWidth = RailStyle.stationRing * scale

                    // The beads appear at each station's own minZoom; the NAMES
                    // wait for a second, higher floor, because a name needs a
                    // district's worth of room and a bead does not.
                    let names = showsName && zoom >= MapLabelStyle.stationLabelMinZoom
                    var width = diameter
                    // Nothing below is worth doing for a name that is not drawn
                    // and was not drawn a moment ago — and that is the state
                    // every bead is in at the zooms where there are hundreds of
                    // them. Setting the font alone invalidates a `UILabel`'s
                    // intrinsic size, and `sizeThatFits` measures type; over
                    // 557 beads that is most of a rescale, spent on a label
                    // whose `isHidden` never changed.
                    if names || !nameLabel.isHidden {
                        let size = MapLabelStyle.stationLabelSize(atZoom: zoom)
                        nameLabel.isHidden = !names
                        nameLabel.font = MapLabelStyle.font(ofSize: size)
                        nameLabel.textColor = MapLabelStyle.ink(dark: dark)
                        nameLabel.haloColor = MapLabelStyle.halo(dark: dark)

                        let labelSize = names
                            ? nameLabel.sizeThatFits(CGSize(width: 180, height: 24)) : .zero
                        // `text-radial-offset` is in ems, so the gap grows with
                        // the text rather than holding a pixel count while the
                        // label around it changes size. The halo needs room of
                        // its own on both sides or it is clipped by the label's
                        // bounds.
                        let gap = size * MapLabelStyle.radialOffsetEm
                        let inset = MapLabelStyle.haloWidth
                        nameLabel.frame = CGRect(
                            x: diameter + gap - inset, y: 1,
                            width: labelSize.width + inset * 2, height: 22)
                        if names { width = nameLabel.frame.maxX }
                    }
                    frame.size = CGSize(width: width, height: 24)
                    centerOffset = CGPoint(x: width / 2 - diameter / 2, y: 0)
                }

            }

            /// The dot itself: fill, ring, and — on an intermediate stop — the
            /// black core that tells it from a boarding terminal.
            private final class RideStationAnnotationView: MKAnnotationView {
                private let dot = UIView()
                private let core = UIView()
                private var item: RideStationAnnotation?
                private var scale: CGFloat = 1

                override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
                    super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
                    addSubview(dot)
                    dot.addSubview(core)
                    core.isUserInteractionEnabled = false
                    // A circle, and `.required`: every dot on a ride draws. The
                    // names contend among themselves on their own annotations.
                    collisionMode = .circle
                    // Below the names deliberately. MapLibre never collides
                    // circles at all — only symbols — so in the web app a bead
                    // can never suppress a caption. MapKit collides every
                    // annotation view against every other, and with the dots
                    // at `.required` a name that touched ANY bead lost: along a
                    // dense route the beads are a few points apart, so all 80
                    // captions on screen were being suppressed by them.
                    //
                    // Inverting it costs a bead where a name lands on one, and
                    // that is much the smaller loss: the ride's LINE is an
                    // overlay and never collides, so the journey is still drawn
                    // through the station either way — while a suppressed name
                    // is the only text this map has.
                    displayPriority = .defaultLow
                    // No callout, for the reason the network's beads have none
                    // (`StationAnnotationView`): a station's answer is the card
                    // in a sheet now — see `mapView(_:didSelect:)`. The bubble
                    // could only ever say the name this dot had WON in the
                    // label election, so at every station that lost it — which
                    // is most of them — a tap opened an empty bubble or did
                    // nothing at all.
                }

                required init?(coder: NSCoder) { nil }

                func configure(_ item: RideStationAnnotation, scale: CGFloat) {
                    self.item = item
                    self.scale = scale
                    dot.backgroundColor = item.fill
                    dot.layer.borderColor = item.stroke.cgColor
                    core.backgroundColor = item.core?.color
                    core.isHidden = item.core == nil
                    alpha = item.alpha
                    // The dot's own name, not the one it won: a dot that lost
                    // the label election draws no caption but is still a
                    // station and still opens that station's card, so leaving
                    // it unlabelled would put an unnamed button under a
                    // VoiceOver reader's finger (§10.2).
                    accessibilityLabel = item.rawName.isEmpty ? nil : item.rawName
                    relayout()
                }

                func applyScale(_ scale: CGFloat) {
                    guard scale != self.scale else { return }
                    self.scale = scale
                    relayout()
                }

                private func relayout() {
                    guard let item else { return }
                    let diameter = max(1, item.drawnRadiusToken * 2 * scale)
                    frame.size = CGSize(width: diameter, height: diameter)
                    // The cross-day break station is a DIAMOND, so the one
                    // place that is both "day D ends here" and "day D+1 starts
                    // here" can never read as an ordinary stop. A square
                    // turned a quarter is a diamond, and turning the dot
                    // itself keeps the ring, the fill and the focus boost it
                    // already carries — where a second layer would be a second
                    // mark to keep in step.
                    //
                    // Its side is the diagonal over √2, so the diamond's WIDTH
                    // is the dot's diameter and its half-diagonal is the
                    // record's radius, which is what `icon-size` scales the
                    // rasterised icon to.
                    let crossDay = item.role == "xday"
                    let side = crossDay ? diameter / 2.0.squareRoot() : diameter
                    // Reset before writing a frame: setting `frame` while a
                    // transform is in force is undefined, and this view is
                    // relaid out on every rescale.
                    dot.transform = .identity
                    dot.frame = CGRect(
                        x: (diameter - side) / 2, y: (diameter - side) / 2,
                        width: side, height: side)
                    dot.layer.cornerRadius = crossDay ? 0 : diameter / 2
                    if crossDay { dot.transform = CGAffineTransform(rotationAngle: .pi / 4) }
                    dot.layer.borderWidth = item.drawnLineWidthToken * scale
                    centerOffset = .zero
                    guard let coreSpec = item.core else { return }
                    // The core takes the focus boost in the same proportion the
                    // dot does, so the white ring between them survives selection.
                    let coreToken = item.selected
                        ? coreSpec.radius + item.focusBoost * coreSpec.focusScale
                        : coreSpec.radius
                    let coreDiameter = max(0.5, min(coreToken * 2 * scale, diameter))
                    core.frame = CGRect(
                        x: (diameter - coreDiameter) / 2, y: (diameter - coreDiameter) / 2,
                        width: coreDiameter, height: coreDiameter)
                    core.layer.cornerRadius = coreDiameter / 2
                }
            }

            /// A marker's elected name, on its own annotation so MapKit's
            /// collision pass decides between NAMES rather than between a name and
            /// somebody else's dot.
            private final class RideLabelAnnotationView: MKAnnotationView {
                private let text = HaloLabel()
                private var item: RideLabelAnnotation?
                private var scale: CGFloat = 1
                private var zoom: Double = 0

                override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
                    super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
                    addSubview(text)
                    text.numberOfLines = 1
                    collisionMode = .rectangle
                }

                required init?(coder: NSCoder) { nil }

                func configure(_ item: RideLabelAnnotation, scale: CGFloat, zoom: Double) {
                    self.item = item
                    self.scale = scale
                    self.zoom = zoom
                    text.text = item.text
                    accessibilityLabel = item.text
                    // `.required`, and it has to be — measured, not chosen.
                    //
                    // The tier ranking `rideLabelTiersInPlacementOrder` gives
                    // is deliberately NOT read here. It was, as a
                    // `defaultHigh + tier` display priority, and the next
                    // paragraph is why that had to go.
                    //
                    // An annotation view does not only collide with other
                    // annotation views: it competes with the BASEMAP's own
                    // labels, and Apple's are dense over a city. At
                    // `defaultHigh + tier` (910 of a possible 1000) every one
                    // of 85 captions over Osaka was evicted and the map drew a
                    // ride with no names on it at all; the two endpoint cards
                    // survived only because they were already `.required`.
                    // Nothing between 750 and 1000 changed that.
                    //
                    // What is given up is thinning: MapKit shows every
                    // `.required` view, so captions no longer yield to each
                    // other by tier the way `rideLabelTiersInPlacementOrder`
                    // arranges in MapLibre. Density is carried entirely by the
                    // two mechanisms that are ported — the ~600 m name election
                    // in `markerLabelWinners`, and the three zoom floors — which
                    // is why those floors are set where they are.
                    displayPriority = .required
                    relayout()
                }

                func applyScale(_ scale: CGFloat, zoom: Double) {
                    guard scale != self.scale || zoom != self.zoom else { return }
                    self.scale = scale
                    self.zoom = zoom
                    relayout()
                }

                /// Text is not a mark: it rides the tier's own shallow ramp — the
                /// base size at the tier's floor, two points more by z16 — and
                /// never thins with the railway scale. Only its DISTANCE from the
                /// dot follows the scale, because that dot did thin.
                private func relayout() {
                    guard let item else { return }
                    let dark = traitCollection.userInterfaceStyle == .dark
                    let points = CGFloat(
                        item.tier.textSize(atZoom: RailStyle.mapLibreZoom(from: zoom)))
                    text.font = MapLabelStyle.font(ofSize: points)
                    text.textColor = MapLabelStyle.ink(dark: dark)
                    text.haloColor = MapLabelStyle.halo(dark: dark)
                    let inset = MapLabelStyle.haloWidth
                    let size = text.sizeThatFits(CGSize(width: 190, height: 24))
                    let height = max(size.height, 16)
                    let width = size.width + inset * 2
                    text.frame = CGRect(x: 0, y: 0, width: width, height: height)
                    frame.size = CGSize(width: width, height: height)
                    centerOffset = CGPoint(
                        x: item.dotRadiusToken * scale
                            + points * MapLabelStyle.radialOffsetEm + width / 2,
                        y: 0)
                }
            }

            /// The origin / destination card, whose placement is decided in
            /// `MapEndpointLabels` and applied here as a centre offset.
            private final class EndpointLabelView: MKAnnotationView {
                /// One label per piece rather than one attributed string.
                ///
                /// ``HaloLabel`` strokes the surface around the glyphs by
                /// drawing the text twice, and the stroke pass works by
                /// swapping `textColor` — which an attributed string carrying
                /// its own `.foregroundColor` ignores, so the halo would come
                /// out in the ink's colour. Four labels of one colour each
                /// keeps that contract and costs a little arithmetic.
                private let badge = HaloLabel()
                private let name = HaloLabel()
                private let time = HaloLabel()
                private var readings: [HaloLabel] = []

                /// The web app's own per-line estimates, reused as the drawn
                /// line heights so the card occupies exactly the box
                /// `layoutEndpointLabels` placed for it.
                private static let mainLineHeight: CGFloat = 18
                private static let readingLineHeight: CGFloat = 15
                private static let verticalPadding: CGFloat = 6
                private static let pieceGap: CGFloat = 4

                override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
                    super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
                    for label in [badge, name, time] {
                        label.numberOfLines = 1
                        label.textAlignment = .center
                        // The web app draws this one as a filled card
                        // (`.station-label`), because HTML text over a raster
                        // map has no other way to stay legible. Here it is
                        // haloed like every other name on the map instead: a
                        // filled plate in dark mode is a black chip punched
                        // through the map, and this is the one label big enough
                        // for that to be the first thing a reader sees.
                        label.backgroundColor = .clear
                        addSubview(label)
                    }
                    badge.font = MapEndpointLabels.badgeFont
                    name.font = MapEndpointLabels.font
                    time.font = MapEndpointLabels.timeFont
                    // The web app's cards are `pointer-events: none` so they never
                    // block route picking; the same here.
                    isUserInteractionEnabled = false
                    collisionMode = .rectangle
                    displayPriority = .required
                }

                required init?(coder: NSCoder) { nil }

                func configure(_ item: EndpointLabelAnnotation) {
                    // Read here, not in `init`: an annotation view is reused
                    // across a light/dark flip, and a colour resolved once at
                    // construction is a colour from whichever theme happened to
                    // be in force the first time this view was made.
                    let dark = traitCollection.userInterfaceStyle == .dark
                    let ink = MapLabelStyle.ink(dark: dark)
                    let muted = MapLabelStyle.mutedInk(dark: dark)
                    let halo = MapLabelStyle.halo(dark: dark)
                    let spec = item.spec

                    badge.text = spec.badge
                    name.text = spec.name
                    time.text = spec.time
                    badge.textColor = ink
                    name.textColor = ink
                    // The time and the readings QUALIFY the name rather than
                    // being it, and with no plate under them the only thing
                    // that can say so is weight, size and a second rank of ink.
                    time.textColor = muted
                    for label in [badge, name, time] { label.haloColor = halo }

                    // One label per reading, built to fit: a station can carry
                    // kana, romaji and a Chinese reading at once, and the box
                    // `buildEndpointLabelSpec` measured already allowed for all
                    // three.
                    while readings.count < spec.readings.count {
                        let label = HaloLabel()
                        label.numberOfLines = 1
                        label.textAlignment = .center
                        label.backgroundColor = .clear
                        label.font = MapEndpointLabels.readingFont
                        addSubview(label)
                        readings.append(label)
                    }
                    for (index, label) in readings.enumerated() {
                        label.isHidden = index >= spec.readings.count
                        label.haloColor = halo
                        label.textColor = muted
                        label.text = index < spec.readings.count ? spec.readings[index] : nil
                    }

                    accessibilityLabel = spec.mainLine
                    layout(spec)
                    centerOffset = MapEndpointLabels.centreOffset(for: spec)
                }

                /// Badge and name on one centred row; the time on its own row
                /// under it, and the readings under that — each on its own
                /// line, never bracket-appended, which is the one display rule
                /// `stationNameReadings` exists to spell.
                ///
                /// The time used to ride the name's row, as it does in the web
                /// app. It came down for two reasons: the name is what the card
                /// is FOR and a suffix on its row competes with it, and a row
                /// that grows sideways gets pushed sideways to stay on screen,
                /// which on a phone moves the card off the dot it belongs to.
                private func layout(_ spec: MapEndpointLabels.Spec) {
                    let inset = MapLabelStyle.haloWidth
                    let bound = CGSize(width: MapEndpointLabels.maxWidth, height: 24)
                    var row: [(label: UILabel, width: CGFloat)] = []
                    for label in [badge, name] where !(label.text ?? "").isEmpty {
                        row.append((label, label.sizeThatFits(bound).width + inset * 2))
                    }
                    for label in [badge, name, time] {
                        label.isHidden = (label.text ?? "").isEmpty
                    }
                    let rowWidth = row.reduce(CGFloat(0)) { $0 + $1.width }
                        + Self.pieceGap * CGFloat(max(row.count - 1, 0))
                    let timeWidth = time.isHidden
                        ? 0 : time.sizeThatFits(bound).width + inset * 2
                    var readingWidths: [CGFloat] = []
                    for label in readings where !label.isHidden {
                        readingWidths.append(label.sizeThatFits(bound).width + inset * 2)
                    }
                    let width = max(rowWidth, max(timeWidth, readingWidths.max() ?? 0))
                    // The sublines are the time and the readings, in that
                    // order; both are drawn at `readingLineHeight`, which is
                    // the height `MapEndpointLabels.spec` measured them at.
                    let height = Self.verticalPadding + Self.mainLineHeight
                        + Self.readingLineHeight
                        * CGFloat(readingWidths.count + (time.isHidden ? 0 : 1))
                    frame.size = CGSize(width: max(width, 1), height: max(height, 1))

                    var x = (width - rowWidth) / 2
                    for piece in row {
                        piece.label.frame = CGRect(
                            x: x, y: Self.verticalPadding / 2,
                            width: piece.width, height: Self.mainLineHeight)
                        x += piece.width + Self.pieceGap
                    }
                    var y = Self.verticalPadding / 2 + Self.mainLineHeight
                    if !time.isHidden {
                        time.frame = CGRect(
                            x: (width - timeWidth) / 2, y: y,
                            width: timeWidth, height: Self.readingLineHeight)
                        y += Self.readingLineHeight
                    }
                    var index = 0
                    for label in readings where !label.isHidden {
                        let pieceWidth = readingWidths[index]
                        label.frame = CGRect(
                            x: (width - pieceWidth) / 2, y: y,
                            width: pieceWidth, height: Self.readingLineHeight)
                        y += Self.readingLineHeight
                        index += 1
                    }
                }
            }

            /// `fitTrainsBounds` while the transport owns the camera.
            ///
            /// `maxZoom` is a floor on how far in the move may go, expressed
            /// as a MapLibre zoom because that is what `Playback.Tuning`
            /// carries. Without it a single short journey opens at street
            /// level, where the overview shows nothing an overview is for.
            func framePlayback(
                coordinates: [Coordinate], maxZoom: Double, animated: Bool
            ) {
                guard let mapView, var region = Self.region(covering: [coordinates])
                else { return }
                // The smallest span this zoom is allowed to produce, across
                // the view's own width — one MapLibre tile pixel is this
                // app's zoom minus the ported offset, and `metresPerPixel`
                // already speaks that language.
                let metres = Self.metresPerPixel(
                    zoom: RailStyle.zoom(fromMapLibre: maxZoom),
                    latitude: region.center.latitude) * Double(mapView.bounds.width)
                let minimumDelta = metres / 111_320
                region.span.latitudeDelta = max(region.span.latitudeDelta, minimumDelta)
                region.span.longitudeDelta = max(region.span.longitudeDelta, minimumDelta)
                controller?.fit(region, animated: animated)
            }

            // MARK: - selection

            /// A tap on any station on this map opens its card.
            ///
            /// ANY: the network's beads, the dots a recorded ride puts on its
            /// own stops, and the captions beside those dots. A station is one
            /// place whether the reader is looking at the whole network or at
            /// one journey through it, and it used to answer differently in the
            /// two — the network bead opened the card, while a ride's dot
            /// opened MapKit's default callout when it happened to have won a
            /// name and did nothing at all when it had not.
            ///
            /// The annotation is deselected straight away, and deliberately.
            /// MapKit's selection is the callout's own state — it exists to
            /// keep a bubble on screen — and there is no bubble now. Left
            /// selected, the bead would stay in its selected appearance behind
            /// the sheet and a second tap on the same station would do nothing
            /// at all, because selecting what is already selected is not a
            /// change.
            /// ## One touch, one answer
            ///
            /// MapKit's selection does not arrive with the touch. It waits for
            /// the double-tap-to-zoom recogniser to fail first, so it lands
            /// about half a second AFTER the finger lifts — measured at
            /// 0.51–0.57 s on the simulator — and it hit-tests an annotation
            /// more generously than `gestureRecognizer(_:shouldReceive:)` can
            /// see: a touch that never entered any `MKAnnotationView` (so the
            /// map's own tap recogniser took it, resolved the rides under it
            /// and opened the ambiguous-tap chooser) still selects the bead or
            /// the caption it landed beside.
            ///
            /// That is one touch asking the workspace for two surfaces. The
            /// second one is not merely redundant — it is DROPPED: both are
            /// presented by the resident sheet's controller, which is already
            /// presenting the chooser by the time this runs, so UIKit refuses
            /// with "Attempt to present … which is already presenting" and the
            /// station card the reader would have seen never appears. It reads
            /// as a card that opens sometimes and not others.
            ///
            /// So a touch this map has already answered with a ride is not
            /// answered again here. A touch that landed ON an annotation never
            /// reaches the tap recogniser at all (`shouldReceive` returns
            /// false), and one that found no ride under it makes no claim — so
            /// both of those still open their card.
            func mapView(_ mapView: MKMapView, didSelect annotation: any MKAnnotation) {
                guard let card = stationCard(for: annotation) else { return }
                mapView.deselectAnnotation(annotation, animated: false)
                if let answered = rideAnsweredTap, ContinuousClock.now - answered < .seconds(1) {
                    return
                }
                onSelectStation(card)
            }

            /// The card one tapped annotation opens, or `nil` when the thing
            /// tapped was not a station at all.
            private func stationCard(for annotation: any MKAnnotation) -> StationCard? {
                if let station = annotation as? StationAnnotation {
                    return StationCard(
                        station: station.station,
                        displayName: station.displayName,
                        readings: station.readings)
                }
                if let dot = annotation as? RideStationAnnotation {
                    return rideStationCard(
                        name: dot.rawName, code: dot.stationCode,
                        at: Self.coordinate(dot.coordinate))
                }
                if let caption = annotation as? RideLabelAnnotation {
                    return rideStationCard(
                        name: caption.rawName, code: caption.stationCode,
                        at: Self.coordinate(caption.coordinate))
                }
                return nil
            }

            /// The card behind one of a ride's own dots.
            ///
            /// A ride's stop knows its name, its station-group code and where
            /// the route drew it; what it does NOT know is which railways run
            /// through the place, which is the whole body of the card. That
            /// lives on the network's side, so the stop is resolved back to a
            /// platform there and the platform's popup model is used — which is
            /// also what makes the card identical to the one the network's own
            /// bead at that station opens, down to the name and the readings.
            ///
            /// When nothing resolves, the card is still opened, with the stop's
            /// own name and no line rows. The reader tapped a station and a
            /// station is what they get; the alternative is a mark that answers
            /// a tap with silence, which is the fault this replaced.
            private func rideStationCard(
                name: String, code: String?, at position: Coordinate
            ) -> StationCard {
                if let station = networkStation(code: code, name: name, near: position) {
                    // Named and read exactly as `StationAnnotation` names and
                    // reads the same platform — the readings table is keyed on
                    // the platform's own id first and its name second.
                    let named = localized(station.name, code: station.id)
                    return StationCard(
                        station: station, displayName: named.display,
                        readings: localization == nil ? nil : named.readings.map(\.text))
                }
                let named = localized(name, code: code)
                return StationCard(
                    id: "stop:\(Stations.normalizeStationName(name))"
                        + "@\(position.lat),\(position.lon)",
                    coordinate: position,
                    displayName: named.display,
                    rawName: name,
                    // A stop that resolved to no platform still names a
                    // region well enough to search in: the store's own
                    // station code says which package it came from, and a
                    // hand-typed ride with no code at all is Japanese for the
                    // same reason `naming` reads it as Japanese.
                    region: Region.fromStationCode(code) ?? .jp,
                    readings: localization == nil ? nil : named.readings.map(\.text),
                    nameRoma: "",
                    lines: [])
            }

            /// The network platform a ride's stop stands on.
            ///
            /// By CODE first, and it is the answer that can be trusted: a
            /// station group is an identity the ride's stop and the network's
            /// station both carry (`n02_station_code`), so a match is the same
            /// station rather than a station that reads the same. The nearest
            /// of the group's platforms is taken, which is also what settles a
            /// code that two countries' packages both happen to use — a ride in
            /// Japan cannot resolve to a Korean platform 1,000 km away.
            ///
            /// By NAME second, for the stores that carry no code — a journey
            /// typed in by hand, or one imported from a source that had none.
            /// A name is a guess and is capped accordingly: 同名 stations are
            /// common enough (中山, 大手町) that an uncapped one would hand the
            /// reader another prefecture's railways.
            private func networkStation(
                code: String?, name: String, near position: Coordinate
            ) -> RailNetworkStore.DrawnStation? {
                func nearest(_ indexes: [Int], within metres: Double) -> RailNetworkStore.DrawnStation? {
                    indexes
                        .map { (station: stations[$0], distance:
                            Geometry.distanceMeters(stations[$0].coordinate, position)) }
                        .filter { $0.distance <= metres }
                        .min { $0.distance < $1.distance }?
                        .station
                }
                if let code, !code.isEmpty, let group = stationsByCode[code],
                    let hit = nearest(group, within: .infinity) {
                    return hit
                }
                let key = Stations.normalizeStationName(name)
                guard !key.isEmpty, let sameName = stationsByName[key] else { return nil }
                return nearest(sameName, within: Self.nameMatchMeters)
            }

            /// How far a NAME may reach for a platform. Generous next to the
            /// ~600 m the label election merges on, because a stop's drawn
            /// position is the route's own geometry rather than the station
            /// table's point, and a complex like 梅田/大阪 spreads its platforms
            /// over half a kilometre before either number applies.
            static let nameMatchMeters: Double = 2_000

            /// The network's platforms, indexed by the two keys a ride's stop
            /// can offer. Rebuilt when the station list itself changes, which
            /// is once per region as the packages land.
            ///
            /// Indices rather than rows: every `DrawnStation` carries its whole
            /// popup model, and Japan alone ships some 12,000 of them.
            private var stationsByCode: [String: [Int]] = [:]
            private var stationsByName: [String: [Int]] = [:]

            private func indexStations() {
                stationsByCode.removeAll(keepingCapacity: true)
                stationsByName.removeAll(keepingCapacity: true)
                for (index, station) in stations.enumerated() {
                    if !station.stationCode.isEmpty {
                        stationsByCode[station.stationCode, default: []].append(index)
                    }
                    let key = Stations.normalizeStationName(station.name)
                    if !key.isEmpty { stationsByName[key, default: []].append(index) }
                }
            }

            /// MapKit's pair as `RailCore`'s. The annotations hold the
            /// former because that is what `MKAnnotation` requires; everything
            /// ported — `Geometry.distanceMeters`, the station table — speaks
            /// the latter.
            static func coordinate(_ location: CLLocationCoordinate2D) -> Coordinate {
                Coordinate(lon: location.longitude, lat: location.latitude)
            }

            // MARK: - rendering

            func mapView(_ mapView: MKMapView, rendererFor overlay: any MKOverlay) -> MKOverlayRenderer {
                if let polygon = overlay as? MKPolygon, polygon.title == "basemap-veil" {
                    let renderer = MKPolygonRenderer(polygon: polygon)
                    renderer.fillColor = UIColor.systemBackground.withAlphaComponent(
                        1 - min(max(basemapOpacity, 0), 1))
                    return renderer
                }
                // The weight ramp, applied at the one place a token becomes points.
                //
                // This used to read "MapKit line widths are already in points and
                // are not scaled by zoom, so the token transfers directly rather
                // than needing a ramp", and that was wrong twice over: the token IS
                // the width at FULL scale — the weight at about 500 m of ground per
                // point and no wider — and the fact that MapKit does not thin a
                // stroke by itself is exactly why the ramp has to be applied here.
                // Drawing every stroke at full weight at every zoom is the thing
                // `railwayScale` exists to prevent: a nationwide Japan that reads
                // as one fused mass of railway rather than as a network.
                let scale = mapView.bounds.width > 1
                    ? RailStyle.scale(atZoom: Self.zoomLevel(of: mapView)) : 1
                if let polyline = overlay as? MKPolyline {
                    let renderer = MKPolylineRenderer(polyline: polyline)
                    let key = polyline.title ?? ""
                    let style = overlayStyles[key]
                    renderer.strokeColor = (style?.color ?? .systemBlue)
                        .withAlphaComponent(style?.alpha ?? 1)
                    renderer.lineWidth = Self.drawnWidth(style, atScale: scale)
                    renderer.lineCap = .round
                    renderer.lineJoin = .round
                    if style?.dashed == true {
                        renderer.lineDashPattern = RailStyle.dashPattern(atScale: scale)
                    }
                    if !key.isEmpty { overlayRenderers[key] = renderer }
                    return renderer
                }
                guard let multi = overlay as? MKMultiPolyline else {
                    return MKOverlayRenderer(overlay: overlay)
                }
                let renderer = MKMultiPolylineRenderer(multiPolyline: multi)
                let key = multi.title ?? ""
                let style = overlayStyles[key]
                renderer.strokeColor = (style?.color ?? .systemBlue).withAlphaComponent(style?.alpha ?? 1)
                renderer.lineWidth = Self.drawnWidth(style, atScale: scale)
                renderer.lineCap = .round
                renderer.lineJoin = .round
                if style?.dashed == true {
                    renderer.lineDashPattern = RailStyle.dashPattern(atScale: scale)
                }
                if !key.isEmpty { overlayRenderers[key] = renderer }
                return renderer
            }

            func mapView(
                _ mapView: MKMapView, viewFor annotation: any MKAnnotation
            ) -> MKAnnotationView? {
                let zoom = Self.zoomLevel(of: mapView)
                let scale = mapView.bounds.width > 1
                    ? Self.quantised(RailStyle.scale(atZoom: zoom), on: mapView) : 1
                if let station = annotation as? StationAnnotation {
                    let identifier = "network-station"
                    let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                        as? StationAnnotationView
                        ?? StationAnnotationView(annotation: station, reuseIdentifier: identifier)
                    view.annotation = station
                    view.configure(station, scale: scale, zoom: zoom)
                    return view
                }
                if let station = annotation as? RideStationAnnotation {
                    let identifier = "ride-station"
                    let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                        as? RideStationAnnotationView
                        ?? RideStationAnnotationView(
                            annotation: station, reuseIdentifier: identifier)
                    view.annotation = station
                    view.configure(station, scale: scale)
                    return view
                }
                if let label = annotation as? RideLabelAnnotation {
                    let identifier = "ride-station-label"
                    let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                        as? RideLabelAnnotationView
                        ?? RideLabelAnnotationView(annotation: label, reuseIdentifier: identifier)
                    view.annotation = label
                    view.configure(label, scale: scale, zoom: zoom)
                    return view
                }
                if let endpoint = annotation as? EndpointLabelAnnotation {
                    let identifier = "ride-endpoint-label"
                    let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                        as? EndpointLabelView
                        ?? EndpointLabelView(annotation: endpoint, reuseIdentifier: identifier)
                    view.annotation = endpoint
                    view.configure(endpoint)
                    return view
                }
                guard let annotation = annotation as? PlaybackAnnotation else { return nil }
                let identifier = annotation.kind == .head ? "playback-head" : "playback-station"
                let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                    ?? MKAnnotationView(annotation: annotation, reuseIdentifier: identifier)
                view.annotation = annotation
                // Playback beads are multiples of an ORDINARY station's radius,
                // and they ride the same factor as that station: a stop already
                // reached is filled and larger, and the one just reached swells
                // toward the current-station scale as its pulse runs.
                let swell = RailStyle.playbackStationScale
                    + (RailStyle.playbackStationCurrentScale - RailStyle.playbackStationScale)
                    * CGFloat(annotation.pulse)
                let multiple: CGFloat = annotation.kind == .head
                    ? RailStyle.playbackHeadScale
                    : annotation.pulse > 0
                        ? swell
                        : annotation.active
                            ? RailStyle.playbackStationDoneScale
                            : RailStyle.playbackStationScale
                let size = max(2, RailStyle.stationRadius * multiple * 2 * scale)
                view.frame.size = CGSize(width: size, height: size)
                view.layer.cornerRadius = size / 2
                view.layer.borderWidth = RailStyle.stationRing * 2 * scale
                view.layer.borderColor = UIColor.white.cgColor
                view.backgroundColor = annotation.active
                    ? annotation.color : annotation.color.withAlphaComponent(0.25)
                view.layer.shadowColor = UIColor.black.cgColor
                view.layer.shadowOpacity = annotation.kind == .head ? 0.28 : 0
                view.layer.shadowRadius = 4
                view.canShowCallout = annotation.kind == .station
                view.accessibilityLabel = annotation.title
                return view
            }

            // MARK: - geometry helpers

            /// Web-Mercator zoom for the map view's current span, in the
            /// Google/Leaflet convention: 256-point tiles, so the world is
            /// `256 × 2^zoom` points wide.
            ///
            /// **This is one level above MapLibre's**, and the comment that used to
            /// stand here — "so the ported LOD thresholds mean the same thing here
            /// as they do in MapLibre" — was wrong. MapLibre's tiles are 512 px, so
            /// the same ground scale reports one level LOWER there:
            ///
            ///     78271.52 × cos35° / 2⁷  = 500.9 m per MapLibre pixel
            ///     156543.03 × cos35° / 2⁸ = 500.9 m per point here
            ///
            /// The web app confirms its own side of that: `app-map-fit.js` computes
            /// its longitude-per-pixel as `360 / (512 × 2^minZoom)`.
            ///
            /// So every threshold ported out of the web app is a MapLibre number
            /// and **must be converted before it is read against this zoom**, or
            /// it fires one level early — one step wider than the web app fires
            /// it. Both places that got this wrong have been fixed and measured:
            /// the station gate (jp drew 3,963 dots at a city view where the web
            /// app draws 348) and `NetworkLOD.minZoom` (652 lines at a national
            /// view against 431). Weights and the ride label tiers convert too.
            ///
            /// The conversion is `RailStyle.zoom(fromMapLibre:)` and its inverse.
            /// Anything new that compares a ported number against this value
            /// without one of them is a bug of the same shape.
            static func zoomLevel(of mapView: MKMapView) -> Double {
                let width = max(mapView.bounds.width, 1)
                let longitudeDelta = max(mapView.region.span.longitudeDelta, 1e-9)
                return log2(360 * (width / 256) / longitudeDelta)
            }

            /// The widest mark ``RailStyle/scale(atZoom:)`` is ever multiplied
            /// into, in points at full weight.
            ///
            /// A bound rather than a measurement, and deliberately generous: it
            /// only decides how finely the shared factor is rounded, and being
            /// too large costs a redraw nobody needed while being too small
            /// costs a visible step. A station bead is 6 pt, a ride stroke with
            /// the reader's 線路粗細 at its widest and the focus boost on top
            /// is under 10, and a playback head is a multiple of the bead's
            /// radius.
            private static let widestScaledMark: CGFloat = 12

            /// The shared factor, rounded to the finest step the screen can
            /// actually show on ``widestScaledMark``.
            static func quantised(_ scale: CGFloat, on mapView: MKMapView) -> CGFloat {
                let pixel = 1 / max(mapView.traitCollection.displayScale, 1)
                let step = pixel / widestScaledMark
                return (scale / step).rounded() * step
            }

            static func metresPerPixel(zoom: Double, latitude: Double) -> Double {
                156_543.03392 * cos(latitude * .pi / 180) / pow(2, zoom)
            }

            static func region(covering lines: [RailNetworkStore.DrawnLine]) -> MKCoordinateRegion? {
                var minLat = Double.infinity, maxLat = -Double.infinity
                var minLon = Double.infinity, maxLon = -Double.infinity
                for line in lines {
                    for interval in line.intervals {
                        for point in interval {
                            minLat = min(minLat, point.lat)
                            maxLat = max(maxLat, point.lat)
                            minLon = min(minLon, point.lon)
                            maxLon = max(maxLon, point.lon)
                        }
                    }
                }
                guard minLat <= maxLat, minLon <= maxLon else { return nil }
                return MKCoordinateRegion(
                    center: CLLocationCoordinate2D(
                        latitude: (minLat + maxLat) / 2, longitude: (minLon + maxLon) / 2),
                    span: MKCoordinateSpan(
                        latitudeDelta: max((maxLat - minLat) * 1.25, 0.01),
                        longitudeDelta: max((maxLon - minLon) * 1.25, 0.01))
                )
            }

            static func region(covering strokes: [[Coordinate]]) -> MKCoordinateRegion? {
                var minLat = Double.infinity, maxLat = -Double.infinity
                var minLon = Double.infinity, maxLon = -Double.infinity
                for stroke in strokes {
                    for point in stroke {
                        minLat = min(minLat, point.lat)
                        maxLat = max(maxLat, point.lat)
                        minLon = min(minLon, point.lon)
                        maxLon = max(maxLon, point.lon)
                    }
                }
                guard minLat <= maxLat, minLon <= maxLon else { return nil }
                return MKCoordinateRegion(
                    center: CLLocationCoordinate2D(
                        latitude: (minLat + maxLat) / 2,
                        longitude: (minLon + maxLon) / 2
                    ),
                    span: MKCoordinateSpan(
                        latitudeDelta: max((maxLat - minLat) * 1.35, 0.01),
                        longitudeDelta: max((maxLon - minLon) * 1.35, 0.01)
                    )
                )
            }

            /// The `[r, g, b]` channels a `MarkerRecord` carries.
            ///
            /// Taken from the RECORD rather than parsed back out of the
            /// `"rgb(26,26,26)"` string its feature prints: that string exists
            /// because deck.gl wanted CSS, and its `undefined` blue channel for a
            /// short array is a JavaScript quirk the port reproduces faithfully —
            /// not a colour format anything on this side should have to read.
            static func uiColor(channels: [Double]?) -> UIColor? {
                guard let channels, channels.count >= 3 else { return nil }
                return UIColor(
                    red: CGFloat(channels[0] / 255), green: CGFloat(channels[1] / 255),
                    blue: CGFloat(channels[2] / 255), alpha: 1)
            }

            static func uiColor(hex: String) -> UIColor? {
                var text = hex.trimmingCharacters(in: .whitespacesAndNewlines)
                if text.hasPrefix("#") { text.removeFirst() }
                guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
                return UIColor(
                    red: CGFloat((value >> 16) & 0xff) / 255,
                    green: CGFloat((value >> 8) & 0xff) / 255,
                    blue: CGFloat(value & 0xff) / 255,
                    alpha: 1
                )
            }
        }
    }
}
