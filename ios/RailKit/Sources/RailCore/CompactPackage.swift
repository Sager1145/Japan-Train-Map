import Foundation

/// The `compact-v1` rail package — the cross-language data contract.
///
/// `app/public/rail/*-2025.json` is read unchanged by both implementations
/// (REFACTOR_FOR_SWIFT_FORK_PROMPT.md §三 contract 7), so this decoder is
/// written against the shipped files rather than against a Swift-shaped
/// re-export of them. Renaming a field here is not a refactor; it is a
/// breaking change to a format the web app, the Node build scripts and this
/// app all depend on.
///
/// The rows are positional arrays rather than objects because the format is
/// built for size — a national package is 17 MB even so.
public struct CompactPackage: Sendable {
    public let format: String
    public let version: String
    public let country: String
    public let lines: [Line]

    public struct Line: Sendable {
        public let id: String
        public let name: String
        public let nameRoma: String?
        public let `operator`: String?
        /// Drives the zoom at which the line first appears; lower is more
        /// important. The web app's `minZoomForRank` consumes it.
        public let rank: Int
        /// Official line colour, light theme. `colorDark` is the dark-theme
        /// substitute where an operator publishes one.
        public let color: String?
        public let colorDark: String?
        public let stations: [Station]
        public let segments: [Segment]
    }

    /// `[id, name, lon, lat, nameRoma, group]`.
    public struct Station: Sendable {
        public let id: String
        public let name: String
        public let coordinate: Coordinate
        public let nameRoma: String?
    }

    /// `[distanceKm, continuesFromPrevious, coordinates]`.
    ///
    /// `continuesFromPrevious` is the seam flag: when set, the interval's
    /// drawn geometry begins at the *previous* interval's last coordinate,
    /// which is how a chain of intervals is stored without repeating the
    /// shared vertex in every row.
    public struct Segment: Sendable {
        public let distanceKm: Double
        public let continuesFromPrevious: Bool
        public let coordinates: [Coordinate]
    }
}

extension CompactPackage: Decodable {
    enum CodingKeys: String, CodingKey {
        case format, version, country, lines
    }
}

extension CompactPackage.Line: Decodable {
    enum CodingKeys: String, CodingKey {
        case id, name, nameRoma, `operator`, rank, color, colorDark, stations, segments
    }
}

extension CompactPackage.Station: Decodable {
    public init(from decoder: Decoder) throws {
        var row = try decoder.unkeyedContainer()
        id = try row.decode(String.self)
        name = try row.decode(String.self)
        let lon = try row.decode(Double.self)
        let lat = try row.decode(Double.self)
        coordinate = Coordinate(lon: lon, lat: lat)
        // Trailing members are optional across packages and countries: Macao
        // carries a romanisation and a group index, some rows carry neither.
        nameRoma = row.isAtEnd ? nil : try? row.decode(String.self)
    }
}

extension CompactPackage.Segment: Decodable {
    public init(from decoder: Decoder) throws {
        var row = try decoder.unkeyedContainer()
        distanceKm = try row.decode(Double.self)
        // Stored as 0/1. Decoded through Int rather than Bool because JSON
        // `0` is not a JSON boolean and a strict decoder will refuse it.
        continuesFromPrevious = (try row.decode(Int.self)) != 0
        coordinates = (try row.decode([[Double]].self)).compactMap(Coordinate.init(pair:))
    }
}

extension CompactPackage {

    /// Decodes one line's station-to-station intervals — the geometry the map
    /// actually draws, one polyline per interval.
    ///
    /// Ported from `rail-network.js` `decodeIntervals`, and there are three
    /// rules in those nineteen lines that a plausible-looking port gets wrong:
    ///
    ///   1. **The seam.** A row flagged `continuesFromPrevious` is prefixed
    ///      with the previous interval's last coordinate. Without it every
    ///      interval boundary is a visible gap.
    ///   2. **The station table wins.** Both endpoints are then *overwritten*
    ///      by the authoritative station anchors. Survey geometry frequently
    ///      stops a few metres short of the platform it serves, and the app's
    ///      rule is that the line passes through the station dot, never near
    ///      it — so geometry loses to the station table, not the reverse.
    ///   3. **Loops close.** The end station index wraps modulo the station
    ///      count, so a circular line's last interval returns to station 0
    ///      rather than running off the end of the table.
    public static func decodeIntervals(_ line: Line) -> [[Coordinate]] {
        let stationCount = line.stations.count
        guard stationCount > 0 else { return [] }

        var intervals: [[Coordinate]] = []
        var previousLast: Coordinate?

        for (index, row) in line.segments.enumerated() {
            var decoded: [Coordinate] = []
            if row.continuesFromPrevious {
                // Matches the JavaScript exactly, including its first-row
                // behaviour: `[previousLastCoordinate].concat(...)` on row 0
                // prepends `null`, which the endpoint overwrite immediately
                // replaces. Reproduced by prepending a placeholder so the
                // resulting vertex COUNT is the same — a port that skips the
                // prepend produces a polyline one vertex shorter.
                decoded.append(previousLast ?? row.coordinates.first ?? Coordinate(lon: 0, lat: 0))
                decoded.append(contentsOf: row.coordinates)
            } else {
                decoded = row.coordinates
            }
            guard !decoded.isEmpty else {
                intervals.append([])
                continue
            }

            let start = line.stations[index % stationCount]
            let end = line.stations[(index + 1) % stationCount]
            decoded[0] = start.coordinate
            decoded[decoded.count - 1] = end.coordinate

            previousLast = decoded[decoded.count - 1]
            intervals.append(decoded)
        }

        return intervals
    }

    public static func load(contentsOf url: URL) throws -> CompactPackage {
        try JSONDecoder().decode(CompactPackage.self, from: Data(contentsOf: url))
    }
}
