import CoreLocation
import MapKit
import Observation
import SwiftUI

/// The commands the control bar can give the map, and the state it reads back.
///
/// The bar and the map are in different halves of the layout — on iPad the bar
/// lives at the foot of the sidebar while the map fills the detail pane — so
/// they cannot talk by being nested. This object is the wire between them.
///
/// It is also where the difference between the two "locate" buttons is kept
/// honest. The web app's 定位 button fits the *selection*: it frames the
/// railway being looked at. It has never had anything to do with where the
/// reader is standing, which is why this adds a second, separate button for
/// that. Collapsing the two would silently change what 定位 means.
@MainActor
@Observable
final class RailMapController {

    // MARK: - state the bar renders from

    /// Map bearing in degrees. The compass needle points at true north, so it
    /// is drawn rotated by the negation of this.
    private(set) var headingDegrees: Double = 0

    /// Whether the map is currently following the device.
    private(set) var isFollowingUser = false

    /// Whether the rail network is drawn. The web app makes the network an
    /// opt-in layer rather than a permanent fixture, and the train button is
    /// that switch.
    var showsNetwork = true

    private(set) var locationAuthorization: CLAuthorizationStatus = .notDetermined

    /// Set when the reader asks to be located but the system has refused.
    /// Surfaced rather than swallowed: a button that appears to do nothing is
    /// worse than one that explains itself.
    private(set) var locationRefusal: String?

    // MARK: - the map registers itself here

    /// Set by ``RailMapView.Coordinator`` once its `MKMapView` exists.
    ///
    /// Deliberately paired with an observable flag: the control stack contains
    /// an `MKCompassButton`, which cannot be constructed without a map view, so
    /// the interface has to *know* when one arrives rather than reading a
    /// non-observable reference and never being told.
    @ObservationIgnored weak var mapView: MKMapView? {
        didSet { isMapReady = mapView != nil }
    }

    private(set) var isMapReady = false

    // MARK: - commands

    /// One zoom step. MapKit has no notion of a zoom level, so a step is a
    /// halving or doubling of the visible span — which is exactly what a web
    /// map's ± buttons do, and keeps the two apps' buttons comparable.
    func zoomIn() { scaleSpan(by: 0.5) }
    func zoomOut() { scaleSpan(by: 2) }

    private func scaleSpan(by factor: Double) {
        guard let mapView else { return }
        let region = mapView.region
        // Clamped to MapKit's own limits: a span of zero is not a valid region
        // and 180° is the whole world. Without the clamp, repeated taps at the
        // extremes hand MKMapView an invalid region and it snaps somewhere
        // unrelated.
        let span = MKCoordinateSpan(
            latitudeDelta: min(max(region.span.latitudeDelta * factor, 0.0005), 170),
            longitudeDelta: min(max(region.span.longitudeDelta * factor, 0.0005), 170)
        )
        mapView.setRegion(MKCoordinateRegion(center: region.center, span: span), animated: true)
    }

    /// Turn the map back to north, keeping the centre and zoom.
    func resetNorth() {
        guard let mapView else { return }
        let camera = mapView.camera.copy() as! MKMapCamera
        camera.heading = 0
        mapView.setCamera(camera, animated: true)
    }

    /// Frame the drawn railway — the native reading of the web app's 定位.
    func fitToNetwork() {
        guard let mapView, let region = fitRegion else { return }
        stopFollowingUser()
        mapView.setRegion(region, animated: true)
    }

    /// Supplied by the map each time it rebuilds, so the button frames what is
    /// actually drawn rather than a remembered extent.
    @ObservationIgnored var fitRegion: MKCoordinateRegion?

    // MARK: - the device's own position

    func toggleFollowUser() {
        if isFollowingUser {
            stopFollowingUser()
        } else {
            startFollowingUser()
        }
    }

    func startFollowingUser() {
        locationRefusal = nil
        switch locationAuthorization {
        case .notDetermined:
            // The prompt is the answer to the tap; following begins in the
            // authorization callback rather than here, because asking and
            // acting in the same breath shows the reader an empty map.
            pendingFollow = true
            locationManager.requestWhenInUseAuthorization()
        case .restricted, .denied:
            locationRefusal = String(
                localized: "Location access is off for this app. Settings › Privacy › Location Services."
            )
        default:
            beginFollowing()
        }
    }

    func stopFollowingUser() {
        guard let mapView else { return }
        mapView.setUserTrackingMode(.none, animated: true)
        isFollowingUser = false
    }

    private func beginFollowing() {
        guard let mapView else { return }
        mapView.showsUserLocation = true
        mapView.setUserTrackingMode(.follow, animated: true)
        isFollowingUser = true
    }

    // MARK: - feedback from the map

    func mapDidChange(heading: Double, trackingMode: MKUserTrackingMode) {
        headingDegrees = heading
        isFollowingUser = trackingMode != .none
    }

    // MARK: - CoreLocation

    @ObservationIgnored private var pendingFollow = false
    // @ObservationIgnored because @Observable rewrites stored properties into
    // computed ones and `lazy` cannot survive that. Neither of these is state
    // the interface reads, so there is nothing to observe here anyway.
    @ObservationIgnored private lazy var locationManager: CLLocationManager = {
        let manager = CLLocationManager()
        manager.delegate = locationDelegate
        return manager
    }()
    @ObservationIgnored private lazy var locationDelegate = LocationDelegate(controller: self)

    fileprivate func authorizationChanged(_ status: CLAuthorizationStatus) {
        locationAuthorization = status
        guard pendingFollow else { return }
        pendingFollow = false
        switch status {
        case .authorizedWhenInUse, .authorizedAlways:
            beginFollowing()
        case .denied, .restricted:
            locationRefusal = String(localized: "Location access was declined.")
        default:
            break
        }
    }

    /// A separate object because `CLLocationManagerDelegate` conformance would
    /// otherwise drag `@Observable`'s stored properties into an
    /// `NSObject` subclass, and the two do not mix well.
    private final class LocationDelegate: NSObject, CLLocationManagerDelegate {
        weak var controller: RailMapController?

        init(controller: RailMapController) {
            self.controller = controller
        }

        func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
            let status = manager.authorizationStatus
            Task { @MainActor [weak controller] in
                controller?.authorizationChanged(status)
            }
        }
    }
}
