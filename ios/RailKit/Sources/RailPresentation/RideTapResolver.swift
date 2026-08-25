import Foundation

/// Which rides a tap landed on.
///
/// A finger has no hover stage, so a tap over crossing lines is ambiguous in a
/// way a pointer's never is: the web app answers it by handing every train
/// under a coarse-pointer tap to `handleDeckRouteChoices` and asking. This is
/// the half of that decision that can be checked — given points already in
/// screen space, which rides are within the tap's reach, and in what order.
///
/// It lives here rather than in the map's coordinator because a decision made
/// inside a `UIViewRepresentable`'s delegate callbacks is a decision nothing
/// can run: `MKMapView.convert(_:toPointTo:)` needs a live map view, a window
/// and a layout pass. Splitting the projection from the arithmetic leaves the
/// arithmetic testable, which is where the off-by-one lives — the distance to a
/// SEGMENT is not the distance to its nearer endpoint, and a ride whose two
/// vertices straddle the tap is exactly the case a naïve version misses.
public enum RideTapResolver {

    /// A point in the map view's own coordinate space, in points.
    public struct Point: Equatable, Sendable {
        public var x: Double
        public var y: Double

        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    /// One ride, already projected into screen space.
    public struct Candidate: Sendable {
        public var id: String
        /// One entry per drawn stroke; a stroke of fewer than two points can
        /// draw nothing and is ignored.
        public var strokes: [[Point]]

        public init(id: String, strokes: [[Point]]) {
            self.id = id
            self.strokes = strokes
        }
    }

    /// How near a tap has to fall, in points.
    ///
    /// 18 pt against the 44 pt of a button, because a railway line is a target
    /// the reader aims at with a visible mark under the finger rather than a
    /// control they hit blind — and because two parallel rides 20 pt apart are
    /// a normal sight on this map, where a 44 pt reach would make every tap
    /// ambiguous.
    public static let defaultTolerance: Double = 18

    /// Every ride within `tolerance` of the tap, nearest first.
    ///
    /// Duplicates are removed — a ride is one answer however many of its
    /// strokes are under the finger — and the order is the one the chooser
    /// shows, so the nearest ride is the first thing the reader reads.
    public static func hits(
        at point: Point, among candidates: [Candidate],
        tolerance: Double = defaultTolerance
    ) -> [String] {
        var scored: [(id: String, distance: Double)] = []
        for candidate in candidates {
            var best = Double.infinity
            for stroke in candidate.strokes where stroke.count >= 2 {
                var previous = stroke[0]
                for next in stroke.dropFirst() {
                    best = min(best, distance(from: point, to: previous, next))
                    previous = next
                }
            }
            if best <= tolerance { scored.append((candidate.id, best)) }
        }
        // Sorted by distance, and by id where two rides are equidistant —
        // which they are exactly when they share the metres under the finger,
        // the case this whole resolver exists for. Without the tiebreak the
        // chooser's order would depend on the order the rides happened to be
        // built in, and the same tap would list them differently twice.
        scored.sort { $0.distance == $1.distance ? $0.id < $1.id : $0.distance < $1.distance }
        var seen = Set<String>()
        return scored.compactMap { seen.insert($0.id).inserted ? $0.id : nil }
    }

    /// Distance from a point to a line SEGMENT — not to the infinite line, and
    /// not to the nearer endpoint.
    static func distance(from point: Point, to a: Point, _ b: Point) -> Double {
        let dx = b.x - a.x
        let dy = b.y - a.y
        let denominator = dx * dx + dy * dy
        // A zero-length segment is a point: two identical vertices are common
        // where a stroke was cut at a station, and dividing by their length
        // would answer NaN, which compares false against every tolerance and
        // silently drops the ride.
        let ratio = denominator > 0
            ? min(max(((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator, 0), 1)
            : 0
        return hypot(point.x - (a.x + ratio * dx), point.y - (a.y + ratio * dy))
    }
}
