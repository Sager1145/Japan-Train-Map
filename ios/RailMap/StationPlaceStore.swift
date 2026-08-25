import MapKit
import RailCore
import RailPresentation
import SwiftUI

/// The Apple Maps place behind a station on this map, looked up once.
///
/// `StationPlaceLink` decides WHICH place a station is and what URL names it;
/// this is the half that cannot be unit-tested, because it is a live
/// `MKLocalSearch` against whichever map service the reader's device is served
/// by. Everything it does with the answers goes back through the rule, so the
/// only judgement made here is how many times to ask and what to remember.
///
/// ## Why it is a store rather than a call in the view
///
/// Two reasons, and both are about the same station being asked for again. A
/// reader who taps 東京 on the network, closes the card and taps the same
/// station on a ride's own dot opens two different `StationCard`s for one
/// place, and a search is a network round trip taken while a sheet is already
/// on screen. And a miss is worth remembering as firmly as a hit: on the China
/// map service every Japanese and Korean query returns
/// `MKError.placemarkNotFound`, so without a cache a reader in that service's
/// territory would pay three timeouts for every card they open, forever.
///
/// Main-actor isolated on purpose. `MKMapItem` is not `Sendable`, and the item
/// is the point — `openInMaps()` on the resolved item is what opens the real
/// place card rather than a pin, and it can only be called where the item
/// lives.
@MainActor
final class StationPlaceStore {

    static let shared = StationPlaceStore()

    /// One station, resolved.
    ///
    /// Isolated to the main actor rather than made `Sendable` by hand: it
    /// carries an `MKMapItem`, which is not `Sendable` and must not be, and an
    /// isolated type is `Sendable` precisely because its contents cannot leave.
    /// That is also what lets the in-flight `Task` hand one back.
    @MainActor
    struct Place {
        /// The map item itself, for `openInMaps()`.
        let item: MKMapItem
        /// What Apple Maps calls it. Held for the audit trail rather than for
        /// display: the card keeps its own header, which is the station's name
        /// in the reader's language, not the service's.
        let name: String
        /// The shareable link to this place, or `nil` when the service gave no
        /// identifier — every service does since iOS 18, and nothing does
        /// before it.
        let url: URL?
    }

    /// Answered stations, and the ones that answered with nothing. `Place?` as
    /// the VALUE rather than removing the key: a miss is a cached answer.
    private var resolved: [String: Place?] = [:]
    /// Lookups already running, so two cards for one station make one search.
    private var running: [String: Task<Place?, Never>] = [:]

    /// The place this card is, or `nil` when Apple Maps has no such station.
    ///
    /// `aliases` is every OTHER name the readings table holds for the station —
    /// the caller's, because the readings engine lives above this. They are
    /// what makes a lookup work when the app's language and the device's
    /// disagree: the service answers Taibei Station to an English phone, and
    /// a card whose header says 臺北 has nothing to compare that to.
    func place(for card: StationCard, aliases: [String] = []) async -> Place? {
        let key = card.id
        if let cached = resolved[key] { return cached }
        if let task = running[key] { return await task.value }
        let task = Task { await Self.resolve(card, aliases: aliases) }
        running[key] = task
        let place = await task.value
        running.removeValue(forKey: key)
        resolved[key] = place
        return place
    }

    // MARK: - The lookup

    /// The search plan `StationPlaceLink` names, run until one step answers.
    ///
    /// The third step repeats the first query with the transport filter off.
    /// A live sweep never needed it — every station that resolved at all
    /// resolved on a filtered pass — but the filter is the service's own
    /// categorisation of a place, and a station it has failed to categorise is
    /// exactly the case a filtered search cannot see. It costs one request on
    /// stations that were going to miss anyway.
    private static func resolve(_ card: StationCard, aliases: [String]) async -> Place? {
        let station = StationPlaceLink.Station(
            names: card.searchNames + aliases, country: card.region.code)
        let queries = StationPlaceLink.queries(for: station)
        guard let first = queries.first else { return nil }
        let plan = queries.map { ($0, true) } + [(first, false)]

        for (query, transportOnly) in plan {
            guard
                let items = try? await search(
                    query, near: card.coordinate, transportOnly: transportOnly)
            else { continue }
            let candidates = items.map { item in
                StationPlaceLink.Candidate(
                    name: item.name ?? "",
                    isPublicTransport: item.pointOfInterestCategory == .publicTransport,
                    metres: metres(from: card.coordinate, to: coordinate(of: item)))
            }
            guard let index = StationPlaceLink.best(candidates, for: station) else { continue }
            let item = items[index]
            return Place(item: item, name: item.name ?? "", url: placeURL(of: item))
        }
        return nil
    }

    /// One search, inside a box around the station.
    ///
    /// Three kilometres on a side. The region is a HINT to the service rather
    /// than a filter — results outside it come back too, which is why the rule
    /// measures every candidate itself — but it is what makes 中山 mean the one
    /// under the reader's finger rather than the seven others in the country.
    private static func search(
        _ query: String, near coordinate: Coordinate, transportOnly: Bool
    ) async throws -> [MKMapItem] {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        request.region = MKCoordinateRegion(
            center: coordinate.clLocation,
            latitudinalMeters: 3_000, longitudinalMeters: 3_000)
        // Points of interest only. An address result is a house number on the
        // street outside the station, and it is never the station.
        request.resultTypes = .pointOfInterest
        if transportOnly {
            request.pointOfInterestFilter = MKPointOfInterestFilter(including: [.publicTransport])
        }
        return try await MKLocalSearch(request: request).start().mapItems
    }

    /// `/place?place-id=`, from the identity the service gave the place.
    ///
    /// iOS 18 is where `MKMapItem` started carrying one. Before that there is
    /// no way to name a place in a URL at all — Apple's own share sheet wrote
    /// `auid`, which was never public — so the card falls back to sending the
    /// pin, which is what it sent for every station before this existed.
    private static func placeURL(of item: MKMapItem) -> URL? {
        guard #available(iOS 18.0, *), let identifier = item.identifier else { return nil }
        return StationPlaceLink.placeURL(placeID: identifier.rawValue)
    }

    // MARK: - Geometry

    /// Where the service put the place.
    ///
    /// Both sides of the comparison are already in the basemap's own datum:
    /// `AppleMapDatum` shifted the package's coordinate into it before the
    /// station was ever drawn, and a result from MapKit is by definition in it.
    /// Measuring a GCJ-02 result against a WGS84 platform would put every
    /// Taiwanese, Hong Kong, Macanese and Korean station 500 m from itself and
    /// outside `StationPlaceLink.maxMetres`.
    private static func coordinate(of item: MKMapItem) -> CLLocationCoordinate2D {
        if #available(iOS 26.0, *) { return item.location.coordinate }
        return legacyCoordinate(of: item)
    }

    /// `MKMapItem.placemark` is deprecated from iOS 26 and is the only way to
    /// read a position before it. Isolated here, and marked, so that supporting
    /// iOS 17 costs one warning-free function rather than a warning at the call
    /// site.
    @available(iOS, deprecated: 26.0)
    private static func legacyCoordinate(of item: MKMapItem) -> CLLocationCoordinate2D {
        item.placemark.coordinate
    }

    private static func metres(from: Coordinate, to: CLLocationCoordinate2D) -> Double {
        CLLocation(latitude: from.lat, longitude: from.lon)
            .distance(from: CLLocation(latitude: to.latitude, longitude: to.longitude))
    }
}
