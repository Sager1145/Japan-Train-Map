import MapKit
import RailCore
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
    /// The wire to the control bar, which lives elsewhere in the layout — at
    /// the bottom of the screen on iPhone, at the foot of the sidebar on iPad.
    var controller: RailMapController
    var playback: PlaybackController
    var onSelectRide: (String?) -> Void
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
            basemapOpacity: basemapOpacity,
            controller: controller,
            playback: playback,
            display: displaySettings.map(DisplayValues.init) ?? DisplayValues(),
            naming: localization.map(MapNaming.init) ?? MapNaming(),
            localization: localization,
            onSelectRide: onSelectRide,
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
        var basemapOpacity: Double
        var controller: RailMapController
        var playback: PlaybackController
        var display: DisplayValues
        /// What the reader's language settles, as a value the renderer can
        /// compare — see ``MapNaming``. The lookups themselves go through
        /// `localization`.
        var naming: MapNaming
        var localization: AppLocalization?
        var onSelectRide: (String?) -> Void
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
            context.coordinator.controller = controller
            context.coordinator.playback = playback
            playback.mapRenderer = context.coordinator
            playback.mapRendererViewSize = mapView.bounds.size
            controller.mapView = mapView
            let tap = UITapGestureRecognizer(
                target: context.coordinator, action: #selector(Coordinator.handleMapTap(_:)))
            tap.delegate = context.coordinator
            mapView.addGestureRecognizer(tap)

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
            var onSelectRide: (String?) -> Void = { _ in }
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
            private var showsNetwork = true
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

            func update(
                lines: [RailNetworkStore.DrawnLine],
                stations: [RailNetworkStore.DrawnStation],
                rides: [RiddenRouteStore.DrawnRide],
                selectedTrainID: String?,
                selectedDate: String,
                showsNetwork: Bool,
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
                        || selectionChanged || visibilityChanged
                        || displayChanged || dateChanged || namingChanged else { return }

                self.display = display
                self.selectedDate = selectedDate
                self.naming = naming
                self.showsNetwork = showsNetwork
                self.basemapOpacity = basemapOpacity
                self.selectedTrainID = selectedTrainID
                if ridesChanged { self.rides = rides }
                if stationsChanged { self.stations = stations }

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
                    framePending = !lines.isEmpty
                }

                let selectedRide = rides.first { $0.id == selectedTrainID }
                let selectionRegion = selectedRide.flatMap { Self.region(covering: $0.strokes) }
                let controller = self.controller
                DispatchQueue.main.async { controller?.selectionRegion = selectionRegion }

                builtForZoom = nil
                rebuild(on: mapView)

                if framePending, let region = Self.region(covering: lines) {
                    framePending = false
                    mapView.setRegion(region, animated: false)
                }
            }

            /// Everything about one ride that changes what is DRAWN for it.
            ///
            /// The stop count and the day-span signature are here because they
            /// are now inputs: the stops decide which dots exist and what role
            /// each carries, and the day span decides where the cross-day
            /// diamond lands and which segments dash. Before those were read,
            /// a ride edited into a different stop list with the same geometry
            /// would have kept its old markers.
            static func rideSignature(_ ride: RiddenRouteStore.DrawnRide) -> String {
                "\(ride.id):\(ride.vertexCount):\(ride.colorHex):\(ride.visible ? 1 : 0)"
                    + ":\(ride.stops.count):\(ride.daySpan.sig)"
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

            func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
                rebuild(on: mapView)
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

                // Decimation, unlike the visibility rule, IS ours. MapLibre gets
                // it free from geojson-vt; MapKit has no equivalent, so the same
                // idea is applied here — drop vertices that cannot move the drawn
                // line by as much as half a pixel at this zoom. Bounded that way
                // it cannot change what a reader sees, only what the GPU is asked
                // to do to show it.
                let epsilon = Self.metresPerPixel(zoom: zoom, latitude: mapView.region.center.latitude) * 0.5

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
                // once, handed to every weight below — see RailStyle.
                let scale = RailStyle.scale(atZoom: zoom)
                styledScale = scale

                mapView.removeOverlays(mapView.overlays)
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
                let orderedRides = rides.sorted { left, right in
                    left.id != selectedTrainID && right.id == selectedTrainID
                }
                for (index, ride) in orderedRides.enumerated() {
                    // Split by the calendar day each SEGMENT runs on, which is
                    // why the strokes are taken from `segments` rather than
                    // from `strokes`: `Dates.segmentDate` needs the segment's
                    // own index and the flattened list has thrown it away.
                    var solid: [MKPolyline] = []
                    var crossDay: [MKPolyline] = []
                    for segment in ride.segments {
                        let stroke = segment.coordinates
                        guard stroke.count >= 2 else { continue }
                        // Straight off the ride's own coordinates. Rule R14 is
                        // withdrawn (commit 38cf0a8): a drawn vertex is the
                        // surveyed vertex, so nothing between here and the
                        // renderer may move one sideways. Decimation is allowed
                        // because it only ever DROPS vertices, and only ones
                        // that cannot move the line by half a point.
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

                if showsNetwork {
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
                            // `nil` is the standalone case — no localisation
                            // engine at all — which is what keeps the single
                            // `nameRoma` subline. See `popupView`.
                            readings: self.localization == nil
                                ? nil : named.readings.map(\.text))
                    }
                    networkAnnotations = stationAnnotations
                    mapView.addAnnotations(stationAnnotations)
                }

                // Every visible ride's calls, flattened into the deck marker
                // records `RailCore.StationDisplay` already knows how to elect
                // names for. Not just the selected ride's: the election exists
                // because a station reached by twenty trains ships twenty records
                // that all know the same name, and only one of them may print it.
                let drawn = markerRecords(for: rides, settings: display.markers)
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
                    guard MapRideMarkers.drawsDot(role: feature.role, atZoom: zoom)
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
                    guard !feature.name.isEmpty, let tier = annotation.labelTier,
                          zoom >= RailStyle.zoom(fromMapLibre: Double(tier.minZoom))
                    else { continue }
                    // The election runs on the package's own names — see
                    // `markerRecords` — and only the winner is translated, so
                    // which record carries a name never depends on the
                    // reader's language.
                    markerAnnotations.append(RideLabelAnnotation(
                        coordinate: annotation.coordinate,
                        text: localized(feature.name, code: item.stationCode).display,
                        tier: tier, dotRadiusToken: annotation.drawnRadiusToken,
                        selected: annotation.selected))
                }
                rideStationAnnotations = markerAnnotations
                mapView.addAnnotations(markerAnnotations)

                // The selected ride's origin / destination cards, and — when a
                // day is in scope — that DAY's first origin and last
                // destination with a 起點/終點 badge, which is `updateEndpointLabels`
                // step (1). `computeScopedEndpoints` is not ported: the scoped
                // pair is derived here from the rides the map already holds.
                endpointAnnotations = endpointSpecs().map(EndpointLabelAnnotation.init)
                if !endpointAnnotations.isEmpty {
                    mapView.addAnnotations(endpointAnnotations)
                    layoutEndpointLabels(on: mapView)
                }

                if let lastPlaybackSnapshot {
                    paintPlayback(lastPlaybackSnapshot, on: mapView, applyCamera: false)
                }

                let elapsed = ContinuousClock.now - started
                NSLog(
                    "railmap: z=%.2f thr=%.1f lines=%d/%d (culled %d) overlays=%d vertices=%d "
                        + "stations=%d ridedots=%d ridelabels=%d %dms",
                    zoom, fitted.threshold, visible.count, lines.count,
                    selection?.culledOffScreen ?? 0,
                    overlays.count + rideOverlays.count + rideCasings.count,
                    vertices,
                    networkAnnotations.count,
                    rideStationAnnotations.filter { $0 is RideStationAnnotation }.count,
                    rideStationAnnotations.filter { $0 is RideLabelAnnotation }.count,
                    elapsed.milliseconds)
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
                    name: named.display, badge: badge, time: time,
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
                    endpointAnnotations[index].spec = specs[index]
                    (mapView.view(for: endpointAnnotations[index]) as? EndpointLabelView)?
                        .configure(endpointAnnotations[index])
                }
            }

            @objc func handleMapTap(_ recognizer: UITapGestureRecognizer) {
                guard recognizer.state == .ended, let mapView,
                      lastPlaybackSnapshot == nil else { return }
                let point = recognizer.location(in: mapView)
                var hits: [(id: String, distance: CGFloat)] = []
                for ride in rides {
                    var best = CGFloat.infinity
                    for stroke in ride.strokes where stroke.count >= 2 {
                        var previous = mapView.convert(stroke[0].clLocation, toPointTo: mapView)
                        for coordinate in stroke.dropFirst() {
                            let next = mapView.convert(coordinate.clLocation, toPointTo: mapView)
                            best = min(best, Self.pointSegmentDistance(point, previous, next))
                            previous = next
                        }
                    }
                    if best <= 18 { hits.append((ride.id, best)) }
                }
                hits.sort { $0.distance < $1.distance }
                guard let nearest = hits.first else { return }
                onSelectRide(nearest.id)
            }

            func gestureRecognizer(
                _ gestureRecognizer: UIGestureRecognizer,
                shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
            ) -> Bool { true }

            private static func pointSegmentDistance(
                _ point: CGPoint, _ a: CGPoint, _ b: CGPoint
            ) -> CGFloat {
                let dx = b.x - a.x
                let dy = b.y - a.y
                let denominator = dx * dx + dy * dy
                let ratio = denominator > 0
                    ? min(max(((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator, 0), 1)
                    : 0
                return hypot(point.x - (a.x + ratio * dx), point.y - (a.y + ratio * dy))
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
                let scale = RailStyle.scale(atZoom: Self.zoomLevel(of: mapView))
                guard !styledScale.isFinite || abs(scale - styledScale) >= 0.005 else { return }
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
                let zoom = Self.zoomLevel(of: mapView)
                for annotation in networkAnnotations {
                    (mapView.view(for: annotation) as? StationAnnotationView)?
                        .applyScale(scale, zoom: zoom)
                }
                for annotation in rideStationAnnotations {
                    guard let view = mapView.view(for: annotation) else { continue }
                    if let dot = view as? RideStationAnnotationView {
                        dot.applyScale(scale)
                    } else if let label = view as? RideLabelAnnotationView {
                        label.applyScale(scale, zoom: zoom)
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
                var title: String? { displayName }
                var subtitle: String? {
                    if let first = readings?.first { return first }
                    guard readings == nil, !station.popup.nameRoma.isEmpty else { return nil }
                    return station.popup.nameRoma
                }
                init(
                    station: RailNetworkStore.DrawnStation,
                    displayName: String, readings: [String]?
                ) {
                    self.station = station
                    self.displayName = displayName
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
                    coordinate: CLLocationCoordinate2D, name: String, role: String,
                    radius: CGFloat, lineWidth: CGFloat, focusScale: CGFloat,
                    fill: UIColor, stroke: UIColor, alpha: CGFloat,
                    focusBoost: CGFloat, selected: Bool
                ) {
                    self.coordinate = coordinate
                    self.name = name
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
                let tier: StationDisplay.RideLabelTier
                /// Where the dot ends, so the text can sit beside it rather than
                /// on it. A token, like every other size here.
                let dotRadiusToken: CGFloat
                let selected: Bool
                var title: String? { text }
                init(
                    coordinate: CLLocationCoordinate2D, text: String,
                    tier: StationDisplay.RideLabelTier, dotRadiusToken: CGFloat,
                    selected: Bool
                ) {
                    self.coordinate = coordinate
                    self.text = text
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
                    canShowCallout = true
                }

                required init?(coder: NSCoder) { nil }

                func configure(_ item: StationAnnotation, scale: CGFloat, zoom: Double) {
                    station = item.station
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
                        named: station.showsLabel)
                    accessibilityLabel = item.displayName
                    detailCalloutAccessoryView = Self.popupView(
                        station.popup, readings: item.readings)
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
                    guard let station else { return }
                    let dark = traitCollection.userInterfaceStyle == .dark
                    let diameter = max(1, RailStyle.stationDiameter * scale)
                    dot.frame = CGRect(
                        x: 0, y: 12 - diameter / 2, width: diameter, height: diameter)
                    dot.layer.cornerRadius = diameter / 2
                    dot.layer.borderWidth = RailStyle.stationRing * scale

                    // The beads appear at each station's own minZoom; the NAMES
                    // wait for a second, higher floor, because a name needs a
                    // district's worth of room and a bead does not.
                    let names = station.showsLabel && zoom >= MapLabelStyle.stationLabelMinZoom
                    let size = MapLabelStyle.stationLabelSize(atZoom: zoom)
                    nameLabel.isHidden = !names
                    nameLabel.font = MapLabelStyle.font(ofSize: size)
                    nameLabel.textColor = MapLabelStyle.ink(dark: dark)
                    nameLabel.haloColor = MapLabelStyle.halo(dark: dark)

                    let labelSize = names
                        ? nameLabel.sizeThatFits(CGSize(width: 180, height: 24)) : .zero
                    // `text-radial-offset` is in ems, so the gap grows with the
                    // text rather than holding a pixel count while the label
                    // around it changes size. The halo needs room of its own on
                    // both sides or it is clipped by the label's bounds.
                    let gap = size * MapLabelStyle.radialOffsetEm
                    let inset = MapLabelStyle.haloWidth
                    nameLabel.frame = CGRect(
                        x: diameter + gap - inset, y: 1,
                        width: labelSize.width + inset * 2, height: 22)
                    let width = names ? nameLabel.frame.maxX : diameter
                    frame.size = CGSize(width: width, height: 24)
                    centerOffset = CGPoint(x: width / 2 - diameter / 2, y: 0)
                }

                /// `stationPopupHtml`'s header and line rows.
                ///
                /// The three-state reading rule is the web app's and it is not
                /// a nicety: `readings == nil` is the standalone railmap with
                /// no i18n at all, which keeps the single `nameRoma` subline;
                /// an EMPTY list is the app with every reading toggle off,
                /// which means no subline. Here the engine is always present,
                /// so an empty list is an answer — `nameRoma` only stands in
                /// when there is no localisation to ask.
                private static func popupView(
                    _ popup: StationDisplay.PopupModel, readings: [String]?
                ) -> UIView {
                    let stack = UIStackView()
                    stack.axis = .vertical
                    stack.spacing = 5
                    stack.alignment = .leading
                    let sublines = readings
                        ?? (popup.nameRoma.isEmpty ? [] : [popup.nameRoma])
                    for subline in sublines {
                        let reading = UILabel()
                        reading.font = .systemFont(ofSize: 12)
                        reading.textColor = .secondaryLabel
                        reading.text = subline
                        stack.addArrangedSubview(reading)
                    }
                    for row in popup.lines {
                        stack.addArrangedSubview(lineRow(row))
                    }
                    stack.frame.size = stack.systemLayoutSizeFitting(
                        CGSize(width: 280, height: UIView.layoutFittingCompressedSize.height))
                    return stack
                }

                /// One railway through this station: its badge, then its name.
                ///
                /// `railmap-popup.js` draws the operator's mark where there is
                /// one and a colour swatch where there is not — never both, and
                /// never a bare name. `OperatorBranding` has been deciding
                /// WHICH badge since it was ported, through
                /// `StationDisplay.buildPopupModel`; the answer simply had
                /// nowhere to go, because the artwork was not in the bundle.
                /// It is now, under the same relative paths the web app uses.
                private static func lineRow(_ row: StationDisplay.PopupRow) -> UIView {
                    let line = UIStackView()
                    line.axis = .horizontal
                    line.spacing = 6
                    line.alignment = .center

                    if let badge = logoView(row) {
                        line.addArrangedSubview(badge)
                    } else {
                        // `.rp-line-swatch`: 14 × 6, the line's own colour.
                        let swatch = UIView()
                        swatch.backgroundColor = Coordinator.uiColor(hex: row.color) ?? .systemGray
                        swatch.layer.cornerRadius = 2
                        swatch.translatesAutoresizingMaskIntoConstraints = false
                        swatch.widthAnchor.constraint(equalToConstant: 14).isActive = true
                        swatch.heightAnchor.constraint(equalToConstant: 6).isActive = true
                        line.addArrangedSubview(swatch)
                    }

                    let label = UILabel()
                    label.font = .systemFont(ofSize: 12, weight: .medium)
                    label.textColor = .label
                    label.numberOfLines = 0
                    label.text = [row.company, row.label].filter { !$0.isEmpty }
                        .joined(separator: "  ")
                    line.addArrangedSubview(label)
                    return line
                }

                /// `.rp-line-logo`: 16 pt tall, aspect kept, never wider than 48.
                ///
                /// The dark matte is not decoration and not a theme rule — it is
                /// for the handful of operators whose current mark is drawn
                /// predominantly in WHITE because their own site puts it on a
                /// dark header. `OperatorBranding.logoNeedsDarkMatte` names
                /// them, and only they get it, so the original artwork stays
                /// legible in both appearances.
                private static func logoView(_ row: StationDisplay.PopupRow) -> UIView? {
                    guard let image = logoImage(row.logo) else { return nil }
                    let view = UIImageView(image: image)
                    view.contentMode = .scaleAspectFit
                    view.translatesAutoresizingMaskIntoConstraints = false
                    let ratio = image.size.height > 0 ? image.size.width / image.size.height : 1
                    view.heightAnchor.constraint(equalToConstant: 16).isActive = true
                    view.widthAnchor.constraint(
                        equalToConstant: min(48, 16 * ratio)).isActive = true
                    guard row.logoNeedsDarkMatte else { return view }
                    let matte = UIView()
                    matte.backgroundColor = UIColor(
                        red: 0x24 / 255, green: 0x31 / 255, blue: 0x3a / 255, alpha: 1)
                    matte.layer.cornerRadius = 2
                    matte.addSubview(view)
                    NSLayoutConstraint.activate([
                        view.leadingAnchor.constraint(equalTo: matte.leadingAnchor, constant: 2),
                        view.trailingAnchor.constraint(equalTo: matte.trailingAnchor, constant: -2),
                        view.topAnchor.constraint(equalTo: matte.topAnchor, constant: 1),
                        view.bottomAnchor.constraint(equalTo: matte.bottomAnchor, constant: -1),
                    ])
                    return matte
                }

                /// A web path — `/rail/logos/<id>.png` — resolved in the bundle.
                ///
                /// The ported rule returns the path the JavaScript hands to an
                /// `<img>`, so the leading slash is stripped and the rest used
                /// as-is. Keeping the web's own directory names is what lets one
                /// table serve both clients; inventing a second naming scheme
                /// here would be a second thing to keep in step.
                private static func logoImage(_ path: String?) -> UIImage? {
                    guard let path, !path.isEmpty else { return nil }
                    if let cached = logoCache.object(forKey: path as NSString) { return cached }
                    let relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
                    guard let url = Bundle.main.resourceURL?.appending(path: relative),
                          let image = UIImage(contentsOfFile: url.path)
                    else { return nil }
                    logoCache.setObject(image, forKey: path as NSString)
                    return image
                }

                /// A station complex can list a dozen railways and a reader
                /// opens one callout after another, so the same handful of
                /// badges is decoded over and over without this.
                private static let logoCache = NSCache<NSString, UIImage>()
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
                    canShowCallout = true
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
                    accessibilityLabel = item.name.isEmpty ? nil : item.name
                    canShowCallout = !item.name.isEmpty
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
                    // `rideLabelTiersInPlacementOrder` is weakest first, which is
                    // the order MapLibre pushes the three symbol layers in. Here
                    // the same ordering is a display priority: a terminal claims
                    // its space before an intermediate stop, which claims it
                    // before a station merely rolled through.
                    let rank = StationDisplay.rideLabelTiersInPlacementOrder
                        .firstIndex(of: item.tier) ?? 0
                    // `.required`, and it has to be — measured, not chosen.
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

                /// Badge, name and time on one centred row; the readings
                /// stacked under it, each on its own line — never
                /// bracket-appended, which is the one display rule
                /// `stationNameReadings` exists to spell.
                private func layout(_ spec: MapEndpointLabels.Spec) {
                    let inset = MapLabelStyle.haloWidth
                    let bound = CGSize(width: MapEndpointLabels.maxWidth, height: 24)
                    var row: [(label: UILabel, width: CGFloat)] = []
                    for label in [badge, name, time] where !(label.text ?? "").isEmpty {
                        row.append((label, label.sizeThatFits(bound).width + inset * 2))
                    }
                    for label in [badge, name, time] {
                        label.isHidden = (label.text ?? "").isEmpty
                    }
                    let rowWidth = row.reduce(CGFloat(0)) { $0 + $1.width }
                        + Self.pieceGap * CGFloat(max(row.count - 1, 0))
                    var readingWidths: [CGFloat] = []
                    for label in readings where !label.isHidden {
                        readingWidths.append(label.sizeThatFits(bound).width + inset * 2)
                    }
                    let width = max(rowWidth, readingWidths.max() ?? 0)
                    let height = Self.verticalPadding + Self.mainLineHeight
                        + Self.readingLineHeight * CGFloat(readingWidths.count)
                    frame.size = CGSize(width: max(width, 1), height: max(height, 1))

                    var x = (width - rowWidth) / 2
                    for piece in row {
                        piece.label.frame = CGRect(
                            x: x, y: Self.verticalPadding / 2,
                            width: piece.width, height: Self.mainLineHeight)
                        x += piece.width + Self.pieceGap
                    }
                    var y = Self.verticalPadding / 2 + Self.mainLineHeight
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
                let scale = mapView.bounds.width > 1 ? RailStyle.scale(atZoom: zoom) : 1
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
