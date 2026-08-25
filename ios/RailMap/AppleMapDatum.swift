import Foundation
import RailCore

/// Converts source WGS84 geometry into the datum used by Apple's basemap.
///
/// On the China MapKit service used by the app, Taiwan, Hong Kong, Macao and
/// Korea are presented with the GCJ-02 displacement. The rail packages remain
/// WGS84 — they are also consumed by the WebUI — so the shift belongs at the
/// native presentation boundary rather than in the packages or `RailCore`.
///
/// A direct MapKit lookup on 2026-08-25 placed Barra station at
/// 113.534528, 22.180786. Its official DSCC WGS84 anchor is
/// 113.529427, 22.183681; the conversion below yields
/// 113.534572, 22.180783 (about 4.6 m from MapKit instead of about 625 m).
/// Distributed station audits on the same date reduced the median residual
/// from 504 m to 37 m in Taiwan, 596 m to 30 m in Hong Kong, and 615 m to 7 m
/// in Macao. Korea's 1,412 station anchors receive a 420–569 m correction
/// (476 m median) on the affected Apple basemap. Japan remains source WGS84.
nonisolated enum AppleMapDatum {
    private static let gcj02Countries: Set<String> = ["tw", "hk", "mo", "kr"]

    static func display(_ coordinate: Coordinate, country: String) -> Coordinate {
        guard gcj02Countries.contains(country) else { return coordinate }
        return gcj02(fromWGS84: coordinate)
    }

    static func display(_ coordinates: [Coordinate], country: String) -> [Coordinate] {
        guard gcj02Countries.contains(country) else { return coordinates }
        return coordinates.map(gcj02(fromWGS84:))
    }

    /// The public GCJ-02 forward transform used by Chinese digital maps.
    /// Constants and series terms intentionally stay spelled out: replacing
    /// them with a fitted translation would align one station and drift along
    /// the rest of the network.
    private static func gcj02(fromWGS84 coordinate: Coordinate) -> Coordinate {
        let longitude = coordinate.lon
        let latitude = coordinate.lat
        let semiMajorAxis = 6_378_245.0
        let eccentricitySquared = 0.00669342162296594323
        let x = longitude - 105
        let y = latitude - 35

        var latitudeOffset = transformLatitude(x: x, y: y)
        var longitudeOffset = transformLongitude(x: x, y: y)
        let radians = latitude * .pi / 180
        let sine = sin(radians)
        let magic = 1 - eccentricitySquared * sine * sine
        let squareRoot = sqrt(magic)
        latitudeOffset = latitudeOffset * 180
            / ((semiMajorAxis * (1 - eccentricitySquared))
                / (magic * squareRoot) * .pi)
        longitudeOffset = longitudeOffset * 180
            / (semiMajorAxis / squareRoot * cos(radians) * .pi)
        return Coordinate(
            lon: longitude + longitudeOffset,
            lat: latitude + latitudeOffset)
    }

    private static func transformLatitude(x: Double, y: Double) -> Double {
        var result = -100 + 2 * x + 3 * y + 0.2 * y * y
            + 0.1 * x * y + 0.2 * sqrt(abs(x))
        result += (20 * sin(6 * x * .pi) + 20 * sin(2 * x * .pi)) * 2 / 3
        result += (20 * sin(y * .pi) + 40 * sin(y / 3 * .pi)) * 2 / 3
        result += (160 * sin(y / 12 * .pi) + 320 * sin(y * .pi / 30)) * 2 / 3
        return result
    }

    private static func transformLongitude(x: Double, y: Double) -> Double {
        var result = 300 + x + 2 * y + 0.1 * x * x
            + 0.1 * x * y + 0.1 * sqrt(abs(x))
        result += (20 * sin(6 * x * .pi) + 20 * sin(2 * x * .pi)) * 2 / 3
        result += (20 * sin(x * .pi) + 40 * sin(x / 3 * .pi)) * 2 / 3
        result += (150 * sin(x / 12 * .pi) + 300 * sin(x / 30 * .pi)) * 2 / 3
        return result
    }
}
