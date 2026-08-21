import Foundation

/// Micro-kink grooming: which surveyed vertices a drawn line keeps.
///
/// Ported from `app/public/rail-network.js` (`MICRO_KINK_SCALES`,
/// `microKinkLimitsForSpacing`, `medianSpacingMeters`, `smoothMicroKinks`).
///
/// The job is to delete GIS digitising barbs — a vertex that runs a few metres
/// out and straight back — without touching anything the surveyor meant. Both
/// failure modes are silent in code review and loud on the map: too timid and
/// every station approach renders a thorn, too eager and a tram's genuine
/// street corner is rubbed flat.
///
/// What makes that possible is that the thresholds are **scale-relative**. The
/// JavaScript states the reasoning and it is worth carrying over verbatim: on a
/// 150 km trunk a 30 m in-and-out barb with a 3 m bulge is certainly noise; on
/// a street tram or a people-mover the very same numbers describe a REAL
/// corner, because a tram rounds a city block in tens of metres. So each line
/// picks its limits from its own characteristic scale — the median distance
/// between its stations — rather than from one absolute table.
public enum Grooming {

    // MARK: - the ladder

    /// One rung of the scale ladder: the limits a line of a given median
    /// station spacing grooms under.
    public struct Limits: Sendable, Hashable {
        /// The spacing ceiling this rung covers. The last rung is unbounded,
        /// which is `.infinity` here and `null` in the fixture, JSON having no
        /// spelling for it.
        public let maxSpacingMeters: Double
        /// The shorter of the two edges meeting at a corner must be no longer
        /// than this for the corner to be a candidate at all.
        public let edge: Double
        /// …and the corner must deflect at least this far.
        public let turn: Double
        /// …and, unless the corner is a spike (see ``spikeMinTurnDegrees``),
        /// must bulge no further than this from the chord it cuts.
        public let deviation: Double

        public init(
            maxSpacingMeters: Double, edge: Double, turn: Double, deviation: Double
        ) {
            self.maxSpacingMeters = maxSpacingMeters
            self.edge = edge
            self.turn = turn
            self.deviation = deviation
        }
    }

    /// `MICRO_KINK_SCALES`, in the order the lookup walks them: the first rung
    /// whose ceiling the spacing fits under wins, so the order is the rule.
    public static let microKinkScales: [Limits] = [
        // Street trams, people movers, funiculars: stops every few hundred
        // metres and curve radii to match. Only sub-10 m spikes are noise here.
        Limits(maxSpacingMeters: 700, edge: 8, turn: 75, deviation: 0.8),
        // Dense urban metro / short private lines.
        Limits(maxSpacingMeters: 1600, edge: 16, turn: 65, deviation: 1.5),
        // Ordinary regional and trunk railways (the historic thresholds).
        Limits(maxSpacingMeters: .infinity, edge: 30, turn: 55, deviation: 3),
    ]

    /// The rung used when a line's spacing says nothing usable — and the rung
    /// `smoothMicroKinks` falls back to when handed no limits at all.
    public static let defaultMicroKink = microKinkScales[microKinkScales.count - 1]

    /// At this deflection the two edges are effectively anti-parallel: the
    /// vertex is a zero-width spike (out and straight back), which is
    /// digitising noise at every scale. The lateral-deviation cap only makes
    /// sense for the shallower range, where it separates a real sharp corner
    /// from a bulge — so at or above this angle the cap is *not consulted*.
    public static let spikeMinTurnDegrees = 150.0

    /// The grooming limits a line of this median station spacing should use.
    public static func microKinkLimits(medianSpacingMeters meters: Double) -> Limits {
        // `!(meters > 0)` rather than `meters <= 0`, exactly as the JavaScript
        // writes it: the negated comparison is also the NaN guard, and a line
        // whose segment lengths are all zero reaches it.
        if !(meters > 0) { return defaultMicroKink }
        for scale in microKinkScales where meters <= scale.maxSpacingMeters {
            return scale
        }
        return defaultMicroKink
    }

    /// The limits one compact-package line grooms under — the composition the
    /// web app's `displayPartsForLine` performs on every line it draws.
    public static func microKinkLimits(for line: CompactPackage.Line) -> Limits {
        microKinkLimits(medianSpacingMeters: medianSpacingMeters(line))
    }

    /// A line's characteristic scale: the median of its station-to-station
    /// distances, in metres.
    public static func medianSpacingMeters(_ line: CompactPackage.Line) -> Double {
        medianSpacingMeters(segmentKilometres: line.segments.map(\.distanceKm))
    }

    /// The same rule over a bare list of segment lengths.
    ///
    /// Split out from the line form so it can be checked against inputs the
    /// shipped packages do not contain — measured: no line in five countries
    /// carries a zero-length segment, so the filter below is unreachable from
    /// real data, and a port that dropped it would look correct everywhere.
    ///
    /// Two details are load-bearing. Non-positive segments are *filtered out*
    /// before the median is taken, rather than sorting to the front and
    /// dragging it down; and the median of an even count is the UPPER of the
    /// two middle values (`floor(n / 2)`), not their mean — a port that
    /// averages lands between two rungs and moves lines across the ladder.
    public static func medianSpacingMeters(segmentKilometres: [Double]) -> Double {
        let spacings = segmentKilometres
            .map { $0 * 1000 }
            .filter { $0 > 0 }
            .sorted()
        if spacings.isEmpty { return 0 }
        return spacings[spacings.count / 2]
    }

    // MARK: - coordinate identity

    /// `"lon,lat"` from the **raw** coordinate.
    ///
    /// Deliberately not ``Grid/coordKey(_:)``. That one quantises to the
    /// 5-decimal grid first, because it is building a persisted cache identity;
    /// this one is `rail-network.js`'s own `coordinateKey`, which spells the
    /// number it was given. The packages carry six decimals, so the two
    /// disagree on almost every real vertex — a port that reaches for the
    /// quantised key here protects a set of points that mostly do not exist,
    /// and grooms away the station anchors it was asked to defend.
    ///
    /// The JavaScript spelling of the number is still the one that matters
    /// (`139`, never `139.0`), hence ``JSNumber/string(_:)``.
    public static func coordinateKey(_ coordinate: Coordinate) -> String {
        JSNumber.string(coordinate.lon) + "," + JSNumber.string(coordinate.lat)
    }

    // MARK: - the groomer

    /// Removes only GIS digitising barbs, at the line's own scale.
    ///
    /// `protectedKeys` names vertices that may not be groomed away — station
    /// anchors, and any vertex appearing in more than one stroke of the same
    /// line. The second of those is not a nicety: a branch's lead-in is a
    /// literal copy of the trunk's vertices, so if the groomer drops a kink
    /// from one copy and keeps it in the other, the two strokes stop being
    /// coincident and the shared metres render as a pair of lines a few metres
    /// apart. Whatever survives has to survive in both.
    ///
    /// Note that protection is by **key**, not by position: protecting one
    /// vertex protects every vertex in the line that has the same coordinates.
    /// That is what makes it work across strokes, and it is observable — a line
    /// that returns to a point it has already visited protects both visits.
    ///
    /// Three things a plausible-looking port gets wrong:
    ///
    ///   1. **`previous` is the last KEPT vertex**, `next.last`, not
    ///      `current[index - 1]`. Removals therefore cascade *within* a pass:
    ///      once a barb goes, the next corner is judged against what is left,
    ///      not against what was there.
    ///   2. **The loop repeats to stability.** One pass cleans a one-vertex
    ///      barb; a two-vertex barb needs the second pass to see it. 阿里山線's
    ///      switchbacks need thirteen.
    ///   3. **The result can be shorter than two vertices.** An out-and-back
    ///      spike collapses to a single point, because the closing push is
    ///      guarded by the same-coordinate test. Callers filter on
    ///      `count >= 2`; this function does not.
    public static func smoothMicroKinks(
        _ coordinates: [Coordinate],
        limits: Limits?,
        protectedKeys: Set<String>? = nil
    ) -> [Coordinate] {
        let rung = limits ?? defaultMicroKink
        let edge = rung.edge
        let turn = rung.turn
        let deviation = rung.deviation

        // Adjacent duplicates go first, before anything is measured. Real
        // packages are full of them: `decodeIntervals` ends one interval and
        // starts the next on the same station anchor, so a concatenated chain
        // repeats a vertex at every seam, and a repeated vertex has no
        // direction for `turnDegrees` to read.
        var current: [Coordinate] = []
        for coordinate in coordinates {
            // Written as a statement rather than a `where` clause because the
            // test reads the array this loop is appending to: each coordinate
            // is compared against the one most recently KEPT, so a run of
            // three identical vertices collapses to one and not to two.
            if !sameCoordinate(current.last, coordinate) { current.append(coordinate) }
        }

        var changed = true
        while changed && current.count > 2 {
            changed = false
            var next: [Coordinate] = [current[0]]
            for index in 1..<(current.count - 1) {
                let previous = next[next.count - 1]
                let corner = current[index]
                let following = current[index + 1]
                let shortEdge = min(
                    distanceMeters(previous, corner),
                    distanceMeters(corner, following)
                )
                let deflection = turnDegrees(previous, corner, following)
                // `protectedKeys?.contains(…) ?? false` is JavaScript's
                // `!protectedKeys?.has(key)`, optional chaining and all: a
                // missing set protects nothing, exactly as an empty one does.
                // The optionality is kept rather than tidied into a required
                // empty set because the JavaScript's own call sites pass
                // nothing at all, and the fixture carries a case for each
                // shape so the two cannot drift apart.
                let isMicroKink =
                    !(protectedKeys?.contains(coordinateKey(corner)) ?? false)
                    && shortEdge <= edge
                    && deflection >= turn
                    && (deflection >= spikeMinTurnDegrees
                        || pointSegmentDistanceMeters(corner, previous, following)
                            <= deviation)
                // A surviving corner is still dropped if it repeats the vertex
                // already at the end of `next` — which happens when a spike
                // has just been removed and the vertex after it is the same
                // point the spike left from. X, spike, X, Y grooms to X, Y and
                // never to X, X, Y.
                if isMicroKink {
                    changed = true
                } else if !sameCoordinate(next[next.count - 1], corner) {
                    next.append(corner)
                }
            }
            if !sameCoordinate(next[next.count - 1], current[current.count - 1]) {
                next.append(current[current.count - 1])
            }
            current = next
        }
        return current
    }

    /// JavaScript's `sameCoordinate`: both ends present and both components
    /// `===`. A `nil` on either side is false, which is what makes the very
    /// first append of the de-duplication pass happen.
    static func sameCoordinate(_ left: Coordinate?, _ right: Coordinate?) -> Bool {
        guard let left, let right else { return false }
        return left.lon == right.lon && left.lat == right.lat
    }

    // MARK: - the local metric

    // Flat local projection at a given latitude: 111 320 m per degree, with the
    // longitude axis shrunk by cos(latitude). The three measurements below MUST
    // share it — an angle measured on unprojected lon/lat degrees is wrong by
    // the aspect ratio, which at 35.56°N once misreported a 9.3° bend.
    private static let metresPerDegree = 111_320.0

    static func localMetric(
        _ point: Coordinate, latitude: Double
    ) -> (x: Double, y: Double) {
        let radians = (latitude * .pi) / 180
        return (point.lon * metresPerDegree * cos(radians), point.lat * metresPerDegree)
    }

    /// **Not** ``Geometry/distanceMeters(_:_:)``, despite the name.
    ///
    /// This is the equirectangular metric `rail-network.js` keeps deliberately
    /// separate from the route solver's haversine. It reads about 0.1125%
    /// LONGER everywhere — 111 320 against the haversine's implied 111 194.93
    /// m per degree, measured constant across 240 pairs spanning
    /// Sapporo→Kaohsiung. Both apply the cos(latitude) correction, so the gap
    /// is purely the constant.
    ///
    /// Do not unify the two. Every threshold in this file was tuned against
    /// these numbers, and the JavaScript records that the equivalent swap in
    /// its own test harness quietly broke that harness's guarantee.
    static func distanceMeters(_ left: Coordinate, _ right: Coordinate) -> Double {
        let latitude = (left.lat + right.lat) / 2
        let a = localMetric(left, latitude: latitude)
        let b = localMetric(right, latitude: latitude)
        return hypot(a.x - b.x, a.y - b.y)
    }

    /// Deflection at `corner`, in degrees: 0 is straight on, 180 is straight
    /// back. All three points are projected at the CORNER's latitude, not at
    /// each own, so the angle is measured in one consistent plane.
    static func turnDegrees(
        _ previous: Coordinate, _ corner: Coordinate, _ following: Coordinate
    ) -> Double {
        let latitude = corner.lat
        let a = localMetric(previous, latitude: latitude)
        let b = localMetric(corner, latitude: latitude)
        let c = localMetric(following, latitude: latitude)
        let incoming = (x: b.x - a.x, y: b.y - a.y)
        let outgoing = (x: c.x - b.x, y: c.y - b.y)
        let denominator = hypot(incoming.x, incoming.y) * hypot(outgoing.x, outgoing.y)
        // JavaScript's `if (!denominator)`, which is true for 0, -0 and NaN.
        // A zero-length edge is reachable in one pass — the vertex after a
        // removed spike can repeat the one before it — and answering 0 rather
        // than dividing is what keeps that vertex from reading as a corner.
        if denominator == 0 || denominator.isNaN { return 0 }
        let cosine = Swift.max(
            -1, Swift.min(1, (incoming.x * outgoing.x + incoming.y * outgoing.y) / denominator)
        )
        return (acos(cosine) * 180) / .pi
    }

    /// How far `point` bulges from the chord `start`–`end`, in metres. This is
    /// the cap that separates a real sharp corner from a barb, and it is only
    /// consulted below ``spikeMinTurnDegrees``.
    static func pointSegmentDistanceMeters(
        _ point: Coordinate, _ start: Coordinate, _ end: Coordinate
    ) -> Double {
        // All three at the POINT's latitude here, where `turnDegrees` uses the
        // corner's. In the groomer's one call site they are the same point, so
        // the two conventions coincide; they are still written as the
        // JavaScript writes them, because a caller from anywhere else would
        // find the difference.
        let latitude = point.lat
        let p = localMetric(point, latitude: latitude)
        let a = localMetric(start, latitude: latitude)
        let b = localMetric(end, latitude: latitude)
        let dx = b.x - a.x
        let dy = b.y - a.y
        let lengthSquared = dx * dx + dy * dy
        let ratio =
            lengthSquared != 0
            ? Swift.max(
                0, Swift.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
            : 0
        return hypot(p.x - (a.x + ratio * dx), p.y - (a.y + ratio * dy))
    }
}

// `hypot` rather than `sqrt(x*x + y*y)`, and `Swift.min`/`Swift.max` rather
// than a ternary, because the JavaScript calls `Math.hypot`, `Math.min` and
// `Math.max` and this code has to answer what those answer. The one place the
// three of them are known to differ is NaN — JavaScript's `Math.min(5, NaN)` is
// NaN where Swift's `min(5, NaN)` is 5 — which is unreachable here: a NaN would
// have to arrive in a coordinate, and JSON has no spelling for one.
