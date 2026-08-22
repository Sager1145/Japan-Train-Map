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
            showsNetwork: showsNetwork,
            basemapOpacity: basemapOpacity,
            controller: controller,
            playback: playback,
            display: displaySettings.map(DisplayValues.init) ?? DisplayValues(),
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
        var showsNetwork: Bool
        var basemapOpacity: Double
        var controller: RailMapController
        var playback: PlaybackController
        var display: DisplayValues
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
            playback.mapRenderer = context.coordinator
            playback.mapRendererViewSize = mapView.bounds.size
            context.coordinator.update(
                lines: lines,
                stations: stations,
                rides: rides,
                selectedTrainID: selectedTrainID,
                showsNetwork: showsNetwork,
                basemapOpacity: basemapOpacity,
                display: display,
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

            private var lines: [RailNetworkStore.DrawnLine] = []
            private var stations: [RailNetworkStore.DrawnStation] = []
            private var rides: [RiddenRouteStore.DrawnRide] = []
            private var selectedTrainID: String?
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
                showsNetwork: Bool,
                basemapOpacity: Double,
                display: DisplayValues,
                on mapView: MKMapView
            ) {
                let linesChanged = lines.map(\.id) != self.lines.map(\.id)
                let stationsChanged = stations.map(\.id) != self.stations.map(\.id)
                let ridesChanged = rides.map { "\($0.id):\($0.vertexCount):\($0.colorHex)" }
                    != self.rides.map { "\($0.id):\($0.vertexCount):\($0.colorHex)" }
                let selectionChanged = selectedTrainID != self.selectedTrainID
                let visibilityChanged = showsNetwork != self.showsNetwork
                    || basemapOpacity != self.basemapOpacity
                // Every 顯示調節 number is a width, a radius or an opacity of
                // something already drawn, so a change to one is a rebuild like
                // any other rather than a separate code path.
                let displayChanged = display != self.display
                guard linesChanged || stationsChanged || ridesChanged
                        || selectionChanged || visibilityChanged
                        || displayChanged else { return }

                self.display = display
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
                // While one ride is selected every other ride still drawn fades,
                // dots included. `riddenOpacity` is the reader's own floor under
                // that; `dimOpacity` is not used here because it answers a
                // different question — see the note on `DisplayValues`.
                let hasSelection = rides.contains { $0.id == selectedTrainID }
                func rideAlpha(selected: Bool) -> CGFloat {
                    if selected { return 1 }
                    return CGFloat(display.riddenOpacity)
                        * (hasSelection ? RailStyle.selectDim : 1)
                }

                var rideCasings: [MKMultiPolyline] = []
                var rideOverlays: [MKMultiPolyline] = []
                let orderedRides = rides.sorted { left, right in
                    left.id != selectedTrainID && right.id == selectedTrainID
                }
                for (index, ride) in orderedRides.enumerated() {
                    let polylines = ride.strokes.compactMap { stroke -> MKPolyline? in
                        guard stroke.count >= 2 else { return nil }
                        // Straight off the ride's own coordinates. Rule R14 is
                        // withdrawn (commit 38cf0a8): a drawn vertex is the
                        // surveyed vertex, so nothing between here and the
                        // renderer may move one sideways. Decimation is allowed
                        // because it only ever DROPS vertices, and only ones
                        // that cannot move the line by half a point.
                        let kept = Geometry.douglasPeuckerIndices(stroke, epsilonMeters: epsilon)
                        let points = kept.map { stroke[$0].clLocation }
                        guard points.count >= 2 else { return nil }
                        return MKPolyline(coordinates: points, count: points.count)
                    }
                    guard !polylines.isEmpty else { continue }
                    let styleKey = "ride|\(index)|\(ride.id)"
                    let selected = ride.id == selectedTrainID
                    let multi = MKMultiPolyline(polylines)
                    multi.title = styleKey
                    overlayStyles[styleKey] = OverlayStyle(
                        color: Self.uiColor(hex: ride.colorHex) ?? .systemBlue,
                        widthToken: rideWidthToken(selected: selected),
                        alpha: rideAlpha(selected: selected)
                    )
                    rideOverlays.append(multi)

                    // §10.5: a selection has to change more than a colour. The
                    // casing is a dark halo UNDER the selected line, 0.7 pt per
                    // side at full scale — Apple's restrained selected-transit
                    // outline rather than a glow — and it rides the same ramp, or
                    // "selected" would read differently at every zoom.
                    guard selected else { continue }
                    let casingKey = "ride-casing|\(index)|\(ride.id)"
                    let casing = MKMultiPolyline(polylines)
                    casing.title = casingKey
                    overlayStyles[casingKey] = OverlayStyle(
                        // `MAP_SURFACE_COLORS[theme].casing`, the same two values
                        // the web app's selection halo uses.
                        color: Self.uiColor(hex: dark ? "#F5EEE9" : "#1A1A1A") ?? .label,
                        widthToken: rideWidthToken(selected: true)
                            + RailStyle.selectionCasingEdge * 2,
                        alpha: 0.9
                    )
                    rideCasings.append(casing)
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
                        return StationAnnotation(station: station)
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
                // Below `STOP_MIN_ZOOM` only the ride's two ends draw. Its
                // intermediate calls at a national view are a smear, and its ends
                // are the whole of what the ride says at that scale.
                let drawsStops = MapRideMarkers.drawsStopDots(atZoom: zoom)
                var markerAnnotations: [MKAnnotation] = []
                var lastEmitted: RideStationAnnotation?
                for (record, feature) in drawn {
                    guard drawsStops || feature.role == "terminal" else {
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
                    let annotation = RideStationAnnotation(
                        coordinate: record.position.clLocation,
                        name: feature.name,
                        role: feature.role,
                        radius: CGFloat(feature.radius),
                        lineWidth: CGFloat(feature.lineWidth),
                        focusScale: CGFloat(feature.focusScale),
                        fill: Self.uiColor(channels: record.fillColor) ?? .white,
                        stroke: Self.uiColor(channels: record.lineColor) ?? .black,
                        alpha: CGFloat(feature.alpha) * rideAlpha(selected: feature.tid == selectedTrainID),
                        focusBoost: CGFloat(display.focusBoost),
                        selected: feature.tid == selectedTrainID)
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
                    markerAnnotations.append(RideLabelAnnotation(
                        coordinate: annotation.coordinate, text: feature.name,
                        tier: tier, dotRadiusToken: annotation.drawnRadiusToken,
                        selected: annotation.selected))
                }
                rideStationAnnotations = markerAnnotations
                mapView.addAnnotations(markerAnnotations)

                // The selected ride's origin / destination name cards. The web
                // app also labels the selected DAY's first origin and last
                // destination with a 起點/終點 badge; that scope is not reachable
                // from here (see `MapEndpointLabels`), so what is drawn is the
                // half this app's inputs can prove.
                if let ride = rides.first(where: { $0.id == selectedTrainID }) {
                    let annotations = MapEndpointLabels.specs(for: ride)
                        .map { EndpointLabelAnnotation(spec: $0) }
                    endpointAnnotations = annotations
                    mapView.addAnnotations(annotations)
                    layoutEndpointLabels(on: mapView)
                }

                if let lastPlaybackSnapshot {
                    paintPlayback(lastPlaybackSnapshot, on: mapView, applyCamera: false)
                }

                let elapsed = ContinuousClock.now - started
                NSLog(
                    "railmap: z=%.2f thr=%.1f lines=%d/%d (culled %d) overlays=%d vertices=%d %dms",
                    zoom, fitted.threshold, visible.count, lines.count,
                    selection?.culledOffScreen ?? 0,
                    overlays.count + rideOverlays.count + rideCasings.count,
                    vertices,
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
                (key: String, settings: MapRideMarkers.Settings,
                 drawn: [(record: StationDisplay.MarkerRecord,
                          feature: StationDisplay.MarkerFeature)])?

            private func markerRecords(
                for rides: [RiddenRouteStore.DrawnRide], settings: MapRideMarkers.Settings
            ) -> [(record: StationDisplay.MarkerRecord, feature: StationDisplay.MarkerFeature)] {
                let key = rides.map { "\($0.id):\($0.vertexCount):\($0.visible ? 1 : 0)" }
                    .joined(separator: "|")
                if let markerCache, markerCache.key == key, markerCache.settings == settings {
                    return markerCache.drawn
                }
                let drawn = MapRideMarkers.drawn(rides: rides, settings: settings)
                markerCache = (key, settings, drawn)
                return drawn
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
                            ? RailStyle.dashPattern(forWidth: width) : nil
                    } else if let multi = renderer as? MKMultiPolylineRenderer {
                        multi.lineWidth = width
                        multi.lineDashPattern = style?.dashed == true
                            ? RailStyle.dashPattern(forWidth: width) : nil
                    } else {
                        continue
                    }
                    renderer.setNeedsDisplay()
                }
                for annotation in networkAnnotations {
                    (mapView.view(for: annotation) as? StationAnnotationView)?.applyScale(scale)
                }
                let zoom = Self.zoomLevel(of: mapView)
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
                        title: $0.element.name, color: color,
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
                var title: String? { station.popup.name }
                var subtitle: String? { station.popup.nameRoma.isEmpty ? nil : station.popup.nameRoma }
                init(station: RailNetworkStore.DrawnStation) {
                    self.station = station
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
                var title: String? { spec.text }
                init(spec: MapEndpointLabels.Spec) {
                    self.spec = spec
                    coordinate = spec.coordinate.clLocation
                }
            }

            private final class StationAnnotationView: MKAnnotationView {
                private let dot = UIView()
                private let nameLabel = UILabel()
                private var station: RailNetworkStore.DrawnStation?
                /// The factor the dot below is currently drawn at. Held so a
                /// rescale is a resize rather than a rebuild.
                private var scale: CGFloat = 1

                override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
                    super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
                    addSubview(dot)
                    addSubview(nameLabel)
                    dot.layer.borderColor = UIColor.systemBackground.cgColor
                    // Text is not a mark and never thins with the railway scale.
                    nameLabel.font = .systemFont(ofSize: 10, weight: .semibold)
                    nameLabel.textColor = .label
                    nameLabel.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.82)
                    nameLabel.layer.cornerRadius = 4
                    nameLabel.layer.masksToBounds = true
                    collisionMode = .rectangle
                    canShowCallout = true
                }

                required init?(coder: NSCoder) { nil }

                func configure(_ item: StationAnnotation, scale: CGFloat) {
                    station = item.station
                    self.scale = scale
                    let station = item.station
                    dot.backgroundColor = Coordinator.uiColor(hex: station.colorHex) ?? .systemGray
                    nameLabel.text = station.showsLabel ? "  \(station.name)  " : nil
                    nameLabel.isHidden = !station.showsLabel
                    displayPriority = station.isTerminal ? .required
                        : station.showsLabel ? .defaultHigh : .defaultLow
                    accessibilityLabel = station.name
                    detailCalloutAccessoryView = Self.popupView(station.popup)
                    relayout()
                }

                func applyScale(_ scale: CGFloat) {
                    guard scale != self.scale else { return }
                    self.scale = scale
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
                    let diameter = max(1, RailStyle.stationDiameter * scale)
                    dot.frame = CGRect(
                        x: 0, y: 12 - diameter / 2, width: diameter, height: diameter)
                    dot.layer.cornerRadius = diameter / 2
                    dot.layer.borderWidth = RailStyle.stationRing * scale
                    let labelSize = station.showsLabel
                        ? nameLabel.sizeThatFits(CGSize(width: 180, height: 24)) : .zero
                    nameLabel.frame = CGRect(
                        x: diameter + 3, y: 1, width: labelSize.width, height: 22)
                    let width = station.showsLabel ? diameter + 3 + labelSize.width : diameter
                    frame.size = CGSize(width: width, height: 24)
                    centerOffset = CGPoint(x: width / 2 - diameter / 2, y: 0)
                }

                private static func popupView(_ popup: StationDisplay.PopupModel) -> UIView {
                    let stack = UIStackView()
                    stack.axis = .vertical
                    stack.spacing = 5
                    stack.alignment = .leading
                    if !popup.nameRoma.isEmpty {
                        let reading = UILabel()
                        reading.font = .systemFont(ofSize: 12)
                        reading.textColor = .secondaryLabel
                        reading.text = popup.nameRoma
                        stack.addArrangedSubview(reading)
                    }
                    for row in popup.lines {
                        let label = UILabel()
                        label.font = .systemFont(ofSize: 12, weight: .medium)
                        label.textColor = .label
                        label.numberOfLines = 1
                        label.text = [row.company, row.label].filter { !$0.isEmpty }
                            .joined(separator: "  ")
                        stack.addArrangedSubview(label)
                    }
                    stack.frame.size = stack.systemLayoutSizeFitting(
                        CGSize(width: 280, height: UIView.layoutFittingCompressedSize.height))
                    return stack
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
                    displayPriority = .required
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
                    dot.frame = CGRect(x: 0, y: 0, width: diameter, height: diameter)
                    dot.layer.cornerRadius = diameter / 2
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
                private let text = UILabel()
                private var item: RideLabelAnnotation?
                private var scale: CGFloat = 1
                private var zoom: Double = 0

                override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
                    super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
                    addSubview(text)
                    text.textColor = .label
                    text.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.82)
                    text.layer.cornerRadius = 4
                    text.layer.masksToBounds = true
                    collisionMode = .rectangle
                }

                required init?(coder: NSCoder) { nil }

                func configure(_ item: RideLabelAnnotation, scale: CGFloat, zoom: Double) {
                    self.item = item
                    self.scale = scale
                    self.zoom = zoom
                    text.text = "  \(item.text)  "
                    accessibilityLabel = item.text
                    // `rideLabelTiersInPlacementOrder` is weakest first, which is
                    // the order MapLibre pushes the three symbol layers in. Here
                    // the same ordering is a display priority: a terminal claims
                    // its space before an intermediate stop, which claims it
                    // before a station merely rolled through.
                    let rank = StationDisplay.rideLabelTiersInPlacementOrder
                        .firstIndex(of: item.tier) ?? 0
                    displayPriority = MKFeatureDisplayPriority(
                        rawValue: MKFeatureDisplayPriority.defaultLow.rawValue
                            + Float(rank) * 250 + (item.selected ? 100 : 0))
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
                    text.font = .systemFont(
                        ofSize: item.tier.textSize(atZoom: RailStyle.mapLibreZoom(from: zoom)),
                        weight: .semibold)
                    let size = text.sizeThatFits(CGSize(width: 190, height: 24))
                    let height = max(size.height, 16)
                    text.frame = CGRect(x: 0, y: 0, width: size.width, height: height)
                    frame.size = CGSize(width: size.width, height: height)
                    centerOffset = CGPoint(
                        x: item.dotRadiusToken * scale + 3 + size.width / 2, y: 0)
                }
            }

            /// The origin / destination card, whose placement is decided in
            /// `MapEndpointLabels` and applied here as a centre offset.
            private final class EndpointLabelView: MKAnnotationView {
                private let card = UILabel()

                override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
                    super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
                    addSubview(card)
                    card.font = MapEndpointLabels.font
                    card.textAlignment = .center
                    card.textColor = .label
                    card.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.92)
                    card.layer.cornerRadius = 6
                    card.layer.masksToBounds = true
                    card.layer.borderWidth = 0.5
                    card.layer.borderColor = UIColor.separator.cgColor
                    // The web app's cards are `pointer-events: none` so they never
                    // block route picking; the same here.
                    isUserInteractionEnabled = false
                    collisionMode = .rectangle
                    displayPriority = .required
                }

                required init?(coder: NSCoder) { nil }

                func configure(_ item: EndpointLabelAnnotation) {
                    card.text = item.spec.text
                    accessibilityLabel = item.spec.text
                    let size = CGSize(width: item.spec.width, height: item.spec.height)
                    card.frame = CGRect(origin: .zero, size: size)
                    frame.size = size
                    centerOffset = MapEndpointLabels.centreOffset(for: item.spec)
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
                        renderer.lineDashPattern = RailStyle.dashPattern(
                            forWidth: renderer.lineWidth)
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
                    renderer.lineDashPattern = RailStyle.dashPattern(forWidth: renderer.lineWidth)
                }
                if !key.isEmpty { overlayRenderers[key] = renderer }
                return renderer
            }

            func mapView(
                _ mapView: MKMapView, viewFor annotation: any MKAnnotation
            ) -> MKAnnotationView? {
                let scale = mapView.bounds.width > 1
                    ? RailStyle.scale(atZoom: Self.zoomLevel(of: mapView)) : 1
                if let station = annotation as? StationAnnotation {
                    let identifier = "network-station"
                    let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                        as? StationAnnotationView
                        ?? StationAnnotationView(annotation: station, reuseIdentifier: identifier)
                    view.annotation = station
                    view.configure(station, scale: scale)
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
                    view.configure(
                        label, scale: scale, zoom: Self.zoomLevel(of: mapView))
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
