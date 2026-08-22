import Foundation

/// Parallel-offset overlap lanes: how several rides sharing one corridor are
/// drawn side by side instead of on top of each other.
///
/// Ported from `app/public/app-overlap-lanes.js` and
/// `app/public/app-deck-records.js`. They are one file here because they are
/// one thing there: the record builder calls the corridor solver, and the
/// corridor solver's chain walker is called back out of the record builder's
/// component pass. Sixteen symbols cross between the two JavaScript files, so
/// splitting them in Swift would move the cycle rather than remove it.
///
/// ## What the machinery is for
///
/// When N rides are drawn on the same metres of track, drawing them at their
/// true positions draws one line and hides N−1 rides. The answer is not to
/// permanently fan them out — that would put every line off its own railway —
/// but to leave the visible ink on the true track and give each ride an
/// invisible **pick lane** beside it, so the pointer can reach any of the N.
/// Hovering one then translates every member's *complete course* rigidly
/// sideways, corners and lengths intact.
///
/// Everything in this file exists to answer four questions about that:
///
///   1. which drawn segments are shared, and by whom
///      (``buildOverlapMap(items:lines:rank:)``);
///   2. which lane each ride takes on each of its segments, and where the
///      shared stretch starts and ends
///      (``assignSegmentOverlapLanes(overlap:orig:segKeys:trainId:noPick:)``,
///      ``maximalOverlapRuns(segIdentity:nSeg:)``);
///   3. which direction "sideways" is, consistently along a whole corridor
///      even where the track curves or two rides traverse it opposite ways
///      (the corridor stitching pass, and ``smoothCorridorCurve(_:settings:)``);
///   4. what the renderer is finally handed
///      (``buildRouteRecords(items:lines:overlap:snap:rank:spacingPx:settings:)``).
///
/// ## What is NOT here, and where the seam is
///
/// `smoothCurveStationJoins` — the pass that rounds the shared endpoints where
/// two corridor curves meet at a station, with `refreshFittedCurveGeometry`
/// and `rebuildLimitedDirectionField` — is **not ported**. It runs after the
/// corridor phase below and assigns `gi.curve` and nothing else, so every
/// other field this file produces is the JavaScript's final value. Measured on
/// the Tokyo scenario in `port-fixtures/overlap-lanes.json`: it replaces the
/// curve of 9 of 17 groups, typically a 20-point per-run fit by a 210-point
/// re-fit of the concatenated source. ``Corridor/curve`` is therefore the
/// pre-join curve, and a later port picks up exactly there.
///
/// Also deliberately absent, because they are not behaviour:
///
///   * the four signature-keyed caches and their FIFO eviction. They answer
///     what the builders answer; a cache is not a port.
///   * the fitted-curve memo in front of ``smoothCorridorCurve(_:settings:)``.
///     Its contents are never observable — the JavaScript hands out a deep
///     clone precisely so they cannot be.
///   * the Worker path (`scheduleFitCurveWorker`). It computes the same
///     corridor fit somewhere else.
///   * the marker records (`buildDeckMarkerRecords`, `deckMarkerRecord` and
///     the computed pass-through cache, `app-deck-records.js` §1348-1590).
///     They flatten stops into scatterplot records and share nothing with the
///     lane machinery but the file they live in.
///   * everything that reads a colour, an opacity or a locale. Those belong to
///     the style and i18n tiers; what this file needs of them arrives as the
///     ``Item/drawn``, ``Item/recordDrawn``, ``Item/noPick`` and
///     ``Item/strokeWidth`` inputs.
public enum OverlapLanes {

    // MARK: - Tuning constants
    //
    // All five live in `app-route-simplify.js` rather than in either ported
    // file, because that is the one leaf both the page and the fit worker
    // load. Each is overridable from the query string in the browser
    // (`?snap=`, `?nearoverlap=`, `?bridge=`, `?join=`); the values here are
    // the defaults, which is what a device build ships with.

    /// Metres per degree of longitude **at the equator** — callers multiply by
    /// cos(latitude) themselves.
    static let metresPerDegreeLon = 111_320.0
    /// Metres per degree of latitude (spherical mean).
    static let metresPerDegreeLat = 110_540.0

    /// How far apart two route vertices may be and still be canonicalised to
    /// one representative before overlap keys are built. Deliberately
    /// sub-track-width: it absorbs graph-coordinate jitter and nothing else,
    /// so genuinely parallel tracks stay separate.
    public static let snapMeters = 2.5

    /// Two *different* alignments closer than this, running the same way, form
    /// one interaction corridor — the conventional line beside the Shinkansen.
    /// Physical and zoom-independent on purpose: it describes track-to-track
    /// separation, not screen pixels.
    public static let nearParallelMeters = 120.0

    /// A short single-ride sliver interrupting an otherwise identical sharing
    /// set is re-attached to it rather than breaking the run in three.
    public static let bridgeMaxMeters = 140.0

    /// How far apart two corridor-run endpoints may be and still be treated as
    /// one join. Much shorter than a station-to-station section, and it
    /// additionally requires matching membership and tangent continuity.
    public static let corridorJoinMeters = 120.0

    /// cos(20°): the bound on how far two segments' headings may diverge and
    /// still count as parallel.
    ///
    /// `JSMath/cos(_:)` rather than the platform's, for the reason every
    /// cosine and every `hypot` in this file is V8's: measured over the 9,942
    /// real latitudes these two scenarios project at, Darwin's `cos` disagrees
    /// with V8's on 308 of them (3.1 %, worst 1 ULP), and swapping this file
    /// over to the platform's functions moves 6 corridor shift axes (`cos`) or
    /// 30-odd of them plus every fitted arc-length table (`hypot`). This
    /// particular number is compared against a dot product to decide whether
    /// two railways fan together at all.
    static let nearParallelCos = JSMath.cos((20 * Double.pi) / 180)

    /// `ROUTE_SORT_TIER`: the line-sort-key stride between the dimmed
    /// (off-date) tier and the active one. Only has to exceed the train count.
    static let routeSortTier = 1_000_000.0

    // MARK: - Inputs

    /// One drawn line of one ride, as the record builder receives it.
    ///
    /// `orig` is the **normalised** geometry — `iterateGeometryLines` maps
    /// every vertex through `normalizeGraphCoord`, so these are already on the
    /// 5-decimal grid (``Grid/normalizeGraphCoord(_:)``). Overlap detection
    /// works on `segKeys`, which are built from the *snapped* endpoints;
    /// drawing works on `orig`. Neither can fragment the other.
    public struct RouteLine: Sendable {
        public var orig: [Coordinate]
        /// Ascending original indices Douglas–Peucker kept, or `nil` for "all".
        ///
        /// Always `nil` in the shipped app: `ROUTE_SIMPLIFY_METERS` is 0, so
        /// the simplifier is bypassed entirely and the only reason it is still
        /// in the pipeline is its index mapping. The `nil` handling is ported
        /// anyway because the merge below is what a non-zero epsilon would
        /// exercise, and a port that assumed `nil` would be silently wrong the
        /// day the constant moves.
        public var keepIdx: [Int]?
        public var segKeys: [String]

        public init(orig: [Coordinate], keepIdx: [Int]? = nil, segKeys: [String]) {
            self.orig = orig
            self.keepIdx = keepIdx
            self.segKeys = segKeys
        }
    }

    /// One `(ride, matched route feature)` pair — the app's `{ train, feature }`
    /// route item, reduced to what the lane machinery reads of it.
    public struct Item: Sendable {
        public var trainId: String

        /// `deckOverlapItemDrawn(item)`: would this item produce a DRAWN
        /// record? Anything invisible must not occupy a lane slot or inflate
        /// the ×N count, or the fan and the pick corridor get phantom gaps.
        ///
        /// An input rather than a computation because the predicate reads the
        /// style tier (`routeSegmentStyleValues`), the ride-category toggles
        /// (`riddenFeatureVisible`) and the date scope — three subsystems this
        /// file otherwise has no dependency on.
        public var drawn: Bool

        /// The record builder's own, slightly *wider*, filter.
        ///
        /// Not the same predicate, and the difference is load-bearing: an
        /// off-date ride is excluded from the overlap map (`drawn == false`)
        /// but still DRAWS, dimmed, while a concrete day is selected. So
        /// `drawn` decides lane membership and `recordDrawn` decides whether
        /// any record is emitted at all.
        public var recordDrawn: Bool

        /// `scopeFlags.dimmed`: off-date rides draw but are not interactive —
        /// no hover, no tooltip, no click-select, and no lane.
        public var noPick: Bool

        /// The drawn stroke width in pixels, which only reaches this file
        /// through the unshared segments' pick width.
        public var strokeWidth: Double

        /// The item's geometry, one array per line of a (Multi)LineString,
        /// **before** normalisation.
        public var geometry: [[Coordinate]]

        public init(
            trainId: String,
            drawn: Bool,
            recordDrawn: Bool,
            noPick: Bool,
            strokeWidth: Double,
            geometry: [[Coordinate]]
        ) {
            self.trainId = trainId
            self.drawn = drawn
            self.recordDrawn = recordDrawn
            self.noPick = noPick
            self.strokeWidth = strokeWidth
            self.geometry = geometry
        }
    }

    // MARK: - Ordering primitives
    //
    // Several of the structures below are JavaScript `Map`s and `Set`s that
    // are iterated, and JavaScript iterates them in INSERTION order. Three
    // answers in this file are decided by that order and by nothing else — the
    // canonical corridor direction (which end of a chain the walk starts
    // from), which sharing-set instance a signature interns to, and the order
    // pick bridges are emitted in — so a Swift `Dictionary`, whose iteration
    // order is unspecified and seed-dependent, cannot stand in for one.

    /// A `Map` with JavaScript's iteration order: first insertion wins the
    /// position, and re-assigning an existing key does not move it.
    struct OrderedMap<Value> {
        private(set) var keys: [String] = []
        private(set) var values: [Value] = []
        private var positions: [String: Int] = [:]

        var count: Int { keys.count }

        subscript(key: String) -> Value? {
            get {
                guard let index = positions[key] else { return nil }
                return values[index]
            }
            set {
                guard let newValue else {
                    // `Map#delete`, which DOES vacate the position.
                    guard let index = positions.removeValue(forKey: key) else { return }
                    keys.remove(at: index)
                    values.remove(at: index)
                    for i in index..<keys.count { positions[keys[i]] = i }
                    return
                }
                if let index = positions[key] {
                    values[index] = newValue
                } else {
                    positions[key] = keys.count
                    keys.append(key)
                    values.append(newValue)
                }
            }
        }

        func contains(_ key: String) -> Bool { positions[key] != nil }

        /// `(key, value)` pairs in insertion order.
        var entries: [(key: String, value: Value)] {
            (0..<keys.count).map { (keys[$0], values[$0]) }
        }
    }

    /// A `Set<String>` with JavaScript's iteration order.
    struct OrderedSet {
        private(set) var order: [String] = []
        private(set) var members: Set<String> = []

        init() {}
        init(_ elements: [String]) { for element in elements { insert(element) } }

        var count: Int { order.count }
        func contains(_ element: String) -> Bool { members.contains(element) }

        mutating func insert(_ element: String) {
            if members.insert(element).inserted { order.append(element) }
        }

        /// `[...set].sort().join("\0")` — the membership signature the
        /// JavaScript compares sets by. `sort()` with no comparator sorts by
        /// UTF-16 code unit, which is what ``jsSorted(_:)`` reproduces.
        var signature: String { jsSorted(order).joined(separator: "\u{0}") }
    }

    /// JavaScript's `<` between two strings: UTF-16 code unit order, not
    /// Swift's canonical ordering. Used everywhere a groupKey or a segment key
    /// is minimised or sorted, all of which are persisted-format decisions.
    static func jsLess(_ a: String, _ b: String) -> Bool {
        a != b && JSNumber.stringLessOrEqual(a, b)
    }

    /// `Array.prototype.sort()` with no comparator, over strings.
    static func jsSorted(_ values: [String]) -> [String] {
        stableSorted(values) { jsLess($0, $1) }
    }

    /// A stable sort, because `Array.prototype.sort` is one and `Array.sort()`
    /// is not.
    ///
    /// This is not hypothetical here. The corridor endpoint candidates are
    /// sorted by a `score` that two symmetric joins at one station reach
    /// identically, and greedy one-to-one pairing then consumes them in
    /// order — so which of two equal-scoring candidates is taken decides which
    /// runs end up in the same corridor.
    static func stableSorted<T>(_ values: [T], by areInIncreasingOrder: (T, T) -> Bool) -> [T] {
        values.enumerated()
            .sorted { left, right in
                if areInIncreasingOrder(left.element, right.element) { return true }
                if areInIncreasingOrder(right.element, left.element) { return false }
                return left.offset < right.offset
            }
            .map(\.element)
    }

    // MARK: - §0 the shared vertex canonicaliser
    //
    // `refreshRouteVertexSnap` / `getRouteLinePairs` live in
    // app-route-simplify.js, not in either file this port is named for. They
    // are here because the overlap map cannot be computed without them and
    // nothing has ported them yet: every segment key the map is built on is
    // the key of a SNAPPED pair, and a port that keyed on raw coordinates
    // would fragment every corridor into single-ride slivers. When
    // app-route-simplify.js is ported in full, these two move there.
    //
    // Not ported with them: the signature guard that decides whether to
    // rebuild, and the per-coordinate memo. Both are caches — the JavaScript
    // says so in as many words ("canon() is pure for a given cell set: a
    // repeat call always found the representative the first call registered").

    /// The canonical representative of each route vertex's ~`snapMeters`
    /// neighbourhood. The first vertex seen in a neighbourhood becomes its
    /// representative, which makes the answer a function of item order.
    public struct VertexSnap: Sendable {
        private var cells: [Int: [Coordinate]] = [:]
        private let tolerance: Double
        private let tolerance2: Double
        /// A stable Japan-wide longitude grid. Deliberately NOT latitude-
        /// scaled: multiplying absolute longitude by a latitude-dependent
        /// scale moves the grid itself as latitude changes, and can put two
        /// sub-metre neighbours several cells apart.
        private let gridLon = 80_000.0
        private let enabled: Bool

        init(tolerance: Double) {
            self.tolerance = tolerance > 0 ? tolerance : 0
            self.tolerance2 = self.tolerance * self.tolerance
            self.enabled = self.tolerance > 0
        }

        /// The numeric cell key. The JavaScript packs both axes into one
        /// integer and falls back to a string key if a pathologically fine
        /// tolerance could make the packing alias; at the shipped 2.5 m it
        /// cannot, and the fallback is unreachable.
        private static let gySpan = 1 << 26
        private static let gyHalf = gySpan >> 1
        private static func cellKey(_ gx: Int, _ gy: Int) -> Int {
            gx * gySpan + (gy + gyHalf)
        }

        /// Registers `coordinate`'s neighbourhood if it is new, and returns the
        /// representative either way.
        @discardableResult
        mutating func canonical(_ coordinate: Coordinate) -> Coordinate {
            guard enabled else { return coordinate }
            let gx = Int((coordinate.lon * gridLon / tolerance).rounded(.down))
            let gy = Int((coordinate.lat * metresPerDegreeLat / tolerance).rounded(.down))
            // The longitude→metre scale is fixed for this query's latitude, so
            // the cosine is taken once here rather than once per candidate.
            // The dx span is ±2 because north of ~44° a cell is narrower than
            // the tolerance, so a within-tolerance match can sit two cells
            // away. The squared test is the exact equivalent of `hypot <= tol`.
            let mx = JSMath.cos((coordinate.lat * .pi) / 180) * metresPerDegreeLon
            for dx in -2...2 {
                for dy in -1...1 {
                    guard let bucket = cells[Self.cellKey(gx + dx, gy + dy)] else { continue }
                    for candidate in bucket {
                        let ex = (coordinate.lon - candidate.lon) * mx
                        let ey = (coordinate.lat - candidate.lat) * metresPerDegreeLat
                        if ex * ex + ey * ey <= tolerance2 { return candidate }
                    }
                }
            }
            cells[Self.cellKey(gx, gy), default: []].append(coordinate)
            return coordinate
        }

        /// Read-only lookup, for callers that only ask.
        ///
        /// Every coordinate the overlap machinery asks about was registered by
        /// the build pass, so this always finds a representative; the mutating
        /// form is what registers. Written as a separate entry point because
        /// `overlapNodeKey` is called from six places that have no business
        /// growing the canonical set.
        public func lookup(_ coordinate: Coordinate) -> Coordinate {
            guard enabled else { return coordinate }
            let gx = Int((coordinate.lon * gridLon / tolerance).rounded(.down))
            let gy = Int((coordinate.lat * metresPerDegreeLat / tolerance).rounded(.down))
            let mx = JSMath.cos((coordinate.lat * .pi) / 180) * metresPerDegreeLon
            for dx in -2...2 {
                for dy in -1...1 {
                    guard let bucket = cells[Self.cellKey(gx + dx, gy + dy)] else { continue }
                    for candidate in bucket {
                        let ex = (coordinate.lon - candidate.lon) * mx
                        let ey = (coordinate.lat - candidate.lat) * metresPerDegreeLat
                        if ex * ex + ey * ey <= tolerance2 { return candidate }
                    }
                }
            }
            return coordinate
        }

        /// `overlapNodeKey`: the corridor-node identity of a coordinate,
        /// snapped so it matches the node keys embedded in segment keys.
        ///
        /// Use this — never the raw ``Grid/coordKey(_:)`` — anywhere a
        /// coordinate is compared ACROSS rides as an overlap node. Raw
        /// coordinates stay for drawn geometry and shift vectors.
        public func nodeKey(_ coordinate: Coordinate) -> String {
            Grid.coordKey(lookup(coordinate))
        }
    }

    /// Builds the snap over every item's geometry, in item order, and then the
    /// per-line segment keys — `getRouteLinePairs` for the whole item list.
    ///
    /// Two details from the JavaScript survive verbatim. The snap registers
    /// EVERY item's vertices, drawn or not, because it is a property of the
    /// geometry set rather than of what is visible. And a segment whose two
    /// ends collapse onto one representative keeps its *true* coordinates, so
    /// its key cannot degenerate to `"P|P"`.
    public static func routeLines(for items: [Item]) -> (snap: VertexSnap, lines: [[RouteLine]]) {
        var snap = VertexSnap(tolerance: snapMeters)
        let normalised = items.map { item in
            item.geometry.map { line in line.map(Grid.normalizeGraphCoord) }
        }
        for lines in normalised {
            for line in lines {
                for coordinate in line { snap.canonical(coordinate) }
            }
        }
        let built = normalised.map { lines in
            lines.map { orig -> RouteLine in
                let snapped = orig.map { snap.lookup($0) }
                var segKeys: [String] = []
                segKeys.reserveCapacity(Swift.max(0, orig.count - 1))
                for i in 0..<Swift.max(0, orig.count - 1) {
                    var a = orig[i]
                    var b = orig[i + 1]
                    if snapped[i] != snapped[i + 1] {
                        a = snapped[i]
                        b = snapped[i + 1]
                    }
                    segKeys.append(Grid.routeCoordinateSegmentKey(a, b))
                }
                // `ROUTE_SIMPLIFY_METERS` is 0, so `douglasPeuckerIndices` is
                // never called and `keepIdx` is always null.
                return RouteLine(orig: orig, keepIdx: nil, segKeys: segKeys)
            }
        }
        return (snap, built)
    }

    // MARK: - §1 the overlap map

    /// One sharing set: which rides are on one original segment.
    ///
    /// `order` is the JavaScript `Set`'s insertion order and is observable —
    /// `attachCorridorPickBridges` walks `Object.keys(gi.mults)`, which is
    /// this order. `signature` is what interning collapses on.
    public struct SharedSet: Sendable {
        public var order: [String]
        public var members: Set<String>
        public var signature: String
        /// The ids in date order, which is what a lane slot is an index into.
        public var byRank: [String]

        public var count: Int { order.count }
        public func slot(of trainId: String) -> Int {
            // `Math.max(0, ordered.indexOf(tid))`: an id that is not a member
            // answers slot 0 rather than −1.
            Swift.max(0, byRank.firstIndex(of: trainId) ?? -1)
        }
    }

    /// Near-parallel interaction group diagnostics, surfaced to the renderer's
    /// debug overlay.
    public struct NearParallelInfo: Sendable, Equatable {
        public var pairCount: Int
        public var maxSeparationMeters: Double
        public var thresholdMeters: Double
    }

    /// The corridor graph: what `buildDeckOverlapMap` returns, as data rather
    /// than as a closure bundle.
    public struct OverlapMap: Sendable {
        /// Every original segment key, in first-seen order.
        public var segmentKeys: [String]
        /// Segment key → index into ``sharedSets``. Absent = unshared, which is
        /// the JavaScript's `null` from `idsForKey`.
        public var sharedIndexByKey: [String: Int]
        public var sharedSets: [SharedSet]
        /// Segment key → near-parallel interaction key, when it has one.
        public var nearGroupByKey: [String: String]
        public var nearMaxByGroup: [String: Double]
        public var nearPairCount: Int
        /// Segment key → the canonical FROM node key of the corridor walk.
        public var segFrom: [String: String]

        /// The sharing set of one original segment, or `nil` when it is not
        /// shared. Below two rides there is no lane to assign.
        public func ids(for key: String) -> SharedSet? {
            guard let index = sharedIndexByKey[key] else { return nil }
            return sharedSets[index]
        }

        /// The *identity* of a sharing set, which is what run boundaries are
        /// computed from. Two segments belong to one run exactly when this is
        /// equal for both — the JavaScript compares `Set` instances, which
        /// `internSharedTrainIdSets` has made one per distinct membership.
        public func sharedIdentity(for key: String) -> Int? { sharedIndexByKey[key] }

        public func groupKey(for key: String) -> String { nearGroupByKey[key] ?? key }

        public func nearGroupInfo(_ groupKey: String) -> NearParallelInfo? {
            guard groupKey.hasPrefix("near:") else { return nil }
            return NearParallelInfo(
                pairCount: nearPairCount,
                maxSeparationMeters: nearMaxByGroup[groupKey] ?? 0,
                thresholdMeters: nearParallelMeters
            )
        }

        /// +1 when traversing `key` starting from the vertex whose node key is
        /// `fromKey` runs WITH the corridor's canonical direction.
        public func direction(for key: String, from fromKey: String) -> Double {
            guard let from = segFrom[key] else { return 1 }
            return from == fromKey ? 1 : -1
        }
    }

    /// `buildDeckOverlapTrainRank`: ride id → lane slot order.
    ///
    /// Slots are by DATE (earliest first, then departure, then id) so parallel
    /// pick lanes read left→right in chronological order and a ride keeps the
    /// same lane along a whole shared stretch. The comparator itself is
    /// ``Dates/compareByDateAndDeparture(_:_:undatedValue:)``, already ported;
    /// here it arrives as a caller-supplied order so this file does not have
    /// to carry the ride model.
    public static func trainRank(uniqueTrainIdsInDateOrder ids: [String]) -> [String: Int] {
        var rank: [String: Int] = [:]
        for (index, id) in ids.enumerated() where rank[id] == nil { rank[id] = index }
        return rank
    }

    /// Five passes, each named for the intermediate product it yields:
    ///
    ///     seg / segmentGeometry   raw sharing sets + endpoint geometry
    ///     near groups             parallel-track fanning
    ///     (in place)              interning: set identity == run id
    ///     segFrom                 the canonical lane normal
    ///
    /// `rank` is `buildDeckOverlapTrainRank`'s answer — see
    /// ``trainRank(uniqueTrainIdsInDateOrder:)``.
    public static func buildOverlapMap(
        items: [Item], lines: [[RouteLine]], rank: [String: Int]
    ) -> OverlapMap {
        // ── seg + segmentGeometry ──
        var seg = OrderedMap<OrderedSet>()
        var geometryByKey = OrderedMap<(a: Coordinate, b: Coordinate)>()
        for (itemIndex, item) in items.enumerated() {
            guard !item.trainId.isEmpty, item.drawn else { continue }
            for line in lines[itemIndex] {
                for i in 0..<line.segKeys.count {
                    let key = line.segKeys[i]
                    var ids = seg[key] ?? OrderedSet()
                    ids.insert(item.trainId)
                    seg[key] = ids
                    if !geometryByKey.contains(key) {
                        geometryByKey[key] = (line.orig[i], line.orig[i + 1])
                    }
                }
            }
        }

        // ── near-parallel groups (writes back into seg) ──
        let pairs = collectNearParallelSegmentPairs(seg: seg, geometry: geometryByKey)
        let near = groupNearParallelSegmentPairs(seg: &seg, pairs: pairs)

        // ── interning ──
        // ONE canonical set per distinct membership, so the record builder can
        // detect run boundaries by identity: a corridor stays a single run
        // however many original segments long it is. Single-ride segments are
        // skipped, as in the JavaScript — they are never surfaced, so interning
        // them was pure throwaway allocation in the most expensive rebuild.
        var sharedSets: [SharedSet] = []
        var indexBySignature: [String: Int] = [:]
        var sharedIndexByKey: [String: Int] = [:]
        for (key, ids) in seg.entries {
            guard ids.count >= 2 else { continue }
            let signature = ids.signature
            if let existing = indexBySignature[signature] {
                sharedIndexByKey[key] = existing
                continue
            }
            let ordered = stableSorted(ids.order) { (rank[$0] ?? 0) < (rank[$1] ?? 0) }
            sharedSets.append(
                SharedSet(
                    order: ids.order, members: ids.members, signature: signature,
                    byRank: ordered))
            indexBySignature[signature] = sharedSets.count - 1
            sharedIndexByKey[key] = sharedSets.count - 1
        }

        return OverlapMap(
            segmentKeys: seg.keys,
            sharedIndexByKey: sharedIndexByKey,
            sharedSets: sharedSets,
            nearGroupByKey: near.groupByKey,
            nearMaxByGroup: near.maxByGroup,
            nearPairCount: near.pairCount,
            segFrom: buildCorridorDirectionIndex(seg: seg)
        )
    }

    // MARK: near-parallel candidate pairs

    struct NearParallelPair {
        var a: String
        var b: String
        var separation: Double
    }

    /// Candidate near-parallel segment pairs — the raw material for adding
    /// different-but-parallel tracks to the overlap graph.
    ///
    /// A metre grid keeps this near O(n): each segment is compared only with
    /// geometries whose bounding boxes enter the same neighbourhood, and the
    /// bucket keys are numeric for the same reason the vertex snap's are — the
    /// discarded `"gx,gy"` strings dominated this scan on a full-country store.
    static func collectNearParallelSegmentPairs(
        seg: OrderedMap<OrderedSet>, geometry: OrderedMap<(a: Coordinate, b: Coordinate)>
    ) -> [NearParallelPair] {
        var pairs: [NearParallelPair] = []
        guard nearParallelMeters > 0, geometry.count > 1 else { return pairs }
        let cellM = Swift.max(20, nearParallelMeters)
        let bucketSpan = 1 << 22
        let bucketHalf = bucketSpan >> 1
        func bucketKey(_ gx: Int, _ gy: Int) -> Int { gx * bucketSpan + (gy + bucketHalf) }

        struct Descriptor {
            var key: String
            var a: Coordinate
            var b: Coordinate
            var minX = 0.0, maxX = 0.0, minY = 0.0, maxY = 0.0
        }
        // Do the two segments share a ride? A route must never overlap itself
        // at a loop, a siding or a tight station throat. Walks the smaller set.
        func intersects(_ a: OrderedSet, _ b: OrderedSet) -> Bool {
            let small = a.count <= b.count ? a : b
            let large = a.count <= b.count ? b : a
            for id in small.order where large.contains(id) { return true }
            return false
        }

        var buckets: [Int: [Int]] = [:]
        var descriptors = geometry.entries.map { Descriptor(key: $0.key, a: $0.value.a, b: $0.value.b) }
        for index in descriptors.indices {
            var d = descriptors[index]
            let ax = d.a.lon * 80_000
            let ay = d.a.lat * metresPerDegreeLat
            let bx = d.b.lon * 80_000
            let by = d.b.lat * metresPerDegreeLat
            d.minX = Swift.min(ax, bx)
            d.maxX = Swift.max(ax, bx)
            d.minY = Swift.min(ay, by)
            d.maxY = Swift.max(ay, by)
            descriptors[index] = d

            let qx0 = Int(((d.minX - nearParallelMeters) / cellM).rounded(.down))
            let qx1 = Int(((d.maxX + nearParallelMeters) / cellM).rounded(.down))
            let qy0 = Int(((d.minY - nearParallelMeters) / cellM).rounded(.down))
            let qy1 = Int(((d.maxY + nearParallelMeters) / cellM).rounded(.down))
            var checked = Set<String>()
            for gx in qx0...qx1 {
                for gy in qy0...qy1 {
                    guard let list = buckets[bucketKey(gx, gy)] else { continue }
                    for otherIndex in list {
                        let other = descriptors[otherIndex]
                        if checked.contains(other.key) { continue }
                        checked.insert(other.key)
                        guard let aIds = seg[d.key], let bIds = seg[other.key] else { continue }
                        if intersects(aIds, bIds) { continue }
                        guard
                            let separation = nearParallelSegmentSeparation(
                                d.a, d.b, other.a, other.b, maxMeters: nearParallelMeters)
                        else { continue }
                        pairs.append(
                            NearParallelPair(a: d.key, b: other.key, separation: separation))
                    }
                }
            }
            let ix0 = Int((d.minX / cellM).rounded(.down))
            let ix1 = Int((d.maxX / cellM).rounded(.down))
            let iy0 = Int((d.minY / cellM).rounded(.down))
            let iy1 = Int((d.maxY / cellM).rounded(.down))
            for gx in ix0...ix1 {
                for gy in iy0...iy1 { buckets[bucketKey(gx, gy), default: []].append(index) }
            }
        }
        return pairs
    }

    /// The separation of two genuinely side-by-side segments, or `nil` when
    /// they merely cross, point towards one another, or have no longitudinal
    /// overlap.
    ///
    /// From `app-route-simplify.js`. The endpoint-minimum test that suggests
    /// itself classifies a shallow fork as parallel, because the two segments
    /// touch at the junction; this measures the shared span at interior
    /// positions in BOTH segment frames instead, so a diverging pair fails the
    /// maximum and median tests even when its minimum separation is exactly
    /// zero.
    static func nearParallelSegmentSeparation(
        _ a0: Coordinate, _ a1: Coordinate, _ b0: Coordinate, _ b1: Coordinate,
        maxMeters: Double
    ) -> Double? {
        let lat = (a0.lat + a1.lat + b0.lat + b1.lat) / 4
        let cosine = JSMath.cos((lat * .pi) / 180)
        let sx = metresPerDegreeLon * (cosine == 0 ? 1e-6 : cosine)
        // Historical, and deliberately kept: latitude shares the longitude
        // scale here, exactly as in `douglasPeuckerIndices`.
        let sy = 111_320.0
        let ax = a0.lon * sx, ay = a0.lat * sy
        let bx = a1.lon * sx, by = a1.lat * sy
        let cx = b0.lon * sx, cy = b0.lat * sy
        let dx = b1.lon * sx, dy = b1.lat * sy
        let avx = bx - ax, avy = by - ay
        let bvx = dx - cx, bvy = dy - cy
        let al = JSMath.hypot(avx, avy)
        let bl = JSMath.hypot(bvx, bvy)
        if al < 1 || bl < 1 { return nil }
        let aux = avx / al, auy = avy / al
        let bux = bvx / bl, buy = bvy / bl
        if abs(aux * bux + auy * buy) < nearParallelCos { return nil }

        // Both projection tests are required: they reject two collinear
        // segments whose endpoints are close but whose actual intervals do not
        // run beside one another.
        let bProj0 = (cx - ax) * aux + (cy - ay) * auy
        let bProj1 = (dx - ax) * aux + (dy - ay) * auy
        let overlapA =
            Swift.min(al, Swift.max(bProj0, bProj1))
            - Swift.max(0, Swift.min(bProj0, bProj1))
        let aProj0 = (ax - cx) * bux + (ay - cy) * buy
        let aProj1 = (bx - cx) * bux + (by - cy) * buy
        let overlapB =
            Swift.min(bl, Swift.max(aProj0, aProj1))
            - Swift.max(0, Swift.min(aProj0, aProj1))
        let requiredOverlap = Swift.max(20, Swift.min(al, bl) * 0.2)
        if overlapA < requiredOverlap || overlapB < requiredOverlap { return nil }

        var separations: [Double] = []
        func sample(
            _ ox: Double, _ oy: Double, _ ux: Double, _ uy: Double, _ lo: Double, _ hi: Double,
            _ p0x: Double, _ p0y: Double, _ p1x: Double, _ p1y: Double
        ) {
            for f in [0.25, 0.5, 0.75] {
                let s = lo + (hi - lo) * f
                separations.append(
                    pointSegmentDistanceXY(ox + ux * s, oy + uy * s, p0x, p0y, p1x, p1y))
            }
        }
        sample(
            ax, ay, aux, auy, Swift.max(0, Swift.min(bProj0, bProj1)),
            Swift.min(al, Swift.max(bProj0, bProj1)), cx, cy, dx, dy)
        sample(
            cx, cy, bux, buy, Swift.max(0, Swift.min(aProj0, aProj1)),
            Swift.min(bl, Swift.max(aProj0, aProj1)), ax, ay, bx, by)
        separations.sort()
        let median = separations[separations.count / 2]
        let maximum = separations[separations.count - 1]
        return median <= maxMeters && maximum <= maxMeters * 1.3 ? median : nil
    }

    static func pointSegmentDistanceXY(
        _ px: Double, _ py: Double, _ ax: Double, _ ay: Double, _ bx: Double, _ by: Double
    ) -> Double {
        let dx = bx - ax
        let dy = by - ay
        let len2 = dx * dx + dy * dy
        var t = len2 != 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
        t = Swift.max(0, Swift.min(1, t))
        return JSMath.hypot(px - (ax + t * dx), py - (ay + t * dy))
    }

    /// The near-parallel group index, and the write-back that gives matched
    /// keys a shared membership so JR and Shinkansen rides fan together even
    /// though their raw coordinates differ.
    static func groupNearParallelSegmentPairs(
        seg: inout OrderedMap<OrderedSet>, pairs: [NearParallelPair]
    ) -> (groupByKey: [String: String], maxByGroup: [String: Double], pairCount: Int) {
        var groupByKey: [String: String] = [:]
        var maxByGroup: [String: Double] = [:]
        if pairs.isEmpty { return (groupByKey, maxByGroup, 0) }

        // Expand membership only through DIRECT geometric neighbours. Do not
        // flood ride ids through an entire spatial component: A beside B and B
        // later beside C must not make C appear on A's earlier section.
        var expanded = OrderedMap<OrderedSet>()
        func expandedFor(_ key: String) -> OrderedSet {
            if let existing = expanded[key] { return existing }
            let fresh = seg[key] ?? OrderedSet()
            expanded[key] = fresh
            return fresh
        }
        for pair in pairs {
            var aIds = expandedFor(pair.a)
            var bIds = expandedFor(pair.b)
            for id in (seg[pair.b] ?? OrderedSet()).order { aIds.insert(id) }
            for id in (seg[pair.a] ?? OrderedSet()).order { bIds.insert(id) }
            expanded[pair.a] = aIds
            expanded[pair.b] = bIds
        }
        var signatures: [String: String] = [:]
        for (key, ids) in expanded.entries { signatures[key] = ids.signature }

        // A shared interaction group is valid only when both physical tracks
        // resolve to the same direct membership: that keeps a three-way station
        // throat from transitively merging unrelated lines.
        let validPairs = pairs.filter { signatures[$0.a] == signatures[$0.b] }

        var parent = OrderedMap<String>()
        var componentIds: [String: OrderedSet] = [:]
        func find(_ key: String) -> String {
            var root = key
            while parent[root] != root { root = parent[root]! }
            var current = key
            while parent[current] != current {
                let next = parent[current]!
                parent[current] = root
                current = next
            }
            return root
        }
        func union(_ a: String, _ b: String) -> Bool {
            if !parent.contains(a) {
                parent[a] = a
                componentIds[a] = seg[a] ?? OrderedSet()
            }
            if !parent.contains(b) {
                parent[b] = b
                componentIds[b] = seg[b] ?? OrderedSet()
            }
            let ar = find(a)
            let br = find(b)
            if ar == br { return true }
            var aIds = componentIds[ar] ?? OrderedSet()
            let bIds = componentIds[br] ?? OrderedSet()
            // The direct pair check above prevents a route overlapping itself,
            // but a plain disjoint-set can reintroduce that bug transitively:
            // A↔B and B↔C would merge A with C even when A and C are two
            // branches of one ride. A physical interaction component may
            // contain each ride only once.
            for id in aIds.order where bIds.contains(id) { return false }
            parent[br] = ar
            for id in bIds.order { aIds.insert(id) }
            componentIds[ar] = aIds
            componentIds.removeValue(forKey: br)
            return true
        }
        let acyclicPairs = validPairs.filter { union($0.a, $0.b) }
        var accepted = Set<String>()
        for pair in acyclicPairs {
            accepted.insert(pair.a)
            accepted.insert(pair.b)
        }
        var components = OrderedMap<[String]>()
        for key in parent.keys where accepted.contains(key) {
            let root = find(key)
            components[root] = (components[root] ?? []) + [key]
        }
        for (_, keys) in components.entries {
            let canonical = "near:" + (jsSorted(keys).first ?? "")
            for key in keys {
                seg[key] = expanded[key] ?? seg[key] ?? OrderedSet()
                groupByKey[key] = canonical
            }
        }
        for pair in acyclicPairs {
            guard let group = groupByKey[pair.a] else { continue }
            maxByGroup[group] = Swift.max(maxByGroup[group] ?? 0, pair.separation)
        }
        return (groupByKey, maxByGroup, acyclicPairs.count)
    }

    // MARK: canonical corridor direction

    /// Every ride offsets its lane relative to the SAME reference direction,
    /// or lanes swap sides wherever two rides traverse shared track opposite
    /// ways, or wherever the bearing crosses an axis.
    ///
    /// Overlapped segments form chains; each connected chain is walked once,
    /// orienting every segment away from the walk start so the direction is
    /// continuous through every bend and station. The whole chain is then
    /// flipped if needed so its net direction is east-dominant (north-dominant
    /// for a N–S chain), which with lane normals taken to the right of it puts
    /// slot 0 — the earliest date — in the left/top lane.
    ///
    /// The walk order is the answer: `adjacency` is iterated in insertion
    /// order, the component is collected with a STACK and the orientation is
    /// laid down with a QUEUE, and a degree-1 node is preferred as the start so
    /// a simple chain gets one continuous direction end to end.
    ///
    /// ## It has exactly one consumer, and that consumer never runs
    ///
    /// Measured over the 483 overlap runs of both fixture scenarios: the only
    /// call site of ``OverlapMap/direction(for:from:)`` is the degenerate-chord
    /// fallback in ``corridorRunShiftAxis(overlap:snap:orig:segKeys:ra:rb:)``,
    /// and **no run has a degenerate chord** — not even on the Kaohsiung
    /// circular light rail or the round-island loop, because a run is a stretch
    /// of constant overlap membership and a loop's membership changes before it
    /// closes. So this whole index, rebuilt on every overlap pass, currently
    /// decides nothing.
    ///
    /// It is ported in full anyway, and the fixture pins the direction of every
    /// shared segment from both ends, for the reason the JavaScript keeps it:
    /// the branch it feeds is what stops lanes swapping sides on a corridor
    /// whose two ends coincide, and a port that dropped it would be correct
    /// today and wrong the first time a ride's membership stayed constant
    /// around a whole loop.
    static func buildCorridorDirectionIndex(seg: OrderedMap<OrderedSet>) -> [String: String] {
        var adjacency = OrderedMap<[String]>()
        for (key, ids) in seg.entries {
            guard ids.count >= 2 else { continue }
            for nodeKey in key.components(separatedBy: "|") {
                adjacency[nodeKey] = (adjacency[nodeKey] ?? []) + [key]
            }
        }
        var segFrom: [String: String] = [:]
        func otherEnd(_ segKey: String, _ nodeKey: String) -> String {
            let parts = segKey.components(separatedBy: "|")
            return parts[0] == nodeKey ? parts[1] : parts[0]
        }
        func nodeXY(_ nodeKey: String) -> (x: Double, y: Double) {
            let parts = nodeKey.components(separatedBy: ",")
            return (Double(parts[0]) ?? .nan, Double(parts[1]) ?? .nan)
        }

        var visited = Set<String>()
        for startNode in adjacency.keys {
            if visited.contains(startNode) { continue }
            var compNodes: [String] = []
            var stack = [startNode]
            visited.insert(startNode)
            while let n = stack.popLast() {
                compNodes.append(n)
                for sk in adjacency[n] ?? [] {
                    let o = otherEnd(sk, n)
                    if !visited.contains(o) {
                        visited.insert(o)
                        stack.append(o)
                    }
                }
            }
            let start =
                compNodes.first { (adjacency[$0] ?? []).count == 1 } ?? compNodes[0]

            var compSegs: [String] = []
            var seenNode: Set<String> = [start]
            var queue = [start]
            var head = 0
            while head < queue.count {
                let n = queue[head]
                head += 1
                for sk in adjacency[n] ?? [] {
                    if segFrom[sk] != nil { continue }
                    segFrom[sk] = n
                    compSegs.append(sk)
                    let o = otherEnd(sk, n)
                    if !seenNode.contains(o) {
                        seenNode.insert(o)
                        queue.append(o)
                    }
                }
            }

            var dxSum = 0.0
            var dySum = 0.0
            for sk in compSegs {
                let from = segFrom[sk]!
                let to = otherEnd(sk, from)
                let f = nodeXY(from)
                let t = nodeXY(to)
                dxSum += (t.x - f.x) * JSMath.cos((((f.y + t.y) / 2) * .pi) / 180)
                dySum += t.y - f.y
            }
            let flip = abs(dxSum) >= abs(dySum) ? dxSum < 0 : dySum < 0
            if flip {
                for sk in compSegs { segFrom[sk] = otherEnd(sk, segFrom[sk]!) }
            }
        }
        return segFrom
    }

    // MARK: - §2 per-line lane assignment

    /// One line's per-original-segment lane assignment.
    public struct LaneAssignment: Sendable {
        /// The sharing set's identity per segment, or `nil` when unshared.
        /// Run boundaries are computed from THIS, by equality of identity.
        public var segIdentity: [Int?]
        public var segSlot: [Int]
        public var segMult: [Double]
        /// Which segments were re-attached to a neighbouring sharing set by the
        /// sliver bridge, and must therefore be skipped when the run's
        /// groupKey is minimised.
        public var segBridged: [Bool]
        public var lineHasOverlap: Bool
    }

    /// The sharing set, this ride's lane slot and the signed lane multiplier
    /// (slots centred around the true track), plus the bridged-sliver flags.
    public static func assignSegmentOverlapLanes(
        overlap: OverlapMap, orig: [Coordinate], segKeys: [String], trainId: String,
        noPick: Bool
    ) -> LaneAssignment {
        let nSeg = orig.count - 1
        var segIdentity = [Int?](repeating: nil, count: nSeg)
        var segSlot = [Int](repeating: 0, count: nSeg)
        var segMult = [Double](repeating: 0, count: nSeg)
        var lineHasOverlap = false
        for i in 0..<nSeg {
            // Off-date rides are excluded from the overlap map entirely: even
            // where their track coincides with a same-day shared corridor they
            // stay on the true track — no lane slot, no fan membership.
            guard !noPick, let index = overlap.sharedIdentity(for: segKeys[i]) else { continue }
            let ids = overlap.sharedSets[index]
            lineHasOverlap = true
            segIdentity[i] = index
            segSlot[i] = ids.slot(of: trainId)
            segMult[i] = Double(segSlot[i]) - Double(ids.count - 1) / 2
        }

        // ── bridge hair-thin overlap-key gaps ──
        // A shared corridor interrupted by a SHORT single-ride sliver whose two
        // neighbours carry the identical sharing set is really one continuous
        // corridor: the sliver only lost its key to a micro-vertex difference.
        // Re-attaching it keeps the run one piece, so the fan no longer
        // collapses and reopens as the pointer slides across the sliver.
        // Bridged segments are flagged because their keys are the one place
        // two members of one fan genuinely differ.
        var segBridged = [Bool](repeating: false, count: nSeg)
        if !noPick {
            var i = 0
            while i < nSeg {
                if segIdentity[i] != nil {
                    i += 1
                    continue
                }
                var j = i
                while j < nSeg && segIdentity[j] == nil { j += 1 }  // gap spans [i, j)
                let before = i > 0 ? segIdentity[i - 1] : nil
                let after = j < nSeg ? segIdentity[j] : nil
                if let before, before == after {
                    var gapM = 0.0
                    for k in i..<j { gapM += Geometry.distanceMeters(orig[k], orig[k + 1]) }
                    if gapM <= bridgeMaxMeters {
                        let ids = overlap.sharedSets[before]
                        let slot = ids.slot(of: trainId)
                        let mult = Double(slot) - Double(ids.count - 1) / 2
                        for k in i..<j {
                            segIdentity[k] = before
                            segSlot[k] = slot
                            segMult[k] = mult
                            segBridged[k] = true
                        }
                        lineHasOverlap = true
                    }
                }
                i = j
            }
        }
        return LaneAssignment(
            segIdentity: segIdentity, segSlot: segSlot, segMult: segMult,
            segBridged: segBridged, lineHasOverlap: lineHasOverlap)
    }

    /// `runs` — maximal stretches of constant overlap membership.
    ///
    /// The comparison is on set IDENTITY, which interning made one instance per
    /// distinct membership, so run boundaries coincide EXACTLY across all
    /// sharing rides and so do the groupKeys derived from them. Each run spans
    /// original vertices `[a … b]`.
    public static func maximalOverlapRuns(segIdentity: [Int?], nSeg: Int) -> [(a: Int, b: Int)] {
        var runs: [(a: Int, b: Int)] = []
        var a = 0
        for i in 1..<Swift.max(1, nSeg) where segIdentity[i] != segIdentity[a] {
            runs.append((a, i))
            a = i
        }
        runs.append((a, nSeg))
        return runs
    }

    /// The drawn vertex subset: the Douglas–Peucker subset plus the exact run
    /// boundaries, the original-index → drawn-position map the run slicer
    /// needs, and the drawn length in metres.
    public static func buildDrawnVertexSubset(
        orig: [Coordinate], keepIdx: [Int]?, runs: [(a: Int, b: Int)], nSeg: Int
    ) -> (drawn: [Coordinate], posOf: [Int: Int], drawnLen: Double) {
        let drawnIdx = mergeDrawnIndices(keepIdx: keepIdx, runs: runs, nSeg: nSeg, extraIdx: nil)
        var drawn: [Coordinate] = []
        var posOf: [Int: Int] = [:]
        drawn.reserveCapacity(drawnIdx.count)
        for (k, index) in drawnIdx.enumerated() {
            drawn.append(orig[index])
            posOf[index] = k
        }
        var drawnLen = 0.0
        for k in 1..<Swift.max(1, drawn.count) {
            drawnLen += Geometry.distanceMeters(drawn[k - 1], drawn[k])
        }
        return (drawn, posOf, drawnLen)
    }

    /// Merges the simplifier's kept indices with the run boundaries, keeping
    /// both sorted and de-duplicated in one pass.
    static func mergeDrawnIndices(
        keepIdx: [Int]?, runs: [(a: Int, b: Int)], nSeg: Int, extraIdx: [Int]?
    ) -> [Int] {
        guard let keepIdx else { return Array(0...nSeg) }
        var boundary = Set<Int>()
        for run in runs {
            boundary.insert(run.a)
            boundary.insert(run.b)
        }
        if let extraIdx { for index in extraIdx { boundary.insert(index) } }
        let extras = boundary.sorted()
        var out: [Int] = []
        var i = 0
        var j = 0
        while i < keepIdx.count || j < extras.count {
            let ki = i < keepIdx.count ? keepIdx[i] : Int.max
            let ej = j < extras.count ? extras[j] : Int.max
            if ki <= ej {
                out.append(ki)
                i += 1
                if ki == ej { j += 1 }
            } else {
                out.append(ej)
                j += 1
            }
        }
        return out
    }

    /// `groupKey` — the run's interaction key, identical for every ride sharing
    /// it whichever way each traverses the track and however each geometry was
    /// simplified.
    ///
    /// The smallest original segment key in the run, over NATIVELY shared
    /// segments only: a bridged sliver carries this ride's own key, which
    /// differs across members, so including it could hand two members different
    /// groupKeys and split one fan in two. Every bridged run still contains its
    /// shared flank segments, so a real key is always found — the fallback loop
    /// exists for the case that cannot arise.
    public static func canonicalRunGroupKey(
        overlap: OverlapMap, segKeys: [String], segBridged: [Bool], ra: Int, rb: Int
    ) -> String {
        var groupKey = ""
        for i in ra..<rb where !segBridged[i] {
            let interactionKey = overlap.groupKey(for: segKeys[i])
            if groupKey.isEmpty || jsLess(interactionKey, groupKey) { groupKey = interactionKey }
        }
        if groupKey.isEmpty {
            groupKey = overlap.groupKey(for: segKeys[ra])
            for i in (ra + 1)..<rb {
                let interactionKey = overlap.groupKey(for: segKeys[i])
                if jsLess(interactionKey, groupKey) { groupKey = interactionKey }
            }
        }
        return groupKey
    }

    /// The run's shift AXIS: reference latitude plus the canonically oriented
    /// chord the group's unit shift is taken perpendicular to.
    ///
    /// The chord joins the run's start and end points — a straight
    /// station-to-station line — so the whole fan translates along ONE axis no
    /// matter where the pointer hovers or how the track curves in between. It
    /// is canonically oriented (lexicographic endpoint order) so every sharing
    /// ride derives the identical vector, and `sx` is pre-divided by
    /// cos(latRef) so the shift spans the same PIXEL distance at any heading.
    public static func corridorRunShiftAxis(
        overlap: OverlapMap, snap: VertexSnap, orig: [Coordinate], segKeys: [String],
        ra: Int, rb: Int
    ) -> (latRef: Double, coslatRef: Double, dx: Double, dy: Double, len: Double) {
        var latSum = 0.0
        for i in ra..<rb { latSum += (orig[i].lat + orig[i + 1].lat) / 2 }
        let latRef = latSum / Double(rb - ra)
        let cosine = JSMath.cos((latRef * .pi) / 180)
        let coslatRef = cosine == 0 ? 1e-6 : cosine
        var pa = orig[ra]
        var pb = orig[rb]
        if pb.lon < pa.lon || (pb.lon == pa.lon && pb.lat < pa.lat) { swap(&pa, &pb) }
        var dx = (pb.lon - pa.lon) * coslatRef
        var dy = pb.lat - pa.lat
        var len = JSMath.hypot(dx, dy)
        if len < 1e-9 {
            // Degenerate chord — the run starts and ends at the same station,
            // which is what a loop does. Fall back to the canonical dominant
            // direction, which is the whole reason `segFrom` exists.
            //
            // Measured: 0 of 483 real runs reach this. See
            // ``buildCorridorDirectionIndex(seg:)``.
            dx = 0
            dy = 0
            for i in ra..<rb {
                let d = overlap.direction(for: segKeys[i], from: snap.nodeKey(orig[i]))
                let latMid = (orig[i].lat + orig[i + 1].lat) / 2
                let c = JSMath.cos((latMid * .pi) / 180)
                let coslat = c == 0 ? 1e-6 : c
                dx += (orig[i + 1].lon - orig[i].lon) * coslat * d
                dy += (orig[i + 1].lat - orig[i].lat) * d
            }
            len = JSMath.hypot(dx, dy)
            if len == 0 { len = 1 }
        }
        return (latRef, coslatRef, dx, dy, len)
    }

    // MARK: - §3 corridor stitching

    /// One end of one corridor run.
    public struct Endpoint: Sendable {
        public var id: String
        public var key: String
        public var side: Int
        public var p: Coordinate
        public var out: (x: Double, y: Double)
        public var sig: String
        /// Recorded by `matchCorridorEndpointJoins` and read by nothing. Kept
        /// because it is part of the endpoint record the JavaScript builds, and
        /// removing it would be a silent change to a structure a later port of
        /// the station-join pass may read.
        public var nearParallel: Bool
    }

    /// A selected join between two run ends.
    public struct Join: Sendable {
        public var a: Endpoint
        public var b: Endpoint
        public var metres: Double
        public var score: Double
    }

    /// The invisible pick path across one corridor join, so sliding the pointer
    /// over a run boundary inside one fan never loses the hit.
    public struct PickBridge: Sendable {
        public var path: [Coordinate]
        public var trainId: String
        /// Index of that ride's first record in the corridor.
        public var recordIndex: Int
        public var laneMult: Double
        public var pickWidth: Double
    }

    /// `groupInfo`'s value: one interaction group, before and after stitching.
    public struct Corridor: Sendable {
        public var sx: Double
        public var sy: Double
        /// Ride id → slot-centred lane multiplier, in the sharing set's own
        /// insertion order — which is the order pick bridges come out in.
        public var mults: [(trainId: String, mult: Double)]
        /// The group's representative geometry.
        public var line: [Coordinate]
        /// Every distinct run line seen for this interaction key. A near-
        /// parallel key can be met on more than one physical run, so they are
        /// kept apart here and joined by ``rebuildGroupRepresentativeGeometry``.
        public var lines: [[Coordinate]]
        public var pa: Coordinate
        public var pb: Coordinate
        public var latRef: Double
        public var signature: String
        public var curveEndpointNodeKeys: [String]
        public var nearParallel: NearParallelInfo?
        public var corridorJoins: [Join]
        public var pickBridges: [PickBridge]
        /// The fitted corridor centreline, **before** the unported station-join
        /// pass. See the type's documentation.
        public var curve: FittedCurve?

        public func mult(of trainId: String) -> Double? {
            mults.first { $0.trainId == trainId }?.mult
        }
    }

    /// Both corridor stitching layers build paths, not branch graphs: once one
    /// endpoint wins a candidate, no second curve may attach to it.
    ///
    /// `ambiguityMargin` drops an endpoint entirely when its two best
    /// candidates are within that margin of one another — a fork whose two
    /// prongs are equally plausible joins to nothing rather than to the one
    /// that happened to sort first.
    static func selectOneToOneEndpointPairs(
        sortedCandidates: [Join], ambiguityMargin: Double = 0
    ) -> [Join] {
        var byEnd = OrderedMap<[Join]>()
        for candidate in sortedCandidates {
            for id in [candidate.a.id, candidate.b.id] {
                byEnd[id] = (byEnd[id] ?? []) + [candidate]
            }
        }
        var ambiguous = Set<String>()
        if ambiguityMargin > 0 {
            for (id, list) in byEnd.entries {
                let sorted = stableSorted(list) { $0.score < $1.score }
                if sorted.count > 1 && sorted[1].score - sorted[0].score <= ambiguityMargin {
                    ambiguous.insert(id)
                }
            }
        }
        var used = Set<String>()
        var selected: [Join] = []
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

    /// The outward unit tangent at one end of a run line.
    static func corridorEndpointOutward(line: [Coordinate], side: Int) -> (x: Double, y: Double)? {
        guard line.count >= 2 else { return nil }
        let a = side == 0 ? line[0] : line[line.count - 1]
        let b = side == 0 ? line[1] : line[line.count - 2]
        let c = JSMath.cos((((a.lat + b.lat) / 2) * .pi) / 180)
        let cs = c == 0 ? 1e-6 : c
        let dx = (a.lon - b.lon) * cs
        let dy = a.lat - b.lat
        let len = JSMath.hypot(dx, dy)
        return len > 0 ? (dx / len, dy / len) : nil
    }

    /// Two loose run ends may be the same corridor join even when their
    /// coordinates do not literally touch. Besides distance, the two outward
    /// tangents must FACE one another along the missing interval, so nearby
    /// parallel tracks and real forks are not glued together.
    static func corridorEndpointPair(_ a: Endpoint, _ b: Endpoint) -> (metres: Double, score: Double)? {
        if a.key == b.key || a.sig != b.sig { return nil }
        let metres = Geometry.distanceMeters(a.p, b.p)
        if metres > corridorJoinMeters { return nil }
        let facing = -(a.out.x * b.out.x + a.out.y * b.out.y)
        // A shared coordinate is not sufficient at a junction — several
        // branches can snap to the same station node — so the tangent check
        // stays, relaxed, even at zero gap. Without it greedy pairing connects
        // perpendicular platform throats.
        if metres <= snapMeters {
            if facing < 0.35 { return nil }
            return (metres, metres + (1 - facing) * 40)
        }
        let lat = (a.p.lat + b.p.lat) / 2
        let c = JSMath.cos((lat * .pi) / 180)
        let cs = c == 0 ? 1e-6 : c
        let gx = (b.p.lon - a.p.lon) * cs
        let gy = b.p.lat - a.p.lat
        var gl = JSMath.hypot(gx, gy)
        if gl == 0 { gl = 1 }
        let ux = gx / gl
        let uy = gy / gl
        let aAlong = a.out.x * ux + a.out.y * uy
        let bAlong = b.out.x * ux + b.out.y * uy
        if aAlong < 0.35 || bAlong > -0.35 || facing < 0.55 { return nil }
        return (metres, metres * (1 + (1 - facing) + (1 - aAlong) + (1 + bAlong)))
    }

    /// Walks a component through its selected endpoint joins.
    ///
    /// Both gap endpoints are retained in the chain, so its arc length stays
    /// continuous across source-feature seams without changing visible
    /// geometry. Returns `nil` when nothing continuable could be assembled.
    static func buildCorridorChain(
        keys: [String], keySet: Set<String>, joins: [Join],
        lineFor: (String) -> [Coordinate]?
    ) -> [Coordinate]? {
        var byKey = OrderedMap<[Int]>()
        for (index, join) in joins.enumerated() {
            guard keySet.contains(join.a.key), keySet.contains(join.b.key) else { continue }
            for k in [join.a.key, join.b.key] { byKey[k] = (byKey[k] ?? []) + [index] }
        }
        let startKey = keys.first { (byKey[$0] ?? []).count < 2 } ?? keys[0]
        let startJoins = byKey[startKey] ?? []
        var fromSide = 0
        if startJoins.count == 1 {
            let join = joins[startJoins[0]]
            fromSide = 1 - (join.a.key == startKey ? join.a.side : join.b.side)
        }
        var unused = Set(keys)
        var usedJoins = Set<Int>()
        var chain: [Coordinate] = []
        var key: String? = startKey
        while let current = key, unused.contains(current) {
            unused.remove(current)
            guard var line = lineFor(current), line.count >= 2 else { break }
            if fromSide == 1 { line.reverse() }
            for point in line {
                if chain.isEmpty || Geometry.distanceMeters(chain[chain.count - 1], point) > 0.05 {
                    chain.append(point)
                }
            }
            let endSide = 1 - fromSide
            let nextJoin = (byKey[current] ?? []).first { index in
                if usedJoins.contains(index) { return false }
                let join = joins[index]
                let end = join.a.key == current ? join.a : join.b
                return end.side == endSide
            }
            guard let nextIndex = nextJoin else { break }
            usedJoins.insert(nextIndex)
            let join = joins[nextIndex]
            let nextEnd = join.a.key == current ? join.b : join.a
            key = nextEnd.key
            fromSide = nextEnd.side
        }
        return chain.count >= 2 ? chain : nil
    }

    /// Each group's representative geometry, and every direction-dependent
    /// field rebuilt from it.
    ///
    /// One near-parallel interaction key may be met on several physical runs.
    /// Only unambiguous end-to-end continuations are joined, the longest
    /// resulting chain wins, and parallel alternatives stay alternatives — a
    /// sequential fragment becomes part of one complete anchor instead of being
    /// silently discarded.
    static func rebuildGroupRepresentativeGeometry(_ corridor: inout Corridor) {
        let lines = corridor.lines.filter { $0.count >= 2 }
        guard !lines.isEmpty else { return }
        var tempKeys: [String] = []
        var tempLines: [String: [Coordinate]] = [:]
        var endpoints: [Endpoint] = []
        for (index, line) in lines.enumerated() {
            let key = "representative:\(index)"
            tempKeys.append(key)
            tempLines[key] = line
            for side in 0...1 {
                guard let out = corridorEndpointOutward(line: line, side: side) else { continue }
                endpoints.append(
                    Endpoint(
                        id: "\(key)::\(side)", key: key, side: side,
                        p: side == 0 ? line[0] : line[line.count - 1],
                        out: out, sig: "representative", nearParallel: false))
            }
        }
        var candidates: [Join] = []
        for i in 0..<endpoints.count {
            for j in (i + 1)..<endpoints.count {
                guard let match = corridorEndpointPair(endpoints[i], endpoints[j]) else { continue }
                candidates.append(
                    Join(a: endpoints[i], b: endpoints[j], metres: match.metres, score: match.score))
            }
        }
        candidates = stableSorted(candidates) { $0.score < $1.score }
        let joins = selectOneToOneEndpointPairs(sortedCandidates: candidates, ambiguityMargin: 8)

        var parent: [String: String] = [:]
        for key in tempKeys { parent[key] = key }
        func find(_ key: String) -> String {
            var root = key
            while parent[root] != root { root = parent[root]! }
            var current = key
            while parent[current] != current {
                let next = parent[current]!
                parent[current] = root
                current = next
            }
            return root
        }
        for join in joins { parent[find(join.b.key)] = find(join.a.key) }
        var components = OrderedMap<[String]>()
        for key in tempKeys {
            let root = find(key)
            components[root] = (components[root] ?? []) + [key]
        }
        func lineLength(_ line: [Coordinate]) -> Double {
            var length = 0.0
            for i in 1..<Swift.max(1, line.count) {
                length += Geometry.distanceMeters(line[i - 1], line[i])
            }
            return length
        }
        var representative = lines[0]
        var representativeLength = lineLength(representative)
        for (_, keys) in components.entries {
            let keySet = Set(keys)
            let componentJoins = joins.filter { keySet.contains($0.a.key) && keySet.contains($0.b.key) }
            var candidate: [Coordinate]? = nil
            if keys.count > 1 && componentJoins.count < keys.count {
                candidate = buildCorridorChain(
                    keys: keys, keySet: keySet, joins: componentJoins,
                    lineFor: { tempLines[$0] })
            }
            if candidate == nil {
                for key in keys {
                    let line = tempLines[key]!
                    if candidate == nil || lineLength(line) > lineLength(candidate!) {
                        candidate = line
                    }
                }
            }
            let length = lineLength(candidate!)
            if length > representativeLength {
                representative = candidate!
                representativeLength = length
            }
        }

        var latitudeSum = 0.0
        var latitudeCount = 0
        for i in 1..<Swift.max(1, representative.count) {
            latitudeSum += (representative[i - 1].lat + representative[i].lat) / 2
            latitudeCount += 1
        }
        let latRef = latitudeCount > 0 ? latitudeSum / Double(latitudeCount) : representative[0].lat
        let c = JSMath.cos((latRef * .pi) / 180)
        let coslat = c == 0 ? 1e-6 : c
        var pa = representative[0]
        var pb = representative[representative.count - 1]
        if pb.lon < pa.lon || (pb.lon == pa.lon && pb.lat < pa.lat) { swap(&pa, &pb) }
        var dx = (pb.lon - pa.lon) * coslat
        var dy = pb.lat - pa.lat
        var length = JSMath.hypot(dx, dy)
        if length < 1e-9 {
            // A closed representative has no chord. Take its longest segment
            // instead, canonically oriented the same way the chord would be.
            var longest = 0.0
            for i in 1..<Swift.max(1, representative.count) {
                var sx = (representative[i].lon - representative[i - 1].lon) * coslat
                var sy = representative[i].lat - representative[i - 1].lat
                let segmentLength = JSMath.hypot(sx, sy)
                if segmentLength <= longest { continue }
                if sx < 0 || (sx == 0 && sy < 0) {
                    sx = -sx
                    sy = -sy
                }
                longest = segmentLength
                dx = sx
                dy = sy
            }
            length = JSMath.hypot(dx, dy)
            if length == 0 { length = 1 }
        }
        corridor.line = representative
        corridor.pa = representative[0]
        corridor.pb = representative[representative.count - 1]
        corridor.latRef = latRef
        corridor.sx = dy / length / coslat
        corridor.sy = -dx / length
    }

    /// `joins` — one geometrically continuous partner per run endpoint.
    ///
    /// The membership signature is the bucket key candidates are matched
    /// within: only runs whose member-ride sets are identical may join. Then
    /// proximity as well as snapped identity closes feature seams, and greedy
    /// one-to-one pairing keeps a nearby fork out of the chain.
    static func matchCorridorEndpointJoins(_ groupInfo: inout OrderedMap<Corridor>) -> [Join] {
        for key in groupInfo.keys {
            var corridor = groupInfo[key]!
            corridor.signature = jsSorted(corridor.mults.map(\.trainId)).joined(separator: "|")
            groupInfo[key] = corridor
        }
        var endpoints: [Endpoint] = []
        for (key, gi) in groupInfo.entries {
            for (side, p) in [(0, gi.pa), (1, gi.pb)] {
                guard let out = corridorEndpointOutward(line: gi.line, side: side) else { continue }
                endpoints.append(
                    Endpoint(
                        id: "\(key)::\(side)", key: key, side: side, p: p, out: out,
                        sig: gi.signature, nearParallel: gi.nearParallel != nil))
            }
        }
        let cellDeg = Swift.max(1e-6, corridorJoinMeters / 80_000)
        var buckets: [String: [Int]] = [:]
        var candidates: [Join] = []
        for (index, end) in endpoints.enumerated() {
            let gx = Int((end.p.lon / cellDeg).rounded(.down))
            let gy = Int((end.p.lat / cellDeg).rounded(.down))
            for dx in -2...2 {
                for dy in -1...1 {
                    guard let list = buckets["\(end.sig)::\(gx + dx),\(gy + dy)"] else { continue }
                    for otherIndex in list {
                        let other = endpoints[otherIndex]
                        guard let match = corridorEndpointPair(other, end) else { continue }
                        candidates.append(
                            Join(a: other, b: end, metres: match.metres, score: match.score))
                    }
                }
            }
            buckets["\(end.sig)::\(gx),\(gy)", default: []].append(index)
        }
        candidates = stableSorted(candidates) { $0.score < $1.score }
        return selectOneToOneEndpointPairs(sortedCandidates: candidates, ambiguityMargin: 8)
    }

    /// One contiguous corridor: its member keys, its mean reference latitude
    /// and its endpoint degrees, so the corridor's global start and end are the
    /// endpoints touched by exactly one run.
    struct Component {
        var keys: [String] = []
        var keySet: Set<String> = []
        var endpoints = OrderedMap<(p: Coordinate, n: Int)>()
        var latSum = 0.0
        var n = 0
    }

    static func buildCorridorComponents(
        groupInfo: OrderedMap<Corridor>, joins: [Join], snap: VertexSnap
    ) -> OrderedMap<Component> {
        var parent: [String: String] = [:]
        func find(_ key: String) -> String {
            var root = key
            while parent[root] != root { root = parent[root]! }
            var current = key
            while parent[current] != current {
                let next = parent[current]!
                parent[current] = root
                current = next
            }
            return root
        }
        for key in groupInfo.keys { parent[key] = key }
        for join in joins { parent[find(join.a.key)] = find(join.b.key) }

        var components = OrderedMap<Component>()
        for (key, gi) in groupInfo.entries {
            let root = find(key)
            var component = components[root] ?? Component()
            component.keys.append(key)
            component.keySet.insert(key)
            component.latSum += gi.latRef
            component.n += 1
            for p in [gi.pa, gi.pb] {
                let ck = snap.nodeKey(p)
                if let existing = component.endpoints[ck] {
                    component.endpoints[ck] = (existing.p, existing.n + 1)
                } else {
                    component.endpoints[ck] = (p, 1)
                }
            }
            components[root] = component
        }
        return components
    }

    /// One contiguous corridor's UNIFIED shift axis — the perpendicular of the
    /// straight line joining the corridor's overall start and end, so hovering
    /// anywhere along it fans along the same axis.
    ///
    /// `nil` keeps the per-run chords: a closed loop has no degree-1 ends, and
    /// a degenerate chord has no direction.
    static func unifiedCorridorShiftAxis(_ c: Component) -> (sx: Double, sy: Double)? {
        var ends: [Coordinate] = []
        for (_, e) in c.endpoints.entries where e.n == 1 { ends.append(e.p) }
        if ends.count < 2 { return nil }
        let cosine = JSMath.cos(((c.latSum / Double(c.n)) * .pi) / 180)
        let coslat = cosine == 0 ? 1e-6 : cosine
        // The FARTHEST pair of degree-1 endpoints is the corridor's start and
        // end stations, which stays right even if a branch leaves more than two
        // loose ends.
        var pa = ends[0]
        var pb = ends[1]
        var best = -1.0
        for i in 0..<ends.count {
            for j in (i + 1)..<ends.count {
                let ddx = (ends[j].lon - ends[i].lon) * coslat
                let ddy = ends[j].lat - ends[i].lat
                let d2 = ddx * ddx + ddy * ddy
                if d2 > best {
                    best = d2
                    pa = ends[i]
                    pb = ends[j]
                }
            }
        }
        if pb.lon < pa.lon || (pb.lon == pa.lon && pb.lat < pa.lat) { swap(&pa, &pb) }
        let dx = (pb.lon - pa.lon) * coslat
        let dy = pb.lat - pa.lat
        let len = JSMath.hypot(dx, dy)
        if len < 1e-9 { return nil }
        return (dy / len / coslat, -dx / len)
    }

    // MARK: - §4 the corridor fit
    //
    // A genuinely smooth physical-distance fit for the hover fan. The source
    // polyline is only an ANCHOR: controls may leave it by `maxDeviation`,
    // sub-`minDetail` features are removed, curvature is regularised toward
    // `minRadius`, and an open cubic B-spline then produces a C2-continuous
    // curve whose LOCAL perpendicular under the pointer is the fan's shift
    // direction — which is why it has to be C2 and not merely smooth-looking:
    // a Catmull-Rom chain would make the fan direction jump at every knot.
    //
    // `precision` changes output sampling ONLY. It can never reintroduce a
    // source corner, and it can never change which fallback was taken: every
    // solve, validation and fallback decision below runs at a fixed physical
    // resolution and the setting is applied to the accepted curve afterwards.
    //
    // ## What is measured, and what is not
    //
    // The lane machinery above uses `Math.cos` and `Math.hypot` only, and
    // ``JSMath`` carries V8's own implementations of both. This section also
    // uses `exp`, `sin`, `atan2` and `sqrt`. V8 implements the first three
    // itself too (`base/ieee754.cc`), `JSMath` does not carry them, and
    // porting fdlibm three more times is not what this port is for — so the
    // parity test states a MEASURED ULP ceiling for the fitted geometry and
    // exact equality for everything structural about it (vertex counts, fit
    // type, accept/reject). See `OverlapLanesParityTests.corridorFits`.

    /// A fitted corridor centreline. Every field the JavaScript returns except
    /// two, both of which are recoverable from what the caller already holds:
    /// `_sourceLines` is the input, and the `nearParallel` boolean the corridor
    /// pass stamps onto the curve is `corridor.nearParallel != nil` on the
    /// corridor that owns it — the two are set from the same condition.
    public struct FittedCurve: Sendable {
        public var pts: [Coordinate]
        public var cum: [Double]
        public var dirs: [(x: Double, y: Double)]
        public var totalMeters: Double
        public var sourceTotalMeters: Double
        public var endpointChordMeters: Double
        public var radiusMeters: Double
        public var smoothingSigmaMeters: Double
        public var directionSigmaMeters: Double
        public var requestedMinRadiusMeters: Double
        /// `null` in the JavaScript when the measured radius is infinite — a
        /// straight corridor has no circumradius — which JSON has no spelling
        /// for and `Infinity` would not survive a round trip.
        public var achievedMinRadiusMeters: Double?
        public var achievedDirectionRadiusMeters: Double?
        public var minDetailMeters: Double
        public var maxDeviationMeters: Double
        public var actualMaxDeviationMeters: Double
        public var samplingPrecision: Double
        public var fitType: String
        public var coslat: Double
    }

    /// The four fit-curve sliders, as `APPLIED_FIT_CURVE_SETTINGS` holds them:
    /// unclamped, and possibly absent.
    ///
    /// `nil` is the JavaScript's missing/`null`/0/NaN — every one of which
    /// `Number(x) || default` collapses to the default, negative numbers and
    /// out-of-range values excepted, which are clamped instead.
    public struct FitCurveSettings: Sendable {
        public var precision: Double?
        public var minRadius: Double?
        public var minDetail: Double?
        public var maxDeviation: Double?

        public init(
            precision: Double? = nil, minRadius: Double? = nil, minDetail: Double? = nil,
            maxDeviation: Double? = nil
        ) {
            self.precision = precision
            self.minRadius = minRadius
            self.minDetail = minDetail
            self.maxDeviation = maxDeviation
        }

        /// `DISPLAY_DEFAULTS`, which is what a fresh install fits with.
        public static let `default` = FitCurveSettings(
            precision: 1, minRadius: 3100, minDetail: 3300, maxDeviation: 4200)
    }

    /// A point in the local metre frame the whole solve works in.
    struct MetricPoint: Sendable, Equatable {
        var x: Double
        var y: Double
    }

    /// Circumscribed-circle radius of three metric points — the discrete
    /// curvature probe shared by the relaxation passes, the spline validation
    /// window and the post-fit diagnostics. A near-zero cross product is a
    /// straight line: infinity, never a huge finite radius.
    static func circumRadius(_ a: MetricPoint, _ b: MetricPoint, _ c: MetricPoint) -> Double {
        let ab = JSMath.hypot(b.x - a.x, b.y - a.y)
        let bc = JSMath.hypot(c.x - b.x, c.y - b.y)
        let ca = JSMath.hypot(a.x - c.x, a.y - c.y)
        let cross = abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
        return cross < 1e-6 ? .infinity : (ab * bc * ca) / (2 * cross)
    }

    /// Clamped-index 1-D Gaussian convolution over a scalar series sampled at a
    /// uniform `step` in metres.
    ///
    /// The weight table uses the RAW step while only the kernel-size ceiling
    /// guards against a sub-metre step. Both direction-field stages' validated
    /// outputs depend on exactly this arithmetic, so it is kept bit for bit.
    static func gaussianSmoothSeries(
        _ input: [Double], sigma: Double, step: Double, minRadius: Int
    ) -> [Double] {
        let radius = Int(
            Swift.max(
                Double(minRadius),
                Swift.min(
                    300, Double(input.count - 1), ((sigma * 3) / Swift.max(1, step)).rounded(.up))))
        var weights = [Double](repeating: 0, count: radius + 1)
        for k in 0...radius {
            let x = (Double(k) * step) / sigma
            weights[k] = exp(-0.5 * (x * x))
        }
        return input.indices.map { i in
            var sum = 0.0
            var sw = 0.0
            for k in -radius...radius {
                let w = weights[abs(k)]
                sum += input[Swift.max(0, Swift.min(input.count - 1, i + k))] * w
                sw += w
            }
            return sum / sw
        }
    }

    /// Cumulative great-circle length along a polyline, `cum[0] == 0`.
    static func cumulativeMeters(_ points: [Coordinate]) -> [Double] {
        var cum = [0.0]
        for i in 1..<Swift.max(1, points.count) {
            cum.append(cum[i - 1] + Geometry.distanceMeters(points[i - 1], points[i]))
        }
        return cum
    }

    static func metricOffsetsFrom(
        _ points: [Coordinate], origin: Coordinate, mx: Double, my: Double
    ) -> [MetricPoint] {
        points.map { MetricPoint(x: ($0.lon - origin.lon) * mx, y: ($0.lat - origin.lat) * my) }
    }

    static func pointsFromMetricOffsets(
        _ metric: [MetricPoint], origin: Coordinate, mx: Double, my: Double
    ) -> [Coordinate] {
        metric.map { Coordinate(lon: origin.lon + $0.x / mx, lat: origin.lat + $0.y / my) }
    }

    /// `anchors` — the source corridor resampled to `count` evenly spaced
    /// points. Every later stage is deviation-clamped against these, so the fit
    /// can never wander away from the physical track.
    static func resampleCorridorAnchors(
        line: [Coordinate], cum: [Double], total: Double, count: Int
    ) -> [Coordinate] {
        func pointOnSource(_ target: Double) -> Coordinate {
            var lo = 0
            var hi = cum.count - 1
            while lo + 1 < hi {
                let mid = (lo + hi) >> 1
                if cum[mid] <= target { lo = mid } else { hi = mid }
            }
            var span = cum[lo + 1] - cum[lo]
            if span == 0 { span = 1 }
            let t = Swift.max(0, Swift.min(1, (target - cum[lo]) / span))
            return Coordinate(
                lon: line[lo].lon + (line[lo + 1].lon - line[lo].lon) * t,
                lat: line[lo].lat + (line[lo + 1].lat - line[lo].lat) * t)
        }
        return (0..<count).map { pointOnSource((total * Double($0)) / Double(count - 1)) }
    }

    /// The polyline counterpart of ``gaussianSmoothSeries(_:sigma:step:minRadius:)``.
    ///
    /// This first scale-space fit is intentionally allowed to cut inside bends.
    /// Linear continuation at either end avoids the endpoint kink a moving
    /// average pinned to the first/last source vertex produces.
    static func gaussianSmoothPolyline(
        _ input: [MetricPoint], sigma: Double, step: Double
    ) -> [MetricPoint] {
        let radius = Int(
            Swift.max(3, Swift.min(240, Double(input.count - 1), ((sigma * 3) / step).rounded(.up))))
        var weights = [Double](repeating: 0, count: radius + 1)
        for k in 0...radius {
            let x = (Double(k) * step) / sigma
            weights[k] = exp(-0.5 * (x * x))
        }
        let edgeSpan = Swift.min(input.count - 1, Swift.max(3, radius))
        let startDx = (input[edgeSpan].x - input[0].x) / Double(edgeSpan)
        let startDy = (input[edgeSpan].y - input[0].y) / Double(edgeSpan)
        let endDx =
            (input[input.count - 1].x - input[input.count - 1 - edgeSpan].x) / Double(edgeSpan)
        let endDy =
            (input[input.count - 1].y - input[input.count - 1 - edgeSpan].y) / Double(edgeSpan)
        func at(_ i: Int) -> MetricPoint {
            if i < 0 {
                return MetricPoint(
                    x: input[0].x + startDx * Double(i), y: input[0].y + startDy * Double(i))
            }
            if i >= input.count {
                let d = Double(i - (input.count - 1))
                return MetricPoint(
                    x: input[input.count - 1].x + endDx * d,
                    y: input[input.count - 1].y + endDy * d)
            }
            return input[i]
        }
        return input.indices.map { i in
            var sx = 0.0
            var sy = 0.0
            var sw = 0.0
            for k in -radius...radius {
                let w = weights[abs(k)]
                let p = at(i + k)
                sx += p.x * w
                sy += p.y * w
                sw += w
            }
            return MetricPoint(x: sx / sw, y: sy / sw)
        }
    }

    /// Pulls `p` back onto the `maxDeviation` disc centred on its source anchor.
    static func clampMetricDeviation(
        _ p: MetricPoint, anchor: MetricPoint, maxDeviation: Double
    ) -> MetricPoint {
        let dx = p.x - anchor.x
        let dy = p.y - anchor.y
        let d = JSMath.hypot(dx, dy)
        if d <= maxDeviation || d < 1e-9 { return p }
        let f = maxDeviation / d
        return MetricPoint(x: anchor.x + dx * f, y: anchor.y + dy * f)
    }

    /// The radius-relaxed metric polyline: repeatedly relax only the points
    /// whose measured radius is below the requested minimum. Deviation limiting
    /// is applied on every pass, so the two user constraints stay well behaved
    /// together.
    static func relaxMetricToMinRadius(
        _ input: [MetricPoint], anchorMetric: [MetricPoint], minRadius: Double,
        maxDeviation: Double, curvatureHalf: Int
    ) -> [MetricPoint] {
        var metric = input
        for _ in 0..<48 {
            var next = metric
            var violations = 0
            var maxMove = 0.0
            var i = curvatureHalf
            while i < metric.count - curvatureHalf {
                let a = metric[i - curvatureHalf]
                let b = metric[i]
                let c = metric[i + curvatureHalf]
                let radius = circumRadius(a, b, c)
                if radius >= minRadius {
                    i += 1
                    continue
                }
                violations += 1
                let severity = Swift.max(0, Swift.min(1, 1 - radius / minRadius))
                let pull = 0.08 + severity * 0.34
                let target = MetricPoint(x: (a.x + c.x) / 2, y: (a.y + c.y) / 2)
                let candidate = clampMetricDeviation(
                    MetricPoint(
                        x: b.x + (target.x - b.x) * pull, y: b.y + (target.y - b.y) * pull),
                    anchor: anchorMetric[i], maxDeviation: maxDeviation)
                maxMove = Swift.max(
                    maxMove, JSMath.hypot(candidate.x - b.x, candidate.y - b.y))
                next[i] = candidate
                i += 1
            }
            metric = next
            metric[0] = anchorMetric[0]
            metric[metric.count - 1] = anchorMetric[anchorMetric.count - 1]
            if violations == 0 || maxMove < 0.01 { break }
        }
        return metric
    }

    /// `controls` — the B-spline control polygon.
    ///
    /// PHYSICAL knot spacing, not source vertices, controls what the spline may
    /// express, so a larger minimum-detail value both removes more wiggles and
    /// gives the spline more freedom to span across small protrusions.
    static func buildSplineControlPolygon(
        metric: [MetricPoint], anchorMetric: [MetricPoint], knotEvery: Int, total: Double,
        minDetail: Double, minRadius: Double
    ) -> [MetricPoint] {
        var controls: [MetricPoint] = []
        var i = 0
        while i < metric.count {
            controls.append(metric[i])
            i += knotEvery
        }
        // The JavaScript compares ARRAY IDENTITY here — "is the last control
        // the very last metric point?" — which for a strided walk is the same
        // question as whether the stride landed on the last index. Comparing
        // coordinates instead would drop a genuinely needed endpoint whenever
        // the corridor's last two work points coincide.
        if (metric.count - 1) % knotEvery != 0 { controls.append(metric[metric.count - 1]) }
        if controls.count < 4 {
            controls = (0..<4).map { k in
                metric[Int(JSNumber.round(Double((metric.count - 1) * k) / 3))]
            }
        }
        // A sub-radius corridor cannot meaningfully express a bend while
        // keeping both physical endpoints. Treat it as a straight C2 span
        // rather than magnifying tiny source protrusions into a sharp
        // hover-direction change.
        if total <= Swift.max(minDetail * 4, minRadius * 1.1) {
            let a = anchorMetric[0]
            let b = anchorMetric[anchorMetric.count - 1]
            controls = [0, 1.0 / 3, 2.0 / 3, 1].map {
                MetricPoint(x: a.x + (b.x - a.x) * $0, y: a.y + (b.y - a.y) * $0)
            }
        }
        // Open B-splines are C2 only at INTERIOR knots. Making the first and
        // last three controls collinear forces zero endpoint curvature, instead
        // of allowing a tight hook beside a station or a run endpoint.
        if controls.count <= 4 {
            let a = controls[0]
            let b = controls[controls.count - 1]
            controls = [0, 1.0 / 3, 2.0 / 3, 1].map {
                MetricPoint(x: a.x + (b.x - a.x) * $0, y: a.y + (b.y - a.y) * $0)
            }
        } else {
            controls[1] = MetricPoint(
                x: (controls[0].x + controls[2].x) / 2, y: (controls[0].y + controls[2].y) / 2)
            let n = controls.count
            controls[n - 2] = MetricPoint(
                x: (controls[n - 1].x + controls[n - 3].x) / 2,
                y: (controls[n - 1].y + controls[n - 3].y) / 2)
        }
        return controls
    }

    /// `count` evenly parameterised samples of the clamped cubic B-spline
    /// through `controls`, by de Boor. C2 continuous at every interior knot, so
    /// both tangent and curvature change continuously as the pointer moves.
    static func sampleClampedBSpline(_ controls: [MetricPoint], count: Int) -> [MetricPoint] {
        let degree = 3
        let knotCount = controls.count + degree + 1
        var knots = [Double](repeating: 0, count: knotCount)
        for i in 0..<knotCount {
            if i <= degree {
                knots[i] = 0
            } else if i >= controls.count {
                knots[i] = 1
            } else {
                knots[i] = Double(i - degree) / Double(controls.count - degree)
            }
        }
        func splinePoint(_ u: Double) -> MetricPoint {
            if u <= 0 { return controls[0] }
            if u >= 1 { return controls[controls.count - 1] }
            var lo = degree
            var hi = controls.count
            while lo + 1 < hi {
                let mid = (lo + hi) >> 1
                if knots[mid] <= u { lo = mid } else { hi = mid }
            }
            let span = Swift.min(controls.count - 1, lo)
            var d = (0...degree).map { controls[span - degree + $0] }
            for r in 1...degree {
                var j = degree
                while j >= r {
                    let i = span - degree + j
                    let den = knots[i + degree - r + 1] - knots[i]
                    let alpha = den != 0 ? (u - knots[i]) / den : 0
                    d[j] = MetricPoint(
                        x: d[j - 1].x * (1 - alpha) + d[j].x * alpha,
                        y: d[j - 1].y * (1 - alpha) + d[j].y * alpha)
                    j -= 1
                }
            }
            return d[degree]
        }
        return (0..<count).map { splinePoint(Double($0) / Double(count - 1)) }
    }

    /// The smallest circumradius measured along `points`, over a window scaled
    /// to the requested minimum detail.
    static func measureMinCircumRadius(_ points: [MetricPoint], minDetail: Double) -> Double {
        var length = 0.0
        for i in 1..<Swift.max(1, points.count) {
            length += JSMath.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
        }
        let step = length / Double(Swift.max(1, points.count - 1))
        let half = Int(
            Swift.max(
                1,
                JSNumber.round(
                    Swift.max(45, Swift.min(180, minDetail * 0.04)) / Swift.max(1, step))))
        var radius = Double.infinity
        var i = half
        while i < points.count - half {
            radius = Swift.min(radius, circumRadius(points[i - half], points[i], points[i + half]))
            i += 1
        }
        return radius
    }

    /// A chord-pulled solution. If local filtering alone cannot meet the
    /// requested radius, progressively pull the complete control polygon toward
    /// its endpoint chord — each target still clamped against its source
    /// anchor, so raising the radius never silently violates the deviation
    /// budget. This global fallback is what lets the fit LEAVE a jagged source
    /// rather than merely round each of its corners.
    static func pullControlsTowardChord(
        controls: [MetricPoint], anchorMetric: [MetricPoint], spline: [MetricPoint],
        radius: Double, minRadius: Double, maxDeviation: Double, minDetail: Double, solveN: Int
    ) -> (spline: [MetricPoint], radius: Double) {
        let originalControls = controls
        var bestSpline = spline
        var bestRadius = radius
        for pass in 1...32 {
            let f = Double(pass) / 32
            let passControls = originalControls.enumerated().map { index, p -> MetricPoint in
                let t = Double(index) / Double(Swift.max(1, originalControls.count - 1))
                let ai = Int(JSNumber.round(t * Double(anchorMetric.count - 1)))
                let chord = MetricPoint(
                    x: anchorMetric[0].x
                        + (anchorMetric[anchorMetric.count - 1].x - anchorMetric[0].x) * t,
                    y: anchorMetric[0].y
                        + (anchorMetric[anchorMetric.count - 1].y - anchorMetric[0].y) * t)
                let target = clampMetricDeviation(
                    chord, anchor: anchorMetric[ai], maxDeviation: maxDeviation)
                return MetricPoint(
                    x: p.x + (target.x - p.x) * f, y: p.y + (target.y - p.y) * f)
            }
            let candidate = sampleClampedBSpline(passControls, count: solveN)
            let candidateRadius = measureMinCircumRadius(candidate, minDetail: minDetail)
            if candidateRadius > bestRadius {
                bestRadius = candidateRadius
                bestSpline = candidate
            }
            if candidateRadius >= minRadius * 0.999 { break }
        }
        return (bestSpline, bestRadius)
    }

    /// The best constant-curvature circular arc, or `nil` when none satisfies
    /// the deviation budget.
    ///
    /// Hairpin and loop corridors can have endpoints close together even though
    /// the shared track between them is long, and pulling such a curve toward
    /// its chord collapses it into a hook. A constant-curvature arc has one
    /// explicit radius at every point instead.
    ///
    /// Measured: no corridor either committed store produces reaches this, at
    /// any of the ten settings combinations in the fixture. Metro LOOP LINES
    /// reach it at the DEFAULT settings — 大江戸線, 丸ノ内線, 名城線, 高雄環狀
    /// 輕軌 — which is what the `alignment:` probes in the fixture are.
    static func fitCircularArcFallback(
        splineMetric: [MetricPoint], anchorMetric: [MetricPoint], total: Double,
        minRadius: Double, maxDeviation: Double, solveN: Int
    ) -> [MetricPoint]? {
        let start = splineMetric[0]
        let end = splineMetric[splineMetric.count - 1]
        let dx = end.x - start.x
        let dy = end.y - start.y
        let chord = JSMath.hypot(dx, dy)
        let minimumArcRadius = Swift.max(minRadius * 1.03, chord * 0.5001)
        var radii: [Double] = []
        for value in [
            minimumArcRadius,
            Swift.max(minimumArcRadius, total / (2 * Double.pi)),
            Swift.max(minimumArcRadius, total / Double.pi),
            minimumArcRadius * 1.5,
        ] {
            let rounded = JSNumber.round(value * 1000) / 1000
            if !radii.contains(rounded) { radii.append(rounded) }
        }
        // Anchor segment vectors are invariant across every radius, side and
        // sweep candidate and every sampled point.
        struct ArcSegment {
            var ax: Double, ay: Double, vx: Double, vy: Double, den: Double
        }
        var arcSegs: [ArcSegment] = []
        arcSegs.reserveCapacity(anchorMetric.count - 1)
        for j in 0..<(anchorMetric.count - 1) {
            let a0 = anchorMetric[j]
            let b0 = anchorMetric[j + 1]
            let vx = b0.x - a0.x
            let vy = b0.y - a0.y
            arcSegs.append(
                ArcSegment(ax: a0.x, ay: a0.y, vx: vx, vy: vy, den: vx * vx + vy * vy))
        }
        var bestArc: [MetricPoint]? = nil
        var bestArcScore = Double.infinity
        for radius in radii {
            let half = chord / 2
            let height = Swift.max(0, radius * radius - half * half).squareRoot()
            let mx0 = (start.x + end.x) / 2
            let my0 = (start.y + end.y) / 2
            let nx = chord > 1e-9 ? -dy / chord : 0
            let ny = chord > 1e-9 ? dx / chord : 1
            for side in [-1.0, 1.0] {
                let center = MetricPoint(x: mx0 + nx * height * side, y: my0 + ny * height * side)
                let startAngle = atan2(start.y - center.y, start.x - center.x)
                let endAngle = atan2(end.y - center.y, end.x - center.x)
                var shortSweep = endAngle - startAngle
                while shortSweep > .pi { shortSweep -= 2 * .pi }
                while shortSweep < -.pi { shortSweep += 2 * .pi }
                let sweeps = [
                    shortSweep,
                    shortSweep > 0 ? shortSweep - 2 * .pi : shortSweep + 2 * .pi,
                ]
                for sweep in sweeps {
                    if abs(sweep) < 1e-6 { continue }
                    var candidate = [MetricPoint](
                        repeating: MetricPoint(x: 0, y: 0), count: solveN)
                    for i in 0..<solveN {
                        let t = Double(i) / Double(solveN - 1)
                        let a = startAngle + sweep * t
                        candidate[i] = MetricPoint(
                            x: center.x + cos(a) * radius, y: center.y + sin(a) * radius)
                    }
                    var sampledDeviation = 0.0
                    var maxNearestDeviation = 0.0
                    var sampledCount = 0
                    let stride = Swift.max(1, Int((Double(solveN) / 96).rounded(.down)))
                    var i = 0
                    while i < solveN {
                        let p = candidate[i]
                        var nearestSq = Double.infinity
                        for s in arcSegs {
                            let u =
                                s.den != 0
                                ? Swift.max(
                                    0,
                                    Swift.min(
                                        1,
                                        ((p.x - s.ax) * s.vx + (p.y - s.ay) * s.vy) / s.den))
                                : 0
                            let ex = p.x - (s.ax + s.vx * u)
                            let ey = p.y - (s.ay + s.vy * u)
                            let dSq = ex * ex + ey * ey
                            if dSq < nearestSq { nearestSq = dSq }
                        }
                        let nearest = nearestSq.squareRoot()
                        sampledDeviation += nearest
                        maxNearestDeviation = Swift.max(maxNearestDeviation, nearest)
                        sampledCount += 1
                        i += stride
                    }
                    if maxNearestDeviation > maxDeviation * 1.02 { continue }
                    let arcLength = radius * abs(sweep)
                    let score =
                        sampledDeviation / Swift.max(1, Double(sampledCount))
                        + abs(arcLength - total) * 0.08
                    if score < bestArcScore {
                        bestArcScore = score
                        bestArc = candidate
                    }
                }
            }
        }
        return bestArc
    }

    /// `angles` — the radius-limited direction field, one continuous scalar
    /// angle per output sample.
    ///
    /// Unwrapped BEFORE smoothing. Averaging unit vectors is unstable at a
    /// U-turn: two nearly opposite vectors cancel, and their normalised result
    /// can jump tens of degrees between adjacent samples. A continuous scalar
    /// angle has no such zero-vector singularity.
    static func directionFieldAngles(
        cur: [Coordinate], coslat: Double, minDetail: Double, minRadius: Double,
        outputStep: Double, directionSigma: Double
    ) -> [Double] {
        let baseHalf = Int(
            Swift.max(
                1,
                JSNumber.round(
                    Swift.max(60, minDetail * 0.18) / Swift.max(1, outputStep))))
        var angles = cur.indices.map { i -> Double in
            let a = cur[Swift.max(0, i - baseHalf)]
            let b = cur[Swift.min(cur.count - 1, i + baseHalf)]
            return atan2(b.lat - a.lat, (b.lon - a.lon) * coslat)
        }
        for i in 1..<Swift.max(1, angles.count) {
            var d = angles[i] - angles[i - 1]
            while d > .pi {
                angles[i] -= 2 * .pi
                d -= 2 * .pi
            }
            while d < -.pi {
                angles[i] += 2 * .pi
                d += 2 * .pi
            }
        }
        angles = gaussianSmoothSeries(
            angles, sigma: directionSigma, step: outputStep, minRadius: 3)
        angles = gaussianSmoothSeries(
            angles, sigma: directionSigma * 0.65, step: outputStep, minRadius: 3)
        let maxTurn = Swift.min(
            0.045, Swift.max(1e-5, outputStep / Swift.max(100, minRadius)))
        for _ in 0..<2 {
            for i in 1..<Swift.max(1, angles.count) {
                angles[i] = Swift.max(
                    angles[i - 1] - maxTurn, Swift.min(angles[i - 1] + maxTurn, angles[i]))
            }
            var i = angles.count - 2
            while i >= 0 {
                angles[i] = Swift.max(
                    angles[i + 1] - maxTurn, Swift.min(angles[i + 1] + maxTurn, angles[i]))
                i -= 1
            }
        }
        return angles
    }

    /// `integrated` — geometry rebuilt from the direction field, with the
    /// endpoint drift distributed LINEARLY over the whole arc so both physical
    /// corridor ends stay exact without concentrating the correction into a
    /// station-side hook.
    static func integrateFromDirectionField(
        splineMetric: [MetricPoint], angles: [Double]
    ) -> [MetricPoint] {
        var segmentLengths = [Double](repeating: 0, count: splineMetric.count - 1)
        for i in segmentLengths.indices {
            segmentLengths[i] = JSMath.hypot(
                splineMetric[i + 1].x - splineMetric[i].x,
                splineMetric[i + 1].y - splineMetric[i].y)
        }
        var integrated = [MetricPoint](
            repeating: MetricPoint(x: 0, y: 0), count: splineMetric.count)
        integrated[0] = splineMetric[0]
        for i in 1..<integrated.count {
            let a = (angles[i - 1] + angles[i]) / 2
            integrated[i] = MetricPoint(
                x: integrated[i - 1].x + cos(a) * segmentLengths[i - 1],
                y: integrated[i - 1].y + sin(a) * segmentLengths[i - 1])
        }
        let endDriftX = splineMetric[splineMetric.count - 1].x - integrated[integrated.count - 1].x
        let endDriftY = splineMetric[splineMetric.count - 1].y - integrated[integrated.count - 1].y
        for i in 1..<integrated.count {
            let t = Double(i) / Double(integrated.count - 1)
            integrated[i].x += endDriftX * t
            integrated[i].y += endDriftY * t
        }
        return integrated
    }

    /// The tightest radius the direction field itself implies — turn per metre.
    static func minDirectionRadius(angles: [Double], cum: [Double]) -> Double {
        var radius = Double.infinity
        for i in 1..<Swift.max(1, angles.count) {
            let turn = abs(angles[i] - angles[i - 1])
            if turn > 1e-9 { radius = Swift.min(radius, (cum[i] - cum[i - 1]) / turn) }
        }
        return radius
    }

    /// The display-resolution resampling of an accepted curve.
    static func resampleFittedCurveOutput(
        cur: [Coordinate], angles: [Double], smoothCum: [Double], smoothTotal: Double,
        displayN: Int
    ) -> (points: [Coordinate], angles: [Double], cum: [Double]) {
        var outputPoints = [Coordinate](
            repeating: Coordinate(lon: 0, lat: 0), count: displayN)
        var outputAngles = [Double](repeating: 0, count: displayN)
        var sourceIndex = 0
        for i in 0..<displayN {
            let target = (smoothTotal * Double(i)) / Double(displayN - 1)
            while sourceIndex + 1 < smoothCum.count - 1 && smoothCum[sourceIndex + 1] < target {
                sourceIndex += 1
            }
            var span = smoothCum[sourceIndex + 1] - smoothCum[sourceIndex]
            if span == 0 { span = 1 }
            let t = Swift.max(0, Swift.min(1, (target - smoothCum[sourceIndex]) / span))
            let a = cur[sourceIndex]
            let b = cur[sourceIndex + 1]
            outputPoints[i] = Coordinate(
                lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t)
            outputAngles[i] =
                angles[sourceIndex] + (angles[sourceIndex + 1] - angles[sourceIndex]) * t
        }
        return (outputPoints, outputAngles, cumulativeMeters(outputPoints))
    }

    /// Exact-enough local metric distance used by final fit validation. Unlike
    /// the solver's convenient single-latitude plane, EACH query gets its own
    /// longitude scale, so a long north/south corridor does not accumulate
    /// projection error.
    static func fittedPointSegmentDistanceMeters(
        _ p: Coordinate, _ a: Coordinate, _ b: Coordinate
    ) -> Double {
        let c = JSMath.cos((((p.lat + a.lat + b.lat) / 3) * .pi) / 180)
        let coslat = c == 0 ? 1e-6 : c
        let ax = (a.lon - p.lon) * metresPerDegreeLon * coslat
        let ay = (a.lat - p.lat) * metresPerDegreeLat
        let bx = (b.lon - p.lon) * metresPerDegreeLon * coslat
        let by = (b.lat - p.lat) * metresPerDegreeLat
        let vx = bx - ax
        let vy = by - ay
        let den = vx * vx + vy * vy
        let t = den != 0 ? Swift.max(0, Swift.min(1, -(ax * vx + ay * vy) / den)) : 0
        return JSMath.hypot(ax + vx * t, ay + vy * t)
    }

    /// Final deviation is ALWAYS measured against raw railway geometry, never
    /// against a previous fitted stage. A degree grid keeps the usual query
    /// local; the distance itself stays in metres and latitude-aware.
    static func validateFittedCurveDeviation(
        points: [Coordinate], sourceLines: [[Coordinate]], budgetMeters: Double
    ) -> (valid: Bool, maxDeviationMeters: Double) {
        let lines = sourceLines.filter { $0.count >= 2 }
        if points.count < 2 || lines.isEmpty || !(budgetMeters > 0) {
            return (false, .infinity)
        }
        let cellDeg = Swift.max(0.005, Swift.min(0.05, budgetMeters / metresPerDegreeLat))
        var cells: [Int64: [Int]] = [:]
        var segments: [(Coordinate, Coordinate)] = []
        func cellKey(_ x: Int, _ y: Int) -> Int64 { Int64(x) &* 1_000_003 &+ Int64(y) }
        for line in lines {
            for i in 0..<(line.count - 1) {
                let a = line[i]
                let b = line[i + 1]
                let index = segments.count
                segments.append((a, b))
                let x0 = Int((Swift.min(a.lon, b.lon) / cellDeg).rounded(.down))
                let x1 = Int((Swift.max(a.lon, b.lon) / cellDeg).rounded(.down))
                let y0 = Int((Swift.min(a.lat, b.lat) / cellDeg).rounded(.down))
                let y1 = Int((Swift.max(a.lat, b.lat) / cellDeg).rounded(.down))
                for x in x0...x1 {
                    for y in y0...y1 { cells[cellKey(x, y), default: []].append(index) }
                }
            }
        }
        func nearest(_ p: Coordinate) -> Double {
            let c = JSMath.cos((p.lat * .pi) / 180)
            let coslat = c == 0 ? 1e-6 : c
            let lonRadius = budgetMeters / (metresPerDegreeLon * coslat)
            let latRadius = budgetMeters / metresPerDegreeLat
            let x0 = Int(((p.lon - lonRadius) / cellDeg).rounded(.down)) - 1
            let x1 = Int(((p.lon + lonRadius) / cellDeg).rounded(.down)) + 1
            let y0 = Int(((p.lat - latRadius) / cellDeg).rounded(.down)) - 1
            let y1 = Int(((p.lat + latRadius) / cellDeg).rounded(.down)) + 1
            var seen = Set<Int>()
            var best = Double.infinity
            for x in x0...x1 {
                for y in y0...y1 {
                    guard let bucket = cells[cellKey(x, y)] else { continue }
                    for index in bucket {
                        if seen.contains(index) { continue }
                        seen.insert(index)
                        let segment = segments[index]
                        best = Swift.min(
                            best,
                            fittedPointSegmentDistanceMeters(p, segment.0, segment.1))
                    }
                }
            }
            return best
        }

        var maximum = 0.0
        let distances = points.map { p -> Double in
            let d = nearest(p)
            maximum = Swift.max(maximum, d)
            return d
        }
        if maximum > budgetMeters { return (false, maximum) }

        // Distance-to-a-set is 1-Lipschitz, so this bound proves whole output
        // SEGMENTS rather than only their vertices; only spans too close to the
        // budget are subdivided, and at the depth cap the answer is a
        // conservative rejection.
        func verifySpan(
            _ a: Coordinate, _ b: Coordinate, _ da: Double, _ db: Double, _ depth: Int
        ) -> Bool {
            let length = Geometry.distanceMeters(a, b)
            let upper = Swift.max(da, Swift.max(db, (da + db + length) / 2))
            if upper <= budgetMeters { return true }
            let mid = Coordinate(lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2)
            let dm = nearest(mid)
            maximum = Swift.max(maximum, dm)
            if dm > budgetMeters { return false }
            if depth >= 9 { return false }
            return verifySpan(a, mid, da, dm, depth + 1)
                && verifySpan(mid, b, dm, db, depth + 1)
        }
        for i in 0..<(points.count - 1) {
            if !verifySpan(points[i], points[i + 1], distances[i], distances[i + 1], 0) {
                return (false, maximum)
            }
        }
        return (true, maximum)
    }

    /// `normalizeFitCurveInputs`: the clamped settings plus the source arc
    /// length, or `nil` for a line that cannot be fitted at all.
    struct FitInputs {
        var precision: Double
        var requestedMinRadius: Double
        var minRadius: Double
        var minDetail: Double
        var maxDeviation: Double
        var cum: [Double]
        var total: Double
    }

    /// `Number(x) || fallback` — every falsy value, including 0 and NaN, is the
    /// default. A negative number is truthy and survives to the clamp.
    private static func orDefault(_ value: Double?, _ fallback: Double) -> Double {
        guard let value, value != 0, !value.isNaN else { return fallback }
        return value
    }

    static func normalizeFitCurveInputs(
        line: [Coordinate], settings: FitCurveSettings
    ) -> FitInputs? {
        guard line.count >= 2 else { return nil }
        let precision = Swift.max(0.5, Swift.min(2, orDefault(settings.precision, 1)))
        let requestedMinRadius = Swift.max(
            100, Swift.min(40000, orDefault(settings.minRadius, 3100)))
        // Solve with a small safety margin so discrete output sampling,
        // latitude scaling and endpoint correction can never pull the measured
        // result below the user-facing minimum radius.
        let minRadius = requestedMinRadius * 1.03
        let minDetail = Swift.max(20, Swift.min(30000, orDefault(settings.minDetail, 3300)))
        let maxDeviation = Swift.max(
            20, Swift.min(40000, orDefault(settings.maxDeviation, 4200)))
        let cum = cumulativeMeters(line)
        let total = cum[cum.count - 1]
        guard total > 0 else { return nil }
        return FitInputs(
            precision: precision, requestedMinRadius: requestedMinRadius, minRadius: minRadius,
            minDetail: minDetail, maxDeviation: maxDeviation, cum: cum, total: total)
    }

    /// `smoothStandaloneCorridorRun`: a closed run has no safe seam for an open
    /// B-spline, so it keeps its static group vector until a periodic solver
    /// exists.
    public static func smoothStandaloneCorridorRun(
        _ line: [Coordinate], isClosed: Bool, settings: FitCurveSettings = .default
    ) -> FittedCurve? {
        isClosed ? nil : smoothCorridorCurve(line, settings: settings)
    }

    /// The corridor fit. `smoothCorridorCurve` in the JavaScript is this plus a
    /// memo and a defensive deep clone of its entry; in Swift the value
    /// semantics make both unnecessary, so this IS `smoothCorridorCurveUncached`.
    public static func smoothCorridorCurve(
        _ line: [Coordinate], settings: FitCurveSettings = .default
    ) -> FittedCurve? {
        guard let inputs = normalizeFitCurveInputs(line: line, settings: settings) else {
            return nil
        }
        let minRadius = inputs.minRadius
        let minDetail = inputs.minDetail
        let maxDeviation = inputs.maxDeviation
        let total = inputs.total

        // ── §1 anchors: the source corridor at a fixed physical work resolution ──
        // Work resolution is independent of the debug-output resolution. Tying
        // it to physical detail makes every option stable across source
        // densities.
        let workStepTarget = Swift.max(20, Swift.min(90, minDetail / 6))
        let workN = Int(
            Swift.max(20, Swift.min(1800, (total / workStepTarget).rounded(.up) + 1)))
        let workStep = total / Double(workN - 1)
        let anchors = resampleCorridorAnchors(
            line: line, cum: inputs.cum, total: total, count: workN)

        // ── §2 the local metric frame every stage below works in ──
        let lat0 = line.reduce(0.0) { $0 + $1.lat } / Double(line.count)
        let coslatRaw = JSMath.cos((lat0 * .pi) / 180)
        let coslat = coslatRaw == 0 ? 1e-6 : coslatRaw
        let mx = metresPerDegreeLon * coslat
        let my = metresPerDegreeLat
        let origin = anchors[0]
        let anchorMetric = metricOffsetsFrom(anchors, origin: origin, mx: mx, my: my)
        var metric = anchorMetric

        // ── §3 scale-space smoothing, then deviation clamping ──
        let sigmaM = Swift.max(100, Swift.max(minDetail * 1.1, minRadius * 0.65))
        metric = gaussianSmoothPolyline(metric, sigma: sigmaM, step: workStep)
        metric = gaussianSmoothPolyline(metric, sigma: sigmaM * 0.65, step: workStep)
        metric = metric.enumerated().map {
            clampMetricDeviation($1, anchor: anchorMetric[$0], maxDeviation: maxDeviation)
        }
        // Keep the physical corridor endpoints addressable; the clamped
        // B-spline still provides a smooth one-sided tangent there.
        metric[0] = anchorMetric[0]
        metric[metric.count - 1] = anchorMetric[anchorMetric.count - 1]

        // ── §4 curvature projection against the requested minimum radius ──
        let curvatureHalf = Int(
            Swift.max(
                1,
                JSNumber.round(
                    Swift.max(100, Swift.max(minDetail * 0.45, minRadius * 0.12)) / workStep)))
        metric = relaxMetricToMinRadius(
            metric, anchorMetric: anchorMetric, minRadius: minRadius,
            maxDeviation: maxDeviation, curvatureHalf: curvatureHalf)

        // ── §5 control polygon and the first spline evaluation ──
        let knotSpacing = Swift.max(100, Swift.max(minDetail * 1.25, minRadius * 0.18))
        let knotEvery = Swift.max(1, Int(JSNumber.round(knotSpacing / workStep)))
        let controls = buildSplineControlPolygon(
            metric: metric, anchorMetric: anchorMetric, knotEvery: knotEvery, total: total,
            minDetail: minDetail, minRadius: minRadius)
        // Candidate solving and validation use ONE fixed physical resolution.
        // The precision setting is applied only when the accepted curve is
        // resampled below, so it cannot trigger a different fallback or shape.
        let solveN = Int(Swift.max(20, Swift.min(3200, (total / 30).rounded(.up) + 1)))
        var splineMetric = sampleClampedBSpline(controls, count: solveN)
        var achievedMinRadius = measureMinCircumRadius(splineMetric, minDetail: minDetail)

        // ── §6 fallback 1: pull the whole control polygon toward its chord ──
        if achievedMinRadius < minRadius * 0.999 {
            let pulled = pullControlsTowardChord(
                controls: controls, anchorMetric: anchorMetric, spline: splineMetric,
                radius: achievedMinRadius, minRadius: minRadius, maxDeviation: maxDeviation,
                minDetail: minDetail, solveN: solveN)
            splineMetric = pulled.spline
            achievedMinRadius = pulled.radius
        }

        // ── §7 fallback 2: constant-curvature circular arcs ──
        var usedCircularArc = false
        if achievedMinRadius < minRadius * 0.999 {
            if let bestArc = fitCircularArcFallback(
                splineMetric: splineMetric, anchorMetric: anchorMetric, total: total,
                minRadius: minRadius, maxDeviation: maxDeviation, solveN: solveN)
            {
                splineMetric = bestArc
                achievedMinRadius = measureMinCircumRadius(splineMetric, minDetail: minDetail)
                usedCircularArc = true
            }
        }

        // ── §8 back to lon/lat: arc length and step of the accepted geometry ──
        var cur = pointsFromMetricOffsets(splineMetric, origin: origin, mx: mx, my: my)
        var smoothCum = cumulativeMeters(cur)
        var smoothTotal = smoothCum[smoothCum.count - 1]
        var outputStep = smoothTotal / Double(Swift.max(1, cur.count - 1))

        // ── §9 direction field, then geometry re-integrated from it ──
        let directionRadiusM = Swift.max(minRadius, minDetail * 2)
        let directionSigmaM = Swift.max(80, Swift.max(minDetail * 0.45, minRadius * 0.12))
        let angles = directionFieldAngles(
            cur: cur, coslat: coslat, minDetail: minDetail, minRadius: minRadius,
            outputStep: outputStep, directionSigma: directionSigmaM)
        let integrated = integrateFromDirectionField(splineMetric: splineMetric, angles: angles)
        let integratedRadius = measureMinCircumRadius(integrated, minDetail: minDetail)
        if integratedRadius >= achievedMinRadius {
            splineMetric = integrated
            achievedMinRadius = integratedRadius
            cur = pointsFromMetricOffsets(splineMetric, origin: origin, mx: mx, my: my)
            smoothCum = cumulativeMeters(cur)
            smoothTotal = smoothCum[smoothCum.count - 1]
            outputStep = smoothTotal / Double(Swift.max(1, cur.count - 1))
        }
        let achievedDirectionRadius = minDirectionRadius(angles: angles, cum: smoothCum)

        // ── §10 hard validation of the fixed-resolution solution ──
        let deviation = validateFittedCurveDeviation(
            points: cur, sourceLines: [line], budgetMeters: maxDeviation)
        if !deviation.valid || achievedMinRadius < inputs.requestedMinRadius * 0.999
            || achievedDirectionRadius < inputs.requestedMinRadius * 0.999
        { return nil }

        // ── §11 output resampling at the requested precision ──
        let displayN = Int(
            Swift.max(
                20,
                Swift.min(3200, (smoothTotal / (30 / inputs.precision)).rounded(.up) + 1)))
        var outputPoints = cur
        var outputAngles = angles
        var outputCum = smoothCum
        if displayN != cur.count {
            let resampled = resampleFittedCurveOutput(
                cur: cur, angles: angles, smoothCum: smoothCum, smoothTotal: smoothTotal,
                displayN: displayN)
            outputPoints = resampled.points
            outputAngles = resampled.angles
            outputCum = resampled.cum
        }
        var finalDeviation = validateFittedCurveDeviation(
            points: outputPoints, sourceLines: [line], budgetMeters: maxDeviation)
        let outputMetric = metricOffsetsFrom(outputPoints, origin: origin, mx: mx, my: my)
        var finalAchievedMinRadius = measureMinCircumRadius(outputMetric, minDetail: minDetail)
        var finalAchievedDirectionRadius = minDirectionRadius(
            angles: outputAngles, cum: outputCum)
        if !finalDeviation.valid
            || finalAchievedMinRadius < inputs.requestedMinRadius * 0.999
            || finalAchievedDirectionRadius < inputs.requestedMinRadius * 0.999
        {
            // A low-density representation may replace a validated bend with a
            // chord. Hard invariants win over the requested output density:
            // keep the fixed-resolution solution rather than publish an invalid
            // polyline.
            outputPoints = cur
            outputAngles = angles
            outputCum = smoothCum
            finalDeviation = deviation
            finalAchievedMinRadius = achievedMinRadius
            finalAchievedDirectionRadius = achievedDirectionRadius
        }
        return FittedCurve(
            pts: outputPoints,
            cum: outputCum,
            dirs: outputAngles.map { (cos($0), sin($0)) },
            totalMeters: outputCum[outputCum.count - 1],
            sourceTotalMeters: total,
            endpointChordMeters: JSMath.hypot(
                anchorMetric[anchorMetric.count - 1].x - anchorMetric[0].x,
                anchorMetric[anchorMetric.count - 1].y - anchorMetric[0].y),
            radiusMeters: directionRadiusM,
            smoothingSigmaMeters: sigmaM,
            directionSigmaMeters: directionSigmaM,
            requestedMinRadiusMeters: inputs.requestedMinRadius,
            achievedMinRadiusMeters: finalAchievedMinRadius.isFinite
                ? finalAchievedMinRadius : nil,
            achievedDirectionRadiusMeters: finalAchievedDirectionRadius.isFinite
                ? finalAchievedDirectionRadius : nil,
            minDetailMeters: minDetail,
            maxDeviationMeters: maxDeviation,
            actualMaxDeviationMeters: finalDeviation.maxDeviationMeters,
            samplingPrecision: inputs.precision,
            fitType: usedCircularArc ? "circular-arc" : "cubic-bspline-c2",
            coslat: coslat)
    }

    // MARK: - §5 the record build

    /// One drawn record: a polyline per maximal stretch of constant overlap
    /// membership, so run boundaries coincide exactly across all sharing rides.
    ///
    /// All source geometry stays on its TRUE track. The lane translation is
    /// applied by the renderer, from ``shiftX``/``shiftY`` and ``laneMult``.
    public struct Record: Sendable {
        public var trainId: String
        public var path: [Coordinate]
        public var shiftX: Double
        public var shiftY: Double
        public var laneMult: Double
        public var pickWidth: Double
        public var overlapCount: Int
        public var overlapSlot: Int
        public var groupKey: String
        public var nopick: Bool
        public var lane: Int
        public var sortKey: Double
    }

    /// One ride's complete course on its true track, per line. Every line of
    /// every ride gets one, so a hovered group can translate each member's
    /// whole course intact — including sections that overlap nothing.
    public struct ExpandRecord: Sendable {
        public var trainId: String
        public var path: [Coordinate]
    }

    public struct RecordBundle: Sendable {
        public var records: [Record]
        public var expandRecords: [ExpandRecord]
        /// The surviving interaction groups, in the order they were created —
        /// aliased entries have been dropped, so only canonical keys remain.
        public var corridors: [(key: String, corridor: Corridor)]
        public var spacingPx: Double
        public var hasOverlaps: Bool

        public func corridor(_ key: String) -> Corridor? {
            corridors.first { $0.key == key }?.corridor
        }
    }

    /// Three phases, each named for the intermediate product it yields:
    ///
    ///     §1 per line   lanes → runs → drawn subset, then one record per run
    ///     §2 corridor   representative geometry → endpoint joins → components
    ///                   → per component: the fitted curve and the unified
    ///                   shift axis, then alias collapse, pick bridges, and
    ///                   dropping the aliased entries
    ///     §3 publish    the painter's order
    ///
    /// `rank` is the date-ordered ride rank; `spacingPx` is
    /// `currentOverlapSpacingPx()`, which reads the display sliders.
    ///
    /// The JavaScript's §2 ends with `smoothCurveStationJoins(groupInfo)`,
    /// which is where this port stops — see the type documentation.
    public static func buildRouteRecords(
        items: [Item], lines: [[RouteLine]], overlap: OverlapMap, snap: VertexSnap,
        rank: [String: Int], spacingPx: Double, settings: FitCurveSettings = .default
    ) -> RecordBundle {
        var records: [Record] = []
        var expandRecords: [ExpandRecord] = []
        var groupInfo = OrderedMap<Corridor>()
        var drawnLenByTid: [String: Double] = [:]
        var hasOverlaps = false

        // ── §1 per line ──
        for (itemIndex, item) in items.enumerated() {
            guard item.recordDrawn else { continue }
            let tid = item.trainId
            let noPick = item.noPick
            for line in lines[itemIndex] {
                let orig = line.orig
                guard orig.count >= 2 else { continue }
                let nSeg = orig.count - 1
                let lanes = assignSegmentOverlapLanes(
                    overlap: overlap, orig: orig, segKeys: line.segKeys, trainId: tid,
                    noPick: noPick)
                if lanes.lineHasOverlap { hasOverlaps = true }
                let runs = maximalOverlapRuns(segIdentity: lanes.segIdentity, nSeg: nSeg)
                let subset = buildDrawnVertexSubset(
                    orig: orig, keepIdx: line.keepIdx, runs: runs, nSeg: nSeg)
                drawnLenByTid[tid] = (drawnLenByTid[tid] ?? 0) + subset.drawnLen

                for run in runs {
                    guard let ka = subset.posOf[run.a], let kb = subset.posOf[run.b] else {
                        continue
                    }
                    let runLine = Array(subset.drawn[ka...kb])
                    if runLine.count < 2 { continue }
                    let identity = lanes.segIdentity[run.a]
                    let n = identity.map { overlap.sharedSets[$0].count } ?? 1
                    let mult = lanes.segMult[run.a]
                    var groupKey = ""
                    if n > 1 {
                        groupKey = canonicalRunGroupKey(
                            overlap: overlap, segKeys: line.segKeys,
                            segBridged: lanes.segBridged, ra: run.a, rb: run.b)
                    }
                    var shiftX = 0.0
                    var shiftY = 0.0
                    if n > 1, let identity {
                        if var gi = groupInfo[groupKey] {
                            // A near-parallel interaction key can be met on
                            // more than one physical run. Keep the distinct
                            // geometry; the representative pass joins whatever
                            // is compatible.
                            mergeRunLineIntoGroup(&gi, runLine: runLine)
                            groupInfo[groupKey] = gi
                            shiftX = gi.sx
                            shiftY = gi.sy
                        } else {
                            let axis = corridorRunShiftAxis(
                                overlap: overlap, snap: snap, orig: orig,
                                segKeys: line.segKeys, ra: run.a, rb: run.b)
                            let ids = overlap.sharedSets[identity]
                            let mults = ids.order.map {
                                (
                                    trainId: $0,
                                    mult: Double(ids.slot(of: $0)) - Double(ids.count - 1) / 2
                                )
                            }
                            let gi = Corridor(
                                sx: axis.dy / axis.len / axis.coslatRef,
                                sy: -axis.dx / axis.len,
                                mults: mults,
                                line: runLine,
                                lines: [runLine],
                                pa: orig[run.a],
                                pb: orig[run.b],
                                latRef: axis.latRef,
                                signature: "",
                                curveEndpointNodeKeys: [],
                                nearParallel: overlap.nearGroupInfo(groupKey),
                                corridorJoins: [],
                                pickBridges: [],
                                curve: nil)
                            groupInfo[groupKey] = gi
                            shiftX = gi.sx
                            shiftY = gi.sy
                        }
                    }
                    records.append(
                        Record(
                            trainId: tid,
                            path: runLine,
                            shiftX: shiftX,
                            shiftY: shiftY,
                            laneMult: mult,
                            pickWidth: n > 1
                                ? Swift.max(spacingPx, 6) : Swift.max(item.strokeWidth + 4, 10),
                            overlapCount: n,
                            overlapSlot: lanes.segSlot[run.a],
                            groupKey: groupKey,
                            nopick: noPick,
                            lane: 0,
                            sortKey: 0))
                }
                expandRecords.append(ExpandRecord(trainId: tid, path: subset.drawn))
            }
        }

        // ── §2 one shift axis per contiguous CORRIDOR ──
        // A single visual corridor is usually split into many runs, because the
        // source geometry is chopped into per-feature LineStrings — so each run
        // got its own chord above and the fan direction changed as the pointer
        // moved between runs. Groups whose member sets are identical and whose
        // runs touch end to end are stitched together and given ONE shift
        // vector: the perpendicular of the straight line joining the corridor's
        // overall start and end.
        if groupInfo.count > 0 {
            for key in groupInfo.keys {
                var gi = groupInfo[key]!
                rebuildGroupRepresentativeGeometry(&gi)
                gi.curveEndpointNodeKeys = [
                    snap.nodeKey(gi.line[0]), snap.nodeKey(gi.line[gi.line.count - 1]),
                ]
                groupInfo[key] = gi
            }
            let joins = matchCorridorEndpointJoins(&groupInfo)
            let components = buildCorridorComponents(
                groupInfo: groupInfo, joins: joins, snap: snap)
            var corridorAliases: [String: String] = [:]
            var corridorMasters = OrderedSet()

            func usePerRunCurves(_ c: Component) {
                for k in c.keys {
                    var g = groupInfo[k]!
                    corridorAliases[k] = k
                    corridorMasters.insert(k)
                    g.corridorJoins = []
                    g.curveEndpointNodeKeys = [
                        snap.nodeKey(g.line[0]), snap.nodeKey(g.line[g.line.count - 1]),
                    ]
                    g.curve = smoothStandaloneCorridorRun(
                        g.line, isClosed: false, settings: settings)
                    groupInfo[k] = g
                }
            }

            for (_, c) in components.entries {
                let componentJoins = joins.filter {
                    c.keySet.contains($0.a.key) && c.keySet.contains($0.b.key)
                }
                let lone = c.keys.count == 1 ? groupInfo[c.keys[0]] : nil
                let isClosed =
                    (c.keys.count > 1 && componentJoins.count == c.keys.count)
                    || (lone.map {
                        $0.line.count > 3
                            && Geometry.distanceMeters($0.pa, $0.pb) <= snapMeters
                    } ?? false)
                if isClosed {
                    // An open B-spline would insert an arbitrary seam into this
                    // cycle. A multi-run cycle can keep its open member runs
                    // independently; a single self-closing run has no safe seam
                    // at all, so it uses only its static group vector.
                    if lone != nil {
                        let key = c.keys[0]
                        var g = groupInfo[key]!
                        corridorAliases[key] = key
                        corridorMasters.insert(key)
                        g.corridorJoins = []
                        g.curve = smoothStandaloneCorridorRun(
                            g.line, isClosed: true, settings: settings)
                        groupInfo[key] = g
                    } else {
                        usePerRunCurves(c)
                    }
                    continue
                }
                // The smoothed corridor centreline: chain the member runs end
                // to end and normalise into a very smooth curve. The renderer
                // derives the fan's shift direction from this curve's LOCAL
                // perpendicular under the pointer, so the direction turns
                // smoothly as the pointer moves.
                let chain = buildCorridorChain(
                    keys: c.keys, keySet: c.keySet, joins: joins,
                    lineFor: { groupInfo[$0]?.line })
                if chain == nil && c.keys.count > 1 {
                    // No continuable chain could be assembled at all, so keep
                    // independently fitted per-run curves.
                    usePerRunCurves(c)
                    continue
                }
                let curve = chain.flatMap { smoothCorridorCurve($0, settings: settings) }
                let canonicalKey = jsSorted(c.keys)[0]
                var master = groupInfo[canonicalKey]!
                if let chain {
                    master.curveEndpointNodeKeys = [
                        snap.nodeKey(chain[0]), snap.nodeKey(chain[chain.count - 1]),
                    ]
                }
                let nearInfos = c.keys.compactMap { groupInfo[$0]?.nearParallel }
                if !nearInfos.isEmpty {
                    master.nearParallel = NearParallelInfo(
                        pairCount: nearInfos.map(\.pairCount).max() ?? 0,
                        maxSeparationMeters: nearInfos.map(\.maxSeparationMeters).max() ?? 0,
                        thresholdMeters: nearInfos.map(\.thresholdMeters).max() ?? 0)
                }
                groupInfo[canonicalKey] = master
                if curve == nil && c.keys.count > 1 {
                    // The unified candidate failed at least one final hard
                    // constraint. Preserve independently validated runs rather
                    // than publish a geometrically invalid shared direction
                    // field.
                    usePerRunCurves(c)
                    continue
                }
                corridorMasters.insert(canonicalKey)
                for k in c.keys { corridorAliases[k] = canonicalKey }
                master = groupInfo[canonicalKey]!
                master.corridorJoins = componentJoins.filter { $0.metres > 0.05 }
                groupInfo[canonicalKey] = master
                if let curve {
                    for k in c.keys {
                        var g = groupInfo[k]!
                        g.curve = curve
                        groupInfo[k] = g
                    }
                }
                if c.keys.count < 2 { continue }  // a lone run keeps its own chord
                guard let axis = unifiedCorridorShiftAxis(c) else { continue }
                for k in c.keys {
                    var g = groupInfo[k]!
                    g.sx = axis.sx
                    g.sy = axis.sy
                    groupInfo[k] = g
                }
            }

            // Collapsing all runs of one continuous corridor onto ONE
            // interaction key is the point of the pass: before it, only the
            // curve was shared, so an open fan moved the current run's pick
            // lane and left the adjacent run on the true track — and crossing
            // the boundary produced a miss/collapse/reopen flash.
            var representative: [String: Int] = [:]
            for index in records.indices {
                let r = records[index]
                guard r.overlapCount > 1, !r.groupKey.isEmpty else { continue }
                let canonicalKey = corridorAliases[r.groupKey] ?? r.groupKey
                records[index].groupKey = canonicalKey
                if let g = groupInfo[canonicalKey] {
                    records[index].shiftX = g.sx
                    records[index].shiftY = g.sy
                }
                let rk = canonicalKey + "::" + r.trainId
                if representative[rk] == nil { representative[rk] = index }
            }
            for canonicalKey in corridorMasters.order {
                var g = groupInfo[canonicalKey]!
                g.pickBridges = []
                for join in g.corridorJoins {
                    for entry in g.mults {
                        guard let index = representative[canonicalKey + "::" + entry.trainId]
                        else { continue }
                        g.pickBridges.append(
                            PickBridge(
                                path: [join.a.p, join.b.p], trainId: entry.trainId,
                                recordIndex: index, laneMult: entry.mult,
                                pickWidth: Swift.max(spacingPx, 8)))
                    }
                }
                groupInfo[canonicalKey] = g
            }
            // Only canonical entries stay addressable by the renderer.
            for key in groupInfo.keys {
                if let canonicalKey = corridorAliases[key], canonicalKey != key {
                    groupInfo[key] = nil
                }
            }
        }

        // ── §3 static painter's order (higher = on top) ──
        // The sort key overrides feature order inside the route layers, so the
        // emphasis tier — dimmed off-date rides under the active date's — rides
        // in the key's high digits. Within a tier, bottom→top: longer total
        // ride under shorter (a short ride covered by a long one loses ALL of
        // its ink; the long one only loses the shared stretch), and among
        // equal-length rides the later date under the earlier. Whole-metre
        // length ranking is what makes opposite-direction traversals tie before
        // the date fallback is applied.
        var sortTrains: [String] = []
        var seen = Set<String>()
        for record in records where !seen.contains(record.trainId) {
            seen.insert(record.trainId)
            sortTrains.append(record.trainId)
        }
        sortTrains = stableSorted(sortTrains) { a, b in
            let la = JSNumber.round(drawnLenByTid[a] ?? 0)
            let lb = JSNumber.round(drawnLenByTid[b] ?? 0)
            if la != lb { return la > lb }
            // `compareTrainsByDateAndDeparture(b, a)` — reversed, so the later
            // date sorts first and therefore draws underneath.
            return (rank[a] ?? 0) > (rank[b] ?? 0)
        }
        var sortRank: [String: Int] = [:]
        for (index, id) in sortTrains.enumerated() { sortRank[id] = index }
        for index in records.indices {
            records[index].sortKey =
                (records[index].nopick ? 0 : routeSortTier)
                + Double(sortRank[records[index].trainId] ?? 0)
        }

        return RecordBundle(
            records: records, expandRecords: expandRecords,
            corridors: groupInfo.entries.map { (key: $0.key, corridor: $0.value) },
            spacingPx: spacingPx, hasOverlaps: hasOverlaps)
    }

    /// Keeps distinct geometry for an interaction key met on more than one
    /// physical run. Two run lines are the same run when both endpoints match
    /// within 5 cm, in either direction.
    static func mergeRunLineIntoGroup(_ gi: inout Corridor, runLine: [Coordinate]) {
        let duplicate = gi.lines.contains { other in
            let same =
                Geometry.distanceMeters(other[0], runLine[0]) <= 0.05
                && Geometry.distanceMeters(
                    other[other.count - 1], runLine[runLine.count - 1]) <= 0.05
            let reverse =
                Geometry.distanceMeters(other[0], runLine[runLine.count - 1]) <= 0.05
                && Geometry.distanceMeters(other[other.count - 1], runLine[0]) <= 0.05
            return same || reverse
        }
        if !duplicate { gi.lines.append(runLine) }
    }
}
