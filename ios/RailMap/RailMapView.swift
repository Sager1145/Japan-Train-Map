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
    /// Whether the network is drawn. Kept separate from `lines` on purpose:
    /// hiding the network used to be expressed by passing an empty list, which
    /// made showing it again indistinguishable from loading a country, so the
    /// map re-framed itself and threw away wherever the reader had panned to.
    var showsNetwork: Bool
    /// The wire to the control bar, which lives elsewhere in the layout — at
    /// the bottom of the screen on iPhone, at the foot of the sidebar on iPad.
    var controller: RailMapController
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
        context.coordinator.controller = controller
        controller.mapView = mapView

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
        context.coordinator.update(lines: lines, showsNetwork: showsNetwork, on: mapView)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, MKMapViewDelegate {
        weak var mapView: MKMapView?
        var controller: RailMapController?
        var onRender: (RenderStats) -> Void = { _ in }

        private var lines: [RailNetworkStore.DrawnLine] = []
        private var minZoomByLineId: [String: Int] = [:]
        private var showsNetwork = true
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

        func update(
            lines: [RailNetworkStore.DrawnLine], showsNetwork: Bool, on mapView: MKMapView
        ) {
            let linesChanged = lines.map(\.id) != self.lines.map(\.id)
            let visibilityChanged = showsNetwork != self.showsNetwork
            guard linesChanged || visibilityChanged else { return }

            self.showsNetwork = showsNetwork

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
            // Switched off from the control bar: clear the map and leave the
            // camera exactly where the reader put it.
            guard showsNetwork else {
                mapView.removeOverlays(mapView.overlays)
                builtForZoom = nil
                return
            }

            // Before the first layout pass the view has no width, and the
            // zoom derived from it is nonsense — it was reading z = -8 and
            // culling every line. Wait for a real size.
            guard mapView.bounds.width > 1, !lines.isEmpty else { return }

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
            let selection = NetworkLOD.select(from: lines, zoom: zoom, buildRect: buildRect)

            // Decimation, unlike the visibility rule, IS ours. MapLibre gets
            // it free from geojson-vt; MapKit has no equivalent, so the same
            // idea is applied here — drop vertices that cannot move the drawn
            // line by as much as half a pixel at this zoom. Bounded that way
            // it cannot change what a reader sees, only what the GPU is asked
            // to do to show it.
            let epsilon = Self.metresPerPixel(zoom: zoom, latitude: mapView.region.center.latitude) * 0.5

            let builds: [LineBuild] = selection.lines.map { line in
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
            var overlays: [MKMultiPolyline] = []
            for (key, polylines) in byColor {
                let multi = MKMultiPolyline(polylines)
                multi.title = key  // the renderer reads the colour back off this
                overlays.append(multi)
            }
            overlayColors = colors
            mapView.addOverlays(overlays, level: .aboveRoads)

            let elapsed = ContinuousClock.now - started
            NSLog(
                "railmap: z=%.2f thr=%.1f lines=%d/%d (culled %d) overlays=%d vertices=%d %dms",
                zoom, fitted.threshold, visible.count, lines.count,
                selection.culledOffScreen, overlays.count, vertices, elapsed.milliseconds)
            // Deferred: a rebuild can be triggered from inside updateUIView,
            // and writing SwiftUI state during a view update is undefined
            // behaviour — in practice the panel simply never showed the
            // numbers. Hand them back on the next turn of the loop instead.
            let stats = RenderStats(
                zoom: zoom,
                visibleLines: visible.count,
                overlays: overlays.count,
                vertices: vertices,
                buildMilliseconds: elapsed.milliseconds,
                culledOffScreen: selection.culledOffScreen,
                threshold: fitted.threshold
            )
            DispatchQueue.main.async { [onRender] in onRender(stats) }
        }

        private var overlayColors: [String: UIColor] = [:]

        // MARK: - rendering

        func mapView(_ mapView: MKMapView, rendererFor overlay: any MKOverlay) -> MKOverlayRenderer {
            guard let multi = overlay as? MKMultiPolyline else {
                return MKOverlayRenderer(overlay: overlay)
            }
            let renderer = MKMultiPolylineRenderer(multiPolyline: multi)
            renderer.strokeColor = overlayColors[multi.title ?? ""] ?? .systemBlue
            // The web app pins the rail stroke to a fixed fraction of the
            // station dot so the dots read as beads on a wire, and since the
            // 2026-08-20 retune that stroke is 1.5 px at every zoom
            // (railmap-style.js §tokens). MapKit line widths are already in
            // points and are not scaled by zoom, so the token transfers
            // directly rather than needing a ramp.
            renderer.lineWidth = 1.5
            renderer.lineCap = .round
            renderer.lineJoin = .round
            return renderer
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
    }
}
