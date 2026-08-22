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

struct RailMapView: UIViewRepresentable {
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
        private var expandedRideIDs: [String] = []

        func update(
            lines: [RailNetworkStore.DrawnLine],
            stations: [RailNetworkStore.DrawnStation],
            rides: [RiddenRouteStore.DrawnRide],
            selectedTrainID: String?,
            showsNetwork: Bool,
            basemapOpacity: Double,
            on mapView: MKMapView
        ) {
            let linesChanged = lines.map(\.id) != self.lines.map(\.id)
            let stationsChanged = stations.map(\.id) != self.stations.map(\.id)
            let ridesChanged = rides.map { "\($0.id):\($0.vertexCount):\($0.colorHex)" }
                != self.rides.map { "\($0.id):\($0.vertexCount):\($0.colorHex)" }
            let selectionChanged = selectedTrainID != self.selectedTrainID
            let visibilityChanged = showsNetwork != self.showsNetwork
                || basemapOpacity != self.basemapOpacity
            guard linesChanged || stationsChanged || ridesChanged
                    || selectionChanged || visibilityChanged else { return }

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

            mapView.removeOverlays(mapView.overlays)
            if !networkAnnotations.isEmpty { mapView.removeAnnotations(networkAnnotations) }
            networkAnnotations = []
            if !rideStationAnnotations.isEmpty { mapView.removeAnnotations(rideStationAnnotations) }
            rideStationAnnotations = []
            overlayStyles.removeAll(keepingCapacity: true)
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
                    width: 1.5,
                    alpha: 1
                )
                overlays.append(multi)
            }
            mapView.addOverlays(overlays, level: .aboveRoads)

            var rideOverlays: [MKMultiPolyline] = []
            let orderedRides = rides.sorted { left, right in
                left.id != selectedTrainID && right.id == selectedTrainID
            }
            for (index, ride) in orderedRides.enumerated() {
                let polylines = ride.strokes.compactMap { stroke -> MKPolyline? in
                    guard stroke.count >= 2 else { return nil }
                    let source = expandedCoordinates(for: stroke, rideID: ride.id, on: mapView)
                    let kept = Geometry.douglasPeuckerIndices(source, epsilonMeters: epsilon)
                    let points = kept.map { source[$0].clLocation }
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
                    width: selected ? 6 : 3.5,
                    alpha: selected ? 1 : 0.9
                )
                rideOverlays.append(multi)
            }
            mapView.addOverlays(rideOverlays, level: .aboveRoads)

            if showsNetwork {
                let stationAnnotations = stations.compactMap { station -> StationAnnotation? in
                    guard station.minZoom <= Int(floor(zoom)) else { return nil }
                    let point = MKMapPoint(station.coordinate.clLocation)
                    guard buildRect.contains(point) else { return nil }
                    return StationAnnotation(station: station)
                }
                networkAnnotations = stationAnnotations
                mapView.addAnnotations(stationAnnotations)
            }

            if let ride = rides.first(where: { $0.id == selectedTrainID }) {
                var seen = Set<String>()
                var annotations: [RideStationAnnotation] = []
                for segment in ride.segments {
                    if let first = segment.coordinates.first, let name = segment.from,
                       seen.insert("\(name)|\(Grid.coordKey(first))").inserted {
                        annotations.append(RideStationAnnotation(
                            coordinate: first.clLocation, name: name,
                            color: Self.uiColor(hex: ride.colorHex) ?? .systemBlue))
                    }
                    if let last = segment.coordinates.last, let name = segment.to,
                       seen.insert("\(name)|\(Grid.coordKey(last))").inserted {
                        annotations.append(RideStationAnnotation(
                            coordinate: last.clLocation, name: name,
                            color: Self.uiColor(hex: ride.colorHex) ?? .systemBlue))
                    }
                }
                rideStationAnnotations = annotations
                mapView.addAnnotations(annotations)
            }

            if let lastPlaybackSnapshot {
                paintPlayback(lastPlaybackSnapshot, on: mapView, applyCamera: false)
            }

            let elapsed = ContinuousClock.now - started
            NSLog(
                "railmap: z=%.2f thr=%.1f lines=%d/%d (culled %d) overlays=%d vertices=%d %dms",
                zoom, fitted.threshold, visible.count, lines.count,
                selection?.culledOffScreen ?? 0,
                overlays.count + rideOverlays.count,
                vertices,
                elapsed.milliseconds)
            // Deferred: a rebuild can be triggered from inside updateUIView,
            // and writing SwiftUI state during a view update is undefined
            // behaviour — in practice the panel simply never showed the
            // numbers. Hand them back on the next turn of the loop instead.
            let stats = RenderStats(
                zoom: zoom,
                visibleLines: visible.count,
                overlays: overlays.count + rideOverlays.count,
                vertices: vertices,
                buildMilliseconds: elapsed.milliseconds,
                culledOffScreen: selection?.culledOffScreen ?? 0,
                threshold: fitted.threshold
            )
            DispatchQueue.main.async { [onRender] in onRender(stats) }
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
            if hits.isEmpty {
                if !expandedRideIDs.isEmpty {
                    expandedRideIDs = []
                    builtForZoom = nil
                    rebuild(on: mapView)
                }
                return
            }
            let ids = hits.map(\.id)
            expandedRideIDs = ids.count > 1 ? ids : []
            onSelectRide(ids[0])
            builtForZoom = nil
            rebuild(on: mapView)
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool { true }

        private func expandedCoordinates(
            for stroke: [Coordinate], rideID: String, on mapView: MKMapView
        ) -> [Coordinate] {
            guard let slot = expandedRideIDs.firstIndex(of: rideID),
                  expandedRideIDs.count > 1,
                  let first = stroke.first, let last = stroke.last else { return stroke }
            let a = mapView.convert(first.clLocation, toPointTo: mapView)
            let b = mapView.convert(last.clLocation, toPointTo: mapView)
            let dx = b.x - a.x
            let dy = b.y - a.y
            let length = max(hypot(dx, dy), 1)
            let lane = CGFloat(slot) - CGFloat(expandedRideIDs.count - 1) / 2
            let distance = lane * 8
            let offset = CGPoint(x: -dy / length * distance, y: dx / length * distance)
            return stroke.map {
                let point = mapView.convert($0.clLocation, toPointTo: mapView)
                return Coordinate(
                    lon: mapView.convert(
                        CGPoint(x: point.x + offset.x, y: point.y + offset.y),
                        toCoordinateFrom: mapView).longitude,
                    lat: mapView.convert(
                        CGPoint(x: point.x + offset.x, y: point.y + offset.y),
                        toCoordinateFrom: mapView).latitude)
            }
        }

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

        private struct OverlayStyle {
            var color: UIColor
            var width: CGFloat
            var alpha: CGFloat
        }

        private var overlayStyles: [String: OverlayStyle] = [:]

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
                        color: color, width: 6,
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

        private final class RideStationAnnotation: NSObject, MKAnnotation {
            dynamic var coordinate: CLLocationCoordinate2D
            let title: String?
            let color: UIColor
            init(coordinate: CLLocationCoordinate2D, name: String, color: UIColor) {
                self.coordinate = coordinate
                title = name
                self.color = color
            }
        }

        private final class StationAnnotationView: MKAnnotationView {
            private let dot = UIView()
            private let nameLabel = UILabel()

            override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
                super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
                addSubview(dot)
                addSubview(nameLabel)
                dot.layer.borderColor = UIColor.systemBackground.cgColor
                dot.layer.borderWidth = 1.25
                nameLabel.font = .systemFont(ofSize: 10, weight: .semibold)
                nameLabel.textColor = .label
                nameLabel.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.82)
                nameLabel.layer.cornerRadius = 4
                nameLabel.layer.masksToBounds = true
                collisionMode = .rectangle
                canShowCallout = true
            }

            required init?(coder: NSCoder) { nil }

            func configure(_ item: StationAnnotation) {
                let station = item.station
                let color = Coordinator.uiColor(hex: station.colorHex) ?? .systemGray
                let dotSize: CGFloat = station.isTerminal ? 8 : 6
                dot.backgroundColor = color
                dot.frame = CGRect(x: 0, y: 12 - dotSize / 2, width: dotSize, height: dotSize)
                dot.layer.cornerRadius = dotSize / 2
                nameLabel.text = station.showsLabel ? "  \(station.name)  " : nil
                nameLabel.isHidden = !station.showsLabel
                let labelSize = station.showsLabel
                    ? nameLabel.sizeThatFits(CGSize(width: 180, height: 24)) : .zero
                nameLabel.frame = CGRect(x: dotSize + 3, y: 1, width: labelSize.width, height: 22)
                let width = station.showsLabel ? dotSize + 3 + labelSize.width : dotSize
                frame.size = CGSize(width: width, height: 24)
                centerOffset = CGPoint(x: width / 2 - dotSize / 2, y: 0)
                displayPriority = station.isTerminal ? .required
                    : station.showsLabel ? .defaultHigh : .defaultLow
                accessibilityLabel = station.name
                detailCalloutAccessoryView = Self.popupView(station.popup)
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

        // MARK: - rendering

        func mapView(_ mapView: MKMapView, rendererFor overlay: any MKOverlay) -> MKOverlayRenderer {
            if let polygon = overlay as? MKPolygon, polygon.title == "basemap-veil" {
                let renderer = MKPolygonRenderer(polygon: polygon)
                renderer.fillColor = UIColor.systemBackground.withAlphaComponent(
                    1 - min(max(basemapOpacity, 0), 1))
                return renderer
            }
            if let polyline = overlay as? MKPolyline {
                let renderer = MKPolylineRenderer(polyline: polyline)
                let style = overlayStyles[polyline.title ?? ""]
                renderer.strokeColor = (style?.color ?? .systemBlue)
                    .withAlphaComponent(style?.alpha ?? 1)
                renderer.lineWidth = style?.width ?? 4
                renderer.lineCap = .round
                renderer.lineJoin = .round
                return renderer
            }
            guard let multi = overlay as? MKMultiPolyline else {
                return MKOverlayRenderer(overlay: overlay)
            }
            let renderer = MKMultiPolylineRenderer(multiPolyline: multi)
            let style = overlayStyles[multi.title ?? ""]
            renderer.strokeColor = (style?.color ?? .systemBlue).withAlphaComponent(style?.alpha ?? 1)
            // The web app pins the rail stroke to a fixed fraction of the
            // station dot so the dots read as beads on a wire, and since the
            // 2026-08-20 retune that stroke is 1.5 px at every zoom
            // (railmap-style.js §tokens). MapKit line widths are already in
            // points and are not scaled by zoom, so the token transfers
            // directly rather than needing a ramp.
            renderer.lineWidth = style?.width ?? 1.5
            renderer.lineCap = .round
            renderer.lineJoin = .round
            return renderer
        }

        func mapView(
            _ mapView: MKMapView, viewFor annotation: any MKAnnotation
        ) -> MKAnnotationView? {
            if let station = annotation as? StationAnnotation {
                let identifier = "network-station"
                let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                    as? StationAnnotationView
                    ?? StationAnnotationView(annotation: station, reuseIdentifier: identifier)
                view.annotation = station
                view.configure(station)
                return view
            }
            if let station = annotation as? RideStationAnnotation {
                let identifier = "ride-station"
                let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                    ?? MKAnnotationView(annotation: station, reuseIdentifier: identifier)
                view.annotation = station
                view.subviews.forEach { $0.removeFromSuperview() }
                view.backgroundColor = .clear
                view.layer.borderWidth = 0
                let dot = UIView(frame: CGRect(x: 0, y: 7, width: 11, height: 11))
                dot.layer.cornerRadius = 5.5
                dot.layer.borderWidth = 2
                dot.layer.borderColor = UIColor.systemBackground.cgColor
                dot.backgroundColor = station.color
                view.addSubview(dot)
                let label = UILabel()
                label.text = "  \(station.title ?? "")  "
                label.font = .systemFont(ofSize: 11, weight: .bold)
                label.textColor = .label
                label.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.86)
                label.layer.cornerRadius = 5
                label.layer.masksToBounds = true
                let size = label.sizeThatFits(CGSize(width: 190, height: 24))
                label.frame = CGRect(x: 14, y: 1, width: size.width, height: 23)
                view.addSubview(label)
                view.frame.size = CGSize(width: 14 + size.width, height: 25)
                view.centerOffset = CGPoint(x: view.frame.width / 2 - 5.5, y: 0)
                view.canShowCallout = true
                view.displayPriority = .required
                view.accessibilityLabel = station.title
                return view
            }
            guard let annotation = annotation as? PlaybackAnnotation else { return nil }
            let identifier = annotation.kind == .head ? "playback-head" : "playback-station"
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
                ?? MKAnnotationView(annotation: annotation, reuseIdentifier: identifier)
            view.annotation = annotation
            let base: CGFloat = annotation.kind == .head ? 16 : 9
            let size = base + CGFloat(annotation.pulse) * 8
            view.frame.size = CGSize(width: size, height: size)
            view.layer.cornerRadius = size / 2
            view.layer.borderWidth = annotation.kind == .head ? 3 : 2
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

        /// Web-mercator zoom for the map view's current span, so the ported
        /// LOD thresholds mean the same thing here as they do in MapLibre.
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
