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
struct RailMapView: UIViewRepresentable {
    var lines: [RailNetworkStore.DrawnLine]
    /// Reports back what the renderer actually did, so the numbers on screen
    /// are measurements rather than estimates.
    var onRender: (RenderStats) -> Void

    struct RenderStats: Equatable {
        var zoom: Double
        var visibleLines: Int
        var overlays: Int
        var vertices: Int
        var buildMilliseconds: Int
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
        return mapView
    }

    func updateUIView(_ mapView: MKMapView, context: Context) {
        context.coordinator.onRender = onRender
        context.coordinator.update(lines: lines, on: mapView)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, MKMapViewDelegate {
        weak var mapView: MKMapView?
        var onRender: (RenderStats) -> Void = { _ in }

        private var lines: [RailNetworkStore.DrawnLine] = []
        private var minZoomByLineId: [String: Int] = [:]
        /// The zoom bucket the current overlays were built for. Rebuilding on
        /// every region change would put a full decimation pass inside the
        /// pan gesture; rebuilding when the integer zoom changes puts it at
        /// the handful of moments where what is drawn actually changes.
        private var builtForZoom: Int?

        func update(lines: [RailNetworkStore.DrawnLine], on mapView: MKMapView) {
            guard lines.map(\.id) != self.lines.map(\.id) else { return }
            // A country switch passes through an empty list while the next
            // package decodes. Clearing the map for that moment is right, but
            // reporting it is not: the panel would show "0 lines" as the last
            // measurement of a map that is about to be full.
            guard !lines.isEmpty else {
                self.lines = []
                mapView.removeOverlays(mapView.overlays)
                builtForZoom = nil
                return
            }
            self.lines = lines
            self.minZoomByLineId = Dictionary(
                uniqueKeysWithValues: lines.map { ($0.id, $0.minZoom) })
            builtForZoom = nil
            rebuild(on: mapView)
            if let region = Self.region(covering: lines) {
                mapView.setRegion(region, animated: false)
            }
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            rebuild(on: mapView)
        }

        // MARK: - building

        private func rebuild(on mapView: MKMapView) {
            // Before the first layout pass the view has no width, and the
            // zoom derived from it is nonsense — it was reading z = -8 and
            // culling every line. Wait for a real size.
            guard mapView.bounds.width > 1, !lines.isEmpty else { return }

            let zoom = Self.zoomLevel(of: mapView)
            let bucket = Int(zoom.rounded())
            guard bucket != builtForZoom else { return }
            builtForZoom = bucket

            let started = ContinuousClock.now

            // Level of detail is the web app's own rule (RailCore.Visibility),
            // not an iOS invention: a line whose group is short drops out of
            // the wide views. Reproducing it is what keeps the two apps
            // showing the same railway at the same zoom.
            let visible = lines.filter { (minZoomByLineId[$0.id] ?? 0) <= bucket }

            // Decimation, unlike the LOD rule, IS ours. MapLibre runs every
            // source through geojson-vt with a pixel tolerance; MapKit has no
            // equivalent, so the same idea is applied here — drop vertices
            // that cannot move the drawn line by as much as half a pixel at
            // this zoom. Bounded that way it cannot change what a reader sees,
            // only how much work the GPU is asked to do to show it.
            let epsilon = Self.metresPerPixel(zoom: zoom, latitude: mapView.region.center.latitude) * 0.5

            var byColor: [String: [MKPolyline]] = [:]
            var colors: [String: UIColor] = [:]
            var vertices = 0

            for line in visible {
                let key = line.colorHex
                colors[key] = UIColor(line.color)
                for interval in line.intervals {
                    guard interval.count >= 2 else { continue }
                    let kept = Geometry.douglasPeuckerIndices(
                        interval, epsilonMeters: epsilon)
                    let points = kept.map { interval[$0].clLocation }
                    guard points.count >= 2 else { continue }
                    vertices += points.count
                    byColor[key, default: []].append(
                        MKPolyline(coordinates: points, count: points.count))
                }
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
                "railmap: z=%.2f bucket=%d lines=%d/%d overlays=%d vertices=%d %dms",
                zoom, bucket, visible.count, lines.count, overlays.count, vertices,
                elapsed.milliseconds)
            // Deferred: a rebuild can be triggered from inside updateUIView,
            // and writing SwiftUI state during a view update is undefined
            // behaviour — in practice the panel simply never showed the
            // numbers. Hand them back on the next turn of the loop instead.
            let stats = RenderStats(
                zoom: zoom,
                visibleLines: visible.count,
                overlays: overlays.count,
                vertices: vertices,
                buildMilliseconds: elapsed.milliseconds
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
