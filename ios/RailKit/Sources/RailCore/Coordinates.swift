import Foundation

/// A WGS84 position in the order the rail packages store it: longitude first.
///
/// The web app passes coordinates as two-element arrays, and every file it
/// writes keeps that order. Naming the members here rather than porting the
/// array is the one liberty this type takes, because `coord[1]` reading as
/// latitude is the single most reliable way to introduce a silent transposition
/// — and a transposed rail network still draws, just in the wrong ocean.
public struct Coordinate: Sendable, Hashable {
    public var lon: Double
    public var lat: Double

    public init(lon: Double, lat: Double) {
        self.lon = lon
        self.lat = lat
    }

    /// Reads the `[lon, lat]` pair the compact packages and fixtures store.
    public init?(pair: [Double]) {
        guard pair.count == 2 else { return nil }
        self.init(lon: pair[0], lat: pair[1])
    }

    public var pair: [Double] { [lon, lat] }
}

/// The 5-decimal grid every coordinate identity in this app is built on.
///
/// Ported from `shared/app-core.js` (`quant5`) and `app/public/app-coords.js`.
/// The comment in the JavaScript is worth repeating because it is the reason
/// these live at the bottom of the dependency graph rather than inside the
/// solver: graph nodes, stats edge keys, deck segment keys and the build-time
/// station expansion must all quantise identically, or cross-module coordinate
/// identities drift apart. The same is now true across languages.
public enum Grid {

    /// `Math.round(v * 1e5) / 1e5`, with JavaScript's rounding.
    public static func quant5(_ value: Double) -> Double {
        JSNumber.round(value * 1e5) / 1e5
    }

    public static func normalizeGraphCoord(_ coordinate: Coordinate) -> Coordinate {
        Coordinate(lon: quant5(coordinate.lon), lat: quant5(coordinate.lat))
    }

    /// `"lon,lat"` on the 5-decimal grid — the node identity, and a persisted
    /// cache format. See ``JSNumber`` for why this cannot use `"\(value)"`.
    public static func coordKey(_ coordinate: Coordinate) -> String {
        JSNumber.string(quant5(coordinate.lon))
            + ","
            + JSNumber.string(quant5(coordinate.lat))
    }

    /// Direction-independent key of one drawn route segment: the two node keys,
    /// smaller first, joined by `|`.
    ///
    /// The JavaScript is explicit that this is deliberately *not*
    /// `AppCore.edgeKey5`: this key's historical byte format orders the two
    /// node keys as strings, while `edgeKey5` orders them numerically. The
    /// overlap caches are keyed on this exact format, so the string ordering
    /// is load-bearing and is preserved here rather than tidied.
    public static func routeCoordinateSegmentKey(_ a: Coordinate, _ b: Coordinate) -> String {
        let ka = coordKey(a)
        let kb = coordKey(b)
        return JSNumber.stringLessOrEqual(ka, kb) ? ka + "|" + kb : kb + "|" + ka
    }
}
