import Foundation

/// The second level-of-detail question, asked of the same railway.
///
/// ``Visibility/minZoomForLength(totalKm:)`` decides when a LINE is worth
/// drawing, from how long it is. This decides when its STATION DOTS are worth
/// drawing, from how far apart they are — a different question with a
/// different answer, because a 6 km tramway and a 600 km trunk can carry stops
/// at the same spacing, and it is the spacing that says whether two beads
/// would land on top of each other.
///
/// Ported from `rail-network.js` `stationMinZoomForLine`. Like the rest of
/// `Visibility` this is the web app's own rule rather than an iOS invention:
/// the two apps have to thin their station dots at the same moment or they are
/// showing different maps of the same country.
extension Visibility {

    /// `STATION_DOT_GAP_PX` — the screen distance two station beads have to be
    /// worth before both are drawn. It is a *pixel* budget, which is what
    /// makes the whole rule a zoom ladder: doubling the zoom halves the ground
    /// distance one pixel buys.
    private static let stationDotGapPx: Double = 22

    /// `STATION_LOD_K` — the ground kilometres one 256 px tile spans at
    /// latitude 35, scaled by the gap budget. 40075.017 km is the equatorial
    /// circumference and the cosine narrows it to 35°N, which is Tokyo's and
    /// close enough to the middle of everything the packages cover. So
    /// `K / spacing` is how many tiles-worth of gap a line has, and its log2
    /// is the zoom at which that gap first reaches 22 px.
    ///
    /// Spelled as the same expression in the same association order as the
    /// JavaScript — `(22 * C) / (256 * cos((35 * π) / 180))`, not
    /// `22 * C / 256 / cos(...)` — because the result is fed to a `log2` that
    /// is then rounded to an integer, so a reassociated product differing in
    /// the last bit can land on the other side of a rounding tie. Measured:
    /// V8 and Darwin agree bit for bit on this `cos`, so both languages hold
    /// the same double, 4204.282706059507 (0x40B0_6C48_5F6C_9FF7).
    private static let stationLodK =
        (stationDotGapPx * 40075.017) / (256 * cos((35 * Double.pi) / 180))

    /// `STATION_MINZ_CAP` — past this zoom nothing further is gained by
    /// holding dots back, so the ladder stops. 41 of the 804 shipped lines sit
    /// here already: Hong Kong's trams and light rail, a quarter of a
    /// kilometre between stops.
    private static let stationMinZoomCap = 14

    /// The zoom at which one line's station dots start being drawn.
    ///
    /// `lineMinZoom` is the line's own length-derived zoom — note that at the
    /// call site it is the whole visibility GROUP's, while `totalKm` is the
    /// single line's. That asymmetry is deliberate in the JavaScript: a
    /// railway stored as several administrative pieces appears as one unit,
    /// but each piece's dots are thinned by its own density.
    ///
    /// The caller in `buildNetworkFromCompactPackage` applies one further
    /// rule this function does not know about: the two terminals of a
    /// non-loop line keep `lineMinZoom` instead, so a line's endpoints are
    /// named as soon as the line is drawn and only the intermediate dots
    /// declutter.
    public static func stationMinZoom(
        lineMinZoom: Int, totalKm: Double, stationCount: Int
    ) -> Int {
        // The degenerate line — and the one path on which neither clamp below
        // runs. The JavaScript hands `lineMinZoom` straight back, so this is
        // the only way the function can answer above the cap. Reproduced
        // rather than tidied: no shipped line reaches it (0 of 804), so a port
        // that "fixed" it would be changing behaviour nobody could see.
        //
        // A NaN total fails `<= 0` in both languages and so falls THROUGH this
        // guard exactly as it does in JavaScript; it is caught further down.
        if stationCount < 2 || totalKm <= 0 { return lineMinZoom }

        // Gaps, not stations. Dividing by `stationCount` instead is off by a
        // factor of n/(n-1), which on a two-station line is a whole octave —
        // one entire zoom level.
        let averageSpacingKm = totalKm / Double(stationCount - 1)

        // `JSNumber.round`, never `.rounded()`. Swift breaks a tie away from
        // zero and JavaScript breaks it toward +∞, so `Math.round(-2.5)` is -2
        // where `(-2.5).rounded()` is -3. Only an enormous average spacing
        // (12,000 km and up) puts this expression on a negative tie, but such
        // a spacing is exactly what a km column read as metres produces, and
        // the fixture carries three of them for that reason.
        let densityMinZoom = JSNumber.round(log2(stationLodK / averageSpacingKm))

        // `Math.max`/`Math.min` propagate NaN. Swift's are written
        // `y >= x ? y : x`, so they quietly return the *other* operand
        // instead. Only `totalKm` can carry a NaN in here and JSON has no NaN
        // literal, so nothing decoded from a package can reach this line — but
        // the languages genuinely differ, and NaN is not a zoom anything can
        // filter on, so the behaviour is stated here rather than left to
        // whichever operand order the standard library happens to use.
        guard !densityMinZoom.isNaN else { return lineMinZoom }

        // Stations may declutter EARLIER than their line but never outlive it,
        // and never survive past the cap.
        //
        // Both clamps stay in `Double` until the end because `densityMinZoom`
        // can legitimately be infinite: a spacing small enough that
        // `K / spacing` overflows, or large enough that it underflows to zero.
        // The cap is what makes the result finite again, so narrowing before
        // it would trap on inputs the JavaScript answers 14 for.
        let clamped = min(Double(stationMinZoomCap), max(Double(lineMinZoom), densityMinZoom))
        return Int(clamped)
    }

    /// The station-dot minimum zoom for every line in a package, with the
    /// arguments paired the way `buildNetworkFromCompactPackage` pairs them:
    /// the group's zoom as the floor, the line's own length and station count
    /// as the density.
    public static func stationMinZoomByLineId(_ package: CompactPackage) -> [String: Int] {
        let lineZoom = minZoomByLineId(package)
        var result: [String: Int] = [:]
        for line in package.lines {
            // `minZoomByLineId` is built from these same lines, so the lookup
            // cannot miss; the default is unreachable rather than a fallback.
            result[line.id] = stationMinZoom(
                lineMinZoom: lineZoom[line.id] ?? 0,
                totalKm: line.segments.reduce(0) { $0 + $1.distanceKm },
                stationCount: line.stations.count)
        }
        return result
    }
}
