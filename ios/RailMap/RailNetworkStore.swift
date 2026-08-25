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
        /// Which package this line came out of. Nothing about *drawing* needs
        /// it — every line draws in its own colour on its own geometry — but
        /// the statistics screen and the ride editor both scope by region, and
        /// re-deriving it from the id at every call site would be a rule
        /// spelled out in several places instead of one.
        let region: Region
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
        /// Complete visibility-group length, not this administrative piece's
        /// own length. The native low-zoom policy uses the unbucketed value so
        /// very long trunks can survive wider views than merely long lines.
        let visibilityLengthKm: Double
        /// The threshold this app actually uses: the ported rule plus the rank
        /// and finer wide-view length terms. See `NetworkLOD` — it is
        /// deliberately stricter than the web app at low zoom, and
        /// deliberately not in `RailCore`.
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
        /// The package this station came out of — the ride editor's picker is
        /// scoped to the region of the itinerary being edited, so that a
        /// Japanese ride cannot pick up a Korean platform.
        let region: Region
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

    /// What one region's package cost and contributed, so the diagnostics
    /// panel reports measurements rather than an estimate.
    struct RegionLoad: Identifiable, Sendable {
        var region: Region
        var lineCount: Int
        var stationCount: Int
        var elapsed: Duration
        var id: String { region.rawValue }
    }

    enum LoadState {
        case idle
        /// Regions still being decoded. The map draws what has already
        /// arrived: the packages differ by three orders of magnitude in size,
        /// so waiting for Japan before showing Macao would hide four networks
        /// behind the slowest one.
        case loading(pending: [Region])
        case loaded(regions: [RegionLoad], failures: [RegionFailure], elapsed: Duration)
    }

    struct RegionFailure: Identifiable, Sendable {
        var region: Region
        var message: String
        var id: String { region.rawValue }
    }

    private(set) var state: LoadState = .idle
    private(set) var lines: [DrawnLine] = []
    private(set) var stations: [DrawnStation] = []

    /// Every region drawn at once.
    ///
    /// The web app loads one package because it has a region switch; this app
    /// has none, so all five are decoded together and merged into one field of
    /// lines and one of stations. Nothing downstream needs to know a region
    /// boundary exists — `NetworkLOD` culls by zoom and by the visible rect,
    /// which is a rule about what is on screen rather than about which country
    /// it is in.
    ///
    /// Decoding runs concurrently and publishes each region as it lands, in
    /// completion order: Macao's 8 KB is on screen long before Japan's 9.5 MB
    /// has finished.
    func loadAll() {
        if case .loading = state { return }
        state = .loading(pending: Region.ordered)
        lines = []
        stations = []
        Task {
            let started = ContinuousClock.now
            var loads: [RegionLoad] = []
            var failures: [RegionFailure] = []
            var pending = Region.ordered

            await withTaskGroup(of: (Region, Result<Decoded, Error>).self) { group in
                for region in Region.ordered {
                    group.addTask {
                        do { return (region, .success(try await Self.decode(region: region))) }
                        catch { return (region, .failure(error)) }
                    }
                }
                for await (region, result) in group {
                    pending.removeAll { $0 == region }
                    switch result {
                    case .success(let decoded):
                        lines.append(contentsOf: decoded.lines)
                        stations.append(contentsOf: decoded.stations)
                        loads.append(
                            RegionLoad(
                                region: region, lineCount: decoded.lines.count,
                                stationCount: decoded.stations.count,
                                elapsed: decoded.elapsed))
                    case .failure(let error):
                        // One missing package is not a dead map: the other four
                        // still draw, and the data screen names the one that
                        // did not. A region-switching app could treat this as
                        // fatal; an all-regions one cannot.
                        failures.append(
                            RegionFailure(
                                region: region, message: error.localizedDescription))
                    }
                    if !pending.isEmpty { state = .loading(pending: pending) }
                }
            }
            loads.sort { Region.ordered.firstIndex(of: $0.region) ?? 0
                < Region.ordered.firstIndex(of: $1.region) ?? 0 }
            state = .loaded(
                regions: loads, failures: failures, elapsed: ContinuousClock.now - started)
        }
    }

    /// The stations of one region only — the ride editor's picker, which is
    /// scoped to the region the itinerary being edited belongs to.
    func stations(in region: Region) -> [DrawnStation] {
        stations.filter { $0.region == region }
    }

    private struct Decoded: Sendable {
        var lines: [DrawnLine]
        var stations: [DrawnStation]
        var elapsed: Duration
    }

    /// Decoding a national package is tens of thousands of coordinates, so it
    /// is `nonisolated` — it runs off the main actor and the main actor only
    /// sees the finished value. Marked `async` rather than dispatched by hand
    /// because that is what lets the compiler check the hand-off instead of
    /// trusting it.
    private nonisolated static func decode(region: Region) async throws -> Decoded {
        let started = ContinuousClock.now
        guard let url = Bundle.main.url(
            forResource: region.packageResource, withExtension: "json")
        else { throw LoadError.missingResource(region.code) }

        let package = try CompactPackage.load(contentsOf: url)
        let topologies = try DisplayParts.LineTopology.byLineID(contentsOf: url)
        let visibilityLengthByLineId = Visibility.groupLengthByLineId(package)
        let minZoomByLineId = visibilityLengthByLineId.mapValues {
            Visibility.minZoomForLength(totalKm: $0)
        }
        let lines = package.lines.map { line in
            let sourceIntervals = DisplayParts.parts(
                for: line, topology: topologies[line.id] ?? .init())
            // `DisplayParts` stays byte-for-byte WGS84-compatible with the
            // WebUI. Only the coordinates handed to MapKit are shifted for
            // regions served by Apple's GCJ-02 basemap.
            let intervals = sourceIntervals.map {
                AppleMapDatum.display($0, country: region.code)
            }
            // The line's own length is deliberately NOT used for the LOD:
            // `minZoomByLineId` answers with the length of the line's
            // visibility GROUP, so every administrative piece of one physical
            // railway appears and vanishes together.
            let portedMinZoom = minZoomByLineId[line.id] ?? 0
            let visibilityLengthKm = visibilityLengthByLineId[line.id] ?? 0
            return DrawnLine(
                id: line.id,
                region: region,
                name: line.name,
                nameRoma: line.nameRoma,
                color: Color(hex: line.color) ?? .accentColor,
                colorDark: Color(hex: line.colorDark ?? line.color) ?? .accentColor,
                colorHex: (line.color ?? "#7a7a7a").lowercased(),
                colorDarkHex: (line.colorDark ?? line.color ?? "#7a7a7a").lowercased(),
                rank: line.rank,
                minZoom: portedMinZoom,
                visibilityLengthKm: visibilityLengthKm,
                lodMinZoom: NetworkLOD.minZoom(
                    portedMinZoom: portedMinZoom,
                    rank: line.rank,
                    visibilityLengthKm: visibilityLengthKm),
                mapRect: Self.boundingRect(of: intervals),
                intervals: intervals
            )
        }
        let stationNetwork = StationDisplay.Network(package: package)
        let labelWinners = Set(StationDisplay.stationLabelWinners(stationNetwork))
        let stations = stationNetwork.stations.enumerated().map { index, station in
            let line = stationNetwork.lines[station.lineIndex]
            return DrawnStation(
                id: station.stationID, region: region,
                stationCode: station.stationGroupID,
                name: station.name,
                nameRoma: station.nameRoma ?? "",
                coordinate: AppleMapDatum.display(station.coordinate, country: region.code),
                colorHex: line.color, minZoom: station.minZoom,
                isTerminal: station.isTerminal, showsLabel: labelWinners.contains(index),
                popup: StationDisplay.buildPopupModel(
                    network: stationNetwork, stationID: station.stationID))
        }
        return Decoded(lines: lines, stations: stations, elapsed: ContinuousClock.now - started)
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
