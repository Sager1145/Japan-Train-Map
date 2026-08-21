import Foundation

/// Distance and decimation — the two geometry primitives everything else in
/// the pure tier is built on.
///
/// Ported from `app/public/app-route-simplify.js`.
public enum Geometry {

    /// Metres between two coordinates, by haversine on a sphere of radius
    /// 6 371 000 m.
    ///
    /// There is exactly one of these in the frontend, and getting to one was
    /// itself a piece of work: an earlier cleanup assumed three copies and
    /// found on measurement that they were *two different algorithms*, the
    /// other being an equirectangular metric in `rail-network.js` that is
    /// deliberately kept. So this is not "the distance function" — it is the
    /// haversine one, and a port that unifies it with the equirectangular one
    /// is changing numerical behaviour rather than removing duplication.
    public static func distanceMeters(_ a: Coordinate, _ b: Coordinate) -> Double {
        let radius = 6_371_000.0
        let p1 = a.lat * .pi / 180
        let p2 = b.lat * .pi / 180
        let dp = (b.lat - a.lat) * .pi / 180
        let dl = (b.lon - a.lon) * .pi / 180
        let sdp = sin(dp / 2), sdl = sin(dl / 2)
        let x = sdp * sdp + cos(p1) * cos(p2) * (sdl * sdl)
        return 2 * radius * asin(x.squareRoot())
    }

    /// Perpendicular distance in metres from `p` to the segment `a`–`b`, under
    /// a local equirectangular scaling supplied by the caller.
    ///
    /// The scales are parameters rather than constants because the simplifier
    /// computes them once per line from that line's first latitude; recomputing
    /// per point would be both slower and a different answer.
    static func perpDistanceMeters(
        _ p: Coordinate, _ a: Coordinate, _ b: Coordinate, sx: Double, sy: Double
    ) -> Double {
        let px = p.lon * sx, py = p.lat * sy
        let ax = a.lon * sx, ay = a.lat * sy
        let bx = b.lon * sx, by = b.lat * sy
        let dx = bx - ax, dy = by - ay
        let length2 = dx * dx + dy * dy
        if length2 == 0 { return hypot(px - ax, py - ay) }
        var t = ((px - ax) * dx + (py - ay) * dy) / length2
        t = t < 0 ? 0 : (t > 1 ? 1 : t)
        return hypot(px - (ax + t * dx), py - (ay + t * dy))
    }

    /// Iterative Douglas–Peucker. `epsilonMeters` is a distance, not a ratio.
    ///
    /// Returns the ascending **original** indices of the kept vertices, both
    /// ends always kept, so a caller can map a simplified vertex back to the
    /// source geometry. That index mapping — not the decimation — is why the
    /// function is still in the pipeline: overlap and lane splitting rely on
    /// it, and epsilon 0 must therefore retain every index.
    public static func douglasPeuckerIndices(
        _ points: [Coordinate], epsilonMeters: Double
    ) -> [Int] {
        let n = points.count
        if n < 3 || epsilonMeters <= 0 { return Array(0..<n) }

        let sx = metresPerDegreeLon * cos((points[0].lat) * .pi / 180)
        // Historical, and deliberately kept: latitude shares the longitude
        // scale here. It overestimates by about 0.7%, well inside the
        // tolerance slack, and correcting it would re-decimate every route in
        // the app for no visible gain.
        let sy = 111_320.0

        var keep = [Bool](repeating: false, count: n)
        keep[0] = true
        keep[n - 1] = true

        var stack: [(Int, Int)] = [(0, n - 1)]
        while let (s, e) = stack.popLast() {
            var maxDistance = -1.0
            var index = -1
            for i in (s + 1)..<e {
                let d = perpDistanceMeters(points[i], points[s], points[e], sx: sx, sy: sy)
                if d > maxDistance {
                    maxDistance = d
                    index = i
                }
            }
            if maxDistance > epsilonMeters && index != -1 {
                keep[index] = true
                stack.append((s, index))
                stack.append((index, e))
            }
        }

        return (0..<n).filter { keep[$0] }
    }

    static let metresPerDegreeLon = 111_320.0
    static let metresPerDegreeLat = 110_540.0
}

// `hypot` rather than `sqrt(x*x + y*y)`: the JavaScript calls `Math.hypot`,
// which is scaled to avoid intermediate overflow and can therefore differ from
// the naive form in the last unit in the last place. The distance is compared
// against epsilon to decide whether a vertex survives, so a last-ulp
// disagreement is a different polyline, not a rounding detail. Whether the two
// implementations agree exactly is a measurement, and port-fixtures/simplify.json
// is where it is measured.
