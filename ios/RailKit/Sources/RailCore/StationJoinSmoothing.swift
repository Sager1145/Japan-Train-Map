import Foundation

/// Station-join smoothing: what happens where two corridor curves meet at a
/// station and neither of them knows about the other.
///
/// Ported from `app/public/app-overlap-lanes.js` §1490-2145 —
/// `smoothCurveStationJoins` and the five primitives it is composed of, with
/// `smoothJoinedStationCurve`, `refreshFittedCurveGeometry`,
/// `rebuildLimitedDirectionField` and `fittedCurvePointAt`. It is the pass
/// ``OverlapLanes`` names as its seam and stops at: it runs after the corridor
/// phase, it assigns `gi.curve` and nothing else, and every other field that
/// file produces is already the JavaScript's final value.
///
/// ## What it is for
///
/// Different overlap memberships often end at the same station as separate
/// fitted curves. Each is C2 internally, but pinning both of them to that
/// station leaves a hard change of tangent between them — up to ~90° — and the
/// hover fan takes its shift direction from the curve's local perpendicular,
/// so the fan flips as the pointer crosses the station. The pass pairs the
/// straightest compatible ends at every station, welds each chain into one
/// polyline, and low-passes the whole thing so the former boundary is an
/// interior point of one curve.
///
/// It is five stages, each named for the intermediate product it builds:
///
///   1. `owners` — fitted curve → the groups that reference it. Many-to-one:
///      a station-continuous curve is shared (``indexStationJoinCurveOwners``).
///   2. `ends` — one descriptor per curve endpoint, with its outward tangent,
///      its ride ids and its snapped node key
///      (``collectStationJoinEndpoints(curves:owners:)``).
///   3. `candidates` — plausible endpoint pairs, best first
///      (``pairStationJoinCandidates(_:)``), then `connections`, a greedy
///      one-to-one selection (``buildStationJoinConnections(_:)``).
///   4. `components` — station-continuous chains
///      (``walkStationJoinChains(curveCount:connections:)``).
///   5. one refit per chain (``smoothJoinedStationCurve(source:template:sourceLines:)``),
///      accepted or rejected by ``stationJoinConstraintReport(_:)``.
///
/// ## Identity, not equality
///
/// The JavaScript keys three `Map`s and a `Set` on the fitted-curve OBJECT.
/// Two groups pointing at one curve are ONE node in the join graph; two equal
/// but distinct curves are two. Swift's value semantics cannot express that,
/// so a curve is identified here by its **index** into the `curves` array the
/// caller passes, and ``Group/curveIndex`` is that index — never a value to
/// compare. Getting this wrong is not a rounding difference: a corridor whose
/// two halves were one object becomes two, and the pass welds a curve to
/// itself.
///
/// ## Wiring it to ``OverlapLanes``, and the one field that is missing
///
/// After `buildRouteRecords`, every surviving corridor holds at most one
/// curve and no two share one, so the mapping is mechanical: one
/// ``CurveEntry`` per corridor with a curve, in
/// ``OverlapLanes/RecordBundle/corridors`` order, and one ``Group`` carrying
/// that index, the corridor's `mults` keys and its `curveEndpointNodeKeys`.
///
/// ``CurveEntry/sourceLines`` is the exception, and it cannot be recovered
/// from a ``OverlapLanes/RecordBundle`` today. It is `curve._sourceLines` —
/// the polyline the corridor fit was measured against, which for a stitched
/// component is the CHAIN `buildCorridorChain` assembled and not any single
/// corridor's `line`. The deviation check needs it: handed an empty array it
/// answers "invalid, infinitely far", and every chain is then rejected. So
/// closing this seam properly means one stored property on
/// ``OverlapLanes/Corridor`` set where §5 assigns `curve` — an edit to that
/// file, deliberately not made here.
///
/// ## What is not here
///
/// `runFitCurveJobs` (§2146), which packs this pass's answer into a structural
/// clone for `postMessage`. It is a serialisation of what ``Outcome`` already
/// holds, and the Worker it serialises for does not exist on this platform.
public enum StationJoinSmoothing {

    // MARK: - Tuning constants

    /// Visual continuity beats the strict radius at membership boundaries: a
    /// chain whose ONLY failed constraint is the geometric minimum radius
    /// still hovers far better than two curves meeting at up to ~90°, so such
    /// a candidate is accepted down to this fraction of the requested radius.
    /// The floor actually enforced is recorded on the accepted curve, so
    /// diagnostics measure against what was accepted rather than re-flagging
    /// the relaxation.
    public static let radiusRelax = 0.4

    /// `selectOneToOneEndpointPairs`' ambiguity margin at this call site. Two
    /// candidate joins for one endpoint that score within 50 of each other are
    /// a fork whose prongs are equally plausible; the endpoint joins nothing
    /// rather than joining whichever happened to sort first.
    static let ambiguityMargin = 50.0

    // MARK: - Inputs

    /// One fitted corridor curve as the join pass sees it.
    public struct CurveEntry: Sendable {
        public var curve: OverlapLanes.FittedCurve
        /// `curve._sourceLines`: the RAW railway geometry the fit was measured
        /// against, which the deviation check needs again after the refit.
        /// ``OverlapLanes/FittedCurve`` deliberately does not carry it (it is
        /// the fit's input), so it travels beside the curve.
        public var sourceLines: [[Coordinate]]

        public init(curve: OverlapLanes.FittedCurve, sourceLines: [[Coordinate]]) {
            self.curve = curve
            self.sourceLines = sourceLines
        }
    }

    /// One entry of `groupInfo`, reduced to the three fields this pass reads.
    public struct Group: Sendable {
        public var groupKey: String
        /// Index into the caller's `curves`, or `nil` for `gi.curve == null`.
        /// This is an IDENTITY: two groups carrying the same index share one
        /// curve in the JavaScript's sense.
        public var curveIndex: Int?
        /// `Object.keys(gi.mults)`.
        public var trainIds: [String]
        /// `gi._curveEndpointNodeKeys`. `nil` means the property is ABSENT,
        /// which is not the same as an empty array: the endpoint collector
        /// takes the first owner whose property is truthy, and `[]` is truthy
        /// in JavaScript. The elements are optional because the JavaScript
        /// checks `endpointNodeKeys[side] != null` before using one.
        public var endpointNodeKeys: [String?]?

        public init(
            groupKey: String, curveIndex: Int?, trainIds: [String],
            endpointNodeKeys: [String?]?
        ) {
            self.groupKey = groupKey
            self.curveIndex = curveIndex
            self.trainIds = trainIds
            self.endpointNodeKeys = endpointNodeKeys
        }
    }

    // MARK: - Outputs

    /// One accepted join, as the failure report and the debug overlay show it.
    /// `gapM` and `turnDeg` are rounded through JavaScript's `toFixed`, which
    /// is not `String(format:)` — see ``toFixedNumber(_:_:)``.
    public struct JoinEdge: Sendable, Equatable {
        public var a: Coordinate
        public var b: Coordinate
        public var gapM: Double
        public var turnDeg: Double
        /// `"node-id"` or `"geometry"`.
        public var matchKind: String
        public var nodeKey: String?
    }

    /// Why one component's station-continuous candidate was rejected, and
    /// where. Stamped on every owner group so the diagnostics can show WHERE
    /// and WHY the chain stayed separate curves instead of silently no-opping.
    public struct Failure: Sendable, Equatable {
        /// `"radius"`, `"deviation"`, `"direction"`, `"solver"`, or several
        /// joined by `+`. `"unknown"` if the reason list came out empty, which
        /// the JavaScript guards for and nothing produces.
        public var reason: String
        public var joins: [JoinEdge]
        public var groupKeys: [String]
        /// `Math.round`ed, and `nil` when there was no candidate to measure.
        public var requestedMinRadiusM: Double?
        public var achievedMinRadiusM: Double?
        public var maxDeviationM: Double?
        public var actualMaxDeviationM: Double?
    }

    /// A station-continuous curve: the refit, plus the stamps the pass adds.
    public struct JoinedCurve: Sendable {
        public var curve: OverlapLanes.FittedCurve
        /// The concatenated `_sourceLines` of every member curve.
        public var sourceLines: [[Coordinate]]
        /// `_finalDeviationValid` / `_finalDirectionValid`: the two hard
        /// validations re-run on the refit.
        public var finalDeviationValid: Bool
        public var finalDirectionValid: Bool
        /// How many box passes the low-pass needed, capped at 12.
        public var stationSmoothingPasses: Int
        /// Set only when the radius was accepted under ``radiusRelax``.
        public var stationJoinRadiusRelaxed: Bool
        public var acceptedMinRadiusMeters: Double?
        /// `component.count - 1`.
        public var stationJoinCount: Int
        public var stationJoinOriginalMaxDeg: Double
        public var stationJoinMaxGapMeters: Double
        public var stationJoinIdMatchedCount: Int
    }

    /// Which curve a group draws after the pass.
    public enum CurveRef: Sendable, Equatable {
        case none
        /// Unchanged: still the caller's `curves[index]`.
        case input(Int)
        /// Replaced by ``Outcome/joined```[index]`.
        case joined(Int)
    }

    public struct Outcome: Sendable {
        /// The station-continuous curves this pass produced, in the order the
        /// components were walked.
        public var joined: [JoinedCurve]
        /// Per input group, in input order.
        public var groupCurve: [CurveRef]
        /// Per input group: `gi.stationJoinFailure`, as an index into
        /// ``failures``.
        public var groupFailure: [Int?]
        public var failures: [Failure]
        /// The number of station boundaries that became interior points.
        public var roundedJoins: Int
    }

    // MARK: - JavaScript's number formatting

    /// `x || fallback` for a Double — every falsy value, which for a number
    /// means `0`, `-0` and `NaN`, collapses to the fallback.
    @inline(__always) static func or(_ value: Double, _ fallback: Double) -> Double {
        (value == 0 || value.isNaN) ? fallback : value
    }

    /// `Number.prototype.toFixed`, which is not `String(format: "%.*f")`.
    ///
    /// The specification chooses the integer `n` minimising `|n / 10^f − x|`
    /// against the EXACT value of `x` and, on a tie, picks the **larger** `n`.
    /// `printf` rounds a tie to even, so `(0.25).toFixed(1)` is `"0.3"` in
    /// JavaScript and `"0.2"` through `String(format:)`; and `(x * 10)
    /// .rounded()` is wrong differently again, because the product has already
    /// been rounded before the tie is examined.
    ///
    /// The exact decimal expansion is obtained from `%.*e` at a precision no
    /// finite Double can exceed (767 significant digits is the worst case, for
    /// the smallest subnormal), and the rounding is then done on digits.
    static func toFixedString(_ value: Double, _ digits: Int) -> String {
        if value.isNaN { return "NaN" }
        if value < 0 { return "-" + toFixedString(-value, digits) }
        if value.isInfinite { return "Infinity" }
        // The specification's own escape hatch: at this magnitude toFixed
        // gives up and returns ToString(x), exponent and all.
        if value >= 1e21 { return JSNumber.string(value) }

        let exact = String(format: "%.*e", 1085, abs(value))
        guard let eIndex = exact.firstIndex(of: "e"),
            let exponent = Int(exact[exact.index(after: eIndex)...])
        else { return JSNumber.string(value) }
        var significand = Array(exact[exact.startIndex..<eIndex].utf8)
            .filter { $0 != UInt8(ascii: ".") }
            .map { Int($0) - 48 }

        // value == significand × 10^(exponent − (count − 1)), so scaling by
        // 10^digits leaves `shift` decimal places still to be removed.
        let shift = exponent - (significand.count - 1) + digits
        var n: [Int]
        if shift >= 0 {
            n = significand + [Int](repeating: 0, count: shift)
        } else if -shift >= significand.count {
            // Everything is dropped. The first dropped digit is the leading
            // one only when exactly all of them go.
            n = [(-shift == significand.count && significand[0] >= 5) ? 1 : 0]
        } else {
            let firstDropped = significand[significand.count + shift]
            significand.removeLast(-shift)
            n = significand
            // ≥ 5 rounds up in both cases the specification distinguishes:
            // above the tie, and AT the tie, where it picks the larger n.
            if firstDropped >= 5 {
                var i = n.count - 1
                while i >= 0 {
                    n[i] += 1
                    if n[i] < 10 { break }
                    n[i] = 0
                    i -= 1
                }
                if i < 0 { n.insert(1, at: 0) }
            }
        }
        while n.count > 1 && n[0] == 0 { n.removeFirst() }
        var text = n.map { String($0) }.joined()
        if digits > 0 {
            if text.count <= digits {
                text = String(repeating: "0", count: digits + 1 - text.count) + text
            }
            text.insert(".", at: text.index(text.endIndex, offsetBy: -digits))
        }
        return text
    }

    /// `+x.toFixed(digits)` — the JavaScript expression the join report is
    /// built out of, string round trip and all.
    static func toFixedNumber(_ value: Double, _ digits: Int) -> Double {
        Double(toFixedString(value, digits)) ?? value
    }

    // MARK: - Sampling a curve mid-rebuild

    /// `fittedCurvePointAt`: the point `metres` along a fitted curve, or `nil`
    /// rather than garbage.
    ///
    /// The pts/cum pair is verified rather than assumed because station-join
    /// probing may see a curve mid-rebuild. This is the same binary search as
    /// `RailMapGeometry.curvePointAt` and is kept separate for the reason the
    /// JavaScript keeps its own copy: that file has to run with no window and
    /// no railmap family — inside the fit worker and the test VM — and
    /// delegating through `window.RailMapGeometry` once killed the worker on
    /// every full-country load.
    static func fittedCurvePointAt(_ curve: OverlapLanes.FittedCurve, _ metres: Double)
        -> Coordinate?
    {
        let pts = curve.pts
        let cum = curve.cum
        guard pts.count >= 2, cum.count == pts.count else { return nil }
        let target = Swift.max(0, Swift.min(curve.totalMeters, metres))
        var lo = 0
        var hi = cum.count - 1
        while lo + 1 < hi {
            let mid = (lo + hi) >> 1
            if cum[mid] <= target { lo = mid } else { hi = mid }
        }
        let span = or(cum[lo + 1] - cum[lo], 1)
        let t = (target - cum[lo]) / span
        return Coordinate(
            lon: pts[lo].lon + (pts[lo + 1].lon - pts[lo].lon) * t,
            lat: pts[lo].lat + (pts[lo + 1].lat - pts[lo].lat) * t)
    }

    // MARK: - Re-deriving a curve's arc length and tangents

    /// `refreshFittedCurveGeometry`: recompute the arc-length and tangent
    /// fields after the join pass has replaced one end of a fitted curve.
    ///
    /// Also refreshes the two achieved-radius diagnostics, because they are
    /// what the accept/reject verdict is read from — a stale one would let a
    /// chain in on the strength of its members' geometry.
    public static func refreshFittedCurveGeometry(_ curve: inout OverlapLanes.FittedCurve) {
        let pts = curve.pts
        var cum = [0.0]
        for i in 1..<Swift.max(1, pts.count) {
            cum.append(cum[i - 1] + Geometry.distanceMeters(pts[i - 1], pts[i]))
        }
        curve.cum = cum
        curve.totalMeters = cum[cum.count - 1]
        let step = curve.totalMeters / Double(Swift.max(1, pts.count - 1))
        let minDetail = or(curve.minDetailMeters, 3300)
        let tangentHalf = Int(
            Swift.max(
                1,
                Swift.min(
                    (Double(pts.count - 1) / 5).rounded(.down),
                    JSNumber.round(Swift.max(80, minDetail * 0.18) / Swift.max(1, step)))))
        let cs = or(curve.coslat, 1)
        curve.dirs = pts.indices.map { i in
            let a = pts[Swift.max(0, i - tangentHalf)]
            let b = pts[Swift.min(pts.count - 1, i + tangentHalf)]
            let dx = (b.lon - a.lon) * cs
            let dy = b.lat - a.lat
            let len = or(JSMath.hypot(dx, dy), 1)
            return (x: dx / len, y: dy / len)
        }

        // Keep the global diagnostics honest after changing the displayed
        // curve.
        let radiusHalf = Int(
            Swift.max(
                1,
                Swift.min(
                    (Double(pts.count - 1) / 5).rounded(.down),
                    JSNumber.round(
                        Swift.max(50, Swift.min(180, minDetail * 0.04)) / Swift.max(1, step)))))
        // Project to metric space once per point, then reuse the solver's own
        // curvature probe over the projected triples.
        let metricPts = pts.map {
            OverlapLanes.MetricPoint(
                x: $0.lon * cs * OverlapLanes.metresPerDegreeLon,
                y: $0.lat * OverlapLanes.metresPerDegreeLat)
        }
        var minRadius = Double.infinity
        var i = radiusHalf
        while i < pts.count - radiusHalf {
            minRadius = Swift.min(
                minRadius,
                OverlapLanes.circumRadius(
                    metricPts[i - radiusHalf], metricPts[i], metricPts[i + radiusHalf]))
            i += 1
        }
        curve.achievedMinRadiusMeters = minRadius.isFinite ? minRadius : nil
        var maxTurn = 0.0
        var previous: Double?
        for d in curve.dirs {
            var angle = atan2(d.y, d.x)
            if let last = previous {
                while angle - last > .pi { angle -= 2 * .pi }
                while angle - last < -.pi { angle += 2 * .pi }
                maxTurn = Swift.max(maxTurn, abs(angle - last))
            }
            previous = angle
        }
        curve.achievedDirectionRadiusMeters = maxTurn > 1e-9 ? step / maxTurn : nil
    }

    /// `rebuildLimitedDirectionField`: run the essential-angle pipeline again
    /// so `dirs` stays a hard-validated output rather than an unchecked
    /// finite-difference diagnostic. Returns whether the field it built holds
    /// the requested minimum radius.
    ///
    /// Note that it clamps every step to `minRadius * 1.03` and then measures
    /// the radius of what it has just clamped, so it can only answer `false`
    /// where two consecutive points share an arc length. Measured over 260
    /// mirrors built from every shared endpoint in the jp package under five
    /// slider settings, it never did — see the fixture's header. It is ported
    /// because the port reproduces the code, not the reachable subset of it.
    @discardableResult
    public static func rebuildLimitedDirectionField(_ curve: inout OverlapLanes.FittedCurve)
        -> Bool
    {
        let pts = curve.pts
        guard pts.count >= 2 else { return false }
        let cum = curve.cum
        let total = or(curve.totalMeters, 0)
        let step = total / Double(Swift.max(1, pts.count - 1))
        let minRadius = Swift.max(100, or(curve.requestedMinRadiusMeters, 3100))
        let minDetail = Swift.max(20, or(curve.minDetailMeters, 3300))
        let half = Int(
            Swift.max(
                1,
                Swift.min(
                    (Double(pts.count - 1) / 5).rounded(.down),
                    JSNumber.round(Swift.max(60, minDetail * 0.18) / Swift.max(1, step)))))
        let cs = or(curve.coslat, 1)
        var angles = pts.indices.map { i -> Double in
            let a = pts[Swift.max(0, i - half)]
            let b = pts[Swift.min(pts.count - 1, i + half)]
            return atan2(b.lat - a.lat, (b.lon - a.lon) * cs)
        }
        for i in 1..<angles.count {
            while angles[i] - angles[i - 1] > .pi { angles[i] -= 2 * .pi }
            while angles[i] - angles[i - 1] < -.pi { angles[i] += 2 * .pi }
        }
        let sigma = Swift.max(80, Swift.max(minDetail * 0.45, minRadius * 0.12))
        angles = OverlapLanes.gaussianSmoothSeries(angles, sigma: sigma, step: step, minRadius: 2)
        angles = OverlapLanes.gaussianSmoothSeries(
            angles, sigma: sigma * 0.65, step: step, minRadius: 2)
        let limitedRadius = minRadius * 1.03
        for _ in 0..<2 {
            for i in 1..<angles.count {
                let maxTurn = Swift.min(
                    0.045, Swift.max(1e-6, (cum[i] - cum[i - 1]) / limitedRadius))
                angles[i] = Swift.max(
                    angles[i - 1] - maxTurn, Swift.min(angles[i - 1] + maxTurn, angles[i]))
            }
            for i in stride(from: angles.count - 2, through: 0, by: -1) {
                let maxTurn = Swift.min(
                    0.045, Swift.max(1e-6, (cum[i + 1] - cum[i]) / limitedRadius))
                angles[i] = Swift.max(
                    angles[i + 1] - maxTurn, Swift.min(angles[i + 1] + maxTurn, angles[i]))
            }
        }
        var achieved = Double.infinity
        for i in 1..<angles.count {
            let turn = abs(angles[i] - angles[i - 1])
            if turn > 1e-9 { achieved = Swift.min(achieved, (cum[i] - cum[i - 1]) / turn) }
        }
        // The platform's `cos` here, and NOT ``JSMath/cos(_:)`` — the one
        // place in this file where that is the right choice. `JSMath.cos` is
        // V8's fdlibm port carrying only the ±3π/4 argument reduction, which
        // is everything a latitude in radians ever needs and traps on
        // anything larger; a direction-field angle is unbounded once the
        // unwrapping loop above has run. There is no V8 `sin` in `JSMath`
        // either, so both components carry the platform's last bit and the
        // parity test's ULP ceiling is what absorbs it.
        curve.dirs = angles.map { (x: cos($0), y: sin($0)) }
        curve.directionSigmaMeters = sigma
        curve.achievedDirectionRadiusMeters = achieved.isFinite ? achieved : nil
        return !achieved.isFinite || achieved >= minRadius * 0.999
    }

    // MARK: - The chain refit

    /// A three-pass box filter, which approximates a Gaussian of σ ≈ radius.
    ///
    /// Prefix sums make it O(n): the weighted implementation it replaced
    /// performed tens of millions of per-sample operations on a nationwide
    /// joined corridor. The ends are extended by LINEAR CONTINUATION of the
    /// first and last `edgeSpan` samples rather than by clamping, so the
    /// filter does not pull a straight approach into a curve.
    static func boxPass(_ input: [OverlapLanes.MetricPoint], _ radius: Int)
        -> [OverlapLanes.MetricPoint]
    {
        let n = input.count
        let radius = Swift.max(1, Swift.min(n - 1, radius))
        let edgeSpan = Swift.min(n - 1, Swift.max(3, radius))
        let startDx = (input[edgeSpan].x - input[0].x) / Double(edgeSpan)
        let startDy = (input[edgeSpan].y - input[0].y) / Double(edgeSpan)
        let last = n - 1
        let endDx = (input[last].x - input[last - edgeSpan].x) / Double(edgeSpan)
        let endDy = (input[last].y - input[last - edgeSpan].y) / Double(edgeSpan)
        var extended = [OverlapLanes.MetricPoint]()
        extended.reserveCapacity(n + radius * 2)
        for i in -radius..<(n + radius) {
            if i < 0 {
                extended.append(
                    OverlapLanes.MetricPoint(
                        x: input[0].x + startDx * Double(i), y: input[0].y + startDy * Double(i)))
            } else if i > last {
                let d = Double(i - last)
                extended.append(
                    OverlapLanes.MetricPoint(
                        x: input[last].x + endDx * d, y: input[last].y + endDy * d))
            } else {
                extended.append(input[i])
            }
        }
        var prefixX = [Double](repeating: 0, count: extended.count + 1)
        var prefixY = [Double](repeating: 0, count: extended.count + 1)
        for i in 0..<extended.count {
            prefixX[i + 1] = prefixX[i] + extended[i].x
            prefixY[i + 1] = prefixY[i] + extended[i].y
        }
        let width = Double(radius * 2 + 1)
        return (0..<n).map { i in
            OverlapLanes.MetricPoint(
                x: (prefixX[i + radius * 2 + 1] - prefixX[i]) / width,
                y: (prefixY[i + radius * 2 + 1] - prefixY[i]) / width)
        }
    }

    /// `smoothJoinedStationCurve`: weld one chain's concatenated points into a
    /// single station-continuous curve.
    ///
    /// A positional low-pass, not a re-solve. The member curves are already
    /// densely sampled, radius-limited splines, so smoothing their
    /// concatenation removes only the new station seams — much cheaper than
    /// running the complete source-fitting solver again over a corridor
    /// hundreds of kilometres long.
    public static func smoothJoinedStationCurve(
        source: [Coordinate], template: OverlapLanes.FittedCurve, sourceLines: [[Coordinate]]
    ) -> JoinedCurve? {
        guard source.count >= 4 else { return nil }
        let lat0 = source.reduce(0.0) { $0 + $1.lat } / Double(source.count)
        let coslat = or(JSMath.cos((lat0 * .pi) / 180), 1e-6)
        let mx = OverlapLanes.metresPerDegreeLon * coslat
        let my = OverlapLanes.metresPerDegreeLat
        let origin = source[0]
        let metricSource = source.map {
            OverlapLanes.MetricPoint(x: ($0.lon - origin.lon) * mx, y: ($0.lat - origin.lat) * my)
        }
        var total = 0.0
        for i in 1..<metricSource.count {
            total += JSMath.hypot(
                metricSource[i].x - metricSource[i - 1].x,
                metricSource[i].y - metricSource[i - 1].y)
        }
        let step = total / Double(Swift.max(1, metricSource.count - 1))
        let minRadius = or(template.requestedMinRadiusMeters, 3100)
        let minDetail = or(template.minDetailMeters, 3300)
        let sigma = Swift.max(500, Swift.max(minDetail * 0.9, minRadius * 0.65))
        let boxRadius = Int(
            Swift.max(
                2,
                Swift.min(
                    Double(metricSource.count - 1),
                    Swift.min(260, (sigma / Swift.max(1, step)).rounded(.up)))))
        var metric = boxPass(boxPass(boxPass(metricSource, boxRadius), boxRadius), boxRadius)

        // Everything the template carries survives except the three fields
        // replaced here — the JavaScript spreads the template object, so the
        // requested radius, the detail and deviation budgets, the sampling
        // precision and the near-parallel flag all come through unchanged.
        var curve = template
        curve.coslat = coslat
        curve.smoothingSigmaMeters = sigma
        curve.fitType = "cubic-bspline-c2-station-continuous"
        curve.sourceTotalMeters = total
        curve.endpointChordMeters = JSMath.hypot(
            metricSource[metricSource.count - 1].x - metricSource[0].x,
            metricSource[metricSource.count - 1].y - metricSource[0].y)

        // Some newly joined near-parallel corridors contain a sharper station
        // throat than either source curve had alone. Continue the same
        // physical low-pass until the displayed centreline also satisfies the
        // requested minimum radius; this preserves the no-sudden-turn
        // guarantee after adding the new overlap membership.
        var passCount = 3
        while true {
            // Whole-chain smoothing must never move the two physical
            // terminal ends.
            metric[0] = metricSource[0]
            metric[metric.count - 1] = metricSource[metricSource.count - 1]
            curve.pts = metric.map {
                Coordinate(lon: origin.lon + $0.x / mx, lat: origin.lat + $0.y / my)
            }
            refreshFittedCurveGeometry(&curve)
            if curve.achievedMinRadiusMeters == nil
                || curve.achievedMinRadiusMeters! >= minRadius * 0.999
                || passCount >= 12
            {
                break
            }
            metric = boxPass(metric, boxRadius)
            passCount += 1
        }

        let rawSources = sourceLines
        let deviation = OverlapLanes.validateFittedCurveDeviation(
            points: curve.pts, sourceLines: rawSources, budgetMeters: curve.maxDeviationMeters)
        curve.actualMaxDeviationMeters = deviation.maxDeviationMeters
        let directionValid = rebuildLimitedDirectionField(&curve)
        return JoinedCurve(
            curve: curve, sourceLines: rawSources, finalDeviationValid: deviation.valid,
            finalDirectionValid: directionValid, stationSmoothingPasses: passCount,
            stationJoinRadiusRelaxed: false, acceptedMinRadiusMeters: nil, stationJoinCount: 0,
            stationJoinOriginalMaxDeg: 0, stationJoinMaxGapMeters: 0,
            stationJoinIdMatchedCount: 0)
    }

    // MARK: - The five intermediate products

    /// One end of one fitted curve.
    struct End {
        var id: String
        /// Index into the pass's own deduplicated curve list — the
        /// JavaScript's object identity.
        var curveIndex: Int
        var side: Int
        var p: Coordinate
        var outward: (x: Double, y: Double)
        var trainIds: Set<String>
        var nodeKey: String?
    }

    /// A plausible endpoint pair, before the one-to-one selection.
    struct Candidate {
        var a: End
        var b: End
        var metres: Double
        var turn: Double
        var sharedTrains: Int
        var matchKind: String
        var score: Double
    }

    /// `owners`: fitted curve → the groups that reference it, deduplicated by
    /// curve identity in the order `groupInfo` is iterated.
    ///
    /// Curves of fewer than four points are not owned by anything: the whole
    /// pass is below its own floor there, including the endpoint collector,
    /// which would otherwise read a three-point curve's first and third vertex
    /// as a corridor.
    static func indexStationJoinCurveOwners(curves: [CurveEntry], groups: [Group])
        -> (order: [Int], owners: [[Int]])
    {
        var order: [Int] = []
        var owners: [[Int]] = []
        var slotOf: [Int: Int] = [:]
        for (groupIndex, group) in groups.enumerated() {
            guard let curveIndex = group.curveIndex, curveIndex < curves.count,
                curves[curveIndex].curve.pts.count >= 4
            else { continue }
            if let slot = slotOf[curveIndex] {
                owners[slot].append(groupIndex)
            } else {
                slotOf[curveIndex] = order.count
                order.append(curveIndex)
                owners.append([groupIndex])
            }
        }
        return (order, owners)
    }

    /// `ends`: one descriptor per curve endpoint carrying its outward tangent,
    /// its member ride ids and its snapped node key.
    static func collectStationJoinEndpoints(
        curves: [CurveEntry], order: [Int], owners: [[Int]], groups: [Group]
    ) -> [End] {
        var ends: [End] = []
        for (slot, curveIndex) in order.enumerated() {
            let curve = curves[curveIndex].curve
            var trainIds = Set<String>()
            var endpointNodeKeys: [String?]?
            for groupIndex in owners[slot] {
                for id in groups[groupIndex].trainIds { trainIds.insert(id) }
                // `!endpointNodeKeys` in the JavaScript, and an empty array is
                // truthy there: the first owner that HAS the property wins,
                // even when its value is empty.
                if endpointNodeKeys == nil, let keys = groups[groupIndex].endpointNodeKeys {
                    endpointNodeKeys = keys
                }
            }
            for side in 0...1 {
                let p = side == 0 ? curve.pts[0] : curve.pts[curve.pts.count - 1]
                let probeM = Swift.min(450, Swift.max(100, curve.totalMeters * 0.03))
                guard
                    let q = fittedCurvePointAt(
                        curve, side == 0 ? probeM : curve.totalMeters - probeM)
                else { continue }
                let cs = or(JSMath.cos((p.lat * .pi) / 180), 1e-6)
                let dx = (q.lon - p.lon) * cs
                let dy = q.lat - p.lat
                let len = JSMath.hypot(dx, dy)
                if len < 1e-12 { continue }
                var nodeKey: String?
                if let keys = endpointNodeKeys, side < keys.count { nodeKey = keys[side] }
                ends.append(
                    End(
                        id: "\(slot)::\(side)", curveIndex: slot, side: side, p: p,
                        outward: (x: dx / len, y: dy / len), trainIds: trainIds,
                        nodeKey: nodeKey))
            }
        }
        return ends
    }

    /// `candidates`: plausible endpoint pairs, best first.
    static func pairStationJoinCandidates(_ ends: [End]) -> [Candidate] {
        var candidates: [Candidate] = []
        for i in 0..<ends.count {
            for j in (i + 1)..<ends.count {
                let a = ends[i]
                let b = ends[j]
                if a.curveIndex == b.curveIndex { continue }
                var sharedTrains = 0
                for id in a.trainIds where b.trainIds.contains(id) { sharedTrains += 1 }
                if sharedTrains == 0 { continue }
                let metres = Geometry.distanceMeters(a.p, b.p)
                let continuationDot = Swift.max(
                    -1,
                    Swift.min(1, -(a.outward.x * b.outward.x + a.outward.y * b.outward.y)))
                let turn = acos(continuationDot)
                // An empty string is falsy in JavaScript, so a blank node key
                // is not an identity match with another blank one.
                let exactNode =
                    !(a.nodeKey ?? "").isEmpty && !(b.nodeKey ?? "").isEmpty
                    && a.nodeKey == b.nodeKey
                // Stable snapped-node identity selects the station first;
                // geometry then rejects only an implausible fold. When ids are
                // missing or line-specific nodes differ, retain the
                // deliberately conservative geometric fallback.
                if exactNode {
                    if metres > 120 || turn > (90 * Double.pi) / 180 { continue }
                } else {
                    if metres > 120 || turn > (60 * Double.pi) / 180 { continue }
                    if metres > 40 && turn > (25 * Double.pi) / 180 { continue }
                }
                candidates.append(
                    Candidate(
                        a: a, b: b, metres: metres, turn: turn, sharedTrains: sharedTrains,
                        matchKind: exactNode ? "node-id" : "geometry",
                        score: (exactNode ? -1_000_000 : 0) + turn * 1200 + metres
                            - Double(Swift.min(5, sharedTrains)) * 4))
            }
        }
        return OverlapLanes.stableSorted(candidates) { $0.score < $1.score }
    }

    /// `selectOneToOneEndpointPairs` (app-overlap-lanes.js §245) at this call
    /// site.
    ///
    /// The JavaScript function is generic over anything with `a.id`, `b.id`
    /// and `score`; ``OverlapLanes/selectOneToOneEndpointPairs(sortedCandidates:ambiguityMargin:)``
    /// is the same function specialised to a corridor ``OverlapLanes/Join``,
    /// and this is it specialised to a ``Candidate``. Unifying them means one
    /// generic over a protocol both conform to, which is an edit to §3 rather
    /// than an addition to it.
    ///
    /// Both layers build paths, not branch graphs: once one endpoint wins a
    /// candidate, no second curve may attach to it. `ambiguityMargin` drops an
    /// endpoint entirely when its two best candidates are within that margin
    /// of one another.
    static func selectOneToOneStationJoinPairs(
        _ sortedCandidates: [Candidate], ambiguityMargin: Double
    ) -> [Candidate] {
        var byEnd = OverlapLanes.OrderedMap<[Candidate]>()
        for candidate in sortedCandidates {
            for id in [candidate.a.id, candidate.b.id] {
                byEnd[id] = (byEnd[id] ?? []) + [candidate]
            }
        }
        var ambiguous = Set<String>()
        if ambiguityMargin > 0 {
            for (id, list) in byEnd.entries {
                let sorted = OverlapLanes.stableSorted(list) { $0.score < $1.score }
                if sorted.count > 1 && sorted[1].score - sorted[0].score <= ambiguityMargin {
                    ambiguous.insert(id)
                }
            }
        }
        var used = Set<String>()
        var selected: [Candidate] = []
        for candidate in sortedCandidates {
            if ambiguous.contains(candidate.a.id) || ambiguous.contains(candidate.b.id)
                || used.contains(candidate.a.id) || used.contains(candidate.b.id)
            { continue }
            used.insert(candidate.a.id)
            used.insert(candidate.b.id)
            selected.append(candidate)
        }
        return selected
    }

    /// One accepted connection, as seen from one side of one curve.
    struct Edge {
        /// The endpoint on the OTHER curve.
        var end: End
        var meta: Candidate
    }

    /// `connections`: curve → side → the accepted partner. Greedy one-to-one
    /// selection keeps a fork from claiming both sides.
    static func buildStationJoinConnections(_ candidates: [Candidate]) -> [Int: [Int: Edge]] {
        var connections: [Int: [Int: Edge]] = [:]
        for candidate in selectOneToOneStationJoinPairs(
            candidates, ambiguityMargin: ambiguityMargin)
        {
            connections[candidate.a.curveIndex, default: [:]][candidate.a.side] = Edge(
                end: candidate.b, meta: candidate)
            connections[candidate.b.curveIndex, default: [:]][candidate.b.side] = Edge(
                end: candidate.a, meta: candidate)
        }
        return connections
    }

    /// One member of a station-continuous chain.
    struct ChainMember {
        var curveIndex: Int
        /// Whether this curve's points are traversed backwards, so that the
        /// connected endpoint becomes the start of its oriented points.
        var reverse: Bool
    }

    /// `components`: station-continuous chains, each an ordered list starting
    /// from a degree-1 end.
    ///
    /// A cycle is marked visited and never emitted. That is deliberate: a ring
    /// needs a periodic solver, and cutting it at an arbitrary edge to feed
    /// the open-chain smoother would put a seam somewhere the map does not
    /// have one.
    static func walkStationJoinChains(curveCount: Int, connections: [Int: [Int: Edge]])
        -> [[ChainMember]]
    {
        var visited = Set<Int>()
        var components: [[ChainMember]] = []
        func walk(_ start: Int, _ reverseStart: Bool) {
            var component: [ChainMember] = []
            var curve: Int? = start
            var reverse = reverseStart
            while let current = curve, !visited.contains(current) {
                visited.insert(current)
                component.append(ChainMember(curveIndex: current, reverse: reverse))
                let exitSide = reverse ? 0 : 1
                guard let edge = connections[current]?[exitSide],
                    !visited.contains(edge.end.curveIndex)
                else { break }
                curve = edge.end.curveIndex
                // Entering native side 1 means the next curve must be reversed
                // so that this connected endpoint becomes the start of its
                // oriented points.
                reverse = edge.end.side == 1
            }
            if component.count > 1 { components.append(component) }
        }
        for slot in 0..<curveCount {
            if visited.contains(slot) { continue }
            guard let sides = connections[slot], sides.count == 1 else { continue }
            walk(slot, sides.keys.first! == 0)
        }
        // A cycle needs a periodic solver. Do not silently cut it at an
        // arbitrary edge and feed it to the open-chain station smoother.
        // (`visited` is local to the JavaScript function too, so this marking
        // changes nothing observable; it is kept because removing it would
        // make the next reader wonder where the cycle guard went.)
        for slot in 0..<curveCount where !visited.contains(slot) && connections[slot] != nil {
            visited.insert(slot)
        }
        return components
    }

    /// One chain's concatenated `source` polyline, plus the join diagnostics
    /// the failure report and the accepted curve's stamps are built from.
    static func concatStationJoinComponentSource(
        _ component: [ChainMember], curves: [CurveEntry], order: [Int],
        connections: [Int: [Int: Edge]]
    ) -> (source: [Coordinate], joinEdges: [JoinEdge], worstTurn: Double, worstGap: Double) {
        var source: [Coordinate] = []
        var worstOriginalTurn = 0.0
        var worstGap = 0.0
        var joinEdges: [JoinEdge] = []
        for (index, member) in component.enumerated() {
            let own = curves[order[member.curveIndex]].curve.pts
            let pts = member.reverse ? own.reversed().map { $0 } : own
            for p in pts {
                if source.isEmpty
                    || Geometry.distanceMeters(source[source.count - 1], p) > 0.05
                {
                    source.append(p)
                }
            }
            if index < component.count - 1 {
                let exitSide = member.reverse ? 0 : 1
                if let edge = connections[member.curveIndex]?[exitSide] {
                    worstOriginalTurn = Swift.max(worstOriginalTurn, edge.meta.turn)
                    worstGap = Swift.max(worstGap, edge.meta.metres)
                    joinEdges.append(
                        JoinEdge(
                            a: edge.meta.a.p, b: edge.meta.b.p,
                            gapM: toFixedNumber(edge.meta.metres, 1),
                            turnDeg: toFixedNumber((edge.meta.turn * 180) / .pi, 2),
                            matchKind: edge.meta.matchKind,
                            nodeKey: edge.meta.matchKind == "node-id"
                                ? edge.meta.a.nodeKey : nil))
                }
            }
        }
        return (source, joinEdges, worstOriginalTurn, worstGap)
    }

    /// The accept/reject verdict on a fitted chain.
    ///
    /// A folded or looping component can be geometrically unable to satisfy
    /// both the requested radius and the deviation budget as one
    /// station-continuous curve. Keep its already-valid member splines
    /// separate instead of replacing them with a tighter or far-away curve.
    /// The exception is a candidate whose ONLY shortfall is the geometric
    /// minimum radius, down to ``radiusRelax`` × requested: continuity wins
    /// there.
    static func stationJoinConstraintReport(_ fitted: JoinedCurve)
        -> (radiusOk: Bool, deviationOk: Bool, directionOk: Bool, radiusRelaxed: Bool)
    {
        let curve = fitted.curve
        let radiusOk = !(
            curve.achievedMinRadiusMeters != nil
                && curve.achievedMinRadiusMeters! < curve.requestedMinRadiusMeters * 0.999
        )
        let deviationOk = !(
            curve.maxDeviationMeters > 0
                && (!fitted.finalDeviationValid
                    || curve.actualMaxDeviationMeters > curve.maxDeviationMeters)
        )
        let directionOk =
            fitted.finalDirectionValid
            && !(
                curve.achievedDirectionRadiusMeters != nil
                    && curve.achievedDirectionRadiusMeters!
                        < curve.requestedMinRadiusMeters * 0.999
            )
        let radiusRelaxed =
            !radiusOk && deviationOk && directionOk
            && (curve.achievedMinRadiusMeters ?? 0)
                >= curve.requestedMinRadiusMeters * radiusRelax
        return (radiusOk, deviationOk, directionOk, radiusRelaxed)
    }

    // MARK: - The pass

    /// `smoothCurveStationJoins`: build the direction field across station
    /// boundaries as one continuous corridor.
    ///
    /// A membership change still remains a separate hover group, but it no
    /// longer forces the fitted direction curve to stop at the station. The
    /// straightest compatible continuation wins at junctions; then the
    /// complete multi-group chain is fitted once, making every former station
    /// boundary an interior C2 point instead of two independently pinned
    /// endpoints.
    public static func smoothCurveStationJoins(curves: [CurveEntry], groups: [Group])
        -> Outcome
    {
        var outcome = Outcome(
            joined: [],
            groupCurve: groups.map { $0.curveIndex.map { CurveRef.input($0) } ?? .none },
            groupFailure: [Int?](repeating: nil, count: groups.count), failures: [],
            roundedJoins: 0)
        guard groups.count >= 2 else { return outcome }

        let (order, owners) = indexStationJoinCurveOwners(curves: curves, groups: groups)
        let ends = collectStationJoinEndpoints(
            curves: curves, order: order, owners: owners, groups: groups)
        let candidates = pairStationJoinCandidates(ends)
        let connections = buildStationJoinConnections(candidates)
        let components = walkStationJoinChains(
            curveCount: order.count, connections: connections)

        for component in components {
            let concatenated = concatStationJoinComponentSource(
                component, curves: curves, order: order, connections: connections)
            if concatenated.source.count < 4 { continue }
            var rawSources: [[Coordinate]] = []
            for member in component {
                rawSources.append(contentsOf: curves[order[member.curveIndex]].sourceLines)
            }

            func markFailure(_ reason: String, _ candidate: JoinedCurve?) {
                let failure = Failure(
                    reason: reason, joins: concatenated.joinEdges,
                    groupKeys: component.flatMap { member in
                        owners[member.curveIndex].map { groups[$0].groupKey }
                    },
                    requestedMinRadiusM: candidate.map {
                        JSNumber.round(or($0.curve.requestedMinRadiusMeters, 0))
                    },
                    achievedMinRadiusM: candidate?.curve.achievedMinRadiusMeters.map {
                        JSNumber.round($0)
                    },
                    maxDeviationM: candidate.map {
                        JSNumber.round(or($0.curve.maxDeviationMeters, 0))
                    },
                    actualMaxDeviationM: candidate.map {
                        JSNumber.round($0.curve.actualMaxDeviationMeters)
                    })
                let index = outcome.failures.count
                for member in component {
                    for groupIndex in owners[member.curveIndex] {
                        outcome.groupFailure[groupIndex] = index
                    }
                }
                outcome.failures.append(failure)
            }

            guard
                var fitted = smoothJoinedStationCurve(
                    source: concatenated.source,
                    template: curves[order[component[0].curveIndex]].curve,
                    sourceLines: rawSources)
            else {
                markFailure("solver", nil)
                continue
            }
            let report = stationJoinConstraintReport(fitted)
            if !(report.radiusOk || report.radiusRelaxed) || !report.deviationOk
                || !report.directionOk
            {
                var reasons: [String] = []
                if !report.radiusOk && !report.radiusRelaxed { reasons.append("radius") }
                if !report.deviationOk { reasons.append("deviation") }
                if !report.directionOk { reasons.append("direction") }
                markFailure(reasons.isEmpty ? "unknown" : reasons.joined(separator: "+"), fitted)
                continue
            }
            if report.radiusRelaxed {
                fitted.stationJoinRadiusRelaxed = true
                fitted.acceptedMinRadiusMeters =
                    fitted.curve.requestedMinRadiusMeters * radiusRelax
            }
            fitted.stationJoinCount = component.count - 1
            fitted.stationJoinOriginalMaxDeg = toFixedNumber(
                (concatenated.worstTurn * 180) / .pi, 2)
            fitted.stationJoinMaxGapMeters = toFixedNumber(concatenated.worstGap, 1)
            fitted.stationJoinIdMatchedCount = concatenated.joinEdges.filter {
                $0.matchKind == "node-id"
            }.count
            fitted.curve.fitType = "cubic-bspline-c2-station-continuous"
            let joinedIndex = outcome.joined.count
            outcome.joined.append(fitted)
            for member in component {
                for groupIndex in owners[member.curveIndex] {
                    outcome.groupCurve[groupIndex] = .joined(joinedIndex)
                }
            }
            outcome.roundedJoins += component.count - 1
        }
        return outcome
    }
}
