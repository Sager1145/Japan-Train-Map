import Foundation
import MapKit
import RailCore
import SwiftUI

/// Loads a country's rail package out of the app bundle and turns it into
/// something the map can draw.
///
/// The decoding and the interval geometry both come from `RailCore`, which is
/// the point: this type contains no geometry of its own, so there is nothing
/// here that could disagree with the web app without a fixture catching it.
@MainActor
@Observable
final class RailNetworkStore {

    struct DrawnLine: Identifiable, Sendable {
        let id: String
        let name: String
        let nameRoma: String?
        let color: Color
        /// The operator's dark-mode colour where it publishes one. The
        /// packages have always carried this — `rail-network.js` reads
        /// `colorDark || color` — and the web app switches palettes with the
        /// theme. Ignoring it would have made dark mode a different map, not
        /// a darker one.
        let colorDark: Color
        /// Kept alongside the resolved `Color`s because the renderer batches
        /// lines by colour, and a hex string is a cheap, stable bucket key
        /// where `Color` is neither.
        let colorHex: String
        let colorDarkHex: String
        let rank: Int
        /// The zoom below which this line is not drawn — the web app's own
        /// rule, ported in `RailCore.Visibility`, not a performance knob.
        let minZoom: Int
        /// The threshold this app actually uses: the ported rule plus the rank
        /// term. See `NetworkLOD` — it is deliberately stricter than the web
        /// app at low zoom, and deliberately not in `RailCore`.
        let lodMinZoom: Double
        /// Bounding box in projected map space, computed once at decode time
        /// so the per-rebuild off-screen test is a rectangle intersection
        /// rather than a walk over 394,285 coordinates.
        let mapRect: MKMapRect
        /// One polyline per station-to-station interval, exactly as the web
        /// app draws them.
        let intervals: [[Coordinate]]
        var vertexCount: Int { intervals.reduce(0) { $0 + $1.count } }
    }

    struct DrawnStation: Identifiable, Sendable {
        let id: String
        /// The package's own station-group code — the identity a ride's stop
        /// carries (`n02_station_code`), which is why the ride editor picks
        /// stations by it rather than by name.
        let stationCode: String
        let name: String
        let nameRoma: String
        let coordinate: Coordinate
        let colorHex: String
        let minZoom: Int
        let isTerminal: Bool
        let showsLabel: Bool
        let popup: StationDisplay.PopupModel
    }

    enum LoadState {
        case idle
        case loading
        case loaded(country: String, lines: [DrawnLine], elapsed: Duration)
        case failed(String)
    }

    private(set) var state: LoadState = .idle
    private(set) var stations: [DrawnStation] = []

    /// The five countries the packages cover, smallest first — which is also
    /// least to most demanding on the renderer, so the ordering doubles as the
    /// order to try things in when measuring.
    static let countries: [(code: String, label: String)] = [
        ("mo", "澳門 Macao"),
        ("hk", "香港 Hong Kong"),
        ("tw", "臺灣 Taiwan"),
        ("kr", "한국 Korea"),
        ("jp", "日本 Japan"),
    ]

    func load(country: String) {
        state = .loading
        stations = []
        Task {
            do {
                let decoded = try await Self.decode(country: country)
                stations = decoded.stations
                state = .loaded(
                    country: country, lines: decoded.lines, elapsed: decoded.elapsed)
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }

    /// Decoding a national package is tens of thousands of coordinates, so it
    /// is `nonisolated` — it runs off the main actor and the main actor only
    /// sees the finished value. Marked `async` rather than dispatched by hand
    /// because that is what lets the compiler check the hand-off instead of
    /// trusting it.
    private nonisolated static func decode(
        country: String
    ) async throws -> (lines: [DrawnLine], stations: [DrawnStation], elapsed: Duration) {
        let started = ContinuousClock.now
        guard let url = Bundle.main.url(forResource: "\(country)-2025", withExtension: "json")
        else { throw LoadError.missingResource(country) }

        let package = try CompactPackage.load(contentsOf: url)
        let topologies = try DisplayParts.LineTopology.byLineID(contentsOf: url)
        let minZoomByLineId = Visibility.minZoomByLineId(package)
        let lines = package.lines.map { line in
            let intervals = DisplayParts.parts(
                for: line, topology: topologies[line.id] ?? .init())
            // The line's own length is deliberately NOT used for the LOD:
            // `minZoomByLineId` answers with the length of the line's
            // visibility GROUP, so every administrative piece of one physical
            // railway appears and vanishes together.
            let portedMinZoom = minZoomByLineId[line.id] ?? 0
            return DrawnLine(
                id: line.id,
                name: line.name,
                nameRoma: line.nameRoma,
                color: Color(hex: line.color) ?? .accentColor,
                colorDark: Color(hex: line.colorDark ?? line.color) ?? .accentColor,
                colorHex: (line.color ?? "#7a7a7a").lowercased(),
                colorDarkHex: (line.colorDark ?? line.color ?? "#7a7a7a").lowercased(),
                rank: line.rank,
                minZoom: portedMinZoom,
                lodMinZoom: NetworkLOD.minZoom(
                    portedMinZoom: portedMinZoom, rank: line.rank),
                mapRect: Self.boundingRect(of: intervals),
                intervals: intervals
            )
        }
        let stationNetwork = StationDisplay.Network(package: package)
        let labelWinners = Set(StationDisplay.stationLabelWinners(stationNetwork))
        let stations = stationNetwork.stations.enumerated().map { index, station in
            let line = stationNetwork.lines[station.lineIndex]
            return DrawnStation(
                id: station.stationID, stationCode: station.stationGroupID,
                name: station.name,
                nameRoma: station.nameRoma ?? "", coordinate: station.coordinate,
                colorHex: line.color, minZoom: station.minZoom,
                isTerminal: station.isTerminal, showsLabel: labelWinners.contains(index),
                popup: StationDisplay.buildPopupModel(
                    network: stationNetwork, stationID: station.stationID))
        }
        return (lines, stations, ContinuousClock.now - started)
    }

    /// Union of every vertex, in projected map space.
    ///
    /// `MKMapRect` rather than a latitude/longitude box because the off-screen
    /// test compares against `MKMapView.visibleMapRect`, and converting one
    /// rect per line per rebuild would undo the point of precomputing it.
    private nonisolated static func boundingRect(of intervals: [[Coordinate]]) -> MKMapRect {
        var rect = MKMapRect.null
        for interval in intervals {
            for point in interval {
                let mapPoint = MKMapPoint(
                    CLLocationCoordinate2D(latitude: point.lat, longitude: point.lon))
                rect = rect.union(MKMapRect(origin: mapPoint, size: MKMapSize(width: 0, height: 0)))
            }
        }
        return rect
    }

    enum LoadError: LocalizedError {
        case missingResource(String)

        var errorDescription: String? {
            switch self {
            case .missingResource(let country):
                return """
                    \(country)-2025.json is not in the app bundle. \
                    Run ios/copy-rail-packages.sh — the packages are copied from \
                    app/public/rail rather than committed twice.
                    """
            }
        }
    }
}

extension Color {
    /// Reads the `#rrggbb` strings the rail packages store.
    ///
    /// The packages also carry `colorDark` for operators that publish a
    /// separate dark-mode colour; wiring that to the colour scheme is a
    /// follow-up, and doing it here rather than in `RailCore` is deliberate —
    /// which colour a theme picks is presentation, and presentation does not
    /// go in the pure tier.
    init?(hex: String?) {
        guard var text = hex?.trimmingCharacters(in: .whitespaces) else { return nil }
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
